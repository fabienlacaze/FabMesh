"""MVAdapter ig2mv_sdxl wrapper with CPU offload + custom num_views.

Addresses two issues with the stock external/MV-Adapter/scripts/inference_ig2mv_sdxl.py:
  1. num_views hardcoded to 6 via the elevation/azimuth lists.
  2. No CPU offload, so 16GB cards OOM on SDXL + MVAdapter + DINOv2.

This runner loads MVAdapter in-process, calls enable_model_cpu_offload()
and supports --num_views in {4, 6}:
  - 4 = [front, right, back, left]     (elev=0 each, azim=0/90/180/270)
  - 6 = 4 + top + bottom               (matches stock script)

Writes a horizontal grid PNG (same as stock) + individual view_i.png.

Usage:
    python mvadapter_runner.py <mesh.glb> <image.png> <output_dir> [num_views=4] [steps=20]
"""
import sys
import os
import argparse

import numpy as np
import torch
from PIL import Image

# Make mvadapter importable
MVA = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   '..', 'external', 'MV-Adapter')
MVA = os.path.abspath(MVA)
if MVA not in sys.path:
    sys.path.insert(0, MVA)

from diffusers import AutoencoderKL, UNet2DConditionModel
from mvadapter.models.attention_processor import DecoupledMVRowColSelfAttnProcessor2_0
from mvadapter.pipelines.pipeline_mvadapter_i2mv_sdxl import MVAdapterI2MVSDXLPipeline
from mvadapter.schedulers.scheduling_shift_snr import ShiftSNRScheduler
from mvadapter.utils import make_image_grid, tensor_to_image
from mvadapter.utils.mesh_utils import (
    NVDiffRastContextWrapper,
    get_orthogonal_camera,
    load_mesh,
    render,
)


def log(msg):
    print(f'[mva_runner] {msg}', flush=True)


