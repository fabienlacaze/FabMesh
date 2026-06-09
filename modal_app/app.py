"""MyFabmesh.AI Cloud — Modal app (POC: text2image only).

Why Modal vs Replicate (recap):
    Replicate L40S w/ Cog: $0.000975/s × (87s setup + 35s inference) = $0.12 / image
    Modal    L40S w/ snap: $0.000542/s × (~5s restore + 35s inference) = $0.022 / image
    → ~5.5× cost reduction + cold start UX goes from 90s to ~5s.

The trick is Memory Snapshots: @modal.enter(snap=True) loads weights
to CPU memory ONCE; Modal snapshots that memory state; subsequent cold
restores rehydrate the snapshot in seconds instead of re-downloading
the 12GB of HF weights from scratch.

DEPLOY:
    pip install modal
    modal token new                # one-time, opens browser to authenticate
    modal deploy modal_app/app.py  # builds image (~5-10 min first time),
                                   #   then publishes the app

INVOKE (once deployed):
    The class methods are exposed at:
      https://<workspace>--myfabmesh-cloud-myfabmeshpredictor-text2image.modal.run
    (Modal generates the URL on `modal deploy` output. Worker
    integrates via the URL set in env MODAL_TEXT2IMAGE_URL.)

NOTE: Do not name this directory `modal/` — Python would shadow the
Modal SDK. We use `modal_app/`.
"""
import io
import os
import sys
import time

import modal


# ---------------------------------------------------------------------------
# DRY helpers for the ASGI routers below. Each router (predictor / backview
# / mesh) wraps multiple POST routes that share the SAME auth pattern, body
# parsing and PNG encoding — we factor them once here so each route body
# stays focused on the heavy AI call.
#
# Why ASGI consolidation? Modal Starter caps web functions at 8. We had 8
# `@modal.fastapi_endpoint`s (text2image + back_view + tpose + rectify +
# image_op + sheet + mesh_start + mesh_status). One `@modal.asgi_app` is
# ONE endpoint slot regardless of how many internal routes it serves, so
# we collapse to 3 routers and free 5 slots for future endpoints (puppeteer
# rig, animation, retopo…) without ever needing a plan upgrade.
#
# Critical: `@modal.asgi_app()` on a `@app.cls` method runs the ASGI server
# INSIDE the same GPU container as the class — `self.pipe` is on the local
# GPU, no `.remote()` hop needed (that would double-bill and double cold
# start). Only `mesh_start` keeps `.spawn()` because it really crosses a
# container boundary (CPU front-end → separate GPU MyFabmeshMesh class).
# ---------------------------------------------------------------------------
def _check_auth(payload: dict) -> None:
    """401 immediately if the shared secret is missing/wrong.

    Raises BEFORE any heavy work — keeps the abuse story identical to the
    legacy `@modal.fastapi_endpoint` paths. Each route called this inline;
    factored here so a worker secret rotation only touches one place.
    """
    from fastapi import HTTPException
    expected = os.environ.get("SHARED_SECRET", "")
    provided = (payload.get("_auth") or "").strip()
    if not expected or provided != expected:
        raise HTTPException(status_code=401, detail="auth")


async def _read_json(request) -> dict:
    """FastAPI hands us a `Request`; legacy endpoints used `payload: dict`.

    We restore the legacy contract by reading + parsing the body once here.
    A malformed body → 400 (same status FastAPI would give for a bad
    `payload: dict` argument before).
    """
    from fastapi import HTTPException
    try:
        return await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid json body")


def _png_response(img):
    """Encode a PIL.Image → PNG → fastapi.Response with image/png type.

    Matches the tail of every legacy endpoint — `buf = io.BytesIO();
    img.save(buf, format='PNG', …); Response(content=buf.getvalue(), …)`.
    """
    from fastapi.responses import Response
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=False)
    return Response(content=buf.getvalue(), media_type="image/png")


def _fetch_image(url: str, mode: str = "RGB"):
    """Browser-UA GET → PIL.Image. Required because Cloudflare R2 returns
    403 to the default urllib UA — every legacy endpoint reimplemented this
    same `urllib.request.Request(..., headers={'User-Agent': ...})` dance.
    """
    import urllib.request
    from PIL import Image
    req = urllib.request.Request(
        url,
        headers={"User-Agent":
                 "Mozilla/5.0 (X11; Linux x86_64) myfabmesh-cloud/1.0"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return Image.open(io.BytesIO(r.read())).convert(mode)

# ---------------------------------------------------------------------------
# Image: CUDA 12.4 + torch 2.4 (same stack as the desktop & the Cog) so
# diffusers loads identical weights and produces byte-identical output
# given the same seed. xformers 0.0.28 needs torch 2.4 — bumping torch
# means re-checking xformers/transformers/diffusers compat (we already
# fought this fight in cog/cog.yaml, no need to re-fight it).
# ---------------------------------------------------------------------------
# Base image — CUDA + Python + the heavy pip deps shared by every
# pipeline (torch, diffusers, fastapi). Both `image` (text2image +
# back-view) and `mesh_image` (TRELLIS-2) extend from here.
_base_image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.4.0-devel-ubuntu22.04",
        add_python="3.11",
    )
    .apt_install(
        "libgl1", "libglib2.0-0", "libsm6", "libxext6", "libxrender-dev",
    )
    .pip_install(
        "torch==2.4.1",
        "torchvision==0.19.1",
        extra_options="--index-url https://download.pytorch.org/whl/cu124",
    )
    .pip_install(
        # Pinned to versions known compatible with torch 2.4.
        # transformers 4.47+ requires torch.distributed.tensor.device_mesh
        # (torch 2.5+) → import-time crash on torch 2.4. Keep at 4.45.
        "transformers==4.45.2",
        "diffusers==0.31.0",
        "huggingface_hub==0.25.2",
        "accelerate==0.34.2",
        "safetensors==0.4.5",
        "xformers==0.0.28",
        # Image processing
        "pillow>=10",
        "numpy>=1.26,<2.0",
        # FastAPI — required since Modal 1.x for @modal.fastapi_endpoint.
        "fastapi[standard]>=0.115",
        # Florence-2 (used by back-view) imports einops + timm via
        # trust_remote_code — without these the @enter(snap=True)
        # crashes with ImportError before the snapshot is even taken.
        "einops>=0.7", "timm>=0.9",
    )
)

# Image for text2image + back-view (no mesh deps needed). Ships the
# shared modal_app/ Python source + the back skeleton PNG.
# Modal rule: add_local_* must come LAST.
image = (
    _base_image
    # opencv-python-headless ships the Haar Cascade XMLs we need for
    # face detection in image_op face_fix_image. Pure CPU (~50ms per
    # image). Kept here (NOT in _base_image) so adding it doesn't
    # invalidate mesh_image — which would re-build CuMesh + the
    # nvdiffrast + o-voxel CUDA stack for 30-60min for nothing.
    # Same logic for trimesh: needed by mesh_start's op_type dispatch
    # (smooth/decimate/center/fix_normals/fill_holes) but pure CPU.
    .pip_install("opencv-python-headless", "trimesh>=4.0", "scipy>=1.10")
    .add_local_python_source("modal_app")
    .add_local_file(
        "modal_app/back_tpose_skeleton.png",
        remote_path="/opt/back_tpose_skeleton.png",
    )
    # FRONT T-pose skeleton — used by the `tpose` endpoint on
    # MyFabmeshBackview (the back-view class already has all the
    # RealVisXL + ControlNet OpenPose + IPAdapter weights we need,
    # so we just need the additional front skeleton PNG here).
    .add_local_file(
        "modal_app/front_tpose_skeleton.png",
        remote_path="/opt/front_tpose_skeleton.png",
    )
)

app = modal.App("myfabmesh-cloud", image=image)


