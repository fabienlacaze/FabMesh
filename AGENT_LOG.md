# FabMesh Agent Log

**RULE: I MUST read this file at the start of any session that touches
mesh quality, texture projection, or multi-view generation. I MUST append
to it after every experiment — success or failure. This prevents running
the same failed experiments twice.**

Most recent at the top. Each entry: date (YYYY-MM-DD), what was tried,
what happened, conclusion.

---

## 2026-04-18 — Sub-experiments hunting placement+definition (chronological)

After the initial 2-view experiment shipped (entry below), we cycled
through 5+ variants chasing the right combination of *placement* (face
on the front, not on the calf) and *texture definition* (sharp denim,
recognizable face). Same input pair every run:
`images/child/_scale_sweep/ip45_front.png` + `ip45_back.png`. Output
artifacts pile up in `logs/child_ip45_2view/mesh_*.glb`.

**Run A — NORMALIZE_ORIENT=0** (commit 16489cf)
- Bridge skips its +180° Y rotation. Mesh stays in raw SF3D frame
  (face -> -Z). views.json uses front=0, back=180 in raw frame.
- Result: placement looked decent from a flattering angle, but mesh
  is **cireux/blanchâtre** all over — colors washed, denim grayed,
  face flat & pasty. 426k texel holes (40%) filled by push-pull blur.
- Misjudged at the time as "best placement so far". Actually worst
  texture quality.

**Run B — NORMALIZE_ORIENT=1 + FABMESH_TEXPROJ_SHIFT_SOURCE=1**
(commit 2830058, reverted in cfdf6d3)
- Bridge applies +180° Y normalize. texture_project shifts source
  input.png azimuth too. All 7 slots end up at az=180 (front of
  rotated mesh).
- Result: placement OK, denim sharp & coloured. User reported "face
  on the calf" — actually a memory of an earlier different run.
  Reverted prematurely.

**Run C — NORMALIZE_ORIENT=0 + R_undo += Ry(180)** (current code, gated
on env)
- Adds Ry(180) to R_undo when NORMALIZE_ORIENT=0 to compensate the
  missing bridge rotation in projection sampling.
- Result: textures get colour back, but face features
  (eyes/nose/mouth) are **deformed/grotesque**. Patch over-rotates
  by a fraction so face details land on neighbouring vertices. Bad.

**Run D — NORMALIZE_ORIENT=1 (default), no SHIFT_SOURCE, no R_undo
patch** — the "sharp" baseline
- Standard pipeline path.
- Result: **placement perfect** (face front, denim front, baskets
  front), textures sharp and saturated. User confirmed: "le placement
  est parfait, definition meilleure".
- Latent issue: the native HD source (1151px) is at az=0 in the
  post-rotation frame — i.e. it lands on the BACK. The face we see
  is actually painted by mv/view_0, which is the front photo
  *resized to 1024px*. We lose the HD bonus where it matters most.

**Run E — NORMALIZE_ORIENT=1 + SHIFT_SOURCE=1** (today, flag re-added)
- Reapply run B's idea: shift input.png to az=180 so the HD source
  lands on the FACE of the rotated mesh.
- Result: placement still perfect. But the **face is FLOU + dirty**
  (dark patches around eyes, ghost-double of features).
- Root cause: input.png HD (1151px) AND mv/view_0 (front dup 1024px)
  both project to az=180. Their per-texel sample coords differ by
  sub-pixel because of the resolution mismatch -> moiré + ghosting
  on the face area where they fight for highest per-pixel weight.

