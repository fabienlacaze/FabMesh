"""2-view -> 3D: feed ip45_front + ip45_back into SF3D via a pre-built
CRM-compatible 6-slot multiview dir. No new image generation — reuses
existing _scale_sweep outputs.

Default inputs (if no args):
    images/child/_scale_sweep/ip45_front.png
    images/child/_scale_sweep/ip45_back.png

Output:
    <out_dir>/mv/           # 6 slots + views.json (front, back duplicated)
    <out_dir>/mesh.glb      # final textured mesh

Env exported to SF3D bridge:
    FABMESH_MV_REUSE = <out_dir>/mv   (the bridge must support this;
                                       see local_sf3d_bridge.py patch)
"""
from __future__ import annotations
import os
import sys
import json
import time
import shutil
import argparse
import subprocess


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(ROOT, 'scripts')


def log(msg):
    print(f'[ip45_2v] {msg}', flush=True)


def build_mv_dir(mv_dir: str, front_png: str, back_png: str) -> None:
    from PIL import Image
    os.makedirs(mv_dir, exist_ok=True)
    # mv slots stay at 1024 — Run K proved that 2048 flips the mesh
    # (see AGENT_LOG). Even raising mv resolution above input.png's
    # native ~1151px makes mv/view_0 dominant -> flip. The 1024
    # bottleneck is structural for D placement.
    front = Image.open(front_png).convert('RGB').resize((1024, 1024))
    back = Image.open(back_png).convert('RGB').resize((1024, 1024))

    front.save(os.path.join(mv_dir, 'input.png'))
    # CANONICAL E LAYOUT — confirmed unchangeable.
    # Runs C/F/G/H/I all proved that ANY change to mv/ contents
    # (back-only, skip view_0, swap view_0=back, view_0=transparent)
    # FLIPS the rendered mesh 180° in the viewer. The fix for E's
    # face moiré must come from texture_project.py priority logic,
    # NOT from mv/ content changes.
    slots = {0: front, 1: front, 2: back, 3: back, 4: front, 5: back}
    for slot, img in slots.items():
        img.save(os.path.join(mv_dir, f'view_{slot}.png'))

    schema = {
        'engine': 'ip45_2view',
        'views': [
            {'azim':   0.0, 'elev':   0.0, 'label': 'front'},
            {'azim':  90.0, 'elev':   0.0, 'label': 'right_dup_front'},
            {'azim': 180.0, 'elev':   0.0, 'label': 'back'},
            {'azim': 270.0, 'elev':   0.0, 'label': 'left_dup_back'},
            {'azim':   0.0, 'elev':  90.0, 'label': 'top_dup_front'},
            {'azim':   0.0, 'elev': -90.0, 'label': 'bottom_dup_back'},
        ],
    }
    with open(os.path.join(mv_dir, 'views.json'), 'w') as f:
        json.dump(schema, f, indent=2)
    log(f'mv dir built -> {mv_dir}')


def run_sf3d(source_image: str, mv_dir: str, glb_out: str) -> None:
    bridge = os.path.join(SCRIPTS, 'local_sf3d_bridge.py')
    env = dict(os.environ)
    env['FABMESH_MV_REUSE'] = mv_dir
    env.setdefault('FABMESH_PROJECT_MODE', 'refine')
    # Run P (2026-04-18): use NORMALIZE=1 (bridge default) to get
    # REAL_D's high-quality textures, THEN post-rotate the exported
    # mesh by Rx(180)@Ry(180) (= Rz(180) net) to fix the dual bug
    # observed in REAL_D (side-swap + head-toward-feet inversion).
    cmd = [sys.executable, bridge, source_image, glb_out]
    log(f'SF3D: {" ".join(cmd)}  (FABMESH_MV_REUSE={mv_dir}, NORMALIZE=1)')
    r = subprocess.run(cmd, env=env, check=False)
    if r.returncode != 0:
        raise RuntimeError(f'sf3d bridge failed: rc={r.returncode}')

    # Post-rotation: fix the dual bug in REAL_D output.
    if os.environ.get('FABMESH_IP45_POST_ROTATE', '1') == '1':
        _post_rotate_glb_xy180(glb_out)


def _post_rotate_glb_xy180(glb_path: str) -> None:
    """Apply Ry(180) to the mesh in `glb_path` in-place using
    glb_post_rotate.py (binary-preserving — does NOT round-trip
    through trimesh, so the SDXL-refined embedded baseColorTexture
    is preserved).

    Runs P+Q showed that trimesh load+apply_transform+export drops
    ~50% of the GLB file (likely the high-res texture binary).
    pygltflib-based positions-only rotation keeps everything else.
    """
    rotator = os.path.join(SCRIPTS, 'glb_post_rotate.py')
    log(f'post-rotating mesh Ry(180) via pygltflib -> {glb_path}')
    r = subprocess.run([sys.executable, rotator, glb_path, 'y', '180'],
                       check=False)
    if r.returncode != 0:
        raise RuntimeError(f'glb_post_rotate failed: rc={r.returncode}')


def main():
    default_sweep = os.path.join(ROOT, 'images', 'child', '_scale_sweep')
    ap = argparse.ArgumentParser()
    ap.add_argument('--front', default=os.path.join(default_sweep, 'ip45_front.png'))
    ap.add_argument('--back',  default=os.path.join(default_sweep, 'ip45_back.png'))
    ap.add_argument('--out-dir', default=os.path.join(ROOT, 'logs', 'child_ip45_2view'))
    args = ap.parse_args()

    for p in (args.front, args.back):
        if not os.path.exists(p):
            log(f'MISSING: {p}')
            sys.exit(2)

    os.makedirs(args.out_dir, exist_ok=True)
    # Copy the two inputs into the run dir for auditability.
    shutil.copy(args.front, os.path.join(args.out_dir, 'front.png'))
    shutil.copy(args.back,  os.path.join(args.out_dir, 'back.png'))

    mv_dir = os.path.join(args.out_dir, 'mv')
    glb_out = os.path.join(args.out_dir, 'mesh.glb')

    t0 = time.time()
    build_mv_dir(mv_dir, args.front, args.back)
    # SF3D's single-view geometry input: use front (the ip45 one).
    run_sf3d(args.front, mv_dir, glb_out)
    log(f'DONE in {time.time()-t0:.1f}s -> {glb_out}')
    print(f'GLB_PATH: {glb_out}', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        log(f'ERROR: {type(e).__name__}: {e}')
        import traceback; traceback.print_exc()
        sys.exit(1)
