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
                    # CC0 post-remediation: all SKM templates are JSON (bones data).
                    # Legacy FBX entries (if any leak back into the registry) still supported.
                    t_type = t.get("type", "json")
                    if t_type == "fbx" and t.get("fbx"):
                        fbx_path = os.path.join(TEMPLATES_DIR, t["fbx"])
                        if os.path.exists(fbx_path):
                            return {"type": "fbx", "path": fbx_path, "name": name, "registry": t}
                    # JSON SKM template (CC0 bone landmarks)
                    json_rel = t.get("json")
                    if json_rel:
                        json_path = os.path.join(TEMPLATES_DIR, json_rel)
                        if os.path.exists(json_path):
                            with open(json_path, "r", encoding="utf-8") as jf:
                                data = json.load(jf)
                            data["type"] = "json"
                            data["name"] = name
                            data["registry"] = t
                            return data
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


def build_fbx_template_script(mesh_path, template_fbx_path, output_fbx, landmarks=None, anim_dir=None):
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
    # Use repr() instead of json.dumps() so the resulting literal is valid
    # Python (true/false/null in JSON would crash when injected into the f-string).
    landmarks_json = repr(landmarks) if landmarks else "None"
    anim_dir_json = json.dumps(anim_dir.replace(chr(92), "/")) if anim_dir else "None"
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

# 5b: Uniform scale of the mesh to match the template's height. Hunyuan3D
# meshes are usually ~2m which matches the orc template (~1.92m), so this
# scale is typically very close to 1.0 — a small correction is still useful
# for non-standard meshes.
mesh_scale = t_size[t_up_idx] / max(nm_size[nm_up_idx], 0.0001)
print(f"AUTORIG: scaling mesh by {{mesh_scale:.3f}} to match template height", flush=True)
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

