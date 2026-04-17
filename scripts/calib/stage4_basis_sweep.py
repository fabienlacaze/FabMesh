"""
Brute-force the 24 possible signed-axis permutations of R_w2c_base
(and optionally R_undo). For each, run Stage 4 on the GT cube and
keep the winner.

R_w2c_base is 3x3 with exactly one ±1 per row and per column -> 48 matrices,
of which 24 are rotations (det=+1). We'll test all 48 and keep only
those that actually rotate (reject reflections that break face winding).
"""
from __future__ import annotations
import os, sys, json, subprocess, shutil, itertools
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stage_checks import ROOT, GT_CUBE_GLB, GT_MV_DIR, GT_AXES_DIR


def _signed_permutations():
    """Yield all 3x3 matrices with one signed unit per row/column. 48 total.
    Of these, 24 have determinant +1 (rotations); the rest are reflections."""
    out = []
    for perm in itertools.permutations(range(3)):
        for signs in itertools.product([-1, 1], repeat=3):
            M = np.zeros((3, 3), dtype=np.float64)
            for i in range(3):
                M[i, perm[i]] = signs[i]
            if abs(np.linalg.det(M) - 1.0) < 1e-6:
                out.append(M)
    return out  # 24 rotations


def _write_basis_override(matrix):
    """Write R_w2c_base override to a temp json the script can read."""
    path = os.path.join(ROOT, '.fabmesh', 'texproj_basis_override.json')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(matrix.tolist(), f)
    return path


def _score_glb(out_glb, work_dir):
    import trimesh
    from PIL import Image
    sys.path.insert(0, os.path.join(ROOT, 'scripts'))
    from calibrate import render_axis, AXES
    g = trimesh.load(out_glb, force='mesh', process=False)
    sims = []
    for name, cam, up, letter, desc in AXES:
        got = render_axis(g, cam, up, size=384)
        Image.fromarray(got).save(os.path.join(work_dir, f'{name}.png'))
        gt = np.asarray(Image.open(os.path.join(GT_AXES_DIR, f'{name}.png'))
                        .convert('RGB').resize((384, 384), Image.LANCZOS)).astype(float)
        m0, m1 = int(384 * 0.18), int(384 * 0.82)
        d = float(np.linalg.norm(got[m0:m1, m0:m1].astype(float) - gt[m0:m1, m0:m1], axis=2).mean())
        sims.append(float(1.0 - d / 441.0))
    correct = sum(1 for s in sims if s >= 0.60)
    return correct, sims


def _run_one(basis_matrix, work_root, tag):
    work_dir = os.path.join(work_root, tag)
    if os.path.exists(work_dir):
        shutil.rmtree(work_dir)
    os.makedirs(work_dir)
    out_glb = os.path.join(work_dir, 'out.glb')
    gt_input = os.path.join(GT_MV_DIR, 'input.png')
    _write_basis_override(basis_matrix)
    script = os.path.join(ROOT, 'scripts', 'texture_project.py')
    env = {**os.environ, 'PYTHONUNBUFFERED': '1',
           'FABMESH_TEXPROJ_BASIS_OVERRIDE':
               os.path.join(ROOT, '.fabmesh', 'texproj_basis_override.json')}
    r = subprocess.run(
        [sys.executable, script, GT_CUBE_GLB, gt_input, out_glb, '1024',
         '--multiview', GT_MV_DIR, '--rotation-offset', '0'],
        env=env, capture_output=True, text=True, timeout=120)
    if r.returncode != 0 or not os.path.exists(out_glb):
        return None
    return _score_glb(out_glb, work_dir)


def main():
    work_root = os.path.join(ROOT, 'logs', 'basis_sweep')
    os.makedirs(work_root, exist_ok=True)
    perms = _signed_permutations()
    print(f'[sweep] testing {len(perms)} signed-axis permutations of R_w2c_base')
    results = []
    for i, M in enumerate(perms):
        tag = f'p{i:02d}'
        res = _run_one(M, work_root, tag)
        if res is None:
            continue
        correct, sims = res
        results.append((correct, sims, M, tag))
        print(f'  {tag} det=+1 M=\n{M.astype(int)} -> {correct}/6 sims={[round(s,2) for s in sims]}')
    results.sort(key=lambda x: (-x[0], -sum(x[1])))
    print('\n=== TOP 5 ===')
    for correct, sims, M, tag in results[:5]:
        print(f'{tag}: {correct}/6 sims={[round(s,2) for s in sims]}\n{M.astype(int)}\n')


if __name__ == '__main__':
    main()
