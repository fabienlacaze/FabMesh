"""
FabMesh mesh subdivision (Python-only, no Blender).
====================================================

Subdivides a GLB mesh while preserving PBR textures via barycentric UV
interpolation. Each level x4 the triangle count.

Negative levels = decimation (pymeshlab quadric edge collapse).

Usage:
    python subdivide.py <input.glb> <output.glb> <levels>
"""
import sys
import os
import time
import numpy as np
import trimesh
import trimesh.visual as _vis


def log(msg):
    print(f'[subdivide] {msg}', flush=True)


def _subdivide_with_uv(vertices, faces, uv, levels):
    """Subdivide mesh geometry and interpolate UVs via barycentric coords.

    For each subdivision step:
    1. trimesh.remesh.subdivide splits each triangle into 4 by adding
       midpoints on edges. New verts are at indices [n_old:].
    2. For each new vertex, we find which original triangle it falls in
       and compute its UV by averaging the UVs of the edge endpoints.

    This is exact for midpoint subdivision (each new vert IS the midpoint
    of an edge, so its UV is exactly the average of the 2 endpoint UVs).
    """
    from trimesh.remesh import subdivide

    for lvl in range(levels):
        n_old = len(vertices)
        old_verts = vertices.copy()

        # Subdivide geometry
        vertices, faces = subdivide(vertices, faces)
        n_new = len(vertices) - n_old

        if uv is None or n_new == 0:
            continue

        # For each new vertex (midpoint of an edge), find the 2 original
        # vertices it came from by checking which edges in the new faces
        # connect an old vertex to this new one.
        #
        # Faster approach: use scipy KDTree to find the 2 nearest original
        # vertices for each new vertex (they're the edge endpoints).
        from scipy.spatial import cKDTree
        tree = cKDTree(old_verts)

        new_verts = vertices[n_old:]
        # Query 2 nearest neighbors from the ORIGINAL vertex set
        dists, indices = tree.query(new_verts, k=2)

        # New UV = average of the 2 endpoint UVs
        new_uv = (uv[indices[:, 0]] + uv[indices[:, 1]]) / 2.0
        uv = np.vstack([uv, new_uv])

    return vertices, faces, uv


