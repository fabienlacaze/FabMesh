"""
FabMesh Face Reproject — non-destructive sharp-face transfer from the SOURCE.
=============================================================================

REPLACES scripts/face_inpaint_atlas.py (the doomed SDXL face-fix). The autopsy
proved SDXL repaints / erases stylized faces by construction: it is a generative
model, so "improve the face" inevitably becomes "invent a new face". This script
does the opposite — it takes the sharp face that ALREADY EXISTS in the user's
SOURCE front image and re-projects it onto the mesh's face UV region, leaving
everything outside the face mask byte-identical to the original bake.

Outcome contract (paid option must NEVER ship a worse face):
  - SUCCESS  -> the SAME face, sharper (source photo projected onto face UV).
  - GUARDRAIL -> the ORIGINAL mesh, untouched (copy input -> output, exit 0).
There is no third outcome. Any uncertainty (mask unbuildable, no R_undo aligns
the projected camera with the source face, coverage too low, weak bbox
agreement) falls back to the original.

Pipeline (validated design + the three verifier fixes):
  1. Load ORIG_ATLAS independently (RGB, native res) — the byte-identical floor
     outside the face mask.
  2. FACE-UV MASK via face_inpaint_atlas (render_mesh_front / detect_face_bbox /
     fallback_top_bbox / make_atlas_mask_from_bbox), feathered to L at atlas res.
  3. AUTO-R_undo + PERSPECTIVE-CAMERA ALIGNMENT GATE (verifier fixes A + B):
     render the mesh through texture_project's EXACT perspective front camera for
     each candidate R_undo flag, Haar-detect the rendered face, and pick the flag
     whose projected-camera render best matches the SOURCE face bbox. The ortho
     mask camera only SELECTS which UV triangles are "the face"; the gate must use
     the projecting camera or it predicts nothing.
  4. SHARP-FACE PATCH: project ONLY the front --source view via texture_project
     with FABMESH_TEXPROJ_BASE_ATLAS=1 (original bake = floor), no multiview,
     FRAME_FIX on, UFLIP off, PREFILL_DOMINANT=0, UV_REPACK=0 (never re-chart),
     and the chosen R_undo flag. Read PROJ_ATLAS back from the output GLB.
  5. COLOUR-MATCH PROJ_ATLAS -> ORIG_ATLAS inside the mask (Reinhard per-channel).
  6. FEATHERED COMPOSITE: out = ORIG*(1-m) + PROJ_matched*m, m = M_uv/255. Outside
     the mask the pixels come from the INDEPENDENTLY loaded ORIG (byte-identical).
  7. Write via texture_refine.replace_glb_atlas (in-place baseColor swap; normal
     map / UVs / skin weights preserved).

Models / deps: trimesh+pygltflib (MIT), OpenCV Haar Cascade (BSD), numpy/PIL.
All commercial-safe. NO diffusion model anywhere.

Usage:
    python face_reproject.py <input.glb> <output.glb> --source <front.png>
        [--feather 12] [--min-coverage 0.012] [--res 0]
"""
import argparse
import os
import shutil
import sys
import time

import numpy as np
from PIL import Image, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def log(msg):
    print(f'[face-reproject] {msg}', flush=True)


# Candidate R_undo flags. Each entry is (label, env-dict). The env-dict is the
# exact set of FABMESH_TEXPROJ_* vars that select that undo inside
# texture_project.project_texture. We try each, render the perspective front,
# Haar-detect, and keep the flag whose render best matches the source face bbox.
#   - sf3d   : the default SF3D post-gen undo (Rx(90) @ Ry(-90)), no env var.
#   - skip   : identity undo (FABMESH_TEXPROJ_SKIP_UNDO=1) — pre-aligned meshes
#              and the UNVALIDATED TRELLIS2 frame fall here.
#   - hi3dgen: Hi3DGen inverse pose + Y-flip (FABMESH_TEXPROJ_HI3DGEN_UNDO=1).
R_UNDO_CANDIDATES = [
    ('sf3d',    {}),
    ('skip',    {'FABMESH_TEXPROJ_SKIP_UNDO': '1'}),
    ('hi3dgen', {'FABMESH_TEXPROJ_HI3DGEN_UNDO': '1'}),
]


