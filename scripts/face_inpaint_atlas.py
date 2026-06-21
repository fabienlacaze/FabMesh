"""Post-process the face region of a textured mesh GLB via SDXL inpaint.

Why : TRELLIS-2 produces meshes where the face often comes out
asymmetric / blurry / "creepy" because the voxel resolution can't
resolve fine facial features. The geometry is locked at this point,
but the *texture* on the face can be polished by SDXL inpaint at the
atlas level.

Workflow :
  1. Render the mesh from the front camera (same as TRELLIS-2 input).
  2. Auto-detect the face bounding box via OpenCV Haar Cascade
     (BSD, bundled with opencv-python). Fallback to top-25% of the
     silhouette if no face is detected.
  3. Project the face bbox onto the atlas via UV unwrap → atlas-space
     mask.
  4. SDXL inpaint on the atlas at native 1024² with mask + prompt
     "detailed realistic face, sharp eyes, natural skin, photorealistic",
     then composite back into the source-res atlas through the mask
     so non-face pixels stay byte-identical.
  5. Pack the new atlas back into the GLB.

Models : RealVisXL inpaint (RAIL++-M), OpenCV Haar Cascade (BSD),
trimesh+pygltflib (MIT), pyrender (MIT). All commercial-safe.

Usage :
    python face_inpaint_atlas.py <input.glb> <output.glb>
        [--strength 0.4] [--prompt "..."] [--render_size 1024]
"""
import argparse
import os
import sys
import time

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFilter


def log(msg):
    print(f'[face-inpaint] {msg}', flush=True)


def render_mesh_front(scene, size=1024):
    """Render the GLB from a front orthographic camera. Returns
    PIL RGB. Uses pyrender (MIT) if available, else falls back to a
    crude vertex-color rasterization."""
    try:
        # On Linux headless we'd want osmesa; on Windows leave default
        # (pyrender uses pyglet/GLFW via PyOpenGL automatically).
        if sys.platform.startswith('linux'):
            os.environ.setdefault('PYOPENGL_PLATFORM', 'osmesa')
        import pyrender
    except Exception as e:
        log(f'pyrender not available ({e}) — falling back to silhouette-only mask')
        return None
    try:
        py_scene = pyrender.Scene(bg_color=[1, 1, 1, 1],
                                    ambient_light=[0.6, 0.6, 0.6])
        geoms = (list(scene.geometry.values())
                 if hasattr(scene, 'geometry') else [scene])
        for g in geoms:
            pm = pyrender.Mesh.from_trimesh(g, smooth=False)
            py_scene.add(pm)
        cam = pyrender.OrthographicCamera(xmag=0.6, ymag=0.6,
                                            znear=0.01, zfar=100)
        cam_pose = np.eye(4)
        cam_pose[2, 3] = 2.0
        py_scene.add(cam, pose=cam_pose)
        light = pyrender.DirectionalLight(color=np.ones(3), intensity=2.0)
        py_scene.add(light, pose=cam_pose)
        r = pyrender.OffscreenRenderer(size, size)
        color, _ = r.render(py_scene)
        r.delete()
        return Image.fromarray(color, mode='RGB')
    except Exception as e:
        log(f'render failed ({e}) — fallback to None')
        return None


def detect_face_bbox(rendered_img):
    """Return (x0, y0, x1, y1) of the face in the rendered image, or
    None if no face is found. Uses OpenCV Haar Cascade (BSD, bundled
    with opencv-python). Commercial-safe."""
    try:
        import cv2
        cascade_path = (cv2.data.haarcascades
                        + 'haarcascade_frontalface_default.xml')
        cascade = cv2.CascadeClassifier(cascade_path)
        arr = np.array(rendered_img.convert('RGB'))
        gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
        faces = cascade.detectMultiScale(gray, scaleFactor=1.1,
                                          minNeighbors=3,
                                          minSize=(50, 50))
        if len(faces) == 0:
            log('opencv: no face detected')
            return None
        # Pick largest face
        x, y, fw, fh = max(faces, key=lambda r: r[2] * r[3])
        x0, y0, x1, y1 = x, y, x + fw, y + fh
        w, h = rendered_img.size
        # Expand 30% margin to include hair / chin / ears
        mw = (x1 - x0) * 0.30
        mh = (y1 - y0) * 0.30
        x0 = max(0, int(x0 - mw))
        y0 = max(0, int(y0 - mh))
        x1 = min(w, int(x1 + mw))
        y1 = min(h, int(y1 + mh))
        log(f'opencv face bbox: ({x0}, {y0}) - ({x1}, {y1})')
        return (x0, y0, x1, y1)
    except Exception as e:
        log(f'opencv face detection failed: {e}')
        return None


