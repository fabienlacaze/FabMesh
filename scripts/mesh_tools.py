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


def log(msg):
    print(f'[mesh_tools] {msg}', flush=True)


def smooth(input_path, output_path, iterations=3, lamb=0.5):
    """Laplacian smoothing."""
    import trimesh
    scene = trimesh.load(input_path)
    geoms = list(scene.geometry.values()) if hasattr(scene, 'geometry') else [scene]
    for g in geoms:
        trimesh.smoothing.filter_laplacian(g, iterations=int(iterations), lamb=float(lamb))
    _export(scene, geoms, output_path)
    log(f'smoothed ({iterations} iterations, lambda={lamb})')


def decimate(input_path, output_path, target_faces=5000):
    """Reduce triangle count."""
    import trimesh
    target_faces = int(target_faces)
    scene = trimesh.load(input_path)
    geoms = list(scene.geometry.values()) if hasattr(scene, 'geometry') else [scene]
    for g in geoms:
        if len(g.faces) > target_faces:
            ratio = target_faces / len(g.faces)
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
                g_new = g.simplify_quadric_decimation(target_faces)
                g.vertices = g_new.vertices
                g.faces = g_new.faces
            log(f'decimated to {len(g.faces)} faces (target: {target_faces})')
    _export(scene, geoms, output_path)


def subdivide_mesh(input_path, output_path, levels=1):
    """Midpoint subdivision."""
    # Use the existing subdivide.py
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


def retexture(input_path, output_path, source_image, tex_res=2048):
    """Re-project source image texture onto mesh."""
    import subprocess
    script = os.path.join(os.path.dirname(__file__), 'texture_project.py')
    import shutil
    if os.path.abspath(input_path) != os.path.abspath(output_path):
        shutil.copy(input_path, output_path)
    r = subprocess.run([sys.executable, script, output_path, source_image, output_path, str(tex_res)],
                       capture_output=True, text=True, timeout=120)
    if r.stdout:
        print(r.stdout, end='', flush=True)
    if r.returncode != 0:
        log(f'ERROR: retexture failed')
    else:
        log('retextured')


def _export(scene, geoms, output_path):
    """Export mesh(es) to GLB."""
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    if len(geoms) == 1:
        geoms[0].export(output_path)
    else:
        scene.export(output_path)


if __name__ == '__main__':
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
