"""Rest-pose-aware retarget: copy DELTA (source_frame - source_rest)
onto target_rest. Bypasses anytop_retarget's heavy machinery (twist
decomposition, chain proportional, damping) which masks our rest-pose
mismatch issue with default values tuned for Dragon.

Math (per matched bone, per frame):

    delta_q  = q_source_frame * conj(q_source_rest)     # source-local delta
    q_target = q_target_rest * delta_q                  # apply on target rest

Assumption: source and target T-poses have aligned bone-local frames.
For humanoid Mixamo / UE5 mannequin source vs Puppeteer Trellis target,
this should hold within a few degrees (both T-pose).

CLI:
    python scripts/puppeteer_delta_retarget.py \\
        --rig    c:/tmp/test_b1_humanoid_05.glb \\
        --labels c:/tmp/test_b1_humanoid_05.glb.labels.json \\
        --fbx    c:/tmp/apovivor_fbx/1_Source/ANIM_AS_Robot1_Walk.fbx \\
        --out    c:/tmp/b1_delta_test.glb
"""
from __future__ import annotations
import argparse
import json
import os
import struct
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


# ---------------------------------------------------------------------------
# Quaternion helpers (XYZW convention to match glTF)
# ---------------------------------------------------------------------------
def quat_mul(a, b):
    """xyzw * xyzw."""
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return np.array([
        aw*bx + ax*bw + ay*bz - az*by,
        aw*by - ax*bz + ay*bw + az*bx,
        aw*bz + ax*by - ay*bx + az*bw,
        aw*bw - ax*bx - ay*by - az*bz,
    ])


def quat_conj(q):
    return np.array([-q[0], -q[1], -q[2], q[3]])


def quat_normalize(q):
    n = np.linalg.norm(q)
    return q / (n + 1e-12)


def euler_to_quat(x_deg, y_deg, z_deg, order: str = "ZYX"):
    """Intrinsic euler -> quat (xyzw). Default ZYX = roll Z first then Y then X.
    Apovivor uses Z,X,Y order (per BVH header CHANNELS), apply that.
    """
    rx = np.deg2rad(x_deg) / 2
    ry = np.deg2rad(y_deg) / 2
    rz = np.deg2rad(z_deg) / 2
    qx = np.array([np.sin(rx), 0, 0, np.cos(rx)])
    qy = np.array([0, np.sin(ry), 0, np.cos(ry)])
    qz = np.array([0, 0, np.sin(rz), np.cos(rz)])
    # ZXY order = qz * qx * qy
    if order == "ZXY":
        return quat_mul(quat_mul(qz, qx), qy)
    if order == "ZYX":
        return quat_mul(quat_mul(qz, qy), qx)
    if order == "XYZ":
        return quat_mul(quat_mul(qx, qy), qz)
    return quat_mul(quat_mul(qz, qy), qx)


# ---------------------------------------------------------------------------
# Labels -> (role, side) per joint index (in pred.txt indexing)
# ---------------------------------------------------------------------------
def parse_label(label: str):
    """Returns (role, side, chain_idx) or None."""
    if not label:
        return None
    if label == "Hips":
        return ("hip", None, 0)
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
            return (role, side, ci)
    return None


def load_target_labels(labels_path: str) -> dict[int, tuple]:
    """Return {pred_idx -> (role, side, chain_idx)}."""
    raw = json.loads(Path(labels_path).read_text(encoding="utf-8"))
    if isinstance(raw, list):
        labels = {i: raw[i] for i in range(len(raw))}
    elif isinstance(raw, dict):
        if "labels" in raw and isinstance(raw["labels"], dict):
            labels = {int(k): v for k, v in raw["labels"].items()}
        elif "labels" in raw and isinstance(raw["labels"], list):
            labels = {i: raw["labels"][i] for i in range(len(raw["labels"]))}
        else:
            labels = {int(k): v for k, v in raw.items()}
    out = {}
    for idx, lbl in labels.items():
        rsc = parse_label(lbl)
        if rsc:
            out[idx] = rsc
    return out


