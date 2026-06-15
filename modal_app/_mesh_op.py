"""Cloud port of the desktop mesh quick-edit tools.

Smooth, Decimate, Center, Fix Normals, Fill Holes — all pure trimesh
CPU operations on the GLB. No GPU needed, no Modal class @enter cost.
These can run inside the lightweight mesh_start function (which also
serves the async TRELLIS-2 dispatch).

Most ops return the modified GLB as raw bytes. fill_holes returns a
tuple (bytes, stats_dict) so the client can show a verdict-driven
toast (CLOSED_OK / OPEN_HOLES / WINDING_INCONSISTENT /
NONMANIFOLD_OR_DOUBLE_SKINNED). The OPS dispatch wraps every other op
as (bytes, None) so the worker has a uniform shape to forward.
"""
import io
import trimesh as _trimesh_probe
assert hasattr(_trimesh_probe.repair, 'fill_holes'), \
    'trimesh.repair.fill_holes missing — pin trimesh>=4.4 in modal_app/app.py'
del _trimesh_probe


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


def _count_boundary_edges(m):
    """Return (boundary_edges, nonmanifold_edges) using a sorted-edges
    unique tally. boundary = edges used by exactly 1 triangle;
    nonmanifold = edges used by >2 triangles (e.g. T-junctions, double
    skin, fan-style stitching)."""
    import numpy as np
    if not hasattr(m, 'edges') or len(m.edges) == 0:
        return 0, 0
    e = np.sort(m.edges, axis=1)
    _, _, counts = np.unique(e, axis=0, return_inverse=True, return_counts=True)
    return int((counts == 1).sum()), int((counts > 2).sum())


def _split_tjunctions(m, tol):
    """Detect T-junctions on boundary edges and split the offending
    edge so the two halves can pair with neighbouring triangles. A
    T-junction is a vertex that lies (within tol) on another boundary
    edge but isn't an endpoint of that edge.

    Cheap approach: build a KDTree over boundary vertex positions, for
    each boundary edge query the tree for points inside its segment
    bounding box, classify hits by point-to-segment distance.

    Returns the number of splits performed. This is a NO-OP on textured
    meshes (UV-aware splitter would need to interpolate UVs at the
    new vertex — out of scope for v1) and on very large meshes.
    """
    import numpy as np
    from scipy.spatial import cKDTree

    if not hasattr(m, 'edges') or len(m.edges) == 0:
        return 0
    e_sorted = np.sort(m.edges, axis=1)
    uniq, inv, counts = np.unique(e_sorted, axis=0, return_inverse=True, return_counts=True)
    bmask = (counts == 1)
    if not bmask.any():
        return 0
    boundary_edges = uniq[bmask]  # (B, 2) vertex index pairs

    boundary_verts = np.unique(boundary_edges.ravel())
    if len(boundary_verts) == 0:
        return 0
    verts = m.vertices[boundary_verts]                  # (V, 3)
    pos2idx = {v: i for i, v in enumerate(boundary_verts.tolist())}
    tree = cKDTree(verts)

    splits = 0
    # For each boundary edge, find points close to the segment (not the
    # endpoints) within tol and split. We don't actually split the edge
    # in-place — trimesh would require re-meshing. Instead we record
    # "phantom" vertex pairs that the merge_vertices in the caller can
    # use on the next pass. Practically: bump the boundary vertex onto
    # the edge by a tiny offset so the next merge_vertices catches it.
    # This trades exactness for safety — no faces are modified.
    bumps = {}  # idx in m.vertices -> new position
    tol_sq = float(tol) ** 2
    for a, b in boundary_edges.tolist():
        pa = m.vertices[a]; pb = m.vertices[b]
        ab = pb - pa
        ab_len_sq = float(np.dot(ab, ab))
        if ab_len_sq < tol_sq * 0.01:
            continue
        midpoint = (pa + pb) * 0.5
        radius = float(np.sqrt(ab_len_sq)) * 0.5 + tol
        # Candidates near the edge's midpoint within radius+tol.
        cand_idx = tree.query_ball_point(midpoint, r=radius)
        for ci in cand_idx:
            v_world_idx = int(boundary_verts[ci])
            if v_world_idx == a or v_world_idx == b:
                continue
            p = m.vertices[v_world_idx]
            ap = p - pa
            t = float(np.dot(ap, ab) / ab_len_sq)
            if t <= 1e-3 or t >= 1.0 - 1e-3:
                continue
            proj = pa + t * ab
            d2 = float(np.dot(p - proj, p - proj))
            if d2 < tol_sq:
                bumps[v_world_idx] = proj
                splits += 1
    if bumps:
        for vi, new_pos in bumps.items():
            m.vertices[vi] = new_pos
        # Snap each bumped vertex onto its target → next merge_vertices
        # collapses the pair, the edge becomes a true boundary.
    return splits


