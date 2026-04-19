# FabMesh — Roadmap

_Last updated: 2026-04-11_

FabMesh target: commercial release on **Fab.com / itch.io / Gumroad** (not Steam).
Everything must be **free to set up AND commercially sellable** (no SDXL Turbo, no Hunyuan, no non-commercial licenses).

---

## Pipeline state

| Step | Local (in zip) | Cloud (optional) | Status |
|---|---|---|---|
| Text → Image | RealVis XL V4.0 (CreativeML Open RAIL++-M) | Meshy.ai (CC-BY 4.0) | ✅ Working |
| Image → Mesh + textures | Stable Fast 3D (Stability Community <$1M) | Meshy.ai | ✅ Working |
| Rigging (UE5 skeleton) | UniRig (MIT) | Meshy.ai | ⚠️ Partial — see known issues |
| img2img / inpaint / remove bg / clone stamp | RealVis XL + SDXL Inpainting + rembg + CLIPSeg | — | ✅ Working |

---

## BLOCKERS (must fix before anything else)

### BUG-01 · VRAM / GPU limits ignored by Apply Inpaint
**Observed**: User sees VRAM at 95% and GPU at 99% while slider limits are set to 92% / 95%.
**Cause**: `index2-edit-tools.js` draw-mask apply calls `addJob()` → bypasses `enqueueJob()` / `gatedRun()`, so the VRAM/GPU headroom check never runs before firing the IPC.
**Fix**:
1. Route draw-mask through `window.fabmeshJobs.enqueue(kind, name, runFn)` instead of directly pushing
2. Export `enqueueJob` alongside `pushJob`/`completeJob` on `window.fabmeshJobs`
3. Audit every other classic-script helper that pushes jobs (clone stamp, mask inpaint, maybe auto-inpaint) for the same bug

### BUG-02 · `hasVramHeadroomFor` condition uses AND instead of OR
**Location**: `src/renderer/index2.js:3954`
```js
if (usedPct > gpuLimits.vram && freeGB < cost)
```
**Problem**: Blocks only when **both** "VRAM % over limit" AND "not enough free" — so a job that would push VRAM from 85% → 98% passes when the slider is at 92% because `usedPct` at check time is 85.
**Fix**: Predict post-allocation VRAM: block if `(usedGB + cost) / totalGB > gpuLimits.vram/100`.

### BUG-03 · SDXL server doesn't pick up slider changes
**Problem**: `FABMESH_VRAM_FRACTION` env var is read **only at server startup**. If the user changes the VRAM slider after the server is running, PyTorch keeps the old memory fraction.
**Fix**: Restart the SDXL server when the VRAM slider changes, OR expose a `/set_memory_fraction` endpoint on `sdxl_server.py` that calls `torch.cuda.set_per_process_memory_fraction()` on the fly.

---

## Features — Pipeline robustness

### Image stage
- [ ] Auto-inpaint (CLIPSeg target) — re-test end-to-end after the SDXL-server RealVis rewire
- [ ] Remove background — re-test
- [ ] Clone stamp — re-test (same `index2-edit-tools.js` code path, probably has the same job-queue bug as draw mask)
- [ ] img2img modal — verify RealVis output quality matches old SDXL Turbo (expected: better, less "fried" look)
- [ ] Validate that deleting an image version doesn't orphan mesh/rig versions that referenced it

### 3D stage
- [x] Stable Fast 3D generates valid PBR GLB (validated on human_rabbit)
- [ ] Test SF3D on multiple asset types: humanoid biped, creature, vehicle, weapon, building
- [ ] Verify output is in T-pose (critical for UniRig downstream) — currently dependent on the source image
- [ ] Verify output orientation: Y-up, feet at origin, size ~1.7m height
- [ ] Expose `target_polycount` + `texture_size` sliders properly (today hardcoded to 50K / 1024)
- [ ] Decide fate of `local_triposr_bridge.py` / `local_triposg_bridge.py` / `trellis_bridge.py` — remove or keep as fallback?

### Rigging stage
- [ ] **UniRig skin writer blocker** (noted in memory) — investigate why the 3rd stage crashes
- [ ] Verify that `bake_procedural_anims.py` produces playable Idle/Walk/Run animations for any skeleton
- [ ] Export to Unreal Engine 5 as FBX with correct orientation + unit scale (cm) + bone names matching UE5 Mannequin
- [ ] IK Rig / IK Retargeter documentation: write a short README telling the user how to retarget UniRig output onto the UE5 Mannequin
- [ ] Remove the dead template-based rig code (`ws-rig-template`, `ws-rig-skin-method`, etc.) if we're 100% committed to AI rigging

### Cloud (Meshy.ai)
- [ ] Test the **Test** button in Settings — should return OK green
- [ ] Test Meshy text-to-image with a simple prompt
- [ ] Test Meshy image-to-3d on the same rabbit and compare quality vs SF3D
- [ ] Test Meshy rigging on a SF3D-generated mesh
- [ ] Handle quota exhaustion gracefully (show "Meshy free tier exhausted — switch to local or upgrade at meshy.ai")
- [ ] Handle cloud timeouts (rigging can take 3-5 minutes on busy days)

---

## UX / Polish

