"""Test TRELLIS-2 sur Windows natif (Python 3.11 + venv .venv).

Usage:
    .venv/Scripts/python.exe test_run.py <input_image> <output_glb>

Pipeline officiel Microsoft/TRELLIS-2 + Blackwell fix (visualbruno).
"""
import os
import sys

# Make TRELLIS-2 source importable
SRC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'src')
sys.path.insert(0, SRC_DIR)
os.chdir(SRC_DIR)

# Apply Blackwell fix BEFORE importing trellis2
import blackwell_fix
blackwell_fix.patch_all(verbose=True)

import torch
torch.backends.cuda.matmul.allow_tf32 = False
torch.backends.cudnn.allow_tf32 = False

import time
import numpy as np
from PIL import Image

print(f"Torch {torch.__version__}, CUDA {torch.version.cuda}")
print(f"Device: {torch.cuda.get_device_name(0)} CC {torch.cuda.get_device_capability(0)}")

if len(sys.argv) < 3:
    print("Usage: test_run.py <input_image> <output_glb>")
    sys.exit(1)

img_path = sys.argv[1]
out_path = sys.argv[2]

print(f"Loading: {img_path}")
img = Image.open(img_path)
print(f"  mode={img.mode} size={img.size}")

# rembg if needed
needs_rembg = True
if img.mode == "RGBA":
    a = np.asarray(img)[:, :, 3]
    if not (a == 255).all():
        needs_rembg = False
if needs_rembg:
    import rembg
    img = rembg.remove(img.convert("RGBA"), session=rembg.new_session("u2net"))
    print("  rembg u2net OK")

print("Loading TRELLIS-2 pipeline...")
from trellis2.pipelines import Trellis2ImageTo3DPipeline
import o_voxel

# Patch fill_holes (CuMesh broken on sm_120)
import trellis2.representations.mesh.base as _t2_base
def _noop_fill_holes(self, max_hole_perimeter=3e-2):
    print("  [blackwell_fix] Mesh.fill_holes() skipped", flush=True)
_t2_base.Mesh.fill_holes = _noop_fill_holes

# Patch BiRefNet rembg (gated repo briaai/RMBG-2.0). We pre-process
# the image with rembg u2net (Apache 2.0) BEFORE feeding it to the
# pipeline, so the internal rembg model is never called. Replace it
# with a stub that just returns the input image as-is.
class _NoOpRembg:
    def __init__(self, *args, **kwargs):
        pass
    def to(self, device):
        return self
    def cpu(self):
        return self
    def __call__(self, image):
        return image  # already RGBA-cleaned by external rembg
import trellis2.pipelines.rembg as _rembg_pkg
_rembg_pkg.BiRefNet = _NoOpRembg
import trellis2.pipelines.rembg.BiRefNet as _bn_mod
_bn_mod.BiRefNet = _NoOpRembg

pipe = Trellis2ImageTo3DPipeline.from_pretrained("microsoft/TRELLIS.2-4B")
pipe.cuda()

# Patch DINOv3: transformers 5.x renamed model structure.
# TRELLIS-2 expects model.layer, model.embeddings, model.rope_embeddings.
# Current transformers exposes them at model.model.layer + model.embeddings
# (root-level for embeddings/rope but layer is now nested).
_dino = pipe.image_cond_model.model
if not hasattr(_dino, 'layer') and hasattr(_dino, 'model') and hasattr(_dino.model, 'layer'):
    _dino.layer = _dino.model.layer
    print(f"  [patch] aliased dino.layer -> dino.model.layer ({len(_dino.layer)} blocks)")

print("Pipeline ready on CUDA")

print(f"Running pipeline_type=512...")
t0 = time.time()
mesh = pipe.run(img, pipeline_type="512")[0]
print(f"Generated in {time.time()-t0:.0f}s")
print(f"  mesh.vertices: {tuple(mesh.vertices.shape)}")
print(f"  mesh.faces:    {tuple(mesh.faces.shape)}")
print(f"  mesh.coords:   {tuple(mesh.coords.shape)}")
print(f"  mesh.attrs:    {tuple(mesh.attrs.shape)}")

print("Simplifying mesh...")
try:
    mesh.simplify(16777216)
except Exception as e:
    print(f"  simplify warning: {e}")

print("Exporting to GLB via o_voxel.postprocess.to_glb (NATIVE)...")
try:
    glb = o_voxel.postprocess.to_glb(
        vertices=mesh.vertices,
        faces=mesh.faces,
        attr_volume=mesh.attrs,
        coords=mesh.coords,
        attr_layout=mesh.layout,
        voxel_size=mesh.voxel_size,
        aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
        decimation_target=1000000,
        texture_size=1024,
        remesh=True,
        remesh_band=1,
        remesh_project=0,
        verbose=True,
    )
    glb.export(out_path)
    print(f"SUCCESS: {os.path.getsize(out_path)} bytes -> {out_path}")
except Exception as e:
    print(f"FAILED native to_glb: {type(e).__name__}: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(2)
