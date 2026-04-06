I can see the sword has very dark/black rendering issues. For more realism, I'll add proper lighting setup, improve materials with more realistic properties, add fuller (blood groove) to the blade, improve blade geometry, add better environment lighting, and fix the rendering darkness.

import bpy
import bmesh
import math
from mathutils import Vector

# Clear scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

# Enable EEVR/Cycles for better rendering
bpy.context.scene.render.engine = 'CYCLES'

# Create blade with fuller (blood groove)
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.75))
blade = bpy.context.active_object
blade.name = "Blade"
blade.scale = (0.04, 0.15, 2.0)
bpy.ops.object.transform_apply(scale=True)

# Add fuller detail to blade
bpy.ops.object.mode_set(mode='EDIT')
bm = bmesh.from_edit_mesh(blade.data)
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.subdivide(number_cuts=3)
bpy.ops.object.mode_set(mode='OBJECT')

# Create fuller groove and taper
for v in blade.data.vertices:
    z_pos = v.co.z
    y_pos = abs(v.co.y)
    
    # Fuller groove in the middle
    if 0.2 < z_pos < 1.6 and y_pos < 0.05:
        v.co.x *= 0.85
    
    # Taper to point
    if z_pos > 1.8:
        v.co.x *= 0.01
        v.co.y *= 0.01
    elif z_pos > 1.4:
        factor = (z_pos - 1.4) / 0.4
        v.co.x *= (1.0 - factor * 0.99)
        v.co.y *= (1.0 - factor * 0.99)
    
    # Blade edge bevel
    if y_pos > 0.12:
        edge_factor = (y_pos - 0.12) / 0.03
        v.co.x *= (1.0 - edge_factor * 0.3)

bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()

# Realistic steel blade material with anisotropic reflections
blade_mat = bpy.data.materials.new(name="Steel")
blade_mat.use_nodes = True
nodes = blade_mat.node_tree.nodes
links = blade_mat.node_tree.links
nodes.clear()

bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
bsdf.location = (0, 0)
bsdf.inputs['Base Color'].default_value = (0.88, 0.89, 0.91, 1.0)
bsdf.inputs['Metallic'].default_value = 1.0
bsdf.inputs['Roughness'].default_value = 0.15
bsdf.inputs['Specular IOR Level'].default_value = 0.5
bsdf.inputs['Anisotropic'].default_value = 0.7
bsdf.inputs['Anisotropic Rotation'].default_value = 0.0

# Add noise texture for micro-scratches
noise = nodes.new(type='ShaderNodeTexNoise')
noise.location = (-600, -200)
noise.inputs['Scale'].default_value = 150.0
noise.inputs['Detail'].default_value = 8.0
noise.inputs['Roughness'].default_value = 0.6

color_ramp = nodes.new(type='ShaderNodeValToRGB')
color_ramp.location = (-400, -200)
color_ramp.color_ramp.elements[0].position = 0.45
color_ramp.color_ramp.elements[1].position = 0.55

mix = nodes.new(type='ShaderNodeMix')
mix.location = (-200, 0)
mix.data_type = 'RGBA'
mix.inputs[0].default_value = 0.05

links.new(noise.outputs['Fac'], color_ramp.inputs['Fac'])
links.new(color_ramp.outputs['Color'], mix.inputs[7])
links.new(mix.outputs[2], bsdf.inputs['Roughness'])

output = nodes.new(type='ShaderNodeOutputMaterial')
output.location = (300, 0)
links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

blade.data.materials.append(blade_mat)

# Create ornate guard with more detail
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, -0.05))
guard = bpy.context.active_object
guard.name = "Guard"
guard.scale = (0.12, 0.6, 0.06)
bpy.ops.object.transform_apply(scale=True)

bpy.ops.object.mode_set(mode='EDIT')
bm = bmesh.from_edit_mesh(guard.data)

