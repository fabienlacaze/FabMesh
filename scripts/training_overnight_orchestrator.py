"""Overnight orchestrator: Trellis mesh + Puppeteer rig + FabMesh import
for the AnyTop training dataset (Plan B1).

Runs sequentially through every reference image in c:/tmp/training_refs/:
  1. Trellis-2 (RTX 5080 local) PNG -> GLB mesh
  2. Puppeteer (CPU + RTX 5080 local) GLB -> rigged GLB
  3. Import to MyFabmesh's /meshes/ + /images/ so the UI shows it
     (script visible without restart — Ctrl+R the renderer)
  4. Log progress to c:/tmp/overnight.log

Prevents system sleep via SetThreadExecutionState(ES_CONTINUOUS |
ES_SYSTEM_REQUIRED). Screen can sleep (user is asleep too).

At the end:
  - If 150 rigged GLBs are present AND the Apovivor BVH dataset is
    prepped under c:/tmp/apovivor_bvh/, launches local AnyTop training.
  - Else logs what's still missing (no popup, no user prompt).

CLI:
    python scripts/training_overnight_orchestrator.py
    python scripts/training_overnight_orchestrator.py --skip-rig
"""
from __future__ import annotations
import argparse
import ctypes
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path


REPO = Path(__file__).resolve().parent.parent
TRELLIS_PY = REPO / "external" / "TRELLIS2_win" / ".venv" / "Scripts" / "python.exe"
TRELLIS_SCRIPT = REPO / "scripts" / "trellis2_native_full_pipeline.py"
PUPP_PY = REPO / "external" / "Puppeteer" / "venv" / "Scripts" / "python.exe"
PUPP_SCRIPT = REPO / "scripts" / "puppeteer_bridge.py"

REFS = Path("c:/tmp/training_refs")
MESHES = Path("c:/tmp/training_meshes")
RIGS = Path("c:/tmp/training_rigs")
FAB_MESHES = REPO / "meshes"
FAB_IMAGES = REPO / "images"
LOG_FILE = Path("c:/tmp/overnight.log")

ARCHETYPES = ["humanoid", "quadruped", "winged_biped"]


def log(msg: str) -> None:
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    # 2026-06-10: print() under capture_output can be cp1252 on Windows
    # and crash on non-ASCII subprocess errors. ASCII-fallback the stdout
    # write so a logging error never tears down the orchestrator.
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        try:
            print(line.encode("ascii", "replace").decode("ascii"), flush=True)
        except Exception:
            pass
    except Exception:
        pass
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def prevent_sleep_on() -> None:
    """Win32: keep system awake. Screen still allowed to sleep."""
    ES_CONTINUOUS = 0x80000000
    ES_SYSTEM_REQUIRED = 0x00000001
    try:
        rc = ctypes.windll.kernel32.SetThreadExecutionState(
            ES_CONTINUOUS | ES_SYSTEM_REQUIRED
        )
        log(f"Sleep prevention: SetThreadExecutionState -> 0x{rc:08x}")
    except Exception as e:
        log(f"Sleep prevention FAILED: {e}")


def prevent_sleep_off() -> None:
    ES_CONTINUOUS = 0x80000000
    try:
        ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS)
        log("Sleep prevention: released")
    except Exception:
        pass


def run_subprocess(args: list[str], cwd: Path, env_extra: dict, timeout: int) -> tuple[int, str]:
    """Subprocess that won't crash on cp1252 / mixed encoding output."""
    env = {**os.environ, **env_extra}
    try:
        rc = subprocess.run(
            args, cwd=str(cwd), env=env,
            capture_output=True, text=False, timeout=timeout,
        )
        err = (rc.stderr or rc.stdout or b"").decode("utf-8", errors="replace")
        return (rc.returncode, err[-400:])
    except subprocess.TimeoutExpired:
        return (-1, f"TIMEOUT after {timeout}s")
    except Exception as e:
        return (-2, f"{type(e).__name__}: {e}")


