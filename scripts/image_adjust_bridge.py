"""
FabMesh Image Adjust Bridge

Quick image adjustments equivalent to Paint.NET / Photoshop tools:
- auto_levels  : per-channel histogram stretch (like Ctrl+L in Paint.NET)
- auto_contrast: PIL ImageOps.autocontrast (cuts 1% extreme pixels)

Usage:
    python image_adjust_bridge.py <op> <input> <output>
"""
import sys
import os
import time
from PIL import Image, ImageOps


def auto_levels(img):
    """Per-channel histogram stretch: each R/G/B channel is rescaled to 0-255."""
    img = img.convert("RGB")
    bands = img.split()
    out_bands = []
    for band in bands:
        lo, hi = band.getextrema()
        if hi > lo:
            scale = 255.0 / (hi - lo)
            offset = -lo * scale
            band = band.point(lambda p, s=scale, o=offset: max(0, min(255, int(p * s + o))))
        out_bands.append(band)
    return Image.merge("RGB", out_bands)


def auto_contrast(img):
    """PIL autocontrast: cuts 1% darkest and 1% brightest pixels."""
    img = img.convert("RGB")
    return ImageOps.autocontrast(img, cutoff=1)


def main():
    if len(sys.argv) < 4:
        print("Usage: python image_adjust_bridge.py <op> <input> <output>")
        print("  op: auto_levels | auto_contrast")
        sys.exit(1)

    op = sys.argv[1]
    input_path = sys.argv[2]
    output_path = sys.argv[3]

    if not os.path.exists(input_path):
        print(f"ADJUST_ERROR: Input not found: {input_path}")
        sys.exit(1)

    print(f"ADJUST: Loading {input_path}", flush=True)
    img = Image.open(input_path)
    has_alpha = img.mode in ("RGBA", "LA")

    # Preserve alpha if present
    alpha = None
    if has_alpha:
        alpha = img.split()[-1]
        img = img.convert("RGB")

    t0 = time.time()
    if op == "auto_levels":
        out = auto_levels(img)
    elif op == "auto_contrast":
        out = auto_contrast(img)
    else:
        print(f"ADJUST_ERROR: Unknown op: {op}")
        sys.exit(1)

    if alpha is not None:
        out = out.convert("RGBA")
        out.putalpha(alpha)

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    out.save(output_path)
    print(f"ADJUST_SUCCESS: {op} done in {time.time()-t0:.2f}s -> {output_path}", flush=True)


if __name__ == "__main__":
    main()
