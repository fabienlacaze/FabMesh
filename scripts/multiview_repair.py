"""
FabMesh multi-view repair pass.

After a multi-view generator (CRM, Z123, SDXL...) produces 6 views, some
views are often hallucinated — especially TOP/BOTTOM on non-compact
subjects (children, quadrupeds) where the base model has weak priors.

This script:
  1. Reads <mv_dir>/input.png (reference) + view_0..5.png + views.json
  2. Scores each view for "hallucination likelihood":
       - dark_mass: % of very-dark pixels inside subject alpha
       - sat_extreme: % of fully-saturated red/orange pixels
       - palette_dist: cosine-sim drop vs ref HSV histogram
     weirdness = 0.4*dark + 0.3*sat + 0.3*(1-palette_sim)
  3. Builds a mask of bad regions in each flagged view (dark + saturated)
  4. Runs SDXL Inpaint with IPAdapter-Plus (ref as condition) per flagged
     view, using slot-aware prompts (top-down / bottom-up / profile etc.)
  5. Saves backup of originals in <mv_dir>/.repair_backup/
  6. Writes repaired views back in place

CLI:
    python multiview_repair.py <mv_dir> [--threshold 0.55] [--force-slots 4,5]
    --force-slots bypasses the detector and repairs those slots unconditionally.

License: Apache 2.0 components only (SDXL-Inpainting, RealVisXL, IP-Adapter).
"""
from __future__ import annotations
import os
import sys
import json
import time
import shutil
import argparse
import numpy as np
from PIL import Image, ImageFilter


def log(msg):
    print(f'[mv_repair] {msg}', flush=True)


def _subpct(pct, label=''):
    pct = int(pct)
    print(f'FABMESH_SUBPCT: {pct} {label}', flush=True)


# Slot metadata — prompt suffix + IPAdapter scale per orientation.
# Lower scale = more freedom for SDXL to generate novel view; higher =
# hugs ref identity. TOP/BOTTOM need medium scale — pure ref bias would
# just repaint a frontal face from above.
SLOT_META = {
    0: {'name': 'front',  'prompt': 'front view, facing camera',              'ip_scale': 0.75},
    1: {'name': 'right',  'prompt': 'right side profile, 90 degrees side',    'ip_scale': 0.60},
    2: {'name': 'back',   'prompt': 'back view, from behind',                 'ip_scale': 0.65},
    3: {'name': 'left',   'prompt': 'left side profile, 90 degrees side',     'ip_scale': 0.60},
    4: {'name': 'top',    'prompt': 'orthographic top-down view, head and shoulders visible from directly above, bird eye view',   'ip_scale': 0.70},
    5: {'name': 'bottom', 'prompt': 'orthographic bottom-up view, soles of feet and underside visible, worm eye view', 'ip_scale': 0.70},
}


def _ref_stats(ref_rgb: Image.Image) -> dict:
    """Compute ref's own dark/hot ratios on its foreground so views can be
    compared against the subject's natural palette (a zebra has lots of
    black legitimately; a child does not)."""
    arr = np.asarray(ref_rgb.convert('RGB')).astype(np.float32)
    lum = arr.mean(axis=2)
    fg = (lum > 25) & (lum < 245)
    if fg.sum() < 100:
        return {'dark': 0.0, 'hot': 0.0}
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    dark = ((lum < 40) & fg).sum() / fg.sum()
    hot = (((r > 180) & (r - g > 50) & (r - b > 50) & fg)).sum() / fg.sum()
    return {'dark': float(dark), 'hot': float(hot)}


