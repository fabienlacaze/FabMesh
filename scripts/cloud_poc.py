"""POC: appel TRELLIS image-to-3D via l'API Replicate.

Lit le token depuis build/replicate-token.txt (gitignored), upload une
image source, lance la prédiction sur firtoz/trellis (TRELLIS-1, 1.2B),
mesure le temps total + télécharge le résultat GLB.

Sortie :
    build/poc_results/<image>_<model>_<timestamp>.glb
    + log JSON avec timing/coût estimé

Usage:
    python scripts/cloud_poc.py path/to/image.png
    python scripts/cloud_poc.py path/to/image.png --model jdb-prog/trellis
"""
import argparse
import json
import os
import pathlib
import sys
import time


def _load_token():
    here = pathlib.Path(__file__).parent.parent
    p = here / 'build' / 'replicate-token.txt'
    if p.is_file():
        return p.read_text(encoding='utf-8').strip()
    env = os.environ.get('REPLICATE_API_TOKEN')
    if env:
        return env.strip()
    raise RuntimeError('No Replicate token. Put it in build/replicate-token.txt '
                       'or set REPLICATE_API_TOKEN env var.')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('image', help='path to source image (png/jpg)')
    ap.add_argument('--model', default='fishwowater/trellis2',
                    help='Replicate model slug (default: fishwowater/trellis2, TRELLIS.2-4B)')
    ap.add_argument('--seed', type=int, default=42)
    args = ap.parse_args()

    img_path = pathlib.Path(args.image)
    if not img_path.is_file():
        sys.exit(f'image not found: {img_path}')

    os.environ['REPLICATE_API_TOKEN'] = _load_token()
    import replicate

    out_dir = pathlib.Path(__file__).parent.parent / 'build' / 'poc_results'
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f'[poc] model = {args.model}')
    print(f'[poc] image = {img_path.name} ({img_path.stat().st_size // 1024} KB)')
    print(f'[poc] uploading + running prediction…')
    t0 = time.time()

    # Resolve the latest version of the model explicitly. Some community
    # models on Replicate aren't reachable via the short slug because
    # the owner didn't publish a deployment endpoint — but we can still
    # call the underlying versions API directly.
    model = replicate.models.get(args.model)
    version = model.latest_version
    print(f'[poc] using version {version.id[:12]}')

    with open(img_path, 'rb') as f:
        out = replicate.run(
            f'{args.model}:{version.id}',
            input={
                'image': f,
                'seed': args.seed,
                'generate_model': True,
                'generate_video': False,
                'preprocess_image': True,
                'texture_size': 2048,
                'decimation_target': 100000,
                'sparse_structure_steps': 12,
                'shape_slat_steps': 12,
                'tex_slat_steps': 12,
            },
        )

    dt = time.time() - t0
    print(f'[poc] DONE in {dt:.1f}s')
    print(f'[poc] raw output type: {type(out).__name__}')

    # Replicate returns a dict with model-specific keys (varies per model).
    # For TRELLIS, expect a "model_file" or similar URL field. We just
    # dump everything so we can inspect.
    if isinstance(out, dict):
        print(f'[poc] output keys: {list(out.keys())}')
        for k, v in out.items():
            print(f'[poc]   {k}: {str(v)[:100]}')
            if hasattr(v, 'url'):
                v = v.url

        # Try to download any GLB-looking URL
        ts = int(time.time())
        slug = args.model.replace('/', '_')
        meta = {
            'model': args.model,
            'image': str(img_path),
            'seed': args.seed,
            'duration_s': round(dt, 2),
            'output': {k: (v.url if hasattr(v, 'url') else str(v)) for k, v in out.items()},
        }
        meta_path = out_dir / f'{img_path.stem}_{slug}_{ts}.json'
        meta_path.write_text(json.dumps(meta, indent=2))
        print(f'[poc] meta saved: {meta_path}')

        # Download any URL output (likely .glb or .ply)
        import urllib.request
        for k, v in out.items():
            url = v.url if hasattr(v, 'url') else str(v)
            if not url.startswith('http'):
                continue
            ext = url.rsplit('.', 1)[-1].split('?')[0][:5]
            out_file = out_dir / f'{img_path.stem}_{slug}_{ts}_{k}.{ext}'
            try:
                urllib.request.urlretrieve(url, out_file)
                size_mb = out_file.stat().st_size / (1024*1024)
                print(f'[poc] downloaded {k} -> {out_file.name} ({size_mb:.1f} MB)')
            except Exception as e:
                print(f'[poc] download failed for {k}: {e}')

    # Rough cost estimate. firtoz/trellis runs on Nvidia L40S typically;
    # Replicate bills $0.000725/s on L40S as of 2026.
    cost_estimate_usd = round(dt * 0.000725, 4)
    print(f'[poc] estimated cost (L40S @ $0.000725/s): ${cost_estimate_usd}')

    return 0


if __name__ == '__main__':
    sys.exit(main())
