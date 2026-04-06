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
for img in bpy.data.images:
    bpy.data.images.remove(img)

# Import the original mesh
bpy.ops.import_scene.fbx(filepath="C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/history/Stable_medieval/v0_Stable_medieval_1775405588354.fbx")

# Get imported objects and compute bounding box
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

# Position chimney on the roof - slightly off-center
chimney_x = min_x + building_width * 0.7
chimney_y = min_y + building_depth * 0.4
roof_top_z = max_z

# Scale chimney proportionally to building
chimney_width = building_width * 0.08
chimney_depth = building_depth * 0.08
chimney_height = building_height * 0.25

# ============================================
# CREATE CHIMNEY BODY (main stack)
# ============================================
bpy.ops.mesh.primitive_cube_add(size=1, location=(chimney_x, chimney_y, roof_top_z + chimney_height * 0.3))
chimney_body = bpy.context.active_object
chimney_body.name = "Chimney_Body"
chimney_body.scale = (chimney_width, chimney_depth, chimney_height)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

# Add slight bevel for realism
bevel_mod = chimney_body.modifiers.new(name="Bevel", type='BEVEL')
bevel_mod.width = chimney_width * 0.05
bevel_mod.segments = 2

bpy.ops.object.shade_smooth()

# Chimney body material - stone/brick
mat_chimney = bpy.data.materials.new(name="Chimney_Stone")
mat_chimney.use_nodes = True
nodes = mat_chimney.node_tree.nodes
links = mat_chimney.node_tree.links
nodes.clear()

principled = nodes.new('ShaderNodeBsdfPrincipled')
output = nodes.new('ShaderNodeOutputMaterial')
links.new(principled.outputs['BSDF'], output.inputs['Surface'])

# Stone/brick color - dark gray with warm tint to match medieval style
principled.inputs['Base Color'].default_value = (0.25, 0.2, 0.17, 1.0)
principled.inputs['Roughness'].default_value = 0.85
principled.inputs['Metallic'].default_value = 0.0
principled.inputs['Specular IOR Level'].default_value = 0.3

# Add noise texture for stone variation
tex_coord = nodes.new('ShaderNodeTexCoord')
mapping = nodes.new('ShaderNodeMapping')
noise = nodes.new('ShaderNodeTexNoise')
color_ramp = nodes.new('ShaderNodeValToRGB')
mix_color = nodes.new('ShaderNodeMix')
mix_color.data_type = 'RGBA'

noise.inputs['Scale'].default_value = 15.0
noise.inputs['Detail'].default_value = 8.0
noise.inputs['Roughness'].default_value = 0.7

links.new(tex_coord.outputs['Object'], mapping.inputs['Vector'])
links.new(mapping.outputs['Vector'], noise.inputs['Vector'])
links.new(noise.outputs['Fac'], color_ramp.inputs['Fac'])

# Use brick pattern via noise mixing
color_ramp.color_ramp.elements[0].color = (0.18, 0.14, 0.11, 1.0)
color_ramp.color_ramp.elements[1].color = (0.32, 0.25, 0.2, 1.0)

links.new(noise.outputs['Fac'], mix_color.inputs['Factor'])
mix_color.inputs[6].default_value = (0.25, 0.2, 0.17, 1.0)  # A color
mix_color.inputs[7].default_value = (0.18, 0.14, 0.11, 1.0)  # B color
links.new(mix_color.outputs[2], principled.inputs['Base Color'])

# Bump for stone texture
bump = nodes.new('ShaderNodeBump')
bump.inputs['Strength'].default_value = 0.3
links.new(noise.outputs['Fac'], bump.inputs['Height'])
links.new(bump.outputs['Normal'], principled.inputs['Normal'])

chimney_body.data.materials.append(mat_chimney)

# ============================================
# CREATE CHIMNEY CAP (top rim)
# ============================================
cap_height = chimney_height * 0.08
cap_overhang = 1.25

