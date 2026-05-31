"""Embed a BVH animation into a glTF/GLB rig.

Used by the AnyTop animation pipeline: AnyTop generates a BVH on its
own skeleton, and we inject those per-frame joint rotations onto the
matching bones of a Puppeteer-rigged GLB so the result plays in
Three.js / model-viewer / UE5.

Pipeline:
  1. Parse BVH via bvhsdk (handles per-joint Euler rotation order).
  2. For each frame: convert (rx, ry, rz) -> quaternion using
     scipy.spatial.transform.Rotation with the joint's native order.
  3. Map BVH joint names -> GLB bone names via the same anatomical
     synonym table as puppeteer_to_skeleton.py.
  4. Build a glTF Animation block (one channel per (joint, property))
     and append it to the GLB's binary buffer + JSON section.

CLI:
  python bvh_to_gltf_anim.py --rig in.glb --bvh anim.bvh --out out.glb \\
                              [--clip-name "walk"] [--fps 30]

Library API:
  from bvh_to_gltf_anim import bvh_to_gltf_anim
  out_path = bvh_to_gltf_anim(
      rig_glb_path, bvh_path, out_glb_path,
      clip_name="walk", target_fps=None,
  )
"""
import argparse
import os
import struct
import sys
from typing import Dict, List, Optional, Tuple

import numpy as np


# ---------------------------------------------------------------------------
# GLB read/write helpers — reuse the pure-python parser from
# puppeteer_to_skeleton.py rather than importing pygltflib (which doesn't
# preserve the GLB binary blob layout we need).
# ---------------------------------------------------------------------------
def _add_scripts_to_path():
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)


_add_scripts_to_path()

try:
    from puppeteer_to_skeleton import (  # noqa: E402
        _read_glb,
        _write_glb,
        _read_accessor,
        _resolve_role_to_template_name,
    )
except ImportError as e:
    raise RuntimeError(
        "puppeteer_to_skeleton.py not importable. Check scripts/ is on PYTHONPATH."
    ) from e


# ---------------------------------------------------------------------------
# BVH parsing (bvhsdk preferred, fallback to a tiny hand-rolled parser)
# ---------------------------------------------------------------------------
def _parse_bvh(bvh_path: str) -> Tuple[List[Dict], np.ndarray, float]:
    """Returns (joints, frames, dt).

    joints: list of dicts {name, parent_idx, channels, offset, rot_order}
            channels is e.g. ['Xposition','Yposition','Zposition','Zrotation','Xrotation','Yrotation']
            rot_order is derived from the rotation-channel order (e.g. 'ZXY')
    frames: ndarray of shape (n_frames, sum(len(channels) for j in joints))
            stored in BVH's channel-major order
    dt: frame time in seconds
    """
    try:
        import bvhsdk  # type: ignore
        return _parse_bvh_via_bvhsdk(bvh_path)
    except ImportError:
        return _parse_bvh_minimal(bvh_path)


def _parse_bvh_via_bvhsdk(bvh_path: str):
    import bvhsdk  # type: ignore
    anim = bvhsdk.ReadFile(bvh_path)
    # bvhsdk hierarchy walk
    joints: List[Dict] = []
    name_to_idx: Dict[str, int] = {}

    def walk(node, parent_idx):
        idx = len(joints)
        channels = list(node.channels) if hasattr(node, "channels") else []
        rot_order = _rot_order_from_channels(channels)
        offset = list(getattr(node, "offset", [0.0, 0.0, 0.0]))
        joints.append({
            "name": node.name,
            "parent_idx": parent_idx,
            "channels": channels,
            "offset": offset,
            "rot_order": rot_order,
        })
        name_to_idx[node.name] = idx
        for child in (node.children or []):
            walk(child, idx)

    walk(anim.root, -1)

    n_frames = anim.frames
    # Reconstruct channel-major frame matrix
    cols = sum(len(j["channels"]) for j in joints)
    mat = np.zeros((n_frames, cols), dtype=np.float32)
    col_off = 0
    for j_idx, j in enumerate(joints):
        node = _find_node_by_name(anim.root, j["name"])
        if node is None:
            col_off += len(j["channels"])
            continue
        ch_names = j["channels"]
        per_node_data = _bvhsdk_node_motion(node, n_frames, ch_names)
        mat[:, col_off:col_off + len(ch_names)] = per_node_data
        col_off += len(ch_names)
    dt = float(anim.frametime) if anim.frametime > 0 else 1.0 / 30.0
    return joints, mat, dt


