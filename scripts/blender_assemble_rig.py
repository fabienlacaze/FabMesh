"""Blender Assembly Script for FabMesh Auto-Rig (landmark-driven).

Runs inside Blender (--background --python blender_assemble_rig.py -- <args>).
Loads a mesh + template FBX, repositions all bones in EDIT mode to match
landmark-derived positions from the NPZ, assigns precomputed voxel heat
skinning weights, retargets animations (Block C), and exports GLB.

Key design: bones are placed in EDIT mode at the landmark positions, which
means the REST POSE equals the landmark positions. No armature_apply needed.
The GLB inverseBindMatrices will match the weight computation positions exactly.

Arguments (after '--'):
    1. mesh_path          - path to the mesh file (GLB/FBX/OBJ/STL)
    2. template_fbx_path  - path to the template FBX skeleton
    3. output_glb         - output GLB path
    4. npz_path           - path to the precomputed weights NPZ
    5. anim_dir           - path to animation FBX directory (or empty string)
    6. landmarks_json     - path to landmarks JSON (or empty string)
"""

import bpy
import os
import sys
import math
import json
import numpy as np
from mathutils import Vector, Matrix

print("AUTORIG: ===== blender_assemble_rig START =====", flush=True)

# ---------------------------------------------------------------------------
# Parse arguments (everything after '--' in sys.argv)
# ---------------------------------------------------------------------------
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(argv) < 4:
    raise RuntimeError(
        f"Expected at least 4 args after '--', got {len(argv)}: {argv}"
    )

mesh_path = argv[0].replace("\\", "/")
template_fbx_path = argv[1].replace("\\", "/")
output_glb = argv[2].replace("\\", "/")
npz_path = argv[3].replace("\\", "/")
anim_dir = argv[4].replace("\\", "/") if len(argv) > 4 and argv[4] else ""
landmarks_json_path = argv[5].replace("\\", "/") if len(argv) > 5 and argv[5] else ""

print(f"AUTORIG: mesh       = {mesh_path}", flush=True)
print(f"AUTORIG: template   = {template_fbx_path}", flush=True)
print(f"AUTORIG: output     = {output_glb}", flush=True)
print(f"AUTORIG: npz        = {npz_path}", flush=True)
print(f"AUTORIG: anim_dir   = {anim_dir}", flush=True)
print(f"AUTORIG: landmarks  = {landmarks_json_path}", flush=True)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def vertex_bbox(mesh_obj):
    """Compute world-space bbox from mesh vertices."""
    bpy.context.view_layer.update()
    mw = mesh_obj.matrix_world
    verts = mesh_obj.data.vertices
    if len(verts) == 0:
        return Vector((0, 0, 0)), Vector((0, 0, 0))
    first = mw @ verts[0].co
    mn = Vector((first.x, first.y, first.z))
    mx = Vector((first.x, first.y, first.z))
    for v in verts:
        wv = mw @ v.co
        if wv.x < mn.x: mn.x = wv.x
        if wv.y < mn.y: mn.y = wv.y
        if wv.z < mn.z: mn.z = wv.z
        if wv.x > mx.x: mx.x = wv.x
        if wv.y > mx.y: mx.y = wv.y
        if wv.z > mx.z: mx.z = wv.z
    return mn, mx


# ===================================================================
# Step 1: Clear scene
# ===================================================================
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)
print("AUTORIG: scene cleared", flush=True)


# ===================================================================
# Step 2: Import the NEW mesh (to be rigged)
# ===================================================================
ext = mesh_path.rsplit(".", 1)[-1].lower()
print(f"AUTORIG: importing mesh: {mesh_path}", flush=True)

if ext in ("glb", "gltf"):
    bpy.ops.import_scene.gltf(filepath=mesh_path)
elif ext == "fbx":
    bpy.ops.import_scene.fbx(filepath=mesh_path)
elif ext == "obj":
    bpy.ops.wm.obj_import(filepath=mesh_path)
elif ext == "stl":
    bpy.ops.import_mesh.stl(filepath=mesh_path)
else:
    raise ValueError(f"Unsupported mesh format: {ext}")

# Snapshot before template import
pre_template_names = set(o.name for o in bpy.context.scene.objects)

# Find and join all mesh objects from the import
new_meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
if not new_meshes:
    raise RuntimeError("No mesh found in imported file")

if len(new_meshes) > 1:
    bpy.ops.object.select_all(action="DESELECT")
    for o in new_meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = new_meshes[0]
    bpy.ops.object.join()

