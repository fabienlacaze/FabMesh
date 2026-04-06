import bpy
import bmesh
import math
from mathutils import Vector

# Clear scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

# Create blade - realistic proportions
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.75))
blade = bpy.context.active_object
blade.name = "Blade"
blade.scale = (0.045, 0.18, 2.0)
bpy.ops.object.transform_apply(scale=True)

# Create realistic blade taper and fuller
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='DESELECT')
bpy.ops.object.mode_set(mode='OBJECT')

# Taper blade to sharp point
for v in blade.data.vertices:
    if v.co.z > 1.85:
        v.co.x *= 0.01
        v.co.y *= 0.01
    elif v.co.z > 1.5:
        factor = (v.co.z - 1.5) / 0.35
        v.co.x *= (1.0 - factor * 0.99)
        v.co.y *= (1.0 - factor * 0.99)
    elif v.co.z > 0.8:
        factor = (v.co.z - 0.8) / 0.7
        v.co.x *= (1.0 - factor * 0.15)

# Add fuller (blood groove) detail
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.subdivide(number_cuts=3)
bpy.ops.object.mode_set(mode='OBJECT')

for v in blade.data.vertices:
    if 0.1 < v.co.z < 1.5 and abs(v.co.y) < 0.08:
        v.co.x *= 0.92

bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()

# Realistic steel blade material with imperfections
blade_mat = bpy.data.materials.new(name="Steel")
blade_mat.use_nodes = True
nodes = blade_mat.node_tree.nodes
links = blade_mat.node_tree.links
nodes.clear()

bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
bsdf.location = (0, 0)
bsdf.inputs['Base Color'].default_value = (0.82, 0.83, 0.85, 1.0)
bsdf.inputs['Metallic'].default_value = 1.0
bsdf.inputs['Roughness'].default_value = 0.18
bsdf.inputs['Specular IOR Level'].default_value = 0.5
bsdf.inputs['Anisotropic'].default_value = 0.3

noise = nodes.new(type='ShaderNodeTexNoise')
noise.location = (-400, -200)
noise.inputs['Scale'].default_value = 150.0
noise.inputs['Detail'].default_value = 8.0

color_ramp = nodes.new(type='ShaderNodeValToRGB')
color_ramp.location = (-200, -200)
color_ramp.color_ramp.elements[0].position = 0.45
color_ramp.color_ramp.elements[1].position = 0.55

links.new(noise.outputs['Fac'], color_ramp.inputs['Fac'])
links.new(color_ramp.outputs['Fac'], bsdf.inputs['Roughness'])

output = nodes.new(type='ShaderNodeOutputMaterial')
output.location = (300, 0)
links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

blade.data.materials.append(blade_mat)

# Create realistic curved guard
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, -0.05))
guard = bpy.context.active_object
guard.name = "Guard"
guard.scale = (0.13, 0.65, 0.07)
bpy.ops.object.transform_apply(scale=True)

bpy.ops.object.mode_set(mode='EDIT')
bm = bmesh.from_edit_mesh(guard.data)

# Curve guard ends upward naturally
for v in bm.verts:
    y_factor = abs(v.co.y)
    if y_factor > 0.25:
        curve = (y_factor - 0.25) ** 1.3
        v.co.z += curve * 0.5
        v.co.x *= (1.0 + curve * 0.25)

bmesh.update_edit_mesh(guard.data)
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.subdivide(number_cuts=3)
bpy.ops.mesh.bevel(offset=0.012, segments=3)
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()

# Realistic aged brass/bronze material
brass_mat = bpy.data.materials.new(name="Brass")
brass_mat.use_nodes = True
nodes = brass_mat.node_tree.nodes
links = brass_mat.node_tree.links
nodes.clear()

bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
bsdf.location = (0, 0)
bsdf.inputs['Base Color'].default_value = (0.72, 0.52, 0.20, 1.0)
bsdf.inputs['Metallic'].default_value = 1.0
bsdf.inputs['Roughness'].default_value = 0.42
bsdf.inputs['Specular IOR Level'].default_value = 0.5

noise = nodes.new(type='ShaderNodeTexNoise')
noise.location = (-400, -150)
noise.inputs['Scale'].default_value = 80.0
noise.inputs['Detail'].default_value = 6.0

color_ramp = nodes.new(type='ShaderNodeValToRGB')
color_ramp.location = (-200, -150)
color_ramp.color_ramp.elements[0].position = 0.40
color_ramp.color_ramp.elements[1].position = 0.60

links.new(noise.outputs['Fac'], color_ramp.inputs['Fac'])
links.new(color_ramp.outputs['Fac'], bsdf.inputs['Roughness'])

output = nodes.new(type='ShaderNodeOutputMaterial')
output.location = (300, 0)
links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

guard.data.materials.append(brass_mat)

# Guard rings with realistic detail
for side in [-1, 1]:
    bpy.ops.mesh.primitive_torus_add(major_radius=0.085, minor_radius=0.014, location=(0, side * 0.30, -0.05))
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
    ring.data.materials.append(brass_mat)

