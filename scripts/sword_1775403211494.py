import bpy
import bmesh
import math
from mathutils import Vector

# Clear scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

# Create blade
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.5))
blade = bpy.context.active_object
blade.name = "Blade"
blade.scale = (0.04, 0.15, 1.5)
bpy.ops.object.transform_apply(scale=True)

# Taper blade to point
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='DESELECT')
bpy.ops.object.mode_set(mode='OBJECT')
for v in blade.data.vertices:
    if v.co.z > 1.3:
        v.co.x *= 0.1
        v.co.y *= 0.1
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()

# Blade material - steel
blade_mat = bpy.data.materials.new(name="Steel")
blade_mat.use_nodes = True
nodes = blade_mat.node_tree.nodes
nodes.clear()
bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
bsdf.inputs['Base Color'].default_value = (0.7, 0.7, 0.75, 1.0)
bsdf.inputs['Metallic'].default_value = 1.0
bsdf.inputs['Roughness'].default_value = 0.2
output = nodes.new(type='ShaderNodeOutputMaterial')
blade_mat.node_tree.links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])
blade.data.materials.append(blade_mat)

# Create guard
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, -0.05))
guard = bpy.context.active_object
guard.name = "Guard"
guard.scale = (0.08, 0.5, 0.08)
bpy.ops.object.transform_apply(scale=True)

# Add guard details
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.bevel(offset=0.01, segments=3)
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()

# Guard material - gold
gold_mat = bpy.data.materials.new(name="Gold")
gold_mat.use_nodes = True
nodes = gold_mat.node_tree.nodes
nodes.clear()
bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
bsdf.inputs['Base Color'].default_value = (0.9, 0.7, 0.2, 1.0)
bsdf.inputs['Metallic'].default_value = 1.0
bsdf.inputs['Roughness'].default_value = 0.15
output = nodes.new(type='ShaderNodeOutputMaterial')
gold_mat.node_tree.links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])
guard.data.materials.append(gold_mat)

# Create grip/handle
bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.04, depth=0.6, location=(0, 0, -0.4))
grip = bpy.context.active_object
grip.name = "Grip"

# Add grip texture detail
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.subdivide(number_cuts=8)
bpy.ops.object.mode_set(mode='OBJECT')

# Add slight grip curves
for i, v in enumerate(grip.data.vertices):
    if abs(v.co.z) < 0.25:
        offset = math.sin(v.co.z * 8) * 0.003
        v.co.x *= (1 + offset)
        v.co.y *= (1 + offset)

bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()

# Add subdivision for smooth grip
subsurf = grip.modifiers.new(name="Subsurf", type='SUBSURF')
subsurf.levels = 2

# Grip material - leather
leather_mat = bpy.data.materials.new(name="Leather")
leather_mat.use_nodes = True
nodes = leather_mat.node_tree.nodes
nodes.clear()
bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
bsdf.inputs['Base Color'].default_value = (0.3, 0.2, 0.15, 1.0)
bsdf.inputs['Metallic'].default_value = 0.0
bsdf.inputs['Roughness'].default_value = 0.8
output = nodes.new(type='ShaderNodeOutputMaterial')
leather_mat.node_tree.links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])
grip.data.materials.append(leather_mat)

# Create pommel
bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=0.06, location=(0, 0, -0.75))
pommel = bpy.context.active_object
pommel.name = "Pommel"
pommel.scale[2] = 0.6
bpy.ops.object.transform_apply(scale=True)

bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()

# Pommel material - gold
pommel.data.materials.append(gold_mat)

# Add guard decorations
bpy.ops.mesh.primitive_cube_add(size=0.04, location=(0, 0.25, -0.05))
guard_deco1 = bpy.context.active_object
guard_deco1.name = "GuardDeco1"
guard_deco1.scale = (1, 0.8, 1.5)
bpy.ops.object.transform_apply(scale=True)
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()
guard_deco1.data.materials.append(gold_mat)

bpy.ops.mesh.primitive_cube_add(size=0.04, location=(0, -0.25, -0.05))
guard_deco2 = bpy.context.active_object
guard_deco2.name = "GuardDeco2"
guard_deco2.scale = (1, 0.8, 1.5)
bpy.ops.object.transform_apply(scale=True)
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()
guard_deco2.data.materials.append(gold_mat)

# Add light
bpy.ops.object.light_add(type='SUN', location=(5, 5, 10))
light = bpy.context.active_object
light.data.energy = 2.0

# Add camera
bpy.ops.object.camera_add(location=(2, -2, 1))
camera = bpy.context.active_object
camera.rotation_euler = (math.radians(75), 0, math.radians(45))
bpy.context.scene.camera = camera

# Export
output_path = "C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/meshes/sword_1775403211494.glb"
if output_path.endswith('.glb') or output_path.endswith('.gltf'):
    fmt = 'GLB' if output_path.endswith('.glb') else 'GLTF_SEPARATE'
    bpy.ops.export_scene.gltf(filepath=output_path, export_format=fmt)
elif output_path.endswith('.obj'):
    bpy.ops.wm.obj_export(filepath=output_path)
elif output_path.endswith('.fbx'):
    bpy.ops.export_scene.fbx(filepath=output_path)
elif output_path.endswith('.stl'):
    bpy.ops.export_mesh.stl(filepath=output_path)
print("FABMESH_SUCCESS")