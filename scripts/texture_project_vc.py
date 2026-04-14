"""
Vertex-Color projection (no UV atlas) — alternative to texture_project.py.

Why this exists:
  SF3D meshes ship with thousands of micro UV islands. Any textured
  projection ends up rendered as a "voronoi mosaic" because Three.js
  bilinear filtering samples across razor-thin island borders. Vertex
  coloring sidesteps the problem entirely: each vertex carries its own
  RGB sample, the renderer interpolates linearly across faces, and the
  result is smooth without any atlas.

Pipeline:
  1. Load mesh.
  2. For each of the 7 views (front + 6 Zero123++) project every vertex,
     compute (visibility * priority * src_alpha) as weight, and sample
     the matching pixel.
  3. Per vertex: keep the colour from the highest-weight view (single
     winner) — softer than blending, avoids muddy averages from
     photometrically-inconsistent Zero123++ views.
  4. For vertices no view saw, fall back to the SF3D baked atlas at
     their UV coord (clean colour, just blurry — better than black).
  5. Write COLOR_0 attribute on the mesh and export GLB. Strip
     baseColorTexture so the renderer uses vertex colours.

Camera math is identical to texture_project.py (Zero123++ v1.2
azimuth/elevation schema verified against InstantMesh).

Usage:
    python texture_project_vc.py <mesh.glb> <source_image> <output.glb>
                                 [--multiview <dir>]
"""
import os
import sys
import time
import argparse
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from fabmesh_log import Logger
except Exception:
    Logger = None


def log(msg):
    print(f'[tex_vc] {msg}', flush=True)


# Same Zero123++ schema as texture_project.py
MULTIVIEW_VIEWS = [
    (30.0, 20.0),
    (90.0, -10.0),
    (150.0, 20.0),
    (210.0, -10.0),
    (270.0, 20.0),
    (330.0, -10.0),
]

PRIORITY_WEIGHTS = {
    0.0: 1.0,
    30.0: 0.6, 330.0: 0.6,
    90.0: 0.9, 270.0: 0.9,
    150.0: 0.8, 210.0: 0.8,
}


def rot_x(deg):
    r = np.radians(deg)
    return np.array([
        [1, 0, 0],
        [0, np.cos(r), -np.sin(r)],
        [0, np.sin(r),  np.cos(r)],
    ])


def rot_y(deg):
    r = np.radians(deg)
    return np.array([
        [ np.cos(r), 0, np.sin(r)],
        [ 0,         1, 0        ],
        [-np.sin(r), 0, np.cos(r)],
    ])


