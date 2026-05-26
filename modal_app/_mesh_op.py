"""Cloud port of the desktop mesh quick-edit tools.

Smooth, Decimate, Center, Fix Normals, Fill Holes — all pure trimesh
CPU operations on the GLB. No GPU needed, no Modal class @enter cost.
These can run inside the lightweight mesh_start function (which also
serves the async TRELLIS-2 dispatch).

Returns the modified GLB as raw bytes. The caller (mesh_start) handles
the HTTP response shape and the worker handles R2 mirroring.
"""
import io


def _load_scene(glb_bytes: bytes):
    """Load GLB into a trimesh Scene (always a Scene, never a Trimesh
    directly, so we have one consistent API)."""
    import trimesh
    return trimesh.load(io.BytesIO(glb_bytes), file_type='glb', force='scene')


def _export(scene) -> bytes:
    """Serialize scene back to GLB bytes, preserving WebP textures."""
    buf = io.BytesIO()
    scene.export(buf, file_type='glb', extension_webp=True)
    return buf.getvalue()


def _meshes(scene):
    """Iterate the trimesh.Trimesh objects inside a Scene."""
    if hasattr(scene, 'geometry'):
        return list(scene.geometry.values())
    return [scene]


def smooth(glb_bytes: bytes, iterations: int = 5, lamb: float = 0.5) -> bytes:
    """Laplacian smoothing (filter_laplacian) on every mesh. The lambda
    factor controls strength — 0.5 matches the desktop default."""
    import trimesh
    scene = _load_scene(glb_bytes)
    for m in _meshes(scene):
        if not hasattr(m, 'vertices'):
            continue
        trimesh.smoothing.filter_laplacian(m, lamb=float(lamb),
                                            iterations=int(iterations))
    return _export(scene)


def decimate(glb_bytes: bytes, target_faces: int = 50_000) -> bytes:
    """Quadric edge collapse decimation. target_faces is the desired
    face count for the LARGEST mesh; smaller meshes get proportional
    decimation. Same defaults as the desktop preset 'medium'."""
    scene = _load_scene(glb_bytes)
    meshes = _meshes(scene)
    if not meshes:
        return glb_bytes
    max_faces = max(len(m.faces) for m in meshes if hasattr(m, 'faces'))
    if max_faces <= target_faces:
        return glb_bytes  # already at or below the target
    ratio = max(0.05, min(1.0, target_faces / max_faces))
    for m in meshes:
        if not hasattr(m, 'faces') or len(m.faces) < 100:
            continue
        try:
            n = max(50, int(len(m.faces) * ratio))
            m_new = m.simplify_quadric_decimation(n)
            m.vertices = m_new.vertices
            m.faces = m_new.faces
            # visual (uv/texture) is dropped by simplify — that's a
            # known trimesh limitation; the desktop accepts the same
            # trade-off (texture re-bake is a separate Re-Texture op).
        except Exception as e:
            print(f'[mesh-op] decimate skipped: {e}', flush=True)
    return _export(scene)


def center(glb_bytes: bytes) -> bytes:
    """Translate every mesh so the joint bounding box sits at the
    origin. Y-axis is brought to bottom=0 (matches desktop / Unreal
    convention where models stand on the ground plane)."""
    import numpy as np
    scene = _load_scene(glb_bytes)
    meshes = _meshes(scene)
    if not meshes:
        return glb_bytes
    all_verts = np.concatenate([m.vertices for m in meshes if hasattr(m, 'vertices')])
    if len(all_verts) == 0:
        return glb_bytes
    cx = (all_verts[:, 0].min() + all_verts[:, 0].max()) / 2.0
    cz = (all_verts[:, 2].min() + all_verts[:, 2].max()) / 2.0
    cy = all_verts[:, 1].min()  # bottom at y=0
    for m in meshes:
        if hasattr(m, 'vertices'):
            m.vertices[:, 0] -= cx
            m.vertices[:, 1] -= cy
            m.vertices[:, 2] -= cz
    return _export(scene)


def fix_normals(glb_bytes: bytes) -> bytes:
    """Recompute vertex normals so lighting looks correct. trimesh
    handles flipping winding order on inverted faces during this."""
    scene = _load_scene(glb_bytes)
    for m in _meshes(scene):
        if not hasattr(m, 'fix_normals'):
            continue
        try:
            m.fix_normals()
        except Exception as e:
            print(f'[mesh-op] fix_normals skipped: {e}', flush=True)
    return _export(scene)


def fill_holes(glb_bytes: bytes) -> bytes:
    """Patch small holes via trimesh.repair.fill_holes (a hole is a
    cycle of boundary edges shorter than max_edge_count). Useful after
    boolean ops or aggressive decimation."""
    import trimesh
    scene = _load_scene(glb_bytes)
    for m in _meshes(scene):
        if not hasattr(m, 'faces'):
            continue
        try:
            trimesh.repair.fill_holes(m)
        except Exception as e:
            print(f'[mesh-op] fill_holes skipped: {e}', flush=True)
    return _export(scene)


# Dispatch table for the mesh_start endpoint.
OPS = {
    'smooth':       smooth,
    'decimate':     decimate,
    'center':       center,
    'fix_normals':  fix_normals,
    'fill_holes':   fill_holes,
}


def run(op_type: str, glb_bytes: bytes, params: dict | None = None) -> bytes:
    """Single entry point — the worker passes op_type + GLB bytes +
    params, we route to the right helper above and return the new
    GLB bytes. Unknown ops raise ValueError."""
    if op_type not in OPS:
        raise ValueError(f'unknown mesh op: {op_type}')
    p = params or {}
    if op_type == 'smooth':
        return smooth(glb_bytes, iterations=int(p.get('iterations', 5)),
                                  lamb=float(p.get('lamb', 0.5)))
    if op_type == 'decimate':
        return decimate(glb_bytes, target_faces=int(p.get('target_faces', 50_000)))
    return OPS[op_type](glb_bytes)
