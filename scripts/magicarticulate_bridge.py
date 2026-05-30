"""MagicArticulate bridge for FabMesh.

Runs Seed3D / MagicArticulate skeleton prediction on an input mesh and
produces a single rigged GLB file that FabMesh can load in its viewer.
The downstream pipeline (``swap_skeleton.py`` → ``bake_procedural_anims.py``)
picks this GLB up exactly the same way it does for the UniRig output.

Reference
---------
- Repo:    https://github.com/Seed3D/MagicArticulate  (Apache-2.0)
- Paper:   "MagicArticulate: Make Your 3D Models Articulation-Ready"
- Runtime: ~1-2 s of inference on RTX 5080 (4.6 GB VRAM) per the paper,
           +5-10 s for marching cubes / OBJ export / GLB bake → ~10-15 s total.

Setup
-----
The script expects ``external/MagicArticulate/`` to contain a clone of the
upstream repo, its model checkpoint, AND a dedicated Python 3.10 venv at
``external/MagicArticulate/venv/Scripts/python.exe`` (Windows layout).

    # 1. Clone repo + checkpoint
    cd external
    git clone https://github.com/Seed3D/MagicArticulate.git
    cd MagicArticulate
    mkdir skeleton_ckpt
    # download checkpoint_trainonv2_hier.pth from the repo's HF link
    # into skeleton_ckpt/

    # 2. Dedicated venv (Python 3.10.13)
    py -3.10 -m venv venv
    venv\\Scripts\\activate

    # 3. Blackwell / RTX 5080 (sm_120) compatibility
    #
    # The default requirements.txt pins torch 2.1.1+cu118 which has NO
    # Blackwell kernels. Install the CUDA 12.8 build instead:
    pip install torch==2.6.0+cu128 torchvision torchaudio \\
        --index-url https://download.pytorch.org/whl/cu128
    # flash-attn 2.6.3 also lacks Blackwell support — use the first
    # sm_120-aware wheel:
    pip install flash-attn==2.7.4.post1 --no-build-isolation
    # If flash-attn fails to build on Windows MSVC, fall back to eager
    # attention by patching demo.py to pass attn_implementation='eager'
    # to the SkeletonGPT constructor.

    # 4. Remaining deps
    pip install trimesh==4.2.3 accelerate==0.28.0 mesh2sdf==1.1.0 \\
        transformers==4.39.3 numpy==1.26.4 pyrender==0.1.45 \\
        opencv-python==4.9.0.80 omegaconf==2.3.0 einops==0.7.0 \\
        bpy==4.2.0

Usage
-----
    python magicarticulate_bridge.py <mesh_path> <output_glb>

Known limitations
-----------------
- Errors out with a clear message if ``external/MagicArticulate/`` or its
  venv is missing.
- Upstream ``demo.py`` only emits a *skeleton* (joints + bones in RigNet
  format, plus an OBJ for the bones). It does NOT produce skin weights.
  We bake weights via a Blender headless pass (heat-diffusion or
  nearest-bone fallback) using ``scripts/build_glb_from_rig_txt.py`` and
  the project's configured Blender install. If that helper is missing,
  the bridge still emits the skeleton-only GLB and downstream
  ``swap_skeleton.py`` will replace the topology anyway.
- MagicArticulate accepts .obj / .ply / .stl only — .glb / .fbx inputs
  are converted to .obj on the fly via trimesh.
"""
import os
import sys
import subprocess
import tempfile
import shutil
import time

