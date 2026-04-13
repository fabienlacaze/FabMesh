"""
Swap a UniRig skeleton (34 bones) with the orc_m1 UE5 skeleton (117 bones)
in a rigged GLB file, transferring skinning weights via spatial nearest-neighbor.

No Blender required — pure pygltflib + numpy.

Usage:
    python swap_skeleton.py <unirig_rigged.glb> <orc_bones.json> <output.glb>

Author: FabWare / MeshyMyself
"""

import json
import struct
import sys
import os
import numpy as np
import pygltflib
from pygltflib import (
    GLTF2, Accessor, Buffer, BufferView, Node, Skin, Scene,
    FLOAT, UNSIGNED_SHORT, UNSIGNED_BYTE, UNSIGNED_INT,
    MAT4, VEC4, SCALAR,
)

# glTF component type constants
COMPONENT_FLOAT = 5126
COMPONENT_UNSIGNED_SHORT = 5123
COMPONENT_UNSIGNED_BYTE = 5121


# ---------------------------------------------------------------------------
# Matrix helpers
# ---------------------------------------------------------------------------

def _translation_matrix(t):
    """Build a 4x4 translation matrix from a (3,) vector."""
    m = np.eye(4, dtype=np.float64)
    m[:3, 3] = t
    return m


def _rotate_point_around_pivot_z(point, pivot, angle_rad):
    """Rotate a 3D point around a pivot on the Z axis (glTF Y-up space)."""
    dx = point[0] - pivot[0]
    dy = point[1] - pivot[1]
    cos_a = np.cos(angle_rad)
    sin_a = np.sin(angle_rad)
    return np.array([
        pivot[0] + dx * cos_a - dy * sin_a,
        pivot[1] + dx * sin_a + dy * cos_a,
        point[2],  # Z unchanged
    ], dtype=np.float64)


def _get_descendants(bone_idx, parent_indices):
    """Return set of all descendant indices (children, grandchildren, etc.) of bone_idx."""
    descendants = set()
    queue = [bone_idx]
    while queue:
        current = queue.pop()
        for i, pi in enumerate(parent_indices):
            if pi == current and i not in descendants:
                descendants.add(i)
                queue.append(i)
    return descendants


# [LEGACY] Bones to exclude from nearest-neighbor mapping targets.
# No longer used — semantic mapping replaced spatial nearest-neighbor in Section 5.
EXCLUDED_MAPPING_BONES = {
    "cc_base_facialbone", "cc_base_jawroot",
    "cc_base_tongue01", "cc_base_tongue02", "cc_base_tongue03",
    "cc_base_teeth01", "cc_base_teeth02",
    "cc_base_r_eye", "cc_base_l_eye",
    "cc_base_upperjaw",
}


# ---------------------------------------------------------------------------
# Topology-based UniRig bone classifier (pure pygltflib, no Blender)
# ---------------------------------------------------------------------------

def _glb_chain_depth(children_map, name):
    """Recursively compute the depth of the longest chain from a node."""
    kids = children_map.get(name, [])
    if not kids:
        return 0
    return 1 + max(_glb_chain_depth(children_map, c) for c in kids)


def _glb_find_chain(children_map, start):
    """Follow the longest chain from start node, always picking the deepest child."""
    chain = [start]
    current = start
    while True:
        kids = children_map.get(current, [])
        if not kids:
            break
        best = max(kids, key=lambda c: _glb_chain_depth(children_map, c))
        chain.append(best)
        current = best
    return chain


