"""
FabMesh Texture Projection — re-project source photo onto 3D mesh UV atlas.
===========================================================================

Improves SF3D's blurry baked textures by projecting the original high-res
source photo back onto the mesh. Uses numpy vectorized operations for speed.

Strategy:
  1. For each vertex: project 3D position onto source image (orthographic)
  2. Sample source image color at projected position
  3. Visibility weight: dot(normal, camera_dir) — front-facing = high weight
  4. Render the UV atlas by rasterizing each face with interpolated colors
  5. Blend: visible areas get source photo, hidden areas keep SF3D texture

Usage:
    python texture_project.py <mesh.glb> <source_image> <output.glb> [resolution]
"""
import sys
import os
import struct
import json
import io
import time
import numpy as np
from PIL import Image, ImageDraw


def log(msg):
    print(f'[tex_project] {msg}', flush=True)


def project_texture(mesh_path, source_image_path, output_path, tex_res=1024):
    """Project source photo onto mesh UV atlas and save result."""
    import trimesh

    t0 = time.time()
    log(f'mesh={mesh_path} src={source_image_path} out={output_path} res={tex_res}')

    # Load mesh
    scene = trimesh.load(mesh_path)
    geoms = list(scene.geometry.values()) if hasattr(scene, 'geometry') else [scene]
    geom = geoms[0]
    vertices = np.asarray(geom.vertices, dtype=np.float64)
    faces = np.asarray(geom.faces, dtype=np.int32)
    normals = np.asarray(geom.vertex_normals, dtype=np.float64)
    uv = np.asarray(geom.visual.uv, dtype=np.float64)

    log(f'mesh: {len(vertices)} verts, {len(faces)} faces')

    # Load source image
    src_img = Image.open(source_image_path).convert('RGBA')
    src_w, src_h = src_img.size
    src_pixels = np.asarray(src_img)  # (H, W, 4)
    log(f'source: {src_w}x{src_h}')

    # Load SF3D texture as fallback
    sf3d_tex = geom.visual.material.baseColorTexture
    if sf3d_tex is None:
        log('ERROR: no baseColorTexture'); return False
    sf3d_tex = sf3d_tex.convert('RGB').resize((tex_res, tex_res), Image.LANCZOS)

    # ---------------------------------------------------------------
    # Step 1: Per-vertex projection from 3D to source image
    # Orthographic front view: camera at +Z looking at -Z, Y up
    # ---------------------------------------------------------------
    bounds = geom.bounds
    extents = bounds[1] - bounds[0]
    view_dir = np.array([0.0, 0.0, -1.0])

    # Project: x -> u [0,1], y -> v [0,1] (image space, top=0)
    proj_u = (vertices[:, 0] - bounds[0][0]) / max(extents[0], 1e-8)
    proj_v = 1.0 - (vertices[:, 1] - bounds[0][1]) / max(extents[1], 1e-8)

    # Sample source image for each vertex
    ix = np.clip((proj_u * src_w).astype(int), 0, src_w - 1)
    iy = np.clip((proj_v * src_h).astype(int), 0, src_h - 1)
    vertex_colors = src_pixels[iy, ix, :3].astype(np.float64)  # (V, 3) RGB
    vertex_alpha = src_pixels[iy, ix, 3].astype(np.float64) / 255.0  # (V,) alpha from rembg

    # Visibility: how much the vertex faces the camera
    # dot(normal, -view_dir) = normal_z (since view_dir = [0,0,-1])
    visibility = normals[:, 2].copy()  # positive = facing front
    visibility = np.clip(visibility, 0, 1)
    # Combine with alpha from source (rembg: 0 = background, 1 = foreground)
    visibility *= vertex_alpha

    log(f'projection done, {(visibility > 0.1).sum()}/{len(vertices)} visible verts')

    # ---------------------------------------------------------------
    # Step 2: Rasterize UV atlas using PIL (fast polygon fill)
    # For each face, draw a filled triangle in the UV atlas with
    # the projected color (blended with SF3D based on visibility)
    # ---------------------------------------------------------------
    log('rasterizing UV atlas...')

    # Create projected color atlas and weight atlas
    proj_atlas = Image.new('RGB', (tex_res, tex_res), (0, 0, 0))
    weight_atlas = Image.new('L', (tex_res, tex_res), 0)
    proj_draw = ImageDraw.Draw(proj_atlas)
    weight_draw = ImageDraw.Draw(weight_atlas)

    face_uvs = uv[faces]  # (N, 3, 2)
    face_colors = vertex_colors[faces]  # (N, 3, 3)
    face_vis = visibility[faces]  # (N, 3)

    # Average color and visibility per face
    avg_colors = face_colors.mean(axis=1)  # (N, 3)
    avg_vis = face_vis.mean(axis=1)  # (N,)

    # Pre-compute UV triangle areas and filter degenerate ones
    uv_px = face_uvs * tex_res  # (N, 3, 2) in pixel coords
    uv_areas = 0.5 * np.abs(
        (uv_px[:, 1, 0] - uv_px[:, 0, 0]) * (uv_px[:, 2, 1] - uv_px[:, 0, 1]) -
        (uv_px[:, 2, 0] - uv_px[:, 0, 0]) * (uv_px[:, 1, 1] - uv_px[:, 0, 1])
    )
    # Compute edge lengths to filter very thin triangles
    edges = np.stack([
        np.linalg.norm(uv_px[:, 1] - uv_px[:, 0], axis=1),
        np.linalg.norm(uv_px[:, 2] - uv_px[:, 1], axis=1),
        np.linalg.norm(uv_px[:, 0] - uv_px[:, 2], axis=1),
    ], axis=1)  # (N, 3)
    max_edge = edges.max(axis=1)
    min_edge = edges.min(axis=1)
    # Aspect ratio: skip very thin slivers (max/min > 15)
    aspect_ok = (min_edge > 0.5) & (max_edge / np.clip(min_edge, 0.01, None) < 15)
    # Skip faces that span too much of the UV atlas (cross-island artifacts)
    # Max edge length in UV pixels should be reasonable (< 20% of atlas)
    edge_size_ok = max_edge < (tex_res * 0.2)

    n_drawn = 0
    n_skipped = 0
    for fi in range(len(faces)):
        vis = avg_vis[fi]
        if vis < 0.05:
            continue
        # Skip degenerate UV faces
        if uv_areas[fi] < 1.0 or not aspect_ok[fi] or not edge_size_ok[fi]:
            n_skipped += 1
            continue

        tri = []
        for vi in range(3):
            px = int(face_uvs[fi, vi, 0] * tex_res)
            py = int((1.0 - face_uvs[fi, vi, 1]) * tex_res)
            tri.append((px, py))

        r, g, b = int(avg_colors[fi, 0]), int(avg_colors[fi, 1]), int(avg_colors[fi, 2])
        w = int(min(255, vis * 255))

        proj_draw.polygon(tri, fill=(r, g, b), outline=(r, g, b))
        weight_draw.polygon(tri, fill=w, outline=w)
        n_drawn += 1

    log(f'skipped {n_skipped} degenerate/thin UV faces')

    log(f'drew {n_drawn}/{len(faces)} faces ({100*n_drawn/len(faces):.1f}%)')

    # ---------------------------------------------------------------
    # Step 3: Blend projected atlas with SF3D atlas based on weights
    # ---------------------------------------------------------------
    proj_arr = np.asarray(proj_atlas, dtype=np.float64)
    sf3d_arr = np.asarray(sf3d_tex, dtype=np.float64)
    weight_arr = np.asarray(weight_atlas, dtype=np.float64) / 255.0

    # Expand weight to 3 channels
    w3 = weight_arr[:, :, np.newaxis]
    result_arr = (proj_arr * w3 + sf3d_arr * (1.0 - w3)).astype(np.uint8)
    result_img = Image.fromarray(result_arr)

    log(f'blended, saving...')

    # ---------------------------------------------------------------
    # Step 4: Write texture back into GLB in-place
    # ---------------------------------------------------------------
    import shutil
    shutil.copy(mesh_path, output_path)

    with open(output_path, 'rb') as f:
        data = bytearray(f.read())

    magic = struct.unpack_from('<I', data, 0)[0]
    if magic != 0x46546C67:
        log('ERROR: not GLB'); return False

    offset = 12
    json_chunk = None
    bin_chunk_offset = None
    while offset < len(data):
        chunk_len, chunk_type = struct.unpack_from('<II', data, offset)
        if chunk_type == 0x4E4F534A:
            json_chunk = json.loads(data[offset+8 : offset+8+chunk_len].decode('utf-8'))
        elif chunk_type == 0x004E4942:
            bin_chunk_offset = offset + 8
        offset += 8 + chunk_len

    if json_chunk and bin_chunk_offset:
        images = json_chunk.get('images', [])
        buffer_views = json_chunk.get('bufferViews', [])
        for img_info in images:
            bv_idx = img_info.get('bufferView')
            if bv_idx is None: continue
            bv = buffer_views[bv_idx]
            img_offset = bin_chunk_offset + bv.get('byteOffset', 0)
            img_length = bv['byteLength']

            buf = io.BytesIO()
            result_img.save(buf, format='PNG', optimize=True)
            new_bytes = buf.getvalue()

            if len(new_bytes) <= img_length:
                data[img_offset : img_offset + len(new_bytes)] = new_bytes
                data[img_offset + len(new_bytes) : img_offset + img_length] = b'\x00' * (img_length - len(new_bytes))
                log(f'texture replaced ({len(new_bytes)}/{img_length} bytes)')
            else:
                # Try with JPEG instead (smaller)
                buf2 = io.BytesIO()
                result_img.save(buf2, format='JPEG', quality=92)
                jpg_bytes = buf2.getvalue()
                if len(jpg_bytes) <= img_length:
                    data[img_offset : img_offset + len(jpg_bytes)] = jpg_bytes
                    data[img_offset + len(jpg_bytes) : img_offset + img_length] = b'\x00' * (img_length - len(jpg_bytes))
                    img_info['mimeType'] = 'image/jpeg'
                    # Re-encode JSON
                    json_str = json.dumps(json_chunk).encode('utf-8')
                    log(f'texture replaced as JPEG ({len(jpg_bytes)}/{img_length} bytes)')
                else:
                    log(f'WARNING: texture too large ({len(new_bytes)} > {img_length}), keeping SF3D texture')
            break

        struct.pack_into('<I', data, 8, len(data))
        with open(output_path, 'wb') as f:
            f.write(data)

    # Save debug
    result_img.save(output_path.replace('.glb', '_tex.png'))

    elapsed = time.time() - t0
    log(f'done in {elapsed:.1f}s')
    return True


if __name__ == '__main__':
    if len(sys.argv) < 4:
        print("Usage: python texture_project.py <mesh.glb> <source_image> <output.glb> [resolution]")
        sys.exit(1)
    try:
        ok = project_texture(sys.argv[1], sys.argv[2], sys.argv[3],
                             int(sys.argv[4]) if len(sys.argv) > 4 else 1024)
        sys.exit(0 if ok else 1)
    except Exception as e:
        log(f'ERROR: {type(e).__name__}: {e}')
        import traceback; traceback.print_exc()
        sys.exit(2)