def _find_node_by_name(root, name):
    if root.name == name:
        return root
    for c in (root.children or []):
        r = _find_node_by_name(c, name)
        if r is not None:
            return r
    return None


def _bvhsdk_node_motion(node, n_frames: int, ch_names: List[str]) -> np.ndarray:
    """Extract per-frame motion for a bvhsdk node in the channel order
    declared by the BVH header."""
    out = np.zeros((n_frames, len(ch_names)), dtype=np.float32)
    # bvhsdk stores rotation curves on node.rotation (shape n_frames x 3
    # in node's own order) and translation on node.translation. Map back
    # to the requested channel order.
    rot = getattr(node, "rotation", None)
    tr = getattr(node, "translation", None)
    rot_idx_map: Dict[str, int] = {}
    if rot is not None and len(rot) == n_frames:
        # Recover bvhsdk's rotation order from the channel order
        rot_axes = [c[0] for c in ch_names if c.endswith("rotation")]
        for axis_i, axis in enumerate(rot_axes):
            rot_idx_map[f"{axis}rotation"] = axis_i
    for i, ch in enumerate(ch_names):
        if ch.endswith("position") and tr is not None:
            axis = ch[0]
            ax_idx = {"X": 0, "Y": 1, "Z": 2}.get(axis, 0)
            try:
                out[:, i] = np.asarray([t[ax_idx] for t in tr], dtype=np.float32)
            except Exception:
                pass
        elif ch.endswith("rotation") and rot is not None:
            ax_idx = rot_idx_map.get(ch, 0)
            try:
                out[:, i] = np.asarray([r[ax_idx] for r in rot], dtype=np.float32)
            except Exception:
                pass
    return out


def _rot_order_from_channels(channels: List[str]) -> str:
    """'Zrotation','Xrotation','Yrotation' -> 'ZXY'."""
    return "".join(c[0] for c in channels if c.endswith("rotation")) or "XYZ"


def _parse_bvh_minimal(bvh_path: str) -> Tuple[List[Dict], np.ndarray, float]:
    """Tiny fallback parser when bvhsdk is unavailable. Handles a single
    HIERARCHY block + MOTION frames. Doesn't support End Site as a
    distinct joint (collapsed into parent), but End Site joints have no
    motion channels in BVH so this is correct."""
    with open(bvh_path, "r", encoding="utf-8", errors="ignore") as f:
        lines = [ln.rstrip("\n") for ln in f.readlines()]
    joints: List[Dict] = []
    stack: List[int] = [-1]
    i = 0
    while i < len(lines):
        s = lines[i].strip()
        toks = s.split()
        if not toks:
            i += 1
            continue
        kw = toks[0]
        if kw in ("ROOT", "JOINT"):
            name = toks[1] if len(toks) > 1 else f"joint_{len(joints)}"
            joints.append({
                "name": name,
                "parent_idx": stack[-1],
                "channels": [],
                "offset": [0.0, 0.0, 0.0],
                "rot_order": "XYZ",
            })
            stack.append(len(joints) - 1)
        elif kw == "End":
            stack.append(stack[-1])  # End Site doesn't create new joint
        elif kw == "OFFSET":
            if stack[-1] >= 0 and len(toks) >= 4:
                joints[stack[-1]]["offset"] = [float(toks[1]), float(toks[2]), float(toks[3])]
        elif kw == "CHANNELS":
            if stack[-1] >= 0 and len(toks) >= 3:
                n_ch = int(toks[1])
                chans = toks[2:2 + n_ch]
                joints[stack[-1]]["channels"] = chans
                joints[stack[-1]]["rot_order"] = _rot_order_from_channels(chans)
        elif kw == "{":
            pass
        elif kw == "}":
            if stack:
                stack.pop()
        elif kw == "MOTION":
            break
        i += 1
    # Parse MOTION block
    n_frames = 0
    dt = 1.0 / 30.0
    motion_start = 0
    while i < len(lines):
        s = lines[i].strip()
        if s.startswith("Frames:"):
            n_frames = int(s.split(":")[1].strip())
        elif s.startswith("Frame Time:"):
            dt = float(s.split(":")[1].strip())
            motion_start = i + 1
            break
        i += 1
    cols = sum(len(j["channels"]) for j in joints)
    mat = np.zeros((n_frames, cols), dtype=np.float32)
    for f_idx in range(n_frames):
        ln_idx = motion_start + f_idx
        if ln_idx >= len(lines):
            break
        vals = lines[ln_idx].split()
        if len(vals) < cols:
            continue
        for c in range(cols):
            try:
                mat[f_idx, c] = float(vals[c])
            except ValueError:
                mat[f_idx, c] = 0.0
    return joints, mat, dt


