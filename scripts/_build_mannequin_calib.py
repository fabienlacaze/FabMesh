"""
Build a crash-test mannequin for FabMesh calibration.

Humanoid shape is IN-DISTRIBUTION for SF3D/Zero123++ (trained on
Objaverse which has many character models). Each body zone carries
a unique color + pattern + letter so mis-projection is instantly
visible:

  Head top      = orange, letter 'H'
  Torso FRONT   = yellow/black checker, letter 'F'
  Torso BACK    = orange/black checker, letter 'B'
  Left arm      = red vertical stripes, letter 'L'
  Right arm     = blue vertical stripes, letter 'R'
  Left leg      = green polka dots, letter 'LL'
  Right leg     = purple polka dots, letter 'RL'

Outputs:
  meshes/_calibration/mannequin_groundtruth.glb
  images/_calibration/mannequin_ref.png           (front photo view)
  images/_calibration/mannequin_ref_0_multiview/  (6 Zero123++ angles)
  images/_calibration/mannequin_ref_0_axes/       (6 orthographic axis GT)
"""
from __future__ import annotations
import os
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFont
import trimesh

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG_DIR = os.path.join(ROOT, 'images', '_calibration')
MESH_DIR = os.path.join(ROOT, 'meshes', '_calibration')
MV_DIR = os.path.join(IMG_DIR, 'mannequin_multiview')
AXES_DIR = os.path.join(IMG_DIR, 'mannequin_axes')
os.makedirs(IMG_DIR, exist_ok=True)
os.makedirs(MESH_DIR, exist_ok=True)
os.makedirs(MV_DIR, exist_ok=True)
os.makedirs(AXES_DIR, exist_ok=True)

# --------------------------------------------------------------
# Atlas layout: 4x2 grid of 256x256 tiles = 1024x512 atlas
#   Row 0: head, torso_front, torso_back, left_arm
#   Row 1: right_arm, left_leg, right_leg, (spare)
# --------------------------------------------------------------
ATLAS_W = 1024
ATLAS_H = 512
TILE = 256


def _try_font(size):
    for name in ('arial.ttf', 'DejaVuSans-Bold.ttf', 'segoeui.ttf'):
        try:
            return ImageFont.truetype(name, size)
        except Exception:
            pass
    return ImageFont.load_default()


def make_tile_checker(c1, c2, letter, letter_color=(255, 255, 255)):
    im = Image.new('RGB', (TILE, TILE), c1)
    d = ImageDraw.Draw(im)
    n = 6
    sq = TILE // n
    for r in range(n):
        for c in range(n):
            if (r + c) % 2:
                d.rectangle([c * sq, r * sq, (c + 1) * sq, (r + 1) * sq], fill=c2)
    f = _try_font(int(TILE * 0.6))
    bbox = d.textbbox((0, 0), letter, font=f)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((TILE - tw) / 2 - bbox[0], (TILE - th) / 2 - bbox[1]),
           letter, fill=letter_color, font=f)
    return im


def make_tile_stripes(c1, c2, letter, letter_color=(255, 255, 255)):
    im = Image.new('RGB', (TILE, TILE), c1)
    d = ImageDraw.Draw(im)
    for x in range(0, TILE, 20):
        d.rectangle([x, 0, x + 10, TILE], fill=c2)
    f = _try_font(int(TILE * 0.6))
    bbox = d.textbbox((0, 0), letter, font=f)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((TILE - tw) / 2 - bbox[0], (TILE - th) / 2 - bbox[1]),
           letter, fill=letter_color, font=f)
    return im


def make_tile_dots(c1, c2, letter, letter_color=(255, 255, 255)):
    im = Image.new('RGB', (TILE, TILE), c1)
    d = ImageDraw.Draw(im)
    for r in range(4):
        for c in range(4):
            x = 20 + c * 55
            y = 20 + r * 55
            d.ellipse([x, y, x + 30, y + 30], fill=c2)
    f = _try_font(int(TILE * 0.6))
    bbox = d.textbbox((0, 0), letter, font=f)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((TILE - tw) / 2 - bbox[0], (TILE - th) / 2 - bbox[1]),
           letter, fill=letter_color, font=f)
    return im


