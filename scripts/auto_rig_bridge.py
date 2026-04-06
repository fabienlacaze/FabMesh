"""
FabMesh Auto-Rigging Bridge

Generates a Blender script that:
1. Imports a mesh (GLB/FBX/OBJ)
2. Loads a skeleton template (JSON)
3. Auto-fits the skeleton to the mesh bounding box
4. Auto-skins via Blender Automatic Weights
5. Exports as FBX rigged (UE5-compatible)

Usage:
    python auto_rig_bridge.py <mesh_path> <template_name> <output_fbx> <blender_path>

Templates available:
    - ue5_mannequin   (humanoid biped, UE5 standard)
    - ue5_quadruped   (4-leg: wolf, dog, cat, horse)
    - ue5_hexapod     (6-leg: insect, beetle)
    - ue5_octopod     (8-leg: spider, crab)
"""
import sys
import os
import json
import subprocess
import tempfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
TEMPLATES_DIR = os.path.join(SCRIPT_DIR, "rig_templates")


def load_template(name):
    """Load a template - search in skm/<name>/, then root, then JSON fallback."""
    # 1) Try the SKM registry
    registry_path = os.path.join(TEMPLATES_DIR, "skm", "registry.json")
    if os.path.exists(registry_path):
        try:
            with open(registry_path, "r", encoding="utf-8") as f:
                reg = json.load(f)
            for t in reg.get("skm_templates", []):
                if t.get("id") == name:
                    fbx_path = os.path.join(TEMPLATES_DIR, t["fbx"])
                    if os.path.exists(fbx_path):
                        return {"type": "fbx", "path": fbx_path, "name": name, "registry": t}
            for t in reg.get("generic_templates", []):
                if t.get("id") == name:
                    json_path = os.path.join(TEMPLATES_DIR, t["json"])
                    if os.path.exists(json_path):
                        with open(json_path, "r", encoding="utf-8") as jf:
                            data = json.load(jf)
                        data["type"] = "json"
                        return data
        except Exception as e:
            print(f"AUTORIG: registry parse error: {e}", flush=True)

    # 2) Direct file lookup in TEMPLATES_DIR root
    for ext in (".fbx", ".FBX"):
        p = os.path.join(TEMPLATES_DIR, f"{name}{ext}")
        if os.path.exists(p):
            return {"type": "fbx", "path": p, "name": name}
    json_path = os.path.join(TEMPLATES_DIR, f"{name}.json")
    if os.path.exists(json_path):
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        data["type"] = "json"
        return data
    raise FileNotFoundError(f"Template not found: {name}")