new_mesh = [o for o in bpy.context.scene.objects if o.type == "MESH"][0]
new_mesh.name = "FabMeshTarget"
print(f"AUTORIG: mesh '{new_mesh.name}' — {len(new_mesh.data.vertices)} verts",
      flush=True)

# Apply transforms
bpy.ops.object.select_all(action="DESELECT")
new_mesh.select_set(True)
bpy.context.view_layer.objects.active = new_mesh
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# Re-fetch after apply (bpy refs can become stale)
new_mesh = [o for o in bpy.context.scene.objects if o.type == "MESH"][0]

# Compute mesh bbox
nm_min, nm_max = vertex_bbox(new_mesh)
nm_size = nm_max - nm_min
nm_center = (nm_min + nm_max) / 2
nm_up_idx = max(range(3), key=lambda i: nm_size[i])
print(f"AUTORIG: mesh bbox size={tuple(nm_size)} center={tuple(nm_center)} "
      f"up={['X','Y','Z'][nm_up_idx]}", flush=True)

# Update snapshot
pre_template_names = set(o.name for o in bpy.context.scene.objects)


# ===================================================================
# Step 3: Import template FBX
# ===================================================================
print(f"AUTORIG: importing template FBX: {template_fbx_path}", flush=True)
bpy.ops.import_scene.fbx(filepath=template_fbx_path)

template_objs = [
    o for o in bpy.context.scene.objects if o.name not in pre_template_names
]
template_armature = None
template_meshes = []
for o in template_objs:
    if o.type == "ARMATURE":
        template_armature = o
    elif o.type == "MESH":
        template_meshes.append(o)

if not template_armature:
    raise RuntimeError(f"Template FBX has no ARMATURE: {template_fbx_path}")
print(f"AUTORIG: armature='{template_armature.name}' "
      f"bones={len(template_armature.data.bones)} "
      f"template_meshes={len(template_meshes)}", flush=True)


# ===================================================================
# Step 4: Apply transforms on template armature
# ===================================================================
bpy.ops.object.select_all(action="DESELECT")
template_armature.select_set(True)
for tm in template_meshes:
    tm.select_set(True)
bpy.context.view_layer.objects.active = template_armature
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
print("AUTORIG: template transforms applied", flush=True)


# ===================================================================
# Step 5: Delete template meshes (keep only armature for hierarchy)
# ===================================================================
print(f"AUTORIG: deleting {len(template_meshes)} template mesh(es)", flush=True)
for tm in list(template_meshes):
    bpy.data.objects.remove(tm, do_unlink=True)
template_meshes = []


# ===================================================================
# Step 6: Load precomputed weights + joint positions from NPZ
# ===================================================================
print(f"AUTORIG: loading precomputed weights from {npz_path}", flush=True)
npz_data = np.load(npz_path, allow_pickle=True)
weights = npz_data["weights"]              # (N, J) float32
bone_names = list(npz_data["bone_names"])   # list of str
joint_positions = npz_data["joint_positions"]  # (J, 3) — heads at landmark pos
joint_tails = npz_data["joint_tails"] if "joint_tails" in npz_data else None
is_landmark_driven = bool(npz_data["landmark_driven"]) if "landmark_driven" in npz_data else False

N_weights, J_weights = weights.shape
N_mesh = len(new_mesh.data.vertices)
print(f"AUTORIG: weights shape=({N_weights}, {J_weights})  "
      f"mesh verts={N_mesh}  bones={J_weights}  "
      f"landmark_driven={is_landmark_driven}", flush=True)

if N_weights != N_mesh:
    print(f"AUTORIG: WARNING — vertex count mismatch! weights={N_weights} "
          f"mesh={N_mesh}. Using min.", flush=True)

N_use = min(N_weights, N_mesh)


# ===================================================================
# Step 7: Reposition armature bones in EDIT mode (landmark-driven)
# ===================================================================
# By setting bone head/tail in EDIT mode, we define the REST POSE to match
# the landmark positions used for weight computation. This eliminates the
# T-pose/A-pose mismatch entirely. No armature_apply needed.
if is_landmark_driven and joint_tails is not None:
    print("AUTORIG: repositioning bones in EDIT mode to landmark positions...",
          flush=True)

    # Build NPZ bone name -> index lookup
    npz_bone_idx = {bn: i for i, bn in enumerate(bone_names)}

    bpy.ops.object.select_all(action="DESELECT")
    template_armature.select_set(True)
    bpy.context.view_layer.objects.active = template_armature
    bpy.ops.object.mode_set(mode="EDIT")

    repositioned = 0
    skipped = []
    for eb in template_armature.data.edit_bones:
        idx = npz_bone_idx.get(eb.name)
        if idx is None:
            skipped.append(eb.name)
            continue

        new_head = Vector(joint_positions[idx].tolist())
        new_tail = Vector(joint_tails[idx].tolist())

        # Ensure minimum bone length (Blender rejects zero-length bones)
        bone_vec = new_tail - new_head
        if bone_vec.length < 1e-4:
            new_tail = new_head + Vector((0, 0.02, 0))

        eb.head = new_head
        eb.tail = new_tail
        repositioned += 1

    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.context.view_layer.update()

    print(f"AUTORIG: repositioned {repositioned} bones in EDIT mode "
          f"(skipped {len(skipped)} not in NPZ)", flush=True)
    if skipped and len(skipped) <= 15:
        print(f"AUTORIG: skipped bones: {skipped}", flush=True)
