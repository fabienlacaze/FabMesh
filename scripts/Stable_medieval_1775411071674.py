import bpy
import bmesh
import math
import random

# Clear default scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

# Remove default collections' orphan data
for mesh in bpy.data.meshes:
    bpy.data.meshes.remove(mesh)
for mat in bpy.data.materials:
    bpy.data.materials.remove(mat)

# Import the original mesh
bpy.ops.import_scene.fbx(filepath="C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/history/Stable_medieval/v0_Stable_medieval_1775405588354.fbx")

# Inspect existing materials to match style
existing_materials = list(bpy.data.materials)
base_color = (0.25, 0.18, 0.12, 1.0)  # dark stone/wood default
base_roughness = 0.85
base_metallic = 0.0

for mat in existing_materials:
    if mat.use_nodes:
        for node in mat.node_tree.nodes:
            if node.type == 'BSDF_PRINCIPLED':
                bc = node.inputs.get('Base Color')
                if bc and hasattr(bc, 'default_value'):
                    base_color = tuple(bc.default_value)
                rough = node.inputs.get('Roughness')
                if rough:
                    base_roughness = rough.default_value
                break

# Find bounding box of imported scene to place chimney
all_imported = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
min_x, min_y, min_z = float('inf'), float('inf'), float('inf')
max_x, max_y, max_z = float('-inf'), float('-inf'), float('-inf')

for obj in all_imported:
    for corner in obj.bound_box:
        world_corner = obj.matrix_world @ __import__('mathutils').Vector(corner)
        min_x = min(min_x, world_corner.x)
        max_x = max(max_x, world_corner.x)
        min_y = min(min_y, world_corner.y)
        max_y = max(max_y, world_corner.y)
        min_z = min(min_z, world_corner.z)
        max_z = max(max_z, world_corner.z)

building_width = max_x - min_x
building_depth = max_y - min_y
building_height = max_z - min_z
center_x = (min_x + max_x) / 2
center_y = (min_y + max_y) / 2

# Chimney placement: offset from center on the roof
chimney_x = center_x + building_width * 0.2
chimney_y = center_y - building_depth * 0.1
chimney_base_z = max_z - building_height * 0.05  # slightly into the roof
chimney_width = building_width * 0.08
chimney_depth = building_depth * 0.08
chimney_height = building_height * 0.35

# --- Create stone material for chimney ---
stone_mat = bpy.data.materials.new(name="Chimney_Stone")
stone_mat.use_nodes = True
nodes = stone_mat.node_tree.nodes
links = stone_mat.node_tree.links
nodes.clear()

# Principled BSDF
principled = nodes.new('ShaderNodeBsdfPrincipled')
principled.location = (200, 0)

# Output
output = nodes.new('ShaderNodeOutputMaterial')
output.location = (500, 0)
links.new(principled.outputs['BSDF'], output.inputs['Surface'])

# Noise texture for stone variation
tex_coord = nodes.new('ShaderNodeTexCoord')
tex_coord.location = (-600, 0)

mapping = nodes.new('ShaderNodeMapping')
mapping.location = (-400, 0)
mapping.inputs['Scale'].default_value = (3.0, 3.0, 3.0)
links.new(tex_coord.outputs['Object'], mapping.inputs['Vector'])

noise = nodes.new('ShaderNodeTexNoise')
noise.location = (-200, 100)
noise.inputs['Scale'].default_value = 8.0
noise.inputs['Detail'].default_value = 6.0
noise.inputs['Roughness'].default_value = 0.6
links.new(mapping.outputs['Vector'], noise.inputs['Vector'])

# Color ramp for stone colors
color_ramp = nodes.new('ShaderNodeValToRGB')
color_ramp.location = (0, 100)
color_ramp.color_ramp.elements[0].position = 0.3
color_ramp.color_ramp.elements[0].color = (0.18, 0.14, 0.10, 1.0)
color_ramp.color_ramp.elements[1].position = 0.7
color_ramp.color_ramp.elements[1].color = (0.35, 0.28, 0.22, 1.0)
links.new(noise.outputs['Fac'], color_ramp.inputs['Fac'])
links.new(color_ramp.outputs['Color'], principled.inputs['Base Color'])

