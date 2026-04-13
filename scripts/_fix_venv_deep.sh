#!/bin/bash
set -e
cd ~/TRELLIS.2
source .venv/bin/activate

echo "=== Step 1: list broken state ==="
pip list 2>/dev/null | grep -iE 'torch|nvidia|nccl' | head -30 || true

echo ""
echo "=== Step 2: purge ALL nvidia-* packages ==="
pip freeze 2>/dev/null | grep -iE '^(torch|torchvision|nvidia-|cuda-)' | sed 's/==.*//' > /tmp/purge_list.txt
cat /tmp/purge_list.txt
xargs -a /tmp/purge_list.txt pip uninstall -y 2>&1 | tail -10 || true

echo ""
echo "=== Step 3: remove leftover directories ==="
cd /root/TRELLIS.2/.venv/lib/python3.12/site-packages
# Remove any corrupted ~xxx dirs (tilde prefix = broken)
for d in ~*; do
    if [ -d "$d" ] || [ -f "$d" ]; then
        echo "removing leftover: $d"
        rm -rf "$d"
    fi
done
# Remove torch / nvidia leftovers
for pkg in torch torchvision nvidia_* nvidia-* cuda_*; do
    for d in $pkg*; do
        if [ -d "$d" ] || [ -f "$d" ]; then
            rm -rf "$d" 2>/dev/null || true
        fi
    done
done
cd ~/TRELLIS.2

echo ""
echo "=== Step 4: fresh install torch 2.11.0+cu130 ==="
pip install torch==2.11.0 torchvision==0.26.0 --index-url https://download.pytorch.org/whl/cu130 2>&1 | tail -15

echo ""
echo "=== Step 5: test ==="
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
    print('matmul ok:', y.shape, 'norm:', y.norm().item())
"
