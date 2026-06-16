"""Cloud-side prompt construction.

Copy of the asset-type + asset-style suffixes from
`src/renderer/index2.js:buildFullPrompt()` and `cog/predict.py`. Kept
verbatim so cloud-generated images match what the desktop / Cog
produce for the same (prompt, type, style) tuple.

This module is intentionally dependency-free (no torch, no diffusers)
so Modal's @modal.enter(snap=True) can import it without paying any
CUDA cost.
"""

# 2026-06-09 (workflow wb66mnlri): trimmed to fit SDXL CLIP-L 77-token
# cap. Removed "ONE X only / single instance / isolated / no duplicate"
# anti-patterns — empirically these POSITIVE tokens make SDXL fill
# empty space with a second subject (canonical doubling bug, seed
# 1004/1009 bear+cub). Anti-headshot/anti-portrait moved to NEGATIVE
# in modal_app/_realvis.py:build_prompts() where they belong. What
# remains here: pure semantic guidance (pose, framing, background).
ASSET_TYPE_PROMPTS = {
    'character':   'full body, T-pose neutral stance, arms extended horizontally, legs apart, strict front view, facing camera, symmetric, plain white background, even studio lighting',
    'building':    'full structure, plain white background, even studio lighting, centered, strict front view, facing camera, single detached building',
    'vehicle':     'complete vehicle, plain white background, even studio lighting, centered, strict front view, facing camera',
    'weapon':      'full weapon, plain white background, even studio lighting, centered, side profile',
    'prop':        'full item, plain white background, even studio lighting, centered, strict front view',
    'creature':    'full body from head to feet, complete figure visible, feet on ground, both wings fully spread to the sides like heraldic emblem, two wings clearly visible, symmetric wingspan, wings extended horizontally on both sides of body, front-facing pose, facing camera, plain white background, even studio lighting, centered',
    'animal':      'full body, four legs visible, standing on all fours, side profile, plain white background, even studio lighting, centered',
    'environment': 'full structure, plain white background, even studio lighting, centered, strict front view',
    'icon':        'app icon, isolated subject, centered, transparent background, slight isometric angle, glossy material',
    'custom':      '',
}

ASSET_STYLE_PROMPTS = {
    'realistic':   'realistic style, photorealistic, sharp details, detailed materials',
    'stylized':    'stylized art, mid-poly game asset, hand-painted textures, fantasy game style',
    'low-poly':    'low-poly 3D art, flat-shaded, faceted geometry, minimalist, geometric shapes, vibrant colors',
    'cartoon':     'cartoon style, bold outlines, cel-shading, vibrant flat colors, expressive shapes',
    'anime':       'anime style, soft cel-shading, expressive features, japanese animation aesthetic',
    'pixel-art':   'pixel art style, 16-bit retro game aesthetic, limited palette, sharp pixel edges',
    'concept-art': 'painterly style, brushstroke textures, hand-painted concept art look',
    'none':        '',
}


def build_enriched_prompt(user_prompt: str, asset_type: str, asset_style: str) -> str:
    style_prefix = ASSET_STYLE_PROMPTS.get(asset_style, '')
    type_suffix = ASSET_TYPE_PROMPTS.get(asset_type, '')
    parts = [p for p in (style_prefix, user_prompt, type_suffix) if p]
    return ', '.join(parts)


def is_tpose_prompt(prompt: str) -> bool:
    p = prompt.lower()
    return any(kw in p for kw in (
        't-pose', 't pose', 'tpose',
        'arms extended horizontally',
        'rts unit',
        'neutral stance',
    ))
