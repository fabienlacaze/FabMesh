"""Puppeteer animation — cloud version (Modal).

Companion to `_puppeteer_rig.py`. Where the rig app turns an unrigged GLB
into a rigged FBX/GLB (skeleton + skin weights baked), THIS app takes the
rigged result + a driving reference video (mp4) and runs Puppeteer's
animation/optimization.py to bake a motion sequence onto the rig — using
video-depth-anything + cotracker3 + optical flow as supervision signals.

Why a SEPARATE app (and not just an extra function in _puppeteer_rig.py):
- The animation pipeline needs additional heavy deps that the rig image
  does NOT carry: `ffmpeg` (system apt package — NOT installed in rig),
  `libigl` (Python bindings — used by visibility computation), `ptlflow`
  (DPFlow / optical-flow runner), `imageio[ffmpeg]`, plus TWO HuggingFace
  checkpoints totalling ~1.65 GB (Video-Depth-Anything-Large vitl +
  CoTracker3 scaled_offline).
- Adding all of that to _puppeteer_rig.py would bloat the rig image's
  cold-start by 1.65 GB of checkpoint pulls + an ffmpeg apt layer + 3
  pip layers for deps the rig doesn't use. Worse, ANY rebuild of the
  animation deps would invalidate the rig image's cached layers and
  force a 25-40 min rebuild for a pipeline that doesn't need them.
- Keeping them split means: rig runs on its own cold container (small),
  animation runs on its own (larger but optional), and the desktop /
  cloud worker can choose whether to call the animation tier per job.

PIPELINE (mirror of animation/demo.sh):
  Stage 0. Decode `glb_bytes` + `video_bytes`, stage into `inputs/<seq>/`:
           - objs/mesh.obj          (from rigged GLB → bpy export to OBJ)
           - objs/rig.txt           (from rigged GLB → reconstruct RigNet
                                     format from armature + weights)
           - objs/texture.png       (albedo texture from GLB material)
           - input.mp4              (the driving video)
  Stage 1. ffmpeg -i input.mp4 -vf fps=10 imgs/frame_%04d.png
  Stage 2. utils/save_flow.py → flow/*.flo + flow_vis/*.png
  Stage 3. optimization.py → results/<seq>/<save_name>/{raw,smoothed}/*.pt
           + per-view rendered mp4s + concat_output.mp4
  Stage 4. Package output (raw .pt motions + concat mp4) into a tar.gz
           and return its bytes. The rigged GLB is NOT re-emitted with
           baked animation — that requires a separate bpy/gltf-anim
           pass (TODO Track B). For the FIRST test we just confirm the
           pipeline runs end-to-end and return the artefact bundle.

VRAM: PyTorch3D differentiable rendering at 960px + CoTracker3 + DPFlow
+ Video-Depth-Anything-Large concurrently uses ~18-20 GB on A10G (24
GB). Expected runtime: ~15-25 min for 200 iters @ 960px on A10G.

DEPLOY:
    modal token new
    modal secret create huggingface HF_TOKEN=<your hf token>
    modal deploy modal_app/_puppeteer_animate.py

The first deploy reuses the rig app's image base layers up to the
Puppeteer clone (same git URL + tag + --recursive), then layers on
ffmpeg / libigl / ptlflow / two HF checkpoints. Build time ~30-45 min
end-to-end on cold cache.

License: Puppeteer animation tree is Apache-2.0 (Seed3D Bytedance).
Video-Depth-Anything is Apache-2.0. CoTracker3 is CC-BY-NC-4.0
(NON-COMMERCIAL only — gating this off behind a license check before
production use; see docs/anytop_license_audit_2026-06-05.md for the
broader audit pattern). For research/test use the redistribution
inside our Modal image is allowed; for commercial release we will need
a replacement tracker (TODO Track B).
"""
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import traceback

import modal

