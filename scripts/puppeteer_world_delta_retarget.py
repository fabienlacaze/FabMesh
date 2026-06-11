"""World-space delta retarget — IBM-aware canonical formula.

For each (source bone, target bone) pair, per frame:

  1. world_q_src_f    = FK on source skeleton at frame f
  2. world_q_src_rest = FK on source skeleton at REST (frame 0)
  3. world_q_delta    = world_q_src_f * conj(world_q_src_rest)
  4. world_q_tgt_rest = world rest of target bone, EXTRACTED FROM
                       skin.inverseBindMatrices (Puppeteer never
                       writes node.rotation -- the rest orientation
                       lives ENTIRELY in the IBM).
  5. world_q_tgt_f    = world_q_delta * world_q_tgt_rest
  6. local_q_tgt_f    = conj(parent_world_q_tgt_rest) * world_q_tgt_f

This is the canonical UPF-GTI / Babylon.js retargeting formula:
  trgLocal = inv(bindTrgWorldParent) * bindSrcWorldParent
                                     * srcLocal
                                     * inv(bindSrcWorld)
                                     * bindTrgWorld

The inv(bindSrcWorld) * bindTrgWorld term automatically absorbs any
source/target axis-convention differences. NO global R_axis hack is
needed -- if frame-0 of the FBX isn't a clean T-pose, the source rest
just becomes that pose and deltas remain consistent.

2026-06-11 FIX (workflow wuzh237ob): previous version read
node.rotation (always identity for Puppeteer rigs) and pre-multiplied
src_world_q by a cyclic-perm R_axis quat to compensate. That broke
L/R symmetry on distal joints. Now: target rest extracted from IBM
via SVD polar decomposition + Shepperd quat-from-matrix, R_axis
removed.

CLI:
    python scripts/puppeteer_world_delta_retarget.py \\
        --rig    c:/tmp/test_b1_humanoid_05.glb \\
        --labels c:/tmp/test_b1_humanoid_05.glb.labels.json \\
        --fbx    c:/tmp/apovivor_fbx/1_Source/ANIM_AS_Robot1_Walk.fbx \\
        --out    c:/tmp/b1_world_test.glb
"""
from __future__ import annotations
import argparse
import json
import struct
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


# ---------------------------------------------------------------------------
# Reuse helpers from delta_retarget
# ---------------------------------------------------------------------------
from puppeteer_delta_retarget import (
    quat_mul, quat_conj, quat_normalize, euler_to_quat,
    parse_label, load_target_labels, classify_source,
    read_glb, write_glb,
)


def quat_rotate_vec(q, v):
    qv = np.array([v[0], v[1], v[2], 0.0])
    return quat_mul(quat_mul(q, qv), quat_conj(q))[:3]


# ---------------------------------------------------------------------------
# IBM helpers (Puppeteer rest pose lives in inverseBindMatrices)
# ---------------------------------------------------------------------------
def _read_accessor_floats(gltf: dict, bin_blob: bytes, acc_idx: int) -> np.ndarray:
    acc = gltf["accessors"][acc_idx]
    bv = gltf["bufferViews"][acc["bufferView"]]
    offs = (bv.get("byteOffset", 0) or 0) + (acc.get("byteOffset", 0) or 0)
    cnt = acc["count"]
    typ_to_n = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
    n_per = typ_to_n.get(acc["type"], 1)
    fmt = f"<{cnt * n_per}f"
    sz = 4 * cnt * n_per
    raw = bin_blob[offs:offs + sz]
    if len(raw) < sz:
        raise RuntimeError(f"accessor {acc_idx} underflow")
    return np.asarray(struct.unpack(fmt, raw), dtype=np.float32)


def _quat_from_mat(Rm: np.ndarray) -> np.ndarray:
    """3x3 rotation -> (x,y,z,w) glTF quaternion. Shepperd's method."""
    if not np.all(np.isfinite(Rm)):
        return np.array([0.0, 0.0, 0.0, 1.0])
    tr = Rm[0, 0] + Rm[1, 1] + Rm[2, 2]
    if tr > 0.0:
        s = np.sqrt(tr + 1.0) * 2.0
        w = 0.25 * s
        x = (Rm[2, 1] - Rm[1, 2]) / s
        y = (Rm[0, 2] - Rm[2, 0]) / s
        z = (Rm[1, 0] - Rm[0, 1]) / s
    elif Rm[0, 0] > Rm[1, 1] and Rm[0, 0] > Rm[2, 2]:
        s = np.sqrt(1.0 + Rm[0, 0] - Rm[1, 1] - Rm[2, 2]) * 2.0
        w = (Rm[2, 1] - Rm[1, 2]) / s
        x = 0.25 * s
        y = (Rm[0, 1] + Rm[1, 0]) / s
        z = (Rm[0, 2] + Rm[2, 0]) / s
    elif Rm[1, 1] > Rm[2, 2]:
        s = np.sqrt(1.0 + Rm[1, 1] - Rm[0, 0] - Rm[2, 2]) * 2.0
        w = (Rm[0, 2] - Rm[2, 0]) / s
        x = (Rm[0, 1] + Rm[1, 0]) / s
        y = 0.25 * s
        z = (Rm[1, 2] + Rm[2, 1]) / s
    else:
        s = np.sqrt(1.0 + Rm[2, 2] - Rm[0, 0] - Rm[1, 1]) * 2.0
        w = (Rm[1, 0] - Rm[0, 1]) / s
        x = (Rm[0, 2] + Rm[2, 0]) / s
        y = (Rm[1, 2] + Rm[2, 1]) / s
        z = 0.25 * s
    q = np.array([x, y, z, w], dtype=np.float64)
    n = np.linalg.norm(q)
    if n < 1e-12:
        return np.array([0.0, 0.0, 0.0, 1.0])
    return q / n