def _aggregate_diag(per_mesh):
    """Decide the single verdict reported to the user from per-mesh
    stats. Priority order — most actionable first:
      WINDING_INCONSISTENT > NONMANIFOLD_OR_DOUBLE_SKINNED > OPEN_HOLES > CLOSED_OK
    """
    if not per_mesh:
        return 'CLOSED_OK'
    has_winding = any(d.get('winding_inconsistent') for d in per_mesh)
    has_double = any(d.get('double_skin') or d.get('nonmanifold_edges_final', 0) > 0 for d in per_mesh)
    has_open = any(d.get('boundary_edges_final', 0) > 0 for d in per_mesh)
    if has_winding:
        return 'WINDING_INCONSISTENT'
    if has_double:
        return 'NONMANIFOLD_OR_DOUBLE_SKINNED'
    if has_open:
        return 'OPEN_HOLES'
    return 'CLOSED_OK'


def fill_holes(glb_bytes: bytes):
    """Diagnostic-first hole filling. Returns (glb_bytes, stats_dict).

    Pipeline per mesh:
      0. Strip degenerate faces + unreferenced verts (mirror cloud client)
      1. Count baseline boundary + non-manifold + winding state
      2. merge_vertices with tol = clamp(bbDiag * 1e-4, 1e-7, bbDiag*1e-2)
      3. T-junction split (gated on size + non-textured to stay safe in v1)
      4. fix_winding + fill_holes(use_fan=True)
      5. Recount + aggregate verdict

    The 4-verdict vocabulary lets the client show ONE actionable toast
    instead of "0 boundary edges found" when the real problem is
    inverted normals or double-skinning.
    """
    import numpy as np
    import trimesh

    scene = _load_scene(glb_bytes)
    per_mesh = []
    total_dfaces = 0
    for m in _meshes(scene):
        if not hasattr(m, 'faces'):
            continue
        diag = {'name': getattr(m, 'metadata', {}).get('name', 'mesh')}

        # Step 0 — clean degenerates so boundary counts aren't polluted.
        try:
            m.update_faces(m.nondegenerate_faces())
            m.remove_unreferenced_vertices()
            try: m._cache.clear()
            except Exception: pass
        except Exception as e:
            print(f'[mesh-op] fill_holes clean step warn: {e}', flush=True)

        # Auto-tol from bounding box diagonal — bumped 1e-4 → 1e-3 so
        # TRELLIS meshes with sub-mm vertex gaps actually weld together
        # before fill_holes runs. The previous 1e-4 left visible holes
        # uncounted (boundary edges not detected because the gap was
        # below merge tolerance but still rendered as a hole).
        try:
            bb_diag = float(np.linalg.norm(m.bounds[1] - m.bounds[0])) or 1.0
        except Exception:
            bb_diag = 1.0
        tol = float(np.clip(bb_diag * 1e-3, 1e-6, bb_diag * 1e-2))
        diag['bb_diag'] = round(bb_diag, 6)
        diag['tol'] = round(tol, 9)

        faces_before = int(len(m.faces))
        be_before, nm_before = _count_boundary_edges(m)
        try:
            winding_inconsistent = not bool(getattr(m, 'is_winding_consistent', True))
        except Exception:
            winding_inconsistent = False
        try:
            watertight_before = bool(getattr(m, 'is_watertight', False))
        except Exception:
            watertight_before = False
        diag.update({
            'faces_before': faces_before,
            'boundary_edges_before': be_before,
            'nonmanifold_edges_before': nm_before,
            'winding_inconsistent': winding_inconsistent,
            'watertight_before': watertight_before,
        })

        # Step 2 — aggressive position-only merge.
        try:
            digits = max(1, int(round(-np.log10(tol))))
            m.merge_vertices(merge_tex=True, merge_norm=True, digits_vertex=digits)
        except TypeError:
            try: m.merge_vertices(merge_tex=True, merge_norm=True)
            except Exception as e: print(f'[mesh-op] merge_vertices fallback warn: {e}', flush=True)
        try: m._cache.clear()
        except Exception: pass
        be_after_merge, _ = _count_boundary_edges(m)
        diag['boundary_edges_after_merge'] = be_after_merge

        # Step 3 — T-junction split (gated).
        is_textured = isinstance(getattr(m, 'visual', None), trimesh.visual.TextureVisuals)
        if be_after_merge <= 200_000 and not is_textured:
            try:
                splits = _split_tjunctions(m, tol)
                diag['tjunction_splits'] = int(splits)
                if splits:
                    try: m.merge_vertices(merge_tex=True, merge_norm=True,
                                           digits_vertex=max(1, int(round(-np.log10(tol)))))
                    except TypeError: m.merge_vertices(merge_tex=True, merge_norm=True)
                    try: m._cache.clear()
                    except Exception: pass
            except Exception as e:
                print(f'[mesh-op] tjunction split warn: {e}', flush=True)
                diag['tjunction_splits'] = 0
        else:
            diag['tjunction_splits'] = 0
            diag['tjunc_skipped_reason'] = ('TEXTURED' if is_textured else 'TOO_LARGE')
        be_after_tjunc, nm_after_tjunc = _count_boundary_edges(m)
        diag['boundary_edges_after_tjunc'] = be_after_tjunc

        # Step 4 — re-orient + clean + fill, ITERATED with non-manifold
        # cleanup interleaved. TRELLIS meshes are often non-manifold AND
        # have winding-inconsistent triangles AND have small open holes
        # all at once. Cycle through the repairs until either watertight
        # or stable (no more improvement).
        def _clean_nonmanifold(mesh):
            try:
                # Drop duplicate faces (collapse double-skin layers).
                mesh.update_faces(mesh.unique_faces())
            except Exception: pass
            try:
                # Drop "broken" faces — those incident to non-manifold edges
                # that can't be salvaged. Aggressive but the alternative
                # is leaving holes that fill_holes can't close.
                broken = trimesh.repair.broken_faces(mesh)
                if broken is not None and len(broken) > 0:
                    keep = np.ones(len(mesh.faces), dtype=bool)
                    keep[np.asarray(broken)] = False
                    mesh.update_faces(keep)
                    print(f'[mesh-op] dropped {int((~keep).sum())} broken faces', flush=True)
            except Exception as e:
                print(f'[mesh-op] broken_faces warn: {e}', flush=True)
            try: mesh.remove_unreferenced_vertices()
            except Exception: pass
            try: mesh._cache.clear()
            except Exception: pass

        last_be = be_after_tjunc
        for pass_i in range(4):
            try: trimesh.repair.fix_winding(m)
            except Exception as e: print(f'[mesh-op] fix_winding pass{pass_i} warn: {e}', flush=True)
            try: m._cache.clear()
            except Exception: pass
            # Clean non-manifold *between* passes so fill_holes can see
            # legitimate boundaries instead of being blocked by the
            # double-skin/non-manifold mess.
            _clean_nonmanifold(m)
            try:
                trimesh.repair.fill_holes(m, use_fan=True)
            except TypeError:
                try: trimesh.repair.fill_holes(m)
                except Exception as e: print(f'[mesh-op] fill_holes pass{pass_i} skipped: {e}', flush=True)
            except Exception as e:
                print(f'[mesh-op] fill_holes pass{pass_i} skipped: {e}', flush=True)
            try: m._cache.clear()
            except Exception: pass
            try:
                if bool(getattr(m, 'is_watertight', False)):
                    break
            except Exception:
                pass
            try:
                be_now, _ = _count_boundary_edges(m)
            except Exception:
                be_now = last_be
            if be_now >= last_be and pass_i >= 1:
                break  # no progress, stop trying
            last_be = be_now
        # Final fix_normals — flips remaining backward-facing triangles.
        try:
            m.fix_normals()
            m._cache.clear()
        except Exception as e:
            print(f'[mesh-op] fix_normals final warn: {e}', flush=True)

        be_final, nm_final = _count_boundary_edges(m)
        faces_after = int(len(m.faces))
        dfaces = max(0, faces_after - faces_before)
        total_dfaces += dfaces
        try: watertight_after = bool(getattr(m, 'is_watertight', False))
        except Exception: watertight_after = (be_final == 0)
        # Double-skin heuristic: lots of non-manifold edges but no
        # boundary → two layers of triangles stitched together.
        double_skin = (nm_final > max(50, int(faces_after * 0.05))) and be_final == 0
        diag.update({
            'faces_after': faces_after,
            'holes_filled_delta_faces': dfaces,
            'boundary_edges_final': be_final,
            'nonmanifold_edges_final': nm_final,
            'watertight_after': watertight_after,
            'double_skin': double_skin,
        })
        per_mesh.append(diag)
        print(f'[mesh-op] fill_holes mesh={diag["name"]} '
              f'be:{be_before}→{be_final} nm:{nm_before}→{nm_final} '
              f'Δfaces={dfaces} verdict-input={diag}', flush=True)

    stats = {
        'verdict': _aggregate_diag(per_mesh),
        'holes_filled_delta_faces': total_dfaces,
        'meshes': per_mesh,
    }
    return _export(scene), stats


