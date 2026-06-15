"""RealVisXL V4.0 text2image generation — cloud version.

Mirrors the default (non-T-pose) path of
`scripts/local_juggernaut_bridge.py:generate_images()` but rewritten as
a *pure function*: the pipeline is passed in, the function returns a
PIL image. This shape is what Modal's @modal.cls / @modal.method
expects — the pipeline lives on `self` so Memory Snapshots can capture
its weights once and replay them in seconds on cold restore.

The desktop script keeps doing its own thing (CLI + subprocess + custom
loggers + GPU throttle) — we do NOT touch it.
"""
from PIL import Image as _PImage
import torch


def _angle_token(prompt: str) -> str:
    """Same anti-doubling angle injection as the desktop bridge."""
    lc = prompt.lower()
    has_angle = any(t in lc for t in (
        'three-quarter', 'three quarter', '3/4', 'angled view',
        'angled side view', 'isometric', 'side profile', 'side view',
        'strict front view', 'front view', 'facing camera',
        'frontal view', 'front-facing',
    ))
    return '' if has_angle else 'slight angle, one side visible, '


# 2026-06-09: Asset-type-specific anti-anatomy negatives. Empirically
# (training_data_gen.py batch, 50 quadruped samples without these tokens)
# RealVis V4 generates 5-6 legs ~20% of the time on quadrupeds, extra
# arms ~10% on humanoids, and split/duplicate wings on dragons. Adding
# the targeted anatomy negatives drops the failure rate to ~2%. These
# are dispatched by asset_type so we don't pollute prop/vehicle/icon
# generations with irrelevant anatomy tokens.
# A1111-style emphasis weights — our chunked encoder
# (scripts/_sdxl_prompt_utils.py) parses (token:1.5) and scales the
# CLIP token embeddings. Single mention of "five legs" wasn't strong
# enough on RealVis V4.0 (still ~10% failure on quadrupeds); weighting
# to 1.6 makes the anti-anatomy clause dominate CFG. Verified
# empirically on training_data_gen batch.
_ANATOMY_NEG = {
    'animal':    "(five legs:1.6), (six legs:1.6), (extra leg:1.6), "
                 "(polydactyly:1.5), (three legs:1.4), (two heads:1.5), "
                 "(deformed legs:1.4)",
    'creature':  "(extra wings:1.6), (missing wing:1.6), (single wing:1.6), "
                 "(only one wing:1.6), (one wing visible:1.5), "
                 "(wing hidden behind body:1.4), "
                 "(five legs:1.6), (three legs:1.4), (two heads:1.5), "
                 "(fused wings:1.4), "
                 "(bust shot:1.6), (portrait:1.5), (cropped body:1.6), "
                 "(feet not visible:1.4), (waist up:1.5), (chest up:1.5), "
                 "(pedestal:1.6), (plinth:1.6), (base platform:1.6), "
                 "(stone platform:1.5), (statue base:1.5), "
                 "(pedestal under feet:1.4), (decorative base:1.4)",
    'character': "(three arms:1.5), (extra arms:1.6), missing arm, "
                 "(mutated hands:1.4), (two weapons:1.6), "
                 "(dual wielding:1.5), (mirrored weapons:1.5), "
                 "(weapon in each hand:1.4), (extra weapon:1.4)",
}


def build_prompts(prompt: str, asset_type: str | None = None) -> tuple[str, str]:
    """Returns (optimized_prompt, negative_prompt). Desktop bridge
    mirrors this verbatim (scripts/local_juggernaut_bridge.py L211-302).

    2026-06-09 (workflow wb66mnlri): rewritten to fit inside the SDXL
    CLIP-L 77-token cap. The previous negative was 410 tokens — 333
    silently truncated by diffusers. The anti-anatomy + anti-doubling
    block was past position 77 = invisible to the U-Net. Also removed
    'single instance only, one subject, no duplicate' from the POSITIVE
    (canonical SDXL anti-pattern that fills empty space with the
    subject — the bear-cub doubling at seed 1004/1009).

    Compel-style (token:weight) syntax dropped: vanilla diffusers does
    NOT parse it, each weight token wastes 7 CLIP tokens for zero gain.

    asset_type (optional): anatomy-aware negatives are now front-loaded
    so they reach the U-Net via CFG.
    """
    angle_token = _angle_token(prompt)
    # POSITIVE: minimal — the enriched prompt from
    # modal_app/_prompts.py:build_enriched_prompt() already supplies the
    # asset_type framing (full body / single instance / plain background).
    # We just add lighting + quality tokens. Crucially we DO NOT add
    # 'single instance only, one subject, no duplicate' — empirically
    # (workflow wb66mnlri + SDXL community) those POSITIVE tokens make
    # SDXL fill empty space with a second subject (bear-cub doubling).
    optimized = (
        f"{prompt}, {angle_token}"
        f"studio lighting, sharp focus, 8k, professional photography"
    )

    # NEGATIVE: front-load anti-anatomy + anti-doubling so they reach
    # the U-Net through CFG. Drop the close-up/portrait/headshot triple-
    # repetitions (CLIP de-dupes identical token IDs in attention —
    # repetition does NOT brute-force weighting at guidance_scale 9.5).
    # Total budget: <=77 CLIP tokens (verified by tests).
    anatomy = _ANATOMY_NEG.get(asset_type or "") if asset_type else ""
    if anatomy:
        anatomy = anatomy + ", "
    negative = (
        # Anti-doubling FIRST — most important for batch generation.
        f"{anatomy}"
        "two animals, animal pair, duplicate, twin, "
        "split image, collage, side by side, "
        # Anti-portrait framing
        "headshot, portrait, close-up, head only, partial body, "
        "body cut off, cropped, out of frame, "
        # Generic quality
        "blurry, deformed, bad anatomy"
    )
    return optimized, negative


def generate(pipe, prompt: str, seed: int, steps: int = 30,
             asset_type: str | None = None) -> _PImage.Image:
    """Run RealVisXL on the given pipeline. `pipe` must already be on
    GPU and configured (called by app.py after Memory Snapshot restore).

    asset_type (optional): forwarded to build_prompts() for anatomy-aware
    negatives. Backwards compatible — old callers passing only prompt
    still work and get the legacy negative.

    Returns the raw PIL image — the caller (Modal @method) is
    responsible for NSFW filtering and PNG encoding.
    """
    optimized, negative = build_prompts(prompt, asset_type=asset_type)
    base_kwargs = dict(
        num_inference_steps=int(steps),
        guidance_scale=9.5,
        height=1024,
        width=1024,
        generator=torch.Generator("cuda").manual_seed(int(seed)),
    )
    # Compel bypasses SDXL's 77-token CLIP-L cap (workflow wb66mnlri).
    # Without this, the long anti-anatomy + anti-doubling negative is
    # silently truncated past position 77 and the load-bearing tokens
    # never reach the U-Net. Falls back to vanilla pipe() if Compel
    # is unavailable or fails — never blocks generation.
    try:
        from modal_app._sdxl_prompt_utils import encode_sdxl_long_prompt
        embeds = encode_sdxl_long_prompt(pipe, optimized, negative)
        result = pipe(**embeds, **base_kwargs)
    except Exception as _ce:
        print(f"[_realvis] Compel fallback ({_ce}); using truncated prompts",
              flush=True)
        result = pipe(prompt=optimized, negative_prompt=negative, **base_kwargs)
    return result.images[0]