# ---------------------------------------------------------------------------
# Image: starts from the SAME base as _puppeteer_rig.py (torch 2.7.0+cu128,
# flash-attn 2.7.4.post1, pytorch3d 0.7.6, bpy 4.2 cp311, Puppeteer source
# tree cloned with --recursive so animation/ + its submodules co_tracker /
# Video_Depth_Anything / ptlflow are present as source).
#
# On TOP of that base we add:
#   - apt: ffmpeg (animation pipeline uses subprocess.call('ffmpeg …'))
#   - pip: libigl, ptlflow, imageio[ffmpeg], imageio-ffmpeg, matplotlib
#   - HF checkpoints: Video-Depth-Anything-Large + CoTracker3 scaled_offline
#
# We DO NOT duplicate the rig image inline — instead we clone Puppeteer
# afresh here (cheap: <1 min in cache) so this app is self-contained and
# doesn't risk breakage if _puppeteer_rig.py's image cache is invalidated.
# ---------------------------------------------------------------------------
image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.8.1-devel-ubuntu22.04",
        add_python="3.11",
    )
    .env({"CUDA_HOME": "/usr/local/cuda"})
    .apt_install(
        # Same toolchain as rig image (clang for pytorch3d linker, ninja
        # for flash-attn, GL libs for bpy headless, wget for HF LFS).
        "clang",
        "git", "build-essential", "ninja-build",
        "libgl1", "libegl1",
        "libglib2.0-0", "libsm6", "libxext6", "libxrender1",
        "libxi6", "libxxf86vm1", "libxfixes3", "libxkbcommon0",
        "wget", "ca-certificates",
        # NEW for animation: ffmpeg is REQUIRED by demo.sh
        # (frame extraction + per-view video render + final concat).
        # apt-get's ffmpeg pulls libavcodec/libavformat/libswscale —
        # the imageio-ffmpeg wheel can't replace it because the
        # pipeline calls `ffmpeg` as a binary via subprocess.
        "ffmpeg",
    )
    .pip_install(
        "torch==2.7.0",
        "torchvision==0.22.0",
        "torchaudio==2.7.0",
        extra_options="--index-url https://download.pytorch.org/whl/cu128",
    )
    .pip_install(
        "packaging", "setuptools", "wheel", "ninja",
    )
    .pip_install(
        "flash-attn==2.7.4.post1",
        extra_options="--no-build-isolation",
    )
    .pip_install(
        "torch-scatter==2.1.2",
        extra_options=(
            "-f https://data.pyg.org/whl/torch-2.7.0+cu128.html"
        ),
    )
    .pip_install("fvcore", "iopath")
    .run_commands(
        "FORCE_CUDA=1 TORCH_CUDA_ARCH_LIST='8.0;8.9;9.0+PTX' "
        "pip install --no-build-isolation "
        "'git+https://github.com/facebookresearch/pytorch3d.git@v0.7.6'",
    )
    # bpy 4.2 cp311 Linux wheel (same as rig image; we use it to extract
    # mesh.obj + rig.txt + texture.png out of the rigged GLB at runtime).
    .run_commands(
        "wget -q -P /tmp "
        "https://files.pythonhosted.org/packages/0b/bc/5245f98dafa39166a4d4701d64077d281a36110e780011de5c38135089aa/"
        "bpy-4.2.0-cp311-cp311-manylinux_2_28_x86_64.whl",
        "pip install /tmp/bpy-4.2.0-cp311-cp311-manylinux_2_28_x86_64.whl",
        "rm /tmp/bpy-4.2.0-cp311-cp311-manylinux_2_28_x86_64.whl",
    )
    # Core deps (subset of rig image — animation doesn't need tetgen,
    # mesh2sdf, transformers, lightning, etc, but DOES need the geom /
    # render / hf stack).
    .pip_install(
        "trimesh>=4.0",
        "numpy<2",
        "pyrender",
        "h5py", "plyfile", "timm", "loguru",
        "psutil",
        "scipy",
        "scikit-image",
        "scikit-learn",
        "boto3", "einops", "opencv-python", "omegaconf",
        "huggingface_hub>=0.34",
        "pillow>=10",
        "tqdm",
        "fastapi[standard]>=0.115",
        # ---- NEW for animation ----
        # libigl Python bindings — used by visibility computation in
        # save_track_points and by the model.py rest-pose helpers.
        # PINNED to 2.5.1 (Puppeteer's requirements.txt) — newer 2.6+
        # changed ray_mesh_intersect signature (dtype/writable strict),
        # breaking compute_visibility_mask_igl.
        "libigl==2.5.1",
        # easydict — used by utils/loss_utils.py for config object access.
        "easydict",
        # ptlflow — DPFlow / RAFT-style optical-flow runner used by
        # utils/save_flow.py. Pulls torch-lightning + matplotlib.
        "ptlflow",
        # imageio[ffmpeg] + imageio-ffmpeg — frame I/O for the depth
        # / track pipelines. The system ffmpeg covers the subprocess
        # calls; imageio-ffmpeg covers programmatic frame writes.
        "imageio[ffmpeg]",
        "imageio-ffmpeg",
        # matplotlib — save_utils + flow_vis + tracking visualisations
        # import pyplot for debug overlays.
        "matplotlib",
    )
    .env({
        "CC": "gcc", "CXX": "g++",
        "CUDA_HOME": "/usr/local/cuda",
        "TORCH_CUDA_ARCH_LIST": "8.0;8.9;9.0+PTX",
        "FORCE_CUDA": "1",
        "HF_HOME": "/root/.cache/huggingface",
    })
    # ---- Puppeteer source tree (same clone as rig image; --recursive
    # pulls animation/third_partys/{co_tracker,Video_Depth_Anything,ptlflow}
    # as submodules — those are the "code" side. We then download the
    # WEIGHTS into the dedicated ckpt/ subfolders below.) ----
    .run_commands(
        "git clone --depth 1 --recursive "
        "https://github.com/Seed3D/Puppeteer.git /Puppeteer",
        # FabMesh fix: upstream Puppeteer's third_partys/ is missing
        # __init__.py files needed for `from third_partys.ptlflow...` imports
        # in animation/utils/save_flow.py. Create empty inits.
        "touch /Puppeteer/animation/third_partys/__init__.py",
        "touch /Puppeteer/animation/third_partys/ptlflow/__init__.py",
        "touch /Puppeteer/animation/third_partys/co_tracker/__init__.py",
        "touch /Puppeteer/animation/third_partys/Video_Depth_Anything/__init__.py",
    )
    # ---- HuggingFace animation checkpoints ----
    # Video-Depth-Anything-Large (1.54 GB) + CoTracker3 scaled_offline
    # (~102 MB). These match animation/download.py verbatim — same repos
    # + filenames + target dirs, so the optimization.py code paths find
    # them at the exact paths their loaders hardcode.
    .run_commands(
        "python -c \""
        "from huggingface_hub import hf_hub_download; "
        "import os; "
        "tok = os.environ.get('HF_TOKEN'); "
        "hf_hub_download("
        "repo_id='depth-anything/Video-Depth-Anything-Large', "
        "filename='video_depth_anything_vitl.pth', "
        "local_dir='/Puppeteer/animation/third_partys/Video_Depth_Anything/ckpt', "
        "token=tok); "
        "hf_hub_download("
        "repo_id='facebook/cotracker3', "
        "filename='scaled_offline.pth', "
        "local_dir='/Puppeteer/animation/third_partys/co_tracker/ckpt', "
        "token=tok); "
        "print('all animation checkpoints downloaded')"
        "\"",
        # Build-time guard — fail the image build if any of these went
        # sideways instead of crash-looping at runtime.
        "python -c \"import os; "
        "files = ["
        "'/Puppeteer/animation/third_partys/Video_Depth_Anything/ckpt/"
        "video_depth_anything_vitl.pth', "
        "'/Puppeteer/animation/third_partys/co_tracker/ckpt/"
        "scaled_offline.pth']; "
        "missing = [(f, os.path.getsize(f) if os.path.isfile(f) else -1) "
        "for f in files if not os.path.isfile(f) "
        "or os.path.getsize(f) < 1024*1024]; "
        "assert not missing, f'ckpt missing/too small: {missing}'; "
        "print('animation checkpoints OK', "
        "[(f, os.path.getsize(f)) for f in files])\"",
        # Sanity: imports + GPU stack.
        "python -c \"import torch, pytorch3d, igl, ptlflow, imageio; "
        "print('torch', torch.__version__, "
        "'pytorch3d', pytorch3d.__version__, "
        "'igl OK', 'ptlflow', ptlflow.__version__, "
        "'imageio', imageio.__version__)\"",
        secrets=[
            modal.Secret.from_name("huggingface", required_keys=["HF_TOKEN"]),
        ],
    )
)

