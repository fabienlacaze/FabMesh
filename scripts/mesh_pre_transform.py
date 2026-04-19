"""Apply a translate + scale transform to a GLB mesh in-place.

Usage:
    python mesh_pre_transform.py <in.glb> <out.glb> <tx> <ty> <scale>

Used by the FabMesh Align Texture tool to pre-transform the mesh before
texture_project re-projects the source photos onto it.
"""
import sys
import trimesh
import numpy as np


def main():
    if len(sys.argv) < 6:
        print('Usage: mesh_pre_transform.py <in.glb> <out.glb> <tx> <ty> <scale> [tz]')
        sys.exit(1)
    in_glb = sys.argv[1]
    out_glb = sys.argv[2]
    tx = float(sys.argv[3])
    ty = float(sys.argv[4])
    scale = float(sys.argv[5])
    tz = float(sys.argv[6]) if len(sys.argv) > 6 else 0.0

    print(f'[pre_transform] in={in_glb} out={out_glb} tx={tx} ty={ty} tz={tz} scale={scale}',
          flush=True)

    m = trimesh.load(in_glb, force='mesh')
    if scale != 1.0:
        m.apply_scale(scale)
    if tx != 0.0 or ty != 0.0 or tz != 0.0:
        m.apply_translation([tx, ty, tz])
    m.export(out_glb)
    print(f'[pre_transform] saved {out_glb}', flush=True)


if __name__ == '__main__':
    main()