# Roughness variation
noise2 = nodes.new('ShaderNodeTexNoise')
noise2.location = (-200, -150)
noise2.inputs['Scale'].default_value = 12.0
noise2.inputs['Detail'].default_value = 4.0
links.new(mapping.outputs['Vector'], noise2.inputs['Vector'])

rough_ramp = nodes.new('ShaderNodeValToRGB')
rough_ramp.location = (0, -150)
rough_ramp.color_ramp.elements[0].position = 0.4
rough_ramp.color_ramp.elements[0].color = (0.75, 0.75, 0.75, 1.0)
rough_ramp.color_ramp.elements[1].position = 0.8
rough_ramp.color_ramp.elements[1].color = (0.95, 0.95, 0.95, 1.0)
links.new(noise2.outputs['Fac'], rough_ramp.inputs['Fac'])
links.new(rough_ramp.outputs['Color'], principled.inputs['Roughness'])

principled.inputs['Metallic'].default_value = 0.0

# --- Build chimney stack (main body) ---
bpy.ops.mesh.primitive_cube_add(size=1, location=(chimney_x, chimney_y, chimney_base_z + chimney_height / 2))
chimney_body = bpy.context.active_object
chimney_body.name = "Chimney_Body"
chimney_body.scale = (chimney_width, chimney_depth, chimney_height)
bpy.ops.object.transform_apply(scale=True)

# Add slight taper using bmesh for realism
bm = bmesh.new()
bm.from_mesh(chimney_body.data)
bm.verts.ensure_lookup_table()

# Taper top vertices slightly inward
top_verts = [v for v in bm.verts if v.co.z > 0]
for v in top_verts:
    v.co.x *= 0.9
    v.co.y *= 0.9

bm.to_mesh(chimney_body.data)
bm.free()

# Apply stone material
chimney_body.data.materials.append(stone_mat)

# Shade smooth
bpy.ops.object.select_all(action='DESELECT')
chimney_body.select_set(True)
bpy.context.view_layer.objects.active = chimney_body
bpy.ops.object.shade_smooth()

# Recalculate normals
bm = bmesh.new()
bm.from_mesh(chimney_body.data)
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
bm.to_mesh(chimney_body.data)
bm.free()

# --- Chimney cap (wider top ledge) ---
cap_height = chimney_height * 0.08
cap_z = chimney_base_z + chimney_height + cap_height / 2
bpy.ops.mesh.primitive_cube_add(size=1, location=(chimney_x, chimney_y, cap_z))
chimney_cap = bpy.context.active_object
chimney_cap.name = "Chimney_Cap"
chimney_cap.scale = (chimney_width * 1.25, chimney_depth * 1.25, cap_height)
bpy.ops.object.transform_apply(scale=True)

chimney_cap.data.materials.append(stone_mat)
bpy.ops.object.shade_smooth()

bm = bmesh.new()
bm.from_mesh(chimney_cap.data)
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
bm.to_mesh(chimney_cap.data)
bm.free()

# --- Chimney pot (cylindrical top piece) ---
pot_radius = chimney_width * 0.3
pot_height = chimney_height * 0.12
pot_z = cap_z + cap_height / 2 + pot_height / 2
bpy.ops.mesh.primitive_cylinder_add(radius=pot_radius, depth=pot_height, location=(chimney_x, chimney_y, pot_z), vertices=16)
chimney_pot = bpy.context.active_object
chimney_pot.name = "Chimney_Pot"

# Dark clay material for pot
pot_mat = bpy.data.materials.new(name="Chimney_Pot_Clay")
pot_mat.use_nodes = True
pot_nodes = pot_mat.node_tree.nodes
pot_links = pot_mat.node_tree.links
pot_nodes.clear()

pot_principled = pot_nodes.new('ShaderNodeBsdfPrincipled')
pot_principled.location = (200, 0)
pot_principled.inputs['Base Color'].default_value = (0.28, 0.15, 0.08, 1.0)
pot_principled.inputs['Roughness'].default_value = 0.8
pot_principled.inputs['Metallic'].default_value = 0.0

