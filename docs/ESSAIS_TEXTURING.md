# FabMesh — Essais de pipelines de texturing (2026-04-19)

Historique chronologique des approches testées pour générer un mesh 3D texturé
de haute qualité à partir d'une photo front 2D, sur RTX 5080 16 GB.

## Contraintes

- **Local + gratuit + commercialisable** (pour vente sur Fab.com/itch.io/Gumroad)
- Licences OK uniquement: Apache 2.0, MIT, BSD-3, CreativeML OpenRAIL++-M,
  Stability Community <$1M
- Licences à remplacer: `nvdiffrast` (NVIDIA Source Code License, non-commercial)
- Licences rejetées d'emblée: SDXL Turbo, Hunyuan3D (EU ban + MAU cap), SMPL-X

---

## Vue d'ensemble des résultats

| Pipeline | Temps | sharp_ratio | Front | Back | Latéraux | Commercial OK |
|---|---|---|---|---|---|---|
| SF3D natif | 110s | baseline | 🟡 flou | 🟡 flou | 🟡 flou | ✅ |
| Voie A (cos⁴ + 1 vue) | 47s | 14% | 🟢 | ❌ leopard | ❌ leopard | ✅ |
| Voie B SF3D + MVAdapter 512² | 170s | 57% | 🟢 | 🟢 | 🟢 | ⚠️ nvdiffrast |
| Voie B TripoSG 200k + MVAdapter | 439s | 58% | 🟢 | 🟢 | 🟢 | ⚠️ nvdiffrast |
| **Voie C pure** RealVis+IPA+CN 1024² | 195s | 62% | 🟢 HD | 🟢 HD | ❌ front bleed | ✅ |
| **Voie HYBRID** C front+back + B latéraux | **194s** | **62%** | **🟢 HD** | **🟢 HD** | **🟢** | ⚠️ nvdiffrast (MVAdapter uniquement sur latéraux) |

---

## Voie A — texture_project cos⁴ + Telea (abandonnée)

**Hypothèse (Hunyuan-inspired)**: le `cos^4` weighting + UV inpaint Telea
suffisent à éliminer le leopard sur un mesh densifié (TripoSG 50k faces).

**Résultat**: ÉCHEC — avec seulement la photo front projetée sur un mesh
xatlas à 2456 charts, le cos^4 tue les flancs et 86% de l'atlas devient
des trous comblés aveuglément par Telea (blanc/gris).

**Enseignement**: `cos^N` n'aide QUE si on a ≥ 6 vues couvrant tout le
sujet. Avec 1-2 vues, ça dégrade.

---

## Voie B — SF3D/TripoSG + MVAdapter + bake

**Pipeline** (voir [docs/PIPELINE_VOIE_B.md](PIPELINE_VOIE_B.md)):
1. SF3D/TripoSG → bare mesh (Y-up, T-pose)
2. xatlas UV unwrap
3. MVAdapter `ig2mv_sdxl` génère 6 vues cohérentes @ 512² conditionnées
   par normal/position maps du mesh (rendu par nvdiffrast)
4. texture_project back-project ortho avec cos⁴ + Telea inpaint

**Résultat**: FONCTIONNE — sharp=57-58%, 6 vues cohérentes entre elles,
pipeline bien aligné (matrices de caméra ortho exactes passées via
`views.json`).

**Limites**:
- MVAdapter @ 512² → textures parfois manquent de détail fin
- Le `DecoupledMVRowColSelfAttnProcessor2_0` hardcode 6 vues (non
  configurable à 4)
- VRAM: 12-14 GB sans offload, OOM avec `enable_sequential_cpu_offload`
  à cause des hooks custom MVAdapter qui cassent `ref_hidden_states`
- **`nvdiffrast` = non-commercial** → blocker commercialisation

**Variante TripoSG 200k**: mesh 16× plus détaillé mais xatlas CPU prend
~3 min → 439s total. 560k faces crash xatlas (OOM). Sweet spot ~200k.

---

## Voie C pure — RealVis+IPA+CN pour les 6 vues (abandonnée)

**Hypothèse**: remplacer MVAdapter par le stack FabMesh existant
(RealVis XL v4.0 + IPAdapter Plus + ControlNet OpenPose SDXL), toutes
Apache 2.0/RAIL++-M. Les 6 squelettes OpenPose sont projetés depuis les
mêmes matrices caméra que le bake.

**Impl**:
- `scripts/_tpose_joints_3d.py`: 18 joints body_18 en 3D normalisé
  (MVAdapter Z-up convention) + fonction
  `render_skeleton_for_camera(w2c, proj_mtx)`
- `scripts/fabmesh_6views_runner.py`: boucle sur 6 angles, génère
  skeleton + diffuse avec RealVis+IPA+CN

