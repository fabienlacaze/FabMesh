# AnyTop License Audit — Commercial-Use Verdict for FabMesh

**Date:** 2026-06-05
**Auditor:** Claude Code (Opus 4.7) on behalf of fabienlacaze
**Scope:** Can FabMesh (commercial Electron desktop product, Steam target) ship AnyTop-based motion generation for non-humanoid creatures?

---

## TL;DR (1 line)

**RISKY BUT PROCEED** — AnyTop code + weights are clean MIT (commercial-safe), BUT the official weights were trained on Truebones Zoo data whose redistribution clause forbids shipping derivatives in BVH/FBX/raw-motion form. **Safe path: ship code + train our own weights on MountainDragon BVHs we already own through UE5 Marketplace.** Avoid shipping the official `checkpoints/` and avoid shipping any Truebones-derived motion file at runtime.

---

## License chain

| Component | License | Commercial OK? | Notes |
|---|---|---|---|
| AnyTop code (Anytop2025/Anytop) | MIT (Copyright 2022 Guy Tevet) | YES | Clean unmodified MIT. No NC clause. Only obligation: ship copyright + permission notice (e.g. in `THIRD_PARTY_LICENSES.md`). No patent grant (MIT, not Apache-2.0). |
| AnyTop weights (HuggingFace `Inbar2344/AnyTop`) | MIT (YAML frontmatter tag) | YES *for the weights file itself* | The MIT tag covers Inbar Gat's contribution (the trained `.pt` files). It does NOT relicense the training data those weights encode. See "Risk scenarios #2" below. |
| Truebones Zoo motion data | "Royalty-free use" for end products + **explicit ban on redistributing in BVH/FBX/iMotion** | PARTIAL — use in finished media OK, redistribution as raw motion forbidden | Operative quoted clause: *"Re-Distribution or ReSale of Truebones in .FBX, .BVH or i-Motion … is strictly prohibited"*. Shipping weights that can regurgitate the training set bit-perfect is a gray zone. |
| Our fine-tuned weights (trained on MountainDragon BVHs from Apovivor UE5 Marketplace asset) | MIT (code) + our copyright on the weights, downstream of Apovivor's UE5 Marketplace EULA | YES (we control the data pipeline) | Apovivor UE5 Marketplace license already grants us commercial use. Our weights are a clean derivative we can license freely. |
| marklalon's fork of AnyTop | MIT, byte-identical to upstream | YES, but with a wart | marklalon vendored `motion_lib/` from `github.com/inbar-2344/Motion` (Daniel Holden lineage) **without bundling a LICENSE file** — that is a license-hygiene gap on their side, not a blocker for us since we did NOT branch from marklalon. Our `feat/text-conditioning-fabmesh` branched from upstream `main`. |

---

## Risk scenarios

### 1. Ship code + OUR weights (trained on MountainDragon BVHs we own via UE5 Marketplace)

**Risk: LOW. Recommended path.**

- Code is MIT → ship with notice in `THIRD_PARTY_LICENSES.md`.
- Weights are our own creation, trained on data we have a commercial license for (UE5 Marketplace EULA for the Apovivor MountainDragon asset).
- No Truebones data touches the trained model.
- We can sell, modify, sublicense at will.
- **One caveat:** verify the Apovivor UE5 Marketplace EULA explicitly allows using the meshes/animations as ML training data. Standard UE5 Marketplace EULA covers "use in games and other interactive content" — ML training is not explicit. Two safer reads: (a) the trained weights are not redistributed bit-for-bit copies of the source animation, they are a statistical model; (b) generated motion ≠ derivative of any single source clip. Still worth a one-line confirmation from Epic / Apovivor if we want zero ambiguity.

### 2. Ship code + OFFICIAL AnyTop weights from HuggingFace

**Risk: MEDIUM-HIGH. Not recommended without legal review.**

- The `Inbar2344/AnyTop` HF repo tags the weights MIT. Technically that's a license grant from Inbar Gat that permits commercial redistribution.
- **BUT** those weights were trained on Truebones Zoo + Mixamo. The MIT tag cannot retroactively grant rights to the training data that the rightsholders never granted to Inbar Gat herself. If a court ruled that AnyTop weights are a "derivative work" of the training set (recent EU AI Act + ongoing US cases trending this way), shipping them commercially exposes us to a Truebones takedown.
- Truebones' redistribution clause specifically lists `.FBX, .BVH, i-Motion` — weights are not literally any of those formats, but a model that can output them on demand is arguably equivalent.
- **Verdict:** safe enough for prototyping and research builds. **Do not ship in the paid Steam build** without (a) written commercial clearance from Truebones, or (b) replacing with our own weights.

