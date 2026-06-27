"""
FabMesh Detail Synthesis — render / refine / reproject high-frequency detail.
==============================================================================

Adds GENUINE high-frequency surface detail to a mesh's baked texture, beyond
the TRELLIS-2 generation ceiling, using a three-stage "render -> refine ->
reproject" loop:

  STAGE 1 — RENDER   (nvdiffrast, light GPU ~700 MB)
      Rasterize the mesh WITH its current baked baseColorTexture from N camera
      views, at 1024x1024, into render_<i>.png (white background).

  STAGE 2 — REFINE   (SDXL server, port 5555, ~9.5-11 GB VRAM)
      Default (--refiner geo): also render a per-view world-space NORMAL map and
      POST each render to /refine_geo. A ControlNet-Union in NORMAL mode makes
      detail follow REAL surface geometry (no hallucinated runes/glyphs) and an
      IP-Adapter on the reference image keeps it faithful -> view_<i>.png.
      Legacy (--refiner tile): POST to /img2img_tile (ControlNet-Tile adds
      micro-detail while preserving structure).
      HEAD FREEZE (--freeze-head on, default): a per-view head_mask_<i>.png is
      rendered from a per-vertex "head" weight (top of the mesh's tallest axis);
      after refine, the ORIGINAL render is composited back over the head so SDXL
      never degrades the AI-generated face -> original face + refined body.

  STAGE 3 — REPROJECT (texture_project.py --multiview, CPU)
      Write views.json and re-bake the refined views back onto the mesh UV
      atlas. The cameras here MUST match texture_project's reprojection
      cameras exactly, or the re-bake misaligns into garbage.

VRAM SEQUENCING
---------------
nvdiffrast render is light (~700 MB). SDXL tile is ~9.5 GB. texture_project is
pure CPU. This script renders ALL views first (light GPU), then `del`s the
nvdiffrast context + tensors and calls torch.cuda.empty_cache() to free the
GPU BEFORE the SDXL stage runs, then reprojects on CPU. It NEVER holds the
nvdiffrast context and the SDXL pipeline resident at the same time. The SDXL
pipeline lives in a SEPARATE process (sdxl_server.py); we only talk to it over
HTTP, so the only torch state this process owns is the (now-freed) renderer.

CAMERA MATCHING — the load-bearing part
---------------------------------------
texture_project.py projects a source image onto the mesh like this (lines
~590-720):

    verts_cam = R_undo @ vertices            # R_undo = rot_x(90) @ rot_y(-90)
    R_w2c     = R_w2c_base @ rot_x(elev) @ rot_y(-azim)
    cam_pos_w = rot_y(azim) @ rot_x(-elev) @ [distance,0,0]
    t_w2c     = -R_w2c @ cam_pos_w
    cam       = R_w2c @ verts_cam + t_w2c
    p_u       = focal * cam_x / (-cam_z) + 0.5
    p_v       = focal * cam_y / (-cam_z) + 0.5
    p_v       = 1.0 - p_v                     # V flip (image Y top-to-bottom)

with  R_w2c_base = [[0,1,0],[0,0,1],[1,0,0]],  fov_deg = 40, distance = 1.6,
      focal = 0.5 / tan(0.5 * radians(fov_deg)).

To guarantee the reprojection lands on the SAME pixels, this renderer builds
its nvdiffrast clip-space transform from the SAME R_undo, R_w2c, t_w2c, focal
and the SAME V-flip, so that a world vertex's final RENDERED pixel (col,row)
equals texture_project's (p_u, p_v_final) sampling location * image size.
See _project_to_clip() for the exact derivation.

Usage
-----
    python scripts/detail_synth.py <mesh.glb> <out.glb> \
        [--strength 0.35] [--prompt "..."] [--texture-size 4096] \
        [--workdir <dir>] [--keep-front-photo <png>] [--render-only]

    --render-only  : run ONLY stage 1 (render_*.png + views.json). No SDXL,
                     no reproject. Use this FIRST to eyeball camera alignment.
"""
import os
import sys
import json
import math
import socket
import argparse
import tempfile
import subprocess

# If anything from trellis ever gets imported transitively, these must be set
# before that import. We don't import trellis here (only trimesh / nvdiffrast /
# torch / numpy / PIL / requests), but set them defensively so a future edit
# that pulls a trellis util in doesn't crash on attention-backend selection.
os.environ.setdefault('ATTN_BACKEND', 'xformers')
os.environ.setdefault('SPARSE_ATTN_BACKEND', 'spconv')

import numpy as np
from PIL import Image

# requests is preferred; fall back to urllib so the import never hard-fails.
try:
    import requests as _requests
    _HAVE_REQUESTS = True
except Exception:
    _requests = None
    _HAVE_REQUESTS = False
    import urllib.request as _urllib_request
    import urllib.error as _urllib_error


# ---------------------------------------------------------------------------
# Logging — mirror texture_project.py's simple prefixed print() style.
# ---------------------------------------------------------------------------
def log(msg):
    print(f'[detail_synth] {msg}', flush=True)


# ---------------------------------------------------------------------------
# Camera constants — EXACTLY texture_project.py's values (lines ~647-666).
# ---------------------------------------------------------------------------
FOV_DEG = 40.0
DISTANCE = 1.6
FOCAL = 0.5 / math.tan(0.5 * math.radians(FOV_DEG))

R_W2C_BASE = np.array([
    [0.0, 1.0, 0.0],
    [0.0, 0.0, 1.0],
    [1.0, 0.0, 0.0],
], dtype=np.float64)

# 6 views, SAME order as view_0..view_5 / views.json.
#   front, right, back, left, front-up, front-down
VIEWS = [
    (0.0,    0.0),   # view_0  front
    (90.0,   0.0),   # view_1  right
    (180.0,  0.0),   # view_2  back
    (270.0,  0.0),   # view_3  left
    (0.0,   30.0),   # view_4  front-up   (camera looks DOWN)
    (0.0,  -30.0),   # view_5  front-down (camera looks UP)
]

