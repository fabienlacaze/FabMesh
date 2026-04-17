"""
FabMesh calibration — 5 independent per-stage checks.

Each function checks ONE pipeline stage in isolation. No upstream
dependency: stage 4 can run even if SF3D is broken, stage 3 can run on
any previously-generated mesh.

Return contract for every stage:
    {
        'stage': int,
        'name': str,
        'ok': bool,
        'score': float,         # 0..1 normalised, comparable for baseline detection
        'details': dict,        # per-test breakdown
        'artifacts': list[str], # paths written to disk (thumbs, debug images)
    }
"""
from __future__ import annotations
import os, sys, json, subprocess, time
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CALIB_DIR = os.path.join(ROOT, 'images', '_calibration')
GT_CUBE_GLB = os.path.join(ROOT, 'meshes', '_calibration_groundtruth.glb')
GT_MV_DIR = os.path.join(CALIB_DIR, 'ref_0_multiview_perfect')
GT_AXES_DIR = os.path.join(CALIB_DIR, 'ref_0_perfect_axes')


def _load_rgb(path, size=None):
    im = Image.open(path).convert('RGB')
    if size:
        im = im.resize((size, size), Image.LANCZOS)
    return np.asarray(im).astype(np.float32)


def _alpha_or_bgmask(path, bg_thresh=240):
    """Return a boolean foreground mask. Uses alpha if present, else
    thresholds on "not near-white" pixels."""
    im = Image.open(path)
    if im.mode == 'RGBA':
        a = np.asarray(im)[..., 3]
        return a > 127
    arr = np.asarray(im.convert('RGB'))
    return arr.min(axis=2) < bg_thresh


def _iou(a, b):
    inter = np.logical_and(a, b).sum()
    union = np.logical_or(a, b).sum()
    return float(inter) / float(max(1, union))


def _centroid(mask):
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return None
    return float(xs.mean()), float(ys.mean())


def _hist_cosine(a_path, b_path, bins=16):
    """Cosine similarity of 3D-RGB histograms. 1.0 = identical palette."""
    a = _load_rgb(a_path, 128).reshape(-1, 3)
    b = _load_rgb(b_path, 128).reshape(-1, 3)
    ha, _ = np.histogramdd(a, bins=bins, range=[[0, 256]] * 3)
    hb, _ = np.histogramdd(b, bins=bins, range=[[0, 256]] * 3)
    ha = ha.ravel(); hb = hb.ravel()
    denom = np.linalg.norm(ha) * np.linalg.norm(hb)
    if denom < 1e-8:
        return 0.0
    return float(np.dot(ha, hb) / denom)


# ============================================================
# Stage 1 — Reference image sanity
# ============================================================

def check_stage1_ref_image(path):
    res = {'stage': 1, 'name': 'ref_image', 'ok': False,
           'score': 0.0, 'details': {}, 'artifacts': []}
    if not os.path.exists(path):
        res['details']['error'] = f'missing: {path}'
        return res
    try:
        im = Image.open(path).convert('RGB')
    except Exception as e:
        res['details']['error'] = f'decode failed: {e}'
        return res
    arr = np.asarray(im).astype(float)
    w, h = im.size
    stddev = float(arr.std())
    # Border-white ratio: most product photos have a light background.
    edge = np.concatenate([
        arr[0].reshape(-1, 3), arr[-1].reshape(-1, 3),
        arr[:, 0].reshape(-1, 3), arr[:, -1].reshape(-1, 3),
    ])
    edge_white_ratio = float((edge.min(axis=1) > 220).mean())
    res['details'] = {
        'size': (w, h),
        'stddev': stddev,
        'edge_white_ratio': edge_white_ratio,
    }
    # Pass: >=512 on shortest side, stddev>20 (has content), edge >50% white.
    size_ok = min(w, h) >= 512
    content_ok = stddev > 20
    bg_ok = edge_white_ratio > 0.50
    res['ok'] = size_ok and content_ok and bg_ok
    res['score'] = float(size_ok) * 0.2 + min(stddev / 60.0, 1.0) * 0.4 + edge_white_ratio * 0.4
    res['details']['checks'] = {'size_ok': size_ok, 'content_ok': content_ok, 'bg_ok': bg_ok}
    return res


