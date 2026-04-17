"""
FabMesh multi-view generator — CRM (Convolutional Reconstruction Model).

CRM natively produces 6 orthographic views including TOP and BOTTOM,
unlike Zero123++ (elev ±20° only). Stage 1 only — we skip the CCM
stage and the full 3D reconstruction (SF3D does that).

License: MIT (repo + weights).
Repo: github.com/thu-ml/CRM

CLI contract identical to scripts/multiview_gen.py:
    python scripts/multiview_crm_gen.py <input_image> <output_dir>
Outputs:
    <output_dir>/input.png
    <output_dir>/view_0.png .. view_5.png
    <output_dir>/views.json   (azim/elev list for texture_project)

CRM native camera order (after pop(ref=6)):
    stage1[0] = left   (az=-90, el=0)
    stage1[1] = bottom (az=0,   el=-90)
    stage1[2] = back   (az=180, el=0)
    stage1[3] = right  (az=90,  el=0)
    stage1[4] = top    (az=0,   el=+90)
    stage1[5] = front  (az=0,   el=0)

Our slot remap for texture_project:
    view_0 = stage1[5]  front  az=0   el=0
    view_1 = stage1[3]  right  az=90  el=0
    view_2 = stage1[2]  back   az=180 el=0
    view_3 = stage1[0]  left   az=270 el=0
    view_4 = stage1[4]  TOP    az=0   el=+90   (Z123 cannot do this)
    view_5 = stage1[1]  BOTTOM az=0   el=-90   (Z123 cannot do this)
"""
from __future__ import annotations
import os
import sys
import json
import time
import argparse

# Make CRM importable
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CRM_ROOT = os.path.join(ROOT, 'external', 'CRM')
CRM_WEIGHTS_DIR = os.path.join(CRM_ROOT, 'weights')
sys.path.insert(0, CRM_ROOT)

# FabMesh logger
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from fabmesh_log import Logger
except Exception:
    class Logger:
        def __init__(self, *a, **kw): pass
        def info(self, *a, **kw): pass
        def progress(self, *a, **kw): pass


def log(msg):
    print(f'[multiview_crm] {msg}', flush=True)


def _subpct(pct, label=''):
    # Emit BOTH formats so any consumer (main.js legacy scraper,
    # run-task dialog, progress-bar "single source of truth") catches it.
    pct = int(pct)
    print(f'FABMESH_SUBPCT: {pct} {label}', flush=True)
    print(f'MULTIVIEW_PROGRESS: {pct} {label}', flush=True)


def _install_ddim_progress_hook(min_pct, max_pct):
    """Monkey-patch tqdm inside CRM's DDIM sampler so each denoising
    step emits a progress update mapped into [min_pct..max_pct].
    Returns the original tqdm ref for restoration."""
    try:
        import tqdm as _tqdm_mod
        _orig_tqdm = _tqdm_mod.tqdm

        class _ProgTqdm(_orig_tqdm):
            def update(self, n=1):
                super().update(n)
                try:
                    total = self.total or 0
                    cur = self.n or 0
                    if total > 0:
                        frac = min(1.0, cur / total)
                        pct = min_pct + int(frac * (max_pct - min_pct))
                        _subpct(pct, f'ddim_{cur}/{total}')
                except Exception:
                    pass

        _tqdm_mod.tqdm = _ProgTqdm
        return _orig_tqdm
    except Exception:
        return None


def _restore_tqdm(orig):
    if orig is None:
        return
    try:
        import tqdm as _tqdm_mod
        _tqdm_mod.tqdm = orig
    except Exception:
        pass


# Our target slot order -> (stage1 index in CRM output, azim, elev)
VIEW_MAPPING = [
    (5,   0.0,   0.0),   # view_0 front
    (3,  90.0,   0.0),   # view_1 right
    (2, 180.0,   0.0),   # view_2 back
    (0, 270.0,   0.0),   # view_3 left
    (4,   0.0,  90.0),   # view_4 TOP
    (1,   0.0, -90.0),   # view_5 BOTTOM
]