# ---------------------------------------------------------------------------
# Forward kinematics — chain world rotations
# ---------------------------------------------------------------------------
def source_fk_world_quats(motion, euler_order: str = "ZXY"):
    """Return (n_frames, n_joints, 4) world-space quaternions per bone."""
    parents = motion["parents"]
    euler = motion["euler"]  # (frames, joints, 3) deg
    n_frames, n_joints = euler.shape[:2]
    Wq = np.zeros((n_frames, n_joints, 4), dtype=np.float64)
    Wq[..., 3] = 1.0  # identity init
    for f in range(n_frames):
        for b in range(n_joints):
            local = euler_to_quat(euler[f, b, 0], euler[f, b, 1],
                                  euler[f, b, 2], euler_order)
            p = parents[b]
            if p < 0:
                Wq[f, b] = local
            else:
                Wq[f, b] = quat_mul(Wq[f, p], local)
    return Wq


def target_rig_bind_world_quats(gltf, bin_blob):
    """Return ({node_idx: world_quat}, parent_of) for the target rig's
    bind (rest) pose, RECOVERED FROM skin.inverseBindMatrices.

    Puppeteer/Trellis never write node.rotation -- the rest orientation
    of every bone lives ENTIRELY in the IBM. Reading node.rotation
    returns identity for every joint, which silently collapses the
    canonical retargeting formula into the simplified
    `trgLocal = inv(srcW) * srcLocal` form that ONLY works when source
    and target bone-local frames coincide.
    """
    nodes = gltf["nodes"]
    parent_of = [-1] * len(nodes)
    for pi, p in enumerate(nodes):
        for c in (p.get("children") or []):
            parent_of[c] = pi

    # Pick the skin (assume one; matches Puppeteer output)
    skins = gltf.get("skins") or []
    if not skins:
        # Fallback to node.rotation FK (legacy behaviour for non-skinned rigs)
        return _node_rotation_fk(gltf, parent_of), parent_of

    skin = skins[0]
    joint_idxs = list(skin.get("joints") or [])
    ibm_acc = skin.get("inverseBindMatrices")
    Wq: dict[int, np.ndarray] = {}

    if ibm_acc is None:
        return _node_rotation_fk(gltf, parent_of), parent_of

    ibm_flat = _read_accessor_floats(gltf, bin_blob, ibm_acc)
    ibm_mats = np.asarray(ibm_flat).reshape(len(joint_idxs), 4, 4)
    # glTF stores column-major; transpose to row-major np convention
    ibm_mats = np.transpose(ibm_mats, (0, 2, 1))

    for k, jidx in enumerate(joint_idxs):
        try:
            world_mat = np.linalg.inv(ibm_mats[k])
            M = world_mat[:3, :3].astype(np.float64)
            # Polar-decompose to strip any scale/shear baked in by sloppy
            # rig authoring. SVD gives the closest orthonormal rotation.
            U, _, Vt = np.linalg.svd(M)
            Rmat = U @ Vt
            if np.linalg.det(Rmat) < 0:
                U[:, -1] *= -1
                Rmat = U @ Vt
            Wq[jidx] = _quat_from_mat(Rmat)
        except Exception:
            Wq[jidx] = np.array([0.0, 0.0, 0.0, 1.0])

    # Non-joint nodes (e.g. Armature root): identity world rot is fine,
    # they only contribute via translation which we don't propagate here.
    for i in range(len(nodes)):
        if i not in Wq:
            Wq[i] = np.array([0.0, 0.0, 0.0, 1.0])

    return Wq, parent_of


