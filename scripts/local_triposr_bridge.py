"""
FabMesh Local TripoSR Bridge
Runs TripoSR locally on your GPU - no internet needed after first download.
Usage: python local_triposr_bridge.py <image_path> <output_glb_path> [resolution]
"""
import sys
import os
import time

TRIPOSR_DIR = os.path.join(os.path.dirname(__file__), '..', 'TripoSR')
sys.path.insert(0, TRIPOSR_DIR)

def generate_3d(image_path, output_path, resolution=512):
    import torch
    from PIL import Image
    from tsr.system import TSR

    # Enforce VRAM cap from FabMesh settings
    if torch.cuda.is_available():
        _frac = float(os.environ.get('FABMESH_VRAM_FRACTION', '0.95'))
        if 0.1 <= _frac < 1.0:
            try:
                torch.cuda.set_per_process_memory_fraction(_frac)
                print(f"LOCAL_TRIPOSR: VRAM hard cap set to {_frac*100:.0f}%", flush=True)
            except Exception as e:
                print(f"LOCAL_TRIPOSR: Could not set VRAM cap ({e})", flush=True)

    # Enforce system RAM limit from FabMesh settings
    _ram_limit_mb = os.environ.get('FABMESH_RAM_LIMIT_MB', '')
    if _ram_limit_mb:
        try:
            import psutil, gc
            _vm = psutil.virtual_memory()
            print(f"LOCAL_TRIPOSR: RAM system used={(_vm.total - _vm.available) / (1024**2):.0f}MB, "
                  f"limit={_ram_limit_mb}MB, percent={_vm.percent:.0f}%", flush=True)
            if (_vm.total - _vm.available) / (1024**2) > int(_ram_limit_mb) * 0.9:
                gc.collect()
                print("LOCAL_TRIPOSR: RAM near limit, ran gc.collect()", flush=True)
        except ImportError:
            print("LOCAL_TRIPOSR: psutil not installed, RAM monitoring skipped", flush=True)
        except Exception as e:
            print(f"LOCAL_TRIPOSR: RAM check error: {e}", flush=True)

    print("LOCAL_TRIPOSR: Loading model...")
    sys.stdout.flush()

    model = TSR.from_pretrained(
        'stabilityai/TripoSR',
        config_name='config.yaml',
        weight_name='model.ckpt'
    )
    model.to('cuda')
    # Chunk the NeRF renderer query. 32768 is ~4x faster than 8192 at the
    # cost of ~4-5 GB peak VRAM, which still leaves headroom on a 16 GB card.
    try:
        model.renderer.set_chunk_size(32768)
        print("LOCAL_TRIPOSR: renderer chunk_size=32768 (fast)", flush=True)
    except Exception as _e:
        print(f"LOCAL_TRIPOSR: could not set chunk_size ({_e}), proceeding unchunked", flush=True)

    print("LOCAL_TRIPOSR: Processing image (TripoSR official pipeline)...", flush=True)
    # Use TripoSR's OFFICIAL preprocessing (matches TripoSR/run.py lines 140-147).
    # Three critical steps missed by the old pipeline:
    #   1. remove_background(): rembg with TripoSR's specific session
    #   2. resize_foreground(): crop the subject, pad to square, then pad to
    #      add margin so the subject only occupies ~85% of the final image.
    #      Without this, the subject touches the image edges and TripoSR
    #      reconstructs a flat "pancake" instead of a volumetric object.
    #   3. alpha composite onto GRAY (0.5), not white.
    try:
        import numpy as _np
        import rembg as _rembg
        from tsr.utils import remove_background, resize_foreground
        rembg_session = _rembg.new_session()
        img_pil = Image.open(image_path)
        img_rgba = remove_background(img_pil, rembg_session)
        img_rgba = resize_foreground(img_rgba, 0.85)  # TripoSR default
        arr = _np.array(img_rgba).astype(_np.float32) / 255.0
        # Composite onto 0.5 gray, exactly like TripoSR run.py
        comp = arr[:, :, :3] * arr[:, :, 3:4] + (1.0 - arr[:, :, 3:4]) * 0.5
        image = Image.fromarray((comp * 255.0).astype(_np.uint8))
        print("LOCAL_TRIPOSR: preprocessed (rembg + resize_foreground 0.85 + gray composite)", flush=True)
    except Exception as e:
        print(f"LOCAL_TRIPOSR: preprocessing failed ({e}), using raw RGB", flush=True)
        image = Image.open(image_path).convert('RGB')

    print("LOCAL_TRIPOSR_PROGRESS: 10 forward_start", flush=True)
    start = time.time()
    with torch.no_grad():
        scene_codes = model([image], device='cuda')
    gen_time = time.time() - start
    print(f"LOCAL_TRIPOSR: 3D generated in {gen_time:.1f}s", flush=True)
    print("LOCAL_TRIPOSR_PROGRESS: 25 extract_mesh_start", flush=True)

    print("LOCAL_TRIPOSR: Extracting mesh (no vertex colors, will bake UV texture)...", flush=True)
    # Use has_vertex_color=False because we'll run TripoSR's OFFICIAL
    # bake_texture() pipeline next. This is exactly what TripoSR/run.py
    # does when called with --bake-texture, and it is the only
    # reliable path. All our previous custom hybrid experiments produced
    # garbled results — sticking to the upstream reference.
    meshes = model.extract_mesh(scene_codes, has_vertex_color=False, resolution=resolution)
    mesh = meshes[0]

    # ------------------------------------------------------------------
    # OFFICIAL TripoSR bake_texture() — reference implementation
    # ------------------------------------------------------------------
    texture_image_rgba = None
    uvs_baked = None
    vmapping_baked = None
    indices_baked = None
    try:
        import numpy as _np_bk
        import torch as _torch_bk
        from tsr import bake_texture as _bt_mod_bk
        # Upstream positions_to_colors forgets to move its positions tensor
        # to the model device — patch it here before calling bake_texture().
        def _ptc_cuda(_m, sc, pt, res):
            dev = next(_m.parameters()).device
            p = _torch_bk.tensor(pt.reshape(-1, 4)[:, :-1], device=dev, dtype=_torch_bk.float32)
            with _torch_bk.no_grad():
                q = _m.renderer.query_triplane(_m.decoder, p, sc)
            rgb = q['color'].detach().cpu().numpy().reshape(-1, 3)
            rgba = _np_bk.insert(rgb, 3, pt.reshape(-1, 4)[:, -1], axis=1)
            rgba[rgba[:, -1] == 0.0] = [0, 0, 0, 0]
            return rgba.reshape(res, res, 4)
        _bt_mod_bk.positions_to_colors = _ptc_cuda
        from tsr.bake_texture import bake_texture

        TEX_RES = 1024
        print("LOCAL_TRIPOSR_PROGRESS: 40 bake_start", flush=True)
        bake_out = bake_texture(mesh, model, scene_codes[0], TEX_RES)
        print("LOCAL_TRIPOSR_PROGRESS: 85 bake_done", flush=True)

        # bake_texture returns RGBA float [0,1] in (H, W, 4).
        # Follow TripoSR/run.py's exact post-processing: flip top-bottom
        # before saving to PNG, which is the convention needed by GLB.
        tex = bake_out["colors"]
        tex = _np_bk.flip(tex, axis=0)       # run.py does Image.FLIP_TOP_BOTTOM
        tex_u8 = (tex * 255.0).clip(0, 255).astype(_np_bk.uint8)
        # Drop alpha (GLB baseColorTexture uses RGB)
        if tex_u8.shape[-1] == 4:
            tex_u8 = tex_u8[..., :3]
        texture_image_rgba = tex_u8
        uvs_baked      = bake_out["uvs"]
        vmapping_baked = bake_out["vmapping"]
        indices_baked  = bake_out["indices"]
        print(
            f"LOCAL_TRIPOSR: official bake_texture OK "
            f"({tex_u8.shape[1]}x{tex_u8.shape[0]}, {len(vmapping_baked)} verts)",
            flush=True,
        )
    except Exception as _be:
        import traceback as _tb_bk
        _tb_bk.print_exc()
        print(f"LOCAL_TRIPOSR: bake_texture failed ({_be}), falling back to vertex colors", flush=True)
        texture_image_rgba = None
        # Re-extract with vertex colors so the mesh still has something
        del meshes, mesh
        meshes = model.extract_mesh(scene_codes, has_vertex_color=True, resolution=resolution)
        mesh = meshes[0]
    # TripoSR outputs the mesh in its canonical frame where X is the long
    # axis (head-to-feet for a character). GLB/Blender/Three.js expect
    # Y-up, so rotate +90° around Z to map X -> Y.
    try:
        import numpy as _np_rot
        import trimesh as _tm_rot
        R = _tm_rot.transformations.rotation_matrix(_np_rot.pi / 2, [0, 0, 1])
        mesh.apply_transform(R)
        print("LOCAL_TRIPOSR: rotated +90 around Z (X-up -> Y-up)", flush=True)
    except Exception as _e:
        print(f"LOCAL_TRIPOSR: rotation failed ({_e})", flush=True)

    # Post-process the mesh for proper rendering in Three.js / Blender:
    #   1. Compute vertex normals (missing -> flat/transparent rendering)
    #   2. Rebuild mesh with UV atlas + baked texture (preferred) OR with
    #      opaque vertex colors as fallback
    #   3. Assign an OPAQUE double-sided PBR material
    try:
        import numpy as _np_pp
        import trimesh as _tm_pp
        import trimesh.visual as _vis_pp
        import trimesh.visual.material as _mat
        from PIL import Image as _PIL_Image

        if texture_image_rgba is not None and uvs_baked is not None:
            # --- UV texture path (hybrid atlas) ---
            new_verts = _np_pp.asarray(mesh.vertices)[vmapping_baked]
            new_faces = _np_pp.asarray(indices_baked)
            # texture_image_rgba here is an RGB uint8 (H, W, 3) produced by
            # the hybrid NeRF+projection block above.
            if texture_image_rgba.ndim == 3 and texture_image_rgba.shape[2] == 4:
                tex_pil = _PIL_Image.fromarray(texture_image_rgba, mode='RGBA').convert('RGB')
            else:
                tex_pil = _PIL_Image.fromarray(texture_image_rgba, mode='RGB')
            tex_material = _mat.PBRMaterial(
                name='fabmesh_hybrid',
                baseColorTexture=tex_pil,
                metallicFactor=0.0,
                roughnessFactor=0.9,
                alphaMode='OPAQUE',
                doubleSided=True,
            )
            uv_visual = _vis_pp.TextureVisuals(uv=uvs_baked, material=tex_material)
            mesh_out = _tm_pp.Trimesh(
                vertices=new_verts,
                faces=new_faces,
                visual=uv_visual,
                process=False,
            )
            # Force normal computation so GLB ships with NORMAL attribute
            _ = mesh_out.vertex_normals
            print(f"LOCAL_TRIPOSR: built UV-mapped mesh ({len(new_verts)} verts, {len(new_faces)} faces) with baked texture", flush=True)
            mesh_out.export(output_path)
        else:
            # --- Vertex color path (always taken now) ---
            try:
                mesh.fix_normals()
            except Exception:
                pass
            _ = mesh.vertex_normals
            # Contrast stretch + saturation boost the NeRF-baked vertex
            # colors so the mesh doesn't look washed-out grey. TripoSR
            # typically puts all channels in [100..200] range (mean ~160),
            # so a 2–98 percentile stretch expands to full dynamic range.
            try:
                if hasattr(mesh.visual, 'vertex_colors') and mesh.visual.vertex_colors is not None:
                    vc = _np_pp.asarray(mesh.visual.vertex_colors).astype(_np_pp.float32)
                    if vc.ndim == 2 and vc.shape[1] == 4:
                        # Alpha to fully opaque
                        vc[:, 3] = 255.0
                        rgb = vc[:, :3] / 255.0
                        # Per-channel percentile stretch
                        for ch in range(3):
                            lo = _np_pp.percentile(rgb[:, ch], 2.0)
                            hi = _np_pp.percentile(rgb[:, ch], 98.0)
                            if hi - lo > 1e-4:
                                rgb[:, ch] = _np_pp.clip((rgb[:, ch] - lo) / (hi - lo), 0.0, 1.0)
                        # Saturation boost (mix with grayscale)
                        gray = rgb.mean(axis=1, keepdims=True)
                        sat = 1.4
                        rgb = _np_pp.clip(gray + (rgb - gray) * sat, 0.0, 1.0)
                        vc[:, :3] = (rgb * 255.0).clip(0, 255)
                        mesh.visual.vertex_colors = vc.astype(_np_pp.uint8)
                        print("LOCAL_TRIPOSR: vertex color contrast stretch + saturation applied", flush=True)
            except Exception as _cs:
                print(f"LOCAL_TRIPOSR: color boost failed ({_cs})", flush=True)
            mesh.visual.material = _mat.PBRMaterial(
                name='triposr_vertex_color',
                metallicFactor=0.0,
                roughnessFactor=0.9,
                alphaMode='OPAQUE',
                doubleSided=True,
            )
            print("LOCAL_TRIPOSR: exported vertex-colored mesh (OPAQUE, boosted)", flush=True)
            print("LOCAL_TRIPOSR_PROGRESS: 95 exporting", flush=True)
            mesh.export(output_path)
    except Exception as _e:
        import traceback
        traceback.print_exc()
        print(f"LOCAL_TRIPOSR: post-process err ({_e}), exporting raw mesh", flush=True)
        mesh.export(output_path)

    # Free GPU and RAM
    del model, scene_codes, meshes, mesh
    torch.cuda.empty_cache()
    import gc
    gc.collect()
    torch.cuda.empty_cache()

    size = os.path.getsize(output_path)
    print(f"LOCAL_TRIPOSR_SUCCESS: {output_path} ({size} bytes)")
    sys.stdout.flush()
    return True

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python local_triposr_bridge.py <image_path> <output_glb_path> [resolution]")
        sys.exit(1)

    image_path = sys.argv[1]
    output_path = sys.argv[2]
    resolution = int(sys.argv[3]) if len(sys.argv) > 3 else 256

    success = generate_3d(image_path, output_path, resolution)
    sys.exit(0 if success else 1)