def project_vertex_colors(mesh_path, source_image_path, output_path,
                          multiview_dir=None):
    import trimesh

    t0 = time.time()
    slog = Logger('tex_vc',
                  mesh=os.path.basename(mesh_path),
                  multiview=(os.path.basename(multiview_dir) if multiview_dir else None)) \
           if Logger else None

    def _evt(event, **f):
        if slog: slog.info(event, **f)

    log(f'mesh={mesh_path} src={source_image_path} out={output_path}')
    _evt('pipeline_started', source=source_image_path,
         multiview_dir=multiview_dir)

    # Load mesh
    scene = trimesh.load(mesh_path)
    geom = list(scene.geometry.values())[0] if hasattr(scene, 'geometry') else scene
    vertices = np.asarray(geom.vertices, dtype=np.float64)
    faces = np.asarray(geom.faces, dtype=np.int32)
    normals = np.asarray(geom.vertex_normals, dtype=np.float64)
    uv = np.asarray(geom.visual.uv, dtype=np.float64) if geom.visual.uv is not None else None
    log(f'mesh: {len(vertices)} verts, {len(faces)} faces')
    _evt('mesh_loaded', verts=int(len(vertices)), faces=int(len(faces)))

    # SF3D baked texture as fallback for unseen verts
    sf3d_tex = geom.visual.material.baseColorTexture
    if sf3d_tex is not None:
        sf3d_tex = sf3d_tex.convert('RGB')
        sf3d_arr = np.asarray(sf3d_tex)
        log(f'sf3d fallback texture: {sf3d_tex.size}')
    else:
        sf3d_arr = None

    # Undo SF3D's post-generation Rx(-90) + Ry(+90) + invert
    R_undo = rot_x(90) @ rot_y(-90)
    verts_cam = (R_undo @ vertices.T).T
    norms_cam = (R_undo @ normals.T).T
    norms_cam = -norms_cam

    # SF3D camera params
    fov_deg = 40.0
    distance = 1.6
    fov_rad = np.radians(fov_deg)
    focal = 0.5 / np.tan(0.5 * fov_rad)
    R_w2c_base = np.array([[0, 1, 0], [0, 0, 1], [1, 0, 0]], dtype=np.float64)

    def project_single(src_pixels, src_w, src_h, azim_deg, elev_deg=0.0):
        R_w2c = R_w2c_base @ rot_x(elev_deg) @ rot_y(-azim_deg)
        cam_pos_w = (rot_y(azim_deg) @ rot_x(-elev_deg) @
                     np.array([distance, 0.0, 0.0]))
        t_w2c = -R_w2c @ cam_pos_w
        v_cs = (R_w2c @ verts_cam.T).T + t_w2c
        n_cs = (R_w2c @ norms_cam.T).T
        z = v_cs[:, 2]
        safe_z = np.where(np.abs(z) < 1e-8, -1e-8, z)
        p_u = focal * v_cs[:, 0] / (-safe_z) + 0.5
        p_v = 1.0 - (focal * v_cs[:, 1] / (-safe_z) + 0.5)
        in_bounds = (p_u >= 0) & (p_u <= 1) & (p_v >= 0) & (p_v <= 1)

        ix = np.clip((p_u * src_w).astype(int), 0, src_w - 1)
        iy = np.clip((p_v * src_h).astype(int), 0, src_h - 1)
        v_colors = src_pixels[iy, ix, :3].astype(np.float64)
        v_alpha = (src_pixels[iy, ix, 3].astype(np.float64) / 255.0
                   if src_pixels.shape[-1] == 4 else
                   np.ones(len(v_colors), dtype=np.float64))

        cam_dirs = -v_cs
        cam_dirs_n = cam_dirs / (np.linalg.norm(cam_dirs, axis=1, keepdims=True) + 1e-10)
        norms_n = n_cs / (np.linalg.norm(n_cs, axis=1, keepdims=True) + 1e-10)
        vis = np.clip(np.sum(norms_n * cam_dirs_n, axis=1), 0, 1)
        vis *= v_alpha
        vis *= in_bounds.astype(np.float64)
        vis = vis ** 0.8
        return v_colors, vis

    # Build view list (path, azim, elev, priority)
    views = [(source_image_path, 0.0, 0.0, PRIORITY_WEIGHTS[0.0])]
    if multiview_dir:
        for i, (azim, elev) in enumerate(MULTIVIEW_VIEWS):
            vp = os.path.join(multiview_dir, f'view_{i}.png')
            if os.path.exists(vp):
                views.append((vp, azim, elev, PRIORITY_WEIGHTS.get(azim, 0.4)))
            else:
                log(f'WARNING missing {vp}')
    log(f'projecting {len(views)} view(s)')

    # Per-vertex best-weight winner (no blending → no muddy averages)
    n_v = len(vertices)
    best_w = np.zeros(n_v, dtype=np.float64)
    best_c = np.zeros((n_v, 3), dtype=np.float64)

    for img_path, azim, elev, prio in views:
        img = Image.open(img_path).convert('RGBA')
        sw, sh = img.size
        sp = np.asarray(img)
        cols, vis = project_single(sp, sw, sh, azim, elev)
        weight = vis * prio
        winner = weight > best_w
        n_won = int(winner.sum())
        best_c[winner] = cols[winner]
        best_w[winner] = weight[winner]
        log(f'  view az={azim:.0f}/el={elev:.0f}: {n_won} verts won')
        _evt('view_done', azim=azim, elev=elev, won=n_won)

    n_seen = int((best_w > 1e-3).sum())
    log(f'verts with multi-view sample: {n_seen}/{n_v}')
    _evt('projection_done', verts_seen=n_seen, total=n_v,
         coverage=float(n_seen) / n_v)

    # Fill unseen vertices from SF3D baked texture (looked up via UV)
    if sf3d_arr is not None and uv is not None and len(uv) == n_v:
        unseen = best_w <= 1e-3
        n_unseen = int(unseen.sum())
        if n_unseen:
            tex_h, tex_w = sf3d_arr.shape[:2]
            uvx = np.clip((uv[unseen, 0] * tex_w).astype(int), 0, tex_w - 1)
            uvy = np.clip(((1.0 - uv[unseen, 1]) * tex_h).astype(int), 0, tex_h - 1)
            best_c[unseen] = sf3d_arr[uvy, uvx, :3].astype(np.float64)
            log(f'fallback from SF3D atlas: {n_unseen} verts')
            _evt('sf3d_fallback', count=n_unseen)
    else:
        # Last-resort grey for verts no view saw (rare)
        unseen = best_w <= 1e-3
        if unseen.any():
            best_c[unseen] = [128, 128, 128]
            log(f'no fallback texture, painting {int(unseen.sum())} verts grey')

    # Build a NEW trimesh with vertex colours and no texture, export it
    colors_u8 = np.clip(best_c, 0, 255).astype(np.uint8)
    # trimesh wants RGBA per-vertex
    colors_rgba = np.concatenate(
        [colors_u8, np.full((n_v, 1), 255, dtype=np.uint8)], axis=1)

    new_mesh = trimesh.Trimesh(
        vertices=vertices, faces=faces,
        vertex_normals=normals,
        vertex_colors=colors_rgba,
        process=False, validate=False,
    )
    # Override material to plain PBR with no texture, slightly rough
    new_mesh.visual.material = trimesh.visual.material.PBRMaterial(
        metallicFactor=0.0,
        roughnessFactor=0.85,
    )
    new_mesh.export(output_path, file_type='glb')
    sz = os.path.getsize(output_path)
    log(f'GLB exported with vertex colours ({sz} bytes) in {time.time()-t0:.1f}s')
    _evt('pipeline_done', bytes=sz, ms=int((time.time() - t0) * 1000))
    return True


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('mesh')
    p.add_argument('source_image')
    p.add_argument('output')
    p.add_argument('--multiview', default=None)
    args = p.parse_args()
    try:
        ok = project_vertex_colors(args.mesh, args.source_image,
                                   args.output, args.multiview)
        sys.exit(0 if ok else 1)
    except Exception as e:
        import traceback
        traceback.print_exc()
        log(f'ERROR: {type(e).__name__}: {e}')
        sys.exit(2)
