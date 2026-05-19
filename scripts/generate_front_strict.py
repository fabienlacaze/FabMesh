"""Generate a strict ORTHOGRAPHIC FRONT view from a text prompt OR an
existing image — works on any subject type, not just humanoids.

Companion to `generate_front_tpose.py` which uses ControlNet OpenPose
(humanoid skeleton, irrelevant for cars/creatures/objects). This script
takes the cheap-but-effective path:
  1. Augment the prompt with strict-front orthographic cues.
  2. Sample N seeds (default 3).
  3. Score each candidate by horizontal symmetry of the rembg-masked
     subject. An orthographic front is highly left-right symmetric
     (mirror equality of foreground pixels around the vertical axis).
  4. Keep the best candidate, run it through `remove_bg_and_center`
     so it cascades cleanly into the rest of the pipeline.

When `--from-image <ref>` is given, the reference is used as IPAdapter
identity anchor (preserves the user's intended subject color/silhouette
while moving toward strict front).

Licensing: RealVis XL (RAIL++-M), IPAdapter (Apache), rembg (MIT).
All commercial-safe.

Usage:
    python generate_front_strict.py <prompt> <output.png>
        [--seeds 3] [--steps 30] [--guidance 7.0]
    python generate_front_strict.py --from-image <ref.png> <output.png>
        [--seeds 3]
"""
import argparse
import os
import sys
import time

import numpy as np
import torch
from PIL import Image


SCRIPTS = os.path.dirname(os.path.abspath(__file__))


def log(msg):
    print(f'[front-strict] {msg}', flush=True)


# Reuse the rembg + center helper from generate_front_tpose.py to keep
# the output format identical (1024² white canvas, subject ~92% height).
sys.path.insert(0, SCRIPTS)
from generate_front_tpose import remove_bg_and_center


STRICT_FRONT_TAIL = (
    ', strict orthographic front view, perfectly head-on, '
    'symmetric horizontal mirror, zero rotation, no tilt, '
    'no perspective distortion, centered subject, plain white '
    'background, even studio lighting, sharp focus, 8k, masterpiece'
)

NEG = (
    'side view, profile view, three quarter view, back view, '
    '3/4 angle, rotated, perspective view, tilted, asymmetric, '
    'cropped, blurry, deformed, multiple subjects, watermark, '
    'low quality, frame, border, signature'
)


def symmetry_score(img: Image.Image) -> float:
    """Return a [0, 1] score of horizontal symmetry on the rembg-masked
    foreground. 1.0 = perfectly symmetric, 0.0 = no symmetry."""
    from rembg import remove
    rgba = remove(img.convert('RGBA'))
    arr = np.array(rgba)
    alpha = arr[..., 3].astype(np.float32) / 255.0
    if alpha.sum() < 100:
        return 0.0  # no subject
    # Crop to subject bbox to make the comparison shift-invariant.
    ys, xs = np.where(alpha > 0.05)
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
    crop = arr[y0:y1 + 1, x0:x1 + 1]
    crop_alpha = crop[..., 3].astype(np.float32) / 255.0
    # Compare alpha to its horizontal flip (where the subject is, not
    # the texture — silhouette symmetry is what defines orthographic front).
    flipped = crop_alpha[:, ::-1]
    # IoU-style score on the binarized masks.
    a_bin = (crop_alpha > 0.5)
    f_bin = (flipped > 0.5)
    inter = np.logical_and(a_bin, f_bin).sum()
    union = np.logical_or(a_bin, f_bin).sum()
    return float(inter / union) if union > 0 else 0.0