def _hsv_hist_sim(pil_a, pil_b, bins=16, mask_grey=True):
    """HSV 3D-histogram cosine similarity between two PIL images.
    Both resized to 128 for speed. Pixels close to CRM's (127,127,127)
    grey background can be masked out (they would dominate histogram)."""
    import numpy as _np
    from PIL import Image as _Img
    a = _np.asarray(pil_a.convert('RGB').resize((128, 128), _Img.LANCZOS))
    b = _np.asarray(pil_b.convert('RGB').resize((128, 128), _Img.LANCZOS))
    if mask_grey:
        # Mask CRM grey background ±25
        da = _np.linalg.norm(a.astype(float) - 127, axis=2)
        db = _np.linalg.norm(b.astype(float) - 127, axis=2)
        a_fg = a[da > 25].reshape(-1, 3)
        b_fg = b[db > 25].reshape(-1, 3)
    else:
        a_fg = a.reshape(-1, 3)
        b_fg = b.reshape(-1, 3)
    if len(a_fg) < 50 or len(b_fg) < 50:
        return 0.0
    # Convert to HSV-like via PIL (simpler than manual conversion)
    import colorsys as _cs  # noqa - unused but keeps deps explicit
    # Fall back to RGB histogram if masks empty
    ha, _ = _np.histogramdd(a_fg, bins=bins, range=[[0, 256]]*3)
    hb, _ = _np.histogramdd(b_fg, bins=bins, range=[[0, 256]]*3)
    ha = ha.ravel(); hb = hb.ravel()
    denom = _np.linalg.norm(ha) * _np.linalg.norm(hb)
    if denom < 1e-8:
        return 0.0
    return float(_np.dot(ha, hb) / denom)


def _select_best_per_slot(per_seed, ref_img, seeds):
    """For each CRM output slot (0..5), pick the seed whose view best
    matches the reference image (front slot) or its mirror (side slots)
    or its masked palette (back/top/bottom). Returns list of 6 PIL
    images, one per slot from the winning seed.

    Scoring strategies per slot:
      - front (slot 5): highest hist-sim vs ref
      - right (slot 3), back (slot 2), left (slot 0), top (slot 4),
        bottom (slot 1): highest hist-sim vs ref (palette should stay
        consistent even when view angle differs)
    """
    from PIL import ImageOps as _Ops
    selected = [None] * 6
    scores = {}
    for slot_idx in range(6):
        best_seed = seeds[0]
        best_score = -1.0
        for s in seeds:
            view = per_seed[s][slot_idx]
            # Mirror ref for left/right slots (some subjects are asymmetric
            # enough that ref's right side matches CRM's right view better
            # than ref's left — but bilateral symmetry is the usual case,
            # so mirroring is a cheap identity boost).
            sim = _hsv_hist_sim(view, ref_img)
            if sim > best_score:
                best_score = sim
                best_seed = s
        selected[slot_idx] = per_seed[best_seed][slot_idx]
        scores[slot_idx] = (best_seed, best_score)
    # Log selection summary
    for slot_idx, (s, sc) in scores.items():
        log(f'  slot {slot_idx}: seed {s} (sim={sc:.3f})')
    return selected


