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
    """Subdivide mesh with correct UV interpolation by unsharing UV seam vertices.

    For each subdivision level:
    1. "Explode" mesh: each face gets its own 3 vertices (no sharing)
    2. subdivide() creates 4 sub-faces per face, with 3 new midpoint vertices per face
    3. For each new vertex, find its parent edge by scanning the output faces
    4. UV = average of the 2 parent endpoint UVs (using the exploded per-face UVs)

    This avoids cross-island contamination because each face has unique vertices.
    """
    from trimesh.remesh import subdivide

    if uv is None:
        for _ in range(levels):
            vertices, faces = subdivide(vertices, faces)
        return vertices, faces, uv

    for lvl in range(levels):
        n_faces = len(faces)

        # "Explode" mesh: each face gets its own 3 vertices (no sharing)
        exploded_verts = vertices[faces.flatten()].reshape(-1, 3)  # (F*3, 3)
        exploded_uv = uv[faces.flatten()].reshape(-1, 2)          # (F*3, 2)
        exploded_faces = np.arange(n_faces * 3).reshape(n_faces, 3)  # [[0,1,2],[3,4,5],...]

        # Build edge→UV midpoint map keyed by VERTEX INDEX pair (not position)
        edge_uv = {}
        for face in exploded_faces:
            for ei in range(3):
                a, b = int(face[ei]), int(face[(ei + 1) % 3])
                key = (min(a, b), max(a, b))
                edge_uv[key] = (exploded_uv[a] + exploded_uv[b]) * 0.5

        # Subdivide the exploded mesh
        n_old = len(exploded_verts)
        new_verts, new_faces = subdivide(exploded_verts, exploded_faces)
        n_new = len(new_verts) - n_old

        # For each new vertex (index >= n_old), find its parent edge
        # by scanning faces that contain it and finding the 2 old vertices
        # Strategy: for each new face, find pairs of (old_vert, new_vert)
        # to determine which edge the new_vert is a midpoint of.
        new_vert_parents = {}  # new_vert_idx -> (old_a, old_b)
        for face in new_faces:
            old_in_face = [v for v in face if v < n_old]
            new_in_face = [v for v in face if v >= n_old]
            if len(old_in_face) == 2 and len(new_in_face) == 1:
                # Face like [old_a, old_b, new_c] — new_c is midpoint of some edge
                # But we need to figure out WHICH edge. new_c connects to both old verts
                # so it could be midpoint of (old_a, X) or (old_b, X)
                pass
            # More reliable: check all edges in the face
            for ei in range(3):
                a, b = int(face[ei]), int(face[(ei + 1) % 3])
                if a >= n_old and b < n_old:
                    # a is new, b is old — a is midpoint of an edge containing b
                    if a not in new_vert_parents:
                        new_vert_parents[a] = set()
                    new_vert_parents[a].add(b)
                elif b >= n_old and a < n_old:
                    if b not in new_vert_parents:
                        new_vert_parents[b] = set()
                    new_vert_parents[b].add(a)

        # Assign UVs to new vertices
        new_uvs = np.zeros((n_new, 2), dtype=np.float64)
        misses = 0
        for i in range(n_new):
            vi = n_old + i
            if vi in new_vert_parents and len(new_vert_parents[vi]) >= 2:
                parents = sorted(new_vert_parents[vi])
                a, b = parents[0], parents[1]
                key = (min(a, b), max(a, b))
                if key in edge_uv:
                    new_uvs[i] = edge_uv[key]
                else:
                    new_uvs[i] = (exploded_uv[a] + exploded_uv[b]) * 0.5
            else:
                misses += 1
                new_uvs[i] = [0.5, 0.5]

        if misses > 0:
            log(f'  WARNING: {misses}/{n_new} UV misses (level {lvl+1})')

        vertices = new_verts
        faces = new_faces
        uv = np.vstack([exploded_uv, new_uvs])

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
    # SUBDIVISION (levels > 0) — edge-based UV interpolation
    # ==================================================================
    result_meshes = {}
    for idx, geom in enumerate(geometries):
        name = list(scene.geometry.keys())[idx] if hasattr(scene, 'geometry') else f'mesh_{idx}'
        verts = np.asarray(geom.vertices, dtype=np.float64)
        faces = np.asarray(geom.faces, dtype=np.int32)
        log(f'  {name}: {len(verts)} verts, {len(faces)} faces before subdivision')

        has_uv = hasattr(geom.visual, 'uv') and geom.visual.uv is not None and len(geom.visual.uv) > 0
        uv = np.asarray(geom.visual.uv, dtype=np.float64) if has_uv else None

        verts, faces, uv = _subdivide_with_uv(verts, faces, uv, levels)
        log(f'  {name}: {len(verts)} verts, {len(faces)} faces after subdivision')

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
        # Re-weld the per-face explode (_subdivide_with_uv gives every
        # triangle its own 3 unique verts). Without this the saved GLB is a
        # disconnected per-face soup (~3x verts) that breaks downstream
        # smoothing/rigging/decimation. merge_vertices (merge_tex defaults
        # False) collapses coincident corners back to one connected body
        # while KEEPING genuine UV seams split.
        try:
            new_mesh.merge_vertices()
        except Exception as e:
            log(f'  {name}: merge_vertices skipped ({e})')
        _ = new_mesh.vertex_normals
        log(f'  {name}: {len(new_mesh.vertices)} verts after re-weld')
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
    """Export meshes to GLB."""
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
