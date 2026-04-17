"""
Build a photo-realistic Rubik's Cube calibration asset.

Unlike the hand-painted cube (which is out-of-distribution for SF3D —
trained on Objaverse photos), a Rubik's Cube is a canonical real-world
object that SF3D has seen many examples of. This should be much more
reliable as a calibration input.

Produces:
  images/_calibration/ref_rubiks.png                       (rendered front)
  images/_calibration/ref_rubiks_multiview_perfect/
      input.png + view_0..5.png                            (ground truth)
  images/_calibration/ref_rubiks_axes_perfect/
      front/back/right/left/top/bottom.png                 (per-axis GT)
  meshes/_calibration/rubiks_groundtruth.glb               (clean cube)

Each face has the canonical Rubik's color:
  Front  = RED       Top    = WHITE
  Back   = ORANGE    Bottom = YELLOW
  Right  = BLUE      Left   = GREEN
(Western standard scheme.)

A 3×3 sticker grid with black borders is drawn on each face so SF3D
has richer geometry cues (the grid lines) for UV reconstruction.
"""
from __future__ import annotations
import os
import math
import numpy as np
from PIL import Image, ImageDraw
import trimesh

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG_DIR = os.path.join(ROOT, 'images', '_calibration')
MESH_DIR = os.path.join(ROOT, 'meshes', '_calibration')
os.makedirs(IMG_DIR, exist_ok=True)
os.makedirs(MESH_DIR, exist_ok=True)

# Canonical Rubik's color scheme (Western) — matches Speedcubing standard
FACE_COLORS = {
    'front':  (200,  35,  35),   # red
    'back':   (230, 120,  40),   # orange
    'right':  ( 40,  70, 200),   # blue
    'left':   ( 50, 180,  90),   # green
    'top':    (245, 245, 245),   # white
    'bottom': (245, 215,  60),   # yellow
}

# A subtle "letter" on each face helps the classifier disambiguate even
# if colors come out slightly washed after multi-view pass. The letter
# sits in the CENTER sticker so a 3x3 grid stays visible.
FACE_LETTERS = {
    'front':  ('F', (255, 255, 255)),
    'back':   ('B', (255, 255, 255)),
    'right':  ('R', (255, 255, 255)),
    'left':   ('L', (255, 255, 255)),
    'top':    ('T', (20, 20, 20)),
    'bottom': ('D', (20, 20, 20)),
}


def render_face_texture(color, letter, letter_color, size=512):
    """Draw a 3x3 sticker grid + center letter on a single face."""
    img = Image.new('RGB', (size, size), (12, 12, 12))  # black body
    draw = ImageDraw.Draw(img)
    # 3x3 sticker layout with a generous black gutter
    pad = int(size * 0.06)
    cell = (size - 2 * pad) // 3
    gutter = int(cell * 0.08)
    for row in range(3):
        for col in range(3):
            x0 = pad + col * cell + gutter
            y0 = pad + row * cell + gutter
            x1 = pad + (col + 1) * cell - gutter
            y1 = pad + (row + 1) * cell - gutter
            # Subtle rounded rect via a polygon approximation
            draw.rounded_rectangle([x0, y0, x1, y1], radius=gutter * 2,
                                   fill=color)
    # Center letter on the middle sticker (row=1, col=1)
    cx = size // 2
    cy = size // 2
    try:
        from PIL import ImageFont
        # Try a big, bold font — falls back to default if not found
        font = None
        for candidate in ['arialbd.ttf', 'arial.ttf', 'Arial.ttf']:
            try:
                font = ImageFont.truetype(candidate, int(cell * 0.55))
                break
            except Exception:
                continue
        if font is None:
            font = ImageFont.load_default()
        bbox = draw.textbbox((0, 0), letter, font=font)
        tw = bbox[2] - bbox[0]; th = bbox[3] - bbox[1]
        draw.text((cx - tw / 2 - bbox[0], cy - th / 2 - bbox[1]), letter,
                  fill=letter_color, font=font)
    except Exception:
        pass
    return img


def build_atlas(face_size=512):
    """3x2 atlas packing: row 0 = front/right/back, row 1 = left/top/bottom."""
    W, H = 3 * face_size, 2 * face_size
    atlas = Image.new('RGB', (W, H), (12, 12, 12))
    layout = [
        ('front', 0, 0), ('right', 1, 0), ('back', 2, 0),
        ('left', 0, 1), ('top', 1, 1), ('bottom', 2, 1),
    ]
    for name, col, row in layout:
        c = FACE_COLORS[name]
        l, lc = FACE_LETTERS[name]
        face = render_face_texture(c, l, lc, face_size)
        atlas.paste(face, (col * face_size, row * face_size))
    return atlas


