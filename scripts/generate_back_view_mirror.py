"""Generate a BACK VIEW that PERFECTLY matches the front by mirror+inpaint.

Pipeline:
1. Mirror the front photo horizontally (silhouette + outfit identical,
   only side-flipped).
2. Detect upper body (head + torso) with MediaPipe Pose.
3. Build a soft mask covering head + upper torso.
4. Inpaint the masked region with ControlNet Tile (Apache 2.0) +
   ControlNet Inpaint SDXL prompted "back of head, hair from behind,
   no face visible, back of shoulders".
5. Lower body (legs, feet) stays pixel-identical to the mirrored front
   = SAME outfit guarantee on the bottom half.

Output: out_dir/back_<stem>_<N>.png (same naming as generate_back_view.py).

Models (all commercial-safe):
- SG161222/RealVisXL_V4.0 (CreativeML OpenRAIL++-M)
- xinsir/controlnet-tile-sdxl-1.0 (Apache 2.0)
- diffusers-community/sdxl-controlnet-seg, etc. as needed
- mediapipe.solutions.pose (Apache 2.0)
"""
import sys
import os
import re
import time
import torch
import numpy as np
from PIL import Image, ImageFilter, ImageDraw


def detect_upper_body_mask(front_pil, height_frac=0.55, soft_px=24):
    """Return a PIL 'L' mask (0=keep, 255=inpaint) covering head + upper
    torso of the subject. Uses rembg alpha (already a project dep) for
    a person-shaped silhouette; falls back to top-fraction rectangle if
    needed. Simpler than MediaPipe Pose (which would need a model
    download) and good enough for the upper-body cutoff.
    """
    rgb = np.array(front_pil.convert('RGB'))
    h, w = rgb.shape[:2]
    mask = np.zeros((h, w), dtype=np.uint8)

    # Try rembg to extract the person silhouette
    try:
        import rembg
        from io import BytesIO
        sess = rembg.new_session('u2net')
        with BytesIO() as buf:
            front_pil.convert('RGB').save(buf, format='PNG')
            cut_bytes = rembg.remove(buf.getvalue(), session=sess)
        cut = Image.open(BytesIO(cut_bytes)).convert('RGBA')
        alpha = np.array(cut)[:, :, 3]
        person_mask = (alpha > 32).astype(np.uint8) * 255
        ys = np.where(person_mask.any(axis=1))[0]
        if len(ys) > 0:
            top_y = int(ys.min())
            bot_y = int(ys.max())
            person_h = bot_y - top_y
            cutoff_y = int(top_y + person_h * height_frac)
            mask = person_mask.copy()
            mask[cutoff_y:, :] = 0
            print(f'[mask] person bbox y={top_y}..{bot_y}, '
                  f'inpaint to y={cutoff_y} (top {height_frac*100:.0f}%)',
                  flush=True)
    except Exception as e:
        print(f'[mask] rembg failed ({e}), falling back to rectangle', flush=True)

    if mask.max() == 0:
        print('[mask] using top-fraction rectangle fallback', flush=True)
        cutoff = int(h * height_frac)
        mask[:cutoff, :] = 255

    # Soft-edge the mask so the inpaint blends smoothly into the kept
    # bottom half. Gaussian blur on a binary 0/255 mask -> ramp.
    mask_pil = Image.fromarray(mask, 'L')
    if soft_px > 0:
        mask_pil = mask_pil.filter(ImageFilter.GaussianBlur(radius=soft_px))
    return mask_pil


