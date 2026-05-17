"""One-shot RealVisXL image generation for test pipelines.
Minimal version of FabMesh's IPC image gen — just CLI.

    python gen_single_image.py "<prompt>" <out.png>
        [--seed 42] [--steps 30] [--guidance 7.0] [--size 1024]
"""
from __future__ import annotations
import argparse
import time
import torch
from diffusers import StableDiffusionXLPipeline


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('prompt')
    ap.add_argument('out')
    ap.add_argument('--seed', type=int, default=42)
    ap.add_argument('--steps', type=int, default=30)
    ap.add_argument('--guidance', type=float, default=7.0)
    ap.add_argument('--size', type=int, default=1024)
    ap.add_argument('--negative', default=
        'blurry, low quality, text, watermark, signature, deformed, '
        'extra limbs, bad anatomy, distorted, cropped, worst quality')
    args = ap.parse_args()

    t0 = time.time()
    print(f'[gen] loading RealVisXL V4.0...', flush=True)
    pipe = StableDiffusionXLPipeline.from_pretrained(
        'SG161222/RealVisXL_V4.0',
        torch_dtype=torch.float16, variant='fp16',
        use_safetensors=True)
    pipe.unet.to(torch.float16)
    pipe.vae.to(torch.float16)
    pipe.text_encoder.to(torch.float16)
    pipe.text_encoder_2.to(torch.float16)
    pipe.enable_model_cpu_offload()
    print(f'[gen] generating ({args.steps} steps, cfg={args.guidance})...', flush=True)
    full_prompt = (
        f'{args.prompt}, single isolated 3D subject, plain white background, '
        'even studio lighting, no shadows, no characters, centered, '
        'three-quarter view, clean silhouette, photorealistic, '
        'sharp details, detailed materials, professional photography, '
        '8k, sharp focus, masterpiece, no text, no watermark'
    )
    gen = torch.Generator('cuda').manual_seed(args.seed)
    img = pipe(
        prompt=full_prompt,
        negative_prompt=args.negative,
        num_inference_steps=args.steps,
        guidance_scale=args.guidance,
        width=args.size, height=args.size,
        generator=gen,
    ).images[0]
    img.save(args.out)
    print(f'[gen] DONE in {time.time()-t0:.1f}s -> {args.out}', flush=True)


if __name__ == '__main__':
    main()
