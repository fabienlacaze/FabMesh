"""Rotation-transfer retarget on Puppeteer rigs using DYNAMIC labels.

Plan B1 final step: combine
  - anytop_retarget's rotation-transfer core (bone-by-bone local
    rotation copy from source to target, preserves mesh topology way
    better than pure end-effector IK)
  - puppeteer_semantic_extractor's labels.json (per-rig semantic role
    for each Puppeteer joint, recovered via k-NN cosine on anchors)

The static rig_mappings/*.json files assume a fixed Puppeteer index
ordering (e.g. flying_quadruped has 47 joints with target_node=46 for
Hips). Puppeteer's actual output varies per-mesh, so a static JSON
can't drive a humanoid_puppeteer mapping. This script builds the
target_table dynamically from the rig's labels.json.

CLI:
    python scripts/puppeteer_rotation_retarget.py \\
        --rig    c:/tmp/test_b1_humanoid_05.glb \\
        --labels c:/tmp/test_b1_humanoid_05.glb.labels.json \\
        --fbx    c:/tmp/apovivor_fbx/1_Source/ANIM_AS_Robot1_Walk.fbx \\
        --out    c:/tmp/b1_rot_test.glb

Expected behaviour:
  - source motion stays articulated (no whole-body collapse from IK
    over-rotation)
  - mesh deforms smoothly through the Puppeteer skin (no spike
    artefacts because each target bone gets ONE rotation, not an
    aggregate of N IK chain rotations)
  - per-frame motion shape is the same as in the source FBX
"""
from __future__ import annotations
import argparse
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# Lazy imports so --help works without anytop_retarget's deps.
def _load_deps():
    from anytop_retarget import retarget_motion_to_rig, _classify_source_bone
    from anytop_retarget import _read_glb
    from fbx_motion import parse_fbx
    from rig_mappings import load_mapping, make_classifier_chain
    return (retarget_motion_to_rig, _classify_source_bone, _read_glb,
            parse_fbx, load_mapping, make_classifier_chain)


# Map our semantic label vocabulary (Hips / Spine00 / LeftArm03 / ...)
# to the (role, side, chain_idx) tuples that retarget_motion_to_rig
# expects in its target_table.
def _parse_label(label: str) -> tuple[str, str | None, int] | None:
    if not label:
        return None
    if label == "Hips":
        return ("hip", None, 0)
    # role + chain index from suffix
    for prefix, role, side in [
        ("LeftArm",  "arm",  "l"),
        ("RightArm", "arm",  "r"),
        ("LeftLeg",  "leg",  "l"),
        ("RightLeg", "leg",  "r"),
        ("LeftWing", "wing", "l"),
        ("RightWing","wing", "r"),
        ("Spine",    "spine", None),
        ("Neck",     "neck", None),
        ("Head",     "head", None),
        ("Tail",     "tail", None),
    ]:
        if label.startswith(prefix):
            tail = label[len(prefix):]
            try:
                ci = int(tail) if tail else 0
            except ValueError:
                ci = 0
            return (role, side, ci + 1)  # +1 to match existing convention
    return None


