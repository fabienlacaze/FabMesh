# MyFabmesh.AI — Roadmap

_Last updated: 2026-05-22_

> **Nom produit / brand marketing** : **MyFabmesh.AI** (le `.AI` fait partie du nom et signale immédiatement "AI product").
> **Nom court / technique** : MyFabmesh (utilisé dans le code, packagename, exe).
> **Domain primary** : `myfabmesh.ai` (~70€/an, à acheter dès qu'on a 50 ventes ~1100€).
> **Domain Phase 0 (zéro budget)** : `myfabmesh.itch.io` ou `myfabmesh.github.io` (gratuit).
> Tous les TLDs `myfabmesh.*` sont libres aujourd'hui : `.com .io .app .ai .fr`. Le `.com` sans préfixe (`fabmesh.com`) était squatté à 9985$ — on l'ignore.

## Vision produit (4 produits, 1 site)

| # | Produit | Cible | Prix | Ma marge |
|---|---|---|---|---|
| **P1** | **Desktop** (Electron + génération locale) | Devs/3D artists avec NVIDIA GPU 8 GB+ | 24,99 € one-shot | ~22 € (88-90% via Fab/itch/Gumroad) |
| **P2** | **Cloud** (génération hosted, crédits Stripe) | Mac, mobile, AMD, Intel, laptops | 0,20 €/mesh (5€ = 25 crédits) | ~50% après coût GPU Replicate/fal |
| **P3** | **Viewer 3D web** (preview/share, gratuit) | Acheteurs marketplace + funnel marketing | 0 € | Driver de trafic |
| **P4** | **Marketplace** (revente assets users, commission) | Vendeurs/acheteurs 3D | 15% par vente | Revenu passif |

---

## Stratégie de couverture marché

**Décision** : pas de port AMD/Intel/Mac en Desktop. Le Cloud couvre les 65% restants. Total = 100% du marché.

| Segment marché PC | % Steam HW Survey 2026 | Produit qui matche |
|---|---|---|
| NVIDIA ≥ 12 GB VRAM | ~15% | Desktop Full |
| NVIDIA 8-11 GB VRAM | ~20% | Desktop Standard/Lite |
| NVIDIA < 8 GB / GTX | ~15% | Cloud |
| AMD Radeon | ~15% | Cloud |
| Intel Arc / Iris Xe | ~10% | Cloud |
| Pas de dGPU / Mac | ~25% | Cloud |
| **Couverture totale** | **100%** | **Desktop 35% + Cloud 65%** |

### Spec minimum Desktop (à afficher en clair sur le site)

| Critère | Minimum | Recommandé |
|---|---|---|
| OS | Windows 10/11 64-bit | Windows 11 |
| GPU | NVIDIA RTX/GTX avec **8 GB VRAM** | RTX 4070/5070 ou supérieur, 12 GB+ |
| RAM | **16 GB** | 32 GB |
| Disque libre | 30 GB | 50 GB SSD |
| Internet | requis au premier lancement (~15-22 GB de modèles) | — |

**Pas supporté Desktop** (→ pousser vers Cloud) :
- AMD Radeon, Intel Arc, GPU intégrés
- macOS, Linux
- Moins de 8 GB VRAM
- Win 7 / 8 / 8.1

---

## Site myfabmesh.ai — structure

### Landing : 2 produits côte-à-côte

```
┌─ DESKTOP 24,99€ ─┐    ┌─ CLOUD 0,20€/mesh ─┐
│ NVIDIA GPU 8GB+   │    │ Any PC, Mac, mobile │
│ Windows 10/11     │    │ Web browser          │
│ Fastest, offline  │    │ No install needed    │
│ [Check my PC]     │    │ [Try 5 free credits] │
│ [Buy 24,99€]      │    │ [Buy credits]        │
└───────────────────┘    └──────────────────────┘
```

### Pages dédiées

1. `/` — Landing 2 produits + Compatibility checker CTA
2. `/desktop` — Specs en haut, screenshots, "Check compatibility" CTA, achat
3. `/cloud` — Pricing crédits, demo, signup
4. `/check` — Compatibility checker web (5 sec, browser-only)
5. `/v/<id>` — Viewer 3D public
6. `/market` — Marketplace (Phase 4)
7. `/faq` — Honest answers : "Why no AMD?", "Why no Mac?", "Why 16 GB RAM?"

### Compatibility checker — points-clés

- **Auto-détection browser** : GPU vendor + modèle (WebGL UNMASKED_RENDERER), OS, RAM (approx), CPU cores
- **Lookup DB GPU** : ~500 modèles connus → VRAM estimée
- **Verdict en 5 sec** :
  - ✓ Compatible Full → "Buy Desktop"
  - ⚠ Compatible Lite → "Buy Desktop (Lite mode)"
  - ✗ Incompatible → "Try Cloud instead"
- **Full diagnostic .exe** (5 MB, optionnel) pour les prudents

**Impact attendu** : refunds ÷ 5, support tickets ÷ 10, conversion incompatibles → Cloud +20-40%.

---

## Stack technique (commercial-safe)

### Modèles utilisés (tous open commercial)

| Brique | Modèle réel | Label public UI | Licence |
|---|---|---|---|
| Image-to-3D core | `microsoft/TRELLIS.2-4B` | FabMesh 3D Core | MIT |
| Texture / Inpaint | `SG161222/RealVisXL_V4.0` + `diffusers/SDXL-inpainting` | Texture engine / Face refiner | OpenRAIL++-M |
| Back-view | `xinsir/controlnet-openpose-sdxl-1.0` | Back-view module | Apache 2.0 |
| Reference cond | `h94/IP-Adapter` | Reference module | Apache 2.0 |
| Caption | `microsoft/Florence-2-large` + `Salesforce/blip-...` | Vision analyzer | MIT + BSD-3 |
| Upscale 8K | `RealESRGAN_x4plus` (xinntao) | Upscale engine | Apache 2.0 |

**Tous publics** sur HuggingFace, téléchargeables anonymement, sans login.

### Retirés (licence NC)

- ❌ Stable Fast 3D (Stability Community NC)
- ❌ TripoSR (Stability Community NC)
- ❌ BLIP-2 OPT (Meta OPT NC)
- ❌ Zero123++ (CC-BY-NC 4.0)

### Empaquetage Desktop

- **Electron** 31.7.7 + scripts Python embarqués
- **Python 3.11.9 portable** bundled (~30 MB, python.org)
- **VC++ 2022 Redistributable** bundled (~25 MB, silent install)
- **Wheels custom** (Phase 2+) Win+CUDA12+Py3.11 hébergés sur `wheels.myfabmesh.ai` (Cloudflare R2). Phase 1 = utilise les wheels officiels PyTorch/PyPI/GitHub direct, pas de R2 nécessaire.
- **PyPI direct** pour le reste (diffusers, transformers, hf_hub, etc.)
- **Modèles AI** téléchargés au premier lancement depuis HuggingFace (~15-22 GB)
- **Installer NSIS** ~150 MB → 22 GB après first-run setup

---

## Plan 0 € (Phase 0 : avant la 1ère vente)

**Principe** : zéro dépense jusqu'à la 1ère vente. Chaque dépense est débloquée par un palier de revenus.

| Dépense | Coût | Débloqué quand | Justification |
|---|---|---|---|
| Hosting site | 0 € | jamais | Vercel / GitHub Pages gratuit |
| Subdomain initial | 0 € | jamais | `myfabmesh.itch.io` ou `myfabmesh.github.io` gratuit |
| Distribution itch.io / Gumroad | 0 € | jamais | 10% pris seulement sur ventes |
| Marketing Reddit / Twitter / YouTube | 0 € | jamais | Build in public |
| `myfabmesh.com` (backup) | 12 €/an | 5 ventes (~110 €) | Sécurise le `.com` (et redirige vers `.ai`) |
| `myfabmesh.app` (backup) | 14 €/an | 10 ventes (~220 €) | Sécurise le `.app` |
| **Azure Trusted Signing** (recommandé) | ~110 €/an | 15 ventes (~330 €) | Signature acceptée nativement par Windows Smart App Control + SmartScreen. La seule voie légitime sans bypass user pour Win11 récent. |
| Sectigo EV (alternative) | ~330 €/an | 25 ventes (~550 €) | Token USB physique, accepté Smart App Control après réputation building |
| **`myfabmesh.ai` (domain principal)** | 70 €/an | 30 ventes (~660 €) | Brand officielle : "MyFabmesh.AI" |
| Dépôt INPI marque "MyFabmesh.AI" | 190 € (one-shot) | 50 ventes (~1100 €) | Protège juridiquement |
| Cloud GPU (Replicate setup) | ~30 €/mois fixe | 100 ventes (~2200 €) | Lance le produit P2 |

### Le problème Windows Defender sans code signing

Tant que le cert n'est pas acheté, au double-clic de `MyFabmesh-Setup-1.0.0.exe` Windows affiche :

```
Windows protected your PC
Microsoft Defender SmartScreen prevented an unrecognized app
from starting.
[ More info ]  [ Don't run ]
```

→ ~30% des users abandonnent ici. Les 70% qui cliquent "More info → Run anyway" passent.

**Mitigation gratuite** :
1. FAQ avec screenshot expliquant l'étape
2. Vidéo YouTube "Comment installer MyFabmesh" qui montre l'étape
3. SmartScreen apprend automatiquement après ~3 000 downloads — la warning disparaît d'elle-même

**Achète le cert quand 200 € de revenus** = ROI quasi immédiat (+30% de conversion sur les ventes futures).

### Distribution gratuite jour 1

| Channel | Cut | Setup | Audience |
|---|---|---|---|
| **itch.io** | 10% (ajustable 0-30%) | live en 1h | Indés / expérimentateurs |
| **Gumroad** | 10% + 0,30 € / sale | live en 30 min | Audience Twitter / YouTube |
| **Fab.com** (Epic) | 12% | review 7-14 jours | Devs Unreal (gros marché) |

→ Les 3 en parallèle dès jour 1. itch.io + Gumroad servent de "pop-up store" pendant que la review Fab.com s'écrit.

---

## Roadmap 7 mois

### MOIS 0 — Préparation diffusion (semaines 1-2)

- [ ] (Phase 0 zéro budget) Subdomain `myfabmesh.itch.io` ou `myfabmesh.github.io` gratuit
- [ ] (À débloquer dès 30 ventes) Acheter `myfabmesh.ai` (70€/an, domain principal)
- [ ] (À débloquer dès 5 ventes) Acheter `myfabmesh.com` en backup (12€/an, redirige vers `.ai`)
- [ ] Landing "Coming soon" + capture email
- [ ] Comptes Twitter/X, Bluesky, YouTube, Discord
- [ ] Logo + brand colors + identité Figma
- [ ] Identité légale (auto-entreprise)

### MOIS 1 — Build in public + finalisation Desktop (semaines 3-6)

**Produit P1 (Desktop)** — déjà à 80% :
- [x] Wizard d'installation 5 étapes
- [x] Hardware detection automatique
- [x] HF token fallback dans wizard_download.py
- [x] Boutons Cancel + Reconfigure + Uninstall
- [x] electron-builder NSIS + installer prototype généré
- [x] Packaging skeleton (Python embed, VC redist, scripts)
- [ ] Compiler wheels custom sur GitHub Actions Windows + CUDA 12.8
- [ ] Pousser wheels sur Cloudflare R2 (`wheels.myfabmesh.com`)
- [ ] Générer token HF read-only + coller dans `HF_FALLBACK_TOKEN`
- [ ] Code signing certificate Sectigo (~200€/an)
- [ ] Tests sur 8 machines variées
- [ ] Icon final (remplacer placeholder)

**Site myfabmesh.ai** (ou subdomain itch/github en Phase 0) :
- [ ] Landing 2 produits côte-à-côte
- [ ] Page `/desktop` avec specs visibles
- [ ] Compatibility checker web `/check`
- [ ] Binaire diagnostic .exe (5 MB Go)

**Diffusion (build in public)** :
- [ ] 3-5 posts/semaine Twitter/X
- [ ] 1 post Reddit ciblé/semaine
- [ ] 2 vidéos YouTube
- [ ] Outreach 20 YouTubers

**KPI fin mois 1** : 500-1500 emails, installer testé sur 8 machines, site live.

### MOIS 2 — Beta privée (semaines 7-8)

- [ ] Listing Gumroad unlisted à 12,99€
- [ ] Discord #beta-feedback
- [ ] 1 patch tous les 2-3 jours
- [ ] Bandeau "Not compatible? → Cloud" sur pages Desktop

**KPI fin mois 2** : 30-80 ventes beta (~400-1000€), 5-10 témoignages.

### MOIS 3 — Public launch Desktop + dev Cloud

- [ ] Listings live Fab/itch/Gumroad/myfabmesh.ai (24,99€)
- [ ] electron-updater
- [ ] Product Hunt + HN + Reddit blast coordonné
- [ ] Cloud P2 : déploiement TRELLIS-2 + SDXL sur Replicate
- [ ] FAQ détaillée

**KPI fin mois 3** : 100-500 ventes Desktop, 2-12k€ revenue.

### MOIS 4 — Croissance + dev Cloud

- [ ] Frontend web Cloud (signup, dashboard, Stripe crédits)
- [ ] Cloudflare R2 stockage GLB
- [ ] Tutos YouTube + Blog SEO
- [ ] Programme affiliés (15% commission)

**KPI fin mois 4** : 3-8k€/mois récurrent.

### MOIS 5 — Launch Cloud + Viewer

- [ ] Email tous Desktop : "Cloud + 50 free credits"
- [ ] Cross-promo Desktop ↔ Cloud auto
- [ ] Viewer 3D web (Three.js + URL partagée)
- [ ] Localisation FR + DE + ZH

**KPI fin mois 5** : 100-300 Cloud users.

### MOIS 6 — Marketplace MVP

- [ ] Upload mesh + browse + Stripe Connect (split 85/15)
- [ ] Seed 200-300 assets persos
- [ ] Inviter 10 créateurs externes

**KPI fin mois 6** : marketplace 300+ assets, 30-80 ventes/mois.

### MOIS 7+ — Crosselling + scale

- [ ] Promo croisée Desktop ↔ Cloud ↔ Market
- [ ] Affiliés ramp-up
- [ ] Bumper Electron 31 → 35 LTS
- [ ] macOS/Linux releases (Cloud uniquement)

---

## Budget infra & revenus médians

| Mois | Coûts cumulés | Revenu cumulé | Net |
|---|---|---|---|
| M0 | 200 € | 0 € | -200 € |
| M1 | 450 € | 0 € | -450 € |
| M2 | 500 € | 500 € | 0 € |
| M3 | 600 € | 4 000 € | +3 400 € |
| M4 | 750 € | 9 000 € | +8 250 € |
| M5 | 900 € | 15 000 € | +14 100 € |
| M6 | 1 100 € | 23 000 € | +21 900 € |
| M7 | 1 300 € | 33 000 € | +31 700 € |

Hypothèses médianes. Pessimiste ÷ 3, optimiste × 3.

---

## État actuel (2026-05-22)

### ✅ Livré

- Wizard 5 étapes fonctionnel
- Hardware detection auto + couleurs vert/orange/rouge
- 3 modes : Full / Standard / Lite (Cloud-only retiré, redirige myfabmesh.ai/cloud)
- Bouton Cancel cancel-safe (backup `setup_state.json`)
- Reconfigure + Uninstall dans Settings
- UI complètement anonymisée (FabMesh 3D Core, Texture engine, etc.)
- Heartbeat download avec timer + pulse
- HF token fallback
- Installer NSIS prototype généré (`dist/installer/FabMesh-Setup-1.0.0.exe`, 142 MB)
- Python 3.11.9 portable + VC++ 2022 redist bundled
- Workflow GitHub Actions pour les wheels custom
- 2 audits sécurité passés

### 🚧 À faire avant release

| # | Item | Effort | Priorité |
|---|---|---|---|
| 1 | Compiler wheels custom sur GH Actions + R2 hosting | 3-4 jours | Bloquant |
| 2 | Générer token HF read-only | 5 min | Important |
| 3 | Code signing cert Sectigo | 2 jours + 200€/an | Bloquant |
| 4 | Landing myfabmesh.ai (ou itch.io Phase 0) 2 produits | 2 jours | Bloquant |
| 5 | Compatibility checker web | 1 semaine | Bloquant |
| 6 | Icon final | 1 jour | Cosmétique |
| 7 | Tests sur 8 machines variées | 1 semaine | Bloquant |
| 8 | Page produit Desktop + FAQ | 2 jours | Bloquant |
| 9 | Trailer YouTube 90s | 2 jours | Important |
| 10 | Beta privée Gumroad unlisted | 1 jour | Important |

**Total avant public release** : ~4-5 semaines solo.

---

## Décisions clés (NEW 2026-05-22)

1. **Pas de port DirectML/AMD pour Desktop.** Le Cloud couvre les non-NVIDIA. Économise 2-3 mois.
2. **Pas de mode Ultra-Lite avec quantization int8.** Trop d'effort, qualité dégradée, le Cloud fait mieux.
3. **Communiquer franchement les requirements sur le site.** "Built for serious creators with NVIDIA GPUs" → positionnement premium.
4. **Compatibility checker obligatoire avant achat Desktop.** Refunds ÷ 5, tickets support ÷ 10.
5. **Pas de Steam.** Cible = devs Unreal/Blender via Fab.com (12% cut), itch.io (10%), Gumroad (10%).
6. **Build in public.** 3-5 posts/semaine, 60 jours d'audience avant launch.

---

## Risques connus & mitigations

| Risque | Probabilité | Mitigation |
|---|---|---|
| HF rate-limit anonyme | Faible | Token fallback embedded |
| HF retire un modèle | Très faible | Mirror R2 backup en Phase 2 |
| Antivirus tiers tue l'app | Moyen | FAQ + suggestion exclusion |
| Concurrence (Meshy, Tripo) | Moyen-élevé | On commercialise vs eux limitent free tier |
| Refunds > 10% | Possible sans checker | Checker obligatoire avant achat |
| Pas de traction | Possible | Build in public 60 jours |

---

## Annexes

- [AGENT_LOG.md](AGENT_LOG.md) — Journal détaillé
- [build/README.md](build/README.md) — Setup machine dev
- [build/build_wheels.md](build/build_wheels.md) — Compilation wheels
- [CLAUDE.md](CLAUDE.md) — Instructions sessions Claude Code
