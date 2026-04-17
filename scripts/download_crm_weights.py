"""
Downloader for CRM (Convolutional Reconstruction Model) weights.

Fetches the 3 checkpoints from HuggingFace hub:
  CRM.pth             (~454 MB)  reconstruction decoder
  pixel-diffusion.pth (~5.74 GB) stage 1 multi-view RGB diffusion
  ccm-diffusion.pth   (~5.74 GB) stage 2 CCM diffusion (optional)

For FabMesh multi-view-only use, only CRM.pth + pixel-diffusion.pth
are strictly needed. We download all 3 by default — the total
~12 GB matches other SF3D/SDXL weights we ship.

Usage:
    python scripts/download_crm_weights.py         # all 3 files
    python scripts/download_crm_weights.py --mv    # multi-view only (~6.2 GB)
"""
from __future__ import annotations
import os
import sys
import argparse

try:
    from huggingface_hub import hf_hub_download
except ImportError:
    print("ERROR: huggingface_hub not installed. pip install huggingface_hub", file=sys.stderr)
    sys.exit(1)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEIGHTS_DIR = os.path.join(ROOT, 'external', 'CRM', 'weights')
REPO_ID = "Zhengyi/CRM"

ALL_FILES = [
    ("CRM.pth",              454),   # MB (approx)
    ("pixel-diffusion.pth", 5880),
    ("ccm-diffusion.pth",   5880),
]
MV_ONLY_FILES = ALL_FILES[:2]


def download(files):
    os.makedirs(WEIGHTS_DIR, exist_ok=True)
    total_mb = sum(mb for _, mb in files)
    print(f'[crm-dl] target dir: {WEIGHTS_DIR}')
    print(f'[crm-dl] will download {len(files)} files, total ~{total_mb} MB')
    for fname, mb in files:
        target = os.path.join(WEIGHTS_DIR, fname)
        if os.path.exists(target) and os.path.getsize(target) > mb * 900 * 1024:
            print(f'[crm-dl] {fname} already present ({os.path.getsize(target)//1024//1024} MB), skip')
            continue
        print(f'[crm-dl] downloading {fname} (~{mb} MB)...')
        sys.stdout.flush()
        got = hf_hub_download(repo_id=REPO_ID, filename=fname,
                              local_dir=WEIGHTS_DIR,
                              local_dir_use_symlinks=False)
        print(f'[crm-dl]   -> {got}')
    print('[crm-dl] done')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--mv', action='store_true',
                    help='Multi-view only (skip ccm-diffusion.pth, ~5.74 GB saved)')
    args = ap.parse_args()
    download(MV_ONLY_FILES if args.mv else ALL_FILES)