def classify_unirig_bones(gltf, skin_index=0):
    """
    Analyze the UniRig skeleton hierarchy in a GLB and return a mapping
    from UniRig bone name -> UE5 semantic name (e.g. 'pelvis', 'spine_01', etc.).

    Works with pure pygltflib data (no Blender). Uses:
    - node.children for hierarchy
    - node.translation for positions (accumulated up-chain for world positions)
    """
    skin = gltf.skins[skin_index]
    joint_indices = list(skin.joints)
    joint_set = set(joint_indices)

    # Build world positions by walking up the node tree
    node_parent = {}
    for i, node in enumerate(gltf.nodes):
        if node.children:
            for child in node.children:
                node_parent[child] = i

    def world_pos(node_idx):
        chain = []
        cur = node_idx
        while cur is not None:
            chain.append(cur)
            cur = node_parent.get(cur)
        pos = np.zeros(3, dtype=np.float64)
        for ni in reversed(chain):
            nd = gltf.nodes[ni]
            if nd.translation:
                pos += np.array(nd.translation, dtype=np.float64)
        return pos

    # Gather positions and names for all joint nodes
    positions = {}   # node_idx -> world pos
    names = {}       # node_idx -> name
    for ni in joint_indices:
        positions[ni] = world_pos(ni)
        names[ni] = gltf.nodes[ni].name or f"joint_{ni}"

    # Build children map among joints only (using node_idx as key)
    children_map = {}  # node_idx -> [child node_idx, ...]
    parent_map = {}    # node_idx -> parent node_idx (among joints)
    for ni in joint_indices:
        children_map[ni] = []
    for ni in joint_indices:
        nd = gltf.nodes[ni]
        if nd.children:
            for ci in nd.children:
                if ci in joint_set:
                    children_map[ni].append(ci)
                    parent_map[ci] = ni

    # Find root(s) — joints with no joint-parent
    roots = [ni for ni in joint_indices if ni not in parent_map]
    if not roots:
        return {}

    # Pick the root with the deepest subtree
    root = max(roots, key=lambda r: _glb_chain_depth(children_map, r))

    # Detect up-axis from bounding box of all joint positions
    all_pos = np.array([positions[ni] for ni in joint_indices])
    bbox_min = all_pos.min(axis=0)
    bbox_max = all_pos.max(axis=0)
    bbox_size = bbox_max - bbox_min
    # glTF is typically Y-up, but UniRig might use Z-up
    up_idx = 1 if bbox_size[1] >= bbox_size[2] else 2

    def get_up(v):
        return v[up_idx]

    def get_lr(v):
        return v[0]  # X = left/right

    body_height = bbox_size[up_idx]

    # Main chain from root (spine -> head)
    spine_chain = _glb_find_chain(children_map, root)

    # Find branch points along the spine chain
    spine_set = set(spine_chain)
    branch_points = []  # (chain_index, node_idx, [side_children])
    for i, ni in enumerate(spine_chain):
        side_kids = [c for c in children_map[ni] if c not in spine_set]
        if side_kids:
            branch_points.append((i, ni, side_kids))

    # Classify branches into upper (arms) and lower (legs)
    upper_branches = []  # (branch_root_node_idx, x_position)
    lower_branches = []

    for idx, bname_ni, side_kids in branch_points:
        branch_pos = positions[bname_ni]
        relative_height = (get_up(branch_pos) - get_up(bbox_min)) / max(body_height, 1e-6)

        for kid in side_kids:
            kid_chain = _glb_find_chain(children_map, kid)
            chain_end_pos = positions[kid_chain[-1]]
            drop = get_up(branch_pos) - get_up(chain_end_pos)
            # Lateral spread: max lateral displacement anywhere in the chain
            lateral = max(abs(get_lr(positions[c]) - get_lr(branch_pos)) for c in kid_chain)

            print(f"[swap] classify: kid={kid} relH={relative_height:.2f} drop={drop:.3f} lateral={lateral:.3f} body_h={body_height:.3f}")
            # Arms: branch from upper body AND has significant lateral spread
            # Legs: branch from lower body OR drops a lot with little lateral spread
            if relative_height > 0.25 and lateral > body_height * 0.03:
                upper_branches.append((kid, get_lr(positions[kid])))
            elif drop > body_height * 0.25 and lateral < body_height * 0.15:
                lower_branches.append((kid, get_lr(positions[kid])))
            elif relative_height > 0.5:
                upper_branches.append((kid, get_lr(positions[kid])))
            else:
                lower_branches.append((kid, get_lr(positions[kid])))

    # Debug: log branch detection
    print(f"[swap] classify: spine_chain={spine_chain} ({len(spine_chain)} bones)")
    print(f"[swap] classify: branch_points={[(i, ni, sk) for i, ni, sk in branch_points]}")
    print(f"[swap] classify: upper_branches={upper_branches}")
    print(f"[swap] classify: lower_branches={lower_branches}")

    # If we didn't find 2 arms, try harder: any branch from the upper half
    # of the spine that has at least 2 bones in the chain is likely an arm.
    if len(upper_branches) < 2:
        # Collect all non-leg candidates from the upper spine
        arm_candidates = []
        for idx, bname_ni, side_kids in branch_points:
            branch_pos = positions[bname_ni]
            relative_height = (get_up(branch_pos) - get_up(bbox_min)) / max(body_height, 1e-6)
            if relative_height < 0.25:
                continue  # too low for arms
            for kid in side_kids:
                if kid in [lb[0] for lb in lower_branches]:
                    continue  # already classified as leg
                if kid in [ub[0] for ub in upper_branches]:
                    continue  # already classified as arm
                kid_chain = _glb_find_chain(children_map, kid)
                if len(kid_chain) >= 2:  # arms have at least 2 bones
                    arm_candidates.append((kid, get_lr(positions[kid])))
        if len(arm_candidates) >= 2:
            # Take the 2 most lateral ones
            arm_candidates.sort(key=lambda x: abs(x[1]), reverse=True)
            upper_branches.extend(arm_candidates[:2])
            print(f"[swap] classify: forced {len(arm_candidates[:2])} arm candidates from upper spine branches")

    # Sort by X for left/right distinction
    upper_branches.sort(key=lambda x: x[1])
    lower_branches.sort(key=lambda x: x[1])

    # Build name mapping: node_idx -> UE5 name
    mapping = {}  # node_idx -> ue5_name

    # Spine chain naming
    spine_ue5 = ["pelvis", "spine_01", "spine_02", "spine_03", "spine_04",
                 "spine_05", "neck_01", "neck_02", "head"]
    for i, ni in enumerate(spine_chain):
        if i < len(spine_ue5):
            mapping[ni] = spine_ue5[i]
        else:
            mapping[ni] = f"spine_extra_{i}"

    # Arm chains
    arm_ue5 = ["clavicle", "upperarm", "lowerarm", "hand",
               "index_01", "index_02", "index_03"]
    if len(upper_branches) >= 2:
        right_root = upper_branches[0][0]   # more negative X
        left_root = upper_branches[-1][0]   # more positive X

        for side_label, branch_root in [("_r", right_root), ("_l", left_root)]:
            chain = _glb_find_chain(children_map, branch_root)
            for i, ni in enumerate(chain):
                if i < len(arm_ue5):
                    mapping[ni] = f"{arm_ue5[i]}{side_label}"
                else:
                    mapping[ni] = f"finger{side_label}_{i}"

    # Leg chains
    leg_ue5 = ["thigh", "calf", "foot", "ball", "toe"]
    if len(lower_branches) >= 2:
        right_root = lower_branches[0][0]
        left_root = lower_branches[-1][0]

        for side_label, branch_root in [("_r", right_root), ("_l", left_root)]:
            chain = _glb_find_chain(children_map, branch_root)
            for i, ni in enumerate(chain):
                if i < len(leg_ue5):
                    mapping[ni] = f"{leg_ue5[i]}{side_label}"
                else:
                    mapping[ni] = f"toe{side_label}_{i}"

    # Convert node_idx -> (original_bone_name, ue5_name)
    result = {}
    for ni in joint_indices:
        bone_name = names[ni]
        if ni in mapping:
            result[bone_name] = mapping[ni]

    # Also return the node_idx mapping and parent info for unmapped bone resolution
    result["__node_mapping__"] = mapping        # node_idx -> ue5_name
    result["__parent_map__"] = parent_map        # node_idx -> parent node_idx
    result["__joint_indices__"] = joint_indices   # ordered joint list
    result["__names__"] = names                  # node_idx -> bone_name

    return result