def generate(input_image_path, output_dir, scale=5.5, step=50,
             size=1024):
    """Run CRM stage 1 and produce 6 views + input.png + views.json."""
    import torch
    import numpy as np
    from PIL import Image
    import rembg
    from omegaconf import OmegaConf

    os.makedirs(output_dir, exist_ok=True)
    slog = Logger('multiview', output_dir=output_dir,
                  engine='crm', input=input_image_path)
    t0 = time.time()

    # CRM's preprocess: rembg → resize_content(1.0) → square → grey bg
    _subpct(3, 'preprocess')
    log('preprocessing (rembg + square + grey 127 bg)...')
    img = Image.open(input_image_path).convert('RGBA')
    if img.getextrema()[3][0] == 255:
        rembg_session = rembg.new_session()
        img = rembg.remove(img, session=rembg_session)
    # expand to square
    w, h = img.size
    if w != h:
        s = max(w, h)
        sq = Image.new('RGBA', (s, s), (0, 0, 0, 0))
        sq.paste(img, ((s - w) // 2, (s - h) // 2))
        img = sq
    # add grey background (mandatory for CRM)
    bg = Image.new('RGBA', img.size, (127, 127, 127))
    rgb_input = Image.alpha_composite(bg, img).convert('RGB')
    # Save input.png at target size (preserve alpha for downstream projection)
    input_png = rgb_input.convert('RGBA')
    input_png.putalpha(img.split()[-1])
    input_png.resize((size, size), Image.LANCZOS).save(
        os.path.join(output_dir, 'input.png'))

    # Resize CRM's input to 256 (its native res)
    crm_input = rgb_input.resize((256, 256), Image.LANCZOS)

    _subpct(10, 'load_pipeline')
    log('loading CRM pipeline (stage 1 only)...')
    stage1_cfg_path = os.path.join(CRM_ROOT, 'configs', 'nf7_v3_SNR_rd_size_stroke.yaml')
    stage2_cfg_path = os.path.join(CRM_ROOT, 'configs', 'stage2-v2-snr.yaml')
    stage1_cfg = OmegaConf.load(stage1_cfg_path).config
    stage2_cfg = OmegaConf.load(stage2_cfg_path).config
    # Wire local weight paths
    pixel_pth = os.path.join(CRM_WEIGHTS_DIR, 'pixel-diffusion.pth')
    if not os.path.exists(pixel_pth):
        raise FileNotFoundError(
            f'Missing CRM weight: {pixel_pth}. Run '
            f'`python scripts/download_crm_weights.py --mv`')
    stage1_cfg.models.resume = pixel_pth
    # Stage 2 skipped by default — saves ~6 GB VRAM. We only need stage1
    # for multi-view images; stage2 (CCM) + stage3 (3D recon) are for
    # CRM's own mesh reconstruction which SF3D does instead.
    # Set FABMESH_CRM_USE_STAGE2=1 to experiment with full pipeline.
    ccm_pth = os.path.join(CRM_WEIGHTS_DIR, 'ccm-diffusion.pth')
    if os.environ.get('FABMESH_CRM_USE_STAGE2') == '1' and os.path.exists(ccm_pth):
        stage2_cfg.models.resume = ccm_pth
        log('stage2 ENABLED (FABMESH_CRM_USE_STAGE2=1, extra ~6 GB VRAM)')
    else:
        stage2_cfg.models.resume = 'SKIP'
        log('stage2 skipped (saves ~6 GB VRAM); set FABMESH_CRM_USE_STAGE2=1 to enable')

    # CRM loads sub-configs via relative paths — chdir into its root.
    _cwd_save = os.getcwd()
    os.chdir(CRM_ROOT)
    try:
        from pipelines import TwoStagePipeline
        pipeline = TwoStagePipeline(
            stage1_cfg.models,
            stage2_cfg.models,
            stage1_cfg.sampler,
            stage2_cfg.sampler,
        )
    finally:
        os.chdir(_cwd_save)

    _subpct(20, 'stage1_infer')
    # Multi-seed + best-of-N (2026-04-18, agent recommendation):
    # CRM's fixed-seed DDIM sampler can mode-collapse on stylised inputs,
    # producing a wrong-but-confident back view. Running N seeds and
    # picking the best candidate per slot (via HSV histogram similarity
    # vs reference) kills most back-view hallucinations.
    seeds = [int(s.strip()) for s in os.environ.get(
        'FABMESH_CRM_SEEDS', '1234').split(',') if s.strip()]
    if len(seeds) == 1:
        log(f'running CRM stage 1 (scale={scale}, step={step}, seed={seeds[0]})...')
    else:
        log(f'running CRM stage 1 × {len(seeds)} seeds={seeds} '
            f'(scale={scale}, step={step})...')
    # Hook tqdm so DDIM steps drive the progress bar through 20..65.
    _orig_tqdm = _install_ddim_progress_hook(20, 65)
    per_seed = {}  # seed -> list of 6 PIL
    try:
        for si, s in enumerate(seeds):
            # Override sampler seed for this run
            try:
                pipeline.stage1_sampler.seed = s
            except Exception:
                pass
            rt = pipeline(crm_input, scale=scale, step=step)
            per_seed[s] = rt['stage1_images']
            log(f'  seed {s} done ({si+1}/{len(seeds)})')
    finally:
        _restore_tqdm(_orig_tqdm)

    if len(seeds) == 1:
        # Legacy single-seed path
        stage1_images = per_seed[seeds[0]]
    else:
        # Pick best seed per slot via HSV histogram similarity vs ref image
        stage1_images = _select_best_per_slot(per_seed, crm_input, seeds)
    log(f'stage 1 done, {len(stage1_images)} views selected')

    _subpct(70, 'upscale')
    # CRM outputs at 256×256. Upscale to target size with RealESRGAN x4
    # for sharpness (BSD-3, commercial-safe, already downloaded by Z123 path).
    # Fallback to LANCZOS if RealESRGAN not available.
    upscaled = {}
    try:
        from realesrgan import RealESRGANer
        from basicsr.archs.rrdbnet_arch import RRDBNet
        model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64,
                        num_block=23, num_grow_ch=32, scale=4)
        model_path = 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth'
        upsampler = RealESRGANer(
            scale=4, model_path=model_path, model=model,
            tile=0, tile_pad=10, pre_pad=0, half=True,
            device='cuda' if torch.cuda.is_available() else 'cpu')
        outscale = size / 256
        for src_idx in range(6):
            v = stage1_images[src_idx].convert('RGB')
            arr = np.asarray(v)
            out, _ = upsampler.enhance(arr, outscale=outscale)
            up = Image.fromarray(out)
            if up.size != (size, size):
                up = up.resize((size, size), Image.LANCZOS)
            upscaled[src_idx] = up
        del upsampler, model
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        log(f'RealESRGAN x4 upscale 256 -> {size} done')
    except Exception as ue:
        log(f'RealESRGAN skipped ({ue}); falling back to LANCZOS')
        for src_idx in range(6):
            v = stage1_images[src_idx]
            upscaled[src_idx] = v.resize((size, size), Image.LANCZOS) \
                if v.size[0] != size else v

    _subpct(85, 'save_views')
    views_meta = []
    for slot_idx, (src_idx, az, el) in enumerate(VIEW_MAPPING):
        v_up = upscaled[src_idx]
        # Remove grey background via threshold (grey is #7F7F7F).
        # Pixels close to (127,127,127) within 25 → alpha=0.
        arr = np.array(v_up.convert('RGB'))
        dist = np.linalg.norm(arr.astype(float) - np.array([127, 127, 127]), axis=2)
        alpha = (dist > 25).astype(np.uint8) * 255
        rgba = np.dstack([arr, alpha])
        Image.fromarray(rgba, 'RGBA').save(
            os.path.join(output_dir, f'view_{slot_idx}.png'))
        views_meta.append({'azim': az, 'elev': el})
        log(f'  view_{slot_idx}: az={az:6.1f}° el={el:5.1f}° <- stage1[{src_idx}]')

    # Write schema file so texture_project can read it
    with open(os.path.join(output_dir, 'views.json'), 'w', encoding='utf-8') as f:
        json.dump({'engine': 'crm', 'views': views_meta}, f, indent=2)

    elapsed = time.time() - t0
    _subpct(95, 'done')
    log(f'MULTIVIEW_PROGRESS: 95 crm_done')
    slog.info('pipeline_done', total_ms=int(elapsed * 1000),
              engine='crm', views=len(VIEW_MAPPING))
    log(f'done in {elapsed:.1f}s')
    _subpct(100, 'finish')
    return True


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('input_image')
    ap.add_argument('output_dir')
    ap.add_argument('--size', type=int, default=1024,
                    help='Final output resolution per view (CRM native is 256)')
    ap.add_argument('--scale', type=float, default=5.5)
    ap.add_argument('--step', type=int, default=50)
    args = ap.parse_args()

    try:
        ok = generate(args.input_image, args.output_dir,
                      scale=args.scale, step=args.step, size=args.size)
        sys.exit(0 if ok else 1)
    except Exception as e:
        log(f'ERROR: {type(e).__name__}: {e}')
        import traceback
        traceback.print_exc()
        sys.exit(2)