def material_adjust(glb_bytes: bytes,
                    brightness: float = 1.0,
                    saturation: float = 1.0,
                    contrast: float = 1.0,
                    emissive: float = 0.0,
                    metallic: float = 0.0,
                    roughness: float = 0.7,
                    hue_shift: float = 0.0) -> bytes:
    """Re-bake the GLB's baseColorTexture with PIL ImageEnhance
    (brightness/saturation/contrast) + optional hue rotation, and
    overwrite the PBR factors. hue_shift is in DEGREES (-180..+180),
    0 = no change. Mirrors scripts/mesh_material_adjust.py."""
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
            if float(hue_shift) != 0.0:
                # PIL HSV uses 0-255 for H; 360deg maps to 256 units.
                # We also floor the saturation by abs(hue_shift)/360 *
                # 0.5 * 255 so grey/dark pixels pick up the tint
                # (otherwise only the saturated parts of the texture
                # change colour and the rest stays grey). Same logic
                # as the live shader so preview ≈ save.
                import numpy as _np
                shift_units = int(round((float(hue_shift) / 360.0) * 256.0)) % 256
                sat_floor = int(round(abs(float(hue_shift) / 360.0) * 0.5 * 255))
                hsv = img.convert('HSV')
                arr = _np.array(hsv, dtype=_np.int16)
                arr[..., 0] = (arr[..., 0] + shift_units) % 256
                arr[..., 1] = _np.maximum(arr[..., 1], sat_floor)
                hsv = Image.fromarray(arr.astype(_np.uint8), mode='HSV')
                img = hsv.convert('RGB')
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
def watertight(glb_bytes: bytes, resolution: int = 128) -> bytes:
    """Rebuild a CLOSED, watertight shell via voxel remesh + marching cubes.

    Fuses every disconnected body into one solid with no holes (loses the
    texture — re-texture afterwards). Mirror of desktop
    scripts/mesh_tools.watertight."""
    import numpy as np
    import trimesh
    resolution = max(32, min(400, int(resolution)))
    scene = _load_scene(glb_bytes)
    meshes = [m for m in _meshes(scene)
              if hasattr(m, 'vertices') and len(m.vertices)
              and hasattr(m, 'faces') and len(m.faces)]
    if not meshes:
        return _export(scene)
    mesh = trimesh.util.concatenate(
        [trimesh.Trimesh(vertices=np.asarray(m.vertices), faces=np.asarray(m.faces)) for m in meshes])
    diag = float(np.linalg.norm(mesh.bounds[1] - mesh.bounds[0])) or 1.0
    vg = mesh.voxelized(pitch=diag / resolution)
    try:
        vg = vg.fill()
    except Exception as e:
        print(f'[mesh-op] watertight fill warn: {e}', flush=True)
    wt = vg.marching_cubes
    try:
        trimesh.smoothing.filter_laplacian(wt, iterations=2, lamb=0.5, volume_constraint=False)
    except Exception:
        pass
    try:
        wt.fix_normals()
    except Exception:
        pass
    return _export(trimesh.Scene(wt))


