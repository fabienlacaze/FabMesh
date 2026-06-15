"""Test isolé: torch.polar + view_as_complex sur sm_120 Blackwell.

Vérifie si la RoPE 3D produit des résultats corrects ou cassés.

Hypothèse: torch.view_as_complex(x.float().reshape(...)) sur Blackwell
peut silently corrupt le résultat car :
  1) x.float() crée une COPIE (OK)
  2) .reshape(*shape, -1, 2) doit être contiguous pour view_as_complex
  3) si x est issu d'un unbind/permute, peut être non-contiguous

Test: comparer CPU vs CUDA pour la même operation.
"""
import torch
import numpy as np

device = torch.device("cuda")
print(f"Device: {torch.cuda.get_device_name(0)} CC {torch.cuda.get_device_capability(0)}")
print(f"Torch: {torch.__version__}")

torch.manual_seed(0)

# === TEST 1: torch.polar pure ===
print("\n=== TEST 1: torch.polar pure ===")
phases = torch.randn(1000, 64, device="cpu") * np.pi
p_cpu = torch.polar(torch.ones_like(phases), phases)
p_cuda = torch.polar(torch.ones_like(phases.cuda()), phases.cuda())
diff = (p_cpu.cuda() - p_cuda).abs().max().item()
print(f"  polar CPU vs CUDA max diff: {diff:.2e}")

# === TEST 2: view_as_complex on contiguous bf16->fp32 ===
print("\n=== TEST 2: view_as_complex sur tensor bf16 -> float ===")
x_bf16 = torch.randn(1000, 16, 64, device="cuda", dtype=torch.bfloat16)
print(f"  x_bf16 shape={x_bf16.shape} stride={x_bf16.stride()} contig={x_bf16.is_contiguous()}")
x_f = x_bf16.float()
print(f"  x_f shape={x_f.shape} stride={x_f.stride()} contig={x_f.is_contiguous()}")
x_r = x_f.reshape(*x_f.shape[:-1], -1, 2)
print(f"  x_r shape={x_r.shape} stride={x_r.stride()} contig={x_r.is_contiguous()}")
x_c = torch.view_as_complex(x_r)
print(f"  x_c shape={x_c.shape} dtype={x_c.dtype}")

# Round trip: complex back to real
x_back = torch.view_as_real(x_c).reshape(*x_c.shape[:-1], -1)
diff = (x_back - x_f).abs().max().item()
print(f"  round-trip max diff: {diff:.2e} (should be 0)")

# === TEST 3: SIMULATE FULL ROPE OPERATION exactement comme dans rope.py ===
print("\n=== TEST 3: full RoPE sim (q in bf16, phases in complex64) ===")
torch.manual_seed(42)
N = 10000  # voxels
H = 12     # heads
D = 128    # head_dim
freq_dim = D // 2 // 3  # = 21
indices = torch.randint(0, 64, (N, 3), device="cuda")  # 3D coords

freqs = torch.arange(freq_dim, dtype=torch.float32, device="cuda") / freq_dim
freqs = 1.0 / (10000.0 ** freqs)
phases = torch.outer(indices.reshape(-1), freqs)  # (N*3, freq_dim)
phases = torch.polar(torch.ones_like(phases), phases)
phases = phases.reshape(N, 3, freq_dim).reshape(N, 3 * freq_dim)
# Pad to head_dim/2
padn = D // 2 - phases.shape[-1]
if padn > 0:
    pad = torch.polar(torch.ones(N, padn, device="cuda"), torch.zeros(N, padn, device="cuda"))
    phases = torch.cat([phases, pad], dim=-1)
print(f"  phases shape={phases.shape} dtype={phases.dtype}")

# Q tensor
q_bf16 = torch.randn(N, H, D, device="cuda", dtype=torch.bfloat16)
print(f"  q_bf16 shape={q_bf16.shape} stride={q_bf16.stride()}")

# Apply RoPE (exact rope.py code)
def apply_rope(x, phases):
    x_complex = torch.view_as_complex(x.float().reshape(*x.shape[:-1], -1, 2))
    x_rotated = x_complex * phases.unsqueeze(-2)
    x_embed = torch.view_as_real(x_rotated).reshape(*x_rotated.shape[:-1], -1).to(x.dtype)
    return x_embed

