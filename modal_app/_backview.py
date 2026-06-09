"""Back-view generation — cloud version.

Mirrors `scripts/generate_back_view.py:generate_back()` but rewritten
as a pure function: the diffusers pipeline, Florence-2 caption model
and skeleton image are passed in. The pipe is expected to be a
StableDiffusionXLControlNetPipeline already configured with:
  - controlnet = xinsir/controlnet-openpose-sdxl-1.0
  - image_encoder = h94/IP-Adapter image_encoder
  - load_ip_adapter('h94/IP-Adapter', 'sdxl_models',
                    'ip-adapter-plus_sdxl_vit-h.safetensors') called

The desktop script's CLI + manifest + multi-seed scoring + post-
process (remove_bg_and_center) parts are dropped — they're not needed
for the cloud API which returns ONE best image as PNG bytes. We keep
the multi-seed scoring because it's what makes back-views consistent.

Models snapshot footprint (loaded ONCE in @modal.enter(snap=True)):
  - RealVisXL V4 base       ~7 GB fp16
  - ControlNet OpenPose SDXL ~5 GB fp16
  - IP-Adapter Plus weights ~1 GB
  - CLIP image encoder      ~0.7 GB
  - Florence-2 large        ~1.5 GB
  Total                     ~15 GB CPU memory
"""
import io
import os
import re
import time
import numpy as np
import torch
from PIL import Image, ImageDraw


# Pinned Florence-2 revision — same one the desktop script audited.
# Without pinning, a hijacked microsoft/Florence-2-large repo could push
# malicious code via trust_remote_code on next load.
FLORENCE2_REVISION = '21a599d414c4d928c9032694c424fb94458e3594'


def caption_outfit(florence_proc, florence_model, ref_img) -> str:
    """Florence-2 detailed caption → outfit/hair description.
    Strips face/framing noise so SDXL doesn't pull toward 'front-facing'.
    Same regex stripping as the desktop script."""
    task = '<MORE_DETAILED_CAPTION>'
    inputs = florence_proc(text=task, images=ref_img, return_tensors='pt')
    inputs = {k: v.to('cuda') for k, v in inputs.items()}
    inputs['pixel_values'] = inputs['pixel_values'].to(torch.float16)
    with torch.no_grad():
        out = florence_model.generate(
            input_ids=inputs['input_ids'],
            pixel_values=inputs['pixel_values'],
            max_new_tokens=200, num_beams=3,
            use_cache=False,
        )
    generated = florence_proc.batch_decode(out, skip_special_tokens=False)[0]
    parsed = florence_proc.post_process_generation(
        generated, task=task, image_size=(ref_img.width, ref_img.height))
    full_caption = (parsed.get(task) or '').strip()

    outfit_desc = full_caption
    for noise in [
        r'\b(she|he|they) (is|are) (standing|posing|holding|sitting|walking)[^.]*\.',
        r'\b(she|he|they) has? a [^.]*expression[^.]*\.',
        r'\b(she|he|they) is looking [^.]*\.',
        r'\b(the )?background (is|appears)[^.]*\.',
        r'\b(the )?image (shows|depicts|is)[^.]*\.',
        r'\bthe (overall )?(color|light(ing)?|composition|atmosphere|mood)[^.]*\.',
        r'\bin the (background|foreground)[^.]*\.',
        r'\bstudio lighting[^.]*\.',
        r'\bplain (white|grey|gray) background[^.]*\.',
        r'\bexpression on (her|his|their) face\b',
        r'\b(serious|happy|sad|smiling|calm|neutral) expression\b',
        r'\blooking at the camera\b',
        r'\bfacing the camera\b',
        r'\bdirectly at the (camera|viewer)\b',
        r'\bon (her|his|their) face\b',
        r'\b(her|his|their) face\b',
        r'\b(her|his|their) (mouth|eyes|nose)\b',
    ]:
        outfit_desc = re.sub(noise, '', outfit_desc, flags=re.IGNORECASE)
    outfit_desc = re.sub(r'\s+', ' ', outfit_desc).strip(' .,;')
    if len(outfit_desc) > 200:
        outfit_desc = outfit_desc[:200].rsplit(' ', 1)[0] + '...'
    return outfit_desc