def preprocess_image(image: Image.Image, height, width):
    image = np.array(image)
    alpha = image[..., 3] > 0
    H, W = alpha.shape
    y, x = np.where(alpha)
    y0, y1 = max(y.min() - 1, 0), min(y.max() + 1, H)
    x0, x1 = max(x.min() - 1, 0), min(x.max() + 1, W)
    image_center = image[y0:y1, x0:x1]
    H, W, _ = image_center.shape
    if H > W:
        W_new = int(W * (height * 0.9) / H)
        H_new = int(height * 0.9)
        image_center = np.array(Image.fromarray(image_center).resize((W_new, H_new)))
    else:
        H_new = int(H * (width * 0.9) / W)
        W_new = int(width * 0.9)
        image_center = np.array(Image.fromarray(image_center).resize((W_new, H_new)))
    H, W, _ = image_center.shape
    full = np.zeros((height, width, 4), dtype=np.uint8)
    full[(height - H) // 2:(height - H) // 2 + H,
         (width - W) // 2:(width - W) // 2 + W] = image_center
    bg = np.ones_like(full[..., :3]) * 255
    a = full[..., 3:4] / 255.0
    rgb = (full[..., :3] * a + bg * (1 - a)).astype(np.uint8)
    return Image.fromarray(rgb)


def camera_schema(num_views):
    """Returns (elevation_deg, azimuth_deg_mva) lists for MVAdapter convention.

    MVAdapter uses azimuth offset of -90 (see inference_ig2mv_sdxl.py:147):
        azimuth_deg = [x - 90 for x in logical_azim]
    So logical [0, 90, 180, 270] becomes [-90, 0, 90, 180] here.
    """
    if num_views == 4:
        # front, right, back, left — all equator
        logical_azim = [0, 90, 180, 270]
        elev = [0.0, 0.0, 0.0, 0.0]
    elif num_views == 6:
        # +top, +bottom
        logical_azim = [0, 90, 180, 270, 180, 180]
        elev = [0.0, 0.0, 0.0, 0.0, 89.99, -89.99]
    else:
        raise ValueError(f'num_views must be 4 or 6, got {num_views}')
    azim_mva = [a - 90 for a in logical_azim]
    return elev, azim_mva, logical_azim


def fabmesh_schema(num_views):
    """Views.json schema in FabMesh/SF3D convention (0=front, 90=right, ...)."""
    _, _, logical_azim = camera_schema(num_views)
    if num_views == 4:
        return [
            {'azim': 0.0,   'elev': 0.0},
            {'azim': 90.0,  'elev': 0.0},
            {'azim': 180.0, 'elev': 0.0},
            {'azim': 270.0, 'elev': 0.0},
        ]
    return [
        {'azim': 0.0,   'elev': 0.0},
        {'azim': 90.0,  'elev': 0.0},
        {'azim': 180.0, 'elev': 0.0},
        {'azim': 270.0, 'elev': 0.0},
        {'azim': 0.0,   'elev': 90.0},
        {'azim': 0.0,   'elev': -90.0},
    ]


def run(mesh_path, image_path, out_dir, num_views=4, num_steps=20,
        guidance=3.0, seed=42, height=512, width=512,
        base_model='stabilityai/stable-diffusion-xl-base-1.0',
        vae_model='madebyollin/sdxl-vae-fp16-fix',
        adapter_path='huanngzh/mv-adapter'):
    os.makedirs(out_dir, exist_ok=True)
    device = 'cuda'
    dtype = torch.float16

    # Release any stale CUDA allocations from prior subprocess runs.
    import gc
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.synchronize()
    free_mb = torch.cuda.mem_get_info()[0] // (1024 * 1024)
    log(f'VRAM free at start: {free_mb} MB')
    log(f'loading SDXL + MVAdapter (num_views={num_views})')
    pipe = MVAdapterI2MVSDXLPipeline.from_pretrained(
        base_model,
        vae=AutoencoderKL.from_pretrained(vae_model),
    )
    pipe.scheduler = ShiftSNRScheduler.from_scheduler(
        pipe.scheduler, shift_mode='interpolated', shift_scale=8.0,
    )
    pipe.init_custom_adapter(
        num_views=num_views,
        self_attn_processor=DecoupledMVRowColSelfAttnProcessor2_0,
    )
    pipe.load_custom_adapter(
        adapter_path, weight_name='mvadapter_ig2mv_sdxl.safetensors',
    )
    pipe.to(device=device, dtype=dtype)
    pipe.cond_encoder.to(device=device, dtype=dtype)
    pipe.enable_vae_slicing()
    # Offload strategy (set via FABMESH_MVA_OFFLOAD env):
    #   "none"        -> all on GPU (fastest; needs ~12-14GB VRAM @ 512)
    #   "model"       -> enable_model_cpu_offload (compat with custom hooks)
    #   "sequential"  -> enable_sequential_cpu_offload (BREAKS ref_hidden_states
    #                    dict propagation in MVAdapter)
    _offload = os.environ.get('FABMESH_MVA_OFFLOAD', 'none').lower()
    if _offload == 'sequential':
        try:
            pipe.enable_sequential_cpu_offload()
            log('sequential CPU offload enabled')
        except Exception as e:
            log(f'sequential offload unavailable ({e})')
    elif _offload == 'model':
        try:
            pipe.enable_model_cpu_offload()
            log('model CPU offload enabled')
        except Exception as e:
            log(f'model offload unavailable ({e}), all-on-GPU')
    else:
        log('offload=none (all-on-GPU — ~12-14GB @ 512)')

    # Cameras + mesh render
    elev, azim_mva, _ = camera_schema(num_views)
    cam_distance = 1.8
    cam_L, cam_R, cam_B, cam_T = -0.55, 0.55, -0.55, 0.55
    cameras = get_orthogonal_camera(
        elevation_deg=elev,
        distance=[cam_distance] * num_views,
        left=cam_L, right=cam_R, bottom=cam_B, top=cam_T,
        azimuth_deg=azim_mva,
        device=device,
    )
    ctx = NVDiffRastContextWrapper(device=device)
    # rescale=True normalises the mesh (vertices /= max(|v|) * 0.5) and
    # swaps axes (+Y mesh up -> +Z std up). We MUST pass the same
    # transform info to texture_project so its back-projection lines up.
    mesh_obj = load_mesh(mesh_path, rescale=True, device=device,
                         return_transform=True)
    # load_mesh returns (textured_mesh, offset, scale) when return_transform
    # is True. move_to_center defaults to False so offset may be None.
    if isinstance(mesh_obj, tuple):
        mesh, mesh_offset, mesh_scale = mesh_obj
    else:
        mesh, mesh_offset, mesh_scale = mesh_obj, None, None
    render_out = render(
        ctx, mesh, cameras,
        height=height, width=width,
        render_attr=False, normal_background=0.0,
    )
    control_images = torch.cat([
        (render_out.pos + 0.5).clamp(0, 1),
        (render_out.normal / 2 + 0.5).clamp(0, 1),
    ], dim=-1).permute(0, 3, 1, 2).to(device)

    # Reference image
    ref = Image.open(image_path)
    if ref.mode == 'RGBA':
        ref = preprocess_image(ref, height, width)
    else:
        ref = ref.convert('RGB').resize((width, height))

    log(f'diffusing {num_steps} steps, {num_views} views @ {height}x{width}')
    gen = torch.Generator(device=device).manual_seed(seed)
    images = pipe(
        'high quality',
        height=height, width=width,
        num_inference_steps=num_steps,
        guidance_scale=guidance,
        num_images_per_prompt=num_views,
        control_image=control_images,
        control_conditioning_scale=1.0,
        reference_image=ref,
        reference_conditioning_scale=1.0,
        negative_prompt='watermark, ugly, deformed, noisy, blurry, low contrast',
        cross_attention_kwargs={'scale': 1.0},
        generator=gen,
    ).images

    # Save grid + individual views
    grid_path = os.path.join(out_dir, '_mvadapter_grid.png')
    make_image_grid(images, rows=1).save(grid_path)
    for i, img in enumerate(images):
        img.save(os.path.join(out_dir, f'view_{i}.png'))

    # Write views.json with FULL camera info for alignment-exact back
    # projection. texture_project will use 'projection=orthographic'
    # + w2c + proj_mtx + mesh transforms to recreate the EXACT same
    # pixel->world mapping MVAdapter used.
    import json

    # Extract numpy tensors
    w2c_np = cameras.w2c.detach().cpu().numpy()          # (N, 4, 4)
    proj_mtx_np = cameras.proj_mtx.detach().cpu().numpy()  # (N, 4, 4)

    # mesh2std: load_mesh applies  v_std = mesh2std @ v_mesh  (after
    # centering + rescaling). For defaults up=+y, front=+x:
    #   mesh2std = [[1,0,0], [0,0,1], [0,-1,0]]
    # We compute it dynamically in case defaults change in future.
    up_vec = np.array([0, 1, 0], dtype=np.float32)     # +y
    front_vec = np.array([1, 0, 0], dtype=np.float32)  # +x
    y_vec = np.cross(up_vec, front_vec)
    std2mesh = np.stack([front_vec, y_vec, up_vec], axis=0).T
    mesh2std = np.linalg.inv(std2mesh)

    schema = {
        'engine': 'mvadapter',
        'projection': 'orthographic',
        'cam_distance': float(cam_distance),
        'cam_bounds': [float(cam_L), float(cam_R),
                       float(cam_B), float(cam_T)],
        # Mesh transforms applied by load_mesh(rescale=True)
        'mesh_rescale_factor': float(mesh_scale) if mesh_scale is not None else None,
        'mesh_offset': mesh_offset.tolist() if mesh_offset is not None else None,
        'mesh2std': mesh2std.tolist(),
        'views': [
            {
                **fabmesh_schema(num_views)[i],
                'w2c': w2c_np[i].tolist(),
                'proj_mtx': proj_mtx_np[i].tolist(),
            }
            for i in range(num_views)
        ],
    }
    with open(os.path.join(out_dir, 'views.json'), 'w') as f:
        json.dump(schema, f, indent=2)
    log(f'wrote {num_views} views + views.json to {out_dir}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mesh')
    parser.add_argument('image')
    parser.add_argument('out_dir')
    parser.add_argument('num_views', type=int, nargs='?', default=4)
    parser.add_argument('num_steps', type=int, nargs='?', default=20)
    args = parser.parse_args()
    run(os.path.abspath(args.mesh),
        os.path.abspath(args.image),
        os.path.abspath(args.out_dir),
        num_views=args.num_views,
        num_steps=args.num_steps)


if __name__ == '__main__':
    main()
