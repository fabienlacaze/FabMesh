# FabMesh — custom wheels (TRELLIS-2 engine)

> Réécrit 2026-07-06 — l'ancienne version de ce doc décrivait un plan
> jamais réalisé (CDN wheels.fabmesh.com, rebuilds flash-attn/xformers,
> kaolin 0.16). La réalité livrée est ci-dessous.

Le moteur mesh par défaut (`trellis2_native`) a besoin de 5 extensions
CUDA compilées que pip ne peut PAS résoudre depuis PyPI
(`spconv-cu128` inclus — 404 sur PyPI). Elles sont livrées en wheels
pré-compilés **cp311 / win_amd64 / cu128 / torch 2.8** :

| Wheel | Version | Provenance |
|---|---|---|
| `o_voxel` | 0.0.1 | distribution ComfyUI-Trellis2 (Torch280) |
| `cumesh` | 1.0 | distribution ComfyUI-Trellis2 (Torch280) |
| `flex_gemm` | 0.0.1 | distribution ComfyUI-Trellis2 (Torch280) |
| `spconv_cu128` | 2.3.8 | build local sm_120 (traveller59/spconv) |
| `cumm_cu128` | 0.8.2 | build local sm_120 (traveller59/cumm) |

Les sha256 sont **bit-identiques** aux packages installés dans le venv
dev qui fonctionne (`external/TRELLIS2_win/.venv`, vérifié via les
`direct_url.json` des dist-info) et sont pinnés dans
`build/fetch_trellis2_wheels.py`.

## Hébergement

GitHub **prerelease** `trellis2-wheels-v1` du repo MyFabmesh
(prerelease exprès : jamais visible par le lookup `/releases/latest`
d'electron-updater) :

```
https://github.com/fabienlacaze/MyFabmesh/releases/download/trellis2-wheels-v1/<wheel>
```

## Flux d'installation

1. **Build de l'installeur** (dev ou CI) : `python build/fetch_trellis2_wheels.py`
   remplit `build/wheels/` (~17,5 Mo, sha256 vérifiés). electron-builder
   les copie via extraResources dans `<install>/resources/wheels/`.
2. **First-run wizard** (machine cliente) : `scripts/wizard_install_deps.py`
   installe torch 2.8.0+torchvision 0.23.0 (index cu128), kaolin 0.18.0
   (index NVIDIA torch-2.8.0_cu128), les packages PyPI, puis les 5 wheels :
   - source 1 : `FABMESH_WHEELS_DIR` (le dossier `resources/wheels` bundlé) ;
   - source 2 (fallback réseau) : URLs directes de la prerelease GitHub.
   Échec des deux = erreur explicite (le moteur par défaut ne peut pas
   tourner sans).

## Rebuild (uniquement si bump torch / Python / CUDA)

Cibles à respecter : Python 3.11 (embedded 3.11.9), CUDA 12.8,
torch 2.8.0+cu128, arch sm_120 incluse (Blackwell RTX 50xx).

- `o_voxel` : source dans `external/TRELLIS2_win/src/o-voxel` →
  `pip wheel . --no-deps` (VS 2022 Build Tools + CUDA 12.8 requis).
- `cumesh` / `flex_gemm` : reprendre les wheels de la distribution
  ComfyUI-Trellis2 pour la version torch cible, ou rebuild depuis les
  sources TRELLIS-2.
- `spconv` / `cumm` : suivre traveller59/spconv (build cumm d'abord),
  `CUMM_CUDA_ARCH_LIST` incluant `12.0`.

Après rebuild : uploader les wheels sur une nouvelle prerelease
(`trellis2-wheels-v2`, …), mettre à jour les sha256 + le tag dans
`build/fetch_trellis2_wheels.py` et `TRELLIS2_WHEELS_BASE` +
`TRELLIS2_WHEEL_FILES` dans `scripts/wizard_install_deps.py`.

## Notes

- **PAS de xformers ni flash-attn** dans l'env cible : le backend SDPA
  est autoritaire (env `ATTN_BACKEND=sdpa` forcé par main.js ; SAC
  bloque flash_attn_2_cuda.dll et le user interdit de désactiver SAC).
  Un xformers compilé pour un autre torch rétrograderait torch 2.8.
- `utils3d` : le paquet PyPI de ce nom est un HOMONYME différent — le
  vrai (EasternJournalist) est pinné par zip GitHub dans
  `wizard_install_deps.py`.
- Risque connu à tester : SAC (Smart App Control) peut bloquer des
  `.pyd` non signés téléchargés sur les machines clientes où SAC est
  actif. À valider lors du test d'install réel ~5 Go (item restant de
  la checklist packaging).
