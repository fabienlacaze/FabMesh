import bpy
import bmesh
import math
from mathutils import Vector

# Clear default scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
for col in bpy.data.collections:
    bpy.data.collections.remove(col)

# Import the original mesh
bpy.ops.import_scene.fbx(filepath="C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/history/Stable_medieval/v0_Stable_medieval_1775405588354.fbx")

# Get bounding box of the imported scene to determine placement
imported_objects = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
if imported_objects:
    min_x = min(obj.bound_box[0][0] * obj.scale.x + obj.location.x for obj in imported_objects)
    max_x = max(obj.bound_box[6][0] * obj.scale.x + obj.location.x for obj in imported_objects)
    min_y = min(obj.bound_box[0][1] * obj.scale.y + obj.location.y for obj in imported_objects)
    max_y = max(obj.bound_box[6][1] * obj.scale.y + obj.location.y for obj in imported_objects)
    min_z = min(obj.bound_box[0][2] * obj.scale.z + obj.location.z for obj in imported_objects)
    max_z = max(obj.bound_box[6][2] * obj.scale.z + obj.location.z for obj in imported_objects)
else:
    min_x, max_x = -1, 1
    min_y, max_y = -1, 1
    min_z, max_z = 0, 2

scene_width_x = max_x - min_x
scene_width_y = max_y - min_y
scene_height = max_z - min_z

# Scale chimney proportionally to the building
chimney_base_size = scene_width_x * 0.08
chimney_height = scene_height * 0.35
chimney_cap_size = chimney_base_size * 1.15

# Place chimney on top of the roof, slightly off-center
chimney_x = min_x + scene_width_x * 0.65
chimney_y = min_y + scene_width_y * 0.5
chimney_z = max_z

# --- Create Chimney Stack (main body) ---
bpy.ops.mesh.primitive_cube_add(size=1, location=(chimney_x, chimney_y, chimney_z + chimney_height * 0.5))
chimney_body = bpy.context.active_object
chimney_body.name = "Chimney_Body"
chimney_body.scale = (chimney_base_size, chimney_base_size, chimney_height)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

# Add slight bevel for realism
bevel_mod = chimney_body.modifiers.new(name="Bevel", type='BEVEL')
bevel_mod.width = chimney_base_size * 0.03
bevel_mod.segments = 2

bpy.ops.object.shade_smooth()

# Create stone/brick material for chimney body
mat_chimney = bpy.data.materials.new(name="Chimney_Stone")
mat_chimney.use_nodes = True
nodes = mat_chimney.node_tree.nodes
links = mat_chimney.node_tree.links
nodes.clear()

# Principled BSDF
principled = nodes.new('ShaderNodeBsdfPrincipled')
principled.location = (0, 0)
principled.inputs['Base Color'].default_value = (0.25, 0.18, 0.12, 1.0)  # Dark stone/brick brown
principled.inputs['Roughness'].default_value = 0.85
principled.inputs['Metallic'].default_value = 0.0
principled.inputs['Specular IOR Level'].default_value = 0.3

# Add noise texture for stone variation
tex_coord = nodes.new('ShaderNodeTexCoord')
tex_coord.location = (-800, 0)

mapping = nodes.new('ShaderNodeMapping')
mapping.location = (-600, 0)
mapping.inputs['Scale'].default_value = (8.0, 8.0, 4.0)

noise_tex = nodes.new('ShaderNodeTexNoise')
noise_tex.location = (-400, 0)
noise_tex.inputs['Scale'].default_value = 12.0
noise_tex.inputs['Detail'].default_value = 6.0
noise_tex.inputs['Roughness'].default_value = 0.7

color_ramp = nodes.new('ShaderNodeValToRGB')
color_ramp.location = (-200, 0)
color_ramp.color_ramp.elements[0].position = 0.3
color_ramp.color_ramp.elements[0].color = (0.18, 0.12, 0.08, 1.0)
color_ramp.color_ramp.elements[1].position = 0.7
color_ramp.color_ramp.elements[1].color = (0.32, 0.22, 0.15, 1.0)

# Bump node for surface detail
bump = nodes.new('ShaderNodeBump')
bump.location = (-200, -200)
bump.inputs['Strength'].default_value = 0.3

noise_bump = nodes.new('ShaderNodeTexNoise')
noise_bump.location = (-400, -200)
noise_bump.inputs['Scale'].default_value = 25.0
noise_bump.inputs['Detail'].default_value = 8.0

output = nodes.new('ShaderNodeOutputMaterial')
output.location = (300, 0)

links.new(tex_coord.outputs['Object'], mapping.inputs['Vector'])
links.new(mapping.outputs['Vector'], noise_tex.inputs['Vector'])
links.new(noise_tex.outputs['Fac'], color_ramp.inputs['Fac'])
links.new(color_ramp.outputs['Color'], principled.inputs['Base Color'])
links.new(mapping.outputs['Vector'], noise_bump.inputs['Vector'])
links.new(noise_bump.outputs['Fac'], bump.inputs['Height'])
links.new(bump.outputs['Normal'], principled.inputs['Normal'])
links.new(principled.outputs['BSDF'], output.inputs['Surface'])