# 5c: Translate the NEW MESH so its FOOT line + central plane match the
# template's. We align by 3 anchors instead of bbox center because bbox
# center includes empty space between extended limbs (orc T-pose) and is
# not anatomically meaningful.
#   - Floor: nm_min[up] → t_min[up]   (feet on the same ground level)
#   - Lateral midline: nm_center[lat] → t_center[lat] (centered side-to-side)
#   - Depth: nm_center[dep] → t_center[dep] (front/back center)
# We compute the offset component-wise rather than (t_center - nm_center)
# so the floor anchor uses min instead of center.
floor_offset = t_min[t_up_idx] - nm_min[nm_up_idx] if t_up_idx == nm_up_idx else 0.0
offset = t_center - nm_center
# Override the up component with a floor-based offset (so feet land on ground)
if t_up_idx == 0: offset.x = floor_offset
elif t_up_idx == 1: offset.y = floor_offset
elif t_up_idx == 2: offset.z = floor_offset
print(f"AUTORIG: translating mesh by {{tuple(offset)}} (floor-aligned)", flush=True)
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
LOWER_ARM_L_NAMES = ['lowerarm_l', 'LeftForeArm', 'mixamorig:LeftForeArm', 'forearm_l', 'elbow_l']
LOWER_ARM_R_NAMES = ['lowerarm_r', 'RightForeArm', 'mixamorig:RightForeArm', 'forearm_r', 'elbow_r']
HAND_L_NAMES = ['hand_l', 'LeftHand', 'mixamorig:LeftHand', 'wrist_l']
HAND_R_NAMES = ['hand_r', 'RightHand', 'mixamorig:RightHand', 'wrist_r']
LEG_L_NAMES = ['thigh_l', 'LeftUpLeg', 'mixamorig:LeftUpLeg', 'leg_l', 'upperleg_l']
LEG_R_NAMES = ['thigh_r', 'RightUpLeg', 'mixamorig:RightUpLeg', 'leg_r', 'upperleg_r']
CALF_L_NAMES = ['calf_l', 'LeftLeg', 'mixamorig:LeftLeg', 'shin_l', 'lowerleg_l', 'knee_l']
CALF_R_NAMES = ['calf_r', 'RightLeg', 'mixamorig:RightLeg', 'shin_r', 'lowerleg_r', 'knee_r']
FOOT_L_NAMES = ['foot_l', 'LeftFoot', 'mixamorig:LeftFoot', 'ankle_l']
FOOT_R_NAMES = ['foot_r', 'RightFoot', 'mixamorig:RightFoot', 'ankle_r']
HEAD_NAMES = ['head', 'Head', 'mixamorig:Head']
NECK_NAMES = ['neck', 'neck_01', 'Neck', 'mixamorig:Neck']
HIPS_NAMES = ['pelvis', 'hips', 'Hips', 'mixamorig:Hips', 'root_pelvis']
# Finger root bones (we aim the finger chain at the fingertip landmark)
THUMB_L_NAMES = ['thumb_01_l', 'thumb_l', 'LeftHandThumb1', 'mixamorig:LeftHandThumb1']
THUMB_R_NAMES = ['thumb_01_r', 'thumb_r', 'RightHandThumb1', 'mixamorig:RightHandThumb1']
INDEX_L_NAMES = ['index_01_l', 'index_l', 'LeftHandIndex1', 'mixamorig:LeftHandIndex1']
INDEX_R_NAMES = ['index_01_r', 'index_r', 'RightHandIndex1', 'mixamorig:RightHandIndex1']

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
    # Landmarks may arrive in two formats:
    #  1) Normalized 0..1 coordinates inside the original mesh bbox (preferred,
    #     marked by the "__normalized__" flag from the renderer). We re-map
    #     them to world space using the CURRENT mesh bbox (post step-5 scale
    #     and translate), which is the same space the template bones live in.
    #  2) Raw world-space coordinates (legacy). We try to use them directly.
    _is_normalized = bool(LANDMARKS.get("__normalized__"))
    _LANDMARKS_RAW = LANDMARKS
    LANDMARKS = {{}}
    if _is_normalized:
        # Re-derive the new mesh bbox after the step-5 scale + translate
        nm_min2, nm_max2 = vertex_bbox(new_mesh)
        nm_size2 = nm_max2 - nm_min2
        # The renderer computed the normalized landmarks against the THREE.js
        # bbox of the model. THREE.js loads the GLB exactly the same way
        # Blender's gltf importer does (same axis convention), so the
        # normalized x/y/z components map 1-to-1 onto Blender's bbox axes.
        # No swap, no flip — anything we add here will only mis-align them.
        for _lid, _lpos in _LANDMARKS_RAW.items():
            if _lid == "__normalized__":
                continue
            if not isinstance(_lpos, (list, tuple)) or len(_lpos) != 3:
                continue
            # THREE.js is Y-up, Blender is Z-up. The renderer stored
            # (three.x, three.y, three.z) = (right, up, forward). We need
            # (blender.x, blender.y, blender.z) = (right, -forward, up).
            lx, ly, lz = _lpos[0], _lpos[1], _lpos[2]
            # Map: blender.x = three.x, blender.z = three.y (both "up"),
            # blender.y = 1 - three.z (front becomes -Y in Blender).
            bx = lx
            bz = ly
            by = 1.0 - lz
            _v = _Vec((
                nm_min2.x + bx * nm_size2.x,
                nm_min2.y + by * nm_size2.y,
                nm_min2.z + bz * nm_size2.z,
            ))
            LANDMARKS[_lid] = (_v.x, _v.y, _v.z)
        print(f"AUTORIG: remapped {{len(LANDMARKS)}} normalized landmarks (Y/Z swap) to mesh bbox {{tuple(nm_min2)}}..{{tuple(nm_max2)}}", flush=True)
        # Dump key landmarks so we can verify they're inside the mesh
        for _k in ('head', 'neck', 'hips', 'shoulder_l', 'shoulder_r', 'hand_l', 'hand_r', 'knee_l', 'foot_l'):
            _p = LANDMARKS.get(_k)
            if _p is not None:
                print(f"AUTORIG: LM {{_k}} = ({{_p[0]:.3f}}, {{_p[1]:.3f}}, {{_p[2]:.3f}})", flush=True)
        # Also dump raw normalized values for the same landmarks
        for _k in ('head', 'neck', 'hips', 'shoulder_l', 'shoulder_r', 'hand_l', 'hand_r', 'knee_l', 'foot_l'):
            _p = _LANDMARKS_RAW.get(_k)
            if _p is not None:
                print(f"AUTORIG: LM RAW {{_k}} = ({{_p[0]:.3f}}, {{_p[1]:.3f}}, {{_p[2]:.3f}})", flush=True)
    else:
        # Legacy raw world-space — apply the step-5 scale+offset
        for _lid, _lpos in _LANDMARKS_RAW.items():
            if _lid == "__normalized__":
                continue
            if not isinstance(_lpos, (list, tuple)) or len(_lpos) != 3:
                continue
            _v = _Vec((_lpos[0], _lpos[1], _lpos[2]))
            _v = _v * mesh_scale + offset
            LANDMARKS[_lid] = (_v.x, _v.y, _v.z)
        print(f"AUTORIG: legacy raw landmarks remapped via scale={{mesh_scale:.3f}}", flush=True)
    # ========== Snap key bones to landmark positions (EDIT mode) ==========
    # Instead of rotating chains (which cumulates badly with twist children),
    # we directly set head/tail of each "key" bone to the corresponding
    # landmark world position. Children bones (twist01/02, share, fingers)
    # are NOT touched — they keep their offset relative to the parent so the
    # local hierarchy stays valid.
    #
    # IMPORTANT: bake the template armature's object-level transform into the
    # bones first. The orc_m1 FBX is imported with object_scale=0.01 (cm→m
    # convention), so b.head_local is in centimeters. transform_apply with
    # scale flips that into meters and aligns the bone coordinates with the
    # mesh+landmark world space. Without this, only the bones we explicitly
    # snap end up in the right space — the 100+ untouched bones stay 100x
    # too far away in EDIT space and the helper visualization explodes.
    bpy.ops.object.select_all(action='DESELECT')
    template_armature.select_set(True)
    bpy.context.view_layer.objects.active = template_armature

    # ========== BLOCK A — POSE aim (no armature_apply) ==========
    # Pose the skeleton in POSE mode to match the mesh's current shape, so
    # that when we parent_set the mesh to the armature, weights are computed
    # against THIS posed state (bind pose). We then clear the pose, which
    # makes the mesh deform back to the untouched T-pose rest. Result:
    # rest pose = orc T-pose (UE5-compatible, anims work), bind shape =
    # mesh's natural shape (weights are correct).
    from mathutils import Matrix as _Mat
    arm_mat_inv = template_armature.matrix_world.inverted()

    def _lm_arm(lid):
        p = LANDMARKS.get(lid)
        if p is None:
            return None
        return arm_mat_inv @ _Vec((p[0], p[1], p[2]))

    AIM_BONES = [
        ('pelvis',     'spine_top'),
        ('spine_03',   'neck'),
        ('neck_01',    'head'),
        ('clavicle_l', 'shoulder_l'),
        ('clavicle_r', 'shoulder_r'),
        ('upperarm_l', 'elbow_l'),
        ('upperarm_r', 'elbow_r'),
        ('lowerarm_l', 'hand_l'),
        ('lowerarm_r', 'hand_r'),
        ('thigh_l',    'knee_l'),
        ('thigh_r',    'knee_r'),
        ('calf_l',     'ankle_l'),
        ('calf_r',     'ankle_r'),
        ('foot_l',     'foot_l'),
        ('foot_r',     'foot_r'),
    ]

    # EDIT mode: directly snap each listed bone's head and tail to its
    # corresponding landmarks. NO propagation, NO rotation math — just
    # write the positions. The manual-skinning step afterwards recomputes
    # weights from the new bone positions, so twist/share/finger bones
    # that got disconnected from their parent don't affect the result.
    bpy.ops.object.mode_set(mode='EDIT')
    _eb_map = {{b.name.lower(): b for b in template_armature.data.edit_bones}}
    def _eb(n):
        return _eb_map.get(n.lower())

    # (bone_name, head_landmark, tail_landmark)
    SNAP = [
        ('pelvis',     'hips',       'spine_top'),
        ('spine_01',   'hips',       'spine_mid'),
        ('spine_02',   'spine_mid',  'spine_top'),
        ('spine_03',   'spine_top',  'neck'),
        ('neck_01',    'neck',       'head'),
        ('head',       'head',       None),
        ('clavicle_l', 'spine_top',  'shoulder_l'),
        ('clavicle_r', 'spine_top',  'shoulder_r'),
        ('upperarm_l', 'shoulder_l', 'elbow_l'),
        ('upperarm_r', 'shoulder_r', 'elbow_r'),
        ('lowerarm_l', 'elbow_l',    'hand_l'),
        ('lowerarm_r', 'elbow_r',    'hand_r'),
        ('hand_l',     'hand_l',     None),
        ('hand_r',     'hand_r',     None),
        ('thigh_l',    'hip_l',      'knee_l'),
        ('thigh_r',    'hip_r',      'knee_r'),
        ('calf_l',     'knee_l',     'ankle_l'),
        ('calf_r',     'knee_r',     'ankle_r'),
        ('foot_l',     'ankle_l',    'foot_l'),
        ('foot_r',     'ankle_r',    'foot_r'),
    ]

    _snapped = 0
    for _bname, _hlm, _tlm in SNAP:
        eb = _eb(_bname)
        if eb is None:
            continue
        new_head = _lm_arm(_hlm) if _hlm else None
        new_tail = _lm_arm(_tlm) if _tlm else None
        if new_head is None and new_tail is None:
            continue
        if new_head is not None:
            eb.head = new_head
        if new_tail is None:
            # Keep tail offset from head (use the old direction+length)
            old_vec = (eb.tail - eb.head)
            if old_vec.length > 1e-6:
                eb.tail = eb.head + old_vec
            continue
        if new_head is None:
            # Keep head, just move tail
            eb.tail = new_tail
            continue
        # Both defined: check the resulting bone isn't degenerate
        if (new_tail - new_head).length < 1e-5:
            continue
        eb.tail = new_tail
        _snapped += 1

    print(f"AUTORIG: EDIT-mode direct snap applied to {{_snapped}}/{{len(SNAP)}} bones", flush=True)
    bpy.ops.object.mode_set(mode='OBJECT')
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
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.select_all(action='DESELECT')
new_mesh.select_set(True)
template_armature.select_set(True)
bpy.context.view_layer.objects.active = template_armature
bpy.context.view_layer.update()
# Flush the depsgraph fully before parent_set so ARMATURE_AUTO's bone
# heat solver has valid rest position data.
bpy.context.evaluated_depsgraph_get().update()

