"""
FabMesh Mesh Tools — automated mesh operations.
================================================

Usage:
    python mesh_tools.py <operation> <input.glb> <output.glb> [params...]

Operations:
    smooth <input> <output> [iterations=3] [lambda=0.5]
    decimate <input> <output> [target_faces=5000]
    subdivide <input> <output> [levels=1]
    fix_normals <input> <output>
    fill_holes <input> <output> [max_hole_size=100]
    center <input> <output>
    retexture <input> <output> <source_image> [tex_res=2048]
"""
import sys
import os
import time
import numpy as np


# ---------------------------------------------------------------------------
# Cloud-parity preset registry.
# Activated via env var `FABMESH_MESH_PRESET=cloud_parity` (or
# `FABMESH_MESH_PRESET=cloud`) or the `--preset cloud_parity` CLI flag.
# Default 'desktop' preserves existing behavior — DO NOT change defaults
# silently because the renderer's UI buttons pass explicit positional args
# for the "Quick" preset (smooth 3 iter, decimate 5000 faces) that we must
# keep honoring.
# ---------------------------------------------------------------------------
PRESETS = {
    'desktop': {
        'smooth_iterations': 3, 'smooth_lamb': 0.5,
        'decimate_target_faces': 5000,
        'subdivide_mode': 'midpoint', 'subdivide_levels': 1,
        'extension_webp': False,
    },
    'cloud_parity': {
        'smooth_iterations': 5, 'smooth_lamb': 0.5,
        'decimate_target_faces': 50_000,
        'subdivide_mode': 'loop', 'subdivide_levels': 1,
        'extension_webp': True,
    },
}
# Accept 'cloud' as an alias for 'cloud_parity'.
_env_preset = os.environ.get('FABMESH_MESH_PRESET', 'desktop').strip().lower()
if _env_preset == 'cloud':
    _env_preset = 'cloud_parity'
ACTIVE_PRESET = _env_preset if _env_preset in PRESETS else 'desktop'


def log(msg):
    print(f'[mesh_tools] {msg}', flush=True)


def _preset(key, override=None):
    """Resolve a preset value: explicit override wins, else active preset."""
    if override is not None:
        return override
    return PRESETS[ACTIVE_PRESET][key]


def smooth(input_path, output_path, iterations=None, lamb=None):
    """Laplacian smoothing.

    When `iterations` / `lamb` are None, values come from the active
    preset (desktop: 3/0.5, cloud_parity: 5/0.5)."""
    import trimesh
    iterations = _preset('smooth_iterations', iterations)
    lamb = _preset('smooth_lamb', lamb)
    scene = trimesh.load(input_path)
    geoms = list(scene.geometry.values()) if hasattr(scene, 'geometry') else [scene]
    for g in geoms:
        trimesh.smoothing.filter_laplacian(g, iterations=int(iterations), lamb=float(lamb))
    _export(scene, geoms, output_path)
    log(f'smoothed ({iterations} iterations, lambda={lamb}, preset={ACTIVE_PRESET})')


def decimate(input_path, output_path, target_faces=None):
    """Reduce triangle count.

    When `target_faces` is None, value comes from the active preset
    (desktop: 5000, cloud_parity: 50_000). Cloud-parity safety rails
    (early-out when already below target, ratio clamp, skip tiny meshes)
    are applied unconditionally — they only kick in for edge cases."""
    import trimesh
    target_faces = int(_preset('decimate_target_faces', target_faces))
    scene = trimesh.load(input_path)
    geoms = list(scene.geometry.values()) if hasattr(scene, 'geometry') else [scene]
    # Cloud-parity early-out: if the biggest mesh is already at or below
    # target, copy through untouched (matches cloud's behavior).
    if geoms:
        max_faces = max((len(g.faces) for g in geoms if hasattr(g, 'faces')),
                        default=0)
        if 0 < max_faces <= target_faces:
            log(f'decimate skipped — already at {max_faces} <= target {target_faces}')
            _export(scene, geoms, output_path)
            return
    for g in geoms:
        # Cloud-parity safety rail: skip meshes with < 100 faces.
        if not hasattr(g, 'faces') or len(g.faces) < 100:
            continue
        if len(g.faces) > target_faces:
            # Cloud-parity ratio clamp [0.05, 1.0].
            ratio = max(0.05, min(1.0, target_faces / len(g.faces)))
            try:
                import fast_simplification
                points, faces_out = fast_simplification.simplify(
                    np.asarray(g.vertices, dtype=np.float32),
                    np.asarray(g.faces, dtype=np.int32),
                    target_reduction=1.0 - ratio
                )
                g.vertices = points
                g.faces = faces_out
            except ImportError:
                # Fallback: use trimesh's built-in (slower, less quality)
                n = max(50, int(len(g.faces) * ratio))
                g_new = g.simplify_quadric_decimation(n)
                g.vertices = g_new.vertices
                g.faces = g_new.faces
            log(f'decimated to {len(g.faces)} faces (target: {target_faces}, preset={ACTIVE_PRESET})')
    _export(scene, geoms, output_path)


