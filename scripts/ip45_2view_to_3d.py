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
    front = Image.open(front_png).convert('RGB').resize((1024, 1024))
    back = Image.open(back_png).convert('RGB').resize((1024, 1024))

    front.save(os.path.join(mv_dir, 'input.png'))
    # texture_project ALWAYS adds input.png at azim=0 (or shifted to 180
    # via FABMESH_TEXPROJ_SHIFT_SOURCE). It supplies the FRONT signal at
    # native 1151px resolution.
    # We therefore don't duplicate `front` into any mv slot — that creates
    # subpixel ghosting between the 1151px source and the 1024px dups
    # (visible as deformed eyes / dark patches on the face).
    # All 6 mv slots = the BACK image. Yes the CRM "right/left/top/bottom"
    # slots end up duplicated, but they only fill in directions that have
    # no other coverage (sides, top, bottom), and those are far enough from
    # the face that ghosting doesn't matter.
    slots = {0: back, 1: back, 2: back, 3: back, 4: back, 5: back}
    for slot, img in slots.items():
        img.save(os.path.join(mv_dir, f'view_{slot}.png'))

    # All slots labelled as the back view (azim=180 in SF3D-native frame).
    # After bridge applies +180° rotation_offset, every mv slot lands at
    # az=0 of the post-rotation mesh — i.e. the BACK of the rotated mesh.
    # input.png (with SHIFT_SOURCE) lands at az=180 of the rotated mesh
    # = the FRONT of the rotated mesh, which is what we want.
    schema = {
        'engine': 'ip45_2view',
        'views': [
            {'azim': 180.0, 'elev':   0.0, 'label': 'back_slot_0'},
            {'azim': 180.0, 'elev':   0.0, 'label': 'back_slot_1'},
            {'azim': 180.0, 'elev':   0.0, 'label': 'back_slot_2'},
            {'azim': 180.0, 'elev':   0.0, 'label': 'back_slot_3'},
            {'azim': 180.0, 'elev':   0.0, 'label': 'back_slot_4'},
            {'azim': 180.0, 'elev':   0.0, 'label': 'back_slot_5'},
        ],
    }
    with open(os.path.join(mv_dir, 'views.json'), 'w') as f:
        json.dump(schema, f, indent=2)
    log(f'mv dir built -> {mv_dir}')


def run_sf3d(source_image: str, mv_dir: str, glb_out: str) -> None:
    bridge = os.path.join(SCRIPTS, 'local_sf3d_bridge.py')
    env = dict(os.environ)
    env['FABMESH_MV_REUSE'] = mv_dir
    # Keep the refine mode so texture projection consumes the multi-views.
    env.setdefault('FABMESH_PROJECT_MODE', 'refine')
    # Disable the bridge's +180° Y rotation. That rotation exists to make
    # the face point to +Z (three.js default camera), but it also injects a
    # 180° offset into every MV projection while leaving the source image
    # at azim=0 — which puts the BACK image on the FRONT of the mesh (and
    # the face on the back). Our views.json already uses the canonical
    # SF3D frame (face at -Z), so we turn the normalizer off entirely.
    env['FABMESH_SF3D_NORMALIZE_ORIENT'] = '0'
    cmd = [sys.executable, bridge, source_image, glb_out]
    log(f'SF3D: {" ".join(cmd)}  (FABMESH_MV_REUSE={mv_dir})')
    r = subprocess.run(cmd, env=env, check=False)
    if r.returncode != 0:
        raise RuntimeError(f'sf3d bridge failed: rc={r.returncode}')


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
