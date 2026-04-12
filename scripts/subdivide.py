"""
FabMesh mesh subdivision (Python-only, no Blender, no pymeshlab).
================================================================

Subdivides a GLB mesh using midpoint subdivision (trimesh) while
preserving PBR textures and UV maps. Each level ×4 the triangle count.

Usage:
    python subdivide.py <input.glb> <output.glb> <levels>

Levels:
    1 → ~4× triangles
    2 → ~16× triangles
    3 → ~64× triangles

Dependencies: trimesh, numpy, PIL — all already installed for SF3D.
"""
import sys
import os
import time
import numpy as np
import trimesh
import trimesh.visual as _vis
import trimesh.visual.material as _mat
from trimesh.remesh import subdivide


def log(msg):
    print(f'[subdivide] {msg}', flush=True)


def subdivide_glb(input_path, output_path, levels=2):
    """Load a GLB, subdivide or decimate, re-export with original textures.

    levels > 0: subdivision (each level ×4 triangles)
    levels < 0: decimate to abs(levels) target faces via pymeshlab
    """
    log(f'input={input_path} output={output_path} levels={levels}')
    t0 = time.time()
    levels = int(levels)

    # ------------------------------------------------------------------
    # 1. Load GLB
    # ------------------------------------------------------------------
    scene = trimesh.load(input_path)
    geometries = list(scene.geometry.values()) if hasattr(scene, 'geometry') else [scene]
    if not geometries:
        log('ERROR: no geometry found in GLB')
        return False

    log(f'loaded {len(geometries)} geometry(ies)')

    # ------------------------------------------------------------------
    # DECIMATION path (levels < 0)
    # ------------------------------------------------------------------
    if levels < 0:
        import pymeshlab
        target_faces = abs(levels)
        result_meshes = {}
        for idx, geom in enumerate(geometries):
            name = list(scene.geometry.keys())[idx] if hasattr(scene, 'geometry') else f'mesh_{idx}'
            log(f'  {name}: {len(geom.vertices)} verts, {len(geom.faces)} faces -> decimate to ~{target_faces}')
            ms = pymeshlab.MeshSet()
            pm = pymeshlab.Mesh(
                vertex_matrix=np.asarray(geom.vertices, dtype=np.float64),
                face_matrix=np.asarray(geom.faces, dtype=np.int32),
            )
            ms.add_mesh(pm)
            ms.meshing_decimation_quadric_edge_collapse(
                targetfacenum=target_faces,
                preservenormal=True,
                preserveboundary=True,
                preservetopology=True,
            )
            out_m = ms.current_mesh()
            new_v = np.asarray(out_m.vertex_matrix(), dtype=np.float32)
            new_f = np.asarray(out_m.face_matrix(), dtype=np.int32)
            log(f'  {name}: decimated to {len(new_v)} verts, {len(new_f)} faces')
            # Rebuild with original material + interpolated/fallback UVs
            mat = geom.visual.material if hasattr(geom.visual, 'material') else None
            has_uv = hasattr(geom.visual, 'uv') and geom.visual.uv is not None and len(geom.visual.uv) > 0
            if has_uv and len(geom.visual.uv) == len(geom.vertices):
                # Nearest-neighbor UV transfer from original to decimated verts
                from scipy.spatial import cKDTree
                tree = cKDTree(np.asarray(geom.vertices, dtype=np.float64))
                _, idx_map = tree.query(new_v)
                new_uv = np.asarray(geom.visual.uv, dtype=np.float32)[idx_map]
            else:
                # Spherical fallback
                center = new_v.mean(axis=0)
                d = new_v - center
                norms = np.linalg.norm(d, axis=1, keepdims=True); norms[norms < 1e-8] = 1.0
                d = d / norms
                u = 0.5 + np.arctan2(d[:, 0], d[:, 2]) / (2 * np.pi)
                v = 0.5 + np.arcsin(np.clip(d[:, 1], -1, 1)) / np.pi
                new_uv = np.column_stack([u, v]).astype(np.float32)
            visual = _vis.TextureVisuals(uv=new_uv, material=mat) if mat else None
            new_mesh = trimesh.Trimesh(vertices=new_v, faces=new_f, visual=visual, process=False)
            _ = new_mesh.vertex_normals
            result_meshes[name] = new_mesh
        # Export
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
        return True

    # ------------------------------------------------------------------
    # SUBDIVISION path (levels > 0)
    # ------------------------------------------------------------------
    result_meshes = {}
    for idx, geom in enumerate(geometries):
        name = list(scene.geometry.keys())[idx] if hasattr(scene, 'geometry') else f'mesh_{idx}'
        verts = np.asarray(geom.vertices, dtype=np.float64)
        faces = np.asarray(geom.faces, dtype=np.int32)
        log(f'  {name}: {len(verts)} verts, {len(faces)} faces before subdivision')

        # Extract UVs if present
        has_uv = (hasattr(geom.visual, 'uv') and geom.visual.uv is not None
                  and len(geom.visual.uv) > 0)
        uv = np.asarray(geom.visual.uv, dtype=np.float64) if has_uv else None

        # ------------------------------------------------------------------
        # 2. Subdivide geometry + interpolate UVs
        # ------------------------------------------------------------------
        for lvl in range(int(levels)):
            n_verts_before = len(verts)
            # trimesh.remesh.subdivide: splits each triangle into 4 by
            # inserting midpoints on each edge. Returns (new_verts, new_faces).
            verts, faces = subdivide(verts, faces)

            # Interpolate UVs for the new midpoint vertices.
            # subdivide() adds new verts at indices [n_verts_before:] — each
            # new vert is the midpoint of an edge. We approximate its UV as
            # the average of the 2 endpoint UVs. This is exact for linear
            # interpolation and good enough for textured game assets.
            if uv is not None:
                n_new = len(verts) - n_verts_before
                if n_new > 0:
                    # Build a UV array for the new vertices by averaging
                    # the UVs of the face-vertices that reference them.
                    new_uv = np.zeros((n_new, 2), dtype=np.float64)
                    counts = np.zeros(n_new, dtype=np.float64)
                    for f in faces:
                        for vi in f:
                            if vi >= n_verts_before:
                                # This is a new midpoint vertex. Average the
                                # UVs of all original verts in faces that
                                # share it. As a fast approximation we use
                                # the UVs of the other verts in this face.
                                for vj in f:
                                    if vj < len(uv):
                                        ni = vi - n_verts_before
                                        new_uv[ni] += uv[vj]
                                        counts[ni] += 1
                    mask = counts > 0
                    new_uv[mask] /= counts[mask, None]
                    uv = np.vstack([uv, new_uv])

        log(f'  {name}: {len(verts)} verts, {len(faces)} faces after subdivision')

        # ------------------------------------------------------------------
        # 3. Rebuild the trimesh with original material
        # ------------------------------------------------------------------
        new_verts = np.asarray(verts, dtype=np.float32)
        new_faces = np.asarray(faces, dtype=np.int32)

        # Use original PBR material
        original_material = None
        if hasattr(geom.visual, 'material'):
            original_material = geom.visual.material

        if uv is not None and len(uv) == len(new_verts) and original_material is not None:
            visual = _vis.TextureVisuals(
                uv=np.asarray(uv, dtype=np.float32),
                material=original_material,
            )
        elif original_material is not None:
            # UVs lost or mismatched — generate spherical fallback
            log(f'  generating fallback spherical UV projection')
            center = new_verts.mean(axis=0)
            d = new_verts - center
            norms = np.linalg.norm(d, axis=1, keepdims=True)
            norms[norms < 1e-8] = 1.0
            d = d / norms
            u = 0.5 + np.arctan2(d[:, 0], d[:, 2]) / (2 * np.pi)
            v = 0.5 + np.arcsin(np.clip(d[:, 1], -1, 1)) / np.pi
            fallback_uv = np.column_stack([u, v]).astype(np.float32)
            visual = _vis.TextureVisuals(uv=fallback_uv, material=original_material)
        else:
            visual = None

        new_mesh = trimesh.Trimesh(
            vertices=new_verts,
            faces=new_faces,
            visual=visual,
            process=False,
        )
        _ = new_mesh.vertex_normals
        result_meshes[name] = new_mesh

    # ------------------------------------------------------------------
    # 4. Export as GLB
    # ------------------------------------------------------------------
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    if len(result_meshes) == 1:
        list(result_meshes.values())[0].export(output_path)
    else:
        trimesh.Scene(geometry=result_meshes).export(output_path)

    elapsed = time.time() - t0
    size = os.path.getsize(output_path)
    total_verts = sum(len(m.vertices) for m in result_meshes.values())
    total_faces = sum(len(m.faces) for m in result_meshes.values())
    print(f'SUBDIVIDE_STATS: verts={total_verts} faces={total_faces}', flush=True)
    print(f'SUBDIVIDE_SUCCESS: {output_path} ({size} bytes) in {elapsed:.1f}s', flush=True)
    return True


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
