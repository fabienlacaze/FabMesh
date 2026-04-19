"""Voie D1 — regenerate lateral views (right/left) in 1024² by img2img
from the front HD view, piloted by the lateral OpenPose skeleton.

Rationale: MVAdapter 512² lateral views are soft and inherit pose
from the front photo (bras collés). Using the HD front T-pose view
as img2img init + a strict lateral skeleton gives:
  - full 1024² resolution (matches front/back HD)
  - T-pose arms (inherited from front init)
  - correct profile framing (forced by ControlNet)
  - identity from IPAdapter (same outfit/hair/face)

Stack: StableDiffusionXLControlNetImg2ImgPipeline + IPAdapter +
ControlNet OpenPose SDXL. All commercial-safe.

Writes view_1.png (right) and view_3.png (left) into <mv_dir>,
overwriting MVAdapter outputs. views.json stays intact.
"""
import argparse
import os
import sys
import time

import numpy as np
import torch
from PIL import Image

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPTS)
from _tpose_joints_3d import render_skeleton_for_camera  # noqa: E402


def log(msg):
    print(f'[lat-refine] {msg}', flush=True)


def _get_c2w(azim_mva_deg, elev_deg, distance):
    import math
    az = math.radians(azim_mva_deg)
    el = math.radians(elev_deg)
    cp = np.array([
        distance * math.cos(el) * math.cos(az),
        distance * math.cos(el) * math.sin(az),
        distance * math.sin(el),
    ])
    up = np.array([0.0, 0.0, 1.0])
    lookat = -cp / (np.linalg.norm(cp) + 1e-10)
    right = np.cross(lookat, up)
    n = np.linalg.norm(right)
    right = right / n if n > 1e-6 else np.array([1.0, 0, 0])
    new_up = np.cross(right, lookat)
    R = np.stack([right, new_up, -lookat], axis=-1)
    c2w = np.eye(4)
    c2w[:3, :3] = R
    c2w[:3, 3] = cp
    return c2w


def _get_ortho_proj(L, R, B, T, near=0.1, far=100.0):
    m = np.zeros((4, 4))
    m[0, 0] = 2 / (R - L)
    m[1, 1] = -2 / (T - B)
    m[2, 2] = -2 / (far - near)
    m[0, 3] = -(R + L) / (R - L)
    m[1, 3] = -(T + B) / (T - B)
    m[2, 3] = -(far + near) / (far - near)
    m[3, 3] = 1.0
    return m


# For each lateral view: (logical_azim, side_label, prompt).
LATERAL_VIEWS = [
    (90,  'right', 'strict right side profile view, 90 degree side view, '
                  'facing right, one ear visible, nose pointing to the right, '
                  'T-pose arms extended sideways, same outfit and hair color '
                  'as reference, full body centered, plain grey background'),
    (270, 'left',  'strict left side profile view, 90 degree side view, '
                  'facing left, one ear visible, nose pointing to the left, '
                  'T-pose arms extended sideways, same outfit and hair color '
                  'as reference, full body centered, plain grey background'),
]

NEGATIVE = (
    'front view, back view, three quarter view, facing camera, '
    'looking at camera, both eyes visible, symmetric face, '
    'blurry, deformed, extra limbs, bad anatomy, different person, '
    'watermark, text, cropped, low quality'
)


def load_pipeline():
    from diffusers import (
        ControlNetModel,
        StableDiffusionXLControlNetImg2ImgPipeline,
    )
    from transformers import CLIPVisionModelWithProjection
    log('loading ControlNet OpenPose + RealVisXL (img2img) + IPAdapter')
    image_encoder = CLIPVisionModelWithProjection.from_pretrained(
        'h94/IP-Adapter', subfolder='models/image_encoder',
        torch_dtype=torch.float16)
    controlnet = ControlNetModel.from_pretrained(
        'xinsir/controlnet-openpose-sdxl-1.0', torch_dtype=torch.float16)
    pipe = StableDiffusionXLControlNetImg2ImgPipeline.from_pretrained(
        'SG161222/RealVisXL_V4.0',
        controlnet=controlnet,
        torch_dtype=torch.float16, variant='fp16',
        use_safetensors=True,
        image_encoder=image_encoder)
    pipe.unet.to(torch.float16)
    pipe.vae.to(torch.float16)
    pipe.text_encoder.to(torch.float16)
    pipe.text_encoder_2.to(torch.float16)
    pipe.load_ip_adapter(
        'h94/IP-Adapter', subfolder='sdxl_models',
        weight_name='ip-adapter-plus_sdxl_vit-h.safetensors')
    pipe.enable_model_cpu_offload()
    log('pipeline ready')
    return pipe