def _node_rotation_fk(gltf, parent_of):
    """Legacy FK from node.rotation -- only used as a fallback for rigs
    that actually populate node.rotation (not Puppeteer).
    """
    nodes = gltf["nodes"]
    roots = [i for i in range(len(nodes)) if parent_of[i] == -1]
    order, visited, stack = [], set(), list(roots)
    while stack:
        i = stack.pop(0)
        if i in visited:
            continue
        visited.add(i)
        order.append(i)
        for c in (nodes[i].get("children") or []):
            stack.append(c)
    Wq = {}
    for i in order:
        local = np.array(nodes[i].get("rotation", [0, 0, 0, 1]), dtype=np.float64)
        p = parent_of[i]
        if p < 0 or p not in Wq:
            Wq[i] = local
        else:
            Wq[i] = quat_mul(Wq[p], local)
    return Wq


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rig", required=True)
    ap.add_argument("--labels", default=None)
    ap.add_argument("--fbx", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--euler-order", default="ZXY")
    args = ap.parse_args()

    from fbx_motion import parse_fbx

    labels_path = args.labels or (args.rig + ".labels.json")
    target_roles = load_target_labels(labels_path)
    tgt_role_to_idx = {v: k for k, v in target_roles.items()}

    print(f"[world-delta] parsing FBX: {args.fbx}")
    motion = parse_fbx(args.fbx, source_skel_hint="auto")
    n_frames = motion["euler"].shape[0]
    src_n = motion["euler"].shape[1]
    print(f"[world-delta] motion: {n_frames} frames, {src_n} bones")

    # Source role -> idx
    src_role_to_idx = {}
    for i, n in enumerate(motion["names"]):
        r = classify_source(n)
        if r:
            src_role_to_idx[r] = i

    # FK source for all frames
    print(f"[world-delta] FK source ({n_frames} frames x {src_n} bones)...")
    src_world_q = source_fk_world_quats(motion, args.euler_order)

    # NOTE 2026-06-11: the previous version applied a cyclic-perm R_axis
    # rotation (R * src_W * conj(R)) here to "convert source Z-up to
    # target Y-up". That was a band-aid masking the real bug
    # (target_rig_bind_world_quats reading node.rotation = identity).
    # The canonical formula naturally absorbs axis-convention differences
    # via the (inv(src_W_rest) * tgt_W_rest) basis-change term, provided
    # tgt_W_rest is correctly extracted from IBM. R_axis REMOVED.

    # Load target rig + IBM-derived rest world quats
    gltf, blob = read_glb(args.rig)
    nodes = gltf["nodes"]
    name_to_node = {n.get("name", ""): i for i, n in enumerate(nodes)}
    tgt_bind_world_q, parent_of = target_rig_bind_world_quats(gltf, blob)
    n_nonident = sum(1 for q in tgt_bind_world_q.values()
                     if abs(q[3] - 1.0) > 1e-4 or np.linalg.norm(q[:3]) > 1e-4)
    print(f"[world-delta] target rig: {len(nodes)} nodes, "
          f"{n_nonident} bones with non-identity world rest "
          f"(should be > 12 for Puppeteer; 0 means IBM read failed)")

    tracks: dict[int, np.ndarray] = {}
    matched = 0
    for (role, side, ci_t), pred_idx in tgt_role_to_idx.items():
        candidates = [(r, s, c) for (r, s, c) in src_role_to_idx
                      if r == role and s == side]
        if not candidates:
            continue
        candidates.sort(key=lambda x: abs(x[2] - ci_t))
        src_b = src_role_to_idx[candidates[0]]
        node_idx = name_to_node.get(f"joint{pred_idx}")
        if node_idx is None:
            continue
        # Pre-fetch
        wq_src_rest = src_world_q[0, src_b]
        wq_tgt_rest = tgt_bind_world_q[node_idx]
        p_node = parent_of[node_idx]
        wq_tgt_parent_rest = (tgt_bind_world_q[p_node]
                              if p_node >= 0 else np.array([0, 0, 0, 1.0]))
        # Per frame
        frames = np.zeros((n_frames, 4), dtype=np.float64)
        for f in range(n_frames):
            wq_src_f = src_world_q[f, src_b]
            # World-space delta from source rest -> frame
            world_delta = quat_mul(wq_src_f, quat_conj(wq_src_rest))
            # Apply to target rest in world
            wq_tgt_f = quat_mul(world_delta, wq_tgt_rest)
            # Strip parent world (rest) to get local
            local = quat_mul(quat_conj(wq_tgt_parent_rest), wq_tgt_f)
            frames[f] = quat_normalize(local)
        tracks[node_idx] = frames.astype(np.float32)
        matched += 1

    print(f"[world-delta] matched: {matched}/{len(tgt_role_to_idx)}")

    # ---------------- Emit GLB animation
    blob_list = bytearray(blob)
    accessors = gltf.setdefault("accessors", [])
    buffer_views = gltf.setdefault("bufferViews", [])
    buffers = gltf.setdefault("buffers", [{"byteLength": len(blob_list)}])

    while len(blob_list) % 4: blob_list.append(0)
    t_offset = len(blob_list)
    times = (np.arange(n_frames, dtype=np.float32) / args.fps)
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

    anim = {"name": "world_delta_retarget", "samplers": samplers, "channels": channels}
    gltf["animations"] = [anim]
    buffers[0]["byteLength"] = len(blob_list)
    write_glb(args.out, gltf, bytes(blob_list))
    print(f"[world-delta] wrote {args.out} with {len(channels)} channels")


if __name__ == "__main__":
    main()
