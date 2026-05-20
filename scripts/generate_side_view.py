"""Generate a SIDE VIEW (90° rotation) of the subject.

The transition front → side is gentler than front → back so SDXL should
preserve outfit / hair / silhouette better. Useful as a sanity check
and (later) as an intermediate step for a 3-step pipeline
(front → side → back) where each pair of consecutive views is
locally consistent.

No ControlNet (we don't have a side T-pose OpenPose skeleton). Just
SDXL + IPAdapter on the front + BLIP-1 outfit caption. Profile
poses are well covered in SDXL's training set so the prompt alone
+ identity anchor is enough.

License: RealVisXL (RAIL++-M), IPAdapter (Apache), BLIP-1 (BSD 3-Clause),
rembg (MIT). All commercial-safe.

Usage:
    python generate_side_view.py <front_image> <output_dir>
        [prompt_hint] [num_images] [name_suffix]
"""
import sys
import os
import re
import time
import torch
from PIL import Image


def generate_side(front_image, out_dir, prompt_hint='', num_images=1,
                   ip_scale=0.7, steps=30, seed=424242, name_suffix=''):
    os.makedirs(out_dir, exist_ok=True)
    print(f'[side-view] front={front_image} out={out_dir} '
          f'hint="{prompt_hint}" n={num_images} ip_scale={ip_scale}', flush=True)

    from diffusers import StableDiffusionXLPipeline
    from transformers import CLIPVisionModelWithProjection

    ref_img = Image.open(front_image).convert('RGB')

    # BLIP-1 outfit caption (same as generate_back_view).
    outfit_desc = ''
    try:
        from transformers import BlipProcessor, BlipForConditionalGeneration
        print('[side-view] BLIP-1 captioning outfit...', flush=True)
        _t_blip = time.time()
        proc = BlipProcessor.from_pretrained('Salesforce/blip-image-captioning-large')
        bmodel = BlipForConditionalGeneration.from_pretrained(
            'Salesforce/blip-image-captioning-large', torch_dtype=torch.float16,
        ).to('cuda')
        inputs = proc(ref_img, 'a person wearing', return_tensors='pt').to('cuda', torch.float16)
        with torch.no_grad():
            out = bmodel.generate(**inputs, max_new_tokens=40, num_beams=4)
        outfit_desc = proc.decode(out[0], skip_special_tokens=True).strip()
        for prefix in ['a person wearing', 'arafed', 'arafy']:
            if outfit_desc.lower().startswith(prefix.lower()):
                outfit_desc = outfit_desc[len(prefix):].strip(' .,')
        print(f'[side-view] BLIP outfit ({time.time()-_t_blip:.1f}s): "{outfit_desc}"', flush=True)
        del bmodel, proc
        torch.cuda.empty_cache()
    except Exception as _be:
        print(f'[side-view] BLIP skipped ({_be})', flush=True)

    # Use ControlNet + a back-skeleton (NOT a side-skeleton — we don't
    # have one) plus a strict "side view" prompt + low ip_scale. The
    # ControlNet at least anchors the body silhouette in T-pose so the
    # model doesn't drift into a random pose; the prompt + low IPAdapter
    # let the rotation hopefully reach 90° instead of 0° (a pure SDXL
    # call kept producing fronts at ip_scale=0.7).
    from diffusers import (
        StableDiffusionXLControlNetPipeline as _CtrlPipe,
        ControlNetModel,
    )
    SCRIPTS = os.path.dirname(os.path.abspath(__file__))
    skel_path = os.path.join(SCRIPTS, '_back_tpose_skeleton.png')
    skel_img = Image.open(skel_path).convert('RGB')
    print('[side-view] loading ControlNet OpenPose + RealVisXL + IPAdapter...',
          flush=True)
    controlnet = ControlNetModel.from_pretrained(
        'xinsir/controlnet-openpose-sdxl-1.0', torch_dtype=torch.float16)
    image_encoder = CLIPVisionModelWithProjection.from_pretrained(
        'h94/IP-Adapter', subfolder='models/image_encoder',
        torch_dtype=torch.float16,
    )
    pipe = _CtrlPipe.from_pretrained(
        'SG161222/RealVisXL_V4.0',
        controlnet=controlnet,
        torch_dtype=torch.float16,
        variant='fp16', use_safetensors=True,
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
    # Lower IPAdapter for side (was 0.7 → 0.4) so the prompt's "side view"
    # cue can dominate. Without this the IPAdapter pulled the model back
    # to a front view.
    pipe.set_ip_adapter_scale(0.4)
    pipe.enable_model_cpu_offload()
    print('[side-view] ready', flush=True)

    base = prompt_hint if prompt_hint else 'a character'
    outfit_phrase = (f', wearing {outfit_desc}, same outfit, same garments'
                     if outfit_desc else '')
    prompt = (
        f'{base}{outfit_phrase}, STRICT PROFILE SIDE VIEW, '
        f'photographed from the side, 90 degree rotation, '
        f'looking sideways, ear visible from the side, '
        f'nose pointing to the left, single shoulder profile, '
        f'full body in profile, plain grey background, '
        f'studio lighting, sharp focus, ultra detailed, 8k'
    )
    neg = (
        'front view, back view, facing camera, looking at camera, '
        'three-quarter view, both eyes visible, both shoulders square to camera, '
        'rotated, perspective distortion, blurry, deformed, extra limbs, '
        'bad anatomy, different person, different clothes, different outfit, '
        'watermark, text, duplicate, multiple people, cropped, low quality'
    )

    suffix = f'_{name_suffix}' if name_suffix else ''
    pattern = re.compile(rf'^side{re.escape(suffix)}_(\d+)\.png$')
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
            image=skel_img,
            controlnet_conditioning_scale=0.85,
            ip_adapter_image=ref_img,
            num_inference_steps=steps, guidance_scale=8.5,
            height=1024, width=1024,
            generator=gen,
        ).images[0]
        print(f'[side-view] gen {i}: {time.time()-t0:.1f}s', flush=True)
        try:
            from generate_front_tpose import remove_bg_and_center
            img = remove_bg_and_center(img, size=1024, target_height_frac=0.92)
        except Exception as _ppe:
            print(f'[side-view] post-process skipped: {_ppe}', flush=True)
        out_path = os.path.join(out_dir, f'side{suffix}_{start_idx + i}.png')
        img.save(out_path)
        out_paths.append(out_path)
        print(f'[side-view] saved {out_path}', flush=True)

    return out_paths


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('Usage: generate_side_view.py <front_image> <output_dir> '
              '[prompt_hint] [num_images] [name_suffix]')
        sys.exit(1)
    paths = generate_side(
        sys.argv[1], sys.argv[2],
        sys.argv[3] if len(sys.argv) > 3 else '',
        int(sys.argv[4]) if len(sys.argv) > 4 else 1,
        name_suffix=sys.argv[5] if len(sys.argv) > 5 else '',
    )
    for p in paths:
        print(f'SIDE_VIEW_PATH: {p}', flush=True)
