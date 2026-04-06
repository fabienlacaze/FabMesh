import bpy
import bmesh
import math
from mathutils import Vector

# Clear scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

# Create blade with fuller (blood groove)
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.75))
blade = bpy.context.active_object
blade.name = "Blade"
blade.scale = (0.05, 0.2, 2.0)
bpy.ops.object.transform_apply(scale=True)

# Create blade shape with realistic taper and fuller
bpy.ops.object.mode_set(mode='EDIT')
bm = bmesh.from_edit_mesh(blade.data)

# Add subdivisions for smoother taper
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.subdivide(number_cuts=10)

bpy.ops.object.mode_set(mode='OBJECT')

# Taper blade realistically
for v in blade.data.vertices:
    z_pos = v.co.z
    if z_pos > 1.6:
        # Sharp tip
        factor = (z_pos - 1.6) / 0.4
        v.co.x *= (1.0 - factor * 0.95)
        v.co.y *= (1.0 - factor * 0.95)
    elif z_pos > 0.5:
        # Gradual taper towards tip
        factor = (z_pos - 0.5) / 1.1
        v.co.x *= (1.0 - factor * 0.15)
        v.co.y *= (1.0 - factor * 0.3)
    
    # Add fuller (blood groove) in the middle of blade
    if 0.0 < z_pos < 1.4 and abs(v.co.x) < 0.015:
        v.co.x *= 0.7

bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()

# Add bevel to blade edge for realistic sharpness
bevel_mod = blade.modifiers.new(name="Bevel", type='BEVEL')
bevel_mod.width = 0.002
bevel_mod.segments = 2

# Blade material - realistic steel
blade_mat = bpy.data.materials.new(name="Steel")
blade_mat.use_nodes = True
nodes = blade_mat.node_tree.nodes
nodes.clear()
bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
bsdf.inputs['Base Color'].default_value = (0.75, 0.76, 0.78, 1.0)
bsdf.inputs['Metallic'].default_value = 1.0
bsdf.inputs['Roughness'].default_value = 0.15
bsdf.inputs['Specular IOR Level'].default_value = 0.5
output = nodes.new(type='ShaderNodeOutputMaterial')
blade_mat.node_tree.links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])
blade.data.materials.append(blade_mat)

# Create realistic crossguard
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, -0.05))
guard = bpy.context.active_object
guard.name = "Guard"
guard.scale = (0.12, 0.6, 0.06)
bpy.ops.object.transform_apply(scale=True)

# Shape crossguard with curved ends
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.subdivide(number_cuts=3)
bpy.ops.object.mode_set(mode='OBJECT')

for v in guard.data.vertices:
    if abs(v.co.y) > 0.2:
        # Curve the ends upward
        curve_factor = (abs(v.co.y) - 0.2) / 0.1
        v.co.z += curve_factor * 0.03
        # Taper the ends
        v.co.x *= (1.0 - curve_factor * 0.3)
        v.co.z *= (1.0 - curve_factor * 0.2)

bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.bevel(offset=0.008, segments=3)
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()

# Guard material - darker metal
guard_mat = bpy.data.materials.new(name="GuardMetal")
guard_mat.use_nodes = True
nodes = guard_mat.node_tree.nodes
nodes.clear()
bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
bsdf.inputs['Base Color'].default_value = (0.3, 0.28, 0.25, 1.0)
bsdf.inputs['Metallic'].default_value = 1.0
bsdf.inputs['Roughness'].default_value = 0.3
output = nodes.new(type='ShaderNodeOutputMaterial')
guard_mat.node_tree.links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])
guard.data.materials.append(guard_mat)

# Create realistic wrapped leather grip
bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=0.045, depth=0.55, location=(0, 0, -0.4))
grip = bpy.context.active_object
grip.name = "Grip"

bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.subdivide(number_cuts=20)
bpy.ops.object.mode_set(mode='OBJECT')

# Add realistic leather wrapping pattern
for i, v in enumerate(grip.data.vertices):
    angle = math.atan2(v.co.y, v.co.x)
    z_pos = v.co.z
    
    # Spiral wrapping pattern
    wrap_pattern = math.sin(angle * 4 + z_pos * 20) * 0.004
    v.co.x *= (1 + wrap_pattern)
    v.co.y *= (1 + wrap_pattern)
    
    # Slight taper towards ends
    if abs(z_pos) > 0.2:
        taper = (abs(z_pos) - 0.2) / 0.075
        v.co.x *= (1.0 - taper * 0.08)
        v.co.y *= (1.0 - taper * 0.08)

bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()

subsurf = grip.modifiers.new(name="Subsurf", type='SUBSURF')
subsurf.levels = 2
subsurf.render_levels = 3

# Realistic leather material
leather_mat = bpy.data.materials.new(name="Leather")
leather_mat.use_nodes = True
nodes = leather_mat.node_tree.nodes
nodes.clear()
bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
bsdf.inputs['Base Color'].default_value = (0.22, 0.15, 0.10, 1.0)
bsdf.inputs['Metallic'].default_value = 0.0
bsdf.inputs['Roughness'].default_value = 0.9
bsdf.inputs['Specular IOR Level'].default_value = 0.2
output = nodes.new(type='ShaderNodeOutputMaterial')
leather_mat.node_tree.links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])
grip.data.materials.append(leather_mat)

# Create realistic pommel
bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=0.055, depth=0.08, location=(0, 0, -0.715))
pommel = bpy.context.active_object
pommel.name = "Pommel"

bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.subdivide(number_cuts=2)
bpy.ops.object.mode_set(mode='OBJECT')

# Shape pommel
for v in pommel.data.vertices:
    if abs(v.co.z) > 0.02:
        factor = (abs(v.co.z) - 0.02) / 0.02
        scale = 1.0 - factor * 0.3
        v.co.x *= scale
        v.co.y *= scale

bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.bevel(offset=0.008, segments=2)
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()

pommel.data.materials.append(guard_mat)

# Add decorative ring on grip
bpy.ops.mesh.primitive_torus_add(major_radius=0.048, minor_radius=0.008, location=(0, 0, -0.15))
ring = bpy.context.active_object
ring.name = "Ring"
bpy.ops.object.shade_smooth()

ring_mat = bpy.data.materials.new(name="Bronze")
ring_mat.use_nodes = True
nodes = ring_mat.node_tree.nodes
nodes.clear()
bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
bsdf.inputs['Base Color'].default_value = (0.55, 0.42, 0.25, 1.0)
bsdf.inputs['Metallic'].default_value = 1.0
bsdf.inputs['Roughness'].default_value = 0.25
output = nodes.new(type='ShaderNodeOutputMaterial')
ring_mat.node_tree.links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])
ring.data.materials.append(ring_mat)

# Add lighting for realistic render
bpy.ops.object.light_add(type='SUN', location=(5, 5, 10))
light = bpy.context.active_object
light.data.energy = 3.0
light.rotation_euler = (math.radians(50), math.radians(20), math.radians(30))

bpy.ops.object.light_add(type='AREA', location=(-3, -3, 5))
fill_light = bpy.context.active_object
fill_light.data.energy = 150
fill_light.data.size = 5

# Add camera
bpy.ops.object.camera_add(location=(2.5, -2.5, 1.5))
camera = bpy.context.active_object
camera.rotation_euler = (math.radians(75), 0, math.radians(45))
bpy.context.scene.camera = camera

# Set up realistic render settings
bpy.context.scene.render.engine = 'CYCLES'
bpy.context.scene.cycles.samples = 128

output_path = "C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/meshes/sword_1775406478059.glb"
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