"""Construction stages v2 = reveal (building rises, exact) + REAL scaffold per stage
(silhouette-only ControlNet), composited. Args: <src.png> <out_dir> <N>.
Loads SDXL+ControlNet ONCE, loops stages. stage_0=site … stage_{N-1}=exact final."""
import sys, os, numpy as np, torch
from PIL import Image
SRC, OUT = sys.argv[1], sys.argv[2]
N = int(sys.argv[3]) if len(sys.argv) > 3 else 4
os.makedirs(OUT, exist_ok=True)
DIM = 1024
src = Image.open(SRC).convert("RGBA").resize((DIM, DIM))
A = np.asarray(src).astype(np.uint8)
rgb0, alpha0 = A[..., :3], A[..., 3]
H, W = DIM, DIM
rows = np.where((alpha0 > 16).any(axis=1))[0]
Rtop, Rbase = int(rows.min()), int(rows.max())
ys = np.arange(H, dtype=np.float32).reshape(H, 1)

def reveal(keep):
    line = Rbase - keep * (Rbase - Rtop)
    a = np.clip((ys - line) / max(1.0, 0.02 * H), 0.0, 1.0)
    return (alpha0.astype(np.float32) * a).astype(np.uint8)   # revealed alpha

def silhouette(al):
    # GROW the building shape ~4.5% → scaffold overhangs a little (user: "dépasser
    # un peu"). Returns the canny outline AND the grown filled region used to CLIP
    # the scaffold (so SDXL's invented floor/sky/outside-bg is discarded).
    am = (al > 16).astype(np.uint8) * 255
    try:
        import cv2
        k = max(3, int(0.045 * DIM)) | 1
        amd = cv2.dilate(am, np.ones((k, k), np.uint8), 1)
        # extend the shape UPWARD (~9%) so scaffold poles rise above the build line
        # and the top isn't sliced flat (user: "coupé en haut de chaque image").
        upE = max(1, int(0.09 * DIM))
        ext = amd.copy(); ext[:-upE] = np.maximum(ext[:-upE], amd[upE:]); amd = ext
        e = cv2.Canny(amd, 40, 120); e = cv2.dilate(e, np.ones((3, 3), np.uint8), 1)
    except Exception:
        amd = am
        gx = np.abs(np.gradient(am.astype(float), 1)); gy = np.abs(np.gradient(am.astype(float), 0))
        e = ((gx + gy) > 10).astype(np.uint8) * 255
    # CLIP region = building COLUMNS (±overhang) × (top of image → base+margin). It
    # drops the invented floor (below base) and outside-bg (non-building columns) but
    # NEVER cuts the scaffold TOP → poles end naturally into transparent sky.
    cols = (amd.max(axis=0) > 0).reshape(1, W).astype(np.float32)
    region = np.zeros((H, W), np.float32)
    region[: min(H, Rbase + int(0.03 * H)), :] = cols
    return Image.fromarray(np.stack([e] * 3, -1), "RGB"), region

def key_scaffold(scaf_rgb):
    # Keep only WOOD-coloured pixels (warm brown/tan) → grey sky, blue, white bg and
    # grey floor drop out by colour, no matter where they are. Then clean speckle.
    s = scaf_rgb.astype(np.float32)
    warm = (s[..., 0] - s[..., 2]) > 12            # R clearly > B  → wood
    bright = s.max(2) > 45                          # not pure black
    sa = (warm & bright).astype(np.uint8)
    try:
        import cv2
        sa = cv2.morphologyEx(sa, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
        sa = cv2.morphologyEx(sa, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        n, lab, st, _ = cv2.connectedComponentsWithStats(sa, 8)
        keep = np.zeros_like(sa)
        for c in range(1, n):
            if st[c, cv2.CC_STAT_AREA] > 0.0006 * sa.size:
                keep[lab == c] = 1
        sa = keep
    except Exception:
        pass
    return sa.astype(np.float32)                    # 1 = wooden scaffold, 0 = else

print("[cn] loading RealVisXL + ControlNet + IP-Adapter…", flush=True)
from diffusers import StableDiffusionXLControlNetPipeline, ControlNetModel, AutoencoderKL
cn = ControlNetModel.from_pretrained("diffusers/controlnet-canny-sdxl-1.0", torch_dtype=torch.float16)
vae = AutoencoderKL.from_pretrained("madebyollin/sdxl-vae-fp16-fix", torch_dtype=torch.float16)
pipe = StableDiffusionXLControlNetPipeline.from_pretrained(   # SAME model as the app → matching photoreal style
    "SG161222/RealVisXL_V4.0", controlnet=cn, vae=vae, torch_dtype=torch.float16)
# IP-Adapter: use the finished building as a STYLE reference so the scaffold is
# rendered in the SAME look (lighting, photoreal 3D render) as the castle image.
pipe.load_ip_adapter("h94/IP-Adapter", subfolder="sdxl_models", weight_name="ip-adapter_sdxl.safetensors")
pipe.set_ip_adapter_scale(0.45)
pipe.enable_model_cpu_offload()
# style-reference image = the building composited on white
_ipn = rgb0.astype(np.float32) * (alpha0[..., None] / 255.0) + 255.0 * (1 - alpha0[..., None] / 255.0)
ip_ref = Image.fromarray(_ipn.clip(0, 255).astype(np.uint8), "RGB")
PROMPT = ("dense wooden construction scaffolding structure wrapping the building, lattice of "
          "vertical wooden poles and horizontal planks and walkways, diagonal cross-braces, "
          "wooden treadwheel crane, isolated on plain white background, photorealistic, detailed")
NEG = "castle, stone building, wall, blurry, low quality, flat, cartoon, toy, solid wall"

for i in range(N):
    prog = 1.0 if N <= 1 else i / (N - 1)
    if i == N - 1:
        src.save(os.path.join(OUT, f"stage_{i}.png")); continue     # exact final
    keep = max(prog, 0.05)
    ral = reveal(keep)
    sil, region = silhouette(ral)
    scaf = pipe(prompt=PROMPT, negative_prompt=NEG, image=sil, ip_adapter_image=ip_ref,
                num_inference_steps=26, guidance_scale=5.5, controlnet_conditioning_scale=0.7,
                generator=torch.Generator("cuda").manual_seed(3)).images[0]
    s = np.asarray(scaf.resize((DIM, DIM)).convert("RGB")).astype(np.float32)
    sa = key_scaffold(s) * region                                  # isolate + clip to building+overhang
    # building revealed (rgb0 masked by ral) then scaffold on top
    build_a = ral.astype(np.float32) / 255.0
    comp = rgb0.astype(np.float32) * build_a[..., None]             # building where revealed
    comp = comp * (1 - sa[..., None]) + s * sa[..., None]           # scaffold over it
    out_a = np.maximum(ral, (sa * 255).astype(np.uint8))            # opaque where building or scaffold
    Image.fromarray(np.dstack([comp.clip(0, 255).astype(np.uint8), out_a]), "RGBA").save(
        os.path.join(OUT, f"stage_{i}.png"))
    print(f"[cn] stage {i} done (keep={keep:.2f})", flush=True)
print("DONE", OUT, flush=True)