pot_output = pot_nodes.new('ShaderNodeOutputMaterial')
pot_output.location = (500, 0)
pot_links.new(pot_principled.outputs['BSDF'], pot_output.inputs['Surface'])

chimney_pot.data.materials.append(pot_mat)

bpy.ops.object.select_all(action='DESELECT')
chimney_pot.select_set(True)
bpy.context.view_layer.objects.active = chimney_pot
bpy.ops.object.shade_smooth()

bm = bmesh.new()
bm.from_mesh(chimney_pot.data)
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
bm.to_mesh(chimney_pot.data)
bm.free()

# --- Chimney base flashing (where chimney meets roof) ---
flashing_height = chimney_height * 0.06
flashing_z = chimney_base_z + flashing_height / 2
bpy.ops.mesh.primitive_cube_add(size=1, location=(chimney_x, chimney_y, flashing_z))
chimney_flashing = bpy.context.active_object
chimney_flashing.name = "Chimney_Flashing"
chimney_flashing.scale = (chimney_width * 1.15, chimney_depth * 1.15, flashing_height)
bpy.ops.object.transform_apply(scale=True)

# Darker material for flashing
flash_mat = bpy.data.materials.new(name="Chimney_Flashing_Mat")
flash_mat.use_nodes = True
fn = flash_mat.node_tree.nodes
fl = flash_mat.node_tree.links
fn.clear()

fp = fn.new('ShaderNodeBsdfPrincipled')
fp.location = (200, 0)
fp.inputs['Base Color'].default_value = (0.12, 0.10, 0.08, 1.0)
fp.inputs['Roughness'].default_value = 0.6
fp.inputs['Metallic'].default_value = 0.3

fo = fn.new('ShaderNodeOutputMaterial')
fo.location = (500, 0)
fl.new(fp.outputs['BSDF'], fo.inputs['Surface'])

chimney_flashing.data.materials.append(flash_mat)

bpy.ops.object.select_all(action='DESELECT')
chimney_flashing.select_set(True)
bpy.context.view_layer.objects.active = chimney_flashing
bpy.ops.object.shade_smooth()

# --- Soot/smoke stain inside pot (dark interior disc) ---
bpy.ops.mesh.primitive_cylinder_add(radius=pot_radius * 0.85, depth=0.001, location=(chimney_x, chimney_y, pot_z + pot_height / 2 - 0.001), vertices=16)
soot_disc = bpy.context.active_object
soot_disc.name = "Chimney_Soot"

soot_mat = bpy.data.materials.new(name="Chimney_Soot_Mat")
soot_mat.use_nodes = True
sn = soot_mat.node_tree.nodes
sl = soot_mat.node_tree.links
sn.clear()

sp = sn.new('ShaderNodeBsdfPrincipled')
sp.location = (200, 0)
sp.inputs['Base Color'].default_value = (0.02, 0.02, 0.02, 1.0)
sp.inputs['Roughness'].default_value = 0.95

so = sn.new('ShaderNodeOutputMaterial')
so.location = (500, 0)
sl.new(sp.outputs['BSDF'], so.inputs['Surface'])

soot_disc.data.materials.append(soot_mat)

# --- Fix materials for GLTF export ---
for mat in bpy.data.materials:
    if mat.use_nodes:
        for node in mat.node_tree.nodes:
            if node.type == 'BSDF_DIFFUSE' or node.type == 'BSDF_GLOSSY':
                pass

bpy.ops.file.pack_all()
output_path = "C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/meshes/Stable_medieval_1775411071674.glb"
if output_path.endswith('.glb') or output_path.endswith('.gltf'):
    fmt = 'GLB' if output_path.endswith('.glb') else 'GLTF_SEPARATE'
    bpy.ops.export_scene.gltf(filepath=output_path, export_format=fmt, export_image_format='AUTO', export_materials='EXPORT')
elif output_path.endswith('.obj'):
    bpy.ops.wm.obj_export(filepath=output_path)
elif output_path.endswith('.fbx'):
    bpy.ops.export_scene.fbx(filepath=output_path)
elif output_path.endswith('.stl'):
    bpy.ops.export_mesh.stl(filepath=output_path)
print("FABMESH_SUCCESS")