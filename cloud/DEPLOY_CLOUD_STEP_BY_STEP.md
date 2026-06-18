# MyFabmesh.AI Cloud — Deploy step-by-step

Procédure complète pour passer du mode MOCK local au service Cloud LIVE.
~90 minutes en tout, ~5 actions humaines (les comptes externes).

État actuel : **code 100% ready**, tests e2e MOCK ✅.
Cf `AGENT_LOG.md` + commit history `cloud/`.

---

## ⚙ Architecture cible

```
        ┌──────────────────┐
        │ docs/cloud.html  │  (déjà live sur GitHub Pages)
        │   "Open Cloud"   │
        └────────┬─────────┘
                 │ link
                 ▼
        ┌────────────────────────────┐
        │ cloud.myfabmesh.ai         │  (Cloudflare Pages)
        │ ├─ /         login / land  │
        │ ├─ /app/     desktop port  │
        │ ├─ /buy      Stripe        │
        │ └─ /api/*    Next.js API   │
        └─┬──────────┬───────────┬───┘
          │          │           │
          ▼          ▼           ▼
       Supabase   Replicate   Stripe
       (auth+DB)  (GPU AI)    (paiements)
                     │
                     ▼
                Cloudflare R2
                (storage GLB)
```

---

## 1. Supabase — auth + DB (10 min)

### 1a. Créer un Personal Access Token (PAT)

1. Login sur https://supabase.com/dashboard (compte fabien65400@hotmail.fr existant)
2. Top-right avatar → **Account Settings**
3. Onglet **Access Tokens** → **Generate new token**
4. Name: `myfabmesh-cli`
5. **Copy le PAT** (commence par `sbp_`)

### 1b. Run le script auto

```powershell
cd cloud
$env:SUPABASE_ACCESS_TOKEN = "sbp_xxxxxxxxxx"   # ton PAT
npm run setup:supabase
```

Le script va :
- Login Supabase CLI avec le PAT
- Lister tes orgs (auto-select si une seule)
- Créer le projet `myfabmesh-cloud` en West EU
- Attendre 2 min provisioning
- Récupérer les API keys (URL, anon, service_role)
- Init `supabase/` dir + push `sql/schema.sql` (tables profiles + jobs + payments + RPCs)
- Write `.env.local` avec les vraies clés
- Désactiver `MOCK=0`

À la fin : **Supabase live** + `.env.local` à jour. Test : `npm run dev` → /login → magic link envoyé à ton email.

---

## 2. Stripe — paiements (20 min)

### 2a. Créer un compte Stripe

1. https://dashboard.stripe.com/register (use fabien65400@hotmail.fr)
2. **Skip activation** (KYC) pour le moment → tu restes en test mode
3. **Test mode** suffit pour développer + test launch (toggles `test/live` plus tard)

### 2b. Créer les 3 produits

Dans le dashboard test mode (toggle "Test mode" en haut) :

**Products → Add product** (×3) :

| Name | Price | Recurring |
|------|-------|-----------|
| Starter | 5 € EUR | One-time |
| Pro | 20 € EUR | One-time |
| Studio | 50 € EUR | One-time |

Une fois créés, copy les **Price IDs** (commencent par `price_…`).

### 2c. Récupérer les clés

**Developers → API keys** :
- **Publishable key** (`pk_test_…`)
- **Secret key** (`sk_test_…`) — clique "Reveal" pour la voir

Ajoute manuellement dans `cloud/.env.local` :
```env
STRIPE_SECRET_KEY=sk_test_xxxxxxxxxx
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_xxxxxxxxxx
STRIPE_PRICE_STARTER=price_xxxxxxxxxx
STRIPE_PRICE_PRO=price_xxxxxxxxxx
STRIPE_PRICE_STUDIO=price_xxxxxxxxxx
```

### 2d. Webhook (à faire après le deploy Cloudflare, pas avant)

On a besoin de l'URL `https://myfabmesh-cloud.pages.dev/api/stripe-webhook` qui n'existe que post-deploy. Revenir ici plus tard pour :
- Dashboard → Developers → Webhooks → Add endpoint
- URL: `https://myfabmesh-cloud.pages.dev/api/stripe-webhook`
- Events: `checkout.session.completed`
- **Reveal signing secret** → copy `whsec_…` → add to env: `STRIPE_WEBHOOK_SECRET=whsec_xxxxx`