# Known Blender headless bug: ARMATURE_AUTO sometimes creates empty vertex
# groups because the operator needs an active 3D viewport context. Use
# temp_override to provide the missing context.
_area = next((a for a in bpy.context.screen.areas if a.type == 'VIEW_3D'), None) if bpy.context.screen else None
if _area is None:
    # Headless: no 3D view — create a minimal override dict and use temp_override
    print("AUTORIG: no VIEW_3D area, using plain context for parent_set", flush=True)
    try:
        bpy.ops.object.parent_set(type='ARMATURE_AUTO')
        print("AUTORIG: parent_set ARMATURE_AUTO (plain) succeeded", flush=True)
    except Exception as e:
        print(f"AUTORIG: parent_set (plain) failed: {{e}}", flush=True)
else:
    _region = next((r for r in _area.regions if r.type == 'WINDOW'), None)
    with bpy.context.temp_override(area=_area, region=_region, active_object=template_armature, selected_objects=[new_mesh, template_armature], selected_editable_objects=[new_mesh, template_armature]):
        try:
            bpy.ops.object.parent_set(type='ARMATURE_AUTO')
            print("AUTORIG: parent_set ARMATURE_AUTO (override) succeeded", flush=True)
        except Exception as e:
            print(f"AUTORIG: parent_set (override) failed: {{e}}", flush=True)

