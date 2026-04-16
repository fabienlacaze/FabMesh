"""
Build a calibration suite for the FabMesh 3D pipeline.

Outputs:
  images/_calibration/ref_0.png                          front render
  images/_calibration/ref_0_multiview/view_0..5.png      synthetic 6 views
  images/_calibration/ref_0_multiview/input.png          copy of ref_0
  meshes/_calibration_groundtruth.glb                    the "perfect" mesh
                                                         with zone-colored tex

Concept: a simple humanoid built from trimesh primitives (cylinder torso,
sphere head, box arms+legs) in strict T-pose. Each body region gets a
distinctive solid colour on the atlas:

  front of torso → RED       (1.0, 0.0, 0.0)
  back  of torso → CYAN      (0.0, 1.0, 1.0)
  head           → YELLOW    (1.0, 1.0, 0.0)
  right arm      → BLUE      (0.0, 0.0, 1.0)
  left  arm      → GREEN     (0.0, 1.0, 0.0)
  legs           → WHITE     (1.0, 1.0, 1.0)  (easy to ignore)
  feet           → BLACK     (0.0, 0.0, 0.0)

Then we render 7 views of that coloured mesh (the front at azim=0,
plus the 6 standard Zero123++ azimuths 30/90/150/210/270/330) with
trimesh's PyRender backend and save them as input.png / view_0..5.png.

The resulting suite lets the pipeline be exercised WITHOUT Zero123++'s
hallucinations. A correct 3D gen should produce a mesh whose FRONT
(viewer at -Z) is predominantly red, whose BACK is cyan, etc. Any colour
landing on the wrong side is immediate, unambiguous evidence of an
orientation / projection / rotation-offset bug.

Run once:  python scripts/_build_calibration_suite.py
"""
from __future__ import annotations

import os
import sys
import numpy as np
from PIL import Image, ImageDraw

import trimesh


# ---------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------

TORSO_H = 0.6
TORSO_R = 0.18
HEAD_R = 0.13
ARM_LEN = 0.42
ARM_R = 0.06
LEG_LEN = 0.55
LEG_R = 0.08
FOOT_LEN = 0.18
FOOT_H = 0.06


def _cyl(length, radius, color):
    c = trimesh.creation.cylinder(radius=radius, height=length, sections=24)
    c.visual.face_colors = color
    return c


def _sphere(radius, color):
    s = trimesh.creation.icosphere(subdivisions=3, radius=radius)
    s.visual.face_colors = color
    return s


def _box(extents, color):
    b = trimesh.creation.box(extents=extents)
    b.visual.face_colors = color
    return b


def _translate(m, xyz):
    m = m.copy()
    m.apply_translation(xyz)
    return m


def _rotate(m, angle_deg, axis):
    m = m.copy()
    R = trimesh.transformations.rotation_matrix(np.radians(angle_deg), axis)
    m.apply_transform(R)
    return m


