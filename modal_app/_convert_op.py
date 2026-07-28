"""GLB -> FBX / OBJ / STL / PLY / glTF / USD / Alembic / Collada, headless.

Cloud mirror of scripts/convert_glb.py (desktop), which drives the same
Blender operators through the `blender --background` CLI. Here we run the
`bpy` PyPI module in-process instead: same operators, same flags, same
output — no Blender install to manage.

Why Blender for EVERY format and not trimesh for the easy ones:
trimesh can write obj/stl/ply/glb without any extra dependency, but its
OBJ writer drops the material/texture bindings, so a textured mesh would
silently come back grey. Two backends = two fidelities = the kind of
"works but wrong" export this codebase already got burned by. One path,
identical to the desktop's, is worth the container cost.

Single-file vs multi-file: FBX embeds its textures (path_mode=COPY +
embed_textures), so the priority format downloads as one .fbx. OBJ and
GLTF_SEPARATE inherently spill sidecars (.mtl, .bin, .png) — those come
back as a .zip rather than a lone file that references images the user
never received.

Returns (bytes, extension). Unsupported targets raise ValueError; nothing
is ever silently substituted with a GLB.
"""
import io
import os
import tempfile
import zipfile


# target format -> file extension actually written
FORMATS = {
    'fbx':  'fbx',
    # Unreal variant: same .fbx, different axes/scale (see _export).
    'fbx_unreal': 'fbx',
    'obj':  'obj',
    'stl':  'stl',
    'ply':  'ply',
    'glb':  'glb',
    'gltf': 'gltf',
    'usd':  'usd',
    'usdc': 'usdc',
    'usda': 'usda',
    'usdz': 'usdz',
    'abc':  'abc',
    'dae':  'dae',
}


def _export(fmt: str, dst: str) -> None:
    """Run the Blender exporter for `fmt`. Flags mirror the desktop's
    scripts/convert_glb.py so both platforms produce identical files."""
    import bpy

    if fmt == 'fbx_unreal':
        # Unreal expects centimetres and Y-up; Blender is metres and Z-up.
        # Same treatment as the desktop (src/main/main.js, isUnreal): scale
        # the objects x100 THEN bake the space transform, so the asset
        # lands at the right size and orientation without the importer
        # having to guess.
        for obj in bpy.context.scene.objects:
            if obj.type in ('MESH', 'ARMATURE'):
                obj.scale = (100, 100, 100)
        bpy.context.view_layer.update()
        bpy.ops.export_scene.fbx(
            filepath=dst,
            apply_unit_scale=True,
            apply_scale_options='FBX_SCALE_NONE',
            axis_forward='-Z',
            axis_up='Y',
            bake_space_transform=True,
            mesh_smooth_type='FACE',
            path_mode='COPY', embed_textures=True,
        )
    elif fmt == 'fbx':
        # embed_textures + path_mode COPY = a self-contained .fbx, which is
        # what makes it a single-file download (and what Unreal expects).
        bpy.ops.export_scene.fbx(
            filepath=dst, use_selection=False, bake_anim=True,
            add_leaf_bones=False, path_mode='COPY', embed_textures=True,
        )
    elif fmt == 'obj':
        try:
            bpy.ops.wm.obj_export(filepath=dst, export_materials=True)
        except AttributeError:  # Blender < 3.3
            bpy.ops.export_scene.obj(filepath=dst)
    elif fmt == 'stl':
        try:
            bpy.ops.wm.stl_export(filepath=dst)
        except AttributeError:  # Blender < 4.2 shipped it elsewhere
            bpy.ops.export_mesh.stl(filepath=dst)
    elif fmt == 'ply':
        try:
            bpy.ops.wm.ply_export(filepath=dst)
        except AttributeError:  # Blender < 4.0
            bpy.ops.export_mesh.ply(filepath=dst)
    elif fmt in ('glb', 'gltf'):
        bpy.ops.export_scene.gltf(
            filepath=dst,
            export_format='GLB' if fmt == 'glb' else 'GLTF_SEPARATE',
        )
    elif fmt in ('usd', 'usdc', 'usda', 'usdz'):
        bpy.ops.wm.usd_export(
            filepath=dst, export_animation=True,
            export_materials=True, export_textures=True,
        )
    elif fmt in ('abc', 'alembic'):
        bpy.ops.wm.alembic_export(filepath=dst)
    elif fmt == 'dae':
        bpy.ops.wm.collada_export(filepath=dst)
    else:
        raise ValueError(f'unsupported target format: {fmt}')


def convert(glb_bytes: bytes, fmt: str) -> tuple[bytes, str]:
    """Convert an in-memory GLB to `fmt`. Returns (bytes, extension) —
    extension is 'zip' when the format needed sidecar files."""
    import bpy

    fmt = (fmt or '').strip().lower().lstrip('.')
    if fmt not in FORMATS:
        raise ValueError(
            f"unsupported target format '{fmt}' "
            f"(supported: {', '.join(sorted(FORMATS))})")
    if not glb_bytes:
        raise ValueError('empty source mesh')

    ext = FORMATS[fmt]
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, 'input.glb')
        with open(src, 'wb') as f:
            f.write(glb_bytes)

        # Isolated output dir so we can tell sidecar files apart from the
        # input by listing it — no guessing at exporter-specific naming.
        out_dir = os.path.join(td, 'out')
        os.makedirs(out_dir)
        dst = os.path.join(out_dir, 'model.' + ext)

        # factory-startup still ships the default cube/camera/light.
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=src)
        _export(fmt, dst)

        written = sorted(
            n for n in os.listdir(out_dir)
            if os.path.isfile(os.path.join(out_dir, n)))
        if not written:
            raise RuntimeError(f'{fmt} export produced no file')

        if len(written) == 1:
            with open(os.path.join(out_dir, written[0]), 'rb') as f:
                return f.read(), ext

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
            for name in written:
                z.write(os.path.join(out_dir, name), name)
        return buf.getvalue(), 'zip'