---

## 3. Cloudflare — Pages + R2 (20 min)

### 3a. Compte Cloudflare

1. https://dash.cloudflare.com/sign-up (use fabien65400@hotmail.fr)
2. Validation email
3. Skip le "Add a website" pour le moment

### 3b. R2 bucket (stockage GLB)

1. Dashboard → **R2 Object Storage** → **Create bucket**
2. Name: `myfabmesh-meshes`
3. Location: **Automatic** (Cloudflare auto-géo)
4. Create

**Public access** (pour que les users puissent télécharger leurs GLB) :
1. Bucket settings → **Public access** → **Allow access** → Allow
2. Copy l'URL `pub-xxxxx.r2.dev`

**API token** (pour que Next.js uploads) :
1. R2 → **Manage R2 API Tokens** → **Create API token**
2. Token name: `myfabmesh-cloud`
3. Permissions: **Object Read & Write**
4. Bucket: only `myfabmesh-meshes`
5. **Create** → copy :
   - Access Key ID
   - Secret Access Key
   - Account ID (visible en haut à droite du dashboard)

Add to `cloud/.env.local`:
```env
R2_ACCOUNT_ID=xxxxxxxxxx
R2_ACCESS_KEY_ID=xxxxxxxxxx
R2_SECRET_ACCESS_KEY=xxxxxxxxxx
R2_BUCKET=myfabmesh-meshes
R2_PUBLIC_URL=https://pub-xxxxxxxx.r2.dev
```

### 3c. Pages — connect GitHub repo

> ⚠ **Pas de build local** : `@cloudflare/next-on-pages` bugué sur Windows (Vercel CLI spawn ENOENT). On utilise l'intégration GitHub native de Cloudflare qui build côté Cloudflare.

1. Dashboard → **Workers & Pages** → **Create application** → **Pages** tab → **Connect to Git**
2. Authorize Cloudflare to access GitHub repos
3. Pick repo: `fabienlacaze/MyFabmesh`
4. Setup project:
   - **Project name**: `myfabmesh-cloud`
   - **Production branch**: `master`
   - **Build command**: `npx @cloudflare/next-on-pages`
   - **Build output directory**: `.vercel/output/static`
   - **Root directory**: `cloud/` ⭐ (important: monorepo)
5. **Environment variables** (Production) → click **Add variable** for each:
   ```
   NEXT_PUBLIC_MOCK=0
   NEXT_PUBLIC_SITE_URL=https://myfabmesh-cloud.pages.dev
   NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJxxx
   NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_xxx
   ```
   For secrets (right column on each var → toggle "Encrypt"):
   ```
   SUPABASE_SERVICE_ROLE_KEY=eyJxxx
   STRIPE_SECRET_KEY=sk_test_xxx
   STRIPE_WEBHOOK_SECRET=whsec_xxx        # add after webhook setup
   REPLICATE_API_TOKEN=r8_xxx
   REPLICATE_MODEL=fishwowater/trellis2   # or fabienlacaze/myfabmesh-cloud once Cog pushed
   R2_ACCOUNT_ID=xxx
   R2_ACCESS_KEY_ID=xxx
   R2_SECRET_ACCESS_KEY=xxx
   R2_BUCKET=myfabmesh-meshes
   R2_PUBLIC_URL=https://pub-xxx.r2.dev
   ```
6. **Settings → Functions** → **Compatibility flags** → add `nodejs_compat` (required for Next.js server)
7. **Save and Deploy** → ~5 min build côté Cloudflare → live!
8. URL : https://myfabmesh-cloud.pages.dev

### 3d. Smoke test post-deploy

```bash
curl -I https://myfabmesh-cloud.pages.dev/                 # 200 (landing)
curl -I https://myfabmesh-cloud.pages.dev/login            # 200
curl    https://myfabmesh-cloud.pages.dev/api/me           # 401 unauthorized (no cookie) — OK
```

Test manuel : aller sur `/login`, signin magic-link, vérifier le redirect vers `/app/`.

---

## 4. Replicate — Cog (optionnel mais recommandé, 1-2h)

Si tu veux notre pipeline complet vs fallback `fishwowater/trellis2` :

### 4a. Pré-requis

