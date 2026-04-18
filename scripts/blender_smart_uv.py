"""Blender Smart UV Project on a .glb mesh.

Loads input .glb, welds vertices, runs Blender's Smart UV Project with
angle_limit=66° (standard for humanoids — produces ~10-30 charts on a
character mesh vs xatlas's ~300), packs islands, exports to output .glb.

Usage (from within Blender):
    blender.exe --background --python blender_smart_uv.py -- <in.glb> <out.glb>

This script is called as a subprocess by local_sf3d_bridge.py.
"""
import sys
import os
import bpy


def main():
    argv = sys.argv
    if '--' not in argv:
        print('[BLENDER_UV] ERROR: missing -- separator')
        sys.exit(2)
    user_args = argv[argv.index('--') + 1:]
    if len(user_args) < 2:
        print('[BLENDER_UV] Usage: <in.glb> <out.glb> [angle_limit_deg]')
        sys.exit(2)
    in_glb = user_args[0]
    out_glb = user_args[1]
    angle_limit = float(user_args[2]) if len(user_args) > 2 else 66.0

    print(f'[BLENDER_UV] in={in_glb}', flush=True)
    print(f'[BLENDER_UV] out={out_glb}', flush=True)
    print(f'[BLENDER_UV] angle_limit={angle_limit}°', flush=True)

    # Clean scene
    bpy.ops.wm.read_factory_settings(use_empty=True)

    # Import GLB
    bpy.ops.import_scene.gltf(filepath=in_glb)
    mesh_objs = [o for o in bpy.data.objects if o.type == 'MESH']
    if not mesh_objs:
        print('[BLENDER_UV] ERROR: no mesh in GLB')
        sys.exit(3)
    obj = mesh_objs[0]
    print(f'[BLENDER_UV] mesh loaded: {len(obj.data.vertices)} verts, '
          f'{len(obj.data.polygons)} faces', flush=True)

    # Activate + select
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)

    # Weld near-duplicate vertices (0.1mm threshold on a 1m mesh)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.remove_doubles(threshold=1e-4)
    print(f'[BLENDER_UV] post-weld: {len(obj.data.vertices)} verts, '
          f'{len(obj.data.polygons)} faces', flush=True)

    # Smart UV Project: fewer charts (big islands) than xatlas
    bpy.ops.uv.smart_project(
        angle_limit=angle_limit * 3.14159 / 180.0,  # radians
        island_margin=0.003,
        area_weight=0.0,
        correct_aspect=True,
        scale_to_bounds=False,
    )
    # Pack islands tight
    bpy.ops.uv.pack_islands(margin=0.005)

    bpy.ops.object.mode_set(mode='OBJECT')

    # Export GLB
    bpy.ops.export_scene.gltf(
        filepath=out_glb,
        export_format='GLB',
        use_selection=False,
        export_apply=True,
    )
    print(f'[BLENDER_UV] exported -> {out_glb}', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f'[BLENDER_UV] ERROR: {type(e).__name__}: {e}')
        import traceback
        traceback.print_exc()
        sys.exit(4)
