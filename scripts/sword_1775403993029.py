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
blade.scale = (0.05, 0.18, 2.0)
bpy.ops.object.transform_apply(scale=True)

# Add fuller groove detail
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='DESELECT')
bpy.ops.object.mode_set(mode='OBJECT')

# Create fuller indentation and normal sword point
for v in blade.data.vertices:
    dist_from_center = abs(v.co.y)
    if dist_from_center < 0.05 and v.co.z > 0.2 and v.co.z < 1.6:
        v.co.x *= 0.85
    # Normal sword point taper
    if v.co.z > 1.6:
        taper = (v.co.z - 1.6) / 0.4
        v.co.x *= (1.0 - taper * 0.98)
        v.co.y *= (1.0 - taper * 0.98)

bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.subdivide(number_cuts=2)
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()

# Add edge wear modifier
subsurf_blade = blade.modifiers.new(name="Subsurf", type='SUBSURF')
subsurf_blade.levels = 1
subsurf_blade.render_levels = 2

# Realistic steel blade material
blade_mat = bpy.data.materials.new(name="Steel")
blade_mat.use_nodes = True
nodes = blade_mat.node_tree.nodes
nodes.clear()
bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
bsdf.location = (0, 0)
bsdf.inputs['Base Color'].default_value = (0.75, 0.76, 0.78, 1.0)
bsdf.inputs['Metallic'].default_value = 1.0
bsdf.inputs['Roughness'].default_value = 0.25
bsdf.inputs['Specular IOR Level'].default_value = 0.5
bsdf.inputs['Anisotropic'].default_value = 0.3

# Add scratches texture
noise_tex = nodes.new(type='ShaderNodeTexNoise')
noise_tex.location = (-600, 0)
noise_tex.inputs['Scale'].default_value = 50.0
noise_tex.inputs['Detail'].default_value = 8.0

color_ramp = nodes.new(type='ShaderNodeValToRGB')
color_ramp.location = (-400, 0)
color_ramp.color_ramp.elements[0].position = 0.48
color_ramp.color_ramp.elements[1].position = 0.52

mix_roughness = nodes.new(type='ShaderNodeMix')
mix_roughness.location = (-200, -100)
mix_roughness.data_type = 'RGBA'
mix_roughness.inputs[6].default_value = (0.25, 0.25, 0.25, 1.0)
mix_roughness.inputs[7].default_value = (0.6, 0.6, 0.6, 1.0)

output = nodes.new(type='ShaderNodeOutputMaterial')
output.location = (300, 0)

blade_mat.node_tree.links.new(noise_tex.outputs['Fac'], color_ramp.inputs['Fac'])
blade_mat.node_tree.links.new(color_ramp.outputs['Color'], mix_roughness.inputs['Factor'])
blade_mat.node_tree.links.new(mix_roughness.outputs[2], bsdf.inputs['Roughness'])
blade_mat.node_tree.links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

blade.data.materials.append(blade_mat)

# Create realistic guard - crossguard style
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, -0.05))
guard = bpy.context.active_object
guard.name = "Guard"
guard.scale = (0.1, 0.55, 0.06)
bpy.ops.object.transform_apply(scale=True)

bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.subdivide(number_cuts=1)
bpy.ops.mesh.bevel(offset=0.012, segments=4)
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')

# Curve guard ends upward
for v in guard.data.vertices:
    if abs(v.co.y) > 0.2:
        curve_factor = (abs(v.co.y) - 0.2) / 0.35
        v.co.z += curve_factor * 0.08

bpy.ops.object.shade_smooth()

subsurf_guard = guard.modifiers.new(name="Subsurf", type='SUBSURF')
subsurf_guard.levels = 1

# Realistic brass/bronze guard material
brass_mat = bpy.data.materials.new(name="Brass")
brass_mat.use_nodes = True
nodes = brass_mat.node_tree.nodes
nodes.clear()
bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
bsdf.inputs['Base Color'].default_value = (0.72, 0.55, 0.26, 1.0)
bsdf.inputs['Metallic'].default_value = 1.0
bsdf.inputs['Roughness'].default_value = 0.35
bsdf.inputs['Specular IOR Level'].default_value = 0.5
output = nodes.new(type='ShaderNodeOutputMaterial')
brass_mat.node_tree.links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])
guard.data.materials.append(brass_mat)

