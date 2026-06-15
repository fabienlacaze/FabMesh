"""Import AnyTop training GLBs as MyFabmesh projects (visible in UI).

The Electron app derives projects from /meshes/ + /images/ folders
(NOT /history/ — that's the version history per project). To appear
in the UI gallery, each (image, glb) pair needs to be placed in:

  meshes/<project>_trellis2_native_<ts>.glb
  meshes/<project>_trellis2_native_<ts>.glb.source   (text: path to image)
  images/<project>_<ts>/ref_0.png

The renderer's meshProject() filename parser strips
'_trellis2_native_*' / '_<10+ digits>' / '_rigged_*' suffixes, so all
versions of a "project" cluster together.

CLI:
    python scripts/training_import_to_fabmesh.py
    python scripts/training_import_to_fabmesh.py --dry-run
    python scripts/training_import_to_fabmesh.py --archetype quadruped
"""
from __future__ import annotations
import argparse
import shutil
import sys
import time
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
MESHES_DIR = REPO_ROOT / "meshes"
IMAGES_DIR = REPO_ROOT / "images"


def import_one(archetype: str, image_path: Path, glb_path: Path,
               ts: int, dry_run: bool = False) -> tuple[bool, str]:
    """Place one (PNG, GLB) pair in /meshes/ + /images/ so it shows in
    the UI under project name 'training_<archetype>_<glb_stem>'."""
    base = f"training_{archetype}_{glb_path.stem}"
    # The "_trellis2_native_<ts>" suffix gets stripped by meshProject()
    # so all post-process versions of the same source mesh cluster.
    mesh_target = MESHES_DIR / f"{base}_trellis2_native_{ts}.glb"
    source_target = MESHES_DIR / f"{base}_trellis2_native_{ts}.glb.source"
    img_folder = IMAGES_DIR / f"{base}_{ts}"
    img_target = img_folder / "ref_0.png"

    if mesh_target.exists():
        return (False, "already imported")

    if dry_run:
        return (True, f"would create {mesh_target.name}")

    MESHES_DIR.mkdir(parents=True, exist_ok=True)
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    img_folder.mkdir(parents=True, exist_ok=True)

    # Copy reference image
    if image_path.exists():
        shutil.copyfile(image_path, img_target)

    # Copy mesh + write .source pointer
    shutil.copyfile(glb_path, mesh_target)
    source_target.write_text(str(img_target).replace("/", "\\"), encoding="utf-8")

    return (True, f"-> {mesh_target.name}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--meshes", default="c:/tmp/training_meshes")
    ap.add_argument("--refs",   default="c:/tmp/training_refs")
    ap.add_argument("--archetype", default=None)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    src_meshes = Path(args.meshes)
    src_refs   = Path(args.refs)
    archetypes = [args.archetype] if args.archetype else [
        d.name for d in src_meshes.iterdir() if d.is_dir()
    ]

    print(f"[import] -> {MESHES_DIR}")
    print(f"[import] -> {IMAGES_DIR}")
    print(f"[import] archetypes: {archetypes}")
    if args.dry_run:
        print(f"[import] DRY RUN")
    print()

    base_ts = int(time.time() * 1000)
    created = 0
    skipped = 0
    missing_img = 0
    for ai, arch in enumerate(archetypes):
        glb_dir = src_meshes / arch
        ref_dir = src_refs / arch
        if not glb_dir.exists():
            continue
        for gi, glb in enumerate(sorted(glb_dir.glob("*.glb"))):
            img = ref_dir / (glb.stem + ".png")
            if not img.exists():
                missing_img += 1
                img = Path()
            # Distinct timestamp per asset so mesh_<ts> stays unique.
            ts = base_ts + ai * 100_000 + gi
            ok, msg = import_one(arch, img, glb, ts, dry_run=args.dry_run)
            if ok:
                created += 1
                if created <= 10 or created % 10 == 0:
                    print(f"  [{created:3d}] {arch}/{glb.stem}  {msg}")
            else:
                skipped += 1

    print(f"\n[import] DONE — {created} new, {skipped} skipped, "
          f"{missing_img} missing ref image")
    if created and not args.dry_run:
        print("[import] Restart MyFabmesh (or Ctrl+R the renderer) to see them.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