# Verify weights actually computed — count verts with non-zero weight
_check_weighted = 0
for _v in new_mesh.data.vertices[:200]:
    if any(g.weight > 0 for g in _v.groups):
        _check_weighted += 1
print(f"AUTORIG: post-parent weighted verts in first 200 = {{_check_weighted}}", flush=True)

_deform_count = sum(1 for b in template_armature.data.bones if b.use_deform)
_nondef = sum(1 for b in template_armature.data.bones if not b.use_deform)
print(f"AUTORIG: template bones deform={{_deform_count}} non-deform={{_nondef}}", flush=True)
if _check_weighted == 0:
    print("AUTORIG: ARMATURE_AUTO produced ZERO weights — falling back to manual rigid closest-bone skinning", flush=True)
    # Clear existing empty groups
    while new_mesh.vertex_groups:
        new_mesh.vertex_groups.remove(new_mesh.vertex_groups[0])
    # For each deform bone, create a vertex group
    _deform_bones = [b for b in template_armature.data.bones if b.use_deform]
    print(f"AUTORIG: manual skinning — {{len(_deform_bones)}} deform bones", flush=True)
    # Log armature/mesh bboxes for sanity
    _amw = template_armature.matrix_world
    _bmn = Vector((1e9,1e9,1e9)); _bmx = Vector((-1e9,-1e9,-1e9))
    for _b in _deform_bones:
        for _p in (_amw @ _b.head_local, _amw @ _b.tail_local):
            for _i in range(3):
                if _p[_i] < _bmn[_i]: _bmn[_i] = _p[_i]
                if _p[_i] > _bmx[_i]: _bmx[_i] = _p[_i]
    _mmn, _mmx = vertex_bbox(new_mesh)
    print(f"AUTORIG: DIAG arm bones world bbox {{tuple(_bmn)}}..{{tuple(_bmx)}}", flush=True)
    print(f"AUTORIG: DIAG mesh world bbox {{tuple(_mmn)}}..{{tuple(_mmx)}}", flush=True)
    _vg_map = {{}}
    for _b in _deform_bones:
        _vg_map[_b.name] = new_mesh.vertex_groups.new(name=_b.name)
    # Precompute bone head/tail in world space
    _arm_mw = template_armature.matrix_world
    _bone_segments = []
    for _b in _deform_bones:
        _h = _arm_mw @ _b.head_local
        _t = _arm_mw @ _b.tail_local
        _bone_segments.append((_b.name, _h, _t))
    # For each vertex, find closest bone segment and assign weight 1.0
    _mw = new_mesh.matrix_world
    def _dist_to_segment(p, a, b):
        ab = b - a
        ap = p - a
        L2 = ab.dot(ab)
        if L2 < 1e-12:
            return ap.length
        tt = max(0.0, min(1.0, ap.dot(ab) / L2))
        proj = a + ab * tt
        return (p - proj).length
    # Smooth skinning: for each vertex, compute inverse-distance weights to
    # the 4 nearest bone segments and normalize.
    _K = 4
    _EPS = 1e-4
    for _vi, _v in enumerate(new_mesh.data.vertices):
        _wp = _mw @ _v.co
        _dists = []
        for _name, _h, _t in _bone_segments:
            _d = _dist_to_segment(_wp, _h, _t)
            _dists.append((_d, _name))
        _dists.sort(key=lambda x: x[0])
        _top = _dists[:_K]
        # Inverse square distance weighting
        _inv = [(1.0 / max(_d * _d, _EPS), _n) for _d, _n in _top]
        _sum = sum(w for w, _ in _inv)
        if _sum < 1e-12:
            continue
        for _w, _name in _inv:
            _vg_map[_name].add([_vi], _w / _sum, 'REPLACE')
    # Ensure armature modifier exists
    if not any(m.type == 'ARMATURE' for m in new_mesh.modifiers):
        _mod = new_mesh.modifiers.new(name='Armature', type='ARMATURE')
        _mod.object = template_armature
    # Ensure parent (reset matrix_parent_inverse to identity so we don't
    # double-transform the mesh)
    new_mesh.parent = template_armature
    new_mesh.matrix_parent_inverse.identity()
    new_mesh.matrix_world = new_mesh.matrix_world  # force update
    _check2 = 0
    for _v in new_mesh.data.vertices[:200]:
        if any(g.weight > 0 for g in _v.groups):
            _check2 += 1
    print(f"AUTORIG: after manual skinning, weighted verts in first 200 = {{_check2}}", flush=True)

