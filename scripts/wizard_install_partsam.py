"""Provision the PartSAM part-segmentation engine on the user's machine.

PartSAM (MIT, feedforward ~40-90 s/mesh) REPLACES SAMPart3D (per-mesh
optimisation ~4 min). It runs natively on Blackwell / sm_120 (RTX 5080).
Everything lands under the user-writable data dir (HEAVY_DIR):

  <HEAVY_DIR>/python-segment/   the dedicated Python env (torch 2.7.0+cu128 —
                                SHARED name with the old SAMPart3D env, but its
                                torch/torkit3d/pointops pins are incompatible
                                with the AI + rig envs, hence still separate)
  <HEAVY_DIR>/PartSAM/          the upstream repo clone (patched) +
                                pretrained/model.safetensors (~900 MB)

WHY this is much lighter than the SAMPart3D wizard:
  - NO Blender (PartSAM is native-3D feedforward: no multi-view render).
  - NO SAM ViT-H (no 2D SAM stage).
  - NO spconv / cumm (PartField backbone here is a PURE-torch PVCNN).
  - NO apex (bypassed: build.py + torch_utils.py fall back to nn.LayerNorm).
The only custom-CUDA deps are `torkit3d` (FPS / chamfer kernels) and
`pointops` (knn_query / farthest_point_sampling). Both are installed
IDEALLY as pre-built sm_120 wheels hosted on a GitHub release
(download-only, no toolchain needed — same pattern as the TRELLIS-2
wheels), and ONLY fall back to a source build (needs CUDA Toolkit 12.8 +
MSVC) when those wheels are unavailable.

Recipe validated 2026-07-08 on the RTX 5080 (see AGENT_LOG "PIVOT #2"):
  - torch 2.7.0+cu128, torch-scatter from the PyG cu128 wheel index.
  - deps: hydra-core omegaconf loguru igraph open3d boto3 h5py scikit-image
    simple_parsing arrgh safetensors timm einops trimesh (+ accelerate,
    matplotlib, tqdm, networkx, scipy, numpy at inference). NOT
    lightning / polyscope / potpourri3d / libigl (Windows build failures,
    unused at inference).
  - torkit3d + pointops: sm_120 wheels (download-only) else source build
    (vcvars64 + CUDA 12.8 + TORCH_CUDA_ARCH_LIST="8.9;12.0").
  - weights: HF Czvvd/PartSAM -> pretrained/model.safetensors.

JSONL progress on stdout (same contract as wizard_install_segment.py):
    {"step": "ps-torch", "pct": 20, "done": false, "current": "..."}
    {"step": "done", "pct": 100, "done": true}

Env inputs (set by the Electron main process):
  FABMESH_PARTSAM_DIR              destination (<HEAVY_DIR>/PartSAM)
  FABMESH_PARTSAM_BUILD_FROM_SOURCE=1   skip the wheels, force a source build
  HF_HOME                         HF cache (shared with the rest of the app)
"""
import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

TORCH_INDEX = 'https://download.pytorch.org/whl/cu128'
PYG_INDEX = 'https://data.pyg.org/whl/torch-2.7.0+cu128.html'
TORCH_PACKAGES = ['torch==2.7.0', 'torchvision==0.22.0']

PARTSAM_GIT = 'https://github.com/czvvd/PartSAM.git'
# Source-build fallbacks for the two custom-CUDA extensions.
TORKIT3D_GIT = 'https://github.com/Jiayuan-Gu/torkit3d.git'
# pointops has no standalone release: it lives in Pointcept's tree at
# libs/pointops (the exact variant PartSAM's README points to).
POINTOPS_GIT = 'https://github.com/Pointcept/SAMPart3D.git'

# Pre-built sm_120 wheels (download-only path). Hosted as assets of a GitHub
# PRERELEASE so electron-updater's /releases/latest never picks them up — same
# scheme as build/fetch_trellis2_wheels.py's trellis2-wheels-v1. The wizard
# discovers the asset filenames from the release (no hard-coded version/sha256),
# so re-uploading a rebuilt wheel just works.
WHEELS_REPO = 'fabienlacaze/MyFabmesh'
WHEELS_TAG = 'partsam-wheels-v1'