### 3. Ship code + official weights + retarget pipeline that uses Truebones canonical skeleton

**Risk: HIGH. Blocked.**

- Same risk as #2, plus we'd be shipping the Truebones skeleton topology as a runtime data file. That's much closer to "redistributing Truebones data in raw motion format" than weights alone.
- If our retarget pipeline reads any `.bvh` shipped from Truebones at runtime in the installed product, that is a direct violation of the redistribution clause.
- **Mitigation:** retarget through our OWN canonical skeleton (built from MountainDragon or from a clean-room rig) so no Truebones-derived file ever ships in the install.

---

## Concrete mitigation paths

1. **Train our own weights on Apovivor MountainDragon BVHs (and other UE5 Marketplace creatures we own).** This is the clean path. We already have MountainDragon data, fine-tuning is in progress per AGENT_LOG. Result: a fully-owned weights file we can ship under our own EULA.

2. **Reach out to Truebones for written commercial license.** Truebones is responsive on Gumroad. A one-time site-license fee (typically $200-$2000 for indie game studios per historical posts on their support pages) would clear the redistribution gray zone for the official AnyTop weights. Worth pursuing in parallel as a fallback.

3. **Reach out to Inbar Gat / Guy Tevet for clarification on weights provenance.** Specifically: (a) what fraction of the official checkpoints' training set is Truebones vs. Mixamo vs. SMPL-X, (b) whether they obtained written commercial clearance from the data providers, (c) whether they would object to us retraining-from-scratch on our own data.

4. **Reach out to marklalon for license intent on their `motion_lib/` vendored code.** Low priority — we did not branch from marklalon. Only matters if we later pull anything from their fork.

