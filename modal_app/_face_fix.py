"""Atlas-level face inpaint — cloud version.

Port of `scripts/face_inpaint_atlas.py` to the cloud, with one
substitution that matters: instead of rendering the mesh from a front
ortho camera (the desktop does this via pyrender/OSMesa, which is
brittle to install on Modal images), we run face detection on the
ORIGINAL front input image that drove TRELLIS-2 in the first place.

Why this is sound:
  TRELLIS-2 + post-processing produce a mesh whose subject is centered
  in the same `[-0.6, 0.6]` ortho window the desktop uses. The face on
  the mesh sits at the same screen-space coordinates as the face in the
  input front image — that's literally what TRELLIS-2 is solving for.
  So bbox(front_img) projected with the same ortho formula lands on the
  same UV triangles as bbox(rendered_mesh).

The actual inpaint (SDXL RealVisXL with mask + prompt) is verbatim. The
mask-projection formula and the composite-back logic are verbatim.

Models : SDXL inpaint via RealVisXL_V4.0 weights (RAIL++-M, the desktop
pipe), OpenCV Haar Cascade (BSD, bundled with opencv-python). Both are
commercial-safe.
"""
import io
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


# Same prompts as the desktop CLI defaults — DO NOT edit lightly: keep
# in lockstep with scripts/face_inpaint_atlas.py to preserve byte-level
# parity for the same input.
DEFAULT_FACE_PROMPT = (
    'detailed realistic face, sharp natural eyes, '
    'photorealistic skin, symmetrical features, soft lighting, '
    'ultra detailed, 8k, masterpiece'
)
FACE_NEG = (
    'deformed, asymmetric, creepy, blurry, low quality, '
    'extra eyes, missing features, distorted, watermark, '
    'cartoon, plastic, doll face, uncanny valley'
)


def detect_face_bbox(front_img: Image.Image, expand: float = 0.30):
    """Return (x0, y0, x1, y1) of the face in the front image, or None.

    Uses OpenCV Haar Cascade — bundled with opencv-python under BSD,
    no extra weight download. Expands the bbox by `expand` (30% by
    default) to include hair / chin / ears (matches desktop)."""
    try:
        import cv2
        cascade_path = (cv2.data.haarcascades
                        + 'haarcascade_frontalface_default.xml')
        cascade = cv2.CascadeClassifier(cascade_path)
        arr = np.array(front_img.convert('RGB'))
        gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
        faces = cascade.detectMultiScale(
            gray, scaleFactor=1.1, minNeighbors=3, minSize=(50, 50))
        if len(faces) == 0:
            return None
        x, y, fw, fh = max(faces, key=lambda r: r[2] * r[3])
        x0, y0, x1, y1 = x, y, x + fw, y + fh
        w, h = front_img.size
        mw = (x1 - x0) * expand
        mh = (y1 - y0) * expand
        x0 = max(0, int(x0 - mw))
        y0 = max(0, int(y0 - mh))
        x1 = min(w, int(x1 + mw))
        y1 = min(h, int(y1 + mh))
        return (x0, y0, x1, y1)
    except Exception as e:
        print(f'[face-fix] opencv face detection failed: {e}', flush=True)
        return None


def fallback_top_bbox(size):
    """Crude fallback: top 30% of image, central 50% horizontally.
    Same as the desktop fallback."""
    w, h = size
    return (int(w * 0.25), 0, int(w * 0.75), int(h * 0.30))


def make_atlas_mask_from_bbox(mesh, bbox, render_size: int,
                              atlas_size: int):
    """Project screen-space bbox onto UV atlas. Verbatim port of
    scripts/face_inpaint_atlas.py:make_atlas_mask_from_bbox. Returns a
    PIL 'L' mask of the atlas, or None if the mesh has no UVs."""
    if not hasattr(mesh, 'vertices') or not hasattr(mesh, 'faces'):
        return None
    verts = np.asarray(mesh.vertices, dtype=np.float32)
    bb_min = verts.min(axis=0)
    bb_max = verts.max(axis=0)
    center = (bb_min + bb_max) * 0.5
    scale = max(bb_max - bb_min) or 1.0
    verts = (verts - center) / scale
    # ortho xmag=ymag=0.6 → screen_x = (v.x + 0.6) / 1.2 * size
    sx = ((verts[:, 0] + 0.6) / 1.2 * render_size).astype(int)
    sy = (((-verts[:, 1]) + 0.6) / 1.2 * render_size).astype(int)
    in_bbox = ((sx >= bbox[0]) & (sx <= bbox[2])
               & (sy >= bbox[1]) & (sy <= bbox[3]))

    visual = getattr(mesh, 'visual', None)
    if visual is None or not hasattr(visual, 'uv') or visual.uv is None:
        return None
    uvs = visual.uv
    faces = mesh.faces
    face_in = in_bbox[faces].any(axis=1)

    mask = Image.new('L', (atlas_size, atlas_size), 0)
    draw = ImageDraw.Draw(mask)
    for fi in np.where(face_in)[0]:
        tri = faces[fi]
        uv_tri = uvs[tri]
        pts = [(int(u * atlas_size), int((1 - v) * atlas_size))
               for u, v in uv_tri]
        draw.polygon(pts, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(8))
    return mask


