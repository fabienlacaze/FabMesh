"""FabMesh AnyTop fine-tuning on Modal H100/A100.

Wraps our text-conditioning AnyTop fork training loop into a Modal app.

Usage from local:
    modal run modal_app/_train_anytop.py::train --num-steps 30000

Cost (approximate, billed per-second):
- A100 80GB at $2.71/h
- H100 80GB at $3.95/h
- 15k steps at ~150 step/min on H100 = ~1h40 = ~$6.50
- 15k steps at ~80 step/min on A100 80GB = ~3h = ~$8.13

Built-in hard budget cap via MAX_BUDGET_USD env var. Stops training and
saves final checkpoint when exceeded.
"""
from __future__ import annotations

import os
import sys
import time

import modal

# ---------- App + Image ----------

app = modal.App("myfabmesh-train-anytop")

# Pre-trained checkpoint pin (must match our local fork)
ANYTOP_FORK_BRANCH = "feat/text-conditioning-fabmesh"

# Build the Modal image. We need PyTorch 2.6+ with cu124 (Hopper H100 = sm_90,
# works fine with cu124, no need for Blackwell nightly cu128).
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "ffmpeg")
    .pip_install(
        # Pin numpy<2 for compat with torch 2.1 ops used in AnyTop
        "numpy<2",
        # PyTorch 2.6 stable with cu124 — covers H100, A100, L40S
        "torch==2.6.0",
        "torchvision==0.21.0",
        index_url="https://download.pytorch.org/whl/cu124",
    )
    .pip_install(
        "scipy",
        "matplotlib<3.9",
        "tqdm",
        "einops",
        "bvhsdk",
        "pygltflib",
        "trimesh",
        "huggingface_hub",
        "moviepy<2",
        "imageio==2.35.1",
        "imageio-ffmpeg",
        "transformers==4.30.0",
        "blobfile",
        "wandb",
    )
    # Install Motion (the BVH module AnyTop needs)
    .pip_install(
        "git+https://github.com/inbar-2344/Motion.git",
        extra_options="--no-build-isolation",
    )
)

# Persistent storage for: (1) AnyTop source code, (2) dataset, (3) checkpoints
volume = modal.Volume.from_name("fabmesh-anytop-training", create_if_missing=True)

# Mount points inside container
ANYTOP_ROOT = "/anytop"
CKPT_DIR = f"{ANYTOP_ROOT}/save/mtndragon_textcond_dataset_truebones_bs_8_latentdim_128"


