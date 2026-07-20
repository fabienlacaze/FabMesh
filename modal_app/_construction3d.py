"""Cloud port of the desktop 3D construction-stages fabricator
(scripts/construction_stages_3d.py, commit fecfda6).

For each stage p: solid = bottom p% of the mesh (face filter -> texture
preserved) + cap; plank work floor over the cut; closed formwork band;
timber frame; modular scaffold cage following the building's own contour.
Per-component materials (scaffold / frame / planks / formwork).

Cloud differences vs desktop:
- operates on GLB bytes in memory, returns a list of stage GLB bytes
  (last = exact input copy);
- FLAT palette colours only — the desktop's style-matched SDXL+IP-Adapter
  texture pass needs a GPU container; parity gap documented, the geometry,
  grain metadata and per-component palettes/PBR are identical so the GPU
  texture pass can be added later without reshaping this module;
- matplotlib.path replaced by a numpy even-odd point-in-polygon test
  (matplotlib is not in the Modal CPU image).

Pure CPU trimesh. Runs inside the mesh_start container (same image as
_mesh_op).
"""
import io

MATS = {
    'wood': {
        'palette': [[140, 98, 55, 255], [168, 124, 76, 255], [122, 86, 48, 255],
                    [152, 110, 66, 255], [176, 136, 88, 255]],
        'metal': 0.0, 'rough': 0.9},
    'metal': {
        'palette': [[176, 180, 188, 255], [150, 155, 164, 255], [196, 200, 206, 255],
                    [132, 138, 148, 255], [166, 172, 180, 255]],
        'metal': 0.9, 'rough': 0.35},
    'bamboo': {
        'palette': [[196, 176, 96, 255], [176, 158, 84, 255], [206, 190, 112, 255],
                    [160, 148, 78, 255], [188, 172, 100, 255]],
        'metal': 0.0, 'rough': 0.7},
    'aluminium': {
        'palette': [[205, 208, 213, 255], [186, 190, 197, 255], [218, 221, 226, 255],
                    [170, 175, 183, 255], [198, 202, 209, 255]],
        'metal': 0.95, 'rough': 0.28},
}
_ALLOWED = set(MATS.keys())


def _points_in_polys(pts2, polys):
    """Even-odd (crossing) test of N points against a list of XZ polygons —
    numpy port of matplotlib.path.contains_points for the work floor."""
    import numpy as np
    cnt = np.zeros(len(pts2), int)
    for poly in polys:
        x, z = poly[:, 0], poly[:, 1]
        xj, zj = np.roll(x, 1), np.roll(z, 1)
        inside = np.zeros(len(pts2), bool)
        for i in range(len(x)):
            cond = ((z[i] > pts2[:, 1]) != (zj[i] > pts2[:, 1]))
            with np.errstate(divide='ignore', invalid='ignore'):
                xint = (xj[i] - x[i]) * (pts2[:, 1] - z[i]) / (zj[i] - z[i] + 1e-30) + x[i]
            inside ^= cond & (pts2[:, 0] < xint)
        cnt += inside.astype(int)
    return (cnt % 2) == 1


