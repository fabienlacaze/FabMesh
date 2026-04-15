"""
Atlas refinement via SDXL img2img — Meshy-style texture polish.

Idea (asked by user, comparing to Meshy.ai):
  Meshy gets sharper textures because they pass the baked atlas through
  a *texture-aware diffusion model* before final export. We don't have
  that model, but we can approximate it by running RealVisXL img2img on
  the atlas at low strength: SDXL hallucinates plausible micro-detail
  (skin pores, fabric weave, scales, feathers) without changing the
  layout or the colours much.

Pipeline:
  1. Load atlas from <input>.glb. Always upscale to a square that's a
     multiple of 1024 (SDXL's native).
  2. Tile-process at 1024x1024 with 128 px overlap. Each tile gets
     img2img'd with a context-rich prompt and `strength` low enough
     that the colours/UV layout stay aligned.
  3. Blend overlapping tiles via a feathered mask so seams don't show.
  4. Re-pack the new atlas into the GLB (in-place, like upscale_atlas).

Talks to the always-on SDXL server on http://127.0.0.1:7777 to avoid
loading another 6 GB pipeline. If the server isn't running we fall
back to a local one-shot diffusers call (slower, more VRAM).

Usage:
    python texture_refine.py <input.glb> <output.glb> [--strength 0.25]
                              [--prompt "..."] [--target 2048]
"""
from __future__ import annotations

import argparse
import io
import json
import os
import struct
import sys
import time

import numpy as np
import requests
import torch
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from fabmesh_log import Logger
except Exception:
    Logger = None


SDXL_URL = 'http://127.0.0.1:7777'
TILE = 1024
OVERLAP = 128


def log(msg):
    print(f'[tex_refine] {msg}', flush=True)


def _server_alive() -> bool:
    try:
        r = requests.get(SDXL_URL + '/health', timeout=1.5)
        return r.status_code == 200
    except Exception:
        return False


def _img2img_via_server(tile: Image.Image, prompt: str, strength: float,
                        scratch_dir: str, idx: int) -> Image.Image:
    """Save tile to disk, POST, read result back."""
    in_path = os.path.join(scratch_dir, f'tile_{idx}_in.png')
    out_path = os.path.join(scratch_dir, f'tile_{idx}_out.png')
    tile.save(in_path)
    r = requests.post(SDXL_URL + '/img2img',
                      json={'input': in_path,
                            'prompt': prompt,
                            'output': out_path,
                            'strength': float(strength)},
                      timeout=180)
    j = r.json()
    if not j.get('ok'):
        raise RuntimeError(j.get('error') or 'img2img failed')
    return Image.open(out_path).convert('RGB')


def _img2img_local_fallback(tile: Image.Image, prompt: str,
                            strength: float) -> Image.Image:
    """One-shot RealVisXL img2img loaded in-process (slow first call)."""
    from diffusers import StableDiffusionXLImg2ImgPipeline
    if not hasattr(_img2img_local_fallback, '_pipe'):
        log('loading RealVisXL img2img in-process (no SDXL server)...')
        p = StableDiffusionXLImg2ImgPipeline.from_pretrained(
            'SG161222/RealVisXL_V4.0',
            torch_dtype=torch.float16,
        )
        p.enable_model_cpu_offload()
        _img2img_local_fallback._pipe = p
    pipe = _img2img_local_fallback._pipe
    s = max(0.1, min(1.0, float(strength)))
    steps = max(int(round(25 / s)), int(round(1 / s)) + 1)
    steps = min(steps, 60)
    with torch.inference_mode():
        out = pipe(
            prompt=f'{prompt}, high quality, detailed',
            image=tile, strength=s,
            num_inference_steps=steps, guidance_scale=6.0,
        ).images[0]
    return out


def _feather_mask(tile_w: int, tile_h: int, overlap: int,
                  is_left: bool, is_top: bool,
                  is_right: bool, is_bottom: bool) -> np.ndarray:
    """
    Per-tile alpha that fades from 0 at every overlapping border to 1
    inside the tile. Edge tiles keep their outer borders fully opaque.
    """
    m = np.ones((tile_h, tile_w), dtype=np.float32)
    if overlap <= 0:
        return m
    ramp = np.linspace(0, 1, overlap, dtype=np.float32)
    if not is_left:
        m[:, :overlap] *= ramp[None, :]
    if not is_right:
        m[:, -overlap:] *= ramp[::-1][None, :]
    if not is_top:
        m[:overlap, :] *= ramp[:, None]
    if not is_bottom:
        m[-overlap:, :] *= ramp[::-1][:, None]
    return m


