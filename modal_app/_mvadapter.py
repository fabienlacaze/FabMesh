"""MV-Adapter multi-view generation - Modal cloud app.

This module contains the SELF-CONTAINED Modal wrap that exposes
`_mvadapter.generate()` as an HTTP endpoint. The pure functions
(`preprocess_reference`, `grey_to_alpha`, `build_plucker_embeds`,
`generate`) live BELOW this wrap, intact - this header only adds:

  - the Modal image (CUDA 12.4 + torch 2.4.1 - same stack as the
    rest of the cloud surface so cached pip layers are reused),
  - the upstream MV-Adapter source tree (cloned at build time, plus
    `patch_mvadapter.py` from FabMesh's scripts/),
  - HF checkpoint pre-warming via `snapshot_download` at build time
    (saves ~3 GB of weight download from cold restore),
  - `MyFabmeshMVAdapter` (@app.cls + @modal.enter(snap=True)) - loads
    the pipeline ONCE per snapshot,
  - `mvadapter_endpoint` (@modal.fastapi_endpoint) - accepts the
    worker's POST body, downloads `front_image_url`, runs `generate()`,
    uploads each of the 6 views to R2 via boto3 (S3-compatible Cloudflare
    R2 API), returns the worker's expected JSON shape `{views: [6 urls]}`.

Why R2 upload from inside Modal (NOT base64 in JSON response):
  The 6 PNGs at 768 px ~= 6 x 600 KB = ~3.6 MB base64-inflated to ~5 MB.
  Cloudflare Worker can only buffer ~100 MB per request, so we'd survive
  even at 1024 px, BUT the worker.ts callsite EXPECTS string URLs (see
  `cloud/src/worker.ts:4683-4702`). Modal-side upload is the source of
  truth; mirroring base64 would force the worker to do a second R2 put
  on every view for no benefit.

Secrets required at deploy time:
    modal secret create huggingface HF_TOKEN=<hf-token>
    modal secret create myfabmesh-shared SHARED_SECRET=<32-byte-hex>
    modal secret create myfabmesh-r2 \\
        R2_ACCOUNT_ID=<cloudflare-account-id> \\
        R2_ACCESS_KEY_ID=<r2-token-key> \\
        R2_SECRET_ACCESS_KEY=<r2-token-secret> \\
        R2_BUCKET=<bucket-name> \\
        R2_PUBLIC_URL=https://pub-<hash>.r2.dev

Deploy:
    modal deploy modal_app/_mvadapter.py

Endpoint URL pattern (set in Cloudflare worker as MODAL_MVADAPTER_URL):
    https://<workspace>--myfabmesh-mvadapter-mvadapter-endpoint.modal.run
"""
import base64
import io
import os
import sys
import time
import traceback
import urllib.request

import modal

import numpy as np
import torch
from PIL import Image