def make_tile_solid(c1, letter, letter_color=(0, 0, 0)):
    im = Image.new('RGB', (TILE, TILE), c1)
    d = ImageDraw.Draw(im)
    f = _try_font(int(TILE * 0.7))
    bbox = d.textbbox((0, 0), letter, font=f)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((TILE - tw) / 2 - bbox[0], (TILE - th) / 2 - bbox[1]),
           letter, fill=letter_color, font=f)
    return im


# Zone (col, row) in atlas grid
ATLAS_LAYOUT = {
    'head':        (0, 0),
    'torso_front': (1, 0),
    'torso_back':  (2, 0),
    'left_arm':    (3, 0),
    'right_arm':   (0, 1),
    'left_leg':    (1, 1),
    'right_leg':   (2, 1),
}


def build_atlas():
    atlas = Image.new('RGB', (ATLAS_W, ATLAS_H), (20, 20, 20))
    tiles = {
        'head':        make_tile_solid((255, 140, 0), 'H', (0, 0, 0)),
        'torso_front': make_tile_checker((255, 220, 0), (0, 0, 0), 'F'),
        'torso_back':  make_tile_checker((255, 120, 0), (0, 0, 0), 'B'),
        'left_arm':    make_tile_stripes((200, 40, 40), (255, 255, 255), 'L'),
        'right_arm':   make_tile_stripes((40, 70, 200), (255, 255, 255), 'R'),
        'left_leg':    make_tile_dots((50, 180, 90), (255, 255, 255), 'LL'),
        'right_leg':   make_tile_dots((160, 60, 200), (255, 255, 255), 'RL'),
    }
    for zone, tile_img in tiles.items():
        col, row = ATLAS_LAYOUT[zone]
        atlas.paste(tile_img, (col * TILE, row * TILE))
    return atlas


def uv_for_zone(zone):
    """Return (u0, v0, u1, v1) for the zone's tile in the atlas."""
    col, row = ATLAS_LAYOUT[zone]
    u0 = col * TILE / ATLAS_W
    u1 = (col + 1) * TILE / ATLAS_W
    # glTF V is bottom-up; atlas is top-down
    v1 = 1.0 - row * TILE / ATLAS_H
    v0 = 1.0 - (row + 1) * TILE / ATLAS_H
    return (u0, v0, u1, v1)


def _cylinder(radius, height, sections=16, zone='', split_front_back=False):
    """Cylinder mesh along Y axis from 0 to height.
    If split_front_back: assign 'torso_front' UVs to +Z half and
    'torso_back' UVs to -Z half (needs zone to be a dict).
    Otherwise use single zone UV.
    """
    n = sections
    verts, uvs, faces = [], [], []
    # Bottom + top rings
    for yi, y in enumerate([0.0, height]):
        for i in range(n):
            a = 2 * math.pi * i / n
            verts.append((radius * math.cos(a), y, radius * math.sin(a)))
    # Side faces
    for i in range(n):
        b0 = i
        b1 = (i + 1) % n
        t0 = n + i
        t1 = n + ((i + 1) % n)
        faces.append((b0, t0, t1))
        faces.append((b0, t1, b1))
    # UVs per vertex via zone mapping
    if split_front_back and isinstance(zone, dict):
        # Z > 0 half = front, Z < 0 half = back
        for v in verts:
            z = v[2]
            zn = zone['front'] if z >= 0 else zone['back']
            u0, v0_, u1, v1_ = uv_for_zone(zn)
            # Map angle around Y to [u0..u1]
            a = math.atan2(v[2], v[0])
            # Normalise to [0..1] wrapping but within halves
            if z >= 0:
                # Front: angle ~[-pi/2 .. pi/2]
                t = (a + math.pi / 2) / math.pi
            else:
                t = (a - math.pi / 2) / math.pi
                if t < 0: t += 1.0
                if t > 1: t -= 1.0
            u = u0 + max(0, min(1, t)) * (u1 - u0)
            y_param = v[1] / height
            vv = v0_ + y_param * (v1_ - v0_)
            uvs.append((u, vv))
    else:
        u0, v0_, u1, v1_ = uv_for_zone(zone)
        for v in verts:
            a = math.atan2(v[2], v[0])
            t = (a + math.pi) / (2 * math.pi)
            u = u0 + t * (u1 - u0)
            y_param = v[1] / height
            vv = v0_ + y_param * (v1_ - v0_)
            uvs.append((u, vv))
    return verts, uvs, faces