# ---------------------------------------------------------------------------
# Classify source bone (Mixamo/UE5/orc_m1 conventions)
# ---------------------------------------------------------------------------
import re
_SRC_PATS = [
    (re.compile(r"(?i)(hip|pelvis|^root$|^bip01_pelvis)$"), ("hip", None)),
    (re.compile(r"(?i)thigh_l|l_thigh|l_upleg|biped_l_thigh"), ("leg", "l", 0)),
    (re.compile(r"(?i)calf_l|l_calf|l_shin|l_knee|biped_l_calf"), ("leg", "l", 1)),
    (re.compile(r"(?i)foot_l|l_foot|l_ankle|biped_l_foot"), ("leg", "l", 2)),
    (re.compile(r"(?i)toe_l|l_toe|ball_l|biped_l_toe"), ("leg", "l", 3)),
    (re.compile(r"(?i)thigh_r|r_thigh|r_upleg|biped_r_thigh"), ("leg", "r", 0)),
    (re.compile(r"(?i)calf_r|r_calf|r_shin|r_knee|biped_r_calf"), ("leg", "r", 1)),
    (re.compile(r"(?i)foot_r|r_foot|r_ankle|biped_r_foot"), ("leg", "r", 2)),
    (re.compile(r"(?i)toe_r|r_toe|ball_r|biped_r_toe"), ("leg", "r", 3)),
    (re.compile(r"(?i)upperarm_l|l_upperarm|l_arm|biped_l_upperarm|clavicle_l"), ("arm", "l", 0)),
    (re.compile(r"(?i)lowerarm_l|l_lowerarm|l_forearm|biped_l_forearm"), ("arm", "l", 1)),
    (re.compile(r"(?i)hand_l|l_hand|biped_l_hand"), ("arm", "l", 2)),
    (re.compile(r"(?i)upperarm_r|r_upperarm|r_arm|biped_r_upperarm|clavicle_r"), ("arm", "r", 0)),
    (re.compile(r"(?i)lowerarm_r|r_lowerarm|r_forearm|biped_r_forearm"), ("arm", "r", 1)),
    (re.compile(r"(?i)hand_r|r_hand|biped_r_hand"), ("arm", "r", 2)),
    (re.compile(r"(?i)^spine_\d+|^spine\d+|^spine$"), ("spine", None)),
    (re.compile(r"(?i)^neck"), ("neck", None)),
    (re.compile(r"(?i)^head"), ("head", None)),
]


_SKIP_PATTERNS = re.compile(
    r"(?i)twist|sharebone|^ik_|breast|tongue|teeth|eye|jaw|"
    r"^cc_base_facial|^cc_base_upperjaw|finger|thumb|big|index|mid|ring|pinky|toebase"
)


def classify_source(name: str):
    """Return (role, side, chain_idx) or None.

    2026-06-11 fix: skip twist / sharebone / IK control bones. Apovivor
    orc_m1 export has `cc_base_l_thightwist01/02` cousins next to the
    real `thigh_l`. The twist bones only carry roll (no swing) so
    classifying them as the leg's chain_idx 0 yielded zero retargeted
    motion (the diag showed range Z=0 for the target thigh).
    """
    if _SKIP_PATTERNS.search(name):
        return None
    for pat, *res in _SRC_PATS:
        if pat.search(name):
            r = res[0]
            if len(r) == 2:
                return (r[0], r[1], 0)
            return r
    return None


# ---------------------------------------------------------------------------
# GLB read/write helpers
# ---------------------------------------------------------------------------
def read_glb(path):
    """Return (gltf_json, bin_blob)."""
    with open(path, "rb") as f:
        magic, ver, total = struct.unpack("<III", f.read(12))
        clen, ctype = struct.unpack("<II", f.read(8))
        j = json.loads(f.read(clen))
        # padding to 4 bytes
        if clen % 4:
            f.read(4 - (clen % 4))
        # binary chunk
        try:
            blen, btype = struct.unpack("<II", f.read(8))
            bin_blob = f.read(blen)
        except Exception:
            bin_blob = b""
    return j, bin_blob


