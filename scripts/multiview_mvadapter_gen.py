"""
FabMesh multi-view generator — MV-Adapter (i2mv-sdxl).

Plug-and-play SDXL adapter that produces multi-view consistent
images from a single reference. Reuses our RealVisXL V4.0 base —
only the ~740 MB adapter + DINOv2 encoder are new downloads.

Unlike CRM (256px, Objaverse-biased) and Zero123++ (elevation ±20°
only), MV-Adapter can be asked for arbitrary (azimuth, elevation)
pairs at 768px. We request the same 6 canonical views as CRM so
the rest of the pipeline (texture_project, SF3D feed) is unchanged.

License: Apache 2.0 (code + weights).
Repo: github.com/huanngzh/MV-Adapter
Paper: arxiv.org/abs/2412.03632

CLI (identical contract to multiview_crm_gen.py):
    python scripts/multiview_mvadapter_gen.py <input_image> <output_dir>
Outputs:
    <output_dir>/input.png
    <output_dir>/view_0.png .. view_5.png
    <output_dir>/views.json
"""
from __future__ import annotations
import os
import sys
import json
import time
import argparse

# Make MV-Adapter importable
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MVA_ROOT = os.path.join(ROOT, 'external', 'MV-Adapter')
sys.path.insert(0, MVA_ROOT)


def _patch_mvadapter_nvdiffrast():
    """Monkey-patch MV-Adapter's mesh_utils package so importing `camera`
    (the only thing we use) doesn't pull in `mesh.py`, `render.py`, etc.,
    all of which hard-import nvdiffrast (not installed — FabMesh doesn't
    need it, we only use camera helpers for the i2mv pipeline).

    Done in-place at runtime so the submodule stays pristine and the
    patch is versioned with FabMesh.
    """
    import importlib, types

    # Preload stub modules so the transitive imports in mesh_utils don't
    # crash. None of these paths are actually exercised by our code
    # (we only use camera helpers + pipeline forward) — the stubs just
    # satisfy top-level `import X` statements in unused modules.
    _stubs = {
        'nvdiffrast': None,
        'nvdiffrast.torch': 'nvdiffrast',
        'triton': None,
        'triton.language': 'triton',
        'cvcuda': None,
        'cvcuda_cu12': None,
        'open3d': None,
        'pymeshlab': None,
        'spandrel': None,
    }
    from importlib.machinery import ModuleSpec
    for name, parent in _stubs.items():
        if name in sys.modules:
            continue
        mod = types.ModuleType(name)
        mod.__spec__ = ModuleSpec(name, loader=None)
        mod.__path__ = []  # pretend package so sub-module stubs work
        sys.modules[name] = mod
        if parent is not None and parent in sys.modules:
            setattr(sys.modules[parent], name.split('.')[-1], mod)


_patch_mvadapter_nvdiffrast()

# Patch MV-Adapter for accelerate cpu_offload compatibility (idempotent).
try:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import patch_mvadapter as _patch_mva
    _patch_mva.patch()
except Exception as _e:
    print(f'[multiview_mvadapter] WARN: patch_mvadapter failed: {_e}',
          flush=True)

# FabMesh logger
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from fabmesh_log import Logger
except Exception:
    class Logger:
        def __init__(self, *a, **kw): pass
        def info(self, *a, **kw): pass
        def progress(self, *a, **kw): pass


def log(msg):
    print(f'[multiview_mvadapter] {msg}', flush=True)


def _subpct(pct, label=''):
    pct = int(pct)
    print(f'FABMESH_SUBPCT: {pct} {label}', flush=True)
    print(f'MULTIVIEW_PROGRESS: {pct} {label}', flush=True)


