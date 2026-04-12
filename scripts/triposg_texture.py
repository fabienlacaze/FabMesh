"""
FabMesh TripoSG Texture Baker (V1 — orthographic source projection)
===================================================================

Takes a raw TripoSG geometry mesh (no UV, no texture) and produces a
UV-mapped textured GLB by projecting the source image onto the mesh
from a front-facing orthographic camera. Back-facing texels fall back
to a neutral gray with a smooth blend at the silhouette.

Pipeline:
    1. Decimate mesh to ~30k verts (pymeshlab quadric edge collapse)
    2. xatlas UV unwrap
    3. Rasterize position atlas (moderngl) so each texel knows its 3D point
    4. Orthographic project each texel through +Z camera onto source image
    5. Compute front-facing weight via finite-diff normals * cam direction
    6. Blend projection / neutral gray by front weight
    7. Dilate to fill UV padding (cv2.inpaint)
    8. Export GLB with UV + embedded baseColorTexture

V2 TODO: add multi-view SDXL img2img pass to fill the back half with
plausible (not gray) colors.

Usage:
    python triposg_texture.py <geometry_glb> <source_image> <output_glb>
        [--target-faces 30000] [--tex-res 1024]

License: MIT (FabMesh). Dependencies: trimesh, pymeshlab, xatlas,
moderngl, numpy, cv2, PIL. All commercial-safe.
"""
import os
import sys
import time
import argparse
import traceback
import numpy as np
import trimesh
import trimesh.visual as _vis
import trimesh.visual.material as _mat
from PIL import Image


def log(msg):
    print(f'[triposg_texture] {msg}', flush=True)


def decimate_mesh(mesh, target_faces):
    """Reduce mesh face count via pymeshlab quadric edge collapse."""
    import pymeshlab
    log(f'decimating {len(mesh.faces)} -> {target_faces} faces')
    ms = pymeshlab.MeshSet()
    pm = pymeshlab.Mesh(
        vertex_matrix=np.asarray(mesh.vertices, dtype=np.float64),
        face_matrix=np.asarray(mesh.faces, dtype=np.int32),
    )
    ms.add_mesh(pm)
    # Merge close verts first to clean up marching-cubes output
    ms.meshing_merge_close_vertices()
    ms.meshing_decimation_quadric_edge_collapse(
        targetfacenum=target_faces,
        preservenormal=True,
        preserveboundary=True,
        preservetopology=True,
    )
    out = ms.current_mesh()
    v = np.asarray(out.vertex_matrix(), dtype=np.float32)
    f = np.asarray(out.face_matrix(), dtype=np.int32)
    log(f'decimated to {len(v)} verts, {len(f)} faces')
    return trimesh.Trimesh(vertices=v, faces=f, process=False)


def uv_unwrap(mesh):
    """Generate UV atlas with xatlas. Returns (vmapping, indices, uvs)."""
    import xatlas
    log('xatlas UV unwrap...')
    t0 = time.time()
    atlas = xatlas.Atlas()
    atlas.add_mesh(
        np.asarray(mesh.vertices, dtype=np.float32),
        np.asarray(mesh.faces, dtype=np.uint32),
    )
    opts = xatlas.PackOptions()
    opts.resolution = 1024
    opts.padding = 8
    opts.bilinear = True
    atlas.generate(pack_options=opts)
    vmapping, indices, uvs = atlas[0]
    log(f'xatlas done in {time.time()-t0:.1f}s : '
        f'{len(vmapping)} new verts, {len(indices)} tris')
    return vmapping, indices, uvs


def rasterize_position_atlas(mesh, vmapping, indices, uvs, texture_res, padding):
    """For each texel in an (texture_res, texture_res, 4) atlas, compute
    the world-space 3D position of the surface it covers. Texels outside
    any chart have alpha=0.
    """
    import moderngl
    log(f'rasterize position atlas {texture_res}x{texture_res}...')
    ctx = moderngl.create_standalone_context()
    prog = ctx.program(
        vertex_shader='''
            #version 330
            in vec2 in_uv;
            in vec3 in_pos;
            out vec3 v_pos;
            void main() {
                v_pos = in_pos;
                gl_Position = vec4(in_uv * 2.0 - 1.0, 0.0, 1.0);
            }
        ''',
        fragment_shader='''
            #version 330
            in vec3 v_pos;
            out vec4 o_col;
            void main() { o_col = vec4(v_pos, 1.0); }
        ''',
    )
    # Remap mesh verts to UV topology
    new_verts = np.asarray(mesh.vertices, dtype=np.float32)[vmapping]
    uv_f32 = np.asarray(uvs, dtype=np.float32)
    idx_i32 = np.asarray(indices, dtype=np.uint32)

    vbo_pos = ctx.buffer(new_verts.tobytes())
    vbo_uv = ctx.buffer(uv_f32.tobytes())
    ibo = ctx.buffer(idx_i32.tobytes())
    vao = ctx.vertex_array(
        prog,
        [(vbo_pos, '3f', 'in_pos'), (vbo_uv, '2f', 'in_uv')],
        index_buffer=ibo,
        index_element_size=4,
    )
    fbo = ctx.framebuffer(
        color_attachments=[ctx.texture((texture_res, texture_res), 4, dtype='f4')]
    )
    fbo.use()
    ctx.clear(0.0, 0.0, 0.0, 0.0)
    vao.render()
    data = fbo.read(components=4, dtype='f4')
    pos = np.frombuffer(data, dtype='f4').reshape(texture_res, texture_res, 4)

    # Cleanup
    vao.release(); vbo_pos.release(); vbo_uv.release()
    ibo.release(); fbo.release(); prog.release(); ctx.release()
    return pos, new_verts, idx_i32


