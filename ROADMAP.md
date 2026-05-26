# MyFabmesh.AI — Roadmap

_Last updated: 2026-05-24_

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

## État actuel (2026-05-24)

### ✅ Cloud P2 — scaffold complet + stratégie "renderer port" (2026-05-23 → 24)

**Décision architecture** : le Cloud N'est PAS un site séparé avec sa propre UI.
C'est **une copie conforme du renderer Electron desktop** (HTML/CSS/JS exactement
les mêmes fichiers source), où les IPC Electron sont remplacés par fetch HTTP.

```
┌────────────────────────────────────┐    ┌────────────────────────────────────┐
│ DESKTOP (Electron)                 │    │ CLOUD (Next.js + Cloudflare Pages) │
│ src/renderer/index2.html ──┐      │    │ cloud/public/app/index.html        │
│ src/renderer/index2.js      │      │    │   ← copie identique                │
│ src/renderer/styles/*.css   │      │    │                                    │
│                              │      │    │ cloud/public/app/meshyAPI-cloud.js │
│ window.meshyAPI = IPC bridge ┘      │    │   ← remplace IPC par fetch HTTP    │
│   ↓                                 │    │   ↓                                │
│ ipcRenderer.invoke('image-to-3d')   │    │ fetch('/api/generate')             │
│   ↓                                 │    │   ↓                                │
│ Python local (TRELLIS-2)            │    │ Replicate Cog (GPU L40S/H100)      │
└────────────────────────────────────┘    └────────────────────────────────────┘
```

**Pourquoi** : 1 source de vérité UI. Quand l'utilisateur modifie une option dans
l'app desktop, le cloud suit automatiquement (script `npm run sync-app`).
Zéro divergence UX/UI entre les 2 versions. Cohérence de marque parfaite.

**Livré** :
- POC Replicate via `fishwowater/trellis2` : 481 s pour $0.33 (A100 80GB). Mesh
  voiture reconnaissable mais qualité moyenne → confirme valeur ajoutée
  de notre pipeline complet (rectify + back-view + smooth).
- `cog/predict.py` refactorisé subprocess pour notre Cog Replicate
  `r8.im/fabienlacaze/myfabmesh-cloud` (push WSL+Docker à faire).
