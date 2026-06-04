# AnyTop — Architecture & Math (Deep Reference)

**Date** : 2026-06-04
**Source** : code `c:/tmp/anytop_pure/` + paper `c:/tmp/anytop_paper/*.tex`
**Purpose** : Référence technique exhaustive pour réimplémenter ou modifier AnyTop.
Chaque affirmation est ancrée à un file:line ou paper section.

---

## 1. High-level architecture

AnyTop est un DDPM transformer-encoder. À chaque denoising step `t in [1,T]`, prend un noisy motion `X_t` + un skeleton `S = {p_S, R_S, d_S, n_S}`, prédit le clean motion `X_hat_0` (predict-x0, `Method.tex:37`).

**Deux top-level blocks** (`Method.tex:39`) :
1. **Enrichment Block** — folde rest-pose, joint names, timestep, positional encoding dans le noised motion. Code : `InputProcess` dans `model/anytop.py:106-158`.
2. **Skeletal-Temporal Transformer (STT) Block** — `L` layers identiques : *Skeletal Attention* → *Temporal Attention* → *Feed-Forward*. Code : `GraphMotionDecoder` / `GraphMotionDecoderLayer` dans `model/motion_transformer.py:133-240`.

```
                            S = (p_S, R_S, d_S, n_S)
                                          │
                ┌─────────────────────────┴──────────────────────────┐
                │              Enrichment Block                       │
                │   - linear-embed X_t per joint  → latent F           │
                │   - linear-embed p_S per joint  → prepended as frame 0│
                │   - T5(n_S) → linear F → add to every (frame,joint)  │
                │   - sin positional encoding over (N+1) frames       │
                └─────────────────────────┬──────────────────────────┘
                                          │ shape (N+1, B, J, F)
                                          │ + sinusoidal t_emb (broadcast)
       ┌──────────────────────────────────┴──────────────────────────────┐
       │  STT layer × L                                                    │
       │                                                                   │
       │   ┌───────── Skeletal Attention (per frame, across J joints)────┐ │
       │   │  a_ij = (q_i·k_j + a^d_ij + a^R_ij) / sqrt(F)                │ │
       │   │  with learned hop/edge query+key embeddings (GRPE-style)     │ │
       │   └──────────────────────────┬───────────────────────────────────┘ │
       │   LayerNorm + residual                                             │
       │   ┌───────── Temporal Attention (per joint, across W frames) ─┐  │
       │   │  standard MHA, window W=31                                  │  │
       │   └──────────────────────────┬───────────────────────────────────┘ │
       │   LayerNorm + residual                                             │
       │   ┌───────── Feed-Forward (Linear-GELU-Linear) ────────────────┐  │
       │   └──────────────────────────┬───────────────────────────────────┘ │
       │   LayerNorm + residual                                             │
       └──────────────────────────────┴──────────────────────────────────┘
                                          │
                                  OutputProcess
                                          │
                                X_hat_0  shape (B, J, D, N)
```

---

## 2. Motion representation

Tensor `X ∈ R^{N × J × D}` (`Method.tex:14`). Layout code = `[B, J, D, N]`, permuted en `[N, B, J, D]` dans `InputProcess.forward` (`model/anytop.py:131`).

**Per-joint features**, `D = 13` (`Method.tex:16-18`) :

| Slice  | Symbol | Dim | Meaning |
|--------|--------|-----|---------|
| `[0:3]`   | `p_j`  | 3 | Root-relative position |
| `[3:9]`   | `r_j`  | 6 | 6D rotation (Zhou et al. 2019 continuity rep) |
| `[9:12]`  | `v_j`  | 3 | Linear velocity |
| `[12:13]` | `fc_j` | 1 | Foot-contact label (binary) |

Confirmation : `data_loaders/truebones/truebones_utils/motion_process.py:270-279` : positions `[:3]`, rotation `[3:9]`, vel `[9:12]`, foot `[12]`.

Le **root joint** a son propre embedding (`InputProcess.root_embedding`, `anytop.py:112`) mais même `D=13` (`model_util.py:33,41`).

**Permutations dans forward** :
- Entry : `x = [B, J, D, N]` (`anytop.py:65`)
- After InputProcess : `[N+1, B, J, F]` (+1 = rest-pose frame, `anytop.py:131-138`)
- Skeletal attn flatten : `[N+1 · B, J, F]` (`motion_transformer.py:189-190`)
- Temporal attn flatten : `[N+1, B · J, F]` (`motion_transformer.py:204`)
- Output : `[B, J, D, N+1]` puis `[..., 1:]` drop rest-pose token → `[B, J, D, N]` (`anytop.py:175`)

---

