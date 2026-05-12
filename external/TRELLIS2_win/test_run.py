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

# [blackwell_fix] Force sparse attention to SDPA math backend
# flash_attn bf16 produces noise on sm_120 (root cause of texture random)
os.environ['SPARSE_ATTN_BACKEND'] = 'sdpa'
print("[blackwell_fix] SPARSE_ATTN_BACKEND=sdpa (avoid flash_attn bf16 sm_120)")

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
torch.backends.cudnn.deterministic = True
torch.backends.cudnn.benchmark = False
# Force fp32 reduction in fp16/bf16 matmul (helps Blackwell precision)
torch.backends.cuda.matmul.allow_fp16_reduced_precision_reduction = False
torch.backends.cuda.matmul.allow_bf16_reduced_precision_reduction = False
print("[blackwell_fix] cuDNN deterministic + no reduced precision reduction")

# [Angle A 2026-05-12] Force PyTorch SDPA to use ONLY the math backend.
# Hypothesis: on sm_120 the flash/mem_efficient SDPA kernels have a silent
# precision bug producing the spatial noise in tex_slat_flow output.
# Math backend is the slowest but bit-exact reference path.
# Enable via env var SDPA_MATH_ONLY=1.
if os.environ.get('SDPA_MATH_ONLY') == '1':
    torch.backends.cuda.enable_flash_sdp(False)
    torch.backends.cuda.enable_mem_efficient_sdp(False)
    torch.backends.cuda.enable_math_sdp(True)
    try:
        torch.backends.cuda.enable_cudnn_sdp(False)
    except AttributeError:
        pass
    print("[blackwell_fix] SDPA_MATH_ONLY=1: flash/mem_eff/cudnn DISABLED, only MATH enabled")

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

# [blackwell_fix] CPU FORCED for tex_slat_flow_model
# Bypass all GPU bugs by running the flow model on CPU. Very slow but
# definitive test: if CPU produces low ratio, bug is GPU-specific.
import os as _os_cpu
# [DEBUG] Bypass tex_slat_flow: pass shape_slat directly to decoder
import os as _os_bypass
# Force flow model dtype = fp32 in forward (bypass bf16)
import os as _os_f32
if _os_f32.environ.get('FLOW_FP32_FWD') == '1':
    print("[blackwell_fix] FLOW_FP32_FWD=1: tex_slat_flow_model_512 ONLY -> fp32")
    _m = pipe.models['tex_slat_flow_model_512']
    _m.float()
    _m.use_fp16 = False
    if hasattr(_m, 'dtype'):
        _m.dtype = torch.float32
    _m.cuda()
    # SDPA backend for sparse attention (flash_attn requires bf16/fp16)
    import trellis2.modules.sparse.config as _sp_cfg
    _sp_cfg.ATTN = 'sdpa'
    print("  tex_slat_flow_model_512 -> fp32, sparse ATTN -> sdpa")

if _os_bypass.environ.get('BYPASS_TEX_FLOW') == '1':
    print("[DEBUG] BYPASS_TEX_FLOW: skip flow, send random latent + shape_slat to decoder")
    _orig_sample_tex_bypass = pipe.sample_tex_slat
    def _bypass_sample_tex_slat(cond, flow_model, shape_slat, sampler_params={}):
        import torch as _t
        N = shape_slat.coords.shape[0]
        mode = _os_bypass.environ.get('BYPASS_MODE', 'random')
        if mode == 'zero':
            slat_feats = _t.zeros(N, 32, device=shape_slat.device)
        elif mode == 'mean':
            mean = _t.tensor(pipe.tex_slat_normalization['mean'])[None].to(shape_slat.device)
            slat_feats = mean.expand(N, 32).contiguous()
        else:  # random
            mean = _t.tensor(pipe.tex_slat_normalization['mean'])[None].to(shape_slat.device)
            std = _t.tensor(pipe.tex_slat_normalization['std'])[None].to(shape_slat.device)
            rand = _t.randn(N, 32, device=shape_slat.device)
            slat_feats = rand * std + mean
        result = shape_slat.replace(feats=slat_feats)
        print(f"[BYPASS mode={mode}] tex_slat min={slat_feats.min().item():.2f} max={slat_feats.max().item():.2f}")
        return result
    pipe.sample_tex_slat = _bypass_sample_tex_slat

