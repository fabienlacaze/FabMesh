# Voie B — Pipeline de texturing Hunyuan-inspired (2026-04-19)

Pipeline multi-vue qui transforme une **photo 2D front** en **mesh 3D texturé**,
en s'inspirant de Hunyuan3D-Paint sans plagier leur code. Tout est local,
gratuit, Apache 2.0 / MIT (une seule dépendance à remplacer pour
commercialisation: `nvdiffrast`).

---

## Vue d'ensemble

```
 photo front (1024×1024 PNG)
            │
            ▼
    ┌──────────────┐
    │ 1. SF3D      │   génère un mesh bare (~12k faces, Y-up, T-pose)
    │ (Stability)  │   avec UVs natifs + atlas basique
    └──────┬───────┘
           │ mesh.glb
           ▼
    ┌──────────────┐
    │ 2. MVAdapter │   génère 6 vues RGB cohérentes conditionnées sur
    │ ig2mv_sdxl   │   normales+positions du mesh, à partir de la photo
    └──────┬───────┘
           │ view_0..5.png + views.json (w2c, proj_mtx, mesh transforms)
           ▼
    ┌──────────────┐
    │ 3. Texture   │   xatlas UV repack + back-project orthographique
    │ Project      │   avec cos⁴ weighting + Telea UV inpaint
    └──────┬───────┘
           │
           ▼
     mesh_textured.glb  (sharp ratio ~57%, 170s total sur RTX 5080)
```

---

## Étape 1 — SF3D : bare mesh (~2 min)

**Script**: `scripts/local_sf3d_bridge.py`
**Modèle**: `stabilityai/stable-fast-3d` (license: Stability Community <$1M)
**Appel**: `subprocess.run([py, bridge, front.png, out.glb, 1024, -1, none, 0])`

**Entrée**: image front 1024×1024 (RGB ou RGBA).
**Sortie**: GLB avec:
- ~12k faces en T-pose
- Convention **Y-up**, front = +X
- UVs natifs sur un atlas 1024² (texture baked basique)
- Taille normalisée ≈ 1m

**Durée**: ~110s sur RTX 5080 (inclut chargement du modèle).

**Rôle dans voie B**: fournir la **géométrie**. L'atlas natif SF3D sera
remplacé plus tard par notre propre bake multi-vue.

---

## Étape 2 — MVAdapter : 6 vues cohérentes (~55s)

**Script wrapper maison**: `scripts/mvadapter_runner.py` (Apache 2.0)
**Modèles utilisés**:
- `stabilityai/stable-diffusion-xl-base-1.0` (CreativeML Open RAIL++-M)
- `madebyollin/sdxl-vae-fp16-fix` (MIT)
- `huanngzh/mv-adapter` (Apache 2.0, weights + code)

**Pourquoi un wrapper maison** ?
Le script MVAdapter stock (`external/MV-Adapter/scripts/inference_ig2mv_sdxl.py`) a 3 problèmes:
1. `num_views` hardcodé à 6 (ok mais non configurable)
2. Pas de CPU offload → OOM sur cartes 16 GB
3. Ne dump PAS les matrices de caméra → alignement impossible pour le bake

Notre wrapper:
- Import direct de `MVAdapterI2MVSDXLPipeline` (pas subprocess)
- Support FABMESH_MVA_OFFLOAD=none/model/sequential
- **Dump complet des w2c + proj_mtx + mesh transforms dans views.json**

### 2a. Rendu conditionnel (normale + position maps)

MVAdapter a besoin de 6 images d'entrée: pour chaque vue, les **normales**
et la **position** 3D par pixel. Rendu via `nvdiffrast` (rasterizer CUDA):

```python
cameras = get_orthogonal_camera(
    elevation_deg=[0, 0, 0, 0, 89.99, -89.99],   # front, right, back, left, top, bot
    azimuth_deg=[-90, 0, 90, 180, 90, 90],        # MVAdapter convention (azim-90)
    distance=1.8,
    left=-0.55, right=0.55, bottom=-0.55, top=0.55,  # ortho frustum
)
mesh = load_mesh(mesh_path, rescale=True)  # normalise v /= max|v| * 0.5, swap axes Y↔Z
render_out = render(ctx, mesh, cameras, height=512, width=512)
# render_out.pos   = position map (batch, H, W, 3) — coords monde
# render_out.normal= normal map  (batch, H, W, 3) — normales monde
```

Les deux maps sont concaténées et passées comme **conditioning** au ControlNet-like de MVAdapter.