## 3. Skeleton conditioning S = {p_S, R_S, d_S, n_S}

### 3.1 Rest pose `p_S`
`p_S ∈ R^{J×D}` — FK avec zero rotations sur `(G_S, O_S)`, root-relative, padded zero rotation 6D + zero velocity + foot-contact indicators pour vivre dans même `D=13` (`Appendix.tex:49-50`). Injecté comme frame 0 (`Method.tex:48`, code `anytop.py:136-138`).

### 3.2 Joint-relations matrix `R_S ∈ N0^{J×J}`
Six categories (`Method.tex:26`) :
```
self:0   parent:1   child:2   sibling:3   no_relation:4   end_effector:5
```
`self` et `end_effector` valides only sur diagonale.

Construction `motion_process.py:284-321` (`create_topology_edge_relations`) :
- Init `edge_rel = no_relation` partout
- Pour chaque `(i,j)` : child si `parents[j] == i`, parent si `j == parents[i]`, sibling si `parents[j] == parents[i]`, self si `i == j`
- Si aucun child trouvé pour `i` (flag `ee = True`), override `edge_rel[i,i] = end_effector`

### 3.3 Distance matrix `d_S ∈ N0^{J×J}`
Topological hop distance, clamped à `d_max` (`Method.tex:27`).
- Direct parent-child : `topo_rel = 1`
- Recursive : `topo_rel[i,j] = topo_rel[i, parents[j]] + 1`
- Symmetric : `topo_rel[i,j] = topo_rel[j,i]`
- Clamp : `topo_rel[topo_rel > max_path_len] = max_path_len`

**`d_max = 5`** justifié empiriquement (`Appendix.tex:15`, code `MAX_PATH_LEN = 5` dans `motion_process.py:363`).

### 3.4 Joint names `n_S`
Preprocessing dans `T5Conditioner` (`model/conditioners.py:253-381`) :
- **Prefix removal** : `BN_Bip01`, `Bip01`, `BN`, `NPC`, `jt`, `Sabrecat`, `Elk` stripped (line 281)
- **CamelCase split** : `re.split('(?=[A-Z]|_)', s)` (line 335)
- **Digit/underscore stripping** par token, single-char tokens dropped
- **Side normalisation** : `L`/`l` → `Left`, `R`/`r` → `Right`
- **Japanese dictionary** (line 282-284) : `momo→Thigh`, `sippo→Tail`, `mune→Chest`, `hiza→Knee`, `hara→Stomach`, `ashi→Leg`, `hiji→Elbow`, `koshi→Hips`, `te→Hand`, `kubi→Neck`, `atama→Head`, `ago→Jaw`, `kata→Shoulder`. `Tai → Tail`.
- T5 tokenizer + encoder → `last_hidden_state` masked-averaged → un `R^{t5_out_dim}` vector par joint

---

## 4. Enrichment Block (`InputProcess`)

File : `model/anytop.py:106-158`.

Per frame :
1. Root via `root_embedding: R^13 → R^F` (line 112)
2. Non-root via `joint_embedding: R^13 → R^F` (line 114)
3. Same projections for rest pose : `tpos_root_embedding`, `tpos_joint_embedding`
4. Concat rest-pose frame en front : `x = cat([tpos_embedded, x_embedded], dim=0)`, length `N+1` (line 138)
5. **Joint names** : `text_embedding: R^{t5_out_dim} → R^F` (line 119) + `Dropout(p=0.1)`. Broadcast on frame axis : `x = x + joints_embedded_names[None, ...]` (line 141)
6. **Sinusoidal positional encoding** (lines 7-26). Position 0 = rest-pose, frames start at 1, offset par `crop_start_ind`

Output : `R^{(N+1) × B × J × F}` (`Method.tex:49`).

---

## 5. Skeletal-Temporal Transformer (STT)

### 5.1 Layer structure
`GraphMotionDecoderLayer` (`motion_transformer.py:175-240`). Pre-residual, 3 sub-blocks :
```python
x = tgt + embed_timesteps(t_emb)                 # line 234
x = norm1(x + _spatial_mha_block(x, ...))         # line 237  Skeletal Attention
x = norm2(x + _temporal_mha_block_sin_joint(x))   # line 238  Temporal Attention
x = norm3(x + _ff_block(x))                       # line 239  Feed-Forward
```

Timestep embedding = sinusoidal `create_sin_embedding(t, latent_dim)` (`anytop.py:74`) puis `Linear(d_model, d_model)`. **Ajouté à chaque layer entry**, broadcast sur tous (frame, joint) tokens.

### 5.2 Skeletal Attention (`GraphMultiHeadAttention`)
Per-frame self-attention across `J` joints, topological bias GRPE-style (Park et al. 2022).