if _os_cpu.environ.get('CPU_TEX_FLOW') == '1':
    print("[blackwell_fix] CPU_TEX_FLOW=1: moving tex_slat_flow_model to CPU (slow)")
    _tex_flow = pipe.models['tex_slat_flow_model_512']
    _tex_flow.cpu()

    # Patch SparseRotaryPositionEmbedder to bypass cache (would point to GPU tensors)
    from trellis2.modules.sparse.attention.rope import SparseRotaryPositionEmbedder as _SRPE
    _orig_rope_forward = _SRPE.forward
    def _patched_rope_forward(self, q, k=None):
        # Always recompute phases on q's device (no cache lookup)
        coords = q.coords[..., 1:]
        phases = self._get_phases(coords.reshape(-1)).reshape(*coords.shape[:-1], -1)
        if phases.shape[-1] < self.head_dim // 2:
            padn = self.head_dim // 2 - phases.shape[-1]
            phases = torch.cat([phases, torch.polar(
                torch.ones(*phases.shape[:-1], padn, device=phases.device),
                torch.zeros(*phases.shape[:-1], padn, device=phases.device)
            )], dim=-1)
        q_embed = q.replace(self._rotary_embedding(q.feats, phases))
        if k is None:
            return q_embed
        k_embed = k.replace(self._rotary_embedding(k.feats, phases))
        return q_embed, k_embed
    _SRPE.forward = _patched_rope_forward
    print("[blackwell_fix] RoPE phases cache bypassed (always recompute on current device)")
    # Override pipe.device by monkey-patching the class property
    type(pipe)._cpu_override = None
    _orig_device_prop = type(pipe).device
    def _patched_device(self):
        if getattr(self, '_cpu_override', None) is not None:
            return self._cpu_override
        return _orig_device_prop.fget(self)
    type(pipe).device = property(_patched_device)

    _orig_sample_tex = pipe.sample_tex_slat
    def _cpu_sample_tex_slat(cond, flow_model, shape_slat, sampler_params={}):
        print("[CPU FLOW] starting CPU sampling...")
        import time as _t
        _t0 = _t.time()
        shape_slat_cpu = shape_slat.cpu()
        cond_cpu = {}
        for k, v in cond.items():
            if isinstance(v, torch.Tensor):
                cond_cpu[k] = v.cpu()
            elif isinstance(v, list):
                cond_cpu[k] = [x.cpu() if isinstance(x, torch.Tensor) else x for x in v]
            else:
                cond_cpu[k] = v
        pipe._cpu_override = torch.device('cpu')
        try:
            result = _orig_sample_tex(cond_cpu, flow_model, shape_slat_cpu, sampler_params)
        finally:
            pipe._cpu_override = None
        result = result.cuda()
        print(f"[CPU FLOW] done in {_t.time()-_t0:.1f}s")
        return result
    pipe.sample_tex_slat = _cpu_sample_tex_slat

# === DIAG: re-load tex_slat_flow with strict=True to see if any weights missed ===
import os as _os_kc
if _os_kc.environ.get('CHECK_WEIGHTS') == '1':
    print("[CHECK] Re-checking tex_slat_flow_model_512 weights (strict=True dry-run)")
    from safetensors.torch import load_file
    from huggingface_hub import hf_hub_download
    _wf = hf_hub_download("microsoft/TRELLIS.2-4B", "ckpts/slat_flow_imgshape2tex_dit_1_3B_512_bf16.safetensors")
    _state = load_file(_wf)
    _model_state = pipe.models['tex_slat_flow_model_512'].state_dict()
    _missing = set(_model_state.keys()) - set(_state.keys())
    _unexpected = set(_state.keys()) - set(_model_state.keys())
    print(f"[CHECK] missing keys ({len(_missing)}): {sorted(_missing)[:20]}{' ...' if len(_missing)>20 else ''}")
    print(f"[CHECK] unexpected keys ({len(_unexpected)}): {sorted(_unexpected)[:20]}{' ...' if len(_unexpected)>20 else ''}")
    # Check shape mismatches
    _shape_mismatch = []
    for k in set(_state.keys()) & set(_model_state.keys()):
        if _state[k].shape != _model_state[k].shape:
            _shape_mismatch.append((k, _state[k].shape, _model_state[k].shape))
    print(f"[CHECK] shape mismatches ({len(_shape_mismatch)}): {_shape_mismatch[:10]}")
    # Check if modulation/adaLN keys present
    _mod_keys_state = [k for k in _state.keys() if 'modulation' in k.lower() or 'adaln' in k.lower()][:30]
    _mod_keys_model = [k for k in _model_state.keys() if 'modulation' in k.lower() or 'adaln' in k.lower()][:30]
    print(f"[CHECK] mod-related keys in state file: {_mod_keys_state[:5]}")
    print(f"[CHECK] mod-related keys in model:      {_mod_keys_model[:5]}")

