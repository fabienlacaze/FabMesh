"""bpy subprocess worker: load an FBX, bake its action, dump
hierarchy + per-frame euler rotations to JSON+NPZ.

GPL ISOLATION: this script imports `bpy` (GPL). The parent
`fbx_motion.parse_fbx()` invokes it via `subprocess.run()` and never
touches `bpy` itself — keeping our retarget core Apache/MIT-compatible
for commercial distribution.

Invocation:
    python bpy_worker.py <fbx_in> <out_json> <out_npz>

Output:
  <out_json>: { "names": [str], "parents": [int], "n_frames": int,
                "frame_time": float, "channels_per_bone": [str] }
  <out_npz>:  offsets (N,3) float32, euler (F,N,3) float32 DEGREES,
              root_pos (F,3) float32

The euler convention is intrinsic ZXY (matches bvhsdk default).
`scripts/anytop_retarget._eulers_to_quats` already handles this
ordering, so the retarget core consumes the output unchanged.
"""
from __future__ import annotations

import json
import math
import os
import sys
import traceback


def _err(msg: str, code: int = 1) -> None:
    """Print error to stderr (parent surfaces it in the exception) and exit."""
    sys.stderr.write(f"[bpy_worker] ERROR: {msg}\n")
    sys.stderr.flush()
    sys.exit(code)


