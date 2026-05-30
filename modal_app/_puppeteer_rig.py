"""Puppeteer auto-rig — cloud version (Modal).

Mirrors `scripts/puppeteer_bridge.py` but as a self-contained Modal app:
the rig function takes the GLB bytes of an unrigged mesh, runs the three
upstream Puppeteer stages on a Modal L4/A10G container, and returns the
rigged GLB bytes.

The desktop bridge launches the three stages as subprocesses against a
preinstalled Windows venv. On Modal we bake the whole `Seed3D/Puppeteer`
tree + Python dependencies into the image, and we still drive the stages
via `subprocess.run([sys.executable, ...])` because the skeleton + skin
scripts expect their `cwd` to be the upstream sub-package directory
(their internal imports use `from models.xxx import ...` paths that only
resolve when CWD is the right folder). Trying to import them in-process
would require monkey-patching `sys.path` for every relative import and
would NOT save measurable time — skeleton + skin are GPU-bound, not
spawn-bound.

WHY this is a separate file (and a separate Modal app):
- Puppeteer's stack is incompatible with TRELLIS-2's (torch 2.7 vs 2.4,
  triton 3.2, flash-attn 2.7.4.post1). Sharing an image would force one
  of the two to downgrade and break compile.
- The Volume + async pattern from `MyFabmeshMesh` is reused (mesh-start
  spawns, mesh-status polls), but the rig stage typically completes in
  ~110 s end-to-end, so we keep a synchronous endpoint variant on top for
  ad-hoc curl testing during the wiring phase.

DEPLOY:
    modal token new
    modal secret create huggingface HF_TOKEN=<your hf token>
    modal secret create myfabmesh-shared SHARED_SECRET=<32-byte hex>
    modal deploy modal_app/_puppeteer_rig.py

The first deploy builds the image, which takes ~25-40 min (flash-attn
2.7.4.post1 compiles from source under `--no-build-isolation`, torch
2.7 + CUDA 12.8 dev image is large, HF checkpoints pull at build time).
Subsequent deploys reuse cached layers and take <1 min.

INVOKE (once deployed):
    The endpoint is exposed at:
      https://<workspace>--myfabmesh-rig-rig-mesh-endpoint.modal.run
    The Cloudflare worker sets MODAL_RIG_URL to this address. Auth uses
    the shared secret passed in the JSON body as `_auth`, matching the
    convention used by all the other modal_app endpoints.

License: Puppeteer is Apache-2.0 (Seed3D), Michelangelo is Apache-2.0
(maikou). We can redistribute their checkpoints inside our Modal image.
"""
import base64
import io
import os
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.request

import modal

