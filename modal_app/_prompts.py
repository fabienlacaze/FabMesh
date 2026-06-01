"""Cloud-side prompt construction.

Copy of the asset-type + asset-style suffixes from
`src/renderer/index2.js:buildFullPrompt()` and `cog/predict.py`. Kept
verbatim so cloud-generated images match what the desktop / Cog
produce for the same (prompt, type, style) tuple.

This module is intentionally dependency-free (no torch, no diffusers)
so Modal's @modal.enter(snap=True) can import it without paying any
CUDA cost.
"""

ASSET_TYPE_PROMPTS = {
    'character':   'single isolated 3D character, one character only, full body, T-pose neutral stance, arms extended horizontally, legs apart, strict front view, facing camera, symmetric, RTS unit game asset, plain white background, even studio lighting, no shadows, no other characters, centered, clean silhouette, no text, no UI',
    'building':    'ONE building only, single instance, isolated, full structure, plain white background, even studio lighting, no shadows, no characters, centered, isometric angle, clean silhouette, no text, no UI, no duplicate, no second building',
    'vehicle':     'ONE car only, single vehicle, only one instance, isolated, complete vehicle, plain white background, even studio lighting, no shadows, no characters, centered, strict front view, facing camera, clean silhouette, no text, no UI, no duplicate, no second car, no twin, no rear view inset',
    'weapon':      'ONE weapon only, single instance, isolated, full weapon, plain white background, even studio lighting, no shadows, centered, side profile, clean silhouette, no text, no UI, no duplicate',
    'prop':        'ONE prop only, single instance, isolated, full item, plain white background, even studio lighting, no shadows, no characters, centered, strict front view, clean silhouette, no text, no UI, no duplicate',
    'creature':    'ONE creature only, single instance, isolated, full body, neutral stance, front view, facing camera, symmetric, plain white background, even studio lighting, no shadows, no other creatures, centered, clean silhouette, no text, no UI, no duplicate',
    # 'animal' was missing from this map, so the suffix was '' and SDXL
    # defaulted to a head/portrait crop (user reported 'I get only the
    # lion head'). Heavy anti-crop reinforcement via repetition is the
    # only thing that works with plain diffusers (Compel weights are
    # ignored). Reference: memory feedback_full_body_prompt_tuning.md.
    'animal':      'ONE animal only, single instance, isolated, FULL BODY shown, complete animal from head to tail, all four legs visible, standing on all fours, full creature visible in frame, wide shot, animal photography full body, wildlife full-body photograph, plain white background, even studio lighting, no shadows, no humans, centered, side profile, clean silhouette, no text, no UI, no duplicate, NO close-up, NO portrait, NO headshot, NOT cropped, NOT zoomed on face, body and limbs clearly visible',
    'environment': 'ONE environment piece only, single instance, isolated, full structure, plain white background, even studio lighting, no shadows, no characters, centered, strict front view, clean silhouette, no text, no UI, no duplicate',
    'icon':        'single flat icon, app icon, UI icon, ONE element only, isolated subject centered in square frame, transparent or pure white background, soft rim light, vibrant colors, clean silhouette, slight isometric 3/4 angle, glossy material, mobile / desktop application icon style, no text, no logo, no duplicate, no extra elements',
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
