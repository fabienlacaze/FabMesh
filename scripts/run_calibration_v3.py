"""
FabMesh Calibration v3 — orchestrates the 5 per-stage independent checks.

Pipeline:
  Stage 1 — reference image sanity (cheap, ~1s)
  Stage 4 — texture_project determinism (~30s, GPU, no SF3D/Zero123++)
  Stage 2 — multi-view sanity (requires a prior Zero123++ run, ~1s if cached)
  Stage 3 — mesh silhouette IoU (~2s, no GPU)
  Stage 5 — final render similarity (~2s, no GPU)

Stage 4 is run unconditionally — it is the most valuable (deterministic
UV bug detector) and has no upstream dependency.

Stages 2/3/5 are run only if a previously-generated pipeline artifact
exists for a given reference project. Pass --project <stem> and we look
for images/<stem>/<stem>_multiview/, meshes/<stem>_sf3d_*.glb, etc.

Emits one JSON line per stage for UI streaming:
  STAGE_JSON: {"stage": 1, "ok": true, "score": 0.82, ...}

Final line:
  CALIB_RESULT: {"stages": [...], "summary": {...}}

Writes persistent baselines to .fabmesh/calib_baselines.json on every
successful run (full 5/5). Future runs flag regressions (>5% drop).

Usage:
  python scripts/run_calibration_v3.py                       # stage 4 only (fastest)
  python scripts/run_calibration_v3.py --ref PATH --mv DIR --mesh GLB
"""
from __future__ import annotations
import os, sys, json, argparse, datetime, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from calib.stage_checks import (
    check_stage1_ref_image,
    check_stage2_multiview,
    check_stage3_mesh_silhouette,
    check_stage4_projection,
    check_stage5_final,
    ROOT,
)

BASELINE_PATH = os.path.join(ROOT, '.fabmesh', 'calib_baselines.json')
LOG_PATH = os.path.join(ROOT, 'logs', 'fabmesh.log')


def _emit(obj):
    print('STAGE_JSON: ' + json.dumps(obj, default=str), flush=True)


def _log(msg):
    ts = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.') + f'{datetime.datetime.utcnow().microsecond//1000:03d}Z'
    line = f'{ts} [INFO] [calib-v3] {msg}\n'
    try:
        with open(LOG_PATH, 'a', encoding='utf-8') as f:
            f.write(line)
    except Exception:
        pass
    print(f'[calib-v3] {msg}', flush=True)


def _load_baselines():
    if os.path.exists(BASELINE_PATH):
        try:
            with open(BASELINE_PATH, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def _save_baselines(scores):
    os.makedirs(os.path.dirname(BASELINE_PATH), exist_ok=True)
    existing = _load_baselines()
    existing.update({
        'updated': datetime.datetime.utcnow().isoformat(),
        'scores': scores,
    })
    with open(BASELINE_PATH, 'w', encoding='utf-8') as f:
        json.dump(existing, f, indent=2)


def _compare_baseline(stage_num, score):
    bl = _load_baselines().get('scores', {})
    prev = bl.get(str(stage_num))
    if prev is None:
        return {'baseline': None, 'regression': False}
    drop = prev - score
    return {'baseline': round(prev, 3), 'delta': round(score - prev, 3),
            'regression': drop > 0.05}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ref', help='Reference image (triggers stages 1,2,3,5)')
    ap.add_argument('--mv-dir', help='Multi-view dir (stage 2)')
    ap.add_argument('--mesh', help='Mesh GLB (stages 3,5)')
    ap.add_argument('--skip-stage4', action='store_true',
                    help='Skip the deterministic stage-4 test (save ~30s)')
    ap.add_argument('--work-dir', default=os.path.join(ROOT, 'logs', 'calib_v3'))
    args = ap.parse_args()
    os.makedirs(args.work_dir, exist_ok=True)

    _log('=' * 60)
    _log(f'CALIBRATION v3 run')
    t0 = time.time()
    results = []

    # Stage 1 — ref image
    if args.ref:
        _emit({'stage': 1, 'phase': 'start'})
        r = check_stage1_ref_image(args.ref)
        _log(f'Stage 1: {r["ok"]} score={r["score"]:.2f}')
        r['baseline_cmp'] = _compare_baseline(1, r['score'])
        _emit(r)
        results.append(r)

    # Stage 4 — deterministic projection (no upstream dep)
    if not args.skip_stage4:
        _emit({'stage': 4, 'phase': 'start'})
        stage4_dir = os.path.join(args.work_dir, 'stage4')
        r = check_stage4_projection(stage4_dir)
        _log(f'Stage 4: {r["ok"]} score={r["score"]:.2f} correct={r["details"].get("correct")}/6')
        r['baseline_cmp'] = _compare_baseline(4, r['score'])
        _emit(r)
        results.append(r)

    # Stage 2 — multi-view sanity
    if args.ref and args.mv_dir and os.path.isdir(args.mv_dir):
        _emit({'stage': 2, 'phase': 'start'})
        r = check_stage2_multiview(args.mv_dir, args.ref)
        _log(f'Stage 2: {r["ok"]} score={r["score"]:.2f}')
        r['baseline_cmp'] = _compare_baseline(2, r['score'])
        _emit(r)
        results.append(r)

    # Stage 3 — mesh silhouette IoU
    if args.ref and args.mesh and os.path.exists(args.mesh):
        _emit({'stage': 3, 'phase': 'start'})
        r = check_stage3_mesh_silhouette(args.mesh, args.ref)
        _log(f'Stage 3: {r["ok"]} score={r["score"]:.2f}')
        r['baseline_cmp'] = _compare_baseline(3, r['score'])
        _emit(r)
        results.append(r)

    # Stage 5 — final render
    if args.ref and args.mesh and os.path.exists(args.mesh):
        _emit({'stage': 5, 'phase': 'start'})
        r = check_stage5_final(args.mesh, args.ref)
        _log(f'Stage 5: {r["ok"]} score={r["score"]:.2f}')
        r['baseline_cmp'] = _compare_baseline(5, r['score'])
        _emit(r)
        results.append(r)

    elapsed = time.time() - t0
    all_ok = all(r['ok'] for r in results) and len(results) > 0
    any_regression = any(r.get('baseline_cmp', {}).get('regression') for r in results)

    # Persist baselines on full-pass runs
    if all_ok:
        _save_baselines({str(r['stage']): r['score'] for r in results})
        _log(f'baselines updated -> {BASELINE_PATH}')

    summary = {
        'elapsed_s': round(elapsed, 1),
        'stages_run': len(results),
        'all_ok': all_ok,
        'any_regression': any_regression,
        'per_stage': [
            {'stage': r['stage'], 'name': r['name'], 'ok': r['ok'],
             'score': round(r['score'], 3),
             'regression': r.get('baseline_cmp', {}).get('regression', False)}
            for r in results
        ],
    }
    _log(f'DONE in {elapsed:.1f}s — all_ok={all_ok} regression={any_regression}')
    print('CALIB_RESULT: ' + json.dumps({'summary': summary, 'stages': results}, default=str))
    return 0 if all_ok and not any_regression else 1


if __name__ == '__main__':
    sys.exit(main())
