"""
Run calibrate.py across all 8 FABMESH_TEXPROJ sign combinations and
build a summary HTML that ranks them.

Reuses the SF3D output (same cube, same ref_0) — only re-projects with
each convention. Takes ~1 minute total.

Usage:  python scripts/_calib_sweep.py
"""
from __future__ import annotations
import os, sys, json, subprocess, datetime, shutil
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPORTS_DIR = os.path.join(ROOT, 'images', '_calibration', 'reports')


def main():
    stamp = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
    sweep_dir = os.path.join(REPORTS_DIR, f'sweep_{stamp}')
    os.makedirs(sweep_dir, exist_ok=True)

    variants = []
    for fa in (False, True):
        for fe in (False, True):
            for fc in (False, True):
                variants.append((fa, fe, fc))

    print(f'[sweep] {len(variants)} variants')
    results = []
    for i, (fa, fe, fc) in enumerate(variants):
        tag = f'a{int(fa)}e{int(fe)}c{int(fc)}'
        print(f'\n[sweep] {i+1}/{len(variants)} variant={tag}')
        cmd = [
            sys.executable, os.path.join(ROOT, 'scripts', 'calibrate.py'),
            '--skip-sf3d',
            '--tag', f'sweep_{tag}',
            '--env', f'FABMESH_TEXPROJ_FLIP_AZIM={fa}',
            '--env', f'FABMESH_TEXPROJ_FLIP_ELEV={fe}',
            '--env', f'FABMESH_TEXPROJ_FLIP_CAMPOS_AZIM={fc}',
        ]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        # Find the generated report dir (by tag)
        matched = [d for d in os.listdir(REPORTS_DIR)
                   if d.endswith(f'sweep_{tag}')]
        if not matched:
            print(f'  FAIL: no report produced\n{r.stderr[-300:]}')
            continue
        report = sorted(matched)[-1]
        report_path = os.path.join(REPORTS_DIR, report)
        score_json = os.path.join(report_path, 'score.json')
        with open(score_json, 'r', encoding='utf-8') as f:
            sc = json.load(f)
        score = sc['score']
        sim = sc['avg_similarity']
        letters = ''.join(r2['got'] if r2['got'] else '?' for r2 in sc['results'])
        print(f'  score={score}/6 sim={sim:.2f} letters={letters}')
        results.append(dict(
            tag=tag, fa=fa, fe=fe, fc=fc,
            score=score, similarity=sim, letters=letters,
            report=report, report_path=report_path,
            details=sc['results'],
        ))

    results.sort(key=lambda r: (-r['score'], -r['similarity']))

    # Build summary HTML
    rows = []
    for r in results:
        best_class = 'best' if r is results[0] else ''
        letters_colored = ''
        expected = 'FBRLTD'
        for exp, got in zip(expected, r['letters']):
            cls = 'ok' if exp == got else 'bad'
            letters_colored += f'<span class="{cls}">{got}</span>'
        rows.append(f"""
        <tr class="{best_class}">
          <td><b>{r['tag']}</b></td>
          <td>azim={r['fa']}<br>elev={r['fe']}<br>cam={r['fc']}</td>
          <td><span class="score">{r['score']}/6</span></td>
          <td>{r['similarity']:.2f}</td>
          <td class="letters">expected: <span class="expected">FBRLTD</span><br>got: {letters_colored}</td>
          <td><a href="../{r['report']}/index.html">report</a></td>
        </tr>""")

    html = f"""<!doctype html><html><head><meta charset="utf-8">
<title>FabMesh Convention Sweep</title>
<style>
body {{ font-family: system-ui; margin: 20px; background: #111; color: #eee; }}
h1 {{ margin-top: 0; }}
table {{ border-collapse: collapse; margin-top: 20px; }}
th, td {{ padding: 10px; border: 1px solid #333; text-align: left; vertical-align: middle; }}
th {{ background: #222; }}
tr.best {{ background: #1a3c1a; font-weight: bold; }}
.score {{ font-size: 1.5em; font-family: monospace; }}
.letters {{ font-family: monospace; font-size: 1.3em; letter-spacing: 4px; }}
.expected {{ color: #888; }}
.ok {{ color: #6f6; }}
.bad {{ color: #f66; }}
a {{ color: #6af; }}
</style>
</head><body>
<h1>FabMesh Convention Sweep</h1>
<p>Tested all 8 combinations of FABMESH_TEXPROJ_{{FLIP_AZIM, FLIP_ELEV, FLIP_CAMPOS_AZIM}}.<br>
Timestamp: {stamp}<br>
Ranked by score, then similarity.</p>
<table>
  <tr><th>Variant</th><th>Flags</th><th>Score</th><th>Similarity</th><th>Letters (F/B/R/L/T/D)</th><th></th></tr>
  {''.join(rows)}
</table>
</body></html>
"""
    out_html = os.path.join(sweep_dir, 'index.html')
    with open(out_html, 'w', encoding='utf-8') as f:
        f.write(html)
    with open(os.path.join(sweep_dir, 'results.json'), 'w', encoding='utf-8') as f:
        json.dump([{k: v for k, v in r.items() if k != 'details'} for r in results], f, indent=2)

    print(f'\n[sweep] BEST: {results[0]["tag"]} score={results[0]["score"]}/6 '
          f'sim={results[0]["similarity"]:.2f}')
    print(f'  flip_azim={results[0]["fa"]} flip_elev={results[0]["fe"]} '
          f'flip_campos={results[0]["fc"]}')
    print(f'\n[sweep] summary: {out_html}')


if __name__ == '__main__':
    main()