def strip_front_tokens(hint: str) -> str:
    """The asset-style template prepends 'strict front view, facing
    camera, symmetric' which contradicts 'back view' and wins because
    it comes first. Strip these tokens before re-using the hint."""
    out = hint or ''
    for pat in [
        r'strict front view', r'front view', r'facing camera', r'symmetric',
        r'three[- ]?quarter view', r'three[- ]?fourth view',
    ]:
        out = re.sub(pat, '', out, flags=re.IGNORECASE)
    out = re.sub(r',\s*,', ',', out)
    return re.sub(r'\s+', ' ', out).strip(' ,')


def build_back_prompts(hint_clean: str, outfit_desc: str) -> tuple[str, str]:
    base = hint_clean if hint_clean else 'a character'
    outfit_phrase = (
        f', wearing {outfit_desc}, same outfit, same garments'
        if outfit_desc else ''
    )
    prompt = (
        f'{base}{outfit_phrase}, back view, from behind, back of head visible, '
        f'turned away from camera, full body centered, plain grey '
        f'background, studio lighting, sharp focus, ultra detailed, '
        f'8k, masterpiece'
    )
    neg = (
        'blurry, deformed, extra limbs, bad anatomy, different person, '
        'front view, facing camera, face visible, frontal view, '
        'eyes visible, looking at camera, mouth visible, ears in front, '
        'nose visible, breast visible, '
        'chest pockets visible from behind, buttons on the back, '
        'shirt buttons visible from behind, button placket on the back, '
        'front zipper on the back, breast pocket on the back, '
        'front decorations on the back, logo on the back, label on the back, '
        'different clothes, different outfit, different garment, '
        'bare back, exposed back, halter top, backless top, tank top, '
        'sleeveless when source has sleeves, missing sleeves, '
        'open back, low back, cropped top when source is full top, '
        'watermark, text, duplicate, multiple people, '
        'cropped, low quality, zoomed in, close-up, half body, feet out of frame'
    )
    return prompt, neg


def mask_face_region(ref_img: Image.Image) -> Image.Image:
    """Soft-mask the top 18-30% of the IP-Adapter reference image so
    the adapter doesn't propagate front-facing face features into the
    back-of-head region. Same gradient mask as the desktop script."""
    out = ref_img.copy()
    _d = ImageDraw.Draw(out)
    h = out.size[1]
    mask_top_full = int(h * 0.18)
    mask_top_fade = int(h * 0.30)
    _d.rectangle([0, 0, out.size[0], mask_top_full], fill=(0, 0, 0))
    arr_ref = np.array(ref_img.convert('RGB')).astype(np.float32)
    arr_masked = np.array(out.convert('RGB')).astype(np.float32)
    for y in range(mask_top_full, mask_top_fade):
        t_fade = (y - mask_top_full) / max(1, mask_top_fade - mask_top_full)
        arr_masked[y] = arr_ref[y] * t_fade
    return Image.fromarray(arr_masked.astype(np.uint8))