bpy.ops.mesh.primitive_cube_add(
    size=1,
    location=(chimney_x, chimney_y, roof_top_z + chimney_height * 0.6 + chimney_height * 0.5 * 0.06)
)
chimney_cap = bpy.context.active_object
chimney_cap.name = "Chimney_Cap"
chimney_cap.scale = (chimney_width * cap_overhang, chimney_depth * cap_overhang, cap_height)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

cap_bevel = chimney_cap.modifiers.new(name="Bevel", type='BEVEL')
cap_bevel.width = cap_height * 0.3
cap_bevel.segments = 2

bpy.ops.object.shade_smooth()

# Cap material - slightly different stone
mat_cap = bpy.data.materials.new(name="Chimney_Cap_Stone")
mat_cap.use_nodes = True
cap_nodes = mat_cap.node_tree.nodes
cap_links = mat_cap.node_tree.links
cap_nodes.clear()

cap_principled = cap_nodes.new('ShaderNodeBsdfPrincipled')
cap_output = cap_nodes.new('ShaderNodeOutputMaterial')
cap_links.new(cap_principled.outputs['BSDF'], cap_output.inputs['Surface'])
cap_principled.inputs['Base Color'].default_value = (0.22, 0.18, 0.15, 1.0)
cap_principled.inputs['Roughness'].default_value = 0.8
cap_principled.inputs['Metallic'].default_value = 0.0

chimney_cap.data.materials.append(mat_cap)

# ============================================
# CREATE CHIMNEY POT (inner opening)
# ============================================
bpy.ops.mesh.primitive_cylinder_add(
    radius=chimney_width * 0.35,
    depth=cap_height * 3,
    location=(chimney_x, chimney_y, roof_top_z + chimney_height * 0.6 + cap_height)
)
chimney_pot = bpy.context.active_object
chimney_pot.name = "Chimney_Pot"
bpy.ops.object.shade_smooth()

# Dark interior material
mat_interior = bpy.data.materials.new(name="Chimney_Interior")
mat_interior.use_nodes = True
int_nodes = mat_interior.node_tree.nodes
int_links = mat_interior.node_tree.links
int_nodes.clear()

int_principled = int_nodes.new('ShaderNodeBsdfPrincipled')
int_output = int_nodes.new('ShaderNodeOutputMaterial')
int_links.new(int_principled.outputs['BSDF'], int_output.inputs['Surface'])
int_principled.inputs['Base Color'].default_value = (0.02, 0.02, 0.02, 1.0)
int_principled.inputs['Roughness'].default_value = 0.95
int_principled.inputs['Metallic'].default_value = 0.0

chimney_pot.data.materials.append(mat_interior)

# ============================================
# CREATE CHIMNEY BASE (where it meets the roof)
# ============================================
base_height = chimney_height * 0.12

bpy.ops.mesh.primitive_cube_add(
    size=1,
    location=(chimney_x, chimney_y, roof_top_z - base_height * 0.3)
)
chimney_base = bpy.context.active_object
chimney_base.name = "Chimney_Base"
chimney_base.scale = (chimney_width * 1.3, chimney_depth * 1.3, base_height)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

base_bevel = chimney_base.modifiers.new(name="Bevel", type='BEVEL')
base_bevel.width = base_height * 0.2
base_bevel.segments = 2

bpy.ops.object.shade_smooth()

# Reuse chimney stone material for base
chimney_base.data.materials.append(mat_chimney)

# ============================================
# Recalculate normals on all chimney parts
# ============================================
chimney_parts = [chimney_body, chimney_cap, chimney_pot, chimney_base]
for part in chimney_parts:
    bpy.context.view_layer.objects.active = part
    bpy.ops.object.select_all(action='DESELECT')
    part.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')

# ============================================
# Fix materials for GLTF export
# ============================================
for mat in bpy.data.materials:
    if mat.use_nodes:
        for node in mat.node_tree.nodes:
            if node.type == 'BSDF_DIFFUSE' or node.type == 'BSDF_GLOSSY':
                pass
bpy.ops.file.pack_all()

# ============================================
# Export
# ============================================
bpy.ops.file.pack_all()
output_path = "C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/meshes/Stable_medieval_1775410896969.glb"
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