has_arm_mod = any(m.type == 'ARMATURE' for m in new_mesh.modifiers)
print(f"AUTORIG: new mesh has ARMATURE modifier: {{has_arm_mod}}", flush=True)


# ========== BLOCK C — Retarget animations to the new rest pose ==========
# For each anim FBX in anim_dir, import it (brings in a source armature with
# the ORIGINAL orc T-pose rest + its baked action), add a Copy Rotation
# constraint (LOCAL space) on every matching bone of template_armature
# targeting the source, then NLA-bake with visual_keying=True. Blender's
# depsgraph resolves the full chain so the baked keys represent the exact
# same visual motion on the new rest pose. Finally push the baked action
# onto template_armature as an NLA strip so the FBX export picks it up.
import os as _os_blockc
ANIM_DIR = {anim_dir_json}
if ANIM_DIR and _os_blockc.path.isdir(ANIM_DIR):
    import glob as _glob
    # Case-insensitive dedupe (Windows glob matches both *.FBX and *.fbx for the same file)
    _seen = set()
    anim_files = []
    for _p in sorted(_glob.glob(_os_blockc.path.join(ANIM_DIR, "*.FBX")) + _glob.glob(_os_blockc.path.join(ANIM_DIR, "*.fbx"))):
        _key = _p.lower()
        if _key in _seen:
            continue
        _seen.add(_key)
        anim_files.append(_p)
    print(f"AUTORIG: Block C found {{len(anim_files)}} anim FBX to retarget", flush=True)
    target_bone_names = set(b.name for b in template_armature.data.bones)

    for anim_fbx in anim_files:
        anim_name = _os_blockc.path.splitext(_os_blockc.path.basename(anim_fbx))[0]
        # Strip common prefixes (AS_XXX_Y1_) to get a clean clip name
        clean = anim_name
        for pfx in ("AS_XXX_Y1_", "AS_XXX_", "AS_"):
            if clean.startswith(pfx):
                clean = clean[len(pfx):]
                break
        print(f"AUTORIG: Block C importing {{anim_name}} -> '{{clean}}'", flush=True)
        pre_objs = set(o.name for o in bpy.data.objects)
        try:
            bpy.ops.import_scene.fbx(filepath=anim_fbx, use_anim=True, automatic_bone_orientation=False)
        except Exception as _e:
            print(f"AUTORIG: Block C import failed for {{anim_name}}: {{_e}}", flush=True)
            continue
        new_objs = [o for o in bpy.data.objects if o.name not in pre_objs]
        src_arm = next((o for o in new_objs if o.type == 'ARMATURE'), None)
        if src_arm is None:
            print(f"AUTORIG: Block C no armature in {{anim_name}}", flush=True)
            for o in new_objs:
                bpy.data.objects.remove(o, do_unlink=True)
            continue
        src_action = None
        if src_arm.animation_data and src_arm.animation_data.action:
            src_action = src_arm.animation_data.action

        # Add Copy Rotation (LOCAL) constraint on every matching bone
        bpy.ops.object.select_all(action='DESELECT')
        template_armature.select_set(True)
        bpy.context.view_layer.objects.active = template_armature
        bpy.ops.object.mode_set(mode='POSE')
        added = 0
        for pb in template_armature.pose.bones:
            src_bone = src_arm.pose.bones.get(pb.name)
            if src_bone is None:
                continue
            # Remove any leftover constraint with our tag
            for _c in list(pb.constraints):
                if _c.name == "FabRetargetCR":
                    pb.constraints.remove(_c)
            c = pb.constraints.new('COPY_ROTATION')
            c.name = "FabRetargetCR"
            c.target = src_arm
            c.subtarget = pb.name
            # POSE space copies the visual rotation (including rest pose
            # contribution), which is what we want for retargeting between
            # two skeletons with different rest poses. LOCAL would copy the
            # raw local rotation which is only valid if both rigs share the
            # exact same rest pose.
            c.target_space = 'POSE'
            c.owner_space = 'POSE'
            added += 1
        print(f"AUTORIG: Block C added {{added}} Copy Rotation constraints", flush=True)

        # Determine frame range from source action
        f_start = int(bpy.context.scene.frame_start)
        f_end = int(bpy.context.scene.frame_end)
        if src_action:
            try:
                f_start = int(src_action.frame_range[0])
                f_end = int(src_action.frame_range[1])
            except (AttributeError, TypeError):
                # Blender 4.4+: derive from frame_end on scene or leave defaults
                pass
        bpy.context.scene.frame_start = f_start
        bpy.context.scene.frame_end = f_end

        # Make sure template_armature has no active action that would block bake
        if template_armature.animation_data and template_armature.animation_data.action:
            template_armature.animation_data.action = None

        bpy.ops.pose.select_all(action='SELECT')
        try:
            bpy.ops.nla.bake(
                frame_start=f_start,
                frame_end=f_end,
                only_selected=False,
                visual_keying=True,
                clear_constraints=True,
                clear_parents=False,
                use_current_action=False,
                bake_types={{'POSE'}},
            )
            print(f"AUTORIG: Block C baked {{clean}} ({{f_start}}..{{f_end}})", flush=True)
        except Exception as _e:
            print(f"AUTORIG: Block C bake failed for {{anim_name}}: {{_e}}", flush=True)
            # Clean up constraints if bake failed
            for pb in template_armature.pose.bones:
                for _c in list(pb.constraints):
                    if _c.name == "FabRetargetCR":
                        pb.constraints.remove(_c)

        # Grab the resulting action, rename it, push to NLA, clear active
        bpy.ops.object.mode_set(mode='OBJECT')
        if template_armature.animation_data and template_armature.animation_data.action:
            baked_act = template_armature.animation_data.action
            baked_act.name = clean
            # Sanity: count fcurves (Blender 4.4+ moved fcurves under layers)
            try:
                nfc = len(baked_act.fcurves)
            except AttributeError:
                nfc = 0
                try:
                    for _layer in baked_act.layers:
                        for _strip in _layer.strips:
                            for _cb in _strip.channelbags:
                                nfc += len(_cb.fcurves)
                except Exception:
                    pass
            print(f"AUTORIG: Block C baked action '{{clean}}' has {{nfc}} fcurves", flush=True)
            # Push to NLA
            try:
                track = template_armature.animation_data.nla_tracks.new()
                track.name = clean
                track.strips.new(clean, f_start, baked_act)
            except Exception as _e:
                print(f"AUTORIG: Block C NLA push failed: {{_e}}", flush=True)
            template_armature.animation_data.action = None
        else:
            print(f"AUTORIG: Block C WARNING no action produced for {{anim_name}}", flush=True)

        # Clean up imported source objects
        for o in list(new_objs):
            try:
                bpy.data.objects.remove(o, do_unlink=True)
            except Exception:
                pass
    print("AUTORIG: Block C done", flush=True)