else:
    print("AUTORIG: WARNING — not landmark-driven, bones stay at FBX positions",
          flush=True)


# ===================================================================
# Step 8: Assign vertex groups from precomputed weights
# ===================================================================

# Clear any existing vertex groups
while new_mesh.vertex_groups:
    new_mesh.vertex_groups.remove(new_mesh.vertex_groups[0])

# Build a mapping: bone_name -> armature bone name
armature_bone_names = {b.name.lower(): b.name for b in template_armature.data.bones}

vg_map = {}  # bone index -> vertex group
matched = 0
unmatched = []
for j, bn in enumerate(bone_names):
    if bn in armature_bone_names.values():
        real_name = bn
    elif bn.lower() in armature_bone_names:
        real_name = armature_bone_names[bn.lower()]
    else:
        real_name = bn
        unmatched.append(bn)
    vg_map[j] = new_mesh.vertex_groups.new(name=real_name)
    matched += 1

print(f"AUTORIG: created {matched} vertex groups "
      f"({len(unmatched)} without armature bone match)", flush=True)
if unmatched and len(unmatched) <= 10:
    print(f"AUTORIG: unmatched bones: {unmatched}", flush=True)

# Assign weights — for each vertex, assign to all bones with weight > threshold
WEIGHT_THRESHOLD = 1e-4
MAX_INFLUENCES = 8
assigned_count = 0

for vi in range(N_use):
    w_row = weights[vi]
    if J_weights <= MAX_INFLUENCES:
        top_indices = list(range(J_weights))
    else:
        top_indices = list(np.argpartition(w_row, -MAX_INFLUENCES)[-MAX_INFLUENCES:])

    total = 0.0
    entries = []
    for ji in top_indices:
        w = float(w_row[ji])
        if w > WEIGHT_THRESHOLD:
            entries.append((ji, w))
            total += w

    if total < 1e-8:
        ji = int(np.argmax(w_row))
        vg_map[ji].add([vi], 1.0, "REPLACE")
        assigned_count += 1
        continue

    for ji, w in entries:
        vg_map[ji].add([vi], w / total, "REPLACE")
    assigned_count += 1

print(f"AUTORIG: assigned weights to {assigned_count}/{N_use} vertices",
      flush=True)

# Add Armature modifier
if not any(m.type == "ARMATURE" for m in new_mesh.modifiers):
    mod = new_mesh.modifiers.new(name="Armature", type="ARMATURE")
    mod.object = template_armature

# Parent mesh to armature (without auto weights — we already have weights)
new_mesh.parent = template_armature
new_mesh.matrix_parent_inverse.identity()
new_mesh.matrix_world = new_mesh.matrix_world  # force update

# Verify
check_weighted = 0
for v in new_mesh.data.vertices[:200]:
    if any(g.weight > 0 for g in v.groups):
        check_weighted += 1
print(f"AUTORIG: verification — {check_weighted}/200 sampled verts have weights",
      flush=True)

# NOTE: No armature_apply needed! Bones were placed at landmark positions
# in EDIT mode, so the rest pose already matches the weight computation
# positions. The GLB inverseBindMatrices will be correct.
print("AUTORIG: rest pose = landmark positions (no armature_apply needed)",
      flush=True)

bpy.ops.object.select_all(action="DESELECT")


