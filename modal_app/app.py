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
    .add_local_python_source("modal_app")
    .add_local_file(
        "modal_app/back_tpose_skeleton.png",
        remote_path="/opt/back_tpose_skeleton.png",
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
    )
    # cumesh and flex-gemm pip packages have torch>=2.5 declared deps
    # which silently upgrade torch and break the torchvision ABI baked
    # earlier. The desktop fork doesn't seem to need them at import time
    # (it imports lazily) so we skip those packages here. If a runtime
    # call needs them we'll add them back gated.
    #
    # Final torch pin: cumesh/o-voxel installs (when run from the fork)
    # may also upgrade torch — force it back to 2.4.1 + torchvision 0.19.1.
    # The CUDA .so binaries built above were compiled against torch 2.4,
    # so downgrading the Python torch module leaves them functional.
    .run_commands(
        "pip install --force-reinstall --no-deps "
        "torch==2.4.1 torchvision==0.19.1 "
        "--index-url https://download.pytorch.org/whl/cu124",
        # FINAL GUARD — torch --force-reinstall + the o-voxel install
        # above are the steps most likely to clobber transformers.
        # Re-verify the import works at the END of all build steps so
        # any regression fails the build, not the runtime.
        "python -c \"import transformers; "
        "assert transformers.__version__.startswith('4.56'), "
        "'transformers got downgraded to '+transformers.__version__; "
        "from transformers import DINOv3ViTModel; "
        "print('FINAL transformers', transformers.__version__, 'DINOv3ViTModel OK')\"",
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
    scaledown_window=30,
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
        img = generate(self.pipe, enriched, seed=seed, steps=steps)

        # Parental control — matches desktop policy (FABMESH_UNRESTRICTED
        # env var bypass).
        if os.environ.get("FABMESH_UNRESTRICTED") != "1":
            safe, nsfw_score = is_safe(img, self.nsfw_clf1, self.nsfw_clf2)
            if not safe:
                print(f"[predict] BLOCKED nsfw={nsfw_score:.2f}", flush=True)
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

    @modal.fastapi_endpoint(method="POST")
    def text2image(self, payload: dict):
        """HTTPS endpoint hit by the Cloudflare Worker.

        Request body (JSON):
            {
              "prompt": "medieval orc warrior",
              "asset_type": "character",
              "asset_style": "realistic",
              "seed": 424242,
              "steps": 30
            }
        Auth: Authorization: Bearer <SHARED_SECRET> (env on Modal side).
        Response: raw PNG bytes (Content-Type image/png).
        """
        from fastapi import HTTPException, Request
        from fastapi.responses import Response

        # Auth check — the secret is injected by modal.Secret.from_name.
        # The Worker MUST send this header; without it we 401 immediately.
        # (FastAPI gives us the request via dependency injection — but
        # since we're decorated with @fastapi_endpoint and have no Request
        # param, we read the header from a Modal-provided context.)
        # Modal's web endpoints expose the raw request via modal.current_input_id
        # and similar; the easier path is to keep auth simple: the Worker
        # passes the secret IN the body too.
        expected = os.environ.get("SHARED_SECRET", "")
        provided = (payload.get("_auth") or "").strip()
        if not expected or provided != expected:
            raise HTTPException(status_code=401, detail="auth")

        prompt = (payload.get("prompt") or "").strip()
        if not prompt:
            raise HTTPException(status_code=400, detail="prompt required")
        png = self._generate_png(
            prompt=prompt,
            asset_type=payload.get("asset_type") or "character",
            asset_style=payload.get("asset_style") or "realistic",
            seed=int(payload.get("seed") or 0),
            steps=int(payload.get("steps") or 30),
        )
        return Response(content=png, media_type="image/png")


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
    scaledown_window=30,
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

    @modal.fastapi_endpoint(method="POST")
    def back_view(self, payload: dict):
        """HTTPS endpoint for back-view generation.

        Request body (JSON):
            {
              "_auth": "<shared_secret>",
              "front_image_url": "https://.../front.png",
              "prompt_hint": "wearing red robe",  // optional
              "ip_scale": 0.65,                   // optional
              "steps": 30,                        // optional
              "seed": 424242,                     // optional
              "n_candidates": 4                   // optional
            }
        Response: raw PNG bytes (the best of N candidates by outfit color).
        """
        from fastapi import HTTPException
        from fastapi.responses import Response
        import urllib.request
        from PIL import Image
        from modal_app._backview import generate

        expected = os.environ.get("SHARED_SECRET", "")
        provided = (payload.get("_auth") or "").strip()
        if not expected or provided != expected:
            raise HTTPException(status_code=401, detail="auth")

        front_url = (payload.get("front_image_url") or "").strip()
        if not front_url:
            raise HTTPException(status_code=400, detail="front_image_url required")

        # Pull the front image (R2 public URL or any HTTPS URL).
        try:
            with urllib.request.urlopen(front_url, timeout=30) as r:
                front_bytes = r.read()
            front_img = Image.open(io.BytesIO(front_bytes)).convert("RGB")
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


# ===========================================================================
# Mesh predictor — TRELLIS-2 image-to-3D.
#
# POC scope: replace the Replicate `fishwowater/trellis2` model with our
# own Modal-hosted TRELLIS-2 4B. License: MIT (microsoft/TRELLIS.2-4B
# weights, microsoft/TRELLIS.2 source) → redistribution-safe.
#
# CRITICAL RISK: TRELLIS-2 uses custom CUDA kernels that may compile on
# first `.cuda()` call. Memory Snapshots only capture CPU memory. If
# compilation dominates the cold start, the gain over Replicate
# disappears (we expected ~$0.10/mesh on Modal vs $0.50 on Replicate;
# if compilation adds 60-90s per cold start, the cost climbs to $0.15+
# and UX gets worse). We measure on the smoke test and decide.
# ===========================================================================
@app.cls(
    image=mesh_image,
    gpu="L40S",
    timeout=900,           # mesh inference can take 60-90s on L40S
    scaledown_window=30,
    enable_memory_snapshot=True,
    secrets=[
        modal.Secret.from_name("myfabmesh-shared", required_keys=["SHARED_SECRET"]),
    ],
)
class MyFabmeshMesh:
    @modal.enter(snap=True)
    def load_to_cpu(self):
        """CPU-only load of the TRELLIS-2 pipeline (weights → CPU).
        Custom CUDA kernels are NOT compiled here (no .cuda() yet) —
        they'll compile on first GPU use in @modal.enter(snap=False)."""
        t0 = time.time()
        print("[mesh/snap] importing trellis2 + loading TRELLIS.2-4B onto CPU…", flush=True)
        import sys
        # The TRELLIS-2 source tree lives at /opt/trellis2_local — the
        # DESKTOP fork (external/TRELLIS2_win/src) shipped into the
        # image via add_local_dir. Put it on sys.path so
        # `from trellis2.pipelines import …` resolves to the desktop's
        # exact code (1:1 parity with what runs on the user's RTX).
        sys.path.insert(0, "/opt/trellis2_local")
        # Mirror the env defaults set by desktop's
        # trellis2_native_full_pipeline.py (some are required for the
        # internal Kaolin shim and disable TorchDynamo / Inductor).
        os.environ.setdefault("TRELLIS2_USE_KAOLIN_RASTER", "1")
        os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
        os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")
        os.environ.setdefault("TORCHINDUCTOR_USE_TRITON", "0")
        os.environ.setdefault("TRANSFORMERS_ATTN_IMPLEMENTATION", "eager")

        from trellis2.pipelines import Trellis2ImageTo3DPipeline
        self.pipeline = Trellis2ImageTo3DPipeline.from_pretrained(
            "microsoft/TRELLIS.2-4B")
        # The pipeline's internal rembg uses gated briaai/RMBG-2.0 —
        # we replace it by rembg u2net upstream (in _mesh.prep_image).
        self.pipeline.rembg_model = None
        print(f"[mesh/snap] CPU load done in {time.time() - t0:.1f}s", flush=True)

    @modal.enter(snap=False)
    def move_to_gpu(self):
        """After snapshot restore + GPU attach: move pipeline to CUDA.
        First time this runs the custom CUDA kernels JIT-compile —
        watch the log to see how long this takes."""
        t0 = time.time()
        print("[mesh/ready] moving TRELLIS-2 pipeline → CUDA…", flush=True)
        self.pipeline.cuda()
        # Import o_voxel here (it's a separate module from the pipeline).
        import o_voxel
        self.o_voxel = o_voxel
        print(f"[mesh/ready] GPU move + compile done in {time.time() - t0:.1f}s", flush=True)

    @modal.fastapi_endpoint(method="POST")
    def mesh(self, payload: dict):
        """HTTPS endpoint for image-to-3D mesh generation.

        Request body (JSON):
            {
              "_auth": "<shared_secret>",
              "front_image_url": "https://.../front.png",
              "mode": "1024",         // 512 | 1024 | 1024_cascade
              "seed": 42,
              "decimation_target": 500000,
              "texture_size": 2048
            }
        Response: raw GLB bytes (Content-Type model/gltf-binary).
        """
        from fastapi import HTTPException
        from fastapi.responses import Response
        import urllib.request
        from PIL import Image
        from modal_app._mesh import generate

        expected = os.environ.get("SHARED_SECRET", "")
        provided = (payload.get("_auth") or "").strip()
        if not expected or provided != expected:
            raise HTTPException(status_code=401, detail="auth")

        front_url = (payload.get("front_image_url") or "").strip()
        if not front_url:
            raise HTTPException(status_code=400, detail="front_image_url required")

        try:
            with urllib.request.urlopen(front_url, timeout=30) as r:
                front_bytes = r.read()
            front_img = Image.open(io.BytesIO(front_bytes))
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"front download: {e}")

        t0 = time.time()
        glb_bytes = generate(
            self.pipeline,
            self.o_voxel,
            front_img,
            mode=payload.get("mode") or "1024",
            seed=int(payload.get("seed") or 42),
            decimation_target=int(payload.get("decimation_target") or 500_000),
            texture_size=int(payload.get("texture_size") or 2048),
        )
        print(f"[mesh] TOTAL dt={time.time() - t0:.1f}s bytes={len(glb_bytes)}", flush=True)
        return Response(content=glb_bytes, media_type="model/gltf-binary")


# ---------------------------------------------------------------------------
# Local dev convenience: run a smoke prediction from your machine via
#   modal run modal_app/app.py
# ---------------------------------------------------------------------------
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
