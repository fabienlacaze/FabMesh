#!/bin/bash
set -e
cd ~/TRELLIS.2
source .venv/bin/activate
export CUDA_HOME=/usr/local/cuda-12.8
export PATH=/usr/local/cuda-12.8/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export MAX_JOBS=4
export TORCH_CUDA_ARCH_LIST='12.0'
export FLASH_ATTENTION_FORCE_BUILD=TRUE
nvcc --version
echo "---"
python3 -c "import torch; print('torch:', torch.__version__); print('cuda:', torch.version.cuda); print('device cap:', torch.cuda.get_device_capability(0))"
echo "---"
pip install flash-attn==2.8.3 --no-build-isolation -v 2>&1
