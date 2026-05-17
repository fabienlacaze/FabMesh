"""FabMesh inv-UV bake v3 — clean Hi3DGen pipeline (no Paint3D, no MVPaint).

Inline nvdiffrast pipeline that:
  1. Loads a Hi3DGen mesh (Y-up, front=-Z, with xatlas UVs already baked).
  2. For each of 6 CRM-convention views (front/right/back/left/top/bottom)
     renders an inv-UV map at the matching camera angle.
  3. Projects the corresponding source photo into the UV atlas via the
     inv-UV mapping.
  4. Weighted blend across views by abs(normal · view_dir) so grazing
     pixels contribute less than head-on ones.
  5. Hole fill: ONLY for pixels inside the atlas-used region (those that
     have at least one face mapping to them in the rasterised mask).
     Outside that region, leave black — those texels are never sampled.
  6. Export final GLB.

Conventions:
  - Camera : pinhole at orbit radius `r`, fov 50°, looking at origin.
  - Azim   : 0=+Z (front), 90=+X (right), 180=-Z (back), 270=-X (left).
  - Elev   : 0=horizontal, +90=top-down, -90=bottom-up.
  - Mesh   : Y-up, front=-Z (Hi3DGen convention). NO pre-rotation needed.

Usage:
    python hi3dgen_invuv_bake_v3.py <mesh.glb> <source_image> <out.glb>
        --mv-dir <multiview_dir>            (6 photos at CRM angles)
        [--atlas-res 2048] [--render-res 1024]
"""
from __future__ import annotations
import os
import sys
import time
import json
import math
import argparse
import numpy as np
from PIL import Image
import torch
import trimesh

import nvdiffrast.torch as dr


# CRM 6-view convention. azim=0 looks at the mesh's front (which sits at -Z
# in Hi3DGen convention). Camera at azim=0 elev=0 is at +Z looking toward -Z.
DEFAULT_ANGLES = [
    (0.0, 0.0),     # 0 front
    (90.0, 0.0),    # 1 right
    (180.0, 0.0),   # 2 back
    (270.0, 0.0),   # 3 left
    (0.0, 89.99),   # 4 top
    (0.0, -89.99),  # 5 bottom
]


def log(msg):
    print(f'[invuv_v3] {msg}', flush=True)


def _camera_matrix(azim_deg, elev_deg, radius=1.5, target=(0, 0, 0)):
    """Right-handed view + perspective matrices, CRM convention.
    Hi3DGen mesh has its front face at -Z. CRM azim=0 means the camera
    is looking at the subject's front — so it is positioned at -Z,
    looking toward +Z.
      azim=  0 → camera at (0,0,-r) → sees front of car
      azim= 90 → camera at (+r,0,0) → sees right of car
      azim=180 → camera at (0,0,+r) → sees back of car
      azim=270 → camera at (-r,0,0) → sees left of car
      elev=+90 → camera at (0,+r,0) → top-down
    Top/bottom up-vector chosen so the car's front sits at image TOP."""
    az = math.radians(azim_deg)
    el = math.radians(elev_deg)
    cx = radius * math.cos(el) * math.sin(az)
    cy = radius * math.sin(el)
    cz = -radius * math.cos(el) * math.cos(az)
    eye = np.array([cx, cy, cz], dtype=np.float32)
    tgt = np.array(target, dtype=np.float32)
    up = np.array([0, 1, 0], dtype=np.float32)
    if abs(elev_deg) > 89.0:
        # At poles up=±Y is degenerate. Use -Z so the front (-Z) of the
        # car maps to image-up (top of the top-down photo).
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
    """Center and scale verts to unit bound for stable rendering."""
    c = (verts.max(0) + verts.min(0)) / 2
    s = (verts - c).max() * 2
    return (verts - c) / s, c, s


