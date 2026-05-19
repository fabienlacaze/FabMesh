"""Patch external/MV-Adapter for accelerate cpu_offload compatibility.

**Root cause** : MV-Adapter passes `ref_hidden_states` (a dict populated
during a reference forward pass) to processors via `cross_attention_kwargs`.
When the pipeline runs under `accelerate.enable_model_cpu_offload()`,
accelerate wraps `unet.forward` with a hook that *clones* every kwarg
at the boundary (`diffusers.models.attention_processor.Attention.forward`
also filters/copies via `inspect.signature`). The processor therefore
reads a *different* dict object than the one the pipeline wrote into,
which is always empty → `KeyError: 'down_blocks.1.attentions.0...attn1.processor'`.

The previous workaround (`ref_hidden_states.get(self.name) + skip`) made
MV-Adapter produce pure noise: every block fell through to the no-ref
branch and the ref image conditioning vanished.

**This patch** stashes each processor's reference tensor as an instance
attribute `self._mva_ref_state` during the ref pass. The attribute lives
on the processor object itself, which survives accelerate's hook boundary
(only the kwargs are copied, not the module attributes). The MV pass
reads from `self._mva_ref_state` in priority, and the pipeline applies
the same `repeat_interleave` + CFG concat to those attributes that it
applied to the kwarg dict.

Idempotent — runs on every invocation but only writes once. Imported by
`generate_back_view_mvadapter.py` and `multiview_mvadapter_gen.py`.

License: this patch is FabMesh-internal. The patched files
(`attention_processor.py`, `pipeline_mvadapter_i2mv_sdxl.py`) remain
under MV-Adapter's Apache 2.0 license.
"""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MVA_ROOT = os.path.join(ROOT, 'external', 'MV-Adapter')

ATTN_PROC_PATH = os.path.join(MVA_ROOT, 'mvadapter', 'models',
                              'attention_processor.py')
PIPELINE_SDXL_PATH = os.path.join(MVA_ROOT, 'mvadapter', 'pipelines',
                                  'pipeline_mvadapter_i2mv_sdxl.py')


# --- attention_processor.py patches ---

WRITE_ORIGINAL = '''        # NEW: cache hidden states for reference unet
        if cache_hidden_states is not None:
            cache_hidden_states[self.name] = hidden_states.clone()'''

WRITE_PATCHED = '''        # NEW: cache hidden states for reference unet.
        # FabMesh fix: accelerate's cpu_offload copies cross_attention_kwargs
        # at the UNet boundary, so writing into `cache_hidden_states` (a kwarg
        # dict) hits a clone that the pipeline never sees. We additionally
        # stash the tensor as a per-processor attribute, which survives
        # accelerate's hook boundary.
        if cache_hidden_states is not None:
            cache_hidden_states[self.name] = hidden_states.clone()
            self._mva_ref_state = hidden_states.clone()'''

READ_ORIGINAL = '''        if use_ref:
            reference_hidden_states = ref_hidden_states[self.name]'''

READ_PATCHED = '''        if use_ref:
            # FabMesh fix: accelerate cpu_offload copies cross_attention_kwargs
            # at the UNet boundary, so the ref_hidden_states dict passed via
            # kwargs is a *different* dict from the one populated during the
            # reference pass. The processor stashes its own tensor as a
            # per-instance attribute during the ref pass (see the cache write
            # earlier in this method), which survives the hook boundary.
            reference_hidden_states = getattr(self, '_mva_ref_state', None)
            if reference_hidden_states is None:
                reference_hidden_states = ref_hidden_states[self.name]'''


# --- pipeline_mvadapter_i2mv_sdxl.py patch ---
# Apply the same repeat_interleave + CFG concat the kwarg dict gets to
# the per-processor _mva_ref_state attributes — otherwise the MV pass
# reads a batch=1 tensor and the model produces glitch art (organic
# blobs instead of multi-view).

