"""Manual mask inpaint — user-supplied PNG mask + SDXL Inpainting.

Direct port of the desktop `/mask_inpaint` SDXL server endpoint (called
by main.js:2790 `mask-inpaint` IPC). The user paints the mask in the
renderer's Draw Mask modal; the frontend sends image + mask data URLs
to the Worker, which forwards them here.

Different from _auto_inpaint.py (no CLIPSeg — mask is given explicitly).
"""
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
    msk_work = msk_work.filter(ImageFilter.GaussianBlur(3))

    result = inpaint_pipe(
        prompt=prompt,
        negative_prompt='blurry, distorted, duplicate, artifact',
        image=img_work,
        mask_image=msk_work,
        num_inference_steps=40,
        guidance_scale=8.5,
        strength=0.99,
        height=work_h, width=work_w,
    ).images[0]

    if (work_w, work_h) != (orig_w, orig_h):
        result = result.resize((orig_w, orig_h), Image.LANCZOS)
    return result
