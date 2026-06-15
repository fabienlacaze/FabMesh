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
        if not hasattr(g, 'vertices') or not hasattr(g, 'faces'):
            continue
        # Harden against the degenerate / unmerged meshes the AI generators
        # ship: unreferenced/duplicate verts cause filter_laplacian to raise
        # ('shapes (N,N) and (M,3) not aligned'), and volume_constraint
        # (trimesh's default) NaNs genuinely zero-volume geometry via the
        # (vol_ini/vol_new)**(1/3) divide. merge_vertices fixes the former,
        # volume_constraint=False the latter — both are required.
        verts_backup = np.asarray(g.vertices).copy()
        try:
            try:
                g.update_faces(g.nondegenerate_faces())  # real trimesh 4.x API
            except Exception:
                pass
            try:
                g.merge_vertices()
            except Exception:
                pass
            try:
                g.remove_unreferenced_vertices()
            except Exception:
                pass
            trimesh.smoothing.filter_laplacian(
                g, iterations=int(iterations), lamb=float(lamb),
                volume_constraint=False)
            if np.isnan(np.asarray(g.vertices)).any():
                raise ValueError('smooth produced NaN')
        except Exception as e:
            log(f'smooth skipped a geom ({type(e).__name__}: {e}) — kept original')
            try:
                if len(verts_backup) == len(g.vertices):
                    g.vertices[:] = verts_backup
            except Exception:
                pass
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
    geom_names = list(scene.geometry.keys()) if hasattr(scene, 'geometry') else [None]
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
    for gi, g in enumerate(geoms):
        # Cloud-parity safety rail: skip meshes with < 100 faces.
        if not hasattr(g, 'faces') or len(g.faces) < 100:
            continue
        if len(g.faces) > target_faces:
            # Cloud-parity ratio clamp [0.05, 1.0].
            ratio = max(0.05, min(1.0, target_faces / len(g.faces)))
            # Preserve the texture: fast_simplification drops UVs, so we
            # replay the collapse list to remap the per-vertex UV array and
            # rebuild a fresh TextureVisuals at the NEW vertex count. Without
            # this the reduced mesh reloads untextured (visual.uv == None) —
            # a violation of FabMesh's #1 texture-match requirement.
            is_tex = isinstance(getattr(g, 'visual', None), trimesh.visual.TextureVisuals)
            old_uv = (np.asarray(g.visual.uv, dtype=np.float32).copy()
                      if (is_tex and getattr(g.visual, 'uv', None) is not None) else None)
            old_mat = getattr(g.visual, 'material', None) if is_tex else None
            verts = np.asarray(g.vertices, dtype=np.float32)
            faces = np.asarray(g.faces, dtype=np.int32)
            try:
                import fast_simplification
                if old_uv is not None and old_uv.shape[0] == verts.shape[0]:
                    points, faces_out, collapses = fast_simplification.simplify(
                        verts, faces, target_reduction=1.0 - ratio,
                        return_collapses=True)
                    # idx_map: length = ORIGINAL vert count, old->new index.
                    _, _, idx_map = fast_simplification.replay_simplification(
                        verts, faces, collapses)
                    new_uv = np.zeros((len(points), 2), dtype=np.float32)
                    new_uv[idx_map] = old_uv  # representative UV per merged cluster
                    g_new = trimesh.Trimesh(vertices=points, faces=faces_out, process=False)
                    g_new.visual = trimesh.visual.TextureVisuals(uv=new_uv, material=old_mat)
                    geoms[gi] = g_new
                    if geom_names[gi] is not None:
                        scene.geometry[geom_names[gi]] = g_new
                    g = g_new
                else:
                    # No usable per-vertex UV (or seam-split mismatch): plain
                    # simplify, accept it stays vertex-color / untextured.
                    points, faces_out = fast_simplification.simplify(
                        verts, faces, target_reduction=1.0 - ratio)
                    g.vertices = points
                    g.faces = faces_out
            except ImportError:
                # Fallback: trimesh's built-in (itself fast_simplification on
                # trimesh 4.x) — also drops UVs.
                n = max(50, int(len(g.faces) * ratio))
                g_new = g.simplify_quadric_decimation(n)
                g.vertices = g_new.vertices
                g.faces = g_new.faces
                log('decimate fallback (quadric) — UVs/texture not preserved')
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
    """Recalculate normals and fix winding.

    trimesh's Trimesh.fix_normals() already runs fix_winding + a
    multibody-aware fix_inversion internally, so the previous explicit
    repair.fix_inversion/fix_winding calls were redundant. The hasattr
    guard + try/except keep a non-mesh geometry (PointCloud/Path3D) or a
    degenerate mesh from aborting the whole op (which surfaced as
    'Output file not created'). Mirrors modal_app/_mesh_op.py."""
    import trimesh
    scene = trimesh.load(input_path)
    geoms = list(scene.geometry.values()) if hasattr(scene, 'geometry') else [scene]
    for g in geoms:
        if not hasattr(g, 'fix_normals'):
            continue
        try:
            g.fix_normals()
        except Exception as e:
            log(f'fix_normals skipped: {e}')
    _export(scene, geoms, output_path)
    log('normals fixed')


