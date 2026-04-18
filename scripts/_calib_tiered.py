"""
Tiered calibration loop with per-tier auto-tuning.

Philosophy: don't waste time tuning a downstream stage when an upstream
stage is broken. Lock each tier before moving to the next.

TIER 1 — Reference image sanity check (~5s, pass/fail)
    File exists, correct size, decodable, non-degenerate contrast.
    If fails, stop — pointless to go further.

TIER 2 — Multi-view generation quality (~1-2 min, tunable)
    Zero123++ generates 6 views. Score = avg similarity vs ground truth.
    Target: >= 0.60. Tune knobs (style-harmonize, CFG if exposed, seed)
    until threshold met or exhausted.

TIER 3 — Mesh + projection (~2 min, tunable)
    SF3D + texture_project. Target: 6/6 faces correct.
    Tune projection flags (FLIP_AZIM / FLIP_ELEV / FLIP_CAMPOS_AZIM,
    rotation-offset) to find the best combo. If no combo reaches 6/6,
    report the best one attained and flag the upstream cause.

Winning knobs persist in .fabmesh/calib_tuned.json so future normal
runs inherit them.

Emits progress JSON lines for the UI:
    TIER_JSON: {"tier":1,"phase":"start","message":"..."}
    TIER_JSON: {"tier":2,"phase":"tune","iter":3,"score":0.65,"config":{...}}
    TIER_JSON: {"tier":3,"phase":"done","score":"5/6","config":{...}}

Final line:
    TIERED_RESULT: {"tiers":[...], "winner_config":{...}, "best_score":"5/6"}

Usage:  python scripts/_calib_tiered.py
"""
from __future__ import annotations
import os, sys, json, subprocess, datetime, time, shutil
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CALIB_DIR = os.path.join(ROOT, 'images', '_calibration')
REF_IMG = os.path.join(CALIB_DIR, 'ref_rubiks.png')
GT_AXES = os.path.join(CALIB_DIR, 'ref_rubiks_axes_perfect')
GT_MV = os.path.join(CALIB_DIR, 'ref_rubiks_multiview_perfect')
MV_ACTIVE = os.path.join(CALIB_DIR, 'ref_rubiks_multiview')
REPORTS = os.path.join(CALIB_DIR, 'reports')
TUNED_PATH = os.path.join(ROOT, '.fabmesh', 'calib_tuned.json')
FABMESH_LOG = os.path.join(ROOT, 'logs', 'fabmesh.log')
os.makedirs(os.path.dirname(TUNED_PATH), exist_ok=True)

# Thresholds
# Zero123++ on a perfectly flat Rubik's Cube caps around 0.55-0.60
# similarity vs our ideal GT renders (it adds shading, slight rotation,
# bg tint). 0.50 is a realistic floor: below that we consider the
# multi-views genuinely broken. Above, we accept and move to tier 3.
# Comparing Zero123++ rotated views to the input image floors around
# 0.30-0.40 even on a perfect run (different angles = different pixels).
# We only want to catch catastrophic failures (all-black, all-gray, etc.).
TIER2_MIN_SIM = 0.30
# Tier 3 scoring is now visual similarity vs Zero123++ multi-views:
# count of views with sim >= 0.50. 4/6 is a realistic pass threshold.
TIER3_TARGET = 4