- `cog/cog.yaml` documente choix L40S (au lieu d'A100 default = -48% coût).
- `build/CLOUD_PRICING.md` : stratégie GPU L40S économique / H100 "Fast mode" premium.
- `cloud/` Next.js 15 scaffold complet (3 services externes wirés + R2 + Stripe).
- `cloud/sql/schema.sql` : profiles + jobs + payments + RPCs atomiques credits + RLS.
- `cloud/scripts/supabase-setup.mjs` : auto-provisioning (PAT → create project →
  push schema → wire .env).
- `cloud/scripts/setup-prod.ps1` : wizard PowerShell pour Stripe + R2 + Cloudflare.
- `cloud/GOING_LIVE.md` : checklist 5 actions humaines (créer comptes Supabase,
  Stripe, Cloudflare, KYC Stripe live, Docker Desktop pour cog push).
- **Mode MOCK** : in-memory store + 50 crédits offerts + sample GLB fake →
  permet de tester tout le flow user **sans aucun signup externe**.

### 🚧 Cloud P2 — en cours (2026-05-24)

- Portage du renderer desktop dans `cloud/public/app/` (in progress)
- Shim `meshyAPI-cloud.js` : 115 IPC mappés (15 implémentés, 100 stubs gracieux)
- Routes API server : `/api/generate`, `/api/jobs/[id]`, `/api/me`, `/api/projects`
- Persistance projets : Supabase table `projects` (en plus de `jobs`)

### ✅ Desktop Beta v1.0.0 — prête techniquement :
- Wizard 5 étapes fonctionnel + auto-detect installation existante
- Hardware detection auto + couleurs vert/orange/rouge
- 3 modes : Full / Standard / Lite
- Bouton Cancel cancel-safe (backup `setup_state.json`)
- Reconfigure + Uninstall dans Settings
- Branding MyFabmesh.AI complet (UI anonymisée des noms HF/modèles)
- Heartbeat download avec timer + pulse
- HF token fallback via sidecar gitignored bundlé en `extraResources`
- Installer NSIS `MyFabmesh.AI-Setup-1.0.0.exe` (146 MB) live sur GitHub Release v1.0.0-beta
- Python 3.11.9 portable + VC++ 2022 redist bundled
- Sentry crash reporting wired (DSN sidecar bundlé, projet `myfabmesh-ai-desktop` dans org `fabienlacaze`)
- electron-updater wired → GitHub Releases (`publish` provider configuré, `latest.yml` généré au build)
- Toast update + modal About / Help dans l'app
- Site web live https://fabienlacaze.github.io/MyFabmesh/ (badge BETA, slideshow, Latest release section auto-pull GitHub API, OG cards)
- Logo cliquable → ouvre site dans navigateur (URLs whitelistées)
- Asset type "UI Icon" + profil intelligent (options visibles selon asset type)
- MCP / Claude Code / Unreal mis en avant (3 emplacements landing)
- 2 audits sécurité passés
- GitHub repo `fabienlacaze/MyFabmesh` propre (filter-repo cleanup 1.5 GB → 200 MB)

### 🚧 Bloquant utilisateur (à toi)

| # | Item | Effort | Doc |
|---|---|---|---|
| 1 | **MS Store Windows dev program** ✅ **payé 19 $ 2026-05-24** · App MyFabmesh.AI réservée (Product ID `9PH6GT8XKQDW`, statut "In draft") · Reste : récupérer Product Identity + packager .msix + soumettre | ~24-72 h validation identité MS · packaging .msix 1-2h | Publisher = **Ayros Studio** · partner.microsoft.com/en-US/dashboard/products/9PH6GT8XKQDW · Store deep link : `ms-windows-store://pdp/?productid=9PH6GT8XKQDW` |
| 2 | Test wizard sur machine vierge (VM Win11 / PC ami) | 1 jour | `build/READY_TO_SHIP.md` étape 3 |
| 3 | Listings Gumroad + itch.io | 50 min | `build/LISTINGS_GUIDE.md` |
| 4 | Annoncer launch (Twitter / Reddit / HN / Discord) | 1 jour | `build/LAUNCH_KIT.md` |
| 5 | Code-signing direct (Azure Trusted Signing ~10 €/mois) | 30 min + 120€/an | Complément MS Store si on distribue AUSSI en direct (Gumroad/itch.io) |
| 6 | Domain `myfabmesh.ai` | 5 min + 70€/an | Optionnel Phase 0 (GitHub Pages OK) |

**⚠ Priorité absolue : item 1.** Sans code-signing, Windows Smart App Control
(activé par défaut sur Win 11 livré ≥ 2023) bloque silencieusement notre
installer — pas de message d'erreur, juste "rien ne se passe au double-clic".
Confirmé par diag sur la machine de Fabien (2026-05-24) : SAC enforce =
unsigned exe = crash silencieux 0xC0000005 dans System.dll plugin NSIS.

**Stratégie code-signing recommandée** (à exécuter dans cet ordre) :

1. **MS Store Windows dev (19 $ unique)** = priorité #1. Signature gratuite par MS,
   0 % commission jusqu'à 1M $ revenu, distribution incluse via le Store.
   `partner.microsoft.com/dashboard/v2/account-settings/settings/programs`
2. **Azure Trusted Signing (120 €/an)** = priorité #2, en parallèle. Pour signer
   notre `.exe` direct (téléchargement Gumroad / itch.io / GitHub Releases).
   Sans ça, les users hors MS Store sont bloqués par SAC.
3. **SignPath.io (gratuit OSS)** = alternative si on rend le repo public —
   couvre les mêmes besoins qu'Azure mais nécessite open-source.

**Coût total recommandé** : ~135 €/an (19 $ MS Store unique + 120 €/an Azure Signing).
Amorti dès la 6ème vente.

### 🚧 Backlog autonome (peut tourner sans toi)

Tout ce que Claude (moi) peut faire seul. Priorité décroissante par catégorie :

**A — Site web / marketing** :
- [ ] GIF animé de génération pour Twitter (1h) ⭐⭐⭐
- [ ] Page Use Cases (gamedev / 3D print / indie / VFX) (2h) ⭐⭐⭐
- [ ] Page Roadmap publique avec votes (GitHub Discussions API) (2h) ⭐⭐⭐
- [ ] Honest comparison page vs concurrents (sans nommer) (2h) ⭐⭐⭐
- [ ] Quickstart guide / tutorial (1h) ⭐⭐⭐
- [ ] Page Changelog auto-pull GitHub Releases (1h) ⭐⭐
- [ ] Press kit (logos, screenshots HD, descriptions) (1h) ⭐⭐
- [ ] Sitemap.xml + robots.txt + SEO (30 min) ⭐⭐
- [ ] Page Cloud "Coming Soon" + waitlist email (1h) ⭐⭐

**B — App desktop (UX et robustesse)** :
- [ ] Mode démo : projet pré-rempli au first-launch (2h) ⭐⭐⭐
- [ ] Tutorial interactif overlay first-run (3h) ⭐⭐⭐
- [ ] Feedback widget → GitHub Issues (1h) ⭐⭐
- [ ] Telemetry opt-in anonyme (2h) ⭐⭐
- [ ] Backup auto des projets locaux (1h) ⭐⭐
- [ ] License key system code-prêt pour Phase 1 (3h) ⭐⭐
- [ ] Stripe webhook code-prêt (3h) ⭐⭐

**C — Documentation dev** :
- [ ] MCP API docs (2h) ⭐⭐
- [ ] Plugin development guide (3h) ⭐

**D — Infra & CI** :
- [ ] GitHub Actions auto-build installer à chaque tag git (2h) ⭐⭐⭐
- [ ] Smoke tests étendus (matrix variée) (2h) ⭐⭐
- [ ] Lint + pre-commit hooks (30 min) ⭐

**E — Cloud product P2 (Phase B/C en cours)** :
- [x] ~~POC Replicate `fishwowater/trellis2`~~ ✅ 2026-05-23
- [x] ~~Stratégie pricing GPU L40S/H100~~ ✅ 2026-05-23 (`build/CLOUD_PRICING.md`)
- [x] ~~Scaffold Next.js cloud/ (15 routes, build OK)~~ ✅ 2026-05-23
- [x] ~~Mode MOCK pour test local sans signups~~ ✅ 2026-05-24
- [x] ~~Auto-provisioning Supabase via CLI~~ ✅ 2026-05-24
- [x] ~~Doc GOING_LIVE.md (5 actions humaines)~~ ✅ 2026-05-24
- [ ] **Port renderer desktop → cloud/public/app/** (2026-05-24, in progress)
- [ ] Routes API : generate, jobs, projects, me (1 jour)
- [ ] Push notre Cog `r8.im/fabienlacaze/myfabmesh-cloud` (WSL + Docker, 1 jour)
- [ ] Deploy Cloudflare Pages + custom domain (`cloud.myfabmesh.ai`) (2h)
- [ ] Activer Stripe live mode (post KYC, J+1-2)
- [ ] Test end-to-end : login → upload image → generate → download GLB

**Stratégie Cloud finale** :
- Cloud = port du renderer desktop (mêmes fichiers HTML/CSS/JS sources)
- Différences = `meshyAPI-cloud.js` shim qui remplace IPC Electron par fetch HTTP
- Auth + Stripe + Replicate = backend Next.js, transparent pour l'UI
- Sync : `npm run sync-app` re-copie `src/renderer/*` → `cloud/public/app/*` à chaque évolution UI desktop

### 🎯 Chantiers majeurs identifiés (audit 2026-05-26)

Deux gros chantiers product validés par les audits agents — à attaquer
après les bugfix UX en cours. Ordre = à décider avec le user.

**Chantier R — Cloud Rigging + UE5 Manny natif (~10 jours)**
- M1 (2 j) : fix UniRig skin writer segfault Draco dans
  `scripts/unirig_bridge.py` + paramétrer `swap_skeleton.py` pour
  accepter `--target-skeleton` (au lieu d'orc_m1 hardcodé)
- M2 (4 j) : container UniRig dans Modal (`modal_app/_unirig.py`),
  endpoint Worker `/api/rig`, retirer stubs `autoRig*` de
  `meshyAPI-cloud.js:1418-1420`, UI cloud non-stub
- M3 (3 j) : `scripts/rig_templates/skm/ue5_mannequin_v5.json` (Manny
  strict + IK bones `ik_foot_root` / `ik_hand_root`) + table Supabase
  `user_skeletons` + endpoint `/api/skeletons/list`
- M4 (2 j) : retarget anims CC0 baked vers tout skeleton
- M5 (1 j) : Meshy.ai retiré (✓ fait dans commit 8ade29e)

MVP cloud rigging stable : **6 jours** (M1+M2). MVP UE5 Manny natif :
**10 jours** (M1+M2+M3). Voie privilégiée par l'audit : UniRig Modal,
car seul algo gérant humanoid + animal + créature sous un même modèle.

**Chantier S — Sync desktop ↔ cloud par user (~10 jours)**
- Voie B+C : push manuel desktop→cloud + pull manuel cloud→desktop
  (pas de sync auto bidir, trop d'edge cases)
- Auth Phase 1 : Personal Access Token (PAT style GitHub)
- Auth Phase 2 (plus tard) : deep-link `myfabmesh://callback?token=…`
  via `app.setAsDefaultProtocolClient`

Plan détaillé :
1. Jour 1 : schéma SQL `desktop_tokens(token_hash, user_id, last_used)`
   + RPC `create_desktop_token` + endpoints `/api/account/tokens`
2. Jour 2 : UI `/account` → section "Desktop access" + PAT one-time
3. Jour 3 : `getSessionUser` accepte `Authorization: Bearer mfm_…`
4. Jour 4 : `/api/desktop/upload-project` multipart streaming + sha256
   dédup (skip re-upload si déjà en R2 sous le même hash)
5. Jour 5 : `/api/desktop/list-projects` + `/api/desktop/download-project`
6. Jour 6 : Electron — panneau "Cloud sync" + PAT stocké via
   `safeStorage` + bouton "Backup to cloud"
7. Jour 7 : Bouton "Import from cloud"
8. Jour 8 : Polish (progress, retry, quota free 2 Go visible)
9-10. QA + tests réseau lent

R2 keying recommandé : `<userId>/desktop/<safeProjectName>/<file>` —
cohabite avec le keying existant (`<userId>/<id>.glb`, etc.).

### Plan d'attaque par défaut suggéré (~8h cumulé)

1. GIF animé Twitter (1h) — sans ça les tweets sont moins viraux
2. Mode démo first-launch (2h) — UX new user x10
3. GitHub Actions auto-build (2h) — toi tu push juste un tag, build auto
4. Page Roadmap publique (2h) — engagement community
5. Quickstart guide (1h) — réduit support load

**Total avant public release polish** : ~4-5 jours solo Claude, en parallèle de tes actions utilisateur.

---

## Décisions clés

### 2026-05-22
1. **Pas de port DirectML/AMD pour Desktop.** Le Cloud couvre les non-NVIDIA. Économise 2-3 mois.
2. **Pas de mode Ultra-Lite avec quantization int8.** Trop d'effort, qualité dégradée, le Cloud fait mieux.
3. **Communiquer franchement les requirements sur le site.** "Built for serious creators with NVIDIA GPUs" → positionnement premium.
4. **Compatibility checker obligatoire avant achat Desktop.** Refunds ÷ 5, tickets support ÷ 10.
5. **Pas de Steam.** Cible = devs Unreal/Blender via Fab.com (12% cut), itch.io (10%), Gumroad (10%).
6. **Build in public.** 3-5 posts/semaine, 60 jours d'audience avant launch.

### 2026-05-23 (Cloud kickoff)
7. **Replicate, pas fal.ai/Modal/RunPod** pour la Phase 0. Simple, sans infra à gérer. Bascule vers Modal si volume > 50 gen/h soutenu.
8. **Notre propre Cog `fabienlacaze/myfabmesh-cloud`**, pas `fishwowater/trellis2`. Le POC a montré que TRELLIS-2 vanilla ≠ produit fini — notre pipeline rectify + back-view + smooth + face-fix fait la différence qualitative.
9. **GPU L40S par défaut, pas A100** : -48% coût pour qualité quasi-équivalente sur TRELLIS-2. A100 80GB ne sera JAMAIS utilisé (cher et pas plus rapide). H100 = option "Fast mode" premium +1 crédit.
10. **Cash-positive d'emblée** : pas de free credits (sauf 1 démo unique). 0€ de coût fixe tant que pas de revenu.
11. **Stockage R2, pas Supabase Storage** : 10× moins cher pour des GLB de 5-20 MB. Egress gratuit (clé pour téléchargements clients).

### 2026-05-24 (Cloud architecture)
12. **Cloud = port du renderer desktop**, pas un nouveau frontend custom. Mêmes fichiers HTML/CSS/JS sources copiés depuis `src/renderer/` vers `cloud/public/app/`, seul `meshyAPI-cloud.js` diffère (shim IPC→HTTP). Garantit cohérence UX/UI parfaite Desktop ↔ Cloud sans double maintenance.
13. **Mode MOCK in-memory en dev** : permet de tester tout le flow UI avant d'avoir créé un seul compte externe (Supabase, Stripe, Cloudflare). Flag `MOCK=1` dans `.env.local`.
14. **Provisioning Supabase scripté** via `supabase-setup.mjs` (PAT + Supabase CLI). Évite "click ops" répétitif sur le dashboard.
15. **Observability obligatoire dès maintenant — logs + Sentry partout** : impossible de débugger les problèmes utilisateur après distribution sans télémétrie. Plan :
    - **Desktop main process** : `startup.log` early-logger qui écrit dans `%APPDATA%\fabmesh\` AVANT tout import (capture les crashes bootstrap), puis Sentry pour le runtime. Rotation `startup.prev.log`.
    - **Desktop renderer** : `renderer.log` (existant) + Sentry renderer via `@sentry/electron/renderer` (déjà wiré dans preload.js).
    - **Wizard** : `wizard.log` dédié (les bugs first-run sont les pires car le user n'a pas encore accepté la télémétrie).
    - **Cloud (Next.js)** : `@sentry/nextjs` côté server + client, plus structured logs dans Cloudflare Pages (déjà collectés par défaut, accessibles dans le dashboard).
    - **Sentry projets séparés** : `myfabmesh-ai-desktop`, `myfabmesh-ai-wizard`, `myfabmesh-ai-cloud` pour pouvoir trier les bugs par produit.
    - **Anti-pattern à éviter** : avoir Sentry sans early-log file. Si l'app crashe AVANT que Sentry init, le crash est invisible. La double couverture (file + Sentry) est non négociable.

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
