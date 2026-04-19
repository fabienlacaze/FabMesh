"""
Multi-view texture AUGMENTATION (additive, not replacement).

Goal: improve the back/sides of a SF3D-textured mesh by sampling from
the 6 Zero123++ multi-view images, WITHOUT touching the front-facing
pixels that SF3D textured well. The user's insight: "we should ADD the
multi-view contributions on top of SF3D, not replace it".

Strategy:
  Per atlas pixel (after rasterising each face's UV triangle):
    - front_score = visibility from the front view (matches SF3D's
                    sampling)
    - For each multi-view (90, 180, 270, ...): mv_score = visibility
      from that view * priority_weight
    - If max(mv_score) > front_score + MARGIN, replace the SF3D pixel
      with the colour sampled from the winning multi-view.
    - Else keep SF3D's value (upscaled atlas already loaded).

  This means: front-facing fragments stay SF3D (clean, sharp, what the
  front view already textured well). Back-of-head, side-of-armour,
  underarms etc. get rewritten with multi-view samples since SF3D had
  nothing better than its neural guess for those.

Camera math reuses texture_project.py's elevation-aware Zero123++
schema. Atlas is rebuilt in-place in the GLB.

Usage:
    python texture_augment.py <mesh.glb> <front_image> <output.glb>
                              [--multiview <dir>] [--margin 0.15]
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
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from fabmesh_log import Logger
except Exception:
    Logger = None


# Zero123++ v1.2 schema (verified vs InstantMesh)
MULTIVIEW_VIEWS = [
    (30.0, 20.0),  (90.0, -10.0), (150.0, 20.0),
    (210.0, -10.0), (270.0, 20.0), (330.0, -10.0),
]
PRIORITY_WEIGHTS = {
    0.0: 1.0,
    30.0: 0.6, 330.0: 0.6,
    90.0: 0.9, 270.0: 0.9,
    150.0: 0.8, 210.0: 0.8,
}


def log(msg):
    print(f'[tex_aug] {msg}', flush=True)


def rot_x(deg):
    r = np.radians(deg)
    return np.array([[1, 0, 0], [0, np.cos(r), -np.sin(r)],
                     [0, np.sin(r), np.cos(r)]])


def rot_y(deg):
    r = np.radians(deg)
    return np.array([[np.cos(r), 0, np.sin(r)], [0, 1, 0],
                     [-np.sin(r), 0, np.cos(r)]])


def project_view_to_uv(verts_cam, norms_cam, R_w2c_base, distance, focal,
                      azim_deg, elev_deg):
    """Return (per-vertex u, v normalized 0..1, visibility 0..1)."""
    R_w2c = R_w2c_base @ rot_x(elev_deg) @ rot_y(-azim_deg)
    cam_pos_w = (rot_y(azim_deg) @ rot_x(-elev_deg) @
                 np.array([distance, 0.0, 0.0]))
    t_w2c = -R_w2c @ cam_pos_w

    v_cs = (R_w2c @ verts_cam.T).T + t_w2c
    n_cs = (R_w2c @ norms_cam.T).T
    z = v_cs[:, 2]
    safe_z = np.where(np.abs(z) < 1e-8, -1e-8, z)
    p_u = focal * v_cs[:, 0] / (-safe_z) + 0.5
    p_v = 1.0 - (focal * v_cs[:, 1] / (-safe_z) + 0.5)
    in_b = (p_u >= 0) & (p_u <= 1) & (p_v >= 0) & (p_v <= 1)

    cam_dirs = -v_cs
    cam_dirs_n = cam_dirs / (np.linalg.norm(cam_dirs, axis=1, keepdims=True) + 1e-10)
    norms_n = n_cs / (np.linalg.norm(n_cs, axis=1, keepdims=True) + 1e-10)
    vis = np.clip(np.sum(norms_n * cam_dirs_n, axis=1), 0, 1)
    vis *= in_b.astype(np.float64)
    vis = vis ** 0.8
    return p_u, p_v, vis


def augment(mesh_path, front_image_path, output_path, multiview_dir=None,
            margin=0.15):
    import trimesh

    t0 = time.time()
    slog = Logger('tex_aug',
                  mesh=os.path.basename(mesh_path),
                  multiview=(os.path.basename(multiview_dir) if multiview_dir else None)) \
           if Logger else None
    def _evt(event, **f):
        if slog: slog.info(event, **f)

    log(f'mesh={mesh_path} front={front_image_path} out={output_path}')
    log(f'multiview={multiview_dir} margin={margin}')
    _evt('pipeline_started', front=front_image_path,
         multiview_dir=multiview_dir, margin=margin)

    if not multiview_dir or not os.path.isdir(multiview_dir):
        log('ERROR: multiview dir missing — augmentation needs the 6 views')
        return False

    # ---- Load mesh + existing atlas ----
    scene = trimesh.load(mesh_path)
    geom = list(scene.geometry.values())[0] if hasattr(scene, 'geometry') else scene
    vertices = np.asarray(geom.vertices, dtype=np.float64)
    faces = np.asarray(geom.faces, dtype=np.int32)
    normals = np.asarray(geom.vertex_normals, dtype=np.float64)
    uv = np.asarray(geom.visual.uv, dtype=np.float64)
    log(f'mesh: {len(vertices)} verts, {len(faces)} faces')

    sf3d_tex = geom.visual.material.baseColorTexture
    if sf3d_tex is None:
        log('ERROR: mesh has no baseColorTexture to augment')
        return False
    sf3d_img = sf3d_tex.convert('RGB')
    tex_res = sf3d_img.size[0]
    sf3d_arr = np.asarray(sf3d_img, dtype=np.uint8)
    log(f'SF3D atlas: {sf3d_img.size}')
    _evt('atlas_loaded', tex_res=tex_res)

    # ---- Undo SF3D's post-rotation so verts are in its internal frame ----
    R_undo = rot_x(90) @ rot_y(-90)
    verts_cam = (R_undo @ vertices.T).T
    norms_cam = -((R_undo @ normals.T).T)  # SF3D inverts winding

    fov_deg, distance = 40.0, 1.6
    focal = 0.5 / np.tan(0.5 * np.radians(fov_deg))
    R_w2c_base = np.array([[0, 1, 0], [0, 0, 1], [1, 0, 0]], dtype=np.float64)

    # ---- Per-vertex front visibility (used as the baseline score SF3D had) ----
    _, _, front_vis = project_view_to_uv(verts_cam, norms_cam, R_w2c_base,
                                         distance, focal, 0.0, 0.0)

    # ---- Multi-view source images + per-vertex uv/vis cache ----
    # Prefer views.json schema if present (e.g. fabmesh_2view: front+back).
    views_json = os.path.join(multiview_dir, 'views.json')
    view_schema = MULTIVIEW_VIEWS
    if os.path.exists(views_json):
        try:
            with open(views_json, 'r') as _f:
                _vj = json.load(_f)
            view_schema = [(v['azim'], v['elev']) for v in _vj.get('views', [])]
            log(f'using views.json schema: {view_schema}')
        except Exception as _e:
            log(f'views.json parse failed ({_e}), falling back to Z123')
    view_data = []
    for i, (azim, elev) in enumerate(view_schema):
        vp = os.path.join(multiview_dir, f'view_{i}.png')
        if not os.path.exists(vp):
            log(f'WARNING: missing {vp}, skipping')
            continue
        img = Image.open(vp).convert('RGBA')
        sw, sh = img.size
        sp = np.asarray(img)
        p_u, p_v, vis = project_view_to_uv(verts_cam, norms_cam, R_w2c_base,
                                           distance, focal, azim, elev)
        # Down-weight by alpha at the projected pixel
        ix = np.clip((p_u * sw).astype(int), 0, sw - 1)
        iy = np.clip((p_v * sh).astype(int), 0, sh - 1)
        alpha = sp[iy, ix, 3].astype(np.float64) / 255.0
        vis = vis * alpha
        score = vis * PRIORITY_WEIGHTS.get(azim, 0.4)
        view_data.append({
            'pixels': sp, 'w': sw, 'h': sh,
            'p_u': p_u, 'p_v': p_v, 'score': score,
            'azim': azim, 'elev': elev,
        })

    log(f'loaded {len(view_data)} multi-view(s)')
    _evt('views_loaded', count=len(view_data))

    # ---- UV atlas filters (avoid degenerate triangles) ----
    face_uvs = uv[faces]  # (F, 3, 2)
    uv_px = face_uvs * tex_res
    edges = np.stack([
        np.linalg.norm(uv_px[:, 1] - uv_px[:, 0], axis=1),
        np.linalg.norm(uv_px[:, 2] - uv_px[:, 1], axis=1),
        np.linalg.norm(uv_px[:, 0] - uv_px[:, 2], axis=1),
    ], axis=1)
    max_edge = edges.max(axis=1)
    min_edge = edges.min(axis=1)
    aspect_ok = (min_edge > 0.1) & (max_edge / np.clip(min_edge, 0.01, None) < 50)
    edge_size_ok = max_edge < (tex_res * 0.2)

    # ---- Rasterize: for each face, write multi-view colour ONLY where
    # a view's score beats the front by >= margin. ----
    out_arr = sf3d_arr.copy().astype(np.float64)
    n_overwritten = 0
    n_partial = 0
    n_skipped = 0
    n_drawn = 0

    for fi in range(len(faces)):
        if not aspect_ok[fi] or not edge_size_ok[fi]:
            n_skipped += 1
            continue
        v_idx = faces[fi]

        # Average front score for this face
        f_front = front_vis[v_idx].mean()

        # Hard guard: if SF3D saw this face well from the front, NEVER
        # touch it. The user noted that the previous augment was
        # degrading the front because slightly-better multi-views were
        # still being blended in. Front is the ground-truth source —
        # respect it where it had a clean view.
        FRONT_PROTECT = 0.45  # face well-lit from front -> SF3D wins
        if f_front >= FRONT_PROTECT:
            continue

        # UV triangle in atlas pixel coords
        x0 = uv_px[fi, 0, 0]; y0 = (1.0 - uv[faces[fi, 0], 1]) * tex_res
        x1 = uv_px[fi, 1, 0]; y1 = (1.0 - uv[faces[fi, 1], 1]) * tex_res
        x2 = uv_px[fi, 2, 0]; y2 = (1.0 - uv[faces[fi, 2], 1]) * tex_res

        min_x = max(0, int(min(x0, x1, x2)))
        max_x = min(tex_res - 1, int(max(x0, x1, x2)) + 1)
        min_y = max(0, int(min(y0, y1, y2)))
        max_y = min(tex_res - 1, int(max(y0, y1, y2)) + 1)
        if max_x <= min_x or max_y <= min_y:
            continue

        denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(denom) < 1e-10:
            continue
        inv_denom = 1.0 / denom

        ys, xs = np.mgrid[min_y:max_y + 1, min_x:max_x + 1]
        xsf = xs.astype(np.float64) + 0.5
        ysf = ys.astype(np.float64) + 0.5
        w0 = ((y1 - y2) * (xsf - x2) + (x2 - x1) * (ysf - y2)) * inv_denom
        w1 = ((y2 - y0) * (xsf - x2) + (x0 - x2) * (ysf - y2)) * inv_denom
        w2 = 1.0 - w0 - w1
        mask = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not mask.any():
            continue
        n_drawn += 1

        # Pick the multi-view with the highest score for this face
        best_score = -1.0
        best_color = None
        for vd in view_data:
            mv_score_face = vd['score'][v_idx].mean()
            if mv_score_face <= best_score:
                continue
            tri_u = vd['p_u'][v_idx]
            tri_v = vd['p_v'][v_idx]
            su = w0 * tri_u[0] + w1 * tri_u[1] + w2 * tri_u[2]
            sv = w0 * tri_v[0] + w1 * tri_v[1] + w2 * tri_v[2]
            sx = np.clip((su * vd['w']).astype(int), 0, vd['w'] - 1)
            sy = np.clip((sv * vd['h']).astype(int), 0, vd['h'] - 1)
            sampled = vd['pixels'][sy, sx, :3].astype(np.float64)
            best_score = mv_score_face
            best_color = sampled

        if best_color is None:
            continue

        # advantage = how much better the multi-view sees this face
        # vs the front. Negative means front is better (skip entirely).
        advantage = best_score - f_front
        if advantage <= 0:
            continue

        # Soft blend factor in [0, 1]: 0 when advantage <= margin (no
        # change), saturates to 1 when advantage is well above margin.
        # Smoothstep-like ramp avoids the abrupt patchwork seams the
        # previous version produced.
        SOFT_RANGE = max(margin, 0.05)
        t = np.clip((advantage - margin) / SOFT_RANGE, 0.0, 1.0)
        if t <= 0.0:
            continue

        # PHOTOMETRIC MATCH: shift the multi-view sample's mean colour
        # towards the SF3D mean colour for this triangle. Zero123++
        # views have inconsistent lighting between each other and vs
        # the SF3D bake, which produced the blotchy yellow/black
        # patches in the v1 augment. We compute the per-channel mean
        # offset across the triangle's mask and apply it to the
        # multi-view sample so its overall tone matches SF3D's, while
        # keeping the multi-view's local texture variations intact.
        sf_local = out_arr[ys, xs]              # (H, W, 3) original
        diff_means = (sf_local[mask].mean(axis=0)
                      - best_color[mask].mean(axis=0))  # 3-vec
        matched = best_color + diff_means       # (H, W, 3)
        matched = np.clip(matched, 0, 255)

        # Apply soft blend only where mask is true
        write_mask = mask.astype(np.float64)[..., np.newaxis] * t
        out_arr[ys, xs] = (write_mask * matched + (1.0 - write_mask) * sf_local)

        if t >= 0.99:
            n_overwritten += 1
        else:
            n_partial += 1

    out_arr = np.clip(out_arr, 0, 255).astype(np.uint8)

    log(f'faces drawn={n_drawn} overwritten={n_overwritten} '
        f'partial-blend={n_partial} '
        f'(SF3D kept on {n_drawn - n_overwritten - n_partial}) '
        f'skipped={n_skipped}')
    _evt('rasterize_done', drawn=n_drawn, overwritten=n_overwritten,
         partial=n_partial, skipped=n_skipped, total_faces=int(len(faces)))

    # ---- Write augmented atlas back into the GLB ----
    out_img = Image.fromarray(out_arr)

    # Re-pack atlas into GLB binary chunk (in-place texture swap)
    import shutil
    if os.path.abspath(mesh_path) != os.path.abspath(output_path):
        shutil.copy(mesh_path, output_path)

    with open(output_path, 'rb') as f:
        data = bytearray(f.read())
    if struct.unpack_from('<I', data, 0)[0] != 0x46546C67:
        log('ERROR: not a GLB')
        return False

    offset = 12
    json_chunk = None
    bin_chunk_offset = 0
    while offset < len(data):
        chunk_len, chunk_type = struct.unpack_from('<II', data, offset)
        if chunk_type == 0x4E4F534A:
            json_chunk = json.loads(data[offset+8: offset+8+chunk_len].decode('utf-8'))
        elif chunk_type == 0x004E4942:
            bin_chunk_offset = offset + 8
        offset += 8 + chunk_len

    images = (json_chunk or {}).get('images', []) or []
    buffer_views = (json_chunk or {}).get('bufferViews', []) or []
    if not images or not bin_chunk_offset:
        log('ERROR: GLB has no images or no BIN chunk')
        return False

    # Encode JPEG and try to fit in slot, else rebuild full GLB
    img_info = images[0]
    bv = buffer_views[img_info['bufferView']]
    img_offset = bin_chunk_offset + bv.get('byteOffset', 0)
    img_length = bv['byteLength']

    buf = io.BytesIO()
    out_img.save(buf, format='JPEG', quality=92)
    new_bytes = buf.getvalue()
    img_info['mimeType'] = 'image/jpeg'

    if len(new_bytes) <= img_length:
        data[img_offset: img_offset + len(new_bytes)] = new_bytes
        data[img_offset + len(new_bytes): img_offset + img_length] = b'\x00' * (img_length - len(new_bytes))
        with open(output_path, 'wb') as f:
            f.write(data)
        log(f'texture replaced in-place ({len(new_bytes)}/{img_length} bytes)')
    else:
        # Rebuild minimal: append the new image at end of BIN, patch bv.
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
        with open(output_path, 'wb') as f:
            f.write(out)
        log(f'GLB rebuilt with new texture (+{len(new_bytes) - img_length} bytes)')

    sz = os.path.getsize(output_path)
    log(f'done in {time.time()-t0:.1f}s, output {sz} bytes')
    _evt('pipeline_done', bytes=sz, ms=int((time.time() - t0) * 1000))
    return True


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('mesh')
    p.add_argument('front_image')
    p.add_argument('output')
    p.add_argument('--multiview', default=None, required=True)
    p.add_argument('--margin', type=float, default=0.3,
                   help='Min visibility advantage a multi-view needs over '
                        'the front before its colour starts blending in '
                        '(0=always overwrite, 1=never). Default 0.3 = '
                        'only zones meaningfully invisible from front.')
    args = p.parse_args()
    try:
        ok = augment(args.mesh, args.front_image, args.output,
                     multiview_dir=args.multiview, margin=args.margin)
        sys.exit(0 if ok else 1)
    except Exception as e:
        import traceback
        traceback.print_exc()
        log(f'ERROR: {type(e).__name__}: {e}')
        sys.exit(2)
