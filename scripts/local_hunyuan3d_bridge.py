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

def generate_3d(image_path, output_path, max_faces=0):
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
        # Map max_faces to octree_resolution for faster generation
        res_map = {1000: 128, 5000: 192, 10000: 256, 50000: 384, 100000: 512, 200000: 640, 300000: 768, 400000: 896, 500000: 1024}
        octree_res = 256
        if max_faces > 0:
            for faces, res in sorted(res_map.items()):
                if max_faces <= faces:
                    octree_res = res
                    break
        print(f"HUNYUAN3D: Using octree_resolution={octree_res} for max {max_faces} faces", flush=True)
        meshes = shape_pipe(image=img, octree_resolution=octree_res, num_inference_steps=30)
        mesh = meshes[0]
        print(f"HUNYUAN3D: Shape done in {time.time()-start:.0f}s", flush=True)

        # Save shape as OBJ
        shape_obj = output_path.replace('.glb', '_shape.obj')
        mesh.export(shape_obj)

        # Decimate with trimesh if needed
        import trimesh
        tri_mesh = trimesh.load(shape_obj)
        if max_faces > 0 and len(tri_mesh.faces) > max_faces:
            print(f"HUNYUAN3D: Decimating {len(tri_mesh.faces)} -> {max_faces} faces...", flush=True)
            import fast_simplification
            ratio = max_faces / len(tri_mesh.faces)
            verts, faces = fast_simplification.simplify(tri_mesh.vertices, tri_mesh.faces, target_reduction=1.0 - ratio)
            tri_mesh = trimesh.Trimesh(vertices=verts, faces=faces)
            tri_mesh.export(shape_obj)
            tri_mesh.export(output_path)
            print(f"HUNYUAN3D: Decimated to {len(tri_mesh.faces)} faces", flush=True)
        else:
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
target = {max_faces if max_faces > 0 else 50000}
if len(mesh.faces) > target:
    print(f"TEXGEN: Decimating {{len(mesh.faces)}} -> {{target}} faces...", flush=True)
    mesh = mesh.simplify_quadric_decimation(target)
    print(f"TEXGEN: Decimated to {{len(mesh.faces)}} faces", flush=True)
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

        # Free WSL memory by shutting it down (texgen uses ~10GB RAM)
        try:
            print("HUNYUAN3D: Shutting down WSL to free RAM...", flush=True)
            subprocess.run(['wsl', '--shutdown'], timeout=10, capture_output=True)
        except Exception:
            pass
    except Exception as tex_err:
        print(f"HUNYUAN3D: Texturing skipped ({tex_err})", flush=True)
        try:
            subprocess.run(['wsl', '--shutdown'], timeout=10, capture_output=True)
        except Exception:
            pass

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
        print("Usage: python local_hunyuan3d_bridge.py <image_path> <output_glb_path> [max_faces]")
        sys.exit(1)
    max_faces = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    success = generate_3d(sys.argv[1], sys.argv[2], max_faces)
    sys.exit(0 if success else 1)
