"""Shared SDXL prompt utilities for FabMesh — bypasses the 77-token
CLIP-L cap via a pure-diffusers chunked dual-CLIP encode.

Workflow wb66mnlri identified that diffusers vanilla SDXL Pipeline
silently truncates negative_prompt + positive_prompt past position 77,
making all our anti-anatomy + anti-doubling + anti-cropping negatives
INVISIBLE to CFG. Worse: (token:1.5) Compel-style emphasis is parsed
as 7 literal junk tokens by vanilla diffusers, wasting ~138 tokens
of the 77-budget across the production negs.

Workflow woydvj5w6 audited the full FabMesh pipeline and confirmed 8
files have the same bug (cloud + desktop):
  modal_app/_tpose.py / _rectify.py / _sheet.py / _realvis.py / _backview.py
  scripts/local_juggernaut_bridge.py / generate_back_view.py
                                     / multiview_{sheet,sdxl}_gen.py

This module provides ONE helper used by all of them.

2026-06-09 — CompelForSDXL was triggering CUDA OOM on RTX 5080 16GB
because its EmbeddingsProvider defaults to fp32 for per-token weights
and the empty_z lerp, which promotes the [B, 77, 2048] working buffer
out of fp16 mid-call (and the forward pass runs WITHOUT torch.no_grad,
holding an autograd graph for both CLIP encoders). We replaced it with
a pure-diffusers chunked encode that reuses pipe.tokenizer/text_encoder
in-place under torch.no_grad — same long-prompt + emphasis-weight
behavior as the upstream lpw_stable_diffusion_xl community pipeline,
but with zero new dependency and zero VRAM overhead beyond a single
encode_prompt() call.

Usage:
    from _sdxl_prompt_utils import encode_sdxl_long_prompt
    embeds = encode_sdxl_long_prompt(pipe, positive_prompt, negative_prompt)
    img = pipe(
        prompt_embeds=embeds["prompt_embeds"],
        pooled_prompt_embeds=embeds["pooled_prompt_embeds"],
        negative_prompt_embeds=embeds["negative_prompt_embeds"],
        negative_pooled_prompt_embeds=embeds["negative_pooled_prompt_embeds"],
        num_inference_steps=30,
        guidance_scale=9.5,
        height=1024, width=1024,
        generator=torch.Generator("cuda").manual_seed(seed),
    ).images[0]

Same call drops in to ControlNet and Inpaint pipelines (they accept
the same *_embeds kwargs since diffusers 0.24+).
"""
from __future__ import annotations

import gc
import re
from typing import TYPE_CHECKING, List, Tuple

if TYPE_CHECKING:
    import torch  # noqa: F401


# ---------------------------------------------------------------------------
# Prompt parsing — supports (token:1.4) / (token) / [token] emphasis syntax
# ---------------------------------------------------------------------------

_ATTN_RE = re.compile(
    r"""
    \\\(|\\\)|\\\[|\\\]|       # escaped brackets
    \(|\[|                     # opening
    :([+-]?[.\d]+)\)|          # (xxx:1.2) closing with weight
    \)|\]|                     # closing without weight
    [^\\()\[\]:]+|             # plain text
    :|                         # stray colon
    .                          # fallback single char
    """,
    re.X,
)


