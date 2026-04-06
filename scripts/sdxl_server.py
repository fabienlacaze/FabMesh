"""
FabMesh SDXL Persistent Server
Keeps SDXL Turbo img2img + SDXL Inpainting + CLIPSeg in memory
to avoid 5-10s reload per call.

Listens on 127.0.0.1:5555 via simple HTTP/JSON.

Endpoints:
  GET  /ping              - health check
  POST /img2img           - { input, prompt, output, strength }
  POST /inpaint           - { input, target, prompt, output, dilate }
  POST /shutdown          - graceful exit
"""
import os
import sys
import json
import time
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

import torch
from PIL import Image, ImageFilter
import numpy as np

HOST = '127.0.0.1'
PORT = 5555

# Global pipelines (lazy loaded)
_img2img_pipe = None
_inpaint_pipe = None
_clipseg_model = None
_clipseg_processor = None
_load_lock = threading.Lock()


def log(msg):
    print(f"[SDXL-SERVER] {msg}", flush=True)


def load_img2img():
    global _img2img_pipe
    if _img2img_pipe is not None:
        return _img2img_pipe
    with _load_lock:
        if _img2img_pipe is not None:
            return _img2img_pipe
        log("Loading SDXL Turbo img2img...")
        from diffusers import StableDiffusionXLImg2ImgPipeline
        pipe = StableDiffusionXLImg2ImgPipeline.from_pretrained(
            "stabilityai/sdxl-turbo",
            torch_dtype=torch.float16,
            variant="fp16",
            use_safetensors=True,
        )
        pipe.to("cuda")
        pipe.enable_attention_slicing()
        pipe.enable_vae_tiling()
        _img2img_pipe = pipe
        log(f"SDXL Turbo loaded ({torch.cuda.memory_allocated()/1024**3:.1f} GB VRAM)")
    return _img2img_pipe


def load_inpaint():
    global _inpaint_pipe, _clipseg_model, _clipseg_processor
    if _inpaint_pipe is not None and _clipseg_model is not None:
        return _inpaint_pipe
    with _load_lock:
        if _clipseg_model is None:
            log("Loading CLIPSeg...")
            from transformers import CLIPSegForImageSegmentation, CLIPSegProcessor
            _clipseg_processor = CLIPSegProcessor.from_pretrained("CIDAS/clipseg-rd64-refined")
            _clipseg_model = CLIPSegForImageSegmentation.from_pretrained("CIDAS/clipseg-rd64-refined")
            _clipseg_model.to("cuda")
            _clipseg_model.eval()
            log("CLIPSeg loaded")
        if _inpaint_pipe is None:
            log("Loading SDXL Inpainting...")
            from diffusers import StableDiffusionXLInpaintPipeline
            pipe = StableDiffusionXLInpaintPipeline.from_pretrained(
                "diffusers/stable-diffusion-xl-1.0-inpainting-0.1",
                torch_dtype=torch.float16,
                variant="fp16",
            )
            pipe.to("cuda")
            pipe.enable_attention_slicing()
            pipe.enable_vae_tiling()
            _inpaint_pipe = pipe
            log(f"SDXL Inpainting loaded ({torch.cuda.memory_allocated()/1024**3:.1f} GB VRAM)")
    return _inpaint_pipe


