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

# Get imported objects and compute bounding box for placement
imported_objects = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']

# Compute overall bounding box of the imported scene
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

# --- Create Chimney Materials ---

# Stone/brick material for chimney body
stone_mat = bpy.data.materials.new(name="Chimney_Stone")
stone_mat.use_nodes = True
nodes = stone_mat.node_tree.nodes
links = stone_mat.node_tree.links
nodes.clear()

principled = nodes.new('ShaderNodeBsdfPrincipled')
principled.location = (0, 0)
principled.inputs['Base Color'].default_value = (0.35, 0.25, 0.18, 1.0)  # Dark brownish stone
principled.inputs['Roughness'].default_value = 0.85
principled.inputs['Metallic'].default_value = 0.0
principled.inputs['Specular IOR Level'].default_value = 0.3

# Add noise texture for stone variation
noise_tex = nodes.new('ShaderNodeTexNoise')
noise_tex.location = (-400, 0)
noise_tex.inputs['Scale'].default_value = 8.0
noise_tex.inputs['Detail'].default_value = 6.0

color_ramp = nodes.new('ShaderNodeValToRGB')
color_ramp.location = (-200, 0)
color_ramp.color_ramp.elements[0].position = 0.3
color_ramp.color_ramp.elements[0].color = (0.25, 0.18, 0.12, 1.0)
color_ramp.color_ramp.elements[1].position = 0.7
color_ramp.color_ramp.elements[1].color = (0.45, 0.32, 0.22, 1.0)

tex_coord = nodes.new('ShaderNodeTexCoord')
tex_coord.location = (-600, 0)

output = nodes.new('ShaderNodeOutputMaterial')
output.location = (300, 0)

links.new(tex_coord.outputs['Generated'], noise_tex.inputs['Vector'])
links.new(noise_tex.outputs['Fac'], color_ramp.inputs['Fac'])
links.new(color_ramp.outputs['Color'], principled.inputs['Base Color'])
links.new(principled.outputs['BSDF'], output.inputs['Surface'])

# Soot/dark top material
soot_mat = bpy.data.materials.new(name="Chimney_Soot")
soot_mat.use_nodes = True
nodes2 = soot_mat.node_tree.nodes
links2 = soot_mat.node_tree.links
nodes2.clear()

principled2 = nodes2.new('ShaderNodeBsdfPrincipled')
principled2.location = (0, 0)
principled2.inputs['Base Color'].default_value = (0.08, 0.06, 0.05, 1.0)  # Very dark soot
principled2.inputs['Roughness'].default_value = 0.95
principled2.inputs['Metallic'].default_value = 0.0

output2 = nodes2.new('ShaderNodeOutputMaterial')
output2.location = (300, 0)
links2.new(principled2.outputs['BSDF'], output2.inputs['Surface'])

# Mortar lines material
mortar_mat = bpy.data.materials.new(name="Chimney_Cap")
mortar_mat.use_nodes = True
nodes3 = mortar_mat.node_tree.nodes
links3 = mortar_mat.node_tree.links
nodes3.clear()

principled3 = nodes3.new('ShaderNodeBsdfPrincipled')
principled3.location = (0, 0)
principled3.inputs['Base Color'].default_value = (0.4, 0.3, 0.22, 1.0)  # Lighter stone cap
principled3.inputs['Roughness'].default_value = 0.8
principled3.inputs['Metallic'].default_value = 0.0

output3 = nodes3.new('ShaderNodeOutputMaterial')
output3.location = (300, 0)
links3.new(principled3.outputs['BSDF'], output3.inputs['Surface'])

# --- Build the Chimney ---

# Position chimney on one side of the roof, slightly off-center
chimney_x = center_x + building_width * 0.2
chimney_y = center_y
chimney_base_z = max_z * 0.6  # Start from roughly where the roof is
chimney_width = building_width * 0.08
chimney_depth = building_depth * 0.08
chimney_total_height = building_height * 0.45

