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


WHEELS_INDEX = 'https://wheels.fabmesh.com/simple/'
PYPI_INDEX   = 'https://pypi.org/simple/'

# Wheels we ship pre-built (~5 GB total). All for Win+CUDA12+Py3.11.
COMPILED_WHEELS = [
    'torch==2.7.0+cu128',
    'torchvision==0.22.0+cu128',
    'flash-attn==2.7.0+cu128',
    'kaolin==0.16.0+cu128',
    'xformers==0.0.28+cu128',
]

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


def _run(args, step):
    """Run a subprocess and stream a coarse progress event on each
    pip output line containing 'Downloading' / 'Installing'."""
    emit({'step': step, 'pct': 0, 'done': False, 'msg': ' '.join(args[-3:])})
    proc = subprocess.Popen(args, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, text=True,
                             encoding='utf-8', errors='replace')
    seen_pkgs = set()
    total = max(len(COMPILED_WHEELS) + len(PYPI_PACKAGES), 1)
    for line in proc.stdout:
        line = line.rstrip()
        if 'Downloading' in line or 'Installing collected packages' in line:
            for token in line.split():
                if '==' in token or token.endswith('.whl'):
                    seen_pkgs.add(token.split('-')[0].split('==')[0].lower())
            pct = min(99, round(len(seen_pkgs) * 100 / total, 1))
            emit({'step': step, 'pct': pct, 'done': False,
                  'current': line[:120]})
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f'pip exited {proc.returncode} on step {step}')


def main():
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

    # Step 2: compiled wheels from our CDN
    if not args.skip_wheels:
        _run([py, '-m', 'pip', 'install', '--no-deps',
              '--index-url', WHEELS_INDEX,
              '--extra-index-url', PYPI_INDEX,  # fallback if CDN down
              *COMPILED_WHEELS], step='wheels')

    # Step 3: pure-Python / lightweight from PyPI
    _run([py, '-m', 'pip', 'install', *PYPI_PACKAGES], step='pypi')

    emit({'step': 'done', 'pct': 100, 'done': True})


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        emit({'step': 'error', 'pct': 0, 'done': True, 'error': str(e)})
        sys.exit(1)
