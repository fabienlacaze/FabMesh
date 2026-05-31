# Rapport comparatif Desktop vs Cloud — 15 catégories

## 1. Tableau récap global

| # | Catégorie | Verdict | Diff principale | Reco |
|---|---|---|---|---|
| 1 | Text2image front gen | ⚠️ near-identical | Branche T-pose (DreamShaper Lightning + OpenPose CN) absente cloud | port_desktop_to_cloud (T-pose only) |
| 2 | Back-view RealVis | ⚠️ near-identical | Cloud manque `remove_bg_and_center` + fallback BLIP-1 | port_desktop_to_cloud (partiel) |
| 3 | MV-Adapter (4-6 ortho) | ❌ divergent | Cloud NON déployé, fallback back-view (1 image vs 6 ortho) | port_desktop_to_cloud (Wave 2.4) |
| 4 | CRM multi-view | ❌ divergent | Cloud n'a pas CRM, fallback sheet 4-views (pas de TOP/BOTTOM) | keep_separate (CRM non portable) |
| 5 | Sheet 2x2 | ⚠️ near-identical | Cloud seed fixe 424242 + tokens character/T-pose retirés | keep_separate (génériquisation voulue) |
| 6 | T-pose strict | ⚠️ near-identical | Cloud reset IPAdapter scale=0 défensif sur txt2img | port mineur ou aucun |
| 7 | Img2img modify | ❌ divergent | strength 0.55/45 steps (desktop) vs 0.35/30 steps + identity prefix (cloud) | port_cloud_to_desktop (prefix + 0.35) |
| 8 | Mask inpaint manuel | ❌ divergent | Cloud crop-inpaint-paste + composite-back + 25 concept boosters | port_cloud_to_desktop (urgent) |
| 9 | Auto-inpaint CLIPSeg | ✅ identique | Port littéral verbatim, params identiques | aucune |
| 10 | Face fix | ❌ divergent | Desktop opère sur atlas GLB, cloud sur image 2D plate | keep_separate (couches différentes) |
| 11 | Rectify front | ⚠️ near-identical | Cloud réutilise pipe CN neutralisée (cn_scale=0) | aucune |
| 12 | Upscale | ❌ divergent | Real-ESRGAN (desktop) vs SDXL refine LANCZOS (cloud) | port_desktop_to_cloud |
| 13 | Mesh TRELLIS-2 | ⚠️ near-identical | Cloud capé à 2 views (front+back), desktop jusqu'à 6 | port_desktop_to_cloud (N-views) |
| 14 | Mesh ops | ❌ divergent | decimate 5k (desktop) vs 50k (cloud), smooth 3 vs 5 iter | port bidirectionnel paramétré |
| 15 | NSFW filter | ❌ divergent | Cloud n'a PAS de filtre pré-prompt (texte) | port_desktop_to_cloud (text gate) |

---

## 2. Diffs majeures détaillées

### Cat 1 — Text2image front gen ⚠️
- Branche T-pose desktop : `Lykon/dreamshaper-xl-lightning` + `xinsir/controlnet-openpose-sdxl-1.0` (CFG 2.0 / 8 steps / cn_scale 0.85) — totalement absente cloud.
- Trigger keywords : `t-pose`, `rts unit`, `neutral stance` → cloud ignore et part en RealVisXL libre (CFG 7.0 / 30 steps).
- NSFW classifier dual ViT + skin-ratio fallback : desktop only (cloud délègue au caller).
- Seed : desktop `time()+i`, cloud caller-supplied (plus déterministe).
- Manifest write : desktop only.

### Cat 2 — Back-view RealVis ⚠️
- `remove_bg_and_center(size=1024, target_height_frac=0.92)` : appliqué desktop, absent cloud → désalignement avec front lors du texture projection 2-views.
- Florence-2 fallback BLIP-1 : desktop only ; si Florence-2 plante cloud, `outfit_desc=''` (perd ancre vestimentaire).
- cand_seed : desktop `seed + i*1000 + k*137`, cloud `seed + k*137` (sans offset batch).
- Reste 100 % verbatim (modèles, prompts, négatif, IPA scale 0.65, CN scale 1.0).

### Cat 3 — MV-Adapter ❌
- Cloud : code path inexistant. Wave 2.4 explicitement deferred dans worker.ts lignes 3675/3721/5115.
- Desktop : `MVAdapterI2MVSDXLPipeline` + ShiftSNRScheduler shift_scale=8.0 + plucker embeddings, 6 vues ortho (azim 0/90/180/270 + ±60 elev).
- Fallback cloud sur `callModalBackView` → 1 seule image back, pas 6 ortho → TRELLIS-2 reçoit 2 vues au lieu de 6.
- Pas de RealESRGAN post-upscale x4 cloud.
- Pas de grey-bg alpha extraction cloud.