def build_calibration_mesh():
    """
    Assemble the humanoid from primitives. Origin = pelvis; +Y up; -Z
    forward (glTF viewer convention). Returns a single trimesh.Trimesh
    with FACE colours set per body part.

    Colour code (must be visually distinguishable from a distance):
        torso: red front half / cyan back half (per-face paint below)
        head:  yellow sphere + magenta nose box on -Z side
        right arm (+X): solid blue capsule, HORIZONTAL along +X
        left  arm (-X): solid green capsule, HORIZONTAL along -X
        legs:  white cylinders
        feet:  black boxes
    """
    parts = []

    # -- Torso: single box, then paint each face based on its outward
    #    normal in Z. Faces with +Z outward (back) → cyan; -Z outward
    #    (front) → red. Everything else (top/bottom/sides) → dark grey.
    torso = trimesh.creation.box(extents=(TORSO_R * 2, TORSO_H, TORSO_R * 2))
    torso.apply_translation((0, TORSO_H / 2, 0))
    cols = np.full((len(torso.faces), 4), (60, 60, 60, 255), dtype=np.uint8)
    fn = torso.face_normals
    cols[fn[:, 2] < -0.5] = (255, 0, 0, 255)   # front → red
    cols[fn[:, 2] > 0.5] = (0, 255, 255, 255)  # back → cyan
    torso.visual.face_colors = cols
    parts.append(torso)

    # -- Head
    head = _sphere(HEAD_R, (255, 255, 0, 255))
    head = _translate(head, (0, TORSO_H + HEAD_R * 0.9, 0))
    parts.append(head)

    # -- Nose: small magenta prism, clearly pointing forward (-Z).
    nose = _box((HEAD_R * 0.3, HEAD_R * 0.3, HEAD_R * 0.7),
                (255, 0, 255, 255))
    nose = _translate(nose, (0, TORSO_H + HEAD_R * 0.9, -HEAD_R - HEAD_R * 0.3))
    parts.append(nose)

    # -- Arms. Cylinder's default axis is Z. To lay an arm along +X we
    #    rotate 90° around Y (not Z). Trimesh cylinder(height=H) is
    #    centered on origin aligned to Z.
    r_arm = trimesh.creation.cylinder(radius=ARM_R, height=ARM_LEN, sections=16)
    r_arm.apply_transform(
        trimesh.transformations.rotation_matrix(np.radians(90), [0, 1, 0])
    )
    r_arm.apply_translation((TORSO_R + ARM_LEN / 2, TORSO_H * 0.85, 0))
    r_arm.visual.face_colors = (0, 0, 255, 255)
    parts.append(r_arm)

    l_arm = trimesh.creation.cylinder(radius=ARM_R, height=ARM_LEN, sections=16)
    l_arm.apply_transform(
        trimesh.transformations.rotation_matrix(np.radians(90), [0, 1, 0])
    )
    l_arm.apply_translation((-(TORSO_R + ARM_LEN / 2), TORSO_H * 0.85, 0))
    l_arm.visual.face_colors = (0, 255, 0, 255)
    parts.append(l_arm)

    # -- Legs (white), vertical cylinders. Cylinder is already Y? No, it's
    #    aligned to Z by default. So we need to rotate to Y.
    r_leg = trimesh.creation.cylinder(radius=LEG_R, height=LEG_LEN, sections=16)
    r_leg.apply_transform(
        trimesh.transformations.rotation_matrix(np.radians(90), [1, 0, 0])
    )
    r_leg.apply_translation((TORSO_R * 0.5, -LEG_LEN / 2, 0))
    r_leg.visual.face_colors = (240, 240, 240, 255)
    parts.append(r_leg)

    l_leg = trimesh.creation.cylinder(radius=LEG_R, height=LEG_LEN, sections=16)
    l_leg.apply_transform(
        trimesh.transformations.rotation_matrix(np.radians(90), [1, 0, 0])
    )
    l_leg.apply_translation((-TORSO_R * 0.5, -LEG_LEN / 2, 0))
    l_leg.visual.face_colors = (240, 240, 240, 255)
    parts.append(l_leg)

    # -- Feet (black)
    r_foot = _box((LEG_R * 2, FOOT_H, FOOT_LEN), (0, 0, 0, 255))
    r_foot = _translate(r_foot,
        (TORSO_R * 0.5, -LEG_LEN - FOOT_H / 2, -FOOT_LEN * 0.15))
    parts.append(r_foot)
    l_foot = _box((LEG_R * 2, FOOT_H, FOOT_LEN), (0, 0, 0, 255))
    l_foot = _translate(l_foot,
        (-TORSO_R * 0.5, -LEG_LEN - FOOT_H / 2, -FOOT_LEN * 0.15))
    parts.append(l_foot)

    full = trimesh.util.concatenate(parts)
    # Center X/Z on origin; feet on y=0.
    bb_min, bb_max = full.bounds
    full.apply_translation([
        -(bb_min[0] + bb_max[0]) / 2,
        -bb_min[1],
        -(bb_min[2] + bb_max[2]) / 2,
    ])
    return full


# ---------------------------------------------------------------------
# Rendering (no PyRender dep — we project vertices ourselves)
# ---------------------------------------------------------------------

