"""Batch FBX -> BVH converter for AnyTop dataset ingest.

Walks an input directory, finds every .fbx, and invokes Blender headlessly
to export it as a BVH. Output naming follows the Truebones convention
that AnyTop's data loader expects:

    <CharacterName>_<ActionName>.bvh

where:
- CharacterName is derived from the FBX path (parent folder name, OR
  prefix stripped from filename — see derive_names()).
- ActionName is the residual filename in snake_case with the _RM
  (root motion) suffix stripped.

The script is layout-tolerant. Two common layouts:

  A) Flat per-character dirs:
        input/dragon/ANIM_MOUNTAIN_DRAGON_walk.fbx
        input/orc/AS_Orc_M1_Run.fbx
     -> CharacterName comes from parent folder, with a prefix-stripping
        pass to remove the species token already in the filename.

  B) Flat single-character dir:
        input/AS_Orc_M1_Run.fbx
        input/AS_Orc_M1_Walk.fbx
     -> CharacterName comes from a common filename prefix (longest run
        of "WORD_" tokens shared by all .fbx in the dir).

Usage:
    python scripts/batch_fbx_to_bvh.py \
        --input  c:/tmp/apovivor_fbx \
        --output c:/tmp/anytop_pure/dataset/truebones/zoo/Truebone_Z-OO

Optional:
    --blender "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe"
    --worker  c:/tmp/fbx_to_bvh_blender_worker.py
    --jobs    1     (Blender is heavy; serial is safer for 1500+ files)
    --skip-existing (default: True)
    --dry-run

One Blender subprocess per FBX — clean state, no datablock leaks across
files. Adds ~3-5 s of Blender startup per file but is the only reliable
pattern at 1500+ files.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List, Tuple

DEFAULT_BLENDER = r"C:/Program Files/Blender Foundation/Blender 5.1/blender.exe"
DEFAULT_WORKER = r"c:/tmp/fbx_to_bvh_blender_worker.py"


# --------------------------------------------------------------------------- #
# Name derivation
# --------------------------------------------------------------------------- #

_CAMEL_RE = re.compile(r"(?<!^)(?=[A-Z])")
_MULTI_US_RE = re.compile(r"_+")


def snake_case(name: str) -> str:
    """CamelCase / PascalCase / spaced -> snake_case, single-underscore."""
    name = name.replace(" ", "_").replace("-", "_")
    name = _CAMEL_RE.sub("_", name)
    name = _MULTI_US_RE.sub("_", name)
    return name.strip("_").lower()


def to_character_name(token: str) -> str:
    """Folder/prefix token -> PascalCase character name for the BVH filename.

    'mountain_dragon' / 'MOUNTAIN_DRAGON' / 'Mountain Dragon' -> 'MountainDragon'
    'AS_Orc_M1'                                              -> 'AsOrcM1'
    """
    token = token.replace("-", "_").replace(" ", "_")
    parts = [p for p in token.split("_") if p]
    return "".join(p.capitalize() if p.islower() or p.isupper() else p for p in parts)


def longest_common_prefix(strings: List[str]) -> str:
    """Longest character prefix shared by every string in `strings`.

    Used to detect a species prefix on flat-dir FBX collections.
    """
    if not strings:
        return ""
    s1, s2 = min(strings), max(strings)
    i = 0
    while i < len(s1) and i < len(s2) and s1[i] == s2[i]:
        i += 1
    return s1[:i]


def trim_to_word_boundary(prefix: str) -> str:
    """Trim a longest-common-prefix string back to its last underscore.

    'AS_Orc_M1_R' -> 'AS_Orc_M1_'  (so we keep whole tokens only)
    """
    if "_" not in prefix:
        return ""
    return prefix[: prefix.rfind("_") + 1]


def derive_action_label(stem: str, species_prefix: str = "") -> str:
    """Given an FBX stem and an optional species prefix, derive the action label.

    - Strip species prefix from the front (case-insensitive).
    - Strip _RM (root motion) suffix.
    - Strip leading ANIM_ if present.
    - snake_case the rest.
    """
    rest = stem
    if species_prefix and rest.lower().startswith(species_prefix.lower()):
        rest = rest[len(species_prefix):]
    rest = re.sub(r"^ANIM_", "", rest, flags=re.IGNORECASE)
    rest = re.sub(r"_RM$", "", rest, flags=re.IGNORECASE)
    rest = rest.strip("_")
    return snake_case(rest) or "anim"


# --------------------------------------------------------------------------- #
# Grouping FBX by character
# --------------------------------------------------------------------------- #


def group_fbx_by_character(input_root: Path) -> Dict[str, List[Tuple[Path, str]]]:
    """Walk input_root and group every .fbx by derived CharacterName.

    Returns: {CharacterName: [(fbx_path, action_label), ...]}

    Per-character logic:
      - All FBX inside one folder are considered one character group.
      - CharacterName preference: parent folder name (if not 'input' root)
        else longest common filename prefix.
      - If the parent-folder name matches the filename prefix, we strip
        that prefix from action labels so 'AS_Orc_M1_Run' -> 'run'.
    """
    by_dir: Dict[Path, List[Path]] = {}
    for fbx in input_root.rglob("*.fbx"):
        by_dir.setdefault(fbx.parent, []).append(fbx)

    groups: Dict[str, List[Tuple[Path, str]]] = {}

    for d, fbxs in by_dir.items():
        fbxs.sort()
        stems = [p.stem for p in fbxs]

        # Find a stable species prefix from the filenames.
        common = trim_to_word_boundary(longest_common_prefix(stems))

        # The Truebones convention treats 'ANIM' as a generic action-file
        # marker, not part of the species name. Strip it when present.
        species_prefix = common
        common_for_name = re.sub(r"^ANIM_", "", common, flags=re.IGNORECASE)

        # Pick the character name.
        if d != input_root:
            folder_token = d.name
            char_name = to_character_name(folder_token)
        else:
            # Flat dir at the root: derive char name from common prefix.
            if common_for_name:
                char_name = to_character_name(common_for_name.rstrip("_"))
            else:
                # No common prefix and no folder distinction — fall back to
                # the input dir name.
                char_name = to_character_name(input_root.name)
                species_prefix = ""

        for fbx, stem in zip(fbxs, stems):
            action = derive_action_label(stem, species_prefix)
            groups.setdefault(char_name, []).append((fbx, action))

    return groups


# --------------------------------------------------------------------------- #
# Conversion
# --------------------------------------------------------------------------- #


def convert_one(
    blender: str,
    worker: str,
    fbx_path: Path,
    bvh_path: Path,
    timeout_s: int = 180,
) -> Tuple[bool, str]:
    """Spawn Blender to convert one FBX. Returns (ok, last_stdout_line)."""
    cmd = [
        blender,
        "-b",
        "--python", worker,
        "--",
        str(fbx_path),
        str(bvh_path),
    ]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )
    except subprocess.TimeoutExpired:
        return False, f"timeout after {timeout_s}s"

    out = (proc.stdout or "") + (proc.stderr or "")
    # Look for our worker's signal lines.
    last = ""
    for line in out.splitlines():
        if "[BVH_OK]" in line or "[BVH_ERR]" in line:
            last = line.strip()
    if proc.returncode == 0 and bvh_path.exists() and bvh_path.stat().st_size > 0:
        return True, last or f"ok ({bvh_path.stat().st_size} bytes)"
    return False, last or f"exit={proc.returncode}"


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", required=True, type=Path, help="Root directory of FBX files.")
    ap.add_argument("--output", required=True, type=Path, help="Root directory where BVH files will be written.")
    ap.add_argument("--blender", default=DEFAULT_BLENDER, help=f"Path to Blender executable (default: {DEFAULT_BLENDER}).")
    ap.add_argument("--worker", default=DEFAULT_WORKER, help=f"Path to Blender Python worker script (default: {DEFAULT_WORKER}).")
    ap.add_argument("--skip-existing", action="store_true", default=True, help="Skip outputs that already exist (default: on).")
    ap.add_argument("--no-skip-existing", dest="skip_existing", action="store_false", help="Re-convert even if output exists.")
    ap.add_argument("--per-character-subdir", action="store_true", help="Write BVH into output/<CharacterName>/ instead of flat output dir.")
    ap.add_argument("--timeout", type=int, default=180, help="Per-FBX Blender timeout in seconds (default: 180).")
    ap.add_argument("--dry-run", action="store_true", help="List the planned conversions without running Blender.")
    ap.add_argument("--limit", type=int, default=0, help="Process at most N FBX (0 = all). Useful for smoke tests.")
    args = ap.parse_args()

    input_root = args.input.resolve()
    output_root = args.output.resolve()

    if not input_root.is_dir():
        print(f"[ERR] input dir does not exist: {input_root}")
        return 2
    if not Path(args.blender).is_file():
        print(f"[ERR] blender not found: {args.blender}")
        return 2
    if not Path(args.worker).is_file():
        print(f"[ERR] worker script not found: {args.worker}")
        return 2

    output_root.mkdir(parents=True, exist_ok=True)

    print(f"[INFO] scanning {input_root} ...")
    groups = group_fbx_by_character(input_root)

    total = sum(len(v) for v in groups.values())
    if total == 0:
        print("[ERR] no .fbx files found.")
        return 1

    print(f"[INFO] found {total} fbx across {len(groups)} character group(s):")
    for char, items in sorted(groups.items()):
        print(f"  - {char}: {len(items)} clip(s)")

    # Plan list: (fbx_path, bvh_path, character, action)
    plan: List[Tuple[Path, Path, str, str]] = []
    seen_outputs: set = set()
    for char, items in sorted(groups.items()):
        for fbx, action in items:
            out_name = f"{char}_{action}.bvh"
            if args.per_character_subdir:
                out_path = output_root / char / out_name
            else:
                out_path = output_root / out_name
            # De-duplicate when _RM variants collapse onto the same action name.
            if out_path in seen_outputs:
                # Pick the non-_RM variant deterministically; keep the first.
                continue
            seen_outputs.add(out_path)
            plan.append((fbx, out_path, char, action))

    if args.limit > 0:
        plan = plan[: args.limit]

    print(f"[INFO] planned conversions after dedup: {len(plan)}")

    if args.dry_run:
        for fbx, out, char, action in plan[:20]:
            tag = "EXISTS" if out.exists() else "PLAN  "
            print(f"  [{tag}] {char}/{action}  <-  {fbx.name}")
        if len(plan) > 20:
            print(f"  ... (+{len(plan) - 20} more)")
        return 0

    ok = 0
    skipped = 0
    failed: List[Tuple[Path, str]] = []
    t0 = time.time()

    for i, (fbx, out, char, action) in enumerate(plan, 1):
        if args.skip_existing and out.exists() and out.stat().st_size > 0:
            skipped += 1
            if i % 50 == 0 or i == len(plan):
                elapsed = time.time() - t0
                print(f"  [{i}/{len(plan)}] (skip) {char}/{action}  elapsed={elapsed:.0f}s")
            continue

        out.parent.mkdir(parents=True, exist_ok=True)
        t_one = time.time()
        success, msg = convert_one(args.blender, args.worker, fbx, out, timeout_s=args.timeout)
        dt = time.time() - t_one

        if success:
            ok += 1
            avg = (time.time() - t0) / i
            eta = avg * (len(plan) - i)
            print(f"  [{i}/{len(plan)}] OK   {char}/{action}  ({dt:.1f}s, eta={eta/60:.1f}min)")
        else:
            failed.append((fbx, msg))
            print(f"  [{i}/{len(plan)}] FAIL {char}/{action}  ({dt:.1f}s)  {msg}")

    elapsed = time.time() - t0
    print()
    print(f"=== batch_fbx_to_bvh: done in {elapsed/60:.1f} min ===")
    print(f"  converted : {ok}")
    print(f"  skipped   : {skipped}")
    print(f"  failed    : {len(failed)}")
    print(f"  output    : {output_root}")
    if failed:
        print("  failures (first 10):")
        for f, m in failed[:10]:
            print(f"    - {f.name}: {m}")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
