"""
FabMesh SDXL Persistent Server
Keeps SDXL Turbo img2img + SDXL Inpainting + CLIPSeg in memory
to avoid 5-10s reload per call.

Listens on 127.0.0.1:5555 via simple HTTP/JSON.

Endpoints:
  GET  /ping              - health check + model status
  GET  /status            - detailed model + GPU status
  POST /img2img           - { input, prompt, output, strength }
  POST /inpaint           - { input, target, prompt, output, dilate }
  POST /shutdown          - graceful exit
  POST /unload            - free a specific model from VRAM
"""
import os
import sys
import json
import time
import gc
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Faster startup: only import what we need at top
import torch
from PIL import Image, ImageFilter
import numpy as np

# ========== CONFIG ==========
HOST = '127.0.0.1'
PORT = 5555
# img2img: RealVis XL V4.0 — CreativeML Open RAIL++-M (commercial-safe).
# We previously used stabilityai/sdxl-turbo which is under the SAI Non-Commercial
# Research License, disqualifying it from a Steam release. RealVis XL shares the
# same SDXL architecture so StableDiffusionXLImg2ImgPipeline loads it unchanged.
IMG2IMG_MODEL = "SG161222/RealVisXL_V4.0"
# Back-compat alias (some older code paths still reference the old name).
SDXL_TURBO_MODEL = IMG2IMG_MODEL
SDXL_INPAINT_MODEL = "diffusers/stable-diffusion-xl-1.0-inpainting-0.1"
CLIPSEG_MODEL = "CIDAS/clipseg-rd64-refined"

# Enforce VRAM cap from FabMesh settings (passed via FABMESH_VRAM_FRACTION env var).
GPU_MEMORY_FRACTION = float(os.environ.get('FABMESH_VRAM_FRACTION', '0.95'))
if torch.cuda.is_available() and 0.1 <= GPU_MEMORY_FRACTION < 1.0:
    try:
        torch.cuda.set_per_process_memory_fraction(GPU_MEMORY_FRACTION)
        print(f"SDXL_SERVER: VRAM hard cap set to {GPU_MEMORY_FRACTION*100:.0f}%", flush=True)
    except Exception as e:
        print(f"SDXL_SERVER: Could not set VRAM cap ({e})", flush=True)


# Enforce system RAM limit from FabMesh settings (FABMESH_RAM_LIMIT_MB env var).
_RAM_LIMIT_MB = os.environ.get('FABMESH_RAM_LIMIT_MB', '')
if _RAM_LIMIT_MB:
    try:
        import psutil
        _vm = psutil.virtual_memory()
        print(f"SDXL_SERVER: RAM system used={(_vm.total - _vm.available) / (1024**2):.0f}MB, "
              f"limit={_RAM_LIMIT_MB}MB, percent={_vm.percent:.0f}%", flush=True)
    except ImportError:
        print("SDXL_SERVER: psutil not installed, RAM monitoring skipped", flush=True)
    except Exception as e:
        print(f"SDXL_SERVER: RAM check error: {e}", flush=True)

# ========== STATE ==========
class ModelState:
    """Holds all loaded models and their locks."""
    def __init__(self):
        self.img2img_pipe = None
        self.inpaint_pipe = None
        self.clipseg_model = None
        self.clipseg_processor = None
        self.load_lock = threading.RLock()    # Reentrant - same thread can load multiple
        self.inference_lock = threading.Lock()  # Serialize GPU calls
        self.last_use = {}                     # model_name -> timestamp


state = ModelState()


def log(msg, level='info'):
    prefix = {'info': '[SDXL]', 'err': '[SDXL ERR]', 'warn': '[SDXL WARN]'}.get(level, '[SDXL]')
    print(f"{prefix} {msg}", flush=True)


def vram_used_gb():
    if not torch.cuda.is_available():
        return 0.0
    return torch.cuda.memory_allocated() / 1024**3


def vram_total_gb():
    if not torch.cuda.is_available():
        return 0.0
    return torch.cuda.get_device_properties(0).total_memory / 1024**3


def free_vram():
    """Aggressive VRAM cleanup."""
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.synchronize()


# ========== MODEL LOADING ==========
def _set_memory_fraction():
    # No-op: see GPU_MEMORY_FRACTION comment above. Kept so existing call sites
    # (load_img2img, load_inpaint) don't need to be touched.
    pass


