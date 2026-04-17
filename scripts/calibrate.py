"""
Calibration scorecard for the FabMesh pipeline.

Runs the full pipeline on the calibration cube reference, renders 6 axis
views of the result, compares them to ground-truth views, and produces
an HTML report showing expected vs got per face with a score.

Usage:
  python scripts/calibrate.py                       # full pipeline
  python scripts/calibrate.py --mesh PATH.glb       # analyze existing mesh
  python scripts/calibrate.py --skip-sf3d           # re-project only
  python scripts/calibrate.py --env FABMESH_TEXPROJ_FLIP_AZIM=True
                                                    # test convention

Outputs:
  images/_calibration/reports/YYYYMMDD_HHMMSS/
    index.html            side-by-side view
    got_<axis>.png        each rendered axis view
    score.json            machine-readable result
"""
from __future__ import annotations
import os, sys, json, time, argparse, subprocess, shutil, datetime
import numpy as np
from PIL import Image
import trimesh

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CALIB_DIR = os.path.join(ROOT, 'images', '_calibration')
_USE_RUBIKS = os.environ.get('FABMESH_CALIB_TARGET', 'rubiks') == 'rubiks'
if _USE_RUBIKS and os.path.exists(os.path.join(CALIB_DIR, 'ref_rubiks.png')):
    GT_AXES_DIR = os.path.join(CALIB_DIR, 'ref_rubiks_axes_perfect')
    REF_IMG = os.path.join(CALIB_DIR, 'ref_rubiks.png')
    MV_DIR_PERFECT = os.path.join(CALIB_DIR, 'ref_rubiks_multiview_perfect')
    MV_DIR_ACTIVE = os.path.join(CALIB_DIR, 'ref_rubiks_multiview')
else:
    GT_AXES_DIR = os.path.join(CALIB_DIR, 'ref_0_perfect_axes')
    REF_IMG = os.path.join(CALIB_DIR, 'ref_0.png')
    MV_DIR_PERFECT = os.path.join(CALIB_DIR, 'ref_0_multiview_perfect')
    MV_DIR_ACTIVE = os.path.join(CALIB_DIR, 'ref_0_multiview')
REPORTS_DIR = os.path.join(CALIB_DIR, 'reports')

AXES = [
    ('front',  (0, 0, 1),  (0, 1, 0),  'F', 'FRONT red/white stripes'),
    ('back',   (0, 0, -1), (0, 1, 0),  'B', 'BACK blue/red B'),
    ('right',  (1, 0, 0),  (0, 1, 0),  'R', 'RIGHT beige/green R'),
    ('left',   (-1, 0, 0), (0, 1, 0),  'L', 'LEFT magenta/green L'),
    ('top',    (0, 1, 0),  (0, 0, 1),  'T', 'TOP cream/red T'),
    ('bottom', (0, -1, 0), (0, 0, -1), 'D', 'BOT red/blue B'),
]

# Dominant color sample from each painted face (for classification)
FACE_COLOR = {
    'F': (200, 40, 40),    # red dominant
    'B': (40, 70, 200),    # blue dominant
    'R': (240, 210, 140),  # beige dominant
    'L': (230, 60, 210),   # magenta dominant
    'T': (80, 210, 90),    # green dominant
    'D': (210, 60, 70),    # red-ish (bottom border)
}


