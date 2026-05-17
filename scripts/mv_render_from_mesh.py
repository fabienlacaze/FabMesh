"""FabMesh — render 6 strict orthogonal views of an untextured mesh.

Used as the "structure" reference for SDXL img2img refinement: the mesh
provides EXACT silhouette + normal-based shading at any chosen camera
angle, so we never depend on a single-image multiview model
hallucinating the back/sides of the subject.

Outputs:
    <out_dir>/view_0.png .. view_5.png     (1024² RGBA shaded mesh)
    <out_dir>/normal_0.png .. normal_5.png (1024² RGB world-space normal)
    <out_dir>/depth_0.png .. depth_5.png   (1024² grayscale depth)
    <out_dir>/views.json                   (azim/elev per slot)

Camera convention matches hi3dgen_invuv_bake_v3.py:
    azim=0   → camera at -Z (front of Hi3DGen mesh)
    azim=90  → +X (right)
    azim=180 → +Z (back)
    azim=270 → -X (left)
    elev=+90 → top-down
    elev=-90 → bottom-up

Usage:
    python mv_render_from_mesh.py <mesh.glb> <out_dir>
        [--res 1024]
        [--light-azim 30] [--light-elev 30]
        [--base-rgb 200,40,40]
"""
from __future__ import annotations
import os
import sys
import json
import math
import argparse
import numpy as np
from PIL import Image
import torch
import trimesh
import nvdiffrast.torch as dr


VIEW_SLOTS = [
    (  0.0,   0.0, 'front'),
    ( 90.0,   0.0, 'right'),
    (180.0,   0.0, 'back'),
    (270.0,   0.0, 'left'),
    (  0.0,  89.99, 'top'),
    (  0.0, -89.99, 'bottom'),
]


def log(msg):
    print(f'[mv_render] {msg}', flush=True)


def _camera_matrix(azim_deg, elev_deg, radius=1.5):
    az = math.radians(azim_deg)
    el = math.radians(elev_deg)
    cx = radius * math.cos(el) * math.sin(az)
    cy = radius * math.sin(el)
    cz = -radius * math.cos(el) * math.cos(az)
    eye = np.array([cx, cy, cz], dtype=np.float32)
    tgt = np.zeros(3, dtype=np.float32)
    up = np.array([0, 1, 0], dtype=np.float32)
    if abs(elev_deg) > 89.0:
        up = np.array([0, 0, -1], dtype=np.float32)
    f = tgt - eye
    f /= np.linalg.norm(f) + 1e-12
    s = np.cross(f, up)
    s /= np.linalg.norm(s) + 1e-12
    u = np.cross(s, f)
    view = np.eye(4, dtype=np.float32)
    view[0, :3] = s
    view[1, :3] = u
    view[2, :3] = -f
    view[:3, 3] = -view[:3, :3] @ eye
    return view, eye


def _proj_matrix(fov_deg=50.0, aspect=1.0, near=0.1, far=100.0):
    f = 1.0 / math.tan(math.radians(fov_deg) / 2)
    proj = np.zeros((4, 4), dtype=np.float32)
    proj[0, 0] = f / aspect
    proj[1, 1] = f
    proj[2, 2] = (far + near) / (near - far)
    proj[2, 3] = (2 * far * near) / (near - far)
    proj[3, 2] = -1
    return proj


def _normalize_mesh(verts):
    c = (verts.max(0) + verts.min(0)) / 2
    s = (verts - c).max() * 2
    return (verts - c) / s, c, s


