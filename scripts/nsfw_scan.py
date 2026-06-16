"""Batch NSFW scan: reads paths from a JSON file, scans with ViT, writes results.

IDEMPOTENT: each scanned image gets a persistent sidecar — `.nsfw` if flagged,
`.nsfwok` if clean — so it is NEVER re-scanned on a later run. The two CPU ViT
models are only loaded when there is genuinely NEW work; an all-cached call
returns instantly without touching transformers. This killed a ~38% CPU /
20-30s spike at every app startup (the whole library was re-classified each
launch because verdicts were only cached in renderer RAM)."""
import os
import sys
import json
from PIL import Image

def main():
    if len(sys.argv) < 3:
        print("Usage: nsfw_scan.py <paths.json> <results.json>")
        return
    paths_file = sys.argv[1]
    results_file = sys.argv[2]

    with open(paths_file, 'r') as f:
        paths = json.load(f)

    # Pre-filter images that already carry a verdict — only the rest needs the AI.
    results = {}
    todo = []
    for p in paths:
        if os.path.exists(p + '.nsfw'):
            results[p] = True
        elif os.path.exists(p + '.nsfwok'):
            results[p] = False
        else:
            todo.append(p)
    if not todo:
        with open(results_file, 'w') as f:
            json.dump(results, f)
        print("OK (all cached, no model load)")
        return

    try:
        from transformers import pipeline
        import numpy as np
        # Use 2 models combined for better detection (both Apache 2.0, local)
        clf1 = pipeline('image-classification', model='Falconsai/nsfw_image_detection', device='cpu')
        clf2 = pipeline('image-classification', model='AdamCodd/vit-base-nsfw-detector', device='cpu')
        for p in todo:
            try:
                img = Image.open(p).convert('RGB').resize((224, 224))
                r1 = clf1(img)
                r2 = clf2(img)
                s1 = next((x['score'] for x in r1 if x['label'] == 'nsfw'), 0)
                s2 = next((x['score'] for x in r2 if x['label'] == 'nsfw'), 0)
                score = max(s1, s2)
                is_nsfw = score > 0.5
                # Fallback: skin ratio for cases both models miss
                if not is_nsfw:
                    arr = np.array(Image.open(p).convert('RGB').resize((256, 256))).astype(float)
                    rv, gv, bv = arr[:,:,0], arr[:,:,1], arr[:,:,2]
                    skin = ((rv>95)&(gv>40)&(bv>20)&(rv>gv)&(rv>bv)&((rv-gv)>15)&(arr.max(2)-arr.min(2)>15))
                    skin_ratio = float(skin.sum()) / (256*256)
                    if skin_ratio > 0.35:
                        is_nsfw = True
                results[p] = is_nsfw
                # Persist the verdict so this image is never re-scanned: `.nsfw`
                # if flagged, `.nsfwok` if clean.
                try:
                    with open(p + ('.nsfw' if is_nsfw else '.nsfwok'), 'w') as nf:
                        nf.write(f'{score:.4f}')
                except:
                    pass
            except Exception:
                results[p] = False
    except Exception as e:
        print(f"NSFW scan error: {e}", file=sys.stderr)
        for p in todo:
            results[p] = False

    with open(results_file, 'w') as f:
        json.dump(results, f)
    print("OK")

if __name__ == '__main__':
    main()
