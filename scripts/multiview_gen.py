"""
FabMesh Multi-View Generation — generate 6 consistent views from a single image.
================================================================================

Uses Zero123++ v1.2 (Apache 2.0, commercial-safe) to generate 6 views
(front, front-right, right, back, left, front-left) from a single input image.

These views are then used by texture_project.py to create a high-quality
texture atlas covering the entire mesh surface.

Usage:
    python multiview_gen.py <input_image> <output_dir> [--size 320]

Output:
    <output_dir>/view_0.png  (front-right, 30°)
    <output_dir>/view_1.png  (right, 90°)
    <output_dir>/view_2.png  (back-right, 150°)
    <output_dir>/view_3.png  (back, 210°)
    <output_dir>/view_4.png  (left, 270°)
    <output_dir>/view_5.png  (front-left, 330°)
    <output_dir>/input.png   (copy of input, front 0°)

Model: sudo-ai/zero123plus-v1.2 (~4 GB, downloaded on first run)
License: Apache 2.0
"""
import sys
import os
import time
import torch
import numpy as np
from PIL import Image


def log(msg):
    print(f'[multiview] {msg}', flush=True)


def generate_multiview(input_image_path, output_dir, size=320):
    """Generate 6 views from a single input image using Zero123++ v1.2."""
    t0 = time.time()
    log(f'input={input_image_path}')
    log(f'output_dir={output_dir}')
    os.makedirs(output_dir, exist_ok=True)

    # Load input image
    input_img = Image.open(input_image_path).convert('RGB')
    log(f'input size: {input_img.size}')

    # Resize to expected input size (320x320 for Zero123++)
    input_img_resized = input_img.resize((size, size), Image.LANCZOS)

    # Save input copy
    input_img.save(os.path.join(output_dir, 'input.png'))

    log('loading Zero123++ v1.2 pipeline...')
    log('MULTIVIEW_PROGRESS: 10')

    from diffusers import DiffusionPipeline, EulerAncestralDiscreteScheduler

    pipeline = DiffusionPipeline.from_pretrained(
        "sudo-ai/zero123plus-v1.2",
        custom_pipeline="sudo-ai/zero123plus-pipeline",
        torch_dtype=torch.float16,
    )
    # Use Euler ancestral scheduler for better quality
    pipeline.scheduler = EulerAncestralDiscreteScheduler.from_config(
        pipeline.scheduler.config, timestep_spacing='trailing'
    )
    pipeline.to('cuda' if torch.cuda.is_available() else 'cpu')

    log(f'pipeline loaded in {time.time()-t0:.1f}s')
    log('MULTIVIEW_PROGRESS: 40')

    # Generate 6 views
    log('generating 6 views...')
    with torch.no_grad():
        result = pipeline(
            input_img_resized,
            num_inference_steps=100,
            guidance_scale=4.0,
        ).images[0]

    log(f'generation done in {time.time()-t0:.1f}s')
    log('MULTIVIEW_PROGRESS: 80')

    # Zero123++ v1.2 outputs a 640x960 grid = 2 columns x 3 rows of 320x320 tiles
    # Layout (left to right, top to bottom):
    #   [0] 30°  front-right   [1] 90°  right
    #   [2] 150° back-right    [3] 210° back-left
    #   [4] 270° left          [5] 330° front-left
    w, h = result.size
    n_cols = 2
    n_rows = 3
    tile_w = w // n_cols
    tile_h = h // n_rows

    view_names = ['view_0', 'view_1', 'view_2', 'view_3', 'view_4', 'view_5']

    for i in range(6):
        row = i // n_cols
        col = i % n_cols
        x = col * tile_w
        y = row * tile_h
        view = result.crop((x, y, x + tile_w, y + tile_h))
        view_path = os.path.join(output_dir, f'{view_names[i]}.png')
        view.save(view_path)
        log(f'saved {view_names[i]}.png ({view.size})')

    log('MULTIVIEW_PROGRESS: 90')

    # Free GPU
    del pipeline
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    elapsed = time.time() - t0
    log(f'done in {elapsed:.1f}s')
    log('MULTIVIEW_PROGRESS: 100')
    return True


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python multiview_gen.py <input_image> <output_dir> [--size 320]")
        sys.exit(1)

    input_path = sys.argv[1]
    output_dir = sys.argv[2]
    size = 320
    if '--size' in sys.argv:
        idx = sys.argv.index('--size')
        size = int(sys.argv[idx + 1])

    try:
        ok = generate_multiview(input_path, output_dir, size)
        sys.exit(0 if ok else 1)
    except Exception as e:
        log(f'ERROR: {type(e).__name__}: {e}')
        import traceback
        traceback.print_exc()
        sys.exit(2)
