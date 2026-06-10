"""IK-based retargeter — drop-in replacement for the rotation-transfer
core in `anytop_retarget.py`.

The legacy core (`retarget_motion_to_rig`) transfers PARENT-LOCAL
quaternions from source bones to target bones after a basis change.
That works when source and target share a similar topology, but it
EXPLODES on skeletons with different bone counts or attach angles
because:

  * Source rest twists (baked by the original artist) propagate onto
    target bones whose rest axes don't match, so limbs rotate in the
    "wrong" parent-local axis.
  * Bone-length mismatches make foot-slide / mesh-stretch unavoidable
    even with correct quaternion math.

The IK approach sidesteps both problems by RESPECTING THE GEOMETRY:

  1. Run forward kinematics on the source skeleton to get the WORLD
     position of each EFFECTOR bone (hip, head_tip, hand_l_tip, …) at
     every frame.
  2. For each frame, solve FABRIK on each target IK CHAIN to make the
     target effector REACH the source effector's world position.
  3. Convert the resulting per-bone world positions to parent-local
     rotation quaternions.
  4. Emit a glTF AnimationClip exactly the way the legacy core does.

The mapping JSON drives WHICH bones are effectors and what chains they
own — same data-driven philosophy as the legacy mapping_table.

This module is intentionally a separate file from anytop_retarget so
the two paths can be A/B-compared without code-mixing risk. Modal /
Electron callers route via `retarget_fbx_to_rig_ik` instead of
`retarget_fbx_to_rig`.
"""
from __future__ import annotations

import json
import os
import struct
import sys
from typing import Dict, List, Optional, Tuple

import numpy as np

# Re-use the heavy lifters from anytop_retarget so we stay in lockstep
# with its bug fixes (IBM polar decomposition, GLB writer padding, …).
sys.path.insert(0, os.path.dirname(__file__))
from anytop_retarget import (   # noqa: E402
    _read_glb,
    _write_glb,
    _read_accessor_floats,
    _add_buffer_view,
    _add_accessor,
    _classify_source_bone,
    _eulers_to_quats,
)
from fbx_motion import parse_fbx          # noqa: E402
from rig_mappings import load_mapping     # noqa: E402
from ik_solver import (                   # noqa: E402
    solve_chain,
    positions_to_local_rotations,
)


# ============================================================
# Quaternion helpers — glTF convention is (x, y, z, w); the FABRIK
# solver works in (w, x, y, z). We bridge at the boundary.
# ============================================================

IDENT_Q_XYZW = np.array([0.0, 0.0, 0.0, 1.0])
IDENT_Q_WXYZ = np.array([1.0, 0.0, 0.0, 0.0])


def _wxyz_to_xyzw(q: np.ndarray) -> np.ndarray:
    q = np.asarray(q, dtype=np.float64).reshape(-1)
    return np.array([q[1], q[2], q[3], q[0]])


def _xyzw_to_wxyz(q: np.ndarray) -> np.ndarray:
    q = np.asarray(q, dtype=np.float64).reshape(-1)
    return np.array([q[3], q[0], q[1], q[2]])


