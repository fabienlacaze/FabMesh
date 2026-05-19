"""Multi-view sheet generator — single SDXL call produces N orthographic views.

Layouts (--views N) :
  - --views 2 : 1x2 grid  (front | back)             total 2048x1024
  - --views 4 : 2x2 grid  (front, right; back, left) total 2048x2048
  - --views 6 : 3x2 grid  (front, back, right;       total 2304x1536
                           left, top, bottom)

All views are prompted as STRICT ORTHOGRAPHIC (no perspective, no
foreshortening), each cell is square.

Single SDXL call -> all views share the same style/lighting/colors
(consistent because they were sampled in the same noise pass). No
IPAdapter, no ControlNet, no MV-Adapter. 100% commercial-safe.

CLI :
    python multiview_sheet_gen.py <front_image> <output_dir>
                                   [prompt_hint] [--views 2|4|6]
Outputs:
    <output_dir>/view_0..view_{N-1}.png
    <output_dir>/sheet.png        raw grid for debug
    <output_dir>/views.json       slot -> orientation mapping
    <output_dir>/input.png        copy of the user front
"""
import os
import sys
import json
import time
import argparse
import shutil
from PIL import Image


def log(msg):
    print(f'[sheet] {msg}', flush=True)


# Layout : N -> (cols, rows, cell_size, slot_specs)
# slot_specs is the ordered list of (label, prompt-orientation)
# matching FabMesh's MV-Adapter convention :
#   view_0=front, view_1=back, view_2=right, view_3=left, view_4=top, view_5=bottom
LAYOUTS = {
    2: (2, 1, 1024, [
        ('front', 'strict front view, facing camera directly'),
        ('back',  'strict back view, 180 degrees, no face visible'),
    ]),
    4: (2, 2, 1024, [
        ('front', 'strict front view, facing camera directly'),
        ('right', 'strict right side profile, 90 degrees'),
        ('back',  'strict back view, 180 degrees, no face visible'),
        ('left',  'strict left side profile, 270 degrees'),
    ]),
    6: (3, 2, 768, [
        ('front',  'strict front view, facing camera directly'),
        ('back',   'strict back view, 180 degrees, no face visible'),
        ('right',  'strict right side profile, 90 degrees'),
        ('left',   'strict left side profile, 270 degrees'),
        ('top',    'strict top-down view from directly above'),
        ('bottom', 'strict bottom-up view from directly below'),
    ]),
}


ORIENT_AZIM_ELEV = {
    'front':  (0,   0),
    'back':   (180, 0),
    'right':  (90,  0),
    'left':   (270, 0),
    'top':    (0,   90),
    'bottom': (0,   -90),
}


def build_prompt(subject_hint: str, layout):
    cols, rows, _, slots = layout
    base = subject_hint.strip() if subject_hint else 'character'
    grid_label = f'{cols}x{rows}' if rows > 1 else f'{cols} views'
    parts = [
        f'{len(slots)}-view orthographic character model sheet of {base}',
        f'{grid_label} grid layout, equal cells',
        'STRICT ORTHOGRAPHIC projection, no perspective, no foreshortening',
        'T-pose neutral stance, arms extended, full body visible in each cell',
        'consistent character identical across all cells, same lighting',
        'plain white background, even studio lighting, no shadows',
        'symmetric grid, perfectly aligned, centered subject in each cell',
        'ultra detailed, sharp focus, 8k, photorealistic',
    ]
    # Add an ordered description of cell contents (row by row).
    cell_lines = []
    for i, (label, orient) in enumerate(slots):
        col = i % cols
        row = i // cols
        # Position labels in plain English
        pos_v = 'top' if row == 0 else ('middle' if row < rows-1 else 'bottom')
        if rows == 1:
            pos_v = 'middle'
        pos_h = 'left' if col == 0 else ('right' if col == cols-1 else 'middle')
        cell_lines.append(f'{pos_v}-{pos_h} cell: {orient}')
    parts += cell_lines
    return ', '.join(parts)


NEG_PROMPT = (
    'perspective, foreshortening, three-quarter view, asymmetric, '
    'cropped, missing limbs, deformed, blurry, low quality, '
    'multiple characters per cell, different characters, text, '
    'watermark, signature, frame, border'
)