def _render_inv_uv(glctx, v_pos, v_uv, faces, faces_uv, v_normals,
                   azim, elev, res, radius=1.5):
    """Returns (inv_uv [H,W,2], mask [H,W], normal_view_dot [H,W]).

    inv_uv stores per-pixel (u, v) atlas coords from the rasterised mesh.
    mask is 1 where a face was hit, 0 elsewhere.
    normal_view_dot is |normal · view_dir| in [0,1] for weighted blending."""
    H = W = res
    view, eye = _camera_matrix(azim, elev, radius=radius)
    proj = _proj_matrix(aspect=W/H)
    mvp = proj @ view
    mvp_t = torch.from_numpy(mvp).cuda()

    # Clip-space positions for rasterisation.
    v_h = torch.cat([v_pos, torch.ones_like(v_pos[:, :1])], dim=1)
    v_clip = v_h @ mvp_t.T
    rast, _ = dr.rasterize(glctx, v_clip[None], faces, (H, W))

    # Interpolate UVs.
    uv_out, _ = dr.interpolate(v_uv[None], rast, faces_uv)
    uv_out = uv_out[0]  # (H, W, 2)
    mask = (rast[0, ..., 3] > 0).float()  # (H, W) 1 where face hit

    # Compute view direction per pixel and interpolate normals for blend weight.
    # World-space normal interpolation.
    n_out, _ = dr.interpolate(v_normals[None], rast, faces)
    n_out = n_out[0]  # (H, W, 3)
    n_out = torch.nn.functional.normalize(n_out, dim=2)
    # View direction from camera to each pixel — approximate via inverse MVP.
    # For weighting we just need cos(angle between normal and view), which is
    # ~ |dot(normal, view_from_pixel)|. Easier: use camera forward in world.
    cam_fwd = torch.from_numpy(-eye / (np.linalg.norm(eye) + 1e-12)).float().cuda()
    cos_nv = (n_out @ cam_fwd).abs()  # (H, W) in [0, 1]
    cos_nv = cos_nv * mask
    return uv_out, mask, cos_nv


def _project_view_to_atlas(view_rgb, uv_out, mask_pix, cos_nv,
                            atlas_acc, weight_acc, atlas_res):
    """Splat one rendered view into the atlas weighted by cos_nv.

    view_rgb     : (H, W, 3) float32 in [0, 255], rendered/source view image
    uv_out       : (H, W, 2) atlas UV coords from inv-UV render
    mask_pix     : (H, W) face-hit mask
    cos_nv       : (H, W) normal·view dot weight
    atlas_acc    : (R, R, 3) float64 running sum
    weight_acc   : (R, R) float64 running weight sum
    """
    valid = (mask_pix > 0)
    if view_rgb.shape[-1] == 4:
        # Discard background pixels (alpha < 0.25 — generous to keep edges).
        valid = valid & (torch.from_numpy(view_rgb[..., 3] > 64).cuda())
    if not valid.any():
        return 0
    uv_v = uv_out[valid]  # (N, 2)
    cos_v = cos_nv[valid]  # (N,)
    rgb_v = torch.from_numpy(view_rgb[..., :3]).cuda()
    rgb_v = rgb_v[valid]  # (N, 3)
    # Atlas pixel coords. UV convention: v=0 at bottom in OpenGL, image
    # convention v=0 at top. Flip v so atlas image is upright.
    u_pix = torch.clamp((uv_v[:, 0] * (atlas_res - 1)).long(), 0, atlas_res - 1)
    v_pix = torch.clamp(((1.0 - uv_v[:, 1]) * (atlas_res - 1)).long(),
                        0, atlas_res - 1)
    flat = v_pix * atlas_res + u_pix  # (N,)
    # Weighted accumulate via scatter_add.
    rgb_w = rgb_v * cos_v[:, None]  # (N, 3)
    atlas_acc_flat = atlas_acc.view(-1, 3)
    weight_acc_flat = weight_acc.view(-1)
    atlas_acc_flat.scatter_add_(0, flat[:, None].expand(-1, 3), rgb_w.double())
    weight_acc_flat.scatter_add_(0, flat, cos_v.double())
    return int(valid.sum().item())