def render_axis(mesh, cam_dir, up_dir, size=384):
    cam_pos = np.array(cam_dir, float)
    cam_pos = cam_pos / np.linalg.norm(cam_pos) * max(mesh.bounds[1] - mesh.bounds[0]) * 2.5
    forward = -cam_pos / np.linalg.norm(cam_pos)
    up0 = np.array(up_dir, float)
    right = np.cross(forward, up0); right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    R = np.vstack([right, up, -forward])
    t = -R @ cam_pos
    v_cam = (R @ mesh.vertices.T).T + t
    z = v_cam[:, 2]
    u2, v2 = v_cam[:, 0], v_cam[:, 1]
    ext = max(u2.max() - u2.min(), v2.max() - v2.min())
    scale = (size * 0.82) / ext
    cx = (u2.max() + u2.min()) / 2
    cy = (v2.max() + v2.min()) / 2
    px = (u2 - cx) * scale + size / 2
    py = size / 2 - (v2 - cy) * scale

    try:
        tex = np.asarray(mesh.visual.material.baseColorTexture.convert('RGB'))
    except Exception:
        return np.zeros((size, size, 3), dtype=np.uint8)
    uvs = mesh.visual.uv
    faces = mesh.faces
    face_z = z[faces].mean(axis=1)
    order = np.argsort(face_z)[::-1]
    img = np.full((size, size, 3), 255, dtype=np.uint8)
    depth = np.full((size, size), 1e18, float)
    aH, aW = tex.shape[:2]
    for i in order:
        f = faces[i]
        v0c, v1c, v2c = v_cam[f]
        n = np.cross(v1c - v0c, v2c - v0c)
        if n[2] < 1e-4:
            continue
        xs = px[f]; ys = py[f]
        xmin = max(0, int(xs.min())); xmax = min(size - 1, int(xs.max()))
        ymin = max(0, int(ys.min())); ymax = min(size - 1, int(ys.max()))
        if xmax < xmin or ymax < ymin:
            continue
        x0, x1, x2 = xs; y0, y1, y2 = ys
        denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(denom) < 1e-8:
            continue
        fz = z[f]; fuv = uvs[f]
        for yy in range(ymin, ymax + 1):
            for xx in range(xmin, xmax + 1):
                l0 = ((y1 - y2) * (xx - x2) + (x2 - x1) * (yy - y2)) / denom
                l1 = ((y2 - y0) * (xx - x2) + (x0 - x2) * (yy - y2)) / denom
                l2 = 1 - l0 - l1
                if l0 >= 0 and l1 >= 0 and l2 >= 0:
                    d = l0 * fz[0] + l1 * fz[1] + l2 * fz[2]
                    if d < depth[yy, xx]:
                        depth[yy, xx] = d
                        u = l0 * fuv[0][0] + l1 * fuv[1][0] + l2 * fuv[2][0]
                        v = l0 * fuv[0][1] + l1 * fuv[1][1] + l2 * fuv[2][1]
                        ax = int(np.clip(u * (aW - 1), 0, aW - 1))
                        ay = int(np.clip((1 - v) * (aH - 1), 0, aH - 1))
                        img[yy, xx] = tex[ay, ax]
    return img


_TEMPLATE_CACHE = {}

def _load_templates(size):
    """Load the 6 ground-truth axis renders as reference templates."""
    if size in _TEMPLATE_CACHE:
        return _TEMPLATE_CACHE[size]
    templates = {}
    letter_map = {'front': 'F', 'back': 'B', 'right': 'R',
                  'left': 'L', 'top': 'T', 'bottom': 'D'}
    for name, letter in letter_map.items():
        p = os.path.join(GT_AXES_DIR, f'{name}.png')
        if os.path.exists(p):
            img = Image.open(p).convert('RGB').resize((size, size), Image.LANCZOS)
            templates[letter] = np.asarray(img).astype(float)
    _TEMPLATE_CACHE[size] = templates
    return templates


def _template_classify(img):
    """Classify by template matching against the 6 ground-truth renders."""
    size = img.shape[0]
    templates = _load_templates(size)
    if not templates:
        return '?', 1.0, {}
    m0, m1 = int(size * 0.18), int(size * 0.82)
    got = img[m0:m1, m0:m1].astype(float)
    scores = {}
    for letter, tpl in templates.items():
        ref = tpl[m0:m1, m0:m1]
        scores[letter] = float(np.linalg.norm(got - ref, axis=2).mean())
    ranked = sorted(scores.items(), key=lambda kv: kv[1])
    best_letter, best_d = ranked[0]
    second_d = ranked[1][1] if len(ranked) > 1 else best_d + 1
    conf = float(min(1.0, (second_d - best_d) / max(1.0, best_d)))
    return best_letter, conf, scores


