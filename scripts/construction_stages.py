"""Construction v4 = MODULAR scaffold. Generate ONE small scaffold bay (module) once,
then TILE it across the width and up to the current build level (add modules as the
building rises). Args: <src.png> <out_dir> <N>."""
import sys, os, numpy as np, torch, cv2
from PIL import Image
SRC, OUT = sys.argv[1], sys.argv[2]
N = int(sys.argv[3]) if len(sys.argv) > 3 else 4
os.makedirs(OUT, exist_ok=True)
DIM = 1024
src = Image.open(SRC).convert("RGBA").resize((DIM, DIM))
A = np.asarray(src).astype(np.uint8); rgb0, alpha0 = A[..., :3], A[..., 3]
H, W = DIM, DIM
rows = np.where((alpha0 > 16).any(1))[0]; Rtop, Rbase = int(rows.min()), int(rows.max())
xs_any = np.where((alpha0 > 16).any(0))[0]; X0, X1 = int(xs_any.min()), int(xs_any.max())
ys = np.arange(H, dtype=np.float32).reshape(H, 1)

# --- ControlNet guide for ONE scaffold bay (poles on the side edges, ledgers top/bottom,
# one diagonal). Poles on the edges → tiles connect pole-to-pole when overlapped. ---
MOD = 768
g = np.zeros((MOD, MOD), np.uint8); e = int(MOD * 0.05)
cv2.line(g, (e, 0), (e, MOD), 255, 7); cv2.line(g, (MOD - e, 0), (MOD - e, MOD), 255, 7)     # side standards
cv2.line(g, (0, e), (MOD, e), 255, 7); cv2.line(g, (0, MOD - e), (MOD, MOD - e), 255, 7)     # ledgers
cv2.line(g, (e, MOD - e), (MOD - e, e), 255, 5)                                              # diagonal brace
guide = Image.fromarray(np.stack([g] * 3, -1), "RGB")

print("[v4] loading + generating ONE module…", flush=True)
from diffusers import StableDiffusionXLControlNetPipeline, ControlNetModel, AutoencoderKL
cn = ControlNetModel.from_pretrained("diffusers/controlnet-canny-sdxl-1.0", torch_dtype=torch.float16)
vae = AutoencoderKL.from_pretrained("madebyollin/sdxl-vae-fp16-fix", torch_dtype=torch.float16)
pipe = StableDiffusionXLControlNetPipeline.from_pretrained(
    "SG161222/RealVisXL_V4.0", controlnet=cn, vae=vae, torch_dtype=torch.float16)
pipe.load_ip_adapter("h94/IP-Adapter", subfolder="sdxl_models", weight_name="ip-adapter_sdxl.safetensors")
pipe.set_ip_adapter_scale(0.4); pipe.enable_model_cpu_offload()
ipn = rgb0.astype(np.float32) * (alpha0[..., None] / 255.) + 255. * (1 - alpha0[..., None] / 255.)
ip_ref = Image.fromarray(ipn.clip(0, 255).astype(np.uint8), "RGB")
PROMPT = ("one section of wooden construction scaffolding, two vertical wooden poles, horizontal "
          "wooden planks and a diagonal wooden brace, isolated on plain white background, photorealistic")
NEG = "castle, building, stone wall, blurry, cartoon, toy, flat, mesh"
mod = pipe(prompt=PROMPT, negative_prompt=NEG, image=guide, ip_adapter_image=ip_ref,
           width=768, height=768, num_inference_steps=26, guidance_scale=5.0,
           controlnet_conditioning_scale=0.6, generator=torch.Generator("cuda").manual_seed(3)).images[0]
mrgb = np.asarray(mod.convert("RGB")).astype(np.float32)
warm = (mrgb[..., 0] - mrgb[..., 2]) > 12; bright = mrgb.max(2) > 45
ma = cv2.morphologyEx((warm & bright).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
mod_rgba = np.dstack([mrgb.astype(np.uint8), (ma * 255).astype(np.uint8)])
Image.fromarray(mod_rgba, "RGBA").save(os.path.join(OUT, "_module.png"))

# --- tile the module across [X0,X1] and up to a top level (overlap → poles merge) ---
TILE = max(80, int((X1 - X0) / 4))                       # ~4 bays wide
mA = np.asarray(Image.fromarray(mod_rgba, "RGBA").resize((TILE, TILE))).astype(np.float32)
OV = int(TILE * 0.12); STEP = TILE - OV

def build_scaffold(top_y):
    canvas = np.zeros((H, W, 4), np.float32)
    y = Rbase - TILE
    while y > top_y - TILE:
        x = X0 - OV
        while x < X1:
            y0, x0 = max(0, y), max(0, x); y1, x1 = min(H, y + TILE), min(W, x + TILE)
            th, tw = y1 - y0, x1 - x0
            if th > 0 and tw > 0:
                t = mA[y0 - y:y0 - y + th, x0 - x:x0 - x + tw]
                a = t[..., 3:4] / 255.0
                canvas[y0:y1, x0:x1, :3] = canvas[y0:y1, x0:x1, :3] * (1 - a) + t[..., :3] * a
                canvas[y0:y1, x0:x1, 3:4] = np.maximum(canvas[y0:y1, x0:x1, 3:4], t[..., 3:4])
            x += STEP
        y -= STEP
    return canvas

for i in range(N):
    prog = 1.0 if N <= 1 else i / (N - 1)
    if i == N - 1:
        src.save(os.path.join(OUT, f"stage_{i}.png")); continue
    keep = max(prog, 0.05)
    bline = Rbase - keep * (Rbase - Rtop)
    b_a = np.clip((ys - bline) / max(1., 0.02 * H), 0, 1) * (alpha0.astype(np.float32) / 255.)
    scaf = build_scaffold(int(bline - 0.04 * H))         # add module rows up to the build level
    sa = scaf[..., 3] / 255.0
    comp = rgb0.astype(np.float32) * b_a[..., None]
    comp = comp * (1 - sa[..., None]) + scaf[..., :3] * sa[..., None]
    out_a = (np.maximum(b_a, sa) * 255).astype(np.uint8)
    Image.fromarray(np.dstack([comp.clip(0, 255).astype(np.uint8), out_a]), "RGBA").save(
        os.path.join(OUT, f"stage_{i}.png"))
    print(f"[v4] stage {i}", flush=True)
print("DONE", OUT, flush=True)
