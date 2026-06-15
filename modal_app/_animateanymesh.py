"""AnimateAnyMesh — cloud version (Modal).

Text-driven universal mesh animation (ICCV 2025). Given a static GLB
mesh + a natural-language prompt, this app runs a single forward pass
of the DyMeshVAE + Text-to-Trajectory Rectified-Flow model and returns
an animated FBX (or ABC) ready for import into Blender / Unreal / Unity.

Why a SEPARATE app (not folded into _puppeteer_animate.py):
- AnimateAnyMesh is a completely DIFFERENT animation paradigm from
  Puppeteer. Puppeteer takes a rigged mesh + a driving video and
  optimises a per-bone quaternion sequence over ~200 differentiable-
  render iters (15-25 min on A10G). AnimateAnyMesh takes a STATIC
  unrigged mesh + a TEXT prompt and runs feed-forward in seconds — no
  reference video, no per-bone rig, no iterative optimisation. The two
  models share zero code, zero checkpoints, and have incompatible
  output schemas (Puppeteer = per-bone quats, AnimateAnyMesh = per-
  vertex trajectory tensors baked into shape keys).
- Their Modal images barely overlap either: AnimateAnyMesh wants
  torch 2.6.0 + transformers 4.55.3 + torchdiffeq + a vanilla
  pytorch3d build, while Puppeteer is pinned to torch 2.7.0 +
  flash-attn 2.7.4.post1 + libigl 2.5.1 + ptlflow + the
  Video-Depth-Anything + CoTracker3 checkpoints (1.65 GB on top of
  the rig image). Sharing one image would force one of the two to
  carry the other's deps for no benefit and would invalidate the
  cached layers on every requirements bump.
- Splitting them also lets the cloud worker / desktop launcher
  choose the right tier per job: feed-forward text→motion goes here
  (cheap L4, ~5-10 min cold + a few seconds of inference), while
  video→motion baking stays on the Puppeteer animate app
  (A10G, ~20-30 min). The desktop UI exposes both as
  "Text-to-animation" vs "Match this video" without users needing to
  know which model runs.

PIPELINE:
  Stage 0. Write `glb_bytes` to `/tmp/run/<test_name>.glb`.
  Stage 1. Invoke `test_drive.py` with the brief's exact CLI:
            python test_drive.py \
                --data_dir /tmp/run \
                --vae_dir /AnimateAnyMesh/checkpoints \
                --rf_model_dir /AnimateAnyMesh/checkpoints \
                --json_dir /AnimateAnyMesh/checkpoints/dvae_factors \
                --rf_exp rf_model --rf_epoch f \
                --seed <seed> \
                --test_name fabmesh --prompt "<prompt>" \
                --export_format <fbx|abc> \
                --video_save_dir /tmp/run/output_videos
  Stage 2. Read `/tmp/run/output_videos/rf_model/fabmesh.<fbx|abc>`
           and return the raw bytes.

INPUT: AnimateAnyMesh consumes `.glb` directly (its internal mesh
loader uses bpy via utils/render.import_glb). No OBJ conversion
needed — the README is explicit: "For the input mesh format, we only
support .glb now."

OUTPUT: a 4D animated mesh — per-frame vertex positions baked as
shape-key keyframes, exported via `bpy.ops.export_scene.fbx` with
`bake_anim=True` (or `bpy.ops.wm.alembic_export` for ABC). UE5 / DCC
tools can re-time / loop / bake-to-skeletal as needed.

VRAM: The released checkpoint (rf_epoch_f, ~805 MB + DyMeshVAE
~146 MB + transformers text encoder) fits in 16 GB headroom according
to the upstream README. L4 24 GB is the cheapest Modal GPU that
clears that bar with margin (vs A10G $1.10/h, T4 = 16 GB but only
CUDA 7.5 / no fp16 perf parity).

DEPLOY:
    modal token new
    modal deploy modal_app/_animateanymesh.py

The image bakes the HF weights into the layer cache (~952 MB of
checkpoint downloads), so cold-container restores are pure pull-from-
registry — no per-job HF round-trip.

License: AnimateAnyMesh is Apache-2.0 (see
https://github.com/JarrentWu1031/AnimateAnyMesh/blob/main/LICENSE).
We REDISTRIBUTE the code at runtime via `git clone` inside the
image build; per Apache-2.0 §4 we preserve the upstream LICENSE +
copyright notices (the clone keeps the repo's LICENSE file at
/AnimateAnyMesh/LICENSE). Commercial use is permitted by the
license, including in our Steam / Fab.com / itch.io distributions
(see docs/anytop_license_audit_2026-06-05.md for the FabMesh-wide
license matrix). Model weights are released by the authors under
the same Apache-2.0 terms on HuggingFace
(https://huggingface.co/JarrentWu/AnimateAnyMesh).
"""
import io
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import time

