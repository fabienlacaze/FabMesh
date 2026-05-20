"""Back view via HYBRID approach: mirror-flip front → SDXL img2img with
ControlNet OpenPose back-skeleton, strength tuned so the source colors
and textures bleed through while the pose is rotated 180°.

Why this exists:
- generate_back_view.py (realvis) gives a real back pose but invents
  garments (BLIP-1 caption helps but doesn't perfectly anchor).
- generate_back_view_mirror.py (pure inpaint) is anatomically wrong
  (torso/arms still face camera after mirror flip).
- This script combines the two: the mirrored front is used as
  *img2img base* — SDXL repaints it under ControlNet's back-skeleton
  guidance with strength=0.55 so the colors/textures from the front
  propagate to the back, while the pose flips to a real back view.

License: RealVisXL (RAIL++-M), ControlNet OpenPose xinsir (Apache 2.0),
IPAdapter (Apache 2.0), BLIP-1 (BSD 3-Clause), rembg (MIT). All
commercial-safe.

Usage:
    python generate_back_view_hybrid.py <front_image> <output_dir>
        [prompt_hint] [num_images] [name_suffix] [strength]
"""
import sys
import os
import re
import time
import torch
from PIL import Image


def generate_back_hybrid(front_image, out_dir, prompt_hint='', num_images=1,
                          name_suffix='', strength=0.55,
                          ip_scale=0.55, cn_scale=1.0, steps=35,
                          seed=424242):
    os.makedirs(out_dir, exist_ok=True)
    print(f'[back-hybrid] front={front_image} out={out_dir} '
          f'hint="{prompt_hint}" n={num_images} '
          f'strength={strength} ip_scale={ip_scale} cn_scale={cn_scale}',
          flush=True)

    from diffusers import (
        StableDiffusionXLControlNetImg2ImgPipeline,
        ControlNetModel,
    )
    from transformers import CLIPVisionModelWithProjection

    SCRIPTS = os.path.dirname(os.path.abspath(__file__))

    # Back skeleton (same one used by generate_back_view.py)
    skel_path = os.path.join(SCRIPTS, '_back_tpose_skeleton.png')
    skel_img = Image.open(skel_path).convert('RGB')

    # Load front, mirror horizontally → img2img base
    front = Image.open(front_image).convert('RGB')
    if front.size != (1024, 1024):
        front = front.resize((1024, 1024), Image.LANCZOS)
    mirrored = front.transpose(Image.FLIP_LEFT_RIGHT)
    print(f'[back-hybrid] mirror base ready ({mirrored.size})', flush=True)

    # BLIP-1 outfit caption (commercial-safe, BSD 3-Clause).
    outfit_desc = ''
    try:
        from transformers import BlipProcessor, BlipForConditionalGeneration
        print('[back-hybrid] BLIP-1 outfit caption...', flush=True)
        _t = time.time()
        proc = BlipProcessor.from_pretrained('Salesforce/blip-image-captioning-large')
        bmodel = BlipForConditionalGeneration.from_pretrained(
            'Salesforce/blip-image-captioning-large', torch_dtype=torch.float16,
        ).to('cuda')
        inputs = proc(front, 'a person wearing', return_tensors='pt').to('cuda', torch.float16)
        with torch.no_grad():
            out = bmodel.generate(**inputs, max_new_tokens=40, num_beams=4)
        outfit_desc = proc.decode(out[0], skip_special_tokens=True).strip()
        for pfx in ['a person wearing', 'arafed', 'arafy']:
            if outfit_desc.lower().startswith(pfx.lower()):
                outfit_desc = outfit_desc[len(pfx):].strip(' .,')
        print(f'[back-hybrid] outfit ({time.time()-_t:.1f}s): "{outfit_desc}"',
              flush=True)
        del bmodel, proc
        torch.cuda.empty_cache()
    except Exception as e:
        print(f'[back-hybrid] BLIP skipped ({e})', flush=True)

    print('[back-hybrid] loading ControlNet OpenPose + RealVisXL Img2Img + IPAdapter...',
          flush=True)
    controlnet = ControlNetModel.from_pretrained(
        'xinsir/controlnet-openpose-sdxl-1.0', torch_dtype=torch.float16)
    image_encoder = CLIPVisionModelWithProjection.from_pretrained(
        'h94/IP-Adapter', subfolder='models/image_encoder',
        torch_dtype=torch.float16)
    pipe = StableDiffusionXLControlNetImg2ImgPipeline.from_pretrained(
        'SG161222/RealVisXL_V4.0',
        controlnet=controlnet,
        torch_dtype=torch.float16, variant='fp16', use_safetensors=True,
        image_encoder=image_encoder,
    )
    pipe.unet.to(torch.float16)
    pipe.vae.to(torch.float16)
    pipe.text_encoder.to(torch.float16)
    pipe.text_encoder_2.to(torch.float16)
    pipe.load_ip_adapter(
        'h94/IP-Adapter', subfolder='sdxl_models',
        weight_name='ip-adapter-plus_sdxl_vit-h.safetensors')
    pipe.set_ip_adapter_scale(ip_scale)
    pipe.enable_model_cpu_offload()
    print('[back-hybrid] ready', flush=True)

    base = prompt_hint if prompt_hint else 'a character'
    outfit_phrase = (f', wearing {outfit_desc}, same outfit, same garments'
                     if outfit_desc else '')
    prompt = (
        f'{base}{outfit_phrase}, back view, from behind, back of head, '
        f'turned away from camera, full body, plain grey background, '
        f'studio lighting, sharp focus, ultra detailed, 8k, masterpiece'
    )
    neg = (
        'front view, facing camera, face visible, eyes visible, '
        'looking at camera, mouth visible, three-quarter view, '
        'different person, different clothes, different outfit, '
        'blurry, deformed, extra limbs, bad anatomy, watermark, '
        'cropped, low quality'
    )
    print(f'[back-hybrid] prompt: "{prompt[:200]}..."', flush=True)

    suffix = f'_{name_suffix}' if name_suffix else ''
    pattern = re.compile(rf'^back{re.escape(suffix)}_(\d+)\.png$')
    existing = [-1]
    for f in os.listdir(out_dir):
        m = pattern.match(f)
        if m:
            existing.append(int(m.group(1)))
    start_idx = max(existing) + 1

    out_paths = []
    for i in range(num_images):
        gen = torch.Generator('cuda').manual_seed(
            seed if num_images == 1 else seed + i)
        t0 = time.time()
        img = pipe(
            prompt=prompt, negative_prompt=neg,
            image=mirrored,                # img2img base = mirrored front
            control_image=skel_img,        # ControlNet OpenPose back skeleton
            strength=strength,             # 0.55 = transform pose but keep textures
            controlnet_conditioning_scale=cn_scale,
            ip_adapter_image=front,        # identity anchor on the original front
            num_inference_steps=steps, guidance_scale=7.5,
            height=1024, width=1024,
            generator=gen,
        ).images[0]
        print(f'[back-hybrid] gen {i}: {time.time()-t0:.1f}s', flush=True)
        try:
            from generate_front_tpose import remove_bg_and_center
            img = remove_bg_and_center(img, size=1024, target_height_frac=0.92)
        except Exception as e:
            print(f'[back-hybrid] post-process skipped: {e}', flush=True)
        out_path = os.path.join(out_dir, f'back{suffix}_{start_idx + i}.png')
        img.save(out_path)
        out_paths.append(out_path)
        print(f'[back-hybrid] saved {out_path}', flush=True)

    return out_paths


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('Usage: generate_back_view_hybrid.py <front> <out_dir> '
              '[hint] [n] [suffix] [strength]')
        sys.exit(1)
    paths = generate_back_hybrid(
        sys.argv[1], sys.argv[2],
        sys.argv[3] if len(sys.argv) > 3 else '',
        int(sys.argv[4]) if len(sys.argv) > 4 else 1,
        name_suffix=sys.argv[5] if len(sys.argv) > 5 else '',
        strength=float(sys.argv[6]) if len(sys.argv) > 6 else 0.55,
    )
    for p in paths:
        print(f'BACK_VIEW_PATH: {p}', flush=True)
