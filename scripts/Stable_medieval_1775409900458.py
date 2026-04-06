import bpy
import bmesh
import math

# Clear default scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

for col in bpy.data.collections:
    bpy.data.collections.remove(col)

# Import the original mesh
bpy.ops.import_scene.fbx(filepath="C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/history/Stable_medieval/v0_Stable_medieval_1775405588354.fbx")

# Get imported objects and compute bounding box to place chimney correctly
imported_objects = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']

# Compute overall bounding box of the imported scene
min_x, min_y, min_z = float('inf'), float('inf'), float('inf')
max_x, max_y, max_z = float('-inf'), float('-inf'), float('-inf')

for obj in imported_objects:
    for corner in obj.bound_box:
        world_corner = obj.matrix_world @ __import__('mathutils').Vector(corner)
        min_x = min(min_x, world_corner.x)
        min_y = min(min_y, world_corner.y)
        min_z = min(min_z, world_corner.z)
        max_x = max(max_x, world_corner.x)
        max_y = max(max_y, world_corner.y)
        max_z = max(max_z, world_corner.z)

size_x = max_x - min_x
size_y = max_y - min_y
size_z = max_z - min_z
center_x = (min_x + max_x) / 2
center_y = (min_y + max_y) / 2

# Chimney dimensions proportional to the building
chimney_width = size_x * 0.08
chimney_depth = size_y * 0.08
chimney_height = size_z * 0.35

# Position chimney on the roof, slightly off-center
chimney_x = center_x + size_x * 0.15
chimney_y = center_y + size_y * 0.1
chimney_z = max_z + chimney_height * 0.3  # Sits partially into the roof

# --- Create chimney body (brick stack) ---
bpy.ops.mesh.primitive_cube_add(size=1, location=(chimney_x, chimney_y, chimney_z))
chimney_body = bpy.context.active_object
chimney_body.name = "Chimney_Body"
chimney_body.scale = (chimney_width, chimney_depth, chimney_height)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

# Add slight bevel for realism
bevel_mod = chimney_body.modifiers.new(name="Bevel", type='BEVEL')
bevel_mod.width = chimney_width * 0.03
bevel_mod.segments = 2
bpy.ops.object.modifier_apply(modifier="Bevel")

# Shade smooth
bpy.ops.object.shade_smooth()

# Create brick/stone material for chimney body
brick_mat = bpy.data.materials.new(name="Chimney_Brick")
brick_mat.use_nodes = True
nodes = brick_mat.node_tree.nodes
links = brick_mat.node_tree.links
nodes.clear()

# Principled BSDF
principled = nodes.new('ShaderNodeBsdfPrincipled')
principled.location = (0, 0)
principled.inputs['Base Color'].default_value = (0.25, 0.12, 0.08, 1.0)  # Dark reddish-brown brick
principled.inputs['Roughness'].default_value = 0.85
principled.inputs['Metallic'].default_value = 0.0
principled.inputs['Specular IOR Level'].default_value = 0.3

# Add brick texture procedurally
tex_coord = nodes.new('ShaderNodeTexCoord')
tex_coord.location = (-800, 0)

mapping = nodes.new('ShaderNodeMapping')
mapping.location = (-600, 0)
mapping.inputs['Scale'].default_value = (4.0, 8.0, 4.0)

brick_tex = nodes.new('ShaderNodeTexBrick')
brick_tex.location = (-350, 0)
brick_tex.inputs['Color1'].default_value = (0.28, 0.13, 0.09, 1.0)
brick_tex.inputs['Color2'].default_value = (0.22, 0.10, 0.07, 1.0)
brick_tex.inputs['Mortar'].default_value = (0.5, 0.45, 0.4, 1.0)
brick_tex.inputs['Scale'].default_value = 6.0
brick_tex.inputs['Mortar Size'].default_value = 0.02

# Mix brick color with base
mix_color = nodes.new('ShaderNodeMix')
mix_color.data_type = 'RGBA'
mix_color.location = (-150, 0)
mix_color.inputs['Factor'].default_value = 0.8

output = nodes.new('ShaderNodeOutputMaterial')
output.location = (300, 0)

links.new(tex_coord.outputs['Object'], mapping.inputs['Vector'])
links.new(mapping.outputs['Vector'], brick_tex.inputs['Vector'])
links.new(brick_tex.outputs['Color'], mix_color.inputs[6])  # A input for RGBA
mix_color.inputs[7].default_value = (0.25, 0.12, 0.08, 1.0)  # B input
links.new(mix_color.outputs[2], principled.inputs['Base Color'])  # Result RGBA output
links.new(brick_tex.outputs['Fac'], principled.inputs['Roughness'])
links.new(principled.outputs['BSDF'], output.inputs['Surface'])

# Bump from brick pattern
bump = nodes.new('ShaderNodeBump')
bump.location = (-150, -200)
bump.inputs['Strength'].default_value = 0.3
links.new(brick_tex.outputs['Fac'], bump.inputs['Height'])
links.new(bump.outputs['Normal'], principled.inputs['Normal'])

chimney_body.data.materials.append(brick_mat)

# --- Create chimney cap (stone top ledge) ---
cap_height = chimney_height * 0.08
cap_z = chimney_z + chimney_height * 0.5 + cap_height * 0.5

bpy.ops.mesh.primitive_cube_add(size=1, location=(chimney_x, chimney_y, cap_z))
chimney_cap = bpy.context.active_object
chimney_cap.name = "Chimney_Cap"
chimney_cap.scale = (chimney_width * 1.15, chimney_depth * 1.15, cap_height)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

