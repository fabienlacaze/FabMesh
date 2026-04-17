"""
Automatic pipeline diagnosis for the FabMesh calibration cube.

Runs the pipeline step-by-step and scores each stage independently:
  Stage 1: SF3D mesh (raw, before multi-view projection)
  Stage 2: Zero123++ multi-views (compared to ground-truth multi-views)
  Stage 3: texture_project result (final mesh)

Emits a verdict: which stage is primarily responsible for the score loss
and what the most-probable fix is.

Writes:
  images/_calibration/reports/diagnose_<timestamp>/
    stage1_sf3d.json
    stage2_mv.json
    stage3_projected.json
    diagnose.html        — single-page report with per-stage scores
                           and the verdict
    verdict.json         — machine-readable conclusion

Usage:  python scripts/_calib_diagnose.py
"""
from __future__ import annotations
import os, sys, json, subprocess, datetime, shutil, time, platform
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGS_DIR = os.path.join(ROOT, 'logs')
os.makedirs(LOGS_DIR, exist_ok=True)
CALIB_LOG = os.path.join(LOGS_DIR, 'calibration.log')


class CalibLogger:
    """Detailed calibration logger. Writes to logs/calibration.log AND
    echoes to stdout so the UI/API can stream progress. Includes:
      - timestamped events
      - per-stage durations
      - GPU memory snapshots
      - image/file sizes
      - subprocess stderr captured on failure
    """
    def __init__(self, run_id):
        self.run_id = run_id
        self.t0 = time.time()
        self.stage_t = None
        self.stage_name = None
        self.fh = open(CALIB_LOG, 'a', encoding='utf-8', buffering=1)
        self._banner()

    def _banner(self):
        self._raw(f'\n{"=" * 72}')
        self._raw(f'RUN {self.run_id}  started {datetime.datetime.now().isoformat(timespec="seconds")}')
        self._raw(f'Python {sys.version.split()[0]} · {platform.platform()}')
        try:
            import torch
            if torch.cuda.is_available():
                gm = torch.cuda.get_device_properties(0).total_memory / (1024**3)
                self._raw(f'GPU: {torch.cuda.get_device_name(0)} ({gm:.1f} GB)')
        except Exception: pass
        self._raw('=' * 72)

    def _raw(self, s):
        line = s if not s or s.startswith('=') or s.startswith('\n') else f'[{time.time()-self.t0:6.1f}s] {s}'
        print(line, flush=True)
        try: self.fh.write(line + '\n')
        except Exception: pass

    def info(self, msg, **kv):
        extra = ''
        if kv:
            extra = ' ' + ' '.join(f'{k}={v}' for k, v in kv.items())
        self._raw(f'  {msg}{extra}')

    def stage_start(self, name):
        self.stage_name = name
        self.stage_t = time.time()
        self._raw(f'\n--- STAGE: {name} ---')

    def stage_end(self, result=None, ok=True):
        if self.stage_t is None: return
        dt = time.time() - self.stage_t
        tag = 'OK' if ok else 'FAIL'
        extra = ''
        if result:
            extra = ' ' + ' '.join(f'{k}={v}' for k, v in result.items())
        self._raw(f'--- {self.stage_name} {tag} in {dt:.1f}s{extra} ---')
        self.stage_t = None
        self.stage_name = None

    def subprocess_result(self, r, label):
        self.info(f'{label} returncode={r.returncode}')
        if r.returncode != 0:
            tail = (r.stderr or '')[-800:]
            self._raw('  stderr tail:')
            for line in tail.splitlines()[-20:]:
                self._raw(f'    | {line}')

    def file_stat(self, path, label=''):
        if not os.path.exists(path):
            self.info(f'{label or path}: MISSING')
            return
        try:
            sz = os.path.getsize(path)
            if path.lower().endswith(('.png', '.jpg', '.jpeg')):
                try:
                    im = Image.open(path)
                    self.info(f'{label or os.path.basename(path)} size={sz}B dim={im.size} mode={im.mode}')
                    return
                except Exception: pass
            self.info(f'{label or os.path.basename(path)} size={sz}B')
        except Exception as e:
            self.info(f'{label or path}: stat failed ({e})')

    def close(self, summary=None):
        total = time.time() - self.t0
        self._raw(f'\nRUN {self.run_id} done in {total:.1f}s')
        if summary:
            self._raw('SUMMARY: ' + json.dumps(summary))
        try: self.fh.close()
        except Exception: pass



