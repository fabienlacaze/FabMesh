"""Install Python dependencies (wheels + pip packages) into the
embedded Python interpreter shipped with FabMesh.

Run between the wizard's "Mode" and "Download" steps. The flow is:

  1. Bootstrap pip into the embedded Python (only once).
  2. Install torch 2.8 + torchvision (PyTorch cu128 official wheels).
  3. Install kaolin (NVIDIA pre-built Win+cu128 wheels).
  4. Install lightweight packages from PyPI (diffusers, transformers, …).
  5. Install the TRELLIS-2 custom CUDA wheels (o-voxel, cumesh,
     flex-gemm, spconv) from the local bundled wheels dir
     (FABMESH_WHEELS_DIR) or the GitHub prerelease — see build/build_wheels.md.

The target env MUST mirror external/TRELLIS2_win/.venv (the dev venv
that runs trellis2_native on the RTX 5080): torch 2.8.0+cu128,
kaolin 0.18.0, NO xformers, NO flash-attn (SDPA backend is
authoritative — see the flash-attn note below).

Streams JSONL progress on stdout so the Electron main process can
forward updates to the wizard UI:
    {"step": "pip-bootstrap", "pct": 0, "done": false}
    {"step": "torch",         "pct": 35, "done": false, "current": "..."}
    {"step": "pypi",          "pct": 90, "done": false, "current": "diffusers"}
    {"step": "done",          "pct": 100, "done": true}

If `--python` is not passed, falls back to `sys.executable` (useful in
dev where we use the system Python).
"""
import argparse
import json
import os
import subprocess
import sys


# PyTorch CUDA 12.8 official wheels (binary only, no compile needed).
TORCH_INDEX = 'https://download.pytorch.org/whl/cu128'
# NVIDIA kaolin pre-built wheels for Windows + CUDA (must match torch).
KAOLIN_INDEX = 'https://nvidia-kaolin.s3.us-east-2.amazonaws.com/torch-2.8.0_cu128.html'
# Standard PyPI for everything else.
PYPI_INDEX = 'https://pypi.org/simple/'
# GitHub prerelease hosting the custom-built TRELLIS-2 wheels
# (direct .whl URLs — pip installs them without any index; sha256 of
# each file is pinned in build/fetch_trellis2_wheels.py).
TRELLIS2_WHEELS_BASE = ('https://github.com/fabienlacaze/MyFabmesh/releases/'
                        'download/trellis2-wheels-v1/')

# torch + torchvision: official PyTorch CUDA 12.8 binaries. ~2.5 GB total.
# 2.8.0 is REQUIRED by TRELLIS-2 native (mirrors external/TRELLIS2_win/.venv).
TORCH_PACKAGES = [
    'torch==2.8.0',
    'torchvision==0.23.0',
]

# kaolin: NVIDIA publishes Win+cu128 cp311 wheels on the kaolin index above
# (verified: kaolin-0.18.0-cp311-cp311-win_amd64.whl). Required by TRELLIS-2.
KAOLIN_PACKAGES = [
    'kaolin==0.18.0',
]

# TRELLIS-2 custom CUDA extensions. NOT on PyPI (spconv-cu128 included) —
# they ship as pre-compiled cp311/win_amd64 wheels (build/build_wheels.md)
# bundled in the installer (FABMESH_WHEELS_DIR env → resources/wheels) with
# the GitHub prerelease as network fallback. Their pure-Python deps
# (triton-windows, pccm, ccimport, …) resolve on PyPI.
TRELLIS2_CUSTOM_WHEELS = [
    'spconv-cu128==2.3.8',
    'cumm-cu128==0.8.2',
    'o-voxel==0.0.1',
    'cumesh==1.0',
    'flex-gemm==0.0.1',
]
TRELLIS2_WHEEL_FILES = [
    'spconv_cu128-2.3.8-cp311-cp311-win_amd64.whl',
    'cumm_cu128-0.8.2-cp311-cp311-win_amd64.whl',
    'o_voxel-0.0.1-cp311-cp311-win_amd64.whl',
    'cumesh-1.0-cp311-cp311-win_amd64.whl',
    'flex_gemm-0.0.1-cp311-cp311-win_amd64.whl',
]

# utils3d: the PyPI project named "utils3d" is a DIFFERENT homonym package.
# TRELLIS-2 needs EasternJournalist/utils3d at this exact commit (same pin
# as the dev venv). Zip archive URL = pip-installable without git.
UTILS3D_ZIP = ('https://github.com/EasternJournalist/utils3d/archive/'
               '9a4eb15e4021b67b12c460c7057d642626897ec8.zip')