def build_cube_mesh(side=0.8):
    """6-face cube, unwelded, per-face UVs into the 3x2 atlas.
    Winding: CCW from outside → outward normals."""
    s = side / 2
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

    def cell_uvs(col, row):
        u0 = col / 3.0; u1 = (col + 1) / 3.0
        v0 = 1.0 - (row + 1) / 2.0; v1 = 1.0 - row / 2.0
        # CCW from camera: BL, BR, TR, TL
        return [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]

    verts = []; uvs = []; tris = []
    for name in ['front', 'back', 'right', 'left', 'top', 'bottom']:
        corners = faces_def[name]
        fu = cell_uvs(*cell[name])
        b = len(verts)
        verts.extend(corners); uvs.extend(fu)
        tris.append((b, b + 1, b + 2))
        tris.append((b, b + 2, b + 3))
    m = trimesh.Trimesh(vertices=np.array(verts, dtype=np.float32),
                        faces=np.array(tris, dtype=np.int64), process=False)
    mat = trimesh.visual.material.PBRMaterial(
        baseColorTexture=None,  # attached below
        metallicFactor=0.0, roughnessFactor=0.5)
    m.visual = trimesh.visual.texture.TextureVisuals(
        uv=np.array(uvs, dtype=np.float32), material=mat)
    return m


# ---------- Rasterizer (copied + tightened from perfect_views script)

def _rasterize(mesh, atlas_arr, v_cam, px, py, z, W, H, bg):
    faces = mesh.faces
    uvs = mesh.visual.uv
    face_z = z[faces].mean(axis=1)
    # Draw farthest first so near faces overwrite (painter's algorithm).
    order = np.argsort(face_z)
    img_arr = np.full((H, W, 4), bg + (255,), dtype=np.uint8)
    aH, aW = atlas_arr.shape[:2]
    for i in order:
        f_idx = faces[i]
        v0c, v1c, v2c = v_cam[f_idx]
        n = np.cross(v1c - v0c, v2c - v0c)
        # n[2] > 0 means facing camera; allow ~0 (edge-on) by using 0 threshold
        if n[2] <= 0:
            continue
        x = px[f_idx]; y = py[f_idx]
        xmin = max(0, int(np.floor(x.min()))); xmax = min(W - 1, int(np.ceil(x.max())))
        ymin = max(0, int(np.floor(y.min()))); ymax = min(H - 1, int(np.ceil(y.max())))
        if xmax < xmin or ymax < ymin: continue
        x0, x1, x2 = x; y0, y1, y2 = y
        denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(denom) < 1e-8: continue
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


def render_view(mesh, atlas, azim_deg, elev_deg, size=768,
                margin=0.8, bg=(240, 240, 240)):
    c_a = math.cos(math.radians(azim_deg)); s_a = math.sin(math.radians(azim_deg))
    c_e = math.cos(math.radians(elev_deg)); s_e = math.sin(math.radians(elev_deg))
    dist = max(mesh.bounds[1] - mesh.bounds[0]) * 3.0
    cam_pos = np.array([dist * s_a * c_e, dist * s_e, dist * c_a * c_e])
    forward = -cam_pos / np.linalg.norm(cam_pos)
    up0 = np.array([0, 1, 0], dtype=float)
    if abs(np.dot(forward, up0)) > 0.95: up0 = np.array([0, 0, 1], dtype=float)
    right = np.cross(forward, up0); right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    R = np.vstack([right, up, -forward])
    t = -R @ cam_pos
    v_cam = (R @ mesh.vertices.T).T + t
    W = H = size
    z = v_cam[:, 2]
    u2, v2 = v_cam[:, 0], v_cam[:, 1]
    proj_extent = max(u2.max() - u2.min(), v2.max() - v2.min())
    scale = (W * margin) / proj_extent
    cx = (u2.max() + u2.min()) / 2; cy = (v2.max() + v2.min()) / 2
    px = (u2 - cx) * scale + W / 2; py = H / 2 - (v2 - cy) * scale
    return _rasterize(mesh, np.asarray(atlas.convert('RGBA')), v_cam, px, py, z, W, H, bg)


