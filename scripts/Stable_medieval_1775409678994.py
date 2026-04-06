import bpy
import bmesh
import math
import mathutils

# Clear default scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

# Remove orphan data
for mesh in bpy.data.meshes:
    bpy.data.meshes.remove(mesh)
for mat in bpy.data.materials:
    bpy.data.materials.remove(mat)

# Import the original mesh
bpy.ops.import_scene.fbx(filepath="C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/history/Stable_medieval/v0_Stable_medieval_1775405588354.fbx")

# Get imported objects and find the main building bounds
imported_objects = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']

# Calculate the bounding box of the entire imported scene
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

building_width = max_x - min_x
building_depth = max_y - min_y
building_height = max_z - min_z

# Scale chimney proportionally to the building
chimney_width = building_width * 0.12
chimney_depth = building_depth * 0.12
chimney_height = building_height * 0.35

# Position chimney on the roof - offset from center toward one side
chimney_x = min_x + building_width * 0.7
chimney_y = min_y + building_depth * 0.35
chimney_z = max_z  # Top of the building

# --- Create chimney base (stone/brick body) ---
bpy.ops.mesh.primitive_cube_add(size=1, location=(chimney_x, chimney_y, chimney_z + chimney_height * 0.5))
chimney_base = bpy.context.active_object
chimney_base.name = "Chimney_Base"
chimney_base.scale = (chimney_width, chimney_depth, chimney_height)
bpy.ops.object.transform_apply(scale=True)

# Add slight bevel to chimney edges for realism
bevel_mod = chimney_base.modifiers.new(name="Bevel", type='BEVEL')
bevel_mod.width = chimney_width * 0.05
bevel_mod.segments = 2

bpy.ops.object.modifier_apply(modifier="Bevel")

# --- Create chimney cap (wider top rim) ---
cap_height = chimney_height * 0.08
cap_width = chimney_width * 1.25
cap_depth = chimney_depth * 1.25

bpy.ops.mesh.primitive_cube_add(size=1, location=(chimney_x, chimney_y, chimney_z + chimney_height + cap_height * 0.5))
chimney_cap = bpy.context.active_object
chimney_cap.name = "Chimney_Cap"
chimney_cap.scale = (cap_width, cap_depth, cap_height)
bpy.ops.object.transform_apply(scale=True)

# Bevel the cap
bevel_cap = chimney_cap.modifiers.new(name="Bevel", type='BEVEL')
bevel_cap.width = cap_width * 0.04
bevel_cap.segments = 2
bpy.ops.object.modifier_apply(modifier="Bevel")

# --- Create chimney interior hole (dark opening at top) ---
hole_width = chimney_width * 0.65
hole_depth = chimney_depth * 0.65
hole_height = cap_height * 1.5

bpy.ops.mesh.primitive_cube_add(size=1, location=(chimney_x, chimney_y, chimney_z + chimney_height + cap_height * 0.3))
chimney_hole = bpy.context.active_object
chimney_hole.name = "Chimney_Hole"
chimney_hole.scale = (hole_width, hole_depth, hole_height)
bpy.ops.object.transform_apply(scale=True)

# --- Create chimney crown / second rim at base of cap ---
crown_height = chimney_height * 0.05
crown_width = chimney_width * 1.15
crown_depth = chimney_depth * 1.15

bpy.ops.mesh.primitive_cube_add(size=1, location=(chimney_x, chimney_y, chimney_z + chimney_height - crown_height * 0.5))
chimney_crown = bpy.context.active_object
chimney_crown.name = "Chimney_Crown"
chimney_crown.scale = (crown_width, crown_depth, crown_height)
bpy.ops.object.transform_apply(scale=True)

# --- Materials ---

# Chimney stone/brick material
mat_chimney = bpy.data.materials.new(name="Chimney_Stone")
mat_chimney.use_nodes = True
nodes = mat_chimney.node_tree.nodes
links = mat_chimney.node_tree.links
nodes.clear()