# Pure-PyPI deps PartSAM needs at inference (no compile). Mirrors the AGENT_LOG
# "PIVOT #2" list + the modules eval_everypart.py actually imports (accelerate,
# matplotlib, tqdm, networkx, scipy). Deliberately WITHOUT lightning / polyscope
# / potpourri3d / libigl (Windows scikit-build failures, training-only).
PYPI_PACKAGES = [
    'numpy<2', 'scipy', 'hydra-core', 'omegaconf', 'loguru', 'igraph',
    'open3d', 'boto3', 'h5py', 'scikit-image', 'simple_parsing', 'arrgh',
    'safetensors', 'timm', 'einops', 'trimesh>=4.0', 'accelerate>=0.30',
    'matplotlib', 'tqdm', 'networkx', 'huggingface_hub>=0.34',
    'setuptools', 'wheel', 'packaging', 'ninja',
]

HF_WEIGHTS_REPO = 'Czvvd/PartSAM'
WEIGHTS_FILE = 'model.safetensors'


def emit(obj):
    sys.stdout.write(json.dumps(obj) + '\n')
    sys.stdout.flush()


def _run(args, step, env=None, cwd=None):
    emit({'step': step, 'pct': 0, 'done': False,
          'msg': ' '.join(str(a) for a in args[-3:])})
    proc = subprocess.Popen(
        args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding='utf-8', errors='replace',
        env={**os.environ, **(env or {})})
    tail = []
    for line in proc.stdout:
        line = line.rstrip()
        tail.append(line)
        if len(tail) > 30:
            tail = tail[-30:]
        if any(k in line for k in ('Downloading', 'Building', 'Installing collected',
                                   'Compiling', 'nvcc', 'creating build')):
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
    """torch 2.7+cu128 is compiled for CUDA 12.8: torkit3d / pointops MUST be
    compiled with a MATCHING major (12) nvcc, else PyTorch's cpp_extension
    refuses ("detected CUDA version mismatches"). Force 12.8 even if a CUDA
    13.x is first on the PATH."""
    base = r'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA'
    cand = os.path.join(base, 'v' + prefer)
    if os.path.isdir(cand):
        return cand
    for pat in (os.path.join(base, 'v12.*'), os.path.join(base, 'v*')):
        hits = sorted(glob.glob(pat))
        if hits:
            return hits[-1]
    return None


