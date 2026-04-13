"""
FabMesh Texture Projection — re-project source photo onto 3D mesh UV atlas.
===========================================================================

Improves SF3D's blurry baked textures by projecting the original high-res
source photo back onto the mesh using SF3D's EXACT perspective camera
(fov=40 deg, distance=1.6) so front-facing geometry gets sharp textures.

Strategy:
  1. Undo SF3D's post-generation rotation (Rx(-90) * Ry(90) * invert)
     to recover the original camera-space coordinates
  2. For each vertex: perspective-project 3D position using SF3D's camera
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
    # Step 1: Undo SF3D's post-generation transforms
    #
    # SF3D applies these AFTER mesh generation (system.py lines 518-528):
    #   1. Rx(-90): rotate -90 deg around X
    #   2. Ry(+90): rotate +90 deg around Y
    #   3. invert(): flip face winding (normals flip)
    #
    # To go from exported GLB coords back to SF3D's internal coords
    # (where the camera was), we must apply the INVERSE in reverse order:
    #   1. un-invert (flip normals back — we handle this via normal sign)
    #   2. Ry(-90)^-1 = Ry(-90)
    #   3. Rx(-90)^-1 = Rx(+90)
    # ---------------------------------------------------------------
    def rot_x(deg):
        r = np.radians(deg)
        return np.array([
            [1, 0, 0],
            [0, np.cos(r), -np.sin(r)],
            [0, np.sin(r),  np.cos(r)]
        ])

    def rot_y(deg):
        r = np.radians(deg)
        return np.array([
            [ np.cos(r), 0, np.sin(r)],
            [ 0,         1, 0        ],
            [-np.sin(r), 0, np.cos(r)]
        ])

    # Inverse of: Rx(-90) then Ry(+90) = undo Ry(+90) then undo Rx(-90)
    R_undo = rot_x(90) @ rot_y(-90)
    verts_cam = (R_undo @ vertices.T).T  # (V, 3) in SF3D's internal coords
    norms_cam = (R_undo @ normals.T).T
    # The invert() call flips normals; undo that
    norms_cam = -norms_cam

    # ---------------------------------------------------------------
    # Step 2: Perspective projection using SF3D's exact camera
    #
    # SF3D camera (system.py / utils.py):
    #   default_fovy_deg = 40.0
    #   default_distance = 1.6
    #   c2w = [[0,0,1,d], [1,0,0,0], [0,1,0,0], [0,0,0,1]]
    #
    # This c2w means: camera position = (d, 0, 0) in world coords
    # (the 4th column after the axis swap), camera Z axis = world X.
    #
    # The c2w columns map camera axes to world axes:
    #   cam_X -> world_Z   (c2w col 0 = [0,0,1])... wait, let's be precise.
    #   Row 0: [0,0,1,d] means world_X = cam_Z * 1 + d
    #   Row 1: [1,0,0,0] means world_Y = cam_X * 1
    #   Row 2: [0,1,0,0] means world_Z = cam_Y * 1
    #
    # Actually c2w maps camera coords to world:
    #   world = R_c2w * cam + t_c2w
    #   R_c2w = [[0,0,1],[1,0,0],[0,1,0]], t_c2w = [d,0,0]
    #
    # So w2c (world to camera) = inv(c2w):
    #   R_w2c = R_c2w^T = [[0,1,0],[0,0,1],[1,0,0]]
    #   t_w2c = -R_w2c * t_c2w = -[[0,1,0],[0,0,1],[1,0,0]] * [d,0,0]
    #         = [0, 0, -d]
    #
    # So in camera coords: cam = R_w2c * world + [0, 0, -d]
    #   cam_x = world_y
    #   cam_y = world_z
    #   cam_z = world_x - d
    # ---------------------------------------------------------------
    fov_deg = 40.0
    distance = 1.6

    # World-to-camera transform
    # R_w2c = R_c2w^T where R_c2w = [[0,0,1],[1,0,0],[0,1,0]]
    R_w2c = np.array([
        [0, 1, 0],
        [0, 0, 1],
        [1, 0, 0]
    ], dtype=np.float64)
    t_w2c = np.array([0, 0, -distance], dtype=np.float64)

    # Transform vertices to camera space
    verts_cs = (R_w2c @ verts_cam.T).T + t_w2c  # (V, 3)
    norms_cs = (R_w2c @ norms_cam.T).T

    # Camera looks along +Z in camera space (OpenGL convention: -Z, but
    # SF3D uses +Z based on the c2w setup where cam_z = world_x and the
    # object is at origin, camera at distance along world_x)
    # verts_cs[:, 2] should be negative for points in front of camera
    # (camera at z=0, object at z=-distance + world_x)
    # Actually: cam_z = world_x - d. Object is near origin, so cam_z ~ -d < 0
    # This means the camera looks along -Z (standard OpenCV/OpenGL convention)

    # Perspective projection
    # Focal length from SF3D: focal = 0.5 * H / tan(0.5 * fov)
    # We project to normalized image coords [0, 1]
    fov_rad = np.radians(fov_deg)
    # Use unit image size for normalized coords
    focal = 0.5 / np.tan(0.5 * fov_rad)

    # Project: u = focal * x / (-z) + 0.5,  v = focal * y / (-z) + 0.5
    # (negate z because camera looks along -Z)
    z = verts_cs[:, 2]
    safe_z = np.where(np.abs(z) < 1e-8, -1e-8, z)
    proj_u = focal * verts_cs[:, 0] / (-safe_z) + 0.5
    proj_v = focal * verts_cs[:, 1] / (-safe_z) + 0.5
    # Flip V because image Y goes top-to-bottom
    proj_v = 1.0 - proj_v

    # Check which vertices project within image bounds
    in_bounds = (proj_u >= 0) & (proj_u <= 1) & (proj_v >= 0) & (proj_v <= 1)

    # Sample source image for each vertex
    ix = np.clip((proj_u * src_w).astype(int), 0, src_w - 1)
    iy = np.clip((proj_v * src_h).astype(int), 0, src_h - 1)
    vertex_colors = src_pixels[iy, ix, :3].astype(np.float64)  # (V, 3) RGB
    vertex_alpha = src_pixels[iy, ix, 3].astype(np.float64) / 255.0  # alpha from rembg

    # Visibility: front-facing check in camera space
    # Camera direction for each vertex (from vertex toward camera origin)
    cam_dirs = -verts_cs.copy()  # direction from vertex to camera (at origin in cam space... no, camera IS the origin)
    # Actually in camera space, camera is at origin. Direction from vertex to camera = -vertex_pos
    cam_dirs = -verts_cs
    cam_dirs_norm = cam_dirs / (np.linalg.norm(cam_dirs, axis=1, keepdims=True) + 1e-10)
    # Normalize surface normals in camera space
    norms_cs_norm = norms_cs / (np.linalg.norm(norms_cs, axis=1, keepdims=True) + 1e-10)
    # Dot product: positive = facing camera
    visibility = np.sum(norms_cs_norm * cam_dirs_norm, axis=1)
    visibility = np.clip(visibility, 0, 1)

    # Combine with alpha and bounds check
    visibility *= vertex_alpha
    visibility *= in_bounds.astype(np.float64)

    # Power curve to sharpen the visibility falloff (reduce blending at edges)
    visibility = visibility ** 1.5

    log(f'projection done, {(visibility > 0.1).sum()}/{len(vertices)} visible verts '
        f'(in_bounds: {in_bounds.sum()}, z_range: {z.min():.2f} to {z.max():.2f})')

    # Debug: save projection overlay to visually verify alignment
    try:
        debug_img = src_img.copy().convert('RGB')
        debug_draw = ImageDraw.Draw(debug_img)
        vis_mask = visibility > 0.1
        for vi in range(0, len(vertices), max(1, len(vertices) // 2000)):
            if not vis_mask[vi]:
                continue
            px = int(proj_u[vi] * src_w)
            py = int(proj_v[vi] * src_h)
            if 0 <= px < src_w and 0 <= py < src_h:
                v = min(255, int(visibility[vi] * 255))
                debug_draw.ellipse([px-1, py-1, px+1, py+1], fill=(v, 255-v, 0))
        debug_path = output_path.replace('.glb', '_proj_debug.png')
        debug_img.save(debug_path)
        log(f'debug overlay saved: {debug_path}')
    except Exception as _dbg_e:
        log(f'debug overlay failed: {_dbg_e}')

    # ---------------------------------------------------------------
    # Step 3: Rasterize UV atlas using PIL
    # For each face, draw a filled triangle in the UV atlas with
    # the projected color (blended with SF3D based on visibility)
    # ---------------------------------------------------------------
    log('rasterizing UV atlas...')

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
    uv_px = face_uvs * tex_res
    uv_areas = 0.5 * np.abs(
        (uv_px[:, 1, 0] - uv_px[:, 0, 0]) * (uv_px[:, 2, 1] - uv_px[:, 0, 1]) -
        (uv_px[:, 2, 0] - uv_px[:, 0, 0]) * (uv_px[:, 1, 1] - uv_px[:, 0, 1])
    )
    edges = np.stack([
        np.linalg.norm(uv_px[:, 1] - uv_px[:, 0], axis=1),
        np.linalg.norm(uv_px[:, 2] - uv_px[:, 1], axis=1),
        np.linalg.norm(uv_px[:, 0] - uv_px[:, 2], axis=1),
    ], axis=1)
    max_edge = edges.max(axis=1)
    min_edge = edges.min(axis=1)
    aspect_ok = (min_edge > 0.5) & (max_edge / np.clip(min_edge, 0.01, None) < 15)
    edge_size_ok = max_edge < (tex_res * 0.2)

    n_drawn = 0
    n_skipped = 0
    for fi in range(len(faces)):
        vis = avg_vis[fi]
        if vis < 0.05:
            continue
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
    # Step 4: Blend projected atlas with SF3D atlas based on weights
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
    # Step 5: Write texture back into GLB in-place
    # ---------------------------------------------------------------
    import shutil
    if os.path.abspath(mesh_path) != os.path.abspath(output_path):
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

            # Try JPEG first (smaller, good quality)
            buf = io.BytesIO()
            result_img.save(buf, format='JPEG', quality=95)
            new_bytes = buf.getvalue()
            new_mime = 'image/jpeg'

            if len(new_bytes) > img_length:
                buf2 = io.BytesIO()
                result_img.save(buf2, format='JPEG', quality=85)
                new_bytes = buf2.getvalue()

            if len(new_bytes) <= img_length:
                data[img_offset : img_offset + len(new_bytes)] = new_bytes
                data[img_offset + len(new_bytes) : img_offset + img_length] = b'\x00' * (img_length - len(new_bytes))
                img_info['mimeType'] = new_mime
                log(f'texture replaced in-place ({len(new_bytes)}/{img_length} bytes)')
            else:
                old_bin_len = struct.unpack_from('<I', data, bin_chunk_offset - 8)[0]
                new_tex_offset = old_bin_len
                pad = (4 - (len(new_bytes) % 4)) % 4
                new_bin = bytes(data[bin_chunk_offset : bin_chunk_offset + old_bin_len]) + new_bytes + b'\x00' * pad
                bv['byteOffset'] = new_tex_offset
                bv['byteLength'] = len(new_bytes)
                img_info['mimeType'] = new_mime
                json_str = json.dumps(json_chunk).encode('utf-8')
                json_pad = (4 - (len(json_str) % 4)) % 4
                json_chunk_data = json_str + b' ' * json_pad
                data = bytearray()
                data += struct.pack('<III', 0x46546C67, 2, 0)
                data += struct.pack('<II', len(json_chunk_data), 0x4E4F534A)
                data += json_chunk_data
                data += struct.pack('<II', len(new_bin), 0x004E4942)
                data += new_bin
                struct.pack_into('<I', data, 8, len(data))
                log(f'texture replaced (GLB rebuilt, +{len(new_bytes)-img_length} bytes)')
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
