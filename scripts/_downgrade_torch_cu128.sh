#!/bin/bash
set -e
cd ~/TRELLIS.2
source .venv/bin/activate

echo "=== Uninstall cu13 torch ==="
pip uninstall -y torch torchvision 2>&1 | tail -5

# Remove cu13 nvidia libs (keep other deps)
pip freeze 2>/dev/null | grep -iE '^nvidia-.*cu13$' | sed 's/==.*//' > /tmp/cu13_list.txt
cat /tmp/cu13_list.txt
if [ -s /tmp/cu13_list.txt ]; then
    xargs -a /tmp/cu13_list.txt pip uninstall -y 2>&1 | tail -5 || true
fi

echo "=== Install torch 2.9.1+cu128 (matches local nvcc 12.8) ==="
pip install torch==2.9.1 torchvision==0.24.1 --index-url https://download.pytorch.org/whl/cu128 2>&1 | tail -10

echo "=== Verify torch ==="
python3 -c "
import torch
print('torch:', torch.__version__)
print('cuda:', torch.version.cuda)
print('available:', torch.cuda.is_available())
if torch.cuda.is_available():
    print('device:', torch.cuda.get_device_name(0))
    print('cap:', torch.cuda.get_device_capability(0))
    x = torch.randn(4, 4, device='cuda')
    y = x @ x
    print('matmul ok:', y.norm().item())
"
