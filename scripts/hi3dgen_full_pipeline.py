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
    # Tell the bridge it's wrapped so it caps progress markers at 50%
    # (leaving 50-100 for unwrap + texture bake steps).
    env = {**os.environ, 'FABMESH_HI3DGEN_WRAPPED': '1'}
    rc = subprocess.run(
        [TRELLIS2_VENV_PY, bridge, image_path, out_glb],
        timeout=600, env=env,
    ).returncode
    if rc != 0:
        log(f'Hi3DGen failed with rc={rc}')
        sys.exit(2)
    log(f'STEP 1 done in {time.time()-t0:.1f}s')


def step_unwrap(in_glb, out_glb):
    log('STEP 2: xatlas UV unwrap')
    t0 = time.time()
    m = trimesh.load(in_glb, force='mesh')
    # Hi3DGen calls to_trimesh(transform_pose=True) which already aligns
    # the mesh to a standard pose. Apply additional Y rotation if needed
    # via FABMESH_HI3DGEN_ROT_DEG (default 0 — no extra rotation).
    rot_deg = float(os.environ.get('FABMESH_HI3DGEN_ROT_DEG', '0'))
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


def step_mvadapter(image_path, mv_dir):
    """Generate 6 multi-view consistent images via MV-Adapter i2mv-sdxl.
    Returns True on success, False otherwise (caller falls back to single-view).
    Single-view projection leaves ~60% of the Hi3DGen mesh untextured (visible
    holes) because only the front is covered. Multi-view fills sides+back+top+
    bottom from one reference image."""
    log(f'STEP 2.5: MV-Adapter 6 views -> {mv_dir}')
    t0 = time.time()
    script = os.path.join(SCRIPTS, 'multiview_mvadapter_gen.py')
    try:
        rc = subprocess.run(
            [sys.executable, script, image_path, mv_dir],
            timeout=900,
        ).returncode
    except Exception as e:
        log(f'MV-Adapter exception: {e}')
        return False
    if rc != 0:
        log(f'MV-Adapter failed with rc={rc}, falling back to single-view')
        return False
    # Sanity check: confirm view_0..view_5 + views.json all landed.
    expected = [f'view_{i}.png' for i in range(6)] + ['views.json']
    missing = [f for f in expected if not os.path.exists(os.path.join(mv_dir, f))]
    if missing:
        log(f'MV-Adapter output incomplete (missing {missing}), falling back')
        return False
    log(f'STEP 2.5 done in {time.time()-t0:.1f}s')
    return True


def step_texture(mesh_glb, image_path, out_glb, tex_res, mv_dir=None):
    log(f'STEP 3: bake atlas via texture_project (res={tex_res}'
        f'{", multi-view" if mv_dir else ", single-view"})')
    t0 = time.time()
    args = [sys.executable, os.path.join(SCRIPTS, 'texture_project.py'),
            mesh_glb, image_path, out_glb, str(tex_res)]
    if mv_dir:
        args += ['--multiview', mv_dir]
    # Hi3DGen mesh has NO SF3D-style internal transforms, so skip the
    # undo step in texture_project (otherwise it double-rotates the
    # mesh and the front photo lands on the side/wings).
    env = {**os.environ, 'FABMESH_TEXPROJ_SKIP_UNDO': '1'}
    rc = subprocess.run(args, timeout=600, env=env).returncode
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
    mv_dir = os.path.join(out_dir, '_hi3dgen_mv')

    # Skip MV-Adapter if disabled (e.g. testing single-view) via env.
    skip_mv = os.environ.get('FABMESH_HI3DGEN_SKIP_MV') == '1'

    t0 = time.time()
    step_hi3dgen(image_path, raw_glb)
    print('LOCAL_HI3DGEN_PROGRESS: 55 step1_done', flush=True)
    step_unwrap(raw_glb, uv_glb)
    print('LOCAL_HI3DGEN_PROGRESS: 65 unwrap_done', flush=True)
    mv_ok = False if skip_mv else step_mvadapter(image_path, mv_dir)
    print(f'LOCAL_HI3DGEN_PROGRESS: 85 mvadapter_{"done" if mv_ok else "skipped"}',
          flush=True)
    step_texture(uv_glb, image_path, out_glb, tex_res,
                 mv_dir=(mv_dir if mv_ok else None))
    print('LOCAL_HI3DGEN_PROGRESS: 95 texture_done', flush=True)
    # Final 100% marker so Electron's progress mapper completes.
    print('LOCAL_HI3DGEN_PROGRESS: 100 done', flush=True)
    log(f'TOTAL: {time.time()-t0:.1f}s -> {out_glb}')


if __name__ == '__main__':
    main()
    # Force-exit so any non-daemon threads hanging around (xformers/
    # diffusers workers, torch.hub side-effects) don't keep the process
    # alive after we're done. Without this the parent (Electron) waits
    # forever for the callback and the 'Running task' modal stays open.
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)
