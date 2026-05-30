# TRELLIS-2 upstream patches

Local edits applied to `external/TRELLIS2_win/src/trellis2/` after the
initial clone. `external/TRELLIS2_win/` is .gitignored (its venv weighs
several GB), so these patches live here as a manual mirror — re-apply
them after every fresh `git clone` + upstream re-install.

## models/__init__.py — relative ckpt path resolution

**File:** `external/TRELLIS2_win/src/trellis2/models/__init__.py` around L57.

**Bug:** when `pipeline.json` contains a relative key like
`ckpts/shape_dec_next_dc_f16c32_fp16` (no repo prefix), the original
upstream code split it as `repo_id="ckpts/shape_dec_next_dc_f16c32_fp16"`
+ `model_name=""` and tried to download
`https://huggingface.co/ckpts/shape_dec_next_dc_f16c32_fp16/resolve/main/.json`
→ RepositoryNotFoundError.

**Fix:** if `path` has fewer than 3 `/`-segments, default `repo_id` to
`microsoft/TRELLIS.2-4B` (the parent pipeline repo) and treat the whole
`path` as `model_name`. See `models__init__.py` in this directory for the
patched version.

## scripts/trellis2_native_full_pipeline.py — ATTN_BACKEND default

Already in the repo (not an external patch). Forces `ATTN_BACKEND=sdpa`
+ `SPARSE_ATTN_BACKEND=sdpa` so trellis2 uses torch's built-in
scaled_dot_product_attention instead of the flash-attn / xformers
compiled `.pyd` files (those get blocked by Windows Smart App Control
on unsigned binaries).
