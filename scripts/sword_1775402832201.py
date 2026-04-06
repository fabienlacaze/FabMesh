import bpy
import bmesh
import math
from mathutils import Vector

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

# Blade
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 1.5))
blade = bpy.context.active_object
blade.name = "Blade"
blade.scale = (0.08, 0.4, 1.5)
bpy.ops.object.transform_apply(scale=True)

bpy.ops.object.mode_set(mode='EDIT')
bm = bmesh.from_edit_mesh(blade.data)
top_verts = [v for v in bm.verts if v.co.z > 1.4]
for v in top_verts:
    v.co.x *= 0.3
    v.co.y *= 0.3
bmesh.update_edit_mesh(blade.data)
bpy.ops.object.mode_set(mode='OBJECT')

bpy.ops.object.modifier_add(type='BEVEL')
blade.modifiers["Bevel"].width = 0.01
blade.modifiers["Bevel"].segments = 3

mat_blade = bpy.data.materials.new(name="Blade_Material")
mat_blade.use_nodes = True
nodes = mat_blade.node_tree.nodes
nodes.clear()
bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
bsdf.inputs['Base Color'].default_value = (0.7, 0.75, 0.8, 1.0)
bsdf.inputs['Metallic'].default_value = 1.0
bsdf.inputs['Roughness'].default_value = 0.2
output = nodes.new(type='ShaderNodeOutputMaterial')
mat_blade.node_tree.links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])
blade.data.materials.append(mat_blade)

# Guard
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.2))
guard = bpy.context.active_object
guard.name = "Guard"
guard.scale = (0.15, 0.8, 0.08)
bpy.ops.object.transform_apply(scale=True)

bpy.ops.object.modifier_add(type='BEVEL')
guard.modifiers["Bevel"].width = 0.015
guard.modifiers["Bevel"].segments = 4

mat_guard = bpy.data.materials.new(name="Guard_Material")
mat_guard.use_nodes = True
nodes = mat_guard.node_tree.nodes
nodes.clear()
bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
bsdf.inputs['Base Color'].default_value = (0.85, 0.7, 0.2, 1.0)
bsdf.inputs['Metallic'].default_value = 1.0
bsdf.inputs['Roughness'].default_value = 0.15
output = nodes.new(type='ShaderNodeOutputMaterial')
mat_guard.node_tree.links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])
guard.data.materials.append(mat_guard)

# Guard decoration
bpy.ops.mesh.primitive_cylinder_add(radius=0.06, depth=0.12, location=(0, 0.7, 0.2), rotation=(math.pi/2, 0, 0))
guard_deco1 = bpy.context.active_object
guard_deco1.name = "Guard_Deco1"
guard_deco1.data.materials.append(mat_guard)

bpy.ops.mesh.primitive_cylinder_add(radius=0.06, depth=0.12, location=(0, -0.7, 0.2), rotation=(math.pi/2, 0, 0))
guard_deco2 = bpy.context.active_object
guard_deco2.name = "Guard_Deco2"
guard_deco2.data.materials.append(mat_guard)

# Handle
bpy.ops.mesh.primitive_cylinder_add(radius=0.08, depth=0.6, location=(0, 0, -0.2))
handle = bpy.context.active_object
handle.name = "Handle"

mat_handle = bpy.data.materials.new(name="Handle_Material")
mat_handle.use_nodes = True
nodes = mat_handle.node_tree.nodes
nodes.clear()
bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
bsdf.inputs['Base Color'].default_value = (0.25, 0.15, 0.08, 1.0)
bsdf.inputs['Metallic'].default_value = 0.0
bsdf.inputs['Roughness'].default_value = 0.7
output = nodes.new(type='ShaderNodeOutputMaterial')
mat_handle.node_tree.links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])
handle.data.materials.append(mat_handle)

# Leather wrapping details
for i in range(5):
    z_pos = -0.45 + i * 0.12
    bpy.ops.mesh.primitive_torus_add(major_radius=0.085, minor_radius=0.015, location=(0, 0, z_pos))
    wrap = bpy.context.active_object
    wrap.name = f"Wrap_{i}"
    wrap.data.materials.append(mat_handle)

# Pommel
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.12, location=(0, 0, -0.55))
pommel = bpy.context.active_object
pommel.name = "Pommel"
pommel.scale = (1, 1, 0.7)
bpy.ops.object.transform_apply(scale=True)

mat_pommel = bpy.data.materials.new(name="Pommel_Material")
mat_pommel.use_nodes = True
nodes = mat_pommel.node_tree.nodes
nodes.clear()
bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
bsdf.inputs['Base Color'].default_value = (0.85, 0.7, 0.2, 1.0)
bsdf.inputs['Metallic'].default_value = 1.0
bsdf.inputs['Roughness'].default_value = 0.15
output = nodes.new(type='ShaderNodeOutputMaterial')
mat_pommel.node_tree.links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])
pommel.data.materials.append(mat_pommel)

# Lighting
bpy.ops.object.light_add(type='SUN', location=(5, 5, 10))
sun = bpy.context.active_object
sun.data.energy = 2.0

bpy.ops.object.select_all(action='SELECT')

output_path = "C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/meshes/sword_1775402832201.glb"
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