app = modal.App("myfabmesh-animate", image=image)

# Volume for async jobs (same pattern as rig_output_volume in
# _puppeteer_rig.py). For now we only use it from the synchronous
# function + local_entrypoint test path, but reserving it keeps the
# door open for the spawn/poll router we'll add later for the worker.
anim_output_volume = modal.Volume.from_name(
    "myfabmesh-animate-output", create_if_missing=True,
)

# ---------------------------------------------------------------------------
# Paths inside the container.
# ---------------------------------------------------------------------------
PUP_DIR = "/Puppeteer"
ANIM_DIR = f"{PUP_DIR}/animation"


def _log(msg: str) -> None:
    print(f"[animate] {msg}", flush=True)


def _stream(proc: subprocess.Popen) -> int:
    """Stream subprocess stdout line-by-line so progress shows up in
    `modal app logs` in real time (matches _puppeteer_rig._stream)."""
    if proc.stdout is None:
        return proc.wait()
    for line in proc.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
    return proc.wait()


def _glb_to_obj_and_rig(glb_path: str, objs_dir: str) -> None:
    """Extract `mesh.obj` + `rig.txt` + optional `texture.png` out of a
    rigged GLB so the Puppeteer animation pipeline can consume them.

    Strategy:
      1. Open the GLB in bpy headless.
      2. For each mesh: write OBJ with the embedded armature's bone
         names as vertex groups (skin weights → per-vertex map).
      3. Walk the armature's bones to emit a RigNet-format rig.txt:
            joints <name> <x> <y> <z>
            root <root_name>
            hier <parent> <child>
            skin <vertex_idx> <name> <weight> <name> <weight> ...
      4. If the mesh has an active material with an image texture node,
         save it as `texture.png` + emit a minimal `mesh.mtl` referencing
         it (pytorch3d.io.load_obj uses .mtl for texture atlas).

    This is the INVERSE of _puppeteer_rig.py::_run_export — that step
    builds an FBX from {OBJ + rig.txt}, we now go BACK to {OBJ + rig.txt}
    so animation can run. It's NOT lossless (Puppeteer's export.py
    bakes weights with a 0.05 threshold + 4-influence cap, so the
    extracted rig.txt is a faithful copy of what's in the FBX, not the
    original skinning_ckpt output)."""
    import bpy  # noqa: F401 — imported for side-effect inside bpy ops
    import numpy as np
    os.makedirs(objs_dir, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=glb_path)

    # Find the armature + first mesh child.
    armature = None
    mesh_obj = None
    for obj in bpy.data.objects:
        if obj.type == "ARMATURE" and armature is None:
            armature = obj
        elif obj.type == "MESH" and mesh_obj is None:
            mesh_obj = obj
    if mesh_obj is None:
        raise RuntimeError("rigged GLB has no MESH object — cannot animate")
    if armature is None:
        raise RuntimeError(
            "rigged GLB has no ARMATURE — animation needs a skinned rig"
        )

    # ---- 1. Export OBJ + MTL ----
    out_obj = os.path.join(objs_dir, "mesh.obj")
    # Deselect everything, then select only the mesh for export.
    bpy.ops.object.select_all(action="DESELECT")
    mesh_obj.select_set(True)
    bpy.context.view_layer.objects.active = mesh_obj
    bpy.ops.wm.obj_export(
        filepath=out_obj,
        export_selected_objects=True,
        export_materials=True,
        export_uv=True,
        export_normals=True,
        forward_axis="NEGATIVE_Z",
        up_axis="Y",
    )
    _log(f"wrote mesh.obj ({os.path.getsize(out_obj)} bytes)")

    # ---- 2. Extract texture(s) if any ----
    # Walk node tree of the first material; save the first image texture
    # as texture.png. Animation's data_loader uses pytorch3d's atlas
    # builder which reads the .mtl referenced by the OBJ.
    if mesh_obj.data.materials:
        for mat in mesh_obj.data.materials:
            if mat is None or not mat.use_nodes or not mat.node_tree:
                continue
            for node in mat.node_tree.nodes:
                if node.type == "TEX_IMAGE" and node.image is not None:
                    tex_out = os.path.join(objs_dir, "texture.png")
                    try:
                        node.image.save_render(tex_out)
                        _log(
                            f"wrote texture.png "
                            f"({os.path.getsize(tex_out)} bytes)"
                        )
                    except Exception as exc:
                        _log(f"texture save failed: {exc}")
                    break
            if os.path.isfile(os.path.join(objs_dir, "texture.png")):
                break

    # ---- 3. Emit rig.txt (RigNet format) ----
    # Bones: use HEAD position in WORLD space (armature.matrix_world @ bone.head_local)
    # so coords match the OBJ verts.
    rig_txt = os.path.join(objs_dir, "rig.txt")
    arm_mw = armature.matrix_world.copy()
    # Bone name → 0-based index. RigNet's read_rig_file builds the same
    # mapping by appearance order, so we preserve insertion order here.
    bone_names = [b.name for b in armature.data.bones]
    name_to_idx = {n: i for i, n in enumerate(bone_names)}

    # Identify the root bone (the one with no parent).
    root_bone = None
    for b in armature.data.bones:
        if b.parent is None:
            root_bone = b.name
            break
    if root_bone is None:
        raise RuntimeError("armature has no root bone")

    # Per-vertex skin weights: walk mesh vertex groups; only keep groups
    # whose name matches a bone. Cap at 4 influences + drop weights < 0.01
    # to keep the rig.txt size manageable (the RigNet loader doesn't cap,
    # but optim runtime scales with influences).
    vgroup_names = [g.name for g in mesh_obj.vertex_groups]
    bone_vgroups = [
        (i, n) for i, n in enumerate(vgroup_names) if n in name_to_idx
    ]
    n_verts = len(mesh_obj.data.vertices)

    skin_rows = []
    for vi in range(n_verts):
        v = mesh_obj.data.vertices[vi]
        # bpy's vertex.groups is a sequence of (group_index, weight).
        infl = []
        for g in v.groups:
            gi = g.group
            w = g.weight
            if w < 1e-3:
                continue
            # Translate vertex-group index → bone name (if it maps).
            if 0 <= gi < len(vgroup_names):
                gn = vgroup_names[gi]
                if gn in name_to_idx:
                    infl.append((gn, w))
        infl.sort(key=lambda x: -x[1])
        infl = infl[:4]
        if not infl:
            # Unskinned vertex — pin to root with weight 1 so the
            # animation loader doesn't NaN out.
            infl = [(root_bone, 1.0)]
        # Renormalize so weights sum to 1 (RigNet loader expects this).
        s = sum(w for _, w in infl)
        if s > 0:
            infl = [(n, w / s) for n, w in infl]
        parts = []
        for n, w in infl:
            parts.append(f"{n} {w:.6f}")
        skin_rows.append(f"skin {vi} " + " ".join(parts))

    with open(rig_txt, "w", encoding="utf-8") as f:
        # joints
        for b in armature.data.bones:
            head_w = arm_mw @ b.head_local
            f.write(
                f"joints {b.name} "
                f"{head_w.x:.6f} {head_w.y:.6f} {head_w.z:.6f}\n"
            )
        # root
        f.write(f"root {root_bone}\n")
        # hier
        for b in armature.data.bones:
            if b.parent is not None:
                f.write(f"hier {b.parent.name} {b.name}\n")
        # skin
        for row in skin_rows:
            f.write(row + "\n")

    _log(
        f"wrote rig.txt: {len(bone_names)} joints, "
        f"{n_verts} skin rows ({os.path.getsize(rig_txt)} bytes)"
    )


