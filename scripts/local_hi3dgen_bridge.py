"""
FabMesh Local Hi3DGen Bridge (Image -> 3D mesh, direct, no multi-view).

- Model: Stable-X/Hi3DGen (MIT, ByteDance + CUHK, ICCV 2025)
- Workflow: image -> normal map (StableNormal) -> 3D mesh (TRELLIS fork)
- Bypasses the multi-view 2D diffusion bottleneck of Zero123++ which
  hallucinates on complex subjects (insects, fine appendages).

Usage:
    python local_hi3dgen_bridge.py <image_path> <output_glb_path> [tex_res=1024]
"""
import sys
import os
import time
import traceback


# Hi3DGen lives in external/Hi3DGen and expects weights/ relative to its
# cwd. We chdir there once Python starts so snapshot_download paths line up.
HI3DGEN_DIR = os.path.abspath(os.path.join(
    os.path.dirname(__file__), '..', 'external', 'Hi3DGen'
))
WEIGHTS_DIR = os.path.join(HI3DGEN_DIR, 'weights')


def _ensure_weights():
    """Download the 3 model checkpoints into external/Hi3DGen/weights/."""
    from huggingface_hub import snapshot_download
    os.makedirs(WEIGHTS_DIR, exist_ok=True)
    model_ids = [
        "Stable-X/trellis-normal-v0-1",
        "Stable-X/yoso-normal-v1-8-1",
        "ZhengPeng7/BiRefNet",
    ]
    for model_id in model_ids:
        local_path = os.path.join(WEIGHTS_DIR, model_id.split("/")[-1])
        if os.path.exists(local_path) and os.listdir(local_path):
            print(f"LOCAL_HI3DGEN: cached {model_id}", flush=True)
            continue
        print(f"LOCAL_HI3DGEN: downloading {model_id} ...", flush=True)
        snapshot_download(
            repo_id=model_id,
            local_dir=local_path,
            force_download=False,
        )
        print(f"LOCAL_HI3DGEN: downloaded {model_id}", flush=True)


