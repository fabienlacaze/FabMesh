"""SDPA-backed shim for the `flash_attn_interface` (FlashAttention-3 API).

SkinTokens' transformer blocks try `from flash_attn_interface import flash_attn_func`.
On this machine we can't ship flash-attn: its compiled .pyd would be blocked by
Windows Smart App Control (same as pandas). torch's built-in scaled_dot_product_attention
(SDPA) is the same attention, runs natively on RTX 5080 / sm_120, needs no extra build.

flash_attn_func's tensors are [B, S, H, D] (flash layout); SDPA wants [B, H, S, D].
FA-3 returns (out, softmax_lse) — we return (out, None); every call site either
unpacks `out, _ = ...` or ignores the second element, matching the in-repo SDPA fallbacks.
"""
import torch
import torch.nn.functional as F


def flash_attn_func(q, k, v, dropout_p=0.0, softmax_scale=None, causal=False, *args, **kwargs):
    qt = q.transpose(1, 2)  # [B, H, S, D]
    kt = k.transpose(1, 2)
    vt = v.transpose(1, 2)
    # GQA/MQA: broadcast kv heads up to the number of query heads if they differ.
    if qt.shape[1] != kt.shape[1] and kt.shape[1] > 0:
        r = qt.shape[1] // kt.shape[1]
        if r > 1:
            kt = kt.repeat_interleave(r, dim=1)
            vt = vt.repeat_interleave(r, dim=1)
    out = F.scaled_dot_product_attention(
        qt, kt, vt, dropout_p=dropout_p, is_causal=causal, scale=softmax_scale
    )
    return out.transpose(1, 2).contiguous(), None  # [B, S, H, D], lse=None