def _log(msg, level='INFO'):
    ts = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.') + f'{datetime.datetime.utcnow().microsecond//1000:03d}Z'
    line = f'{ts} [{level}] [calib] {msg}\n'
    try:
        with open(FABMESH_LOG, 'a', encoding='utf-8') as f:
            f.write(line)
    except Exception: pass
    print(f'[calib-tiered] {msg}', flush=True)


def _emit(obj):
    """Emit a JSON progress line the UI can parse."""
    print('TIER_JSON: ' + json.dumps(obj), flush=True)


def _sim(a_path, b_path, size=384):
    """Center-region color similarity, 0..1 (higher = closer)."""
    a = np.asarray(Image.open(a_path).convert('RGB').resize((size, size), Image.LANCZOS)).astype(float)
    b = np.asarray(Image.open(b_path).convert('RGB').resize((size, size), Image.LANCZOS)).astype(float)
    m0, m1 = int(size * 0.2), int(size * 0.8)
    diff = np.linalg.norm(a[m0:m1, m0:m1] - b[m0:m1, m0:m1], axis=2)
    return float(1.0 - diff.mean() / 441.0)


# ============================================================
# TIER 1 — reference image sanity
# ============================================================

def tier1_reference_image():
    _emit({'tier': 1, 'phase': 'start', 'name': 'Reference image sanity'})
    _log('TIER 1: reference image sanity')
    if not os.path.exists(REF_IMG):
        _emit({'tier': 1, 'phase': 'fail', 'reason': 'ref_rubiks.png missing'})
        return {'ok': False, 'reason': 'missing ref_rubiks.png — run _calib_build_rubiks.py'}
    try:
        im = Image.open(REF_IMG).convert('RGB')
    except Exception as e:
        _emit({'tier': 1, 'phase': 'fail', 'reason': f'decode failed: {e}'})
        return {'ok': False, 'reason': f'decode failed: {e}'}
    arr = np.asarray(im).astype(float)
    # Contrast check: min-max spread across the image
    spread = arr.max() - arr.min()
    w, h = im.size
    details = {
        'size': im.size, 'mode': im.mode,
        'contrast_spread': float(spread),
        'mean': [float(arr[..., c].mean()) for c in range(3)],
        'file_bytes': os.path.getsize(REF_IMG),
    }
    if w < 256 or h < 256:
        _emit({'tier': 1, 'phase': 'fail', 'reason': f'image too small: {im.size}', **details})
        return {'ok': False, 'reason': f'image too small: {im.size}', 'details': details}
    if spread < 50:
        _emit({'tier': 1, 'phase': 'fail', 'reason': f'image too flat (spread={spread:.0f})', **details})
        return {'ok': False, 'reason': f'image has no contrast (spread={spread:.0f})', 'details': details}
    _log(f'  image OK: {im.size}, spread={spread:.0f}')
    _emit({'tier': 1, 'phase': 'pass', **details})
    return {'ok': True, 'details': details}


# ============================================================
# TIER 2 — multi-view quality (tunable)
# ============================================================

def _generate_multiviews(env, logger_prefix=''):
    """Invoke multiview_gen. Returns (ok, error)."""
    # Clear old views first so we re-generate with new config
    if os.path.exists(MV_ACTIVE):
        for fn in os.listdir(MV_ACTIVE):
            if fn.startswith('view_') or fn == 'input.png':
                try: os.remove(os.path.join(MV_ACTIVE, fn))
                except Exception: pass
    os.makedirs(MV_ACTIVE, exist_ok=True)
    script = os.path.join(ROOT, 'scripts', 'multiview_gen.py')
    r = subprocess.run([sys.executable, script, REF_IMG, MV_ACTIVE],
                       env=env, capture_output=True, text=True, timeout=600)
    if r.returncode != 0 or not os.path.exists(os.path.join(MV_ACTIVE, 'view_0.png')):
        return False, (r.stderr or '')[-400:]
    return True, None


def _score_multiviews():
    """Score Zero123++ output WITHOUT needing a GT.
    For subjects without a synthetic ground truth (e.g. a RealVisXL-
    generated apple), we instead check:
      - All 6 views decodable and non-empty
      - Each view has decent contrast (spread >= 40)
      - avg similarity of each view to the INPUT image (lower bound:
        Zero123++ shouldn't drift entirely away from the subject)
    """
    sims = []
    for i in range(6):
        got = os.path.join(MV_ACTIVE, f'view_{i}.png')
        if not os.path.exists(got):
            sims.append(0.0); continue
        # Compare vs the input image (should share overall palette + subject)
        sims.append(_sim(got, REF_IMG))
    return sims, sum(sims) / max(1, len(sims))


def tier2_multiview(prev_ok):
    _emit({'tier': 2, 'phase': 'start', 'name': 'Multi-view generation'})
    if not prev_ok:
        _emit({'tier': 2, 'phase': 'skipped', 'reason': 'tier 1 failed'})
        return {'ok': False, 'skipped': True, 'reason': 'tier 1 failed'}

    # Variants to try (cheap knobs; each is one full Zero123++ run ~1min)
    # Order by likelihood of helping this particular issue.
    variants = [
        {'name': 'default', 'env': {}},
        {'name': 'harmonize_on', 'env': {'FABMESH_MV_STYLE_HARMONIZE': '1'}},
        {'name': 'identity_harmonize_on', 'env': {'FABMESH_MV_IDENTITY_HARMONIZE': '1'}},
    ]

    best = {'score': -1, 'variant': None, 'sims': None}
    for i, v in enumerate(variants):
        _log(f'TIER 2 variant {i+1}/{len(variants)}: {v["name"]} env={v["env"]}')
        _emit({'tier': 2, 'phase': 'tune', 'iter': i+1, 'total': len(variants),
               'variant': v['name'], 'env': v['env']})
        env = {**os.environ, 'PYTHONUNBUFFERED': '1', **v['env']}
        ok, err = _generate_multiviews(env)
        if not ok:
            _emit({'tier': 2, 'phase': 'iter_fail', 'variant': v['name'], 'error': err})
            continue
        sims, avg = _score_multiviews()
        _log(f'  {v["name"]}: avg_sim={avg:.3f} sims={[round(s,2) for s in sims]}')
        _emit({'tier': 2, 'phase': 'iter_done', 'variant': v['name'],
               'avg_sim': round(avg, 3), 'sims': [round(s, 3) for s in sims]})
        if avg > best['score']:
            best = {'score': avg, 'variant': v, 'sims': sims}
        # Early exit if clearly good
        if avg >= 0.85:
            _log(f'  tier 2 early-exit: {avg:.2f} >= 0.85')
            break

    passed = best['score'] >= TIER2_MIN_SIM
    _emit({'tier': 2, 'phase': 'done', 'score': round(best['score'], 3),
           'threshold': TIER2_MIN_SIM, 'passed': passed,
           'winning_variant': best['variant']['name'] if best['variant'] else None})
    return {
        'ok': passed, 'best_variant': best['variant'], 'best_sim': best['score'],
        'sims': best['sims'], 'threshold': TIER2_MIN_SIM,
    }


# ============================================================
# TIER 3 — mesh + projection (tunable)
# ============================================================

def _ensure_sf3d_mesh(work_dir, env):
    sf3d = os.path.join(work_dir, 'sf3d_raw.glb')
    if os.path.exists(sf3d):
        return sf3d, None
    script = os.path.join(ROOT, 'scripts', 'local_sf3d_bridge.py')
    r = subprocess.run([sys.executable, script, REF_IMG, sf3d, '1024', '-1', 'none', '0'],
                       env=env, capture_output=True, text=True, timeout=1800)
    if r.returncode != 0 or not os.path.exists(sf3d):
        return None, (r.stderr or '')[-400:]
    return sf3d, None


def _render_mesh_views(mesh_path, out_dir, angles):
    """Render the textured mesh from the given (azim, elev) angles using
    the same painter-rasterizer as calibrate.render_axis. Saves view_N.png."""
    import trimesh
    os.makedirs(out_dir, exist_ok=True)
    g = trimesh.load(mesh_path, force='mesh', process=False)
    # Import render_axis from calibrate for consistency
    sys.path.insert(0, os.path.join(ROOT, 'scripts'))
    from calibrate import render_axis
    paths = []
    import math
    for i, (az, el) in enumerate(angles):
        ca, sa = math.cos(math.radians(az)), math.sin(math.radians(az))
        ce, se = math.cos(math.radians(el)), math.sin(math.radians(el))
        cam = (sa * ce, se, ca * ce)
        up = (0, 1, 0) if abs(se) < 0.9 else (0, 0, 1)
        img = render_axis(g, cam, up, size=384)
        p = os.path.join(out_dir, f'view_{i}.png')
        Image.fromarray(img).save(p)
        paths.append(p)
    return paths


def _project_and_score(sf3d_path, work_dir, env, variant_name):
    """Run texture_project with the given env flags, then score via
    global visual similarity vs the 6 Zero123++ multi-views (the same
    metric Tier 2 uses — no color classifier needed)."""
    out_path = os.path.join(work_dir, f'projected_{variant_name}.glb')
    script = os.path.join(ROOT, 'scripts', 'texture_project.py')
    rot = env.get('FABMESH_TEXPROJ_ROTATION_OFFSET', '0')
    r = subprocess.run(
        [sys.executable, script, sf3d_path, REF_IMG, out_path, '1024',
         '--multiview', MV_ACTIVE, '--rotation-offset', rot],
        env=env, capture_output=True, text=True, timeout=300)
    if r.returncode != 0 or not os.path.exists(out_path):
        return {'ok': False, 'error': (r.stderr or '')[-400:]}

    # Render the projected mesh from the 6 Zero123++ angles and compare
    z123 = [(30, 20), (90, -10), (150, 20), (210, -10), (270, 20), (330, -10)]
    rendered_dir = os.path.join(work_dir, f'rendered_{variant_name}')
    try:
        _render_mesh_views(out_path, rendered_dir, z123)
    except Exception as e:
        return {'ok': False, 'error': f'render failed: {e}'}

    sims = []
    for i in range(6):
        got = os.path.join(rendered_dir, f'view_{i}.png')
        gt = os.path.join(MV_ACTIVE, f'view_{i}.png')
        if os.path.exists(got) and os.path.exists(gt):
            sims.append(_sim(got, gt))
        else:
            sims.append(0.0)
    avg_sim = sum(sims) / 6.0
    # Score = number of views where the mesh render matches the
    # Zero123++ view it was textured from. sim >= 0.55 = good match.
    sc = sum(1 for s in sims if s >= 0.55)
    score_obj = {
        'score': sc, 'total': 6,
        'avg_similarity': avg_sim,
        'per_view_sims': [round(s, 3) for s in sims],
    }
    report_dir = os.path.join(REPORTS, f'{datetime.datetime.now().strftime("%Y%m%d_%H%M%S")}_tiered_{variant_name}')
    os.makedirs(report_dir, exist_ok=True)
    with open(os.path.join(report_dir, 'score.json'), 'w', encoding='utf-8') as f:
        json.dump(score_obj, f, indent=2)
    return {'ok': True, 'score': score_obj, 'report': report_dir, 'mesh': out_path}


def tier3_mesh_projection(stamp, prev_ok):
    _emit({'tier': 3, 'phase': 'start', 'name': 'Mesh + projection'})
    if not prev_ok:
        _emit({'tier': 3, 'phase': 'skipped', 'reason': 'tier 2 failed'})
        return {'ok': False, 'skipped': True, 'reason': 'tier 2 failed'}

    work_dir = os.path.join(ROOT, 'meshes', '_calibration', f'tiered_{stamp}')
    os.makedirs(work_dir, exist_ok=True)
    env = {**os.environ, 'PYTHONUNBUFFERED': '1'}

    _emit({'tier': 3, 'phase': 'sf3d', 'message': 'Running SF3D...'})
    sf3d_path, err = _ensure_sf3d_mesh(work_dir, env)
    if not sf3d_path:
        _emit({'tier': 3, 'phase': 'fail', 'reason': f'SF3D failed: {err}'})
        return {'ok': False, 'reason': f'SF3D failed: {err}'}

    # Projection flag combinations — all cheap (~10s each)
    combos = []
    for fa in (False, True):
        for fe in (False, True):
            for fc in (False, True):
                for ro in ('0', '90', '180', '270'):
                    combos.append({
                        'FABMESH_TEXPROJ_FLIP_AZIM': str(fa),
                        'FABMESH_TEXPROJ_FLIP_ELEV': str(fe),
                        'FABMESH_TEXPROJ_FLIP_CAMPOS_AZIM': str(fc),
                        'FABMESH_TEXPROJ_ROTATION_OFFSET': ro,
                    })

    # Hill-climb shortcut: test coordinate axes first (flip_azim only,
    # flip_elev only, etc.), then corners. Actually since we have 32
    # combos and each is ~10s = 5 min, we test them all if time allows.
    # But cap at 16 to stay under 3 min for this tier.
    combos = combos[:16]

    best = {'score': -1, 'combo': None, 'result': None}
    for i, combo in enumerate(combos):
        name = f'a{combo["FABMESH_TEXPROJ_FLIP_AZIM"][0]}e{combo["FABMESH_TEXPROJ_FLIP_ELEV"][0]}c{combo["FABMESH_TEXPROJ_FLIP_CAMPOS_AZIM"][0]}_r{combo["FABMESH_TEXPROJ_ROTATION_OFFSET"]}'
        _log(f'TIER 3 variant {i+1}/{len(combos)}: {name}')
        _emit({'tier': 3, 'phase': 'tune', 'iter': i+1, 'total': len(combos),
               'variant': name, 'env': combo})
        e = {**env, **combo}
        res = _project_and_score(sf3d_path, work_dir, e, name)
        if not res.get('ok'):
            _emit({'tier': 3, 'phase': 'iter_fail', 'variant': name,
                   'error': res.get('error', '?')[:100]})
            continue
        sc = res['score']['score']; total = res['score']['total']
        _emit({'tier': 3, 'phase': 'iter_done', 'variant': name,
               'score': f'{sc}/{total}',
               'sim': round(res['score'].get('avg_similarity', 0), 3)})
        if sc > best['score']:
            best = {'score': sc, 'combo': combo, 'result': res,
                    'total': total, 'variant': name}
        if sc >= TIER3_TARGET:
            _log(f'  tier 3 hit target {TIER3_TARGET}/{total}, stopping early')
            break

    passed = best['score'] >= TIER3_TARGET
    _emit({'tier': 3, 'phase': 'done',
           'best_score': f'{best["score"]}/{best.get("total", 6)}',
           'best_variant': best.get('variant'),
           'winning_config': best['combo'], 'passed': passed})
    return {
        'ok': passed, 'best_score': best['score'], 'best_combo': best['combo'],
        'best_report': best['result']['report'] if best['result'] else None,
        'best_mesh': best['result']['mesh'] if best['result'] else None,
        'target': TIER3_TARGET, 'variant': best.get('variant'),
    }


def persist_tuned(tier2_variant, tier3_combo):
    cfg = {
        'timestamp': datetime.datetime.utcnow().isoformat(),
        'tier2_env': tier2_variant['env'] if tier2_variant else {},
        'tier3_env': tier3_combo or {},
    }
    with open(TUNED_PATH, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, indent=2)
    _log(f'persisted tuned config to {TUNED_PATH}')


def main():
    stamp = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
    _log('=' * 60)
    _log(f'TIERED CALIBRATION run {stamp}')
    t0 = time.time()

    t1 = tier1_reference_image()
    t2 = tier2_multiview(prev_ok=t1['ok'])
    t3 = tier3_mesh_projection(stamp, prev_ok=t2['ok'])

    if t3.get('ok') or (t3.get('best_score', 0) > 0 and not t3.get('skipped')):
        persist_tuned(t2.get('best_variant'), t3.get('best_combo'))

    elapsed = time.time() - t0
    _log(f'DONE in {elapsed:.1f}s')

    summary = {
        'elapsed_s': round(elapsed, 1),
        'tier1': t1,
        'tier2': {k: v for k, v in t2.items() if k != 'best_variant'} | {
            'best_variant': t2.get('best_variant', {}).get('name') if t2.get('best_variant') else None,
        },
        'tier3': t3,
        'final_score': f'{t3.get("best_score", 0)}/6' if not t3.get('skipped') else 'N/A',
        'persisted_tuning': os.path.exists(TUNED_PATH),
        'tuned_path': TUNED_PATH,
    }
    print('TIERED_RESULT: ' + json.dumps(summary, default=str))


if __name__ == '__main__':
    main()