# Curve and sculpt the guard
for v in bm.verts:
    y_factor = abs(v.co.y)
    if y_factor > 0.2:
        v.co.z += (y_factor - 0.2) * 0.4
        curve_scale = 1.0 + (y_factor - 0.2) * 0.3
        v.co.x *= curve_scale

bmesh.update_edit_mesh(guard.data)
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.subdivide(number_cuts=3)
bpy.ops.mesh.bevel(offset=0.015, segments=4)
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()

# Realistic brass/bronze material
gold_mat = bpy.data.materials.new(name="Brass")
gold_mat.use_nodes = True
nodes = gold_mat.node_tree.nodes
links = gold_mat.node_tree.links
nodes.clear()

bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
bsdf.location = (0, 0)
bsdf.inputs['Base Color'].default_value = (0.80, 0.60, 0.26, 1.0)
bsdf.inputs['Metallic'].default_value = 1.0
bsdf.inputs['Roughness'].default_value = 0.3
bsdf.inputs['Specular IOR Level'].default_value = 0.5

# Patina variation
noise = nodes.new(type='ShaderNodeTexNoise')
noise.location = (-400, -200)
noise.inputs['Scale'].default_value = 30.0

color_ramp = nodes.new(type='ShaderNodeValToRGB')
color_ramp.location = (-200, -200)
color_ramp.color_ramp.elements[0].color = (0.75, 0.55, 0.22, 1.0)
color_ramp.color_ramp.elements[1].color = (0.85, 0.65, 0.30, 1.0)

links.new(noise.outputs['Fac'], color_ramp.inputs['Fac'])
links.new(color_ramp.outputs['Color'], bsdf.inputs['Base Color'])

output = nodes.new(type='ShaderNodeOutputMaterial')
output.location = (300, 0)
links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

guard.data.materials.append(gold_mat)

# Guard rings with more detail
for side in [-1, 1]:
    bpy.ops.mesh.primitive_torus_add(major_radius=0.08, minor_radius=0.012, location=(0, side * 0.28, -0.05))
    ring = bpy.context.active_object
    ring.name = f"GuardRing{side}"
    ring.rotation_euler = (0, math.radians(90), 0)
    bpy.ops.object.transform_apply(rotation=True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.subdivide(number_cuts=1)
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.shade_smooth()
    ring.data.materials.append(gold_mat)

# Decorative spheres
for y_pos in [-0.35, -0.15, 0.15, 0.35]:
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=12, radius=0.025, location=(0, y_pos, -0.05))
    sphere = bpy.context.active_object
    sphere.name = f"GuardSphere_{y_pos}"
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.shade_smooth()
    sphere.data.materials.append(gold_mat)

# Quillon blocks
for side in [-1, 1]:
    bpy.ops.mesh.primitive_cube_add(size=0.06, location=(0, side * 0.42, -0.03))
    quillon = bpy.context.active_object
    quillon.name = f"Quillon{side}"
    quillon.scale = (1.2, 1, 1.5)
    quillon.rotation_euler.z = math.radians(15 * side)
    bpy.ops.object.transform_apply(scale=True, rotation=True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.bevel(offset=0.008, segments=3)
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.shade_smooth()
    quillon.data.materials.append(gold_mat)

# Enhanced grip with wrapping detail
bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=0.04, depth=0.6, location=(0, 0, -0.4))
grip = bpy.context.active_object
grip.name = "Grip"

bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.subdivide(number_cuts=12)
bpy.ops.object.mode_set(mode='OBJECT')

# Spiral grip pattern
for i, v in enumerate(grip.data.vertices):
    z_pos = v.co.z
    if abs(z_pos) < 0.28:
        angle = math.atan2(v.co.y, v.co.x)
        spiral = math.sin(z_pos * 15 + angle * 3) * 0.004
        radius_mod = 1 + spiral
        v.co.x *= radius_mod
        v.co.y *= radius_mod

bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()

