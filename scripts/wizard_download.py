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


# Slow-link resilience: HuggingFace's default connect/etag timeout is 10s,
# which can abort a large-file transfer on rural DSL / mobile tethering /
# hotel wifi. Raise them BEFORE huggingface_hub is imported (it reads these
# at import time). This does NOT cap total download time — a slow transfer
# keeps going; it only stops premature aborts on a sluggish connection.
os.environ.setdefault('HF_HUB_DOWNLOAD_TIMEOUT', '30')
os.environ.setdefault('HF_HUB_ETAG_TIMEOUT', '30')


def _lower_priority():
    """Drop this process (and the children it spawns) to BELOW_NORMAL so the
    multi-GB download + concurrent disk writes don't freeze the desktop.
    Best-effort; no-op off Windows or on failure. Uses the typed-ctypes idiom
    (restype=c_void_p) that scripts/trellis2_native_full_pipeline.py proved is
    required so the 64-bit GetCurrentProcess() pseudo-handle isn't truncated
    to 32 bits (which makes SetPriorityClass silently fail)."""
    try:
        if sys.platform == 'win32':
            import ctypes
            from ctypes import wintypes
            k32 = ctypes.windll.kernel32
            k32.GetCurrentProcess.restype = ctypes.c_void_p
            k32.SetPriorityClass.argtypes = [ctypes.c_void_p, wintypes.DWORD]
            k32.SetPriorityClass.restype = wintypes.BOOL
            k32.SetPriorityClass(k32.GetCurrentProcess(), 0x00004000)  # BELOW_NORMAL_PRIORITY_CLASS
        else:
            os.nice(10)
    except Exception:
        pass


# Models that are OPTIONAL — the app still generates without them (esrgan =
# upscaler, florence2 = secondary captioner). A failure on THESE only warns;
# a failure on any other (essential) model fails the install loudly so the
# user never proceeds with a broken setup.
_OPTIONAL_MODELS = {'esrgan', 'florence2'}


# ---------------------------------------------------------------------------
# DINOv3 — TRELLIS-2's image backbone.
#
# TRELLIS-2 loads facebook/dinov3-vitl16-pretrain-lvd1689m LAZILY on the first
# generation. That repo is GATED by Meta, so a client with no Meta token hits
# GatedRepoError mid-generation — a hard release blocker. Meta's DINOv3 license
# DOES permit redistribution, so we pull a NON-GATED copy at install time and
# stage it into the canonical cache folder, letting from_pretrained resolve it
# locally with no token.
#
# Source priority (see download_dinov3):
#   1. FABMESH_DINOV3_URL  — self-hosted copy the shipper controls. Either an
#      HF repo id ("myorg/dinov3-mirror") or a base URL serving the weight
#      files (…/config.json, …/model.safetensors). PREFERRED for a commercial
#      release: a mirror you own can't be deleted out from under you.
#   2. DINOV3_MIRROR_REPO  — community HF mirror (non-gated fallback).
DINOV3_CANONICAL_REPO = 'facebook/dinov3-vitl16-pretrain-lvd1689m'
# Non-gated community mirror (verified: config.json + model.safetensors 1.21 GB
# + preprocessor_config.json, HF transformers format, no license gate).
# NOTE for the shipper: for a commercial release, re-host these weights on your
# own R2/CDN and set FABMESH_DINOV3_URL — do not depend on a third-party mirror
# staying online. See userTodo "host DINOv3 weights".
DINOV3_MIRROR_REPO = 'camenduru/dinov3-vitl16-pretrain-lvd1689m'
DINOV3_FILES = ['config.json', 'model.safetensors', 'preprocessor_config.json']