# ============================================================
# Stage 2 — Multi-view sanity (no GT required)
# ============================================================

def check_stage2_multiview(mv_dir, input_img):
    """Verifies 6 views exist, silhouettes are at different positions
    (views differ), and palette is consistent with input (same subject)."""
    res = {'stage': 2, 'name': 'multiview', 'ok': False,
           'score': 0.0, 'details': {}, 'artifacts': []}
    views = [os.path.join(mv_dir, f'view_{i}.png') for i in range(6)]
    missing = [v for v in views if not os.path.exists(v)]
    if missing:
        res['details']['missing'] = missing
        return res

    # Silhouette centroid distance matrix — views must actually differ
    centroids = [_centroid(_alpha_or_bgmask(v)) for v in views]
    if any(c is None for c in centroids):
        res['details']['error'] = 'one view has empty silhouette'
        return res
    cs = np.array(centroids)
    img0 = Image.open(views[0]).size
    w = img0[0]
    dmat = np.linalg.norm(cs[:, None] - cs[None, :], axis=2) / w
    off_diag = dmat[np.triu_indices(6, 1)]
    max_pair_dist = float(off_diag.max())
    min_pair_dist = float(off_diag.min())

    # Palette consistency: each view should share overall colors with input
    hist_sims = [_hist_cosine(v, input_img) for v in views]
    hist_mean = float(np.mean(hist_sims))

    res['details'] = {
        'silhouette_max_pair_dist': max_pair_dist,
        'silhouette_min_pair_dist': min_pair_dist,
        'hist_sim_mean': hist_mean,
        'hist_sims': [round(s, 3) for s in hist_sims],
    }
    # Pass: max pair distance > 5% width (some views differ) + hist mean > 0.40
    views_differ = max_pair_dist > 0.05
    colors_consistent = hist_mean > 0.40
    res['ok'] = views_differ and colors_consistent
    res['score'] = min(max_pair_dist / 0.30, 1.0) * 0.5 + min(hist_mean / 0.80, 1.0) * 0.5
    res['details']['checks'] = {'views_differ': views_differ,
                                'colors_consistent': colors_consistent}
    # Visual comparison: input image + 6 multi-views with per-view sim.
    try:
        html_dir = os.path.dirname(os.path.abspath(mv_dir))
        html_path = os.path.join(html_dir, 'stage2_compare.html')
        input_rel = os.path.relpath(input_img, html_dir).replace('\\', '/')
        tiles = []
        for i in range(6):
            v_rel = os.path.relpath(views[i], html_dir).replace('\\', '/')
            sim = hist_sims[i]
            col = '#3a3' if sim > 0.40 else '#c33'
            tiles.append(f'<div style="text-align:center;">'
                         f'<img src="{v_rel}" width="180" style="border:1px solid #333;"><br>'
                         f'<span style="font-family:monospace; color:{col};">view_{i} · hist {sim:.2f}</span></div>')
        html = f'''<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:Segoe UI,sans-serif; background:#111; color:#ddd; padding:18px;">
  <h2>Stage 2 — Multi-view generation</h2>
  <div style="margin-bottom:12px;"><b>Input reference:</b><br>
    <img src="{input_rel}" width="260" style="border:1px solid #333;"></div>
  <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:12px;">{''.join(tiles)}</div>
</body></html>'''
        with open(html_path, 'w', encoding='utf-8') as f:
            f.write(html)
        res['details']['compare_html'] = html_path
        res['artifacts'].append(html_path)
    except Exception:
        pass
    return res


# ============================================================
# Stage 3 — SF3D mesh silhouette IoU
# ============================================================

