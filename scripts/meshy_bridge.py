"""
FabMesh Meshy.ai Bridge — cloud pipeline
========================================

Talks to the Meshy.ai REST API to run any of the 3 pipeline steps:
  1. text-to-image   (nano-banana model)
  2. image-to-3d     (GLB/FBX with PBR textures)
  3. rigging         (auto-rigged humanoid with walk/run animations)

Meshy free tier = CC-BY 4.0 on outputs (commercial use OK with attribution).

Usage:
    python meshy_bridge.py text2image <api_key> <prompt> <output_dir> [num_images]
    python meshy_bridge.py image2mesh <api_key> <image_path> <output_glb> [target_faces] [texture_res]
    python meshy_bridge.py rig        <api_key> <mesh_glb>   <output_glb> [height_meters]

Progress markers are printed to stdout for the FabMesh job progress bar:
    LOCAL_MESHY_PROGRESS: <pct> <label>
    LOCAL_MESHY_SUCCESS:  <output_path> (<size> bytes)
    LOCAL_MESHY_ERROR:    <message>
"""
import sys
import os
import time
import base64
import json
import traceback
import urllib.request
import urllib.parse
import mimetypes


API_BASE = "https://api.meshy.ai/openapi/v1"
POLL_INTERVAL_S = 4.0
POLL_TIMEOUT_S = 1800  # 30 min hard cap (mesh can take 5-10 min, rig ~1-2 min)


def log(msg):
    print(f"LOCAL_MESHY: {msg}", flush=True)


def progress(pct, label):
    print(f"LOCAL_MESHY_PROGRESS: {pct} {label}", flush=True)


def _http_json(method, url, api_key, body=None):
    """Tiny JSON HTTP helper. Uses urllib so we don't force the user to
    install `requests` in the Python env. Raises RuntimeError on failure."""
    headers = {
        'Authorization': f'Bearer {api_key}',
        'Accept': 'application/json',
    }
    data = None
    if body is not None:
        data = json.dumps(body).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read()
            if not raw:
                return {}
            return json.loads(raw.decode('utf-8'))
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='replace')
        raise RuntimeError(f"HTTP {e.code} from {url}: {body[:500]}") from e


def _download(url, out_path):
    """Download a file from a signed Meshy asset URL to `out_path`."""
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with urllib.request.urlopen(url, timeout=300) as resp:
        with open(out_path, 'wb') as f:
            while True:
                chunk = resp.read(64 * 1024)
                if not chunk:
                    break
                f.write(chunk)
    return os.path.getsize(out_path)


def _poll(task_url, api_key, start_pct=50, end_pct=95):
    """Poll a Meshy task until SUCCEEDED/FAILED/CANCELED. Emit progress
    markers scaled to [start_pct, end_pct]."""
    t0 = time.time()
    last_pct = -1
    while True:
        if time.time() - t0 > POLL_TIMEOUT_S:
            raise RuntimeError(f"Meshy task timed out after {POLL_TIMEOUT_S}s")
        info = _http_json('GET', task_url, api_key)
        status = info.get('status', 'UNKNOWN')
        p = info.get('progress', 0) or 0
        # Map task progress [0,100] to our window [start_pct, end_pct]
        mapped = start_pct + (end_pct - start_pct) * (p / 100.0)
        mapped = int(max(start_pct, min(end_pct, mapped)))
        if mapped != last_pct:
            progress(mapped, f"meshy_{status.lower()}")
            last_pct = mapped
        if status == 'SUCCEEDED':
            return info
        if status in ('FAILED', 'CANCELED'):
            err = info.get('task_error') or info.get('error') or status
            raise RuntimeError(f"Meshy task {status}: {err}")
        time.sleep(POLL_INTERVAL_S)


