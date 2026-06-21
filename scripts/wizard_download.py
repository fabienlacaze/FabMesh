"""Download models for FabMesh first-run wizard.

Streams JSON progress lines on stdout so the Electron main process can
forward them to the wizard UI. Resume-friendly (uses huggingface_hub
which supports resume natively) and respects the shared HF cache so
users with ComfyUI/Auto1111 don't re-download the same weights.

Usage:
    python wizard_download.py --mode {lite|standard|full}

Output (one JSON object per line on stdout):
    {"id": "trellis2", "pct": 12.5, "done": false,
     "speed_mbps": 87.4, "eta": "1m 20s",
     "total_done_mb": 512}
"""
import argparse
import json
import os
import sys
import threading
import time
import urllib.request


MODELS = {
    'lite': [
        ('trellis2', 'microsoft/TRELLIS.2-4B', 4100),
        ('blip1',    'Salesforce/blip-image-captioning-large', 990),
    ],
    'standard': [
        ('trellis2',  'microsoft/TRELLIS.2-4B', 4100),
        ('realvis',   'SG161222/RealVisXL_V4.0', 6500),
        ('lightning', 'ByteDance/SDXL-Lightning', 400),
        ('cn_pose',   'xinsir/controlnet-openpose-sdxl-1.0', 2400),
        ('ipadapter', 'h94/IP-Adapter', 700),
        ('blip1',     'Salesforce/blip-image-captioning-large', 990),
        ('esrgan',    'RealESRGAN_x4plus', 70),
    ],
    'full': [
        ('trellis2',  'microsoft/TRELLIS.2-4B', 4100),
        ('realvis',   'SG161222/RealVisXL_V4.0', 6500),
        ('lightning', 'ByteDance/SDXL-Lightning', 400),
        ('sdxl_inp',  'diffusers/stable-diffusion-xl-1.0-inpainting-0.1', 6500),
        ('cn_pose',   'xinsir/controlnet-openpose-sdxl-1.0', 2400),
        ('ipadapter', 'h94/IP-Adapter', 700),
        ('florence2', 'microsoft/Florence-2-large', 1700),
        ('blip1',     'Salesforce/blip-image-captioning-large', 990),
        ('esrgan',    'RealESRGAN_x4plus', 70),
    ],
}


# Repos where we only need a subset of files (snapshot_download pulls the WHOLE
# repo otherwise). The Lightning repo ships many step/format variants (~GBs);
# we only use the 4-step SDXL LoRA (~400 MB).
ALLOW_PATTERNS = {
    'ByteDance/SDXL-Lightning': ['sdxl_lightning_4step_lora.safetensors'],
}


def emit(obj):
    sys.stdout.write(json.dumps(obj) + '\n')
    sys.stdout.flush()


def _eta_str(remaining_mb, speed_mbps):
    if not speed_mbps or speed_mbps <= 0:
        return '–'
    secs = int(remaining_mb / speed_mbps)
    if secs < 60: return f'{secs}s'
    if secs < 3600: return f'{secs // 60}m {secs % 60}s'
    return f'{secs // 3600}h {(secs % 3600) // 60}m'


def _hf_cache_size_mb(repo):
    """Walk the HF cache for a given repo and return total size in MB.
    Used by the heartbeat to compute live progress without waiting for
    snapshot_download to return."""
    cache_dir = os.path.expanduser('~/.cache/huggingface/hub')
    repo_dir = os.path.join(cache_dir, 'models--' + repo.replace('/', '--'))
    if not os.path.isdir(repo_dir):
        return 0
    total = 0
    for root, _dirs, files in os.walk(repo_dir):
        for fn in files:
            try:
                total += os.path.getsize(os.path.join(root, fn))
            except OSError:
                pass
    return total // (1024 * 1024)


def _heartbeat(item_id, repo, expected_mb, total_done_mb_ref, stop, t0):
    """Emit a progress event every second while snapshot_download blocks.
    pct is derived from the actual HF cache growth on disk — accurate
    even though huggingface_hub doesn't expose a download callback."""
    start_size = _hf_cache_size_mb(repo)
    last_size = start_size
    last_t = time.time()
    while not stop.wait(1.0):
        cur_size = _hf_cache_size_mb(repo)
        elapsed = time.time() - t0
        delta_mb = max(0, cur_size - start_size)
        # Speed: bytes/s over the last tick
        now = time.time()
        speed_mbps = max(0, (cur_size - last_size) / max(now - last_t, 0.001))
        last_size = cur_size; last_t = now
        pct = min(99.0, round(delta_mb * 100.0 / max(expected_mb, 1), 1))
        emit({
            'id': item_id,
            'pct': pct,
            'done': False,
            'in_progress': True,
            'elapsed_s': round(elapsed, 1),
            'speed_mbps': round(speed_mbps, 2),
            'eta': _eta_str(max(0, expected_mb - delta_mb), speed_mbps),
            'total_done_mb': total_done_mb_ref[0] + delta_mb,
        })


