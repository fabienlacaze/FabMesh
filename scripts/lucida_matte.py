"""Lucida (egeorcun/lucida, MIT) — background removal / matting.

A BiRefNet fine-tune that beats u2net on hard edges: glass/transparency,
hair/fur, text/logos, glow, illustration/line-art. Pure PyTorch via HF
transformers (trust_remote_code) — no custom CUDA, runs on RTX 5080 (sm_120).

Usage:
    python lucida_matte.py <image_path> [<output_png>]

Output: an RGBA PNG (original RGB + Lucida alpha). If <output_png> is omitted,
writes <image>_lucida.png next to the input.
"""
import os
import sys

import torch
from PIL import Image
from torchvision import transforms
from transformers import AutoModelForImageSegmentation

_MODEL = None


def _load():
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    m = AutoModelForImageSegmentation.from_pretrained(
        "egeorcun/lucida", trust_remote_code=True, dtype=torch.float32)
    m.to(dev).eval()
    print(f"LUCIDA: model loaded on {dev}", flush=True)
    _MODEL = (m, dev)
    return _MODEL


_T = transforms.Compose([
    transforms.Resize((1024, 1024)),
    transforms.ToTensor(),
    transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
])


def matte(in_path, out_path):
    m, dev = _load()
    img = Image.open(in_path).convert("RGB")
    with torch.no_grad():
        preds = m(_T(img).unsqueeze(0).to(dev))[-1].sigmoid().cpu()
    alpha = transforms.functional.resize(preds[0], img.size[::-1]).squeeze(0)
    rgba = img.copy()
    rgba.putalpha(Image.fromarray((alpha.numpy() * 255).astype("uint8")))
    rgba.save(out_path, "PNG")
    return out_path


def main():
    if len(sys.argv) < 2:
        print("Usage: python lucida_matte.py <image_path> [<output_png>]")
        sys.exit(1)
    in_path = sys.argv[1]
    out_path = sys.argv[2] if len(sys.argv) > 2 else \
        os.path.splitext(in_path)[0] + "_lucida.png"
    if not os.path.exists(in_path):
        print(f"LUCIDA_ERROR: image not found: {in_path}")
        sys.exit(1)
    matte(in_path, out_path)
    print(f"OK: {out_path}", flush=True)


if __name__ == "__main__":
    main()