RENDER_RES = 1024


# ---------------------------------------------------------------------------
# Rotation helpers — IDENTICAL conventions to texture_project.py rot_x/rot_y
# (degrees, right-handed). Reproduced here so the math is bit-faithful.
# ---------------------------------------------------------------------------
def rot_x(deg):
    r = math.radians(deg)
    c, s = math.cos(r), math.sin(r)
    return np.array([
        [1, 0, 0],
        [0, c, -s],
        [0, s, c],
    ], dtype=np.float64)


def rot_y(deg):
    r = math.radians(deg)
    c, s = math.cos(r), math.sin(r)
    return np.array([
        [c, 0, s],
        [0, 1, 0],
        [-s, 0, c],
    ], dtype=np.float64)


def _smoothstep(lo, hi, t):
    """Hermite smoothstep: 0 below lo, 1 above hi, smooth S-curve between.
    Vectorised (t may be a numpy array). Robust if hi<=lo (-> hard step)."""
    if hi <= lo:
        return (np.asarray(t) >= hi).astype(np.float64)
    x = np.clip((np.asarray(t, dtype=np.float64) - lo) / (hi - lo), 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def w2c_for_view(azim_deg, elev_deg):
    """Return (R_w2c, t_w2c) for an orbited view — EXACTLY as texture_project
    computes them (lines ~685-693)."""
    R_w2c = R_W2C_BASE @ rot_x(elev_deg) @ rot_y(-azim_deg)
    cam_pos_w = (rot_y(azim_deg) @ rot_x(-elev_deg)
                 @ np.array([DISTANCE, 0.0, 0.0], dtype=np.float64))
    t_w2c = -R_w2c @ cam_pos_w
    return R_w2c, t_w2c


# ---------------------------------------------------------------------------
# Mesh loading — match texture_project's R_undo applied to vertices.
# ---------------------------------------------------------------------------
def load_mesh_for_render(mesh_path):
    """Load mesh with trimesh (force='mesh') and return:
        verts_cam : (V,3) float64  vertices AFTER R_undo = rot_x(90)@rot_y(-90)
                    (the SAME frame texture_project projects in — verts_cam)
        faces     : (F,3) int32
        uv        : (V,3) float32  per-vertex UV (V row, only XY used)
        tex_rgb   : (H,W,3) uint8  baseColorTexture (white if none)
        norm_cam  : (V,3) float64  per-vertex normals rotated by R_undo (so they
                    live in the SAME verts_cam frame). Per-view we rotate these
                    again by R_w2c (rotation only) to get view-space normals for
                    the geometry-guided refine ControlNet.
        head_weight : (V,) float64 in [0,1]  1 = head/face/beard region (FROZEN,
                    keep original), 0 = body (refined). A smoothstep over the
                    mesh's tallest axis (top ~26-38% of height -> ~1). Used to
                    composite the ORIGINAL render back over the refined view so
                    SDXL never touches the (fragile AI-generated) face. It's a
                    per-vertex SCALAR, so R_undo doesn't rotate it — it's indexed
                    by the same vertex order as verts_cam.

    NOTE on R_undo: texture_project applies it to recover SF3D's internal
    camera frame before projecting (verts_cam = R_undo @ vertices). The render
    MUST live in the same frame, so we apply it here too. If the mesh carries
    one of the alternate-undo env flags (FABMESH_TEXPROJ_SKIP_UNDO /
    FABMESH_TEXPROJ_HI3DGEN_UNDO), honour the SAME branch so we stay aligned.
    """
    import trimesh

    scene_or_mesh = trimesh.load(mesh_path, force='mesh', process=False)
    if isinstance(scene_or_mesh, trimesh.Scene):
        # force='mesh' should already concatenate; guard anyway.
        scene_or_mesh = scene_or_mesh.dump(concatenate=True)
    mesh = scene_or_mesh

    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces, dtype=np.int32)

    # UVs
    uv = None
    try:
        if (mesh.visual is not None
                and getattr(mesh.visual, 'uv', None) is not None):
            uv = np.asarray(mesh.visual.uv, dtype=np.float32)
    except Exception:
        uv = None
    if uv is None or len(uv) != len(vertices):
        raise RuntimeError(
            'mesh has no per-vertex UVs matching vertex count — cannot render '
            'its baked texture. (got uv=%s for %d verts)'
            % (None if uv is None else uv.shape, len(vertices)))

    # baseColorTexture image
    tex_rgb = None
    try:
        material = getattr(mesh.visual, 'material', None)
        img = None
        if material is not None:
            img = getattr(material, 'baseColorTexture', None)
            if img is None:
                img = getattr(material, 'image', None)
        if img is not None:
            tex_rgb = np.asarray(Image.fromarray(np.asarray(img)).convert('RGB'),
                                 dtype=np.uint8)
    except Exception as e:
        log(f'WARNING: could not read baseColorTexture ({e}); using white')
        tex_rgb = None
    if tex_rgb is None:
        log('WARNING: mesh has no baseColorTexture — rendering white. '
            '(detail synth needs a baked texture to refine.)')
        tex_rgb = np.full((1024, 1024, 3), 255, dtype=np.uint8)

    # R_undo — SAME branch logic as texture_project.py (lines ~575-593).
    if os.environ.get('FABMESH_TEXPROJ_SKIP_UNDO') == '1':
        R_undo = np.eye(3, dtype=np.float64)
        log('R_undo: identity (FABMESH_TEXPROJ_SKIP_UNDO=1)')
    elif os.environ.get('FABMESH_TEXPROJ_HI3DGEN_UNDO') == '1':
        R_inv = np.array([[1.0, 0.0, 0.0],
                          [0.0, 0.0, 1.0],
                          [0.0, -1.0, 0.0]], dtype=np.float64)
        R_y180 = np.array([[1.0, 0.0, 0.0],
                           [0.0, -1.0, 0.0],
                           [0.0, 0.0, -1.0]], dtype=np.float64)
        R_undo = R_y180 @ R_inv
        log('R_undo: Hi3DGen inverse pose + Y-flip (FABMESH_TEXPROJ_HI3DGEN_UNDO=1)')
    else:
        R_undo = rot_x(90) @ rot_y(-90)
        log('R_undo: rot_x(90) @ rot_y(-90) (default, matches texture_project)')

    verts_cam = (R_undo @ vertices.T).T  # (V,3)

    # Per-vertex world-space NORMALS, rotated into the verts_cam frame by the
    # SAME R_undo. Normals transform by the rotation only (no translation) and
    # R_undo is a pure rotation, so (R_undo @ n) is correct without an
    # inverse-transpose. trimesh computes vertex_normals lazily (area-weighted
    # from faces); guard against degenerate meshes that return an empty array.
    try:
        vnorm = np.asarray(mesh.vertex_normals, dtype=np.float64)
    except Exception as e:
        log(f'WARNING: vertex_normals unavailable ({e}); using +Z up')
        vnorm = None
    if vnorm is None or vnorm.shape != vertices.shape:
        # Fallback: flat +Z so the normal map is at least a valid neutral image.
        vnorm = np.tile(np.array([0.0, 0.0, 1.0]), (len(vertices), 1))
    norm_cam = (R_undo @ vnorm.T).T  # (V,3), same frame as verts_cam
    # Re-normalise (R_undo is orthonormal so this is just numerical hygiene).
    _n = np.linalg.norm(norm_cam, axis=1, keepdims=True)
    norm_cam = norm_cam / np.clip(_n, 1e-8, None)

    # --- HEAD / FACE FREEZE weight (per-vertex scalar) ---------------------
    # SDXL ControlNet (tile AND geo/normal) destroys AI-generated faces no
    # matter the params. The fix: never refine the head — composite the
    # ORIGINAL render back over the head region. head_weight ~1 there.
    #
    # Pick the VERTICAL axis as the one with the LARGEST vertex extent (robust
    # for a standing humanoid without assuming Y-up vs Z-up), normalise that
    # coord to [0,1] across the mesh, then smoothstep so the top ~26-38% of the
    # height (head + hat + most of the beard) -> ~1 with a feathered transition.
    # Computed on the ORIGINAL mesh frame (vertices) — it's a scalar indexed by
    # the same vertex order as verts_cam, so R_undo (a frame rotation) is
    # irrelevant to it.
    try:
        lo = float(os.environ.get('FABMESH_FREEZE_HEAD_LO', '0.62'))
        hi = float(os.environ.get('FABMESH_FREEZE_HEAD_HI', '0.74'))
        extents = vertices.max(axis=0) - vertices.min(axis=0)  # (3,)
        up_axis = int(np.argmax(extents))
        span = float(extents[up_axis])
        if span <= 1e-8:
            log('WARNING: mesh has no measurable vertical extent — head freeze '
                'weight all-zero (freeze will be a no-op).')
            head_weight = np.zeros(len(vertices), dtype=np.float64)
        else:
            coord = vertices[:, up_axis]
            t = (coord - coord.min()) / span        # 0 at bottom, 1 at top
            head_weight = _smoothstep(lo, hi, t)     # (V,) in [0,1]
            log(f'head freeze: up_axis={["X","Y","Z"][up_axis]} '
                f'(extents={extents.round(3).tolist()}), smoothstep[{lo:.2f},{hi:.2f}], '
                f'frozen verts={(head_weight > 0.5).sum()}/{len(vertices)}')
    except Exception as e:
        log(f'WARNING: head-freeze weight failed ({e}); freeze disabled.')
        head_weight = np.zeros(len(vertices), dtype=np.float64)

    return verts_cam, faces, uv, tex_rgb, norm_cam, head_weight