# ---------------------------------------------------------------------------
# Image: torch 2.7.0 + CUDA 12.8 (matches the desktop Puppeteer venv per
# AGENT_LOG 2026-05-30). flash-attn 2.7.4.post1 is the FIRST wheel with
# Blackwell (sm_120) support — and the version the desktop runs against.
# On Linux Modal we KEEP the upstream `nccl` distributed backend (the
# Windows-only `gloo` override is dropped). vtk stub is N/A — Smart App
# Control is Windows-only.
# ---------------------------------------------------------------------------
image = (
    # nvidia/cuda:12.8.1-devel includes nvcc (CUDA compiler) which is
    # REQUIRED for flash-attn's source build. debian_slim only has CUDA
    # runtime libs (no nvcc) -> flash-attn build fails with
    # "CUDA_HOME environment variable is not set".
    modal.Image.from_registry(
        "nvidia/cuda:12.8.1-devel-ubuntu22.04",
        add_python="3.10",
    )
    .env({"CUDA_HOME": "/usr/local/cuda"})
    .apt_install(
        # clang/clang++ — pytorch3d setup.py uses clang++ as linker even
        # when CC/CXX are gcc/g++ (Modal's add_python="3.10" toolchain hint).
        # Without it: "clang++: No such file or directory" at link stage
        # after 67/67 nvcc compiles succeeded.
        "clang",
        "git", "build-essential", "ninja-build",
        # libgl1 / libegl1 — required by bpy 4.2 even in headless mode
        # (it links against system OpenGL libs at import).
        "libgl1", "libegl1",
        # Common shared libs used by trimesh / opencv (kept here to
        # avoid surprise ImportErrors on Modal's slim base).
        "libglib2.0-0", "libsm6", "libxext6", "libxrender1",
        # wget required to pull the Michelangelo VAE checkpoint that
        # upstream's submodule pulls via LFS (not bundled with pip).
        "wget", "ca-certificates",
    )
    # ---- PyTorch + Blackwell stack (mirrors external/Puppeteer/venv) ----
    .pip_install(
        # Pinned to 2.7.0+cu128 — matches AGENT_LOG 2026-05-30 SUCCESS row.
        # The original Puppeteer pin is 2.1.1+cu118 which has NO Blackwell
        # kernels. On Modal L4/A10G (sm_89) the cu128 build still works
        # because nvcc emits sm_89 PTX for it.
        "torch==2.7.0",
        "torchvision==0.22.0",
        "torchaudio==2.7.0",
        extra_options="--index-url https://download.pytorch.org/whl/cu128",
    )
    .pip_install(
        # Build deps required by flash-attn setup.py with --no-build-isolation:
        # the isolated env is OFF so the BASE env must already have packaging,
        # setuptools, wheel, ninja. Without them: ModuleNotFoundError: packaging.
        "packaging",
        "setuptools",
        "wheel",
        "ninja",
    )
    .pip_install(
        # flash-attn 2.7.4.post1 — first wheel with sm_120 support. On
        # Linux Modal there is no prebuilt wheel for torch 2.7 / py3.10 /
        # cu128 in PyPI, so pip builds from source. --no-build-isolation
        # is REQUIRED (the build setup.py imports torch at build time;
        # without it the isolated env has no torch and the build crashes).
        "flash-attn==2.7.4.post1",
        extra_options="--no-build-isolation",
    )
    .pip_install(
        # torch-scatter — must match the +cu128 wheel index. Same version
        # the desktop venv uses (pulled from data.pyg.org, NOT PyPI).
        "torch-scatter==2.1.2",
        extra_options=(
            "-f https://data.pyg.org/whl/torch-2.7.0+cu128.html"
        ),
    )
    .pip_install(
        # pytorch3d build deps (compiled from git source — see next step).
        # The fbaipublicfiles wheel index does NOT publish wheels for
        # torch 2.7 + cu128 + py310 (only torch 2.1-2.4). Install from
        # source against our exact torch + nvcc.
        "fvcore", "iopath",
    )
    .run_commands(
        # pytorch3d from git source (stable tag, builds against torch
        # 2.7+cu128 with nvcc from the cuda:devel base). ~10-15 min.
        "FORCE_CUDA=1 TORCH_CUDA_ARCH_LIST='8.0;8.9;9.0+PTX' "
        "pip install --no-build-isolation "
        "'git+https://github.com/facebookresearch/pytorch3d.git@v0.7.6'",
    )
    # ---- Puppeteer requirements + the bits the desktop venv ships ----
    .pip_install(
        # bpy 4.2 wheel — pure Python wheel of Blender 4.2 for headless
        # FBX → GLB conversion in the final export stage. No system
        # Blender needed.
        "bpy==4.2.0",
        # Core mesh / geometry utilities used by the bridge.
        "trimesh>=4.0",
        "numpy<2",   # bpy 4.2 + torch-scatter both prefer numpy 1.x
        # Mesh prep / SDF / tet utilities used by the skeleton + skinning
        # stages (upstream requirements.txt).
        "tetgen==0.8.4",
        "mesh2sdf",
        "pyrender",
        # Misc deps pulled by upstream's requirements.txt.
        "h5py", "plyfile", "timm", "loguru", "lightning",
        "boto3", "einops", "opencv-python", "omegaconf",
        "transformers>=4.40,<4.56",
        "accelerate>=0.30",
        "huggingface_hub>=0.34",
        "pillow>=10",
        "tqdm",
        # FastAPI — required by @modal.fastapi_endpoint.
        "fastapi[standard]>=0.115",
    )
    .env({
        "CC": "gcc", "CXX": "g++",
        "CUDA_HOME": "/usr/local/cuda",
        "TORCH_CUDA_ARCH_LIST": "8.0;8.9;9.0+PTX",
        "FORCE_CUDA": "1",
        # Tell huggingface_hub to use the shared cache the HF token
        # secret will populate at runtime.
        "HF_HOME": "/root/.cache/huggingface",
    })
    # ---- Puppeteer source tree (HEAD of master, Apache-2.0) ----
    .run_commands(
        # `--recursive` pulls Michelangelo as a submodule under
        # skeleton/third_partys/Michelangelo. The skinning stage needs
        # the same Michelangelo tree — we duplicate it below.
        "git clone --depth 1 --recursive "
        "https://github.com/Seed3D/Puppeteer.git /Puppeteer",
        # ---- Upstream patches (mirror of AGENT_LOG 2026-05-30 SUCCESS) ----
        # 1. weights_only=False at the 3 torch.load sites — torch 2.6+
        #    flipped the default and the Puppeteer checkpoints contain
        #    non-tensor objects (PyTorch Lightning metadata) that the
        #    new default rejects.
        "sed -i 's/torch.load(\\(.*\\.pth.*\\))/torch.load(\\1, weights_only=False)/g' "
        "/Puppeteer/skeleton/models/asl_pl_module.py",
        "sed -i 's/torch.load(\\(.*\\.pth.*\\))/torch.load(\\1, weights_only=False)/g' "
        "/Puppeteer/skeleton/demo.py",
        "sed -i 's/torch.load(\\(.*\\.pth.*\\))/torch.load(\\1, weights_only=False)/g' "
        "/Puppeteer/skinning/main.py",
        # 2. Copy Michelangelo into skinning/third_partys/ (skinning
        #    expects it at that path; upstream submodule lives only
        #    under skeleton/third_partys/).
        "mkdir -p /Puppeteer/skinning/third_partys",
        "cp -r /Puppeteer/skeleton/third_partys/Michelangelo "
        "/Puppeteer/skinning/third_partys/Michelangelo",
        # 3. NO gloo backend override — upstream uses nccl on Linux,
        #    which is what we want. (Windows-only override skipped.)
        # 4. NO vtk stub — Smart App Control is Windows-only.
    )
    # ---- HuggingFace checkpoints (Seed3D/Puppeteer, Apache-2.0) ----
    .run_commands(
        # Skeleton checkpoint.
        "mkdir -p /Puppeteer/skeleton/skeleton_ckpts",
        "wget -q -O /Puppeteer/skeleton/skeleton_ckpts/"
        "puppeteer_skeleton_w_diverse_pose.pth "
        "https://huggingface.co/Seed3D/Puppeteer/resolve/main/"
        "puppeteer_skeleton_w_diverse_pose.pth",
        # Skinning checkpoint.
        "mkdir -p /Puppeteer/skinning/skinning_ckpts",
        "wget -q -O /Puppeteer/skinning/skinning_ckpts/"
        "puppeteer_skin_w_diverse_pose_depth1.pth "
        "https://huggingface.co/Seed3D/Puppeteer/resolve/main/"
        "puppeteer_skin_w_diverse_pose_depth1.pth",
        # Michelangelo VAE checkpoint — required by both stages'
        # point-cloud encoder. The submodule pulls only the source, the
        # weights live separately on HF (maikou/Michelangelo).
        "mkdir -p /Puppeteer/skeleton/third_partys/Michelangelo/"
        "checkpoints/aligned_shape_latents",
        "wget -q -O /Puppeteer/skeleton/third_partys/Michelangelo/"
        "checkpoints/aligned_shape_latents/shapevae-256.ckpt "
        "https://huggingface.co/Maikou/Michelangelo/resolve/main/"
        "checkpoints/aligned_shape_latents/shapevae-256.ckpt",
        # Mirror the same VAE under skinning's tree (mirrors the
        # third_partys copy we made for the Michelangelo source).
        "mkdir -p /Puppeteer/skinning/third_partys/Michelangelo/"
        "checkpoints/aligned_shape_latents",
        "cp /Puppeteer/skeleton/third_partys/Michelangelo/"
        "checkpoints/aligned_shape_latents/shapevae-256.ckpt "
        "/Puppeteer/skinning/third_partys/Michelangelo/"
        "checkpoints/aligned_shape_latents/shapevae-256.ckpt",
        # Build-time guard — fail the image build if any of these went
        # sideways instead of crash-looping at runtime.
        "python -c \"import os; "
        "files = ["
        "'/Puppeteer/skeleton/skeleton_ckpts/"
        "puppeteer_skeleton_w_diverse_pose.pth', "
        "'/Puppeteer/skinning/skinning_ckpts/"
        "puppeteer_skin_w_diverse_pose_depth1.pth', "
        "'/Puppeteer/skeleton/third_partys/Michelangelo/"
        "checkpoints/aligned_shape_latents/shapevae-256.ckpt']; "
        "missing = [f for f in files if not os.path.isfile(f) "
        "or os.path.getsize(f) < 1024]; "
        "assert not missing, f'ckpt missing/empty: {missing}'; "
        "print('all puppeteer checkpoints present')\"",
        "python -c \"import torch, flash_attn, torch_scatter, bpy, "
        "trimesh; print('torch', torch.__version__, "
        "'flash_attn', flash_attn.__version__, 'bpy', bpy.app.version_string)\"",
    )
)