output_node = nodes.new(type='ShaderNodeOutputMaterial')
principled = nodes.new(type='ShaderNodeBsdfPrincipled')
principled.inputs['Base Color'].default_value = (0.35, 0.25, 0.18, 1.0)  # Dark brownish stone
principled.inputs['Roughness'].default_value = 0.9
principled.inputs['Specular IOR Level'].default_value = 0.1
links.new(principled.outputs['BSDF'], output_node.inputs['Surface'])

# Add noise texture for stone variation
tex_coord = nodes.new(type='ShaderNodeTexCoord')
noise = nodes.new(type='ShaderNodeTexNoise')
noise.inputs['Scale'].default_value = 15.0
noise.inputs['Detail'].default_value = 8.0
color_ramp = nodes.new(type='ShaderNodeValToRGB')
color_ramp.color_ramp.elements[0].color = (0.28, 0.2, 0.14, 1.0)
color_ramp.color_ramp.elements[1].color = (0.42, 0.32, 0.22, 1.0)
links.new(tex_coord.outputs['Object'], noise.inputs['Vector'])
links.new(noise.outputs['Fac'], color_ramp.inputs['Fac'])
links.new(color_ramp.outputs['Color'], principled.inputs['Base Color'])

# Bump for stone texture
bump = nodes.new(type='ShaderNodeBump')
bump.inputs['Strength'].default_value = 0.3
links.new(noise.outputs['Fac'], bump.inputs['Height'])
links.new(bump.outputs['Normal'], principled.inputs['Normal'])

# Dark interior material for the hole
mat_dark = bpy.data.materials.new(name="Chimney_Interior")
mat_dark.use_nodes = True
dark_nodes = mat_dark.node_tree.nodes
dark_links = mat_dark.node_tree.links
dark_nodes.clear()

dark_output = dark_nodes.new(type='ShaderNodeOutputMaterial')
dark_principled = dark_nodes.new(type='ShaderNodeBsdfPrincipled')
dark_principled.inputs['Base Color'].default_value = (0.02, 0.02, 0.02, 1.0)
dark_principled.inputs['Roughness'].default_value = 1.0
dark_links.new(dark_principled.outputs['BSDF'], dark_output.inputs['Surface'])

# Assign materials
chimney_base.data.materials.append(mat_chimney)
chimney_cap.data.materials.append(mat_chimney)
chimney_crown.data.materials.append(mat_chimney)
chimney_hole.data.materials.append(mat_dark)

# --- Shade smooth on chimney parts ---
for obj_name in ["Chimney_Base", "Chimney_Cap", "Chimney_Crown", "Chimney_Hole"]:
    obj = bpy.data.objects.get(obj_name)
    if obj:
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.shade_smooth()
        obj.select_set(False)

# --- Recalculate normals on all chimney parts ---
chimney_parts = ["Chimney_Base", "Chimney_Cap", "Chimney_Crown", "Chimney_Hole"]
for part_name in chimney_parts:
    obj = bpy.data.objects.get(part_name)
    if obj and obj.type == 'MESH':
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(obj.data)
        bm.free()
        obj.data.update()

# --- Boolean subtract the hole from the cap to create the opening ---
bpy.context.view_layer.objects.active = chimney_cap
bool_mod = chimney_cap.modifiers.new(name="Boolean_Hole", type='BOOLEAN')
bool_mod.operation = 'DIFFERENCE'
bool_mod.object = chimney_hole
bpy.ops.object.modifier_apply(modifier="Boolean_Hole")

# Hide the hole cutter but keep it for visual darkening inside
chimney_hole.scale = (hole_width * 0.95, hole_depth * 0.95, hole_height * 0.8)
chimney_hole.location.z = chimney_z + chimney_height + cap_height * 0.15

# Deselect all
bpy.ops.object.select_all(action='DESELECT')

# Export
output_path = "C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/meshes/Stable_medieval_1775409678994.glb"
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