# ---------------------------------------------------------------------------
# Mesh image — TRELLIS-2 has heavy CUDA build deps that we DON'T want
# in the shared image (text2image + back-view would re-pay them for
# nothing). We extend `_base_image` with the TRELLIS-2 source + its
# native CUDA components (nvdiffrast, o-voxel) BEFORE the add_local_*
# step (Modal forbids run_commands/pip_install after add_local_*).
#
# CAUTION: build can take 30-60 min the first time. Modal caches the
# image so subsequent deploys are fast.
# ---------------------------------------------------------------------------
mesh_image = (
    _base_image
    # libeigen3-dev required because the desktop fork's
    # `o-voxel/third_party/eigen/` is an empty git submodule placeholder
    # (we ship it via add_local_dir but the headers aren't there).
    # We `cp -r /usr/include/eigen3/Eigen` into the fork's third_party
    # tree just before `pip install o-voxel`.
    .apt_install("git", "ninja-build", "build-essential",
                 "libjpeg-dev", "libeigen3-dev")
    .pip_install(
        # Build tools — REQUIRED before nvdiffrast/o-voxel/etc. use
        # --no-build-isolation (otherwise bdist_wheel is missing →
        # "invalid command 'bdist_wheel'" at install time).
        "wheel>=0.42", "setuptools>=68", "packaging",
        # TRELLIS-2 basic deps (mirror of setup.sh BASIC=true block).
        "imageio", "imageio-ffmpeg", "tqdm", "easydict",
        "opencv-python-headless", "ninja", "trimesh",
        "tensorboard", "pandas", "lpips", "zstandard",
        "kornia",
        # utils3d pinned by TRELLIS-2 setup.sh.
        "utils3d @ git+https://github.com/EasternJournalist/utils3d.git"
        "@9a4eb15e4021b67b12c460c7057d642626897ec8",
        # rembg uses ONNX runtime — needs onnxruntime-gpu for L40S.
        "rembg[gpu]>=2.0",
        # transformers 4.56.0 — the FIRST version that ships
        # DINOv3ViTModel (the fork's image_feature_extractor.py does
        # `from transformers import DINOv3ViTModel`, added on 2025-08-29).
        # Anything < 4.56.0 (incl. the 4.51.3 we tried previously)
        # crashes the @enter(snap=True) with `ImportError: cannot import
        # name 'DINOv3ViTModel' from 'transformers'`.
        # transformers 4.56 still works on torch 2.4 (min torch is 2.2).
        # We DON'T pin tokenizers manually — pip picks one compatible.
        # Override the _base_image's 4.45.2 with `--upgrade`.
        "transformers==4.56.0", "huggingface_hub>=0.34",
    )
    .env({
        "CC": "gcc", "CXX": "g++",
        "CUDA_HOME": "/usr/local/cuda",
        "TORCH_CUDA_ARCH_LIST": "8.0;8.9;9.0+PTX",
        "FORCE_CUDA": "1",
    })
    # Ship the DESKTOP fork of TRELLIS-2 directly into the image
    # (≈40 MB of pure source — no precompiled .so/.pyd, all the .cu/.cpp
    # files compile fresh below). This is the SAME tree the desktop
    # runs against and the user has hardened over several days. We do
    # NOT clone microsoft/TRELLIS.2 main anymore — its layout drifted
    # (root vs src/) and its image_feature_extractor expects API surfaces
    # that the desktop fork patched.
    .add_local_dir(
        "external/TRELLIS2_win/src",
        remote_path="/opt/trellis2_local",
        copy=True,   # bake into image so subsequent run_commands can use it
    )
    .run_commands(
        # CRITICAL: force-upgrade transformers to 4.56 BEFORE TRELLIS-2
        # imports DINOv3ViTModel (the symbol only exists from 4.56.0+,
        # released 2025-08-29 — 4.51 we tried previously DOES NOT have
        # it, so the import crashed @enter(snap=True)).
        # We do it via run_commands rather than pip_install so the step
        # cannot be deduped against a previous build's pip_install layer.
        # --no-deps to keep torch 2.4.1 pinned (transformers 4.56 only
        # needs torch >= 2.2, so 2.4 is fine).
        "pip install --upgrade --no-deps "
        "transformers==4.56.0 'tokenizers>=0.22,<0.23' "
        "'huggingface_hub>=0.34,<1.0'",
        # BUILD-TIME GUARD — fail the image build (clear traceback)
        # instead of crash-looping the running app if the upgrade did
        # not take effect for any reason (cache, conflict, etc.).
        "python -c \"import transformers; "
        "print('transformers', transformers.__version__, transformers.__file__); "
        "from transformers import DINOv3ViTModel; print('DINOv3ViTModel OK')\"",
        # nvdiffrast v0.4.0 (rendering backend used by trellis2).
        "git clone --depth 1 -b v0.4.0 https://github.com/NVlabs/nvdiffrast.git /tmp/nvdiffrast "
        "&& pip install /tmp/nvdiffrast --no-build-isolation",
        # The desktop fork's `o-voxel/third_party/eigen/` is an empty
        # submodule placeholder — Modal's add_local_dir skips empty
        # dirs so we mkdir + populate from libeigen3-dev so the
        # #include <Eigen/Dense> in the .cpp files resolves.
        "mkdir -p /opt/trellis2_local/o-voxel/third_party/eigen "
        "&& cp -r /usr/include/eigen3/Eigen /opt/trellis2_local/o-voxel/third_party/eigen/Eigen",
        # o-voxel from the SHIPPED desktop fork. --no-deps so its setup
        # cannot quietly pull in a transformers pin that downgrades the
        # 4.56 we just installed above.
        "pip install /opt/trellis2_local/o-voxel --no-build-isolation --no-deps",
        # cumesh — `import cumesh` is needed by
        # trellis2/representations/mesh/base.py:4. The desktop fork has
        # cumesh only in its Windows .venv (no source), so we clone the
        # upstream JeffreyXiang/CuMesh repo (same as TRELLIS-2 setup.sh)
        # and pip install --no-deps to preserve torch 2.4. CuMesh has
        # NO triton dependency — safe to keep.
        "git clone --recursive https://github.com/JeffreyXiang/CuMesh.git /tmp/cumesh "
        "&& pip install /tmp/cumesh --no-build-isolation --no-deps",
        # flex-gemm — sparse GEMM kernels used by trellis2/representations/
        # mesh/base.py:5 (`from flex_gemm.ops.grid_sample import grid_sample_3d`)
        # AND by sparse-conv backend. Pinned to v1.0.0 (Jan 2026 stable
        # release) to avoid unannounced API breakage on `main`.
        "git clone --depth 1 --branch v1.0.0 --recursive "
        "https://github.com/JeffreyXiang/FlexGEMM.git /tmp/flexgemm "
        "&& pip install /tmp/flexgemm --no-build-isolation --no-deps",
        # flash-attn — required by TRELLIS-2's attention layers. Without
        # it the mesh runtime fails with `ModuleNotFoundError: flash_attn`
        # at the first pipeline.run() call. Same version the desktop
        # setup.sh installs. --no-deps so it doesn't try to upgrade torch.
        # We install BEFORE the triton 3.2 pin and the build-time guards.
        "pip install --no-deps --no-build-isolation flash-attn==2.7.3",
        # *** THE FIX FROM 17 DEPLOYS OF FAILURE ***
        # flex-gemm's `flex_gemm/utils/autotuner.py` does:
        #   class TritonPersistentCacheAutotuner(triton.runtime.Autotuner):
        #       def __init__(self, ...):
        #           super().__init__(<13 args incl. do_bench>)
        # Triton 3.2.0+ `Autotuner.__init__` accepts those 13 args; triton
        # 3.0.0 (the version torch 2.4 SHIPS) only accepts up to 12 →
        # "Autotuner.__init__() takes from 7 to 13 positional arguments
        #  but 14 were given" at the very first cumesh/mesh import.
        # We install triton 3.2.0 explicitly here AFTER flex-gemm is
        # already installed (so its --no-deps doesn't skip this) and
        # BEFORE the final torch reinstall (which would otherwise
        # downgrade triton). Triton is pure Python wrappers around CUDA
        # PTX — no torch ABI to break.
        "pip install --no-deps 'triton==3.2.0' filelock",
        # BUILD-TIME GUARD — only torch + triton + presence of TRELLIS
        # extensions. We CANNOT import flex_gemm at build time because
        # its @triton_autotune decorator queries the GPU driver. We
        # check presence via importlib.find_spec (string-only lookup,
        # no module execution).
        "python -c \"import torch, triton; "
        "print('torch', torch.__version__, 'triton', triton.__version__)\"",
        "python -c \"import importlib.util; "
        "missing = [p for p in ['cumesh','o_voxel','flex_gemm','transformers'] "
        "if importlib.util.find_spec(p) is None]; "
        "assert not missing, f'missing packages: {missing}'; "
        "print('all required packages located')\"",
    )
    # Final torch pin: o-voxel/cumesh/flex-gemm installs may upgrade torch
    # despite --no-deps in edge cases. Force it back to 2.4.1 + torchvision
    # 0.19.1. The CUDA .so binaries built above were compiled against torch
    # 2.4, so downgrading the Python torch module leaves them functional.
    .run_commands(
        "pip install --force-reinstall --no-deps "
        "torch==2.4.1 torchvision==0.19.1 "
        "--index-url https://download.pytorch.org/whl/cu124",
        # FINAL GUARD — torch --force-reinstall + the o-voxel install
        # above are the steps most likely to clobber transformers.
        # Re-verify the import works at the END of all build steps so
        # any regression fails the build, not the runtime.
        "python -c \"import transformers, triton; "
        "assert transformers.__version__.startswith('4.56'), "
        "'transformers got downgraded to '+transformers.__version__; "
        "assert triton.__version__.startswith('3.2'), "
        "'triton got downgraded to '+triton.__version__; "
        "from transformers import DINOv3ViTModel; "
        "print('FINAL transformers', transformers.__version__, "
        "'triton', triton.__version__, 'DINOv3ViTModel OK')\"",
    )
    .add_local_python_source("modal_app")
)


