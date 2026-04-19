"""Generate a strict T-pose FRONT view from a text prompt OR from an
existing image (img2img seed). Uses RealVis XL + ControlNet OpenPose
with a T-pose front skeleton, then remove_bg + center on a 1024² white
canvas so the subject is centered + full height (feet visible).

This produces a deterministic T-pose front photo that cascades through
the rest of the FabMesh pipeline (MVAdapter, voie B/C bake) cleanly:
no "bras collés" mismatch with the back T-pose RealVis generates.

Licensing: RealVis XL (RAIL++-M), ControlNet OpenPose xinsir (Apache 2.0),
rembg (MIT). All commercial-safe.

Usage:
    python generate_front_tpose.py <prompt> <output.png> [seed] [cn_scale]
    python generate_front_tpose.py --from-image <ref.png> <output.png> [seed]
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
    print(f'[front-tpose] {msg}', flush=True)


def ensure_skeleton():
    """Regenerate the T-pose front skeleton if missing."""
    skel = os.path.join(SCRIPTS, '_front_tpose_skeleton.png')
    if not os.path.exists(skel):
        from _make_front_skeleton import make_tpose_front
        make_tpose_front().save(skel)
    return skel


def remove_bg_and_center(img: Image.Image, size=1024, bg_rgb=(255, 255, 255),
                        target_height_frac=0.92):
    """Remove background with rembg, then center + pad the subject on a
    size² white canvas so the subject is target_height_frac of the frame.
    Guarantees feet are NOT cropped."""
    from rembg import remove
    rgba = remove(img.convert('RGBA'))
    arr = np.array(rgba)
    alpha = arr[..., 3] > 10
    if not alpha.any():
        log('rembg found no subject, returning original resized')
        return img.convert('RGB').resize((size, size), Image.LANCZOS)
    ys, xs = np.where(alpha)
    y0, y1 = ys.min(), ys.max()
    x0, x1 = xs.min(), xs.max()
    crop = arr[y0:y1 + 1, x0:x1 + 1]
    h, w = y1 - y0 + 1, x1 - x0 + 1
    # Scale so subject height = target * size
    target_h = int(size * target_height_frac)
    scale = target_h / h
    new_h = target_h
    new_w = max(1, int(round(w * scale)))
    # If width would overflow, fit width instead
    if new_w > int(size * 0.95):
        new_w = int(size * 0.95)
        scale = new_w / w
        new_h = max(1, int(round(h * scale)))
    crop_img = Image.fromarray(crop).resize((new_w, new_h), Image.LANCZOS)
    # Composite on white canvas, centered horizontally, feet near bottom
    canvas = Image.new('RGB', (size, size), bg_rgb)
    x = (size - new_w) // 2
    y = size - new_h - int(size * 0.02)  # small bottom margin (~2%)
    y = max(0, y)
    canvas.paste(crop_img, (x, y),
                 crop_img if crop_img.mode == 'RGBA' else None)
    return canvas


def load_pipeline(use_ipadapter_image_ref=None):
    from diffusers import (
        ControlNetModel,
        StableDiffusionXLControlNetPipeline,
    )
    log('loading ControlNet OpenPose + RealVisXL + (optional IPAdapter)')
    controlnet = ControlNetModel.from_pretrained(
        'xinsir/controlnet-openpose-sdxl-1.0', torch_dtype=torch.float16)
    kwargs = {
        'controlnet': controlnet,
        'torch_dtype': torch.float16,
        'variant': 'fp16',
        'use_safetensors': True,
    }
    if use_ipadapter_image_ref is not None:
        from transformers import CLIPVisionModelWithProjection
        kwargs['image_encoder'] = CLIPVisionModelWithProjection.from_pretrained(
            'h94/IP-Adapter', subfolder='models/image_encoder',
            torch_dtype=torch.float16)
    pipe = StableDiffusionXLControlNetPipeline.from_pretrained(
        'SG161222/RealVisXL_V4.0', **kwargs)
    pipe.unet.to(torch.float16)
    pipe.vae.to(torch.float16)
    pipe.text_encoder.to(torch.float16)
    pipe.text_encoder_2.to(torch.float16)
    if use_ipadapter_image_ref is not None:
        pipe.load_ip_adapter(
            'h94/IP-Adapter', subfolder='sdxl_models',
            weight_name='ip-adapter-plus_sdxl_vit-h.safetensors')
    pipe.enable_model_cpu_offload()
    log('pipeline ready')
    return pipe


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


def run_from_prompt(prompt, out_path, seed=42, cn_scale=1.15, steps=30,
                    guidance=7.0, size=1024):
    skel = Image.open(ensure_skeleton()).convert('RGB')
    pipe = load_pipeline()
    t0 = time.time()
    full_prompt = prompt.strip().rstrip('.,') + FRONT_PROMPT_TAIL
    log(f'prompt: "{full_prompt[:200]}..."')
    log(f'cn_scale={cn_scale} seed={seed} steps={steps}')
    gen = torch.Generator('cuda').manual_seed(int(seed))
    img = pipe(
        prompt=full_prompt, negative_prompt=NEG,
        image=skel, controlnet_conditioning_scale=cn_scale,
        num_inference_steps=steps, guidance_scale=guidance,
        height=size, width=size,
        generator=gen,
    ).images[0]
    log(f'diffusion done in {time.time()-t0:.1f}s')
    log('post-processing: rembg + center')
    img_c = remove_bg_and_center(img, size=size)
    img_c.save(out_path)
    log(f'saved {out_path}')


def run_from_image(ref_path, out_path, seed=42, cn_scale=1.15,
                   ip_scale=0.75, steps=30, guidance=7.0, size=1024):
    """Regenerate a T-pose front FROM an existing front image (keeps
    identity/outfit via IPAdapter, forces T-pose via ControlNet)."""
    skel = Image.open(ensure_skeleton()).convert('RGB')
    ref = Image.open(ref_path).convert('RGB')
    pipe = load_pipeline(use_ipadapter_image_ref=True)
    pipe.set_ip_adapter_scale(ip_scale)
    t0 = time.time()
    caption = (
        'a person in a T-pose, arms extended horizontally sideways, '
        'facing camera directly, plain white background'
    )
    full_prompt = caption + FRONT_PROMPT_TAIL
    log(f'ref image: {ref_path}')
    log(f'ip_scale={ip_scale} cn_scale={cn_scale} seed={seed}')
    gen = torch.Generator('cuda').manual_seed(int(seed))
    img = pipe(
        prompt=full_prompt, negative_prompt=NEG,
        image=skel, controlnet_conditioning_scale=cn_scale,
        ip_adapter_image=ref,
        num_inference_steps=steps, guidance_scale=guidance,
        height=size, width=size,
        generator=gen,
    ).images[0]
    log(f'diffusion done in {time.time()-t0:.1f}s')
    log('post-processing: rembg + center')
    img_c = remove_bg_and_center(img, size=size)
    img_c.save(out_path)
    log(f'saved {out_path}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--prompt', default=None,
                        help='Text prompt (text2image mode)')
    parser.add_argument('--from-image', dest='from_image', default=None,
                        help='Existing image to re-pose as T-pose (img+IPA mode)')
    parser.add_argument('--out', required=True, help='Output PNG path')
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--cn-scale', type=float, default=1.15)
    parser.add_argument('--ip-scale', type=float, default=0.75)
    args = parser.parse_args()
    if args.from_image:
        run_from_image(args.from_image, args.out, seed=args.seed,
                       cn_scale=args.cn_scale, ip_scale=args.ip_scale)
    elif args.prompt:
        run_from_prompt(args.prompt, args.out, seed=args.seed,
                        cn_scale=args.cn_scale)
    else:
        print('Must provide --prompt or --from-image')
        sys.exit(1)


if __name__ == '__main__':
    main()
