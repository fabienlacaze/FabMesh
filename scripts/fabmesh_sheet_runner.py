"""Voie E — single-call multi-view sheet generation.

Generates the 6 views (front/right/back/left/top/bottom) in ONE
RealVis XL pass on a 1536×1024 canvas (3×2 grid of 512×512 cells).
Each cell is conditioned by a ControlNet OpenPose skeleton specific
to its angle, projected from the same orthographic cameras used for
the bake.

Why a sheet:
  - SDXL renders the whole sheet in ONE latent → cohérence native
    de couleurs / lighting / identity (pas de drift entre vues).
  - Plus de MVAdapter (donc plus de nvdiffrast non-commercial).
  - 1 pipe() call ~30s vs 6× ~90s en séquentiel.

Output contract identical to mvadapter_runner / fabmesh_6views_runner:
  view_0..5.png + views.json (orthographic, mesh transforms).

Limitations:
  - SDXL not natively trained on character sheets → CN OpenPose strict
    is mandatory for layout discipline.
  - Lateral views (right/left/top/bot) still constrained by SDXL's
    frontal training bias, but the global attention helps coherence
    even if profiles aren't perfect.

License: RealVis XL (RAIL++-M), IPAdapter (Apache 2.0), ControlNet
OpenPose (Apache 2.0). 100% commercial-safe.

Usage:
    python fabmesh_sheet_runner.py <mesh.glb> <front.png> <out_dir>
        [num_steps=30] [seed=42]
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
    print(f'[sheet] {msg}', flush=True)


CELL = 512
COLS = 3
ROWS = 2
SHEET_W = COLS * CELL  # 1536
SHEET_H = ROWS * CELL  # 1024

# Each cell holds the view for one of the 6 angles.
# Layout matches the 3×2 visual grid:
#   row 0: front  | right | back
#   row 1: left   | top   | bottom
# Indices follow FabMesh convention (view_0=front, view_1=right, etc.).
CELL_LAYOUT = [
    # (col, row, logical_azim, elev, label)
    (0, 0, 0,    0,      'front'),
    (1, 0, 90,   0,      'right'),
    (2, 0, 180,  0,      'back'),
    (0, 1, 270,  0,      'left'),
    (1, 1, 0,    89.99,  'top'),
    (2, 1, 0,    -89.99, 'bottom'),
]


def get_c2w(azim_mva_deg, elev_deg, distance):
    """Reproduce mvadapter's get_c2w (Z-up, +X forward at azim=0)."""
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


def get_ortho_proj(L, R, B, T, near=0.1, far=100.0):
    m = np.zeros((4, 4))
    m[0, 0] = 2 / (R - L)
    m[1, 1] = -2 / (T - B)
    m[2, 2] = -2 / (far - near)
    m[0, 3] = -(R + L) / (R - L)
    m[1, 3] = -(T + B) / (T - B)
    m[2, 3] = -(far + near) / (far - near)
    m[3, 3] = 1.0
    return m


def build_skeleton_sheet():
    """Render all 6 OpenPose skeletons into a 1536×1024 sheet (3×2)."""
    sheet = Image.new('RGB', (SHEET_W, SHEET_H), (0, 0, 0))
    proj = get_ortho_proj(-0.55, 0.55, -0.55, 0.55)
    for col, row, logical_azim, elev, label in CELL_LAYOUT:
        mva_azim = logical_azim - 90  # MVAdapter convention
        c2w = get_c2w(mva_azim, elev, 1.8)
        w2c = np.linalg.inv(c2w)
        skel = render_skeleton_for_camera(
            w2c, proj, size=CELL,
            limb_width=6, joint_radius=5,
            draw_invisible=True)
        sheet.paste(skel, (col * CELL, row * CELL))
    return sheet


def build_views_json(out_dir, mesh_path,
                     cam_distance=1.8, L=-0.55, R=0.55, B=-0.55, T=0.55):
    """Same schema as mvadapter_runner so texture_project's ortho path
    consumes it identically."""
    import trimesh
    scene = trimesh.load(mesh_path, force='mesh', process=False)
    if isinstance(scene, trimesh.Scene):
        mesh = trimesh.util.concatenate(list(scene.geometry.values()))
    else:
        mesh = scene
    verts = np.asarray(mesh.vertices, dtype=np.float64)
    rescale_factor = float(np.abs(verts).max()) / 0.5
    up_vec = np.array([0, 1, 0], dtype=np.float64)
    front_vec = np.array([1, 0, 0], dtype=np.float64)
    y_vec = np.cross(up_vec, front_vec)
    std2mesh = np.stack([front_vec, y_vec, up_vec], axis=0).T
    mesh2std = np.linalg.inv(std2mesh)
    proj = get_ortho_proj(L, R, B, T)
    views = []
    for _, _, logical_azim, elev, _ in CELL_LAYOUT:
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
        'engine': 'fabmesh_sheet',
        'projection': 'orthographic',
        'cam_distance': cam_distance,
        'cam_bounds': [L, R, B, T],
        'mesh_rescale_factor': rescale_factor,
        'mesh_offset': None,
        'mesh2std': mesh2std.tolist(),
        'views': views,
    }
    with open(os.path.join(out_dir, 'views.json'), 'w') as f:
        json.dump(schema, f, indent=2)


