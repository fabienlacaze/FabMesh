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

def generate_3d(image_path, output_path, max_faces=0, effort=2):
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

    # Auto-remove background for cleaner shape (Hunyuan3D handles RGBA)
    if img.mode != 'RGBA':
        try:
            from rembg import remove
            print("HUNYUAN3D: Removing background for cleaner shape...", flush=True)
            img = remove(img)
            print("HUNYUAN3D: Background removed", flush=True)
        except Exception as e:
            print(f"HUNYUAN3D: rembg skipped ({e})", flush=True)

    print("HUNYUAN3D: Generating 3D shape...", flush=True)
    start = time.time()
    try:
        # Map max_faces to octree_resolution for faster generation
        res_map = {
            1000: 128, 5000: 192, 10000: 256,
            20000: 288, 30000: 320, 40000: 352, 50000: 384,
            60000: 416, 70000: 448, 80000: 464, 90000: 480, 100000: 512,
            150000: 576, 200000: 640, 250000: 704, 300000: 768,
            350000: 832, 400000: 896, 450000: 960, 500000: 1024
        }
        octree_res = 256
        if max_faces > 0:
            for faces, res in sorted(res_map.items()):
                if max_faces <= faces:
                    octree_res = res
                    break
        # Effort slider controls num_inference_steps (quality vs speed)
        # 20 = fast preview, 200 = max quality (beyond that, gains are negligible)
        effort_steps = {1: 20, 2: 30, 3: 50, 4: 100, 5: 200}
        effort_labels = {1: 'Low', 2: 'Medium', 3: 'High', 4: 'Max', 5: 'Ultra'}
        inf_steps = effort_steps.get(int(effort), 30)
        label = effort_labels.get(int(effort), 'Medium')
        print(f"HUNYUAN3D: octree_resolution={octree_res}, steps={inf_steps} (effort={label})", flush=True)
        meshes = shape_pipe(image=img, octree_resolution=octree_res, num_inference_steps=inf_steps)
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
        import gc
        gc.collect()
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

    # Write texgen script - use json.dumps for safe string escaping
    import json
    target_val = max_faces if max_faces > 0 else 50000
    tex_script_path = os.path.join(os.path.dirname(__file__), '_texgen_run.py')
    with open(tex_script_path, 'w', encoding='utf-8') as f:
        f.write(
            "import sys, os, torch, trimesh\n"
            f"sys.path.insert(0, {json.dumps(hunyuan_wsl)})\n"
            "from PIL import Image\n"
            "from hy3dgen.texgen import Hunyuan3DPaintPipeline\n"
            "\n"
            'print("TEXGEN: Loading model...", flush=True)\n'
            'pipe = Hunyuan3DPaintPipeline.from_pretrained("tencent/Hunyuan3D-2")\n'
            "pipe.enable_model_cpu_offload()\n"
            'print("TEXGEN: Model ready", flush=True)\n'
            "\n"
            f"mesh = trimesh.load({json.dumps(wsl_shape)})\n"
            f"target = {target_val}\n"
            "if len(mesh.faces) > target:\n"
            '    print(f"TEXGEN: Decimating {len(mesh.faces)} -> {target} faces...", flush=True)\n'
            "    mesh = mesh.simplify_quadric_decimation(target)\n"
            '    print(f"TEXGEN: Decimated to {len(mesh.faces)} faces", flush=True)\n'
            f"img = Image.open({json.dumps(wsl_image)})\n"
            'print(f"TEXGEN: Mesh {len(mesh.vertices)} verts, painting...", flush=True)\n'
            "\n"
            "textured = pipe(mesh, image=img)\n"
            f"textured.export({json.dumps(wsl_output)})\n"
            f"sz = os.path.getsize({json.dumps(wsl_output)})\n"
            'print(f"TEXGEN_SUCCESS: {sz} bytes", flush=True)\n'
        )

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
        print("Usage: python local_hunyuan3d_bridge.py <image_path> <output_glb_path> [max_faces] [effort]")
        sys.exit(1)
    max_faces = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    effort = int(sys.argv[4]) if len(sys.argv) > 4 else 2
    success = generate_3d(sys.argv[1], sys.argv[2], max_faces, effort)
    sys.exit(0 if success else 1)