# Pure-Python or pip-managed binaries — small + safe to grab from PyPI.
PYPI_PACKAGES = [
    'diffusers>=0.30',
    'transformers>=4.41',
    'huggingface_hub>=0.24',
    'accelerate>=0.30',
    'safetensors>=0.4',
    'pillow>=10',
    'numpy>=1.26,<2.0',
    'scipy>=1.13',
    'trimesh>=4.4',
    'pygltflib>=1.16',
    'opencv-python>=4.9',
    'pyrender>=0.1.45',
    'rembg>=2.0',
    'realesrgan>=0.3.0',
    'basicsr>=1.4',
    # TRELLIS-2 runtime deps (inference path only, no training extras):
    'easydict>=1.13',
    'einops>=0.8',
    'plyfile>=1.0',
    'zstandard>=0.22',
    'tqdm>=4.66',
    UTILS3D_ZIP,
]


def emit(obj):
    sys.stdout.write(json.dumps(obj) + '\n')
    sys.stdout.flush()


def _lower_priority():
    """Drop this process (and the pip children it spawns) to BELOW_NORMAL so
    the ~5 GB torch install doesn't freeze the desktop. Best-effort; no-op off
    Windows or on failure. On Windows the priority class is inherited by
    subprocess.Popen children (no creationflags), so pip stays throttled too.
    Uses the typed-ctypes idiom (restype=c_void_p) required so the 64-bit
    GetCurrentProcess() pseudo-handle isn't truncated → SetPriorityClass works."""
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


_TOTAL_STEPS = (len(TORCH_PACKAGES) + len(KAOLIN_PACKAGES)
                + len(TRELLIS2_CUSTOM_WHEELS)
                + len(PYPI_PACKAGES))


def _run(args, step):
    """Run a subprocess and stream a coarse progress event on each
    pip output line containing 'Downloading' / 'Installing'. On failure,
    include the tail of pip's output so the UI shows WHY (disk full, network,
    etc.) instead of a bare 'pip exited 1'."""
    emit({'step': step, 'pct': 0, 'done': False, 'msg': ' '.join(args[-3:])})
    proc = subprocess.Popen(args, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, text=True,
                             encoding='utf-8', errors='replace')
    seen_pkgs = set()
    tail = []
    for line in proc.stdout:
        line = line.rstrip()
        tail.append(line)
        if len(tail) > 20:
            tail = tail[-20:]
        if 'Downloading' in line or 'Installing collected packages' in line:
            for token in line.split():
                if '==' in token or token.endswith('.whl'):
                    seen_pkgs.add(token.split('-')[0].split('==')[0].lower())
            pct = min(99, round(len(seen_pkgs) * 100 / _TOTAL_STEPS, 1))
            emit({'step': step, 'pct': pct, 'done': False,
                  'current': line[:120]})
    proc.wait()
    if proc.returncode != 0:
        ctx = '\n'.join(tail)
        low = ctx.lower()
        if ('no space left' in low or 'errno 28' in low
                or 'not enough space' in low or 'disk full' in low):
            raise RuntimeError(
                'Not enough free disk space to install the AI engine. Free up '
                'space (or move the data folder to a bigger drive in Settings) '
                'and retry.\n\n' + ctx)
        raise RuntimeError(f'pip exited {proc.returncode} on step {step}:\n{ctx}')


def _install_trellis2_wheels(py):
    """Install the custom TRELLIS-2 CUDA wheels. Tries the local bundled
    wheels dir first (FABMESH_WHEELS_DIR env, set by the Electron wizard when
    the installer ships them), then the GitHub prerelease. REQUIRED for
    the default mesh engine (trellis2_native) — a clear error beats a broken
    install, so failure of both sources aborts the whole step."""
    local_dir = os.environ.get('FABMESH_WHEELS_DIR', '')
    attempts = []
    if local_dir and os.path.isdir(local_dir):
        attempts.append(('trellis2-wheels-local',
                         [py, '-m', 'pip', 'install',
                          '--find-links', local_dir,
                          *TRELLIS2_CUSTOM_WHEELS]))
    attempts.append(('trellis2-wheels-github',
                     [py, '-m', 'pip', 'install',
                      *(TRELLIS2_WHEELS_BASE + f
                        for f in TRELLIS2_WHEEL_FILES)]))
    last_err = None
    for step, args in attempts:
        try:
            _run(args, step=step)
            return
        except Exception as e:
            last_err = e
            emit({'step': step, 'pct': 0, 'done': False,
                  'warn': f'{step} failed, trying next source'})
    raise RuntimeError(
        'Could not install the TRELLIS-2 engine wheels '
        f'({", ".join(TRELLIS2_CUSTOM_WHEELS)}). The 3D mesh engine cannot '
        'run without them. Check your internet connection and retry; if the '
        'problem persists, report it — the FabMesh wheel CDN may be down.\n\n'
        f'Last error: {last_err}')


