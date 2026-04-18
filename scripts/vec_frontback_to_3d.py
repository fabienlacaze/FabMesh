"""Front+Back via vector-ref IPA, then CRM-stage1 slots, then SF3D -> GLB.

Hypothesis: feeding a VECTORIZED (vtracer) reference to IPA-Plus strips
photographic noise and yields a more faithful silhouette on the hardest
view (back), while still preserving palette.

Pipeline:
  1. vtracer(ref_photo) -> SVG -> rasterize back to PNG (vector_ref.png)
  2. SDXL + IPA-Plus(vector_ref, scale=0.55) + prompt 'back view' -> back.png
  3. Write 6-slot CRM-compatible mv dir:
       view_0 = front (photo)       az=0
       view_1 = front (photo)       az=90  (duplicated, CRM tolerates)
       view_2 = back  (vector-IPA)  az=180
       view_3 = back  (vector-IPA)  az=270
       view_4 = front                az=0,  el=+90 (top placeholder)
       view_5 = back                 az=180,el=-90 (bottom placeholder)
  4. Call the existing SF3D bridge on that mv dir to produce the GLB.

Output: logs/<run>/mesh.glb  + front.png, back.png, vector_ref.png
"""
from __future__ import annotations
import os
import sys
import time
import argparse
import subprocess
import shutil


def log(msg):
    print(f'[vec_fb] {msg}', flush=True)


def vectorize(ref_photo: str, out_png: str, size: int = 1024) -> None:
    import vtracer
    from PIL import Image
    import cairosvg
    import io

    svg_path = out_png + '.svg'
    log(f'vtracer -> {svg_path}')
    vtracer.convert_image_to_svg_py(
        ref_photo, svg_path,
        colormode='color',
        hierarchical='stacked',
        mode='spline',
        filter_speckle=4,
        color_precision=6,
        layer_difference=16,
        corner_threshold=60,
        length_threshold=4.0,
        splice_threshold=45,
        path_precision=3,
    )
    log(f'rasterize SVG -> {out_png} ({size}x{size})')
    png_bytes = cairosvg.svg2png(
        url=svg_path, output_width=size, output_height=size,
        background_color='white',
    )
    img = Image.open(io.BytesIO(png_bytes)).convert('RGB')
    img.save(out_png)


def gen_back_view(vector_ref: str, out_png: str, steps: int = 35,
                  ip_scale: float = 0.55, seed: int | None = None) -> None:
    import torch
    from PIL import Image
    from diffusers import StableDiffusionXLPipeline
    from transformers import CLIPVisionModelWithProjection

    log('loading RealVisXL v4.0 + IPA-Plus SDXL...')
    image_encoder = CLIPVisionModelWithProjection.from_pretrained(
        'h94/IP-Adapter', subfolder='models/image_encoder',
        torch_dtype=torch.float16)
    pipe = StableDiffusionXLPipeline.from_pretrained(
        'SG161222/RealVisXL_V4.0',
        torch_dtype=torch.float16, variant='fp16', use_safetensors=True,
        image_encoder=image_encoder)
    pipe.load_ip_adapter(
        'h94/IP-Adapter', subfolder='sdxl_models',
        weight_name='ip-adapter-plus_sdxl_vit-h.safetensors')
    pipe.set_ip_adapter_scale(ip_scale)
    pipe.enable_model_cpu_offload()

    if seed is None:
        seed = int(time.time()) & 0xFFFFFFFF
    log(f'seed={seed} ip_scale={ip_scale}')

    ref_img = Image.open(vector_ref).convert('RGB')
    prompt = (
        'rear view from behind, back of the body facing camera, '
        'turned around, back of the head visible, no face, '
        'full body, centered, same character, same outfit, '
        'plain light gray background, studio lighting, ultra detailed, '
        '8k, sharp focus, professional photography, masterpiece')
    neg = (
        'blurry, low quality, text, watermark, signature, deformed, '
        'extra limbs, bad anatomy, distorted, cropped, worst quality, '
        'different person, different clothes, multiple people, duplicate')

    t0 = time.time()
    out = pipe(
        prompt=prompt, negative_prompt=neg,
        ip_adapter_image=ref_img,
        num_inference_steps=steps, guidance_scale=7.0,
        height=1024, width=1024,
        generator=torch.Generator('cuda').manual_seed(seed),
    ).images[0]
    out.save(out_png)
    log(f'back view generated in {time.time()-t0:.1f}s -> {out_png}')

    del pipe
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def build_mv_dir(mv_dir: str, front_png: str, back_png: str) -> None:
    import json
    from PIL import Image
    os.makedirs(mv_dir, exist_ok=True)
    front = Image.open(front_png).convert('RGB').resize((1024, 1024))
    back = Image.open(back_png).convert('RGB').resize((1024, 1024))

    front.save(os.path.join(mv_dir, 'input.png'))
    slot_map = {
        0: front,   # front  az=0   el=0
        1: front,   # dup as right
        2: back,    # back   az=180 el=0
        3: back,    # dup as left
        4: front,   # top placeholder
        5: back,    # bottom placeholder
    }
    for slot, img in slot_map.items():
        img.save(os.path.join(mv_dir, f'view_{slot}.png'))

    views = [
        {'slot': 0, 'azim':   0, 'elev':   0, 'label': 'front'},
        {'slot': 1, 'azim':  90, 'elev':   0, 'label': 'right_dup_front'},
        {'slot': 2, 'azim': 180, 'elev':   0, 'label': 'back'},
        {'slot': 3, 'azim': 270, 'elev':   0, 'label': 'left_dup_back'},
        {'slot': 4, 'azim':   0, 'elev':  90, 'label': 'top_dup_front'},
        {'slot': 5, 'azim':   0, 'elev': -90, 'label': 'bottom_dup_back'},
    ]
    with open(os.path.join(mv_dir, 'views.json'), 'w') as f:
        json.dump(views, f, indent=2)
    log(f'mv dir written -> {mv_dir}')


def run_sf3d(mv_dir: str, glb_out: str) -> None:
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          'local_sf3d_bridge.py')
    cmd = [sys.executable, script, mv_dir, glb_out]
    log(f'running SF3D: {" ".join(cmd)}')
    r = subprocess.run(cmd, check=False)
    if r.returncode != 0:
        raise RuntimeError(f'sf3d bridge failed: rc={r.returncode}')
    log(f'glb -> {glb_out}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('ref_photo')
    ap.add_argument('out_dir')
    ap.add_argument('--steps', type=int, default=35)
    ap.add_argument('--ip-scale', type=float, default=0.55)
    ap.add_argument('--seed', type=int, default=None)
    ap.add_argument('--skip-sf3d', action='store_true')
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    front_png = os.path.join(args.out_dir, 'front.png')
    vector_png = os.path.join(args.out_dir, 'vector_ref.png')
    back_png = os.path.join(args.out_dir, 'back.png')
    mv_dir = os.path.join(args.out_dir, 'mv')
    glb_out = os.path.join(args.out_dir, 'mesh.glb')

    shutil.copy(args.ref_photo, front_png)
    vectorize(args.ref_photo, vector_png)
    gen_back_view(vector_png, back_png, steps=args.steps,
                  ip_scale=args.ip_scale, seed=args.seed)
    build_mv_dir(mv_dir, front_png, back_png)

    if args.skip_sf3d:
        log('skip-sf3d set, stopping before GLB')
        return
    run_sf3d(mv_dir, glb_out)
    log(f'DONE: {glb_out}')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        log(f'ERROR: {type(e).__name__}: {e}')
        import traceback; traceback.print_exc()
        sys.exit(1)
