"""FabMesh — sheet runner v2 with dual ControlNet (Depth + Canny).

Improvements over scripts/sheet_render_depth.py:
  - Render mesh depth AND canny at 1024² then downscale → sharper structure
  - Dual ControlNet: Depth (0.7 weight) + Canny (0.5 weight) for strong
    silhouette enforcement, especially on sides/back where Hi3DGen depth
    alone is too noisy to constrain the diffuser
  - No alpha-mask on split (the Hi3DGen silhouette holes were fragmenting
    the SDXL-painted car). The bake's own inv-UV mask handles real masking.
  - Optional per-cell angle text label in prompt via "view_label" hints.

Usage:
    python sheet_render_v2.py <mesh.glb> <source_photo> <out_dir>
        [--steps 30] [--guidance 7.0] [--seed 42]
        [--depth-scale 0.7] [--canny-scale 0.5] [--ip-scale 0.55]
"""
from __future__ import annotations
import os
import sys
import json
import time
import argparse
import subprocess
import numpy as np
from PIL import Image, ImageFilter
import torch

SCRIPTS = os.path.dirname(os.path.abspath(__file__))


CELL = 512
COLS = 3
ROWS = 2
SHEET_W = COLS * CELL
SHEET_H = ROWS * CELL

CELL_LAYOUT = [
    (0, 0,   0.0,    0.00, 'front'),
    (1, 0,  90.0,    0.00, 'right'),
    (2, 0, 180.0,    0.00, 'back'),
    (0, 1, 270.0,    0.00, 'left'),
    (1, 1,   0.0,   89.99, 'top'),
    (2, 1,   0.0,  -89.99, 'bottom'),
]


def log(msg):
    print(f'[sheet_v2] {msg}', flush=True)


def _ensure_renders(mesh_path, out_dir, hires=1024):
    """Render mesh at hires resolution; we then downscale to CELL for sheet."""
    needed = [os.path.join(out_dir, f'depth_{i}.png') for i in range(6)] + \
             [os.path.join(out_dir, f'view_{i}.png') for i in range(6)]
    if all(os.path.isfile(p) for p in needed):
        log(f'mesh renders already present in {out_dir}')
        return
    log(f'rendering mesh at {hires}px via mv_render_from_mesh.py...')
    r = subprocess.run(
        [sys.executable,
         os.path.join(SCRIPTS, 'mv_render_from_mesh.py'),
         mesh_path, out_dir, '--res', str(hires)],
        check=False)
    if r.returncode != 0:
        raise RuntimeError(f'mesh render failed: rc={r.returncode}')


def _canny_from_depth(depth_pil, low=50, high=150):
    """Build a canny edge map from a depth image."""
    import cv2
    arr = np.asarray(depth_pil.convert('L'))
    # Strong Gaussian blur to suppress micro-noise from mesh decimation.
    arr = cv2.GaussianBlur(arr, (5, 5), 0)
    edges = cv2.Canny(arr, low, high)
    return Image.fromarray(edges).convert('RGB')


def _compose_sheet(out_dir, mode):
    """Compose a 1536×1024 sheet of either depth or canny images.
    mode='depth' uses depth_*.png; mode='canny' derives from depth_*.png."""
    sheet = Image.new('RGB', (SHEET_W, SHEET_H), (0, 0, 0))
    for col, row, _, _, _ in CELL_LAYOUT:
        idx = next(i for i, (c, r, *_) in enumerate(CELL_LAYOUT)
                   if (c, r) == (col, row))
        depth_pil = Image.open(os.path.join(out_dir, f'depth_{idx}.png'))
        depth_pil = depth_pil.convert('L').resize((CELL, CELL), Image.LANCZOS)
        if mode == 'depth':
            cell = Image.merge('RGB', (depth_pil, depth_pil, depth_pil))
        elif mode == 'canny':
            cell = _canny_from_depth(depth_pil)
        else:
            raise ValueError(mode)
        sheet.paste(cell, (col * CELL, row * CELL))
    return sheet


def load_pipeline():
    from diffusers import (
        ControlNetModel,
        StableDiffusionXLControlNetPipeline,
    )
    from transformers import CLIPVisionModelWithProjection
    log('loading RealVisXL + DUAL ControlNet (Depth + Canny) + IPAdapter...')
    image_encoder = CLIPVisionModelWithProjection.from_pretrained(
        'h94/IP-Adapter', subfolder='models/image_encoder',
        torch_dtype=torch.float16)
    cn_depth = ControlNetModel.from_pretrained(
        'diffusers/controlnet-depth-sdxl-1.0', torch_dtype=torch.float16)
    cn_canny = ControlNetModel.from_pretrained(
        'diffusers/controlnet-canny-sdxl-1.0', torch_dtype=torch.float16)
    pipe = StableDiffusionXLControlNetPipeline.from_pretrained(
        'SG161222/RealVisXL_V4.0',
        controlnet=[cn_depth, cn_canny],
        torch_dtype=torch.float16, variant='fp16',
        use_safetensors=True,
        image_encoder=image_encoder)
    pipe.unet.to(torch.float16)
    pipe.vae.to(torch.float16)
    pipe.text_encoder.to(torch.float16)
    pipe.text_encoder_2.to(torch.float16)
    pipe.load_ip_adapter(
        'h94/IP-Adapter', subfolder='sdxl_models',
        weight_name='ip-adapter-plus_sdxl_vit-h.safetensors')
    pipe.enable_model_cpu_offload()
    log('pipeline ready')
    return pipe