def refine_atlas_image(atlas: Image.Image, prompt: str, strength: float,
                       use_server: bool, scratch_dir: str) -> Image.Image:
    """Main worker — tile + img2img + feather-blend."""
    W, H = atlas.size
    if (W, H) != (atlas.size[0], atlas.size[1]):
        atlas = atlas.convert('RGB')

    # Upsize so we have at least 1 tile
    target = max(W, H, TILE)
    if (W, H) != (target, target):
        atlas = atlas.resize((target, target), Image.LANCZOS)
        W = H = target

    src_arr = np.asarray(atlas.convert('RGB'), dtype=np.float32)
    accum = np.zeros_like(src_arr)
    weight = np.zeros((H, W, 1), dtype=np.float32)

    step = TILE - OVERLAP
    # Walk the grid in steps but never start a tile that would overflow
    # the atlas. Replace any out-of-bound start with W-TILE / H-TILE so
    # tiles always sit fully inside [0, W) x [0, H).
    xs = []
    x = 0
    while True:
        xs.append(min(x, W - TILE))
        if x + TILE >= W:
            break
        x += step
    ys = []
    y = 0
    while True:
        ys.append(min(y, H - TILE))
        if y + TILE >= H:
            break
        y += step
    # Dedupe in case the last clamp created a duplicate
    xs = sorted(set(xs))
    ys = sorted(set(ys))
    log(f'atlas {W}x{H} tiled into {len(xs)}x{len(ys)} = {len(xs)*len(ys)} 1024 tiles')

    idx = 0
    n_tiles = len(xs) * len(ys)
    for iy, y in enumerate(ys):
        for ix, x in enumerate(xs):
            t0 = time.time()
            tile = atlas.crop((x, y, x + TILE, y + TILE))
            try:
                if use_server:
                    refined = _img2img_via_server(tile, prompt, strength,
                                                   scratch_dir, idx)
                else:
                    refined = _img2img_local_fallback(tile, prompt, strength)
            except Exception as e:
                log(f'tile {idx+1}/{n_tiles} FAILED ({e}) — using original')
                refined = tile
            r_arr = np.asarray(refined.convert('RGB'), dtype=np.float32)
            mask = _feather_mask(TILE, TILE, OVERLAP,
                                  is_left=(ix == 0),
                                  is_right=(ix == len(xs) - 1),
                                  is_top=(iy == 0),
                                  is_bottom=(iy == len(ys) - 1))[..., None]
            accum[y:y + TILE, x:x + TILE] += r_arr * mask
            weight[y:y + TILE, x:x + TILE] += mask
            log(f'tile {idx+1}/{n_tiles} ({time.time()-t0:.1f}s)')
            idx += 1

    # Weighted average; where weight==0 (shouldn't happen) keep source
    safe_w = np.where(weight < 1e-6, 1.0, weight)
    out = accum / safe_w
    out = np.where(weight < 1e-6, src_arr, out)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


def replace_glb_atlas(input_glb: str, output_glb: str,
                     new_atlas: Image.Image) -> None:
    """In-place texture swap (same logic as upscale_atlas.py)."""
    import shutil
    if os.path.abspath(input_glb) != os.path.abspath(output_glb):
        shutil.copy(input_glb, output_glb)
    with open(output_glb, 'rb') as f:
        data = bytearray(f.read())
    if struct.unpack_from('<I', data, 0)[0] != 0x46546C67:
        raise RuntimeError('not a GLB')

    offset = 12
    json_chunk = None
    json_chunk_offset = 0
    json_chunk_len = 0
    bin_chunk_offset = 0
    bin_chunk_len = 0
    while offset < len(data):
        chunk_len, chunk_type = struct.unpack_from('<II', data, offset)
        if chunk_type == 0x4E4F534A:
            json_chunk_offset = offset + 8
            json_chunk_len = chunk_len
            json_chunk = json.loads(
                data[offset + 8: offset + 8 + chunk_len].decode('utf-8'))
        elif chunk_type == 0x004E4942:
            bin_chunk_offset = offset + 8
            bin_chunk_len = chunk_len
        offset += 8 + chunk_len

    images = (json_chunk or {}).get('images', []) or []
    buffer_views = (json_chunk or {}).get('bufferViews', []) or []
    if not images or not bin_chunk_offset:
        raise RuntimeError('no images / no BIN')

    # Resolve baseColorTexture explicitly via materials → don't
    # accidentally overwrite the normal map (image[0] vs image[1]
    # depending on how SF3D ordered them).
    materials = (json_chunk or {}).get('materials', []) or []
    textures = (json_chunk or {}).get('textures', []) or []
    base_color_image_idx = 0
    for mat in materials:
        pbr = mat.get('pbrMetallicRoughness') or {}
        bct = pbr.get('baseColorTexture') or {}
        tex_idx = bct.get('index')
        if tex_idx is not None and tex_idx < len(textures):
            src_idx = textures[tex_idx].get('source')
            if src_idx is not None:
                base_color_image_idx = src_idx
                break
    log(f'replacing image[{base_color_image_idx}] (baseColorTexture)')

    # Encode new atlas
    img_info = images[base_color_image_idx]
    bv = buffer_views[img_info['bufferView']]
    img_offset = bin_chunk_offset + bv.get('byteOffset', 0)
    img_length = bv['byteLength']
    buf = io.BytesIO()
    new_atlas.save(buf, format='JPEG', quality=92)
    new_bytes = buf.getvalue()
    img_info['mimeType'] = 'image/jpeg'

    if len(new_bytes) <= img_length:
        data[img_offset: img_offset + len(new_bytes)] = new_bytes
        data[img_offset + len(new_bytes): img_offset + img_length] = b'\x00' * (img_length - len(new_bytes))
        with open(output_glb, 'wb') as f:
            f.write(data)
    else:
        old_bin_len = struct.unpack_from('<I', data, bin_chunk_offset - 8)[0]
        new_off = old_bin_len
        pad = (4 - (len(new_bytes) % 4)) % 4
        new_bin = (bytes(data[bin_chunk_offset: bin_chunk_offset + old_bin_len])
                   + new_bytes + b'\x00' * pad)
        bv['byteOffset'] = new_off
        bv['byteLength'] = len(new_bytes)
        if json_chunk.get('buffers'):
            json_chunk['buffers'][0]['byteLength'] = len(new_bin)
        json_str = json.dumps(json_chunk, separators=(',', ':')).encode('utf-8')
        json_pad = (4 - (len(json_str) % 4)) % 4
        json_chunk_data = json_str + b' ' * json_pad
        out = bytearray()
        total_len = 12 + 8 + len(json_chunk_data) + 8 + len(new_bin)
        out += struct.pack('<III', 0x46546C67, 2, total_len)
        out += struct.pack('<II', len(json_chunk_data), 0x4E4F534A)
        out += json_chunk_data
        out += struct.pack('<II', len(new_bin), 0x004E4942)
        out += new_bin
        with open(output_glb, 'wb') as f:
            f.write(out)


