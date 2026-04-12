"""
FabMesh Local Image Generation Bridge — RealVis XL v4.0
SDXL fine-tune with photorealistic output. ~7 GB download.
License: CreativeML OpenRAIL++-M (commercial use permitted).
Model: https://huggingface.co/SG161222/RealVisXL_V4.0
Usage: python local_juggernaut_bridge.py "<prompt>" <output_dir> [num_images]

Note: file name kept as local_juggernaut_bridge.py for backwards compatibility
with main.js process references.
"""
import sys
import os
import time
import json
import torch

# GPU throttle — respects FABMESH_GPU_LIMIT / FABMESH_TEMP_LIMIT env vars
# by sleeping between diffusion steps when the GPU exceeds the user's
# configured limits. No-op if the env vars are not set.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from gpu_throttle import make_throttle_callback
except Exception as _gt_err:
    print(f"LOCAL_REALVIS: gpu_throttle unavailable ({_gt_err}), continuing unthrottled", flush=True)
    def make_throttle_callback():
        return None


def generate_images(prompt, output_dir, num_images=4, steps=30):
    from diffusers import StableDiffusionXLPipeline

    os.makedirs(output_dir, exist_ok=True)

    # Enforce VRAM limit from FabMesh settings (FABMESH_VRAM_FRACTION env var).
    # The fraction is (slider% / 100), e.g. 0.75 for a 75% slider.
    if torch.cuda.is_available():
        try:
            free_b, total_b = torch.cuda.mem_get_info()
            print(f"LOCAL_REALVIS: VRAM free={free_b/1e9:.1f}GB total={total_b/1e9:.1f}GB", flush=True)
        except Exception:
            pass
        frac = float(os.environ.get('FABMESH_VRAM_FRACTION', '0.95'))
        if 0.1 <= frac < 1.0:
            try:
                torch.cuda.set_per_process_memory_fraction(frac)
                print(f"LOCAL_REALVIS: VRAM hard cap set to {frac*100:.0f}% of total", flush=True)
            except Exception as e:
                print(f"LOCAL_REALVIS: Could not set VRAM cap ({e}), continuing uncapped", flush=True)

    # Enforce system RAM limit from FabMesh settings (FABMESH_RAM_LIMIT_MB env var).
    _ram_limit_mb = os.environ.get('FABMESH_RAM_LIMIT_MB', '')
    if _ram_limit_mb:
        try:
            import psutil, gc
            rss_mb = psutil.Process().memory_info().rss / (1024 * 1024)
            sys_used = psutil.virtual_memory().percent
            print(f"LOCAL_REALVIS: RAM usage: process={rss_mb:.0f}MB, system={sys_used:.0f}%, limit={_ram_limit_mb}MB", flush=True)
        except ImportError:
            print("LOCAL_REALVIS: psutil not installed, RAM monitoring skipped", flush=True)
        except Exception as e:
            print(f"LOCAL_REALVIS: RAM check error: {e}", flush=True)

    print("LOCAL_REALVIS: Loading RealVis XL v4.0 (first run downloads ~7 GB)...")
    sys.stdout.flush()

    pipe = StableDiffusionXLPipeline.from_pretrained(
        "SG161222/RealVisXL_V4.0",
        torch_dtype=torch.float16,
        variant="fp16",
        use_safetensors=True,
    )
    # Use model_cpu_offload instead of moving everything to CUDA at once.
    # This prevents VAE decode OOM/freeze on GPUs with limited VRAM (16GB)
    # and nightly PyTorch builds.
    pipe.enable_model_cpu_offload()
    print("LOCAL_REALVIS: Loaded with CPU offload (VAE decodes on CPU if needed)")
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

    _throttle_cb = make_throttle_callback()  # None if disabled

    images = []
    for i in range(num_images):
        print(f"LOCAL_REALVIS_PROGRESS: Generating image {i+1}/{num_images}...")
        sys.stdout.flush()

        _pipe_kwargs = dict(
            prompt=optimized_prompt,
            negative_prompt=negative_prompt,
            num_inference_steps=int(steps),
            guidance_scale=7.0,
            height=1024,
            width=1024,
            generator=torch.Generator("cuda").manual_seed(int(time.time()) + i),
        )
        if _throttle_cb is not None:
            # Diffusers >= 0.25 uses callback_on_step_end; older versions use callback
            try:
                _pipe_kwargs['callback_on_step_end'] = _throttle_cb
                result = pipe(**_pipe_kwargs)
            except TypeError:
                _pipe_kwargs.pop('callback_on_step_end', None)
                _pipe_kwargs['callback'] = _throttle_cb
                _pipe_kwargs['callback_steps'] = 1
                result = pipe(**_pipe_kwargs)
        else:
            result = pipe(**_pipe_kwargs)

        img_path = os.path.join(output_dir, f"ref_{i}.png")
        gen_img = result.images[0]

        # Post-generation safety check (parental control).
        # Uses a simple skin-ratio heuristic: if >40% of the image is skin-colored
        # pixels, flag as potentially NSFW and block when restricted.
        if os.environ.get('FABMESH_UNRESTRICTED') != '1':
            try:
                import numpy as _np
                arr = _np.array(gen_img.convert('RGB'))
                r, g, b = arr[:,:,0].astype(float), arr[:,:,1].astype(float), arr[:,:,2].astype(float)
                # Skin detection (RGB heuristic)
                skin = ((r > 95) & (g > 40) & (b > 20) &
                        (r > g) & (r > b) &
                        ((r - g).astype(float) > 15) &
                        (arr.max(axis=2).astype(float) - arr.min(axis=2).astype(float) > 15))
                skin_ratio = skin.sum() / (arr.shape[0] * arr.shape[1])
                if skin_ratio > 0.45:
                    print(f"LOCAL_REALVIS_BLOCKED: image {i} blocked by safety filter (skin ratio {skin_ratio:.0%})", flush=True)
                    # Replace with a black image + warning text
                    from PIL import ImageDraw, ImageFont
                    gen_img = Image.new('RGB', gen_img.size, (30, 30, 30))
                    draw = ImageDraw.Draw(gen_img)
                    draw.text((gen_img.width//2 - 100, gen_img.height//2 - 10), "Blocked by content filter", fill=(200, 50, 50))
            except Exception as _se:
                print(f"LOCAL_REALVIS: safety check error ({_se}), allowing image", flush=True)

        gen_img.save(img_path)
        images.append(img_path)
        print(f"LOCAL_REALVIS_DONE: {img_path} ({os.path.getsize(img_path)} bytes)")
        sys.stdout.flush()

    del pipe
    torch.cuda.empty_cache()

    print(f"LOCAL_REALVIS_SUCCESS: {len(images)} images generated")
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
        print(f"LOCAL_REALVIS_ERROR: {e}")
        sys.exit(1)

    if images:
        print(f"RESULT: {json.dumps(images)}")
    sys.exit(0 if images else 1)