def _run_save_flow(input_path: str, seq_name: str) -> int:
    """Stage 2 — utils/save_flow.py (DPFlow / RAFT optical flow)."""
    cmd = [
        sys.executable, f"{ANIM_DIR}/utils/save_flow.py",
        "--input_path", input_path,
        "--seq_name", seq_name,
    ]
    _log(f"save_flow: {' '.join(cmd)}")
    # FabMesh fix (2026-06-08): save_flow.py imports `from third_partys.ptlflow...`
    # which only resolves if the parent of `third_partys` is on PYTHONPATH.
    # Python only auto-adds the script's directory (utils/) to sys.path, so
    # we must inject ANIM_DIR (the parent of utils/) explicitly.
    env = os.environ.copy()
    env["PYTHONPATH"] = ANIM_DIR + os.pathsep + env.get("PYTHONPATH", "")
    proc = subprocess.Popen(
        cmd, cwd=ANIM_DIR, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
    )
    return _stream(proc)


def _run_optimization(
    input_path: str,
    save_path: str,
    seq_name: str,
    save_name: str,
    iters: int,
    img_size: int,
    smooth_weight: float,
    coherence_weight: float,
    main_renderer: str,
    additional_renderers: str,
) -> int:
    """Stage 3 — animation/optimization.py (the big 200-iter @ 960px
    differentiable-render fit)."""
    cmd = [
        sys.executable, f"{ANIM_DIR}/optimization.py",
        "--input_path", input_path,
        "--save_path", save_path,
        "--seq_name", seq_name,
        "--save_name", save_name,
        "--iter", str(iters),
        "--img_size", str(img_size),
        "--smooth_weight", str(smooth_weight),
        "--coherence_weight", str(coherence_weight),
        "--main_renderer", main_renderer,
        "--additional_renderers", additional_renderers,
    ]
    _log(f"optimization: {' '.join(cmd)}")
    # Same PYTHONPATH fix as save_flow
    env = os.environ.copy()
    env["PYTHONPATH"] = ANIM_DIR + os.pathsep + env.get("PYTHONPATH", "")
    proc = subprocess.Popen(
        cmd, cwd=ANIM_DIR, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
    )
    return _stream(proc)


