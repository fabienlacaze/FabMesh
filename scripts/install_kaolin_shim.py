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

# Second nvdiffrast importer that must also be patched : o_voxel (a wheel
# bundled in the TRELLIS-2 venv). Its postprocess.py calls the same three
# nvdiffrast functions (RasterizeCudaContext / rasterize / interpolate)
# that our shim exposes, so the swap is identical.
OVOXEL_PY = os.path.join(ROOT, 'external', 'TRELLIS2_win', '.venv', 'Lib',
                         'site-packages', 'o_voxel', 'postprocess.py')

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


def _patch_file(target_path, label):
    """Replace the original nvdiffrast import in `target_path` by the
    conditional shim block. Creates a .bak_kaolin sibling on first patch."""
    if not os.path.isfile(target_path):
        print(f'[install_kaolin_shim] WARNING: {label} missing at {target_path}')
        return False
    with open(target_path, 'r', encoding='utf-8') as f:
        content = f.read()
    if SHIM_BLOCK in content:
        print(f'[install_kaolin_shim] {label} already patched')
        return True
    if ORIGINAL_IMPORT not in content:
        print(f'[install_kaolin_shim] WARNING: original import not found '
              f'in {target_path} -- skipping')
        return False
    backup_path = target_path + '.bak_kaolin'
    if not os.path.isfile(backup_path):
        with open(backup_path, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f'[install_kaolin_shim] backup: {backup_path}')
    new_content = content.replace(ORIGINAL_IMPORT, SHIM_BLOCK)
    with open(target_path, 'w', encoding='utf-8') as f:
        f.write(new_content)
    print(f'[install_kaolin_shim] patched: {target_path}')
    return True


def _restore_file(target_path, label):
    backup_path = target_path + '.bak_kaolin'
    if os.path.isfile(backup_path):
        shutil.copy2(backup_path, target_path)
        print(f'[install_kaolin_shim] restored: {target_path}')


def install():
    if not os.path.isdir(TRELLIS_SRC):
        print(f'ERROR: TRELLIS-2 source tree not found at {TRELLIS_SRC}')
        print('Did you clone TRELLIS-2 into external/TRELLIS2_win/src/ ?')
        sys.exit(1)
    if not os.path.isfile(SHIM_SRC):
        print(f'ERROR: canonical shim missing: {SHIM_SRC}')
        sys.exit(1)

    # 1) Copy the shim into the TRELLIS-2 source tree
    os.makedirs(os.path.dirname(SHIM_DST), exist_ok=True)
    shutil.copy2(SHIM_SRC, SHIM_DST)
    print(f'[install_kaolin_shim] copied shim -> {SHIM_DST}')

    # 2) Patch every file that does `import nvdiffrast.torch as dr`
    _patch_file(TEX_PY, 'trellis2_texturing.py')
    _patch_file(OVOXEL_PY, 'o_voxel/postprocess.py')


def uninstall():
    _restore_file(TEX_PY, 'trellis2_texturing.py')
    _restore_file(OVOXEL_PY, 'o_voxel/postprocess.py')
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
