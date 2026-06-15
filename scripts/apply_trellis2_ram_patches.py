#!/usr/bin/env python3
"""Re-apply the FabMesh RAM-reduction patches to the (gitignored) TRELLIS-2
checkout.

external/TRELLIS2_win is NOT tracked by git, so the three memory patches we
hand-edit into it would be lost the next time TRELLIS-2 is re-installed /
re-cloned. This script re-applies them idempotently — run it after any
TRELLIS-2 (re)setup:

    python scripts/apply_trellis2_ram_patches.py

The patches cut the system-RAM peak of the cascade SLat pass (observed
~104 s/iteration when the working set spills past physical RAM and pages to
disk, vs ~1.4 s/it when it fits). See AGENT_LOG.md 2026-06-14.

  (a) flow_euler.py        — don't keep the full sampling trajectory
                             (24 latent copies per pass) unless return_traj.
  (c) trellis2_image_to_3d — free the LR slat + upsample coords before the
                             HR pass reallocates them.
  (b) trellis2_image_to_3d — honor FABMESH_TRELLIS2_MAX_TOKENS env to cap the
                             HR token budget (set to 32768 for Ultra/1536).

Exit code 0 = all patches present (applied now or already there); 1 = a
target file or anchor was not found (TRELLIS-2 upstream changed — re-derive).
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
T2 = ROOT / "external" / "TRELLIS2_win" / "src" / "trellis2" / "pipelines"
FLOW = T2 / "samplers" / "flow_euler.py"
IMG = T2 / "trellis2_image_to_3d.py"
SATTN = (ROOT / "external" / "TRELLIS2_win" / "src" / "trellis2" / "modules"
         / "sparse" / "attention" / "full_attn.py")
WATTN = (ROOT / "external" / "TRELLIS2_win" / "src" / "trellis2" / "modules"
         / "sparse" / "attention" / "windowed_attn.py")

# Shared SDPA window-attention body (one torch SDPA per window, fp32, EFFICIENT
# kernel) — the texturing model uses windowed sparse attention, which had ONLY
# xformers/flash_attn branches; with SPARSE_ATTN_BACKEND=sdpa (no flash_attn in
# the texturing venv) `out` was never assigned. These add the missing branch.
_WATTN_SELF_NEW = """    elif config.ATTN == 'flash_attn':
        if 'flash_attn' not in globals():
            import flash_attn
        out = flash_attn.flash_attn_varlen_qkvpacked_func(qkv_feats, **attn_func_args)  # [M, H, C]
    else:
        # [blackwell_fix] SDPA fallback (sm_120 / no flash_attn) — windowed
        # self attention, one torch SDPA per window in fp32 (EFFICIENT kernel).
        # Mirrors the full_attn sdpa branch.
        from torch.nn.functional import scaled_dot_product_attention as _sdpa
        try:
            from torch.nn.attention import sdpa_kernel, SDPBackend
            _kctx = sdpa_kernel([SDPBackend.EFFICIENT_ATTENTION, SDPBackend.MATH])
        except ImportError:
            import contextlib
            _kctx = contextlib.nullcontext()
        q_all, k_all, v_all = qkv_feats.unbind(dim=1)  # each [M, H, C]
        orig_dtype = q_all.dtype
        out_list = []
        off = 0
        with _kctx:
            for sl in seq_lens.tolist():
                sl = int(sl)
                qi = q_all[off:off+sl].permute(1, 0, 2).unsqueeze(0).contiguous().float()
                ki = k_all[off:off+sl].permute(1, 0, 2).unsqueeze(0).contiguous().float()
                vi = v_all[off:off+sl].permute(1, 0, 2).unsqueeze(0).contiguous().float()
                oi = _sdpa(qi, ki, vi).squeeze(0).permute(1, 0, 2).contiguous().to(orig_dtype)
                out_list.append(oi)
                off += sl
        out = torch.cat(out_list, dim=0)  # [M, H, C]

    out = out[bwd_indices]      # [T, H, C]"""
_WATTN_SELF_OLD = """    elif config.ATTN == 'flash_attn':
        if 'flash_attn' not in globals():
            import flash_attn
        out = flash_attn.flash_attn_varlen_qkvpacked_func(qkv_feats, **attn_func_args)  # [M, H, C]

    out = out[bwd_indices]      # [T, H, C]"""
_WATTN_CROSS_NEW = """    elif config.ATTN == 'flash_attn':
        if 'flash_attn' not in globals():
            import flash_attn
        out = flash_attn.flash_attn_varlen_kvpacked_func(q_feats, kv_feats,
            cu_seqlens_q=q_attn_func_args['cu_seqlens'], cu_seqlens_k=kv_attn_func_args['cu_seqlens'],
            max_seqlen_q=q_attn_func_args['max_seqlen'], max_seqlen_k=kv_attn_func_args['max_seqlen'],
        )  # [M, H, C]
    else:
        # [blackwell_fix] SDPA fallback (sm_120 / no flash_attn) — windowed
        # cross attention, one torch SDPA per (q-window, kv-window) pair.
        from torch.nn.functional import scaled_dot_product_attention as _sdpa
        try:
            from torch.nn.attention import sdpa_kernel, SDPBackend
            _kctx = sdpa_kernel([SDPBackend.EFFICIENT_ATTENTION, SDPBackend.MATH])
        except ImportError:
            import contextlib
            _kctx = contextlib.nullcontext()
        k_all, v_all = kv_feats.unbind(dim=1)  # each [M, H, C]
        q_all = q_feats                        # [M, H, C]
        orig_dtype = q_all.dtype
        out_list = []
        qoff = 0
        kvoff = 0
        with _kctx:
            for ql, kl in zip(q_seq_lens.tolist(), kv_seq_lens.tolist()):
                ql = int(ql); kl = int(kl)
                qi = q_all[qoff:qoff+ql].permute(1, 0, 2).unsqueeze(0).contiguous().float()
                ki = k_all[kvoff:kvoff+kl].permute(1, 0, 2).unsqueeze(0).contiguous().float()
                vi = v_all[kvoff:kvoff+kl].permute(1, 0, 2).unsqueeze(0).contiguous().float()
                oi = _sdpa(qi, ki, vi).squeeze(0).permute(1, 0, 2).contiguous().to(orig_dtype)
                out_list.append(oi)
                qoff += ql
                kvoff += kl
        out = torch.cat(out_list, dim=0)  # [M, H, C]

    out = out[q_bwd_indices]      # [T, H, C]"""