# ----------------------------------------------------------------------------
# Perspective front camera — BIT-FAITHFUL to texture_project.project_texture.
# detail_synth.py warns the gate cameras MUST match texture_project exactly,
# otherwise the alignment gate predicts nothing. We mirror:
#   R_undo (per candidate flag) -> verts_cam = R_undo @ v
#   R_w2c_base = [[0,1,0],[0,0,1],[1,0,0]], distance=1.6, fov=40
#   p_u = focal*x/(-z)+0.5 ; p_v = 1-(focal*y/(-z)+0.5)
# UFLIP stays OFF (texture_project default), matching the projection pass below.
# ----------------------------------------------------------------------------
def _rot_x(deg):
    r = np.radians(deg)
    return np.array([[1, 0, 0],
                     [0, np.cos(r), -np.sin(r)],
                     [0, np.sin(r),  np.cos(r)]], dtype=np.float64)


def _rot_y(deg):
    r = np.radians(deg)
    return np.array([[np.cos(r), 0, np.sin(r)],
                     [0, 1, 0],
                     [-np.sin(r), 0, np.cos(r)]], dtype=np.float64)


def _r_undo_for_flag(env):
    """Reproduce the R_undo branch selection inside texture_project for a given
    candidate env-dict. Kept in lock-step with project_texture's Step 1."""
    if env.get('FABMESH_TEXPROJ_SKIP_UNDO') == '1':
        return np.eye(3)
    if env.get('FABMESH_TEXPROJ_HI3DGEN_UNDO') == '1':
        R_inv = np.array([[1.0, 0.0, 0.0],
                          [0.0, 0.0, 1.0],
                          [0.0, -1.0, 0.0]], dtype=np.float64)
        R_y180 = np.array([[1.0, 0.0, 0.0],
                           [0.0, -1.0, 0.0],
                           [0.0, 0.0, -1.0]], dtype=np.float64)
        return R_y180 @ R_inv
    return _rot_x(90) @ _rot_y(-90)


def render_perspective_front(vertices, faces, normals, r_undo, size=512):
    """Render the mesh through texture_project's EXACT perspective front camera,
    using a tiny z-buffered solid rasterizer (front-facing, shaded by the
    camera-facing dot product). Returns a PIL 'L' image where the silhouette is
    bright on a black background — enough for Haar frontal-face detection.

    This is NOT pyrender's ortho camera (that one only drives the UV MASK). The
    GATE must see what the PROJECTION sees, so we replicate the perspective
    camera math exactly."""
    R_w2c_base = np.array([[0, 1, 0],
                           [0, 0, 1],
                           [1, 0, 0]], dtype=np.float64)
    distance = 1.6
    fov_rad = np.radians(40.0)
    focal = 0.5 / np.tan(0.5 * fov_rad)

    verts_cam = (r_undo @ vertices.T).T
    norms_cam = (r_undo @ normals.T).T
    # FRAME_FIX default ON -> normals kept outward (no -norms_cam).

    v_cs = (R_w2c_base @ verts_cam.T).T + np.array([0, 0, -distance])
    n_cs = (R_w2c_base @ norms_cam.T).T

    z = v_cs[:, 2]
    safe_z = np.where(np.abs(z) < 1e-8, -1e-8, z)
    p_u = focal * v_cs[:, 0] / (-safe_z) + 0.5
    p_v = 1.0 - (focal * v_cs[:, 1] / (-safe_z) + 0.5)

    sx = (p_u * size).astype(np.float64)
    sy = (p_v * size).astype(np.float64)

    # Camera-facing shade per vertex (cam at origin in cam space).
    cam_dirs = -v_cs
    cam_n = cam_dirs / (np.linalg.norm(cam_dirs, axis=1, keepdims=True) + 1e-10)
    nn = n_cs / (np.linalg.norm(n_cs, axis=1, keepdims=True) + 1e-10)
    facing = np.clip(np.sum(nn * cam_n, axis=1), 0.0, 1.0)
    shade = (60 + 195 * facing)  # 60..255 so silhouette is always visible

    img = np.zeros((size, size), dtype=np.float64)
    zbuf = np.full((size, size), np.inf, dtype=np.float64)

    # Camera-space depth for the z-test (smaller -z = closer; we test on -z).
    depth = -safe_z

    for tri in faces:
        i0, i1, i2 = int(tri[0]), int(tri[1]), int(tri[2])
        # Reject back-facing / behind-camera triangles cheaply.
        if facing[i0] + facing[i1] + facing[i2] <= 0.0:
            continue
        x0, y0 = sx[i0], sy[i0]
        x1, y1 = sx[i1], sy[i1]
        x2, y2 = sx[i2], sy[i2]
        min_x = int(max(0, np.floor(min(x0, x1, x2))))
        max_x = int(min(size - 1, np.ceil(max(x0, x1, x2))))
        min_y = int(max(0, np.floor(min(y0, y1, y2))))
        max_y = int(min(size - 1, np.ceil(max(y0, y1, y2))))
        if max_x <= min_x or max_y <= min_y:
            continue
        denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(denom) < 1e-9:
            continue
        inv = 1.0 / denom
        d0, d1, d2 = depth[i0], depth[i1], depth[i2]
        s0, s1, s2 = shade[i0], shade[i1], shade[i2]
        ys, xs = np.mgrid[min_y:max_y + 1, min_x:max_x + 1]
        xf = xs + 0.5
        yf = ys + 0.5
        w0 = ((y1 - y2) * (xf - x2) + (x2 - x1) * (yf - y2)) * inv
        w1 = ((y2 - y0) * (xf - x2) + (x0 - x2) * (yf - y2)) * inv
        w2 = 1.0 - w0 - w1
        inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not inside.any():
            continue
        pd = w0 * d0 + w1 * d1 + w2 * d2
        ps = w0 * s0 + w1 * s1 + w2 * s2
        sub_z = zbuf[min_y:max_y + 1, min_x:max_x + 1]
        sub_i = img[min_y:max_y + 1, min_x:max_x + 1]
        closer = inside & (pd < sub_z)
        sub_z[closer] = pd[closer]
        sub_i[closer] = ps[closer]
        zbuf[min_y:max_y + 1, min_x:max_x + 1] = sub_z
        img[min_y:max_y + 1, min_x:max_x + 1] = sub_i

    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), mode='L')