def inpaint_atlas(inpaint_pipe, atlas_img: Image.Image, mask: Image.Image,
                  prompt: str, strength: float = 0.4,
                  sdxl_size: int = 1024) -> Image.Image:
    """SDXL inpaint on the atlas using a CALLER-OWNED pipe (so the heavy
    weight load can be amortized across calls). Verbatim recompose logic
    from desktop: process at 1024², upscale back to atlas res, blend
    via the mask so non-face pixels stay byte-identical."""
    aw, ah = atlas_img.size
    atlas_lo = atlas_img.convert('RGB').resize(
        (sdxl_size, sdxl_size), Image.LANCZOS)
    mask_lo = mask.resize((sdxl_size, sdxl_size), Image.LANCZOS)

    out_lo = inpaint_pipe(
        prompt=prompt,
        negative_prompt=FACE_NEG,
        image=atlas_lo,
        mask_image=mask_lo,
        strength=float(strength),
        num_inference_steps=30,
        guidance_scale=7.5,
        height=sdxl_size, width=sdxl_size,
    ).images[0]

    out_hi = out_lo.resize((aw, ah), Image.LANCZOS)
    orig_arr = np.array(atlas_img.convert('RGB'), dtype=np.float32)
    inp_arr = np.array(out_hi, dtype=np.float32)
    mask_arr = np.array(mask.resize((aw, ah), Image.LANCZOS),
                        dtype=np.float32) / 255.0
    if mask_arr.ndim == 2:
        mask_arr = mask_arr[..., None]
    blend = orig_arr * (1.0 - mask_arr) + inp_arr * mask_arr
    blend = np.clip(blend, 0, 255).astype(np.uint8)
    return Image.fromarray(blend, 'RGB')


def apply_face_fix(
    glb_bytes: bytes,
    front_img: Image.Image,
    inpaint_pipe,
    prompt: str = DEFAULT_FACE_PROMPT,
    strength: float = 0.4,
    render_size: int = 1024,
) -> bytes:
    """End-to-end: load GLB, detect face on the front image, project to
    atlas, SDXL inpaint the masked region, write the new atlas back into
    the GLB. Returns the new GLB bytes. On any failure, returns the
    INPUT bytes unchanged (matches the desktop's shutil.copy fallbacks
    so a face-fix flag never breaks a working mesh)."""
    import trimesh
    try:
        scene = trimesh.load(io.BytesIO(glb_bytes), file_type='glb',
                             force='scene')
    except Exception as e:
        print(f'[face-fix] trimesh load failed: {e}', flush=True)
        return glb_bytes

    geoms = (list(scene.geometry.values())
             if hasattr(scene, 'geometry') else [scene])
    mesh = geoms[0] if geoms else None
    if mesh is None:
        print('[face-fix] no geometry — passthrough', flush=True)
        return glb_bytes

    visual = getattr(mesh, 'visual', None)
    material = getattr(visual, 'material', None)
    tex = getattr(material, 'baseColorTexture', None)
    if tex is None:
        print('[face-fix] no baseColor texture — passthrough', flush=True)
        return glb_bytes

    bbox = detect_face_bbox(front_img) or fallback_top_bbox(front_img.size)
    print(f'[face-fix] face bbox = {bbox}', flush=True)

    # Rescale bbox from front_img coords → render_size coords (the
    # projection formula in make_atlas_mask_from_bbox assumes a square
    # `render_size` canvas).
    fw, fh = front_img.size
    scale_x = render_size / max(fw, 1)
    scale_y = render_size / max(fh, 1)
    bbox_render = (int(bbox[0] * scale_x), int(bbox[1] * scale_y),
                   int(bbox[2] * scale_x), int(bbox[3] * scale_y))

    mask = make_atlas_mask_from_bbox(
        mesh, bbox_render, render_size, tex.size[0])
    if mask is None:
        print('[face-fix] could not build atlas mask — passthrough', flush=True)
        return glb_bytes
    cov = float(np.array(mask).mean() / 255.0)
    print(f'[face-fix] mask covers {cov * 100:.1f}% of atlas', flush=True)
    if cov < 0.001:
        print('[face-fix] mask too small — passthrough', flush=True)
        return glb_bytes

    new_tex = inpaint_atlas(inpaint_pipe, tex, mask, prompt, strength)
    mesh.visual.material.baseColorTexture = new_tex

    out_buf = io.BytesIO()
    scene.export(out_buf, file_type='glb', extension_webp=True)
    return out_buf.getvalue()
