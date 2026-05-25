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
image = (
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
        # `[standard]` pulls in uvicorn and a few useful extras.
        "fastapi[standard]>=0.115",
    )
    # Ship our cloud-specific helper modules into the image. We do NOT
    # ship anything from `scripts/` — desktop pipeline stays separate.
    .add_local_python_source("modal_app")
)

app = modal.App("myfabmesh-cloud", image=image)


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