def _parse_prompt_attention(text: str) -> List[Tuple[str, float]]:
    """Parse A1111-style (token:1.4) / [token] emphasis into a list of
    (text, weight) tuples. Mirrors the algorithm used by
    diffusers/examples/community/lpw_stable_diffusion_xl.py."""
    res: List[List] = []
    round_brackets: List[int] = []
    square_brackets: List[int] = []
    round_mul = 1.1
    square_mul = 1 / 1.1

    def multiply_range(start_pos: int, mul: float):
        for p in range(start_pos, len(res)):
            res[p][1] *= mul

    for m in _ATTN_RE.finditer(text):
        token = m.group(0)
        weight = m.group(1)
        if token.startswith("\\"):
            res.append([token[1:], 1.0])
        elif token == "(":
            round_brackets.append(len(res))
        elif token == "[":
            square_brackets.append(len(res))
        elif weight is not None and round_brackets:
            multiply_range(round_brackets.pop(), float(weight))
        elif token == ")" and round_brackets:
            multiply_range(round_brackets.pop(), round_mul)
        elif token == "]" and square_brackets:
            multiply_range(square_brackets.pop(), square_mul)
        else:
            res.append([token, 1.0])

    for pos in round_brackets:
        multiply_range(pos, round_mul)
    for pos in square_brackets:
        multiply_range(pos, square_mul)

    if not res:
        res = [["", 1.0]]

    # merge adjacent equal-weight runs
    merged: List[List] = []
    for chunk, w in res:
        if merged and merged[-1][1] == w:
            merged[-1][0] += chunk
        else:
            merged.append([chunk, w])
    return [(c, w) for c, w in merged]


def _get_prompt_tokens_and_weights(tokenizer, text: str) -> Tuple[List[int], List[float]]:
    """Tokenize a prompt with per-token weights from (token:1.4) syntax."""
    parsed = _parse_prompt_attention(text)
    tokens: List[int] = []
    weights: List[float] = []
    for chunk, w in parsed:
        if not chunk:
            continue
        chunk_ids = tokenizer(chunk, truncation=False, add_special_tokens=False).input_ids
        tokens.extend(chunk_ids)
        weights.extend([w] * len(chunk_ids))
    return tokens, weights


def _pad_and_chunk(
    tokens: List[int],
    weights: List[float],
    tokenizer,
    chunk_content: int,
) -> Tuple[List[List[int]], List[List[float]]]:
    """Split (tokens, weights) into 75-token windows; wrap each with
    BOS/EOS and pad to model_max_length=77."""
    bos = tokenizer.bos_token_id
    eos = tokenizer.eos_token_id
    pad_id = tokenizer.pad_token_id if tokenizer.pad_token_id is not None else eos

    if not tokens:
        tokens = []
        weights = []

    chunks_ids: List[List[int]] = []
    chunks_w: List[List[float]] = []
    for i in range(0, max(len(tokens), 1), chunk_content):
        sub_ids = tokens[i:i + chunk_content]
        sub_w = weights[i:i + chunk_content]
        ids = [bos] + sub_ids + [eos]
        ws = [1.0] + sub_w + [1.0]
        pad_n = (chunk_content + 2) - len(ids)
        if pad_n > 0:
            ids = ids + [pad_id] * pad_n
            ws = ws + [1.0] * pad_n
        chunks_ids.append(ids)
        chunks_w.append(ws)
    if not chunks_ids:
        ids = [bos, eos] + [pad_id] * chunk_content
        ws = [1.0] * (chunk_content + 2)
        chunks_ids.append(ids)
        chunks_w.append(ws)
    return chunks_ids, chunks_w


def _encode_one_encoder(text_encoder, tokenizer, text: str, device, dtype):
    """Run one SDXL text encoder over chunked windows and apply per-token
    weights. Returns (hidden [1, N*77, dim], pooled_last_chunk_or_None)."""
    import torch

    chunk_content = tokenizer.model_max_length - 2  # 75
    tokens, weights = _get_prompt_tokens_and_weights(tokenizer, text)
    chunks_ids, chunks_w = _pad_and_chunk(tokens, weights, tokenizer, chunk_content)

    input_ids = torch.tensor(chunks_ids, dtype=torch.long, device=device)  # [N, 77]
    w_tensor = torch.tensor(chunks_w, dtype=dtype, device=device)  # [N, 77]

    out = text_encoder(input_ids, output_hidden_states=True)
    hidden = out.hidden_states[-2].to(dtype)  # [N, 77, dim]

    # Per-token emphasis: scale around the chunk mean to keep norm stable.
    if (w_tensor != 1.0).any():
        prev_mean = hidden.float().mean(dim=(-2, -1), keepdim=True)
        hidden = hidden * w_tensor.unsqueeze(-1)
        new_mean = hidden.float().mean(dim=(-2, -1), keepdim=True)
        hidden = (hidden.float() * (prev_mean / (new_mean + 1e-8))).to(dtype)

    hidden = hidden.reshape(1, -1, hidden.shape[-1])

    pooled = None
    if hasattr(out, "text_embeds") and out.text_embeds is not None:
        pooled = out.text_embeds[-1:].to(dtype).clone()
    return hidden, pooled