def load_img2img():
    """Lazy-load SDXL Turbo img2img pipeline."""
    if state.img2img_pipe is not None:
        state.last_use['img2img'] = time.time()
        return state.img2img_pipe

    with state.load_lock:
        if state.img2img_pipe is not None:
            return state.img2img_pipe
        log(f"Loading {IMG2IMG_MODEL}...")
        _set_memory_fraction()
        from diffusers import StableDiffusionXLImg2ImgPipeline
        t0 = time.time()
        # RealVis XL V4.0 doesn't ship an fp16 variant branch — ask for fp16 dtype
        # but omit variant="fp16" so the loader grabs the default safetensors.
        pipe = StableDiffusionXLImg2ImgPipeline.from_pretrained(
            IMG2IMG_MODEL,
            torch_dtype=torch.float16,
            use_safetensors=True,
        )
        pipe.to("cuda")
        pipe.enable_attention_slicing()
        pipe.enable_vae_tiling()
        # Disable safety checker if present (we're local single user)
        if hasattr(pipe, 'safety_checker'):
            pipe.safety_checker = None
        state.img2img_pipe = pipe
        state.last_use['img2img'] = time.time()
        log(f"img2img loaded in {time.time()-t0:.1f}s ({vram_used_gb():.1f} GB VRAM)")
    return state.img2img_pipe


def load_inpaint():
    """Lazy-load SDXL Inpainting + CLIPSeg."""
    if state.inpaint_pipe is not None and state.clipseg_model is not None:
        state.last_use['inpaint'] = time.time()
        return state.inpaint_pipe

    with state.load_lock:
        # CLIPSeg first (small model, ~400 MB)
        if state.clipseg_model is None:
            log(f"Loading {CLIPSEG_MODEL}...")
            from transformers import CLIPSegForImageSegmentation, CLIPSegProcessor
            t0 = time.time()
            state.clipseg_processor = CLIPSegProcessor.from_pretrained(CLIPSEG_MODEL)
            state.clipseg_model = CLIPSegForImageSegmentation.from_pretrained(CLIPSEG_MODEL)
            state.clipseg_model.to("cuda")
            state.clipseg_model.eval()
            log(f"CLIPSeg loaded in {time.time()-t0:.1f}s")

        # SDXL Inpainting (large model, ~6 GB)
        if state.inpaint_pipe is None:
            log(f"Loading {SDXL_INPAINT_MODEL}...")
            _set_memory_fraction()
            from diffusers import StableDiffusionXLInpaintPipeline
            t0 = time.time()
            pipe = StableDiffusionXLInpaintPipeline.from_pretrained(
                SDXL_INPAINT_MODEL,
                torch_dtype=torch.float16,
                variant="fp16",
            )
            pipe.to("cuda")
            pipe.enable_attention_slicing()
            pipe.enable_vae_tiling()
            if hasattr(pipe, 'safety_checker'):
                pipe.safety_checker = None
            state.inpaint_pipe = pipe
            state.last_use['inpaint'] = time.time()
            log(f"Inpaint loaded in {time.time()-t0:.1f}s ({vram_used_gb():.1f} GB VRAM)")
    return state.inpaint_pipe


def unload_model(name):
    """Free a model from VRAM. name in ('img2img', 'inpaint', 'clipseg')."""
    with state.load_lock:
        before = vram_used_gb()
        if name == 'img2img' and state.img2img_pipe is not None:
            del state.img2img_pipe
            state.img2img_pipe = None
        elif name == 'inpaint' and state.inpaint_pipe is not None:
            del state.inpaint_pipe
            state.inpaint_pipe = None
        elif name == 'clipseg' and state.clipseg_model is not None:
            del state.clipseg_model
            del state.clipseg_processor
            state.clipseg_model = None
            state.clipseg_processor = None
        free_vram()
        log(f"Unloaded {name} - VRAM {before:.1f} -> {vram_used_gb():.1f} GB")


