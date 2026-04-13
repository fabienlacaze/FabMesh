"""Blender script: rename UniRig's generic bone_N names to UE5 Mannequin names.

Uses spatial analysis to identify which bone is which:
- Root (lowest ancestor) = pelvis
- Longest chain from root upward = spine → neck → head
- Two chains branching near top of spine = arms (left/right by X position)
- Two chains branching near bottom of spine = legs (left/right by X position)

Args (after --):
    rigged_glb: path to the UniRig-rigged GLB (input + output)
"""
import bpy
import os
import sys
from mathutils import Vector
from collections import defaultdict


def log(msg):
    print(f"RENAME_BONES: {msg}", flush=True)


def get_args():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = argv[1:]
    if len(argv) < 1:
        log("ERROR: usage: unirig_rename_bones.py <rigged_glb>")
        sys.exit(1)
    return os.path.abspath(argv[0])


def find_armature():
    for o in bpy.data.objects:
        if o.type == 'ARMATURE':
            return o
    return None


def bone_world_head(arm, bone):
    return arm.matrix_world @ bone.head_local


def bone_world_tail(arm, bone):
    return arm.matrix_world @ bone.tail_local


def build_children_map(arm):
    children = defaultdict(list)
    for b in arm.data.bones:
        if b.parent:
            children[b.parent.name].append(b.name)
    return children


def find_chain(children_map, start, bones_dict):
    """Follow the longest chain from start bone downward."""
    chain = [start]
    current = start
    while current in children_map and len(children_map[current]) > 0:
        # Pick the child that continues most "in line" (longest sub-chain)
        best = None
        best_depth = -1
        for child_name in children_map[current]:
            depth = _chain_depth(children_map, child_name)
            if depth > best_depth:
                best_depth = depth
                best = child_name
        if best is None:
            break
        chain.append(best)
        current = best
    return chain


def _chain_depth(children_map, name):
    if name not in children_map or len(children_map[name]) == 0:
        return 0
    return 1 + max(_chain_depth(children_map, c) for c in children_map[name])