else:
    print("AUTORIG: Block C skipped (no anim_dir)", flush=True)

# ===== Step 10: Persist textures so embed_textures can pick them up =====
# GLB import stores textures as in-memory bpy.data.images with no filepath.
# Blender's FBX exporter silently drops images that lack a real file on disk
# even when embed_textures=True, so we save every image to a temp folder and
# assign its filepath BEFORE the export call.
import os, tempfile
_tex_tmp = os.path.join(tempfile.gettempdir(), "fabmesh_autorig_tex_" + str(os.getpid()))
os.makedirs(_tex_tmp, exist_ok=True)
_saved_tex = 0
for _img in list(bpy.data.images):
    if _img is None or _img.type != 'IMAGE':
        continue
    if _img.size[0] == 0 or _img.size[1] == 0:
        try: _img.reload()
        except Exception: pass
        if _img.size[0] == 0 or _img.size[1] == 0:
            continue
    _safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in (_img.name or "tex"))
    if not _safe.lower().endswith(('.png', '.jpg', '.jpeg', '.tga', '.bmp')):
        _safe += ".png"
    _target = os.path.join(_tex_tmp, _safe)
    try:
        _img.filepath_raw = _target
        _img.file_format = 'PNG'
        _img.save()
        try: _img.pack()
        except Exception: pass
        _saved_tex += 1
    except Exception as _e:
        print(f"AUTORIG: failed to save image '{{_img.name}}': {{_e}}", flush=True)
