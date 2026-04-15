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

### 2026-04-15 — TRELLIS.2 already installed in WSL — DIDN'T RUN (CUDA ABI mismatch)

Re-discovery: `local_trellis2_bridge.py` (170 lines) already exists in
`scripts/`, and `/root/TRELLIS.2` exists in WSL Ubuntu with a `.venv`
(python 3.12) and the official `example_texturing.py`. Module
imports cleanly (`from trellis2 ...`).

The bridge's docstring claims "works out of the box with ~14 GB VRAM
peak on RTX 5080" — so a previous attempt DID succeed once.

**Failure mode this time** (test on orc image, output to /tmp):
```
ImportError: ... flex_gemm/kernels/cuda.cpython-312-x86_64-linux-gnu.so:
undefined symbol: _ZNK3c1010TensorImpl15incref_pyobjectEv
```
flex_gemm 1.0.0 was pre-compiled against torch 2.6 (TRELLIS.2 README
explicitly recommends torch 2.6.0 + CUDA 12.4) but the venv has
torch 2.9.1+cu128. Pre-built CUDA extensions break across torch
minor versions.

**Why this happens repeatedly**: TRELLIS.2 ships its own custom CUDA
ops (flex_gemm, custom_rasterizer). They're tightly coupled to the
specific torch ABI they were built against. Any pip install/upgrade
in the venv that touches torch breaks them.

**Two ways forward**:
- A. `pip install torch==2.6.0 --index-url cu124` inside the venv
  (5 min, narrow risk — only the trellis2 venv affected)
- B. Recreate the venv from scratch via TRELLIS.2's official
  `setup.sh` (~30 min, cleanest)

**User instruction**: install it for real this time, log every step
to avoid going in circles.

**Attempt 1 (2026-04-15 ~10:35)**: downgrade torch in the venv to
2.6.0+cu124 to match the flex_gemm 1.0.0 pre-built wheels. Command:
`/root/TRELLIS.2/.venv/bin/pip install torch==2.6.0 torchvision==0.21.0
--index-url https://download.pytorch.org/whl/cu124 --upgrade`.

→ torch 2.9.1+cu128 → torch 2.6.0+cu124 OK. Re-tested
`import flex_gemm` — **STILL** `undefined symbol _ZNK3c1010TensorImpl
15incref_pyobjectEv`. The locally-installed flex_gemm 1.0.0 isn't
built for torch 2.6 either. Origin unknown — pip says "from local"
without source URL. Probably built earlier against an even older
torch.

**Web research (agent ad0a60f011a9cdcca, 2026-04-15)** — clarifies
the Windows landscape:
- ❌ Microsoft TRELLIS.2 has **NO official Windows wheels**. Repo
  has 0 GitHub releases, no `wheels/`/`dist/`, README explicitly
  says "tested only on Linux". The earlier agent #3 finding "wheels
  Windows officielles available" was WRONG.
