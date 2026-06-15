# marklalon vs our AnyTop fork — final decision

**Date:** 2026-06-05
**Author:** Claude Code (synthesis of architecture deep-dive + retarget audit + current training state)
**Status:** Decision document — actionable today

---

## TL;DR (3 lines)

1. **Keep training our fork** — step 243k / ~12.7k fine-tune steps is too far in to throw away, and marklalon ships zero compatible weights so a switch costs 20-40 days of new training on the 5080.
2. **Lift marklalon's `utils/retarget.py` + `retarget_cache.py` into our `scripts/` now** — solves the 1957deg-eaten Dragon clip directly, no model retraining required, attribution-only cost.
3. **Track `feat/global-energy-conditioning` upstream** — if marklalon publishes weights, re-evaluate; until then their architectural advantage is theoretical and our fork is the only deployable path.

---

## Should we continue the current training, switch to marklalon, or hybrid?

**Recommendation: Hybrid (Plan C). Continue current training to convergence. Port marklalon's retarget stack into our scripts. Do NOT migrate the model architecture.**

### Effort breakdown

| Action | Effort | Calendar |
|---|---|---|
| Let current fine-tune finish (243k -> target convergence) | 0 dev-days, GPU only | 3-7 days wall clock |
| Lift `utils/retarget.py` (1843 lines) into `scripts/anytop_retarget_v2.py` with CC BY-NC attribution header | 1 day | Day 1 |
| Lift `utils/retarget_cache.py` + adapt to our project layout | 0.5 day | Day 1 |
| Wire Puppeteer 47-bone target spec into the new retargeter (target rig descriptor) | 2 days | Day 2-3 |
| Bench new retargeter on the Dragon clip currently losing 1957deg of motion | 0.5 day | Day 3 |
| A/B compare against current `scripts/anytop_retarget.py` on idle_breathe / walk / run / death | 1 day | Day 4 |
| Optional: lift `tools/extract_action_categories.py` to replace filename heuristic in next fine-tune run | 0.5 day | Day 5 |
| **Total hybrid effort** | **~5.5 dev-days** | **1 calendar week** |

Compare to wholesale switch: **30-55 dev-days** dominated by retraining from scratch on Truebones with no public checkpoint to bootstrap from. The hybrid captures ~80% of marklalon's *deployable* value (the retarget stack) at ~10% of the cost.

---

## Concrete next steps (today)

1. **Do not touch the running fine-tune.** Loss 0.06-0.10 at step 243k is healthy. The "180deg max joints suggest quaternion flips" symptom is a *retarget* artifact (basis-change quat math wrap), not a model artifact — switching the model would not fix it.
2. **Read `marklalon/LICENSE` directly.** I could not verify its contents from the audit inputs. Confirm it inherits CC BY-NC 4.0 from upstream AnyTop. If yes, both forks share the same commercial blocker and licensing is not a tiebreaker. If marklalon re-licensed (unlikely but possible), revisit.
3. **Pin a marklalon commit.** 80 commits in the last month, 6 live feature branches. Pick the head of `feat/retarget_v2` as of 2026-06-05 and freeze it. Do not chase main.
4. **Create `scripts/anytop_retarget_v2.py`** — copy `utils/retarget.py` from the pinned marklalon commit verbatim with a CC BY-NC attribution header. Run side-by-side with the existing `scripts/anytop_retarget.py` on the Dragon idle_breathe clip. The G2 swing+twist decomposition is the specific feature that should kill the 180deg joint flip / 1957deg motion loss.
5. **Append the decision to `AGENT_LOG.md`** before any commit (project hook requires it). Entry: "2026-06-05 — Decided hybrid path. Retarget stack lifted from marklalon (pinned commit X). Model fork stays on our action_prompt path. Architectural features (FiLM energy, loop cond, cross-limb) parked pending marklalon weight release."

---

## Risks of each path

### Plan A — continue our fork, no marklalon at all
- **Lose:** G2 swing+twist retargeter (the one thing that directly fixes the observed 1957deg motion loss on Dragon). LLM-driven auto-mapping for new species. Subtree perturbation training augmentation.
- **Keep:** Compatible with official AnyTop checkpoint. 12.7k fine-tune steps not wasted. Production pipeline stable. Action_prompt conditioning works today.
- **Hidden risk:** The current quaternion-flip symptom will persist. We will keep eating motion energy on long sequences. Diminishing returns from more fine-tune steps if the bottleneck is downstream of the model.