app = modal.App("myfabmesh-rig", image=image)

# Volume to persist async rig outputs the same way `_mesh.py` does.
# `rig-start` spawns the rig job and returns {job_id}; `rig-status` reads
# /data/<job_id>.glb (or .err on failure). Volume survives container
# restarts so the status endpoint can land on a different container than
# the worker that produced the file.
rig_output_volume = modal.Volume.from_name(
    "myfabmesh-rig-output", create_if_missing=True,
)


# ---------------------------------------------------------------------------
# Helpers ported from scripts/puppeteer_bridge.py
# ---------------------------------------------------------------------------
PUP_DIR = "/Puppeteer"
SKELETON_DIR = f"{PUP_DIR}/skeleton"
SKINNING_DIR = f"{PUP_DIR}/skinning"
FINAL_DIR = PUP_DIR
SKEL_CKPT = f"{SKELETON_DIR}/skeleton_ckpts/puppeteer_skeleton_w_diverse_pose.pth"
SKIN_CKPT = f"{SKINNING_DIR}/skinning_ckpts/puppeteer_skin_w_diverse_pose_depth1.pth"


def _log(msg: str) -> None:
    print(f"[rig] {msg}", flush=True)


def _recenter_to_obj(glb_bytes: bytes, tmp_dir: str) -> str:
    """GLB bytes → .obj, with feet at Y=0 and X-Z centered (matches the
    FabMesh _jsCenter convention used by the desktop bridge). Returns the
    path of the written .obj."""
    import trimesh
    import numpy as np
    glb_path = os.path.join(tmp_dir, "input.glb")
    with open(glb_path, "wb") as f:
        f.write(glb_bytes)
    out_obj = os.path.join(tmp_dir, "input.obj")
    scene = trimesh.load(glb_path, force="mesh")
    if not hasattr(scene, "vertices"):
        raise RuntimeError("trimesh could not load input glb as a mesh")
    bb_min = scene.vertices.min(axis=0)
    bb_max = scene.vertices.max(axis=0)
    cx = (bb_min[0] + bb_max[0]) * 0.5
    cz = (bb_min[2] + bb_max[2]) * 0.5
    fy = bb_min[1]
    scene.vertices = scene.vertices - np.array(
        [cx, fy, cz], dtype=scene.vertices.dtype)
    scene.export(out_obj)
    _log(f"recentered → {out_obj} ({os.path.getsize(out_obj)} bytes)")
    return out_obj


