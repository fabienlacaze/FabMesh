# FabMesh — custom wheels build pipeline

The libraries below ship as **pre-compiled `.whl` files** on FabMesh's
own CDN (Cloudflare R2). The wizard pulls them on first run via
`pip install --no-deps --index-url=https://wheels.fabmesh.com/`,
skipping the painful "compile from source on the user's machine"
path that breaks 80% of Windows installs.

You only need to rebuild these wheels when bumping torch / Python /
CUDA. Once a wheel set is on the CDN, every user downloads the same
binary — zero compile risk.

## Target environment (must match exactly)

| Component | Version |
|---|---|
| OS | Windows 10/11 x64 |
| Python | 3.11.9 (embedded distribution) |
| CUDA | 12.8 (matches RTX 5080 driver baseline 550+) |
| MSVC | Visual Studio Build Tools 2022 (v143) |

## Wheels to build

| Package | Version | Source |
|---|---|---|
| `torch` | 2.7.0+cu128 | pypi/pytorch-cu128 (no rebuild — just mirror) |
| `torchvision` | matching | pypi/pytorch-cu128 |
| `flash-attn` | 2.7.0+cu128 | Dao-AILab/flash-attention (rebuild required) |
| `kaolin` | 0.16.0+cu128 | NVIDIAGameWorks/kaolin (rebuild required) |
| `xformers` | 0.0.28+cu128 | facebookresearch/xformers (rebuild required) |

## Build on GitHub Actions (recommended)

A workflow `.github/workflows/build-wheels.yml` (TBD) spawns a
`windows-2022` runner with CUDA 12.8 installed via
[Jimver/cuda-toolkit-action](https://github.com/Jimver/cuda-toolkit-action),
then runs:

```bat
:: Install Python 3.11 + dependencies
choco install python --version=3.11.9
python -m pip install --upgrade pip wheel setuptools

:: Build flash_attn
git clone --depth 1 -b v2.7.0 https://github.com/Dao-AILab/flash-attention
cd flash-attention
set MAX_JOBS=4
pip wheel . --no-deps -w ../dist
cd ..

:: Build kaolin
git clone --depth 1 -b v0.16.0 https://github.com/NVIDIAGameWorks/kaolin
cd kaolin
python setup.py bdist_wheel
copy dist\*.whl ..\dist\
cd ..

:: Build xformers
pip wheel xformers==0.0.28 --no-binary=xformers -w dist/
```

The runner uploads `dist/*.whl` to Cloudflare R2 via
`rclone copy dist/ r2:fabmesh-wheels/`. Done.

## Manual build (Windows dev)

Same steps locally, requires:

- VS 2022 Build Tools with C++ workload
- CUDA Toolkit 12.8
- Python 3.11.9 (from python.org, not embedded)
- ~30-60 min per wheel on first build

## Index file format

The CDN serves a flat PEP-503 index at
`https://wheels.fabmesh.com/simple/`:

```
wheels.fabmesh.com/
├── simple/
│   ├── flash-attn/index.html      (links to .whl)
│   ├── kaolin/index.html
│   └── xformers/index.html
└── files/
    ├── flash_attn-2.7.0+cu128-cp311-cp311-win_amd64.whl
    └── ...
```

Generate with `dumb-pypi` or by hand from a flat directory.

## First-run install flow (in the wizard)

```
1. Setup wizard ready to download models
2. main.js calls scripts/wizard_install_deps.py
3. wizard_install_deps.py runs:
   python -m pip install --no-deps \
     --index-url=https://wheels.fabmesh.com/simple/ \
     torch torchvision flash-attn kaolin xformers
4. Then: pip install (regular pypi) diffusers transformers huggingface_hub
5. Wizard continues to model download step
```

## Cost on Cloudflare R2

- ~5 GB of wheels total
- Free tier: 10 GB storage + 10 GB egress/month
- Each user downloads ~5 GB once → 2 users/month = at the limit
- Above ~1000 users: ~$0.36/GB egress = manageable

## Fallback

If `wheels.fabmesh.com` is unreachable, the wizard falls back to
PyPI direct (slower, may need to compile) and shows a warning. Never
fails silently.
