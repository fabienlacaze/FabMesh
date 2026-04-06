"""
MeshyMyself - Blender Script Template
=====================================
This is the base template that Claude Code uses to generate Blender Python scripts.
The script runs in Blender's headless mode (--background).

RULES FOR GENERATED SCRIPTS:
1. Always start by clearing the default scene
2. Build geometry using Blender Python API (bpy)
3. Apply materials with Principled BSDF
4. Export to the path specified by __OUTPUT_PATH__
5. Use only built-in Blender operations (no external addons)

OUTPUT FORMAT MARKERS:
- __OUTPUT_PATH__ : replaced at runtime with the actual output file path
"""

import bpy
import bmesh
import math
from mathutils import Vector, Matrix

# ============ SCENE SETUP ============
# Clear everything
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

# Remove orphan data
for block in bpy.data.meshes:
    if block.users == 0:
        bpy.data.meshes.remove(block)
for block in bpy.data.materials:
    if block.users == 0:
        bpy.data.materials.remove(block)

# ============ YOUR GEOMETRY HERE ============
# [Claude Code generates this section]
# Example: bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 0))

# ============ EXPORT ============
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
elif output_path.endswith('.ply'):
    bpy.ops.export_mesh.ply(filepath=output_path)

print(f"MESHY_SUCCESS: Exported to {output_path}")