PIPELINE_ANCHOR = '''        cross_attention_kwargs = {
            "mv_scale": mv_scale,
            "ref_hidden_states": {k: v.clone() for k, v in ref_hidden_states.items()},
            "ref_scale": reference_conditioning_scale,
            "num_views": num_images_per_prompt,
            **(self.cross_attention_kwargs or {}),
        }'''

PIPELINE_PATCHED = '''        cross_attention_kwargs = {
            "mv_scale": mv_scale,
            "ref_hidden_states": {k: v.clone() for k, v in ref_hidden_states.items()},
            "ref_scale": reference_conditioning_scale,
            "num_views": num_images_per_prompt,
            **(self.cross_attention_kwargs or {}),
        }
        # FabMesh fix: the per-processor `_mva_ref_state` stashed during the
        # ref pass holds the *raw* (batch=1) tensor. The MV pass expects
        # batch=num_views (×2 if CFG), so we must apply the same
        # `repeat_interleave` + CFG concat that the kwarg path does above —
        # otherwise the processor reads a tensor with a mismatched batch
        # dim and produces glitch art.
        for _proc in self.unet.attn_processors.values():
            _raw = getattr(_proc, '_mva_ref_state', None)
            if _raw is not None:
                _v = _raw.repeat_interleave(num_images_per_prompt, dim=0)
                if self.do_classifier_free_guidance:
                    _v = torch.cat([torch.zeros_like(_v), _v], dim=0)
                _proc._mva_ref_state = _v'''


def _apply_patch(file_path, original, patched, label):
    """Idempotent string-based patch. Returns True if file already patched
    or just patched; False if neither original nor patched is found."""
    if not os.path.isfile(file_path):
        print(f'[patch_mvadapter] WARN: {label}: file not found ({file_path})',
              flush=True)
        return False
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    if patched in content:
        return True  # already patched
    if original not in content:
        print(f'[patch_mvadapter] WARN: {label}: original snippet not found '
              f'(MV-Adapter version mismatch?)', flush=True)
        return False
    content = content.replace(original, patched)
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f'[patch_mvadapter] applied: {label}', flush=True)
    return True


def patch():
    """Apply all FabMesh patches to MV-Adapter. Returns True if all
    patches were applied or already present."""
    ok = True
    # attention_processor.py: write site appears twice (two classes,
    # DecoupledMVRowSelfAttnProcessor2_0 and DecoupledMVRowColSelfAttnProcessor2_0)
    # — we need to patch both. The simplest way is to do a global string
    # replace, then re-read to count occurrences.
    if os.path.isfile(ATTN_PROC_PATH):
        with open(ATTN_PROC_PATH, 'r', encoding='utf-8') as f:
            content = f.read()
        changed = False
        if WRITE_PATCHED not in content and WRITE_ORIGINAL in content:
            content = content.replace(WRITE_ORIGINAL, WRITE_PATCHED)
            changed = True
        if READ_PATCHED not in content and READ_ORIGINAL in content:
            content = content.replace(READ_ORIGINAL, READ_PATCHED)
            changed = True
        if changed:
            with open(ATTN_PROC_PATH, 'w', encoding='utf-8') as f:
                f.write(content)
            print('[patch_mvadapter] applied: attention_processor.py '
                  '(write + read sites)', flush=True)
        elif WRITE_PATCHED not in content or READ_PATCHED not in content:
            print('[patch_mvadapter] WARN: attention_processor.py: '
                  'expected snippets not found', flush=True)
            ok = False
    else:
        print(f'[patch_mvadapter] WARN: attention_processor.py not found',
              flush=True)
        ok = False

    ok = ok and _apply_patch(
        PIPELINE_SDXL_PATH, PIPELINE_ANCHOR, PIPELINE_PATCHED,
        'pipeline_mvadapter_i2mv_sdxl.py (per-processor batch transform)')
    return ok


if __name__ == '__main__':
    ok = patch()
    raise SystemExit(0 if ok else 1)
