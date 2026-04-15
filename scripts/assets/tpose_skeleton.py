"""
FabMesh T-pose skeleton generator (OpenPose format) for ControlNet guidance.

Outputs a 1024×1024 RGB image with colored bones + keypoints in the
standard OpenPose COCO 18-keypoint layout, which xinsir's SDXL OpenPose
ControlNet is trained on.

Run once to produce `tpose_skeleton.png` next to this file. The
juggernaut bridge loads that PNG as the control_image when the user
prompt asks for a T-pose character.

Coordinate convention (normalized [0,1] then scaled to target size):
  nose           (0.50, 0.20)
  neck           (0.50, 0.28)
  R_shoulder     (0.38, 0.30)
  R_elbow        (0.22, 0.30)
  R_wrist        (0.08, 0.30)   ← arms fully extended horizontally
  L_shoulder     (0.62, 0.30)
  L_elbow        (0.78, 0.30)
  L_wrist        (0.92, 0.30)   ← arms fully extended horizontally
  R_hip          (0.42, 0.55)
  R_knee         (0.42, 0.72)
  R_ankle        (0.42, 0.92)
  L_hip          (0.58, 0.55)
  L_knee         (0.58, 0.72)
  L_ankle        (0.58, 0.92)
  R_eye          (0.47, 0.18)
  L_eye          (0.53, 0.18)
  R_ear          (0.45, 0.20)
  L_ear          (0.55, 0.20)
"""
from PIL import Image, ImageDraw
import os


def build_tpose_skeleton(size: int = 1024) -> Image.Image:
    W = H = size
    img = Image.new('RGB', (W, H), (0, 0, 0))
    d = ImageDraw.Draw(img)

    # Keypoints normalized coords
    kpts_norm = {
        'nose':       (0.50, 0.20),
        'neck':       (0.50, 0.28),
        'r_shoulder': (0.38, 0.30),
        'r_elbow':    (0.22, 0.30),
        'r_wrist':    (0.08, 0.30),
        'l_shoulder': (0.62, 0.30),
        'l_elbow':    (0.78, 0.30),
        'l_wrist':    (0.92, 0.30),
        'r_hip':      (0.42, 0.55),
        'r_knee':     (0.42, 0.72),
        'r_ankle':    (0.42, 0.92),
        'l_hip':      (0.58, 0.55),
        'l_knee':     (0.58, 0.72),
        'l_ankle':    (0.58, 0.92),
        'r_eye':      (0.47, 0.18),
        'l_eye':      (0.53, 0.18),
        'r_ear':      (0.45, 0.20),
        'l_ear':      (0.55, 0.20),
    }
    kpts = {k: (int(x * W), int(y * H)) for k, (x, y) in kpts_norm.items()}

    # Bones — (from, to, color) in OpenPose standard RGB palette
    # (colors from openpose's renderPoseKeypointsCpu defaults)
    bones = [
        ('neck',       'r_shoulder', (153,   0,   0)),
        ('neck',       'l_shoulder', (153,  51,   0)),
        ('r_shoulder', 'r_elbow',    (153, 102,   0)),
        ('r_elbow',    'r_wrist',    (153, 153,   0)),
        ('l_shoulder', 'l_elbow',    (102, 153,   0)),
        ('l_elbow',    'l_wrist',    ( 51, 153,   0)),
        ('neck',       'r_hip',      (  0, 153,   0)),
        ('r_hip',      'r_knee',     (  0, 153,  51)),
        ('r_knee',     'r_ankle',    (  0, 153, 102)),
        ('neck',       'l_hip',      (  0, 153, 153)),
        ('l_hip',      'l_knee',     (  0, 102, 153)),
        ('l_knee',     'l_ankle',    (  0,  51, 153)),
        ('neck',       'nose',       (  0,   0, 153)),
        ('nose',       'r_eye',      ( 51,   0, 153)),
        ('nose',       'l_eye',      (102,   0, 153)),
        ('r_eye',      'r_ear',      (153,   0, 153)),
        ('l_eye',      'l_ear',      (153,   0, 102)),
    ]

    # Bone thickness ~3% of W (OpenPose ControlNet expects thick limbs)
    th = max(6, int(W * 0.03))
    for a, b, col in bones:
        d.line([kpts[a], kpts[b]], fill=col, width=th)

    # Joint dots
    joint_col = (255, 255, 255)
    r = max(4, int(W * 0.012))
    for k, (x, y) in kpts.items():
        d.ellipse([x - r, y - r, x + r, y + r], fill=joint_col)

    return img


if __name__ == '__main__':
    out_dir = os.path.dirname(os.path.abspath(__file__))
    img = build_tpose_skeleton(1024)
    out_path = os.path.join(out_dir, 'tpose_skeleton.png')
    img.save(out_path)
    print(f'wrote: {out_path}')
