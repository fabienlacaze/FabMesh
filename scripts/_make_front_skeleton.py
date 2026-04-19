"""Generate a T-pose FRONT-view OpenPose skeleton image once.
Mirror of _make_back_skeleton.py but with face features (eyes, ears).
Used as ControlNet conditioning for generate_front_tpose.py to force
a strict T-pose front view regardless of IPAdapter pull.

Output: scripts/_front_tpose_skeleton.png (1024x1024)
"""
import sys
import os
from PIL import Image, ImageDraw

COLORS = [
    (255, 0, 0), (255, 85, 0), (255, 170, 0), (255, 255, 0),
    (170, 255, 0), (85, 255, 0), (0, 255, 0), (0, 255, 85),
    (0, 255, 170), (0, 255, 255), (0, 170, 255), (0, 85, 255),
    (0, 0, 255), (85, 0, 255), (170, 0, 255), (255, 0, 255),
    (255, 0, 170), (255, 0, 85),
]
LIMBS = [
    (1, 2), (1, 5), (2, 3), (3, 4), (5, 6), (6, 7),
    (1, 8), (8, 9), (9, 10), (1, 11), (11, 12), (12, 13),
    (1, 0), (0, 14), (14, 16), (0, 15), (15, 17),
]


def make_tpose_front(size=1024):
    img = Image.new('RGB', (size, size), (0, 0, 0))
    draw = ImageDraw.Draw(img)
    cx = size / 2
    s = size * 0.45
    # FRONT view: character faces the camera.
    # OpenPose convention: the SKELETON's r_shoulder (index 2) sits on
    # the IMAGE LEFT side because the character is facing us — their
    # right shoulder is our left. Same mirroring for elbow/wrist/hip etc.
    pts = {
        0:  (cx, cx - s * 0.78),                  # nose
        1:  (cx, cx - s * 0.55),                  # neck
        2:  (cx - s * 0.18, cx - s * 0.50),       # r_shoulder (image left)
        3:  (cx - s * 0.55, cx - s * 0.50),       # r_elbow
        4:  (cx - s * 0.92, cx - s * 0.50),       # r_wrist
        5:  (cx + s * 0.18, cx - s * 0.50),       # l_shoulder (image right)
        6:  (cx + s * 0.55, cx - s * 0.50),       # l_elbow
        7:  (cx + s * 0.92, cx - s * 0.50),       # l_wrist
        8:  (cx - s * 0.10, cx + s * 0.05),       # r_hip
        9:  (cx - s * 0.10, cx + s * 0.45),       # r_knee
        10: (cx - s * 0.10, cx + s * 0.85),       # r_ankle
        11: (cx + s * 0.10, cx + s * 0.05),       # l_hip
        12: (cx + s * 0.10, cx + s * 0.45),       # l_knee
        13: (cx + s * 0.10, cx + s * 0.85),       # l_ankle
        14: (cx - s * 0.04, cx - s * 0.80),       # r_eye
        15: (cx + s * 0.04, cx - s * 0.80),       # l_eye
        16: (cx - s * 0.08, cx - s * 0.76),       # r_ear
        17: (cx + s * 0.08, cx - s * 0.76),       # l_ear
    }
    for li, (a, b) in enumerate(LIMBS):
        if a in pts and b in pts:
            draw.line([pts[a], pts[b]], fill=COLORS[li], width=10)
    for ki, (x, y) in pts.items():
        c = COLORS[ki % len(COLORS)]
        draw.ellipse([x - 8, y - 8, x + 8, y + 8], fill=c)
    return img


if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(__file__), '_front_tpose_skeleton.png')
    img = make_tpose_front()
    img.save(out)
    print(f'saved {out}')
