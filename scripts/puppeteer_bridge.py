"""Puppeteer bridge for FabMesh.

Runs the three-stage Seed3D / Puppeteer auto-rigging pipeline (skeleton →
skinning → FBX export) on an input mesh and produces a single rigged GLB
that FabMesh can load in its viewer. The downstream pipeline
(``swap_skeleton.py`` → ``bake_procedural_anims.py``) picks this GLB up
exactly the same way it does for the UniRig / MagicArticulate outputs.

Reference
---------
- Repo:    https://github.com/Seed3D/Puppeteer  (Apache-2.0)
- Models:  https://huggingface.co/Seed3D/Puppeteer
- Paper:   "Puppeteer: Bring Your 3D Assets to Life with Auto-Rigging"
- Runtime: not officially benchmarked in the README; treat any wall-clock
           figure as unverified until measured locally on RTX 5080.

Pipeline (mirrors upstream ``demo_rigging.sh``)
-----------------------------------------------
1. ``skeleton/demo.py`` — point-cloud → joint sequence, emits
   ``{name}_pred.txt``, ``{name}_skel.obj``, ``{name}_mesh.obj``.
   Single-GPU, no torchrun.
2. ``skinning/main.py`` — predicts per-vertex skin weights from the
   skeleton + mesh. **Requires** ``torchrun --nproc_per_node=1`` even on a
   single GPU (the script uses ``DistributedDataParallel``).
3. ``final_rigging/export.py`` — uses the ``bpy`` pip wheel (no system
   Blender required) to bake skeleton + weights into an FBX. We then
   re-export the FBX to GLB so the rest of FabMesh can stay GLB-only.

Setup
-----
The script expects ``external/Puppeteer/`` to contain a clone of the
upstream repo, its checkpoints, AND a dedicated Python 3.10 venv at
``external/Puppeteer/venv/Scripts/python.exe`` (Windows layout).

    # 1. Clone repo (recursive — pulls Michelangelo/PointCloudEncoder)
    cd external
    git clone --recursive https://github.com/Seed3D/Puppeteer.git
    cd Puppeteer

    # 2. Dedicated venv (Python 3.10.13)
    py -3.10 -m venv venv
    venv\\Scripts\\activate

    # 3. Blackwell / RTX 5080 (sm_120) compatibility
    #
    # Upstream pins torch 2.1.1+cu118 which has NO Blackwell kernels.
    # Install the CUDA 12.8 build instead:
    pip install torch==2.6.0+cu128 torchvision torchaudio \\
        --index-url https://download.pytorch.org/whl/cu128
    # flash-attn 2.6.3 also lacks Blackwell support — use the first
    # sm_120-aware wheel:
    pip install flash-attn==2.7.4.post1 --no-build-isolation
    # torch-scatter must match torch+cu128:
    pip install torch-scatter \\
        -f https://data.pyg.org/whl/torch-2.6.0+cu128.html
    # pytorch3d (Blackwell-friendly build):
    pip install pytorch3d \\
        -f https://dl.fbaipublicfiles.com/pytorch3d/packaging/wheels/index.html
    # bpy pip wheel (no system Blender needed):
    pip install bpy==4.2.0
    # Remaining repo deps:
    pip install -r requirements.txt

    # 4. Checkpoints (HF)
    huggingface-cli download Seed3D/Puppeteer \\
        puppeteer_skeleton_w_diverse_pose.pth \\
        --local-dir external/Puppeteer/skeleton/skeleton_ckpts
    huggingface-cli download Seed3D/Puppeteer \\
        puppeteer_skin_w_diverse_pose_depth1.pth \\
        --local-dir external/Puppeteer/skinning/skinning_ckpts

Usage
-----
    python puppeteer_bridge.py <mesh_path> <output_glb>

Known limitations
-----------------
- The skinning stage REQUIRES torchrun (DDP). We launch it via
  ``-m torch.distributed.run`` from the venv to avoid PATH issues on
  Windows.
- Puppeteer accepts .obj / .ply only. .glb / .fbx / .stl inputs are
  converted to .obj on the fly via trimesh (in the bridge's parent env).
- The FBX → GLB conversion uses trimesh as a fallback; if that round-trip
  loses the armature, we fall back to a Blender (``bpy`` venv) export.
"""
import os
import sys
import subprocess
import tempfile
import shutil
import time

