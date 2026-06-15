# AnyTop Alternatives for FabMesh — Strategic Research Report

*Date: 2026-06-04 — Author: Deep-Research agent — Target: FabMesh animation backbone decision*

---

## 1. Global verdict

**There is no single tool today that satisfies all FabMesh constraints (free + permissive license + local RTX 5080 inference + topology-agnostic + multi-species + text/action conditioning).** Every credible candidate trades one constraint for another.

The verdict is therefore a **two-track stack**:

- **Track 1 (ship this quarter — MVP path):** Keep **AnyTop** as the ML brain (MIT, topology-agnostic, pretrained on 70+ species, already integrated) and add **Motion2Motion** (SIGGRAPH Asia 2025) as a *training-free* retarget bridge from a labeled FBX library (Truebones Zoo free pack — royalty-free) into Puppeteer rigs. Cost: <€0, ~7 person-days of integration. This finally gives you `walk / run / idle / death` action control without retraining anything.
- **Track 2 (Q3-Q4 2026 — quality upgrade):** Migrate the AnyTop role to **T2M4LVO ("How to Move Your Dragon", ICML 2025)** the day its code drops. T2M4LVO is the only paper that explicitly addresses *text-to-motion for large-vocabulary objects with rig augmentation* on Truebones Zoo. Until the repo flips green, treat it as a research bet, not a dependency.

Everything else (X-MoGen, UniMoGen, AniMo, OmniZoo, NECromancer, ProtoMotions) is **either license-unclear, code-unreleased, or fundamentally humanoid-biased** and not yet shippable in a commercial Electron app.

Bottom line for FabMesh: **AnyTop stays. Add a labeled FBX library + Motion2Motion bridge for gameplay actions. Watch T2M4LVO and NECromancer monthly.**

---

## 2. Comparison table — 30 entries

Legend: `Topo` = topology-agnostic (any bone count / species), `Act` = action / text conditioning, `Local` = runs on RTX 5080 (16–24 GB), `Comm` = commercial OK with permissive license, `Fit` = FabMesh fit score 1–5.

