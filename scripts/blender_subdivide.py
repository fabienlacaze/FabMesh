"""
Blender script: subdivide a GLB mesh using Catmull-Clark subdivision.

Usage (called by local_sf3d_bridge.py, not directly):
    blender --background --python blender_subdivide.py -- <input.glb> <output.glb> <levels>

Levels:
    1 → ~4× triangles  (13K → 53K)
    2 → ~16× triangles (13K → 212K)
    3 → ~64× triangles (13K → 850K)

The PBR materials and UV maps are preserved through subdivision.
"""
import sys
import bpy
import os
import time


def main():
    # Parse args after "--"
    argv = sys.argv
    if '--' not in argv:
        print("SUBDIVIDE_ERROR: no -- separator in argv", flush=True)
        return False
    args = argv[argv.index('--') + 1:]
    if len(args) < 3:
        print("SUBDIVIDE_ERROR: need <input> <output> <levels>", flush=True)
        return False

    input_path = args[0]
    output_path = args[1]
    levels = int(args[2])

    print(f"SUBDIVIDE: input={input_path} output={output_path} levels={levels}", flush=True)

    if not os.path.exists(input_path):
        print(f"SUBDIVIDE_ERROR: input not found: {input_path}", flush=True)
        return False

    t0 = time.time()

    # Clear default scene
    bpy.ops.wm.read_factory_settings(use_empty=True)

    # Import GLB
    print("SUBDIVIDE: importing GLB...", flush=True)
    bpy.ops.import_scene.gltf(filepath=input_path)

    # Find all mesh objects
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
    if not meshes:
        print("SUBDIVIDE_ERROR: no mesh objects found in GLB", flush=True)
        return False

    total_verts_before = sum(len(m.data.vertices) for m in meshes)
    total_faces_before = sum(len(m.data.polygons) for m in meshes)
    print(f"SUBDIVIDE: before: {total_verts_before} verts, {total_faces_before} faces", flush=True)

    # Apply Catmull-Clark subdivision to each mesh
    for obj in meshes:
        # Select this object
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)

        # Add subdivision modifier
        mod = obj.modifiers.new(name='FabMeshSubdiv', type='SUBSURF')
        mod.subdivision_type = 'CATMULL_CLARK'
        mod.levels = 0          # viewport (don't care)
        mod.render_levels = levels
        mod.quality = 3         # good quality
        mod.use_limit_surface = True

        # Apply the modifier so the geometry is baked
        bpy.ops.object.modifier_apply(modifier=mod.name)

        obj.select_set(False)

    total_verts_after = sum(len(m.data.vertices) for m in meshes)
    total_faces_after = sum(len(m.data.polygons) for m in meshes)
    print(f"SUBDIVIDE: after: {total_verts_after} verts, {total_faces_after} faces", flush=True)

    # Export GLB
    print("SUBDIVIDE: exporting GLB...", flush=True)
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=output_path,
        export_format='GLB',
        export_normals=True,
        export_materials='EXPORT',
        export_colors=True,
        export_texcoords=True,
        export_apply=True,
    )

    elapsed = time.time() - t0
    size = os.path.getsize(output_path)
    print(f"SUBDIVIDE_SUCCESS: {output_path} ({size} bytes, {total_verts_after} verts, {total_faces_after} faces) in {elapsed:.1f}s", flush=True)
    return True


if __name__ == '__main__':
    try:
        ok = main()
        if not ok:
            sys.exit(1)
    except Exception as e:
        print(f"SUBDIVIDE_ERROR: {type(e).__name__}: {e}", flush=True)
        import traceback
        traceback.print_exc()
        sys.exit(1)
