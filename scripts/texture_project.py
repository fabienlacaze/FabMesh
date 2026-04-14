"""
FabMesh Texture Projection — re-project source photo onto 3D mesh UV atlas.
===========================================================================

Improves SF3D's blurry baked textures by projecting the original high-res
source photo back onto the mesh using SF3D's EXACT perspective camera
(fov=40 deg, distance=1.6) so front-facing geometry gets sharp textures.

Supports multi-view projection using Zero123++ generated views at 6 angles
(30, 90, 150, 210, 270, 330 deg) plus the front input image (0 deg).

Strategy:
  1. Undo SF3D's post-generation rotation (Rx(-90) * Ry(90) * invert)
     to recover the original camera-space coordinates
  2. For each vertex: perspective-project 3D position using SF3D's camera
  3. Visibility weight: dot(normal, camera_dir) — front-facing = high weight
  4. Render the UV atlas by rasterizing each face with interpolated colors
  5. Blend: visible areas get source photo, hidden areas keep SF3D texture

Usage:
    python texture_project.py <mesh.glb> <source_image> <output.glb> [resolution]
    python texture_project.py <mesh.glb> <source_image> <output.glb> [resolution] --multiview <dir>
"""
import sys
import os
import struct
import json
import io
import time
import numpy as np
from PIL import Image, ImageDraw


def log(msg):
    print(f'[tex_project] {msg}', flush=True)


