"""Generate a photorealistic BACK VIEW of the same subject using
RealVis XL + IPAdapter Plus, conditioned on the front photo.

This is a MINIMAL adaptation of scripts/_scale_sweep.py that produced
the validated child_ip45_back.png (proven reproducible pixel-perfect
on the same seed). Only difference: 1 image (back only), configurable
prompt hint (instead of the hardcoded child description).

Replaces Zero123++ for the FabMesh 2-view texturing pipeline.

Usage:
    python generate_back_view.py <front_image> <output_dir>
                                 [prompt_hint] [num_images] [name_suffix]

Model: SG161222/RealVisXL_V4.0 (CreativeML OpenRAIL++-M, commercial OK)
       + h94/IP-Adapter (Apache 2.0)
"""
import sys
import os
import time
import torch
from PIL import Image


def generate_back(front_image, out_dir, prompt_hint='', num_images=1,
                  ip_scale=0.45, steps=30, seed=424242, name_suffix=''):
    os.makedirs(out_dir, exist_ok=True)
    print(f'[back-view] front={front_image} out={out_dir} hint="{prompt_hint}" '
          f'n={num_images} ip_scale={ip_scale}', flush=True)

    from diffusers import StableDiffusionXLPipeline
    from transformers import CLIPVisionModelWithProjection

    print('[back-view] loading RealVisXL + IPAdapter Plus...', flush=True)
    image_encoder = CLIPVisionModelWithProjection.from_pretrained(
        'h94/IP-Adapter', subfolder='models/image_encoder',
        torch_dtype=torch.float16)

    pipe = StableDiffusionXLPipeline.from_pretrained(
        'SG161222/RealVisXL_V4.0',
        torch_dtype=torch.float16, variant='fp16', use_safetensors=True,
        image_encoder=image_encoder)
    pipe.unet.to(torch.float16)
    pipe.vae.to(torch.float16)
    pipe.text_encoder.to(torch.float16)
    pipe.text_encoder_2.to(torch.float16)
    pipe.load_ip_adapter(
        'h94/IP-Adapter', subfolder='sdxl_models',
        weight_name='ip-adapter-plus_sdxl_vit-h.safetensors')
    pipe.enable_model_cpu_offload()
    pipe.set_ip_adapter_scale(ip_scale)
    print('[back-view] ready', flush=True)

    ref_img = Image.open(front_image).convert('RGB')

    # EXACT recipe from _scale_sweep.py (verified pixel-perfect
    # reproducible on seed=424242).
    # CRITICAL: strip FRONT-related tokens from the FabMesh hint
    # (asset-style appends 'strict front view, facing camera, symmetric'
    # which directly contradicts 'back view' and wins because it comes
    # first in the prompt). Without this strip, FabMesh-generated back
    # views are always fronts.
    import re as _re
    hint_clean = prompt_hint or ''
    _front_patterns = [
        r'strict front view',
        r'front view',
        r'facing camera',
        r'symmetric',
        r'three[- ]?quarter view',
        r'three[- ]?fourth view',
    ]
    for pat in _front_patterns:
        hint_clean = _re.sub(pat, '', hint_clean, flags=_re.IGNORECASE)
    hint_clean = _re.sub(r',\s*,', ',', hint_clean)
    hint_clean = _re.sub(r'\s+', ' ', hint_clean).strip(' ,')
    print(f'[back-view] cleaned hint: "{hint_clean[:200]}"', flush=True)

    base = hint_clean if hint_clean else 'a character in T-pose'
    prompt = (
        f'{base}, back view, from behind, back of head visible, '
        f'turned away from camera, full body shot from head to feet, '
        f'entire body visible including shoes, wide shot, '
        f'plain grey background, studio lighting, sharp focus, '
        f'ultra detailed, 8k, masterpiece'
    )
    neg = (
        'blurry, deformed, extra limbs, bad anatomy, different person, '
        'different clothes, watermark, text, duplicate, multiple people, '
        'cropped, low quality, zoomed in, close-up, half body, feet out of frame'
    )

    out_paths = []
    for i in range(num_images):
        # Constant seed for single image (matches scale_sweep).
        gen = torch.Generator('cuda').manual_seed(
            seed if num_images == 1 else seed + i)
        t0 = time.time()
        img = pipe(
            prompt=prompt, negative_prompt=neg,
            ip_adapter_image=ref_img,
            num_inference_steps=steps, guidance_scale=7.0,
            height=1024, width=1024,
            generator=gen,
        ).images[0]
        print(f'[back-view] gen {i}: {time.time()-t0:.1f}s', flush=True)
        suffix = f'_{name_suffix}' if name_suffix else ''
        out_path = os.path.join(out_dir, f'back{suffix}_{i}.png')
        img.save(out_path)
        out_paths.append(out_path)
        print(f'[back-view] saved {out_path}', flush=True)

    print(f'[back-view] done — {len(out_paths)} image(s)', flush=True)
    return out_paths


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('Usage: generate_back_view.py <front_image> <output_dir> '
              '[prompt_hint] [num_images] [name_suffix]')
        sys.exit(1)
    front = sys.argv[1]
    out = sys.argv[2]
    hint = sys.argv[3] if len(sys.argv) > 3 else ''
    n = int(sys.argv[4]) if len(sys.argv) > 4 else 1
    name_suffix = sys.argv[5] if len(sys.argv) > 5 else ''
    paths = generate_back(front, out, hint, n, name_suffix=name_suffix)
    for p in paths:
        print(f'BACK_VIEW_PATH: {p}', flush=True)
