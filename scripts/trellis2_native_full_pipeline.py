"""TRELLIS-2 native image-to-3D pipeline (single-shot mesh + PBR).

Default engine of FabMesh since 2026-05-19. Replaces the previous
Hi3DGen + TRELLIS-2 texturing two-stage pipeline.

Uses microsoft/TRELLIS.2-4B's Trellis2ImageTo3DPipeline which generates
geometry and texture jointly from a single input image. Validated at
~100s on RTX 5080 (16 GB) with mode '1024' and VRAM peak ~3 GB.

Pipeline:
  1. Auto-patch HF cache (briaai/RMBG-2.0 [gated] -> ZhengPeng7/BiRefNet [Apache])
  2. rembg u2net image pre-processing (skip TRELLIS-2 internal rembg)
  3. Trellis2ImageTo3DPipeline.run(mode='1024', preprocess_image=False)
  4. o_voxel.postprocess.to_glb (Kaolin shim, commercial-safe)
  5. Auto-brighten baseColor texture (under-lit in ACES viewers)
  6. EU AI Act art. 50 metadata

Configurable via env:
  FABMESH_TRELLIS2_NATIVE_MODE      '512' / '1024' / '1024_cascade'  (default '1024')
  FABMESH_TRELLIS2_NATIVE_SEED      int (default 42)
  FABMESH_TRELLIS2_NATIVE_DECIM     decimation target faces (default 500000)
  FABMESH_TRELLIS2_SKIP_BRIGHTEN    1 to disable auto-brighten

Usage:
    python trellis2_native_full_pipeline.py <input_image> <out_glb> [tex_res=2048]
"""
import os
os.environ.setdefault('TRELLIS2_USE_KAOLIN_RASTER', '1')
os.environ.setdefault('PYTORCH_CUDA_ALLOC_CONF', 'expandable_segments:True')
os.environ.setdefault('TORCHDYNAMO_DISABLE', '1')
# Force PyTorch native scaled_dot_product_attention so we don't load
# flash_attn / xformers compiled CUDA extensions — Windows Smart App
# Control blocks unsigned .pyd files (flash_attn_2_cuda.dll etc.). SDPA
# is built into torch itself and ships in the signed torch wheel, so it
# always loads. Slight perf hit (~20%) vs flash_attn 2.x but reliable.
os.environ.setdefault('ATTN_BACKEND', 'sdpa')
os.environ.setdefault('SPARSE_ATTN_BACKEND', 'sdpa')
os.environ.setdefault('TORCHINDUCTOR_USE_TRITON', '0')
os.environ.setdefault('TRANSFORMERS_ATTN_IMPLEMENTATION', 'eager')

import sys
import time

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
TRELLIS2_SRC = os.path.abspath(os.path.join(
    SCRIPTS, '..', 'external', 'TRELLIS2_win', 'src'))
sys.path.insert(0, TRELLIS2_SRC)
sys.path.insert(0, SCRIPTS)  # for add_ai_metadata


def log(msg):
    print(f'[t2_native] {msg}', flush=True)


def _patch_rmbg_in_hf_cache():
    """Replace briaai/RMBG-2.0 (gated, commercial-restricted) by
    ZhengPeng7/BiRefNet (Apache 2.0) in the cached TRELLIS.2-4B pipeline.json.
    Idempotent — runs every launch but only writes on first."""
    try:
        from huggingface_hub import snapshot_download
        cache_root = snapshot_download(
            'microsoft/TRELLIS.2-4B',
            allow_patterns=['pipeline.json'],
        )
    except Exception as e:
        log(f'WARN: HF cache lookup failed: {e}')
        return
    pipeline_json = os.path.join(cache_root, 'pipeline.json')
    if not os.path.isfile(pipeline_json):
        return
    with open(pipeline_json, 'r', encoding='utf-8') as f:
        content = f.read()
    if 'briaai/RMBG-2.0' in content:
        backup = pipeline_json + '.bak_native'
        if not os.path.isfile(backup):
            with open(backup, 'w', encoding='utf-8') as f:
                f.write(content)
        new_content = content.replace(
            'briaai/RMBG-2.0', 'ZhengPeng7/BiRefNet')
        with open(pipeline_json, 'w', encoding='utf-8') as f:
            f.write(new_content)
        log('patched HF cache: briaai/RMBG-2.0 -> ZhengPeng7/BiRefNet')


