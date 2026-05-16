"""TripoSG mesh + SF3D atlas via per-pixel raycast (best texture quality).

Pipeline:
  1. SF3D bridge   -> mesh_sf3d.glb (12k faces, native UVs, native atlas)
  2. TripoSG       -> mesh_triposg.glb (1.4M faces)
  3. Decimate TripoSG to target_faces
  4. xatlas unwrap TripoSG -> mesh has UVs
  5. RAYCAST BAKE:
     - Build a fresh atlas (1024x1024 RGB)
     - For each pixel in atlas: convert UV -> 3D pos on TripoSG mesh,
       find closest_point on SF3D mesh, sample SF3D atlas at that point's
       UV, write the color in TripoSG atlas.
     - Result: TripoSG atlas filled with SF3D colors interpolated on the
       continuous SF3D surface (not just at vertices).

Usage:
    python triposg_sf3d_raycast.py <front_image> <out.glb>
        [target_faces=50000] [tex_res=1024]
"""
import sys
import os
import time
import subprocess
import numpy as np
import trimesh
from PIL import Image


SCRIPTS = os.path.dirname(os.path.abspath(__file__))


def log(msg):
    print(f'[triposg_raycast] {msg}', flush=True)


def step_sf3d(image_path, out_glb, tex_res):
    log(f'STEP 1: SF3D bridge -> {out_glb}')
    bridge = os.path.join(SCRIPTS, 'local_sf3d_bridge.py')
    t0 = time.time()
    proc = subprocess.run(
        [sys.executable, bridge, image_path, out_glb, str(tex_res),
         '-1', 'none', '0'],
        capture_output=True, text=True, timeout=600,
    )
    if proc.returncode != 0:
        log(f'SF3D failed: {proc.stderr[-500:]}')
        sys.exit(2)
    log(f'STEP 1 done in {time.time()-t0:.1f}s')


def step_triposg(image_path, out_glb):
    log(f'STEP 2: TripoSG bridge -> {out_glb}')
    bridge = os.path.join(SCRIPTS, 'local_triposg_bridge.py')
    t0 = time.time()
    proc = subprocess.run(
        [sys.executable, bridge, image_path, out_glb, '30', '7.0'],
        capture_output=True, text=True, timeout=300,
    )
    if proc.returncode != 0:
        log(f'TripoSG failed: {proc.stderr[-500:]}')
        sys.exit(3)
    log(f'STEP 2 done in {time.time()-t0:.1f}s')


def step_decimate(in_glb, out_glb, target_faces):
    log(f'STEP 3: decimate to {target_faces} faces')
    t0 = time.time()
    m = trimesh.load(in_glb, force='mesh')
    log(f'  loaded {len(m.vertices)}v / {len(m.faces)}f')
    if len(m.faces) > target_faces:
        try:
            import fast_simplification
            v, f = fast_simplification.simplify(
                m.vertices, m.faces, target_count=target_faces)
            m = trimesh.Trimesh(vertices=v, faces=f, process=False)
            log(f'  decimated to {len(m.faces)}f')
        except Exception as e:
            log(f'  fast_simplification failed ({e})')
    m.export(out_glb)
    log(f'STEP 3 done in {time.time()-t0:.1f}s')


def step_unwrap(in_glb, out_glb):
    log('STEP 4: xatlas unwrap')
    t0 = time.time()
    import xatlas
    m = trimesh.load(in_glb, force='mesh')
    v = m.vertices.astype(np.float32)
    f = m.faces.astype(np.uint32)
    atlas = xatlas.Atlas()
    atlas.add_mesh(v, f)
    atlas.generate()
    vmap, indices, uvs = atlas[0]
    new_mesh = trimesh.Trimesh(
        vertices=v[vmap],
        faces=indices.astype(np.int64),
        visual=trimesh.visual.TextureVisuals(uv=uvs),
        process=False,
    )
    log(f'  {atlas.chart_count} charts, util {atlas.utilization:.1%}, '
        f'{len(new_mesh.vertices)}v / {len(new_mesh.faces)}f')
    new_mesh.export(out_glb)
    log(f'STEP 4 done in {time.time()-t0:.1f}s')


def step_align(triposg_mesh, sf3d_mesh):
    """Align TripoSG to SF3D coordinate frame (center + scale)."""
    log('STEP 5a: align TripoSG to SF3D frame')
    sf_center = sf3d_mesh.vertices.mean(axis=0)
    tp_center = triposg_mesh.vertices.mean(axis=0)
    triposg_mesh.vertices -= tp_center
    sf_extent = sf3d_mesh.vertices.max() - sf3d_mesh.vertices.min()
    tp_extent = triposg_mesh.vertices.max() - triposg_mesh.vertices.min()
    if tp_extent > 0:
        s = sf_extent / tp_extent
        triposg_mesh.vertices *= s
        log(f'  scale x{s:.3f}')
    triposg_mesh.vertices += sf_center
    return triposg_mesh