def _package_results(
    results_root: str,
    seq_name: str,
    save_name: str,
    out_path: str,
) -> None:
    """Bundle the optimization output into a tar.gz that the caller can
    unpack locally. We include:
      - raw/local_quats.pt, raw/root_quats.pt, raw/root_pos.pt
        (everything needed to retarget the motion onto the GLB rig)
      - raw/<view>_output_video.mp4 (the rendered animation per camera)
      - concat_output.mp4 (gt vs ours side-by-side, if it was made)
      - config.json (the args of the optimization run, for reproducibility)
    """
    seq_dir = os.path.join(results_root, seq_name, save_name)
    if not os.path.isdir(seq_dir):
        raise RuntimeError(
            f"optimization produced no results dir at {seq_dir}"
        )
    with tarfile.open(out_path, "w:gz") as tar:
        for root, _dirs, files in os.walk(seq_dir):
            for fn in files:
                # Skip enormous debug dumps / intermediate flow caches
                # if any landed here by accident (they should be under
                # inputs/, not results/, but be safe).
                if fn.endswith(".flo"):
                    continue
                full = os.path.join(root, fn)
                arc = os.path.relpath(full, seq_dir)
                tar.add(full, arcname=arc)


# ---------------------------------------------------------------------------
# Core function — synchronous, returns the tar.gz bytes of the animation
# artefacts. Caller (local_entrypoint or future router) decodes + unpacks.
# ---------------------------------------------------------------------------
@app.function(
    image=image,
    gpu="A10G",            # 24 GB matches the brief's minimum_gpu_vram_gb
    timeout=3600,          # 60 min — animation runs ~15-25 min, leave room
                           # for cold start + frame extraction overhead
    volumes={"/anim_data": anim_output_volume},
    secrets=[
        modal.Secret.from_name("huggingface", required_keys=["HF_TOKEN"]),
    ],
)
def animate(
    glb_bytes: bytes,
    video_bytes: bytes,
    seq_name: str = "fabmesh",
    save_name: str = "run0",
    iters: int = 200,
    img_size: int = 960,
    fps: int = 10,
    smooth_weight: float = 1.0,
    coherence_weight: float = 5.0,
    main_renderer: str = "front",
    additional_renderers: str = "front_left,front_right,back_right",
    job_id: str | None = None,
) -> bytes:
    """Run the full Puppeteer animation pipeline.

    Args:
      glb_bytes:    rigged GLB (output of _puppeteer_rig.py / rig_mesh).
      video_bytes:  driving reference video (mp4).
      seq_name:     subdir name under inputs/ + results/ (cosmetic).
      save_name:    subdir name under results/<seq>/ (cosmetic).
      iters:        optimization iters (200 matches demo.sh; lower = faster).
      img_size:     differentiable render resolution (960 matches demo.sh).
      fps:          frame extraction rate (10 matches README).
      smooth_weight: temporal joint-quaternion smoothness regulariser.
      coherence_weight: joint-motion coherence regulariser (demo.sh: 5 for
                    fish, 15 for crocodile — depends on the motion type).
      main_renderer / additional_renderers: camera views used for the
                    multi-view RGB/flow/depth supervision.
      job_id:       if set, also persist tar.gz to /anim_data/<job_id>.tgz
                    (or .err on failure) on the anim_output Volume so an
                    async poller can fetch it later. Matches the rig
                    pipeline's async pattern.

    Returns: bytes of a tar.gz containing the raw motion .pt files +
    rendered per-view mp4 + concat_output.mp4 + config.json.

    Raises on any stage failure (and writes a .err sentinel if job_id
    is set, mirroring _puppeteer_rig.rig_mesh)."""
    t_total = time.time()
    tmp_dir = tempfile.mkdtemp(prefix="puppeteer_anim_")
    try:
        try:
            out_bytes = _run_animate_pipeline(
                glb_bytes=glb_bytes,
                video_bytes=video_bytes,
                tmp_dir=tmp_dir,
                seq_name=seq_name,
                save_name=save_name,
                iters=iters,
                img_size=img_size,
                fps=fps,
                smooth_weight=smooth_weight,
                coherence_weight=coherence_weight,
                main_renderer=main_renderer,
                additional_renderers=additional_renderers,
                t_total=t_total,
            )
        except Exception as e:
            if job_id:
                try:
                    err_path = f"/anim_data/{job_id}.err"
                    with open(err_path, "w") as f:
                        f.write(json.dumps({
                            "error": str(e),
                            "type": type(e).__name__,
                            "trace": traceback.format_exc(),
                        })[:8000])
                    anim_output_volume.commit()
                    _log(f"wrote {err_path}")
                except Exception as e2:
                    _log(f"WARN err-file write failed for {job_id}: {e2}")
            raise

        if job_id:
            try:
                out_path = f"/anim_data/{job_id}.tgz"
                with open(out_path, "wb") as f:
                    f.write(out_bytes)
                anim_output_volume.commit()
                _log(f"wrote {out_path} ({len(out_bytes)} bytes)")
            except Exception as e:
                _log(f"WARN volume write failed for {job_id}: {e}")

        return out_bytes
    finally:
        try:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        except Exception:
            pass


