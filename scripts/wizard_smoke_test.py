"""Final functional test for the FabMesh first-run wizard.

Loads the minimal stack for the chosen install mode and runs a tiny
operation to confirm everything works. Exits 0 on success, nonzero
on failure (Electron picks up the error and shows it in the wizard).

We deliberately avoid running a full TRELLIS-2 image-to-3D here (would
take ~60s and use 12 GB VRAM): the goal is to detect setup mistakes
(missing wheel, broken driver, CUDA-init failure) in ~10s.

Usage:
    python wizard_smoke_test.py --mode {lite|standard|full}
"""
import argparse
import sys
import time


def log(msg):
    print(msg, flush=True)


def check_torch_cuda():
    log('[smoke] checking PyTorch + CUDA...')
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError(
            'CUDA not available. Possible causes:\n'
            ' - NVIDIA driver too old (need >= 550)\n'
            ' - PyTorch CUDA build mismatch with installed driver\n'
            ' - No NVIDIA GPU detected')
    name = torch.cuda.get_device_name(0)
    vram_gb = torch.cuda.get_device_properties(0).total_memory / (1024 ** 3)
    log(f'[smoke]   CUDA OK: {name} ({vram_gb:.1f} GB VRAM)')
    # Tiny tensor op to confirm we can actually allocate + compute
    x = torch.randn(256, 256, device='cuda')
    y = (x @ x.T).sum().item()
    log(f'[smoke]   matmul OK (sanity sum: {y:.0f})')
    del x


def check_trellis_loadable():
    """Check that the 3D core's dependencies import correctly."""
    log('[smoke] checking 3D core...')
    try:
        import importlib
        importlib.import_module('diffusers')
        log('[smoke]   3D core OK')
    except Exception as e:
        raise RuntimeError(f'3D core import failed: {e}')


def check_blip_loadable():
    log('[smoke] checking vision module...')
    from huggingface_hub import try_to_load_from_cache
    p = try_to_load_from_cache(
        'Salesforce/blip-image-captioning-large', 'config.json')
    if not p:
        raise RuntimeError('vision module not in cache (download incomplete?)')
    log(f'[smoke]   vision module OK')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mode', required=True)
    args = ap.parse_args()

    t0 = time.time()
    log(f'[smoke] mode={args.mode}')

    try:
        check_torch_cuda()
        check_trellis_loadable()
        if args.mode in ('standard', 'full', 'lite'):
            check_blip_loadable()
        log(f'[smoke] all checks passed in {time.time() - t0:.1f}s')
        sys.exit(0)
    except Exception as e:
        log(f'[smoke] FAILED: {e}')
        sys.exit(1)


if __name__ == '__main__':
    main()
