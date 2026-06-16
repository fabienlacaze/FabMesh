"""Auto-inpaint — CLIPSeg segmentation + SDXL inpainting.

Direct port of `scripts/local_inpaint_bridge.py` (the script the desktop
SDXL server calls when the user clicks "Auto Inpaint"). Two-stage :
  1. CLIPSeg detects the area matching `target_text` (e.g. "hat",
     "background") and produces a soft mask.
  2. SDXL Inpainting paints `prompt` (or "remove" if empty) onto that
     mask, preserving the rest of the image.

Models :
  - CIDAS/clipseg-rd64-refined  (~450 MB, Apache 2.0)
  - diffusers/stable-diffusion-xl-1.0-inpainting-0.1  (~6 GB, OpenRAIL++)

Both are lazy-loaded by MyFabmeshBackview on first call (cached for
subsequent calls) so cold start isn't penalised when auto_inpaint
isn't used.
"""
import io
import numpy as np
from PIL import Image, ImageFilter
import torch


def _segment(seg_processor, seg_model, image: Image.Image, target_text: str,
             work_w: int, work_h: int, dilate: int) -> Image.Image:
    """CLIPSeg → soft mask, then threshold + dilate + blur (same recipe
    as desktop local_inpaint_bridge.py:33-75)."""
    inputs = seg_processor(text=[target_text], images=[image],
                           padding=True, return_tensors='pt')
    inputs = {k: v.to('cuda') for k, v in inputs.items()}
    with torch.no_grad():
        out = seg_model(**inputs)
    mask = torch.sigmoid(out.logits).squeeze().cpu().numpy()
    mask_img = Image.fromarray((mask * 255).astype(np.uint8)).resize(
        (work_w, work_h), Image.LANCZOS)
    arr = np.array(mask_img)
    binary = (arr > 60).astype(np.uint8) * 255   # assouplir (was 100): detect fainter CLIPSeg responses
    m = Image.fromarray(binary, mode='L')
    if dilate > 0:
        m = m.filter(ImageFilter.MaxFilter(dilate * 2 + 1))
    return m.filter(ImageFilter.GaussianBlur(3))


def generate(
    seg_processor,                # CLIPSegProcessor
    seg_model,                    # CLIPSegForImageSegmentation on cuda
    inpaint_pipe,                 # StableDiffusionXLInpaintPipeline on cuda
    source_img: Image.Image,
    target_text: str,
    prompt: str = '',
    dilate: int = 15,
    max_dim: int = 1024,
) -> Image.Image:
    """End-to-end auto-inpaint. Caller owns the lazy-loaded models so
    repeated calls reuse them. Raises ValueError if the segmentation
    can't find target_text (same as desktop "Mask empty" error)."""
    img = source_img.convert('RGB')
    orig_w, orig_h = img.size

    # Down-scale for VRAM hygiene (desktop uses max 1024 long side).
    if max(orig_w, orig_h) > max_dim:
        if orig_w > orig_h:
            work_w, work_h = max_dim, int(orig_h * max_dim / orig_w)
        else:
            work_h, work_w = max_dim, int(orig_w * max_dim / orig_h)
    else:
        work_w, work_h = orig_w, orig_h
    # SDXL needs both dims % 8.
    work_w = (work_w // 8) * 8
    work_h = (work_h // 8) * 8
    img_work = img.resize((work_w, work_h), Image.LANCZOS)

    mask = _segment(seg_processor, seg_model, img_work, target_text,
                    work_w, work_h, dilate)
    coverage = (np.array(mask) > 128).mean() * 100
    print(f'[auto-inpaint] mask covers {coverage:.1f}% '
          f'(target="{target_text[:60]}")', flush=True)
    if coverage < 0.2:
        raise ValueError(f'mask empty — "{target_text}" not found in image')

    # Detect "remove" intent — same heuristic as desktop.
    p = (prompt or '').strip()
    is_removal = p.lower() in ('', 'remove', 'delete', 'none', 'nothing', 'empty', 'gone')
    if is_removal:
        final_prompt = ('solid plain wall, flat continuous surface, smooth '
                        'uniform facade, seamless background, empty space, '
                        'no door, no opening')
        negative = (f'{target_text}, door, opening, hole, gap, window, frame, '
                    'jamb, panel, object, furniture, item, duplicate, deformed, '
                    'blurry, distorted, artifact')
    else:
        final_prompt = p
        negative = f'blurry, distorted, duplicate, {target_text}'
    _strength = 0.85 if is_removal else 0.99

    result = inpaint_pipe(
        prompt=final_prompt,
        negative_prompt=negative,
        image=img_work,
        mask_image=mask,
        num_inference_steps=40,
        guidance_scale=8.5,
        strength=_strength,
        height=work_h, width=work_w,
    ).images[0]

    if (work_w, work_h) != (orig_w, orig_h):
        result = result.resize((orig_w, orig_h), Image.LANCZOS)
    return result