def refine(input_glb: str, output_glb: str, strength: float = 0.25,
           prompt: str | None = None, target: int | None = None) -> bool:
    import trimesh
    t0 = time.time()
    slog = Logger('tex_refine', input=os.path.basename(input_glb)) if Logger else None
    if slog: slog.info('pipeline_started', strength=strength,
                       target=target, prompt=prompt)

    m = trimesh.load(input_glb, process=False)
    geom = list(m.geometry.values())[0] if hasattr(m, 'geometry') else m
    tex = geom.visual.material.baseColorTexture
    if tex is None:
        log('ERROR: no baseColorTexture')
        return False
    src = tex.convert('RGB')
    log(f'source atlas {src.size}')

    if target and target > 0:
        if src.size != (target, target):
            src = src.resize((target, target), Image.LANCZOS)
            log(f'resized to {target}x{target} before refinement')

    use_server = _server_alive()
    log(f'SDXL server alive: {use_server}')

    if not prompt:
        prompt = ('photorealistic detailed surface texture, '
                  'natural materials, sharp focus, 8k')
    else:
        # Subject-aware refine: keep the subject identity from the user's
        # original prompt, append the texture-quality keywords. SDXL is
        # then nudged to refine ON THE RIGHT subject (an orc, a chicken)
        # instead of hallucinating a generic photoreal something.
        prompt = (prompt
                  + ', photorealistic detailed surface texture, '
                    'natural materials, sharp focus, 8k')
    log(f'prompt: {prompt[:120]}{"..." if len(prompt) > 120 else ""}')

    scratch = os.path.join(os.path.dirname(os.path.abspath(output_glb)),
                            '.refine_scratch')
    os.makedirs(scratch, exist_ok=True)
    try:
        new_atlas = refine_atlas_image(src, prompt, strength,
                                        use_server, scratch)
        replace_glb_atlas(input_glb, output_glb, new_atlas)
    finally:
        # Best-effort cleanup
        try:
            for f in os.listdir(scratch):
                try: os.remove(os.path.join(scratch, f))
                except Exception: pass
            os.rmdir(scratch)
        except Exception:
            pass

    sz = os.path.getsize(output_glb)
    log(f'done in {time.time()-t0:.1f}s ({sz} bytes)')
    if slog: slog.info('pipeline_done', bytes=sz, ms=int((time.time()-t0)*1000))
    return True


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('input')
    p.add_argument('output')
    p.add_argument('--strength', type=float, default=0.25,
                   help='SDXL img2img strength (0=noop, 1=full repaint)')
    p.add_argument('--prompt', default=None,
                   help='Refinement prompt')
    p.add_argument('--target', type=int, default=None,
                   help='Resize atlas to this square size before refinement')
    args = p.parse_args()
    try:
        ok = refine(args.input, args.output, args.strength,
                    args.prompt, args.target)
        sys.exit(0 if ok else 1)
    except Exception as e:
        import traceback
        traceback.print_exc()
        log(f'ERROR: {type(e).__name__}: {e}')
        sys.exit(2)