def _atlas_used_mask(glctx, v_uv, faces_uv, atlas_res):
    """Rasterise UV-space → atlas coverage mask. 1 where any face occupies
    that texel (so we know which texels need filling vs being left as 0)."""
    # UV in clip-space: [u,v]→[2u-1, 2v-1, 0, 1]
    uv = v_uv * 2.0 - 1.0
    uv4 = torch.cat([uv, torch.zeros_like(uv[:, :1]),
                     torch.ones_like(uv[:, :1])], dim=1)
    rast, _ = dr.rasterize(glctx, uv4[None], faces_uv,
                           (atlas_res, atlas_res))
    used = (rast[0, ..., 3] > 0).cpu().numpy().astype(bool)
    # Flip vertically to match texture orientation (image top=v=1).
    return used[::-1, :]


def _atlas_chart_id_map(used_mask):
    """Label each connected component of used texels with a unique chart id.
    Used by chart-aware NN fill so holes are only filled from texels of the
    SAME chart, not from arbitrary nearby charts whose colours come from
    different mesh regions (= the snake-skin speckle artifact)."""
    from scipy.ndimage import label
    # 4-connectivity is enough; 8 would merge thin chart boundaries.
    structure = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=bool)
    chart_id, n_charts = label(used_mask, structure=structure)
    log(f'atlas-used has {n_charts} connected chart components')
    return chart_id  # int32 array, 0=background, 1..n_charts=charts


def _fill_holes_nearest(atlas, written_mask, used_mask, gutter_px=8,
                         chart_id=None):
    """Fill atlas in two passes:
      1. Holes INSIDE charts (used_mask & ~written_mask). When chart_id is
         given (CHART-AWARE), the NN is computed PER CHART so a hole gets
         filled only from texels of the same chart — eliminates the
         snake-skin / hatching speckle where NN traverses chart edges and
         pulls colours from unrelated mesh regions.
      2. Gutter expansion: dilate the used region by `gutter_px` and fill
         those new texels with the nearest already-filled pixel. This
         provides sampling headroom at chart edges so bilinear texture
         sampling doesn't fall into black inter-chart space."""
    from scipy.ndimage import distance_transform_edt, binary_dilation
    filled = atlas.copy()

    holes = used_mask & (~written_mask)
    if holes.any():
        if chart_id is not None:
            log(f'filling {int(holes.sum())} hole pixels CHART-AWARE')
            # For each chart id, compute NN within that chart only.
            unique_ids = np.unique(chart_id[chart_id > 0])
            for cid in unique_ids:
                chart_mask = (chart_id == cid)
                chart_written = chart_mask & written_mask
                chart_holes = chart_mask & holes
                if not chart_holes.any() or not chart_written.any():
                    continue
                # Compute NN within this chart only.
                # distance_transform_edt source = ~chart_written → finds the
                # nearest written texel; we constrain holes to chart_holes
                # which guarantees we only assign INSIDE the chart.
                _, indices = distance_transform_edt(
                    ~chart_written, return_indices=True)
                fy = indices[0][chart_holes]
                fx = indices[1][chart_holes]
                filled[chart_holes] = atlas[fy, fx]
        else:
            log(f'filling {int(holes.sum())} hole pixels (legacy NN, '
                f'crosses chart boundaries)')
            _, indices = distance_transform_edt(~written_mask, return_indices=True)
            fy = indices[0][holes]
            fx = indices[1][holes]
            filled[holes] = atlas[fy, fx]
        written_mask = written_mask | holes

    if gutter_px > 0:
        # 8-connectivity dilation of the used region.
        used_dilated = binary_dilation(used_mask, iterations=gutter_px)
        gutter = used_dilated & (~used_mask)
        n_gutter = int(gutter.sum())
        if n_gutter > 0:
            log(f'expanding atlas gutter by {gutter_px}px '
                f'({n_gutter} edge texels)')
            _, indices = distance_transform_edt(
                ~written_mask, return_indices=True)
            gy = indices[0][gutter]
            gx = indices[1][gutter]
            filled[gutter] = filled[gy, gx]
    return filled


