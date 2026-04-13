#!/bin/bash
set -e
cd ~/TRELLIS.2
source .venv/bin/activate

export CUDA_HOME=/usr/local/cuda-12.8
# Prepend venv bin + cuda-12.8 to PATH but KEEP the rest of the current PATH
# so python3 still resolves to the venv python.
export PATH="$VIRTUAL_ENV/bin:/usr/local/cuda-12.8/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export MAX_JOBS=4
export TORCH_CUDA_ARCH_LIST='12.0'
export FLASH_ATTENTION_FORCE_BUILD=TRUE

echo "=== nvcc version ==="
nvcc --version
echo ""
echo "=== torch info ==="
python3 -c "
import torch
print('torch:', torch.__version__)
print('cuda:', torch.version.cuda)
print('device cap:', torch.cuda.get_device_capability(0))
"
echo ""
echo "=== build + install flash_attn 2.8.3 ==="
# Install also build deps
pip install packaging ninja wheel 2>&1 | tail -3
echo ""
# Build from source. 2.8.3 is the last version with the Dao-AILab code we need.
pip install flash-attn==2.8.3 --no-build-isolation 2>&1 | tail -30
echo ""
echo "=== test flash_attn ==="
python3 -c "
import torch
import flash_attn
print('flash_attn version:', flash_attn.__version__)
from flash_attn import flash_attn_func
q = torch.randn(1, 16, 8, 64, device='cuda', dtype=torch.float16)
k = torch.randn(1, 16, 8, 64, device='cuda', dtype=torch.float16)
v = torch.randn(1, 16, 8, 64, device='cuda', dtype=torch.float16)
out = flash_attn_func(q, k, v)
print('flash_attn_func output shape:', out.shape)
print('norm:', out.float().norm().item())
"