def subdivide_mesh(input_path, output_path, levels=1, mode=None):
    """Subdivision — midpoint by default, Loop when preset=cloud_parity.

    `mode` ('midpoint' or 'loop') overrides the preset choice.
    Loop subdivision (smoother, used by the cloud worker) is run in-process
    via trimesh's `subdivide_loop`; midpoint shells out to subdivide.py.
    """
    mode = _preset('subdivide_mode', mode)
    levels = int(levels) if levels is not None else _preset('subdivide_levels')

    if mode == 'loop':
        # Cloud-parity Loop subdivision — in-process via trimesh.
        # Safety rails ported verbatim from cloud: cap to 2 iterations max,
        # bail when a mesh already exceeds 500_000 faces.
        import trimesh
        scene = trimesh.load(input_path)
        geoms = list(scene.geometry.values()) if hasattr(scene, 'geometry') else [scene]
        for g in geoms:
            if not hasattr(g, 'subdivide_loop'):
                continue
            try:
                for _ in range(max(1, min(2, int(levels)))):
                    if hasattr(g, 'faces') and len(g.faces) > 500_000:
                        log(f'subdivide_loop bail — mesh already at {len(g.faces)} faces')
                        break
                    sub = g.subdivide_loop()
                    g.vertices = sub.vertices
                    g.faces = sub.faces
            except Exception as e:
                log(f'subdivide_loop skipped: {e}')
        _export(scene, geoms, output_path)
        log(f'loop-subdivided ({levels} levels, preset={ACTIVE_PRESET})')
        return True

    # Default: midpoint via the existing subdivide.py
    import subprocess
    script = os.path.join(os.path.dirname(__file__), 'subdivide.py')
    r = subprocess.run([sys.executable, script, input_path, output_path, str(levels)],
                       capture_output=True, text=True, timeout=300)
    if r.stdout:
        print(r.stdout, end='', flush=True)
    if r.returncode != 0:
        log(f'ERROR: subdivide failed (code {r.returncode})')
        if r.stderr:
            log(r.stderr[-300:])
        return False
    return True


def fix_normals(input_path, output_path):
    """Recalculate normals and fix winding."""
    import trimesh
    scene = trimesh.load(input_path)
    geoms = list(scene.geometry.values()) if hasattr(scene, 'geometry') else [scene]
    for g in geoms:
        g.fix_normals()
        trimesh.repair.fix_inversion(g)
        trimesh.repair.fix_winding(g)
    _export(scene, geoms, output_path)
    log('normals fixed')


def fill_holes(input_path, output_path, max_hole_size=100):
    """Fill holes in the mesh."""
    import trimesh
    max_hole_size = int(max_hole_size)
    scene = trimesh.load(input_path)
    geoms = list(scene.geometry.values()) if hasattr(scene, 'geometry') else [scene]
    for g in geoms:
        trimesh.repair.fill_holes(g)
        log(f'holes filled (watertight: {g.is_watertight})')
    _export(scene, geoms, output_path)


def center(input_path, output_path):
    """Center mesh at origin, feet on ground plane."""
    import trimesh
    scene = trimesh.load(input_path)
    geoms = list(scene.geometry.values()) if hasattr(scene, 'geometry') else [scene]
    for g in geoms:
        centroid = g.centroid.copy()
        bounds = g.bounds
        # Center X/Z, put feet at Y=0
        g.vertices[:, 0] -= centroid[0]
        g.vertices[:, 2] -= centroid[2]
        g.vertices[:, 1] -= bounds[0][1]  # min Y = 0
    _export(scene, geoms, output_path)
    log('centered (feet at Y=0)')


def trellis2_retex(input_path, output_path, source_image):
    """Re-texture mesh via TRELLIS-2-4B native PBR (SOTA quality).

    Wraps scripts/trellis2_texturing_bridge.py — runs in the TRELLIS2_win
    venv (flash_attn + DINOv3). ~90s on RTX 5080."""
    import subprocess
    bridge = os.path.join(os.path.dirname(__file__),
                           'trellis2_texturing_bridge.py')
    venv_py = os.path.abspath(os.path.join(
        os.path.dirname(__file__), '..', 'external', 'TRELLIS2_win',
        '.venv', 'Scripts', 'python.exe'))
    env = dict(os.environ)
    env['PYTORCH_CUDA_ALLOC_CONF'] = 'expandable_segments:True'
    env['TORCHDYNAMO_DISABLE'] = '1'
    env['TORCHINDUCTOR_USE_TRITON'] = '0'
    env['TRANSFORMERS_ATTN_IMPLEMENTATION'] = 'eager'
    # Use kaolin (Apache 2.0) rasterizer instead of nvdiffrast (NVIDIA NC).
    env.setdefault('TRELLIS2_USE_KAOLIN_RASTER', '1')
    r = subprocess.run(
        [venv_py, bridge, input_path, source_image, output_path],
        capture_output=True, text=True, timeout=600, env=env)
    if r.stdout:
        print(r.stdout, end='', flush=True)
    if r.returncode != 0:
        log(f'ERROR: trellis2_retex failed: {r.stderr[-500:] if r.stderr else ""}')
    else:
        log('trellis2 retextured')


