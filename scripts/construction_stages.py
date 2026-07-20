"""Construction v5 = MODULAR scaffold with VARIATIONS. Generate several module variants
(diagonal / X-brace / ladder / platform — same edge poles so they tile), then place a
deterministic mix per position (stable across stages). Args: <src.png> <out_dir> <N>."""
import sys, os, numpy as np, torch, cv2
from PIL import Image
SRC, OUT = sys.argv[1], sys.argv[2]
N = int(sys.argv[3]) if len(sys.argv) > 3 else 4
os.makedirs(OUT, exist_ok=True)
DIM = 1024
src = Image.open(SRC).convert("RGBA").resize((DIM, DIM))
A = np.asarray(src).astype(np.uint8); rgb0, alpha0 = A[..., :3], A[..., 3]
H, W = DIM, DIM
# Robust BUILDING mask: use the alpha channel when the image is really transparent,
# else key out the (opaque) background colour from the corners. Without this an opaque
# black-bg image reads as "building everywhere" → scaffold covers the whole frame.
if int(alpha0.min()) < 200:
    build_alpha = alpha0.astype(np.float32)
else:
    corners = np.concatenate([rgb0[:8, :8].reshape(-1, 3), rgb0[:8, -8:].reshape(-1, 3),
                              rgb0[-8:, :8].reshape(-1, 3), rgb0[-8:, -8:].reshape(-1, 3)])
    bgc = np.median(corners, axis=0)
    m = (np.abs(rgb0.astype(np.float32) - bgc.reshape(1, 1, 3)).max(2) > 30).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((11, 11), np.uint8))
    build_alpha = (m * 255).astype(np.float32)
# Tight bbox on the SOLID building so the scaffold's bounds/base match the visible
# building — no side overshoot, base aligned.
solid = build_alpha > 128
rows = np.where(solid.any(1))[0]; Rtop, Rbase = int(rows.min()), int(rows.max())
xs_any = np.where(solid.any(0))[0]; X0, X1 = int(xs_any.min()), int(xs_any.max())
ys = np.arange(H, dtype=np.float32).reshape(H, 1)
# Keep the scaffold WITHIN the building bounds: x in [X0,X1] (no horizontal overshoot
# off the frame) and rows down to the building base Rbase (base aligned with building).
clip = np.zeros((H, W), np.float32)
clip[: min(H, Rbase + int(0.008 * H)), X0: X1 + 1] = 1.0
MOD = 768