### 2b. Diffusion multi-view SDXL (20 steps, guidance=3.0, 512×512)

```python
images = pipe(
    'high quality',
    num_inference_steps=20,
    num_images_per_prompt=6,              # 6 vues générées en batch cohérent
    control_image=control_images,         # pos + normal (6 × 6 canaux)
    reference_image=front_photo,          # notre photo 1024² downsamplée à 512²
    reference_conditioning_scale=1.0,
    ...
).images  # 6 × PIL 512×512
```

**Le secret**: le `DecoupledMVRowColSelfAttnProcessor2_0` de MVAdapter
applique une **attention multi-view structurée** qui garantit que le même
vêtement, même coupe de cheveux, même visage apparaissent dans les 6 angles.
Sans cette attention, chaque vue serait générée indépendamment → résultats
incohérents.

### 2c. Sauvegarde du schéma caméra

Pour que le bake soit pixel-perfect, on dump TOUT dans `views.json`:

```json
{
  "engine": "mvadapter",
  "projection": "orthographic",
  "cam_distance": 1.8,
  "cam_bounds": [-0.55, 0.55, -0.55, 0.55],
  "mesh_rescale_factor": 0.9708,
  "mesh_offset": null,
  "mesh2std": [[1,0,0], [0,0,1], [0,-1,0]],   // swap Y↔Z axes
  "views": [
    {
      "azim": 0.0, "elev": 0.0,
      "w2c":      [[...], [...], [...], [...]],  // 4×4 world-to-camera
      "proj_mtx": [[...], [...], [...], [...]]   // 4×4 orthographic
    },
    // ... 5 autres vues
  ]
}
```

**Note licence**: `nvdiffrast` utilisé ici est sous **NVIDIA Source Code License (non-commercial)**. Pour commercialisation, on le remplacera par `pyrender` (Apache 2.0) — le résultat est le même (normales/positions par pixel), juste plus lent.

---

## Étape 3 — Texture Project : bake multi-vue aligné (~3s)

**Script**: `scripts/texture_project.py` (existant, étendu pour voie B)
**Appel**: `texture_project.py mesh.glb front.png out.glb 1024 --multiview views_dir`

### 3a. xatlas UV repack

L'atlas SF3D natif a des micro-îlots UV (souvent 1-2 triangles chacun).
xatlas les reconsolide en charts plus gros → projection propre.

```python
vmap, idx_new, uv_new = xatlas.parametrize(vertices, faces)
```

Activé par défaut (`FABMESH_UV_REPACK=1`).

### 3b. Détection ortho + transforms mesh

Le fichier `views.json` dit `projection: "orthographic"` → on applique les **transforms inverses** pour aligner le mesh avec la convention MVAdapter:

```python
# Même transformation que MVAdapter load_mesh(rescale=True):
v_std = (v_mesh - offset) / rescale_factor
v_std = mesh2std @ v_std    # swap Y↔Z (Y-up → Z-up)
```

### 3c. Projection orthographique + visibility

Pour chaque vue et chaque sommet:

```python
clip = proj_mtx @ w2c @ [v_std; 1]    # 4D homogène
ndc  = clip[:3] / clip[3]              # [-1, 1] en x, y
p_u  = 0.5 * (ndc_x + 1)               # [0, 1] image
p_v  = 0.5 * (ndc_y + 1)               # pas de flip ! proj_mtx[1,1]<0 déjà inversé
n_cs = R_w2c @ n_std                   # normale dans repère caméra
vvis = clip(n_cs.z, 0, 1) ** bake_exp  # cos^4 anti-leopard
```

**Le "no V-flip"** est le piège qui a causé la tête en bas: `get_orthogonal_projection_matrix` de MVAdapter a **`proj_mtx[1,1] = -2/(top-bottom)`** (signe négatif), donc Y est **déjà** inversé dans le NDC. Rajouter un flip supplémentaire = tête en bas.

### 3d. Bake cos⁴ (Hunyuan-inspired)

Pour chaque pixel de l'atlas UV, on regarde quels triangles y tombent,
puis pour chaque vue qui voit ce triangle on calcule:

```
weight = cos(normal, view_dir)^4 × priority
```

Le `^4` est la **clé anti-leopard**: une face à 45° a déjà un poids
divisé par 5.66, à 60° par 16, donc les vues rasantes contribuent
quasi-zéro. Ça évite les tâches causées par 2 vues qui se battent pour le
même pixel avec des couleurs différentes.

