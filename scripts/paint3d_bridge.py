"""FabMesh Paint3D Bridge — texture an existing mesh using Paint3D.

Pipeline:
  existing .glb mesh + reference image (ip-adapter-style)
  -> convert to .obj temp
  -> Paint3D stage 1 (depth-aware SD1.5 + ControlNet + IPAdapter)
  -> baked albedo UV atlas
  -> pack back into .glb

CLI:
    python paint3d_bridge.py <in_mesh.glb> <ref_image.png> <out.glb>
        [--prompt "..."] [--negative "..."] [--texture-size 1024]

Dependencies (installed via prebuilt wheels, no source compile):
    pytorch3d 0.7.9+d9839a9pt2.7.0cu128
    nvdiffrast 0.4.0+253ac4fpt2.7.0cu128
    trimesh, Pillow, numpy
    diffusers, transformers, accelerate (already in FabMesh env)

Also needs external/Paint3D/ in the repo. The paint3d package's kaolin
imports are re-routed to `paint3d.models._kal_shim` (a pytorch3d+nvdiffrast+
trimesh shim — see external/Paint3D/paint3d/models/_kal_shim.py).
"""
from __future__ import annotations
import os
import sys
import time
import shutil
import argparse
import subprocess
import tempfile


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAINT3D_DIR = os.path.join(ROOT, 'external', 'Paint3D')


def log(msg: str):
    print(f'[paint3d] {msg}', flush=True)


def _glb_to_obj(glb_path: str, obj_path: str) -> None:
    """Convert .glb -> .obj + .mtl + baseColor.png via trimesh.

    Paint3D's mesh loader wants an .obj file with UVs. trimesh handles
    GLB unpack cleanly including the embedded texture.
    """
    import trimesh
    scene = trimesh.load(glb_path, force='mesh')
    if isinstance(scene, trimesh.Scene):
        # pick the first geometry
        scene = list(scene.geometry.values())[0]
    # Ensure UVs exist. SF3D output has them; fallback to xatlas.
    if not hasattr(scene.visual, 'uv') or scene.visual.uv is None:
        log('input mesh has no UVs — running xatlas unwrap')
        import xatlas, numpy as np
        v = scene.vertices.astype(np.float32)
        f = scene.faces.astype(np.uint32)
        vmap, idx, uv = xatlas.parametrize(v, f)
        scene = trimesh.Trimesh(
            vertices=scene.vertices[vmap],
            faces=idx.astype(np.int64),
            visual=trimesh.visual.TextureVisuals(uv=uv),
            process=False,
        )
    scene.export(obj_path)
    log(f'converted glb -> obj: {obj_path}')


def _run_paint3d_stage2(obj_path: str, stage1_albedo: str,
                        ref_image: str, prompt: str,
                        outdir: str) -> str:
    """Run Paint3D stage 2 (UV-position ControlNet inpaint) on top of
    stage 1's albedo. Fills the magenta gaps where stage 1's 2 init
    views didn't cover."""
    if PAINT3D_DIR not in sys.path:
        sys.path.insert(0, PAINT3D_DIR)
    sd_cfg = os.path.join(PAINT3D_DIR, 'controlnet', 'config',
                          'UV_based_inpaint_template.yaml')
    render_cfg = os.path.join(PAINT3D_DIR, 'paint3d', 'config',
                              'train_config_paint3d.py')
    cmd = [
        sys.executable,
        os.path.join(PAINT3D_DIR, 'pipeline_paint3d_stage2.py'),
        '--sd_config', sd_cfg,
        '--render_config', render_cfg,
        '--mesh_path', obj_path,
        '--texture_path', stage1_albedo,
        '--prompt', prompt,
        '--outdir', outdir,
    ]
    if ref_image:
        cmd += ['--ip_adapter_image_path', ref_image]
    log(f'stage 2 cmd: {" ".join(cmd)}')
    t0 = time.time()
    r = subprocess.run(cmd, cwd=PAINT3D_DIR, check=False)
    log(f'stage 2 done in {time.time()-t0:.1f}s (rc={r.returncode})')
    if r.returncode != 0:
        raise RuntimeError(f'Paint3D stage 2 failed: rc={r.returncode}')
    albedo = os.path.join(outdir, 'res-0', 'albedo.png')
    if not os.path.exists(albedo):
        raise RuntimeError(f'Paint3D stage 2 produced no albedo at {albedo}')
    log(f'stage 2 albedo baked: {albedo}')
    return albedo