def generate_back_mirror(front_image, out_dir, prompt_hint='', num_images=1,
                          name_suffix='', seed=424242, steps=35):
    os.makedirs(out_dir, exist_ok=True)
    print(f'[back-mirror] front={front_image} out={out_dir} '
          f'hint="{prompt_hint}" n={num_images}', flush=True)

    front = Image.open(front_image).convert('RGB')
    print(f'[back-mirror] loaded front {front.size}', flush=True)

    # 1. Mirror horizontally
    mirrored = front.transpose(Image.FLIP_LEFT_RIGHT)

    # 2. Upper-body mask (head + ~70% torso so face is fully covered)
    mask = detect_upper_body_mask(mirrored, height_frac=0.70, soft_px=32)

    # 3. SDXL Inpaint pipeline (NO ControlNet — Tile would preserve the
    # front face structure we're TRYING to remove). Pure inpaint with a
    # strong prompt forces the masked area to become a back view.
    print('[back-mirror] loading SDXL inpaint...', flush=True)
    from diffusers import StableDiffusionXLInpaintPipeline
    pipe = StableDiffusionXLInpaintPipeline.from_pretrained(
        'SG161222/RealVisXL_V4.0',
        torch_dtype=torch.float16, variant='fp16', use_safetensors=True,
    )
    pipe.unet.to(torch.float16)
    pipe.vae.to(torch.float16)
    pipe.text_encoder.to(torch.float16)
    pipe.text_encoder_2.to(torch.float16)
    pipe.enable_model_cpu_offload()
    print('[back-mirror] ready', flush=True)

    base = prompt_hint if prompt_hint else 'a person'
    prompt = (
        f'BACK VIEW of {base}, back of head, hair from behind, '
        f'back of neck, back of shoulders, no face visible, '
        f'subject turned 180 degrees away from camera, '
        f'plain grey background, studio lighting, sharp focus, '
        f'ultra detailed, 8k, masterpiece, photorealistic'
    )
    neg = (
        'face visible, eyes, mouth, nose, ears, front view, facing camera, '
        'three-quarter view, side view, profile, looking at camera, '
        'blurry, deformed, extra limbs, bad anatomy'
    )
    print(f'[back-mirror] prompt: {prompt[:200]}', flush=True)

    # Output filename: scan existing back_<suffix>_<N>.png
    suffix = f'_{name_suffix}' if name_suffix else ''
    pattern = re.compile(rf'^back{re.escape(suffix)}_(\d+)\.png$')
    existing = [-1]
    for f in os.listdir(out_dir):
        m = pattern.match(f)
        if m:
            existing.append(int(m.group(1)))
    start_idx = max(existing) + 1
    print(f'[back-mirror] starting at back{suffix}_{start_idx}', flush=True)

    out_paths = []
    for i in range(num_images):
        gen = torch.Generator('cuda').manual_seed(
            seed if num_images == 1 else seed + i)
        t0 = time.time()
        # ControlNet input = the mirrored front itself (Tile model uses
        # the source image as structural reference).
        result = pipe(
            prompt=prompt,
            negative_prompt=neg,
            image=mirrored,           # base image (mirrored front)
            mask_image=mask,          # area to regenerate
            strength=1.0,             # full repaint inside mask
            num_inference_steps=steps,
            guidance_scale=8.0,       # higher = stronger 'back view' bias
            height=front.size[1],
            width=front.size[0],
            generator=gen,
        ).images[0]
        print(f'[back-mirror] gen {i}: {time.time()-t0:.1f}s', flush=True)
        out_path = os.path.join(out_dir, f'back{suffix}_{start_idx + i}.png')
        result.save(out_path)
        out_paths.append(out_path)
        print(f'[back-mirror] saved {out_path}', flush=True)

    print(f'[back-mirror] done — {len(out_paths)} image(s)', flush=True)
    return out_paths


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('Usage: generate_back_view_mirror.py <front_image> '
              '<output_dir> [prompt_hint] [num_images] [name_suffix]')
        sys.exit(1)
    front = sys.argv[1]
    out = sys.argv[2]
    hint = sys.argv[3] if len(sys.argv) > 3 else ''
    n = int(sys.argv[4]) if len(sys.argv) > 4 else 1
    name_suffix = sys.argv[5] if len(sys.argv) > 5 else ''
    paths = generate_back_mirror(front, out, hint, n,
                                  name_suffix=name_suffix)
    for p in paths:
        print(f'BACK_VIEW_PATH: {p}', flush=True)
