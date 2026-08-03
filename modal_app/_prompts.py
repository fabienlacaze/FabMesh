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
    # PORTEE DU DESKTOP le 2026-08-03 (src/renderer/index2.js).
    # Avant : 10 entrees, donc 7 des 17 types proposes dans l'interface
    # retombaient sur une chaine VIDE — avion, bateau, insect et les
    # quatre « other_* ». Ils perdaient aussi leurs garde-fous
    # anatomiques : celui d'insect impose « exactement six pattes, PAS
    # une araignee », celui d'animal « NEVER bipedal ». Sans eux le
    # modele produisait n'importe quoi, et l'utilisateur payait.
    'character'     : 'isolated 3D character, full body, fully clothed, wearing a complete outfit, dressed in appropriate clothing, T-pose neutral stance, arms extended horizontally, legs apart, strict front view, facing camera, symmetric, RTS unit game asset, plain white background, even studio lighting, no shadows, centered, clean silhouette, no text, no UI',
    'building'      : 'architectural building exterior, complete edifice, entire building visible from base to roof, wide establishing shot, long shot, distant camera, the whole structure fits inside the frame with clear margin on every side, building fills about 70 percent of frame, nothing cropped, not touching the frame edges, isolated, full structure, plain white background, even studio lighting, no shadows, centered, strict front view, facing camera, clean silhouette, no text, no UI, not a village, not a town',
    'vehicle'       : 'isolated, complete vehicle, plain white background, even studio lighting, no shadows, no characters, centered, strict front view, facing camera, clean silhouette, no text, no UI, no rear view inset',
    'weapon'        : 'isolated, full weapon, plain white background, even studio lighting, no shadows, centered, side profile, clean silhouette, no text, no UI',
    'prop'          : 'isolated, full item, plain white background, even studio lighting, no shadows, no characters, centered, strict front view, clean silhouette, no text, no UI',
    'creature'      : '3D game asset reference sheet, full body character sheet, long shot, full figure shot, wide establishing shot, distant camera, entire creature visible from head to feet to tail, body fills 60 percent of frame, isolated, neutral stance, front view, facing camera, symmetric, plain white background, even studio lighting, no shadows, centered, clean silhouette, no text, no UI, NOT a portrait, NOT a headshot, NOT a close-up, NOT a head shot, NOT a face shot, NOT a bust shot',
    'environment'   : 'isolated, full structure, plain white background, even studio lighting, no shadows, no characters, centered, strict front view, clean silhouette, no text, no UI',
    'icon'          : 'flat icon, app icon, UI icon, isolated subject centered in square frame, transparent or pure white background, soft rim light, vibrant colors, clean silhouette, slight isometric 3/4 angle, glossy material, mobile / desktop application icon style, no text, no logo, no extra elements',
    'avion'         : 'complete passenger aircraft, isolated, 3/4 isometric view, full body visible from nose to tail, both wings visible, tail fin visible, plain white background, even studio lighting, no shadows, no clouds, no horizon, no contrail, centered, clean silhouette, no text, no UI',
    'bateau'        : 'complete boat, isolated, 3/4 isometric view, full body visible from bow to stern, hull and superstructure visible, plain white background, even studio lighting, no shadows, no water, no wake, no horizon, centered, clean silhouette, no text, no UI',
    'animal'        : '3D game asset reference sheet, full body character reference, long shot, full figure shot, wide establishing shot, distant camera, entire animal visible from nose to tail to feet, body fills 60 percent of frame, full body lateral profile, all four feet flat on the ground, body horizontal parallel to floor, belly close to ground, four legs supporting the body from below, plain white background, even studio lighting, no shadows, NEVER bipedal, NEVER upright, NEVER standing on hind legs, NEVER humanoid posture, NEVER T-pose, NEVER cartoon mascot stance, no text, no UI, NOT a portrait, NOT a headshot, NOT a close-up, NOT a head shot, NOT a face shot, NOT a bust shot, NOT head and shoulders',
    'insect'        : '3D game asset reference sheet, full body reference, long shot, full figure shot, distant camera, entire insect visible, body fills 60 percent of frame, isolated, exactly six legs in total, three legs on the left side and three legs on the right side, six legs and no more, anatomically correct insect leg count, segmented body with distinct head thorax and abdomen, hard exoskeleton, antennae, 3/4 isometric view, high three-quarter angle seen from above and to the side, all six legs clearly visible and separated, plain white background, even studio lighting, no shadows, NOT eight legs, NOT a spider, NOT an arachnid, no extra legs, no doubled legs, no duplicated legs, no overlapping duplicate limbs, no mirrored extra legs, NO tail, no fur, NOT a mammal, NOT a quadruped, no humanoid posture, NOT a front head-on view, NOT a portrait, NOT a close-up, NOT a headshot, no text, no UI',
    'other_living'  : 'full body, isolated, plain white background, even studio lighting, no shadows, centered, strict front view, facing camera, clean silhouette, no text, no UI',
    'other_vehicle' : 'complete vehicle, isolated, plain white background, even studio lighting, no shadows, no characters, centered, strict front view, facing camera, clean silhouette, no text, no UI',
    'other_built'   : 'full structure, isolated, plain white background, even studio lighting, no shadows, no characters, centered, strict front view, clean silhouette, no text, no UI',
    'other_item'    : 'ONE item only, single item, only one instance, isolated, full item, plain white background, even studio lighting, no shadows, no characters, centered, strict front view, clean silhouette, no text, no UI, no duplicate, no second item',
    'custom'        : '',
}

