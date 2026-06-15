# RECOVERY — rebuild FabMesh / MyFabmesh.AI from zero

If the machine dies, this is the full "new PC → working project" procedure for
all three surfaces (**desktop**, **cloud**, **admin**). Everything needed is
either in this repo or re-downloadable. The only thing GitHub does **NOT**
hold is your **secrets** — restore those from your encrypted vault (Step 1).

> Rule of thumb: **code + recipe = GitHub** (this repo). **Big binaries
> (models, venvs, node_modules) = re-downloaded** by the wizards. **Secrets =
> your encrypted vault**. **Cloud user data (R2 + Supabase DB) = lives in the
> cloud**, survives a dead PC.

---

## 0. Prerequisites (new machine)
- Windows 11, NVIDIA GPU (project tuned for RTX 5080 / sm_120, CUDA 12.8).
- Git, Node.js 20+, Python 3.11, the NVIDIA driver.
- Account access: **HuggingFace**, **Cloudflare**, **Supabase**, **Stripe**,
  **Modal**, **Replicate** (for regenerating/reading secrets).

## 1. Restore secrets (NOT on GitHub in plaintext)
The secret files (`.env`, `.mcp_bridge_token`, `.test_api_token`, `config.json`)
are gitignored. They are backed up **encrypted** in this repo as
`secrets.sealed` (AES-256-GCM). Restore them with your passphrase:
```
python scripts/secrets_unseal.py        # asks for the passphrase, restores the files
```
(To re-seal after changing a secret: `python scripts/secrets_seal.py` then
`git add secrets.sealed && git commit && git push`.)

If `secrets.sealed` is missing or you forgot the passphrase, regenerate each
key from its provider dashboard. Cloud-deploy secrets (Cloudflare/Stripe/
Supabase) also live in **GitHub → Settings → Secrets** for the Actions deploy.

## 2. Clone the repo
```
git clone https://github.com/fabienlacaze/MyFabmesh.git
cd MyFabmesh
```

---

## 3. DESKTOP (Electron app + local GPU pipeline)
```
npm install                       # Electron + renderer deps (package.json)
```
First run launches the in-app **wizard**, or run it manually:
```
python scripts/wizard_install_deps.py   # torch 2.7.0/cu128, kaolin, flash-attn,
                                         # xformers, diffusers, transformers, hf_hub
python scripts/wizard_download.py        # HF weights (~17 GB, see Appendix A)
python scripts/install_kaolin_shim.py    # Apache-2.0 kaolin rasterizer shim
```

### 3a. External models (gitignored — re-clone + re-apply our patches)
For each model: clone upstream, then copy our edits back from `external_patches/`.
```
# TRELLIS-2 (image→3D, texturing)
git clone https://github.com/microsoft/TRELLIS.2 external/TRELLIS2_win/src
# create external/TRELLIS2_win/.venv (the wizard handles torch/flash-attn/kaolin)
xcopy /E external_patches\TRELLIS2_win\* external\TRELLIS2_win\   # restore our edits
python scripts/apply_trellis2_ram_patches.py                      # or re-derive them

# StableFast3D
git clone https://github.com/Stability-AI/stable-fast-3d external/StableFast3D
copy external_patches\StableFast3D\sf3d\models\tokenizers\dinov2.py ^
     external\StableFast3D\sf3d\models\tokenizers\dinov2.py

# MV-Adapter (+ its own venv .venv-mvadapter, diffusers 0.30)
git clone https://github.com/huanngzh/MV-Adapter external/MV-Adapter
xcopy /E external_patches\MV-Adapter\* external\MV-Adapter\

# UniRig (legacy rigging fallback)
git clone https://github.com/VAST-AI-Research/UniRig external/UniRig
copy external_patches\UniRig\src\model\unirig_ar.py external\UniRig\src\model\unirig_ar.py

# Hi3DGen
git clone https://github.com/Stable-X/Hi3DGen external/Hi3DGen
# Puppeteer (primary rigging engine — NEVER modified, clean clone)
git clone --recursive https://github.com/Seed3D/Puppeteer external/Puppeteer
```
Validate: `python scripts/wizard_smoke_test.py`.

### 3b. Launch desktop
```
npm start    # (or: unset ELECTRON_RUN_AS_NODE; node_modules/.bin/electron .)
```

---

## 4. CLOUD (Cloudflare Worker + Next.js) + 4b. ADMIN
The cloud **auto-deploys** on push to `master` via GitHub Actions
(`.github/workflows/cloud-deploy.yml`) — verified green. Manual deploy:
```
cd cloud
npm install
npm run build            # MUST run before deploy — copies public/app → out/
npx wrangler deploy      # needs Cloudflare auth + the bindings in wrangler.toml
```
- Config in git: `cloud/wrangler.toml`, `cloud/next.config.mjs`,
  `cloud/package.json`.
- **Admin** = `cloud/public/admin.html` (served by the same Worker), in git.
- **Database**: re-apply schema from `cloud/sql/schema.sql` +
  `cloud/supabase/migrations/*` (`supabase db push`). User rows/projects live
  in Supabase cloud — they survive a dead PC.
- **R2 assets** (user meshes/images) live in Cloudflare R2 — survive a dead PC.

### 4c. Modal GPU backend (cloud generation/animation)
```
modal deploy modal_app/app.py        # needs `modal token set` (your Modal acct)
# see modal_app/PUPPETEER_DEPLOY.md for the Puppeteer animation engine
```

---

## Appendix A — HuggingFace weights (via `scripts/wizard_download.py`)
| key | repo | ~MB |
|---|---|---|
| trellis2 | `microsoft/TRELLIS.2-4B` | 4100 |
| realvis | `SG161222/RealVisXL_V4.0` | 6500 |
| sdxl_inp | `diffusers/stable-diffusion-xl-1.0-inpainting-0.1` | 6500 |
| cn_pose | `xinsir/controlnet-openpose-sdxl-1.0` | 2400 |
| ipadapter | `h94/IP-Adapter` | 700 |
| florence2 | `microsoft/Florence-2-large` | 1700 |
| blip1 | `Salesforce/blip-image-captioning-large` | 990 |

## Appendix B — what is intentionally NOT in git (and how to re-get it)
- `external/` (~46 GB: model src + venvs + weights) → Step 3a + wizards.
- `node_modules/`, `cloud/node_modules/` → `npm install`.
- `.venv*`, `__pycache__` → wizards / pip.
- `meshes/`, `images/`, `logs/`, `dist/`, `cloud/.next`, `cloud/out` → app
  output / build artifacts; regenerate by running the app / `npm run build`.
- **Secrets** (`.env`, tokens, `config.json`) → your encrypted vault (Step 1).

## Appendix C — our patches to vendored models
`external_patches/` holds a copy of every file we hand-edit inside the
gitignored `external/` models (TRELLIS-2 Blackwell/sdpa fixes, MV-Adapter,
StableFast3D, UniRig). After a fresh clone of a model, copy the matching files
back. See `external_patches/README.md`.
