"""
TRELLIS Bridge for FabMesh
Converts an image to a 3D GLB mesh using TRELLIS on Hugging Face Spaces.
Includes retry logic for when the Space is overloaded.
Usage: python trellis_bridge.py <image_path> <output_glb_path> [mesh_simplify] [texture_size]
"""
import sys
import os
import shutil
import time

def generate_3d(image_path, output_path, mesh_simplify=0.95, texture_size=1024, max_retries=3):
    from gradio_client import Client

    for attempt in range(max_retries):
        try:
            print(f"TRELLIS: Attempt {attempt + 1}/{max_retries}...")
            sys.stdout.flush()

            print("TRELLIS: Connecting...")
            sys.stdout.flush()
            client = Client('microsoft/TRELLIS')

            print("TRELLIS: Starting session...")
            sys.stdout.flush()
            client.predict(api_name='/start_session')

            print("TRELLIS: Preprocessing image...")
            sys.stdout.flush()
            client.predict(image=image_path, api_name='/preprocess_image')

            print("TRELLIS: Generating 3D model...")
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

            print("TRELLIS: Extracting GLB mesh...")
            sys.stdout.flush()
            glb_result = client.predict(
                mesh_simplify=mesh_simplify,
                texture_size=texture_size,
                api_name='/extract_glb'
            )

            # Find and copy the GLB file
            if isinstance(glb_result, tuple):
                for f in glb_result:
                    if f and str(f).endswith('.glb'):
                        shutil.copy(str(f), output_path)
                        size = os.path.getsize(output_path)
                        print(f"TRELLIS_SUCCESS: {output_path} ({size} bytes)")
                        sys.stdout.flush()
                        return True
            elif isinstance(glb_result, str) and glb_result.endswith('.glb'):
                shutil.copy(glb_result, output_path)
                size = os.path.getsize(output_path)
                print(f"TRELLIS_SUCCESS: {output_path} ({size} bytes)")
                sys.stdout.flush()
                return True

            print("TRELLIS_WARN: No GLB file in result, retrying...")
            sys.stdout.flush()

        except Exception as e:
            err_msg = str(e)[:200]
            print(f"TRELLIS_RETRY: Attempt {attempt + 1} failed: {err_msg}")
            sys.stdout.flush()
            if attempt < max_retries - 1:
                wait = 10 * (attempt + 1)
                print(f"TRELLIS_WAIT: Waiting {wait}s before retry...")
                sys.stdout.flush()
                time.sleep(wait)

    print("TRELLIS_ERROR: All retries failed. The TRELLIS Space may be overloaded. Try again later.")
    sys.stdout.flush()
    return False

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python trellis_bridge.py <image_path> <output_glb_path> [mesh_simplify] [texture_size]")
        sys.exit(1)

    image_path = sys.argv[1]
    output_path = sys.argv[2]
    mesh_simplify = float(sys.argv[3]) if len(sys.argv) > 3 else 0.95
    texture_size = int(sys.argv[4]) if len(sys.argv) > 4 else 1024

    success = generate_3d(image_path, output_path, mesh_simplify, texture_size)
    sys.exit(0 if success else 1)
