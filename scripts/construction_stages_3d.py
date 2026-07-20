"""Fabricate REAL 3D construction-stage meshes from one finished GLB (Manor Lords
style, auto-manufactured). For each stage p: solid = bottom p% of the mesh (face
filter → texture preserved) + cap; timber FRAME above the build line (beams along
the building's own cross-section contour); modular SCAFFOLD cage around the
footprint. Args: <mesh.glb> <out_dir> <N>. Writes stage_0..N-1.glb (last = exact copy).
Pure geometry (no GPU)."""
import sys, os, shutil
import numpy as np
import trimesh

SRC, OUT = sys.argv[1], sys.argv[2]
N = int(sys.argv[3]) if len(sys.argv) > 3 else 5
os.makedirs(OUT, exist_ok=True)

WOOD = [140, 98, 55, 255]      # beams (default)
WOOD2 = [168, 124, 76, 255]    # scaffold poles/planks (default)
# Varied wood shades → beams don't look uniform; picked deterministically by
# position so the SAME beam keeps the SAME shade across stages.
WOODS = [[140, 98, 55, 255], [168, 124, 76, 255], [122, 86, 48, 255],
         [152, 110, 66, 255], [176, 136, 88, 255]]
def wood(p):
    return WOODS[int(abs(p[0] * 73.7 + p[1] * 179.3 + p[2] * 283.1)) % len(WOODS)]

scene = trimesh.load(SRC)
if isinstance(scene, trimesh.Scene):
    geoms = list(scene.geometry.values())
    mesh = geoms[0] if len(geoms) == 1 else trimesh.util.concatenate(geoms)
else:
    mesh = scene
mesh = mesh.copy()
minB, maxB = mesh.bounds
minY, maxY = float(minB[1]), float(maxB[1])
H = maxY - minY
cx, cz = (minB[0] + maxB[0]) / 2, (minB[2] + maxB[2]) / 2
SX, SZ = (maxB[0] - minB[0]), (maxB[2] - minB[2])
R = float(max(SX, SZ))
POLE_R = 0.006 * R             # beam/pole radius

def beam(p0, p1, r=None, color=None, shape='cyl'):
    """Wooden beam between two 3D points. shape='cyl' (round pole, scaffolding) or
    'box' (square timber, building frame) — shape variety reads more real."""
    p0, p1 = np.asarray(p0, float), np.asarray(p1, float)
    L = np.linalg.norm(p1 - p0)
    if L < 1e-6: return None
    rr = (r or POLE_R)
    if shape == 'box':
        c = trimesh.creation.box(extents=[rr * 2.2, rr * 2.2, L])
        c.apply_translation([0, 0, L / 2])
    else:
        c = trimesh.creation.cylinder(radius=rr, height=L, sections=8)
        c.apply_translation([0, 0, L / 2])
    c.apply_transform(trimesh.geometry.align_vectors([0, 0, 1], (p1 - p0) / L))
    c.apply_translation(p0)
    c.visual = trimesh.visual.ColorVisuals(c, face_colors=(color or wood(p0)))
    return c

# Cap colour matched to the BUILDING's own material (mean texture colour) so the
# cut cross-section reads as the same stone/wood as the building.
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
    """Building cross-section outline points at height y (world XZ), ordered."""
    try:
        sec = mesh.section(plane_origin=[0, y, 0], plane_normal=[0, 1, 0])
        if sec is None: return []
        loops = []
        for ent in sec.discrete:                     # list of (n,3) polylines
            if len(ent) >= 3: loops.append(np.asarray(ent))
        return loops
    except Exception:
        return []