_WATTN_CROSS_OLD = """    elif config.ATTN == 'flash_attn':
        if 'flash_attn' not in globals():
            import flash_attn
        out = flash_attn.flash_attn_varlen_kvpacked_func(q_feats, kv_feats,
            cu_seqlens_q=q_attn_func_args['cu_seqlens'], cu_seqlens_k=kv_attn_func_args['cu_seqlens'],
            max_seqlen_q=q_attn_func_args['max_seqlen'], max_seqlen_k=kv_attn_func_args['max_seqlen'],
        )  # [M, H, C]

    out = out[q_bwd_indices]      # [T, H, C]"""

# Each patch: (file, anchor-old, replacement-new, already-applied-marker)
PATCHES = [
    (
        FLOW,
        '''        ret = edict({"samples": None, "pred_x_t": [], "pred_x_0": []})
        for t, t_prev in tqdm(t_pairs, desc=tqdm_desc, disable=not verbose):
            out = self.sample_once(model, sample, t, t_prev, cond, **kwargs)
            sample = out.pred_x_prev
            ret.pred_x_t.append(out.pred_x_prev)
            ret.pred_x_0.append(out.pred_x_0)
        ret.samples = sample
        return ret''',
        '''        return_traj = kwargs.pop("return_traj", False)
        ret = edict({"samples": None, "pred_x_t": [], "pred_x_0": []})
        for t, t_prev in tqdm(t_pairs, desc=tqdm_desc, disable=not verbose):
            out = self.sample_once(model, sample, t, t_prev, cond, **kwargs)
            sample = out.pred_x_prev
            if return_traj:
                ret.pred_x_t.append(out.pred_x_prev)
                ret.pred_x_0.append(out.pred_x_0)
        ret.samples = sample
        return ret''',
        'return_traj = kwargs.pop("return_traj", False)',
    ),
    (
        IMG,
        '''            hr_resolution -= 128

        # Sample structured latent
        noise = SparseTensor(''',
        '''            hr_resolution -= 128

        # FABMESH mem-opt: LR working set is dead here (coords + hr_resolution
        # already finalized and survive); drop LR slat + upsample coords before
        # the HR pass reallocates 'slat'/'noise' to cut the system-RAM peak.
        import gc
        del slat, hr_coords, quant_coords
        gc.collect()
        torch.cuda.empty_cache()

        # Sample structured latent
        noise = SparseTensor(''',
        'del slat, hr_coords, quant_coords',
    ),
    (
        IMG,
        '''            max_num_tokens (int): The maximum number of tokens to use.
        """
        # Check pipeline type
        pipeline_type = pipeline_type or self.default_pipeline_type''',
        '''            max_num_tokens (int): The maximum number of tokens to use.
        """
        # FabMesh: optional HR token-budget cap to reduce peak system RAM on
        # the 1536_cascade pass (16 GB PC target). Env override only; when unset
        # the upstream default (49152) is preserved untouched.
        import os as _os
        _env_cap = _os.environ.get('FABMESH_TRELLIS2_MAX_TOKENS')
        if _env_cap:
            max_num_tokens = int(_env_cap)
        # Check pipeline type
        pipeline_type = pipeline_type or self.default_pipeline_type''',
        "_os.environ.get('FABMESH_TRELLIS2_MAX_TOKENS')",
    ),
    (
        SATTN,
        "            _kernel_ctx = sdpa_kernel([SDPBackend.MATH])",
        "            _kernel_ctx = sdpa_kernel([SDPBackend.EFFICIENT_ATTENTION, SDPBackend.MATH])",
        "sdpa_kernel([SDPBackend.EFFICIENT_ATTENTION",
    ),
    (WATTN, _WATTN_SELF_OLD, _WATTN_SELF_NEW,
     "# self attention, one torch SDPA per window"),
    (WATTN, _WATTN_CROSS_OLD, _WATTN_CROSS_NEW,
     "# cross attention, one torch SDPA per (q-window, kv-window) pair."),
]


def main() -> int:
    ok = True
    for path, old, new, marker in PATCHES:
        if not path.exists():
            print(f"[SKIP] target missing: {path}")
            ok = False
            continue
        text = path.read_text(encoding="utf-8")
        if marker in text:
            print(f"[OK ] already patched: {path.name} ({marker[:40]}...)")
            continue
        if old not in text:
            print(f"[FAIL] anchor not found in {path.name} — upstream changed, "
                  f"re-derive this patch")
            ok = False
            continue
        path.write_text(text.replace(old, new, 1), encoding="utf-8")
        print(f"[APPLIED] {path.name} ({marker[:40]}...)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
