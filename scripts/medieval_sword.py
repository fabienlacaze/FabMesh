import bpy
import bmesh
import math
from mathutils import Vector

# Clear scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
for block in bpy.data.meshes:
    if block.users == 0:
        bpy.data.meshes.remove(block)
for block in bpy.data.materials:
    if block.users == 0:
        bpy.data.materials.remove(block)

# === BLADE ===
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.75))
blade = bpy.context.active_object
blade.name = "Blade"
blade.scale = (0.06, 0.015, 0.75)
bpy.ops.object.transform_apply(scale=True)

# Sharpen blade tip
bm = bmesh.new()
bm.from_mesh(blade.data)
bm.verts.ensure_lookup_table()

# Find top vertices and merge to a point
top_verts = [v for v in bm.verts if v.co.z > 0.7]
if top_verts:
    target = Vector((0, 0, max(v.co.z for v in top_verts) + 0.08))
    for v in top_verts:
        v.co.x = v.co.x * 0.15
        v.co.z = target.z

bm.to_mesh(blade.data)
bm.free()

# Bevel blade edges
bevel = blade.modifiers.new(name="Bevel", type='BEVEL')
bevel.width = 0.005
bevel.segments = 2
bpy.context.view_layer.objects.active = blade
bpy.ops.object.modifier_apply(modifier="Bevel")

# Blade material - polished steel
blade_mat = bpy.data.materials.new(name="BladeMetal")
blade_mat.use_nodes = True
nodes = blade_mat.node_tree.nodes
bsdf = nodes.get("Principled BSDF")
bsdf.inputs["Base Color"].default_value = (0.75, 0.78, 0.82, 1.0)
bsdf.inputs["Metallic"].default_value = 0.95
bsdf.inputs["Roughness"].default_value = 0.15
blade.data.materials.append(blade_mat)

# === FULLER (blood groove) ===
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0.012, 0.55))
fuller = bpy.context.active_object
fuller.name = "Fuller"
fuller.scale = (0.025, 0.004, 0.45)
bpy.ops.object.transform_apply(scale=True)

fuller_mat = bpy.data.materials.new(name="FullerMetal")
fuller_mat.use_nodes = True
fn = fuller_mat.node_tree.nodes
fb = fn.get("Principled BSDF")
fb.inputs["Base Color"].default_value = (0.55, 0.57, 0.62, 1.0)
fb.inputs["Metallic"].default_value = 0.9
fb.inputs["Roughness"].default_value = 0.3
fuller.data.materials.append(fuller_mat)

# Duplicate fuller on other side
bpy.ops.object.duplicate()
fuller2 = bpy.context.active_object
fuller2.location.y = -0.012

# === CROSSGUARD ===
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0))
guard = bpy.context.active_object
guard.name = "Crossguard"
guard.scale = (0.22, 0.025, 0.03)
bpy.ops.object.transform_apply(scale=True)

# Taper crossguard ends
bm = bmesh.new()
bm.from_mesh(guard.data)
bm.verts.ensure_lookup_table()
for v in bm.verts:
    dist = abs(v.co.x)
    if dist > 0.15:
        v.co.y *= 0.6
        v.co.z *= 0.7
bm.to_mesh(guard.data)
bm.free()

bevel_g = guard.modifiers.new(name="Bevel", type='BEVEL')
bevel_g.width = 0.008
bevel_g.segments = 2
bpy.context.view_layer.objects.active = guard
bpy.ops.object.modifier_apply(modifier="Bevel")

# Guard material - dark steel with gold tint
guard_mat = bpy.data.materials.new(name="GuardMetal")
guard_mat.use_nodes = True
gn = guard_mat.node_tree.nodes
gb = gn.get("Principled BSDF")
gb.inputs["Base Color"].default_value = (0.45, 0.38, 0.22, 1.0)
gb.inputs["Metallic"].default_value = 0.9
gb.inputs["Roughness"].default_value = 0.3
guard.data.materials.append(guard_mat)

# === GRIP ===
bpy.ops.mesh.primitive_cylinder_add(radius=0.022, depth=0.28, location=(0, 0, -0.16))
grip = bpy.context.active_object
grip.name = "Grip"

# Grip material - dark leather
grip_mat = bpy.data.materials.new(name="Leather")
grip_mat.use_nodes = True
ln = grip_mat.node_tree.nodes
lb = ln.get("Principled BSDF")
lb.inputs["Base Color"].default_value = (0.12, 0.06, 0.03, 1.0)
lb.inputs["Roughness"].default_value = 0.85
lb.inputs["Metallic"].default_value = 0.0
grip.data.materials.append(grip_mat)

# === LEATHER WRAP RINGS ===
for i in range(6):
    z = -0.05 - i * 0.04
    bpy.ops.mesh.primitive_torus_add(
        major_radius=0.026,
        minor_radius=0.005,
        location=(0, 0, z)
    )
    ring = bpy.context.active_object
    ring.name = f"WrapRing_{i}"
    ring.data.materials.append(grip_mat)

# === POMMEL ===
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.04, location=(0, 0, -0.32))
pommel = bpy.context.active_object
pommel.name = "Pommel"
pommel.scale = (1, 0.7, 0.8)
bpy.ops.object.transform_apply(scale=True)

# Pommel material - same as guard
pommel.data.materials.append(guard_mat)

# === POMMEL CAP ===
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.015, location=(0, 0, -0.36))
cap = bpy.context.active_object
cap.name = "PommelCap"
cap.data.materials.append(guard_mat)

# === SELECT ALL AND SET ORIGIN ===
bpy.ops.object.select_all(action='SELECT')

# === EXPORT ===
output_path = "__OUTPUT_PATH__"
if output_path.endswith('.glb') or output_path.endswith('.gltf'):
    fmt = 'GLB' if output_path.endswith('.glb') else 'GLTF_SEPARATE'
    bpy.ops.export_scene.gltf(filepath=output_path, export_format=fmt)
elif output_path.endswith('.obj'):
    bpy.ops.wm.obj_export(filepath=output_path)
elif output_path.endswith('.fbx'):
    bpy.ops.export_scene.fbx(filepath=output_path)
elif output_path.endswith('.stl'):
    bpy.ops.export_mesh.stl(filepath=output_path)

print(f"FABMESH_SUCCESS: Exported to {output_path}")
