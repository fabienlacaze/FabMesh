@echo off
call "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvarsall.bat" x64
set CUDA_HOME=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.2
set DISTUTILS_USE_SDK=1
set TORCH_CUDA_ARCH_LIST=12.0
cd C:\Users\Utilisateur\Desktop\FabWare\MeshyMyself\Hunyuan3D-2\hy3dgen\texgen\custom_rasterizer
pip install --no-build-isolation -v . 2>&1
echo BUILD_RESULT=%ERRORLEVEL%