# === BLACKWELL DEEP DIAGNOSTIC: hook every block of tex_slat_flow_model_512 ===
import os as _os_diag
DIAG_TEX_FLOW_BLOCKS = _os_diag.environ.get('DIAG_TEX_FLOW_BLOCKS') == '1'
if DIAG_TEX_FLOW_BLOCKS:
    print("[DIAG] Installing per-block hooks on tex_slat_flow_model_512")
    _tex_flow = pipe.models['tex_slat_flow_model_512']
    _flow_call_count = [0]
    _block_stats = []

    def _stat_block(idx):
        def _hook(module, inputs, output):
            if _flow_call_count[0] not in (1, 6, 12):
                return
            from scipy.spatial import cKDTree
            import numpy as _np
            x = output  # SparseTensor
            f = x.feats.float()
            coords = x.coords[:, 1:].float().cpu().numpy()
            f_cpu = f.cpu().numpy()
            if len(coords) >= 1000:
                tree = cKDTree(coords)
                sample_idx = _np.random.default_rng(0).choice(len(coords), size=min(2000, len(coords)), replace=False)
                _, nn_idx = tree.query(coords[sample_idx], k=2)
                nn_idx = nn_idx[:, 1]
                nn_d = _np.linalg.norm(f_cpu[sample_idx] - f_cpu[nn_idx], axis=1).mean()
                rng = _np.random.default_rng(42)
                rand_idx = rng.integers(0, len(coords), len(sample_idx))
                rand_d = _np.linalg.norm(f_cpu[sample_idx] - f_cpu[rand_idx], axis=1).mean()
                ratio = nn_d / rand_d
            else:
                ratio = -1
            print(f"[DIAG] step{_flow_call_count[0]} blk{idx:02d}: "
                  f"min={f.min().item():.3f} max={f.max().item():.3f} "
                  f"mean={f.mean().item():.3f} std={f.std().item():.3f} "
                  f"ratio={ratio:.3f} "
                  f"nan={torch.isnan(f).any().item()} inf={torch.isinf(f).any().item()}")
        return _hook

    for _i, _blk in enumerate(_tex_flow.blocks):
        _blk.register_forward_hook(_stat_block(_i))

    _orig_tex_flow_fwd = _tex_flow.forward
    def _patched_tex_flow_fwd(*args, **kwargs):
        _flow_call_count[0] += 1
        if _flow_call_count[0] in (1, 6, 12):
            print(f"[DIAG] === tex_flow call #{_flow_call_count[0]} ===")
        out = _orig_tex_flow_fwd(*args, **kwargs)
        return out
    _tex_flow.forward = _patched_tex_flow_fwd

# === BLACKWELL FIX TENTATIVE: convert tex_slat_flow_model to fp32 ===
FP32_TEX_FLOW = _os_diag.environ.get('FP32_TEX_FLOW') == '1'
if FP32_TEX_FLOW:
    print("[blackwell_fix] Converting tex_slat_flow_model_512 entirely to FP32")
    _tex_flow = pipe.models['tex_slat_flow_model_512']
    _tex_flow.convert_to(torch.float32)
    _tex_flow.dtype = torch.float32
    print(f"  done. dtype now: {next(_tex_flow.parameters()).dtype}")

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

# Vanilla pipeline — investigation: maybe ratio 0.55 is NORMAL and the
# atlas WOULD render correctly in a real PBR viewer.
if False:  # disabled
    pass