MODELS = {
    'lite': [
        ('trellis2', 'microsoft/TRELLIS.2-4B', 4100),
        ('dinov3',   DINOV3_CANONICAL_REPO, 1250),
        ('blip1',    'Salesforce/blip-image-captioning-large', 990),
    ],
    'standard': [
        ('trellis2',  'microsoft/TRELLIS.2-4B', 4100),
        ('dinov3',    DINOV3_CANONICAL_REPO, 1250),
        ('realvis',   'SG161222/RealVisXL_V4.0', 6500),
        ('lightning', 'ByteDance/SDXL-Lightning', 400),
        ('cn_pose',   'xinsir/controlnet-openpose-sdxl-1.0', 2400),
        ('ipadapter', 'h94/IP-Adapter', 700),
        ('blip1',     'Salesforce/blip-image-captioning-large', 990),
        ('esrgan',    'RealESRGAN_x4plus', 70),
    ],
    'full': [
        ('trellis2',  'microsoft/TRELLIS.2-4B', 4100),
        ('dinov3',    DINOV3_CANONICAL_REPO, 1250),
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
    # Honor HF_HOME / HUGGINGFACE_HUB_CACHE so the cache follows the user's
    # chosen data location (set by the Electron spawn env). snapshot_download
    # already respects these; this size-walk must look in the same place.
    cache_dir = (os.environ.get('HUGGINGFACE_HUB_CACHE')
                 or (os.path.join(os.environ['HF_HOME'], 'hub')
                     if os.environ.get('HF_HOME')
                     else os.path.expanduser('~/.cache/huggingface/hub')))
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


def _with_retry(fn, item_id, total_done_mb_ref, attempts=5):
    """Retry fn() on TRANSIENT network/server errors with exponential
    backoff (4s, 8s, 16s… capped 120s + jitter). Permanent errors (gated /
    missing repo, revision, file, or auth 401/403) re-raise immediately —
    retrying them just wastes minutes before the identical failure.
    snapshot_download resumes from the HF cache, so each retry continues
    where the last attempt stopped rather than restarting from 0."""
    import random
    try:
        from requests.exceptions import (ConnectionError as _ConnErr,
                                          Timeout as _Timeout,
                                          ChunkedEncodingError as _ChunkErr)
        _TRANSIENT_NET = (_ConnErr, _Timeout, _ChunkErr)
    except Exception:
        _TRANSIENT_NET = ()
    try:
        from huggingface_hub.utils import HfHubHTTPError as _HTTPErr
    except Exception:
        try:
            from huggingface_hub.errors import HfHubHTTPError as _HTTPErr
        except Exception:
            _HTTPErr = None
    try:
        from huggingface_hub.errors import (RepositoryNotFoundError,
                                            GatedRepoError, RevisionNotFoundError,
                                            EntryNotFoundError)
        _PERMANENT = (RepositoryNotFoundError, GatedRepoError,
                      RevisionNotFoundError, EntryNotFoundError)
    except Exception:
        _PERMANENT = ()
    delay = 4.0
    for n in range(1, attempts + 1):
        try:
            return fn()
        except _PERMANENT:
            raise  # never retry: user must accept a license / fix the repo id
        except Exception as e:
            is_http = bool(_HTTPErr) and isinstance(e, _HTTPErr)
            status = getattr(getattr(e, 'response', None), 'status_code', None) if is_http else None
            transient = (isinstance(e, _TRANSIENT_NET)
                         or (is_http and status in (429, 500, 502, 503, 504)))
            if not transient or n == attempts:
                raise
            emit({'id': item_id, 'pct': 0, 'done': False, 'in_progress': True,
                  'msg': f'network hiccup, retry {n}/{attempts - 1} in {int(delay)}s…',
                  'total_done_mb': total_done_mb_ref[0]})
            time.sleep(delay + random.uniform(0, 2))
            delay = min(delay * 2, 120)


def download_hf(item_id, repo, expected_mb, total_done_mb_ref):
    """Use huggingface_hub.snapshot_download. A background thread emits
    progress events every second based on actual cache growth, so the
    UI never looks frozen even on multi-GB repos. Transient network/server
    errors are retried with backoff (_with_retry); a rate-limit falls back
    to the embedded read-only token."""
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
    def _dl(tok):
        return snapshot_download(repo_id=repo, resume_download=True,
                                 max_workers=4, token=tok,
                                 allow_patterns=ALLOW_PATTERNS.get(repo))
    try:
        token = _hf_token()
        try:
            _with_retry(lambda: _dl(token), item_id, total_done_mb_ref)
        except HfHubHTTPError:
            # Rate-limit / auth that survived the retries — try once with the
            # embedded read-only fallback token if we have one and weren't
            # already using a token (also retried on transient failures).
            if not token and HF_FALLBACK_TOKEN:
                emit({'id': item_id, 'pct': 0, 'done': False,
                      'in_progress': True, 'msg': 'retrying with fallback token',
                      'total_done_mb': total_done_mb_ref[0]})
                _with_retry(lambda: _dl(HF_FALLBACK_TOKEN), item_id, total_done_mb_ref)
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
    _attempt = 0
    while True:
        _attempt += 1
        try:
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
            break
        except Exception as e:
            if _attempt >= 3:
                raise
            emit({'id': item_id, 'pct': 0, 'done': False, 'in_progress': True,
                  'msg': f'download hiccup, retry {_attempt}/2…',
                  'total_done_mb': total_done_mb_ref[0]})
            time.sleep(3 * _attempt)
    total_done_mb_ref[0] += expected_mb
    emit({'id': item_id, 'pct': 100, 'done': True,
          'total_done_mb': total_done_mb_ref[0]})


def _hub_cache_root():
    """Absolute path of the HF hub cache, honoring HUGGINGFACE_HUB_CACHE /
    HF_HOME exactly like _hf_cache_size_mb does."""
    return (os.environ.get('HUGGINGFACE_HUB_CACHE')
            or (os.path.join(os.environ['HF_HOME'], 'hub')
                if os.environ.get('HF_HOME')
                else os.path.expanduser('~/.cache/huggingface/hub')))


def _dinov3_canonical_root():
    return os.path.join(
        _hub_cache_root(),
        'models--' + DINOV3_CANONICAL_REPO.replace('/', '--'))


def _dinov3_already_staged():
    """True when config.json + model.safetensors are present under the
    canonical facebook/… cache folder (so from_pretrained resolves locally)."""
    try:
        root = _dinov3_canonical_root()
        ref = os.path.join(root, 'refs', 'main')
        if not os.path.isfile(ref):
            return False
        with open(ref, 'r', encoding='utf-8') as f:
            rev = f.read().strip()
        snap = os.path.join(root, 'snapshots', rev)
        return (os.path.isfile(os.path.join(snap, 'config.json'))
                and os.path.isfile(os.path.join(snap, 'model.safetensors')))
    except Exception:
        return False


def _stage_dinov3_canonical(src_dir):
    """Copy the mirror's files into the canonical HF cache layout for the
    GATED facebook repo so DINOv3ViTModel.from_pretrained(canonical_id)
    resolves them locally — no Meta token, no GatedRepoError — when the
    runtime loads offline (HF_HUB_OFFLINE=1 / local_files_only). Plain file
    copies (not symlinks) keep this Windows-safe."""
    import hashlib
    import shutil
    root = _dinov3_canonical_root()
    # Deterministic 40-hex 'revision' — refs/main just has to point at a
    # snapshots/<rev>/ dir that exists; the value itself is never verified.
    rev = hashlib.sha1(
        ('fabmesh-mirror-' + DINOV3_CANONICAL_REPO).encode()).hexdigest()
    snap = os.path.join(root, 'snapshots', rev)
    os.makedirs(snap, exist_ok=True)
    os.makedirs(os.path.join(root, 'refs'), exist_ok=True)
    for fn in os.listdir(src_dir):
        s = os.path.join(src_dir, fn)
        if not os.path.isfile(s):
            continue
        d = os.path.join(snap, fn)
        if not os.path.exists(d) or os.path.getsize(d) != os.path.getsize(s):
            shutil.copy2(s, d)
    with open(os.path.join(root, 'refs', 'main'), 'w', encoding='utf-8') as f:
        f.write(rev)
    return snap


def _download_dinov3_from_url(base_url):
    """Pull the DINOv3 files from a self-hosted base URL (R2/CDN) into a temp
    dir and return it. config.json + model.safetensors are required; the
    preprocessor is optional (TRELLIS-2 does its own image transforms)."""
    import tempfile
    base = base_url.rstrip('/')
    out = tempfile.mkdtemp(prefix='fabmesh_dinov3_')
    for fn in DINOV3_FILES:
        url = f'{base}/{fn}'
        target = os.path.join(out, fn)
        try:
            req = urllib.request.Request(
                url, headers={'User-Agent': 'fabmesh-wizard/1.0'})
            with urllib.request.urlopen(req, timeout=180) as resp, \
                    open(target, 'wb') as f:
                while True:
                    chunk = resp.read(1024 * 256)
                    if not chunk:
                        break
                    f.write(chunk)
        except Exception:
            # config.json / model.safetensors are mandatory; preprocessor isn't.
            if fn in ('config.json', 'model.safetensors'):
                raise
            try:
                os.path.isfile(target) and os.remove(target)
            except Exception:
                pass
    return out


def download_dinov3(item_id, expected_mb, total_done_mb_ref):
    """Fetch the DINOv3 backbone from a NON-GATED source and stage it where
    TRELLIS-2 expects the Meta-gated canonical repo. ESSENTIAL model: a
    failure here fails the install (correct — the engine can't generate
    without it). Meta's DINOv3 license permits redistribution, so mirroring
    / self-hosting is legitimate."""
    from huggingface_hub import snapshot_download

    if _dinov3_already_staged():
        base = total_done_mb_ref[0]
        for pct in (12, 38, 66, 100):
            emit({'id': item_id, 'pct': pct, 'done': pct >= 100,
                  'in_progress': pct < 100, 'speed_mbps': 0, 'eta': '–',
                  'elapsed_s': 0,
                  'msg': ('DINOv3 already staged' if pct >= 100 else 'verifying…'),
                  'total_done_mb': base + (expected_mb * pct // 100)})
            if pct < 100:
                time.sleep(0.08)
        total_done_mb_ref[0] = base + expected_mb
        return

    emit({'id': item_id, 'pct': 0, 'done': False, 'in_progress': True,
          'elapsed_s': 0, 'total_done_mb': total_done_mb_ref[0]})
    t0 = time.time()
    src = os.environ.get('FABMESH_DINOV3_URL', '').strip()

    if src and '://' in src:
        # Self-hosted base URL (R2 / CDN).
        staged_dir = _download_dinov3_from_url(src)
    else:
        repo = src or DINOV3_MIRROR_REPO
        if not repo or repo.startswith('[') or 'À_COMPLÉTER' in repo:
            raise RuntimeError(
                'No non-gated DINOv3 source configured. Set FABMESH_DINOV3_URL '
                'to a self-hosted copy (HF repo id or base URL of the weight '
                'files). See userTodo "host DINOv3 weights".')
        stop = threading.Event()
        hb = threading.Thread(
            target=_heartbeat,
            args=(item_id, repo, expected_mb, total_done_mb_ref, stop, t0),
            daemon=True)
        hb.start()
        try:
            staged_dir = _with_retry(
                lambda: snapshot_download(
                    repo_id=repo, resume_download=True, max_workers=4,
                    token=_hf_token(), allow_patterns=DINOV3_FILES),
                item_id, total_done_mb_ref)
        finally:
            stop.set()
            hb.join(timeout=2.0)

    _stage_dinov3_canonical(staged_dir)
    dt = max(time.time() - t0, 0.001)
    total_done_mb_ref[0] += expected_mb
    emit({'id': item_id, 'pct': 100, 'done': True,
          'speed_mbps': round(expected_mb / dt, 2), 'eta': '–',
          'elapsed_s': round(dt, 1),
          'msg': 'DINOv3 staged into canonical cache',
          'total_done_mb': total_done_mb_ref[0]})


def main():
    _lower_priority()  # keep the desktop responsive during the multi-GB pull
    ap = argparse.ArgumentParser()
    ap.add_argument('--mode', choices=list(MODELS.keys()), required=True)
    args = ap.parse_args()

    items = MODELS[args.mode]
    total_done = [0]
    failures = []
    for item_id, repo, size in items:
        try:
            if item_id == 'esrgan':
                download_esrgan(item_id, size, total_done)
            elif item_id == 'dinov3':
                download_dinov3(item_id, size, total_done)
            else:
                download_hf(item_id, repo, size, total_done)
        except Exception as e:
            emit({'id': item_id, 'pct': 0, 'done': False, 'error': str(e)})
            failures.append((item_id, str(e)))
            # Keep going so an OPTIONAL model (upscaler / extra captioner)
            # failing doesn't block essentials from downloading.

    essential_failures = [(i, e) for i, e in failures if i not in _OPTIONAL_MODELS]
    if essential_failures:
        # An essential model is missing → DO NOT report success. Emit the
        # error to the UI (so the Retry path fires) and exit non-zero so the
        # Electron promise rejects instead of silently marking setup complete.
        detail = '; '.join(f'{i}: {e}' for i, e in failures)
        emit({'id': '__all__', 'pct': 100, 'done': False, 'error': detail,
              'total_done_mb': total_done[0]})
        sys.stderr.write('wizard_download failed: ' + detail + '\n')
        sys.stderr.flush()
        sys.exit(1)

    # All essentials present. If only optional models failed, warn but proceed.
    done_obj = {'id': '__all__', 'pct': 100, 'done': True,
                'total_done_mb': total_done[0]}
    if failures:
        done_obj['warn'] = '; '.join(f'{i}: {e}' for i, e in failures)
    emit(done_obj)


if __name__ == '__main__':
    main()
