"""Auto-rectify: strict orthographic FRONT (or 3/4 ISO) view generation,
multi-seed with silhouette symmetry scoring.

Verbatim port of `scripts/generate_front_strict.py`. Used by the cloud
when the user uploads a reference image that is NOT a clean orthographic
front (most "concept art" downloads are 3/4 angle): we re-generate from
the prompt + optional IPAdapter anchor, then pick the seed with the
highest horizontal-symmetry IoU on the rembg silhouette.

Two modes :
  - 'front' (default) — STRICT_FRONT_TAIL + NEG_FRONT, max symmetry.
    For humanoids / characters / weapons. Cascades cleanly into
    MV-Adapter + ControlNet OpenPose downstream.
  - 'iso' — ISO_TAIL + NEG_ISO, max ASYMMETRY (capped to avoid
    accidental back/side views). For vehicles / non-bipedal creatures
    where TRELLIS-2 single-shot needs depth cues to avoid trapu meshes.

Reuses the MyFabmeshBackview pipeline (RealVisXL + ControlNet OpenPose
+ IPAdapter). The ControlNet is NEUTRALIZED at call time by passing a
black image with cn_scale=0.0 — the conv stack still runs but its
output is zeroed, so the diffusion path is identical to a plain
StableDiffusionXLPipeline. This lets us avoid spinning up a second
@app.cls (would add another 15 GB snapshot for zero functional gain).
"""
from PIL import Image
import numpy as np
import torch


STRICT_FRONT_TAIL = (
    ', strict orthographic front view, perfectly head-on, '
    'symmetric horizontal mirror, zero rotation, no tilt, '
    'no perspective distortion, centered subject, plain white '
    'background, even studio lighting, sharp focus, 8k, masterpiece'
)
ISO_TAIL = (
    ', 3/4 isometric view, three-quarter angle, slight rotation '
    'showing both front and side, slight elevation showing the top, '
    'classic Objaverse render angle, full subject visible with '
    'depth cues, plain white background, even studio lighting, '
    'sharp focus, 8k, masterpiece'
)
NEG_FRONT = (
    'side view, profile view, three quarter view, back view, '
    '3/4 angle, rotated, perspective view, tilted, asymmetric, '
    'cropped, blurry, deformed, multiple subjects, watermark, '
    'low quality, frame, border, signature'
)
NEG_ISO = (
    'strict front view, flat front view, head-on, profile view, '
    'back view, top-down view, perspective distortion, fish-eye, '
    'cropped, blurry, deformed, multiple subjects, watermark, '
    'low quality, frame, border, signature'
)


def symmetry_score(img: Image.Image) -> float:
    """Return [0,1] horizontal-symmetry IoU of the rembg silhouette.
    Verbatim port of generate_front_strict.py:symmetry_score."""
    from rembg import remove
    rgba = remove(img.convert('RGBA'))
    arr = np.array(rgba)
    alpha = arr[..., 3].astype(np.float32) / 255.0
    if alpha.sum() < 100:
        return 0.0
    ys, xs = np.where(alpha > 0.05)
    y0, y1 = ys.min(), ys.max()
    x0, x1 = xs.min(), xs.max()
    crop = arr[y0:y1 + 1, x0:x1 + 1]
    crop_alpha = crop[..., 3].astype(np.float32) / 255.0
    flipped = crop_alpha[:, ::-1]
    a_bin = (crop_alpha > 0.5)
    f_bin = (flipped > 0.5)
    inter = np.logical_and(a_bin, f_bin).sum()
    union = np.logical_or(a_bin, f_bin).sum()
    return float(inter / union) if union > 0 else 0.0


def generate(
    pipe,                            # StableDiffusionXLControlNetPipeline (on CUDA)
    prompt: str,
    ref_img: Image.Image = None,     # optional — IPAdapter identity anchor
    mode: str = 'front',
    seeds: int = 3,
    steps: int = 30,
    guidance: float = 7.0,
    size: int = 1024,
    ip_scale: float = 0.7,
) -> Image.Image:
    """Multi-seed RealVisXL rectify with symmetry scoring. Returns the
    best candidate, post-processed (rembg + center @ ~92% canvas height).

    The pipe is the MyFabmeshBackview's ControlNet pipeline; we feed it
    a black image with controlnet_conditioning_scale=0.0 to neutralize
    the ControlNet branch (output is zeroed, no semantic effect)."""
    from modal_app._tpose import remove_bg_and_center

    if mode == 'iso':
        full_prompt = prompt.strip().rstrip('.,') + ISO_TAIL
        neg = NEG_ISO
    else:
        full_prompt = prompt.strip().rstrip('.,') + STRICT_FRONT_TAIL
        neg = NEG_FRONT

    # Neutralized ControlNet input — all-black 1024² (ControlNet still
    # runs its forward but cn_scale=0 zeroes the residuals into UNet).
    blank_skel = Image.new('RGB', (size, size), (0, 0, 0))

    # IPAdapter scale: 0.7 (preserve identity) when ref_img provided,
    # 0.0 (disable) otherwise. Required because the pipeline carries
    # IPAdapter weights from previous back_view/tpose calls otherwise.
    try:
        pipe.set_ip_adapter_scale(ip_scale if ref_img is not None else 0.0)
    except Exception:
        pass

    candidates = []
    for i in range(seeds):
        seed = 1000 + i * 137  # same reproducible spread as desktop
        gen = torch.Generator('cuda').manual_seed(seed)
        call_kwargs = dict(
            prompt=full_prompt,
            negative_prompt=neg,
            image=blank_skel,
            controlnet_conditioning_scale=0.0,
            num_inference_steps=steps,
            guidance_scale=guidance,
            height=size,
            width=size,
            generator=gen,
        )
        if ref_img is not None:
            call_kwargs['ip_adapter_image'] = ref_img
        img = pipe(**call_kwargs).images[0]
        sym = symmetry_score(img)
        # Front: maximize symmetry. ISO: maximize asymmetry but cap at
        # sym>=0.85 (would already be ~front), so reward
        # (1-sym) only when sym is meaningfully off-axis.
        if mode == 'iso':
            score = (1.0 - sym) if sym < 0.85 else 0.0
        else:
            score = sym
        candidates.append((score, img, seed))

    candidates.sort(key=lambda t: -t[0])
    best_score, best_img, best_seed = candidates[0]
    print(f'[rectify] mode={mode} best seed={best_seed} score={best_score:.3f} '
          f'(over {seeds} seeds)', flush=True)
    return remove_bg_and_center(best_img, size=size)