def build_fbx_template_script(mesh_path, template_fbx_path, output_fbx, landmarks=None):
    """Generate Blender script that uses an existing FBX as rig template.

    Pipeline:
    1. Clear scene
    2. Import the new mesh, remember its objects in a set
    3. Import template FBX
    4. Anything in the scene that's NOT in the original set is template
    5. Find new_mesh + template_armature + template_meshes
    6. Compute bbox of new mesh and template mesh
    7. Scale/translate template armature so it matches new mesh
    8. Delete template meshes (keep only armature)
    9. Parent new mesh to armature with ARMATURE_AUTO
    10. Export selection
    """
    landmarks_json = json.dumps(landmarks) if landmarks else "None"
    return f'''
import bpy
import math
from mathutils import Vector

print("AUTORIG: ===== START =====", flush=True)

def vertex_bbox(mesh_obj):
    """Compute bbox from world-transformed vertices (more reliable than bound_box)."""
    bpy.context.view_layer.update()
    mw = mesh_obj.matrix_world
    verts = mesh_obj.data.vertices
    if len(verts) == 0:
        return Vector((0,0,0)), Vector((0,0,0))
    first = mw @ verts[0].co
    mn = Vector((first.x, first.y, first.z))
    mx = Vector((first.x, first.y, first.z))
    for v in verts:
        wv = mw @ v.co
        if wv.x < mn.x: mn.x = wv.x
        if wv.y < mn.y: mn.y = wv.y
        if wv.z < mn.z: mn.z = wv.z
        if wv.x > mx.x: mx.x = wv.x
        if wv.y > mx.y: mx.y = wv.y
        if wv.z > mx.z: mx.z = wv.z
    return mn, mx

# ===== Step 1: Clear scene =====
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)
print("AUTORIG: scene cleared", flush=True)

# ===== Step 2: Import the NEW mesh (to be rigged) =====
new_mesh_path = {json.dumps(mesh_path.replace(chr(92), "/"))}
ext = new_mesh_path.rsplit('.', 1)[-1].lower()
print(f"AUTORIG: Importing NEW mesh: {{new_mesh_path}}", flush=True)

if ext in ('glb', 'gltf'):
    bpy.ops.import_scene.gltf(filepath=new_mesh_path)
elif ext == 'fbx':
    bpy.ops.import_scene.fbx(filepath=new_mesh_path)
elif ext == 'obj':
    bpy.ops.wm.obj_import(filepath=new_mesh_path)
elif ext == 'stl':
    bpy.ops.import_mesh.stl(filepath=new_mesh_path)
else:
    raise ValueError(f"Unsupported format: {{ext}}")

# Snapshot of object names BEFORE template import
new_obj_names = set(o.name for o in bpy.context.scene.objects)
print(f"AUTORIG: after new mesh import, {{len(new_obj_names)}} objects: {{list(new_obj_names)}}", flush=True)

# Find and join all mesh objects from the new import
new_meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
if not new_meshes:
    raise RuntimeError("No mesh found in new import")

if len(new_meshes) > 1:
    bpy.ops.object.select_all(action='DESELECT')
    for o in new_meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = new_meshes[0]
    bpy.ops.object.join()

# Re-fetch mesh from scene by type filter (the previous reference may be stale)
new_meshes_after = [o for o in bpy.context.scene.objects if o.type == 'MESH']
if not new_meshes_after:
    raise RuntimeError("After join, no mesh found in scene")
new_mesh = new_meshes_after[0]
new_mesh.name = "FabMeshTarget"
print(f"AUTORIG: joined new mesh into '{{new_mesh.name}}' (data={{new_mesh.data is not None}}, verts={{len(new_mesh.data.vertices) if new_mesh.data else 0}})", flush=True)

# Force view layer update so derived data is current
bpy.context.view_layer.update()

# Apply transforms on new mesh
bpy.ops.object.select_all(action='DESELECT')
new_mesh.select_set(True)
bpy.context.view_layer.objects.active = new_mesh
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# Re-fetch again after transform_apply (defensive: bpy refs can become stale)
new_meshes_after2 = [o for o in bpy.context.scene.objects if o.type == 'MESH']
new_mesh = new_meshes_after2[0]

# Compute new mesh bbox from actual vertices (more reliable than bound_box)
nm_min, nm_max = vertex_bbox(new_mesh)
nm_size = nm_max - nm_min
nm_center = (nm_min + nm_max) / 2
print(f"AUTORIG: new mesh verts={{len(new_mesh.data.vertices)}} bbox size={{tuple(nm_size)}} center={{tuple(nm_center)}}", flush=True)

# Detect new mesh up axis
nm_up_idx = max(range(3), key=lambda i: nm_size[i])
print(f"AUTORIG: new mesh up axis = {{['X','Y','Z'][nm_up_idx]}}", flush=True)

# Update snapshot to include the joined object
existing_before_template = set(o.name for o in bpy.context.scene.objects)

# ===== Step 3: Import TEMPLATE FBX =====
template_path = {json.dumps(template_fbx_path.replace(chr(92), "/"))}
print(f"AUTORIG: Importing template FBX: {{template_path}}", flush=True)
bpy.ops.import_scene.fbx(filepath=template_path)

# New objects = template objects (set diff)
template_objs = [o for o in bpy.context.scene.objects if o.name not in existing_before_template]
template_armature = None
template_meshes = []
for o in template_objs:
    if o.type == 'ARMATURE':
        template_armature = o
    elif o.type == 'MESH':
        template_meshes.append(o)

print(f"AUTORIG: template objects: {{[(o.name, o.type) for o in template_objs]}}", flush=True)
if not template_armature:
    raise RuntimeError(f"Template FBX has no ARMATURE: {{template_path}}")
print(f"AUTORIG: armature='{{template_armature.name}}' bones={{len(template_armature.data.bones)}} meshes={{len(template_meshes)}}", flush=True)

# ===== Step 4: Apply transforms on the template (so scale 1, rotation 0) =====
bpy.ops.object.select_all(action='DESELECT')
template_armature.select_set(True)
for tm in template_meshes:
    tm.select_set(True)
bpy.context.view_layer.objects.active = template_armature
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# Compute template bbox from actual vertices
if template_meshes:
    t_min, t_max = vertex_bbox(template_meshes[0])
else:
    bb = []
    for b in template_armature.data.bones:
        bb.append(template_armature.matrix_world @ b.head_local)
        bb.append(template_armature.matrix_world @ b.tail_local)
    t_min = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
    t_max = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))

t_size = t_max - t_min
t_center = (t_min + t_max) / 2
t_up_idx = max(range(3), key=lambda i: t_size[i])
print(f"AUTORIG: template bbox size={{tuple(t_size)}} center={{tuple(t_center)}} up={{['X','Y','Z'][t_up_idx]}}", flush=True)

# ===== Step 5: Mixamo-style align (scale NEW MESH, not template) =====
# Distorting the template skeleton produces broken proportions for
# fantasy meshes. Instead we keep the template at its true UE5 size
# and scale + translate the new mesh to match.

# 5a: Rotate template if up axes differ
if t_up_idx != nm_up_idx:
    bpy.ops.object.select_all(action='DESELECT')
    template_armature.select_set(True)
    for tm in template_meshes:
        tm.select_set(True)
    bpy.context.view_layer.objects.active = template_armature
    if t_up_idx == 2 and nm_up_idx == 1:
        print("AUTORIG: rotate template -90deg X (Z-up -> Y-up)", flush=True)
        bpy.ops.transform.rotate(value=-math.pi/2, orient_axis='X')
    elif t_up_idx == 1 and nm_up_idx == 2:
        print("AUTORIG: rotate template +90deg X (Y-up -> Z-up)", flush=True)
        bpy.ops.transform.rotate(value=math.pi/2, orient_axis='X')
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    if template_meshes:
        t_min, t_max = vertex_bbox(template_meshes[0])
        t_size = t_max - t_min
        t_center = (t_min + t_max) / 2

# 5b: Scale the NEW MESH to match the template's height (along template up axis)
mesh_scale = t_size[t_up_idx] / max(nm_size[nm_up_idx], 0.0001)
print(f"AUTORIG: scaling NEW MESH by {{mesh_scale:.3f}} to match template height", flush=True)
bpy.ops.object.select_all(action='DESELECT')
new_mesh.select_set(True)
bpy.context.view_layer.objects.active = new_mesh
bpy.ops.transform.resize(value=(mesh_scale, mesh_scale, mesh_scale))
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

# Recompute new mesh bbox after scale
nm_min, nm_max = vertex_bbox(new_mesh)
nm_size = nm_max - nm_min
nm_center = (nm_min + nm_max) / 2
print(f"AUTORIG: new mesh after scale: size={{tuple(nm_size)}} center={{tuple(nm_center)}}", flush=True)

# 5c: Translate the NEW MESH so its bbox center matches the template's
offset = t_center - nm_center
print(f"AUTORIG: translating NEW MESH by {{tuple(offset)}}", flush=True)
new_mesh.location = new_mesh.location + offset
bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)

# ===== Step 8: Delete template meshes (keep only armature) =====
print(f"AUTORIG: deleting {{len(template_meshes)}} template mesh(es)", flush=True)
for tm in list(template_meshes):
    bpy.data.objects.remove(tm, do_unlink=True)
template_meshes = []

# ===== Step 8b: Position bones from user landmarks (or fallback A-pose) =====
LANDMARKS = {landmarks_json}
print(f"AUTORIG: landmarks provided: {{LANDMARKS is not None and len(LANDMARKS) > 0}}", flush=True)

import math as _m
from mathutils import Vector as _Vec

bpy.ops.object.select_all(action='DESELECT')
template_armature.select_set(True)
bpy.context.view_layer.objects.active = template_armature

# Bone name patterns (case-insensitive)
ARM_L_NAMES = ['upperarm_l', 'LeftArm', 'mixamorig:LeftArm', 'Left_Shoulder', 'shoulder_l']
ARM_R_NAMES = ['upperarm_r', 'RightArm', 'mixamorig:RightArm', 'Right_Shoulder', 'shoulder_r']
HAND_L_NAMES = ['hand_l', 'LeftHand', 'mixamorig:LeftHand', 'wrist_l']
HAND_R_NAMES = ['hand_r', 'RightHand', 'mixamorig:RightHand', 'wrist_r']
LEG_L_NAMES = ['thigh_l', 'LeftUpLeg', 'mixamorig:LeftUpLeg', 'leg_l', 'upperleg_l']
LEG_R_NAMES = ['thigh_r', 'RightUpLeg', 'mixamorig:RightUpLeg', 'leg_r', 'upperleg_r']
FOOT_L_NAMES = ['foot_l', 'LeftFoot', 'mixamorig:LeftFoot', 'ankle_l']
FOOT_R_NAMES = ['foot_r', 'RightFoot', 'mixamorig:RightFoot', 'ankle_r']
HEAD_NAMES = ['head', 'Head', 'mixamorig:Head']
HIPS_NAMES = ['pelvis', 'hips', 'Hips', 'mixamorig:Hips', 'root_pelvis']

def find_edit_bone(names):
    for n in names:
        target = n.lower()
        for b in template_armature.data.edit_bones:
            if b.name.lower() == target:
                return b
    return None

def collect_chain_edit(root):
    out = [root]
    def walk(b):
        for c in b.children:
            out.append(c)
            walk(c)
    walk(root)
    return out

def rotate_chain_to_target(root, target_pos):
    """Rotate the chain at the root bone so the chain end (root or last)
    points toward target_pos in world space.
    Uses the root bone's head as pivot.
    """
    if not root:
        return False
    pivot = root.head.copy()
    cur_dir = (root.tail - root.head)
    if cur_dir.length < 1e-6:
        return False
    cur_dir.normalize()
    tgt_dir = (target_pos - pivot)
    if tgt_dir.length < 1e-6:
        return False
    tgt_dir.normalize()
    # Rotation matrix that maps cur_dir -> tgt_dir
    axis = cur_dir.cross(tgt_dir)
    if axis.length < 1e-6:
        return True  # already aligned
    axis.normalize()
    angle = _m.acos(max(-1.0, min(1.0, cur_dir.dot(tgt_dir))))
    from mathutils import Matrix
    rot = Matrix.Rotation(angle, 4, axis)
    def transform(p):
        return rot @ (p - pivot) + pivot
    for b in collect_chain_edit(root):
        b.head = transform(b.head)
        b.tail = transform(b.tail)
    return True

if LANDMARKS:
    print("AUTORIG: positioning bones from landmarks...", flush=True)
    # Note: landmarks are in WORLD space relative to the NEW MESH (after we
    # scaled & translated it). So we use them directly.
    # For each available landmark, we rotate the corresponding bone chain
    # to point toward it.
    bpy.ops.object.mode_set(mode='EDIT')

    # Helper: target the chain root toward a far landmark by chaining
    def aim_chain_at(root_names, target_xyz):
        if not target_xyz:
            return False
        root = find_edit_bone(root_names)
        if not root:
            print(f"AUTORIG: bone not found for {{root_names[0]}}", flush=True)
            return False
        target = _Vec(target_xyz)
        ok = rotate_chain_to_target(root, target)
        print(f"AUTORIG: aimed {{root.name}} -> {{tuple(target)}} ok={{ok}}", flush=True)
        return ok

    # Arms: aim shoulder chain at the hand landmark
    if 'hand_l' in LANDMARKS:
        aim_chain_at(ARM_L_NAMES, LANDMARKS['hand_l'])
    if 'hand_r' in LANDMARKS:
        aim_chain_at(ARM_R_NAMES, LANDMARKS['hand_r'])
    # Legs: aim thigh chain at the foot landmark
    if 'foot_l' in LANDMARKS:
        aim_chain_at(LEG_L_NAMES, LANDMARKS['foot_l'])
    if 'foot_r' in LANDMARKS:
        aim_chain_at(LEG_R_NAMES, LANDMARKS['foot_r'])
    # Head: aim head bone toward the head landmark
    if 'head' in LANDMARKS:
        aim_chain_at(HEAD_NAMES, LANDMARKS['head'])

    bpy.ops.object.mode_set(mode='OBJECT')
    print("AUTORIG: bone positioning from landmarks done", flush=True)
else:
    # Fallback: hardcoded A-pose (35 deg arms down)
    print("AUTORIG: no landmarks, using hardcoded A-pose...", flush=True)
    bpy.ops.object.mode_set(mode='POSE')
    bpy.ops.pose.select_all(action='SELECT')
    bpy.ops.pose.transforms_clear()

    def find_pose_bone_ci(names):
        for n in names:
            target = n.lower()
            for b in template_armature.pose.bones:
                if b.name.lower() == target:
                    return b
        return None

    def rotate_pose_global(pb, axis, angle_deg):
        if not pb:
            return
        from mathutils import Matrix
        rot = Matrix.Rotation(_m.radians(angle_deg), 4, axis)
        pb.matrix = rot @ pb.matrix
        bpy.context.view_layer.update()

    arm_l = find_pose_bone_ci(ARM_L_NAMES)
    arm_r = find_pose_bone_ci(ARM_R_NAMES)
    A_DEG = 35
    if arm_l: rotate_pose_global(arm_l, 'Y', -A_DEG)
    if arm_r: rotate_pose_global(arm_r, 'Y', A_DEG)

    bpy.ops.pose.select_all(action='SELECT')
    try:
        bpy.ops.pose.armature_apply(selected=False)
    except Exception as e:
        print(f"AUTORIG: armature_apply failed: {{e}}", flush=True)
    bpy.ops.object.mode_set(mode='OBJECT')

print(f"AUTORIG: bone positioning done", flush=True)

# ===== Step 9: Parent new mesh to armature with auto weights =====
print("AUTORIG: parenting new mesh to armature (ARMATURE_AUTO)...", flush=True)
bpy.ops.object.select_all(action='DESELECT')
new_mesh.select_set(True)
template_armature.select_set(True)
bpy.context.view_layer.objects.active = template_armature
try:
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    print("AUTORIG: parent_set ARMATURE_AUTO succeeded", flush=True)
except Exception as e:
    print(f"AUTORIG: parent_set failed: {{e}}, trying ARMATURE_NAME", flush=True)
    bpy.ops.object.parent_set(type='ARMATURE_NAME')

# Verify the new mesh has an armature modifier
has_arm_mod = any(m.type == 'ARMATURE' for m in new_mesh.modifiers)
print(f"AUTORIG: new mesh has ARMATURE modifier: {{has_arm_mod}}", flush=True)

# ===== Step 10: Export =====
output_fbx = {json.dumps(output_fbx.replace(chr(92), "/"))}
print(f"AUTORIG: exporting to {{output_fbx}}", flush=True)
bpy.ops.object.select_all(action='DESELECT')
new_mesh.select_set(True)
template_armature.select_set(True)
bpy.context.view_layer.objects.active = template_armature

print(f"AUTORIG: selected for export: {{[o.name for o in bpy.context.selected_objects]}}", flush=True)

bpy.ops.export_scene.fbx(
    filepath=output_fbx,
    use_selection=True,
    object_types={{'MESH', 'ARMATURE'}},
    add_leaf_bones=False,
    bake_anim=False,
    mesh_smooth_type='FACE',
    use_mesh_modifiers=True,
    apply_unit_scale=True,
    apply_scale_options='FBX_SCALE_NONE',
    axis_forward='-Z',
    axis_up='Y',
    path_mode='COPY',
    embed_textures=True,
)

import os
sz = os.path.getsize(output_fbx) if os.path.exists(output_fbx) else 0
print(f"AUTORIG_SUCCESS: {{output_fbx}} ({{sz}} bytes)", flush=True)
'''