def _render_mesh_silhouette(mesh_path, size=384):
    """Orthographic front silhouette (alpha mask)."""
    import trimesh
    g = trimesh.load(mesh_path, force='mesh', process=False)
    verts = np.asarray(g.vertices, dtype=np.float32)
    # Front camera = +Z. Project x,y to image, ignore z (ortho).
    v = verts.copy()
    # Normalize to image
    mins = v.min(axis=0); maxs = v.max(axis=0)
    ext = (maxs - mins)[:2].max()
    s = (size * 0.82) / ext
    cx = (maxs[0] + mins[0]) / 2
    cy = (maxs[1] + mins[1]) / 2
    px = (v[:, 0] - cx) * s + size / 2
    py = size / 2 - (v[:, 1] - cy) * s
    faces = np.asarray(g.faces)
    mask = np.zeros((size, size), dtype=bool)
    # Rasterize triangles with pure-numpy bbox + barycentric test
    for f in faces:
        x = px[f]; y = py[f]
        xmin = max(0, int(x.min())); xmax = min(size - 1, int(x.max()))
        ymin = max(0, int(y.min())); ymax = min(size - 1, int(y.max()))
        if xmax < xmin or ymax < ymin:
            continue
        x0, x1, x2 = x; y0, y1, y2 = y
        denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(denom) < 1e-8:
            continue
        ys, xs = np.mgrid[ymin:ymax + 1, xmin:xmax + 1]
        l0 = ((y1 - y2) * (xs - x2) + (x2 - x1) * (ys - y2)) / denom
        l1 = ((y2 - y0) * (xs - x2) + (x0 - x2) * (ys - y2)) / denom
        l2 = 1 - l0 - l1
        inside = (l0 >= 0) & (l1 >= 0) & (l2 >= 0)
        mask[ymin:ymax + 1, xmin:xmax + 1] |= inside
    return mask


def check_stage3_mesh_silhouette(mesh_path, ref_img_path, size=384):
    """Silhouette IoU: mesh front projection vs reference image foreground."""
    res = {'stage': 3, 'name': 'mesh_silhouette', 'ok': False,
           'score': 0.0, 'details': {}, 'artifacts': []}
    if not os.path.exists(mesh_path):
        res['details']['error'] = f'missing mesh: {mesh_path}'
        return res
    if not os.path.exists(ref_img_path):
        res['details']['error'] = f'missing ref: {ref_img_path}'
        return res
    try:
        mesh_mask = _render_mesh_silhouette(mesh_path, size=size)
    except Exception as e:
        res['details']['error'] = f'mesh render failed: {e}'
        return res
    ref_mask_raw = _alpha_or_bgmask(ref_img_path)
    # Resize ref mask to size
    im = Image.fromarray(ref_mask_raw.astype(np.uint8) * 255).resize((size, size), Image.NEAREST)
    ref_mask = np.asarray(im) > 127
    iou = _iou(mesh_mask, ref_mask)
    res['details'] = {'iou': iou, 'mesh_area': int(mesh_mask.sum()),
                      'ref_area': int(ref_mask.sum())}
    res['score'] = iou
    res['ok'] = iou >= 0.70
    return res


# ============================================================
# Stage 4 — texture_project on deterministic GT inputs
# ============================================================

