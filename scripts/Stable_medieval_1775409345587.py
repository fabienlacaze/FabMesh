import bpy
import bmesh
import math

# Clear default scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

# Remove orphan data
for mesh in bpy.data.meshes:
    bpy.data.meshes.remove(mesh)
for mat in bpy.data.materials:
    bpy.data.materials.remove(mat)

# Import original mesh
bpy.ops.import_scene.fbx(filepath="C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/history/Stable_medieval/v0_Stable_medieval_1775405588354.fbx")

# Get imported objects and find the bounding box of the whole scene
imported_objects = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']

# Calculate overall bounding box of the imported model
min_x, min_y, min_z = float('inf'), float('inf'), float('inf')
max_x, max_y, max_z = float('-inf'), float('-inf'), float('-inf')

for obj in imported_objects:
    for corner in obj.bound_box:
        world_corner = obj.matrix_world @ mathutils.Vector(corner)
        min_x = min(min_x, world_corner.x)
        min_y = min(min_y, world_corner.y)
        min_z = min(min_z, world_corner.z)
        max_x = max(max_x, world_corner.x)
        max_y = max(max_y, world_corner.y)
        max_z = max(max_z, world_corner.z)

import mathutils

# Recalculate with mathutils imported
min_x, min_y, min_z = float('inf'), float('inf'), float('inf')
max_x, max_y, max_z = float('-inf'), float('-inf'), float('-inf')

for obj in imported_objects:
    for corner in obj.bound_box:
        world_corner = obj.matrix_world @ mathutils.Vector(corner)
        min_x = min(min_x, world_corner.x)
        min_y = min(min_y, world_corner.y)
        min_z = min(min_z, world_corner.z)
        max_x = max(max_x, world_corner.x)
        max_y = max(max_y, world_corner.y)
        max_z = max(max_z, world_corner.z)

model_width = max_x - min_x
model_depth = max_y - min_y
model_height = max_z - min_z
center_x = (min_x + max_x) / 2
center_y = (min_y + max_y) / 2

# Chimney dimensions proportional to the building
chimney_width = model_width * 0.08
chimney_depth = model_depth * 0.08
chimney_height = model_height * 0.3

# Position chimney on the roof - offset from center toward one side
chimney_x = center_x + model_width * 0.2
chimney_y = center_y - model_depth * 0.15
chimney_z = max_z + chimney_height / 2 - chimney_height * 0.1  # Slightly embedded in roof

# --- Create chimney base (main shaft) ---
bpy.ops.mesh.primitive_cube_add(size=1, location=(chimney_x, chimney_y, chimney_z))
chimney_base = bpy.context.active_object
chimney_base.name = "Chimney_Base"
chimney_base.scale = (chimney_width, chimney_depth, chimney_height)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

# Edit chimney base to add slight taper at top using bmesh
bm = bmesh.new()
bm.from_mesh(chimney_base.data)
bm.faces.ensure_lookup_table()
bm.verts.ensure_lookup_table()

# Find top vertices (highest z) and scale them slightly inward for a subtle taper
top_z = max(v.co.z for v in bm.verts)
for v in bm.verts:
    if abs(v.co.z - top_z) < 0.001:
        v.co.x *= 0.92
        v.co.y *= 0.92

bm.to_mesh(chimney_base.data)
bm.free()

# Recalculate normals
bpy.ops.object.select_all(action='DESELECT')
chimney_base.select_set(True)
bpy.context.view_layer.objects.active = chimney_base
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')

# --- Create chimney cap (wider rim at top) ---
cap_height = chimney_height * 0.08
cap_z = chimney_z + chimney_height / 2 + cap_height / 2 - chimney_height * 0.02

bpy.ops.mesh.primitive_cube_add(size=1, location=(chimney_x, chimney_y, cap_z))
chimney_cap = bpy.context.active_object
chimney_cap.name = "Chimney_Cap"
chimney_cap.scale = (chimney_width * 1.2, chimney_depth * 1.2, cap_height)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

# Recalculate normals for cap
bpy.ops.object.select_all(action='DESELECT')
chimney_cap.select_set(True)
bpy.context.view_layer.objects.active = chimney_cap
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')

# --- Create chimney opening (hollow top) ---
# Create inner cube to boolean-subtract from chimney cap area
inner_height = cap_height * 2
inner_z = cap_z

bpy.ops.mesh.primitive_cube_add(size=1, location=(chimney_x, chimney_y, inner_z))
chimney_inner = bpy.context.active_object
chimney_inner.name = "Chimney_Inner_Cut"
chimney_inner.scale = (chimney_width * 0.7, chimney_depth * 0.7, inner_height)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

# Boolean difference on chimney base to create hollow top
bool_mod = chimney_base.modifiers.new(name="Hollow", type='BOOLEAN')
bool_mod.operation = 'DIFFERENCE'
bool_mod.object = chimney_inner