def fallback_top_bbox(image_size):
    """Crude fallback when face detection fails: top 25% of image."""
    w, h = image_size
    return (int(w * 0.25), 0, int(w * 0.75), int(h * 0.30))


def make_atlas_mask_from_bbox(scene, bbox, render_size, atlas_size):
    """Project a 2D screen-space bbox onto the UV atlas to produce a
    mask of the face region in atlas pixels.

    Since we don't have a real raycaster here, we use a heuristic:
    every triangle whose vertices project inside the bbox in screen
    space gets its UV triangle painted on the mask.
    """
    geoms = (list(scene.geometry.values())
             if hasattr(scene, 'geometry') else [scene])
    if not geoms:
        return None
    mesh = geoms[0]
    if not hasattr(mesh, 'vertices') or not hasattr(mesh, 'faces'):
        return None
    # Normalize mesh to [-0.5, 0.5] in its largest axis BEFORE projecting,
    # so the same projection works regardless of the GLB unit scale.
    verts = np.asarray(mesh.vertices, dtype=np.float32)
    bb_min = verts.min(axis=0)
    bb_max = verts.max(axis=0)
    center = (bb_min + bb_max) * 0.5
    scale = max(bb_max - bb_min) or 1.0
    verts = (verts - center) / scale  # now roughly in [-0.5, 0.5]
    # Ortho camera xmag=0.6 ymag=0.6 -> screen x = (v.x + 0.6) / 1.2 * size
    sx = ((verts[:, 0] + 0.6) / 1.2 * render_size).astype(int)
    sy = (((-verts[:, 1]) + 0.6) / 1.2 * render_size).astype(int)
    in_bbox = ((sx >= bbox[0]) & (sx <= bbox[2])
               & (sy >= bbox[1]) & (sy <= bbox[3]))
    log(f'{in_bbox.sum()} / {len(verts)} vertices in face bbox')

    if not hasattr(mesh, 'visual') or not hasattr(mesh.visual, 'uv'):
        log('mesh has no UVs — cannot build atlas mask')
        return None
    uvs = mesh.visual.uv
    faces = mesh.faces
    # A triangle is "face triangle" if any of its 3 verts is in bbox.
    face_in = in_bbox[faces].any(axis=1)
    log(f'{face_in.sum()} / {len(faces)} faces touch the face bbox')

    # Paint UV triangles into the mask
    mask = Image.new('L', (atlas_size, atlas_size), 0)
    draw = ImageDraw.Draw(mask)
    for fi in np.where(face_in)[0]:
        tri = faces[fi]
        uv_tri = uvs[tri]
        pts = [(int(u * atlas_size), int((1 - v) * atlas_size))
               for u, v in uv_tri]
        draw.polygon(pts, fill=255)
    # Soft edges so the inpaint blends
    mask = mask.filter(ImageFilter.GaussianBlur(8))
    return mask


