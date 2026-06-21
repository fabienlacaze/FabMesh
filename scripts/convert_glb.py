"""Convert a GLB/GLTF (mesh + optional armature/animation) to FBX / USD /
Alembic / OBJ / glTF via Blender's Python, headless.

Invoked by src/main/animation.js (_runExport):

    blender --background --factory-startup --python convert_glb.py -- \
        --in <input.glb> --out <output.fbx> --format fbx

Supported --format: fbx, usd / usdc / usda / usdz, abc (Alembic), obj,
glb / gltf. Armature + animation are preserved where the target format
supports them (FBX/USD bake animation; OBJ/Alembic are geometry/cache).
Exit codes: 2 bad args, 3 missing input, 4 unsupported format, 5 no output.
"""
import bpy
import sys
import os


def _argv_after_ddash():
    argv = sys.argv
    return argv[argv.index("--") + 1:] if "--" in argv else []


def _parse(args):
    out = {}
    i = 0
    while i < len(args):
        if args[i].startswith("--") and i + 1 < len(args):
            out[args[i][2:]] = args[i + 1]
            i += 2
        else:
            i += 1
    return out


def main():
    opts = _parse(_argv_after_ddash())
    src = opts.get("in")
    dst = opts.get("out")
    fmt = (opts.get("format") or "").lower()
    if not src or not dst or not fmt:
        print("convert_glb: --in, --out and --format are required", file=sys.stderr)
        sys.exit(2)
    if not os.path.isfile(src):
        print(f"convert_glb: input not found: {src}", file=sys.stderr)
        sys.exit(3)

    # Start from a guaranteed-empty scene (factory-startup still ships the
    # default cube/camera/light), then import the GLB.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)

    out_dir = os.path.dirname(os.path.abspath(dst))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    if fmt == "fbx":
        bpy.ops.export_scene.fbx(
            filepath=dst, use_selection=False, bake_anim=True,
            add_leaf_bones=False, path_mode="COPY", embed_textures=True,
        )
    elif fmt in ("usd", "usdc", "usda", "usdz"):
        bpy.ops.wm.usd_export(
            filepath=dst, export_animation=True,
            export_materials=True, export_textures=True,
        )
    elif fmt in ("abc", "alembic"):
        bpy.ops.wm.alembic_export(filepath=dst)
    elif fmt == "obj":
        try:
            bpy.ops.wm.obj_export(filepath=dst, export_materials=True)
        except AttributeError:  # Blender < 3.3 fallback
            bpy.ops.export_scene.obj(filepath=dst)
    elif fmt in ("glb", "gltf"):
        bpy.ops.export_scene.gltf(
            filepath=dst,
            export_format="GLB" if fmt == "glb" else "GLTF_SEPARATE",
        )
    else:
        print(f"convert_glb: unsupported format '{fmt}'", file=sys.stderr)
        sys.exit(4)

    if not os.path.isfile(dst):
        print(f"convert_glb: export produced no file: {dst}", file=sys.stderr)
        sys.exit(5)
    print(f"convert_glb: wrote {dst} ({os.path.getsize(dst)} bytes)")


if __name__ == "__main__":
    main()
