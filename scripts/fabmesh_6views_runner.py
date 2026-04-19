"""Voie C — generate 6 coherent HD views via FabMesh stack.

Replaces MVAdapter (voie B) with RealVis XL + IPAdapter + ControlNet
OpenPose SDXL. Outputs `view_0..5.png` (1024²) + `views.json` with
full camera matrices, in the same format MVAdapter uses, so
texture_project's orthographic bake path consumes them unchanged.

Licensing (all commercial-safe, no nvdiffrast):
  - RealVis XL v4.0  (CreativeML OpenRAIL++-M)
  - IP-Adapter Plus  (Apache 2.0)
  - ControlNet OpenPose SDXL (Apache 2.0)

Usage:
    python fabmesh_6views_runner.py <mesh.glb> <front_image> <out_dir>
        [num_steps=30] [seed=42] [--reuse-front PATH] [--reuse-back PATH]
"""
import argparse
import json
import math
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
    print(f'[voieC] {msg}', flush=True)


def get_c2w(azim_mva_deg, elev_deg, distance):
    """MVAdapter-compatible camera-to-world (Z-up, +Y forward-ish).
    Reproduces mvadapter.utils.mesh_utils.camera.get_c2w numerically."""
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
    if n < 1e-6:
        # Degenerate (top/bottom) — pick an arbitrary right.
        right = np.array([1.0, 0.0, 0.0])
    else:
        right = right / n
    new_up = np.cross(right, lookat)
    R = np.stack([right, new_up, -lookat], axis=-1)
    c2w = np.eye(4)
    c2w[:3, :3] = R
    c2w[:3, 3] = cp
    return c2w


def get_ortho_proj(L, R, B, T, near=0.1, far=100.0):
    """MVAdapter-compatible orthographic projection matrix.
    Row [1] has the negative sign that already flips Y, so
    texture_project's ortho path must NOT re-flip V."""
    m = np.zeros((4, 4))
    m[0, 0] = 2 / (R - L)
    m[1, 1] = -2 / (T - B)
    m[2, 2] = -2 / (far - near)
    m[0, 3] = -(R + L) / (R - L)
    m[1, 3] = -(T + B) / (T - B)
    m[2, 3] = -(far + near) / (far - near)
    m[3, 3] = 1.0
    return m


# Per-view prompts. "logical" azim: 0=front, 90=right, 180=back, 270=left.
# Params hard-tuned after observing IPAdapter dominance: with ip≥0.50
# RealVis replicates the front photo regardless of CN/prompt. For the
# 5 non-front views we drop ip to 0.18-0.25 (identity only, no pose)
# and push cn to 1.15 (above 1.0 forces skeleton).
# Top/bottom STILL use ControlNet even if the skeleton is degenerate —
# a weak structural hint beats pure IPAdapter which always falls back
# to a front view.
VIEW_SPECS = [
    # (logical_azim, elev, prompt_suffix, ip_scale, cn_scale, use_controlnet)
    (0,   0,      'front view, facing camera, symmetric full body T-pose',
        0.80, 0.70, True),
    (90,  0,      'right side profile silhouette, only right half of body '
                  'visible, nose pointing right, one ear visible, one arm '
                  'extended toward camera, other arm extended away from '
                  'camera, T-pose, strict 90 degree side view',
        0.22, 1.15, True),
    (180, 0,      'back view from behind, back of head, long loose hair '
                  'visible from the back, same hair color and length as '
                  'reference, same dress and outfit as reference, no face, '
                  'no facial features, shoulders and back visible, T-pose '
                  'arms horizontal, turned 180 degrees away from camera',
        0.70, 1.25, True),
    (270, 0,      'left side profile silhouette, only left half of body '
                  'visible, nose pointing left, one ear visible, T-pose, '
                  'strict 90 degree side view from the left',
        0.22, 1.15, True),
    (0,   89.99,  'top-down bird eye view from directly above, head and '
                  'shoulders from above, arms extended as a cross, feet '
                  'hidden below body, foreshortening, T-pose',
        0.25, 0.90, True),   # keep skeleton even if degenerate
    (0,   -89.99, 'bottom-up worm eye view from directly below, feet in '
                  'foreground pointing down at camera, body receding above, '
                  'T-pose arms extended',
        0.25, 0.90, True),
]