def split_sheet_to_views(sheet_img, out_dir):
    """Crop the sheet into 6 1024² views. No alpha masking — bake's own
    inv-UV rasterisation handles real masking."""
    out_size = 1024
    for col, row, az, el, label in CELL_LAYOUT:
        idx = next(i for i, (c, r, *_) in enumerate(CELL_LAYOUT)
                   if (c, r) == (col, row))
        crop = sheet_img.crop((col * CELL, row * CELL,
                                (col + 1) * CELL, (row + 1) * CELL))
        crop = crop.resize((out_size, out_size), Image.LANCZOS)
        rgba = crop.convert('RGBA')
        rgba.putalpha(Image.new('L', (out_size, out_size), 255))
        rgba.save(os.path.join(out_dir, f'sheet_view_{idx}.png'))
        log(f'  sheet_view_{idx} {label:<7} az={az:+04.0f} el={el:+04.0f} saved')


def write_views_json(out_dir):
    views = [{
        'slot': i,
        'file': f'sheet_view_{i}.png',
        'azim': float(az),
        'elev': float(el),
        'label': lab,
    } for i, (_, _, az, el, lab) in enumerate(CELL_LAYOUT)]
    sj = {
        'engine': 'sheet-v2-dual-cn',
        'note': 'SDXL+RealVisXL with dual ControlNet (Depth+Canny) + '
                'IPAdapter on a 3x2 turnaround layout. Bake reads '
                'sheet_view_N.png at the listed azim/elev.',
        'views': views,
    }
    with open(os.path.join(out_dir, 'views.json'), 'w', encoding='utf-8') as f:
        json.dump(sj, f, indent=2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('mesh')
    ap.add_argument('source')
    ap.add_argument('out_dir')
    ap.add_argument('--subject', default='vintage red Italian coupé sports car')
    ap.add_argument('--steps', type=int, default=30)
    ap.add_argument('--guidance', type=float, default=7.0)
    ap.add_argument('--depth-scale', type=float, default=0.7)
    ap.add_argument('--canny-scale', type=float, default=0.5)
    ap.add_argument('--ip-scale', type=float, default=0.65)
    ap.add_argument('--seed', type=int, default=42)
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    t0 = time.time()

    _ensure_renders(args.mesh, args.out_dir, hires=1024)

    log('composing depth + canny sheets...')
    depth_sheet = _compose_sheet(args.out_dir, 'depth')
    canny_sheet = _compose_sheet(args.out_dir, 'canny')
    depth_sheet.save(os.path.join(args.out_dir, 'sheet_cond_depth.png'))
    canny_sheet.save(os.path.join(args.out_dir, 'sheet_cond_canny.png'))

    pipe = load_pipeline()
    pipe.set_ip_adapter_scale(args.ip_scale)

    prompt = (
        f'orthographic 3x2 turnaround model sheet of the same {args.subject}, '
        'six strict orthographic views: '
        'TOP ROW: front, right side profile, back. '
        'BOTTOM ROW: left side profile, top-down view, bottom-up view. '
        'plain white background, photorealistic, glossy paint, chrome trim, '
        'studio lighting, sharp focus, no perspective distortion, '
        'identical car in every cell, no text, no watermark'
    )
    negative = (
        'three-quarter view, perspective distortion, multiple different cars, '
        'shadows on ground, ground plane, characters, people, '
        'tilted camera, dutch angle, blurry, low quality, text overlay'
    )

    ref_img = Image.open(args.source).convert('RGB')
    gen = torch.Generator('cuda').manual_seed(args.seed)

    log(f'generating sheet (steps={args.steps}, cfg={args.guidance}, '
        f'depth={args.depth_scale}, canny={args.canny_scale}, '
        f'ip={args.ip_scale})...')
    t_gen = time.time()
    result = pipe(
        prompt=prompt, negative_prompt=negative,
        image=[depth_sheet, canny_sheet],
        ip_adapter_image=ref_img,
        controlnet_conditioning_scale=[args.depth_scale, args.canny_scale],
        num_inference_steps=args.steps,
        guidance_scale=args.guidance,
        width=SHEET_W, height=SHEET_H,
        generator=gen,
    )
    sheet = result.images[0]
    sheet.save(os.path.join(args.out_dir, 'sheet_output_v2.png'))
    log(f'sheet generated in {time.time()-t_gen:.1f}s')

    split_sheet_to_views(sheet, args.out_dir)
    write_views_json(args.out_dir)

    log(f'DONE in {time.time()-t0:.1f}s -> {args.out_dir}')


if __name__ == '__main__':
    main()
