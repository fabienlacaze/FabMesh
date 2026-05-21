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
        ('cn_pose',   'xinsir/controlnet-openpose-sdxl-1.0', 2400),
        ('ipadapter', 'h94/IP-Adapter', 700),
        ('blip1',     'Salesforce/blip-image-captioning-large', 990),
        ('esrgan',    'RealESRGAN_x4plus', 70),
    ],
    'full': [
        ('trellis2',  'microsoft/TRELLIS.2-4B', 4100),
        ('realvis',   'SG161222/RealVisXL_V4.0', 6500),
        ('sdxl_inp',  'diffusers/stable-diffusion-xl-1.0-inpainting-0.1', 6500),
        ('cn_pose',   'xinsir/controlnet-openpose-sdxl-1.0', 2400),
        ('ipadapter', 'h94/IP-Adapter', 700),
        ('florence2', 'microsoft/Florence-2-large', 1700),
        ('blip1',     'Salesforce/blip-image-captioning-large', 990),
        ('esrgan',    'RealESRGAN_x4plus', 70),
    ],
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


def download_hf(item_id, repo, expected_mb, total_done_mb_ref):
    """Use huggingface_hub.snapshot_download for HF repos. Emits coarse
    progress because HF doesn't expose per-byte hooks across all files
    without monkey-patching."""
    from huggingface_hub import snapshot_download
    # We emit start
    emit({'id': item_id, 'pct': 0, 'done': False,
          'total_done_mb': total_done_mb_ref[0]})
    t0 = time.time()
    # snapshot_download handles resume + parallel files + cache reuse
    snapshot_download(repo_id=repo, resume_download=True,
                      max_workers=4)
    dt = max(time.time() - t0, 0.001)
    speed = expected_mb / dt
    total_done_mb_ref[0] += expected_mb
    emit({'id': item_id, 'pct': 100, 'done': True,
          'speed_mbps': speed, 'eta': '–',
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
