"""TripoSG full pipeline: image -> mesh + UV + textured atlas (out.glb).

TripoSG only generates raw geometry (no UVs, ~1.4M faces). This wrapper
adds the missing steps so the output is a complete textured GLB usable
in FabMesh:

  1. local_triposg_bridge.py    -> raw mesh (no UV, no texture)
  2. trimesh quadric decimation -> ~target_faces (default 30000)
  3. xatlas UV unwrap
  4. texture_project.py        -> back-project the front photo to UV atlas

Usage:
    python triposg_full_pipeline.py <front_image> <out.glb>
        [target_faces=30000] [tex_res=1024]
"""
import sys
import os
import time
import subprocess
import tempfile
import numpy as np
import trimesh
import xatlas


SCRIPTS = os.path.dirname(os.path.abspath(__file__))


def log(msg):
    print(f'[triposg_full] {msg}', flush=True)


def step_triposg(image_path, out_glb):
    log(f'STEP 1: TripoSG raw mesh -> {out_glb}')
    bridge = os.path.join(SCRIPTS, 'local_triposg_bridge.py')
    t0 = time.time()
    # Inherit stdout/stderr so the bridge's LOCAL_TRIPOSG_PROGRESS markers
    # reach Electron's progress mapper. Capturing here would hide them.
    rc = subprocess.run(
        [sys.executable, bridge, image_path, out_glb, '30', '7.0'],
        timeout=300,
    ).returncode
    if rc != 0:
        log(f'TripoSG failed with rc={rc}')
        sys.exit(2)
    log(f'STEP 1 done in {time.time()-t0:.1f}s')


def step_decimate(in_glb, out_glb, target_faces):
    log(f'STEP 2: decimate to {target_faces} faces')
    t0 = time.time()
    m = trimesh.load(in_glb, force='mesh')
    log(f'  loaded: {len(m.vertices)}v / {len(m.faces)}f')
    if len(m.faces) > target_faces:
        # Try fast-simplification (best on huge meshes, ships with trimesh
        # extras). Then trimesh.simplify_quadric_decimation (which uses
        # vedo/open3d under the hood — its arg is FACE COUNT not ratio).
        ok = False
        try:
            import fast_simplification
            verts_out, tris_out = fast_simplification.simplify(
                m.vertices, m.faces,
                target_count=target_faces,
            )
            m = trimesh.Trimesh(vertices=verts_out, faces=tris_out,
                                  process=False)
            log(f'  decimated to {len(m.faces)}f via fast_simplification')
            ok = True
        except Exception as e:
            log(f'  fast_simplification not available ({e})')
        if not ok:
            # trimesh.simplify_quadric_decimation: signature is
            # simplify_quadric_decimation(face_count) — but in newer
            # trimesh it's percent. Try percent first.
            try:
                pct = target_faces / len(m.faces)
                m_dec = m.simplify_quadric_decimation(percent=pct)
                log(f'  decimated to {len(m_dec.faces)}f via trimesh '
                    f'simplify_quadric (percent={pct:.4f})')
                m = m_dec
                ok = True
            except Exception as e:
                log(f'  trimesh percent failed ({e})')
        if not ok:
            log('  ALL decimation methods failed, keeping original')
    m.export(out_glb)
    log(f'STEP 2 done in {time.time()-t0:.1f}s -> {out_glb}')


def step_unwrap(in_glb, out_glb):
    log('STEP 3: xatlas UV unwrap')
    t0 = time.time()
    m = trimesh.load(in_glb, force='mesh')
    v = m.vertices.astype(np.float32)
    f = m.faces.astype(np.uint32)
    log(f'  unwrapping {len(v)}v / {len(f)}f...')
    atlas = xatlas.Atlas()
    atlas.add_mesh(v, f)
    atlas.generate()
    vmap, indices, uvs = atlas[0]
    new_mesh = trimesh.Trimesh(
        vertices=v[vmap],
        faces=indices.astype(np.int64),
        visual=trimesh.visual.TextureVisuals(uv=uvs),
        process=False,
    )
    log(f'  result: {len(new_mesh.vertices)}v / {len(new_mesh.faces)}f, '
        f'{atlas.chart_count} UV charts, util {atlas.utilization:.1%}')
    new_mesh.export(out_glb)
    log(f'STEP 3 done in {time.time()-t0:.1f}s -> {out_glb}')