def fill_holes(input_path, output_path, max_hole_size=None):
    """Fill holes in the mesh (ported from modal_app/_mesh_op.py).

    The load-bearing fix is WELDING sub-millimetre vertex gaps first: the AI
    generators (TRELLIS/SF3D/Hi3DGen) leave seams unwelded, so trimesh
    detects no boundary edges and a naive single fill_holes pass silently
    no-ops (watertight stays False). After welding we run up to 4 repair
    passes (fix_winding + broken-face cleanup + fan fill) then a final
    fix_normals. `max_hole_size` is accepted but unused (the UI slider was a
    dead no-op — trimesh.repair.fill_holes fills all holes at once)."""
    import trimesh
    scene = trimesh.load(input_path)
    geoms = list(scene.geometry.values()) if hasattr(scene, 'geometry') else [scene]
    for g in geoms:
        if not hasattr(g, 'faces') or not hasattr(g, 'vertices'):
            continue
        try:
            g.update_faces(g.nondegenerate_faces())
            g.remove_unreferenced_vertices()
        except Exception:
            pass
        # Weld seam gaps so boundary edges become detectable.
        try:
            bb = np.asarray(g.bounds)
            bb_diag = float(np.linalg.norm(bb[1] - bb[0])) or 1.0
            tol = float(np.clip(bb_diag * 1e-3, 1e-6, bb_diag * 1e-2))
            digits = max(1, int(round(-np.log10(tol))))
            try:
                g.merge_vertices(merge_tex=True, merge_norm=True, digits_vertex=digits)
            except TypeError:
                g.merge_vertices()
        except Exception as e:
            log(f'fill_holes weld skipped: {e}')
        # Iterated repair.
        prev_boundary = None
        for _ in range(4):
            try:
                trimesh.repair.fix_winding(g)
            except Exception:
                pass
            try:
                g.update_faces(g.unique_faces())
            except Exception:
                pass
            try:
                broken = trimesh.repair.broken_faces(g)
                if broken is not None and len(broken):
                    mask = np.ones(len(g.faces), dtype=bool)
                    mask[broken] = False
                    g.update_faces(mask)
            except Exception:
                pass
            try:
                trimesh.repair.fill_holes(g, use_fan=True)
            except TypeError:
                trimesh.repair.fill_holes(g)
            except Exception:
                pass
            if g.is_watertight:
                break
            # Stop when boundary edges stop shrinking (no progress).
            try:
                edges = g.edges_sorted
                _, counts = np.unique(edges, axis=0, return_counts=True)
                boundary = int((counts == 1).sum())
            except Exception:
                boundary = None
            if boundary is not None and prev_boundary is not None and boundary >= prev_boundary:
                break
            prev_boundary = boundary
        try:
            g.fix_normals()
        except Exception:
            pass
        log(f'holes filled (watertight: {g.is_watertight})')
    _export(scene, geoms, output_path)