# ===================================================================
# Step 8 (Block C): Retarget animations
# ===================================================================
if anim_dir and os.path.isdir(anim_dir):
    import glob as _glob

    # Case-insensitive dedupe
    _seen = set()
    anim_files = []
    for p in sorted(
        _glob.glob(os.path.join(anim_dir, "*.FBX"))
        + _glob.glob(os.path.join(anim_dir, "*.fbx"))
    ):
        key = p.lower()
        if key in _seen:
            continue
        _seen.add(key)
        anim_files.append(p)
    print(f"AUTORIG: Block C — {len(anim_files)} anim FBX to retarget",
          flush=True)

    target_bone_names = set(b.name for b in template_armature.data.bones)

    for anim_fbx in anim_files:
        anim_name = os.path.splitext(os.path.basename(anim_fbx))[0]
        # Strip common prefixes for clean clip name
        clean = anim_name
        for pfx in ("AS_XXX_Y1_", "AS_XXX_", "AS_"):
            if clean.startswith(pfx):
                clean = clean[len(pfx):]
                break

        print(f"AUTORIG: Block C importing {anim_name} -> '{clean}'",
              flush=True)
        pre_objs = set(o.name for o in bpy.data.objects)
        try:
            bpy.ops.import_scene.fbx(
                filepath=anim_fbx, use_anim=True,
                automatic_bone_orientation=False,
            )
        except Exception as e:
            print(f"AUTORIG: Block C import failed for {anim_name}: {e}",
                  flush=True)
            continue

        new_objs = [o for o in bpy.data.objects if o.name not in pre_objs]
        src_arm = next((o for o in new_objs if o.type == "ARMATURE"), None)
        if src_arm is None:
            print(f"AUTORIG: Block C no armature in {anim_name}", flush=True)
            for o in new_objs:
                bpy.data.objects.remove(o, do_unlink=True)
            continue

        src_action = None
        if src_arm.animation_data and src_arm.animation_data.action:
            src_action = src_arm.animation_data.action

        # Add Copy Rotation (WORLD space) constraints on every matching bone
        bpy.ops.object.select_all(action="DESELECT")
        template_armature.select_set(True)
        bpy.context.view_layer.objects.active = template_armature
        bpy.ops.object.mode_set(mode="POSE")

        added = 0
        for pb in template_armature.pose.bones:
            src_bone = src_arm.pose.bones.get(pb.name)
            if src_bone is None:
                continue
            # Remove any leftover constraint
            for c in list(pb.constraints):
                if c.name == "FabRetargetCR":
                    pb.constraints.remove(c)
            c = pb.constraints.new("COPY_ROTATION")
            c.name = "FabRetargetCR"
            c.target = src_arm
            c.subtarget = pb.name
            # Use WORLD space so that the target bone reaches the same
            # absolute orientation as the source, regardless of rest pose
            # differences (source is T-pose anim FBX, target is landmark-pose
            # rest). WORLD space ensures visual motion is preserved.
            c.target_space = "WORLD"
            c.owner_space = "WORLD"
            added += 1
        print(f"AUTORIG: Block C added {added} Copy Rotation constraints",
              flush=True)

        # Frame range from source action
        f_start = int(bpy.context.scene.frame_start)
        f_end = int(bpy.context.scene.frame_end)
        if src_action:
            try:
                f_start = int(src_action.frame_range[0])
                f_end = int(src_action.frame_range[1])
            except (AttributeError, TypeError):
                pass
        bpy.context.scene.frame_start = f_start
        bpy.context.scene.frame_end = f_end

        # Clear active action to avoid blocking bake
        if template_armature.animation_data and template_armature.animation_data.action:
            template_armature.animation_data.action = None

        bpy.ops.pose.select_all(action="SELECT")
        try:
            bpy.ops.nla.bake(
                frame_start=f_start,
                frame_end=f_end,
                only_selected=False,
                visual_keying=True,
                clear_constraints=True,
                clear_parents=False,
                use_current_action=False,
                bake_types={"POSE"},
            )
            print(f"AUTORIG: Block C baked '{clean}' ({f_start}..{f_end})",
                  flush=True)
        except Exception as e:
            print(f"AUTORIG: Block C bake failed for {anim_name}: {e}",
                  flush=True)
            for pb in template_armature.pose.bones:
                for c in list(pb.constraints):
                    if c.name == "FabRetargetCR":
                        pb.constraints.remove(c)

        # Rename baked action, push to NLA
        bpy.ops.object.mode_set(mode="OBJECT")
        if template_armature.animation_data and template_armature.animation_data.action:
            baked_act = template_armature.animation_data.action
            baked_act.name = clean
            # Count fcurves (Blender 4.4+ compatibility)
            try:
                nfc = len(baked_act.fcurves)
            except AttributeError:
                nfc = 0
                try:
                    for layer in baked_act.layers:
                        for strip in layer.strips:
                            for cb in strip.channelbags:
                                nfc += len(cb.fcurves)
                except Exception:
                    pass
            print(f"AUTORIG: Block C action '{clean}' has {nfc} fcurves",
                  flush=True)
            try:
                track = template_armature.animation_data.nla_tracks.new()
                track.name = clean
                track.strips.new(clean, f_start, baked_act)
            except Exception as e:
                print(f"AUTORIG: Block C NLA push failed: {e}", flush=True)
            template_armature.animation_data.action = None
        else:
            print(f"AUTORIG: Block C WARNING no action produced for {anim_name}",
                  flush=True)

        # Clean up imported source objects
        for o in list(new_objs):
            try:
                bpy.data.objects.remove(o, do_unlink=True)
            except Exception:
                pass

    print("AUTORIG: Block C done", flush=True)