def render_axis(mesh, atlas, axis, size=768, margin=0.85, bg=(240, 240, 240)):
    axis_cfg = {
        'front':  dict(cam=( 0, 0,  1), up=( 0, 1, 0)),
        'back':   dict(cam=( 0, 0, -1), up=( 0, 1, 0)),
        'right':  dict(cam=( 1, 0, 0), up=( 0, 1, 0)),
        'left':   dict(cam=(-1, 0, 0), up=( 0, 1, 0)),
        'top':    dict(cam=( 0, 1, 0), up=( 0, 0, 1)),
        'bottom': dict(cam=( 0,-1, 0), up=( 0, 0, -1)),
    }[axis]
    cam_pos = np.array(axis_cfg['cam'], float)
    cam_pos = cam_pos / np.linalg.norm(cam_pos) * max(mesh.bounds[1] - mesh.bounds[0]) * 3.0
    forward = -cam_pos / np.linalg.norm(cam_pos)
    up0 = np.array(axis_cfg['up'], float)
    right = np.cross(forward, up0); right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    R = np.vstack([right, up, -forward])
    t = -R @ cam_pos
    v_cam = (R @ mesh.vertices.T).T + t
    W = H = size
    z = v_cam[:, 2]
    u2, v2 = v_cam[:, 0], v_cam[:, 1]
    proj_extent = max(u2.max() - u2.min(), v2.max() - v2.min())
    scale = (W * margin) / proj_extent
    cx = (u2.max() + u2.min()) / 2; cy = (v2.max() + v2.min()) / 2
    px = (u2 - cx) * scale + W / 2; py = H / 2 - (v2 - cy) * scale
    return _rasterize(mesh, np.asarray(atlas.convert('RGBA')), v_cam, px, py, z, W, H, bg)


def main():
    print('[rubiks] building atlas...')
    atlas = build_atlas(face_size=512)
    atlas_path = os.path.join(MESH_DIR, 'rubiks_atlas.png')
    atlas.save(atlas_path)
    print(f'  atlas -> {atlas_path}')

    print('[rubiks] building cube mesh...')
    mesh = build_cube_mesh(side=0.8)
    mesh.visual.material.baseColorTexture = atlas
    gt_path = os.path.join(MESH_DIR, 'rubiks_groundtruth.glb')
    mesh.export(gt_path)
    print(f'  mesh  -> {gt_path}')

    # Reference image: trimesh's built-in scene.save_image() uses pyglet
    # with proper z-buffering. Falls back to our painter's algo if it
    # fails (headless environments, missing GL).
    print('[rubiks] rendering reference image (3/4 view)...')
    ref_path = os.path.join(IMG_DIR, 'ref_rubiks.png')
    ref = None
    try:
        scene = trimesh.Scene(mesh)
        # Orbit camera so we see front + right + top
        scene.set_camera(angles=(math.radians(25), math.radians(35), 0),
                         distance=max(mesh.bounds[1] - mesh.bounds[0]) * 2.2,
                         fov=(40, 40))
        png = scene.save_image(resolution=(768, 768), visible=False,
                               background=[240, 240, 240, 255])
        if png:
            with open(ref_path, 'wb') as f:
                f.write(png)
            ref = Image.open(ref_path)
            print('  used trimesh.Scene.save_image (GL path)')
    except Exception as e:
        print(f'  trimesh scene render failed: {type(e).__name__}: {str(e)[:80]}')
    if ref is None:
        # Fallback: pure front ortho (SF3D can still handle a single-face
        # cube input, and the multi-views fill in the rest).
        print('  falling back to pure front ortho view')
        ref = render_view(mesh, atlas, azim_deg=0, elev_deg=0, size=768,
                          margin=0.78, bg=(240, 240, 240))
        ref.save(ref_path)
    print(f'  ref   -> {ref_path}')

    # Also save a pure-front ortho as the "input" Zero123++ will use
    input_ortho = render_view(mesh, atlas, 0, 0, size=768, margin=0.85)
    mv_dir = os.path.join(IMG_DIR, 'ref_rubiks_multiview_perfect')
    os.makedirs(mv_dir, exist_ok=True)
    input_ortho.save(os.path.join(mv_dir, 'input.png'))

    # Ground truth multi-views (z123 angles)
    print('[rubiks] rendering ground-truth multi-views...')
    z123 = [(30, 20), (90, -10), (150, 20), (210, -10), (270, 20), (330, -10)]
    for i, (az, el) in enumerate(z123):
        v = render_view(mesh, atlas, az, el, size=768, margin=0.82,
                        bg=(255, 255, 255))
        v.save(os.path.join(mv_dir, f'view_{i}.png'))
        print(f'  view_{i} (az={az}, el={el})')

    # Per-axis ground truth
    print('[rubiks] rendering per-axis ground truth...')
    ax_dir = os.path.join(IMG_DIR, 'ref_rubiks_axes_perfect')
    os.makedirs(ax_dir, exist_ok=True)
    for name in ['front', 'back', 'right', 'left', 'top', 'bottom']:
        im = render_axis(mesh, atlas, name, size=768, margin=0.85)
        im.save(os.path.join(ax_dir, f'{name}.png'))
        print(f'  axis {name}')

    print('\n[rubiks] DONE.')
    print('  Use ref_rubiks.png as input to SF3D for calibration.')


if __name__ == '__main__':
    main()
