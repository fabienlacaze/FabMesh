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


_PROGRESS_FILE = None  # set at main() start — tails every log line


def log(msg):
    line = f'[mv_bake] {msg}'
    print(line, flush=True)
    if _PROGRESS_FILE:
        try:
            with open(_PROGRESS_FILE, 'a', encoding='utf-8') as _f:
                _f.write(line + '\n')
        except Exception:
            pass


def _run_streamed(cmd, prefix, timeout, env=None, cwd=None):
    """Run subprocess with stdout streamed live (prefixed + progress file).

    Returns (returncode, captured_output_tail, stderr_tail). The whole
    stdout is echoed live so we always see where the job is; last ~2000
    chars are captured for error reporting on failure.
    """
    import threading
    env = env or os.environ.copy()
    env.setdefault('PYTHONIOENCODING', 'utf-8')
    env.setdefault('PYTHONUNBUFFERED', '1')  # crucial for live stdout
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=env, cwd=cwd, bufsize=1,
    )
    out_buf = []
    err_buf = []

    def _pump(stream, buf, tag):
        for raw in iter(stream.readline, b''):
            try:
                line = raw.decode('utf-8', errors='replace').rstrip()
            except Exception:
                line = repr(raw)
            if not line:
                continue
            buf.append(line)
            if len(buf) > 200:
                buf.pop(0)
            out = f'[{prefix}:{tag}] {line}'
            print(out, flush=True)
            if _PROGRESS_FILE:
                try:
                    with open(_PROGRESS_FILE, 'a', encoding='utf-8') as _f:
                        _f.write(out + '\n')
                except Exception:
                    pass
        stream.close()

    t_out = threading.Thread(target=_pump, args=(proc.stdout, out_buf, 'out'),
                             daemon=True)
    t_err = threading.Thread(target=_pump, args=(proc.stderr, err_buf, 'err'),
                             daemon=True)
    t_out.start(); t_err.start()
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        log(f'{prefix}: TIMEOUT after {timeout}s')
        return (124, '\n'.join(out_buf[-40:]), '\n'.join(err_buf[-40:]))
    t_out.join(timeout=5); t_err.join(timeout=5)
    return (proc.returncode, '\n'.join(out_buf[-40:]),
            '\n'.join(err_buf[-40:]))


def step_sf3d_mesh(image_path, out_glb, tex_res=1024):
    log(f'STEP 1 (SF3D): bare mesh -> {out_glb}')
    bridge = os.path.join(SCRIPTS, 'local_sf3d_bridge.py')
    t0 = time.time()
    rc, _, err = _run_streamed(
        [sys.executable, bridge, image_path, out_glb, str(tex_res),
         '-1', 'none', '0'],
        prefix='sf3d', timeout=600,
    )
    if rc != 0:
        log(f'SF3D failed (rc={rc}): {err[-500:]}'); sys.exit(2)
    log(f'STEP 1 done in {time.time()-t0:.1f}s')


def step_triposg_mesh(image_path, out_glb, target_faces=50000):
    log(f'STEP 1 (TripoSG): raw + decimate to {target_faces} -> {out_glb}')
    full = os.path.join(SCRIPTS, 'triposg_full_pipeline.py')
    out_dir = os.path.dirname(os.path.abspath(out_glb))
    tmp = os.path.join(out_dir, '_mvbake_tmp.glb')
    t0 = time.time()
    rc, _, err = _run_streamed(
        [sys.executable, full, image_path, tmp, str(target_faces), '1024'],
        prefix='triposg', timeout=900,
    )
    if rc != 0:
        log(f'TripoSG failed (rc={rc}): {err[-500:]}'); sys.exit(2)
    uvunwrap = os.path.join(out_dir, '_triposg_uvunwrapped.glb')
    if not os.path.exists(uvunwrap):
        log('TripoSG uvunwrap missing'); sys.exit(2)
    import shutil
    shutil.copy(uvunwrap, out_glb)
    log(f'STEP 1 done in {time.time()-t0:.1f}s')


