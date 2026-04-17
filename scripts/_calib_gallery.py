"""
Build a visual gallery of all calibration runs.

Collects every projected_*.glb in meshes/_calibration/, pulls the
matching report from images/_calibration/reports/, and writes an
index.html with:
  - a <model-viewer> 3D preview of each mesh (click-drag to rotate)
  - the 6 axis renders side-by-side
  - the score and convention flags
  - a link to the full report

Usage:  python scripts/_calib_gallery.py
Output: images/_calibration/gallery.html
"""
from __future__ import annotations
import os, json, glob
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MESH_DIR = ROOT / 'meshes' / '_calibration'
REPORT_DIR = ROOT / 'images' / '_calibration' / 'reports'
OUT_HTML = ROOT / 'images' / '_calibration' / 'gallery.html'


def gather():
    """Return list of (mesh_path, report_dir, score_data)."""
    items = []
    # Collect all report dirs that have score.json
    reports = {}
    for rdir in REPORT_DIR.iterdir():
        if rdir.is_dir():
            sj = rdir / 'score.json'
            if sj.exists():
                try:
                    with open(sj, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                    reports[Path(data['mesh']).name] = (rdir, data)
                except Exception:
                    pass
    # Pair with GLBs
    for glb in sorted(MESH_DIR.glob('*.glb')):
        name = glb.name
        if name in reports:
            rdir, data = reports[name]
            items.append((glb, rdir, data))
        else:
            items.append((glb, None, None))
    return items


def build_card(glb, rdir, data, idx):
    rel_glb = os.path.relpath(glb, OUT_HTML.parent).replace('\\', '/')
    score_html = ''
    axes_html = ''
    if data:
        score = data['score']
        total = data['total']
        sim = data['avg_similarity']
        cls = 'high' if score >= 5 else 'mid' if score >= 3 else 'low'
        score_html = (f'<span class="score {cls}">{score}/{total}</span>'
                      f'<span class="sim">sim {sim:.2f}</span>')
        rel_report = os.path.relpath(rdir, OUT_HTML.parent).replace('\\', '/')
        cells = []
        for r in data['results']:
            img = os.path.relpath(rdir / r['got_img'], OUT_HTML.parent).replace('\\', '/')
            gt = r.get('gt_img', '').replace('..\\', '').replace('..//', '')
            mark = 'ok' if r['correct'] else 'bad'
            cells.append(f'''
              <div class="axcell {mark}">
                <img src="{img}" loading="lazy">
                <div class="ax-label">{r['axis']}<br>
                  <span class="letters">{r['expected']}&rarr;{r['got']}</span></div>
              </div>''')
        axes_html = f'<div class="axes-row">{"".join(cells)}</div>'
        axes_html += f'<a class="report-link" href="{rel_report}/index.html" target="_blank">Full report</a>'
    else:
        score_html = '<span class="score no-score">no report</span>'

    return f'''
    <div class="card">
      <div class="card-head">
        <h3>{glb.name}</h3>
        {score_html}
      </div>
      <model-viewer src="{rel_glb}" camera-controls auto-rotate
        style="width: 100%; height: 320px; background: #222"
        exposure="1" shadow-intensity="1"
        camera-orbit="30deg 70deg auto"></model-viewer>
      {axes_html}
    </div>
    '''


def main():
    items = gather()
    # Sort: highest score first, then name
    def sort_key(it):
        _, _, d = it
        if d: return (-d['score'], -d['avg_similarity'])
        return (999, 999)
    items.sort(key=sort_key)

    cards = [build_card(g, r, d, i) for i, (g, r, d) in enumerate(items)]

    html = f'''<!doctype html><html><head><meta charset="utf-8">
<title>FabMesh Calibration Gallery</title>
<script type="module" src="https://unpkg.com/@google/model-viewer@3/dist/model-viewer.min.js"></script>
<style>
body {{ font-family: system-ui, sans-serif; margin: 0; padding: 16px;
       background: #0a0a0a; color: #eee; }}
h1 {{ margin: 0 0 16px; }}
.intro {{ max-width: 900px; color: #aaa; margin-bottom: 24px; }}
.intro code {{ background: #222; padding: 2px 6px; border-radius: 3px; }}
.grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 16px; }}
.card {{ background: #161616; border: 1px solid #333; border-radius: 8px;
        padding: 12px; }}
.card-head {{ display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }}
.card-head h3 {{ margin: 0; font-size: 0.9em; font-family: monospace; color: #9cf;
                 overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }}
.score {{ padding: 4px 10px; border-radius: 4px; font-weight: bold; font-size: 1.1em; }}
.score.high {{ background: #1a5c1a; }}
.score.mid {{ background: #8a6a1a; }}
.score.low {{ background: #8a1a1a; }}
.score.no-score {{ background: #333; color: #888; font-weight: normal; }}
.sim {{ color: #888; margin-left: 8px; font-size: 0.85em; }}
model-viewer {{ border-radius: 6px; margin: 8px 0; }}
.axes-row {{ display: grid; grid-template-columns: repeat(6, 1fr); gap: 4px;
            margin-top: 8px; }}
.axcell {{ position: relative; border-radius: 4px; overflow: hidden; }}
.axcell img {{ width: 100%; display: block; background: #fff; }}
.axcell.ok {{ outline: 2px solid #3a3; }}
.axcell.bad {{ outline: 2px solid #c33; }}
.ax-label {{ position: absolute; bottom: 0; left: 0; right: 0;
             background: rgba(0,0,0,0.75); padding: 2px 4px; font-size: 0.7em;
             text-align: center; line-height: 1.1; }}
.letters {{ font-family: monospace; font-weight: bold; }}
.report-link {{ display: inline-block; margin-top: 8px; color: #6af;
                font-size: 0.85em; }}
</style>
</head><body>
<h1>FabMesh Calibration Gallery</h1>
<p class="intro">
All meshes in <code>meshes/_calibration/</code> with their scoring reports.
Drag the 3D previews to rotate. The 6 small images under each mesh are the
rendered axis views (expected &rarr; got per face). Green border = face
correctly identified, red = misaligned.
</p>
<div class="grid">
  {''.join(cards)}
</div>
</body></html>
'''
    with open(OUT_HTML, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f'[gallery] wrote {OUT_HTML}')
    print(f'[gallery] {len(items)} meshes, {sum(1 for _,_,d in items if d)} with reports')
    print(f'[gallery] open: file:///{str(OUT_HTML).replace(chr(92),"/")}')


if __name__ == '__main__':
    main()