def _run_paint3d_stage1(obj_path: str, ref_image: str,
                        prompt: str, negative: str,
                        outdir: str) -> str:
    """Run Paint3D stage 1 in-process. Returns the albedo.png path."""
    # Make sure Paint3D is importable.
    if PAINT3D_DIR not in sys.path:
        sys.path.insert(0, PAINT3D_DIR)

    # Paint3D's pipeline_paint3d_stage1.py takes CLI args; easier to call
    # as subprocess so it stays isolated (its sys.path hacks and global
    # state don't leak into FabMesh).
    log(f'launching Paint3D stage 1 subprocess')
    # Use the template config as base; we feed prompt via --prompt and
    # ip_adapter_image via --ip_adapter_image_path (Paint3D's own CLI).
    sd_cfg = os.path.join(PAINT3D_DIR, 'controlnet', 'config',
                          'depth_based_inpaint_template.yaml')
    render_cfg = os.path.join(PAINT3D_DIR, 'paint3d', 'config',
                              'train_config_paint3d.py')
    cmd = [
        sys.executable,
        os.path.join(PAINT3D_DIR, 'pipeline_paint3d_stage1.py'),
        '--sd_config', sd_cfg,
        '--render_config', render_cfg,
        '--mesh_path', obj_path,
        '--prompt', prompt,
        '--outdir', outdir,
    ]
    # Paint3D stage 1 doesn't expose --neg_prompt as CLI — it's baked
    # into the sd_config yaml. We leave negative prompt as default.
    if ref_image:
        cmd += ['--ip_adapter_image_path', ref_image]
    log(f'cmd: {" ".join(cmd)}')
    t0 = time.time()
    # Run from Paint3D dir so its relative paths work.
    r = subprocess.run(cmd, cwd=PAINT3D_DIR, check=False)
    log(f'stage1 done in {time.time()-t0:.1f}s (rc={r.returncode})')
    if r.returncode != 0:
        raise RuntimeError(f'Paint3D stage1 failed: rc={r.returncode}')

    # Find the albedo.png — it's in <outdir>/res-0/albedo.png by default.
    # outdir passed to Paint3D is relative to PAINT3D_DIR (that's its
    # own convention). We normalized to absolute, so it should match.
    albedo = os.path.join(outdir, 'res-0', 'albedo.png')
    if not os.path.exists(albedo):
        raise RuntimeError(f'Paint3D stage1 produced no albedo at {albedo}')
    log(f'albedo baked: {albedo}')
    return albedo


def _pack_obj_to_glb(obj_dir: str, out_glb: str) -> None:
    """Pack the Paint3D mesh.obj + mesh.mtl + albedo.png into a GLB."""
    import trimesh
    obj_path = os.path.join(obj_dir, 'mesh.obj')
    mesh = trimesh.load(obj_path, process=False)
    if isinstance(mesh, trimesh.Scene):
        mesh = list(mesh.geometry.values())[0]
    # trimesh auto-loads the albedo.png via the .mtl file.
    mesh.export(out_glb)
    log(f'packed glb: {out_glb}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('in_mesh', help='input .glb or .obj mesh')
    ap.add_argument('ref_image',
                    help='reference image(s) for IP-Adapter. '
                         'Pass multiple as semicolon-separated paths, '
                         'e.g. "front.png;back.png" — Paint3D patched to '
                         'accept a list.')
    ap.add_argument('out_glb', help='output .glb with baked texture')
    ap.add_argument('--prompt', default=' ', help='subject prompt')
    ap.add_argument('--negative', default='', help='negative prompt')
    ap.add_argument('--work-dir', default=None,
                    help='scratch dir (default: sibling of out_glb)')
    ap.add_argument('--skip-stage2', action='store_true',
                    help='skip the UV-inpaint stage 2 (faster but leaves magenta gaps)')
    args = ap.parse_args()

    if not os.path.exists(args.in_mesh):
        log(f'MISSING: {args.in_mesh}')
        sys.exit(2)
    # ref_image can be a semicolon-separated list.
    for p in args.ref_image.split(';'):
        p = p.strip()
        if p and not os.path.exists(p):
            log(f'MISSING ref: {p}')
            sys.exit(2)

    # Work dir: <out_glb>.paint3d_work/
    work = args.work_dir or (os.path.abspath(args.out_glb) + '.paint3d_work')
    os.makedirs(work, exist_ok=True)
    log(f'work dir: {work}')

    # Step 1: GLB -> OBJ (Paint3D wants .obj)
    in_mesh = os.path.abspath(args.in_mesh)
    if in_mesh.lower().endswith('.glb'):
        obj_path = os.path.join(work, 'input_mesh.obj')
        _glb_to_obj(in_mesh, obj_path)
    else:
        obj_path = in_mesh

    # Step 2: run Paint3D stage 1
    outdir1 = os.path.abspath(os.path.join(work, 'stage1'))
    # Convert each semicolon-separated ref to absolute path; rejoin.
    ref_abs = ';'.join(
        os.path.abspath(p.strip()) for p in args.ref_image.split(';') if p.strip()
    )
    albedo1 = _run_paint3d_stage1(obj_path, ref_abs, args.prompt,
                                   args.negative, outdir1)
    # Stage 1 writes mesh.obj + albedo.png + mesh.mtl in outdir1/res-0/
    stage1_obj = os.path.join(outdir1, 'res-0', 'mesh.obj')

    # Step 3: run Paint3D stage 2 (UV-inpaint on top of stage 1)
    if args.skip_stage2:
        log('skipping stage 2 (--skip-stage2)')
        final_res_dir = os.path.join(outdir1, 'res-0')
    else:
        outdir2 = os.path.abspath(os.path.join(work, 'stage2'))
        _run_paint3d_stage2(stage1_obj, albedo1, ref_abs, args.prompt, outdir2)
        final_res_dir = os.path.join(outdir2, 'res-0')

    # Step 4: pack final textured OBJ back to GLB
    _pack_obj_to_glb(final_res_dir, os.path.abspath(args.out_glb))
    log(f'DONE: {args.out_glb}')
    print(f'GLB_PATH: {args.out_glb}', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        log(f'ERROR: {type(e).__name__}: {e}')
        import traceback; traceback.print_exc()
        sys.exit(1)
