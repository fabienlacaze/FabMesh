# SkinTokens patches (FabMesh / MyFabmesh.AI)

Clone-on-first-run: `git clone https://github.com/VAST-AI-Research/SkinTokens external/SkinTokens`
(MIT). These files replace the upstream ones so SkinTokens runs on Windows /
RTX 5080 (sm_120) **without flash-attn and without tripping Smart App Control**:

- `flash_attn_interface.py` (NEW) — SDPA-backed shim for the FlashAttention-3
  API the transformer blocks import. Pure torch SDPA, native on sm_120.
- `demo.py` — `import gradio` made lazy (gradio pulls pandas whose .pyd is
  SAC-blocked; the CLI rig path needs neither).
- `src/model/tokenrig.py` + `src/server/spec.py` — Qwen3 backbone
  `attn_implementation` / `_attn_implementation` `flash_attention_2` -> `sdpa`.

Venv: python 3.11, `torch==2.7.0+cu128` + `requirements.txt` + `scipy`, created
at a SHORT path (e.g. `C:\tmp\skv`) to dodge Windows MAX_PATH on pip's
jupyter/labextension files. Weights via `python download.py --model` (grpo_1400
+ skin_vae + Qwen3-0.6B config). Bridge: `scripts/skintokens_bridge.py`.