def _score_view(view_rgba: Image.Image, ref_rgb: Image.Image,
                ref_stats: dict | None = None) -> dict:
    """Return dict with weirdness components + overall score in [0..1].
    If ref_stats is provided, dark/sat ratios are compared against ref's
    own natural ratio so a naturally dark subject is not flagged."""
    arr = np.asarray(view_rgba.convert('RGBA'))
    rgb = arr[..., :3].astype(np.float32)
    alpha = arr[..., 3]
    fg_mask = alpha > 32
    if fg_mask.sum() < 100:
        return {'weirdness': 1.0, 'dark': 1.0, 'sat': 0.0, 'palette_sim': 0.0,
                'reason': 'empty'}

    lum = rgb.mean(axis=2)
    dark = (lum < 40) & fg_mask
    dark_ratio = dark.sum() / max(1, fg_mask.sum())

    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    hot = (r > 180) & (r - g > 50) & (r - b > 50) & fg_mask
    sat_ratio = hot.sum() / max(1, fg_mask.sum())

    # Normalize against ref's natural ratios — "excess" is what matters.
    # 5% slack so near-equal ratios aren't flagged.
    if ref_stats is not None:
        dark_excess = max(0.0, dark_ratio - ref_stats['dark'] - 0.05)
        sat_excess = max(0.0, sat_ratio - ref_stats['hot'] - 0.05)
    else:
        dark_excess = dark_ratio
        sat_excess = sat_ratio

    # palette similarity vs ref — foreground pixels only on both sides.
    # Ref foreground = non-near-grey, non-near-black, non-near-white.
    ref_arr = np.asarray(ref_rgb.convert('RGB').resize(view_rgba.size, Image.LANCZOS))
    ref_lum = ref_arr.mean(axis=2)
    ref_fg_mask = (ref_lum > 25) & (ref_lum < 245)
    if ref_fg_mask.sum() < 100:
        palette_sim = 1.0  # nothing to compare, don't penalize
    else:
        h_view, _ = np.histogramdd(rgb[fg_mask].reshape(-1, 3),
                                   bins=16, range=[[0, 256]]*3)
        h_ref, _ = np.histogramdd(ref_arr[ref_fg_mask].reshape(-1, 3).astype(np.float32),
                                  bins=16, range=[[0, 256]]*3)
        hv = h_view.ravel(); hr = h_ref.ravel()
        denom = np.linalg.norm(hv) * np.linalg.norm(hr)
        palette_sim = float(np.dot(hv, hr) / denom) if denom > 1e-8 else 0.0

    # Hard-trigger bumps for unambiguous defects — excess (not raw) above
    # what the ref itself exhibits. Anchoring to ref prevents naturally
    # dark subjects (zebra, panda) being flagged for their own stripes.
    hard_dark = 1.0 if dark_excess > 0.08 else 0.0
    hard_sat  = 1.0 if sat_excess  > 0.05 else 0.0

    base = 0.4 * dark_excess + 0.3 * sat_excess + 0.3 * (1 - palette_sim)
    weirdness = min(1.0, base + 0.4 * max(hard_dark, hard_sat))
    return {
        'weirdness': float(weirdness),
        'dark': float(dark_ratio),
        'sat': float(sat_ratio),
        'palette_sim': float(palette_sim),
    }


def _build_repair_mask(view_rgba: Image.Image, score: dict,
                       force_full_fg: bool = False) -> Image.Image:
    """Mask in {0,255} of pixels that need repainting.

    Strategy depends on how wrong the view is:
      - force_full_fg=True or weirdness >= 0.70 -> repaint entire
        foreground. The surrounding pixels are themselves hallucinated,
        so leaving them as context drags SDXL back to the same wrong
        answer.
      - weirdness < 0.70 -> repaint just the dark + hot-saturated
        defect regions with a halo for blending.
    """
    arr = np.asarray(view_rgba.convert('RGBA'))
    rgb = arr[..., :3]
    alpha = arr[..., 3]
    fg = alpha > 32

    # Full-FG is destructive: SDXL regenerates the whole subject and can
    # produce a shape different from the original silhouette, leaving
    # "ghost" alpha outline. Only trigger it when the view is truly
    # garbage (pitch-black mass AND palette completely drifted) or the
    # user explicitly forces it via --full-fg.
    very_bad = (score['weirdness'] >= 0.85 and score['palette_sim'] < 0.05)
    if force_full_fg or very_bad:
        # Strictly inside alpha — NO dilation, minimal blur. Dilation
        # gives SDXL pixels outside the subject silhouette to paint,
        # which creates "shadow clone" ghosts when IPAdapter pulls
        # the composition toward a different pose.
        mask = fg.astype(np.uint8) * 255
        m_img = Image.fromarray(mask, mode='L')
        m_img = m_img.filter(ImageFilter.GaussianBlur(1.5))
    else:
        lum = rgb.mean(axis=2)
        dark = (lum < 40) & fg
        r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
        hot = (r > 180) & (r - g > 50) & (r - b > 50) & fg
        mask = (dark | hot).astype(np.uint8) * 255
        m_img = Image.fromarray(mask, mode='L')
        m_img = m_img.filter(ImageFilter.MaxFilter(9))
        m_img = m_img.filter(ImageFilter.GaussianBlur(4))
    return m_img


