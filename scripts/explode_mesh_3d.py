"""Fracture a finished GLB into Voronoi shards, exported as ONE GLB whose shards
are named submeshes `part_00`, `part_01`, … at their ORIGINAL positions.

The 3D viewer's live "explode" slider (the same control used for segmented
meshes) blasts the shards outward continuously — no baked stages, no file
swapping. Texture is preserved: each shard keeps the ORIGINAL vertices/UVs and
references the same baked texture (no re-bake); face-colour fallback otherwise.

Shards are thin shells (same triangle budget as the source — no solidify, so the
result stays light and loads fast). The viewer renders the explosion parts
DOUBLE-SIDED so the hollow interior shows the (lit) texture instead of a black
void — a "filled" look with zero extra geometry.

Args: <mesh.glb> <out.glb> [fragments]. Pure geometry (no GPU). Deterministic.
"""
import sys
import numpy as np
import trimesh

SRC, OUT = sys.argv[1], sys.argv[2]
FRAGS = int(sys.argv[3]) if len(sys.argv) > 3 else 24
FRAGS = max(4, min(FRAGS, 200))
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
    faces_k = F[face_ids]
    uniq, inv = np.unique(faces_k, return_inverse=True)
    shard = trimesh.Trimesh(V[uniq], inv.reshape(-1, 3), process=False)
    if MAT is not None and UV is not None:
        shard.visual = trimesh.visual.TextureVisuals(uv=UV[uniq], material=MAT)
    elif FACE_COLORS is not None:
        shard.visual = trimesh.visual.ColorVisuals(shard, face_colors=FACE_COLORS[face_ids])
    name = f"part_{n:02d}"
    out.add_geometry(shard, node_name=name, geom_name=name)
    n += 1

out.export(OUT)
print(f"DONE {n} shards -> {OUT}", flush=True)