NEGATIVE_BASE = (
    'blurry, deformed, extra limbs, bad anatomy, different person, '
    'different clothes, watermark, text, duplicate, multiple people, '
    'cropped, low quality'
)
NEGATIVE_SIDE = NEGATIVE_BASE + (
    ', front view, three-quarter view, facing camera, looking at camera, '
    'both eyes visible, symmetric face'
)
NEGATIVE_BACK = NEGATIVE_BASE + (
    ', face visible, eyes, nose, mouth, front view, three-quarter view, '
    'facing camera, looking at camera'
)
NEGATIVE_TOP = NEGATIVE_BASE + (
    ', front view, side view, level view, facing camera at eye level, '
    'full height silhouette'
)


def load_pipeline():
    from diffusers import (
        ControlNetModel,
        StableDiffusionXLControlNetPipeline,
    )
    from transformers import CLIPVisionModelWithProjection
    log('loading SDXL + ControlNet OpenPose + IPAdapter...')
    image_encoder = CLIPVisionModelWithProjection.from_pretrained(
        'h94/IP-Adapter', subfolder='models/image_encoder',
        torch_dtype=torch.float16)
    controlnet = ControlNetModel.from_pretrained(
        'xinsir/controlnet-openpose-sdxl-1.0', torch_dtype=torch.float16)
    pipe = StableDiffusionXLControlNetPipeline.from_pretrained(
        'SG161222/RealVisXL_V4.0',
        controlnet=controlnet,
        torch_dtype=torch.float16, variant='fp16',
        use_safetensors=True,
        image_encoder=image_encoder)
    # Force submodules to fp16 (some heads stay fp32 by default and cause
    # `mat1 != mat2 dtype` errors on the text_projection).
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


