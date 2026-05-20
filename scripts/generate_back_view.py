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

    # BLIP-1 single-caption mode. Multi-aspect (3 questions) was tested
    # 2026-05-20 and produced WORSE results — the longer "wearing X on
    # top, Y on bottom, Z hair" suffix drowned the "back view" cue and
    # ControlNet OpenPose, and the model regressed to a front pose.
    # Single caption stays the sweet spot: short, dominant garment
    # words ("denim jacket", "white pants") are enough to anchor SDXL.
    # BLIP-1 (Salesforce/blip-image-captioning-large) is pure BSD 3-Clause
    # — commercial-safe (NOT BLIP-2 which uses OPT, non-commercial).
    outfit_desc = ''
    try:
        from transformers import BlipProcessor, BlipForConditionalGeneration
        print('[back-view] BLIP-1 single-caption (outfit anchor)...', flush=True)
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
        # BLIP-1 often appends scene-context noise ("is posing for a
        # picture", "stands in a studio", "with arms out", etc) that
        # dilutes the garment signal in the SDXL prompt. Strip the most
        # common patterns and cut everything after the first verb of
        # being / posing.
        import re as _re_blip
        for noise in [
            r'\s+is posing for a picture\b.*$',
            r'\s+is posing\b.*$',
            r'\s+stands?\b.*$',
            r'\s+standing\b.*$',
            r'\s+poses?\b.*$',
            r'\s+posing\b.*$',
            r'\s+with (her|his|their) arms?\b.*$',
            r'\s+with arms?\b.*$',
            r'\s+with hands?\b.*$',
            r'\s+holds?\b.*$',
            r'\s+holding\b.*$',
            r'\s+sits?\b.*$',
            r'\s+sitting\b.*$',
            r'\s+walks?\b.*$',
            r'\s+walking\b.*$',
        ]:
            outfit_desc = _re_blip.sub(noise, '', outfit_desc,
                                       flags=_re_blip.IGNORECASE).strip(' ,.')
        print(f'[back-view] BLIP outfit ({time.time()-_t_blip:.1f}s): "{outfit_desc}"', flush=True)
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

    # MULTI-SEED with auto-pick. Generate N_CANDIDATES back-views with
    # different seeds, then score each by COLOR HISTOGRAM SIMILARITY
    # with the mirrored front in the lower-body region (where the
    # garment is most directly visible from behind). Keep the best,
    # discard the rest. This dramatically reduces seed-roulette without
    # asking the user to A/B-pick.
    import numpy as _np
    n_candidates = int(os.environ.get('FABMESH_BACK_N_CANDIDATES', '4'))

    def _outfit_color_score(back_img, front_mirror):
        """Color-histogram similarity between back and mirrored front,
        restricted to the lower body (40%-90% of the canvas height).
        Returns a [0,1] score, higher = closer color match."""
        a = _np.asarray(back_img.convert('RGB')).astype(_np.float32)
        b = _np.asarray(front_mirror.convert('RGB')).astype(_np.float32)
        h = a.shape[0]
        y0 = int(h * 0.40); y1 = int(h * 0.90)
        a_crop = a[y0:y1].reshape(-1, 3)
        b_crop = b[y0:y1].reshape(-1, 3)
        # Histograms in 16 bins per channel
        a_hist = _np.stack([_np.histogram(a_crop[:, c], 16, (0, 256))[0]
                             for c in range(3)]).astype(_np.float32)
        b_hist = _np.stack([_np.histogram(b_crop[:, c], 16, (0, 256))[0]
                             for c in range(3)]).astype(_np.float32)
        a_hist /= (a_hist.sum(1, keepdims=True) + 1e-6)
        b_hist /= (b_hist.sum(1, keepdims=True) + 1e-6)
        return float((_np.minimum(a_hist, b_hist).sum() / 3.0))

    front_mirror = ref_img.transpose(Image.FLIP_LEFT_RIGHT)

    out_paths = []
    for i in range(num_images):
        candidates = []
        for k in range(n_candidates):
            cand_seed = seed + i * 1000 + k * 137
            gen = torch.Generator('cuda').manual_seed(cand_seed)
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
            score = _outfit_color_score(img, front_mirror)
            print(f'[back-view] candidate {k+1}/{n_candidates} seed={cand_seed} '
                  f'color_match={score:.3f} ({time.time()-t0:.1f}s)', flush=True)
            candidates.append((score, img, cand_seed))

        candidates.sort(key=lambda t: -t[0])
        best_score, best_img, best_seed = candidates[0]
        print(f'[back-view] keeping best: seed={best_seed} '
              f'color_match={best_score:.3f}', flush=True)

        try:
            from generate_front_tpose import remove_bg_and_center
            best_img = remove_bg_and_center(best_img, size=1024, target_height_frac=0.92)
            print(f'[back-view] post-processed: remove_bg + center @ 92%', flush=True)
        except Exception as _ppe:
            print(f'[back-view] post-process skipped: {_ppe}', flush=True)
        out_path = os.path.join(out_dir, f'back{suffix}_{_start_idx + i}.png')
        best_img.save(out_path)
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
