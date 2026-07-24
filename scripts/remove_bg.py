"""Remove background from an image.

Primary engine: Lucida (egeorcun/lucida, MIT) — a BiRefNet fine-tune that beats
u2net on hard edges (hair/fur, glass/transparency, text/logos, glow, line-art).
Falls back to rembg/u2net if Lucida can't load (missing deps / offline), so the
tool never breaks. Output is written IN PLACE as an RGBA PNG (jpg/jpeg/webp are
converted to .png), preserving the previous contract.

Usage: python remove_bg.py <image_path>
"""
import os
import sys

from PIL import Image


def _out_path(img_path):
    base, ext = os.path.splitext(img_path)
    if ext.lower() in ('.jpg', '.jpeg', '.webp'):
        return base + '.png'
    return img_path


def _lucida(img_path, out_path):
    # lucida_matte lives next to this script; it loads egeorcun/lucida and
    # writes the RGBA cutout to out_path.
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import lucida_matte
    lucida_matte.matte(img_path, out_path)


def _u2net(img_path, out_path):
    import numpy as np
    from rembg import remove, new_session
    session = new_session("u2net")
    img = Image.open(img_path).convert("RGBA")
    Image.fromarray(np.array(remove(img, session=session))).save(out_path, 'PNG')


def main():
    if len(sys.argv) < 2:
        print("Usage: python remove_bg.py <image_path>")
        sys.exit(1)
    img_path = sys.argv[1]
    if not os.path.exists(img_path):
        print(f"REMOVEBG_ERROR: image not found: {img_path}")
        sys.exit(1)
    out_path = _out_path(img_path)

    try:
        _lucida(img_path, out_path)
        print(f"OK: {out_path}")
    except Exception as e:
        print(f"[remove_bg] primary matting engine unavailable "
              f"({type(e).__name__}: {str(e)[:120]}) — falling back", flush=True)
        _u2net(img_path, out_path)
        print(f"OK: {out_path}")


if __name__ == '__main__':
    main()