# Main chimney body (tapered slightly)
bpy.ops.mesh.primitive_cube_add(size=1, location=(chimney_x, chimney_y, chimney_base_z + chimney_total_height / 2))
chimney_body = bpy.context.active_object
chimney_body.name = "Chimney_Body"
chimney_body.scale = (chimney_width, chimney_depth, chimney_total_height / 2)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

# Taper the chimney slightly using bmesh
bpy.ops.object.mode_set(mode='EDIT')
bm = bmesh.from_edit_mesh(chimney_body.data)
bm.faces.ensure_lookup_table()
bm.verts.ensure_lookup_table()

# Move top vertices slightly inward for taper
for v in bm.verts:
    if v.co.z > 0:
        v.co.x *= 0.88
        v.co.y *= 0.88

bmesh.update_edit_mesh(chimney_body.data)
bpy.ops.object.mode_set(mode='OBJECT')

# Assign stone material
chimney_body.data.materials.append(stone_mat)

# Add loop cuts for brick detail
bpy.ops.object.select_all(action='DESELECT')
chimney_body.select_set(True)
bpy.context.view_layer.objects.active = chimney_body
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.subdivide(number_cuts=4)
bpy.ops.object.mode_set(mode='OBJECT')

# Recalculate normals
bpy.ops.object.select_all(action='DESELECT')
chimney_body.select_set(True)
bpy.context.view_layer.objects.active = chimney_body
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()

# Chimney cap (slightly wider rim at the top)
cap_z = chimney_base_z + chimney_total_height
cap_height = chimney_total_height * 0.06

bpy.ops.mesh.primitive_cube_add(size=1, location=(chimney_x, chimney_y, cap_z + cap_height / 2))
chimney_cap = bpy.context.active_object
chimney_cap.name = "Chimney_Cap"
chimney_cap.scale = (chimney_width * 1.15, chimney_depth * 1.15, cap_height)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
chimney_cap.data.materials.append(mortar_mat)

# Recalculate normals for cap
bpy.ops.object.select_all(action='DESELECT')
chimney_cap.select_set(True)
bpy.context.view_layer.objects.active = chimney_cap
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()

# Chimney opening (dark inside) - slightly recessed cylinder at top
bpy.ops.mesh.primitive_cylinder_add(
    radius=chimney_width * 0.55,
    depth=cap_height * 2,
    vertices=16,
    location=(chimney_x, chimney_y, cap_z + cap_height * 0.3)
)
chimney_hole = bpy.context.active_object
chimney_hole.name = "Chimney_Opening"
chimney_hole.data.materials.append(soot_mat)

bpy.ops.object.select_all(action='DESELECT')
chimney_hole.select_set(True)
bpy.context.view_layer.objects.active = chimney_hole
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()

# Chimney base flashing (where chimney meets roof) - flared base
bpy.ops.mesh.primitive_cube_add(size=1, location=(chimney_x, chimney_y, chimney_base_z + chimney_total_height * 0.02))
chimney_base = bpy.context.active_object
chimney_base.name = "Chimney_Base"
chimney_base.scale = (chimney_width * 1.25, chimney_depth * 1.25, chimney_total_height * 0.04)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
chimney_base.data.materials.append(stone_mat)

bpy.ops.object.select_all(action='DESELECT')
chimney_base.select_set(True)
bpy.context.view_layer.objects.active = chimney_base
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()

# --- Fix materials for GLTF export ---
for mat in bpy.data.materials:
    if mat.use_nodes:
        for node in mat.node_tree.nodes:
            if node.type == 'BSDF_DIFFUSE' or node.type == 'BSDF_GLOSSY':
                pass
bpy.ops.file.pack_all()

# --- Export ---
bpy.ops.file.pack_all()
output_path = "C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/meshes/Stable_medieval_1775410167567.glb"
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