def _prep_image(path):
    """Background removal via rembg u2net (Apache 2.0) — skip TRELLIS-2's
    internal rembg which uses the gated briaai/RMBG-2.0."""
    from PIL import Image
    import numpy as np
    image = Image.open(path)
    needs_rembg = True
    if image.mode == 'RGBA':
        a = np.asarray(image)[:, :, 3]
        if not (a == 255).all():
            needs_rembg = False
    if needs_rembg:
        log('rembg u2net (background removal)...')
        import rembg
        image = rembg.remove(
            image.convert('RGBA'),
            session=rembg.new_session('u2net'))
    return image


def _brighten_baseColor(glb_obj):
    """Apply +50% brightness, +30% sat, +10% contrast to baseColorTexture
    in-place. Compensates for ACES tonemapping in glTF viewers (model-viewer)."""
    try:
        from PIL import ImageEnhance
        geoms = (list(glb_obj.geometry.values())
                 if hasattr(glb_obj, 'geometry') else [glb_obj])
        n = 0
        for m in geoms:
            visual = getattr(m, 'visual', None)
            if not visual:
                continue
            material = getattr(visual, 'material', None)
            if not material:
                continue
            tex = getattr(material, 'baseColorTexture', None)
            if not tex:
                continue
            tex = ImageEnhance.Brightness(tex).enhance(1.5)
            tex = ImageEnhance.Color(tex).enhance(1.3)
            tex = ImageEnhance.Contrast(tex).enhance(1.1)
            material.baseColorTexture = tex
            n += 1
        if n:
            log(f'auto-brighten: x1.5/x1.3/x1.1 ({n} material(s))')
    except Exception as e:
        log(f'brighten skipped: {type(e).__name__}: {e}')


