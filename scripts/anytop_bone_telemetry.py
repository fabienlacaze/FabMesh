"""Dump per-frame bone telemetry from (a) source BVH and (b) animated GLB
so we can compare what AnyTop INTENDED (BVH) vs what arrived on the
Puppeteer rig (GLB) after retarget.

Output JSON consumed by c:/tmp/viewer/bone_telemetry.html:
{
  "src": {
    "bones": ["pelvis", "spine", "wing_l_arm", ...],
    "parents": [-1, 0, 0, ...],
    "n_frames": int,
    "frames": [[[x,y,z], ...one per bone...], ...one per frame...],
    "quats": [[[w,x,y,z], ...], ...]      # local rotations
  },
  "tgt": same shape
}

Usage:
  python scripts/anytop_bone_telemetry.py \\
      --bvh c:/tmp/anytop_test_out/Dragon_rep_0_#0.bvh \\
      --glb c:/tmp/viewer/dragon_anytop_fly.glb \\
      --clip fly \\
      --out c:/tmp/viewer/bone_telemetry.json
"""
from __future__ import annotations

import argparse
import json
import re
import struct
import sys
from pathlib import Path

import numpy as np


# ---------------------------------------------------------------------------
# BVH parser (minimal, sufficient for AnyTop Truebones output)
# ---------------------------------------------------------------------------
def parse_bvh(path: str):
    """Return dict: bones[name], parents[idx], offsets[idx]=(x,y,z),
    channels[idx]=list of 'Xrotation'/'Yposition'/etc, frame_time, n_frames,
    motion[frame][total_channels]"""
    txt = Path(path).read_text(encoding="utf-8", errors="ignore")
    hier_end = txt.find("MOTION")
    if hier_end < 0:
        raise ValueError("BVH has no MOTION block")
    hierarchy = txt[:hier_end]
    motion = txt[hier_end:]

    bones, parents, offsets, channels = [], [], [], []
    stack: list[int] = []
    last_was_keyword = False

    tokens = hierarchy.replace("{", " { ").replace("}", " } ").split()
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if t in ("ROOT", "JOINT"):
            name = tokens[i + 1]
            bones.append(name)
            parents.append(stack[-1] if stack else -1)
            offsets.append((0.0, 0.0, 0.0))
            channels.append([])
            stack.append(len(bones) - 1)
            i += 2
        elif t == "End":
            # End Site — push a phantom child for offset, no channels
            i += 2  # skip "Site"
        elif t == "{":
            i += 1
        elif t == "}":
            if stack:
                stack.pop()
            i += 1
        elif t == "OFFSET":
            x, y, z = float(tokens[i + 1]), float(tokens[i + 2]), float(tokens[i + 3])
            if bones:
                offsets[len(bones) - 1] = (x, y, z)
            i += 4
        elif t == "CHANNELS":
            n = int(tokens[i + 1])
            chs = tokens[i + 2 : i + 2 + n]
            if bones:
                channels[len(bones) - 1] = chs
            i += 2 + n
        else:
            i += 1

    # Parse MOTION
    motion_lines = motion.strip().split("\n")
    n_frames = None
    frame_time = None
    motion_data: list[list[float]] = []
    for ln in motion_lines:
        ln = ln.strip()
        if ln.startswith("Frames:"):
            n_frames = int(ln.split(":")[1].strip())
        elif ln.startswith("Frame Time:"):
            frame_time = float(ln.split(":")[1].strip())
        elif ln and not ln.startswith("MOTION"):
            try:
                motion_data.append([float(x) for x in ln.split()])
            except ValueError:
                pass
    if n_frames is None:
        n_frames = len(motion_data)

    return {
        "bones": bones,
        "parents": parents,
        "offsets": offsets,
        "channels": channels,
        "n_frames": n_frames,
        "frame_time": frame_time or 1.0 / 30.0,
        "motion": motion_data,
    }


def _euler_to_mat(rx_deg: float, ry_deg: float, rz_deg: float, order: str) -> np.ndarray:
    rx, ry, rz = np.deg2rad([rx_deg, ry_deg, rz_deg])
    cx, sx = np.cos(rx), np.sin(rx)
    cy, sy = np.cos(ry), np.sin(ry)
    cz, sz = np.cos(rz), np.sin(rz)
    Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]], dtype=float)
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], dtype=float)
    Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]], dtype=float)
    mats = {"X": Rx, "Y": Ry, "Z": Rz}
    R = np.eye(3)
    for ax in order:
        R = R @ mats[ax]
    return R