- [ ] Clean up legacy code paths from `main.js`:
  - SDXL Turbo fallback (`local-sd`) — emit clean error
  - Pollinations (`pollinations`) — emit clean error
  - Hunyuan3D (`hunyuan`) — emit clean error
  - `local_image_bridge.py` script — delete, it's the SDXL Turbo bridge
- [ ] Remove `scripts/_legacy_backup/` and `*.backup_*` files
- [ ] Remove unused `TripoSG/`, `TripoSR/`, `trellis2/` external checkouts (keep only StableFast3D, UniRig)
- [ ] Re-enable / fix Cancel button for jobs (mid-run kill is currently hit-or-miss)
- [ ] Settings: a "Reset to defaults" button that clears API keys and resets GPU sliders
- [ ] Settings: show the current model download status / cache size for each of the 6 bundled models
- [ ] Workspace: a "Help" / info icon next to each AI engine dropdown explaining what it does and its licence

---

## Pre-release packaging (Fab.com / itch.io / Gumroad)

**Strategy** (decided 2026-04-11): lightweight ~5 GB zip + first-run download of ~17 GB models from HuggingFace. User accepts internet needed on first launch. Memorized in `project_packaging_strategy.md`.

### P1 — Required for release
- [ ] Create `scripts/package_release.ps1` that builds the release zip
- [ ] Python 3.11 embedded portable in `python/` (download from python.org)
- [ ] Copy current `site-packages` into `python/Lib/site-packages/` (torch cu128, diffusers, transformers, trimesh, moderngl, pre-built texture_baker + uv_unwrapper wheels, etc.)
- [ ] Modify `main.js` to call `python/python.exe` (relative path) instead of system `python`
- [ ] Modify Python bridges to read from `./models/<repo>/` before falling back to HF cache
- [ ] Implement **first-run setup modal** in the renderer:
  - Checks if `./models/RealVisXL_V4.0` / `./models/stable-fast-3d` / `./models/sdxl-inpainting` / `./models/UniRig` exist
  - If any are missing, download them from HuggingFace into `./models/` with a progress bar
  - For gated models (SF3D), prompt the user for a HuggingFace token + open the license page in their browser
  - Persist "first-run done" flag in `config.json` so it never runs again
- [ ] Move `config.json` from repo root to `app.getPath('userData')` (`%APPDATA%/FabMesh/config.json`)
- [ ] Generate `CREDITS.txt` from a manifest listing all third-party licenses + Meshy attribution
- [ ] `electron-builder.yml`: `target: zip`, `win x64`, icon, productName, etc.
- [ ] Test the generated zip on a clean Windows machine (VM) to confirm zero-install works

### P2 — Nice-to-have before release
- [ ] Auto-update check against a GitHub release tag (optional — skip for v1)
- [ ] Crash reporter that writes `%APPDATA%/FabMesh/crash.log` on uncaught exceptions
- [ ] "Export logs" button in Settings that zips the logs folder and opens it in Explorer (for support)
- [ ] Translations: at minimum English. French as default is fine for v1 since the user is French.
- [ ] About modal with version number, build date, and 3rd-party credits

---

## Marketing / Store-listing prep (out of scope for coding, but track here)

- [ ] Fab.com listing (title, short description, 4-5 screenshots, demo video)
- [ ] itch.io mirror with a free demo build (limited to text-to-image only?)
- [ ] Gumroad fallback if Fab.com approval is slow
- [ ] Short demo video: image → mesh → rig → Unreal import, all in ~60 seconds
- [ ] Landing page or at least a simple itch.io devlog

---

## Versioning & changelog system (inspired by Lokizio)

User screenshot 2026-04-19 — Lokizio affiche une popup verticale
"Historique des mises à jour" listant `v8.95 (DERNIÈRE)`, `v8.94`,
`v8.93`, ... avec un bullet point par changement (Refactoring, Fix,
Nouveau rôle, etc.). Reproduire la même logique pour FabMesh.

- [ ] Bump auto de la version semver dans `package.json` à chaque
  release / commit avec marqueur (`[release]`)
- [ ] Fichier `CHANGELOG.md` à la racine, format Keep a Changelog
  (`Added` / `Changed` / `Fixed` / `Removed` par version)
- [ ] Modal "À propos / Mises à jour" dans FabMesh: bouton dans la
  barre du haut → popup qui lit `CHANGELOG.md` (ou JSON dérivé) et
  l'affiche comme Lokizio (timeline verticale, badge "DERNIÈRE",
  bullets par version)
- [ ] Notification toast au démarrage si l'app vient d'être mise à
  jour ("FabMesh vX.Y.Z — voir le changelog")
- [ ] Optionnel: hook git pre-commit qui force l'ajout d'une entrée
  dans `CHANGELOG.md` quand le diff touche `src/` ou `scripts/`

Pratique pour communiquer aux beta-testeurs ce qui a changé sans
qu'ils aient à fouiller le git log.

---

## Known limitations to document in the README

- GPU required (RTX 30/40/50 with >=8 GB VRAM) — CPU fallback not supported
- First run needs internet (~17 GB HF download)
- Stable Fast 3D gated: user must accept the license on HuggingFace and paste a HF token once
- Generations are VRAM-heavy and will use 100% of available VRAM during inference
- No multi-GPU support
- Windows only (macOS / Linux not tested, torch cu128 is Win/Linux)