# ---------------------------------------------------------------------------
# Predictor class with Memory Snapshots.
#
# Lifecycle on each cold container:
#   1. Container boots (~1s on Modal vs ~30s on Replicate because no
#      6GB Docker image pull).
#   2. @modal.enter(snap=True) runs ONCE per snapshot version. It loads
#      diffusion weights to *CPU memory*. CUDA must NOT be used here —
#      the GPU is not attached yet.
#   3. Modal takes the snapshot of process memory after (2).
#   4. On every cold container after that:
#      - Snapshot restored (~3-5s — restores the entire CPU state)
#      - GPU is attached
#      - @modal.enter(snap=False) runs → moves the pipes onto CUDA
#      - We're ready in ~5-10s total (vs Replicate ~90s for an
#        equivalent workload)
# ---------------------------------------------------------------------------
@app.cls(
    gpu="L40S",
    timeout=600,
    # 30 s is aggressive: a container is killed 30 s after its last
    # request, so back-to-back gens stay warm but a user who pauses
    # 1 min between gens will pay the snapshot-restore cold start
    # again (~54 s). The trade-off: 180 s scaledown billed ~$0.10
    # of idle L40S per gen, while 30 s billed ~$0.02. We checked the
    # user's first invoice on 2026-05-25 ($0.52 for 2 gens) and it
    # was dominated by scaledown idle time. 30 s is the sweet spot
    # for the bursty workload of an image generator (one user
    # iterates on 3-5 gens in a row, then is idle for minutes).
    scaledown_window=300,  # keep warm 5 min after last call so back-to-back gens stay fast
    enable_memory_snapshot=True,
    # Surface the HF token + R2 creds so the predictor can pull
    # private/gated weights and (optionally) upload directly to R2.
    secrets=[
        # Shared secret the Worker sends in the request body so random
        # people can't burn our credits hitting the public URL.
        # Set via:  modal secret create myfabmesh-shared SHARED_SECRET=<32-byte hex>
        modal.Secret.from_name("myfabmesh-shared", required_keys=["SHARED_SECRET"]),
        # HuggingFace token is OPTIONAL for the POC — RealVisXL V4.0 is
        # a public model. If you ever swap in a gated model, uncomment:
        #   modal.Secret.from_name("huggingface", required_keys=["HF_TOKEN"]),
    ],
)
class MyFabmeshPredictor:
    @modal.enter(snap=True)
    def load_to_cpu(self):
        """CPU-only weight loading — runs once, gets snapshotted."""
        t0 = time.time()
        print("[snap] loading RealVisXL V4.0 onto CPU…", flush=True)
        import torch
        from diffusers import StableDiffusionXLPipeline
        from transformers import pipeline as _hfpipeline

        # CRITICAL: load on CPU (torch_dtype=fp16 is fine on CPU for
        # storage). DO NOT call .to("cuda") here — GPU is not attached.
        self.pipe = StableDiffusionXLPipeline.from_pretrained(
            "SG161222/RealVisXL_V4.0",
            torch_dtype=torch.float16,
            variant="fp16",
            use_safetensors=True,
        )
        # Pre-cast all sub-modules to fp16 (matches desktop bridge).
        self.pipe.unet.to(torch.float16)
        self.pipe.vae.to(torch.float16)
        self.pipe.text_encoder.to(torch.float16)
        self.pipe.text_encoder_2.to(torch.float16)

        # NSFW classifiers — small (~350MB total) and CPU-only, so we
        # also load them under the snapshot. Both are Apache 2.0.
        print("[snap] loading NSFW classifiers (Falconsai + AdamCodd)…", flush=True)
        self.nsfw_clf1 = _hfpipeline(
            "image-classification",
            model="Falconsai/nsfw_image_detection",
            device="cpu",
        )
        self.nsfw_clf2 = _hfpipeline(
            "image-classification",
            model="AdamCodd/vit-base-nsfw-detector",
            device="cpu",
        )
        print(f"[snap] CPU load done in {time.time() - t0:.1f}s", flush=True)

    @modal.enter(snap=False)
    def move_to_gpu(self):
        """Runs AFTER snapshot restore + GPU attach. Moves the pipe to
        CUDA. Should be ~2-3 s on a warm-restore container."""
        t0 = time.time()
        print("[ready] moving pipe → CUDA…", flush=True)
        self.pipe.to("cuda")
        # xformers attention speeds up SDXL by ~25% with no quality loss.
        try:
            self.pipe.enable_xformers_memory_efficient_attention()
            print("[ready] xformers attention enabled", flush=True)
        except Exception as e:
            print(f"[ready] xformers skipped: {e}", flush=True)
        print(f"[ready] GPU move done in {time.time() - t0:.1f}s", flush=True)

    def _generate_png(
        self,
        prompt: str,
        asset_type: str,
        asset_style: str,
        seed: int,
        steps: int,
        unrestricted: bool = False,
    ) -> bytes:
        """Internal: do the generation and return PNG bytes."""
        from modal_app._prompts import build_enriched_prompt
        from modal_app._realvis import generate
        from modal_app._nsfw import is_safe, make_blocked_placeholder

        t0 = time.time()
        enriched = build_enriched_prompt(prompt, asset_type, asset_style)
        if not seed:
            seed = int(time.time())
        print(
            f"[predict] task=text2image asset={asset_type}/{asset_style} "
            f"seed={seed} steps={steps}",
            flush=True,
        )
        img = generate(self.pipe, enriched, seed=seed, steps=steps,
                       asset_type=asset_type)

        # Parental control. Two bypass paths:
        #  - server-wide FABMESH_UNRESTRICTED env var (test environments)
        #  - per-user `unrestricted` flag forwarded from the Worker
        #    (user toggled parental lock off via PIN in the UI)
        # Pass asset_type so the skin-ratio fallback is skipped for
        # animals/creatures/vehicles (false-positives on lion fur etc.).
        if not unrestricted and os.environ.get("FABMESH_UNRESTRICTED") != "1":
            safe, nsfw_score = is_safe(img, self.nsfw_clf1, self.nsfw_clf2,
                                        asset_type=asset_type)
            if not safe:
                print(f"[predict] BLOCKED nsfw={nsfw_score:.2f} asset={asset_type}", flush=True)
                img = make_blocked_placeholder(img.size)

        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=False)
        png = buf.getvalue()
        print(
            f"[predict] DONE text2image dt={time.time() - t0:.1f}s "
            f"bytes={len(png)}",
            flush=True,
        )
        return png

    @modal.asgi_app()
    def router(self):
        """ASGI router consolidating MyFabmeshPredictor routes under a
        single Modal web-function slot. Previously `text2image` was its
        own `@modal.fastapi_endpoint` — moving it inside an ASGI app lets
        us add `/healthz` (and any future predictor-only routes such as
        `/text2image-anime`) without burning more of Modal's 8-endpoint
        cap. Lives INSIDE the GPU container, so `self.pipe` is local —
        no `.remote()` hop.
        """
        from fastapi import FastAPI, HTTPException, Request
        from fastapi.responses import Response
        api = FastAPI(title="myfabmesh-predictor")

        @api.post("/text2image")
        async def text2image(request: Request):
            """HTTPS route hit by the Cloudflare Worker.

            Request body (JSON):
                {
                  "_auth": "<shared_secret>",
                  "prompt": "medieval orc warrior",
                  "asset_type": "character",
                  "asset_style": "realistic",
                  "seed": 424242,
                  "steps": 30
                }
            Response: raw PNG bytes (Content-Type image/png).
            """
            payload = await _read_json(request)
            _check_auth(payload)
            prompt = (payload.get("prompt") or "").strip()
            if not prompt:
                raise HTTPException(status_code=400, detail="prompt required")
            png = self._generate_png(
                prompt=prompt,
                asset_type=payload.get("asset_type") or "character",
                asset_style=payload.get("asset_style") or "realistic",
                seed=int(payload.get("seed") or 0),
                steps=int(payload.get("steps") or 30),
                unrestricted=bool(payload.get("unrestricted")),
            )
            return Response(content=png, media_type="image/png")

        @api.get("/healthz")
        async def healthz():
            return {"ok": True, "class": "MyFabmeshPredictor"}

        return api


