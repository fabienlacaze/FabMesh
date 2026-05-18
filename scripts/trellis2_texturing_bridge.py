"""FabMesh -- TRELLIS-2 texturing bridge.

Wraps microsoft/TRELLIS.2-4B's Trellis2TexturingPipeline:
  input  = (mesh.glb, reference_image.png)
  output = textured.glb with PBR materials (baseColor + roughness +
           metallic + normal, up to 4K depending on config)

Runs in the TRELLIS2_win venv (already used by Hi3DGen bridge).

CLI:
    python trellis2_texturing_bridge.py <mesh.glb> <image.png> <out.glb>
        [--seed 42] [--config texturing_pipeline.json]
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('mesh', help='Input mesh GLB (Hi3DGen / SF3D / any)')
    ap.add_argument('image', help='Reference image PNG')
    ap.add_argument('out', help='Output textured GLB')
    ap.add_argument('--config', default='texturing_pipeline.json')
    ap.add_argument('--seed', type=int, default=42)
    args = ap.parse_args()

    t0 = time.time()
    log(f'mesh:  {args.mesh}')
    log(f'image: {args.image}')
    log(f'out:   {args.out}')

    import trimesh
    from PIL import Image
    from trellis2.pipelines import Trellis2TexturingPipeline

    log('loading Trellis2TexturingPipeline from microsoft/TRELLIS.2-4B...')
    t_load = time.time()
    pipeline = Trellis2TexturingPipeline.from_pretrained(
        'microsoft/TRELLIS.2-4B', config_file=args.config)
    # Skip TRELLIS-2's internal rembg (briaai/RMBG-2.0 is gated, and
    # ZhengPeng7/BiRefNet has fp16/fp32 mismatch on Blackwell). We
    # pre-process the image with rembg (Apache 2.0) below instead.
    pipeline.rembg_model = None
    log('  rembg_model disabled (using rembg pre-process instead)')
    pipeline.cuda()
    log(f'pipeline loaded in {time.time()-t_load:.1f}s')

    mesh = trimesh.load(args.mesh, force='mesh', process=False)
    if isinstance(mesh, trimesh.Scene):
        mesh = list(mesh.geometry.values())[0]
    log(f'mesh: {len(mesh.vertices)}v / {len(mesh.faces)}f')

    image = Image.open(args.image).convert('RGBA')
    # Pre-rembg if alpha all-opaque
    import numpy as np
    if np.asarray(image)[:, :, 3].min() == 255:
        log('image has no alpha — running rembg (Apache 2.0)...')
        import rembg
        image = rembg.remove(image)
    log(f'image: {image.size} (alpha range {np.asarray(image)[:, :, 3].min()}-{np.asarray(image)[:, :, 3].max()})')

    log('running texturing...')
    t_run = time.time()
    import torch
    if args.seed:
        torch.manual_seed(args.seed)
    output = pipeline.run(mesh, image)
    log(f'texturing done in {time.time()-t_run:.1f}s')

    log(f'exporting to {args.out}')
    if hasattr(output, 'export'):
        output.export(args.out, extension_webp=True)
    else:
        # Fallback: assume output is a trimesh object
        output.export(args.out)
    log(f'TOTAL: {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