# Decorative guard spheres
for y_pos in [-0.38, -0.16, 0.16, 0.38]:
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=12, radius=0.028, location=(0, y_pos, -0.05))
    sphere = bpy.context.active_object
    sphere.name = f"GuardSphere_{y_pos}"
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.shade_smooth()
    sphere.data.materials.append(brass_mat)

# Ornate quillon blocks
for side in [-1, 1]:
    bpy.ops.mesh.primitive_cube_add(size=0.065, location=(0, side * 0.45, -0.03))
    quillon = bpy.context.active_object
    quillon.name = f"Quillon{side}"
    quillon.scale = (1.3, 1.1, 1.6)
    quillon.rotation_euler.z = math.radians(12 * side)
    bpy.ops.object.transform_apply(scale=True, rotation=True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.bevel(offset=0.010, segments=4)
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.shade_smooth()
    quillon.data.materials.append(brass_mat)

# Realistic leather-wrapped grip
bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=0.042, depth=0.62, location=(0, 0, -0.4))
grip = bpy.context.active_object
grip.name = "Grip"

bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.subdivide(number_cuts=12)
bpy.ops.object.mode_set(mode='OBJECT')

# Add realistic grip wrapping pattern
for i, v in enumerate(grip.data.vertices):
    if abs(v.co.z) < 0.28:
        angle = math.atan2(v.co.y, v.co.x)
        wrap_offset = math.sin((v.co.z * 15) + (angle * 2)) * 0.004
        v.co.x *= (1 + wrap_offset)
        v.co.y *= (1 + wrap_offset)

bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()

subsurf = grip.modifiers.new(name="Subsurf", type='SUBSURF')
subsurf.levels = 2

# Realistic worn leather material
leather_mat = bpy.data.materials.new(name="Leather")
leather_mat.use_nodes = True
nodes = leather_mat.node_tree.nodes
links = leather_mat.node_tree.links
nodes.clear()

bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
bsdf.location = (0, 0)
bsdf.inputs['Base Color'].default_value = (0.22, 0.13, 0.08, 1.0)
bsdf.inputs['Metallic'].default_value = 0.0
bsdf.inputs['Roughness'].default_value = 0.88
bsdf.inputs['Specular IOR Level'].default_value = 0.25
bsdf.inputs['Subsurface Weight'].default_value = 0.08
bsdf.inputs['Subsurface Radius'].default_value = (0.25, 0.12, 0.06)

noise = nodes.new(type='ShaderNodeTexNoise')
noise.location = (-400, -100)
noise.inputs['Scale'].default_value = 120.0
noise.inputs['Detail'].default_value = 10.0

color_ramp = nodes.new(type='ShaderNodeValToRGB')
color_ramp.location = (-200, -100)
color_ramp.color_ramp.elements[0].position = 0.35
color_ramp.color_ramp.elements[1].position = 0.65

links.new(noise.outputs['Fac'], color_ramp.inputs['Fac'])
links.new(color_ramp.outputs['Fac'], bsdf.inputs['Roughness'])

output = nodes.new(type='ShaderNodeOutputMaterial')
output.location = (300, 0)
links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

grip.data.materials.append(leather_mat)

# Realistic pommel
bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=16, radius=0.075, location=(0, 0, -0.75))
pommel = bpy.context.active_object
pommel.name = "Pommel"
pommel.scale[2] = 0.65
bpy.ops.object.transform_apply(scale=True)

bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.subdivide(number_cuts=1)
bpy.ops.mesh.bevel(offset=0.005, segments=2)
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()

pommel.data.materials.append(brass_mat)

# Pommel decoration ring
bpy.ops.mesh.primitive_torus_add(major_radius=0.070, minor_radius=0.012, location=(0, 0, -0.72))
pommel_ring = bpy.context.active_object
pommel_ring.name = "PommelRing"
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()
pommel_ring.data.materials.append(brass_mat)

# Realistic lighting setup
bpy.ops.object.light_add(type='SUN', location=(5, 5, 10))
sun = bpy.context.active_object
sun.data.energy = 3.5
sun.rotation_euler = (math.radians(45), math.radians(25), math.radians(135))

bpy.ops.object.light_add(type='AREA', location=(-4, -3, 5))
fill = bpy.context.active_object
fill.data.energy = 150
fill.data.size = 3
fill.rotation_euler = (math.radians(60), math.radians(-30), math.radians(-45))

# Setup camera
bpy.ops.object.camera_add(location=(2.2, -2.2, 1.4))
camera = bpy.context.active_object
camera.rotation_euler = (math.radians(72), 0, math.radians(45))
camera.data.lens = 50
bpy.context.scene.camera = camera

# World environment
world = bpy.context.scene.world
world.use_nodes = True
world_nodes = world.node_tree.nodes
world_links = world.node_tree.links
bg = world_nodes['Background']
bg.inputs['Color'].default_value = (0.05, 0.05, 0.06, 1.0)
bg.inputs['Strength'].default_value = 0.4

# Export
output_path = "C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/meshes/sword_1775406274770.glb"
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