cap_bevel = chimney_cap.modifiers.new(name="Bevel", type='BEVEL')
cap_bevel.width = chimney_width * 0.04
cap_bevel.segments = 2
bpy.ops.object.modifier_apply(modifier="Bevel")
bpy.ops.object.shade_smooth()

# Stone cap material
stone_mat = bpy.data.materials.new(name="Chimney_Stone_Cap")
stone_mat.use_nodes = True
snodes = stone_mat.node_tree.nodes
slinks = stone_mat.node_tree.links
snodes.clear()

s_principled = snodes.new('ShaderNodeBsdfPrincipled')
s_principled.location = (0, 0)
s_principled.inputs['Base Color'].default_value = (0.35, 0.30, 0.25, 1.0)  # Grey-brown stone
s_principled.inputs['Roughness'].default_value = 0.9
s_principled.inputs['Metallic'].default_value = 0.0

s_output = snodes.new('ShaderNodeOutputMaterial')
s_output.location = (300, 0)
slinks.new(s_principled.outputs['BSDF'], s_output.inputs['Surface'])

# Add noise for stone texture variation
s_texcoord = snodes.new('ShaderNodeTexCoord')
s_texcoord.location = (-500, 0)
s_noise = snodes.new('ShaderNodeTexNoise')
s_noise.location = (-300, 0)
s_noise.inputs['Scale'].default_value = 15.0
s_noise.inputs['Detail'].default_value = 8.0

s_colorramp = snodes.new('ShaderNodeValToRGB')
s_colorramp.location = (-100, 100)
s_colorramp.color_ramp.elements[0].color = (0.30, 0.25, 0.20, 1.0)
s_colorramp.color_ramp.elements[1].color = (0.40, 0.35, 0.30, 1.0)

slinks.new(s_texcoord.outputs['Object'], s_noise.inputs['Vector'])
slinks.new(s_noise.outputs['Fac'], s_colorramp.inputs['Fac'])
slinks.new(s_colorramp.outputs['Color'], s_principled.inputs['Base Color'])

# Bump for stone
s_bump = snodes.new('ShaderNodeBump')
s_bump.location = (-100, -200)
s_bump.inputs['Strength'].default_value = 0.2
slinks.new(s_noise.outputs['Fac'], s_bump.inputs['Height'])
slinks.new(s_bump.outputs['Normal'], s_principled.inputs['Normal'])

chimney_cap.data.materials.append(stone_mat)

# --- Create chimney opening (hollow inside at the top) ---
inner_z = cap_z + cap_height * 0.1
bpy.ops.mesh.primitive_cylinder_add(
    radius=chimney_width * 0.35,
    depth=cap_height * 1.5,
    vertices=8,
    location=(chimney_x, chimney_y, inner_z)
)
chimney_hole = bpy.context.active_object
chimney_hole.name = "Chimney_Inner"
bpy.ops.object.shade_smooth()

# Dark interior material
dark_mat = bpy.data.materials.new(name="Chimney_Interior")
dark_mat.use_nodes = True
dnodes = dark_mat.node_tree.nodes
dlinks = dark_mat.node_tree.links
dnodes.clear()

d_principled = dnodes.new('ShaderNodeBsdfPrincipled')
d_principled.location = (0, 0)
d_principled.inputs['Base Color'].default_value = (0.02, 0.02, 0.02, 1.0)  # Very dark soot
d_principled.inputs['Roughness'].default_value = 1.0
d_principled.inputs['Metallic'].default_value = 0.0

d_output = dnodes.new('ShaderNodeOutputMaterial')
d_output.location = (300, 0)
dlinks.new(d_principled.outputs['BSDF'], d_output.inputs['Surface'])

chimney_hole.data.materials.append(dark_mat)

# --- Create a small chimney base (wider base where it meets the roof) ---
base_height = chimney_height * 0.15
base_z = chimney_z - chimney_height * 0.5 + base_height * 0.3

bpy.ops.mesh.primitive_cube_add(size=1, location=(chimney_x, chimney_y, base_z))
chimney_base = bpy.context.active_object
chimney_base.name = "Chimney_Base"
chimney_base.scale = (chimney_width * 1.25, chimney_depth * 1.25, base_height)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

base_bevel = chimney_base.modifiers.new(name="Bevel", type='BEVEL')
base_bevel.width = chimney_width * 0.03
base_bevel.segments = 2
bpy.ops.object.modifier_apply(modifier="Bevel")
bpy.ops.object.shade_smooth()

# Reuse brick material for base
chimney_base.data.materials.append(brick_mat)

# --- Recalculate normals for all chimney parts ---
chimney_parts = [chimney_body, chimney_cap, chimney_hole, chimney_base]
for part in chimney_parts:
    bpy.context.view_layer.objects.active = part
    bpy.ops.object.select_all(action='DESELECT')
    part.select_set(True)
    bpy.ops.object.editmode_toggle()
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.editmode_toggle()

# Select all objects for export
bpy.ops.object.select_all(action='SELECT')

# Export
bpy.ops.file.pack_all()
output_path = "C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/meshes/Stable_medieval_1775409900458.glb"
if output_path.endswith('.glb') or output_path.endswith('.gltf'):
    fmt = 'GLB' if output_path.endswith('.glb') else 'GLTF_SEPARATE'
    bpy.ops.export_scene.gltf(filepath=output_path, export_format=fmt, export_image_format='AUTO')
elif output_path.endswith('.obj'):
    bpy.ops.wm.obj_export(filepath=output_path)
elif output_path.endswith('.fbx'):
    bpy.ops.export_scene.fbx(filepath=output_path)
elif output_path.endswith('.stl'):
    bpy.ops.export_mesh.stl(filepath=output_path)
print("FABMESH_SUCCESS")