def build_stages(glb_bytes: bytes, n_stages: int = 5, materials=None):
    """Fabricate the construction stages. `materials` is either a single
    material name (AUTO mode) or a dict {scaffold, frame, planks, formwork}
    (MANUAL mode); unknown/missing roles inherit the scaffold material.
    Returns list of GLB bytes, stage_0 .. stage_{n-1} (last = input copy)."""
    import numpy as np
    import trimesh

    N = max(2, min(int(n_stages or 5), 12))
    if isinstance(materials, str):
        materials = {'scaffold': materials}
    materials = materials or {}
    def _m(role, default):
        v = str(materials.get(role) or default).lower()
        return v if v in _ALLOWED else default
    SC_MAT = _m('scaffold', 'wood')
    FR_MAT = _m('frame', SC_MAT)
    PL_MAT = _m('planks', SC_MAT)
    FW_MAT = _m('formwork', SC_MAT)

    state = {'WOODS': MATS[SC_MAT]['palette']}

    def set_palette(m):
        state['WOODS'] = MATS[m]['palette']

    def wood(p):
        W = state['WOODS']
        return W[int(abs(p[0] * 73.7 + p[1] * 179.3 + p[2] * 283.1)) % len(W)]

    scene = trimesh.load(io.BytesIO(glb_bytes), file_type='glb')
    if isinstance(scene, trimesh.Scene):
        geoms = list(scene.geometry.values())
        mesh = geoms[0] if len(geoms) == 1 else trimesh.util.concatenate(geoms)
    else:
        mesh = scene
    mesh = mesh.copy()
    minB, maxB = mesh.bounds
    minY, maxY = float(minB[1]), float(maxB[1])
    H = maxY - minY
    SX, SZ = (maxB[0] - minB[0]), (maxB[2] - minB[2])
    R = float(max(SX, SZ))
    POLE_R = 0.006 * R

    def beam(p0, p1, r=None, color=None, shape='cyl'):
        p0, p1 = np.asarray(p0, float), np.asarray(p1, float)
        L = np.linalg.norm(p1 - p0)
        if L < 1e-6:
            return None
        rr = (r or POLE_R)
        if shape == 'box':
            c = trimesh.creation.box(extents=[rr * 2.2, rr * 2.2, L])
        else:
            c = trimesh.creation.cylinder(radius=rr, height=L, sections=8)
        c.apply_translation([0, 0, L / 2])
        c.apply_transform(trimesh.geometry.align_vectors([0, 0, 1], (p1 - p0) / L))
        c.apply_translation(p0)
        c.visual = trimesh.visual.ColorVisuals(c, face_colors=(color or wood(p0)))
        c.metadata['grain'] = ((p1 - p0) / L).tolist()
        return c

    # Cap colour matched to the building's own mean texture colour.
    CAPC = [120, 112, 100, 255]
    try:
        _mat = mesh.visual.material
        _img = getattr(_mat, 'baseColorTexture', None) or getattr(_mat, 'image', None)
        if _img is not None:
            _avg = np.asarray(_img.convert('RGB').resize((64, 64))).reshape(-1, 3).mean(0)
            CAPC = [int(_avg[0] * 0.9), int(_avg[1] * 0.9), int(_avg[2] * 0.9), 255]
    except Exception:
        pass

    def contour_at(y):
        try:
            sec = mesh.section(plane_origin=[0, y, 0], plane_normal=[0, 1, 0])
            if sec is None:
                return []
            return [np.asarray(e) for e in sec.discrete if len(e) >= 3]
        except Exception:
            return []

    def frame_at(yline, frameH):
        parts = []
        loops = contour_at(max(minY + 0.02 * H, yline - 0.01 * H))
        step = 0.09 * R
        for loop in loops:
            d = np.r_[0, np.cumsum(np.linalg.norm(np.diff(loop, axis=0), axis=1))]
            if d[-1] < step:
                continue
            studs = []
            for t in np.arange(0, d[-1], step):
                i = min(int(np.searchsorted(d, t)), len(loop) - 1)
                p = loop[i]
                b = beam([p[0], yline, p[2]], [p[0], yline + frameH, p[2]], shape='box')
                if b is not None:
                    parts.append(b); studs.append(p)
            for k in range(0, len(studs) - 1, 2):
                a, c2 = studs[k], studs[k + 1]
                b = beam([a[0], yline, a[2]], [c2[0], yline + frameH, c2[2]],
                         r=POLE_R * 0.7, shape='box')
                if b is not None:
                    parts.append(b)
            # top ring resampled by ARC LENGTH (index stepping made confetti
            # pieces shorter than their own width on small tower loops)
            rstep = max(0.05 * R, step * 0.5)
            ring_pts = []
            for tt in np.arange(0, d[-1], rstep):
                i = min(int(np.searchsorted(d, tt)), len(loop) - 1)
                ring_pts.append(loop[i])
            for k in range(len(ring_pts)):
                pA = ring_pts[k]; pB = ring_pts[(k + 1) % len(ring_pts)]
                seg = np.linalg.norm(np.asarray(pB) - np.asarray(pA))
                if seg < POLE_R * 3 or seg > rstep * 2.5:
                    continue
                b = beam([pA[0], yline + frameH, pA[2]],
                         [pB[0], yline + frameH, pB[2]], r=POLE_R * 0.8, shape='box')
                if b is not None:
                    parts.append(b)
        return parts

    def formwork_at(yline):
        parts = []
        y0, y1 = yline - 0.06 * H, yline + 0.035 * H
        # 0.024R clears protruding stonework (machicolation corbels bled
        # through the band at 0.012R)
        off = 0.024 * R; thick = POLE_R * 1.6
        step = 0.045 * R
        loops = contour_at(max(minY + 0.02 * H, yline - 0.04 * H))
        for loop in loops:
            c = loop.mean(axis=0)
            d = np.r_[0, np.cumsum(np.linalg.norm(np.diff(loop, axis=0), axis=1))]
            if d[-1] < step * 2:
                continue
            pts = []
            for t in np.arange(0, d[-1], step):
                i = min(int(np.searchsorted(d, t)), len(loop) - 1)
                p = loop[i]
                n = p - c; n[1] = 0
                nl = np.linalg.norm(n)
                q = p + (n / nl) * off if nl > 1e-6 else p
                pts.append([q[0], q[2]])
            n2 = len(pts)
            if n2 < 3:
                continue
            cxz = np.array([c[0], c[2]])
            for k in range(n2):
                a = pts[k]; b = pts[(k + 1) % n2]
                seg = np.hypot(b[0] - a[0], b[1] - a[1])
                if seg < 1e-6 or seg > step * 3:
                    continue
                tj = thick * (1.0 + ((abs(a[0] * 41.3 + a[1] * 67.7)) % 1.0) * 0.35)
                panel = trimesh.creation.box(extents=[seg * 1.0, y1 - y0, tj])
                ang = np.arctan2(b[1] - a[1], b[0] - a[0])
                panel.apply_transform(trimesh.transformations.rotation_matrix(-ang, [0, 1, 0]))
                panel.apply_translation([(a[0] + b[0]) / 2, (y0 + y1) / 2, (a[1] + b[1]) / 2])
                panel.visual = trimesh.visual.ColorVisuals(panel, face_colors=wood([a[0], y0, a[1]]))
                panel.metadata['grain'] = [0.0, 1.0, 0.0]
                parts.append(panel)
                for yw in (y0 + POLE_R, y1 - POLE_R):
                    m2 = (np.array([a[0], a[1]]) + np.array([b[0], b[1]])) / 2
                    nrm2 = m2 - cxz; nl2 = np.linalg.norm(nrm2)
                    dx, dz = ((nrm2 / nl2) * (thick * 1.2)) if nl2 > 1e-6 else (0, 0)
                    bb = beam([a[0] + dx, yw, a[1] + dz], [b[0] + dx, yw, b[1] + dz], r=POLE_R * 0.7)
                    if bb is not None:
                        parts.append(bb)
        return parts

    def scaffold_to(topY):
        parts = []
        bay = max(0.12 * R, 1e-3); lift = 0.16 * H
        top = min(topY + 0.10 * H, maxY + 0.05 * H)
        off = 0.045 * R
        loops = contour_at(minY + 0.06 * H)

        def area(l):
            x, z = l[:, 0], l[:, 2]
            return 0.5 * abs(np.dot(x, np.roll(z, 1)) - np.dot(z, np.roll(x, 1)))
        loops = [l for l in loops if area(l) > 0.02 * SX * SZ]
        posts_pts = []
        for loop in loops:
            c = loop.mean(axis=0)
            d = np.r_[0, np.cumsum(np.linalg.norm(np.diff(loop, axis=0), axis=1))]
            if d[-1] < bay:
                continue
            ring = []
            for t in np.arange(0, d[-1] - bay * 0.4, bay):
                i = min(int(np.searchsorted(d, t)), len(loop) - 1)
                p = loop[i]
                n = p - c; n[1] = 0
                nl = np.linalg.norm(n)
                if nl < 1e-6:
                    continue
                q = p + (n / nl) * off
                ring.append([q[0], q[2]])
            if len(ring) >= 3:
                posts_pts.append(ring)
        if not posts_pts:
            m = off
            x0, x1, z0, z1 = minB[0] - m, maxB[0] + m, minB[2] - m, maxB[2] + m
            ring = [[x, z0] for x in np.arange(x0, x1, bay)] + [[x1, z] for z in np.arange(z0, z1, bay)] + \
                   [[x, z1] for x in np.arange(x1, x0, -bay)] + [[x0, z] for z in np.arange(z1, z0, -bay)]
            posts_pts = [ring]
        lifts = np.arange(minY + lift, top, lift)
        W = state['WOODS']
        for ring in posts_pts:
            n = len(ring)
            for k, (x, z) in enumerate(ring):
                b = beam([x, minY, z], [x, top, z])
                if b is not None:
                    parts.append(b)
                pad = trimesh.creation.box(extents=[POLE_R * 5, POLE_R * 1.6, POLE_R * 5])
                pad.apply_translation([x, minY + POLE_R * 0.8, z])
                pad.visual = trimesh.visual.ColorVisuals(pad, face_colors=W[0])
                pad.metadata['grain'] = [1.0, 0.0, 0.0]
                parts.append(pad)
            for y in lifts:
                for k in range(n):
                    a = ring[k]; bq = ring[(k + 1) % n]
                    seg = np.hypot(bq[0] - a[0], bq[1] - a[1])
                    if seg > bay * 2.6:
                        continue
                    bb = beam([a[0], y, a[1]], [bq[0], y, bq[1]], r=POLE_R * 0.8, color=W[1])
                    if bb is not None:
                        parts.append(bb)
                    mx, mz = (a[0] + bq[0]) / 2, (a[1] + bq[1]) / 2
                    pl = trimesh.creation.box(extents=[seg * 0.98, POLE_R * 1.1, POLE_R * 4.5])
                    ang = np.arctan2(bq[1] - a[1], bq[0] - a[0])
                    Rm = trimesh.transformations.rotation_matrix(-ang, [0, 1, 0])
                    pl.apply_transform(Rm); pl.apply_translation([mx, y + POLE_R, mz])
                    pl.visual = trimesh.visual.ColorVisuals(pl, face_colors=wood([mx, y, mz]))
                    pl.metadata['grain'] = [(bq[0] - a[0]) / seg, 0.0, (bq[1] - a[1]) / seg]
                    parts.append(pl)
                    if (k % 2) == 0:
                        yb = min(y + lift, top)
                        d1 = beam([a[0], y, a[1]], [bq[0], yb, bq[1]], r=POLE_R * 0.6)
                        if d1 is not None:
                            parts.append(d1)
        return parts

    stages = []
    for i in range(N):
        p = 1.0 if N <= 1 else i / (N - 1)
        if i == N - 1:
            stages.append(glb_bytes)
            continue
        keep = max(p, 0.06)
        yline = minY + keep * H
        solid = mesh.copy()
        vy = solid.vertices[:, 1]
        below = (vy[solid.faces].max(axis=1) <= yline)
        solid.update_faces(below)
        solid.remove_unreferenced_vertices()
        parts = [solid] if len(solid.faces) else []
        # cap the cut
        try:
            sec = mesh.section(plane_origin=[0, yline, 0], plane_normal=[0, 1, 0])
            if sec is not None:
                planar, T = sec.to_2D()
                v2, f2 = planar.triangulate()
                if len(f2):
                    cap = trimesh.Trimesh(np.column_stack([v2, np.zeros(len(v2))]), f2)
                    cap.apply_transform(T)
                    cap.visual = trimesh.visual.ColorVisuals(cap, face_colors=CAPC)
                    parts.append(cap)
        except Exception:
            pass
        # plank work floor over the cut, clipped to the building outline
        set_palette(PL_MAT)
        try:
            loops2 = contour_at(yline)
            polys = [np.column_stack([l[:, 0], l[:, 2]]) for l in loops2 if len(l) >= 3]
            if polys:
                plankW = max(0.018 * R, 1e-4)
                xs_all = np.arange(minB[0], maxB[0], plankW * 0.5)
                for zc in np.arange(minB[2], maxB[2], plankW):
                    pts2 = np.column_stack([xs_all, np.full(len(xs_all), zc)])
                    inside = _points_in_polys(pts2, polys)
                    k2 = 0
                    while k2 < len(inside):
                        if inside[k2]:
                            j2 = k2
                            while j2 + 1 < len(inside) and inside[j2 + 1]:
                                j2 += 1
                            xa, xb = xs_all[k2], xs_all[j2]
                            if xb - xa > plankW:
                                bd = trimesh.creation.box(extents=[xb - xa, POLE_R * 1.2, plankW * 0.92])
                                bd.apply_translation([(xa + xb) / 2, yline + POLE_R * 1.3, zc + plankW / 2])
                                bd.visual = trimesh.visual.ColorVisuals(bd, face_colors=wood([xa, yline, zc]))
                                bd.metadata['grain'] = [1.0, 0.0, 0.0]
                                parts.append(bd)
                            k2 = j2 + 1
                        else:
                            k2 += 1
        except Exception:
            pass
        set_palette(FW_MAT); parts += formwork_at(yline)
        set_palette(FR_MAT); parts += frame_at(yline, frameH=0.10 * H)
        set_palette(SC_MAT); parts += scaffold_to(yline)
        out_scene = trimesh.Scene()
        for k, g in enumerate(parts):
            out_scene.add_geometry(g, node_name=f"g{k}")
        buf = io.BytesIO()
        out_scene.export(buf, file_type='glb')
        stages.append(buf.getvalue())
    return stages
