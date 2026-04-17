"""
FabMesh Local Image-to-Image Bridge
Uses SDXL Turbo img2img for image modification.
Note: better at modifying (color, style, details) than removing objects.
Usage: python local_img2img_bridge.py <input_image> <prompt> <output_image> [strength]
"""
import sys
import os
import torch
from PIL import Image


def img2img(input_path, prompt, output_path, strength=0.55):
    from diffusers import StableDiffusionXLImg2ImgPipeline

    # Enforce VRAM cap from FabMesh settings
    if torch.cuda.is_available():
        _frac = float(os.environ.get('FABMESH_VRAM_FRACTION', '0.95'))
        if 0.1 <= _frac < 1.0:
            try:
                torch.cuda.set_per_process_memory_fraction(_frac)
                print(f"IMG2IMG: VRAM hard cap set to {_frac*100:.0f}%", flush=True)
            except Exception as e:
                print(f"IMG2IMG: Could not set VRAM cap ({e})", flush=True)

    print("IMG2IMG: Loading SDXL Turbo img2img pipeline...", flush=True)
    pipe = StableDiffusionXLImg2ImgPipeline.from_pretrained(
        "stabilityai/sdxl-turbo",
        torch_dtype=torch.float16,
        variant="fp16",
        use_safetensors=True,
    )
    pipe.to("cuda")
    # Force every sub-module to fp16 to avoid "mat1 and mat2 must have the
    # same dtype" errors with torch 2.7.1+cu128 / diffusers 0.34 — some
    # internal buffers stay fp32 after from_pretrained on this stack.
    try:
        pipe.unet.to(torch.float16)
        pipe.vae.to(torch.float16)
        pipe.text_encoder.to(torch.float16)
        pipe.text_encoder_2.to(torch.float16)
    except Exception as _e:
        print(f"IMG2IMG: dtype force-cast skipped ({_e})", flush=True)
    # Memory optim
    pipe.enable_attention_slicing()
    pipe.enable_vae_tiling()
    print(f"IMG2IMG: On GPU ({torch.cuda.memory_allocated()/1024**3:.1f} GB)", flush=True)

    # Load image - keep original aspect
    img = Image.open(input_path).convert("RGB")
    w, h = img.size
    if w < h:
        new_w = 1024
        new_h = int(h * 1024 / w)
    else:
        new_h = 1024
        new_w = int(w * 1024 / h)
    new_w = (new_w // 8) * 8
    new_h = (new_h // 8) * 8
    img = img.resize((new_w, new_h), Image.LANCZOS)
    print(f"IMG2IMG: Input resized to {new_w}x{new_h}", flush=True)

    enhanced_prompt = f"{prompt}, high quality, detailed"

    # SDXL Turbo: num_inference_steps * strength must be >= 1
    s = float(strength)
    steps = max(2, int(round(4 / s)))
    print(f"IMG2IMG: strength={s}, steps={steps}", flush=True)
    result = pipe(
        prompt=enhanced_prompt,
        image=img,
        strength=s,
        num_inference_steps=steps,
        guidance_scale=0.0,
    ).images[0]

    result.save(output_path)

    # Free GPU/RAM
    del pipe, result, img
    torch.cuda.empty_cache()
    import gc
    gc.collect()
    torch.cuda.empty_cache()

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
