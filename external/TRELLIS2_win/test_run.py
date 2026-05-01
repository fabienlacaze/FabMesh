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

# Apply Blackwell fix (CC spoof + flex_gemm patches) BEFORE importing trellis2
# NOTE: with native sm_120 spconv installed, we can disable the CC spoof
# but keep the flex_gemm fallback patches
import blackwell_fix
import torch as _torch
_orig_cap = _torch.cuda.get_device_capability  # save before patch
blackwell_fix.patch_all(verbose=True)
# Restore real CC (8,6 spoof was needed only for old spconv-cu126)
_torch.cuda.get_device_capability = _orig_cap
# Also restore cumm CC
try:
    import cumm.tensorview as _tv
    # Find original by importing fresh
    import importlib
    importlib.reload(_tv)
except Exception:
    pass
print(f"[override] Restored real CC: {_torch.cuda.get_device_capability(0)}")

# Stick with spconv (flex_gemm Triton broken on sm_120 even with patch)

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

# Drop-in commercial-safe replacement for o_voxel.postprocess.to_glb
# (kills the nvdiffrast dependency, which is NVIDIA SCL = non-commercial).
# o_voxel_patch.py lives at TRELLIS2_win/o_voxel_patch.py — make sure it is
# importable independently of the cwd swap above.
_PATCH_DIR = os.path.dirname(os.path.abspath(SRC_DIR))  # = TRELLIS2_win/
if _PATCH_DIR not in sys.path:
    sys.path.insert(0, _PATCH_DIR)
import o_voxel_patch
print(f"  [patch] o_voxel.postprocess.to_glb -> o_voxel_patch.to_glb (no nvdiffrast)")

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

# Vanilla pipeline — relying on blackwell_fix (8,6) spoof + JIT_DISABLE

# DEBUG: instrument sparse_structure_decoder
_ss_dec = pipe.models['sparse_structure_decoder']
_orig_ss_dec_fwd = _ss_dec.forward
def _patched_ss_dec_fwd(z):
    import numpy as _np, os as _os
    print(f"[DEBUG] ss_decoder INPUT z: shape={tuple(z.shape)} dtype={z.dtype} "
          f"min={z.min().item():.3f} max={z.max().item():.3f} "
          f"mean={z.mean().item():.3f} std={z.std().item():.3f} "
          f"nan={torch.isnan(z).any().item()} inf={torch.isinf(z).any().item()}")
    # Per-axis stats on z
    for ax_name, ax in [("axisD2-z(spatial0)",2),("axisD3-y(spatial1)",3),("axisD4-x(spatial2)",4)]:
        # mean over all but this axis
        m = z.float().mean(dim=tuple(d for d in range(z.dim()) if d != ax))
        print(f"[DEBUG] z mean per {ax_name}: {[f'{v:.3f}' for v in m.cpu().tolist()]}")
    _np.save(_os.path.join(_os.path.dirname(__file__), '_dbg_z_s.npy'), z.float().cpu().numpy())
    out = _orig_ss_dec_fwd(z)
    print(f"[DEBUG] ss_decoder OUTPUT: shape={tuple(out.shape)} dtype={out.dtype} "
          f"min={out.min().item():.3f} max={out.max().item():.3f} "
          f"mean={out.mean().item():.3f} std={out.std().item():.3f} occupied(>0)={(out>0).sum().item()} "
          f"nan={torch.isnan(out).any().item()} inf={torch.isinf(out).any().item()}")
    # Per-axis occupancy
    occ = (out > 0).float()
    for ax_name, ax in [("y(D2)",2),("x(D3)",3),("z(D4)",4)]:
        m = occ.sum(dim=tuple(d for d in range(occ.dim()) if d != ax))
        print(f"[DEBUG] occupancy per {ax_name}: {[int(v) for v in m.cpu().tolist()]}")
    _np.save(_os.path.join(_os.path.dirname(__file__), '_dbg_decoded_logits.npy'), out.float().cpu().numpy())
    return out
_ss_dec.forward = _patched_ss_dec_fwd

