"""
FabMesh Local Hunyuan3D-2 Bridge
Shape: Windows GPU directly
Texture: WSL Ubuntu (custom_rasterizer)
Usage: python local_hunyuan3d_bridge.py <image_path> <output_glb_path>
"""
import sys
import os
import time
import subprocess

HUNYUAN_DIR = os.path.join(os.path.dirname(__file__), '..', 'Hunyuan3D-2')
sys.path.insert(0, HUNYUAN_DIR)

def generate_3d(image_path, output_path):
    import torch
    from PIL import Image
    from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline

    # Step 1: Shape on Windows GPU
    print("HUNYUAN3D: Loading shape model...", flush=True)
    shape_pipe = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained('tencent/Hunyuan3D-2')
    shape_pipe.to('cuda')
    print(f"HUNYUAN3D: Shape model on GPU ({torch.cuda.memory_allocated()/1024**3:.1f} GB)", flush=True)

    img = Image.open(image_path)
    print(f"HUNYUAN3D: Image loaded ({img.size})", flush=True)

    print("HUNYUAN3D: Generating 3D shape...", flush=True)
    start = time.time()
    try:
        meshes = shape_pipe(image=img, octree_resolution=256, num_inference_steps=30)
        mesh = meshes[0]
        print(f"HUNYUAN3D: Shape done in {time.time()-start:.0f}s", flush=True)

        # Save shape as OBJ for WSL texturing + GLB as fallback
        shape_obj = output_path.replace('.glb', '_shape.obj')
        mesh.export(shape_obj)
        mesh.export(output_path)
        print(f"HUNYUAN3D: Shape saved ({os.path.getsize(output_path)} bytes)", flush=True)

        del shape_pipe
        torch.cuda.empty_cache()
    except Exception as e:
        print(f"HUNYUAN3D_ERROR: Shape failed: {type(e).__name__}: {e}", flush=True)
        return False

    # Step 2: Texture via WSL
    print("HUNYUAN3D: Painting textures via WSL...", flush=True)

    def to_wsl(p):
        p = os.path.abspath(p).replace('\\', '/')
        if p[1] == ':':
            return '/mnt/' + p[0].lower() + p[2:]
        return p

    wsl_image = to_wsl(image_path)
    wsl_shape = to_wsl(shape_obj)
    wsl_output = to_wsl(output_path)
    hunyuan_wsl = to_wsl(HUNYUAN_DIR)

    # Write texgen script
    tex_script_path = os.path.join(os.path.dirname(__file__), '_texgen_run.py')
    with open(tex_script_path, 'w', encoding='utf-8') as f:
        f.write(f'''import sys, os, torch, trimesh
sys.path.insert(0, "{hunyuan_wsl}")
from PIL import Image
from hy3dgen.texgen import Hunyuan3DPaintPipeline

print("TEXGEN: Loading model...", flush=True)
pipe = Hunyuan3DPaintPipeline.from_pretrained("tencent/Hunyuan3D-2")
pipe.enable_model_cpu_offload()
print("TEXGEN: Model ready", flush=True)

mesh = trimesh.load("{wsl_shape}")
img = Image.open("{wsl_image}")
print(f"TEXGEN: Mesh {{len(mesh.vertices)}} verts, painting...", flush=True)

textured = pipe(mesh, image=img)
textured.export("{wsl_output}")
sz = os.path.getsize("{wsl_output}")
print(f"TEXGEN_SUCCESS: {{sz}} bytes", flush=True)
''')

    wsl_script = to_wsl(tex_script_path)

    try:
        proc = subprocess.Popen(
            ['wsl', '-d', 'Ubuntu', '--', 'bash', '-c',
             f'export PATH=/usr/local/cuda-12.8/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin && '
             f'export CUDA_HOME=/usr/local/cuda-12.8 && '
             f'cd ~/TRELLIS.2 && source .venv/bin/activate && '
             f'python3 {wsl_script}'],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace'
        )

        texgen_success = False
        for line in proc.stdout:
            line = line.strip()
            if line:
                try:
                    print(line, flush=True)
                except:
                    pass
                if 'TEXGEN_SUCCESS' in line:
                    texgen_success = True

        proc.wait()
        os.unlink(tex_script_path)

        if texgen_success:
            print("HUNYUAN3D: Textured mesh ready!", flush=True)
        else:
            print("HUNYUAN3D: Texturing failed, using shape only", flush=True)
    except Exception as tex_err:
        print(f"HUNYUAN3D: Texturing skipped ({tex_err})", flush=True)

    # Cleanup shape OBJ
    try:
        os.unlink(shape_obj)
    except:
        pass

    elapsed = time.time() - start
    size = os.path.getsize(output_path)
    print(f"HUNYUAN3D: Total time: {elapsed:.0f}s", flush=True)
    print(f"HUNYUAN3D_SUCCESS: {size} bytes", flush=True)
    return True

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python local_hunyuan3d_bridge.py <image_path> <output_glb_path>")
        sys.exit(1)
    success = generate_3d(sys.argv[1], sys.argv[2])
    sys.exit(0 if success else 1)
