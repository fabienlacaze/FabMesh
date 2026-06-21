"""
FabMesh SDXL Persistent Server
Keeps SDXL Turbo img2img + SDXL Inpainting + CLIPSeg in memory
to avoid 5-10s reload per call.

Listens on 127.0.0.1:5555 via simple HTTP/JSON.

Endpoints:
  GET  /ping              - health check + model status
  GET  /status            - detailed model + GPU status
  POST /img2img           - { input, prompt, output, strength, guidance, steps, seed }
  POST /inpaint           - { input, target, prompt, output, dilate }
  POST /shutdown          - graceful exit
  POST /unload            - free a specific model from VRAM
"""
import os
import sys
import re
import json
import time
import gc
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# FabMesh: cap CPU threads so a heavy phase (VAE decode, preprocessing) can't
# monopolise every core and freeze the desktop while this server runs. Set
# BEFORE importing torch/numpy so they pick up the limit at import. No priority
# drop here — this server handles INTERACTIVE ops (modify/inpaint) the user is
# actively waiting on. Disable with FABMESH_NO_WORKER_THROTTLE=1.
if os.environ.get('FABMESH_NO_WORKER_THROTTLE') != '1':
    try:
        _t = os.environ.get('FABMESH_CPU_THREADS') or str(max(2, (os.cpu_count() or 8) // 2))
        for _k in ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMEXPR_NUM_THREADS'):
            os.environ.setdefault(_k, _t)
    except Exception:
        pass

# Faster startup: only import what we need at top
import torch
from PIL import Image, ImageFilter
import numpy as np

# ========== CONFIG ==========
HOST = '127.0.0.1'
PORT = 5555
# img2img: RealVis XL V4.0 — CreativeML Open RAIL++-M (commercial-safe).
# We previously used stabilityai/sdxl-turbo which is under the SAI Non-Commercial
# Research License, disqualifying it from a Steam release. RealVis XL shares the
# same SDXL architecture so StableDiffusionXLImg2ImgPipeline loads it unchanged.
IMG2IMG_MODEL = "SG161222/RealVisXL_V4.0"
# Back-compat alias (some older code paths still reference the old name).
SDXL_TURBO_MODEL = IMG2IMG_MODEL
SDXL_INPAINT_MODEL = "diffusers/stable-diffusion-xl-1.0-inpainting-0.1"
CLIPSEG_MODEL = "CIDAS/clipseg-rd64-refined"
# ControlNet Tile SDXL — xinsir/controlnet-tile-sdxl-1.0 (Apache 2.0,
# commercial-safe). Used to boost atlas refine strength without breaking
# the UV layout: the tile ControlNet constrains SDXL to respect the
# source image structure while still adding micro-detail.
CONTROLNET_TILE_MODEL = "xinsir/controlnet-tile-sdxl-1.0"

# Identity-preserving prompt scaffolding (ported from cloud modal_app/_modify.py).
# When the user is doing a low-strength "modify" pass (e.g. add a hat, change
# colour), prefix their prompt with these tokens so SDXL doesn't drift to a
# different subject. At high strength (>0.6) the user is going for a re-style
# so we skip the prefix and let the prompt drive the redraw.
# Subject-agnostic on purpose: the old wording ('same character, same outfit,
# same pose, bad anatomy, extra limbs') is person-only and mis-steers SDXL on
# objects / vehicles / props (a catapult has no 'outfit' or 'pose').
PRESERVE_PREFIX = (
    'same subject, same shape, same proportions, same composition, '
    'same colors, preserve the original object identity, only change: '
)
PRESERVE_NEG = (
    'different subject, changed shape, different proportions, '
    'different composition, distorted, blurry, low quality, deformed, '
    'watermark, multiple subjects'
)
# Toggle (default ON). Set FABMESH_MODIFY_PRESERVE=0 to disable the prefix
# globally — useful if a downstream caller is doing its own prompt scaffolding.
PRESERVE_IDENTITY_ENABLED = os.environ.get('FABMESH_MODIFY_PRESERVE', '1') != '0'

# Enforce VRAM cap from FabMesh settings (passed via FABMESH_VRAM_FRACTION env var).
GPU_MEMORY_FRACTION = float(os.environ.get('FABMESH_VRAM_FRACTION', '0.95'))
if torch.cuda.is_available() and 0.1 <= GPU_MEMORY_FRACTION < 1.0:
    try:
        torch.cuda.set_per_process_memory_fraction(GPU_MEMORY_FRACTION)
        print(f"SDXL_SERVER: VRAM hard cap set to {GPU_MEMORY_FRACTION*100:.0f}%", flush=True)
    except Exception as e:
        print(f"SDXL_SERVER: Could not set VRAM cap ({e})", flush=True)


# Enforce system RAM limit from FabMesh settings (FABMESH_RAM_LIMIT_MB env var).
_RAM_LIMIT_MB = os.environ.get('FABMESH_RAM_LIMIT_MB', '')
if _RAM_LIMIT_MB:
    try:
        import psutil
        _vm = psutil.virtual_memory()
        print(f"SDXL_SERVER: RAM system used={(_vm.total - _vm.available) / (1024**2):.0f}MB, "
              f"limit={_RAM_LIMIT_MB}MB, percent={_vm.percent:.0f}%", flush=True)
    except ImportError:
        print("SDXL_SERVER: psutil not installed, RAM monitoring skipped", flush=True)
    except Exception as e:
        print(f"SDXL_SERVER: RAM check error: {e}", flush=True)

# ========== STATE ==========
class ModelState:
    """Holds all loaded models and their locks."""
    def __init__(self):
        self.img2img_pipe = None
        self.inpaint_pipe = None
        self.controlnet_tile_pipe = None
        self.clipseg_model = None
        self.clipseg_processor = None
        self.load_lock = threading.RLock()    # Reentrant - same thread can load multiple
        self.inference_lock = threading.Lock()  # Serialize GPU calls
        self.last_use = {}                     # model_name -> timestamp


state = ModelState()


def log(msg, level='info'):
    prefix = {'info': '[SDXL]', 'err': '[SDXL ERR]', 'warn': '[SDXL WARN]'}.get(level, '[SDXL]')
    print(f"{prefix} {msg}", flush=True)


def vram_used_gb():
    if not torch.cuda.is_available():
        return 0.0
    return torch.cuda.memory_allocated() / 1024**3


def vram_total_gb():
    if not torch.cuda.is_available():
        return 0.0
    return torch.cuda.get_device_properties(0).total_memory / 1024**3


def free_vram():
    """Aggressive VRAM cleanup."""
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.synchronize()


# ========== MODEL LOADING ==========
def _set_memory_fraction():
    # No-op: see GPU_MEMORY_FRACTION comment above. Kept so existing call sites
    # (load_img2img, load_inpaint) don't need to be touched.
    pass


def _free_heavy_except(keep):
    """Keep only ONE heavy SDXL pipe resident at a time to bound VRAM (16 GB card).
    img2img / inpaint / controlnet_tile each cost ~6-9 GB; resident together they OOM
    (the user's 'CUDA out of memory ... 0 bytes free'). CLIPSeg (~400 MB) is shared
    and left alone. No single op needs two heavy pipes, so freeing the others is safe.
    Caller must already hold state.load_lock."""
    freed = []
    if keep != 'img2img' and state.img2img_pipe is not None:
        del state.img2img_pipe
        state.img2img_pipe = None
        freed.append('img2img')
    if keep != 'inpaint' and state.inpaint_pipe is not None:
        del state.inpaint_pipe
        state.inpaint_pipe = None
        freed.append('inpaint')
    if keep != 'controlnet_tile' and state.controlnet_tile_pipe is not None:
        del state.controlnet_tile_pipe
        state.controlnet_tile_pipe = None
        freed.append('controlnet_tile')
    if freed:
        free_vram()
        log(f"Freed {freed} to fit '{keep}' ({vram_used_gb():.1f} GB VRAM)")


def load_img2img():
    """Lazy-load SDXL Turbo img2img pipeline."""
    if state.img2img_pipe is not None:
        state.last_use['img2img'] = time.time()
        return state.img2img_pipe

    with state.load_lock:
        if state.img2img_pipe is not None:
            return state.img2img_pipe
        _free_heavy_except('img2img')
        log(f"Loading {IMG2IMG_MODEL}...")
        _set_memory_fraction()
        from diffusers import StableDiffusionXLImg2ImgPipeline
        t0 = time.time()
        # RealVis XL V4.0 doesn't ship an fp16 variant branch — ask for fp16 dtype
        # but omit variant="fp16" so the loader grabs the default safetensors.
        pipe = StableDiffusionXLImg2ImgPipeline.from_pretrained(
            IMG2IMG_MODEL,
            torch_dtype=torch.float16,
            use_safetensors=True,
        )
        # RealVis XL's native VAE OVERFLOWS in fp16 -> rainbow/colorful noise all
        # over the img2img output (the user's "image vraiment dégradée"). Swap in
        # the fp16-fixed VAE (madebyollin), built to stay numerically stable in
        # fp16 for both encode + decode. Downloaded once, then cached. Falls back
        # to force_upcast (fp32 VAE decode) if it can't be fetched.
        try:
            from diffusers import AutoencoderKL
            pipe.vae = AutoencoderKL.from_pretrained(
                "madebyollin/sdxl-vae-fp16-fix", torch_dtype=torch.float16)
        except Exception as _ve:
            log(f"fp16-fix VAE unavailable ({_ve}); using force_upcast fallback")
            try:
                pipe.vae.config.force_upcast = True
            except Exception:
                pass
        pipe.to("cuda")
        # Force every sub-module to fp16 — diffusers 0.34 on torch
        # 2.7.1+cu128 leaves some buffers fp32 after from_pretrained,
        # causing "mat1/mat2 dtype mismatch" errors at inference.
        try:
            pipe.unet.to(torch.float16)
            pipe.vae.to(torch.float16)
            pipe.text_encoder.to(torch.float16)
            pipe.text_encoder_2.to(torch.float16)
        except Exception as _e:
            log(f"img2img fp16 cast skipped: {_e}")
        # attention_slicing removed: on torch 2.7 / SDPA it's a serious slowdown
        # with no memory gain. VAE tiling below is the real VRAM win — keep it.
        pipe.enable_vae_tiling()
        # Safety checker: enabled by default (parental control).
        # Disabled only when FABMESH_UNRESTRICTED=1 env var is set.
        if os.environ.get('FABMESH_UNRESTRICTED') == '1':
            if hasattr(pipe, 'safety_checker'):
                pipe.safety_checker = None
                log("Safety checker DISABLED (unrestricted mode)")
        else:
            log("Safety checker ENABLED (parental control active)")
        state.img2img_pipe = pipe
        state.last_use['img2img'] = time.time()
        log(f"img2img loaded in {time.time()-t0:.1f}s ({vram_used_gb():.1f} GB VRAM)")
    return state.img2img_pipe


def load_clipseg():
    """Lazy-load just CLIPSeg (~400 MB) — used for mask detection/preview
    without pulling in the heavy ~6 GB SDXL inpaint pipeline."""
    if state.clipseg_model is not None:
        return
    with state.load_lock:
        if state.clipseg_model is None:
            log(f"Loading {CLIPSEG_MODEL}...")
            from transformers import CLIPSegForImageSegmentation, CLIPSegProcessor
            t0 = time.time()
            state.clipseg_processor = CLIPSegProcessor.from_pretrained(CLIPSEG_MODEL)
            # Raise CLIPSeg input resolution 352 -> 512 for a ~2x sharper mask
            # (default ViT input is 352px -> blobby logits upscaled 3x).
            try:
                state.clipseg_processor.image_processor.size = {'height': 512, 'width': 512}
            except Exception as _e:
                log(f"CLIPSeg res override skipped: {_e}", 'warn')
            state.clipseg_model = CLIPSegForImageSegmentation.from_pretrained(CLIPSEG_MODEL)
            state.clipseg_model.to("cuda")
            state.clipseg_model.eval()
            log(f"CLIPSeg loaded in {time.time()-t0:.1f}s")


def load_inpaint():
    """Lazy-load SDXL Inpainting + CLIPSeg."""
    if state.inpaint_pipe is not None and state.clipseg_model is not None:
        state.last_use['inpaint'] = time.time()
        return state.inpaint_pipe

    load_clipseg()
    with state.load_lock:
        # SDXL Inpainting (large model, ~6 GB)
        if state.inpaint_pipe is None:
            _free_heavy_except('inpaint')
            log(f"Loading {SDXL_INPAINT_MODEL}...")
            _set_memory_fraction()
            from diffusers import StableDiffusionXLInpaintPipeline
            t0 = time.time()
            pipe = StableDiffusionXLInpaintPipeline.from_pretrained(
                SDXL_INPAINT_MODEL,
                torch_dtype=torch.float16,
                variant="fp16",
            )
            # fp16-fixed VAE (same overflow/noise fix as img2img).
            try:
                from diffusers import AutoencoderKL
                pipe.vae = AutoencoderKL.from_pretrained(
                    "madebyollin/sdxl-vae-fp16-fix", torch_dtype=torch.float16)
            except Exception as _ve:
                log(f"inpaint fp16-fix VAE unavailable ({_ve})")
                try:
                    pipe.vae.config.force_upcast = True
                except Exception:
                    pass
            pipe.to("cuda")
            # Same fp16 force-cast as img2img (diffusers 0.34 / torch 2.7.1)
            try:
                pipe.unet.to(torch.float16)
                pipe.vae.to(torch.float16)
                pipe.text_encoder.to(torch.float16)
                pipe.text_encoder_2.to(torch.float16)
            except Exception as _e:
                log(f"inpaint fp16 cast skipped: {_e}")
            # attention_slicing removed (torch 2.7/SDPA slowdown, no mem gain).
            pipe.enable_vae_tiling()
            if os.environ.get('FABMESH_UNRESTRICTED') == '1':
                if hasattr(pipe, 'safety_checker'):
                    pipe.safety_checker = None
            state.inpaint_pipe = pipe
            state.last_use['inpaint'] = time.time()
            log(f"Inpaint loaded in {time.time()-t0:.1f}s ({vram_used_gb():.1f} GB VRAM)")
    return state.inpaint_pipe


def load_controlnet_tile():
    """Lazy-load RealVisXL + ControlNet Tile SDXL img2img pipeline."""
    if state.controlnet_tile_pipe is not None:
        state.last_use['controlnet_tile'] = time.time()
        return state.controlnet_tile_pipe

    with state.load_lock:
        if state.controlnet_tile_pipe is not None:
            return state.controlnet_tile_pipe
        _free_heavy_except('controlnet_tile')
        log(f"Loading {CONTROLNET_TILE_MODEL} + {IMG2IMG_MODEL}...")
        _set_memory_fraction()
        from diffusers import (
            ControlNetModel,
            StableDiffusionXLControlNetImg2ImgPipeline,
        )
        t0 = time.time()
        controlnet = ControlNetModel.from_pretrained(
            CONTROLNET_TILE_MODEL,
            torch_dtype=torch.float16,
            use_safetensors=True,
        )
        pipe = StableDiffusionXLControlNetImg2ImgPipeline.from_pretrained(
            IMG2IMG_MODEL,
            controlnet=controlnet,
            torch_dtype=torch.float16,
            use_safetensors=True,
        )
        # fp16-fixed VAE (RealVis XL's native VAE overflows in fp16 -> noise).
        try:
            from diffusers import AutoencoderKL
            pipe.vae = AutoencoderKL.from_pretrained(
                "madebyollin/sdxl-vae-fp16-fix", torch_dtype=torch.float16)
        except Exception as _ve:
            log(f"tile fp16-fix VAE unavailable ({_ve})")
            try:
                pipe.vae.config.force_upcast = True
            except Exception:
                pass
        pipe.to("cuda")
        # Same fp16 force-cast (diffusers 0.34 / torch 2.7.1)
        try:
            pipe.unet.to(torch.float16)
            pipe.vae.to(torch.float16)
            pipe.text_encoder.to(torch.float16)
            pipe.text_encoder_2.to(torch.float16)
            if hasattr(pipe, 'controlnet'):
                pipe.controlnet.to(torch.float16)
        except Exception as _e:
            log(f"controlnet_tile fp16 cast skipped: {_e}")
        # attention_slicing removed (torch 2.7/SDPA slowdown, no mem gain).
        pipe.enable_vae_tiling()
        if os.environ.get('FABMESH_UNRESTRICTED') == '1':
            if hasattr(pipe, 'safety_checker'):
                pipe.safety_checker = None
        state.controlnet_tile_pipe = pipe
        state.last_use['controlnet_tile'] = time.time()
        log(f"controlnet_tile loaded in {time.time()-t0:.1f}s "
            f"({vram_used_gb():.1f} GB VRAM)")
    return state.controlnet_tile_pipe


def unload_model(name):
    """Free a model from VRAM. name in ('img2img', 'inpaint', 'controlnet_tile', 'clipseg')."""
    with state.load_lock:
        before = vram_used_gb()
        if name == 'img2img' and state.img2img_pipe is not None:
            del state.img2img_pipe
            state.img2img_pipe = None
        elif name == 'inpaint' and state.inpaint_pipe is not None:
            del state.inpaint_pipe
            state.inpaint_pipe = None
        elif name == 'controlnet_tile' and state.controlnet_tile_pipe is not None:
            del state.controlnet_tile_pipe
            state.controlnet_tile_pipe = None
        elif name == 'clipseg' and state.clipseg_model is not None:
            del state.clipseg_model
            del state.clipseg_processor
            state.clipseg_model = None
            state.clipseg_processor = None
        free_vram()
        log(f"Unloaded {name} - VRAM {before:.1f} -> {vram_used_gb():.1f} GB")


# ========== IMAGE HELPERS ==========
def resize_for_sdxl(img, max_dim=1024, snap_to_8=True):
    """Resize keeping aspect ratio so longer side = max_dim, dimensions multiple of 8."""
    w, h = img.size
    if max(w, h) > max_dim:
        if w >= h:
            new_w, new_h = max_dim, int(h * max_dim / w)
        else:
            new_h, new_w = max_dim, int(w * max_dim / h)
    else:
        new_w, new_h = w, h
    if snap_to_8:
        new_w = max(8, (new_w // 8) * 8)
        new_h = max(8, (new_h // 8) * 8)
    return img.resize((new_w, new_h), Image.LANCZOS), (new_w, new_h)


def save_debug_mask(output_path, mask_img):
    """Save mask in .debug/ subfolder so it doesn't appear in the gallery."""
    try:
        debug_dir = os.path.join(os.path.dirname(output_path), ".debug")
        os.makedirs(debug_dir, exist_ok=True)
        base = os.path.basename(output_path)
        name = base.rsplit('.', 1)[0] + '_mask.png'
        path = os.path.join(debug_dir, name)
        mask_img.save(path)
        return path
    except Exception:
        return None


# ========== INFERENCE ==========
def do_img2img(input_path, prompt, output_path, strength=0.55,
               guidance=7.0, steps=None, seed=42):
    """
    SDXL img2img with optional identity-preserving prefix for "Modify Image"
    flows (ported from cloud modal_app/_modify.py).

    Args:
      strength: img2img denoise strength. Legacy default 0.55 preserved at
                this layer so existing callers don't shift behaviour. Cloud
                "Modify Image" uses 0.35 — callers wanting modify semantics
                should pass strength=0.35 explicitly.
      guidance: classifier-free guidance scale. Cloud default 7.0.
                The legacy 6.0 is used as a fallback only if caller passes
                None.
      steps:    explicit step count. None = legacy auto-derive from strength
                (`max(round(25/s), round(1/s)+1)` capped at 60).
      seed:     deterministic seed (default 42, matching cloud). Pass None
                for non-deterministic.
    """
    if not os.path.exists(input_path):
        return {"ok": False, "error": f"Input not found: {input_path}"}

    # Only one SDXL pipeline at a time — RealVis img2img (~6 GB) + SDXL Inpaint
    # (~6 GB) together saturate a 16 GB card and force NVIDIA driver shared-mem
    # fallback, making every step 10x slower. Unload the other pipeline first.
    if state.inpaint_pipe is not None:
        unload_model('inpaint')

    pipe = load_img2img()
    state.last_use['img2img'] = time.time()

    with state.inference_lock:
        try:
            img = Image.open(input_path).convert("RGB")
            # NOTE: we intentionally keep variable aspect ratio (longer side
            # 1024, snapped to /8) rather than the cloud's forced 1024x1024
            # square. Desktop has a dedicated img2img pipe (no ControlNet
            # base constraint) so this is strictly better.
            img, (w, h) = resize_for_sdxl(img, max_dim=1024)

            s = max(0.1, min(1.0, float(strength)))

            # Identity-preserving prefix for low-strength "modify" passes.
            # At strength > 0.6 the user is going for a re-style — skip the
            # prefix and keep the legacy "high quality, detailed" suffix so
            # existing high-strength callers' output doesn't soften.
            if PRESERVE_IDENTITY_ENABLED and s <= 0.6:
                final_prompt = PRESERVE_PREFIX + prompt
                final_neg = PRESERVE_NEG
            else:
                final_prompt = f"{prompt}, high quality, detailed"
                final_neg = ''

            # RealVis XL V4.0: standard SDXL fine-tune, likes 25-30 steps + CFG 5-7.
            # num_inference_steps * strength must be >= 1 (same diffusers rule
            # as Turbo, but with higher base step count).
            if steps is None:
                _steps = max(int(round(25 / s)), int(round(1 / s)) + 1)
                _steps = min(_steps, 60)  # safety upper bound
            else:
                _steps = int(steps)

            # guidance=None falls back to legacy CFG 6.0
            _guidance = 6.0 if guidance is None else float(guidance)

            gen = None
            if seed is not None and torch.cuda.is_available():
                gen = torch.Generator('cuda').manual_seed(int(seed))

            t0 = time.time()
            with torch.inference_mode():
                result = pipe(
                    prompt=final_prompt,
                    negative_prompt=final_neg,
                    image=img,
                    strength=s,
                    num_inference_steps=_steps,
                    guidance_scale=_guidance,
                    generator=gen,
                ).images[0]

            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            result.save(output_path)
            elapsed = time.time() - t0
            log(f"img2img done in {elapsed:.1f}s ({_steps} steps, cfg={_guidance}, "
                f"preserve={'Y' if final_neg else 'N'}, {w}x{h}) -> {output_path}")
            return {"ok": True, "output": output_path, "time": elapsed, "size": [w, h]}
        except Exception as e:
            log(f"img2img error: {e}", 'err')
            traceback.print_exc()
            free_vram()
            return {"ok": False, "error": str(e)}


def do_img2img_tile(input_path, prompt, output_path, strength=0.55,
                     controlnet_scale=0.7, guidance_scale=6.0, steps=None,
                     seed=42):
    """
    Tile-conditioned img2img: uses the source image as BOTH the init image
    AND the ControlNet Tile condition. This lets us push strength way higher
    than plain img2img (0.5-0.8 range) without destroying the UV layout or
    colour composition of a texture atlas — the ControlNet anchors structure
    while SDXL adds micro-detail.

    Params:
      strength          — img2img strength (0.5-0.8 recommended for atlas)
      controlnet_scale  — how strongly the tile controlnet enforces structure
                          (0.5 = permissive, 0.9 = rigid). 0.6-0.8 is sweet spot.
      guidance_scale    — CFG (5-7 typical for RealVisXL)
      steps             — None = auto from strength (same rule as img2img)
    """
    if not os.path.exists(input_path):
        return {"ok": False, "error": f"Input not found: {input_path}"}

    # Single SDXL pipe at a time to stay under 16 GB VRAM.
    if state.img2img_pipe is not None:
        unload_model('img2img')
    if state.inpaint_pipe is not None:
        unload_model('inpaint')

    pipe = load_controlnet_tile()
    state.last_use['controlnet_tile'] = time.time()

    with state.inference_lock:
        try:
            img = Image.open(input_path).convert("RGB")
            img, (w, h) = resize_for_sdxl(img, max_dim=1024)

            enhanced = f"{prompt}, high quality, detailed"
            s = max(0.1, min(1.0, float(strength)))
            if steps is None:
                steps = max(int(round(25 / s)), int(round(1 / s)) + 1)
                steps = min(steps, 60)
            cns = max(0.0, min(1.5, float(controlnet_scale)))
            # Seed drives the variation: a different seed = a different texture
            # from the same atlas (used by the "Texture variations" tool).
            gen = None
            if seed is not None and torch.cuda.is_available():
                gen = torch.Generator('cuda').manual_seed(int(seed))

            t0 = time.time()
            with torch.inference_mode():
                result = pipe(
                    prompt=enhanced,
                    image=img,
                    control_image=img,  # same tile image drives the ControlNet
                    strength=s,
                    num_inference_steps=steps,
                    guidance_scale=guidance_scale,
                    controlnet_conditioning_scale=cns,
                    generator=gen,
                ).images[0]

            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            result.save(output_path)
            elapsed = time.time() - t0
            log(f"img2img_tile done in {elapsed:.1f}s "
                f"(s={s:.2f}, cns={cns:.2f}, {steps} steps, {w}x{h}) "
                f"-> {output_path}")
            return {"ok": True, "output": output_path, "time": elapsed,
                    "size": [w, h], "strength": s, "controlnet_scale": cns}
        except Exception as e:
            log(f"img2img_tile error: {e}", 'err')
            traceback.print_exc()
            free_vram()
            return {"ok": False, "error": str(e)}


def do_inpaint(input_path, target_text, prompt, output_path, dilate=15, rel=0.5):
    if not os.path.exists(input_path):
        return {"ok": False, "error": f"Input not found: {input_path}"}
    if not target_text or not target_text.strip():
        return {"ok": False, "error": "target_text required"}

    # Only one SDXL pipeline at a time — see do_img2img comment.
    if state.img2img_pipe is not None:
        unload_model('img2img')

    pipe = load_inpaint()
    state.last_use['inpaint'] = time.time()

    with state.inference_lock:
        try:
            img = Image.open(input_path).convert("RGB")
            orig_size = img.size
            img_work, (work_w, work_h) = resize_for_sdxl(img, max_dim=1024)

            t0 = time.time()

            # === Step 1: CLIPSeg segmentation ===
            inputs = state.clipseg_processor(
                text=[target_text.strip()],
                images=[img_work],
                padding=True,
                return_tensors="pt"
            )
            inputs = {k: v.to("cuda") for k, v in inputs.items()}
            with torch.inference_mode():
                seg_out = state.clipseg_model(**inputs)

            mask_logits = seg_out.logits.squeeze().detach().cpu().numpy()
            mask_prob = 1 / (1 + np.exp(-mask_logits))  # sigmoid
            mask_uint8 = (mask_prob * 255).astype(np.uint8)

            mask_img = Image.fromarray(mask_uint8).resize((work_w, work_h), Image.LANCZOS)
            mask_arr = np.array(mask_img)
            binary = (mask_arr > max(60.0, float(mask_arr.max()) * float(rel))).astype(np.uint8) * 255  # relative-to-peak (tighter)
            mask_binary = Image.fromarray(binary, mode="L")

            # Dilate mask for context blending
            d = max(0, int(dilate))
            if d > 0:
                mask_binary = mask_binary.filter(ImageFilter.MaxFilter(d * 2 + 1))
            mask_binary = mask_binary.filter(ImageFilter.GaussianBlur(3))

            coverage = (np.array(mask_binary) > 128).mean() * 100
            if coverage < 0.2:
                return {"ok": False, "error": f"Target '{target_text}' not detected (coverage {coverage:.1f}%)"}
            if coverage > 80:
                log(f"WARNING: mask covers {coverage:.0f}% of image", 'warn')

            save_debug_mask(output_path, mask_binary)

            # === Step 2: SDXL Inpainting ===
            inpaint_prompt = (prompt or "").strip()
            removal_keywords = ("", "remove", "delete", "none", "nothing", "empty", "gone")
            is_removal = inpaint_prompt.lower() in removal_keywords

            if is_removal:
                # Give CFG a concrete surface to paint TOWARD + forbid the object
                # shape, else the object-shaped hole gets re-filled with the object.
                inpaint_prompt = "solid plain wall, flat continuous surface, smooth uniform facade, seamless background, empty space, no door, no opening"
                negative_prompt = f"{target_text}, door, opening, hole, gap, window, frame, jamb, panel, object, furniture, item, duplicate, deformed, blurry, distorted, artifact"
            else:
                negative_prompt = f"blurry, distorted, duplicate, deformed, low quality, {target_text}"
            # Removal leans on the surrounding (now wall-coloured) pixels; full
            # 0.99 regen from noise tends to redraw the object.
            _inpaint_strength = 0.85 if is_removal else 0.99

            with torch.inference_mode():
                result = pipe(
                    prompt=inpaint_prompt,
                    negative_prompt=negative_prompt,
                    image=img_work,
                    mask_image=mask_binary,
                    num_inference_steps=40,
                    guidance_scale=8.5,
                    strength=_inpaint_strength,
                    height=work_h,
                    width=work_w,
                ).images[0]

            # Restore original resolution if needed
            if (work_w, work_h) != orig_size:
                result = result.resize(orig_size, Image.LANCZOS)

            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            result.save(output_path)

            elapsed = time.time() - t0
            log(f"inpaint done in {elapsed:.1f}s ({coverage:.0f}% mask) -> {output_path}")
            return {
                "ok": True,
                "output": output_path,
                "time": elapsed,
                "mask_coverage": round(coverage, 1)
            }
        except Exception as e:
            log(f"inpaint error: {e}", 'err')
            traceback.print_exc()
            free_vram()
            return {"ok": False, "error": str(e)}


# ============================ RECOLOR =====================================
# Bilingual (FR+EN) colour lexicon -> (hue 0-255 PIL scale, sat_boost, mode).
# mode 'chroma' = tint to the hue keeping luminance; 'grey'/'black'/'white' =
# special handling. Used by the deterministic HSV recolor (shape-preserving).
_COLOR_LEXICON = {
    'rouge': (0, 1.4, 'chroma'), 'red': (0, 1.4, 'chroma'),
    'orange': (18, 1.4, 'chroma'),
    'jaune': (35, 1.4, 'chroma'), 'yellow': (35, 1.4, 'chroma'),
    'vert': (85, 1.3, 'chroma'), 'verte': (85, 1.3, 'chroma'), 'green': (85, 1.3, 'chroma'),
    'cyan': (128, 1.3, 'chroma'), 'turquoise': (128, 1.3, 'chroma'),
    'bleu': (156, 1.3, 'chroma'), 'bleue': (156, 1.3, 'chroma'), 'blue': (156, 1.3, 'chroma'),
    'violet': (195, 1.3, 'chroma'), 'violette': (195, 1.3, 'chroma'),
    'purple': (195, 1.3, 'chroma'), 'mauve': (200, 1.2, 'chroma'),
    'rose': (227, 1.2, 'chroma'), 'pink': (227, 1.2, 'chroma'),
    'marron': (14, 0.7, 'chroma'), 'brun': (14, 0.7, 'chroma'), 'brune': (14, 0.7, 'chroma'), 'brown': (14, 0.7, 'chroma'),
    'dore': (32, 1.5, 'chroma'), 'dores': (32, 1.5, 'chroma'),
    'doree': (32, 1.5, 'chroma'), 'gold': (32, 1.5, 'chroma'), 'golden': (32, 1.5, 'chroma'),
    'argent': (0, 0.0, 'grey'), 'argente': (0, 0.0, 'grey'), 'argentee': (0, 0.0, 'grey'),
    'silver': (0, 0.0, 'grey'), 'gris': (0, 0.0, 'grey'), 'grise': (0, 0.0, 'grey'),
    'grey': (0, 0.0, 'grey'), 'gray': (0, 0.0, 'grey'),
    'noir': (0, 0.0, 'black'), 'noire': (0, 0.0, 'black'), 'black': (0, 0.0, 'black'),
    'blanc': (0, 0.0, 'white'), 'blanche': (0, 0.0, 'white'), 'white': (0, 0.0, 'white'),
}


def _strip_accents(s):
    import unicodedata
    return ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn')


def parse_recolor_prompt(prompt):
    """'cape rouge' -> ('cape', color_spec) ; color_spec is None when no known
    colour word is present (-> ControlNet-Tile material fallback)."""
    text = (prompt or '').strip()
    color_spec = None
    noun_words = []
    for raw in text.split():
        w = _strip_accents(raw.strip(".,;:!?\"'()").lower())
        if w in _COLOR_LEXICON:
            if color_spec is None:
                hue, sat, mode = _COLOR_LEXICON[w]
                color_spec = {'hue': hue, 'sat': sat, 'mode': mode, 'word': w}
            # colour words are dropped from the CLIPSeg target either way
        else:
            noun_words.append(raw)
    noun = ' '.join(noun_words).strip() or text
    return noun, color_spec


def recolor_hsv_masked(img_rgb, mask_soft, color_spec, strength=1.0):
    """Shift HSV inside the masked region, preserving luminance (V) so folds and
    shadows stay intact. Blends through the feathered mask * strength."""
    hsv = np.array(img_rgb.convert('HSV')).astype(np.float32)  # H,S,V each 0-255
    H, S, V = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    newH, newS, newV = H.copy(), S.copy(), V.copy()
    mode = color_spec['mode']
    if mode == 'chroma':
        newH[:] = color_spec['hue']
        # Saturation floor 110 so a GREY source (S~0) still takes a clearly visible
        # tint (not a washed-out pastel); already-saturated pixels keep their level.
        newS = np.clip(np.maximum(S * color_spec['sat'], 110.0), 0, 255)
    elif mode == 'grey':
        newS = S * 0.10
    elif mode == 'black':
        newS = S * 0.20
        newV = V * 0.35
    elif mode == 'white':
        newS = S * 0.10
        newV = np.clip(V * 1.15 + 60, 0, 255)
    out_hsv = np.stack([np.clip(newH, 0, 255), np.clip(newS, 0, 255), np.clip(newV, 0, 255)], axis=-1).astype(np.uint8)
    recolored = Image.fromarray(out_hsv, mode='HSV').convert('RGB')
    m = (np.array(mask_soft).astype(np.float32) / 255.0) * float(max(0.0, min(1.0, strength)))
    m = m[..., None]
    base = np.array(img_rgb).astype(np.float32)
    blended = base * (1 - m) + np.array(recolored).astype(np.float32) * m
    return Image.fromarray(blended.clip(0, 255).astype(np.uint8), 'RGB')


def _clipseg_mask(img_work, work_w, work_h, target_text, dilate, rel=0.5):
    """CLIPSeg text->mask. The threshold is RELATIVE to the per-image peak response
    (rel*peak, floored at 60) so it keys on the strongly-detected region instead of
    everything matching weakly -> much tighter/precise. Higher rel = tighter."""
    inputs = state.clipseg_processor(text=[target_text.strip()], images=[img_work], padding=True, return_tensors="pt")
    inputs = {k: v.to("cuda") for k, v in inputs.items()}
    with torch.inference_mode():
        seg_out = state.clipseg_model(**inputs)
    mask_logits = seg_out.logits.squeeze().detach().cpu().numpy()
    mask_prob = 1 / (1 + np.exp(-mask_logits))
    arr = np.array(Image.fromarray((mask_prob * 255).astype(np.uint8)).resize((work_w, work_h), Image.LANCZOS)).astype(np.float32)
    thr = max(60.0, float(arr.max()) * float(rel))
    mask_binary = Image.fromarray((arr > thr).astype(np.uint8) * 255, mode="L")
    d = max(0, int(dilate))
    if d > 0:
        mask_binary = mask_binary.filter(ImageFilter.MaxFilter(d * 2 + 1))
    return mask_binary.filter(ImageFilter.GaussianBlur(3))


def do_recolor(input_path, prompt, output_path, strength=1.0, dilate=15, rel=0.5):
    """Auto-recolour: detect the named part (CLIPSeg) and recolour ONLY it via a
    luminance-preserving HSV shift (shape/folds intact). Falls back to
    ControlNet-Tile when the prompt names a material rather than a colour."""
    if not os.path.exists(input_path):
        return {"ok": False, "error": f"Input not found: {input_path}"}
    if not prompt or not prompt.strip():
        return {"ok": False, "error": "prompt required (e.g. 'cape rouge')"}
    noun, color_spec = parse_recolor_prompt(prompt)
    if color_spec is None:
        return do_recolor_tile(input_path, noun, prompt, output_path, dilate, rel)
    load_clipseg()
    with state.inference_lock:
        try:
            img = Image.open(input_path).convert("RGB")
            orig_size = img.size
            img_work, (work_w, work_h) = resize_for_sdxl(img, max_dim=1024)
            t0 = time.time()
            mask_soft = _clipseg_mask(img_work, work_w, work_h, noun, dilate, rel)
            coverage = (np.array(mask_soft) > 128).mean() * 100
            if coverage < 0.2:
                return {"ok": False, "error": f"'{noun}' not detected (coverage {coverage:.1f}%)"}
            if coverage > 80:
                log(f"WARNING: recolor mask covers {coverage:.0f}%", 'warn')
            save_debug_mask(output_path, mask_soft)
            recolored = recolor_hsv_masked(img_work, mask_soft, color_spec, strength)
            if (work_w, work_h) != orig_size:
                recolored = recolored.resize(orig_size, Image.LANCZOS)
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            recolored.save(output_path)
            elapsed = time.time() - t0
            log(f"recolor '{noun}'->{color_spec['word']} in {elapsed:.2f}s ({coverage:.0f}% mask)")
            return {"ok": True, "output": output_path, "time": elapsed, "mask_coverage": round(coverage, 1)}
        except Exception as e:
            log(f"recolor error: {e}", 'err')
            traceback.print_exc()
            return {"ok": False, "error": str(e)}


def do_recolor_tile(input_path, noun, full_prompt, output_path, dilate=15, rel=0.5):
    """ControlNet-Tile fallback for material/non-colour requests ('metal rouille',
    'cuir vieilli'): low-denoise structure-preserving re-paint, composited through
    the CLIPSeg mask so only the detected region changes."""
    if not os.path.exists(input_path):
        return {"ok": False, "error": f"Input not found: {input_path}"}
    load_clipseg()
    if state.img2img_pipe is not None:
        unload_model('img2img')
    pipe = load_controlnet_tile()
    state.last_use['controlnet_tile'] = time.time()
    with state.inference_lock:
        try:
            img = Image.open(input_path).convert("RGB")
            orig_size = img.size
            img_work, (work_w, work_h) = resize_for_sdxl(img, max_dim=1024)
            t0 = time.time()
            mask_soft = _clipseg_mask(img_work, work_w, work_h, noun or full_prompt, dilate, rel)
            coverage = (np.array(mask_soft) > 128).mean() * 100
            if coverage < 0.2:
                return {"ok": False, "error": f"'{noun}' not detected (coverage {coverage:.1f}%)"}
            with torch.inference_mode():
                result = pipe(
                    prompt=f"{full_prompt}, same shape, preserve folds and details, photorealistic",
                    negative_prompt="deformed, distorted, blurry, low quality, changed shape, extra parts",
                    image=img_work,
                    control_image=img_work,
                    strength=0.18,
                    num_inference_steps=20,
                    guidance_scale=5.5,
                    controlnet_conditioning_scale=0.65,
                    generator=torch.Generator("cuda").manual_seed(42),
                ).images[0]
            if result.size != (work_w, work_h):
                result = result.resize((work_w, work_h), Image.LANCZOS)
            m = (np.array(mask_soft).astype(np.float32) / 255.0)[..., None]
            out = np.array(img_work).astype(np.float32) * (1 - m) + np.array(result).astype(np.float32) * m
            final = Image.fromarray(out.clip(0, 255).astype(np.uint8), 'RGB')
            if (work_w, work_h) != orig_size:
                final = final.resize(orig_size, Image.LANCZOS)
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            final.save(output_path)
            elapsed = time.time() - t0
            log(f"recolor-tile '{noun}' in {elapsed:.1f}s ({coverage:.0f}% mask)")
            return {"ok": True, "output": output_path, "time": elapsed, "mask_coverage": round(coverage, 1)}
        except Exception as e:
            log(f"recolor-tile error: {e}", 'err')
            traceback.print_exc()
            free_vram()
            return {"ok": False, "error": str(e)}


def do_tex_variant(input_path, prompt, output_path, strength=0.45, seed=0):
    """Structure-locked TEXTURE variant: ControlNet-Tile keeps the shape/geometry
    (the original image is the control) while regenerating the surface/texture.
    The generated element does NOT move — only the texture/colours vary per seed."""
    if not os.path.exists(input_path):
        return {"ok": False, "error": f"Input not found: {input_path}"}
    if state.img2img_pipe is not None:
        unload_model('img2img')
    pipe = load_controlnet_tile()
    state.last_use['controlnet_tile'] = time.time()
    with state.inference_lock:
        try:
            img = Image.open(input_path).convert("RGB")
            orig_size = img.size
            img_work, (work_w, work_h) = resize_for_sdxl(img, max_dim=1024)
            t0 = time.time()
            p = (prompt or "").strip() or "high quality, detailed, sharp focus, intricate textures, game asset"
            with torch.inference_mode():
                result = pipe(
                    prompt=p,
                    negative_prompt="deformed, distorted, changed shape, different pose, extra parts, missing parts, blurry, low quality",
                    image=img_work,
                    control_image=img_work,
                    strength=float(max(0.35, min(0.9, strength))),
                    num_inference_steps=28,
                    guidance_scale=7.5,
                    # LOW conditioning so the silhouette/pose is held but the
                    # texture/material/colour can change A LOT (metal->gold, grey
                    # horse->brown). High scale (0.9) kept the colours = no real change.
                    controlnet_conditioning_scale=0.45,
                    generator=torch.Generator("cuda").manual_seed(int(seed)),
                ).images[0]
            if result.size != orig_size:
                result = result.resize(orig_size, Image.LANCZOS)
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            result.save(output_path)
            elapsed = time.time() - t0
            log(f"tex_variant seed={seed} strength={strength} in {elapsed:.1f}s -> {output_path}")
            return {"ok": True, "output": output_path, "time": elapsed}
        except Exception as e:
            log(f"tex_variant error: {e}", 'err')
            traceback.print_exc()
            free_vram()
            return {"ok": False, "error": str(e)}


def do_segment(input_path, target_text, output_path, dilate=15, rel=0.5):
    """CLIPSeg detection ONLY (no inpaint): save a red overlay of the detected
    mask so the user can preview LIVE what Auto Inpaint will repaint. Loads only
    the small CLIPSeg model, never the heavy ~6 GB inpaint pipeline."""
    if not os.path.exists(input_path):
        return {"ok": False, "error": f"Input not found: {input_path}"}
    if not target_text or not target_text.strip():
        return {"ok": False, "error": "target_text required"}
    load_clipseg()
    state.last_use['inpaint'] = time.time()
    with state.inference_lock:
        try:
            # Put the inputs on the SAME device as CLIPSeg — model_cpu_offload on
            # the other pipelines can leave CLIPSeg on CPU, and forcing inputs to
            # cuda then crashed ("Input cuda vs weight cpu"). Re-pin to GPU when
            # available, then follow whatever device the model is actually on.
            try:
                if torch.cuda.is_available():
                    state.clipseg_model.to('cuda')
            except Exception:
                pass
            _dev = next(state.clipseg_model.parameters()).device
            img = Image.open(input_path).convert("RGB")
            img_work, (work_w, work_h) = resize_for_sdxl(img, max_dim=1024)
            inputs = state.clipseg_processor(
                text=[target_text.strip()], images=[img_work],
                padding=True, return_tensors="pt")
            inputs = {k: v.to(_dev) for k, v in inputs.items()}
            with torch.inference_mode():
                seg_out = state.clipseg_model(**inputs)
            mask_logits = seg_out.logits.squeeze().detach().cpu().numpy()
            mask_prob = 1 / (1 + np.exp(-mask_logits))  # sigmoid
            mask_uint8 = (mask_prob * 255).astype(np.uint8)
            # Upscale the low-res CLIPSeg mask with LANCZOS (BILINEAR was blocky).
            mask_img = Image.fromarray(mask_uint8).resize((work_w, work_h), Image.LANCZOS)
            # Threshold RELATIVE to the per-image peak (rel*peak, floor 60) so the
            # preview keys on the strongly-detected region, not weak spillover.
            _arr = np.array(mask_img).astype(np.float32)
            binary = (_arr > max(60.0, float(_arr.max()) * float(rel))).astype(np.uint8) * 255
            mask_binary = Image.fromarray(binary, mode="L")
            d = max(0, int(dilate))
            if d > 0:
                mask_binary = mask_binary.filter(ImageFilter.MaxFilter(d * 2 + 1))
            # Feathered soft mask for a SMOOTH preview overlay (not a blocky binary).
            _feather = max(3, int(min(work_w, work_h) * 0.012))
            mask_soft = mask_binary.filter(ImageFilter.GaussianBlur(_feather))
            coverage = (np.array(mask_soft) > 128).mean() * 100
            # Red overlay so the user sees exactly what will be repainted.
            red = Image.new("RGB", img_work.size, (255, 45, 60))
            tinted = Image.blend(img_work, red, 0.55)
            overlay = Image.composite(tinted, img_work, mask_soft)
            if (work_w, work_h) != img.size:
                overlay = overlay.resize(img.size, Image.LANCZOS)
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            overlay.save(output_path)
            return {"ok": True, "output": output_path, "coverage": round(coverage, 1)}
        except Exception as e:
            log(f"segment error: {e}", 'err')
            return {"ok": False, "error": str(e)}


# ========== MASK INPAINT HELPERS (ported from cloud cat8) ==========
# Concept-specific boosters — SDXL Inpaint v1.0 is weak on bare nouns
# for distinctive objects. A bare "bazooka" gets generated as a tube
# or pipe. Adding concept-specific synonyms + visual descriptors
# disambiguates ("M72 LAW", "shoulder-fired rocket launcher", etc.).
# Keys are matched case-insensitively as substrings in the user's
# stripped noun phrase.
_CONCEPT_BOOSTERS = {
    # Weapons
    'bazooka': 'M1 bazooka shoulder-fired rocket launcher, large green metal tube, military weapon, tactical hardware',
    'rocket launcher': 'M72 LAW shoulder-fired rocket launcher, large tube weapon, military tactical hardware',
    'sword': 'large medieval sword, sharp steel blade, leather-wrapped hilt, fantasy weapon',
    'shield': 'large round battle shield, embossed metal, leather straps, fantasy armor',
    'gun': 'realistic firearm, metallic, detailed mechanism',
    'rifle': 'tactical assault rifle, military firearm, detailed scope and stock',
    'axe':   'heavy battle axe, sharp steel blade, wooden handle, fantasy weapon',
    # Armor / clothing
    'helmet': 'fitted protective helmet, metal alloy, articulated visor, fantasy armor',
    'crown': 'ornate royal crown, gold inlay, jewels, fantasy regalia',
    'hat':   'fitted hat, recognizable headwear',
    'cape':  'flowing fabric cape, draped, ornate trim',
    'mask':  'theatrical face mask, detailed, expressive features',
    # Sci-fi / transformations
    'robotic': 'cyborg face, mechanical metallic plating, glowing red eye, exposed wires, sci-fi cybernetic, chrome and steel, hyper-detailed',
    'cyborg':  'cyborg face, mechanical metallic plating, glowing red eye, exposed wires, sci-fi cybernetic, chrome and steel, hyper-detailed',
    'android': 'android face, smooth synthetic skin, mechanical components visible at seams, sci-fi humanoid',
    'cybernetic': 'cyborg face, mechanical metallic plating, glowing red eye, exposed wires, sci-fi cybernetic',
    'robot face': 'robotic face, metallic head, glowing eyes, mechanical jaw, chrome plating, sci-fi',
    # Fantasy creatures
    'wings': 'large feathered wings spread wide, anatomically integrated',
    'dragon': 'majestic dragon, scaled, large wings',
    'horns':  'curved fantasy horns, bone texture, naturally integrated',
    # Nature
    'flower': 'large blooming flower, vibrant petals, garden quality, botanical',
    'fire':   'bright flames, glowing embers, smoke wisps',
    'lightning': 'electric lightning bolts, bright glowing arcs, energy crackling',
}


def _boost(obj: str) -> str:
    low = obj.lower()
    for key, repl in _CONCEPT_BOOSTERS.items():
        if key in low:
            return f'{repl}, in place of "{obj}"'
    return obj


def _enrich_prompt(raw: str) -> tuple:
    """Light prompt cleanup: strip add/put/place verbs, expand concept
    boosters, build a sane negative prompt. Returns (positive, negative)."""
    p = (raw or '').strip()
    if not p:
        return ('continuation of the surrounding area, seamless',
                'object, item, blurry, distorted')

    low = p.lower()
    add_m = re.match(r'^(?:add|put|place|insert|paint|draw)\s+(?:a|an|the|some)?\s*(.+)$',
                     low, flags=re.IGNORECASE)
    rem_m = re.match(r'^(?:remove|delete|erase|hide|clear)\s+(?:the|a|an)?\s*(.+)$',
                     low, flags=re.IGNORECASE)

    if rem_m:
        target = rem_m.group(1).strip()
        return (
            f'continuation of the surrounding area, same background, '
            f'no {target}, seamless',
            f'{target}, any object, duplicate, artifact, blurry, distorted'
        )

    obj = add_m.group(1).strip() if add_m else p
    boosted = _boost(obj)
    positive = f'{boosted}, detailed, photorealistic'
    negative = 'blurry, distorted, low quality, deformed, watermark, text'
    return (positive, negative)


def _mask_bbox(msk, threshold: int = 30):
    """Return (x0, y0, x1, y1) of the painted region, or None if empty."""
    arr = np.array(msk)
    if arr.ndim == 3:
        arr = arr[..., 0]
    ys, xs = np.where(arr > threshold)
    if len(ys) == 0:
        return None
    return (int(xs.min()), int(ys.min()),
            int(xs.max()) + 1, int(ys.max()) + 1)


def do_mask_inpaint(input_path, mask_path, prompt, output_path):
    """Inpaint using a user-provided mask (white = inpaint, black = keep).

    Crop-inpaint-paste strategy (ported from cloud cat8):
      - bbox of mask, square-pad 30%, crop to bbox, inpaint at 1024², paste back
      - >40% coverage → fall back to global path
      - composite-back with full-res blurred mask so only painted pixels change
      - prompt enrichment via _enrich_prompt (concept boosters, add/remove verbs)
    """
    if not os.path.exists(input_path):
        return {"ok": False, "error": f"Input not found: {input_path}"}
    if not os.path.exists(mask_path):
        return {"ok": False, "error": f"Mask not found: {mask_path}"}

    # Only one SDXL pipeline at a time — see do_img2img comment above.
    # Unload img2img before loading inpaint so we stay under 16 GB VRAM.
    if state.img2img_pipe is not None:
        unload_model('img2img')

    pipe = load_inpaint()
    state.last_use['inpaint'] = time.time()

    sdxl_native = 1024
    max_dim = 1024

    with state.inference_lock:
        try:
            src = Image.open(input_path).convert("RGB")
            msk = Image.open(mask_path).convert("L")

            orig_w, orig_h = src.size
            if msk.size != (orig_w, orig_h):
                msk = msk.resize((orig_w, orig_h), Image.LANCZOS)

            pos_prompt, neg_prompt = _enrich_prompt(prompt)

            bbox = _mask_bbox(msk)
            if bbox is None:
                return {"ok": False, "error": "Mask is empty"}

            bx0, by0, bx1, by1 = bbox
            bw, bh = bx1 - bx0, by1 - by0
            mask_frac = (bw * bh) / float(orig_w * orig_h)
            coverage = mask_frac * 100
            log(f"mask_inpaint bbox={bbox} frac={mask_frac:.3f} "
                f"enriched=\"{pos_prompt[:100]}...\"")

            # Debug-save the full-res mask used for compositing
            save_debug_mask(output_path, msk)

            # >40% → global path (less risk of edge artefacts)
            use_global = mask_frac > 0.40

            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            t0 = time.time()

            if not use_global:
                # ---- Crop branch ----
                cx = (bx0 + bx1) / 2
                cy = (by0 + by1) / 2
                side = max(bw, bh) * 1.6  # 30% padding each side
                side = max(side, max(orig_w, orig_h) * 0.20)
                side = min(side, min(orig_w, orig_h))
                cx0 = max(0, int(cx - side / 2))
                cy0 = max(0, int(cy - side / 2))
                cx1 = min(orig_w, cx0 + int(side))
                cy1 = min(orig_h, cy0 + int(side))
                if cx1 - cx0 < int(side):
                    cx0 = max(0, cx1 - int(side))
                if cy1 - cy0 < int(side):
                    cy0 = max(0, cy1 - int(side))

                crop_img = src.crop((cx0, cy0, cx1, cy1))
                crop_msk = msk.crop((cx0, cy0, cx1, cy1))
                cw, ch = crop_img.size

                work = (sdxl_native // 8) * 8
                crop_img_w = crop_img.resize((work, work), Image.LANCZOS)
                crop_msk_w = crop_msk.resize((work, work), Image.LANCZOS) \
                                     .filter(ImageFilter.GaussianBlur(2))

                with torch.inference_mode():
                    result_w = pipe(
                        prompt=pos_prompt,
                        negative_prompt=neg_prompt,
                        image=crop_img_w,
                        mask_image=crop_msk_w,
                        num_inference_steps=40,
                        guidance_scale=8.5,
                        strength=0.99,
                        height=work, width=work,
                    ).images[0]

                result_crop = result_w.resize((cw, ch), Image.LANCZOS)
                composed = src.copy()
                composed.paste(result_crop, (cx0, cy0))

                # Composite-back with FULL-RES mask — only painted pixels change
                msk_full = msk.filter(ImageFilter.GaussianBlur(1.5))
                src_arr = np.array(src, dtype=np.float32)
                new_arr = np.array(composed, dtype=np.float32)
                mask_arr = np.array(msk_full, dtype=np.float32) / 255.0
                if mask_arr.ndim == 2:
                    mask_arr = mask_arr[..., None]
                blend = src_arr * (1.0 - mask_arr) + new_arr * mask_arr
                final = Image.fromarray(np.clip(blend, 0, 255).astype(np.uint8), 'RGB')
            else:
                # ---- Global branch (large mask) ----
                if max(orig_w, orig_h) > max_dim:
                    if orig_w > orig_h:
                        work_w, work_h = max_dim, int(orig_h * max_dim / orig_w)
                    else:
                        work_h, work_w = max_dim, int(orig_w * max_dim / orig_h)
                else:
                    work_w, work_h = orig_w, orig_h
                work_w = (work_w // 8) * 8
                work_h = (work_h // 8) * 8

                img_work = src.resize((work_w, work_h), Image.LANCZOS)
                msk_work = msk.resize((work_w, work_h), Image.LANCZOS)
                msk_work_soft = msk_work.filter(ImageFilter.GaussianBlur(3))

                with torch.inference_mode():
                    result = pipe(
                        prompt=pos_prompt,
                        negative_prompt=neg_prompt,
                        image=img_work,
                        mask_image=msk_work_soft,
                        num_inference_steps=40,
                        guidance_scale=8.5,
                        strength=0.99,
                        height=work_h, width=work_w,
                    ).images[0]

                if (work_w, work_h) != (orig_w, orig_h):
                    result = result.resize((orig_w, orig_h), Image.LANCZOS)
                    msk_full = msk.filter(ImageFilter.GaussianBlur(3))
                else:
                    msk_full = msk_work_soft

                src_arr = np.array(src, dtype=np.float32)
                new_arr = np.array(result, dtype=np.float32)
                mask_arr = np.array(msk_full, dtype=np.float32) / 255.0
                if mask_arr.ndim == 2:
                    mask_arr = mask_arr[..., None]
                blend = src_arr * (1.0 - mask_arr) + new_arr * mask_arr
                final = Image.fromarray(np.clip(blend, 0, 255).astype(np.uint8), 'RGB')

            final.save(output_path)
            elapsed = time.time() - t0
            log(f"mask_inpaint done in {elapsed:.1f}s "
                f"({coverage:.0f}% mask, {'global' if use_global else 'crop'}) "
                f"-> {output_path}")
            return {"ok": True, "output": output_path, "time": elapsed,
                    "mask_coverage": round(coverage, 1)}
        except Exception as e:
            log(f"mask_inpaint error: {e}", 'err')
            traceback.print_exc()
            free_vram()
            return {"ok": False, "error": str(e)}


# ========== HTTP HANDLER ==========
class Handler(BaseHTTPRequestHandler):
    # Suppress default request logging
    def log_message(self, format, *args):
        pass

    def _json_response(self, code, data):
        try:
            body = json.dumps(data, ensure_ascii=False).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # client gone

    def do_GET(self):
        if self.path == '/ping':
            self._json_response(200, {
                "ok": True,
                "status": "ready",
                "models": {
                    "img2img": state.img2img_pipe is not None,
                    "inpaint": state.inpaint_pipe is not None,
                    "controlnet_tile": state.controlnet_tile_pipe is not None,
                    "clipseg": state.clipseg_model is not None,
                },
                "vram_gb": round(vram_used_gb(), 2),
            })
        elif self.path == '/status':
            self._json_response(200, {
                "ok": True,
                "models_loaded": {
                    "img2img": state.img2img_pipe is not None,
                    "inpaint": state.inpaint_pipe is not None,
                    "controlnet_tile": state.controlnet_tile_pipe is not None,
                    "clipseg": state.clipseg_model is not None,
                },
                "last_use": state.last_use,
                "vram_used_gb": round(vram_used_gb(), 2),
                "vram_total_gb": round(vram_total_gb(), 2),
                "vram_free_gb": round(vram_total_gb() - vram_used_gb(), 2),
            })
        else:
            self._json_response(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            if length == 0:
                data = {}
            else:
                raw = self.rfile.read(length)
                data = json.loads(raw.decode('utf-8'))
        except Exception as e:
            self._json_response(400, {"ok": False, "error": f"bad json: {e}"})
            return

        try:
            if self.path == '/img2img':
                if 'input' not in data or 'output' not in data:
                    self._json_response(400, {"ok": False, "error": "missing input/output"})
                    return
                # HTTP-layer strength default kept at 0.55 for back-compat with
                # all existing renderer callsites (ipcMain `img2img` handler in
                # src/main/main.js). New "Modify Image" UI should pass
                # strength=0.35 + guidance=7.0 explicitly.
                result = do_img2img(
                    data['input'],
                    data.get('prompt', ''),
                    data['output'],
                    data.get('strength', 0.55),
                    guidance=data.get('guidance', 7.0),
                    steps=data.get('steps', None),
                    seed=data.get('seed', 42),
                )
                self._json_response(200 if result.get('ok') else 500, result)

            elif self.path == '/img2img_tile':
                if 'input' not in data or 'output' not in data:
                    self._json_response(400, {"ok": False, "error": "missing input/output"})
                    return
                result = do_img2img_tile(
                    data['input'],
                    data.get('prompt', ''),
                    data['output'],
                    data.get('strength', 0.55),
                    data.get('controlnet_scale', 0.7),
                    data.get('guidance_scale', 6.0),
                    data.get('steps', None),
                    data.get('seed', 42),
                )
                self._json_response(200 if result.get('ok') else 500, result)

            elif self.path == '/inpaint':
                if 'input' not in data or 'output' not in data or 'target' not in data:
                    self._json_response(400, {"ok": False, "error": "missing input/output/target"})
                    return
                result = do_inpaint(
                    data['input'],
                    data['target'],
                    data.get('prompt', ''),
                    data['output'],
                    data.get('dilate', 15),
                    data.get('rel', 0.5),
                )
                self._json_response(200 if result.get('ok') else 500, result)

            elif self.path == '/segment':
                if 'input' not in data or 'output' not in data or 'target' not in data:
                    self._json_response(400, {"ok": False, "error": "missing input/output/target"})
                    return
                result = do_segment(
                    data['input'],
                    data['target'],
                    data['output'],
                    data.get('dilate', 15),
                    data.get('rel', 0.5),
                )
                self._json_response(200 if result.get('ok') else 500, result)

            elif self.path == '/recolor':
                if 'input' not in data or 'output' not in data or 'prompt' not in data:
                    self._json_response(400, {"ok": False, "error": "missing input/output/prompt"})
                    return
                result = do_recolor(
                    data['input'],
                    data['prompt'],
                    data['output'],
                    data.get('strength', 1.0),
                    data.get('dilate', 15),
                    data.get('rel', 0.5),
                )
                self._json_response(200 if result.get('ok') else 500, result)

            elif self.path == '/tex_variant':
                if 'input' not in data or 'output' not in data:
                    self._json_response(400, {"ok": False, "error": "missing input/output"})
                    return
                result = do_tex_variant(
                    data['input'],
                    data.get('prompt', ''),
                    data['output'],
                    data.get('strength', 0.45),
                    data.get('seed', 0),
                )
                self._json_response(200 if result.get('ok') else 500, result)

            elif self.path == '/mask_inpaint':
                if 'input' not in data or 'output' not in data or 'mask' not in data:
                    self._json_response(400, {"ok": False, "error": "missing input/output/mask"})
                    return
                result = do_mask_inpaint(
                    data['input'],
                    data['mask'],
                    data.get('prompt', ''),
                    data['output'],
                )
                self._json_response(200 if result.get('ok') else 500, result)

            elif self.path == '/unload':
                model_name = data.get('model', '')
                if model_name in ('img2img', 'inpaint', 'clipseg'):
                    unload_model(model_name)
                    self._json_response(200, {"ok": True, "vram_gb": round(vram_used_gb(), 2)})
                else:
                    self._json_response(400, {"ok": False, "error": "model must be img2img/inpaint/clipseg"})

            elif self.path == '/shutdown':
                self._json_response(200, {"ok": True, "bye": True})
                log("Shutdown requested")
                threading.Thread(target=lambda: (time.sleep(0.3), os._exit(0)), daemon=True).start()

            else:
                self._json_response(404, {"ok": False, "error": "not found"})

        except Exception as e:
            log(f"handler error: {e}", 'err')
            traceback.print_exc()
            self._json_response(500, {"ok": False, "error": str(e)})


# ========== STARTUP ==========
def preload_models():
    """Preload img2img + CLIPSeg (tiny ~400MB). Inpaint loads on demand."""
    try:
        log("Preloading CLIPSeg (mask detection)...")
        load_clipseg()   # so the FIRST Auto-Inpaint detection is a warm GPU call (~10s cold-load gone)
        log("Preloading RealVis XL img2img...")
        load_img2img()
        log("MODELS READY - img2img + CLIPSeg loaded (inpaint on first use)")
    except Exception as e:
        log(f"Preload failed: {e}", 'err')
        traceback.print_exc()


def main():
    log(f"Starting on http://{HOST}:{PORT}")
    log(f"Python {sys.version.split()[0]} | torch {torch.__version__}")
    if torch.cuda.is_available():
        log(f"GPU: {torch.cuda.get_device_name(0)} ({vram_total_gb():.1f} GB)")
    else:
        log("WARNING: No CUDA GPU detected", 'warn')

    server = ThreadingHTTPServer((HOST, PORT), Handler)
    log("HTTP server listening (loading models in background...)")

    # Preload in background so first call is instant
    threading.Thread(target=preload_models, daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("Stopped (Ctrl+C)")
    finally:
        free_vram()


if __name__ == "__main__":
    main()