def make_atlas_mask_from_screenmask(scene, screen_mask, render_size, atlas_size):
    """Project a user-drawn 2D screen-space mask (white = edit this region) onto
    the UV atlas. Same vertex->screen ortho projection as the bbox version, but a
    triangle is selected when any of its verts lands on a white mask pixel. This
    generalises face inpaint to ANY region the user paints on the front render.
    `screen_mask` is a (render_size, render_size) uint8 numpy array (0/255)."""
    geoms = (list(scene.geometry.values())
             if hasattr(scene, 'geometry') else [scene])
    if not geoms:
        return None
    mesh = geoms[0]
    if not hasattr(mesh, 'vertices') or not hasattr(mesh, 'faces'):
        return None
    verts = np.asarray(mesh.vertices, dtype=np.float32)
    bb_min = verts.min(axis=0)
    bb_max = verts.max(axis=0)
    center = (bb_min + bb_max) * 0.5
    scale = max(bb_max - bb_min) or 1.0
    verts = (verts - center) / scale
    sx = ((verts[:, 0] + 0.6) / 1.2 * render_size).astype(int)
    sy = (((-verts[:, 1]) + 0.6) / 1.2 * render_size).astype(int)
    sx = np.clip(sx, 0, render_size - 1)
    sy = np.clip(sy, 0, render_size - 1)
    in_region = screen_mask[sy, sx] > 127
    log(f'{int(in_region.sum())} / {len(verts)} vertices under the drawn mask')
    if not hasattr(mesh, 'visual') or not hasattr(mesh.visual, 'uv'):
        log('mesh has no UVs — cannot build atlas mask')
        return None
    uvs = mesh.visual.uv
    faces = mesh.faces
    face_in = in_region[faces].any(axis=1)
    log(f'{int(face_in.sum())} / {len(faces)} faces under the drawn mask')
    mask = Image.new('L', (atlas_size, atlas_size), 0)
    draw = ImageDraw.Draw(mask)
    for fi in np.where(face_in)[0]:
        tri = faces[fi]
        uv_tri = uvs[tri]
        pts = [(int(u * atlas_size), int((1 - v) * atlas_size))
               for u, v in uv_tri]
        draw.polygon(pts, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(6))
    return mask


