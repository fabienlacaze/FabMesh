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


def load_img2img():
    """Lazy-load SDXL Turbo img2img pipeline."""
    if state.img2img_pipe is not None:
        state.last_use['img2img'] = time.time()
        return state.img2img_pipe

    with state.load_lock:
        if state.img2img_pipe is not None:
            return state.img2img_pipe
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
        pipe.enable_attention_slicing()
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


def load_inpaint():
    """Lazy-load SDXL Inpainting + CLIPSeg."""
    if state.inpaint_pipe is not None and state.clipseg_model is not None:
        state.last_use['inpaint'] = time.time()
        return state.inpaint_pipe

    with state.load_lock:
        # CLIPSeg first (small model, ~400 MB)
        if state.clipseg_model is None:
            log(f"Loading {CLIPSEG_MODEL}...")
            from transformers import CLIPSegForImageSegmentation, CLIPSegProcessor
            t0 = time.time()
            state.clipseg_processor = CLIPSegProcessor.from_pretrained(CLIPSEG_MODEL)
            state.clipseg_model = CLIPSegForImageSegmentation.from_pretrained(CLIPSEG_MODEL)
            state.clipseg_model.to("cuda")
            state.clipseg_model.eval()
            log(f"CLIPSeg loaded in {time.time()-t0:.1f}s")

        # SDXL Inpainting (large model, ~6 GB)
        if state.inpaint_pipe is None:
            log(f"Loading {SDXL_INPAINT_MODEL}...")
            _set_memory_fraction()
            from diffusers import StableDiffusionXLInpaintPipeline
            t0 = time.time()
            pipe = StableDiffusionXLInpaintPipeline.from_pretrained(
                SDXL_INPAINT_MODEL,
                torch_dtype=torch.float16,
                variant="fp16",
            )
            pipe.to("cuda")
            # Same fp16 force-cast as img2img (diffusers 0.34 / torch 2.7.1)
            try:
                pipe.unet.to(torch.float16)
                pipe.vae.to(torch.float16)
                pipe.text_encoder.to(torch.float16)
                pipe.text_encoder_2.to(torch.float16)
            except Exception as _e:
                log(f"inpaint fp16 cast skipped: {_e}")
            pipe.enable_attention_slicing()
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
        pipe.enable_attention_slicing()
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


def do_inpaint(input_path, target_text, prompt, output_path, dilate=15):
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

            mask_img = Image.fromarray(mask_uint8).resize((work_w, work_h), Image.BILINEAR)
            mask_arr = np.array(mask_img)
            binary = (mask_arr > 100).astype(np.uint8) * 255
            mask_binary = Image.fromarray(binary, mode="L")

            # Dilate mask for context blending
            d = max(0, int(dilate))
            if d > 0:
                mask_binary = mask_binary.filter(ImageFilter.MaxFilter(d * 2 + 1))
            mask_binary = mask_binary.filter(ImageFilter.GaussianBlur(3))

            coverage = (np.array(mask_binary) > 128).mean() * 100
            if coverage < 0.5:
                return {"ok": False, "error": f"Target '{target_text}' not detected (coverage {coverage:.1f}%)"}
            if coverage > 80:
                log(f"WARNING: mask covers {coverage:.0f}% of image", 'warn')

            save_debug_mask(output_path, mask_binary)

            # === Step 2: SDXL Inpainting ===
            inpaint_prompt = (prompt or "").strip()
            removal_keywords = ("", "remove", "delete", "none", "nothing", "empty", "gone")
            is_removal = inpaint_prompt.lower() in removal_keywords

            if is_removal:
                inpaint_prompt = "continuation of the surrounding area, same background, seamless"
                negative_prompt = f"{target_text}, any object, duplicate, artifact, blurry, distorted, deformed"
            else:
                negative_prompt = f"blurry, distorted, duplicate, deformed, low quality, {target_text}"

            with torch.inference_mode():
                result = pipe(
                    prompt=inpaint_prompt,
                    negative_prompt=negative_prompt,
                    image=img_work,
                    mask_image=mask_binary,
                    num_inference_steps=40,
                    guidance_scale=8.5,
                    strength=0.99,
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
    """Preload only img2img model (most common). Inpaint loads on demand."""
    try:
        log("Preloading RealVis XL img2img...")
        load_img2img()
        log("MODELS READY - img2img loaded (inpaint on first use)")
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