- ❌ Native Windows build attempts (issue #4) fail for nvdiffrast,
  nvdiffrec, cumesh, FlexGEMM, o-voxel — `CUDA_HOME` errors even
  when set. No Microsoft maintainer has helped on Windows.
- ✅ **Community wheels Linux cu128** at
  `siraxe/TRELLIS.2-4B_cuda_12.8.r12.8_wheels` for python 3.12 —
  usable inside WSL on Blackwell (RTX 5080 / 5090). 3 wheels:
  `cumesh-0.0.1`, `flex_gemm-0.0.1`, `o_voxel-0.0.1`.
- ✅ Real working setup: WSL2 Ubuntu + python 3.12 + torch
  2.6.0+cu128 (or torch from siraxe wheel set) + the 3 community
  wheels above.

**Packaging consequence for FabMesh commercial release**:
TRELLIS.2 cannot be shipped as a Windows-native local app. End
users would need WSL2 installed (~5 GB extra). Three options
remain:
- (A) Bundle WSL2 + everything in installer — feasible but heavy
- (B) Cloud premium endpoint that we host — defeats "100% local"
- (C) Skip TRELLIS.2 — keep current SF3D + atlas_refine which is
  100% Windows native

User chose: install attempt continues to validate quality. If
TRELLIS.2 is visibly much better, decide packaging strategy after.

**Attempt 2 (2026-04-15 ~10:55)**: switch venv torch to cu128 + install
community Linux wheels. **PARTIAL FAILURE so far**:
- `pip install torch==2.6.0 --index-url cu128` → "No matching
  distribution". The PyTorch index has torch+cu128 only from 2.7.0
  onwards; 2.6.0 is cu124-only.
- Without --force-reinstall, the previous 2.6.0+cu124 stayed.

→ Pivot: use **torch 2.7.0+cu128** (lowest cu128 version available)
and hope the siraxe community wheels (built against cu128 around
2025-12) are compatible with torch 2.7's ABI. Wheel filenames don't
encode their torch version, so risk: same `_ZNK3c1010TensorImpl
15incref_pyobject` symbol mismatch all over again.

**Wheels downloaded** to `/root/trellis2_wheels/`:
- `flex_gemm-0.0.1-cp312-cp312-linux_x86_64.whl`
- `cumesh-0.0.1-cp312-cp312-linux_x86_64.whl`
- `o_voxel-0.0.1-cp312-cp312-linux_x86_64.whl`

**Result torch 2.8.0+cu128**:
- flex_gemm OK ✅
- cumesh OK ✅
- o_voxel OK ✅ (the SymBool symbol is in torch 2.8)
- ❌ **nvdiffrast** now breaks: `undefined symbol _ZN3c104cuda29
  c10_cuda_check_implementationEiPKcS2_jb`. nvdiffrast was built for
  another torch ABI.

Trying: rebuild nvdiffrast from source against torch 2.8
(`pip install --force-reinstall --no-deps git+https://github.com/
NVlabs/nvdiffrast.git`).

→ **Build wheel FAILED** (exit code 1, output truncated to 5 lines).
Verbose retry with `-v` also failed. Output too noisy to triage,
need to inspect the build log on disk.

`Trellis2TexturingPipeline` requires nvdiffrast at import time
(confirmed via direct `from trellis2.pipelines import ...`), so
this blocks the whole pipeline.

**Next**: capture the actual nvdiffrast build error.

→ Build error: `Cannot compile nvdiffrast CUDA extension. Run pip
install with --no-build-isolation flag`. Trivial fix.

→ Retried with `--no-build-isolation`: **NEW ERROR**
`nvcc fatal : Unsupported gpu architecture 'compute_120'`. The
WSL Ubuntu has nvcc 12.0 system-wide, but Blackwell (RTX 5080 =
sm_120) requires **nvcc 12.8+** to compile.

This is the real blocker. Three options:
- A. Force build with `TORCH_CUDA_ARCH_LIST=8.9` (sm_89, Ada
     Lovelace 4090) — Blackwell may run sm_89 binary by fallback.
- B. Install CUDA Toolkit 12.8 in WSL (~3-4 GB) — clean fix.
- C. Abandon TRELLIS.2 path entirely.

Trying A first (zero install, 5 min). If kernels don't run on
Blackwell at runtime, fall back to B.

**Result torch 2.7.0+cu128 + community wheels** (previous attempt):
- `flex_gemm OK` ✅
- `cumesh OK` ✅
- `grid_sample_3d OK` ✅
- `o_voxel` ❌ — `undefined symbol _ZNK3c107SymBool14guard_or_falseEPKcl`
  (= `c10::SymBool::guard_or_false(const char*, long)`) — present in
  torch 2.8+, not in 2.7. So o_voxel was built against torch 2.8.

**Attempt 3 (in progress)**: bump to torch 2.8.0+cu128 + same wheels.
3 of 4 things now work; o_voxel needs the 2.8 symbol.
Note: pin between flex_gemm/cumesh ABI (2.7-compatible) and o_voxel
(2.8-required) is fragile — there might be no torch version where
ALL 3 wheels are happy at once. Will know in 1 minute.

**Add to "do not retry"**: don't trust agent claims about "wheels
Windows officielles" without verifying via direct GitHub release
listing — Microsoft TRELLIS.2 has none.

### 2026-04-15 — TRELLIS.2 install attempt — STARTED

**Why retry**: Earlier `AGENT_LOG` entry says "TRELLIS never ran, don't
retry". That was for **v1** (CUDA / nvdiffrast / kaolin issues on
Windows). **TRELLIS.2** released by Microsoft in Dec 2025 has
**official Windows wheels** for nvdiffrast 0.4.0 (cp311-cp311) per
the agent #3 research today.

