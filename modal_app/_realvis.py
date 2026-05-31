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


def build_prompts(prompt: str) -> tuple[str, str]:
    """Returns (optimized_prompt, negative_prompt) — copied verbatim
    from the desktop bridge's hard-surface/prop path so cloud output
    matches desktop output 1:1 for the same input."""
    angle_token = _angle_token(prompt)
    optimized = (
        f"{prompt}, {angle_token}"
        f"single instance only, one subject, no duplicate, no composition grid, "
        f"studio lighting, ultra detailed, 8k, sharp focus, professional photography, "
        f"masterpiece, no text, no watermark"
    )
    negative = (
        "blurry, low quality, text, watermark, signature, deformed, "
        "extra limbs, bad anatomy, distorted, cropped, worst quality, "
        "flat profile, "
        # Anti-portrait composition tokens — SDXL's default for animals/
        # creatures/characters tends toward head shots. Without this,
        # prompting "dragon" produces a dragon-head portrait instead of
        # the full-body asset we need for 3D reconstruction.
        "(close-up:1.5), (portrait:1.5), (headshot:1.5), "
        "(head only:1.5), (head close-up:1.5), (face only:1.4), "
        "(bust shot:1.4), (head and shoulders:1.4), "
        "(face close-up:1.4), (head crop:1.4), (cropped to head:1.4), "
        "(zoomed in on face:1.4), (extreme close-up:1.5), "
        "(two:1.6), (pair:1.5), (duplicate:1.5), (twin:1.5), "
        "(set of two:1.5), (multiple instances:1.5), "
        "(two objects:1.5), (two subjects:1.5), (two items:1.5), "
        "(two cars:1.5), (two vehicles:1.5), (two knives:1.5), "
        "(two characters:1.5), (two props:1.5), (two weapons:1.5), "
        "(second instance:1.5), (second copy:1.4), (companion item:1.4), "
        "(side by side:1.5), (paired:1.4), (matched set:1.4), "
        "(rear view inset:1.4), (front and back:1.4), "
        "split image, stacked vertically, stacked horizontally, "
        "collage, grid layout, comparison view, "
        "product comparison, kitchenware set, catalog grid"
    )
    return optimized, negative


def generate(pipe, prompt: str, seed: int, steps: int = 30) -> _PImage.Image:
    """Run RealVisXL on the given pipeline. `pipe` must already be on
    GPU and configured (called by app.py after Memory Snapshot restore).

    Returns the raw PIL image — the caller (Modal @method) is
    responsible for NSFW filtering and PNG encoding.
    """
    optimized, negative = build_prompts(prompt)
    result = pipe(
        prompt=optimized,
        negative_prompt=negative,
        num_inference_steps=int(steps),
        guidance_scale=7.0,
        height=1024,
        width=1024,
        generator=torch.Generator("cuda").manual_seed(int(seed)),
    )
    return result.images[0]
