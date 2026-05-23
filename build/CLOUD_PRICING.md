# MyFabmesh.AI Cloud — Stratégie coûts & pricing

> **Reality check du 2026-05-23** : POC fishwowater/trellis2 → **$0.33** pour 238 s
> sur A100 80GB. Trop cher. Notre Cog vise **$0.06-0.10** par mesh standard.

---

## 1. Coût Replicate par GPU

| GPU              | VRAM    | $/s        | $ / 100 s | Vitesse rel. | Usage                          |
|------------------|---------|------------|-----------|--------------|--------------------------------|
| T4               | 16 GB   | $0.000225  | $0.023    | 0.3×         | Trop juste pour TRELLIS-2      |
| L4               | 24 GB   | $0.000400  | $0.040    | 0.6×         | OK lite seulement              |
| **L40S**         | 48 GB   | $0.000725  | $0.073    | 0.85×        | **Default éco (lite/std)**     |
| A100 40GB        | 40 GB   | $0.001150  | $0.115    | 1.0×         | Inutile (L40S moins cher)      |
| A100 80GB        | 80 GB   | $0.001400  | $0.140    | 1.0×         | Cher ET pas plus rapide → jamais|
| **H100**         | 80 GB   | $0.001528  | $0.153    | **~1.8×**    | **Mode "Fast" premium**        |

**Insight clé** : H100 est ~1.8× plus rapide que A100 sur les diffusion
models (TRELLIS-2 → 50-60 s warm au lieu de 90-110 s). Coût final
quasi-identique au L40S (car 1.8× plus rapide compense le $/s),
mais l'utilisateur ressent la rapidité. Donc :

- **L40S** = optim coût (économique, par défaut)
- **H100** = optim latence (mode "Fast" payant +1 crédit)
- **A100** = ni l'un ni l'autre → ne jamais sélectionner

## 2. Coût attendu par mode (sur L40S, warm container)

| Mode      | Pipeline                                       | Durée | Coût L40S | Coût A100 80GB |
|-----------|------------------------------------------------|-------|-----------|----------------|
| **lite**  | trellis2 1024 + smooth                         | ~80 s | **$0.06** | $0.11          |
| **standard** | + rectify + back-view + smooth              | ~140 s| **$0.10** | $0.20          |
| **full**  | + cascade 1536 + face_fix + ultra_hd 8K        | ~280 s| **$0.20** | $0.39          |

Cold start (premier appel après >10 min idle) = +30 s, soit +$0.02 (L40S).

## 3. Pricing crédits (cash-positive)

| Pack       | Prix  | Crédits | Coût/mesh user | Notre marge mode std | Marge mode full |
|------------|-------|---------|----------------|----------------------|-----------------|
| Starter    | 5 €   | 25      | 0.20 €         | 100 %                | 0 % (perte)     |
| **Pro** ⭐ | 20 €  | 120     | 0.17 €         | 70 %                 | -15 %           |
| Studio     | 50 €  | 350     | 0.14 €         | 40 %                 | -30 %           |

**Règle : 1 mesh standard = 1 crédit, 1 mesh full = 2 crédits.** Force le user
qui veut la qualité maximale à payer 2× — il consomme 2× plus de GPU.

**Pas de free tier** (sauf 1 mesh démo unique par compte vérifié email).

## 4. Leviers d'optimisation immédiats

1. **L40S forcé** dans le dashboard Replicate (pas A100). Cf. cog.yaml.
2. **Mode lite par défaut**, switcher mode dans l'UI doit indiquer le coût en crédits.
3. **Pas de cascade** sauf mode full explicite. Cascade = 2× passes TRELLIS-2.
4. **Steps par défaut bas** : sparse_structure_steps=8 (vs 12 du POC), shape_slat=8, tex_slat=8.
   Test visuel desktop a montré que >10 = diminishing returns.
5. **Texture_size adaptatif** : 1024 par défaut, 2048 en option, 4096 = full mode only.
6. **Skip rectify si asset_type=prop / custom** : ces catégories ne profitent pas du front-view canonical.

## 5. Métriques à instrumenter (Phase 1 v0.2)

```
mesh.gen.duration_s     histogram, par mode + asset_type
mesh.gen.cost_usd       histogram, calculé via duration * gpu_rate
mesh.gen.success_rate   counter
mesh.gen.cold_start_ratio  → si > 30 %, augmenter le min_instances
```

Si on dépasse une certaine consommation Replicate (~50 gen/heure soutenu)
on bascule sur **Replicate Deployments avec min_instances=1** : un GPU
réservé H24 à $50/jour, mais coût marginal /gen ≈ 0 → break-even à ~500
gen/jour.

## 6. Alternatives si Replicate trop cher

| Provider     | $/h L40S équiv | Cold start | Verdict                                |
|--------------|----------------|------------|----------------------------------------|
| Replicate    | $2.61          | 30 s       | Default, simple                        |
| fal.ai       | $2.60          | 5 s        | Plus rapide cold start                 |
| Modal.com    | $1.96          | 10 s       | -25 % mais setup plus complexe         |
| RunPod       | $1.49          | 60 s       | Le moins cher, mais infra à gérer      |
| Self-hosted RTX 4090 | $0 (~150€/mo électricité)|0s| Phase 2+ quand volume justifie    |

**Phase 0** : on reste sur Replicate (le plus simple), on optimise via L40S
+ steps réduits + cache aggressif.
