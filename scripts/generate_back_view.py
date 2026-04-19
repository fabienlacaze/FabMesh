"""Generate a photorealistic BACK VIEW of the same subject using
RealVis XL + IPAdapter Plus, conditioned on the front photo.

This replaces Zero123++ (which is hallucinated and not photoreal) for
the FabMesh 2-view texturing pipeline.

Usage:
    python generate_back_view.py <front_image> <output_dir> [prompt_hint] [num_images]

Output: out_dir/back_0.png (and back_1, back_2, back_3 if num_images>1)

Model: SG161222/RealVisXL_V4.0 (CreativeML OpenRAIL++-M, commercial OK)
       + h94/IP-Adapter (Apache 2.0)
"""
import sys
import os
import torch
from PIL import Image


def generate_back(front_image, out_dir, prompt_hint='', num_images=1, ip_scale=0.45,
                  steps=30, seed=424242):
    os.makedirs(out_dir, exist_ok=True)
    print(f'[back-view] front={front_image} out={out_dir} hint="{prompt_hint}" '
          f'n={num_images} ip_scale={ip_scale}', flush=True)

    from diffusers import StableDiffusionXLPipeline
    from transformers import CLIPVisionModelWithProjection

    print('[back-view] loading RealVisXL + IPAdapter Plus...', flush=True)
    image_encoder = CLIPVisionModelWithProjection.from_pretrained(
        'h94/IP-Adapter', subfolder='models/image_encoder',
        torch_dtype=torch.float16,
    )
    pipe = StableDiffusionXLPipeline.from_pretrained(
        'SG161222/RealVisXL_V4.0',
        torch_dtype=torch.float16, variant='fp16', use_safetensors=True,
        image_encoder=image_encoder,
    )
    pipe.unet.to(torch.float16)
    pipe.vae.to(torch.float16)
    pipe.text_encoder.to(torch.float16)
    pipe.text_encoder_2.to(torch.float16)
    pipe.load_ip_adapter(
        'h94/IP-Adapter', subfolder='sdxl_models',
        weight_name='ip-adapter-plus_sdxl_vit-h.safetensors',
    )
    pipe.enable_model_cpu_offload()
    pipe.set_ip_adapter_scale(ip_scale)
    print('[back-view] ready', flush=True)

    ref_img = Image.open(front_image).convert('RGB')

    # Use the user prompt hint if provided, else generic. The "back view"
    # phrasing is critical to avoid Identity drift via IPAdapter (which
    # would otherwise replicate the front pose).
    if prompt_hint:
        prompt = (
            f'{prompt_hint}, back view, from behind, back of head visible, '
            f'turned away from camera, full body centered, plain grey '
            f'background, studio lighting, sharp focus, ultra detailed, 8k'
        )
    else:
        prompt = (
            'back view, from behind, back of head visible, turned away from '
            'camera, full body centered, plain grey background, studio '
            'lighting, sharp focus, ultra detailed, 8k, masterpiece'
        )
    neg = (
        'blurry, deformed, extra limbs, bad anatomy, different person, '
        'different clothes, watermark, text, duplicate, multiple people, '
        'front view, facing camera, side view'
    )

    out_paths = []
    for i in range(num_images):
        gen = torch.Generator('cuda').manual_seed(seed + i)
        img = pipe(
            prompt=prompt,
            negative_prompt=neg,
            ip_adapter_image=ref_img,
            num_inference_steps=steps,
            guidance_scale=6.0,
            generator=gen,
            width=1024, height=1024,
        ).images[0]
        out_path = os.path.join(out_dir, f'back_{i}.png')
        img.save(out_path)
        out_paths.append(out_path)
        print(f'[back-view] saved {out_path}', flush=True)

    print(f'[back-view] done — {len(out_paths)} image(s)', flush=True)
    return out_paths


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('Usage: generate_back_view.py <front_image> <output_dir> '
              '[prompt_hint] [num_images]')
        sys.exit(1)
    front = sys.argv[1]
    out = sys.argv[2]
    hint = sys.argv[3] if len(sys.argv) > 3 else ''
    n = int(sys.argv[4]) if len(sys.argv) > 4 else 1
    paths = generate_back(front, out, hint, n)
    # Print marker for main.js to parse
    for p in paths:
        print(f'BACK_VIEW_PATH: {p}', flush=True)
