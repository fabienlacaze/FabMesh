"""
FabMesh Local Image Generation Bridge
Uses Stable Diffusion XL Turbo via diffusers on local GPU.
Usage: python local_image_bridge.py "<prompt>" <output_dir> [num_images]
"""
import sys
import os
import time
import torch

def generate_images(prompt, output_dir, num_images=4):
    from diffusers import AutoPipelineForText2Image

    os.makedirs(output_dir, exist_ok=True)

    # Enforce VRAM cap from FabMesh settings
    if torch.cuda.is_available():
        _frac = float(os.environ.get('FABMESH_VRAM_FRACTION', '0.95'))
        if 0.1 <= _frac < 1.0:
            try:
                torch.cuda.set_per_process_memory_fraction(_frac)
                print(f"LOCAL_IMG: VRAM hard cap set to {_frac*100:.0f}%", flush=True)
            except Exception as e:
                print(f"LOCAL_IMG: Could not set VRAM cap ({e})", flush=True)

    print("LOCAL_IMG: Loading Stable Diffusion XL Turbo...")
    sys.stdout.flush()

    pipe = AutoPipelineForText2Image.from_pretrained(
        "stabilityai/sdxl-turbo",
        torch_dtype=torch.float16,
        variant="fp16"
    )
    pipe.to("cuda")

    optimized_prompt = (
        f"3D render of {prompt}, single object centered on plain white background, "
        f"studio lighting, high detail, no text, isometric view, product photography"
    )

    images = []
    for i in range(num_images):
        print(f"LOCAL_IMG_PROGRESS: Generating image {i+1}/{num_images}...")
        sys.stdout.flush()

        result = pipe(
            prompt=optimized_prompt,
            num_inference_steps=4,
            guidance_scale=0.0,
            generator=torch.Generator("cuda").manual_seed(int(time.time()) + i)
        )

        img_path = os.path.join(output_dir, f"ref_{i}.png")
        result.images[0].save(img_path)
        images.append(img_path)
        print(f"LOCAL_IMG_DONE: {img_path} ({os.path.getsize(img_path)} bytes)")
        sys.stdout.flush()

    # Free GPU memory
    del pipe
    torch.cuda.empty_cache()

    print(f"LOCAL_IMG_SUCCESS: {len(images)} images generated")
    sys.stdout.flush()
    return images

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python local_image_bridge.py \"<prompt>\" <output_dir> [num_images]")
        sys.exit(1)

    prompt = sys.argv[1]
    output_dir = sys.argv[2]
    num_images = int(sys.argv[3]) if len(sys.argv) > 3 else 4

    images = generate_images(prompt, output_dir, num_images)
    if images:
        import json
        print(f"RESULT: {json.dumps(images)}")
    sys.exit(0 if images else 1)