q_rope = apply_rope(q_bf16, phases)
print(f"  q_rope shape={q_rope.shape} dtype={q_rope.dtype}")
print(f"  q_rope: min={q_rope.min().item():.4f} max={q_rope.max().item():.4f} "
      f"mean={q_rope.mean().item():.4f} std={q_rope.std().item():.4f}")
print(f"  q_bf16: min={q_bf16.min().item():.4f} max={q_bf16.max().item():.4f} "
      f"mean={q_bf16.mean().item():.4f} std={q_bf16.std().item():.4f}")

# RoPE preserves norm: |q_rope| should == |q|
n_orig = q_bf16.float().norm(dim=-1)
n_rope = q_rope.float().norm(dim=-1)
norm_err = (n_rope - n_orig).abs().max().item()
print(f"  norm preservation error: {norm_err:.2e} (should be ~1e-3 in bf16)")

# RoPE should give different output for different positions
# Check: same q, different positions -> different output
q_same = q_bf16[0:1].expand(N, H, D).contiguous()
q_same_rope = apply_rope(q_same, phases)
diff_per_voxel = (q_same_rope - q_same_rope[0:1]).float().abs().mean(dim=(1, 2))
print(f"  pos-dependent variance: mean={diff_per_voxel.mean().item():.4f} (should be > 0.1)")
print(f"  pos-dependent variance: min={diff_per_voxel.min().item():.4f} max={diff_per_voxel.max().item():.4f}")

# === TEST 4: COMPARE WITH CPU GROUND TRUTH ===
print("\n=== TEST 4: CPU vs CUDA reference ===")
torch.manual_seed(42)
indices_c = indices.cpu()
freqs_c = torch.arange(freq_dim, dtype=torch.float32) / freq_dim
freqs_c = 1.0 / (10000.0 ** freqs_c)
phases_c = torch.outer(indices_c.reshape(-1), freqs_c)
phases_c = torch.polar(torch.ones_like(phases_c), phases_c).reshape(N, 3, freq_dim).reshape(N, 3 * freq_dim)
if padn > 0:
    pad_c = torch.polar(torch.ones(N, padn), torch.zeros(N, padn))
    phases_c = torch.cat([phases_c, pad_c], dim=-1)
phases_diff = (phases_c.cuda() - phases).abs().max().item()
print(f"  phases CPU vs CUDA max diff: {phases_diff:.2e}")

q_cpu = q_bf16.cpu()
q_rope_cpu = apply_rope(q_cpu, phases_c)
q_rope_diff = (q_rope_cpu.cuda().float() - q_rope.float()).abs().max().item()
print(f"  q_rope CPU vs CUDA max diff: {q_rope_diff:.2e} (>1e-2 = SUSPECT!)")

mean_diff = (q_rope_cpu.cuda().float() - q_rope.float()).abs().mean().item()
print(f"  q_rope CPU vs CUDA mean diff: {mean_diff:.2e}")

# === TEST 5: spconv coords casted to RoPE indices ===
print("\n=== TEST 5: real spconv int32 coords ===")
# spconv stores coords as int32, RoPE casts via reshape(-1) then outer
coords_int = torch.randint(0, 32, (5000, 4), device="cuda", dtype=torch.int32)
coords_xyz = coords_int[..., 1:]
print(f"  coords_xyz dtype={coords_xyz.dtype}")
phases_int = torch.outer(coords_xyz.reshape(-1), freqs)
print(f"  outer(int32, fp32) -> dtype={phases_int.dtype}")
# This is a known PyTorch quirk: outer(int, fp) returns fp32 OK on CPU,
# but on Blackwell may behave differently
phases_int_cpu = torch.outer(coords_xyz.cpu().reshape(-1), freqs.cpu())
diff_int = (phases_int_cpu.cuda() - phases_int).abs().max().item()
print(f"  outer(int32, fp32) CUDA vs CPU max diff: {diff_int:.2e}")

print("\n=== DONE ===")