def _stream(proc: subprocess.Popen) -> int:
    """Stream stdout line-by-line to Modal's container log (so the user
    sees skeleton/skin progress in `modal app logs`)."""
    if proc.stdout is None:
        return proc.wait()
    for line in proc.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
    return proc.wait()


def _run_skeleton(input_obj: str, work_dir: str, run_name: str):
    """Step 1 — skeleton/demo.py (single-GPU, no torchrun)."""
    examples_dir = os.path.join(work_dir, "examples")
    os.makedirs(examples_dir, exist_ok=True)
    staged = os.path.join(examples_dir, os.path.basename(input_obj))
    if os.path.abspath(staged) != os.path.abspath(input_obj):
        shutil.copyfile(input_obj, staged)
    results_dir = os.path.join(work_dir, "results")
    os.makedirs(results_dir, exist_ok=True)

    cmd = [
        sys.executable, f"{SKELETON_DIR}/demo.py",
        "--input_dir", examples_dir,
        "--pretrained_weights", SKEL_CKPT,
        "--output_dir", results_dir,
        "--save_name", run_name,
        "--input_pc_num", "8192",
        "--save_render",
        "--apply_marching_cubes",
        "--joint_token",
        "--seq_shuffle",
    ]
    _log(f"skeleton: {' '.join(cmd)}")
    proc = subprocess.Popen(
        cmd, cwd=SKELETON_DIR,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
    )
    rc = _stream(proc)
    return rc, results_dir, staged