def load_pipeline(use_ipadapter_image_ref=None):
    from diffusers import StableDiffusionXLPipeline
    log('loading RealVisXL + (optional IPAdapter)')
    kwargs = {
        'torch_dtype': torch.float16,
        'variant': 'fp16',
        'use_safetensors': True,
    }
    if use_ipadapter_image_ref is not None:
        from transformers import CLIPVisionModelWithProjection
        kwargs['image_encoder'] = CLIPVisionModelWithProjection.from_pretrained(
            'h94/IP-Adapter', subfolder='models/image_encoder',
            torch_dtype=torch.float16)
    pipe = StableDiffusionXLPipeline.from_pretrained(
        'SG161222/RealVisXL_V4.0', **kwargs)
    pipe.unet.to(torch.float16)
    pipe.vae.to(torch.float16)
    pipe.text_encoder.to(torch.float16)
    pipe.text_encoder_2.to(torch.float16)
    if use_ipadapter_image_ref is not None:
        pipe.load_ip_adapter(
            'h94/IP-Adapter', subfolder='sdxl_models',
            weight_name='ip-adapter-plus_sdxl_vit-h.safetensors')
        # 0.7 = preserve identity + still let the prompt re-orient
        # the subject toward strict front.
        pipe.set_ip_adapter_scale(0.7)
    pipe.enable_model_cpu_offload()
    log('pipeline ready')
    return pipe


def generate(prompt, out_path, ref_image=None, seeds=3, steps=30,
             guidance=7.0, size=1024):
    full_prompt = prompt.strip().rstrip('.,') + STRICT_FRONT_TAIL
    log(f'prompt: "{full_prompt[:200]}..."')
    log(f'seeds={seeds} steps={steps} guidance={guidance}')

    ipadapter_ref = None
    if ref_image is not None:
        ipadapter_ref = Image.open(ref_image).convert('RGB')
        log(f'using ref image as IPAdapter anchor: {ref_image}')

    pipe = load_pipeline(use_ipadapter_image_ref=ipadapter_ref)

    candidates = []
    t0 = time.time()
    for i, base_seed in enumerate(range(seeds)):
        seed = 1000 + base_seed * 137  # spread seeds reproducibly
        gen = torch.Generator('cuda').manual_seed(seed)
        call_kwargs = dict(
            prompt=full_prompt, negative_prompt=NEG,
            num_inference_steps=steps, guidance_scale=guidance,
            height=size, width=size, generator=gen,
        )
        if ipadapter_ref is not None:
            call_kwargs['ip_adapter_image'] = ipadapter_ref
        img = pipe(**call_kwargs).images[0]
        score = symmetry_score(img)
        log(f'  candidate {i+1}/{seeds} seed={seed} symmetry={score:.3f}')
        candidates.append((score, img, seed))

    candidates.sort(key=lambda t: -t[0])
    best_score, best_img, best_seed = candidates[0]
    log(f'best: seed={best_seed} symmetry={best_score:.3f} '
        f'(after {time.time()-t0:.1f}s)')

    log('post-processing: rembg + center')
    final = remove_bg_and_center(best_img, size=size)
    final.save(out_path)
    log(f'saved -> {out_path}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('prompt_or_first', nargs='?')
    ap.add_argument('output')
    ap.add_argument('--from-image', dest='from_image', default=None)
    ap.add_argument('--seeds', type=int, default=3)
    ap.add_argument('--steps', type=int, default=30)
    ap.add_argument('--guidance', type=float, default=7.0)
    args = ap.parse_args()

    if args.from_image is not None:
        if not os.path.isfile(args.from_image):
            log(f'ERROR: --from-image not found: {args.from_image}')
            sys.exit(2)
        # When refining an existing image, use a generic prompt — the
        # IPAdapter carries the identity.
        prompt = args.prompt_or_first or 'subject'
        generate(prompt, args.output, ref_image=args.from_image,
                 seeds=args.seeds, steps=args.steps, guidance=args.guidance)
    else:
        if not args.prompt_or_first:
            log('ERROR: prompt required (or use --from-image)')
            sys.exit(2)
        generate(args.prompt_or_first, args.output, ref_image=None,
                 seeds=args.seeds, steps=args.steps, guidance=args.guidance)


if __name__ == '__main__':
    main()