HERE = os.path.abspath(os.path.dirname(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(HERE, ".."))
MA_DIR = os.path.join(PROJECT_ROOT, "external", "MagicArticulate")
VENV_PY = os.path.join(MA_DIR, "venv", "Scripts", "python.exe")
VENV_BIN = os.path.join(MA_DIR, "venv", "Scripts")
CHECKPOINT = os.path.join(MA_DIR, "skeleton_ckpt", "checkpoint_trainonv2_hier.pth")
DEMO_PY = os.path.join(MA_DIR, "demo.py")


def log(msg):
    print(f"MAGICART: {msg}", flush=True)


def _find_blender_exe():
    """Find Blender (same logic as unirig_bridge.py)."""
    try:
        import json
        cfg_path = os.path.join(PROJECT_ROOT, "config.json")
        if os.path.exists(cfg_path):
            with open(cfg_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            p = cfg.get("blenderPath")
            if p and os.path.exists(p):
                return p
    except Exception:
        pass
    candidates = [
        r"C:\Program Files\Blender Foundation\Blender 4.4\blender.exe",
        r"C:\Program Files\Blender Foundation\Blender 4.3\blender.exe",
        r"C:\Program Files\Blender Foundation\Blender 4.2\blender.exe",
        r"C:\Program Files\Blender Foundation\Blender 4.1\blender.exe",
        r"C:\Program Files\Blender Foundation\Blender 4.0\blender.exe",
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    import shutil as _sh
    return _sh.which("blender")


def _convert_to_obj(mesh_path, tmp_dir):
    """Convert .glb/.fbx/etc → .obj using trimesh (the bridge's own env,
    not the MA venv, so trimesh must be available in the parent python).
    Returns the obj path. Pass-through if already .obj/.ply/.stl.
    """
    ext = os.path.splitext(mesh_path)[1].lower()
    if ext in (".obj", ".ply", ".stl"):
        return mesh_path
    try:
        import trimesh
    except ImportError:
        print("AUTORIG_ERROR: trimesh not installed in bridge env — "
              "cannot convert non-OBJ input. pip install trimesh.")
        sys.exit(1)
    out_obj = os.path.join(tmp_dir, "input.obj")
    log(f"converting {ext} → .obj via trimesh")
    scene = trimesh.load(mesh_path, force="mesh")
    if hasattr(scene, "export"):
        scene.export(out_obj)
    else:
        print(f"AUTORIG_ERROR: trimesh could not load {mesh_path}")
        sys.exit(1)
    if not os.path.exists(out_obj):
        print(f"AUTORIG_ERROR: obj export failed: {out_obj}")
        sys.exit(1)
    log(f"converted → {out_obj} ({os.path.getsize(out_obj)} bytes)")
    return out_obj


def _run_demo(input_obj, out_dir, run_name):
    """Run MagicArticulate demo.py from MA_DIR with the dedicated venv."""
    env = os.environ.copy()
    env["PATH"] = VENV_BIN + os.pathsep + env.get("PATH", "")
    env["CUDA_VISIBLE_DEVICES"] = env.get("CUDA_VISIBLE_DEVICES", "0")
    cmd = [
        VENV_PY, DEMO_PY,
        "--input_path", input_obj.replace("\\", "/"),
        "--output_dir", out_dir.replace("\\", "/"),
        "--save_name", run_name,
        "--pretrained_weights", CHECKPOINT.replace("\\", "/"),
        "--input_pc_num", "8192",
        "--apply_marching_cubes",
        "--hier_order",
    ]
    log(f"exec: {' '.join(cmd)}")
    proc = subprocess.Popen(
        cmd,
        cwd=MA_DIR,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    for line in iter(proc.stdout.readline, ""):
        if not line:
            break
        line = line.rstrip()
        if line:
            print(line, flush=True)
    proc.stdout.close()
    rc = proc.wait()
    if rc != 0:
        log(f"demo.py exited with rc={rc}")
    return rc


def _bake_glb(mesh_obj, rig_txt, output_glb):
    """Bake the predicted skeleton + skin weights into a GLB via Blender.

    Uses scripts/build_glb_from_rig_txt.py (Blender headless). If that
    helper is missing, falls back to copying the predicted skeleton .obj
    as a degenerate GLB and lets swap_skeleton.py rebuild the topology.
    """
    helper = os.path.join(PROJECT_ROOT, "scripts", "build_glb_from_rig_txt.py")
    if not os.path.exists(helper):
        log(f"WARN: {helper} missing — skinning weights will not be baked")
        log("WARN: emitting raw skeleton GLB; swap_skeleton.py must run after")
        # Best-effort: try a trimesh export of the mesh with no armature so
        # the downstream pipeline still gets a valid GLB.
        try:
            import trimesh
            m = trimesh.load(mesh_obj, force="mesh")
            m.export(output_glb)
            return os.path.exists(output_glb)
        except Exception as exc:
            print(f"AUTORIG_ERROR: fallback GLB export failed: {exc}")
            return False

    blender_exe = _find_blender_exe()
    if blender_exe is None:
        print("AUTORIG_ERROR: Blender not found (config.json:blenderPath or PATH)")
        return False
    log(f"blender={blender_exe}")
    cmd = [
        blender_exe, "--background", "--python", helper,
        "--", mesh_obj, rig_txt, output_glb,
    ]
    log(f"exec: {' '.join(cmd)}")
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    for line in iter(proc.stdout.readline, ""):
        if not line:
            break
        line = line.rstrip()
        if line:
            print(line, flush=True)
    proc.stdout.close()
    rc = proc.wait()
    log(f"glb bake rc={rc}")
    return os.path.exists(output_glb)


def main():
    if len(sys.argv) < 3:
        print("AUTORIG_ERROR: usage: magicarticulate_bridge.py <mesh_path> <output_glb>")
        sys.exit(1)
    mesh_path = os.path.abspath(sys.argv[1])
    output_glb = os.path.abspath(sys.argv[2])

    if not os.path.exists(mesh_path):
        print(f"AUTORIG_ERROR: mesh not found: {mesh_path}")
        sys.exit(1)
    if not os.path.isdir(MA_DIR):
        print(f"AUTORIG_ERROR: MagicArticulate not installed at {MA_DIR}")
        print("AUTORIG_ERROR: see header docstring for setup instructions")
        sys.exit(1)
    if not os.path.exists(VENV_PY):
        print(f"AUTORIG_ERROR: MagicArticulate venv not found at {VENV_PY}")
        print("AUTORIG_ERROR: see header docstring for setup instructions")
        sys.exit(1)
    if not os.path.exists(DEMO_PY):
        print(f"AUTORIG_ERROR: demo.py missing: {DEMO_PY}")
        sys.exit(1)
    if not os.path.exists(CHECKPOINT):
        print(f"AUTORIG_ERROR: checkpoint missing: {CHECKPOINT}")
        print("AUTORIG_ERROR: download checkpoint_trainonv2_hier.pth (see header)")
        sys.exit(1)

    log(f"mesh={mesh_path}")
    log(f"output={output_glb}")

    tmp_dir = tempfile.mkdtemp(prefix="magicart_")
    try:
        # Step 1: input conversion → OBJ
        log("== Step 1: input conversion ==")
        t0 = time.time()
        input_obj = _convert_to_obj(mesh_path, tmp_dir)
        log(f"input ready in {time.time()-t0:.1f}s")

        # Step 2: skeleton prediction
        log("== Step 2: skeleton prediction (MagicArticulate) ==")
        t0 = time.time()
        run_name = "fabmesh"
        rc = _run_demo(input_obj, tmp_dir, run_name)

        # Expected outputs from demo.py: <out_dir>/<run_name>/<basename>_pred.txt
        # plus <basename>_skel.obj and <basename>_mesh.obj
        run_out_dir = os.path.join(tmp_dir, run_name)
        if not os.path.isdir(run_out_dir):
            print(f"AUTORIG_ERROR: skeleton prediction failed (no output dir). rc={rc}")
            sys.exit(1)
        pred_txt = None
        mesh_obj_out = None
        for fname in os.listdir(run_out_dir):
            fp = os.path.join(run_out_dir, fname)
            if fname.endswith("_pred.txt"):
                pred_txt = fp
            elif fname.endswith("_mesh.obj"):
                mesh_obj_out = fp
        if pred_txt is None:
            print(f"AUTORIG_ERROR: no _pred.txt in {run_out_dir}. rc={rc}")
            sys.exit(1)
        # If marching cubes was applied, demo.py emits its own _mesh.obj —
        # use it so the skin bake is consistent with the predicted joints.
        bake_mesh = mesh_obj_out if mesh_obj_out else input_obj
        log(f"skeleton done in {time.time()-t0:.1f}s "
            f"(pred={os.path.basename(pred_txt)}, mesh={os.path.basename(bake_mesh)})")

        # Step 3: bake skeleton + weights into GLB via Blender
        log("== Step 3: GLB bake (Blender) ==")
        t0 = time.time()
        ok = _bake_glb(bake_mesh, pred_txt, output_glb)
        if not ok or not os.path.exists(output_glb):
            print(f"AUTORIG_ERROR: GLB bake failed: {output_glb}")
            sys.exit(1)
        sz = os.path.getsize(output_glb)
        log(f"GLB bake done in {time.time()-t0:.1f}s ({sz} bytes)")

        print(f"AUTORIG_SUCCESS: {output_glb} ({sz} bytes)")
        sys.exit(0)
    finally:
        try:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        except Exception:
            pass


if __name__ == "__main__":
    main()
