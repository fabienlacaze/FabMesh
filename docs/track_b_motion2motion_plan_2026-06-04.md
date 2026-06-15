# Track B — Motion2Motion 7-day sprint plan
**Date:** 2026-06-04
**Owner:** Track B (parallel to Track A AnyTop fine-tune)
**Status:** DRAFT — pending licensing unblock (see Day 1)

---

## Context summary (inputs)

- **Motion2Motion** (SIGGRAPH Asia 2025, arXiv 2508.13139): training-free, CPU-only, patch-based motion matching with sparse 6-pair cross-skeleton correspondence. No weights. ~10–60 s/clip on CPU. Built on GenMM.
- **License:** `LinghaoChan/Motion2Motion_codes` has **no LICENSE file** → "All rights reserved" by default. **Hard blocker for Steam commercial release** without explicit grant from author (`thu.lhchen@gmail.com`).
- **Truebones-Zoo data:** paid Gumroad EULA, non-redistributable. Cannot ship vendor BVHs. AnyTop's 70-skeleton processed dataset (1219 motions / 147k frames) inherits this restriction.
- **Morphology classifier** (`scripts/morphology_classifier.py`) is committed (`65d6bb5`) and correctly tags a 47-bone dragon as `winged` → Truebones donor `Buzzard`. Ready to plug into Track B donor selection.
- **Existing AnyTop retarget** lives in `scripts/anytop_retarget.py` (Track A actively iterating on it — DO NOT TOUCH).

---

## Day 1 (Mon) — Licensing unblock + isolated scaffold

**Goal:** clear the legal gate **before** writing any pipeline code. Set up Track B in a directory Track A never touches.

- **Tasks**
  - Send licensing inquiry to `thu.lhchen@gmail.com` (CC `fabien65400@hotmail.fr`). Ask explicitly for: (a) commercial-redistribution grant for `Motion2Motion.py` + `run_M2M.py` + `utils/`, (b) confirmation we may ship a fork. Attach Steam/commercial context.
  - Mirror the upstream repo to a frozen local snapshot at `external/motion2motion_upstream/` with `.git` stripped and a `UPSTREAM_COMMIT.txt` pinning the SHA (do not vendor into our `scripts/` tree yet — keep under a clearly-fenced `external/` dir flagged "non-shippable until licensed").
  - Create the Track B working tree: `scripts/track_b_m2m/__init__.py`, `scripts/track_b_m2m/README.md` (1 paragraph: "isolated from Track A AnyTop retarget; do not import `anytop_retarget.py`").
  - Add a feature flag `FABMESH_TRACK_B_M2M=0` default, read in `scripts/track_b_m2m/__init__.py`; ALL Track B code must early-return if unset.
  - Add `AGENT_LOG.md` entry: "Track B day 1 — licensing email sent, scaffold created, no pipeline code yet".
- **Files created**
  - `external/motion2motion_upstream/` (snapshot)
  - `external/motion2motion_upstream/UPSTREAM_COMMIT.txt`
  - `scripts/track_b_m2m/__init__.py`
  - `scripts/track_b_m2m/README.md`
  - `docs/track_b_motion2motion_plan_2026-06-04.md` (this file)
- **Files modified:** `AGENT_LOG.md` only.
- **Expected commit:** `feat(track-b): scaffold isolated Motion2Motion sandbox + license inquiry sent`

---

## Day 2 (Tue) — Upstream smoke test on author's demo

