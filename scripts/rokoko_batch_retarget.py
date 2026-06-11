"""Batch retarget Apovivor FBX motions onto Puppeteer-rigged GLBs
using the Rokoko Studio Live Blender addon (LGPL-3.0).

Workflow w96ogz3vm verified:
  - Addon is LGPL-3.0, commercial Steam-sale safe (no bundling)
  - All retargeting features are free, no paywall
  - bpy.ops.rsl.build_bone_list + bpy.ops.rsl.retarget_animation work
    headless. Login NOT required for the operators to run.
  - REQUIRES Blender 4.4.3 (issues #131/#135 break the addon on 5.x).

Usage (one retarget):
    /c/tools/blender-4.4.3-windows-x64/blender.exe \\
        --background --factory-startup --python THIS_FILE -- \\
        --src-fbx c:/tmp/apovivor_fbx/1_Source/ANIM_AS_Robot1_Walk.fbx \\
        --tgt-glb c:/tmp/test_b1_humanoid_05.glb \\
        --out-dir c:/tmp/rokoko_out/

Usage (batch over a directory of motions x dir of rigs):
    python scripts/rokoko_batch_retarget.py \\
        --motions-dir c:/tmp/apovivor_fbx/1_Source \\
        --rigs-dir c:/tmp/training_rigs/humanoid \\
        --out-dir c:/tmp/rokoko_out/ \\
        --jobs 4

The batch mode is the OUTER orchestrator that spawns N Blender
subprocesses (each runs THIS_FILE in single-retarget mode). One
subprocess per (motion, rig) pair so a stuck nla.bake (issue #65)
can't poison the rest.
"""
from __future__ import annotations
import argparse
import os
import subprocess
import sys
import time
from pathlib import Path


BLENDER_EXE = r"c:/tools/blender-4.4.3-windows-x64/blender.exe"
THIS_FILE = Path(__file__).resolve()


# =============================================================================
# Single-retarget mode (run inside Blender)
# =============================================================================
def _inside_blender():
    """Return True if invoked as `blender --python THIS_FILE -- ...`."""
    return "bpy" in sys.modules or "BLENDER_USER_CONFIG" in os.environ or \
           any(arg.endswith("blender.exe") or arg.endswith("blender") for arg in sys.argv[:1])


