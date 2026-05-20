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
                  ip_scale=0.65, steps=30, seed=424242, name_suffix='',
                  cn_scale=1.0):
    os.makedirs(out_dir, exist_ok=True)
    print(f'[back-view] front={front_image} out={out_dir} hint="{prompt_hint}" '
          f'n={num_images} ip_scale={ip_scale} cn_scale={cn_scale}', flush=True)

    from diffusers import (
        StableDiffusionXLControlNetPipeline,
        ControlNetModel,
        StableDiffusionXLPipeline,
    )
    from transformers import CLIPVisionModelWithProjection

    # Load OpenPose skeleton (T-pose back) — generated once by
    # scripts/_make_back_skeleton.py.
    skel_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              '_back_tpose_skeleton.png')
    if not os.path.exists(skel_path):
        # Fallback: regenerate
        from _make_back_skeleton import make_tpose_back
        make_tpose_back().save(skel_path)
    skel_img = Image.open(skel_path).convert('RGB')
    print(f'[back-view] using ControlNet OpenPose skeleton: {skel_path}',
          flush=True)

    print('[back-view] loading ControlNet OpenPose + RealVisXL + IPAdapter...',
          flush=True)
    image_encoder = CLIPVisionModelWithProjection.from_pretrained(
        'h94/IP-Adapter', subfolder='models/image_encoder',
        torch_dtype=torch.float16)
    controlnet = ControlNetModel.from_pretrained(
        'xinsir/controlnet-openpose-sdxl-1.0',
        torch_dtype=torch.float16,
    )
    pipe = StableDiffusionXLControlNetPipeline.from_pretrained(
        'SG161222/RealVisXL_V4.0',
        controlnet=controlnet,
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

    # BLIP-1 captioning of the front photo to extract the outfit
    # description. Without this, IPAdapter alone soft-anchors style but
    # SDXL invents random garments when re-drawing the back view.
    # NOTE: we use BLIP-1 (Salesforce/blip-image-captioning-large) which
    # is pure BSD 3-Clause — NOT BLIP-2, whose default backbone is OPT
    # (Meta OPT license = NON-commercial, would break FabMesh's
    # commercial-safe rule).
    outfit_desc = ''
    try:
        from transformers import BlipProcessor, BlipForConditionalGeneration
        print('[back-view] BLIP-1 captioning the front for outfit anchor...', flush=True)
        _t_blip = time.time()
        proc = BlipProcessor.from_pretrained('Salesforce/blip-image-captioning-large')
        bmodel = BlipForConditionalGeneration.from_pretrained(
            'Salesforce/blip-image-captioning-large', torch_dtype=torch.float16,
        ).to('cuda')
        # Conditional caption: prefix the prompt so BLIP focuses on
        # clothing rather than the scene at large.
        inputs = proc(ref_img, 'a person wearing', return_tensors='pt').to('cuda', torch.float16)
        with torch.no_grad():
            out = bmodel.generate(**inputs, max_new_tokens=40, num_beams=4)
        outfit_desc = proc.decode(out[0], skip_special_tokens=True).strip()
        # BLIP-1 typically echoes the conditional prefix back in the
        # output. Strip it so we don't get "a person wearing a person
        # wearing ..." downstream.
        for prefix in ['a person wearing', 'arafed', 'arafy']:
            if outfit_desc.lower().startswith(prefix.lower()):
                outfit_desc = outfit_desc[len(prefix):].strip(' .,')
        print(f'[back-view] BLIP outfit ({time.time()-_t_blip:.1f}s): "{outfit_desc}"', flush=True)
        # Free VRAM before SDXL loads
        del bmodel, proc
        torch.cuda.empty_cache()
    except Exception as _be:
        print(f'[back-view] BLIP captioning skipped ({_be}); falling back to hint only',
              flush=True)

    base = hint_clean if hint_clean else 'a character'
    outfit_phrase = (f', wearing {outfit_desc}, same outfit, same garments' if outfit_desc else '')
    prompt = (
        f'{base}{outfit_phrase}, back view, from behind, back of head visible, '
        f'turned away from camera, full body centered, plain grey '
        f'background, studio lighting, sharp focus, ultra detailed, '
        f'8k, masterpiece'
    )
    neg = (
        'blurry, deformed, extra limbs, bad anatomy, different person, '
        # ANTI-FRONT: stop the model from regenerating a front view (the
        # IPAdapter on the front photo strongly pulls in this direction).
        'front view, facing camera, face visible, frontal view, '
        'eyes visible, looking at camera, mouth visible, ears in front, '
        'nose visible, breast visible, buttons visible, shirt buttons, '
        # ANTI-OUTFIT-DRIFT: the back must wear the same garments.
        'different clothes, different outfit, different garment, '
        'bare back, exposed back, halter top, backless top, tank top, '
        'sleeveless when source has sleeves, missing sleeves, '
        'open back, low back, cropped top when source is full top, '
        # NOISE: usual stuff
        'watermark, text, duplicate, multiple people, '
        'cropped, low quality, zoomed in, close-up, half body, feet out of frame'
    )

    # PURE _scale_sweep recipe: constant ip_scale, no schedule.
    # User A/B: PURE 0.75 beats SCHED at every value on fille_afghanne.
    pipe.set_ip_adapter_scale(ip_scale)

    # Find highest existing back_<suffix>_<N>.png so successive
    # 'Regenerate back view' clicks APPEND instead of overwriting.
    # Same pattern as scripts/local_juggernaut_bridge.py (commit febbec5).
    import re as _re_idx
    suffix = f'_{name_suffix}' if name_suffix else ''
    _existing_idx = [-1]
    _pattern = _re_idx.compile(
        rf'^back{_re_idx.escape(suffix)}_(\d+)\.png$'
    )
    for _f in os.listdir(out_dir):
        _m = _pattern.match(_f)
        if _m:
            _existing_idx.append(int(_m.group(1)))
    _start_idx = max(_existing_idx) + 1
    print(f'[back-view] starting at back{suffix}_{_start_idx} '
          f'(existing highest={max(_existing_idx)})', flush=True)

    out_paths = []
    for i in range(num_images):
        gen = torch.Generator('cuda').manual_seed(
            seed if num_images == 1 else seed + i)
        t0 = time.time()
        img = pipe(
            prompt=prompt, negative_prompt=neg,
            image=skel_img,                # ControlNet conditioning
            controlnet_conditioning_scale=cn_scale,
            ip_adapter_image=ref_img,
            num_inference_steps=steps, guidance_scale=7.0,
            height=1024, width=1024,
            generator=gen,
        ).images[0]
        print(f'[back-view] gen {i}: {time.time()-t0:.1f}s', flush=True)
        # Post-process : remove_bg + center on a 1024² canvas so the
        # back ends up at the same proportions as the front-tpose
        # output. Without this, the ControlNet back-skeleton produces a
        # subject that's noticeably zoomed compared to the original front
        # photo (user-reported on humanoid char with T-pose 2026-05-20).
        try:
            from generate_front_tpose import remove_bg_and_center
            img = remove_bg_and_center(img, size=1024, target_height_frac=0.92)
            print(f'[back-view] post-processed: remove_bg + center @ 92%', flush=True)
        except Exception as _ppe:
            print(f'[back-view] post-process skipped: {_ppe}', flush=True)
        out_path = os.path.join(out_dir, f'back{suffix}_{_start_idx + i}.png')
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
