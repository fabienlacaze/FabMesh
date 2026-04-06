"""
FabMesh Skeleton Analyzer

Imports a FBX template via Blender (background mode) and extracts the bone
hierarchy with positions, then writes a JSON file:

{
  "bones": [
    {"name": "root", "head": [x,y,z], "tail": [x,y,z], "parent": null},
    {"name": "spine_01", "head": [x,y,z], "tail": [x,y,z], "parent": "root"},
    ...
  ],
  "bbox": {"min": [x,y,z], "max": [x,y,z]}
}

Usage:
    python analyze_skeleton.py <fbx_path> <output_json> <blender_exe>
"""
import sys
import os
import json
import subprocess
import tempfile


def build_blender_script(fbx_path, output_json):
    return f'''
import bpy
import json

print("ANALYZE: ===== START =====", flush=True)

# Clear scene
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)

fbx_path = {json.dumps(fbx_path.replace(chr(92), "/"))}
print(f"ANALYZE: importing {{fbx_path}}", flush=True)
bpy.ops.import_scene.fbx(filepath=fbx_path)

armature = None
for o in bpy.context.scene.objects:
    if o.type == 'ARMATURE':
        armature = o
        break

if not armature:
    print("ANALYZE_ERROR: no armature found", flush=True)
    raise SystemExit(1)

print(f"ANALYZE: armature='{{armature.name}}' bones={{len(armature.data.bones)}}", flush=True)

# Apply transforms so head/tail are in world space relative to origin
bpy.ops.object.select_all(action='DESELECT')
armature.select_set(True)
bpy.context.view_layer.objects.active = armature
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# Extract bones
bones_data = []
mw = armature.matrix_world
for b in armature.data.bones:
    head_w = mw @ b.head_local
    tail_w = mw @ b.tail_local
    bones_data.append({{
        "name": b.name,
        "head": [head_w.x, head_w.y, head_w.z],
        "tail": [tail_w.x, tail_w.y, tail_w.z],
        "parent": b.parent.name if b.parent else None,
    }})

# Compute armature bbox from all bone heads/tails
all_pts = []
for b in bones_data:
    all_pts.append(b["head"])
    all_pts.append(b["tail"])

if all_pts:
    xs = [p[0] for p in all_pts]
    ys = [p[1] for p in all_pts]
    zs = [p[2] for p in all_pts]
    bbox = {{
        "min": [min(xs), min(ys), min(zs)],
        "max": [max(xs), max(ys), max(zs)],
    }}
else:
    bbox = {{"min": [0,0,0], "max": [0,0,0]}}

result = {{
    "armature_name": armature.name,
    "bone_count": len(bones_data),
    "bones": bones_data,
    "bbox": bbox,
}}

output_json = {json.dumps(output_json.replace(chr(92), "/"))}
with open(output_json, "w", encoding="utf-8") as f:
    json.dump(result, f, indent=2)

print(f"ANALYZE_SUCCESS: {{output_json}} ({{len(bones_data)}} bones)", flush=True)
'''


def main():
    if len(sys.argv) < 4:
        print("Usage: python analyze_skeleton.py <fbx> <output.json> <blender_exe>")
        sys.exit(1)

    fbx_path = sys.argv[1]
    output_json = sys.argv[2]
    blender_exe = sys.argv[3]

    if not os.path.exists(fbx_path):
        print(f"ANALYZE_ERROR: fbx not found: {fbx_path}")
        sys.exit(1)
    if not os.path.exists(blender_exe):
        print(f"ANALYZE_ERROR: blender not found: {blender_exe}")
        sys.exit(1)

    script = build_blender_script(fbx_path, output_json)
    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".py", prefix="analyze_")
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            f.write(script)

        print("ANALYZE: running Blender (background)...", flush=True)
        result = subprocess.run(
            [blender_exe, "--background", "--python", tmp_path],
            capture_output=True,
            text=True,
            timeout=120,
        )
        for line in result.stdout.splitlines():
            if "ANALYZE" in line or "Error" in line or "ERROR" in line:
                print(line, flush=True)

        if result.returncode != 0:
            print(f"ANALYZE_ERROR: blender exit code {result.returncode}")
            print(result.stderr[-2000:] if result.stderr else "")
            sys.exit(1)
        if not os.path.exists(output_json):
            print("ANALYZE_ERROR: output not created")
            sys.exit(1)
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


if __name__ == "__main__":
    main()