def _mat_to_quat_wxyz(R: np.ndarray) -> np.ndarray:
    """Return (w,x,y,z) quaternion from a 3x3 rotation matrix."""
    m = R
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0:
        S = 2.0 * np.sqrt(tr + 1.0)
        w = 0.25 * S
        x = (m[2, 1] - m[1, 2]) / S
        y = (m[0, 2] - m[2, 0]) / S
        z = (m[1, 0] - m[0, 1]) / S
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        S = 2.0 * np.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2])
        w = (m[2, 1] - m[1, 2]) / S
        x = 0.25 * S
        y = (m[0, 1] + m[1, 0]) / S
        z = (m[0, 2] + m[2, 0]) / S
    elif m[1, 1] > m[2, 2]:
        S = 2.0 * np.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2])
        w = (m[0, 2] - m[2, 0]) / S
        x = (m[0, 1] + m[1, 0]) / S
        y = 0.25 * S
        z = (m[1, 2] + m[2, 1]) / S
    else:
        S = 2.0 * np.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1])
        w = (m[1, 0] - m[0, 1]) / S
        x = (m[0, 2] + m[2, 0]) / S
        y = (m[1, 2] + m[2, 1]) / S
        z = 0.25 * S
    return np.array([w, x, y, z], dtype=float)


def bvh_world_positions(bvh: dict) -> tuple[np.ndarray, np.ndarray]:
    """Compute per-frame world positions (F, J, 3) and local quaternions (F, J, 4)."""
    n_frames = bvh["n_frames"]
    n_bones = len(bvh["bones"])
    positions = np.zeros((n_frames, n_bones, 3), dtype=float)
    quats = np.zeros((n_frames, n_bones, 4), dtype=float)
    quats[..., 0] = 1.0  # identity w

    # Pre-compute channel offsets per bone (cumulative sum)
    chan_starts: list[int] = [0]
    for chs in bvh["channels"]:
        chan_starts.append(chan_starts[-1] + len(chs))

    for f in range(n_frames):
        frame = bvh["motion"][f] if f < len(bvh["motion"]) else bvh["motion"][-1]
        world_pos = np.zeros((n_bones, 3))
        world_rot = [np.eye(3) for _ in range(n_bones)]
        for ji, name in enumerate(bvh["bones"]):
            chs = bvh["channels"][ji]
            cs = chan_starts[ji]
            # Extract position (only root usually has Xposition)
            local_t = np.array(bvh["offsets"][ji], dtype=float)
            for k, ch in enumerate(chs):
                if ch == "Xposition":
                    local_t[0] = frame[cs + k]
                elif ch == "Yposition":
                    local_t[1] = frame[cs + k]
                elif ch == "Zposition":
                    local_t[2] = frame[cs + k]
            # Rotation: collect angles in order they appear
            rot_chs = [(k, ch) for k, ch in enumerate(chs) if ch.endswith("rotation")]
            order = "".join(ch[0] for _, ch in rot_chs)
            angles = {"X": 0.0, "Y": 0.0, "Z": 0.0}
            for k, ch in rot_chs:
                angles[ch[0]] = frame[cs + k]
            R = _euler_to_mat(angles["X"], angles["Y"], angles["Z"], order or "ZYX")
            parent = bvh["parents"][ji]
            if parent == -1:
                world_rot[ji] = R
                world_pos[ji] = local_t
            else:
                world_rot[ji] = world_rot[parent] @ R
                world_pos[ji] = world_pos[parent] + world_rot[parent] @ local_t
            quats[f, ji] = _mat_to_quat_wxyz(R)
        positions[f] = world_pos
    return positions, quats