def step_raycast_bake(triposg_path, sf3d_path, out_path, atlas_size=1024):
    """Per-pixel raycast from TripoSG atlas to SF3D mesh surface."""
    log('STEP 5: RAYCAST BAKE')
    t0 = time.time()

    # Load both
    tp = trimesh.load(triposg_path, force='mesh')
    sf = trimesh.load(sf3d_path, force='mesh')

    if not (hasattr(tp.visual, 'uv') and tp.visual.uv is not None):
        log('  ERROR: TripoSG has no UVs!'); sys.exit(4)
    if not (hasattr(sf.visual, 'uv') and sf.visual.uv is not None):
        log('  ERROR: SF3D has no UVs!'); sys.exit(5)
    sf_atlas = sf.visual.material.baseColorTexture
    if sf_atlas is None:
        log('  ERROR: SF3D has no atlas!'); sys.exit(6)

    # Align
    tp = step_align(tp, sf)
    sf_atlas_arr = np.asarray(sf_atlas.convert('RGB'))
    sH, sW = sf_atlas_arr.shape[:2]
    log(f'  SF3D atlas: {sf_atlas.size}, mesh: {len(sf.vertices)}v')
    log(f'  TripoSG mesh: {len(tp.vertices)}v / {len(tp.faces)}f')

    # Build the TripoSG atlas via UV rasterization:
    # For each pixel in the new atlas, compute its 3D position on TripoSG
    # by interpolating barycentrically inside the UV triangle that covers
    # that pixel. Then closest_point on SF3D, then sample SF3D atlas.
    log(f'  building {atlas_size}x{atlas_size} atlas via UV raster + raycast...')

    new_atlas = np.zeros((atlas_size, atlas_size, 3), dtype=np.uint8)
    coverage = np.zeros((atlas_size, atlas_size), dtype=bool)

    tp_uvs = np.asarray(tp.visual.uv)
    tp_verts = np.asarray(tp.vertices)
    tp_faces = np.asarray(tp.faces)

    # For each face: collect (u,v,3D) of the 3 corners, rasterize triangle
    # in atlas, interpolate 3D pos per pixel.
    # Sequential-but-vectorized-per-triangle approach.
    sample_pts = []
    sample_idx = []  # (atlas_y, atlas_x) for each sample
    log('  rasterizing UV triangles to collect 3D sample points...')
    for fi in range(len(tp_faces)):
        v_idx = tp_faces[fi]
        uvs = tp_uvs[v_idx]  # (3, 2)
        pts3d = tp_verts[v_idx]  # (3, 3)
        # Triangle UV → atlas pixel coords
        px = uvs[:, 0] * (atlas_size - 1)
        py = (1.0 - uvs[:, 1]) * (atlas_size - 1)
        x0, x1, x2 = px
        y0, y1, y2 = py
        min_x = max(0, int(np.floor(min(x0, x1, x2))))
        max_x = min(atlas_size - 1, int(np.ceil(max(x0, x1, x2))))
        min_y = max(0, int(np.floor(min(y0, y1, y2))))
        max_y = min(atlas_size - 1, int(np.ceil(max(y0, y1, y2))))
        if max_x <= min_x or max_y <= min_y:
            continue
        denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(denom) < 1e-10:
            continue
        inv_denom = 1.0 / denom
        ys, xs = np.mgrid[min_y:max_y + 1, min_x:max_x + 1]
        xsf = xs.astype(np.float64) + 0.5
        ysf = ys.astype(np.float64) + 0.5
        w0 = ((y1 - y2) * (xsf - x2) + (x2 - x1) * (ysf - y2)) * inv_denom
        w1 = ((y2 - y0) * (xsf - x2) + (x0 - x2) * (ysf - y2)) * inv_denom
        w2 = 1.0 - w0 - w1
        mask = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not mask.any():
            continue
        # Interpolated 3D positions for in-triangle pixels
        positions = (w0[..., None] * pts3d[0]
                     + w1[..., None] * pts3d[1]
                     + w2[..., None] * pts3d[2])
        # Take only in-mask pixels
        inmask_pos = positions[mask]
        inmask_y = ys[mask]
        inmask_x = xs[mask]
        sample_pts.append(inmask_pos)
        sample_idx.append(np.stack([inmask_y, inmask_x], axis=1))
        coverage[inmask_y, inmask_x] = True

    if not sample_pts:
        log('  ERROR: no pixels covered'); sys.exit(7)
    sample_pts = np.concatenate(sample_pts, axis=0)
    sample_idx = np.concatenate(sample_idx, axis=0)
    log(f'  collected {len(sample_pts)} sample points '
        f'({coverage.sum()}/{atlas_size**2} pixels = '
        f'{coverage.mean()*100:.1f}% coverage)')

    # Closest-point on SF3D mesh for each sample
    log('  closest_point on SF3D mesh (this can be slow)...')
    t1 = time.time()
    closest, distance, triangle_id = trimesh.proximity.closest_point(sf, sample_pts)
    log(f'  closest_point done in {time.time()-t1:.1f}s')

    # For each closest point: get the SF3D triangle, compute barycentric
    # coords of the closest point in that triangle, interpolate the SF3D
    # UVs, sample the SF3D atlas.
    sf_uvs = np.asarray(sf.visual.uv)
    sf_verts = np.asarray(sf.vertices)
    sf_faces = np.asarray(sf.faces)

    log('  computing barycentric + sampling SF3D atlas...')
    # Vectorized barycentric: for each sample, get the 3 vertex positions
    # of the closest triangle.
    tri_verts = sf_verts[sf_faces[triangle_id]]  # (N, 3, 3)
    tri_uvs = sf_uvs[sf_faces[triangle_id]]      # (N, 3, 2)
    A = tri_verts[:, 0]; B = tri_verts[:, 1]; C = tri_verts[:, 2]
    P = closest
    # Barycentric in 3D
    v0 = B - A; v1 = C - A; v2 = P - A
    d00 = (v0 * v0).sum(axis=1)
    d01 = (v0 * v1).sum(axis=1)
    d11 = (v1 * v1).sum(axis=1)
    d20 = (v2 * v0).sum(axis=1)
    d21 = (v2 * v1).sum(axis=1)
    denom_b = d00 * d11 - d01 * d01
    safe = np.abs(denom_b) > 1e-12
    v_bc = np.zeros_like(d00); w_bc = np.zeros_like(d00)
    v_bc[safe] = (d11[safe] * d20[safe] - d01[safe] * d21[safe]) / denom_b[safe]
    w_bc[safe] = (d00[safe] * d21[safe] - d01[safe] * d20[safe]) / denom_b[safe]
    u_bc = 1.0 - v_bc - w_bc
    # Interpolated SF3D UVs at the closest point
    interp_uv = (u_bc[:, None] * tri_uvs[:, 0]
                 + v_bc[:, None] * tri_uvs[:, 1]
                 + w_bc[:, None] * tri_uvs[:, 2])
    # Sample SF3D atlas
    atlas_x = np.clip((interp_uv[:, 0] * (sW - 1)).astype(int), 0, sW - 1)
    atlas_y = np.clip(((1.0 - interp_uv[:, 1]) * (sH - 1)).astype(int), 0, sH - 1)
    sampled_colors = sf_atlas_arr[atlas_y, atlas_x]
    # Write into TripoSG atlas
    new_atlas[sample_idx[:, 0], sample_idx[:, 1]] = sampled_colors
    log(f'  wrote {len(sample_pts)} pixels')

    # Build the final mesh with the new atlas
    new_atlas_pil = Image.fromarray(new_atlas)
    new_mesh = trimesh.Trimesh(
        vertices=tp.vertices,
        faces=tp.faces,
        visual=trimesh.visual.TextureVisuals(
            uv=tp_uvs,
            image=new_atlas_pil,
        ),
        process=False,
    )
    new_mesh.export(out_path)
    log(f'STEP 5 done in {time.time()-t0:.1f}s -> {out_path}')


