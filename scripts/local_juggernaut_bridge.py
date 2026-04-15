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
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from fabmesh_log import Logger
        _slog = Logger('realvis',
                       project=os.path.basename(output_dir),
                       num_images=num_images, steps=steps)
    except Exception:
        _slog = None
    def _evt(event, **f):
        if _slog:
            _slog.info(event, **f)
    def _warn(event, **f):
        if _slog:
            _slog.warn(event, **f)
    _t0 = time.time()
    _evt('pipeline_started',
         prompt=prompt[:120],
         output_dir=output_dir,
         torch_cuda=torch.cuda.is_available())

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

    # Prompt enhancement: choose between T-pose (3D-game-asset) mode and
    # the default three-quarter view mode based on cues in the user prompt.
    #
    # Why two modes:
    #   - Multi-view generation (Zero123++) works BEST when the input is a
    #     strict T-pose front-facing character. Dynamic poses cause it to
    #     duplicate the front across multiple azimuths (observed on
    #     orc_child: view_0 and view_3 both looked "face").
    #   - But for hard-surface props (buildings, items) a 3/4 angle gives
    #     SF3D more side info and bakes a better texture.
    #
    # Heuristic: if the user typed "T-pose" or "front view" anywhere, go
    # full T-pose mode. Otherwise keep the legacy 3/4 bias.
    _p_low = prompt.lower()
    _is_tpose = any(kw in _p_low for kw in (
        't-pose', 't pose', 'tpose',
        'front view', 'frontal view', 'front-facing', 'facing camera',
        'facing the camera', 'straight-on',
    ))
    if _is_tpose:
        # T-pose/front mode: reinforce strict symmetry, arms out horizontally,
        # no perspective. Zero123++ will be able to rotate around properly.
        optimized_prompt = (
            f"{prompt}, "
            f"arms extended straight out horizontally to the sides, "
            f"legs apart shoulder-width, standing upright, symmetrical pose, "
            f"perfectly centered, strict front view, orthographic-like flat view, "
            f"looking directly at the camera, no tilt, no rotation, "
            f"single character isolated on plain white background, "
            f"studio lighting, sharp focus, ultra detailed, 8k, "
            f"no text, no watermark, full body visible, feet on the ground"
        )
        negative_prompt = (
            "dynamic pose, action pose, combat stance, fighting, running, "
            "jumping, crouching, bent arms, bent legs, tilted head, "
            "twisted torso, asymmetric, side view, three-quarter view, "
            "profile view, back view, perspective distortion, foreshortening, "
            "blurry, low quality, text, watermark, signature, deformed, "
            "extra limbs, bad anatomy, cropped, worst quality"
        )
        print(f"LOCAL_REALVIS: T-pose mode detected (keywords in prompt)", flush=True)
    else:
        # Three-quarter view bias for hard-surface / prop subjects: SF3D
        # textures only what the front shows and "invents" the back/sides
        # as a duller version of the front. By asking RealVisXL for a 3/4
        # angle we expose the side of the subject in the source image
        # itself, so SF3D bakes a richer, more accurate texture.
        optimized_prompt = (
            f"{prompt}, three-quarter view showing one side, slight rotation, "
            f"single object centered on plain white background, "
            f"studio lighting, ultra detailed, 8k, sharp focus, professional photography, "
            f"masterpiece, no text, no watermark"
        )
        negative_prompt = (
            "blurry, low quality, text, watermark, signature, deformed, "
            "extra limbs, bad anatomy, distorted, cropped, worst quality, "
            "strict frontal view, flat profile"
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
        # Uses Falconsai/nsfw_image_detection ViT classifier (Apache 2.0).
        # Scans EVERY generated image regardless of prompt — catches all
        # circumventions that keyword filters miss.
        if os.environ.get('FABMESH_UNRESTRICTED') != '1':
            try:
                from transformers import pipeline as _tfpipeline
                import numpy as _np2
                # Dual model detection (both Apache 2.0, local, ~350 MB total)
                _clf1 = _tfpipeline('image-classification', model='Falconsai/nsfw_image_detection', device='cpu')
                _clf2 = _tfpipeline('image-classification', model='AdamCodd/vit-base-nsfw-detector', device='cpu')
                _img224 = gen_img.convert('RGB').resize((224, 224))
                _r1 = _clf1(_img224)
                _r2 = _clf2(_img224)
                _s1 = next((x['score'] for x in _r1 if x['label'] == 'nsfw'), 0)
                _s2 = next((x['score'] for x in _r2 if x['label'] == 'nsfw'), 0)
                _nsfw_score = max(_s1, _s2)
                _is_blocked = _nsfw_score > 0.5
                # Fallback: skin ratio for cases both models miss
                if not _is_blocked:
                    _arr = _np2.array(gen_img.convert('RGB').resize((256, 256))).astype(float)
                    _rv, _gv, _bv = _arr[:,:,0], _arr[:,:,1], _arr[:,:,2]
                    _skin = ((_rv>95)&(_gv>40)&(_bv>20)&(_rv>_gv)&(_rv>_bv)&((_rv-_gv)>15)&(_arr.max(2)-_arr.min(2)>15))
                    _skin_ratio = float(_skin.sum()) / (256*256)
                    if _skin_ratio > 0.35:
                        _is_blocked = True
                        print(f"LOCAL_REALVIS: skin ratio {_skin_ratio:.0%} -> blocked", flush=True)
                if _is_blocked:
                    print(f"LOCAL_REALVIS_BLOCKED: image {i} blocked (nsfw={_nsfw_score:.0%})", flush=True)
                    try:
                        with open(img_path + '.nsfw', 'w') as _nf:
                            _nf.write(f'{_nsfw_score:.4f}')
                    except: pass
                    from PIL import ImageDraw
                    gen_img = Image.new('RGB', gen_img.size, (30, 30, 30))
                    draw = ImageDraw.Draw(gen_img)
                    draw.text((gen_img.width//2 - 120, gen_img.height//2 - 10), "Blocked by content filter", fill=(200, 50, 50))
                else:
                    print(f"LOCAL_REALVIS: safety check passed (nsfw={_nsfw_score:.0%})", flush=True)
            except Exception as _se:
                print(f"LOCAL_REALVIS: safety check error ({_se}), allowing image", flush=True)

        gen_img.save(img_path)
        images.append(img_path)
        _sz = os.path.getsize(img_path)
        _evt('image_saved', index=i, path=img_path, bytes=_sz,
             w=gen_img.size[0], h=gen_img.size[1])
        # Per-project manifest entry
        try:
            from manifest import append_entry as _ma
            _ma(output_dir,
                kind='image_gen',
                path=img_path,
                engine='local-realvis',
                model='SG161222/RealVisXL_V4.0',
                prompt=prompt,
                full_prompt=optimized_prompt,
                negative_prompt=negative_prompt,
                steps=int(steps),
                guidance_scale=7.0,
                seed=int(_pipe_kwargs['generator'].initial_seed())
                     if hasattr(_pipe_kwargs.get('generator'), 'initial_seed') else None,
                width=1024, height=1024,
                bytes=_sz)
        except Exception:
            pass
        print(f"LOCAL_REALVIS_DONE: {img_path} ({_sz} bytes)")
        sys.stdout.flush()

    del pipe
    torch.cuda.empty_cache()

    _evt('pipeline_done', images=len(images),
         total_ms=int((time.time() - _t0) * 1000))
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