def _run_animate_pipeline(
    glb_bytes: bytes,
    video_bytes: bytes,
    tmp_dir: str,
    seq_name: str,
    save_name: str,
    iters: int,
    img_size: int,
    fps: int,
    smooth_weight: float,
    coherence_weight: float,
    main_renderer: str,
    additional_renderers: str,
    t_total: float,
) -> bytes:
    """Pipeline body — extracted from `animate` so error handling +
    Volume persistence can wrap it cleanly (mirror of the rig file's
    `_run_rig_pipeline`).

    The pipeline writes its inputs into `<tmp_dir>/inputs/<seq>/…` and
    results into `<tmp_dir>/results/<seq>/<save_name>/…` so multiple
    concurrent jobs on the same container don't collide on the
    Puppeteer source-tree's `inputs/` + `results/` defaults."""
    inputs_root = os.path.join(tmp_dir, "inputs")
    results_root = os.path.join(tmp_dir, "results")
    seq_in = os.path.join(inputs_root, seq_name)
    objs_dir = os.path.join(seq_in, "objs")
    imgs_dir = os.path.join(seq_in, "imgs")
    os.makedirs(seq_in, exist_ok=True)
    os.makedirs(imgs_dir, exist_ok=True)

    # Stage 0 — decode inputs.
    _log("== Stage 0: decode inputs ==")
    t0 = time.time()
    glb_path = os.path.join(tmp_dir, "input.glb")
    with open(glb_path, "wb") as f:
        f.write(glb_bytes)
    video_path = os.path.join(seq_in, "input.mp4")
    with open(video_path, "wb") as f:
        f.write(video_bytes)
    _log(
        f"staged input.glb ({len(glb_bytes)} bytes) + "
        f"input.mp4 ({len(video_bytes)} bytes) in {time.time() - t0:.1f}s"
    )

    # Stage 0b — GLB → OBJ + rig.txt + texture.
    _log("== Stage 0b: GLB → OBJ + rig.txt ==")
    t0 = time.time()
    _glb_to_obj_and_rig(glb_path, objs_dir)
    _log(f"GLB → OBJ + rig.txt done in {time.time() - t0:.1f}s")

    # Stage 1 — ffmpeg frame extraction.
    _log("== Stage 1: ffmpeg frame extraction @ %d fps ==" % fps)
    t0 = time.time()
    cmd = [
        "ffmpeg", "-y", "-i", video_path,
        "-vf", f"fps={fps}",
        os.path.join(imgs_dir, "frame_%04d.png"),
    ]
    rc = subprocess.call(cmd)
    if rc != 0:
        raise RuntimeError(f"ffmpeg frame extraction failed rc={rc}")
    n_frames = len([f for f in os.listdir(imgs_dir) if f.endswith(".png")])
    _log(f"extracted {n_frames} frames in {time.time() - t0:.1f}s")
    if n_frames < 2:
        raise RuntimeError(
            f"too few frames extracted ({n_frames}); need a longer video"
        )

    # Stage 2 — optical flow.
    _log("== Stage 2: save_flow.py ==")
    t0 = time.time()
    rc = _run_save_flow(inputs_root, seq_name)
    if rc != 0:
        raise RuntimeError(f"save_flow.py failed rc={rc}")
    _log(f"save_flow done in {time.time() - t0:.1f}s")

    # Stage 3 — optimization.
    _log("== Stage 3: optimization.py ==")
    t0 = time.time()
    rc = _run_optimization(
        input_path=inputs_root,
        save_path=results_root,
        seq_name=seq_name,
        save_name=save_name,
        iters=iters,
        img_size=img_size,
        smooth_weight=smooth_weight,
        coherence_weight=coherence_weight,
        main_renderer=main_renderer,
        additional_renderers=additional_renderers,
    )
    if rc != 0:
        raise RuntimeError(f"optimization.py failed rc={rc}")
    _log(f"optimization done in {time.time() - t0:.1f}s")

    # Stage 4 — package results.
    _log("== Stage 4: package tar.gz ==")
    t0 = time.time()
    out_path = os.path.join(tmp_dir, "animation_results.tar.gz")
    _package_results(results_root, seq_name, save_name, out_path)
    with open(out_path, "rb") as f:
        out_bytes = f.read()
    _log(
        f"packaged {len(out_bytes)} bytes in {time.time() - t0:.1f}s; "
        f"TOTAL dt={time.time() - t_total:.1f}s"
    )
    return out_bytes