def _run_skinning(skel_flat: str, mesh_examples_dir: str, work_dir: str):
    """Step 2 — skinning/main.py direct, with manual DDP env vars.

    Upstream uses `torchrun --nproc_per_node=1` but its libuv backend
    causes issues on some Linux containers; passing the env vars by hand
    is reliable and works around it. NCCL is the right backend here
    (Linux + GPU)."""
    skin_out = os.path.join(work_dir, "skin_results")
    os.makedirs(skin_out, exist_ok=True)
    cmd = [
        sys.executable, f"{SKINNING_DIR}/main.py",
        "--num_workers", "1",
        "--batch_size", "1",
        "--generate",
        "--save_skin_npy",
        "--pretrained_weights", SKIN_CKPT,
        "--input_skel_folder", skel_flat,
        "--mesh_folder", mesh_examples_dir,
        "--post_filter",
        "--depth", "1",
        "--save_folder", skin_out,
    ]
    env = dict(os.environ)
    env["RANK"] = "0"
    env["LOCAL_RANK"] = "0"
    env["WORLD_SIZE"] = "1"
    env["MASTER_ADDR"] = "127.0.0.1"
    env["MASTER_PORT"] = "10009"
    _log(f"skinning: {' '.join(cmd)}")
    proc = subprocess.Popen(
        cmd, cwd=SKINNING_DIR, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
    )
    rc = _stream(proc)
    return rc, skin_out


def _build_final_rig_txt(pred_txt: str, skin_txt: str, out_path: str) -> None:
    """Concat the joints/hier/root lines from `_pred.txt` and only the
    `skin` lines from `_skin.txt` into a single rig file for export.py.

    export.py increments a `tot` counter on every `joints` line and
    indexes `id_mapping[tot]` — if we passed both files raw the duplicate
    `joints` lines would bump `tot` past `len(joint_pos)` and crash.
    We also strip blank lines because export.py L165 does `word[0]`
    without bounds checking on `split()` output."""
    with open(out_path, "w", encoding="utf-8") as out:
        with open(pred_txt, "r", encoding="utf-8") as src:
            for line in src:
                s = line.strip()
                if not s:
                    continue
                first = s.split()[0]
                if first in ("joints", "hier", "root"):
                    out.write(line if line.endswith("\n") else line + "\n")
        with open(skin_txt, "r", encoding="utf-8") as src:
            for line in src:
                s = line.strip()
                if not s:
                    continue
                if s.split()[0] == "skin":
                    out.write(line if line.endswith("\n") else line + "\n")


def _run_export(mesh_obj: str, rig_txt: str, out_fbx: str) -> int:
    """Step 3 — export.py (Puppeteer bakes skeleton + weights into FBX
    via the bpy pip wheel — no system Blender needed)."""
    cmd = [
        sys.executable, f"{FINAL_DIR}/export.py",
        "--mesh", mesh_obj,
        "--rig", rig_txt,
        "--output", out_fbx,
    ]
    _log(f"export: {' '.join(cmd)}")
    proc = subprocess.Popen(
        cmd, cwd=FINAL_DIR,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
    )
    return _stream(proc)


def _fbx_to_glb(fbx_path: str, glb_path: str) -> bool:
    """FBX → GLB. Try trimesh first (fast, no extra process); on failure
    fall back to a bpy round-trip which preserves the armature."""
    try:
        import trimesh
        _log("FBX → GLB via trimesh")
        scene = trimesh.load(fbx_path, force="scene")
        scene.export(glb_path)
        if os.path.exists(glb_path) and os.path.getsize(glb_path) > 0:
            return True
    except Exception as exc:
        _log(f"trimesh FBX→GLB failed: {exc} — falling back to bpy")
    try:
        import bpy
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.fbx(filepath=fbx_path)
        bpy.ops.export_scene.gltf(filepath=glb_path, export_format="GLB")
    except Exception as exc:
        _log(f"bpy FBX→GLB failed: {exc}")
        return False
    return os.path.exists(glb_path) and os.path.getsize(glb_path) > 0


