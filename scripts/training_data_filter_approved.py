"""Filter training dataset by the manual QC review list.

After the user reviews the 150 generated meshes via
c:/tmp/training_meshes/index.html (review UI) and clicks "Save
approved list", a `training_approved.json` file is downloaded.

This script consumes that JSON and produces a clean dataset folder
under c:/tmp/training_approved/ containing only the meshes the user
accepted — plus their reference image and rigged GLB. This is what
the AnyTop training script (Step 6) actually consumes.

Input JSON format (from index.html save button):
    {
      "accepted_count": 87,
      "rejected_count": 23,
      "accepted": ["humanoid/humanoid_00_seed42.glb", ...],
      "rejected": [...]
    }

Output structure:
    c:/tmp/training_approved/
      humanoid/
        humanoid_00_seed42.png        (reference image)
        humanoid_00_seed42.glb        (mesh)
        humanoid_00_seed42_rigged.glb (rig)
      quadruped/...
      winged_biped/...
      manifest.json                   (full list + per-arch counts)

CLI:
    python scripts/training_data_filter_approved.py
    python scripts/training_data_filter_approved.py --approved path/to/json
    python scripts/training_data_filter_approved.py --dry-run
"""
from __future__ import annotations
import argparse
import json
import shutil
import sys
import time
from pathlib import Path


REFS   = Path("c:/tmp/training_refs")
MESHES = Path("c:/tmp/training_meshes")
RIGS   = Path("c:/tmp/training_rigs")
OUT    = Path("c:/tmp/training_approved")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--approved",
                    default=str(Path.home() / "Downloads" / "training_approved.json"),
                    help="Path to JSON exported from the review UI")
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    approved_json = Path(args.approved)
    if not approved_json.exists():
        # Try a few common spots
        candidates = [
            Path.home() / "Downloads" / "training_approved.json",
            MESHES / "training_approved.json",
            Path("c:/tmp/training_approved.json"),
        ]
        for c in candidates:
            if c.exists():
                approved_json = c
                break
        else:
            print(f"[filter] cannot find training_approved.json")
            print(f"[filter] looked at: {[str(c) for c in candidates]}")
            print(f"[filter] download from the review UI first.")
            return 1

    print(f"[filter] reading {approved_json}")
    data = json.loads(approved_json.read_text(encoding="utf-8"))
    accepted = data.get("accepted", [])
    print(f"[filter] {len(accepted)} accepted, "
          f"{len(data.get('rejected', []))} rejected")

    out_root = Path(args.out)
    by_arch = {}
    copied_mesh = copied_rig = copied_png = missing_rig = missing_png = 0

    for entry in accepted:
        # entry format: "archetype/filename.glb"
        if "/" not in entry:
            continue
        arch, fname = entry.split("/", 1)
        stem = Path(fname).stem
        by_arch.setdefault(arch, []).append(stem)

        out_dir = out_root / arch
        if not args.dry_run:
            out_dir.mkdir(parents=True, exist_ok=True)

        src_mesh = MESHES / arch / fname
        src_rig  = RIGS   / arch / (stem + "_rigged.glb")
        src_png  = REFS   / arch / (stem + ".png")

        if src_mesh.exists():
            if not args.dry_run:
                shutil.copyfile(src_mesh, out_dir / fname)
            copied_mesh += 1
        if src_rig.exists():
            if not args.dry_run:
                shutil.copyfile(src_rig, out_dir / (stem + "_rigged.glb"))
            copied_rig += 1
        else:
            missing_rig += 1
        if src_png.exists():
            if not args.dry_run:
                shutil.copyfile(src_png, out_dir / (stem + ".png"))
            copied_png += 1
        else:
            missing_png += 1

    manifest = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "source_approved_json": str(approved_json),
        "total_accepted": len(accepted),
        "by_archetype": {a: len(v) for a, v in by_arch.items()},
        "items_per_archetype": by_arch,
        "stats": {
            "copied_mesh": copied_mesh,
            "copied_rig":  copied_rig,
            "copied_png":  copied_png,
            "missing_rig": missing_rig,
            "missing_png": missing_png,
        },
    }
    print(f"[filter] meshes: {copied_mesh}, rigs: {copied_rig} "
          f"(missing {missing_rig}), refs: {copied_png} (missing {missing_png})")
    print(f"[filter] per-archetype: {manifest['by_archetype']}")
    if not args.dry_run:
        manifest_path = out_root / "manifest.json"
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        print(f"[filter] wrote {manifest_path}")
        print(f"[filter] DONE — dataset ready under {out_root}")
    else:
        print(f"[filter] DRY RUN — nothing written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