def _q_mul_xyzw(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Hamilton product, glTF (x, y, z, w) convention."""
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return np.array([
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ])


def _quat_from_mat(Rm: np.ndarray) -> np.ndarray:
    """3x3 rotation matrix -> glTF (x, y, z, w) quat. Shepperd."""
    if not np.all(np.isfinite(Rm)):
        return IDENT_Q_XYZW.copy()
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
        return IDENT_Q_XYZW.copy()
    return q / n


# ============================================================
# Effector list loader — pulls the "effectors" array out of the raw
# mapping JSON. The Mapping dataclass doesn't currently surface it,
# so we re-read the JSON ourselves (cheap — a few KB).
# ============================================================

def _load_effectors(source_skel_id: str, target_family: str) -> List[dict]:
    """Read the "effectors" array from the mapping JSON. Raises
    KeyError if the JSON has no effectors section — IK retargeting is
    impossible without effector definitions.

    Each effector dict is expected to have:
      name              : str             (debug label)
      source_bone       : str             (name in the source skeleton)
      target_node       : int             (glTF node idx of the chain tip)
      chain_root        : int             (glTF node idx of the chain root)
      chain_bones_target: List[int]       (root-to-tip glTF node idxs)
    """
    here = os.path.dirname(os.path.abspath(__file__))
    json_path = os.path.join(
        here, "rig_mappings", f"{source_skel_id}__{target_family}.json"
    )
    if not os.path.isfile(json_path):
        raise FileNotFoundError(
            f"mapping JSON missing for IK retarget: {json_path}"
        )
    with open(json_path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    eff = raw.get("effectors") or []
    if not isinstance(eff, list) or not eff:
        raise KeyError(
            f"mapping {source_skel_id}->{target_family} has no 'effectors' "
            f"section; IK retargeting requires one"
        )
    return eff


# ============================================================
# Plan B1 (2026-06-11): Dynamic effectors from labels.json
# Replaces static rig_mappings/*.json effectors with per-rig labels
# produced by scripts/puppeteer_semantic_extractor.py.
# ============================================================

def _effectors_from_labels(labels_json_path: str, rig_glb_path: str) -> list:
    """Build the effectors list expected by retarget_fbx_to_rig_ik from
    a per-joint labels.json (output of puppeteer_semantic_extractor).

    The labels JSON is either:
      A) a flat list of role names in joint-index order, OR
      B) a dict {idx_str: role_name}
    Roles follow the puppeteer_joint_renamer naming (Hips, Spine00,
    Spine01, ..., Head00, LeftArm00..03, RightLeg00..03, etc.).

    For each canonical effector (hip, head_tip, hand_l_tip, hand_r_tip,
    foot_l_tip, foot_r_tip) we:
      - locate the joint whose label is the chain TIP (e.g. Head00,
        LeftArm03 = the highest chain_idx in that family)
      - walk the parents up to the chain ROOT and emit the indices.
    """
    with open(labels_json_path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    if isinstance(raw, list):
        labels = {i: raw[i] for i in range(len(raw))}
    elif isinstance(raw, dict):
        # Prefer top-level "labels" key if the file is the full
        # extractor output (has anchor_labels / geometric_labels too).
        if "labels" in raw and isinstance(raw["labels"], dict):
            labels = {int(k): v for k, v in raw["labels"].items()}
        elif "labels" in raw and isinstance(raw["labels"], list):
            labels = {i: raw["labels"][i] for i in range(len(raw["labels"]))}
        else:
            labels = {int(k): v for k, v in raw.items()}
    else:
        raise ValueError(f"unrecognized labels.json shape: {type(raw)}")

    # Build parent map from the rig's GLB nodes
    gltf, _bbuf, _ = _read_glb(rig_glb_path)
    nodes = gltf.get("nodes", [])
    # 2026-06-11 FIX: GLB node enumeration order != pred.txt joint
    # ordering. Map by NAME ("jointN"). The labels list/dict uses the
    # pred.txt indexing (joint0..jointN).
    name_to_node = {n.get("name", ""): i for i, n in enumerate(nodes)}
    joint_orig = []
    for i in range(len(labels)):
        node_idx = name_to_node.get(f"joint{i}")
        if node_idx is None:
            raise ValueError(
                f"rig has no node named 'joint{i}' — pred.txt and GLB out of sync"
            )
        joint_orig.append(node_idx)
    if len(joint_orig) != len(labels):
        raise ValueError(
            f"labels has {len(labels)} entries but rig has "
            f"{len(joint_orig)} joints"
        )
    parent_of_orig = {i: -1 for i in range(len(nodes))}
    for pi, p in enumerate(nodes):
        for c in (p.get("children") or []):
            parent_of_orig[c] = pi
    # Translate to label-space indices
    # labels[i] corresponds to joint_orig[i]; build a "label idx -> glTF
    # node idx" and the inverse.
    label_idx_to_node = {i: joint_orig[i] for i in range(len(labels))}
    node_to_label_idx = {v: k for k, v in label_idx_to_node.items()}

    def parent_label_idx(li: int) -> int:
        node = label_idx_to_node[li]
        p_node = parent_of_orig.get(node, -1)
        return node_to_label_idx.get(p_node, -1)

    # Map role -> (chain_idx parser, source_bone hint)
    # We expect labels like "LeftArm00", "LeftArm01", ..., "LeftArm03".
    # The chain TIP is the maximum chain_idx among joints with that
    # prefix; the chain ROOT is the minimum chain_idx.
    def chain_for(prefix: str):
        members = [(li, lbl) for li, lbl in labels.items()
                   if lbl.startswith(prefix) and lbl[len(prefix):].isdigit()]
        if not members:
            return None
        members.sort(key=lambda x: int(x[1][len(prefix):]))
        chain = [li for li, _ in members]
        return chain

    effectors: list = []

    # hip = single joint labeled "Hips"
    hip_idxs = [li for li, lbl in labels.items() if lbl == "Hips"]
    if hip_idxs:
        h = label_idx_to_node[hip_idxs[0]]
        effectors.append({
            "name": "hip",
            "source_bone": "pelvis",
            "target_node": h,
            "chain_root": h,
            "chain_bones_target": [h],
        })

    # head_tip: the joint labeled "Head00" (or highest "Head*")
    # Chain = Neck + Head ONLY. Including spine would let IK rotate the
    # whole torso to reach the head target (mass deformation).
    head_chain = chain_for("Head")
    neck_chain = chain_for("Neck")
    if head_chain:
        tip = label_idx_to_node[head_chain[-1]]
        chain_li = (neck_chain or []) + head_chain
        chain_nodes = [label_idx_to_node[i] for i in chain_li]
        root = chain_nodes[0] if chain_nodes else tip
        effectors.append({
            "name": "head_tip",
            "source_bone": "head",
            "target_node": tip,
            "chain_root": root,
            "chain_bones_target": chain_nodes,
        })

    for role, name, src in [
        ("LeftArm",  "hand_l_tip", "hand_l"),
        ("RightArm", "hand_r_tip", "hand_r"),
        ("LeftLeg",  "foot_l_tip", "foot_l"),
        ("RightLeg", "foot_r_tip", "foot_r"),
    ]:
        chain = chain_for(role)
        if not chain:
            continue
        tip = label_idx_to_node[chain[-1]]
        chain_nodes = [label_idx_to_node[i] for i in chain]
        root = chain_nodes[0]
        effectors.append({
            "name": name,
            "source_bone": src,
            "target_node": tip,
            "chain_root": root,
            "chain_bones_target": chain_nodes,
        })

    return effectors


# ============================================================
# Source FK — compose per-frame local quats along the source hierarchy
# to recover the world position of every source bone at every frame.
# ============================================================

def _source_fk_world_positions(motion: dict) -> np.ndarray:
    """Run FK on the source skeleton for every frame.

    Returns: (F, N_src, 3) world positions of every source bone at
    every frame. Root translation (motion['root_pos']) is applied to
    the root only.

    Algorithm:
      For each frame f:
        For each bone i (DFS-ordered, parents first):
          local_quat = euler_to_quat(motion['euler'][f, i], channels[i])
          world_quat[i]  = world_quat[parent] * local_quat
          world_offset[i] = world_quat[parent] @ offsets[i]    (rotate)
          world_pos[i]   = world_pos[parent] + world_offset[i]
        world_pos[root] += root_pos[f] - root_pos[0]   (delta translation)
    """
    names: List[str] = motion["names"]
    parents: List[int] = motion["parents"]
    offsets: np.ndarray = np.asarray(motion["offsets"], dtype=np.float64)   # (N, 3)
    channels = motion["channels"]
    eul: np.ndarray = np.asarray(motion["euler"], dtype=np.float64)         # (F, N, 3)
    root_pos: np.ndarray = np.asarray(motion["root_pos"], dtype=np.float64) # (F, 3)
    n_frames = int(motion["n_frames"])
    n = len(names)

    # Pre-compute every bone's per-frame local quat (xyzw). Reusing
    # `_eulers_to_quats` keeps channel-order handling identical to the
    # rotation-transfer path so a misordered euler can't silently
    # disagree between the two retargeters.
    per_bone_q = np.zeros((n_frames, n, 4), dtype=np.float64)
    for i in range(n):
        try:
            qs = _eulers_to_quats(eul[:, i, :], channels[i])  # (F, 4) xyzw
            per_bone_q[:, i, :] = qs
        except Exception:
            per_bone_q[:, i, 3] = 1.0  # identity quat

    world_pos = np.zeros((n_frames, n, 3), dtype=np.float64)
    world_quat = np.zeros((n_frames, n, 4), dtype=np.float64)
    world_quat[..., 3] = 1.0  # default to identity

    # Root translation: prefer the absolute world-space root, but if
    # root_pos[0] is non-zero (FBX often bakes the rest world position
    # into frame 0), we want delta-from-rest so the chain starts at
    # the source's actual rest pose, not at the origin.
    if root_pos.ndim == 2 and root_pos.shape == (n_frames, 3):
        root_delta = root_pos - root_pos[0:1]
    else:
        root_delta = np.zeros((n_frames, 3), dtype=np.float64)

    for f in range(n_frames):
        for i in range(n):
            p = parents[i]
            q_local = per_bone_q[f, i]
            if p < 0:
                # Root: world quat = local quat, world pos = offset + delta.
                world_quat[f, i] = q_local
                # Rotate offset into world (identity parent), add root delta.
                world_pos[f, i] = offsets[i] + root_delta[f]
            else:
                q_parent = world_quat[f, p]
                world_quat[f, i] = _q_mul_xyzw(q_parent, q_local)
                # Rotate this bone's parent-relative offset by parent's
                # WORLD quat to get the world-space child offset.
                off_w = _rotate_vec_xyzw(q_parent, offsets[i])
                world_pos[f, i] = world_pos[f, p] + off_w
    return world_pos


def _rotate_vec_xyzw(q: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Rotate 3-vec v by quat q (xyzw). q * (v,0) * q^-1."""
    vq = np.array([v[0], v[1], v[2], 0.0])
    qi = np.array([-q[0], -q[1], -q[2], q[3]])
    out = _q_mul_xyzw(_q_mul_xyzw(q, vq), qi)
    return out[:3]