**Goal**: install TRELLIS.2 from `microsoft/TRELLIS.2` repo, run
`example_texturing.py` on the orc image, judge whether it produces
PBR atlases that beat our current SDXL refine. If yes, bridge it as
a new mode `FABMESH_PROJECT_MODE=trellis2`.

**Backup**: `git tag before-trellis2-attempt` created so we can
revert any accidental damage to the working pipeline.

**Constraints**: must be MIT or Apache, EU + commercial OK, must
fit in 16 GB VRAM (v2 docs say peak 30 GB in rendering — risky on
RTX 5080, will need the 4B distilled checkpoint).

### 2026-04-15 — Post-refine saturation/contrast punch — DONE

User feedback on atlas_refine result: "la texture semble toujours
délavée". The orc identity was preserved (green skin, blue crown
on head only, brown armor) but colours were too pale.

**Fix**: PIL ImageEnhance.Color x1.25 + ImageEnhance.Contrast x1.12
applied right after SDXL refine, before atlas write-back. Non-
destructive on detail (keeps the micro-texture SDXL added) but
restores the chroma SDXL softens.

Pending visual check.

### 2026-04-15 — atlas_refine: 2-pass projection + SDXL refine — IN PROGRESS

**Premise** (user request): retry the multi-view UV projection now
that we have all the latest fixes (alpha-aware multi-views,
elevation-correct camera, NEAREST→trilinear filter, normal-map
preservation), then chain SDXL refine on top to clean the seams.

**New mode**: `FABMESH_PROJECT_MODE=atlas_refine` in
`local_sf3d_bridge.py`. Runs `texture_project.py` (multi-view
projection, EDT dilation) then chains `texture_refine.py` with the
subject-aware prompt at strength 0.22.

**Side fix**: `texture_project.py` was iterating ALL images in the
GLB and overwriting them — same bug as upscale_atlas/texture_refine
had — destroying the normal map. Now resolves baseColorTexture index
explicitly before writing.

**Status**: not yet visually validated.

### 2026-04-15 — Trilinear filter + preserve normal map — POLISH

**Problem**: when zooming on a mesh, user saw "carrés" (the actual
texels of the 2048 atlas in NEAREST filtering). Also asked if we even
had a normal map.

**Findings**:
- Normal map IS present in every SF3D-baked GLB (SF3D `system.py:508`
  exports `normalTexture=bump_tex`).
- BUT: `upscale_atlas.py` was iterating ALL images in the GLB and
  upscaling them — including the normal map. RealESRGAN trained on
  photos was flattening the XY components of the normal, killing the
  bump.
- `texture_refine.py` was always replacing `images[0]` — when SF3D
  ordered the normal map first, refine wrote SDXL's hallucination
  ON the normal map.

**Fix** (commit `0737124`):
- Both scripts now resolve baseColorTexture explicitly via
  `materials[0].pbrMetallicRoughness.baseColorTexture.index` →
  `textures[i].source` to find which image to touch.
- `_applyMeshTextureFilter` in renderer: NEAREST → LinearMipMapLinear
  + 16x anisotropy; covers normalMap/roughnessMap/metalnessMap/aoMap
  too (was only `mat.map`).

**Status**: visual validation pending. Should give clean trilinear
zoom + working normal-map relief.

### 2026-04-15 — Subject-aware refine prompt — IN PROGRESS

**Premise**: refine SDXL at strength 0.25 with default generic prompt
("photorealistic detailed surface texture") was hallucinating an ice
golem on the orc because the blue crown dominated the signal.

**Fix** (commit `5cc4f6b`):
- `local_sf3d_bridge.py` reads the latest entry from
  `images/<project>/prompts.json` and passes it via `--prompt` to
  `texture_refine.py`.
- `texture_refine.py` prepends the user prompt to the quality
  keywords so SDXL is anchored to the right subject.

**Verified manually**: standalone refine with prompt "orc warrior
with blue crown..." in 60s, atlas correctly refined.

**Bug found**: pipeline run does NOT produce a refined atlas —
`FABMESH_PROJECT_MODE=upscale` was lingering in the OS env from a
previous PowerShell `Start-Process`, so the bridge was using upscale
instead of refine. Restarted clean without the env var.

