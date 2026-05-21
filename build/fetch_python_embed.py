"""Download + prepare Python 3.11 embedded distribution for bundling.

Run ONCE on the dev machine before electron-builder packaging:
    python build/fetch_python_embed.py

Output: build/python-embed/  (~30 MB, ready to be bundled)
        - python.exe              the portable interpreter
        - python311._pth          adjusted to allow site-packages
        - get-pip.py              for the first-run pip bootstrap

This folder is then copied by electron-builder via extraResources to:
        <install_dir>/resources/python-embed/
and the wizard runs it instead of the system 'python'.

Source: python.org embedded distribution (PSF License, redistributable).
"""
import hashlib
import os
import pathlib
import shutil
import sys
import urllib.request
import zipfile


PYTHON_VERSION = '3.11.9'
ZIP_URL = (
    f'https://www.python.org/ftp/python/{PYTHON_VERSION}/'
    f'python-{PYTHON_VERSION}-embed-amd64.zip'
)
# Pinned sha256 for python-3.11.9-embed-amd64.zip (python.org official).
# Update both URL + hash together when bumping versions.
EXPECTED_SHA256 = (
    'fbc73a0b0eee3a3afb049f5d3d196cf311b4d8e7d63c8eba6925a657ddedf21d'
)
GETPIP_URL = 'https://bootstrap.pypa.io/get-pip.py'

OUT_DIR = pathlib.Path(__file__).parent / 'python-embed'


def _sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def main():
    OUT_DIR.mkdir(exist_ok=True, parents=True)
    zip_path = OUT_DIR / 'python-embed.zip'

    if zip_path.exists() and _sha256(zip_path) == EXPECTED_SHA256:
        print(f'[ok] zip already present + sha256 verified')
    else:
        print(f'[dl] {ZIP_URL}')
        urllib.request.urlretrieve(ZIP_URL, zip_path)
        got = _sha256(zip_path)
        if got != EXPECTED_SHA256:
            zip_path.unlink()
            sys.exit(f'sha256 mismatch: got {got}, expected {EXPECTED_SHA256}')
        print(f'[ok] verified sha256={got}')

    print(f'[extract] -> {OUT_DIR}')
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(OUT_DIR)

    # The embed distribution disables `import site` by default — flip
    # it on so wheels installed via pip become reachable.
    pth = OUT_DIR / 'python311._pth'
    if pth.exists():
        text = pth.read_text()
        if '#import site' in text:
            pth.write_text(text.replace('#import site', 'import site'))
            print(f'[ok] enabled site-packages via {pth.name}')

    # Bootstrap pip — we'll call this once at first-run from main.js.
    getpip = OUT_DIR / 'get-pip.py'
    if not getpip.exists():
        print(f'[dl] {GETPIP_URL}')
        urllib.request.urlretrieve(GETPIP_URL, getpip)

    zip_path.unlink()
    print(f'\nReady: {OUT_DIR}')
    print(f'Size : ~{sum(p.stat().st_size for p in OUT_DIR.rglob("*") if p.is_file()) // (1024*1024)} MB')


if __name__ == '__main__':
    main()