print(f"AUTORIG: persisted {{_saved_tex}} texture(s) for FBX embed", flush=True)
try:
    bpy.ops.file.pack_all()
except Exception as _e:
    print(f"AUTORIG: pack_all failed: {{_e}}", flush=True)

# ===== Step 11: Cleanup orphan objects and junk actions =====
# Block C imports anim FBX files which leave behind orphan armatures and
# actions (e.g. 'root.001|Unreal Take|Base Layer'). Delete everything that's
# not our mesh or our armature.
_keep = {{new_mesh.name, template_armature.name}}
for _o in list(bpy.data.objects):
    if _o.name not in _keep:
        try: bpy.data.objects.remove(_o, do_unlink=True)
        except Exception: pass
# Keep only the 3 clean action names
_KEEP_ACTIONS = {{'Idle', 'Walk', 'Run'}}
for _a in list(bpy.data.actions):
    if _a.name not in _KEEP_ACTIONS:
        try: bpy.data.actions.remove(_a, do_unlink=True)
        except Exception: pass
print(f"AUTORIG: cleanup done — objects={{len(bpy.data.objects)}} actions={{len(bpy.data.actions)}}", flush=True)

# Diagnostic: check mesh skinning state
_vg_count = len(new_mesh.vertex_groups) if hasattr(new_mesh, 'vertex_groups') else 0
_arm_mods = [m for m in new_mesh.modifiers if m.type == 'ARMATURE']
_arm_mod_obj = _arm_mods[0].object.name if _arm_mods and _arm_mods[0].object else 'none'
print(f"AUTORIG: DIAG mesh vertex_groups={{_vg_count}} armature_mods={{len(_arm_mods)}} mod.object={{_arm_mod_obj}}", flush=True)
# Check if any vertex actually has non-zero weight
_weighted = 0
for _v in new_mesh.data.vertices[:100]:
    if any(g.weight > 0 for g in _v.groups):
        _weighted += 1
print(f"AUTORIG: DIAG first 100 verts with weight>0 = {{_weighted}}", flush=True)

# ===== Step 11b: Export =====
output_fbx = {json.dumps(output_fbx.replace(chr(92), "/"))}
print(f"AUTORIG: exporting to {{output_fbx}}", flush=True)
bpy.ops.object.select_all(action='DESELECT')
new_mesh.select_set(True)
template_armature.select_set(True)
bpy.context.view_layer.objects.active = template_armature

print(f"AUTORIG: selected for export: {{[o.name for o in bpy.context.selected_objects]}}", flush=True)

# Export to GLB instead of FBX — avoids FBXLoader bind-matrix bugs (three.js #16222)
# Select BOTH mesh and armature explicitly before export to ensure the
# SkinnedMesh relationship is preserved.
bpy.ops.object.select_all(action='DESELECT')
new_mesh.select_set(True)
template_armature.select_set(True)
bpy.context.view_layer.objects.active = template_armature
bpy.ops.export_scene.gltf(
    filepath=output_fbx,
    export_format='GLB',
    use_selection=False,
    export_apply=False,
    export_animations=True,
    export_skins=True,
    export_morph=False,
    export_yup=True,
    export_extras=False,
)

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