@app.function(
    image=image,
    volumes={ANYTOP_ROOT: volume},
    gpu="H100",  # ~$3.95/h. Change to "A100-80GB" ($2.71/h) for cheaper.
    timeout=4 * 3600,  # 4-hour hard limit
    memory=32 * 1024,  # 32 GB RAM for T5 + dataset
)
def train(
    num_steps: int = 30000,
    lr: float = 1e-4,
    batch_size: int = 16,  # H100 has plenty of VRAM, double our local batch
    save_interval: int = 500,
    log_interval: int = 20,
    freeze_backbone: bool = True,
    use_bf16: bool = True,
    lambda_geo: float = 1.0,
    max_budget_usd: float = 15.0,
    resume_step: int | None = None,
):
    """Run the AnyTop fine-tune on a Modal GPU.

    Reads the latest checkpoint from the volume (or `resume_step` if pinned),
    runs train_anytop, and saves new checkpoints back to the volume.

    Budget cap: training aborts cleanly when wall-clock × hourly_rate exceeds
    `max_budget_usd`. Final checkpoint is saved before exit.
    """
    import subprocess

    # Hourly rate per Modal pricing (verify in dashboard)
    HOURLY_RATE = {"H100": 3.95, "A100-80GB": 2.71, "L40S": 1.40}.get("H100", 4.0)
    started = time.time()

    def check_budget():
        elapsed_h = (time.time() - started) / 3600
        cost = elapsed_h * HOURLY_RATE
        if cost > max_budget_usd:
            print(f"\n[BUDGET] ${cost:.2f} > ${max_budget_usd:.2f} — stop", flush=True)
            return True
        return False

    # Find the latest checkpoint
    save_dir = CKPT_DIR
    if not os.path.isdir(save_dir):
        raise RuntimeError(f"No save_dir at {save_dir} — populate the volume first")

    import re
    matches = {f: re.match(r"model(\d+)\.pt$", f) for f in os.listdir(save_dir)}
    steps = {int(m.group(1)): f for f, m in matches.items() if m}
    if not steps:
        raise RuntimeError(f"No model*.pt found in {save_dir}")
    pick_step = resume_step or max(steps)
    if pick_step not in steps:
        raise RuntimeError(f"requested resume_step={resume_step} not in {sorted(steps)}")
    resume_path = os.path.join(save_dir, steps[pick_step])
    print(f"[modal-train] resume_checkpoint={resume_path}", flush=True)

    # Build env
    env = os.environ.copy()
    env["ANYTOP_FREEZE_BACKBONE"] = "1" if freeze_backbone else "0"
    env["ANYTOP_USE_BF16"] = "1" if use_bf16 else "0"

    cmd = [
        "python", "-m", "train.train_anytop",
        "--model_prefix", "mtndragon_textcond",
        "--objects_subset", "flying",
        "--balanced",
        "--overwrite",
        "--resume_checkpoint", resume_path.replace(ANYTOP_ROOT + "/", ""),
        "--num_steps", str(num_steps),
        "--save_interval", str(save_interval),
        "--log_interval", str(log_interval),
        "--batch_size", str(batch_size),
        "--lr", str(lr),
        "--lambda_geo", str(lambda_geo),
    ]
    print(f"[modal-train] cmd: {' '.join(cmd)}", flush=True)

    # Launch and stream output
    proc = subprocess.Popen(
        cmd, env=env, cwd=ANYTOP_ROOT,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
    )
    assert proc.stdout is not None
    last_budget_check = time.time()
    try:
        for line in proc.stdout:
            print(line.rstrip(), flush=True)
            # Check budget every 30 seconds
            if time.time() - last_budget_check > 30:
                last_budget_check = time.time()
                if check_budget():
                    proc.terminate()
                    proc.wait(timeout=60)
                    break
    finally:
        proc.wait()

    # Commit the volume so checkpoints persist
    volume.commit()
    elapsed = (time.time() - started) / 3600
    print(f"[modal-train] DONE — {elapsed:.2f}h, ~${elapsed*HOURLY_RATE:.2f}", flush=True)
    return {"elapsed_h": elapsed, "estimated_cost_usd": elapsed * HOURLY_RATE}


@app.function(
    image=image,
    volumes={ANYTOP_ROOT: volume},
    cpu=2, memory=4096, timeout=600,
)
def upload_source(tarball_b64: str):
    """Upload local AnyTop fork (tarball) into the Modal volume."""
    import base64, tarfile, io
    data = base64.b64decode(tarball_b64)
    print(f"[upload] received {len(data)/1e6:.1f} MB tarball", flush=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        tar.extractall(ANYTOP_ROOT)
    volume.commit()
    print("[upload] source extracted + volume committed", flush=True)


@app.function(
    image=image,
    volumes={ANYTOP_ROOT: volume},
    cpu=2, memory=4096, timeout=600,
)
def list_checkpoints():
    """List all checkpoints in the volume."""
    import re
    save_dir = CKPT_DIR
    if not os.path.isdir(save_dir):
        return {"error": f"no save_dir at {save_dir}"}
    matches = {f: re.match(r"model(\d+)\.pt$", f) for f in os.listdir(save_dir)}
    steps = sorted(int(m.group(1)) for m in matches.values() if m)
    return {"latest_step": steps[-1] if steps else None,
            "total_checkpoints": len(steps), "steps": steps[-10:]}


@app.function(
    image=image,
    volumes={ANYTOP_ROOT: volume},
    cpu=2, memory=4096, timeout=600,
)
def download_checkpoint(step: int) -> bytes:
    """Return a specific checkpoint's bytes for local download."""
    save_dir = CKPT_DIR
    path = os.path.join(save_dir, f"model{step:09d}.pt")
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    with open(path, "rb") as f:
        return f.read()


@app.local_entrypoint()
def main(num_steps: int = 30000, max_budget_usd: float = 15.0):
    """Local CLI: kick off training + monitor."""
    print(f"[fabmesh] launching Modal train: {num_steps} steps, budget=${max_budget_usd}")
    result = train.remote(num_steps=num_steps, max_budget_usd=max_budget_usd)
    print(f"[fabmesh] train returned: {result}")