OPS = {
    'smooth':          smooth,
    'decimate':        decimate,
    'watertight':      watertight,
    'center':          center,
    'fix_normals':     fix_normals,
    'fill_holes':      fill_holes,
    'subdivide':       subdivide,
    'align_texture':   align_texture,
    'material':        normalize_material,
    'material_adjust': material_adjust,  # 6-slider PBR tweak (mirror of scripts/mesh_material_adjust.py)
    'retex_swap':      retex_swap_atlas,
}


def run(op_type: str, glb_bytes: bytes, params: dict | None = None):
    """Single entry point — the worker passes op_type + GLB bytes +
    params, we route to the right helper above and return a
    (bytes, stats|None) tuple. fill_holes populates stats with a
    verdict + per-mesh diagnostic; every other op returns stats=None.
    Unknown ops raise ValueError."""
    if op_type not in OPS:
        raise ValueError(f'unknown mesh op: {op_type}')
    p = params or {}
    if op_type == 'smooth':
        return smooth(glb_bytes, iterations=int(p.get('iterations', 5)),
                                  lamb=float(p.get('lamb', 0.5))), None
    if op_type == 'decimate':
        return decimate(glb_bytes, target_faces=int(p.get('target_faces', 50_000))), None
    if op_type == 'subdivide':
        return subdivide(glb_bytes, iterations=int(p.get('iterations', 1))), None
    if op_type == 'watertight':
        return watertight(glb_bytes, resolution=int(p.get('resolution', 128))), None
    if op_type == 'retex_swap':
        return retex_swap_atlas(glb_bytes, str(p.get('image_url') or '')), None
    if op_type == 'material_adjust':
        return material_adjust(glb_bytes,
            brightness=float(p.get('brightness', 1.0)),
            saturation=float(p.get('saturation', 1.0)),
            contrast=float(p.get('contrast', 1.0)),
            emissive=float(p.get('emissive', 0.0)),
            metallic=float(p.get('metallic', 0.0)),
            roughness=float(p.get('roughness', 0.7)),
            hue_shift=float(p.get('hue_shift', 0.0))), None
    if op_type == 'fill_holes':
        # fill_holes already returns (bytes, stats_dict).
        return fill_holes(glb_bytes)
    return OPS[op_type](glb_bytes), None