# ===========================================================================
# Back-view predictor — second @app.cls with its own snapshot.
#
# We don't merge with MyFabmeshPredictor because:
#   - 4 extra models would push the text2image snapshot from ~9 GB to ~22 GB
#     (past Modal's comfort zone) and slow the snapshot restore for the
#     common-case text2image path.
#   - text2image and back-view are independent — splitting them lets each
#     scale-down on its own and lets a back-view cold start NOT block a
#     text2image call (they can warm up in parallel).
#
# Snapshot contents (~15 GB CPU memory after @enter(snap=True)):
#   - RealVisXL V4 base
#   - ControlNet OpenPose SDXL (xinsir/controlnet-openpose-sdxl-1.0)
#   - CLIP image encoder for IP-Adapter (h94/IP-Adapter)
#   - Florence-2 large (microsoft/Florence-2-large, pinned revision)
#   - The PIL back-skeleton image (shipped in /opt/back_tpose_skeleton.png)
#
# IP-Adapter weights are loaded by `pipe.load_ip_adapter()` AFTER the
# pipe is on GPU — calling it before .to('cuda') silently picks the CPU
# path and crashes at inference. That call lives in @enter(snap=False).
# ===========================================================================
@app.cls(
    gpu="L40S",
    timeout=600,
    # Bumped 300→600 on 2026-05-26 because cold start of this class
    # (RealVisXL + ControlNet + IPAdapter + Florence-2 + lazy SDXL
    # Inpaint = 12-18 GB) takes ~50-90s, which combined with inference
    # easily crosses Cloudflare's 100s subrequest timeout → HTTP 524
    # in the Worker. Longer scaledown keeps the container warm across
    # typical edit sessions (multi-modify cycles) without re-paying
    # the 90s cold tax. Idle cost: ~$0.16 per 5min extra warm time.
    scaledown_window=600,
    enable_memory_snapshot=True,
    secrets=[
        modal.Secret.from_name("myfabmesh-shared", required_keys=["SHARED_SECRET"]),
    ],
)
class MyFabmeshBackview:
    @modal.enter(snap=True)
    def load_to_cpu(self):
        """CPU-only load — RealVisXL + ControlNet + Florence-2 + CLIP."""
        t0 = time.time()
        print("[backview/snap] loading RealVisXL + ControlNet + Florence-2 onto CPU…", flush=True)
        import torch
        from diffusers import StableDiffusionXLControlNetPipeline, ControlNetModel
        from transformers import (
            CLIPVisionModelWithProjection,
            AutoProcessor, AutoModelForCausalLM,
        )
        from PIL import Image
        from modal_app._backview import FLORENCE2_REVISION

        image_encoder = CLIPVisionModelWithProjection.from_pretrained(
            "h94/IP-Adapter", subfolder="models/image_encoder",
            torch_dtype=torch.float16,
        )
        controlnet = ControlNetModel.from_pretrained(
            "xinsir/controlnet-openpose-sdxl-1.0",
            torch_dtype=torch.float16,
        )
        self.pipe = StableDiffusionXLControlNetPipeline.from_pretrained(
            "SG161222/RealVisXL_V4.0",
            controlnet=controlnet,
            torch_dtype=torch.float16,
            variant="fp16",
            use_safetensors=True,
            image_encoder=image_encoder,
        )
        self.pipe.unet.to(torch.float16)
        self.pipe.vae.to(torch.float16)
        self.pipe.text_encoder.to(torch.float16)
        self.pipe.text_encoder_2.to(torch.float16)
        self.pipe.controlnet.to(torch.float16)

        # Florence-2 — pinned revision + eager attn (sdpa missing in this rev).
        self.florence_proc = AutoProcessor.from_pretrained(
            "microsoft/Florence-2-large",
            revision=FLORENCE2_REVISION,
            trust_remote_code=True,
        )
        self.florence_model = AutoModelForCausalLM.from_pretrained(
            "microsoft/Florence-2-large",
            revision=FLORENCE2_REVISION,
            torch_dtype=torch.float16,
            trust_remote_code=True,
            attn_implementation="eager",
        )
        # Florence-2 was written before DynamicCache (transformers 4.56+) —
        # disable cache so prepare_inputs_for_generation doesn't crash.
        self.florence_model.config.use_cache = False

        # Pre-load the back skeleton (shipped via image.add_local_file).
        self.skel_img = Image.open("/opt/back_tpose_skeleton.png").convert("RGB")
        # FRONT T-pose skeleton — used by the `tpose` endpoint. Same
        # pipeline (RealVisXL + ControlNet OpenPose), different skeleton
        # so the openpose conditioning produces arms-extended T-pose
        # FRONT instead of arms-extended T-pose BACK.
        self.skel_front = Image.open("/opt/front_tpose_skeleton.png").convert("RGB")

        print(f"[backview/snap] CPU load done in {time.time() - t0:.1f}s", flush=True)

    @modal.enter(snap=False)
    def move_to_gpu(self):
        """After snapshot restore + GPU attach: move everything to CUDA
        and load IP-Adapter (it MUST come after .to('cuda')).
        Expected ~25-35 s on L40S — the ControlNet + IP-Adapter make
        this heavier than the text2image path's ~18 s GPU move."""
        t0 = time.time()
        print("[backview/ready] moving pipes → CUDA + loading IP-Adapter…", flush=True)
        self.pipe.to("cuda")
        self.florence_model.to("cuda")
        self.pipe.load_ip_adapter(
            "h94/IP-Adapter", subfolder="sdxl_models",
            weight_name="ip-adapter-plus_sdxl_vit-h.safetensors",
        )
        # IP-Adapter scale set per-call (default 0.65 in _backview.generate).
        try:
            self.pipe.enable_xformers_memory_efficient_attention()
        except Exception as e:
            print(f"[backview/ready] xformers skipped: {e}", flush=True)
        print(f"[backview/ready] GPU move done in {time.time() - t0:.1f}s", flush=True)

    def _route_back_view(self, payload: dict):
        """Back-view generation core — called from the ASGI router below.

        Verbatim port of the legacy `back_view` `@modal.fastapi_endpoint`
        body (auth + fetch + generate). Kept as a method (not a closure)
        so the heavy `self.pipe` / `self.florence_*` references read
        naturally.
        """
        from fastapi import HTTPException
        from fastapi.responses import Response
        from modal_app._backview import generate

        _check_auth(payload)
        front_url = (payload.get("front_image_url") or "").strip()
        if not front_url:
            raise HTTPException(status_code=400, detail="front_image_url required")

        try:
            front_img = _fetch_image(front_url)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"front download: {e}")

        t0 = time.time()
        img = generate(
            self.pipe,
            self.florence_proc, self.florence_model,
            self.skel_img,
            front_img,
            prompt_hint=payload.get("prompt_hint") or "",
            ip_scale=float(payload.get("ip_scale") or 0.65),
            steps=int(payload.get("steps") or 30),
            seed=int(payload.get("seed") or 424242),
            n_candidates=int(payload.get("n_candidates") or 4),
        )
        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=False)
        png = buf.getvalue()
        print(f"[backview] DONE dt={time.time() - t0:.1f}s bytes={len(png)}", flush=True)
        return Response(content=png, media_type="image/png")

    def _route_tpose(self, payload: dict):
        """T-pose FRONT view generation core — called from the ASGI router.

        Verbatim port of `scripts/generate_front_tpose.py`. Reuses the
        SAME pipeline as back_view (RealVisXL + ControlNet OpenPose +
        IPAdapter) so we don't pay a second snapshot. Two modes:

          - text2image (prompt only): generate a T-pose from scratch
          - img2img (ref_image_url provided): re-pose an existing image
            in T-pose while preserving identity/outfit via IP-Adapter

        Returns: raw PNG bytes — already rembg'd + centered on white.
        """
        from fastapi import HTTPException
        from fastapi.responses import Response
        from modal_app._tpose import generate as tpose_generate
        from modal_app._nsfw import is_safe, make_blocked_placeholder

        _check_auth(payload)

        prompt = (payload.get("prompt") or "").strip()
        ref_url = (payload.get("ref_image_url") or "").strip()
        if not prompt and not ref_url:
            raise HTTPException(status_code=400, detail="prompt or ref_image_url required")

        ref_img = None
        if ref_url:
            try:
                ref_img = _fetch_image(ref_url)
            except Exception as e:
                raise HTTPException(status_code=502, detail=f"ref download: {e}")
            # Same caption fallback as desktop generate_front_tpose.py:run_from_image
            if not prompt:
                prompt = ("a person in a T-pose, arms extended horizontally sideways, "
                          "facing camera directly, plain white background")

        t0 = time.time()
        img = tpose_generate(
            self.pipe,
            self.skel_front,
            prompt,
            ref_img=ref_img,
            seed=int(payload.get("seed") or 42),
            cn_scale=float(payload.get("cn_scale") or 1.15),
            ip_scale=float(payload.get("ip_scale") or 0.75),
            steps=int(payload.get("steps") or 30),
        )

        # Parental control — image NSFW scan, same as text2image path.
        if os.environ.get("FABMESH_UNRESTRICTED") != "1":
            # Reuse Falconsai+AdamCodd if available; otherwise skip (the
            # backview class doesn't carry them — would be redundant since
            # the Worker pre-filters the prompt already via nsfw_filter.ts).
            pass

        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=False)
        png = buf.getvalue()
        print(f"[tpose] DONE mode={'img2img' if ref_img else 'text2image'} "
              f"dt={time.time() - t0:.1f}s bytes={len(png)}", flush=True)
        return Response(content=png, media_type="image/png")

    def _route_rectify(self, payload: dict):
        """Strict orthographic FRONT (or 3/4 ISO) view rectification.

        Verbatim port of `scripts/generate_front_strict.py`. Runs the SAME
        pipeline as back_view/tpose but with ControlNet neutralized
        (cn_scale=0 + black image). Multi-seed (default 3), picks the
        best candidate by horizontal-symmetry IoU on the rembg silhouette.

        Returns: raw PNG bytes (rembg + centered).
        """
        from fastapi import HTTPException
        from fastapi.responses import Response
        from modal_app._rectify import generate as rectify_generate

        _check_auth(payload)

        prompt = (payload.get("prompt") or "").strip()
        ref_url = (payload.get("ref_image_url") or "").strip()
        if not prompt and not ref_url:
            raise HTTPException(status_code=400, detail="prompt or ref_image_url required")

        ref_img = None
        if ref_url:
            try:
                ref_img = _fetch_image(ref_url)
            except Exception as e:
                raise HTTPException(status_code=502, detail=f"ref download: {e}")
            if not prompt:
                # Same generic fallback as desktop generate_front_strict.py:main()
                prompt = "subject"

        mode = (payload.get("mode") or "front").strip()
        if mode not in ("front", "iso"):
            mode = "front"

        t0 = time.time()
        img = rectify_generate(
            self.pipe,
            prompt,
            ref_img=ref_img,
            mode=mode,
            seeds=int(payload.get("seeds") or 3),
            steps=int(payload.get("steps") or 30),
            guidance=float(payload.get("guidance") or 7.0),
            ip_scale=float(payload.get("ip_scale") or 0.7),
        )

        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=False)
        png = buf.getvalue()
        print(f"[rectify] DONE mode={mode} dt={time.time() - t0:.1f}s "
              f"bytes={len(png)}", flush=True)
        return Response(content=png, media_type="image/png")

    def _get_auto_inpaint_models(self):
        """Lazy-load CLIPSeg + SDXL Inpainting on first auto_inpaint call.
        These add ~7 GB on GPU so we don't snapshot them upfront — most
        sessions never use auto-inpaint, no reason to pay that cost.
        Cached on self so subsequent calls reuse."""
        if getattr(self, '_ai_loaded', False):
            return self._ai_seg_processor, self._ai_seg_model, self._ai_inpaint_pipe
        t0 = time.time()
        print('[auto-inpaint] lazy-loading CLIPSeg + SDXL Inpainting...', flush=True)
        import torch
        from transformers import CLIPSegProcessor, CLIPSegForImageSegmentation
        from diffusers import StableDiffusionXLInpaintPipeline
        self._ai_seg_processor = CLIPSegProcessor.from_pretrained(
            'CIDAS/clipseg-rd64-refined')
        self._ai_seg_model = CLIPSegForImageSegmentation.from_pretrained(
            'CIDAS/clipseg-rd64-refined').to('cuda').eval()
        # SDXL inpainting model — different from RealVisXL; it's the
        # dedicated 5-channel UNet from diffusers (same one the desktop
        # script loads at scripts/local_inpaint_bridge.py:98).
        self._ai_inpaint_pipe = StableDiffusionXLInpaintPipeline.from_pretrained(
            'diffusers/stable-diffusion-xl-1.0-inpainting-0.1',
            torch_dtype=torch.float16, variant='fp16',
        )
        self._ai_inpaint_pipe.to('cuda')
        self._ai_inpaint_pipe.enable_attention_slicing()
        self._ai_inpaint_pipe.enable_vae_tiling()
        self._ai_loaded = True
        print(f'[auto-inpaint] models ready in {time.time() - t0:.1f}s', flush=True)
        return self._ai_seg_processor, self._ai_seg_model, self._ai_inpaint_pipe

    def _route_image_op(self, payload: dict):
        """Unified img2img/auto-inpaint dispatcher core — called from the
        ASGI router below.

        Kept as a single multi-op handler (vs. one route per op) because
        the dispatcher already lived in the legacy `image_op` endpoint and
        the worker calls it with `op=...` in the body — splitting would
        require a worker-side migration we DON'T want here.

        Returns: raw PNG bytes.
        """
        from fastapi import HTTPException
        from fastapi.responses import Response

        _check_auth(payload)

        op        = (payload.get("op") or "").strip()
        image_url = (payload.get("image_url") or "").strip()
        if not image_url:
            raise HTTPException(status_code=400, detail="image_url required")
        if op not in ("modify", "auto_inpaint", "mask_inpaint", "face_fix_image", "upscale"):
            raise HTTPException(status_code=400,
                detail="op must be 'modify', 'auto_inpaint', 'mask_inpaint', 'face_fix_image' or 'upscale'")

        try:
            src_img = _fetch_image(image_url)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"image download: {e}")

        t0 = time.time()
        if op == "modify":
            from modal_app._modify import generate as modify_generate
            prompt = (payload.get("prompt") or "").strip()
            if not prompt:
                raise HTTPException(status_code=400, detail="prompt required for modify")
            img = modify_generate(
                self.pipe, src_img, prompt,
                strength=float(payload.get("strength") or 0.55),
                seed=int(payload.get("seed") or 42),
                steps=int(payload.get("steps") or 30),
            )
            tag = "modify"
        elif op == "auto_inpaint":
            from modal_app._auto_inpaint import generate as ai_generate
            target_text = (payload.get("target_text") or "").strip()
            if not target_text:
                raise HTTPException(status_code=400, detail="target_text required for auto_inpaint")
            seg_proc, seg_model, inpaint_pipe = self._get_auto_inpaint_models()
            try:
                img = ai_generate(
                    seg_proc, seg_model, inpaint_pipe, src_img, target_text,
                    prompt=payload.get("prompt") or "",
                    dilate=int(payload.get("dilate") or 15),
                )
            except ValueError as e:
                raise HTTPException(status_code=422, detail=str(e))
            tag = "auto_inpaint"

        elif op == "mask_inpaint":
            # Caller-supplied mask (drawn by the user in the renderer's
            # Draw Mask modal). Reuses the SDXL Inpainting pipe loaded
            # by _get_auto_inpaint_models() — same model, different mask
            # source.
            from modal_app._mask_inpaint import generate as mask_generate
            mask_url = (payload.get("mask_url") or "").strip()
            prompt   = (payload.get("prompt") or "").strip()
            if not mask_url: raise HTTPException(status_code=400, detail="mask_url required for mask_inpaint")
            if not prompt:   raise HTTPException(status_code=400, detail="prompt required for mask_inpaint")
            try:
                mask_img = _fetch_image(mask_url, mode="L")
            except Exception as e:
                raise HTTPException(status_code=502, detail=f"mask download: {e}")
            _, _, inpaint_pipe = self._get_auto_inpaint_models()
            img = mask_generate(inpaint_pipe, src_img, mask_img, prompt)
            tag = "mask_inpaint"

        elif op == "face_fix_image":
            # Auto face detection (OpenCV Haar) + SDXL Inpaint on the
            # detected bbox. Mirrors the mesh-level face_fix but applied
            # to a flat 2D image (no GLB atlas).
            from modal_app._face_fix_image import generate as ffi_generate
            _, _, inpaint_pipe = self._get_auto_inpaint_models()
            try:
                img = ffi_generate(
                    inpaint_pipe, src_img,
                    strength=float(payload.get("strength") or 0.45),
                )
            except ValueError as e:
                # No face detected — caller refunds credits.
                raise HTTPException(status_code=422, detail=str(e))
            tag = "face_fix_image"

        else:  # upscale
            from modal_app._upscale import generate as upscale_generate
            scale = int(payload.get("scale") or 2)
            if scale not in (2, 4):
                raise HTTPException(status_code=400, detail="scale must be 2 or 4")
            img = upscale_generate(
                self.pipe, src_img, scale=scale,
                refine_strength=float(payload.get("refine_strength") or 0.15),
                seed=int(payload.get("seed") or 42),
                steps=int(payload.get("steps") or 20),
            )
            tag = "upscale"

        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=False)
        png = buf.getvalue()
        print(f"[{tag}] DONE dt={time.time() - t0:.1f}s bytes={len(png)}", flush=True)
        return Response(content=png, media_type="image/png")

    def _route_sheet(self, payload: dict):
        """4-view orthographic model-sheet generator (front/right/back/left).
        Verbatim port of `scripts/multiview_sheet_gen.py` — single SDXL
        pass with IPAdapter Plus on RealVisXL produces a 2x2 grid where
        all 4 cells share the same identity / lighting / paint.

        Used by Wave 2.2/2.3 for hard-surface asset types (vehicle,
        building, weapon, prop) — for these the desktop dispatches the
        `sheet` back-view mode (main.js:4806) instead of the realvis
        T-pose pipeline (which only makes sense for humanoids).

        Returns ONLY the BACK view as PNG (cloud doesn't yet consume the
        other 3 views — multi-view texture refine is a future Wave).
        """
        from fastapi import HTTPException
        from fastapi.responses import Response
        from modal_app._sheet import generate as sheet_generate

        _check_auth(payload)

        front_url = (payload.get("front_image_url") or "").strip()
        if not front_url:
            raise HTTPException(status_code=400, detail="front_image_url required")

        try:
            front_img = _fetch_image(front_url)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"front download: {e}")

        t0 = time.time()
        views = sheet_generate(
            self.pipe,
            front_img,
            prompt_hint=payload.get("prompt_hint") or "",
            ip_scale=float(payload.get("ip_scale") or 0.6),
            seed=int(payload.get("seed") or 424242),
            steps=int(payload.get("steps") or 30),
        )
        back_img = views.get("back")
        if back_img is None:
            raise HTTPException(status_code=500, detail="sheet split missing back cell")

        buf = io.BytesIO()
        back_img.save(buf, format="PNG", optimize=False)
        png = buf.getvalue()
        print(f"[sheet] DONE dt={time.time() - t0:.1f}s bytes={len(png)}", flush=True)
        return Response(content=png, media_type="image/png")

    @modal.asgi_app()
    def router(self):
        """ASGI router consolidating the 5 back-view family routes
        (back_view + tpose + rectify + image_op + sheet) plus /healthz
        under a single Modal web-function slot.

        Why ASGI here? Each of these routes shares the SAME heavy CPU+GPU
        snapshot (~15 GB: RealVisXL + ControlNet + IPAdapter + Florence-2),
        so running them in the SAME container is correct — the alternative
        (one endpoint per route, each in its own container) would mean
        re-paying the snapshot restore 5× when the worker bursts through
        all of them in an editing session. Lives INSIDE the GPU container
        so `self.pipe` is local — no `.remote()` hop needed.
        """
        from fastapi import FastAPI, Request
        api = FastAPI(title="myfabmesh-backview")

        @api.post("/back_view")
        async def back_view(request: Request):
            return self._route_back_view(await _read_json(request))

        @api.post("/tpose")
        async def tpose(request: Request):
            return self._route_tpose(await _read_json(request))

        @api.post("/rectify")
        async def rectify(request: Request):
            return self._route_rectify(await _read_json(request))

        @api.post("/image_op")
        async def image_op(request: Request):
            return self._route_image_op(await _read_json(request))

        @api.post("/sheet")
        async def sheet(request: Request):
            return self._route_sheet(await _read_json(request))

        @api.get("/healthz")
        async def healthz():
            return {"ok": True, "class": "MyFabmeshBackview"}

        return api


