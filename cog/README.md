# MyFabmesh.AI Cloud — Cog deployment

Ce dossier contient le **packaging Replicate** de notre pipeline 3D
complet. Déployé sur Replicate, il devient le moteur du produit
**Cloud** (P2). Output strictement équivalent au Desktop.

---

## Pré-requis (à installer une fois)

```bash
# Cog CLI (tool de Replicate pour build + push)
# https://github.com/replicate/cog
sudo curl -o /usr/local/bin/cog -L https://github.com/replicate/cog/releases/latest/download/cog_$(uname -s)_$(uname -m)
sudo chmod +x /usr/local/bin/cog
```

Sur Windows, utilise WSL2 (Cog ne tourne pas natif Windows). Ou utilise
**Replicate Push Service** via leur web UI si tu veux éviter WSL.

---

## Build local + test

```bash
cd cog/

# Build l'image Docker (longue : 20-40 min la première fois,
# ~5 GB de dépendances PyTorch / CUDA / etc.)
cog build -t myfabmesh-cloud

# Test local avec une image
cog predict \
    -i image=@../images/voiture_de_course/ref_0.png \
    -i asset_type=vehicle \
    -i mode=standard \
    -i seed=42
# → produit un GLB dans output.glb
```

⚠️ **Cog local exige Docker Desktop + nvidia-container-toolkit**.
Sans GPU local, le test échoue. Tu peux skip et push direct sur
Replicate (ils ont les GPUs).

---

## Push sur Replicate

```bash
# Login
cog login

# Crée le model sur Replicate (une fois)
# https://replicate.com/create
# → owner = fabienlacaze
# → name = myfabmesh-cloud
# → visibility = private (recommandé en Phase 0)

# Push
cog push r8.im/fabienlacaze/myfabmesh-cloud
```

→ Replicate construit l'image Docker sur leurs serveurs (~30 min de
build) et l'héberge. Le model devient appelable via leur API.

---

## Appel depuis le frontend Cloud

```typescript
// api/generate.ts (Cloudflare Worker)
import Replicate from 'replicate';

const replicate = new Replicate({ auth: env.REPLICATE_API_TOKEN });

const output = await replicate.run(
  "fabienlacaze/myfabmesh-cloud",
  {
    input: {
      image: imageBlob,
      asset_type: "character",
      mode: "standard",
      seed: 42,
      rectify: true,
      back_view: true,
      smooth: true,
      face_fix: false,
      ultra_hd: false,
    },
  }
);

// `output` = URL du GLB. On le copie sur notre R2 pour service au user.
```

---

## Versionnage

Chaque `cog push` crée une nouvelle version (hash unique). Replicate
garde TOUTES les versions, donc les requêtes en cours sur l'ancienne
version finissent proprement avant qu'on switche le frontend sur la
nouvelle.

Pour pinner une version :
```typescript
replicate.run("fabienlacaze/myfabmesh-cloud:abc123def456", ...);
```

---

## Coût d'hébergement Replicate

| Item | Coût |
|---|---|
| Storage du model (image Docker ~12 GB) | 0 € (gratuit) |
| Build time (par push) | 0 € |
| Cold start si pas d'inference depuis 10 min | 0 € (gratuit, ~30s) |
| Inference (par seconde de GPU) | ~$0.0007/s L40S |
| Per-prediction (typical 80-120s) | **~$0.06-0.10** |

Donc tant qu'on n'a pas de traffic = **0 € hosting**.

---

## Updates de version

Quand on améliore le pipeline (nouveau Cog) :

1. Edit `predict.py` et / ou les `scripts/*.py` du parent repo
2. `cog push r8.im/fabienlacaze/myfabmesh-cloud`
3. Replicate build la nouvelle version (~30 min)
4. Le frontend pointe automatiquement sur la dernière version
   (sauf si on a pinned un hash spécifique)

---

## Pourquoi notre Cog plutôt que `fishwowater/trellis2`

| Critère | fishwowater/trellis2 | NOTRE Cog |
|---|---|---|
| Vrai TRELLIS-2 | ✅ oui | ✅ oui |
| Auto-rectify (front/iso) | ❌ | ✅ |
| Back-view generation | ❌ | ✅ |
| Face inpaint | ❌ | ✅ |
| Texture smooth | ❌ | ✅ |
| 8K Ultra HD upscale | ❌ | ✅ |
| Asset-type-aware pipeline | ❌ | ✅ |
| Branding URL | replicate.com/fishwowater | replicate.com/fabienlacaze/myfabmesh-cloud |
| Dépendance sur un tiers | ✅ (risque qu'il disparaisse) | ❌ (on contrôle) |

→ Le Cloud est UNIQUE et cohérent avec le Desktop. Pas une copie
discount du modèle de quelqu'un d'autre.