Pour chaque paire `(i,j)` (`Method.tex:71-81`) :
```
a^d_ij = q_i · E^d_q[d_ij]  +  k_j · E^d_k[d_ij]     (distance bias)
a^R_ij = q_i · E^R_q[R_ij]  +  k_j · E^R_k[R_ij]     (relation bias)
a_ij   = (q_i · k_j + a^d_ij + a^R_ij) / sqrt(F)     (final logit)
```
puis row-wise softmax.

**Embedding tables** (`motion_transformer.py:139-146`) :
- `topology_query_emb`, `topology_key_emb` : `nn.Embedding(d_max+1=6, d_model)` (+1 pour clamped)
- `edge_query_emb`, `edge_key_emb` : `nn.Embedding(6, d_model)` (6 categories)
- Optional `*_value_emb` (only si `value_emb=True`, default off)

`scale = (d_model // nheads) ** -0.5` (code utilise `1/sqrt(F/H)` per-head scaling, paper Eq utilise `1/sqrt(F)` — équivalent).

### 5.3 Temporal Attention
Standard `torch.nn.MultiheadAttention` (`motion_transformer.py:182`). Self-attention along frame axis per joint indépendamment (`Method.tex:57-58`).

Implementation `_temporal_mha_block_sin_joint` (lines 201-209) :
- Reshape `[N+1, B, J, F] → [N+1, B*J, F]`
- Standard MHA avec `attn_mask = temporal_mask`

**Temporal window** `W = 31` (`Appendix.tex:15`). Banded attention mask width `W` centré sur chaque frame. Forbidden positions = `−1e9` (`anytop.py:85`).

### 5.4 Feed-Forward
`_ff_block` (`motion_transformer.py:212-214`) : `Linear(F, ff_size) → GELU → Dropout → Linear(ff_size, F) → Dropout`. `ff_size = 1024` (`model_util.py:38`).

---

## 6. Output Process
`OutputProcess` (`model/anytop.py:160-176`) :
- Root : `root_dembedding: F → 13`
- Non-root : `joint_dembedding: F → 13`
- Concat root + non-root, permute `[B, J, D, N+1]`, drop frame 0 → `[B, J, D, N]`

---

## 7. Diffusion training

| Parameter | Value | Source |
|-----------|-------|--------|
| Steps `T` | **100** | `model_util.py:46`, `Experiments.tex:27` |
| Predict | `x_0` (START_X) | `model_util.py:45,62` |
| Beta schedule | **cosine** | `parser_util.py:67`, `gaussian_diffusion.py:37` |
| Variance type | `FIXED_SMALL` | `model_util.py:66-68` |
| Loss type | MSE on `x_0` | `model_util.py:53` |

### Losses

**L_simple** (`Method.tex:92-94`) :
```
L_simple = E_t || AnyTop(X_t, t, S) − X_0 ||_2^2
```

**L_geo / L_rot** geodesic on 6D rotation (`Method.tex:96-100`) :
```
L_rot = Σ_n Σ_j arccos( ( Tr( GS(r_{n,j}) · GS(r_hat_{n,j})^T ) − 1 ) / 2 )
```
où `GS` = Gram-Schmidt 6D → 3×3 rotation matrix.

**Total** :
```
L = L_simple + λ_rot · L_rot
```
λ_rot exposé via `--lambda_geo` (`parser_util.py:89`, default `0.0` mais README passe `1.0`).

### Sampling
`BalancingSampler` : `1/(n_i · k)` per instance pour skeleton type `i` (`Method.tex:86`).

### Augmentations
1. **Joint removal** 10-30% — only leaves, jamais feet, exclut joints à multiples children (`motion_process.py:581-605`)
2. **Joint addition** : insert at edge midpoint, only edges où end has single child et parent != root (`motion_process.py:608-674`)
3. Après chaque op : `R_S`, `d_S`, `n_S` recomputed

---

## 8. Hyperparameters

| Hyperparameter | Default | Source |
|----------------|---------|--------|
| Latent F | **128** | `parser_util.py:83` |
| FF size | **1024** | `model_util.py:38` |
| STT layers L | **4** | `parser_util.py:81` |
| Attention heads H | **4** | `model_util.py:38` |
| Dropout | **0.1** | `model_util.py:39` |
| Activation | **GELU** | `model_util.py:39` |
| Joint-name dropout | 0.1 | `anytop.py:118` |
| T5 backbone | **t5-base** (768-dim) | `parser_util.py:90` |
| Max joints J_max | **143** | `model_util.py:32` |
| Crop length N (train) | **40 frames** | `Appendix.tex:15` |
| Max gen frames | 120 | `parser_util.py:139` |
| Temporal window W | **31** | `Appendix.tex:15` |
| Max distance d_max | **5** | `motion_process.py:363` |
| Batch size | **16** | `Appendix.tex:16` |
| Learning rate | `1e-4` | `parser_util.py:118` |
| Weight decay | 0.0 | `parser_util.py:120` |
| Training steps | up to 600,000 | `parser_util.py:137` |
| `cond_mask_prob` | 0.1 | `parser_util.py:85` (plumbed mais inert) |