# ----------------------------------------------------------------------
# Step 1: text-to-image
# ----------------------------------------------------------------------
def text_to_image(api_key, prompt, output_dir, num_images=1):
    log(f"text-to-image prompt={prompt[:80]!r} n={num_images}")
    progress(5, "meshy_submit")
    os.makedirs(output_dir, exist_ok=True)
    saved = []
    for i in range(int(num_images)):
        body = {
            'ai_model': 'nano-banana',
            'prompt': prompt,
            'aspect_ratio': '1:1',
        }
        resp = _http_json('POST', f"{API_BASE}/text-to-image", api_key, body)
        task_id = resp.get('result')
        if not task_id:
            raise RuntimeError(f"No task id in response: {resp}")
        log(f"task {i+1}/{num_images} id={task_id}")

        info = _poll(
            f"{API_BASE}/text-to-image/{task_id}",
            api_key,
            start_pct=10 + (i * 80 // max(1, int(num_images))),
            end_pct=10 + ((i + 1) * 80 // max(1, int(num_images))),
        )
        urls = info.get('image_urls') or []
        if not urls:
            raise RuntimeError(f"No image_urls for task {task_id}: {info}")

        for j, url in enumerate(urls):
            ts = int(time.time() * 1000)
            name = f"meshy_{ts}_{i}_{j}.png"
            out = os.path.join(output_dir, name)
            size = _download(url, out)
            log(f"saved {out} ({size} bytes)")
            saved.append(out)

    progress(100, "done")
    print(f"LOCAL_MESHY_SUCCESS: {len(saved)} images in {output_dir}", flush=True)
    return saved


# ----------------------------------------------------------------------
# Step 2: image-to-3d
# ----------------------------------------------------------------------
def _image_to_data_uri(path):
    """Meshy accepts either a public URL or a data URI. We always upload
    as data URI so the caller doesn't need to host anything."""
    mime = mimetypes.guess_type(path)[0] or 'image/png'
    with open(path, 'rb') as f:
        b64 = base64.b64encode(f.read()).decode('ascii')
    return f"data:{mime};base64,{b64}"


def image_to_mesh(api_key, image_path, output_path, target_faces=50000, texture_res=1024):
    log(f"image-to-3d image={image_path} target_faces={target_faces}")
    progress(5, "encode_input")
    data_uri = _image_to_data_uri(image_path)

    # Clamp target_faces to Meshy accepted range [100, 300000]
    tf = max(100, min(300000, int(target_faces)))

    body = {
        'image_url': data_uri,
        'ai_model': 'latest',
        'topology': 'triangle',
        'target_polycount': tf,
        'should_texture': True,
        'enable_pbr': True,
        'target_formats': ['glb'],
    }
    progress(10, "meshy_submit")
    resp = _http_json('POST', f"{API_BASE}/image-to-3d", api_key, body)
    task_id = resp.get('result')
    if not task_id:
        raise RuntimeError(f"No task id in response: {resp}")
    log(f"task id={task_id}")

    info = _poll(f"{API_BASE}/image-to-3d/{task_id}", api_key, start_pct=15, end_pct=90)
    urls = info.get('model_urls') or {}
    glb_url = urls.get('glb')
    if not glb_url:
        raise RuntimeError(f"No glb url for task {task_id}: {info}")

    size = _download(glb_url, output_path)
    print(f"LOCAL_MESHY_SUCCESS: {output_path} ({size} bytes)", flush=True)
    progress(100, "done")
    return output_path


# ----------------------------------------------------------------------
# Step 3: rigging
# ----------------------------------------------------------------------
def _glb_to_data_uri(path):
    with open(path, 'rb') as f:
        b64 = base64.b64encode(f.read()).decode('ascii')
    return f"data:model/gltf-binary;base64,{b64}"


def rig_mesh(api_key, mesh_path, output_path, height_meters=1.7):
    log(f"rigging mesh={mesh_path} height={height_meters}")
    progress(5, "encode_input")
    data_uri = _glb_to_data_uri(mesh_path)

    body = {
        'model_url': data_uri,
        'height_meters': float(height_meters),
    }
    progress(10, "meshy_submit")
    resp = _http_json('POST', f"{API_BASE}/rigging", api_key, body)
    task_id = resp.get('result')
    if not task_id:
        raise RuntimeError(f"No task id in rigging response: {resp}")
    log(f"task id={task_id}")

    info = _poll(f"{API_BASE}/rigging/{task_id}", api_key, start_pct=15, end_pct=90)
    glb_url = info.get('rigged_character_glb_url')
    if not glb_url:
        raise RuntimeError(f"No rigged_character_glb_url for task {task_id}: {info}")

    size = _download(glb_url, output_path)
    print(f"LOCAL_MESHY_SUCCESS: {output_path} ({size} bytes)", flush=True)
    progress(100, "done")
    return output_path


# ----------------------------------------------------------------------
# CLI dispatch
# ----------------------------------------------------------------------
def main():
    if len(sys.argv) < 4:
        print(__doc__)
        return 1
    mode = sys.argv[1]
    api_key = sys.argv[2]
    try:
        if mode == 'text2image':
            prompt = sys.argv[3]
            out_dir = sys.argv[4] if len(sys.argv) > 4 else 'images/meshy'
            n = int(sys.argv[5]) if len(sys.argv) > 5 else 1
            text_to_image(api_key, prompt, out_dir, n)
        elif mode == 'image2mesh':
            img = sys.argv[3]
            out = sys.argv[4]
            tf = int(sys.argv[5]) if len(sys.argv) > 5 else 50000
            tr = int(sys.argv[6]) if len(sys.argv) > 6 else 1024
            image_to_mesh(api_key, img, out, tf, tr)
        elif mode == 'rig':
            mesh = sys.argv[3]
            out = sys.argv[4]
            h = float(sys.argv[5]) if len(sys.argv) > 5 else 1.7
            rig_mesh(api_key, mesh, out, h)
        else:
            print(f"Unknown mode: {mode}")
            return 2
        return 0
    except Exception as e:
        msg = f"{type(e).__name__}: {e}"
        print(f"LOCAL_MESHY_ERROR: {msg}", flush=True)
        traceback.print_exc()
        return 3


if __name__ == '__main__':
    sys.exit(main())
