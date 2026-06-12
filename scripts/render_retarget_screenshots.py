"""Headless Blender script — render N viewpoints of an animated GLB
so the assistant can see retarget results without depending on the user.

Dual-mode:
  - Inside Blender (`blender --background --python THIS_FILE -- ...`):
    loads the GLB, picks the Retarget clip, samples 3 frames (25/50/75%
    of duration), renders 3 viewpoints each (front / side / 3q) at
    512x512 EEVEE_NEXT. Output: 9 PNGs in --out-dir.
  - Outside Blender (plain Python): orchestrator `render_glb()` spawns
    Blender as a subprocess and returns the PNG paths.

CLI (Blender mode):
    blender --background --python scripts/render_retarget_screenshots.py -- \
        --glb c:/tmp/rokoko_out/X.glb \
        --out-dir c:/tmp/qa_out

CLI (Python orchestrator):
    python scripts/render_retarget_screenshots.py \
        --glb c:/tmp/rokoko_out/X.glb --out-dir c:/tmp/qa_out
"""
from __future__ import annotations
import argparse
import json
import math
import os
import subprocess
import sys
from pathlib import Path


BLENDER_EXE = r"c:/tools/blender-4.4.3-windows-x64/blender.exe"
THIS_FILE = Path(__file__).resolve()


