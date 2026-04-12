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

import torch
# Disable TF32 — it can silently corrupt conv3d outputs on Blackwell
# (sm_120), which is what was making sparse_structure_decoder spit out
# all-negative values (min=-170, max=-74) instead of normal logits.
torch.backends.cuda.matmul.allow_tf32 = False
torch.backends.cudnn.allow_tf32 = False
torch.backends.cudnn.deterministic = True
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
try:
    glb = o_voxel.postprocess.to_glb(
        vertices=mesh.vertices,
        faces=mesh.faces,
        attr_volume=mesh.attrs,
        coords=mesh.coords,
        attr_layout=mesh.layout,
        voxel_size=mesh.voxel_size,
        aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
        decimation_target=1000000,
        texture_size=1024,
        remesh=True,
        remesh_band=1,
        remesh_project=0,
        verbose=True,
    )
    glb.export("{wsl_output}")
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
