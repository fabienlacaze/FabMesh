#!/bin/bash
set -e
cd ~/TRELLIS.2
source .venv/bin/activate
echo "--- before ---"
pip show torch 2>&1 | head -3
echo "--- force reinstall torch 2.11.0+cu130 ---"
pip install --force-reinstall --no-deps torch==2.11.0 torchvision==0.26.0 --index-url https://download.pytorch.org/whl/cu130 2>&1 | tail -10
echo "--- test ---"
python3 -c "
import torch
print('torch:', torch.__version__)
print('cuda version:', torch.version.cuda)
print('cuda available:', torch.cuda.is_available())
if torch.cuda.is_available():
    print('device name:', torch.cuda.get_device_name(0))
    print('device cap:', torch.cuda.get_device_capability(0))
"