bpy.ops.object.select_all(action='DESELECT')
chimney_base.select_set(True)
bpy.context.view_layer.objects.active = chimney_base
bpy.ops.object.modifier_apply(modifier="Hollow")

# Also boolean on cap
bool_mod2 = chimney_cap.modifiers.new(name="Hollow", type='BOOLEAN')
bool_mod2.operation = 'DIFFERENCE'
bool_mod2.object = chimney_inner

bpy.ops.object.select_all(action='DESELECT')
chimney_cap.select_set(True)
bpy.context.view_layer.objects.active = chimney_cap
bpy.ops.object.modifier_apply(modifier="Hollow")

# Delete the inner cut object
bpy.ops.object.select_all(action='DESELECT')
chimney_inner.select_set(True)
bpy.ops.object.delete(use_global=False)

# --- Create chimney material (stone/brick look) ---
chimney_mat = bpy.data.materials.new(name="Chimney_Stone")
chimney_mat.use_nodes = True
nodes = chimney_mat.node_tree.nodes
links = chimney_mat.node_tree.links

# Clear default nodes
for node in nodes:
    nodes.remove(node)

# Create Principled BSDF
bsdf = nodes.new('ShaderNodeBsdfPrincipled')
bsdf.location = (0, 0)
bsdf.inputs['Base Color'].default_value = (0.35, 0.25, 0.18, 1.0)  # Dark stone/brick color
bsdf.inputs['Roughness'].default_value = 0.85
bsdf.inputs['Specular IOR Level'].default_value = 0.15

# Add texture coordinate and noise for variation
tex_coord = nodes.new('ShaderNodeTexCoord')
tex_coord.location = (-600, 0)

mapping = nodes.new('ShaderNodeMapping')
mapping.location = (-400, 0)
mapping.inputs['Scale'].default_value = (8.0, 8.0, 4.0)

noise = nodes.new('ShaderNodeTexNoise')
noise.location = (-200, 100)
noise.inputs['Scale'].default_value = 12.0
noise.inputs['Detail'].default_value = 6.0

color_ramp = nodes.new('ShaderNodeValToRGB')
color_ramp.location = (-50, 100)
color_ramp.color_ramp.elements[0].color = (0.25, 0.17, 0.12, 1.0)
color_ramp.color_ramp.elements[1].color = (0.45, 0.32, 0.22, 1.0)

mix_color = nodes.new('ShaderNodeMix')
mix_color.data_type = 'RGBA'
mix_color.location = (200, 100)
mix_color.inputs['Factor'].default_value = 0.5

output = nodes.new('ShaderNodeOutputMaterial')
output.location = (400, 0)

links.new(tex_coord.outputs['Object'], mapping.inputs['Vector'])
links.new(mapping.outputs['Vector'], noise.inputs['Vector'])
links.new(noise.outputs['Fac'], color_ramp.inputs['Fac'])
links.new(color_ramp.outputs['Color'], bsdf.inputs['Base Color'])
links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

# Apply material to chimney parts
chimney_base.data.materials.append(chimney_mat)
chimney_cap.data.materials.append(chimney_mat)

# --- Create soot/smoke stain at top (darker cap material) ---
soot_mat = bpy.data.materials.new(name="Chimney_Soot")
soot_mat.use_nodes = True
soot_nodes = soot_mat.node_tree.nodes
soot_links = soot_mat.node_tree.links

for node in soot_nodes:
    soot_nodes.remove(node)

soot_bsdf = soot_nodes.new('ShaderNodeBsdfPrincipled')
soot_bsdf.inputs['Base Color'].default_value = (0.2, 0.15, 0.1, 1.0)
soot_bsdf.inputs['Roughness'].default_value = 0.95

soot_output = soot_nodes.new('ShaderNodeOutputMaterial')
soot_links.new(soot_bsdf.outputs['BSDF'], soot_output.inputs['Surface'])

chimney_cap.data.materials.clear()
chimney_cap.data.materials.append(soot_mat)

# --- Shade smooth on chimney parts ---
for obj in [chimney_base, chimney_cap]:
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.shade_smooth()

# --- Join chimney parts into one object ---
bpy.ops.object.select_all(action='DESELECT')
chimney_base.select_set(True)
chimney_cap.select_set(True)
bpy.context.view_layer.objects.active = chimney_base
bpy.ops.object.join()
chimney_base.name = "Chimney"

# Final normals recalculation
bpy.ops.object.select_all(action='DESELECT')
chimney_base.select_set(True)
bpy.context.view_layer.objects.active = chimney_base
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')

# Select all objects for export
bpy.ops.object.select_all(action='SELECT')

# Export
output_path = "C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/meshes/Stable_medieval_1775409345587.glb"
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