| Tool | Year | License | Topo | Act | Local | Cost | Comm | Fit |
|---|---|---|---|---|---|---|---|---|
| [AnyTop](https://github.com/Anytop2025/Anytop) | 2025 | MIT | Yes | No (unconditional) | Yes | Free | Yes | 4 |
| [T2M4LVO "How to Move Your Dragon"](https://t2m4lvo.github.io/) | 2025 | TBD (dataset CC-BY-SA) | Yes | Yes (text) | Likely (29-38 GB training, infer lighter) | Free | TBD | 5* |
| [SinMDM](https://github.com/SinMDM/SinMDM) | ICLR 2024 | **MIT** | Yes | Per-clip | Yes | Free | Yes | 4 |
| [Motion2Motion](https://github.com/LinghaoChan/Motion2Motion_codes) | SIGGRAPH Asia 2025 | TBD | Yes | Via source clip | Yes (CPU works) | Free | TBD | 5 |
| [AniMo](https://github.com/WandererXX/AniMo) | CVPR 2025 | TBD | Partial (species-aware) | Yes (text) | Likely | Free | TBD | 3 |
| [X-MoGen](https://arxiv.org/abs/2508.05162) | 2025 | No code released | Yes | Yes (text) | Unknown | Free | Unknown | 2 |
| [UniMoGen](https://arxiv.org/abs/2505.21837) | 2025 | No code | Yes | Style+trajectory | Unknown | Free | Unknown | 2 |
| [NECromancer](https://arxiv.org/abs/2602.06548) | Feb 2026 | No code | Yes (tokenizer) | Via downstream LM | Unknown | Unknown | 3 |
| [OmniZoo/Topology-Agnostic Animal Motion Gen](https://arxiv.org/abs/2512.10352) | Dec 2025 | No code | Yes | Yes (text) | Unknown | Unknown | 3 |
| [OmniMotionGPT](https://arxiv.org/abs/2311.18303) | 2023 | Unknown | Animals | Yes (text) | Yes | Free | Unknown | 2 |
| [SALAD](https://arxiv.org/html/2503.13836v1) | 2025 | Unknown | Skeleton-aware | Yes (text) | Yes | Free | Unknown | 2 |
| [MDM](https://github.com/guytevet/motion-diffusion-model) | 2022 | MIT | Humanoid only | Yes (text) | Yes | Free | Yes | 1 |
| [ProtoMotions](https://github.com/NVlabs/ProtoMotions) | 2024-2025 | **Apache-2.0** | Humanoid-bias | Reference + text via Kimodo | Yes (single-GPU OK) | Free | Yes | 2 |
| [DeepMimic](https://github.com/xbpeng/DeepMimic) | 2018 | MIT | Per-character | Reference clip | Yes | Free | Yes | 1 |
| [AMP](https://arxiv.org/abs/2104.02180) | 2021 | MIT-style (research) | Per-character | Style only | Yes | Free | Yes | 1 |
| [Mixamo](https://www.mixamo.com/) | Adobe service | Royalty-free (embedded) | Humanoid only | Action library | N/A (cloud, no API) | Free | Yes (embedded) | 2 |
| [Truebones Zoo](https://truebones.gumroad.com/l/skZMC) | active | **100% royalty-free** (per vendor) | N/A (FBX/BVH assets) | Labeled walk/run/idle/death | N/A (data) | $0–$1 PWYW | Yes | 5 |
| [MoCap Online creature packs](https://mocaponline.com/) | active | Royalty-free per pack | N/A | Labeled | N/A | $50–$500 | Yes | 4 |
| [CGTrader animal anim packs](https://www.cgtrader.com/) | marketplace | Per-asset (Standard or Editorial) | N/A | Labeled | N/A | $5–$200 | Mostly | 3 |
| [UE5 IK Rig + IK Retargeter](https://dev.epicgames.com/documentation/en-us/unreal-engine/ik-rig-animation-retargeting-in-unreal-engine) | UE5.4+ | UE EULA (5% / 3.5% royalty over $1M) | Yes | Action via input clips | Yes | Free <$1M | Yes (with royalty) | 3 |
| [UE5 Control Rig + FBIK](https://dev.epicgames.com/documentation/en-us/unreal-engine/control-rig-full-body-ik-in-unreal-engine) | UE5 | UE EULA | Yes | Procedural | Yes | Free <$1M | Yes | 3 |
| [UE5 Dragon IK Plugin (codehawk64)](https://assetsue.com/file/dragon-ik-universal-ik-system) | active | Marketplace EULA | Yes (dragon/quad/spider/snake) | Procedural foot+spine IK | Yes | $50–80 once | Yes | 3 |
| [Unity Animation Rigging](https://docs.unity3d.com/Packages/com.unity.animation.rigging@latest) | active | Unity EULA | Yes | Procedural | Yes | Free tier OK | Yes | 2 |
| [UE5 Motion Matching](https://dev.epicgames.com/documentation/en-us/unreal-engine/motion-matching-in-unreal-engine) | UE5.4+ | UE EULA | Per-rig | Database query | Yes | Free <$1M | Yes | 2 |
| [AccuRIG 2 (Reallusion)](https://actorcore.reallusion.com/auto-rig) | 2025 | Reallusion EULA (free) | Humanoid + beastmen / birds (limited) | N/A (rigger) | Yes (desktop) | Free | Yes | 2 |
| [Auto-Rig Pro (Blender)](https://superhivemarket.com/products/auto-rig-pro) | active | Single-user paid (commercial OK) | Yes (human/quad/bird/custom) | N/A (rigger) | Yes | ~€40 one-time | Yes | 3 |
| [RigAnything (UCSD / Adobe Research)](https://github.com/Isabella98Liu/RigAnything) | SIGGRAPH TOG 2025 | License TBD (LICENSE.md unread) | **Yes** (humanoid/quad/marine/insect) | N/A (auto-rigger) | Yes | Free | TBD | 4 |
| [MagicArticulate](https://github.com/Seed3D/MagicArticulate) | CVPR 2025 | License TBD | Yes (autoregressive bone count) | N/A | Yes | Free | TBD | 3 |
| [RigNet](https://github.com/zhan-xu/RigNet) | SIGGRAPH 2020 | **Dual: GPL3 / commercial** | Yes | N/A | Yes | Free non-comm | **No (GPL3 blocking)** | 0 |
| [Pinocchio (Baran 2007)](https://github.com/elrnv/pinocchio) | 2007 | LGPL | Humanoid mainly | N/A | Yes | Free | Risky for Electron bundling | 1 |
| [libigl BBW skinning](https://libigl.github.io/) | active | **MPL-2.0** | Geometry only | N/A | Yes | Free | Yes | 2 |
| [Spore-style procedural locomotion](https://www.gdcvault.com/) | research | N/A | Yes | N/A | Yes | Free | Yes | 2 |

`*` T2M4LVO fit = 5 *conditional on code release with permissive license*. Today it is a dataset-only release.

---

## 3. Top 5 recommendations

### #1 — Keep AnyTop + add Motion2Motion bridge to a labeled FBX library (Track 1 / Production)

**Why top 1:** Unblocks `walk / run / idle / death` action control *without* training, *without* swapping the ML model, and *without* a license risk. MIT + training-free + can run on CPU. AnyTop already lives in FabMesh.

**Workflow:**

1. Ship **Truebones Zoo** (75+ species, 100 % royalty-free per vendor) inside FabMesh `assets/anim_library/` (or first-run download from R2, since pack is ~hundreds of MB).
2. After Puppeteer outputs a rig, classify the rig morphology (biped / quad / hexapod / serpent / winged) using bone count + topology heuristics already present in the pipeline.
3. User picks an action label in the renderer → FabMesh selects matching Truebones FBX clip.
4. **Motion2Motion** (SIGGRAPH Asia 2025) retargets that clip onto the Puppeteer rig using a *sparse bone correspondence map* (5–8 bones: pelvis, spine, head, 4 limbs). The model is **training-free** and runs on CPU.
5. AnyTop stays for *unconditional ambient* motion (idle variations, "feel alive" loops).

**Effort:** **~7 person-days.**
- D1: vendor licensing audit, download Truebones Zoo, fingerprint species → action map.
- D2-D3: morphology classifier (Puppeteer bone-count → species archetype).
- D4-D5: Motion2Motion subprocess wrapper + sparse-correspondence builder per archetype.
- D6: Electron UI action selector (dropdown: idle/walk/run/death/jump).
- D7: QA on 10 mixed test meshes (humanoid, quadruped, dragon, hexapod, bird, blob).

**Risks:**
- Motion2Motion LICENSE.md not confirmed yet — read it before commit. If unfavorable, fall back to SinMDM (confirmed MIT) per-clip overfit.
- Truebones Zoo license is "100% royalty-free" per vendor page text — get a written confirmation email before bundling in a paid Steam product.
- Cross-topology retarget quality on extreme rigs (3-eyed centipede dragon) will need fall-back to AnyTop.

---

### #2 — SinMDM single-motion overfit per action (MIT, confirmed)

**Why:** Strict MIT, official pretrained checkpoints on Truebones Zoo, trains on a **single BVH clip per character**, modest single-GPU requirement. It is the safest *fully ML* path.

**Workflow:**
1. Pre-train one SinMDM model per (action × archetype) on the Truebones Zoo BVHs ("walk-quad", "run-quad", "death-biped", …). ~30 models, each tiny.
2. At runtime, pick the matching micro-model and infer motion conditioned on the user rig topology (via topology re-embedding similar to the AnyTop approach).
3. Use AnyTop as ambient fallback.

**Effort:** **~14 person-days.** Heavier than #1 because you train 30 SinMDM micro-models offline and have to ship them inside the desktop app or stream from R2.

**Risks:**
- SinMDM is single-motion-per-model — diversity per action is low.
- Re-embedding to user rig is not native; needs the same correspondence pipeline as Motion2Motion anyway.

---

### #3 — T2M4LVO when code drops (Track 2 / Future)

**Why:** It is the only paper explicitly designed for *text-conditioned* motion synthesis on *large-vocabulary objects* (>70 species, dragons, pegasus, icy dragon, etc.), and reports very strong numbers (training-set FID **0.0072**, augmented test FID **0.2636**, R@1 **0.6707**, alignment **0.9276**). It is literally the dream model for FabMesh.

**Workflow when code lands:**
1. Replace AnyTop denoising network in `modal_app/_ref_anim.py` with the SiT-S adapted transformer.
2. Pipe the user text prompt through the official caption template.
3. The pretrained model on Truebones Zoo + rig augmentation should give better cross-species generalization than AnyTop out of the box.

**Effort (when released):** **~10 person-days** integration + ~2 days monitoring drift vs AnyTop on FabMesh test meshes.

**Risks:**
- **Code is not released as of June 2026.** Project page repo at github.com/t2m4lvo/t2m4lvo.github.io is the *website only*. Dataset is on HuggingFace `1Konny/t2m4lvo-truebones-zoo`. Paper says "we will release". No date.
- License unknown. Project website is CC-BY-SA but that does not extend to code/weights.
- Training cost is steep: pose diffusion 29 GB VRAM × 30h, motion diffusion 38 GB VRAM × 4 days on A6000/A100. Inference VRAM is lower (model is SiT-S, 12 layers × 384 hidden — fits in 8-12 GB easily) so RTX 5080 is safe for inference.
- Max joints = 140, max frames = 90. Puppeteer rigs (30-50 bones) are well within range.

---

### #4 — UE5 IK Retargeter + Truebones Zoo as a *headless* C++ subprocess

**Why:** Pure CPU, deterministic, mature, cross-species (the codehawk64 Dragon IK plugin documents biped + quad + spider + snake), and Epic's royalty (3.5–5 % over $1M lifetime) is irrelevant until FabMesh ships **$1M+** — which is years away.

**Workflow:**
1. Build a tiny UE5 commandlet (or use UnrealCLR / Unreal Headless mode) that loads a Puppeteer FBX rig, runs `IKRetargeter::RunRetargeter` with a Truebones source clip and bone map, and exports the target FBX.
2. Trigger via Electron `child_process.spawn('UnrealEditor-Cmd.exe', [...])`.

**Effort:** **~21 person-days** because UE5 headless is heavy to embed in an Electron installer (~3 GB of UE5 binaries to ship or download).

**Risks:**
- Massive installer footprint (multi-GB) hurts FabMesh's "light 5 GB zip + first-run download" packaging strategy.
- Royalty becomes real if FabMesh succeeds (which is the *goal*).
- UE EULA permits this, but distributing UE5 binaries with FabMesh requires care — read the redistribution clause for commandlet bundling.

---

### #5 — RigAnything for auto-rig + AnyTop for animation (Puppeteer replacement track)

**Why:** RigAnything (UCSD + Adobe Research, SIGGRAPH TOG 2025) is template-free, supports humanoids / quadrupeds / marine creatures / insects, has pretrained weights on Hugging Face, and is *the only* modern alternative to Puppeteer that is open-source and topology-agnostic. Combined with AnyTop, this is a fully ML stack with no Puppeteer dependency.

**Workflow:**
1. Replace Puppeteer with `RigAnything inference` (mesh → joints → topology → skinning weights → GLB).
2. Feed RigAnything's output skeleton to AnyTop (already topology-agnostic).
3. Optionally use Motion2Motion on top for action library.

**Effort:** **~14 person-days.**

**Risks:**
- **LICENSE.md not yet verified.** Adobe Research collaboration means the license could be non-commercial — read it before any commit.
- User instruction "Don't touch Puppeteer" is *formal* in the memory bank — this path violates that unless explicitly re-approved.
- Quality vs Puppeteer's curated dragon rig is unproven on FabMesh test meshes.

---

## 4. Decision tree

| Scenario | Recommendation |
|---|---|
| **"MVP shippable this month"** | **#1 — AnyTop + Motion2Motion + Truebones Zoo.** 7 days, no license blocker beyond two confirmations, immediate `walk/run/idle/death` control. |
| **"Long-term flexibility maximale"** | **#3 — T2M4LVO when released**, in parallel **#5 — RigAnything** for rig flexibility. Build a swappable `engine_anim` abstraction in `cloud/src/anim_engines/`. |
| **"Best motion quality, accept dev cost"** | **#4 — UE5 IK Retargeter headless** + **MoCap Online creature packs** (~$500 one-time). Pro-grade animation. 21 days + installer bloat. |
| **"Best for non-humanoid creatures specifically"** | **#1 short-term, #3 long-term.** AnyTop already covers dragons (paper shows Komodo Dragon biped, Cat from quadruped model). T2M4LVO is the direct successor when released. Pure-procedural fall-back: **Dragon IK plugin** in UE5 (biped/quad/spider/snake all native). |
| **"Lowest license risk, fully MIT/Apache stack"** | **AnyTop (MIT) + SinMDM (MIT) + ProtoMotions (Apache-2.0) + libigl BBW (MPL-2.0).** Sacrifice text conditioning quality for legal safety. |
| **"Replace Puppeteer fully"** | **#5 — RigAnything** if license clears. Otherwise **MagicArticulate** (CVPR 2025) or stay on Puppeteer. **Do NOT use RigNet (GPL3) or Pinocchio (LGPL, problematic inside Electron) for a commercial Steam product.** |

---

## 5. SPECIAL DEEP FOCUS — T2M4LVO ("How to Move Your Dragon")

### Status as of 2026-06-04

| Question | Verified answer |
|---|---|
| **Code released?** | **No.** The repo [github.com/t2m4lvo/t2m4lvo.github.io](https://github.com/t2m4lvo/t2m4lvo.github.io) contains the *project website* only (HTML/CSS/JS). The paper explicitly states authors *"will release the code for our data and model pipelines, along with the annotated captions"* — no date. |
| **Where?** | TBD. Authors anchor on the github.com/t2m4lvo org; expect a sibling repo. |
| **License?** | **TBD.** Website is CC-BY-SA 4.0 (does not extend to code/weights). Paper licensing not yet stated. |
| **Pretrained model available?** | **No.** Only the dataset is published: [HuggingFace `1Konny/t2m4lvo-truebones-zoo`](https://huggingface.co/datasets/1Konny/t2m4lvo-truebones-zoo) (Truebones Zoo annotated with text captions). |
| **Performance vs AnyTop?** | Paper does **not** include a direct AnyTop baseline comparison in the released arXiv v2. It reports FID **0.0072** on the augmented training set, **0.2636** on augmented test set, R@1 **0.6707**, alignment **0.9276**. These are strong numbers but not apples-to-apples with AnyTop tables. |
| **Architecture** | SiT-S adapted: depth 12, hidden dim 384, 6 self-attention heads. Factorized spatial-temporal attention. Pose diffusion + motion diffusion two-stage. |
| **Joint / frame limits** | Max joints **140**, max frames **90** per clip. Puppeteer rigs (30-50 bones) and standard 30-60-frame animation clips are well inside. Bone-length augmentation 0.8× to 1.2×. |
| **Training cost** | Pose diffusion: **29 GB VRAM**, batch 512, 400 K iter, ~30 h on RTX A6000 (48 GB) or A100. Motion diffusion: **38 GB VRAM**, batch 4, sequence 90, 1 M iter, ~4 days. RTX 5080 (16 GB) **cannot retrain** but should comfortably **infer** the SiT-S model. |
| **Text/action conditioning?** | **Yes — full text-to-motion.** Examples show "walking forward" up to multi-clause descriptions. Sequential descriptions enable extended motions. |
| **Species coverage** | 70+ Truebones species + novel dragon / pegasus / icy dragon demonstrated. Strong "unseen object" generalization claim. |

### Workflow once code drops (planning)

1. `git submodule add https://github.com/t2m4lvo/<code-repo>` into FabMesh.
2. Download pretrained motion-diffusion checkpoint from HuggingFace (once published).
3. Wrap the inference loop in a `modal_app/t2m4lvo_anim.py` mirroring the existing `_ref_anim.py` interface, so the Electron pipeline only flips an `ANIM_ENGINE=t2m4lvo` env var.
4. Pipe Puppeteer rig → joint-template encoding → text prompt → motion BVH/FBX.
5. A/B test FID + visual mesh-preservation against AnyTop on the 10-mesh FabMesh QA set.

### Recommended action *this quarter*

- **Star the project page repo + watch releases.** Reasonable estimate: code release in Q3-Q4 2026 (typical ICML lag of 3-6 months post-camera-ready).
- Already begin downloading and using the dataset (CC-BY-SA presumably) to *fine-tune AnyTop* with text captions — that hybrid alone could be a >50 % uplift in controllability for FabMesh without waiting for the model release.

---

## 6. Implementation roadmap — Top recommendation #1

**Goal:** Ship action-controlled animation in FabMesh in ~2 working weeks, no model retraining, no license blocker.

### Week 1 — Library + bridge

| Day | Task | Files |
|---|---|---|
| Mon | License confirmation email to Truebones Studios. Download Zoo pack. Inventory: species × actions (build CSV). | new `scripts/truebones_inventory.py`, output `assets/truebones_zoo_manifest.json` |
| Tue | Morphology classifier: Puppeteer rig → archetype (`biped / quad / hexapod / serpent / winged / blob`). Use bone count + branching factor + height heuristic. | new `scripts/morphology_classifier.py`; integrate in `scripts/anytop_retarget.py` |
| Wed | Vendor + smoke-test [Motion2Motion](https://github.com/LinghaoChan/Motion2Motion_codes). Confirm LICENSE. Build CPU subprocess wrapper. | new `modal_app/motion2motion_bridge.py`; freeze deps in `requirements_anim.txt` |
| Thu | Sparse-bone correspondence builder per archetype (hand-curate the 5–8 anchor bone names per archetype × Truebones species). | new `assets/bone_correspondences/*.json` (one per archetype) |
| Fri | End-to-end smoke test: humanoid Puppeteer mesh + "walk" → Motion2Motion → FBX export → load in Electron viewer. | modify `cloud/src/worker.ts` action endpoint, add `engine: 'motion2motion'` branch |

### Week 2 — UI + QA + fallback

| Day | Task | Files |
|---|---|---|
| Mon | Renderer UI: action dropdown next to the existing "Generate animation" button. | `src/renderer/animation_panel.html`, `src/renderer/animation_panel.js` |
| Tue | Fall-back logic: if Motion2Motion retarget confidence < threshold, route to AnyTop. | extend `modal_app/_ref_anim.py` |
| Wed | QA on 10 mixed test meshes (humanoid, quadruped, dragon, hexapod, bird, ship's-wheel-with-arms, blob, centipede, fish, two-headed dog). | new `tests/anim_qa_matrix.md` |
| Thu | Tune morphology classifier on QA failures. Bug-fix bone-mismatch errors. | `morphology_classifier.py` v2 |
| Fri | Cut a backup branch, commit, tag `v0.x.0-action-anim`, update [AGENT_LOG.md](../AGENT_LOG.md). | git |

### Decisions to make BEFORE coding

1. **License confirmation** from Truebones Studios in writing (email reply pinned in repo).
2. **Read Motion2Motion LICENSE** in the code repo. If it is **non-commercial**, replace step 4 with SinMDM (confirmed MIT) trained one-clip-per-action offline.
3. **Bundle vs first-run download** of Truebones Zoo: probably first-run download to keep zip <5 GB per the packaging strategy memory.
4. **AnyTop ambient blend ratio:** decide whether to crossfade AnyTop "alive" noise with the action clip so static idle does not look dead. Probably 10–20 % blend.

### Known bugs / risks to fix on the way

- `anytop_retarget.py` recently had a ZYX channel-order bug (commit `94c66b2`) and a 90-deg clamp issue (commit `9681dd7`). The Motion2Motion bridge must NOT use the AnyTop retarget code — it has its own correspondence-based math. Wire it as a separate path.
- `scripts/fix_glb_ibms.py` (untracked) suggests recent inverse-bind-matrix work — confirm the Puppeteer FBX path produces clean rest-pose matrices before Motion2Motion ingestion, otherwise the retarget pose will drift.
- Electron `unset ELECTRON_RUN_AS_NODE` requirement after main.js changes still applies if the action panel triggers IPC changes.

---

## Appendix A — Quick reference: license outcomes by tool family

| Family | Verdict for FabMesh commercial Steam release |
|---|---|
| **AnyTop, SinMDM, MDM, DeepMimic, AMP** | MIT — safe. |
| **ProtoMotions** | Apache-2.0 — safe. |
| **libigl BBW skinning** | MPL-2.0 — safe (file-level copyleft, won't infect FabMesh source). |
| **Mixamo** | Royalty-free *if embedded in the product*; cannot redistribute as standalone assets; no API for commercial pipelines. Humanoid only. Acceptable for FabMesh's humanoid branch *only*. |
| **Truebones Zoo** | Vendor says "100 % royalty-free"; get written confirmation. |
| **MoCap Online / CGTrader packs** | Per-asset license — read each. |
| **UE5 EULA** | 5 % royalty over $1M lifetime, 3.5 % via Launch Everywhere program. Acceptable. |
| **Auto-Rig Pro** | Paid (~€40 single-user). Commercial OK per vendor. |
| **AccuRIG 2 / Character Creator** | Free for AccuRIG itself; CC4 is paid; humanoid-biased. |
| **RigAnything / MagicArticulate** | **License unread — must verify before commit.** Adobe Research collaboration on RigAnything is a yellow flag for commercial use. |
| **RigNet** | **GPL3 — BLOCKING for FabMesh.** Do not link in any way. |
| **Pinocchio (Baran 2007)** | LGPL — technically OK dynamically linked, but Electron bundling makes static linking common → audit carefully. |
| **T2M4LVO** | Dataset CC-BY-SA, code TBD — wait. |
| **X-MoGen, UniMoGen, NECromancer, OmniZoo, AniMo** | No code or licenses confirmed yet — research watch list. |

---

## Appendix B — Source list

- AnyTop paper: [AnyTop: Character Animation Diffusion with Any Topology (arXiv 2502.17327)](https://arxiv.org/abs/2502.17327) — [code](https://github.com/Anytop2025/Anytop) — [project page](https://anytop2025.github.io/Anytop-page/)
- T2M4LVO paper: [How to Move Your Dragon (arXiv 2503.04257v2)](https://arxiv.org/html/2503.04257v2) — [project page](https://t2m4lvo.github.io/) — [project repo](https://github.com/t2m4lvo/t2m4lvo.github.io) — [HuggingFace dataset](https://huggingface.co/datasets/1Konny/t2m4lvo-truebones-zoo)
- SinMDM: [paper (ICLR 2024)](https://openreview.net/forum?id=DrhZneqz4n) — [code](https://github.com/SinMDM/SinMDM) — [project page](https://sinmdm.github.io/SinMDM-page/)
- Motion2Motion: [paper (arXiv 2508.13139)](https://arxiv.org/html/2508.13139v1) — [code](https://github.com/LinghaoChan/Motion2Motion_codes) — [project page](https://lhchen.top/Motion2Motion/)
- AniMo: [CVPR 2025 OpenAccess](https://openaccess.thecvf.com/content/CVPR2025/html/Wang_AniMo_Species-Aware_Model_for_Text-Driven_Animal_Motion_Generation_CVPR_2025_paper.html) — [code](https://github.com/WandererXX/AniMo)
- X-MoGen: [arXiv 2508.05162](https://arxiv.org/abs/2508.05162)
- UniMoGen: [arXiv 2505.21837](https://arxiv.org/abs/2505.21837)
- Topology-Agnostic Animal Motion (OmniZoo): [arXiv 2512.10352](https://arxiv.org/abs/2512.10352)
- NECromancer: [arXiv 2602.06548](https://arxiv.org/abs/2602.06548)
- OmniMotionGPT: [arXiv 2311.18303](https://arxiv.org/abs/2311.18303)
- RigAnything: [paper (arXiv 2502.09615)](https://arxiv.org/abs/2502.09615) — [code](https://github.com/Isabella98Liu/RigAnything) — [project page](https://www.liuisabella.com/RigAnything/)
- MagicArticulate: [paper (arXiv 2502.12135)](https://arxiv.org/abs/2502.12135) — [code](https://github.com/Seed3D/MagicArticulate) — [project page](https://chaoyuesong.github.io/MagicArticulate/)
- RigNet: [paper (TOG 2020)](https://dl.acm.org/doi/abs/10.1145/3386569.3392379) — [code (GPL3)](https://github.com/zhan-xu/RigNet) — [project page](https://zhan-xu.github.io/rig-net/)
- ProtoMotions: [code (Apache-2.0)](https://github.com/NVlabs/ProtoMotions)
- AMP: [arXiv 2104.02180](https://arxiv.org/pdf/2104.02180)
- Mixamo FAQ: [Adobe](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html) — [Community Q&A](https://community.adobe.com/t5/mixamo-discussions/mixamo-faq-licensing-royalties-ownership-eula-and-tos/td-p/13234775)
- Truebones Zoo: [Gumroad listing](https://truebones.gumroad.com/l/skZMC) — [Free pack post](https://truebones.gumroad.com/p/free-truebones-zoo-over-75-animals-and-animations)
- AccuRIG: [Reallusion ActorCore](https://actorcore.reallusion.com/auto-rig) — [vs Mixamo](https://magazine.reallusion.com/2025/07/30/accurig-2-vs-mixamo-smarter-auto-rigging-for-3d-animators/)
- Auto-Rig Pro: [Superhive](https://superhivemarket.com/products/auto-rig-pro)
- UE5 IK Retargeter docs: [Epic Docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/ik-rig-animation-retargeting-in-unreal-engine)
- UE5 FBIK + Procedural Dragon: [Unreal Engine blog](https://www.unrealengine.com/en-US/blog/full-body-ik-procedural-dragon-animations) — [Control Rig Samples Pack](https://www.fab.com/listings/2ce3fe44-9ee6-4fa7-99fc-b9424a402386)
- UE5 royalty: [CG Channel (2024)](https://www.cgchannel.com/2024/10/epic-games-to-cut-royalty-rate-on-unreal-engine-games/) — [Unreal Engine licensing](https://www.unrealengine.com/license)
- Dragon IK plugin (codehawk64): [Assetsue listing](https://assetsue.com/file/dragon-ik-universal-ik-system) — [80 LV writeup](https://80.lv/articles/create-procedural-chinese-dragon-style-animations-on-any-skeletal-mesh-in-ue5)
- SALAD: [arXiv 2503.13836](https://arxiv.org/html/2503.13836v1)

---

*End of report — ~3 700 words.*