def _render_mesh(glctx, v_pos, faces, v_normals, azim, elev,
                 res, light_dir, base_rgb, radius=1.5):
    """Render the mesh with Lambertian + ambient shading at one angle.
    Returns (shaded RGBA, normal RGB, depth GS) — all 8-bit numpy arrays."""
    H = W = res
    view, eye = _camera_matrix(azim, elev, radius=radius)
    proj = _proj_matrix(aspect=W/H)
    mvp = proj @ view
    mvp_t = torch.from_numpy(mvp).cuda()

    v_h = torch.cat([v_pos, torch.ones_like(v_pos[:, :1])], dim=1)
    v_clip = v_h @ mvp_t.T
    rast, _ = dr.rasterize(glctx, v_clip[None], faces, (H, W))
    mask = (rast[0, ..., 3] > 0).float()

    # Normal interpolation (world-space).
    n_out, _ = dr.interpolate(v_normals[None], rast, faces)
    n_out = torch.nn.functional.normalize(n_out[0], dim=2)
    # Lambertian wrap (half-shading): smoother on round bodies.
    L = torch.from_numpy(light_dir).float().cuda()
    L = L / (L.norm() + 1e-12)
    diff = (n_out @ L).clamp(min=0.0)
    # Wrap-light: 0.4 ambient + 0.6 diffuse
    light_amount = 0.4 + 0.6 * diff
    base = torch.tensor(base_rgb, dtype=torch.float32).cuda() / 255.0
    rgb = base[None, None, :] * light_amount[..., None]
    rgb = rgb.clamp(0, 1)
    # Mask out background → white (SDXL works best on white-bg subject crops).
    bg = torch.ones_like(rgb)
    out_rgb = rgb * mask[..., None] + bg * (1 - mask[..., None])
    out_rgba = torch.cat([out_rgb, mask[..., None]], dim=-1)
    out_rgba_np = (out_rgba.cpu().numpy() * 255).clip(0, 255).astype(np.uint8)

    normal_vis = (n_out * 0.5 + 0.5).clamp(0, 1)
    normal_vis = normal_vis * mask[..., None] + (1 - mask[..., None]) * 0.5
    normal_np = (normal_vis.cpu().numpy() * 255).clip(0, 255).astype(np.uint8)

    depth = -v_clip[..., 2] / v_clip[..., 3]  # NDC depth
    # Already in NDC after rast — interpolate via barycentric on z.
    z_attr = v_clip[..., 2:3] / (v_clip[..., 3:4] + 1e-9)
    z_int, _ = dr.interpolate(z_attr.detach(), rast, faces)
    z_int = z_int[0, ..., 0]
    z_int = z_int * mask + (1 - mask) * 1.0
    # Normalise to 0-1 within mask.
    if mask.sum() > 0:
        zmin = z_int[mask > 0].min().item()
        zmax = z_int[mask > 0].max().item()
        if zmax - zmin > 1e-6:
            z_norm = (z_int - zmin) / (zmax - zmin)
        else:
            z_norm = z_int
    else:
        z_norm = z_int
    depth_np = ((1.0 - z_norm.cpu().numpy()) * 255).clip(0, 255).astype(np.uint8)
    depth_np = depth_np * mask.cpu().numpy().astype(np.uint8)

    return out_rgba_np, normal_np, depth_np


def render(mesh_path, out_dir, res=1024, light_azim=30.0, light_elev=30.0,
           base_rgb=(200, 40, 40)):
    os.makedirs(out_dir, exist_ok=True)
    log(f'mesh:    {mesh_path}')
    log(f'out_dir: {out_dir}')
    log(f'res:     {res}')

    m = trimesh.load(mesh_path, force='mesh', process=False)
    if isinstance(m, trimesh.Scene):
        m = list(m.geometry.values())[0]
    log(f'mesh:    {len(m.vertices)} verts / {len(m.faces)} faces')

    v_norm, _, _ = _normalize_mesh(np.asarray(m.vertices, dtype=np.float32))
    v_pos = torch.from_numpy(v_norm).cuda()
    faces = torch.from_numpy(np.asarray(m.faces, dtype=np.int32)).cuda()
    m_tmp = trimesh.Trimesh(vertices=v_norm, faces=np.asarray(m.faces),
                            process=False)
    vn = np.asarray(m_tmp.vertex_normals, dtype=np.float32)
    v_normals = torch.from_numpy(vn).cuda()

    glctx = dr.RasterizeCudaContext()

    # Light direction (world space) — frontal-3/4 default to match the
    # source photo's lighting bias.
    la = math.radians(light_azim)
    le = math.radians(light_elev)
    light_dir = np.array([
        math.cos(le) * math.sin(la),
        math.sin(le),
        math.cos(le) * math.cos(la),
    ], dtype=np.float32)

    schema = []
    for i, (azim, elev, label) in enumerate(VIEW_SLOTS):
        rgba, normal, depth = _render_mesh(
            glctx, v_pos, faces, v_normals, azim, elev,
            res, light_dir, base_rgb)
        Image.fromarray(rgba).save(os.path.join(out_dir, f'view_{i}.png'))
        Image.fromarray(normal).save(os.path.join(out_dir, f'normal_{i}.png'))
        Image.fromarray(depth).save(os.path.join(out_dir, f'depth_{i}.png'))
        log(f'  view_{i} {label:<7} az={azim:+04.0f} el={elev:+04.0f}')
        schema.append({
            'slot': i,
            'file': f'view_{i}.png',
            'azim': float(azim),
            'elev': float(elev),
            'label': label,
        })

    with open(os.path.join(out_dir, 'views.json'), 'w', encoding='utf-8') as f:
        json.dump({
            'engine': 'mesh-render',
            'convention': 'fabmesh-strict-ortho-6',
            'note': 'Rendered directly from Hi3DGen mesh — EXACT angles, '
                    'no diffusion hallucination.',
            'views': schema,
        }, f, indent=2)

    log(f'DONE: 6 views saved to {out_dir}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('mesh')
    ap.add_argument('out_dir')
    ap.add_argument('--res', type=int, default=1024)
    ap.add_argument('--light-azim', type=float, default=30.0)
    ap.add_argument('--light-elev', type=float, default=30.0)
    ap.add_argument('--base-rgb', default='200,40,40',
                    help='Base material colour as R,G,B (0-255). Default red.')
    args = ap.parse_args()
    base = tuple(int(x) for x in args.base_rgb.split(','))
    render(args.mesh, args.out_dir, res=args.res,
           light_azim=args.light_azim, light_elev=args.light_elev,
           base_rgb=base)


if __name__ == '__main__':
    main()