def main():
    if len(sys.argv) < 3:
        print('Usage: trellis2_native_full_pipeline.py <input_image> '
              '<out_glb> [tex_res=2048]')
        sys.exit(1)
    image_path = os.path.abspath(sys.argv[1])
    out_glb = os.path.abspath(sys.argv[2])
    tex_res = int(sys.argv[3]) if len(sys.argv) > 3 else 2048

    out_dir = os.path.dirname(out_glb)
    os.makedirs(out_dir, exist_ok=True)

    mode = os.environ.get('FABMESH_TRELLIS2_NATIVE_MODE', '1024')
    seed = int(os.environ.get('FABMESH_TRELLIS2_NATIVE_SEED', '42'))
    decim = int(os.environ.get('FABMESH_TRELLIS2_NATIVE_DECIM', '500000'))

    t0 = time.time()
    print('LOCAL_HI3DGEN_PROGRESS: 3 patch_cache', flush=True)
    _patch_rmbg_in_hf_cache()

    import torch
    log(f'torch={torch.__version__} gpu={torch.cuda.get_device_name(0)} '
        f'cc={torch.cuda.get_device_capability(0)}')
    log(f'mode={mode} seed={seed} decim={decim} tex_res={tex_res}')

    print('LOCAL_HI3DGEN_PROGRESS: 8 image_prep', flush=True)
    img = _prep_image(image_path)
    log(f'image prepared: {img.size}')

    # Collect optional multi-view reference images. The user can opt in
    # via the "Extra views" dropdown which calls the back-view generator
    # in MV-Adapter mode; it persists view_0..view_5 in <stem>_multiview/.
    # If that dir exists for the current source image, we feed the full
    # view set into TRELLIS-2's conditioning for both mesh shape and
    # texture (via get_cond([list]) + internal stages instead of run()).
    #
    # AUTO-DETECT IS OPT-IN: the TRELLIS-2 4B base checkpoint
    # ('microsoft/TRELLIS.2-4B') does NOT natively support multi-image
    # conditioning — the cross_attn layer is sized for 1 view per query,
    # so feeding 6 views causes a dim mismatch deep in modulated.py
    # ('tensor a (768) must match tensor b (128) at dim 3' = 6 * 128
    # features vs 128-dim query). Gate on FABMESH_USE_EXTRA_VIEWS=1 so
    # users who generated multi-views just for visualisation don't get
    # surprise crashes; explicit env var to opt in.
    mv_dir = os.environ.get('FABMESH_TRELLIS2_MULTIVIEW_DIR')
    if not mv_dir and (os.environ.get('FABMESH_USE_EXTRA_VIEWS') or '').strip().lower() in ('1', 'true', 'yes'):
        # Auto-detect: <image_stem>_multiview/ next to the source image
        from PIL import Image as _PILImage
        guess = os.path.join(
            os.path.dirname(image_path),
            os.path.splitext(os.path.basename(image_path))[0] + '_multiview')
        if os.path.isdir(guess):
            mv_dir = guess
            log(f'multi-view auto-detected (FABMESH_USE_EXTRA_VIEWS=1): {mv_dir}')
    mv_images = [img]
    if mv_dir and os.path.isdir(mv_dir):
        from PIL import Image as _PILImage
        # view_0 is the front re-render by MV-Adapter; the original `img` is
        # the user's untouched front photo, which is cleaner. Skip view_0.
        for i in range(1, 6):
            p = os.path.join(mv_dir, f'view_{i}.png')
            if os.path.isfile(p):
                # Run through rembg if no alpha (consistent with `img`).
                view_img = _PILImage.open(p).convert('RGBA')
                import numpy as np
                if (np.asarray(view_img)[:, :, 3] == 255).all():
                    try:
                        import rembg
                        view_img = rembg.remove(
                            view_img,
                            session=rembg.new_session('u2net'))
                    except Exception as _e:
                        log(f'rembg view_{i} skipped: {_e}')
                mv_images.append(view_img)
        log(f'multi-view conditioning: {len(mv_images)} images '
            f'(front + {len(mv_images)-1} extras)')

    print('LOCAL_HI3DGEN_PROGRESS: 12 loading_pipeline', flush=True)
    log('loading Trellis2ImageTo3DPipeline from microsoft/TRELLIS.2-4B...')
    t_load = time.time()
    from trellis2.pipelines import Trellis2ImageTo3DPipeline
    pipeline = Trellis2ImageTo3DPipeline.from_pretrained(
        'microsoft/TRELLIS.2-4B')
    pipeline.rembg_model = None  # gated, replaced by external rembg upstream
    pipeline.cuda()
    log(f'pipeline loaded in {time.time()-t_load:.1f}s, '
        f'VRAM peak {torch.cuda.max_memory_allocated()/1e9:.1f} GB')
    print('LOCAL_HI3DGEN_PROGRESS: 35 pipeline_ready', flush=True)

    log(f'inference (pipeline_type={mode}, n_views={len(mv_images)})...')
    t_inf = time.time()
    print('LOCAL_HI3DGEN_PROGRESS: 40 sparse_struct', flush=True)
    # Multi-view path is gated upstream (FABMESH_USE_EXTRA_VIEWS=1) but
    # may still raise at runtime if the loaded checkpoint doesn't
    # support multi-image cross-attention. Catch RuntimeError shape
    # mismatches and fall back to single-view rather than killing the
    # whole 3D generation.
    _mv_path_failed = False
    try:
        if len(mv_images) > 1:
            try:
                # Multi-view path: replicate pipeline.run() internals with a
                # multi-image cond. Same code as trellis2_image_to_3d.py:540-595
                # except `[image]` -> `mv_images`.
                torch.manual_seed(seed)
                cond_512 = pipeline.get_cond(mv_images, 512)
                cond_1024 = (pipeline.get_cond(mv_images, 1024)
                             if mode != '512' else None)
                ss_res = {'512': 32, '1024': 64,
                          '1024_cascade': 32, '1536_cascade': 32}[mode]
                coords = pipeline.sample_sparse_structure(
                    cond_512, ss_res, 1, {})
                if mode == '512':
                    shape_slat = pipeline.sample_shape_slat(
                        cond_512,
                        pipeline.models['shape_slat_flow_model_512'],
                        coords, {})
                    tex_slat = pipeline.sample_tex_slat(
                        cond_512,
                        pipeline.models['tex_slat_flow_model_512'],
                        shape_slat, {})
                    res = 512
                elif mode == '1024':
                    shape_slat = pipeline.sample_shape_slat(
                        cond_1024,
                        pipeline.models['shape_slat_flow_model_1024'],
                        coords, {})
                    tex_slat = pipeline.sample_tex_slat(
                        cond_1024,
                        pipeline.models['tex_slat_flow_model_1024'],
                        shape_slat, {})
                    res = 1024
                else:
                    # Cascade modes: fall back to single-image run() for now
                    # (cascade needs both sample_shape_slat_cascade which has
                    # extra constraints we'd need to thread through).
                    log(f'cascade mode not yet multi-view; falling back to single view')
                    outputs = pipeline.run(img, num_samples=1, seed=seed,
                                           pipeline_type=mode,
                                           preprocess_image=False)
                    shape_slat = None  # marker for the branch below
                if shape_slat is not None:
                    torch.cuda.empty_cache()
                    outputs = [pipeline.decode_latent(shape_slat, tex_slat, res)]
            except RuntimeError as _mv_err:
                # Multi-view shape mismatch — the TRELLIS-2 4B checkpoint's
                # cross_attn is sized for 1 view per query. Fall back to
                # single-image rather than killing the whole 3D gen.
                log(f'multi-view conditioning failed ({_mv_err}); falling back to single-view')
                _mv_path_failed = True
                torch.cuda.empty_cache()
                outputs = pipeline.run(
                    img,
                    num_samples=1,
                    seed=seed,
                    pipeline_type=mode,
                    preprocess_image=False,
                )
        else:
            outputs = pipeline.run(
                img,
                num_samples=1,
                seed=seed,
                pipeline_type=mode,
                preprocess_image=False,  # we did rembg upstream
            )
    except torch.cuda.OutOfMemoryError as e:
        log(f'OOM in mode={mode}: {e}')
        log(f'VRAM peak: {torch.cuda.max_memory_allocated()/1e9:.1f} GB')
        sys.exit(2)
    log(f'inference done in {time.time()-t_inf:.1f}s, '
        f'VRAM peak {torch.cuda.max_memory_allocated()/1e9:.1f} GB')
    print('LOCAL_HI3DGEN_PROGRESS: 80 inference_done', flush=True)

    mesh = outputs[0]
    log(f'mesh: {mesh.vertices.shape[0]}v / {mesh.faces.shape[0]}f')

    log('exporting GLB via o_voxel.postprocess.to_glb (Kaolin)...')
    print('LOCAL_HI3DGEN_PROGRESS: 85 export_start', flush=True)
    t_exp = time.time()
    from o_voxel.postprocess import to_glb
    glb = to_glb(
        vertices=mesh.vertices,
        faces=mesh.faces,
        attr_volume=mesh.attrs,
        coords=mesh.coords,
        attr_layout=mesh.layout,
        voxel_size=mesh.voxel_size,
        aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
        decimation_target=decim,
        texture_size=tex_res,
        remesh=True,
        remesh_band=1,
        remesh_project=0,
        verbose=False,
    )
    log(f'GLB built in {time.time()-t_exp:.1f}s')
    print('LOCAL_HI3DGEN_PROGRESS: 92 brightening', flush=True)

    # Auto-brighten the baseColor texture (TRELLIS-2 output under-lit in PBR viewers).
    if os.environ.get('FABMESH_TRELLIS2_SKIP_BRIGHTEN') != '1':
        _brighten_baseColor(glb)

    use_webp = os.environ.get('FABMESH_TRELLIS2_EXPORT_WEBP', '1') == '1'
    if use_webp:
        glb.export(out_glb, extension_webp=True)
    else:
        glb.export(out_glb)
    log(f'exported: {os.path.getsize(out_glb)} bytes -> {out_glb}')

    # EU AI Act art. 50 — mark GLB as AI-generated (machine-readable).
    try:
        from add_ai_metadata import patch_glb as _patch_ai
        _patch_ai(out_glb)
    except Exception as _ai_e:
        log(f'AI Act metadata skipped: {_ai_e}')

    print('LOCAL_HI3DGEN_PROGRESS: 100 done', flush=True)
    log(f'TOTAL: {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
    sys.stdout.flush()
    sys.stderr.flush()