def check_stage4_projection(work_dir, env=None):
    """Run texture_project.py on the ground-truth cube GLB + GT multi-views.
    This is deterministic: same inputs every run. Catches UV/camera bugs."""
    res = {'stage': 4, 'name': 'projection', 'ok': False,
           'score': 0.0, 'details': {}, 'artifacts': []}
    os.makedirs(work_dir, exist_ok=True)
    if not os.path.exists(GT_CUBE_GLB):
        res['details']['error'] = f'missing GT cube: {GT_CUBE_GLB}'
        return res
    gt_input = os.path.join(GT_MV_DIR, 'input.png')
    if not os.path.exists(gt_input):
        res['details']['error'] = f'missing GT mv dir: {GT_MV_DIR}'
        return res

    out_glb = os.path.join(work_dir, 'stage4_projected.glb')
    script = os.path.join(ROOT, 'scripts', 'texture_project.py')
    # GT cube is in natural glTF frame (front=-Z, up=+Y). SKIP_UNDO=1
    # stops R_undo from rotating the cube into SF3D frame (which would
    # scramble the axes).
    e = {**os.environ, 'PYTHONUNBUFFERED': '1',
         'FABMESH_TEXPROJ_SKIP_UNDO': '1', **(env or {})}
    r = subprocess.run(
        [sys.executable, script, GT_CUBE_GLB, gt_input, out_glb, '1024',
         '--multiview', GT_MV_DIR, '--rotation-offset', '120'],
        env=e, capture_output=True, text=True, timeout=300)
    if r.returncode != 0 or not os.path.exists(out_glb):
        res['details']['error'] = (r.stderr or '')[-400:]
        return res
    res['artifacts'].append(out_glb)

    # Render 6 axes and compare pixel-wise to the GT axes renders
    import trimesh, numpy as np
    sys.path.insert(0, os.path.join(ROOT, 'scripts'))
    from calibrate import render_axis, AXES
    g = trimesh.load(out_glb, force='mesh', process=False)
    per_axis = {}
    correct = 0
    for name, cam, up, letter, desc in AXES:
        got_img = render_axis(g, cam, up, size=384)
        got_path = os.path.join(work_dir, f'stage4_{name}.png')
        Image.fromarray(got_img).save(got_path)
        res['artifacts'].append(got_path)
        gt_path = os.path.join(GT_AXES_DIR, f'{name}.png')
        if not os.path.exists(gt_path):
            per_axis[name] = {'error': 'missing GT'}
            continue
        gt_arr = _load_rgb(gt_path, 384)
        # Pixel-distance in the center region (avoid edges where AA differs)
        m0, m1 = int(384 * 0.18), int(384 * 0.82)
        d = float(np.linalg.norm(got_img[m0:m1, m0:m1].astype(float) - gt_arr[m0:m1, m0:m1], axis=2).mean())
        sim = float(1.0 - d / 441.0)
        # 0.60 floor: catches mirrored letters (~0.65) and wrong-face
        # mappings (~0.50) while tolerating AA/lighting drift.
        ok = sim >= 0.60
        if ok:
            correct += 1
        per_axis[name] = {'sim': round(sim, 3), 'ok': ok}
    res['details'] = {'correct': correct, 'total': 6, 'per_axis': per_axis}
    res['score'] = correct / 6.0
    res['ok'] = correct >= 6

    # Write a side-by-side HTML comparison so the user can judge visually.
    html_path = os.path.join(work_dir, 'stage4_compare.html')
    rows = []
    for name, cam, up, letter, desc in AXES:
        got_rel = f'stage4_{name}.png'
        gt_abs = os.path.join(GT_AXES_DIR, f'{name}.png')
        gt_rel = os.path.relpath(gt_abs, work_dir).replace('\\', '/')
        info = per_axis.get(name, {})
        sim = info.get('sim', 0.0)
        ok = info.get('ok', False)
        col = '#3a3' if ok else '#c33'
        rows.append(f'''
        <tr>
          <td style="padding:8px; font-weight:bold; color:#ccc;">{name.upper()} ({letter})</td>
          <td style="padding:4px;"><img src="{gt_rel}" width="200" style="border:1px solid #333;"></td>
          <td style="padding:4px;"><img src="{got_rel}" width="200" style="border:1px solid #333;"></td>
          <td style="padding:8px; color:{col}; font-family:monospace;">sim {sim:.3f}<br>{'PASS' if ok else 'FAIL'}</td>
        </tr>''')
    html = f'''<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Stage 4 — Expected vs Got</title></head>
<body style="font-family:Segoe UI,sans-serif; background:#111; color:#ddd; padding:18px;">
  <h2>Stage 4 — UV Projection Calibration</h2>
  <div style="margin-bottom:14px; padding:10px; background:#1a1a1a; border-radius:4px;">
    <b>Result:</b> {correct}/6 axes correct &nbsp;·&nbsp; pass threshold sim &ge; 0.60
  </div>
  <table style="border-collapse:collapse; width:100%;">
    <thead>
      <tr style="background:#222; color:#aaa; text-align:left;">
        <th style="padding:8px;">Axis</th>
        <th style="padding:8px;">Expected (GT)</th>
        <th style="padding:8px;">Got (pipeline)</th>
        <th style="padding:8px;">Similarity</th>
      </tr>
    </thead>
    <tbody>{''.join(rows)}</tbody>
  </table>
</body></html>'''
    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(html)
    res['artifacts'].append(html_path)
    res['details']['compare_html'] = html_path
    return res