def guide(kind):
    g = np.zeros((MOD, MOD), np.uint8); e = int(MOD * 0.05)
    cv2.line(g, (e, 0), (e, MOD), 255, 7); cv2.line(g, (MOD - e, 0), (MOD - e, MOD), 255, 7)   # side standards (shared → tiles connect)
    cv2.line(g, (0, e), (MOD, e), 255, 7); cv2.line(g, (0, MOD - e), (MOD, MOD - e), 255, 7)   # ledgers
    if kind == "diag":
        cv2.line(g, (e, MOD - e), (MOD - e, e), 255, 5)
    elif kind == "x":
        cv2.line(g, (e, MOD - e), (MOD - e, e), 255, 5); cv2.line(g, (e, e), (MOD - e, MOD - e), 255, 5)
    elif kind == "ladder":
        a, b = int(MOD * 0.4), int(MOD * 0.6)
        cv2.line(g, (a, e), (a, MOD - e), 255, 5); cv2.line(g, (b, e), (b, MOD - e), 255, 5)
        for yy in range(e, MOD - e, int(MOD * 0.11)): cv2.line(g, (a, yy), (b, yy), 255, 4)
    elif kind == "platform":
        cv2.line(g, (0, MOD // 2), (MOD, MOD // 2), 255, 12)                                   # a working deck
        cv2.line(g, (e, MOD // 2), (e, e), 255, 4); cv2.line(g, (MOD - e, MOD // 2), (MOD - e, e), 255, 4)
    return Image.fromarray(np.stack([g] * 3, -1), "RGB")

print("[v5] loading pipeline…", flush=True)
from diffusers import StableDiffusionXLControlNetPipeline, ControlNetModel, AutoencoderKL
cn = ControlNetModel.from_pretrained("diffusers/controlnet-canny-sdxl-1.0", torch_dtype=torch.float16)
vae = AutoencoderKL.from_pretrained("madebyollin/sdxl-vae-fp16-fix", torch_dtype=torch.float16)
pipe = StableDiffusionXLControlNetPipeline.from_pretrained(
    "SG161222/RealVisXL_V4.0", controlnet=cn, vae=vae, torch_dtype=torch.float16)
pipe.load_ip_adapter("h94/IP-Adapter", subfolder="sdxl_models", weight_name="ip-adapter_sdxl.safetensors")
pipe.set_ip_adapter_scale(0.4); pipe.enable_model_cpu_offload()
ipn = rgb0.astype(np.float32) * (build_alpha[..., None] / 255.) + 255. * (1 - build_alpha[..., None] / 255.)
ip_ref = Image.fromarray(ipn.clip(0, 255).astype(np.uint8), "RGB")
PROMPT = ("one section of wooden construction scaffolding, vertical wooden poles and horizontal "
          "wooden planks with a wooden brace, isolated on plain white background, photorealistic")
NEG = "castle, building, stone wall, blurry, cartoon, toy, flat, mesh"

TILE = max(50, int((X1 - X0) / 9))     # ~9 bays across → module scale matches the building
KINDS = ["diag", "x", "ladder", "platform"]
mods = []
for ki, kind in enumerate(KINDS):
    print(f"[v5] module {kind}…", flush=True)
    im = pipe(prompt=PROMPT, negative_prompt=NEG, image=guide(kind), ip_adapter_image=ip_ref,
              width=768, height=768, num_inference_steps=24, guidance_scale=5.0,
              controlnet_conditioning_scale=0.6, generator=torch.Generator("cuda").manual_seed(3 + ki)).images[0]
    r = np.asarray(im.convert("RGB")).astype(np.float32)
    ma = cv2.morphologyEx((((r[..., 0] - r[..., 2]) > 12) & (r.max(2) > 45)).astype(np.uint8),
                          cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    rgba = np.dstack([r.astype(np.uint8), (ma * 255).astype(np.uint8)])
    Image.fromarray(rgba, "RGBA").save(os.path.join(OUT, f"_mod_{kind}.png"))
    mods.append(np.asarray(Image.fromarray(rgba, "RGBA").resize((TILE, TILE))).astype(np.float32))

OV = int(TILE * 0.12); STEP = TILE - OV
def pick(r, c): return (c * 13 + 1) % len(mods)              # variant per COLUMN → ladders/braces run continuously top-to-bottom (vertically aligned)

def build_scaffold(top_y):
    canvas = np.zeros((H, W, 4), np.float32); r = 0; y = Rbase - TILE
    while y > top_y - TILE:
        c = 0; x = X0 - OV
        while x < X1:
            t = mods[pick(r, c)]
            y0, x0 = max(0, y), max(0, x); y1, x1 = min(H, y + TILE), min(W, x + TILE)
            th, tw = y1 - y0, x1 - x0
            if th > 0 and tw > 0:
                tt = t[y0 - y:y0 - y + th, x0 - x:x0 - x + tw]; a = tt[..., 3:4] / 255.0
                canvas[y0:y1, x0:x1, :3] = canvas[y0:y1, x0:x1, :3] * (1 - a) + tt[..., :3] * a
                canvas[y0:y1, x0:x1, 3:4] = np.maximum(canvas[y0:y1, x0:x1, 3:4], tt[..., 3:4])
            c += 1; x += STEP
        r += 1; y -= STEP
    return canvas

for i in range(N):
    prog = 1.0 if N <= 1 else i / (N - 1)
    if i == N - 1:
        src.save(os.path.join(OUT, f"stage_{i}.png")); continue
    keep = max(prog, 0.05); bline = Rbase - keep * (Rbase - Rtop)
    b_a = np.clip((ys - bline) / max(1., 0.02 * H), 0, 1) * (build_alpha / 255.)
    scaf = build_scaffold(int(bline - 0.04 * H)); sa = (scaf[..., 3] / 255.0) * clip
    comp = rgb0.astype(np.float32) * b_a[..., None]
    comp = comp * (1 - sa[..., None]) + scaf[..., :3] * sa[..., None]
    out_a = (np.maximum(b_a, sa) * 255).astype(np.uint8)
    Image.fromarray(np.dstack([comp.clip(0, 255).astype(np.uint8), out_a]), "RGBA").save(
        os.path.join(OUT, f"stage_{i}.png"))
    print(f"[v5] stage {i}", flush=True)
print("DONE", OUT, flush=True)