CALIB_DIR = os.path.join(ROOT, 'images', '_calibration')
# Which calibration target? Prefer the Rubik's Cube (in-distribution
# for SF3D) over the hand-painted cube (which is out-of-distribution).
_USE_RUBIKS = os.environ.get('FABMESH_CALIB_TARGET', 'rubiks') == 'rubiks'
if _USE_RUBIKS and os.path.exists(os.path.join(CALIB_DIR, 'ref_rubiks.png')):
    REF_IMG = os.path.join(CALIB_DIR, 'ref_rubiks.png')
    GT_AXES_DIR = os.path.join(CALIB_DIR, 'ref_rubiks_axes_perfect')
    GT_MV_DIR = os.path.join(CALIB_DIR, 'ref_rubiks_multiview_perfect')
    MV_DIR_ACTIVE = os.path.join(CALIB_DIR, 'ref_rubiks_multiview')
else:
    REF_IMG = os.path.join(CALIB_DIR, 'ref_0.png')
    GT_AXES_DIR = os.path.join(CALIB_DIR, 'ref_0_perfect_axes')
    GT_MV_DIR = os.path.join(CALIB_DIR, 'ref_0_multiview_perfect')
    MV_DIR_ACTIVE = os.path.join(CALIB_DIR, 'ref_0_multiview')
REPORTS_DIR = os.path.join(CALIB_DIR, 'reports')


def _sim(a_path, b_path, size=384):
    """Center-region color similarity (0..1)."""
    a = np.asarray(Image.open(a_path).convert('RGB').resize((size, size), Image.LANCZOS)).astype(float)
    b = np.asarray(Image.open(b_path).convert('RGB').resize((size, size), Image.LANCZOS)).astype(float)
    m0, m1 = int(size * 0.2), int(size * 0.8)
    diff = np.linalg.norm(a[m0:m1, m0:m1] - b[m0:m1, m0:m1], axis=2)
    return float(1.0 - diff.mean() / 441.0)


def stage1_sf3d(work_dir, env, logger):
    logger.stage_start('SF3D mesh reconstruction')
    logger.file_stat(REF_IMG, 'input image')
    sf3d_path = os.path.join(work_dir, 'sf3d_raw.glb')
    if not os.path.exists(sf3d_path):
        sf3d_script = os.path.join(ROOT, 'scripts', 'local_sf3d_bridge.py')
        logger.info(f'invoking local_sf3d_bridge.py -> {sf3d_path}')
        r = subprocess.run(
            [sys.executable, sf3d_script, REF_IMG, sf3d_path, '1024', '-1', 'none', '0'],
            env=env, capture_output=True, text=True, timeout=1800)
        logger.subprocess_result(r, 'SF3D')
        if r.returncode != 0 or not os.path.exists(sf3d_path):
            logger.stage_end(ok=False)
            return {'ok': False, 'error': r.stderr[-400:]}
    else:
        logger.info('sf3d_raw.glb already exists, skipping reconstruction')
    logger.file_stat(sf3d_path, 'SF3D output mesh')
    tag = 'diag_stage1'
    logger.info(f'scoring with calibrate.py --tag {tag}')
    r = subprocess.run(
        [sys.executable, os.path.join(ROOT, 'scripts', 'calibrate.py'),
         '--mesh', sf3d_path, '--tag', tag],
        env=env, capture_output=True, text=True, timeout=300)
    logger.subprocess_result(r, 'calibrate.py')
    dirs = sorted([d for d in os.listdir(REPORTS_DIR) if d.endswith('_' + tag)])
    if not dirs:
        logger.stage_end(ok=False)
        return {'ok': False, 'error': 'no report produced', 'stdout': r.stdout[-500:]}
    rd = os.path.join(REPORTS_DIR, dirs[-1])
    with open(os.path.join(rd, 'score.json'), 'r', encoding='utf-8') as f:
        score = json.load(f)
    for face in score.get('results', []):
        logger.info(f"  face {face['axis']:6s} expected={face['expected']} got={face['got']} "
                    f"ok={face['correct']} sim={face.get('similarity',0):.2f}")
    logger.stage_end(result={'score': f"{score['score']}/{score['total']}",
                             'avg_sim': f"{score.get('avg_similarity',0):.2f}"})
    return {'ok': True, 'mesh': sf3d_path, 'report': rd, 'score': score}