# =============================================================================
# In-Blender render
# =============================================================================
def run_in_blender():
    import bpy
    import mathutils

    # Parse args after `--`
    try:
        i = sys.argv.index("--")
        argv = sys.argv[i + 1:]
    except ValueError:
        argv = []

    def get(k, default=None):
        if k in argv:
            return argv[argv.index(k) + 1]
        return default

    glb = get("--glb")
    out_dir = get("--out-dir", "c:/tmp/qa_out")
    if not glb:
        print("ERR no --glb", file=sys.stderr)
        sys.exit(2)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = Path(glb).stem

    # Clean scene
    bpy.ops.wm.read_factory_settings(use_empty=True)

    # Import GLB
    bpy.ops.import_scene.gltf(filepath=glb)

    # Find armature + first skinned mesh
    arm = next((o for o in bpy.context.scene.objects if o.type == "ARMATURE"), None)
    if arm is None:
        print(json.dumps({"glb": glb, "error": "no armature"}))
        sys.exit(3)

    # Pick the Retarget clip if multiple actions exist
    actions = list(bpy.data.actions)
    retarget_action = next((a for a in actions if "Retarget" in a.name), None)
    pick = retarget_action or (actions[-1] if actions else None)
    if pick is not None and arm.animation_data is not None:
        arm.animation_data.action = pick
    clip_name = pick.name if pick else "(no clip)"

    # Frame range
    fps = bpy.context.scene.render.fps
    if pick is not None:
        s_frame = int(pick.frame_range[0])
        e_frame = int(pick.frame_range[1])
    else:
        s_frame = 1
        e_frame = 1
    bpy.context.scene.frame_start = s_frame
    bpy.context.scene.frame_end = e_frame

    # Lighting: bright ambient world + 1 sun. Make the world background
    # a noticeable color so we can SEE if the mesh is missing vs invisible.
    world = bpy.data.worlds.new("RenderWorld")
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg is not None:
        bg.inputs[0].default_value = (0.2, 0.3, 0.5, 1.0)  # blue
        bg.inputs[1].default_value = 5.0
    light_data = bpy.data.lights.new("Sun", "SUN")
    light_data.energy = 8
    light_obj = bpy.data.objects.new("Sun", light_data)
    bpy.context.collection.objects.link(light_obj)
    light_obj.rotation_euler = (math.radians(40), math.radians(20), 0)
    # Add a 2nd fill light to compensate dark imported materials
    fill_data = bpy.data.lights.new("Fill", "SUN")
    fill_data.energy = 4
    fill_obj = bpy.data.objects.new("Fill", fill_data)
    bpy.context.collection.objects.link(fill_obj)
    fill_obj.rotation_euler = (math.radians(-30), math.radians(150), 0)

    # WORKBENCH renderer — paints meshes with a constant studio shader,
    # no materials/lighting required, works deterministically headless.
    bpy.context.scene.render.engine = "BLENDER_WORKBENCH"
    shading = bpy.context.scene.display.shading
    shading.light = "STUDIO"
    shading.color_type = "SINGLE"  # solid color, ignore baked materials
    shading.single_color = (0.7, 0.7, 0.75)
    try:
        shading.show_cavity = True
    except Exception:
        pass
    bpy.context.scene.render.resolution_x = 512
    bpy.context.scene.render.resolution_y = 512
    bpy.context.scene.render.image_settings.file_format = "PNG"
    bpy.context.scene.render.film_transparent = False

    # Camera — perspective, hardcoded distances per view.
    cam_data = bpy.data.cameras.new("Cam")
    cam_obj = bpy.data.objects.new("Cam", cam_data)
    bpy.context.collection.objects.link(cam_obj)
    bpy.context.scene.camera = cam_obj
    cam_data.lens = 35  # wide-ish
    # Mesh can be ~1 cm wide in world space (Rokoko bakes scale=0.01 into
    # the GLB). Default clip_start=0.1 would put the entire mesh inside
    # the near plane. Push it down to micrometers.
    cam_data.clip_start = 1e-5
    cam_data.clip_end = 1000.0

    def fit_camera(view: str, mid_frame: int):
        """Move camera so the animated DEFORMED mesh fits in frame."""
        bpy.context.scene.frame_set(mid_frame)
        bpy.context.view_layer.update()
        # Evaluate the deformed mesh at this frame and use its world bbox.
        deps = bpy.context.evaluated_depsgraph_get()
        verts = []
        # Pick the LARGEST mesh (by vert count) — the character mesh.
        # GLBs sometimes include a stub Icosphere / debug node that
        # pollutes the bbox and shrinks framing on the real character.
        mesh_objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
        if not mesh_objs:
            return
        # Sort by vert count desc, keep meshes whose count > 10% of the
        # largest (skip true outliers like 42-vert helper geometry).
        sized = sorted(((o, len(o.evaluated_get(deps).data.vertices)) for o in mesh_objs),
                       key=lambda x: -x[1])
        biggest = sized[0][1]
        keep_objs = [o for o, n in sized if n >= max(1000, biggest * 0.1)]
        for obj in keep_objs:
            obj_eval = obj.evaluated_get(deps)
            mesh_data = obj_eval.data
            mat = obj_eval.matrix_world
            if view == "front" and mid_frame == frames[1]:
                print(f"[render] mesh={obj.name} verts={len(mesh_data.vertices)} "
                      f"matrix_world.translation={list(mat.translation)} "
                      f"scale={list(mat.to_scale())}")
            for v in mesh_data.vertices:
                verts.append(mat @ v.co)
        if not verts:
            # Fallback to bones if no mesh evaluated
            for b in arm.pose.bones:
                verts.append(arm.matrix_world @ b.head)
                verts.append(arm.matrix_world @ b.tail)
        if not verts:
            return
        # Debug
        if view == "front" and mid_frame == frames[1]:
            print(f"[render] bbox verts={len(verts)} "
                  f"X=[{min(v.x for v in verts):.3f},{max(v.x for v in verts):.3f}] "
                  f"Y=[{min(v.y for v in verts):.3f},{max(v.y for v in verts):.3f}] "
                  f"Z=[{min(v.z for v in verts):.3f},{max(v.z for v in verts):.3f}]")
        xs = [v.x for v in verts]
        ys = [v.y for v in verts]
        zs = [v.z for v in verts]
        cx = (min(xs) + max(xs)) / 2
        cy = (min(ys) + max(ys)) / 2
        cz = (min(zs) + max(zs)) / 2
        # Mesh size in world units. Don't clamp to 0.5 — Rokoko bakes
        # scale=0.01 into the GLB so the character can be ~1cm wide.
        size = max(max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs), 1e-4)
        # 35mm lens FOV ~ 54deg horizontal. tan(half) = 0.51.
        # dist = (size/2) / 0.51 = size * 0.98 for tight fit. Add 30%.
        dist = size * 1.3

        if view == "front":
            cam_obj.location = (cx, cy - dist, cz)
        elif view == "side":
            cam_obj.location = (cx + dist, cy, cz)
        elif view == "3q":
            cam_obj.location = (cx + dist * 0.7, cy - dist * 0.7, cz + size * 0.2)
        else:
            cam_obj.location = (cx, cy - dist, cz)
        # Aim camera at mesh center via direct rotation (no constraints).
        cam_loc = mathutils.Vector(cam_obj.location)
        center = mathutils.Vector((cx, cy, cz))
        direction = (center - cam_loc)
        rot_quat = direction.to_track_quat("-Z", "Y")
        cam_obj.rotation_euler = rot_quat.to_euler()
        bpy.context.view_layer.update()

    # Frames to render: 25%, 50%, 75% of clip
    n_frames = max(1, e_frame - s_frame)
    frames = [
        s_frame + int(0.25 * n_frames),
        s_frame + int(0.50 * n_frames),
        s_frame + int(0.75 * n_frames),
    ]
    views = ["front", "side", "3q"]

    rendered = []
    for view in views:
        for f in frames:
            fit_camera(view, f)
            bpy.context.scene.frame_set(f)
            png_path = out_dir / f"{stem}_{view}_f{f}.png"
            bpy.context.scene.render.filepath = str(png_path)
            bpy.ops.render.render(write_still=True)
            rendered.append({"view": view, "frame": f, "path": str(png_path)})

    report = {
        "glb": glb,
        "clip_name": clip_name,
        "frame_range": [s_frame, e_frame],
        "fps": fps,
        "frames_rendered": rendered,
    }
    # The report goes to a sidecar so the outer orchestrator can read it
    report_path = out_dir / f"{stem}_render_report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"[render] OK report={report_path}")