def retexture(input_path, output_path, source_image, tex_res=2048):
    """Re-project source image texture onto mesh.

    Auto-detects Hi3DGen meshes via filename pattern and sets the
    FABMESH_TEXPROJ_HI3DGEN_UNDO env var so texture_project applies the
    correct axis transform (Hi3DGen exports "front=-Z" whereas
    texture_project assumes "front=+Z"). Without this fix, the front
    photo gets projected on the BACK of the mesh."""
    import subprocess
    script = os.path.join(os.path.dirname(__file__), 'texture_project.py')
    import shutil
    if os.path.abspath(input_path) != os.path.abspath(output_path):
        shutil.copy(input_path, output_path)
    # Auto-detect Hi3DGen by filename — same pattern as the meshProject
    # regex in the renderer.
    env = dict(os.environ)
    if '_hi3dgen_' in os.path.basename(input_path).lower():
        env['FABMESH_TEXPROJ_HI3DGEN_UNDO'] = '1'
        env['FABMESH_UV_REPACK'] = '0'
        log('Hi3DGen mesh detected — applying axis fix '
            '(FABMESH_TEXPROJ_HI3DGEN_UNDO=1)')
    r = subprocess.run(
        [sys.executable, script, output_path, source_image, output_path, str(tex_res)],
        capture_output=True, text=True, timeout=120, env=env)
    if r.stdout:
        print(r.stdout, end='', flush=True)
    if r.returncode != 0:
        log(f'ERROR: retexture failed')
    else:
        log('retextured')


def _export(scene, geoms, output_path):
    """Export mesh(es) to GLB.

    When the active preset enables `extension_webp` AND the target is a
    .glb, we pass `extension_webp=True` so trimesh writes WebP textures
    (EXT_texture_webp glTF extension). Cloud parity — smaller GLBs.
    """
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    webp = bool(PRESETS[ACTIVE_PRESET].get('extension_webp', False))
    kwargs = {}
    if webp and output_path.lower().endswith('.glb'):
        kwargs['extension_webp'] = True
        kwargs.setdefault('file_type', 'glb')
    if len(geoms) == 1:
        geoms[0].export(output_path, **kwargs)
    else:
        scene.export(output_path, **kwargs)


if __name__ == '__main__':
    # Strip `--preset <name>` BEFORE positional parsing so `op` stays the
    # operation name. Accepts 'desktop', 'cloud_parity', or alias 'cloud'.
    if '--preset' in sys.argv:
        i = sys.argv.index('--preset')
        if i + 1 < len(sys.argv):
            _cli_preset = sys.argv[i + 1].strip().lower()
            if _cli_preset == 'cloud':
                _cli_preset = 'cloud_parity'
            if _cli_preset in PRESETS:
                ACTIVE_PRESET = _cli_preset
                log(f'preset = {ACTIVE_PRESET} (via --preset)')
            else:
                log(f'WARN: unknown preset {_cli_preset!r}, keeping {ACTIVE_PRESET}')
            del sys.argv[i:i + 2]

    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)

    op = sys.argv[1]
    inp = sys.argv[2]
    out = sys.argv[3]
    params = sys.argv[4:]

    ops = {
        'smooth': lambda: smooth(inp, out, *params),
        'decimate': lambda: decimate(inp, out, *params),
        'subdivide': lambda: subdivide_mesh(inp, out, *params),
        'fix_normals': lambda: fix_normals(inp, out),
        'fill_holes': lambda: fill_holes(inp, out, *params),
        'center': lambda: center(inp, out),
        'retexture': lambda: retexture(inp, out, *params),
        'trellis2_retex': lambda: trellis2_retex(inp, out, *params),
    }

    if op not in ops:
        print(f'Unknown operation: {op}. Available: {", ".join(ops.keys())}')
        sys.exit(1)

    try:
        t0 = time.time()
        ops[op]()
        log(f'{op} done in {time.time()-t0:.1f}s')
        log(f'output: {out} ({os.path.getsize(out)} bytes)')
    except Exception as e:
        log(f'ERROR: {type(e).__name__}: {e}')
        import traceback
        traceback.print_exc()
        sys.exit(2)
