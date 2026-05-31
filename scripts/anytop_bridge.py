"""Desktop bridge: AnyTop animation generation on a Puppeteer-rigged GLB.

Mirrors the Modal `animate_mesh()` function in modal_app/_anytop_anim.py
but runs locally on the user's RTX 5080. Requires AnyTop installed at
`external/AnyTop/` with its own Python 3.8 venv (because AnyTop's torch
2.4.1 stack collides with the main FabMesh environment).

CLI:
  python anytop_bridge.py --rig in.glb --out out.glb \\
                          --anim-type idle --project <project_dir>

The script:
  1. Verifies external/AnyTop/venv exists (prints clear setup hint if not)
  2. Extracts a T-pose BVH from the rig GLB
  3. Runs `python -m utils.process_new_skeleton` in the AnyTop venv
  4. Runs `python -m sample.generate` in the AnyTop venv
  5. Calls bvh_to_gltf_anim to embed the BVH onto the rig GLB
  6. Writes the animated GLB to <project>/animations/<anim_type>_<ts>.glb

Print LOCAL_ANYTOP_PROGRESS: <0-99> lines so the renderer bar moves via
the existing onAI3DProgress channel.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
ANYTOP_DIR = PROJECT_ROOT / "external" / "AnyTop"
ANYTOP_VENV = ANYTOP_DIR / "venv"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _log(level: str, msg: str) -> None:
    print(f"[anytop:{level}] {msg}", flush=True)


def _progress(pct: int, label: str) -> None:
    # Bridge progress line picked up by the LOCAL_*_PROGRESS regex listener
    # in src/renderer/index2.js (commit 12731-area).
    print(f"LOCAL_ANYTOP_PROGRESS: {pct} {label}", flush=True)


def _venv_python() -> str:
    """Return the path to the AnyTop venv's python.exe (Windows) or
    python (POSIX). Raises with a setup hint if missing."""
    if os.name == "nt":
        py = ANYTOP_VENV / "Scripts" / "python.exe"
    else:
        py = ANYTOP_VENV / "bin" / "python"
    if not py.exists():
        raise FileNotFoundError(
            f"AnyTop venv not found at {ANYTOP_VENV}.\n"
            f"To install:\n"
            f"  cd {PROJECT_ROOT / 'external'}\n"
            f"  git clone https://github.com/Anytop2025/Anytop AnyTop\n"
            f"  cd AnyTop\n"
            f"  py -3.8 -m venv venv\n"
            f"  venv\\Scripts\\activate\n"
            f"  pip install -r requirements.txt\n"
            f"  pip install git+https://github.com/inbar-2344/Motion.git\n"
            f"  python -m utils.download_dependencies\n"
        )
    return str(py)


def _extract_bvh_from_glb(rig_glb_path: str, bvh_out: str) -> None:
    """Use the same GLB->BVH extraction as the Modal side, but importable
    from this script. We re-import from bvh_to_gltf_anim (which loads
    puppeteer_to_skeleton helpers via sys.path)."""
    sys.path.insert(0, str(HERE))
    # The full implementation lives in modal_app/_anytop_anim.py but
    # we re-do a slim version here so the desktop bridge doesn't need
    # Modal SDK installed.
    from puppeteer_to_skeleton import _read_glb  # type: ignore

    gltf, _json_blob, _bin, _tail = _read_glb(rig_glb_path)
    skins = gltf.get("skins") or []
    if not skins:
        raise RuntimeError("GLB has no skin/skeleton")
    skin = skins[0]
    joint_idxs = skin["joints"]
    nodes = gltf["nodes"]
    name_by_idx = {i: (nodes[i].get("name") or f"joint_{i}") for i in joint_idxs}
    parent_by_idx = {i: -1 for i in joint_idxs}
    for parent_idx in joint_idxs:
        for child in (nodes[parent_idx].get("children") or []):
            if child in joint_idxs:
                parent_by_idx[child] = parent_idx
    root = next((i for i in joint_idxs if parent_by_idx[i] == -1), joint_idxs[0])

    lines = ["HIERARCHY"]

    def emit(node_idx: int, indent: int, is_root: bool):
        pad = "  " * indent
        name = name_by_idx[node_idx]
        kw = "ROOT" if is_root else "JOINT"
        lines.append(f"{pad}{kw} {name}")
        lines.append(f"{pad}{{")
        tr = nodes[node_idx].get("translation") or [0.0, 0.0, 0.0]
        lines.append(f"{pad}  OFFSET {tr[0]} {tr[1]} {tr[2]}")
        if is_root:
            lines.append(f"{pad}  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation")
        else:
            lines.append(f"{pad}  CHANNELS 3 Zrotation Xrotation Yrotation")
        kids = [c for c in (nodes[node_idx].get("children") or []) if c in joint_idxs]
        for c in kids:
            emit(c, indent + 1, False)
        if not kids:
            lines.append(f"{pad}  End Site")
            lines.append(f"{pad}  {{")
            lines.append(f"{pad}    OFFSET 0 0 0")
            lines.append(f"{pad}  }}")
        lines.append(f"{pad}}}")

    emit(root, 0, True)
    # 1-frame motion (all zeros, T-pose)
    n_joints = sum(1 for _ in joint_idxs)
    lines += [
        "MOTION",
        "Frames: 1",
        "Frame Time: 0.033333",
        " ".join(["0"] * (3 + 3 * n_joints)),
    ]
    with open(bvh_out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


CHECKPOINTS = {
    "all": "all_model_dataset_truebones_bs_16_latentdim_128",
    "bipeds": "bipeds_model_dataset_truebones_bs_16_latentdim_128",
    "quadropeds": "quadropeds_model_dataset_truebones_bs_16_latentdim_128",
    "millipeds_snakes": "millipeds_snakes_model_dataset_truebones_bs_16_latentdim_128",
    "flying": "flying_model_dataset_truebones_bs_16_latentdim_128",
}


def _pick_checkpoint(anim_type: str) -> str:
    t = (anim_type or "").lower()
    if any(k in t for k in ("fly", "wing", "soar", "glide")):
        return "flying"
    if any(k in t for k in ("crawl", "snake", "slither")):
        return "millipeds_snakes"
    if any(k in t for k in ("quad", "wolf", "dog", "horse", "cat")):
        return "quadropeds"
    if any(k in t for k in ("idle", "walk", "run", "attack", "death", "humanoid", "biped")):
        return "bipeds"
    return "all"


def _resolve_checkpoint_path(family: str) -> str:
    folder = CHECKPOINTS.get(family) or CHECKPOINTS["all"]
    save_dir = ANYTOP_DIR / "save" / folder
    if not save_dir.is_dir():
        return ""
    best = ""
    best_step = -1
    for fn in save_dir.iterdir():
        if not fn.name.startswith("model") or not fn.name.endswith(".pt"):
            continue
        try:
            step = int(fn.name.replace("model", "").replace(".pt", ""))
            if step > best_step:
                best_step = step
                best = str(fn)
        except ValueError:
            continue
    return best


def _guess_face_joints(bvh_path: str) -> list:
    L = []
    R = []
    FL = []
    FR = []
    with open(bvh_path, "r", encoding="utf-8", errors="ignore") as f:
        for ln in f:
            ln = ln.strip()
            if not ln.startswith(("JOINT ", "ROOT ")):
                continue
            name = ln.split(maxsplit=1)[1]
            nl = name.lower()
            if "thigh" in nl or "leg" in nl or "hip" in nl:
                (L if ("l_" in nl or "_l" in nl or "left" in nl) else R).append(name)
            elif "shoulder" in nl or "arm" in nl or "finger" in nl:
                (FL if ("l_" in nl or "_l" in nl or "left" in nl) else FR).append(name)
    out = []
    if R: out.append(R[0])
    if L: out.append(L[0])
    if FR: out.append(FR[0])
    if FL: out.append(FL[0])
    while len(out) < 4:
        out.append(out[0] if out else "root")
    return out[:4]


def _find_latest_bvh(under: Path) -> str:
    best = ""
    best_mt = -1.0
    for p in under.rglob("*.bvh"):
        try:
            mt = p.stat().st_mtime
            if mt > best_mt:
                best_mt = mt
                best = str(p)
        except OSError:
            continue
    return best


def _run_subprocess(cmd: list, cwd: str) -> int:
    p = subprocess.Popen(
        cmd, cwd=cwd,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
    )
    for line in p.stdout:  # type: ignore[union-attr]
        sys.stdout.write(line)
        sys.stdout.flush()
    return p.wait()


# ---------------------------------------------------------------------------
# Main flow
# ---------------------------------------------------------------------------
def run(rig_glb: str, out_glb: str, anim_type: str, prompt: str) -> int:
    _progress(2, "starting")
    venv_py = _venv_python()
    _progress(5, "anytop_venv_ok")

    work = Path(tempfile.mkdtemp(prefix="anytop_"))
    try:
        bvh_extract = work / "rig.bvh"
        bvh_anim = work / "anim.bvh"

        # Step 1 — extract T-pose BVH from the GLB
        _log("info", f"extracting BVH skeleton from {rig_glb}")
        _extract_bvh_from_glb(rig_glb, str(bvh_extract))
        _progress(12, "skeleton_bvh_extracted")

        # Step 2 — process_new_skeleton
        skel_name = f"job_{int(time.time())}"
        ds_dir = ANYTOP_DIR / "dataset" / "truebones" / "zoo" / skel_name
        ds_dir.mkdir(parents=True, exist_ok=True)
        face_joints = _guess_face_joints(str(bvh_extract))
        _log("info", f"face_joints heuristic: {face_joints}")
        rc = _run_subprocess(
            [
                venv_py, "-m", "utils.process_new_skeleton",
                "--object_name", skel_name,
                "--bvh_dir", str(work),
                "--save_dir", str(ds_dir),
                "--face_joints_names", *face_joints,
                "--tpos_bvh", str(bvh_extract),
            ],
            cwd=str(ANYTOP_DIR),
        )
        if rc != 0:
            raise RuntimeError(f"process_new_skeleton exit {rc}")
        _progress(35, "skeleton_preprocessed")

        # Step 3 — sample.generate
        family = _pick_checkpoint(anim_type)
        ckpt = _resolve_checkpoint_path(family)
        if not ckpt:
            raise RuntimeError(
                f"AnyTop checkpoint '{family}' not found. Run "
                f"`python -m utils.download_dependencies` in the AnyTop venv."
            )
        _log("info", f"using checkpoint family={family}: {ckpt}")
        rc = _run_subprocess(
            [
                venv_py, "-m", "sample.generate",
                "--model_path", ckpt,
                "--object_type", skel_name,
                "--cond_path", str(ds_dir / "cond.npy"),
                "--num_repetitions", "1",
                "--motion_length", "5.0",
                "--device", "0",
            ],
            cwd=str(ANYTOP_DIR),
        )
        if rc != 0:
            raise RuntimeError(f"sample.generate exit {rc}")
        gen_bvh = _find_latest_bvh(Path(ckpt).parent)
        if not gen_bvh:
            raise RuntimeError("sample.generate produced no BVH")
        shutil.copyfile(gen_bvh, bvh_anim)
        _log("info", f"AnyTop BVH: {bvh_anim} ({bvh_anim.stat().st_size} bytes)")
        _progress(80, "motion_generated")

        # Step 4 — BVH -> glTF animation tracks embedded on the rig GLB
        sys.path.insert(0, str(HERE))
        from bvh_to_gltf_anim import bvh_to_gltf_anim  # type: ignore
        bvh_to_gltf_anim(
            rig_glb_path=rig_glb,
            bvh_path=str(bvh_anim),
            out_glb_path=out_glb,
            clip_name=anim_type or "clip",
            target_fps=30.0,
        )
        _progress(99, "tracks_embedded")
        sz = os.path.getsize(out_glb)
        _log("info", f"DONE: {out_glb} ({sz} bytes)")
        _progress(100, "done")
        return 0
    finally:
        try:
            shutil.rmtree(work, ignore_errors=True)
        except Exception:
            pass


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--rig", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--anim-type", default="idle", dest="anim_type")
    ap.add_argument("--prompt", default="")
    args = ap.parse_args()
    try:
        return run(args.rig, args.out, args.anim_type, args.prompt)
    except FileNotFoundError as e:
        # Setup hint surface
        print(json.dumps({"error": str(e), "setup_required": True}), flush=True)
        return 3
    except Exception as e:
        import traceback
        print(json.dumps({
            "error": str(e),
            "type": type(e).__name__,
            "trace": traceback.format_exc()[:4000],
        }), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
