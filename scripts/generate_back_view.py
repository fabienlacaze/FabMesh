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
                  steps=30, seed=424242, name_suffix=''):
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

    # CRITICAL: strip FRONT-related tokens from the user hint. FabMesh's
    # asset-style system appends 'strict front view, facing camera,
    # symmetric' which directly contradicts the 'back view' directive and
    # wins because it comes first in the prompt.
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

    base = hint_clean if hint_clean else 'a person in T-pose'
    prompt = (
        f'{base}, back view, from behind, back of head visible, '
        f'turned away from camera, full body centered, plain grey '
        f'background, studio lighting, sharp focus, ultra detailed, '
        f'8k, masterpiece'
    )
    # Plain neg, NO 'front view' / 'face' bans (those over-constrain
    # SDXL and force it to invent a NEW different person to avoid
    # the forbidden tokens — exactly the bug the user reported).
    neg = (
        'blurry, deformed, extra limbs, bad anatomy, different person, '
        'different clothes, watermark, text, duplicate, multiple people, '
        'cropped, low quality'
    )

    # IPAdapter scale SCHEDULE: steps 0..orient_end = 0 (prompt alone dictates
    # orientation), orient_end..identity_start = ramp, identity_start..end =
    # full ip_scale (identity lock-in once orientation is committed).
    # The diffusion process commits composition in the first 30% of steps, so
    # holding IPAdapter off during that phase frees 'back view' to win.
    orient_end = max(1, int(steps * 0.33))
    identity_start = max(orient_end + 1, int(steps * 0.66))

    def _ip_schedule_cb(pipe_ref, step_index, timestep, cbk_kwargs):
        if step_index < orient_end:
            pipe_ref.set_ip_adapter_scale(0.0)
        elif step_index < identity_start:
            # Linear ramp between orient_end and identity_start
            t = (step_index - orient_end) / max(1, identity_start - orient_end)
            pipe_ref.set_ip_adapter_scale(ip_scale * t)
        else:
            pipe_ref.set_ip_adapter_scale(ip_scale)
        return cbk_kwargs

    out_paths = []
    for i in range(num_images):
        # _scale_sweep used a CONSTANT seed across views — keeps the same
        # subject identity. Only vary across multiple back candidates.
        gen = torch.Generator('cuda').manual_seed(seed if num_images == 1 else seed + i)
        # Start with IP off so the schedule callback drives it.
        pipe.set_ip_adapter_scale(0.0)
        img = pipe(
            prompt=prompt,
            negative_prompt=neg,
            ip_adapter_image=ref_img,
            num_inference_steps=steps,
            guidance_scale=7.0,
            generator=gen,
            height=1024, width=1024,
            callback_on_step_end=_ip_schedule_cb,
        ).images[0]
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
              '[prompt_hint] [num_images]')
        sys.exit(1)
    front = sys.argv[1]
    out = sys.argv[2]
    hint = sys.argv[3] if len(sys.argv) > 3 else ''
    n = int(sys.argv[4]) if len(sys.argv) > 4 else 1
    name_suffix = sys.argv[5] if len(sys.argv) > 5 else ''
    paths = generate_back(front, out, hint, n, name_suffix=name_suffix)
    # Print marker for main.js to parse
    for p in paths:
        print(f'BACK_VIEW_PATH: {p}', flush=True)