Les poids de priorité (arbitraires, testés):
```
(0, 0):    1.0   # front
(90, 0):   0.9   # right
(180, 0):  0.8   # back
(270, 0):  0.9   # left
(0, 90):   0.7   # top
(0, -90):  0.7   # bottom
```

### 3e. Push-pull Gaussian pyramid fill

Les pixels de l'atlas **jamais vus** (≈ 43% au premier passage) sont
remplis par push-pull pyramidal: on downsample en moyennant les pixels
vus, puis on réinjecte aux trous. Couleur localement cohérente, pas de
noir.

### 3f. Telea UV inpaint (Hunyuan-inspired)

Dernier polish: `cv2.inpaint(..., INPAINT_TELEA, radius=3)` sur le masque
des pixels non-touchés. Reconstruit les détails edge-aware que le
push-pull a lissés.

**Déclencheur**: `FABMESH_TEXPROJ_UV_INPAINT=1` (défaut ON).

### 3g. Export GLB

Le GLB final est ré-empaqueté avec:
- Même géométrie que SF3D (12k faces)
- UVs xatlas (atlas reconsolidé)
- Atlas RGB 1024² (push-pull + Telea)
- Normal map SF3D préservée (on patch juste `baseColorTexture`)

---

## Variables d'environnement clés

| Variable | Défaut | Effet |
|---|---|---|
| `FABMESH_TEXPROJ_BAKE_EXP` | `0.8` (`4.0` en ortho) | Exposant `cos^N` pour visibilité |
| `FABMESH_TEXPROJ_UV_INPAINT` | `1` | Active Telea inpaint post push-pull |
| `FABMESH_TEXPROJ_NO_FRONT` | `0` | Skip la photo front HD (voie B = `1`) |
| `FABMESH_UV_REPACK` | `1` | xatlas re-parametrize avant projection |
| `FABMESH_MVA_OFFLOAD` | `none` | `none`/`model`/`sequential` CPU offload |

---

## Métriques mesurées (fille_afghanne)

| Config | sharp_ratio | Total | Note |
|---|---|---|---|
| Voie A (1 vue front, cos^4) | 14.1% | 47s | leopard, inutilisable |
| Voie B v1 (cam perspective SF3D) | 47.0% | 165s | dos cassé, double visage |
| Voie B v2 (cam ortho, V flip bug) | 57.2% | 170s | tête en bas |
| **Voie B v3 (cam ortho + V fix)** | **57.2%** | **170s** | **✅ OK** |

---

## Limites actuelles (pour future amélioration)

1. **Mesh 12k faces trop low-poly** — la forme globale est bonne, mais
   les polygones sont visibles sur les silhouettes (bras, chaussures).
   Solutions:
   - Utiliser **TripoSG** (50k-1.4M faces) en STEP 1 à la place de SF3D
   - Ajouter un **Catmull-Clark subdivision** post-SF3D (+smooth, +4× faces)
   - Ou remonter `target_polycount` dans SF3D si exposé

2. **MVAdapter 512×512** — textures parfois manquent de détail fin.
   Monter à 768×768 coûte ~3× VRAM (OOM 16 GB sans offload).

3. **nvdiffrast non-commercial** — blocker commercialisation. Remplacer
   par `pyrender` dans `mvadapter_runner.step_conditional_render`.

4. **Temps: 170s/mesh** — dont 110s SF3D + 55s MVAdapter + 3s bake.
   Le goulot est le chargement SDXL (SF3D lui est déjà cached). Garder
   la pipeline warm entre les jobs.

---

## Fichiers touchés

| Fichier | Rôle |
|---|---|
| `scripts/mv_bake_hunyuan.py` | Orchestrateur voie B (SF3D → MVAdapter → bake) |
| `scripts/mvadapter_runner.py` | Wrapper MVAdapter (CPU offload + dump matrices) |
| `scripts/texture_project.py` | Bake orthographique + Telea inpaint |
| `external/MV-Adapter/` | Sous-module upstream (Apache 2.0, non modifié) |
| `logs/ip_sweep/viewer_voieA.html` | Viewer comparatif v1/v2/v3 |

---

## Reproduction

```bash
# 1. Lancer le serveur HTTP local pour le viewer
cd logs/ip_sweep && python -m http.server 8766 &

# 2. Générer un mesh texturé voie B
PYTHONIOENCODING=utf-8 FABMESH_MVA_OFFLOAD=none \
  python scripts/mv_bake_hunyuan.py \
  logs/ip_sweep/_mirror_front.png \
  logs/ip_sweep/out.glb \
  sf3d 4.0

# 3. Ouvrir http://localhost:8766/viewer_voieA.html
```