# ---------------------------------------------------------------------------
# STAGE 1 — render with nvdiffrast.
# ---------------------------------------------------------------------------
def _project_to_clip(verts_cam_t, R_w2c_t, t_w2c_t, focal, near=0.05, far=10.0):
    """Map camera-frame verts -> nvdiffrast clip-space (homogeneous, V,4).

    DERIVATION (this is the crux of the camera match).

    texture_project samples a source image at:
        cam   = R_w2c @ verts_cam + t_w2c          # camera coords
        p_u   = focal * cam_x / (-cam_z) + 0.5     # in [0,1], +u to the right
        p_v   = focal * cam_y / (-cam_z) + 0.5     # in [0,1] BEFORE flip
        p_v   = 1.0 - p_v                          # final V (image top = row 0)
    i.e. the image is seen looking down -Z (objects have cam_z < 0 in front),
    +x maps to +u (right), +y maps to +p_v-before-flip (up in NDC terms).

    nvdiffrast.rasterize takes CLIP coords (x_c,y_c,z_c,w_c); it divides by w_c
    to get NDC in [-1,1], and the OUTPUT raster tensor has:
        - column index increasing with NDC x   (left -> right)
        - ROW 0 at the BOTTOM (NDC y = -1), row H-1 at the TOP (NDC y = +1)
          (nvdiffrast/OpenGL convention: +y is up, origin bottom-left).

    We want the rendered image, AFTER we flip it to a normal top-left-origin
    PNG, to have a pixel at (col,row) whose (col/W, row/H) == (p_u, p_v_final)
    for the world vertex there. Build clip coords so:

        ndc_x = 2*p_u - 1 = 2*(focal*cam_x/(-cam_z) + 0.5) - 1
                          = 2*focal*cam_x/(-cam_z)
        ndc_y_gl = up direction. We pick ndc_y_gl so that nvdiffrast's
                   bottom-left-origin buffer, once vertically flipped to a
                   top-left PNG, reproduces p_v_final.

    Let p_v_raw = focal*cam_y/(-cam_z) + 0.5  (in [0,1], BEFORE the 1-p_v flip).
    Then p_v_final = 1 - p_v_raw.
    A top-left-origin PNG row index satisfies  row/H = p_v_final.
    nvdiffrast buffer row r_gl maps to NDC y = (2*r_gl/H + ... ) increasing
    upward; r_gl = 0 is NDC y = -1 (bottom). When we np.flipud() the buffer to
    get a top-left PNG, png_row = H-1-r_gl, so png_row/H increases as r_gl
    decreases, i.e. as NDC y goes DOWN. We want png_row/H = p_v_final =
    1 - p_v_raw, i.e. png_row/H increases as p_v_raw decreases, i.e. as
    cam_y/(-cam_z) decreases, i.e. as cam_y (for cam_z<0) decreases.

    NDC y in nvdiffrast increases UP. png_row (after flipud) increases as NDC y
    decreases. We need png_row/H to increase as cam_y decreases ->
    NDC y must INCREASE as cam_y increases. So:

        ndc_y_gl = 2*p_v_raw - 1 = 2*focal*cam_y/(-cam_z)

    and we flipud() the rendered buffer before saving. With cam_z<0, set
        w_c   = -cam_z          (positive depth -> perspective divide by depth)
        x_c   = 2*focal*cam_x
        y_c   = 2*focal*cam_y
        z_c   = w_c*(far+near)/(far-near) - 2*far*near/(far-near)   (std GL z)
    Then ndc_x = x_c/w_c = 2*focal*cam_x/(-cam_z) = 2*p_u-1.   OK.
         ndc_y = y_c/w_c = 2*focal*cam_y/(-cam_z) = 2*p_v_raw-1. OK.

    So: render, then np.flipud the buffer -> a top-left PNG whose
    (col/W,row/H) == (p_u, p_v_final). This is EXACTLY the texel
    texture_project re-samples. Confidence: high for X (u) and Y (v) mapping;
    the one thing to eyeball with --render-only is the vertical handedness
    (whether the flipud is needed or doubled) — see module docstring.
    """
    import torch

    cam = (R_w2c_t @ verts_cam_t.T).T + t_w2c_t       # (V,3), camera coords
    cam_x = cam[:, 0]
    cam_y = cam[:, 1]
    cam_z = cam[:, 2]

    w_c = -cam_z                                       # depth (>0 in front)
    x_c = 2.0 * focal * cam_x
    y_c = 2.0 * focal * cam_y
    z_c = w_c * ((far + near) / (far - near)) - (2.0 * far * near / (far - near))

    clip = torch.stack([x_c, y_c, z_c, w_c], dim=1)    # (V,4)
    return clip