Training hardware (paper) : single NVIDIA RTX A6000, **~24h**. Inference : RTX 2080 Ti.

---

## 9. Three forms of generalisation (Analysis.tex)

- **In-skeleton (in-gen)** — temporal & spatial composition within same skeleton
- **Cross-skeleton (cross-gen)** — adapting motifs across characters
- **Unseen-skeleton (unseen-gen)** — works on skeletons absent from training (degrades avec Wasserstein graph-feature distance)

---

## 10. Re-implementation cheat sheet

Minimum pour reproduire AnyTop :

1. **Data tensor** `[B, J, D=13, N]`, slots `[pos(3), rot6D(6), vel(3), fc(1)]`
2. **Per-skeleton cond dict** : `tpos_first_frame [J,D]`, `joints_relations [J,J] ∈ {0..5}`, `graph_dist [J,J] ∈ {0..5}`, `joints_names_embs [J, t5_out_dim]`, `joints_mask`, `mask`, `crop_start_ind`
3. **Enrichment** : two Linears (root, non-root) pour motion et rest-pose → `F` ; T5(name) → Linear → `F` added per-joint broadcast across frames ; sinusoidal pos-enc over `N+1` with offset `crop_start_ind` ; concat rest-pose comme frame 0
4. **STT × L=4** : à chaque layer ajouter sinusoidal timestep emb via Linear, puis (a) skeletal MHA avec GRPE biases (2×`Embedding(6, F)` hop q/k + 2×`Embedding(6, F)` edge q/k) — softmax sur joint axis, scale `1/sqrt(F/H)` ; (b) temporal MHA across frames per joint, banded mask width `W=31` ; (c) GELU FF hidden `1024`. Pre-residual + LayerNorm
5. **Output** : two Linears `F → 13`, drop rest-pose frame
6. **Diffusion** : 100 cosine-schedule steps, predict-`x_0`, MSE + λ_rot · geodesic on 6D-rotation slice
7. **Training** : batch 16, lr 1e-4, balancing sampler, skeletal aug (joint removal 10-30%, midpoint insertion)

---

## Gotchas importants

1. **`feature_len=13` est hard-coded** — toute nouvelle feature nécessite modif parallèle dans `motion_process.py:270-279`, `model_util.py:33`, InputProcess et OutputProcess
2. **Rest pose encodée comme frame 0** du même tensor avec zero rotation/velocity — model's "frame 0" output = rest-pose reconstruction, pas une real animation frame
3. **Topology pre-computed once per skeleton** dans `cond.npy` — runtime retargeting needs only `(R_S, d_S, n_S, p_S)` tuple, pas BVH access
4. **Code uses `t5-base`** (768-dim) par défaut, paper figure mentionne juste "T5". `t5_out_dim` must match checkpoint
5. **Paper scale `1/sqrt(F)` vs code `1/sqrt(F/H)`** per-head — équivalent sémantiquement, différent numériquement
6. **Default `value_emb=False`** — most checkpoints don't have `topology_value_emb` / `edge_value_emb`. Loading : `value_emb` must match training-time flag ou `strict=False`

---

## Key file paths

- `c:/tmp/anytop_paper/Method.tex` — équations
- `c:/tmp/anytop_paper/Appendix.tex` — d_max=5, W=31, N=40, J_max=143, batch=16
- `c:/tmp/anytop_paper/Experiments.tex` — T=100, L=4, F=128
- `c:/tmp/anytop_pure/model/anytop.py` — top-level model, InputProcess, OutputProcess
- `c:/tmp/anytop_pure/model/motion_transformer.py` — GRPE skeletal MHA, STT layer
- `c:/tmp/anytop_pure/model/conditioners.py` — T5 wrapper, joint-name preprocessing
- `c:/tmp/anytop_pure/utils/model_util.py` — diffusion/model factory defaults
- `c:/tmp/anytop_pure/data_loaders/truebones/truebones_utils/motion_process.py` — relation/distance graph construction, augmentations
- `c:/tmp/anytop_pure/diffusion/gaussian_diffusion.py` — DDPM machinery
