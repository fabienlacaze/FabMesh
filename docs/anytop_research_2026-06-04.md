# AnyTop — Synthèse Recherche & Stratégie FabMesh
**Date** : 2026-06-04
**Sources** : code `c:/tmp/anytop_pure/`, paper `arXiv:2502.17327v2`, 5 agents de recherche
**Status** : synthèse complète de la session de debug + plan d'implémentation text-conditioning

---

## 0. TL;DR

1. **AnyTop officiel = unconditional** : confirmé 4× (code, paper Conclusion, auteure GH#12, 2 forks). Le checkpoint ne supporte PAS de choisir l'animation type (walk/run/death).

2. **"How to Move Your Dragon" (T2M4LVO, ICML 2025) — successeur d'AnyTop avec text-conditioning EXISTE**. Code release pending, à surveiller : `https://t2m4lvo.github.io/`. C'est probablement notre meilleur chemin à moyen terme.

3. **Implémenter text-conditioning nous-mêmes = ~1 semaine** (réduit de l'estimation initiale 2-4 sem). Le T5 est déjà chargé pour les joint names — on ajoute juste un projection linéaire pour l'action prompt + broadcast. **Code déjà commencé** (commit `feat/text-conditioning-fabmesh` dans `C:/tmp/anytop_pure/`).

4. **Mode 4 V2 (seed=777 low DAMP=0.6) = shippable comme idle générique** pour le dragon. Validé visuellement, pose anatomique correcte.

5. **41 FBX MountainDragon exportés** depuis Apovivor — walk, run, death, idle, fly, bite, attack, etc. Solution **pragmatique court terme** via `retarget_fbx_to_rig` (besoin debug bras T-pose + créer mapping `flying_quadruped`).

6. **Truebones Zoo = $0-100 PWYW sur Gumroad**, licence commerciale OK. **AUTORISÉ** pour entraîner ML, **INTERDIT** de redistribuer raw BVH/FBX.

7. **Outils alternatives complémentaires** : Motion2Motion (training-free retarget cross-rig), AniMo (text-driven 78k seqs), UE5 FBIK (procedural fallback). Tous ML-models text-to-motion existants en 2026 sont humanoid-only sauf les 4-5 récents listés section 4.

---

## 1. Pourquoi AnyTop officiel est unconditional — 4 preuves

### Source 1 — Code (`utils/parser_util.py`)
Aucun arg `--text_prompt` / `--action_label` / `--motion_class`. Tous les args : `--object_type, --seed, --motion_length, --num_repetitions, --cond_path`.

`model_kwargs['y']` ne contient que `joints_mask, mask, tpos_first_frame, joints_names_embs, crop_start_ind, graph_dist, joints_relations, object_type, parents, n_joints, lengths, mean, std`. Aucun champ d'action.

### Source 2 — Auteure Inbar Gat (Issue GitHub #12)
> *"You're correct — we currently don't support textual control over the generated motion. Introducing more explicit control (e.g., specifying actions like running or attacking) is definitely something we're considering for future work."*

### Source 3 — Paper Conclusion (`Conclusion.tex:13`)
> *"In the future, we plan to use AnyTop for skeletal retargeting, multi-character interaction, editing, and various control modalities such as **text-based and music-driven animation**."*

= explicitement **FUTURE WORK**.

### Source 4 — Forks GitHub
- `Kitsunetic/Anytop` : copie personnelle, rien ajouté
- `Lingfanb/Anytop_CrossEmbodiment_Human2Humanoids` : nom prometteur, contenu identique

### Note sur le faux indice "(text-to-motion only)"
Le README mentionne `--motion_length (text-to-motion only) in seconds`. **C'est un commentaire hérité de MDM** (le repo parent d'AnyTop) qui réfère à HumanML3D (text-to-motion) et HumanAct12 (action-to-motion). Aucun rapport avec AnyTop lui-même (`parser_util.py:172`).

---

## 2. Architecture AnyTop (résumé)

📄 **Référence détaillée complète** : `docs/anytop_architecture_deep.md`

### Vue d'ensemble
DDPM transformer-encoder. Deux top-level blocks :
1. **Enrichment Block** (`InputProcess` dans `model/anytop.py:106-158`) : fold rest-pose + T5(joint_names) + sinusoidal pos-enc dans noised motion
2. **STT Block** (`GraphMotionDecoder` dans `model/motion_transformer.py:133-240`) : `L=4` layers de Skeletal Attention → Temporal Attention → Feed-Forward

### Motion representation
Tensor `[B, J, D=13, N]`. `D=13` par joint :
- `[0:3]` position root-relative
- `[3:9]` rotation 6D (Zhou 2019)
- `[9:12]` linear velocity
- `[12]` foot contact binary

### Skeleton conditioning `S = {p_S, R_S, d_S, n_S}`
- `p_S` rest pose (FK avec zero rotations, padded à D=13)
- `R_S [J,J]` joint relations 6 categories : `self:0, parent:1, child:2, sibling:3, no_relation:4, end_effector:5`
- `d_S [J,J]` graph distance clamped à `d_max=5`
- `n_S` joint names → T5 encoder → embedding `R^{768}` per joint

### GRPE-style Skeletal Attention
Pour chaque paire `(i,j)` de joints :
```
a_ij = (q_i·k_j + a^d_ij + a^R_ij) / sqrt(F)
a^d_ij = q_i · E^d_q[d_ij] + k_j · E^d_k[d_ij]
a^R_ij = q_i · E^R_q[R_ij] + k_j · E^R_k[R_ij]
```
Embeddings learned : `nn.Embedding(d_max+1=6, F)` (hop) + `nn.Embedding(6, F)` (edge).

### Hyperparameters clés
| Param | Value | Source |
|---|---|---|
| Latent F | 128 | `parser_util.py:83` |
| FF size | 1024 | `model_util.py:38` |
| Layers L | 4 | `parser_util.py:81` |
| Heads H | 4 | `model_util.py:38` |
| T5 backbone | t5-base (768d) | `parser_util.py:90` |
| Max joints | 143 | `model_util.py:32` |
| Train crop N | 40 frames | `Appendix.tex:15` |
| Temporal window W | 31 | `Appendix.tex:15` |
| Distance d_max | 5 | `motion_process.py:363` |
| Diffusion steps T | 100 | `model_util.py:46` |
| Beta schedule | cosine | `parser_util.py:67` |
| Predict | x_0 (START_X) | `model_util.py:45` |
| Batch size | 16 | `Appendix.tex:16` |
| Learning rate | 1e-4 | `parser_util.py:118` |

### Training losses
```
L = L_simple + λ_geo · L_rot
L_simple = MSE on x_0 (normalized)
L_rot = geodesic on 6D rotation (denormalized)
```
`λ_geo = 1.0` dans tous les released checkpoints.

---

## 3. Training & Fine-tuning (résumé)

### Released checkpoints
| Subset | Steps | Filename |
|---|---|---|
| flying | 230k | `model000229999.pt` |
| quadropeds | 190k | `model000189999.pt` |
| bipeds | 330k | `model000329999.pt` |
| millipeds_snakes | 350k | `model000349999.pt` |
| all (unified) | 460k | `model000459999.pt` |

Training hardware : single NVIDIA RTX A6000, **~24h** (paper Experiments.tex).

### Subsets training data
| Subset | Espèces | Count |
|---|---|---|
| BIPEDS | Ostrich, Flamingo, Raptor1/2/3, Trex, Chicken, Tyranno | 8 |
| QUADROPEDS | Horse, Hippo, Camel, Bear, Cat, Crocodile, Elephant, Lion, etc. | 36 |
| MILLIPEDS | Cricket, SpiderG, Scorpion, FireAnt, Crab, Centipede, Ant, etc. | 12 |
| SNAKES | Anaconda, KingCobra | 2 |
| FLYING | Bat, **Dragon**, Bird, Buzzard, Eagle, Parrot, Pigeon, Pteranodon, Tukan, Giantbee | 11 |
| FISH | Pirrana | 1 |
| **all** | union | **70** |

Motions per species : 3 à 40.

### Plan fine-tuning pour FabMesh Dragon

```bash
python -m train.train_anytop \
  --model_prefix flying_ft_dragon \
  --objects_subset flying \
  --lambda_geo 1.0 --balanced --overwrite \
  --resume_checkpoint save/flying_model_dataset_truebones_bs_16_latentdim_128/model000229999.pt \
  --num_steps 260000 \
  --save_interval 2000 \
  --lr 5e-5 \
  --gen_during_training --use_ema \
  --train_platform_type WandBPlatform
```

**Recommandations** :
- LR : `1e-4 → 5e-5` (×2 réduction) pour fine-tune
- Steps : 5k-30k extras (sur top des 230k flying)
- `--use_ema` recommandé pour stabilité fine-tune
- Watch `l_simple` et `geodesic_loss` sur W&B, stop quand plateau 5k steps

**Important** : NE PAS changer `latent_dim, layers, num_heads, ff_size, dropout, temporal_window, diffusion_steps, noise_schedule, t5_name, arch` — baked dans le checkpoint.

### Inference
- Sampler : vanilla DDPM `p_sample_loop` (T=100 steps, pas de DDIM)
- Init : pure Gaussian noise `(B, max_joints=143, 13, n_frames=motion_length·20)`
- `clip_denoised=False`
- Variance `FIXED_SMALL` (β̃_t)
- Output : `.npy` xyz positions + BVH via IK + stick-figure MP4

---

## 4. Modèles alternatives et papers récents (2024-2026)

### Compétiteurs directs d'AnyTop (topology-aware + non-humanoid)

| Modèle | Year | License | Action ctrl | Status | Lien |
|---|---|---|---|---|---|
| **AnyTop** | 2025 | MIT | NON | Released, 352⭐ | [GitHub](https://github.com/Anytop2025/Anytop) |
| **How to Move Your Dragon (T2M4LVO)** | ICML 2025 | TBD | **OUI text** | **Code release pending** | [Site](https://t2m4lvo.github.io/) |
| **AniMo** | CVPR 2025 | TBD | **OUI text** | Released | [GitHub](https://github.com/WandererXX/AniMo) |
| **X-MoGen** | Aug 2025 | TBD | **OUI text** | Code TBD | [arXiv 2508.05162](https://arxiv.org/abs/2508.05162) |
| **NECromancer** | Feb 2026 | TBD | **OUI text** | Released | [arXiv 2602.06548](https://arxiv.org/abs/2602.06548) |
| **Motion2Motion** | SIGGRAPH Asia 2025 | TBD | training-free retarget | Released | [Site](https://lhchen.top/Motion2Motion/) |
| **Topology-Agnostic Animal Gen** | Dec 2025 | TBD | **OUI text** | OmniZoo 140 species | [arXiv 2512.10352](https://arxiv.org/abs/2512.10352) |
| **UniMoGen** | May 2025 | TBD | claim | **no code** | [arXiv 2505.21837](https://arxiv.org/abs/2505.21837) |
| **SinMDM** | ICLR 2024 | MIT | per-clip overfit | Released | [GitHub](https://github.com/SinMDM/SinMDM) |

### Modèles text-to-motion **humanoid only** (pas applicable FabMesh non-humanoid)
- **MDM** (Tevet 2022) — repo parent d'AnyTop
- **MotionGPT** (Jiang 2023) — LLM-based
- **T2M-GPT** (Zhang 2023)
- **MLD** (Chen 2023)
- **ACTOR** (Petrovich 2021)
- **PriorMDM, OmniControl, GMD, MoFusion, MotionCLR, CAMDM**
- **Kimodo** (NVIDIA, Mars 2026) — 700h mocap mais humanoid only

### License blockers commercial
- **AMASS** = research only — JAMAIS ship weights derived from it
- **MotionCLR** = IDEA license interdit commercial — drop
- **Kimodo weights** = certains checkpoints NVIDIA R&D research-only
- **Mixamo ToS** = forbid ML training (Adobe FAQ confirmé)

### Lineage TAU (Tel Aviv University, Cohen-Or/Bermano group)
```
MDM (2022) → priorMDM → SinMDM → AnyTop (2025)
```
Auteurs AnyTop : Inbar Gat, Sigal Raab, Guy Tevet, Yuval Reshef, Amit H. Bermano, Daniel Cohen-Or.

### **GAME CHANGER** : T2M4LVO ("How to Move Your Dragon")
Successeur AnyTop avec **text-conditioning natif**. ICML 2025. Trained sur Truebones (même substrate). Code release pending.

**Stratégie** : surveiller le repo `github.com/t2m4lvo`. Si licence permissive → c'est la solution pour FabMesh text-to-motion sur creatures non-humanoid sans qu'on ait à implémenter nous-mêmes.

---

## 5. Truebones Zoo — dataset & licence

### Le produit
- **URL** : `https://truebones.gumroad.com/l/skZMC`
- **Vendor** : Truebones Motions Animation Studios
- **Formats** : `.BVH` + `.FBX` + textures + iClone files
- **Capture rate** : 30 fps native (AnyTop down-sample à 20 fps)
- **Pricing** : **Pay What You Want** ($0-100 sur Gumroad, coupon `truebonesfree` parfois disponible)
- **Upsells** : ProBones 10,000+ MOCAP Studio + X-PANDO 2,000 BVH Pak

### Inventaire (70 species)
```
FLYING   (11): Bat, Dragon, Bird, Buzzard, Eagle, Giantbee, Parrot, Parrot2,
               Pigeon, Pteranodon, Tukan
BIPEDS    (8): Ostrich, Flamingo, Raptor1/2/3, Trex, Chicken, Tyranno
MILLIPEDS(12): Cricket, SpiderG, Scorpion, FireAnt, Crab, Centipede, Ant, etc.
SNAKES    (2): Anaconda, KingCobra
QUADRUPEDS(36): Cat, Hippopotamus, Camel, Bear, Buffalo, Crocodile, Elephant,
               Deer, Fox, Gazelle, Horse, Hound, Jaguar, Lion, Mammoth,
               Monkey, Wolf, etc.
FISH      (1): Pirrana
```

Joint count : min 9 (Pigeon), max **142 (Dragon)**, mean 48.3. AnyTop `MAX_JOINTS=143` sized for Dragon + 1 slack.

### Filename convention
```
<Species>_<MotionLabel>.bvh   e.g. Chicken_Walk.bvh, Chicken_IdlePecking.bvh
```
Parser dans `data_loaders/truebones/data/dataset.py:53-62` : `startswith(f'{object_type}_')`.

### Licence (verbatim)
> *"Truebones products are absolutely royalty free and can be used for any and all purposes even commercial, including movies, animations, games, VR, AR, research, and education."*

> *"Re-distribution or resale of Truebones in .FBX, .BVH or i-Motion formats is strictly prohibited and protected by copyright law."*

| Use-case FabMesh | Allowed |
|---|---|
| Entraîner un modèle ML sur Truebones data | ✅ OUI |
| Bake motion sur user mesh + ship FBX/GLB output | ✅ OUI |
| Ship raw `.bvh`/`.fbx` dans installer | ❌ NON |
| Ship `.npy` processed features | ⚠️ Grey zone (demander confirmation Lloyd via Discord) |
| Crédit "Truebones Motions Animation Studios" | ✅ Required (poli) |

### Data on disk (no purchase needed)
- ✅ `c:/tmp/anytop_pure/dataset/.../cond.npy` — 70 species skeleton signatures (skeleton only)
- ✅ `c:/tmp/anytop_pure/assets/Truebones_Chicken/*.bvh` — 4 Chicken BVHs (TPOSE, Walk, IdlePecking, EggLaying)
- ✅ `c:/tmp/anytop_pure/assets/{Hound,Monkey,Ostrich,Scorpion}___*.npy` — 4 sample processed motions
- ❌ **Pas de motions/ dir** — pour fine-tune il faut acheter Truebones OU régénérer depuis BVHs externes (e.g. nos 41 FBX MountainDragon)

### HuggingFace mirror `1Konny/t2m4lvo-truebones-zoo`
- **Captions only** (1135 JSON files, 4 granularités short/mid/long/long_rich)
- **License CC-BY-NC-4.0** — research only, **PAS commercial**
- Pas de motion files

### Alternatives commerciales
| Source | Coverage | Prix | Licence | Best for |
|---|---|---|---|---|
| Truebones Zoo | 70+ species incl. Dragon | $0-100 PWYW | Royalty-free commercial, no redistrib | Best $/species ratio |
| Truebones ProBones | Humanoid + animal super-pack | TBD | Same Truebones T.O.S. | Si on étend à human mocap |
| MoCap Online creature packs | Dragon/monster sets curated | $30-$200 | Royalty-free per-seat | Polish premium |
| **Mixamo** (Adobe) | **Humanoid only** | Free | Royalty-free | INUTILE pour FabMesh non-humanoid |
| FAB.com / UE5 Marketplace | Per-species packs (Apovivor !) | $15-$80/pack | Standard FAB EULA | Filling gaps |
| CGTrader / TurboSquid | Per-animation | $5-$50/clip | Per-listing EULA | One-off niche |

---

## 6. Mode 4 V2 — paramètres validés pour idle générique

### Pipeline complet
1. **`c:/tmp/export_puppeteer_v2.py`** : rig GLB → 3 BVHs perturbés + canonical names + face_joints
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
  --model_path save/flying_model_.../model000229999.pt \
  --object_type PuppDragonV2 \
  --cond_path C:/tmp/pupp_dragon_v2_cond/cond.npy \
  --num_repetitions 1 --motion_length 5.0 \
  --output_dir C:/tmp/pupp_dragon_v2_anim \
  --seed 777
```
4. **retarget** avec `ANYTOP_OUTPUT_DAMP=0.6` via `retarget_bvh_to_rig`

### Winner stats
- mean delta = 9.85°, max delta = 60.6°, joints_over_90 = 0/38
- Pose : dragon debout natural, 4 pattes au sol, ailes spread
- **MAIS** : motion subtle (idle-like), pas walk/run/death précis
- Validé visuellement par user : "B parait vraiment bien"

### Limitations
- Motion type ALÉATOIRE (seed=777 happens to give idle)
- S'écroule au-delà de 3-4s si magnitudes plus fortes
- Pas de control sur action type

---

## 7. FBX Library Apovivor — solution pragmatique

### Assets disponibles dans `d:/apovivor512.15/Content/1_Actors/Animals/1_Source/`
- **MountainDragon** : 41 anims labellisées (walk, run, death, idle, fly, bite, glide, attack, getHit, turn90L/R, takeOff, landing, spit fire, etc.)
- **AfricanAnimalsPack** : Crocodile, Elephant, Hippopotamus, Lion, Rhinoceros, Zebra
- **AnimalVarietyPack** : Crow, Deer, Fox, Pig, Wolf
- **Animal_pack_ultra_2**
- **Spider_LowPolyPack**
- **Barghest** (quadrupède custom)

### 41 FBX MountainDragon exportés
**`C:/tmp/dragon_anim_fbx/*.fbx`** via UE5 Python commandlet :
```
"C:/Program Files/Epic Games/UE_5.7/Engine/Binaries/Win64/UnrealEditor-Cmd.exe" \
  "d:/apovivor512.15/apovivor450.uproject" \
  -run=pythonscript -script="c:/tmp/export_dragon_anims_v2.py" \
  -unattended -nopause -nullrhi
```

### Pipeline retarget existant
`scripts/anytop_retarget.py::retarget_fbx_to_rig` consume FBX (via `scripts/fbx_motion.py` + bpy worker), écrit animation embedded dans GLB Puppeteer.

### Bugs actuels à fixer
1. **Bras stuck en T-pose orc M1 run** — jambes bougent, bras pas. Cause probable : rest pose mismatch (UE5 A-pose vs Puppeteer T-pose), delta_src des bras = identité
2. **Forward axis** : motion forward UE5 (+X) devient lateral en glTF. Fix `Ry(+90°)` tenté → empiré → reverted
3. **Mapping `flying_quadruped` manquant** : pour MountainDragon il faut créer `scripts/rig_mappings/mountain_dragon__flying_quadruped.json`

---

## 8. Plan d'implémentation text-conditioning ourselves

📌 **Code déjà commencé** : branch `feat/text-conditioning-fabmesh` dans `C:/tmp/anytop_pure/`. Voir commits.

### Pourquoi c'est ~1 semaine au lieu de 2-4
**T5 déjà chargé** pour joint names. On AJOUTE juste un projection linéaire pour l'action prompt + broadcast. ~50 LOC.

### Étapes

**A. Récupérer dataset labellisé (~1 jour)**
- Option 1 : acheter Truebones Zoo ($0-100 PWYW)
- Option 2 : convertir nos 41 FBX MountainDragon en BVH (dataset dragon-only proof of concept)

**B. Extract labels depuis filenames (~1 jour)**
```python
# data_loaders/truebones/data/dataset.py
filename = "Dragon_Walk_001.bvh"
action = filename.split('_')[1].lower()  # → "walk"
data_dict['action_label'] = action
```
Vocabulary : walk, run, idle, attack, death, fly, glide, bite, jump, sleep, eat, spit_fire, take_off, landing, turn_left, turn_right, get_hit, fall, sidestep, claw_attack, ...

**C. Implementer Enrichment Block extension (~2 jours)**

`model/anytop.py` (DEJA FAIT — commit ce session) :
```python
class InputProcess(nn.Module):
    def __init__(self, ...):
        # ... existing ...
        self.action_dropout = nn.Dropout(p=0.1)
        self.action_embedding = nn.Linear(t5_output_dim, latent_dim)

    def forward(self, x, ..., action_embedded=None):
        # ... existing joint_names_embs handling ...
        if action_embedded is not None:
            action_proj = self.action_embedding(self.action_dropout(action_embedded))
            x = x + action_proj[None, :, None, :]  # broadcast on (frame, joint)
```

`utils/parser_util.py` (DEJA FAIT) :
```python
group.add_argument("--action_prompt", default='', type=str, nargs='*', ...)
group.add_argument("--guidance_scale", default=1.0, type=float, ...)
```

`sample/generate.py` (À FAIRE) :
```python
if args.action_prompt:
    action_tokens = t5_conditioner.tokenize([args.action_prompt])
    action_emb = t5_conditioner(action_tokens).detach().cpu().numpy()
    model_kwargs['y']['action_embs'] = torch.from_numpy(action_emb).to(device)
```

**D. Classifier-Free Guidance dropout (~1 jour)**
- Dans `dataset.py` : `if np.random.rand() < cond_mask_prob: action='';`
- Dans inference : `final = uncond + guidance_scale * (cond - uncond)`

**E. Fine-tuning (~3-5 jours wall-clock RTX 5080)**
- Load checkpoint flying
- Fine-tune avec action labels sur subset flying
- `lr=5e-5, steps=50k-100k, batch=8-16, cond_mask_prob=0.15, use_ema=True`

**F. Validation (~1 jour)**
- `sample.generate --action_prompt walk --object_type Dragon`
- A/B avec différents prompts
- Mesurer si control effectif (FID, action recognition)

### Total : ~10-12 jours

---

## 9. Outils complémentaires recommandés

### Top 5 pour FabMesh
1. **Motion2Motion (SIGGRAPH Asia 2025)** — training-free cross-rig retarget. Parfait pour bridge 142-bone canonical → Puppeteer 47-bone
2. **UE5 Control Rig FBIK** — Epic ships free 100% procedural dragon sample (`unrealengine.com/en-US/blog/full-body-ik-procedural-dragon-animations`). Fallback procédural
3. **AniMo (CVPR 2025)** — Text-driven, AniMo4D (78k seqs, 114 species). Si licence permissive
4. **T2M4LVO** — successeur AnyTop avec text-cond. Surveiller release
5. **Cascadeur Indie** ($96/yr, perpetual après 1 an) — auto-physics premium hand-keyed hero content

### Stratégie multi-couche recommandée
```
1. AnyTop (déjà shipped) → unseen topologies, idle/ambient
2. Truebones Zoo + UE5 IK Retargeter → common species fast path
3. UE5 Control Rig FBIK → procedural fallback dragons
4. Optional: Cascadeur → premium hero animation
```

### Industry signals
- **Autodesk** = most visible commercial entrant (UniMoGen + 2025 Motion Generation Survey)
- **Robotics** converge sur skeleton-agnostic framing (QuadFM, X-Diffusion, Latent Action Diffusion)
- **Aucune** game studio production deployment d'AnyTop publique encore

---

## 10. Décisions finales pour FabMesh

### Voies parallèles à exécuter

**Voie A — Court terme (cette semaine) : FBX library + retarget**
1. Fix retarget orc M1 run (bras T-pose)
2. Créer mapping `flying_quadruped` pour MountainDragon
3. Retarget les 41 anims dragon sur le rig Puppeteer
4. Ship un viewer avec menu (walk / run / death / idle / fly / attack)

**Voie B — Moyen terme (~10-12 jours) : implémenter text-conditioning**
1. ✅ Architecture étudiée (Method.tex + code)
2. ✅ Branch `feat/text-conditioning-fabmesh` créé
3. ✅ `model/anytop.py` modifié (InputProcess + AnyTop.forward)
4. ✅ `parser_util.py` modifié (`--action_prompt`)
5. ⏳ `sample/generate.py` à wirer
6. ⏳ Convertir 41 FBX MountainDragon en BVH labellisés
7. ⏳ Modifier dataset.py extraction labels + CFG dropout
8. ⏳ Fine-tune sur RTX 5080 (~3-5j)
9. ⏳ Test inférence + integration modal_app

**Voie C — Long terme : surveiller T2M4LVO**
- Repository : `https://t2m4lvo.github.io/`
- Si code released avec licence permissive → switch
- Probablement la meilleure solution à terme

### Mode 4 V2 winner = à intégrer maintenant
- Pipeline V2 (seed=777 low DAMP=0.6) à wirer dans modal_app comme "generic dragon idle"
- Fallback quand pas d'animation spécifique demandée

---

## 11. Tests / Workflows lancés cette session

| Workflow ID | Topic | Verdict |
|---|---|---|
| `wxsmsl985` | audit pipeline AnyTop import | 4 hypothèses invalidées par mesure (halluciné des bugs) |
| `wuw2yxv1d` | spec AnyTop custom skeleton | validée |
| `wq1bagc4v` | design Bridge IK Strategy B1 | rejeté, on a trouvé Mode 4 V2 |
| `wrfwwkjti` | post-mortem 4 fails | recommandait procedural, on a continué |
| `w63pf1o4q` | exploration systematic V2 | 24 variants × 3 frames screenshots + reviews adversariales. Winner = seed=123 low DAMP=0.6 score 72/100 mais s'écroule à 3-4s. seed=777 finalement préféré |

---

## 12. Fichiers clés à connaître

### Code MyFabmesh (master)
- `scripts/anytop_retarget.py` — retarget BVH/FBX → GLB
- `scripts/fbx_motion.py` — parse FBX via bpy worker
- `scripts/bvh_to_gltf_anim.py` — embed BVH dans GLB
- `scripts/rig_mappings/_loader.py` — JSON mapping loader (axis_to_target reverted)
- `scripts/rig_mappings/ue5_mannequin__humanoid_puppeteer.json`
- `modal_app/_anytop_anim.py` — Modal app AnyTop (commit pin `e780d15`)
- `modal_app/_ref_anim.py` — Modal app FBX retarget (CPU only)

### AnyTop fork (`C:/tmp/anytop_pure/`)
- Branch `feat/text-conditioning-fabmesh`
- Modified : `model/anytop.py`, `utils/parser_util.py`
- À modifier : `sample/generate.py`, `data_loaders/truebones/data/dataset.py`

### Scripts cette session
- `c:/tmp/export_puppeteer_v2.py` (V2 winner pipeline)
- `c:/tmp/export_dragon_anims_v2.py` (UE5 → 41 FBX exports)
- `c:/tmp/direct_retarget.py` (no-basis-change attempt, abandonné)

### Données
- `c:/tmp/dragon_rig.glb` — Puppeteer rig test (47 bones)
- `c:/tmp/dragon_anim_fbx/*.fbx` — 41 anims MountainDragon
- `c:/tmp/pupp_dragon_v2_cond/cond.npy` — cond V2 winner
- `c:/tmp/viewer/stable_s777.glb` — test #5 user-validated mesh

### Docs
- **`docs/anytop_research_2026-06-04.md`** (ce fichier) — synthèse principale
- **`docs/anytop_architecture_deep.md`** — référence architecture exhaustive

---

## 13. Références externes

### Paper & code AnyTop
- [arXiv 2502.17327v2](https://arxiv.org/abs/2502.17327) — paper (SIGGRAPH 2025 camera-ready)
- [GitHub Anytop2025/Anytop](https://github.com/Anytop2025/Anytop) — 352⭐ MIT
- [Project page](https://anytop2025.github.io/Anytop-page/)
- Commit pin FabMesh : `e780d15` (2026-04-11)

### Successeurs & alternatives
- [T2M4LVO "How to Move Your Dragon"](https://t2m4lvo.github.io/) — ICML 2025, successeur AnyTop avec text-cond
- [AniMo](https://github.com/WandererXX/AniMo) — CVPR 2025
- [Motion2Motion](https://lhchen.top/Motion2Motion/) — SIGGRAPH Asia 2025, training-free retarget
- [SinMDM](https://github.com/SinMDM/SinMDM) — ICLR 2024, MIT

### Dataset
- [Truebones Zoo Gumroad](https://truebones.gumroad.com/l/skZMC) — $0-100 PWYW
- [HF mirror captions only (CC-BY-NC)](https://huggingface.co/datasets/1Konny/t2m4lvo-truebones-zoo)

### Tools
- [UE5 FBIK Procedural Dragon](https://www.unrealengine.com/en-US/blog/full-body-ik-procedural-dragon-animations) — free Epic sample
- [Cascadeur](https://cascadeur.com/plans) — Indie $96/yr
- [Motion Generation Survey](https://arxiv.org/abs/2507.05419) — Autodesk 2025

### GitHub issues citées
- [Issue #12](https://github.com/Anytop2025/Anytop/issues/12) — Inbar Gat confirms unconditional
- [Issue #23](https://github.com/Anytop2025/Anytop/issues/23) — inpainting style preservation

---

## 14. Action items en cours

### ✅ Complété cette session
- [x] AnyTop unconditional confirmé (4 sources)
- [x] Mode 4 V2 winner pipeline (seed=777 low DAMP=0.6)
- [x] 41 FBX MountainDragon exportés depuis Apovivor
- [x] Architecture analysée — T5 réutilisable, ~50 LOC suffit
- [x] Branch `feat/text-conditioning-fabmesh` créé
- [x] `model/anytop.py` : action_embedded support ajouté
- [x] `utils/parser_util.py` : `--action_prompt` + `--guidance_scale` ajoutés
- [x] Doc synthèse écrit (ce fichier) + push backup branch master

### ⏳ Prochaines étapes
1. `sample/generate.py` : tokenize action_prompt + pass dans model_kwargs
2. Test forward pass dummy action (smoke test, RTX 5080 5min)
3. Convertir 41 FBX MountainDragon en BVH labellisés
4. `data_loaders/truebones/data/dataset.py` : extract action label + CFG dropout
5. Fine-tune flying checkpoint sur dataset Dragon labellisé (~3-5j)
6. Test inférence end-to-end `--action_prompt walk`
7. Wire dans modal_app
8. Surveiller release T2M4LVO en parallèle