# ---------------------------------------------------------------------------
# Euler -> Quaternion (per-joint rotation order)
# ---------------------------------------------------------------------------
def _eulers_to_quats(eulers_deg: np.ndarray, order: str) -> np.ndarray:
    """eulers_deg: (n_frames, 3) array of [angle_axis1, angle_axis2, angle_axis3]
    in DEGREES in the joint's native rotation order (e.g. 'ZXY' means the
    first column is the Z-axis angle, applied first).

    Returns (n_frames, 4) quaternion array [x, y, z, w]."""
    try:
        from scipy.spatial.transform import Rotation as R
    except ImportError as e:
        raise RuntimeError("scipy.spatial.transform.Rotation required") from e
    eul_rad = np.deg2rad(eulers_deg.astype(np.float64))
    # scipy R.from_euler uses lower-case order for intrinsic (e.g. 'zxy')
    r = R.from_euler(order.lower(), eul_rad, degrees=False)
    q = r.as_quat()  # scipy returns [x, y, z, w]
    return q.astype(np.float32)


# ---------------------------------------------------------------------------
# Bone-name mapping BVH joints -> GLB bones
# ---------------------------------------------------------------------------
def _build_glb_bone_index(gltf: dict) -> Dict[str, int]:
    """Map each node name to its node index."""
    out: Dict[str, int] = {}
    nodes = gltf.get("nodes", []) or []
    for i, n in enumerate(nodes):
        nm = n.get("name") or f"node_{i}"
        out[nm] = i
    return out


def _glb_skin_joint_names(gltf: dict) -> List[str]:
    """Return the list of bone names referenced by the FIRST skin's joints
    array, in joint-order. This is the canonical bone list for the rig."""
    skins = gltf.get("skins", []) or []
    if not skins:
        return []
    skin = skins[0]
    joint_node_idxs = skin.get("joints", []) or []
    nodes = gltf.get("nodes", []) or []
    out: List[str] = []
    for idx in joint_node_idxs:
        if 0 <= idx < len(nodes):
            out.append(nodes[idx].get("name") or f"node_{idx}")
    return out


def _map_bvh_to_glb(
    bvh_joint_names: List[str],
    glb_bone_names: List[str],
) -> Dict[str, str]:
    """Returns {bvh_name: glb_bone_name}. Strategy:
      1. Exact match first.
      2. Case-insensitive contains.
      3. _resolve_role_to_template_name on a hand-rolled anatomical role
         derived from the BVH joint name (left/right hint + body part).
    Anything that doesn't resolve is dropped silently."""
    out: Dict[str, str] = {}
    glb_lower = {b.lower(): b for b in glb_bone_names}
    for bvh_name in bvh_joint_names:
        if not bvh_name:
            continue
        # Exact
        if bvh_name in glb_bone_names:
            out[bvh_name] = bvh_name
            continue
        if bvh_name.lower() in glb_lower:
            out[bvh_name] = glb_lower[bvh_name.lower()]
            continue
        # Try the synonym resolver from puppeteer_to_skeleton.
        # We invent a "role" string from the BVH name: lowercase, drop
        # common prefixes/suffixes ("Bip01_", "BN_", "_End").
        role = (bvh_name.lower()
                .replace("bip01_", "").replace("bn_", "")
                .replace("_end", "").replace("end_", "")
                .replace("__", "_").strip("_"))
        try:
            tgt = _resolve_role_to_template_name(role, glb_bone_names)
            if tgt and tgt in glb_bone_names:
                out[bvh_name] = tgt
                continue
        except Exception:
            pass
        # Last resort: fuzzy substring scan.
        bvh_low = bvh_name.lower()
        for glb_name in glb_bone_names:
            if glb_name.lower() in bvh_low or bvh_low in glb_name.lower():
                out[bvh_name] = glb_name
                break
    return out