def _box_with_zones(half_x, half_y_low, half_y_high, half_z, zones):
    """Box with distinct UV zones per face.
    half_y_low / half_y_high: lower and upper Y extent.
    zones: dict with keys 'front','back','left','right','top','bottom'.
    Returns (verts, uvs, faces)."""
    verts, uvs, faces = [], [], []
    # Corners
    sx = half_x; sy_lo = half_y_low; sy_hi = half_y_high; sz = half_z

    def _face(p0, p1, p2, p3, zone):
        b = len(verts)
        verts.extend([p0, p1, p2, p3])
        u0, v0_, u1, v1_ = uv_for_zone(zone)
        uvs.extend([(u0, v0_), (u1, v0_), (u1, v1_), (u0, v1_)])
        faces.append((b, b + 1, b + 2))
        faces.append((b, b + 2, b + 3))

    # FRONT (+Z): BL, BR, TR, TL  (from outside, CCW)
    _face((-sx, sy_lo, sz), (sx, sy_lo, sz), (sx, sy_hi, sz), (-sx, sy_hi, sz),
          zones['front'])
    # BACK (-Z): BR, BL, TL, TR (from outside)
    _face((sx, sy_lo, -sz), (-sx, sy_lo, -sz), (-sx, sy_hi, -sz), (sx, sy_hi, -sz),
          zones['back'])
    # LEFT (-X)
    _face((-sx, sy_lo, sz), (-sx, sy_hi, sz), (-sx, sy_hi, -sz), (-sx, sy_lo, -sz),
          zones['left'])
    # wait — need correct winding. Use a more careful approach for each side:
    # Clear & rebuild:
    verts.clear(); uvs.clear(); faces.clear()
    # FRONT (+Z)
    _face((-sx, sy_lo, sz), (sx, sy_lo, sz), (sx, sy_hi, sz), (-sx, sy_hi, sz),
          zones['front'])
    # BACK (-Z)
    _face((sx, sy_lo, -sz), (-sx, sy_lo, -sz), (-sx, sy_hi, -sz), (sx, sy_hi, -sz),
          zones['back'])
    # LEFT (-X)
    _face((-sx, sy_lo, -sz), (-sx, sy_lo, sz), (-sx, sy_hi, sz), (-sx, sy_hi, -sz),
          zones['left'])
    # RIGHT (+X)
    _face((sx, sy_lo, sz), (sx, sy_lo, -sz), (sx, sy_hi, -sz), (sx, sy_hi, sz),
          zones['right'])
    # TOP (+Y)
    _face((-sx, sy_hi, sz), (sx, sy_hi, sz), (sx, sy_hi, -sz), (-sx, sy_hi, -sz),
          zones['top'])
    # BOTTOM (-Y)
    _face((-sx, sy_lo, -sz), (sx, sy_lo, -sz), (sx, sy_lo, sz), (-sx, sy_lo, sz),
          zones['bottom'])
    return verts, uvs, faces


def _sphere(radius, center, zone, sections=16, rings=12):
    """Sphere with single zone UV (spherical mapping)."""
    n_sec, n_ring = sections, rings
    verts, uvs, faces = [], [], []
    for ri in range(n_ring + 1):
        phi = math.pi * ri / n_ring - math.pi / 2
        y = radius * math.sin(phi)
        r_ring = radius * math.cos(phi)
        for si in range(n_sec + 1):
            theta = 2 * math.pi * si / n_sec
            x = r_ring * math.cos(theta)
            z = r_ring * math.sin(theta)
            verts.append((center[0] + x, center[1] + y, center[2] + z))
    u0, v0_, u1, v1_ = uv_for_zone(zone)
    for ri in range(n_ring + 1):
        for si in range(n_sec + 1):
            u = u0 + (si / n_sec) * (u1 - u0)
            v = v0_ + (ri / n_ring) * (v1_ - v0_)
            uvs.append((u, v))
    stride = n_sec + 1
    for ri in range(n_ring):
        for si in range(n_sec):
            a = ri * stride + si
            b = a + 1
            c = a + stride
            d = c + 1
            faces.append((a, b, d))
            faces.append((a, d, c))
    return verts, uvs, faces


