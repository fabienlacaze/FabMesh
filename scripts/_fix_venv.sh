#!/bin/bash
set -e
cd ~/TRELLIS.2
source .venv/bin/activate

echo "=== Step 1: remove corrupted ~vidia-cudnn-cu12 directory ==="
cd /root/TRELLIS.2/.venv/lib/python3.12/site-packages
ls -d ~vidia* 2>/dev/null || echo "no ~vidia dirs"
# The corrupted package starts with ~ (tilde) — pip uninstall can't find it, must rm
for d in ~vidia*; do
    if [ -d "$d" ]; then
        echo "removing $d"
        rm -rf "$d"
    fi
done
cd ~/TRELLIS.2

echo "=== Step 2: force reinstall torch 2.11.0+cu130 (with all deps) ==="
pip install --force-reinstall torch==2.11.0 torchvision==0.26.0 --index-url https://download.pytorch.org/whl/cu130 2>&1 | tail -15

echo "=== Step 3: test ==="
python3 -c "
import torch
print('torch:', torch.__version__)
print('cuda version:', torch.version.cuda)
print('cuda available:', torch.cuda.is_available())
if torch.cuda.is_available():
    print('device:', torch.cuda.get_device_name(0))
    print('cap:', torch.cuda.get_device_capability(0))
    x = torch.randn(4, 4, device='cuda')
    y = x @ x
    print('matmul ok:', y.shape)
"
