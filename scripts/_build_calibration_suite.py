"""
Build a calibration CUBE for the FabMesh 3D pipeline.

The new idea (user 2026-04-16): a single cube with a distinctive
texture on each of its 6 faces — huge letter + colour + subtle pattern.
Any orientation/projection bug on the output mesh is instantly readable
because you can just READ the letter currently visible on the front.

Faces (glTF convention: +Y up, -Z forward):

  FRONT (-Z face):   RED     + big "F"  + vertical stripes
  BACK  (+Z face):   CYAN    + big "B"  + horizontal stripes
  RIGHT (+X face):   BLUE    + big "R"  + dots
  LEFT  (-X face):   GREEN   + big "L"  + diagonal hatch
  TOP   (+Y face):   YELLOW  + big "T"  + grid
  BOTTOM(-Y face):   MAGENTA + big "D"  + cross

The pattern serves two roles:
  - letter reads instantly ("I see a B on the front → 180° flip bug")
  - pattern detects partial projection drift on sub-regions (a sliver
    of 'F stripes' bleeding into the R-dots face is visible even if
    the letter still lands on the right face).

Outputs:
  images/_calibration/ref_0.png                          front render
  images/_calibration/ref_0_multiview/view_0..5.png      6 real renders
                                                         at Zero123++'s
                                                         azimuths, so no
                                                         multi-view regen
  images/_calibration/ref_0_multiview/input.png          copy of ref_0
  meshes/_calibration_groundtruth.glb                    ground-truth cube

The ground-truth mesh carries the 6-face texture as a UV atlas so
FabMesh can be pointed at it directly for apples-to-apples comparison
against its own output.

Run once:  python scripts/_build_calibration_suite.py
"""
from __future__ import annotations

import os
import sys
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFont

import trimesh


# ---------------------------------------------------------------------
# Per-face texture generator
# ---------------------------------------------------------------------

FACE_SPECS = {
    'front':  {'letter': 'F', 'bg': (220,  30,  30), 'fg': (255, 255, 255), 'pattern': 'v_stripes'},
    'back':   {'letter': 'B', 'bg': ( 20, 200, 210), 'fg': (  0,  40,  50), 'pattern': 'h_stripes'},
    'right':  {'letter': 'R', 'bg': ( 40,  80, 230), 'fg': (255, 255, 255), 'pattern': 'dots'},
    'left':   {'letter': 'L', 'bg': ( 50, 200,  70), 'fg': ( 10,  60,  20), 'pattern': 'diag'},
    'top':    {'letter': 'T', 'bg': (250, 220,  40), 'fg': ( 60,  40,  10), 'pattern': 'grid'},
    'bottom': {'letter': 'D', 'bg': (220,  60, 210), 'fg': (255, 255, 255), 'pattern': 'cross'},
}


def _draw_pattern(d: ImageDraw.ImageDraw, size: int, kind: str, fg, alpha=60):
    """Overlay a faint pattern on top of the solid bg. Alpha kept low so
    the dominant colour still reads from far."""
    col = fg + (alpha,) if len(fg) == 3 else fg
    if kind == 'v_stripes':
        for x in range(0, size, 32):
            d.rectangle((x, 0, x + 6, size), fill=col)
    elif kind == 'h_stripes':
        for y in range(0, size, 32):
            d.rectangle((0, y, size, y + 6), fill=col)
    elif kind == 'dots':
        for y in range(16, size, 48):
            for x in range(16, size, 48):
                d.ellipse((x, y, x + 14, y + 14), fill=col)
    elif kind == 'diag':
        for i in range(-size, size * 2, 48):
            d.line((i, 0, i + size, size), fill=col, width=5)
    elif kind == 'grid':
        for v in range(0, size + 1, 48):
            d.line((v, 0, v, size), fill=col, width=2)
            d.line((0, v, size, v), fill=col, width=2)
    elif kind == 'cross':
        d.line((0, 0, size, size), fill=col, width=8)
        d.line((0, size, size, 0), fill=col, width=8)


