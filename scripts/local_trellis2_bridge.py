"""
FabMesh Local TRELLIS 2 Bridge.
Runs inside WSL Ubuntu where the TRELLIS.2 repo + venv live.

Follows the OFFICIAL `example.py` pattern from Microsoft:
  pipeline.cuda()
  mesh = pipeline.run(image)[0]
  o_voxel.postprocess.to_glb(...)

Earlier attempts tried `pipe.low_vram + model.half()` which produced empty
sparse structures at the shape-SLat stage (coords tensor empty -> max()
crash). The official path is simpler and works out of the box with ~14 GB
VRAM peak on an RTX 5080.

Usage: python local_trellis2_bridge.py <image_path> <output_glb_path>
"""
import sys
import os
import subprocess


def generate_3d(image_path, output_path):
    def to_wsl(p):
        p = os.path.abspath(p).replace('\\', '/')
        if p[1] == ':':
            return '/mnt/' + p[0].lower() + p[2:]
        return p

    wsl_image = to_wsl(image_path)
    wsl_output = to_wsl(output_path)

    # We write the runner script to disk so stack traces reference real
    # file lines, then execute it inside the WSL venv.
    script_content = f'''import os
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
import sys, time, traceback
sys.path.insert(0, ".")

# CRITICAL: Apply Blackwell (RTX 5070/5080/5090) fix BEFORE importing
# trellis2 / o_voxel. Sets ATTN_BACKEND=sdpa, SPARSE_CONV_BACKEND=spconv,
# patches torch.cuda.get_device_capability to return (9, 0) so spconv
# / cumm / flex_gemm select sm_90 PTX which JIT-compiles on sm_120.
# Without this, sparse_structure_decoder produces empty coords -> max() crash.
# Source: visualbruno/ComfyUI-Trellis2 (MIT)
import blackwell_fix
blackwell_fix.patch_all(verbose=True)

# Patch CuMesh.fill_holes() — CUDA error 209 "no kernel image" on
# Blackwell (sm_120). It's a cosmetic step (closes mesh boundaries),
# safe to skip — the mesh is still usable, just may have small holes.
import trellis2.representations.mesh.base as _t2_base
def _noop_fill_holes(self, max_hole_perimeter=3e-2):
    print("[blackwell_fix] Mesh.fill_holes() skipped (CuMesh broken on sm_120)", flush=True)
_t2_base.Mesh.fill_holes = _noop_fill_holes

import torch
# Disable TF32 — extra safety on top of the Blackwell patch.
torch.backends.cuda.matmul.allow_tf32 = False
torch.backends.cudnn.allow_tf32 = False
torch.backends.cudnn.deterministic = True
# Extra safety: some PyTorch 2.x paths use the new precision API which
# overrides allow_tf32. Force highest precision globally.
try:
    torch.set_float32_matmul_precision("highest")
except Exception:
    pass
# Disable cuDNN entirely for conv3d to bypass any sm_120 cuDNN bug.
torch.backends.cudnn.enabled = False
import numpy as np
from PIL import Image

print("TRELLIS2: Loading pipeline...", flush=True)
from trellis2.pipelines import Trellis2ImageTo3DPipeline
import o_voxel

pipeline = Trellis2ImageTo3DPipeline.from_pretrained("microsoft/TRELLIS.2-4B")
pipeline.cuda()
print("TRELLIS2: Pipeline on CUDA", flush=True)


# rembg pre-processing (Trellis2 default rembg is gated). The public
# `rembg` package uses u2net (Apache-2.0) and produces an RGBA image
# which Trellis2.preprocess_image will pass through unmodified.
print("TRELLIS2: Loading source image...", flush=True)
img_in = Image.open("{wsl_image}")
print(f"TRELLIS2: raw image mode={{img_in.mode}} size={{img_in.size}}", flush=True)
needs_rembg = True
if img_in.mode == "RGBA":
    alpha_arr = np.asarray(img_in)[:, :, 3]
    if not (alpha_arr == 255).all():
        needs_rembg = False  # already has a meaningful alpha channel
if needs_rembg:
    try:
        import rembg
        session = rembg.new_session("u2net")
        img_in = rembg.remove(img_in.convert("RGBA"), session=session)
        print("TRELLIS2: rembg u2net ok", flush=True)
    except Exception as re:
        print(f"TRELLIS2: rembg failed ({{re}}), Trellis2 will try its own", flush=True)

print("TRELLIS2: Running pipeline...", flush=True)
# Diagnostics: dump image stats + capability seen by cumm/spconv
print(f"DIAG: img mode={{img_in.mode}} size={{img_in.size}}", flush=True)
arr = np.asarray(img_in.convert("RGBA"))
alpha = arr[..., 3]
print(f"DIAG: alpha min={{alpha.min()}} max={{alpha.max()}} nonzero={{(alpha>0).sum()}}", flush=True)
print(f"DIAG: torch CC seen = {{torch.cuda.get_device_capability(0)}}", flush=True)
try:
    import cumm.tensorview as _tv
    print(f"DIAG: cumm CC seen = {{_tv.get_compute_capability(0)}}", flush=True)
except Exception as _e:
    print(f"DIAG: cumm import error: {{_e}}", flush=True)
import os as _os
print(f"DIAG: ATTN_BACKEND={{_os.environ.get('ATTN_BACKEND','unset')}} SPARSE_CONV_BACKEND={{_os.environ.get('SPARSE_CONV_BACKEND','unset')}}", flush=True)

start = time.time()
try:
    # Force 512 pipeline on 16 GB Blackwell (RTX 5080) -- 1024_cascade
    # needs > 16 GB VRAM and will OOM on the second cascade stage.
    mesh = pipeline.run(img_in, pipeline_type="512")[0]
    elapsed = time.time() - start
    print(f"TRELLIS2: Generated in {{elapsed:.0f}}s", flush=True)
except Exception as e:
    print(f"TRELLIS2_ERROR: {{type(e).__name__}}: {{e}}", flush=True)
    traceback.print_exc()
    raise

print("TRELLIS2: Simplifying mesh...", flush=True)
try:
    mesh.simplify(16777216)   # nvdiffrast vertex limit
except Exception as e:
    print(f"TRELLIS2: simplify warning: {{e}}", flush=True)

print("TRELLIS2: Exporting to GLB...", flush=True)
# CuMesh-free export path for Blackwell. o_voxel.postprocess.to_glb
# uses CuMesh (CUDA error 209 on sm_120). We build a trimesh GLB
# directly from mesh.vertices + mesh.faces and sample mesh.attrs
# (the texture latent volume) at each vertex to get RGB.
try:
    import trimesh
    import torch as _torch
    print(f"TRELLIS2: voxel coords shape={{tuple(mesh.coords.shape)}}", flush=True)
    # Use blackwell_fix.voxel_to_mesh which does marching cubes + Taubin
    # smoothing on the coord grid. Produces a clean closed surface mesh
    # instead of the raw voxel grid (3.7M micro-triangles = visually a
    # point cloud).
    print("TRELLIS2: voxel_to_mesh (marching cubes + Taubin)...", flush=True)
    tm_clean = blackwell_fix.voxel_to_mesh(
        mesh,
        target_height_mm=0,        # don't rescale to mm
        sigma=1.5,                 # Gaussian smoothing
        coarse_downsample=4,
        taubin_iterations=50,
        verbose=True,
    )
    print(f"TRELLIS2: marching cubes -> {{len(tm_clean.vertices)}}v / {{len(tm_clean.faces)}}f", flush=True)
    # Decimate: 4.58M faces is too heavy for browsers + downstream UV
    # bake. Target 100k faces (still dense vs SF3D 12k).
    if len(tm_clean.faces) > 200000:
        try:
            import fast_simplification as _fs
            _v, _f = _fs.simplify(
                np.asarray(tm_clean.vertices, dtype=np.float32),
                np.asarray(tm_clean.faces, dtype=np.uint32),
                target_count=100000,
            )
            tm_clean = trimesh.Trimesh(vertices=_v, faces=_f,
                                       process=False, validate=False)
            print(f"TRELLIS2: decimated -> {{len(tm_clean.vertices)}}v / {{len(tm_clean.faces)}}f", flush=True)
        except Exception as _de:
            print(f"TRELLIS2: decimation skipped ({{_de}})", flush=True)
    verts = np.asarray(tm_clean.vertices)
    faces = np.asarray(tm_clean.faces)

    # Sample texture from mesh.attrs (sparse voxel attribute volume)
    # mesh.attrs is the per-voxel feature tensor at coords mesh.coords
    # mesh.layout maps voxel positions to attr indices.
    # For each vertex, find nearest voxel coord and grab its attrs[0:3] = RGB.
    attrs = mesh.attrs.detach().cpu().numpy()         # (N, C)
    coords = mesh.coords.detach().cpu().numpy()       # (N, 3 or 4)
    voxel_size = float(mesh.voxel_size)
    print(f"TRELLIS2: attrs shape={{attrs.shape}} coords shape={{coords.shape}} voxel_size={{voxel_size}}", flush=True)
    # Voxel coords -> world coords
    if coords.shape[1] == 4:
        coords_xyz = coords[:, 1:4]
    else:
        coords_xyz = coords
    voxel_world = coords_xyz.astype(np.float32) * voxel_size - 0.5
    # KDTree nearest neighbour
    from scipy.spatial import cKDTree
    tree = cKDTree(voxel_world)
    _, nn_idx = tree.query(verts, k=1, workers=-1)
    if attrs.shape[1] >= 3:
        rgb = np.clip(attrs[nn_idx, :3], 0.0, 1.0)
        rgba = np.concatenate([rgb, np.ones((len(rgb), 1), dtype=rgb.dtype)], axis=1)
        rgba_u8 = (rgba * 255).astype(np.uint8)
    else:
        rgba_u8 = None

    tm = trimesh.Trimesh(vertices=verts, faces=faces, process=False, validate=False)
    if rgba_u8 is not None:
        tm.visual = trimesh.visual.ColorVisuals(mesh=tm, vertex_colors=rgba_u8)
    tm.export("{wsl_output}", file_type="glb")
    size = os.path.getsize("{wsl_output}")
    print(f"TRELLIS2_SUCCESS: {{size}} bytes", flush=True)
except Exception as e:
    print(f"TRELLIS2_ERROR: export: {{type(e).__name__}}: {{e}}", flush=True)
    traceback.print_exc()
    raise
'''

    script_dir = os.path.dirname(os.path.abspath(__file__))
    script_path = os.path.join(script_dir, '_trellis2_run.py')
    with open(script_path, 'w', encoding='utf-8') as f:
        f.write(script_content)

    wsl_script = to_wsl(script_path)
    print("TRELLIS2: Starting WSL...", flush=True)

    # ATTN_BACKEND left unset -> Trellis2 picks flash_attn by default when
    # it's installed. SDPA fallback produced broken latents (std ~0.057 vs
    # expected 1.0) which crashed the decoder; only the rescale hack made
    # the pipeline complete but the outputs were garbage. With flash_attn
    # installed we let Trellis2 use its native attention path.
    proc = subprocess.Popen(
        ['wsl', '-d', 'Ubuntu', '--', 'bash', '-c',
         'export PATH=/usr/local/cuda-12.8/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin && '
         'export CUDA_HOME=/usr/local/cuda-12.8 && '
         f'cd ~/TRELLIS.2 && source .venv/bin/activate && '
         f'python3 {wsl_script}'],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding='utf-8', errors='replace',
    )

    for line in proc.stdout:
        line = line.strip()
        if line:
            try:
                print(line, flush=True)
            except UnicodeEncodeError:
                print(line.encode('ascii', 'replace').decode(), flush=True)

    proc.wait()
    try:
        os.unlink(script_path)
    except Exception:
        pass

    if os.path.exists(output_path) and os.path.getsize(output_path) > 1000:
        return True
    return False


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python local_trellis2_bridge.py <image_path> <output_glb_path>")
        sys.exit(1)
    ok = generate_3d(sys.argv[1], sys.argv[2])
    sys.exit(0 if ok else 1)
