"""FBX → motion dict parser. Output shape IDENTICAL to
scripts/anytop_retarget.py:_parse_bvh() so the retarget core
(`retarget_motion_to_rig`) is reusable verbatim.

We isolate `bpy` (GPL) in a subprocess via `bpy_worker.py` so the
PARENT retarget process (Apache-2.0 compatible numpy + scipy) never
imports it. This keeps the GPL boundary clean for commercial
distribution.

Public API:
    parse_fbx(fbx_path, source_skel_hint=None) -> dict with keys
      names, parents, offsets, channels, n_frames, frame_time, euler,
      root_pos, plus an extra 'detected_skeleton_id' (str|None).

Output `euler` is degrees in CHANNELS order ('Xrotation','Yrotation',
'Zrotation'), so the existing `_eulers_to_quats` in
`anytop_retarget.py` consumes it without changes.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from typing import List, Optional

import numpy as np


_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_WORKER_PATH = os.path.join(_THIS_DIR, "bpy_worker.py")


def _detect_skeleton_id(bone_names: List[str]) -> Optional[str]:
    """Try to identify the source skeleton based on bone-name patterns.
    Returns one of the registered source_skeleton_ids (per
    `rig_mappings/_loader.fingerprint_skeleton`) or None.

    We DO NOT import the loader at module load time (the FBX parser
    may run inside a Modal container without the rig_mappings package
    mounted). Lazy import + best-effort fallback.
    """
    try:
        # Lazy import — parent process is the one running the loader.
        from rig_mappings import fingerprint_skeleton  # type: ignore
        return fingerprint_skeleton(bone_names, target_family="humanoid_puppeteer")
    except Exception:
        # Heuristic fallback if the rig_mappings package isn't on the
        # path: bone-name table match.
        names = {n.lower() for n in bone_names}
        if "cc_base_facialbone" in names and "pelvis" in names:
            return "orc_m1"
        if {"pelvis", "spine_05", "upperarm_l"}.issubset(names):
            return "ue5_mannequin"
        return None


def parse_fbx(fbx_path: str, source_skel_hint: Optional[str] = None) -> dict:
    """Parse an FBX file into a motion dict compatible with
    `anytop_retarget._parse_bvh()`'s output schema.

    Algorithm:
      1. Spawn a subprocess running `bpy_worker.py` which:
         - imports bpy
         - loads the FBX with automatic_bone_orientation=False (key:
           the default True remaps bones and breaks name-keyed lookup)
         - walks each armature in DFS order to produce names + parents
         - bakes the action with visual_keying so constraints flatten
         - reads pose_bone.matrix_basis per frame, converts to Euler ZXY
         - writes the result to a tmp JSON+NPZ pair
      2. Load the result back here, build the dict the retarget core
         expects.

    Args:
      fbx_path: absolute path to the input .fbx
      source_skel_hint: optional hint ('ue5_mannequin', 'orc_m1', or
        'auto'). When 'auto' (default if None), we run the bone-name
        fingerprint after parsing.

    Returns:
      dict with the same keys as `_parse_bvh`, plus:
        detected_skeleton_id: str | None
    """
    if not os.path.isfile(fbx_path):
        raise FileNotFoundError(fbx_path)

    work_dir = tempfile.mkdtemp(prefix="fbxmotion_")
    out_json = os.path.join(work_dir, "motion.json")
    out_npz  = os.path.join(work_dir, "motion.npz")

    if not os.path.isfile(_WORKER_PATH):
        raise RuntimeError(f"bpy_worker.py missing at {_WORKER_PATH}")

    cmd = [
        sys.executable, _WORKER_PATH,
        fbx_path, out_json, out_npz,
    ]
    print(f"[fbx_motion] spawning bpy worker: {' '.join(cmd)}", flush=True)
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=300,
    )
    if proc.returncode != 0:
        # Surface the worker's stderr in the exception so the Modal
        # function's err sentinel carries actionable debugging info
        # instead of just "exit 1".
        tail = (proc.stderr or "")[-2000:]
        raise RuntimeError(
            f"_bpy_worker exit {proc.returncode}:\n{tail}"
        )

    if not os.path.isfile(out_json) or not os.path.isfile(out_npz):
        raise RuntimeError(
            "_bpy_worker produced no output (worker says: "
            f"{(proc.stderr or proc.stdout or '')[-400:]})"
        )

    with open(out_json, "r", encoding="utf-8") as f:
        meta = json.load(f)
    npz = np.load(out_npz)

    names: List[str] = list(meta["names"])
    parents: List[int] = list(meta["parents"])
    n = len(names)
    n_frames = int(meta["n_frames"])
    frame_time = float(meta["frame_time"])

    # The worker synthesises channels per-bone — same string convention
    # the BVH parser uses so _eulers_to_quats can re-use its existing
    # axis-order parser. We pin to ZXY (bvhsdk default; matches scipy
    # intrinsic 'zxy').
    channels = [list(meta["channels_per_bone"]) for _ in range(n)]

    offsets = npz["offsets"].astype(np.float64)
    euler = npz["euler"].astype(np.float64)
    root_pos = npz["root_pos"].astype(np.float64)

    detected = _detect_skeleton_id(names)
    print(
        f"[fbx_motion] parsed: bones={n} frames={n_frames} fps={1.0/max(frame_time,1e-9):.1f} "
        f"hint={source_skel_hint!r} detected={detected!r}",
        flush=True,
    )

    return {
        "names": names,
        "parents": parents,
        "offsets": offsets,
        "channels": channels,
        "n_frames": n_frames,
        "frame_time": frame_time,
        "euler": euler,
        "root_pos": root_pos,
        "detected_skeleton_id": detected,
    }


if __name__ == "__main__":
    # Standalone CLI: `python scripts/fbx_motion.py <fbx_path>` →
    # prints a one-line summary. Used for local sanity testing.
    if len(sys.argv) < 2:
        print("usage: python fbx_motion.py <fbx_path>")
        sys.exit(2)
    m = parse_fbx(sys.argv[1])
    print(
        f"bones={len(m['names'])} frames={m['n_frames']} "
        f"detected={m['detected_skeleton_id']}"
    )
    print("first bones:", m["names"][:8])