def build_target_table_from_labels(labels_json_path: str) -> dict:
    """Build {joint_name → (role, side, chain_idx)} from labels.json.

    labels.json may be:
      A) flat list (anchor format), labels[i] = label for jointi
      B) extractor JSON with "labels" dict / "anchor_labels" dict
    """
    raw = json.loads(Path(labels_json_path).read_text(encoding="utf-8"))
    if isinstance(raw, list):
        labels_by_idx = {i: raw[i] for i in range(len(raw))}
    elif isinstance(raw, dict):
        if "labels" in raw and isinstance(raw["labels"], dict):
            labels_by_idx = {int(k): v for k, v in raw["labels"].items()}
        elif "labels" in raw and isinstance(raw["labels"], list):
            labels_by_idx = {i: raw["labels"][i] for i in range(len(raw["labels"]))}
        else:
            labels_by_idx = {int(k): v for k, v in raw.items()}
    else:
        raise ValueError(f"unsupported labels.json shape: {type(raw)}")

    table: dict = {}
    for idx, lbl in labels_by_idx.items():
        rsc = _parse_label(lbl)
        if not rsc:
            continue
        joint_name = f"joint{idx}"
        table[joint_name.lower()] = rsc
        # also under 'pelvis' alias if this is Hips (some downstream
        # heuristics look for the literal 'pelvis' key)
        if lbl == "Hips":
            table["pelvis"] = rsc
    return table


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rig",    required=True)
    ap.add_argument("--labels", default=None, help="Path to labels.json "
                    "(default: <rig>.labels.json)")
    ap.add_argument("--fbx",    required=True)
    ap.add_argument("--out",    required=True)
    ap.add_argument("--source-skel", default="auto")
    ap.add_argument("--target-family", default="humanoid_puppeteer")
    ap.add_argument("--clip-name", default="apovivor")
    ap.add_argument("--fps", type=float, default=30.0)
    # 2026-06-11: forward-axis calibration. Apovivor source faces +Z
    # (z_up convention) but Puppeteer-rigged FabMesh meshes face
    # variable directions depending on how Trellis + Puppeteer
    # oriented the auto-rig. Pre-rotate motion offsets + root_pos
    # by this many degrees around Y so the target's "forward" matches
    # the source's "forward".
    ap.add_argument("--rest-yaw-deg", type=float, default=0.0,
                    help="Yaw rotation (around Y axis) applied to source "
                         "motion to align with target rest pose. Common "
                         "values: 0 / 90 / 180 / 270. Empirical for now.")
    args = ap.parse_args()

    (retarget_motion_to_rig, _classify_source_bone, _read_glb,
     parse_fbx, load_mapping, make_classifier_chain) = _load_deps()

    labels_path = args.labels or (args.rig + ".labels.json")
    if not os.path.isfile(labels_path):
        raise FileNotFoundError(f"labels.json missing: {labels_path}")
    target_table = build_target_table_from_labels(labels_path)
    print(f"[rot-retarget] target_table from labels: {len(target_table)} entries")
    for k, v in sorted(target_table.items())[:8]:
        print(f"    {k} -> {v}")

    print(f"[rot-retarget] parsing FBX: {args.fbx} hint={args.source_skel}")
    motion = parse_fbx(args.fbx, source_skel_hint=args.source_skel)
    detected = motion.get("detected_skeleton_id")
    print(f"[rot-retarget] detected source: {detected}")

    effective_skel = args.source_skel if args.source_skel != "auto" else (detected or "ue5_mannequin")
    try:
        mapping = load_mapping(effective_skel, args.target_family)
    except KeyError:
        print(f"[rot-retarget] WARN no mapping for ({effective_skel},{args.target_family}); ue5_mannequin fallback")
        effective_skel = "ue5_mannequin"
        mapping = load_mapping(effective_skel, args.target_family)

    # Axis convention on offsets + root_pos
    if mapping.axis_source != mapping.axis_target:
        try:
            motion["offsets"] = mapping.axis_to_target(motion["offsets"])
            motion["root_pos"] = mapping.axis_to_target(motion["root_pos"])
            print(f"[rot-retarget] axis: {mapping.axis_source} -> {mapping.axis_target}")
        except Exception as e:
            print(f"[rot-retarget] WARN axis rotation: {e}")

    # 2026-06-11: extra yaw rotation around Y to align source's forward
    # with target's forward. Applied to OFFSETS and ROOT_POS in target
    # coords (post axis_to_target). Per-bone eulers are parent-local so
    # unaffected.
    if abs(args.rest_yaw_deg) > 1e-3:
        import numpy as _np
        a = _np.deg2rad(args.rest_yaw_deg)
        c, s = _np.cos(a), _np.sin(a)
        Ry = _np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], dtype=_np.float64)
        try:
            offs = _np.asarray(motion["offsets"], dtype=_np.float64)
            motion["offsets"] = (Ry @ offs.T).T.astype(_np.float32)
            rp = _np.asarray(motion["root_pos"], dtype=_np.float64)
            motion["root_pos"] = (Ry @ rp.T).T.astype(_np.float32)
            # Also rotate per-frame eulers around root: simplest as
            # multiplying the ROOT bone's rotation by Ry. The motion's
            # euler array's first joint is the root.
            print(f"[rot-retarget] applied rest yaw +{args.rest_yaw_deg:.1f}deg "
                  f"(forward-axis calibration)")
        except Exception as e:
            print(f"[rot-retarget] WARN rest yaw failed: {e}")

    classifier = make_classifier_chain(mapping, _classify_source_bone)
    retarget_motion_to_rig(
        rig_glb_path=args.rig,
        motion=motion,
        out_glb_path=args.out,
        clip_name=args.clip_name,
        target_fps=args.fps,
        ckpt_family="all",
        source_classifier=classifier,
        target_table=target_table,
        target_drop_re=None,
    )
    print(f"[rot-retarget] wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