### Plan B — wholesale switch to marklalon
- **Lose:** ALL current fine-tune progress (step 243k -> 0 — checkpoint incompatible, 100 missing keys, 32 rejected keys). Action_prompt text steering (they have no text conditioning). Production stability. 20-40 days of GPU time on the 5080.
- **Keep:** Theoretically superior architecture (global energy FiLM, dual-mode loop, cross-limb attention, playspeed). Better retarget. Better action extraction.
- **Hidden risk:** Their `quadropeds_locomotion_slim_v4` checkpoint is unreleased. We would train from scratch on Truebones with no upstream weights to bootstrap. 6 active feature branches mean the API will shift under us. CC BY-NC commercial blocker is **not solved** by switching — same upstream license.
- **Showstopper:** No public checkpoint. 20-40 days training is real wall-clock time on a single 5080, not optimistic.

### Plan C — hybrid (recommended)
- **Lose:** Architectural features that need their weights (energy FiLM, loop cond, cross-limb, playspeed). These stay theoretical until marklalon publishes weights.
- **Keep:** Current fine-tune progress. Production pipeline. Action_prompt text steering. Compatibility with official AnyTop checkpoint.
- **Gain:** G2 swing+twist retarget (directly fixes Dragon symptom). LLM auto-mapping for new species. Disk-cached joint mappings. Cleaner action category extraction.
- **Hidden risk:** Licensing — marklalon's retarget code inherits CC BY-NC. Lifting it into our scripts inherits the same restriction. Both forks were already CC BY-NC, so no net new risk, but document the lineage clearly.
- **Maintenance risk:** If marklalon refactors `utils/retarget.py` in a future commit, we won't pick it up automatically. Pinning is required.

---

## How this affects FabMesh ship timeline

Reference: FabMesh Steam / Fab.com / itch.io commercial target, packaging strategy "light 5GB zip + first-run 17GB model download" (per project memory).

### Plan A — continue our fork
- Current fine-tune completes: **2026-06-08 to 2026-06-12** (3-7 days)
- Dragon motion-loss bug persists, would need separate retarget fix: **+5-10 days** of original work
- **Ship-ready animation pipeline: 2026-06-25 to 2026-07-05**
- **Commercial blocker: unresolved** (CC BY-NC upstream)

### Plan B — wholesale switch to marklalon
- Current fine-tune wasted, restart from scratch on Truebones: **20-40 days GPU**
- Port action_prompt into their InputProcess: **+2 days**
- Re-wire Electron pipeline to their CLI surface: **+3 days**
- Regression test all existing reference clips: **+5 days**
- **Ship-ready animation pipeline: 2026-07-15 to 2026-08-15** (best case)
- **Commercial blocker: still unresolved** (same upstream CC BY-NC)

### Plan C — hybrid (recommended)
- Current fine-tune completes in parallel: **2026-06-08 to 2026-06-12**
- Retarget v2 ported and benched: **2026-06-05 to 2026-06-11** (parallel to GPU)
- Combined validation pass: **2026-06-12 to 2026-06-14**
- **Ship-ready animation pipeline: 2026-06-14 to 2026-06-18**
- **Commercial blocker: still unresolved** (need separate license action regardless)

**Net:** Plan C ships ~1 week earlier than Plan A (by killing the retarget bug in parallel with training) and ~4-8 weeks earlier than Plan B. None of the plans solve the CC BY-NC commercial issue — that requires either an upstream license negotiation, a clean-room reimplementation, or a license workaround (e.g., free-tier non-commercial build + paid model swap). That decision is orthogonal to the marklalon question and should be tracked as a separate blocker.

---

## Decision

**Plan C — Hybrid.** Continue training. Port retarget. Don't touch the model. Re-evaluate architectural migration only if marklalon publishes `quadropeds_locomotion_slim_v4` weights.

**First action this session:** read `marklalon/LICENSE` to confirm CC BY-NC inheritance, then pin a commit on `feat/retarget_v2` and lift `utils/retarget.py` into `scripts/anytop_retarget_v2.py` with attribution.
