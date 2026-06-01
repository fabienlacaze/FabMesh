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


def _quat_mul(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Hamilton product (xyzw) of two quaternions. Both inputs are
    (..., 4); result is the same shape."""
    ax, ay, az, aw = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    bx, by, bz, bw = b[..., 0], b[..., 1], b[..., 2], b[..., 3]
    return np.stack([
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ], axis=-1).astype(np.float32)


def _quat_normalize(q: np.ndarray) -> np.ndarray:
    """Normalize a (..., 4) quaternion array so each row is unit-length.
    float32 drift in Hamilton products produces non-unit quats — three.js
    SLERP then yields visible per-frame jerks. Guard against div-by-zero
    on degenerate frames by clamping the norm at 1e-8."""
    n = np.linalg.norm(q, axis=-1, keepdims=True)
    n = np.maximum(n, 1e-8)
    return (q / n).astype(np.float32)


def _quat_sign_continuous(q: np.ndarray) -> np.ndarray:
    """Ensure consecutive quaternions are on the same hemisphere.
    glTF SLERP linearly interpolates [x,y,z,w] components and renormalises
    — if dot(q[i], q[i+1]) < 0 the interpolation crosses the antipodal
    region and produces a 180° flip. Flip q[i+1] sign whenever the dot
    product is negative; this represents the IDENTICAL rotation but
    keeps the path short."""
    if q.shape[0] < 2:
        return q
    out = q.copy()
    for i in range(1, out.shape[0]):
        if float(np.dot(out[i - 1], out[i])) < 0.0:
            out[i] = -out[i]
    return out.astype(np.float32)


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
    gltf, _json_blob, bin_blob, tail = _read_glb(rig_glb_path)
    # PATCH bone node.translation from inverseBindMatrices. The Puppeteer
    # rig encodes the rest pose ONLY in IBM; bone nodes have no
    # translation set, so in Three.js every bone sits at the origin.
    # SkeletonHelper collapses to a single point AND the bone hierarchy
    # produces zero offsets when parent transforms cascade — animation
    # rotations don't visibly propagate through the skin.
    # Fix: for each bone node, set node.translation = world_pos -
    # parent_world_pos (the bone's local offset). Three.js then has a
    # proper skeleton, the helper renders correctly, and skinned
    # rotations move the mesh as expected.
    try:
        _skins = gltf.get("skins") or []
        if _skins:
            skin0 = _skins[0]
            joint_idxs = list(skin0.get("joints") or [])
            ibm_acc = skin0.get("inverseBindMatrices")
            if ibm_acc is not None and joint_idxs:
                _ibm_flat = _read_accessor(gltf, bin_blob, ibm_acc)
                _ibm_mats = np.asarray(_ibm_flat).reshape(len(joint_idxs), 4, 4)
                # glTF stores matrices column-major; numpy is row-major.
                _ibm_mats = np.transpose(_ibm_mats, (0, 2, 1))
                world_by_jidx = {}
                for k, jidx in enumerate(joint_idxs):
                    try:
                        world_mat = np.linalg.inv(_ibm_mats[k])
                        world_by_jidx[jidx] = world_mat[:3, 3]
                    except Exception:
                        world_by_jidx[jidx] = np.array([0.0, 0.0, 0.0])
                # Find each joint's parent. The skin's joint list is
                # flat; we walk nodes[*].children to discover parent
                # relations.
                parent_by_jidx = {ji: -1 for ji in joint_idxs}
                _all_nodes = gltf.get("nodes") or []
                for pi in range(len(_all_nodes)):
                    for ci in (_all_nodes[pi].get("children") or []):
                        if ci in parent_by_jidx and parent_by_jidx[ci] == -1:
                            parent_by_jidx[ci] = pi
                patched = 0
                for jidx in joint_idxs:
                    parent_jidx = parent_by_jidx.get(jidx, -1)
                    if parent_jidx in world_by_jidx:
                        offset = world_by_jidx[jidx] - world_by_jidx[parent_jidx]
                    else:
                        offset = world_by_jidx.get(jidx, np.array([0.0, 0.0, 0.0]))
                    # Only patch if the node lacks a translation. Don't
                    # overwrite values the rig may have set deliberately.
                    if not _all_nodes[jidx].get("translation"):
                        _all_nodes[jidx]["translation"] = [
                            float(offset[0]), float(offset[1]), float(offset[2]),
                        ]
                        patched += 1
                print(f"[bvh→glb] patched node.translation on {patched}/"
                      f"{len(joint_idxs)} bones from IBM offsets", flush=True)
    except Exception as e:
        print(f"[bvh→glb] bone-translation patch failed: {e}", flush=True)
    # DIAG: inventory the input rig's skin/mesh shape so we can tell
    # whether the output is missing references the GLTFLoader needs.
    _in_meshes = gltf.get("meshes") or []
    _in_skins = gltf.get("skins") or []
    _in_mesh_skin_refs = []
    for mi, m in enumerate(_in_meshes):
        prims = m.get("primitives") or []
        # In glTF the skin reference lives on the NODE, not the mesh
        # itself. Map mesh idx → node refs further down.
        _in_mesh_skin_refs.append({"mesh_idx": mi, "prim_count": len(prims)})
    _node_mesh_skin = []
    for ni, n in enumerate(gltf.get("nodes") or []):
        if "mesh" in n:
            _node_mesh_skin.append({"node": ni, "mesh": n["mesh"], "skin": n.get("skin")})
    print(f"[bvh→glb] INPUT rig: meshes={len(_in_meshes)} skins={len(_in_skins)} "
          f"node->mesh->skin={_node_mesh_skin[:5]}", flush=True)
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
    mapped_count = 0
    unmapped_names = []
    nodes = gltf.get("nodes", []) or []
    for j_idx, j in enumerate(bvh_joints):
        chans = j["channels"]
        if not chans:
            continue
        rot_cols = [(i, c) for i, c in enumerate(chans) if c.endswith("rotation")]
        pos_cols = [(i, c) for i, c in enumerate(chans) if c.endswith("position")]
        tgt_name = mapping.get(j["name"])
        if tgt_name is None or tgt_name not in name_to_idx:
            unmapped_names.append(j["name"])
            col += len(chans)
            continue
        node_idx = name_to_idx[tgt_name]
        mapped_count += 1
        if pos_cols:
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
            # COMPOSE WITH BIND POSE: rest * bvh per frame so identity
            # bvh frames preserve bind pose.
            rest_rot = nodes[node_idx].get("rotation") if node_idx < len(nodes) else None
            if rest_rot is not None and rest_rot != [0, 0, 0, 1]:
                rest_q = np.asarray(rest_rot, dtype=np.float32).reshape(1, 4)
                quats = _quat_mul(np.broadcast_to(rest_q, quats.shape), quats)
            # POST-PROCESS each track so model-viewer / three.js SLERP
            # doesn't produce jerks. Two fixes (per workflow audit):
            # 1. Normalize after Hamilton multiplication — float32 drift
            #    leaves non-unit quats that SLERP visibly stutters on.
            # 2. Sign-continuity flip — when dot(q[i], q[i+1]) < 0 the
            #    interpolation crosses the antipodal region and produces
            #    a 180° per-frame jerk. Flipping q[i+1] sign represents
            #    the same rotation with a short path.
            quats = _quat_normalize(quats)
            quats = _quat_sign_continuous(quats)
            rotations_per_node[node_idx] = quats
        col += len(chans)

    print(f"[bvh→glb] joint mapping: {mapped_count}/{len(bvh_joints)} mapped, "
          f"first 5 unmapped: {unmapped_names[:5]}", flush=True)
    if rotations_per_node:
        any_node = next(iter(rotations_per_node))
        print(f"[bvh→glb] sample node={any_node} frame0_quat={rotations_per_node[any_node][0].tolist()} "
              f"frame{n_frames-1}_quat={rotations_per_node[any_node][-1].tolist()}", flush=True)

    if not rotations_per_node:
        raise RuntimeError("No rotation channels could be mapped onto the rig")

    # Build keyframe timings.
    if target_fps and target_fps > 0:
        # Resample N frames at native dt to N' frames at 1/target_fps.
        # Correct formula (workflow audit): new_n = duration_seconds * fps
        # = n_frames * dt * fps. Old formula `n_frames * (dt * fps)` is
        # algebraically identical and happens to work when dt = 1/fps,
        # but the readable form is `duration * target_fps`. Kept as a
        # single multiply to avoid divisions on degenerate dt = 0.
        duration_s = float(n_frames) * float(dt)
        new_n = int(round(duration_s * float(target_fps)))
        if new_n < 2:
            new_n = n_frames
        new_dt = 1.0 / target_fps
        timings = np.arange(new_n, dtype=np.float32) * new_dt
        # Rotations resample via SLERP (linear interp on quat components
        # produces non-unit + wrong-arc rotations). Translations: linear.
        for k, arr in list(rotations_per_node.items()):
            rotations_per_node[k] = _resample_quat(arr, new_n)
        for k, arr in list(translations_per_node.items()):
            translations_per_node[k] = _resample(arr, new_n)
    else:
        timings = np.arange(n_frames, dtype=np.float32) * dt
    print(f"[bvh→glb] n_frames={n_frames} dt={dt:.6f} duration={n_frames*dt:.3f}s "
          f"target_fps={target_fps} final_frames={len(timings)}", flush=True)

    gltf, bin_blob = inject_anim_into_glb(
        gltf, bin_blob, timings,
        rotations_per_node, translations_per_node,
        clip_name=clip_name,
    )
    # DIAG: confirm the skin reference survived our injection pass.
    _out_node_mesh_skin = []
    for ni, n in enumerate(gltf.get("nodes") or []):
        if "mesh" in n:
            _out_node_mesh_skin.append({"node": ni, "mesh": n["mesh"], "skin": n.get("skin")})
    _has_skin_ref = any(x.get("skin") is not None for x in _out_node_mesh_skin)
    print(f"[bvh→glb] OUTPUT: meshes={len(gltf.get('meshes') or [])} "
          f"skins={len(gltf.get('skins') or [])} animations={len(gltf.get('animations') or [])} "
          f"node->mesh->skin={_out_node_mesh_skin[:5]} has_skin_ref={_has_skin_ref}", flush=True)
    if not _has_skin_ref:
        print("[bvh→glb] WARNING: no node has a skin reference in the output. "
              "Three.js GLTFLoader will produce a plain Mesh, animation tracks "
              "will animate Bone objects without driving any skin → mesh appears "
              "frozen in bind pose. Repairing by copying skin index from input.", flush=True)
        # Try to repair: if input had skin refs and they got dropped,
        # apply them back from the input snapshot.
        for src in _node_mesh_skin:
            tgt = next((x for x in _out_node_mesh_skin if x["node"] == src["node"]), None)
            if tgt and src.get("skin") is not None and tgt.get("skin") is None:
                gltf["nodes"][src["node"]]["skin"] = src["skin"]
                print(f"[bvh→glb]   repaired node {src['node']} skin={src['skin']}", flush=True)
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


def _resample_quat(quats: np.ndarray, new_n: int) -> np.ndarray:
    """SLERP-resample a quaternion track (old_n, 4) to (new_n, 4).
    scipy's Slerp handles the shortest-arc choice and renormalisation
    so the output is unit + continuous. Falls back to scalar lerp +
    renormalize when scipy unavailable."""
    if quats.shape[0] == new_n:
        return quats.astype(np.float32)
    if quats.shape[0] < 2:
        return np.repeat(quats, new_n, axis=0).astype(np.float32)
    try:
        from scipy.spatial.transform import Rotation as R, Slerp
        old_t = np.linspace(0.0, 1.0, quats.shape[0])
        new_t = np.linspace(0.0, 1.0, new_n)
        rots = R.from_quat(quats.astype(np.float64))
        slerp = Slerp(old_t, rots)
        out = slerp(new_t).as_quat().astype(np.float32)
        return _quat_sign_continuous(out)
    except Exception as e:
        print(f"[bvh→glb] SLERP resample fallback: {e}", flush=True)
        out = _resample(quats, new_n)
        return _quat_sign_continuous(_quat_normalize(out))


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
