"""Upscale the baseColor atlas via Real-ESRGAN (Apache 2.0, no hallucination).

Why: SDXL-based refine hallucinates wear on smooth surfaces (cars,
chrome). A bilateral filter cleans the speckle but can't *add*
resolution. Real-ESRGAN does the opposite: it learned to invert
the typical bicubic-downscale pipeline, so it adds plausible
edge sharpness and texture frequency *without* inventing new content.

Pipeline:
  1. Load GLB, extract baseColorTexture.
  2. Run RealESRGAN_x4plus (or x2plus) on the texture.
  3. Re-pack into the GLB.

Model: xinntao/Real-ESRGAN (BSD 3-Clause), weights Apache 2.0
compatible. Default model 'RealESRGAN_x4plus.pth' (~70 MB, auto-DL
from HuggingFace on first run via realesrgan package).

Usage:
    python texture_upscale.py <input.glb> <output.glb>
        [--scale 2] [--model x4plus] [--tile 512]
"""
import argparse
import os
import sys
import time

import numpy as np
from PIL import Image


def log(msg):
    print(f'[tex-upscale] {msg}', flush=True)


def upscale_atlas(img: Image.Image, scale=2, model_name='RealESRGAN_x4plus',
                  tile=512) -> Image.Image:
    """Run Real-ESRGAN x4 (or x2) on `img`. Returns RGB PIL upscaled."""
    import torch
    from basicsr.archs.rrdbnet_arch import RRDBNet
    from realesrgan import RealESRGANer

    # Auto-download weight on first run.
    model_dir = os.path.expanduser('~/.cache/realesrgan_weights')
    os.makedirs(model_dir, exist_ok=True)
    weight_path = os.path.join(model_dir, f'{model_name}.pth')
    if not os.path.isfile(weight_path):
        log(f'downloading {model_name} to {weight_path}...')
        from urllib.request import urlretrieve
        urls = {
            'RealESRGAN_x4plus':
                'https://github.com/xinntao/Real-ESRGAN/releases/'
                'download/v0.1.0/RealESRGAN_x4plus.pth',
            'RealESRGAN_x2plus':
                'https://github.com/xinntao/Real-ESRGAN/releases/'
                'download/v0.2.1/RealESRGAN_x2plus.pth',
        }
        urlretrieve(urls[model_name], weight_path)
        log(f'  downloaded {os.path.getsize(weight_path)} bytes')

    if 'x4plus' in model_name:
        net_scale = 4
        model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64,
                         num_block=23, num_grow_ch=32, scale=4)
    elif 'x2plus' in model_name:
        net_scale = 2
        model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64,
                         num_block=23, num_grow_ch=32, scale=2)
    else:
        raise ValueError(f'unknown model: {model_name}')

    upsampler = RealESRGANer(
        scale=net_scale, model_path=weight_path, model=model,
        tile=tile, tile_pad=10, pre_pad=0, half=True,
        device='cuda' if torch.cuda.is_available() else 'cpu',
    )

    arr = np.array(img.convert('RGB'))
    # Real-ESRGAN expects BGR
    arr_bgr = arr[..., ::-1].copy()
    out_bgr, _ = upsampler.enhance(arr_bgr, outscale=scale)
    out_rgb = out_bgr[..., ::-1]
    return Image.fromarray(out_rgb)


def upscale_glb(in_path, out_path, scale=2, model='RealESRGAN_x4plus',
                tile=512):
    import trimesh
    log(f'load {in_path}')
    scene = trimesh.load(in_path, force='scene')

    geoms = (list(scene.geometry.values())
             if hasattr(scene, 'geometry') else [scene])
    n = 0
    for m in geoms:
        visual = getattr(m, 'visual', None)
        if not visual:
            continue
        material = getattr(visual, 'material', None)
        if not material:
            continue
        tex = getattr(material, 'baseColorTexture', None)
        if not tex:
            continue
        log(f'  upscaling baseColor {tex.size} '
            f'x{scale} via {model}, tile={tile}')
        t0 = time.time()
        new_tex = upscale_atlas(tex, scale, model, tile)
        log(f'  done in {time.time()-t0:.1f}s -> {new_tex.size}')
        material.baseColorTexture = new_tex
        n += 1
    if not n:
        log('WARN: no baseColorTexture found')

    log(f'export {out_path}')
    scene.export(out_path)
    log(f'wrote {os.path.getsize(out_path)} bytes')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input')
    ap.add_argument('output')
    ap.add_argument('--scale', type=int, default=2,
                    help='output scale relative to input (1, 2 or 4)')
    ap.add_argument('--model', default='RealESRGAN_x4plus',
                    choices=['RealESRGAN_x4plus', 'RealESRGAN_x2plus'])
    ap.add_argument('--tile', type=int, default=512,
                    help='tile size (lower = less VRAM, more seams)')
    args = ap.parse_args()

    if not os.path.isfile(args.input):
        log(f'ERROR: input not found: {args.input}')
        sys.exit(2)

    t0 = time.time()
    upscale_glb(args.input, args.output, scale=args.scale,
                model=args.model, tile=args.tile)
    log(f'TOTAL: {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