def render_views(verts_cam, faces, uv, tex_rgb, out_dir, res=RENDER_RES,
                 norm_cam=None, write_normal=True, write_depth=False,
                 head_weight=None, write_head_mask=False):
    """STAGE 1: rasterize each view with nvdiffrast, sample the baked texture,
    write render_<i>.png (RGB, white background). Returns
        (render_paths, normal_paths, depth_paths, head_mask_paths)
    where normal_paths / depth_paths / head_mask_paths are [] when not requested.

    When write_normal and norm_cam are given, ALSO writes a world-space (view-
    space) NORMAL map per view (normal_<i>.png): the geometry control image for
    the /refine_geo ControlNet-Union normal mode. Per view we rotate norm_cam by
    R_w2c (rotation only) so the normal map is in the SAME view frame as the
    colour render, then map [-1,1] -> [0,1] RGB with a neutral (0.5,0.5,1.0)
    background on un-hit pixels.

    When write_head_mask and head_weight are given, ALSO writes a grayscale
    head_mask_<i>.png per view (the per-vertex head_weight interpolated across
    the raster, background 0). The refine stage composites the ORIGINAL render
    back over white (head) pixels so SDXL never touches the face.

    write_depth (optional) writes depth_<i>.png from rast z/w — only needed if
    the refine falls back to a depth ControlNet instead of the union normal one.

    Frees the nvdiffrast context + all GPU tensors before returning so the GPU
    is clear for the SDXL stage.
    """
    import torch
    import nvdiffrast.torch as dr

    if not torch.cuda.is_available():
        raise RuntimeError('CUDA not available — nvdiffrast render needs a GPU.')

    device = torch.device('cuda')
    os.makedirs(out_dir, exist_ok=True)

    # --- upload geometry / texture once ---
    verts_t = torch.tensor(verts_cam, dtype=torch.float32, device=device)  # (V,3)
    faces_t = torch.tensor(faces, dtype=torch.int32, device=device)        # (F,3)
    # Per-vertex normals in the verts_cam frame (for the geometry control map).
    do_normal = bool(write_normal and norm_cam is not None)
    normals_t = None
    if do_normal:
        normals_t = torch.tensor(norm_cam, dtype=torch.float32, device=device)  # (V,3)
    # Per-vertex head-freeze weight (scalar in [0,1]) for the head_mask render.
    do_head = bool(write_head_mask and head_weight is not None
                   and float(np.max(head_weight)) > 1e-6)
    head_w_t = None
    if write_head_mask and head_weight is not None and not do_head:
        log('  head freeze requested but head_weight all-zero — skipping mask.')
    if do_head:
        # (V,1) so dr.interpolate yields a (1,H,W,1) attribute. contiguous() —
        # nvdiffrast requires contiguous attribute tensors (same fix as normals).
        head_w_t = torch.tensor(np.asarray(head_weight, dtype=np.float32)[:, None],
                                dtype=torch.float32, device=device).contiguous()  # (V,1)
    # UV: nvdiffrast.texture expects uv in [0,1] with origin bottom-left and
    # V increasing upward. trimesh/glTF UVs use origin top-left (V down), so
    # flip V to match nvdiffrast's texel sampling.
    uv_xy = np.ascontiguousarray(uv[:, :2].astype(np.float32))
    uv_xy[:, 1] = 1.0 - uv_xy[:, 1]
    uv_t = torch.tensor(uv_xy, dtype=torch.float32, device=device)         # (V,2)

    # Texture tensor for dr.texture: (1, H, W, C) float32 in [0,1].
    tex_t = torch.tensor(tex_rgb.astype(np.float32) / 255.0,
                         dtype=torch.float32, device=device)[None, ...]    # (1,H,W,3)

    glctx = dr.RasterizeCudaContext(device=device)

    paths = []
    normal_paths = []
    depth_paths = []
    head_mask_paths = []
    for i, (azim, elev) in enumerate(VIEWS):
        R_w2c, t_w2c = w2c_for_view(azim, elev)
        R_w2c_t = torch.tensor(R_w2c, dtype=torch.float32, device=device)
        t_w2c_t = torch.tensor(t_w2c, dtype=torch.float32, device=device)

        clip = _project_to_clip(verts_t, R_w2c_t, t_w2c_t, FOCAL)  # (V,4)
        clip = clip[None, ...].contiguous()                        # (1,V,4)

        # Rasterize. rast_out: (1,H,W,4) = (u,v,z/w, triangle_id+1).
        rast, _ = dr.rasterize(glctx, clip, faces_t, resolution=[res, res])

        # Interpolate per-vertex UV across the raster.
        uv_interp, _ = dr.interpolate(uv_t[None, ...], rast, faces_t)  # (1,H,W,2)

        # Sample the baked texture (bilinear).
        color = dr.texture(tex_t, uv_interp, filter_mode='linear')    # (1,H,W,3)

        # Background mask: rast[...,3]==0 means no triangle hit -> white bg.
        mask = (rast[..., 3:4] > 0).float()                           # (1,H,W,1)
        color = color * mask + (1.0 - mask) * 1.0                     # white bg

        img = color[0].clamp(0.0, 1.0).detach().cpu().numpy()         # (H,W,3)
        img = (img * 255.0 + 0.5).astype(np.uint8)
        # nvdiffrast buffer is bottom-left origin (row 0 = bottom). Flip to a
        # standard top-left-origin PNG so (col/W,row/H) == (p_u, p_v_final).
        img = np.flipud(img)

        p = os.path.join(out_dir, f'render_{i}.png')
        Image.fromarray(img, mode='RGB').save(p)
        paths.append(p)
        log(f'  rendered view {i} az={azim:.0f} el={elev:.0f} -> {p}')

        # --- world/view-space NORMAL map (geometry control for /refine_geo) ---
        normal_p = None
        nrm_interp = None
        if do_normal:
            # View-space normals: rotate the verts_cam-frame normals by R_w2c
            # (rotation only — normals ignore translation). R_w2c is orthonormal,
            # so plain rotation is the correct normal transform.
            nrm_view = (R_w2c_t @ normals_t.T).T.contiguous()          # (V,3)
            nrm_interp, _ = dr.interpolate(
                nrm_view[None, ...].contiguous(), rast, faces_t)       # (1,H,W,3)
            n = nrm_interp[0]                                          # (H,W,3)
            # Re-normalise interpolated normals (interpolation shortens them).
            n = n / torch.clamp(torch.linalg.norm(n, dim=-1, keepdim=True), min=1e-6)
            # Map [-1,1] -> [0,1] RGB (standard normal-map encoding).
            n_rgb = (n * 0.5 + 0.5)
            # Neutral background (0.5,0.5,1.0) on un-hit pixels (flat +Z facing
            # the camera) so the ControlNet sees empty space, not garbage.
            neutral = torch.tensor([0.5, 0.5, 1.0], device=device)
            n_rgb = n_rgb * mask[0] + (1.0 - mask[0]) * neutral
            n_np = n_rgb.clamp(0.0, 1.0).detach().cpu().numpy()
            n_np = (n_np * 255.0 + 0.5).astype(np.uint8)
            n_np = np.flipud(n_np)                                     # same flip as colour
            normal_p = os.path.join(out_dir, f'normal_{i}.png')
            Image.fromarray(n_np, mode='RGB').save(normal_p)
            normal_paths.append(normal_p)
            log(f'    + normal map -> {normal_p}')

        # --- optional DEPTH map (only for a depth-controlnet fallback) ---
        if write_depth:
            # rast[...,2] is z/w (NDC depth in [-1,1] over the hit region).
            z = rast[0, ..., 2]                                        # (H,W)
            m2 = mask[0, ..., 0] > 0.5
            if m2.any():
                zmin = z[m2].min()
                zmax = z[m2].max()
                rng = torch.clamp(zmax - zmin, min=1e-6)
                # Near = bright (1.0), far = dark — the diffusers depth controlnet
                # convention. NDC z grows with distance, so invert.
                d = 1.0 - (z - zmin) / rng
            else:
                d = torch.zeros_like(z)
            d = torch.where(m2, d, torch.zeros_like(d))               # black bg
            d_np = d.clamp(0.0, 1.0).detach().cpu().numpy()
            d_np = (d_np * 255.0 + 0.5).astype(np.uint8)
            d_np = np.flipud(d_np)
            depth_p = os.path.join(out_dir, f'depth_{i}.png')
            Image.fromarray(d_np, mode='L').convert('RGB').save(depth_p)
            depth_paths.append(depth_p)
            log(f'    + depth map -> {depth_p}')

        # --- HEAD MASK (frozen region; composited back over the refine) -------
        hw_interp = None
        if do_head:
            # Interpolate the per-vertex head_weight across the raster. The
            # attribute tensor is already contiguous (same requirement as the
            # normal fix). Channel 0 is the scalar weight.
            hw_interp, _ = dr.interpolate(
                head_w_t[None, ...].contiguous(), rast, faces_t)       # (1,H,W,1)
            hwm = hw_interp[0, ..., 0]                                 # (H,W)
            # Background (no triangle hit) -> 0 so only ON-MESH head pixels freeze.
            hwm = hwm * mask[0, ..., 0]
            hw_np = hwm.clamp(0.0, 1.0).detach().cpu().numpy()
            hw_np = (hw_np * 255.0 + 0.5).astype(np.uint8)
            hw_np = np.flipud(hw_np)                                   # same flip as colour
            head_p = os.path.join(out_dir, f'head_mask_{i}.png')
            Image.fromarray(hw_np, mode='L').save(head_p)
            head_mask_paths.append(head_p)
            log(f'    + head mask -> {head_p}')

        del R_w2c_t, t_w2c_t, clip, rast, uv_interp, color, mask
        if nrm_interp is not None:
            del nrm_interp
        if hw_interp is not None:
            del hw_interp

    # --- free the GPU before SDXL stage ---
    del glctx, verts_t, faces_t, uv_t, tex_t
    if normals_t is not None:
        del normals_t
    if head_w_t is not None:
        del head_w_t
    torch.cuda.empty_cache()
    log('nvdiffrast context + tensors freed; GPU clear for SDXL stage.')
    return paths, normal_paths, depth_paths, head_mask_paths