# ---------------------------------------------------------------------------
# GLB animated bone sampler
# ---------------------------------------------------------------------------
def glb_bone_telemetry(glb_path: str, clip_name: str | None = None,
                       n_samples: int = 60) -> dict:
    """Sample per-frame world positions of every skeleton bone from a glTF
    animation clip.

    Uses pygltflib to read the file, then walks the node hierarchy with
    per-frame LERP/SLERP of the animation samplers.
    """
    from pygltflib import GLTF2

    g = GLTF2().load(glb_path)
    if not g.skins:
        raise RuntimeError("GLB has no skin")
    skin = g.skins[0]
    bone_idxs = list(skin.joints)
    nodes = g.nodes
    name_by_idx = {i: (nodes[i].name or f"node_{i}") for i in range(len(nodes))}
    bone_names = [name_by_idx[i] for i in bone_idxs]

    # Parent relationships
    parent_of: dict[int, int] = {i: -1 for i in bone_idxs}
    for parent_i in bone_idxs:
        for child_i in (nodes[parent_i].children or []):
            if child_i in bone_idxs:
                parent_of[child_i] = parent_i

    # Rest transforms
    rest_t = np.zeros((len(bone_idxs), 3))
    rest_r = np.zeros((len(bone_idxs), 4)); rest_r[:, 3] = 1.0  # identity (xyzw)
    rest_s = np.ones((len(bone_idxs), 3))
    for k, ni in enumerate(bone_idxs):
        n = nodes[ni]
        if n.translation:
            rest_t[k] = n.translation
        if n.rotation:
            rest_r[k] = n.rotation  # glTF stores xyzw
        if n.scale:
            rest_s[k] = n.scale

    # Pick the animation
    if not g.animations:
        raise RuntimeError("GLB has no animations")
    if clip_name:
        anim = next((a for a in g.animations if a.name == clip_name), None)
        if anim is None:
            print(f"[telemetry] clip '{clip_name}' not found, using richest")
            anim = max(g.animations, key=lambda a: len(a.channels))
    else:
        anim = max(g.animations, key=lambda a: len(a.channels))

    print(f"[telemetry] picked clip '{anim.name}' with {len(anim.channels)} channels")

    # Read accessor helper
    bin_blob = g.binary_blob()
    bv_list = g.bufferViews
    acc_list = g.accessors

    def read_acc(idx: int) -> np.ndarray:
        acc = acc_list[idx]
        bv = bv_list[acc.bufferView]
        offset = (bv.byteOffset or 0) + (acc.byteOffset or 0)
        dtype_map = {5126: np.float32, 5123: np.uint16, 5125: np.uint32, 5121: np.uint8}
        dt = dtype_map[acc.componentType]
        type_size = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[acc.type]
        raw = np.frombuffer(bin_blob, dtype=dt, count=acc.count * type_size, offset=offset)
        if acc.type != "SCALAR":
            raw = raw.reshape(acc.count, type_size)
        return raw.astype(np.float32)

    # For each target node, collect (path, times, values, interp)
    tracks: dict[int, dict[str, dict]] = {}
    for ch in anim.channels:
        node_i = ch.target.node
        path = ch.target.path  # 'translation', 'rotation', 'scale'
        if node_i is None:
            continue
        samp = anim.samplers[ch.sampler]
        times = read_acc(samp.input)
        values = read_acc(samp.output)
        if node_i not in tracks:
            tracks[node_i] = {}
        tracks[node_i][path] = {
            "times": times.astype(float),
            "values": values.astype(float).reshape(len(times), -1),
            "interp": samp.interpolation or "LINEAR",
        }

    duration = max(
        (max(t["times"][-1] for t in node_tracks.values())
         for node_tracks in tracks.values()),
        default=0.0,
    )
    sample_times = np.linspace(0.0, max(duration, 1e-3), n_samples)
    print(f"[telemetry] animation duration {duration:.3f}s sampled to {n_samples} frames")

    # Sample per node per time
    def slerp(qa: np.ndarray, qb: np.ndarray, t: float) -> np.ndarray:
        # qa, qb in xyzw
        d = float(np.dot(qa, qb))
        if d < 0:
            qb = -qb; d = -d
        if d > 0.9995:
            r = qa + t * (qb - qa)
            return r / np.linalg.norm(r)
        omega = np.arccos(np.clip(d, -1, 1))
        so = np.sin(omega)
        return (np.sin((1 - t) * omega) / so) * qa + (np.sin(t * omega) / so) * qb

    def lerp(va: np.ndarray, vb: np.ndarray, t: float) -> np.ndarray:
        return va + t * (vb - va)

    def sample_track(track: dict, time: float, kind: str) -> np.ndarray:
        times = track["times"]; values = track["values"]
        if time <= times[0]:
            return values[0].copy()
        if time >= times[-1]:
            return values[-1].copy()
        idx = int(np.searchsorted(times, time))
        t0, t1 = times[idx - 1], times[idx]
        u = (time - t0) / max(t1 - t0, 1e-9)
        v0, v1 = values[idx - 1], values[idx]
        if kind == "rotation":
            return slerp(v0, v1, u)
        return lerp(v0, v1, u)

    positions = np.zeros((n_samples, len(bone_idxs), 3))
    quats = np.zeros((n_samples, len(bone_idxs), 4))
    quats[..., 0] = 1.0  # wxyz identity (we'll convert from xyzw)

    # Local transforms per (frame, bone)
    for f, time in enumerate(sample_times):
        local_T = np.tile(rest_t, (1, 1)).copy()
        local_R_xyzw = np.tile(rest_r, (1, 1)).copy()
        local_S = np.tile(rest_s, (1, 1)).copy()
        for k, ni in enumerate(bone_idxs):
            if ni in tracks:
                tr = tracks[ni]
                if "translation" in tr:
                    local_T[k] = sample_track(tr["translation"], time, "translation")
                if "rotation" in tr:
                    local_R_xyzw[k] = sample_track(tr["rotation"], time, "rotation")
                if "scale" in tr:
                    local_S[k] = sample_track(tr["scale"], time, "scale")

        # Forward kinematics
        world_T = np.zeros((len(bone_idxs), 3))
        world_R = [None] * len(bone_idxs)  # store as 3x3 mat
        idx_by_node = {ni: k for k, ni in enumerate(bone_idxs)}
        # Order parents-before-children
        order = []
        visited = set()
        roots = [k for k, ni in enumerate(bone_idxs) if parent_of[ni] == -1]
        stack = list(roots)
        while stack:
            k = stack.pop(0)
            if k in visited:
                continue
            visited.add(k)
            order.append(k)
            ni = bone_idxs[k]
            for child_ni in (nodes[ni].children or []):
                if child_ni in idx_by_node:
                    stack.append(idx_by_node[child_ni])

        for k in order:
            x, y, z, w = local_R_xyzw[k]
            R = np.array([
                [1 - 2 * (y*y + z*z), 2 * (x*y - z*w), 2 * (x*z + y*w)],
                [2 * (x*y + z*w), 1 - 2 * (x*x + z*z), 2 * (y*z - x*w)],
                [2 * (x*z - y*w), 2 * (y*z + x*w), 1 - 2 * (x*x + y*y)],
            ])
            S = np.diag(local_S[k])
            local_M = R @ S
            ni = bone_idxs[k]
            parent_ni = parent_of[ni]
            if parent_ni == -1:
                world_R[k] = local_M
                world_T[k] = local_T[k]
            else:
                pk = idx_by_node[parent_ni]
                world_R[k] = world_R[pk] @ local_M
                world_T[k] = world_T[pk] + world_R[pk] @ local_T[k]
            quats[f, k] = np.array([w, x, y, z])  # wxyz
        positions[f] = world_T

    return {
        "bones": bone_names,
        "parents": [bone_idxs.index(parent_of[i]) if parent_of[i] != -1 else -1
                    for i in bone_idxs],
        "n_frames": n_samples,
        "frame_time": float(duration / max(n_samples - 1, 1)),
        "frames": positions.tolist(),
        "quats": quats.tolist(),
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bvh", required=True, help="AnyTop source BVH")
    ap.add_argument("--glb", required=True, help="Animated retarget GLB")
    ap.add_argument("--clip", default=None, help="Clip name to extract (default = richest)")
    ap.add_argument("--out", required=True, help="JSON output path")
    ap.add_argument("--n-samples", type=int, default=60)
    args = ap.parse_args()

    print(f"[telemetry] parsing BVH {args.bvh}")
    bvh = parse_bvh(args.bvh)
    print(f"[telemetry] BVH: {len(bvh['bones'])} bones, {bvh['n_frames']} frames")
    src_pos, src_quat = bvh_world_positions(bvh)

    src = {
        "bones": bvh["bones"],
        "parents": bvh["parents"],
        "n_frames": bvh["n_frames"],
        "frame_time": bvh["frame_time"],
        "frames": src_pos.tolist(),
        "quats": src_quat.tolist(),
    }

    print(f"[telemetry] parsing GLB {args.glb}")
    tgt = glb_bone_telemetry(args.glb, clip_name=args.clip, n_samples=args.n_samples)
    print(f"[telemetry] GLB: {len(tgt['bones'])} bones, {tgt['n_frames']} frames")

    out = {"src": src, "tgt": tgt}
    Path(args.out).write_text(json.dumps(out), encoding="utf-8")
    print(f"[telemetry] wrote {args.out} ({Path(args.out).stat().st_size/1024:.1f} KB)")

    # Quick anomaly summary
    def amplitude(arr):
        p = np.asarray(arr["frames"])  # (F, B, 3)
        return (p.max(axis=0) - p.min(axis=0)).max(axis=-1)  # (B,) per-bone

    src_amp = amplitude(src)
    tgt_amp = amplitude(tgt)
    print(f"[telemetry] SRC per-bone amplitude (max-min over frames): mean={src_amp.mean():.3f} max={src_amp.max():.3f}")
    print(f"[telemetry] TGT per-bone amplitude: mean={tgt_amp.mean():.3f} max={tgt_amp.max():.3f}")
    print(f"[telemetry] ratio TGT/SRC = {tgt_amp.mean() / max(src_amp.mean(), 1e-9):.4f} (should be ~scale of retarget)")


if __name__ == "__main__":
    sys.exit(main() or 0)