def run_single_retarget():
    """Run inside Blender. Reads CLI args after `--` and writes one GLB."""
    import bpy
    import traceback

    # Args after `--`
    try:
        i = sys.argv.index("--")
        argv = sys.argv[i + 1:]
    except ValueError:
        argv = []
    def get(k, default=None):
        if k in argv:
            return argv[argv.index(k) + 1]
        return default

    src_fbx = get("--src-fbx")
    tgt_glb = get("--tgt-glb")
    out_dir = get("--out-dir", "c:/tmp/rokoko_out")
    if not src_fbx or not tgt_glb:
        print(f"[rokoko-single] missing --src-fbx or --tgt-glb")
        sys.exit(2)
    os.makedirs(out_dir, exist_ok=True)

    print(f"[rokoko-single] src={src_fbx}")
    print(f"[rokoko-single] tgt={tgt_glb}")

    # Clean slate
    bpy.ops.wm.read_factory_settings(use_empty=True)

    # Ensure addon enabled (no-op if already)
    try:
        bpy.ops.preferences.addon_enable(module="rokoko-studio-live-blender")
    except Exception as e:
        print(f"[rokoko-single] addon_enable failed: {e}")
        sys.exit(3)

    # Import target rig (GLB) — keep armature + skinned mesh
    bpy.ops.import_scene.gltf(filepath=tgt_glb)
    tgt_arm = next((o for o in bpy.context.scene.objects if o.type == "ARMATURE"), None)
    if tgt_arm is None:
        print("[rokoko-single] no target ARMATURE found in GLB")
        sys.exit(4)
    print(f"[rokoko-single] target armature: {tgt_arm.name}, "
          f"{len(tgt_arm.data.bones)} bones")

    # 2026-06-11: Rokoko's build_bone_list auto-detect needs semantic
    # bone names on BOTH sides to find Hips/Spine/LeftArm/etc. The
    # Puppeteer output has anonymous joint0..jointN, so the matcher
    # fails with "No root bone found". Rename target bones to canonical
    # names using the labels.json sidecar produced by
    # scripts/puppeteer_semantic_extractor.py. Names are stripped of
    # chain indices (Rokoko expects "LeftArm" / "LeftForeArm" / "LeftHand"
    # rather than "LeftArm00..LeftArm03") and mapped to the Mixamo-style
    # vocabulary that the auto-detect tables ship with.
    labels_path = tgt_glb + ".labels.json"
    labels = None
    if os.path.isfile(labels_path):
        import json
        raw = json.loads(open(labels_path, "r", encoding="utf-8").read())
        if isinstance(raw, list):
            labels = {i: raw[i] for i in range(len(raw))}
        elif isinstance(raw, dict) and "labels" in raw:
            ll = raw["labels"]
            if isinstance(ll, dict):
                labels = {int(k): v for k, v in ll.items()}
            else:
                labels = {i: ll[i] for i in range(len(ll))}
        else:
            labels = {int(k): v for k, v in raw.items()}
    else:
        # 2026-06-11: fallback for rigs without labels.json sidecar.
        # The 50 humanoid rigs in c:/tmp/training_rigs/ were rigged
        # before the puppeteer_bridge sidecar patch. Use the renamer's
        # geometric heuristic to recover per-joint role names without
        # needing the pred.txt sidecar.
        sys.path.insert(0, r"c:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/scripts")
        try:
            from puppeteer_joint_renamer import rename_for_anytop
        except Exception as e:
            print(f"[rokoko-single] WARN renamer import failed: {e}")
            rename_for_anytop = None
        if rename_for_anytop is not None:
            joint_idxs = []
            parent_by_idx = {}
            world_by_idx = {}
            name_by_idx = {}
            # Walk the GLB's armature in Blender to get rest world pose
            for i, bone in enumerate(tgt_arm.data.bones):
                joint_idxs.append(i)
                name_by_idx[i] = bone.name
                parent_by_idx[i] = (
                    list(tgt_arm.data.bones).index(bone.parent)
                    if bone.parent is not None else -1
                )
                # Rest world position: armature_matrix @ bone.head_local
                head_world = tgt_arm.matrix_world @ bone.head_local
                import numpy as _np
                world_by_idx[i] = _np.array([head_world.x, head_world.y, head_world.z])
            renamed_dict = rename_for_anytop(
                joint_idxs, parent_by_idx, world_by_idx, name_by_idx, force=True,
            )
            labels = renamed_dict
            print(f"[rokoko-single] labels recovered via "
                  f"puppeteer_joint_renamer ({len(labels)} entries)")
        else:
            print(f"[rokoko-single] WARN no labels.json AND no renamer "
                  f"-> Rokoko auto-detect will likely fail")
            labels = {}

    if labels:

        # Map our extractor vocabulary -> Mixamo-style names that
        # Rokoko's bone-list auto-detect recognises. Includes both
        # humanoid (LeftArm/RightLeg/...) AND quadruped (FrontLeftLeg/
        # RearLeftLeg/Tail/...) vocabularies. Rokoko's auto-detect
        # only recognises humanoid names — for quadruped chains we
        # invent our own canonical names; Rokoko ignores the dictionary
        # match and just uses whatever string we put in
        # rsl_retargeting_bone_list, so the auto-detect path is
        # effectively bypassed.
        MIXAMO_NAME = {
            # Humanoid
            "Hips":      "Hips",
            "Spine00":   "Spine",
            "Spine01":   "Spine1",
            "Spine02":   "Spine2",
            "Spine03":   "Spine3",
            "Neck00":    "Neck",
            "Neck01":    "Neck1",
            "Neck02":    "Neck2",
            "Head00":    "Head",
            "LeftArm00":  "LeftShoulder",
            "LeftArm01":  "LeftArm",
            "LeftArm02":  "LeftForeArm",
            "LeftArm03":  "LeftHand",
            "RightArm00": "RightShoulder",
            "RightArm01": "RightArm",
            "RightArm02": "RightForeArm",
            "RightArm03": "RightHand",
            "LeftLeg00":  "LeftUpLeg",
            "LeftLeg01":  "LeftLeg",
            "LeftLeg02":  "LeftFoot",
            "LeftLeg03":  "LeftToeBase",
            "RightLeg00": "RightUpLeg",
            "RightLeg01": "RightLeg",
            "RightLeg02": "RightFoot",
            "RightLeg03": "RightToeBase",
            # Quadruped — invented canonical names, mapped directly
            # via EXPLICIT_PAIRS at the rsl_bone_list step below.
            "RearLeftLeg00":  "RearLeftUpLeg",
            "RearLeftLeg01":  "RearLeftLeg",
            "RearLeftLeg02":  "RearLeftAnkle",
            "RearLeftLeg03":  "RearLeftFoot",
            "RearLeftLeg04":  "RearLeftToeBase",
            "RearRightLeg00": "RearRightUpLeg",
            "RearRightLeg01": "RearRightLeg",
            "RearRightLeg02": "RearRightAnkle",
            "RearRightLeg03": "RearRightFoot",
            "RearRightLeg04": "RearRightToeBase",
            "FrontLeftLeg00":  "FrontLeftShoulder",
            "FrontLeftLeg01":  "FrontLeftUpLeg",
            "FrontLeftLeg02":  "FrontLeftLeg",
            "FrontLeftLeg03":  "FrontLeftFoot",
            "FrontLeftLeg04":  "FrontLeftToeBase",
            "FrontRightLeg00": "FrontRightShoulder",
            "FrontRightLeg01": "FrontRightUpLeg",
            "FrontRightLeg02": "FrontRightLeg",
            "FrontRightLeg03": "FrontRightFoot",
            "Tail00": "Tail",
            "Tail01": "Tail1",
            "Tail02": "Tail2",
            "Tail03": "Tail3",
            "Tail04": "Tail4",
            "Tail05": "Tail5",
            "Tail06": "Tail6",
            # Winged biped (dragons / wyverns)
            "LeftLeg04":  "LeftFoot4",
            "LeftLeg05":  "LeftFoot5",
            "LeftLeg06":  "LeftToeBase",
            "RightLeg04": "RightFoot4",
            "RightLeg05": "RightFoot5",
            "RightLeg06": "RightToeBase",
            "LeftWing00":  "LeftWingArm",
            "LeftWing01":  "LeftWingForearm",
            "LeftWing02":  "LeftWingHand",
            # 2026-06-12 FIX wings (workflow wyxzfsg1x): do NOT rewrite
            # LeftWing03/04 into LeftWingFinger1/2 because labels.json
            # may already declare distinct bones with those names —
            # Blender auto-suffixes `.001` on collision and the
            # EXPLICIT_PAIRS lookup at `tgt_name not in tgt_bone_names`
            # silently drops the pair. Keep `LeftWingFingerAN/BN/CN`
            # literal so each finger has a unique target name.
            "RightWing00": "RightWingArm",
            "RightWing01": "RightWingForearm",
            "RightWing02": "RightWingHand",
        }
        renamed = 0
        for pred_idx, lbl in labels.items():
            new_name = MIXAMO_NAME.get(lbl, lbl)
            old_name = f"joint{pred_idx}"
            if old_name not in tgt_arm.data.bones:
                continue
            # 2026-06-12 FIX wings (workflow wyxzfsg1x): collision-guard.
            # Never rename onto an existing bone name — Blender silently
            # auto-suffixes `.001` and the EXPLICIT_PAIRS lookup later
            # drops the pair because `tgt_name not in tgt_bone_names`.
            if new_name in tgt_arm.data.bones and new_name != old_name:
                continue
            tgt_arm.data.bones[old_name].name = new_name
            renamed += 1
        print(f"[rokoko-single] renamed {renamed} target bones via labels.json "
              f"-> Mixamo vocab")
    else:
        print(f"[rokoko-single] WARN no labels.json next to {tgt_glb} — "
              f"Rokoko auto-detect will likely fail on jointN names")

    # Import source FBX — carries the animation on its own armature
    before = set(bpy.data.objects.keys())
    bpy.ops.import_scene.fbx(filepath=src_fbx)
    new_objs = [bpy.data.objects[n] for n in bpy.data.objects.keys()
                if n not in before]
    src_arm = next((o for o in new_objs
                    if o.type == "ARMATURE" and o.animation_data
                    and o.animation_data.action), None)
    if src_arm is None:
        # Fallback: any armature
        src_arm = next((o for o in new_objs if o.type == "ARMATURE"), None)
    if src_arm is None:
        print("[rokoko-single] no source ARMATURE in FBX")
        sys.exit(5)
    print(f"[rokoko-single] source armature: {src_arm.name}, "
          f"{len(src_arm.data.bones)} bones, "
          f"action={src_arm.animation_data.action.name if src_arm.animation_data else None}")

    # Configure Rokoko retargeting via Scene PointerProperties
    scn = bpy.context.scene
    scn.rsl_retargeting_armature_source = src_arm
    scn.rsl_retargeting_armature_target = tgt_arm
    # Auto-scale wipes hip positions (issue #67) — leave it off, the
    # source vs target height is normalized separately if needed.
    if hasattr(scn, "rsl_retargeting_auto_scaling"):
        scn.rsl_retargeting_auto_scaling = False
    if hasattr(scn, "rsl_retargeting_use_pose"):
        scn.rsl_retargeting_use_pose = "REST"

    # 2026-06-11: bypass Rokoko's auto-detect. Pick humanoid vs
    # quadruped mapping based on what we see in the source FBX
    # (presence of "thigh_l" or "LizardLFrontLeg*").
    EXPLICIT_PAIRS_HUMANOID = [
        ("pelvis",       "Hips"),
        ("spine_01",     "Spine"),
        ("spine_02",     "Spine1"),
        ("spine_03",     "Spine2"),
        ("spine_05",     "Spine3"),
        ("neck_01",      "Neck"),
        ("head",         "Head"),
        ("clavicle_l",   "LeftShoulder"),
        ("upperarm_l",   "LeftArm"),
        ("lowerarm_l",   "LeftForeArm"),
        ("hand_l",       "LeftHand"),
        ("clavicle_r",   "RightShoulder"),
        ("upperarm_r",   "RightArm"),
        ("lowerarm_r",   "RightForeArm"),
        ("hand_r",       "RightHand"),
        ("thigh_l",      "LeftUpLeg"),
        ("calf_l",       "LeftLeg"),
        ("foot_l",       "LeftFoot"),
        ("ball_l",       "LeftToeBase"),
        ("thigh_r",      "RightUpLeg"),
        ("calf_r",       "RightLeg"),
        ("foot_r",       "RightFoot"),
        ("ball_r",       "RightToeBase"),
    ]

    # Lizard / Apovivor quadruped naming. Source bone names have
    # arbitrary numeric suffixes (e.g. "LizardLLegThigh11",
    # "LizardLLegCalf323") -> match by prefix instead.
    QUADRUPED_PREFIX_MAP = [
        ("LizardSpine1",            "Hips"),
        ("LizardSpine2",            "Spine"),
        ("LizardSpine3",            "Spine1"),
        ("LizardSpine4",            "Spine2"),
        ("LizardSpine5",            "Spine3"),
        ("LizardSpine6",            "Spine3"),  # collapses if Spine3 already used
        ("LizardRibcage",           "Spine3"),
        ("LizardNeck1",             "Neck"),
        ("LizardNeck2",             "Neck1"),
        ("LizardNeck3",             "Neck2"),
        ("LizardNeck4",             "Neck2"),
        ("LizardHead",              "Head"),
        ("LizardLLegThigh",         "RearLeftUpLeg"),
        ("LizardLLegCalf",          "RearLeftLeg"),
        ("LizardLLegAnkle",         "RearLeftAnkle"),
        ("LizardLLegDigit",         "RearLeftFoot"),
        ("LizardRRearLegThigh",     "RearRightUpLeg"),
        ("LizardRRearLegCalf",      "RearRightLeg"),
        ("LizardRRearLegAnkle",     "RearRightAnkle"),
        ("LizardRRearLegDigit",     "RearRightFoot"),
        ("LizardLFrontLegCollarbone", "FrontLeftShoulder"),
        ("LizardLFrontLegUpper",      "FrontLeftUpLeg"),
        ("LizardLFrontLegLower",      "FrontLeftLeg"),
        ("LizardLFrontLegPalm",       "FrontLeftFoot"),
        ("LizardLFrontLegDigit",      "FrontLeftToeBase"),
        ("LizardRFrontLegCollarbone", "FrontRightShoulder"),
        ("LizardRFrontLegUpper",      "FrontRightUpLeg"),
        ("LizardRFrontLegLower",      "FrontRightLeg"),
        ("LizardRFrontLegPalm",       "FrontRightFoot"),
        ("LizardTail1",  "Tail"),
        ("LizardTail2",  "Tail1"),
        ("LizardTail3",  "Tail2"),
        ("LizardTail4",  "Tail3"),
        ("LizardTail5",  "Tail4"),
        ("LizardTail6",  "Tail5"),
        ("LizardTail7",  "Tail6"),
    ]

    # Winged biped (mountain dragon) source bone prefix mapping.
    # Source bones have a leading "MOUNTAIN_DRAGON_" prefix plus a SPACE
    # before the bone short name (e.g. "MOUNTAIN_DRAGON_ Pelvis").
    WINGED_BIPED_PREFIX_MAP = [
        ("MOUNTAIN_DRAGON_ Pelvis",   "Hips"),
        ("MOUNTAIN_DRAGON_ Spine2",   "Spine01"),  # Trellis target is shorter
        ("MOUNTAIN_DRAGON_ Spine1",   "Spine00"),  # Spine -> Hips
        ("MOUNTAIN_DRAGON_ Neck5",    "Neck01"),
        ("MOUNTAIN_DRAGON_ Neck1",    "Neck00"),
        ("MOUNTAIN_DRAGON_ Head",     "Head00"),
        ("MOUNTAIN_DRAGON_ L Thigh",  "LeftLeg00"),
        ("MOUNTAIN_DRAGON_ L Calf",   "LeftLeg01"),
        ("MOUNTAIN_DRAGON_ L HorseLink", "LeftLeg02"),
        ("MOUNTAIN_DRAGON_ L Foot",   "LeftLeg03"),
        ("MOUNTAIN_DRAGON_ L Toe0",   "LeftLeg04"),
        ("MOUNTAIN_DRAGON_ L Toe1",   "LeftLeg05"),
        ("MOUNTAIN_DRAGON_ R Thigh",  "RightLeg00"),
        ("MOUNTAIN_DRAGON_ R Calf",   "RightLeg01"),
        ("MOUNTAIN_DRAGON_ R HorseLink", "RightLeg02"),
        ("MOUNTAIN_DRAGON_ R Foot",   "RightLeg03"),
        ("MOUNTAIN_DRAGON_ R Toe0",   "RightLeg04"),
        ("MOUNTAIN_DRAGON_ R Toe1",   "RightLeg05"),
        ("MOUNTAIN_DRAGON_WING_L_ARM",     "LeftWing00"),
        ("MOUNTAIN_DRAGON_WING_L_FOREARM", "LeftWing01"),
        ("MOUNTAIN_DRAGON_WING_L_HAND",    "LeftWing02"),
        # 2026-06-12 FIX wings: full A/B/C finger coverage. Mountain
        # Dragon has 4 finger chains per wing (A/B/C/D). FINGER_B is
        # the LONGEST — it drives the wing tip + leading-edge membrane.
        # Mapping only A_1/A_2 left the wing visually static.
        ("MOUNTAIN_DRAGON_WING_L_FINGER_A_1", "LeftWingFingerA0"),
        ("MOUNTAIN_DRAGON_WING_L_FINGER_A_2", "LeftWingFingerA1"),
        ("MOUNTAIN_DRAGON_WING_L_FINGER_B_1", "LeftWingFingerB0"),
        ("MOUNTAIN_DRAGON_WING_L_FINGER_B_2", "LeftWingFingerB1"),
        ("MOUNTAIN_DRAGON_WING_L_FINGER_C_1", "LeftWingFingerC0"),
        ("MOUNTAIN_DRAGON_WING_L_FINGER_C_2", "LeftWingFingerC1"),
        ("MOUNTAIN_DRAGON_WING_R_ARM",     "RightWing00"),
        ("MOUNTAIN_DRAGON_WING_R_FOREARM", "RightWing01"),
        ("MOUNTAIN_DRAGON_WING_R_HAND",    "RightWing02"),
        ("MOUNTAIN_DRAGON_WING_R_FINGER_A_1", "RightWingFingerA0"),
        ("MOUNTAIN_DRAGON_WING_R_FINGER_A_2", "RightWingFingerA1"),
        ("MOUNTAIN_DRAGON_WING_R_FINGER_B_1", "RightWingFingerB0"),
        ("MOUNTAIN_DRAGON_WING_R_FINGER_B_2", "RightWingFingerB1"),
        ("MOUNTAIN_DRAGON_WING_R_FINGER_C_1", "RightWingFingerC0"),
        ("MOUNTAIN_DRAGON_WING_R_FINGER_C_2", "RightWingFingerC1"),
        ("MOUNTAIN_DRAGON_ Tail",  "Tail00"),
        ("MOUNTAIN_DRAGON_ Tail1", "Tail01"),
        ("MOUNTAIN_DRAGON_ Tail3", "Tail02"),
        ("MOUNTAIN_DRAGON_ Tail5", "Tail03"),
        ("MOUNTAIN_DRAGON_ Tail7", "Tail04"),
        ("MOUNTAIN_DRAGON_ Tail9", "Tail05"),
        ("MOUNTAIN_DRAGON_ Tail11", "Tail06"),
    ]

    # Now apply the same MIXAMO_NAME map to TARGET roles (Hips/Spine00/...)
    # so the rsl_retargeting_bone_list keys match the renamed bones.
    def _to_mixamo_target(role):
        return MIXAMO_NAME.get(role, role)
    WINGED_BIPED_PAIRS_MAPPED = [(s, _to_mixamo_target(t))
                                 for s, t in WINGED_BIPED_PREFIX_MAP]

    src_names = [b.name for b in src_arm.data.bones]
    is_quadruped = any(n.startswith("Lizard") for n in src_names)
    is_winged_biped = any(n.startswith("MOUNTAIN_DRAGON") for n in src_names)
    if is_winged_biped:
        # Resolve prefix matches for mountain dragon source.
        EXPLICIT_PAIRS = []
        used_src = set()
        used_tgt = set()
        for prefix, tgt in WINGED_BIPED_PAIRS_MAPPED:
            for n in src_names:
                if n.startswith(prefix) and n not in used_src and tgt not in used_tgt:
                    EXPLICIT_PAIRS.append((n, tgt))
                    used_src.add(n)
                    used_tgt.add(tgt)
                    break
        print(f"[rokoko-single] mode=WINGED_BIPED ({len(EXPLICIT_PAIRS)} pairs resolved)")
    elif is_quadruped:
        # Resolve prefix matches: for each prefix, find the first
        # source bone that starts with it (skip if already used).
        EXPLICIT_PAIRS = []
        used_src = set()
        used_tgt = set()
        for prefix, tgt in QUADRUPED_PREFIX_MAP:
            for n in src_names:
                if n.startswith(prefix) and n not in used_src and tgt not in used_tgt:
                    EXPLICIT_PAIRS.append((n, tgt))
                    used_src.add(n)
                    used_tgt.add(tgt)
                    break
        print(f"[rokoko-single] mode=QUADRUPED ({len(EXPLICIT_PAIRS)} explicit pairs resolved)")
    else:
        EXPLICIT_PAIRS = EXPLICIT_PAIRS_HUMANOID
        print(f"[rokoko-single] mode=HUMANOID ({len(EXPLICIT_PAIRS)} explicit pairs)")
    src_bone_names = {b.name for b in src_arm.data.bones}
    tgt_bone_names = {b.name for b in tgt_arm.data.bones}

    # 2026-06-12: AUTO-DETECT forward axis alignment.
    # The Apovivor source FBX always faces some consistent direction
    # (Mixamo: +Y forward in Z-up world; Blender FBX import flips to
    # +Y forward in Y-up world). The Trellis+Puppeteer target faces
    # an arbitrary direction depending on how Trellis oriented the mesh
    # during generation. Without alignment, Rokoko's COPY_ROTATION
    # constraint copies local rotations into target bone-local frames
    # that don't share source's forward axis -> "pas chassé" (legs
    # swing laterally instead of forward/back).
    # Fix: rotate the target armature object around its UP axis so its
    # rest-pose forward (Hips->Head horizontal vector) aligns with the
    # source rest-pose forward.
    def _horizontal_forward(arm_obj, hips_name, head_candidates):
        """Return a unit vector pointing FROM hips TO head, with the
        UP component zeroed out. Up = world Z in Blender."""
        import mathutils
        if hips_name not in arm_obj.data.bones:
            return None
        hips_world = arm_obj.matrix_world @ arm_obj.data.bones[hips_name].head_local
        head_world = None
        for n in head_candidates:
            if n in arm_obj.data.bones:
                head_world = arm_obj.matrix_world @ arm_obj.data.bones[n].head_local
                break
        if head_world is None:
            return None
        v = head_world - hips_world
        v.z = 0.0  # project onto horizontal plane (Blender world is Z-up)
        if v.length < 1e-6:
            return None
        return v.normalized()

    # 2026-06-12 FIX wings (workflow wyxzfsg1x): previous head_candidates
    # used exact match. Mountain Dragon source bones are named
    # "MOUNTAIN_DRAGON_ Head" (with trailing space prefix), so neither
    # pelvis nor head matched -> src_fwd=None -> auto-align silently
    # skipped -> wing flap plane wrong + messy body skeleton.
    def _find_bone_loose(arm, candidates):
        names = [b.name for b in arm.data.bones]
        # Exact match first
        for c in candidates:
            if c in names:
                return c
        # Case-insensitive substring match
        for c in candidates:
            cl = c.lower()
            for n in names:
                if cl in n.lower():
                    return n
        return None

    src_hips = _find_bone_loose(src_arm,
        ["pelvis", "Pelvis", "Hips", "LizardSpine1"])
    src_head = _find_bone_loose(src_arm,
        ["Head", "Neck1", "Neck5", "LizardHead"])
    src_fwd = _horizontal_forward(src_arm, src_hips,
                                  [src_head] if src_head else [])
    tgt_fwd = _horizontal_forward(tgt_arm, "Hips",
                                  ["Head", "Head00", "Neck", "Neck00", "Neck1"])
    print(f"[rokoko-single] forward auto-align inputs: "
          f"src_hips={src_hips} src_head={src_head} "
          f"src_fwd={src_fwd} tgt_fwd={tgt_fwd}")
    if src_fwd is not None and tgt_fwd is not None:
        import mathutils, math
        # Angle from tgt_fwd to src_fwd around world Z (signed).
        # cross.z > 0 -> src is COUNTERCLOCKWISE from tgt (looking down Z).
        dot = max(-1.0, min(1.0, src_fwd.dot(tgt_fwd)))
        ang = math.acos(dot)
        cross_z = tgt_fwd.x * src_fwd.y - tgt_fwd.y * src_fwd.x
        if cross_z < 0:
            ang = -ang
        print(f"[rokoko-single] forward auto-align: src_fwd={src_fwd[:]} "
              f"tgt_fwd={tgt_fwd[:]} rotation around Z = {math.degrees(ang):.1f} deg")
        # Rotate target armature object by `ang` around world Z so its
        # rest-pose forward now matches source's forward.
        if abs(math.degrees(ang)) > 1.0:
            tgt_arm.rotation_mode = "XYZ"
            tgt_arm.rotation_euler = (
                tgt_arm.rotation_euler.x,
                tgt_arm.rotation_euler.y,
                tgt_arm.rotation_euler.z + ang,
            )
            # Apply the rotation into the armature DATA so the rest
            # pose itself rotates (otherwise it's just an object-level
            # rotation that gets reset by our TRS cleanup later).
            bpy.context.view_layer.objects.active = tgt_arm
            bpy.ops.object.select_all(action="DESELECT")
            tgt_arm.select_set(True)
            bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    else:
        print(f"[rokoko-single] forward auto-align SKIPPED (src_fwd={src_fwd}, "
              f"tgt_fwd={tgt_fwd})")

    try:
        # Clear then add explicit entries
        scn.rsl_retargeting_bone_list.clear()
        added = 0
        for src_name, tgt_name in EXPLICIT_PAIRS:
            if src_name not in src_bone_names:
                continue
            if tgt_name not in tgt_bone_names:
                continue
            item = scn.rsl_retargeting_bone_list.add()
            item.bone_name_source = src_name
            item.bone_name_target = tgt_name
            added += 1
        print(f"[rokoko-single] bone list (explicit): {added} entries")
        if added < 12:
            print("[rokoko-single] WARN: less than 12 explicit pairs matched — "
                  "rig/source may be missing standard humanoid bones.")
        bpy.ops.rsl.retarget_animation()
    except Exception:
        print("[rokoko-single] retarget failed:")
        traceback.print_exc()
        sys.exit(6)

    # 2026-06-11 (workflow w0llhdmri fix #2): clean the export so each
    # output GLB has exactly one animation (the retarget) and no baked
    # Armature scale.
    # (a) Reset target armature TRS. Rokoko bakes the source FBX scale
    #     (0.01 from Unreal Take FBXs) into the target Armature's
    #     scale on its object-level action when it copies the source
    #     animation, even though the bones themselves are correctly
    #     retargeted. Reset object TRS to identity.
    tgt_arm.location = (0.0, 0.0, 0.0)
    tgt_arm.rotation_euler = (0.0, 0.0, 0.0)
    if tgt_arm.rotation_mode == "QUATERNION":
        tgt_arm.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
    tgt_arm.scale = (1.0, 1.0, 1.0)
    # (b) Strip object-level fcurves (location/scale/rotation_*) from
    #     all actions — only keep pose.bones[...]
    for action in bpy.data.actions:
        bad = [fc for fc in action.fcurves
               if not fc.data_path.startswith("pose.bones[")]
        for fc in bad:
            action.fcurves.remove(fc)
    # (c) Remove the source 'Base Layer' action so only the retargeted
    #     clip ends up in the GLB.
    for a in list(bpy.data.actions):
        if "Retarget" not in a.name:
            bpy.data.actions.remove(a)
    # (d) Make sure the target armature is using the Retarget action
    if tgt_arm.animation_data is None:
        tgt_arm.animation_data_create()
    retarget_actions = [a for a in bpy.data.actions if "Retarget" in a.name]
    if retarget_actions:
        tgt_arm.animation_data.action = retarget_actions[0]

    # Export the target rig + mesh as GLB with the new animation
    bpy.ops.object.select_all(action="DESELECT")
    tgt_arm.select_set(True)
    for c in tgt_arm.children_recursive:
        c.select_set(True)
    out_name = f"{Path(src_fbx).stem}__{Path(tgt_glb).stem}.glb"
    out_path = Path(out_dir) / out_name
    bpy.ops.export_scene.gltf(
        filepath=str(out_path),
        use_selection=True,
        export_animations=True,
        export_format="GLB",
    )
    print(f"[rokoko-single] OK -> {out_path}")