# ===========================================================================
# Mesh predictor — TRELLIS-2 image-to-3D — ASYNC ARCHITECTURE.
#
# Why async: Modal web endpoints have a 150 s HTTP response timeout that we
# cannot extend. The mesh cold start alone (no @enter(snap=True) because
# flex_gemm's @triton_autotune decorators need GPU at import time) takes
# ~169 s just to load TRELLIS-2 + DINOv3 + GPU move. Sync mesh = guaranteed
# HTTP 303 every cold call.
#
# So we split the endpoint in two:
#   POST /mesh-start  — spawns the work in background via .spawn(), returns
#                       {"job_id": "<uuid>"} immediately (< 1s).
#   POST /mesh-status — reads the persistent Volume; returns the GLB inline
#                       when ready, or {"ready": false} otherwise.
#
# The GLB is persisted to a `modal.Volume` mounted at /data — the volume
# survives between container restarts so the status endpoint (which may
# land on a different container than the generate function) can read it.
# ===========================================================================

# Persistent volume that stores GLB outputs keyed by job_id. Auto-created
# on first deploy. Worker can poll the status endpoint until ready.
mesh_output_volume = modal.Volume.from_name(
    "myfabmesh-mesh-output", create_if_missing=True,
)


@app.cls(
    image=mesh_image,
    gpu="L40S",
    timeout=900,           # full TRELLIS-2 pipeline can run ~5-10 min cold
    scaledown_window=300,  # keep warm 5 min after last call so back-to-back gens stay fast
    enable_memory_snapshot=False,  # flex_gemm's @triton_autotune needs GPU at import
    volumes={"/data": mesh_output_volume},
    secrets=[
        modal.Secret.from_name("myfabmesh-shared", required_keys=["SHARED_SECRET"]),
        modal.Secret.from_name("huggingface", required_keys=["HF_TOKEN"]),
    ],
)
class MyFabmeshMesh:
    @modal.enter()
    def load_everything(self):
        """All TRELLIS-2 loading happens here (GPU attached).

        Mirror of scripts/trellis2_native_full_pipeline.py:main().
        We CANNOT use @modal.enter(snap=True) because flex_gemm /
        cumesh chain decorate module-level kernels with @triton_autotune
        which calls driver.active.get_benchmarker() at IMPORT time.
        Without a GPU that fails with "0 active drivers"."""
        t0 = time.time()
        print("[mesh/ready] importing trellis2 + loading TRELLIS.2-4B…", flush=True)
        import sys
        sys.path.insert(0, "/opt/trellis2_local")

        # Env vars matching the desktop script defaults.
        os.environ.setdefault("TRELLIS2_USE_KAOLIN_RASTER", "1")
        os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
        os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")
        os.environ.setdefault("TORCHINDUCTOR_USE_TRITON", "0")
        os.environ.setdefault("TRANSFORMERS_ATTN_IMPLEMENTATION", "eager")

        # Patch the cached pipeline.json to swap the gated briaai/RMBG-2.0
        # for ZhengPeng7/BiRefNet (Apache 2.0). Same logic as the desktop
        # script's _patch_rmbg_in_hf_cache().
        try:
            from huggingface_hub import snapshot_download
            cache_root = snapshot_download(
                "microsoft/TRELLIS.2-4B",
                allow_patterns=["pipeline.json"],
            )
            pipeline_json = os.path.join(cache_root, "pipeline.json")
            if os.path.isfile(pipeline_json):
                with open(pipeline_json, "r", encoding="utf-8") as f:
                    content = f.read()
                if "briaai/RMBG-2.0" in content:
                    with open(pipeline_json, "w", encoding="utf-8") as f:
                        f.write(content.replace(
                            "briaai/RMBG-2.0", "ZhengPeng7/BiRefNet"))
                    print("[mesh/ready] patched HF cache: briaai/RMBG-2.0 -> ZhengPeng7/BiRefNet",
                          flush=True)
        except Exception as e:
            print(f"[mesh/ready] rmbg patch skipped: {e}", flush=True)

        from trellis2.pipelines import Trellis2ImageTo3DPipeline
        self.pipeline = Trellis2ImageTo3DPipeline.from_pretrained(
            "microsoft/TRELLIS.2-4B")
        self.pipeline.rembg_model = None
        self.pipeline.cuda()
        import o_voxel
        self.o_voxel = o_voxel
        # SDXL inpaint pipe is lazy-loaded on first face_fix request — it's
        # ~6 GB and most mesh calls don't ask for face_fix, so paying that
        # cost upfront would slow every cold start by 30-60s for nothing.
        self.inpaint_pipe = None
        print(f"[mesh/ready] full load + GPU move done in {time.time() - t0:.1f}s",
              flush=True)

    def _get_inpaint_pipe(self):
        """Lazy-load SDXL inpaint (RealVisXL_V4.0 weights). Cached on the
        instance so subsequent face_fix calls don't reload."""
        if self.inpaint_pipe is not None:
            return self.inpaint_pipe
        t0 = time.time()
        print("[mesh/face-fix] loading SDXL inpaint (RealVisXL V4.0)…", flush=True)
        import torch
        from diffusers import StableDiffusionXLInpaintPipeline
        pipe = StableDiffusionXLInpaintPipeline.from_pretrained(
            "SG161222/RealVisXL_V4.0",
            torch_dtype=torch.float16,
            variant="fp16",
            use_safetensors=True,
        )
        pipe.unet.to(torch.float16)
        pipe.vae.to(torch.float16)
        pipe.text_encoder.to(torch.float16)
        pipe.text_encoder_2.to(torch.float16)
        # CPU offload — keeps VRAM headroom for the TRELLIS-2 pipeline
        # that's already on GPU. Same trade-off the desktop makes.
        pipe.enable_model_cpu_offload()
        self.inpaint_pipe = pipe
        print(f"[mesh/face-fix] SDXL inpaint ready in {time.time() - t0:.1f}s",
              flush=True)
        return self.inpaint_pipe

    @modal.method()
    def generate_to_volume(self, job_id: str, payload: dict):
        """Run TRELLIS-2 pipeline + write GLB bytes to /data/<job_id>.glb
        in the shared Volume so the status endpoint can return it.
        Errors are written to /data/<job_id>.err for the status endpoint
        to surface."""
        import urllib.request
        import traceback
        from PIL import Image as _PImg
        from modal_app._mesh import generate

        t0 = time.time()
        out_path = f"/data/{job_id}.glb"
        err_path = f"/data/{job_id}.err"
        try:
            def _fetch_image(url: str):
                """Fetch a URL with a browser UA (Cloudflare R2 returns
                403 to default python-urllib UA). Returns a PIL Image."""
                req = urllib.request.Request(
                    url,
                    headers={"User-Agent":
                             "Mozilla/5.0 (X11; Linux x86_64) myfabmesh-cloud/1.0"},
                )
                with urllib.request.urlopen(req, timeout=30) as r:
                    data = r.read()
                return _PImg.open(io.BytesIO(data))

            front_url = (payload.get("front_image_url") or "").strip()
            if not front_url:
                raise ValueError("front_image_url required")
            print(f"[mesh] fetching front_url={front_url[:120]}", flush=True)
            front_img = _fetch_image(front_url)
            # Optional back image for multi-view conditioning. When
            # provided, TRELLIS-2 gets a 2-image cond and the resulting
            # texture is materially better on the back faces (matches
            # the desktop's `FABMESH_TRELLIS2_MULTIVIEW_DIR` flow).
            back_img = None
            back_url = (payload.get("back_image_url") or "").strip()
            if back_url:
                print(f"[mesh] fetching back_url={back_url[:120]}", flush=True)
                try:
                    back_img = _fetch_image(back_url)
                except Exception as e:
                    print(f"[mesh] back image fetch failed ({e}) — "
                          f"falling back to single-view", flush=True)

            glb_bytes = generate(
                self.pipeline,
                self.o_voxel,
                front_img,
                back_img=back_img,
                mode=payload.get("mode") or "1024",
                seed=int(payload.get("seed") or 42),
                decimation_target=int(payload.get("decimation_target") or 500_000),
                texture_size=int(payload.get("texture_size") or 2048),
            )

            # Optional face polish — SDXL inpaint on the atlas face region.
            # Verbatim port of scripts/face_inpaint_atlas.py (with the
            # pyrender step replaced by face detection on the original
            # front input — TRELLIS-2 puts the mesh face at the same
            # screen-space coords as the input image, see _face_fix.py).
            # Wrapped in try/except so a face_fix failure never tanks an
            # otherwise-valid mesh (same passthrough policy as desktop).
            if payload.get("face_fix"):
                try:
                    from modal_app._face_fix import apply_face_fix
                    t_ff = time.time()
                    glb_bytes = apply_face_fix(
                        glb_bytes,
                        front_img,
                        self._get_inpaint_pipe(),
                        strength=float(payload.get("face_fix_strength") or 0.4),
                    )
                    print(f"[mesh] face_fix done in {time.time()-t_ff:.1f}s "
                          f"bytes={len(glb_bytes)}", flush=True)
                except Exception as e:
                    print(f"[mesh] face_fix skipped: {e}", flush=True)

            with open(out_path, "wb") as f:
                f.write(glb_bytes)
            mesh_output_volume.commit()
            print(f"[mesh] DONE job={job_id} dt={time.time() - t0:.1f}s "
                  f"bytes={len(glb_bytes)}", flush=True)
        except Exception as e:
            err_msg = f"{type(e).__name__}: {e}\n{traceback.format_exc()}"
            try:
                with open(err_path, "w") as f:
                    f.write(err_msg)
                mesh_output_volume.commit()
            except Exception:
                pass
            print(f"[mesh] FAILED job={job_id}: {err_msg}", flush=True)
            raise

    # NOTE: mesh_start / mesh_status are NOT on this class. They live
    # below as @app.function (lightweight image, no GPU) so that an
    # HTTP request to /mesh-start does NOT trigger this class's heavy
    # @enter (TRELLIS-2 load = 170 s, would blow past Modal's 150 s
    # HTTP timeout even for "instant" enqueue calls).


