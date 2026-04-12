"""
FabMesh Local Stable Fast 3D Bridge (Image -> 3D mesh with PBR textures)
=======================================================================

- Model: stabilityai/stable-fast-3d (Stability AI Community License,
  commercial-safe under $1M annual revenue, no geographic restrictions)
- Background removal: rembg u2net (Apache 2.0, commercial-safe)
- Native PBR material output: albedo + metallic/roughness + normal map
- Local texture_baker + uv_unwrapper C++ extensions (built with MSVC,
  CPU-only to avoid nvcc/torch CUDA version mismatch)

Usage:
    python local_sf3d_bridge.py <image_path> <output_glb_path>
        [texture_res] [target_vertex_count] [remesh_option]

Defaults: texture_res=1024, target_vertex_count=-1 (no reduction), remesh=none

Exit code 0 on success, non-zero on error.
"""
import sys
import os
import time
import traceback
from contextlib import nullcontext


def generate_3d(
    image_path,
    output_path,
    texture_resolution=1024,
    target_vertex_count=-1,
    remesh_option='none',
    foreground_ratio=0.85,
    subdivide_levels=0,
):
    """Run Stable Fast 3D on `image_path`, save textured GLB to `output_path`.

    If subdivide_levels > 0, the mesh is post-processed through Blender
    Catmull-Clark subdivision to increase triangle count while preserving
    PBR textures and UVs. Each level ×4 the triangle count.
    """
    print(f"LOCAL_SF3D: image={image_path}", flush=True)
    print(f"LOCAL_SF3D: output={output_path}", flush=True)
    print(f"LOCAL_SF3D: texture_res={texture_resolution} verts={target_vertex_count} remesh={remesh_option} subdivide={subdivide_levels}", flush=True)
    print(f"LOCAL_SF3D_PROGRESS: 5 import_start", flush=True)

    # Path to the cloned SF3D repo (bundled in external/)
    SF3D_DIR = os.path.abspath(os.path.join(
        os.path.dirname(__file__), '..', 'external', 'StableFast3D'
    ))
    if not os.path.isdir(SF3D_DIR):
        print(f"LOCAL_SF3D_ERROR: StableFast3D repo not found at {SF3D_DIR}", flush=True)
        return False
    sys.path.insert(0, SF3D_DIR)

    import torch
    import rembg
    from PIL import Image

    from sf3d.system import SF3D
    from sf3d.utils import get_device, remove_background, resize_foreground

    print(f"LOCAL_SF3D_PROGRESS: 10 preprocess_start", flush=True)

    # Enforce VRAM cap passed by FabMesh main.js (optional)
    if torch.cuda.is_available():
        frac = float(os.environ.get('FABMESH_VRAM_FRACTION', '0.95'))
        if 0.1 <= frac < 1.0:
            try:
                torch.cuda.set_per_process_memory_fraction(frac)
                print(f"LOCAL_SF3D: VRAM hard cap set to {frac*100:.0f}%", flush=True)
            except Exception as e:
                print(f"LOCAL_SF3D: could not set VRAM cap ({e})", flush=True)

    device = get_device()
    if not (torch.cuda.is_available() or torch.backends.mps.is_available()):
        device = "cpu"
    print(f"LOCAL_SF3D: device={device}", flush=True)

    # ------------------------------------------------------------------
    # Preprocess image: rembg (u2net default) + resize to foreground ratio
    # ------------------------------------------------------------------
    rembg_session = rembg.new_session()
    raw = Image.open(image_path).convert('RGBA')
    image = remove_background(raw, rembg_session)
    image = resize_foreground(image, foreground_ratio)
    print(f"LOCAL_SF3D: image preprocessed {image.size}", flush=True)

    # ------------------------------------------------------------------
    # Download + load SF3D weights (~3 GB, one-time, gated on HF)
    # ------------------------------------------------------------------
    print(f"LOCAL_SF3D_PROGRESS: 25 load_pipeline", flush=True)
    t0 = time.time()
    model = SF3D.from_pretrained(
        "stabilityai/stable-fast-3d",
        config_name="config.yaml",
        weight_name="model.safetensors",
    )
    model.to(device)
    model.eval()
    print(f"LOCAL_SF3D: model loaded in {time.time()-t0:.1f}s", flush=True)

    # ------------------------------------------------------------------
    # Clamp parameters to avoid OOM on 16 GB cards.
    # SF3D VRAM scales with (vertex_count × bake_resolution²). Empirically:
    #   1024 tex + 50K verts  → ~6.2 GB peak (safe on 16 GB)
    #   2048 tex + 30K verts  → ~10 GB peak
    #   4096 tex + 10K verts  → ~13 GB peak (tight on 16 GB)
    #   4096 tex + 250K verts → OOM guaranteed on 16 GB
    # We auto-downscale to keep things runnable rather than crashing.
    # ------------------------------------------------------------------
    tex_res = int(texture_resolution)
    vert_count = int(target_vertex_count)
    if torch.cuda.is_available():
        total_gb = torch.cuda.get_device_properties(0).total_memory / 1024**3
    else:
        total_gb = 8  # conservative default
    if vert_count > 0:
        # Apply VRAM-safe clamps based on card size
        if total_gb < 12:
            # 8-10 GB cards: keep it very conservative
            tex_res = min(tex_res, 1024)
            vert_count = min(vert_count, 30000)
        elif total_gb < 20:
            # 12-16 GB cards (RTX 3060-5080): moderate
            if tex_res >= 4096:
                vert_count = min(vert_count, 10000)
                print(f"LOCAL_SF3D: clamped vertex_count to {vert_count} (4096 tex on {total_gb:.0f}GB card)", flush=True)
            elif tex_res >= 2048:
                vert_count = min(vert_count, 50000)
            # else 1024: up to ~100K is fine
        # 20+ GB cards (RTX 3090/4090): no clamp needed
    if tex_res != int(texture_resolution) or vert_count != int(target_vertex_count):
        print(f"LOCAL_SF3D: params clamped for VRAM safety: tex {texture_resolution}→{tex_res}, verts {target_vertex_count}→{vert_count}", flush=True)

    # ------------------------------------------------------------------
    # Run inference
    # ------------------------------------------------------------------
    print(f"LOCAL_SF3D_PROGRESS: 50 inference_start", flush=True)
    t0 = time.time()
    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()
    with torch.no_grad():
        ctx = (
            torch.autocast(device_type=device, dtype=torch.bfloat16)
            if "cuda" in device
            else nullcontext()
        )
        with ctx:
            mesh, glob_dict = model.run_image(
                image,
                bake_resolution=tex_res,
                remesh=remesh_option,
                vertex_count=vert_count,
            )
    elapsed = time.time() - t0
    print(f"LOCAL_SF3D: inference done in {elapsed:.1f}s", flush=True)
    if torch.cuda.is_available():
        peak = torch.cuda.max_memory_allocated() / 1024 / 1024
        print(f"LOCAL_SF3D: peak VRAM {peak:.0f} MB", flush=True)

    # run_image can return a list when batched; we passed a single PIL image
    if isinstance(mesh, list):
        if not mesh:
            print("LOCAL_SF3D_ERROR: empty mesh list from pipeline", flush=True)
            return False
        mesh = mesh[0]

    print(f"LOCAL_SF3D_PROGRESS: 90 export", flush=True)
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    mesh.export(output_path, include_normals=True)
    size = os.path.getsize(output_path)

    # Read back the GLB to count verts/faces for the UI stats display.
    try:
        import trimesh as _tmesh
        _scene = _tmesh.load(output_path)
        _geoms = list(_scene.geometry.values()) if hasattr(_scene, 'geometry') else [_scene]
        _total_verts = sum(len(g.vertices) for g in _geoms)
        _total_faces = sum(len(g.faces) for g in _geoms)
        print(f"LOCAL_SF3D_STATS: verts={_total_verts} faces={_total_faces} tex={tex_res}", flush=True)
    except Exception as _e:
        print(f"LOCAL_SF3D_STATS: verts=? faces=? tex={tex_res} (count failed: {_e})", flush=True)

    # ------------------------------------------------------------------
    # Optional: Blender Catmull-Clark subdivision for Ultra quality.
    # This runs on CPU (no VRAM needed) and preserves UVs + PBR materials.
    # ------------------------------------------------------------------
    if int(subdivide_levels) > 0:
        print(f"LOCAL_SF3D_PROGRESS: 92 subdivide_start", flush=True)
        print(f"LOCAL_SF3D: subdividing ×{subdivide_levels} via Blender...", flush=True)
        import subprocess
        import json
        # Find Blender path from FabMesh config
        blender_exe = None
        try:
            config_path = os.path.join(os.path.dirname(__file__), '..', 'config.json')
            if os.path.exists(config_path):
                with open(config_path) as f:
                    cfg = json.load(f)
                blender_exe = cfg.get('blenderPath', '')
        except Exception:
            pass
        if not blender_exe or not os.path.exists(blender_exe):
            # Try common default paths
            for candidate in [
                r'C:\Program Files\Blender Foundation\Blender 5.1\blender.exe',
                r'C:\Program Files\Blender Foundation\Blender 4.3\blender.exe',
                r'C:\Program Files\Blender Foundation\Blender 4.0\blender.exe',
            ]:
                if os.path.exists(candidate):
                    blender_exe = candidate
                    break
        if blender_exe and os.path.exists(blender_exe):
            subdivide_script = os.path.join(os.path.dirname(__file__), 'blender_subdivide.py')
            raw_glb = output_path + '.raw.glb'
            os.rename(output_path, raw_glb)
            try:
                result = subprocess.run(
                    [blender_exe, '--background', '--python', subdivide_script,
                     '--', raw_glb, output_path, str(subdivide_levels)],
                    capture_output=True, text=True, timeout=300
                )
                print(result.stdout, flush=True)
                if result.returncode != 0 or not os.path.exists(output_path):
                    print(f"LOCAL_SF3D: subdivide failed (code {result.returncode}), using raw mesh", flush=True)
                    if result.stderr:
                        print(f"LOCAL_SF3D: {result.stderr[-500:]}", flush=True)
                    os.rename(raw_glb, output_path)
                else:
                    # Clean up the raw file
                    try: os.remove(raw_glb)
                    except: pass
            except Exception as e:
                print(f"LOCAL_SF3D: subdivide exception ({e}), using raw mesh", flush=True)
                if os.path.exists(raw_glb) and not os.path.exists(output_path):
                    os.rename(raw_glb, output_path)
        else:
            print(f"LOCAL_SF3D: Blender not found, skipping subdivision", flush=True)

    # Re-read final file size after possible subdivision
    size = os.path.getsize(output_path)
    print(f"LOCAL_SF3D_SUCCESS: {output_path} ({size} bytes)", flush=True)
    print(f"LOCAL_SF3D_PROGRESS: 100 done", flush=True)

    # Free GPU
    del model
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return True


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python local_sf3d_bridge.py <image_path> <output_glb_path> [tex_res] [vertex_count] [remesh] [subdivide_levels]")
        sys.exit(1)
    image = sys.argv[1]
    out = sys.argv[2]
    tex_res = int(sys.argv[3]) if len(sys.argv) > 3 else 1024
    vcount = int(sys.argv[4]) if len(sys.argv) > 4 else -1
    remesh = sys.argv[5] if len(sys.argv) > 5 else 'none'
    subdiv = int(sys.argv[6]) if len(sys.argv) > 6 else 0
    try:
        ok = generate_3d(
            image, out,
            texture_resolution=tex_res,
            target_vertex_count=vcount,
            remesh_option=remesh,
            subdivide_levels=subdiv,
        )
        sys.exit(0 if ok else 1)
    except Exception as e:
        print(f"LOCAL_SF3D_ERROR: {type(e).__name__}: {e}", flush=True)
        traceback.print_exc()
        sys.exit(2)