### Cat 4 — CRM ❌
- Cloud : pas de CRM. Worker implémente un sheet 4-vues SDXL (port de `multiview_sheet_gen.py`).
- Conséquence : pas de TOP/BOTTOM cloud — clé manquante pour SF3D texture projection.
- Pas de multi-seed best-of-N (HSV histogram cosine) cloud.
- Pas de rembg preprocessing cloud (assume ref pré-nettoyée).

### Cat 5 — Sheet 2x2 ⚠️
- Seed : desktop random (varie chaque run), cloud fixé à **424242** (reproductible).
- Tokens supprimés cloud : `'character'`, `'T-pose neutral stance, arms extended, full body'`.
- Subject par défaut : `'character'` (desktop) vs `'subject'` (cloud).
- Cloud route via ControlNet pipe avec `cn_scale=0.0` (équivalent math, coût mineur).
- Cloud ne retourne que la vue `back`, jette les 3 autres.

### Cat 6 — T-pose strict ⚠️
- Cloud `set_ip_adapter_scale(0.0)` + `encoder_hid_proj=None` défensif sur branche txt2img (évite bleed d'identité sur pipe partagée).
- Desktop reload pipe à chaque appel (pas de risque).
- Reste verbatim : `FRONT_PROMPT_TAIL`, `NEG`, steps 30, CFG 7.0, cn_scale 1.15, ipa 0.75, seed 42.

### Cat 7 — Img2img modify ❌
- **strength** : desktop **0.55**, cloud **0.35** → cloud beaucoup plus conservateur.
- **steps** : desktop auto ~45 à s=0.55, cloud fixe 30.
- **guidance** : desktop 6.0, cloud 7.0.
- **PRESERVE_PREFIX cloud** (verbatim) : `"same character, same outfit, same pose, same composition, preserve original subject identity, only change: "` — desktop ajoute seulement `"high quality, detailed"`.
- **PRESERVE_NEG cloud** : 11 tokens d'anti-drift identité — desktop neg vide.
- **Resize** : cloud force 1024² (écrase non-carrés), desktop préserve aspect ratio (max_dim=1024).
- **Seed** : cloud fixe 42, desktop random.

### Cat 8 — Mask inpaint manuel ❌
- **Crop-inpaint-paste cloud** : crop bbox + 30 % padding, upsample 1024², inpaint, downsample, paste back → petits objets nets ; desktop inpaint l'image entière à ≤1024 → petits masques dilués.
- **Composite-back cloud** : `src*(1-mask) + new*mask` byte-identique hors masque ; desktop laisse SDXL re-VAE toute l'image → drift subtil visage/outfit.
- **25 concept boosters cloud** : bazooka → `"M1 bazooka shoulder-fired rocket launcher..."`, sword, helmet, cyborg, wings, dragon — desktop = prompt brut.
- **Regex add/remove cloud** : parsing intentionnel ; desktop = match exact de mots-clés.
- **Blur edge** : cloud 2 px (sharper), desktop 3 px.

### Cat 10 — Face fix ❌
- Desktop opère sur **atlas UV du GLB** via pyrender + projection 3D→UV ; cloud opère sur **image 2D plate**.
- Failure handling : cloud raise `ValueError` (refund crédits) si pas de visage ; desktop fallback bbox top-25 %.
- strength : desktop 0.40, cloud 0.45.
- Mask blur : desktop 8 px (à res atlas), cloud 15 px (à res working).
- Mask shape : desktop polygones UV irréguliers ; cloud rectangle bbox étendu.

### Cat 12 — Upscale ❌
- **Algorithme** : desktop `RealESRGAN_x4plus` (CNN déterministe, BSD-3, 70 MB) ; cloud SDXL img2img refine (strength 0.15, 20 steps, CFG 5.0).
- **Prompt cloud** : `"high quality, sharp details, ultra detailed, photorealistic, crisp textures, 8k, masterpiece"` → pousse esthétique photo même sur stylisé/cartoon.
- **Plafond résolution** : cloud cap refine à 1024² puis LANCZOS retour (perte au-delà) ; desktop scale arbitraire via tiling 512 px.
- **Hallucination** : cloud peut inventer micro-détails ; desktop conservateur (matche `feedback_texture_refine_scope.md` — refine OFF véhicules).
- **GLB handling** : desktop pack/unpack baseColor seul ; cloud opère PIL only.

### Cat 13 — Mesh TRELLIS-2 ⚠️
- **Multi-view** : desktop charge `view_1..view_5` (5 extras + front), cloud capé à **2 vues** (front + back).
- **Texture** : cloud `extension_webp=True` (compact, requiert `EXT_texture_webp`) ; desktop PNG (compatible universel).
- **Remesh** : desktop passe `remesh_band=1, remesh_project=0` ; cloud utilise defaults.
- **Cascade modes** : desktop expose `1024_cascade`/`1536_cascade` ; cloud absent.
- **AI Act metadata** : desktop via `add_ai_metadata.patch_glb` ; cloud hardcode `"FabMesh 1.0.0 (AI-generated)"`.

### Cat 14 — Mesh ops ❌
- **decimate.target_faces** : desktop **5 000**, cloud **50 000** → 10× écart silhouette.
- **decimate backend** : desktop `fast_simplification` (fallback quadric), cloud quadric only.
- **smooth iterations** : desktop 3, cloud 5 → cloud sur-lisse de 67 %.
- **fix_normals** : desktop triple appel (`fix_normals` + `fix_inversion` + `fix_winding`), cloud appel unique.
- **subdivide** : desktop midpoint (préserve silhouette), cloud Loop (lisse, change silhouette).
- **center** : desktop centroïde par-mesh (drift multi-geom), cloud bbox global.
- **WebP** : cloud `extension_webp=True`, desktop perd l'encodage WebP.

### Cat 15 — NSFW ❌
- **Cloud n'a AUCUN filtre pré-prompt** : pas de `NSFW_KEYWORDS`, pas de `NSFW_COMBOS` (combos child-safety), pas de `michellejieli/NSFW_text_classifier`.
- Conséquence : prompt "schoolgirl + lingerie" passe sur cloud, est bloqué à l'entrée IPC sur desktop.
- Cloud pas de `.nsfw` sidecar (perte d'état UI).
- Cloud pas de mode `isUnrestrictedMode()` PIN-protégé.
- Image-side : ViT dual + skin-ratio fallback à parité parfaite (modèles, threshold 0.5, skin 0.35).

---

## 3. Verdict sur quelle est meilleure

| Cat | Meilleure | Raisonnement |
|---|---|---|
| 1 | Desktop (T-pose) / égalité (hard-surface) | Lock de pose CN OpenPose imbattable pour prompts character T-pose ; sinon identique. |
| 2 | Desktop | `remove_bg_and_center` rend la sortie directement pipeline-ready, cloud nécessite post-process caller. |
| 3 | Desktop (massivement) | 6 vues ortho > 1 back-view dégradée pour TRELLIS-2 mesh quality organique. |
| 4 | Desktop | TOP/BOTTOM + multi-seed best-of-N + ESRGAN donnent SF3D texture projection plus fiable. |
| 5 | Égalité | Génériquisation cloud volontaire pour hard-surface ; identique avec hints non-vides. |
| 6 | Égalité | Verbatim port, juste un reset IPA défensif côté cloud sans impact qualité. |
| 7 | Cloud pour "modify" UX, Desktop pour restyling agressif | strength 0.35 + identity prefix = micro-edits identité-stables côté cloud ; desktop trop intrusif sur petites retouches. |
| 8 | Cloud (clairement) | Crop-inpaint-paste + composite-back + concept boosters = insertion fidèle sans drift hors-mask. |
| 10 | Égalité (problèmes différents) | Chacun gagne sur son domaine (atlas vs image). |
| 11 | Égalité | Verbatim port, pipe partagée côté cloud sans impact qualité. |
| 12 | Desktop | Real-ESRGAN n'invente pas — matche la préférence user documentée (`feedback_texture_refine_scope.md`). Cloud pousse esthétique photo même sur cartoon/véhicule. |
| 13 | Desktop si user fournit 3+ vues, sinon égalité | Multi-view cap cloud limite la qualité back/side seulement quand l'utilisateur active MV-Adapter. |
| 14 | Dépend du cas | Desktop meilleur silhouette hard-surface (midpoint, 5k faces) ; cloud meilleur multi-mesh scenes (center bbox global) et préserve textures WebP. |
| 15 | Desktop | Gate avant SDXL → économise GPU + ferme combos child-safety, cloud entièrement aveugle au prompt. |

**Constat global** : le ressenti user "cloud > desktop" provient principalement de **Cat 7 (img2img modify)** et **Cat 8 (mask inpaint)** — c'est là que cloud a des features (identity prefix, crop-paste, concept boosters) que desktop n'a pas, et l'utilisateur s'en sert souvent.

---

## 4. Plan de port priorisé (cloud → desktop pour combler le ressenti)

1. **[Cat 8 Mask inpaint] Porter `_enrich_prompt` + `_CONCEPT_BOOSTERS` (25 entrées) + crop-inpaint-paste + composite-back depuis `modal_app/_mask_inpaint.py` vers l'endpoint `/mask_inpaint` de `scripts/sdxl_server.py`** — **Impact : haut**. C'est probablement la diff #1 perçue par l'user (insertion d'objets nommés type bazooka/épée beaucoup plus crédibles, zéro drift hors-mask).

2. **[Cat 7 Img2img modify] Porter PRESERVE_PREFIX + PRESERVE_NEG + default strength 0.35 depuis `modal_app/_modify.py:19-27` vers `scripts/sdxl_server.py::do_img2img` (lignes 320-365)** — **Impact : haut**. Identity-preserving prefix conditionnel à `strength<=0.6` transforme l'UX "Modify Image" desktop pour micro-edits.

3. **[Cat 14 Mesh ops] Aligner defaults dans `scripts/mesh_tools.py` : exposer preset selector `target_faces` (5k/50k) + utiliser `smooth.iterations=3` partagé ; backport `extension_webp=True` à l'export GLB** — **Impact : moyen**. Évite que cloud sur-décime ou desktop sous-décime selon les attentes user.

4. **[Cat 2 Back-view] Porter le fallback BLIP-1 manquant côté cloud + s'assurer que `remove_bg_and_center` est appliqué dans `_backview.py:generate()`** — **Impact : moyen**. Stabilise l'alignement back/front utilisé en texture projection.

5. **[Cat 13 Mesh TRELLIS-2] Étendre `modal_app/_mesh.py:generate()` pour accepter N vues (front + jusqu'à 5 extras) au lieu du cap 2 vues actuel** — **Impact : moyen** (déclenche uniquement si l'user active MV-Adapter cloud).

6. **[Cat 1 Text2image] Porter la branche T-pose (DreamShaper Lightning + CN OpenPose) dans `modal_app/_realvis.py` pour les triggers `t-pose / rts unit / neutral stance`** — **Impact : moyen**. Sans ça, rigging cloud downstream reçoit des poses libres au lieu de T-pose.

7. **[Cat 3 MV-Adapter] Déployer Wave 2.4 — nouveau endpoint `MODAL_MVADAPTER_URL` mirroring `multiview_mvadapter_gen.py` (768², 6 slots, ref scale 1.3, ShiftSNR 8.0)** — **Impact : moyen-haut pour assets créature** mais coût infra élevé.

8. **[Cat 12 Upscale] Remplacer SDXL refine de `modal_app/_upscale.py` par Real-ESRGAN x4plus (BSD-3, ~70 MB, weights HF)** — **Impact : moyen**. Réaligne sur préférence user "no hallucination on smooth surfaces".

9. **[Cat 15 NSFW] Porter `NSFW_KEYWORDS` + `NSFW_COMBOS` + `michellejieli/NSFW_text_classifier` dans nouveau `modal_app/_nsfw_text.py` invoqué avant `pipe(...)` sur Modal** — **Impact : moyen** (sécurité, pas qualité visible mais économie GPU + ferme une faille).

Pas retenu (cosmétique ou architectural justifié) : Cat 4 (CRM non portable Worker), Cat 5 (génériquisation voulue), Cat 6 (déjà verbatim), Cat 9 (déjà identique), Cat 10 (couches différentes), Cat 11 (déjà verbatim).

---

## 5. NSFW filter

**Status actuel :**
- **Desktop** : double gate complet — pré-prompt (keywords + combos child-safety + classifier IA `michellejieli/NSFW_text_classifier`) dans `src/main/main.js` L218-356, puis post-image (dual ViT `Falconsai` + `AdamCodd` + skin-ratio fallback) dans `scripts/nsfw_scan.py` et `local_juggernaut_bridge.py:295-336`. Sidecar `.nsfw` persistant. Mode adulte PIN-protégé via `isUnrestrictedMode()`.
- **Cloud** : SEULEMENT image-side (dual ViT identique + skin-ratio identique, threshold 0.5, blocked placeholder dark-grey + texte rouge). **AUCUN filtre pré-prompt** — un prompt NSFW textuel atteint SDXL avant d'être détecté en post.

**Confirmation explicite : rien n'est désactivé.** Conformément à la mémoire `feedback_never_disable_sac.md` et la prohibition formelle utilisateur sur la désactivation des protections : l'image-side ViT à parité parfaite reste en place des deux côtés. La recommandation **#9 du plan** est un **renforcement** (ajout du gate texte côté cloud), jamais une suppression. Le mode adulte desktop reste PIN-protégé et n'est pas exposé côté cloud (volontairement).

**Risque résiduel cloud à corriger** : combos child-safety (e.g. tokens d'âge + tokens de tenue) ne sont actuellement filtrés que côté desktop. Le port du `NSFW_COMBOS` dict est prioritaire sur le port des keywords simples.

---

## 6. Recommandation immédiate

Commencer par **porter `_CONCEPT_BOOSTERS` + crop-inpaint-paste + composite-back de `modal_app/_mask_inpaint.py` vers l'endpoint `/mask_inpaint` de `scripts/sdxl_server.py`** — c'est le seul changement single-fichier qui clôt en une fois la principale diff perçue user (insertion d'objets nets sans drift hors-mask) sans toucher à l'infra Modal ni au filtre NSFW.