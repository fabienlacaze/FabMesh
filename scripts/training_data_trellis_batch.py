"""Batch TRELLIS-2 mesh generation for AnyTop training (Plan B1 Step 2).

Two backends:
  --backend modal  : Modal MyFabmeshMesh.inference_bytes (default if --modal)
  --backend local  : RTX 5080 via external/TRELLIS2_win/.venv (free, slower)

The local backend reuses scripts/trellis2_native_full_pipeline.py but
spawns each call in the TRELLIS2_win venv (where cumesh + the custom
CUDA kernels are installed). The system Python doesn't have cumesh —
that's the bug that bit us on the first local attempt.

Modal handles GPU + Trellis pipeline load (kept warm 5 min between
calls so back-to-back batches stay fast).

Cost: ~$0.05 per mesh on L40S = ~$8 for 150 meshes.
Wall-clock: ~3-5 min per mesh on warm container = ~7-12 hours sequential,
or 60-90 min if we parallelize with 8 concurrent calls.

CLI:
    python scripts/training_data_trellis_batch.py
    python scripts/training_data_trellis_batch.py --limit 3
    python scripts/training_data_trellis_batch.py --concurrency 4
    python scripts/training_data_trellis_batch.py --archetype quadruped
"""
from __future__ import annotations
import argparse
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


def _process_one_modal(mesh_cls, png_path: Path, glb_path: Path,
                       tex_res: int, mode: str) -> tuple[bool, str]:
    """Read PNG → call Modal → write GLB. Returns (success, message)."""
    try:
        with open(png_path, "rb") as f:
            img_bytes = f.read()
        glb_bytes = mesh_cls().inference_bytes.remote(
            img_bytes,
            mode=mode,
            seed=42,
            decimation=500_000,
            texture_size=tex_res,
        )
        if not glb_bytes or len(glb_bytes) < 1000:
            return (False, f"GLB too small: {len(glb_bytes)} bytes")
        with open(glb_path, "wb") as f:
            f.write(glb_bytes)
        return (True, f"{len(glb_bytes)/1e6:.1f} MB")
    except Exception as e:
        return (False, f"{type(e).__name__}: {str(e)[:200]}")


# Local backend: spawn trellis2_native_full_pipeline.py in the TRELLIS2_win
# venv (where cumesh + flex_gemm + the custom CUDA kernels are installed).
HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
TRELLIS_VENV_PYTHON = (
    REPO_ROOT / "external" / "TRELLIS2_win" / ".venv" / "Scripts" / "python.exe"
)
TRELLIS_SCRIPT = HERE / "trellis2_native_full_pipeline.py"


