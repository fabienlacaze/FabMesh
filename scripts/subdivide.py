"""
FabMesh mesh subdivision (Python-only, no Blender dependency).
==============================================================

Subdivides a GLB mesh using Catmull-Clark (pymeshlab) while preserving
PBR textures and UV maps. Each level ×4 the triangle count.

Usage:
    python subdivide.py <input.glb> <output.glb> <levels>

Levels:
    1 → ~4× triangles  (13K → ~53K)
    2 → ~16× triangles (13K → ~212K)
    3 → ~64× triangles (13K → ~850K)

Dependencies: trimesh, pymeshlab, numpy, PIL — all already installed for SF3D.
No Blender required.
"""
import sys
import os
import time
import numpy as np
import trimesh
import trimesh.visual as _vis
import trimesh.visual.material as _mat


def log(msg):
    print(f'[subdivide] {msg}', flush=True)


def subdivide_glb(input_path, output_path, levels=2):
    """Load a GLB, subdivide, re-export with original textures."""
    import pymeshlab

    log(f'input={input_path} output={output_path} levels={levels}')
    t0 = time.time()

    # ------------------------------------------------------------------
    # 1. Load GLB via trimesh — this gives us the PBR material + UVs
    # ------------------------------------------------------------------
    scene = trimesh.load(input_path)
    geometries = list(scene.geometry.values()) if hasattr(scene, 'geometry') else [scene]
    if not geometries:
        log('ERROR: no geometry found in GLB')
        return False

    log(f'loaded {len(geometries)} geometry(ies)')

    result_meshes = {}
    for idx, geom in enumerate(geometries):
        name = list(scene.geometry.keys())[idx] if hasattr(scene, 'geometry') else f'mesh_{idx}'
        verts = np.asarray(geom.vertices, dtype=np.float64)
        faces = np.asarray(geom.faces, dtype=np.int32)
        log(f'  {name}: {len(verts)} verts, {len(faces)} faces before subdivision')

        # Extract UVs if present
        has_uv = (hasattr(geom.visual, 'uv') and geom.visual.uv is not None
                  and len(geom.visual.uv) > 0)

        # ------------------------------------------------------------------
        # 2. Subdivide via pymeshlab
        # ------------------------------------------------------------------
        ms = pymeshlab.MeshSet()
        pm = pymeshlab.Mesh(
            vertex_matrix=verts,
            face_matrix=faces,
        )
        # Attach UVs as wedge texture coordinates if available
        if has_uv:
            uv = np.asarray(geom.visual.uv, dtype=np.float64)
            # pymeshlab wants per-face-vertex (wedge) UVs: shape (n_faces, 3, 2)
            face_uv = uv[faces]  # (n_faces, 3, 2)
            pm = pymeshlab.Mesh(
                vertex_matrix=verts,
                face_matrix=faces,
                f_wedge_tex_coord_matrix=face_uv.reshape(-1, 2),
            )

        ms.add_mesh(pm)
        ms.meshing_surface_subdivision_catmull_clark(iterations=int(levels))
        out = ms.current_mesh()

        new_verts = np.asarray(out.vertex_matrix(), dtype=np.float32)
        new_faces = np.asarray(out.face_matrix(), dtype=np.int32)
        log(f'  {name}: {len(new_verts)} verts, {len(new_faces)} faces after subdivision')

        # ------------------------------------------------------------------
        # 3. Rebuild the trimesh with original material
        # ------------------------------------------------------------------
        # Try to recover subdivided UVs from pymeshlab
        new_uv = None
        try:
            wedge_uv = np.asarray(out.wedge_tex_coord_matrix(), dtype=np.float32)
            if wedge_uv.shape[0] == new_faces.shape[0] * 3:
                # Convert wedge (per-face-vertex) back to per-vertex UVs.
                # This is lossy at UV seams but good enough for smooth subdivision.
                new_uv = np.zeros((len(new_verts), 2), dtype=np.float32)
                counts = np.zeros(len(new_verts), dtype=np.float32)
                flat_faces = new_faces.flatten()
                for i in range(len(flat_faces)):
                    vi = flat_faces[i]
                    new_uv[vi] += wedge_uv[i]
                    counts[vi] += 1
                mask = counts > 0
                new_uv[mask] /= counts[mask, None]
        except Exception as e:
            log(f'  UV recovery failed ({e}), using projection fallback')

        # If UVs were lost or not available, generate simple spherical projection
        if new_uv is None or len(new_uv) != len(new_verts):
            log(f'  generating fallback spherical UV projection')
            center = new_verts.mean(axis=0)
            d = new_verts - center
            norms = np.linalg.norm(d, axis=1, keepdims=True)
            norms[norms < 1e-8] = 1.0
            d = d / norms
            u = 0.5 + np.arctan2(d[:, 0], d[:, 2]) / (2 * np.pi)
            v = 0.5 + np.arcsin(np.clip(d[:, 1], -1, 1)) / np.pi
            new_uv = np.column_stack([u, v]).astype(np.float32)

        # Reconstruct visual with original PBR material
        original_material = None
        if hasattr(geom.visual, 'material'):
            original_material = geom.visual.material

        if original_material is not None:
            visual = _vis.TextureVisuals(uv=new_uv, material=original_material)
        else:
            visual = _vis.TextureVisuals(uv=new_uv)

        new_mesh = trimesh.Trimesh(
            vertices=new_verts,
            faces=new_faces,
            visual=visual,
            process=False,
        )
        # Force vertex normals
        _ = new_mesh.vertex_normals

        result_meshes[name] = new_mesh

    # ------------------------------------------------------------------
    # 4. Export as GLB
    # ------------------------------------------------------------------
    if len(result_meshes) == 1:
        mesh = list(result_meshes.values())[0]
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        mesh.export(output_path)
    else:
        new_scene = trimesh.Scene(geometry=result_meshes)
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        new_scene.export(output_path)

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