def subdivide_glb(input_path, output_path, levels=2):
    """Load a GLB, subdivide or decimate, re-export with textures."""
    log(f'input={input_path} output={output_path} levels={levels}')
    t0 = time.time()
    levels = int(levels)

    scene = trimesh.load(input_path)
    geometries = list(scene.geometry.values()) if hasattr(scene, 'geometry') else [scene]
    if not geometries:
        log('ERROR: no geometry found in GLB')
        return False

    log(f'loaded {len(geometries)} geometry(ies)')

    # ==================================================================
    # DECIMATION (levels < 0)
    # ==================================================================
    if levels < 0:
        import pymeshlab
        target_faces = abs(levels)
        result_meshes = {}
        for idx, geom in enumerate(geometries):
            name = list(scene.geometry.keys())[idx] if hasattr(scene, 'geometry') else f'mesh_{idx}'
            log(f'  {name}: {len(geom.vertices)} verts, {len(geom.faces)} faces -> decimate to ~{target_faces}')

            ms = pymeshlab.MeshSet()
            ms.add_mesh(pymeshlab.Mesh(
                vertex_matrix=np.asarray(geom.vertices, dtype=np.float64),
                face_matrix=np.asarray(geom.faces, dtype=np.int32),
            ))
            ms.meshing_decimation_quadric_edge_collapse(
                targetfacenum=target_faces,
                preservenormal=True, preserveboundary=True, preservetopology=True,
            )
            out_m = ms.current_mesh()
            new_v = np.asarray(out_m.vertex_matrix(), dtype=np.float32)
            new_f = np.asarray(out_m.face_matrix(), dtype=np.int32)
            log(f'  {name}: decimated to {len(new_v)} verts, {len(new_f)} faces')

            # Transfer UVs via nearest-neighbor from original
            mat = geom.visual.material if hasattr(geom.visual, 'material') else None
            has_uv = hasattr(geom.visual, 'uv') and geom.visual.uv is not None and len(geom.visual.uv) > 0
            if has_uv and len(geom.visual.uv) == len(geom.vertices):
                from scipy.spatial import cKDTree
                tree = cKDTree(np.asarray(geom.vertices, dtype=np.float64))
                _, idx_map = tree.query(new_v)
                new_uv = np.asarray(geom.visual.uv, dtype=np.float32)[idx_map]
            else:
                new_uv = _fallback_uv(new_v)

            visual = _vis.TextureVisuals(uv=new_uv, material=mat) if mat else None
            new_mesh = trimesh.Trimesh(vertices=new_v, faces=new_f, visual=visual, process=False)
            _ = new_mesh.vertex_normals
            result_meshes[name] = new_mesh

        _export(result_meshes, output_path, t0)
        return True

    # ==================================================================
    # SUBDIVISION (levels > 0)
    # ==================================================================
    result_meshes = {}
    for idx, geom in enumerate(geometries):
        name = list(scene.geometry.keys())[idx] if hasattr(scene, 'geometry') else f'mesh_{idx}'
        verts = np.asarray(geom.vertices, dtype=np.float64)
        faces = np.asarray(geom.faces, dtype=np.int32)
        log(f'  {name}: {len(verts)} verts, {len(faces)} faces before subdivision')

        # Extract UVs
        has_uv = hasattr(geom.visual, 'uv') and geom.visual.uv is not None and len(geom.visual.uv) > 0
        uv = np.asarray(geom.visual.uv, dtype=np.float64) if has_uv else None

        # Subdivide with UV interpolation
        verts, faces, uv = _subdivide_with_uv(verts, faces, uv, levels)

        log(f'  {name}: {len(verts)} verts, {len(faces)} faces after subdivision')

        # Rebuild mesh with original material
        new_verts = np.asarray(verts, dtype=np.float32)
        new_faces = np.asarray(faces, dtype=np.int32)
        mat = geom.visual.material if hasattr(geom.visual, 'material') else None

        if uv is not None and len(uv) == len(new_verts) and mat is not None:
            visual = _vis.TextureVisuals(uv=np.asarray(uv, dtype=np.float32), material=mat)
        elif mat is not None:
            visual = _vis.TextureVisuals(uv=_fallback_uv(new_verts), material=mat)
        else:
            visual = None

        new_mesh = trimesh.Trimesh(vertices=new_verts, faces=new_faces, visual=visual, process=False)
        _ = new_mesh.vertex_normals
        result_meshes[name] = new_mesh

    _export(result_meshes, output_path, t0)
    return True


def _fallback_uv(verts):
    """Spherical UV projection as fallback."""
    center = verts.mean(axis=0)
    d = verts - center
    norms = np.linalg.norm(d, axis=1, keepdims=True)
    norms[norms < 1e-8] = 1.0
    d = d / norms
    u = 0.5 + np.arctan2(d[:, 0], d[:, 2]) / (2 * np.pi)
    v = 0.5 + np.arcsin(np.clip(d[:, 1], -1, 1)) / np.pi
    return np.column_stack([u, v]).astype(np.float32)


def _export(result_meshes, output_path, t0):
    """Export meshes to GLB and print stats."""
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    if len(result_meshes) == 1:
        list(result_meshes.values())[0].export(output_path)
    else:
        trimesh.Scene(geometry=result_meshes).export(output_path)

    elapsed = time.time() - t0
    total_v = sum(len(m.vertices) for m in result_meshes.values())
    total_f = sum(len(m.faces) for m in result_meshes.values())
    print(f'SUBDIVIDE_STATS: verts={total_v} faces={total_f}', flush=True)
    print(f'SUBDIVIDE_SUCCESS: {output_path} ({os.path.getsize(output_path)} bytes) in {elapsed:.1f}s', flush=True)


if __name__ == '__main__':
    if len(sys.argv) < 4:
        print("Usage: python subdivide.py <input.glb> <output.glb> <levels>")
        sys.exit(1)
    try:
        ok = subdivide_glb(sys.argv[1], sys.argv[2], int(sys.argv[3]))
        sys.exit(0 if ok else 1)
    except Exception as e:
        print(f'SUBDIVIDE_ERROR: {type(e).__name__}: {e}', flush=True)
        import traceback
        traceback.print_exc()
        sys.exit(1)
