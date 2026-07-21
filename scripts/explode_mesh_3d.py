"""Fracture a finished GLB into Voronoi shards, exported as ONE GLB whose shards
are named submeshes `part_00`, `part_01`, … at their ORIGINAL positions.

This lets the 3D viewer's live "explode" slider (the same control used for
segmented meshes) blast the shards outward continuously — no baked stages, no
file swapping. Texture is preserved: each shard keeps the ORIGINAL vertices/UVs
and references the same baked texture (no re-bake); face-colour fallback if the
mesh has no texture.

Args: <mesh.glb> <out.glb> [fragments] [fill 0/1]. Pure geometry (no GPU).
Deterministic. `fill=1` solidifies each shard (adds inner thickness so exploded
shards read as solid debris instead of hollow shells).
"""
import sys, os
import numpy as np
import trimesh

SRC, OUT = sys.argv[1], sys.argv[2]
FRAGS = int(sys.argv[3]) if len(sys.argv) > 3 else 24
FRAGS = max(4, min(FRAGS, 200))
FILL = (len(sys.argv) > 4 and str(sys.argv[4]) in ('1', 'true', 'True'))
RNG = np.random.RandomState(1234)

scene = trimesh.load(SRC)
if isinstance(scene, trimesh.Scene):
    geoms = list(scene.geometry.values())
    mesh = geoms[0] if len(geoms) == 1 else trimesh.util.concatenate(geoms)
else:
    mesh = scene
mesh = mesh.copy()

V = np.asarray(mesh.vertices)
F = np.asarray(mesh.faces)

# Texture (preferred) or per-face colours (fallback) — carried onto every shard.
TEX = None; UV = None; FACE_COLORS = None
try:
    vis = mesh.visual
    if isinstance(vis, trimesh.visual.TextureVisuals) and vis.uv is not None:
        UV = np.asarray(vis.uv)
        m = getattr(vis, 'material', None)
        TEX = getattr(m, 'baseColorTexture', None) or getattr(m, 'image', None)
    if TEX is None:
        fc = getattr(vis, 'face_colors', None)
        if fc is not None and len(fc) == len(F):
            FACE_COLORS = np.asarray(fc)
except Exception:
    pass
if TEX is None and FACE_COLORS is None:
    FACE_COLORS = np.tile([170, 170, 175, 255], (len(F), 1)).astype(np.uint8)

MAT = trimesh.visual.material.PBRMaterial(baseColorTexture=TEX) if TEX is not None else None

# ---- fill-interior prep: a dark "stone interior" colour + a texel that samples it
R = float(np.max(mesh.bounds[1] - mesh.bounds[0])) or 1.0
DARK_UV = np.array([0.0, 0.0])
DARK_COL = np.array([60, 58, 55, 255], np.uint8)
if FILL:
    # dark tone = the mesh's own mean colour, darkened (reads as shaded stone core)
    try:
        if TEX is not None:
            from PIL import Image as _PImg
            t = TEX.convert('RGB').copy(); Wt, Ht = t.size
            avg = np.asarray(t.resize((32, 32))).reshape(-1, 3).mean(0)
            DARK_COL = np.array([int(avg[0] * 0.30), int(avg[1] * 0.30), int(avg[2] * 0.30), 255], np.uint8)
            # paint top-left AND bottom-left corners dark so uv (0,0) samples dark
            # under either V-flip convention; real UVs (xatlas-padded) don't hit 0.
            px = t.load(); dk = (int(DARK_COL[0]), int(DARK_COL[1]), int(DARK_COL[2]))
            for yy in (0, 1, 2, Ht - 1, Ht - 2, Ht - 3):
                for xx in (0, 1, 2):
                    px[xx, yy] = dk
            TEX = t
            MAT = trimesh.visual.material.PBRMaterial(baseColorTexture=TEX)
        elif FACE_COLORS is not None:
            avg = FACE_COLORS[:, :3].mean(0)
            DARK_COL = np.array([int(avg[0] * 0.30), int(avg[1] * 0.30), int(avg[2] * 0.30), 255], np.uint8)
    except Exception as e:
        print(f"[explode] fill prep skipped ({e})", flush=True)


def solidify(sv, sf, suv, scol):
    """Give an open shard shell thickness: offset an inner copy inward along the
    normals, flip it, and bridge the open boundary with walls → a closed solid
    slab. Outer face keeps the texture/colour; inner + walls are the dark core."""
    try:
        mm = trimesh.Trimesh(sv, sf, process=False)
        vn = mm.vertex_normals
    except Exception:
        return None
    Nv = len(sv)
    diag = float(np.linalg.norm(sv.max(0) - sv.min(0))) or 1.0
    th = min(0.06 * diag, 0.02 * R)                 # thickness (never too fat)
    inner = sv - vn * th
    verts = np.vstack([sv, inner])
    inner_f = sf[:, ::-1] + Nv                       # inner shell, flipped
    walls = []
    try:
        uniq = trimesh.grouping.group_rows(mm.edges_sorted, require_count=1)
        for a, b in mm.edges[uniq]:                  # open boundary edges
            walls.append([a, b, b + Nv]); walls.append([a, b + Nv, a + Nv])
    except Exception:
        pass
    walls = np.asarray(walls, np.int64) if walls else np.zeros((0, 3), np.int64)
    faces = np.vstack([sf, inner_f, walls])
    solid = trimesh.Trimesh(verts, faces, process=False)
    if suv is not None and MAT is not None:
        uv2 = np.vstack([suv, np.tile(DARK_UV, (Nv, 1))])   # inner verts → dark texel
        solid.visual = trimesh.visual.TextureVisuals(uv=uv2, material=MAT)
    else:
        fcol = np.vstack([scol, np.tile(DARK_COL, (len(inner_f) + len(walls), 1))])
        solid.visual = trimesh.visual.ColorVisuals(solid, face_colors=fcol.astype(np.uint8))
    return solid


# Fracture: assign each face to its nearest random seed (surface Voronoi).
fc_centroids = V[F].mean(axis=1)
k = min(FRAGS, len(F))
seed_idx = RNG.choice(len(F), k, replace=False)
seeds = fc_centroids[seed_idx]
try:
    from scipy.spatial import cKDTree
    labels = cKDTree(seeds).query(fc_centroids)[1]
except Exception:
    d = np.linalg.norm(fc_centroids[:, None, :] - seeds[None, :, :], axis=2)
    labels = d.argmin(axis=1)

out = trimesh.Scene()
n = 0
for lab in np.unique(labels):
    face_ids = np.where(labels == lab)[0]
    if len(face_ids) == 0:
        continue
    face_ids = np.asarray(face_ids)
    faces_k = F[face_ids]
    uniq, inv = np.unique(faces_k, return_inverse=True)
    sv = V[uniq]; sf = inv.reshape(-1, 3)
    suv = UV[uniq] if (UV is not None) else None
    scol = FACE_COLORS[face_ids] if (FACE_COLORS is not None) else None
    shard = None
    if FILL:
        shard = solidify(sv, sf, suv, scol)
    if shard is None:                                # thin-shell fallback / FILL off
        shard = trimesh.Trimesh(sv, sf, process=False)
        if MAT is not None and suv is not None:
            shard.visual = trimesh.visual.TextureVisuals(uv=suv, material=MAT)
        elif scol is not None:
            shard.visual = trimesh.visual.ColorVisuals(shard, face_colors=scol)
    name = f"part_{n:02d}"
    out.add_geometry(shard, node_name=name, geom_name=name)
    n += 1

out.export(OUT)
print(f"DONE {n} shards -> {OUT}", flush=True)
