import bpy
import bmesh
import math
import mathutils

# Clear default scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

# Remove orphan data
for mesh in bpy.data.meshes:
    if mesh.users == 0:
        bpy.data.meshes.remove(mesh)
for mat in bpy.data.materials:
    if mat.users == 0:
        bpy.data.materials.remove(mat)

# Import the original mesh
bpy.ops.import_scene.fbx(filepath="C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/history/Stable_medieval/v0_Stable_medieval_1775405588354.fbx")

# Inspect existing materials to understand the style
existing_materials = []
for mat in bpy.data.materials:
    if mat.use_nodes:
        existing_materials.append(mat)

# Find the imported objects and determine bounding box for placement
imported_objects = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']

# Calculate overall bounding box of imported scene
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
center_x = (min_x + max_x) / 2
center_y = (min_y + max_y) / 2

# --- Create Stone Material for chimney ---
stone_mat = bpy.data.materials.new(name="Chimney_Stone")
stone_mat.use_nodes = True
stone_nodes = stone_mat.node_tree.nodes
stone_links = stone_mat.node_tree.links
stone_nodes.clear()

stone_bsdf = stone_nodes.new('ShaderNodeBsdfPrincipled')
stone_bsdf.inputs['Base Color'].default_value = (0.35, 0.32, 0.28, 1.0)
stone_bsdf.inputs['Roughness'].default_value = 0.85
stone_bsdf.inputs['Metallic'].default_value = 0.0

stone_output = stone_nodes.new('ShaderNodeOutputMaterial')
stone_links.new(stone_bsdf.outputs['BSDF'], stone_output.inputs['Surface'])

# --- Create Dark Stone Material for chimney top/cap ---
dark_stone_mat = bpy.data.materials.new(name="Chimney_DarkStone")
dark_stone_mat.use_nodes = True
ds_nodes = dark_stone_mat.node_tree.nodes
ds_links = dark_stone_mat.node_tree.links
ds_nodes.clear()

ds_bsdf = ds_nodes.new('ShaderNodeBsdfPrincipled')
ds_bsdf.inputs['Base Color'].default_value = (0.22, 0.20, 0.18, 1.0)
ds_bsdf.inputs['Roughness'].default_value = 0.9
ds_bsdf.inputs['Metallic'].default_value = 0.0

ds_output = ds_nodes.new('ShaderNodeOutputMaterial')
ds_links.new(ds_bsdf.outputs['BSDF'], ds_output.inputs['Surface'])

# --- Create Soot/Interior Material ---
soot_mat = bpy.data.materials.new(name="Chimney_Soot")
soot_mat.use_nodes = True
soot_nodes = soot_mat.node_tree.nodes
soot_links = soot_mat.node_tree.links
soot_nodes.clear()

soot_bsdf = soot_nodes.new('ShaderNodeBsdfPrincipled')
soot_bsdf.inputs['Base Color'].default_value = (0.05, 0.04, 0.03, 1.0)
soot_bsdf.inputs['Roughness'].default_value = 0.95
soot_bsdf.inputs['Metallic'].default_value = 0.0

soot_output = soot_nodes.new('ShaderNodeOutputMaterial')
soot_links.new(soot_bsdf.outputs['BSDF'], soot_output.inputs['Surface'])

# --- Chimney dimensions based on building size ---
chimney_width = building_width * 0.12
chimney_depth = building_depth * 0.12
chimney_height = building_height * 0.45

# Place chimney on the roof, offset from center
chimney_x = center_x + building_width * 0.15
chimney_y = center_y - building_depth * 0.1
chimney_base_z = max_z - building_height * 0.05

# --- Build chimney stack (main body) ---
bpy.ops.mesh.primitive_cube_add(size=1, location=(chimney_x, chimney_y, chimney_base_z + chimney_height / 2))
chimney_body = bpy.context.active_object
chimney_body.name = "Chimney_Body"
chimney_body.scale = (chimney_width, chimney_depth, chimney_height)
bpy.ops.object.transform_apply(scale=True)

# Add slight taper to chimney using bmesh
bpy.ops.object.mode_set(mode='EDIT')
bm = bmesh.from_edit_mesh(chimney_body.data)
bm.faces.ensure_lookup_table()
bm.verts.ensure_lookup_table()

# Taper top vertices slightly inward
for v in bm.verts:
    if v.co.z > 0:
        v.co.x *= 0.9
        v.co.y *= 0.9

bmesh.update_edit_mesh(chimney_body.data)
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')

# Add loop cuts for stone detail
bpy.ops.object.mode_set(mode='EDIT')
bm = bmesh.from_edit_mesh(chimney_body.data)

# Add horizontal edge loops to simulate stone courses
n_cuts = 5
edges_to_cut = []
for e in bm.edges:
    v1z = e.verts[0].co.z
    v2z = e.verts[1].co.z
    if abs(v1z - v2z) > 0.001:
        edges_to_cut.append(e)

