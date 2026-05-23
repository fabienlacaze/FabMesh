# MyFabmesh.AI Cloud — Architecture

> Public-facing SaaS for users without an NVIDIA GPU. Same engine,
> same quality, runs on cloud GPU. Pay-as-you-go credits. Phase 2
> of the product (Desktop = Phase 1).

---

## 1. Why Cloud now

| Segment | Desktop reach | Cloud closes the gap |
|---|---|---|
| NVIDIA ≥ 8 GB VRAM (~35%) | ✅ | — |
| NVIDIA < 8 GB (~15%) | ❌ | ✅ |
| AMD Radeon (~15%) | ❌ | ✅ |
| Intel Arc / iGPU (~10%) | ❌ | ✅ |
| Mac / Linux / mobile (~25%) | ❌ | ✅ |
| **Total marché PC** | 35% | **+65% = 100%** |

Sans Cloud, on plafonne à 35% du marché. C'est suffisant pour valider
la Phase 1 (revenu Desktop pur), mais le ceiling est atteint vite.
Cloud = expansion naturelle dès que Desktop a sa traction.

---

## 2. Stack technique cible

```
┌─────────────────────────────────────────────────────────────┐
│  USER BROWSER  (Chrome / Safari / Edge / mobile)            │
│  • Upload image                                              │
│  • Voir progress + 3D viewer (three.js)                      │
│  • Acheter crédits, voir historique                         │
└──────────────┬──────────────────────────────────────────────┘
               │ HTTPS
               ▼
┌─────────────────────────────────────────────────────────────┐
│  FRONTEND  (Next.js 15 sur Cloudflare Pages, free)          │
│  • Static SSR + edge functions                               │
│  • Auth widget (Supabase)                                    │
│  • Stripe Checkout embed                                     │
└──────────────┬──────────────────────────────────────────────┘
               │ tRPC / REST
               ▼
┌─────────────────────────────────────────────────────────────┐
│  API EDGE  (Cloudflare Workers, free tier 100k req/day)     │
│  • POST /generate   → valide crédits, déclenche job          │
│  • GET  /jobs/:id   → status + URL résultat                  │
│  • POST /stripe-webhook → crédite l'user                     │
└──────────────┬─────────────────────────┬────────────────────┘
               │                         │
               ▼                         ▼
┌──────────────────────────┐  ┌──────────────────────────────┐
│ POSTGRES (Supabase free) │  │ GPU PROVIDER (Replicate)     │
│ • users / credits        │  │ • notre Cog TRELLIS-2-4B     │
│ • jobs / generations     │  │ • pay per inference          │
│ • stripe_events          │  │ • renvoie GLB                │
└──────────────────────────┘  └────────────┬─────────────────┘
                                            │
                                            ▼
                              ┌──────────────────────────────┐
                              │ CLOUDFLARE R2 (10 GB free)   │
                              │ • stockage GLB générés        │
                              │ • CDN gratuit pour download   │
                              │ • TTL 30 jours par défaut     │
                              └──────────────────────────────┘
```

### Choix justifiés

| Brique | Choix | Pourquoi pas l'alternative |
|---|---|---|
| Frontend hosting | Cloudflare Pages (free) | Vercel free est OK aussi, mais CF Workers + R2 forment un stack cohérent |
| Auth | Supabase (free 50k MAU) | Clerk = payant dès 1k MAU, Auth0 cher. Supabase OSS, exportable |
| DB | Supabase Postgres (free 500 MB) | Neon OK mais Supabase fournit auth+DB en 1 produit |
| Storage | Cloudflare R2 (10 GB / mois free egress) | S3 = egress facturée même pour CDN, plus cher |
| GPU | Replicate avec notre Cog | fal.ai cher; Modal config OK mais coût équivalent; Azure VM = $1.5/h idle, perdant en phase 0 |
| Paiement | Stripe Checkout | Pas d'alternative crédible pour SaaS B2C en EU |
| Edge API | Cloudflare Workers (free 100k/day) | Vercel functions = limite 10s, Workers = 30s par défaut |

