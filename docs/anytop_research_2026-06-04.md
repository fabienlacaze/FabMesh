# AnyTop — Recherche & Stratégie Animation FabMesh
**Date** : 2026-06-04
**Contexte** : Session de debug intensive du pipeline AnyTop + retarget pour
animer le dragon Puppeteer (47 bones) de FabMesh.
**Conclusion** : Le checkpoint AnyTop officiel ne permet PAS de choisir
l'animation type (walk/run/death). Pour FabMesh on a 2 voies : (a) implémenter
le text-conditioning nous-mêmes (~1 semaine, plan détaillé ci-dessous),
(b) bypass AnyTop et utiliser une library FBX externe (41 anims MountainDragon
déjà exportées depuis l'asset pack Apovivor).

---

## 1. Résumé exécutif

### Ce qui marche
- **Mode 4 V2 (process_new_skeleton + sample.generate)** sur dragon Puppeteer :
  produit un motion stable et anatomiquement correct avec
  `seed=777, perturb=low, ANYTOP_OUTPUT_DAMP=0.6`. Le dragon a une posture
  debout naturelle, ailes déployées, 4 pattes au sol. Validé visuellement.
- **41 FBX MountainDragon exportés** depuis Apovivor UE5 project — walk, run,
  death, idle, fly, bite, glide, attack, etc. Stockés dans
  `C:/tmp/dragon_anim_fbx/`.
- **Pipeline `retarget_fbx_to_rig`** dans `scripts/anytop_retarget.py` existe
  et marche (validé sur Orc M1 run vers orc Puppeteer rig, 35 channels écrits).

### Ce qui ne marche pas / est limité
- **AnyTop est UNCONDITIONAL** : aucun `--text_prompt` / `--action_label`.
  On ne peut PAS demander "walk" précisément, juste obtenir un sample aléatoire
  du distribution.
- **Magnitudes V2 trop fortes** : mean delta 80-114° pour les seeds dynamiques,
  ce qui écroule le mesh au-delà de ~3 secondes même avec DAMP=0.6.
- **Retarget FBX orc** : les bras restent en T-pose statique alors que les
  jambes bougent en sidestep. Cause probable : rest pose mismatch
  (UE5 A-pose vs Puppeteer T-pose).
- **Axis convention forward** : le fix Ry(+90°) que j'ai tenté pour corriger
  UE5 X-forward → glTF -Z-forward a empiré le résultat. Reverted.

### Décision en cours
Le user a choisi (2026-06-04) d'**implémenter le text-conditioning nous-mêmes**
dans AnyTop ("on peut s'en charger nous"). Plan détaillé section 6.

---

## 2. Pourquoi AnyTop est unconditional — 4 sources concordantes

### Source 1 — Code officiel `parser_util.py`
```python
# C:/tmp/anytop_pure/utils/parser_util.py:257 (generate_args)
# Tous les arguments de sample.generate :
--object_type        # Choisit l'espèce (Dragon, Chicken, Bat) — PAS l'action
--seed              # RNG seed — donne un sample aléatoire différent
--motion_length     # Durée en secondes
--num_repetitions   # Nombre de variantes générées
--cond_path         # Charger un cond.npy custom (pour skeleton inconnu)
```
**Aucun `--text_prompt`, `--action_label`, `--motion_class`.**

`model_kwargs['y']` ne contient que (`model/anytop.py:69-75`) :
`joints_mask, mask, tpos_first_frame, joints_names_embs, crop_start_ind,
graph_dist, joints_relations, object_type, parents, n_joints, lengths, mean, std`.
Aucun champ d'action.

### Source 2 — Auteure principale Inbar Gat (GitHub Issue #12)
> *"You're correct — we currently don't support textual control over the
> generated motion. Introducing more explicit control (e.g., specifying actions
> like running or attacking) is definitely something we're considering for
> future work."*

### Source 3 — Paper section Conclusion (Conclusion.tex:13)
> *"In the future, we plan to use AnyTop for skeletal retargeting, multi-character
> interaction, editing, and various **control modalities such as text-based
> and music-driven animation**."*

= explicitement **FUTURE WORK**.

### Source 4 — Forks GitHub (Kitsunetic, Lingfanb)
- `Kitsunetic/Anytop` : copie personnelle, rien ajouté
- `Lingfanb/Anytop_CrossEmbodiment_Human2Humanoids` : nom prometteur, contenu
  identique à l'original

### Note sur le faux indice "(text-to-motion only)"
Le README mentionne `--motion_length (text-to-motion only) in seconds`. C'est
un **commentaire hérité de MDM** (Motion Diffusion Model, le repo parent
d'AnyTop) qui réfère à HumanML3D (text-to-motion) et HumanAct12
(action-to-motion). Aucun rapport avec AnyTop lui-même.
Citation : `parser_util.py:172` :
> "Maximum is 9.8 for HumanML3D (text-to-motion), and 2.0 for HumanAct12
> (action-to-motion)"

---

## 3. Architecture AnyTop — points pertinents pour text-conditioning

### Composants (Method.tex:34-49)
1. **Enrichment Block** :
   - Concatène `p_s` (rest-pose) comme frame 0 du noised motion
   - Encode `n_s` (joint names) via **T5** → projeté à dim F → **ajouté à chaque
     joint sur toutes les frames**
   - Output : `(N+1, J, F)` enrichi

2. **STT (Skeletal Temporal Transformer) Block** :
   - L layers de :
     - Skeletal attention (cross-joints, par frame)
     - Temporal attention (cross-frames, par joint) avec fenêtre W
     - Feed-forward
   - Intégration topologie via `D_s` et `R_s` dans les attention maps

3. **Output projection** vers la dim originale (D=13 par joint)

### Conditioning actuel
- **Topology** : `D_s` (graph distances) + `R_s` (joint relations 6-types)
  injectés dans les attention maps via learned embeddings
- **Skeleton** : rest pose + joint names T5 embeddings

### Pas d'action conditioning — mais T5 déjà chargé
Le T5 conditioner (`model/conditioners.py:358-381`) reçoit
`cond_dict[object_type]['joints_names']` (`sample/generate.py:128`).
Les noms encodés sont des strings de bones ("LeftLeg", "RightShoulder", "Tail").

**On peut réutiliser ce T5 pour encoder un action prompt et broadcast son
embedding sur tous les joints/frames.**

---

## 4. Mode 4 V2 — paramètres validés

### Pipeline complet
1. **export_puppeteer_v2.py** (`c:/tmp/`) :
   - Lit le rig GLB Puppeteer (47 bones)
   - Classifie chaque bone anatomiquement (hip/spine/wing/leg/tail/...)
   - Mappe chaque bone vers un nom canonique Truebones Dragon (40/47 canonical,
     7 "BN_Extra*" pour la zone face/jaw non classifiable)
   - Écrit 3 BVHs : tpose + 2 poses perturbées (Zrot ±15°, Xrot ±12°, Yrot ±8°)
   - `face_joints_names = [Bip01_R_Thigh, Bip01_L_Thigh, BN_RWing01, BN_LWing01]`

2. **process_new_skeleton** :
```
.venv/Scripts/python.exe -m utils.process_new_skeleton \
  --object_name PuppDragonV2 \
  --bvh_dir C:/tmp/pupp_dragon_v2_bvhs \
  --save_dir C:/tmp/pupp_dragon_v2_cond \
  --face_joints_names Bip01_R_Thigh Bip01_L_Thigh BN_RWing01 BN_LWing01 \
  --tpos_bvh "C:/tmp/pupp_dragon_v2_bvhs\tpose.bvh"
```

3. **sample.generate** :
```
.venv/Scripts/python.exe -m sample.generate \
  --model_path save/flying_model_dataset_truebones_bs_16_latentdim_128/model000229999.pt \
  --object_type PuppDragonV2 \
  --cond_path C:/tmp/pupp_dragon_v2_cond/cond.npy \
  --num_repetitions 1 \
  --motion_length 5.0 \
  --output_dir C:/tmp/pupp_dragon_v2_anim \
  --seed 777
```

4. **retarget_bvh_to_rig** avec `ANYTOP_OUTPUT_DAMP=0.6`

### Stats du winner (seed=777 low)
- mean delta = 9.85°
- max delta = 60.6°
- joints_over_90 = 0/38
- Pose : dragon debout natural, 4 pattes au sol, ailes déployées
- **MAIS** : motion subtle (idle-like), pas walk/run/death précis

### Erreurs des autres seeds
- seed=42 low : explose le mesh (mean 23.7°, max 175.6°)
- seed=123 low : winner basis-change DAMP=0.6 score 72/100, mais s'écroule à ~3-4s
- seed=42/123 high : motion riche mais mesh fragmente
- seed=100/500/1234/9999 low : pas testés visuellement (workflow background)

### Pourquoi le motion s'écroule au-delà de 3-4s
Magnitudes cumulées trop fortes pour l'anatomie du rig 47-bone. Solutions :
- Crop à 3s
- DAMP variable dans le temps
- Per-bone DAMP (différent par role)

---

## 5. FBX Library — solution pragmatique pour anims précises

### Assets disponibles dans Apovivor (UE5 project `d:/apovivor512.15`)
- **MountainDragon** : 41 anims labellisées (walk, run, death, idleBreathe,
  idleLookAround, flyNormal, FlyStationary, glide, falling, bite, biteGrabThrow,
  ClawsAttack2HitComboForward, LeftClawsAttackForward, rightClawsAttackForward,
  spitFireBall, spreadFire, takeOffToFlyStationary, takeOffToGlide,
  glidePosToLanding, FlyStationaryToLanding, getHitFront, getHitLeft, getHitRight,
  flyNormalGetHit, FlyStationaryGetHit, flyNormalToFall, deathHitTheGround,
  turn90Left, turn90Right, + variantes RM)
- **AfricanAnimalsPack** : Crocodile, Elephant, Hippopotamus, LionAndLioness,
  Rhinoceros, Zebra (anims par espèce)
- **AnimalVarietyPack** : Crow, DeerStagAndDoe, Fox, Pig, Wolf
- **Animal_pack_ultra_2** : autres assets quadrupèdes
- **Spider_LowPolyPack** : anims arachnides
- **Barghest** : créature quadrupède custom

### FBX déjà exportés
**C:/tmp/dragon_anim_fbx/** : les 41 FBX MountainDragon.
Export via `c:/tmp/export_dragon_anims_v2.py` (UE5 Python commandlet).
Commande utilisée :
```
"C:/Program Files/Epic Games/UE_5.7/Engine/Binaries/Win64/UnrealEditor-Cmd.exe" \
  "d:/apovivor512.15/apovivor450.uproject" \
  -run=pythonscript -script="c:/tmp/export_dragon_anims_v2.py" \
  -unattended -nopause -nullrhi
```

### Pipeline retarget existant
`scripts/anytop_retarget.py::retarget_fbx_to_rig` consume du FBX (via
`scripts/fbx_motion.py` + bpy worker) et écrit l'animation embedded
dans la GLB Puppeteer.

### Bugs actuels du retarget FBX
1. **Bras stuck en T-pose** alors que les jambes bougent (sidestep visible
   à la place de run forward). Cause probable : delta_src des bras = identité
   parce que la rest pose du source (UE5 A-pose) n'est pas alignée avec
   le frame 0 de l'animation.
2. **Forward axis** : motion forward UE5 (+X) devient lateral en glTF.
   Le fix `Ry(+90°)` dans `axis_to_target` a empiré → reverted.

### Mapping JSON utilisé
`scripts/rig_mappings/ue5_mannequin__humanoid_puppeteer.json` :
- 47+ bones mappés (pelvis, spine_01..05, neck_01..02, head, clavicle/upperarm/lowerarm/hand L+R, thigh/calf/foot/ball L+R)
- `axis_convention: source=z_up, target=y_up`
- `target_bones` table explicite pour humanoid_puppeteer

### Pour le dragon : mapping flying_quadruped à créer
Pas encore implémenté. Il faudra créer
`scripts/rig_mappings/mountain_dragon__flying_quadruped.json` avec les
bones MountainDragon UE5 (Root, Pelvis, Spine_01..04, Neck_01..03,
Head, Jaw, WingClavicle/UpperArm/Forearm/Hand L+R, WingFinger0..2 L+R,
Thigh/Calf/Foot/Toe L+R, Tail_01..08).

---

## 6. Plan d'implémentation text-conditioning

### Pourquoi c'est ~1 semaine au lieu de 2-4
- **T5 déjà présent** (`model/conditioners.py:358`)
- **Enrichment Block facile à étendre** (~50 LOC)
- **Fine-tune** le checkpoint existant au lieu de train-from-scratch
- **Architecture transformer modular** : ajouter un broadcast token = trivial

### Étape A : Récupérer dataset Truebones labellisé (~1 jour)
**Problème** : on n'a que `cond.npy` preprocessed, pas les BVHs originaux avec
les noms Dragon_Walk.bvh.

**Options** :
1. Acheter **Truebones Zoo $99** sur https://truebones.gumroad.com/l/skZMC
   (licence commerciale OK)
2. HuggingFace mirror `1Konny/t2m4lvo-truebones-zoo` (vérifier licence)
3. Convertir les 41 FBX MountainDragon en BVH et utiliser ce dataset
   (workflow alternatif si pas de budget Truebones)

### Étape B : Extraire les labels depuis les filenames (~1 jour)
- Parser `Dragon_Walk.bvh` / `Dragon___Walk_001.bvh` / `Dragon Walk.bvh` etc.
- Build action vocabulary :
  walk, run, idle, attack, death, fly, glide, bite, jump, sleep, eat,
  spit_fire, spread_fire, take_off, landing, turn_left, turn_right,
  get_hit, fall, sidestep, claw_attack, ...
- Modifier `data_loaders/truebones/data/dataset.py:67-78` pour inclure
  `data_dict['action_label']`

### Étape C : Implémenter Enrichment Block extension (~2 jours)

`model/anytop.py` :
```python
class InputProcess(nn.Module):
    def __init__(self, ...):
        # ... existing ...
        # NEW: action prompt projection (réutilise T5 dim)
        self.action_proj = nn.Linear(T5_DIM, self.feature_len)

    def forward(self, x, model_kwargs):
        # ... existing joint_names_embs handling ...

        # NEW: optional action conditioning
        action_emb = model_kwargs['y'].get('action_emb', None)
        if action_emb is not None:
            action_emb = self.action_proj(action_emb)  # (B, F)
            # broadcast on all joints, all frames
            x = x + action_emb[:, None, None, :]

        return x
```

`sample/generate.py` :
```python
if args.action_prompt:
    action_tokens = t5_conditioner.tokenize([args.action_prompt])
    action_emb = t5_conditioner(action_tokens).detach().cpu().numpy()
    model_kwargs['y']['action_emb'] = torch.from_numpy(action_emb).to(device)
```

`utils/parser_util.py` :
```python
group.add_argument("--action_prompt", default="", type=str,
                   help="Action label (walk/run/death/...) for text-conditioned generation")
```

### Étape D : Classifier-Free Guidance (~1 jour)

Dans `data_loaders/truebones/data/dataset.py` :
```python
if np.random.rand() < self.cond_mask_prob:
    data_dict['action_label'] = ''  # null prompt for CFG learning
```

Dans `sample/generate.py` :
```python
# Standard CFG sampling
guidance_scale = 3.5  # tune this
cond_out = model(x_t, t, with_action=action_emb)
uncond_out = model(x_t, t, with_action=None)
final = uncond_out + guidance_scale * (cond_out - uncond_out)
```

### Étape E : Fine-tuning (~3 jours wall-clock)
- Load checkpoint `save/flying_model_dataset_truebones_bs_16_latentdim_128/model000229999.pt`
- Fine-tune avec action labels sur le subset flying (Dragon, Bat, Pteranodon,
  Bird, Eagle, ...)
- Settings suggérés :
  - batch_size = 8-16 (selon VRAM RTX 5080)
  - lr = 1e-5 (low pour fine-tune)
  - steps = 50k-100k
  - cond_mask_prob = 0.15 (CFG)
- Wall-clock estimé : **3-5 jours** sur RTX 5080

### Étape F : Validation (~1 jour)
- Tester `sample.generate --action_prompt walk --object_type Dragon`
- Mesurer si le control est effectif (motion ressemble visuellement à walk vs random)
- A/B avec différents prompts (walk vs run vs death vs idle)

### Total
**~1 semaine de dev + 3-5 jours de training wall-clock = ~10-12 jours**

---

## 7. Architecture FabMesh — décisions

### Modal app `_anytop_anim.py` (existing)
- Pin AnyTop commit `e780d15` (2026-04-11)
- Image MIT compatible
- Run sample.generate sur GPU
- ZYX channel-order fix appliqué (commit `94c66b2`)
- Bind-pose anchor + rest tracks fix (commit `4629d3b`)
- BVH leaf channels patch (commit `6bb442f`)
- AGENT_LOG.md à jour

### Modal app `_ref_anim.py` (existing — FBX retarget)
- App name `myfabmesh-fbx-retarget`, CPU-only (~30s cold start)
- Pas d'AnyTop : pure-Python `retarget_fbx_to_rig`
- Endpoint `/fbx-retarget-fetch` retourne GLB animé
- Bug actuel : bras stuck en T-pose pour orc M1 run

### Cloud worker (`cloud/src/worker.ts`)
- `MODAL_ANYTOP_ANIM_URL` env binding
- POST `/api/animate` route
- 90s timeout (cold start AnyTop image)

---

## 8. Tests / Workflows lancés cette session

### Workflows complétés
- `wxsmsl985` (audit pipeline AnyTop import) : a halluciné des bugs ; 4 hypothèses
  invalidées par mesure (axis Z-up, basis-change déjà correct, etc.)
- `wuw2yxv1d` (recherche spec AnyTop custom skeleton) : confirme Mode 4 path
  + identifie le risque OOD
- `wq1bagc4v` (design bridge Puppeteer→AnyTop) : winner = Strategy B1 IK
  projection 880 LOC / 1 semaine. Plan détaillé dans le rapport.
- `wrfwwkjti` (post-mortem 4 fails) : recommande procedural animation 5-7j.
  Mais finalement on a trouvé Mode 4 V2 qui marche.
- `w63pf1o4q` (systematic exploration V2) : 24 variants (3 seeds × 2 perturbs ×
  4 DAMP) + screenshots + reviews. Winner = seed=123 low DAMP=0.6 score 72/100.
  Mais s'écroule à 3-4s.

### Test #5 V2 final = WINNER
- Pipeline : process_new_skeleton avec 3 BVHs perturbés + face_joints valides
  + noms canoniques + sample.generate seed=777 + retarget DAMP=0.6
- Output : dragon mesh debout natural, 4 pattes au sol, ailes spread
- Validé visuellement par user : "B parait vraiment bien"

### Test FBX retarget orc
- Source : `c:/tmp/apovivor_export/AS_Orc_M1_Run.fbx`
- Target : `meshes/orc_marron_trellis2_native_*_rigged_puppeteer_*.glb`
- Output : `c:/tmp/viewer/orc_run.glb` (35 channels, 20 samples)
- Bug : bras stuck en T-pose, jambes en sidestep (forward axis mismatch)
- Fix Y+90 tenté → "pire" → reverted

---

## 9. Fichiers clés à connaître

### Scripts modifiés / créés cette session
- `c:/tmp/export_puppeteer_as_canonical_bvh.py` (v1)
- `c:/tmp/export_puppeteer_v2.py` (v2 avec face_joints fix + canonical names only)
- `c:/tmp/inject_canonical_stats.py` (test #4 — abandoned)
- `c:/tmp/direct_retarget.py` (no-basis-change attempt — abandoned)
- `c:/tmp/export_dragon_anims_v2.py` (UE5 → FBX export, marche)
- `scripts/rig_mappings/_loader.py` (Y+90 fix tenté puis reverted)

### Données
- `c:/tmp/dragon_rig.glb` (Puppeteer rig de test, 47 bones)
- `c:/tmp/dragon_anim_fbx/` (41 FBX MountainDragon)
- `c:/tmp/pupp_dragon_v2_cond/cond.npy` (cond.npy V2 winner)
- `c:/tmp/pupp_dragon_v2_anim/PuppDragonV2_rep_0_#0.bvh` (motion winner)
- `c:/tmp/viewer/v2_s123_low_d06.glb` (workflow winner — basis-change)
- `c:/tmp/viewer/stable_s777.glb` (test #5 user-validated mesh)

### Viewers
- `c:/tmp/viewer/pupp_v2.html` (skeleton view)
- `c:/tmp/viewer/pupp_v2_mesh.html` (mesh view)
- `c:/tmp/viewer/pupp_v2_grid.html` (4-pane DAMP grid)
- `c:/tmp/viewer/winner_fix.html` (s777 vs crop3s)
- `c:/tmp/viewer/anim_picker.html` (6 seeds picker)
- `c:/tmp/viewer/pupp_compare.html` (direct vs basis-change)
- `c:/tmp/viewer/orc_run.html` (orc FBX retarget)

---

## 10. Références

### Paper
- **AnyTop: Character Animation Diffusion with Any Topology**
- arXiv: https://arxiv.org/abs/2502.17327 (v2)
- Project page: https://anytop2025.github.io/Anytop-page/
- License: MIT

### Code
- Official: https://github.com/Anytop2025/Anytop
- Local clone: `C:/tmp/anytop_pure/`
- Pin commit: `e780d15` (2026-04-11)

### Dataset
- Truebones Zoo: https://truebones.gumroad.com/l/skZMC ($99)
- HuggingFace mirror (à vérifier): `1Konny/t2m4lvo-truebones-zoo`

### Models text-to-motion alternatives (humanoid only)
- MDM (Tevet 2022) — repo parent d'AnyTop, text/action conditioned
- MotionGPT (Jiang 2023) — LLM-based
- T2M-GPT (Zhang 2023)
- ACTOR (Petrovich 2021) — action class conditional

### Issues GitHub citées
- Issue #12 (Inbar Gat) — confirms unconditional
- Issue #23 — in_betweening style preservation

---

## 11. Décisions finales

1. **Mode 4 V2 winner (seed=777 low DAMP=0.6) est SHIPPABLE pour idle/ambient**
   du dragon dans la version actuelle de FabMesh. Pose stable, posture natural.
   → À intégrer dans modal_app comme fallback "generic dragon idle".

2. **Pour walk/run/death/attack précis** : 2 voies parallèles à évaluer :
   - **Voie A** : Implémenter text-conditioning AnyTop nous-mêmes (~10-12 jours).
     User a choisi cette voie le 2026-06-04.
   - **Voie B** : Library FBX externe (41 anims MountainDragon déjà prêts) +
     retarget pipeline. Plus rapide à shipper, moins novateur.

3. **Bugs FBX retarget à fixer en parallèle** :
   - Bras stuck T-pose orc → debug rest pose A vs T mismatch
   - Forward axis sidestep → revoir mapping JSON ou ajouter `forward_yaw_deg`
     config (sans toucher au code générique du _loader.py)
