"""NSFW image safety check — cloud version.

Mirrors the dual-model + skin-ratio check used in
`scripts/local_juggernaut_bridge.py` so cloud generations have the
same parental control as desktop. Both classifiers are Apache 2.0 and
small (~350 MB combined), so they live alongside the diffusion
pipelines on the Modal worker. They run on CPU (the diffusion model
already has the GPU pinned).

Public surface: `is_safe(image, threshold=0.5) -> (bool, float)`
where `image` is a PIL.Image and the float is the max NSFW score
across both classifiers (or the skin ratio if either model missed).
"""
from PIL import Image as _PImage
import numpy as _np


def is_safe(image, clf1, clf2, threshold: float = 0.5,
            asset_type: str = "character") -> tuple[bool, float]:
    """Returns (safe, nsfw_score). `safe=False` means content was
    flagged. Caller decides what to render in its place (a blocked
    placeholder, an error, etc).

    `clf1` and `clf2` are pre-loaded transformers `pipeline` objects
    (image-classification) — pre-loading them in @modal.enter(snap=True)
    lets the snapshot capture their weights too.

    asset_type drives the skin-ratio fallback: animals/creatures with
    tan/orange fur (lions, tigers, foxes, dogs) trip the naive
    red-channel check that was tuned for human skin. We skip it for
    non-human asset types and only apply it to character-typed
    generations (the only ones with meaningful skin coverage).
    """
    img224 = image.convert('RGB').resize((224, 224))
    try:
        r1 = clf1(img224)
        r2 = clf2(img224)
        s1 = next((x['score'] for x in r1 if x['label'] == 'nsfw'), 0.0)
        s2 = next((x['score'] for x in r2 if x['label'] == 'nsfw'), 0.0)
        nsfw_score = float(max(s1, s2))
    except Exception:
        nsfw_score = 0.0
    if nsfw_score > threshold:
        return False, nsfw_score
    # Skin-ratio fallback — ONLY for asset_type='character'. Animals,
    # creatures, vehicles, props, buildings, etc. don't have meaningful
    # 'skin', and the naive red-channel rule below false-positives on
    # tan/orange fur (lion, tiger, fox, dog) and red-painted vehicles.
    if asset_type and asset_type.lower() not in ('character', ''):
        return True, nsfw_score
    arr = _np.array(image.convert('RGB').resize((256, 256))).astype(float)
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    skin = (
        (r > 95) & (g > 40) & (b > 20)
        & (r > g) & (r > b)
        & ((r - g) > 15)
        & (arr.max(2) - arr.min(2) > 15)
    )
    skin_ratio = float(skin.sum()) / (256 * 256)
    # Threshold bumped 0.35 → 0.55. Even for characters, 0.35 was tight:
    # a tight crop of a face fills > 35% of frame with skin and would
    # have tripped. 0.55 still catches genuine NSFW (most explicit
    # content has 60-80% skin) without false-positives on tight portraits.
    if skin_ratio > 0.55:
        return False, max(nsfw_score, skin_ratio)
    return True, nsfw_score


def make_blocked_placeholder(size: tuple[int, int]) -> _PImage.Image:
    """Same dark-grey placeholder the desktop script produces when
    parental control blocks an image."""
    from PIL import ImageDraw
    img = _PImage.new('RGB', size, (30, 30, 30))
    draw = ImageDraw.Draw(img)
    draw.text(
        (img.width // 2 - 120, img.height // 2 - 10),
        "Blocked by content filter",
        fill=(200, 50, 50),
    )
    return img
