"""Fabricate REAL 3D "explosion / destruction" stage meshes from one finished GLB.

The mesh is FRACTURED into Voronoi shards (each face assigned to its nearest
random seed → contiguous surface shards) then the shards are PROJECTED outward
from the blast centre over N stages, with per-shard tumbling rotation, so the
object appears to detonate. Texture is preserved perfectly: shards keep the
ORIGINAL vertices/UVs and reference the same baked texture — no re-baking.

Args: <mesh.glb> <out_dir> <N> [strength 0-100] [fragments]
  N          number of stages (stage_0 = pristine intact, stage_{N-1} = fully
             exploded); each stage_i.glb is navigable + exportable.
  strength   explosion intensity 0-100 (how far shards travel). Default 70.
  fragments  number of shards. Default 24.

Writes stage_0..N-1.glb. Pure geometry (no GPU). Deterministic (fixed seed).
"""
import sys, os, shutil
import numpy as np
import trimesh

SRC, OUT = sys.argv[1], sys.argv[2]
N = int(sys.argv[3]) if len(sys.argv) > 3 else 5
STRENGTH = (float(sys.argv[4]) / 100.0) if len(sys.argv) > 4 else 0.7
FRAGS = int(sys.argv[5]) if len(sys.argv) > 5 else 24
N = max(2, min(N, 20))
STRENGTH = max(0.0, min(STRENGTH, 1.5))
FRAGS = max(4, min(FRAGS, 200))
os.makedirs(OUT, exist_ok=True)
RNG = np.random.RandomState(1234)          # deterministic shards/spins

# ---- load, flatten to a single mesh, keep the texture ---------------------
scene = trimesh.load(SRC)
if isinstance(scene, trimesh.Scene):
    geoms = list(scene.geometry.values())
    mesh = geoms[0] if len(geoms) == 1 else trimesh.util.concatenate(geoms)
else:
    mesh = scene
mesh = mesh.copy()

V = np.asarray(mesh.vertices)
F = np.asarray(mesh.faces)
minB, maxB = mesh.bounds
CENTER = (minB + maxB) / 2.0
R = float(np.max(maxB - minB)) or 1.0

# Texture (preferred) or per-face colours (fallback) — carried onto every shard.
TEX = None
UV = None
FACE_COLORS = None
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

# ---- fracture: assign each face to its nearest random seed (surface Voronoi)
fc_centroids = V[F].mean(axis=1)                      # (nF, 3)
k = min(FRAGS, len(F))
seed_idx = RNG.choice(len(F), k, replace=False)
seeds = fc_centroids[seed_idx]
try:
    from scipy.spatial import cKDTree
    labels = cKDTree(seeds).query(fc_centroids)[1]
except Exception:
    # numpy fallback (slower but dependency-free)
    d = np.linalg.norm(fc_centroids[:, None, :] - seeds[None, :, :], axis=2)
    labels = d.argmin(axis=1)

# Build each shard once: local verts/faces/uv(or colors) + its centroid, and a
# deterministic explosion direction + spin.
SHARDS = []
for lab in np.unique(labels):
    face_ids = np.where(labels == lab)[0]
    if len(face_ids) == 0:
        continue
    faces_k = F[face_ids]
    uniq, inv = np.unique(faces_k, return_inverse=True)
    new_faces = inv.reshape(-1, 3)
    new_verts = V[uniq]
    c = new_verts.mean(axis=0)
    # radial blast direction from the centre, + jitter + slight upward loft
    d = c - CENTER
    d = d + RNG.uniform(-0.25, 0.25, 3) * R * 0.15
    d[1] += 0.18 * R                                  # loft
    nl = np.linalg.norm(d)
    d = d / nl if nl > 1e-6 else RNG.randn(3)
    d = d / (np.linalg.norm(d) or 1.0)
    axis = RNG.randn(3); axis /= (np.linalg.norm(axis) or 1.0)
    spin = RNG.uniform(0.5, 2.2)                       # radians at full explosion
    uv_k = UV[uniq] if UV is not None else None
    col_k = FACE_COLORS[face_ids] if FACE_COLORS is not None else None
    SHARDS.append(dict(v=new_verts, f=new_faces, c=c, dir=d, axis=axis,
                       spin=spin, uv=uv_k, col=col_k))

OFF_MAX = STRENGTH * 1.0 * R                           # max travel at last stage


def _rot(vs, c, axis, ang):
    """Rotate vertices `vs` about point `c` by `ang` around unit `axis` (Rodrigues)."""
    if abs(ang) < 1e-6:
        return vs
    p = vs - c
    k = axis
    cosA, sinA = np.cos(ang), np.sin(ang)
    return (p * cosA
            + np.cross(k, p) * sinA
            + np.outer(p @ k, k) * (1 - cosA)) + c


def build_stage(tn):
    """Assemble one exploded stage (tn in [0,1]) as a single textured mesh."""
    vs, fs, uvs, cols, off = [], [], [], [], 0
    for s in SHARDS:
        v2 = _rot(s['v'], s['c'], s['axis'], s['spin'] * tn)
        v2 = v2 + s['dir'] * OFF_MAX * tn
        vs.append(v2); fs.append(s['f'] + off); off += len(v2)
        if s['uv'] is not None:
            uvs.append(s['uv'])
        if s['col'] is not None:
            cols.append(s['col'])
    big = trimesh.Trimesh(np.vstack(vs), np.vstack(fs), process=False)
    if TEX is not None and uvs:
        mat = trimesh.visual.material.PBRMaterial(baseColorTexture=TEX)
        big.visual = trimesh.visual.TextureVisuals(uv=np.vstack(uvs), material=mat)
    elif cols:
        big.visual = trimesh.visual.ColorVisuals(big, face_colors=np.vstack(cols))
    return big


for i in range(N):
    out = os.path.join(OUT, f"stage_{i}.glb")
    if i == 0:
        shutil.copyfile(SRC, out)                      # pristine intact
        print(f"[explode] stage 0 (intact)", flush=True)
        continue
    tn = i / (N - 1)
    stage = build_stage(tn)
    sc = trimesh.Scene()
    sc.add_geometry(stage, node_name="shards")
    sc.export(out)
    print(f"[explode] stage {i} (t={tn:.2f}, shards={len(SHARDS)})", flush=True)
print("DONE", OUT, flush=True)
