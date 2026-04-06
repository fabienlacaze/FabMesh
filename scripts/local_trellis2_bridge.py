"""
FabMesh Local TRELLIS 2 Bridge - Low VRAM mode
Usage: python local_trellis2_bridge.py <image_path> <output_glb_path>
"""
import sys, os, subprocess

def generate_3d(image_path, output_path):
    def to_wsl(p):
        p = os.path.abspath(p).replace('\\', '/')
        if p[1] == ':':
            return '/mnt/' + p[0].lower() + p[2:]
        return p

    wsl_image = to_wsl(image_path)
    wsl_output = to_wsl(output_path)

    script_content = f'''import os
os.environ["HF_TOKEN"] = "{os.environ.get("HF_TOKEN", "")}"
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
import torch, sys, time, gc
sys.path.insert(0, ".")
from huggingface_hub import login
login(token="{os.environ.get("HF_TOKEN", "")}")
from trellis2.pipelines.trellis2_image_to_3d import Trellis2ImageTo3DPipeline
from PIL import Image

print("TRELLIS2: Loading pipeline...", flush=True)
pipe = Trellis2ImageTo3DPipeline.from_pretrained("microsoft/TRELLIS.2-4B")
pipe.low_vram = True

img = Image.open("{wsl_image}").resize((512, 512))
print("TRELLIS2: Image loaded", flush=True)

# Convert to fp16 on CPU first
for name, model in pipe.models.items():
    model.half()
print("TRELLIS2: All models fp16 on CPU", flush=True)

# Set device to cuda WITHOUT moving models (low_vram moves them on-demand)
pipe._device = torch.device("cuda")
torch.cuda.empty_cache()
gc.collect()

torch.cuda.empty_cache()
gc.collect()

print("TRELLIS2: Generating 3D...", flush=True)
start = time.time()
try:
    with torch.autocast(device_type="cuda", dtype=torch.float16):
        meshes = pipe.run(img, seed=42, pipeline_type="512", max_num_tokens=4096)
    elapsed = time.time() - start
    print(f"TRELLIS2: Generated in {{elapsed:.0f}}s", flush=True)
    print("TRELLIS2: Exporting GLB...", flush=True)
    meshes[0].export("{wsl_output}")
    size = os.path.getsize("{wsl_output}")
    print(f"TRELLIS2_SUCCESS: {{size}} bytes", flush=True)
except torch.cuda.OutOfMemoryError as e:
    print(f"TRELLIS2_ERROR: Out of VRAM: {{e}}", flush=True)
except Exception as e:
    print(f"TRELLIS2_ERROR: {{type(e).__name__}}: {{e}}", flush=True)
    import traceback; traceback.print_exc()
'''

    script_dir = os.path.dirname(os.path.abspath(__file__))
    script_path = os.path.join(script_dir, '_trellis2_run.py')
    with open(script_path, 'w', encoding='utf-8') as f:
        f.write(script_content)

    wsl_script = to_wsl(script_path)
    print("TRELLIS2: Starting WSL...", flush=True)

    proc = subprocess.Popen(
        ['wsl', '-d', 'Ubuntu', '--', 'bash', '-c',
         f'export PATH=/usr/local/cuda-12.8/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin && '
         f'export CUDA_HOME=/usr/local/cuda-12.8 && '
         f'export ATTN_BACKEND=sdpa && '
         f'cd ~/TRELLIS.2 && source .venv/bin/activate && '
         f'python3 {wsl_script}'],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace'
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
    except:
        pass

    if os.path.exists(output_path) and os.path.getsize(output_path) > 1000:
        return True
    return False

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python local_trellis2_bridge.py <image_path> <output_glb_path>")
        sys.exit(1)
    success = generate_3d(sys.argv[1], sys.argv[2])
    sys.exit(0 if success else 1)
