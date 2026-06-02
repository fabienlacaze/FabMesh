"""FabMesh -- TRELLIS-2 texturing bridge.

Wraps microsoft/TRELLIS.2-4B's Trellis2TexturingPipeline:
  input  = (mesh.glb, reference_image.png[, back_image.png, ...])
  output = textured.glb with PBR materials

Runs in the TRELLIS2_win venv.

CLI:
    python trellis2_texturing_bridge.py <mesh.glb> <image.png> <out.glb>
        [--seed 42]
        [--steps 12]                 sampler steps (12=default fast, 24=quality)
        [--texture-size 2048]        baked tex resolution (2048|4096)
        [--resolution 1024]          internal voxel/feature resolution (512|1024)
        [--image-resolution 1024]    source image resize before DINOv3 (default 1024)
        [--back-image PATH]          optional 2nd reference photo (back/side)
        [--extra-image PATH ...]     even more references (sides, etc.)
        [--guidance 1.0]             guidance_strength override
"""
from __future__ import annotations
import os
os.environ['PYTORCH_CUDA_ALLOC_CONF'] = 'expandable_segments:True'
import sys
import time
import argparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRELLIS2_SRC = os.path.join(ROOT, 'external', 'TRELLIS2_win', 'src')
sys.path.insert(0, TRELLIS2_SRC)


def log(msg):
    print(f'[trellis2_tex] {msg}', flush=True)


