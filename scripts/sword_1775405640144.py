import bpy
import bmesh
import math
from mathutils import Vector

# Clear scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

# Create blade - made longer with fuller (blood groove)
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

# Add fuller (blood groove) detail to blade
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.subdivide(number_cuts=3)
bpy.ops.object.mode_set(mode='OBJECT')

for v in blade.data.vertices:
    if abs(v.co.y) < 0.04 and v.co.z < 1.5 and v.co.z > -0.2:
        v.co.x -= 0.003

bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()

# Blade material - realistic steel with procedural scratches
blade_mat = bpy.data.materials.new(name="Steel")
blade_mat.use_nodes = True
nodes = blade_mat.node_tree.nodes
links = blade_mat.node_tree.links
nodes.clear()

# Add texture coordinate
texcoord = nodes.new(type='ShaderNodeTexCoord')
texcoord.location = (-800, 0)

# Add noise for scratches
noise = nodes.new(type='ShaderNodeTexNoise')
noise.location = (-600, 100)
noise.inputs['Scale'].default_value = 150.0
noise.inputs['Detail'].default_value = 8.0
noise.inputs['Roughness'].default_value = 0.7

# ColorRamp for scratch intensity
colorramp = nodes.new(type='ShaderNodeValToRGB')
colorramp.location = (-400, 100)
colorramp.color_ramp.elements[0].position = 0.45
colorramp.color_ramp.elements[1].position = 0.55

# Mix for roughness variation
mix_rough = nodes.new(type='ShaderNodeMix')
mix_rough.location = (-200, 100)
mix_rough.data_type = 'FLOAT'
mix_rough.inputs[6].default_value = 0.15
mix_rough.inputs[7].default_value = 0.35

bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
bsdf.location = (0, 0)
bsdf.inputs['Base Color'].default_value = (0.82, 0.84, 0.87, 1.0)
bsdf.inputs['Metallic'].default_value = 1.0
bsdf.inputs['Specular IOR Level'].default_value = 0.5
bsdf.inputs['Anisotropic'].default_value = 0.3

output = nodes.new(type='ShaderNodeOutputMaterial')
output.location = (300, 0)

links.new(texcoord.outputs['Object'], noise.inputs['Vector'])
links.new(noise.outputs['Fac'], colorramp.inputs['Fac'])
links.new(colorramp.outputs['Color'], mix_rough.inputs['Factor'])
links.new(mix_rough.outputs[2], bsdf.inputs['Roughness'])
links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

blade.data.materials.append(blade_mat)

# Create ornate guard base - curved swept design
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, -0.05))
guard = bpy.context.active_object
guard.name = "Guard"
guard.scale = (0.12, 0.6, 0.06)
bpy.ops.object.transform_apply(scale=True)

bpy.ops.object.mode_set(mode='EDIT')
bm = bmesh.from_edit_mesh(guard.data)

# Curve the guard ends upward
for v in bm.verts:
    y_factor = abs(v.co.y)
    if y_factor > 0.2:
        v.co.z += (y_factor - 0.2) * 0.4
        curve_scale = 1.0 + (y_factor - 0.2) * 0.3
        v.co.x *= curve_scale

bmesh.update_edit_mesh(guard.data)
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.subdivide(number_cuts=2)
bpy.ops.mesh.bevel(offset=0.015, segments=4)
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()

# Guard material - realistic brass with patina variation
gold_mat = bpy.data.materials.new(name="Brass")
gold_mat.use_nodes = True
nodes = gold_mat.node_tree.nodes
links = gold_mat.node_tree.links
nodes.clear()

texcoord = nodes.new(type='ShaderNodeTexCoord')
texcoord.location = (-600, 0)

noise = nodes.new(type='ShaderNodeTexNoise')
noise.location = (-400, 100)
noise.inputs['Scale'].default_value = 8.0

colorramp = nodes.new(type='ShaderNodeValToRGB')
colorramp.location = (-200, 100)
colorramp.color_ramp.elements[0].color = (0.70, 0.48, 0.18, 1.0)
colorramp.color_ramp.elements[1].color = (0.82, 0.64, 0.28, 1.0)

bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
bsdf.location = (0, 0)
bsdf.inputs['Metallic'].default_value = 1.0
bsdf.inputs['Roughness'].default_value = 0.4
bsdf.inputs['Specular IOR Level'].default_value = 0.5

output = nodes.new(type='ShaderNodeOutputMaterial')
output.location = (300, 0)

links.new(texcoord.outputs['Object'], noise.inputs['Vector'])
links.new(noise.outputs['Fac'], colorramp.inputs['Fac'])
links.new(colorramp.outputs['Color'], bsdf.inputs['Base Color'])
links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

guard.data.materials.append(gold_mat)