def _process_one_local(png_path: Path, glb_path: Path,
                       tex_res: int, mode: str) -> tuple[bool, str]:
    """Run TRELLIS-2 locally via the dedicated venv (cumesh is in there)."""
    import os, subprocess
    if not TRELLIS_VENV_PYTHON.exists():
        return (False, f"venv python missing: {TRELLIS_VENV_PYTHON}")
    if not TRELLIS_SCRIPT.exists():
        return (False, f"script missing: {TRELLIS_SCRIPT}")
    t0 = __import__("time").time()
    try:
        # text=False + manual decode with errors='replace' avoids the
        # cp1252 UnicodeDecodeError on TRELLIS-2's mixed-encoding stdout
        # (Windows console codepage 437/1252 vs our utf-8 env).
        rc = subprocess.run(
            [str(TRELLIS_VENV_PYTHON), str(TRELLIS_SCRIPT),
             str(png_path), str(glb_path), str(tex_res)],
            cwd=str(REPO_ROOT),
            env={**os.environ,
                 "PYTHONIOENCODING": "utf-8",
                 "FABMESH_TRELLIS2_NATIVE_MODE": mode,
                 "FABMESH_TRELLIS2_NATIVE_SEED": "42",
                 "PYTHONUNBUFFERED": "1"},
            capture_output=True, text=False, timeout=600,
        )
        rc_stdout = (rc.stdout or b"").decode("utf-8", errors="replace")
        rc_stderr = (rc.stderr or b"").decode("utf-8", errors="replace")
        dt = __import__("time").time() - t0
        if rc.returncode == 0 and glb_path.exists():
            return (True, f"{glb_path.stat().st_size/1e6:.1f} MB ({dt:.0f}s)")
        err = (rc_stderr or rc_stdout or "<no output>")[-250:]
        return (False, f"rc={rc.returncode}: {err}")
    except subprocess.TimeoutExpired:
        return (False, "TIMEOUT after 10 min")
    except Exception as e:
        return (False, f"{type(e).__name__}: {str(e)[:200]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refs", default="c:/tmp/training_refs")
    ap.add_argument("--out",  default="c:/tmp/training_meshes")
    ap.add_argument("--archetype", default=None)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--tex-res", type=int, default=1024)
    ap.add_argument("--mode", default="1024",
                    help="TRELLIS-2 mode: 512 / 1024 / cascade")
    ap.add_argument("--concurrency", type=int, default=4,
                    help="Parallel Modal calls (max 8 — Modal queues "
                         "extras automatically). LOCAL backend ignores this "
                         "and runs 1 at a time (one GPU).")
    ap.add_argument("--backend", choices=["modal", "local"], default="modal",
                    help="modal = MyFabmeshMesh on cloud GPU (paid). "
                         "local = RTX 5080 via TRELLIS2_win venv (free).")
    args = ap.parse_args()

    if args.backend == "modal":
        import modal
        print("[trellis-batch] connecting to Modal myfabmesh-cloud / MyFabmeshMesh…")
        mesh_cls = modal.Cls.from_name("myfabmesh-cloud", "MyFabmeshMesh")
    else:
        mesh_cls = None
        print(f"[trellis-batch] LOCAL backend — venv: {TRELLIS_VENV_PYTHON}")
        # Local = sequential (single GPU); force concurrency=1
        args.concurrency = 1

    refs = Path(args.refs)
    out_root = Path(args.out)
    archetypes = [args.archetype] if args.archetype else [
        d.name for d in refs.iterdir() if d.is_dir()
    ]

    print(f"[trellis-batch] archetypes={archetypes}")
    print(f"[trellis-batch] refs={refs}")
    print(f"[trellis-batch] out={out_root}")
    print(f"[trellis-batch] mode={args.mode} tex_res={args.tex_res} "
          f"concurrency={args.concurrency}")

    work = []
    for a in archetypes:
        in_dir = refs / a
        out_dir = out_root / a
        out_dir.mkdir(parents=True, exist_ok=True)
        pngs = sorted(in_dir.glob("*.png"))
        if args.limit:
            pngs = pngs[: args.limit]
        for png in pngs:
            glb = out_dir / (png.stem + ".glb")
            if glb.exists() and glb.stat().st_size > 100_000:
                continue
            work.append((a, png, glb))

    n_total = len(work)
    print(f"[trellis-batch] {n_total} new images to process\n")

    if not n_total:
        print("[trellis-batch] nothing to do.")
        return 0

    overall_start = time.time()
    done = 0
    failed = 0
    def _worker(png, glb):
        if args.backend == "modal":
            return _process_one_modal(mesh_cls, png, glb, args.tex_res, args.mode)
        else:
            return _process_one_local(png, glb, args.tex_res, args.mode)

    with ThreadPoolExecutor(max_workers=args.concurrency) as ex:
        futures = {
            ex.submit(_worker, png, glb): (a, png, glb)
            for (a, png, glb) in work
        }
        for fut in as_completed(futures):
            archetype, png, glb = futures[fut]
            success, msg = fut.result()
            if success:
                done += 1
                elapsed = time.time() - overall_start
                eta = elapsed / done * (n_total - done)
                print(f"  OK   [{done + failed:3d}/{n_total}] "
                      f"{archetype}/{glb.name}  ({msg})  ETA {eta/60:.1f} min")
            else:
                failed += 1
                print(f"  FAIL [{done + failed:3d}/{n_total}] "
                      f"{archetype}/{png.name}  ({msg})")

    total_min = (time.time() - overall_start) / 60
    print(f"\n[trellis-batch] DONE in {total_min:.1f} min — "
          f"{done} new, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