def render_view(mesh: trimesh.Trimesh, azim_deg: float, elev_deg: float = 0.0,
                size: int = 640, bg=(255, 255, 255)) -> Image.Image:
    """
    Render the mesh seen from a camera orbiting azim_deg around Y and
    elev_deg around X. Uses a simple face-painter algorithm:
      - transform vertices to camera space
      - paint back-to-front with per-face colour
    Enough for calibration — not photoreal but crisp and fast.
    """
    c_a, s_a = np.cos(np.radians(azim_deg)), np.sin(np.radians(azim_deg))
    c_e, s_e = np.cos(np.radians(elev_deg)), np.sin(np.radians(elev_deg))
    # Camera positioned at distance, looking at origin
    dist = max(mesh.bounds[1] - mesh.bounds[0]) * 1.6
    cam_pos = np.array([
        dist * s_a * c_e,
        dist * s_e,
        dist * c_a * c_e,  # +Z when azim=0 → looks toward -Z → sees FRONT
    ])
    # World → camera matrix
    forward = -cam_pos / np.linalg.norm(cam_pos)
    up = np.array([0, 1, 0], dtype=float)
    right = np.cross(forward, up); right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    R = np.vstack([right, up, -forward])
    t = -R @ cam_pos
    v_cam = (R @ mesh.vertices.T).T + t

    # Perspective projection
    W = H = size
    fov_deg = 40
    f = 0.5 / np.tan(np.radians(fov_deg) / 2)
    z = v_cam[:, 2]
    safe_z = np.where(np.abs(z) < 1e-6, -1e-6, z)
    u = f * v_cam[:, 0] / (-safe_z)
    v = f * v_cam[:, 1] / (-safe_z)
    px = (u * W * 0.5 + W * 0.5).astype(int)
    py = (H * 0.5 - v * H * 0.5).astype(int)

    # Sort faces by mean depth (far first so near overpaints)
    faces = mesh.faces
    face_z = z[faces].mean(axis=1)
    order = np.argsort(face_z)[::-1]

    img = Image.new('RGBA', (W, H), bg + (255,))
    d = ImageDraw.Draw(img, 'RGBA')
    face_cols = mesh.visual.face_colors
    for i in order:
        f_idx = faces[i]
        # Reject back-facing tris (simple normal check in camera space)
        v0, v1, v2 = v_cam[f_idx]
        n = np.cross(v1 - v0, v2 - v0)
        if n[2] > 0:
            continue  # back face
        pts = [(int(px[j]), int(py[j])) for j in f_idx]
        col = tuple(int(c) for c in face_cols[i])
        d.polygon(pts, fill=col)
    return img


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

    print('[calib] building mesh...')
    m = build_calibration_mesh()
    print(f'[calib] verts={len(m.vertices)} faces={len(m.faces)}')

    # Ground-truth GLB
    gt_path = os.path.join(mesh_dir, '_calibration_groundtruth.glb')
    m.export(gt_path)
    print(f'[calib] wrote {gt_path}')

    # Render front (azim=0) → ref_0.png and input.png
    print('[calib] rendering front view (azim=0)...')
    front = render_view(m, 0, 0, size=768, bg=(245, 245, 245))
    front_rgb = front.convert('RGB')
    front_rgb.save(os.path.join(img_dir, 'ref_0.png'))
    front_rgb.save(os.path.join(mv_dir, 'input.png'))

    # Write prompts.json so bridge can pick up a subject prompt
    import json as _j
    with open(os.path.join(img_dir, 'prompts.json'), 'w', encoding='utf-8') as f:
        _j.dump([{
            'prompt': 'calibration mannequin, 3D humanoid in T-pose, '
                      'red front torso, cyan back torso, yellow head, '
                      'blue right arm, green left arm, strict front view, '
                      'plain white background, symmetric, clean silhouette',
            'timestamp': 0,
        }], f, indent=2)

    # Zero123++ standard 6 views (with alternating elevations +20/-10)
    views = [(30, 20), (90, -10), (150, 20), (210, -10), (270, 20), (330, -10)]
    for i, (az, el) in enumerate(views):
        print(f'[calib] rendering view_{i} (azim={az}, elev={el})...')
        v = render_view(m, az, el, size=768, bg=(255, 255, 255))
        # Make background transparent so downstream code handles alpha
        v_rgba = v.convert('RGBA')
        arr = np.array(v_rgba)
        white = (arr[:, :, 0] > 240) & (arr[:, :, 1] > 240) & (arr[:, :, 2] > 240)
        arr[white, 3] = 0
        Image.fromarray(arr, 'RGBA').save(os.path.join(mv_dir, f'view_{i}.png'))

    print('\n[calib] done. Suite written to:')
    print(f'  {img_dir}/ref_0.png       (reference front image)')
    print(f'  {img_dir}/ref_0_multiview/ (6 synthetic multi-views)')
    print(f'  {gt_path}  (ground-truth mesh)')
    print('\nExpected behaviour of a correct pipeline on this input:')
    print('  - mesh faces the -Z axis (glTF forward)')
    print('  - FRONT (camera at -Z) is RED')
    print('  - BACK  (camera at +Z) is CYAN')
    print('  - right side (+X) is BLUE,  left side (-X) is GREEN')
    print('  - head is YELLOW with MAGENTA nose pointing -Z')
    print('\nBug signatures on the resulting 3D mesh:')
    print('  CYAN on front  -> auto-align flipped 180 degrees')
    print('  BLUE on front  -> rotation-offset 90 off (right->front)')
    print('  GREEN on front -> rotation-offset 90 off (left->front)')
    print('  Speckled       -> multi-view projection azimuth drift')


if __name__ == '__main__':
    main()