def frame_at(yline, frameH):
    """Timber frame of the NEXT storey: vertical studs along the section contour
    at yline, plus a top ring beam following the contour → looks like the building's
    own frame rising before the walls (fabricated Manor Lords frame stage)."""
    parts = []
    loops = contour_at(max(minY + 0.02 * H, yline - 0.01 * H))
    step = 0.09 * R                                  # stud spacing
    for loop in loops:
        # resample the loop at ~step spacing
        d = np.r_[0, np.cumsum(np.linalg.norm(np.diff(loop, axis=0), axis=1))]
        if d[-1] < step: continue
        studs = []
        for t in np.arange(0, d[-1], step):
            i = np.searchsorted(d, t); i = min(i, len(loop) - 1)
            p = loop[i]
            b = beam([p[0], yline, p[2]], [p[0], yline + frameH, p[2]], shape='box')
            if b is not None: parts.append(b); studs.append(p)
        # diagonal braces between alternate studs (timber-frame look)
        for k in range(0, len(studs) - 1, 2):
            a, c2 = studs[k], studs[k + 1]
            b = beam([a[0], yline, a[2]], [c2[0], yline + frameH, c2[2]],
                     r=POLE_R * 0.7, shape='box')
            if b is not None: parts.append(b)
        # top ring following the contour (coarse)
        for i in range(0, len(loop) - 1, max(1, len(loop) // 60)):
            j = min(i + max(1, len(loop) // 60), len(loop) - 1)
            b = beam([loop[i][0], yline + frameH, loop[i][2]],
                     [loop[j][0], yline + frameH, loop[j][2]], r=POLE_R * 0.8, shape='box')
            if b is not None: parts.append(b)
    return parts

def scaffold_to(topY):
    """Modular scaffold cage around the footprint bbox up to topY: standards every
    bay on the 4 sides, ledgers per lift, planks (thin boxes) per lift."""
    parts = []
    m = 0.05 * R                                     # offset out from the facade
    x0, x1 = minB[0] - m, maxB[0] + m
    z0, z1 = minB[2] - m, maxB[2] + m
    bay = max(0.14 * R, 1e-3); lift = 0.16 * H
    top = min(topY + 0.10 * H, maxY + 0.05 * H)
    xs = list(np.arange(x0, x1 + bay * 0.5, bay))
    zs = list(np.arange(z0, z1 + bay * 0.5, bay))
    posts = [(x, z0) for x in xs] + [(x, z1) for x in xs] + \
            [(x0, z) for z in zs[1:-1]] + [(x1, z) for z in zs[1:-1]]
    for (x, z) in posts:
        b = beam([x, minY, z], [x, top, z])           # varied wood shade per pole
        if b is not None: parts.append(b)
    # X cross-braces on the two long sides, alternate bays (breaks uniformity)
    for zz in (z0, z1):
        for k in range(0, len(xs) - 1, 2):
            for (ya, yb) in [(minY, min(minY + lift, top))]:
                b1 = beam([xs[k], ya, zz], [xs[k + 1], yb, zz], r=POLE_R * 0.7)
                b2 = beam([xs[k + 1], ya, zz], [xs[k], yb, zz], r=POLE_R * 0.7)
                for bb in (b1, b2):
                    if bb is not None: parts.append(bb)
    lifts = np.arange(minY + lift, top, lift)
    for y in lifts:
        for (a, bpt) in [((x0, z0), (x1, z0)), ((x0, z1), (x1, z1)),
                         ((x0, z0), (x0, z1)), ((x1, z0), (x1, z1))]:
            bb = beam([a[0], y, a[1]], [bpt[0], y, bpt[1]], r=POLE_R * 0.8, color=WOOD2)
            if bb is not None: parts.append(bb)
        # walk planks on the two long sides
        for zz in (z0, z1):
            pl = trimesh.creation.box(extents=[x1 - x0, POLE_R * 1.2, 0.03 * R])
            pl.apply_translation([(x0 + x1) / 2, y + POLE_R, zz])
            pl.visual = trimesh.visual.ColorVisuals(pl, face_colors=WOOD2)
            parts.append(pl)
    return parts

for i in range(N):
    p = 1.0 if N <= 1 else i / (N - 1)
    out = os.path.join(OUT, f"stage_{i}.glb")
    if i == N - 1:
        shutil.copyfile(SRC, out); print(f"[3d] stage {i} (final copy)", flush=True); continue
    keep = max(p, 0.06)
    yline = minY + keep * H
    # SOLID: faces entirely below the build line (texture preserved: no new verts)
    solid = mesh.copy()
    vy = solid.vertices[:, 1]
    below = (vy[solid.faces].max(axis=1) <= yline)
    solid.update_faces(below)
    solid.remove_unreferenced_vertices()
    parts = [solid] if len(solid.faces) else []
    # CAP the cut so the hollow shell doesn't show an empty box
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
    parts += frame_at(yline, frameH=0.10 * H)        # the rising timber frame
    parts += scaffold_to(yline)                       # scaffold up to the build level
    out_scene = trimesh.Scene()
    for k, g in enumerate(parts): out_scene.add_geometry(g, node_name=f"g{k}")
    out_scene.export(out)
    print(f"[3d] stage {i} (keep={keep:.2f}, solid_faces={len(solid.faces)})", flush=True)
print("DONE", OUT, flush=True)