# ---------------------------------------------------------------------------
# glTF Animation block injection
# ---------------------------------------------------------------------------
def _append_buffer_chunk(bin_blob: bytes, data: bytes) -> Tuple[bytes, int, int]:
    """Append data to bin_blob aligned to 4 bytes, return (new_blob,
    byte_offset, byte_length)."""
    pad = (-len(bin_blob)) % 4
    new_blob = bin_blob + (b"\x00" * pad) + data
    return new_blob, len(bin_blob) + pad, len(data)


def _f32_packed(arr: np.ndarray) -> bytes:
    return arr.astype(np.float32, copy=False).tobytes(order="C")


def _add_accessor(gltf: dict, buf_view_idx: int, comp_type: int,
                  count: int, type_str: str,
                  mins=None, maxs=None) -> int:
    accessors = gltf.setdefault("accessors", [])
    acc = {
        "bufferView": buf_view_idx,
        "componentType": comp_type,
        "count": count,
        "type": type_str,
    }
    if mins is not None:
        acc["min"] = list(mins)
    if maxs is not None:
        acc["max"] = list(maxs)
    accessors.append(acc)
    return len(accessors) - 1


def _add_buffer_view(gltf: dict, byte_offset: int, byte_length: int) -> int:
    bvs = gltf.setdefault("bufferViews", [])
    bvs.append({
        "buffer": 0,
        "byteOffset": byte_offset,
        "byteLength": byte_length,
    })
    return len(bvs) - 1