def build_blender_script(mesh_path, template, output_fbx):
    """Generate the Blender Python script that does the auto-rigging."""
    template_json = json.dumps(template)
    return f'''
import bpy
import json
import math

# ========== CLEAR SCENE ==========
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# Remove default cube/light/camera
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)

# ========== IMPORT MESH ==========
mesh_path = {json.dumps(mesh_path.replace(chr(92), "/"))}
ext = mesh_path.rsplit('.', 1)[-1].lower()
print(f"AUTORIG: Importing {{mesh_path}}", flush=True)

if ext in ('glb', 'gltf'):
    bpy.ops.import_scene.gltf(filepath=mesh_path)
elif ext == 'fbx':
    bpy.ops.import_scene.fbx(filepath=mesh_path)
elif ext == 'obj':
    bpy.ops.wm.obj_import(filepath=mesh_path)
elif ext == 'stl':
    bpy.ops.import_mesh.stl(filepath=mesh_path)
else:
    raise ValueError(f"Unsupported format: {{ext}}")

# Find all mesh objects
mesh_objects = [o for o in bpy.context.scene.objects if o.type == 'MESH']
if not mesh_objects:
    raise RuntimeError("No mesh found in imported file")

print(f"AUTORIG: {{len(mesh_objects)}} mesh object(s) imported", flush=True)

# Join all meshes if multiple
if len(mesh_objects) > 1:
    bpy.ops.object.select_all(action='DESELECT')
    for o in mesh_objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = mesh_objects[0]
    bpy.ops.object.join()
    mesh_obj = bpy.context.active_object
else:
    mesh_obj = mesh_objects[0]

# ========== APPLY TRANSFORMS + COMPUTE BBOX ==========
bpy.ops.object.select_all(action='DESELECT')
mesh_obj.select_set(True)
bpy.context.view_layer.objects.active = mesh_obj
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# World-space bounding box
bbox_corners = [mesh_obj.matrix_world @ v.co for v in mesh_obj.data.vertices]
if not bbox_corners:
    raise RuntimeError("Mesh has no vertices")

min_x = min(v.x for v in bbox_corners)
max_x = max(v.x for v in bbox_corners)
min_y = min(v.y for v in bbox_corners)
max_y = max(v.y for v in bbox_corners)
min_z = min(v.z for v in bbox_corners)
max_z = max(v.z for v in bbox_corners)

mesh_size = (max_x - min_x, max_y - min_y, max_z - min_z)
mesh_center = ((min_x + max_x) / 2, (min_y + max_y) / 2, (min_z + max_z) / 2)
print(f"AUTORIG: bbox size {{mesh_size}}, center {{mesh_center}}", flush=True)

# ========== LOAD TEMPLATE ==========
template = json.loads({json.dumps(template_json)})
print(f"AUTORIG: Loaded template '{{template['name']}}'", flush=True)

# Compute template's normalized bbox so we can map it to the mesh
all_pts = []
for b in template['bones']:
    all_pts.append(b['head'])
    all_pts.append(b['tail'])

t_min_x = min(p[0] for p in all_pts)
t_max_x = max(p[0] for p in all_pts)
t_min_y = min(p[1] for p in all_pts)
t_max_y = max(p[1] for p in all_pts)
t_min_z = min(p[2] for p in all_pts)
t_max_z = max(p[2] for p in all_pts)

t_size = (
    max(t_max_x - t_min_x, 0.001),
    max(t_max_y - t_min_y, 0.001),
    max(t_max_z - t_min_z, 0.001),
)
t_center = ((t_min_x + t_max_x) / 2, (t_min_y + t_max_y) / 2, (t_min_z + t_max_z) / 2)

# ========== MAP TEMPLATE TO MESH BBOX ==========
# Detect mesh up axis: tallest dimension
up_axis_idx = 0
max_dim = mesh_size[0]
for i in range(1, 3):
    if mesh_size[i] > max_dim:
        max_dim = mesh_size[i]
        up_axis_idx = i
print(f"AUTORIG: Mesh up axis index = {{up_axis_idx}} ({{['X','Y','Z'][up_axis_idx]}})", flush=True)

# For most generated meshes (TripoSR/Hunyuan3D), Y is up
# For our templates, ue5_mannequin uses Z up
# We map by uniform scale + bbox alignment

def map_point(p):
    """Map a template point (head/tail) to mesh space."""
    # Normalize to [0,1] in template space
    nx = (p[0] - t_min_x) / t_size[0]
    ny = (p[1] - t_min_y) / t_size[1]
    nz = (p[2] - t_min_z) / t_size[2]

    template_up = template.get('up_axis', 'Z').upper()

    # If template is Z-up but mesh is Y-up (Hunyuan3D), swap Y/Z
    if template_up == 'Z' and up_axis_idx == 1:  # mesh Y up
        # Template Z -> Mesh Y, Template Y -> -Mesh Z
        mx = min_x + nx * mesh_size[0]
        mz = max_y - nz * mesh_size[1]  # template Z (height) -> mesh Y
        my = min_z + ny * mesh_size[2]  # template Y (depth)  -> mesh Z
        return (mx, my, mz)
    else:
        # Direct mapping (assume mesh and template share up axis)
        mx = min_x + nx * mesh_size[0]
        my = min_y + ny * mesh_size[1]
        mz = min_z + nz * mesh_size[2]
        return (mx, my, mz)

# ========== CREATE ARMATURE ==========
print("AUTORIG: Creating armature...", flush=True)
bpy.ops.object.armature_add(enter_editmode=True, location=(0, 0, 0))
armature = bpy.context.active_object
armature.name = f"Armature_{{template['name']}}"
arm_data = armature.data

# Remove default bone
default_bone = arm_data.edit_bones[0]
arm_data.edit_bones.remove(default_bone)

# Create bones from template (mapped to mesh space)
created_bones = {{}}
for bone_def in template['bones']:
    head_world = map_point(bone_def['head'])
    tail_world = map_point(bone_def['tail'])

    eb = arm_data.edit_bones.new(bone_def['name'])
    eb.head = head_world
    eb.tail = tail_world
    created_bones[bone_def['name']] = eb

# Set parents
for bone_def in template['bones']:
    if bone_def.get('parent'):
        child = created_bones[bone_def['name']]
        parent = created_bones.get(bone_def['parent'])
        if parent:
            child.parent = parent
            child.use_connect = False

bpy.ops.object.mode_set(mode='OBJECT')
print(f"AUTORIG: Armature has {{len(arm_data.bones)}} bones", flush=True)

# ========== PARENT MESH TO ARMATURE WITH AUTO WEIGHTS ==========
print("AUTORIG: Parenting mesh with automatic weights...", flush=True)
bpy.ops.object.select_all(action='DESELECT')
mesh_obj.select_set(True)
armature.select_set(True)
bpy.context.view_layer.objects.active = armature
bpy.ops.object.parent_set(type='ARMATURE_AUTO')

# ========== EXPORT AS FBX ==========
output_fbx = {json.dumps(output_fbx.replace(chr(92), "/"))}
print(f"AUTORIG: Exporting to {{output_fbx}}", flush=True)

bpy.ops.object.select_all(action='DESELECT')
mesh_obj.select_set(True)
armature.select_set(True)
bpy.context.view_layer.objects.active = armature

bpy.ops.export_scene.fbx(
    filepath=output_fbx,
    use_selection=True,
    object_types={{'MESH', 'ARMATURE'}},
    add_leaf_bones=False,
    bake_anim=False,
    mesh_smooth_type='FACE',
    use_mesh_modifiers=True,
    apply_unit_scale=True,
    apply_scale_options='FBX_SCALE_NONE',
    axis_forward='-Z',
    axis_up='Y',
    path_mode='COPY',
    embed_textures=True,
)

print(f"AUTORIG_SUCCESS: {{output_fbx}}", flush=True)
'''