def _face_texture(spec: dict, size: int = 512) -> Image.Image:
    """Return a size×size RGBA image for one cube face."""
    img = Image.new('RGBA', (size, size), spec['bg'] + (255,))
    d = ImageDraw.Draw(img, 'RGBA')
    _draw_pattern(d, size, spec['pattern'], spec['fg'])
    # Big centered letter. Try a system font; fall back to default if missing.
    font = None
    for candidate in ['arialbd.ttf', 'arial.ttf', 'DejaVuSans-Bold.ttf']:
        try:
            font = ImageFont.truetype(candidate, size=int(size * 0.7))
            break
        except Exception:
            pass
    if font is None:
        font = ImageFont.load_default()
    text = spec['letter']
    try:
        bbox = d.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        # textbbox can include ascent offset; offset draw position by bbox[0], bbox[1]
        x = (size - tw) // 2 - bbox[0]
        y = (size - th) // 2 - bbox[1]
    except Exception:
        tw, th = int(size * 0.5), int(size * 0.5)
        x, y = (size - tw) // 2, (size - th) // 2
    # Draw a subtle outline then the letter
    for dx, dy in [(-3, 0), (3, 0), (0, -3), (0, 3)]:
        d.text((x + dx, y + dy), text, fill=spec['bg'] + (255,), font=font)
    d.text((x, y), text, fill=spec['fg'] + (255,), font=font)
    # Corner coords so projection drift is readable to the pixel
    small = None
    for candidate in ['arial.ttf', 'DejaVuSans.ttf']:
        try:
            small = ImageFont.truetype(candidate, size=int(size * 0.04))
            break
        except Exception:
            pass
    if small is None:
        small = ImageFont.load_default()
    d.text((6, 4), f'{spec["letter"]}-TL', fill=spec['fg'] + (255,), font=small)
    d.text((size - 70, 4), f'{spec["letter"]}-TR', fill=spec['fg'] + (255,), font=small)
    d.text((6, size - 20), f'{spec["letter"]}-BL', fill=spec['fg'] + (255,), font=small)
    d.text((size - 70, size - 20), f'{spec["letter"]}-BR', fill=spec['fg'] + (255,), font=small)
    return img


def build_cube_atlas(face_size: int = 512) -> Image.Image:
    """
    Assemble the 6 face textures into one atlas (3×2 layout) compatible
    with the cube UVs we set below.

      row 0: FRONT | RIGHT | BACK
      row 1: LEFT  | TOP   | BOTTOM

    Each face texture is horizontally flipped BEFORE paste so that when
    it's mapped onto the cube and viewed from outside, the letter reads
    the correct way (not mirrored). UV convention has u increasing
    along the camera's right when viewed head-on, but we render textures
    in screen-space-normal orientation, so a pre-flip compensates.
    """
    W = 3 * face_size
    H = 2 * face_size
    atlas = Image.new('RGBA', (W, H), (0, 0, 0, 255))
    layout = [
        ('front', 0, 0), ('right', 1, 0), ('back', 2, 0),
        ('left',  0, 1), ('top',   1, 1), ('bottom', 2, 1),
    ]
    for name, cx, cy in layout:
        tex = _face_texture(FACE_SPECS[name], face_size)
        tex = tex.transpose(Image.FLIP_LEFT_RIGHT)
        atlas.paste(tex, (cx * face_size, cy * face_size))
    return atlas


# ---------------------------------------------------------------------
# Cube mesh with UVs that sample the atlas correctly
# ---------------------------------------------------------------------