else:
    print("AUTORIG: Block C skipped (no anim_dir)", flush=True)


# ===================================================================
# Step 9: Persist textures (so GLB export embeds them)
# ===================================================================
import tempfile as _tempfile
_tex_tmp = os.path.join(_tempfile.gettempdir(),
                        f"fabmesh_autorig_tex_{os.getpid()}")
os.makedirs(_tex_tmp, exist_ok=True)
_saved_tex = 0
for img in list(bpy.data.images):
    if img is None or img.type != "IMAGE":
        continue
    if img.size[0] == 0 or img.size[1] == 0:
        try:
            img.reload()
        except Exception:
            pass
        if img.size[0] == 0 or img.size[1] == 0:
            continue
    safe = "".join(c if c.isalnum() or c in "._-" else "_"
                   for c in (img.name or "tex"))
    if not safe.lower().endswith((".png", ".jpg", ".jpeg", ".tga", ".bmp")):
        safe += ".png"
    target = os.path.join(_tex_tmp, safe)
    try:
        img.filepath_raw = target
        img.file_format = "PNG"
        img.save()
        try:
            img.pack()
        except Exception:
            pass
        _saved_tex += 1
    except Exception as e:
        print(f"AUTORIG: failed to save image '{img.name}': {e}", flush=True)

print(f"AUTORIG: persisted {_saved_tex} texture(s)", flush=True)
try:
    bpy.ops.file.pack_all()
except Exception as e:
    print(f"AUTORIG: pack_all failed: {e}", flush=True)


# ===================================================================
# Step 10: Cleanup orphan objects and junk actions
# ===================================================================
_keep = {new_mesh.name, template_armature.name}
for o in list(bpy.data.objects):
    if o.name not in _keep:
        try:
            bpy.data.objects.remove(o, do_unlink=True)
        except Exception:
            pass

# Keep only the clean animation action names
_KEEP_ACTIONS = {"Idle", "Walk", "Run"}
for a in list(bpy.data.actions):
    if a.name not in _KEEP_ACTIONS:
        try:
            bpy.data.actions.remove(a, do_unlink=True)
        except Exception:
            pass

print(f"AUTORIG: cleanup done — objects={len(bpy.data.objects)} "
      f"actions={len(bpy.data.actions)}", flush=True)

# Diagnostics
vg_count = len(new_mesh.vertex_groups) if hasattr(new_mesh, "vertex_groups") else 0
arm_mods = [m for m in new_mesh.modifiers if m.type == "ARMATURE"]
arm_mod_obj = (arm_mods[0].object.name
               if arm_mods and arm_mods[0].object else "none")
print(f"AUTORIG: DIAG vertex_groups={vg_count} armature_mods={len(arm_mods)} "
      f"mod.object={arm_mod_obj}", flush=True)
weighted = 0
for v in new_mesh.data.vertices[:100]:
    if any(g.weight > 0 for g in v.groups):
        weighted += 1
print(f"AUTORIG: DIAG first 100 verts with weight>0 = {weighted}", flush=True)


# ===================================================================
# Step 11: Export GLB
# ===================================================================
print(f"AUTORIG: exporting GLB to {output_glb}", flush=True)

# Ensure output directory exists
os.makedirs(os.path.dirname(output_glb) or ".", exist_ok=True)

bpy.ops.object.select_all(action="DESELECT")
new_mesh.select_set(True)
template_armature.select_set(True)
bpy.context.view_layer.objects.active = template_armature

bpy.ops.export_scene.gltf(
    filepath=output_glb,
    export_format="GLB",
    use_selection=False,
    export_apply=False,
    export_animations=True,
    export_skins=True,
    export_morph=False,
    export_yup=True,
    export_extras=False,
)

sz = os.path.getsize(output_glb) if os.path.exists(output_glb) else 0
print(f"AUTORIG_SUCCESS: {output_glb} ({sz} bytes)", flush=True)