def run(front_hd_path, mv_dir, seed=42, size=1024,
        strength=0.80, cn_scale=1.15, ip_scale=0.50,
        steps=30, guidance=7.0):
    """front_hd_path: the T-pose HD front (view_0). Used as both
       img2img init AND IPAdapter identity reference.
    mv_dir: output dir (contains views.json + view_*.png)."""
    front_hd_path = os.path.abspath(front_hd_path)
    mv_dir = os.path.abspath(mv_dir)
    log(f'front_hd={front_hd_path}')
    log(f'mv_dir={mv_dir}')
    log(f'strength={strength} cn_scale={cn_scale} ip_scale={ip_scale}')

    import gc
    gc.collect()
    torch.cuda.empty_cache()
    free_mb = torch.cuda.mem_get_info()[0] // (1024 * 1024)
    log(f'VRAM free at start: {free_mb} MB')

    front_img = Image.open(front_hd_path).convert('RGB')
    if front_img.size != (size, size):
        front_img = front_img.resize((size, size), Image.LANCZOS)

    pipe = load_pipeline()
    pipe.set_ip_adapter_scale(ip_scale)

    proj = _get_ortho_proj(-0.55, 0.55, -0.55, 0.55)

    for logical_azim, label, prompt in LATERAL_VIEWS:
        t0 = time.time()
        mva_azim = logical_azim - 90
        c2w = _get_c2w(mva_azim, 0.0, 1.8)
        w2c = np.linalg.inv(c2w)
        skel = render_skeleton_for_camera(w2c, proj, size=size,
                                          draw_invisible=True)
        # target index: view_1 for right (azim=90), view_3 for left (azim=270)
        vi = 1 if logical_azim == 90 else 3
        log(f'view_{vi} {label} side (azim={logical_azim})')
        gen = torch.Generator('cuda').manual_seed(int(seed) + logical_azim)
        # img2img: front HD provides init latents, ControlNet OpenPose
        # forces the profile pose, IPAdapter preserves identity.
        img = pipe(
            prompt=prompt,
            negative_prompt=NEGATIVE,
            image=front_img,                   # img2img init
            control_image=skel,                # CN cond
            controlnet_conditioning_scale=cn_scale,
            ip_adapter_image=front_img,        # identity anchor (same source)
            strength=strength,
            num_inference_steps=steps,
            guidance_scale=guidance,
            generator=gen,
        ).images[0]
        out_path = os.path.join(mv_dir, f'view_{vi}.png')
        img.save(out_path)
        log(f'wrote {out_path} in {time.time()-t0:.1f}s')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('front_hd', help='Front HD T-pose image (1024²)')
    p.add_argument('mv_dir', help='Multiview dir with views.json')
    p.add_argument('--seed', type=int, default=42)
    p.add_argument('--strength', type=float, default=0.80,
                   help='img2img denoise strength (0.6-0.9)')
    p.add_argument('--cn-scale', type=float, default=1.15)
    p.add_argument('--ip-scale', type=float, default=0.50)
    p.add_argument('--steps', type=int, default=30)
    args = p.parse_args()
    run(args.front_hd, args.mv_dir,
        seed=args.seed, strength=args.strength,
        cn_scale=args.cn_scale, ip_scale=args.ip_scale,
        steps=args.steps)


if __name__ == '__main__':
    main()