def build_cube_mesh(side: float = 0.8) -> trimesh.Trimesh:
    """
    A 1×1×1-ish cube centered on origin with per-face UVs pointing at
    the 6 slots of a 3×2 atlas. Face order matches FACE_SPECS keys.
    """
    s = side / 2
    # Vertices (8 corners) — we'll duplicate them per face to have
    # independent UVs per face.
    # Face definitions: (name, 4 corner points in world space, order such
    # that the face normal points outward from the cube).
    # Face vertices ordered COUNTER-CLOCKWISE when viewed FROM OUTSIDE
    # (normal points away from the cube center). This makes the renderer's
    # back-face culling + `n[2] > 0` reject the correct faces and keep the
    # outward-facing ones, so 'front' really renders on the -Z side.
    # Convention: list the 4 corners so that when the camera faces the
    # same way as the normal, the quad goes CCW in screen space.
    faces_def = {
        # FRONT at -Z: camera at +Z looks at -Z; CCW from camera view:
        #   bot-right, bot-left, top-left, top-right  in the cube's local X
        'front':  [( s, -s, -s), (-s, -s, -s), (-s,  s, -s), ( s,  s, -s)],  # -Z normal
        # BACK at +Z: camera at -Z looks at +Z; CCW from that side means
        # flip X:
        'back':   [(-s, -s,  s), ( s, -s,  s), ( s,  s,  s), (-s,  s,  s)],  # +Z normal
        # RIGHT at +X:
        'right':  [( s, -s,  s), ( s, -s, -s), ( s,  s, -s), ( s,  s,  s)],  # +X normal
        # LEFT at -X:
        'left':   [(-s, -s, -s), (-s, -s,  s), (-s,  s,  s), (-s,  s, -s)],  # -X normal
        # TOP at +Y (looking DOWN):
        'top':    [(-s,  s, -s), ( s,  s, -s), ( s,  s,  s), (-s,  s,  s)],  # +Y normal
        # BOTTOM at -Y (looking UP):
        'bottom': [(-s, -s,  s), ( s, -s,  s), ( s, -s, -s), (-s, -s, -s)],  # -Y normal
    }
    # Atlas layout (matches build_cube_atlas): 3 cols × 2 rows.
    # For each face, give the (col, row) cell it samples.
    cell = {
        'front':  (0, 0), 'right':  (1, 0), 'back':   (2, 0),
        'left':   (0, 1), 'top':    (1, 1), 'bottom': (2, 1),
    }
    # UVs: (0,0) bottom-left of the cell, (1,1) top-right of the cell.
    # glTF V is flipped (top-left origin), so we invert V.
    def cell_uvs(col, row):
        u0 = col / 3
        u1 = (col + 1) / 3
        v0 = 1.0 - (row + 1) / 2
        v1 = 1.0 - row / 2
        return [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]

    verts = []
    uvs = []
    faces_tri = []
    for name in ['front', 'back', 'right', 'left', 'top', 'bottom']:
        corners = faces_def[name]
        fuvs = cell_uvs(*cell[name])
        base = len(verts)
        verts.extend(corners)
        uvs.extend(fuvs)
        # Two triangles per quad, wound so the normal points outward
        faces_tri.append((base + 0, base + 1, base + 2))
        faces_tri.append((base + 0, base + 2, base + 3))

    verts = np.array(verts, dtype=np.float32)
    uvs = np.array(uvs, dtype=np.float32)
    faces_tri = np.array(faces_tri, dtype=np.int64)

    mesh = trimesh.Trimesh(vertices=verts, faces=faces_tri, process=False)
    # Use trimesh's TextureVisuals with a PBR material carrying the atlas.
    atlas = build_cube_atlas(512)
    material = trimesh.visual.material.PBRMaterial(
        baseColorTexture=atlas,
        metallicFactor=0.0,
        roughnessFactor=0.85,
    )
    mesh.visual = trimesh.visual.texture.TextureVisuals(
        uv=uvs, material=material,
    )
    return mesh


# ---------------------------------------------------------------------
# Rendering (software painter)
# ---------------------------------------------------------------------

def _tex_color_at(atlas: Image.Image, u: float, v: float):
    """Sample the atlas at (u, v∈[0,1]). Handles V flip."""
    u = max(0.0, min(1.0, u))
    v = max(0.0, min(1.0, v))
    px = int(u * (atlas.width - 1))
    py = int((1.0 - v) * (atlas.height - 1))
    r, g, b = atlas.getpixel((px, py))[:3]
    return (r, g, b)


def render_view(mesh: trimesh.Trimesh, atlas: Image.Image,
                azim_deg: float, elev_deg: float = 0.0,
                size: int = 768, bg=(255, 255, 255)) -> Image.Image:
    """
    Render the textured cube from an orbited camera. Paints each face
    as a single quad using the texture colour at the face's UV centroid.
    That's enough for calibration — the face ID reads instantly.
    """
    # Camera orbit: start at (0,0,+distance) looking at origin (-Z).
    # azim=0 => front of cube; azim=90 => right side; etc.
    c_a, s_a = math.cos(math.radians(azim_deg)), math.sin(math.radians(azim_deg))
    c_e, s_e = math.cos(math.radians(elev_deg)), math.sin(math.radians(elev_deg))
    dist = max(mesh.bounds[1] - mesh.bounds[0]) * 2.2
    # Azimuth 0 = camera looks along -Z (sees the FRONT).
    # Azimuth 90 = camera moves to -X (sees the RIGHT face, since the right
    # face is on +X and the camera looking toward origin from -X sees it).
    # That requires x = -sin(az), z = +cos(az).
    cam_pos = np.array([
        -dist * s_a * c_e,
        dist * s_e,
        dist * c_a * c_e,
    ])
    forward = -cam_pos / np.linalg.norm(cam_pos)
    up = np.array([0, 1, 0], dtype=float)
    right = np.cross(forward, up); right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    R = np.vstack([right, up, -forward])
    t = -R @ cam_pos
    v_cam = (R @ mesh.vertices.T).T + t

    W = H = size
    fov_deg = 40
    f = 0.5 / math.tan(math.radians(fov_deg) / 2)
    z = v_cam[:, 2]
    safe_z = np.where(np.abs(z) < 1e-6, -1e-6, z)
    u_proj = f * v_cam[:, 0] / (-safe_z)
    v_proj = f * v_cam[:, 1] / (-safe_z)
    px = (u_proj * W * 0.5 + W * 0.5).astype(int)
    py = (H * 0.5 - v_proj * H * 0.5).astype(int)

    faces = mesh.faces
    uvs = mesh.visual.uv
    face_z = z[faces].mean(axis=1)
    order = np.argsort(face_z)[::-1]  # far first

    img = Image.new('RGBA', (W, H), bg + (255,))
    d = ImageDraw.Draw(img, 'RGBA')
    for i in order:
        f_idx = faces[i]
        v0, v1, v2 = v_cam[f_idx]
        n = np.cross(v1 - v0, v2 - v0)
        if n[2] > 0:
            continue
        pts = [(int(px[j]), int(py[j])) for j in f_idx]
        # Sample atlas at the triangle's UV centroid
        uc = float(uvs[f_idx][:, 0].mean())
        vc = float(uvs[f_idx][:, 1].mean())
        # To render with the actual face texture we need a texture-mapped
        # triangle. Cheap approximation: fill with the face's dominant
        # colour (one sample at the UV centre). For the letter to be
        # readable, we sample FROM THE ATLAS so at least big colour zones
        # render right; for fine detail we fall back to a separate path:
        col = _tex_color_at(atlas, uc, vc)
        d.polygon(pts, fill=col, outline=(0, 0, 0))
    return img


