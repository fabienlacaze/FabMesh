"""MV-Adapter multi-view generation - cloud version.

Pure functions only - no @app.cls / @modal.method here. The Modal
class lives in app.py and passes the pre-loaded MV-Adapter pipeline
(MVAdapterI2MVSDXLPipeline) in. The desktop script's CLI / manifest /
file I/O / progress markers / Real-ESRGAN post-pass are dropped -
the cloud caller just wants the 6 PNGs back in a JSON dict.

Mirrors `scripts/multiview_mvadapter_gen.py` exactly for:
  - VIEW_SLOTS (azimuth, elevation) -- same 6 canonical views
  - Plucker embedding + orthographic camera setup
  - ShiftSNRScheduler shift_mode='interpolated', shift_scale=8.0
  - Reference image preprocessing (rembg + square pad + grey composite)
  - Grey-bg -> alpha post-processing per view
  - Adapter init order (init_custom_adapter -> load_custom_adapter)

Models snapshotted in @modal.enter(snap=True) (loaded ONCE per snapshot):
  - SDXL base 1.0 (UNet + 2 text encoders) ~7 GB fp16
    NOTE: vanilla SDXL-base, NOT RealVisXL - the adapter is trained
    against vanilla SDXL and crashes on RealVisXL's renamed attn1.processor.
  - SDXL VAE (fp16-fix)                    ~0.3 GB
  - MV-Adapter weights (i2mv-sdxl)         ~0.7 GB
  - rembg session model (u2net)            ~0.2 GB CPU
  Total                                    ~8 GB CPU memory

VRAM budget on L40S (48 GB): comfortable without cpu_offload. We disable
the desktop's cpu_offload because L40S has 48 GB - offload would slow
inference 3-4x for nothing. The FabMesh patch_mvadapter still applies
(it's a correctness fix for cpu_offload, but it is also a no-op when
offload is disabled - safe to keep so the code path matches desktop).
"""
import io
import os
import sys
import time

import numpy as np
import torch
from PIL import Image


# ---------------------------------------------------------------------------
# View grid - IDENTICAL to scripts/multiview_mvadapter_gen.py.
# Convention: az 0 = front, 90 = right, 180 = back, 270 = left.
# The camera builder applies a -90 deg offset before calling
# get_orthogonal_camera (MV-Adapter's own convention has 0 = right).
# ---------------------------------------------------------------------------
VIEW_SLOTS = [
    (  0.0,   0.0),   # view_0 front
    ( 90.0,   0.0),   # view_1 right
    (180.0,   0.0),   # view_2 back
    (270.0,   0.0),   # view_3 left
    (  0.0,  60.0),   # view_4 top 3/4-high
    (  0.0, -60.0),   # view_5 bottom 3/4-low
]

# Pinned snapshot revisions - protects against silent upstream changes
# to model weights that would invalidate our snapshot. The HF hub
# resolves these to immutable commits.
SDXL_BASE_REVISION = "462165984030d82259a11f4367a4eed129e94a7b"  # vanilla SDXL-base-1.0
SDXL_VAE_REVISION  = "4df413ca49271c25289a6482ab97a433f8117d15"  # madebyollin sdxl-vae-fp16-fix
MV_ADAPTER_REPO    = "huanngzh/mv-adapter"
MV_ADAPTER_FILE    = "mvadapter_i2mv_sdxl.safetensors"


