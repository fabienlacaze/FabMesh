#!/bin/bash
set -e
cd ~/TRELLIS.2
source .venv/bin/activate

export CUDA_HOME=/usr/local/cuda-12.8
export PATH="$VIRTUAL_ENV/bin:/usr/local/cuda-12.8/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export TORCH_CUDA_ARCH_LIST='12.0'
export MAX_JOBS=4

clone_or_update () {
    local repo="$1"
    local dest="$2"
    if [ ! -d "$dest" ]; then
        echo "cloning $repo ..."
        git clone "$repo" "$dest" --recursive 2>&1 | tail -3
    else
        echo "already cloned: $dest"
    fi
}

echo "=== clone sources ==="
clone_or_update https://github.com/JeffreyXiang/FlexGEMM.git /tmp/FlexGEMM
clone_or_update https://github.com/JeffreyXiang/o-voxel.git /tmp/o-voxel

echo ""
echo "=== uninstall broken extensions ==="
pip uninstall -y flex_gemm o_voxel 2>&1 | tail -5

echo ""
echo "=== build + install flex_gemm ==="
pip install /tmp/FlexGEMM --no-build-isolation 2>&1 | tail -10

echo ""
echo "=== build + install o-voxel ==="
pip install /tmp/o-voxel --no-build-isolation 2>&1 | tail -10

echo ""
echo "=== test imports ==="
python3 -c "
import torch
print('torch:', torch.__version__)
import cumesh
print('cumesh ok')
import flex_gemm
print('flex_gemm ok')
import o_voxel
print('o_voxel ok')
"
