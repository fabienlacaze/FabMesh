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

### 2026-04-14 — InstantMesh as alternative texture-aware mesh generator — STARTED

**Why**: SF3D ceiling reached. All atlas-based projections (mosaic),
xatlas re-pack (mosaic), vertex coloring (15k verts → flou granuleux).
User suggested using a dedicated texturing AI.

**Audit of texturing/mesh AIs (EU + commercial constraints)**:
- ❌ Paint3D, TexFusion, Text2Tex, MeshAnything: research only or
  Tencent Community license
- ❌ Hunyuan3D-2: EU-excluded
- ✅ InstantMesh (`external/InstantMesh/`): Apache 2.0, takes Zero123++
  multi-views as input, generates mesh + texture in single forward pass
- ✅ TripoSR (already in repo via `local_triposr_bridge.py`): MIT, but
  texture native ~SF3D quality

**Next experiment**: bridge InstantMesh as alternative engine.
External repo present, CLI at `external/InstantMesh/run.py`, takes
`config + input_path` and exports OBJ/GLB. `--export_texmap` flag.

### 2026-04-14 — Vertex coloring pipeline (no UV atlas) — DONE, REJECTED VISUALLY

**Result**: GLB 660 KB (vs 4 MB atlas), pipeline 0.1 s. Code clean,
camera math correct, 97% of verts covered by multi-view, 478 fall
back to SF3D atlas.

**Visual**: smooth, no mosaic — but **flou granuleux**. SF3D's 15k
vertices = ~128×128 effective texture resolution stretched on full
mesh surface. Not enough density for fine details (face, ornaments).
**User rejected**.

**Conclusion**: vertex coloring is structurally limited by mesh
density. Would need ≥60k verts (subdivide + paint) to compete with a
2048 atlas.

**File preserved**: `scripts/texture_project_vc.py` (gated by
`FABMESH_PROJECT_MODE=vc` env var).

### 2026-04-14 — Vertex coloring pipeline (no UV atlas) — IN PROGRESS

**Why**: 3 agents diagnosed the fragmented-mosaic atlas. Agreed strategy
recommendation: bypass UV atlas entirely. Each vertex carries its own
RGB, Three.js interpolates linearly across faces — no island borders to
sample across, no EDT dilation, no xatlas tuning.

**Implementation**: `scripts/texture_project_vc.py` (new, parallel to
texture_project.py). Same camera math (Zero123++ schema with elevation
fix), but per-vertex single-winner-takes-all instead of UV rasterization.
Unseen verts fall back to SF3D baked atlas via UV lookup. Output GLB
carries COLOR_0 attribute, no baseColorTexture.

**Status**: script written, NOT yet wired into local_sf3d_bridge.py.
Needs end-to-end test on the orc.

### 2026-04-14 — Zero123++ camera elevation fix — REAL BUG, partial visual win

**Problem (found by 3-agent investigation)**: Zero123++ v1.2 produces 6
views at ALTERNATING elevations: azimuth=[30,90,150,210,270,330],
elevation=[20,-10,20,-10,20,-10]. Verified in
`external/InstantMesh/src/utils/camera_util.py:99-100`.

`texture_project.py` was treating all 6 views as pure Y-axis rotation
at zero pitch. Every non-front sample fetched from a vertically-shifted
pixel — back-of-head verts sampled the chest area in view_3, etc.

**Fix** (commit `672c14e`): added `rot_x(elev_deg)` to camera transform,
re-derived translation since it's no longer azimuth-invariant when
elevation != 0.

**Result**: math fixed BUT visual still mosaic at render. The other
half of the problem is SF3D's micro-island UV layout. Multi-agent
verdict: vertex coloring is the pragmatic next step.

### 2026-04-14 — xatlas UV re-pack — DOES NOT HELP, disabled by default

**Tried**: `xatlas.parametrize` to re-unwrap SF3D micro-islands into
big contiguous UV charts. Implemented in `texture_project.py`, gated by
`FABMESH_UV_REPACK` env var.

**Result on orc**: 15273 → 19707 verts (seams duplicated), 19048 faces
preserved, sharp_ratio 25% → 58%, BUT visual atlas still mosaic. xatlas
default `ChartOptions` produces per-triangle charts on this dense mesh.
Final rendering still bad.

**Conclusion**: not a silver bullet for SF3D meshes. Disabled by
default (`FABMESH_UV_REPACK=0` is now the default — set to 1 to opt
in). Could be revived with custom `ChartOptions(max_iterations=4,
normal_deviation_weight=2.0)` but vertex coloring is more promising.

### 2026-04-14 — EDT dilation atlas fill — WIN for coverage, NEUTRAL for visual

**Tried**: `scipy.ndimage.distance_transform_edt` to fill atlas pixels
with the nearest projected colour instead of falling back to SF3D blur.

**Result**: every atlas pixel now has a colour from our projection
(no SF3D blur leak), but on SF3D's micro-island layout this produces
the voronoi-mosaic appearance because EDT spreads each tiny island's
colour across the whole inter-island padding.

**Status**: still active. Helps when UV layout is good (TripoSG?).

### 2026-04-14 — Alpha-aware multiview input — SUSPECTED FIX

**Problem**: orc_blue_crown texture came out as a broken voronoi mosaic
(blue leaking everywhere, no recognizable silhouette in atlas, face
missing). Debug overlay showed projection math was correct.

**Root cause found**: `multiview_gen.py` opened the preprocessed input
and did `convert('RGB')` before saving `input.png`. That stripped the
alpha channel produced by SF3D's `remove_background`. When
`texture_project.py` later loaded that input.png to sample colours, it
had no alpha to gate with — so background pixels were sampled onto the
mesh, then EDT dilation smeared them across the full UV atlas.

**Fix**: preserve alpha end-to-end. If the input has no alpha, run rembg
on it (new code path). Save the RGBA result as input.png. Zero123++
still gets an RGB composite (paste on white).

**Expected**: atlas should now have clean silhouettes; background weight
is zero because texture_project.py already multiplies by src_alpha.

**Not yet visually verified by user** — needs a fresh end-to-end run.

### 2026-04-14 — Atlas 2048 + EDT dilation — WIN (needs user visual check)

**Tried**: two changes to `scripts/texture_project.py`:
1. Default atlas res stays 1024 but SF3D bridge already passes 2048 in
   production — confirmed on test mesh.
2. Replaced SF3D fallback blending with SciPy EDT-based dilation: unseen
   pixels take color from the nearest projected pixel, not from SF3D's
   blurry baked texture.

**Metrics on test "man" mesh at 2048**:
- sharp pixels: 226k @ 1024 → **907k @ 2048** (4× as expected)
- faces drawn: 8971/9788 (87%) → **9338/9788 (95%)**
- all 4M atlas pixels now filled (no black gaps)

**Conclusion**: atlas is fully populated by our projected color
(projected regions + EDT-dilated neighbors). No more SF3D blur leaking
into the final texture except where scipy unavailable (graceful fallback
still works).

**Still to verify**: actual FabMesh 3D render — user has not yet run a
full generation on this new code path.

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
- ❌ Tune per-pixel UV projection on SF3D meshes — micro-islands make
  the rendered atlas inevitably mosaic regardless of projection quality
- ❌ Retry xatlas with default ChartOptions on SF3D output — produces
  per-triangle charts that don't help the rendering issue
- ❌ Treat Zero123++ multi-views as pure Y-axis rotations — they have
  alternating elevations +20°/-10°. Always include `rot_x(elev_deg)`