def _load_views(source_img_path, mv_dir):
    """Build the list of (rgba, azim, elev, weight) views.
    Source photo is NOT used directly — the MV view_0 IS the front view
    rendered from the same reference, so it's redundant and may misalign."""
    views = []
    schema = [(az, el, 1.0) for az, el in DEFAULT_ANGLES]
    sj = os.path.join(mv_dir, 'views.json')
    if os.path.isfile(sj):
        try:
            with open(sj, 'r', encoding='utf-8') as f:
                sd = json.load(f)
            schema = [
                (float(v['azim']), float(v['elev']),
                 float(v.get('weight', 1.0)))
                for v in sd['views']
            ]
            log(f'loaded views.json with {len(schema)} views')
        except Exception as e:
            log(f'views.json parse error: {e}; falling back to CRM defaults')
    for i, (az, el, w) in enumerate(schema):
        p = os.path.join(mv_dir, f'view_{i}.png')
        if not os.path.isfile(p):
            log(f'  view_{i}.png missing — skip')
            continue
        rgba = np.asarray(Image.open(p).convert('RGBA')).astype(np.float32)
        views.append((rgba, az, el, w))
    return views


def bake(mesh_glb, source_image_path, out_glb, mv_dir,
         atlas_res=2048, render_res=1024):
    t0 = time.time()
    log(f'mesh:    {mesh_glb}')
    log(f'source:  {source_image_path}')
    log(f'out:     {out_glb}')
    log(f'mv_dir:  {mv_dir}')

    # Load mesh with UVs.
    m = trimesh.load(mesh_glb, force='mesh', process=False)
    if isinstance(m, trimesh.Scene):
        m = list(m.geometry.values())[0]
    if not hasattr(m.visual, 'uv') or m.visual.uv is None:
        log('input mesh has no UVs — running xatlas unwrap')
        import xatlas
        v = m.vertices.astype(np.float32)
        f = m.faces.astype(np.uint32)
        vmap, idx, uv = xatlas.parametrize(v, f)
        m = trimesh.Trimesh(
            vertices=m.vertices[vmap],
            faces=idx.astype(np.int64),
            visual=trimesh.visual.TextureVisuals(uv=uv),
            process=False,
        )
    log(f'mesh: {len(m.vertices)}v / {len(m.faces)}f / uv {m.visual.uv.shape}')

    # Normalize for rendering (keep original verts for export).
    v_norm, c, s = _normalize_mesh(np.asarray(m.vertices, dtype=np.float32))
    v_pos = torch.from_numpy(v_norm).cuda()
    v_uv = torch.from_numpy(np.asarray(m.visual.uv, dtype=np.float32)).cuda()
    faces = torch.from_numpy(np.asarray(m.faces, dtype=np.int32)).cuda()
    faces_uv = faces  # same indexing since uv is per-vertex here
    # Compute per-vertex normals on the normalized mesh.
    m_tmp = trimesh.Trimesh(vertices=v_norm, faces=np.asarray(m.faces),
                            process=False)
    vn = np.asarray(m_tmp.vertex_normals, dtype=np.float32)
    v_normals = torch.from_numpy(vn).cuda()

    glctx = dr.RasterizeCudaContext()

    # Atlas-used mask: which texels are actually mapped by any face.
    log('computing atlas-used mask via UV-space rasterisation')
    used_mask = _atlas_used_mask(glctx, v_uv, faces_uv, atlas_res)
    n_used = int(used_mask.sum())
    log(f'atlas-used texels: {n_used}/{atlas_res*atlas_res} '
        f'({100*n_used/(atlas_res*atlas_res):.1f}%)')
    chart_id = _atlas_chart_id_map(used_mask)

    # Load views.
    views = _load_views(source_image_path, mv_dir)
    log(f'loaded {len(views)} MV views (skipping source photo to avoid '
        f'duplicate/misaligned front)')

    # Accumulators (atlas_res, atlas_res, 3) float64.
    atlas_acc = torch.zeros((atlas_res, atlas_res, 3), dtype=torch.float64).cuda()
    weight_acc = torch.zeros((atlas_res, atlas_res), dtype=torch.float64).cuda()

    for idx, (view_rgba, az, el, w) in enumerate(views):
        # Resize view to render_res if needed.
        if view_rgba.shape[0] != render_res or view_rgba.shape[1] != render_res:
            view_pil = Image.fromarray(view_rgba.astype(np.uint8))
            view_pil = view_pil.resize((render_res, render_res), Image.LANCZOS)
            view_rgba = np.asarray(view_pil).astype(np.float32)
        uv_out, mask_pix, cos_nv = _render_inv_uv(
            glctx, v_pos, v_uv, faces, faces_uv, v_normals,
            az, el, render_res)
        # Apply per-view weight multiplier (e.g. trust strict-front more).
        cos_nv = cos_nv * w
        n_v = _project_view_to_atlas(
            view_rgba, uv_out, mask_pix, cos_nv,
            atlas_acc, weight_acc, atlas_res)
        log(f'  view {idx} az={az:+.0f}/el={el:+.0f} (w={w:.1f}): '
            f'splatted {n_v} pixels')

    # Resolve atlas: divide by weight where weight > 0.
    weight_np = weight_acc.cpu().numpy()
    atlas_np = atlas_acc.cpu().numpy()
    written = weight_np > 1e-6
    atlas = np.zeros((atlas_res, atlas_res, 3), dtype=np.float32)
    atlas[written] = (atlas_np[written] / weight_np[written, None]).astype(np.float32)
    n_written = int(written.sum())
    log(f'atlas: {n_written} px written '
        f'({100*n_written/(atlas_res*atlas_res):.1f}%)')

    # Save coverage and pre-fill atlas for debugging.
    workdir = os.path.abspath(out_glb) + '.invuv_v3_work'
    os.makedirs(workdir, exist_ok=True)
    Image.fromarray((written.astype(np.uint8) * 255)).save(
        os.path.join(workdir, 'coverage.png'))
    Image.fromarray((used_mask.astype(np.uint8) * 255)).save(
        os.path.join(workdir, 'used_mask.png'))
    Image.fromarray(atlas.clip(0, 255).astype(np.uint8)).save(
        os.path.join(workdir, 'atlas_raw.png'))

    # Fill holes INSIDE the used region only.
    atlas = _fill_holes_nearest(atlas, written, used_mask, chart_id=chart_id)
    Image.fromarray(atlas.clip(0, 255).astype(np.uint8)).save(
        os.path.join(workdir, 'atlas_filled.png'))

    # Export GLB with the new atlas (original vertices preserved).
    atlas_img = Image.fromarray(atlas.clip(0, 255).astype(np.uint8))
    m.visual = trimesh.visual.TextureVisuals(uv=m.visual.uv, image=atlas_img)
    m.export(out_glb)
    log(f'TOTAL: {time.time()-t0:.1f}s -> {out_glb}')
    log(f'work dir: {workdir}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('mesh')
    ap.add_argument('source')
    ap.add_argument('out')
    ap.add_argument('--mv-dir', required=True)
    ap.add_argument('--atlas-res', type=int, default=2048)
    ap.add_argument('--render-res', type=int, default=1024)
    args = ap.parse_args()
    bake(args.mesh, args.source, args.out, mv_dir=args.mv_dir,
         atlas_res=args.atlas_res, render_res=args.render_res)


if __name__ == '__main__':
    main()