def step_texture(mesh_glb, image_path, out_glb, tex_res, mv_dir=None):
    log(f'STEP 4: bake atlas via texture_project (res={tex_res})')
    t0 = time.time()
    args = [sys.executable, os.path.join(SCRIPTS, 'texture_project.py'),
            mesh_glb, image_path, out_glb, str(tex_res)]
    if mv_dir:
        args += ['--multiview', mv_dir]
    rc = subprocess.run(args, timeout=600).returncode
    if rc != 0:
        log(f'texture_project failed with rc={rc}')
        sys.exit(3)
    log(f'STEP 4 done in {time.time()-t0:.1f}s')


def step_augment(mesh_glb, front_image, out_glb, mv_dir):
    log(f'STEP 5: augment back blend via texture_augment')
    t0 = time.time()
    rc = subprocess.run(
        [sys.executable, os.path.join(SCRIPTS, 'texture_augment.py'),
         mesh_glb, front_image, out_glb, '--multiview', mv_dir],
        timeout=300,
    ).returncode
    if rc != 0:
        log(f'augment failed with rc={rc}')
        # Non-fatal: keep the front-textured mesh
        log('  keeping front-only textured mesh')
        return
    log(f'STEP 5 done in {time.time()-t0:.1f}s')


def main():
    if len(sys.argv) < 3:
        print('Usage: triposg_full_pipeline.py <front_image> <out.glb> '
              '[target_faces=0] [tex_res=1024] [--mv-dir=<path>]\n'
              '  target_faces=0 = NO decimation (keep ~1.4M faces).\n'
              '  --mv-dir = optional 2-view multiview dir for augment blend.')
        sys.exit(1)
    image_path = sys.argv[1]
    out_glb = sys.argv[2]
    target_faces = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    tex_res = int(sys.argv[4]) if len(sys.argv) > 4 else 1024
    mv_dir = None
    for a in sys.argv:
        if a.startswith('--mv-dir='):
            mv_dir = a.split('=', 1)[1]

    out_dir = os.path.dirname(os.path.abspath(out_glb))
    os.makedirs(out_dir, exist_ok=True)

    raw_glb = os.path.join(out_dir, '_triposg_raw.glb')
    uv_glb = os.path.join(out_dir, '_triposg_uvunwrapped.glb')
    front_only_glb = os.path.join(out_dir, '_triposg_front_only.glb')

    t0 = time.time()
    step_triposg(image_path, raw_glb)
    if target_faces > 0:
        dec_glb = os.path.join(out_dir, '_triposg_decimated.glb')
        step_decimate(raw_glb, dec_glb, target_faces)
        unwrap_in = dec_glb
    else:
        log('STEP 2: SKIP decimation (target_faces=0)')
        unwrap_in = raw_glb
    step_unwrap(unwrap_in, uv_glb)
    if mv_dir and os.path.isdir(mv_dir):
        # Texture with all views (front + back) via texture_project,
        # then augment for cleaner dorsal blend
        step_texture(uv_glb, image_path, front_only_glb, tex_res, mv_dir)
        step_augment(front_only_glb, image_path, out_glb, mv_dir)
    else:
        # No back view: just project the front
        step_texture(uv_glb, image_path, out_glb, tex_res)
    # Final 100% marker so Electron's progress bar reaches the end and the
    # job is considered complete by the UI mapper.
    print('LOCAL_TRIPOSG_PROGRESS: 100 done', flush=True)
    log(f'TOTAL: {time.time()-t0:.1f}s -> {out_glb}')


if __name__ == '__main__':
    main()
