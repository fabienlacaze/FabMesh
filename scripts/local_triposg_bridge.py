"""
FabMesh Local TripoSG Bridge (Image -> 3D mesh)
===============================================

- Model: VAST-AI/TripoSG (MIT license, commercial OK)
- Background removal: rembg u2net (Apache 2.0, commercial OK)
- Mesh extraction: mcubes fallback (BSD, commercial OK) since `diso` cannot
  build against torch+cu128 on Windows with only nvcc 13.2 available.

Usage:
    python local_triposg_bridge.py <image_path> <output_glb_path> [num_inference_steps] [guidance_scale]

Exit code 0 on success, non-zero on error.
"""
import sys
import os
import time
import traceback


def generate_3d(image_path, output_path, num_inference_steps=30, guidance_scale=7.0, seed=42):
    """Run TripoSG on `image_path`, save textured-less mesh to `output_path`.

    Returns True on success.
    """
    print(f"LOCAL_TRIPOSG: image={image_path}", flush=True)
    print(f"LOCAL_TRIPOSG: output={output_path}", flush=True)
    print(f"LOCAL_TRIPOSG_PROGRESS: 5 import_start", flush=True)

    # Path to the cloned TripoSG repo (bundled in external/)
    TRIPOSG_DIR = os.path.abspath(os.path.join(
        os.path.dirname(__file__), '..', 'external', 'TripoSG'
    ))
    if not os.path.isdir(TRIPOSG_DIR):
        print(f"LOCAL_TRIPOSG_ERROR: TripoSG repo not found at {TRIPOSG_DIR}", flush=True)
        return False
    sys.path.insert(0, TRIPOSG_DIR)

    import numpy as np
    import torch
    import trimesh
    from PIL import Image
    from huggingface_hub import snapshot_download

    # Import after path insertion
    from triposg.pipelines.pipeline_triposg import TripoSGPipeline

    print(f"LOCAL_TRIPOSG_PROGRESS: 10 preprocess_start", flush=True)

    # Enforce VRAM cap passed by FabMesh main.js (optional)
    if torch.cuda.is_available():
        frac = float(os.environ.get('FABMESH_VRAM_FRACTION', '0.95'))
        if 0.1 <= frac < 1.0:
            try:
                torch.cuda.set_per_process_memory_fraction(frac)
                print(f"LOCAL_TRIPOSG: VRAM hard cap set to {frac*100:.0f}%", flush=True)
            except Exception as e:
                print(f"LOCAL_TRIPOSG: could not set VRAM cap ({e})", flush=True)

    # ------------------------------------------------------------------
    # Background removal via rembg u2net (Apache 2.0, commercial-safe).
    # TripoSG's official pipeline uses briaai/RMBG-1.4 which is non-commercial.
    # ------------------------------------------------------------------
    try:
        import rembg
        pil_raw = Image.open(image_path)
        has_alpha = (pil_raw.mode == 'RGBA' and np.asarray(pil_raw)[:, :, 3].min() < 255)
        if has_alpha:
            pil_rgba = pil_raw.convert('RGBA')
            print("LOCAL_TRIPOSG: input already has alpha, skipping rembg", flush=True)
        else:
            session = rembg.new_session('u2net')
            pil_rgba = rembg.remove(pil_raw.convert('RGBA'), session=session)
            print("LOCAL_TRIPOSG: rembg u2net OK", flush=True)
        # TripoSG expects a white-background RGB image, tight crop around subject.
        arr = np.asarray(pil_rgba).astype(np.float32) / 255.0
        alpha = arr[:, :, 3:4]
        rgb = arr[:, :, :3] * alpha + (1.0 - alpha) * 1.0  # white bg
        # Tight crop around the alpha footprint with 5% padding
        nz = (arr[:, :, 3] > 0.1)
        if nz.any():
            ys, xs = np.where(nz)
            y0, y1 = ys.min(), ys.max()
            x0, x1 = xs.min(), xs.max()
            h, w = y1 - y0, x1 - x0
            py = int(h * 0.05)
            px = int(w * 0.05)
            y0 = max(0, y0 - py); y1 = min(arr.shape[0], y1 + py)
            x0 = max(0, x0 - px); x1 = min(arr.shape[1], x1 + px)
            rgb = rgb[y0:y1, x0:x1]
        # Resize to square 512 (TripoSG's expected input resolution)
        img_in = Image.fromarray((rgb * 255.0).clip(0, 255).astype(np.uint8))
        s = max(img_in.size)
        square = Image.new('RGB', (s, s), (255, 255, 255))
        square.paste(img_in, ((s - img_in.width) // 2, (s - img_in.height) // 2))
        img_in = square.resize((512, 512), Image.LANCZOS)
        print(f"LOCAL_TRIPOSG: image preprocessed {img_in.size}", flush=True)
    except Exception as e:
        print(f"LOCAL_TRIPOSG: preprocessing failed ({e}), using raw RGB", flush=True)
        traceback.print_exc()
        img_in = Image.open(image_path).convert('RGB').resize((512, 512), Image.LANCZOS)

    # ------------------------------------------------------------------
    # Download + load TripoSG weights (~4.5 GB, one-time)
    # ------------------------------------------------------------------
    print(f"LOCAL_TRIPOSG_PROGRESS: 20 download_start", flush=True)
    triposg_weights_dir = os.path.join(TRIPOSG_DIR, 'pretrained_weights', 'TripoSG')
    if not os.path.isdir(triposg_weights_dir) or not os.listdir(triposg_weights_dir):
        print("LOCAL_TRIPOSG: Downloading VAST-AI/TripoSG weights (one-time, ~4.5 GB)...", flush=True)
        snapshot_download(repo_id="VAST-AI/TripoSG", local_dir=triposg_weights_dir)
    else:
        print("LOCAL_TRIPOSG: weights already cached", flush=True)

    print(f"LOCAL_TRIPOSG_PROGRESS: 35 load_pipeline", flush=True)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    pipe = TripoSGPipeline.from_pretrained(triposg_weights_dir).to(device, dtype)
    print(f"LOCAL_TRIPOSG: pipeline on {device} ({dtype})", flush=True)

    # ------------------------------------------------------------------
    # Run inference
    # ------------------------------------------------------------------
    print(f"LOCAL_TRIPOSG_PROGRESS: 50 inference_start", flush=True)
    t0 = time.time()
    with torch.no_grad():
        outputs = pipe(
            image=img_in,
            generator=torch.Generator(device=device).manual_seed(int(seed)),
            num_inference_steps=int(num_inference_steps),
            guidance_scale=float(guidance_scale),
        ).samples[0]
    elapsed = time.time() - t0
    print(f"LOCAL_TRIPOSG: inference done in {elapsed:.1f}s", flush=True)
    print(f"LOCAL_TRIPOSG_PROGRESS: 90 extract_mesh", flush=True)

    verts = outputs[0]
    faces = outputs[1]
    if verts is None or faces is None:
        print("LOCAL_TRIPOSG_ERROR: empty mesh from pipeline", flush=True)
        return False
    mesh = trimesh.Trimesh(verts.astype(np.float32), np.ascontiguousarray(faces))

    # ------------------------------------------------------------------
    # Orientation: TripoSG actually outputs Y-up natively (verified
    # empirically: bbox extents = X~0.93, Y~1.91 [head-to-feet], Z~0.78).
    # No rotation needed. Applying any 90° rotation here puts the mesh
    # on its side in Three.js.
    # ------------------------------------------------------------------
    print(f"LOCAL_TRIPOSG: mesh bbox={mesh.bounding_box.extents} (Y-up, no rotation)", flush=True)

    # Force vertex normals + default neutral PBR material. The mesh exported
    # here is GEOMETRY ONLY — it has no UVs and no texture. A second stage
    # (scripts/triposg_texture.py) unwraps UVs, renders multi-view, runs
    # img2img against the source image, and bakes a GLB with the texture.
    try:
        _ = mesh.vertex_normals
        import trimesh.visual.material as _mat
        mesh.visual.material = _mat.PBRMaterial(
            name='triposg_geometry',
            baseColorFactor=[220, 220, 220, 255],
            metallicFactor=0.0,
            roughnessFactor=0.9,
            alphaMode='OPAQUE',
            doubleSided=True,
        )
    except Exception as e:
        print(f"LOCAL_TRIPOSG: material post-process failed ({e})", flush=True)

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    mesh.export(output_path)
    size = os.path.getsize(output_path)
    print(f"LOCAL_TRIPOSG_SUCCESS: {output_path} ({size} bytes, {len(mesh.vertices)} verts, {len(mesh.faces)} faces)", flush=True)
    print(f"LOCAL_TRIPOSG_PROGRESS: 100 done", flush=True)

    # Free GPU
    del pipe
    torch.cuda.empty_cache()
    return True


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python local_triposg_bridge.py <image_path> <output_glb_path> [steps] [guidance]")
        sys.exit(1)
    image = sys.argv[1]
    out = sys.argv[2]
    steps = int(sys.argv[3]) if len(sys.argv) > 3 else 30
    guid = float(sys.argv[4]) if len(sys.argv) > 4 else 7.0
    try:
        ok = generate_3d(image, out, num_inference_steps=steps, guidance_scale=guid)
        sys.exit(0 if ok else 1)
    except Exception as e:
        print(f"LOCAL_TRIPOSG_ERROR: {type(e).__name__}: {e}", flush=True)
        traceback.print_exc()
        sys.exit(2)