def pose_orc_apose(orc_heads, orc_names, orc_parent_indices, angle_deg=70):
    """
    [LEGACY] Return a copy of orc_heads with arms rotated down to approximate A-pose.
    No longer used — semantic mapping replaced spatial nearest-neighbor in Section 5.
    Kept for potential future use / debugging.
    """
    posed = orc_heads.copy()
    name_to_idx = {n: i for i, n in enumerate(orc_names)}

    for side_name, sign in [("upperarm_l", -1), ("upperarm_r", +1)]:
        if side_name not in name_to_idx:
            continue
        root_idx = name_to_idx[side_name]
        pivot = orc_heads[root_idx]  # rotation pivot = upperarm head
        angle_rad = np.radians(sign * angle_deg)

        # Rotate the upperarm itself and all its descendants
        descendants = _get_descendants(root_idx, orc_parent_indices)
        indices_to_rotate = {root_idx} | descendants

        for idx in indices_to_rotate:
            posed[idx] = _rotate_point_around_pivot_z(posed[idx], pivot, angle_rad)

    return posed


# ---------------------------------------------------------------------------
# Binary data helpers
# ---------------------------------------------------------------------------

def read_accessor_data(gltf, blob, accessor_index):
    """Read raw data from a glTF accessor as a numpy array."""
    acc = gltf.accessors[accessor_index]
    bv = gltf.bufferViews[acc.bufferView]

    # Determine element size
    component_sizes = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
    type_counts = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}

    comp_size = component_sizes[acc.componentType]
    n_components = type_counts[acc.type]
    elem_size = comp_size * n_components

    # Byte stride: if defined use it, else tightly packed
    byte_stride = bv.byteStride if bv.byteStride else elem_size

    offset = bv.byteOffset + acc.byteOffset
    count = acc.count

    # Numpy dtype for the component
    dtype_map = {
        5120: np.int8, 5121: np.uint8,
        5122: np.int16, 5123: np.uint16,
        5125: np.uint32, 5126: np.float32,
    }
    dtype = dtype_map[acc.componentType]

    if byte_stride == elem_size:
        # Tightly packed — fast path
        raw = blob[offset: offset + count * elem_size]
        arr = np.frombuffer(raw, dtype=dtype).reshape(count, n_components)
    else:
        # Strided — read element by element
        arr = np.zeros((count, n_components), dtype=dtype)
        for i in range(count):
            start = offset + i * byte_stride
            elem_bytes = blob[start: start + elem_size]
            arr[i] = np.frombuffer(elem_bytes, dtype=dtype)

    return arr.copy()  # copy to make it writable