if edges_to_cut:
    bmesh.ops.subdivide_edges(bm, edges=edges_to_cut, cuts=n_cuts)

bmesh.update_edit_mesh(chimney_body.data)
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')

# Assign stone material
chimney_body.data.materials.append(stone_mat)

# Shade smooth
bpy.ops.object.shade_smooth()

# --- Chimney cap/crown (slightly wider ledge at top) ---
cap_height = chimney_height * 0.06
cap_z = chimney_base_z + chimney_height + cap_height / 2

bpy.ops.mesh.primitive_cube_add(size=1, location=(chimney_x, chimney_y, cap_z))
chimney_cap = bpy.context.active_object
chimney_cap.name = "Chimney_Cap"
chimney_cap.scale = (chimney_width * 1.2, chimney_depth * 1.2, cap_height)
bpy.ops.object.transform_apply(scale=True)

chimney_cap.data.materials.append(dark_stone_mat)
bpy.ops.object.shade_smooth()

# --- Chimney opening (hollow top) ---
opening_depth_val = chimney_height * 0.08
opening_z = chimney_base_z + chimney_height - opening_depth_val / 2

bpy.ops.mesh.primitive_cube_add(size=1, location=(chimney_x, chimney_y, cap_z + cap_height * 0.5))
chimney_opening = bpy.context.active_object
chimney_opening.name = "Chimney_Opening"
chimney_opening.scale = (chimney_width * 0.65, chimney_depth * 0.65, cap_height * 0.3)
bpy.ops.object.transform_apply(scale=True)

chimney_opening.data.materials.append(soot_mat)

# --- Base flashing (where chimney meets roof) ---
flashing_height = chimney_height * 0.05

bpy.ops.mesh.primitive_cube_add(size=1, location=(chimney_x, chimney_y, chimney_base_z + flashing_height / 2))
chimney_base = bpy.context.active_object
chimney_base.name = "Chimney_Base"
chimney_base.scale = (chimney_width * 1.3, chimney_depth * 1.3, flashing_height)
bpy.ops.object.transform_apply(scale=True)

chimney_base.data.materials.append(dark_stone_mat)
bpy.ops.object.shade_smooth()

# --- Chimney pot (small cylinder on top) ---
pot_radius = chimney_width * 0.2
pot_height = chimney_height * 0.12
pot_z = cap_z + cap_height / 2 + pot_height / 2

bpy.ops.mesh.primitive_cylinder_add(radius=pot_radius, depth=pot_height, vertices=12, location=(chimney_x, chimney_y, pot_z))
chimney_pot = bpy.context.active_object
chimney_pot.name = "Chimney_Pot"

# Create a terracotta-like material for the pot
pot_mat = bpy.data.materials.new(name="Chimney_Pot_Terracotta")
pot_mat.use_nodes = True
pot_nodes = pot_mat.node_tree.nodes
pot_links = pot_mat.node_tree.links
pot_nodes.clear()

pot_bsdf = pot_nodes.new('ShaderNodeBsdfPrincipled')
pot_bsdf.inputs['Base Color'].default_value = (0.45, 0.25, 0.15, 1.0)
pot_bsdf.inputs['Roughness'].default_value = 0.8
pot_bsdf.inputs['Metallic'].default_value = 0.0

pot_output = pot_nodes.new('ShaderNodeOutputMaterial')
pot_links.new(pot_bsdf.outputs['BSDF'], pot_output.inputs['Surface'])

chimney_pot.data.materials.append(pot_mat)
bpy.ops.object.shade_smooth()

# --- Hollow out the chimney pot ---
inner_radius = pot_radius * 0.7
bpy.ops.mesh.primitive_cylinder_add(radius=inner_radius, depth=pot_height * 0.5, vertices=12, location=(chimney_x, chimney_y, pot_z + pot_height * 0.3))
pot_inner = bpy.context.active_object
pot_inner.name = "Chimney_Pot_Inner"
pot_inner.data.materials.append(soot_mat)
bpy.ops.object.shade_smooth()

# --- Select all chimney parts and recalculate normals ---
chimney_parts = ["Chimney_Body", "Chimney_Cap", "Chimney_Opening", "Chimney_Base", "Chimney_Pot", "Chimney_Pot_Inner"]

for part_name in chimney_parts:
    obj = bpy.data.objects.get(part_name)
    if obj:
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.normals_make_consistent(inside=False)
        bpy.ops.object.mode_set(mode='OBJECT')
        obj.select_set(False)

# Fix materials for GLTF export - ensure all use Principled BSDF
for mat in bpy.data.materials:
    if mat.use_nodes:
        for node in mat.node_tree.nodes:
            if node.type == 'BSDF_DIFFUSE' or node.type == 'BSDF_GLOSSY':
                # Already has Principled? Skip
                pass
bpy.ops.file.pack_all()

bpy.ops.file.pack_all()
output_path = "C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/meshes/Stable_medieval_1775411334454.glb"
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