# ============================================================
# Target rig reader — pulls joints, parents, IBM-derived world
# rest positions and rest rotations from the GLB.
# ============================================================

def _read_target_rig(rig_glb_path: str):
    """Returns (gltf, bin_blob, joint_node_idxs, parent_by_idx,
    name_by_idx, world_by_idx, world_rot_by_idx).
    Mirrors the rest-state extraction at the top of
    `retarget_motion_to_rig` so the IK path sees the same world rest
    as the rotation-transfer path."""
    gltf, _json_blob, bin_blob = _read_glb(rig_glb_path)
    skins = gltf.get("skins") or []
    if not skins:
        raise RuntimeError("GLB has no skin to retarget onto")
    skin = skins[0]
    joint_node_idxs: List[int] = list(skin.get("joints") or [])
    nodes = gltf.get("nodes") or []
    name_by_idx = {i: (nodes[i].get("name") or f"node_{i}") for i in joint_node_idxs}
    parent_by_idx = {i: -1 for i in joint_node_idxs}
    for parent_idx in joint_node_idxs:
        for child in (nodes[parent_idx].get("children") or []):
            if child in joint_node_idxs:
                parent_by_idx[child] = parent_idx

    world_by_idx: Dict[int, np.ndarray] = {}
    world_rot_by_idx: Dict[int, np.ndarray] = {}
    ibm_acc = skin.get("inverseBindMatrices")
    if ibm_acc is not None:
        ibm_flat = _read_accessor_floats(gltf, bin_blob, ibm_acc)
        ibm_mats = np.asarray(ibm_flat).reshape(len(joint_node_idxs), 4, 4)
        # glTF stores matrices column-major; flatten gives column-major
        # order, so transpose to get row-major numpy convention.
        ibm_mats = np.transpose(ibm_mats, (0, 2, 1))
        for k, jidx in enumerate(joint_node_idxs):
            try:
                world_mat = np.linalg.inv(ibm_mats[k])
                world_by_idx[jidx] = world_mat[:3, 3].astype(np.float64)
                M = world_mat[:3, :3].astype(np.float64)
                U, _, Vt = np.linalg.svd(M)
                Rmat = U @ Vt
                if np.linalg.det(Rmat) < 0:
                    U[:, -1] *= -1
                    Rmat = U @ Vt
                world_rot_by_idx[jidx] = Rmat
            except Exception:
                world_by_idx[jidx] = np.zeros(3, dtype=np.float64)
                world_rot_by_idx[jidx] = np.eye(3)
    for jidx in joint_node_idxs:
        if jidx not in world_by_idx:
            tr = nodes[jidx].get("translation") or [0.0, 0.0, 0.0]
            world_by_idx[jidx] = np.asarray(tr, dtype=np.float64)
        if jidx not in world_rot_by_idx:
            world_rot_by_idx[jidx] = np.eye(3)

    return (gltf, bin_blob, joint_node_idxs, parent_by_idx,
            name_by_idx, world_by_idx, world_rot_by_idx)