def get_joint_world_positions(gltf, skin_index):
    """
    Compute world-space positions for each joint in a skin by walking
    the node hierarchy and accumulating translations.

    Returns: (J, 3) float64 array of joint world positions
    """
    skin = gltf.skins[skin_index]
    joint_indices = skin.joints
    J = len(joint_indices)

    # Build a node parent map for the joint nodes
    # We need to find the parent of each joint node in the scene graph
    node_parent = {}
    for i, node in enumerate(gltf.nodes):
        if node.children:
            for child in node.children:
                node_parent[child] = i

    # For each joint, walk up the hierarchy accumulating translations
    positions = np.zeros((J, 3), dtype=np.float64)
    for j_idx in range(J):
        node_idx = joint_indices[j_idx]
        # Walk up to root, collecting translations
        chain = []
        current = node_idx
        while current is not None:
            chain.append(current)
            current = node_parent.get(current, None)

        # Accumulate translations from root down
        pos = np.zeros(3, dtype=np.float64)
        for ni in reversed(chain):
            node = gltf.nodes[ni]
            if node.translation:
                pos += np.array(node.translation, dtype=np.float64)
            # Note: we ignore rotation/scale — UniRig uses pure translations
        positions[j_idx] = pos

    return positions


# ---------------------------------------------------------------------------
# Core swap function
# ---------------------------------------------------------------------------