# DEBUG: instrument the sparse-structure flow model output (z_s before decoder)
_ss_flow = pipe.models['sparse_structure_flow_model']
_orig_ss_flow_fwd = _ss_flow.forward
_ss_flow_call_count = [0]
def _patched_ss_flow_fwd(*args, **kwargs):
    _ss_flow_call_count[0] += 1
    out = _orig_ss_flow_fwd(*args, **kwargs)
    if _ss_flow_call_count[0] in (1, 25, 50):
        print(f"[DEBUG] ss_flow call #{_ss_flow_call_count[0]} v_pred: shape={tuple(out.shape)} "
              f"min={out.min().item():.3f} max={out.max().item():.3f} "
              f"mean={out.mean().item():.3f} std={out.std().item():.3f}")
    return out
_ss_flow.forward = _patched_ss_flow_fwd

# DEBUG: trace sample_sparse_structure to see if upstream coords are good
_orig_sample_ss = pipe.sample_sparse_structure
def _debug_ss(*args, **kwargs):
    coords = _orig_sample_ss(*args, **kwargs)
    print(f"[DEBUG] sparse_structure OUTPUT: N={coords.shape[0]} ndim={coords.shape[1]}")
    print(f"[DEBUG] ss coords: x=[{coords[:,1].min().item()},{coords[:,1].max().item()}] "
          f"y=[{coords[:,2].min().item()},{coords[:,2].max().item()}] "
          f"z=[{coords[:,3].min().item()},{coords[:,3].max().item()}]")
    # Per-axis histogram
    import torch as _t
    for ax_name, ax_idx in [("x",1),("y",2),("z",3)]:
        c = coords[:,ax_idx].cpu()
        cmin = int(c.min()); cmax = int(c.max())
        bins = _t.bincount(c - cmin, minlength=cmax-cmin+1).tolist()
        print(f"[DEBUG] ss axis {ax_name} hist (range [{cmin},{cmax}]): {bins}")
    # Save coords as npy for later inspection
    import numpy as _np, os as _os
    _np.save(_os.path.join(_os.path.dirname(__file__), '_dbg_ss_coords.npy'), coords.cpu().numpy())
    return coords
pipe.sample_sparse_structure = _debug_ss

# DEBUG: trace shape_slat (input texture stage) — comparer coords range
_orig_sample_shape = pipe.sample_shape_slat
def _debug_shape(*args, **kwargs):
    out = _orig_sample_shape(*args, **kwargs)
    coords = out.coords
    print(f"[DEBUG] shape_slat OUTPUT: N={coords.shape[0]} feats_C={out.feats.shape[1]} "
          f"feats_min={out.feats.min().item():.3f} max={out.feats.max().item():.3f} "
          f"mean={out.feats.mean().item():.3f} std={out.feats.std().item():.3f}")
    print(f"[DEBUG] shape_slat coords: x=[{coords[:,1].min().item()},{coords[:,1].max().item()}] "
          f"y=[{coords[:,2].min().item()},{coords[:,2].max().item()}] "
          f"z=[{coords[:,3].min().item()},{coords[:,3].max().item()}]")
    return out
pipe.sample_shape_slat = _debug_shape

# Vanilla pipeline — focus on diagnosing tex_slat_flow_model bf16 issue

_orig_sample = pipe.sample_tex_slat
def _debug_sample(*args, **kwargs):
    out = _orig_sample(*args, **kwargs)
    f = out.feats; coords = out.coords
    print(f"[DEBUG] sample_tex_slat OUTPUT: shape={tuple(f.shape)} "
          f"min={f.min().item():.3f} max={f.max().item():.3f} "
          f"mean={f.mean().item():.3f} std={f.std().item():.3f}")
    print(f"[DEBUG] tex_slat coords: x=[{coords[:,1].min().item()},{coords[:,1].max().item()}] "
          f"y=[{coords[:,2].min().item()},{coords[:,2].max().item()}] "
          f"z=[{coords[:,3].min().item()},{coords[:,3].max().item()}]")
    return out
pipe.sample_tex_slat = _debug_sample

# DEBUG: dump tex_slat normalization params + check spatial coherence on the
# RAW SAMPLER OUTPUT (before normalization, before decoder)
print(f"[DEBUG] tex_slat_normalization mean[:6]: {pipe.tex_slat_normalization['mean'][:6]}")
print(f"[DEBUG] tex_slat_normalization std[:6]:  {pipe.tex_slat_normalization['std'][:6]}")
print(f"[DEBUG] tex_slat_normalization mean dtype: {type(pipe.tex_slat_normalization['mean'])}, "
      f"len={len(pipe.tex_slat_normalization['mean'])}")