# ============================================================
# Public API
# ============================================================

def retarget_fbx_to_rig_ik(
    rig_glb_path: str,
    fbx_path: str,
    out_glb_path: str,
    source_skel_id: str,
    target_family: str,
    clip_name: str = "animation",
    target_fps: float = 30.0,
    **kwargs,
) -> dict:
    """IK-based retarget. Drop-in replacement for retarget_fbx_to_rig.

    Pipeline:
      1. Parse FBX -> source bone hierarchy + per-frame euler rotations.
      2. Load mapping JSON (MUST have an "effectors" section).
      3. Run source FK -> per-frame world positions of every source bone.
      4. For each frame:
         - For each effector chain on the target:
           - solve_chain to make the target effector REACH the
             corresponding source effector's world position.
         - Convert resulting per-bone world positions to parent-local
           quaternions.
      5. Combine all chain quaternions into per-bone tracks. Bones
         that aren't in any chain get an emitted rest-pose track so
         LBS sees a stable rotation (legacy approach).
      6. Emit GLB with one quat track per joint.

    Returns a diagnostics dict (mirrors retarget_fbx_to_rig).
    """
    # 1. Parse FBX.
    print(f"[ik_retarget] parsing FBX: {fbx_path} hint={source_skel_id}", flush=True)
    motion = parse_fbx(fbx_path, source_skel_hint=source_skel_id)
    detected = motion.get("detected_skeleton_id")

    effective_skel = source_skel_id
    if source_skel_id == "auto":
        effective_skel = detected or "ue5_mannequin"

    # 2. Load mapping (axis convention + classifier table + effectors).
    try:
        mapping = load_mapping(effective_skel, target_family)
    except KeyError:
        print(f"[ik_retarget] WARN no mapping for "
              f"({effective_skel},{target_family}); using ue5_mannequin",
              flush=True)
        effective_skel = "ue5_mannequin"
        mapping = load_mapping(effective_skel, target_family)

    # 2026-06-11 (Plan B1): if a labels.json sidecar exists next to the
    # rig (produced by puppeteer_semantic_extractor), build effectors
    # DYNAMICALLY from per-joint semantic labels. Falls back to the
    # static JSON otherwise so existing flows (orc_m1, mountain_dragon)
    # keep working unchanged.
    labels_sidecar = rig_glb_path + ".labels.json"
    if os.path.isfile(labels_sidecar):
        try:
            effectors = _effectors_from_labels(labels_sidecar, rig_glb_path)
            print(f"[ik_retarget] loaded {len(effectors)} effectors from "
                  f"DYNAMIC labels sidecar: {labels_sidecar}", flush=True)
        except Exception as e:
            print(f"[ik_retarget] WARN dynamic effectors failed ({e}); "
                  f"falling back to static JSON", flush=True)
            effectors = _load_effectors(effective_skel, target_family)
    else:
        effectors = _load_effectors(effective_skel, target_family)
        print(f"[ik_retarget] loaded {len(effectors)} effectors from mapping JSON",
              flush=True)

    # Axis-convention pre-rotation, same recipe as the rotation-transfer
    # path: we rotate WORLD-space inputs (offsets + root_pos) so that
    # source FK produces target-aligned world positions. Parent-local
    # rotations are axis-invariant once the world rest is rotated
    # consistently.
    if mapping.axis_source != mapping.axis_target:
        try:
            motion["offsets"] = mapping.axis_to_target(motion["offsets"])
            motion["root_pos"] = mapping.axis_to_target(motion["root_pos"])
            print(f"[ik_retarget] axis rotation: {mapping.axis_source} "
                  f"-> {mapping.axis_target}", flush=True)
        except Exception as e:
            print(f"[ik_retarget] WARN axis rotation failed: {e}", flush=True)

    # 3. Read the target rig BEFORE FK so we can establish the source
    # rest -> target rest scale (used to keep effector positions inside
    # the target's reach envelope).
    (gltf, bin_blob, joint_node_idxs, parent_by_idx, name_by_idx,
     world_by_idx, world_rot_by_idx) = _read_target_rig(rig_glb_path)

    n_frames = int(motion["n_frames"])
    if n_frames <= 0:
        raise RuntimeError("motion has 0 frames")

    # Source name -> bvh idx lookup.
    src_name_to_idx: Dict[str, int] = {n.strip().lower(): i
                                       for i, n in enumerate(motion["names"])}

    # Build effector pairing: each effector binds (source_bvh_idx,
    # target_chain_root_to_tip).
    eff_records: List[dict] = []
    for eff in effectors:
        src_bone_name = str(eff.get("source_bone") or "").strip().lower()
        chain_target = eff.get("chain_bones_target") or []
        if not src_bone_name or not chain_target:
            continue
        sidx = src_name_to_idx.get(src_bone_name)
        if sidx is None:
            print(f"[ik_retarget][warn] effector {eff.get('name')!r} source "
                  f"bone {src_bone_name!r} not in source skeleton; skipped",
                  flush=True)
            continue
        # Validate the chain — all nodes must exist in the rig.
        chain_int = [int(c) for c in chain_target]
        missing = [c for c in chain_int if c not in world_by_idx]
        if missing:
            print(f"[ik_retarget][warn] effector {eff.get('name')!r} chain "
                  f"references missing target nodes {missing}; skipped",
                  flush=True)
            continue
        eff_records.append({
            "name": str(eff.get("name") or ""),
            "src_idx": int(sidx),
            "chain": chain_int,        # root -> tip
        })

    if not eff_records:
        raise RuntimeError(
            f"no usable effectors after pairing source <-> target "
            f"(mapping defined {len(effectors)})"
        )
    print(f"[ik_retarget] paired {len(eff_records)}/{len(effectors)} effectors",
          flush=True)

    # 4. Source FK -> per-frame world positions of every source bone.
    print(f"[ik_retarget] running source FK on {len(motion['names'])} bones "
          f"x {n_frames} frames", flush=True)
    src_world_pos = _source_fk_world_positions(motion)   # (F, N_src, 3)

    # Source -> target scale: use the bounding-box height ratio between
    # the source FK rest pose and the target rest pose so effectors
    # don't overshoot small targets / undershoot large ones.
    src_rest_arr = src_world_pos[0]
    src_bb_min = src_rest_arr.min(axis=0)
    src_bb_max = src_rest_arr.max(axis=0)
    src_h = max(float((src_bb_max - src_bb_min)[1]), 1e-6)
    tgt_pts = np.asarray(list(world_by_idx.values()), dtype=np.float64)
    tgt_bb_min = tgt_pts.min(axis=0)
    tgt_bb_max = tgt_pts.max(axis=0)
    tgt_h = max(float((tgt_bb_max - tgt_bb_min)[1]), 1e-6)
    scale = tgt_h / src_h
    print(f"[ik_retarget] source bbox h={src_h:.4f} target bbox h={tgt_h:.4f} "
          f"scale={scale:.4f}", flush=True)

    src_centroid = 0.5 * (src_bb_min + src_bb_max)
    tgt_centroid = 0.5 * (tgt_bb_min + tgt_bb_max)

    def _src_to_tgt_space(p: np.ndarray) -> np.ndarray:
        """Transform a source-FK world position into target world space
        by uniform-scale + recentering on the target's bbox center."""
        return tgt_centroid + (p - src_centroid) * scale

    # 5. Per-frame IK + parent-local quat extraction.
    # The output quat tracks are indexed by target node idx.
    # `tgt_quats_xyzw[tni]` will be a (F, 4) array if the bone is in
    # some chain, otherwise omitted (rest-pose track emitted later).
    tgt_quats_xyzw: Dict[int, np.ndarray] = {
        tni: np.tile(IDENT_Q_XYZW, (n_frames, 1)) for tni in joint_node_idxs
    }
    # Track which target bones are driven by IK at all so unmapped
    # ones get a constant rest-pose track (legacy behaviour).
    driven: set = set()

    # Cache each chain's REST world positions (root -> tip) so we can
    # pass them to FABRIK every frame as the "current" pose.
    chain_rest_world: Dict[int, np.ndarray] = {}
    for rec in eff_records:
        chain = rec["chain"]
        chain_rest_world[id(rec)] = np.array(
            [world_by_idx[c] for c in chain], dtype=np.float64
        )

    for fi in range(n_frames):
        for rec in eff_records:
            chain = rec["chain"]
            sidx = rec["src_idx"]
            # Source effector world position at this frame, scaled into
            # target world space.
            src_eff_world = src_world_pos[fi, sidx]
            target_world = _src_to_tgt_space(src_eff_world)

            rest_world = chain_rest_world[id(rec)]
            anchor = rest_world[0]   # chain root stays pinned

            new_world = solve_chain(
                bone_positions_world=rest_world,
                target_world=target_world,
                anchor_world=anchor,
                max_iterations=10,
                tol=1e-4,
            )

            # Parent of the chain's ROOT bone, in PARENT-LOCAL frame for
            # the first bone of the chain (used by FABRIK -> quat).
            root_tni = chain[0]
            p_of_root = parent_by_idx.get(root_tni, -1)
            if p_of_root >= 0 and p_of_root in world_rot_by_idx:
                Rp = world_rot_by_idx[p_of_root]
            else:
                Rp = np.eye(3)
            parent_world_rest_xyzw = _quat_from_mat(Rp)
            parent_world_rest_wxyz = _xyzw_to_wxyz(parent_world_rest_xyzw)

            local_quats_wxyz = positions_to_local_rotations(
                rest_positions_world=rest_world,
                new_positions_world=new_world,
                parent_world_rest=parent_world_rest_wxyz,
            )
            # Convert each chain-bone's quat to xyzw and store on the
            # corresponding target node. Note: positions_to_local_rotations
            # returns N quats for N chain bones, in chain order
            # (root->tip). The tip quat is identity by convention.
            for ci, tni in enumerate(chain):
                q_wxyz = local_quats_wxyz[ci]
                q_xyzw = _wxyz_to_xyzw(q_wxyz)
                # IK gives a parent-local DELTA from rest. We need to
                # COMPOSE it onto the bone's rest-pose local quat to
                # get an absolute local quat, otherwise the rendered
                # rest pose at frame 0 would lose its bake-in orientation.
                rest_local_xyzw = _local_rest_quat(
                    tni, parent_by_idx, world_rot_by_idx
                )
                q_abs_xyzw = _q_mul_xyzw(q_xyzw, rest_local_xyzw)
                # Normalize for safety.
                n = np.linalg.norm(q_abs_xyzw)
                if n > 1e-12:
                    q_abs_xyzw = q_abs_xyzw / n
                tgt_quats_xyzw[tni][fi] = q_abs_xyzw
                driven.add(tni)

    # Sign-continuity across frames for every driven bone, so the
    # Three.js mixer doesn't double-flip mid-clip.
    for tni in driven:
        q = tgt_quats_xyzw[tni]
        for i in range(1, q.shape[0]):
            if np.dot(q[i], q[i - 1]) < 0.0:
                q[i] = -q[i]

    # 6. Emit GLB. One quat track per joint; unmapped joints get a
    # constant rest-pose track (LBS needs an explicit identity so the
    # bone doesn't drift along with an animated parent).
    print(f"[ik_retarget] writing {out_glb_path}", flush=True)

    bin_data = bytearray(bin_blob)
    samplers: List[dict] = []
    channels_anim: List[dict] = []

    # Shared timeline.
    frame_time = float(motion.get("frame_time") or (1.0 / 30.0))
    times = np.arange(n_frames, dtype=np.float32) * frame_time
    if target_fps and target_fps > 0:
        new_t = np.arange(0.0, float(times[-1]) + 1.0 / target_fps,
                          1.0 / target_fps, dtype=np.float32)
    else:
        new_t = times

    input_bv = _add_buffer_view(gltf, bin_data, new_t.astype("<f4").tobytes())
    input_acc = _add_accessor(
        gltf, input_bv, count=len(new_t),
        comp_type=5126, acc_type="SCALAR",
        minv=[float(new_t[0])], maxv=[float(new_t[-1])],
    )

    def _emit_rest_quat_track(tni_):
        """Constant 2-frame rest-quat track. Same pattern as the
        legacy core's `_emit_rest_quat_track`."""
        q_rest = _local_rest_quat(tni_, parent_by_idx, world_rot_by_idx)
        t2 = np.array([0.0, float(new_t[-1])], dtype="<f4")
        in_bv = _add_buffer_view(gltf, bin_data, t2.tobytes())
        in_acc = _add_accessor(
            gltf, in_bv, count=2,
            comp_type=5126, acc_type="SCALAR",
            minv=[float(t2[0])], maxv=[float(t2[-1])],
        )
        q2 = np.stack([q_rest, q_rest], axis=0).astype("<f4")
        out_bv_ = _add_buffer_view(gltf, bin_data, q2.tobytes())
        out_acc_ = _add_accessor(
            gltf, out_bv_, count=2,
            comp_type=5126, acc_type="VEC4",
        )
        s_idx_ = len(samplers)
        samplers.append({"input": in_acc, "output": out_acc_,
                         "interpolation": "LINEAR"})
        channels_anim.append({
            "sampler": s_idx_,
            "target": {"node": tni_, "path": "rotation"},
        })

    for tni in joint_node_idxs:
        if tni not in driven:
            _emit_rest_quat_track(tni)
            continue
        q = tgt_quats_xyzw[tni]
        # Resample to target FPS if needed (nearest-neighbour quat).
        if target_fps and target_fps > 0 and len(new_t) != n_frames:
            idxs = np.clip((new_t / max(times[-1], 1e-6)) * (n_frames - 1),
                           0, n_frames - 1)
            idxs = idxs.round().astype(np.int64)
            q = q[idxs]
            for i in range(1, q.shape[0]):
                if np.dot(q[i], q[i - 1]) < 0.0:
                    q[i] = -q[i]
        q = q.astype("<f4")
        out_bv = _add_buffer_view(gltf, bin_data, q.tobytes())
        out_acc = _add_accessor(
            gltf, out_bv, count=q.shape[0],
            comp_type=5126, acc_type="VEC4",
        )
        s_idx = len(samplers)
        samplers.append({"input": input_acc, "output": out_acc,
                         "interpolation": "LINEAR"})
        channels_anim.append({
            "sampler": s_idx,
            "target": {"node": tni, "path": "rotation"},
        })

    # Root translation track on the hip effector's chain root, if any.
    hip_eff = next((r for r in eff_records
                    if r["name"].lower() in ("hip", "pelvis", "root")), None)
    if hip_eff is not None:
        hip_tni = hip_eff["chain"][-1]  # tip of the "hip" effector chain
        # If the hip chain is single-bone, root == tip.
        if hip_tni in world_by_idx:
            hip_rest = world_by_idx[hip_tni]
            # Per-frame translation: rest hip position + scaled delta of
            # the source root pos (already pre-rotated to target axes
            # earlier in this function).
            rp_in = motion.get("root_pos")
            if rp_in is None:
                rp_in = np.zeros((n_frames, 3))
            root_pos = np.asarray(rp_in, dtype=np.float64)
            if (root_pos.ndim == 2 and root_pos.shape[0] == n_frames
                    and root_pos.shape[1] == 3):
                tr = (hip_rest + (root_pos - root_pos[0:1]) * scale)
                if target_fps and target_fps > 0 and len(new_t) != n_frames:
                    idxs = np.clip((new_t / max(times[-1], 1e-6)) * (n_frames - 1),
                                   0, n_frames - 1)
                    idxs = idxs.round().astype(np.int64)
                    tr = tr[idxs]
                tr = tr.astype("<f4")
                tr_bv = _add_buffer_view(gltf, bin_data, tr.tobytes())
                tr_acc = _add_accessor(
                    gltf, tr_bv, count=tr.shape[0],
                    comp_type=5126, acc_type="VEC3",
                )
                s_idx_tr = len(samplers)
                samplers.append({"input": input_acc, "output": tr_acc,
                                 "interpolation": "LINEAR"})
                channels_anim.append({
                    "sampler": s_idx_tr,
                    "target": {"node": hip_tni, "path": "translation"},
                })
                print(f"[ik_retarget] root translation track: hip_tni={hip_tni} "
                      f"scale={scale:.4f} frames={tr.shape[0]}", flush=True)

    anim_obj = {
        "name": clip_name,
        "samplers": samplers,
        "channels": channels_anim,
    }
    gltf.setdefault("animations", []).append(anim_obj)
    _write_glb(gltf, bytes(bin_data), out_glb_path)
    print(f"[ik_retarget] wrote {out_glb_path}: "
          f"{len(channels_anim)} channels, {len(new_t)} samples", flush=True)

    return {
        "detected_skeleton_id": detected,
        "source_skel_id_used": effective_skel,
        "target_family": target_family,
        "n_frames": n_frames,
        "n_effectors": len(eff_records),
        "n_driven_bones": len(driven),
    }


