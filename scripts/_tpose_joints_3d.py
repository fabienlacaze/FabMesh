"""Canonical T-pose 18-joints model (OpenPose body_18 layout) in 3D.

Used by voie C (fabmesh_6views_runner) to project OpenPose skeletons
from ANY orthographic camera by applying the SAME w2c + proj_mtx
matrices that texture_project will use for baking — so skeletons +
bake pixels stay perfectly aligned.

Joint indices follow the OpenPose body_18 convention used already
by scripts/_make_back_skeleton.py. Coordinates are in the MESH-STD
frame (after mesh2std axis-swap), normalized to a unit box ~[-0.5, 0.5]
on the largest axis, with +Y = up, +Z = facing camera for the front
view.

The figure is a gender-neutral adult T-pose, ~1.0m tall in the
normalized frame (head at y=+0.45, feet at y=-0.55).
"""
import numpy as np


# OpenPose body_18 joint ORDER. Index matches the key in
# _make_back_skeleton.py's `pts` dict.
JOINT_NAMES = [
    'nose',         # 0
    'neck',         # 1
    'r_shoulder',   # 2
    'r_elbow',      # 3
    'r_wrist',      # 4
    'l_shoulder',   # 5
    'l_elbow',      # 6
    'l_wrist',      # 7
    'r_hip',        # 8
    'r_knee',       # 9
    'r_ankle',      # 10
    'l_hip',        # 11
    'l_knee',       # 12
    'l_ankle',      # 13
    'r_eye',        # 14
    'l_eye',        # 15
    'r_ear',        # 16
    'l_ear',        # 17
]

# T-pose joint positions in MESH-STD frame (after mesh2std swap).
# +X = right, +Y = up, +Z = toward camera for front view.
# Dimensions approximate a ~1m-tall adult: shoulders at y=0.23,
# hips at y=-0.05, knees at y=-0.28, ankles at y=-0.55.
# Arms extended horizontally: wrists at x=±0.46.
TPOSE_JOINTS = np.array([
    [ 0.00,  0.44,  0.03],  # 0 nose
    [ 0.00,  0.29,  0.00],  # 1 neck
    [ 0.14,  0.24,  0.00],  # 2 r_shoulder  (character's right, so +X is LEFT in image → watch out)
    [ 0.30,  0.24,  0.00],  # 3 r_elbow
    [ 0.46,  0.24,  0.00],  # 4 r_wrist
    [-0.14,  0.24,  0.00],  # 5 l_shoulder
    [-0.30,  0.24,  0.00],  # 6 l_elbow
    [-0.46,  0.24,  0.00],  # 7 l_wrist
    [ 0.08, -0.05,  0.00],  # 8 r_hip
    [ 0.08, -0.28,  0.00],  # 9 r_knee
    [ 0.08, -0.55,  0.00],  # 10 r_ankle
    [-0.08, -0.05,  0.00],  # 11 l_hip
    [-0.08, -0.28,  0.00],  # 12 l_knee
    [-0.08, -0.55,  0.00],  # 13 l_ankle
    [ 0.04,  0.46,  0.03],  # 14 r_eye
    [-0.04,  0.46,  0.03],  # 15 l_eye
    [ 0.07,  0.44,  0.00],  # 16 r_ear
    [-0.07,  0.44,  0.00],  # 17 l_ear
], dtype=np.float64)

# Limbs + color palette identical to _make_back_skeleton.py so the
# output matches what ControlNet OpenPose SDXL was trained on.
LIMBS = [
    (1, 2), (1, 5), (2, 3), (3, 4), (5, 6), (6, 7),
    (1, 8), (8, 9), (9, 10), (1, 11), (11, 12), (12, 13),
    (1, 0), (0, 14), (14, 16), (0, 15), (15, 17),
]
COLORS = [
    (255, 0, 0), (255, 85, 0), (255, 170, 0), (255, 255, 0),
    (170, 255, 0), (85, 255, 0), (0, 255, 0), (0, 255, 85),
    (0, 255, 170), (0, 255, 255), (0, 170, 255), (0, 85, 255),
    (0, 0, 255), (85, 0, 255), (170, 0, 255), (255, 0, 255),
    (255, 0, 170), (255, 0, 85),
]