def _palette_classify(img):
    """Classify by counting pixels that match each face's signature
    palette. Independent from template matching — uses each face's
    unique dominant + secondary colors."""
    if _USE_RUBIKS:
        # Rubik's Cube standard (Western): unique dominant color per face
        PALETTES = {
            'F': [(200, 35, 35)],    # red
            'B': [(230, 120, 40)],   # orange
            'R': [(40, 70, 200)],    # blue
            'L': [(50, 180, 90)],    # green
            'T': [(245, 245, 245)],  # white
            'D': [(245, 215, 60)],   # yellow
        }
    else:
        PALETTES = {
            'F': [(200, 40, 40), (240, 240, 240)],
            'B': [(40, 70, 200), (200, 40, 40), (240, 240, 240)],
            'R': [(240, 210, 140), (80, 210, 90), (30, 30, 30)],
            'L': [(230, 60, 210), (80, 210, 90), (240, 240, 240)],
            'T': [(240, 235, 210), (80, 210, 90), (200, 40, 40)],
            'D': [(200, 40, 40), (40, 70, 200), (80, 210, 90)],
        }
    size = img.shape[0]
    m0, m1 = int(size * 0.2), int(size * 0.8)
    sample = img[m0:m1, m0:m1].reshape(-1, 3).astype(float)
    # Drop bg (pure white)
    mask = sample.sum(1) < 720
    if not mask.any():
        return '?', 0.0, {}
    sample = sample[mask]
    scores = {}
    for letter, palette in PALETTES.items():
        # For each pixel, distance to closest palette color
        refs = np.array(palette, float)
        dists = np.linalg.norm(sample[:, None, :] - refs[None, :, :], axis=2)
        min_d = dists.min(axis=1)
        # Count pixels within tight threshold
        scores[letter] = float((min_d < 60).sum()) / len(sample)
    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    best_letter, best_s = ranked[0]
    second_s = ranked[1][1] if len(ranked) > 1 else 0
    conf = float(max(0, best_s - second_s))
    return best_letter, conf, scores


def classify_face(img):
    """Cross-validate using two independent classifiers:
      1. Template matching (pixel-vs-pixel distance to ground truth)
      2. Palette histogram (counts of signature colors per face)

    If both agree → high confidence.
    If they disagree → '?' flagged so the UI shows it's ambiguous.
    """
    tpl_letter, tpl_conf, _ = _template_classify(img)
    pal_letter, pal_conf, _ = _palette_classify(img)
    agree = tpl_letter == pal_letter
    # Combined confidence: product scaled down if they disagree
    conf = (tpl_conf + pal_conf) / 2 if agree else 0.0
    letter = tpl_letter if agree else f'?{tpl_letter}/{pal_letter}'
    avg = tuple(int(x) for x in img[int(img.shape[0]*0.3):int(img.shape[0]*0.7),
                                    int(img.shape[0]*0.3):int(img.shape[0]*0.7)].reshape(-1,3).mean(0))
    return letter, avg, conf


def pixel_similarity(got, expected_path, size=384):
    """Return a 0..1 similarity score comparing the center region of
    got vs expected. Crops expected to the cube body to avoid framing
    differences influencing the score."""
    exp = Image.open(expected_path).convert('RGB').resize((size, size), Image.LANCZOS)
    exp_arr = np.asarray(exp)
    got_arr = got
    # Compare center 60% region (both renders center the cube)
    m0, m1 = int(size * 0.2), int(size * 0.8)
    a = exp_arr[m0:m1, m0:m1].astype(float)
    b = got_arr[m0:m1, m0:m1].astype(float)
    diff = np.linalg.norm(a - b, axis=2)  # per-pixel color distance
    # Normalize: max per-pixel distance = sqrt(3 * 255^2) ≈ 441
    return float(1.0 - diff.mean() / 441.0)