def project_texture(mesh_path, source_image_path, output_path, tex_res=1024,
                    multiview_dir=None):
    """Project source photo onto mesh UV atlas and save result.

    If multiview_dir is provided, also projects view_0..view_5.png at their
    respective Zero123++ angles and blends all views weighted by visibility
    and priority.
    """
    import trimesh

    t0 = time.time()
    log(f'mesh={mesh_path} src={source_image_path} out={output_path} res={tex_res}'
        f'{" multiview=" + multiview_dir if multiview_dir else ""}')

    # Load mesh
    scene = trimesh.load(mesh_path)
    geoms = list(scene.geometry.values()) if hasattr(scene, 'geometry') else [scene]
    geom = geoms[0]
    vertices = np.asarray(geom.vertices, dtype=np.float64)
    faces = np.asarray(geom.faces, dtype=np.int32)
    normals = np.asarray(geom.vertex_normals, dtype=np.float64)
    uv = np.asarray(geom.visual.uv, dtype=np.float64)

    log(f'mesh: {len(vertices)} verts, {len(faces)} faces')

    # Load SF3D texture as fallback
    sf3d_tex = geom.visual.material.baseColorTexture
    if sf3d_tex is None:
        log('ERROR: no baseColorTexture'); return False
    sf3d_tex = sf3d_tex.convert('RGB').resize((tex_res, tex_res), Image.LANCZOS)

    # ---------------------------------------------------------------
    # Step 1: Undo SF3D's post-generation transforms
    #
    # SF3D applies these AFTER mesh generation (system.py lines 518-528):
    #   1. Rx(-90): rotate -90 deg around X
    #   2. Ry(+90): rotate +90 deg around Y
    #   3. invert(): flip face winding (normals flip)
    #
    # To go from exported GLB coords back to SF3D's internal coords
    # (where the camera was), we must apply the INVERSE in reverse order:
    #   1. un-invert (flip normals back — we handle this via normal sign)
    #   2. Ry(-90)^-1 = Ry(-90)
    #   3. Rx(-90)^-1 = Rx(+90)
    # ---------------------------------------------------------------
    def rot_x(deg):
        r = np.radians(deg)
        return np.array([
            [1, 0, 0],
            [0, np.cos(r), -np.sin(r)],
            [0, np.sin(r),  np.cos(r)]
        ])

    def rot_y(deg):
        r = np.radians(deg)
        return np.array([
            [ np.cos(r), 0, np.sin(r)],
            [ 0,         1, 0        ],
            [-np.sin(r), 0, np.cos(r)]
        ])

    # Inverse of: Rx(-90) then Ry(+90) = undo Ry(+90) then undo Rx(-90)
    R_undo = rot_x(90) @ rot_y(-90)
    verts_cam = (R_undo @ vertices.T).T  # (V, 3) in SF3D's internal coords
    norms_cam = (R_undo @ normals.T).T
    # The invert() call flips normals; undo that
    norms_cam = -norms_cam

    # ---------------------------------------------------------------
    # Step 2: Camera parameters
    #
    # SF3D camera (system.py / utils.py):
    #   default_fovy_deg = 40.0
    #   default_distance = 1.6
    #   c2w = [[0,0,1,d], [1,0,0,0], [0,1,0,0], [0,0,0,1]]
    #
    # This c2w means: camera position = (d, 0, 0) in world coords
    # (the 4th column after the axis swap), camera Z axis = world X.
    #
    # The c2w columns map camera axes to world axes:
    #   Row 0: [0,0,1,d] means world_X = cam_Z * 1 + d
    #   Row 1: [1,0,0,0] means world_Y = cam_X * 1
    #   Row 2: [0,1,0,0] means world_Z = cam_Y * 1
    #
    # Actually c2w maps camera coords to world:
    #   world = R_c2w * cam + t_c2w
    #   R_c2w = [[0,0,1],[1,0,0],[0,1,0]], t_c2w = [d,0,0]
    #
    # So w2c (world to camera) = inv(c2w):
    #   R_w2c = R_c2w^T = [[0,1,0],[0,0,1],[1,0,0]]
    #   t_w2c = -R_w2c * t_c2w = -[[0,1,0],[0,0,1],[1,0,0]] * [d,0,0]
    #         = [0, 0, -d]
    #
    # So in camera coords: cam = R_w2c * world + [0, 0, -d]
    #   cam_x = world_y
    #   cam_y = world_z
    #   cam_z = world_x - d
    # ---------------------------------------------------------------
    fov_deg = 40.0
    distance = 1.6
    fov_rad = np.radians(fov_deg)
    focal = 0.5 / np.tan(0.5 * fov_rad)

    # Base world-to-camera transform (front view, 0 degrees)
    # R_w2c = R_c2w^T where R_c2w = [[0,0,1],[1,0,0],[0,1,0]]
    R_w2c_base = np.array([
        [0, 1, 0],
        [0, 0, 1],
        [1, 0, 0]
    ], dtype=np.float64)
    t_w2c_base = np.array([0, 0, -distance], dtype=np.float64)

    # -------------------------------------------------------------------
    # Helper: project vertices from a rotated camera viewpoint
    # angle_deg: Y-axis rotation angle (0 = front, 90 = right, etc.)
    # Returns (vertex_colors, visibility) arrays for this view
    # -------------------------------------------------------------------
    def project_single_view(src_pixels, src_w, src_h, angle_deg):
        """Project from a camera rotated angle_deg around Y axis.

        Camera orbit math:
          Base c2w has R_c2w_base and t_c2w_base = [d,0,0].
          Orbiting by angle_deg around Y applies Ry(angle) to the whole c2w:
            R_c2w_new = Ry(angle) @ R_c2w_base
            t_c2w_new = Ry(angle) @ [d,0,0]
          Inverting to get w2c:
            R_w2c_new = R_c2w_new^T = R_c2w_base^T @ Ry(-angle) = R_w2c_base @ Ry(-angle)
            t_w2c_new = -R_w2c_new @ t_c2w_new
                      = -(R_w2c_base @ Ry(-angle)) @ (Ry(angle) @ [d,0,0])
                      = -R_w2c_base @ [d,0,0] = t_w2c_base
          The translation is angle-invariant because orbit rotation cancels out.
        """
        R_w2c = R_w2c_base @ rot_y(-angle_deg)
        t_w2c = t_w2c_base  # angle-invariant (see derivation above)

        # Transform vertices to this camera's space
        v_cs = (R_w2c @ verts_cam.T).T + t_w2c  # (V, 3)
        n_cs = (R_w2c @ norms_cam.T).T

        # Perspective projection
        z = v_cs[:, 2]
        safe_z = np.where(np.abs(z) < 1e-8, -1e-8, z)
        p_u = focal * v_cs[:, 0] / (-safe_z) + 0.5
        p_v = focal * v_cs[:, 1] / (-safe_z) + 0.5
        p_v = 1.0 - p_v  # flip V (image Y top-to-bottom)

        # Bounds check
        in_bounds = (p_u >= 0) & (p_u <= 1) & (p_v >= 0) & (p_v <= 1)

        # Sample source image
        ix = np.clip((p_u * src_w).astype(int), 0, src_w - 1)
        iy = np.clip((p_v * src_h).astype(int), 0, src_h - 1)
        v_colors = src_pixels[iy, ix, :3].astype(np.float64)
        v_alpha = src_pixels[iy, ix, 3].astype(np.float64) / 255.0

        # Visibility: dot(normal, cam_dir) where cam_dir = -vertex_pos (cam at origin)
        cam_dirs = -v_cs
        cam_dirs_n = cam_dirs / (np.linalg.norm(cam_dirs, axis=1, keepdims=True) + 1e-10)
        norms_n = n_cs / (np.linalg.norm(n_cs, axis=1, keepdims=True) + 1e-10)
        vis = np.sum(norms_n * cam_dirs_n, axis=1)
        vis = np.clip(vis, 0, 1)

        # Combine with alpha and bounds
        vis *= v_alpha
        vis *= in_bounds.astype(np.float64)

        # Mild power curve — keep wider visibility so oblique faces still
        # get projected color instead of falling back to blurry SF3D.
        vis = vis ** 0.8

        return v_colors, vis

    # -------------------------------------------------------------------
    # Build list of views to project
    # -------------------------------------------------------------------
    # Zero123++ view angles:
    #   input.png: 0 deg (front)
    #   view_0.png: 30, view_1: 90, view_2: 150, view_3: 210, view_4: 270, view_5: 330
    MULTIVIEW_ANGLES = [30.0, 90.0, 150.0, 210.0, 270.0, 330.0]

    # Priority weights: front=1.0, front-side=0.7, side=0.5, back-side=0.4, back views get less
    # The priority downweights views so front dominates where multiple views see the same surface
    PRIORITY_WEIGHTS = {
        0.0:   1.0,   # front (input.png) — HD source image
        30.0:  0.6,   # front-right
        330.0: 0.6,   # front-left
        90.0:  0.9,   # right — main side view
        270.0: 0.9,   # left — main side view
        150.0: 0.8,   # back-right — contributes to back coverage
        210.0: 0.8,   # back-left — contributes to back coverage
    }

    views = []  # list of (image_path, angle_deg, priority)

    # Always include the front view
    views.append((source_image_path, 0.0, PRIORITY_WEIGHTS[0.0]))

    if multiview_dir:
        for i, angle in enumerate(MULTIVIEW_ANGLES):
            vpath = os.path.join(multiview_dir, f'view_{i}.png')
            if os.path.exists(vpath):
                views.append((vpath, angle, PRIORITY_WEIGHTS.get(angle, 0.4)))
            else:
                log(f'WARNING: missing {vpath}, skipping')

    log(f'projecting {len(views)} view(s): ' +
        ', '.join(f'{v[1]:.0f}deg(p={v[2]})' for v in views))

    # -------------------------------------------------------------------
    # Step 2b: Project all views and accumulate weighted colors per vertex
    # -------------------------------------------------------------------
    n_verts = len(vertices)
    accum_color = np.zeros((n_verts, 3), dtype=np.float64)
    accum_weight = np.zeros(n_verts, dtype=np.float64)

    for img_path, angle_deg, priority in views:
        src_img = Image.open(img_path).convert('RGBA')
        sw, sh = src_img.size
        sp = np.asarray(src_img)
        log(f'  view {angle_deg:.0f}deg: {img_path} ({sw}x{sh})')

        v_colors, vis = project_single_view(sp, sw, sh, angle_deg)

        # Weight = visibility * priority
        w = vis * priority
        accum_color += v_colors * w[:, np.newaxis]
        accum_weight += w

        n_visible = (vis > 0.1).sum()
        log(f'    {n_visible}/{n_verts} visible verts')

    # Normalize accumulated colors
    safe_w = np.where(accum_weight < 1e-8, 1.0, accum_weight)
    vertex_colors = accum_color / safe_w[:, np.newaxis]
    # Total visibility = clamped accumulated weight (for atlas blending vs SF3D)
    visibility = np.clip(accum_weight, 0, 1)

    log(f'multi-view projection done, {(visibility > 0.1).sum()}/{n_verts} verts covered')

    # Debug: save projection overlay for front view
    try:
        front_img = Image.open(source_image_path).convert('RGBA')
        fw, fh = front_img.size
        front_pixels = np.asarray(front_img)
        _, front_vis = project_single_view(front_pixels, fw, fh, 0.0)
        # Recompute front projection UVs for debug overlay
        R_w2c = R_w2c_base
        t_w2c = t_w2c_base
        verts_cs_dbg = (R_w2c @ verts_cam.T).T + t_w2c
        z_dbg = verts_cs_dbg[:, 2]
        safe_z_dbg = np.where(np.abs(z_dbg) < 1e-8, -1e-8, z_dbg)
        proj_u_dbg = focal * verts_cs_dbg[:, 0] / (-safe_z_dbg) + 0.5
        proj_v_dbg = 1.0 - (focal * verts_cs_dbg[:, 1] / (-safe_z_dbg) + 0.5)

        debug_img = front_img.copy().convert('RGB')
        debug_draw = ImageDraw.Draw(debug_img)
        vis_mask = front_vis > 0.1
        for vi in range(0, len(vertices), max(1, len(vertices) // 2000)):
            if not vis_mask[vi]:
                continue
            px = int(proj_u_dbg[vi] * fw)
            py = int(proj_v_dbg[vi] * fh)
            if 0 <= px < fw and 0 <= py < fh:
                v = min(255, int(front_vis[vi] * 255))
                debug_draw.ellipse([px-1, py-1, px+1, py+1], fill=(v, 255-v, 0))
        debug_path = output_path.replace('.glb', '_proj_debug.png')
        debug_img.save(debug_path)
        log(f'debug overlay saved: {debug_path}')
    except Exception as _dbg_e:
        log(f'debug overlay failed: {_dbg_e}')

    # ---------------------------------------------------------------
    # Step 3: Rasterize UV atlas using PIL
    # For each face, draw a filled triangle in the UV atlas with
    # the projected color (blended with SF3D based on visibility)
    # ---------------------------------------------------------------
    log('rasterizing UV atlas...')

    proj_atlas = Image.new('RGB', (tex_res, tex_res), (0, 0, 0))
    weight_atlas = Image.new('L', (tex_res, tex_res), 0)
    proj_draw = ImageDraw.Draw(proj_atlas)
    weight_draw = ImageDraw.Draw(weight_atlas)

    face_uvs = uv[faces]  # (N, 3, 2)
    face_colors = vertex_colors[faces]  # (N, 3, 3)
    face_vis = visibility[faces]  # (N, 3)

    # Average color and visibility per face
    avg_colors = face_colors.mean(axis=1)  # (N, 3)
    avg_vis = face_vis.mean(axis=1)  # (N,)

    # Pre-compute UV triangle areas and filter degenerate ones
    uv_px = face_uvs * tex_res
    uv_areas = 0.5 * np.abs(
        (uv_px[:, 1, 0] - uv_px[:, 0, 0]) * (uv_px[:, 2, 1] - uv_px[:, 0, 1]) -
        (uv_px[:, 2, 0] - uv_px[:, 0, 0]) * (uv_px[:, 1, 1] - uv_px[:, 0, 1])
    )
    edges = np.stack([
        np.linalg.norm(uv_px[:, 1] - uv_px[:, 0], axis=1),
        np.linalg.norm(uv_px[:, 2] - uv_px[:, 1], axis=1),
        np.linalg.norm(uv_px[:, 0] - uv_px[:, 2], axis=1),
    ], axis=1)
    max_edge = edges.max(axis=1)
    min_edge = edges.min(axis=1)
    # Loose filters: SF3D atlases pack the face/hair in tiny triangle strips
    # (top-right "brick" region). Prior thresholds (min_edge>0.5, aspect<15)
    # rejected ~15% of faces — including the whole head — and those pixels
    # fell back to SF3D's blurry texture. Keep filters only for true
    # degenerates (sub-pixel) to preserve detail.
    aspect_ok = (min_edge > 0.1) & (max_edge / np.clip(min_edge, 0.01, None) < 50)
    edge_size_ok = max_edge < (tex_res * 0.2)

    # Per-pixel rasterization: sample source image at projected vertex
    # coords (via barycentric interp) instead of using face avg color.
    # This preserves the full detail of the source image in the atlas.
    proj_arr = np.zeros((tex_res, tex_res, 3), dtype=np.float64)
    weight_arr = np.zeros((tex_res, tex_res), dtype=np.float64)

    # Precompute per-vertex projected image coords (normalized 0..1)
    # We need to pick ONE source view per vertex — pick the one with highest visibility
    # Simpler: use the accumulated color we already computed (from all views)
    # But to get sharpness, we need the PROJECTED POSITIONS not just the sampled color.
    #
    # For sharpness: for each face, rasterize its UV triangle in the atlas,
    # and for each atlas pixel, interpolate the source image UVs via barycentric,
    # then sample the source image at that position (with bilinear).

    # Per-view precomputation: for each view, cache projected UVs + per-vertex
    # visibility + source image pixels. Then at rasterization time we pick the
    # BEST view per atlas pixel (highest weight), not per face — this is what
    # makes multi-view projection actually work on surfaces invisible from front
    # (e.g. back of head, sides).
    view_data = []
    for img_path, angle_deg, priority in views:
        vsrc_img = Image.open(img_path).convert('RGBA')
        vsrc_w, vsrc_h = vsrc_img.size
        vsrc_pixels = np.asarray(vsrc_img)

        R_w2c_v = R_w2c_base @ rot_y(-angle_deg)
        t_w2c_v = t_w2c_base

        v_cs = (R_w2c_v @ verts_cam.T).T + t_w2c_v
        n_cs = (R_w2c_v @ norms_cam.T).T
        z = v_cs[:, 2]
        safe_z = np.where(np.abs(z) < 1e-8, -1e-8, z)
        p_u = focal * v_cs[:, 0] / (-safe_z) + 0.5
        p_v = 1.0 - (focal * v_cs[:, 1] / (-safe_z) + 0.5)

        cam_dirs = -v_cs
        cam_dirs_n = cam_dirs / (np.linalg.norm(cam_dirs, axis=1, keepdims=True) + 1e-10)
        norms_n = n_cs / (np.linalg.norm(n_cs, axis=1, keepdims=True) + 1e-10)
        vvis = np.clip(np.sum(norms_n * cam_dirs_n, axis=1), 0, 1) ** 0.8

        view_data.append({
            'pixels': vsrc_pixels, 'w': vsrc_w, 'h': vsrc_h,
            'p_u': p_u, 'p_v': p_v, 'vis': vvis,
            'priority': priority, 'angle': angle_deg,
        })

    n_drawn = 0
    n_skipped = 0
    for fi in range(len(faces)):
        # Do NOT gate on avg_vis here — low visibility from front view doesn't
        # mean invisible from multiview. Let the per-view loop below decide.
        if uv_areas[fi] < 0.1 or not aspect_ok[fi] or not edge_size_ok[fi]:
            n_skipped += 1
            continue

        tri_uv = []
        for vi in range(3):
            px = face_uvs[fi, vi, 0] * tex_res
            py = (1.0 - face_uvs[fi, vi, 1]) * tex_res
            tri_uv.append((px, py))

        v_idx = faces[fi]

        min_x = max(0, int(min(tri_uv[0][0], tri_uv[1][0], tri_uv[2][0])))
        max_x = min(tex_res - 1, int(max(tri_uv[0][0], tri_uv[1][0], tri_uv[2][0])) + 1)
        min_y = max(0, int(min(tri_uv[0][1], tri_uv[1][1], tri_uv[2][1])))
        max_y = min(tex_res - 1, int(max(tri_uv[0][1], tri_uv[1][1], tri_uv[2][1])) + 1)
        if max_x <= min_x or max_y <= min_y:
            continue

        x0, y0 = tri_uv[0]
        x1, y1 = tri_uv[1]
        x2, y2 = tri_uv[2]
        denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(denom) < 1e-10:
            continue
        inv_denom = 1.0 / denom

        ys, xs = np.mgrid[min_y:max_y+1, min_x:max_x+1]
        xsf = xs.astype(np.float64) + 0.5
        ysf = ys.astype(np.float64) + 0.5

        w0 = ((y1 - y2) * (xsf - x2) + (x2 - x1) * (ysf - y2)) * inv_denom
        w1 = ((y2 - y0) * (xsf - x2) + (x0 - x2) * (ysf - y2)) * inv_denom
        w2 = 1.0 - w0 - w1

        mask = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not mask.any():
            continue

        # Sample each view and keep the best per-pixel weight.
        for vd in view_data:
            tri_src_u = [vd['p_u'][v_idx[vi]] for vi in range(3)]
            tri_src_v = [vd['p_v'][v_idx[vi]] for vi in range(3)]
            tri_vis   = [vd['vis'][v_idx[vi]] for vi in range(3)]

            # Skip if face invisible from this view at all 3 verts
            if max(tri_vis) < 0.05:
                continue

            src_u = w0 * tri_src_u[0] + w1 * tri_src_u[1] + w2 * tri_src_u[2]
            src_v = w0 * tri_src_v[0] + w1 * tri_src_v[1] + w2 * tri_src_v[2]
            pt_vis = w0 * tri_vis[0] + w1 * tri_vis[1] + w2 * tri_vis[2]

            in_b = (src_u >= 0) & (src_u <= 1) & (src_v >= 0) & (src_v <= 1)
            src_ix = np.clip((src_u * vd['w']).astype(int), 0, vd['w'] - 1)
            src_iy = np.clip((src_v * vd['h']).astype(int), 0, vd['h'] - 1)

            sampled = vd['pixels'][src_iy, src_ix]
            src_alpha = sampled[..., 3] / 255.0 if sampled.shape[-1] == 4 else 1.0
            w_pixel = pt_vis * src_alpha * vd['priority'] * mask.astype(np.float64) * in_b.astype(np.float64)

            better = w_pixel > weight_arr[ys, xs]
            if not better.any():
                continue
            for c in range(3):
                proj_arr[ys, xs, c] = np.where(better, sampled[..., c], proj_arr[ys, xs, c])
            weight_arr[ys, xs] = np.where(better, w_pixel, weight_arr[ys, xs])

        n_drawn += 1

    log(f'per-pixel multi-view rasterization: {n_drawn}/{len(faces)} faces, {n_skipped} skipped, {len(view_data)} views')

    # Reconstruct PIL images from numpy arrays
    proj_atlas = Image.fromarray(proj_arr.astype(np.uint8))
    weight_atlas = Image.fromarray((weight_arr * 255).clip(0, 255).astype(np.uint8), mode='L')

    # ---------------------------------------------------------------
    # Step 4: Blend projected atlas with SF3D atlas based on weights
    # ---------------------------------------------------------------
    proj_arr = np.asarray(proj_atlas, dtype=np.float64)
    sf3d_arr = np.asarray(sf3d_tex, dtype=np.float64)
    weight_arr = np.asarray(weight_atlas, dtype=np.float64) / 255.0

    # Blend: where the per-pixel weight is non-trivial, use the projected
    # multi-view color. SF3D's own texture is only a last-resort fallback for
    # areas no view could see (inside mouth, between limbs). Prior thresholds
    # (0.2 / 0.05) were too strict and let SF3D dominate 80% of the atlas.
    # Hard override: if ANY view sampled this atlas pixel (weight > tiny
    # threshold), use the projected color at 100%. Otherwise fall back to
    # the SF3D baked texture. Prior smoothstep blend washed out detail on
    # small triangles (head/hair) because their per-pixel weights are low
    # relative to the flat broad torso — the weight magnitude varies with
    # triangle size, not projection quality.
    PIXEL_PRESENT = 0.002
    sharp_mask = weight_arr > PIXEL_PRESENT
    fallback_mask = ~sharp_mask
    w_boosted = sharp_mask.astype(np.float64)
    w3 = w_boosted[:, :, np.newaxis]
    result_arr = (proj_arr * w3 + sf3d_arr * (1.0 - w3)).astype(np.uint8)
    result_img = Image.fromarray(result_arr)
    log(f'blend: sharp={sharp_mask.sum()} fallback={fallback_mask.sum()} total={tex_res*tex_res}')

    log(f'blended, saving...')

    # ---------------------------------------------------------------
    # Step 5: Write texture back into GLB in-place
    # ---------------------------------------------------------------
    import shutil
    if os.path.abspath(mesh_path) != os.path.abspath(output_path):
        shutil.copy(mesh_path, output_path)

    with open(output_path, 'rb') as f:
        data = bytearray(f.read())

    magic = struct.unpack_from('<I', data, 0)[0]
    if magic != 0x46546C67:
        log('ERROR: not GLB'); return False

    offset = 12
    json_chunk = None
    bin_chunk_offset = None
    while offset < len(data):
        chunk_len, chunk_type = struct.unpack_from('<II', data, offset)
        if chunk_type == 0x4E4F534A:
            json_chunk = json.loads(data[offset+8 : offset+8+chunk_len].decode('utf-8'))
        elif chunk_type == 0x004E4942:
            bin_chunk_offset = offset + 8
        offset += 8 + chunk_len

    if json_chunk and bin_chunk_offset:
        images = json_chunk.get('images', [])
        buffer_views = json_chunk.get('bufferViews', [])
        for img_info in images:
            bv_idx = img_info.get('bufferView')
            if bv_idx is None: continue
            bv = buffer_views[bv_idx]
            img_offset = bin_chunk_offset + bv.get('byteOffset', 0)
            img_length = bv['byteLength']

            # Try JPEG first (smaller, good quality)
            buf = io.BytesIO()
            result_img.save(buf, format='JPEG', quality=95)
            new_bytes = buf.getvalue()
            new_mime = 'image/jpeg'

            if len(new_bytes) > img_length:
                buf2 = io.BytesIO()
                result_img.save(buf2, format='JPEG', quality=85)
                new_bytes = buf2.getvalue()

            if len(new_bytes) <= img_length:
                data[img_offset : img_offset + len(new_bytes)] = new_bytes
                data[img_offset + len(new_bytes) : img_offset + img_length] = b'\x00' * (img_length - len(new_bytes))
                img_info['mimeType'] = new_mime
                log(f'texture replaced in-place ({len(new_bytes)}/{img_length} bytes)')
            else:
                old_bin_len = struct.unpack_from('<I', data, bin_chunk_offset - 8)[0]
                new_tex_offset = old_bin_len
                pad = (4 - (len(new_bytes) % 4)) % 4
                new_bin = bytes(data[bin_chunk_offset : bin_chunk_offset + old_bin_len]) + new_bytes + b'\x00' * pad
                bv['byteOffset'] = new_tex_offset
                bv['byteLength'] = len(new_bytes)
                img_info['mimeType'] = new_mime
                json_str = json.dumps(json_chunk).encode('utf-8')
                json_pad = (4 - (len(json_str) % 4)) % 4
                json_chunk_data = json_str + b' ' * json_pad
                data = bytearray()
                data += struct.pack('<III', 0x46546C67, 2, 0)
                data += struct.pack('<II', len(json_chunk_data), 0x4E4F534A)
                data += json_chunk_data
                data += struct.pack('<II', len(new_bin), 0x004E4942)
                data += new_bin
                struct.pack_into('<I', data, 8, len(data))
                log(f'texture replaced (GLB rebuilt, +{len(new_bytes)-img_length} bytes)')
            break

        struct.pack_into('<I', data, 8, len(data))
        with open(output_path, 'wb') as f:
            f.write(data)

    # Save debug
    result_img.save(output_path.replace('.glb', '_tex.png'))

    elapsed = time.time() - t0
    log(f'done in {elapsed:.1f}s')
    return True


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='FabMesh Texture Projection')
    parser.add_argument('mesh', help='Input mesh GLB file')
    parser.add_argument('source_image', help='Source photo (front view)')
    parser.add_argument('output', help='Output GLB file')
    parser.add_argument('resolution', nargs='?', type=int, default=1024,
                        help='Texture resolution (default: 1024)')
    parser.add_argument('--multiview', metavar='DIR', default=None,
                        help='Directory with Zero123++ views (view_0.png..view_5.png)')
    args = parser.parse_args()
    try:
        ok = project_texture(args.mesh, args.source_image, args.output,
                             args.resolution, multiview_dir=args.multiview)
        sys.exit(0 if ok else 1)
    except Exception as e:
        log(f'ERROR: {type(e).__name__}: {e}')
        import traceback; traceback.print_exc()
        sys.exit(2)
