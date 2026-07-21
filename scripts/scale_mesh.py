"""Apply a per-axis scale to a mesh, baking it into a new GLB. Texture/UVs are
preserved (only the geometry is scaled). Args: <src.glb> <out.glb> <sx> <sy> <sz>.
Pure trimesh, no GPU."""
import sys
import numpy as np
import trimesh

SRC, OUT = sys.argv[1], sys.argv[2]
sx = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0
sy = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
sz = float(sys.argv[5]) if len(sys.argv) > 5 else 1.0
# guard against degenerate scales
sx = max(1e-3, min(sx, 1000.0))
sy = max(1e-3, min(sy, 1000.0))
sz = max(1e-3, min(sz, 1000.0))

obj = trimesh.load(SRC)
M = np.diag([sx, sy, sz, 1.0])
obj.apply_transform(M)                     # scene or mesh: scales geometry, keeps UVs
obj.export(OUT)
print(f"DONE scale=({sx:.4f},{sy:.4f},{sz:.4f}) -> {OUT}", flush=True)
