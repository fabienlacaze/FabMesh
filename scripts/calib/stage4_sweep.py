"""
Sweep Stage 4 projection variants to find the winning camera convention.
Tests: rotation-offset 0/90/180/270 × U-flip on/off.
Keeps the combination with the highest score, writes winner to stdout.
"""
from __future__ import annotations
import os, sys, json, subprocess, tempfile, shutil
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stage_checks import (check_stage4_projection, ROOT, GT_CUBE_GLB,
                           GT_MV_DIR, GT_AXES_DIR)


def _run_one(rot, u_flip):
    work_dir = os.path.join(ROOT, 'logs', f'sweep_rot{rot}_u{int(u_flip)}')
    if os.path.exists(work_dir):
        shutil.rmtree(work_dir)
    os.makedirs(work_dir)
    env = dict(os.environ)
    env['FABMESH_TEXPROJ_NO_UFLIP'] = '0' if u_flip else '1'
    # Monkey-patch the rotation-offset argv: re-implement the Stage 4 call.
    out_glb = os.path.join(work_dir, 'stage4_projected.glb')
    gt_input = os.path.join(GT_MV_DIR, 'input.png')
    script = os.path.join(ROOT, 'scripts', 'texture_project.py')
    r = subprocess.run(
        [sys.executable, script, GT_CUBE_GLB, gt_input, out_glb, '1024',
         '--multiview', GT_MV_DIR, '--rotation-offset', str(rot)],
        env=env, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        return None
    # Score: reuse stage_checks logic without re-running texture_project
    import trimesh, numpy as np
    from PIL import Image
    sys.path.insert(0, os.path.join(ROOT, 'scripts'))
    from calibrate import render_axis, AXES
    g = trimesh.load(out_glb, force='mesh', process=False)
    sims = []
    for name, cam, up, letter, desc in AXES:
        got = render_axis(g, cam, up, size=384)
        Image.fromarray(got).save(os.path.join(work_dir, f'stage4_{name}.png'))
        gt = np.asarray(Image.open(os.path.join(GT_AXES_DIR, f'{name}.png'))
                        .convert('RGB').resize((384, 384), Image.LANCZOS)).astype(float)
        m0, m1 = int(384 * 0.18), int(384 * 0.82)
        d = float(np.linalg.norm(got[m0:m1, m0:m1].astype(float) - gt[m0:m1, m0:m1], axis=2).mean())
        sims.append(float(1.0 - d / 441.0))
    correct = sum(1 for s in sims if s >= 0.60)
    return {'rot': rot, 'u_flip': u_flip, 'correct': correct,
            'sims': [round(s, 3) for s in sims], 'work_dir': work_dir}


def main():
    print('[sweep] stage 4 convention search...')
    results = []
    for rot in (0, 90, 180, 270):
        for u in (False, True):
            r = _run_one(rot, u)
            if r:
                print(f'  rot={rot:3d} u_flip={u!s:5} -> {r["correct"]}/6 sims={r["sims"]}')
                results.append(r)
    results.sort(key=lambda x: (-x['correct'], -sum(x['sims'])))
    best = results[0] if results else None
    print('[sweep] best:')
    print(json.dumps(best, indent=2))


if __name__ == '__main__':
    main()
