"""Edge-preserving smoothing of the baseColor atlas via bilateral filter.

Why: SDXL-based texture refine (`texture_refine.py`) hallucinates "wear
and tear" (scratches, paint chips) on smooth uniform surfaces like car
paint, chrome and glass — even at strength=0.15 with ControlNet Tile.
A classical bilateral filter is the conservative alternative: it
smooths uniform regions (reducing the speckled grain that TRELLIS-2's
internal renderer bakes into the atlas) while preserving real edges
(panel gaps, grille slots, window frames). Zero hallucination, zero
new content.

Pipeline:
  1. Load GLB, extract baseColorTexture for each material.
  2. Apply OpenCV bilateralFilter with parameters tuned for paint /
     metal surfaces: d=9, sigmaColor=50, sigmaSpace=50 (light pass).
  3. Replace the texture in-place, export new GLB.

License: OpenCV (Apache 2.0), trimesh (MIT), pygltflib (MIT). All
commercial-safe.

Usage:
    python texture_smooth.py <input.glb> <output.glb>
        [--d 9] [--sigma_color 50] [--sigma_space 50] [--passes 1]
"""
import argparse
import os
import sys
import time

import numpy as np
from PIL import Image


def log(msg):
    print(f'[tex-smooth] {msg}', flush=True)


def smooth_atlas(img: Image.Image, d=9, sigma_color=50, sigma_space=50,
                 passes=1) -> Image.Image:
    """Apply bilateral filter `passes` times. Returns RGB PIL."""
    import cv2
    arr = np.array(img.convert('RGB'))
    # OpenCV uses BGR
    arr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
    for _ in range(passes):
        arr = cv2.bilateralFilter(arr, d, sigma_color, sigma_space)
    arr = cv2.cvtColor(arr, cv2.COLOR_BGR2RGB)
    return Image.fromarray(arr)


def smooth_glb(in_path, out_path, d=9, sigma_color=50, sigma_space=50,
               passes=1):
    import trimesh
    log(f'load {in_path}')
    scene = trimesh.load(in_path, force='scene')

    geoms = (list(scene.geometry.values())
             if hasattr(scene, 'geometry') else [scene])
    n_processed = 0
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
        log(f'  smoothing baseColor {tex.size} '
            f'(d={d}, sigma_color={sigma_color}, sigma_space={sigma_space}, '
            f'passes={passes})')
        t0 = time.time()
        new_tex = smooth_atlas(tex, d, sigma_color, sigma_space, passes)
        log(f'  done in {time.time()-t0:.1f}s')
        material.baseColorTexture = new_tex
        n_processed += 1

    if not n_processed:
        log('WARN: no baseColorTexture found in any material')

    log(f'export {out_path}')
    scene.export(out_path)
    log(f'wrote {os.path.getsize(out_path)} bytes')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input')
    ap.add_argument('output')
    ap.add_argument('--d', type=int, default=9,
                    help='bilateral neighbourhood diameter')
    ap.add_argument('--sigma_color', type=float, default=50,
                    help='color-space sigma (higher = more colors mixed)')
    ap.add_argument('--sigma_space', type=float, default=50,
                    help='coordinate-space sigma (higher = wider blur)')
    ap.add_argument('--passes', type=int, default=1,
                    help='apply the filter N times (stack effect)')
    args = ap.parse_args()

    if not os.path.isfile(args.input):
        log(f'ERROR: input not found: {args.input}')
        sys.exit(2)

    t0 = time.time()
    smooth_glb(args.input, args.output, d=args.d,
               sigma_color=args.sigma_color,
               sigma_space=args.sigma_space, passes=args.passes)
    log(f'TOTAL: {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
