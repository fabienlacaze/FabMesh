"""
FabMesh Local Image-to-Image Bridge
Uses Stable Diffusion XL img2img via diffusers on local GPU.
Usage: python local_img2img_bridge.py <input_image> <prompt> <output_image> [strength]
"""
import sys
import os
import torch
from PIL import Image


def img2img(input_path, prompt, output_path, strength=0.55):
    from diffusers import StableDiffusionXLImg2ImgPipeline

    print("IMG2IMG: Loading SDXL base img2img pipeline...", flush=True)
    pipe = StableDiffusionXLImg2ImgPipeline.from_pretrained(
        "stabilityai/stable-diffusion-xl-base-1.0",
        torch_dtype=torch.float16,
        variant="fp16",
        use_safetensors=True,
    )
    pipe.to("cuda")
    print(f"IMG2IMG: On GPU ({torch.cuda.memory_allocated()/1024**3:.1f} GB)", flush=True)

    # Load image - keep original aspect for better quality
    img = Image.open(input_path).convert("RGB")
    # Resize to 1024 on shortest side, keeping aspect
    w, h = img.size
    if w < h:
        new_w = 1024
        new_h = int(h * 1024 / w)
    else:
        new_h = 1024
        new_w = int(w * 1024 / h)
    # Round to multiple of 8
    new_w = (new_w // 8) * 8
    new_h = (new_h // 8) * 8
    img = img.resize((new_w, new_h), Image.LANCZOS)
    print(f"IMG2IMG: Input resized to {new_w}x{new_h}", flush=True)

    # Keep it simple - don't over-enhance the prompt
    enhanced_prompt = f"{prompt}, high quality, detailed"

    print(f"IMG2IMG: Generating with strength={strength}...", flush=True)
    result = pipe(
        prompt=enhanced_prompt,
        image=img,
        strength=float(strength),
        num_inference_steps=40,
        guidance_scale=8.0,
    ).images[0]

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
