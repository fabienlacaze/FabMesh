I can see the current sword with an ornate but somewhat stylized guard. To make it more realistic, I'll redesign the guard to be simpler and more historically accurate - a straight crossguard with proper proportions, solid construction, and realistic metalwork details.

```python
import bpy
import bmesh
import math
from mathutils import Vector

# Clear scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

# Create blade - made longer
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.75))
blade = bpy.context.active_object
blade.name = "Blade"
blade.scale = (0.04, 0.15, 2.0)
bpy.ops.object.transform_apply(scale=True)

# Taper blade to sharper point
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='DESELECT')
bpy.ops.object.mode_set(mode='OBJECT')
for v in blade.data.vertices:
    if v.co.z > 1.8:
        v.co.x *= 0.02
        v.co.y *= 0.02
    elif v.co.z > 1.4:
        factor = (v.co.z - 1.4) / 0.4
        v.co.x *= (1.0 - factor * 0.98)
        v.co.y *= (1.0 - factor * 0.98)
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()

# Blade material - realistic steel
blade_mat = bpy.data.materials.new(name="Steel")
blade_mat.use_nodes = True
nodes = blade_mat.node_tree.nodes
nodes.clear()
bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
bsdf.inputs['Base Color'].default_value = (0.85, 0.86, 0.88, 1.0)
bsdf.inputs['Metallic'].default_value = 1.0
bsdf.inputs['Roughness'].default_value = 0.25
bsdf.inputs['Specular IOR Level'].default_value = 0.5
output = nodes.new(type='ShaderNodeOutputMaterial')
blade_mat.node_tree.links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])
blade.data.materials.append(blade_mat)

# Create realistic crossguard - straight horizontal bar
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, -0.05))
guard = bpy.context.active_object
guard.name = "Guard"
guard.scale = (0.05, 0.45, 0.05)
bpy.ops.object.transform_apply(scale=True)

bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.subdivide(number_cuts=1)

# Add slight taper to guard ends
bm = bmesh.from_edit_mesh(guard.data)
for v in bm.verts:
    y_abs = abs(v.co.y)
    if y_abs > 0.15:
        taper_factor = (y_abs - 0.15) / 0.3
        v.co.x *= (1.0 - taper_factor * 0.3)
        v.co.z *= (1.0 - taper_factor * 0.25)

bmesh.update_edit_mesh(guard.data)
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.bevel(offset=0.008, segments=2)
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()

# Guard material - realistic steel
guard_mat = bpy.data.materials.new(name="GuardSteel")
guard_mat.use_nodes = True
nodes = guard_mat.node_tree.nodes
nodes.clear()
bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
bsdf.inputs['Base Color'].default_value = (0.75, 0.76, 0.78, 1.0)
bsdf.inputs['Metallic'].default_value = 1.0
bsdf.inputs['Roughness'].default_value = 0.35
bsdf.inputs['Specular IOR Level'].default_value = 0.5
output = nodes.new(type='ShaderNodeOutputMaterial')
guard_mat.node_tree.links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])
guard.data.materials.append(guard_mat)

# Create central guard block (ricasso protection)
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, -0.05))
guard_center = bpy.context.active_object
guard_center.name = "GuardCenter"
guard_center.scale = (0.06, 0.08, 0.08)
bpy.ops.object.transform_apply(scale=True)

bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.bevel(offset=0.006, segments=2)
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()
guard_center.data.materials.append(guard_mat)

# Add decorative brass ring at guard center
bpy.ops.mesh.primitive_torus_add(major_radius=0.042, minor_radius=0.008, location=(0, 0, -0.05))
guard_ring = bpy.context.active_object
guard_ring.name = "GuardRing"
guard_ring.rotation_euler = (math.radians(90), 0, 0)
bpy.ops.object.transform_apply(rotation=True)
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()

# Brass material for decorative elements
brass_mat = bpy.data.materials.new(name="Brass")
brass_mat.use_nodes = True
nodes = brass_mat.node_tree.nodes
nodes.clear()
bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
bsdf.inputs['Base Color'].default_value = (0.78, 0.58, 0.24, 1.0)
bsdf.inputs['Metallic'].default_value = 1.0
bsdf.inputs['Roughness'].default_value = 0.35
bsdf.inputs['Specular IOR Level'].default_value = 0.5
output = nodes.new(type='ShaderNodeOutputMaterial')
brass_mat.node_tree.links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])
guard_ring.data.materials.append(brass_mat)

# Add end caps to crossguard
for side in [-1, 1]:
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=8, radius=0.032, location=(0, side * 0.225, -0.05))
    cap = bpy.context.active_object
    cap.name = f"GuardCap{side}"
    cap.scale[1] = 0.8
    bpy.ops.object.transform_apply(scale=True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.shade_smooth()
    cap.data.materials.append(brass_mat)

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

# Grip material - realistic worn leather
leather_mat = bpy.data.materials.new(name="Leather")
leather_mat.use_nodes = True
nodes = leather_mat.node_tree.nodes
nodes.clear()
bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
bsdf.inputs['Base Color'].default_value = (0.25, 0.15, 0.10, 1.0)
bsdf.inputs['Metallic'].default_value = 0.0
bsdf.inputs['Roughness'].default_value = 0.85
bsdf.inputs['Specular IOR Level'].default_value = 0.3
bsdf.inputs['Subsurface Weight'].default_value = 0.05
bsdf.inputs['Subsurface Radius'].default_value = (0.2, 0.1, 0.05)
output = nodes.new(type='ShaderNodeOutputMaterial')
leather_mat.node_tree.links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])
grip.data.materials.append(leather_mat)

# Create realistic pommel
bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=0.07, location=(0, 0, -0.75))
pommel = bpy.context.active_object
pommel.name = "Pommel"
pommel.scale[2] = 0.7
bpy.ops.object.transform_apply(scale=True)

bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.subdivide(number_cuts=1)
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()

# Pommel material - brass
pommel.data.materials.append(brass_mat)

# Add pommel decoration ring
bpy.ops.mesh.primitive_torus_add(major_radius=0.065, minor_radius=0.01, location=(0, 0, -0.72))
pommel_ring = bpy.context.active_object
pommel_ring.name = "PommelRing"
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()
pommel_ring.data.materials.append(brass_mat)

# Add light
bpy.ops.object.light_add(type='SUN', location=(5, 5, 10))
light = bpy.context.active_object
light.data.energy = 2.0

# Add camera
bpy.ops.object.camera_add(location=(2, -2, 1.5))
camera = bpy.context.active_object
camera.rotation_euler = (math.radians(75), 0, math.radians(45))
bpy.context.scene.camera = camera

# Export
output_path = "C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/meshes/sword_1775405032517.glb"
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
```