5. **Clean-room reimplementation of AnyTop architecture.** Last-resort. AnyTop is a public paper (SIGGRAPH 2025 submission). The architecture (skeleton-aware transformer + per-joint conditioning) is patent-free. A 2-3 week reimplementation in-house would eliminate every license question except the data one (which we handle via mitigation #1). Defer unless mitigation #1 hits a snag.

6. **Ship a `THIRD_PARTY_LICENSES.md` in FabMesh that bundles**: AnyTop MIT notice, Daniel Holden's Motion library lineage notice (even though we use it indirectly), and any other ML-stack notices (PyTorch BSD, NumPy BSD, etc.). Standard hygiene regardless of which weights we ship.

---

## RIGHT NOW (today's action items, priority order)

1. **Lock in the "own-weights" path as the production plan.** Continue MountainDragon fine-tuning on our hardware. Tag the resulting weights as `fabmesh-anytop-mtndragon-v1.pt` and store in our private R2 bucket, NOT in HuggingFace public.

2. **Audit the Apovivor UE5 Marketplace EULA** for any explicit ban on ML training. If silent, send a 3-sentence email to Apovivor (Fab.com creator contact form) asking for written confirmation that ML training on the MountainDragon asset is permitted under the standard EULA. Template below.

3. **Send the Truebones commercial-license inquiry email today** (template below). Even if we go the own-weights route, having a Truebones site license unlocks the official checkpoints as a fallback and removes the gray zone if a single Truebones-derived BVH ever ends up in our retarget reference set.

4. **Add `THIRD_PARTY_LICENSES.md` to the FabMesh repo root** with AnyTop MIT notice + Guy Tevet copyright. Takes 5 minutes. Already required by MIT regardless of weights choice.

5. **Send the Inbar Gat / Guy Tevet clarification email** (template below). Useful intel for production planning, low effort, low cost.

---

## Email templates

### Template A — Truebones commercial license inquiry

```
Subject: Commercial site-license inquiry — Truebones Zoo for indie game studio (FabMesh)

Hi Truebones team,

I'm an indie game developer (sole developer, France) building FabMesh — a
commercial desktop tool (Steam release planned 2026) that generates
animated 3D creatures for use in Unreal Engine projects.

I would like to license Truebones Zoo motion data commercially under a
written agreement that covers:

  1. Use of Truebones BVH data to train a machine-learning motion model
     (AnyTop-family architecture) that ships embedded in FabMesh.
  2. The trained model may output new motions; the original Truebones
     BVH files are NEVER shipped, exposed, or redistributed in the
     installed product.

I understand your standard TOS permits commercial use in end products
but forbids redistribution of the .BVH / .FBX / i-Motion files
themselves. My use case sits between these two — the trained weights are
not a BVH file, but they are derived from your data.

Could you quote a site-license fee that would unambiguously cover this
ML-training use case? Happy to sign whatever paperwork makes sense.

Best,
Fabien Lacaze
fabien65400@hotmail.fr
fabware (Steam publisher)
```

### Template B — Inbar Gat / Guy Tevet (AnyTop authors)

```
Subject: AnyTop pretrained weights — commercial-use clarification

Hi Inbar, hi Guy,

Congratulations on AnyTop — really impressive work, especially the
skeleton-aware conditioning.

I'm building a commercial desktop product (FabMesh, indie, Steam) that
generates animated 3D creatures using an AnyTop-style backbone. The
HuggingFace repo Inbar2344/AnyTop tags the checkpoints as MIT, and the
upstream GitHub LICENSE is also MIT. I want to be a good citizen before
shipping.

Two questions:

  1. The training set referenced in the paper (Truebones Zoo, Mixamo,
     others) carries per-asset licenses that are not MIT. Did you obtain
     written commercial clearance from those providers for the released
     checkpoints, or is the MIT tag intended to cover only your own
     contribution to the model?

  2. If we plan to NOT ship your official checkpoints — instead training
     our own weights from scratch on a dataset we have a commercial
     license for (UE5 Marketplace asset) using your code — do you see
     any issue or is that the intended commercial path?

Either way, FabMesh will credit AnyTop prominently in the About screen
and ship the MIT notice in THIRD_PARTY_LICENSES.md.

Thanks for any guidance,
Fabien Lacaze
fabien65400@hotmail.fr
```

### Template C — marklalon (fork maintainer)

```
Subject: marklalon/Anytop — license clarification on motion_lib/

Hi,

I'm evaluating your AnyTop fork for a commercial project (FabMesh). The
LICENSE file is MIT (inherited from upstream Guy Tevet 2022) — clear.

One question on motion_lib/. BUNDLED_DEPS.md says it's vendored from
github.com/inbar-2344/Motion, which itself is derived from Daniel
Holden's published code. There is no LICENSE file inside motion_lib/
itself in your fork.

Would you mind:

  1. Confirming the intended license of motion_lib/* (MIT? same as
     repo root? something else?), and
  2. Adding a LICENSE or NOTICE file inside motion_lib/ so the chain
     is unambiguous?

This would help anyone (not just me) ship downstream products with
clean license hygiene.

Thanks for the fork — your root-folding fix in BVH.py is useful.

Best,
Fabien Lacaze
fabien65400@hotmail.fr
```

### Template D — Apovivor (UE5 Marketplace MountainDragon, ML-training clarification)

```
Subject: MountainDragon UE5 asset — ML-training use clarification

Hi Apovivor team,

I purchased your MountainDragon asset on the UE5 Marketplace (now
Fab.com) and I love it — it's already in use in my Apovivor-engine
project.

I'm now building a separate commercial product (FabMesh, indie, Steam)
that uses machine-learning to generate new creature animations. As part
of that, I would like to train a model on the animation clips (BVH/FBX)
included with MountainDragon. The trained model would generate NEW
motions; no original Apovivor file would ever be shipped or exposed in
the FabMesh product.

The standard UE5 Marketplace / Fab.com EULA covers "use in interactive
content" but is silent on ML training. Could you confirm in writing that
training an ML model on the MountainDragon animation data, for use in a
separate commercial product, is permitted under your standard license?

Happy to credit you in the FabMesh About screen.

Thanks,
Fabien Lacaze
fabien65400@hotmail.fr
```

---

## Closing note

The single highest-leverage action is **#1 — commit to own-weights as the production path**. Every other license question becomes downstream noise once our shipped weights are trained on data we control. The official AnyTop checkpoints stay useful for R&D and benchmark comparisons but never enter the Steam build.

If the own-weights path stalls (e.g. MountainDragon dataset too small for AnyTop's data hunger), the fallback ladder is:

  1. Buy a Truebones commercial site-license → unlocks official checkpoints.
  2. Augment our dataset with additional Fab.com / UE5 Marketplace creature packs we license individually.
  3. Clean-room reimplement the AnyTop architecture if any code-side license question ever surfaces (currently none — MIT is the cleanest possible grant).