# =============================================================================
# Batch orchestrator (runs in plain Python, spawns Blender subprocesses)
# =============================================================================
def run_batch():
    ap = argparse.ArgumentParser()
    ap.add_argument("--motions-dir", required=True)
    ap.add_argument("--rigs-dir",    required=True)
    ap.add_argument("--out-dir",     default="c:/tmp/rokoko_out")
    ap.add_argument("--motion-glob", default="*.fbx")
    ap.add_argument("--rig-glob",    default="*.glb")
    ap.add_argument("--jobs", type=int, default=1,
                    help="parallel Blender processes (CPU-bound nla.bake)")
    ap.add_argument("--limit", type=int, default=None,
                    help="cap total (motion, rig) pairs for testing")
    args = ap.parse_args()

    motions = sorted(Path(args.motions_dir).glob(args.motion_glob))
    rigs = sorted(Path(args.rigs_dir).glob(args.rig_glob))
    pairs = [(m, r) for r in rigs for m in motions]
    if args.limit:
        pairs = pairs[: args.limit]
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"[rokoko-batch] {len(motions)} motions x {len(rigs)} rigs "
          f"= {len(pairs)} pairs, jobs={args.jobs}")

    from concurrent.futures import ProcessPoolExecutor, as_completed
    t0 = time.time()
    done = 0
    failed = 0

    def _run_one(m: Path, r: Path):
        out_name = f"{m.stem}__{r.stem}.glb"
        out_path = out_dir / out_name
        if out_path.exists():
            return ("skip", str(out_path))
        cmd = [
            BLENDER_EXE,
            "--background",
            "--factory-startup",
            "--python", str(THIS_FILE),
            "--",
            "--src-fbx", str(m),
            "--tgt-glb", str(r),
            "--out-dir", str(out_dir),
        ]
        rc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if rc.returncode == 0 and out_path.exists():
            return ("ok", str(out_path))
        return ("fail", f"rc={rc.returncode} stderr={rc.stderr[-200:]}")

    with ProcessPoolExecutor(max_workers=args.jobs) as ex:
        futs = {ex.submit(_run_one, m, r): (m, r) for (m, r) in pairs}
        for fut in as_completed(futs):
            m, r = futs[fut]
            try:
                kind, msg = fut.result()
            except Exception as e:
                kind, msg = "fail", str(e)
            if kind == "ok":
                done += 1
                if done % 20 == 0 or done <= 5:
                    elapsed = time.time() - t0
                    eta = elapsed / done * (len(pairs) - done)
                    print(f"  [{done + failed}/{len(pairs)}] OK {Path(msg).name} "
                          f"({elapsed:.0f}s elapsed, ETA {eta / 60:.1f} min)")
            elif kind == "skip":
                done += 1
            else:
                failed += 1
                print(f"  FAIL {m.name} x {r.name}: {msg}")

    print(f"\n[rokoko-batch] DONE — {done} ok, {failed} failed "
          f"in {(time.time() - t0) / 60:.1f} min")


# =============================================================================
def main():
    # Detect mode: are we inside Blender?
    try:
        import bpy  # noqa: F401
        run_single_retarget()
    except ImportError:
        run_batch()


if __name__ == "__main__":
    main()
