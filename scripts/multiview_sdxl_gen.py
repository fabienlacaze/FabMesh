"""
FabMesh Multi-View Generation via RealVisXL + IPAdapter Plus — Option 2.
================================================================================

Generates 3 additional views (right, back, left) matching the input's identity
and clothing by feeding the input image as a visual reference via IPAdapter.

Licenses — all commercial-safe for a paid desktop app:
  - RealVisXL v4.0     : OpenRAIL++-M (SDXL derivative)
  - IP-Adapter Plus    : Apache 2.0
  - CLIP image encoder : MIT (h94/IP-Adapter ships it in /models/image_encoder)

Note: IP-Adapter-FaceID is NOT used (research-only license). IP-Adapter Plus
captures identity well enough for full-body references without the FaceID
restriction.

Output layout matches scripts/multiview_gen.py so texture_project.py stays
drop-in compatible:
    <output_dir>/input.png     (copy of the user's front image)
    <output_dir>/view_0..5.png (right/back/left duplicated into 6 slots)

Usage:
    python multiview_sdxl_gen.py <input_image> <prompt> <output_dir> [--steps N]
"""
import sys
import os
import time
import argparse
import torch
from PIL import Image


def log(msg):
    print(f'[multiview_sdxl] {msg}', flush=True)


# Per-orientation prompt + IPAdapter scale. Profile views need a LOWER scale
# than the back view because SDXL's prior is heavily biased toward 3/4 frontal
# portraits; the IPAdapter reference (which is frontal) reinforces that bias.
# Dropping scale on profile lets the orientation prompt win.
ORIENTATIONS = {
    'right': {
        'prompt': ('strict 90 degree right side profile, face pointing to the left, '
                   'showing only half of the face, ear visible, nose pointing left'),
        'ip_scale': 0.35,
    },
    'back': {
        'prompt': ('rear view from behind, back of the body facing camera, '
                   'turned around, back of the head visible, no face'),
        'ip_scale': 0.55,
    },
    'left': {
        'prompt': ('strict 90 degree left side profile, face pointing to the right, '
                   'showing only half of the face, ear visible, nose pointing right'),
        'ip_scale': 0.35,
    },
}

SLOT_MAP = {
    0: 'right',   # 30°
    1: 'right',   # 90°
    2: 'back',    # 150°
    3: 'back',    # 210°
    4: 'left',    # 270°
    5: 'left',    # 330°
}


def generate_multiview(input_image_path, prompt, output_dir, steps=30,
                       scale_bias=0.0):
    t0 = time.time()
    log(f'input={input_image_path}')
    log(f'prompt={prompt!r}')
    log(f'output_dir={output_dir} scale_bias={scale_bias}')
    os.makedirs(output_dir, exist_ok=True)

    ref_img = Image.open(input_image_path).convert('RGB')
    log(f'ref size: {ref_img.size}')

    # Copy front input as the "0 degree" reference.
    front_path = os.path.join(output_dir, 'input.png')
    ref_img.save(front_path)

    log('loading RealVisXL v4.0 + IPAdapter Plus...')
    log('MULTIVIEW_PROGRESS: 10')

    from diffusers import StableDiffusionXLPipeline
    from transformers import CLIPVisionModelWithProjection

    # IPAdapter Plus SDXL was trained against CLIP ViT-H (not the default
    # ViT-bigG that SDXL uses for text). Load it explicitly, otherwise the
    # projection layer dims don't match and the UNet crashes at inference.
    image_encoder = CLIPVisionModelWithProjection.from_pretrained(
        "h94/IP-Adapter",
        subfolder="models/image_encoder",
        torch_dtype=torch.float16,
    )

    pipe = StableDiffusionXLPipeline.from_pretrained(
        "SG161222/RealVisXL_V4.0",
        torch_dtype=torch.float16,
        variant="fp16",
        use_safetensors=True,
        image_encoder=image_encoder,
    )

    # Load IPAdapter Plus (SDXL variant). h94/IP-Adapter is Apache 2.0.
    pipe.load_ip_adapter(
        "h94/IP-Adapter",
        subfolder="sdxl_models",
        weight_name="ip-adapter-plus_sdxl_vit-h.safetensors",
    )
    # scale gets reset per view below
    pipe.enable_model_cpu_offload()
    log(f'pipeline loaded in {time.time()-t0:.1f}s')
    log('MULTIVIEW_PROGRESS: 25')

    seed = int(time.time()) & 0xFFFFFFFF
    log(f'shared seed={seed}')

    generated = {}
    progress = 25
    step_per_view = 70 // len(ORIENTATIONS)

    for orientation, cfg in ORIENTATIONS.items():
        view_scale = max(0.0, min(1.0, cfg['ip_scale'] + scale_bias))
        pipe.set_ip_adapter_scale(view_scale)
        log(f'generating {orientation} view (ip_scale={view_scale:.2f})...')
        styled_prompt = (
            f"{prompt}, {cfg['prompt']}, "
            f"full body, centered, same character, same outfit, "
            f"plain light gray background, studio lighting, ultra detailed, "
            f"8k, sharp focus, professional photography, masterpiece"
        )
        negative_prompt = (
            "blurry, low quality, text, watermark, signature, deformed, "
            "extra limbs, bad anatomy, distorted, cropped, worst quality, "
            "different person, different clothes, different outfit, "
            "multiple people, duplicate, nude, shirtless, underwear"
        )

        result = pipe(
            prompt=styled_prompt,
            negative_prompt=negative_prompt,
            ip_adapter_image=ref_img,
            num_inference_steps=int(steps),
            guidance_scale=7.0,
            height=1024,
            width=1024,
            generator=torch.Generator("cuda").manual_seed(seed),
        )
        generated[orientation] = result.images[0]
        progress += step_per_view
        log(f'MULTIVIEW_PROGRESS: {progress}')

    log('MULTIVIEW_PROGRESS: 95')
    for slot, orientation in SLOT_MAP.items():
        vpath = os.path.join(output_dir, f'view_{slot}.png')
        generated[orientation].save(vpath)
        log(f'saved view_{slot}.png ({orientation})')

    del pipe
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    log(f'done in {time.time()-t0:.1f}s')
    log('MULTIVIEW_PROGRESS: 100')
    return True


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('input_image')
    parser.add_argument('prompt')
    parser.add_argument('output_dir')
    parser.add_argument('--steps', type=int, default=30)
    parser.add_argument('--scale-bias', type=float, default=0.0,
                        help='Shift per-view IP scales by this amount '
                             '(negative = more rotation, less identity)')
    args = parser.parse_args()

    try:
        ok = generate_multiview(args.input_image, args.prompt,
                                args.output_dir, args.steps,
                                scale_bias=args.scale_bias)
        sys.exit(0 if ok else 1)
    except Exception as e:
        log(f'ERROR: {type(e).__name__}: {e}')
        import traceback
        traceback.print_exc()
        sys.exit(2)