### 2026-04-15 — SDXL atlas refine (Meshy-style) — DEFAULT

**Approach**: pass SF3D's baked atlas through SDXL img2img (RealVisXL,
strength 0.25) tile by tile (1024 tiles, 128 px overlap, feather
blend). Hallucinates micro-detail (skin pores, fabric weave, fur)
without changing colours or UV.

**Files**: `scripts/texture_refine.py` (new), wired in
`local_sf3d_bridge.py` as `FABMESH_PROJECT_MODE=refine` (default
since commit `958b30d`).

**Result on poule_geante**: visibly sharper plumage detail (orange
striping, defined feathers) vs the upscale baseline. Cost: +60-90 s
per generation (in-process fallback when SDXL server isn't up).

**Subprocess timeout**: bumped 120 → 600 s (commit `b7905a0`) because
the in-process fallback loads RealVisXL ~6 GB on first call.

### 2026-04-15 — RealVisXL prompt: 3/4 view bias — DONE

**Fix** (commit `3be97b5`): added "three-quarter view showing one
side, slight rotation" to the optimized_prompt and "strict frontal
view, flat profile" to negative_prompt in `local_juggernaut_bridge.py`.

**Why**: SF3D textures only what the front shows and invents the
back/sides. A 3/4 source image exposes one side directly, so SF3D's
bake has real data instead of inventions.

**Verified**: prompts produce 3/4 chickens / orcs / camels reliably.

### 2026-04-15 — Multi-view ADDITIVE augment on top of SF3D atlas — REJECTED VISUALLY

**Premise** (user's idea): SF3D textures the front well from the source
image but invents the back/sides. Augment those by overwriting only
where a Zero123++ multi-view sees that surface better than the front.

**Implementation**: scripts/texture_augment.py. Per face: front_score
= front_vis, mv_score = vis * priority for each of 6 views. If max
mv_score beats front_score by `margin` (default 0.15), overwrite the
SF3D pixels of that face's UV triangle with the multi-view sample.
Wired as `FABMESH_PROJECT_MODE=augment`.

**Result on poule_geante**: 8264/16534 faces overwritten (50%). Mesh
came out with **blotchy patchwork** plumage — black/yellow/white
patches because each Zero123++ view has its own implicit lighting and
the seams between SF3D and overwritten zones are abrupt.

**Conclusion**: photometric mismatch between Zero123++ views and SF3D
makes additive augmentation visually WORSE than plain upscale.
Keeping the script (it works) but `upscale` stays the default mode.

### 2026-04-15 — Atlas-only RealESRGAN upscale — NEW DEFAULT

**Insight**: we kept replacing SF3D's native atlas (which has CORRECT
UV layout — SF3D made it). The replacement (multi-view projection)
is what created the mosaic. Just keep SF3D's atlas + sharpen it.

**New script**: `scripts/upscale_atlas.py`. Takes a GLB, finds the
embedded baseColorTexture, runs RealESRGAN x4plus on it, writes back
to the same GLB (rebuilds binary chunk). 15 s on a 2048 atlas.

**SF3D bridge**: default mode now `FABMESH_PROJECT_MODE=upscale`. The
old multi-view UV projection lives behind `=atlas`, vertex-color
behind `=vc`, no post behind `=none`.

**Smoke test on man mesh**: 2048 -> upscale x4 -> resize 2048. Subtle
sharpening but limited because input is already 2048. Real benefit
when SF3D bake at 1024 then upscale to 2048 or 4096.

**Status**: not yet visually validated by user end-to-end through
FabMesh.

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
- ❌ Iterate ALL images in a GLB and run RealESRGAN/SDXL on them —
  this destroys the normal map. Always resolve baseColorTexture
  explicitly via `materials[0].pbrMetallicRoughness.baseColorTexture
  .index → textures[i].source`.
- ❌ Set FABMESH_PROJECT_MODE in the OS env "just for one test". It
  persists in the parent shell and overrides the bridge default for
  every subsequent FabMesh launch. Always set on the Start-Process
  invocation only, or unset after.
- ❌ Hardcode NEAREST filtering on Three.js material — kills normal
  maps, makes texels visible at zoom. Default trilinear + 16x aniso
  works once UV padding is good.