def classify_bones(arm):
    """Analyze the UniRig skeleton topology and return a name mapping."""
    bones = arm.data.bones
    children_map = build_children_map(arm)

    # Find root bone (no parent)
    roots = [b.name for b in bones if b.parent is None]
    if not roots:
        log("ERROR: no root bone")
        return {}

    # The root with the most descendants is the main skeleton root
    root_name = max(roots, key=lambda r: _chain_depth(children_map, r))
    root_bone = bones[root_name]
    root_head = bone_world_head(arm, root_bone)
    log(f"root: {root_name} at {tuple(root_head)}")

    # Detect up axis (Y or Z) from mesh bbox
    all_heads = [bone_world_head(arm, b) for b in bones]
    bbox_min = Vector((min(h.x for h in all_heads), min(h.y for h in all_heads), min(h.z for h in all_heads)))
    bbox_max = Vector((max(h.x for h in all_heads), max(h.y for h in all_heads), max(h.z for h in all_heads)))
    bbox_size = bbox_max - bbox_min
    up_idx = 1 if bbox_size.y > bbox_size.z else 2  # Y-up or Z-up

    def get_up(v):
        return v[up_idx]

    def get_lr(v):
        return v.x  # X = left/right

    # Find the spine chain: from root, go UP (increasing up-axis)
    # The spine is the chain from root that goes highest
    spine_chain = find_chain(children_map, root_name, {b.name: b for b in bones})
    log(f"main chain from root: {len(spine_chain)} bones")

    # Split: find where arms branch off (near the top, 2 branches going sideways)
    # and where legs branch off (near the bottom, 2 branches going down)
    mapping = {}
    mapping[root_name] = "pelvis"

    # Identify spine segments along the chain
    # The spine goes from pelvis up to head
    # Arms branch from a bone near the top (clavicle area)
    # Legs branch from the root (or near it)

    # Find all branch points (bones with >1 child)
    branch_points = []
    for i, bname in enumerate(spine_chain):
        kids = children_map.get(bname, [])
        # Children NOT in the spine chain = branches
        side_kids = [k for k in kids if k not in spine_chain]
        if side_kids:
            branch_points.append((i, bname, side_kids))

    # Also check the ROOT for side branches (legs typically branch from root/pelvis)
    root_kids = children_map.get(root_name, [])
    root_side_kids = [k for k in root_kids if k not in spine_chain]
    if root_side_kids:
        branch_points.insert(0, (0, root_name, root_side_kids))

    # Classify branches by height
    upper_branches = []  # arms
    lower_branches = []  # legs

    mid_height = (get_up(bbox_min) + get_up(bbox_max)) / 2.0
    for idx, bname, side_kids in branch_points:
        bhead = bone_world_head(arm, bones[bname])
        height = get_up(bhead)
        for kid in side_kids:
            kid_head = bone_world_head(arm, bones[kid])
            # Classify by WHERE the branch starts:
            # - Arms branch from UPPER spine (height > 60% of bbox)
            # - Legs branch from LOWER spine/pelvis (height < 40% of bbox)
            # Check if this branch goes DOWN from its origin
            kid_chain = find_chain(children_map, kid, {b.name: b for b in bones})
            chain_end_head = bone_world_head(arm, bones[kid_chain[-1]]) if kid_chain else kid_head
            # Arms: branch starts high AND stays high or goes sideways
            # Legs: branch ends significantly lower than it starts
            drop = get_up(bhead) - get_up(chain_end_head)
            lateral = abs(get_lr(kid_head) - get_lr(bhead))
            relative_height = (get_up(bhead) - get_up(bbox_min)) / max(get_up(bbox_max) - get_up(bbox_min), 1e-6)
            # If the chain drops more than 30% of body height → leg
            body_height = get_up(bbox_max) - get_up(bbox_min)
            if drop > body_height * 0.25:
                lower_branches.append((kid, get_lr(kid_head)))
            elif relative_height > 0.5:
                upper_branches.append((kid, get_lr(kid_head)))
            else:
                lower_branches.append((kid, get_lr(kid_head)))

    # Sort left/right (positive X = left in Blender convention, but could vary)
    upper_branches.sort(key=lambda x: x[1])  # ascending X
    lower_branches.sort(key=lambda x: x[1])  # ascending X

    # Name the spine chain
    spine_ue5 = ["pelvis", "spine_01", "spine_02", "spine_03", "spine_04",
                 "spine_05", "neck_01", "neck_02", "head"]
    for i, bname in enumerate(spine_chain):
        if i < len(spine_ue5):
            mapping[bname] = spine_ue5[i]
        else:
            mapping[bname] = f"spine_extra_{i}"

    # Name arm chains
    arm_ue5 = ["clavicle", "upperarm", "lowerarm", "hand",
               "index_01", "index_02", "index_03"]
    if len(upper_branches) >= 2:
        # Right = more negative X, Left = more positive X (or vice versa)
        right_root = upper_branches[0][0]
        left_root = upper_branches[-1][0]

        right_chain = find_chain(children_map, right_root, {b.name: b for b in bones})
        left_chain = find_chain(children_map, left_root, {b.name: b for b in bones})

        for i, bname in enumerate(right_chain):
            if i < len(arm_ue5):
                mapping[bname] = f"{arm_ue5[i]}_r"
            else:
                mapping[bname] = f"finger_r_{i}"
        for i, bname in enumerate(left_chain):
            if i < len(arm_ue5):
                mapping[bname] = f"{arm_ue5[i]}_l"
            else:
                mapping[bname] = f"finger_l_{i}"

    # Name leg chains
    leg_ue5 = ["thigh", "calf", "foot", "ball", "toe"]
    if len(lower_branches) >= 2:
        right_root = lower_branches[0][0]
        left_root = lower_branches[-1][0]

        right_chain = find_chain(children_map, right_root, {b.name: b for b in bones})
        left_chain = find_chain(children_map, left_root, {b.name: b for b in bones})

        for i, bname in enumerate(right_chain):
            if i < len(leg_ue5):
                mapping[bname] = f"{leg_ue5[i]}_r"
            else:
                mapping[bname] = f"toe_r_{i}"
        for i, bname in enumerate(left_chain):
            if i < len(leg_ue5):
                mapping[bname] = f"{leg_ue5[i]}_l"
            else:
                mapping[bname] = f"toe_l_{i}"

    return mapping


