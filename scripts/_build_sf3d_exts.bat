@echo off
REM Build texture_baker + uv_unwrapper for Stable Fast 3D
REM Uses local MSVC (VS 2022 Professional) + torch 2.7.1+cu128

REM Activate MSVC x64 env
call "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 (
    echo ERROR: vcvars64.bat failed
    exit /b 1
)

echo === MSVC env activated ===
where cl.exe

REM Required so torch.utils.cpp_extension accepts our pre-activated VC env
set DISTUTILS_USE_SDK=1

REM Move to project root
cd /d c:\Users\Utilisateur\Desktop\FabWare\MeshyMyself

REM Force nvcc 12.8 to match torch cu128
set "CUDA_HOME=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.2"
set "PATH=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.2\bin;%PATH%"
set TORCH_CUDA_ARCH_LIST=12.0
set USE_NATIVE_ARCH=0

echo === Building uv_unwrapper (C++ only, no CUDA) ===
cd external\StableFast3D\uv_unwrapper
python -m pip install . --no-build-isolation 2>&1
if errorlevel 1 (
    echo ERROR: uv_unwrapper build failed
    exit /b 2
)

cd ..\..\..

echo === Building texture_baker (C++, try CPU-only first to avoid CUDA mismatch) ===
cd external\StableFast3D\texture_baker
set USE_CUDA=0
python -m pip install . --no-build-isolation 2>&1
if errorlevel 1 (
    echo ERROR: texture_baker CPU build failed
    exit /b 3
)

cd ..\..\..

echo === Test imports ===
python -c "from uv_unwrapper import Unwrapper; print('uv_unwrapper OK'); from texture_baker import TextureBaker; print('texture_baker OK')"
