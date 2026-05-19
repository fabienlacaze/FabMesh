"""Render 6 orthographic views from a 3D mesh.

Plan D step 1: take a mesh (typically a TRELLIS-2 single-shot "v1" mesh)
and render 6 strict-orthographic views (front, back, right, left, top,
bottom) via pyrender. These views are pixel-perfect orthogonal by
construction — no AI, no perspective, no hallucination — and serve as
input for a second TRELLIS-2 pass via `pipeline.get_cond([list])`.

Usage:
    python scripts/multiview_from_mesh.py <mesh.glb> <output_dir>
        [--size 1024] [--bg white|transparent]

Outputs:
    <output_dir>/view_0.png   front  (azim=0,   elev=0)
    <output_dir>/view_1.png   back   (azim=180, elev=0)
    <output_dir>/view_2.png   right  (azim=90,  elev=0)
    <output_dir>/view_3.png   left   (azim=270, elev=0)
    <output_dir>/view_4.png   top    (azim=0,   elev=90)
    <output_dir>/view_5.png   bottom (azim=0,   elev=-90)
    <output_dir>/views.json   slot -> orientation mapping

License: pyrender (MIT) + trimesh (MIT). 100% commercial-safe.
"""
import argparse
import json
import os
import sys
import time

import numpy as np
import trimesh
from PIL import Image


# Slot convention matches multiview_sheet_gen.py / hi3dgen_full_pipeline /
# trellis2_native_full_pipeline.
SLOTS = [
    ('front',  0.0,    0.0),
    ('back',   180.0,  0.0),
    ('right',  90.0,   0.0),
    ('left',   270.0,  0.0),
    ('top',    0.0,    89.999),
    ('bottom', 0.0,   -89.999),
]


def log(msg):
    print(f'[mv_from_mesh] {msg}', flush=True)


def _look_at(eye, target, up):
    """OpenGL-style camera-to-world matrix (4x4)."""
    eye, target, up = (np.asarray(v, dtype=np.float64) for v in (eye, target, up))
    f = target - eye
    f /= np.linalg.norm(f)
    s = np.cross(f, up)
    s /= np.linalg.norm(s)
    u = np.cross(s, f)
    M = np.eye(4)
    M[:3, 0] = s
    M[:3, 1] = u
    M[:3, 2] = -f       # OpenGL: camera looks down -Z
    M[:3, 3] = eye
    return M


def _camera_pose(azim_deg, elev_deg, radius):
    """Spherical → cartesian. azim around Y, elev from XZ plane."""
    az = np.radians(azim_deg)
    el = np.radians(elev_deg)
    x = radius * np.cos(el) * np.sin(az)
    y = radius * np.sin(el)
    z = radius * np.cos(el) * np.cos(az)
    eye = np.array([x, y, z], dtype=np.float64)
    target = np.zeros(3, dtype=np.float64)
    # up = (0, 1, 0) sauf quand on regarde droit en haut ou en bas
    if abs(elev_deg) > 85:
        up = np.array([0.0, 0.0, -1.0 if elev_deg > 0 else 1.0])
    else:
        up = np.array([0.0, 1.0, 0.0])
    return _look_at(eye, target, up)


def render_orthographic_views(mesh_path, output_dir, size=1024, bg='white'):
    """Render the 6 ortho views of <mesh_path> into <output_dir>."""
    import pyrender  # heavy import deferred so --help is fast

    os.makedirs(output_dir, exist_ok=True)
    log(f'mesh={mesh_path}')
    log(f'out_dir={output_dir}')
    log(f'size={size} bg={bg}')

    # Load + normalize the mesh
    scene_tm = trimesh.load(mesh_path, force='scene')
    if hasattr(scene_tm, 'geometry') and not scene_tm.geometry:
        log('ERROR: empty scene'); sys.exit(2)

    # Compute the bounding box, then center + scale to unit
    bounds = scene_tm.bounds
    center = (bounds[0] + bounds[1]) / 2.0
    extent = np.max(bounds[1] - bounds[0])
    if extent <= 0:
        log('ERROR: zero extent mesh'); sys.exit(3)
    scale = 1.0 / extent
    log(f'mesh extent={extent:.3f}  scale={scale:.3f}')

    # Build pyrender scene
    bg_color = ([1.0, 1.0, 1.0, 1.0] if bg == 'white'
                else [0.0, 0.0, 0.0, 0.0])
    scene = pyrender.Scene(
        bg_color=bg_color,
        ambient_light=np.array([0.5, 0.5, 0.5, 1.0]),
    )
    # Apply normalization (center then scale)
    M_norm = np.eye(4)
    M_norm[:3, 3] = -center * scale
    M_norm[:3, :3] *= scale

    # Add every geometry as a pyrender Mesh
    for name, geom in (scene_tm.geometry.items() if hasattr(scene_tm, 'geometry')
                        else [('mesh', scene_tm)]):
        pm = pyrender.Mesh.from_trimesh(geom, smooth=False)
        scene.add(pm, pose=M_norm)

    # Soft directional light from above + side, neutral white
    light = pyrender.DirectionalLight(color=np.ones(3), intensity=3.0)
    light_pose = _camera_pose(35, 35, 5.0)
    scene.add(light, pose=light_pose)
    light2 = pyrender.DirectionalLight(color=np.ones(3), intensity=2.0)
    scene.add(light2, pose=_camera_pose(-145, 25, 5.0))

    # Orthographic camera — half-extent slightly > 0.5 so the unit mesh fits
    # with a little padding.
    ortho_half = 0.6
    cam = pyrender.OrthographicCamera(xmag=ortho_half, ymag=ortho_half,
                                       znear=0.01, zfar=100.0)
    cam_node = scene.add(cam, pose=np.eye(4))

    # Offscreen renderer
    r = pyrender.OffscreenRenderer(viewport_width=size, viewport_height=size)

    views_meta = {'engine': 'pyrender_ortho', 'views': []}
    t0 = time.time()
    for i, (label, az, el) in enumerate(SLOTS):
        pose = _camera_pose(az, el, radius=2.0)
        scene.set_pose(cam_node, pose=pose)
        color, depth = r.render(scene,
                                 flags=pyrender.RenderFlags.RGBA)
        img = Image.fromarray(color, mode='RGBA')
        if bg == 'white':
            img = img.convert('RGB')
        out_p = os.path.join(output_dir, f'view_{i}.png')
        img.save(out_p)
        log(f'view_{i} ({label}, az={az:.0f}, el={el:.0f}) -> {out_p}')
        views_meta['views'].append({'azim': az, 'elev': el, 'label': label})

    r.delete()

    with open(os.path.join(output_dir, 'views.json'), 'w', encoding='utf-8') as f:
        json.dump(views_meta, f, indent=2)
    log(f'TOTAL {time.time()-t0:.2f}s — 6 views written')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('mesh')
    ap.add_argument('output_dir')
    ap.add_argument('--size', type=int, default=1024)
    ap.add_argument('--bg', choices=['white', 'transparent'], default='white')
    args = ap.parse_args()

    if not os.path.isfile(args.mesh):
        log(f'ERROR: mesh not found: {args.mesh}')
        sys.exit(1)
    render_orthographic_views(args.mesh, args.output_dir,
                              size=args.size, bg=args.bg)


if __name__ == '__main__':
    main()
