"""Pure-math quality scorer for retargeted GLB animations.

Reads an animated GLB and returns a JSON quality report covering 6
metrics that flag common Rokoko / Puppeteer retargeting failure modes:

  1. SYMMETRY        — L/R limb quaternion variance match
  2. FOOT_CONTACT    — feet actually touch the ground regularly
  3. BONE_LENGTH     — bone distances preserved across frames
  4. REST_DRIFT      — frame 0 pose matches the bind pose
  5. MOTION_RANGE    — L/R limb total angular motion balance
  6. AABB_STABILITY  — no sudden bone-bbox jumps (jitter / NaN frames)

The scorer is pure math — no Blender, no rendering, no GPU. It depends
only on numpy + pygltflib, and reuses parse_glb_skeleton() from
auto_label_rig.py for rest-pose joint extraction.

CLI:

  python scripts/judge_retarget.py <glb> \\
      [--labels labels.json] \\
      [--clip CLIP_NAME] \\
      [--out report.json] \\
      [--samples N] \\
      [--quiet]

Output JSON layout (also printed to stdout):

  {
    "glb": "<path>",
    "frames": 30,
    "bones_count": 22,
    "score": 78.3,
    "metrics": {
      "symmetry":       { "score": 0.85, "pairs_checked": 4, "flags": [...] },
      "foot_contact":   { "score": 1.00, "contacts_per_sec": 2.4, "flags": [] },
      "bone_length":    { "score": 0.92, "max_std_ratio": 0.04, "flags": [] },
      "rest_drift":     { "score": 0.78, "pct_drifted": 0.18, "flags": [] },
      "motion_range":   { "score": 0.65, "pairs_checked": 4, "flags": [...] },
      "aabb_stability": { "score": 0.99, "jump_frame_ratio": 0.01, "flags": [] }
    },
    "red_flags": ["foot never lands", ...],
    "verdict": "GOOD" | "OK" | "BAD"
  }
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

# Reuse parse_glb_skeleton from auto_label_rig (same project).
HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
from auto_label_rig import parse_glb_skeleton, auto_label  # noqa: E402


# ===========================================================================
# GLB animation sampler
# ===========================================================================
def _read_accessor(g, blob: bytes, idx: int) -> np.ndarray:
    """Decode a glTF accessor into a numpy array (count, type_size)."""
    acc = g.accessors[idx]
    bv = g.bufferViews[acc.bufferView]
    offset = (bv.byteOffset or 0) + (acc.byteOffset or 0)
    dtype_map = {5126: np.float32, 5123: np.uint16,
                 5125: np.uint32, 5121: np.uint8}
    dt = dtype_map[acc.componentType]
    type_size = {"SCALAR": 1, "VEC2": 2, "VEC3": 3,
                 "VEC4": 4, "MAT4": 16}[acc.type]
    raw = np.frombuffer(blob, dtype=dt,
                        count=acc.count * type_size, offset=offset)
    if acc.type != "SCALAR":
        raw = raw.reshape(acc.count, type_size)
    return raw.astype(np.float32)


def _slerp(qa: np.ndarray, qb: np.ndarray, t: float) -> np.ndarray:
    """Spherical LERP between two xyzw quaternions."""
    d = float(np.dot(qa, qb))
    if d < 0:
        qb = -qb
        d = -d
    if d > 0.9995:
        r = qa + t * (qb - qa)
        n = np.linalg.norm(r)
        return r / n if n > 1e-9 else qa
    omega = math.acos(max(-1.0, min(1.0, d)))
    so = math.sin(omega)
    if so < 1e-9:
        return qa
    return (math.sin((1 - t) * omega) / so) * qa \
        + (math.sin(t * omega) / so) * qb


def _lerp(va: np.ndarray, vb: np.ndarray, t: float) -> np.ndarray:
    return va + t * (vb - va)


def _sample_track(track: dict, time: float, kind: str) -> np.ndarray:
    times = track["times"]
    values = track["values"]
    if time <= times[0]:
        return values[0].copy()
    if time >= times[-1]:
        return values[-1].copy()
    idx = int(np.searchsorted(times, time))
    t0, t1 = times[idx - 1], times[idx]
    u = float((time - t0) / max(t1 - t0, 1e-9))
    v0, v1 = values[idx - 1], values[idx]
    if kind == "rotation":
        return _slerp(v0, v1, u)
    return _lerp(v0, v1, u)


def _quat_xyzw_to_mat3(q: np.ndarray) -> np.ndarray:
    x, y, z, w = q
    return np.array([
        [1 - 2 * (y*y + z*z), 2 * (x*y - z*w),     2 * (x*z + y*w)],
        [2 * (x*y + z*w),     1 - 2 * (x*x + z*z), 2 * (y*z - x*w)],
        [2 * (x*z - y*w),     2 * (y*z + x*w),     1 - 2 * (x*x + y*y)],
    ], dtype=np.float64)


def sample_animation(glb_path: Path, clip_name: str | None = None,
                     n_samples: int = 30) -> dict:
    """Sample the richest animation in the GLB at n_samples uniform times.

    Returns dict with:
      bone_idxs       : list of skin.joints node indices (joint_idx order)
      bone_names      : list of node names
      parent_of_joint : {joint_idx: parent_joint_idx} (parents-in-joint-space)
      world_pos       : (frames, n_bones, 3) world translations per frame
      world_quat_wxyz : (frames, n_bones, 4) world rotations (wxyz)
      local_quat_xyzw : (frames, n_bones, 4) local rotations (xyzw)
      duration        : seconds
      frame_time      : seconds per frame
      bind_world_pos  : (n_bones, 3) world bind translations
    """
    from pygltflib import GLTF2

    g = GLTF2().load(str(glb_path))
    blob = g.binary_blob()
    if not g.skins:
        raise RuntimeError(f"{glb_path}: no skin")
    skin = g.skins[0]
    bone_idxs = list(skin.joints)
    nodes = g.nodes
    bone_names = [(nodes[i].name or f"node_{i}") for i in bone_idxs]
    idx_by_node = {ni: k for k, ni in enumerate(bone_idxs)}

    # Parent (in joint-index space) — walk node-parent up until we hit
    # another bone, matches the convention used by auto_label_rig.
    parent_of_node: dict[int, int] = {}
    for pi, p in enumerate(nodes):
        for c in (p.children or []):
            parent_of_node[c] = pi

    parent_of_joint: dict[int, int] = {}
    for k, ni in enumerate(bone_idxs):
        p_node = parent_of_node.get(ni, -1)
        while p_node >= 0 and p_node not in idx_by_node:
            p_node = parent_of_node.get(p_node, -1)
        parent_of_joint[k] = idx_by_node[p_node] if p_node in idx_by_node else -1

    # Rest local TRS
    rest_t = np.zeros((len(bone_idxs), 3))
    rest_r = np.tile(np.array([0, 0, 0, 1.0]), (len(bone_idxs), 1))  # xyzw
    rest_s = np.ones((len(bone_idxs), 3))
    for k, ni in enumerate(bone_idxs):
        n = nodes[ni]
        if n.translation:
            rest_t[k] = n.translation
        if n.rotation:
            rest_r[k] = n.rotation  # xyzw
        if n.scale:
            rest_s[k] = n.scale

    # Bind world positions: prefer inverseBindMatrices if present.
    bind_world_pos = np.zeros((len(bone_idxs), 3))
    if skin.inverseBindMatrices is not None:
        ibm_flat = _read_accessor(g, blob, skin.inverseBindMatrices)
        ibm = ibm_flat.reshape(len(bone_idxs), 4, 4).astype(np.float64)
        # glTF stores column-major
        ibm = np.transpose(ibm, (0, 2, 1))
        for k in range(len(bone_idxs)):
            try:
                world = np.linalg.inv(ibm[k])
                bind_world_pos[k] = world[:3, 3]
            except np.linalg.LinAlgError:
                pass
    else:
        # Fallback: walk rest TRS up the tree (FK at rest)
        order = _topo_order(parent_of_joint)
        world_T = np.zeros((len(bone_idxs), 3))
        world_R = [None] * len(bone_idxs)
        for k in order:
            R = _quat_xyzw_to_mat3(rest_r[k])
            S = np.diag(rest_s[k])
            local_M = R @ S
            p = parent_of_joint[k]
            if p < 0:
                world_R[k] = local_M
                world_T[k] = rest_t[k]
            else:
                world_R[k] = world_R[p] @ local_M
                world_T[k] = world_T[p] + world_R[p] @ rest_t[k]
        bind_world_pos = world_T

    # Pick the animation
    if not g.animations:
        # Static GLB — return frame=1 of bind pose
        return {
            "bone_idxs": bone_idxs,
            "bone_names": bone_names,
            "parent_of_joint": parent_of_joint,
            "world_pos": bind_world_pos[None, :, :].copy(),
            "world_quat_wxyz": np.tile(np.array([1, 0, 0, 0]),
                                       (1, len(bone_idxs), 1)).astype(float),
            "local_quat_xyzw": rest_r[None, :, :].copy(),
            "duration": 0.0,
            "frame_time": 0.0,
            "bind_world_pos": bind_world_pos,
            "no_animation": True,
        }

    if clip_name:
        anim = next((a for a in g.animations if a.name == clip_name), None)
        if anim is None:
            anim = max(g.animations, key=lambda a: len(a.channels))
    else:
        anim = max(g.animations, key=lambda a: len(a.channels))

    # Collect per-node tracks
    tracks: dict[int, dict[str, dict]] = {}
    for ch in anim.channels:
        node_i = ch.target.node
        path = ch.target.path
        if node_i is None:
            continue
        samp = anim.samplers[ch.sampler]
        times = _read_accessor(g, blob, samp.input)
        values = _read_accessor(g, blob, samp.output)
        if node_i not in tracks:
            tracks[node_i] = {}
        tracks[node_i][path] = {
            "times": times.astype(float),
            "values": values.astype(float).reshape(len(times), -1),
            "interp": samp.interpolation or "LINEAR",
        }

    if not tracks:
        # animation present but no usable channels
        return {
            "bone_idxs": bone_idxs,
            "bone_names": bone_names,
            "parent_of_joint": parent_of_joint,
            "world_pos": bind_world_pos[None, :, :].copy(),
            "world_quat_wxyz": np.tile(np.array([1, 0, 0, 0]),
                                       (1, len(bone_idxs), 1)).astype(float),
            "local_quat_xyzw": rest_r[None, :, :].copy(),
            "duration": 0.0,
            "frame_time": 0.0,
            "bind_world_pos": bind_world_pos,
            "no_animation": True,
        }

    duration = 0.0
    for node_tracks in tracks.values():
        for t in node_tracks.values():
            duration = max(duration, float(t["times"][-1]))
    duration = max(duration, 1e-3)
    sample_times = np.linspace(0.0, duration, n_samples)

    order = _topo_order(parent_of_joint)

    world_pos = np.zeros((n_samples, len(bone_idxs), 3))
    world_quat_wxyz = np.zeros((n_samples, len(bone_idxs), 4))
    world_quat_wxyz[..., 0] = 1.0
    local_quat_xyzw = np.tile(rest_r, (n_samples, 1, 1))

    for f, time in enumerate(sample_times):
        local_T = rest_t.copy()
        local_R_xyzw = rest_r.copy()
        local_S = rest_s.copy()
        for k, ni in enumerate(bone_idxs):
            if ni in tracks:
                tr = tracks[ni]
                if "translation" in tr:
                    local_T[k] = _sample_track(tr["translation"], time,
                                               "translation")
                if "rotation" in tr:
                    local_R_xyzw[k] = _sample_track(tr["rotation"], time,
                                                    "rotation")
                if "scale" in tr:
                    local_S[k] = _sample_track(tr["scale"], time, "scale")

        local_quat_xyzw[f] = local_R_xyzw

        world_R = [None] * len(bone_idxs)
        world_T = np.zeros((len(bone_idxs), 3))
        for k in order:
            R = _quat_xyzw_to_mat3(local_R_xyzw[k])
            S = np.diag(local_S[k])
            local_M = R @ S
            p = parent_of_joint[k]
            if p < 0:
                world_R[k] = local_M
                world_T[k] = local_T[k]
            else:
                world_R[k] = world_R[p] @ local_M
                world_T[k] = world_T[p] + world_R[p] @ local_T[k]
            # store world quat (wxyz) — extract from world_R via SVD-stable
            world_quat_wxyz[f, k] = _mat3_to_quat_wxyz(world_R[k])
        world_pos[f] = world_T

    return {
        "bone_idxs": bone_idxs,
        "bone_names": bone_names,
        "parent_of_joint": parent_of_joint,
        "world_pos": world_pos,
        "world_quat_wxyz": world_quat_wxyz,
        "local_quat_xyzw": local_quat_xyzw,
        "duration": float(duration),
        "frame_time": float(duration / max(n_samples - 1, 1)),
        "bind_world_pos": bind_world_pos,
        "no_animation": False,
    }


def _topo_order(parent_of_joint: dict[int, int]) -> list[int]:
    """Return joint indices in parents-before-children order."""
    n = len(parent_of_joint)
    children: dict[int, list[int]] = {}
    roots: list[int] = []
    for k, p in parent_of_joint.items():
        if p < 0:
            roots.append(k)
        else:
            children.setdefault(p, []).append(k)
    order: list[int] = []
    stack = list(roots)
    visited: set[int] = set()
    while stack:
        k = stack.pop(0)
        if k in visited:
            continue
        visited.add(k)
        order.append(k)
        for c in children.get(k, []):
            stack.append(c)
    # In rare cases (orphan bones), append remaining
    for k in range(n):
        if k not in visited:
            order.append(k)
    return order


def _mat3_to_quat_wxyz(R: np.ndarray) -> np.ndarray:
    """Convert a 3x3 rotation-ish matrix to a wxyz quaternion (Shepperd's method,
    SVD-orthogonalized first so it survives scale baked into R).
    """
    # Orthogonalize via SVD to strip non-uniform scale before extracting quat.
    try:
        U, _, Vt = np.linalg.svd(R)
        Rn = U @ Vt
        if np.linalg.det(Rn) < 0:
            U[:, -1] *= -1
            Rn = U @ Vt
    except np.linalg.LinAlgError:
        Rn = R
    m = Rn
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        w = 0.25 * s
        x = (m[2, 1] - m[1, 2]) / s
        y = (m[0, 2] - m[2, 0]) / s
        z = (m[1, 0] - m[0, 1]) / s
    elif (m[0, 0] > m[1, 1]) and (m[0, 0] > m[2, 2]):
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        w = (m[2, 1] - m[1, 2]) / s
        x = 0.25 * s
        y = (m[0, 1] + m[1, 0]) / s
        z = (m[0, 2] + m[2, 0]) / s
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        w = (m[0, 2] - m[2, 0]) / s
        x = (m[0, 1] + m[1, 0]) / s
        y = 0.25 * s
        z = (m[1, 2] + m[2, 1]) / s
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        w = (m[1, 0] - m[0, 1]) / s
        x = (m[0, 2] + m[2, 0]) / s
        y = (m[1, 2] + m[2, 1]) / s
        z = 0.25 * s
    q = np.array([w, x, y, z], dtype=np.float64)
    n = np.linalg.norm(q)
    return q / n if n > 1e-9 else np.array([1.0, 0.0, 0.0, 0.0])


# ===========================================================================
# L/R pair detection from role labels
# ===========================================================================
LIMB_PAIR_PREFIXES = [
    ("LeftArm00", "RightArm00"),
    ("LeftArm01", "RightArm01"),
    ("LeftArm02", "RightArm02"),
    ("LeftArm03", "RightArm03"),
    ("LeftLeg00", "RightLeg00"),
    ("LeftLeg01", "RightLeg01"),
    ("LeftLeg02", "RightLeg02"),
    ("LeftLeg03", "RightLeg03"),
    ("LeftLeg04", "RightLeg04"),
    # Quadruped variants
    ("FrontLeftLeg00", "FrontRightLeg00"),
    ("FrontLeftLeg01", "FrontRightLeg01"),
    ("FrontLeftFoot", "FrontRightFoot"),
    ("BackLeftLeg00", "BackRightLeg00"),
    ("BackLeftLeg01", "BackRightLeg01"),
    ("BackLeftFoot", "BackRightFoot"),
    # Winged biped
    ("LeftWing00", "RightWing00"),
    ("LeftWing01", "RightWing01"),
    ("LeftWing02", "RightWing02"),
]

FOOT_LABELS = {
    # humanoid feet/toes
    "LeftLeg03", "RightLeg03", "LeftLeg04", "RightLeg04",
    # quadruped feet
    "FrontLeftFoot", "FrontRightFoot", "BackLeftFoot", "BackRightFoot",
}


def _index_labels_to_joint(labels: dict[int, str]) -> dict[str, int]:
    """{role -> joint_idx}; only the first match wins."""
    out: dict[str, int] = {}
    for k, v in labels.items():
        if v not in out:
            out[v] = k
    return out


# ===========================================================================
# METRIC 1 — SYMMETRY
# ===========================================================================
def metric_symmetry(quat_stream_wxyz: np.ndarray,
                    labels: dict[int, str]) -> dict:
    """For each L/R pair, compare std of quat stream over time. Score per
    pair = 1 - |std_L - std_R| / max(std_L, std_R).
    """
    role_to_idx = _index_labels_to_joint(labels)
    flags: list[str] = []
    pair_scores: list[float] = []
    pairs_checked = 0
    for L, R in LIMB_PAIR_PREFIXES:
        if L not in role_to_idx or R not in role_to_idx:
            continue
        li = role_to_idx[L]
        ri = role_to_idx[R]
        ql = quat_stream_wxyz[:, li, :]  # (frames, 4)
        qr = quat_stream_wxyz[:, ri, :]
        a = float(np.linalg.norm(np.std(ql, axis=0)))
        b = float(np.linalg.norm(np.std(qr, axis=0)))
        denom = max(a, b, 1e-9)
        # If both sides are essentially static (no motion at all), call it
        # perfectly symmetric — but flag in a meta line so caller can warn.
        if a < 1e-6 and b < 1e-6:
            sym = 1.0
        else:
            sym = 1.0 - abs(a - b) / denom
        sym = max(0.0, min(1.0, sym))
        pair_scores.append(sym)
        pairs_checked += 1
        if sym < 0.7:
            flags.append(f"{L} vs {R}: symmetry={sym:.2f}")
    if pairs_checked == 0:
        return {"score": 1.0, "pairs_checked": 0,
                "flags": ["no L/R pairs found in labels"]}
    return {
        "score": float(np.mean(pair_scores)),
        "pairs_checked": pairs_checked,
        "flags": flags,
    }


# ===========================================================================
# METRIC 2 — FOOT_CONTACT
# ===========================================================================
def metric_foot_contact(world_pos: np.ndarray, labels: dict[int, str],
                        duration: float) -> dict:
    """For each foot bone, count frames where Y is near the floor."""
    role_to_idx = _index_labels_to_joint(labels)
    foot_indices = [role_to_idx[r] for r in FOOT_LABELS if r in role_to_idx]
    flags: list[str] = []
    if not foot_indices:
        return {"score": 1.0, "contacts_per_sec": None, "feet_found": 0,
                "flags": ["no foot bones in labels"]}

    n_frames = world_pos.shape[0]
    if n_frames < 2 or duration <= 0:
        return {"score": 0.0, "contacts_per_sec": 0.0,
                "feet_found": len(foot_indices),
                "flags": ["static animation"]}

    # Floor = global min Y across foot bones across all frames.
    foot_y = world_pos[:, foot_indices, 1]
    y_min = float(foot_y.min())
    # Range over the entire rig, not just feet, for a robust threshold.
    rig_y = world_pos[..., 1]
    y_range = float(rig_y.max() - rig_y.min())
    if y_range < 1e-6:
        y_range = 1.0
    contact_thresh = y_min + 0.15 * y_range

    # A frame counts as a "contact event" for foot F if foot_y[F] <
    # contact_thresh AND previous frame foot_y[F] >= contact_thresh
    # (rising-edge detection => we count discrete strikes, not slides).
    total_contacts = 0
    for fi, foot_idx in enumerate(foot_indices):
        col = foot_y[:, fi]
        below = col < contact_thresh
        # Rising-edge detection: previously above, now below.
        # Also count frame 0 if it starts below.
        strikes = int(np.sum(below[1:] & ~below[:-1])) + int(below[0])
        total_contacts += strikes

    contacts_per_sec = total_contacts / max(duration, 1e-3)

    # Expected baseline: >=2 contacts per second across all feet combined.
    # Score is linear ramp 0 -> 1 between 0 and 2 contacts/sec.
    score = float(min(1.0, contacts_per_sec / 2.0))
    if total_contacts == 0:
        flags.append("foot never lands")
    elif contacts_per_sec < 2.0:
        flags.append(
            f"low foot-contact rate ({contacts_per_sec:.1f}/s, expected >=2)")
    return {
        "score": score,
        "contacts_per_sec": float(contacts_per_sec),
        "total_contacts": int(total_contacts),
        "feet_found": len(foot_indices),
        "flags": flags,
    }


# ===========================================================================
# METRIC 3 — BONE_LENGTH
# ===========================================================================
def metric_bone_length(world_pos: np.ndarray,
                       parent_of_joint: dict[int, int],
                       bone_names: list[str]) -> dict:
    """For each (parent, child) bone, std/mean of distance should be small."""
    flags: list[str] = []
    ratios: list[float] = []
    pairs: list[tuple[int, int]] = [
        (c, p) for c, p in parent_of_joint.items() if p >= 0
    ]
    if not pairs:
        return {"score": 1.0, "bones_checked": 0,
                "max_std_ratio": 0.0, "flags": []}
    for c, p in pairs:
        d = np.linalg.norm(world_pos[:, c, :] - world_pos[:, p, :], axis=1)
        mean = float(d.mean())
        if mean < 1e-6:
            continue
        ratio = float(d.std() / mean)
        ratios.append(ratio)
        if ratio > 0.10:
            flags.append(f"{bone_names[c]} bone length std/mean={ratio:.2f}")
    if not ratios:
        return {"score": 1.0, "bones_checked": 0,
                "max_std_ratio": 0.0, "flags": flags}
    max_ratio = float(max(ratios))
    # Score: 1.0 at ratio<=0.05, linear down to 0 at ratio=0.20.
    score = float(max(0.0, min(1.0, 1.0 - (max_ratio - 0.05) / 0.15)))
    return {
        "score": score,
        "bones_checked": len(ratios),
        "max_std_ratio": max_ratio,
        "mean_std_ratio": float(np.mean(ratios)),
        "flags": flags,
    }


# ===========================================================================
# METRIC 4 — REST_DRIFT
# ===========================================================================
def metric_rest_drift(world_pos: np.ndarray,
                      bind_world_pos: np.ndarray,
                      bone_names: list[str]) -> dict:
    """Compare FK at frame 0 vs bind pose. Drift > 5% rig bbox diag = drifted.
    Flag if > 30% of bones drift.
    """
    flags: list[str] = []
    n_bones = world_pos.shape[1]
    bbox_min = bind_world_pos.min(axis=0)
    bbox_max = bind_world_pos.max(axis=0)
    diag = float(np.linalg.norm(bbox_max - bbox_min))
    if diag < 1e-6:
        diag = 1.0
    diffs = np.linalg.norm(world_pos[0] - bind_world_pos, axis=1)
    pct_per_bone = diffs / diag
    drifted = int(np.sum(pct_per_bone > 0.05))
    drift_ratio = float(drifted / max(n_bones, 1))
    if drift_ratio > 0.30:
        worst_idx = int(np.argmax(pct_per_bone))
        flags.append(
            f"{drift_ratio*100:.0f}% of bones drift from bind pose "
            f"(worst: {bone_names[worst_idx]} at "
            f"{pct_per_bone[worst_idx]*100:.1f}% of diag)")
    # Score: 1.0 at 0% drift, 0.0 at 50% drift, linear in between.
    score = float(max(0.0, min(1.0, 1.0 - drift_ratio / 0.50)))
    return {
        "score": score,
        "pct_drifted": drift_ratio,
        "bones_drifted": drifted,
        "bones_total": n_bones,
        "rig_diag": diag,
        "max_drift_pct": float(pct_per_bone.max()),
        "flags": flags,
    }


# ===========================================================================
# METRIC 5 — MOTION_RANGE
# ===========================================================================
def _quat_angle_between(q1_wxyz: np.ndarray, q2_wxyz: np.ndarray) -> float:
    """Angle in radians between two unit quaternions (wxyz)."""
    d = float(abs(np.dot(q1_wxyz, q2_wxyz)))
    d = max(-1.0, min(1.0, d))
    return 2.0 * math.acos(d)


def metric_motion_range(local_quat_xyzw: np.ndarray,
                        labels: dict[int, str]) -> dict:
    """Per labeled bone, sum quat angular delta between consecutive frames.
    Then for each L/R pair, ratio of (min / max) total motion.
    Flag if < 0.3.
    """
    role_to_idx = _index_labels_to_joint(labels)
    flags: list[str] = []
    n_frames = local_quat_xyzw.shape[0]

    # Convert xyzw -> wxyz for angle math.
    def angle_sum(joint_idx: int) -> float:
        q = local_quat_xyzw[:, joint_idx, :]
        # roll to wxyz
        qw = np.concatenate([q[:, 3:4], q[:, :3]], axis=1)
        # Normalize
        norms = np.linalg.norm(qw, axis=1, keepdims=True)
        qw = qw / np.where(norms < 1e-9, 1.0, norms)
        total = 0.0
        for f in range(1, n_frames):
            total += _quat_angle_between(qw[f - 1], qw[f])
        return float(total)

    pair_ratios: list[float] = []
    pairs_checked = 0
    for L, R in LIMB_PAIR_PREFIXES:
        if L not in role_to_idx or R not in role_to_idx:
            continue
        a = angle_sum(role_to_idx[L])
        b = angle_sum(role_to_idx[R])
        denom = max(a, b)
        if denom < 1e-6:
            # both sides truly static — neutral
            pair_ratios.append(1.0)
            pairs_checked += 1
            continue
        ratio = min(a, b) / denom
        pair_ratios.append(float(ratio))
        pairs_checked += 1
        if ratio < 0.3:
            flags.append(
                f"{L} vs {R}: motion ratio={ratio:.2f} "
                f"(L={a:.2f} rad, R={b:.2f} rad)")
    if pairs_checked == 0:
        return {"score": 1.0, "pairs_checked": 0,
                "flags": ["no L/R pairs found in labels"]}
    return {
        "score": float(np.mean(pair_ratios)),
        "pairs_checked": pairs_checked,
        "min_pair_ratio": float(min(pair_ratios)),
        "flags": flags,
    }


# ===========================================================================
# METRIC 6 — AABB_STABILITY
# ===========================================================================
def metric_aabb_stability(world_pos: np.ndarray) -> dict:
    """Compute the bone bbox volume (or diagonal length) per frame. A jump
    > 30% of mean between consecutive frames = jitter. Flag if >5% of
    frames have such a jump.
    """
    flags: list[str] = []
    n_frames = world_pos.shape[0]
    if n_frames < 2:
        return {"score": 1.0, "jump_frame_ratio": 0.0,
                "n_jumps": 0, "flags": []}

    # Per-frame bbox diagonal
    diag = np.linalg.norm(
        world_pos.max(axis=1) - world_pos.min(axis=1), axis=1)
    mean = float(diag.mean())
    if mean < 1e-6:
        return {"score": 1.0, "jump_frame_ratio": 0.0,
                "n_jumps": 0, "flags": []}
    deltas = np.abs(np.diff(diag))
    jumps = int(np.sum(deltas > 0.30 * mean))
    nan_frames = int(np.sum(~np.isfinite(diag)))
    jump_ratio = float((jumps + nan_frames) / max(n_frames - 1, 1))
    if nan_frames > 0:
        flags.append(f"{nan_frames} NaN/Inf frames in animation")
    if jump_ratio > 0.05:
        flags.append(
            f"{jump_ratio*100:.1f}% of frames have AABB jumps >30% of mean")
    # Score: 1.0 at jump_ratio=0, 0.0 at jump_ratio=0.30, linear in between.
    score = float(max(0.0, min(1.0, 1.0 - jump_ratio / 0.30)))
    return {
        "score": score,
        "jump_frame_ratio": jump_ratio,
        "n_jumps": jumps,
        "nan_frames": nan_frames,
        "mean_diag": mean,
        "flags": flags,
    }


# ===========================================================================
# Top-level scoring
# ===========================================================================
METRIC_WEIGHTS = {
    "symmetry":       0.15,
    "foot_contact":   0.20,
    "bone_length":    0.25,
    "rest_drift":     0.15,
    "motion_range":   0.15,
    "aabb_stability": 0.10,
}


def verdict(score: float) -> str:
    if score >= 80:
        return "GOOD"
    if score >= 60:
        return "OK"
    return "BAD"


def judge(glb_path: Path,
          labels: dict[int, str] | None,
          clip_name: str | None = None,
          n_samples: int = 30,
          verbose: bool = True) -> dict:
    if verbose:
        print(f"[judge] sampling {glb_path.name} at {n_samples} frames",
              file=sys.stderr)
    samp = sample_animation(glb_path, clip_name=clip_name, n_samples=n_samples)

    if labels is None:
        # Sidecar lookup
        sidecar = Path(str(glb_path) + ".labels.json")
        if sidecar.exists():
            payload = json.loads(sidecar.read_text(encoding="utf-8"))
            raw = payload.get("labels", payload) if isinstance(
                payload, dict) else payload
            labels = {int(k): v for k, v in raw.items()
                      if not str(k).startswith("_") and isinstance(v, str)}
            if verbose:
                print(f"[judge] loaded labels sidecar {sidecar.name} "
                      f"({len(labels)} entries)", file=sys.stderr)
        else:
            # k-NN auto-label via auto_label_rig
            if verbose:
                print(f"[judge] no sidecar — running auto_label_rig",
                      file=sys.stderr)
            try:
                labels = auto_label(Path(str(glb_path) + ".pred.txt"),
                                    None,
                                    glb_fallback=glb_path)
            except Exception as e:
                if verbose:
                    print(f"[judge] auto_label failed ({e}); proceeding "
                          f"without role labels", file=sys.stderr)
                labels = {}

    metrics: dict[str, dict] = {}
    red_flags: list[str] = []

    if samp.get("no_animation"):
        # No animation track at all — everything is BAD except symmetry/length
        # which are trivially perfect.
        metrics["symmetry"] = {"score": 1.0, "pairs_checked": 0,
                               "flags": ["no animation"]}
        metrics["foot_contact"] = {"score": 0.0, "contacts_per_sec": 0.0,
                                   "flags": ["no animation"]}
        metrics["bone_length"] = {"score": 1.0, "bones_checked": 0,
                                  "max_std_ratio": 0.0,
                                  "flags": ["no animation"]}
        metrics["rest_drift"] = {"score": 1.0, "pct_drifted": 0.0,
                                 "flags": ["no animation"]}
        metrics["motion_range"] = {"score": 0.0, "pairs_checked": 0,
                                   "flags": ["no animation"]}
        metrics["aabb_stability"] = {"score": 1.0, "jump_frame_ratio": 0.0,
                                     "flags": ["no animation"]}
        red_flags.append("no animation in GLB")
    else:
        metrics["symmetry"] = metric_symmetry(
            samp["world_quat_wxyz"], labels)
        metrics["foot_contact"] = metric_foot_contact(
            samp["world_pos"], labels, samp["duration"])
        metrics["bone_length"] = metric_bone_length(
            samp["world_pos"], samp["parent_of_joint"], samp["bone_names"])
        metrics["rest_drift"] = metric_rest_drift(
            samp["world_pos"], samp["bind_world_pos"], samp["bone_names"])
        metrics["motion_range"] = metric_motion_range(
            samp["local_quat_xyzw"], labels)
        metrics["aabb_stability"] = metric_aabb_stability(samp["world_pos"])

        for m in metrics.values():
            for f in m.get("flags", []):
                red_flags.append(f)

    # Weighted aggregate
    raw_total = sum(metrics[k]["score"] * w
                    for k, w in METRIC_WEIGHTS.items())
    score = float(round(raw_total * 100.0, 1))

    return {
        "glb": str(glb_path),
        "frames": int(samp["world_pos"].shape[0]),
        "bones_count": int(samp["world_pos"].shape[1]),
        "duration_sec": float(samp["duration"]),
        "labels_count": len(labels),
        "score": score,
        "metrics": metrics,
        "red_flags": red_flags,
        "verdict": verdict(score),
    }


# ===========================================================================
# CLI
# ===========================================================================
def main() -> int:
    ap = argparse.ArgumentParser(
        description="Score the quality of a retargeted animated GLB.")
    ap.add_argument("glb", help="Path to animated GLB to evaluate.")
    ap.add_argument("--labels", default=None,
                    help="Path to labels.json (joint_idx -> role). "
                         "Default: <glb>.labels.json sidecar, then auto.")
    ap.add_argument("--clip", default=None,
                    help="Animation clip name (default: richest in GLB).")
    ap.add_argument("--out", default=None,
                    help="Write the report JSON here. Default: stdout only.")
    ap.add_argument("--samples", type=int, default=30,
                    help="Number of uniform time samples (default: 30).")
    ap.add_argument("--quiet", action="store_true",
                    help="Suppress stderr progress logs.")
    args = ap.parse_args()

    glb_path = Path(args.glb)
    if not glb_path.exists():
        print(f"ERR GLB not found: {glb_path}", file=sys.stderr)
        return 2

    labels: dict[int, str] | None = None
    if args.labels:
        raw = json.loads(Path(args.labels).read_text(encoding="utf-8"))
        if isinstance(raw, dict) and "labels" in raw:
            raw = raw["labels"]
        labels = {int(k): v for k, v in raw.items()
                  if isinstance(v, str) and not str(k).startswith("_")}

    report = judge(glb_path, labels, clip_name=args.clip,
                   n_samples=args.samples, verbose=not args.quiet)

    out_str = json.dumps(report, indent=2)
    if args.out:
        Path(args.out).write_text(out_str, encoding="utf-8")
        if not args.quiet:
            print(f"[judge] wrote {args.out}", file=sys.stderr)
    print(out_str)
    return 0


if __name__ == "__main__":
    sys.exit(main())