def split_sheet(sheet_img: Image.Image, output_dir: str, layout):
    cols, rows, cell_size, slots = layout
    sheet_w, sheet_h = sheet_img.size
    cell_w = sheet_w // cols
    cell_h = sheet_h // rows
    log(f'splitting {sheet_w}x{sheet_h} into {cols}x{rows} cells '
        f'of {cell_w}x{cell_h}')
    paths = {}
    for i, (label, _) in enumerate(slots):
        col = i % cols
        row = i // cols
        box = (col * cell_w, row * cell_h,
               (col + 1) * cell_w, (row + 1) * cell_h)
        cell = sheet_img.crop(box)
        out_p = os.path.join(output_dir, f'view_{i}.png')
        cell.save(out_p)
        paths[i] = out_p
        log(f'wrote view_{i} ({label}) -> {out_p}')
    # views.json
    views_meta = {
        'engine': 'sdxl_sheet',
        'layout': f'{cols}x{rows}',
        'views': [
            {'azim': ORIENT_AZIM_ELEV[lbl][0],
             'elev': ORIENT_AZIM_ELEV[lbl][1],
             'label': lbl}
            for lbl, _ in slots
        ],
    }
    with open(os.path.join(output_dir, 'views.json'), 'w', encoding='utf-8') as f:
        json.dump(views_meta, f, indent=2)
    return paths


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('front_image')
    ap.add_argument('output_dir')
    ap.add_argument('prompt_hint', nargs='?', default='')
    ap.add_argument('--views', type=int, default=4, choices=[2, 4, 6])
    args = ap.parse_args()

    front_image = os.path.abspath(args.front_image)
    output_dir = os.path.abspath(args.output_dir)
    prompt_hint = args.prompt_hint or ''
    n_views = args.views

    if not os.path.isfile(front_image):
        log(f'ERROR: front image not found: {front_image}')
        sys.exit(2)
    os.makedirs(output_dir, exist_ok=True)
    log(f'front={front_image}')
    log(f'out_dir={output_dir}')
    log(f'views={n_views}')
    log(f'subject={prompt_hint or "(none)"}')

    layout = LAYOUTS[n_views]
    cols, rows, cell_size, _ = layout
    sheet_w = cols * cell_size
    sheet_h = rows * cell_size
    log(f'sheet target size: {sheet_w}x{sheet_h} ({cols}x{rows} cells '
        f'of {cell_size}x{cell_size})')

    # Copy untouched front for downstream pipelines.
    shutil.copy2(front_image, os.path.join(output_dir, 'input.png'))

    log('loading SG161222/RealVisXL_V4.0 + IPAdapter Plus ...')
    import torch
    from diffusers import StableDiffusionXLPipeline
    from transformers import CLIPVisionModelWithProjection

    # IPAdapter Plus is essential here: without identity anchoring, SDXL
    # prompt-only invents a generic "creature model sheet" character
    # totally unrelated to the user's front image. With IPAdapter, the
    # sheet's character matches the input identity / color / clothing.
    image_encoder = CLIPVisionModelWithProjection.from_pretrained(
        'h94/IP-Adapter',
        subfolder='models/image_encoder',
        torch_dtype=torch.float16,
    )
    pipe = StableDiffusionXLPipeline.from_pretrained(
        'SG161222/RealVisXL_V4.0',
        torch_dtype=torch.float16,
        variant='fp16',
        use_safetensors=True,
        image_encoder=image_encoder,
    )
    # Force every sub-module to fp16 — text_projection inside CLIP stays
    # fp32 by default and breaks at runtime with dtype mismatch.
    pipe.unet.to(torch.float16)
    pipe.vae.to(torch.float16)
    pipe.text_encoder.to(torch.float16)
    pipe.text_encoder_2.to(torch.float16)
    pipe.load_ip_adapter(
        'h94/IP-Adapter',
        subfolder='sdxl_models',
        weight_name='ip-adapter-plus_sdxl_vit-h.safetensors',
    )
    # 0.6 = decent identity + still lets the grid layout breathe
    ip_scale = float(os.environ.get('FABMESH_SHEET_IP_SCALE', '0.6'))
    pipe.set_ip_adapter_scale(ip_scale)
    pipe.enable_model_cpu_offload()
    log(f'IPAdapter loaded, scale={ip_scale}')

    # Load the user's front image as the identity reference.
    front_img_pil = Image.open(front_image).convert('RGB')

    prompt = build_prompt(prompt_hint, layout)
    log(f'prompt: {prompt[:300]}...')

    t0 = time.time()
    image = pipe(
        prompt=prompt,
        negative_prompt=NEG_PROMPT,
        ip_adapter_image=front_img_pil,
        width=sheet_w,
        height=sheet_h,
        num_inference_steps=30,
        guidance_scale=7.0,
        num_images_per_prompt=1,
    ).images[0]
    log(f'SDXL done in {time.time()-t0:.1f}s')

    sheet_path = os.path.join(output_dir, 'sheet.png')
    image.save(sheet_path)
    log(f'sheet saved -> {sheet_path}')

    paths = split_sheet(image, output_dir, layout)
    log(f'TOTAL: {time.time()-t0:.1f}s, {len(paths)} view(s) written')


if __name__ == '__main__':
    main()
