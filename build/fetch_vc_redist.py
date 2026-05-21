"""Download the Visual C++ 2022 x64 Redistributable.

Bundled into the installer so users without VC++ runtime libraries
(common on fresh Win 10/11 installs) don't get cryptic "DLL not found"
errors on first launch. Microsoft hosts the official redistributable
at a stable URL — we mirror it locally with sha-256 verification.

Run once on the dev machine:
    python build/fetch_vc_redist.py
"""
import hashlib
import pathlib
import sys
import urllib.request


URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
OUT = pathlib.Path(__file__).parent / 'vc_redist.x64.exe'
# NB: Microsoft updates this binary over time. The SHA-256 below is
# a placeholder; the dev should run the script, copy the actual hash
# printed at first download, and commit the new value here.
EXPECTED_SHA256 = None  # set this once and pin it


def _sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def main():
    if OUT.exists():
        got = _sha256(OUT)
        if EXPECTED_SHA256 and got == EXPECTED_SHA256:
            print(f'[ok] vc_redist already present + verified ({got})')
            return
        print(f'[warn] vc_redist present but hash differs / unset: {got}')

    print(f'[dl] {URL}')
    urllib.request.urlretrieve(URL, OUT)
    got = _sha256(OUT)
    print(f'[ok] downloaded {OUT.stat().st_size // 1024 // 1024} MB')
    print(f'sha256: {got}')
    if EXPECTED_SHA256 and got != EXPECTED_SHA256:
        OUT.unlink()
        sys.exit(f'sha256 mismatch: pin {got} in this script before shipping')


if __name__ == '__main__':
    main()