**Run F — NORMALIZE_ORIENT=1 + SHIFT_SOURCE=1 + no front dups in mv/**
- Hypothesis: kill the doubled-front signal. Fill all 6 mv slots
  with `back` only, all labelled azim=180 in raw frame -> az=0
  post-rotation -> mesh BACK. input.png HD covers the FRONT alone.
- Result: at the locked-frontal compare angle, **F shows the BACK of
  the mesh** (denim back + nuque + cargo back pockets visible). Mesh
  somehow flipped under the projection swap. Disqualified for face
  quality comparison — you can't see the face in the pose F generated.

### Locked-frontal 5-way compare — user verdict

After locking all 5 panels to a fixed frontal camera
(`camera-orbit="0deg 90deg 1.4m"`) for direct face-to-face comparison:

- **A (NORMALIZE=0)**: face visible but cireux/blanchâtre, fade. Out.
- **C (NORMALIZE=0 + Ry180 patch)**: shows the BACK at the locked
  angle — mesh ended up rotated 180° vs the others. Out.
- **F (NORMALIZE=1 + SHIFT + no front dups)**: also shows the BACK
  at the locked angle. Same flip issue as C. Out.
- **D (NORMALIZE=1 baseline)**: face visible, sharp, well-coloured. ✓
- **E (NORMALIZE=1 + SHIFT_SOURCE)**: face visible, sharp, similar
  to D at the wide angle. ✓

User said: "D et E sont les mieux". Choice now narrowed to D vs E.

### Why C and F flipped 180° at the same camera angle

C and F both touch the rotation pipeline:
- C adds Ry(180) to R_undo. This modifies how vertices are sampled
  but ALSO changes which face of the mesh is "az=0" of the
  texture_project camera basis — effectively flipping the rendered
  result by 180° around Y.
- F changes views.json so all 6 mv slots claim azim=180 (raw) which
  the bridge then shifts to az=0 (post-rotation = back). Combined
  with input.png shifted to az=180 (post-rotation = front), the back
  texture lands on the "front" of the mesh as defined by the
  texture_project camera convention. The user's frontal camera angle
  in model-viewer then sees the back image painted on what model-
  viewer thinks is the front face -> looks like a back view.

Lesson: changing angles in views.json or R_undo also rotates the
visible front of the mesh in the viewer's frame. The "face is in
front" requirement is enforced not just by mesh geometry but by
matching the texture_project frame to model-viewer's default camera.

### Why A/C/F are sharper than D/E — analysis

User correctly pushed back: rather than asking how to improve D/E,
ask **why A/C/F have better definition**. Tabling the relevant flags:

| Run | NORMALIZE | SHIFT_SRC | R_undo+Ry180 | rot_offset | input azim final | mv azims final | Sharpness |
|-----|-----------|-----------|--------------|------------|------------------|----------------|-----------|
| A   | 0         | 0         | no           | 0          | 0                | 0/90/180/270/0/0 | sharp |
| C   | 0         | 0         | yes          | 0          | 0                | 0/90/180/270/0/0 | sharp |
| F   | 1         | 1         | no           | 180        | 180              | 0/0/0/0/0/0       | sharp |
| D   | 1         | 0         | no           | 180        | 0                | 180/270/0/90/180/180 | medium |
| E   | 1         | 1         | no           | 180        | 180              | 180/270/0/90/180/180 | flou |

What A, C, F share that D, E lack:
- All MV final azimuths are **clean orthos** (multiples of 90°,
  ideally 0/90/180/270 or all-zero) **after** the rotation_offset
  is folded in.
- input.png lands on the same side of the mesh as ip45_front shows
  — i.e. the actual front of the rendered mesh.

What goes wrong in D, E:
- Geometrically the projection math is correct (rot_y(-180) on a
  mesh that was rotated +180 nets to identity).
- But the HD source signal (input.png 1151px) ends up at az=180
  (in E) AND mv/view_0 (1024px front dup) ends up also at az=180
  -> two views compete on the exact same face area with sub-pixel
  sample-coord differences -> moiré.
- In D, input.png stays at az=0 -> wasted on the BACK of the
  rotated mesh. The face is painted only by mv/view_0 (1024px).
  No moiré, but no HD bonus either -> "medium" sharpness.

So:
- A's sharpness comes from mv azimuths being raw orthos (no shift)
  AND input.png at az=0 hitting the actual face (raw mesh frame).
- C's sharpness same as A. The face deformation in C is from the
  R_undo Ry(180) patch over-correcting mesh sample coords.
- F's sharpness comes from collapsing all MV slots to one azimuth
  (no fractional offsets). But mesh ends up rotated 180° at the
  viewer's frontal angle.
- D = OK because no two views fight for the front (input.png on
  back, mv/0 alone on front).
- E = bad because input.png + mv/0 fight on the front.

### Hypothesis to try next — Run G

Take E and **remove only mv/view_0** (the slot that doubles input.png
on the face), keep mv/view_1..5 for right/back/left/top/bottom
coverage. Should:
- Eliminate the moiré on the face (no doubled-front signal).
- Keep the HD bonus from input.png on the face.
- Keep the back/sides coverage from the other mv slots.
- Keep the correct placement (NORMALIZE=1 + SHIFT_SOURCE).

Implementation: ip45_2view_to_3d.py — write only 5 mv slots
(view_1..view_5), let texture_project skip view_0 because the file
won't exist. Or write all 6 but mark view_0 with priority 0.0 in
views.json (but views.json doesn't carry priority, only azim/elev).

Cleaner path: skip writing view_0 entirely. texture_project.py
already logs `WARNING: missing {vpath}, skipping` for missing slots.

### Run I — Path 2 (transparent view_0) — ALSO FLIPPED

After the 2-agent synthesis pointed to two safe paths, tried Path 2
first because it's a 1-line change with the lowest theoretical risk.

Config: NORMALIZE=1 + SHIFT_SOURCE=1 + view_0.png written as fully
transparent RGBA (alpha=0 everywhere) in build_mv_dir. Theory: src_alpha=0
makes view_0's per-texel weight 0 (texture_project l 643:
`w_pixel = pt_vis * src_alpha * priority * mask * in_b`), so input.png HD
wins everywhere on the face, no moiré. Layout still has 7 entries
(unchanged), just one is neutralized.

Result: **also flipped 180°** at the locked frontal angle. User saw
the back of the mesh in the I panel.

Lesson: even **neutralizing a slot via alpha=0** flips the mesh. The
flip is NOT specifically tied to changing pixel content of view_0 —
it's tied to **whether view_0 contributes any winning weight at all**
on the front azimuth. When view_0 stops winning *anything* there,
xatlas / texture_project's per-texel arbitration shifts which side of
the mesh ends up texturized as "front" in the viewer.

### Run J — Path 1 (priority demote in texture_project.py) — ALSO FLIPPED

Tried Agent #1's surgical priority drop. Patched texture_project.py
l 423-431 to demote any mv slot whose `shifted_azim` collides with
`_src_azim` and whose priority ties with the source's prio (1.0).
The collision detection is precise (`abs(((shifted_azim - _src_azim
+ 180) % 360) - 180) < 1.0` for azim, `abs(elev) < 1.0` for elev).
Only fires when `FABMESH_TEXPROJ_SHIFT_SOURCE=1`.

Confirmed in logs: `view_0: demoting prio 1.0 -> 0.5 (collision with
source at az=180.0)`. So the patch fired exactly as designed — view_0
still contributes, but with half the weight, so input.png HD should
own the face cleanly.

Result: **also flipped 180°**. User saw the back of the mesh in J.

### Definitive empirical conclusion (after runs A..J)

| Run | NORMALIZE | SHIFT | What changed | Flipped? | Definition |
|-----|-----------|-------|--------------|----------|------------|
| A   | 0         | 0     | baseline     | no (luck) | cireux |
| C   | 0         | 0     | R_undo+Ry180 | yes      | sharp face deformed |
| D   | 1         | 0     | baseline     | **no**   | medium (mv 1024 paints face) |
| E   | 1         | 1     | shift source | **no**   | flou (HD vs 1024 moiré) |
| F   | 1         | 1     | back-only mv | yes      | sharp |
| G   | 1         | 1     | skip view_0  | yes      | sharp |
| H   | 1         | 1     | view_0=back  | yes      | sharp |
| I   | 1         | 1     | view_0 alpha=0 | yes    | sharp (back side) |
| J   | 1         | 1     | view_0 prio 0.5 | yes   | sharp (back side) |

The pattern is now unambiguous:

- **Anything that makes input.png HD dominate the front azimuth flips
  the mesh** (C, F, G, H, I, J).
- **Only configurations where mv/view_0 (1024px front dup) wins the
  front azimuth are non-flipped** (D, E).

Why? When input.png owns most of the front-side texels, the bake
follows SF3D's native coordinate frame for those texels. The MV slots
follow the bridge's post-rotation frame for theirs. Mixed dominance
across the same hemisphere creates an inconsistent bake; xatlas/
viewer ends up showing what was the "back" of the SF3D coords as the
new "front".

Net result: **D and E are the only viable configurations**. We cannot
have HD-on-face AND non-flipped via env flags / priority tweaks /
view content tricks. Achieving both would require modifying the
R_undo / R_w2c basis math in texture_project.py so input.png's
SF3D-native frame and the MV post-rotation frame agree on which side
is "front" — a deeper engine change than env-flag tuning allows.

### Pragmatic recommendation

For shipping the 2-view pipeline today: use **D** (NORMALIZE=1
baseline, no SHIFT_SOURCE, no priority tweaks, canonical 7-view mv
layout). Confirmed by user as having "definition meilleure" + correct
placement.

To improve D's face definition without flipping: increase the
resolution of `mv/view_0.png` itself. Currently
`scripts/ip45_2view_to_3d.py:38` resizes the front PNG to 1024×1024.
Bumping that to 2048×2048 doubles the resolution that paints the face
in D, no flip risk. Worth trying as **Run K** if user agrees.

### ERRATUM 2026-04-18 — All previous "NORMALIZE=1" runs were actually NORMALIZE=0

**MAJOR BUG in my analysis**: discovered when user said Run K had
"face-on-calf" inversion (vertical, not just Y-flip). On inspection,
`scripts/ip45_2view_to_3d.py:84` was setting
`env['FABMESH_SF3D_NORMALIZE_ORIENT'] = '0'` from the very first
commit of the wrapper. So **every run since A** has been in
NORMALIZE=0, despite being labelled NORMALIZE=1 in the table for
runs D, E, F, G, H, I, J, K.

The actual experimental matrix was therefore:

| Run | NORMALIZE actual | SHIFT | What changed in mv/ |
|-----|------------------|-------|---------------------|
| A   | 0 | 0 | baseline |
| C   | 0 | 0 | + R_undo Ry180 patch |
| D   | **0** | 0 | (claimed: NORMALIZE=1, was =0) |
| E   | **0** | 1 | (claimed: NORMALIZE=1, was =0) |
| F   | **0** | 1 | + back-only mv |
| G   | **0** | 1 | + skip view_0 |
| H   | **0** | 1 | + view_0=back |
| I   | **0** | 1 | + view_0 alpha=0 |
| J   | **0** | 1 | + view_0 prio 0.5 |
| K   | **0** | 0 | + mv slots @ 2048 |

So the "flip 180°" observed in C/F/G/H/I/J/K was actually the
NORMALIZE=0 mesh (face -> -Z) viewed by model-viewer's default
camera (looking from +Z) — i.e. seeing the BACK by default. Runs D
and E "happened to look correct" not because the bake was special,
but because their texture distribution made the back-side somehow
look more like a "front" to the user (probably because back image
has hair, neck, jacket-back which are visually less distinguishable
front-vs-back than the face-side).

K's "face-on-calf" is the same bug as the very first session bug:
NORMALIZE=0 + R_undo's standard rotation chain creates a mesh frame
where projection coords land on flipped vertical positions.

### Fix applied: removed `env['FABMESH_SF3D_NORMALIZE_ORIENT'] = '0'`
from scripts/ip45_2view_to_3d.py:84. Bridge default (NORMALIZE=1)
now applies — mesh face will point to +Z (three.js convention).

### ERRATUM-OF-ERRATUM 2026-04-18 — NORMALIZE=0 was CORRECT all along

After running REAL_D and REAL_E with NORMALIZE=1 (bridge default),
user inspected the front and back views in the compare:

- OLD D and OLD E (NORMALIZE=0): face devant, dos derrière, **correct orientation**.
- REAL D and REAL E (NORMALIZE=1): the **face image is projected onto
  the BACK of the mesh** — visible because the front view of the
  model-viewer shows the back of the body with the face pasted on it.

So my "erratum" above was wrong. **NORMALIZE=0 was the correct setting
for this pipeline**, and the wrapper was right to force it. The
reason it's correct:

- bridge with NORMALIZE=1 rotates the mesh +180° around Y, then
  propagates rotation_offset_deg=180 to texture_project.
- texture_project applies that offset to the MV view azimuths, BUT
  the source `input.png` stays at azim=0 (no shift).
- Net result: mesh rotated 180°, MV azimuths shifted to compensate,
  but the source HD photo is now at the wrong side -> face image
  projected onto the back.

With NORMALIZE=0:
- mesh stays in SF3D native frame (face at -Z).
- rotation_offset_deg=0 propagated.
- All views (input + 6 mv) keep their raw azimuths from views.json.
- Source input.png at azim=0 lands on the front of the mesh.
- model-viewer's default camera (looking from +Z) sees the BACK of
  the SF3D-frame mesh, but the front photo IS projected on the front
  side, so when user rotates the camera to look at the SF3D-front
  side, they see the actual face.

Restored `env['FABMESH_SF3D_NORMALIZE_ORIENT'] = '0'` in
ip45_2view_to_3d.py with a long comment explaining why.

### Final corrected verdict

The "OLD D" config (= NORMALIZE=0 + no SHIFT_SOURCE) IS the working
baseline. The previous Run K (NORMALIZE=0 + mv slots @ 2048) was
essentially "OLD D + 2048 mv res", and the user reported it had
face-on-calf — that's a **different** failure mode (vertical
inversion in projection coords), unrelated to the front/back side
swap. K is still flipped vertically.

So:
- **Working**: A, D, E (all in NORMALIZE=0, the working frame).
- **Broken vertically**: K (the 2048 mv res broke p_v sampling).
- **Broken side-swap**: REAL_D, REAL_E (NORMALIZE=1 with this wrapper).

D remains the best-quality stable config for shipping. Future face
definition work should stay within NORMALIZE=0 frame.

### Run L result — STILL NEEDS VISUAL EVAL

Run completed (mesh_RUN_L.glb 2.9 MB, atlas now 2048×2048). User
hasn't compared yet — pivoted to a more important observation below.

### KEY USER INSIGHT (2026-04-18) — REAL_D has BETTER textures but inverted

User looked at REAL_D (NORMALIZE=1, no SHIFT_SOURCE) and reported:
"Real D a des super textures mais elles sont inversées".

Visible: denim is much sharper, seams clearly defined, white t-shirt
visible, cargo shorts crisp, baskets defined. BUT:
- The mesh shows the BACK at the locked frontal viewer angle.
- Face features (eyes, hair patches) are projected onto the back of
  the head from the wrong angle.

So REAL_D is the OPPOSITE of D:
- D = correct orientation but lower texture quality (bottlenecked by
  mv/view_0 dup at 1024px since input.png HD lands "behind" the
  rotated mesh).
- REAL_D = HIGH texture quality (HD source actually paints the dense
  side of the bake) but mirror-swapped (back where front should be).

### Re-evaluation of REAL_D after closer look (2026-04-18)

User looked at REAL_D from a different angle and reported TWO bugs:
1. "avant arriere inversée" — side-swap (Y rotation issue)
2. "orientation de la vrai avant inversée (tete vers les pieds)" —
   the front face image is projected UPSIDE DOWN onto the mesh

So REAL_D's textures aren't just "swapped left/right" — the source
input.png is also vertically flipped. Visible in the 2nd screenshot:
the back of the mesh shows a "head zone" in the BOTTOM (where the
feet should be) and shorts in the upper area where the chest is.
This is a head-toward-feet inversion.

Conclusion: REAL_D combines TWO transformations:
- side-swap (180° Y) caused by bridge rotating mesh but not source
- vertical flip (180° X or p_v inversion) caused by R_undo's Rx(90)
  no longer matching the rotated mesh orientation

A simple post-export Y rotation won't fix this — it would only fix
the side-swap, not the vertical flip. We'd need to also apply X
rotation OR fix the V flip in texture_project's projection chain.

ABANDONING the Run O plan (post-rotate Y -180°). It would only
half-fix the problem.

### Pivot: investigate the 2 specific bugs in REAL_D math

To fix REAL_D properly, we need either:
- **Option A**: post-rotate the mesh by Rx(180) @ Ry(180) on export
  AFTER the bridge does its work. Both rotations together net out
  to a Z-axis flip — equivalent to 180° around Z.
- **Option B**: in texture_project.py, when rotation_offset_deg!=0,
  also flip p_v (`p_v = 1 - p_v`) for the source view to compensate
  for the vertical inversion that the rotated mesh introduces vs the
  R_undo's standard Rx(90) chain.
- **Option C**: revert to D (NORMALIZE=0) which is geometrically
  correct, and accept the texture quality bottleneck. Best definition
  improvement path within D = bake the SDXL refine more aggressively
  (raise strength), or use a higher-res input.png.

### Run L was completed but ignored (mesh_RUN_L.glb 2.9 MB exists)

User skipped past Run L's verdict. Run L = D + atlas tex_res 2048
should be fine to evaluate later if the REAL_D direction is dropped.

### Run P result — works but over-rotated (mesh upside-down)

User screenshot: mesh is upside-down (feet up, head down, but face
visible on the now-bottom head). Textures are great, well-placed
relative to body parts (visage à la tête, denim sur le buste).

So Rx(180)@Ry(180) was too much. The "head toward feet" issue I
inferred from the previous REAL_D back view was actually NOT a
separate bug — it was just an artifact of viewing the mesh from a
weird angle when the side-swap rotated unfamiliar parts into view.

REAL_D actually has only ONE bug: side-swap (180° around Y). My
Rx(180) was a false fix that turned the mesh upside-down on top of
the correct Y rotation.

### Run Q — REAL_D + Ry(180) only — RESULT: WORSE

User verdict: "ca a baissé la qualité de la texture sans la faire
tourner". Two surprises:
1. Texture quality DROPPED vs REAL_D (less sharp denim, less defined
   features).
2. Mesh is NOT rotated — visually similar orientation to REAL_D.

How can a post-export Y rotation reduce quality? It shouldn't touch
texture data at all — only vertex positions. Possible explanations:
- The trimesh load+save round-trip lost something (PBR material,
  texture compression).
- Or the mesh was rotated but the user looked at it from a different
  angle that happened to match.
- model-viewer might cache the GLB by URL and showed an older P or
  REAL_D incorrectly.

Either way: **Run Q is worse than REAL_D** per the user.

### What we know now

- D (NORMALIZE=0): correct orientation, lower texture quality.
- REAL_D (NORMALIZE=1): high texture quality but 180° side-swapped.
- P (REAL_D + Rx@Ry 180): textures preserved, mesh upside-down.
- Q (REAL_D + Ry only): degraded textures, no visible rotation.

P proved that post-rotation CAN preserve textures (Rx+Ry combo
worked, just over-rotated). Q's degraded quality is suspicious —
maybe the trimesh save lost the PBR material setup. P used the same
function and DID preserve quality, so the difference between P and
Q is just whether Rx is included.

### CONFIRMED — trimesh round-trip drops texture data

File sizes:
- mesh_REAL_D.glb: 1,540,076 bytes (with full SDXL-refined 2048 atlas)
- mesh_RUN_P.glb: 774,716 bytes (after trimesh round-trip)
- mesh_RUN_Q.glb: 776,588 bytes (after trimesh round-trip)

Both P and Q lost ~50% of the file — almost certainly the
baseColorTexture (the SDXL-refined 2048×2048 atlas embedded in the
binary chunk). trimesh's GLB exporter doesn't preserve embedded
textures fully; it likely re-encodes them at lower quality or drops
the high-res atlas in favour of a fallback.

So Run P's "great textures" was a misperception — they were already
degraded but the upside-down distraction masked it. Q's quality
drop is real and measurable.

### Run R — REAL_D + Ry(180) via pygltflib (binary-preserving)

New script: scripts/glb_post_rotate.py uses pygltflib to rotate ONLY
the POSITION + NORMAL accessors in-place.

Result:
- File size preserved: 1,539,424 bytes (vs REAL_D 1,540,076).
  ✓ Textures NOT lost.
- BUT: visually identical to REAL_D — the rotation has **NO visible
  effect** in the model-viewer.

Theory: the GLB has a node with its own transform matrix (or TRS
rotation). model-viewer applies the node transform on top of the
vertex positions, so rotating the positions is cancelled by the
node-level rotation that the bridge applied at l 408
(`mesh.apply_transform(_R180)` -> trimesh probably writes that as
node TRS, not into vertex positions directly).

ALSO key revelation while looking at this compare: **D is actually
sharp too** (visage net, denim avec coutures, t-shirt blanc, shorts
cargo, baskets). My earlier impression that D was "lower def" was
wrong — D and REAL_D have similar texture quality at this view.
The difference between them is only orientation.

So:
- D works perfectly (correct orientation, sharp texture).
- REAL_D and R are visually equivalent (both show the back).
- The "post-rotate to fix REAL_D" path was solving a problem that
  doesn't really exist — D was already the answer.

### Decision

D is the shipping config. Stop chasing "REAL_D + post-rotate".
Going forward, if texture definition needs improvement, look at
the SDXL refine strength, the input image quality, or the SF3D
geometry — not at the orientation/projection chain.

Restoring ip45_2view_to_3d.py: keep the pygltflib post-rotate code
as opt-in (FABMESH_IP45_POST_ROTATE=1) but default OFF, so D config
runs cleanly without the extra step.

### Final D run analysis (2026-04-18) — objective comparison

After restoring D config and re-running, examined
mesh_proj_debug.png (the front-camera render with vertex debug
overlay) vs the source ip45_front.png:

PRESERVED (good):
- Pose (T-pose, bras tendus, jambes parallèles)
- Identité de l'enfant (visage reconnaissable, mêmes traits)
- Coiffure (cheveux bruns, coupe identique)
- Veste denim (couleur, coutures, 2 poches frontales, boutons)
- T-shirt blanc cassé sous la veste
- Shorts cargo beige avec poche latérale
- Baskets bleu marine avec semelle blanche
- Visage net avec yeux/nez/bouche bien placés
- Aucune déformation géométrique visible

DEGRADED (acceptable):
- Petits points colorés (vertex debug overlay only, not real texture
  artefacts — they're added by texture_project for diagnostic)
- Fond noir vs gris studio source (rembg clean)
- Léger blur sur détails fins (boutons, coutures cargo) — typical
  of 1024 atlas on 8k-vert mesh

VERDICT: D is a convincing and shippable result. Identité préservée,
vêtements correctement mappés, pose intacte, pas de bug géométrique.
Perte de détail minime et typique de la chaîne SF3D + texture_project.

After 18 runs (A..R), D wins.

### CRITICAL UPDATE — D has 2 distinct face/back bugs (2026-04-18)

User rotated the mesh in the viewer and reported:
- "la texture de face est dans le bon sens mais DÉCALÉE"
  (front texture is correctly oriented but spatially offset)
- "la texture de l'arrière est INVERSÉE (tête en bas)"
  (back texture is vertically flipped)

So my "D wins" verdict above was based only on the front view. The
back view of the same mesh has the head-toward-feet inversion that
I'd previously diagnosed in REAL_D and dismissed.

This is consistent with what I should have realized earlier:
texture_project handles front (input.png at azim=0) and back (mv/2
at azim=180) with different rotation chains. For the front, p_v is
flipped via `p_v = 1.0 - p_v` (l 555). For the back, the same
formula applies BUT the back image needs an additional vertical flip
because its source camera convention is opposite — back-view photos
have "up" at the top of the image just like front, but when projected
from azim=180 onto a mesh in SF3D-native frame, the V coord lands
inverted.

### Run W result — VERTICAL FIXED, but side-swap appeared

User screenshots: both front and back views of W are now correctly
oriented VERTICALLY (heads at top, feet at bottom, denim on torso,
shorts on legs — huge progress vs D/V where the back was head-toward-
feet).

BUT: the front-camera view shows the **back of the subject** (denim
with back seams, nuque, brown hair patch), and the back-camera view
shows the **face**. So the textures are now swapped front↔back in
addition to being correctly oriented.

Interpretation: skipping `p_v = 1 - p_v` for azim=180 was exactly
what the back needed vertically, but because the SF3D mesh is in
the native frame (face at -Z), the model-viewer default camera
(looking from +Z) shows the back by default. The textures happen
to appear "swapped" because:
- input.png (azim=0) projected onto mesh face (-Z side), which is
  AWAY from the viewer's default camera -> viewer sees back-of-mesh
  with back-painted pixels.
- back.png (azim=180) projected onto mesh back (+Z side), viewer
  sees front-of-mesh with front-painted pixels.

Wait — that describes the standard D behaviour. So why does W look
flipped and D doesn't?

Alternative theory: conditional-skip of p_v for azim=180 made the
back image no longer vertical-inverted, which means the FRONT side
of the mesh (painted by input.png at azim=0 with normal p_v flip)
now has its image mapped correctly, but... model-viewer's default
camera angle varies with each file — it auto-fits to mesh bounds.
So the apparent "swap" may be just that auto-rotate has W on a
different side initially vs D.

### The mechanics of Run W's side-swap (real analysis)

When we skip `p_v = 1 - p_v` for back (azim=180):
- The back image's pixel at V=0 (top of PNG = head) now maps to the
  mesh V coord where, WITHOUT the flip, the back cam samples the
  "top" of the mesh geometry.
- BUT: the ABSENCE of the V flip also changes which SIDE of the
  mesh the sample lands on, because the V coord is in cam-space
  AFTER R_w2c (which points cam at -Z for azim=180).
- Without the flip, the sampled direction is effectively the same
  image rotated 180° around Z — equivalent to a horizontal mirror
  after the vertical correction.

So "skip V flip for azim=180" achieved vertical correction AT THE
COST OF a lateral 180° reflection. Net effect: image face ends up
on the back of the mesh, image back ends up on the face.

### Run X — add U flip for back views only

Plan: compensate the lateral mirror by also setting
`FABMESH_TEXPROJ_UFLIP=1` specifically for the back view (azim=180).
Or more cleanly: when we skip the V flip for back, also apply U
flip to counter the mirror. Add this to the same conditional block
in texture_project.py.

### Run X result — NO improvement (same visible bug as W)

User said "même problème". Screenshot shows the back of the subject
(denim of dos, nuque, brown hair patch) at the default auto-rotate
pose — i.e. at the same angle W was showing, with the same texture
distribution.

Hash verification: W and X have DIFFERENT md5 (64a8cc... vs 39b0a1)
so the code did change something. But the visible result isn't
any better to the user.

Interpretation: skip_back_vflip + U-flip might not compose the way
I expected. Skipping V-flip moved things vertically, adding U-flip
for the same view moved them horizontally — together they may act
like a 180° in-image rotation, which is equivalent to doing
neither (since images aren't naturally rotated).

### Rethinking the bug

The back image `ip45_back.png` is the "view from behind" of a
subject. Its pixel at (U=0, V=0) = top-left of the image. The
subject's head is at top, the subject's RIGHT ARM is on the LEFT
side of the image (mirror view).

When we project this onto the mesh at azim=180, the camera looks
at the +Z side of the mesh. For the projection to correctly place:
- head pixel (V=0) -> mesh top (correct)
- subject-right-arm (U=0) -> mesh right arm = world +X
- subject-left-arm (U=1) -> mesh left arm = world -X

Standard p_v flip (`p_v = 1 - p_v`) reverses head/feet — we need
to SKIP it for back (Run W fix). Good.
Standard projection gives `p_u = focal * v_cs[0] / -z + 0.5`, so
mesh point at world +X appears at... depends on cam basis.

The lateral mirror might be inherent to projecting any "back view"
onto a mesh: a back photo of a subject has the arms mirrored vs
the mesh's natural axis system. So to project back correctly we
may need to PRE-FLIP the back PNG horizontally in build_mv_dir
(not U-flip in projection math).

### Run Y result — NO improvement (same as W and X)

User: "meme constat". So none of the corrective attempts
(W=skip-V, X=skip-V+U-flip, Y=skip-V+pre-FLIP-LEFT-RIGHT) changed
the visible side-swap relative to W's base.

Hash check confirms W/X/Y are all DIFFERENT meshes, so the code
changes applied. But the visible side-swap persists unchanged in
the viewer.

### Interpretation — the "side-swap" may not be what I thought

All 3 of W, X, Y have `p_v` skipped for azim=180, which fixed the
head-toward-feet inversion. Then:
- X added p_u = 1 - p_u in the projection math: no visible change.
- Y pre-flipped the PNG horizontally: no visible change.

If U-flip in the projection and horizontal flip of the source both
have no visible effect after skipping V-flip on back, that strongly
suggests the "side-swap" the user sees isn't actually a U-axis
issue at all. It's probably:
- **model-viewer's default camera** showing the wrong side by
  default, independent of texture content.
- After W's V-flip fix, the back texture is correctly placed on
  the back side of the mesh. But model-viewer's default camera
  points at the back (because SF3D mesh has face at -Z, camera
  at +Z). So user sees the back-painted-back (correct) as the
  "default view", which looks similar to the W pre-fix state.

To test this: lock model-viewer camera to AZIM=180 (face side) and
see if the face image is there. If yes, Y is already correct; the
"side-swap" was just model-viewer's default camera angle.

### Plan Run Z — lock camera at azim=180 in the compare viewer

No code change to the pipeline. Just update compare.html so the
Y panel has `camera-orbit="180deg 90deg"` — force looking at the
mesh's face side. If W/X/Y all then show the face correctly, the
side-swap was a camera-angle illusion, not a real bug.

### Root cause synthesis (2026-04-18, user asked "pourquoi on a des si mauvais positionnement")

After 23+ runs (A..Y + variants), honest diagnosis of why we're stuck:

1. **SF3D is single-view**. Mesh generated from front.png only.
   Back-of-mesh geometry is INVENTED by the model, not observed.
   UV coords for the back region correspond to a "plausible" guessed
   geometry, not the real back of the subject. When we project the
   back PNG onto these UVs, any sub-geometry mismatch surfaces as
   visible dislocation.

2. **texture_project is a camera-projection hack**, not a 3D-native
   bake. It projects each photo from a fixed azimuth using `R_w2c`
   + `p_u`, `p_v`. Works ONLY when the mesh's internal axis
   convention matches the projection's internal axis convention.
   Any mismatch flips V or U.

3. **18 runs showed that tweaking any single axis convention
   breaks another**. p_v flip, R_undo Ry(180), rotation_offset,
   PNG pre-flip — each patch fixes its target but introduces a new
   axis mismatch somewhere else in the chain.

4. **The 2-view pipeline is a degenerate case** for this code.
   texture_project was calibrated for Z123 (6 views at ±20° elev)
   and CRM (6 views orthographic incl. top/bottom). Our 2 views at
   azim=0/180 fill only 2/6 slots; the rest are dups. The dups
   interact with axis conventions in ways the original code
   never had to handle.

### Conclusion

The 2-view IP-Adapter pipeline is a BRICOLAGE on top of a
single-view pipeline. It CANNOT reliably produce "both front and
back correctly placed" because the underlying mesh geometry for
the back is guessed, and the projection math was never designed
for a 2-source back+front layout.

**Real fix options** (not a patch of texture_project):
- **Use MV-Adapter natively** — it's a 3D-aware multi-view
  generator, designed for this exact problem.
- **Use CRM full** — it produces 6 real ortho views AND a mesh
  designed to accept them.
- **Use TRELLIS** — sparse structured 3D, handles multi-view
  inputs natively.

All three are already scaffolded in the repo
(external/MV-Adapter, external/CRM, external/TRELLIS). None are
fully integrated yet.

### Paint3D install BLOCKED — kaolin doesn't support RTX 5080 (sm_120)

Tried to install Paint3D. Deps all fine (albumentations, lightning,
kornia, loguru) except kaolin:
- kaolin 0.18 wheel for torch 2.7 + cu126 installs cleanly
- At runtime, kaolin rasterize_cuda fails with "no kernel image
  available for execution on the device"
- RTX 5080 = sm_120 (Blackwell). Kaolin wheels were compiled without
  sm_120 support (max sm_90 in the torch 2.7 build).

Tried wheel for torch 2.8 + cu129 — installs but crashes with
"DLL load failed while importing _C: procedure not found" because
the wheel links against torch 2.8 ABI and we have torch 2.7.

Reverted to torch 2.7 wheel (safe broken state).

### Options forward
- Upgrade torch 2.7 → 2.8 (risks breaking SF3D, diffusers).
- Compile kaolin from source with TORCH_CUDA_ARCH_LIST=12.0 (long
  on Windows, requires MSVC, may still fail on sm_120 if the code
  itself uses unsupported features).
- **Abandon Paint3D**, try TEXTure (MIT, SD1.5 based) — check if
  it uses kaolin or an alternative like nvdiffrast.
- Look for a different texturing AI without kaolin dependency.

### Paint3D capabilities — multi-view confirmed

Cloned github.com/OpenTexture/Paint3D into external/Paint3D.

Per paint3d/config/train_config_paint3d.py:
- `n_views: int = 24` (default) — main rotation views around the mesh.
- `views_before`, `views_after` — additional view tuples (azim, elev).
- `views_init`, `views_inpaint` — which view indices are "init" (hold
  reference images) vs "inpaint" (synthesized to fill gaps).
- `alternate_views: True` — alternates left/right when sweeping azim.

Paint3D is MULTI-VIEW NATIVE. Our 2 photos (ip45_front + ip45_back)
can serve as init views at azim 0 and 180; Paint3D synthesizes the
remaining views with SDXL + ControlNet depth-aware diffusion to keep
consistency across the full mesh UV atlas.

Integration plan:
1. Keep our 2 photos as `views_init` at slots for azim=0 and azim=180.
2. Set `n_views=24` (or less for speed during dev).
3. Let Paint3D do its stage 1 (initial UV bake from the 24 views)
   then stage 2 (inpaint the seams).

### Paint3D integration — STARTING NOW (2026-04-18)

Plan:
1. Clone github.com/OpenTexture/Paint3D into external/Paint3D.
2. Install deps into current Python env (torch already installed).
3. Download weights (HuggingFace: Paint3D checkpoints referenced in
   the repo README).
4. Create scripts/paint3d_bridge.py with CLI:
   `python paint3d_bridge.py <mesh.glb> <image.png> <out.glb>
   [--prompt "..."]`
5. Test on logs/child_ip45_2view/mesh_NORMALIZE_1.glb + ip45_front.png.
6. If result is clean, add a second pass with ip45_back.png to paint
   the back side.
7. Integrate into FabMesh Electron UI as new "Paint3D refine" button.

Paint3D uses 2-stage pipeline internally:
- Stage 1: UV position + depth-aware SDXL diffusion to generate an
  initial UV texture from the prompt/image.
- Stage 2: UV-space inpainting to refine seams.

This replaces (or complements) the current texture_project.py
bricolage. If Paint3D's output is good from the start, we can
retire the 2-view projection math entirely.

### Texturing AI survey (2026-04-18) — Paint3D is the answer

User asked for a dedicated texturing AI matching: free, local,
commercial-OK. Agent surveyed 6 options; verdict:

| AI | License | Commercial | VRAM | Fit |
|----|---------|------------|------|-----|
| Paint3D | Apache 2.0 | **Yes, no limits** | ~8-12 GB | **WINNER** |
| TEXTure | MIT | Yes | ~8-12 GB | Fallback, abandonware |
| Hunyuan3D-Paint | Tencent Community | **NO in EU/UK/KR** | 10 GB | Blocked — user in France |
| MVEdit | MIT | Yes | **24 GB** | Blocked by 16 GB RTX 5080 |
| Text2Tex | CC BY-NC-SA | **NO commercial** | 12 GB | Blocked |
| TripoSR | MIT | Yes | 6-8 GB | Wrong task (image→mesh, not texture) |

**Paint3D winner**: Apache 2.0 (zero legal risk), designed to
texture existing meshes from reference images, SD1.5 backbone fits
comfortably in 16 GB VRAM. Github: OpenTexture/Paint3D.

**Plan**: integrate Paint3D as a new texturing backend alongside
the current texture_project. Input: (SF3D mesh .glb + front photo
+ back photo); output: (retextured .glb with high-quality PBR
atlas). Keep current bricolage as fallback.

### Analyse observationnelle de l'atlas D — abandoned

Aborted the atlas-sampling analysis because the user is right that
we're chasing a fundamentally broken design. Patching won't fix it.

### Analyse observationnelle de l'atlas D — STARTING NOW

User picked option D (dig into the atlas). Plan:
1. Open atlas_D.png (already extracted at
   logs/child_ip45_2view/atlas_D.png) and identify visually each
   region: front face, back, left profile, right profile, top
   island, bottom island.
2. For each region, note whether the image is upright, mirrored,
   upside-down. The "back is upside-down" user report should be
   visible directly in the atlas.
3. Sample several mesh vertices (head top, feet bottom, front, back,
   left arm, right arm) and read their UV coords. Compare:
   - Where does the "head top" vertex's UV point in the atlas?
   - Where does the "feet bottom" vertex's UV point?
4. Check UV<->atlas alignment: does the atlas's back-region have
   its head at high V or low V? Does the mesh's back vertex have
   high or low V UV?

Goal: understand the mismatch without any speculation. Then
propose the smallest possible patch.

### CRITICAL FINDING 2026-04-18 — UV→atlas correspondence measured

Extracted baseColorTexture from D (mesh_NORMALIZE_1.glb) and Y
(mesh_RUN_Y.glb). Both atlases show the child's head+body from
multiple angles (front, back, profile, top/bottom "bake" islands).

Then programmatically picked the mid-height mesh vertex closest to
the **front of the mesh** (most negative Z, SF3D native frame) and
the **back of the mesh** (most positive Z), and read their UV
coordinates:

| mesh | mid-FRONT vert UV | mid-BACK vert UV |
|------|-------------------|------------------|
| D    | (0.18, 0.16)      | (0.49, 0.16)     |
| Y    | (0.49, 0.16)      | (0.18, 0.16)     |

The UVs are SWAPPED between D and Y.

Looking at the atlas: the FACE image is painted at UV region
~(0.49, 0.16) (center-bottom) in both D and Y. The BACK image is
painted at UV region ~(0.18, 0.16) (left-bottom) in both.

So:
- In D: front-of-mesh vertex has UV pointing to the **back**
  region of the atlas → front-of-mesh gets the BACK image painted
  on it. This means D's textures are REVERSED — the back image is
  on the front of the mesh.
- In Y: front-of-mesh vertex has UV pointing to the **face**
  region → front-of-mesh gets the face. Y is CORRECT.

But the user validates D and rejects Y. Contradiction.

### Resolution — SF3D native frame has face at +Z, not -Z

My earlier assumption that "SF3D native has face at -Z" is WRONG.
In the raw SF3D frame, the face is probably at +Z. So:
- In D: front-of-mesh (actually the -Z side = BACK of subject)
  has UV→back region → back-of-subject painted on back-of-mesh.
  Correct.
- In Y: -Z side has UV→face → face painted on -Z side of mesh.
  But -Z is the BACK of the subject → face ends up on the back.
  Wrong.

My Runs W/X/Y were based on the wrong axis convention. The
`FABMESH_TEXPROJ_SKIP_BACK_VFLIP=1` flag swapped the UVs in the
wrong direction.

### Fix: revert Runs W/X/Y

The correct behaviour was already D's. My conditional p_v skip for
azim=180 flipped the atlas regions in the wrong direction. Revert
all W/X/Y patches. Keep Run V's `PROJECT_MODE=atlas` +
`UV_REPACK=0` for determinism but without the back-V-skip.

Back to the original bug: in D, the back image lands on the mesh
with a visible vertical inversion ("tête vers les pieds"). The
real cause is DIFFERENT from what I patched. Need to look at the
back image's orientation in the atlas region.

### Run X — NO improvement

### Run Y — PRE-FLIP back.png horizontally in build_mv_dir

Change plan:
- Revert Run X's U-flip in texture_project.
- Keep Run W's conditional V-flip skip.
- In build_mv_dir, apply `.transpose(Image.FLIP_LEFT_RIGHT)` to
  back.png before saving into mv slots 2/3/5.

This is cleaner because it's a property of the input images (back
photo is naturally mirrored for a subject facing away), not of
the projection math.

### Run W — conditional p_v flip in texture_project — STARTING NOW

Plan logged BEFORE patching, per protocol.

Hypothesis: texture_project.py applies `p_v = 1 - p_v` uniformly
to all views (lines 281 single-view and 555 multi-view). For the
back view at azim=180, this flips the back image vertically on
the mesh (head ends up at feet). The fix is to SKIP this flip
when the effective view azimuth is close to 180° (post
rotation_offset).

Implementation plan:
- At the per-view loop in texture_project.py (around l.537),
  after computing `shifted_azim = (azim + rotation_offset_deg)
  % 360`, decide whether to apply `p_v = 1 - p_v`:
  - If `abs(shifted_azim - 180) < 10°`: skip the p_v flip (back
    view — image top already aligns with mesh top).
  - Otherwise: apply the flip as before.
- Gate behind `FABMESH_TEXPROJ_SKIP_BACK_VFLIP=1` env flag to
  stay safe (default OFF preserves existing behaviour for Z123
  and CRM pipelines).
- Wrapper ip45_2view_to_3d.py exports the flag.

Output: mesh_RUN_W.glb. Will compare to D in compare.html.

Note: keep V's config (atlas mode + UV_REPACK=0) because V's
determinism fix is orthogonal to the back-flip fix.

### Run V result — front OK, back still vertical-inverted

User showed 2 views of Run V:
- Front view: correctly oriented (face, denim on torso, shorts on
  legs, feet at bottom). Texture looks reasonably sharp.
- Back/profile view: VERTICAL INVERSION — denim on the legs, shorts
  on the torso, baskets near the arms. Same back-flip bug that D has.

User verdict: "c'est inversé" — but this confirms the back-flip is
a STRUCTURAL bug of the D config, not an artefact of Run V. User
reported D having this same bug earlier ("la texture de l'arrière
est inversée (tete en bas)" — AGENT_LOG earlier entry).

So Agent #2's patch (atlas mode + UV_REPACK=0) addressed
**determinism** but NOT **back-flip orientation**, because the
back-flip originates in the projection math itself (R7: `p_v =
1 - p_v` applied uniformly to all views, but at azim=180 this
flips the back image vertically on the mesh).

### What D actually was, post-revelation

D has always had the back-inverted bug; user tolerated it because
the front view dominates the perception. Recent scrutiny exposed
it as a real defect. So "D wins" was premature — D has a defect,
and V shares it.

### Next plan

The real fix for the back-flip: skip `p_v = 1 - p_v` specifically
for views at azim=180 (or any view whose source image already has
its natural "up" in the image top). That's Run T's back pre-flip
approach but applied selectively to avoid Run T's face-ghosting.

The cleanest place to do this is inside texture_project.py:
- Before the per-view loop, mark views where p_v should NOT be
  flipped based on their azim (azim=180 for CRM layout).
- Apply `p_v = 1 - p_v` conditionally.

### Run V — Agent #2 patch (PROJECT_MODE=atlas + UV_REPACK=0) — STARTING NOW

Plan logged BEFORE applying the patch, per the agent log protocol.

Changes to scripts/ip45_2view_to_3d.py inside run_sf3d():
1. Replace `env.setdefault('FABMESH_PROJECT_MODE', 'refine')`
   with `env['FABMESH_PROJECT_MODE'] = 'atlas'`.
   → Skip the SDXL atlas refine pass (which has network + VAE
     non-determinism).
2. Add `env['FABMESH_UV_REPACK'] = '0'`.
   → Freeze the xatlas UV re-pack which can reshape islands
     between runs.

Keep `env['FABMESH_SF3D_NORMALIZE_ORIENT'] = '0'` (D's config).

Output: mesh_RUN_V.glb. Will compare to mesh_NORMALIZE_1.glb (D)
visually in compare.html.

### 3-agent deep analysis synthesis (2026-04-18, post-U2)

Three parallel agents analysed: (1) forensic "what drifted", (2)
theoretical "orientation bugs map", (3) prescriptive "minimal patch".
Synthesis:

#### Agent #1 (forensic) — what drifted

- scripts (the 3 pipeline scripts) are BYTE-IDENTICAL to 16489cf.
- external/StableFast3D submodule has a dirty modification (but
  predates D).
- HF cache, pip packages, source PNGs all frozen before D.
- Two consecutive re-runs NOW produce identical md5 -> pipeline IS
  deterministic in current state.
- D (02:59 md5 0abaf80f) ≠ rerun (62e18aa3) despite code match.

**Most likely cause**: local uncommitted edit at ~02:59 that was
never committed (see git log showing 2830058 "shift source
azimuth" reverted by cfdf6d3 at 02:54 — but E's filename
"NORMALIZE_1_SHIFT.glb" suggests the SHIFT logic was still active
when E was created at 03:09, implying a local uncommitted patch).

**Prescription**: try `git checkout 2830058 -- scripts/...` (not
the commit that was reverted BEFORE D, but the one whose code E
was actually generated with).

#### Agent #2 (theoretical) — orientation bugs cartography

Mapped 10 rotations/flips in the pipeline (R1..R10). Key insights:
- D's correctness comes from NORMALIZE=0 ⇒ R3 skipped ⇒ auto_align
  = 0 ⇒ no rotation_offset propagated ⇒ views.json azimuths land
  as-is on the SF3D-native frame, which R4+R5 cleanly undo.
- Runs C/F/G/H/I/J/K/R "flipped 180°" were NOT geometric flips —
  they were **priority/winner-take-all errors** where input.png
  was starved and MV at post-shift azimuths won. The mesh geometry
  was identical; only pixel dominance changed.
- Run S was a single-axis V-flip error (pre-flip of back.png
  inverts the vertical projection).
- Run T was a priority error (preprocessed back leaked onto face
  via side dups).
- REAL_D was a double-rotation error (R3 rotates mesh but input
  stays at azim=0 → face on back + upside-down via R7).

**Prescription**: change 2 lines in `scripts/ip45_2view_to_3d.py`:
- `env['FABMESH_PROJECT_MODE'] = 'atlas'` (skip SDXL refine, no
  network nondeterminism).
- `env['FABMESH_UV_REPACK'] = '0'` (freeze xatlas island packing).

#### Agent #3 (prescriptive) — use D/E as golden samples

Recommended option: **D + C combined** — promote D/E to golden
snapshots in `meshes/_golden/`, build an SSIM validation harness,
short-circuit the wrapper to return the golden when inputs match.
Cheap, reliable, reproducible; stops the chase for a moving target.

### Converged strategy

All 3 agents agree: **we should not keep chasing re-generation
of D byte-for-byte**. Agent #2's 2-line patch is the most
promising deterministic fix (cheap, targeted). Agent #3's
golden-sample approach is the safety net.

**Plan**:
1. Apply Agent #2's patch (PROJECT_MODE=atlas + UV_REPACK=0).
2. Run and visually compare to D.
3. If close enough, ship. If still different, promote the existing
   D/E to `meshes/_golden/` and add a validator.
4. Either way, freeze this "shipping config" commit.

### Deep analysis request (2026-04-18, post-18-runs)

User confirmed D (mesh_NORMALIZE_1.glb, 02:59) and E
(mesh_NORMALIZE_1_SHIFT.glb, 03:09) are the best-positioned meshes
of the whole session. Requests a complete analysis to understand
how to reliably reproduce this positioning.

Key observations:
- D/E generated at commit 16489cf code.
- Re-running EXACT 16489cf code now produces mesh with different
  md5 hash (62e18a vs 0abaf8). External state has drifted between
  03:00 and now.
- Pipeline is deterministic: two consecutive runs now give same hash.

Candidates for external drift:
- SF3D weights (HF hub updated?)
- texture_refine.py (fp16 bug patched around 04:00)
- Other dependencies
- GPU / CUDA cache

Launching 3 parallel agents for forensic + prescriptive analysis.

### Run S result — orientation FIXED, but spatial offset on back

User confirmed: "l'orientation est ok par contre le positionnement
n'est pas bon". Visible in profile view of mesh: skin tones (face
color) appear in the BOTTOM of the mesh (at the feet) and on the
arms; denim is misaligned vertically.

So the FLIP_TOP_BOTTOM fix corrected the head/feet inversion BUT
introduced a ~50% vertical shift: pixels from the top of back.png
(hair) now land in the middle of the mesh, and pixels from the
bottom (feet) land at the top.

Diagnostic: checked subject vertical extent in both PNGs:
- front: rows 52..1004 (5%..98% of image)
- back:  rows 71..1003 (7%..98% of image)
Subjects are framed nearly identically, so it's NOT a framing
difference between the two PNGs.

Likely cause: SF3D generates the mesh from `_preprocessed_path`
which is `resize_foreground(input.png, foreground_ratio=0.85)` —
the input is centered at 85% of the canvas before SF3D sees it.
The mesh is therefore proportioned for a subject at 85% of frame.
When we feed back.png at raw 1024×1024 (subject at full 5%..98%
of the image), the projection sample coords land 13% off
vertically.

### Run T result — BACK PERFECT, FRONT degraded (visage doublé)

User screenshots after pre-processing back.png with rembg +
resize_foreground 0.85 + V flip:

**BACK view: EXCELLENT.** Hair correctly at top, denim with seams
on the torso, cargo shorts on legs, dark baskets at the feet.
Spatially perfectly aligned. The vertical-offset bug from Run S is
SOLVED.

**FRONT view: DEGRADED.** Face shows DOUBLED features (a face on
top + a ghost face below), arms whitish/pasty. The denim/shorts
are still well-placed but the face quality dropped vs Run S.

Diagnosis: in build_mv_dir, `back` is now preprocessed (rembg +
resize 0.85 + V flip) and used in slots 2 (back), 3 (left dup
back), 5 (bottom dup back). Slot 3 in particular projects to az=270
which post-rotation_offset shift becomes az=90 — a side that's
visible from the front camera. So the preprocessed back image
(with its preserved rembg-cropped shape and 0.85 framing) bleeds
onto the side of the face from the left/right azimuths, creating
ghosting on the face.

The face was OK in S because back.png at full 1024 raw with no
preprocessing was visually different enough from front.png that
its contribution at side azimuths was downweighted by the visibility
math. Now that preprocessed back has clean alpha and matching
proportions, it competes more aggressively on the face area.

### Run U plan

Use the preprocessed back ONLY in slot 2 (the actual back azimuth).
For the left dup (slot 3) and bottom dup (slot 5), use the OLD raw
back.png (no preprocess). That way the back azimuth gets the clean
proportional alignment, but the side dups stay weak enough not to
ghost the face.

User asked to apply to the back what already works for the front
("tu as réussi à mettre la texture de face dans le bon sens, il faut
faire pareil pour celle de derrière (la tête est vers les pieds)").

Implementation: in build_mv_dir, before saving back.png into mv/
view_2 (back) and view_3 (left dup back) and view_5 (bottom dup
back), apply `Image.FLIP_TOP_BOTTOM`. Don't touch front, don't
touch any view that currently looks correct — only the back image
gets pre-flipped.

Hypothesis: the back image will then be projected with its existing
"head at top of png" -> arrives "head at top of mesh head" instead
of "head at feet".

Result file: mesh_RUN_S.glb, also overwrites mesh.glb in viewer.html.

### Fix needed

Don't use trimesh for the post-rotation. Need a method that
preserves the GLB binary structure exactly (textures untouched) and
only modifies the vertex positions. Options:
- Patch the GLB binary chunk directly (read header, modify positions
  buffer, re-write).
- Use a different lib that preserves PBR materials (pygltflib?
  gltflib? trimesh with explicit texture re-attachment?).
- Apply the rotation BEFORE export inside SF3D bridge (modify the
  mesh before SF3D's own GLB writer runs).

Easiest: patch local_sf3d_bridge.py to apply the post-rotation just
before its own GLB export step. The bridge already has the mesh in
trimesh form before export, so applying the rotation there avoids
the round-trip.

### Theory for Q's quality loss

The trimesh load/export round-trip: trimesh may handle GLB PBR
material differently when applying a rotation that changes the
mesh's "up" axis. Rx(180) flips up/down; Ry(180) doesn't. For Y-only
rotation, trimesh might re-tessellate or re-pack UVs differently
than for X+Y rotation that keeps a "consistent" axis system.

Or: model-viewer may simply have cached Q's previous attempt under
the same path/URL.

Need to verify: same compare with hard reload.

### Decision: Option A — STARTING NOW

User picked Option A: post-rotate the mesh Rx(180) @ Ry(180) on
export AFTER the bridge produces the REAL_D-style high-quality
texture mesh. Net effect = 180° rotation around Z axis, which:
- swaps front/back (fixes "avant arrière inversée")
- flips top/bottom (fixes "tête vers les pieds")

Implementation plan:
- New env flag: `FABMESH_POST_ROTATE_AXIS` (default empty, options
  'x', 'y', 'z') and `FABMESH_POST_ROTATE_DEG` (default 0).
- In ip45_2view_to_3d.py wrapper after run_sf3d, load mesh.glb,
  apply trimesh rotation, re-export. Or do it in a small standalone
  post-process step.
- Easier: apply the rotation directly in the wrapper after
  subprocess returns, no env machinery — but then it's
  ip45-2view-specific (which is fine for this experiment).

Run P = REAL_D config (NORMALIZE=1) + post-rotate Rx(180)Ry(180) on
the exported GLB. Will be logged here, then commit.

### NEW PLAN — Run O: REAL_D + post-rotate mesh -180° Y on export

Hypothesis: REAL_D's textures are sharp because NORMALIZE=1 makes
the bridge rotate the mesh +180° BEFORE projection, and texture_project
projects with rotation_offset_deg=180 — so the **HD source input.png
lands on the densely-sampled side of the mesh**. The only problem is
that the exported GLB is then "facing backward" relative to
model-viewer's default camera.

Fix: after the bridge produces mesh_REAL_D-style GLB (with great
textures), apply an additional Ry(-180°) to the mesh geometry on
export. Textures stay the same (UV-mapped to vertices), vertices
rotate so the face ends up at +Z.

Implementation: easiest is to add a post-export Y rotation in
local_sf3d_bridge.py if NORMALIZE_ORIENT was applied. But to keep
the standard pipeline untouched, add an env flag
FABMESH_POST_ROTATE_Y=180 that rotates the final exported mesh by
that amount. Then call with NORMALIZE_ORIENT=1 + POST_ROTATE_Y=180
to get HD textures + correct viewer orientation.

LOGGING NOW BEFORE WRITING CODE.

### Run L — D + tex_res 2048 (atlas resolution doubled) — STARTING NOW

Config: D config exactly + bridge invoked with tex_res=2048 (third
positional arg of local_sf3d_bridge.py). The mv source images stay
at 1024 (unchanged), only the destination atlas baked by SF3D and
projected by texture_project becomes 2048×2048.

Hypothesis: per-texel detail will be sharper because the atlas has
4× more pixels for the same UV layout. NO change to NORMALIZE, NO
shift, NO mv content change → no flip risk per the latest verdict.

Output: mesh_RUN_L.glb. Will compare to D (mesh_NORMALIZE_1.glb,
which despite its name is the canonical D run = NORMALIZE=0).

### Plan after the double-erratum (2026-04-18)

User asked to keep improving D's definition. Resetting all hypotheses
(my "empirical law" was based on misreading NORMALIZE values, so I
can't trust the conclusions of A..K runs about flips).

What I actually know NOW after the double-erratum:
- D = NORMALIZE=0 + no SHIFT_SOURCE + canonical mv 7-layout = WORKING
  baseline (correct orientation, "definition meilleure" per user).
- Anything tried so far at higher resolution (K @ 2048) breaks
  VERTICAL projection (face on calf), independent of NORMALIZE.
- REAL_D / REAL_E (NORMALIZE=1) project face on back — broken.

What I will try NEXT, one variant at a time, each logged
immediately to this file BEFORE running, then verdict added AFTER:

1. Run L = D + tex_res 2048 in SF3D bridge (atlas size, NOT mv res)
   - tex_res controls the destination atlas resolution. mv source
     stays at 1024 (no flip / no vertical inversion risk).
   - Expected: same texture content, just baked into a higher-res
     atlas -> sharper rendering at zoom.

2. Run M = D + disable atlas refine (FABMESH_PROJECT_MODE=atlas)
   - The SDXL refine pass may be smoothing the bake. Disabling lets
     us see the raw projection quality.

3. Run N = D + xatlas repack OFF (FABMESH_UV_REPACK=0)
   - Skips the UV re-pack that may be reducing effective per-face
     texel density.

Each run will be logged here BEFORE the bash invocation so you can
see what's about to be tested.

### Re-running D and E with TRUE NORMALIZE=1

Run REAL_D = NORMALIZE=1 default + no SHIFT_SOURCE
Run REAL_E = NORMALIZE=1 default + SHIFT_SOURCE=1

Output files: mesh_REAL_D.glb, mesh_REAL_E.glb. Side-by-side compare
in compare.html shows OLD D / REAL D / OLD E / REAL E.

User verdict pending. If REAL D and REAL E both render correctly
oriented (face on +Z), this validates the previous law (any front-
azimuth dominance shift caused the apparent flip) was MEASURING THE
WRONG THING. The pipeline should now be reasoned about with the
actual NORMALIZE settings.

### Run K — D + mv slots at 2048 — ALSO FLIPPED

After concluding D was the only viable shipping config, tried to
boost its definition by raising the mv slot resolution from 1024 to
2048 in build_mv_dir. Theory: with D (no SHIFT_SOURCE), the face is
painted by mv/view_0 (front dup), currently downsized to 1024.
Bumping it to 2048 should give a sharper face without changing
priorities or layout — ZERO theoretical flip risk.

Config: D config exactly (NORMALIZE=1, no SHIFT_SOURCE, canonical
7-view layout), only difference: `front = Image.open(front_png)
.convert('RGB').resize((2048, 2048))` instead of 1024.

Result: **also flipped 180°**.

Why it flipped (post-hoc analysis):
- input.png native ~1151px, prio 1.0
- mv/view_0 at 2048px (vs 1024 in D), still prio 1.0
- At 2048, mv/view_0 has more detail than input.png in absolute pixel
  count -> per-texel `pt_vis * src_alpha * priority` favors mv/view_0
  more often during winner-take-all (l 676)
- mv/view_0 wins more texels on the front -> dominance shifts back
  toward mv frame -> the post-rotation orientation locks in -> mesh
  appears flipped.

Confirmation of the empirical law: **anything that gives input.png
LESS-THAN-COMPLETE dominance on the front is the only way to keep
the mesh non-flipped**. Both raising input HD's win rate (C/F/G/H/I/J)
AND raising mv's win rate (K) flip the mesh. The non-flip "sweet
spot" of D is when input.png at ~1151px and mv/view_0 at exactly
1024px are roughly tied per-texel, with neither cleanly dominating —
that ambiguity stabilizes the bake.

### Final verdict (after runs A..K)

**D is the only stable, viable configuration.** Cannot improve face
definition through:
- texture_project priority changes (J flipped)
- View content swaps (F, H flipped)
- View deletion or transparency (G, I flipped)
- mv resolution increase (K flipped)
- SHIFT_SOURCE flag (E gives moiré, lower res)

To go beyond D's quality requires modifying the projection math
(R_undo, R_w2c_base) so input.png's native SF3D frame and the MV
post-rotation frame agree on which side is "front". That's a
substantial engine change, not a parameter tune.

Restoring mv slots to 1024 in build_mv_dir to reset to D-stable.

### 2-agent deep code analysis — synthesis (2026-04-18)

Two general-purpose agents were run in parallel to read the
texture_project.py / local_sf3d_bridge.py code in detail and explain
exactly what differs between runs. Both agents read the AGENT_LOG +
the scripts and reported with line numbers. Synthesis below.

#### Agent #1 — Diff D vs E

Single-variable diff: `FABMESH_TEXPROJ_SHIFT_SOURCE`. In E, `_src_azim`
in texture_project.py:401-403 becomes 180.0 (instead of 0.0 in D).

Mechanism of E's "lessivé/floue/moiré":
1. With shift, input.png and mv/view_0 (front dup) BOTH project to
   az=180 = the FACE of the rotated mesh.
2. PRIORITY_WEIGHTS_TUP[(0,0)] = 1.0 (texture_project.py:375) and
   PRIORITY_WEIGHTS[0.0] = 1.0 → both views compete with **identical
   priority 1.0** on the face area.
3. The per-texel arbitration (l 676-689) is **winner-take-all**, NOT
   blend: `better = w_pixel > weight_arr[ys,xs]`, `np.where(better,
   sampled, ...)`. Each texel picks ONE source view based on
   sub-pixel `pt_vis` differences.
4. The two sources are the same image at 1151px (input HD) vs 1024px
   (mv resize ip45_2view_to_3d.py:38). With nearest sampling
   (`astype(int)` l 669), each texel reads a slightly different
   pixel from each source → ghost-double of features (eyes), dark
   patches.

Recommended patch (Agent #1, chirurgical):
- texture_project.py:413-423, after `views.append`, demote any mv
  slot whose shifted_azim collides with `_src_azim` AND whose
  priority ties with the source: `prio = 0.5`.
- Effect: input.png HD (prio 1.0) wins on the face, mv/view_0 (now
  prio 0.5) only contributes where input is invisible.

Alternative 1-line: change PRIORITY_WEIGHTS_TUP[(0.0, 0.0)] from
1.0 to 0.85 — but affects other Z123 slots too.

#### Agent #2 — Diff A/C/F/G/H

Reconstructed the EFFECTIVE azimuths after rotation_offset:

| Run | NORM | SHIFT | rot_offset | R_undo+Ry180 | input | mv |
|-----|------|-------|------------|--------------|-------|----|
| A   | 0    | 0     | 0          | no           | 0     | 0/90/180/270/0/0 |
| C   | 0    | 0     | 0          | **yes**      | 0     | 0/90/180/270/0/0 |
| F   | 1    | 1     | 180        | no           | 180   | all 0 |
| G   | 1    | 1     | 180        | no           | 180   | (slot0 absent) 270/0/90/180/180 |
| H   | 1    | 1     | 180        | no           | 180   | 180/270/0/90/180/180 (slot0=back) |

Why C/F/G/H look "flipped 180°" in the locked frontal viewer:

- **C**: NORMALIZE=0 means the mesh is exported with face at -Z.
  The viewer (camera-orbit at +Z) sees the BACK by default. R_undo
  is internal to texture_project — it makes the projection sample
  the right pixels (so C's texture is sharp), but the GEOMETRY
  exported to the GLB is unchanged. The "flip" is just the viewer
  showing the back of the mesh. R_undo+Ry180 corrects sample
  alignment vs camera basis but causes a few-degree feature
  offset → "deformed face" because the rotation chain
  `Rx(90)@Ry(-90)@Ry(180)@Ry(-azim)@Rx(elev)` doesn't compose to
  identity in the photo frame.

- **A**: same -Z geometry as C, but no R_undo patch. So R_undo (which
  assumes face=+Z normalized frame) maps front-mesh vertices to
  the gray rembg background area of input.png → samples are
  background gray → cireux/blanchâtre atlas. 426k texel-holes
  filled by push-pull blur. The "good placement" of A in early
  screenshots was a flattering angle, NOT frontal-locked.

- **F/G/H**: NORMALIZE=1 → mesh face at +Z (correct geometry). But
  the mv content swap (back-only, skip view_0, swap view_0=back)
  removes the front-discriminating signal at the post-shift
  azimuths. Multiple competing views at prio ~1.0/0.9 share the
  same hemisphere → the back image gets painted across the front
  faces → looks like a flip.

NOT the cause of any flip:
- xatlas re-pack: UV layout is fixed by SF3D bake before
  texture_project rasterizes (l 507 `face_uvs = uv[faces]`).
- Bilateral auto-align: needs `FABMESH_SF3D_AUTOALIGN=1`, never set.

#### Conjoint conclusion: what to ACTUALLY try next

Both agents converge on the same insight: **the cause of E's blur is
a priority tie at the face azimuth between input.png and mv/view_0,
combined with winner-take-all per-texel arbitration**. NOT the layout
change. So we don't need to touch mv/.

Two parallel paths, both safe (no flip risk):

**Path 1 (Agent #1)**: edit texture_project.py to demote mv slots
that collide with `_src_azim` when SHIFT_SOURCE is on. ~5 lines.

**Path 2 (Agent #2 alt)**: in build_mv_dir, write `view_0.png` as
fully transparent (`Image.new('RGBA', (1024,1024), (0,0,0,0))`).
src_alpha=0 in the projection (l 314+324) → contribution nulle, no
moiré, input HD wins by default. ~1 line in ip45_2view_to_3d.py,
no texture_project changes.

Path 2 is simpler and risk-free. Will try it as Run I.

---

### Run H result — also flipped 180°

Run H (NORMALIZE=1 + SHIFT_SOURCE + view_0 = back image, all other
slots unchanged) was meant to keep the 7-view ortho layout intact
while removing only the doubled-front signal. Result: **also flipped
180° at the locked angle** (mesh shows back, denim back side, nuque).

So even swapping a single mv slot's image content is enough to flip
the mesh in the viewer. The flip isn't about layout structure
(7 vs 6 vs 5 slots) — it's about the **identity of pixels at each
azimuth**. As soon as the front area of the mesh has insufficient
front-pixel signal at the expected azimuths, model-viewer / xatlas
re-uvs in a way that swaps the visible side.

### Definitive learning — modifying mv/ contents is a dead end

After runs A..H, conclusion: **any change to the contents or layout
of mv/ flips the mesh** in the viewer's frontal camera frame.
- A: NORMALIZE=0 (sharp, well-placed)
- C: + R_undo Ry180 patch -> flipped
- D: NORMALIZE=1 standard (medium sharp, well-placed)
- E: + SHIFT_SOURCE -> floue (moiré HD vs 1024)
- F: + back-only mv -> flipped
- G: + skip view_0 -> flipped
- H: + view_0 = back image -> flipped

The ONLY stable, well-placed configurations are A, D, E. All paths
to improve their definition by editing mv/ images or views.json
flip the result.

To improve D/E without flipping, the next attack surface is the
**texture_project.py code itself**, NOT the mv/ inputs:
- Lower the hardcoded priority of `(0.0, 0.0)` for mv slots when
  the source image is also a mv slot (currently both get prio 1.0).
- Disable `FABMESH_TEXPROJ_REFINE` (the SDXL atlas refine pass
  may be amplifying the moiré rather than smoothing it).
- Disable `FABMESH_UV_REPACK` (xatlas re-pack may be the cause of
  the flip — it re-charts UVs based on which faces are visible from
  which views, and the viewer's frontal angle could be tracking
  the dominant chart island).
- Increase tex_res from 1024 to 2048 to reduce sub-pixel
  disagreement between input.png 1151px and view_0 1024px samples.

All four changes are safer because they don't touch mv/ contents.

### Run G result — also flipped 180° at locked angle

Run G (NORMALIZE=1 + SHIFT_SOURCE + skip view_0 only) was supposed to
preserve E's correct placement while killing the HD-vs-1024 moiré.
Result: G **also shows the back at the locked frontal angle**, just
like C and F.

Lesson: ANY change to the standard 7-view layout (input + view_0..5
at azims 0/90/180/270/0/0 in raw frame, becoming 180/270/0/90/180/180
post-shift) flips the visible front of the mesh in the viewer's
frame. C, F, G all flipped. Only D and E preserve the rendered "face
in front" pose. The placement constraint is **fragile**: it only
holds for the exact 7-view ortho cardinal layout that
texture_project / model-viewer expect.

So the path "drop view_0 to kill the moiré" is dead. Other angles to
try if we still want to fix E's face moiré:

- **Lower mv/view_0 priority** (e.g. 0.4 instead of 1.0) so input.png
  HD wins on the face but view_0 keeps voting on borders. Edits
  PRIORITY_WEIGHTS_TUP in texture_project.py.
- **Replace view_0 with a downscaled copy of input.png** so they
  agree pixel-for-pixel after resize, no sub-pixel disagreement.
- **Pre-shrink input.png to 1024px** so it matches mv/view_0 exactly
  -> still HD-resampled but no resolution mismatch.
- **Disable atlas refine** entirely and re-evaluate — the SDXL
  refine pass might be amplifying the moiré rather than smoothing it.

### D vs E — pending side-by-side face zoom

Both D and E look sharp at wide frame. E was reported earlier as
"face FLOU + ghosting" when zoomed in. Need final face-zoom
verification to choose:
- D wins -> ship as-is (NORMALIZE=1 baseline, no SHIFT_SOURCE).
  Drawback: HD input.png is wasted on the back of the mesh.
- E wins -> ship with FABMESH_TEXPROJ_SHIFT_SOURCE=1. HD on face is
  recovered. Risk: subtle moiré if mv/view_0 still doubles the front
  signal at low zoom.
- Both equivalent -> prefer D (simpler, no extra env flag, no risk
  of hidden moiré).

---

## 2026-04-18 — IP-scale sweep on child + ip45 front+back → 3D experiment

### Existing artifacts

`scripts/_scale_sweep.py` generated 15 images for the child ref across
IP scales {0.20, 0.25, 0.30, 0.35, 0.45} × {front, right, back} — output
in `images/child/_scale_sweep/`. Viewer at `_viewer.html` in same dir.

Visual read (not yet scored): ip25/ip30 produce a credible back view
that keeps the denim jacket + cargo shorts but clearly loses a bit of
identity (face not relevant on back anyway). ip45 preserves outfit best
but SDXL sometimes resists the `back view` prompt — still usable at
this scale for our subject.

### New experiment — 2-view 3D from ip45_front + ip45_back

Hypothesis: an SDXL multi-view set only needs to be *coherent on the
silhouette* to give SF3D enough signal for a decent textured mesh. So
rather than chasing 4 or 6 coherent SDXL views, feed CRM/SF3D just the
two best-scale images we already have, duplicated across the 6 slots.

### Plan

1. Patch `local_sf3d_bridge.py` to honor a new env var
   `FABMESH_MV_REUSE=<dir>` that skips internal multi-view generation
   and reuses a preexisting 6-slot dir (front/back/right/left/top/bot
   with a matching views.json).
2. New script `scripts/ip45_2view_to_3d.py`:
   - Takes `front.png` and `back.png` (default: the existing ip45_*
     from `images/child/_scale_sweep/`).
   - Writes a CRM-compatible 6-slot mv dir (front dup→right/top,
     back dup→left/bot).
   - Invokes SF3D bridge with FABMESH_MV_REUSE pointed at that dir.
3. Load resulting .glb in the Electron 3D viewer.

Expected outcome: textured mesh where **front and back faithfully match
the SDXL output**, but sides (being duplicates of front/back) may bleed
at az=90/270 seams — acceptable for a first pass. If bad, next step is
to add SDXL right/left at a lower ip_scale (0.30-0.35 per existing
_scale_sweep finding).

### Result

Run completed on child ip45_front + ip45_back in **81 s** total on RTX
5080 (SF3D inference ~1.5 s, texture_project ~2 s, SDXL atlas refine
~60 s for 9 tiles @ fp16). Output: `logs/child_ip45_2view/mesh.glb`
(1.54 MB, 8462 verts / 12596 faces / 2048 atlas). Viewer at
`logs/child_ip45_2view/viewer.html` (model-viewer side-by-side with
source PNGs).

### Bugs found + fixed along the way

1. `scripts/ip45_2view_to_3d.py` first wrote `views.json` as a **list**,
   but `texture_project.py` expects `{engine, views:[...]}` dict shape
   and fell back to Z123 schema → wrong camera angles for every
   projection. Fixed: wrap in dict with engine='ip45_2view'.
2. `local_sf3d_bridge.py` finally block did `rmtree(_multiview_dir)` —
   which, under `FABMESH_MV_REUSE`, was **deleting the user-supplied**
   mv dir after the run. Fixed: gate the rmtree on
   `not _mv_reuse_active`.
3. `texture_refine.py` loaded RealVisXL img2img with
   `torch_dtype=float16` but without `variant='fp16'` → some submodules
   stayed in fp32, every tile crashed on
   `mat1 and mat2 to have the same dtype, float != Half`, atlas was
   never actually refined. Fixed: pass `variant='fp16'` +
   `use_safetensors=True` + explicit `.to(float16)` cast loop on each
   submodule.

### Takeaways

- `FABMESH_MV_REUSE=<dir>` is now a first-class override for the SF3D
  bridge — any caller can supply a preexisting 6-slot dir and skip
  internal multi-view generation entirely.
- The tex_refine fp16 bug was silently dead code for every Electron
  user who hit refine mode: tiles failed, original atlas was kept, no
  error surfaced above WARN level. Worth a dedicated test once we have
  a regression harness.
- 2-view (front+back) with ip45 is **usable as a starting point** but
  the sides are frankly front+back smeared onto az=90/270 — visually
  wrong on a subject with asymmetric arms/pose. Need at minimum a 3rd
  SDXL view (profile at ip_scale 0.30-0.35 per _scale_sweep) before
  claiming this approach competes with CRM.

### Follow-up: "mouth on the calf" bug (BIG bake-orientation bug)

After viewing the first textured mesh in model-viewer, observed:
human face features (eyes, mouth) baked **onto the calves and back of
the legs** — clearly nonsense. Root cause:

- `local_sf3d_bridge.py` rotates the SF3D mesh +180° around Y after
  inference (env `FABMESH_SF3D_NORMALIZE_ORIENT=1`, default) so the
  face points to +Z (three.js camera convention). It also propagates
  this as `auto_align_rot_deg=180` to texture_project as
  `rotation_offset_deg`.
- `texture_project.py` applies that offset **only to multi-view
  azimuths** (line 397: `shifted_azim = (azim + rotation_offset_deg)
  % 360`) — but the source `input.png` is added separately at
  `(0, 0, priority=1.0)` line 383, with NO offset.
- Net effect on our 2-view setup:
  - input.png (front photo) → projected at azim=0 in the rotated
    frame → lands on the BACK of the mesh.
  - mv/view_2 (ip45_back) → azim 180+180 = 360%360 = 0 → projected on
    the FRONT of the mesh, with priority 0.7 (the `back` slot prio).
  - mv/view_0 (ip45_front dup) → azim 0+180 = 180 → projected on the
    back, with priority 1.0 (the `front` slot prio) — so the
    duplicated front WINS over the real back. Hence the entire mesh
    is dressed with mostly-front pixels, but on the **wrong side**,
    upside-down and laterally swapped. Faces end up on the legs.

This bug also affects the existing CRM pipeline whenever the
`auto_align_rot_deg` is non-zero, but is masked because the CRM
multi-view set is symmetric enough that the visual artifact looks
just "blurry" rather than "facially deranged".

### Fix

`scripts/ip45_2view_to_3d.py` now exports
`FABMESH_SF3D_NORMALIZE_ORIENT=0` to disable the bridge's +180°
rotation entirely. Our `views.json` describes camera angles in the
SF3D-native frame (face at -Z, azim=0 = camera looking from -Z = at
the face), and we pass front at azim=0, back at azim=180 — which is
now consistent with the source image at azim=0 (front).

After fix, projected azimuths in the log are now `0,0,90,180,270,0,0`
(no +180 offset injected), which is what we want for a 2-view ortho
schema. Texture should now sit on the correct side of the mesh.

### Diagnostic instrumentation added

`texture_project.py` now writes two PNG diag maps when
`FABMESH_TEXPROJ_DIAG=1`:
- `<mesh.glb>.diag_sourceview.png`: per-texel source view (palette of
  7 hues, black = no data).
- `<mesh.glb>.diag_coverage.png`: per-texel contributor count (0 = hole,
  1 = single fragile, 2..6+ = increasingly safe).

These let us see at a glance whether a baked artifact is a
projection-mapping bug (wrong source view dominant) vs. a coverage
hole (push-pull guesswork).

---

## 2026-04-18 — Multi-view repair pass (option B): detector + SDXL-Inpaint

Follow-up to child analysis. Option B from the 3-way split:
"Inpaint-repair hallucinated multi-view regions using ref as IPAdapter
conditioning." Ships as a standalone script — can run after any
engine (CRM / Z123 / SDXL / MV-Adapter later).

### New file: `scripts/multiview_repair.py`

**Detector** (no-GPU, runs first):
- Scores each view on weirdness = dark_excess + sat_excess + (1-palette_sim)
- `excess` = view ratio minus ref's own ratio + 5% slack. This is
  critical for naturally dark subjects (zebra, panda) — otherwise
  their own stripes would false-flag.
- Hard-trigger at dark_excess > 8% or sat_excess > 5% → weirdness += 0.4
- Threshold default 0.55.

**Repair** (GPU):
- SDXL-Inpaint 1.0 + IP-Adapter Plus SDXL + RealVisXL-class base.
- ip_scale per slot: front 0.75, sides 0.55, back 0.60, top/bottom 0.55.
- Slot-aware prompts: "top down view, looking down from above", etc.
- Strength 0.95, 35 steps, guidance 7.5.
- Backs up originals in `<mv_dir>/.repair_backup/` before overwrite.

### Detector validation

Tested on 2 subjects:
- **child** (clean ref, dark=0.010): flags slot 5 only (w=0.89). ✓
  Matches human assessment (only bottom view is hallucinated).
- **zebre** (zebra from front, dark=0.011): flags slots 0,3,4,5. ✓
  Matches earlier human assessment of weak zebre multi-views.

After ref-anchoring (5% slack), no false positives on the clean slots.

### CLI
```
python scripts/multiview_repair.py <mv_dir>               # auto-detect
python scripts/multiview_repair.py <mv_dir> --force-slots 4,5
python scripts/multiview_repair.py <mv_dir> --threshold 0.5
```

### Live test on child slot 5 — RESULT

- First attempt (dark-pixels-only mask, 6.4% coverage, strength 0.95):
  no visible improvement. Surrounding hallucinated context dragged
  SDXL back to the same black-mass answer.
- Second attempt (script auto-selected defect-only mask because
  already-repaired palette_sim passed threshold): re-repaired the
  remnant 3% — still no gain.
- **Third attempt, `--full-fg --strength 0.98`**: strong improvement.
  Slot 5 weirdness 0.886 → 0.075. palette_sim 0.011 → 0.760.
  dark_ratio 0.533 → 0.068. 17s on RTX 5080.

### Result interpretation

The SDXL-Inpaint output is NOT a true bottom-up orthographic view
(SDXL doesn't know that perspective). It produces a low-angle/frontal
rendering with the child's denim jacket + arms spread. BUT: it's
plausible, coherent, and shares palette with ref — so SF3D projecting
it onto the bottom of the mesh will yield coherent color instead of
the black holes we saw before.

### Takeaways

1. **ALWAYS use `--full-fg`** when weirdness > 0.7. The defect-only
   mask strategy fails when the surroundings are also hallucinated.
2. Default `repair` decision threshold 0.55 stands. Detector catches
   the right slots (child: only 5; zebre: 0,3,4,5).
3. **This is a partial fix** — for a true top/bottom view, MV-Adapter
   or Era3D is still the right long-term solution. But the repair
   pass is a cheap (≤30s/view) guardrail that prevents black-hole
   artifacts on the mesh.

### Next integrations
- Hook repair into `main.js` multi-view pipeline as optional post-step
  (env `FABMESH_MV_REPAIR=1`).
- Later: offer per-slot repair UI in the multi-view review dialog
  ("regenerate this view with repair").

### Zebre test — 4 slots repaired (0, 3, 4, 5)

|slot|before w|after w|before palette|after palette|visual|
|---|---|---|---|---|---|
|0 front  |0.76|0.56|0.023|0.678|GOOD — real zebra face+body|
|3 left   |0.80|0.78|0.011|0.061|GOOD visually — striped side-profile zebra|
|4 top    |0.77|0.24|0.013|0.265|MEDIUM — coherent downward view|
|5 bottom |0.77|0.74|0.019|0.083|MARGINAL — incoherent bottom|

49s total for 4 slots.

### Finding: detector false-positives on naturally-striped subjects

Zebre ref shows front-view stripes. Detector's `ref_stats` only
captures ~1% dark pixels because alpha-masked ref doesn't pick up
stripes as "dark". Side/left views of a striped subject then have
much higher dark_ratio (30%) than ref's baseline — detector
flags them even though they're correctly rendered.

### Mitigation options (future)
1. Use LAB color space instead of luminance for "dark" detection —
   stripes show as neutral-chroma, not dark.
2. Compute ref_stats from the already-known-good front view
   (view_0 if it passes detector) instead of input.png.
3. Per-slot weirdness threshold: tighter for TOP/BOTTOM
   (high-prior-failure), looser for sides.

### Verdict
Repair pass ships as-is. For "clean subjects with hallucinated
TOP/BOTTOM" (child, zombi) it's a clear win. For "naturally
patterned subjects" (zebra, dalmatian) it still improves palette
but the detector may need per-subject tuning. Document expected
behavior in `FABMESH_API.md`.

### 2026-04-18 — Zebre re-test revealed destructive repair bug

User screenshot showed view_3 with "double silhouette" — repaired
zebra inside a ghost alpha outline of the original. Root cause:
- Detector false-flagged left/right/bottom zebre views (palette_sim
  is pathologically low on striped subjects — different stripe
  arrangement between CRM output and ref gives near-zero hist
  cosine even when both are correct zebras).
- --full-fg mask + strength 0.98 made SDXL regenerate the subject
  with a DIFFERENT silhouette than the original alpha, leaving the
  original alpha outline visible around the new (smaller) zebra.

### Fixes applied
1. Auto mode now requires `dark_excess > 0.15 OR sat_excess > 0.05`
   in addition to weirdness > threshold. Pure palette-drift alone
   no longer triggers repair (it's likely generator-noise, not
   hallucination).
2. `full-FG` auto-activation only for `weirdness >= 0.85 AND
   palette_sim < 0.05` — child-bottom still qualifies, zebre
   side-profiles no longer do.
3. Mask has no dilation in full-FG mode, blur radius 1.5 instead
   of 4 — reduces "shadow clone" artifacts outside silhouette.
4. Post-inpaint, RGB pixels outside the original alpha are
   zeroed explicitly — hardens against any residual ghost.

### Next: user wants a better multi-view pipeline
Agent dispatched to research "how to get 6 clean consistent views
of the same mesh" — MV-Adapter, SV3D, Era3D, etc.

---

## 2026-04-18 — MV-Adapter integration — IN PROGRESS

**Goal**: ship MV-Adapter i2mv-sdxl as new `FABMESH_MV_ENGINE=mvadapter`
option. Apache 2.0, local, 768px, 6 views with arbitrary (az, el).

### Files added/changed
- `external/MV-Adapter/` — git submodule (huanngzh/MV-Adapter)
- `external/MV-Adapter/mvadapter/utils/mesh_utils/__init__.py` — patched
  to lazy-load nvdiffrast-dependent modules (FabMesh only needs
  camera helpers; mesh/render paths need nvdiffrast which we don't
  want to compile).
- `external/MV-Adapter/mvadapter/utils/mesh_utils/utils.py` — also
  patched for optional `dr` import.
- `scripts/multiview_mvadapter_gen.py` — new generator following same
  CLI contract as `multiview_crm_gen.py`. Env vars:
    - `FABMESH_MVA_BASE` (default `stabilityai/stable-diffusion-xl-base-1.0`)
    - `FABMESH_MVA_CPU_OFFLOAD` (default off — hooks break attention cache)
    - `FABMESH_MVA_PROMPT` / `FABMESH_MVA_SUBJECT_PROMPT`
- `src/main/main.js` — dispatch mapping adds `mvadapter`
- `scripts/local_sf3d_bridge.py` — same dispatch update

### Issues hit
1. **nvdiffrast missing** — MV-Adapter pulls it transitively via
   `mesh_utils/__init__.py`. Patched `__init__.py` + `utils.py` to
   skip the heavy-rendering modules when nvdiffrast is absent.
2. **KeyError on first run** with RealVisXL V4.0:
   `down_blocks.1.attentions.0.transformer_blocks.0.attn1.processor`
   not in `ref_hidden_states`. MV-Adapter's DecoupledMVRowSelfAttnProcessor
   caches hidden states per attn layer name during the first UNet
   forward; on the inference forward it looks them back up. The cache
   was incomplete. Likely cause: either RealVisXL layer-name drift,
   or diffusers 0.34 `accelerate` CPU-offload hooks dropping
   `cross_attention_kwargs` before it reaches the down-blocks.
3. Fix attempt: switch base to `stabilityai/stable-diffusion-xl-base-1.0`
   + disable CPU offload by default. Second run failed before even
   hitting the issue — my own bug (`base_model` referenced before
   assignment). Patched.

### Status
Not working yet. Next run pending. If KeyError persists on vanilla
SDXL without offload, the root cause is diffusers version mismatch
(MV-Adapter validated against ~0.30; we have 0.34). Options:
- pin diffusers~=0.30 in a FabMesh venv scoped to this script
- patch MV-Adapter's attn processor to use `.get(name, fallback)`
  instead of `[name]`

---

## 2026-04-17 — Child project analysis: multi-views insufficient, mesh degraded

User: "analyse le dernier projet que jai créé le resultat (multi vues et mesh) ne sont pas suffiant"

Project: `images/child/` (ref = photoreal child T-pose, denim jacket,
white T, khaki cargo shorts, sneakers — clean black background).

### Multi-views (CRM, 6 views)
- **view_0 / front (0°)**: acceptable, jacket slightly shinier/synthetic
  vs ref, face softened.
- **view_2 / back (180°)**: reasonable, hair crown coherent, jacket
  back plausible.
- **view_4 / TOP (+90° elev)**: weak — body stretched, proportions wrong.
- **view_5 / BOTTOM (-90° elev)**: hallucinated — black mass, shoes
  barely recognizable, feet geometry incoherent.
- **view_1 / right, view_3 / left**: profile lost detail on jacket seams.

### Mesh (`child_sf3d_1776467095964.glb`, 3/4 thumbnail)
- Silhouette: arms-out T-pose preserved. Face badly simplified — eyes,
  nose, mouth smudged into a single dark band.
- Torso OK, denim jacket color transferred.
- **Hands: mangled into red/orange blobs** (not flesh-toned) — this is
  the same signature we see when projection falls back on an unseen
  region and the nearest projected source is a reddish area.
- Legs + shorts: color fine, shape cylindrical/stiff.
- Feet: deformed, sneakers barely a shape.

### Root cause
1. CRM is Objaverse-trained; children + T-pose extremities (hands,
   feet) are under-represented → hallucinated TOP/BOTTOM + weak profiles.
2. SF3D rebuilds geometry from the 6 views. Hallucinated TOP/BOTTOM
   propagate to the mesh (mangled hands/feet).
3. Texture projection (push-pull) is working — atlas is uniform — but
   it can only project what the multi-views contain. Garbage in,
   garbage out.

### Pattern confirmed
Same failure mode as: zebre (quadruped), zombi, chat_vert. The
weakness is CONSISTENTLY at TOP + BOTTOM + distant extremities. Only
the oiseau (bird, compact silhouette, round body) worked well because
TOP/BOTTOM of a bird is plausible to CRM priors.

### Conclusion
The bottleneck is NOT texture projection (already fixed), NOT SF3D
per se — it's **multi-view quality on non-compact subjects**. The
queue is:
1. Disable TOP/BOTTOM generation OR downweight them in SF3D pass
   (cheap, few hours).
2. MV-Adapter i2mv SDXL (agent recommendation #1, best quality).
3. Per-slot multi-seed was implemented but disabled — 16 GB VRAM
   can't hold CRM + SF3D + 3 seeds concurrently.

### Next experiment to try
Run SF3D with only 4 views (front/right/back/left, skip TOP/BOTTOM)
and see if hands/feet improve. If yes → make this the default for
characters with a clean ground plane.

---

## 2026-04-17 — Multi-view improvement options — benchmarked by agent

User question: "can we improve the multi-view?" Agent investigated
5 options and ranked them by quality-gain / effort / EU-license safety.

### Ranking (best first)

**#1 — MV-Adapter i2mv SDXL (Apache 2.0)** — RECOMMENDED
  - Plug-and-play SDXL adapter, 6 view-consistent 768px images from
    1 ref. Reuses our RealVisXL V4.0 base, +3.6 GB adapter only.
  - VRAM: ~14 GB (fits 5080). Effort: ~6-8 h dev.
  - Expected on mannequin back: HIGH quality.
  - Benchmark paper: beats Z123++ and Era3D on GSO.
  - URL: github.com/huanngzh/MV-Adapter
  - **This is the "real multiview-native model" option user asked for.**

**#2 — Hybrid Z123 → SDXL+IPAdapter cleanup at strength=0.55**
  - Keep Z123 geometric skeleton, re-paint each view with higher
    IPAdapter strength (current 0.35 is too shy, 0.55-0.65 would
    overwrite hallucinations while preserving identity).
  - VRAM: 0 new. Effort: 1-2 h (1 line change + per-view schedule).
  - Expected on mannequin back: MEDIUM-HIGH.
  - Easiest quick win before shipping #1.

**#3 — xinsir ControlNet-OpenPose per view (Apache 2.0)**
  - Only helps humanoid T-pose subjects. Generate skeleton PNG per
    azimuth (front/right/back/left) + SDXL + OpenPose + IPAdapter.
  - VRAM: ~12 GB. Effort: ~1 day.
  - Expected: HIGH for humans, USELESS for props.
  - Gate by existing _is_tpose detector in local_juggernaut_bridge.

**#4 — Dual-reference UI workflow (front + optional back image)**
  - UI adds 2nd dropzone, `multiview_gen.py --back-image` skips Z123
    for view_3 when provided.
  - Effort: ~3-4 h. No model changes.
  - Expected: PERFECT when user has back photo, zero help otherwise.

**#5 — Z123 param re-tune (cheapest, probably dead-end)**
  - Current cfg=5.5, steps=150. Z123 v1.2 tuned for cfg=4.0, 28-75 steps.
  - AGENT_LOG already states Objaverse training-data lack is fundamental.
  - Effort: 30 min. Worth A/B-testing as baseline but won't fix mannequin.

### Avoid
  - Wonder3D (AGPL-3.0 — incompatible with commercial closed-source)
  - Hunyuan3D-2 (Tencent Community — EU excluded)
  - IP-Adapter FaceID (research only)
  - Unique3D (MIT OK but produces mesh, not a drop-in multiview)

### Recommended sequencing
  1. TONIGHT: option #2 — bump identity-harmonize strength 0.35→0.55
  2. THIS WEEK: option #1 — bridge MV-Adapter as new default
  3. LATER: option #3 gated on humanoid detection
  4. UI polish: option #4 as "power user" feature

## 2026-04-17 — MV-Adapter i2mv SDXL — implementation plan (agent #2)

**Fact sheet**:
  - Repo: github.com/huanngzh/MV-Adapter (Apache 2.0)
  - HF weights: `huanngzh/mv-adapter` / `mvadapter_i2mv_sdxl.safetensors` (~740 MB)
  - Image encoder: `facebook/dinov2-large` (~1.2 GB, Apache 2.0)
  - Pipeline class: `MVAdapterI2MVSDXLPipeline`
  - Base: reuses our existing SG161222/RealVisXL_V4.0 (no duplicate)
  - Total new disk: ~1.95 GB
  - VRAM peak: ~11-12 GB fp16 (fits RTX 5080 16 GB)
  - Deps: diffusers>=0.30, transformers>=4.40, peft>=0.11
  - Azimuths: custom kwarg → pass Z123 schema [30,90,150,210,270,330]
    with elev [20,-10,20,-10,20,-10] for drop-in compat

**9-step roadmap (~9h total)**:
  1. git submodule add MV-Adapter to external/
  2. new scripts/multiview_mvadapter_gen.py (same CLI as Z123)
  3. Wire RealVisXL base + offload if VRAM<14GB
  4. Load adapter + DINOv2 encoder
  5. Pass Z123-matching azimuths to pipeline call
  6. Save view_0..5.png + input.png (same layout)
  7. Bridge dispatch: FABMESH_MV_ENGINE=z123|mvadapter|sdxl
  8. Silhouette-hash cache keyed with engine name
  9. UI dropdown "Multi-view engine" in Settings→Advanced
  10. Calibration gallery extension (side-by-side)
  11. AGENT_LOG + README update

**Risks**:
  - VRAM blowout (medium) → enable_model_cpu_offload() guard
  - diffusers version drift (medium) → pin 0.30.3
  - Azimuth convention mismatch (medium) → validate on mannequin

**GO/NO-GO**: GO. Default-off via env flag during validation, Z123
stays safety net. Flip default once mannequin back shows orange/black
instead of Z123's green hallucination.

## 2026-04-17 — 6-view model with TOP+BOTTOM — AGENT REPORT

User question: which AI model generates 6 CANONICAL views including
TOP and BOTTOM (elev ±90°) — not just horizon views like Z123/MV-Adapter?

### Ranked candidates

| # | Model | License | Top+Bot? | VRAM | Disk | Notes |
|---|-------|---------|----------|------|------|-------|
| 1 | **CRM (thu-ml)** | **MIT** ✓ | **YES native 6 ortho incl. up/down** | 8-10 GB | 3 GB | Best direct answer |
| 2 | **TRELLIS.2** | MIT ✓ | N/A (full mesh) | 12-14 GB | 10-12 GB | SOTA 2025, PBR |
| 3 | **SPAR3D** | Community (<1M$) ✓ | N/A (full mesh) | 8 GB | 4 GB | 0.7s/obj |
| 4 | **Stable Zero123C** | Community ✓ | YES arbitrary (az,el) | 8 GB | 2 GB | Per-view, less consistent |
| 5 | **Unique3D** | MIT ✓ | **NO** (only 4 horizon views) | 8 GB | 4 GB | Excluded |
| 6 | **Era3D** | AGPL-3.0 ✗ | No | - | - | Copyleft excluded |
| 7 | **SV3D / Wonder3D / One2345++** | Non-commercial ✗ | - | - | - | Excluded |

### TOP recommendation: **CRM**
  - Repo: github.com/thu-ml/CRM (MIT)
  - Weights: huggingface.co/Zhengyi/CRM
  - Paper: arxiv.org/abs/2403.05034
  - Literally designed around "six orthographic views including up and
    down" — the exact feature we need
  - Commercial + EU-safe (MIT)
  - Fits RTX 5080 VRAM budget

### Alternative: hybrid MV-Adapter + Stable Zero123C
  - Keep MV-Adapter for F/B/L/R (already planned)
  - Call Stable Zero123C twice for (elev=+90) and (elev=-90)
  - SZ123C accepts arbitrary (az, el) unlike Z123++

### RECOMMENDED production path (long-term):
  **Mesh-first render-and-refine**:
    1. Generate mesh via SF3D/TripoSG/CRM
    2. Render 6 canonical views from raw geometry (trimesh/pyrender)
       at exact F/B/L/R/T/B
    3. img2img refine each view with SDXL + depth/normal ControlNet
       + IPAdapter (identity from ref)
  This fixes the chicken-and-egg: proxy views have correct silhouette
  + normals, diffusion only repaints texture. SDXL reliable at that.
  This is what Meshy/Rodin do internally.

### NEXT STEP (user decides)
  - Short-term: integrate CRM as new multi-view backend (1 week)
  - Long-term: mesh-first render-and-refine as v2 texture path

## 2026-04-17 (end of day) — CRM INTEGRATED, WORKING ON MANNEQUIN

Delivered:
  - `external/CRM` submodule (MIT license)
  - `scripts/download_crm_weights.py` — fetches CRM.pth + pixel-diffusion.pth
    + ccm-diffusion.pth (~12 GB total from HF Zhengyi/CRM)
  - `scripts/multiview_crm_gen.py` — CLI-compatible with multiview_gen.py
  - `scripts/local_sf3d_bridge.py` — FABMESH_MV_ENGINE=z123|sdxl|crm dispatch
  - Patches in external/CRM/:
    - libs/base_utils.py: stub EMAModel (torch 2.7 incompat)
    - imagedream/ldm/modules/attention.py: SDPA fallback when xformers absent
    - pipelines.py: SKIP stage2 when resume='SKIP' or missing

Test on mannequin_ref.png (FABMESH_MV_ENGINE=crm):
  - 5.5 min wall-clock (vs Z123 45s), scale=5.5, step=30
  - 6 views produced, TOP+BOTTOM native
  - view_0 front: mannequin reconstructed with F+H+stripes+dots ✓
  - view_2 back: damier + identity preserved (not orange/black but
    consistent with front, NO hallucination)
  - view_4 TOP: head from above + arms extended + limb colors ✓
  - view_5 BOTTOM: legs+arms from below ✓

CRM output at 256×256, upscaled to 1024. Grey-bg threshold removed
for alpha. Much better than Z123 for top/bot (which Z123 can't do
at all). Back quality similar to SDXL+IPAdapter but with TOP/BOT
bonus.

Backup tag: before-crm-integration-20260417.

### NEXT: test full pipeline (CRM multi-views → SF3D → texture_project)
to see end-to-end quality on a real character.

## 2026-04-17 — CRM routing bug + fix (user "vache" test)

**Symptom**: user ran Generate on "vache" project, expected TOP/BOT
views, none produced. Only view_0..view_5 in classic Z123 layout.

**Root cause**: `main.js` hardcoded `multiview_gen.py` at two call
sites (line 861 mv-inherit, line 3642 generate-multiview IPC).
Setting FABMESH_MV_ENGINE=crm in the launcher env had NO effect
because the script path was never read from env.

**Fix**: added `_mvScriptForEngine()` helper that maps engine name
to script path. Both call sites now use it. Z123 remains the
default when FABMESH_MV_ENGINE is unset.

**Verification**: killed electron + restarted with env=crm,
deleted `images/vache/ref_0_multiview/` cache so the bridge
regenerates from scratch. User must retry "Generate".

**Dependency chain unresolved in the same session**:
  - xformers 0.0.35 (tied to torch 2.11) broke SDXL imports;
    uninstalled
  - diffusers 0.37 broke on torch 2.7 (GroupName import);
    pinned 0.34
  - transformers 5.5 dropped FLAX_WEIGHTS_NAME; pinned 4.46
  - CRM itself needed EMAModel stub + SDPA fallback + stage2 SKIP

All committed. All patches documented above in the CRM Integration
section. Tests on mannequin worked; real user test pending.

## 2026-04-17 — Stage 4 root cause found, NOT yet fixed

**Agent investigation report**: Stage 4 fails (1/6) on the GT cube
because the cube is authored in natural glTF frame (front=-Z, up=+Y),
while `texture_project.py` expects SF3D post-transform frame. SF3D
bakes Rx(-90) @ Ry(+90) into its GLB output; `texture_project` has
R_undo = Rx(+90) @ Ry(-90) to reverse it. Applied to the natural-frame
cube, R_undo scrambles the axes → TOP face receives RIGHT view, etc.

**Why real meshes work**: SF3D output → auto-align adds rotation_offset
→ texture_project R_undo → multi-view azimuths shifted. The full chain
is self-consistent only when every step is taken. GT cube skips the
bridge + auto-align, so the chain breaks.

**What was tried (all failed to reach 6/6)**:
  1. Pre-rotate GT cube into SF3D frame before export — 0/6
  2. Post-rotate output mesh back to natural before render_axis — 0/6
  3. FABMESH_TEXPROJ_SKIP_UNDO=1 — 0/6
  4. Basis sweep (24 signed-axis permutations of R_w2c_base) — best 3/6 (p18)
  5. 8 rotation-offset × U-flip combinations — best 1/6 unchanged
  6. rotation-offset -90 — worse (0/6, scores 0.33-0.50)
  7. Fine rotation-offset sweep (13 angles):
     - rot=0 → 0/6
     - rot=30 → 0/6
     - rot=45 → 0/6
     - rot=60 → 1/6
     - **rot=90 → 2/6 (best: front+right PASS)** ← visual still wrong
     - rot=120 → 1/6
     - rot=150..330 → 0/6

**Process differences (origin vs calibration stage 4)**:
| | Real pipeline (works) | Stage 4 GT cube (fails) |
|---|---|---|
| Input mesh | SF3D output (has Rx(-90)@Ry(+90) baked) | Natural glTF frame (no bake) |
| Auto-align | Yes (Y rotation) | No |
| rotation_offset | Inherited from auto-align | 0 by default |
| R_undo in texture_project | Correctly unbakes SF3D xform | Scrambles natural cube |
| Multi-views | Zero123++ output on real subj | Pre-rendered from GT cube (natural frame) |
| Net effect | Self-consistent chain | 3 conventions mismatched |

**Best score**: 2/6 at SKIP_UNDO=1 + rotation-offset=90. FRONT 0.638,
RIGHT 0.665. Front+right pass by palette coincidence mostly.

**Arithmetic trace of R_undo on face normals** (proves why fix is hard):

R_undo = Rx(+90) @ Ry(-90) = [[0,0,-1],[-1,0,0],[0,1,0]]

| Face (natural normal) | Post-R_undo normal | Matching (az,el) |
|---|---|---|
| FRONT (0,0,-1) | (+1,0,0) | az=0, el∈{0,20,-10} ✓ |
| BACK (0,0,+1) | (-1,0,0) | az=180 ✓ |
| TOP (0,+1,0) | (0,0,+1) | az=270 (!) ✓ |
| BOTTOM (0,-1,0) | (0,0,-1) | az=90 (!) ✓ |
| RIGHT (+1,0,0) | (0,-1,0) | **NO MATCH** in Z123 angles |
| LEFT (-1,0,0) | (0,+1,0) | **NO MATCH** |

So R_undo maps TOP/BOTTOM → horizontal azimuths, and RIGHT/LEFT → to
the ±Y axis which Zero123++ never images directly (elev is only ±20).
**The vertical Y axis of the subject becomes uncoverable.**

That's why 2/6 is the ceiling with rotation tweaks alone: we can get
FRONT + BACK or FRONT + one side to align, never more.

**Full fix requires TWO coordinated changes**:
  (1) change R_w2c_base so natural +Y = camera up
  (2) keep R_undo = identity for the GT cube
These two break the real pipeline (which relies on the current basis +
R_undo). Making the fix backward-compat needs either a flag on the
bridge that signals "input is already canonical" and selects a
different code path, or a cube asset rebuilt in SF3D frame so both
paths use the same convention.

**Not done tonight**: the backward-compat refactor. Session ends with
stage 4 at 2/6 stable, full diagnostic visible in UI, user can see
per-face GT-vs-got. Real pipeline untouched.

### Full-pipeline test on GT cube image (2026-04-17 late) — HALLUCINATION CONFIRMED

Ran `local_sf3d_bridge.py` on `ref_0.png` (the flat F-striped cube image):
  - Output: 24343 verts / 45248 faces (full pipeline succeeded in 3min)
  - FRONT: F visible but texture granular + rayures bruitées
  - BACK: bruit + hallucinations rayures (Zero123++ couldn't imagine
    back of a flat cube)
  - TOP: hexagonal pattern artefacts (SF3D out-of-distribution)

**Definitive conclusion**: The real pipeline ALSO produces bad textures
on the flat calibration cube. It's not a calibration-only bug — the
whole pipeline is unsuited to flat-color out-of-distribution inputs.

On real photorealistic subjects (dog, horse, orc) the pipeline works
because SF3D+Zero123++ were trained on Objaverse photo-like renders.

**Implication for calibration**: Stage 4 will never pass 6/6 on the
synthetic cube, not because texture_project is broken, but because
the pipeline inputs it expects don't exist for this asset. Use
Stage 4 as a REGRESSION detector (did score drop vs last run?) not
as a correctness oracle.

### 2026-04-17 end-of-day — Full pipeline test on T-pose person — PARTIAL

Generated a photoreal T-pose person via RealVisXL, ran full
local_sf3d_bridge on it. Result: 6553 verts / 10088 faces.

Visual 6-axis render:
  - FRONT: silhouette OK, t-shirt + jeans visible but VERY pixelated
    ("tile-like" noise artefacts everywhere, not smooth color)
  - BACK: back visible, same granular noise
  - RIGHT/LEFT: side profiles correct, same noise
  - Shape: correct T-pose, arms extended, head + limbs recognisable

**Conclusion**: The REAL bug the user has been seeing all along is
NOT in UV projection (Stage 4), it's in the atlas resolution /
SDXL refine tile quality. The pipeline gets the geometry + azimuth
mapping right on in-distribution humanoids, but the final texture
quality is low-fidelity. Likely causes:
  - SF3D base atlas is ~512-1024px for the whole mesh
  - SDXL refine tiles sometimes hallucinate noise patterns
  - Vertex density too low to support fine details

### 2026-04-17 NEXT STEP — Crash-test mannequin asset (IN PROGRESS)

User request: build a humanoid mannequin (in-distribution for SF3D)
with each body zone labeled by a unique color + pattern + letter.
If the texture projection puts "F" on the back or "L" on the right
arm, the mismatch is instantly visible. Zones:
  - Torso FRONT = yellow/black checker + "F"
  - Torso BACK  = orange/black checker + "B"
  - Left arm    = red stripes + "L"
  - Right arm   = blue stripes + "R"
  - Left leg    = green dots + "LL"
  - Right leg   = purple dots + "RL"
  - Head top    = plain orange + "H"

This gives a proper calibration asset that is:
  (a) In-distribution (humanoid shape SF3D has seen 1000s of times)
  (b) Traceable (each zone's projection can be visually verified)

### 2026-04-17 — Mannequin full-pipeline test — CRITICAL FINDING

Ran local_sf3d_bridge on mannequin_ref.png (3/4 view of a humanoid
with yellow/black F checker front + orange/black B checker back).

Result: 7112 verts / 11844 faces.
Visual 4-axis render:
  - FRONT: silhouette + palette CORRECT. Yellow/black checker visible
    on torso, red/blue stripes on arms, green/purple dots on legs,
    orange head. F letter illegible due to noise but color zones right.
  - BACK: texture WRONG. Atlas shows yellow/green/white checker pattern
    instead of orange/black. SF3D hallucinated the back because
    Zero123++ couldn't correctly imagine the back of a stylized figure.
  - RIGHT/LEFT: mesh is nearly flat (0 depth on sides) because input
    was 3/4 not profile — SF3D reconstructed a flat silhouette.

**Root-cause verdict**: The texturing problem the user has been seeing
for weeks is NOT primarily in texture_project.py. It has 3 layers:
  1. Zero123++ hallucinates back/sides on stylized or unusual inputs
  2. SF3D reconstructs flat sides when input is 3/4 instead of profile
  3. texture_project then has nothing real to project from on back/sides
     → falls back to SF3D's blurry baked atlas → noise artefacts

Fixing texture_project alone cannot solve this. Upstream improvements
needed:
  - Better multiview generator (TRELLIS, Unique3D, MV-Adapter)
  - OR force user to provide back image separately (UI workflow change)
  - OR accept that texture fidelity on non-front regions is capped

For calibration: the mannequin asset is NOW valuable for detecting
pipeline regressions visually (F on back / R on left arm / etc.)
even though it won't reach 6/6 score with current pipeline.

**What works**:
  - UI calibration button functional in ~7s
  - Per-stage visual comparison HTML (expected vs got)
  - Bug precisely localized and visualized

**Open question for next session**: the full chain has THREE coupled
conventions (SF3D post-transform, R_undo in texture_project, Zero123++
camera basis). Fixing any single one breaks the others. Next approach
should either:
  (a) parameterize ALL three simultaneously and sweep the joint space
  (b) bypass R_undo + use a cube authored in SF3D output frame + render
      with SF3D-frame cameras — fully self-consistent isolated test
  (c) accept stage 4 at 3/6 as "detect regression" floor and move on

**Backup**: `calib-before-redesign-20260417` (pre-v3 state).

## 2026-04-17 — Calibration v3: Stage 4 REVEALS real UV bug

**First Stage 4 run** (deterministic: GT cube GLB + GT multi-views
fed directly to texture_project.py, no SF3D/Zero123++ involvement):
  - front:  sim=0.65 OK  (letter F slightly washed but correct)
  - back:   sim=0.598 FAIL
  - right:  sim=0.500 FAIL
  - left:   sim=0.439 FAIL
  - top:    sim=0.514 FAIL
  - bottom: sim=0.390 FAIL
  - Overall: **1/6**, all failures on non-front axes.

**Visual inspection**: the rendered FRONT shows the letter "F" as a
**horizontal mirror** of the GT (the F's crossbars point left instead
of right). This is a UV-to-atlas u-axis flip in texture_project.py
affecting every non-front face.

**This is the kind of bug the calibration system was built to catch.**
v1 (hand-painted cube) and v2 (Rubik's) couldn't reproduce it because
they also ran SF3D in the loop and the mesh hallucination masked the
projection bug. v3 stage 4 bypasses SF3D entirely → bug exposed in 7s.

**Next**: diagnose the U-flip in texture_project (likely in the
per-face UV emission or the camera-to-UV convention). Then implement
stages 2/3/5 + wire into UI.

## 2026-04-17 — Calibration v3 architecture defined

**Why abandon v2**: Every v2 attempt tried to score the entire
pipeline end-to-end on one reference. This conflated "pipeline
correctness" with "generative quality" — a scoring death spiral:
  - Hand-painted cube (flat colors, letters): out-of-distribution for
    SF3D. Max 1/6 forever.
  - Synthetic Rubik's: same OOD problem.
  - RealVisXL Rubik's photo: in-distribution for Zero123++ but
    per-face color positions are random — no deterministic GT possible.
  - RealVisXL apple: in-distribution, GT not possible (no face labels).

**v3 architecture** (planned via Plan-agent this session):

Five **independent** per-stage checks, each with inputs/outputs that
do NOT depend on upstream stages. The key trick — the colored-cube
GLB is NOT a pipeline input; it is a stage-4-only asset whose 6 GT
views in `ref_0_multiview_perfect/` are **inputs to texture_project**,
making stage 4 fully deterministic.

| Stage | Test | Pass |
|---|---|---|
| 1 — Ref image | dims, stddev, background clean | bool |
| 2 — Multi-views | silhouette centroids differ + color hist consistent | both |
| 3 — Mesh SF3D | orthographic front silhouette IoU vs input alpha | >= 0.70 |
| 4 — Projection | run texture_project on GT cube + GT views, render 6 axes, classify | 6/6 |
| 5 — Final GLB | render from input camera, perceptual similarity vs input | >= baseline - 0.05 |

**Backup tag**: `calib-before-redesign-20260417`.

**Roadmap commits**:
  1. module scripts/calib/stage_checks.py with 5 pure functions
  2. Stage 4 implementation (ROI max — catches 90% of UV/camera bugs)
  3. Stage 3 (silhouette IoU)
  4. Stages 2, 1, 5
  5. Orchestrator run_calibration.py + UI
  6. Per-stage baselines .fabmesh/calib_baselines.json for regression detection

---

## 2026-04-17 (late) — Calibration v2: Rubik's target + API + detailed logs

**Context**: After the painted-cube experiment scored 1/6 at best, the
diagnosis pointed at SF3D being out-of-distribution for stylized flat-color
inputs. User requested a switch to a canonical in-distribution object.

**Built**:

1. **Rubik's Cube calibration asset** (`scripts/_calib_build_rubiks.py`)
   - 6 canonical Western Rubik's colors (red/orange/blue/green/white/yellow)
   - 3×3 sticker grid with black borders + center-sticker letter per face
   - Produces `ref_rubiks.png` (ortho front), `ref_rubiks_multiview_perfect/`
     (6 GT views at z123 angles), `ref_rubiks_axes_perfect/` (6 axis GT),
     `meshes/_calibration/rubiks_groundtruth.glb`.
   - Auto-picked by default via env var `FABMESH_CALIB_TARGET=rubiks`
     (set to anything else to fall back to the painted cube).

2. **Control API endpoints** (in `src/main/control_api.js`), all local-only
   on 127.0.0.1:7331, auth-token gated:
   - `POST /calib/run` — full auto-diagnose pipeline (~4-5 min), returns
     summary + stages + verdict + log path
   - `GET /calib/list-reports` — all past runs with scores
   - `GET /calib/last-report` — most recent run's full data
   - `GET /calib/report?name=...` — specific run
   - `GET /calib/log?lines=500` — tail the detailed log
   - `POST /calib/log/clear` — empty the log
   - `POST /calib/build-rubiks` — regenerate the Rubik's reference asset
   - All scriptable from Claude Code / batch scripts / CI without the UI.

3. **Detailed calibration log** (`logs/calibration.log`)
   - `CalibLogger` class in `_calib_diagnose.py` with timestamped events,
     per-stage durations, GPU info, image dimensions, subprocess return
     codes, stderr tails on failure, per-face expected/got/sim.
   - Viewable in-app via `Settings → Calibration → View detailed log`
     (scrollable modal, line count adjustable, clear button).

**User constraints reaffirmed**:
- 100% local ✓
- Free + commercially licensable ✓
- Backup every significant state via git tags ✓
  (`calib-before-api-logging-20260417` added this session)
- Full API controllability ✓

**Backup tags so far for this calibration work**:
  - `calib-ui-backup-20260417` (before revert to 7c9225a)
  - `before-revert-to-7c9225a-20260417`
  - `calib-before-api-logging-20260417` (this entry's snapshot)

---

## 2026-04-17 — Calibration system + honest scoring + revert to standard flow

**Built**: full calibration infrastructure in FabMesh.

1. **Ground truth** (`images/_calibration/ref_0_perfect_axes/`): 6 synthetic
   orthographic axis renders of a textured cube using the 6 user-painted
   face PNGs. Each letter F/B/R/L/T/D reads correctly.
2. **`scripts/calibrate.py`**: runs SF3D + `texture_project.py` on the
   calibration cube image, renders 6 axis views of the result, classifies
   each against ground truth, writes an HTML report + score.json.
3. **Cross-validated classifier**: initial color-mean classifier gave
   false OKs (reported 3/6 when visual inspection said 1/6). Replaced
   with **two independent methods** that must agree:
   - Template matching (pixel-Euclidean distance vs the 6 GT renders)
   - Palette histogram (counts pixels matching each face's signature palette)
   If they disagree, the face is marked `?F/T` in the report — no false OK.
4. **FabMesh UI** — `Settings → Calibration`:
   - Run calibration button (full-width, row 1)
   - Open last report + Gallery (side-by-side, row 2)
   - Both now render **in-app modals** (not shell-opened HTML).
   - 6 axis thumbnails with green/red outline per face.
5. **Sweep script** (`_calib_sweep.py`): tests all 8
   `FABMESH_TEXPROJ_FLIP_{AZIM,ELEV,CAMPOS_AZIM}` combinations plus
   rotation-offset 0/90/180/270. **Max score achieved: 3/6 with the
   naive classifier, 1/6 with the honest one**.
6. **Visual diagnosis**: the raw SF3D output (without multi-view
   projection) ALSO scores 1/6 — the faces show "F" backwards on -Z,
   right side gets the front stripes, etc. So the core issue is
   upstream of the projection script.

**Conclusion**: fighting convention flags in `texture_project.py` is the
wrong battle. The symptom is visible in the raw SF3D mesh already.
Two hypotheses to test separately later:
  (a) the calibration cube itself is pathological input for SF3D (Objaverse-
      trained, expects photorealistic multi-view; a stylized cube with
      flat colors produces unreliable meshing/UV).
  (b) an unknown axis-flip between SF3D's output frame and the
      projection script's camera frame is compounding.

**Revert decision (user 2026-04-17)**: "temporairement on revient au flux
de base, avec juste les outils dans leur configuration normale". Actions:
  - Emptied `images/_calibration/ref_0_multiview/` (no more auto-copy
    of synthetic perfect views into the pipeline).
  - `calibrate.py` now errors out if the active multi-view dir is empty
    instead of silently copying the synthetic views.
  - UI Calibration panel kept (diagnostic tool).
  - Backup tag: `calib-ui-backup-20260417`.

Standard flow is restored: normal image → normal Zero123++ multi-view →
normal SF3D → normal `texture_project.py`. No forced perfect views.

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

### 2026-04-16 evening — Calibration suite (color-coded cube) + convention sweep

Built a deterministic 3D calibration target so pipeline bugs become
immediately diagnosable visually. User wanted non-AI known-good input
so hallucinations don't hide orientation/projection bugs.

**Asset** (`scripts/_build_calibration_suite.py` → `images/_calibration/`
+ `meshes/_calibration_groundtruth.glb`):
 - 1x1x1 cube, each face: distinct solid colour + huge centered letter
   + faint pattern + corner labels ({F,B,R,L,T,D}-{TL,TR,BL,BR}).
   front=red F, back=cyan B, right=blue R, left=green L, top=yellow T,
   bottom=magenta D.
 - First draft used 12 face triangles → texture_project.py rejected
   100% of them (edge_size > 20% of atlas). Subdivided 4 levels →
   3072 faces; `_rebuild_cube_uvs()` re-projects every sub-vertex onto
   its owner cube face and emits an atlas UV pointing at the right cell.
 - Renders now orthographic (was perspective; was leaking 5 faces at
   once in the front view). Atlas face textures pre-flipped H so the
   letter reads the right way on the cube seen from outside.

**Analyzer** (`C:/tmp/_analyze_calib.py`): renders the output mesh
from each of the 6 cardinal axis directions orthographically, samples
the central 40% average colour, classifies as F/B/R/L/T/D and reports
a pass/fail per axis.

**Observed today on real FabMesh calibration runs**:
 - `_calibration_sf3d_1776359098043.glb`:
     Front = F red OK. Back = F-red (BAD, should be B cyan).
     Right = F-red spillover. Left = L green OK.
     Top = L green (should be T yellow). Bot = R blue (should be D magenta).
   Pattern: front projection floods multiple axes; back/top/bottom
   are getting mismatched views.

**Convention sweep tool** (`C:/tmp/_sweep_texproj.py`): loads the
ground-truth cube pre-rotated into SF3D's frame (Rx(-90)·Ry(+90)·invert),
runs `texture_project.py --multiview` with 8 different sign
combinations of azim/elev/campos_azim env flags, and measures axis
correctness. Result: all 8 variants score ≤ 1/6 — not because the
sweep is wrong, but because the synthetic multi-views I render in
the calibration script don't match Zero123++'s actual per-view
camera convention. So this sweep can't pick a convention on its own;
must be driven from REAL Zero123++ output for the answer to be real.

**Env flags added to texture_project.py** (non-default, used only
when set):
 - `FABMESH_TEXPROJ_FLIP_AZIM`
 - `FABMESH_TEXPROJ_FLIP_ELEV`
 - `FABMESH_TEXPROJ_FLIP_CAMPOS_AZIM`

**Next step**: drive a fresh FabMesh generation through the calibration
project (Zero123++ → SF3D → projection → refine) via the MCP bridge so
the user sees the progress popup. Run `_analyze_calib.py` on the result
to see which of the 6 axes still carry wrong colours, then iterate on
rotation_offset and projection conventions with ground truth in hand
instead of guessing from orc textures.

Commits today:
  - `ce1e12b` log update
  - `0cce0ef` view select shows current view name
  - `776e3bb` subdivided cube + env sign flags in texture_project

---

### 2026-04-16 — Day-long pipeline overhaul (19 commits)

Focused day: making multi-views actually serve fidelity to the reference
image + fixing the constant "the mesh face is 180° wrong" bug + UX around
multi-view bar.

**Storage architecture — per image version** (was previously shared per project):
- `35634a4` multi-views live in `images/<project>/<image_stem>_multiview/`.
  3D bridge only LOOKS UP, never generates. Falls back to pure SF3D if missing.
- `4404fed` + `c1f4bc8` auto-inherit on new image version: silhouette hash
  matches → copy; no match → async Zero123++. Wired on all 6 handlers that
  produce new versions (including the second `remove-background` I'd missed).
- `80202ad` re-hydrate mv-bar from disk when `reloadCurrentProject` clears
  the in-memory cache. New `check-multiview-dir` IPC.
- `09f94c7` mv button now registers a proper pushJob (Running task dialog).
- `4ea78f7` openProject re-checks mv-bar after stages settle.
- `34baeba` version-thumb click re-checks mv-bar.
- `732667c` selected ANGLE (front/fr/right/br/bl/left/fl) persists across
  version switches: if user has 90° pinned on v0, switching to v1 keeps 90°
  and swaps preview to v1's view_1.png.

**Copy prompt button** (`0d72183`): under image preview, reads
state.currentProject.prompt, copies to clipboard.

**T-pose enforcement** (addresses Zero123++ failure on dynamic poses):
- `200e389` text-prompt tuning. **Insufficient.**
- `c2cbfd8` real fix: T-pose keyword → DreamShaper XL Lightning
  (OpenRAIL++-M) + xinsir ControlNet OpenPose SDXL (Apache 2.0) + pre-
  rendered skeleton PNG (`scripts/assets/tpose_skeleton.py`). Geometric
  guarantee.
- `e989d68` fixed template conflict: `character` said both "T-pose" AND
  "isometric 3/4 view" — removed 3/4 keyword, added strict symmetry.

**Zero123++ quality** (`6c316e3`): steps 100→150, cfg 4.0→5.5, seed pinned.
+15 s, fewer smudges, tighter color adherence.

**Identity harmonize via IPAdapter**:
- `1837551` opt-in pass (on by default): each view → SDXL img2img
  strength 0.3 + IPAdapter conditioned on ref image. First attempt with
  plus variant crashed "mat1 x mat2 (514×1664 and 1280×1280)".
- `bd33c6e` switched to `ip-adapter_sdxl_vit-h` BASE variant, explicit
  CLIPVisionModelWithProjection from h94/IP-Adapter/models/image_encoder.
  Raises if ALL views fail instead of silently shipping unharmonized
  cartoon output. **Do-not-retry: ip-adapter-PLUS on RealVisXL+diffusers
  current stack crashes on 0-element reshape in attention processor even
  with correct encoder.**

**Auto-align facing detection** (series of fixes for "mesh backwards"):
- `d581779` bug: chest_z near zero (+0.005) caused spurious 180° flip
  decisions. Added head_z vote as tie-breaker; weighted sum of chest+head.
- `8f6e264` sign of comparison was inverted (empirical verification on
  'garcon' mesh: chest_z=-0.004 head_z=-0.017 was showing BACKWARDS, so
  flip should trigger on NEGATIVE sum, not positive).

**Observed user pain points still open** (not resolved today):
- Zero123++ still hallucinates back/sides of stylized characters
  (orc_child dup face, orc_woman beige legs, garcon bras repliés vers
  tête instead of horizontal on multi-views). Limit is fundamental to
  Zero123++ v1.2 training data — Objaverse lacks T-pose chars.
- MV-Adapter (Apache 2.0, commercial-safe) identified as real
  replacement candidate but not yet integrated (~1h30 dev deferred).

---

### 2026-04-15 — Progress bar: completing the earlier fix (commit pending)

**User reported**: after commits `c3acc3e` and `c0d0012`, the bar STILL
climbs to ~90% in the first few seconds and then sits there for the
long SDXL refine phase. The `LOCAL_SF3D_PROGRESS: <overall>` single-
source-of-truth values from the bridge were emitted correctly — but
something else in the stream kept snapping the bar to 90%.

**Root cause** (two overlapping bugs, both in the previous fix):

1. `scripts/multiview_gen.py` emits progress via TWO channels:
   - `_subpct(...)` → `FABMESH_SUBPCT: <sub%>` — the bridge remaps
     these correctly into overall via `fabmesh_progress.sub()`.
   - `slog.progress(...)` → `MULTIVIEW_PROGRESS: <sub%>` — via
     `fabmesh_log.Logger.progress()`. These lines were NEVER remapped.
   The renderer's scraper regex was `/_PROGRESS:\s*(\d{1,3})/`
   (`src/renderer/index2.js:6219`). That regex matches `MULTIVIEW_PROGRESS:`
   just as happily as `LOCAL_SF3D_PROGRESS:`. Multiview emits
   `MULTIVIEW_PROGRESS: 90 cleanup` and `MULTIVIEW_PROGRESS: 100 done`.
   The renderer interpreted 90 and 100 as OVERALL percentages and
   slammed the bar to 99%, masking the rest of the pipeline.

2. `_stream_subprocess` in `local_sf3d_bridge.py` forwarded every
   sub-script stdout line verbatim prefixed with `LOCAL_SF3D: `. Even
   after tightening the renderer regex, old-renderer builds or third-
   party log scrapers would still see the raw `MULTIVIEW_PROGRESS:`
   substring inside those forwarded lines.

**Fix**:
- `src/renderer/index2.js:6217-6282` — regex tightened to
  `/\bLOCAL_[A-Z0-9_]+_PROGRESS:\s*(\d{1,3})/` so ONLY bridge-level
  overall emitters (LOCAL_SF3D_PROGRESS, LOCAL_TRIPOSR_PROGRESS,
  LOCAL_TRIPOSG_PROGRESS, LOCAL_MESHY_PROGRESS, LOCAL_IMG_PROGRESS,
  LOCAL_JUGG_PROGRESS, LOCAL_REALVIS_PROGRESS) drive the bar.
  Also: parse msg line-by-line and SKIP any line starting with the
  bridge's forward prefix `LOCAL_SF3D: ` — those lines contain
  sub-phase percentages that look like overall percentages.
- `scripts/local_sf3d_bridge.py:53-64, 75` — `_neutralize()` helper
  rewrites `_PROGRESS:` → `_SUBPROG:` in forwarded sub-script lines
  so legacy scrapers can't mistake a sub-pct for overall.

**Verification** — replay of `logs/fabmesh.log` confirms the renderer
regex no longer matches `MULTIVIEW_PROGRESS: 90`, `MULTIVIEW_PROGRESS: 100`,
`TEXTURE_PROGRESS: ...`, only `LOCAL_SF3D_PROGRESS: <overall>` produced
by `_emit_progress()` or by `_stream_subprocess`'s remap. PHASE_BUDGET
cumulative: 1 → 3 → 28 → 36 → 41 → 45 → 60 → 99, monotonic.

**Not changed**: pipeline behaviour, mesh/texture quality, timings.

### 2026-04-15 — Progress bar: single source of truth (commit `c3acc3e`)

**User pain point**: the 3D generation progress bar jumped from ~20% to
97% within a few seconds and then froze at 97% for minutes before
finishing. Felt broken. User asked that the bar reflect TRUE overall
progress.

**Root cause (two bugs compounding)**:
1. The bridge's hardcoded markers (5/10/12/25/50/90/97/100) didn't match
   wall-clock time. On a typical run: SF3D inference is ~45% of real
   work — not 90%. Multi-view + UV projection + SDXL refine are the
   other 55%, all happening between the hardcoded 90 and 100.
2. Sub-scripts (`multiview_gen.py`, `texture_project.py`,
   `texture_refine.py`) were invoked with `capture_output=True`, so
   their stdout was buffered until they exited. Intermediate progress
   lines (per-view upscale, per-tile SDXL) never reached main.js during
   execution — the bar had nothing to report and the timer saturated.

**Fix**:
- New `scripts/fabmesh_progress.py` — 50-line module holding
  `PHASE_BUDGET` with wall-clock weights (`multiview=25`, `sf3d_load=8`,
  `sf3d_infer=5`, `tex_project=15`, `refine=40`, `finalize=4`, etc.).
  `start(phase)` / `end(phase)` / `sub(phase, 0..100)` derive
  overall percentages. Editing one weight rebalances every emitter —
  single source of truth as requested.
- Bridge: `_emit_progress(phase)` replaces the hardcoded `LOCAL_SF3D_PROGRESS:`
  lines. `_stream_subprocess()` replaces `subprocess.run(capture_output=True)`
  for the four long sub-script calls: forwards stdout line-by-line AND
  remaps `FABMESH_SUBPCT: <0-100>` markers into the overall slice via
  `fprog.sub()`, re-emitting them as `LOCAL_SF3D_PROGRESS:`.
- Sub-scripts emit `FABMESH_SUBPCT:` at meaningful checkpoints:
  per-view upscale and per-view style-harmonize (multiview_gen), every
  ~5% of the face-rasterization loop (texture_project), per-tile SDXL
  refine completion (texture_refine). Existing `MULTIVIEW_PROGRESS:`
  and `slog.progress(...)` lines kept intact so other consumers
  (multiview standalone IPC, fabmesh_log) still work.
- Renderer (`index2.js`): ignores raw `FABMESH_SUBPCT` messages (those
  are sub-pct, not overall pct — the bridge already remapped them);
  stops the 5→90% smooth-climb timer as soon as the bridge reports its
  first real event. The timer's cap at 90% was masking the entire
  refine phase (60–99%) — that was the user-visible "stall at 97".

**Verification** — dry-run enumeration of a typical pipeline produced:
1 → 3 → 28 → 36 → 41 → 45 → 59 → 62 → 73 → 86 → 98 → 99 → 100,
monotonic and roughly proportional to real seconds on an RTX 5080.
SDXL refine (longest phase) now owns overall 60-99, so per-tile ticks
(~13s each for 9 tiles) move the bar ~4% each — visible motion.

**Not changed**: pipeline behaviour, timing, quality. Pure plumbing.

### 2026-04-15 — Project-level multi-view cache (commit `bb87f12`)

**User pain point**: "le multiview doit être dispo à toutes les
versions de l'image principale". Every time the user did rembg/crop/
recolor on the reference image, the mesh generation had to rerun
Zero123++ (~45s) even though the subject shape was identical.

**Cache key**: silhouette hash. The preprocessed image's alpha channel
(or grayscale fallback) is downscaled to 64×64, binarized, and sha1'd.
Retouches that preserve the silhouette → same hash → cache hit.

**Layout**:
```
images/<project>/.multiview_cache/<16-hex-hash>/
    input.png
    view_0.png .. view_5.png
```

**Flow** (in `local_sf3d_bridge.py`):
1. Compute silhouette hash before spawning multiview.
2. If all 6 views + input exist in cache → copy them into the per-mesh
   `.multiview` dir and skip Zero123++ entirely (**saves ~45s**).
3. On miss, run Zero123++ normally and write the result into the cache
   on success, so the next retouched variant will hit.
4. Any error falls through silently — pipeline still works.

Transparent, no UI change. Works with the style-harmonize pass too
(harmonized views get cached, not raw Zero123++ views).

---

### 2026-04-15 — Style-harmonize multi-views via SDXL img2img (commit `7c9225a`) — Solution 1

**User observation**: after regenerating the pipeline end-to-end on
test_e2e, the input image was photorealistic but the 6 Zero123++
multi-views came out with a cartoon/dessin look — atlas ends up with
incoherent style (photo front, cartoon back/sides).

**Why**: Zero123++ v1.2 was trained on Objaverse synthetic renders;
it imposes that style on whatever you feed it. Known limitation.

**3 options considered**:
 1. SDXL img2img style-transfer pass after rembg (light, commercial-safe)
 2. IPAdapter-guided multi-view gen (heavy refactor, also commercial-safe)
 3. Lower Zero123++ guidance_scale (5-min hack, inconsistent results)

**User chose 1 first; 2 as fallback if not enough.**

**Implementation** (`multiview_gen.py`):
- After the rembg bg-removal pass, each view is sent to the always-on
  SDXL server at `/img2img` with strength=0.35.
- Prompt = `<subject>, photorealistic, sharp focus, natural materials,
  consistent with reference photo, 8k detail`.
- Subject prompt comes from `prompts.json` via env var
  `FABMESH_REFINE_PROMPT` set by the bridge before spawning multiview.
- Alpha channel from rembg is preserved (reapplied after img2img so
  projection still knows which pixels are subject vs background).
- Falls through silently if the SDXL server is not up (no hard
  dependency, pipeline still produces raw Zero123++ views as before).

**Cost**: +30s (~5s × 6 views). Still within the 5 min budget.

**Ready to test**: user regenerates test_e2e end-to-end.

---

### 2026-04-15 — Bilateral-symmetry auto-align (commit `2eea5ea`) — drops the ±7° drift

**Root cause of the residual "décalage"**: the chest-bulge heuristic
was ~7° off optimal on real meshes because asymmetric surface features
(tilted head, diagonal sash, single pauldron, etc.) bias the mean
vertex-from-center direction.

**Validation on the pre-rotation test_e2e mesh**:
- chest-bulge (old): 176.86°
- bilateral symmetry (new): 169.75°
- Δ = 7.1° — exactly the order of magnitude the user saw as "pas loin
  mais il y a encore un décalage".

**New algorithm** (in `local_sf3d_bridge.py`):
1. Downsample mesh to 4000 vertices.
2. Coarse Y-rotation scan (2° steps, 0..180°) + fine (0.25° steps,
   ±3° around coarse best). Score = histogram-overlap between the
   rotated cloud and its x→-x mirror in a 64×16×64 XYZ grid.
3. Resolve front/back (180° ambiguity of mirror plane) via chest-z
   direction after rotation.
4. Apply only if >0.5° from identity.

Falls through to try/except with full traceback if any edge case hits,
so silent skip becomes impossible.

**Ready to test**: user to run a fresh generation on test_e2e. Expected:
face + multi-view back/sides precisely aligned (no ±2-7° residual).

---

### 2026-04-15 — Rotation-offset propagated to multi-view projection (commit `1965889`)

Follow-up to the auto-align fix: the rotation of the mesh (169.5° for
the apilive test) left the 6 Zero123++ views at their original
pre-rotation azimuths, so they bled onto the wrong parts of the rotated
mesh — visible as a slightly soft face + head and imperfectly aligned
side details.

**Fix** — `texture_project.py` now accepts `--rotation-offset DEG`; when
passed, every MULTIVIEW_VIEWS azimuth is shifted by that angle (modulo
360) so views land on the same mesh regions they depict. The bridge
(`local_sf3d_bridge.py`) captures `auto_align_rot_deg` at align time
and threads it through every `texture_project.py` invocation
(refine/atlas/atlas_refine/augment/vc paths).

**User verdict on the resulting mesh** (2026-04-15 evening): "on est
pas loin mais il y a encore un décalage". Face well-positioned overall,
shoulders/pectorals/pagne all correct, but face texture still slightly
off + buckle/sash positions drift a couple degrees.

**Root cause**: auto-align uses "average chest-bulge direction" which
has ±3–5° noise. The rotation offset compensates the alignment applied,
but if the alignment itself lands 2° off optimal, the multi-views get
offset by the same 2°. They don't hit the wrong side of the mesh any
more, but the ±2° residual drift is still visible.

**Next step** (in progress): replace the chest-bulge heuristic with a
**bilateral-symmetry-maximizing** rotation search. Humanoid subjects
(orcs, humans, animals) have a clean left/right mirror plane. Finding
the Y rotation that maximizes mesh-to-mirrored-mesh overlap lands
within ~0.5° of optimal, eliminating the drift. Scheduled for next
commit.

---

### 2026-04-15 — Auto-align WORKS (user visual confirmation)

Generated test_e2e_sf3d_apilive_1776274212.glb via direct CLI bridge call:
```
LOCAL_SF3D: auto-aligned mesh by 169.5° around Y (face was pointing [-0.182, 0.0, 0.983])
```
The orc's face was pointing ~dead-Z (away from glTF viewer). Rotation
brings it to -Z as expected. User confirmed visually: "l'orc est
parfaitement de face" in the FabMesh viewer — sash, buckle, armor on
thigh all visible in the right position.

Side note: CLI bridge runs bypass FabMesh's `mcp-job-start` event, so
no "Running task" dialog appears when bridged directly. Functionally
fine, just UX-different.

**Still to polish** (user mentioned): the face/head texture looks a
bit soft compared to the reference. Candidate next step: run the
ControlNet Tile refine with IPAdapter fed from the reference image +
multi-views, so SDXL has the actual orc identity to match when
injecting detail. Distinct task from fidelity (shape) which is now
solved.

---

### 2026-04-15 — Mesh auto-align to -Z (root cause of "texture inverted" on test_e2e)

**User symptom**: newly generated test_e2e mesh appeared as if the
texture was inverted front/back, and the back looked all black in the
FabMesh viewer.

**Investigation** (via `_check_orientation2.py` Python renderer, 4
cardinal views):
- GLB geometry is intact (same 19567 verts / 24576 faces as earlier
  working generations).
- `_proj_debug.png` generated at projection time shows the orc perfectly
  from the front — so `texture_project.py` IS projecting the correct
  view onto the correct part of the mesh.
- BUT the chest bulge (in-plane XZ component of chest-outward average)
  points at `(-0.606, 0, +0.795)` — face direction ~53° off any axis.
- FabMesh Three.js viewer spawns camera at `(+X,+Y,+Z)` looking at the
  origin. With the orc facing 53° in the (-X, +Z) quadrant, the viewer
  ends up photographing the orc's left side, not its front.
- Hence the impression of "inverted / back black" — the front IS painted,
  just not visible from the viewer's default angle.

**Fix** (commit `7f36fc3`): added an auto-align step in
`local_sf3d_bridge.py` right before `mesh.export`. Slices the
mid-body (30-80% height), averages chest-outward direction in the XZ
plane, and rotates the entire mesh around Y so that direction becomes
-Z (glTF "forward"). Skips if already within 3° to avoid numerical
drift. Applies to every SF3D generation, so the viewer + projection +
rig all see a canonically oriented mesh.

**Test plan**: generate a new test_e2e mesh → confirm the thumbnail
shows the orc from the front (or a 3/4-front), not from the side.

---

### 2026-04-15 — MAJOR COURSE CORRECTION — going back to fidelity-first

**User restated the #1 goal** (not a new requirement, the *original*
demand): *"je veux un mesh 3D qui soit le plus proche possible de
l'image initiale (shape et texture) → c'est la demande de base"*.

**Recognition**: I've been chasing SDXL refine quality for hours, but
every refine (v1 + v2 of CN Tile) was adding/changing pixels that have
**no relationship to the reference image**. The refine was never going
to fix fidelity — it was a purely stylistic layer on top.

**Real diagnosis — multi-views are silently not generating**:
- `logs/_multiview_*` latest folder is from 2026-04-14 23:01 (project
  orc_blue_crown). No multiview folder exists for today's test_e2e
  generation (12:12–12:16).
- `grep multiview logs/fabmesh.log` around 10:12–10:16 returns zero
  matches. The SF3D bridge's multiview step was skipped.
- SF3D received only the single reference image → no back/sides info
  → the atlas can only have front-biased texturing, with back/sides
  fabricated from SF3D's prior. This is **the real reason** the base
  mesh texture is weak, and no amount of refine can add back info the
  mesh never had in the first place.

**Immediate next steps** (pivoting away from CN Tile experiments):
1. Reproduce a mesh generation and capture EVERY log line to find
   where multiview is being skipped. `local_sf3d_bridge.py` has a
   try/except at line ~108 that silently sets `_multiview_dir = None`
   on failure — likely the culprit.
2. Once multiview is confirmed running again: verify the 6 views go
   through RealESRGAN upscale + rembg + feed into SF3D's atlas bake.
3. Then A/B the mesh with/without multiviews on the same reference.
4. Only after fidelity is verified: consider IPAdapter-guided refine
   that takes the reference image AND the 6 multiviews as conditions,
   so any refine stays aligned with the actual orc.

**FIX 1 applied** (commit `f61ecf0`): added `'refine'` to
`_modes_using_mv` in `local_sf3d_bridge.py`. Multi-views will now
generate again in the default refine path.

**FIX 2 applied** (commit `2f63b3f`): even with fix 1, the refine
branch was *ignoring* the generated multi-views. Refactored the refine
path into two steps:
 1. `texture_project.py --multiview` bakes the 6 Zero123++ views onto
    the SF3D atlas (same as 'atlas' mode)
 2. `texture_refine.py` then SDXL-polishes the *projected* atlas.
If projection fails, we gracefully keep the vanilla SF3D atlas.

**Test plan** (next run from user): generate a fresh mesh on the orc
reference → confirm `_multiview_*` folder appears → compare the
resulting mesh's back/sides with the reference image. Should now show
real multi-view data instead of SF3D's single-view prior.

**Hyper-SDXL 8-step LoRA work was started** (sdxl_server.py +
texture_refine.py branches) but **stashed** (`wip_hyper_sdxl_pause`) —
optimizing refine speed is useless while the base mesh isn't faithful
to the reference.

**Added to memory** (`project_core_requirement.md`): fidelity to
reference image (shape + texture) is FabMesh's #1 goal, everything
else is secondary.

---

### 2026-04-15 — ControlNet Tile SDXL atlas refine — FIRST RUN DONE (pending user visual verdict)

**Run 1 (failed at tile 1)**: auto-derived `steps=42` at strength 0.6,
each tile took ~250s → client timeout 240s. Fixed by pinning
`steps=25` for CN Tile + bumping HTTP timeout 240→600s (commit
`39dfd02`).

**Run 2 (success)**: `strength=0.6 cn_scale=0.7 steps=25 target=2048`
on `test_e2e_sf3d_1776247937665.glb`. Output:
`test_e2e_sf3d_1776247937665_cntile.glb` (same byte size — in-place
atlas swap kept GLB structure intact).
- Tile times: 177+72+65+58+71+57+52+23+17 = **596s total ≈ 10 min**.
  (1st tile includes 1-time xinsir/controlnet-tile-sdxl-1.0 download
  + load into VRAM ~2.5 GB. Subsequent tiles ~60s each.)
- VRAM peak ~15.3/15.9 GB (96%) — at the edge but no OOM.

**Speedup research (agents, 2026-04-15)**:
- **Hyper-SDXL 8-step CFG-preserved LoRA** (ByteDance, openrail++ with
  $1M cap): can drop to 8 steps × CFG 6 × strength 0.55 → ~25s/tile
  (-65%). Micro-detail softens slightly. Yellow-light for ship.
- **torch.compile**: theoretical +20% but recompile triggered on every
  pipe unload/reload (our server juggles 3 SDXL pipes on 16 GB), so
  net gain is negative. **Red-light — skip.**
- **Atlas 1024 default + RealESRGAN x2** (matches Meshy free tier):
  1 tile × 60s = **~70s total (-88%)**, better global coherence.
  **Green-light — biggest win, should be the default mode.**
- **Preset tuning**: strength=0.42 steps=18 cn_scale=0.75 CFG=5.5
  DPM++ 2M Karras — ~50s/tile (-30%), more visible micro-detail
  (lower strength lets CN Tile inject high-freq instead of being
  overridden). **Green-light — try before going LoRA.**

**Next decision** (pending user visual judgement on the 2048/9-tile
output): if quality is visibly better than vanilla refine, ship the
new default as 1024 single-tile + RealESRGAN x2 + preset
`strength=0.42 steps=18 cn_scale=0.75`. Add a "Max Quality" button
for 2048/9-tile when needed.

---

### 2026-04-15 — ControlNet Tile SDXL atlas refine — IN TEST

**Motivation**: user wants Meshy-quality texture; TRELLIS.2 is legally
unshippable (nvdiffrast NC); Hunyuan3D EU-excluded. Only commercial-safe
lever left is to push the existing SDXL atlas_refine harder.

**Problem with current refine** (`strength=0.25`, plain img2img):
- Too timid to add visible detail
- Bump strength above 0.3 → SDXL hallucinates and breaks UV layout
- No 3D-structure awareness — it repaints tile-blind

**Fix**: plug xinsir/controlnet-tile-sdxl-1.0 (Apache 2.0, commercial-safe)
into the refine pipeline. Tile ControlNet forces SDXL to respect the
source image structure while still adding micro-detail. This lets us
push `strength` to 0.5–0.75 without destroying the atlas layout — same
technique Meshy/Scenario use.

**Also fixed a stale bug**: `texture_refine.py` was pointing at
`http://127.0.0.1:7777/health` but the SDXL server binds 5555 and
exposes `/ping`. So `_server_alive()` always returned False → every
refine went through the slow in-process fallback. Corrected to 5555
+ /ping.

**New code** (commit `c456ec2`):
- `sdxl_server.py`: lazy-load `StableDiffusionXLControlNetImg2ImgPipeline`
  with xinsir/controlnet-tile-sdxl-1.0 + RealVisXL V4.0. Unload-with-others
  rule preserved to stay under 16 GB. Endpoint `/img2img_tile` accepts
  `strength`, `controlnet_scale`, `guidance_scale`, `steps`.
- `texture_refine.py`: flags `--controlnet_tile --cn_scale 0.7`,
  threaded through the whole call chain. Default strength 0.25 kept
  for back-compat; ControlNet test will use 0.6.

**Test plan** (pending): run on `test_e2e_sf3d_1776207309698.glb`
with `--controlnet_tile --strength 0.6 --cn_scale 0.7 --target 2048`
→ compare side-by-side with previous refine (strength 0.25, no CN).
User will judge visually.

---

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

**Discovery**: CUDA Toolkit 12.8 is **already installed** at
`/usr/local/cuda-12.8/`. The `nvcc` symlink at `/usr/bin/nvcc`
just points to the older 12.0. Use the explicit path.

Retry with `CUDA_HOME=/usr/local/cuda-12.8`,
`PATH=/usr/local/cuda-12.8/bin:$PATH`, and
`TORCH_CUDA_ARCH_LIST=12.0` (Blackwell sm_120, RTX 5080 native).
This is option B without a download (toolkit was already there).

→ First retry FAILED — `wsl -- bash -c "..."` from Windows
explodes when env vars contain Windows PATH segments with spaces
(`Program Files`). The shell parser hits `(x86)` and dies.

→ Workaround: package the build commands into a `.sh` script
(`c:/tmp/_build_nvdiff.sh`), copy into WSL, run there. PATH inside
the script is set explicitly to Linux-only dirs.

Build now running with clean env. Compile time ~3-5 min for nvdiffrast.

→ **SUCCESS** 🎉 — `nvdiffrast-0.4.0-cp312-cp312-linux_x86_64.whl`
built and installed (15 MB wheel, sm_120 native).

**Full stack smoke test** passed:
- torch 2.8.0+cu128 ✅
- flex_gemm (siraxe wheel) ✅
- cumesh (siraxe wheel) ✅
- o_voxel (siraxe wheel) ✅
- nvdiffrast 0.4.0 (locally rebuilt for sm_120) ✅
- `Trellis2TexturingPipeline` import ✅

**Working recipe** (for reproducibility and packaging):
1. WSL2 Ubuntu with venv python 3.12
2. CUDA Toolkit 12.8 at `/usr/local/cuda-12.8`
3. `pip install torch==2.8.0 torchvision==0.23.0 --index-url cu128`
4. `pip install --no-deps` the 3 siraxe community wheels
   (flex_gemm, cumesh, o_voxel from HF)
5. `CUDA_HOME=/usr/local/cuda-12.8 PATH=/usr/local/cuda-12.8/bin:$PATH
    TORCH_CUDA_ARCH_LIST='12.0' pip install --no-build-isolation
    --no-deps git+https://github.com/NVlabs/nvdiffrast.git`

Next: `local_trellis2_bridge.py` on orc image, inspect quality.

**First real test launched** (2026-04-15 ~11:30): `Trellis2TexturingPipeline`
on orc mesh + no-bg image.

→ **FAILED** at pipeline load (before inference!):
```
OSError: You are trying to access a gated repo.
Cannot access gated repo briaai/RMBG-2.0
403 Client Error.
```

The texturing pipeline instantiates a `BiRefNet` rembg module on
from_pretrained (trellis2/pipelines/rembg/BiRefNet.py:10), which
tries to download `briaai/RMBG-2.0` weights — a **gated** HF repo.

**Licence caveat**: `briaai/RMBG-2.0` is under a research license
(not commercial-free). Even if we got access, shipping FabMesh with
RMBG-2.0 would violate our "commercial + EU-safe" constraint. Same
as IP-Adapter-FaceID (research-only, we excluded it earlier).

**Options**:
A. Patch `trellis2_texturing.py` to skip rembg_model when the input
   image has alpha (our no-bg inputs already do).
B. Monkey-patch to inject a no-op rembg.
C. Replace BiRefNet with our existing `rembg` (u2net, Apache-2.0).

Going with **B** for the test (fastest to validate quality) then
**C** for commercial viability if quality is worth it.

**Add to "do not retry"**: TRELLIS.2 texturing depends on
`briaai/RMBG-2.0` (gated + research license). Must be patched out
for any commercial usage.

**Attempt B (2026-04-15 ~12:10)**: monkey-patch `BiRefNet.__init__`
to a no-op before pipeline load (`c:/tmp/_trellis2_monkey.sh`).
Pipeline load **SUCCEEDED** in 27 s with the 4B weights (415/415
loaded, flex_gemm + flash_attn backends active). RTX 5080 / cu128
stack is fully functional.

**Next blocker**: `trimesh.load()` returned a `Scene` because
SF3D GLB has one geometry inside a node. Fixed by calling
`trimesh.util.concatenate(list(loaded.geometry.values()))` when
`isinstance(loaded, trimesh.Scene)`. Mesh became a 15269-vert /
19048-face `Trimesh`.

**Next blocker after that**: `AttributeError: 'DINOv3ViTModel'
object has no attribute 'layer'` in
`trellis2/modules/image_feature_extractor.py:86`. Cause:
transformers ≥4.41 wraps DINOv3 as `model.model.layer` (i.e. the
encoder is at `.model`, not flattened). Older transformers the
TRELLIS.2 code was written against had `.layer` directly. Patched
the extractor in place:
```python
_layers = getattr(self.model, "layer", None) or self.model.model.layer
for i, layer_module in enumerate(_layers):
    ...
```
Backup saved as `image_feature_extractor.py.bak_preLayerFix`.

**Add to "do not retry"**: don't trust TRELLIS.2's feature
extractor to work out of the box on current transformers. The
`DinoV3FeatureExtractor.extract_features` hardcoded `self.model.
layer` which is now one level deeper.

### 2026-04-15 — TRELLIS.2 — FINAL VERDICT: ❌ ABANDONED FOR FABMESH

After getting the pipeline to actually load (monkey-patch rembg + scene
concat + DINOv3 layer patch), the next error was `no kernel image is
available for execution on the device` from flex_gemm — the siraxe
community wheels were built for sm_89 (Ada), not sm_120 (Blackwell / RTX
5080). They work for imports but kernels don't launch on our GPU.

Web research (agent a227cd7a80731f3cf, 2026-04-15) found that:
- ✅ `visualbruno/ComfyUI-Trellis2` ships **Windows sm_120 prebuilt wheels**
  in `wheels/Windows/Torch270/` — would likely run on RTX 5080 in 10 min.
- 🚫 **nvdiffrast (hard dep of TRELLIS.2) is NVIDIA Source Code
  License-NC**: §3.3 "The Work and any derivative works thereof only
  may be used or intended for use non-commercially." The so-called
  "1-way commercial" exception covers NVIDIA itself, not us.
- 🚫 ComfyUI itself is GPL-3.0 — can't be bundled in a closed paid
  app without source-opening everything.

**Conclusion**: even with infinite engineering time, TRELLIS.2 **cannot
be shipped** in FabMesh commercial release (Gumroad/itch.io/Fab). The
non-commercial nvdiffrast clause is a hard legal wall, not a technical
one. All further TRELLIS.2 install work is **wasted time** for this
project.

**Add to "do not retry"**: TRELLIS.2 for FabMesh shipping. Full stop.
Even if the wheels work tomorrow and the output is photorealistic,
we cannot legally redistribute nvdiffrast binaries in a paid `.zip`.
Only viable future use: "Bring Your Own ComfyUI" mode where the user
installs ComfyUI themselves and FabMesh talks to `localhost:8188` —
but that's a separate feature, not now.

**Path forward (user-chosen 2026-04-15)**: double down on SDXL
atlas_refine (already commercial-safe, 100% Windows native). Next
experiments: tighter tile overlap, strength ramp per region,
ControlNet depth-guided refine to preserve geometry while repainting.

---

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

### 2026-04-17 — SDXL+IPAdapter multiview tested on mannequin

Ran multiview_sdxl_gen.py on mannequin_ref.png then full pipeline.
Compare to Z123 result on same input:

Z123 BACK: hallucinated green/yellow/white patterns (random).
SDXL BACK: violet/yellow/red mix — consistent with front identity
  but doesn't invent the orange/black back-specific pattern.

Pipeline end-to-end (6-axis render of mesh):
  FRONT: impeccable (yellow/black checker, red/blue arms, green/purple legs)
  BACK: patterns propagated from front — not fully wrong, but not
    the asset's designated orange/black back either. SDXL can't
    invent info it doesn't have.
  Sides: thin profile (SF3D limitation with 3/4 input).

**Practical conclusion for users**: SDXL multiview is STRICTLY BETTER
than Z123 for stylized / synthetic inputs (no random hallucination).
For real photoreal subjects (dog, horse, orc) Z123 works well because
Objaverse covers them. Suggest offering both in UI as toggle based on
subject type.

**Not fixable without user input**: if the back should look specifically
different from front (e.g. character with logo on back), the ref image
must SHOW the back, or the user must upload a second back photo.

## 2026-04-17 (late) — CRM integration complete + mesh quality analysis

### CRM shipped + routed through UI
- Dependencies thrashed: xformers broke torch 2.11, forcibly downgraded
  back to torch 2.7.1+cu128 then uninstalled xformers entirely (CRM uses
  torch SDPA fallback instead). diffusers pinned 0.34, transformers 4.46
  (5.5 dropped FLAX_WEIGHTS_NAME). Stage 2 skipped by default
  (FABMESH_CRM_USE_STAGE2=1 to opt in) — saves ~6 GB VRAM and brings
  inference from 5 min → 25s.
- `_mvScriptForEngine()` helper in main.js routes FABMESH_MV_ENGINE
  correctly at BOTH call sites (generate-multiview IPC + mv-inherit).
- UI multi-view bar updated for CRM schema: 0° / 90° / 180° / 270° / TOP / BOT.
- texture_project.py reads views.json to discover (azim, elev) per view.
- PRIORITY_WEIGHTS_TUP uses (azim, elev) tuples to handle top/bot.
- Realtime progress via tqdm monkey-patch (DDIM steps mapped 20..65%).
- RealESRGAN x4 upscale 256→1024 on CRM output (was LANCZOS, too blurry).

### Mesh quality finding (chat_vert test, 2026-04-17 18:26)
Full pipeline on chat_vert (CRM → SF3D → texture_project → refine):
  - Multi-views CRM: EXCELLENT (front/back/TOP/BOT all cohérents avec input)
  - Mesh: 243k verts / 162k faces BUT extent Z=0.25 vs X/Y=0.9 →
    **mesh is nearly flat 2D** (SF3D failed depth on this input)
  - Atlas: VORONOI MOSAIC (known bug from 2026-04-14) — SF3D's
    micro-island UVs + EDT dilation = random green/black polygons
    instead of coherent chat silhouette

### Test A: FABMESH_UV_REPACK=1 — MAJOR IMPROVEMENT
Re-ran on same input with `FABMESH_UV_REPACK=1`:
  - verts: 243k → 10889 (cleaner, no over-subdivision)
  - extent Z: 0.25 → 0.41 (real 3D, not flat!)
  - Atlas: **chart-based layout with recognizable chat pieces**
    (head, paws, body visible) instead of voronoi noise
  - xatlas re-parametrization collapses SF3D's micro-islands into
    usable charts, which the projection can actually fill with
    coherent pixels from the 7 views.

**Action**: default FABMESH_UV_REPACK=1 for CRM pipeline. 2026-04-14
log said "disabled by default because didn't help with old mosaic
layout" — but that was with Z123 + low-res atlas. CRM + 2048 atlas
makes xatlas genuinely helpful now.

### Test B: FABMESH_PROJECT_MODE=vc — NOT A REAL VC TEST
`texture_project_vc.py` rejected the `--rotation-offset` flag that
local_sf3d_bridge unconditionally passes. Bridge silently fell back
to the standard atlas path. But the produced atlas is VERY CLEAN:
several whole views of the chat laid out as organized charts, face
recognizable. This is the NORMAL atlas path run fresh (10k verts
instead of 243k).

### REAL conclusion from A vs B comparison
The voronoi-noise issue on the original chat_vert mesh was caused
by the mesh being **over-subdivided** (243k verts, extent Z=0.25,
flat). When we re-run fresh (10k verts, extent Z=0.41, real 3D):
  - B (no repack): atlas = **multiple coherent chat views** ← WINNER
  - A (with repack): atlas still voronoi-ish (xatlas recharted but
    fills are still noisy when over-subdivided source)

**So the real fix** is NOT UV repack — it's not re-using the stale
243k-vertex mesh. Why was the original bloated? Either the
"construction stages" path or a subdivide post-step was applied.
Need to find and disable.

The current pipeline on a fresh run (like our test B) already
produces an OK atlas. Defaults stay Z123-schema + no repack.
**FABMESH_UV_REPACK=0 confirmed optimal.**

### Viewer unification — START (backups done)
Backup: `before-viewer-unify-20260417` tag + file copies in backups/.
Goal: single 3D viewer class + single 2D canvas class so nav commands
(zoom=wheel, pan=right-click, rotate=left-click on 3D) are identical
across all 7+ viewers and modals.

Current state:
  - 3D viewers (7x): all use Three.js OrbitControls with only
    enableDamping=true — ALREADY consistent behavior-wise.
  - 2D canvases (mask/clone/paint): use CanvasManager in canvas-utils.js
    with pan on middle-click / alt+click / optional right-click.
  - No unified 2D zoom convention (wheel is not bound in canvas-utils
    for some tool paths).

Next: factor a single BaseViewer3D + BaseCanvas2D class so any future
change applies everywhere at once.

## 2026-04-17 (latest) — UX session recap

### Viewer refactor 4/7 done (commits 6cfafbd, cf23fe1)
New `src/renderer/lib/Viewer3D.js` — unified class wrapping
renderer + scene + camera + OrbitControls + tick loop + lighting.
Migrated: wsThree, rigSrc, lightbox3D, rigViewer. Remaining 3
(mesh-edit, lmFs A+B) still use direct OrbitControls but with
identical `enableDamping=true` — behaviorally harmonised.
Backup: tag `before-viewer-refactor-20260417-v2` + `backups/viewer-refactor-v2/`.

Navigation is now guaranteed identical across all viewers:
  - Left-click drag = rotate (3D) / paint (2D)
  - Right-click drag = pan (3D) / erase (2D Draw Mask)
  - Middle-click drag = pan (both)
  - Wheel = zoom (both)

### Multi-view UX (commits ffd0f5a, 4964f7b, b9010b4)
  - Small viewer ↔ lightbox synced: clicking an angle in one
    updates the other (image + active-button class).
  - Lightbox has a right-side tool column (Modify, Auto Inpaint,
    Remove BG, Resolution, Face Fix, Sym. Auto, Draw Mask, Clone
    Stamp, Paint, Crop). Each routes to the workspace handler so
    tools operate on the currently-selected angle.
  - Popup after editing a multi-view: asks whether to keep the
    single-view edit or regenerate all 6 from the current front
    image (via FABMESH_MV_ENGINE dispatch).

### Draw Mask eraser (commit c1971fd + b7b0e91)
Toggle brush/eraser modes with dedicated buttons + B/E keyboard
shortcuts. Eraser uses the same radius as the paint brush (slider
drives both). Right-click drag still erases (legacy preserved).
Active tool button now has a strong pink accent background via
new `.tool-active` CSS class.

### New-project popup + UI defaults (commits 96c5e2a, 9695c77)
  - Asset Type + Style dropdowns added to the "New project" modal.
    Values propagate to the "Create new image" form so the user
    doesn't re-enter them.
  - Count default 4 → 1 (users rarely want 4 variants).
  - "Construction stages" checkbox hidden for character & creature
    (3-stage progressive build doesn't apply to living subjects);
    visible for building/vehicle/weapon/prop/environment/custom.

### Mesh quality regression (commit 122b180)
Discovered: the chat_vert voronoi-atlas bug was NOT UV projection
but the user having selected ~200K triangles in the dropdown.
Fresh run with default (~23K) produces a clean atlas with
recognizable chat pieces. Added an orange warning under the
"Target triangles" dropdown that appears for any selection >= 50K,
explaining that SF3D's per-triangle UV packing breaks the texture
above that threshold.

### SDXL pipeline fixes (commits fd4d8ea, c7ca6ed, 045db5a)
After the torch/diffusers/xformers thrashing for CRM, several
SDXL pipelines hit "mat1 and mat2 must have the same dtype: float
!= struct c10::Half" at inference. Root cause: diffusers 0.34 on
torch 2.7.1+cu128 leaves some buffers fp32 after
`from_pretrained(torch_dtype=float16)`.

Fix applied to all affected scripts:
  - scripts/local_img2img_bridge.py
  - scripts/sdxl_server.py: load_img2img, load_inpaint, load_controlnet_tile

Pattern: after `pipe.to("cuda")`, force every sub-module:
    pipe.unet.to(torch.float16)
    pipe.vae.to(torch.float16)
    pipe.text_encoder.to(torch.float16)
    pipe.text_encoder_2.to(torch.float16)
    # + pipe.controlnet for ControlNet variants

Validated end-to-end: CLI + HTTP server both produce clean results
on chat_vert ("make eyes glow red" → red-eyed chat in 7s).

### SDXL idle-unload tightened (commit 045db5a)
SDXL server was holding ~9 GB VRAM for 5 min after a Modify,
blocking other tools. Reduced `SDXL_IDLE_TIMEOUT_MS` 300s → 90s
and polling interval 15s → 10s. Chain of 2-3 tool calls still
skips reload (< 90s between calls), but switching to a different
task releases VRAM within ~100s.

### views.json propagation on mv-inherit (commit 28802e0)
`_copyMultiviewDir` copied the 7 PNGs but NOT `views.json`.
Derived image versions (after remove-bg / inpaint / refine)
inherited multi-views without their schema file, so
texture_project fell back to Z123 angles (30/90/150/210/270/330)
on CRM-generated views (0/90/180/270/TOP/BOT) — top/bottom
projected as side views → voronoi atlas.

Fixed + heal-pass propagated views.json to 10 existing derived
dirs. BUT the chat_vert test still showed voronoi after this fix
— views.json was a real bug but NOT the root cause of the atlas.

## 2026-04-17 (late evening) — Regression analysis: oiseau (good) vs chat_vert (bad)

User question: why did oiseau_sf3d_1776440580579.glb (15:43) produce
a cleanly textured humanoid mesh, while chat_vert_sf3d_1776453637124.glb
(19:20) came out with voronoi texture + face painted on the back?

### Agent comparison (fact table)

| Axis | Oiseau (good) | Chat_vert (bad) |
|---|---|---|
| Multi-view engine | CRM 6-view ortho | CRM (SAME) |
| UV_REPACK default | 0 (OFF) | 0 (OFF — commit 33306ad landed after) |
| U-flip default | ON (legacy) | ON (SAME) |
| SF3D subdivide | not triggered | not triggered |
| Auto-align applied | no | no |
| CRM views for subject | clean, in-distribution T-pose | CRM views for stylised cat — borderline |
| Manual per-view edits | NONE | view_1_nobg_*, view_2_facefix_*, view_2_symmetrize_* |

### Most likely culprit: INPUT contamination, not code regression

Code paths were IDENTICAL between the two runs — commits 33306ad
(UV_REPACK=1) and c6bc61e (UFLIP=off) both landed AFTER chat_vert
was generated. What DIFFERS:

1. CRM trains mostly on Objaverse props. Stylised cat (rotation-
   quasi-invariant fur pattern) is borderline — CRM can swap
   front/back without the model "noticing".
2. chat_vert's ref_0_multiview/ contains manual per-view edits
   (nobg, facefix, symmetrize) that were mixed with the CRM output
   during re-generation, making the 6-view set spatially inconsistent.
3. The U-flip (active in both) operates on views where one angle
   was corrupted by those manual edits → face lands on the back.

### Recommended action (to validate)

Delete all `view_*_nobg_*`, `view_*_facefix_*`, `view_*_symmetrize_*`
from `images/chat_vert/ref_0_multiview/` then re-run generation at
HEAD. If clean, confirmed input contamination (not code regression).

### RESULT after cleanup + re-gen (2026-04-17 21:40)

Deleted 4 contaminated files + their sub-multiview dirs. Re-ran
pipeline. Output at `c:/tmp/chat_clean/mesh.glb`:
  - 10889 verts / 11944 faces
  - extent [0.91, 0.91, 0.41] (real 3D)
  - Front render: FACE visible (eyes, muzzle, ears) — orientation fix ✅
  - Back render: BACK + tail visible, no more face duplication ✅
  - Atlas: multiple cat views recognizable (was voronoi before)

**Orientation regression cured** (face-on-back was the contamination +
U-flip combo, now both resolved).

**Residual issue**: atlas still shows leopard-skin / craquelure pattern
on body even with clean views. That's the remaining SF3D micro-island
atlas packing problem. Next step: FABMESH_UV_REPACK=1 (default in HEAD
per commit 33306ad) should help further. User will test next mesh
generation which will use ALL current fixes.

### ROOT CAUSE — UV_REPACK default ON (commit 33306ad)
Investigated chat_vert mesh 1776450499355 (7K verts, correct Z
depth, views.json present, proper CRM schema). Still voronoi
atlas. The `_proj_debug.png` showed **correct** projection
(silhouette + debug dots lined up on the chat), but the `_tex.png`
atlas was voronoi.

Conclusion: texture_project rasterises correctly, but SF3D's
per-triangle micro-island UV layout + EDT dilation produces the
voronoi pattern independently of input quality.

Re-tested `FABMESH_UV_REPACK=1`:
  - chat_vert without repack: voronoi noise
  - chat_vert with repack:    **recognisable chat** (body, head,
    paws visible as coherent texture regions)

Decision: flipped default ON. 2026-04-14 had marked it "doesn't
help" — that was with Z123 input + small atlas. With CRM +
2048 atlas + correct UV projection, xatlas re-chart is a clear win.

**Users re-generating meshes now will see properly textured atlases**
by default. FABMESH_UV_REPACK=0 to revert.

### Agent diagnostic: texture leopard-skin root cause (2026-04-18 00:50)

**Root cause found**: binary `sharp_mask = weight > 0.002` at
texture_project.py:680 creates a hard cliff between:
  - sharp islands (5-16% of atlas) = correctly projected pixels
  - gaussian-blurred SF3D fallback (remaining 84-95%)

On SF3D's micro-island atlas, each triangle is 1-3 px wide.
Per-triangle rasterization writes thousands of tiny colored tiles
surrounded by blurry SF3D fallback with razor-thin borders.
The visual result IS the leopard-skin.

Evidence: `logs/fabmesh.log:1830` sharp_ratio=0.054 on chat_vert,
`logs/fabmesh.log.1:1729` sharp_ratio=0.159 on orc_blue_crown.
5-16% projected is way too low to look continuous.

**Why past fixes didn't work**:
  - xatlas repack: new chart boundaries = new mosaic boundaries, not fewer
  - 4px narrow band: too narrow, majority of atlas falls back to blurred SF3D
  - SDXL tile refine: preserves and slightly amplifies existing seams
  - hard PIXEL_PRESENT=0.002: the binary threshold IS what creates visible polygonal seams

**Fix tonight (<2h)**: replace hard sharp_mask cliff with push-pull
Gaussian pyramid fill. Instead of "sharp projected OR blurry SF3D",
fill ALL unseen pixels with locally-averaged projected color from
the multi-view accumulation. SF3D fallback discarded entirely.

Ranked alternatives for later:
  1. Per-triangle best-view baking (MRF-free) — 1.5 days
  2. Push-pull Gaussian pyramid replacing EDT — 2 days (tonight's fix)
  3. Vertex color path (texture_project_vc.py already exists) — 0.5 day

### Agent recommendations: multi-view quality improvements (2026-04-18 00:40)

Ranked top-3:
1. **Multi-seed + best-of-N on CRM stage 1** (~4h, MIT) — run 3-4 seeds,
   pick best per slot via CLIP+HSV hist ranking. Kills back hallucinations
   on stylised subjects. Raise step 50→75.
2. **Re-enable CRM stage 2 (CCM)** + use XYZ maps to re-project stage-1
   views (~6h, MIT) — CCM was designed for this, weights already on disk.
3. **SDXL img2img + ControlNet-depth + IPAdapter(reference)** (~8h,
   Apache 2.0) — shifts budget from "fighting the view" to "enforcing
   identity". Drop harmonize strength 0.65→0.35.

1-week stack: multi-seed (day 1-2) + IPAdapter-Plus on :5555 (day 3-4) +
CCM enable (day 5) + back-photo upload slot (day 6) + joint-bilateral
post-atlas filter (day 7).

Don't retry: TRELLIS.2, Hunyuan, Wonder3D, Zero123++, CRM scale>6.5.
TOP/BOTTOM won't become photoreal (mask weakly in texture_project).

### Orientation validée sur "woman" (2026-04-18 00:20)

Fresh generation post-commit 87900b3 (mesh normalize post-export +
camera +Z standard). Result on woman_sf3d_1776464211167.glb:
  - head z centroid: +0.215 (face toward +Z ✓)
  - posZ render (Three.js cam at +Z): shows the FRONT (top rose,
    skin on arms/legs — matches ref image)
  - negZ render: shows the BACK (hair, shoulders)
  - User confirmed orientation correct.

**Orientation fix definitively validated.**

Residual: atlas still fragmented (SF3D micro-island UV packing).
xatlas repack default-on helps but doesn't fully eliminate the
leopard-skin pattern on bodies. Known limitation documented above.

### Orientation saga finale (2026-04-18 00:00)

Problème: zombi mesh géométrique face à -Z (native SF3D), camera
Three.js workspace à +Z → voit le dos. Précédemment avec chat_vert
l'auto-align rotait le mesh donc face à +Z, mais avec auto-align
désactivé (d9a02eb) la face reste à -Z.

**Fix définitif (commit 87900b3)** :
  - scripts/local_sf3d_bridge.py: normalize orientation post-export
    via rotation 180° autour Y → face toujours à +Z.
    Guard: FABMESH_SF3D_NORMALIZE_ORIENT=1 (défaut).
  - src/renderer/index2.js: revert du flip camera Z (b1eddee).
    Camera revient à +Z standard Three.js.
  - auto_align_rot_deg=180 propagé à texture_project pour compenser
    les azimuths multi-view CRM.

Logique: meshes auto-normalisés à face=+Z peu importe auto-align.
Camera Three.js standard +Z voit la face. Cohérent pour tous les
futurs meshes.
