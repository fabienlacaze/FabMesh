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

    print("LOCAL_TRIPOSR: Loading model...")
    sys.stdout.flush()

    model = TSR.from_pretrained(
        'stabilityai/TripoSR',
        config_name='config.yaml',
        weight_name='model.ckpt'
    )
    model.to('cuda')

    print("LOCAL_TRIPOSR: Processing image (removing background)...")
    sys.stdout.flush()
    image = Image.open(image_path).convert('RGBA')

    # Remove background for better results
    try:
        from rembg import remove
        image = remove(image)
        # Put on white background
        bg = Image.new('RGBA', image.size, (255, 255, 255, 255))
        bg.paste(image, mask=image.split()[3])
        image = bg.convert('RGB')
        print("LOCAL_TRIPOSR: Background removed")
    except Exception as e:
        print(f"LOCAL_TRIPOSR: rembg failed ({e}), using original image")
        image = image.convert('RGB')

    start = time.time()
    with torch.no_grad():
        scene_codes = model([image], device='cuda')
    gen_time = time.time() - start
    print(f"LOCAL_TRIPOSR: 3D generated in {gen_time:.1f}s")
    sys.stdout.flush()

    print("LOCAL_TRIPOSR: Extracting mesh (may take 20-40s)...")
    sys.stdout.flush()
    meshes = model.extract_mesh(scene_codes, has_vertex_color=True, resolution=resolution)
    mesh = meshes[0]
    mesh.export(output_path)

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
