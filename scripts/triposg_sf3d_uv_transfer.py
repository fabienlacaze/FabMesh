"""TripoSG mesh + SF3D UVs+atlas (best of both worlds).

Pipeline:
  1. SF3D bridge   -> mesh_sf3d.glb (12k faces, native UVs, native atlas)
  2. TripoSG bridge-> mesh_triposg.glb (1.4M faces, geometry only)
  3. Optional decimate TripoSG to a manageable size
  4. UV transfer: for each TripoSG vertex, find nearest SF3D vertex,
     inherit its UV. The atlas image is reused as-is from SF3D.
  5. Export: TripoSG geometry + SF3D-derived UVs + SF3D atlas

Result: TripoSG's geometric detail (microreliefs, clothing folds, hair
strands) but textured cleanly via SF3D's native baked atlas instead of
xatlas's 2500-chart fragmentation.

Usage:
    python triposg_sf3d_uv_transfer.py <front_image> <out.glb>
        [target_faces=50000] [tex_res=1024]
"""
import sys
import os
import time
import subprocess
import numpy as np
import trimesh
from PIL import Image
from scipy.spatial import cKDTree


SCRIPTS = os.path.dirname(os.path.abspath(__file__))


def log(msg):
    print(f'[triposg_sf3d_uv] {msg}', flush=True)


def step_sf3d(image_path, out_glb, tex_res):
    log(f'STEP 1: SF3D bridge -> {out_glb}')
    bridge = os.path.join(SCRIPTS, 'local_sf3d_bridge.py')
    t0 = time.time()
    proc = subprocess.run(
        [sys.executable, bridge, image_path, out_glb, str(tex_res), '-1', 'none', '0'],
        capture_output=True, text=True, timeout=600,
    )
    if proc.returncode != 0:
        log(f'SF3D failed: {proc.stderr[-500:]}')
        sys.exit(2)
    log(f'STEP 1 done in {time.time()-t0:.1f}s')


def step_triposg(image_path, out_glb):
    log(f'STEP 2: TripoSG bridge -> {out_glb}')
    bridge = os.path.join(SCRIPTS, 'local_triposg_bridge.py')
    t0 = time.time()
    proc = subprocess.run(
        [sys.executable, bridge, image_path, out_glb, '30', '7.0'],
        capture_output=True, text=True, timeout=300,
    )
    if proc.returncode != 0:
        log(f'TripoSG failed: {proc.stderr[-500:]}')
        sys.exit(3)
    log(f'STEP 2 done in {time.time()-t0:.1f}s')


def step_decimate(in_glb, out_glb, target_faces):
    log(f'STEP 3: decimate TripoSG to {target_faces} faces')
    t0 = time.time()
    m = trimesh.load(in_glb, force='mesh')
    log(f'  loaded {len(m.vertices)}v / {len(m.faces)}f')
    if len(m.faces) > target_faces:
        try:
            import fast_simplification
            verts_out, tris_out = fast_simplification.simplify(
                m.vertices, m.faces, target_count=target_faces,
            )
            m = trimesh.Trimesh(vertices=verts_out, faces=tris_out,
                                  process=False)
            log(f'  decimated to {len(m.faces)}f')
        except Exception as e:
            log(f'  fast_simplification failed ({e}), keeping original')
    m.export(out_glb)
    log(f'STEP 3 done in {time.time()-t0:.1f}s')


def step_align_meshes(triposg_mesh, sf3d_mesh):
    """Align TripoSG mesh to SF3D mesh's coordinate frame.
    Both should be normalized to roughly the same scale and centered.
    Returns the transformed TripoSG mesh.
    """
    log('STEP 4: align TripoSG to SF3D coordinate frame')
    # Center both
    sf_center = sf3d_mesh.vertices.mean(axis=0)
    tp_center = triposg_mesh.vertices.mean(axis=0)
    triposg_mesh.vertices -= tp_center
    # Match scale to SF3D
    sf_scale = (sf3d_mesh.vertices - sf_center).max() - (sf3d_mesh.vertices - sf_center).min()
    tp_scale = triposg_mesh.vertices.max() - triposg_mesh.vertices.min()
    if tp_scale > 0:
        scale = sf_scale / tp_scale
        triposg_mesh.vertices *= scale
        log(f'  scale TripoSG by {scale:.3f}')
    # Re-translate to SF3D center
    triposg_mesh.vertices += sf_center
    log(f'  TripoSG bbox post-align: {triposg_mesh.bounds.tolist()}')
    log(f'  SF3D    bbox:            {sf3d_mesh.bounds.tolist()}')
    return triposg_mesh