# ========== Persist textures before export (same rationale as step 10) ==========
import os, tempfile
_tex_tmp = os.path.join(tempfile.gettempdir(), "fabmesh_autorig_tex_" + str(os.getpid()))
os.makedirs(_tex_tmp, exist_ok=True)
_saved_tex = 0
for _img in list(bpy.data.images):
    if _img is None or _img.type != 'IMAGE':
        continue
    if _img.size[0] == 0 or _img.size[1] == 0:
        try: _img.reload()
        except Exception: pass
        if _img.size[0] == 0 or _img.size[1] == 0:
            continue
    _safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in (_img.name or "tex"))
    if not _safe.lower().endswith(('.png', '.jpg', '.jpeg', '.tga', '.bmp')):
        _safe += ".png"
    _target = os.path.join(_tex_tmp, _safe)
    try:
        _img.filepath_raw = _target
        _img.file_format = 'PNG'
        _img.save()
        try: _img.pack()
        except Exception: pass
        _saved_tex += 1
    except Exception as _e:
        print(f"AUTORIG: failed to save image '{{_img.name}}': {{_e}}", flush=True)
print(f"AUTORIG: persisted {{_saved_tex}} texture(s) for FBX embed", flush=True)
try:
    bpy.ops.file.pack_all()
except Exception as _e:
    print(f"AUTORIG: pack_all failed: {{_e}}", flush=True)

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
    add_leaf_bones=True,
    bake_anim=True,
    bake_anim_use_all_actions=False,
    bake_anim_use_nla_strips=True,
    bake_anim_use_all_bones=True,
    bake_anim_force_startend_keying=True,
    bake_anim_step=1.0,
    bake_anim_simplify_factor=1.0,
    mesh_smooth_type='FACE',
    use_mesh_modifiers=True,
    global_scale=1.0,
    apply_unit_scale=True,
    apply_scale_options='FBX_SCALE_ALL',
    axis_forward='-Z',
    axis_up='Y',
    primary_bone_axis='Y',
    secondary_bone_axis='X',
    armature_nodetype='ROOT',
    use_armature_deform_only=False,
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
        # Anim folder convention: scripts/rig_templates/animations/<template_name>/
        anim_dir = os.path.join(TEMPLATES_DIR, "animations", template_name)
        if not os.path.isdir(anim_dir):
            anim_dir = None
        else:
            print(f"AUTORIG: anim dir = {anim_dir}", flush=True)
        script_content = build_fbx_template_script(mesh_path, template["path"], output_fbx, landmarks, anim_dir)
    else:
        script_content = build_blender_script(mesh_path, template, output_fbx)

    # Write to a temp file for Blender to execute
    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".py", prefix="autorig_")
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            f.write(script_content)

        print(f"AUTORIG: Running Blender (background)...", flush=True)
        # Use Popen with line-by-line streaming reads instead of subprocess.run
        # with capture_output=True. The latter buffers stdout in RAM until the
        # child exits, but Blender can write many MB; if the OS pipe (~64 KB)
        # fills up, Blender blocks on its write() and the whole process hangs.
        # Streaming reads keep the pipe drained.
        keywords = ("AUTORIG", "Error", "ERROR", "Traceback", "  File ", "Exception", "raise ", "ValueError", "TypeError", "AttributeError", "RuntimeError")
        proc = subprocess.Popen(
            [blender_exe, "--background", "--python", tmp_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,  # merge stderr into stdout for streaming
            text=True,
            bufsize=1,  # line buffered
        )
        stdout_tail = []  # keep last 200 lines for error reporting
        try:
            for line in iter(proc.stdout.readline, ''):
                if not line:
                    break
                line = line.rstrip()
                stdout_tail.append(line)
                if len(stdout_tail) > 200:
                    stdout_tail.pop(0)
                if any(k in line for k in keywords):
                    print(line, flush=True)
            proc.wait(timeout=300)
        except subprocess.TimeoutExpired:
            print("AUTORIG_ERROR: Blender timed out after 300s — killing", flush=True)
            try: proc.kill()
            except Exception: pass
            sys.exit(1)
        finally:
            try: proc.stdout.close()
            except Exception: pass

        if proc.returncode != 0:
            print(f"AUTORIG_ERROR: Blender exited with code {proc.returncode}")
            print("=== STDOUT (tail) ===")
            print("\n".join(stdout_tail[-50:]))
            sys.exit(1)

        if not os.path.exists(output_fbx):
            print("AUTORIG_ERROR: Output FBX not created")
            print("=== STDOUT (tail) ===")
            print("\n".join(stdout_tail[-80:]))
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