def _find_vcvars():
    """Locate vcvars64.bat so a source build gets cl.exe on PATH regardless of
    the shell the wizard was launched from."""
    vswhere = (r'C:\Program Files (x86)\Microsoft Visual Studio\Installer'
               r'\vswhere.exe')
    if os.path.isfile(vswhere):
        try:
            out = subprocess.check_output(
                [vswhere, '-latest', '-products', '*', '-requires',
                 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
                 '-property', 'installationPath'],
                text=True, encoding='utf-8', errors='replace').strip()
            if out:
                cand = os.path.join(out, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')
                if os.path.isfile(cand):
                    return cand
        except Exception:
            pass
    pats = [
        r'C:\Program Files\Microsoft Visual Studio\*\*\VC\Auxiliary\Build\vcvars64.bat',
        r'C:\Program Files (x86)\Microsoft Visual Studio\*\*\VC\Auxiliary\Build\vcvars64.bat',
    ]
    for p in pats:
        hits = sorted(glob.glob(p))
        if hits:
            return hits[-1]
    return None


def _vcvars_env(base_env):
    """Return base_env merged with the MSVC x64 environment from vcvars64.bat
    (cl.exe / INCLUDE / LIB). No-op if vcvars can't be found."""
    vc = _find_vcvars()
    if not vc:
        return dict(base_env)
    try:
        out = subprocess.check_output(
            ['cmd', '/c', f'call "{vc}" >nul 2>&1 && set'],
            text=True, encoding='utf-8', errors='replace')
    except Exception:
        return dict(base_env)
    env = dict(base_env)
    for line in out.splitlines():
        if '=' in line:
            k, _, v = line.partition('=')
            env[k] = v
    return env


def _check_build_toolchain():
    """torkit3d + pointops source build needs nvcc (CUDA Toolkit 12.8) and MSVC
    (cl.exe). Fail early + clearly rather than deep inside a pip build."""
    missing = []
    if not _cuda_home('12.8'):
        missing.append('CUDA Toolkit 12.8 (not found under '
                       'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.8)')
    if not (_which('cl') or _find_vcvars()):
        missing.append('Visual Studio Build Tools (MSVC / cl.exe)')
    if missing:
        raise RuntimeError(
            'The pre-built PartSAM CUDA wheels were unavailable, so a source '
            'build is required — but the C++/CUDA toolchain is not installed:\n'
            '  - ' + '\n  - '.join(missing) +
            '\n\nInstall "Visual Studio Build Tools" (Desktop C++) and the CUDA '
            'Toolkit 12.8, then re-run this step. (These are only needed for the '
            'PartSAM part-segmentation engine — the rest of FabMesh does not '
            'require them.)')


# ---------------------------------------------------------------------------
# Repo patches (kept in sync with the dev tree in <repo>/PartSAM):
#  1. build.py         top-level `from apex.normalization import FusedLayerNorm`
#                      -> try/except -> nn.LayerNorm  (apex has no sm_120 build)
#  2. torch_utils.py   in-function apex import -> try/except -> return (no-op)
#  3. eval_everypart   also save results/{id}_labels.npy (per-face labels the
#                      bridge reads to rebuild the part_XX submesh GLB)
# ---------------------------------------------------------------------------
_APEX_MARK = 'FabMesh: apex fallback'
_LABELS_MARK = 'FabMesh: save per-face labels'


def _patch_build_py(path):
    if not os.path.isfile(path):
        return 0
    src = open(path, 'r', encoding='utf-8').read()
    if _APEX_MARK in src:
        return 0
    pat = re.compile(r'^from apex\.normalization import FusedLayerNorm[ \t]*$', re.M)
    repl = ('try:  # ' + _APEX_MARK + ' (apex has no sm_120 build)\n'
            '    from apex.normalization import FusedLayerNorm\n'
            'except Exception:\n'
            '    from torch.nn import LayerNorm as FusedLayerNorm')
    new, c = pat.subn(repl, src, count=1)
    if c:
        open(path, 'w', encoding='utf-8').write(new)
    return c


def _patch_torch_utils(path):
    if not os.path.isfile(path):
        return 0
    src = open(path, 'r', encoding='utf-8').read()
    if _APEX_MARK in src:
        return 0
    pat = re.compile(r'^([ \t]+)from apex\.normalization import FusedLayerNorm[ \t]*$', re.M)

    def _r(m):
        ind = m.group(1)
        return (ind + 'try:  # ' + _APEX_MARK + ' (apex has no sm_120 build)\n'
                + ind + '    from apex.normalization import FusedLayerNorm\n'
                + ind + 'except Exception:\n'
                + ind + '    return')

    new, c = pat.subn(_r, src, count=1)
    if c:
        open(path, 'w', encoding='utf-8').write(new)
    return c


def _patch_eval(path):
    if not os.path.isfile(path):
        return 0
    src = open(path, 'r', encoding='utf-8').read()
    if _LABELS_MARK in src:
        return 0
    pat = re.compile(
        r'^([ \t]+)(mesh_save_path\s*=\s*os\.path\.join\(\s*f?"results",\s*'
        r'f"\{id\}\.ply"\s*\))', re.M)

    def _r(m):
        ind = m.group(1)
        # NOTE: plain (non-f) string so f"{id}_labels.npy" stays literal.
        return (ind + '# ' + _LABELS_MARK + ' to rebuild a part_XX submesh GLB\n'
                + ind + 'os.makedirs("results", exist_ok=True)\n'
                + ind + 'np.save(os.path.join("results", f"{id}_labels.npy"), '
                'np.asarray(mesh_group))\n'
                + ind + m.group(2))

    new, c = pat.subn(_r, src, count=1)
    if c:
        open(path, 'w', encoding='utf-8').write(new)
    return c


def _patch_repo(root):
    n = 0
    n += _patch_build_py(os.path.join(root, 'PartSAM', 'model', 'build.py'))
    n += _patch_torch_utils(os.path.join(root, 'PartSAM', 'utils', 'torch_utils.py'))
    n += _patch_eval(os.path.join(root, 'evaluation', 'eval_everypart.py'))
    emit({'step': 'ps-patch', 'pct': 8, 'done': False,
          'msg': f'{n} patch(es) applied (apex / labels)'})


# ---------------------------------------------------------------------------
# torkit3d + pointops : pre-built wheels (download-only) else source build.
# ---------------------------------------------------------------------------
def _download(url, dest):
    tmp = dest + '.part'
    with urllib.request.urlopen(url, timeout=180) as r, open(tmp, 'wb') as f:
        shutil.copyfileobj(r, f)
    os.replace(tmp, dest)


def _try_prebuilt_wheels(py, workdir):
    """Return True if torkit3d + pointops were installed from hosted sm_120
    wheels; False (falls back to source build) if the release/assets are
    missing or a download/install fails."""
    api = f'https://api.github.com/repos/{WHEELS_REPO}/releases/tags/{WHEELS_TAG}'
    try:
        req = urllib.request.Request(
            api, headers={'User-Agent': 'FabMesh-wizard',
                          'Accept': 'application/vnd.github+json'})
        with urllib.request.urlopen(req, timeout=30) as r:
            rel = json.loads(r.read().decode('utf-8'))
    except Exception as e:
        emit({'step': 'ps-wheels', 'pct': 55, 'done': False,
              'msg': f'no prebuilt wheels ({e}); building from source'})
        return False

    want = {}
    for a in rel.get('assets', []):
        low = a.get('name', '').lower()
        if low.endswith('win_amd64.whl') and low.startswith('torkit3d'):
            want['torkit3d'] = a['browser_download_url']
        elif low.endswith('win_amd64.whl') and low.startswith('pointops'):
            want['pointops'] = a['browser_download_url']
    if 'torkit3d' not in want or 'pointops' not in want:
        emit({'step': 'ps-wheels', 'pct': 55, 'done': False,
              'msg': 'release found but torkit3d/pointops wheels missing; '
                     'building from source'})
        return False

    os.makedirs(workdir, exist_ok=True)
    local = []
    for key, url in want.items():
        dest = os.path.join(workdir, os.path.basename(url))
        emit({'step': 'ps-wheels', 'pct': 60, 'done': False,
              'msg': f'downloading {os.path.basename(url)}'})
        try:
            _download(url, dest)
        except Exception as e:
            emit({'step': 'ps-wheels', 'pct': 60, 'done': False,
                  'msg': f'download failed ({e}); building from source'})
            return False
        local.append(dest)
    try:
        _run([py, '-m', 'pip', 'install', *local], step='ps-wheels')
    except Exception as e:
        emit({'step': 'ps-wheels', 'pct': 65, 'done': False,
              'msg': f'wheel install failed ({e}); building from source'})
        return False
    emit({'step': 'ps-wheels', 'pct': 80, 'done': False,
          'msg': 'torkit3d + pointops installed from prebuilt wheels'})
    return True


def _source_build_cuda_exts(py, workdir):
    """Fallback: compile torkit3d + pointops for sm_120 from source."""
    _check_build_toolchain()
    cuda_home = _cuda_home('12.8')
    build_env = _vcvars_env(os.environ)
    if cuda_home:
        build_env['CUDA_HOME'] = cuda_home
        build_env['CUDA_PATH'] = cuda_home
        build_env['PATH'] = (os.path.join(cuda_home, 'bin') + os.pathsep
                             + build_env.get('PATH', ''))
        emit({'step': 'ps-cuda', 'pct': 56, 'done': False,
              'msg': f'building against {cuda_home}'})
    build_env['TORCH_CUDA_ARCH_LIST'] = '8.9;12.0'   # Ada + Blackwell
    build_env['FORCE_CUDA'] = '1'
    build_env['DISTUTILS_USE_SDK'] = '1'
    os.makedirs(workdir, exist_ok=True)

    # torkit3d (FPS / chamfer). setup.py imports torch -> no build isolation.
    tk = os.path.join(workdir, 'torkit3d_src')
    if not os.path.isdir(os.path.join(tk, '.git')):
        _run(['git', 'clone', '--depth', '1', TORKIT3D_GIT, tk], step='ps-torkit3d')
    _run([py, '-m', 'pip', 'install', '--no-build-isolation', tk],
         step='ps-torkit3d', env=build_env)

    # pointops (knn_query / farthest_point_sampling) from Pointcept/SAMPart3D.
    sp = os.path.join(workdir, 'pointops_src')
    if not os.path.isdir(os.path.join(sp, '.git')):
        _run(['git', 'clone', '--depth', '1', POINTOPS_GIT, sp], step='ps-pointops')
    pointops = os.path.join(sp, 'libs', 'pointops')
    if not os.path.isfile(os.path.join(pointops, 'setup.py')):
        raise RuntimeError('pointops source not found at libs/pointops in '
                           + POINTOPS_GIT)
    _run([py, 'setup.py', 'install'], step='ps-pointops', cwd=pointops,
         env=build_env)


def _install_cuda_exts(py, dest_repo):
    workdir = os.path.join(dest_repo, '_build')
    force_src = os.environ.get('FABMESH_PARTSAM_BUILD_FROM_SOURCE', '') == '1'
    if not force_src and _try_prebuilt_wheels(py, workdir):
        return
    _source_build_cuda_exts(py, workdir)


def _download_weights(dest_repo):
    from huggingface_hub import hf_hub_download, snapshot_download
    dest = os.path.join(dest_repo, 'pretrained', WEIGHTS_FILE)
    if os.path.isfile(dest) and os.path.getsize(dest) > 100 * 1024 * 1024:
        emit({'step': 'ps-weights', 'pct': 95, 'done': False, 'msg': 'already present'})
        return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    emit({'step': 'ps-weights', 'pct': 88, 'done': False,
          'msg': 'PartSAM model.safetensors (~900 MB)'})
    staging = os.path.join(dest_repo, '_hf_staging')
    try:
        got = hf_hub_download(repo_id=HF_WEIGHTS_REPO, filename=WEIGHTS_FILE,
                              local_dir=staging)
        shutil.move(got, dest)
    except Exception:
        d = snapshot_download(repo_id=HF_WEIGHTS_REPO, local_dir=staging)
        hits = glob.glob(os.path.join(d, '**', '*.safetensors'), recursive=True)
        if not hits:
            raise RuntimeError('PartSAM weights: no .safetensors in HF repo '
                               + HF_WEIGHTS_REPO)
        shutil.move(hits[0], dest)
    shutil.rmtree(staging, ignore_errors=True)
    if not (os.path.isfile(dest) and os.path.getsize(dest) > 100 * 1024 * 1024):
        raise RuntimeError('PartSAM weights download failed '
                           '(pretrained/model.safetensors missing or too small)')
    emit({'step': 'ps-weights', 'pct': 98, 'done': False, 'msg': 'ok'})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--python', default=sys.executable)
    ap.add_argument('--skip-deps', action='store_true')
    args = ap.parse_args()
    py = args.python

    dest_repo = os.environ.get('FABMESH_PARTSAM_DIR', '')
    if not dest_repo:
        emit({'step': 'error', 'pct': 0, 'done': True,
              'error': 'FABMESH_PARTSAM_DIR not set'})
        sys.exit(2)

    # Step 1: pip bootstrap
    emit({'step': 'ps-pip-bootstrap', 'pct': 0, 'done': False})
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

    # Step 2: clone PartSAM
    emit({'step': 'ps-clone', 'pct': 5, 'done': False, 'msg': dest_repo})
    if not os.path.isdir(os.path.join(dest_repo, '.git')):
        parent = os.path.dirname(dest_repo.rstrip('/\\'))
        os.makedirs(parent, exist_ok=True)
        _run(['git', 'clone', '--depth', '1', PARTSAM_GIT, dest_repo], step='ps-clone')

    # Step 3: patch the repo (apex bypass + labels dump) BEFORE any model import.
    _patch_repo(dest_repo)

    if not args.skip_deps:
        # Step 4: torch 2.7.0 + cu128 (Blackwell-native)
        _run([py, '-m', 'pip', 'install', '--index-url', TORCH_INDEX,
              *TORCH_PACKAGES], step='ps-torch')
        # Step 5: torch-scatter (prebuilt cu128 wheel, no compile)
        _run([py, '-m', 'pip', 'install', '--find-links', PYG_INDEX,
              'torch-scatter'], step='ps-scatter')
        # Step 6: pure-PyPI deps
        _run([py, '-m', 'pip', 'install', *PYPI_PACKAGES], step='ps-pypi')
        # Step 7: torkit3d + pointops (prebuilt wheels else source build)
        _install_cuda_exts(py, dest_repo)

    # Step 8: weights (Czvvd/PartSAM -> pretrained/model.safetensors)
    _download_weights(dest_repo)

    emit({'step': 'done', 'pct': 100, 'done': True})


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        emit({'step': 'error', 'pct': 0, 'done': True, 'error': str(e)})
        sys.exit(1)