def swap_skeleton(input_glb, orc_bones_json, output_glb, verbose=True):
    """
    Swap the UniRig skeleton in a rigged GLB with the orc_m1 UE5 skeleton.

    Steps:
      1. Load UniRig GLB, extract bone positions and JOINTS_0/WEIGHTS_0
      2. Load orc bones, filter IK, convert to glTF Y-up
      3. Align orc skeleton to UniRig mesh bounding box
      4. (reserved)
      5. SEMANTIC mapping: classify UniRig bones by topology (spine/arms/legs),
         then match to orc bones by UE5 name. Unmapped bones inherit from ancestor.
      6. Remap JOINTS_0 indices
      7. Rebuild skeleton with orc hierarchy
      8. Save
    """

    # ==================================================================
    # 1. Load the UniRig rigged GLB
    # ==================================================================
    if verbose:
        print(f"[swap] Loading UniRig GLB: {input_glb}")
    gltf = GLTF2().load(input_glb)
    blob = bytearray(gltf.binary_blob() or b"")

    # Find the skin
    if not gltf.skins or len(gltf.skins) == 0:
        raise RuntimeError("Input GLB has no skin — is it rigged?")

    skin = gltf.skins[0]
    old_joint_indices = list(skin.joints)
    J_old = len(old_joint_indices)
    if verbose:
        print(f"[swap] Found skin with {J_old} joints")

    # Extract UniRig joint world positions
    unirig_positions = get_joint_world_positions(gltf, 0)
    if verbose:
        print(f"[swap] UniRig joint positions shape: {unirig_positions.shape}")
        for i, ji in enumerate(old_joint_indices[:5]):
            name = gltf.nodes[ji].name or f"joint_{i}"
            print(f"       [{i}] {name}: {unirig_positions[i]}")

    # Find mesh node(s) and read JOINTS_0 / WEIGHTS_0
    mesh_node_indices = []
    for i, node in enumerate(gltf.nodes):
        if node.mesh is not None and node.skin is not None:
            mesh_node_indices.append(i)

    if not mesh_node_indices:
        raise RuntimeError("No skinned mesh node found!")

    # Read JOINTS_0 and WEIGHTS_0 from the first primitive
    mesh_node = gltf.nodes[mesh_node_indices[0]]
    mesh_obj = gltf.meshes[mesh_node.mesh]
    prim = mesh_obj.primitives[0]

    if prim.attributes.JOINTS_0 is None or prim.attributes.WEIGHTS_0 is None:
        raise RuntimeError("Mesh has no JOINTS_0/WEIGHTS_0 attributes!")

    joints_data = read_accessor_data(gltf, blob, prim.attributes.JOINTS_0)   # (N, 4) uint8/16
    weights_data = read_accessor_data(gltf, blob, prim.attributes.WEIGHTS_0) # (N, 4) float32
    N = joints_data.shape[0]
    if verbose:
        print(f"[swap] Read JOINTS_0/WEIGHTS_0 for {N} vertices")

    # Also read POSITION to get mesh bounding box
    pos_data = read_accessor_data(gltf, blob, prim.attributes.POSITION)  # (N, 3) float32
    mesh_min = pos_data.min(axis=0)
    mesh_max = pos_data.max(axis=0)
    mesh_center = (mesh_min + mesh_max) / 2.0
    mesh_size = mesh_max - mesh_min
    if verbose:
        print(f"[swap] Mesh bbox: min={mesh_min}, max={mesh_max}, size={mesh_size}")

    # ==================================================================
    # 2. Load orc bones JSON
    # ==================================================================
    if verbose:
        print(f"[swap] Loading orc bones: {orc_bones_json}")
    with open(orc_bones_json, "r", encoding="utf-8") as f:
        orc_data = json.load(f)

    all_bones = orc_data["bones"]

    # Filter out IK bones
    orc_bones = [b for b in all_bones if not b["name"].startswith("ik_")]
    if verbose:
        ik_count = len(all_bones) - len(orc_bones)
        print(f"[swap] Loaded {len(all_bones)} bones, filtered {ik_count} IK -> {len(orc_bones)} remaining")

    orc_names = [b["name"] for b in orc_bones]
    orc_parents = [b["parent"] for b in orc_bones]
    J_orc = len(orc_bones)

    # Build name -> index map (in filtered list)
    orc_name_to_idx = {n: i for i, n in enumerate(orc_names)}

    # Fix parent references: if a bone's parent was filtered out (IK parent),
    # walk up until we find a non-IK parent
    all_bone_map = {b["name"]: b for b in all_bones}
    for i, pname in enumerate(orc_parents):
        if pname is None:
            continue
        # Walk up until we find a parent that exists in our filtered set
        current_parent = pname
        while current_parent is not None and current_parent not in orc_name_to_idx:
            parent_bone = all_bone_map.get(current_parent)
            current_parent = parent_bone["parent"] if parent_bone else None
        orc_parents[i] = current_parent

    # ==================================================================
    # 3. Convert orc bone positions: Blender Z-up -> glTF Y-up
    #    Blender (x, y, z) -> glTF (x, z, -y)
    # ==================================================================
    orc_heads_blender = np.array([b["head"] for b in orc_bones], dtype=np.float64)

    orc_heads_gltf = np.zeros_like(orc_heads_blender)
    orc_heads_gltf[:, 0] = orc_heads_blender[:, 0]   # x -> x
    orc_heads_gltf[:, 1] = orc_heads_blender[:, 2]   # z -> y
    orc_heads_gltf[:, 2] = -orc_heads_blender[:, 1]  # -y -> z

    if verbose:
        print(f"[swap] Orc bones (glTF space): {J_orc} joints")
        orc_min = orc_heads_gltf.min(axis=0)
        orc_max = orc_heads_gltf.max(axis=0)
        print(f"       Orc bbox: min={orc_min}, max={orc_max}")

    # ==================================================================
    # 4. Align orc skeleton to match the actual MESH bbox
    #    (not the UniRig joint bbox, which only covers upper body)
    # ==================================================================
    orc_min = orc_heads_gltf.min(axis=0)
    orc_max = orc_heads_gltf.max(axis=0)
    orc_size = orc_max - orc_min
    orc_center = (orc_min + orc_max) / 2.0

    # Scale factor: match the height (Y axis in glTF = up) to MESH height
    scale_y = mesh_size[1] / orc_size[1] if orc_size[1] > 1e-6 else 1.0
    # Use uniform scale to preserve proportions
    scale = scale_y

    if verbose:
        print(f"[swap] Alignment: scale={scale:.4f}")
        print(f"       Mesh bbox center={mesh_center}, size={mesh_size}")
        print(f"       Orc center={orc_center}, size={orc_size}")

    # Apply: scale around orc center, then translate to match mesh floor + center
    orc_heads_scaled = (orc_heads_gltf - orc_center) * scale
    # Floor-align: match the bottom (min Y) to mesh min Y
    orc_scaled_min = orc_heads_scaled.min(axis=0)
    floor_offset = np.zeros(3)
    floor_offset[1] = mesh_min[1] - orc_scaled_min[1]  # Y = up in glTF
    # Center X and Z to mesh center
    orc_scaled_center = (orc_heads_scaled.min(axis=0) + orc_heads_scaled.max(axis=0)) / 2.0
    floor_offset[0] = mesh_center[0] - orc_scaled_center[0]
    floor_offset[2] = mesh_center[2] - orc_scaled_center[2]
    orc_heads_aligned = orc_heads_scaled + floor_offset

    if verbose:
        aligned_min = orc_heads_aligned.min(axis=0)
        aligned_max = orc_heads_aligned.max(axis=0)
        print(f"       Aligned orc bbox: min={aligned_min}, max={aligned_max}")

    # ==================================================================
    # 5. SEMANTIC mapping: classify UniRig bones by topology, then match
    #    to orc bones by UE5 name (pelvis->pelvis, spine_01->spine_01, etc.)
    #    Unmapped UniRig bones inherit from their nearest mapped ancestor.
    # ==================================================================

    # Build parent indices for orc (needed later for hierarchy)
    orc_parent_idx_list = []
    for pname in orc_parents:
        if pname is None:
            orc_parent_idx_list.append(-1)
        else:
            orc_parent_idx_list.append(orc_name_to_idx.get(pname, -1))

    # --- Step 5a: Classify UniRig bones using topology analysis ---
    classification = classify_unirig_bones(gltf, skin_index=0)

    # Extract internal data and remove metadata keys
    node_mapping = classification.pop("__node_mapping__", {})    # node_idx -> ue5_name
    unirig_parent_map = classification.pop("__parent_map__", {}) # node_idx -> parent node_idx
    unirig_joint_list = classification.pop("__joint_indices__", [])
    unirig_names_map = classification.pop("__names__", {})

    # classification now is: {unirig_bone_name -> ue5_name}
    if verbose:
        print(f"\n[swap] UniRig topology classification ({len(classification)} mapped):")
        for bone_name, ue5_name in sorted(classification.items(), key=lambda x: x[1]):
            print(f"       {bone_name:20s} -> {ue5_name}")

    # --- Step 5b: For each UniRig joint, find the orc bone by exact UE5 name ---
    unirig_to_orc = np.zeros(J_old, dtype=np.int32)

    for i in range(J_old):
        node_idx = old_joint_indices[i]
        bone_name = gltf.nodes[node_idx].name or f"bone_{i}"
        ue5_name = classification.get(bone_name)

        if ue5_name and ue5_name in orc_name_to_idx:
            # Direct semantic match
            unirig_to_orc[i] = orc_name_to_idx[ue5_name]
        else:
            # No direct match — walk up UniRig hierarchy to find nearest
            # mapped ancestor, then use that ancestor's orc bone
            ancestor_orc_idx = None
            current = node_idx
            while current is not None:
                ancestor_ue5 = node_mapping.get(current)
                if ancestor_ue5 and ancestor_ue5 in orc_name_to_idx:
                    ancestor_orc_idx = orc_name_to_idx[ancestor_ue5]
                    break
                current = unirig_parent_map.get(current)

            if ancestor_orc_idx is not None:
                unirig_to_orc[i] = ancestor_orc_idx
            else:
                # Ultimate fallback: map to pelvis (root)
                unirig_to_orc[i] = orc_name_to_idx.get("pelvis", 0)

    if verbose:
        print(f"\n[swap] Semantic bone mapping (UniRig -> Orc):")
        for i in range(J_old):
            old_name = gltf.nodes[old_joint_indices[i]].name or f"bone_{i}"
            ue5_name = classification.get(old_name, "(unmapped)")
            new_idx = unirig_to_orc[i]
            new_name = orc_names[new_idx]
            marker = "*" if ue5_name == "(unmapped)" else " "
            print(f"      {marker}[{i:2d}] {old_name:20s} ({ue5_name:15s}) -> [{new_idx:3d}] {new_name}")

    # ==================================================================
    # 6. Remap JOINTS_0 indices
    #    Each vertex's joint indices point into the old 34-bone list.
    #    Remap them to point into the new orc bone list.
    # ==================================================================
    new_joints = np.zeros_like(joints_data, dtype=np.uint8)
    for v in range(N):
        for k in range(4):
            old_idx = int(joints_data[v, k])
            if old_idx < J_old:
                new_joints[v, k] = unirig_to_orc[old_idx]
            else:
                new_joints[v, k] = 0  # safety fallback

    if verbose:
        # Show some sample remappings
        print(f"\n[swap] Sample vertex remappings (first 5):")
        for v in range(min(5, N)):
            old_j = joints_data[v]
            new_j = new_joints[v]
            w = weights_data[v]
            print(f"       v{v}: joints {old_j} -> {new_j}, weights={w}")

    # ==================================================================
    # 7. Remove old skeleton nodes, create new orc skeleton
    # ==================================================================
    # Strategy: we'll remove old joint nodes from the scene and skin,
    # then append new orc joint nodes.

    # First, disconnect old joint nodes from the scene
    if gltf.scenes:
        scene = gltf.scenes[gltf.scene if gltf.scene is not None else 0]
        # Remove old root joints from scene.nodes
        old_joint_set = set(old_joint_indices)
        scene.nodes = [n for n in scene.nodes if n not in old_joint_set]

    # Clear children of old joint nodes (break hierarchy) but keep the nodes
    # in the array to avoid re-indexing (we just won't reference them)
    for ji in old_joint_indices:
        gltf.nodes[ji].children = []
        gltf.nodes[ji].name = f"_deprecated_{ji}"

    # Reuse parent indices already computed for the A-pose rotation
    orc_parent_indices = orc_parent_idx_list

    # Compute local translations for orc bones (using ORIGINAL T-pose positions)
    orc_local_translations = np.zeros((J_orc, 3), dtype=np.float64)
    for i in range(J_orc):
        pi = orc_parent_indices[i]
        if pi < 0:
            orc_local_translations[i] = orc_heads_aligned[i]
        else:
            orc_local_translations[i] = orc_heads_aligned[i] - orc_heads_aligned[pi]

    # Append new joint nodes
    node_offset = len(gltf.nodes)
    new_joint_node_indices = []

    for i in range(J_orc):
        t = orc_local_translations[i]
        node = Node(
            name=orc_names[i],
            translation=[float(t[0]), float(t[1]), float(t[2])],
            children=[],
        )
        gltf.nodes.append(node)
        new_joint_node_indices.append(node_offset + i)

    # Set up parent-child hierarchy
    root_joint_indices = []
    for i in range(J_orc):
        pi = orc_parent_indices[i]
        if pi >= 0:
            parent_node_idx = new_joint_node_indices[pi]
            gltf.nodes[parent_node_idx].children.append(new_joint_node_indices[i])
        else:
            root_joint_indices.append(new_joint_node_indices[i])

    if verbose:
        print(f"\n[swap] Created {J_orc} orc joint nodes (offset={node_offset}), "
              f"{len(root_joint_indices)} root(s)")

    # ==================================================================
    # 8. Compute inverseBindMatrices for orc joints
    # ==================================================================
    ibm_bytes = bytearray()
    for i in range(J_orc):
        world_mat = _translation_matrix(orc_heads_aligned[i])
        inv_mat = np.linalg.inv(world_mat).astype(np.float32)
        # Transpose to column-major for glTF
        col_major = inv_mat.T.flatten()
        ibm_bytes.extend(struct.pack(f"<{16}f", *col_major))

    # ==================================================================
    # 9. Prepare new JOINTS_0 bytes
    # ==================================================================
    # J_orc < 256 so uint8 is fine
    new_joints_bytes = new_joints.astype(np.uint8).tobytes()

    # WEIGHTS_0 stays the same values — just re-encode to be safe
    new_weights_bytes = weights_data.astype(np.float32).tobytes()

    # ==================================================================
    # 10. Append new binary data to the blob
    # ==================================================================
    if len(gltf.buffers) == 0:
        gltf.buffers.append(Buffer(byteLength=len(blob)))

    def _align_blob():
        pad = (4 - len(blob) % 4) % 4
        blob.extend(b"\x00" * pad)

    def add_accessor(data_bytes, component_type, type_str, count):
        _align_blob()
        offset = len(blob)
        blob.extend(data_bytes)
        bv = BufferView(buffer=0, byteOffset=offset, byteLength=len(data_bytes))
        bv_idx = len(gltf.bufferViews)
        gltf.bufferViews.append(bv)
        acc = Accessor(
            bufferView=bv_idx, byteOffset=0,
            componentType=component_type, count=count, type=type_str,
        )
        acc_idx = len(gltf.accessors)
        gltf.accessors.append(acc)
        return acc_idx

    ibm_acc_idx = add_accessor(ibm_bytes, COMPONENT_FLOAT, MAT4, J_orc)
    joints_acc_idx = add_accessor(new_joints_bytes, COMPONENT_UNSIGNED_BYTE, VEC4, N)
    weights_acc_idx = add_accessor(new_weights_bytes, COMPONENT_FLOAT, VEC4, N)

    gltf.buffers[0].byteLength = len(blob)

    if verbose:
        print(f"[swap] New accessors: IBM={ibm_acc_idx}, JOINTS_0={joints_acc_idx}, WEIGHTS_0={weights_acc_idx}")

    # ==================================================================
    # 11. Update the Skin object
    # ==================================================================
    new_skin = Skin(
        name="orc_m1_Armature",
        joints=new_joint_node_indices,
        inverseBindMatrices=ibm_acc_idx,
        skeleton=root_joint_indices[0] if root_joint_indices else new_joint_node_indices[0],
    )

    # Replace the existing skin
    gltf.skins[0] = new_skin

    # ==================================================================
    # 12. Update mesh primitives to use new JOINTS_0 / WEIGHTS_0
    # ==================================================================
    for mni in mesh_node_indices:
        mesh_node = gltf.nodes[mni]
        mesh_obj = gltf.meshes[mesh_node.mesh]
        for prim_item in mesh_obj.primitives:
            prim_item.attributes.JOINTS_0 = joints_acc_idx
            prim_item.attributes.WEIGHTS_0 = weights_acc_idx
        # Skin index stays 0

    # Add orc root joints to scene
    if gltf.scenes:
        scene = gltf.scenes[gltf.scene if gltf.scene is not None else 0]
        for rji in root_joint_indices:
            if rji not in scene.nodes:
                scene.nodes.append(rji)
    else:
        gltf.scenes = [Scene(nodes=list(root_joint_indices))]
        gltf.scene = 0

    # ==================================================================
    # 13. Save the output GLB
    # ==================================================================
    gltf.set_binary_blob(bytes(blob))
    os.makedirs(os.path.dirname(os.path.abspath(output_glb)), exist_ok=True)
    gltf.save(output_glb)

    if verbose:
        file_size = os.path.getsize(output_glb)
        print(f"\n[swap] Saved: {output_glb} ({file_size:,} bytes)")
        print(f"[swap] Summary: {N} verts, {J_old} UniRig joints -> {J_orc} orc joints")
        print(f"[swap] Bone mapping coverage:")

        # Count how many unique orc bones are actually used
        used_orc = set()
        for v in range(N):
            for k in range(4):
                if weights_data[v, k] > 0:
                    used_orc.add(int(new_joints[v, k]))
        print(f"       {len(used_orc)} / {J_orc} orc bones have non-zero vertex weights")
        print(f"       Used orc bones: {sorted([orc_names[i] for i in used_orc])}")

    return output_glb


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Swap UniRig skeleton with orc_m1 UE5 skeleton in a rigged GLB."
    )
    parser.add_argument("input_glb", help="Input UniRig-rigged GLB file")
    parser.add_argument("orc_bones_json", help="Orc bones JSON (e.g. orc_m1.bones.json)")
    parser.add_argument("output_glb", help="Output GLB with orc skeleton")
    parser.add_argument("-q", "--quiet", action="store_true", help="Suppress verbose output")

    args = parser.parse_args()

    swap_skeleton(args.input_glb, args.orc_bones_json, args.output_glb,
                  verbose=not args.quiet)
    print("Done.")
