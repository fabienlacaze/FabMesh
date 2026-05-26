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
import re
import numpy as np
from PIL import Image, ImageFilter


# Concept-specific boosters — SDXL Inpaint v1.0 is weak on bare nouns
# for distinctive objects. A bare "bazooka" gets generated as a tube
# or pipe. Adding concept-specific synonyms + visual descriptors
# disambiguates ("M72 LAW", "shoulder-fired rocket launcher", etc.).
# Keys are matched case-insensitively as substrings in the user's
# stripped noun phrase.
_CONCEPT_BOOSTERS = {
    'bazooka': 'M1 bazooka shoulder-fired rocket launcher, large green metal tube, military weapon, tactical hardware',
    'rocket launcher': 'M72 LAW shoulder-fired rocket launcher, large tube weapon, military tactical hardware',
    'sword': 'large medieval sword, sharp steel blade, leather-wrapped hilt, fantasy weapon',
    'shield': 'large round battle shield, embossed metal, leather straps, fantasy armor',
    'gun': 'realistic firearm, metallic, detailed mechanism',
    'rifle': 'tactical assault rifle, military firearm, detailed scope and stock',
    'helmet': 'fitted protective helmet, metal alloy, articulated visor, fantasy armor',
    'flower': 'large blooming flower, vibrant petals, garden quality, botanical',
    'crown': 'ornate royal crown, gold inlay, jewels, fantasy regalia',
    'hat':   'fitted hat, recognizable headwear',
    'cape':  'flowing fabric cape, draped, ornate trim',
    'wings': 'large feathered wings spread wide, anatomically integrated',
    'dragon': 'majestic dragon, scaled, large wings',
}


def _boost(obj: str) -> str:
    low = obj.lower()
    for key, repl in _CONCEPT_BOOSTERS.items():
        if key in low:
            return f'{repl}, in place of "{obj}"'
    return obj


def _enrich_prompt(raw: str) -> tuple[str, str]:
    """Light prompt cleanup — match the desktop's behaviour as closely
    as possible (it just uses the raw prompt), with three small
    exceptions where a literal-instruction prompt would actively
    mislead SDXL Inpaint:

      - "add a/an X" / "put a/an X" → keep just "X" (otherwise the
        word "add" gets diffused as a concept)
      - "remove X" / "delete X" → "continuation of the surrounding
        area, no X" (the empty-mask intent)
      - concept boosters (_CONCEPT_BOOSTERS) for a handful of nouns
        SDXL Inpaint v1.0 is known to render as generic tubes
        (bazooka, rocket launcher, sword, …)

    Anything else passes through verbatim. The desktop audit
    (sdxl_server.py) confirmed that piling on "highly detailed,
    photorealistic, masterpiece, 8k, …" tokens actively HURTS quality
    on SDXL Inpaint by saturating the prompt budget — the model
    splits its attention across keywords instead of focusing on the
    subject.

    Returns (positive_prompt, negative_prompt).
    """
    p = (raw or '').strip()
    if not p:
        return ('continuation of the surrounding area, seamless',
                'object, item, blurry, distorted')

    low = p.lower()
    add_m = re.match(r'^(?:add|put|place|insert|paint|draw)\s+(?:a|an|the|some)?\s*(.+)$',
                     low, flags=re.IGNORECASE)
    rem_m = re.match(r'^(?:remove|delete|erase|hide|clear)\s+(?:the|a|an)?\s*(.+)$',
                     low, flags=re.IGNORECASE)

    if rem_m:
        target = rem_m.group(1).strip()
        return (
            f'continuation of the surrounding area, same background, '
            f'no {target}, seamless',
            f'{target}, any object, duplicate, artifact, blurry, distorted'
        )

    obj = add_m.group(1).strip() if add_m else p
    boosted = _boost(obj)
    # Minimal positive prompt — closer to the desktop's "use the raw
    # prompt" approach. We only add the booster for known-weak nouns
    # and a tiny detail nudge.
    positive = f'{boosted}, detailed, photorealistic'
    negative = 'blurry, distorted, low quality, deformed, watermark, text'
    return (positive, negative)


def _mask_bbox(msk: Image.Image, threshold: int = 30):
    """Return (x0, y0, x1, y1) of the painted region, or None if empty."""
    arr = np.array(msk)
    if arr.ndim == 3:
        arr = arr[..., 0]
    ys, xs = np.where(arr > threshold)
    if len(ys) == 0:
        return None
    return (int(xs.min()), int(ys.min()),
            int(xs.max()) + 1, int(ys.max()) + 1)


