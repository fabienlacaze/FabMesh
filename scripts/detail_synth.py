"""
FabMesh Detail Synthesis — render / refine / reproject high-frequency detail.
==============================================================================

Adds GENUINE high-frequency surface detail to a mesh's baked texture, beyond
the TRELLIS-2 generation ceiling, using a three-stage "render -> refine ->
reproject" loop:

  STAGE 1 — RENDER   (nvdiffrast, light GPU ~700 MB)
      Rasterize the mesh WITH its current baked baseColorTexture from N camera
      views, at 1024x1024, into render_<i>.png (white background).

  STAGE 2 — REFINE   (SDXL ControlNet-Tile server, port 5555, ~9.5 GB VRAM)
      POST each render to /img2img_tile. ControlNet-Tile adds micro-detail
      while preserving structure -> view_<i>.png.

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
    return verts_cam, faces, uv, tex_rgb


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


def render_views(verts_cam, faces, uv, tex_rgb, out_dir, res=RENDER_RES):
    """STAGE 1: rasterize each view with nvdiffrast, sample the baked texture,
    write render_<i>.png (RGB, white background). Returns list of paths.

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

        del R_w2c_t, t_w2c_t, clip, rast, uv_interp, color, mask

    # --- free the GPU before SDXL stage ---
    del glctx, verts_t, faces_t, uv_t, tex_t
    torch.cuda.empty_cache()
    log('nvdiffrast context + tensors freed; GPU clear for SDXL stage.')
    return paths


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


def _post_json(url, payload, timeout=600):
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


def refine_views(render_paths, out_dir, prompt, strength, steps, seed=42):
    """STAGE 2: POST each render_<i>.png to /img2img_tile -> view_<i>.png.
    Requires the SDXL server already up (does NOT start it). Returns list of
    view_<i>.png paths.
    """
    if not _sdxl_up():
        log('ERROR: SDXL server is not reachable on '
            f'{SDXL_HOST}:{SDXL_PORT}.')
        log('  Start it first (the human owns VRAM sequencing):')
        log('    python scripts/sdxl_server.py')
        sys.exit(3)

    url = f'http://{SDXL_HOST}:{SDXL_PORT}/img2img_tile'
    view_paths = []
    for i, rp in enumerate(render_paths):
        out_p = os.path.join(out_dir, f'view_{i}.png')
        payload = {
            'input': os.path.abspath(rp),
            'prompt': prompt,
            'output': os.path.abspath(out_p),
            'strength': strength,
            'steps': steps,
            'seed': seed,
        }
        log(f'  refining view {i}: {rp} (strength={strength}, steps={steps})')
        status, body = _post_json(url, payload)
        if status != 200 or not (isinstance(body, dict) and body.get('ok')):
            log(f'ERROR: /img2img_tile failed for view {i} '
                f'(HTTP {status}): {body}')
            sys.exit(4)
        if not os.path.exists(out_p):
            log(f'ERROR: server reported ok but {out_p} is missing.')
            sys.exit(4)
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
    proc = subprocess.run(cmd, text=True, env=os.environ.copy())
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
    verts_cam, faces, uv, tex_rgb = load_mesh_for_render(mesh_path)
    log(f'mesh: {len(verts_cam)} verts, {len(faces)} faces, '
        f'tex {tex_rgb.shape[1]}x{tex_rgb.shape[0]}')
    render_paths = render_views(verts_cam, faces, uv, tex_rgb, work,
                                res=RENDER_RES)
    views_json = write_views_json(work)

    if args.render_only:
        log('--render-only: stage 1 done. Inspect:')
        for p in render_paths:
            log(f'  {p}')
        log(f'  {views_json}')
        log('Verify the orientation matches what texture_project expects '
            '(front face at view_0, etc.) BEFORE running the full pipeline.')
        return

    # --- STAGE 2: refine ---
    log('STAGE 2: refine (SDXL ControlNet-Tile, port 5555)')
    view_paths = refine_views(render_paths, work, args.prompt, args.strength,
                              args.steps, seed=args.seed)

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