def do_img2img(input_path, prompt, output_path, strength):
    pipe = load_img2img()

    img = Image.open(input_path).convert("RGB")
    w, h = img.size
    if w < h:
        new_w, new_h = 1024, int(h * 1024 / w)
    else:
        new_h, new_w = 1024, int(w * 1024 / h)
    new_w = (new_w // 8) * 8
    new_h = (new_h // 8) * 8
    img = img.resize((new_w, new_h), Image.LANCZOS)

    enhanced = f"{prompt}, high quality, detailed"
    s = float(strength)
    steps = max(2, int(round(4 / s)))
    t0 = time.time()
    result = pipe(
        prompt=enhanced,
        image=img,
        strength=s,
        num_inference_steps=steps,
        guidance_scale=0.0,
    ).images[0]
    result.save(output_path)
    log(f"img2img done in {time.time()-t0:.1f}s -> {output_path}")
    return {"ok": True, "output": output_path}


def do_inpaint(input_path, target_text, prompt, output_path, dilate):
    pipe = load_inpaint()

    img = Image.open(input_path).convert("RGB")
    orig_w, orig_h = img.size
    max_dim = 1024
    if max(orig_w, orig_h) > max_dim:
        if orig_w > orig_h:
            work_w, work_h = max_dim, int(orig_h * max_dim / orig_w)
        else:
            work_h, work_w = max_dim, int(orig_w * max_dim / orig_h)
    else:
        work_w, work_h = orig_w, orig_h
    work_w = (work_w // 8) * 8
    work_h = (work_h // 8) * 8
    img_work = img.resize((work_w, work_h), Image.LANCZOS)

    # Segment
    t0 = time.time()
    inputs = _clipseg_processor(text=[target_text], images=[img_work], padding=True, return_tensors="pt")
    inputs = {k: v.to("cuda") for k, v in inputs.items()}
    with torch.no_grad():
        seg_out = _clipseg_model(**inputs)
    mask = torch.sigmoid(seg_out.logits).squeeze().cpu().numpy()
    mask_img = Image.fromarray((mask * 255).astype(np.uint8)).resize((work_w, work_h), Image.BILINEAR)
    binary = (np.array(mask_img) > 100).astype(np.uint8) * 255
    mask_binary = Image.fromarray(binary, mode="L")
    if dilate > 0:
        mask_binary = mask_binary.filter(ImageFilter.MaxFilter(int(dilate) * 2 + 1))
    mask_binary = mask_binary.filter(ImageFilter.GaussianBlur(3))

    coverage = (np.array(mask_binary) > 128).mean() * 100
    if coverage < 0.5:
        return {"ok": False, "error": f"Target '{target_text}' not found"}

    # Save debug mask
    debug_dir = os.path.join(os.path.dirname(output_path), ".debug")
    os.makedirs(debug_dir, exist_ok=True)
    debug_mask = os.path.join(debug_dir, os.path.basename(output_path).replace(".png", "_mask.png").replace(".jpg", "_mask.png"))
    mask_binary.save(debug_mask)

    inpaint_prompt = (prompt or "").strip()
    is_removal = inpaint_prompt.lower() in ("", "remove", "delete", "none", "nothing", "empty", "gone")
    if is_removal:
        inpaint_prompt = "continuation of the surrounding area, same background, seamless"
        negative_prompt = f"{target_text}, any object, duplicate, artifact, blurry, distorted"
    else:
        negative_prompt = f"blurry, distorted, duplicate, {target_text}"

    result = pipe(
        prompt=inpaint_prompt,
        negative_prompt=negative_prompt,
        image=img_work,
        mask_image=mask_binary,
        num_inference_steps=40,
        guidance_scale=8.5,
        strength=0.99,
        height=work_h,
        width=work_w,
    ).images[0]

    if (work_w, work_h) != (orig_w, orig_h):
        result = result.resize((orig_w, orig_h), Image.LANCZOS)
    result.save(output_path)
    log(f"inpaint done in {time.time()-t0:.1f}s -> {output_path}")
    return {"ok": True, "output": output_path}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # Suppress default HTTP logs

    def _json_response(self, code, data):
        body = json.dumps(data).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/ping':
            self._json_response(200, {"ok": True, "status": "ready"})
        else:
            self._json_response(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        try:
            data = json.loads(self.rfile.read(length).decode('utf-8'))
        except Exception as e:
            self._json_response(400, {"ok": False, "error": f"bad json: {e}"})
            return

        try:
            if self.path == '/img2img':
                result = do_img2img(
                    data['input'],
                    data['prompt'],
                    data['output'],
                    data.get('strength', 0.55),
                )
                self._json_response(200, result)
            elif self.path == '/inpaint':
                result = do_inpaint(
                    data['input'],
                    data['target'],
                    data.get('prompt', ''),
                    data['output'],
                    data.get('dilate', 15),
                )
                self._json_response(200, result)
            elif self.path == '/shutdown':
                self._json_response(200, {"ok": True, "bye": True})
                log("Shutdown requested")
                threading.Thread(target=lambda: (time.sleep(0.3), os._exit(0))).start()
            else:
                self._json_response(404, {"ok": False, "error": "not found"})
        except Exception as e:
            import traceback
            traceback.print_exc()
            self._json_response(500, {"ok": False, "error": str(e)})


def preload_models():
    """Preload models in background after server starts."""
    try:
        log("Preloading img2img model...")
        load_img2img()
        log("Preloading inpaint model...")
        load_inpaint()
        log("All models preloaded - server fully ready")
    except Exception as e:
        log(f"Preload error: {e}")
        import traceback
        traceback.print_exc()


def main():
    log(f"Starting SDXL server on http://{HOST}:{PORT}")
    server = HTTPServer((HOST, PORT), Handler)
    log("Server ready (loading models in background...)")
    sys.stdout.flush()

    # Preload models in background thread so first call is instant
    threading.Thread(target=preload_models, daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("Stopped")


if __name__ == "__main__":
    main()