def main() -> int:
    # FabMesh (2026-06-08): when launched via `blender -b -P bpy_worker.py -- args`,
    # Blender prepends its own argv (own script path, etc) and the real args come
    # AFTER `--`. Detect this and slice off everything up to `--`.
    argv = sys.argv
    if "--" in argv:
        idx = argv.index("--")
        args = argv[idx + 1:]
    else:
        args = argv[1:]
    if len(args) < 3:
        _err("usage: bpy_worker.py <fbx_in> <out_json> <out_npz>", 2)
    fbx_in, out_json, out_npz = args[0], args[1], args[2]
    if not os.path.isfile(fbx_in):
        _err(f"input FBX not found: {fbx_in}", 2)

    try:
        import bpy  # type: ignore
    except ImportError as e:
        _err(f"bpy import failed (install fake-bpy-module or run inside Blender): {e}", 3)
    try:
        import numpy as np  # type: ignore
    except ImportError as e:
        _err(f"numpy import failed: {e}", 3)

    # Wipe the default scene so the FBX import is isolated.
    try:
        bpy.ops.wm.read_factory_settings(use_empty=True)
    except Exception:
        # Older bpy builds don't support read_factory_settings(use_empty=True);
        # fall back to deleting everything.
        for obj in list(bpy.data.objects):
            try:
                bpy.data.objects.remove(obj, do_unlink=True)
            except Exception:
                pass

    # Import FBX. CRITICAL flags:
    #   automatic_bone_orientation=False — the default True remaps
    #   bones with Blender's own axis heuristic which BREAKS our
    #   name-keyed lookup downstream.
    #   use_anim=True — load the animation NLA strips.
    #   use_anim_action_all=True — bake every action into the scene
    #   so we can iterate frames inside the scene timeline.
    try:
        bpy.ops.import_scene.fbx(
            filepath=fbx_in,
            automatic_bone_orientation=False,
            use_anim=True,
            ignore_leaf_bones=False,
        )
    except Exception as e:
        _err(f"bpy.ops.import_scene.fbx failed: {e}\n{traceback.format_exc()}", 4)

    # Find the first armature object. ORC_M1 / UE5 mannequin FBX
    # exports always contain exactly one armature; if for some reason
    # there are more, we pick the one with the highest bone count
    # (likely the actual rig vs. a helper).
    armature_objs = [o for o in bpy.data.objects if o.type == 'ARMATURE']
    if not armature_objs:
        _err("no armature found in FBX", 5)
    arm_obj = max(armature_objs, key=lambda o: len(o.data.bones))
    arm = arm_obj.data

    # ------------------------------------------------------------
    # Walk bones in DFS order so the index layout matches what the
    # BVH parser produces (parents always come before children).
    # ------------------------------------------------------------
    names = []
    parents = []
    rest_local_head = []  # rest-pose head, parent-local — used as 'offset'
    parent_of = {}

    def _walk(bone, parent_idx):
        idx = len(names)
        names.append(bone.name)
        parents.append(parent_idx)
        parent_of[bone.name] = parent_idx
        # rest-pose offset: head position in parent's local space.
        # Blender's bone.head_local is in armature space, so we
        # subtract the parent's head_local and re-express in the
        # parent's local frame via parent.matrix_local.
        if bone.parent is not None:
            try:
                # parent.matrix_local.inverted() takes us from armature
                # space → parent-local. Compose with bone.head_local
                # (a Vector in armature space).
                head_local = bone.parent.matrix_local.inverted() @ bone.head_local
            except Exception:
                head_local = bone.head_local
        else:
            head_local = bone.head_local
        rest_local_head.append([float(head_local[0]),
                                 float(head_local[1]),
                                 float(head_local[2])])
        for c in bone.children:
            _walk(c, idx)

    for root in [b for b in arm.bones if b.parent is None]:
        _walk(root, -1)

    n = len(names)
    if n == 0:
        _err("armature has 0 bones", 6)

    # ------------------------------------------------------------
    # Frame range. Prefer the action's frame_range so we don't waste
    # cycles baking idle frames before / after the actual clip.
    # Fall back to the scene's frame_start/end.
    # ------------------------------------------------------------
    scene = bpy.context.scene
    action = None
    if arm_obj.animation_data and arm_obj.animation_data.action:
        action = arm_obj.animation_data.action
    if action is not None:
        fr_start = int(math.floor(action.frame_range[0]))
        fr_end   = int(math.ceil(action.frame_range[1]))
    else:
        fr_start = int(scene.frame_start)
        fr_end   = int(scene.frame_end)
    if fr_end < fr_start:
        fr_end = fr_start
    n_frames = fr_end - fr_start + 1
    fps = float(scene.render.fps) / max(float(scene.render.fps_base), 1e-9)
    if fps <= 0:
        fps = 30.0
    frame_time = 1.0 / fps

    # ------------------------------------------------------------
    # Bake. visual_keying=True flattens any IK / copy-rotation
    # constraints into the pose-bone rotation curves so the per-
    # frame matrix_basis reads we do below capture the FINAL pose,
    # not the input curves.
    #
    # We only bake the armature object's action — bake_types={'POSE'}.
    # ------------------------------------------------------------
    bpy.context.view_layer.objects.active = arm_obj
    arm_obj.select_set(True)
    try:
        bpy.ops.object.mode_set(mode='POSE')
    except Exception:
        pass
    try:
        bpy.ops.nla.bake(
            frame_start=fr_start, frame_end=fr_end,
            only_selected=False,
            visual_keying=True,
            clear_constraints=False,
            clear_parents=False,
            use_current_action=True,
            bake_types={'POSE'},
        )
    except Exception as e:
        # Bake can fail when there are no actions to bake (rest pose
        # only). That's not fatal — we still produce a 1-frame output.
        sys.stderr.write(f"[bpy_worker] WARN nla.bake failed: {e}\n")

    # ------------------------------------------------------------
    # Per-frame read-back. We use pose_bone.matrix_basis (the bone's
    # local rotation+translation+scale in its rest frame) and
    # decompose to Euler ZXY.
    #
    # Root translation: the armature object's loc at each frame. UE5
    # exports stick the motion on the armature object OR on the
    # pelvis bone — we copy the pelvis bone's matrix_basis translation
    # if non-zero, otherwise fall back to the armature object.
    # ------------------------------------------------------------
    euler = np.zeros((n_frames, n, 3), dtype=np.float32)
    root_pos = np.zeros((n_frames, 3), dtype=np.float32)

    # Build a name → pose_bone lookup once.
    pose_bone_by_name = {b.name: b for b in arm_obj.pose.bones}

    for fi, frame in enumerate(range(fr_start, fr_end + 1)):
        scene.frame_set(frame)
        # Refresh dependency graph so pose updates propagate (some
        # bpy builds need this after frame_set in headless mode).
        try:
            bpy.context.view_layer.update()
        except Exception:
            pass
        for bi, name in enumerate(names):
            pb = pose_bone_by_name.get(name)
            if pb is None:
                continue
            # matrix_basis is the bone's animated transform relative
            # to its rest. Extract its rotation and convert to ZXY.
            try:
                eul = pb.matrix_basis.to_euler('ZXY')
                # to_euler gives radians — convert to degrees.
                euler[fi, bi, 0] = math.degrees(eul.x)
                euler[fi, bi, 1] = math.degrees(eul.y)
                euler[fi, bi, 2] = math.degrees(eul.z)
            except Exception:
                pass

        # Root translation. Prefer the pelvis (root bone in DFS).
        # If absent, use the armature object location.
        root_name = names[0]
        pb_root = pose_bone_by_name.get(root_name)
        if pb_root is not None:
            tr = pb_root.location  # parent-local translation
            root_pos[fi, 0] = float(tr.x)
            root_pos[fi, 1] = float(tr.y)
            root_pos[fi, 2] = float(tr.z)
        else:
            loc = arm_obj.location
            root_pos[fi, 0] = float(loc.x)
            root_pos[fi, 1] = float(loc.y)
            root_pos[fi, 2] = float(loc.z)

    # ------------------------------------------------------------
    # Serialise.
    # ------------------------------------------------------------
    meta = {
        "names": names,
        "parents": parents,
        "n_frames": int(n_frames),
        "frame_time": float(frame_time),
        # The retarget core's `_eulers_to_quats` parses these to
        # build a 3-char scipy intrinsic rotation order. We use ZXY
        # because Blender's `to_euler('ZXY')` matches it.
        "channels_per_bone": ["Zrotation", "Xrotation", "Yrotation"],
        "armature_name": arm_obj.name,
        "armature_bone_count": len(names),
    }
    try:
        with open(out_json, "w", encoding="utf-8") as f:
            json.dump(meta, f)
    except Exception as e:
        _err(f"writing {out_json} failed: {e}", 7)

    try:
        offsets = np.asarray(rest_local_head, dtype=np.float32)
        np.savez(out_npz,
                 offsets=offsets,
                 euler=euler,
                 root_pos=root_pos)
    except Exception as e:
        _err(f"writing {out_npz} failed: {e}", 7)

    print(f"[bpy_worker] DONE bones={n} frames={n_frames} fps={fps:.1f}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