def inject_anim_into_glb(
    gltf: dict,
    bin_blob: bytes,
    timings: np.ndarray,
    rotations_per_node: Dict[int, np.ndarray],  # node_idx -> (n_frames, 4) quats xyzw
    translations_per_node: Optional[Dict[int, np.ndarray]] = None,
    clip_name: str = "clip",
) -> Tuple[dict, bytes]:
    """Append a new glTF Animation that targets the given nodes."""
    samplers = []
    channels = []

    # Single input (time) accessor shared by all channels.
    in_buf, in_off, in_len = _append_buffer_chunk(bin_blob, _f32_packed(timings))
    in_bv = _add_buffer_view(gltf, in_off, in_len)
    in_acc = _add_accessor(
        gltf, in_bv, 5126, len(timings), "SCALAR",
        mins=[float(timings.min())], maxs=[float(timings.max())],
    )
    bin_blob = in_buf

    # Rotation channels
    for node_idx, quats in rotations_per_node.items():
        rot_buf, rot_off, rot_len = _append_buffer_chunk(bin_blob, _f32_packed(quats))
        rot_bv = _add_buffer_view(gltf, rot_off, rot_len)
        rot_acc = _add_accessor(gltf, rot_bv, 5126, len(quats), "VEC4")
        sampler_idx = len(samplers)
        samplers.append({"input": in_acc, "output": rot_acc, "interpolation": "LINEAR"})
        channels.append({
            "sampler": sampler_idx,
            "target": {"node": int(node_idx), "path": "rotation"},
        })
        bin_blob = rot_buf

    # Translation channels (typically only the root)
    if translations_per_node:
        for node_idx, trs in translations_per_node.items():
            tr_buf, tr_off, tr_len = _append_buffer_chunk(bin_blob, _f32_packed(trs))
            tr_bv = _add_buffer_view(gltf, tr_off, tr_len)
            tr_acc = _add_accessor(gltf, tr_bv, 5126, len(trs), "VEC3")
            sampler_idx = len(samplers)
            samplers.append({"input": in_acc, "output": tr_acc, "interpolation": "LINEAR"})
            channels.append({
                "sampler": sampler_idx,
                "target": {"node": int(node_idx), "path": "translation"},
            })
            bin_blob = tr_buf

    # Update the buffer size to match the new blob length.
    buffers = gltf.setdefault("buffers", [{}])
    buffers[0]["byteLength"] = len(bin_blob)

    anims = gltf.setdefault("animations", [])
    anims.append({"name": clip_name, "samplers": samplers, "channels": channels})
    return gltf, bin_blob


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------
def bvh_to_gltf_anim(
    rig_glb_path: str,
    bvh_path: str,
    out_glb_path: str,
    clip_name: str = "clip",
    target_fps: Optional[float] = None,
) -> str:
    """Inject the BVH animation onto the rig GLB and write to out_glb_path.
    Returns out_glb_path on success.

    target_fps: if set, the timing keyframes are uniformly resampled to this
    framerate (e.g. 30) regardless of BVH dt. Useful to match Three.js /
    UE5 timebase.
    """
    gltf, bin_blob, tail = _read_glb(rig_glb_path)
    glb_bones = _glb_skin_joint_names(gltf)
    if not glb_bones:
        raise RuntimeError(f"No skin/joints found in {rig_glb_path}")
    name_to_idx = _build_glb_bone_index(gltf)

    bvh_joints, frames, dt = _parse_bvh(bvh_path)
    n_frames = frames.shape[0]
    if n_frames == 0:
        raise RuntimeError(f"BVH {bvh_path} has 0 frames")

    bvh_names = [j["name"] for j in bvh_joints]
    mapping = _map_bvh_to_glb(bvh_names, glb_bones)
    if not mapping:
        raise RuntimeError(
            "No BVH joint name resolves to a GLB bone — "
            f"BVH joints: {bvh_names[:6]}... GLB bones: {glb_bones[:6]}..."
        )

    # Walk channel-major frames matrix and reduce to per-joint Eulers/positions.
    col = 0
    rotations_per_node: Dict[int, np.ndarray] = {}
    translations_per_node: Dict[int, np.ndarray] = {}
    for j_idx, j in enumerate(bvh_joints):
        chans = j["channels"]
        if not chans:
            continue
        rot_cols = [(i, c) for i, c in enumerate(chans) if c.endswith("rotation")]
        pos_cols = [(i, c) for i, c in enumerate(chans) if c.endswith("position")]
        # Translations
        tgt_name = mapping.get(j["name"])
        if tgt_name is None or tgt_name not in name_to_idx:
            col += len(chans)
            continue
        node_idx = name_to_idx[tgt_name]
        if pos_cols:
            # Reorder X,Y,Z based on channel labels.
            pos = np.zeros((n_frames, 3), dtype=np.float32)
            for i, ch in pos_cols:
                ax = {"X": 0, "Y": 1, "Z": 2}.get(ch[0], 0)
                pos[:, ax] = frames[:, col + i]
            translations_per_node[node_idx] = pos
        if rot_cols:
            eulers = np.stack(
                [frames[:, col + i] for i, _ in rot_cols], axis=1,
            )  # (n_frames, 3) in rot_order
            quats = _eulers_to_quats(eulers, j["rot_order"])
            rotations_per_node[node_idx] = quats
        col += len(chans)

    if not rotations_per_node:
        raise RuntimeError("No rotation channels could be mapped onto the rig")

    # Build keyframe timings.
    if target_fps and target_fps > 0:
        new_n = int(round(n_frames * (dt * target_fps)))
        if new_n < 2:
            new_n = n_frames
        new_dt = 1.0 / target_fps
        timings = np.arange(new_n, dtype=np.float32) * new_dt
        # Resample rotations + translations linearly.
        for d in (rotations_per_node, translations_per_node):
            for k, arr in list(d.items()):
                d[k] = _resample(arr, new_n)
    else:
        timings = np.arange(n_frames, dtype=np.float32) * dt

    gltf, bin_blob = inject_anim_into_glb(
        gltf, bin_blob, timings,
        rotations_per_node, translations_per_node,
        clip_name=clip_name,
    )
    _write_glb(out_glb_path, gltf, bin_blob, tail)
    return out_glb_path


def _resample(arr: np.ndarray, new_n: int) -> np.ndarray:
    """Linear resample along axis 0 from arr.shape[0] -> new_n."""
    if arr.shape[0] == new_n:
        return arr
    old_n = arr.shape[0]
    old_t = np.linspace(0.0, 1.0, old_n)
    new_t = np.linspace(0.0, 1.0, new_n)
    out = np.zeros((new_n,) + arr.shape[1:], dtype=arr.dtype)
    for col in range(arr.shape[1]):
        out[:, col] = np.interp(new_t, old_t, arr[:, col])
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--rig", required=True, help="Path to the rigged GLB")
    ap.add_argument("--bvh", required=True, help="Path to the BVH animation")
    ap.add_argument("--out", required=True, help="Path to the output animated GLB")
    ap.add_argument("--clip-name", default="clip", help="Animation clip name")
    ap.add_argument("--fps", type=float, default=None,
                    help="Resample timings to this FPS (default: preserve BVH dt)")
    args = ap.parse_args()
    out = bvh_to_gltf_anim(args.rig, args.bvh, args.out,
                           clip_name=args.clip_name,
                           target_fps=args.fps)
    print(f"OK: {out}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