def main():
    rigged_glb = get_args()
    log(f"input: {rigged_glb}")

    # Clear and import
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)

    bpy.ops.import_scene.gltf(filepath=rigged_glb)
    arm = find_armature()
    if arm is None:
        log("ERROR: no armature")
        sys.exit(1)
    log(f"armature: {arm.name} ({len(arm.data.bones)} bones)")

    # Classify and build rename map
    mapping = classify_bones(arm)
    log(f"classified {len(mapping)} bones")
    for old, new in sorted(mapping.items(), key=lambda x: x[1]):
        log(f"  {old} -> {new}")

    # Rename bones in EDIT mode + add missing UE5 IK/control bones
    bpy.ops.object.select_all(action='DESELECT')
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')

    renamed = 0
    for eb in arm.data.edit_bones:
        new_name = mapping.get(eb.name)
        if new_name and new_name != eb.name:
            eb.name = new_name
            renamed += 1

    # Add missing UE5 IK/control bones that the retargeter expects
    edit_bones = arm.data.edit_bones

    def _get_eb(name):
        return edit_bones.get(name)

    def _add_bone(name, head, tail, parent_name=None):
        if edit_bones.get(name):
            return  # already exists
        eb = edit_bones.new(name)
        eb.head = head
        eb.tail = tail
        eb.use_deform = False  # IK bones don't deform mesh
        if parent_name:
            p = _get_eb(parent_name)
            if p:
                eb.parent = p
        log(f"  added missing bone: {name}")

    # root bone at origin (parent of pelvis)
    pelvis = _get_eb('pelvis')
    if pelvis:
        origin = Vector((0, 0, 0))
        _add_bone('root', origin, origin + Vector((0, 0.01, 0)))
        root_eb = _get_eb('root')
        if root_eb:
            pelvis.parent = root_eb

    # hand_l / hand_r — if lowerarm exists but hand doesn't
    for side in ('_l', '_r'):
        lowerarm = _get_eb(f'lowerarm{side}')
        hand = _get_eb(f'hand{side}')
        if lowerarm and not hand:
            # Place hand at lowerarm tail
            h = lowerarm.tail.copy()
            t = h + (lowerarm.tail - lowerarm.head).normalized() * 0.05
            _add_bone(f'hand{side}', h, t, f'lowerarm{side}')

    # IK bones at origin (control bones, no deform)
    foot_l = _get_eb('foot_l')
    foot_r = _get_eb('foot_r')
    hand_l = _get_eb('hand_l')
    hand_r = _get_eb('hand_r')

    _add_bone('ik_foot_root', Vector((0, 0, 0)), Vector((0, 0.01, 0)), 'root')
    if foot_l:
        _add_bone('ik_foot_l', foot_l.head.copy(), foot_l.tail.copy(), 'ik_foot_root')
    if foot_r:
        _add_bone('ik_foot_r', foot_r.head.copy(), foot_r.tail.copy(), 'ik_foot_root')

    _add_bone('ik_hand_root', Vector((0, 0, 0)), Vector((0, 0.01, 0)), 'root')
    _add_bone('ik_hand_gun', Vector((0, 0, 0)), Vector((0, 0.01, 0)), 'ik_hand_root')
    if hand_l:
        _add_bone('ik_hand_l', hand_l.head.copy(), hand_l.tail.copy(), 'ik_hand_root')
    if hand_r:
        _add_bone('ik_hand_r', hand_r.head.copy(), hand_r.tail.copy(), 'ik_hand_root')

    bpy.ops.object.mode_set(mode='OBJECT')
    log(f"renamed {renamed} bones + added IK/control bones")

    # Also rename vertex groups on meshes to match
    for obj in bpy.data.objects:
        if obj.type == 'MESH':
            for vg in obj.vertex_groups:
                new_name = mapping.get(vg.name)
                if new_name:
                    vg.name = new_name

    # Export
    log(f"exporting to {rigged_glb}")
    bpy.ops.export_scene.gltf(
        filepath=rigged_glb,
        export_format='GLB',
        use_selection=False,
        export_apply=False,
        export_animations=True,
        export_skins=True,
        export_morph=False,
        export_yup=True,
    )
    log("done")


if __name__ == "__main__":
    main()