def preprocess_ref(image: Image.Image, size=1024):
    """Center + pad the front photo onto a 1024² square so it matches
    the orthographic camera framing MVAdapter assumes."""
    img = image.convert('RGBA') if image.mode != 'RGBA' else image
    arr = np.array(img)
    alpha = arr[..., 3] > 0
    if alpha.any():
        y, x = np.where(alpha)
        y0, y1 = max(y.min() - 1, 0), min(y.max() + 1, arr.shape[0])
        x0, x1 = max(x.min() - 1, 0), min(x.max() + 1, arr.shape[1])
        crop = arr[y0:y1, x0:x1]
    else:
        crop = arr
    h, w, _ = crop.shape
    if h > w:
        new_h = int(size * 0.9)
        new_w = max(1, int(w * new_h / h))
    else:
        new_w = int(size * 0.9)
        new_h = max(1, int(h * new_w / w))
    crop_img = Image.fromarray(crop).resize((new_w, new_h), Image.LANCZOS)
    full = Image.new('RGB', (size, size), (255, 255, 255))
    full.paste(crop_img,
               ((size - new_w) // 2, (size - new_h) // 2),
               crop_img if crop_img.mode == 'RGBA' else None)
    return full


def load_mesh_transforms(mesh_path):
    """Reproduce MVAdapter's load_mesh(rescale=True, up=+y, front=+x)
    transforms so views.json carries the exact same mesh2std + rescale
    data as voie B. Without this, texture_project's ortho path
    mis-aligns mesh vs skeletons."""
    import trimesh
    scene = trimesh.load(mesh_path, force='mesh', process=False)
    if isinstance(scene, trimesh.Scene):
        mesh = trimesh.util.concatenate(list(scene.geometry.values()))
    else:
        mesh = scene
    # Same as mvadapter_runner: no move_to_center (offset stays None),
    # rescale=True with scale=0.5.
    verts = np.asarray(mesh.vertices, dtype=np.float64)
    rescale_factor = float(np.abs(verts).max()) / 0.5
    # mesh2std for up=+y / front=+x
    up_vec = np.array([0, 1, 0], dtype=np.float64)
    front_vec = np.array([1, 0, 0], dtype=np.float64)
    y_vec = np.cross(up_vec, front_vec)
    std2mesh = np.stack([front_vec, y_vec, up_vec], axis=0).T
    mesh2std = np.linalg.inv(std2mesh)
    return rescale_factor, None, mesh2std


def generate_view(pipe, ref_img, skel_img, prompt, neg_prompt,
                  ip_scale, cn_scale, use_controlnet,
                  steps, guidance, seed, size=1024):
    import torch
    pipe.set_ip_adapter_scale(ip_scale)
    gen = torch.Generator('cuda').manual_seed(int(seed))
    if use_controlnet:
        img = pipe(
            prompt=prompt, negative_prompt=neg_prompt,
            image=skel_img,
            controlnet_conditioning_scale=cn_scale,
            ip_adapter_image=ref_img,
            num_inference_steps=steps, guidance_scale=guidance,
            height=size, width=size,
            generator=gen,
        ).images[0]
    else:
        # No ControlNet for top/bot — use a neutral grey frame at 0 weight
        # (pipeline still requires an image arg).
        neutral = Image.new('RGB', (size, size), (0, 0, 0))
        img = pipe(
            prompt=prompt, negative_prompt=neg_prompt,
            image=neutral,
            controlnet_conditioning_scale=0.0,
            ip_adapter_image=ref_img,
            num_inference_steps=steps, guidance_scale=guidance,
            height=size, width=size,
            generator=gen,
        ).images[0]
    return img


def build_views_json(out_dir, mesh_path,
                     cam_distance=1.8, L=-0.55, R=0.55, B=-0.55, T=0.55):
    """Write views.json with the same contract as mvadapter_runner.py
    so texture_project's ortho path works unchanged."""
    rescale_factor, offset, mesh2std = load_mesh_transforms(mesh_path)
    proj = get_ortho_proj(L, R, B, T)
    views = []
    for i, (logical_azim, elev, *_rest) in enumerate(VIEW_SPECS):
        mva_azim = logical_azim - 90
        c2w = get_c2w(mva_azim, elev, cam_distance)
        w2c = np.linalg.inv(c2w)
        views.append({
            'azim': float(logical_azim),
            'elev': float(elev),
            'w2c': w2c.tolist(),
            'proj_mtx': proj.tolist(),
        })
    schema = {
        'engine': 'fabmesh_realvis',
        'projection': 'orthographic',
        'cam_distance': cam_distance,
        'cam_bounds': [L, R, B, T],
        'mesh_rescale_factor': rescale_factor,
        'mesh_offset': offset,
        'mesh2std': mesh2std.tolist(),
        'views': views,
    }
    out = os.path.join(out_dir, 'views.json')
    with open(out, 'w') as f:
        json.dump(schema, f, indent=2)
    log(f'views.json written: {out}')


def make_grid(images, rows=1):
    w, h = images[0].size
    cols = len(images) // rows
    grid = Image.new('RGB', (w * cols, h * rows))
    for idx, img in enumerate(images):
        r = idx // cols
        c = idx % cols
        grid.paste(img, (c * w, r * h))
    return grid


def run(mesh_path, front_image, out_dir,
        num_steps=30, guidance=7.0, seed=42, size=1024,
        reuse_front=None, reuse_back=None,
        only_front_back=False):
    os.makedirs(out_dir, exist_ok=True)
    mesh_path = os.path.abspath(mesh_path)
    front_image = os.path.abspath(front_image)
    log(f'mesh={mesh_path}')
    log(f'front={front_image}')
    log(f'out={out_dir}')

    # Build the 6 camera w2c/proj first (we need them for skeletons
    # AND for views.json).
    proj = get_ortho_proj(-0.55, 0.55, -0.55, 0.55)
    cams = []
    for logical_azim, elev, *_rest in VIEW_SPECS:
        mva_azim = logical_azim - 90
        c2w = get_c2w(mva_azim, elev, 1.8)
        w2c = np.linalg.inv(c2w)
        cams.append((w2c, proj))

    # Reference image (identity anchor)
    ref_img = preprocess_ref(Image.open(front_image), size=size)

    # Lazy-load pipeline only if we actually need diffusion
    need_pipeline = not (reuse_front and reuse_back
                         and all(os.path.exists(reuse_front) and
                                 os.path.exists(reuse_back)
                                 for _ in [0]))
    # Simpler logic: we always need pipeline for at least some views
    # (right/left/top/bot). Even if reuse-front and reuse-back are
    # given, 4 views remain.
    pipe = load_pipeline()

    # Hybrid mode: only generate front + back. Return an incomplete
    # views list where only indices 0 and 2 are filled. Caller
    # (mv_bake_hunyuan.py hybrid) will fill the other slots from
    # MVAdapter's output.
    indices_to_generate = (
        [0, 2] if only_front_back else list(range(len(VIEW_SPECS))))

    images = [None] * len(VIEW_SPECS)
    for i in indices_to_generate:
        logical_azim, elev, sfx, ip, cn, use_cn = VIEW_SPECS[i]
        t0 = time.time()
        w2c, _proj = cams[i]
        # Skip-if-reuse shortcuts
        if i == 0 and reuse_front and os.path.exists(reuse_front):
            log(f'view_0: reuse-front {reuse_front}')
            img = Image.open(reuse_front).convert('RGB').resize((size, size),
                                                                 Image.LANCZOS)
            images[0] = img
            continue
        if i == 2 and reuse_back and os.path.exists(reuse_back):
            log(f'view_2: reuse-back {reuse_back}')
            img = Image.open(reuse_back).convert('RGB').resize((size, size),
                                                                Image.LANCZOS)
            images[2] = img
            continue

        # Skeleton for ControlNet — always try, even for top/bot
        # (degenerate but better than no structural hint).
        if use_cn:
            skel = render_skeleton_for_camera(w2c, proj, size=size,
                                              draw_invisible=True)
        else:
            skel = None

        # Prompt
        prompt = (
            f'realistic photorealistic 3D character, {sfx}, full body, '
            f'plain grey background, studio lighting, sharp focus, '
            f'ultra detailed, 8k, masterpiece'
        )
        # Pick negative prompt per view type
        if logical_azim == 180:
            neg = NEGATIVE_BACK
        elif logical_azim in (90, 270):
            neg = NEGATIVE_SIDE
        elif abs(elev) > 45:
            neg = NEGATIVE_TOP
        else:
            neg = NEGATIVE_BASE

        log(f'view_{i} ({sfx[:40]}...) ip={ip} cn={cn} cn_on={use_cn}')
        img = generate_view(
            pipe, ref_img, skel, prompt, neg,
            ip_scale=ip, cn_scale=cn, use_controlnet=use_cn,
            steps=num_steps, guidance=guidance,
            seed=seed, size=size,
        )
        images[i] = img
        log(f'view_{i} done in {time.time()-t0:.1f}s')

    # Save only the ones we generated (don't overwrite other slots'
    # files — e.g. in hybrid mode MVAdapter wrote them first).
    for i in indices_to_generate:
        if images[i] is not None:
            images[i].save(os.path.join(out_dir, f'view_{i}.png'))
    if not only_front_back:
        make_grid(images, rows=1).save(
            os.path.join(out_dir, '_voiec_grid.png'))
    # Save skeletons for debug
    dbg = os.path.join(out_dir, '_skeletons')
    os.makedirs(dbg, exist_ok=True)
    for i, (w2c, _proj) in enumerate(cams):
        use_cn = VIEW_SPECS[i][5]
        if use_cn:
            render_skeleton_for_camera(
                w2c, proj, size=size, draw_invisible=True).save(
                    os.path.join(dbg, f'skel_{i}.png'))

    # views.json: only write/overwrite in full mode. In hybrid mode,
    # MVAdapter has already written the canonical schema.
    if not only_front_back:
        build_views_json(out_dir, mesh_path)
    log('DONE')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('mesh')
    p.add_argument('front')
    p.add_argument('out_dir')
    p.add_argument('num_steps', type=int, nargs='?', default=30)
    p.add_argument('seed', type=int, nargs='?', default=42)
    p.add_argument('--reuse-front', default=None)
    p.add_argument('--reuse-back', default=None)
    p.add_argument('--only-front-back', action='store_true',
                   help='Hybrid mode: only regenerate view_0 and view_2, '
                        'leave other slots untouched.')
    args = p.parse_args()
    run(args.mesh, args.front, args.out_dir,
        num_steps=args.num_steps, seed=args.seed,
        reuse_front=args.reuse_front, reuse_back=args.reuse_back,
        only_front_back=args.only_front_back)


if __name__ == '__main__':
    main()