def run_pipeline(mesh_out, env_overrides=None, skip_sf3d=False):
    """Run SF3D + texture_project; return sf3d_mesh, projected_mesh."""
    mesh_dir = os.path.dirname(mesh_out)
    os.makedirs(mesh_dir, exist_ok=True)
    sf3d_path = os.path.join(mesh_dir, 'sf3d_output.glb')
    projected_path = mesh_out

    env = dict(os.environ)
    if env_overrides:
        env.update(env_overrides)

    if not skip_sf3d or not os.path.exists(sf3d_path):
        print('[calib] running SF3D...')
        sf3d_script = os.path.join(ROOT, 'scripts', 'local_sf3d_bridge.py')
        r = subprocess.run(
            [sys.executable, sf3d_script, REF_IMG, sf3d_path, '1024', '-1', 'none', '0'],
            env=env, capture_output=True, text=True, timeout=1800)
        if r.returncode != 0 or not os.path.exists(sf3d_path):
            raise RuntimeError(f'SF3D failed: {r.stderr[-500:]}')

    # Generate multi-views via the normal Zero123++ pipeline if they
    # don't already exist — this is the real "out of the factory" flow.
    if not os.path.exists(os.path.join(MV_DIR_ACTIVE, 'view_0.png')):
        print('[calib] running Zero123++ multi-view gen...')
        os.makedirs(MV_DIR_ACTIVE, exist_ok=True)
        mv_script = os.path.join(ROOT, 'scripts', 'multiview_gen.py')
        r = subprocess.run(
            [sys.executable, mv_script, REF_IMG, MV_DIR_ACTIVE],
            env=env, capture_output=True, text=True, timeout=600)
        if r.returncode != 0 or not os.path.exists(os.path.join(MV_DIR_ACTIVE, 'view_0.png')):
            raise RuntimeError(f'multiview_gen failed: {r.stderr[-500:]}')

    print('[calib] running texture_project...')
    proj_script = os.path.join(ROOT, 'scripts', 'texture_project.py')
    r = subprocess.run(
        [sys.executable, proj_script, sf3d_path, REF_IMG, projected_path, '1024',
         '--multiview', MV_DIR_ACTIVE],
        env=env, capture_output=True, text=True, timeout=300)
    if r.returncode != 0 or not os.path.exists(projected_path):
        raise RuntimeError(f'texture_project failed: {r.stderr[-500:]}')
    return sf3d_path, projected_path


def analyze(mesh_path, report_dir):
    os.makedirs(report_dir, exist_ok=True)
    scene = trimesh.load(mesh_path, process=False)
    g = list(scene.geometry.values())[0] if hasattr(scene, 'geometry') else scene

    results = []
    hits = 0
    sim_sum = 0.0
    for name, cam, up, expected, desc in AXES:
        img = render_axis(g, cam, up, size=384)
        got_path = os.path.join(report_dir, f'got_{name}.png')
        Image.fromarray(img).save(got_path)

        got_letter, got_rgb, conf = classify_face(img)
        ok = got_letter == expected

        gt_path = os.path.join(GT_AXES_DIR, f'{name}.png')
        sim = pixel_similarity(img, gt_path) if os.path.exists(gt_path) else 0.0
        sim_sum += sim

        results.append(dict(
            axis=name, expected=expected, got=got_letter,
            correct=ok, confidence=conf, similarity=sim,
            avg_color=got_rgb, desc=desc,
            got_img=f'got_{name}.png',
            gt_img=os.path.relpath(gt_path, report_dir).replace('\\', '/'),
        ))
        if ok:
            hits += 1

    return dict(
        mesh=mesh_path,
        score=hits, total=len(AXES),
        avg_similarity=sim_sum / len(AXES),
        timestamp=datetime.datetime.now().isoformat(timespec='seconds'),
        results=results,
    )


