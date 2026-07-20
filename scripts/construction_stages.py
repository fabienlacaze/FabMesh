"""Construction stages v3 = COHERENT scaffold: generate ONE scaffold for the full
building, then REVEAL it progressively (same scaffold grows with the building).
Args: <src.png> <out_dir> <N>. 1 SDXL call total → faster + consistent across stages."""
import sys, os, numpy as np, torch, cv2
from PIL import Image
SRC, OUT = sys.argv[1], sys.argv[2]
N = int(sys.argv[3]) if len(sys.argv) > 3 else 4
os.makedirs(OUT, exist_ok=True)
DIM = 1024
src = Image.open(SRC).convert("RGBA").resize((DIM, DIM))
A = np.asarray(src).astype(np.uint8); rgb0, alpha0 = A[..., :3], A[..., 3]
H, W = DIM, DIM
rows = np.where((alpha0 > 16).any(axis=1))[0]; Rtop, Rbase = int(rows.min()), int(rows.max())
ys = np.arange(H, dtype=np.float32).reshape(H, 1)

# --- silhouette (dilated + extended up) + clip region from the FULL building ---
am = (alpha0 > 16).astype(np.uint8) * 255
k = max(3, int(0.045 * DIM)) | 1
amd = cv2.dilate(am, np.ones((k, k), np.uint8), 1)
upE = max(1, int(0.09 * DIM))
# ControlNet guide = a DRAWN scaffold grid spanning the FULL building width (poles +
# ledgers + diagonals). SDXL renders photoreal wood on this grid → I control the width
# and layout, SDXL controls the realism. Fixes the too-narrow central scaffold.
xs_any = np.where(amd.max(0) > 0)[0]
x0, x1 = int(xs_any.min()), int(xs_any.max())
ytop = max(0, Rtop - upE); ybot = min(H - 1, Rbase)
grid = np.zeros((H, W), np.uint8)
# SPARSE guide only (a few standards + 2-3 ledgers, NO diagonals) so SDXL follows the
# full WIDTH but still IMAGINES a real volumetric 3D scaffold (with its own bracing/depth)
# instead of tracing a flat rigid mesh. Low controlnet scale keeps it organic.
bay = max(60, int((x1 - x0) / 4)); lift = max(60, int((ybot - ytop) / 3))
xs_p = list(range(x0, x1 + 1, bay)) + [x1]; ys_l = list(range(ytop, ybot + 1, lift)) + [ybot]
for x in xs_p: cv2.line(grid, (x, ytop), (x, ybot), 255, 4)                 # a few vertical standards
for y in ys_l: cv2.line(grid, (x0, y), (x1, y), 255, 4)                     # a few horizontal ledgers
sil = Image.fromarray(np.stack([grid] * 3, -1), "RGB")
cols = (amd.max(0) > 0).reshape(1, W).astype(np.float32)
clip = np.zeros((H, W), np.float32); clip[: min(H, Rbase + int(0.03 * H)), :] = cols

# --- pipeline (RealVisXL + ControlNet + IP-Adapter for style) → ONE scaffold ---
print("[v3] loading pipeline…", flush=True)
from diffusers import StableDiffusionXLControlNetPipeline, ControlNetModel, AutoencoderKL
cn = ControlNetModel.from_pretrained("diffusers/controlnet-canny-sdxl-1.0", torch_dtype=torch.float16)
vae = AutoencoderKL.from_pretrained("madebyollin/sdxl-vae-fp16-fix", torch_dtype=torch.float16)
pipe = StableDiffusionXLControlNetPipeline.from_pretrained(
    "SG161222/RealVisXL_V4.0", controlnet=cn, vae=vae, torch_dtype=torch.float16)
pipe.load_ip_adapter("h94/IP-Adapter", subfolder="sdxl_models", weight_name="ip-adapter_sdxl.safetensors")
pipe.set_ip_adapter_scale(0.45); pipe.enable_model_cpu_offload()
ipn = rgb0.astype(np.float32) * (alpha0[..., None] / 255.) + 255. * (1 - alpha0[..., None] / 255.)
ip_ref = Image.fromarray(ipn.clip(0, 255).astype(np.uint8), "RGB")
PROMPT = ("dense wooden construction scaffolding structure wrapping the building, lattice of "
          "vertical wooden poles and horizontal planks and walkways, diagonal cross-braces, "
          "wooden treadwheel crane, isolated on plain white background, photorealistic, detailed")
NEG = "castle, stone building, wall, blurry, low quality, flat, cartoon, toy, solid wall"
print("[v3] generating the single coherent scaffold…", flush=True)
scaf = pipe(prompt=PROMPT, negative_prompt=NEG, image=sil, ip_adapter_image=ip_ref,
            num_inference_steps=26, guidance_scale=5.5, controlnet_conditioning_scale=0.4,
            generator=torch.Generator("cuda").manual_seed(3)).images[0]
s = np.asarray(scaf.resize((DIM, DIM)).convert("RGB")).astype(np.float32)
# wood-colour key → isolate the scaffold; clip to building columns (top→base)
warm = (s[..., 0] - s[..., 2]) > 12; bright = s.max(2) > 45
wood = cv2.morphologyEx((warm & bright).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
wood = cv2.morphologyEx(wood, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
n, lab, st, _ = cv2.connectedComponentsWithStats(wood, 8); keep = np.zeros_like(wood)
for c in range(1, n):
    if st[c, cv2.CC_STAT_AREA] > 0.0006 * wood.size: keep[lab == c] = 1
wood_mask = keep.astype(np.float32) * clip                      # the ONE scaffold, isolated

# --- per stage: reveal building + reveal the SAME scaffold up to the build level ---
for i in range(N):
    prog = 1.0 if N <= 1 else i / (N - 1)
    if i == N - 1:
        src.save(os.path.join(OUT, f"stage_{i}.png")); continue
    keep_i = max(prog, 0.05)
    bline = Rbase - keep_i * (Rbase - Rtop)
    b_a = np.clip((ys - bline) / max(1.0, 0.02 * H), 0, 1) * (alpha0.astype(np.float32) / 255.0)
    # scaffold built PROGRESSIVELY with the building: reveal the SAME scaffold up to
    # ~the current build level, with a GENEROUS feather at the top so the poles taper
    # off (being erected) instead of a hard slice. Same scaffold → coherent; it grows
    # stage by stage → credible ("built little by little during construction").
    s_line = bline - 0.04 * H                       # scaffold reaches a bit above the build line
    s_a = wood_mask * np.clip((ys - s_line) / max(1.0, 0.11 * H), 0.0, 1.0)
    comp = rgb0.astype(np.float32) * b_a[..., None]
    comp = comp * (1 - s_a[..., None]) + s * s_a[..., None]
    out_a = (np.maximum(b_a, s_a) * 255).astype(np.uint8)
    Image.fromarray(np.dstack([comp.clip(0, 255).astype(np.uint8), out_a]), "RGBA").save(
        os.path.join(OUT, f"stage_{i}.png"))
    print(f"[v3] stage {i} (keep={keep_i:.2f})", flush=True)
print("DONE", OUT, flush=True)