def _haar_bbox(pil_img):
    """Largest Haar frontal-face bbox in image pixels, or None. (x0,y0,x1,y1)."""
    try:
        import cv2
    except Exception as e:
        log(f'opencv unavailable for gate ({e})')
        return None
    cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
    arr = np.array(pil_img.convert('RGB'))
    gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
    faces = cascade.detectMultiScale(gray, scaleFactor=1.1,
                                     minNeighbors=3, minSize=(40, 40))
    if len(faces) == 0:
        return None
    x, y, fw, fh = max(faces, key=lambda r: r[2] * r[3])
    return (int(x), int(y), int(x + fw), int(y + fh))


def _bbox_metrics(bbox, size):
    """Normalised centre (cx,cy in [0,1]) and scale (max side / size)."""
    x0, y0, x1, y1 = bbox
    cx = 0.5 * (x0 + x1) / size
    cy = 0.5 * (y0 + y1) / size
    scale = max(x1 - x0, y1 - y0) / float(size)
    return cx, cy, scale


def _gate_score(render_bbox, render_size, src_bbox, src_size):
    """Agreement between the projected-camera render face and the source face.
    Returns (ok, score, detail). ok requires centre within ~6% of frame and
    scale ratio in [0.82, 1.22]; lower score is better (it is the centre
    distance, used only to rank candidates that all pass)."""
    if render_bbox is None or src_bbox is None:
        return False, 1e9, 'missing bbox'
    rcx, rcy, rscale = _bbox_metrics(render_bbox, render_size)
    scx, scy, sscale = _bbox_metrics(src_bbox, src_size)
    dcx = abs(rcx - scx)
    dcy = abs(rcy - scy)
    centre_dist = float(np.hypot(dcx, dcy))
    ratio = rscale / sscale if sscale > 1e-6 else 1e9
    centre_ok = (dcx <= 0.06) and (dcy <= 0.06)
    scale_ok = (0.82 <= ratio <= 1.22)
    ok = centre_ok and scale_ok
    detail = (f'centre=({rcx:.2f},{rcy:.2f}) vs ({scx:.2f},{scy:.2f}) '
              f'd={centre_dist:.3f} ratio={ratio:.2f} '
              f'centre_ok={centre_ok} scale_ok={scale_ok}')
    return ok, centre_dist, detail


