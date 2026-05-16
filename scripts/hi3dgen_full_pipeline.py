"""Hi3DGen full pipeline: image -> mesh + UV + textured atlas.

Hi3DGen produces high-quality bare geometry (no UVs, no texture).
This wrapper adds the missing steps so the output is a textured GLB.

  1. local_hi3dgen_bridge.py -> raw mesh (no UV, no texture)
  2. xatlas UV unwrap
  3. texture_project.py     -> back-project the front photo to UV atlas

Usage:
    python hi3dgen_full_pipeline.py <front_image> <out.glb> [tex_res=1024]
"""
import sys
import os
import time
import subprocess
import numpy as np
import trimesh
import xatlas


SCRIPTS = os.path.dirname(os.path.abspath(__file__))
# Hi3DGen sparse attention requires flash_attn, which only lives in
# the TRELLIS2 venv (built against torch 2.8). The other steps
# (xatlas unwrap, texture_project) run fine in the same venv since
# we already installed their light deps there.
TRELLIS2_VENV_PY = os.path.abspath(os.path.join(
    SCRIPTS, '..', 'external', 'TRELLIS2_win', '.venv', 'Scripts', 'python.exe'
))


def log(msg):
    print(f'[hi3dgen_full] {msg}', flush=True)


def step_hi3dgen(image_path, out_glb):
    log(f'STEP 1: Hi3DGen raw mesh -> {out_glb}')
    bridge = os.path.join(SCRIPTS, 'local_hi3dgen_bridge.py')
    t0 = time.time()
    # Inherit stdout/stderr so progress markers (LOCAL_HI3DGEN_PROGRESS)
    # reach Electron's progress mapper.
    rc = subprocess.run(
        [TRELLIS2_VENV_PY, bridge, image_path, out_glb],
        timeout=600,
    ).returncode
    if rc != 0:
        log(f'Hi3DGen failed with rc={rc}')
        sys.exit(2)
    log(f'STEP 1 done in {time.time()-t0:.1f}s')


def step_unwrap(in_glb, out_glb):
    log('STEP 2: xatlas UV unwrap')
    t0 = time.time()
    m = trimesh.load(in_glb, force='mesh')
    # Hi3DGen outputs mesh with subject facing -Z (TRELLIS convention).
    # FabMesh viewer (Three.js camera at +X+Y+Z) expects facing +Z, so
    # apply Ry(180°) by default. Override via FABMESH_HI3DGEN_ROT_DEG=N.
    rot_deg = float(os.environ.get('FABMESH_HI3DGEN_ROT_DEG', '180'))
    if abs(rot_deg) > 0.5:
        R = trimesh.transformations.rotation_matrix(
            np.radians(rot_deg), [0, 1, 0]
        )
        m.apply_transform(R)
        log(f'  applied Ry({rot_deg}°) to align with viewer convention')
    v = m.vertices.astype(np.float32)
    f = m.faces.astype(np.uint32)
    log(f'  unwrapping {len(v)}v / {len(f)}f...')
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
    log(f'  result: {len(new_mesh.vertices)}v / {len(new_mesh.faces)}f, '
        f'{atlas.chart_count} UV charts, util {atlas.utilization:.1%}')
    new_mesh.export(out_glb)
    log(f'STEP 2 done in {time.time()-t0:.1f}s -> {out_glb}')


def step_texture(mesh_glb, image_path, out_glb, tex_res):
    log(f'STEP 3: bake atlas via texture_project (res={tex_res})')
    t0 = time.time()
    args = [sys.executable, os.path.join(SCRIPTS, 'texture_project.py'),
            mesh_glb, image_path, out_glb, str(tex_res)]
    rc = subprocess.run(args, timeout=600).returncode
    if rc != 0:
        log(f'texture_project failed with rc={rc}')
        sys.exit(3)
    log(f'STEP 3 done in {time.time()-t0:.1f}s')


def main():
    if len(sys.argv) < 3:
        print('Usage: hi3dgen_full_pipeline.py <front_image> <out.glb> [tex_res=1024]')
        sys.exit(1)
    image_path = os.path.abspath(sys.argv[1])
    out_glb = os.path.abspath(sys.argv[2])
    tex_res = int(sys.argv[3]) if len(sys.argv) > 3 else 1024

    out_dir = os.path.dirname(out_glb)
    os.makedirs(out_dir, exist_ok=True)

    raw_glb = os.path.join(out_dir, '_hi3dgen_raw.glb')
    uv_glb = os.path.join(out_dir, '_hi3dgen_uvunwrapped.glb')

    t0 = time.time()
    step_hi3dgen(image_path, raw_glb)
    step_unwrap(raw_glb, uv_glb)
    step_texture(uv_glb, image_path, out_glb, tex_res)
    # Final 100% marker so Electron's progress mapper completes.
    print('LOCAL_HI3DGEN_PROGRESS: 100 done', flush=True)
    log(f'TOTAL: {time.time()-t0:.1f}s -> {out_glb}')


if __name__ == '__main__':
    main()
