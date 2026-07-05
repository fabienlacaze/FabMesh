"""
FabMesh SDXL Persistent Server
Keeps SDXL Turbo img2img + SDXL Inpainting + CLIPSeg in memory
to avoid 5-10s reload per call.

Listens on 127.0.0.1:5555 via simple HTTP/JSON.

Endpoints:
  GET  /ping              - health check + model status
  GET  /status            - detailed model + GPU status
  POST /img2img           - { input, prompt, output, strength, guidance, steps, seed }
  POST /img2img_tile      - { input, prompt, output, strength, controlnet_scale, guidance_scale, steps, seed, negative_prompt, control_guidance_end }
  POST /refine_geo        - GEOMETRY-GUIDED + reference-anchored refine.
                            { input, control, ref, prompt, output, strength,
                              controlnet_scale, ip_scale, guidance_scale, steps,
                              seed, negative_prompt, control_guidance_end }
                            `control` is a world-space NORMAL map (or depth map)
                            rendered from the mesh; the ControlNet-Union (normal
                            mode) makes detail follow REAL surface geometry, and
                            an IP-Adapter on `ref` keeps it faithful to the
                            reference image. Replaces ControlNet-Tile for organic
                            texture (no more hallucinated runes / frayed hair).
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
# ControlNet-Union SDXL — xinsir/controlnet-union-sdxl-1.0 (Apache 2.0,
# commercial-safe). A single union model that handles 6 control types; we use
# it in NORMAL mode (control_mode index 4) so the geometry-guided refine pass
# conditions SDXL on the mesh's REAL surface normals — detail follows actual
# geometry instead of free-associating (the ControlNet-Tile rune/hair failure).
CONTROLNET_UNION_MODEL = "xinsir/controlnet-union-sdxl-1.0"
# control_mode integer index for the NORMAL condition in the union model.
# Mapping (from xinsir6/ControlNetPlus + diffusers): 0=openpose, 1=depth,
# 2=hed/scribble/softedge, 3=canny/lineart/mlsd, 4=normal, 5=segment.
CONTROLNET_UNION_NORMAL_MODE = 4
# IP-Adapter — h94/IP-Adapter (Apache 2.0). The base SDXL ip-adapter keeps the
# refine faithful to the reference image (image-prompt conditioning) without a
# face model. Loaded onto the geo pipe; the image encoder (ViT) is auto-fetched
# from the same repo's `models/image_encoder` subfolder by load_ip_adapter.
IP_ADAPTER_REPO = "h94/IP-Adapter"
IP_ADAPTER_SUBFOLDER = "sdxl_models"
IP_ADAPTER_WEIGHT = "ip-adapter_sdxl.bin"

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
        self.controlnet_geo_pipe = None
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
    if keep != 'controlnet_geo' and state.controlnet_geo_pipe is not None:
        del state.controlnet_geo_pipe
        state.controlnet_geo_pipe = None
        freed.append('controlnet_geo')
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
            pipe.vae.config.force_upcast = False  # fp16-fix VAE is fp16-stable; no fp32 upcast (fixes Half vs float)
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
                pipe.vae.config.force_upcast = False  # fp16-fix VAE is fp16-stable; no fp32 upcast (fixes Half vs float)
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
            pipe.vae.config.force_upcast = False  # fp16-fix VAE is fp16-stable; no fp32 upcast (fixes Half vs float)
        except Exception as _ve:
            log(f"tile fp16-fix VAE unavailable ({_ve})")
            try:
                pipe.vae.config.force_upcast = True
            except Exception:
                pass
        # fp16 force-cast (diffusers 0.34 / torch 2.7.1) — dtype only, BEFORE the
        # offload hooks are attached (modules still on CPU here).
        try:
            pipe.unet.to(torch.float16)
            pipe.vae.to(torch.float16)
            pipe.text_encoder.to(torch.float16)
            pipe.text_encoder_2.to(torch.float16)
            if hasattr(pipe, 'controlnet'):
                pipe.controlnet.to(torch.float16)
        except Exception as _e:
            log(f"controlnet_tile fp16 cast skipped: {_e}")
        # VRAM: model_cpu_offload keeps ONLY the active module on the GPU (peak
        # ~4-6 GB) instead of pipe.to("cuda") which holds the whole ~12 GB
        # ControlNet+img2img pipe resident. On a 16 GB card (Windows, where
        # expandable_segments is unsupported → no defrag) the resident version
        # spilled to system RAM and thrashed — the Age/recolor tool then took
        # minutes and looked stuck. Offload is a bit slower per step but never
        # spills, so wall-clock is far better when VRAM is tight.
        pipe.enable_model_cpu_offload()
        pipe.enable_vae_tiling()
        if os.environ.get('FABMESH_UNRESTRICTED') == '1':
            if hasattr(pipe, 'safety_checker'):
                pipe.safety_checker = None
        state.controlnet_tile_pipe = pipe
        state.last_use['controlnet_tile'] = time.time()
        log(f"controlnet_tile loaded in {time.time()-t0:.1f}s "
            f"({vram_used_gb():.1f} GB VRAM)")
    return state.controlnet_tile_pipe


def load_controlnet_geo():
    """Lazy-load RealVisXL + ControlNet-Union (NORMAL mode) img2img pipeline,
    with an IP-Adapter on top, for the geometry-guided + reference-anchored
    refine pass (do_refine_geo).

    This is the Meshy-style path: the ControlNet conditions SDXL on the mesh's
    REAL surface normals (control_mode=4) so added detail follows actual
    geometry instead of hallucinating; the IP-Adapter conditions on the source
    reference image so the texture stays faithful. Together they replace the
    ControlNet-Tile refine that invented runes on a wizard's beard.

    VRAM ~10-11 GB (RealVisXL + union controlnet + IP-Adapter image encoder).
    Mirrors load_controlnet_tile: frees the other heavy pipes first.
    """
    if state.controlnet_geo_pipe is not None:
        state.last_use['controlnet_geo'] = time.time()
        return state.controlnet_geo_pipe

    with state.load_lock:
        if state.controlnet_geo_pipe is not None:
            return state.controlnet_geo_pipe
        _free_heavy_except('controlnet_geo')
        log(f"Loading {CONTROLNET_UNION_MODEL} (normal mode) + {IMG2IMG_MODEL} "
            f"+ IP-Adapter...")
        _set_memory_fraction()
        from diffusers import (
            ControlNetUnionModel,
            StableDiffusionXLControlNetUnionImg2ImgPipeline,
        )
        t0 = time.time()
        controlnet = ControlNetUnionModel.from_pretrained(
            CONTROLNET_UNION_MODEL,
            torch_dtype=torch.float16,
            use_safetensors=True,
        )
        pipe = StableDiffusionXLControlNetUnionImg2ImgPipeline.from_pretrained(
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
            pipe.vae.config.force_upcast = False  # fp16-fix VAE is fp16-stable; no fp32 upcast (fixes Half vs float)
        except Exception as _ve:
            log(f"geo fp16-fix VAE unavailable ({_ve})")
            try:
                pipe.vae.config.force_upcast = True
            except Exception:
                pass
        # IP-Adapter adds the ViT-H image encoder (~2.5 GB VRAM + RAM). With it the
        # full pipe is ~13.6 GB -> on a 16 GB card it needs cpu-offload, whose
        # CPU<->GPU swap THRASHES when system RAM is tight (Electron/app running) =>
        # ~70-100s/step. DEFAULT OFF so the pipe is ~9.5 GB and fits in VRAM WITHOUT
        # offload (stable, ~2s/step). The geometry (normal) ControlNet is the real
        # face-preservation lever anyway. Set FABMESH_GEO_IPADAPTER=1 on Modal / a
        # bigger card to re-enable reference anchoring.
        _geo_use_ip = os.environ.get('FABMESH_GEO_IPADAPTER', '0') == '1'
        _ip_loaded = False
        if _geo_use_ip:
            try:
                pipe.load_ip_adapter(
                    IP_ADAPTER_REPO,
                    subfolder=IP_ADAPTER_SUBFOLDER,
                    weight_name=IP_ADAPTER_WEIGHT,
                )
                _ip_loaded = True
                log("IP-Adapter loaded onto geo pipe")
            except Exception as _ie:
                log(f"IP-Adapter load FAILED ({_ie}); geo pipe runs controlnet-only",
                    'warn')
        else:
            log("IP-Adapter OFF (FABMESH_GEO_IPADAPTER=0) — controlnet-only, "
                "fits VRAM without offload")
        pipe._fabmesh_has_ip = _ip_loaded
        # fp16 dtype cast FIRST (dtype only, on CPU — the cpu-offload hooks below
        # install device placement, so we must NOT pipe.to('cuda') here).
        try:
            pipe.unet.to(torch.float16)
            pipe.vae.to(torch.float16)
            pipe.text_encoder.to(torch.float16)
            pipe.text_encoder_2.to(torch.float16)
            if hasattr(pipe, 'controlnet'):
                pipe.controlnet.to(torch.float16)
            # IP-Adapter image encoder, if present, also to fp16.
            if getattr(pipe, 'image_encoder', None) is not None:
                pipe.image_encoder.to(torch.float16)
        except Exception as _e:
            log(f"controlnet_geo fp16 cast skipped: {_e}")
        if _ip_loaded:
            # Full pipe (~13.6 GB) won't fit 16 GB -> cpu-offload. Only sensible on
            # a bigger card / Modal (the CPU<->GPU swap thrashes on tight RAM).
            try:
                pipe.enable_model_cpu_offload()
            except Exception as _oe:
                log(f"geo enable_model_cpu_offload failed ({_oe}); pipe.to(cuda)", 'warn')
                pipe.to("cuda")
        else:
            # Controlnet-only pipe (~9.5 GB) fits VRAM directly -> no swap, fast.
            pipe.to("cuda")
        pipe.enable_vae_tiling()
        if os.environ.get('FABMESH_UNRESTRICTED') == '1':
            if hasattr(pipe, 'safety_checker'):
                pipe.safety_checker = None
        state.controlnet_geo_pipe = pipe
        state.last_use['controlnet_geo'] = time.time()
        log(f"controlnet_geo loaded in {time.time()-t0:.1f}s "
            f"({vram_used_gb():.1f} GB VRAM)")
    return state.controlnet_geo_pipe


def unload_model(name):
    """Free a model from VRAM. name in ('img2img', 'inpaint', 'controlnet_tile', 'controlnet_geo', 'clipseg')."""
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
        elif name == 'controlnet_geo' and state.controlnet_geo_pipe is not None:
            del state.controlnet_geo_pipe
            state.controlnet_geo_pipe = None
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


# Default tile-refine negative prompt. ControlNet-Tile LOVES to hallucinate
# text/runes/glyphs onto ambiguous organic texture (it invented runes on a
# wizard's beard at strength 0.5). This hard-suppresses that failure mode on
# every tile call. Callers can override via the `negative_prompt` arg.
DEFAULT_TILE_NEG = ("text, letters, words, writing, runes, glyphs, symbols, "
                    "sigil, tattoo, calligraphy, inscription, hieroglyphs, "
                    "ornamental pattern, watermark, logo, signature, "
                    "deformed, blurry, lowres, worst quality, artifacts")


def do_img2img_tile(input_path, prompt, output_path, strength=0.55,
                     controlnet_scale=0.7, guidance_scale=6.0, steps=None,
                     seed=42, negative_prompt=None, control_guidance_end=1.0):
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
                    # None by default -> identical to the ORIGINAL tile behaviour
                    # (don't change the existing "Sharpen/Refine texture" tool).
                    # The anti-rune negative lives ONLY on the new geo path.
                    negative_prompt=negative_prompt,
                    image=img,
                    control_image=img,  # same tile image drives the ControlNet
                    strength=s,
                    num_inference_steps=steps,
                    guidance_scale=guidance_scale,
                    controlnet_conditioning_scale=cns,
                    # Stop the tile ControlNet before the LATE denoise steps: it
                    # guides early structure but no longer drives late-step
                    # micro-invention (the runes/glyphs failure). The late steps
                    # become plain img2img anchored to the init by `strength`.
                    control_guidance_end=float(control_guidance_end),
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


def do_refine_geo(input_path, control_path, ref_path, prompt, output_path,
                  strength=0.5, controlnet_scale=0.8, ip_scale=0.6,
                  guidance_scale=6.0, steps=None, seed=42,
                  negative_prompt=None, control_guidance_end=1.0):
    """
    GEOMETRY-GUIDED + reference-anchored refine (the Meshy-style path).

    Conditions SDXL on the mesh's REAL surface geometry via a ControlNet-Union
    in NORMAL mode (control_mode=4) — so added micro-detail follows actual
    surface normals and CAN'T free-associate runes/glyphs onto ambiguous organic
    texture (the ControlNet-Tile failure). An IP-Adapter on `ref_path` keeps the
    output faithful to the source reference image.

    Args mirror do_img2img_tile where they overlap:
      input_path        — the rendered view (img2img init image)
      control_path      — the geometry control map (world-space NORMAL PNG,
                          or a depth PNG if you wired a depth fallback). Required.
      ref_path          — the source reference image for the IP-Adapter. If
                          missing/None, the IP-Adapter image is skipped and the
                          pipe runs controlnet-only.
      strength          — img2img denoise strength (0.4-0.6 for a refine pass)
      controlnet_scale  — normal ControlNet conditioning scale (0.6-0.9)
      ip_scale          — IP-Adapter scale (0.0 = ignore ref, 1.0 = strong)
      guidance_scale    — CFG (5-7 typical for RealVisXL)
      control_guidance_end — fraction of steps the controlnet stays active
                          (default 1.0: geometry guides the WHOLE denoise, unlike
                          tile which we stop early to curb late invention)
    """
    if not os.path.exists(input_path):
        return {"ok": False, "error": f"Input not found: {input_path}"}
    if not control_path or not os.path.exists(control_path):
        return {"ok": False, "error": f"Control map not found: {control_path}"}

    # Single SDXL pipe at a time to stay under 16 GB VRAM. The geo pipe is the
    # heaviest (~10-11 GB with the IP-Adapter image encoder), so evict the others.
    if state.img2img_pipe is not None:
        unload_model('img2img')
    if state.inpaint_pipe is not None:
        unload_model('inpaint')
    if state.controlnet_tile_pipe is not None:
        unload_model('controlnet_tile')

    pipe = load_controlnet_geo()
    state.last_use['controlnet_geo'] = time.time()

    with state.inference_lock:
        try:
            img = Image.open(input_path).convert("RGB")
            img, (w, h) = resize_for_sdxl(img, max_dim=1024)

            # Geometry control map -> SAME work size as the init so the union
            # controlnet's spatial conditioning lines up pixel-for-pixel.
            geo = Image.open(control_path).convert("RGB")
            if geo.size != (w, h):
                geo = geo.resize((w, h), Image.LANCZOS)

            # Reference image for the IP-Adapter (optional).
            ref_img = None
            use_ip = bool(ref_path) and os.path.exists(ref_path)
            if use_ip:
                try:
                    ref_img = Image.open(ref_path).convert("RGB")
                except Exception as _re:
                    log(f"refine_geo: ref image unreadable ({_re}); "
                        f"skipping IP-Adapter", 'warn')
                    use_ip = False
            # set_ip_adapter_scale only matters if the adapter actually loaded.
            ip_loaded = bool(getattr(pipe, 'image_encoder', None) is not None)
            if ip_loaded:
                try:
                    # 0 effectively disables the adapter for this call when we
                    # have no usable reference image.
                    pipe.set_ip_adapter_scale(
                        float(ip_scale) if use_ip else 0.0)
                except Exception as _se:
                    log(f"refine_geo: set_ip_adapter_scale failed ({_se})", 'warn')

            enhanced = f"{prompt}, high quality, detailed"
            s = max(0.1, min(1.0, float(strength)))
            if steps is None:
                steps = max(int(round(25 / s)), int(round(1 / s)) + 1)
                steps = min(steps, 60)
            cns = max(0.0, min(1.5, float(controlnet_scale)))
            gen = None
            if seed is not None and torch.cuda.is_available():
                gen = torch.Generator('cuda').manual_seed(int(seed))

            # Build kwargs so we can conditionally drop ip_adapter_image when we
            # have no reference (passing None is fine too, but be explicit).
            call_kwargs = dict(
                prompt=enhanced,
                negative_prompt=(negative_prompt or DEFAULT_TILE_NEG),
                image=img,
                control_image=geo,             # union auto-wraps to [geo]
                control_mode=CONTROLNET_UNION_NORMAL_MODE,  # 4 = normal
                strength=s,
                num_inference_steps=steps,
                guidance_scale=guidance_scale,
                controlnet_conditioning_scale=cns,
                control_guidance_end=float(control_guidance_end),
                generator=gen,
            )
            if use_ip and ip_loaded and ref_img is not None:
                call_kwargs['ip_adapter_image'] = ref_img

            t0 = time.time()
            with torch.inference_mode():
                result = pipe(**call_kwargs).images[0]

            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            result.save(output_path)
            elapsed = time.time() - t0
            log(f"refine_geo done in {elapsed:.1f}s "
                f"(s={s:.2f}, cns={cns:.2f}, ip={'%.2f' % ip_scale if (use_ip and ip_loaded) else 'off'}, "
                f"{steps} steps, {w}x{h}) -> {output_path}")
            return {"ok": True, "output": output_path, "time": elapsed,
                    "size": [w, h], "strength": s, "controlnet_scale": cns,
                    "ip_scale": (float(ip_scale) if (use_ip and ip_loaded) else 0.0)}
        except Exception as e:
            log(f"refine_geo error: {e}", 'err')
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
    thr = max(50.0, float(arr.max()) * float(rel))  # floor 50 (was 60): catch weaker parts like building windows
    mask_binary = Image.fromarray((arr > thr).astype(np.uint8) * 255, mode="L")
    d = max(0, int(dilate))
    if d > 0:
        mask_binary = mask_binary.filter(ImageFilter.MaxFilter(d * 2 + 1))
    return mask_binary.filter(ImageFilter.GaussianBlur(3))


def do_recolor(input_path, prompt, output_path, strength=1.0, dilate=15, rel=0.5, recolor_all=False):
    """Auto-recolour: detect the named part (CLIPSeg) and recolour ONLY it via a
    luminance-preserving HSV shift (shape/folds intact). Falls back to
    ControlNet-Tile when the prompt names a material rather than a colour.
    recolor_all=True skips CLIPSeg and recolours the WHOLE image (full mask)."""
    if not os.path.exists(input_path):
        return {"ok": False, "error": f"Input not found: {input_path}"}
    if not prompt or not prompt.strip():
        return {"ok": False, "error": "prompt required (e.g. 'cape rouge')"}
    noun, color_spec = parse_recolor_prompt(prompt)
    if color_spec is None:
        # No colour word → a material/style prompt ('rusty metal', 'sunset
        # gradient') → ControlNet-Tile AI render (whole image if recolor_all).
        return do_recolor_tile(input_path, noun, prompt, output_path, dilate, rel,
                               recolor_all=recolor_all, strength=strength)
    load_clipseg()
    with state.inference_lock:
        try:
            img = Image.open(input_path).convert("RGB")
            orig_size = img.size
            img_work, (work_w, work_h) = resize_for_sdxl(img, max_dim=1024)
            t0 = time.time()
            if recolor_all:
                # Whole-image recolour: no CLIPSeg detection, mask = every pixel.
                mask_soft = Image.new("L", (work_w, work_h), 255)
                coverage = 100.0
            else:
                # CLIPSeg is weak on small / repeated parts (e.g. building "windows").
                # Try a few phrasings and keep the strongest mask before giving up.
                _base = noun.strip()
                _nl = _base.lower()
                _variants = [_base]
                if _nl.endswith('s') and len(_nl) > 3:
                    _variants.append(_base[:-1])          # windows -> window
                else:
                    _variants.append(_base + 's')         # window  -> windows
                _variants += ['the ' + _base, _base + ' area']
                mask_soft, coverage, _seen = None, 0.0, set()
                for _vt in _variants:
                    if not _vt or _vt in _seen:
                        continue
                    _seen.add(_vt)
                    _m = _clipseg_mask(img_work, work_w, work_h, _vt, dilate, rel)
                    _c = (np.array(_m) > 128).mean() * 100
                    if _c > coverage:
                        mask_soft, coverage = _m, _c
                    if coverage >= 2.0:  # good enough — stop early
                        break
                if coverage < 0.2:
                    return {"ok": False, "error": f"'{noun}' not found. CLIPSeg couldn't segment it — try a broader/simpler word (e.g. the whole facade, roof, walls), or lower Detection precision."}
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


def do_recolor_tile(input_path, noun, full_prompt, output_path, dilate=15, rel=0.5, recolor_all=False, strength=1.0):
    """ControlNet-Tile fallback for material/non-colour requests ('metal rouille',
    'cuir vieilli', or a whole-image style like 'sunset gradient'): low-denoise
    structure-preserving re-paint, composited through the CLIPSeg mask so only
    the detected region changes. recolor_all=True → whole image (full mask); the
    Strength slider (strength) then drives how strongly the style is applied."""
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
            if recolor_all:
                mask_soft = Image.new("L", (work_w, work_h), 255)  # whole image
                coverage = 100.0
            else:
                mask_soft = _clipseg_mask(img_work, work_w, work_h, noun or full_prompt, dilate, rel)
                coverage = (np.array(mask_soft) > 128).mean() * 100
                if coverage < 0.2:
                    return {"ok": False, "error": f"'{noun}' not detected (coverage {coverage:.1f}%)"}
            # Whole-image restyle needs real denoise or the style barely shows
            # (0.35 kept a "military green camo" building silver). Drive it from
            # the Strength slider: 20%→0.44, 100%→0.76. ControlNet still holds the
            # shape (lower cond so colours can actually change). Part material
            # recolor stays conservative (0.18) to preserve the detected region.
            _s = max(0.2, min(1.0, float(strength)))
            _denoise = (0.4 + _s * 0.36) if recolor_all else 0.18
            _cn = 0.5 if recolor_all else 0.65
            _prompt = (f"{full_prompt}, entire subject recoloured, keep the exact shape and structure, photorealistic"
                       if recolor_all else
                       f"{full_prompt}, same shape, preserve folds and details, photorealistic")
            with torch.inference_mode():
                result = pipe(
                    prompt=_prompt,
                    negative_prompt="deformed, distorted, blurry, low quality, changed shape, extra parts",
                    image=img_work,
                    control_image=img_work,
                    strength=_denoise,
                    num_inference_steps=(28 if recolor_all else 20),
                    guidance_scale=(6.5 if recolor_all else 5.5),
                    controlnet_conditioning_scale=_cn,
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


def do_tex_variant(input_path, prompt, output_path, strength=0.45, seed=0, cn_scale=0.45, neg_prompt=None):
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
                    negative_prompt=neg_prompt or "deformed, distorted, changed shape, different pose, extra parts, missing parts, blurry, low quality",
                    image=img_work,
                    control_image=img_work,
                    strength=float(max(0.35, min(0.9, strength))),
                    num_inference_steps=28,
                    guidance_scale=7.5,
                    # Variable conditioning: HIGH (variant / mild age: hold the
                    # silhouette) -> LOW (strong age: let PROPORTIONS shift, e.g. an
                    # adult lion -> a cub with a bigger head / shorter limbs). 0.45 default.
                    controlnet_conditioning_scale=float(max(0.1, min(0.95, cn_scale))),
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


def do_segment(input_path, target_text, output_path, dilate=15, rel=0.5, binary=False):
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
            # Same multi-phrasing detection as do_recolor so the PREVIEW overlay
            # matches exactly what Recolor/Auto-Inpaint will act on (CLIPSeg is
            # weak on small/repeated parts like building windows). Floor 50.
            def _seg_binary(_txt):
                _in = state.clipseg_processor(
                    text=[_txt], images=[img_work], padding=True, return_tensors="pt")
                _in = {k: v.to(_dev) for k, v in _in.items()}
                with torch.inference_mode():
                    _out = state.clipseg_model(**_in)
                _lg = _out.logits.squeeze().detach().cpu().numpy()
                _pb = 1 / (1 + np.exp(-_lg))  # sigmoid
                _u8 = (_pb * 255).astype(np.uint8)
                _mi = Image.fromarray(_u8).resize((work_w, work_h), Image.LANCZOS)
                _a = np.array(_mi).astype(np.float32)
                return (_a > max(50.0, float(_a.max()) * float(rel))).astype(np.uint8) * 255
            _base = target_text.strip()
            _nl = _base.lower()
            _variants = [_base]
            if _nl.endswith('s') and len(_nl) > 3:
                _variants.append(_base[:-1])          # windows -> window
            else:
                _variants.append(_base + 's')         # window  -> windows
            _variants += ['the ' + _base, _base + ' area']
            # NB: use mask_arr (NOT `binary`) — `binary` is the bool PARAM that
            # selects B/W-mask vs red-overlay output below. Reassigning it to a
            # numpy array (the old bug) made `if binary:` raise "ambiguous truth
            # value", so the preview overlay silently failed and never showed.
            mask_arr, _bestcov, _seen = None, -1.0, set()
            for _vt in _variants:
                if not _vt or _vt in _seen:
                    continue
                _seen.add(_vt)
                _b = _seg_binary(_vt)
                _c = float((_b > 128).mean())
                if _c > _bestcov:
                    mask_arr, _bestcov = _b, _c
                if _bestcov * 100 >= 2.0:  # good enough — stop early
                    break
            mask_binary = Image.fromarray(mask_arr, mode="L")
            d = max(0, int(dilate))
            if d > 0:
                mask_binary = mask_binary.filter(ImageFilter.MaxFilter(d * 2 + 1))
            if binary:
                # AI region re-texture wants a WHITE/BLACK mask (projected onto the UV),
                # not the red preview overlay.
                mb = mask_binary if (work_w, work_h) == img.size else mask_binary.resize(img.size, Image.NEAREST)
                _cov = float((np.array(mask_binary) > 128).mean() * 100)
                os.makedirs(os.path.dirname(output_path), exist_ok=True)
                mb.convert("RGB").save(output_path)
                return {"ok": True, "output": output_path, "coverage": round(_cov, 1)}
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
                    "controlnet_geo": state.controlnet_geo_pipe is not None,
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
                    "controlnet_geo": state.controlnet_geo_pipe is not None,
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

            elif self.path == '/refine_geo':
                # Geometry-guided + reference-anchored refine. `control` (the
                # normal/depth map) is REQUIRED; `ref` is optional (skips the
                # IP-Adapter image when absent).
                if 'input' not in data or 'output' not in data or 'control' not in data:
                    self._json_response(400, {"ok": False, "error": "missing input/output/control"})
                    return
                result = do_refine_geo(
                    data['input'],
                    data['control'],
                    data.get('ref'),
                    data.get('prompt', ''),
                    data['output'],
                    data.get('strength', 0.5),
                    data.get('controlnet_scale', 0.8),
                    data.get('ip_scale', 0.6),
                    data.get('guidance_scale', 6.0),
                    data.get('steps', None),
                    data.get('seed', 42),
                    data.get('negative_prompt'),
                    data.get('control_guidance_end', 1.0),
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
                    data.get('binary', False),
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
                    recolor_all=bool(data.get('recolor_all', False)),
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
                    data.get('cn_scale', 0.45),
                    data.get('neg_prompt'),
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
                if model_name in ('img2img', 'inpaint', 'controlnet_tile', 'controlnet_geo', 'clipseg'):
                    unload_model(model_name)
                    self._json_response(200, {"ok": True, "vram_gb": round(vram_used_gb(), 2)})
                else:
                    self._json_response(400, {"ok": False, "error": "model must be img2img/inpaint/controlnet_tile/controlnet_geo/clipseg"})

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