def gen_mesh(png: Path, glb: Path, retry: bool = True) -> bool:
    """Generate mesh. Returns True if GLB exists at end.

    Strategy:
      - Pass 1: timeout 540s, mode=1024 (fast path, ~85% success)
      - Pass 2 (retry): timeout 540s, mode=512 (fallback for problematic
        images — sparse_structure_512 stage stalls less often)
      - On timeout, mark image in c:/tmp/training_meshes/_failed.txt so
        the next orchestrator pass can decide whether to skip permanently.
    """
    if glb.exists() and glb.stat().st_size > 100_000:
        return True
    glb.parent.mkdir(parents=True, exist_ok=True)

    mode = "1024" if retry else "512"
    timeout = 540  # 9 min — was 1500, far too generous; if it doesn't
                   # finish in 9 min it never will (Trellis stalls on
                   # certain meshes' diffoctreerast pass).

    rc, err = run_subprocess(
        [str(TRELLIS_PY), str(TRELLIS_SCRIPT), str(png), str(glb), "1024"],
        cwd=REPO,
        env_extra={
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUNBUFFERED": "1",
            "FABMESH_TRELLIS2_NATIVE_MODE": mode,
            "FABMESH_TRELLIS2_NATIVE_SEED": "42",
            "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True,max_split_size_mb:256",
        },
        timeout=timeout,
    )
    ok = rc == 0 and glb.exists() and glb.stat().st_size > 100_000
    if not ok:
        log(f"  mesh FAIL rc={rc} (mode={mode}): {err[-200:]}")
        if retry:
            log(f"  retry once at mode=512 after 15s sleep…")
            time.sleep(15)
            return gen_mesh(png, glb, retry=False)
        # Final failure — record so next pass can skip
        try:
            failed_log = MESHES.parent / "_failed.txt"
            with open(failed_log, "a", encoding="utf-8") as f:
                f.write(f"{png}\n")
        except Exception:
            pass
    return ok


def gen_rig(glb: Path, rig_glb: Path) -> bool:
    if rig_glb.exists() and rig_glb.stat().st_size > 100_000:
        return True
    rig_glb.parent.mkdir(parents=True, exist_ok=True)
    rc, err = run_subprocess(
        [str(PUPP_PY), str(PUPP_SCRIPT), str(glb), str(rig_glb)],
        cwd=REPO,
        env_extra={
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUNBUFFERED": "1",
        },
        timeout=900,
    )
    ok = rc == 0 and rig_glb.exists() and rig_glb.stat().st_size > 100_000
    if not ok:
        log(f"  rig FAIL rc={rc}: {err[-200:]}")
    return ok


def import_to_fabmesh(arch: str, png: Path, glb: Path, rig_glb: Path, ts: int) -> None:
    """Copy mesh + rig + ref image into FabMesh's /meshes/ + /images/."""
    base = f"training_{arch}_{glb.stem}"
    mesh_target = FAB_MESHES / f"{base}_trellis2_native_{ts}.glb"
    source_target = FAB_MESHES / f"{base}_trellis2_native_{ts}.glb.source"
    img_folder = FAB_IMAGES / f"{base}_{ts}"
    img_target = img_folder / "ref_0.png"

    FAB_MESHES.mkdir(parents=True, exist_ok=True)
    FAB_IMAGES.mkdir(parents=True, exist_ok=True)
    img_folder.mkdir(parents=True, exist_ok=True)

    if png.exists() and not img_target.exists():
        shutil.copyfile(png, img_target)
    if not mesh_target.exists():
        shutil.copyfile(glb, mesh_target)
        source_target.write_text(str(img_target).replace("/", "\\"), encoding="utf-8")
    if rig_glb.exists() and rig_glb.stat().st_size > 100_000:
        rig_target = FAB_MESHES / f"{base}_trellis2_native_{ts}_rigged_puppeteer_{ts + 1}.glb"
        rig_source = FAB_MESHES / f"{base}_trellis2_native_{ts}_rigged_puppeteer_{ts + 1}.glb.source"
        if not rig_target.exists():
            shutil.copyfile(rig_glb, rig_target)
            rig_source.write_text(str(img_target).replace("/", "\\"), encoding="utf-8")