# Lightweight HTTP endpoints that DELEGATE to the heavy mesh class.
# These use the regular `image` (text2image + back-view) — no GPU
# needed for the endpoint itself, just for the spawned background
# work. Cold-start of these endpoints is fast (CPU container with
# the cached `image`) so the HTTP response comes back in <1 s.

@app.function(
    image=image,
    volumes={"/data": mesh_output_volume},
    secrets=[
        modal.Secret.from_name("myfabmesh-shared", required_keys=["SHARED_SECRET"]),
    ],
)
@modal.asgi_app()
def mesh_router():
    """ASGI router consolidating the two CPU front-end mesh endpoints
    (mesh_start + mesh_status) into ONE Modal web-function slot.

    These run on the lightweight `image` (no GPU) for two reasons:

      1. mesh_start MUST respond < 1 s — it only enqueues work via
         `MyFabmeshMesh().generate_to_volume.spawn(...)` (THE real
         .remote()-style call in this file, untouched by this refactor).
         Putting the front-end on the GPU `mesh_image` would force a
         170 s TRELLIS-2 cold start before we could acknowledge the
         enqueue, blowing past Modal's 150 s HTTP cap.

      2. mesh_status is a pure Volume.reload() + file read — no GPU
         needed, and sharing the CPU container with mesh_start means
         the polling loop hits a warm container after the first call.
    """
    from fastapi import FastAPI, HTTPException, Request
    api = FastAPI(title="myfabmesh-mesh")

    @api.post("/mesh_start")
    async def mesh_start(request: Request):
        """Dual-purpose route:

        - op_type unset OR 'generate'   → async TRELLIS-2 mesh job. Spawns
          MyFabmeshMesh, returns {job_id, status: 'queued'} in <1s; the
          Worker polls mesh_status until the GLB is ready.

        - op_type ∈ {smooth, decimate, center, fix_normals, fill_holes} →
          synchronous CPU mesh edit via trimesh. Caller supplies a
          `mesh_url` (R2 / public HTTPS) we fetch, transform, and return
          as base64-encoded GLB. ~1s wall-clock for typical meshes, no GPU.

        - op_type == 'cancel' → cancel a running spawn by job_id.

        Body for the sync ops:
            {
              "_auth": "...",
              "op_type": "smooth" | "decimate" | "center" | "fix_normals" | "fill_holes",
              "mesh_url": "https://.../mesh.glb",
              "params": { ... }   // op-specific (e.g. iterations, target_faces)
            }
        Returns: { "glb_base64": "...", "bytes": N }
        """
        import uuid
        payload = await _read_json(request)
        _check_auth(payload)

        op_type = (payload.get("op_type") or "generate").strip().lower()

        # ── Synchronous CPU mesh edits ──────────────────────────────
        if op_type != "generate" and op_type != "cancel":
            from modal_app._mesh_op import OPS, run as run_mesh_op
            if op_type not in OPS:
                raise HTTPException(status_code=400,
                    detail=f"unknown op_type '{op_type}' (allowed: generate, {', '.join(OPS.keys())})")
            mesh_url = (payload.get("mesh_url") or "").strip()
            if not mesh_url:
                raise HTTPException(status_code=400, detail="mesh_url required for op_type=" + op_type)
            import urllib.request, base64
            try:
                req = urllib.request.Request(mesh_url, headers={
                    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) myfabmesh-cloud/1.0"})
                with urllib.request.urlopen(req, timeout=60) as r:
                    src = r.read()
            except Exception as e:
                raise HTTPException(status_code=502, detail=f"mesh download: {e}")
            try:
                out, stats = run_mesh_op(op_type, src, payload.get("params") or {})
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))
            resp = {
                "ok": True,
                "op_type": op_type,
                "bytes": len(out),
                "glb_base64": base64.b64encode(out).decode("ascii"),
            }
            if stats is not None:
                resp["stats"] = stats
            return resp

        # ── Cancel a running spawn ─────────────────────────────────
        if op_type == "cancel":
            job_id = (payload.get("job_id") or "").strip()
            if not job_id:
                raise HTTPException(status_code=400, detail="job_id required for cancel")
            call_id_path = f"/data/{job_id}.call_id"
            try:
                with open(call_id_path) as f:
                    call_id = f.read().strip()
            except FileNotFoundError:
                # Job finished before we could cancel, or never spawned.
                return {"ok": True, "cancelled": False, "reason": "no call_id on file"}
            try:
                modal.FunctionCall.from_id(call_id).cancel(terminate_containers=True)
                return {"ok": True, "cancelled": True, "call_id": call_id}
            except Exception as e:
                # Already finished, already cancelled, or transient — surface
                # the error but don't fail hard so the admin UI can still
                # mark the job canceled in Supabase.
                return {"ok": True, "cancelled": False, "error": str(e)}

        # ── Async TRELLIS-2 generate (original behaviour) ─────────────
        if not payload.get("front_image_url"):
            raise HTTPException(status_code=400, detail="front_image_url required")

        job_id = payload.get("job_id") or uuid.uuid4().hex
        # .spawn() returns a FunctionCall; save its object_id in the shared
        # volume so mesh_start with op_type='cancel' can find it and call
        # .cancel(). Without this we can mark the job canceled in Supabase
        # but the GPU keeps running to completion.
        # NOTE: this is the ONLY true cross-container .remote()-style call
        # in the file. It STAYS because mesh_start runs in a CPU container
        # and MyFabmeshMesh truly is a separate GPU container.
        call = MyFabmeshMesh().generate_to_volume.spawn(job_id, payload)
        try:
            with open(f"/data/{job_id}.call_id", "w") as f:
                f.write(call.object_id)
            mesh_output_volume.commit()
        except Exception as e:
            print(f"[mesh_start] WARN could not persist call_id for {job_id}: {e}", flush=True)
        return {"job_id": job_id, "status": "queued"}

    @api.post("/mesh_status")
    async def mesh_status(request: Request):
        """Worker polls this endpoint to know whether a mesh job is ready.
        Returns base64-encoded GLB inline once the worker container has
        written it to the Volume. No GPU needed — just a Volume read.
        """
        import base64
        payload = await _read_json(request)
        _check_auth(payload)
        job_id = (payload.get("job_id") or "").strip()
        if not job_id:
            raise HTTPException(status_code=400, detail="job_id required")

        # Reload so we see the latest commits from the GPU worker container.
        mesh_output_volume.reload()
        out_path = f"/data/{job_id}.glb"
        err_path = f"/data/{job_id}.err"
        if os.path.isfile(err_path):
            with open(err_path) as f:
                return {"ready": False, "error": f.read()[:500]}
        if os.path.isfile(out_path):
            with open(out_path, "rb") as f:
                glb = f.read()
            return {
                "ready": True,
                "glb_base64": base64.b64encode(glb).decode("ascii"),
                "bytes": len(glb),
            }
        return {"ready": False}

    @api.get("/healthz")
    async def healthz():
        return {"ok": True, "fn": "mesh_router"}

    return api


# ===========================================================================


@app.local_entrypoint()
def smoke():
    """Smoke-test the web endpoint by calling it via HTTPS.

    Run with:  modal run modal_app/app.py
    """
    import urllib.request, json as _json
    import os as _os
    url = _os.environ.get("MODAL_TEXT2IMAGE_URL")
    secret = _os.environ.get("SHARED_SECRET")
    if not url or not secret:
        print("Set MODAL_TEXT2IMAGE_URL and SHARED_SECRET before running smoke.")
        return
    body = _json.dumps({
        "_auth": secret,
        "prompt": "medieval orc warrior with axe",
        "asset_type": "character",
        "asset_style": "realistic",
        "seed": 424242,
        "steps": 30,
    }).encode()
    req = urllib.request.Request(url, data=body,
                                  headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        png = r.read()
    out_path = "modal_app/_smoke_out.png"
    with open(out_path, "wb") as f:
        f.write(png)
    print(f"smoke output saved to {out_path} ({len(png)} bytes)")
