"""Hunyuan-inspired multi-view bake pipeline (Voie B).

Pipeline:
  1. SF3D or TripoSG → bare mesh
  2. xatlas UV unwrap
  3. MVAdapter ig2mv_sdxl → 6 coherent views (front/right/back/left/top/bot)
     conditioned on mesh normal+position maps
  4. texture_project.py with all 6 views + CRM schema views.json
     + cos^BAKE_EXP weighting (default 4.0 for 6-view)
     + Telea UV inpaint on holes
  5. Export textured GLB

Why it works where voie A failed:
  - 6 views cover the entire surface (vs 1-2) → cos^4 now boosts SNR
    instead of killing flanks
  - MVAdapter produces view-consistent RGB (same subject, same clothes,
    same pose in all 6 angles) — unlike naive SF3D+back photo which
    mismatch

License: MVAdapter = Apache 2.0 (commercial OK). WARNING: nvdiffrast
dependency has NVIDIA non-commercial restriction — for commercial
release we must replace the render step with pyrender or torch-native
rasterizer.

Usage:
    python mv_bake_hunyuan.py <front_image> <out.glb> [mesh=sf3d|triposg]
"""
import sys
import os
import time
import json
import subprocess
from PIL import Image

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPTS)
MVA_DIR = os.path.join(ROOT, 'external', 'MV-Adapter')


def log(msg):
    print(f'[mv_bake] {msg}', flush=True)


def step_sf3d_mesh(image_path, out_glb, tex_res=1024):
    log(f'STEP 1 (SF3D): bare mesh -> {out_glb}')
    bridge = os.path.join(SCRIPTS, 'local_sf3d_bridge.py')
    t0 = time.time()
    proc = subprocess.run(
        [sys.executable, bridge, image_path, out_glb, str(tex_res), '-1', 'none', '0'],
        capture_output=True, text=True, timeout=600,
    )
    if proc.returncode != 0:
        log(f'SF3D failed: {proc.stderr[-500:]}'); sys.exit(2)
    log(f'STEP 1 done in {time.time()-t0:.1f}s')


def step_triposg_mesh(image_path, out_glb, target_faces=50000):
    log(f'STEP 1 (TripoSG): raw + decimate to {target_faces} -> {out_glb}')
    full = os.path.join(SCRIPTS, 'triposg_full_pipeline.py')
    # Use triposg_full_pipeline but stop after unwrap (mv_dir absent → no texture)
    # Actually: triposg_full_pipeline always textures. Call it without mv_dir
    # and use its _triposg_uvunwrapped.glb as output.
    out_dir = os.path.dirname(os.path.abspath(out_glb))
    tmp = os.path.join(out_dir, '_mvbake_tmp.glb')
    t0 = time.time()
    proc = subprocess.run(
        [sys.executable, full, image_path, tmp, str(target_faces), '1024'],
        capture_output=True, text=True, timeout=600,
    )
    if proc.returncode != 0:
        log(f'TripoSG failed: {proc.stderr[-500:]}'); sys.exit(2)
    # Grab the uvunwrapped intermediate
    uvunwrap = os.path.join(out_dir, '_triposg_uvunwrapped.glb')
    if not os.path.exists(uvunwrap):
        log('TripoSG uvunwrap missing'); sys.exit(2)
    import shutil
    shutil.copy(uvunwrap, out_glb)
    log(f'STEP 1 done in {time.time()-t0:.1f}s')


def step_mvadapter_views(mesh_path, image_path, out_dir, num_views=4,
                         num_steps=20, guidance=3.0):
    """Generate coherent views via mvadapter_runner.py (our wrapper
    that adds CPU offload + custom num_views on top of MVAdapter ig2mv_sdxl)."""
    mesh_path = os.path.abspath(mesh_path)
    image_path = os.path.abspath(image_path)
    out_dir = os.path.abspath(out_dir)
    log(f'STEP 2: mvadapter_runner -> {num_views} views in {out_dir}')
    t0 = time.time()
    runner = os.path.join(SCRIPTS, 'mvadapter_runner.py')
    cmd = [sys.executable, runner, mesh_path, image_path, out_dir,
           str(num_views), str(num_steps)]
    env = os.environ.copy()
    env['PYTHONIOENCODING'] = 'utf-8'
    proc = subprocess.run(cmd, capture_output=True, timeout=1800, env=env)
    _out = (proc.stdout or b'').decode('utf-8', errors='replace')
    _err = (proc.stderr or b'').decode('utf-8', errors='replace')
    if proc.returncode != 0:
        log(f'mvadapter_runner failed:\nSTDOUT: {_out[-1200:]}\nSTDERR: {_err[-2000:]}')
        sys.exit(3)
    log(f'STEP 2 done in {time.time()-t0:.1f}s ({num_views} views)')


def step_bake(mesh_path, front_image, out_glb, mv_dir, tex_res=1024,
              bake_exp=4.0):
    log(f'STEP 3: texture_project with 6-view + cos^{bake_exp} + Telea inpaint')
    t0 = time.time()
    env = os.environ.copy()
    env['FABMESH_TEXPROJ_BAKE_EXP'] = str(bake_exp)
    env['FABMESH_TEXPROJ_UV_INPAINT'] = '1'
    # Re-packing already done (mesh already has xatlas UVs) → skip.
    env['FABMESH_UV_REPACK'] = '0'
    proc = subprocess.run(
        [sys.executable, os.path.join(SCRIPTS, 'texture_project.py'),
         mesh_path, front_image, out_glb, str(tex_res),
         '--multiview', mv_dir],
        capture_output=True, text=True, timeout=600, env=env,
    )
    if proc.returncode != 0:
        log(f'bake failed: {proc.stderr[-500:]}'); sys.exit(4)
    log(f'STEP 3 done in {time.time()-t0:.1f}s')
    # Echo key metrics from the bake
    for line in proc.stdout.splitlines():
        if any(k in line for k in ('sharp_ratio', 'hole', 'inpaint',
                                   'visible', 'blend')):
            log(f'  {line}')


def main():
    if len(sys.argv) < 3:
        print('Usage: mv_bake_hunyuan.py <front_image> <out.glb> [mesh=sf3d|triposg] [bake_exp=4.0]')
        sys.exit(1)
    front = sys.argv[1]
    out_glb = sys.argv[2]
    mesh_backend = sys.argv[3] if len(sys.argv) > 3 else 'sf3d'
    bake_exp = float(sys.argv[4]) if len(sys.argv) > 4 else 4.0

    out_dir = os.path.dirname(os.path.abspath(out_glb))
    os.makedirs(out_dir, exist_ok=True)

    bare_mesh = os.path.join(out_dir, '_mvbake_bare.glb')
    mv_dir = os.path.join(out_dir, '_mvbake_views')

    t0 = time.time()
    if mesh_backend == 'sf3d':
        step_sf3d_mesh(front, bare_mesh)
    elif mesh_backend == 'triposg':
        step_triposg_mesh(front, bare_mesh)
    else:
        log(f'unknown backend: {mesh_backend}'); sys.exit(1)

    step_mvadapter_views(bare_mesh, front, mv_dir)
    step_bake(bare_mesh, front, out_glb, mv_dir, bake_exp=bake_exp)
    log(f'TOTAL: {time.time()-t0:.1f}s -> {out_glb}')


if __name__ == '__main__':
    main()