def project_joints(w2c, proj_mtx, size=1024):
    """Project the 18 canonical T-pose joints into image-space pixels
    using the given orthographic camera matrices.

    w2c, proj_mtx: 4x4 numpy arrays (same convention as MVAdapter).
    Returns:
        points_2d: (18, 2) pixel coordinates (x, y) — may be NaN / OOB
                   for joints behind the camera or out of frame.
        visible:   (18,) bool mask, True if the joint projects inside
                   [0, size]² AND is in front of the camera.
    """
    w2c = np.asarray(w2c, dtype=np.float64)
    proj = np.asarray(proj_mtx, dtype=np.float64)
    j = TPOSE_JOINTS  # (18, 3)
    j_h = np.concatenate([j, np.ones((len(j), 1))], axis=1)  # (18, 4)
    clip = (proj @ w2c @ j_h.T).T  # (18, 4)
    w = np.where(np.abs(clip[:, 3]) < 1e-8, 1.0, clip[:, 3])
    ndc = clip[:, :3] / w[:, np.newaxis]
    # MVAdapter's get_orthogonal_projection_matrix has [1,1] = -2/(t-b)
    # (negative) which already flips Y into image convention. So
    # p_u = 0.5*(ndc_x + 1), p_v = 0.5*(ndc_y + 1) — no extra flip.
    p_u = 0.5 * (ndc[:, 0] + 1.0)
    p_v = 0.5 * (ndc[:, 1] + 1.0)
    xs = p_u * size
    ys = p_v * size
    points = np.stack([xs, ys], axis=1)
    # Visibility: camera looks at -Z in cam space, so z_cam < 0 is in
    # front. cam = w2c @ point; z_cam = (w2c @ [p;1])[2].
    cam_z = (w2c @ j_h.T)[2, :]
    in_front = cam_z < 0
    in_frame = (p_u >= 0) & (p_u <= 1) & (p_v >= 0) & (p_v <= 1)
    return points, (in_front & in_frame)


def render_skeleton_for_camera(w2c, proj_mtx, size=1024,
                               limb_width=10, joint_radius=8,
                               draw_invisible=False):
    """Render an OpenPose body_18 skeleton image for the given camera.

    Matches the style of scripts/_make_back_skeleton.py: black BG,
    colored limbs, colored joint circles.

    Args:
        w2c, proj_mtx: 4x4 numpy arrays.
        size: output image side length (px).
        limb_width, joint_radius: drawing dimensions.
        draw_invisible: if True, draw limbs even when one endpoint is
                        behind the camera or OOB. Default False for
                        cleaner conditioning.

    Returns: PIL.Image in RGB mode.
    """
    from PIL import Image, ImageDraw
    img = Image.new('RGB', (size, size), (0, 0, 0))
    draw = ImageDraw.Draw(img)
    points, visible = project_joints(w2c, proj_mtx, size=size)
    # Draw limbs first, joints on top
    for li, (a, b) in enumerate(LIMBS):
        if not draw_invisible and (not visible[a] or not visible[b]):
            continue
        pa = tuple(points[a])
        pb = tuple(points[b])
        draw.line([pa, pb], fill=COLORS[li % len(COLORS)], width=limb_width)
    for ki in range(len(points)):
        if not draw_invisible and not visible[ki]:
            continue
        x, y = points[ki]
        c = COLORS[ki % len(COLORS)]
        draw.ellipse([x - joint_radius, y - joint_radius,
                      x + joint_radius, y + joint_radius], fill=c)
    return img


if __name__ == '__main__':
    # Smoke test: render the 6 canonical voie-B cameras and dump PNGs
    # to scripts/_debug_skeletons/ so we can eyeball alignment.
    import os
    import math
    out_dir = os.path.join(os.path.dirname(__file__), '_debug_skeletons')
    os.makedirs(out_dir, exist_ok=True)

    # Reproduce MVAdapter's get_c2w + get_orthogonal_projection_matrix
    # standalone (no torch needed).
    def _get_c2w(azim_mva_deg, elev_deg, distance):
        az = math.radians(azim_mva_deg)
        el = math.radians(elev_deg)
        cp = np.array([
            distance * math.cos(el) * math.cos(az),
            distance * math.cos(el) * math.sin(az),
            distance * math.sin(el),
        ])
        up = np.array([0.0, 0.0, 1.0])
        lookat = -cp / (np.linalg.norm(cp) + 1e-10)
        right = np.cross(lookat, up)
        n = np.linalg.norm(right)
        if n < 1e-6:
            right = np.array([1.0, 0.0, 0.0])
        else:
            right = right / n
        new_up = np.cross(right, lookat)
        R = np.stack([right, new_up, -lookat], axis=-1)  # 3x3
        c2w = np.eye(4)
        c2w[:3, :3] = R
        c2w[:3, 3] = cp
        return c2w

    def _get_ortho_proj(L, R, B, T, near=0.1, far=100.0):
        m = np.zeros((4, 4))
        m[0, 0] = 2 / (R - L)
        m[1, 1] = -2 / (T - B)
        m[2, 2] = -2 / (far - near)
        m[0, 3] = -(R + L) / (R - L)
        m[1, 3] = -(T + B) / (T - B)
        m[2, 3] = -(far + near) / (far - near)
        m[3, 3] = 1.0
        return m

    # FabMesh logical view list
    views = [
        ('view_0_front',  0,   0),
        ('view_1_right',  90,  0),
        ('view_2_back',   180, 0),
        ('view_3_left',   270, 0),
        ('view_4_top',    0,   89.99),
        ('view_5_bottom', 0,   -89.99),
    ]
    proj = _get_ortho_proj(-0.55, 0.55, -0.55, 0.55)
    for name, logical_azim, elev in views:
        mva_azim = logical_azim - 90  # MVAdapter convention
        c2w = _get_c2w(mva_azim, elev, 1.8)
        w2c = np.linalg.inv(c2w)
        img = render_skeleton_for_camera(w2c, proj, size=1024)
        path = os.path.join(out_dir, f'{name}.png')
        img.save(path)
        print(f'wrote {path}')