def write_glb(path, gltf_json, bin_blob):
    j_bytes = json.dumps(gltf_json, separators=(",", ":")).encode("utf-8")
    while len(j_bytes) % 4: j_bytes += b" "
    while len(bin_blob) % 4: bin_blob += b"\x00"
    total = 12 + 8 + len(j_bytes) + 8 + len(bin_blob)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(j_bytes), 0x4E4F534A))
        f.write(j_bytes)
        f.write(struct.pack("<II", len(bin_blob), 0x004E4942))
        f.write(bin_blob)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rig",    required=True)
    ap.add_argument("--labels", default=None)
    ap.add_argument("--fbx",    required=True)
    ap.add_argument("--out",    required=True)
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--euler-order", default="ZXY",
                    help="Apovivor BVH header CHANNELS lists Zrotation Xrotation Yrotation = ZXY intrinsic")
    args = ap.parse_args()

    from fbx_motion import parse_fbx

    labels_path = args.labels or (args.rig + ".labels.json")
    target_roles = load_target_labels(labels_path)
    print(f"[delta-retarget] target roles: {len(target_roles)} mapped")

    # Build target role -> joint_idx lookup
    tgt_role_to_idx = {}
    for jidx, (role, side, ci) in target_roles.items():
        tgt_role_to_idx[(role, side, ci)] = jidx

    print(f"[delta-retarget] parsing FBX {args.fbx}")
    motion = parse_fbx(args.fbx, source_skel_hint="auto")
    src_names = motion["names"]
    src_euler = motion["euler"]  # (frames, joints, 3) degrees
    src_parents = motion["parents"]
    n_frames = src_euler.shape[0]
    src_n = src_euler.shape[1]
    print(f"[delta-retarget] motion: {n_frames} frames, {src_n} bones")

    # Build source role -> idx lookup
    src_role_to_idx = {}
    for i, n in enumerate(src_names):
        r = classify_source(n)
        if r:
            src_role_to_idx[r] = i

    print(f"[delta-retarget] source bones classified: {len(src_role_to_idx)}")

    # Compute source quats per frame per bone
    src_quats = np.zeros((n_frames, src_n, 4), dtype=np.float64)
    for f in range(n_frames):
        for b in range(src_n):
            src_quats[f, b] = euler_to_quat(
                src_euler[f, b, 0], src_euler[f, b, 1], src_euler[f, b, 2],
                order=args.euler_order)

    # Source rest = frame 0
    src_rest = src_quats[0]  # (src_n, 4)

    # Load target rig and get current bind rotations
    gltf, blob = read_glb(args.rig)
    nodes = gltf["nodes"]
    # Map joint name -> node idx
    name_to_node = {n.get("name", ""): i for i, n in enumerate(nodes)}

    # Get target rest quat per labeled joint (from node's "rotation" field)
    # If absent, identity.
    def node_rest_quat(node_idx):
        n = nodes[node_idx]
        return np.array(n.get("rotation", [0, 0, 0, 1]), dtype=np.float64)

    # For each (role, side, chain_idx) mapping, transfer:
    # target_q_frame = target_rest * (src_q_frame * conj(src_rest))
    matched = 0
    mismatched = []
    tracks: dict[int, np.ndarray] = {}  # node_idx -> (n_frames, 4) quats
    for (role, side, ci_t), j_idx in tgt_role_to_idx.items():
        # Find matching source — try same chain_idx, then closest
        candidates = [(r, s, c) for (r, s, c) in src_role_to_idx.keys()
                      if r == role and s == side]
        if not candidates:
            mismatched.append((role, side, ci_t))
            continue
        # Pick the source whose chain_idx is closest to target chain_idx
        candidates.sort(key=lambda x: abs(x[2] - ci_t))
        src_key = candidates[0]
        src_b = src_role_to_idx[src_key]

        target_node = name_to_node.get(f"joint{j_idx}")
        if target_node is None:
            continue
        tgt_rest = node_rest_quat(target_node)
        # Transfer per frame
        frames = np.zeros((n_frames, 4), dtype=np.float64)
        sr_inv = quat_conj(src_rest[src_b])
        for f in range(n_frames):
            delta = quat_mul(src_quats[f, src_b], sr_inv)
            frames[f] = quat_normalize(quat_mul(tgt_rest, delta))
        tracks[target_node] = frames.astype(np.float32)
        matched += 1

    print(f"[delta-retarget] matched: {matched}, missing source: {len(mismatched)}")
    if mismatched:
        print(f"  missing roles: {mismatched[:8]}")

    # Emit GLB animation channels
    blob_list = bytearray(blob)
    accessors = gltf.setdefault("accessors", [])
    buffer_views = gltf.setdefault("bufferViews", [])
    buffers = gltf.setdefault("buffers", [{"byteLength": len(blob_list)}])

    # Times accessor (shared)
    times = np.arange(n_frames, dtype=np.float32) * (1.0 / args.fps)
    while len(blob_list) % 4: blob_list.append(0)
    t_offset = len(blob_list)
    blob_list.extend(times.tobytes())
    t_bv = {"buffer": 0, "byteOffset": t_offset, "byteLength": n_frames * 4}
    buffer_views.append(t_bv); t_bv_idx = len(buffer_views) - 1
    t_acc = {"bufferView": t_bv_idx, "componentType": 5126, "count": n_frames,
             "type": "SCALAR", "min": [float(times[0])], "max": [float(times[-1])]}
    accessors.append(t_acc); t_acc_idx = len(accessors) - 1

    channels = []
    samplers = []
    for node_idx, quats in tracks.items():
        q_offset = len(blob_list)
        blob_list.extend(quats.astype(np.float32).tobytes())
        q_bv = {"buffer": 0, "byteOffset": q_offset, "byteLength": n_frames * 16}
        buffer_views.append(q_bv); q_bv_idx = len(buffer_views) - 1
        q_acc = {"bufferView": q_bv_idx, "componentType": 5126, "count": n_frames,
                 "type": "VEC4"}
        accessors.append(q_acc); q_acc_idx = len(accessors) - 1
        sampler = {"input": t_acc_idx, "output": q_acc_idx, "interpolation": "LINEAR"}
        samplers.append(sampler); s_idx = len(samplers) - 1
        channels.append({"sampler": s_idx, "target": {"node": node_idx, "path": "rotation"}})

    anim = {"name": "delta_retarget", "samplers": samplers, "channels": channels}
    gltf["animations"] = [anim]

    buffers[0]["byteLength"] = len(blob_list)
    write_glb(args.out, gltf, bytes(blob_list))
    print(f"[delta-retarget] wrote {args.out} with {len(channels)} channels")


if __name__ == "__main__":
    main()
