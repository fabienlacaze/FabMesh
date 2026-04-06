"""
FabMesh Local Image-to-Image Bridge
Uses Instruct-Pix2Pix for instruction-based image editing.
Usage: python local_img2img_bridge.py <input_image> <prompt> <output_image> [strength]
"""
import sys
import os
import torch
from PIL import Image


def img2img(input_path, prompt, output_path, strength=0.55):
    from diffusers import StableDiffusionInstructPix2PixPipeline, EulerAncestralDiscreteScheduler

    print("IMG2IMG: Loading Instruct-Pix2Pix pipeline...", flush=True)
    pipe = StableDiffusionInstructPix2PixPipeline.from_pretrained(
        "timbrooks/instruct-pix2pix",
        torch_dtype=torch.float16,
        safety_checker=None,
    )
    pipe.scheduler = EulerAncestralDiscreteScheduler.from_config(pipe.scheduler.config)
    pipe.to("cuda")
    print(f"IMG2IMG: On GPU ({torch.cuda.memory_allocated()/1024**3:.1f} GB)", flush=True)

    # Load image
    img = Image.open(input_path).convert("RGB")
    # Resize to fit in 768 max (pix2pix works best around 512-768)
    w, h = img.size
    max_dim = 768
    if max(w, h) > max_dim:
        if w > h:
            new_w, new_h = max_dim, int(h * max_dim / w)
        else:
            new_h, new_w = max_dim, int(w * max_dim / h)
    else:
        new_w, new_h = w, h
    # Round to multiple of 8
    new_w = (new_w // 8) * 8
    new_h = (new_h // 8) * 8
    img = img.resize((new_w, new_h), Image.LANCZOS)
    print(f"IMG2IMG: Input resized to {new_w}x{new_h}", flush=True)

    # Instruct-Pix2Pix recommended values from the paper:
    # image_guidance_scale: 1.0 - 2.0 (default 1.5)
    # guidance_scale: 5.0 - 10.0 (default 7.5)
    # Strength slider interpolates between "stay close to image" and "follow instruction strongly"
    s = float(strength)
    # Safer ranges to avoid artifacts/duplications
    image_guidance = 2.0 - s * 0.8  # 0.3 -> 1.76, 0.95 -> 1.24
    text_guidance = 6.0 + s * 4.0   # 0.3 -> 7.2, 0.95 -> 9.8

    print(f"IMG2IMG: text_guidance={text_guidance:.1f}, image_guidance={image_guidance:.1f}", flush=True)
    result = pipe(
        prompt=prompt,
        image=img,
        num_inference_steps=50,
        image_guidance_scale=image_guidance,
        guidance_scale=text_guidance,
    ).images[0]

    # Resize back if needed
    if (new_w, new_h) != (w, h):
        result = result.resize((w, h), Image.LANCZOS)

    result.save(output_path)
    print(f"IMG2IMG_SUCCESS: {os.path.getsize(output_path)} bytes", flush=True)
    return True


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: python local_img2img_bridge.py <input> <prompt> <output> [strength]")
        sys.exit(1)

    input_path = sys.argv[1]
    prompt = sys.argv[2]
    output_path = sys.argv[3]
    strength = sys.argv[4] if len(sys.argv) > 4 else "0.55"

    try:
        img2img(input_path, prompt, output_path, strength)
        sys.exit(0)
    except Exception as e:
        print(f"IMG2IMG_ERROR: {type(e).__name__}: {e}", flush=True)
        import traceback
        traceback.print_exc()
        sys.exit(1)
