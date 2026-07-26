"""Install the FabMesh Kaolin shim into the TRELLIS-2 source tree.

WHY : nvdiffrast (NVIDIA Source Code License) is non-commercial. To ship
FabMesh commercially we replace it by `kaolin.render.mesh.rasterize`
(Apache 2.0). The shim file lives in this repo at
`scripts/trellis2_kaolin_shim.py` (canonical source). This installer
copies it into the TRELLIS-2 source tree and patches the import line of
`trellis2_texturing.py` so the swap is active.

The TRELLIS-2 source tree is a nested git repo and cannot be tracked
directly by FabMesh, hence this bootstrap.

The swap is UNCONDITIONAL: the patched files import the kaolin shim with
no env-var fallback, so no non-commercial import statement survives in a
file that ships. Re-running this installer on a tree patched by an older
(env-gated) version upgrades it in place.

Usage:
    python scripts/install_kaolin_shim.py
        # optional flag: --uninstall  (dev-only: restore the .bak_kaolin
        #   backup, i.e. the original nvdiffrast import — never ship that)
"""
import os
import re
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
#
# KNOWN PRODUCTION GAP (not fixable from this script): the path below is
# the DEV venv only. On a customer machine o_voxel is installed from
# build/wheels/o_voxel-0.0.1-cp311-cp311-win_amd64.whl by
# scripts/wizard_install_deps.py, and that wheel still carries an
# unpatched `import nvdiffrast.torch as dr` in postprocess.py. Since
# o_voxel/__init__.py eagerly imports postprocess, any `import o_voxel`
# on a fresh install pulls in nvdiffrast, which the wizard never
# installs. Proper fix = rebuild the wheel with postprocess.py
# pre-patched to the shim (touches build/wheels, out of this script's
# scope). Tracked in AGENT_LOG.md.
OVOXEL_PY = os.path.join(ROOT, 'external', 'TRELLIS2_win', '.venv', 'Lib',
                         'site-packages', 'o_voxel', 'postprocess.py')

# Third target: the git-TRACKED disaster-recovery mirror. external_patches/
# holds a copy of every vendored file we hand-edit (see RECOVERY.md, which
# restores it with `xcopy /E external_patches\TRELLIS2_win\* external\...`).
# It was previously NOT patched by this installer, so it still carried the
# legacy env-gated block -- meaning (a) the `import nvdiffrast.torch as dr`
# line lived in FabMesh's own git history / working tree, and (b) any
# recovery per RECOVERY.md would silently re-introduce the non-commercial
# fallback into external/. Patched here so the mirror stays commercial-safe.
MIRROR_TEX_PY = os.path.join(ROOT, 'external_patches', 'TRELLIS2_win', 'src',
                             'trellis2', 'pipelines', 'trellis2_texturing.py')

ORIGINAL_IMPORT = "import nvdiffrast.torch as dr"

# The patch is UNCONDITIONAL on purpose. An earlier version wrote an
# env-gated block (`if TRELLIS2_USE_KAOLIN_RASTER != '0': kaolin else
# nvdiffrast`). That else-branch is a licensing bug: the literal
# `import nvdiffrast.torch as dr` statement ends up inside a file that
# ships in the sold package (verified in MyFabmesh.AI 1.0.12.appx ->
# app/resources/TRELLIS2_win/src/trellis2/pipelines/trellis2_texturing.py),
# and a customer exporting TRELLIS2_USE_KAOLIN_RASTER=0 would re-enable
# the NVIDIA non-commercial rasterizer inside a commercial product.
# There is now no escape hatch: use --uninstall (dev-only, restores the
# .bak_kaolin backup) if you ever need the nvdiffrast reference locally.
SHIM_BLOCK = """# FabMesh commercial build : kaolin shim (Apache 2.0) replaces nvdiffrast
# (NVIDIA Source Code License -- non-commercial). Validated vs nvdr at
# PSNR>82 dB / SSIM>0.996 on leopard/king/fusil meshes. ~+0.5s per gen.
# Unconditional: no env-var fallback, so no non-commercial import
# statement is ever written into a distributed file.
from trellis2.renderers import nvdiffrast_kaolin_compat as dr"""

# Matches the legacy env-gated block written by previous versions of this
# installer, so re-running it UPGRADES an already-patched tree instead of
# reporting "original import not found -- skipping". Tolerates the two
# comment/`import os as _os` orderings that were emitted in the wild
# (trellis2_texturing.py vs the hand-edited o_voxel/postprocess.py).
LEGACY_BLOCK_RE = re.compile(
    r"(?:^(?:#[^\n]*|import os as _os)\n)*"
    r"^if _os\.environ\.get\(\s*['\"]TRELLIS2_USE_KAOLIN_RASTER['\"][^\n]*\n"
    r"^[ \t]+from trellis2\.renderers import nvdiffrast_kaolin_compat as dr\n"
    r"^else:\n"
    r"^[ \t]+import nvdiffrast\.torch as dr\n",
    re.MULTILINE,
)


def _patch_file(target_path, label, backup=True):
    """Point `target_path` at the kaolin shim unconditionally.

    Handles three input states: pristine (`import nvdiffrast.torch as dr`),
    legacy env-gated block (upgraded in place), and already-patched (no-op).
    Creates a .bak_kaolin sibling on first patch.

    `backup=False` is used for the git-tracked external_patches/ mirror: a
    .bak_kaolin there would write an `import nvdiffrast.torch as dr` line
    back into a tracked directory, which is the very thing we are removing.
    Git history is that file's backup.
    """
    if not os.path.isfile(target_path):
        print(f'[install_kaolin_shim] WARNING: {label} missing at {target_path}')
        return False
    with open(target_path, 'r', encoding='utf-8') as f:
        content = f.read()
    if SHIM_BLOCK in content:
        print(f'[install_kaolin_shim] {label} already patched')
        return True

    legacy = LEGACY_BLOCK_RE.search(content)
    if legacy:
        new_content = content[:legacy.start()] + SHIM_BLOCK + '\n' + \
            content[legacy.end():]
        action = 'upgraded (legacy env-gated block -> unconditional)'
    elif ORIGINAL_IMPORT in content:
        new_content = content.replace(ORIGINAL_IMPORT, SHIM_BLOCK)
        action = 'patched'
    else:
        print(f'[install_kaolin_shim] WARNING: original import not found '
              f'in {target_path} -- skipping')
        return False

    backup_path = target_path + '.bak_kaolin'
    if backup and not os.path.isfile(backup_path):
        with open(backup_path, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f'[install_kaolin_shim] backup: {backup_path}')
    with open(target_path, 'w', encoding='utf-8') as f:
        f.write(new_content)
    print(f'[install_kaolin_shim] {action}: {target_path}')
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
    # The tracked recovery mirror, so RECOVERY.md can never restore the
    # non-commercial fallback. No .bak_kaolin here (see _patch_file docstring).
    _patch_file(MIRROR_TEX_PY, 'external_patches/…/trellis2_texturing.py',
                backup=False)


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