- Docker Desktop installé sur Windows ou WSL
- Cog CLI installé dans WSL : `sudo curl -o /usr/local/bin/cog -L https://github.com/replicate/cog/releases/latest/download/cog_Linux_x86_64 && sudo chmod +x /usr/local/bin/cog`
- Compte Replicate (déjà existant : token dans `build/replicate-token.txt`)

### 4b. Push

```bash
# Depuis WSL
cd /mnt/c/Users/Utilisateur/Desktop/FabWare/MeshyMyself
cog login                    # paste replicate token
cog push r8.im/fabienlacaze/myfabmesh-cloud
# 30-60 min build time côté Replicate
```

### 4c. Update Cloudflare env

Dashboard Pages → Settings → Environment variables :
```
REPLICATE_MODEL=fabienlacaze/myfabmesh-cloud
```

Trigger redeploy. Done.

### 4d. Set GPU hardware

https://replicate.com/fabienlacaze/myfabmesh-cloud/settings → Hardware tier → **Nvidia L40S** (économie -48% vs A100 80GB default). Cf `build/CLOUD_PRICING.md`.

---

## 5. Custom domain (optionnel, 15 min)

Si tu veux `cloud.myfabmesh.ai` au lieu de `myfabmesh-cloud.pages.dev` :

### 5a. Acheter le domaine

1. Cloudflare dashboard → **Domain Registration** → search `myfabmesh.ai`
2. ~12 €/an (pas de markup chez Cloudflare Registrar)
3. Buy

### 5b. Custom domain sur Pages

1. Dashboard → Workers & Pages → myfabmesh-cloud → **Custom domains**
2. **Set up a custom domain** → enter `cloud.myfabmesh.ai`
3. Cloudflare crée le DNS automatiquement
4. SSL en ~5 min

### 5c. Update env

Pages → Settings → Environment variables :
```
NEXT_PUBLIC_SITE_URL=https://cloud.myfabmesh.ai
```

Trigger redeploy.

### 5d. Update site web (docs/index.html) plus tard

Le bouton "Open Cloud" sur le site officiel pointe vers `docs/cloud.html` (page waitlist).
Quand le Cloud est live, changer en :
```html
<a href="https://cloud.myfabmesh.ai/" class="btn-primary-full">Open Cloud</a>
```

---

## 6. Sentry pour le Cloud (optionnel, 10 min)

Pour les crash reports server-side et client-side du Cloud Next.js :