def _pad_seq(t, target_len):
    import torch
    if t.shape[1] == target_len:
        return t
    pad = torch.zeros(
        t.shape[0], target_len - t.shape[1], t.shape[2],
        dtype=t.dtype, device=t.device,
    )
    return torch.cat([t, pad], dim=1)


# ---------------------------------------------------------------------------
# Public API — same signature as the previous Compel-based version
# ---------------------------------------------------------------------------

def _get_or_make_compel(pipe):  # kept for backwards-compat import
    """Deprecated: previous CompelForSDXL wrapper caused OOM on 16GB.
    Kept as a no-op stub so any old import still resolves."""
    return None


def encode_sdxl_long_prompt(pipe, positive: str, negative: str = "") -> dict:
    """Encode (positive, negative) prompts past the 77-token cap and
    return embeds ready for pipe(**embeds, ...).

    Returns a dict with 4 keys, all torch.Tensor on the pipe device:
      prompt_embeds, pooled_prompt_embeds,
      negative_prompt_embeds, negative_pooled_prompt_embeds
    """
    import torch

    device = (
        pipe._execution_device
        if hasattr(pipe, "_execution_device")
        else next(pipe.text_encoder.parameters()).device
    )
    dtype = pipe.text_encoder.dtype

    with torch.no_grad():
        h1_pos, _ = _encode_one_encoder(
            pipe.text_encoder, pipe.tokenizer, positive, device, dtype,
        )
        h1_neg, _ = _encode_one_encoder(
            pipe.text_encoder, pipe.tokenizer, negative or "", device, dtype,
        )
        h2_pos, p2_pos = _encode_one_encoder(
            pipe.text_encoder_2, pipe.tokenizer_2, positive, device, dtype,
        )
        h2_neg, p2_neg = _encode_one_encoder(
            pipe.text_encoder_2, pipe.tokenizer_2, negative or "", device, dtype,
        )

        L = max(h1_pos.shape[1], h1_neg.shape[1], h2_pos.shape[1], h2_neg.shape[1])
        h1_pos = _pad_seq(h1_pos, L)
        h1_neg = _pad_seq(h1_neg, L)
        h2_pos = _pad_seq(h2_pos, L)
        h2_neg = _pad_seq(h2_neg, L)

        prompt_embeds = torch.cat([h1_pos, h2_pos], dim=-1)
        negative_prompt_embeds = torch.cat([h1_neg, h2_neg], dim=-1)

        if p2_pos is None:
            p2_pos = torch.zeros(1, h2_pos.shape[-1], dtype=dtype, device=device)
        if p2_neg is None:
            p2_neg = torch.zeros(1, h2_neg.shape[-1], dtype=dtype, device=device)

    out = {
        "prompt_embeds": prompt_embeds.detach(),
        "pooled_prompt_embeds": p2_pos.detach(),
        "negative_prompt_embeds": negative_prompt_embeds.detach(),
        "negative_pooled_prompt_embeds": p2_neg.detach(),
    }
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return out


def count_clip_tokens(text: str) -> int:
    """Count CLIP-L tokens for a string."""
    cache = getattr(count_clip_tokens, "_tk", None)
    if cache is None:
        from transformers import CLIPTokenizer
        cache = CLIPTokenizer.from_pretrained("openai/clip-vit-large-patch14")
        count_clip_tokens._tk = cache
    return len(cache(text).input_ids)