def write_report(report_dir, result, env_overrides=None):
    json_path = os.path.join(report_dir, 'score.json')
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2)

    rows = []
    for r in result['results']:
        ok_class = 'ok' if r['correct'] else 'bad'
        color_swatch = 'rgb({},{},{})'.format(*r['avg_color'])
        rows.append(f"""
        <tr class="{ok_class}">
          <td><b>{r['axis']}</b><br><small>{r['desc']}</small></td>
          <td><img src="{r['gt_img']}" width=160></td>
          <td><img src="{r['got_img']}" width=160></td>
          <td class="status">{r['expected']} &rarr; {r['got']} {'OK' if r['correct'] else 'XX'}</td>
          <td>
            <div class="swatch" style="background:{color_swatch}"></div>
            <small>sim {r['similarity']:.2f}<br>conf {r['confidence']:.2f}</small>
          </td>
        </tr>""")

    env_str = ''
    if env_overrides:
        env_str = '<h3>Env overrides:</h3><pre>' + '\n'.join(
            f'{k}={v}' for k, v in env_overrides.items()) + '</pre>'

    html = f"""<!doctype html><html><head><meta charset="utf-8">
<title>FabMesh Calibration Report</title>
<style>
body {{ font-family: system-ui, sans-serif; margin: 20px; background: #111; color: #eee; }}
h1 {{ margin-top: 0; }}
.score {{ font-size: 2em; font-weight: bold; padding: 10px 20px; border-radius: 8px;
          display: inline-block; background: #222; }}
.score.high {{ background: #1a5c1a; }}
.score.mid {{ background: #8a6a1a; }}
.score.low {{ background: #8a1a1a; }}
table {{ border-collapse: collapse; margin-top: 20px; width: 100%; }}
th, td {{ padding: 10px; border: 1px solid #333; text-align: left; vertical-align: middle; }}
th {{ background: #222; }}
tr.ok {{ background: #1a2c1a; }}
tr.bad {{ background: #2c1a1a; }}
.status {{ font-family: monospace; font-size: 1.1em; }}
.swatch {{ width: 40px; height: 40px; border: 1px solid #555; display: inline-block; }}
img {{ display: block; border: 1px solid #333; }}
pre {{ background: #222; padding: 8px; border-radius: 4px; }}
</style>
</head><body>
<h1>FabMesh Calibration Report</h1>
<p>Mesh: <code>{result['mesh']}</code><br>
Timestamp: {result['timestamp']}</p>
<p>
  <span class="score {'high' if result['score'] >= 5 else 'mid' if result['score'] >= 3 else 'low'}">
    Score: {result['score']} / {result['total']}
  </span>
  &nbsp; avg similarity: {result['avg_similarity']:.2f}
</p>
{env_str}
<table>
  <tr><th>Axis</th><th>Expected (ground truth)</th><th>Got (generated)</th><th>Classification</th><th>Metrics</th></tr>
  {''.join(rows)}
</table>
</body></html>
"""
    html_path = os.path.join(report_dir, 'index.html')
    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(html)
    return html_path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mesh', help='Analyze existing mesh GLB instead of running pipeline')
    parser.add_argument('--skip-sf3d', action='store_true',
                        help='Reuse existing SF3D output, only re-project')
    parser.add_argument('--env', action='append', default=[],
                        help='Env var override KEY=VALUE (can repeat)')
    parser.add_argument('--tag', default='',
                        help='Tag suffix for report directory')
    args = parser.parse_args()

    env_overrides = {}
    for e in args.env:
        if '=' in e:
            k, v = e.split('=', 1); env_overrides[k] = v

    stamp = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
    if args.tag:
        stamp += '_' + args.tag
    report_dir = os.path.join(REPORTS_DIR, stamp)

    if args.mesh:
        mesh_path = args.mesh
        print(f'[calib] analyzing existing mesh: {mesh_path}')
    else:
        work_dir = os.path.join(ROOT, 'meshes', '_calibration')
        mesh_path = os.path.join(work_dir, f'projected_{stamp}.glb')
        print(f'[calib] running pipeline -> {mesh_path}')
        run_pipeline(mesh_path, env_overrides=env_overrides, skip_sf3d=args.skip_sf3d)

    print(f'[calib] analyzing and rendering axis views...')
    result = analyze(mesh_path, report_dir)
    html = write_report(report_dir, result, env_overrides)
    print(f'\n[calib] SCORE: {result["score"]}/{result["total"]}  '
          f'avg similarity {result["avg_similarity"]:.2f}')
    for r in result['results']:
        mark = 'OK' if r['correct'] else 'XX'
        print(f'  {r["axis"]:8s} {r["expected"]} -> {r["got"]} {mark}  '
              f'sim {r["similarity"]:.2f}')
    print(f'\n[calib] report: {html}')


if __name__ == '__main__':
    main()
