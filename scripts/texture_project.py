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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from fabmesh_log import Logger
except Exception:
    Logger = None  # Allow the module to keep working even if the helper is missing


def log(msg):
    print(f'[tex_project] {msg}', flush=True)


def project_texture(mesh_path, source_image_path, output_path, tex_res=1024,
                    multiview_dir=None, rotation_offset_deg=0.0):
    _slog = Logger('tex_project',
                   mesh=os.path.basename(mesh_path),
                   res=tex_res,
                   multiview=(os.path.basename(multiview_dir) if multiview_dir else None)) \
            if Logger else None
    def _evt(event, **f):
        if _slog:
            _slog.info(event, **f)
    """Project source photo onto mesh UV atlas and save result.

    If multiview_dir is provided, also projects view_0..view_5.png at their
    respective Zero123++ angles and blends all views weighted by visibility
    and priority.
    """
    import trimesh

    t0 = time.time()
    log(f'mesh={mesh_path} src={source_image_path} out={output_path} res={tex_res}'
        f'{" multiview=" + multiview_dir if multiview_dir else ""}')
    _evt('pipeline_started', mesh_path=mesh_path, source=source_image_path,
         out=output_path, res=tex_res, multiview_dir=multiview_dir)

    # Load mesh
    scene = trimesh.load(mesh_path)
    geoms = list(scene.geometry.values()) if hasattr(scene, 'geometry') else [scene]
    geom = geoms[0]
    _evt('mesh_loaded', verts=len(geom.vertices), faces=len(geom.faces))
    vertices = np.asarray(geom.vertices, dtype=np.float64)
    faces = np.asarray(geom.faces, dtype=np.int32)
    normals = np.asarray(geom.vertex_normals, dtype=np.float64)
    uv = np.asarray(geom.visual.uv, dtype=np.float64)

    log(f'mesh: {len(vertices)} verts, {len(faces)} faces')

    # ---------------------------------------------------------------
    # Optional UV re-unwrap with xatlas
    # ---------------------------------------------------------------
    # SF3D produces atlases with thousands of micro UV islands (often
    # 1-2 faces each). When we project + EDT-dilate onto that, the
    # rendered mesh looks like a voronoi mosaic because Three.js's
    # bilinear filter samples ACROSS the razor-thin island borders.
    # xatlas.parametrize re-packs UVs into a small number of large
    # islands, which makes both projection AND rendering clean.
    #
    # Triggered automatically when the source mesh has more than
    # FABMESH_UV_REPACK_THRESHOLD faces per island on average — i.e.
    # the existing layout is already fragmented. Disable with
    # FABMESH_UV_REPACK=0 to fall back to the original UVs.
    # xatlas re-unwrap is OFF by default: on SF3D meshes it produces a
    # per-triangle chart layout that still renders as mosaic. Keep the
    # 2026-04-17 re-evaluation with CRM multi-views (6 ortho incl. TOP/BOT):
    # xatlas re-chart is now a clear WIN — SF3D's micro-island packing
    # produces voronoi-mosaic atlases (chat_vert, orc_m1 reproduced this)
    # which xatlas collapses into chart-based layout where projection
    # data actually spans contiguous UV regions. Default flipped to ON.
    # Set FABMESH_UV_REPACK=0 to disable.
    _repack_enabled = os.environ.get('FABMESH_UV_REPACK', '1') == '1'
    _repacked = False
    if _repack_enabled and len(faces) > 100:
        try:
            import xatlas
            t_uv = time.time()
            v32 = vertices.astype(np.float32)
            f32 = faces.astype(np.uint32)
            vmap, idx_new, uv_new = xatlas.parametrize(v32, f32)
            n_old = len(vertices)
            n_new = len(vmap)
            vertices = vertices[vmap]
            normals = normals[vmap]
            faces = idx_new.astype(np.int32)
            uv = uv_new.astype(np.float64)
            _repacked = True
            log(f'xatlas re-unwrap: {n_old} -> {n_new} verts, '
                f'{len(faces)} faces, {time.time()-t_uv:.1f}s')
            _evt('xatlas_done',
                 verts_before=n_old, verts_after=n_new,
                 faces=int(len(faces)),
                 ms=int((time.time() - t_uv) * 1000))
        except ImportError:
            log('xatlas not installed, keeping original UVs')
            _evt('xatlas_skipped', reason='not_installed')
        except Exception as ux:
            log(f'xatlas failed: {ux} — keeping original UVs')
            _evt('xatlas_failed', error=type(ux).__name__, msg=str(ux)[:200])

    # Sanity check: UV topology must match vertex topology.
    _max_face_idx = int(faces.max()) + 1 if len(faces) else 0
    _uv_rows = len(uv)
    _vert_rows = len(vertices)
    _topology_ok = (_uv_rows == _vert_rows) and (_max_face_idx <= _uv_rows)
    _evt('uv_topology_check',
         verts=_vert_rows, uv_rows=_uv_rows,
         max_face_idx=_max_face_idx, ok=_topology_ok)
    if not _topology_ok:
        log(f'WARNING: UV/vertex topology mismatch! '
            f'verts={_vert_rows} uv_rows={_uv_rows} '
            f'max_face_idx={_max_face_idx} — atlas will be scrambled.')

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
    # The GT calibration cube is NOT passed through SF3D, so the undo
    # transform would rotate it into the wrong frame. Skip when the env
    # signals a pre-aligned input mesh (set by stage_checks.py stage 4).
    if os.environ.get('FABMESH_TEXPROJ_SKIP_UNDO') == '1':
        R_undo = np.eye(3)
        log('FABMESH_TEXPROJ_SKIP_UNDO=1: skipping SF3D undo transform')
    else:
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
    _basis_override_path = os.environ.get('FABMESH_TEXPROJ_BASIS_OVERRIDE')
    if _basis_override_path and os.path.exists(_basis_override_path):
        import json as _json
        with open(_basis_override_path, 'r', encoding='utf-8') as _f:
            R_w2c_base = np.array(_json.load(_f), dtype=np.float64)
        log(f'R_w2c_base overridden from {_basis_override_path}')
    else:
        R_w2c_base = np.array([
            [0, 1, 0],
            [0, 0, 1],
            [1, 0, 0]
        ], dtype=np.float64)
    t_w2c_base = np.array([0, 0, -distance], dtype=np.float64)

    # -------------------------------------------------------------------
    # Helper: project vertices from an orbited camera viewpoint.
    # azim_deg: azimuth around Y axis (0 = front, 90 = right, ...)
    # elev_deg: elevation above the equator (positive = camera looks DOWN
    #           at subject, negative = looks UP). Zero123++ v1.2 uses
    #           +20° / -10° alternating across its 6 views — ignoring
    #           this pitch was the cause of the mosaic atlas bug.
    # Returns (vertex_colors, visibility) arrays for this view
    # -------------------------------------------------------------------
    def project_single_view(src_pixels, src_w, src_h, azim_deg, elev_deg=0.0):
        """Camera orbit around the subject:
            c2w = Ry(azim) @ Rx(-elev) @ c2w_base
        Inverted to w2c:
            R_w2c = R_w2c_base @ Rx(elev) @ Ry(-azim)
        For non-zero elevation the translation is no longer azimuth-
        invariant, so we recompute it explicitly each time.
        """
        R_w2c = R_w2c_base @ rot_x(elev_deg) @ rot_y(-azim_deg)
        # t_w2c = -R_w2c @ t_c2w (camera-to-world translation)
        # Base c2w sits at +distance on world X axis, then orbited by
        # Ry(azim) @ Rx(-elev). For elev=0 this collapses to the old
        # angle-invariant case, but for non-zero elev the camera height
        # changes and so does the world-space camera centre.
        cam_pos_w = (rot_y(azim_deg) @ rot_x(-elev_deg) @
                     np.array([distance, 0.0, 0.0]))
        t_w2c = -R_w2c @ cam_pos_w

        # Transform vertices to this camera's space
        v_cs = (R_w2c @ verts_cam.T).T + t_w2c  # (V, 3)
        n_cs = (R_w2c @ norms_cam.T).T

        # Perspective projection
        z = v_cs[:, 2]
        safe_z = np.where(np.abs(z) < 1e-8, -1e-8, z)
        p_u = focal * v_cs[:, 0] / (-safe_z) + 0.5
        p_v = focal * v_cs[:, 1] / (-safe_z) + 0.5
        # Run W (2026-04-18): skip V-flip for back-view when requested.
        # For front (azim=0), the standard `p_v = 1 - p_v` maps the
        # image's top row to the mesh's top. For back views (azim=180),
        # that same formula flips the image vertically on the mesh
        # (head ends up at feet). Skip the flip conditionally when
        # FABMESH_TEXPROJ_SKIP_BACK_VFLIP=1 and azim is near 180.
        _is_back_azim = abs(((azim_deg - 180.0 + 180.0) % 360.0) - 180.0) < 10.0
        _skip_back_vflip = (os.environ.get('FABMESH_TEXPROJ_SKIP_BACK_VFLIP') == '1'
                            and _is_back_azim)
        if _skip_back_vflip:
            pass  # p_v left as is (no V flip). U-flip removed in Run Y.
        else:
            p_v = 1.0 - p_v  # flip V (image Y top-to-bottom)
        # Empirical: the front render of the GT cube shows the letter F
        # as a horizontal mirror of the reference. The source image's
        # pixel (u=0, v=v) maps to world-space left, but our camera
        # basis maps that to image-right. A simple U-flip corrects this.
        # Stage 4 calibration validates this on a deterministic input.
        # 2026-04-17 re-test on CRM output: the U-flip that was correct
        # on Z123 calibration in April now DUPLICATES the face onto the
        # back of SF3D meshes (chat_vert: visage visible sur front AND
        # back). Default flipped to OFF. Set FABMESH_TEXPROJ_UFLIP=1 to
        # re-enable the legacy behaviour.
        if os.environ.get('FABMESH_TEXPROJ_UFLIP') == '1':
            p_u = 1.0 - p_u

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
    # Zero123++ v1.2 official view schema (verified in
    # external/InstantMesh/src/utils/camera_util.py:99-100):
    #   azimuth = [30, 90, 150, 210, 270, 330]
    #   elevation = [20, -10, 20, -10, 20, -10]   (alternating)
    # The front input.png stays at (0, 0).
    #
    # If the multiview directory contains views.json (written by
    # multiview_crm_gen.py or any engine that uses non-Zero123 angles)
    # use that schema instead. CRM schema is:
    #   [(0,0), (90,0), (180,0), (270,0), (0,+90), (0,-90)]
    # This adds TOP and BOTTOM coverage which Zero123 cannot produce.
    MULTIVIEW_VIEWS = None
    if multiview_dir:
        _schema_path = os.path.join(multiview_dir, 'views.json')
        if os.path.exists(_schema_path):
            try:
                with open(_schema_path, 'r', encoding='utf-8') as _sf:
                    _schema = json.load(_sf)
                MULTIVIEW_VIEWS = [(float(v['azim']), float(v['elev']))
                                   for v in _schema.get('views', [])]
                log(f'using views.json schema (engine={_schema.get("engine","?")}): {MULTIVIEW_VIEWS}')
            except Exception as _e:
                log(f'views.json read failed: {_e}, falling back to Z123 schema')
    if MULTIVIEW_VIEWS is None:
        MULTIVIEW_VIEWS = [
            (30.0,   20.0),  # view_0
            (90.0,  -10.0),  # view_1
            (150.0,  20.0),  # view_2
            (210.0, -10.0),  # view_3
            (270.0,  20.0),  # view_4
            (330.0, -10.0),  # view_5
        ]
    # Back-compat aliases for code below that still reads MULTIVIEW_ANGLES
    MULTIVIEW_ANGLES = [a for (a, _) in MULTIVIEW_VIEWS]

    # Priority weights: front=1.0, front-side=0.7, side=0.5, back-side=0.4, back views get less
    # The priority downweights views so front dominates where multiple views see the same surface.
    # Keys are (azim, elev) tuples so CRM's top/bottom (elev=+/-90) are handled.
    PRIORITY_WEIGHTS_TUP = {
        (0.0,   0.0):   1.0,   # front (input.png) — HD source image
        (30.0,  20.0):  0.6,   # Z123 front-right
        (330.0, -10.0): 0.6,   # Z123 front-left
        (90.0,  -10.0): 0.9,   # Z123 right
        (270.0, 20.0):  0.9,   # Z123 left
        (150.0, 20.0):  0.8,   # Z123 back-right
        (210.0, -10.0): 0.8,   # Z123 back-left
        # CRM orthographic schema
        (90.0,  0.0):   0.9,   # CRM right
        (180.0, 0.0):   0.8,   # CRM back
        (270.0, 0.0):   0.9,   # CRM left
        (0.0,   90.0):  0.7,   # CRM TOP — unique coverage, never seen elsewhere
        (0.0,  -90.0):  0.7,   # CRM BOTTOM — unique coverage
    }
    # Legacy dict keyed on azim alone (for code paths that only have azim)
    PRIORITY_WEIGHTS = {a: p for (a, _), p in PRIORITY_WEIGHTS_TUP.items()}

    views = []  # list of (image_path, azim_deg, elev_deg, priority)

    # Always include the front view at (0, 0)
    views.append((source_image_path, 0.0, 0.0, PRIORITY_WEIGHTS[0.0]))

    # If the bridge applied an auto-align rotation around Y between SF3D
    # inference and this projection, we must shift every multi-view azimuth
    # by the SAME angle — Zero123++ views were generated from the pre-rotation
    # mesh, so their "az=30°" view actually lands on the mesh at (30° + offset)
    # in the new coordinate frame. Without this compensation, multi-views bleed
    # onto the wrong part of the mesh and wash out detail (user-visible: soft
    # face, blurry head on test_e2e). The source image stays at az=0 because
    # it was projected AFTER rotation from the viewer-front direction.
    if multiview_dir:
        for i, (azim, elev) in enumerate(MULTIVIEW_VIEWS):
            vpath = os.path.join(multiview_dir, f'view_{i}.png')
            if os.path.exists(vpath):
                shifted_azim = (azim + rotation_offset_deg) % 360
                # Priority lookup uses the ORIGINAL (azim, elev) tuple.
                # Falls back to azim-only dict for back-compat, then 0.4.
                prio = PRIORITY_WEIGHTS_TUP.get(
                    (azim, elev),
                    PRIORITY_WEIGHTS.get(azim, 0.4))
                views.append((vpath, shifted_azim, elev, prio))
            else:
                log(f'WARNING: missing {vpath}, skipping')
        if abs(rotation_offset_deg) > 0.5:
            log(f'applied rotation_offset_deg={rotation_offset_deg:.1f}° to multiview azimuths')

    log(f'projecting {len(views)} view(s): ' +
        ', '.join(f'az={v[1]:.0f}/el={v[2]:.0f}(p={v[3]})' for v in views))

    # -------------------------------------------------------------------
    # Step 2b: Project all views and accumulate weighted colors per vertex
    # -------------------------------------------------------------------
    n_verts = len(vertices)
    accum_color = np.zeros((n_verts, 3), dtype=np.float64)
    accum_weight = np.zeros(n_verts, dtype=np.float64)

    for img_path, azim_deg, elev_deg, priority in views:
        src_img = Image.open(img_path).convert('RGBA')
        sw, sh = src_img.size
        sp = np.asarray(src_img)
        log(f'  view az={azim_deg:.0f}/el={elev_deg:.0f}: {img_path} ({sw}x{sh})')

        v_colors, vis = project_single_view(sp, sw, sh, azim_deg, elev_deg)

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
    for img_path, azim_deg, elev_deg, priority in views:
        vsrc_img = Image.open(img_path).convert('RGBA')
        vsrc_w, vsrc_h = vsrc_img.size
        vsrc_pixels = np.asarray(vsrc_img)

        # Full orbit: azimuth around Y + elevation around X (Zero123++
        # alternates +20 / -10 elevation per view — projecting these
        # as pure azimuth produced the mosaic atlas bug).
        R_w2c_v = R_w2c_base @ rot_x(elev_deg) @ rot_y(-azim_deg)
        cam_pos_w = (rot_y(azim_deg) @ rot_x(-elev_deg) @
                     np.array([distance, 0.0, 0.0]))
        t_w2c_v = -R_w2c_v @ cam_pos_w

        v_cs = (R_w2c_v @ verts_cam.T).T + t_w2c_v
        n_cs = (R_w2c_v @ norms_cam.T).T
        z = v_cs[:, 2]
        safe_z = np.where(np.abs(z) < 1e-8, -1e-8, z)
        p_u = focal * v_cs[:, 0] / (-safe_z) + 0.5
        # Run W: conditional V-flip (see same block above around l.281)
        # Run Y: removed X's U-flip. Lateral mirror fix moved to
        # build_mv_dir (pre-flip back.png horizontally).
        _is_back_azim_mv = abs(((azim_deg - 180.0 + 180.0) % 360.0) - 180.0) < 10.0
        if (os.environ.get('FABMESH_TEXPROJ_SKIP_BACK_VFLIP') == '1'
                and _is_back_azim_mv):
            p_v = focal * v_cs[:, 1] / (-safe_z) + 0.5  # no V flip
        else:
            p_v = 1.0 - (focal * v_cs[:, 1] / (-safe_z) + 0.5)
        # Same U-flip as in project_single_view — calibration stage 4 on
        # the GT cube confirmed the front face texture was horizontally
        # mirrored. The mirror is in the SF3D → GLB axis convention
        # interacting with our camera basis; simplest fix is to flip U.
        # 2026-04-17 re-test on CRM output: the U-flip that was correct
        # on Z123 calibration in April now DUPLICATES the face onto the
        # back of SF3D meshes (chat_vert: visage visible sur front AND
        # back). Default flipped to OFF. Set FABMESH_TEXPROJ_UFLIP=1 to
        # re-enable the legacy behaviour.
        if os.environ.get('FABMESH_TEXPROJ_UFLIP') == '1':
            p_u = 1.0 - p_u

        cam_dirs = -v_cs
        cam_dirs_n = cam_dirs / (np.linalg.norm(cam_dirs, axis=1, keepdims=True) + 1e-10)
        norms_n = n_cs / (np.linalg.norm(n_cs, axis=1, keepdims=True) + 1e-10)
        vvis = np.clip(np.sum(norms_n * cam_dirs_n, axis=1), 0, 1) ** 0.8

        view_data.append({
            'pixels': vsrc_pixels, 'w': vsrc_w, 'h': vsrc_h,
            'p_u': p_u, 'p_v': p_v, 'vis': vvis,
            'priority': priority, 'azim': azim_deg, 'elev': elev_deg,
        })

    # Diagnostic: per-texel source-view index + contribution count.
    # Only allocated when FABMESH_TEXPROJ_DIAG=1 to keep the default
    # memory footprint unchanged for production runs.
    _diag_on = os.environ.get('FABMESH_TEXPROJ_DIAG') == '1'
    if _diag_on:
        source_view_arr = np.full((tex_res, tex_res), 255, dtype=np.uint8)
        coverage_arr = np.zeros((tex_res, tex_res), dtype=np.uint16)
    else:
        source_view_arr = None
        coverage_arr = None

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
        for _vd_idx, vd in enumerate(view_data):
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
                if _diag_on:
                    # Still count contributors even if they don't win
                    contributing = (w_pixel > 0.05) & mask
                    if contributing.any():
                        coverage_arr[ys, xs] = np.where(
                            contributing,
                            coverage_arr[ys, xs] + 1,
                            coverage_arr[ys, xs])
                continue
            for c in range(3):
                proj_arr[ys, xs, c] = np.where(better, sampled[..., c], proj_arr[ys, xs, c])
            weight_arr[ys, xs] = np.where(better, w_pixel, weight_arr[ys, xs])
            if _diag_on:
                source_view_arr[ys, xs] = np.where(
                    better, np.uint8(_vd_idx), source_view_arr[ys, xs])
                contributing = (w_pixel > 0.05) & mask
                coverage_arr[ys, xs] = np.where(
                    contributing,
                    coverage_arr[ys, xs] + 1,
                    coverage_arr[ys, xs])

        n_drawn += 1

    log(f'per-pixel multi-view rasterization: {n_drawn}/{len(faces)} faces, {n_skipped} skipped, {len(view_data)} views')
    _evt('rasterize_done', drawn=n_drawn, skipped=n_skipped,
         total_faces=len(faces), views=len(view_data))

    if _diag_on:
        # 6-colour palette (same hue order as reports/). Index 255 = no-data.
        _palette = np.array([
            [239,  68,  68],   # 0 red    — view 0
            [245, 158,  11],   # 1 amber  — view 1
            [ 34, 197,  94],   # 2 green  — view 2
            [ 14, 165, 233],   # 3 blue   — view 3
            [168,  85, 247],   # 4 purple — view 4
            [236,  72, 153],   # 5 pink   — view 5
            [250, 204,  21],   # 6 yellow — view 6 (front input.png)
        ], dtype=np.uint8)
        src_rgb = np.zeros((tex_res, tex_res, 3), dtype=np.uint8)
        for vi in range(min(len(view_data), len(_palette))):
            m = source_view_arr == vi
            src_rgb[m] = _palette[vi]
        # Emptry texels left black.
        src_img = Image.fromarray(src_rgb)
        src_path = out_mesh_path + '.diag_sourceview.png'
        src_img.save(src_path)
        log(f'diag source-view map saved: {src_path}')

        # Coverage: 0=black, 1=dim red, 2=orange, 3=yellow, 4=light green,
        # 5+=bright green. Clamp to 6 for display.
        cov_clamped = np.clip(coverage_arr, 0, 6).astype(np.uint8)
        cov_palette = np.array([
            [  0,   0,   0],   # 0 — hole
            [127,  30,  30],   # 1 — single view, fragile
            [200, 100,  20],   # 2
            [230, 180,  40],   # 3
            [180, 220,  80],   # 4
            [120, 220, 120],   # 5
            [ 40, 255,  40],   # 6+
        ], dtype=np.uint8)
        cov_rgb = cov_palette[cov_clamped]
        cov_img = Image.fromarray(cov_rgb)
        cov_path = out_mesh_path + '.diag_coverage.png'
        cov_img.save(cov_path)
        log(f'diag coverage map saved: {cov_path}  '
            f'(holes={int((coverage_arr == 0).sum())}, '
            f'single={int((coverage_arr == 1).sum())}, '
            f'multi={int((coverage_arr >= 2).sum())})')

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

    # 2026-04-18 — push-pull Gaussian pyramid fill (replaces EDT-band + SF3D
    # fallback). Diagnosis: hard binary `sharp_mask` + blurred-SF3D fallback
    # on SF3D's micro-island atlas (sharp_ratio typically 5-16%) produced
    # leopard-skin pattern — thousands of 1-3px projected tiles surrounded
    # by blurry SF3D with razor-thin borders. Push-pull pyramid instead
    # fills EVERY unseen pixel with locally-averaged projected color from
    # the multi-view accumulation. SF3D fallback discarded — its blur was
    # the background contrast that made seams visible.
    try:
        from scipy.ndimage import gaussian_filter

        def _push_pull_fill(rgb_f, w_f, levels=6):
            """Push-pull / pyramid fill. Unseen pixels take on the weighted
            average of the nearest projected pixels at ascending scales."""
            # Premultiply: at base level, pixel = rgb * w (zero where unseen).
            pyr_rgb = [rgb_f * w_f[:, :, np.newaxis]]
            pyr_w = [w_f]
            for _ in range(levels):
                # Downsample 2x: sum-pool weights, sum-pool rgb*w.
                rgb_cur = pyr_rgb[-1]
                w_cur = pyr_w[-1]
                h, w = w_cur.shape
                # Pad odd dims before pooling
                if h % 2 or w % 2:
                    pad_h = h % 2; pad_w = w % 2
                    rgb_cur = np.pad(rgb_cur, ((0, pad_h), (0, pad_w), (0, 0)))
                    w_cur = np.pad(w_cur, ((0, pad_h), (0, pad_w)))
                rgb_down = (rgb_cur[0::2, 0::2] + rgb_cur[1::2, 0::2]
                            + rgb_cur[0::2, 1::2] + rgb_cur[1::2, 1::2]) * 0.25
                w_down = (w_cur[0::2, 0::2] + w_cur[1::2, 0::2]
                          + w_cur[0::2, 1::2] + w_cur[1::2, 1::2]) * 0.25
                pyr_rgb.append(rgb_down)
                pyr_w.append(w_down)
            # Walk back up. At each coarser level: normalize rgb=rgb/w where w>0.
            # Upsample and composite back under any pixel whose mask is < threshold.
            out_rgb = None
            out_w = None
            EPS = 1e-6
            for lvl in range(levels, -1, -1):
                rgb_l = pyr_rgb[lvl]
                w_l = pyr_w[lvl]
                # Normalize where we have weight
                safe = w_l > EPS
                rgb_norm = np.zeros_like(rgb_l)
                rgb_norm[safe] = rgb_l[safe] / w_l[safe, np.newaxis]
                if out_rgb is None:
                    out_rgb = rgb_norm
                    out_w = safe.astype(np.float64)
                else:
                    # Upsample (nearest) to next level size
                    target_h, target_w = rgb_norm.shape[:2]
                    from scipy.ndimage import zoom as _zoom
                    up_rgb = np.repeat(np.repeat(out_rgb, 2, axis=0), 2, axis=1)
                    up_w = np.repeat(np.repeat(out_w, 2, axis=0), 2, axis=1)
                    up_rgb = up_rgb[:target_h, :target_w]
                    up_w = up_w[:target_h, :target_w]
                    # Where current level has weight, use it; else use upsampled coarser.
                    cur_w = safe.astype(np.float64)
                    blend = cur_w[:, :, np.newaxis]
                    out_rgb = rgb_norm * blend + up_rgb * (1 - blend)
                    out_w = np.maximum(cur_w, up_w * 0.95)  # coarser has less weight
            return out_rgb

        filled = _push_pull_fill(proj_arr.astype(np.float64),
                                 weight_arr.astype(np.float64))
        # Final composite: where we have a real projected pixel use it crisply;
        # elsewhere use the push-pull fill. Sharp_mask now a narrow cliff to
        # keep small-triangle detail, but the "unseen" region is smoothly
        # filled rather than blurry-SF3D.
        w3 = sharp_mask.astype(np.float64)[:, :, np.newaxis]
        result_arr = np.clip(
            proj_arr * w3 + filled * (1.0 - w3), 0, 255
        ).astype(np.uint8)
        log('fill: push-pull Gaussian pyramid (no SF3D blur leak)')
    except Exception as _dil_e:
        log(f'push-pull unavailable ({_dil_e}), falling back to SF3D baked')
        w3 = sharp_mask.astype(np.float64)[:, :, np.newaxis]
        result_arr = (proj_arr * w3 + sf3d_arr * (1.0 - w3)).astype(np.uint8)

    result_img = Image.fromarray(result_arr)
    log(f'blend: sharp={sharp_mask.sum()} dilated={(~sharp_mask).sum()} total={tex_res*tex_res}')
    _evt('blend_done',
         sharp_px=int(sharp_mask.sum()),
         dilated_px=int((~sharp_mask).sum()),
         total_px=tex_res * tex_res,
         sharp_ratio=float(sharp_mask.sum()) / (tex_res * tex_res))

    log(f'blended, saving...')

    # ---------------------------------------------------------------
    # Step 5: Write GLB
    # ---------------------------------------------------------------
    # If xatlas re-unwrapped the UVs, the geometry has changed (more
    # vertices because of seams) so we cannot write the texture in-place
    # — we have to rebuild the mesh + export. Otherwise, the cheap
    # in-place texture swap below preserves everything else SF3D baked
    # (skinning weights, custom vertex attrs, etc).
    if _repacked:
        import trimesh as _trimesh
        _new_mesh = _trimesh.Trimesh(
            vertices=vertices, faces=faces,
            process=False, validate=False,
        )
        _vis = _trimesh.visual.texture.TextureVisuals(
            uv=uv.astype(np.float32),
            material=_trimesh.visual.material.PBRMaterial(
                baseColorTexture=result_img,
                metallicFactor=0.0,
                roughnessFactor=0.85,
            ),
        )
        _new_mesh.visual = _vis
        _new_mesh.export(output_path, file_type='glb')
        sz = os.path.getsize(output_path)
        log(f'GLB rebuilt with re-packed UVs ({sz} bytes)')
        _evt('glb_rebuilt', bytes=sz)
        return True

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
        # Resolve the baseColorTexture's image index — never overwrite
        # the normal map. (Bug AGENT_LOG 2026-04-15: SF3D orders normal
        # before baseColor sometimes; iterating all images destroyed it.)
        materials_g = json_chunk.get('materials', []) or []
        textures_g = json_chunk.get('textures', []) or []
        base_color_image_idx = 0
        for _mat in materials_g:
            _pbr = _mat.get('pbrMetallicRoughness') or {}
            _bct = _pbr.get('baseColorTexture') or {}
            _ti = _bct.get('index')
            if _ti is not None and _ti < len(textures_g):
                _si = textures_g[_ti].get('source')
                if _si is not None:
                    base_color_image_idx = _si
                    break
        log(f'replacing image[{base_color_image_idx}] only (preserving normal map etc.)')
        for i_img, img_info in enumerate(images):
            if i_img != base_color_image_idx:
                continue
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
    _evt('pipeline_done', total_ms=int(elapsed * 1000), output=output_path)
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
    parser.add_argument('--rotation-offset', type=float, default=0.0,
                        metavar='DEG',
                        help='Azimuth shift (deg) applied to multi-view angles. '
                             'Use when the bridge auto-aligned the mesh around Y '
                             'after Zero123++ generated the views — pass the same '
                             'angle here so multi-views still land on the right '
                             'parts of the rotated mesh.')
    args = parser.parse_args()
    try:
        ok = project_texture(args.mesh, args.source_image, args.output,
                             args.resolution, multiview_dir=args.multiview,
                             rotation_offset_deg=args.rotation_offset)
        sys.exit(0 if ok else 1)
    except Exception as e:
        log(f'ERROR: {type(e).__name__}: {e}')
        import traceback; traceback.print_exc()
        sys.exit(2)
