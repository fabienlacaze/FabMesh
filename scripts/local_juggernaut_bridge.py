"""
FabMesh Local Image Generation Bridge — Juggernaut XL v9
SDXL fine-tune with photorealistic output. ~7 GB download.
Usage: python local_flux_bridge.py "<prompt>" <output_dir> [num_images]
"""
import sys
import os
import time
import json
import torch


def generate_images(prompt, output_dir, num_images=4, steps=30):
    from diffusers import StableDiffusionXLPipeline

    os.makedirs(output_dir, exist_ok=True)

    print("LOCAL_JUGG: Loading Juggernaut XL v9 (first run downloads ~7 GB)...")
    sys.stdout.flush()

    pipe = StableDiffusionXLPipeline.from_pretrained(
        "RunDiffusion/Juggernaut-XL-v9",
        torch_dtype=torch.float16,
        variant="fp16",
        use_safetensors=True,
    )
    pipe.to("cuda")
    print("LOCAL_JUGG: Loaded on CUDA")
    sys.stdout.flush()

    optimized_prompt = (
        f"{prompt}, single object centered on plain white background, "
        f"studio lighting, ultra detailed, 8k, sharp focus, professional photography, "
        f"masterpiece, no text, no watermark"
    )
    negative_prompt = (
        "blurry, low quality, text, watermark, signature, deformed, "
        "extra limbs, bad anatomy, distorted, cropped, worst quality"
    )

    images = []
    for i in range(num_images):
        print(f"LOCAL_JUGG_PROGRESS: Generating image {i+1}/{num_images}...")
        sys.stdout.flush()

        result = pipe(
            prompt=optimized_prompt,
            negative_prompt=negative_prompt,
            num_inference_steps=int(steps),
            guidance_scale=7.0,
            height=1024,
            width=1024,
            generator=torch.Generator("cuda").manual_seed(int(time.time()) + i),
        )

        img_path = os.path.join(output_dir, f"ref_{i}.png")
        result.images[0].save(img_path)
        images.append(img_path)
        print(f"LOCAL_JUGG_DONE: {img_path} ({os.path.getsize(img_path)} bytes)")
        sys.stdout.flush()

    del pipe
    torch.cuda.empty_cache()

    print(f"LOCAL_JUGG_SUCCESS: {len(images)} images generated")
    sys.stdout.flush()
    return images


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python local_juggernaut_bridge.py \"<prompt>\" <output_dir> [num_images] [steps]")
        sys.exit(1)

    prompt = sys.argv[1]
    output_dir = sys.argv[2]
    num_images = int(sys.argv[3]) if len(sys.argv) > 3 else 4
    steps = int(sys.argv[4]) if len(sys.argv) > 4 else 30

    try:
        images = generate_images(prompt, output_dir, num_images, steps)
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"LOCAL_JUGG_ERROR: {e}")
        sys.exit(1)

    if images:
        print(f"RESULT: {json.dumps(images)}")
    sys.exit(0 if images else 1)