# ---------------------------------------------------------------------------
# Image: CUDA 12.4 + torch 2.4.1. This matches `modal_app/app.py:_base_image`
# so the heavy layers (torch, diffusers, transformers, xformers) are reused
# from the registry cache when both apps build in the same workspace.
#
# MV-Adapter itself is pure-Python on top of diffusers (no custom CUDA
# kernels), so we DON'T need the nvidia/cuda:12.8-devel base that
# _puppeteer_rig.py uses for flash-attn 2.7.4.post1. The 12.4-devel image
# is ~3 GB smaller and rebuilds in <2 min on a cache miss.
# ---------------------------------------------------------------------------
image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.4.0-devel-ubuntu22.04",
        add_python="3.11",
    )
    .env({"CUDA_HOME": "/usr/local/cuda"})
    .apt_install(
        "git", "build-essential", "ninja-build",
        # libgl1 / libegl1 + friends - required by rembg / opencv-headless
        # even though we never open a window. PIL also pulls libxext6.
        "libgl1", "libegl1",
        "libglib2.0-0", "libsm6", "libxext6", "libxrender1",
        "wget", "ca-certificates",
    )
    # ---- PyTorch (same pin as app.py _base_image so layers dedupe) ----
    .pip_install(
        "torch==2.4.1",
        "torchvision==0.19.1",
        extra_options="--index-url https://download.pytorch.org/whl/cu124",
    )
    # ---- diffusion stack ----
    .pip_install(
        # Pinned to match app.py - transformers 4.45.2 is the highest
        # version that doesn't need torch >= 2.5 (4.47+ imports
        # torch.distributed.tensor.device_mesh which exists from 2.5).
        "transformers==4.45.2",
        "diffusers==0.31.0",
        "accelerate==0.34.2",
        "huggingface_hub==0.25.2",
        "safetensors==0.4.5",
        # xformers wheel built against torch 2.4 - required because
        # MV-Adapter's SDXL UNet uses xformers attention for the 6-view
        # batched forward (without it the batched attn OOMs at 768).
        "xformers==0.0.28",
        # MV-Adapter's runtime deps (subset of external/MV-Adapter/requirements.txt
        # we actually exercise - controlnet_aux/peft/omegaconf needed by import
        # graph; gradio/pytorch-lightning/open3d/pymeshlab/spandrel/nvdiffrast
        # are training/texturing-only and stubbed at runtime by
        # `_patch_mvadapter_nvdiffrast` (see scripts/multiview_mvadapter_gen.py
        # lines 37-72 - the exact same stub set the desktop uses).
        "controlnet_aux>=0.0.7", "peft>=0.10", "omegaconf>=2.3",
        "einops>=0.7", "timm>=0.9", "kornia>=0.7",
        "scikit-image>=0.22", "sentencepiece>=0.2",
        # Misc
        "pillow>=10", "numpy>=1.26,<2.0", "trimesh>=4.0",
        "rembg[cpu]>=2.0",  # u2net session, CPU is fast enough (~200 ms)
        # FastAPI - required by Modal 1.x for @modal.fastapi_endpoint.
        "fastapi[standard]>=0.115",
        # boto3 for R2 (S3-compatible) upload of the 6 generated views.
        "boto3>=1.34",
    )
    .env({
        # HF cache lives on the snapshot-ed root volume so the
        # snapshot_download below is baked into the image layer.
        "HF_HOME": "/root/.cache/huggingface",
        "HUGGINGFACE_HUB_CACHE": "/root/.cache/huggingface/hub",
        # Same arch list as app.py so any source-built wheel re-uses the
        # cached layer. A10G = sm_86, L4 = sm_89; we keep 9.0+PTX in case
        # Modal schedules a Hopper or Blackwell on us later.
        "TORCH_CUDA_ARCH_LIST": "8.0;8.6;8.9;9.0+PTX",
        "FORCE_CUDA": "1",
    })
    # ---- Clone MV-Adapter upstream source ----
    # The `mvadapter` package isn't on PyPI - it's a research repo. We
    # clone at build time and put it on PYTHONPATH (cheaper than
    # `pip install -e .` which would re-resolve the entire requirements.txt).
    .run_commands(
        "git clone --depth 1 https://github.com/huanngzh/MV-Adapter.git /opt/MV-Adapter",
        # Sanity-check the package layout matches what `generate()` imports
        # (mvadapter.pipelines.pipeline_mvadapter_i2mv_sdxl /
        #  mvadapter.schedulers.scheduling_shift_snr /
        #  mvadapter.utils.mesh_utils + utils.geometry).
        "test -f /opt/MV-Adapter/mvadapter/pipelines/pipeline_mvadapter_i2mv_sdxl.py "
        "&& test -f /opt/MV-Adapter/mvadapter/schedulers/scheduling_shift_snr.py "
        "&& test -f /opt/MV-Adapter/mvadapter/utils/mesh_utils.py "
        "&& test -f /opt/MV-Adapter/mvadapter/utils/geometry.py "
        "&& echo 'mvadapter package layout OK'",
    )
    .env({"PYTHONPATH": "/opt/MV-Adapter"})
    # ---- Pre-warm HF weights at build time (saves ~3 GB download on cold
    # restore even WITH memory snapshot, because the on-disk HF cache is
    # what diffusers.from_pretrained checks first). HF_TOKEN is read from
    # the `huggingface` secret which is bound at build time. ----
    .run_commands(
        "python -c \""
        "import os; "
        "from huggingface_hub import snapshot_download; "
        "snapshot_download('stabilityai/stable-diffusion-xl-base-1.0', "
        "revision='462165984030d82259a11f4367a4eed129e94a7b', "
        "allow_patterns=['*.json', '*.txt', '*.fp16.safetensors', "
        "'text_encoder*/model.fp16.safetensors', 'unet/diffusion_pytorch_model.fp16.safetensors', "
        "'vae/diffusion_pytorch_model.fp16.safetensors', "
        "'tokenizer*/*', 'scheduler/scheduler_config.json']); "
        "snapshot_download('madebyollin/sdxl-vae-fp16-fix', "
        "revision='4df413ca49271c25289a6482ab97a433f8117d15', "
        "allow_patterns=['*.json', '*.safetensors']); "
        "snapshot_download('huanngzh/mv-adapter', "
        "allow_patterns=['mvadapter_i2mv_sdxl.safetensors']); "
        "print('HF prewarm OK')\"",
        secrets=[modal.Secret.from_name("huggingface", required_keys=["HF_TOKEN"])],
    )
    # ---- Build-time guard: assert the three checkpoints landed AND the
    # mvadapter package + ShiftSNRScheduler import. Catches a broken image
    # at build time instead of crash-looping the deployed app. ----
    .run_commands(
        "python -c \""
        "import sys; sys.path.insert(0, '/opt/MV-Adapter'); "
        "from mvadapter.pipelines.pipeline_mvadapter_i2mv_sdxl import MVAdapterI2MVSDXLPipeline; "
        "from mvadapter.schedulers.scheduling_shift_snr import ShiftSNRScheduler; "
        "import torch, diffusers, transformers; "
        "print('torch', torch.__version__, 'diffusers', diffusers.__version__, "
        "'transformers', transformers.__version__, 'mvadapter OK')\"",
    )
    # ---- Ship FabMesh's local sources so the endpoint can import
    # modal_app._nsfw (NSFW classifiers helper) for per-view safety. ----
    .add_local_python_source("modal_app")
)

