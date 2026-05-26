"""Image-level face fix — auto-detect face via OpenCV Haar Cascade,
SDXL Inpaint with a "polish face" prompt.

Different from the mesh-level face_fix (_face_fix.py) which works on a
GLB texture atlas. Here we operate on a flat 2D image (e.g. the front
ref before mesh generation) to improve facial detail before TRELLIS-2
sees it, OR as a post-edit on an already-generated image.

Detection: same Haar Cascade as the desktop face_inpaint_atlas.py (BSD,
bundled with opencv). Inpaint: reuses _ai_inpaint_pipe lazy-loaded by
the MyFabmeshBackview class (CIDAS/clipseg-... + diffusers SDXL
inpainting model). We don't go through CLIPSeg for face_fix — the Haar
bbox is already tight + we explicitly want to keep eyes, mouth, etc.
"""
import numpy as np
from PIL import Image, ImageDraw, ImageFilter


DEFAULT_PROMPT = (
    'detailed realistic face, sharp natural eyes, photorealistic skin, '
    'symmetrical features, soft lighting, ultra detailed, 8k, masterpiece'
)
NEG = (
    'deformed, asymmetric, creepy, blurry, low quality, '
    'extra eyes, missing features, distorted, watermark, '
    'cartoon, plastic, doll face, uncanny valley'
)


def _detect_face(img: Image.Image, expand: float = 0.30):
    """Return (x0, y0, x1, y1) of the biggest face in the image, or None.
    Verbatim copy of the bbox logic in modal_app/_face_fix.py:detect_face_bbox
    so atlas and image face-fix produce consistent crops."""
    try:
        import cv2
    except Exception as e:
        print(f'[face-fix-img] opencv import failed: {e}', flush=True)
        return None
    cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
    cascade = cv2.CascadeClassifier(cascade_path)
    arr = np.array(img.convert('RGB'))
    gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
    faces = cascade.detectMultiScale(
        gray, scaleFactor=1.1, minNeighbors=3, minSize=(50, 50))
    if len(faces) == 0:
        return None
    x, y, fw, fh = max(faces, key=lambda r: r[2] * r[3])
    x0, y0, x1, y1 = x, y, x + fw, y + fh
    w, h = img.size
    mw = (x1 - x0) * expand
    mh = (y1 - y0) * expand
    x0 = max(0, int(x0 - mw))
    y0 = max(0, int(y0 - mh))
    x1 = min(w, int(x1 + mw))
    y1 = min(h, int(y1 + mh))
    return (x0, y0, x1, y1)


def generate(
    inpaint_pipe,                 # StableDiffusionXLInpaintPipeline (lazy-loaded on parent class)
    source_img: Image.Image,
    prompt: str = DEFAULT_PROMPT,
    strength: float = 0.45,
    max_dim: int = 1024,
) -> Image.Image:
    """Detect face → SDXL Inpaint that bbox → composite back into the
    original-resolution image so non-face pixels stay byte-identical.
    Raises ValueError when no face is detected (caller refunds credits)."""
    img = source_img.convert('RGB')
    orig_w, orig_h = img.size

    bbox = _detect_face(img)
    if bbox is None:
        raise ValueError('no face detected in image')
    print(f'[face-fix-img] face bbox = {bbox}', flush=True)

    # Down-scale to SDXL native res for inpaint, then up-scale back.
    if max(orig_w, orig_h) > max_dim:
        if orig_w > orig_h:
            work_w, work_h = max_dim, int(orig_h * max_dim / orig_w)
        else:
            work_h, work_w = max_dim, int(orig_w * max_dim / orig_h)
    else:
        work_w, work_h = orig_w, orig_h
    work_w = (work_w // 8) * 8
    work_h = (work_h // 8) * 8
    img_work = img.resize((work_w, work_h), Image.LANCZOS)

    # Rescale bbox to working size.
    sx = work_w / orig_w
    sy = work_h / orig_h
    bx0 = int(bbox[0] * sx); by0 = int(bbox[1] * sy)
    bx1 = int(bbox[2] * sx); by1 = int(bbox[3] * sy)

    # Soft white mask over the face bbox.
    mask = Image.new('L', (work_w, work_h), 0)
    ImageDraw.Draw(mask).rectangle([bx0, by0, bx1, by1], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(15))

    result = inpaint_pipe(
        prompt=prompt,
        negative_prompt=NEG,
        image=img_work,
        mask_image=mask,
        num_inference_steps=30,
        guidance_scale=7.5,
        strength=float(strength),
        height=work_h, width=work_w,
    ).images[0]

    if (work_w, work_h) != (orig_w, orig_h):
        result = result.resize((orig_w, orig_h), Image.LANCZOS)

    # Composite — only overwrite inside the mask, copy the rest from the
    # source so pixels outside the face stay pixel-perfect identical.
    orig_arr = np.array(img, dtype=np.float32)
    new_arr  = np.array(result, dtype=np.float32)
    mask_full = np.array(mask.resize((orig_w, orig_h), Image.LANCZOS),
                         dtype=np.float32) / 255.0
    if mask_full.ndim == 2:
        mask_full = mask_full[..., None]
    blend = orig_arr * (1.0 - mask_full) + new_arr * mask_full
    return Image.fromarray(np.clip(blend, 0, 255).astype(np.uint8), 'RGB')