def _reinhard_match(proj_arr, orig_arr, mask01):
    """Reinhard per-channel mean/std colour transfer of proj -> orig statistics,
    measured ONLY over mask>0.5 texels, applied to the whole proj atlas (the
    composite then keeps it only inside the mask). Avoids the photo face landing
    as a brighter/cooler plaque against the bake's white balance."""
    sel = mask01 > 0.5
    if sel.sum() < 64:
        log('colour-match: too few mask texels, skipping (proj kept as-is)')
        return proj_arr
    out = proj_arr.copy().astype(np.float64)
    for c in range(3):
        p = proj_arr[..., c][sel].astype(np.float64)
        o = orig_arr[..., c][sel].astype(np.float64)
        pm, ps = p.mean(), p.std()
        om, os_ = o.mean(), o.std()
        if ps < 1e-3:
            continue
        out[..., c] = (out[..., c] - pm) * (os_ / ps) + om
    return np.clip(out, 0, 255)


def _load_atlas_from_glb(glb_path):
    """Independent load of the baseColorTexture as an RGB PIL image (native res),
    via trimesh. Returns None if absent."""
    import trimesh
    scene = trimesh.load(glb_path, process=False, force='scene')
    geoms = (list(scene.geometry.values())
             if hasattr(scene, 'geometry') else [scene])
    for g in geoms:
        tex = getattr(getattr(getattr(g, 'visual', None), 'material', None),
                      'baseColorTexture', None)
        if tex is not None:
            return tex.convert('RGB')
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input')
    ap.add_argument('output')
    ap.add_argument('--source', required=True,
                    help='Sharp SOURCE front image (rectified front PNG).')
    ap.add_argument('--feather', type=int, default=12,
                    help='Gaussian feather radius (px) on the face UV mask edge.')
    ap.add_argument('--min-coverage', dest='min_coverage', type=float,
                    default=0.012,
                    help='Min fraction of atlas the face mask must cover; below '
                         'this -> guardrail passthrough.')
    ap.add_argument('--res', type=int, default=0,
                    help='Projection tex_res; 0 = use the native atlas size.')
    args = ap.parse_args()

    t0 = time.time()
    in_abs = os.path.abspath(args.input)
    out_abs = os.path.abspath(args.output)

    def guardrail(reason):
        log(f'GUARDRAIL -> passthrough ({reason}); copying input -> output')
        if in_abs != out_abs:
            shutil.copy(args.input, args.output)
        log(f'done (guardrail) in {time.time() - t0:.1f}s')
        sys.exit(0)

    if in_abs == out_abs:
        log('ERROR: input and output identical; aborting')
        sys.exit(2)
    if not os.path.exists(args.source):
        guardrail(f'source image missing: {args.source}')

    try:
        import trimesh
    except Exception as e:
        guardrail(f'trimesh unavailable ({e})')

    # ------------------------------------------------------------------
    # 1. ORIG_ATLAS — independent load, the byte-identical floor.
    # ------------------------------------------------------------------
    orig_atlas = _load_atlas_from_glb(args.input)
    if orig_atlas is None:
        guardrail('input GLB has no baseColorTexture')
    atlas_w, atlas_h = orig_atlas.size
    log(f'ORIG_ATLAS {atlas_w}x{atlas_h}')

    # Mesh arrays for the perspective gate (single load, geom[0]).
    scene = trimesh.load(args.input, process=False, force='scene')
    geoms = (list(scene.geometry.values())
             if hasattr(scene, 'geometry') else [scene])
    if not geoms:
        guardrail('no geometry in input GLB')
    geom = geoms[0]
    vertices = np.asarray(geom.vertices, dtype=np.float64)
    faces = np.asarray(geom.faces, dtype=np.int64)
    try:
        normals = np.asarray(geom.vertex_normals, dtype=np.float64)
    except Exception:
        normals = None
    if normals is None or len(normals) != len(vertices):
        guardrail('mesh has no usable vertex normals')

    # ------------------------------------------------------------------
    # 2. FACE-UV MASK (feathered L at atlas res). None -> guardrail.
    # ------------------------------------------------------------------
    try:
        from face_inpaint_atlas import (render_mesh_front, detect_face_bbox,
                                        fallback_top_bbox,
                                        make_atlas_mask_from_bbox)
    except Exception as e:
        guardrail(f'cannot import face_inpaint_atlas helpers ({e})')

    render_size = 1024
    ortho_render = render_mesh_front(scene, render_size)
    if ortho_render is None:
        guardrail('mask renderer (pyrender ortho) unavailable')
    mask_bbox = detect_face_bbox(ortho_render)
    if mask_bbox is None:
        mask_bbox = fallback_top_bbox((render_size, render_size))
        log('mask: Haar found no face on ortho render -> top-band fallback')
    M_uv = make_atlas_mask_from_bbox(scene, mask_bbox, render_size, atlas_w)
    if M_uv is None:
        guardrail('could not build face UV mask')
    M_uv = M_uv.convert('L').resize((atlas_w, atlas_h), Image.LANCZOS)
    if args.feather and args.feather > 0:
        M_uv = M_uv.filter(ImageFilter.GaussianBlur(float(args.feather)))
    mask01 = np.asarray(M_uv, dtype=np.float64) / 255.0
    coverage = float((mask01 > 0.5).mean())
    log(f'face UV mask coverage = {coverage * 100:.2f}% (min '
        f'{args.min_coverage * 100:.2f}%)')
    if coverage < args.min_coverage:
        guardrail(f'face mask coverage {coverage:.4f} < {args.min_coverage}')

    # ------------------------------------------------------------------
    # 3. AUTO-R_undo + PERSPECTIVE-CAMERA ALIGNMENT GATE (fixes A + B).
    #    Render the PROJECTING camera for each candidate R_undo, Haar-detect,
    #    compare to the SOURCE face bbox. Pick the best-aligning flag.
    # ------------------------------------------------------------------
    src_img = Image.open(args.source).convert('RGB')
    src_w, src_h = src_img.size
    src_bbox = _haar_bbox(src_img)
    if src_bbox is None:
        guardrail('no frontal face detected in SOURCE image (cannot overlay)')
    log(f'source face bbox = {src_bbox} on {src_w}x{src_h}')

    gate_size = 512
    best = None  # (label, env, score, detail)
    for label, env in R_UNDO_CANDIDATES:
        r_undo = _r_undo_for_flag(env)
        try:
            gate_render = render_perspective_front(
                vertices, faces, normals, r_undo, size=gate_size)
        except Exception as e:
            log(f'gate render failed for R_undo={label} ({e})')
            continue
        rb = _haar_bbox(gate_render)
        ok, score, detail = _gate_score(rb, gate_size, src_bbox,
                                        max(src_w, src_h))
        log(f'gate R_undo={label}: bbox={rb} {detail} -> '
            f'{"OK" if ok else "reject"}')
        if ok and (best is None or score < best[2]):
            best = (label, env, score, detail)
    if best is None:
        guardrail('no R_undo flag aligned the projecting camera with the '
                  'source face')
    chosen_label, chosen_env, chosen_score, chosen_detail = best
    log(f'chosen R_undo = {chosen_label} (score={chosen_score:.3f})')

    # ------------------------------------------------------------------
    # 4. SHARP-FACE PATCH via texture_project (front --source only).
    # ------------------------------------------------------------------
    try:
        from texture_project import project_texture
    except Exception as e:
        guardrail(f'cannot import texture_project ({e})')

    tex_res = args.res if args.res and args.res > 0 else max(atlas_w, atlas_h)
    proj_glb = args.output + '.proj.tmp.glb'

    proj_env = {
        'FABMESH_TEXPROJ_BASE_ATLAS': '1',      # original bake = floor
        'FABMESH_TEXPROJ_FRAME_FIX': '1',       # normals outward (gate matches)
        'FABMESH_TEXPROJ_UFLIP': '0',           # UFLIP off (default)
        'FABMESH_TEXPROJ_PREFILL_DOMINANT': '0',  # no dominant pre-fill
        'FABMESH_UV_REPACK': '0',               # NEVER re-chart UVs
    }
    proj_env.update(chosen_env)  # the auto-detected R_undo flag

    # Set env for the in-process project_texture call, restore afterwards.
    _saved = {}
    _clear = ['FABMESH_TEXPROJ_SKIP_UNDO', 'FABMESH_TEXPROJ_HI3DGEN_UNDO']
    for k in set(list(proj_env.keys()) + _clear):
        _saved[k] = os.environ.get(k)
    try:
        for k in _clear:
            os.environ.pop(k, None)
        for k, v in proj_env.items():
            os.environ[k] = v
        log(f'texture_project env: {proj_env}')
        ok = project_texture(args.input, args.source, proj_glb,
                             tex_res=tex_res, multiview_dir=None,
                             rotation_offset_deg=0.0)
    except Exception as e:
        try:
            os.path.exists(proj_glb) and os.remove(proj_glb)
        except Exception:
            pass
        guardrail(f'texture_project raised ({type(e).__name__}: {e})')
    finally:
        for k, v in _saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    if not ok or not os.path.exists(proj_glb):
        guardrail('texture_project produced no output')

    # Read PROJ_ATLAS back — prefer re-opening the GLB; the _tex.png side-file
    # is a fragile fallback.
    proj_atlas = _load_atlas_from_glb(proj_glb)
    if proj_atlas is None:
        side = proj_glb.replace('.glb', '_tex.png')
        if os.path.exists(side):
            log('PROJ_ATLAS: GLB read failed, using _tex.png side-file')
            proj_atlas = Image.open(side).convert('RGB')
    if proj_atlas is None:
        try:
            os.remove(proj_glb)
        except Exception:
            pass
        guardrail('could not read back PROJ_ATLAS')
    if proj_atlas.size != (atlas_w, atlas_h):
        proj_atlas = proj_atlas.resize((atlas_w, atlas_h), Image.LANCZOS)

    proj_arr = np.asarray(proj_atlas, dtype=np.float64)
    orig_arr = np.asarray(orig_atlas, dtype=np.float64)

    # ------------------------------------------------------------------
    # 5. COLOUR-MATCH PROJ -> ORIG inside the mask (Reinhard).
    # ------------------------------------------------------------------
    proj_matched = _reinhard_match(proj_arr, orig_arr, mask01)

    # ------------------------------------------------------------------
    # 6. FEATHERED COMPOSITE. Outside the mask -> independently loaded ORIG
    #    (byte-identical), inside -> colour-matched projected face.
    # ------------------------------------------------------------------
    m = mask01[..., None]
    out_arr = orig_arr * (1.0 - m) + proj_matched * m
    out_atlas = Image.fromarray(np.clip(out_arr, 0, 255).astype(np.uint8),
                                mode='RGB')

    # ------------------------------------------------------------------
    # 7. Write via texture_refine.replace_glb_atlas (in-place baseColor swap).
    # ------------------------------------------------------------------
    try:
        from texture_refine import replace_glb_atlas
        replace_glb_atlas(args.input, args.output, out_atlas)
    except Exception as e:
        try:
            os.path.exists(proj_glb) and os.remove(proj_glb)
        except Exception:
            pass
        guardrail(f'replace_glb_atlas failed ({type(e).__name__}: {e})')

    # Cleanup the projection temp GLB + its side-file.
    for p in (proj_glb, proj_glb.replace('.glb', '_tex.png'),
              proj_glb.replace('.glb', '_proj_debug.png')):
        try:
            os.path.exists(p) and os.remove(p)
        except Exception:
            pass

    sz = os.path.getsize(args.output)
    log(f'SUCCESS: sharp source face reprojected onto face UV '
        f'(R_undo={chosen_label}, coverage={coverage * 100:.2f}%, '
        f'{sz} bytes) in {time.time() - t0:.1f}s')
    sys.exit(0)


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        # Last-resort guardrail: never leave the caller without an output.
        try:
            _in = os.path.abspath(sys.argv[1])
            _out = os.path.abspath(sys.argv[2])
            if _in != _out and not os.path.exists(_out):
                shutil.copy(sys.argv[1], sys.argv[2])
                log(f'top-level guardrail copy after error: {type(e).__name__}')
        except Exception:
            pass
        sys.exit(0)
