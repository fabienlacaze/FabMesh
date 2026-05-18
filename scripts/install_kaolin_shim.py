"""Install the FabMesh Kaolin shim into the TRELLIS-2 source tree.

WHY : nvdiffrast (NVIDIA Source Code License) is non-commercial. To ship
FabMesh commercially we replace it by `kaolin.render.mesh.rasterize`
(Apache 2.0). The shim file lives in this repo at
`scripts/trellis2_kaolin_shim.py` (canonical source). This installer
copies it into the TRELLIS-2 source tree and patches the import line of
`trellis2_texturing.py` so the swap is active.

The TRELLIS-2 source tree is a nested git repo and cannot be tracked
directly by FabMesh, hence this bootstrap.

Usage:
    python scripts/install_kaolin_shim.py
        # optional flag: --uninstall  (restore original nvdiffrast import)
"""
import os
import sys
import shutil
import argparse


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
SHIM_SRC = os.path.join(ROOT, 'scripts', 'trellis2_kaolin_shim.py')
TRELLIS_SRC = os.path.join(ROOT, 'external', 'TRELLIS2_win', 'src', 'trellis2')
SHIM_DST = os.path.join(TRELLIS_SRC, 'renderers', 'nvdiffrast_kaolin_compat.py')
TEX_PY = os.path.join(TRELLIS_SRC, 'pipelines', 'trellis2_texturing.py')

ORIGINAL_IMPORT = "import nvdiffrast.torch as dr"
SHIM_BLOCK = """import os as _os
# FabMesh commercial build : kaolin shim (Apache 2.0) replaces nvdiffrast
# (NVIDIA Source Code License -- non-commercial). Validated vs nvdr at
# PSNR>82 dB / SSIM>0.996 on leopard/king/fusil meshes. ~+0.5s per gen.
# Set TRELLIS2_USE_KAOLIN_RASTER=0 explicitly to fall back to nvdiffrast.
if _os.environ.get('TRELLIS2_USE_KAOLIN_RASTER', '1') == '1':
    from trellis2.renderers import nvdiffrast_kaolin_compat as dr
else:
    import nvdiffrast.torch as dr"""


def install():
    if not os.path.isdir(TRELLIS_SRC):
        print(f'ERROR: TRELLIS-2 source tree not found at {TRELLIS_SRC}')
        print('Did you clone TRELLIS-2 into external/TRELLIS2_win/src/ ?')
        sys.exit(1)
    if not os.path.isfile(SHIM_SRC):
        print(f'ERROR: canonical shim missing: {SHIM_SRC}')
        sys.exit(1)
    if not os.path.isfile(TEX_PY):
        print(f'ERROR: trellis2_texturing.py missing at {TEX_PY}')
        sys.exit(1)

    # 1) Copy the shim into the TRELLIS-2 source tree
    os.makedirs(os.path.dirname(SHIM_DST), exist_ok=True)
    shutil.copy2(SHIM_SRC, SHIM_DST)
    print(f'[install_kaolin_shim] copied shim -> {SHIM_DST}')

    # 2) Patch trellis2_texturing.py to use the shim by default
    with open(TEX_PY, 'r', encoding='utf-8') as f:
        content = f.read()

    if SHIM_BLOCK in content:
        print('[install_kaolin_shim] trellis2_texturing.py already patched')
        return

    if ORIGINAL_IMPORT not in content:
        print(f'[install_kaolin_shim] WARNING: original import line not found '
              f'in {TEX_PY} -- patch may already be applied or file changed')
        return

    content = content.replace(ORIGINAL_IMPORT, SHIM_BLOCK)
    backup_path = TEX_PY + '.bak_kaolin'
    if not os.path.isfile(backup_path):
        with open(backup_path, 'w', encoding='utf-8') as f:
            # Re-read original via the in-memory string before patching
            f.write(content.replace(SHIM_BLOCK, ORIGINAL_IMPORT))
        print(f'[install_kaolin_shim] backup: {backup_path}')
    with open(TEX_PY, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f'[install_kaolin_shim] patched: {TEX_PY}')


def uninstall():
    backup_path = TEX_PY + '.bak_kaolin'
    if os.path.isfile(backup_path):
        shutil.copy2(backup_path, TEX_PY)
        print(f'[install_kaolin_shim] restored: {TEX_PY}')
    if os.path.isfile(SHIM_DST):
        os.remove(SHIM_DST)
        print(f'[install_kaolin_shim] removed: {SHIM_DST}')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--uninstall', action='store_true',
                    help='Restore the original nvdiffrast import')
    args = ap.parse_args()
    if args.uninstall:
        uninstall()
    else:
        install()