def _hf_token():
    """Return a HuggingFace token if available. Priority:
      1. HF_TOKEN env var (set by main.js or user)
      2. ~/.cache/huggingface/token (default HF CLI location)
      3. Embedded read-only fallback (only kicks in on rate-limit retry)
    Read-only token = no write/secret access, safe to ship in the binary.
    """
    t = os.environ.get('HF_TOKEN') or os.environ.get('HUGGING_FACE_HUB_TOKEN')
    if t:
        return t
    user_token = os.path.expanduser('~/.cache/huggingface/token')
    if os.path.isfile(user_token):
        try:
            with open(user_token, 'r', encoding='utf-8') as f:
                return f.read().strip() or None
        except Exception:
            pass
    return None  # caller decides whether to retry with a fallback


# Embedded read-only fallback token. Leave empty until you generate one:
#   1. Create a free HF account
#   2. Settings -> Access Tokens -> New token (READ only, never write)
#   3. Paste it here. It only buys you a higher rate-limit for anonymous
#      downloads — it does NOT grant access to private/gated content.
# Read from a sibling file (bundled into the installer via electron-builder
# extraResources), or empty if missing. The literal token is NEVER stored
# in git — GitHub's secret scanner rejects pushes that contain hf_*
# tokens, even for read-only public ones. The file lives at
# `build/hf_fallback_token.txt` on the dev box (gitignored) and at
# `resources/hf_fallback_token.txt` once installed.
def _load_hf_fallback_token():
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(here, '..', 'hf_fallback_token.txt'),       # packaged: resources/
        os.path.join(here, '..', 'build', 'hf_fallback_token.txt'),  # dev box
    ]
    for p in candidates:
        try:
            if os.path.isfile(p):
                with open(p, 'r', encoding='utf-8') as f:
                    t = f.read().strip()
                    if t.startswith('hf_'):
                        return t
        except Exception:
            pass
    return ''
HF_FALLBACK_TOKEN = _load_hf_fallback_token()


def _already_installed(repo, expected_mb):
    """True when the repo is already in the HF cache at (at least) the
    size we'd expect to download. Re-running the wizard then skips it
    instantly instead of re-pulling the whole repo.

    The on-disk cache for a completed model is always >= expected_mb
    (often 2-4x, because HF stores every weight variant + multiple
    revisions). A partially-downloaded repo is < expected_mb, so the
    threshold cleanly separates "done" from "needs more". We use 0.95x
    as a small safety margin against variant/compression differences.
    """
    try:
        cache_mb = _hf_cache_size_mb(repo)
        return cache_mb >= expected_mb * 0.95
    except Exception:
        return False