# Our canonical 6-slot schema — same as CRM so downstream (texture_project,
# SF3D feed) doesn't need changes. Each tuple is (azim_deg, elev_deg).
# Azim: 0 = front, 90 = right, 180 = back, 270 = left.
# Elev: +90 = TOP, -90 = BOTTOM.
VIEW_SLOTS = [
    (  0.0,   0.0),   # view_0 front
    ( 90.0,   0.0),   # view_1 right
    (180.0,   0.0),   # view_2 back
    (270.0,   0.0),   # view_3 left
    (  0.0,  90.0),   # view_4 TOP
    (  0.0, -90.0),   # view_5 BOTTOM
]


def generate(input_image_path, output_dir, num_steps=50,
             guidance_scale=4.5, size=768, seed=1234):
    """Run MV-Adapter i2mv-sdxl and produce 6 views + input.png + views.json."""
    import numpy as np
    import torch
    from PIL import Image
    import rembg

    from diffusers import AutoencoderKL, DDPMScheduler, UNet2DConditionModel  # noqa
    from mvadapter.pipelines.pipeline_mvadapter_i2mv_sdxl import (
        MVAdapterI2MVSDXLPipeline)
    from mvadapter.schedulers.scheduling_shift_snr import ShiftSNRScheduler
    from mvadapter.utils.mesh_utils import get_orthogonal_camera
    from mvadapter.utils.geometry import get_plucker_embeds_from_cameras_ortho

    os.makedirs(output_dir, exist_ok=True)
    slog = Logger('multiview', output_dir=output_dir,
                  engine='mvadapter', input=input_image_path)
    t0 = time.time()

    # Preprocess: rembg → square → white BG (MV-Adapter's preprocess_image
    # in inference_i2mv_sdxl.py expects RGBA with white-ish background).
    _subpct(3, 'preprocess')
    log('preprocessing (rembg + square)...')
    img = Image.open(input_image_path).convert('RGBA')
    if img.getextrema()[3][0] == 255:
        rembg_session = rembg.new_session()
        img = rembg.remove(img, session=rembg_session)

    w, h = img.size
    if w != h:
        s = max(w, h)
        sq = Image.new('RGBA', (s, s), (0, 0, 0, 0))
        sq.paste(img, ((s - w) // 2, (s - h) // 2))
        img = sq
    img = img.resize((size, size), Image.LANCZOS)
    # Save input.png (preserve alpha — downstream texture_project needs it)
    img.save(os.path.join(output_dir, 'input.png'))

    # Composite onto mid-grey background — MV-Adapter's _preprocess expects
    # RGB with alpha pre-multiplied against grey = 0.5.
    _subpct(7, 'preprocess_done')
    arr = np.asarray(img).astype(np.float32) / 255.0
    alpha = arr[..., 3:4]
    rgb = arr[..., :3] * alpha + (1 - alpha) * 0.5
    ref_rgb = Image.fromarray((rgb * 255).clip(0, 255).astype(np.uint8))

    _subpct(10, 'load_pipeline')
    # MV-Adapter was trained against vanilla SDXL base-1.0's UNet layer
    # layout. RealVisXL fuses / renames some processors, which causes
    # KeyError on 'down_blocks.1.attentions.0.transformer_blocks.0.attn1.processor'.
    # Env override: set FABMESH_MVA_BASE=SG161222/RealVisXL_V4.0 to try
    # a different base (risky — expect layer-name mismatches).
    base_model = os.environ.get(
        'FABMESH_MVA_BASE', 'stabilityai/stable-diffusion-xl-base-1.0')
    vae_model = 'madebyollin/sdxl-vae-fp16-fix'
    adapter_path = 'huanngzh/mv-adapter'
    log(f'loading base={base_model} + MV-Adapter (SDXL)...')
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    dtype = torch.float16 if device == 'cuda' else torch.float32

    vae = AutoencoderKL.from_pretrained(vae_model, torch_dtype=dtype)
    pipe = MVAdapterI2MVSDXLPipeline.from_pretrained(
        base_model, vae=vae, torch_dtype=dtype)

    # Scheduler shift (paper default for i2mv-sdxl)
    pipe.scheduler = ShiftSNRScheduler.from_scheduler(
        pipe.scheduler, shift_mode='interpolated', shift_scale=8.0,
        scheduler_class=None)

    pipe.init_custom_adapter(num_views=len(VIEW_SLOTS))
    pipe.load_custom_adapter(
        adapter_path, weight_name='mvadapter_i2mv_sdxl.safetensors')

    pipe.to(device=device, dtype=dtype)
    pipe.cond_encoder.to(device=device, dtype=dtype)
    pipe.enable_vae_slicing()
    # CPU offload: ON by default. 6-view batched SDXL at 768² overflows
    # 16 GB VRAM, causing ~100s/step instead of 2-3s (GPU<->RAM
    # thrashing). Offload accepts the overhead of swapping models
    # per-block and keeps inference realistic.
    # Set FABMESH_MVA_CPU_OFFLOAD=0 to disable (needs >20 GB VRAM).
    if os.environ.get('FABMESH_MVA_CPU_OFFLOAD', '1') == '1':
        try:
            pipe.enable_model_cpu_offload()
            log('model CPU offload enabled')
        except Exception as oe:
            log(f'cpu offload unavailable ({oe})')

    log(f'pipeline loaded in {time.time()-t0:.1f}s '
        f'(VRAM: {torch.cuda.memory_allocated()/1024**3:.1f} GB)'
        if torch.cuda.is_available() else 'pipeline loaded (CPU)')
    _subpct(30, 'pipeline_ready')

    # Build cameras matching our 6 slots
    azimuth_deg = [az for az, _ in VIEW_SLOTS]
    elevation_deg = [el for _, el in VIEW_SLOTS]
    # MV-Adapter expects azim offset -90 (camera looks along -Y when az=0 of input)
    cameras = get_orthogonal_camera(
        elevation_deg=elevation_deg,
        distance=[1.8] * len(VIEW_SLOTS),
        left=-0.55, right=0.55, bottom=-0.55, top=0.55,
        azimuth_deg=[x - 90 for x in azimuth_deg],
        device=device,
    )
    plucker_embeds = get_plucker_embeds_from_cameras_ortho(
        cameras.c2w, [1.1] * len(VIEW_SLOTS), size)
    control_images = ((plucker_embeds + 1.0) / 2.0).clamp(0, 1)

    log(f'generating {len(VIEW_SLOTS)} views (steps={num_steps}, '
        f'cfg={guidance_scale}, seed={seed})...')
    _subpct(35, 'inference_start')

    generator = torch.Generator(device=device).manual_seed(int(seed)) \
        if seed is not None and int(seed) >= 0 else None

    pipe_kwargs = {}
    if generator is not None:
        pipe_kwargs['generator'] = generator

    prompt = os.environ.get('FABMESH_MVA_PROMPT', 'high quality')
    neg = ("watermark, ugly, deformed, noisy, blurry, low contrast, "
           "distorted anatomy, extra limbs, text, signature")
    if ref_prompt := os.environ.get('FABMESH_MVA_SUBJECT_PROMPT'):
        prompt = f"{ref_prompt}, {prompt}"

    images = pipe(
        prompt,
        height=size, width=size,
        num_inference_steps=num_steps,
        guidance_scale=guidance_scale,
        num_images_per_prompt=len(VIEW_SLOTS),
        control_image=control_images,
        control_conditioning_scale=1.0,
        reference_image=ref_rgb,
        reference_conditioning_scale=1.3,
        negative_prompt=neg,
        cross_attention_kwargs={'scale': 1.0},
        **pipe_kwargs,
    ).images

    log(f'inference done in {time.time()-t0:.1f}s')
    _subpct(85, 'save_views')

    # Drop grey background → alpha. MV-Adapter outputs RGB at ~(128,128,128).
    views_meta = []
    for slot_idx, (az, el) in enumerate(VIEW_SLOTS):
        v = images[slot_idx].convert('RGB')
        if v.size != (size, size):
            v = v.resize((size, size), Image.LANCZOS)
        arr = np.asarray(v)
        # Grey-bg removal: pixels within 25 of (128,128,128) -> alpha=0
        dist = np.linalg.norm(arr.astype(float) - np.array([128, 128, 128]), axis=2)
        alpha = (dist > 25).astype(np.uint8) * 255
        rgba = np.dstack([arr, alpha])
        Image.fromarray(rgba, 'RGBA').save(
            os.path.join(output_dir, f'view_{slot_idx}.png'))
        views_meta.append({'azim': az, 'elev': el})
        log(f'  view_{slot_idx}: az={az:6.1f}° el={el:5.1f}°')

    with open(os.path.join(output_dir, 'views.json'), 'w', encoding='utf-8') as f:
        json.dump({'engine': 'mvadapter', 'views': views_meta}, f, indent=2)

    del pipe
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    # Optional post-gen: upscale 768 -> 1024 via Real-ESRGAN. MV-Adapter
    # native resolution is 768, but the source photo is usually 1024 so
    # the 6 views look softer in the viewer. ESRGAN x4 + downsample to
    # 1024 closes the gap at low cost (~10s for 6 tiles).
    if os.environ.get('FABMESH_MV_UPSCALE') == '1':
        try:
            _subpct(92, 'esrgan_upscale')
            log('upscaling 6 views 768->1024 via Real-ESRGAN...')
            from realesrgan import RealESRGANer
            from basicsr.archs.rrdbnet_arch import RRDBNet
            model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64,
                            num_block=23, num_grow_ch=32, scale=4)
            up = RealESRGANer(
                scale=4, model_path=(
                    'https://github.com/xinntao/Real-ESRGAN/releases/'
                    'download/v0.1.0/RealESRGAN_x4plus.pth'),
                model=model, tile=0, tile_pad=10, pre_pad=0, half=True)
            t_up = time.time()
            for slot_idx in range(len(VIEW_SLOTS)):
                vp = os.path.join(output_dir, f'view_{slot_idx}.png')
                im = Image.open(vp).convert('RGBA')
                arr = np.asarray(im)
                rgb_up, _ = up.enhance(arr[:, :, :3], outscale=4)
                # Downsample 3072 -> 1024 for memory + viewer parity.
                rgb_out = np.asarray(
                    Image.fromarray(rgb_up).resize((1024, 1024), Image.LANCZOS))
                alpha_up = np.asarray(
                    Image.fromarray(arr[:, :, 3]).resize((1024, 1024),
                                                         Image.LANCZOS))
                Image.fromarray(np.dstack([rgb_out, alpha_up]), 'RGBA') \
                    .save(vp)
            log(f'  ESRGAN upscale done in {time.time()-t_up:.1f}s')
            del up
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception as e:
            log(f'  ESRGAN upscale failed: {e} — keeping 768px views')

    elapsed = time.time() - t0
    slog.info('pipeline_done', total_ms=int(elapsed * 1000),
              engine='mvadapter', views=len(VIEW_SLOTS))
    log(f'done in {elapsed:.1f}s')
    _subpct(100, 'finish')
    return True


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('input_image')
    ap.add_argument('output_dir')
    ap.add_argument('--size', type=int, default=768,
                    help='Output resolution per view (MV-Adapter SDXL native: 768)')
    ap.add_argument('--steps', type=int, default=50)
    ap.add_argument('--guidance', type=float, default=4.5)
    ap.add_argument('--seed', type=int, default=1234)
    args = ap.parse_args()

    try:
        ok = generate(args.input_image, args.output_dir,
                      num_steps=args.steps, guidance_scale=args.guidance,
                      size=args.size, seed=args.seed)
        sys.exit(0 if ok else 1)
    except Exception as e:
        log(f'ERROR: {type(e).__name__}: {e}')
        import traceback
        traceback.print_exc()
        sys.exit(2)