ASSET_STYLE_PROMPTS = {
    # PORTEE DU DESKTOP le 2026-08-03 (src/renderer/index2.js).
    # Avant : 8 entrees seulement, donc 28 des 33 styles proposes
    # dans l'interface ne produisaient RIEN. L'utilisateur payait
    # 2 credits pour une image sans le style choisi.
    'realistic'         : 'realistic style, photorealistic, sharp details, detailed materials',
    'stylized'          : 'stylized art, mid-poly game asset, hand-painted textures, fantasy game style',
    'lowpoly'           : 'low-poly 3D art, flat-shaded, faceted geometry, minimalist, geometric shapes, vibrant colors',
    'cartoon'           : 'cartoon style, bold outlines, cel-shading, vibrant flat colors, expressive shapes',
    'anime'             : 'anime style, soft cel-shading, expressive features, japanese animation aesthetic',
    'pixelart'          : 'pixel art style, 16-bit retro game aesthetic, limited palette, sharp pixel edges',
    'painterly'         : 'painterly style, brushstroke textures, hand-painted concept art look',
    'pbr'               : 'PBR materials, ultra detailed, 8k textures, high-poly cinematic quality, film-grade lighting',
    'voxel'             : 'voxel art, minecraft-inspired blocky 3D style, cubic geometry, clean voxels',
    'stylized-pbr'      : 'stylized PBR, Overwatch and Fortnite style, hand-painted shading on PBR maps, clean game asset',
    'hand-painted'      : 'hand-painted texture, WoW-style stylized, painterly diffuse, no realistic PBR maps, vibrant',
    'ghibli'            : 'Studio Ghibli style, soft anime, gentle warm palette, hand-drawn animation, expressive nature',
    'pixar'             : 'Pixar 3D animated movie, clean stylized 3D, family-friendly polish, expressive characters',
    'comic'             : 'comic book style, ink outlines, halftone shading, bold saturated colors, dynamic poses',
    'dark-fantasy'      : 'dark fantasy, gothic grimdark, dramatic chiaroscuro lighting, weathered ornate detail, brooding',
    'cyberpunk'         : 'cyberpunk sci-fi, neon accents, futuristic mechanical detail, gritty urban',
    'steampunk'         : 'steampunk, brass copper rivets, victorian mechanical, leather and gears, ornate clockwork',
    'minecraft'         : 'Minecraft blocky low-fi, cubic geometry, pixelated 16x16 texture, voxel inspired',
    'watercolor'        : 'watercolor painting, soft pigment washes, paper texture, gentle bleeding edges',
    'concept'           : 'concept art, rough painterly, dramatic lighting, production design, key art quality',
    'sketch'            : 'pencil sketch, line art, graphite shading, minimal color, hand-drawn',
    'claymation'        : 'claymation, plasticine model, soft stop-motion surface, Aardman style, handmade charm',
    'synthwave'         : 'synthwave vaporwave, retro 80s neon, purple and cyan gradients, chrome grid glow',
    'horror'            : 'horror creepy, dark unsettling atmosphere, eerie grim, weathered decay',
    'chrome'            : 'polished chrome metal, mirror reflections, liquid metal surface, glossy',
    'marble'            : 'marble statue, carved stone sculpture, veined polished white marble',
    'carved-wood'       : 'carved wood, natural wood grain, hand-carved artisan woodwork',
    'stained-glass'     : 'stained glass, colored glass panels, dark lead outlines, luminous backlit',
    'holographic'       : 'holographic iridescent, rainbow sheen, pearlescent shimmer, prismatic',
    'figurine'          : 'toy figurine, glossy molded plastic, collectible model, smooth vinyl',
    'graffiti'          : 'graffiti street art, spray paint, vibrant urban colors, bold outlines',
    'art-deco'          : 'art deco, geometric gold ornament, elegant symmetrical 1920s luxury',
    'custom'            : '',
    # Alias de compatibilite : le cloud utilisait ces 3 orthographes,
    # differentes de celles de l'UI, d'ou des styles silencieusement muets.
    # On garde les deux pour qu'un client en cache continue de marcher.
    'low-poly'          : 'low-poly 3D art, flat-shaded, faceted geometry, minimalist, geometric shapes, vibrant colors',
    'pixel-art'         : 'pixel art style, 16-bit retro game aesthetic, limited palette, sharp pixel edges',
    'concept-art'       : 'painterly style, brushstroke textures, hand-painted concept art look',
    'none'              : '',
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