# ---------------------------------------------------------------------------
# Local entrypoint — used for ad-hoc CLI tests:
#
#   modal run modal_app/_puppeteer_animate.py::test_animate \
#       --input-glb path/to/dragon.glb \
#       --video-ref path/to/walking_dragon.mp4
#
# Reads bytes locally, calls `animate.remote(...)`, writes the tar.gz
# next to the input GLB. The remote function's container logs stream
# back to the CLI in real time thanks to `subprocess.Popen` line-buffer
# in _stream(), so you see "save_flow → optimization → packaging" as
# it happens.
# ---------------------------------------------------------------------------
@app.local_entrypoint()
def test_animate(
    input_glb: str,
    video_ref: str,
    output_tgz: str = "",
    seq_name: str = "fabmesh",
    save_name: str = "run0",
    iters: int = 200,
    img_size: int = 960,
    fps: int = 10,
    smooth_weight: float = 1.0,
    coherence_weight: float = 5.0,
    main_renderer: str = "front",
    additional_renderers: str = "front_left,front_right,back_right",
):
    """Run a single animation test from the CLI.

    Args:
      input_glb:   path to a rigged GLB (output of Puppeteer rig stage).
      video_ref:   path to a driving reference mp4.
      output_tgz:  where to write the results tar.gz. Defaults to
                   `<input_glb_basename>.<seq_name>.<save_name>.tgz`
                   next to input_glb.
      everything else maps 1:1 to the remote `animate` function args.
    """
    if not os.path.isfile(input_glb):
        raise SystemExit(f"input GLB not found: {input_glb}")
    if not os.path.isfile(video_ref):
        raise SystemExit(f"reference video not found: {video_ref}")
    with open(input_glb, "rb") as f:
        glb_bytes = f.read()
    with open(video_ref, "rb") as f:
        video_bytes = f.read()
    print(
        f"[test_animate] sending GLB ({len(glb_bytes)} bytes) + "
        f"video ({len(video_bytes)} bytes) to Modal animate()",
        flush=True,
    )
    t0 = time.time()
    out_bytes = animate.remote(
        glb_bytes=glb_bytes,
        video_bytes=video_bytes,
        seq_name=seq_name,
        save_name=save_name,
        iters=iters,
        img_size=img_size,
        fps=fps,
        smooth_weight=smooth_weight,
        coherence_weight=coherence_weight,
        main_renderer=main_renderer,
        additional_renderers=additional_renderers,
    )
    dt = time.time() - t0
    if not output_tgz:
        base = os.path.splitext(os.path.basename(input_glb))[0]
        output_tgz = os.path.join(
            os.path.dirname(os.path.abspath(input_glb)),
            f"{base}.{seq_name}.{save_name}.tgz",
        )
    with open(output_tgz, "wb") as f:
        f.write(out_bytes)
    print(
        f"[test_animate] done in {dt:.1f}s — wrote "
        f"{output_tgz} ({len(out_bytes)} bytes)",
        flush=True,
    )
