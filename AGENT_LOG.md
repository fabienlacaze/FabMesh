# FabMesh Agent Log

**RULE: I MUST read this file at the start of any session that touches
mesh quality, texture projection, or multi-view generation. I MUST append
to it after every experiment — success or failure. This prevents running
the same failed experiments twice.**

Most recent at the top. Each entry: date (YYYY-MM-DD), what was tried,
what happened, conclusion.

---

## Constraints (never forget)

- **Commercial target**: Gumroad / itch.io / Fab.com (NOT Steam)
- **Must be**: free, local, commercially licensable, **EU-safe**
- **User is in France** → EU licensing restrictions apply
- **Hardware**: RTX 5080 (16 GB VRAM)
- **Prefer French** in chat replies

## Licence status of tried/considered models

| Model | License | EU + commercial? | Status in FabMesh |
|---|---|---|---|
| Stable Fast 3D | Stability Community (<1M$/yr) | ✅ | Bridged, current default mesh pipeline |
| TripoSG | MIT | ✅ | Bridged (`local_triposg_bridge.py`) — user has used it |
| TRELLIS | MIT | ✅ but UNUSABLE | Bridge exists but **never managed to run** — don't retry |
| Hunyuan3D-2 | Tencent Community | ❌ EU excluded | Bridged but **not allowed** for EU release |
| Zero123++ v1.2 | Apache 2.0 | ✅ | Current multi-view generator |
| RealESRGAN x4plus | BSD-3 | ✅ | Upscales multi-views 320→1024 |
| RealVisXL V4.0 | OpenRAIL++-M | ✅ | Current image generator |
| IPAdapter Plus | Apache 2.0 | ✅ | Tried for multi-view, failed (see log) |
| IPAdapter-FaceID | Research only | ❌ NON-COMMERCIAL | Never use |
| xinsir ControlNet OpenPose SDXL | Apache 2.0 | ✅ | Not yet tried |
| Unique3D | MIT | ✅ | Not yet bridged — candidate |

## Texture pipeline reference state (2026-04-14)

Current scripts:
- `scripts/multiview_gen.py` — Zero123++ → 6 views → RealESRGAN upscale 320→1024 → rembg bg removal
- `scripts/texture_project.py` — per-pixel barycentric projection of all 7 views (input + 6 multi) onto mesh UVs, with hard-override blend against SF3D fallback
- `scripts/multiview_sdxl_gen.py` — SDXL + IPAdapter alternative (does NOT work well, see log)

Commits of interest:
- `515ca97` — looser UV filters + hard blend + bg removal on multi-views
- `c68344a` — per-pixel rasterization uses ALL 7 views (not just front)
- `bfb2aaa` — RealESRGAN 320→1024 upscale integration

---

## Log entries

### 2026-04-14 — SDXL + IPAdapter multi-view (Option 2) — PARTIAL FAILURE

**Tried**: `scripts/multiview_sdxl_gen.py` — RealVisXL + IPAdapter Plus + per-orientation prompts.
Per-view IP scales: right/left=0.35, back=0.55. Shared seed across views.

**Result on "man" prompt**:
- view_3 (back): ✅✅ **Perfect** — real rear view, same identity, clothes match
- view_1 (right profile): ❌ Still 3/4 front, just head slightly turned
- view_4 (left profile): ❌ Same — SDXL dataset bias prevents true 90° profile

**Conclusion**: IPAdapter alone cannot force true side profiles. Would need
ControlNet OpenPose on top, which adds ~1.5 GB models + fragility.
**DO NOT retry this without ControlNet.**

### 2026-04-14 — SDXL pure prompt + seed (Option 1) — FAILURE

**Tried**: same RealVisXL, no IPAdapter, just prompt+seed for 4 orientations.

**Result**: Each view was a completely different person with different
clothes (white shirt + jeans → gray T-shirt → shirtless in shorts for back).
Shared seed is nowhere near enough to preserve identity.

**Conclusion**: **Pure prompt steering is useless for multi-view texture.**
**DO NOT retry.**

### 2026-04-14 — Texture projection debugging — PARTIAL WIN

**Problem**: Generated 3D mesh had black/blurry face even though the 6
upscaled multi-views (1024 px each) were clean and sharp.

**Root causes found**:
1. Per-pixel rasterization only used `views[0]` (front) — any surface not
   visible from front fell back to SF3D blur. Fixed in `c68344a`.
2. UV filters (`min_edge > 0.5`, `aspect < 15`) rejected ~15% of faces
   including the entire face/hair region (SF3D packs these as tiny
   triangle strips). Fixed in `515ca97`.
3. Smoothstep blend weighted small triangles near zero. Fixed with hard
   override at 0.002.
4. Zero123++ output RGB gray background bled into projection. Fixed by
   running rembg on all 6 views after upscale.

**Measurement**: after fixes, 37% of atlas pixels differ from the
untouched SF3D texture (head + torso + limbs all covered). Not yet
visually verified in FabMesh 3D viewer by the user.

**Open question**: User reports visual result still unsatisfying. Unclear
if remaining blur comes from:
- PBR lighting in Three.js viewer (roughness/metallic rendering)
- SF3D fallback still dominating the ~60% of atlas pixels we don't touch
- Base SF3D atlas being a rendering ceiling

### 2026-04-14 — Zero123++ 1024 px upscale via RealESRGAN — WIN

**Tried**: upscale 6 Zero123++ tiles from 320 → 1024 via RealESRGAN x4plus.
Patched `basicsr/data/degradations.py` (torchvision.transforms.functional_tensor → functional).

**Result**: 6 views now 1024×1024, **visually sharp** (user confirmed:
"les images sont propres et pas flou"). Coût: +12 s per generation.

**File**: `scripts/multiview_gen.py` calls RealESRGAN before saving tiles.

---

## Things to NOT do again

- ❌ Retry IP-Adapter-FaceID (research license)
- ❌ Retry pure-prompt SDXL multi-view (identity drift)
- ❌ Retry TRELLIS (never ran)
- ❌ Ship Hunyuan3D-2 (EU excluded)
- ❌ Tune per-pixel projection further without first ruling out Three.js
  lighting as the visual issue
