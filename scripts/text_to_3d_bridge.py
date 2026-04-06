"""
FabMesh Text-to-3D Bridge
Pipeline: Text -> Pollinations (image) -> TRELLIS (3D mesh with PBR textures)
100% free, no accounts needed.

Usage: python text_to_3d_bridge.py "<prompt>" <output_glb_path> [texture_size] [num_images]
"""
import sys
import os
import shutil
import urllib.request
import urllib.parse
import ssl
import json
import time

def generate_images(prompt, output_dir, num_images=4):
    """Generate reference images using Pollinations.ai (free, no auth)"""
    print("STEP1_START: Generating reference images...")
    sys.stdout.flush()

    optimized_prompt = (
        f"3D render of {prompt}, single object centered on plain white background, "
        f"studio lighting, high detail, no text, isometric view, product photography"
    )

    images = []
    for i in range(num_images):
        encoded = urllib.parse.quote(optimized_prompt)
        seed = int(time.time() * 1000) + i
        url = f"https://image.pollinations.ai/prompt/{encoded}?width=1024&height=1024&nologo=true&seed={seed}"

        req = urllib.request.Request(url, headers={'User-Agent': 'FabMesh/1.0'})
        ctx = ssl.create_default_context()

        img_path = os.path.join(output_dir, f"ref_image_{i}.png")
        try:
            resp = urllib.request.urlopen(req, timeout=120, context=ctx)
            data = resp.read()
            with open(img_path, 'wb') as f:
                f.write(data)
            images.append(img_path)
            print(f"STEP1_IMAGE: {img_path} ({len(data)} bytes)")
            sys.stdout.flush()
        except Exception as e:
            print(f"STEP1_WARN: Image {i} failed: {e}")
            sys.stdout.flush()

    print(f"STEP1_DONE: {len(images)} images generated")
    sys.stdout.flush()
    return images


def image_to_3d(image_path, output_path, texture_size=1024):
    """Convert image to 3D mesh using TRELLIS on Hugging Face (free, no auth)"""
    from gradio_client import Client

    print("STEP2_START: Converting to 3D with TRELLIS...")
    sys.stdout.flush()

    client = Client('microsoft/TRELLIS')

    client.predict(api_name='/start_session')

    client.predict(image=image_path, api_name='/preprocess_image')

    print("STEP2_PROGRESS: Generating 3D geometry...")
    sys.stdout.flush()

    client.predict(
        image=image_path,
        multiimages=[],
        seed=42,
        ss_guidance_strength=7.5,
        ss_sampling_steps=12,
        slat_guidance_strength=3.0,
        slat_sampling_steps=12,
        multiimage_algo='stochastic',
        api_name='/image_to_3d'
    )

    print("STEP2_PROGRESS: Extracting textured GLB mesh...")
    sys.stdout.flush()

    glb_result = client.predict(
        mesh_simplify=0.95,
        texture_size=texture_size,
        api_name='/extract_glb'
    )

    found = False
    if isinstance(glb_result, tuple):
        for f in glb_result:
            if f and str(f).endswith('.glb'):
                shutil.copy(str(f), output_path)
                found = True
                break
    elif isinstance(glb_result, str) and glb_result.endswith('.glb'):
        shutil.copy(glb_result, output_path)
        found = True

    if not found:
        print(f"TRELLIS_ERROR: No GLB in result: {glb_result}")
        return False

    size = os.path.getsize(output_path)
    print(f"STEP2_DONE: {output_path} ({size} bytes)")
    sys.stdout.flush()
    return True


def text_to_3d(prompt, output_path, texture_size=1024, num_images=4):
    """Full pipeline: text -> images -> select -> 3D"""
    output_dir = os.path.dirname(output_path)

    # Step 1: Generate reference images
    images = generate_images(prompt, output_dir, num_images)
    if not images:
        print("ERROR: No images generated")
        return False

    # Output image paths as JSON for the UI to pick from
    print(f"IMAGES_READY: {json.dumps(images)}")
    sys.stdout.flush()

    # If called with --auto, use first image automatically
    if '--auto' in sys.argv:
        selected = images[0]
    else:
        # Wait for selection from stdin
        print("WAITING_SELECTION: Send image index (0-based) via stdin")
        sys.stdout.flush()
        try:
            line = sys.stdin.readline().strip()
            idx = int(line)
            selected = images[idx] if idx < len(images) else images[0]
        except:
            selected = images[0]

    print(f"SELECTED: {selected}")
    sys.stdout.flush()

    # Step 2: Convert to 3D
    return image_to_3d(selected, output_path, texture_size)


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python text_to_3d_bridge.py \"<prompt>\" <output_glb_path> [texture_size] [num_images]")
        sys.exit(1)

    prompt = sys.argv[1]
    output_path = sys.argv[2]
    texture_size = int(sys.argv[3]) if len(sys.argv) > 3 else 1024
    num_images = int(sys.argv[4]) if len(sys.argv) > 4 else 4

    success = text_to_3d(prompt, output_path, texture_size, num_images)
    if success:
        print(f"SUCCESS: {output_path}")
    sys.exit(0 if success else 1)