# ---------------------------------------------------------------------------
# Core function — synchronous version called by the simple web endpoint.
# Returns the rigged GLB bytes, raises on failure.
# ---------------------------------------------------------------------------
@app.function(
    image=image,
    gpu="A10G",
    timeout=600,
    secrets=[
        modal.Secret.from_name(
            "huggingface", required_keys=["HF_TOKEN"],
        ),
    ],
)
def rig_mesh(glb_bytes: bytes) -> bytes:
    """Run the full Puppeteer pipeline on `glb_bytes` and return the
    rigged GLB bytes.

    Stages (mirror of puppeteer_bridge.main()):
      1. recenter → .obj
      2. skeleton/demo.py
      3. skinning/main.py
      4. concat pred+skin → final_rig.txt
      5. export.py → FBX
      6. FBX → GLB

    On L4/A10G the typical wall-clock is ~120-150 s (vs ~113 s measured
    on a desktop 5080; A10G is slower per-watt but skeleton + skin are
    short on the L4 too)."""
    t_total = time.time()
    tmp_dir = tempfile.mkdtemp(prefix="puppeteer_")
    try:
        # Step 1 — recenter + .obj conversion.
        _log("== Step 1: convert + recenter ==")
        t0 = time.time()
        input_obj = _recenter_to_obj(glb_bytes, tmp_dir)
        _log(f"step 1 done in {time.time() - t0:.1f}s")

        # Step 2 — skeleton prediction.
        _log("== Step 2: skeleton prediction ==")
        t0 = time.time()
        run_name = "fabmesh"
        rc, results_dir, staged_obj = _run_skeleton(
            input_obj, tmp_dir, run_name)
        skel_run_dir = os.path.join(results_dir, run_name)
        if not os.path.isdir(skel_run_dir):
            raise RuntimeError(
                f"skeleton stage produced no output dir. rc={rc}")
        pred_txt = None
        for fname in os.listdir(skel_run_dir):
            if fname.endswith("_pred.txt"):
                pred_txt = os.path.join(skel_run_dir, fname)
                break
        if pred_txt is None:
            raise RuntimeError(
                f"no _pred.txt in {skel_run_dir}. rc={rc}")
        _log(f"step 2 done in {time.time() - t0:.1f}s "
             f"(pred={os.path.basename(pred_txt)})")

        # Step 3 — skinning (DDP, single-GPU, manual env vars).
        _log("== Step 3: skinning ==")
        t0 = time.time()
        mesh_examples_dir = os.path.dirname(staged_obj)
        skel_flat = os.path.join(tmp_dir, "skeletons")
        os.makedirs(skel_flat, exist_ok=True)
        shutil.copyfile(
            pred_txt,
            os.path.join(skel_flat, os.path.basename(pred_txt)),
        )
        base_no_pred = os.path.basename(pred_txt).replace(
            "_pred.txt", ".txt")
        shutil.copyfile(
            pred_txt, os.path.join(skel_flat, base_no_pred))
        rc, skin_out = _run_skinning(
            skel_flat, mesh_examples_dir, tmp_dir)
        skin_gen = os.path.join(skin_out, "generate")
        if not os.path.isdir(skin_gen):
            skin_gen = skin_out
        skin_txt = None
        for fname in os.listdir(skin_gen):
            if fname.endswith("_skin.txt"):
                skin_txt = os.path.join(skin_gen, fname)
                break
        if skin_txt is None:
            raise RuntimeError(
                f"skinning produced no *_skin.txt in {skin_gen}. rc={rc}")
        _log(f"step 3 done in {time.time() - t0:.1f}s "
             f"(skin={os.path.basename(skin_txt)})")

        # Step 4 — build final rig text (filtered concat).
        _log("== Step 4: build final_rig.txt ==")
        final_txt = os.path.join(tmp_dir, "final_rig.txt")
        _build_final_rig_txt(pred_txt, skin_txt, final_txt)

        # Step 5 — bake mesh + rig into FBX. We pass the ORIGINAL staged
        # .obj (NOT the marching-cubes mesh emitted by step 2) because
        # demo_rigging.sh upstream confirms that's what export.py expects.
        _log("== Step 5: FBX export ==")
        t0 = time.time()
        out_fbx = os.path.join(tmp_dir, "rigged.fbx")
        rc = _run_export(staged_obj, final_txt, out_fbx)
        if not os.path.exists(out_fbx) or os.path.getsize(out_fbx) == 0:
            raise RuntimeError(f"export.py produced no FBX. rc={rc}")
        _log(f"step 5 done in {time.time() - t0:.1f}s "
             f"(fbx={os.path.getsize(out_fbx)} bytes)")

        # Step 6 — FBX → GLB.
        _log("== Step 6: FBX → GLB ==")
        t0 = time.time()
        out_glb = os.path.join(tmp_dir, "rigged.glb")
        if not _fbx_to_glb(out_fbx, out_glb):
            raise RuntimeError("FBX → GLB conversion failed (both paths)")
        with open(out_glb, "rb") as f:
            out_bytes = f.read()
        _log(f"step 6 done in {time.time() - t0:.1f}s "
             f"(glb={len(out_bytes)} bytes)")

        _log(f"TOTAL dt={time.time() - t_total:.1f}s "
             f"out_bytes={len(out_bytes)}")
        return out_bytes
    finally:
        try:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# HTTP wrapper — synchronous endpoint suitable for ad-hoc curl tests and
