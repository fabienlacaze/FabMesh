"""
TripoSG Bridge for FabMesh
Converts an image to a 3D GLB mesh using TripoSG on Hugging Face Spaces.
Usage: python triposg_bridge.py <image_path> <output_glb_path> [target_faces]
"""
import sys
import os
import shutil
import time

def generate_3d(image_path, output_path, target_faces=50000, max_retries=3):
    from gradio_client import Client, handle_file

    for attempt in range(max_retries):
        try:
            print(f"TRIPOSG: Attempt {attempt + 1}/{max_retries}...")
            sys.stdout.flush()

            client = Client('VAST-AI/TripoSG')
            client.predict(api_name='/start_session')

            print("TRIPOSG: Generating 3D geometry...")
            sys.stdout.flush()

            glb_path = client.predict(
                image=handle_file(image_path),
                seed=42,
                num_inference_steps=50,
                guidance_scale=7.0,
                simplify=True,
                target_face_num=target_faces,
                api_name='/image_to_3d'
            )
            print(f"TRIPOSG: Geometry done: {glb_path}")
            sys.stdout.flush()

            # Try texturing (may fail if GPU overloaded)
            try:
                print("TRIPOSG: Adding textures...")
                sys.stdout.flush()
                textured = client.predict(
                    image=handle_file(image_path),
                    mesh_path=glb_path,
                    seed=42,
                    api_name='/run_texture'
                )
                shutil.copy(str(textured), output_path)
                print(f"TRIPOSG: Textured mesh saved!")
            except Exception as tex_err:
                print(f"TRIPOSG: Texturing failed ({str(tex_err)[:100]}), using untextured mesh")
                shutil.copy(str(glb_path), output_path)

            size = os.path.getsize(output_path)
            print(f"TRIPOSG_SUCCESS: {output_path} ({size} bytes)")
            sys.stdout.flush()
            return True

        except Exception as e:
            print(f"TRIPOSG_RETRY: Attempt {attempt+1} failed: {str(e)[:150]}")
            sys.stdout.flush()
            if attempt < max_retries - 1:
                time.sleep(10 * (attempt + 1))

    print("TRIPOSG_ERROR: All retries failed")
    sys.stdout.flush()
    return False

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python triposg_bridge.py <image_path> <output_glb_path> [target_faces]")
        sys.exit(1)

    success = generate_3d(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 50000)
    sys.exit(0 if success else 1)
