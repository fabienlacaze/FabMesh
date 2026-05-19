"""Multi-view sheet generator — single SDXL call produces a 4-view grid.

Idea (user request 2026-05-19): instead of running MV-Adapter (broken
on diffusers >= 0.33) or 4 separate SDXL+IPAdapter calls, ask the base
model (RealVisXL) to draw a single "character model sheet" image with
4 views in a 2x2 grid (front / right / back / left). Then crop the
4 cells into view_0..view_3.png that the rest of the pipeline can
feed into TRELLIS-2 multi-ref.

Pros:
  - 1 SDXL call (~25-30s) instead of 4 (~100s) — 4x speedup
  - All 4 views share a single style/lighting/colors (consistent
    because they were sampled in the same noise pass)
  - No MV-Adapter dependency, no IPAdapter, no ControlNet
  - 100% commercial-safe (RealVisXL OpenRAIL++-M, Apache 2.0 deps)

Cons:
  - Each cell is half the resolution of a normal SDXL output
    (~1024 if the sheet is 2048, ~768 if 1536)
  - SDXL doesn't always honor "4-view grid" perfectly; if a cell ends
    up wrong, we still ship the imperfect result instead of an AI
    hallucination of a fake back.

CLI :
    python multiview_sheet_gen.py <front_image> <output_dir> [prompt_hint]

Outputs:
    <output_dir>/view_0.png   front (top-left cell)
    <output_dir>/view_1.png   back  (bottom-left cell)
    <output_dir>/view_2.png   right (top-right cell)
    <output_dir>/view_3.png   left  (bottom-right cell)
    <output_dir>/sheet.png    raw 2x2 grid for debugging
    <output_dir>/views.json   slot -> angle mapping
"""
import os
import sys
import json
import time
from PIL import Image


SHEET_SIZE = 2048   # cells will be 1024x1024
CELL_SIZE = SHEET_SIZE // 2


def log(msg):
    print(f'[sheet] {msg}', flush=True)


def build_prompt(subject_hint: str = '') -> str:
    """Force a clean 2x2 model-sheet layout with a strict orientation
    convention. SDXL needs explicit cell positions to be reliable."""
    base = subject_hint.strip() if subject_hint else 'character'
    parts = [
        f'4-view character model sheet of {base}',
        'orthographic views',
        '2 by 2 grid layout, four equal quadrants',
        'TOP-LEFT cell: strict front view, facing camera directly',
        'TOP-RIGHT cell: strict right side profile view, 90 degrees',
        'BOTTOM-LEFT cell: strict back view, 180 degrees',
        'BOTTOM-RIGHT cell: strict left side profile view, 270 degrees',
        'T-pose neutral stance, arms extended, full body visible',
        'consistent character identical across all four views',
        'plain white background, even studio lighting, no shadows',
        'ultra detailed, sharp focus, 8k, photorealistic',
        'symmetric layout, perfectly aligned grid, centered subject in each cell',
    ]
    return ', '.join(parts)


NEG_PROMPT = (
    'perspective, foreshortening, three-quarter view, asymmetric grid, '
    'cropped, missing limbs, deformed, blurry, low quality, multiple '
    'characters per cell, text, watermark, signature'
)


def split_sheet_to_views(sheet_img: Image.Image, output_dir: str):
    """Crop the 2x2 grid into 4 cells, named after the orientation
    convention enforced in the prompt :
        view_0 = top-left  (front)
        view_1 = bottom-left (back)
        view_2 = top-right  (right)
        view_3 = bottom-right (left)
    Same view_N <-> orientation mapping as MV-Adapter's contract so
    downstream code (3D pipeline, multiview thumb grid) keeps working.
    """
    w, h = sheet_img.size
    half_w, half_h = w // 2, h // 2
    crops = {
        0: sheet_img.crop((0, 0, half_w, half_h)),         # front
        1: sheet_img.crop((0, half_h, half_w, h)),         # back
        2: sheet_img.crop((half_w, 0, w, half_h)),         # right
        3: sheet_img.crop((half_w, half_h, w, h)),         # left
    }
    paths = {}
    for idx, img in crops.items():
        p = os.path.join(output_dir, f'view_{idx}.png')
        img.save(p)
        paths[idx] = p
        log(f'wrote view_{idx} -> {p}')
    # views.json (compat with multiview_mvadapter / multiview_crm contracts)
    views_meta = {
        'engine': 'sdxl_sheet',
        'views': [
            {'azim': 0,   'elev': 0, 'label': 'front'},
            {'azim': 180, 'elev': 0, 'label': 'back'},
            {'azim': 90,  'elev': 0, 'label': 'right'},
            {'azim': 270, 'elev': 0, 'label': 'left'},
        ],
    }
    with open(os.path.join(output_dir, 'views.json'), 'w', encoding='utf-8') as f:
        json.dump(views_meta, f, indent=2)
    return paths


def main():
    if len(sys.argv) < 3:
        print('Usage: multiview_sheet_gen.py <front_image> <output_dir> '
              '[prompt_hint]')
        sys.exit(1)
    front_image = os.path.abspath(sys.argv[1])
    output_dir = os.path.abspath(sys.argv[2])
    prompt_hint = sys.argv[3] if len(sys.argv) > 3 else ''

    if not os.path.isfile(front_image):
        log(f'ERROR: front image not found: {front_image}')
        sys.exit(2)
    os.makedirs(output_dir, exist_ok=True)
    log(f'front={front_image}')
    log(f'out_dir={output_dir}')
    log(f'subject={prompt_hint or "(none)"}')

    # Copy the user's untouched front as view_0 reference (for the
    # downstream pipelines that expect input.png + view_0.png).
    import shutil
    shutil.copy2(front_image, os.path.join(output_dir, 'input.png'))

    # Load RealVisXL once. Same model used by the front-image gen, so
    # the cell style/lighting matches the original front aesthetic.
    log('loading SG161222/RealVisXL_V4.0 ...')
    import torch
    from diffusers import StableDiffusionXLPipeline
    pipe = StableDiffusionXLPipeline.from_pretrained(
        'SG161222/RealVisXL_V4.0',
        torch_dtype=torch.float16,
        variant='fp16',
        use_safetensors=True,
    )
    # Force every sub-module to fp16 (not just unet+vae): text_projection
    # inside CLIPTextModelWithProjection is loaded in fp32 by default and
    # mismatches the fp16 hidden_states downstream, raising
    # `expected mat1 and mat2 to have the same dtype, but got float != Half`.
    pipe.unet.to(torch.float16)
    pipe.vae.to(torch.float16)
    pipe.text_encoder.to(torch.float16)
    pipe.text_encoder_2.to(torch.float16)
    pipe.enable_model_cpu_offload()

    prompt = build_prompt(prompt_hint)
    log(f'prompt: {prompt[:240]}...')

    t0 = time.time()
    image = pipe(
        prompt=prompt,
        negative_prompt=NEG_PROMPT,
        width=SHEET_SIZE,
        height=SHEET_SIZE,
        num_inference_steps=30,
        guidance_scale=7.0,
        num_images_per_prompt=1,
    ).images[0]
    log(f'SDXL done in {time.time()-t0:.1f}s')

    # Save the raw sheet for debugging / preview
    sheet_path = os.path.join(output_dir, 'sheet.png')
    image.save(sheet_path)
    log(f'sheet saved -> {sheet_path}')

    # Split into 4 view_N.png
    paths = split_sheet_to_views(image, output_dir)
    log(f'TOTAL: {time.time()-t0:.1f}s, {len(paths)} views written')


if __name__ == '__main__':
    main()