# Hook the decoder INPUT to see if input is coherent or noise already
import trellis2.modules.sparse.basic as _spbasic
def _hook_decoder_input(slat, subs):
    f = slat.feats
    print(f"[DECODER INPUT] N={f.shape[0]} C={f.shape[1]} dtype={f.dtype}")
    print(f"  global: min={f.min().item():.3f} max={f.max().item():.3f} mean={f.mean().item():.3f} std={f.std().item():.3f}")
    # Check spatial coherence of INPUT to decoder
    import numpy as _np, torch as _torch
    coords = slat.coords  # (N, 4) [batch, x, y, z]
    if coords.shape[0] >= 100:
        # Pick 100 random voxels, find their nearest neighbor in xyz space
        with _torch.no_grad():
            xyz = coords[:, 1:].float().cpu().numpy()
            from scipy.spatial import cKDTree
            tree = cKDTree(xyz)
            sample_idx = _np.random.default_rng(0).choice(len(xyz), size=min(2000, len(xyz)), replace=False)
            _, nn_idx = tree.query(xyz[sample_idx], k=2)
            nn_idx = nn_idx[:, 1]
            f_cpu = f.float().cpu().numpy()
            nn_diff = _np.linalg.norm(f_cpu[sample_idx] - f_cpu[nn_idx], axis=1).mean()
            rng = _np.random.default_rng(42)
            rand_idx = rng.integers(0, len(xyz), len(sample_idx))
            rand_diff = _np.linalg.norm(f_cpu[sample_idx] - f_cpu[rand_idx], axis=1).mean()
            print(f"  SPATIAL COHERENCE: nn_diff={nn_diff:.3f} rand_diff={rand_diff:.3f} ratio={nn_diff/rand_diff:.3f}")
    return _orig_decode_tex(slat, subs)
_orig_decode_tex = pipe.decode_tex_slat
pipe.decode_tex_slat = _hook_decoder_input

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

print(f"DIAG attr_volume: shape={tuple(mesh.attrs.shape)} "
      f"min={mesh.attrs.min().item():.3f} max={mesh.attrs.max().item():.3f} "
      f"mean={mesh.attrs.mean().item():.3f} std={mesh.attrs.std().item():.3f}")
# Per-channel
for c in range(min(6, mesh.attrs.shape[1])):
    ch = mesh.attrs[:, c]
    print(f"  ch{c}: min={ch.min().item():.3f} max={ch.max().item():.3f} mean={ch.mean().item():.3f} std={ch.std().item():.3f}")

# DUMP: voxel point cloud with RGB to validate decoder output
import trimesh as _tm
_voxel_size = float(mesh.voxel_size) if not hasattr(mesh.voxel_size, 'numel') else float(mesh.voxel_size)
_pts = mesh.coords.float().cpu().numpy() * _voxel_size + np.array([-0.5, -0.5, -0.5])
_rgb = mesh.attrs[:, :3].clamp(0, 1).cpu().numpy()
_rgba = np.concatenate([(_rgb * 255).astype(np.uint8), np.full((_rgb.shape[0], 1), 255, dtype=np.uint8)], axis=1)
_pc_path = out_path.replace('.glb', '_voxels_rgb.ply')
_pc = _tm.PointCloud(_pts, colors=_rgba)
_pc.export(_pc_path)
print(f"DUMP voxel cloud: {_pc_path} ({len(_pts)} points)")

# Render orthographic projection to PNG (front view, axis-aligned)
import imageio
_img = np.zeros((512, 512, 3), dtype=np.float32)
_count = np.zeros((512, 512), dtype=np.int32)
# Project onto XY plane (front view)
_x = ((_pts[:, 0] + 0.5) * 512).astype(np.int32).clip(0, 511)
_y = ((0.5 - _pts[:, 1]) * 512).astype(np.int32).clip(0, 511)
_z = _pts[:, 2]
# Sort by Z ascending so closest (largest Z) overwrites
_order = np.argsort(_z)
for px, py, rgb in zip(_x[_order], _y[_order], _rgb[_order]):
    _img[py, px] = rgb
_img8 = (np.clip(_img, 0, 1) * 255).astype(np.uint8)
_proj_path = out_path.replace('.glb', '_voxel_front.png')
imageio.imwrite(_proj_path, _img8)
print(f"DUMP front projection: {_proj_path}")

print("Exporting to GLB via o_voxel_patch.to_glb (PURE PYTORCH, no nvdiffrast)...")
try:
    glb = o_voxel_patch.to_glb(
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