def render_textured_view(mesh: trimesh.Trimesh, atlas: Image.Image,
                         azim_deg: float, elev_deg: float = 0.0,
                         size: int = 768, bg=(255, 255, 255),
                         orthographic: bool = True) -> Image.Image:
    """
    Better renderer that preserves the texture pattern (letters readable).
    For each pixel inside a projected triangle, barycentric-interpolate
    the UVs and sample the atlas.

    orthographic=True (default for calibration): camera at infinite
    distance, no perspective — a cube shows exactly ONE face per axis
    view with no adjacent-face leak. Matches Zero123++'s training data
    (Objaverse ortho renders).
    """
    c_a, s_a = math.cos(math.radians(azim_deg)), math.sin(math.radians(azim_deg))
    c_e, s_e = math.cos(math.radians(elev_deg)), math.sin(math.radians(elev_deg))
    dist = max(mesh.bounds[1] - mesh.bounds[0]) * 2.2
    cam_pos = np.array([
        -dist * s_a * c_e, dist * s_e, dist * c_a * c_e,
    ])
    forward = -cam_pos / np.linalg.norm(cam_pos)
    up0 = np.array([0, 1, 0], dtype=float)
    right = np.cross(forward, up0); right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    R = np.vstack([right, up, -forward])
    t = -R @ cam_pos
    v_cam = (R @ mesh.vertices.T).T + t

    W = H = size
    z = v_cam[:, 2]
    if orthographic:
        extent = max(mesh.bounds[1] - mesh.bounds[0]) * 0.6
        scale = W * 0.5 / extent
        px = v_cam[:, 0] * scale + W * 0.5
        py = H * 0.5 - v_cam[:, 1] * scale
    else:
        fov_deg = 40
        f = 0.5 / math.tan(math.radians(fov_deg) / 2)
        safe_z = np.where(np.abs(z) < 1e-6, -1e-6, z)
        px = f * v_cam[:, 0] / (-safe_z) * W * 0.5 + W * 0.5
        py = H * 0.5 - f * v_cam[:, 1] / (-safe_z) * H * 0.5

    faces = mesh.faces
    uvs = mesh.visual.uv
    face_z = z[faces].mean(axis=1)
    order = np.argsort(face_z)[::-1]

    img_arr = np.full((H, W, 4), bg + (255,), dtype=np.uint8)
    atlas_arr = np.array(atlas.convert('RGBA'))
    aH, aW = atlas_arr.shape[:2]

    for i in order:
        f_idx = faces[i]
        v0c, v1c, v2c = v_cam[f_idx]
        n = np.cross(v1c - v0c, v2c - v0c)
        if n[2] > 0:
            continue
        x = px[f_idx]; y = py[f_idx]
        # Bounding box
        xmin = max(0, int(np.floor(x.min())))
        xmax = min(W - 1, int(np.ceil(x.max())))
        ymin = max(0, int(np.floor(y.min())))
        ymax = min(H - 1, int(np.ceil(y.max())))
        if xmax < xmin or ymax < ymin:
            continue
        # Grid of pixels in the bbox
        xs = np.arange(xmin, xmax + 1)
        ys = np.arange(ymin, ymax + 1)
        gx, gy = np.meshgrid(xs, ys)
        # Barycentric coords
        x0, x1, x2 = x
        y0, y1, y2 = y
        denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(denom) < 1e-8:
            continue
        l0 = ((y1 - y2) * (gx - x2) + (x2 - x1) * (gy - y2)) / denom
        l1 = ((y2 - y0) * (gx - x2) + (x0 - x2) * (gy - y2)) / denom
        l2 = 1.0 - l0 - l1
        inside = (l0 >= 0) & (l1 >= 0) & (l2 >= 0)
        if not inside.any():
            continue
        # Interpolate UV
        u = l0 * uvs[f_idx[0]][0] + l1 * uvs[f_idx[1]][0] + l2 * uvs[f_idx[2]][0]
        v = l0 * uvs[f_idx[0]][1] + l1 * uvs[f_idx[1]][1] + l2 * uvs[f_idx[2]][1]
        u = np.clip(u, 0.0, 1.0)
        v = np.clip(v, 0.0, 1.0)
        ax = (u * (aW - 1)).astype(int)
        ay = ((1.0 - v) * (aH - 1)).astype(int)
        col = atlas_arr[ay, ax]  # (Hs, Ws, 4)
        mask = inside
        out_y = gy[mask]
        out_x = gx[mask]
        img_arr[out_y, out_x] = col[mask]
    return Image.fromarray(img_arr, mode='RGBA').convert('RGB')


