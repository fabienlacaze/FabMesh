"""Batch NSFW scan: reads paths from a JSON file, scans with ViT, writes results."""
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

    results = {}
    try:
        from transformers import pipeline
        clf = pipeline('image-classification', model='Falconsai/nsfw_image_detection', device='cpu')
        for p in paths:
            try:
                img = Image.open(p).convert('RGB').resize((224, 224))
                r = clf(img)
                score = next((x['score'] for x in r if x['label'] == 'nsfw'), 0)
                results[p] = score > 0.5
            except Exception:
                results[p] = False
    except Exception as e:
        print(f"NSFW scan error: {e}", file=sys.stderr)
        for p in paths:
            results[p] = False

    with open(results_file, 'w') as f:
        json.dump(results, f)
    print("OK")

if __name__ == '__main__':
    main()