def build_texture_atlas(pos_tex, mesh, src_img_rgb, texture_res):
    """Project the source image onto every texel via orthographic front
    camera. Returns an (H, W, 3) uint8 atlas.
    """
    import cv2
    log('building texture atlas...')
    H_src, W_src, _ = src_img_rgb.shape
    xyz = pos_tex[..., :3]
    valid = pos_tex[..., 3] > 0.5

    # Normalize mesh bbox to [-1, 1] cube so projection is scale-agnostic
    v = np.asarray(mesh.vertices, dtype=np.float32)
    bb_min = v.min(axis=0)
    bb_max = v.max(axis=0)
    center = 0.5 * (bb_min + bb_max)
    half = 0.5 * (bb_max - bb_min).max() * 1.05
    xyz_n = (xyz - center) / half

    x = xyz_n[..., 0]
    y = xyz_n[..., 1]
    z = xyz_n[..., 2]

    # Orthographic projection from +Z (looking -Z, Y-up):
    #   u = (x + 1) / 2 * (W - 1)
    #   v = (1 - y) / 2 * (H - 1)
    u_pix = np.clip((x + 1.0) * 0.5, 0.0, 1.0) * (W_src - 1)
    v_pix = np.clip((1.0 - y) * 0.5, 0.0, 1.0) * (H_src - 1)
    u_i = u_pix.astype(np.int32)
    v_i = v_pix.astype(np.int32)

    # Sample source image
    src_f = src_img_rgb.astype(np.float32) / 255.0
    projected = src_f[v_i, u_i]  # (H, W, 3)

    # Front-facing weight: surface normal vs camera (+Z).
    # Estimate normals from finite diffs on xyz atlas (noisy at chart
    # boundaries but averaged over a smooth atlas it's OK).
    dx = np.zeros_like(xyz)
    dy = np.zeros_like(xyz)
    dx[:, 1:-1, :] = (xyz[:, 2:, :] - xyz[:, :-2, :]) * 0.5
    dy[1:-1, :, :] = (xyz[2:, :, :] - xyz[:-2, :, :]) * 0.5
    normal = np.cross(dx, dy)
    nlen = np.linalg.norm(normal, axis=-1, keepdims=True)
    normal = normal / np.where(nlen > 1e-6, nlen, 1.0)
    # Use |n . +Z| (sign-ignoring to tolerate flipped chart normals).
    n_dot_z = np.abs(normal[..., 2])

    # front mask: z > 0 in normalized space AND |n.z| > 0.15
    is_front = (z > -0.02) & (n_dot_z > 0.15) & valid
    weight = np.clip((n_dot_z - 0.15) / 0.5, 0.0, 1.0)
    weight = weight * is_front.astype(np.float32)

    # Neutral mid-gray for back & grazing texels
    gray = np.full_like(projected, 0.5)
    rgb = projected * weight[..., None] + gray * (1.0 - weight[..., None])

    # Fill outside-chart texels with gray so inpainting doesn't start
    # from black and pollute.
    rgb[~valid] = 0.5

    # cv2 inpaint to smoothly dilate chart colors into the padding ring.
    rgb_u8 = (rgb.clip(0, 1) * 255.0).astype(np.uint8)
    mask_inv = (~valid).astype(np.uint8) * 255
    try:
        rgb_bgr = cv2.cvtColor(rgb_u8, cv2.COLOR_RGB2BGR)
        inpainted = cv2.inpaint(rgb_bgr, mask_inv, 15, cv2.INPAINT_TELEA)
        rgb_u8 = cv2.cvtColor(inpainted, cv2.COLOR_BGR2RGB)
        log('TELEA inpaint applied to padding region')
    except Exception as e:
        log(f'inpaint failed ({e}), using raw atlas')

    # Flip vertically — xatlas UVs use bottom-left origin but moderngl
    # fbo.read() returns top-down.
    rgb_u8 = np.flip(rgb_u8, axis=0)
    return rgb_u8


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('geometry_glb')
    parser.add_argument('source_image')
    parser.add_argument('output_glb')
    parser.add_argument('--target-faces', type=int, default=30000)
    parser.add_argument('--tex-res', type=int, default=1024)
    args = parser.parse_args()

    log(f'geometry : {args.geometry_glb}')
    log(f'source   : {args.source_image}')
    log(f'output   : {args.output_glb}')

    t_total = time.time()

    log('loading geometry...')
    mesh_in = trimesh.load(args.geometry_glb, force='mesh', process=False)
    log(f'loaded {len(mesh_in.vertices)} verts, {len(mesh_in.faces)} faces')

    # Decimate to manageable size
    mesh_dec = decimate_mesh(mesh_in, args.target_faces)

    # UV unwrap
    vmapping, indices, uvs = uv_unwrap(mesh_dec)

    # Rasterize position atlas
    pad = max(2, args.tex_res // 256)
    pos_tex, new_verts, idx_i32 = rasterize_position_atlas(
        mesh_dec, vmapping, indices, uvs, args.tex_res, pad
    )
    log(f'atlas filled texels: {(pos_tex[..., 3] > 0.5).sum()} / {pos_tex[..., 3].size}')

    # Preprocess source image: rembg on white background
    log('loading source image...')
    try:
        import rembg
        src_pil = Image.open(args.source_image)
        has_alpha = (src_pil.mode == 'RGBA' and np.asarray(src_pil)[..., 3].min() < 255)
        if not has_alpha:
            session = rembg.new_session('u2net')
            src_pil = rembg.remove(src_pil.convert('RGBA'), session=session)
            log('rembg u2net OK')
        arr = np.asarray(src_pil).astype(np.float32) / 255.0
        alpha = arr[:, :, 3:4]
        rgb = arr[:, :, :3] * alpha + (1.0 - alpha) * 1.0  # white bg
        # Tight crop around subject
        mask = arr[:, :, 3] > 0.1
        if mask.any():
            ys, xs = np.where(mask)
            y0, y1 = ys.min(), ys.max()
            x0, x1 = xs.min(), xs.max()
            py = int((y1 - y0) * 0.05)
            px = int((x1 - x0) * 0.05)
            y0 = max(0, y0 - py); y1 = min(arr.shape[0], y1 + py)
            x0 = max(0, x0 - px); x1 = min(arr.shape[1], x1 + px)
            rgb = rgb[y0:y1, x0:x1]
        # Pad to square
        src_img = Image.fromarray((rgb * 255).clip(0, 255).astype(np.uint8))
        s = max(src_img.size)
        square = Image.new('RGB', (s, s), (255, 255, 255))
        square.paste(src_img, ((s - src_img.width) // 2, (s - src_img.height) // 2))
        src_img = square.resize((1024, 1024), Image.LANCZOS)
    except Exception as e:
        log(f'preprocess failed ({e}), using raw RGB')
        src_img = Image.open(args.source_image).convert('RGB').resize((1024, 1024), Image.LANCZOS)
    src_np = np.asarray(src_img, dtype=np.uint8)

    # Build texture atlas
    tex_atlas = build_texture_atlas(pos_tex, mesh_dec, src_np, args.tex_res)

    # Build output mesh with UV + texture
    log('assembling output GLB...')
    tex_pil = Image.fromarray(tex_atlas, mode='RGB')
    material = _mat.PBRMaterial(
        name='triposg_baked',
        baseColorTexture=tex_pil,
        metallicFactor=0.0,
        roughnessFactor=0.9,
        alphaMode='OPAQUE',
        doubleSided=True,
    )
    uv_visual = _vis.TextureVisuals(uv=np.asarray(uvs, dtype=np.float32), material=material)
    out_mesh = trimesh.Trimesh(
        vertices=new_verts,
        faces=np.asarray(indices, dtype=np.int32),
        visual=uv_visual,
        process=False,
    )
    _ = out_mesh.vertex_normals

    os.makedirs(os.path.dirname(os.path.abspath(args.output_glb)), exist_ok=True)
    out_mesh.export(args.output_glb)
    size = os.path.getsize(args.output_glb)
    log(f'wrote {args.output_glb} ({size} bytes, {len(new_verts)} verts, {len(indices)} tris)')
    log(f'total time: {time.time()-t_total:.1f}s')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as e:
        print(f'[triposg_texture] ERROR: {type(e).__name__}: {e}')
        traceback.print_exc()
        sys.exit(1)