subsurf = grip.modifiers.new(name="Subsurf", type='SUBSURF')
subsurf.levels = 2
subsurf.render_levels = 2

# Realistic leather material
leather_mat = bpy.data.materials.new(name="Leather")
leather_mat.use_nodes = True
nodes = leather_mat.node_tree.nodes
links = leather_mat.node_tree.links
nodes.clear()

bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
bsdf.location = (0, 0)
bsdf.inputs['Base Color'].default_value = (0.28, 0.18, 0.12, 1.0)
bsdf.inputs['Metallic'].default_value = 0.0
bsdf.inputs['Roughness'].default_value = 0.9
bsdf.inputs['Specular IOR Level'].default_value = 0.25
bsdf.inputs['Subsurface Weight'].default_value = 0.08
bsdf.inputs['Subsurface Radius'].default_value = (0.3, 0.15, 0.08)

# Leather texture
noise = nodes.new(type='ShaderNodeTexNoise')
noise.location = (-600, 0)
noise.inputs['Scale'].default_value = 80.0
noise.inputs['Detail'].default_value = 10.0
noise.inputs['Roughness'].default_value = 0.7

bump = nodes.new(type='ShaderNodeBump')
bump.location = (-200, -200)
bump.inputs['Strength'].default_value = 0.3

links.new(noise.outputs['Fac'], bump.inputs['Height'])
links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])

output = nodes.new(type='ShaderNodeOutputMaterial')
output.location = (300, 0)
links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

grip.data.materials.append(leather_mat)

# Ornate pommel
bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=16, radius=0.07, location=(0, 0, -0.75))
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

pommel.data.materials.append(gold_mat)

# Pommel ring
bpy.ops.mesh.primitive_torus_add(major_radius=0.065, minor_radius=0.01, location=(0, 0, -0.72))
pommel_ring = bpy.context.active_object
pommel_ring.name = "PommelRing"
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.subdivide(number_cuts=1)
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()
pommel_ring.data.materials.append(gold_mat)

# Professional lighting setup - three-point lighting
bpy.ops.object.light_add(type='SUN', location=(5, -3, 8))
key_light = bpy.context.active_object
key_light.name = "Key Light"
key_light.data.energy = 3.5
key_light.data.angle = math.radians(10)
key_light.rotation_euler = (math.radians(50), 0, math.radians(135))

bpy.ops.object.light_add(type='AREA', location=(-4, 2, 5))
fill_light = bpy.context.active_object
fill_light.name = "Fill Light"
fill_light.data.energy = 150
fill_light.data.size = 3
fill_light.rotation_euler = (math.radians(60), 0, math.radians(-45))

bpy.ops.object.light_add(type='AREA', location=(1, -5, 2))
rim_light = bpy.context.active_object
rim_light.name = "Rim Light"
rim_light.data.energy = 200
rim_light.data.size = 2
rim_light.rotation_euler = (math.radians(80), 0, math.radians(90))

# Add world environment lighting
world = bpy.context.scene.world
world.use_nodes = True
world_nodes = world.node_tree.nodes
world_links = world.node_tree.links
world_nodes.clear()

bg = world_nodes.new(type='ShaderNodeBackground')
bg.inputs['Color'].default_value = (0.05, 0.05, 0.06, 1.0)
bg.inputs['Strength'].default_value = 0.8

output = world_nodes.new(type='ShaderNodeOutputWorld')
world_links.new(bg.outputs['Background'], output.inputs['Surface'])

# Camera with better angle
bpy.ops.object.camera_add(location=(2.5, -2.5, 1.5))
camera = bpy.context.active_object
camera.rotation_euler = (math.radians(72), 0, math.radians(45))
bpy.context.scene.camera = camera

# Camera settings for better depth of field
camera.data.lens = 50
camera.data.sensor_width = 36

# Export
output_path = "C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/meshes/sword_1775405370781.glb"
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