# =============================================================================
# Outside-Blender orchestrator
# =============================================================================
def render_glb(glb_path: Path | str, out_dir: Path | str) -> list[Path]:
    """Spawn Blender headless and return the list of PNG paths."""
    glb_path = Path(glb_path).resolve()
    out_dir = Path(out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        BLENDER_EXE,
        "--background",
        "--factory-startup",
        "--python", str(THIS_FILE),
        "--",
        "--glb", str(glb_path),
        "--out-dir", str(out_dir),
    ]
    rc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if rc.returncode != 0:
        raise RuntimeError(f"Blender render failed (rc={rc.returncode}): "
                           f"{rc.stderr[-500:]}")
    report_path = out_dir / f"{glb_path.stem}_render_report.json"
    if not report_path.exists():
        raise RuntimeError(f"render report missing: {report_path}")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    return [Path(r["path"]) for r in report["frames_rendered"]]


def cli_orchestrator():
    ap = argparse.ArgumentParser()
    ap.add_argument("--glb", required=True)
    ap.add_argument("--out-dir", default="c:/tmp/qa_out")
    args = ap.parse_args()
    pngs = render_glb(args.glb, args.out_dir)
    print(json.dumps({"glb": args.glb, "pngs": [str(p) for p in pngs]}, indent=2))


def main():
    # Heuristic: inside Blender, `--` separator is present in sys.argv
    # AND we can `import bpy` cleanly with full context. Plain Python
    # might have a stub bpy on PyPI installed; we can't trust import-only.
    inside_blender = "--" in sys.argv
    if inside_blender:
        import bpy  # noqa: F401
        run_in_blender()
    else:
        cli_orchestrator()


if __name__ == "__main__":
    main()