# ============================================================
# Stage 5 — final GLB perceptual similarity vs input
# ============================================================

def check_stage5_final(glb_path, ref_img_path, size=384):
    """Render the final textured mesh from the input-image camera and
    compare to the input. No baseline required — just a floor."""
    res = {'stage': 5, 'name': 'final_render', 'ok': False,
           'score': 0.0, 'details': {}, 'artifacts': []}
    if not os.path.exists(glb_path) or not os.path.exists(ref_img_path):
        res['details']['error'] = 'missing inputs'
        return res
    try:
        import trimesh
        sys.path.insert(0, os.path.join(ROOT, 'scripts'))
        from calibrate import render_axis
        g = trimesh.load(glb_path, force='mesh', process=False)
        img = render_axis(g, (0, 0, 1), (0, 1, 0), size=size)
    except Exception as e:
        res['details']['error'] = f'render failed: {e}'
        return res
    out_path = os.path.join(os.path.dirname(glb_path), 'stage5_front.png')
    Image.fromarray(img).save(out_path)
    res['artifacts'].append(out_path)

    # Compare via histogram cosine + silhouette IoU
    hist = _hist_cosine(out_path, ref_img_path)
    m_mesh = _alpha_or_bgmask(out_path)
    m_ref_raw = _alpha_or_bgmask(ref_img_path)
    im_ref = Image.fromarray(m_ref_raw.astype(np.uint8) * 255).resize((size, size), Image.NEAREST)
    m_ref = np.asarray(im_ref) > 127
    iou = _iou(m_mesh, m_ref)
    score = 0.5 * hist + 0.5 * iou
    res['details'] = {'hist_cosine': hist, 'silhouette_iou': iou}
    res['score'] = score
    res['ok'] = score >= 0.55
    return res


# ============================================================
# CLI
# ============================================================

def _main():
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument('--stage', type=int, required=True, choices=[1, 2, 3, 4, 5])
    p.add_argument('--ref', help='Reference image path')
    p.add_argument('--mv-dir', help='Multi-view dir')
    p.add_argument('--mesh', help='Mesh GLB path')
    p.add_argument('--work-dir', default=os.path.join(ROOT, 'logs', 'calib_stage'),
                   help='Working dir for stage outputs')
    args = p.parse_args()
    os.makedirs(args.work_dir, exist_ok=True)

    if args.stage == 1:
        r = check_stage1_ref_image(args.ref)
    elif args.stage == 2:
        r = check_stage2_multiview(args.mv_dir, args.ref)
    elif args.stage == 3:
        r = check_stage3_mesh_silhouette(args.mesh, args.ref)
    elif args.stage == 4:
        r = check_stage4_projection(args.work_dir)
    elif args.stage == 5:
        r = check_stage5_final(args.mesh, args.ref)
    print('STAGE_RESULT: ' + json.dumps(r, default=str))
    return 0 if r['ok'] else 1


if __name__ == '__main__':
    sys.exit(_main())