# for the Worker's initial wiring. For production we'll add the async
# spawn/status pair on top (see /api/rig in worker.ts handleRig).
#
# Body:
#   {"_auth": "<SHARED_SECRET>", "mesh_url": "https://…/mesh.glb"}
# Response:
#   {"glb_base64": "..."}    (base64-encoded rigged GLB)
# ---------------------------------------------------------------------------
@app.function(
    image=image,
    timeout=900,
    secrets=[
        modal.Secret.from_name(
            "myfabmesh-shared", required_keys=["SHARED_SECRET"],
        ),
    ],
)
@modal.fastapi_endpoint(method="POST")
def rig_mesh_endpoint(payload: dict):
    """POST endpoint — fetches `mesh_url`, calls `rig_mesh`, returns
    {"glb_base64": "..."} JSON. Synchronous: the HTTP request stays open
    until the rig pipeline finishes (typical ~120 s on A10G). Cloudflare
    workers have a 100 s subrequest cap so the Worker MUST use the async
    rig-start / rig-status pair instead of this endpoint in production —
    this exists for direct curl testing during wiring."""
    from fastapi import HTTPException
    from fastapi.responses import JSONResponse

    expected = os.environ.get("SHARED_SECRET", "")
    provided = (payload.get("_auth") or "").strip()
    if not expected or provided != expected:
        raise HTTPException(status_code=401, detail="auth")

    mesh_url = (payload.get("mesh_url") or "").strip()
    if not mesh_url:
        raise HTTPException(
            status_code=400, detail="mesh_url required")

    _log(f"endpoint: fetching mesh_url={mesh_url[:120]}")
    try:
        req = urllib.request.Request(
            mesh_url,
            headers={
                "User-Agent":
                    "Mozilla/5.0 (X11; Linux x86_64) myfabmesh-rig/1.0",
            },
        )
        with urllib.request.urlopen(req, timeout=60) as r:
            in_bytes = r.read()
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"failed to fetch mesh_url: {e}",
        )
    _log(f"endpoint: fetched {len(in_bytes)} bytes")

    try:
        # `.remote()` runs the function on a GPU container; .local()
        # would run it inside this (CPU-only) endpoint container and
        # fail on CUDA-required imports.
        glb_bytes = rig_mesh.remote(in_bytes)
    except Exception as e:
        tb = traceback.format_exc()
        _log(f"endpoint: rig failed: {e}\n{tb}")
        raise HTTPException(
            status_code=500,
            detail=f"rig_mesh failed: {type(e).__name__}: {e}",
        )

    return JSONResponse(content={
        "glb_base64": base64.b64encode(glb_bytes).decode("ascii"),
        "bytes": len(glb_bytes),
    })
