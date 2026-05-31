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
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.request
import uuid

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
        # Python 3.11: bpy has ONLY a cp311 Linux wheel (no cp310). All other
        # deps (torch 2.7+cu128, flash-attn 2.7.4, pytorch3d 0.7.6) support cp311.
        "nvidia/cuda:12.8.1-devel-ubuntu22.04",
        add_python="3.11",
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
        # bpy headless needs libXi, libXxf86vm, libXfixes for X11 inputs
        # even when no display is attached.
        "libxi6", "libxxf86vm1", "libxfixes3", "libxkbcommon0",
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
    # ---- bpy: wget cp311 Linux wheel directly from files.pythonhosted.org ----
    # Modal pypi mirror blocks bpy and PyPI external is firewalled from build
    # containers. files.pythonhosted.org IS reachable. bpy 4.2.0 cp311 is the
    # ONLY Linux wheel that exists on PyPI.
    .run_commands(
        "wget -q -P /tmp "
        "https://files.pythonhosted.org/packages/0b/bc/5245f98dafa39166a4d4701d64077d281a36110e780011de5c38135089aa/"
        "bpy-4.2.0-cp311-cp311-manylinux_2_28_x86_64.whl",
        "pip install /tmp/bpy-4.2.0-cp311-cp311-manylinux_2_28_x86_64.whl",
        "rm /tmp/bpy-4.2.0-cp311-cp311-manylinux_2_28_x86_64.whl",
    )
    # ---- Puppeteer requirements + the bits the desktop venv ships ----
    .pip_install(
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
        # PartField (skinning third_party) deps — discovered via failed deploys
        "pytz",
        "vtk",  # Linux only — SAC is Windows-only
        "pymeshlab",
        "psutil",
        "scipy",
        "scikit-image",
        "scikit-learn",
        "yacs",
        "boto3", "einops", "opencv-python", "omegaconf",
        "transformers==4.46.1",  # exact pin: desktop venv version, Puppeteer-compatible
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
    # ---- Patcher script for torch.load weights_only=False ----
    # Uploaded once, reused in the next run_commands. Avoids inline-heredoc
    # quoting hell with bash + cat.
    .add_local_file(
        "modal_app/_patch_torch_load.py",
        "/tmp/_patch_torch_load.py",
        copy=True,
    )
    # ---- Puppeteer source tree (HEAD of master, Apache-2.0) ----
    .run_commands(
        # `--recursive` pulls Michelangelo as a submodule under
        # skeleton/third_partys/Michelangelo. The skinning stage needs
        # the same Michelangelo tree — we duplicate it below.
        "git clone --depth 1 --recursive "
        "https://github.com/Seed3D/Puppeteer.git /Puppeteer",
        # ---- Upstream patches (mirror of AGENT_LOG 2026-05-30 SUCCESS) ----
        # 1. weights_only=False at EVERY torch.load site via _patch_torch_load.py
        #    (uploaded as a local file below) — torch 2.6+ flipped the default
        #    to True, which rejects checkpoints with PyTorch Lightning /
        #    numpy.core.multiarray.scalar globals. Python script does PROPER
        #    paren matching (sed can't handle nested parens like
        #    torch.device("cpu") inside torch.load).
        "python /tmp/_patch_torch_load.py /Puppeteer",
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
    # Use hf_hub_download which handles auth + retries properly.
    # HF_TOKEN is required because Seed3D/Puppeteer is gated.
    .run_commands(
        # Skeleton + skinning + michelangelo VAE — all in one Python call.
        "python -c \""
        "from huggingface_hub import hf_hub_download; "
        "import os, shutil; "
        "tok = os.environ.get('HF_TOKEN'); "
        # Files live under skeleton_ckpts/ + skinning_ckpts/ in the HF repo.
        # hf_hub_download recreates that structure under local_dir, so we
        # download to /Puppeteer/skeleton and /Puppeteer/skinning roots.
        "hf_hub_download(repo_id='Seed3D/Puppeteer', "
        "filename='skeleton_ckpts/puppeteer_skeleton_w_diverse_pose.pth', "
        "local_dir='/Puppeteer/skeleton', token=tok); "
        "hf_hub_download(repo_id='Seed3D/Puppeteer', "
        "filename='skinning_ckpts/puppeteer_skin_w_diverse_pose_depth1.pth', "
        "local_dir='/Puppeteer/skinning', token=tok); "
        "hf_hub_download(repo_id='Maikou/Michelangelo', "
        "filename='checkpoints/aligned_shape_latents/shapevae-256.ckpt', "
        "local_dir='/Puppeteer/skeleton/third_partys/Michelangelo', token=tok); "
        "print('all checkpoints downloaded')"
        "\"",
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
        secrets=[
            modal.Secret.from_name("huggingface", required_keys=["HF_TOKEN"]),
        ],
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
        # Skip --save_render: pyrender needs EGL which crashes headless
        # on Linux container without display, killing subprocess with
        # FileNotFoundError before _pred.txt is written.
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


def _retexture_rigged_glb(
    source_glb_path: str,
    rigged_glb_path: str,
    out_glb_path: str,
) -> bool:
    """Re-attach the source GLB's PBR material + albedo texture onto the
    rigged GLB. The Puppeteer pipeline strips materials because it goes
    GLB → OBJ → … → FBX → GLB and OBJ doesn't carry textures.

    Strategy: load both GLBs in bpy, copy the source mesh's active material
    onto every mesh of the rigged GLB armature, then re-export. Keeps the
    armature + skin from the rigged GLB and the materials/textures from
    the source GLB.

    On success the rigged GLB has the original albedo/PBR back. On failure
    we keep the original untextured rigged GLB (returns False, caller
    leaves out_glb_path untouched)."""
    try:
        import bpy
    except Exception as exc:
        _log(f"retexture: bpy import failed: {exc}")
        return False
    try:
        # Single bpy session — DO NOT read_factory_settings between
        # imports. That invalidates StructRNA pointers of copied
        # materials and the next access raises 'StructRNA of type
        # Material has been removed'.
        bpy.ops.wm.read_factory_settings(use_empty=True)

        # 1. Import source GLB (textured).
        bpy.ops.import_scene.gltf(filepath=source_glb_path)
        src_objs = list(bpy.data.objects)
        # Find a material that actually carries an image texture.
        kept_mat = None
        for obj in src_objs:
            if obj.type != "MESH":
                continue
            for mat in obj.data.materials:
                if mat is None:
                    continue
                if _material_has_image(mat):
                    kept_mat = mat
                    break
            if kept_mat is not None:
                break
        if kept_mat is None:
            # Fallback: any material on a mesh
            for obj in src_objs:
                if obj.type != "MESH":
                    continue
                if obj.data.materials and obj.data.materials[0] is not None:
                    kept_mat = obj.data.materials[0]
                    break
        if kept_mat is None:
            _log("retexture: source GLB has no usable material; skipping")
            return False
        kept_mat.name = "FabMesh_RigTex"
        kept_mat.use_fake_user = True  # survive object deletion
        kept_mat_name = kept_mat.name

        # 2. Delete source objects so they don't end up in the export.
        # Materials in bpy.data.materials persist independently as long
        # as use_fake_user is set.
        bpy.ops.object.select_all(action="DESELECT")
        for obj in src_objs:
            try: obj.select_set(True)
            except Exception: pass
        try: bpy.ops.object.delete()
        except Exception as exc: _log(f"retexture: source cleanup warn: {exc}")

        # 3. Import the rigged GLB on top (same session).
        bpy.ops.import_scene.gltf(filepath=rigged_glb_path)

        # 4. Re-fetch the material by NAME (not by held reference — the
        # second import may have renamed/replaced datablocks).
        kept_mat = bpy.data.materials.get(kept_mat_name)
        if kept_mat is None:
            _log("retexture: kept material vanished after second import; skipping")
            return False

        # 5. Assign material to every rigged mesh.
        n_assigned = 0
        for obj in bpy.data.objects:
            if obj.type != "MESH":
                continue
            obj.data.materials.clear()
            obj.data.materials.append(kept_mat)
            n_assigned += 1
        if n_assigned == 0:
            _log("retexture: rigged GLB has no mesh; skipping")
            return False

        # 6. Re-export.
        bpy.ops.export_scene.gltf(
            filepath=out_glb_path,
            export_format="GLB",
            export_skins=True,
            export_animations=False,
        )
        ok = os.path.exists(out_glb_path) and os.path.getsize(out_glb_path) > 0
        if ok:
            _log(f"retexture: assigned '{kept_mat_name}' to {n_assigned} mesh(es)")
        return ok
    except Exception as exc:
        import traceback as _tb
        _log(f"retexture failed: {exc}\n{_tb.format_exc()[:800]}")
        return False


def _material_has_image(mat) -> bool:
    """True if `mat` has any image-texture node connected in its node
    tree. We use this to prefer the 'best' source material (one carrying
    an albedo image) over a default flat-color material."""
    try:
        if not mat or not getattr(mat, "use_nodes", False) or not mat.node_tree:
            return False
        for node in mat.node_tree.nodes:
            try:
                if node.type == "TEX_IMAGE" and getattr(node, "image", None):
                    return True
            except Exception:
                continue
    except Exception:
        pass
    return False


# ---------------------------------------------------------------------------
# Core function — synchronous version called by the simple web endpoint.
# Returns the rigged GLB bytes, raises on failure.
# ---------------------------------------------------------------------------
@app.function(
    image=image,
    gpu="A10G",
    timeout=600,
    volumes={"/rig_data": rig_output_volume},
    secrets=[
        modal.Secret.from_name(
            "huggingface", required_keys=["HF_TOKEN"],
        ),
    ],
)
def rig_mesh(glb_bytes: bytes, job_id: str | None = None) -> bytes:
    """Run the full Puppeteer pipeline on `glb_bytes` and return the
    rigged GLB bytes.

    When `job_id` is supplied, also persist the result (or error) to
    `/rig_data/<job_id>.glb` (or `<job_id>.err`) on the rig_output
    Volume so `rig_router.rig_status` can serve the result back to the
    Worker after `.spawn()` returns control immediately. When `job_id`
    is None (e.g. the legacy `rig_mesh_endpoint` curl test path), the
    Volume is left untouched.

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
        # ── Inner try/except wraps the whole pipeline so that, when
        # `job_id` is set, ANY failure persists a `.err` marker on the
        # rig_output Volume. Without this, async callers (rig_status)
        # would poll forever after a rig crash.
        try:
            out_bytes = _run_rig_pipeline(glb_bytes, tmp_dir, t_total)
        except Exception as e:
            if job_id:
                try:
                    err_path = f"/rig_data/{job_id}.err"
                    with open(err_path, "w") as f:
                        f.write(json.dumps({
                            "error": str(e),
                            "type": type(e).__name__,
                            "trace": traceback.format_exc(),
                        })[:8000])
                    rig_output_volume.commit()
                    print(
                        f"[rig_mesh] wrote {err_path}",
                        flush=True,
                    )
                except Exception as e2:
                    print(
                        f"[rig_mesh] WARN err-file write failed for "
                        f"{job_id}: {e2}",
                        flush=True,
                    )
            raise

        # Persist the rigged GLB to the Volume so async pollers can
        # fetch it via rig_status. Non-fatal on write error: the sync
        # endpoint still returns the bytes inline.
        if job_id:
            try:
                out_path = f"/rig_data/{job_id}.glb"
                with open(out_path, "wb") as f:
                    f.write(out_bytes)
                rig_output_volume.commit()
                print(
                    f"[rig_mesh] wrote {out_path} ({len(out_bytes)} bytes)",
                    flush=True,
                )
            except Exception as e:
                print(
                    f"[rig_mesh] WARN volume write failed for "
                    f"{job_id}: {e}",
                    flush=True,
                )

        return out_bytes
    finally:
        try:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        except Exception:
            pass


def _run_rig_pipeline(glb_bytes: bytes, tmp_dir: str, t_total: float) -> bytes:
    """The original sync pipeline body, extracted so `rig_mesh` can
    wrap it in async-aware error handling without losing the existing
    stage-by-stage logging structure. `tmp_dir` cleanup is the
    caller's responsibility (`rig_mesh`'s outer finally)."""
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
    _log(f"step 6 done in {time.time() - t0:.1f}s "
         f"(glb={os.path.getsize(out_glb)} bytes)")

    # Step 7 — re-attach the source GLB's materials/textures onto the
    # rigged GLB. The Puppeteer pipeline strips textures because OBJ
    # doesn't carry them and the FBX export doesn't bake them either.
    # This step is best-effort: on failure we keep the untextured rig
    # rather than crashing the whole job.
    _log("== Step 7: re-texture rigged GLB from source ==")
    t0 = time.time()
    src_glb_path = os.path.join(tmp_dir, "input.glb")
    final_glb = os.path.join(tmp_dir, "rigged_textured.glb")
    if os.path.isfile(src_glb_path):
        retex_ok = _retexture_rigged_glb(src_glb_path, out_glb, final_glb)
        if retex_ok:
            _log(f"step 7 done in {time.time() - t0:.1f}s "
                 f"(textured glb={os.path.getsize(final_glb)} bytes)")
            out_glb = final_glb
        else:
            _log("step 7 skipped (retexture failed) — keeping untextured rig")
    else:
        _log(f"step 7 skipped (no source GLB at {src_glb_path})")
    with open(out_glb, "rb") as f:
        out_bytes = f.read()

    _log(f"TOTAL dt={time.time() - t_total:.1f}s "
         f"out_bytes={len(out_bytes)}")
    return out_bytes


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

    # Return raw GLB bytes (model/gltf-binary) instead of base64 JSON.
    # Avoids 33% bloat + JSON parse cost on the Worker side AND avoids
    # Modal runtime SIGSEGV on large JSON payloads (53 MB+ rigged GLBs).
    from fastapi.responses import Response
    return Response(
        content=glb_bytes,
        media_type="model/gltf-binary",
        headers={"X-Rigged-Bytes": str(len(glb_bytes))},
    )


# ---------------------------------------------------------------------------
# Async spawn+poll router — mirrors `mesh_router` in modal_app/app.py.
#
# Cloudflare workers have a 100 s subrequest cap; a Puppeteer rig job
# takes ~120-150 s on A10G (and longer on cold start), so we CANNOT keep
# the HTTP request open from the Worker side. Instead:
#
#   POST /rig-start  → spawns rig_mesh() in the background, returns
#                       {"job_id": "...", "status": "queued"} in <2 s.
#   POST /rig-status → reads the rig_output Volume, returns
#                       {"ready": false}                  (still running),
#                       {"ready": false, "error": "..."} (failed), or
#                       {"ready": true, "glb_base64": "...", "bytes": N}.
#
# The Worker exposes /api/auto-rig (spawn) and /api/auto-rig-status (one
# poll tick); the browser does the actual polling loop every 5 s. This
# matches the existing mesh pipeline (mesh_router → mesh_start +
# mesh_status) verbatim.
# ---------------------------------------------------------------------------
@app.function(
    # Lightweight CPU container — no GPU for the router itself; the
    # GPU work happens inside rig_mesh's separate container via .spawn().
    image=image,
    timeout=120,
    volumes={"/rig_data": rig_output_volume},
    secrets=[
        modal.Secret.from_name(
            "myfabmesh-shared", required_keys=["SHARED_SECRET"],
        ),
    ],
)
@modal.asgi_app()
def rig_router():
    """ASGI router exposing /rig-start, /rig-status and /healthz.

    Designed to be called from a Cloudflare Worker which has a 100 s
    sub-request cap — each call returns in well under 1 s so the worker
    can hand control back to the browser, which polls /rig-status every
    5 s until the rigged GLB is ready (or an error file shows up).
    """
    from fastapi import FastAPI, HTTPException, Request

    api = FastAPI(title="myfabmesh-rig")

    async def _read_json(request: Request) -> dict:
        try:
            return await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="invalid JSON body")

    def _check_auth(payload: dict) -> None:
        expected = os.environ.get("SHARED_SECRET", "")
        provided = (payload or {}).get("_auth") or ""
        if not expected or provided != expected:
            raise HTTPException(status_code=401, detail="unauthorized")

    @api.get("/healthz")
    async def healthz():
        return {"ok": True, "fn": "rig_router"}

    @api.post("/rig-start")
    async def rig_start(request: Request):
        """Dual-purpose route:

        - op_type unset or 'rig' → async rig job. Downloads the source
          GLB on this CPU container (cheap), then `.spawn()`s rig_mesh
          on a GPU container, returns {job_id, status: 'queued'} in
          ~1-2 s. The browser then polls /rig-status.

        - op_type == 'cancel' → cancel a running spawn by job_id.

        Body for the normal spawn:
            {
              "_auth": "...",
              "mesh_url": "https://.../mesh.glb",
              "skeleton": "orc_m1"   // optional, ignored by rig_mesh today
            }
        Returns: {"job_id": "...", "status": "queued"}
        """
        payload = await _read_json(request)
        _check_auth(payload)

        op_type = (payload.get("op_type") or "rig").strip().lower()

        # ── Cancel a running spawn ─────────────────────────────────
        if op_type == "cancel":
            job_id = (payload.get("job_id") or "").strip()
            if not job_id:
                raise HTTPException(
                    status_code=400,
                    detail="job_id required for cancel",
                )
            call_id_path = f"/rig_data/{job_id}.call_id"
            try:
                with open(call_id_path) as f:
                    call_id = f.read().strip()
            except FileNotFoundError:
                return {
                    "ok": True, "cancelled": False,
                    "reason": "no call_id on file",
                }
            try:
                modal.FunctionCall.from_id(call_id).cancel(
                    terminate_containers=True,
                )
                return {"ok": True, "cancelled": True, "call_id": call_id}
            except Exception as e:
                # Already finished / already cancelled / transient —
                # don't fail hard so the UI can still mark canceled.
                return {"ok": True, "cancelled": False, "error": str(e)}

        # ── Normal rig spawn ─────────────────────────────────────
        mesh_url = (payload.get("mesh_url") or "").strip()
        if not mesh_url:
            raise HTTPException(status_code=400, detail="mesh_url required")

        # Download the GLB here (cheap CPU container) rather than inside
        # rig_mesh on the GPU container — saves ~60 s of A10G time per
        # job when the source URL is slow.
        try:
            req = urllib.request.Request(
                mesh_url,
                headers={"User-Agent": "myfabmesh-rig/1.0"},
            )
            with urllib.request.urlopen(req, timeout=60) as resp:
                in_bytes = resp.read()
        except Exception as e:
            raise HTTPException(
                status_code=502, detail=f"mesh fetch failed: {e}",
            )

        if not in_bytes or in_bytes[:4] != b"glTF":
            raise HTTPException(
                status_code=400,
                detail="mesh_url did not return a GLB",
            )

        job_id = (payload.get("job_id") or "").strip() or uuid.uuid4().hex

        # `.spawn()` returns a FunctionCall; persist its object_id so a
        # subsequent op_type='cancel' call can find and terminate it.
        call = rig_mesh.spawn(in_bytes, job_id=job_id)
        try:
            with open(f"/rig_data/{job_id}.call_id", "w") as f:
                f.write(call.object_id)
            rig_output_volume.commit()
        except Exception as e:
            print(
                f"[rig-start] WARN could not persist call_id for "
                f"{job_id}: {e}",
                flush=True,
            )

        return {"job_id": job_id, "status": "queued"}

    @api.post("/rig-status")
    async def rig_status(request: Request):
        """One poll tick. Three response shapes:
        - JSON {"ready": false} : rig still running
        - JSON {"ready": false, "error": "..."} : .err sentinel found
        - JSON {"ready": true, "fetch_path": "/rig-fetch?job_id=…", "bytes": N}
          : rigged GLB landed; client should call /rig-fetch to STREAM the
          bytes. We no longer return glb_base64 inline — a 63 MB GLB
          base64-encoded blew CF Worker memory (128 MB hard cap) when the
          Worker tried to atob() the response, producing sustained 503s.
        """
        from fastapi.responses import JSONResponse
        payload = await _read_json(request)
        _check_auth(payload)
        job_id = (payload.get("job_id") or "").strip()
        if not job_id:
            raise HTTPException(status_code=400, detail="job_id required")

        # Reload so we see the GPU worker's latest commits — the rig_mesh
        # function runs in a SEPARATE container and the Volume is the
        # only synchronisation point.
        rig_output_volume.reload()
        out_path = f"/rig_data/{job_id}.glb"
        err_path = f"/rig_data/{job_id}.err"

        if os.path.isfile(err_path):
            with open(err_path) as f:
                raw = f.read()
            err_msg = raw
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict) and parsed.get("error"):
                    err_msg = str(parsed["error"])
            except Exception:
                pass
            return JSONResponse({"ready": False, "error": err_msg[:500]})

        if os.path.isfile(out_path):
            sz = os.path.getsize(out_path)
            return JSONResponse({
                "ready": True,
                "bytes": sz,
                "fetch_endpoint": "/rig-fetch",
            })

        return JSONResponse({"ready": False})

    @api.post("/rig-fetch")
    async def rig_fetch(request: Request):
        """Stream the rigged GLB bytes for the given job_id. Replaces the
        base64-in-JSON path from rig_status — the Worker consumes this
        response.body as a ReadableStream and pipes it directly into
        env.MESHES.put(key, stream), never materialising 63 MB in memory.

        Body: {"_auth": "...", "job_id": "..."}
        Response: raw GLB bytes (Content-Type: model/gltf-binary) on
        success, 404 if the GLB hasn't landed yet (caller should keep
        polling /rig-status), 410 if a .err sentinel exists (caller
        should treat as terminal failure).
        """
        from fastapi.responses import FileResponse
        payload = await _read_json(request)
        _check_auth(payload)
        job_id = (payload.get("job_id") or "").strip()
        if not job_id:
            raise HTTPException(status_code=400, detail="job_id required")
        # Defensive: refuse path-traversal job_ids before we open(<volume>/…).
        if "/" in job_id or ".." in job_id or not all(c in "0123456789abcdef" for c in job_id.lower()):
            raise HTTPException(status_code=400, detail="job_id must be hex")
        rig_output_volume.reload()
        out_path = f"/rig_data/{job_id}.glb"
        err_path = f"/rig_data/{job_id}.err"
        if os.path.isfile(err_path):
            raise HTTPException(status_code=410, detail="rig failed — see /rig-status for error message")
        if not os.path.isfile(out_path):
            raise HTTPException(status_code=404, detail="rig not ready yet")
        # FileResponse streams the file in chunks rather than buffering
        # the full 63 MB into memory — works both on Modal (container
        # memory) and on the Worker side (it just proxies the stream).
        return FileResponse(
            out_path,
            media_type="model/gltf-binary",
            filename=f"{job_id}.glb",
        )

    return api