**Goal:** prove the upstream code runs end-to-end on the **author-shipped** flamingo→monkey demo (the only data we're 100% allowed to use because the repo ships it). No FabMesh assets involved.

- **Tasks**
  - Build a dedicated venv `venvs/track_b_m2m/` (Python 3.10, CPU-only torch). Do NOT touch the AnyTop venv.
  - Run `external/motion2motion_upstream/run.sh` on the flamingo→monkey demo. Capture wall-clock, output BVH path, any crashes.
  - Write `scripts/track_b_m2m/smoke_upstream.py` — single-command repro that calls `run_M2M.py` with the demo paths and asserts the output BVH exists + has >0 frames.
  - Document the joint-name-collision sharp edge (the `add_random_string_of_joints.py` workaround the upstream README mentions).
- **Files created**
  - `scripts/track_b_m2m/smoke_upstream.py`
  - `logs/track_b/day2_smoke.log`
- **Expected output**
  - `demo_output/monkey_syn.bvh` exists, plays back in Blender.
  - Wall-clock recorded (expect 10–60 s on CPU per upstream README).
- **Expected commit:** `test(track-b): upstream M2M flamingo→monkey demo runs in isolated venv`

---

## Day 3 (Wed) — Donor BVH provider abstraction (NO Truebones data)

**Goal:** define the interface between Track B and the donor-motion store, **without** committing any Truebones BVHs to the repo. This is the hard architectural decision — get it right before any retarget code.

- **Tasks**
  - Write `scripts/track_b_m2m/donor_provider.py` with `class DonorProvider` exposing `get_donor_bvh(archetype: str, motion: str) -> Path`.
  - Implement **3 backends** behind that interface:
    1. `LocalDonorProvider` — reads from `$FABMESH_DONOR_DIR` env var, user-supplied path (the user's own Truebones license). Default for dev.
    2. `MixamoDonorProvider` — stub returning `NotImplementedError`, placeholder for the FBX-from-Mixamo path (CC0-ish, allowed to ship).
    3. `SyntheticDonorProvider` — generates a trivial procedural BVH (e.g. a sinusoidal idle on a canonical 6-joint chain) so the smoke test works **with zero third-party data**.
  - Wire `scripts/morphology_classifier.py::classify_glb` to pick the donor archetype: `winged → Buzzard`, `quadruped → Dog`, `biped → Human`, `serpent → Anaconda`, `hexapod → Spider`. Put the map in `scripts/track_b_m2m/archetype_to_donor.py` (single source of truth).
  - Smoke: classify `c:/tmp/dragon_rig.glb` → `winged` → `SyntheticDonorProvider.get_donor_bvh("winged", "idle")` returns a valid BVH path.
- **Files created**
  - `scripts/track_b_m2m/donor_provider.py`
  - `scripts/track_b_m2m/archetype_to_donor.py`
  - `scripts/track_b_m2m/test_donor_smoke.py`
- **Expected commit:** `feat(track-b): donor provider abstraction + archetype→species map (no third-party data shipped)`

---

## Day 4 (Thu) — Sparse correspondence builder

**Goal:** auto-generate the 6-pair `{source: jointName, target: jointName}` JSON that M2M requires, from a FabMesh GLB skeleton + a donor BVH skeleton. This is the only piece M2M does **not** do for you.

- **Tasks**
  - Write `scripts/track_b_m2m/correspondence.py`:
    - Parse source GLB skeleton via `morphology_classifier.extract_skeleton`.
    - Parse target BVH skeleton (reuse `scripts/bvh_to_gltf_anim.py` parser if shareable — **read-only**, do not modify).
    - Use the morphology features (`low_terms`, `high_terms`, `wide_terms`, `symmetry`) to find: 2 root-line pairs (hip/spine), 2 limb-pairs (thigh-equivalents), 2 extremity pairs (feet/wingtips).
    - Output `correspondence.json` in M2M's expected schema.
  - Validate on the upstream demo (regenerate the flamingo→monkey 6-pair JSON from scratch, diff against the shipped one — they don't need to match byte-for-byte, just produce a working retarget).
  - Validate on `c:/tmp/dragon_rig.glb` → Buzzard donor: should produce 6 sensible pairs (2 wing pairs + 2 leg pairs + spine + tail). Manual inspection only — no acceptance metric yet.
- **Files created**
  - `scripts/track_b_m2m/correspondence.py`
  - `scripts/track_b_m2m/test_correspondence.py`
  - `logs/track_b/day4_dragon_pairs.json` (sample output for review)
- **Expected commit:** `feat(track-b): auto sparse 6-pair correspondence from morphology features`

---

## Day 5 (Fri) — End-to-end glue: GLB → BVH → M2M → GLB animation

**Goal:** one CLI command takes a FabMesh GLB, runs the full pipeline, and emits an animated GLB. This is the **Day-5 go/no-go gate**.

- **Tasks**
  - Write `scripts/track_b_m2m/pipeline.py` with `run(glb_in: Path, motion: str, glb_out: Path)`:
    1. Classify GLB → archetype.
    2. Look up donor BVH via `DonorProvider`.
    3. Build correspondence JSON.
    4. Export source GLB skeleton as a rest-pose BVH (reuse `scripts/bvh_to_gltf_anim.py` reversed — read-only consumption).
    5. Invoke upstream `run_M2M.py` as a **subprocess** (do not import — keeps the upstream code isolated from our process, simplifies the licensing fence).
    6. Parse the synthesized BVH back and inject as a glTF animation channel onto the input GLB (reuse `scripts/bvh_to_gltf_anim.py` — read-only).
  - Run end-to-end on the dragon. Record: wall-clock, output frame count, visual sanity (open in Blender, scrub timeline).
  - Compare side-by-side with Track A's AnyTop retarget output on the same dragon, same target motion (idle). Document which one looks less broken — this becomes the Day-7 ship signal.
- **Files created**
  - `scripts/track_b_m2m/pipeline.py`
  - `scripts/track_b_m2m/__main__.py` (CLI entry)
  - `logs/track_b/day5_dragon_e2e.mp4` (turntable render)
- **Expected commit:** `feat(track-b): end-to-end M2M pipeline GLB→BVH→retarget→animated GLB`

---

## Day 6 (Sat) — Quality battery + 3 morphologies

**Goal:** stress-test on >1 morphology to avoid overfitting to the dragon.

- **Tasks**
  - Run the pipeline on 3 test GLBs covering 3 archetypes:
    - `winged` — the existing dragon
    - `quadruped` — any FabMesh dog/wolf/horse GLB (find one in past test outputs)
    - `biped` — humanoid orc from the `orc_m1` asset family
  - For each: produce idle + walk + attack (3 motions × 3 morphologies = 9 retargets).
  - Score by `global_std` (frame-to-frame joint-pos std-dev) — same metric the AnyTop audit (commit `9681dd7`) uses. **Track A's recent number: 1957 deg/s motion preserved**, AnyTop native baseline `global_std ≈ 0.59`. Use those as comparison anchors.
  - Build `scripts/track_b_m2m/quality_battery.py` that runs the 9-cell matrix and emits a CSV.
- **Files created**
  - `scripts/track_b_m2m/quality_battery.py`
  - `logs/track_b/day6_battery.csv`
  - `logs/track_b/day6_turntables/*.mp4`
- **Expected commit:** `test(track-b): 9-cell quality battery (3 morphologies × 3 motions)`

---

## Day 7 (Sun) — Ship decision + integration plan (or kill switch)

**Goal:** decide. Either fold Track B into the Electron pipeline behind a feature flag, or document why we shelve it.

- **Tasks**
  - Compare Day-6 CSV against the AnyTop baseline number from Track A. Pick winner per archetype (M2M may win on `serpent`/`winged`, AnyTop may win on `biped` — that's fine, keep both behind a dispatch).
  - **If licensing came back GREEN (Day 1 email answered with explicit commercial grant):**
    - Add `scripts/track_b_m2m/` to the Electron rig pipeline behind `process.env.FABMESH_TRACK_B_M2M === '1'`.
    - Wire UI toggle in `src/renderer/` (single checkbox, default OFF).
    - Write `docs/track_b_ship_notes.md` with archetype-dispatch logic.
  - **If licensing is still SILENT:**
    - Tag the work `track-b-shelved-pending-license`, leave the sandbox in `scripts/track_b_m2m/`, do NOT wire into Electron, do NOT ship.
    - Write `docs/track_b_shelved.md` summarizing what works and the exact blocker.
  - **If licensing came back RED (refused):**
    - Delete `external/motion2motion_upstream/`.
    - Keep `morphology_classifier.py` + `donor_provider.py` + `correspondence.py` (those are ours, reusable for any future retargeter).
    - Pivot: write `docs/track_b_pivot.md` proposing GenMM (the parent paper, check its license) as a clean-room replacement.
- **Expected commit:** one of:
  - `feat(track-b): ship Motion2Motion behind feature flag (license granted)`
  - `chore(track-b): shelve pending license response`
  - `chore(track-b): pivot away from Motion2Motion (license refused) — keep reusable infra`

---

## Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|------------|--------|------------|
| 1 | **License email goes unanswered for 7 days** | High (academic authors, SIGGRAPH timing) | Blocks ship | Day 1 send + Day 4 follow-up; Day 7 fallback to GenMM pivot already scoped |
| 2 | **Truebones donor data cannot be redistributed → no shippable donor library** | Certain (vendor EULA) | High | `DonorProvider` abstraction with `SyntheticDonorProvider` baseline + Mixamo path (CC0) for biped/quadruped; "bring your own donor" UX for power users |
| 3 | **M2M output quality on non-demo morphologies (dragon, hexapod) collapses** | Medium (paper only shows curated cases) | Medium | Day 6 battery exposes this early; Day 7 decision allows per-archetype dispatch with AnyTop fallback — no need for M2M to win everywhere |

Secondary risks logged but not in top 3: CPU inference time (mitigation: cache results per-archetype/per-motion), joint-name-collision parser bug (mitigation: run `add_random_string_of_joints.py` preprocessor inside `pipeline.py`), upstream repo gets force-pushed (mitigation: `UPSTREAM_COMMIT.txt` pinned snapshot in `external/`).

---

## Go/No-Go criteria

- **After Day 3 we should be able to:** classify any FabMesh GLB into an archetype and resolve a donor BVH path (synthetic backend at minimum), with zero third-party data committed to the repo. **No-go if:** `DonorProvider` interface still ambiguous or morphology→species map isn't single-source-of-truth.
- **After Day 5 we should be able to:** run one CLI command (`python -m scripts.track_b_m2m c:/tmp/dragon_rig.glb idle out.glb`) and get a non-broken animated GLB out, in <90 s on CPU, on at least one morphology (dragon). **No-go if:** pipeline crashes mid-way, output has NaN joints, or wall-clock >5 min.
- **Day 7 ship decision:**
  - **Yes (ship behind flag)** if: licensing GREEN **AND** Day-6 battery shows M2M beats AnyTop on at least 1 archetype (likely `winged` or `serpent`).
  - **Yes (shelve)** if: licensing still SILENT but Day-6 battery is promising — keep code, don't ship, don't delete.
  - **No (pivot to GenMM clean-room)** if: licensing RED, or Day-6 shows M2M loses to AnyTop on all 3 archetypes.

---

## Decision: parallel-safe with Track A?

**Confirmed parallel-safe.** Track A is actively iterating on `scripts/anytop_retarget.py` (commits `9681dd7`, `a8a4f63`, `94c66b2` all touch this file and its companion `modal_app/_ref_anim.py`). Track B's entire footprint sits **outside** Track A's blast radius:

### Track A active files (DO NOT TOUCH from Track B)
- `scripts/anytop_retarget.py` (modified, in-flight)
- `scripts/anytop_bridge.py`
- `modal_app/_ref_anim.py` (modified, in-flight)
- `modal_app/_anytop_anim.py`
- `scripts/.gpu_limit.json` (modified)
- `.claude/settings.json` (modified)

### Track B new files (all under `scripts/track_b_m2m/` or `external/`)
- `scripts/track_b_m2m/__init__.py`
- `scripts/track_b_m2m/README.md`
- `scripts/track_b_m2m/smoke_upstream.py`
- `scripts/track_b_m2m/donor_provider.py`
- `scripts/track_b_m2m/archetype_to_donor.py`
- `scripts/track_b_m2m/correspondence.py`
- `scripts/track_b_m2m/pipeline.py`
- `scripts/track_b_m2m/__main__.py`
- `scripts/track_b_m2m/quality_battery.py`
- `scripts/track_b_m2m/test_*.py`
- `external/motion2motion_upstream/` (vendored snapshot)
- `venvs/track_b_m2m/` (isolated venv, gitignored)

### Track B shared reads (read-only — must not edit)
- `scripts/morphology_classifier.py` — consumed as a library, no modifications planned.
- `scripts/bvh_to_gltf_anim.py` — consumed as a library for skeleton ↔ BVH conversion. **If modification needed**, fork as `scripts/track_b_m2m/_bvh_io.py` rather than edit the shared file.
- `scripts/bvh_patch_leaves.py` — read-only.
- `scripts/fbx_motion.py` — read-only.

### Conflict checks (run at start of each day)
```powershell
git diff --name-only master HEAD -- scripts/anytop_retarget.py scripts/anytop_bridge.py modal_app/_ref_anim.py modal_app/_anytop_anim.py
# Track B commits MUST return empty.
git diff --name-only master HEAD -- scripts/track_b_m2m/ external/motion2motion_upstream/
# Track A commits MUST return empty.
```

If either check ever shows cross-contamination, **stop Track B immediately** and rebase onto a fresh master before continuing.

### Shared resources to watch (non-file)
- GPU: Track B is CPU-only by design (M2M README explicitly says CPU). Zero contention with Track A's fine-tune on the RTX 5080.
- Disk: `external/motion2motion_upstream/` is <50 MB. Negligible.
- Python env: separate venv `venvs/track_b_m2m/`. No site-packages collision.

**Verdict: SAFE TO RUN IN PARALLEL.** No file conflicts, no GPU contention, no shared mutable state.
