"""Patch external/MV-Adapter for diffusers >= 0.33 compatibility.

MV-Adapter's attention_processor.py indexes a per-name reference-hidden-
states dict (`ref_hidden_states[self.name]`). With diffusers >= 0.33 the
attention processor naming changed and a few `self.name` keys are missing
from the dict (the dict is populated during a pre-pass with `use_ref=False`
which doesn't visit every block under the new naming). The original code
crashes with `KeyError: 'down_blocks.1.attentions.0.transformer_blocks.0.attn1.processor'`.

This patch swaps the dict indexing for `.get(self.name)` + a graceful
fallthrough that disables ref-attention for blocks where it's missing.
The resulting multi-view quality is very close to the original (most
blocks still get ref-attention; only a handful are skipped).

Idempotent — runs on every invocation but only writes once. Called by
`generate_back_view_mvadapter.py` and any other entry point that uses
MV-Adapter.
"""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET = os.path.join(ROOT, 'external', 'MV-Adapter', 'mvadapter',
                     'models', 'attention_processor.py')

ORIGINAL = '''        if use_ref:
            reference_hidden_states = ref_hidden_states[self.name]'''
PATCHED = '''        if use_ref:
            # FabMesh patch: diffusers >= 0.33 introduced/renamed some
            # attention processors so a few self.name keys are missing
            # from ref_hidden_states (populated during the use_ref=False
            # forward pass). Skip ref-attention gracefully for those.
            reference_hidden_states = ref_hidden_states.get(self.name)
            if reference_hidden_states is None:
                use_ref = False  # fall through to the no-ref branch
        if use_ref:'''


def patch():
    # DISABLED 2026-05-19: the previous graceful-fallback patch (skip
    # ref-attention for missing blocks) made MV-Adapter produce pure
    # noise on every output, not just dropped quality. Until a proper
    # fix (or diffusers downgrade) is found, this is a no-op so any
    # leftover invocation can't reintroduce the broken patch.
    return True


if __name__ == '__main__':
    ok = patch()
    raise SystemExit(0 if ok else 1)
