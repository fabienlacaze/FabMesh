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
    path = os.path.join(TEMPLATES_DIR, f"{name}.json")
    if not os.path.exists(path):
        raise FileNotFoundError(f"Template not found: {path}")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


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
        print("Usage: python auto_rig_bridge.py <mesh> <template> <output> <blender_exe>")
        sys.exit(1)

    mesh_path = sys.argv[1]
    template_name = sys.argv[2]
    output_fbx = sys.argv[3]
    blender_exe = sys.argv[4]

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

    print(f"AUTORIG: Building Blender script for template '{template_name}'", flush=True)
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

        # Forward Blender output (filter noise)
        for line in result.stdout.splitlines():
            if "AUTORIG" in line or "Error" in line or "ERROR" in line:
                print(line, flush=True)

        if result.returncode != 0:
            print(f"AUTORIG_ERROR: Blender exited with code {result.returncode}")
            print(result.stderr[-2000:] if result.stderr else "")
            sys.exit(1)

        if not os.path.exists(output_fbx):
            print("AUTORIG_ERROR: Output FBX not created")
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
