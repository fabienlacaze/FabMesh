import bpy
import math

# Clear scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

for block in bpy.data.meshes:
    if block.users == 0:
        bpy.data.meshes.remove(block)

# Create a stylized cube with beveled edges
bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 1))
cube = bpy.context.active_object
cube.name = "StylizedCube"

# Add bevel modifier
bevel = cube.modifiers.new(name="Bevel", type='BEVEL')
bevel.width = 0.1
bevel.segments = 3

# Apply modifier
bpy.ops.object.modifier_apply(modifier="Bevel")

# Create material
mat = bpy.data.materials.new(name="CubeMaterial")
mat.use_nodes = True
nodes = mat.node_tree.nodes
bsdf = nodes.get("Principled BSDF")
bsdf.inputs["Base Color"].default_value = (0.2, 0.5, 0.9, 1.0)
bsdf.inputs["Metallic"].default_value = 0.3
bsdf.inputs["Roughness"].default_value = 0.4
cube.data.materials.append(mat)

# Add a ground plane
bpy.ops.mesh.primitive_plane_add(size=10, location=(0, 0, 0))
plane = bpy.context.active_object
plane_mat = bpy.data.materials.new(name="GroundMaterial")
plane_mat.use_nodes = True
plane_nodes = plane_mat.node_tree.nodes
plane_bsdf = plane_nodes.get("Principled BSDF")
plane_bsdf.inputs["Base Color"].default_value = (0.15, 0.15, 0.2, 1.0)
plane_bsdf.inputs["Roughness"].default_value = 0.8
plane.data.materials.append(plane_mat)

# Export
output_path = "__OUTPUT_PATH__"
if output_path.endswith('.glb') or output_path.endswith('.gltf'):
    fmt = 'GLB' if output_path.endswith('.glb') else 'GLTF_SEPARATE'
    bpy.ops.export_scene.gltf(filepath=output_path, export_format=fmt)
elif output_path.endswith('.obj'):
    bpy.ops.wm.obj_export(filepath=output_path)
elif output_path.endswith('.fbx'):
    bpy.ops.export_scene.fbx(filepath=output_path)
elif output_path.endswith('.stl'):
    bpy.ops.export_mesh.stl(filepath=output_path)

print(f"FABMESH_SUCCESS: Exported to {output_path}")