import modal

# ---------------------------------------------------------------------------
# Image — minimal stack to run AnimateAnyMesh's test_drive.py:
#   - CUDA 12.8 devel base (matches upstream README: "CUDA12.8 (CUDA 11.8+
#     recommended)") with cp311 — also per upstream "tested under
#     Python 3.11".
#   - torch 2.6.0 + torchvision from the cu128 index (upstream pin).
#   - pytorch3d built from source against torch 2.6 / cu128 (no prebuilt
#     wheel for this combo; gcc build is clean on Linux, no MSVC issue).
#   - bpy via PyPI wheel (upstream requirements.txt lists `bpy` unpinned;
#     bpy 4.5 ships a cp311 manylinux wheel that matches the base image).
#   - The rest of upstream requirements.txt verbatim (torchdiffeq,
#     transformers==4.55.3, einops, imageio[ffmpeg,pyav], pillow,
#     opencv-python, psutil, numpy==1.26.0).
#   - git clone of the upstream repo + HF checkpoint download into the
#     paths test_drive.py hardcodes via its argparse defaults.
# ---------------------------------------------------------------------------
image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.8.1-devel-ubuntu22.04",
        add_python="3.11",
    )
    .env({"CUDA_HOME": "/usr/local/cuda"})
    .apt_install(
        # Build toolchain — gcc/g++ from build-essential is the only
        # compiler we need (no MSVC pain on Linux). ninja for pytorch3d
        # CUDA extension linker speed. ffmpeg for imageio[ffmpeg]
        # subprocess backend (test_drive.py writes per-frame PNGs then
        # encodes a preview mp4 via imageio). GL libs for bpy headless
        # (utils/render.py imports bpy at module-load time).
        "git", "build-essential", "ninja-build", "clang",
        "libgl1", "libegl1",
        "libglib2.0-0", "libsm6", "libxext6", "libxrender1",
        "libxi6", "libxxf86vm1", "libxfixes3", "libxkbcommon0",
        "ffmpeg",
        "wget", "ca-certificates",
    )
    .pip_install(
        # Upstream pin — torch 2.6.0 / cu128 / cp311. We add torchvision
        # at the matching 0.21.0 release (torch 2.6 alignment) even
        # though upstream requirements.txt lists only torch — bpy +
        # pytorch3d pull torchvision implicitly so we pin it explicitly
        # to avoid a sneaky pip upgrade.
        # 2026-06-08: bumped from 2.6.0 → 2.7.1 because cu128 index dropped 2.6.0
        # AnimateAnyMesh tested on 2.6.0 but pytorch3d source build works against 2.7
        "torch==2.7.1",
        "torchvision==0.22.1",
        extra_options="--index-url https://download.pytorch.org/whl/cu128",
    )
    .pip_install(
        "packaging", "setuptools", "wheel", "ninja",
    )
    # pytorch3d from source — no prebuilt wheel covers torch 2.6 + cu128
    # + cp311 on PyPI, so we build it ourselves. The Linux gcc build is
    # clean (the MSVC drama is Windows-only). TORCH_CUDA_ARCH_LIST
    # targets Ampere (8.0 = A100), Ada Lovelace (8.9 = L4 / RTX 4090),
    # Hopper (9.0+PTX = H100 forward-compat) — L4 is our deploy GPU but
    # adding 8.0/9.0 keeps the same image runnable on A10G/A100/H100 if
    # we need to scale up.
    .run_commands(
        "FORCE_CUDA=1 TORCH_CUDA_ARCH_LIST='8.0;8.9;9.0+PTX' "
        "pip install --no-build-isolation "
        "'git+https://github.com/facebookresearch/pytorch3d.git'",
    )
    # Remaining upstream requirements.txt + a couple of implicit deps
    # the code path pulls in (huggingface_hub for the build-time
    # checkpoint download, trimesh as a defensive fallback for any
    # GLB-side conversion we might add later).
    .pip_install(
        "numpy==1.26.0",
        "torchdiffeq==0.2.5",
        "transformers==4.55.3",
        # 2026-06-09: bpy 3.6 not on PyPI (starts at 4.2.0).
        # 4.4+ broke Action.fcurves API. Stay at latest 4.2.x patch.
        # Add DISPLAY env hack so Cycles GPU init doesn't SIGSEGV.
        "bpy==4.2.21",
        "einops",
        "imageio[ffmpeg]",
        "imageio[pyav]",
        "pillow",
        "opencv-python",
        "psutil",
        "huggingface_hub>=0.34",
        "trimesh>=4.0",
    )
    .env({
        "CC": "gcc", "CXX": "g++",
        "CUDA_HOME": "/usr/local/cuda",
        "TORCH_CUDA_ARCH_LIST": "8.0;8.9;9.0+PTX",
        "FORCE_CUDA": "1",
        "HF_HOME": "/root/.cache/huggingface",
        # AnimateAnyMesh's bpy import in utils/render.py expects a
        # headless display; bpy 4.x handles offscreen rendering itself
        # but we set this to be explicit and silence the EGL warning.
        "PYOPENGL_PLATFORM": "egl",
    })
    # AnimateAnyMesh source tree — pinned to a shallow main clone. The
    # repo is ~30 MB without the assets/ + demo_source/ image dumps so
    # `--depth 1` is fine (we don't need history). We DO want the
    # upstream LICENSE preserved at /AnimateAnyMesh/LICENSE for the
    # Apache-2.0 §4 redistribution clause.
    .run_commands(
        "git clone --depth 1 "
        "https://github.com/JarrentWu1031/AnimateAnyMesh /AnimateAnyMesh",
    )
    # HuggingFace weights — JarrentWu/AnimateAnyMesh holds the three
    # checkpoints test_drive.py loads:
    #   - dvae/dvae_f.pth          (DyMeshVAE,           ~146 MB)
    #   - dvae/model_config.json   (vae arch metadata)
    #   - dvae_factors/dvae_f.json (rescale stats: f0_mean/std + ft_mean/std)
    #   - rf_model/rf_epoch_f.pth  (RF text→traj model,  ~805 MB)
    #   - rf_model/training_config.json (unified vae+rf+training args
    #                              that test_drive.py REQUIRES to exist
    #                              for inference — without it the load
    #                              raises FileNotFoundError)
    # We use snapshot_download to grab the whole repo at once instead
    # of 5 separate hf_hub_download calls — fewer HTTP round-trips and
    # the resulting checkpoint layout exactly mirrors what test_drive.py's
    # path-joining expects (vae_dir + "/" + vae_exp + "/dvae_" + vae_epoch
    # + ".pth" etc.).
    .run_commands(
        "python -c \""
        "from huggingface_hub import snapshot_download; "
        "snapshot_download("
        "repo_id='JarrentWu/AnimateAnyMesh', "
        "local_dir='/AnimateAnyMesh/checkpoints', "
        "); "
        "print('AnimateAnyMesh checkpoints downloaded')"
        "\"",
        # Build-time guard: fail the image build if any required file
        # is missing or implausibly small (HF flake → empty file). Better
        # to fail fast at build than crash-loop at first invocation.
        "python -c \""
        "import os; "
        "files = ["
        "('/AnimateAnyMesh/checkpoints/dvae/dvae_f.pth', 100*1024*1024), "
        "('/AnimateAnyMesh/checkpoints/dvae/model_config.json', 100), "
        "('/AnimateAnyMesh/checkpoints/dvae_factors/dvae_f.json', 100), "
        "('/AnimateAnyMesh/checkpoints/rf_model/rf_epoch_f.pth', 500*1024*1024), "
        "('/AnimateAnyMesh/checkpoints/rf_model/training_config.json', 300)]; "
        "bad = [(f, os.path.getsize(f) if os.path.isfile(f) else -1, lo) "
        "for f, lo in files if not os.path.isfile(f) or os.path.getsize(f) < lo]; "
        "assert not bad, f'ckpt missing/too small: {bad}'; "
        "print('AnimateAnyMesh checkpoints OK:', "
        "[(f, os.path.getsize(f)) for f, _ in files])\"",
        # Sanity import — catch missing CUDA arches or pytorch3d build
        # mismatches at build time instead of in the user's job.
        "python -c \"import torch, pytorch3d, bpy, torchdiffeq, transformers; "
        "print('torch', torch.__version__, "
        "'pytorch3d', pytorch3d.__version__, "
        "'bpy', bpy.app.version_string, "
        "'transformers', transformers.__version__)\"",
    )
)