chimney_body.data.materials.append(mat_chimney)

# --- Create Chimney Cap (top rim) ---
bpy.ops.mesh.primitive_cube_add(size=1, location=(chimney_x, chimney_y, chimney_z + chimney_height + chimney_base_size * 0.08))
chimney_cap = bpy.context.active_object
chimney_cap.name = "Chimney_Cap"
chimney_cap.scale = (chimney_cap_size, chimney_cap_size, chimney_base_size * 0.15)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

cap_bevel = chimney_cap.modifiers.new(name="Bevel", type='BEVEL')
cap_bevel.width = chimney_base_size * 0.02
cap_bevel.segments = 2

bpy.ops.object.shade_smooth()

# Cap material - slightly darker stone
mat_cap = bpy.data.materials.new(name="Chimney_Cap_Stone")
mat_cap.use_nodes = True
cap_nodes = mat_cap.node_tree.nodes
cap_links = mat_cap.node_tree.links
cap_nodes.clear()

cap_principled = cap_nodes.new('ShaderNodeBsdfPrincipled')
cap_principled.location = (0, 0)
cap_principled.inputs['Base Color'].default_value = (0.2, 0.14, 0.1, 1.0)
cap_principled.inputs['Roughness'].default_value = 0.9
cap_principled.inputs['Metallic'].default_value = 0.0

cap_output = cap_nodes.new('ShaderNodeOutputMaterial')
cap_output.location = (300, 0)
cap_links.new(cap_principled.outputs['BSDF'], cap_output.inputs['Surface'])

chimney_cap.data.materials.append(mat_cap)

# --- Create Chimney Pot (inner opening cylinder) ---
bpy.ops.mesh.primitive_cylinder_add(
    radius=chimney_base_size * 0.35,
    depth=chimney_base_size * 0.3,
    vertices=16,
    location=(chimney_x, chimney_y, chimney_z + chimney_height + chimney_base_size * 0.22)
)
chimney_pot = bpy.context.active_object
chimney_pot.name = "Chimney_Pot"
bpy.ops.object.shade_smooth()

# Dark interior material for the chimney opening
mat_interior = bpy.data.materials.new(name="Chimney_Interior")
mat_interior.use_nodes = True
int_nodes = mat_interior.node_tree.nodes
int_links = mat_interior.node_tree.links
int_nodes.clear()

int_principled = int_nodes.new('ShaderNodeBsdfPrincipled')
int_principled.location = (0, 0)
int_principled.inputs['Base Color'].default_value = (0.02, 0.02, 0.02, 1.0)  # Very dark soot
int_principled.inputs['Roughness'].default_value = 1.0
int_principled.inputs['Metallic'].default_value = 0.0

int_output = int_nodes.new('ShaderNodeOutputMaterial')
int_output.location = (300, 0)
int_links.new(int_principled.outputs['BSDF'], int_output.inputs['Surface'])

chimney_pot.data.materials.append(mat_interior)

# --- Create Chimney Base Flashing (where it meets the roof) ---
bpy.ops.mesh.primitive_cube_add(size=1, location=(chimney_x, chimney_y, chimney_z + chimney_base_size * 0.05))
chimney_base = bpy.context.active_object
chimney_base.name = "Chimney_Base_Flashing"
chimney_base.scale = (chimney_base_size * 1.2, chimney_base_size * 1.2, chimney_base_size * 0.1)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

base_bevel = chimney_base.modifiers.new(name="Bevel", type='BEVEL')
base_bevel.width = chimney_base_size * 0.02
base_bevel.segments = 1

bpy.ops.object.shade_smooth()

# Lead flashing material
mat_flashing = bpy.data.materials.new(name="Chimney_Flashing")
mat_flashing.use_nodes = True
fl_nodes = mat_flashing.node_tree.nodes
fl_links = mat_flashing.node_tree.links
fl_nodes.clear()

fl_principled = fl_nodes.new('ShaderNodeBsdfPrincipled')
fl_principled.location = (0, 0)
fl_principled.inputs['Base Color'].default_value = (0.15, 0.15, 0.15, 1.0)  # Lead gray
fl_principled.inputs['Roughness'].default_value = 0.6
fl_principled.inputs['Metallic'].default_value = 0.7

fl_output = fl_nodes.new('ShaderNodeOutputMaterial')
fl_output.location = (300, 0)
fl_links.new(fl_principled.outputs['BSDF'], fl_output.inputs['Surface'])

chimney_base.data.materials.append(mat_flashing)

# --- Recalculate normals on all chimney parts ---
chimney_parts = [chimney_body, chimney_cap, chimney_pot, chimney_base]
for obj in chimney_parts:
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
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
output_path = "C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/meshes/Stable_medieval_1775410622349.glb"
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