"""Caption an image with BLIP-2 to describe the subject (clothes, hair,
features) for back-view generation prompt enrichment.

Usage:
    python caption_image.py <image_path>

Output: prints "CAPTION: <text>" on stdout. Caller parses that line.

Model: Salesforce/blip2-opt-2.7b (BSD-3-Clause, commercial OK).
Smaller alternative: Salesforce/blip-image-captioning-large (~990 MB).

Why BLIP not CLIP-Interrogator:
- CLIP-Interrogator is non-commercial (uses BLIP+CLIP+LLaMA chain)
- BLIP-2 raw is BSD-3 only.
- ~3 GB model, ~3s inference on RTX 5080.
"""
import sys
import os
import torch
from PIL import Image


PROMPT_QUERY = (
    "Question: Describe in detail the clothing and physical features of "
    "this character (hair color and style, shirt, pants, shoes, accessories, "
    "colors). Answer in a single sentence."
)


def caption(image_path):
    print(f'[caption] loading BLIP-2...', flush=True)
    from transformers import Blip2Processor, Blip2ForConditionalGeneration

    # Use the smaller BLIP captioning model first (~1 GB) — faster and
    # also BSD-3. Falls back to BLIP-2 OPT 2.7B if needed.
    try:
        from transformers import BlipProcessor, BlipForConditionalGeneration
        model_id = 'Salesforce/blip-image-captioning-large'
        proc = BlipProcessor.from_pretrained(model_id)
        model = BlipForConditionalGeneration.from_pretrained(
            model_id, torch_dtype=torch.float16,
        ).to('cuda')
        img = Image.open(image_path).convert('RGB')
        # Conditional caption: prefix steers the description.
        prompt = (
            'a character wearing'
        )
        inputs = proc(img, prompt, return_tensors='pt').to('cuda', torch.float16)
        with torch.no_grad():
            out = model.generate(**inputs, max_new_tokens=80, num_beams=5)
        text = proc.decode(out[0], skip_special_tokens=True)
        print(f'CAPTION: {text}', flush=True)
        return text
    except Exception as e:
        print(f'[caption] BLIP small failed: {e}; trying BLIP-2 OPT...', flush=True)
        proc = Blip2Processor.from_pretrained('Salesforce/blip2-opt-2.7b')
        model = Blip2ForConditionalGeneration.from_pretrained(
            'Salesforce/blip2-opt-2.7b', torch_dtype=torch.float16,
        ).to('cuda')
        img = Image.open(image_path).convert('RGB')
        inputs = proc(img, PROMPT_QUERY, return_tensors='pt').to('cuda', torch.float16)
        with torch.no_grad():
            out = model.generate(**inputs, max_new_tokens=100)
        text = proc.decode(out[0], skip_special_tokens=True).strip()
        print(f'CAPTION: {text}', flush=True)
        return text


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: caption_image.py <image_path>')
        sys.exit(1)
    if not os.path.exists(sys.argv[1]):
        print(f'ERROR: image not found: {sys.argv[1]}')
        sys.exit(2)
    try:
        caption(sys.argv[1])
    except Exception as e:
        print(f'ERROR: {type(e).__name__}: {e}')
        import traceback; traceback.print_exc()
        sys.exit(3)
