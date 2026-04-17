"""
FabMesh Multi-View Generation — generate 6 consistent views from a single image.
================================================================================

Uses Zero123++ v1.2 (Apache 2.0, commercial-safe) to generate 6 views
(front, front-right, right, back, left, front-left) from a single input image.

These views are then used by texture_project.py to create a high-quality
texture atlas covering the entire mesh surface.

Usage:
    python multiview_gen.py <input_image> <output_dir> [--size 320]

Output:
    <output_dir>/view_0.png  (front-right, 30°)
    <output_dir>/view_1.png  (right, 90°)
    <output_dir>/view_2.png  (back-right, 150°)
    <output_dir>/view_3.png  (back, 210°)
    <output_dir>/view_4.png  (left, 270°)
    <output_dir>/view_5.png  (front-left, 330°)
    <output_dir>/input.png   (copy of input, front 0°)

Model: sudo-ai/zero123plus-v1.2 (~4 GB, downloaded on first run)
License: Apache 2.0
"""
import sys
import os
import time
import torch
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fabmesh_log import Logger


def log(msg):
    # Legacy thin wrapper — new sites should use the structured Logger.
    print(f'[multiview] {msg}', flush=True)


def generate_multiview(input_image_path, output_dir, size=320):
    """Generate 6 views from a single input image using Zero123++ v1.2."""
    t0 = time.time()
    slog = Logger(
        'multiview',
        input=os.path.basename(input_image_path),
        project=os.path.basename(os.path.dirname(input_image_path)),
        outDir=os.path.basename(output_dir),
    )
    slog.info('pipeline_started',
              input_path=input_image_path,
              output_dir=output_dir,
              target_tile_size=size,
              torch_cuda=torch.cuda.is_available(),
              vram_free_gb=(torch.cuda.mem_get_info()[0] / 1e9
                            if torch.cuda.is_available() else None))
    log(f'input={input_image_path}')
    log(f'output_dir={output_dir}')
    os.makedirs(output_dir, exist_ok=True)

    # Load input image. If it still has a background (RGB or RGBA where the
    # alpha is fully opaque), run rembg on it BEFORE Zero123++ so the model
    # doesn't hallucinate the backdrop into the 6 generated views and so
    # texture_project.py samples transparent-away-from-subject pixels.
    raw_input = Image.open(input_image_path)
    needs_rembg = True
    if raw_input.mode == 'RGBA':
        # If alpha is already non-trivial (not all 255), skip rembg
        alpha = np.asarray(raw_input.split()[-1])
        if (alpha < 255).any():
            needs_rembg = False
            slog.info('input_has_alpha_already', min_alpha=int(alpha.min()))

    if needs_rembg:
        try:
            with slog.timed('rembg_input'):
                from rembg import remove as rembg_remove
                raw_input_rgb = raw_input.convert('RGB')
                input_img_rgba = rembg_remove(raw_input_rgb)
            slog.info('rembg_input_done', mode=input_img_rgba.mode)
        except Exception as re_err:
            slog.warn('rembg_input_failed', reason=str(re_err)[:200])
            input_img_rgba = raw_input.convert('RGBA')
    else:
        input_img_rgba = raw_input.convert('RGBA')

    # Zero123++ wants RGB; composite the transparent input onto white so the
    # remaining pixels stay photometric while the background is now neutral
    # and small, not a distracting grey studio floor.
    bg = Image.new('RGB', input_img_rgba.size, (255, 255, 255))
    bg.paste(input_img_rgba, mask=input_img_rgba.split()[-1])
    input_img = bg
    slog.info('input_loaded', w=input_img.size[0], h=input_img.size[1],
              rembg=needs_rembg)
    log(f'input size: {input_img.size} (rembg={needs_rembg})')

    # Resize to expected input size (320x320 for Zero123++)
    input_img_resized = input_img.resize((size, size), Image.LANCZOS)

    # Save the CLEAN RGBA input (alpha intact) so downstream tools —
    # texture_project.py in particular — can use its alpha to mask away
    # background pixels when sampling.
    input_img_rgba.save(os.path.join(output_dir, 'input.png'))

    log('loading Zero123++ v1.2 pipeline...')
    slog.progress(10, 'load_pipeline')

    from diffusers import DiffusionPipeline, EulerAncestralDiscreteScheduler

    with slog.timed('pipeline_load', model='sudo-ai/zero123plus-v1.2'):
        pipeline = DiffusionPipeline.from_pretrained(
            "sudo-ai/zero123plus-v1.2",
            custom_pipeline="sudo-ai/zero123plus-pipeline",
            torch_dtype=torch.float16,
        )
        pipeline.scheduler = EulerAncestralDiscreteScheduler.from_config(
            pipeline.scheduler.config, timestep_spacing='trailing'
        )
        pipeline.to('cuda' if torch.cuda.is_available() else 'cpu')

    log(f'pipeline loaded in {time.time()-t0:.1f}s')
    slog.progress(40, 'generate_views')

    # Generate 6 views
    log('generating 6 views...')
    with slog.timed('inference', steps=100, guidance_scale=4.0):
        with torch.no_grad():
            result = pipeline(
                input_img_resized,
                num_inference_steps=100,
                guidance_scale=4.0,
            ).images[0]

    log(f'generation done in {time.time()-t0:.1f}s')
    slog.info('grid_produced', w=result.size[0], h=result.size[1])
    slog.progress(80, 'grid_ready')

    # Zero123++ v1.2 outputs a 640x960 grid = 2 columns x 3 rows of 320x320 tiles
    # Layout (left to right, top to bottom):
    #   [0] 30°  front-right   [1] 90°  right
    #   [2] 150° back-right    [3] 210° back-left
    #   [4] 270° left          [5] 330° front-left
    w, h = result.size
    n_cols = 2
    n_rows = 3
    tile_w = w // n_cols
    tile_h = h // n_rows

    view_names = ['view_0', 'view_1', 'view_2', 'view_3', 'view_4', 'view_5']
    view_tiles = []
    for i in range(6):
        row = i // n_cols
        col = i % n_cols
        x = col * tile_w
        y = row * tile_h
        view_tiles.append(result.crop((x, y, x + tile_w, y + tile_h)))

    # ---------------------------------------------------------------
    # Upscale views 320 → 1280 using RealESRGAN (BSD-3, commercial-safe)
    # Preserves fine details (faces, patterns) that would otherwise be
    # blurry when projected onto the 2048px texture atlas.
    # ---------------------------------------------------------------
    upscaled_tiles = view_tiles
    try:
        log('MULTIVIEW_PROGRESS: 85 upscaling')
        slog.progress(85, 'upscaling')
        with slog.timed('realesrgan_upscale', source_tile=tile_w, target=1024):
            from realesrgan import RealESRGANer
            from basicsr.archs.rrdbnet_arch import RRDBNet
            # numpy is already imported at module top; re-importing locally
            # would shadow it for the whole function and break the alpha
            # check earlier in the function.

            model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=4)
            model_path = 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth'
            upsampler = RealESRGANer(
                scale=4, model_path=model_path, model=model,
                tile=0, tile_pad=10, pre_pad=0, half=True,
                device='cuda' if torch.cuda.is_available() else 'cpu',
            )
            upscaled_tiles = []
            target_size = 1024
            outscale = target_size / tile_w
            for i, tile in enumerate(view_tiles):
                t_start = time.time()
                arr = np.asarray(tile.convert('RGB'))
                out, _ = upsampler.enhance(arr, outscale=outscale)
                up = Image.fromarray(out)
                if up.size != (target_size, target_size):
                    up = up.resize((target_size, target_size), Image.LANCZOS)
                upscaled_tiles.append(up)
                slog.info('view_upscaled', view=i,
                          w=up.size[0], h=up.size[1],
                          ms=int((time.time() - t_start) * 1000))
                log(f'upscaled view_{i} to {up.size}')
            del upsampler, model
            if torch.cuda.is_available(): torch.cuda.empty_cache()
    except Exception as ue:
        slog.warn('realesrgan_skipped', reason=str(ue)[:200])
        log(f'RealESRGAN upscale skipped ({ue}); using raw 320px tiles')
        upscaled_tiles = view_tiles

    # Remove the Zero123++ gray background so projection doesn't sample it.
    # Without this, the texture atlas gets dominated by flat gray.
    try:
        log('MULTIVIEW_PROGRESS: 88 bg-removal')
        slog.progress(88, 'bg_removal')
        with slog.timed('rembg_all_views'):
            from rembg import remove as rembg_remove
            cleaned = []
            for i, tile in enumerate(upscaled_tiles):
                t_start = time.time()
                cleaned.append(rembg_remove(tile.convert('RGB')))
                slog.info('view_bg_removed', view=i, mode=cleaned[-1].mode,
                          ms=int((time.time() - t_start) * 1000))
                log(f'bg removed view_{i} mode={cleaned[-1].mode}')
            upscaled_tiles = cleaned
    except Exception as be:
        slog.warn('rembg_skipped', reason=str(be)[:200])
        log(f'rembg bg removal skipped ({be})')

    # ------------------------------------------------------------------
    # Style harmonization pass
    # ------------------------------------------------------------------
    # Zero123++ v1.2 produces views that look slightly cartoon-rendered
    # compared to a photorealistic input image — the model was trained on
    # the Objaverse synthetic renders and imposes that look on everything.
    # Baking this mix into the atlas gives a texture whose front (from the
    # source photo) is photorealistic but whose back/sides (from Zero123++)
    # look like they belong to a different character.
    #
    # Fix: after rembg, pass each view through SDXL img2img (RealVisXL)
    # at strength 0.35 with a "photorealistic, matches reference" prompt,
    # using the always-on SDXL server (http://127.0.0.1:5555/img2img)
    # when available. Falls through silently if the server is down —
    # the pipeline still works, it just skips the harmonization.
    try:
        import requests as _rq
        if _rq.get('http://127.0.0.1:5555/ping', timeout=1.5).status_code == 200:
            slog.progress(89, 'style_harmonize')
            log('MULTIVIEW_PROGRESS: 89 style-harmonize')
            # Prompt keeps subject identity neutral; bridge supplies a
            # subject prompt via env when available (FABMESH_REFINE_PROMPT).
            subject = os.environ.get('FABMESH_REFINE_PROMPT', '').strip()
            style_prompt = (
                (subject + ', ' if subject else '')
                + 'photorealistic, sharp focus, natural materials, '
                  'consistent with reference photo, 8k detail'
            )
            harmonized = []
            t_style_start = time.time()
            for i, tile in enumerate(upscaled_tiles):
                _tmp_in = os.path.join(output_dir, f'.style_in_{i}.png')
                _tmp_out = os.path.join(output_dir, f'.style_out_{i}.png')
                tile.convert('RGBA').save(_tmp_in)
                try:
                    r = _rq.post(
                        'http://127.0.0.1:5555/img2img',
                        json={'input': _tmp_in, 'output': _tmp_out,
                              'prompt': style_prompt, 'strength': 0.35},
                        timeout=180,
                    )
                    j = r.json()
                    if j.get('ok'):
                        new_rgb = Image.open(_tmp_out).convert('RGB')
                        if new_rgb.size != tile.size:
                            new_rgb = new_rgb.resize(tile.size, Image.LANCZOS)
                        # Preserve the original alpha (rembg'd) so projection
                        # still knows which pixels are subject vs background.
                        if tile.mode == 'RGBA':
                            alpha = tile.split()[-1]
                            new_rgba = new_rgb.convert('RGBA')
                            new_rgba.putalpha(alpha)
                            harmonized.append(new_rgba)
                        else:
                            harmonized.append(new_rgb)
                        slog.info('view_style_harmonized', view=i,
                                  strength=0.35)
                    else:
                        log(f'style harmonize view_{i} failed '
                            f'({j.get("error")}), keeping original')
                        harmonized.append(tile)
                except Exception as _se:
                    log(f'style harmonize view_{i} error ({_se}), '
                        f'keeping original')
                    harmonized.append(tile)
                finally:
                    for _p in (_tmp_in, _tmp_out):
                        try: os.remove(_p)
                        except Exception: pass
            upscaled_tiles = harmonized
            slog.info('style_harmonize_done',
                      ms=int((time.time() - t_style_start) * 1000))
            log(f'style-harmonized 6 views in '
                f'{time.time() - t_style_start:.1f}s')
        else:
            log('SDXL server not responding — skipping style harmonization')
    except Exception as _he:
        slog.warn('style_harmonize_skipped', reason=str(_he)[:200])
        log(f'style harmonization skipped ({_he})')

    for i, tile in enumerate(upscaled_tiles):
        view_path = os.path.join(output_dir, f'{view_names[i]}.png')
        tile.save(view_path)
        size_bytes = os.path.getsize(view_path)
        slog.info('view_saved', view=i, path=view_path,
                  w=tile.size[0], h=tile.size[1], mode=tile.mode,
                  bytes=size_bytes)
        log(f'saved {view_names[i]}.png ({tile.size} mode={tile.mode})')

    slog.progress(90, 'cleanup')

    # Free GPU
    del pipeline
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    elapsed = time.time() - t0
    slog.info('pipeline_done', total_ms=int(elapsed * 1000),
              views_saved=len(upscaled_tiles))
    log(f'done in {elapsed:.1f}s')
    slog.progress(100, 'done')
    return True


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python multiview_gen.py <input_image> <output_dir> [--size 320]")
        sys.exit(1)

    input_path = sys.argv[1]
    output_dir = sys.argv[2]
    size = 320
    if '--size' in sys.argv:
        idx = sys.argv.index('--size')
        size = int(sys.argv[idx + 1])

    try:
        ok = generate_multiview(input_path, output_dir, size)
        sys.exit(0 if ok else 1)
    except Exception as e:
        # Best-effort structured error (Logger may have been created inside
        # generate_multiview and lost; emit a raw event line here too).
        import traceback
        from datetime import datetime, timezone
        tb = traceback.format_exc()
        print(f'[{datetime.now(timezone.utc).isoformat()}] level=ERROR '
              f'component=multiview event=fatal '
              f'error={type(e).__name__} msg="{str(e)[:200]}"', flush=True)
        log(f'ERROR: {type(e).__name__}: {e}')
        traceback.print_exc()
        sys.exit(2)