def stage2_multiview(env, logger):
    logger.stage_start('Zero123++ multi-views')
    logger.info(f'active dir: {MV_DIR_ACTIVE}')
    if not os.path.exists(os.path.join(MV_DIR_ACTIVE, 'view_0.png')):
        os.makedirs(MV_DIR_ACTIVE, exist_ok=True)
        mv_script = os.path.join(ROOT, 'scripts', 'multiview_gen.py')
        logger.info(f'invoking multiview_gen.py {REF_IMG} -> {MV_DIR_ACTIVE}')
        r = subprocess.run(
            [sys.executable, mv_script, REF_IMG, MV_DIR_ACTIVE],
            env=env, capture_output=True, text=True, timeout=600)
        logger.subprocess_result(r, 'multiview_gen')
        if r.returncode != 0:
            logger.stage_end(ok=False)
            return {'ok': False, 'error': r.stderr[-400:]}
    else:
        logger.info('multi-views already generated, skipping')
    views = []
    for i in range(6):
        got = os.path.join(MV_DIR_ACTIVE, f'view_{i}.png')
        gt = os.path.join(GT_MV_DIR, f'view_{i}.png')
        if not (os.path.exists(got) and os.path.exists(gt)):
            logger.info(f'  view_{i}: MISSING (got={os.path.exists(got)} gt={os.path.exists(gt)})')
            views.append({'i': i, 'similarity': 0.0, 'ok': False})
            continue
        sim = _sim(got, gt)
        logger.info(f'  view_{i} similarity {sim:.3f} {"ok" if sim > 0.7 else "low"}')
        views.append({'i': i, 'similarity': sim, 'ok': sim > 0.7})
    avg = sum(v['similarity'] for v in views) / max(1, len(views))
    good = sum(1 for v in views if v['ok'])
    logger.stage_end(result={'good_views': f"{good}/{len(views)}", 'avg_sim': f"{avg:.3f}"})
    return {'ok': True, 'views': views, 'avg_similarity': avg,
            'good_views': good, 'total': len(views)}


def stage3_projected(sf3d_path, work_dir, env, logger):
    logger.stage_start('texture_project')
    out_path = os.path.join(work_dir, 'projected.glb')
    proj_script = os.path.join(ROOT, 'scripts', 'texture_project.py')
    logger.info(f'projecting mv -> {out_path}')
    r = subprocess.run(
        [sys.executable, proj_script, sf3d_path, REF_IMG, out_path, '1024',
         '--multiview', MV_DIR_ACTIVE],
        env=env, capture_output=True, text=True, timeout=300)
    logger.subprocess_result(r, 'texture_project')
    if r.returncode != 0 or not os.path.exists(out_path):
        logger.stage_end(ok=False)
        return {'ok': False, 'error': r.stderr[-400:]}
    logger.file_stat(out_path, 'projected mesh')
    tag = 'diag_stage3'
    r = subprocess.run(
        [sys.executable, os.path.join(ROOT, 'scripts', 'calibrate.py'),
         '--mesh', out_path, '--tag', tag],
        env=env, capture_output=True, text=True, timeout=300)
    logger.subprocess_result(r, 'calibrate.py')
    dirs = sorted([d for d in os.listdir(REPORTS_DIR) if d.endswith('_' + tag)])
    if not dirs:
        logger.stage_end(ok=False)
        return {'ok': False, 'error': 'no report produced'}
    rd = os.path.join(REPORTS_DIR, dirs[-1])
    with open(os.path.join(rd, 'score.json'), 'r', encoding='utf-8') as f:
        score = json.load(f)
    for face in score.get('results', []):
        logger.info(f"  face {face['axis']:6s} expected={face['expected']} got={face['got']} "
                    f"ok={face['correct']} sim={face.get('similarity',0):.2f}")
    logger.stage_end(result={'score': f"{score['score']}/{score['total']}"})
    return {'ok': True, 'mesh': out_path, 'report': rd, 'score': score}