def repair(mv_dir, threshold=0.55, force_slots=None, steps=35,
           full_fg=False, strength=0.95):
    import torch
    from diffusers import StableDiffusionXLInpaintPipeline
    from transformers import CLIPVisionModelWithProjection

    t0 = time.time()
    ref_path = os.path.join(mv_dir, 'input.png')
    if not os.path.exists(ref_path):
        raise FileNotFoundError(f'missing ref: {ref_path}')
    ref_img = Image.open(ref_path).convert('RGB')
    log(f'ref size: {ref_img.size}')

    views_json = os.path.join(mv_dir, 'views.json')
    if os.path.exists(views_json):
        with open(views_json, 'r', encoding='utf-8') as f:
            views_meta = json.load(f)
        log(f'engine={views_meta.get("engine")}')
    else:
        views_meta = {}

    # Compute ref-own baseline first
    rs = _ref_stats(ref_img)
    log(f'ref baseline: dark={rs["dark"]:.3f} hot={rs["hot"]:.3f}')

    # Score every view
    scored = []
    for slot in range(6):
        vp = os.path.join(mv_dir, f'view_{slot}.png')
        if not os.path.exists(vp):
            log(f'  view_{slot}: MISSING, skipping')
            scored.append(None)
            continue
        v = Image.open(vp).convert('RGBA')
        s = _score_view(v, ref_img, ref_stats=rs)
        log(f'  view_{slot} ({SLOT_META[slot]["name"]}): '
            f'weirdness={s["weirdness"]:.3f} dark={s["dark"]:.3f} '
            f'sat={s["sat"]:.3f} palette_sim={s["palette_sim"]:.3f}')
        scored.append((v, s))

    # Decide repair targets
    if force_slots is not None:
        targets = set(force_slots)
        log(f'FORCE mode: repairing slots={sorted(targets)}')
    else:
        # Require BOTH high weirdness AND a real defect signal
        # (dark/sat excess). Pure palette drift alone is likely noise
        # (different generator fingerprint, not hallucination) —
        # repairing those views tends to replace good content with
        # same-or-worse content.
        targets = set()
        for i, r in enumerate(scored):
            if r is None:
                continue
            s = r[1]
            hard_defect = s['dark'] > 0.15 or s['sat'] > 0.05
            if s['weirdness'] > threshold and hard_defect:
                targets.add(i)
        log(f'AUTO mode (threshold={threshold}, '
            f'needs dark>15% or sat>5%): repairing slots={sorted(targets)}')

    if not targets:
        log('nothing to repair')
        return True

    # Backup originals
    backup_dir = os.path.join(mv_dir, '.repair_backup')
    os.makedirs(backup_dir, exist_ok=True)
    for slot in targets:
        src = os.path.join(mv_dir, f'view_{slot}.png')
        dst = os.path.join(backup_dir, f'view_{slot}.png')
        if not os.path.exists(dst):  # keep oldest
            shutil.copy2(src, dst)
    log(f'backed up originals to {backup_dir}')

    # VRAM cap
    if torch.cuda.is_available():
        frac = float(os.environ.get('FABMESH_VRAM_FRACTION', '0.95'))
        if 0.1 <= frac < 1.0:
            try:
                torch.cuda.set_per_process_memory_fraction(frac)
            except Exception:
                pass

    _subpct(10, 'load_pipeline')
    log('loading SDXL Inpaint + IPAdapter-Plus...')
    image_encoder = CLIPVisionModelWithProjection.from_pretrained(
        'h94/IP-Adapter', subfolder='models/image_encoder',
        torch_dtype=torch.float16)

    pipe = StableDiffusionXLInpaintPipeline.from_pretrained(
        'diffusers/stable-diffusion-xl-1.0-inpainting-0.1',
        torch_dtype=torch.float16, variant='fp16',
        image_encoder=image_encoder)
    # Force fp16 on sub-modules (diffusers 0.34 buffers leak fp32)
    pipe.unet.to(torch.float16)
    pipe.vae.to(torch.float16)
    pipe.text_encoder.to(torch.float16)
    pipe.text_encoder_2.to(torch.float16)

    pipe.load_ip_adapter(
        'h94/IP-Adapter', subfolder='sdxl_models',
        weight_name='ip-adapter-plus_sdxl_vit-h.safetensors')
    pipe.enable_model_cpu_offload()
    pipe.enable_vae_tiling()
    log(f'pipeline ready ({time.time()-t0:.1f}s)')

    seed = int(time.time()) & 0xFFFFFFFF
    log(f'seed={seed}')

    per_view_pct = 80 // max(1, len(targets))
    progress = 10
    for slot in sorted(targets):
        slot_meta = SLOT_META[slot]
        v_img, score = scored[slot]
        log(f'-- repairing view_{slot} ({slot_meta["name"]}) '
            f'w={score["weirdness"]:.3f}')

        mask = _build_repair_mask(v_img, score, force_full_fg=full_fg)
        mc = (np.array(mask) > 128).mean() * 100
        log(f'   mask coverage: {mc:.1f}%')
        if mc < 1.0:
            log('   mask too small, skipping')
            continue

        # Inpaint size: keep view size but snap to /8
        w, h = v_img.size
        w8 = (w // 8) * 8; h8 = (h // 8) * 8
        v_work = v_img.convert('RGB').resize((w8, h8), Image.LANCZOS)
        m_work = mask.resize((w8, h8), Image.BILINEAR)

        ip_scale = slot_meta['ip_scale']
        pipe.set_ip_adapter_scale(ip_scale)

        prompt = (
            f"{slot_meta['prompt']}, same character, same outfit, "
            f"full body centered, plain light gray background, "
            f"studio lighting, sharp focus, ultra detailed, 8k, masterpiece"
        )
        negative = (
            "blurry, low quality, deformed, extra limbs, bad anatomy, "
            "distorted, different person, different clothes, duplicate, "
            "multiple people, text, watermark, black mass, artifact"
        )

        result = pipe(
            prompt=prompt,
            negative_prompt=negative,
            image=v_work,
            mask_image=m_work,
            ip_adapter_image=ref_img,
            num_inference_steps=steps,
            guidance_scale=7.5,
            strength=strength,
            height=h8, width=w8,
            generator=torch.Generator('cuda').manual_seed(seed + slot),
        ).images[0]

        # Re-apply original alpha (SDXL Inpaint outputs RGB only).
        # ALSO zero-out the RGB outside the alpha silhouette to suppress
        # "shadow clone" ghosts that SDXL paints in the mask's blurred
        # halo. Without this the view shows a phantom copy of the
        # subject outside its real silhouette.
        orig_rgba = np.asarray(v_img.resize((w8, h8), Image.LANCZOS).convert('RGBA'))
        new_rgb = np.asarray(result).copy()
        alpha = orig_rgba[..., 3]
        outside = alpha <= 32
        new_rgb[outside] = 0  # black-out-of-silhouette
        out = np.dstack([new_rgb, alpha])
        out_img = Image.fromarray(out, 'RGBA')
        if out_img.size != v_img.size:
            out_img = out_img.resize(v_img.size, Image.LANCZOS)

        out_path = os.path.join(mv_dir, f'view_{slot}.png')
        out_img.save(out_path)
        log(f'   saved {out_path}')
        progress += per_view_pct
        _subpct(min(progress, 95), f'view_{slot}_done')

        del result
        torch.cuda.empty_cache()

    del pipe
    torch.cuda.empty_cache()
    import gc; gc.collect(); torch.cuda.empty_cache()
    _subpct(100, 'done')
    log(f'repair done in {time.time()-t0:.1f}s')
    return True


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('mv_dir', help='multi-view directory with views.json + view_*.png')
    ap.add_argument('--threshold', type=float, default=0.55)
    ap.add_argument('--force-slots',
                    help='comma-separated slots to force-repair, e.g. "4,5"')
    ap.add_argument('--steps', type=int, default=35)
    ap.add_argument('--full-fg', action='store_true',
                    help='Force full-foreground mask on all targeted slots '
                         '(useful when defects are structural, not just dark blobs)')
    ap.add_argument('--strength', type=float, default=0.95,
                    help='Inpaint strength (1.0 = ignore existing pixels entirely)')
    args = ap.parse_args()

    force = None
    if args.force_slots:
        force = [int(s.strip()) for s in args.force_slots.split(',') if s.strip()]

    try:
        ok = repair(args.mv_dir, threshold=args.threshold,
                    force_slots=force, steps=args.steps,
                    full_fg=args.full_fg, strength=args.strength)
        sys.exit(0 if ok else 1)
    except Exception as e:
        log(f'ERROR: {type(e).__name__}: {e}')
        import traceback; traceback.print_exc()
        sys.exit(2)