def load_pipeline():
    from diffusers import (
        ControlNetModel,
        StableDiffusionXLControlNetInpaintPipeline,
    )
    from transformers import CLIPVisionModelWithProjection
    log('loading SDXL ControlNet INPAINT OpenPose + IPAdapter')
    image_encoder = CLIPVisionModelWithProjection.from_pretrained(
        'h94/IP-Adapter', subfolder='models/image_encoder',
        torch_dtype=torch.float16)
    controlnet = ControlNetModel.from_pretrained(
        'xinsir/controlnet-openpose-sdxl-1.0', torch_dtype=torch.float16)
    # Use the Inpaint variant of the CN pipeline so we can lock the
    # front photo as cell 0 and only inpaint the 5 other cells.
    pipe = StableDiffusionXLControlNetInpaintPipeline.from_pretrained(
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


def preprocess_ref(image: Image.Image, size=1024):
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


SHEET_PROMPT = (
    'character sheet of the same person, T-pose, six orthographic views '
    'arranged as a 3x2 grid: top row shows front view, right side profile, '
    'back view; bottom row shows left side profile, top-down view, '
    'bottom-up view. Same outfit, same hair, same identity in every cell. '
    'Plain neutral grey background, even studio lighting, sharp focus, '
    'photorealistic, 8k, masterpiece'
)
SHEET_NEG = (
    'blurry, deformed, inconsistent outfit, inconsistent hair, different '
    'people, watermark, text, label, frame, border, panel divider, '
    'low quality, cropped, missing limbs'
)


def run(mesh_path, front_image, out_dir,
        num_steps=30, guidance=7.0, seed=42,
        cn_scale=1.20, ip_scale=0.55):
    os.makedirs(out_dir, exist_ok=True)
    mesh_path = os.path.abspath(mesh_path)
    front_image = os.path.abspath(front_image)
    log(f'mesh={mesh_path}')
    log(f'front={front_image}')
    log(f'out={out_dir}')

    import gc
    gc.collect()
    torch.cuda.empty_cache()
    free_mb = torch.cuda.mem_get_info()[0] // (1024 * 1024)
    log(f'VRAM free at start: {free_mb} MB')

    skel_sheet = build_skeleton_sheet()
    skel_sheet.save(os.path.join(out_dir, '_skeleton_sheet.png'))
    log(f'skeleton sheet built: {SHEET_W}x{SHEET_H}')

    ref_img = preprocess_ref(Image.open(front_image), size=1024)
    ref_img.save(os.path.join(out_dir, '_reference.png'))

    # Build init sheet: cell 0 (front, top-left) = the front photo
    # rescaled to CELL×CELL. Other 5 cells = neutral grey (will be
    # inpainted from the skeleton + IPA reference).
    init_sheet = Image.new('RGB', (SHEET_W, SHEET_H), (160, 160, 160))
    front_cell = ref_img.resize((CELL, CELL), Image.LANCZOS)
    init_sheet.paste(front_cell, (0, 0))
    init_sheet.save(os.path.join(out_dir, '_init_sheet.png'))

    # Build mask: 0 = keep (front cell), 255 = inpaint (5 other cells).
    # 8px border around the front cell stays at 0 too, so the model
    # has a clean "anchor" to reference from.
    mask = Image.new('L', (SHEET_W, SHEET_H), 255)
    from PIL import ImageDraw
    md = ImageDraw.Draw(mask)
    md.rectangle([0, 0, CELL - 1, CELL - 1], fill=0)
    mask.save(os.path.join(out_dir, '_inpaint_mask.png'))

    pipe = load_pipeline()
    pipe.set_ip_adapter_scale(ip_scale)

    log(f'diffusing 1 INPAINT sheet @ {SHEET_W}x{SHEET_H}, '
        f'steps={num_steps} cn={cn_scale} ip={ip_scale}')
    log(f'cell 0 LOCKED to front photo, cells 1-5 inpainted')
    t0 = time.time()
    gen = torch.Generator('cuda').manual_seed(int(seed))
    sheet = pipe(
        prompt=SHEET_PROMPT,
        negative_prompt=SHEET_NEG,
        image=init_sheet,
        mask_image=mask,
        control_image=skel_sheet,
        controlnet_conditioning_scale=cn_scale,
        ip_adapter_image=ref_img,
        strength=0.99,                # high — fill the masked area
        num_inference_steps=num_steps,
        guidance_scale=guidance,
        height=SHEET_H, width=SHEET_W,
        generator=gen,
    ).images[0]
    log(f'sheet inpaint done in {time.time()-t0:.1f}s')

    sheet.save(os.path.join(out_dir, '_sheet_raw.png'))

    # Crop into 6 view_*.png cells.
    for col, row, _, _, label in CELL_LAYOUT:
        cell = sheet.crop((col * CELL, row * CELL,
                           (col + 1) * CELL, (row + 1) * CELL))
        # Map cell to view index
        idx = next(i for i, t in enumerate(CELL_LAYOUT)
                   if t[0] == col and t[1] == row)
        cell.save(os.path.join(out_dir, f'view_{idx}.png'))

    build_views_json(out_dir, mesh_path)
    log('DONE')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('mesh')
    p.add_argument('front')
    p.add_argument('out_dir')
    p.add_argument('num_steps', type=int, nargs='?', default=30)
    p.add_argument('seed', type=int, nargs='?', default=42)
    p.add_argument('--cn-scale', type=float, default=1.20)
    p.add_argument('--ip-scale', type=float, default=0.55)
    args = p.parse_args()
    run(os.path.abspath(args.mesh),
        os.path.abspath(args.front),
        os.path.abspath(args.out_dir),
        num_steps=args.num_steps, seed=args.seed,
        cn_scale=args.cn_scale, ip_scale=args.ip_scale)


if __name__ == '__main__':
    main()