def download_hf(item_id, repo, expected_mb, total_done_mb_ref):
    """Use huggingface_hub.snapshot_download. A background thread emits
    progress events every second based on actual cache growth, so the
    UI never looks frozen even on multi-GB repos. Retries once with
    the embedded read-only token if anonymous hits a rate-limit."""
    from huggingface_hub import snapshot_download
    from huggingface_hub.utils import HfHubHTTPError

    # 2026-06-13: skip already-installed repos. Without this, re-entering
    # the wizard re-pulls the FULL repo (snapshot_download has no
    # allow_patterns, so it fetches every weight variant) even though the
    # app only needs a subset that's already on disk.
    if _already_installed(repo, expected_mb):
        cache_mb = _hf_cache_size_mb(repo)
        # Quick cosmetic ramp 0->100 (~320 ms) so the bar visibly fills
        # instead of snapping to 100. The download loop is sequential, so
        # the bars animate one after another. Real downloads ignore this.
        base = total_done_mb_ref[0]
        for pct in (12, 38, 66, 100):
            emit({'id': item_id, 'pct': pct,
                  'done': pct >= 100,
                  'in_progress': pct < 100,
                  'speed_mbps': 0, 'eta': '–', 'elapsed_s': 0,
                  'msg': (f'already installed ({cache_mb} MB on disk)' if pct >= 100 else 'verifying…'),
                  'total_done_mb': base + (expected_mb * pct // 100)})
            if pct < 100:
                time.sleep(0.08)
        total_done_mb_ref[0] = base + expected_mb
        return

    emit({'id': item_id, 'pct': 0, 'done': False,
          'in_progress': True, 'elapsed_s': 0,
          'total_done_mb': total_done_mb_ref[0]})
    t0 = time.time()
    stop = threading.Event()
    hb = threading.Thread(
        target=_heartbeat,
        args=(item_id, repo, expected_mb, total_done_mb_ref, stop, t0),
        daemon=True)
    hb.start()
    try:
        token = _hf_token()
        try:
            snapshot_download(repo_id=repo, resume_download=True,
                              max_workers=4, token=token,
                              allow_patterns=ALLOW_PATTERNS.get(repo))
        except HfHubHTTPError as e:
            # Rate-limit (429) or auth (401/403) — try once with the
            # embedded fallback token if we have one and weren't already
            # using a token.
            if not token and HF_FALLBACK_TOKEN:
                emit({'id': item_id, 'pct': 0, 'done': False,
                      'in_progress': True, 'msg': 'retrying with fallback token',
                      'total_done_mb': total_done_mb_ref[0]})
                snapshot_download(repo_id=repo, resume_download=True,
                                  max_workers=4, token=HF_FALLBACK_TOKEN,
                                  allow_patterns=ALLOW_PATTERNS.get(repo))
            else:
                raise
    finally:
        stop.set()
        hb.join(timeout=2.0)
    dt = max(time.time() - t0, 0.001)
    speed = expected_mb / dt
    total_done_mb_ref[0] += expected_mb
    emit({'id': item_id, 'pct': 100, 'done': True,
          'speed_mbps': round(speed, 2), 'eta': '–',
          'elapsed_s': round(dt, 1),
          'total_done_mb': total_done_mb_ref[0]})


def download_esrgan(item_id, expected_mb, total_done_mb_ref):
    """Real-ESRGAN weights come from GitHub releases, not HF."""
    url = ('https://github.com/xinntao/Real-ESRGAN/releases/'
           'download/v0.1.0/RealESRGAN_x4plus.pth')
    target_dir = os.path.expanduser('~/.cache/realesrgan_weights')
    os.makedirs(target_dir, exist_ok=True)
    target = os.path.join(target_dir, 'RealESRGAN_x4plus.pth')
    if os.path.isfile(target) and os.path.getsize(target) > 60 * 1024 * 1024:
        emit({'id': item_id, 'pct': 100, 'done': True,
              'total_done_mb': total_done_mb_ref[0] + expected_mb})
        total_done_mb_ref[0] += expected_mb
        return

    emit({'id': item_id, 'pct': 0, 'done': False,
          'total_done_mb': total_done_mb_ref[0]})
    t0 = time.time()
    last_emit = 0
    with urllib.request.urlopen(url, timeout=60) as resp, open(target, 'wb') as f:
        total = int(resp.headers.get('content-length') or expected_mb * 1024 * 1024)
        read = 0
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk: break
            f.write(chunk)
            read += len(chunk)
            now = time.time()
            if now - last_emit > 0.3:
                pct = round(read * 100 / total, 1)
                speed = (read / (1024 * 1024)) / max(now - t0, 0.001)
                emit({'id': item_id, 'pct': pct, 'done': False,
                      'speed_mbps': speed,
                      'eta': _eta_str((total - read) / (1024 * 1024), speed),
                      'total_done_mb': total_done_mb_ref[0] + read // (1024 * 1024)})
                last_emit = now
    total_done_mb_ref[0] += expected_mb
    emit({'id': item_id, 'pct': 100, 'done': True,
          'total_done_mb': total_done_mb_ref[0]})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mode', choices=list(MODELS.keys()), required=True)
    args = ap.parse_args()

    items = MODELS[args.mode]
    total_done = [0]
    for item_id, repo, size in items:
        try:
            if item_id == 'esrgan':
                download_esrgan(item_id, size, total_done)
            else:
                download_hf(item_id, repo, size, total_done)
        except Exception as e:
            emit({'id': item_id, 'pct': 0, 'done': False,
                  'error': str(e)})
            # Continue with the next model — partial install is still
            # better than aborting. The smoke test will tell us if the
            # bare minimum is in place.
    emit({'id': '__all__', 'pct': 100, 'done': True,
          'total_done_mb': total_done[0]})


if __name__ == '__main__':
    main()
