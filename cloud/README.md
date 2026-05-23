# MyFabmesh.AI Cloud — Frontend Next.js

Frontend du produit P2 (Cloud SaaS). Stack :
- **Next.js 15** (App Router, server components)
- **Supabase** — auth magic-link + Postgres (profiles, jobs, payments)
- **Stripe Checkout** — paiements crédits
- **Replicate** — appel du Cog `fabienlacaze/myfabmesh-cloud` (avec fallback `fishwowater/trellis2`)
- **Cloudflare R2** — stockage GLB stable (signed URLs Replicate expirent à 24h)
- **Cloudflare Pages** — hébergement (free tier jusqu'à 100k req/jour)

## Démarrage local

### Option A — Mode DEV mock (zéro signup) ⭐
```bash
cd cloud/
npm install
# .env.local is already set up with MOCK=1
npm run dev          # http://localhost:3030
```
Tu auras un user instantané avec 50 crédits, GLB de test, et Stripe simulé.
Idéal pour tester l'UI complète sans aucun service externe.

### Option B — Mode PROD réel (avec Supabase + Stripe + Replicate)

1. **Supabase auto** (recommandé) :
   ```bash
   node scripts/supabase-setup.mjs
   ```
   Crée un PAT sur https://supabase.com/dashboard/account/tokens, colle-le
   quand demandé. Le script crée le projet, push le schema, et met à jour
   ton `.env.local`.

2. **Stripe + R2** : remplis les clés manuellement via :
   ```powershell
   .\scripts\setup-prod.ps1
   ```

3. `npm run dev` ou `npm run build && npm run start`

## Setup external services (one-time)

### 1. Supabase
1. Crée un projet sur https://supabase.com (free tier OK).
2. Settings → API → copie `URL`, `anon key`, `service_role key` dans `.env.local`.
3. SQL Editor → exécute `cloud/sql/schema.sql` une fois.
4. Authentication → Email templates → personnalise le magic-link (sujet `[MyFabmesh.AI] Ton lien de connexion`).
5. Authentication → URL Configuration → ajoute `http://localhost:3030/auth/callback` et l'URL Cloudflare Pages prod en redirect URL.

### 2. Stripe
1. Crée un compte sur https://stripe.com (test mode par défaut).
2. Developers → API keys → copie `Secret key` et `Publishable key` dans `.env.local`.
3. Developers → Webhooks → Add endpoint → `https://<TON-DOMAINE>/api/stripe-webhook` → events `checkout.session.completed` → copie le `Signing secret` dans `.env.local`.
4. En dev local, utilise `stripe listen --forward-to localhost:3030/api/stripe-webhook` pour simuler les webhooks.

### 3. Replicate
1. Token déjà créé pour le POC (cf `build/replicate-token.txt`).
2. Push notre Cog : `cd cog/ && cog push r8.im/fabienlacaze/myfabmesh-cloud` (nécessite WSL2 + Docker — cf `cog/README.md`).
3. Dans le dashboard Replicate, settings → hardware → **L40S** (default éco) ou **H100** (mode Fast premium).
4. En attendant notre Cog, `REPLICATE_MODEL=fishwowater/trellis2` marche (output schema géré dans `src/lib/replicate.ts`).

### 4. Cloudflare R2
1. Cloudflare Dashboard → R2 → Create bucket `myfabmesh-meshes`.
2. Settings → Public access → expose en `pub-xxxxx.r2.dev` (ou via custom domain).
3. R2 API tokens → Create token → permissions Object Read & Write sur ce bucket → copie `Access Key ID` et `Secret` dans `.env.local`.

## Déploiement Cloudflare Pages

```bash
# Une fois
npm install -g wrangler
wrangler login

# Build + deploy
npm run pages:build
npm run pages:deploy
```

Ou via le dashboard Cloudflare Pages :
1. Connect git repo (sous-dossier `cloud/`)
2. Build command : `npx @cloudflare/next-on-pages`
3. Build output : `.vercel/output/static`
4. Compatibility flag : `nodejs_compat`
5. Variables d'environnement : recopier toutes celles de `.env.local`

## Structure

```
cloud/
├── src/
│   ├── app/
│   │   ├── layout.tsx              # shell + nav + footer
│   │   ├── page.tsx                # landing (hero, pricing, features)
│   │   ├── generate/               # form upload + viewer 3D
│   │   ├── buy/                    # 3 packs crédits + checkout
│   │   ├── account/                # solde + historique
│   │   ├── login/                  # magic-link
│   │   ├── auth/callback/          # OTP exchange
│   │   └── api/
│   │       ├── generate/           # POST: upload + create Replicate prediction
│   │       ├── jobs/[id]/          # GET: poll status + upload R2 on success
│   │       ├── checkout/           # POST: Stripe session
│   │       └── stripe-webhook/     # POST: credit on payment.success
│   ├── components/
│   │   └── Nav.tsx
│   └── lib/
│       ├── supabase.ts             # SSR + admin clients
│       ├── auth.ts                 # getSessionUser, spend/add credits
│       ├── replicate.ts            # createPrediction, dual-schema (our Cog OR fishwowater)
│       ├── r2.ts                   # SigV4 PUT to R2
│       └── stripe.ts               # client + PACKS map
├── sql/
│   └── schema.sql                  # profiles + jobs + payments + RPCs + RLS
├── public/
├── .env.example
├── next.config.mjs
├── package.json
└── tsconfig.json
```

## Architecture flow

```
[User browser]
  ├─ POST /api/generate (FormData: image + opts)
  │    └─ verify session + spend_credits()
  │    └─ replicate.predictions.create() → returns predictionId
  │    └─ insert into jobs table
  │
  ├─ poll GET /api/jobs/[id] every 3s
  │    └─ replicate.predictions.get(id)
  │    └─ if succeeded: upload GLB → R2 → return r2_url
  │    └─ if failed: add_credits() refund
  │
  └─ <model-viewer src="https://pub-xxx.r2.dev/<user_id>/<job_id>.glb">

[Stripe Checkout]
  └─ POST /api/stripe-webhook
       └─ verify signature
       └─ insert payments (idempotent)
       └─ add_credits()
```
