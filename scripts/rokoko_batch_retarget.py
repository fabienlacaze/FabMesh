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

        # Map our extractor vocabulary -> Mixamo-style names that
        # Rokoko's bone-list auto-detect recognises.
        MIXAMO_NAME = {
            "Hips":      "Hips",
            "Spine00":   "Spine",
            "Spine01":   "Spine1",
            "Spine02":   "Spine2",
            "Spine03":   "Spine3",
            "Neck00":    "Neck",
            "Neck01":    "Neck1",
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
        }
        renamed = 0
        for pred_idx, lbl in labels.items():
            new_name = MIXAMO_NAME.get(lbl)
            if new_name is None:
                continue
            old_name = f"joint{pred_idx}"
            if old_name in tgt_arm.data.bones:
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

    # 2026-06-11: bypass Rokoko's auto-detect (it maps multiple Apovivor
    # twist/share/clavicle bones to the same Mixamo target -> "Duplicate
    # target bone entries"). Pre-populate the bone_list explicitly with
    # a known-good source->target mapping. Source names follow Apovivor
    # orc_m1 / Mixamo convention; target names were just renamed via
    # labels.json above.
    EXPLICIT_PAIRS = [
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
    src_bone_names = {b.name for b in src_arm.data.bones}
    tgt_bone_names = {b.name for b in tgt_arm.data.bones}

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
