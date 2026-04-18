"""
Atlas-only sharpener: take a GLB with a baked baseColorTexture (typically
the blurry one Stable Fast 3D ships with) and replace it with the same
texture upscaled 2x or 4x via RealESRGAN x4plus.

The mesh, faces, UVs, materials are untouched — we only swap the image
data inside the buffer. So the rendered look gets sharper without
touching topology, projection, or anything else that broke before.

Usage:
    python upscale_atlas.py <input.glb> <output.glb> [--scale 4] [--target 2048]

If --target is given, the upscaled image is resized to that resolution
(useful when SF3D produced a 1024 atlas and you want to cap at 2048).
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
import torch
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from fabmesh_log import Logger
except Exception:
    Logger = None


def log(msg):
    print(f'[atlas_up] {msg}', flush=True)


def upscale_image(img: Image.Image, target_size: int | None = None) -> Image.Image:
    """Upscale via RealESRGAN x4plus (BSD-3-Clause, commercial-safe).

    NOTE 2026-04-19: 4x-UltraSharp / Remacri alternatives were considered
    for better texture quality, but their distribution on HuggingFace/Civitai
    does not include an explicit commercial license. Sticking with x4plus
    which has clean BSD-3 licensing. Improvement: tile_pad raised 10->32
    to reduce seam artefacts at UV chart edges.
    """
    from realesrgan import RealESRGANer
    from basicsr.archs.rrdbnet_arch import RRDBNet

    model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64,
                    num_block=23, num_grow_ch=32, scale=4)
    model_path = ('https://github.com/xinntao/Real-ESRGAN/releases/'
                  'download/v0.1.0/RealESRGAN_x4plus.pth')
    upsampler = RealESRGANer(
        scale=4, model_path=model_path, model=model,
        tile=512, tile_pad=32, pre_pad=0, half=True,
        device='cuda' if torch.cuda.is_available() else 'cpu',
    )
    arr = np.asarray(img.convert('RGB'))
    # UV chart dilation: SF3D atlases have ~300 UV charts with gaps between
    # them. ESRGAN bleeds across chart borders because it sees the gaps as
    # edges. Dilate the filled pixels into the gap by ~4px so the ESRGAN
    # "sees" continuous content. Detect gap = uniform magenta / near-black /
    # exact SF3D padding colour (it's the constant dilate_fill border).
    try:
        from scipy import ndimage as _ndi
        # Background mask heuristic: pixels that are exactly the same across
        # R/G/B AND close to 0 or 255 are typically padding. Safer mask = flat
        # pixels matching the mode colour at image corners.
        _corners = arr[[0, 0, -1, -1], [0, -1, 0, -1]]
        _corner_mode = np.mean(_corners, axis=0).astype(np.int32)
        _diff = np.abs(arr.astype(np.int32) - _corner_mode).sum(axis=-1)
        _bg_mask = _diff < 8  # near-identical to padding colour
        if _bg_mask.mean() > 0.05 and _bg_mask.mean() < 0.90:
            # Dilate the foreground into the background by ~4px
            _fg = ~_bg_mask
            # EDT of the BG: for each bg pixel, find nearest fg pixel coords
            _, (_yi, _xi) = _ndi.distance_transform_edt(
                _bg_mask, return_indices=True,
            )
            _mask_close = _bg_mask & (_ndi.distance_transform_edt(_bg_mask) < 6)
            arr = arr.copy()
            arr[_mask_close] = arr[_yi[_mask_close], _xi[_mask_close]]
            log(f'UV dilation applied to {_bg_mask.mean()*100:.1f}% padding')
    except Exception as _de:
        log(f'UV dilation skipped ({_de})')
    out_arr, _ = upsampler.enhance(arr, outscale=4)
    out = Image.fromarray(out_arr)
    del upsampler, model
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    if target_size and out.size != (target_size, target_size):
        out = out.resize((target_size, target_size), Image.LANCZOS)
    return out


def upscale_atlas_in_glb(input_path: str, output_path: str,
                        target_size: int | None = None) -> bool:
    t0 = time.time()
    slog = Logger('atlas_up', input=os.path.basename(input_path)) if Logger else None
    if slog: slog.info('pipeline_started', input=input_path, output=output_path,
                       target_size=target_size)

    # Read the GLB and find every embedded image. We don't use trimesh
    # here so the geometry, materials, samplers etc. are bit-for-bit
    # preserved — only the buffer slice that holds the PNG/JPEG bytes
    # of the baseColorTexture is touched.
    with open(input_path, 'rb') as f:
        data = bytearray(f.read())

    if struct.unpack_from('<I', data, 0)[0] != 0x46546C67:
        log('ERROR: not a GLB')
        return False

    # Walk chunks
    offset = 12
    json_chunk = None
    json_chunk_offset = 0
    json_chunk_len = 0
    bin_chunk_offset = 0
    bin_chunk_len = 0
    while offset < len(data):
        chunk_len, chunk_type = struct.unpack_from('<II', data, offset)
        if chunk_type == 0x4E4F534A:  # JSON
            json_chunk_offset = offset + 8
            json_chunk_len = chunk_len
            json_chunk = json.loads(
                data[offset+8 : offset+8+chunk_len].decode('utf-8'))
        elif chunk_type == 0x004E4942:  # BIN
            bin_chunk_offset = offset + 8
            bin_chunk_len = chunk_len
        offset += 8 + chunk_len

    if not json_chunk or not bin_chunk_offset:
        log('ERROR: missing JSON or BIN chunk')
        return False

    images = json_chunk.get('images', []) or []
    buffer_views = json_chunk.get('bufferViews', []) or []
    if not images:
        log('ERROR: no images in GLB')
        return False
    log(f'GLB has {len(images)} embedded image(s); '
        f'BIN chunk = {bin_chunk_len} bytes')

    # Find which image index is the baseColorTexture — we ONLY upscale
    # that one. Normal maps must stay untouched (RealESRGAN trained on
    # photos would smooth out the directional XY components, killing
    # the bump effect). roughness/metallic are scalars in our pipeline,
    # not textures.
    materials = (json_chunk or {}).get('materials', []) or []
    textures = (json_chunk or {}).get('textures', []) or []
    base_color_image_idx = None
    for mat in materials:
        pbr = mat.get('pbrMetallicRoughness') or {}
        bct = pbr.get('baseColorTexture') or {}
        tex_idx = bct.get('index')
        if tex_idx is not None and tex_idx < len(textures):
            src_idx = textures[tex_idx].get('source')
            if src_idx is not None:
                base_color_image_idx = src_idx
                break
    log(f'baseColorTexture is image[{base_color_image_idx}] '
        f'(out of {len(images)} images in GLB)')

    # We rebuild the binary buffer from scratch: copy every buffer view
    # except those that point to images we replace, then append the
    # upscaled images at the end with new (offset, length).
    img_view_idx_to_new_bytes = {}
    for i_img, img_info in enumerate(images):
        if base_color_image_idx is not None and i_img != base_color_image_idx:
            log(f'image {i_img}: NOT baseColor, keeping as-is')
            continue
        bv_idx = img_info.get('bufferView')
        if bv_idx is None:
            log(f'image {i_img}: no bufferView, skipping')
            continue
        bv = buffer_views[bv_idx]
        img_offset = bin_chunk_offset + bv.get('byteOffset', 0)
        img_length = bv['byteLength']
        old_bytes = bytes(data[img_offset : img_offset + img_length])
        try:
            old_img = Image.open(io.BytesIO(old_bytes))
            old_size = old_img.size
        except Exception as e:
            log(f'image {i_img}: cannot decode ({e}), skipping')
            continue
        log(f'image {i_img}: {old_size[0]}x{old_size[1]} -> upscaling...')
        if slog: slog.info('atlas_decode', index=i_img,
                           w=old_size[0], h=old_size[1],
                           bytes_in=img_length)

        try:
            upscaled = upscale_image(old_img, target_size=target_size)
        except Exception as ue:
            log(f'image {i_img}: upscale failed ({ue}), keeping original')
            if slog: slog.warn('upscale_failed', index=i_img,
                               reason=str(ue)[:200])
            continue

        # JPEG quality 95 first, then back off if it's larger than the slot
        buf = io.BytesIO()
        upscaled.save(buf, format='JPEG', quality=95)
        new_bytes = buf.getvalue()
        new_mime = 'image/jpeg'
        log(f'image {i_img}: encoded {len(new_bytes)} bytes JPEG q=95 '
            f'(target_size={upscaled.size})')
        img_view_idx_to_new_bytes[bv_idx] = (new_bytes, new_mime,
                                              upscaled.size, i_img)

    if not img_view_idx_to_new_bytes:
        log('ERROR: no image was successfully upscaled')
        return False

    # Rebuild BIN: every buffer view except those we replace, in same
    # offset order, then append the new image bytes at the end and
    # rewrite their bufferView entries.
    new_bin = bytearray()
    new_bv_offsets = {}  # old bv index -> (new_offset, new_length)
    # First, copy non-image bufferViews keeping their relative order
    sorted_bvs = sorted(enumerate(buffer_views),
                        key=lambda x: x[1].get('byteOffset', 0))
    for bv_idx, bv in sorted_bvs:
        if bv_idx in img_view_idx_to_new_bytes:
            continue  # write later
        old_off = bv.get('byteOffset', 0)
        bv_len = bv['byteLength']
        # Pad to 4 bytes for the next view (per glTF spec)
        pad = (4 - (len(new_bin) % 4)) % 4
        new_bin += b'\x00' * pad
        new_offset = len(new_bin)
        new_bin += bytes(data[bin_chunk_offset + old_off :
                              bin_chunk_offset + old_off + bv_len])
        new_bv_offsets[bv_idx] = (new_offset, bv_len)
    # Append upscaled images
    for bv_idx, (new_bytes, new_mime, _, i_img) in img_view_idx_to_new_bytes.items():
        pad = (4 - (len(new_bin) % 4)) % 4
        new_bin += b'\x00' * pad
        new_offset = len(new_bin)
        new_bin += new_bytes
        new_bv_offsets[bv_idx] = (new_offset, len(new_bytes))
        # Patch image record's mimeType
        images[i_img]['mimeType'] = new_mime

    # Patch all bufferViews with new offsets / lengths
    for bv_idx, bv in enumerate(buffer_views):
        if bv_idx in new_bv_offsets:
            new_off, new_len = new_bv_offsets[bv_idx]
            bv['byteOffset'] = new_off
            bv['byteLength'] = new_len

    # Patch buffers[0].byteLength
    if json_chunk.get('buffers'):
        json_chunk['buffers'][0]['byteLength'] = len(new_bin)

    # Re-serialise JSON (pad to 4 bytes with spaces per glTF spec)
    json_str = json.dumps(json_chunk, separators=(',', ':')).encode('utf-8')
    json_pad = (4 - (len(json_str) % 4)) % 4
    json_chunk_data = json_str + b' ' * json_pad
    bin_pad = (4 - (len(new_bin) % 4)) % 4
    new_bin = bytes(new_bin) + b'\x00' * bin_pad

    out = bytearray()
    total_len = 12 + 8 + len(json_chunk_data) + 8 + len(new_bin)
    out += struct.pack('<III', 0x46546C67, 2, total_len)
    out += struct.pack('<II', len(json_chunk_data), 0x4E4F534A)
    out += json_chunk_data
    out += struct.pack('<II', len(new_bin), 0x004E4942)
    out += new_bin

    with open(output_path, 'wb') as f:
        f.write(out)
    sz = os.path.getsize(output_path)
    log(f'wrote {sz} bytes in {time.time()-t0:.1f}s')
    if slog: slog.info('pipeline_done', bytes=sz,
                       ms=int((time.time()-t0)*1000))
    return True


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('input')
    p.add_argument('output')
    p.add_argument('--target', type=int, default=None,
                   help='Final atlas size in pixels (default: 4x input)')
    args = p.parse_args()
    try:
        ok = upscale_atlas_in_glb(args.input, args.output, args.target)
        sys.exit(0 if ok else 1)
    except Exception as e:
        import traceback
        traceback.print_exc()
        log(f'ERROR: {type(e).__name__}: {e}')
        sys.exit(2)
