"""Install Python dependencies (wheels + pip packages) into the
embedded Python interpreter shipped with FabMesh.

Run between the wizard's "Mode" and "Download" steps. The flow is:

  1. Bootstrap pip into the embedded Python (only once).
  2. Install heavy compiled wheels from FabMesh's CDN
     (torch, flash-attn, kaolin, xformers — pre-built for Win+CUDA12+Py3.11).
  3. Install lightweight pure-Python packages from PyPI
     (diffusers, transformers, huggingface_hub, etc.).

Streams JSONL progress on stdout so the Electron main process can
forward updates to the wizard UI:
    {"step": "pip-bootstrap", "pct": 0, "done": false}
    {"step": "wheels",        "pct": 35, "done": false, "current": "flash-attn"}
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
# NVIDIA kaolin pre-built wheels for Windows + CUDA.
KAOLIN_INDEX = 'https://nvidia-kaolin.s3.us-east-2.amazonaws.com/torch-2.7.0_cu128.html'
# Standard PyPI for everything else.
PYPI_INDEX = 'https://pypi.org/simple/'
# Optional fallback mirror — gitignored token will be filled later.
FABMESH_WHEELS_INDEX = 'https://wheels.fabmesh.com/simple/'

# torch + torchvision: official PyTorch CUDA 12.8 binaries. ~2.5 GB total.
TORCH_PACKAGES = [
    'torch==2.7.0',
    'torchvision==0.22.0',
]

# Compiled wheels available pre-built (no FabMesh R2 needed):
#   flash-attn: Dao-AILab publishes Win+CUDA12 wheels on GitHub Releases
#               (handled via a specific --find-links URL once we pick one).
#   xformers:   PyPI ships Win+CUDA12 binaries directly.
#   kaolin:     NVIDIA publishes Win+CUDA12 wheels (kaolin index above).
COMPILED_WHEELS_NVIDIA = [
    'xformers==0.0.30',  # ships as binary wheel for Win+cu128
    'kaolin',            # picked up from the kaolin index
]

# flash-attn Windows wheels: Dao-AILab uploads them to GitHub Releases,
# not PyPI. We pin a specific known-good build via direct URL — pip
# accepts a .whl URL as an argument.
FLASH_ATTN_WHL = (
    'https://github.com/Dao-AILab/flash-attention/releases/download/'
    'v2.7.0/flash_attn-2.7.0-cp311-cp311-win_amd64.whl'
)

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


_TOTAL_STEPS = (len(TORCH_PACKAGES) + len(COMPILED_WHEELS_NVIDIA)
                + 1  # flash_attn
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

    # Step 2b: REQUIRED — pure-Python / lightweight from PyPI
    _run([py, '-m', 'pip', 'install', *PYPI_PACKAGES], step='pypi')

    # Step 2c: OPTIONAL — xformers (perf boost). If it fails, PyTorch SDPA
    # is used as a slower fallback. Non-blocking.
    try:
        _run([py, '-m', 'pip', 'install', 'xformers==0.0.30'],
             step='xformers-optional')
    except Exception as e:
        emit({'step': 'xformers-optional', 'pct': 99, 'done': False,
              'warn': f'xformers install failed ({e}) — falling back to SDPA'})

    # Step 2d: SKIPPED — flash-attn install disabled 2026-05-30.
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
            _run([py, '-m', 'pip', 'install', FLASH_ATTN_WHL],
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