def center(input_path, output_path):
    """Center the JOINT bbox on X/Z at origin, feet (joint min Y) at Y=0.

    One shared offset from the joint bounding box of ALL geometries — the
    previous per-geometry centroid offset tore multi-part GLBs apart (each
    part moved by a different amount) and used the mass centroid instead of
    the geometric bbox center. Ported from modal_app/_mesh_op.py::center."""
    import trimesh
    scene = trimesh.load(input_path)
    geoms = list(scene.geometry.values()) if hasattr(scene, 'geometry') else [scene]
    verts = [g.vertices for g in geoms if hasattr(g, 'vertices') and len(g.vertices)]
    if not verts:
        _export(scene, geoms, output_path)
        log('centered (no vertices — passthrough)')
        return
    all_verts = np.concatenate(verts)
    cx = (all_verts[:, 0].min() + all_verts[:, 0].max()) / 2.0
    cz = (all_verts[:, 2].min() + all_verts[:, 2].max()) / 2.0
    cy = all_verts[:, 1].min()  # feet at Y=0
    for g in geoms:
        if hasattr(g, 'vertices') and len(g.vertices):
            g.vertices[:, 0] -= cx
            g.vertices[:, 1] -= cy
            g.vertices[:, 2] -= cz
    _export(scene, geoms, output_path)
    log('centered (joint bbox X/Z=0, feet Y=0)')


_TRELLIS2_PRESETS = {
    'fast':     ['--steps', '12', '--texture-size', '2048', '--image-resolution', '1024'],
    'balanced': ['--steps', '24', '--texture-size', '2048', '--image-resolution', '1024'],
    'quality':  ['--steps', '32', '--texture-size', '4096', '--image-resolution', '2048'],
}


def trellis2_retex(input_path, output_path, source_image, preset='fast'):
    """Re-texture mesh via TRELLIS-2-4B native PBR (SOTA quality).

    Wraps scripts/trellis2_texturing_bridge.py — runs in the TRELLIS2_win
    venv (flash_attn + DINOv3). ~90s on RTX 5080. `preset` (fast/balanced/
    quality) selects the bridge's --steps/--texture-size/--image-resolution;
    it used to be a dead UI selector stashed in an unread window var."""
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
    quality_args = _TRELLIS2_PRESETS.get(str(preset), _TRELLIS2_PRESETS['fast'])
    r = subprocess.run(
        [venv_py, bridge, input_path, source_image, output_path, *quality_args],
        capture_output=True, text=True, timeout=600, env=env)
    if r.stdout:
        print(r.stdout, end='', flush=True)
    if r.returncode != 0:
        if r.stderr:
            print(r.stderr, end='', flush=True)
        # Raise so __main__ exits non-zero and the renderer shows the real
        # cause instead of the opaque 'Output file not created'.
        raise RuntimeError(
            f'trellis2 bridge failed (rc={r.returncode}): {(r.stderr or "")[-1000:]}')
    if not os.path.exists(output_path):
        raise RuntimeError('trellis2 bridge returned 0 but wrote no output')
    log(f'trellis2 retextured (preset={preset})')


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
    # An unconditional pre-copy used to mask projection failures as success:
    # if texture_project failed we still had an (unmodified) output file, so
    # main.js saw success and the UI showed 'retexture done!' on a no-op.
    made_copy = os.path.abspath(input_path) != os.path.abspath(output_path)
    if made_copy:
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
        if r.stderr:
            print(r.stderr, end='', flush=True)  # surface the real error
        # Only delete the freshly-made copy — never the user's in-place source.
        if made_copy and os.path.exists(output_path):
            try:
                os.remove(output_path)
            except OSError:
                pass
        raise RuntimeError(
            f'texture_project failed (rc={r.returncode}): {(r.stderr or "")[-500:]}')
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