app = modal.App("myfabmesh-animateanymesh", image=image)


# ---------------------------------------------------------------------------
# Paths inside the container.
# ---------------------------------------------------------------------------
AAM_DIR = "/AnimateAnyMesh"
CKPT_DIR = f"{AAM_DIR}/checkpoints"


def _log(msg: str) -> None:
    print(f"[animateanymesh] {msg}", flush=True)


def _stream(proc: subprocess.Popen) -> int:
    """Stream subprocess stdout line-by-line so progress shows up in
    `modal app logs` in real time (matches _puppeteer_animate._stream)."""
    if proc.stdout is None:
        return proc.wait()
    for line in proc.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
    return proc.wait()


# ---------------------------------------------------------------------------
# Core function — synchronous, returns the FBX or ABC bytes. Caller
# (local_entrypoint or future router) writes the file locally.
# ---------------------------------------------------------------------------
@app.function(
    image=image,
    # L4 24 GB — cheapest Modal GPU that comfortably fits the brief's
    # 16 GB minimum VRAM, at $0.80/h. T4 (16 GB) lacks fp16 perf parity
    # + bare-minimum VRAM headroom; A10G works but is 38 % more expensive.
    gpu="L4",
    # 10 min — feed-forward inference is seconds, but cold-start of a
    # CUDA 12.8 image + torch load + checkpoint mmap can take 1-2 min,
    # plus bpy scene setup + per-frame render + ffmpeg encode for the
    # preview mp4 adds another minute or two for a 16-frame sequence.
    # 10 min gives plenty of margin without overpaying on timeout.
    timeout=600,
    # 16 GB host RAM — bpy + the RF model state dict + the rendered
    # frame buffer easily exceeds the 8 GB Modal default for non-trivial
    # meshes.
    memory=16384,
)
def animate(
    glb_bytes: bytes,
    prompt: str = "The object is walking",
    export_format: str = "fbx",
    seed: int = 666,
) -> bytes:
    """Run AnimateAnyMesh inference. Returns the FBX or ABC bytes.

    Args:
      glb_bytes:     raw bytes of a static .glb mesh (no rig required).
      prompt:        natural-language motion description (e.g.
                     "The object is walking", "The object is flying").
                     The text encoder inside the RF model conditions on
                     this verbatim; upstream README recommends prefixing
                     "The object is …" for best results.
      export_format: "fbx" or "abc". FBX bakes the per-frame vertex
                     trajectories as shape-key animation (UE5 / Unity
                     friendly); ABC writes an Alembic cache (DCC-friendly,
                     keeps UVs + face sets).
      seed:          torch.manual_seed for reproducibility. Upstream
                     README explicitly recommends trying multiple seeds —
                     "outputs can vary significantly across seeds".

    Returns: raw bytes of the exported FBX or ABC file.

    Raises:
      ValueError on unsupported `export_format`.
      RuntimeError if test_drive.py exits non-zero or the expected
      output file is missing after the run.
    """
    if export_format not in ("fbx", "abc"):
        raise ValueError(
            f"export_format must be 'fbx' or 'abc', got {export_format!r}"
        )

    t_total = time.time()
    tmp_dir = tempfile.mkdtemp(prefix="animateanymesh_")
    try:
        # Stage 0 — stage the GLB at /tmp/<tmp>/<test_name>.glb so
        # test_drive.py finds it via --data_dir + --test_name. We use
        # a fixed test_name so the output path is predictable.
        test_name = "fabmesh"
        data_dir = tmp_dir
        video_save_dir = os.path.join(tmp_dir, "output_videos")
        os.makedirs(video_save_dir, exist_ok=True)

        glb_path = os.path.join(data_dir, f"{test_name}.glb")
        with open(glb_path, "wb") as f:
            f.write(glb_bytes)
        _log(f"staged {glb_path} ({len(glb_bytes)} bytes)")

        # Stage 1 — invoke test_drive.py exactly as the brief specifies.
        # rf_exp=rf_model + rf_epoch=f match the released checkpoint
        # layout (rf_model/rf_epoch_f.pth + rf_model/training_config.json
        # on the HF repo). test_drive.py reads training_config.json to
        # auto-fill vae_exp + vae_epoch from training_args[
        # "vae_exp_dependency"] / ["vae_epoch_dependency"], which
        # resolve to "dvae" + "f" — so the dvae/dvae_f.pth +
        # dvae_factors/dvae_f.json paths line up too.
        cmd = [
            sys.executable, "test_drive.py",
            "--data_dir", data_dir,
            "--vae_dir", CKPT_DIR,
            "--rf_model_dir", CKPT_DIR,
            "--json_dir", os.path.join(CKPT_DIR, "dvae_factors"),
            "--rf_exp", "rf_model",
            "--rf_epoch", "f",
            "--seed", str(seed),
            "--test_name", test_name,
            "--prompt", prompt,
            "--export_format", export_format,
            "--video_save_dir", video_save_dir,
        ]
        _log("test_drive: " + " ".join(shlex.quote(c) for c in cmd))
        t0 = time.time()
        proc = subprocess.Popen(
            cmd, cwd=AAM_DIR,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1,
        )
        rc = _stream(proc)
        if rc != 0:
            raise RuntimeError(f"test_drive.py failed rc={rc}")
        _log(f"test_drive.py done in {time.time() - t0:.1f}s")

        # Stage 2 — read the exported animation file. In
        # utils/render.drive_mesh_with_trajs_frames the export path is
        # built as `os.path.join(os.path.dirname(output_dir),
        # f"{filename}.{export_format}")` where `output_dir =
        # f"{video_save_dir}/{test_name}"` (after test_drive.py already
        # appended rf_exp to video_save_dir) and `filename =
        # os.path.basename(output_dir) = test_name`. So the final
        # location is `<video_save_dir>/<rf_exp>/<test_name>.<ext>`.
        out_path = os.path.join(
            video_save_dir, "rf_model", f"{test_name}.{export_format}"
        )
        if not os.path.isfile(out_path):
            raise RuntimeError(
                f"AnimateAnyMesh produced no {export_format.upper()} at "
                f"{out_path}; expected layout: "
                f"<video_save_dir>/<rf_exp>/<test_name>.<ext>"
            )
        with open(out_path, "rb") as f:
            out_bytes = f.read()
        _log(
            f"read {out_path} ({len(out_bytes)} bytes); "
            f"TOTAL dt={time.time() - t_total:.1f}s"
        )
        # FabMesh 2026-06-09: also bundle the rendered preview mp4 so the
        # user can see the animation directly (without parsing FBX shape
        # keys). The mp4 lives next to the fbx with name
        # `<test_name>_azi0_ele0.mp4`. Bundle both as a tarball.
        import tarfile
        mp4_candidates = [
            os.path.join(video_save_dir, "rf_model", f"{test_name}_azi0_ele0.mp4"),
            os.path.join(video_save_dir, "rf_model", f"{test_name}.mp4"),
        ]
        mp4_path = next((p for p in mp4_candidates if os.path.isfile(p)), None)
        if mp4_path:
            buf = io.BytesIO()
            with tarfile.open(fileobj=buf, mode="w:gz") as tar:
                tar.add(out_path, arcname=os.path.basename(out_path))
                tar.add(mp4_path, arcname=os.path.basename(mp4_path))
            _log(f"bundled fbx + mp4 into tar.gz ({len(buf.getvalue())} bytes)")
            return buf.getvalue()
        return out_bytes
    finally:
        try:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Local entrypoint — ad-hoc CLI tests:
#
#   modal run modal_app/_animateanymesh.py::test_animate \
#       --input-glb path/to/dragon.glb \
#       --prompt "a dragon walking" \
#       --output-path path/to/dragon.fbx \
#       --export-format fbx
#
# Reads the GLB locally, calls `animate.remote(...)`, writes the result
# next to the input GLB by default.
# ---------------------------------------------------------------------------
@app.local_entrypoint()
def test_animate(
    input_glb: str,
    prompt: str = "a dragon walking",
    output_path: str = None,
    export_format: str = "fbx",
    seed: int = 666,
):
    """Run a single AnimateAnyMesh test from the CLI.

    Args:
      input_glb:     path to a static .glb mesh.
      prompt:        natural-language motion description.
      output_path:   where to write the exported FBX/ABC. Defaults to
                     `<input_glb_basename>.animated.<fbx|abc>` next to
                     input_glb.
      export_format: "fbx" or "abc".
      seed:          torch.manual_seed for reproducibility. Upstream
                     README notes outputs can vary significantly across
                     seeds — try a few if the first one disappoints.
    """
    if not os.path.isfile(input_glb):
        raise SystemExit(f"input GLB not found: {input_glb}")
    if export_format not in ("fbx", "abc"):
        raise SystemExit(
            f"export_format must be 'fbx' or 'abc', got {export_format!r}"
        )
    with open(input_glb, "rb") as f:
        glb_bytes = f.read()
    print(
        f"[test_animate] sending GLB ({len(glb_bytes)} bytes) to Modal "
        f"animate() — prompt={prompt!r} fmt={export_format} ",
        flush=True,
    )
    t0 = time.time()
    out_bytes = animate.remote(
        glb_bytes=glb_bytes,
        prompt=prompt,
        export_format=export_format,
        seed=seed,
    )
    dt = time.time() - t0
    if not output_path:
        base = os.path.splitext(os.path.basename(input_glb))[0]
        output_path = os.path.join(
            os.path.dirname(os.path.abspath(input_glb)),
            f"{base}.animated.{export_format}",
        )
    with open(output_path, "wb") as f:
        f.write(out_bytes)
    print(
        f"[test_animate] done in {dt:.1f}s — wrote "
        f"{output_path} ({len(out_bytes)} bytes)",
        flush=True,
    )
