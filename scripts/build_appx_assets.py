"""
Generate Microsoft Store APPX tile assets from the existing
build/store_assets/ logos. Run once before `npm run build:msix`.

Why this script exists
----------------------
Microsoft Store rejected MyFabmesh.AI under policy 10.1.1.11 ("On
Device Tiles") because the APPX package shipped with electron-builder's
generic placeholder tiles (a gray X) — the cert team flagged them as
"default image, does not uniquely represent product".

electron-builder 26 picks tile icons from `buildResources` (which is
`build/` by default — see `build.directories.buildResources` in
package.json). The seven PNGs below must sit directly at the root of
that folder with the exact names Microsoft expects, otherwise the
APPX pipeline falls back to its generic placeholder tiles.

(Earlier electron-builder docs mentioned `appx.assetsDir`. That
option was REMOVED in 26.x; passing it now triggers a
ValidationError. The buildResources convention replaces it.)

Sizes & files produced (in build/):
    StoreLogo.png            50  x 50
    Square44x44Logo.png      44  x 44   (Start menu small tile + taskbar)
    Square71x71Logo.png      71  x 71   (Small Start tile)
    Square150x150Logo.png    150 x 150  (Medium Start tile)
    Square310x310Logo.png    310 x 310  (Large Start tile)
    Wide310x150Logo.png      310 x 150  (Wide Start tile — synthesised from the square logo + brand bg)
    SplashScreen.png         620 x 300  (App splash on launch)

Source images (must exist):
    build/store_assets/icon_1080x1080.png  (master hi-res logo)
    build/store_assets/promo_2400x1200.png (optional — used to seed SplashScreen)

Usage:
    python scripts/build_appx_assets.py
"""
from __future__ import annotations

from pathlib import Path
import sys

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    print("[build_appx_assets] Pillow not installed. Install with: pip install Pillow")
    sys.exit(1)


ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "build" / "store_assets"
# electron-builder 26 reads APPX tile icons directly from the
# buildResources root (= `build/`), not from a sub-folder.
OUT_DIR = ROOT / "build"

# Brand colour also used as the appx backgroundColor in package.json.
# We pad the wide tile + splash with this so the logo sits on the same
# colour as the Start menu badge background.
BRAND_BG = (11, 11, 20)  # #0b0b14


def _load(name: str) -> Image.Image:
    p = SRC_DIR / name
    if not p.exists():
        raise FileNotFoundError(f"Missing source asset: {p}")
    img = Image.open(p).convert("RGBA")
    return img


def _resize_square(src: Image.Image, size: int) -> Image.Image:
    return src.resize((size, size), Image.LANCZOS)


def _logo_on_canvas(src: Image.Image, canvas_w: int, canvas_h: int,
                    logo_scale: float = 0.7) -> Image.Image:
    """Centre the (square) logo on a brand-coloured canvas. Used for
    Wide310x150 and SplashScreen where we don't want to letterbox the
    icon — instead we keep the logo square and pad with brand bg."""
    bg = Image.new("RGBA", (canvas_w, canvas_h), BRAND_BG + (255,))
    logo_side = int(min(canvas_w, canvas_h) * logo_scale)
    logo = src.resize((logo_side, logo_side), Image.LANCZOS)
    offset = ((canvas_w - logo_side) // 2, (canvas_h - logo_side) // 2)
    bg.paste(logo, offset, logo)
    return bg


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Master logo. Prefer the 1080×1080 hi-res master; fall back to 358
    # if the master isn't available.
    master_path = SRC_DIR / "icon_1080x1080.png"
    if not master_path.exists():
        master_path = SRC_DIR / "icon_358x358.png"
    if not master_path.exists():
        print(f"[build_appx_assets] No master logo found in {SRC_DIR}")
        return 1
    master = Image.open(master_path).convert("RGBA")
    print(f"[build_appx_assets] Using master logo: {master_path.name} ({master.size[0]}x{master.size[1]})")

    # Square tiles — direct resize of the master.
    squares = {
        "StoreLogo.png":          50,
        "Square44x44Logo.png":    44,
        "Square71x71Logo.png":    71,
        "Square150x150Logo.png":  150,
        "Square310x310Logo.png":  310,
    }
    for name, size in squares.items():
        out = _resize_square(master, size)
        out_path = OUT_DIR / name
        out.save(out_path, "PNG")
        print(f"  -> {name} ({size}x{size})")

    # Wide tile — logo centred on brand-bg canvas. Logo scaled to 70%
    # of the short side so it's visible but not crammed edge-to-edge.
    wide = _logo_on_canvas(master, 310, 150, logo_scale=0.85)
    wide.save(OUT_DIR / "Wide310x150Logo.png", "PNG")
    print("  -> Wide310x150Logo.png (310x150)")

    # SplashScreen — prefer the existing 2400x1200 promo if available
    # (it already has the dark brand bg + centred logo), otherwise
    # synthesise from the master.
    promo_path = SRC_DIR / "promo_2400x1200.png"
    if promo_path.exists():
        promo = Image.open(promo_path).convert("RGBA")
        splash = promo.resize((620, 300), Image.LANCZOS)
        print(f"  -> SplashScreen.png (620x300, from {promo_path.name})")
    else:
        splash = _logo_on_canvas(master, 620, 300, logo_scale=0.6)
        print("  -> SplashScreen.png (620x300, synthesised)")
    splash.save(OUT_DIR / "SplashScreen.png", "PNG")

    print(f"\n[build_appx_assets] Done. Files written to: {OUT_DIR}")
    print("Next: npm run build:msix")
    return 0


if __name__ == "__main__":
    sys.exit(main())