# ========== IMAGE HELPERS ==========
def resize_for_sdxl(img, max_dim=1024, snap_to_8=True):
    """Resize keeping aspect ratio so longer side = max_dim, dimensions multiple of 8."""
    w, h = img.size
    if max(w, h) > max_dim:
        if w >= h:
            new_w, new_h = max_dim, int(h * max_dim / w)
        else:
            new_h, new_w = max_dim, int(w * max_dim / h)
    else:
        new_w, new_h = w, h
    if snap_to_8:
        new_w = max(8, (new_w // 8) * 8)
        new_h = max(8, (new_h // 8) * 8)
    return img.resize((new_w, new_h), Image.LANCZOS), (new_w, new_h)


def save_debug_mask(output_path, mask_img):
    """Save mask in .debug/ subfolder so it doesn't appear in the gallery."""
    try:
        debug_dir = os.path.join(os.path.dirname(output_path), ".debug")
        os.makedirs(debug_dir, exist_ok=True)
        base = os.path.basename(output_path)
        name = base.rsplit('.', 1)[0] + '_mask.png'
        path = os.path.join(debug_dir, name)
        mask_img.save(path)
        return path
    except Exception:
        return None


# ========== INFERENCE ==========
def do_img2img(input_path, prompt, output_path, strength=0.55):
    if not os.path.exists(input_path):
        return {"ok": False, "error": f"Input not found: {input_path}"}

    # Only one SDXL pipeline at a time — RealVis img2img (~6 GB) + SDXL Inpaint
    # (~6 GB) together saturate a 16 GB card and force NVIDIA driver shared-mem
    # fallback, making every step 10x slower. Unload the other pipeline first.
    if state.inpaint_pipe is not None:
        unload_model('inpaint')

    pipe = load_img2img()
    state.last_use['img2img'] = time.time()

    with state.inference_lock:
        try:
            img = Image.open(input_path).convert("RGB")
            img, (w, h) = resize_for_sdxl(img, max_dim=1024)

            enhanced = f"{prompt}, high quality, detailed"
            s = max(0.1, min(1.0, float(strength)))
            # RealVis XL V4.0: standard SDXL fine-tune, likes 25-30 steps + CFG 5-7.
            # num_inference_steps * strength must be >= 1 (same diffusers rule
            # as Turbo, but with higher base step count).
            steps = max(int(round(25 / s)), int(round(1 / s)) + 1)
            steps = min(steps, 60)  # safety upper bound

            t0 = time.time()
            with torch.inference_mode():
                result = pipe(
                    prompt=enhanced,
                    image=img,
                    strength=s,
                    num_inference_steps=steps,
                    guidance_scale=6.0,
                ).images[0]

            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            result.save(output_path)
            elapsed = time.time() - t0
            log(f"img2img done in {elapsed:.1f}s ({steps} steps, {w}x{h}) -> {output_path}")
            return {"ok": True, "output": output_path, "time": elapsed, "size": [w, h]}
        except Exception as e:
            log(f"img2img error: {e}", 'err')
            traceback.print_exc()
            free_vram()
            return {"ok": False, "error": str(e)}


def do_inpaint(input_path, target_text, prompt, output_path, dilate=15):
    if not os.path.exists(input_path):
        return {"ok": False, "error": f"Input not found: {input_path}"}
    if not target_text or not target_text.strip():
        return {"ok": False, "error": "target_text required"}

    # Only one SDXL pipeline at a time — see do_img2img comment.
    if state.img2img_pipe is not None:
        unload_model('img2img')

    pipe = load_inpaint()
    state.last_use['inpaint'] = time.time()

    with state.inference_lock:
        try:
            img = Image.open(input_path).convert("RGB")
            orig_size = img.size
            img_work, (work_w, work_h) = resize_for_sdxl(img, max_dim=1024)

            t0 = time.time()

            # === Step 1: CLIPSeg segmentation ===
            inputs = state.clipseg_processor(
                text=[target_text.strip()],
                images=[img_work],
                padding=True,
                return_tensors="pt"
            )
            inputs = {k: v.to("cuda") for k, v in inputs.items()}
            with torch.inference_mode():
                seg_out = state.clipseg_model(**inputs)

            mask_logits = seg_out.logits.squeeze().detach().cpu().numpy()
            mask_prob = 1 / (1 + np.exp(-mask_logits))  # sigmoid
            mask_uint8 = (mask_prob * 255).astype(np.uint8)

            mask_img = Image.fromarray(mask_uint8).resize((work_w, work_h), Image.BILINEAR)
            mask_arr = np.array(mask_img)
            binary = (mask_arr > 100).astype(np.uint8) * 255
            mask_binary = Image.fromarray(binary, mode="L")

            # Dilate mask for context blending
            d = max(0, int(dilate))
            if d > 0:
                mask_binary = mask_binary.filter(ImageFilter.MaxFilter(d * 2 + 1))
            mask_binary = mask_binary.filter(ImageFilter.GaussianBlur(3))

            coverage = (np.array(mask_binary) > 128).mean() * 100
            if coverage < 0.5:
                return {"ok": False, "error": f"Target '{target_text}' not detected (coverage {coverage:.1f}%)"}
            if coverage > 80:
                log(f"WARNING: mask covers {coverage:.0f}% of image", 'warn')

            save_debug_mask(output_path, mask_binary)

            # === Step 2: SDXL Inpainting ===
            inpaint_prompt = (prompt or "").strip()
            removal_keywords = ("", "remove", "delete", "none", "nothing", "empty", "gone")
            is_removal = inpaint_prompt.lower() in removal_keywords

            if is_removal:
                inpaint_prompt = "continuation of the surrounding area, same background, seamless"
                negative_prompt = f"{target_text}, any object, duplicate, artifact, blurry, distorted, deformed"
            else:
                negative_prompt = f"blurry, distorted, duplicate, deformed, low quality, {target_text}"

            with torch.inference_mode():
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

            # Restore original resolution if needed
            if (work_w, work_h) != orig_size:
                result = result.resize(orig_size, Image.LANCZOS)

            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            result.save(output_path)

            elapsed = time.time() - t0
            log(f"inpaint done in {elapsed:.1f}s ({coverage:.0f}% mask) -> {output_path}")
            return {
                "ok": True,
                "output": output_path,
                "time": elapsed,
                "mask_coverage": round(coverage, 1)
            }
        except Exception as e:
            log(f"inpaint error: {e}", 'err')
            traceback.print_exc()
            free_vram()
            return {"ok": False, "error": str(e)}


def do_mask_inpaint(input_path, mask_path, prompt, output_path):
    """Inpaint using a user-provided mask (white = inpaint, black = keep)."""
    if not os.path.exists(input_path):
        return {"ok": False, "error": f"Input not found: {input_path}"}
    if not os.path.exists(mask_path):
        return {"ok": False, "error": f"Mask not found: {mask_path}"}

    # Only one SDXL pipeline at a time — see do_img2img comment above.
    # Unload img2img before loading inpaint so we stay under 16 GB VRAM.
    if state.img2img_pipe is not None:
        unload_model('img2img')

    pipe = load_inpaint()
    state.last_use['inpaint'] = time.time()

    with state.inference_lock:
        try:
            img = Image.open(input_path).convert("RGB")
            orig_size = img.size
            img_work, (work_w, work_h) = resize_for_sdxl(img, max_dim=1024)

            mask = Image.open(mask_path).convert("L").resize((work_w, work_h), Image.BILINEAR)
            mask = mask.filter(ImageFilter.GaussianBlur(3))

            coverage = (np.array(mask) > 128).mean() * 100
            if coverage < 0.1:
                return {"ok": False, "error": "Mask is empty"}

            save_debug_mask(output_path, mask)

            inpaint_prompt = (prompt or "").strip()
            removal_keywords = ("", "remove", "delete", "none", "nothing", "empty", "gone")
            is_removal = inpaint_prompt.lower() in removal_keywords
            if is_removal:
                inpaint_prompt = "continuation of the surrounding area, same background, seamless"
                negative_prompt = "any object, duplicate, artifact, blurry, distorted, deformed"
            else:
                negative_prompt = "blurry, distorted, duplicate, deformed, low quality"

            t0 = time.time()
            with torch.inference_mode():
                result = pipe(
                    prompt=inpaint_prompt,
                    negative_prompt=negative_prompt,
                    image=img_work,
                    mask_image=mask,
                    num_inference_steps=40,
                    guidance_scale=8.5,
                    strength=0.99,
                    height=work_h,
                    width=work_w,
                ).images[0]

            if (work_w, work_h) != orig_size:
                result = result.resize(orig_size, Image.LANCZOS)
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            result.save(output_path)

            elapsed = time.time() - t0
            log(f"mask_inpaint done in {elapsed:.1f}s ({coverage:.0f}% mask) -> {output_path}")
            return {"ok": True, "output": output_path, "time": elapsed, "mask_coverage": round(coverage, 1)}
        except Exception as e:
            log(f"mask_inpaint error: {e}", 'err')
            traceback.print_exc()
            free_vram()
            return {"ok": False, "error": str(e)}


# ========== HTTP HANDLER ==========
class Handler(BaseHTTPRequestHandler):
    # Suppress default request logging
    def log_message(self, format, *args):
        pass

    def _json_response(self, code, data):
        try:
            body = json.dumps(data, ensure_ascii=False).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # client gone

    def do_GET(self):
        if self.path == '/ping':
            self._json_response(200, {
                "ok": True,
                "status": "ready",
                "models": {
                    "img2img": state.img2img_pipe is not None,
                    "inpaint": state.inpaint_pipe is not None,
                    "clipseg": state.clipseg_model is not None,
                },
                "vram_gb": round(vram_used_gb(), 2),
            })
        elif self.path == '/status':
            self._json_response(200, {
                "ok": True,
                "models_loaded": {
                    "img2img": state.img2img_pipe is not None,
                    "inpaint": state.inpaint_pipe is not None,
                    "clipseg": state.clipseg_model is not None,
                },
                "last_use": state.last_use,
                "vram_used_gb": round(vram_used_gb(), 2),
                "vram_total_gb": round(vram_total_gb(), 2),
                "vram_free_gb": round(vram_total_gb() - vram_used_gb(), 2),
            })
        else:
            self._json_response(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            if length == 0:
                data = {}
            else:
                raw = self.rfile.read(length)
                data = json.loads(raw.decode('utf-8'))
        except Exception as e:
            self._json_response(400, {"ok": False, "error": f"bad json: {e}"})
            return

        try:
            if self.path == '/img2img':
                if 'input' not in data or 'output' not in data:
                    self._json_response(400, {"ok": False, "error": "missing input/output"})
                    return
                result = do_img2img(
                    data['input'],
                    data.get('prompt', ''),
                    data['output'],
                    data.get('strength', 0.55),
                )
                self._json_response(200 if result.get('ok') else 500, result)

            elif self.path == '/inpaint':
                if 'input' not in data or 'output' not in data or 'target' not in data:
                    self._json_response(400, {"ok": False, "error": "missing input/output/target"})
                    return
                result = do_inpaint(
                    data['input'],
                    data['target'],
                    data.get('prompt', ''),
                    data['output'],
                    data.get('dilate', 15),
                )
                self._json_response(200 if result.get('ok') else 500, result)

            elif self.path == '/mask_inpaint':
                if 'input' not in data or 'output' not in data or 'mask' not in data:
                    self._json_response(400, {"ok": False, "error": "missing input/output/mask"})
                    return
                result = do_mask_inpaint(
                    data['input'],
                    data['mask'],
                    data.get('prompt', ''),
                    data['output'],
                )
                self._json_response(200 if result.get('ok') else 500, result)

            elif self.path == '/unload':
                model_name = data.get('model', '')
                if model_name in ('img2img', 'inpaint', 'clipseg'):
                    unload_model(model_name)
                    self._json_response(200, {"ok": True, "vram_gb": round(vram_used_gb(), 2)})
                else:
                    self._json_response(400, {"ok": False, "error": "model must be img2img/inpaint/clipseg"})

            elif self.path == '/shutdown':
                self._json_response(200, {"ok": True, "bye": True})
                log("Shutdown requested")
                threading.Thread(target=lambda: (time.sleep(0.3), os._exit(0)), daemon=True).start()

            else:
                self._json_response(404, {"ok": False, "error": "not found"})

        except Exception as e:
            log(f"handler error: {e}", 'err')
            traceback.print_exc()
            self._json_response(500, {"ok": False, "error": str(e)})


# ========== STARTUP ==========
def preload_models():
    """Preload only img2img model (most common). Inpaint loads on demand."""
    try:
        log("Preloading RealVis XL img2img...")
        load_img2img()
        log("MODELS READY - img2img loaded (inpaint on first use)")
    except Exception as e:
        log(f"Preload failed: {e}", 'err')
        traceback.print_exc()


def main():
    log(f"Starting on http://{HOST}:{PORT}")
    log(f"Python {sys.version.split()[0]} | torch {torch.__version__}")
    if torch.cuda.is_available():
        log(f"GPU: {torch.cuda.get_device_name(0)} ({vram_total_gb():.1f} GB)")
    else:
        log("WARNING: No CUDA GPU detected", 'warn')

    server = ThreadingHTTPServer((HOST, PORT), Handler)
    log("HTTP server listening (loading models in background...)")

    # Preload in background so first call is instant
    threading.Thread(target=preload_models, daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("Stopped (Ctrl+C)")
    finally:
        free_vram()


if __name__ == "__main__":
    main()