# [blackwell_fix] Replace SparseConv3d in tex_slat_decoder with dense
# nn.Conv3d (sparse -> dense -> conv -> re-sparsify). Bypass spconv kernels
# entirely. Sparse Conv3d on Blackwell sm_120 may have a bug producing
# noise that doesn't show in simple tests.
_DENSE_WRAPPER_CODE = '''
import torch.nn as _nn
from trellis2.modules.sparse.conv.conv import SparseConv3d as _SpConv3d
from trellis2.modules.sparse import SparseTensor as _SpTensor

class DenseConv3dWrapper(_nn.Module):
    """Replace a SparseConv3d with a dense nn.Conv3d. Densifies, applies
    Conv3d, returns sparse tensor on the same coords."""
    def __init__(self, sp_conv: _SpConv3d):
        super().__init__()
        # Extract weight/bias from spconv module
        self.in_channels = sp_conv.conv.in_channels
        self.out_channels = sp_conv.conv.out_channels
        self.stride = sp_conv.stride
        kernel_size = sp_conv.conv.kernel_size if hasattr(sp_conv.conv, 'kernel_size') else (3, 3, 3)
        self.kernel_size = kernel_size if isinstance(kernel_size, tuple) else (kernel_size,)*3
        # Build dense Conv3d
        self.conv = _nn.Conv3d(
            self.in_channels, self.out_channels,
            self.kernel_size, padding=tuple(k//2 for k in self.kernel_size), bias=True
        )
        # Copy weights from spconv (KdKhKw layout) to PyTorch (Co Ci Kd Kh Kw)
        spconv_weight = sp_conv.conv.weight.data  # may be (Kd Kh Kw Ci Co) or other
        # Try to detect layout by shape
        sw = spconv_weight
        if sw.shape == (self.out_channels, self.in_channels, *self.kernel_size):
            self.conv.weight.data.copy_(sw)
        elif sw.shape == (*self.kernel_size, self.in_channels, self.out_channels):
            # spconv: (Kd Kh Kw Ci Co) -> torch: (Co Ci Kd Kh Kw)
            self.conv.weight.data.copy_(sw.permute(4, 3, 0, 1, 2).contiguous())
        elif sw.shape == (self.kernel_size[0]*self.kernel_size[1]*self.kernel_size[2], self.in_channels, self.out_channels):
            # Flat KKK -> Co Ci Kd Kh Kw
            sw_r = sw.reshape(*self.kernel_size, self.in_channels, self.out_channels)
            self.conv.weight.data.copy_(sw_r.permute(4, 3, 0, 1, 2).contiguous())
        else:
            print(f"[DenseConv3dWrapper] WARN: unknown weight shape {sw.shape}, expected one of "
                  f"({self.out_channels},{self.in_channels},{self.kernel_size}) or transposed")
            # Fallback: copy raw
            try:
                self.conv.weight.data.copy_(sw.reshape_as(self.conv.weight.data))
            except Exception as e:
                print(f"  reshape fail: {e}")
        if hasattr(sp_conv.conv, 'bias') and sp_conv.conv.bias is not None:
            self.conv.bias.data.copy_(sp_conv.conv.bias.data)
        self.conv = self.conv.cuda()

    def forward(self, x):
        # x is SparseTensor with x.data = SparseConvTensor (spconv)
        # Densify: get spatial_shape and rebuild dense volume
        sp_data = x.data
        coords = sp_data.indices.long()  # (N, 4) [batch, z, y, x] for spconv
        feats = sp_data.features  # (N, C_in)
        spatial = sp_data.spatial_shape
        B = sp_data.batch_size
        D, H, W = spatial[0], spatial[1], spatial[2]
        # Build dense (B, C_in, D, H, W)
        dense = torch.zeros(B, self.in_channels, D, H, W, device=feats.device, dtype=feats.dtype)
        b, z, y, xc = coords.unbind(dim=-1)
        dense[b, :, z, y, xc] = feats
        # Apply Conv3d
        dense_out = self.conv(dense.float()).to(feats.dtype) if feats.dtype == torch.float16 else self.conv(dense)
        # Re-sparsify on same coords
        new_feats = dense_out[b, :, z, y, xc]
        # Build new SparseConvTensor with same coords (assumes stride=1)
        import spconv.pytorch as _spconv
        new_data = _spconv.SparseConvTensor(new_feats, sp_data.indices, spatial, B)
        return _SpTensor(new_data, shape=torch.Size([x.shape[0], self.out_channels]),
                         layout=x.layout, scale=x._scale, spatial_cache=x._spatial_cache)

# Apply to all SparseConv3d in tex_slat_decoder (only stride=1 SubMConv3d)
_n_replaced = 0
import spconv.pytorch as _spconv_pytorch
for _name, _mod in pipe.models['tex_slat_decoder'].named_modules():
    if isinstance(_mod, _SpConv3d) and _mod.stride == (1, 1, 1) and _mod.padding is None:
        # Replace inner spconv module with our wrapper
        try:
            wrapper = DenseConv3dWrapper(_mod).cuda()
            # Patch the forward method of this _SpConv3d instance
            _mod._dense_wrapper = wrapper
            _orig_fwd = _mod.forward
            def _new_fwd(x, _w=wrapper):
                return _w(x)
            _mod.forward = _new_fwd
            _n_replaced += 1
        except Exception as e:
            print(f"[DenseConv] FAIL replace {_name}: {e}")
print(f"[blackwell_fix] Replaced {_n_replaced} SparseConv3d with dense Conv3d wrapper in tex_decoder")
'''