# ============================================================
# Internal helpers
# ============================================================

# Cache of bone -> parent-local rest quat to avoid re-computing on
# every effector pass (each chain bone is touched per-frame and the
# rest never changes). Keyed by id(world_rot_by_idx) so multiple
# concurrent retargets don't share cache.
_REST_CACHE: Dict[Tuple[int, int], np.ndarray] = {}


def _local_rest_quat(
    tni: int,
    parent_by_idx: Dict[int, int],
    world_rot_by_idx: Dict[int, np.ndarray],
) -> np.ndarray:
    """Parent-local rest quat (xyzw) for joint `tni`. Same recipe as
    `retarget_motion_to_rig`: R_local = R_parent^T @ R_world."""
    key = (id(world_rot_by_idx), tni)
    cached = _REST_CACHE.get(key)
    if cached is not None:
        return cached
    Rw = world_rot_by_idx.get(tni, np.eye(3))
    p = parent_by_idx.get(tni, -1)
    if p < 0 or p not in world_rot_by_idx:
        Rp = np.eye(3)
    else:
        Rp = world_rot_by_idx[p]
    R_local = Rp.T @ Rw
    q = _quat_from_mat(R_local)
    _REST_CACHE[key] = q
    return q


# ============================================================
# CLI smoke test
# ============================================================

if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="IK-based FBX -> GLB retarget")
    ap.add_argument("--rig", required=True, help="input Puppeteer rig GLB")
    ap.add_argument("--fbx", required=True, help="input animation FBX")
    ap.add_argument("--out", required=True, help="output animated GLB")
    ap.add_argument("--source-skel", default="auto",
                    help="source skeleton id (ue5_mannequin / orc_m1 / auto)")
    ap.add_argument("--target-family", default="humanoid_puppeteer",
                    help="target family (humanoid_puppeteer / flying_quadruped)")
    ap.add_argument("--clip-name", default="animation")
    ap.add_argument("--fps", type=float, default=30.0)
    args = ap.parse_args()
    info = retarget_fbx_to_rig_ik(
        rig_glb_path=args.rig,
        fbx_path=args.fbx,
        out_glb_path=args.out,
        source_skel_id=args.source_skel,
        target_family=args.target_family,
        clip_name=args.clip_name,
        target_fps=args.fps,
    )
    print(json.dumps(info, indent=2))
