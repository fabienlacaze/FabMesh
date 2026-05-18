"""Hi3DGen full pipeline: image -> mesh + native PBR texture.

DEFAULT PATH (TRELLIS-2 Texturing, since 2026-05-18):
  1. local_hi3dgen_bridge.py            -> raw mesh
  2. trellis2_texturing_bridge.py       -> microsoft/TRELLIS.2-4B native
                                           3D PBR texture (MIT license,
                                           EU-safe, Blackwell-compatible)
                                           No UV unwrap needed — texture
                                           is generated directly in the
                                           mesh's 3D space.

ALT PATHS (set FABMESH_HI3DGEN_TEX_ENGINE):
  - 'sheet_bake' (2026-05-17 chain): xatlas + sheet_render_v2 + bake_v3
  - 'legacy'    : multiview_gen + texture_project

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
    # DECIMATE first: a 92k-face Hi3DGen mesh produces 3000+ micro UV
    # islands no matter how we tune xatlas — the normal variation across
    # 92k tiny faces FORCES xatlas to break charts. Decimate to ~15k
    # faces first so xatlas has a chance to produce coherent charts.
    # Skip decimation when the mesh is already small (target preserved).
    target_faces = int(os.environ.get('FABMESH_HI3DGEN_TARGET_FACES', '15000'))
    if len(m.faces) > target_faces * 1.5:
        log(f'  decimating {len(m.faces)}f -> ~{target_faces}f for clean UV atlas...')
        t_dec = time.time()
        m = m.simplify_quadric_decimation(face_count=target_faces)
        log(f'  decimated to {len(m.faces)}f in {time.time()-t_dec:.1f}s')

    # Taubin smoothing pre-xatlas was tested but REGRESSED quality on the
    # orc subject — it bumped chart utilization (43%→79%) but introduced
    # vertex shifts that exploded the mesh visually post-bake. Off by
    # default; opt-in via FABMESH_HI3DGEN_DO_SMOOTH=1.
    if os.environ.get('FABMESH_HI3DGEN_DO_SMOOTH') == '1':
        iters = int(os.environ.get('FABMESH_HI3DGEN_SMOOTH_ITERS', '10'))
        log(f'  Taubin smoothing {iters} iters (opt-in)...')
        trimesh.smoothing.filter_taubin(m, lamb=0.5, nu=-0.53, iterations=iters)

    v = m.vertices.astype(np.float32)
    f = m.faces.astype(np.uint32)
    log(f'  unwrapping {len(v)}v / {len(f)}f...')
    atlas = xatlas.Atlas()
    atlas.add_mesh(v, f)
    # Bias xatlas toward big, contiguous charts (more UV distortion OK
    # since we project a photo, not a tileable material).
    chart_opts = xatlas.ChartOptions()
    chart_opts.max_cost = 32.0                # default 16 — accept bigger charts
    chart_opts.max_iterations = 1             # less refinement = bigger initial charts
    pack_opts = xatlas.PackOptions()
    pack_opts.padding = 4
    pack_opts.bilinear = True
    atlas.generate(chart_options=chart_opts, pack_options=pack_opts)
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


def _mv_dir_for_image(image_path):
    """FabMesh standard multiview location: <image_stem>_multiview/ next to
    the image. This is the SAME convention as the "Multi-Views" button in
    the image editor (src/main/main.js:4024) — so views generated here
    appear in the image viewer toggle, are editable with image tools, and
    are reused if the user re-runs the 3D pipeline."""
    stem = os.path.splitext(os.path.basename(image_path))[0]
    return os.path.join(os.path.dirname(image_path), stem + '_multiview')


def _mv_dir_complete(mv_dir):
    """True iff view_0..view_5.png exist. views.json is OPTIONAL —
    texture_project.py falls back to the Z123 schema (the historical
    default for FabMesh) when views.json is absent. Previously this
    check required views.json, which made hi3dgen reject perfectly
    valid Z123-generated dirs and fall through to bare single-view
    texture (= white mesh)."""
    if not os.path.isdir(mv_dir):
        return False
    for i in range(6):
        if not os.path.isfile(os.path.join(mv_dir, f'view_{i}.png')):
            return False
    return True


def step_mvadapter(image_path, mv_dir):
    """Generate 6 multi-view consistent images via MV-Adapter i2mv-sdxl.
    Returns True on success, False otherwise (caller falls back to single-view).
    Single-view projection leaves ~60% of the Hi3DGen mesh untextured (visible
    holes) because only the front is covered. Multi-view fills sides+back+top+
    bottom from one reference image.

    Reuses existing views if `mv_dir` already has view_0..5 + views.json —
    so a manual "Multi-Views" button click before 3D gen is honored, and
    a re-run of the 3D pipeline doesn't recompute MV-Adapter.

    Captures the subprocess stdout+stderr so a failure leaves a diagnostic
    trace in the parent log instead of vanishing silently."""
    if _mv_dir_complete(mv_dir):
        log(f'STEP 2.5: reusing existing multi-views -> {mv_dir}')
        return True
    log(f'STEP 2.5: MV-Adapter 6 views -> {mv_dir}')
    t0 = time.time()
    script = os.path.join(SCRIPTS, 'multiview_mvadapter_gen.py')
    try:
        proc = subprocess.run(
            [sys.executable, script, image_path, mv_dir],
            timeout=900,
            capture_output=True,
            text=True,
        )
        rc = proc.returncode
        if proc.stdout:
            # Forward last ~50 lines so the parent log shows MV progress markers
            # but isn't drowned by tqdm bars.
            for line in proc.stdout.splitlines()[-50:]:
                log(f'mvadapter-stdout: {line}')
        if rc != 0 and proc.stderr:
            for line in proc.stderr.splitlines()[-50:]:
                log(f'mvadapter-stderr: {line}')
    except subprocess.TimeoutExpired as e:
        log(f'MV-Adapter timed out after 900s: {e}')
        return False
    except Exception as e:
        log(f'MV-Adapter exception: {type(e).__name__}: {e}')
        return False
    if rc != 0:
        log(f'MV-Adapter failed with rc={rc}, falling back to single-view')
        return False
    if not _mv_dir_complete(mv_dir):
        # Diagnose what's missing so we know if the subprocess crashed mid-flight
        # vs. wrote nothing at all.
        if os.path.isdir(mv_dir):
            present = sorted(os.listdir(mv_dir))
            log(f'MV-Adapter output incomplete in {mv_dir} — present files: {present}')
        else:
            log(f'MV-Adapter never created {mv_dir}')
        return False
    log(f'STEP 2.5 done in {time.time()-t0:.1f}s')
    return True


def step_trellis2_texturing(mesh_glb, image_path, out_glb):
    """TRELLIS-2-4B native 3D PBR texturing.

    Configurable via env vars (UI surface them as advanced options) :
      FABMESH_TRELLIS2_STEPS         sampler steps (default 12)
      FABMESH_TRELLIS2_TEX_SIZE      texture resolution (default 2048, max 4096)
      FABMESH_TRELLIS2_RESOLUTION    voxel resolution (512 or 1024, default 1024)
      FABMESH_TRELLIS2_IMG_RES       DINOv3 input resolution (default 1024)
      FABMESH_TRELLIS2_BACK_IMAGE    optional second reference photo
      FABMESH_TRELLIS2_GUIDANCE      guidance strength (default 1.0)
    """
    log(f'STEP 3 (TRELLIS-2 Texturing): native 3D PBR -> {out_glb}')
    t0 = time.time()
    bridge = os.path.join(SCRIPTS, 'trellis2_texturing_bridge.py')
    cmd = [TRELLIS2_VENV_PY, bridge, mesh_glb, image_path, out_glb]
    # Forward env-configured options as CLI flags.
    if os.environ.get('FABMESH_TRELLIS2_STEPS'):
        cmd += ['--steps', os.environ['FABMESH_TRELLIS2_STEPS']]
    if os.environ.get('FABMESH_TRELLIS2_TEX_SIZE'):
        cmd += ['--texture-size', os.environ['FABMESH_TRELLIS2_TEX_SIZE']]
    if os.environ.get('FABMESH_TRELLIS2_RESOLUTION'):
        cmd += ['--resolution', os.environ['FABMESH_TRELLIS2_RESOLUTION']]
    if os.environ.get('FABMESH_TRELLIS2_IMG_RES'):
        cmd += ['--image-resolution', os.environ['FABMESH_TRELLIS2_IMG_RES']]
    if os.environ.get('FABMESH_TRELLIS2_BACK_IMAGE'):
        cmd += ['--back-image', os.environ['FABMESH_TRELLIS2_BACK_IMAGE']]
    if os.environ.get('FABMESH_TRELLIS2_GUIDANCE'):
        cmd += ['--guidance', os.environ['FABMESH_TRELLIS2_GUIDANCE']]
    env = {**os.environ,
           'PYTORCH_CUDA_ALLOC_CONF': 'expandable_segments:True',
           # Triton DLL blocked by Smart App Control on Windows.
           'TORCHDYNAMO_DISABLE': '1',
           'TORCHINDUCTOR_USE_TRITON': '0',
           'TRANSFORMERS_ATTN_IMPLEMENTATION': 'eager'}
    rc = subprocess.run(cmd, timeout=900, env=env).returncode
    if rc != 0:
        log(f'TRELLIS-2 texturing failed with rc={rc}')
        return False
    log(f'STEP 3 done in {time.time()-t0:.1f}s')
    return True


def step_texture(mesh_glb, image_path, out_glb, tex_res, mv_dir=None):
    log(f'STEP 3: bake atlas via texture_project (res={tex_res}'
        f'{", multi-view" if mv_dir else ", single-view"})')
    t0 = time.time()
    args = [sys.executable, os.path.join(SCRIPTS, 'texture_project.py'),
            mesh_glb, image_path, out_glb, str(tex_res)]
    if mv_dir:
        args += ['--multiview', mv_dir]
    # Hi3DGen applies (x,y,z) -> (x,-z,y) in to_trimesh(transform_pose=True).
    # texture_project's camera convention assumes the SF3D inverse (rot_x(90)
    # @ rot_y(-90)) which doesn't match either. Tell texture_project to use
    # the Hi3DGen-specific inverse transform so projections land on the
    # correct faces.
    # Also disable xatlas re-unwrap — step_unwrap() already produces a
    # chart-merged atlas; a second xatlas pass would re-atomize it.
    env = {**os.environ,
           'FABMESH_TEXPROJ_HI3DGEN_UNDO': '1',
           'FABMESH_UV_REPACK': '0'}
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
    # Multi-views live in the FabMesh-standard "<image_stem>_multiview/"
    # next to the image (NOT next to the mesh), so they appear in the
    # image-side viewer, are reusable across runs, and editable with
    # the standard image AI tools.
    mv_dir = _mv_dir_for_image(image_path)

    # Skip MV-Adapter if disabled (e.g. testing single-view) via env.
    skip_mv = os.environ.get('FABMESH_HI3DGEN_SKIP_MV') == '1'

    t0 = time.time()
    step_hi3dgen(image_path, raw_glb)
    print('LOCAL_HI3DGEN_PROGRESS: 55 step1_done', flush=True)

    # TRELLIS-2-4B native PBR texturing (the only path now — sheet_bake
    # and legacy fallbacks removed in 2026-05-18 cleanup).
    print('LOCAL_HI3DGEN_PROGRESS: 65 trellis2_start', flush=True)
    ok = step_trellis2_texturing(raw_glb, image_path, out_glb)
    if not ok:
        # Last-ditch fallback: legacy texture_project on decimated mesh.
        # Not great quality but guaranteed to produce something.
        log('TRELLIS-2 failed, falling back to texture_project (single-view)')
        step_unwrap(raw_glb, uv_glb)
        step_texture(uv_glb, image_path, out_glb, tex_res, mv_dir=None)
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