def step_mvadapter_views(mesh_path, image_path, out_dir, num_views=6,
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
    rc, _, err = _run_streamed(cmd, prefix='mva', timeout=1800, env=env)
    if rc != 0:
        log(f'mvadapter_runner failed (rc={rc}): {err[-800:]}'); sys.exit(3)
    log(f'STEP 2 done in {time.time()-t0:.1f}s ({num_views} views)')


def step_fabmesh_6views(mesh_path, image_path, out_dir,
                        num_steps=30, seed=42,
                        reuse_front=None, reuse_back=None,
                        only_front_back=False, only_front=False):
    """Voie C: generate 6 HD views via FabMesh stack
    (RealVis XL + IPAdapter + ControlNet OpenPose). Commercial-safe,
    no nvdiffrast. Output contract identical to step_mvadapter_views.
    When only_front_back=True, only view_0 and view_2 are
    (re)generated — used by hybrid mode to overlay HD front+back on
    top of MVAdapter's 6-view output."""
    mesh_path = os.path.abspath(mesh_path)
    image_path = os.path.abspath(image_path)
    out_dir = os.path.abspath(out_dir)
    if only_front:
        mode = 'FRONT-only HD'
    elif only_front_back:
        mode = 'HYBRID front+back'
    else:
        mode = '6 HD views'
    log(f'STEP 2 (voieC): fabmesh_6views -> {mode} in {out_dir}')
    t0 = time.time()
    runner = os.path.join(SCRIPTS, 'fabmesh_6views_runner.py')
    cmd = [sys.executable, runner, mesh_path, image_path, out_dir,
           str(num_steps), str(seed)]
    if reuse_front:
        cmd += ['--reuse-front', os.path.abspath(reuse_front)]
    if reuse_back:
        cmd += ['--reuse-back', os.path.abspath(reuse_back)]
    if only_front:
        cmd += ['--only-front']
    elif only_front_back:
        cmd += ['--only-front-back']
    env = os.environ.copy()
    env['PYTHONIOENCODING'] = 'utf-8'
    rc, _, err = _run_streamed(cmd, prefix='voiec', timeout=1800, env=env)
    if rc != 0:
        log(f'fabmesh_6views_runner failed (rc={rc}): {err[-800:]}')
        sys.exit(3)
    log(f'STEP 2 done in {time.time()-t0:.1f}s ({mode})')


def step_back_view(image_path, out_dir):
    """Generate the back view via FabMesh's generate_back_view.py
    (RealVis XL + IPAdapter Plus + ControlNet OpenPose T-pose back).
    Returns the path to back.png."""
    image_path = os.path.abspath(image_path)
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    log(f'STEP back: generate_back_view -> {out_dir}')
    t0 = time.time()
    bv = os.path.join(SCRIPTS, 'generate_back_view.py')
    cmd = [sys.executable, bv, image_path, out_dir, '', '1']
    env = os.environ.copy()
    env['PYTHONIOENCODING'] = 'utf-8'
    rc, _, err = _run_streamed(cmd, prefix='back', timeout=600, env=env)
    if rc != 0:
        log(f'generate_back_view failed (rc={rc}): {err[-500:]}')
        sys.exit(2)
    # Find the back image (back_*.png)
    candidates = sorted(
        f for f in os.listdir(out_dir)
        if f.startswith('back') and f.endswith('.png'))
    if not candidates:
        log(f'no back.png found in {out_dir}')
        sys.exit(2)
    back_path = os.path.join(out_dir, candidates[-1])
    log(f'STEP back done in {time.time()-t0:.1f}s -> {back_path}')
    return back_path


def step_sf3d_2view_augment(image_path, back_image, out_glb, tex_res=1024):
    """Reproduce FabMesh's 2-view AUGMENT pipeline: SF3D bare mesh +
    front bake + back additive blend (texture_augment). Same as the
    UI's image-to-3d handler when useTwoView=true.

    Outputs the same file structure: out_glb + out_glb_mv2/ alongside.
    """
    image_path = os.path.abspath(image_path)
    back_image = os.path.abspath(back_image)
    out_glb = os.path.abspath(out_glb)
    out_dir = os.path.dirname(out_glb)
    out_base = os.path.splitext(os.path.basename(out_glb))[0]
    mv2_dir = os.path.join(out_dir, f'{out_base}_mv2')
    os.makedirs(mv2_dir, exist_ok=True)

    # Pre-build mv/ dir like main.js does (view_0=front, view_1=back)
    import shutil
    shutil.copy(image_path, os.path.join(mv2_dir, 'view_0.png'))
    shutil.copy(back_image, os.path.join(mv2_dir, 'view_1.png'))
    with open(os.path.join(mv2_dir, 'views.json'), 'w') as f:
        json.dump({
            'engine': 'fabmesh_2view',
            'views': [
                {'azim': 0, 'elev': 0, 'label': 'front'},
                {'azim': 180, 'elev': 0, 'label': 'back'},
            ],
        }, f, indent=2)

    log(f'STEP SF3D 2-view AUGMENT -> {out_glb}')
    t0 = time.time()
    bridge = os.path.join(SCRIPTS, 'local_sf3d_bridge.py')
    cmd = [sys.executable, bridge, image_path, out_glb,
           str(tex_res), '-1', 'none', '0']
    env = os.environ.copy()
    env['PYTHONIOENCODING'] = 'utf-8'
    env['PYTHONUNBUFFERED'] = '1'
    # 2-view AUGMENT envvars (mirror of main.js:3514-3522)
    # NORMALIZE_ORIENT trade-off (v10/v12 confirmed): with =1 (rotate
    # 180°), voie C front+back HD overlay both lands on the SIDES
    # (mesh face=+Z but ortho cams expect face=+Y → 90° offset on
    # both halves). Reverting to =0 = same as the FabMesh UI 2-view
    # path. Voie C cameras may still be misaligned but at least the
    # SF3D atlas and back additive blend are computed in their native
    # convention.
    env['FABMESH_MV_REUSE'] = mv2_dir
    env['FABMESH_PROJECT_MODE'] = 'augment'
    env['FABMESH_SF3D_NORMALIZE_ORIENT'] = '0'
    env['FABMESH_TEXPROJ_FRAME_FIX'] = '1'
    env['FABMESH_TEXPROJ_SKIP_BACK_VFLIP'] = '1'
    env['FABMESH_AUTOFIT'] = '1'
    env['FABMESH_AUTOFIT_RATIO'] = '1.20'
    rc, _, err = _run_streamed(cmd, prefix='sf3d2v', timeout=900, env=env)
    if rc != 0:
        log(f'SF3D 2-view failed (rc={rc}): {err[-500:]}')
        sys.exit(2)
    log(f'STEP SF3D 2-view done in {time.time()-t0:.1f}s')


def step_sheet_6views(mesh_path, image_path, out_dir,
                      num_steps=30, seed=42):
    """Voie E: single-call multi-view sheet (RealVis + CN OpenPose +
    IPAdapter) on a 1536x1024 canvas, cropped into 6 view_*.png.
    Native color coherence (1 latent), no nvdiffrast."""
    mesh_path = os.path.abspath(mesh_path)
    image_path = os.path.abspath(image_path)
    out_dir = os.path.abspath(out_dir)
    log(f'STEP 2 (voieE/sheet): single-pass 6-view sheet -> {out_dir}')
    t0 = time.time()
    runner = os.path.join(SCRIPTS, 'fabmesh_sheet_runner.py')
    cmd = [sys.executable, runner, mesh_path, image_path, out_dir,
           str(num_steps), str(seed)]
    env = os.environ.copy()
    env['PYTHONIOENCODING'] = 'utf-8'
    rc, _, err = _run_streamed(cmd, prefix='sheet', timeout=1200, env=env)
    if rc != 0:
        log(f'fabmesh_sheet_runner failed (rc={rc}): {err[-800:]}')
        sys.exit(3)
    log(f'STEP 2 done in {time.time()-t0:.1f}s (sheet)')


def step_bake(mesh_path, front_image, out_glb, mv_dir, tex_res=1024,
              bake_exp=4.0, base_atlas=False):
    log(f'STEP 3: texture_project with 6-view + cos^{bake_exp} + Telea inpaint')
    t0 = time.time()
    env = os.environ.copy()
    env['FABMESH_TEXPROJ_BAKE_EXP'] = str(bake_exp)
    env['FABMESH_TEXPROJ_UV_INPAINT'] = '1'
    # Re-packing already done (mesh already has xatlas UVs) → skip.
    env['FABMESH_UV_REPACK'] = '0'
    # MVAdapter's view_0 IS the front — don't also inject the HD source
    # photo (creates double-face bleed since they have different cameras).
    env['FABMESH_TEXPROJ_NO_FRONT'] = '1'
    if base_atlas:
        # Voie F: keep the SF3D AUGMENT atlas as floor, overlay only.
        env['FABMESH_TEXPROJ_BASE_ATLAS'] = '1'
        log('STEP 3 base_atlas=ON (SF3D AUGMENT atlas as floor)')
    rc, _, err = _run_streamed(
        [sys.executable, os.path.join(SCRIPTS, 'texture_project.py'),
         mesh_path, front_image, out_glb, str(tex_res),
         '--multiview', mv_dir],
        prefix='bake', timeout=600, env=env,
    )
    if rc != 0:
        log(f'bake failed (rc={rc}): {err[-500:]}'); sys.exit(4)
    log(f'STEP 3 done in {time.time()-t0:.1f}s')


def main():
    import argparse
    parser = argparse.ArgumentParser(
        description='Voie B/C multi-view bake pipeline.')
    parser.add_argument('front', help='Front image (PNG/JPG)')
    parser.add_argument('out_glb', help='Output textured GLB path')
    parser.add_argument('mesh_backend', nargs='?', default='sf3d',
                        choices=['sf3d', 'triposg'],
                        help='Bare mesh generator (default: sf3d)')
    parser.add_argument('bake_exp', nargs='?', type=float, default=4.0,
                        help='cos^N visibility exponent (default: 4.0)')
    parser.add_argument('target_faces', nargs='?', type=int, default=50000,
                        help='TripoSG face count (default: 50000)')
    parser.add_argument('--engine',
                        choices=['mvadapter', 'fabmesh', 'hybrid', 'sheet',
                                 'voiefab', 'voiefab-front'],
                        default='mvadapter',
                        help='View generator: mvadapter=voie B, '
                             'fabmesh=voie C pure (lateral views unreliable), '
                             'hybrid=MVAdapter for 6 views then voie C '
                             'overwrites front+back with HD 1024², '
                             'sheet=voie E single-pass 6-panel sheet, '
                             'voiefab=voie F: SF3D 2-view AUGMENT '
                             '(commercial-safe, no nvdiffrast) + voie C '
                             'HD overlay on front/back')
    parser.add_argument('--reuse-front', default=None,
                        help='(voie C) reuse an existing front image '
                             'instead of regenerating view_0')
    parser.add_argument('--reuse-back', default=None,
                        help='(voie C) reuse an existing back image '
                             'instead of regenerating view_2')
    args = parser.parse_args()

    front = args.front
    out_glb = args.out_glb
    mesh_backend = args.mesh_backend
    bake_exp = args.bake_exp
    target_faces = args.target_faces
    engine = args.engine
    reuse_front = args.reuse_front
    reuse_back = args.reuse_back

    out_dir = os.path.dirname(os.path.abspath(out_glb))
    os.makedirs(out_dir, exist_ok=True)

    bare_mesh = os.path.join(out_dir, '_mvbake_bare.glb')
    mv_dir = os.path.join(out_dir, '_mvbake_views')

    # Live progress file: tail -f this at any time to see the pipeline state.
    global _PROGRESS_FILE
    _PROGRESS_FILE = os.path.join(out_dir, '_mvbake_progress.log')
    try:
        with open(_PROGRESS_FILE, 'w', encoding='utf-8') as _f:
            _f.write(f'# Voie B pipeline start: {time.strftime("%Y-%m-%d %H:%M:%S")}\n')
            _f.write(f'# front={front}\n# out={out_glb}\n')
            _f.write(f'# backend={mesh_backend} target_faces={target_faces}\n')
    except Exception:
        pass
    log(f'progress log: {_PROGRESS_FILE}')

    t0 = time.time()
    if mesh_backend == 'sf3d':
        step_sf3d_mesh(front, bare_mesh)
    elif mesh_backend == 'triposg':
        step_triposg_mesh(front, bare_mesh, target_faces=target_faces)
    else:
        log(f'unknown backend: {mesh_backend}'); sys.exit(1)

    if engine == 'mvadapter':
        step_mvadapter_views(bare_mesh, front, mv_dir)
    elif engine == 'fabmesh':
        step_fabmesh_6views(bare_mesh, front, mv_dir,
                            reuse_front=reuse_front,
                            reuse_back=reuse_back)
    elif engine == 'hybrid':
        # 1. MVAdapter produces 6 coherent views + views.json
        step_mvadapter_views(bare_mesh, front, mv_dir)
        # 2. RealVis+IPA+CN HD overwrites view_0 (front) and view_2
        #    (back). views.json stays unchanged (same cameras).
        step_fabmesh_6views(bare_mesh, front, mv_dir,
                            reuse_front=reuse_front,
                            reuse_back=reuse_back,
                            only_front_back=True)
    elif engine == 'sheet':
        # Voie E: single-pass 6-panel sheet (no MVAdapter, no nvdiffrast).
        step_sheet_6views(bare_mesh, front, mv_dir)
    elif engine in ('voiefab', 'voiefab-front'):
        # Voie F: 100% commercial-safe pipeline.
        # 1. Generate back via FabMesh (RealVis+IPA+CN)
        # 2. SF3D 2-view AUGMENT bake (front+back natively in atlas)
        # 3. voie C HD front (+back if engine=voiefab) overlay on top
        # No MVAdapter, no nvdiffrast.
        bp_dir = os.path.join(out_dir, '_voief_back')
        back_path = step_back_view(front, bp_dir)
        step_sf3d_2view_augment(front, back_path, bare_mesh)
        if engine == 'voiefab-front':
            # FRONT-only HD overlay: trust the SF3D AUGMENT atlas for
            # back (no risk of mini-face on dorsal silhouette).
            step_fabmesh_6views(bare_mesh, front, mv_dir,
                                reuse_front=front,
                                only_front=True)
        else:
            step_fabmesh_6views(bare_mesh, front, mv_dir,
                                reuse_front=front,
                                reuse_back=back_path,
                                only_front_back=True)
    else:
        log(f'unknown engine: {engine}'); sys.exit(1)
    step_bake(bare_mesh, front, out_glb, mv_dir, bake_exp=bake_exp,
              base_atlas=engine.startswith('voiefab'))
    log(f'TOTAL: {time.time()-t0:.1f}s -> {out_glb}')


if __name__ == '__main__':
    main()