# Add ornamental guard rings
for side in [-1, 1]:
    bpy.ops.mesh.primitive_torus_add(major_radius=0.08, minor_radius=0.012, location=(0, side * 0.28, -0.05))
    ring = bpy.context.active_object
    ring.name = f"GuardRing{side}"
    ring.rotation_euler = (0, math.radians(90), 0)
    bpy.ops.object.transform_apply(rotation=True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.shade_smooth()
    ring.data.materials.append(gold_mat)

# Add decorative guard spheres
for y_pos in [-0.35, -0.15, 0.15, 0.35]:
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=8, radius=0.025, location=(0, y_pos, -0.05))
    sphere = bpy.context.active_object
    sphere.name = f"GuardSphere_{y_pos}"
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.shade_smooth()
    sphere.data.materials.append(gold_mat)

# Add ornate quillon blocks
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

# Grip material - realistic worn leather with normal detail
leather_mat = bpy.data.materials.new(name="Leather")
leather_mat.use_nodes = True
nodes = leather_mat.node_tree.nodes
links = leather_mat.node_tree.links
nodes.clear()

texcoord = nodes.new(type='ShaderNodeTexCoord')
texcoord.location = (-800, 0)

noise1 = nodes.new(type='ShaderNodeTexNoise')
noise1.location = (-600, 200)
noise1.inputs['Scale'].default_value = 40.0
noise1.inputs['Detail'].default_value = 5.0

noise2 = nodes.new(type='ShaderNodeTexNoise')
noise2.location = (-600, -100)
noise2.inputs['Scale'].default_value = 5.0

colorramp = nodes.new(type='ShaderNodeValToRGB')
colorramp.location = (-400, 200)
colorramp.color_ramp.elements[0].color = (0.18, 0.10, 0.06, 1.0)
colorramp.color_ramp.elements[1].color = (0.28, 0.18, 0.12, 1.0)

bump = nodes.new(type='ShaderNodeBump')
bump.location = (-200, -100)
bump.inputs['Strength'].default_value = 0.3

bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
bsdf.location = (0, 0)
bsdf.inputs['Metallic'].default_value = 0.0
bsdf.inputs['Roughness'].default_value = 0.9
bsdf.inputs['Specular IOR Level'].default_value = 0.25
bsdf.inputs['Subsurface Weight'].default_value = 0.08
bsdf.inputs['Subsurface Radius'].default_value = (0.3, 0.15, 0.08)

output = nodes.new(type='ShaderNodeOutputMaterial')
output.location = (300, 0)

links.new(texcoord.outputs['Object'], noise1.inputs['Vector'])
links.new(texcoord.outputs['Object'], noise2.inputs['Vector'])
links.new(noise1.outputs['Fac'], colorramp.inputs['Fac'])
links.new(colorramp.outputs['Color'], bsdf.inputs['Base Color'])
links.new(noise2.outputs['Fac'], bump.inputs['Height'])
links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

grip.data.materials.append(leather_mat)

# Create ornate pommel
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

# Pommel material - same realistic brass
pommel.data.materials.append(gold_mat)

# Add pommel decoration ring
bpy.ops.mesh.primitive_torus_add(major_radius=0.065, minor_radius=0.01, location=(0, 0, -0.72))
pommel_ring = bpy.context.active_object
pommel_ring.name = "PommelRing"
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()
pommel_ring.data.materials.append(gold_mat)

# Setup realistic lighting - three-point lighting
bpy.ops.object.light_add(type='SUN', location=(5, -3, 10))
key_light = bpy.context.active_object
key_light.name = "KeyLight"
key_light.data.energy = 3.5
key_light.data.angle = math.radians(5)
key_light.rotation_euler = (math.radians(45), 0, math.radians(30))

bpy.ops.object.light_add(type='AREA', location=(-3, 2, 5))
fill_light = bpy.context.active_object
fill_light.name = "FillLight"
fill_light.data.energy = 150
fill_light.data.size = 2.0
fill_light.rotation_euler = (math.radians(60), 0, math.radians(-45))

bpy.ops.object.light_add(type='SPOT', location=(2, -4, 2))
rim_light = bpy.context.active_object
rim_light.name = "RimLight"
rim_light.data.energy = 200
rim_light.data.spot_size = math.radians(60)
rim_light.data.spot_blend = 0.3
rim_light.rotation_euler = (math.radians(80), 0, math.radians(45))

# Add camera
bpy.ops.object.camera_add(location=(2, -2, 1.5))
camera = bpy.context.active_object
camera.rotation_euler = (math.radians(75), 0, math.radians(45))
bpy.context.scene.camera = camera

# Enable scene world lighting
world = bpy.context.scene.world
world.use_nodes = True
world_nodes = world.node_tree.nodes
world_links = world.node_tree.links
world_nodes.clear()

bg = world_nodes.new(type='ShaderNodeBackground')
bg.inputs['Color'].default_value = (0.05, 0.05, 0.08, 1.0)
bg.inputs['Strength'].default_value = 0.3

world_output = world_nodes.new(type='ShaderNodeOutputWorld')
world_links.new(bg.outputs['Background'], world_output.inputs['Surface'])

# Export
output_path = "C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/meshes/sword_1775405640144.glb"
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