def generate_3d(image_path, output_path):
    """Run Hi3DGen on `image_path`, save textured-less mesh to `output_path`."""
    # Convert to absolute paths BEFORE chdir into Hi3DGen dir (we chdir below
    # so relative paths from the caller would no longer resolve).
    image_path = os.path.abspath(image_path)
    output_path = os.path.abspath(output_path)
    print(f"LOCAL_HI3DGEN: image={image_path}", flush=True)
    print(f"LOCAL_HI3DGEN: output={output_path}", flush=True)
    print(f"LOCAL_HI3DGEN_PROGRESS: 5 import_start", flush=True)

    # spconv backend env BEFORE any spconv import (mirrors Hi3DGen app.py)
    os.environ['SPCONV_ALGO'] = 'native'
    # PyTorch CUDA alloc — large allocations during sparse structure flow
    os.environ.setdefault('PYTORCH_CUDA_ALLOC_CONF', 'expandable_segments:True')
    # 2026-05-30 — Switched from flash_attn to sdpa (Blackwell-correct path).
    # Windows SAC blocks flash_attn_2_cuda.dll on this machine and user
    # explicitly prohibited disabling SAC. TRELLIS-2 sparse module DOES
    # support sdpa (modules/sparse/attention/full_attn.py:214-254 implements
    # the fp32-math SDPA branch for sm_120 Blackwell). flash_attn is being
    # uninstalled from the trellis2 venv to make this unambiguous.
    os.environ['ATTN_BACKEND'] = 'sdpa'
    os.environ['SPARSE_ATTN_BACKEND'] = 'sdpa'

    if not os.path.isdir(HI3DGEN_DIR):
        print(f"LOCAL_HI3DGEN_ERROR: Hi3DGen repo not found at {HI3DGEN_DIR}", flush=True)
        return False
    sys.path.insert(0, HI3DGEN_DIR)
    # Working dir must be the repo root so torch.hub local cache + weights/ work
    _orig_cwd = os.getcwd()
    os.chdir(HI3DGEN_DIR)

    try:
        import torch
        from PIL import Image
        import trimesh
        from hi3dgen.pipelines import Hi3DGenPipeline

        print(f"LOCAL_HI3DGEN_PROGRESS: 10 fetch_weights", flush=True)
        _ensure_weights()

        # VRAM cap (FabMesh slider) — same pattern as SF3D/TripoSG bridges.
        if torch.cuda.is_available():
            frac = float(os.environ.get('FABMESH_VRAM_FRACTION', '0.95'))
            if 0.1 <= frac < 1.0:
                try:
                    torch.cuda.set_per_process_memory_fraction(frac)
                except Exception:
                    pass

        print(f"LOCAL_HI3DGEN_PROGRESS: 20 load_pipeline", flush=True)
        pipeline = Hi3DGenPipeline.from_pretrained(
            os.path.join(WEIGHTS_DIR, 'trellis-normal-v0-1')
        )
        pipeline.cuda()

        print(f"LOCAL_HI3DGEN_PROGRESS: 35 load_normal_predictor", flush=True)
        try:
            normal_predictor = torch.hub.load(
                "hugoycj/StableNormal", "StableNormal_turbo",
                trust_repo=True, yoso_version='yoso-normal-v1-8-1',
                local_cache_dir=WEIGHTS_DIR,
            )
        except Exception as e:
            print(f"LOCAL_HI3DGEN_ERROR: StableNormal load failed: {e}", flush=True)
            traceback.print_exc()
            return False

        print(f"LOCAL_HI3DGEN_PROGRESS: 50 preprocess_image", flush=True)
        image = Image.open(image_path)
        image = pipeline.preprocess_image(image, resolution=1024)

        print(f"LOCAL_HI3DGEN_PROGRESS: 60 normal_estimation", flush=True)
        normal_image = normal_predictor(
            image, resolution=768, match_input_resolution=True, data_type='object'
        )

        print(f"LOCAL_HI3DGEN_PROGRESS: 70 mesh_inference", flush=True)
        t0 = time.time()
        outputs = pipeline.run(
            normal_image,
            seed=42,
            formats=["mesh"],
            preprocess_image=False,
            sparse_structure_sampler_params={"steps": 50, "cfg_strength": 3},
            slat_sampler_params={"steps": 6, "cfg_strength": 3},
        )
        print(f"LOCAL_HI3DGEN: inference done in {time.time()-t0:.1f}s", flush=True)

        # When wrapped by hi3dgen_full_pipeline.py, cap progress at 50
        # so the parent can emit higher markers for UV unwrap + texture
        # bake steps without the bar getting stuck at 99% early.
        _wrapped = os.environ.get('FABMESH_HI3DGEN_WRAPPED') == '1'
        _final_pct = 50 if _wrapped else 100
        print(f"LOCAL_HI3DGEN_PROGRESS: {min(45, _final_pct)} export", flush=True)
        mesh = outputs['mesh'][0].to_trimesh(transform_pose=True)
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        mesh.export(output_path)
        size = os.path.getsize(output_path)
        print(
            f"LOCAL_HI3DGEN_SUCCESS: {output_path} ({size} bytes, "
            f"{len(mesh.vertices)} verts, {len(mesh.faces)} faces)",
            flush=True,
        )
        print(f"LOCAL_HI3DGEN_PROGRESS: {_final_pct} done", flush=True)

        del pipeline, normal_predictor
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        return True
    finally:
        os.chdir(_orig_cwd)


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python local_hi3dgen_bridge.py <image_path> <output_glb_path>")
        sys.exit(1)
    image = sys.argv[1]
    out = sys.argv[2]
    try:
        ok = generate_3d(image, out)
        sys.exit(0 if ok else 1)
    except Exception as e:
        print(f"LOCAL_HI3DGEN_ERROR: {type(e).__name__}: {e}", flush=True)
        traceback.print_exc()
        sys.exit(2)