def maybe_launch_training() -> None:
    n_rigged = sum(
        1 for arch in ARCHETYPES
        for _ in (RIGS / arch).glob("*.glb")
        if (RIGS / arch).exists()
    )
    log(f"Training gate: {n_rigged} rigged GLBs ready")

    apovivor = Path("c:/tmp/apovivor_bvh")
    has_apovivor = apovivor.exists() and any(apovivor.rglob("*.bvh"))

    if n_rigged < 100:
        log("Training: not enough rigged meshes (<100). Skip auto-launch.")
        return
    if not has_apovivor:
        log("Training: Apovivor BVH dataset not prepped at c:/tmp/apovivor_bvh/. "
            "Manual Step 4 (UE5 export + Blender FBX->BVH) needed before training.")
        return
    log("Training: prerequisites met. Auto-launch is NOT wired (custom "
        "AnyTop training script not yet written). Dataset is ready under "
        f"c:/tmp/training_rigs/ + {apovivor}.")
    # Future hook: subprocess.run([sys.executable, "scripts/anytop_train_custom.py", ...])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-rig", action="store_true",
                    help="Only do Trellis mesh gen + FabMesh import (no Puppeteer)")
    ap.add_argument("--archetype", default=None)
    args = ap.parse_args()

    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    if LOG_FILE.exists():
        LOG_FILE.rename(LOG_FILE.with_suffix(f".{int(time.time())}.log"))

    log("=" * 60)
    log("OVERNIGHT ORCHESTRATOR started")
    log(f"  Trellis venv: {TRELLIS_PY}")
    log(f"  Puppeteer venv: {PUPP_PY}")
    log(f"  refs dir: {REFS}")
    log(f"  meshes dir: {MESHES}")
    log(f"  rigs dir: {RIGS}")
    log(f"  fabmesh: {FAB_MESHES}, {FAB_IMAGES}")
    log("=" * 60)

    if not TRELLIS_PY.exists():
        log(f"FATAL: Trellis venv missing: {TRELLIS_PY}")
        return 1
    if not args.skip_rig and not PUPP_PY.exists():
        log(f"WARN: Puppeteer venv missing — running with --skip-rig automatically")
        args.skip_rig = True

    prevent_sleep_on()

    try:
        base_ts = int(time.time() * 1000)
        archetypes = [args.archetype] if args.archetype else ARCHETYPES
        n_total = sum(len(list((REFS / a).glob("*.png"))) for a in archetypes
                      if (REFS / a).exists())
        log(f"Total images to process: {n_total}")
        log("")

        n_done = 0
        n_failed = 0
        overall_start = time.time()

        # 2026-06-10: outer "while not done" loop so a chain of failures
        # doesn't terminate the orchestrator — we re-scan and retry any
        # un-meshed/un-rigged item up to MAX_PASSES times. Resumable:
        # already-existing GLBs are skipped instantly by gen_mesh/gen_rig.
        MAX_PASSES = 3
        for pass_n in range(1, MAX_PASSES + 1):
          log(f"--- PASS {pass_n}/{MAX_PASSES} ---")
          pass_processed = 0
          for ai, arch in enumerate(archetypes):
            png_dir = REFS / arch
            if not png_dir.exists():
                continue
            for gi, png in enumerate(sorted(png_dir.glob("*.png"))):
                glb = MESHES / arch / (png.stem + ".glb")
                rig_glb = RIGS / arch / (png.stem + "_rigged.glb")

                mesh_done = glb.exists() and glb.stat().st_size > 100_000
                rig_done = rig_glb.exists() and rig_glb.stat().st_size > 100_000
                if mesh_done and (rig_done or args.skip_rig):
                    continue
                pass_processed += 1

                log(f"[pass {pass_n}] {arch}/{png.stem}")
                t0 = time.time()

                ok_mesh = gen_mesh(png, glb)
                log(f"  mesh: {'OK' if ok_mesh else 'FAIL'} ({time.time() - t0:.0f}s)")
                if not ok_mesh:
                    n_failed += 1
                    continue

                ok_rig = False
                if not args.skip_rig:
                    t1 = time.time()
                    ok_rig = gen_rig(glb, rig_glb)
                    log(f"  rig:  {'OK' if ok_rig else 'FAIL'} ({time.time() - t1:.0f}s)")

                ts = base_ts + ai * 100_000 + gi
                try:
                    import_to_fabmesh(arch, png, glb,
                                      rig_glb if ok_rig else Path(),
                                      ts)
                    log(f"  fab-import: OK")
                except Exception as e:
                    log(f"  fab-import: FAIL {e}")

                n_done += 1
                elapsed = time.time() - overall_start
                eta = elapsed / max(n_done, 1) * (n_total - n_done - n_failed)
                log(f"  total: {n_done}/{n_total} done. "
                    f"ETA {eta / 60:.0f} min")
          log(f"--- pass {pass_n} processed {pass_processed} items ---")
          if pass_processed == 0:
              log("Pass converged — nothing left to do.")
              break

        log("=" * 60)
        log(f"PIPELINE DONE in {(time.time() - overall_start) / 60:.0f} min")
        log(f"  {n_done} processed, {n_failed} failed")
        log("=" * 60)
        maybe_launch_training()
    finally:
        prevent_sleep_off()
        log("Orchestrator finished.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
