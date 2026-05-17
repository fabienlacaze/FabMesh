"""FabMesh sheet runner v3 — Depth-only ControlNet, smoother SDXL output.

Differences from sheet_render_v2.py:
  - SINGLE ControlNet (Depth, no Canny) — Canny edges were causing SDXL
    to hallucinate scales / fabric / hatching textures from the rough
    Hi3DGen mesh outline. Pure depth gives smoother painted output.
  - Lower depth scale (0.5 vs 0.7) — gives SDXL more creative freedom
    to follow the IP-Adapter style rather than over-fitting the mesh.
  - Higher ip-scale default (0.75) — better identity / colour from ref.
  - Aggressive anti-pattern negatives.
  - 35 steps (vs 30) — slight quality bump.

Usage:
    python sheet_render_v3.py <mesh.glb> <source_photo> <out_dir>
"""
from __future__ import annotations
import os
import sys
import json
import time
import argparse
import subprocess
import numpy as np
from PIL import Image
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
    print(f'[sheet_v3] {msg}', flush=True)


def _ensure_renders(mesh_path, out_dir, hires=1024):
    needed = [os.path.join(out_dir, f'depth_{i}.png') for i in range(6)]
    if all(os.path.isfile(p) for p in needed):
        log(f'depth maps already present in {out_dir}')
        return
    log(f'rendering mesh depth at {hires}px...')
    r = subprocess.run(
        [sys.executable,
         os.path.join(SCRIPTS, 'mv_render_from_mesh.py'),
         mesh_path, out_dir, '--res', str(hires)],
        check=False)
    if r.returncode != 0:
        raise RuntimeError(f'mesh render failed: rc={r.returncode}')


def _compose_depth_sheet(out_dir):
    sheet = Image.new('RGB', (SHEET_W, SHEET_H), (0, 0, 0))
    for col, row, _, _, _ in CELL_LAYOUT:
        idx = next(i for i, (c, r, *_) in enumerate(CELL_LAYOUT)
                   if (c, r) == (col, row))
        depth_pil = Image.open(os.path.join(out_dir, f'depth_{idx}.png'))
        depth_pil = depth_pil.convert('L').resize((CELL, CELL), Image.LANCZOS)
        cell = Image.merge('RGB', (depth_pil, depth_pil, depth_pil))
        sheet.paste(cell, (col * CELL, row * CELL))
    return sheet


def load_pipeline():
    from diffusers import (
        ControlNetModel,
        StableDiffusionXLControlNetPipeline,
    )
    from transformers import CLIPVisionModelWithProjection
    log('loading RealVisXL + ControlNet Depth (no Canny) + IPAdapter...')
    image_encoder = CLIPVisionModelWithProjection.from_pretrained(
        'h94/IP-Adapter', subfolder='models/image_encoder',
        torch_dtype=torch.float16)
    cn_depth = ControlNetModel.from_pretrained(
        'diffusers/controlnet-depth-sdxl-1.0', torch_dtype=torch.float16)
    pipe = StableDiffusionXLControlNetPipeline.from_pretrained(
        'SG161222/RealVisXL_V4.0',
        controlnet=cn_depth,
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
    out_size = 1024
    for col, row, az, el, label in CELL_LAYOUT:
        idx = next(i for i, (c, r, *_) in enumerate(CELL_LAYOUT)
                   if (c, r) == (col, row))
        crop = sheet_img.crop((col * CELL, row * CELL,
                                (col + 1) * CELL, (row + 1) * CELL))
        crop = crop.resize((out_size, out_size), Image.LANCZOS)
        rgba = crop.convert('RGBA')
        rgba.putalpha(Image.new('L', (out_size, out_size), 255))
        rgba.save(os.path.join(out_dir, f'view_{idx}.png'))
        log(f'  view_{idx} {label:<7} az={az:+04.0f} el={el:+04.0f}')


def write_views_json(out_dir):
    views = [{
        'slot': i, 'file': f'view_{i}.png',
        'azim': float(az), 'elev': float(el), 'label': lab,
    } for i, (_, _, az, el, lab) in enumerate(CELL_LAYOUT)]
    with open(os.path.join(out_dir, 'views.json'), 'w', encoding='utf-8') as f:
        json.dump({'engine': 'sheet-v3-depth-only', 'views': views}, f, indent=2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('mesh')
    ap.add_argument('source')
    ap.add_argument('out_dir')
    ap.add_argument('--subject', default='character')
    ap.add_argument('--steps', type=int, default=35)
    ap.add_argument('--guidance', type=float, default=6.5)
    ap.add_argument('--depth-scale', type=float, default=0.5)
    ap.add_argument('--ip-scale', type=float, default=0.75)
    ap.add_argument('--seed', type=int, default=42)
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    t0 = time.time()

    _ensure_renders(args.mesh, args.out_dir, hires=1024)
    log('composing depth sheet (no canny)...')
    depth_sheet = _compose_depth_sheet(args.out_dir)
    depth_sheet.save(os.path.join(args.out_dir, 'sheet_cond_depth.png'))

    pipe = load_pipeline()
    pipe.set_ip_adapter_scale(args.ip_scale)

    prompt = (
        f'orthographic 3x2 turnaround model sheet, same {args.subject}, '
        'six clean views: TOP ROW front, right, back. BOTTOM ROW left, '
        'top-down, bottom-up. plain white background, photorealistic, '
        'smooth clean SKIN texture, soft lighting, sharp focus, '
        'professional 3d render, identical subject in every cell'
    )
    negative = (
        'scales, fish scales, snake skin, reptile, dragon scales, fabric, '
        'woven, hatching, cross-hatching, mesh pattern, repeated pattern, '
        'tile texture, fish-net, chainmail, dotted, speckled, '
        'three-quarter view, perspective distortion, different cars/subjects '
        'per cell, characters of different colour, shadows on ground, '
        'tilted camera, dutch angle, blurry, low quality, text overlay'
    )

    ref_img = Image.open(args.source).convert('RGB')
    gen = torch.Generator('cuda').manual_seed(args.seed)

    log(f'generating sheet (depth={args.depth_scale}, ip={args.ip_scale}, '
        f'steps={args.steps}, cfg={args.guidance})...')
    t_gen = time.time()
    result = pipe(
        prompt=prompt, negative_prompt=negative,
        image=depth_sheet,
        ip_adapter_image=ref_img,
        controlnet_conditioning_scale=args.depth_scale,
        num_inference_steps=args.steps,
        guidance_scale=args.guidance,
        width=SHEET_W, height=SHEET_H,
        generator=gen,
    )
    sheet = result.images[0]
    sheet.save(os.path.join(args.out_dir, 'sheet_output_v3.png'))
    log(f'sheet generated in {time.time()-t_gen:.1f}s')

    split_sheet_to_views(sheet, args.out_dir)
    write_views_json(args.out_dir)
    log(f'DONE in {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