# [Angle E 2026-05-12] Activate DenseConv3dWrapper to bypass spconv.
# Hypothesis: tex_slat_decoder produces noise on sm_120 because spconv
# SubMConv3d CUDA kernels are buggy. Replace with dense nn.Conv3d which
# uses well-tested cudnn paths.
# Enable with DENSE_TEX_DECODER=1.
if os.environ.get('DENSE_TEX_DECODER') == '1':
    print("[blackwell_fix] DENSE_TEX_DECODER=1: replacing SparseConv3d -> dense Conv3d in tex_slat_decoder")
    exec(_DENSE_WRAPPER_CODE)

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

# [Angle E 2026-05-12] Force tex_slat_decoder on CPU (definitive test).
# If CPU produces uniform color silhouette with BYPASS_MODE=mean while GPU
# produces noise → confirms decoder is broken specifically on sm_120 (spconv
# CUDA kernels). Activated via env var CPU_TEX_DECODER=1. Very slow.
if os.environ.get('CPU_TEX_DECODER') == '1':
    print("[blackwell_fix] CPU_TEX_DECODER=1: moving tex_slat_decoder to CPU")
    _tex_dec_cpu = pipe.models['tex_slat_decoder']
    _tex_dec_cpu.cpu()
    _orig_decode_tex_cpu = pipe.decode_tex_slat
    def _cpu_decode_tex_slat(slat, subs):
        import time as _t
        print(f"[CPU DECODER] running on CPU (sparse N={slat.feats.shape[0]} C={slat.feats.shape[1]})...")
        _t0 = _t.time()
        slat_cpu = slat.cpu()
        result = _orig_decode_tex_cpu(slat_cpu, subs)
        if isinstance(result, torch.Tensor):
            result = result.cuda()
        elif hasattr(result, 'cuda'):
            result = result.cuda()
        print(f"[CPU DECODER] done in {_t.time()-_t0:.1f}s")
        return result
    pipe.decode_tex_slat = _cpu_decode_tex_slat

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

# [CRITICAL FIX] DINOv3 stays on CPU after pipe.cuda() — force it to GPU
print(f"  [patch] dino device BEFORE: {next(_dino.parameters()).device}")
pipe.image_cond_model.model = _dino.cuda()
print(f"  [patch] dino device AFTER : {next(pipe.image_cond_model.model.parameters()).device}")

# [CRITICAL FIX 2] extract_features bypasses self.model.forward — use HF native API
import torch.nn.functional as _F
def _patched_extract_features(self, image):
    # Use the HF model's native forward (handles all internal transforms)
    image = image.to(next(self.model.parameters()).dtype)
    out = self.model(image)
    # HF returns BaseModelOutput — get last hidden state
    if hasattr(out, 'last_hidden_state'):
        hidden = out.last_hidden_state
    elif hasattr(out, 'hidden_states'):
        hidden = out.hidden_states[-1]
    else:
        hidden = out[0] if isinstance(out, tuple) else out
    return _F.layer_norm(hidden, hidden.shape[-1:])
import types
pipe.image_cond_model.extract_features = types.MethodType(_patched_extract_features, pipe.image_cond_model)
print("  [patch] extract_features patched to use HF native model.forward()")

print("Pipeline ready on CUDA")

print(f"Running pipeline_type=512...")
t0 = time.time()
_pipeline_type = os.environ.get('PIPELINE_TYPE', '512')
print(f"[test] using pipeline_type={_pipeline_type}")
mesh = pipe.run(img, pipeline_type=_pipeline_type)[0]
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

print("Exporting to GLB via o_voxel.postprocess.to_glb ORIGINAL (with nvdiffrast)...")
try:
    use_orig = os.environ.get('USE_ORIG_TOGLB') == '1'
    if use_orig:
        from o_voxel.postprocess import to_glb as _to_glb_fn
        print("  [test] using ORIGINAL nvdiffrast-based to_glb")
    else:
        _to_glb_fn = o_voxel_patch.to_glb
        print("  [test] using o_voxel_patch (pure PyTorch)")
    glb = _to_glb_fn(
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
