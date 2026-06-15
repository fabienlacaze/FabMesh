# external_patches — FabMesh customizations to vendored models

`external/` is **gitignored** (model weights + Python venvs are tens of GB and
re-downloadable). But we hand-edit a handful of source files inside those
vendored models. Those edits are CUSTOM and must survive a fresh install, so a
copy of each modified file lives here, mirroring its path under `external/`.

## How to restore after a fresh `external/<Model>` install

Copy each file back to the same relative path under `external/`. E.g.:

```
external_patches/TRELLIS2_win/src/trellis2/modules/sparse/attention/windowed_attn.py
  → external/TRELLIS2_win/src/trellis2/modules/sparse/attention/windowed_attn.py
```

For the main TRELLIS-2 RAM/attention patches you can instead run the
self-contained re-applier (it re-derives them from anchors):

```
python scripts/apply_trellis2_ram_patches.py
```

## What's here (custom-edited files)

- **TRELLIS2_win/** — Blackwell (sm_120) fixes + RAM patches + sdpa attention:
  - `o_voxel_patch.py`
  - `src/blackwell_fix.py`
  - `src/trellis2/modules/attention/full_attn.py`
  - `src/trellis2/modules/sparse/attention/full_attn.py` (MATH→EFFICIENT)
  - `src/trellis2/modules/sparse/attention/windowed_attn.py` (sdpa branch)
  - `src/trellis2/modules/sparse/config.py`
  - `src/trellis2/pipelines/samplers/flow_euler.py` (return_traj)
  - `src/trellis2/pipelines/trellis2_image_to_3d.py` (RAM opt + token cap)
  - `src/trellis2/pipelines/trellis2_texturing.py`
- **MV-Adapter/** — `attention_processor.py`, `pipeline_mvadapter_i2mv_sdxl.py`
- **StableFast3D/** — `sf3d/models/tokenizers/dinov2.py`
- **UniRig/** — `src/model/unirig_ar.py`

> Keep this in sync whenever you patch a vendored model file: copy the new
> version here and commit. This is the ONLY backup of these edits — the
> originals live under the gitignored `external/`.
