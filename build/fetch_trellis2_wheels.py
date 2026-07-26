"""Download the TRELLIS-2 custom CUDA wheels for bundling.

Run ONCE on the dev/CI machine before electron-builder packaging:
    python build/fetch_trellis2_wheels.py

Output: build/wheels/  (~17.5 MB, 5 wheels cp311/win_amd64)

These are the compiled extensions the default mesh engine
(trellis2_native) needs and that pip cannot resolve from PyPI
(spconv-cu128 included — 404 on PyPI). They are hosted as assets of
the `trellis2-wheels-v1` GitHub PRERELEASE (prerelease so that
electron-updater's /releases/latest lookup never picks it up).

Provenance (sha256 below are bit-identical to the wheels installed in
the working dev venv external/TRELLIS2_win/.venv):
  - o_voxel / cumesh / flex_gemm: pre-built Torch280 wheels from the
    ComfyUI-Trellis2 distribution (MIT, TRELLIS-2 ecosystem)
  - spconv_cu128 / cumm_cu128: local sm_120 builds (Apache-2.0,
    traveller59/spconv + cumm)

The folder is then copied by electron-builder via extraResources to
<install_dir>/resources/wheels/ and wizard_install_deps.py installs
from it (FABMESH_WHEELS_DIR) before trying the network fallback.

LICENSING: the upstream o_voxel wheel imports nvdiffrast (NVIDIA Source
Code License -- non-commercial) in postprocess.py, which
o_voxel/__init__.py imports eagerly. Since this wheel ships in the sold
package, it is rewritten right after download by
build/patch_ovoxel_wheel.py (kaolin shim, Apache-2.0). That step is part
of provisioning, NOT an optional extra -- see the module docstring there.
"""
import hashlib
import os
import pathlib
import sys
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import patch_ovoxel_wheel  # noqa: E402  (same directory)

RELEASE_BASE = ('https://github.com/fabienlacaze/MyFabmesh/releases/'
                'download/trellis2-wheels-v1/')

# filename -> sha256 (must match external/TRELLIS2_win/.venv dist-info)
WHEELS = {
    'o_voxel-0.0.1-cp311-cp311-win_amd64.whl':
        '531e370e7768d32a438ca7ebbdc5d7644cb3b9c4838f2539c6768dc464cb3145',
    'cumesh-1.0-cp311-cp311-win_amd64.whl':
        'd1ed72dfb2815776812bd634c175885bf373ae585306a5b819dc191041c1f024',
    'flex_gemm-0.0.1-cp311-cp311-win_amd64.whl':
        '71658a676bfc8e7d7b15550a4a502c759e6f315a064cb990a0235d1d1dd2d9ad',
    'spconv_cu128-2.3.8-cp311-cp311-win_amd64.whl':
        'b4264f8fc35f54f1f3597eea305a9560f77e3dcae5490f0bcb206c77d9e13d70',
    'cumm_cu128-0.8.2-cp311-cp311-win_amd64.whl':
        'ee8b7c038fceacc4391d879c04be1c4c1ccb52aab1ed28c91df559ae0f7cad93',
}

OUT_DIR = pathlib.Path(__file__).resolve().parent / 'wheels'


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    failed = []
    for name, expected in WHEELS.items():
        dest = OUT_DIR / name
        # o_voxel is rewritten after download (see module docstring), so its
        # sha256 no longer matches upstream. Detect the patch instead, or we
        # would re-download the non-commercial version on every run.
        if (dest.is_file() and dest == patch_ovoxel_wheel.WHEEL
                and patch_ovoxel_wheel.is_patched(dest)):
            print(f'[ok] {name} (already present, kaolin patch verified)')
            continue
        if dest.is_file() and sha256_of(dest) == expected:
            print(f'[ok] {name} (already present, sha256 verified)')
            continue
        url = RELEASE_BASE + name
        print(f'[dl] {url}')
        try:
            tmp = str(dest) + '.part'
            urllib.request.urlretrieve(url, tmp)
            got = sha256_of(tmp)
            if got != expected:
                os.remove(tmp)
                failed.append(f'{name}: sha256 mismatch ({got})')
                continue
            os.replace(tmp, dest)
            print(f'[ok] {name}')
        except Exception as e:
            failed.append(f'{name}: {e}')
    if failed:
        print('\nFAILED:\n  ' + '\n  '.join(failed))
        print('\nIf the GitHub release is unreachable, copy the wheels '
              'manually into build/wheels/ (see AGENT_LOG 2026-07-06 for '
              'the original local paths).')
        sys.exit(1)

    # Strip the non-commercial nvdiffrast import from o_voxel before it can
    # reach extraResources. Hard failure: shipping it is a sale blocker.
    rc = patch_ovoxel_wheel.main_no_args()
    if rc != 0:
        print('\nFAILED: could not remove nvdiffrast from the o_voxel wheel.')
        sys.exit(1)

    print(f'\nAll {len(WHEELS)} wheels ready in {OUT_DIR}')


if __name__ == '__main__':
    main()
