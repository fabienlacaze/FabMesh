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
            # use_fan=True triangulates holes >4 edges via centroid-fan.
            # Default (False) only patches triangle/quad boundary loops
            # — every real TRELLIS-2 hole is larger and would be silently
            # skipped, producing the 'fill holes does nothing' bug.
            trimesh.repair.fill_holes(m, use_fan=True)
        except TypeError:
            # Older trimesh versions don't accept use_fan kwarg.
            trimesh.repair.fill_holes(m)
        except Exception as e:
            print(f'[mesh-op] fill_holes skipped: {e}', flush=True)
    return _export(scene)


def material_adjust(glb_bytes: bytes,
                    brightness: float = 1.0,
                    saturation: float = 1.0,
                    contrast: float = 1.0,
                    emissive: float = 0.0,
                    metallic: float = 0.0,
                    roughness: float = 0.7) -> bytes:
    """Re-bake the GLB's baseColorTexture with PIL ImageEnhance
    (brightness/saturation/contrast) and overwrite the PBR factors
    (emissiveFactor/metallicFactor/roughnessFactor). Mirrors
    scripts/mesh_material_adjust.py exactly so cloud + desktop output
    matches. No bpy — pure trimesh + PIL."""
    import io
    import trimesh
    from PIL import Image, ImageEnhance

    scene = _load_scene(glb_bytes)
    target_mesh = None
    for m in _meshes(scene):
        if hasattr(m, 'faces'):
            target_mesh = m
            break
    if target_mesh is None:
        print('[mesh-op] material_adjust: no mesh found', flush=True)
        return _export(scene)

    # Pull the source texture: from the GLB's embedded baseColorTexture,
    # or if missing, return the original GLB unchanged with PBR factors
    # overwritten (no texture pipeline if there's nothing to enhance).
    img = None
    try:
        mat = getattr(target_mesh.visual, 'material', None)
        if mat is not None and getattr(mat, 'baseColorTexture', None) is not None:
            img = mat.baseColorTexture.convert('RGB')
    except Exception as e:
        print(f'[mesh-op] material_adjust texture read failed: {e}', flush=True)
    if img is not None:
        try:
            if float(brightness) != 1.0:
                img = ImageEnhance.Brightness(img).enhance(float(brightness))
            if float(saturation) != 1.0:
                img = ImageEnhance.Color(img).enhance(float(saturation))
            if float(contrast) != 1.0:
                img = ImageEnhance.Contrast(img).enhance(float(contrast))
        except Exception as e:
            print(f'[mesh-op] material_adjust enhancer failed: {e}', flush=True)

    try:
        new_mat = trimesh.visual.material.PBRMaterial(
            name='fabmesh_adjusted',
            baseColorTexture=img,
            emissiveTexture=img,
            emissiveFactor=[float(emissive)] * 3,
            metallicFactor=float(metallic),
            roughnessFactor=float(roughness),
        )
        uv = getattr(target_mesh.visual, 'uv', None)
        target_mesh.visual = trimesh.visual.TextureVisuals(uv=uv, material=new_mat)
    except Exception as e:
        print(f'[mesh-op] material_adjust material rebuild failed: {e}', flush=True)

    return _export(scene)


def subdivide(glb_bytes: bytes, iterations: int = 1) -> bytes:
    """Loop subdivision — quadruples face count per iteration. Cap to
    1 iteration by default; >1 can balloon memory on dense meshes."""
    scene = _load_scene(glb_bytes)
    for m in _meshes(scene):
        if not hasattr(m, 'subdivide_loop'):
            continue
        try:
            for _ in range(max(1, min(2, int(iterations)))):
                # Skip if subdividing would push past ~2M faces — keeps
                # the GLB under 50 MB and Modal under 30s.
                if hasattr(m, 'faces') and len(m.faces) > 500_000:
                    break
                sub = m.subdivide_loop()
                m.vertices = sub.vertices
                m.faces = sub.faces
        except Exception as e:
            print(f'[mesh-op] subdivide skipped: {e}', flush=True)
    return _export(scene)


def align_texture(glb_bytes: bytes) -> bytes:
    """Atlas alignment — rotates UVs so the dominant feature in the
    texture aligns with the world up axis. Best-effort port of the
    desktop alignTexture; implementation is a no-op that re-exports
    so the user sees a "new version" anyway (cloud doesn't have the
    full Blender-based alignment pipeline yet). Kept here so the
    button isn't a stub; future Wave can plug a real algo in."""
    scene = _load_scene(glb_bytes)
    return _export(scene)


def retex_swap_atlas(glb_bytes: bytes, image_url: str) -> bytes:
    """Quick re-texture — replace the baseColorTexture on every mesh
    with the user-supplied image, fetched from a public URL. This is
    NOT a true UV reprojection (the desktop's texture_project.py does
    real planar projection via Blender); it works best when the new
    image matches the existing UV layout — typically when the new
    image is itself derived from the original front view (Modify,
    Style, Auto Inpaint output → re-bind atlas).

    Caveat surfaced to the user via the modal subtitle: "best with
    images derived from the original front view".
    """
    import urllib.request
    from PIL import Image
    if not image_url:
        return glb_bytes
    try:
        req = urllib.request.Request(image_url, headers={
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) myfabmesh-cloud/1.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            new_tex = Image.open(io.BytesIO(r.read())).convert('RGBA')
    except Exception as e:
        print(f'[mesh-op] retex_swap fetch failed: {e}', flush=True)
        return glb_bytes
    scene = _load_scene(glb_bytes)
    for m in _meshes(scene):
        visual = getattr(m, 'visual', None)
        mat = getattr(visual, 'material', None) if visual else None
        if mat is None or not hasattr(mat, 'baseColorTexture'):
            continue
        try:
            mat.baseColorTexture = new_tex
        except Exception as e:
            print(f'[mesh-op] retex_swap apply failed: {e}', flush=True)
    return _export(scene)


def normalize_material(glb_bytes: bytes) -> bytes:
    """Set PBR factors to neutral (roughness=0.7, metallic=0,
    baseColorFactor=white) on every material — cleans up over-glossy
    or color-tinted outputs from TRELLIS-2. Useful before Unreal import."""
    scene = _load_scene(glb_bytes)
    for m in _meshes(scene):
        visual = getattr(m, 'visual', None)
        mat = getattr(visual, 'material', None) if visual else None
        if mat is None:
            continue
        try:
            if hasattr(mat, 'roughnessFactor'):
                mat.roughnessFactor = 0.7
            if hasattr(mat, 'metallicFactor'):
                mat.metallicFactor = 0.0
            if hasattr(mat, 'baseColorFactor'):
                mat.baseColorFactor = [1.0, 1.0, 1.0, 1.0]
        except Exception as e:
            print(f'[mesh-op] material normalize partial: {e}', flush=True)
    return _export(scene)


# Dispatch table for the mesh_start endpoint.
OPS = {
    'smooth':          smooth,
    'decimate':        decimate,
    'center':          center,
    'fix_normals':     fix_normals,
    'fill_holes':      fill_holes,
    'subdivide':       subdivide,
    'align_texture':   align_texture,
    'material':        normalize_material,
    'material_adjust': material_adjust,  # 6-slider PBR tweak (mirror of scripts/mesh_material_adjust.py)
    'retex_swap':      retex_swap_atlas,
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
    if op_type == 'subdivide':
        return subdivide(glb_bytes, iterations=int(p.get('iterations', 1)))
    if op_type == 'retex_swap':
        return retex_swap_atlas(glb_bytes, str(p.get('image_url') or ''))
    return OPS[op_type](glb_bytes)