def _prep_image(path, log_label='image'):
    """Load + rembg if needed."""
    from PIL import Image
    import numpy as np
    image = Image.open(path).convert('RGBA')
    if np.asarray(image)[:, :, 3].min() == 255:
        log(f'{log_label} no alpha — rembg...')
        import rembg
        image = rembg.remove(image)
    log(f'{log_label}: {image.size}')
    return image


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('mesh', help='Input mesh GLB')
    ap.add_argument('image', help='Reference image PNG (front)')
    ap.add_argument('out', help='Output textured GLB')
    ap.add_argument('--config', default='texturing_pipeline.json')
    ap.add_argument('--seed', type=int, default=42)
    ap.add_argument('--steps', type=int, default=None,
                    help='Sampler steps (default 12 from config, 24 for quality)')
    ap.add_argument('--texture-size', type=int, default=None,
                    help='Output texture resolution (default 2048, max 4096)')
    ap.add_argument('--resolution', type=int, default=None,
                    help='Internal voxel/feature resolution (512 or 1024)')
    ap.add_argument('--image-resolution', type=int, default=None,
                    help='Source image resize before DINOv3 (1024 default)')
    ap.add_argument('--back-image', default=None,
                    help='Optional 2nd reference image (back/side photo)')
    ap.add_argument('--extra-image', action='append', default=[],
                    help='Additional reference images (can repeat)')
    ap.add_argument('--guidance', type=float, default=None,
                    help='Guidance strength override (default 1.0)')
    args = ap.parse_args()

    t0 = time.time()
    log(f'mesh:  {args.mesh}')
    log(f'image: {args.image}')
    log(f'out:   {args.out}')

    import trimesh
    from PIL import Image
    from trellis2.pipelines import Trellis2TexturingPipeline

    # Progress markers consumed by the main process stderr parser
    # so the Electron UI's progress bar moves linearly between
    # trellis2_start (65%) and texture_done (95%).
    print('LOCAL_TRELLIS2_PROGRESS: 67 trellis2_loading', flush=True)
    log('loading Trellis2TexturingPipeline from microsoft/TRELLIS.2-4B...')
    t_load = time.time()
    pipeline = Trellis2TexturingPipeline.from_pretrained(
        'microsoft/TRELLIS.2-4B', config_file=args.config)
    pipeline.rembg_model = None  # rembg pre-process upstream
    pipeline.cuda()
    log(f'pipeline loaded in {time.time()-t_load:.1f}s')
    print('LOCAL_TRELLIS2_PROGRESS: 72 trellis2_ready', flush=True)

    mesh = trimesh.load(args.mesh, force='mesh', process=False)
    if isinstance(mesh, trimesh.Scene):
        mesh = list(mesh.geometry.values())[0]
    log(f'mesh: {len(mesh.vertices)}v / {len(mesh.faces)}f')

    # Collect all reference images (front + back + extras).
    images = [_prep_image(args.image, 'front')]
    if args.back_image:
        images.append(_prep_image(args.back_image, 'back'))
    for i, p in enumerate(args.extra_image):
        images.append(_prep_image(p, f'extra_{i}'))
    log(f'total references: {len(images)}')

    # Build sampler params override from CLI flags.
    sampler_params = {}
    if args.steps is not None:
        sampler_params['steps'] = args.steps
    if args.guidance is not None:
        sampler_params['guidance_strength'] = args.guidance

    # Build run() kwargs.
    run_kwargs = {'seed': args.seed}
    if args.resolution is not None:
        run_kwargs['resolution'] = args.resolution
    if args.texture_size is not None:
        run_kwargs['texture_size'] = args.texture_size
    if sampler_params:
        run_kwargs['tex_slat_sampler_params'] = sampler_params

    # Optional: override image_size for DINOv3 feature extraction.
    if args.image_resolution is not None:
        pipeline.image_cond_model.image_size = args.image_resolution
        log(f'  DINOv3 image_size = {args.image_resolution}')

    print('LOCAL_TRELLIS2_PROGRESS: 75 sampling_start', flush=True)
    log(f'running texturing (run_kwargs={run_kwargs})...')
    t_run = time.time()
    import torch
    torch.manual_seed(args.seed)
    # The run() method takes ONE image in its signature; pipelines that
    # accept multi-image references handle them inside get_cond([list]).
    # We pass image=images[0] and patch the conditioning afterwards if
    # multi-image was provided.
    if len(images) > 1:
        # Multi-reference: call internal stages manually to feed all images.
        cond = pipeline.get_cond(images, 1024 if (args.resolution or 1024) == 1024 else 512)
        log(f'  multi-cond shape: {cond["cond"].shape}')
        mesh = pipeline.preprocess_mesh(mesh)
        shape_slat = pipeline.encode_shape_slat(mesh, args.resolution or 1024)
        tex_model_key = ('tex_slat_flow_model_1024'
                         if (args.resolution or 1024) == 1024
                         else 'tex_slat_flow_model_512')
        tex_model = pipeline.models[tex_model_key]
        print('LOCAL_TRELLIS2_PROGRESS: 80 sampling_diffusion', flush=True)
        tex_slat = pipeline.sample_tex_slat(
            cond, tex_model, shape_slat, sampler_params)
        print('LOCAL_TRELLIS2_PROGRESS: 86 sampling_done', flush=True)
        pbr_voxel = pipeline.decode_tex_slat(tex_slat)
        print('LOCAL_TRELLIS2_PROGRESS: 88 postprocess_start', flush=True)
        output = pipeline.postprocess_mesh(
            mesh, pbr_voxel,
            args.resolution or 1024,
            args.texture_size or 2048)
    else:
        print('LOCAL_TRELLIS2_PROGRESS: 80 sampling_diffusion', flush=True)
        output = pipeline.run(mesh, images[0], **run_kwargs)
        print('LOCAL_TRELLIS2_PROGRESS: 88 postprocess_done', flush=True)
    log(f'texturing done in {time.time()-t_run:.1f}s')
    print('LOCAL_TRELLIS2_PROGRESS: 91 brightening', flush=True)

    # Auto-brighten the baseColor texture before export. TRELLIS-2 PBR
    # output tends to look under-lit in glTF viewers (model-viewer ACES
    # tonemapping). Same boost as the SF3D bake path applied a few days
    # back (commit bc475eb). Disable with FABMESH_TRELLIS2_SKIP_BRIGHTEN=1.
    if os.environ.get('FABMESH_TRELLIS2_SKIP_BRIGHTEN') != '1':
        try:
            from PIL import ImageEnhance
            geoms = (list(output.geometry.values())
                     if hasattr(output, 'geometry') else [output])
            n_boosted = 0
            for m in geoms:
                visual = getattr(m, 'visual', None)
                if visual is None:
                    continue
                material = getattr(visual, 'material', None)
                if material is None:
                    continue
                tex = getattr(material, 'baseColorTexture', None)
                if tex is None:
                    continue
                new_tex = ImageEnhance.Brightness(tex).enhance(1.5)
                new_tex = ImageEnhance.Color(new_tex).enhance(1.3)
                new_tex = ImageEnhance.Contrast(new_tex).enhance(1.1)
                material.baseColorTexture = new_tex
                n_boosted += 1
            if n_boosted:
                log(f'post-process: brightness x1.5, sat x1.3, contrast x1.1'
                    f' ({n_boosted} material(s))')
        except Exception as e:
            log(f'auto-brighten skipped: {type(e).__name__}: {e}')

    log(f'exporting to {args.out}')
    if hasattr(output, 'export'):
        output.export(args.out, extension_webp=True)
    else:
        output.export(args.out)
    log(f'TOTAL: {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