# Create realistic wrapped leather grip
bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=0.045, depth=0.65, location=(0, 0, -0.425))
grip = bpy.context.active_object
grip.name = "Grip"

bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.subdivide(number_cuts=12)
bpy.ops.object.mode_set(mode='OBJECT')

# Add realistic leather wrap pattern
for i, v in enumerate(grip.data.vertices):
    height = v.co.z
    angle = math.atan2(v.co.y, v.co.x)
    wrap_offset = math.sin(height * 20 + angle * 8) * 0.004
    diamond_pattern = abs(math.sin(height * 15)) * abs(math.sin(angle * 12)) * 0.003
    v.co.x *= (1 + wrap_offset + diamond_pattern)
    v.co.y *= (1 + wrap_offset + diamond_pattern)
    
    # Slight taper toward pommel
    if height < -0.5:
        taper = abs(height + 0.5) / 0.2
        v.co.x *= (1 - taper * 0.1)
        v.co.y *= (1 - taper * 0.1)

bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()

subsurf_grip = grip.modifiers.new(name="Subsurf", type='SUBSURF')
subsurf_grip.levels = 2

# Realistic leather material
leather_mat = bpy.data.materials.new(name="Leather")
leather_mat.use_nodes = True
nodes = leather_mat.node_tree.nodes
nodes.clear()
bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
bsdf.inputs['Base Color'].default_value = (0.25, 0.15, 0.08, 1.0)
bsdf.inputs['Metallic'].default_value = 0.0
bsdf.inputs['Roughness'].default_value = 0.85
bsdf.inputs['Sheen Weight'].default_value = 0.2
bsdf.inputs['Subsurface Weight'].default_value = 0.05
bsdf.inputs['Subsurface Radius'].default_value = (0.8, 0.5, 0.3)
output = nodes.new(type='ShaderNodeOutputMaterial')
leather_mat.node_tree.links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])
grip.data.materials.append(leather_mat)

# Create realistic pommel
bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.07, depth=0.08, location=(0, 0, -0.785))
pommel = bpy.context.active_object
pommel.name = "Pommel"

bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.bevel(offset=0.01, segments=3)
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')

# Add decorative facets
for v in pommel.data.vertices:
    if v.co.z > 0.03 or v.co.z < -0.03:
        dist = math.sqrt(v.co.x**2 + v.co.y**2)
        if dist > 0.04:
            angle = math.atan2(v.co.y, v.co.x)
            facet = abs(math.sin(angle * 8)) * 0.008
            v.co.x *= (1 - facet)
            v.co.y *= (1 - facet)

bpy.ops.object.shade_smooth()

subsurf_pommel = pommel.modifiers.new(name="Subsurf", type='SUBSURF')
subsurf_pommel.levels = 2

pommel.data.materials.append(brass_mat)

# Add wire wrap detail on grip ends
bpy.ops.mesh.primitive_torus_add(major_radius=0.048, minor_radius=0.006, location=(0, 0, -0.12))
wire1 = bpy.context.active_object
wire1.name = "WireWrap1"
bpy.ops.object.shade_smooth()
wire1.data.materials.append(brass_mat)

bpy.ops.mesh.primitive_torus_add(major_radius=0.048, minor_radius=0.006, location=(0, 0, -0.73))
wire2 = bpy.context.active_object
wire2.name = "WireWrap2"
bpy.ops.object.shade_smooth()
wire2.data.materials.append(brass_mat)

# Add light setup for realism
bpy.ops.object.light_add(type='SUN', location=(5, 5, 10))
light = bpy.context.active_object
light.data.energy = 1.8
light.data.angle = math.radians(5)
light.rotation_euler = (math.radians(45), 0, math.radians(30))

bpy.ops.object.light_add(type='AREA', location=(-3, -3, 5))
fill_light = bpy.context.active_object
fill_light.data.energy = 150
fill_light.data.size = 5.0
fill_light.rotation_euler = (math.radians(60), 0, math.radians(-45))

# Camera
bpy.ops.object.camera_add(location=(2.2, -2.2, 1.3))
camera = bpy.context.active_object
camera.rotation_euler = (math.radians(78), 0, math.radians(45))
camera.data.lens = 85
bpy.context.scene.camera = camera

# Enable realistic rendering
bpy.context.scene.render.engine = 'CYCLES'
bpy.context.scene.cycles.samples = 128

output_path = "C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/meshes/sword_1775403993029.glb"
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