def main():
    if len(sys.argv) < 3:
        print('Usage: triposg_sf3d_raycast.py <front_image> <out.glb> '
              '[target_faces=50000] [tex_res=1024]')
        sys.exit(1)
    image_path = sys.argv[1]
    out_glb = sys.argv[2]
    target_faces = int(sys.argv[3]) if len(sys.argv) > 3 else 50000
    tex_res = int(sys.argv[4]) if len(sys.argv) > 4 else 1024

    out_dir = os.path.dirname(os.path.abspath(out_glb))
    os.makedirs(out_dir, exist_ok=True)
    sf3d_glb = os.path.join(out_dir, '_sf3d_native.glb')
    tp_raw_glb = os.path.join(out_dir, '_triposg_raw.glb')
    tp_dec_glb = os.path.join(out_dir, '_triposg_decimated.glb')
    tp_uv_glb = os.path.join(out_dir, '_triposg_uvunwrapped.glb')

    t0 = time.time()
    step_sf3d(image_path, sf3d_glb, tex_res)
    step_triposg(image_path, tp_raw_glb)
    if target_faces > 0:
        step_decimate(tp_raw_glb, tp_dec_glb, target_faces)
        unwrap_in = tp_dec_glb
    else:
        log('STEP 3 SKIP decimation')
        unwrap_in = tp_raw_glb
    step_unwrap(unwrap_in, tp_uv_glb)
    step_raycast_bake(tp_uv_glb, sf3d_glb, out_glb, atlas_size=tex_res)
    log(f'TOTAL: {time.time()-t0:.1f}s -> {out_glb}')


if __name__ == '__main__':
    main()