def build_verdict(s1, s2, s3):
    """Pick the stage most responsible for the score loss and propose
    the most likely fix."""
    verdict = {
        'stage1_sf3d_score': None, 'stage2_mv_similarity': None,
        'stage3_final_score': None,
        'primary_cause': 'unknown', 'recommendation': '',
        'details': []
    }
    if s1.get('ok'):
        s1_score = s1['score']['score']
        verdict['stage1_sf3d_score'] = f"{s1_score}/6"
        verdict['details'].append(f'SF3D raw mesh: {s1_score}/6 faces correctly placed')
    if s2.get('ok'):
        verdict['stage2_mv_similarity'] = f"{s2['good_views']}/{s2['total']}"
        verdict['details'].append(
            f"Zero123++ views: {s2['good_views']}/{s2['total']} close to ground truth "
            f"(avg sim {s2['avg_similarity']:.2f})")
    if s3.get('ok'):
        s3_score = s3['score']['score']
        verdict['stage3_final_score'] = f"{s3_score}/6"
        verdict['details'].append(f'Final projected mesh: {s3_score}/6 faces correct')

    # Primary cause: the earliest stage that already fails badly.
    if s1.get('ok') and s1['score']['score'] <= 2:
        verdict['primary_cause'] = 'sf3d'
        verdict['recommendation'] = (
            'SF3D itself produces a mesh where <3 of 6 faces end up on the '
            'correct axis. The calibration cube (stylized, flat colors) may '
            'be out-of-distribution for SF3D (trained on Objaverse photos). '
            'Suggested fix: test with a realistic photo input; or try TripoSG '
            '(scripts/local_triposg_bridge.py) to isolate whether the mesh '
            'reconstruction or the texture output is the problem.')
    elif s2.get('ok') and s2['good_views'] <= 2:
        verdict['primary_cause'] = 'zero123'
        verdict['recommendation'] = (
            'Zero123++ hallucinates the back/sides very differently from '
            'ground truth. The flat-colored cube is not well-constrained '
            'for the model. Suggested fix: add a guidance image (IPAdapter) '
            'or use a realistic photo as input; the pipeline is fine for '
            'natural photos.')
    elif s3.get('ok') and s1.get('ok'):
        drop = s1['score']['score'] - s3['score']['score']
        if drop >= 2:
            verdict['primary_cause'] = 'projection'
            verdict['recommendation'] = (
                f'texture_project degraded the mesh by {drop} points. '
                'Likely an axis/rotation convention mismatch between SF3D '
                'output frame and the projection camera frame. Fix: sweep '
                'the FABMESH_TEXPROJ_FLIP_* env flags (scripts/_calib_sweep.py).')
        else:
            verdict['primary_cause'] = 'none_clear'
            verdict['recommendation'] = (
                'All stages degrade uniformly — no single culprit. Likely '
                'the calibration cube is simply a hard input for the whole '
                'pipeline (stylized geometry + flat textures). Try a '
                'realistic image and compare.')
    elif s3.get('ok'):
        verdict['primary_cause'] = 'projection_or_sf3d'
        verdict['recommendation'] = (
            'Could not isolate: SF3D raw stage did not produce a comparable '
            'score. Check individual stage reports.')
    return verdict