def inpaint_atlas(atlas_img, mask, prompt, strength=0.4,
                   sdxl_size=1024):
    """SDXL inpaint on the atlas where the mask is white.

    SDXL is locked to 1024x1024 native res. For 2K/4K atlases we
    process at 1024 then composite the inpainted region back into the
    original-res atlas, so non-face pixels stay byte-identical to the
    source.
    """
    from diffusers import StableDiffusionXLInpaintPipeline
    aw, ah = atlas_img.size
    # Downscale atlas + mask to SDXL native res
    atlas_lo = atlas_img.convert('RGB').resize(
        (sdxl_size, sdxl_size), Image.LANCZOS)
    mask_lo = mask.resize((sdxl_size, sdxl_size), Image.LANCZOS)

    pipe = StableDiffusionXLInpaintPipeline.from_pretrained(
        'SG161222/RealVisXL_V4.0',
        torch_dtype=torch.float16, variant='fp16', use_safetensors=True,
    )
    pipe.unet.to(torch.float16)
    pipe.vae.to(torch.float16)
    pipe.text_encoder.to(torch.float16)
    pipe.text_encoder_2.to(torch.float16)
    pipe.enable_model_cpu_offload()
    neg = ('deformed, asymmetric, creepy, blurry, low quality, '
           'extra eyes, missing features, distorted, watermark, '
           'cartoon, plastic, doll face, uncanny valley')
    out_lo = pipe(
        prompt=prompt,
        negative_prompt=neg,
        image=atlas_lo,
        mask_image=mask_lo,
        strength=strength,
        num_inference_steps=30,
        guidance_scale=7.5,
        height=sdxl_size, width=sdxl_size,
    ).images[0]

    # Free VRAM before the next post-process step (Real-ESRGAN, etc.)
    # — pipe holds ~6 GB of UNet/VAE/text-encoder on GPU when offloaded.
    try:
        del pipe
        torch.cuda.empty_cache()
    except Exception:
        pass

    # Upscale inpainted back to atlas res
    out_hi = out_lo.resize((aw, ah), Image.LANCZOS)
    # Composite: keep original outside mask, use inpainted inside mask
    orig_arr = np.array(atlas_img.convert('RGB'), dtype=np.float32)
    inp_arr = np.array(out_hi, dtype=np.float32)
    mask_arr = np.array(mask.resize((aw, ah), Image.LANCZOS),
                         dtype=np.float32) / 255.0
    if mask_arr.ndim == 2:
        mask_arr = mask_arr[..., None]
    blend = orig_arr * (1.0 - mask_arr) + inp_arr * mask_arr
    blend = np.clip(blend, 0, 255).astype(np.uint8)
    return Image.fromarray(blend, 'RGB')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input')
    ap.add_argument('output')
    ap.add_argument('--strength', type=float, default=0.4)
    ap.add_argument('--prompt', default=(
        'detailed realistic face, sharp natural eyes, '
        'photorealistic skin, symmetrical features, soft lighting, '
        'ultra detailed, 8k, masterpiece'))
    ap.add_argument('--render_size', type=int, default=1024)
    ap.add_argument('--mask', default=None,
                    help='user-drawn screen-space mask PNG (white = region to '
                         're-texture). When set, skips face detection and '
                         're-textures the painted region with --prompt.')
    ap.add_argument('--render-only', dest='render_only', default=None,
                    help='just render the mesh front to this PNG and exit, so '
                         'the UI can draw a mask aligned to the projection.')
    args = ap.parse_args()

    # Guard against in-place overwrite: trimesh.export() would corrupt
    # the texture stream we're still reading from `tex`. main.js always
    # passes input != output, but a manual CLI call could foot-gun.
    in_abs = os.path.abspath(args.input)
    out_abs = os.path.abspath(args.output)
    if in_abs == out_abs:
        log(f'ERROR: input and output paths are identical ({in_abs}); aborting')
        sys.exit(2)

    import trimesh
    log(f'load {args.input}')
    scene = trimesh.load(args.input, force='scene')

    log('rendering mesh front for face detection...')
    t0 = time.time()
    rendered = render_mesh_front(scene, args.render_size)
    if rendered is None:
        log('cannot render mesh — aborting (geometry unchanged, copy input)')
        import shutil
        shutil.copy(args.input, args.output)
        sys.exit(0)
    log(f'  rendered in {time.time()-t0:.1f}s')

    if args.render_only:
        rendered.save(args.render_only)
        log(f'render-only -> {args.render_only}')
        sys.exit(0)

    bbox = None
    if not args.mask:
        bbox = detect_face_bbox(rendered) or fallback_top_bbox(rendered.size)
        log(f'face bbox = {bbox}')

    geoms = (list(scene.geometry.values())
             if hasattr(scene, 'geometry') else [scene])
    mesh = geoms[0] if geoms else None
    if not mesh:
        log('no geometry — abort')
        import shutil
        shutil.copy(args.input, args.output)
        sys.exit(0)

    tex = getattr(getattr(mesh.visual, 'material', None),
                  'baseColorTexture', None)
    if tex is None:
        log('no baseColor texture — abort')
        import shutil
        shutil.copy(args.input, args.output)
        sys.exit(0)
    log(f'atlas size: {tex.size}')

    if args.mask:
        log(f'projecting user-drawn mask {args.mask} to UV atlas...')
        _sm = Image.open(args.mask).convert('L').resize(
            (args.render_size, args.render_size), Image.LANCZOS)
        screen_mask = np.array(_sm, dtype=np.uint8)
        mask = make_atlas_mask_from_screenmask(scene, screen_mask,
                                               args.render_size, tex.size[0])
    else:
        log('projecting face bbox to UV atlas...')
        mask = make_atlas_mask_from_bbox(scene, bbox, args.render_size,
                                           tex.size[0])
    if mask is None:
        log('could not build atlas mask — abort')
        import shutil
        shutil.copy(args.input, args.output)
        sys.exit(0)
    mask_white_ratio = np.array(mask).mean() / 255.0
    log(f'mask covers {mask_white_ratio*100:.1f}% of atlas')
    if mask_white_ratio < 0.001:
        log('mask too small — passthrough (skipping SDXL load)')
        import shutil
        shutil.copy(args.input, args.output)
        sys.exit(0)

    log(f'SDXL inpaint with strength={args.strength}...')
    t0 = time.time()
    new_tex = inpaint_atlas(tex, mask, args.prompt, args.strength)
    log(f'  inpaint done in {time.time()-t0:.1f}s')

    mesh.visual.material.baseColorTexture = new_tex

    log(f'export {args.output}')
    use_webp = os.environ.get('FABMESH_TRELLIS2_EXPORT_WEBP', '1') == '1'
    if use_webp:
        scene.export(args.output, extension_webp=True)
    else:
        scene.export(args.output)
    log(f'wrote {os.path.getsize(args.output)} bytes')


if __name__ == '__main__':
    main()