**Piège 1 — confusion d'axes**: j'avais défini les joints en Y-up
alors que MVAdapter attend Z-up avec offset azim=-90°. Fix: joints
avec `+Y=front, +Z=up, +X=character right`.

**Piège 2 — IPAdapter dominance**: avec `ip_scale=0.55` (valeur validée
pour back view), RealVis **reproduit TOUJOURS la photo front** sur les
vues latérales/top/bottom — même avec:
- `cn_scale=1.15` (skeleton surpondéré)
- prompts très explicites ("right side profile silhouette, nose
  pointing right, only one ear visible")
- negative prompts renforcés ("no front view, no facing camera")
- ip_scale baissé à 0.20

Résultat: fille_francaise voie C pure → v1/v3/v4/v5 montrent toutes la
face avant. **ÉCHEC.**

**Enseignement**: ControlNet OpenPose SDXL n'est pas entraîné sur des
profiles latéraux "nez pointe à droite" — les datasets training sont
majoritairement frontaux. Même avec un skeleton parfait de profil,
RealVis ne sait pas produire un rendu latéral réaliste. Le pipeline
FabMesh est conçu pour front + back uniquement.

---

## Voie HYBRID — C pour front+back HD, B pour latéraux ✅ VALIDÉE

**Hypothèse**: MVAdapter est **fait pour la cohérence latérale** via son
attention multi-vue structurée; RealVis est **fait pour le photoréalisme
frontal HD**. Combiner les deux selon leurs points forts.

**Pipeline**:
1. SF3D → bare mesh
2. MVAdapter génère 6 vues cohérentes @ 512² (comme voie B)
3. Voie C (RealVis+IPA+CN) **écrase view_0 et view_2** avec des
   versions HD 1024² — ce sont les 2 angles où:
   - Les skeletons OpenPose ne sont PAS dégénérés (le nez pointe vers
     la caméra → largement visible, pas dégénéré axialement)
   - ControlNet OpenPose est entraîné à fond sur ces angles
   - RealVis produit la meilleure HD
4. texture_project bake avec les 6 vues (2 HD + 4 MVAdapter)

**Impl**:
- `scripts/fabmesh_6views_runner.py --only-front-back`: mode partiel
  où seuls view_0 et view_2 sont (re)générés, les autres slots restent
  tels quels (ceux écrits par MVAdapter juste avant)
- `scripts/mv_bake_hunyuan.py --engine hybrid`: orchestre les deux
  passes dans l'ordre

**Résultat fille_francaise**:
- **194s total** (comparable à voie B pure 170s, +24s pour voie C overlay)
- **sharp_ratio=62%**
- front+back en HD 1024² réalistes, latéraux cohérents avec MVAdapter

**Licences**:
- Front/back (voie C): 100% commercial OK
- Latéraux (voie B/MVAdapter): dépend de `nvdiffrast` → à remplacer par
  `pyrender` pour ship commercial

---

## Paramètres notables

### Voie B bake
- `FABMESH_TEXPROJ_BAKE_EXP=4.0` (Hunyuan-inspired cos^4 weighting)
- `FABMESH_TEXPROJ_UV_INPAINT=1` (Telea inpaint post push-pull)
- `FABMESH_TEXPROJ_NO_FRONT=1` (pas de mix HD front photo avec vues
  ortho — crée du double-face bleed)
- `FABMESH_UV_REPACK=0` (xatlas déjà fait amont)

### Voie C/Hybrid runner
- Seed unique partagé entre vues (cohérence outfit/cheveux)
- ip_scale front=0.80, back=0.55, latéraux=0.22 (ignorés en hybrid)
- cn_scale front=0.70, back=1.15, latéraux=1.15
- Negative prompts spécialisés par angle (front/back/side/top)

### MVAdapter
- `FABMESH_MVA_OFFLOAD=none` (sequential offload casse
  ref_hidden_states, model offload OK mais plus lent)
- 6 vues hardcodées @ 512² × 20 steps SDXL = ~55s sur RTX 5080 no offload

---

## Prochaines étapes

- [ ] **Replacer nvdiffrast par pyrender** → voie B/hybrid 100%
      commercial
- [ ] **Décision finale**: voie hybrid par défaut dans l'UI FabMesh
      (cf. plan livré dans ROADMAP)
- [ ] **Test sur enfant_roux et autres** pour valider la robustesse
- [ ] **Cloud Boost Phase 1**: exposer une alternative Replicate pour
      users sans GPU

---

## Viewers HTML de référence

Tous sur le serveur local `http://localhost:8766/`:

- [viewer_voieA.html](../logs/ip_sweep/viewer_voieA.html) — fille_afghanne
  (SF3D natif, voie B SF3D, voie B TripoSG 200k, voie C pure)
- [viewer_fille_francaise.html](../logs/ip_sweep/viewer_fille_francaise.html) —
  fille_francaise (voie C pure vs voie HYBRID avec les 12 vues comparées)