---

## 3. Coût par génération

Décomposition d'une génération à $0.20 prix de vente :

| Item | Coût | Marge |
|---|---|---|
| GPU inference (Replicate L40S, ~60s) | $0.07 - $0.10 | — |
| R2 storage (40 MB GLB × 30 days) | $0.001 | — |
| R2 egress (1 download par mesh) | $0.005 | — |
| Cloudflare Workers + DB | quasi nul | — |
| Stripe fees (1.4% + 0.25€ EU) | $0.05 par tx | — |
| **Total coût** | **~$0.13** | — |
| **Prix de vente** | **$0.20** | **35% marge brute** |

Marge nette plus fine à cause des fixed costs (Cloudflare 0€, Supabase
0€ tant qu'on est en tier gratuit). Au-delà de ~500 users payants, on
passera en tier payant Supabase (~$25/mo) ce qui dilue la marge.

### Pricing tiers proposés

| Plan | Prix | Crédits | Coût/mesh effectif |
|---|---|---|---|
| Pay-as-you-go | 5 € | 25 crédits | 0,20 € |
| Pay-as-you-go | 20 € | 120 crédits | 0,17 € (-15%) |
| Pay-as-you-go | 50 € | 350 crédits | 0,14 € (-30%) |
| **Mensuel Pro** (à débloquer) | 15 €/mo | 250 crédits | 0,06 € |

Le mensuel arrive en phase 2 — il faut d'abord valider la demande au
prix spot.

---

## 4. Plan d'implémentation par jalons

### Jalon 0 — Validation rapide (1 jour)
- [ ] Tester `firtoz/trellis` sur Replicate (TRELLIS-1, déjà déployé)
- [ ] Mesurer qualité, latence, coût exact par run
- [ ] Confirmer que l'API marche bien pour notre cas
- [ ] Décision : firtoz/trellis (TRELLIS-1, 1.2B) ou déployer notre Cog TRELLIS-2-4B

**Décision attendue** : utiliser firtoz/trellis pour le POC, déployer
notre propre Cog TRELLIS-2-4B en parallèle si la qualité TRELLIS-1
n'est pas suffisante.

### Jalon 1 — POC backend (~3 jours)
- [ ] Repo séparé `myfabmesh-cloud` ou monorepo
- [ ] Worker Cloudflare avec route `/generate` qui call Replicate
- [ ] Stockage temporaire R2 du résultat
- [ ] Auth dev (token statique) pour les premiers tests

### Jalon 2 — Web app squelette (~3 jours)
- [ ] Next.js 15 app router
- [ ] Page upload image + bouton Generate
- [ ] Polling status job
- [ ] Viewer 3D avec @google/model-viewer (déjà connu, utilisé sur le Desktop)
- [ ] Page historique des generations

### Jalon 3 — Auth + Stripe (~3 jours)
- [ ] Supabase project setup (auth + DB schema)
- [ ] Stripe Checkout pour acheter crédits
- [ ] Webhook Stripe → décrémenter crédits à chaque génération
- [ ] Politique : 5 crédits gratuits à l'inscription

### Jalon 4 — Production (~2 jours)
- [ ] Déploiement Cloudflare Pages + Workers
- [ ] Domain `cloud.myfabmesh.ai` (sub-domain du domaine principal)
- [ ] Monitoring (Sentry partagé avec Desktop)
- [ ] Rate limit anti-abus (10 gen/h par IP sans compte)

### Jalon 5 — Intégration cross-produits (~2 jours)
- [ ] Bouton "Try Cloud" dans le Desktop wizard quand GPU non détecté
- [ ] Login SSO partagé Desktop ↔ Cloud
- [ ] Synchronisation projets (optionnel, Phase 3)

**Total : ~13 jours de dev pour un Cloud MVP prêt à monétiser.**

---

## 5. Comptes à créer (par toi, avant que je code)

| # | Service | Quand | Coût immédiat |
|---|---|---|---|
| 1 | **Replicate** | Avant Jalon 0 | 0€ (5$ de credit offert) |
| 2 | **Supabase** | Avant Jalon 3 | 0€ (free tier 50k MAU) |
| 3 | **Cloudflare** | Avant Jalon 4 | 0€ (Pages + R2 + Workers free) |
| 4 | **Stripe** | Avant Jalon 3 | 0€ setup, 1.4% + 0.25€/tx |
| 5 | Domain `myfabmesh.ai` | Avant Jalon 4 (optionnel) | ~70€/an |

Tu peux créer Replicate maintenant pour qu'on attaque le Jalon 0.

### Setup Replicate (5 min)

1. https://replicate.com/signin (login GitHub possible)
2. Settings → API Tokens → Copy
3. Colle-moi le token (read+write) → je l'utilise pour le POC. Sera
   migré vers `build/replicate-token.txt` (gitignored) puis utilisé
   par le worker Cloudflare en variable d'environnement quand on
   passe en prod.

### Variables d'env à prévoir (worker production)

```
REPLICATE_API_TOKEN=r8_...
SUPABASE_URL=https://....supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
R2_BUCKET_NAME=myfabmesh-cloud-meshes
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
SENTRY_DSN=...   # peut réutiliser le projet myfabmesh-ai-desktop ou un projet séparé "myfabmesh-cloud"
```

---

## 6. Différenciateur Cloud vs Desktop

Le Cloud n'est PAS une version dégradée. Il offre des choses que le
Desktop ne peut pas faire :

| Avantage | Cloud | Desktop |
|---|---|---|
| Marche sur Mac / Linux / mobile | ✅ | ❌ |
| Marche sans GPU dédié | ✅ | ❌ |
| Pas d'install, pas de download | ✅ | ❌ |
| 5 crédits gratuits pour tester | ✅ | ❌ |
| Génération en arrière-plan (l'user ferme l'onglet) | ✅ | ❌ |
| Aucune limite VRAM (toujours mode Full) | ✅ | dépend du GPU local |
| Coût marginal par génération | $0.20 | $0 |
| Disponibilité hors-ligne | ❌ | ✅ |
| Unlimited generations à coût marginal nul | ❌ | ✅ |

**Pitch unifié** : Desktop pour les power users avec NVIDIA, Cloud
pour le reste du monde. Même qualité, même engine.

---

## 7. Risques connus

| Risque | Mitigation |
|---|---|
| Coût Replicate explose si beaucoup d'usage | Rate limit + monitoring, switch to fal.ai ou Modal si meilleur prix |
| Replicate retire firtoz/trellis | Déploiement de notre propre Cog en backup |
| Supabase tier gratuit dépassé | Passage payant à ~500 users actifs, ~$25/mo |
| Cloudflare R2 free egress dépassé | $0.36/GB après les 10 GB free, manageable |
| Abus (free 5 credits exploités via fake accounts) | Email verification + Stripe fingerprint (gratuit) |
| Latence générations multi-minutes | Job async + email/webhook quand prêt, UX patience |

---

## 8. Décisions explicites prises

1. **Pas d'API publique pour les devs en Phase 0** — la valeur c'est l'UX, on ne se concurrence pas avec Replicate
2. **Pas de free tier illimité** — 5 crédits gratuits, après faut payer
3. **Sub-domain `cloud.myfabmesh.ai`** — pas un domain séparé
4. **Stripe pour le paiement, pas Gumroad** — le SaaS demande Stripe (subscriptions futures, webhooks)
5. **Politique no-refund sur crédits non utilisés** — sauf bug de service prouvé
6. **GLB générés stockés 30 jours puis purgés** — l'user re-télécharge s'il veut garder
7. **EU AI Act compliance** : même metadata `aiGenerated=true` que Desktop

---

## 9. Prochaine étape pour TOI

1. Crée le compte Replicate (5 min) → https://replicate.com/signin
2. Settings → API tokens → copie le token (commence par `r8_`)
3. Colle-moi le token ici (ou place-le dans `build/replicate-token.txt`)
4. Je lance le POC Jalon 0 immédiatement (test firtoz/trellis depuis Python)