1. https://sentry.io/organizations/fabienlacaze/projects/new/
2. Project type: **Next.js**
3. Project name: `myfabmesh-ai-cloud`
4. Copy le **DSN** (https://xxx@oxxx.ingest.de.sentry.io/xxx)
5. Add to Cloudflare Pages env :
   ```
   SENTRY_DSN=https://xxx@oxxx.ingest.de.sentry.io/xxx
   NEXT_PUBLIC_SENTRY_DSN=<même DSN>
   ```
6. Trigger redeploy. Sentry capture auto serveur + client (instrumentation.ts + instrumentation-client.ts déjà wired).

---

## 7. Test launch (15 min)

Une fois tout up :

| Test | Commande | Résultat attendu |
|------|----------|------------------|
| Landing | `https://cloud.myfabmesh.ai/` | Hero "Image to 3D mesh in your browser" |
| Login | `/login` → email | Magic link reçu sur ton inbox |
| App | After login → `/app/` | App desktop complète chargée dans le navigateur |
| Generate | Upload une image dans `/app/`, lance gen | Polling status → mesh visible en ~120 s |
| Buy | `/buy` → click Pro | Stripe Checkout test → success → +120 credits |
| Account | `/account` | Profile + historique des jobs + payments |

---

## ⏱ Estimation timeline

| Quand | Quoi | Cumul |
|-------|------|-------|
| J0 | Supabase setup (10 min) + Stripe test mode (20 min) + Cloudflare R2 + Pages (40 min) | 70 min |
| J0 +1 day | Stripe webhook config (5 min) + smoke test live (15 min) | 90 min |
| J+3 (optional) | Replicate Cog push (1-2h) | 3-4h cumul |
| J+7 (optional) | Custom domain + DNS (15 min) + email Stripe KYC pour live mode | +30 min |

**Cloud opérationnel en pay-as-you-go test mode** : **J0 + 90 min**.
**Cloud opérationnel en live (vrai paiements)** : J+3 après KYC Stripe approuvé.

---

## 🆘 Si ça plante

| Symptôme | Cause probable | Fix |
|----------|----------------|-----|
| `setup:supabase` fails: "PAT invalid" | Token mal copié | Re-générer le PAT |
| Cloudflare build fails: `nodejs_compat` missing | Flag non activé | Settings → Functions → Compatibility flags → add `nodejs_compat` |
| `/api/me` returns 500 in prod | Supabase URL wrong | Check env vars dans Cloudflare dashboard |
| Stripe webhook fails: signature mismatch | `STRIPE_WEBHOOK_SECRET` env wrong | Re-copy depuis Stripe dashboard → trigger redeploy |
| Mesh upload fails to R2 | Token permissions wrong | Re-create R2 token avec Read & Write sur le bon bucket |
| User signs up but `/app/` 404 | rewrites pas chargés | Check `cloud/next.config.mjs` → redeploy |

---

## 📋 Checklist quick

- [ ] Supabase project created + schema pushed (`npm run setup:supabase`)
- [ ] Stripe account + 3 products + API keys in `.env.local`
- [ ] Cloudflare account + R2 bucket + API token
- [ ] Cloudflare Pages project connected to GitHub repo
- [ ] All env vars set in Cloudflare dashboard
- [ ] First deploy successful → URL `myfabmesh-cloud.pages.dev` live
- [ ] Stripe webhook configured with the live URL
- [ ] Smoke test : landing + login + generate + buy all work
- [ ] (optional) Cog pushed on Replicate
- [ ] (optional) Custom domain `cloud.myfabmesh.ai` wired
- [ ] (optional) Sentry project created + DSN in env
- [ ] Update site button "Open Cloud" to point to live URL
- [ ] Announce launch on Twitter/Reddit/LinkedIn (cf `build/marketing/LAUNCH_POSTS.md`)

## 🔐 R2 signed URLs (P1 — face photos must not be public)

The worker mints short-lived HMAC-signed URLs (`/r2/<key>?exp&sig`) served
from its own origin and streamed from the `MESHES` binding. This closes the
P1 finding that R2 objects (incl. user face photos) were reachable at
permanent, guessable, unauthenticated `r2.dev` URLs.

Rollout (NON-breaking — do the steps in order):

1. Deploy the worker (`cd cloud && npm run build && npx wrangler deploy`).
   With **no** secret set, `signedR2Url()` falls back to the old public
   `R2_PUBLIC_URL` form and the `/r2/` route 404s → byte-for-byte current
   behavior. Full rollback safety.
2. Generate + set the secret (no redeploy needed; effective next request):
   ```bash
   openssl rand -hex 32 | npx wrangler secret put R2_URL_SIGNING_SECRET
   ```
   API responses now mint signed `/r2/...?exp=<unix>&sig=<hex>` URLs.
   TTLs: images 24h, meshes 7d, exports (CSV/XLSX/GDPR) 30d.
3. Verify in the live app: a fresh image renders via `/r2/` (200), a tampered
   or expired `sig` → 403, a mesh loads in model-viewer, admin listing +
   marketplace download work, cache-bust `?t=` coexists with `exp`+`sig`.
4. **ONLY AFTER step 3 passes:** Cloudflare dashboard → R2 → `myfabmesh-meshes`
   → Settings → Public Access (R2.dev subdomain) → **Disallow**. After this,
   `pub-*.r2.dev/<key>` returns 401/404 for everyone; the in-app signed URLs
   still 200 (the `MESHES` binding is unaffected by disabling the public
   subdomain). P1 closed.
5. (Optional hardening) remove `https://*.r2.dev` from the CSP once nothing
   references r2.dev, then redeploy.

Notes:
- `R2_URL_SIGNING_SECRET` is a **Worker SECRET** — never in `wrangler.toml`.
- Rotating the secret invalidates every outstanding signed URL (all 403).
  The `v1:` prefix in the signing string allows a future dual-secret rotation.
- Persisted columns (`jobs.mesh_url`, `user_assets.r2_path`,
  `jobs.options.sourceImage`) store the raw R2 KEY and are re-signed on read,
  so links never go permanently stale. Legacy rows holding a full r2.dev URL
  are passed through unchanged but those specific links die when step 4 runs.