def write_report(report_dir, s1, s2, s3, verdict):
    os.makedirs(report_dir, exist_ok=True)
    with open(os.path.join(report_dir, 'stage1_sf3d.json'), 'w') as f:
        json.dump(s1, f, indent=2, default=str)
    with open(os.path.join(report_dir, 'stage2_mv.json'), 'w') as f:
        json.dump(s2, f, indent=2, default=str)
    with open(os.path.join(report_dir, 'stage3_projected.json'), 'w') as f:
        json.dump(s3, f, indent=2, default=str)
    with open(os.path.join(report_dir, 'verdict.json'), 'w') as f:
        json.dump(verdict, f, indent=2)

    def stage_card(title, data, color_ok):
        if not data or not data.get('ok'):
            err = (data or {}).get('error', 'not run')
            return f'<div class="stage-card" style="border-color:#633;"><h3>{title}</h3><p style="color:#f66">Failed: {err[:200]}</p></div>'
        body = ''
        if 'score' in data:
            s = data['score']['score']; t = data['score']['total']
            body = f'<div class="big-score" style="background:{color_ok if s >= 4 else "#8a6a1a" if s >= 2 else "#8a1a1a"}">{s}/{t}</div>'
            body += f'<p>sim {data["score"].get("avg_similarity", 0):.2f}</p>'
        elif 'avg_similarity' in data:
            s = data['good_views']; t = data['total']
            body = f'<div class="big-score" style="background:{color_ok if s >= 4 else "#8a6a1a" if s >= 2 else "#8a1a1a"}">{s}/{t}</div>'
            body += f'<p>avg similarity {data["avg_similarity"]:.2f}</p>'
        link = ''
        if data.get('report'):
            rel = os.path.relpath(data['report'], report_dir).replace('\\', '/')
            link = f'<p><a href="{rel}/index.html">full report</a></p>'
        return f'<div class="stage-card"><h3>{title}</h3>{body}{link}</div>'

    vc = {'sf3d': '#cc3', 'zero123': '#c60', 'projection': '#c36',
          'none_clear': '#888', 'unknown': '#555'}.get(verdict['primary_cause'], '#555')

    html = f'''<!doctype html><html><head><meta charset="utf-8">
<title>FabMesh Auto-Diagnosis</title>
<style>
body {{ font-family: system-ui; margin: 20px; background: #0a0a0a; color: #eee; }}
h1 {{ margin-top: 0; }}
.stages {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin: 20px 0; }}
.stage-card {{ background: #161616; border: 2px solid #333; border-radius: 8px;
              padding: 16px; text-align: center; }}
.stage-card h3 {{ margin: 0 0 10px; color: #9cf; }}
.big-score {{ display: inline-block; padding: 12px 24px; border-radius: 8px;
             font-size: 2.5em; font-weight: bold; color: #fff; margin: 6px 0; }}
.verdict {{ border-left: 6px solid {vc}; padding: 16px 20px; background: #1a1a1a;
           border-radius: 0 8px 8px 0; margin-top: 20px; }}
.verdict h2 {{ margin: 0 0 10px; color: {vc}; }}
.verdict .cause-tag {{ display: inline-block; background: {vc}; color: #000;
                      padding: 2px 10px; border-radius: 3px; font-weight: bold;
                      text-transform: uppercase; font-size: 0.8em; }}
.verdict ul {{ margin: 10px 0; line-height: 1.6; }}
.verdict code {{ background: #222; padding: 2px 6px; border-radius: 3px; }}
a {{ color: #6af; }}
</style></head><body>
<h1>FabMesh Pipeline Auto-Diagnosis</h1>
<p style="color:#aaa">Runs the 3 stages independently, scores each, and identifies which one is responsible for the score loss.</p>
<div class="stages">
  {stage_card('1. SF3D raw mesh', s1, '#1a5c1a')}
  {stage_card('2. Zero123++ views', s2, '#1a5c1a')}
  {stage_card('3. Projected mesh', s3, '#1a5c1a')}
</div>
<div class="verdict">
  <h2>Verdict <span class="cause-tag">{verdict['primary_cause']}</span></h2>
  <ul>
    {''.join(f'<li>{d}</li>' for d in verdict['details'])}
  </ul>
  <p><b>Recommendation:</b></p>
  <p>{verdict['recommendation']}</p>
</div>
</body></html>
'''
    out = os.path.join(report_dir, 'diagnose.html')
    with open(out, 'w', encoding='utf-8') as f:
        f.write(html)
    return out


def main():
    stamp = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
    work_dir = os.path.join(ROOT, 'meshes', '_calibration', f'diagnose_{stamp}')
    os.makedirs(work_dir, exist_ok=True)
    report_dir = os.path.join(REPORTS_DIR, f'diagnose_{stamp}')

    env = dict(os.environ)
    env['PYTHONUNBUFFERED'] = '1'

    logger = CalibLogger(stamp)
    logger.info(f'calibration target: {"rubiks" if _USE_RUBIKS else "painted cube"}')
    logger.info(f'ref image: {REF_IMG}')
    logger.info(f'work dir:  {work_dir}')
    logger.info(f'report dir: {report_dir}')

    s1 = stage1_sf3d(work_dir, env, logger)
    s2 = stage2_multiview(env, logger)
    sf3d_path = s1.get('mesh') if s1.get('ok') else None
    s3 = stage3_projected(sf3d_path, work_dir, env, logger) if sf3d_path else {'ok': False, 'error': 'skipped: SF3D failed'}

    verdict = build_verdict(s1, s2, s3)
    html = write_report(report_dir, s1, s2, s3, verdict)

    # Print summary
    print('\n=== DIAGNOSIS ===')
    for d in verdict['details']:
        print(' -', d)
    print(f'\nPRIMARY CAUSE: {verdict["primary_cause"]}')
    print(f'RECOMMENDATION: {verdict["recommendation"]}')
    print(f'\nReport: {html}')
    # Also emit a machine-parseable line for the UI/API
    summary = {
        'primary_cause': verdict['primary_cause'],
        'stage1': verdict.get('stage1_sf3d_score'),
        'stage2': verdict.get('stage2_mv_similarity'),
        'stage3': verdict.get('stage3_final_score'),
        'report_html': html,
        'report_dir': report_dir,
        'recommendation': verdict['recommendation'],
        'log_file': CALIB_LOG,
    }
    logger.close(summary)
    print('DIAGNOSE_JSON:', json.dumps(summary))


if __name__ == '__main__':
    main()
