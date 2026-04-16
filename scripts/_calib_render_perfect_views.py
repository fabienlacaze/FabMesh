"""
Render a set of "perfect" multi-views of the calibration cube:
- Orthographic projection (no perspective warp)
- Consistent framing (cube fits ~70% of the frame on every view)
- Clean white background with alpha
- Angles chosen so each letter is clearly visible

Two sets are produced:

  images/_calibration/ref_0_multiview_perfect/
      6 views at Zero123++ v1.2 angles (same as the real pipeline,
      but with consistent framing so the letters are unambiguous)

  images/_calibration/ref_0_perfect_axes/
      6 pure axis views (F/B/R/L/T/D), one per cardinal axis.
      These are the absolute ground-truth renders used to score
      projection-convention experiments.

Usage:  python scripts/_calib_render_perfect_views.py
"""
from __future__ import annotations

import os
import math
import numpy as np
from PIL import Image
import importlib.util

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_spec = importlib.util.spec_from_file_location(
    '_calib', os.path.join(ROOT, 'scripts', '_build_calibration_suite.py'))
_c = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_c)


def _build_clean_cube(side=0.8):
    """6-face cube with unwelded per-face vertices + UVs pointing at
    the 3×2 atlas cells. Same atlas layout as _calib_use_manual_faces:
      row 0 (top of image): front | right | back
      row 1 (bottom):       left  | top   | bottom
    """
    import trimesh
    s = side / 2
    # Each face: 4 corners in CCW screen order viewed from THAT face's
    # camera (BL, BR, TR, TL). UVs are assigned in the same order.
    # Screen axes per camera:
    #   front  (cam +Z): right=+X, up=+Y
    #   back   (cam -Z): right=-X, up=+Y
    #   right  (cam +X): right=-Z, up=+Y
    #   left   (cam -X): right=+Z, up=+Y
    #   top    (cam +Y): right=-X, up=+Z
    #   bottom (cam -Y): right=-X, up=-Z
    faces_def = {
        'front':  [(-s, -s, -s), ( s, -s, -s), ( s,  s, -s), (-s,  s, -s)],
        'back':   [( s, -s,  s), (-s, -s,  s), (-s,  s,  s), ( s,  s,  s)],
        'right':  [( s, -s,  s), ( s, -s, -s), ( s,  s, -s), ( s,  s,  s)],
        'left':   [(-s, -s, -s), (-s, -s,  s), (-s,  s,  s), (-s,  s, -s)],
        'top':    [( s,  s, -s), (-s,  s, -s), (-s,  s,  s), ( s,  s,  s)],
        'bottom': [( s, -s,  s), (-s, -s,  s), (-s, -s, -s), ( s, -s, -s)],
    }
    cell = {'front': (0, 0), 'right': (1, 0), 'back': (2, 0),
            'left': (0, 1), 'top': (1, 1), 'bottom': (2, 1)}
    # UVs in (BL, BR, TR, TL) to match corner order (CCW from camera).
    # glTF V flipped → row 0 spans v ∈ [0.5, 1.0].
    def cell_uvs(col, row):
        u0 = col / 3.0; u1 = (col + 1) / 3.0
        v0 = 1.0 - (row + 1) / 2.0; v1 = 1.0 - row / 2.0
        return [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
    verts = []; uvs = []; tris = []
    for name in ['front', 'back', 'right', 'left', 'top', 'bottom']:
        corners = faces_def[name]
        c_uvs = cell_uvs(*cell[name])
        b = len(verts)
        verts.extend(corners); uvs.extend(c_uvs)
        tris.append((b, b + 1, b + 2))
        tris.append((b, b + 2, b + 3))
    verts = np.array(verts, dtype=np.float32)
    uvs = np.array(uvs, dtype=np.float32)
    tris = np.array(tris, dtype=np.int64)
    m = trimesh.Trimesh(vertices=verts, faces=tris, process=False)
    mat = trimesh.visual.material.PBRMaterial(metallicFactor=0.0,
                                              roughnessFactor=0.85)
    m.visual = trimesh.visual.texture.TextureVisuals(uv=uvs, material=mat)
    return m


def render_axis(mesh, atlas, axis_name, size=768, margin=0.88,
                bg=(255, 255, 255)):
    """Pure axis render: camera placed on one of ±X, ±Y, ±Z looking at
    origin, with a stable up-vector that doesn't flip at poles."""
    # Camera positions chosen to match the z123 renderer's azim convention
    # (azim=0 → +Z, azim=90 → -X, azim=180 → -Z, azim=270 → +X).
    # So "right face visible" means the camera is placed on the +X side,
    # which corresponds to z123's azim=270.
    axis_cfg = {
        'front':  dict(cam=( 0,  0,  1), up=( 0,  1,  0)),   # azim=0
        'back':   dict(cam=( 0,  0, -1), up=( 0,  1,  0)),   # azim=180
        'right':  dict(cam=( 1,  0,  0), up=( 0,  1,  0)),   # +X side sees +X (right) face
        'left':   dict(cam=(-1,  0,  0), up=( 0,  1,  0)),   # -X side sees -X (left) face
        'top':    dict(cam=( 0,  1,  0), up=( 0,  0,  1)),
        'bottom': dict(cam=( 0, -1,  0), up=( 0,  0, -1)),
    }
    cfg = axis_cfg[axis_name]
    dist = max(mesh.bounds[1] - mesh.bounds[0]) * 3.0
    cam_pos = np.array(cfg['cam'], dtype=float) * dist
    forward = -cam_pos / np.linalg.norm(cam_pos)
    up0 = np.array(cfg['up'], dtype=float)
    right = np.cross(forward, up0); right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    R = np.vstack([right, up, -forward])
    t = -R @ cam_pos
    v_cam = (R @ mesh.vertices.T).T + t

    W = H = size
    z = v_cam[:, 2]
    u2 = v_cam[:, 0]; v2 = v_cam[:, 1]
    proj_extent = max(u2.max() - u2.min(), v2.max() - v2.min())
    scale = (W * margin) / proj_extent
    cx = (u2.max() + u2.min()) * 0.5
    cy = (v2.max() + v2.min()) * 0.5
    px = (u2 - cx) * scale + W * 0.5
    py = H * 0.5 - (v2 - cy) * scale

    return _rasterize(mesh, atlas, v_cam, px, py, z, W, H, bg)


def _rasterize(mesh, atlas, v_cam, px, py, z, W, H, bg):
    faces = mesh.faces
    uvs = mesh.visual.uv
    face_z = z[faces].mean(axis=1)
    order = np.argsort(face_z)[::-1]
    img_arr = np.full((H, W, 4), bg + (0,), dtype=np.uint8)
    atlas_arr = np.array(atlas.convert('RGBA'))
    aH, aW = atlas_arr.shape[:2]
    for i in order:
        f_idx = faces[i]
        v0c, v1c, v2c = v_cam[f_idx]
        n = np.cross(v1c - v0c, v2c - v0c)
        # Cull back-facing: in camera space, faces pointing away from
        # the camera have n[2] <= 0. Use a small positive threshold so
        # edge-on triangles don't leak in.
        if n[2] < 1e-4:
            continue
        x = px[f_idx]; y = py[f_idx]
        xmin = max(0, int(np.floor(x.min())))
        xmax = min(W - 1, int(np.ceil(x.max())))
        ymin = max(0, int(np.floor(y.min())))
        ymax = min(H - 1, int(np.ceil(y.max())))
        if xmax < xmin or ymax < ymin:
            continue
        x0, x1, x2 = x; y0, y1, y2 = y
        denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(denom) < 1e-8:
            continue
        fuv = uvs[f_idx]
        for yy in range(ymin, ymax + 1):
            for xx in range(xmin, xmax + 1):
                l0 = ((y1 - y2) * (xx - x2) + (x2 - x1) * (yy - y2)) / denom
                l1 = ((y2 - y0) * (xx - x2) + (x0 - x2) * (yy - y2)) / denom
                l2 = 1 - l0 - l1
                if l0 >= 0 and l1 >= 0 and l2 >= 0:
                    u = l0 * fuv[0][0] + l1 * fuv[1][0] + l2 * fuv[2][0]
                    v = l0 * fuv[0][1] + l1 * fuv[1][1] + l2 * fuv[2][1]
                    ax = int(np.clip(u * (aW - 1), 0, aW - 1))
                    ay = int(np.clip((1 - v) * (aH - 1), 0, aH - 1))
                    img_arr[yy, xx, :3] = atlas_arr[ay, ax, :3]
                    img_arr[yy, xx, 3] = 255
    return Image.fromarray(img_arr, 'RGBA')


def render_consistent(mesh, atlas, azim_deg, elev_deg, size=768,
                      margin=0.88, bg=(255, 255, 255)):
    """Re-implementation of render_textured_view with a single, stable
    framing: cube's largest projected extent always fills `margin` of
    the image. This is the key fix vs. the existing renderer — the
    latter uses a fixed world-space `extent` so views where the cube
    spans more of the frame (corner-on) get clipped.
    """
    c_a = math.cos(math.radians(azim_deg))
    s_a = math.sin(math.radians(azim_deg))
    c_e = math.cos(math.radians(elev_deg))
    s_e = math.sin(math.radians(elev_deg))
    dist = max(mesh.bounds[1] - mesh.bounds[0]) * 3.0
    # Standard convention: azim=0 → +Z, azim=90 → +X (not -X).
    cam_pos = np.array([
        dist * s_a * c_e, dist * s_e, dist * c_a * c_e,
    ])
    forward = -cam_pos / np.linalg.norm(cam_pos)
    up0 = np.array([0, 1, 0], dtype=float)
    if abs(np.dot(forward, up0)) > 0.95:
        up0 = np.array([0, 0, 1], dtype=float)
    right = np.cross(forward, up0); right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    R = np.vstack([right, up, -forward])
    t = -R @ cam_pos
    v_cam = (R @ mesh.vertices.T).T + t

    W = H = size
    z = v_cam[:, 2]
    u2 = v_cam[:, 0]; v2 = v_cam[:, 1]
    proj_extent = max(u2.max() - u2.min(), v2.max() - v2.min())
    scale = (W * margin) / proj_extent
    cx = (u2.max() + u2.min()) * 0.5
    cy = (v2.max() + v2.min()) * 0.5
    px = (u2 - cx) * scale + W * 0.5
    py = H * 0.5 - (v2 - cy) * scale
    return _rasterize(mesh, atlas, v_cam, px, py, z, W, H, bg)


def main():
    img_dir = os.path.join(ROOT, 'images', '_calibration')
    mv_dir = os.path.join(img_dir, 'ref_0_multiview_perfect')
    ax_dir = os.path.join(img_dir, 'ref_0_perfect_axes')
    os.makedirs(mv_dir, exist_ok=True)
    os.makedirs(ax_dir, exist_ok=True)

    # Build a non-subdivided cube with per-face (unwelded) UVs. This
    # avoids the edge-vertex UV ambiguity that the subdivided ground-
    # truth cube suffers from, giving noise-free reference views.
    atlas_path = os.path.join(ROOT, 'meshes', '_calibration_atlas.png')
    if not os.path.exists(atlas_path):
        raise FileNotFoundError(
            'Run scripts/_calib_use_manual_faces.py first to build the atlas.')
    import trimesh
    mesh = _build_clean_cube(side=0.8)
    atlas = Image.open(atlas_path).convert('RGBA')

    # --- Pure axis views (one letter per frame, true orthogonal) ---
    for name in ['front', 'back', 'right', 'left', 'top', 'bottom']:
        print(f'[calib-perfect] axis {name}')
        im = render_axis(mesh, atlas, name, size=768, margin=0.82)
        im.save(os.path.join(ax_dir, f'{name}.png'))

    # --- Zero123++ v1.2 views, but with consistent framing ---
    z123_views = [
        (30, 20), (90, -10), (150, 20), (210, -10), (270, 20), (330, -10),
    ]
    # Save front as input.png (what Zero123++ expects)
    front = render_consistent(mesh, atlas, 0, 0, size=768, margin=0.82)
    front.save(os.path.join(mv_dir, 'input.png'))

    for i, (az, el) in enumerate(z123_views):
        print(f'[calib-perfect] z123 view_{i} (az={az}, el={el})')
        im = render_consistent(mesh, atlas, az, el, size=768, margin=0.82)
        im.save(os.path.join(mv_dir, f'view_{i}.png'))

    print('\n[calib-perfect] DONE.')
    print(f'  Axis renders : {ax_dir}')
    print(f'  Z123 views   : {mv_dir}')


if __name__ == '__main__':
    main()