def outfit_color_score(back_img: Image.Image, front_mirror: Image.Image) -> float:
    """Color-histogram similarity in the lower body region (40%-90%
    of canvas height). Higher = better outfit match between front and
    back. Used to auto-pick the best of N candidate seeds."""
    a = np.asarray(back_img.convert('RGB')).astype(np.float32)
    b = np.asarray(front_mirror.convert('RGB')).astype(np.float32)
    h = a.shape[0]
    y0 = int(h * 0.40); y1 = int(h * 0.90)
    a_crop = a[y0:y1].reshape(-1, 3)
    b_crop = b[y0:y1].reshape(-1, 3)
    a_hist = np.stack([np.histogram(a_crop[:, c], 16, (0, 256))[0]
                       for c in range(3)]).astype(np.float32)
    b_hist = np.stack([np.histogram(b_crop[:, c], 16, (0, 256))[0]
                       for c in range(3)]).astype(np.float32)
    a_hist /= (a_hist.sum(1, keepdims=True) + 1e-6)
    b_hist /= (b_hist.sum(1, keepdims=True) + 1e-6)
    return float(np.minimum(a_hist, b_hist).sum() / 3.0)


def generate(
    pipe,
    florence_proc, florence_model,
    skel_img: Image.Image,
    front_img: Image.Image,
    prompt_hint: str = '',
    ip_scale: float = 0.65,
    cn_scale: float = 1.0,
    steps: int = 30,
    seed: int = 424242,
    n_candidates: int = 4,
) -> Image.Image:
    """Run back-view generation. The pipe must already have IP-Adapter
    loaded (cloud app.py does that in @enter(snap=False) after the GPU
    is attached). Returns the best of N candidates by outfit color
    match — same picker as the desktop multi-seed flow."""
    hint_clean = strip_front_tokens(prompt_hint)
    outfit_desc = ''
    try:
        outfit_desc = caption_outfit(florence_proc, florence_model, front_img)
    except Exception as e:
        print(f'[backview] Florence-2 skipped: {e}', flush=True)

    prompt, neg = build_back_prompts(hint_clean, outfit_desc)
    print(f'[backview] outfit_anchor="{outfit_desc[:80]}"', flush=True)

    pipe.set_ip_adapter_scale(ip_scale)
    ref_no_face = mask_face_region(front_img)
    front_mirror = front_img.transpose(Image.FLIP_LEFT_RIGHT)

    # Compel long-prompt encoding — bypasses the 77-token CLIP cap so the
    # full anti-doubling + anti-cropping negatives (179 tokens, was 57%
    # truncated per workflow woydvj5w6) reach the U-Net. Encoded ONCE
    # before the loop since (prompt, neg) are seed-independent. Falls
    # back to vanilla pipe() with truncated prompts if Compel fails.
    embeds = None
    try:
        from modal_app._sdxl_prompt_utils import encode_sdxl_long_prompt
        embeds = encode_sdxl_long_prompt(pipe, prompt, neg)
    except Exception as _ce:
        print(f'[backview] Compel fallback ({_ce}); using truncated prompts',
              flush=True)

    candidates = []
    for k in range(n_candidates):
        cand_seed = seed + k * 137
        gen = torch.Generator('cuda').manual_seed(cand_seed)
        t0 = time.time()
        base_kwargs = dict(
            image=skel_img,
            controlnet_conditioning_scale=cn_scale,
            ip_adapter_image=ref_no_face,
            num_inference_steps=int(steps), guidance_scale=7.0,
            height=1024, width=1024,
            generator=gen,
        )
        if embeds is not None:
            try:
                img = pipe(**embeds, **base_kwargs).images[0]
            except Exception as _pe:
                print(f'[backview] embeds call failed ({_pe}); '
                      f'falling back to prompt= path', flush=True)
                embeds = None
                img = pipe(
                    prompt=prompt, negative_prompt=neg, **base_kwargs,
                ).images[0]
        else:
            img = pipe(
                prompt=prompt, negative_prompt=neg, **base_kwargs,
            ).images[0]
        score = outfit_color_score(img, front_mirror)
        print(f'[backview] cand {k+1}/{n_candidates} seed={cand_seed} '
              f'score={score:.3f} ({time.time()-t0:.1f}s)', flush=True)
        candidates.append((score, img))

    candidates.sort(key=lambda t: -t[0])
    best_score, best_img = candidates[0]
    print(f'[backview] best score={best_score:.3f}', flush=True)
    return best_img