# ---------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------

def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    img_dir = os.path.join(root, 'images', '_calibration')
    mesh_dir = os.path.join(root, 'meshes')
    mv_dir = os.path.join(img_dir, 'ref_0_multiview')
    os.makedirs(img_dir, exist_ok=True)
    os.makedirs(mv_dir, exist_ok=True)
    os.makedirs(mesh_dir, exist_ok=True)

    print('[calib] building cube mesh + atlas...')
    m = build_cube_mesh(side=0.8)
    print(f'[calib] verts={len(m.vertices)} faces={len(m.faces)}')

    gt_path = os.path.join(mesh_dir, '_calibration_groundtruth.glb')
    m.export(gt_path)
    print(f'[calib] wrote ground-truth GLB: {gt_path}')

    atlas = build_cube_atlas(512)
    # Write atlas OUTSIDE the images dir so FabMesh's project scanner
    # doesn't treat it as another image version of _calibration.
    atlas_path = os.path.join(mesh_dir, '_calibration_atlas.png')
    atlas.convert('RGB').save(atlas_path)
    print(f'[calib] wrote atlas: {atlas_path}')

    print('[calib] rendering front view (azim=0)...')
    front = render_textured_view(m, atlas, 0, 0, size=768,
                                 bg=(245, 245, 245))
    front.save(os.path.join(img_dir, 'ref_0.png'))
    front.save(os.path.join(mv_dir, 'input.png'))

    import json as _j
    with open(os.path.join(img_dir, 'prompts.json'), 'w', encoding='utf-8') as f:
        _j.dump([{
            'prompt': 'calibration cube 6-face test pattern, solid colors '
                      'with letters F B R L T D, symmetric, strict front '
                      'view, plain white background, clean silhouette',
            'timestamp': 0,
        }], f, indent=2)

    views = [(30, 20), (90, -10), (150, 20), (210, -10), (270, 20), (330, -10)]
    for i, (az, el) in enumerate(views):
        print(f'[calib] rendering view_{i} (azim={az}, elev={el})...')
        v = render_textured_view(m, atlas, az, el, size=768,
                                 bg=(255, 255, 255))
        v_rgba = v.convert('RGBA')
        arr = np.array(v_rgba)
        white = (arr[:, :, 0] > 240) & (arr[:, :, 1] > 240) & (arr[:, :, 2] > 240)
        arr[white, 3] = 0
        Image.fromarray(arr, 'RGBA').save(os.path.join(mv_dir, f'view_{i}.png'))

    print('\n[calib] DONE. Suite paths:')
    print(f'  ref_0.png       : {os.path.join(img_dir, "ref_0.png")}')
    print(f'  multi-views     : {mv_dir}')
    print(f'  ground-truth    : {gt_path}')
    print('\nExpected 3D gen outputs for a correct pipeline:')
    print('  Letter F visible from the front     -> auto-align OK')
    print('  Letter B on front                   -> 180 flip bug')
    print('  Letter R on front                   -> rotation-offset +90')
    print('  Letter L on front                   -> rotation-offset -90')
    print('  Letter T on front (unlikely)        -> axis swap Y<->Z')
    print('  Fine pattern (stripes/dots) intact  -> projection UV OK')
    print('  Pattern scrambled across faces      -> azimuth/UV drift')


if __name__ == '__main__':
    main()
