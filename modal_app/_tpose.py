"""T-pose front view generation — cloud version.

Verbatim port of `scripts/generate_front_tpose.py:run_from_prompt` /
`run_from_image`. The reason for a strict T-pose front is purely
geometric: TRELLIS-2 + MVAdapter cascade much cleaner when the input
silhouette has arms extended horizontally (no shoulder occlusion, no
"bras collés" mismatch with the back generator).

Pipeline (same as desktop):
  prompt + FRONT_PROMPT_TAIL → SDXL ControlNet (xinsir openpose) with
  the pre-rendered front T-pose skeleton at cn_scale=1.15 → rembg →
  center on 1024² white canvas with feet visible (~92% height).

The img2img branch additionally pipes the source image through IP-Adapter
(h94/IP-Adapter, plus_sdxl_vit-h, scale 0.75) to preserve identity/outfit
while forcing the T-pose via ControlNet.

This module is *pure function* — caller (modal_app/app.py) owns the
pipeline object so Memory Snapshot can cover the weights. We reuse the
SAME @app.cls MyFabmeshBackview pipeline (RealVisXL + ControlNet OpenPose
+ IPAdapter), avoiding a second 15 GB snapshot.
"""
from PIL import Image
import numpy as np
import torch


# Verbatim copy of generate_front_tpose.py:115-129 — DO NOT edit without
# updating the desktop script in lockstep (otherwise cloud T-pose drifts
# from desktop T-pose and downstream geometry breaks).
FRONT_PROMPT_TAIL = (
    ', full body, arms extended horizontally sideways in a T-pose, '
    'arms pointing straight out at shoulder level, strict front view, '
    'facing camera directly, symmetric T-pose, standing upright, '
    'legs apart shoulder-width, feet visible on the ground, '
    'plain white background, studio lighting, sharp focus, 8k, '
    'masterpiece, orthographic-like flat view'
)
NEG = (
    'arms down, arms by side, arms at side, hands on hips, '
    'side view, profile view, three quarter view, back view, '
    'perspective distortion, cropped, blurry, deformed, '
    'extra limbs, bad anatomy, multiple people, watermark, '
    'low quality, pose reference sheet, feet out of frame'
)


def remove_bg_and_center(img: Image.Image, size: int = 1024,
                         bg_rgb=(255, 255, 255),
                         target_height_frac: float = 0.92) -> Image.Image:
    """Verbatim port of generate_front_tpose.py:remove_bg_and_center.
    Crops subject via rembg alpha, scales to ~92% canvas height, pastes
    on a white canvas with feet near bottom (~2% bottom margin)."""
    from rembg import remove
    rgba = remove(img.convert('RGBA'))
    arr = np.array(rgba)
    alpha = arr[..., 3] > 10
    if not alpha.any():
        return img.convert('RGB').resize((size, size), Image.LANCZOS)
    ys, xs = np.where(alpha)
    y0, y1 = ys.min(), ys.max()
    x0, x1 = xs.min(), xs.max()
    crop = arr[y0:y1 + 1, x0:x1 + 1]
    h, w = y1 - y0 + 1, x1 - x0 + 1
    target_h = int(size * target_height_frac)
    scale = target_h / h
    new_h = target_h
    new_w = max(1, int(round(w * scale)))
    if new_w > int(size * 0.95):
        new_w = int(size * 0.95)
        scale = new_w / w
        new_h = max(1, int(round(h * scale)))
    crop_img = Image.fromarray(crop).resize((new_w, new_h), Image.LANCZOS)
    canvas = Image.new('RGB', (size, size), bg_rgb)
    x = (size - new_w) // 2
    y = size - new_h - int(size * 0.02)
    y = max(0, y)
    canvas.paste(crop_img, (x, y),
                 crop_img if crop_img.mode == 'RGBA' else None)
    return canvas


def generate(
    pipe,                            # StableDiffusionXLControlNetPipeline (on CUDA)
    skel_img: Image.Image,           # the FRONT T-pose skeleton (RGB, 1024²)
    prompt: str,
    ref_img: Image.Image = None,     # optional — img2img mode via IPAdapter
    seed: int = 42,
    cn_scale: float = 1.15,
    ip_scale: float = 0.75,
    steps: int = 30,
    guidance: float = 7.0,
    size: int = 1024,
) -> Image.Image:
    """Run RealVisXL + ControlNet OpenPose T-pose generation. Returns
    the post-processed PIL image (rembg + center). `pipe` must already
    be on CUDA and have `load_ip_adapter(...)` called (caller responsibility,
    see app.py MyFabmeshBackview.move_to_gpu). When ref_img is provided,
    pipe.set_ip_adapter_scale(ip_scale) is called and the IP-Adapter
    image is passed; otherwise the IPAdapter branch is skipped (set to 0)."""
    full_prompt = prompt.strip().rstrip('.,') + FRONT_PROMPT_TAIL
    base_kwargs = {
        'image': skel_img,
        'controlnet_conditioning_scale': cn_scale,
        'num_inference_steps': int(steps),
        'guidance_scale': guidance,
        'height': size,
        'width': size,
        'generator': torch.Generator('cuda').manual_seed(int(seed)),
    }
    if ref_img is not None:
        pipe.set_ip_adapter_scale(ip_scale)
        base_kwargs['ip_adapter_image'] = ref_img
    else:
        # Neutralize IPAdapter so a previous request's identity doesn't bleed.
        try:
            pipe.set_ip_adapter_scale(0.0)
        except Exception:
            pass

    # Compel long-prompt encoding — bypasses the 77-token CLIP cap. The
    # FRONT_PROMPT_TAIL alone is ~75 tokens, so any user prompt overflows
    # and the T-pose anchors ("arms extended horizontally", "feet visible")
    # get silently dropped by vanilla diffusers (workflow wb66mnlri). Falls
    # back to truncated prompts if Compel is unavailable.
    try:
        from modal_app._sdxl_prompt_utils import encode_sdxl_long_prompt
        embeds = encode_sdxl_long_prompt(pipe, full_prompt, NEG)
        img = pipe(**embeds, **base_kwargs).images[0]
    except Exception as _ce:
        print(f'[_tpose] Compel fallback ({_ce}); using truncated prompts',
              flush=True)
        img = pipe(
            prompt=full_prompt, negative_prompt=NEG, **base_kwargs,
        ).images[0]
    return remove_bg_and_center(img, size=size)