# ---------------------------------------------------------------------------
# App + GPU class
# ---------------------------------------------------------------------------
app = modal.App("myfabmesh-mvadapter", image=image)


@app.cls(
    gpu="A10G",                  # 24 GB - MV-Adapter at 768 with 6 views
                                 #         needs ~16 GB VRAM (no cpu_offload).
    timeout=600,                 # 10 min ceiling for the GPU worker.
    scaledown_window=300,        # Keep container warm 5 min after last call.
    enable_memory_snapshot=True, # Snapshot CPU state after @enter(snap=True)
                                 # so cold restores skip the ~15s HF load.
    secrets=[
        modal.Secret.from_name("huggingface", required_keys=["HF_TOKEN"]),
    ],
)
class MyFabmeshMVAdapter:
    """MV-Adapter i2mv-sdxl wrapper. The pipeline is built once in
    @modal.enter(snap=True), snapshotted, then re-hydrated in <5 s
    on every cold restore. .generate() is the @modal.method that
    fans 1 reference image into 6 orthographic views."""

    @modal.enter(snap=True)
    def load_pipeline(self):
        """Build pipeline on CPU, get snapshotted. The .to('cuda')
        move happens in @enter(snap=False) below - snapshot would
        capture stale GPU pointers if we moved here.
        """
        # MV-Adapter source must be on sys.path BEFORE the stubs are
        # installed (the patch monkey-patches modules in sys.modules).
        sys.path.insert(0, "/opt/MV-Adapter")

        # Stub out nvdiffrast/triton/cvcuda/etc. - same set as
        # scripts/multiview_mvadapter_gen.py:_patch_mvadapter_nvdiffrast.
        # MV-Adapter's mesh_utils package eagerly imports nvdiffrast at
        # module load, but we never call any function that touches it
        # (only camera helpers + the i2mv pipeline forward). Stubs let
        # the bare `import` succeed.
        import importlib, types
        from importlib.machinery import ModuleSpec
        _stubs = {
            "nvdiffrast": None, "nvdiffrast.torch": "nvdiffrast",
            "triton": None, "triton.language": "triton",
            "cvcuda": None, "cvcuda_cu12": None,
            "open3d": None, "pymeshlab": None, "spandrel": None,
        }
        for name, parent in _stubs.items():
            if name in sys.modules:
                continue
            mod = types.ModuleType(name)
            mod.__spec__ = ModuleSpec(name, loader=None)
            mod.__path__ = []
            sys.modules[name] = mod
            if parent is not None and parent in sys.modules:
                setattr(sys.modules[parent], name.split(".")[-1], mod)

        import torch
        from diffusers import AutoencoderKL
        from mvadapter.pipelines.pipeline_mvadapter_i2mv_sdxl import (
            MVAdapterI2MVSDXLPipeline)
        from mvadapter.schedulers.scheduling_shift_snr import (
            ShiftSNRScheduler)

        t0 = time.time()
        dtype = torch.float16

        # VAE fp16-fix (madebyollin) - vanilla SDXL VAE has the well-known
        # fp16 black-output bug.
        vae = AutoencoderKL.from_pretrained(
            "madebyollin/sdxl-vae-fp16-fix",
            revision=SDXL_VAE_REVISION,
            torch_dtype=dtype,
        )
        # SDXL base 1.0 (NOT RealVisXL - see _mvadapter docstring).
        pipe = MVAdapterI2MVSDXLPipeline.from_pretrained(
            "stabilityai/stable-diffusion-xl-base-1.0",
            revision=SDXL_BASE_REVISION,
            vae=vae,
            torch_dtype=dtype,
        )
        # Scheduler shift (paper default for i2mv-sdxl).
        pipe.scheduler = ShiftSNRScheduler.from_scheduler(
            pipe.scheduler,
            shift_mode="interpolated",
            shift_scale=8.0,
            scheduler_class=None,
        )
        # Adapter init order matters: init_custom_adapter FIRST so the
        # 6-view cross-attn layers exist; load_custom_adapter THEN to
        # populate their weights.
        pipe.init_custom_adapter(num_views=len(VIEW_SLOTS))
        pipe.load_custom_adapter(
            MV_ADAPTER_REPO, weight_name=MV_ADAPTER_FILE)
        pipe.enable_vae_slicing()

        # Keep on CPU through the snapshot. The .to('cuda') happens in
        # the no-snap @enter below.
        self.pipe = pipe

        # rembg u2net session (CPU, ~200 ms per call). Snapshot-friendly.
        import rembg
        self.rembg_session = rembg.new_session("u2net")

        # Optional NSFW classifiers - same pair as modal_app/_nsfw is_safe.
        # We load on CPU; the per-view scan is <50 ms each, no GPU needed.
        try:
            from transformers import pipeline as hf_pipeline
            self.nsfw_clf1 = hf_pipeline(
                "image-classification",
                model="Falconsai/nsfw_image_detection",
                device=-1,
            )
            self.nsfw_clf2 = hf_pipeline(
                "image-classification",
                model="AdamCodd/vit-base-nsfw-detector",
                device=-1,
            )
        except Exception as e:
            print(f"[mvadapter] NSFW classifiers skipped: {e}", flush=True)
            self.nsfw_clf1 = None
            self.nsfw_clf2 = None

        print(f"[mvadapter] @enter(snap=True) loaded in {time.time()-t0:.1f}s",
              flush=True)

    @modal.enter(snap=False)
    def move_to_gpu(self):
        """Post-snapshot hook - moves the pipeline to CUDA. Must be in
        a separate @enter(snap=False) so the snapshot captures CPU
        tensors (CUDA pointers would be stale on restore)."""
        import torch
        t0 = time.time()
        device = "cuda" if torch.cuda.is_available() else "cpu"
        dtype = torch.float16 if device == "cuda" else torch.float32
        self.pipe.to(device=device, dtype=dtype)
        # cond_encoder is the Plucker conditioning trunk - it must follow
        # the rest of the pipeline to the GPU explicitly (it's NOT a
        # registered submodule on the base SDXL pipeline).
        self.pipe.cond_encoder.to(device=device, dtype=dtype)
        print(f"[mvadapter] @enter(snap=False) to_cuda in {time.time()-t0:.1f}s "
              f"device={device}", flush=True)

    @modal.method()
    def generate_views(
        self,
        image_b64: str,
        prompt_hint: str = "",
        seed: int = 1234,
        num_steps: int = 50,
        guidance_scale: float = 4.5,
        size: int = 768,
    ) -> dict:
        """Run MV-Adapter once and return all 6 views as base64-PNG strings.

        Returns:
            {
              "views_b64": [<6 base64-PNG strings, view_0..view_5>],
              "azim_elev": [[0,0],[90,0],[180,0],[270,0],[0,60],[0,-60]],
              "nsfw_blocked": bool,
              "nsfw_max_score": float,
              "engine": "mvadapter",
            }
        """
        from PIL import Image

        # Decode incoming reference image (PNG/JPG bytes -> PIL).
        ref_bytes = base64.b64decode(image_b64)
        ref_img = Image.open(io.BytesIO(ref_bytes)).convert("RGBA")

        # Call the pure entry point defined below in this module.
        result = generate(
            self.pipe,
            self.rembg_session,
            ref_img,
            prompt="high quality, detailed",
            subject_prompt=prompt_hint,
            num_steps=num_steps,
            guidance_scale=guidance_scale,
            size=size,
            seed=seed,
            nsfw_clf1=self.nsfw_clf1,
            nsfw_clf2=self.nsfw_clf2,
            nsfw_threshold=0.5,
        )

        # Serialize 6 PIL.Image RGBAs to base64 PNGs in canonical order.
        views_b64 = []
        for view in result["views"]:
            buf = io.BytesIO()
            view["image"].save(buf, format="PNG", optimize=True)
            views_b64.append(base64.b64encode(buf.getvalue()).decode("ascii"))

        return {
            "views_b64": views_b64,
            "azim_elev": [[float(az), float(el)] for (az, el) in VIEW_SLOTS],
            "nsfw_blocked": bool(result["nsfw_blocked"]),
            "nsfw_max_score": float(result["nsfw_max_score"]),
            "engine": "mvadapter",
        }


