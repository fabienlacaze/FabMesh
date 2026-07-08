"""Provision the SAMPart3D part-segmentation engine on the user's machine.

Optional wizard phase (after the AI + rig engines). Everything lands under
the user-writable data dir (HEAVY_DIR):

  <HEAVY_DIR>/python-segment/   copy of embedded Python + the SAMPart3D stack
                                (torch 2.7.0+cu128 — Blackwell/sm_120 native,
                                a SEPARATE env: its spconv/pointops builds are
                                incompatible with the AI + rig envs' pins)
  <HEAVY_DIR>/SAMPart3D/        the upstream repo clone (patched) + ckpts +
                                a bundled Blender 4.0.0

WHY a full local build (unlike the rig, which is all prebuilt wheels):
SAMPart3D needs two custom-CUDA deps that have NO prebuilt Windows/sm_120
wheel — `pointops` (always source-compiled) and `spconv`+`cumm` (source
build from the Pointcept forks for sm_120). Both REQUIRE a build toolchain:
  • CUDA Toolkit 12.8 (nvcc on PATH)
  • Visual Studio Build Tools (cl.exe / MSVC ≥14.2)
The wizard checks for these up front and fails clearly if missing.

Recipe validated by the 2026-07-08 build-feasibility research:
  - torch 2.7.0+cu128 (same proven Blackwell stack as the rig env)
  - torch-scatter from the PyG cu128 wheel index (no compile)
  - cumm + spconv: source build from Pointcept forks with
    CUMM_CUDA_ARCH_LIST="12.0"  CUMM_DISABLE_JIT=1  SPCONV_DISABLE_JIT=1
    → emits sm_120 kernels.  ⚠ THE FRAGILE STEP (documented Blackwell-spconv
    instability on PTv3). This is the one to watch on a real install.
  - pointops: `python setup.py install` (simple kernels, no sm_120 issue),
    TORCH_CUDA_ARCH_LIST="8.9;12.0".
  - tiny-cuda-nn: NOT built — the repo is patched to use a pure-torch MLP.
  - flash-attn: NOT built — the config is patched to enable_flash=False.
  - HDBSCAN: sklearn (CPU), not RAPIDS cuml — repo patched.
  - Blender 4.0.0 bundled (the render script hardcodes BLENDER_EEVEE, which
    was REMOVED in Blender 4.2 — a user's newer install would break it).

JSONL progress on stdout (same contract as wizard_install_rig.py):
    {"step": "seg-torch", "pct": 12, "done": false, "current": "..."}
    {"step": "done", "pct": 100, "done": true}

Env inputs (set by the Electron main process):
  FABMESH_SEGMENT_DIR   destination (<HEAVY_DIR>/SAMPart3D)
  HF_HOME               HF cache (shared with the rest of the app)
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
import zipfile

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

TORCH_INDEX = 'https://download.pytorch.org/whl/cu128'
PYG_INDEX = 'https://data.pyg.org/whl/torch-2.7.0+cu128.html'
TORCH_PACKAGES = ['torch==2.7.0', 'torchvision==0.22.0']

# Pointcept forks with sm_120 (Blackwell) support — source build.
CUMM_GIT = 'git+https://github.com/Pointcept/cumm.git'
SPCONV_GIT = 'git+https://github.com/Pointcept/spconv.git'
SAMPART3D_GIT = 'https://github.com/Pointcept/SAMPart3D.git'

# Pure-PyPI deps SAMPart3D needs at inference (no compile). sklearn provides
# the CPU HDBSCAN we patch cuml over to. transformers pulls SAM ViT-H.
PYPI_PACKAGES = [
    'numpy<2', 'scipy', 'scikit-learn', 'trimesh>=4.0', 'open3d',
    'opencv-python', 'einops', 'addict', 'timm', 'yapf', 'plyfile',
    'transformers', 'accelerate>=0.30', 'huggingface_hub>=0.34',
    'safetensors', 'pillow>=10', 'tqdm', 'tensorboard', 'tensorboardx',
    'ninja', 'setuptools', 'wheel', 'packaging',
]

PTV3_REPO = 'yhyang-myron/SAMPart3D'
PTV3_FILE = 'ptv3-object.pth'
SAM_REPO = 'facebook/sam-vit-huge'
BLENDER_URL = ('https://download.blender.org/release/Blender4.0/'
               'blender-4.0.0-windows-x64.zip')
BLENDER_ZIP_ROOT = 'blender-4.0.0-windows-x64'   # top dir inside the zip


def emit(obj):
    sys.stdout.write(json.dumps(obj) + '\n')
    sys.stdout.flush()


def _run(args, step, env=None):
    emit({'step': step, 'pct': 0, 'done': False,
          'msg': ' '.join(str(a) for a in args[-3:])})
    proc = subprocess.Popen(
        args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        encoding='utf-8', errors='replace',
        env={**os.environ, **(env or {})})
    tail = []
    for line in proc.stdout:
        line = line.rstrip()
        tail.append(line)
        if len(tail) > 30:
            tail = tail[-30:]
        if any(k in line for k in ('Downloading', 'Building', 'Installing collected', 'Compiling', 'nvcc')):
            emit({'step': step, 'pct': 50, 'done': False, 'current': line[:120]})
    proc.wait()
    if proc.returncode != 0:
        ctx = '\n'.join(tail)
        if 'no space left' in ctx.lower() or 'errno 28' in ctx.lower():
            raise RuntimeError('Not enough free disk space.\n\n' + ctx)
        raise RuntimeError(f'step {step} failed (exit {proc.returncode}):\n{ctx}')


def _which(name):
    from shutil import which
    return which(name)


def _cuda_home(prefer='12.8'):
    """torch 2.7+cu128 est compilé pour CUDA 12.8 : les extensions (pointops,
    spconv) DOIVENT être compilées avec un nvcc de MÊME version majeure (12),
    sinon PyTorch cpp_extension refuse (« detected CUDA version mismatches »).
    On force donc CUDA 12.8 même si un CUDA 13.x est premier sur le PATH."""
    import glob
    base = r'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA'
    cand = os.path.join(base, 'v' + prefer)
    if os.path.isdir(cand):
        return cand
    for pat in (os.path.join(base, 'v12.*'), os.path.join(base, 'v*')):
        hits = sorted(glob.glob(pat))
        if hits:
            return hits[-1]
    return None


def _check_build_toolchain():
    """pointops + spconv are source-compiled → need nvcc (CUDA Toolkit) and
    MSVC (cl.exe). Fail early + clearly rather than deep inside a pip build."""
    missing = []
    # Require a CUDA 12.x install specifically (torch cu128 needs major 12) —
    # NOT just any nvcc on PATH (a CUDA 13.x could be first and would mismatch).
    if not _cuda_home('12.8'):
        missing.append('CUDA Toolkit 12.8 (not found under '
                       'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.8)')
    # cl.exe is only on PATH inside a VS dev shell; also probe common installs.
    has_cl = bool(_which('cl'))
    if not has_cl:
        import glob
        pats = [
            r'C:\Program Files\Microsoft Visual Studio\*\*\VC\Tools\MSVC\*\bin\Hostx64\x64\cl.exe',
            r'C:\Program Files (x86)\Microsoft Visual Studio\*\*\VC\Tools\MSVC\*\bin\Hostx64\x64\cl.exe',
        ]
        has_cl = any(glob.glob(p) for p in pats)
    if not has_cl:
        missing.append('Visual Studio Build Tools (MSVC / cl.exe)')
    if missing:
        raise RuntimeError(
            'Part segmentation needs a C++/CUDA build toolchain that is not '
            'installed:\n  - ' + '\n  - '.join(missing) +
            '\n\nInstall "Visual Studio Build Tools" (Desktop C++) and the '
            'CUDA Toolkit 12.8, then re-run this setup step. (These are only '
            'needed for the SAMPart3D part-segmentation engine — the rest of '
            'FabMesh does not require them.)')


# ---------------------------------------------------------------------------
# Repo patches (kept in sync with modal_app/_patch_sampart3d.py):
#  1. enable_flash=True → False        (no flash-attn build)
#  2. cuml HDBSCAN → sklearn HDBSCAN   (no RAPIDS)
#  3. import tinycudann as tcnn → pure-torch MLP shim  (no tcnn build)
# ---------------------------------------------------------------------------
_TCNN_SHIM = '''# import tinycudann as tcnn  # FabMesh: pure-torch MLP (sm_120, no tcnn build)
import torch.nn as _fab_nn


class _FabTcnn:
    class Network(_fab_nn.Module):
        def __init__(self, n_input_dims, n_output_dims, network_config=None, **_kw):
            super().__init__()
            cfg = network_config or {}
            w = int(cfg.get("n_neurons", 128))
            h = int(cfg.get("n_hidden_layers", 2))
            layers = [_fab_nn.Linear(n_input_dims, w), _fab_nn.ReLU()]
            for _ in range(max(0, h - 1)):
                layers += [_fab_nn.Linear(w, w), _fab_nn.ReLU()]
            layers.append(_fab_nn.Linear(w, n_output_dims))
            self.net = _fab_nn.Sequential(*layers)

        def forward(self, x):
            return self.net(x.float())


tcnn = _FabTcnn'''


def _patch_repo(root):
    flash_pat = re.compile(r'enable_flash\s*=\s*True')
    tcnn_pat = re.compile(r'^import\s+tinycudann\s+as\s+tcnn\s*$', re.MULTILINE)
    cuml_pats = [
        re.compile(r'from\s+cuml\.cluster\.hdbscan\s+import\s+HDBSCAN'),
        re.compile(r'from\s+cuml\.cluster\s+import\s+HDBSCAN'),
        re.compile(r'from\s+cuml\s+import\s+HDBSCAN'),
    ]
    nf = nh = nt = 0
    for dp, _dirs, files in os.walk(root):
        if os.sep + '.git' in dp:
            continue
        for fn in files:
            if not fn.endswith('.py'):
                continue
            p = os.path.join(dp, fn)
            try:
                src = open(p, 'r', encoding='utf-8').read()
            except Exception:
                continue
            orig = src
            src, c = flash_pat.subn('enable_flash=False', src); nf += c
            for cp in cuml_pats:
                src, c = cp.subn('from sklearn.cluster import HDBSCAN', src); nh += c
            src, c = tcnn_pat.subn(lambda _m: _TCNN_SHIM, src); nt += c
            if src != orig:
                open(p, 'w', encoding='utf-8').write(src)
    emit({'step': 'seg-patch', 'pct': 60, 'done': False,
          'msg': f'flash x{nf}, hdbscan x{nh}, tcnn x{nt}'})


def _download_blender(dest_repo):
    blender_dir = os.path.join(dest_repo, 'blender')
    if os.path.isfile(os.path.join(blender_dir, 'blender.exe')):
        emit({'step': 'seg-blender', 'pct': 90, 'done': False, 'msg': 'already present'})
        return
    emit({'step': 'seg-blender', 'pct': 85, 'done': False, 'msg': 'downloading Blender 4.0.0 (~300 MB)'})
    os.makedirs(dest_repo, exist_ok=True)
    tmp_zip = os.path.join(dest_repo, '_blender.zip')
    with urllib.request.urlopen(BLENDER_URL, timeout=120) as r, open(tmp_zip, 'wb') as f:
        shutil.copyfileobj(r, f)
    with zipfile.ZipFile(tmp_zip) as z:
        z.extractall(dest_repo)
    os.remove(tmp_zip)
    extracted = os.path.join(dest_repo, BLENDER_ZIP_ROOT)
    if os.path.isdir(extracted):
        if os.path.isdir(blender_dir):
            shutil.rmtree(blender_dir, ignore_errors=True)
        os.rename(extracted, blender_dir)
    if not os.path.isfile(os.path.join(blender_dir, 'blender.exe')):
        raise RuntimeError('Blender 4.0.0 extraction failed (blender.exe missing)')
    emit({'step': 'seg-blender', 'pct': 92, 'done': False, 'msg': 'ok'})


def _download_checkpoints(dest_repo):
    from huggingface_hub import hf_hub_download, snapshot_download
    # ptv3-object.pth (452 MB) → <repo>/ckpts/
    dest = os.path.join(dest_repo, 'ckpts', PTV3_FILE)
    if not (os.path.isfile(dest) and os.path.getsize(dest) > 1024 * 1024):
        emit({'step': 'seg-ckpt', 'pct': 93, 'done': False, 'msg': 'ptv3-object.pth (452 MB)'})
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        got = hf_hub_download(repo_id=PTV3_REPO, filename=PTV3_FILE,
                              local_dir=os.path.join(dest_repo, '_hf_staging'))
        shutil.move(got, dest)
        shutil.rmtree(os.path.join(dest_repo, '_hf_staging'), ignore_errors=True)
    # SAM ViT-H (~2.5 GB) → HF cache (the dataset instantiates it via transformers).
    emit({'step': 'seg-sam', 'pct': 96, 'done': False, 'msg': 'SAM ViT-H (~2.5 GB, first run only)'})
    snapshot_download(repo_id=SAM_REPO)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--python', default=sys.executable)
    ap.add_argument('--skip-deps', action='store_true')
    args = ap.parse_args()
    py = args.python

    dest_repo = os.environ.get('FABMESH_SEGMENT_DIR', '')
    if not dest_repo:
        emit({'step': 'error', 'pct': 0, 'done': True, 'error': 'FABMESH_SEGMENT_DIR not set'})
        sys.exit(2)

    # Step 0: build toolchain check (nvcc + MSVC) — fail fast if missing.
    if not args.skip_deps:
        _check_build_toolchain()

    # Step 1: pip bootstrap
    emit({'step': 'seg-pip-bootstrap', 'pct': 0, 'done': False})
    try:
        subprocess.check_call([py, '-m', 'pip', '--version'],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        getpip = os.path.join(os.path.dirname(py), 'get-pip.py')
        if os.path.isfile(getpip):
            subprocess.check_call([py, getpip, '--no-warn-script-location'])
        else:
            emit({'step': 'error', 'pct': 0, 'done': True,
                  'error': f'pip missing and no get-pip.py at {getpip}'})
            sys.exit(3)

    # Step 2: clone SAMPart3D (needed early — pointops lives inside it)
    emit({'step': 'seg-clone', 'pct': 5, 'done': False, 'msg': dest_repo})
    if not os.path.isdir(os.path.join(dest_repo, '.git')):
        parent = os.path.dirname(dest_repo.rstrip('/\\'))
        os.makedirs(parent, exist_ok=True)
        _run(['git', 'clone', '--depth', '1', SAMPART3D_GIT, dest_repo], step='seg-clone')
    # Apply the 3 patches (flash/hdbscan/tcnn) BEFORE any import of the model.
    _patch_repo(dest_repo)

    # CUDA 12.8 env for ALL source builds (must match torch cu128, not the
    # CUDA 13.x that may be first on the PATH).
    cuda_home = _cuda_home('12.8')
    cuda_env = {}
    if cuda_home:
        cuda_env = {
            'CUDA_HOME': cuda_home,
            'CUDA_PATH': cuda_home,
            'PATH': os.path.join(cuda_home, 'bin') + os.pathsep + os.environ.get('PATH', ''),
        }
        emit({'step': 'seg-cuda', 'pct': 8, 'done': False, 'msg': f'building against {cuda_home}'})

    if not args.skip_deps:
        # Step 3: torch 2.7.0 + cu128 (Blackwell-native)
        _run([py, '-m', 'pip', 'install', '--index-url', TORCH_INDEX, *TORCH_PACKAGES], step='seg-torch')
        # Step 4: torch-scatter (prebuilt cu128 wheel, no compile)
        _run([py, '-m', 'pip', 'install', '--find-links', PYG_INDEX, 'torch-scatter'], step='seg-scatter')
        # Step 5: pure-PyPI deps
        _run([py, '-m', 'pip', 'install', *PYPI_PACKAGES], step='seg-pypi')
        # Step 6: cumm + spconv for sm_120 — THE FRAGILE STEP (source build).
        build_env = {
            **cuda_env,
            'CUMM_CUDA_VERSION': '128',
            'CUMM_CUDA_ARCH_LIST': '12.0',
            'CUMM_DISABLE_JIT': '1',
            'SPCONV_DISABLE_JIT': '1',
            'TORCH_CUDA_ARCH_LIST': '8.9;12.0',
        }
        _run([py, '-m', 'pip', 'install', CUMM_GIT], step='seg-cumm', env=build_env)
        _run([py, '-m', 'pip', 'install', SPCONV_GIT], step='seg-spconv', env=build_env)
        # Step 7: pointops (compiled inside the repo, cwd=libs/pointops)
        _build_pointops(py, dest_repo, cuda_env)

    # Step 8: Blender 4.0.0 (bundled — newer Blenders break the render script)
    _download_blender(dest_repo)

    # Step 9: checkpoints (ptv3-object.pth + SAM ViT-H)
    _download_checkpoints(dest_repo)

    emit({'step': 'done', 'pct': 100, 'done': True})


def _build_pointops(py, dest_repo, cuda_env=None):
    """pointops setup.py must run with cwd=libs/pointops."""
    pointops = os.path.join(dest_repo, 'libs', 'pointops')
    emit({'step': 'seg-pointops', 'pct': 75, 'done': False, 'msg': 'compiling knn kernels'})
    proc = subprocess.Popen(
        [py, 'setup.py', 'install'], cwd=pointops,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        encoding='utf-8', errors='replace',
        env={**os.environ, **(cuda_env or {}),
             'TORCH_CUDA_ARCH_LIST': '8.9;12.0', 'DISTUTILS_USE_SDK': '1'})
    tail = []
    for line in proc.stdout:
        tail.append(line.rstrip())
        if len(tail) > 30:
            tail = tail[-30:]
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError('pointops compile failed:\n' + '\n'.join(tail))


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        emit({'step': 'error', 'pct': 0, 'done': True, 'error': str(e)})
        sys.exit(1)