def build_mannequin():
    all_verts, all_uvs, all_faces = [], [], []

    def _append(v, u, f):
        b = len(all_verts)
        all_verts.extend(v)
        all_uvs.extend(u)
        for tri in f:
            all_faces.append((tri[0] + b, tri[1] + b, tri[2] + b))

    # --- Torso: box, front/back split ---
    # size: width 0.4, height 0.6, depth 0.25
    v, u, f = _box_with_zones(
        half_x=0.2, half_y_low=0.0, half_y_high=0.6, half_z=0.125,
        zones={
            'front':  'torso_front',
            'back':   'torso_back',
            'left':   'torso_front',   # sides get front pattern (visible from front)
            'right':  'torso_front',
            'top':    'torso_front',
            'bottom': 'torso_front',
        })
    _append(v, u, f)

    # --- Head: sphere above torso ---
    v, u, f = _sphere(radius=0.13, center=(0, 0.75, 0), zone='head')
    _append(v, u, f)

    # --- Neck: small cylinder connecting head to torso ---
    v, u, f = _cylinder(radius=0.06, height=0.08, zone='head')
    # shift up to y=0.60
    v = [(x, y + 0.60, z) for (x, y, z) in v]
    _append(v, u, f)

    # --- Left arm (from -X side of torso, extending to -X) ---
    # T-pose: horizontal along -X from shoulder
    v, u, f = _cylinder(radius=0.05, height=0.5, zone='left_arm')
    # rotate to lie along -X, shift to shoulder position (-0.2, 0.55, 0)
    v = [(-(y) - 0.2, 0.55 + x, z) for (x, y, z) in v]  # rotate Y->-X
    _append(v, u, f)

    # --- Right arm ---
    v, u, f = _cylinder(radius=0.05, height=0.5, zone='right_arm')
    v = [((y) + 0.2, 0.55 + x, z) for (x, y, z) in v]
    _append(v, u, f)

    # --- Left leg ---
    v, u, f = _cylinder(radius=0.07, height=0.7, zone='left_leg')
    # shift down from torso bottom
    v = [(x - 0.1, y - 0.7, z) for (x, y, z) in v]
    _append(v, u, f)

    # --- Right leg ---
    v, u, f = _cylinder(radius=0.07, height=0.7, zone='right_leg')
    v = [(x + 0.1, y - 0.7, z) for (x, y, z) in v]
    _append(v, u, f)

    verts = np.array(all_verts, dtype=np.float32)
    uvs = np.array(all_uvs, dtype=np.float32)
    faces = np.array(all_faces, dtype=np.int64)
    mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=False)
    return mesh, uvs


def render_view(mesh, atlas, azim_deg, elev_deg, size=768,
                margin=0.85, bg=(240, 240, 240)):
    """Painter-style render of the textured mesh at the given angles."""
    c_a = math.cos(math.radians(azim_deg)); s_a = math.sin(math.radians(azim_deg))
    c_e = math.cos(math.radians(elev_deg)); s_e = math.sin(math.radians(elev_deg))
    dist = max(mesh.bounds[1] - mesh.bounds[0]) * 2.5
    cam_pos = np.array([dist * s_a * c_e, dist * s_e, dist * c_a * c_e])
    forward = -cam_pos / np.linalg.norm(cam_pos)
    up0 = np.array([0, 1, 0], float)
    if abs(np.dot(forward, up0)) > 0.95:
        up0 = np.array([0, 0, 1], float)
    right = np.cross(forward, up0); right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    R = np.vstack([right, up, -forward])
    t = -R @ cam_pos
    v_cam = (R @ mesh.vertices.T).T + t
    W = H = size
    z = v_cam[:, 2]
    u2, v2 = v_cam[:, 0], v_cam[:, 1]
    ext = max(u2.max() - u2.min(), v2.max() - v2.min())
    scale = (W * margin) / ext
    cx = (u2.max() + u2.min()) / 2
    cy = (v2.max() + v2.min()) / 2
    px = (u2 - cx) * scale + W / 2
    py = H / 2 - (v2 - cy) * scale

    atlas_arr = np.array(atlas.convert('RGB'))
    aH, aW = atlas_arr.shape[:2]
    uvs = mesh.visual.uv
    faces = mesh.faces
    face_z = z[faces].mean(axis=1)
    order = np.argsort(face_z)[::-1]  # far to near (painter)

    img = np.full((H, W, 3), bg, dtype=np.uint8)
    depth = np.full((H, W), 1e18, float)
    for i in order:
        fidx = faces[i]
        v0c, v1c, v2c = v_cam[fidx]
        n = np.cross(v1c - v0c, v2c - v0c)
        if n[2] < 1e-4:
            continue
        xs_ = px[fidx]; ys_ = py[fidx]
        xmin = max(0, int(xs_.min())); xmax = min(W - 1, int(xs_.max()))
        ymin = max(0, int(ys_.min())); ymax = min(H - 1, int(ys_.max()))
        if xmax < xmin or ymax < ymin: continue
        x0, x1, x2 = xs_; y0, y1, y2 = ys_
        denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(denom) < 1e-8: continue
        fz = z[fidx]; fuv = uvs[fidx]
        for yy in range(ymin, ymax + 1):
            for xx in range(xmin, xmax + 1):
                l0 = ((y1 - y2) * (xx - x2) + (x2 - x1) * (yy - y2)) / denom
                l1 = ((y2 - y0) * (xx - x2) + (x0 - x2) * (yy - y2)) / denom
                l2 = 1 - l0 - l1
                if l0 >= 0 and l1 >= 0 and l2 >= 0:
                    d = l0 * fz[0] + l1 * fz[1] + l2 * fz[2]
                    if d < depth[yy, xx]:
                        depth[yy, xx] = d
                        u = l0 * fuv[0][0] + l1 * fuv[1][0] + l2 * fuv[2][0]
                        v = l0 * fuv[0][1] + l1 * fuv[1][1] + l2 * fuv[2][1]
                        ax = int(np.clip(u * (aW - 1), 0, aW - 1))
                        ay = int(np.clip((1 - v) * (aH - 1), 0, aH - 1))
                        img[yy, xx] = atlas_arr[ay, ax]
    return Image.fromarray(img)