# ---------------------------------------------------------------------------
# views.json — schema texture_project.py reads (lines ~780-788):
#   {"engine": "...", "projection": "perspective",
#    "views": [{"azim": <deg>, "elev": <deg>}, ...]}
# texture_project does: [(float(v['azim']), float(v['elev'])) for v in
#                        schema.get('views', [])]
# Order MUST match view_0..view_5.
# ---------------------------------------------------------------------------
def write_views_json(out_dir):
    schema = {
        'engine': 'detail_synth',
        'projection': 'perspective',
        'views': [{'azim': float(a), 'elev': float(e)} for (a, e) in VIEWS],
    }
    p = os.path.join(out_dir, 'views.json')
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(schema, f, indent=2)
    log(f'wrote {p}: {[ (a,e) for (a,e) in VIEWS ]}')
    return p


# ---------------------------------------------------------------------------
# STAGE 2 — refine via SDXL ControlNet-Tile server (port 5555).
# ---------------------------------------------------------------------------
SDXL_HOST = '127.0.0.1'
SDXL_PORT = 5555


def _sdxl_up(host=SDXL_HOST, port=SDXL_PORT, timeout=2.0):
    """TCP connect test — returns True if the SDXL server accepts connections."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _post_json(url, payload, timeout=1200):
    """POST JSON, return (status_code, parsed_dict_or_text). Uses requests if
    available, else urllib."""
    if _HAVE_REQUESTS:
        r = _requests.post(url, json=payload, timeout=timeout)
        try:
            return r.status_code, r.json()
        except Exception:
            return r.status_code, r.text
    else:
        data = json.dumps(payload).encode('utf-8')
        req = _urllib_request.Request(
            url, data=data, headers={'Content-Type': 'application/json'},
            method='POST')
        try:
            with _urllib_request.urlopen(req, timeout=timeout) as resp:
                body = resp.read().decode('utf-8')
                try:
                    return resp.status, json.loads(body)
                except Exception:
                    return resp.status, body
        except _urllib_error.HTTPError as e:
            body = e.read().decode('utf-8', 'replace')
            try:
                return e.code, json.loads(body)
            except Exception:
                return e.code, body


def refine_views(render_paths, out_dir, prompt, strength, steps, seed=42,
                 refiner='geo', normal_paths=None, reference=None,
                 controlnet_scale=0.8, ip_scale=0.6,
                 control_guidance_end=1.0, head_mask_paths=None):
    """STAGE 2: refine each render_<i>.png -> view_<i>.png via the SDXL server.

    refiner='geo'  (default): POST to /refine_geo — GEOMETRY-GUIDED. Passes the
        per-view normal map (normal_<i>.png) as the ControlNet-Union normal
        control, and `reference` (or the front view) as the IP-Adapter image.
        Detail follows REAL geometry; the ref keeps it faithful. This replaces
        the hallucination-prone ControlNet-Tile path.
    refiner='tile' (legacy): POST to /img2img_tile (the old behaviour).

    HEAD FREEZE: when head_mask_paths is given, AFTER each view is refined we
    composite the ORIGINAL render_<i> back over the head region:
        final = render_i * head_mask + view_i * (1 - head_mask)
    so SDXL never touches the (fragile AI-generated) face — the head stays the
    original texture, only the body/clothes get refined. Applies to BOTH
    refiners. Overwrites view_<i>.png in place.

    Requires the SDXL server already up (does NOT start it). Returns list of
    view_<i>.png paths.
    """
    if not _sdxl_up():
        log('ERROR: SDXL server is not reachable on '
            f'{SDXL_HOST}:{SDXL_PORT}.')
        log('  Start it first (the human owns VRAM sequencing):')
        log('    python scripts/sdxl_server.py')
        sys.exit(3)

    use_geo = (refiner == 'geo')
    if use_geo and not normal_paths:
        log('WARNING: refiner=geo but no normal maps were rendered; '
            'falling back to /img2img_tile (tile).')
        use_geo = False

    # IP-Adapter reference: explicit --reference if given (and exists), else the
    # refined-source FRONT render (view_0's input render_0) as a weak ref.
    ref_abs = None
    if use_geo:
        if reference and os.path.exists(reference):
            ref_abs = os.path.abspath(reference)
        elif render_paths:
            # Weak self-reference: the front render. Keeps the IP-Adapter on so
            # texture stays anchored to the model's own colours/material.
            ref_abs = os.path.abspath(render_paths[0])
        if ref_abs:
            log(f'  IP-Adapter reference: {ref_abs}')
        else:
            log('  no IP-Adapter reference -> controlnet-only refine')

    endpoint = '/refine_geo' if use_geo else '/img2img_tile'
    url = f'http://{SDXL_HOST}:{SDXL_PORT}{endpoint}'
    view_paths = []
    for i, rp in enumerate(render_paths):
        out_p = os.path.join(out_dir, f'view_{i}.png')
        if use_geo:
            ctrl = normal_paths[i] if i < len(normal_paths) else None
            if not ctrl or not os.path.exists(ctrl):
                log(f'ERROR: normal map for view {i} missing ({ctrl}).')
                sys.exit(4)
            payload = {
                'input': os.path.abspath(rp),
                'control': os.path.abspath(ctrl),
                'prompt': prompt,
                'output': os.path.abspath(out_p),
                'strength': strength,
                'controlnet_scale': controlnet_scale,
                'ip_scale': ip_scale,
                'steps': steps,
                'seed': seed,
                'control_guidance_end': control_guidance_end,
            }
            if ref_abs:
                payload['ref'] = ref_abs
            log(f'  refining view {i} (geo): {rp} ctrl={os.path.basename(ctrl)} '
                f'(s={strength}, cns={controlnet_scale}, ip={ip_scale}, steps={steps})')
        else:
            payload = {
                'input': os.path.abspath(rp),
                'prompt': prompt,
                'output': os.path.abspath(out_p),
                'strength': strength,
                'steps': steps,
                'seed': seed,
            }
            log(f'  refining view {i} (tile): {rp} (strength={strength}, steps={steps})')
        status, body = _post_json(url, payload)
        if status != 200 or not (isinstance(body, dict) and body.get('ok')):
            log(f'ERROR: {endpoint} failed for view {i} '
                f'(HTTP {status}): {body}')
            sys.exit(4)
        if not os.path.exists(out_p):
            log(f'ERROR: server reported ok but {out_p} is missing.')
            sys.exit(4)

        # --- HEAD FREEZE composite (both refiners) ---------------------------
        # final = render_i * head_mask + view_i * (1 - head_mask). Keeps the
        # head/face/beard at the ORIGINAL render pixels so SDXL never degrades
        # the AI-generated face; only the body/clothes carry refined detail.
        hmp = (head_mask_paths[i]
               if (head_mask_paths and i < len(head_mask_paths)) else None)
        if hmp and os.path.exists(hmp):
            try:
                refined = Image.open(out_p).convert('RGB')
                original = Image.open(rp).convert('RGB')
                if original.size != refined.size:
                    original = original.resize(refined.size, Image.LANCZOS)
                hm = Image.open(hmp).convert('L')
                if hm.size != refined.size:
                    hm = hm.resize(refined.size, Image.LANCZOS)
                # Soft seam: a few-px gaussian blur on the mask edge (optional).
                from PIL import ImageFilter as _IF
                hm = hm.filter(_IF.GaussianBlur(3))
                m = (np.asarray(hm, dtype=np.float32) / 255.0)[..., None]  # (H,W,1)
                orig_a = np.asarray(original, dtype=np.float32)
                ref_a = np.asarray(refined, dtype=np.float32)
                blended = orig_a * m + ref_a * (1.0 - m)
                final = Image.fromarray(
                    np.clip(blended, 0, 255).astype(np.uint8), 'RGB')
                final.save(out_p)  # overwrite in place
                frozen_frac = float((m > 0.5).mean() * 100.0)
                log(f'    head-freeze composite ({frozen_frac:.1f}% frozen) '
                    f'-> {out_p}')
            except Exception as e:
                log(f'    WARNING: head-freeze composite failed for view {i} '
                    f'({e}); using refined view as-is.')

        view_paths.append(out_p)
        log(f'    -> {out_p}')
    return view_paths


# ---------------------------------------------------------------------------
# STAGE 3 — reproject via texture_project.py --multiview (CPU).
# ---------------------------------------------------------------------------
def reproject(mesh_path, front_ref, out_glb, multiview_dir, texture_size):
    """STAGE 3: call texture_project.py to re-bake the refined views onto the
    mesh UV atlas. texture_project CLI is:
        python texture_project.py <mesh> <source_image> <output> [resolution]
            --multiview <dir>
    NOTE: 'resolution' is a POSITIONAL argument (default 1024), not a flag.
    Streams texture_project's stdout/stderr (no capture).
    """
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          'texture_project.py')
    cmd = [
        sys.executable, script,
        mesh_path,
        front_ref,
        out_glb,
        str(int(texture_size)),
        '--multiview', multiview_dir,
    ]
    log('reproject: ' + ' '.join(f'"{c}"' if ' ' in c else c for c in cmd))
    # Pass the env through (texture_project honours FABMESH_TEXPROJ_* +
    # FABMESH_UV_REPACK_MAX_FACES for the xatlas-skip on high-poly meshes).
    _env = os.environ.copy()
    # BASE_ATLAS: load the mesh's EXISTING texture as the floor so under-covered
    # regions (thin/sparse geometry — e.g. a skeleton's spine) keep the original
    # bake instead of a dark inpaint patch. This removes the centre seam AND makes
    # detail-synth SAFE: the result is never worse than the input — detail is only
    # ADDED where the 6 views cover well. Default on; set
    # FABMESH_TEXPROJ_BASE_ATLAS=0 in the environment to disable.
    _env.setdefault('FABMESH_TEXPROJ_BASE_ATLAS', '1')
    proc = subprocess.run(cmd, text=True, env=_env)
    if proc.returncode != 0:
        log(f'ERROR: texture_project.py exited rc={proc.returncode}')
        sys.exit(5)
    log(f'reproject done -> {out_glb}')


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description='FabMesh detail synthesis — render / refine / reproject.')
    parser.add_argument('mesh', help='Input mesh GLB (with baked texture)')
    parser.add_argument('output', help='Output GLB')
    parser.add_argument('--strength', type=float, default=0.35,
                        help='SDXL img2img strength (default 0.35)')
    parser.add_argument('--prompt', default=(
        'sharp intricate fine surface detail, crisp high-detail texture, '
        'photoreal material'),
        help='Detail prompt for the ControlNet-Tile refine pass')
    parser.add_argument('--steps', type=int, default=22,
                        help='SDXL inference steps (default 22)')
    parser.add_argument('--seed', type=int, default=42,
                        help='SDXL seed (default 42)')
    parser.add_argument('--refiner', choices=['geo', 'tile'], default='geo',
                        help='Refine path: "geo" (default) = geometry-guided '
                             'normal ControlNet + IP-Adapter (Meshy-style, '
                             'detail follows real surface, no hallucinated '
                             'runes); "tile" = legacy ControlNet-Tile.')
    parser.add_argument('--reference', default=None,
                        help='Source reference image (PNG) for the IP-Adapter in '
                             '--refiner geo. Keeps the refine faithful to the '
                             'reference. If omitted, the front render is used as '
                             'a weak self-reference.')
    parser.add_argument('--controlnet-scale', type=float, default=0.8,
                        help='Normal ControlNet conditioning scale for '
                             '--refiner geo (default 0.8)')
    parser.add_argument('--ip-scale', type=float, default=0.6,
                        help='IP-Adapter scale for --refiner geo (default 0.6)')
    parser.add_argument('--freeze-head', choices=['on', 'off'], default='on',
                        help='Head/face FREEZE (default on): refine only the '
                             'body/clothes and keep the ORIGINAL render for the '
                             'head/face/beard — SDXL ControlNet destroys '
                             'AI-generated faces no matter the params. "off" '
                             'refines the whole mesh (legacy behaviour). '
                             'Thresholds via FABMESH_FREEZE_HEAD_LO/HI.')
    parser.add_argument('--texture-size', type=int, default=4096,
                        help='Reprojection atlas resolution (default 4096)')
    parser.add_argument('--workdir', default=None,
                        help='Working dir for render_*.png / view_*.png / '
                             'views.json (default: temp dir)')
    parser.add_argument('--keep-front-photo', default=None,
                        help='Optional HD front photo to use as the source '
                             'image arg to texture_project (default: view_0). '
                             'texture_project mixes this in at priority 1.0.')
    parser.add_argument('--render-only', action='store_true',
                        help='Run ONLY stage 1 (render_*.png + views.json). '
                             'No SDXL, no reproject. Use FIRST to verify '
                             'camera alignment.')
    args = parser.parse_args()

    mesh_path = os.path.abspath(args.mesh)
    out_glb = os.path.abspath(args.output)
    if not os.path.exists(mesh_path):
        log(f'ERROR: mesh not found: {mesh_path}')
        sys.exit(2)

    # Workdir (multiview dir): default alongside the mesh under a temp dir.
    if args.workdir:
        work = os.path.abspath(args.workdir)
    else:
        work = tempfile.mkdtemp(prefix='detail_synth_')
    os.makedirs(work, exist_ok=True)
    log(f'workdir: {work}')

    # --- STAGE 1: render ---
    log('STAGE 1: render (nvdiffrast)')
    verts_cam, faces, uv, tex_rgb, norm_cam, head_weight = \
        load_mesh_for_render(mesh_path)
    log(f'mesh: {len(verts_cam)} verts, {len(faces)} faces, '
        f'tex {tex_rgb.shape[1]}x{tex_rgb.shape[0]}')
    # Normal maps are the geometry control for --refiner geo; render them unless
    # we're explicitly on the legacy tile path (cheap, but skip if not needed).
    want_normal = (args.refiner == 'geo')
    want_head = (args.freeze_head == 'on')
    render_paths, normal_paths, _depth_paths, head_mask_paths = render_views(
        verts_cam, faces, uv, tex_rgb, work, res=RENDER_RES,
        norm_cam=norm_cam, write_normal=want_normal, write_depth=False,
        head_weight=head_weight, write_head_mask=want_head)
    views_json = write_views_json(work)

    if args.render_only:
        log('--render-only: stage 1 done. Inspect:')
        for p in render_paths:
            log(f'  {p}')
        for p in normal_paths:
            log(f'  {p}')
        for p in head_mask_paths:
            log(f'  {p}')
        log(f'  {views_json}')
        log('Verify the orientation matches what texture_project expects '
            '(front face at view_0, etc.) BEFORE running the full pipeline.')
        if head_mask_paths:
            log('Also eyeball head_mask_*.png: WHITE = frozen (kept original), '
                'BLACK = refined. The head/face/beard should be white.')
        return

    # --- STAGE 2: refine ---
    if args.refiner == 'geo':
        log('STAGE 2: refine (SDXL geometry-guided /refine_geo, port 5555)')
    else:
        log('STAGE 2: refine (SDXL ControlNet-Tile /img2img_tile, port 5555)')
    if want_head:
        log('  head/face FREEZE on: head region kept from original render.')
    view_paths = refine_views(
        render_paths, work, args.prompt, args.strength, args.steps,
        seed=args.seed, refiner=args.refiner, normal_paths=normal_paths,
        reference=args.reference, controlnet_scale=args.controlnet_scale,
        ip_scale=args.ip_scale,
        head_mask_paths=(head_mask_paths if want_head else None))

    # --- STAGE 3: reproject ---
    log('STAGE 3: reproject (texture_project.py --multiview, CPU)')
    # Source-image arg: the HD front photo if provided, else view_0 (refined
    # front). texture_project requires a source image positional arg.
    front_ref = (os.path.abspath(args.keep_front_photo)
                 if args.keep_front_photo else view_paths[0])
    if args.keep_front_photo and not os.path.exists(front_ref):
        log(f'ERROR: --keep-front-photo not found: {front_ref}')
        sys.exit(2)
    reproject(mesh_path, front_ref, out_glb, work, args.texture_size)

    log(f'DONE -> {out_glb}')


if __name__ == '__main__':
    main()
