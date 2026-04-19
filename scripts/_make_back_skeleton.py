"""Generate a T-pose back-view OpenPose skeleton image once.
Used as ControlNet conditioning for generate_back_view.py to force the
same T-pose as the front photo regardless of IPAdapter pull.

Output: scripts/_back_tpose_skeleton.png (1024x1024)
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


def make_tpose_back(size=1024):
    img = Image.new('RGB', (size, size), (0, 0, 0))
    draw = ImageDraw.Draw(img)
    cx = size / 2
    s = size * 0.45
    pts = {
        0:  (cx, cx - s * 0.78),
        1:  (cx, cx - s * 0.55),
        2:  (cx + s * 0.18, cx - s * 0.50),
        3:  (cx + s * 0.55, cx - s * 0.50),
        4:  (cx + s * 0.92, cx - s * 0.50),
        5:  (cx - s * 0.18, cx - s * 0.50),
        6:  (cx - s * 0.55, cx - s * 0.50),
        7:  (cx - s * 0.92, cx - s * 0.50),
        8:  (cx + s * 0.10, cx + s * 0.05),
        9:  (cx + s * 0.10, cx + s * 0.45),
        10: (cx + s * 0.10, cx + s * 0.85),
        11: (cx - s * 0.10, cx + s * 0.05),
        12: (cx - s * 0.10, cx + s * 0.45),
        13: (cx - s * 0.10, cx + s * 0.85),
        14: (cx, cx - s * 0.78),
        15: (cx, cx - s * 0.78),
        16: (cx + s * 0.04, cx - s * 0.76),
        17: (cx - s * 0.04, cx - s * 0.76),
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
        os.path.dirname(__file__), '_back_tpose_skeleton.png')
    img = make_tpose_back()
    img.save(out)
    print(f'saved {out}')