def step_transfer_uv(triposg_path, sf3d_path, out_path):
    log(f'STEP 5: transfer SF3D UVs+atlas to TripoSG mesh')
    t0 = time.time()

    # Load both
    tp_scene = trimesh.load(triposg_path, force='mesh')
    sf_scene = trimesh.load(sf3d_path, force='mesh')

    # Align coordinate frames
    tp_scene = step_align_meshes(tp_scene, sf_scene)

    # SF3D UVs and atlas
    if not (hasattr(sf_scene.visual, 'uv') and sf_scene.visual.uv is not None):
        log('  ERROR: SF3D mesh has no UVs!')
        sys.exit(4)
    sf_uvs = np.asarray(sf_scene.visual.uv)
    sf_verts = np.asarray(sf_scene.vertices)
    sf_atlas = sf_scene.visual.material.baseColorTexture
    if sf_atlas is None:
        log('  ERROR: SF3D mesh has no baked atlas!')
        sys.exit(5)
    log(f'  SF3D: {len(sf_verts)} verts, atlas {sf_atlas.size}')

    # For each TripoSG vertex, find nearest SF3D vertex via KDTree
    tp_verts = np.asarray(tp_scene.vertices)
    tp_faces = np.asarray(tp_scene.faces)
    log(f'  TripoSG: {len(tp_verts)} verts / {len(tp_faces)} faces')
    log('  building KDTree on SF3D verts + querying nearest neighbour...')
    tree = cKDTree(sf_verts)
    _, nn_idx = tree.query(tp_verts, k=1, workers=-1)
    # Inherit SF3D UV from nearest SF3D vertex
    tp_uvs = sf_uvs[nn_idx]
    log(f'  UV inheritance done, {len(tp_uvs)} UVs assigned')

    # Build the new TripoSG mesh with SF3D UVs + atlas
    new_mesh = trimesh.Trimesh(
        vertices=tp_verts,
        faces=tp_faces,
        visual=trimesh.visual.TextureVisuals(
            uv=tp_uvs,
            image=sf_atlas,
        ),
        process=False,
    )
    new_mesh.export(out_path)
    log(f'STEP 5 done in {time.time()-t0:.1f}s -> {out_path}')


def main():
    if len(sys.argv) < 3:
        print('Usage: triposg_sf3d_uv_transfer.py <front_image> <out.glb> '
              '[target_faces=50000] [tex_res=1024]')
        sys.exit(1)
    image_path = sys.argv[1]
    out_glb = sys.argv[2]
    target_faces = int(sys.argv[3]) if len(sys.argv) > 3 else 50000
    tex_res = int(sys.argv[4]) if len(sys.argv) > 4 else 1024

    out_dir = os.path.dirname(os.path.abspath(out_glb))
    os.makedirs(out_dir, exist_ok=True)

    sf3d_glb = os.path.join(out_dir, '_sf3d_native.glb')
    triposg_raw_glb = os.path.join(out_dir, '_triposg_raw.glb')
    triposg_dec_glb = os.path.join(out_dir, '_triposg_decimated.glb')

    t0 = time.time()
    step_sf3d(image_path, sf3d_glb, tex_res)
    step_triposg(image_path, triposg_raw_glb)
    if target_faces > 0:
        step_decimate(triposg_raw_glb, triposg_dec_glb, target_faces)
        triposg_in = triposg_dec_glb
    else:
        log('STEP 3: SKIP decimation')
        triposg_in = triposg_raw_glb
    step_transfer_uv(triposg_in, sf3d_glb, out_glb)
    log(f'TOTAL: {time.time()-t0:.1f}s -> {out_glb}')


if __name__ == '__main__':
    main()
