"""Post-rotate a GLB file's vertex positions in-place WITHOUT
touching textures, materials, UVs, normals.

Used by ip45_2view_to_3d.py to fix the side-swap of NORMALIZE=1
output without losing the SDXL-refined embedded baseColorTexture
(trimesh round-trip drops ~50% of the file).

Usage:
    python glb_post_rotate.py <glb_path> <axis> <degrees>

axis = x | y | z
degrees = e.g. 180

Modifies file in place.
"""
import sys
import struct
import numpy as np
import pygltflib


def rotate_glb(glb_path: str, axis: str, degrees: float) -> None:
    print(f'[glb_rot] loading {glb_path}', flush=True)
    glb = pygltflib.GLTF2().load(glb_path)

    rad = np.radians(degrees)
    c, s = np.cos(rad), np.sin(rad)
    if axis == 'x':
        R = np.array([[1, 0, 0], [0, c, -s], [0, s, c]], dtype=np.float32)
    elif axis == 'y':
        R = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], dtype=np.float32)
    elif axis == 'z':
        R = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]], dtype=np.float32)
    else:
        raise ValueError(f'axis must be x|y|z, got {axis}')

    print(f'[glb_rot] R{axis}({degrees}°)', flush=True)

    # Get the binary blob (single buffer in GLB)
    bin_blob = glb.binary_blob()
    bin_blob = bytearray(bin_blob)

    # For each mesh primitive, rotate POSITION and NORMAL accessors.
    # Skip TEXCOORD, TANGENT, COLOR (don't depend on world position).
    rotated_accessors = set()
    for mesh in glb.meshes:
        for prim in mesh.primitives:
            attrs = prim.attributes
            for attr_name in ('POSITION', 'NORMAL'):
                acc_idx = getattr(attrs, attr_name, None)
                if acc_idx is None or acc_idx in rotated_accessors:
                    continue
                rotated_accessors.add(acc_idx)
                acc = glb.accessors[acc_idx]
                bv = glb.bufferViews[acc.bufferView]
                offset = (bv.byteOffset or 0) + (acc.byteOffset or 0)
                count = acc.count
                # VEC3 of float32 = 12 bytes per vertex
                stride = bv.byteStride or 12
                end = offset + count * stride

                # Read positions/normals as float32 array
                arr = np.frombuffer(
                    bytes(bin_blob[offset:end]),
                    dtype=np.float32,
                ).reshape(count, 3).copy()
                # Apply rotation
                arr_rotated = (R @ arr.T).T.astype(np.float32)
                # Write back
                bin_blob[offset:end] = arr_rotated.tobytes()
                print(f'[glb_rot]  rotated {attr_name} accessor #{acc_idx} '
                      f'({count} verts at offset {offset})', flush=True)

    # Re-set the buffer blob
    glb.set_binary_blob(bytes(bin_blob))
    glb.save(glb_path)
    print(f'[glb_rot] saved {glb_path}', flush=True)


if __name__ == '__main__':
    if len(sys.argv) < 4:
        print('usage: glb_post_rotate.py <glb_path> <axis x|y|z> <degrees>')
        sys.exit(1)
    rotate_glb(sys.argv[1], sys.argv[2].lower(), float(sys.argv[3]))