def main():
    if len(sys.argv) < 5:
        print("Usage: python auto_rig_bridge.py <mesh> <template> <output> <blender_exe> [landmarks.json]")
        sys.exit(1)

    mesh_path = sys.argv[1]
    template_name = sys.argv[2]
    output_fbx = sys.argv[3]
    blender_exe = sys.argv[4]
    landmarks_path = sys.argv[5] if len(sys.argv) > 5 else None
    landmarks = None
    if landmarks_path and os.path.exists(landmarks_path):
        try:
            with open(landmarks_path, "r", encoding="utf-8") as f:
                landmarks = json.load(f)
            print(f"AUTORIG: loaded {len(landmarks)} landmarks from {landmarks_path}", flush=True)
        except Exception as e:
            print(f"AUTORIG: landmarks load failed: {e}", flush=True)

    if not os.path.exists(mesh_path):
        print(f"AUTORIG_ERROR: Input mesh not found: {mesh_path}")
        sys.exit(1)
    if not os.path.exists(blender_exe):
        print(f"AUTORIG_ERROR: Blender not found: {blender_exe}")
        sys.exit(1)

    try:
        template = load_template(template_name)
    except Exception as e:
        print(f"AUTORIG_ERROR: {e}")
        sys.exit(1)

    print(f"AUTORIG: Building Blender script for template '{template_name}' (type={template.get('type')})", flush=True)
    if template.get("type") == "fbx":
        script_content = build_fbx_template_script(mesh_path, template["path"], output_fbx, landmarks)
    else:
        script_content = build_blender_script(mesh_path, template, output_fbx)

    # Write to a temp file for Blender to execute
    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".py", prefix="autorig_")
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            f.write(script_content)

        print(f"AUTORIG: Running Blender (background)...", flush=True)
        result = subprocess.run(
            [blender_exe, "--background", "--python", tmp_path],
            capture_output=True,
            text=True,
            timeout=300,
        )

        # Forward Blender output (broader filter to catch Python errors)
        keywords = ("AUTORIG", "Error", "ERROR", "Traceback", "  File ", "Exception", "raise ", "ValueError", "TypeError", "AttributeError", "RuntimeError")
        for line in result.stdout.splitlines():
            if any(k in line for k in keywords):
                print(line, flush=True)

        if result.returncode != 0:
            print(f"AUTORIG_ERROR: Blender exited with code {result.returncode}")
            print("=== STDERR (tail) ===")
            print(result.stderr[-2000:] if result.stderr else "(empty)")
            sys.exit(1)

        if not os.path.exists(output_fbx):
            print("AUTORIG_ERROR: Output FBX not created")
            print("=== STDOUT (tail) ===")
            print(result.stdout[-2000:] if result.stdout else "(empty)")
            print("=== STDERR (tail) ===")
            print(result.stderr[-2000:] if result.stderr else "(empty)")
            sys.exit(1)

        size = os.path.getsize(output_fbx)
        print(f"AUTORIG_SUCCESS: {output_fbx} ({size} bytes)", flush=True)
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


if __name__ == "__main__":
    main()
