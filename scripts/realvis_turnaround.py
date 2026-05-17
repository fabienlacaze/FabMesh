"""FabMesh — pure RealVisXL text-to-image turnaround sheet.

No ControlNet, no IPAdapter — just SDXL with a turnaround prompt.
Generates a 1536×1024 image showing 6 orthographic views of a car.

Usage:
    python realvis_turnaround.py <subject_prompt> <out_dir>
        [--ref <ipadapter_ref.png>]   # optional IPAdapter to bias colour/style
        [--steps 40] [--guidance 7.5] [--seed 42]
"""
from __future__ import annotations
import os
import sys
import time
import argparse
import torch
from PIL import Image

CELL = 512
SHEET_W = 3 * CELL  # 1536
SHEET_H = 2 * CELL  # 1024

CELL_LAYOUT = [
    (0, 0,   0.0,    0.00, 'front'),
    (1, 0,  90.0,    0.00, 'right'),
    (2, 0, 180.0,    0.00, 'back'),
    (0, 1, 270.0,    0.00, 'left'),
    (1, 1,   0.0,   89.99, 'top'),
    (2, 1,   0.0,  -89.99, 'bottom'),
]


def log(msg):
    print(f'[realvis_turn] {msg}', flush=True)


def load_pipeline(use_ipadapter):
    from diffusers import StableDiffusionXLPipeline
    log('loading RealVisXL V4.0...')
    pipe = StableDiffusionXLPipeline.from_pretrained(
        'SG161222/RealVisXL_V4.0',
        torch_dtype=torch.float16, variant='fp16',
        use_safetensors=True)
    pipe.unet.to(torch.float16)
    pipe.vae.to(torch.float16)
    pipe.text_encoder.to(torch.float16)
    pipe.text_encoder_2.to(torch.float16)
    if use_ipadapter:
        from transformers import CLIPVisionModelWithProjection
        log('+ IPAdapter for style/colour bias...')
        # Re-instantiate with image encoder this time.
        image_encoder = CLIPVisionModelWithProjection.from_pretrained(
            'h94/IP-Adapter', subfolder='models/image_encoder',
            torch_dtype=torch.float16)
        pipe = StableDiffusionXLPipeline.from_pretrained(
            'SG161222/RealVisXL_V4.0',
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('subject',
                    help='Subject description, e.g. "red sports car"')
    ap.add_argument('out_dir')
    ap.add_argument('--ref', default=None,
                    help='Optional IPAdapter reference image')
    ap.add_argument('--steps', type=int, default=40)
    ap.add_argument('--guidance', type=float, default=7.5)
    ap.add_argument('--ip-scale', type=float, default=0.55)
    ap.add_argument('--seed', type=int, default=42)
    ap.add_argument('--width', type=int, default=SHEET_W)
    ap.add_argument('--height', type=int, default=SHEET_H)
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)

    prompt = (
        f'orthographic turnaround model sheet of the same {args.subject}, '
        'six views arranged in a 3x2 grid on plain white background, '
        'TOP ROW left to right: strict front view (headlights and grille '
        'facing camera), strict right side profile (the car seen from '
        'its right side), strict back view (trunk and tail lights facing '
        'camera), '
        'BOTTOM ROW left to right: strict left side profile (the car seen '
        'from its left side), top-down view (roof and windshield visible), '
        'bottom-up view (underside of the car visible), '
        'orthographic projection no perspective distortion, isolated subject, '
        'studio lighting, photorealistic, sharp focus, detailed, '
        'identical car in every cell, no text labels, no UI, no watermark'
    )
    negative = (
        'three-quarter view, perspective distortion, multiple cars of '
        'different colours, characters, people, signature, text overlay, '
        'watermark, blurry, low quality, shadows on ground, ground plane, '
        'tilted camera, dutch angle, different cars per cell'
    )

    log(f'prompt: {prompt[:120]}...')

    pipe = load_pipeline(use_ipadapter=bool(args.ref))
    if args.ref:
        pipe.set_ip_adapter_scale(args.ip_scale)
        ref_img = Image.open(args.ref).convert('RGB')

    gen = torch.Generator('cuda').manual_seed(args.seed)
    t0 = time.time()
    kwargs = dict(
        prompt=prompt,
        negative_prompt=negative,
        num_inference_steps=args.steps,
        guidance_scale=args.guidance,
        width=args.width, height=args.height,
        generator=gen,
    )
    if args.ref:
        kwargs['ip_adapter_image'] = ref_img
    result = pipe(**kwargs)
    sheet = result.images[0]
    sheet.save(os.path.join(args.out_dir, 'sheet_output.png'))
    log(f'sheet generated in {time.time()-t0:.1f}s')

    # Split
    out_size = 1024
    for col, row, az, el, label in CELL_LAYOUT:
        idx = next(i for i, (c, r, *_) in enumerate(CELL_LAYOUT)
                   if (c, r) == (col, row))
        crop = sheet.crop((col * CELL, row * CELL,
                            (col + 1) * CELL, (row + 1) * CELL))
        crop = crop.resize((out_size, out_size), Image.LANCZOS)
        crop.save(os.path.join(args.out_dir, f'view_{idx}.png'))
        log(f'  view_{idx} {label:<7} az={az:+.0f} el={el:+.0f}')

    import json
    views = [{'slot': i, 'file': f'view_{i}.png',
              'azim': float(az), 'elev': float(el), 'label': lab}
             for i, (_, _, az, el, lab) in enumerate(CELL_LAYOUT)]
    with open(os.path.join(args.out_dir, 'views.json'), 'w',
              encoding='utf-8') as f:
        json.dump({'engine': 'realvis-turnaround',
                   'note': 'Pure RealVisXL text-to-image turnaround.',
                   'views': views}, f, indent=2)

    log(f'DONE -> {args.out_dir}')


if __name__ == '__main__':
    main()