def main():
    print('[mannequin] building atlas...')
    atlas = build_atlas()
    atlas_path = os.path.join(MESH_DIR, 'mannequin_atlas.png')
    atlas.save(atlas_path)
    print(f'  atlas -> {atlas_path}')

    print('[mannequin] building mesh...')
    mesh, uvs = build_mannequin()
    print(f'  verts={len(mesh.vertices)} faces={len(mesh.faces)}')
    material = trimesh.visual.material.PBRMaterial(
        baseColorTexture=atlas, metallicFactor=0.0, roughnessFactor=0.8)
    mesh.visual = trimesh.visual.texture.TextureVisuals(
        uv=uvs, material=material)
    gt_path = os.path.join(MESH_DIR, 'mannequin_groundtruth.glb')
    mesh.export(gt_path)
    print(f'  mesh  -> {gt_path}')

    # Reference photo: front 3/4 view so SF3D has info about sides
    print('[mannequin] rendering reference image (front, slight 3/4)...')
    ref = render_view(mesh, atlas, azim_deg=15, elev_deg=0,
                      size=768, margin=0.82, bg=(240, 240, 240))
    ref.save(os.path.join(IMG_DIR, 'mannequin_ref.png'))

    # Zero123++ multi-views
    print('[mannequin] rendering multi-views at z123 angles...')
    z123 = [(30, 20), (90, -10), (150, 20), (210, -10), (270, 20), (330, -10)]
    # input.png (front) for the multiview dir
    front = render_view(mesh, atlas, 0, 0, size=768, margin=0.82,
                        bg=(255, 255, 255))
    front.save(os.path.join(MV_DIR, 'input.png'))
    for i, (az, el) in enumerate(z123):
        v = render_view(mesh, atlas, az, el, size=768, margin=0.82,
                        bg=(255, 255, 255))
        v.save(os.path.join(MV_DIR, f'view_{i}.png'))
        print(f'  view_{i} (az={az}, el={el})')

    # Cardinal-axis orthographic-ish renders (GT for stage 4 scoring)
    print('[mannequin] rendering 6 cardinal axes...')
    axes = [('front', 0, 0), ('back', 180, 0),
            ('right', 90, 0), ('left', 270, 0),
            ('top', 0, 89), ('bottom', 0, -89)]
    for name, az, el in axes:
        im = render_view(mesh, atlas, az, el, size=768, margin=0.85,
                         bg=(240, 240, 240))
        im.save(os.path.join(AXES_DIR, f'{name}.png'))
        print(f'  axis {name}')

    print('\n[mannequin] DONE')


if __name__ == '__main__':
    main()