def main():
    _lower_priority()  # keep the desktop responsive during the ~5 GB install
    ap = argparse.ArgumentParser()
    ap.add_argument('--python', default=sys.executable,
                    help='path to the embedded python.exe; default = current')
    ap.add_argument('--skip-wheels', action='store_true',
                    help='skip the compiled wheels step (dev mode)')
    args = ap.parse_args()

    py = args.python
    if not os.path.isfile(py) and py != sys.executable:
        emit({'step': 'error', 'pct': 0, 'done': True,
              'error': f'python not found at {py}'})
        sys.exit(2)

    # Step 1: bootstrap pip if needed
    emit({'step': 'pip-bootstrap', 'pct': 0, 'done': False})
    try:
        subprocess.check_call([py, '-m', 'pip', '--version'],
                              stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL)
    except Exception:
        getpip = os.path.join(os.path.dirname(py), 'get-pip.py')
        if os.path.isfile(getpip):
            subprocess.check_call([py, getpip, '--no-warn-script-location'])
        else:
            emit({'step': 'error', 'pct': 0, 'done': True,
                  'error': f'pip missing and no get-pip.py at {getpip}'})
            sys.exit(3)

    if args.skip_wheels:
        # Dev mode: just install the pure-Python stuff so we can iterate
        # quickly without re-downloading 2 GB of torch every time.
        _run([py, '-m', 'pip', 'install', *PYPI_PACKAGES], step='pypi')
        emit({'step': 'done', 'pct': 100, 'done': True})
        return

    # Step 2a: REQUIRED — torch + torchvision from PyTorch's CUDA 12.8 index.
    # If this fails, the rest of the install is pointless.
    _run([py, '-m', 'pip', 'install',
          '--index-url', TORCH_INDEX,
          *TORCH_PACKAGES], step='torch')

    # Step 2b: REQUIRED — kaolin from NVIDIA's pre-built wheel index
    # (its pure-Python deps resolve on PyPI via the default index).
    _run([py, '-m', 'pip', 'install',
          '--find-links', KAOLIN_INDEX,
          *KAOLIN_PACKAGES], step='kaolin')

    # Step 2c: REQUIRED — pure-Python / lightweight from PyPI
    _run([py, '-m', 'pip', 'install', *PYPI_PACKAGES], step='pypi')

    # Step 2d: REQUIRED — TRELLIS-2 custom CUDA wheels (o-voxel, cumesh,
    # flex-gemm, spconv). Local bundled dir first, GitHub release fallback.
    _install_trellis2_wheels(py)

    # NOTE: NO xformers. The dev venv runs TRELLIS-2 on the SDPA backend
    # without it, and xformers wheels pin their own torch build — installing
    # one compiled for another torch would silently downgrade torch 2.8.0
    # and break kaolin/spconv. Do not add it back without pinning a build
    # that matches torch 2.8.0+cu128 exactly.

    # Step 2e: SKIPPED — flash-attn install disabled 2026-05-30.
    # Windows Smart App Control (SAC) blocks flash_attn_2_cuda.dll on this
    # target hardware and the user formally prohibited disabling SAC. The
    # TRELLIS-2 codebase guards every `import flash_attn` behind
    # `if config.BACKEND == 'flash_attn'`, and the Electron spawn env now
    # forces ATTN_BACKEND=sdpa + SPARSE_ATTN_BACKEND=sdpa authoritatively,
    # so flash_attn is never imported. The Blackwell-correct SDPA path
    # (modules/sparse/attention/full_attn.py:214-254 fp32-math branch)
    # produces correct results on sm_120. To re-enable, set
    # WIZARD_INSTALL_FLASH_ATTN=1 in the env before running this script.
    if os.environ.get('WIZARD_INSTALL_FLASH_ATTN') == '1':
        try:
            _run([py, '-m', 'pip', 'install',
                  'https://github.com/Dao-AILab/flash-attention/releases/download/'
                  'v2.7.0/flash_attn-2.7.0-cp311-cp311-win_amd64.whl'],
                 step='flash-attn-optional')
        except Exception as e:
            emit({'step': 'flash-attn-optional', 'pct': 99, 'done': False,
                  'warn': f'flash-attn install failed ({e}) — using slower attention'})
    else:
        emit({'step': 'flash-attn-optional', 'pct': 99, 'done': False,
              'msg': 'skipped (SAC-blocked; sdpa backend is authoritative)'})

    emit({'step': 'done', 'pct': 100, 'done': True})


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        emit({'step': 'error', 'pct': 0, 'done': True, 'error': str(e)})
        sys.exit(1)