HERE = os.path.abspath(os.path.dirname(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(HERE, ".."))
PUP_DIR = os.path.join(PROJECT_ROOT, "external", "Puppeteer")
VENV_PY = os.path.join(PUP_DIR, "venv", "Scripts", "python.exe")
VENV_BIN = os.path.join(PUP_DIR, "venv", "Scripts")

SKELETON_DIR = os.path.join(PUP_DIR, "skeleton")
SKINNING_DIR = os.path.join(PUP_DIR, "skinning")
# Puppeteer ships export.py at the repo top-level (NOT under a
# final_rigging/ subdir as the earlier audit incorrectly claimed).
FINAL_DIR = PUP_DIR

SKELETON_DEMO = os.path.join(SKELETON_DIR, "demo.py")
SKINNING_MAIN = os.path.join(SKINNING_DIR, "main.py")
FINAL_EXPORT = os.path.join(FINAL_DIR, "export.py")

SKEL_CKPT = os.path.join(
    SKELETON_DIR, "skeleton_ckpts", "puppeteer_skeleton_w_diverse_pose.pth"
)
SKIN_CKPT = os.path.join(
    SKINNING_DIR, "skinning_ckpts", "puppeteer_skin_w_diverse_pose_depth1.pth"
)

SETUP_HINT = (
    "AUTORIG_ERROR: see scripts/puppeteer_bridge.py header docstring for "
    "the full setup procedure (clone, venv, torch 2.6.0+cu128, flash-attn "
    "2.7.4.post1, HF checkpoint download)."
)


def log(msg):
    print(f"PUPPET: {msg}", flush=True)


def _stream(proc):
    """Drain a Popen's stdout (line-buffered) until EOF, mirroring lines."""
    for line in iter(proc.stdout.readline, ""):
        if not line:
            break
        line = line.rstrip()
        if line:
            print(line, flush=True)
    proc.stdout.close()
    return proc.wait()


def _venv_env():
    env = os.environ.copy()
    env["PATH"] = VENV_BIN + os.pathsep + env.get("PATH", "")
    env["CUDA_VISIBLE_DEVICES"] = env.get("CUDA_VISIBLE_DEVICES", "0")
    # Make sure Puppeteer's repo root is importable (some sub-modules
    # do ``from skeleton.foo import ...``).
    pp = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = PUP_DIR + (os.pathsep + pp if pp else "")
    return env


def _convert_to_obj(mesh_path, tmp_dir):
    """Convert .glb/.fbx/.stl → .obj using trimesh (bridge parent env).

    Pass-through if already .obj or .ply.
    """
    ext = os.path.splitext(mesh_path)[1].lower()
    if ext in (".obj", ".ply"):
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


def _run_skeleton(input_obj, work_dir, run_name):
    """Step 1 — skeleton/demo.py (single-GPU, no torchrun)."""
    examples_dir = os.path.join(work_dir, "examples")
    os.makedirs(examples_dir, exist_ok=True)
    staged = os.path.join(examples_dir, os.path.basename(input_obj))
    if os.path.abspath(staged) != os.path.abspath(input_obj):
        shutil.copyfile(input_obj, staged)
    results_dir = os.path.join(work_dir, "results")
    os.makedirs(results_dir, exist_ok=True)

    cmd = [
        VENV_PY, SKELETON_DEMO,
        "--input_dir", examples_dir.replace("\\", "/"),
        "--pretrained_weights", SKEL_CKPT.replace("\\", "/"),
        "--output_dir", results_dir.replace("\\", "/"),
        "--save_name", run_name,
        "--input_pc_num", "8192",
        "--save_render",
        "--apply_marching_cubes",
        "--joint_token",
        "--seq_shuffle",
    ]
    log(f"exec: {' '.join(cmd)}")
    proc = subprocess.Popen(
        cmd,
        cwd=SKELETON_DIR,
        env=_venv_env(),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    rc = _stream(proc)
    return rc, results_dir, staged


def _run_skinning(skel_results_dir, mesh_examples_dir, work_dir):
    """Step 2 — skinning/main.py via torchrun (DDP, single GPU)."""
    skin_out = os.path.join(work_dir, "skin_results")
    os.makedirs(skin_out, exist_ok=True)
    cmd = [
        VENV_PY, "-m", "torch.distributed.run",
        "--nproc_per_node=1",
        "--master_port=10009",
        SKINNING_MAIN,
        "--num_workers", "1",
        "--batch_size", "1",
        "--generate",
        "--save_skin_npy",
        "--pretrained_weights", SKIN_CKPT.replace("\\", "/"),
        "--input_skel_folder", skel_results_dir.replace("\\", "/"),
        "--mesh_folder", mesh_examples_dir.replace("\\", "/"),
        "--post_filter",
        "--depth", "1",
        "--save_folder", skin_out.replace("\\", "/"),
    ]
    log(f"exec: {' '.join(cmd)}")
    proc = subprocess.Popen(
        cmd,
        cwd=SKINNING_DIR,
        env=_venv_env(),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    rc = _stream(proc)
    return rc, skin_out


def _run_export(mesh_obj, rig_txt, out_fbx):
    """Step 3 — final_rigging/export.py (uses bpy pip wheel)."""
    cmd = [
        VENV_PY, FINAL_EXPORT,
        "--mesh", mesh_obj.replace("\\", "/"),
        "--rig", rig_txt.replace("\\", "/"),
        "--output", out_fbx.replace("\\", "/"),
    ]
    log(f"exec: {' '.join(cmd)}")
    proc = subprocess.Popen(
        cmd,
        cwd=FINAL_DIR,
        env=_venv_env(),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    rc = _stream(proc)
    return rc


def _fbx_to_glb(fbx_path, glb_path):
    """Convert the Puppeteer FBX output to GLB.

    First try trimesh in the bridge env (fast, no extra process). If that
    drops the armature (trimesh has no FBX skinning support) we fall back
    to a bpy round-trip inside the Puppeteer venv.
    """
    # Attempt 1: trimesh (geometry only — fine if downstream
    # swap_skeleton.py rebuilds the rig, which is the current pipeline).
    try:
        import trimesh
        log("FBX → GLB via trimesh (geometry only)")
        scene = trimesh.load(fbx_path, force="scene")
        scene.export(glb_path)
        if os.path.exists(glb_path) and os.path.getsize(glb_path) > 0:
            return True
    except Exception as exc:
        log(f"trimesh FBX→GLB failed: {exc}")

    # Attempt 2: bpy round-trip in the Puppeteer venv (preserves armature).
    log("falling back to bpy FBX→GLB (Puppeteer venv)")
    snippet = (
        "import bpy, sys\n"
        "bpy.ops.wm.read_factory_settings(use_empty=True)\n"
        f"bpy.ops.import_scene.fbx(filepath=r'{fbx_path}')\n"
        f"bpy.ops.export_scene.gltf(filepath=r'{glb_path}', export_format='GLB')\n"
        "print('PUPPET: bpy export ok')\n"
    )
    tmp_py = os.path.join(tempfile.gettempdir(), "_pup_fbx2glb.py")
    with open(tmp_py, "w", encoding="utf-8") as f:
        f.write(snippet)
    proc = subprocess.Popen(
        [VENV_PY, tmp_py],
        env=_venv_env(),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    rc = _stream(proc)
    try:
        os.remove(tmp_py)
    except Exception:
        pass
    return rc == 0 and os.path.exists(glb_path) and os.path.getsize(glb_path) > 0


def _preflight():
    """Validate install state. Returns None on success or exits 1."""
    if not os.path.isdir(PUP_DIR):
        print(f"AUTORIG_ERROR: Puppeteer not installed at {PUP_DIR}")
        print(SETUP_HINT)
        sys.exit(1)
    if not os.path.exists(VENV_PY):
        print(f"AUTORIG_ERROR: Puppeteer venv not found at {VENV_PY}")
        print(SETUP_HINT)
        sys.exit(1)
    for required in (SKELETON_DEMO, SKINNING_MAIN, FINAL_EXPORT):
        if not os.path.exists(required):
            print(f"AUTORIG_ERROR: missing Puppeteer script: {required}")
            print(SETUP_HINT)
            sys.exit(1)
    for ckpt in (SKEL_CKPT, SKIN_CKPT):
        if not os.path.exists(ckpt):
            print(f"AUTORIG_ERROR: checkpoint missing: {ckpt}")
            print(SETUP_HINT)
            sys.exit(1)


def main():
    if len(sys.argv) < 3:
        print("AUTORIG_ERROR: usage: puppeteer_bridge.py <mesh_path> <output_glb>")
        sys.exit(1)
    mesh_path = os.path.abspath(sys.argv[1])
    output_glb = os.path.abspath(sys.argv[2])

    if not os.path.exists(mesh_path):
        print(f"AUTORIG_ERROR: mesh not found: {mesh_path}")
        sys.exit(1)
    _preflight()

    log(f"mesh={mesh_path}")
    log(f"output={output_glb}")

    tmp_dir = tempfile.mkdtemp(prefix="puppeteer_")
    try:
        # Step 1 — input conversion
        log("== Step 1: input conversion ==")
        t0 = time.time()
        input_obj = _convert_to_obj(mesh_path, tmp_dir)
        log(f"step 1 convert in {time.time()-t0:.1f}s")

        # Step 2 — skeleton prediction
        log("== Step 2: skeleton prediction ==")
        t0 = time.time()
        run_name = "fabmesh"
        rc, results_dir, staged_obj = _run_skeleton(input_obj, tmp_dir, run_name)
        skel_run_dir = os.path.join(results_dir, run_name)
        if not os.path.isdir(skel_run_dir):
            print(f"AUTORIG_ERROR: skeleton stage produced no output dir. rc={rc}")
            sys.exit(1)
        pred_txt = None
        mesh_obj_out = None
        for fname in os.listdir(skel_run_dir):
            fp = os.path.join(skel_run_dir, fname)
            if fname.endswith("_pred.txt"):
                pred_txt = fp
            elif fname.endswith("_mesh.obj"):
                mesh_obj_out = fp
        if pred_txt is None:
            print(f"AUTORIG_ERROR: no _pred.txt in {skel_run_dir}. rc={rc}")
            sys.exit(1)
        log(f"step 2 skeleton in {time.time()-t0:.1f}s "
            f"(pred={os.path.basename(pred_txt)})")

        # Step 3 — skinning (DDP, single GPU)
        log("== Step 3: skinning (torchrun, 1 GPU) ==")
        t0 = time.time()
        # The skinning stage expects skel txt files in input_skel_folder
        # and the matching meshes in mesh_folder, keyed by basename.
        mesh_examples_dir = os.path.dirname(staged_obj)
        # Mirror the demo_rigging.sh layout: a flat skeletons/ folder.
        skel_flat = os.path.join(tmp_dir, "skeletons")
        os.makedirs(skel_flat, exist_ok=True)
        shutil.copyfile(pred_txt, os.path.join(skel_flat, os.path.basename(pred_txt)))
        # Some versions of Puppeteer key by <name>.txt rather than
        # <name>_pred.txt — provide both names defensively.
        base_no_pred = os.path.basename(pred_txt).replace("_pred.txt", ".txt")
        shutil.copyfile(pred_txt, os.path.join(skel_flat, base_no_pred))
        rc, skin_out = _run_skinning(skel_flat, mesh_examples_dir, tmp_dir)
        skin_gen = os.path.join(skin_out, "generate")
        if not os.path.isdir(skin_gen):
            # Some forks write straight into save_folder.
            skin_gen = skin_out
        skin_txt = None
        for fname in os.listdir(skin_gen):
            if fname.endswith("_skin.txt"):
                skin_txt = os.path.join(skin_gen, fname)
                break
        if skin_txt is None:
            print(f"AUTORIG_ERROR: skinning stage produced no *_skin.txt in "
                  f"{skin_gen}. rc={rc}")
            sys.exit(1)
        log(f"step 3 skinning in {time.time()-t0:.1f}s "
            f"(skin={os.path.basename(skin_txt)})")

        # Step 4 — final export (FBX via bpy pip wheel)
        log("== Step 4: final FBX export ==")
        t0 = time.time()
        # Puppeteer's export.py expects a single rig text file combining
        # joints + weights. demo_rigging.sh concatenates _pred.txt and
        # _skin.txt into final_rigging/<name>.txt.
        final_txt = os.path.join(tmp_dir, "final_rig.txt")
        with open(final_txt, "w", encoding="utf-8") as out:
            with open(pred_txt, "r", encoding="utf-8") as src:
                out.write(src.read())
            out.write("\n")
            with open(skin_txt, "r", encoding="utf-8") as src:
                out.write(src.read())
        bake_mesh = mesh_obj_out if mesh_obj_out else staged_obj
        out_fbx = os.path.join(tmp_dir, "rigged.fbx")
        rc = _run_export(bake_mesh, final_txt, out_fbx)
        if rc != 0 or not os.path.exists(out_fbx):
            print(f"AUTORIG_ERROR: final FBX export failed. rc={rc}")
            sys.exit(1)
        log(f"step 4 export in {time.time()-t0:.1f}s "
            f"(fbx={os.path.getsize(out_fbx)} bytes)")

        # Step 5 — FBX → GLB so the rest of FabMesh stays GLB-only
        log("== Step 5: FBX → GLB ==")
        t0 = time.time()
        ok = _fbx_to_glb(out_fbx, output_glb)
        if not ok or not os.path.exists(output_glb):
            print(f"AUTORIG_ERROR: FBX→GLB conversion failed: {output_glb}")
            sys.exit(1)
        sz = os.path.getsize(output_glb)
        log(f"step 5 glb in {time.time()-t0:.1f}s ({sz} bytes)")

        print(f"AUTORIG_SUCCESS: {output_glb} ({sz} bytes)")
        sys.exit(0)
    finally:
        try:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        except Exception:
            pass


if __name__ == "__main__":
    main()
