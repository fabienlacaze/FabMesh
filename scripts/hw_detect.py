"""Hardware compatibility check for FabMesh first-run wizard.

Detects GPU (vendor + model + VRAM), driver version (NVIDIA), system
RAM, free disk space and download bandwidth. Outputs a single JSON
line to stdout — easy to parse from Node's execFile.

The wizard uses this JSON to pick the right install mode:
  - "full"     16 GB+ VRAM, all features
  - "standard" 12 GB+ VRAM, full local generation
  - "lite"     6-8 GB VRAM, basic generation only
  - "cloud"    no compatible GPU, cloud-only mode

Run from anywhere — only uses stdlib + subprocess.
"""
import json
import os
import platform
import shutil
import subprocess
import sys
import time
import urllib.request


def _safe(fn, default):
    try:
        return fn()
    except Exception:
        return default


def detect_gpu():
    """Returns {'vendor', 'model', 'vram_mb', 'driver'} or None."""
    # NVIDIA first (most common, supported)
    try:
        out = subprocess.check_output(
            ['nvidia-smi',
             '--query-gpu=name,memory.total,driver_version',
             '--format=csv,noheader,nounits'],
            text=True, timeout=5, stderr=subprocess.DEVNULL).strip()
        if out:
            # Take the first GPU listed
            name, vram, driver = [s.strip() for s in out.splitlines()[0].split(',')]
            return {
                'vendor': 'NVIDIA',
                'model': name,
                'vram_mb': int(vram),
                'driver': driver,
            }
    except Exception:
        pass
    # AMD via wmic (Windows only)
    if platform.system() == 'Windows':
        try:
            out = subprocess.check_output(
                ['wmic', 'path', 'Win32_VideoController',
                 'get', 'Name,AdapterRAM', '/format:csv'],
                text=True, timeout=8, stderr=subprocess.DEVNULL)
            # Parse CSV — skip header, find a GPU line with AMD/Radeon/RX
            for line in out.splitlines():
                parts = [p.strip() for p in line.split(',') if p.strip()]
                if len(parts) >= 3:
                    name = parts[2] if len(parts) > 2 else ''
                    if any(k in name.lower() for k in ('amd', 'radeon', 'rx ', 'intel')):
                        ram_bytes = _safe(lambda: int(parts[1]), 0)
                        return {
                            'vendor': 'AMD' if 'amd' in name.lower() or 'radeon' in name.lower() else 'Intel',
                            'model': name,
                            'vram_mb': ram_bytes // (1024 * 1024) if ram_bytes else 0,
                            'driver': None,
                        }
        except Exception:
            pass
    return None


def detect_system_ram_mb():
    if platform.system() == 'Windows':
        try:
            out = subprocess.check_output(
                ['wmic', 'OS', 'get', 'TotalVisibleMemorySize', '/value'],
                text=True, timeout=5, stderr=subprocess.DEVNULL)
            for line in out.splitlines():
                if line.startswith('TotalVisibleMemorySize='):
                    return int(line.split('=')[1].strip()) // 1024
        except Exception:
            pass
    # Linux / macOS fallback
    try:
        import psutil
        return psutil.virtual_memory().total // (1024 * 1024)
    except ImportError:
        return 0


def detect_disk_free_gb(path=None):
    if path is None:
        path = 'C:\\' if platform.system() == 'Windows' else '/'
    try:
        usage = shutil.disk_usage(path)
        return usage.free // (1024 ** 3)
    except Exception:
        return 0


def test_bandwidth_mbps(timeout=8):
    """Quick download timing on a known 1 MB file from HuggingFace CDN.
    Returns MB/s as float, or 0 on failure."""
    url = 'https://huggingface.co/datasets/julien-c/wine-quality/resolve/main/winequality-red.csv'
    try:
        t0 = time.time()
        req = urllib.request.Request(url, headers={'User-Agent': 'fabmesh-hw-detect/1.0'})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read(1024 * 1024)  # cap at 1 MB
        dt = time.time() - t0
        if dt <= 0 or not data:
            return 0
        return round(len(data) / dt / (1024 * 1024), 2)
    except Exception:
        return 0


def recommend_mode(gpu, ram_mb, disk_gb):
    """Pick the install mode based on detected hardware."""
    if not gpu or gpu['vendor'] != 'NVIDIA':
        return 'cloud'
    vram = gpu.get('vram_mb', 0)
    if vram >= 16 * 1024 and ram_mb >= 16 * 1024 and disk_gb >= 30:
        return 'full'
    if vram >= 12 * 1024 and ram_mb >= 16 * 1024 and disk_gb >= 25:
        return 'standard'
    if vram >= 6 * 1024 and ram_mb >= 8 * 1024 and disk_gb >= 15:
        return 'lite'
    return 'cloud'


def parse_nvidia_driver(driver_str):
    """Major version of a driver like '566.14' → 566. Returns 0 on parse fail."""
    try:
        return int(str(driver_str).split('.')[0])
    except Exception:
        return 0


def driver_ok(driver_str):
    """FabMesh needs >=550 for CUDA 12.4+ support."""
    return parse_nvidia_driver(driver_str) >= 550


def main():
    gpu = detect_gpu()
    ram_mb = detect_system_ram_mb()
    disk_gb = detect_disk_free_gb()
    bw_mbps = test_bandwidth_mbps()

    mode = recommend_mode(gpu, ram_mb, disk_gb)

    warnings = []
    if gpu and gpu['vendor'] == 'NVIDIA' and gpu.get('driver'):
        if not driver_ok(gpu['driver']):
            warnings.append(
                f"NVIDIA driver {gpu['driver']} is too old (need >= 550). "
                "Update via GeForce Experience or nvidia.com/drivers."
            )
    if not gpu:
        warnings.append("No GPU detected — cloud mode only.")
    elif gpu['vendor'] != 'NVIDIA':
        warnings.append(
            f"{gpu['vendor']} GPU detected — local generation needs NVIDIA. "
            "Cloud mode will be used instead."
        )
    if ram_mb < 8 * 1024:
        warnings.append(f"Low system RAM ({ram_mb // 1024} GB). 16 GB recommended.")
    if disk_gb < 15:
        warnings.append(f"Low disk space ({disk_gb} GB free). Need at least 15 GB.")
    if bw_mbps and bw_mbps < 2:
        warnings.append(
            f"Slow connection ({bw_mbps} MB/s). Model download may take a long time."
        )

    result = {
        'os': f'{platform.system()} {platform.release()}',
        'cpu_cores': os.cpu_count() or 0,
        'ram_mb': ram_mb,
        'disk_free_gb': disk_gb,
        'bandwidth_mbps': bw_mbps,
        'gpu': gpu,
        'recommended_mode': mode,
        'driver_ok': driver_ok(gpu['driver']) if gpu and gpu.get('driver') else False,
        'warnings': warnings,
    }
    print(json.dumps(result))


if __name__ == '__main__':
    main()
