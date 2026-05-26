"""Manual mask inpaint — user-supplied PNG mask + SDXL Inpainting.

Direct port of the desktop `/mask_inpaint` SDXL server endpoint (called
by main.js:2790 `mask-inpaint` IPC). The user paints the mask in the
renderer's Draw Mask modal; the frontend sends image + mask data URLs
to the Worker, which forwards them here.

Different from _auto_inpaint.py (no CLIPSeg — mask is given explicitly).

Includes a manual composite-back step so pixels OUTSIDE the painted
mask stay byte-identical with the source. Without it, SDXL Inpaint
also re-VAE-encodes the un-masked region and you get a slightly
different face / outfit even if you only painted a small mask in one
corner (user report: "add a bazooka on the right shoulder" redrew
the entire orc with a bald head).
"""
import numpy as np
from PIL import Image, ImageFilter


def generate(
    inpaint_pipe,
    source_img: Image.Image,
    mask_img: Image.Image,
    prompt: str,
    max_dim: int = 1024,
) -> Image.Image:
    """SDXL Inpaint with the caller-provided mask. White = inpaint,
    black = preserve. Mask is GaussianBlur'd lightly for soft edges
    (mirrors the desktop UX where painted strokes feather naturally)."""
    src = source_img.convert('RGB')
    msk = mask_img.convert('L')

    orig_w, orig_h = src.size
    # Down-scale to SDXL native if needed; both image and mask must
    # match dimensions and be %8-aligned for the inpaint UNet.
    if max(orig_w, orig_h) > max_dim:
        if orig_w > orig_h:
            work_w, work_h = max_dim, int(orig_h * max_dim / orig_w)
        else:
            work_h, work_w = max_dim, int(orig_w * max_dim / orig_h)
    else:
        work_w, work_h = orig_w, orig_h
    work_w = (work_w // 8) * 8
    work_h = (work_h // 8) * 8

    img_work = src.resize((work_w, work_h), Image.LANCZOS)
    msk_work = msk.resize((work_w, work_h), Image.LANCZOS)
    # Light blur for soft edges so the composite blends. Keep small —
    # too much blur and the user's painted boundary becomes loose.
    msk_work_soft = msk_work.filter(ImageFilter.GaussianBlur(3))

    result = inpaint_pipe(
        prompt=prompt,
        negative_prompt='blurry, distorted, duplicate, artifact',
        image=img_work,
        mask_image=msk_work_soft,
        num_inference_steps=40,
        guidance_scale=8.5,
        strength=0.99,
        height=work_h, width=work_w,
    ).images[0]

    # Upscale result + mask back to original resolution.
    if (work_w, work_h) != (orig_w, orig_h):
        result = result.resize((orig_w, orig_h), Image.LANCZOS)
        msk_full = msk.resize((orig_w, orig_h), Image.LANCZOS).filter(ImageFilter.GaussianBlur(3))
    else:
        msk_full = msk_work_soft

    # Manual composite: keep source pixels OUTSIDE the painted mask,
    # use SDXL output INSIDE the mask. This guarantees the un-masked
    # area is byte-identical to the source (no face drift, no
    # accidental redrawing of the rest of the image).
    src_arr = np.array(src, dtype=np.float32)
    new_arr = np.array(result, dtype=np.float32)
    mask_arr = np.array(msk_full, dtype=np.float32) / 255.0
    if mask_arr.ndim == 2:
        mask_arr = mask_arr[..., None]
    blend = src_arr * (1.0 - mask_arr) + new_arr * mask_arr
    return Image.fromarray(np.clip(blend, 0, 255).astype(np.uint8), 'RGB')