# ---------------------------------------------------------------------------
# HTTP endpoint - wraps MyFabmeshMVAdapter.generate_views and converts the
# response into the JSON shape `cloud/src/worker.ts:callModalMVAdapter`
# expects (`{views: [6 R2 URLs]}`).
# ---------------------------------------------------------------------------
@app.function(
    image=image,
    timeout=900,                # CPU endpoint - longer than GPU worker so
                                # the R2 uploads of 6 PNGs can ride out a
                                # slow Cloudflare edge.
    secrets=[
        modal.Secret.from_name(
            "myfabmesh-shared", required_keys=["SHARED_SECRET"]),
        modal.Secret.from_name(
            "myfabmesh-r2",
            required_keys=[
                "R2_ACCOUNT_ID",
                "R2_ACCESS_KEY_ID",
                "R2_SECRET_ACCESS_KEY",
                "R2_BUCKET",
                "R2_PUBLIC_URL",
            ],
        ),
    ],
)
@modal.fastapi_endpoint(method="POST")
def mvadapter_endpoint(payload: dict):
    """POST handler. Body schema:
        {
          "_auth": "<SHARED_SECRET>",
          "front_image_url": "<https URL of reference image>",
          "prompt_hint": "<str, optional>",
          "seed":  int, "steps": int, "guidance": float, "size": int,
          "user_id": "<str>", "folder": "<R2 subfolder path>"
        }

    Response (200): {"views": [6 R2 URLs], "engine": "mvadapter",
                    "azim_elev": [[az,el], x6]}
    Response (4xx/5xx): {"error": "<message>"} via HTTPException.
    """
    from fastapi import HTTPException
    from fastapi.responses import JSONResponse

    t_total = time.time()

    # 1) Auth - body field `_auth` matches MODAL_SHARED_SECRET. No bearer.
    expected = os.environ.get("SHARED_SECRET", "")
    provided = (payload.get("_auth") or "").strip()
    if not expected or provided != expected:
        raise HTTPException(status_code=401, detail="auth")

    # 2) Validate input.
    front_image_url = payload.get("front_image_url")
    if not front_image_url or not isinstance(front_image_url, str):
        raise HTTPException(status_code=400, detail="front_image_url required")

    user_id = (payload.get("user_id") or "anon").strip() or "anon"
    folder = (payload.get("folder") or "mv-auto").strip() or "mv-auto"
    prompt_hint = payload.get("prompt_hint") or ""
    seed = int(payload.get("seed") or 1234)
    num_steps = int(payload.get("steps") or 50)
    guidance = float(payload.get("guidance") or 4.5)
    size = int(payload.get("size") or 768)

    # 3) Fetch the reference image (Cloudflare R2 public URL or any HTTPS).
    try:
        req = urllib.request.Request(
            front_image_url,
            headers={"User-Agent": "myfabmesh-mvadapter/1.0"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            in_bytes = resp.read()
        if len(in_bytes) < 64:
            raise ValueError(f"image too small ({len(in_bytes)} bytes)")
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"failed to fetch front_image_url: {e}",
        )
    image_b64 = base64.b64encode(in_bytes).decode("ascii")

    # 4) Fan out to the GPU worker via .remote() (cannot .local() - would
    # try to import CUDA pipeline in this CPU container).
    try:
        result = MyFabmeshMVAdapter().generate_views.remote(
            image_b64=image_b64,
            prompt_hint=prompt_hint,
            seed=seed,
            num_steps=num_steps,
            guidance_scale=guidance,
            size=size,
        )
    except Exception as e:
        tb = traceback.format_exc()
        print(f"[mvadapter-endpoint] worker crashed: {e}\n{tb}", flush=True)
        raise HTTPException(
            status_code=500,
            detail=f"generate_views failed: {type(e).__name__}: {e}",
        )

    views_b64 = result.get("views_b64") or []
    if len(views_b64) != len(VIEW_SLOTS):
        raise HTTPException(
            status_code=500,
            detail=f"worker returned {len(views_b64)} views, expected {len(VIEW_SLOTS)}",
        )

    # 5) Upload all 6 views to R2 (S3-compatible) and collect public URLs.
    # We use the per-account S3 endpoint:
    #   https://<account_id>.r2.cloudflarestorage.com
    # The public read URL is the bucket's pub-<hash>.r2.dev (env-configured)
    # and matches the value the Cloudflare Worker also reads.
    try:
        import boto3
        from botocore.config import Config as BotoConfig
        account_id = os.environ["R2_ACCOUNT_ID"]
        bucket = os.environ["R2_BUCKET"]
        public_base = os.environ["R2_PUBLIC_URL"].rstrip("/")
        s3 = boto3.client(
            "s3",
            endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            region_name="auto",
            config=BotoConfig(signature_version="s3v4", retries={"max_attempts": 3}),
        )
        ts = int(time.time() * 1000)
        view_urls = []
        view_names = ["front", "right", "back", "left", "top", "bottom"]
        for i, (b64, name) in enumerate(zip(views_b64, view_names)):
            key = f"{user_id}/{folder}/{ts}_{seed}_view_{i}_{name}.png"
            body = base64.b64decode(b64)
            s3.put_object(
                Bucket=bucket,
                Key=key,
                Body=body,
                ContentType="image/png",
                CacheControl="public, max-age=31536000, immutable",
            )
            view_urls.append(f"{public_base}/{key}")
        print(f"[mvadapter-endpoint] uploaded 6 views to R2 "
              f"folder={folder} total_dt={time.time()-t_total:.1f}s",
              flush=True)
    except Exception as e:
        tb = traceback.format_exc()
        print(f"[mvadapter-endpoint] R2 upload failed: {e}\n{tb}", flush=True)
        raise HTTPException(
            status_code=500,
            detail=f"R2 upload failed: {type(e).__name__}: {e}",
        )

    # 6) Final response - matches the schema `worker.ts:callModalMVAdapter`
    # parses on lines 4688-4702: 6 string URLs, engine tag, azim_elev grid.
    return JSONResponse(content={
        "views": view_urls,
        "engine": "mvadapter",
        "azim_elev": [[float(az), float(el)] for (az, el) in VIEW_SLOTS],
        "nsfw_blocked": bool(result.get("nsfw_blocked")),
        "nsfw_max_score": float(result.get("nsfw_max_score") or 0.0),
    })


# ===========================================================================
# Below this line: the existing pure functions (preprocess_reference,
# grey_to_alpha, build_plucker_embeds, generate) live untouched. They are
# imported by the @modal.enter / @modal.method above via plain module-level
# references (`generate`, `VIEW_SLOTS`, `SDXL_BASE_REVISION`,
# `SDXL_VAE_REVISION`, `MV_ADAPTER_REPO`, `MV_ADAPTER_FILE`).
# ===========================================================================


# ---------------------------------------------------------------------------
# View grid - IDENTICAL to scripts/multiview_mvadapter_gen.py.
# Convention: az 0 = front, 90 = right, 180 = back, 270 = left.
# The camera builder applies a -90 deg offset before calling
# get_orthogonal_camera (MV-Adapter's own convention has 0 = right).
# ---------------------------------------------------------------------------
VIEW_SLOTS = [
    (  0.0,   0.0),   # view_0 front
    ( 90.0,   0.0),   # view_1 right
    (180.0,   0.0),   # view_2 back
    (270.0,   0.0),   # view_3 left
    (  0.0,  60.0),   # view_4 top 3/4-high
    (  0.0, -60.0),   # view_5 bottom 3/4-low
]

# Pinned snapshot revisions - protects against silent upstream changes
# to model weights that would invalidate our snapshot. The HF hub
# resolves these to immutable commits.
SDXL_BASE_REVISION = "462165984030d82259a11f4367a4eed129e94a7b"  # vanilla SDXL-base-1.0
SDXL_VAE_REVISION  = "4df413ca49271c25289a6482ab97a433f8117d15"  # madebyollin sdxl-vae-fp16-fix
MV_ADAPTER_REPO    = "huanngzh/mv-adapter"
MV_ADAPTER_FILE    = "mvadapter_i2mv_sdxl.safetensors"


# ---------------------------------------------------------------------------
# Preprocessing - mirrors steps a-f from scripts/multiview_mvadapter_gen.py
# section "9. INPUT PREPROCESSING". Returns (ref_rgb_for_model, rgba_input).
# ---------------------------------------------------------------------------
def preprocess_reference(
    ref_img: Image.Image,
    size: int,
    rembg_session,
) -> tuple[Image.Image, Image.Image]:
    """Open as RGBA -> strip bg if opaque -> square pad -> resize -> composite
    onto mid-grey for the SDXL reference. Returns:
      (ref_rgb_on_grey, rgba_input_for_caller)
    The caller stores the RGBA version for downstream texture_project.
    """
    img = ref_img.convert("RGBA")

    # Background removal only if the alpha is fully opaque (no existing mask).
    if np.asarray(img)[..., 3].min() == 255:
        import rembg
        img = rembg.remove(img, session=rembg_session)

    # Square pad with transparency.
    w, h = img.size
    s = max(w, h)
    pad = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    pad.paste(img, ((s - w) // 2, (s - h) // 2))
    img = pad.resize((size, size), Image.LANCZOS)

    # Composite onto mid-grey (0.5) for the diffusion reference image.
    arr = np.asarray(img).astype(np.float32) / 255.0
    alpha = arr[..., 3:4]
    rgb = arr[..., :3] * alpha + (1.0 - alpha) * 0.5
    ref_rgb = Image.fromarray((rgb * 255).clip(0, 255).astype(np.uint8))
    return ref_rgb, img  # ref for model, RGBA preserved


# ---------------------------------------------------------------------------
# Post-process: grey-bg -> alpha for one PIL view.
# Mirrors section "10. OUTPUT POST-PROCESSING" from the desktop script.
# ---------------------------------------------------------------------------
def grey_to_alpha(view: Image.Image, size: int) -> Image.Image:
    rgb = view.convert("RGB")
    if rgb.size != (size, size):
        rgb = rgb.resize((size, size), Image.LANCZOS)
    arr = np.asarray(rgb)
    dist = np.linalg.norm(arr.astype(float) - np.array([128.0, 128.0, 128.0]), axis=2)
    alpha = (dist > 25).astype(np.uint8) * 255
    rgba = np.dstack([arr, alpha])
    return Image.fromarray(rgba, mode="RGBA")


# ---------------------------------------------------------------------------
# Build the orthographic-camera Plucker embedding the adapter needs.
# Lifted verbatim from scripts/multiview_mvadapter_gen.py section 5.
# ---------------------------------------------------------------------------
def build_plucker_embeds(size: int, device: str):
    from mvadapter.utils.mesh_utils import get_orthogonal_camera
    from mvadapter.utils.geometry import get_plucker_embeds_from_cameras_ortho

    n = len(VIEW_SLOTS)
    cameras = get_orthogonal_camera(
        elevation_deg=[el for _, el in VIEW_SLOTS],
        distance=[1.8] * n,
        left=-0.55, right=0.55, bottom=-0.55, top=0.55,
        # -90 offset matches MV-Adapter's internal "azimuth 0 = right" convention.
        azimuth_deg=[az - 90 for az, _ in VIEW_SLOTS],
        device=device,
    )
    plucker_embeds = get_plucker_embeds_from_cameras_ortho(
        cameras.c2w, [1.1] * n, size,
    )
    control_images = ((plucker_embeds + 1.0) / 2.0).clamp(0.0, 1.0)
    return control_images


# ---------------------------------------------------------------------------
# Public entry point - called from the @app.cls endpoint in app.py.
# The caller passes the pre-loaded MV-Adapter pipeline (built in
# @modal.enter), the rembg session, and (optionally) the NSFW classifiers
# for per-view content filtering.
# ---------------------------------------------------------------------------
def generate(
    pipe,                       # MVAdapterI2MVSDXLPipeline already on CUDA
    rembg_session,              # rembg.new_session() - used to strip ref bg
    ref_img: Image.Image,
    prompt: str = "high quality",
    subject_prompt: str = "",
    num_steps: int = 50,
    guidance_scale: float = 4.5,
    size: int = 768,
    seed: int = 1234,
    nsfw_clf1=None, nsfw_clf2=None,
    nsfw_threshold: float = 0.5,
) -> dict:
    """Run MV-Adapter once and return all 6 views as PIL RGBA images.

    Returns:
        {
          "views": [ {"azim": float, "elev": float, "image": PIL.Image}, ... ],
          "input": PIL.Image,        # the RGBA preprocessed reference
          "nsfw_blocked": bool,      # True iff any view tripped the NSFW filter
          "nsfw_max_score": float,
        }
    """
    t_total = time.time()
    device = "cuda" if torch.cuda.is_available() else "cpu"

    # 1. Preprocess the reference image - same recipe as desktop.
    ref_rgb, rgba_input = preprocess_reference(ref_img, size, rembg_session)
    print(f"[mvadapter] preprocess size={size} subject_prompt={subject_prompt!r}",
          flush=True)

    # 2. Build the camera/Plucker control conditioning.
    control_images = build_plucker_embeds(size, device)

    # 3. Build the final prompt - same order as desktop section 8.
    full_prompt = f"{subject_prompt}, {prompt}" if subject_prompt else prompt
    neg_prompt = (
        "watermark, ugly, deformed, noisy, blurry, low contrast, "
        "distorted anatomy, extra limbs, text, signature"
    )

    # 4. Deterministic generator if seed >= 0.
    gen = (torch.Generator(device=device).manual_seed(int(seed))
           if seed is not None and seed >= 0 else None)

    # 5. Inference - same knobs as scripts/multiview_mvadapter_gen.py.
    t_inf = time.time()
    result = pipe(
        prompt=full_prompt,
        negative_prompt=neg_prompt,
        num_inference_steps=int(num_steps),
        guidance_scale=float(guidance_scale),
        num_images_per_prompt=len(VIEW_SLOTS),
        reference_image=ref_rgb,
        control_image=control_images,
        control_conditioning_scale=1.0,
        reference_conditioning_scale=1.3,
        height=size, width=size,
        generator=gen,
        cross_attention_kwargs={"scale": 1.0},
    )
    pil_views = result.images
    print(f"[mvadapter] inference dt={time.time() - t_inf:.1f}s "
          f"views={len(pil_views)}", flush=True)

    # 6. Post-process - grey -> alpha for each view.
    views_out = []
    nsfw_max = 0.0
    nsfw_block = False
    for i, (view, (az, el)) in enumerate(zip(pil_views, VIEW_SLOTS)):
        rgba = grey_to_alpha(view, size)

        # Optional per-view NSFW scan (desktop bridge skips this - we add it
        # for parity with the rest of the cloud surface).
        if nsfw_clf1 is not None and nsfw_clf2 is not None:
            from modal_app._nsfw import is_safe
            safe, score = is_safe(rgba.convert("RGB"), nsfw_clf1, nsfw_clf2,
                                  threshold=nsfw_threshold)
            nsfw_max = max(nsfw_max, score)
            if not safe:
                from modal_app._nsfw import make_blocked_placeholder
                rgba = make_blocked_placeholder((size, size)).convert("RGBA")
                nsfw_block = True
                print(f"[mvadapter] view_{i} BLOCKED nsfw={score:.3f}", flush=True)

        views_out.append({"azim": float(az), "elev": float(el), "image": rgba})

    print(f"[mvadapter] DONE total_dt={time.time() - t_total:.1f}s "
          f"nsfw_blocked={nsfw_block}", flush=True)
    return {
        "views": views_out,
        "input": rgba_input,
        "nsfw_blocked": nsfw_block,
        "nsfw_max_score": float(nsfw_max),
    }