def generate(
    inpaint_pipe,
    source_img: Image.Image,
    mask_img: Image.Image,
    prompt: str,
    max_dim: int = 1024,
    sdxl_native: int = 1024,
) -> Image.Image:
    """SDXL Inpaint with caller-provided mask, using the "inpaint only
    masked" technique (a.k.a. crop-inpaint-paste):

      1. find the bbox of the painted region,
      2. expand it by 30% padding,
      3. crop image + mask to that bbox,
      4. resize the crop to SDXL native (1024²),
      5. SDXL Inpaint at full resolution on the crop — the model sees
         the mask filling most of its working area, so the object it
         paints scales naturally to fit (no "tiny bazooka swallowed
         by 1024²" failure mode),
      6. resize the result back, paste into the original image,
      7. composite-back using the original mask so untouched pixels
         stay byte-identical.

    Falls back to the whole-image path if the mask is huge (>40% of the
    image area) or empty.
    """
    src = source_img.convert('RGB')
    msk = mask_img.convert('L')

    orig_w, orig_h = src.size
    if msk.size != (orig_w, orig_h):
        msk = msk.resize((orig_w, orig_h), Image.LANCZOS)

    pos_prompt, neg_prompt = _enrich_prompt(prompt)

    bbox = _mask_bbox(msk)
    if bbox is None:
        print('[mask-inpaint] empty mask — passthrough', flush=True)
        return src

    bx0, by0, bx1, by1 = bbox
    bw, bh = bx1 - bx0, by1 - by0
    mask_frac = (bw * bh) / float(orig_w * orig_h)
    print(f'[mask-inpaint] mask bbox={bbox} frac={mask_frac:.3f} '
          f'enriched="{pos_prompt[:100]}..."', flush=True)

    # If mask is very large (>40% of the image), the crop path
    # degenerates to "almost the whole image". Use the global path
    # instead — less risk of edge artefacts.
    use_global = mask_frac > 0.40

    if not use_global:
        # Expand bbox by 30% padding, clamp to image bounds. Make it
        # square so SDXL gets a 1:1 aspect ratio.
        cx = (bx0 + bx1) / 2
        cy = (by0 + by1) / 2
        side = max(bw, bh) * 1.6  # 30% padding on each side
        # Minimum crop side — 256 px in the source coord system so the
        # surrounding context survives the resize-to-1024.
        side = max(side, max(orig_w, orig_h) * 0.20)
        side = min(side, min(orig_w, orig_h))  # don't exceed image
        cx0 = max(0, int(cx - side / 2))
        cy0 = max(0, int(cy - side / 2))
        cx1 = min(orig_w, cx0 + int(side))
        cy1 = min(orig_h, cy0 + int(side))
        # Re-anchor if we clipped against an edge
        if cx1 - cx0 < int(side): cx0 = max(0, cx1 - int(side))
        if cy1 - cy0 < int(side): cy0 = max(0, cy1 - int(side))

        crop_img = src.crop((cx0, cy0, cx1, cy1))
        crop_msk = msk.crop((cx0, cy0, cx1, cy1))
        cw, ch = crop_img.size

        # Up-scale crop to SDXL native (typically 1024²).
        work = (sdxl_native // 8) * 8
        crop_img_w = crop_img.resize((work, work), Image.LANCZOS)
        crop_msk_w = crop_msk.resize((work, work), Image.LANCZOS) \
                              .filter(ImageFilter.GaussianBlur(4))

        result_w = inpaint_pipe(
            prompt=pos_prompt,
            negative_prompt=neg_prompt,
            image=crop_img_w,
            mask_image=crop_msk_w,
            num_inference_steps=40,
            guidance_scale=8.5,
            strength=0.99,
            height=work, width=work,
        ).images[0]

        # Down-scale crop result back to its original crop size, then
        # paste into a copy of the source.
        result_crop = result_w.resize((cw, ch), Image.LANCZOS)
        composed = src.copy()
        composed.paste(result_crop, (cx0, cy0))

        # Composite-back using the FULL-resolution painted mask, so
        # only the user-painted pixels actually change (the area we
        # cropped but didn't paint is preserved). Slight blur on the
        # final mask for seamless blending.
        msk_full = msk.filter(ImageFilter.GaussianBlur(3))
        src_arr = np.array(src, dtype=np.float32)
        new_arr = np.array(composed, dtype=np.float32)
        mask_arr = np.array(msk_full, dtype=np.float32) / 255.0
        if mask_arr.ndim == 2:
            mask_arr = mask_arr[..., None]
        blend = src_arr * (1.0 - mask_arr) + new_arr * mask_arr
        return Image.fromarray(np.clip(blend, 0, 255).astype(np.uint8), 'RGB')

    # ─── Global path (large mask) ──────────────────────────────────
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
    msk_work_soft = msk_work.filter(ImageFilter.GaussianBlur(3))

    result = inpaint_pipe(
        prompt=pos_prompt,
        negative_prompt=neg_prompt,
        image=img_work,
        mask_image=msk_work_soft,
        num_inference_steps=40,
        guidance_scale=8.5,
        strength=0.99,
        height=work_h, width=work_w,
    ).images[0]

    if (work_w, work_h) != (orig_w, orig_h):
        result = result.resize((orig_w, orig_h), Image.LANCZOS)
        msk_full = msk.filter(ImageFilter.GaussianBlur(3))
    else:
        msk_full = msk_work_soft

    src_arr = np.array(src, dtype=np.float32)
    new_arr = np.array(result, dtype=np.float32)
    mask_arr = np.array(msk_full, dtype=np.float32) / 255.0
    if mask_arr.ndim == 2:
        mask_arr = mask_arr[..., None]
    blend = src_arr * (1.0 - mask_arr) + new_arr * mask_arr
    return Image.fromarray(np.clip(blend, 0, 255).astype(np.uint8), 'RGB')