# ---------------------------------------------------------------------------
# Preprocessing - mirrors steps a-f from scripts/multiview_mvadapter_gen.py
# section "9. INPUT PREPROCESSING". Returns (ref_rgb_for_model, rgba_input).
# ---------------------------------------------------------------------------
def preprocess_reference(
    ref_img: Image.Image,
    size: int,
    rembg_session,
) -> tuple[Image.Image, Image.Image]:
    """Open as RGBA -> strip bg if opaque -> square pad -> resize -> composite
    onto mid-grey for the SDXL reference. Returns:
      (ref_rgb_on_grey, rgba_input_for_caller)
    The caller stores the RGBA version for downstream texture_project.
    """
    img = ref_img.convert("RGBA")

    # Background removal only if the alpha is fully opaque (no existing mask).
    if np.asarray(img)[..., 3].min() == 255:
        import rembg
        img = rembg.remove(img, session=rembg_session)

    # Square pad with transparency.
    w, h = img.size
    s = max(w, h)
    pad = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    pad.paste(img, ((s - w) // 2, (s - h) // 2))
    img = pad.resize((size, size), Image.LANCZOS)

    # Composite onto mid-grey (0.5) for the diffusion reference image.
    arr = np.asarray(img).astype(np.float32) / 255.0
    alpha = arr[..., 3:4]
    rgb = arr[..., :3] * alpha + (1.0 - alpha) * 0.5
    ref_rgb = Image.fromarray((rgb * 255).clip(0, 255).astype(np.uint8))
    return ref_rgb, img  # ref for model, RGBA preserved


# ---------------------------------------------------------------------------
# Post-process: grey-bg -> alpha for one PIL view.
# Mirrors section "10. OUTPUT POST-PROCESSING" from the desktop script.
# ---------------------------------------------------------------------------
def grey_to_alpha(view: Image.Image, size: int) -> Image.Image:
    rgb = view.convert("RGB")
    if rgb.size != (size, size):
        rgb = rgb.resize((size, size), Image.LANCZOS)
    arr = np.asarray(rgb)
    dist = np.linalg.norm(arr.astype(float) - np.array([128.0, 128.0, 128.0]), axis=2)
    alpha = (dist > 25).astype(np.uint8) * 255
    rgba = np.dstack([arr, alpha])
    return Image.fromarray(rgba, mode="RGBA")


# ---------------------------------------------------------------------------
# Build the orthographic-camera Plucker embedding the adapter needs.
# Lifted verbatim from scripts/multiview_mvadapter_gen.py section 5.
# ---------------------------------------------------------------------------
def build_plucker_embeds(size: int, device: str):
    from mvadapter.utils.mesh_utils import get_orthogonal_camera
    from mvadapter.utils.geometry import get_plucker_embeds_from_cameras_ortho

    n = len(VIEW_SLOTS)
    cameras = get_orthogonal_camera(
        elevation_deg=[el for _, el in VIEW_SLOTS],
        distance=[1.8] * n,
        left=-0.55, right=0.55, bottom=-0.55, top=0.55,
        # -90 offset matches MV-Adapter's internal "azimuth 0 = right" convention.
        azimuth_deg=[az - 90 for az, _ in VIEW_SLOTS],
        device=device,
    )
    plucker_embeds = get_plucker_embeds_from_cameras_ortho(
        cameras.c2w, [1.1] * n, size,
    )
    control_images = ((plucker_embeds + 1.0) / 2.0).clamp(0.0, 1.0)
    return control_images


# ---------------------------------------------------------------------------
# Public entry point - called from the @app.cls endpoint in app.py.
# The caller passes the pre-loaded MV-Adapter pipeline (built in
# @modal.enter), the rembg session, and (optionally) the NSFW classifiers
# for per-view content filtering.
# ---------------------------------------------------------------------------
def generate(
    pipe,                       # MVAdapterI2MVSDXLPipeline already on CUDA
    rembg_session,              # rembg.new_session() - used to strip ref bg
    ref_img: Image.Image,
    prompt: str = "high quality",
    subject_prompt: str = "",
    num_steps: int = 50,
    guidance_scale: float = 4.5,
    size: int = 768,
    seed: int = 1234,
    nsfw_clf1=None, nsfw_clf2=None,
    nsfw_threshold: float = 0.5,
) -> dict:
    """Run MV-Adapter once and return all 6 views as PIL RGBA images.

    Returns:
        {
          "views": [ {"azim": float, "elev": float, "image": PIL.Image}, ... ],
          "input": PIL.Image,        # the RGBA preprocessed reference
          "nsfw_blocked": bool,      # True iff any view tripped the NSFW filter
          "nsfw_max_score": float,
        }
    """
    t_total = time.time()
    device = "cuda" if torch.cuda.is_available() else "cpu"

    # 1. Preprocess the reference image - same recipe as desktop.
    ref_rgb, rgba_input = preprocess_reference(ref_img, size, rembg_session)
    print(f"[mvadapter] preprocess size={size} subject_prompt={subject_prompt!r}",
          flush=True)

    # 2. Build the camera/Plucker control conditioning.
    control_images = build_plucker_embeds(size, device)

    # 3. Build the final prompt - same order as desktop section 8.
    full_prompt = f"{subject_prompt}, {prompt}" if subject_prompt else prompt
    neg_prompt = (
        "watermark, ugly, deformed, noisy, blurry, low contrast, "
        "distorted anatomy, extra limbs, text, signature"
    )

    # 4. Deterministic generator if seed >= 0.
    gen = (torch.Generator(device=device).manual_seed(int(seed))
           if seed is not None and seed >= 0 else None)

    # 5. Inference - same knobs as scripts/multiview_mvadapter_gen.py.
    t_inf = time.time()
    result = pipe(
        prompt=full_prompt,
        negative_prompt=neg_prompt,
        num_inference_steps=int(num_steps),
        guidance_scale=float(guidance_scale),
        num_images_per_prompt=len(VIEW_SLOTS),
        reference_image=ref_rgb,
        control_image=control_images,
        control_conditioning_scale=1.0,
        reference_conditioning_scale=1.3,
        height=size, width=size,
        generator=gen,
        cross_attention_kwargs={"scale": 1.0},
    )
    pil_views = result.images
    print(f"[mvadapter] inference dt={time.time() - t_inf:.1f}s "
          f"views={len(pil_views)}", flush=True)

    # 6. Post-process - grey -> alpha for each view.
    views_out = []
    nsfw_max = 0.0
    nsfw_block = False
    for i, (view, (az, el)) in enumerate(zip(pil_views, VIEW_SLOTS)):
        rgba = grey_to_alpha(view, size)

        # Optional per-view NSFW scan (desktop bridge skips this - we add it
        # for parity with the rest of the cloud surface).
        if nsfw_clf1 is not None and nsfw_clf2 is not None:
            from modal_app._nsfw import is_safe
            safe, score = is_safe(rgba.convert("RGB"), nsfw_clf1, nsfw_clf2,
                                  threshold=nsfw_threshold)
            nsfw_max = max(nsfw_max, score)
            if not safe:
                from modal_app._nsfw import make_blocked_placeholder
                rgba = make_blocked_placeholder((size, size)).convert("RGBA")
                nsfw_block = True
                print(f"[mvadapter] view_{i} BLOCKED nsfw={score:.3f}", flush=True)

        views_out.append({"azim": float(az), "elev": float(el), "image": rgba})

    print(f"[mvadapter] DONE total_dt={time.time() - t_total:.1f}s "
          f"nsfw_blocked={nsfw_block}", flush=True)
    return {
        "views": views_out,
        "input": rgba_input,
        "nsfw_blocked": nsfw_block,
        "nsfw_max_score": float(nsfw_max),
    }
