# MyFabmesh.AI Cloud — Going Live

Guide pas-à-pas pour passer du **mode DEV (mock)** au **service réel
opérationnel** sur internet. Tout ce que je peux automatiser est dans
`scripts/setup-prod.ps1` ; ici on documente les **5 actions manuelles**
que tu dois faire dans des UI web.

Temps total : **~1h30** étalées sur 2 jours (Stripe KYC = 1-2 jours wait).

---

## Vue d'ensemble

```
        TOI (manual)                   MOI (auto)
        ────────────                   ──────────
1. Crée projet Supabase                
                                       → Run schema.sql via Supabase CLI
2. Crée compte Stripe (test mode)
3. Configure Stripe webhook            → Test webhook avec stripe-cli
4. Crée bucket R2 + token Cloudflare
                                       → Deploy via wrangler pages
                                       → Bascule .env MOCK=0
5. KYC Stripe (J+1)                    → Tu basculera en mode live
```

---

## 1. Supabase (10 min)

> 🟢 Tu as déjà un compte (lokizio). Juste un nouveau projet à créer.

1. https://supabase.com/dashboard → **New project**
2. Settings :
   - **Name** : `myfabmesh-cloud`
   - **Database password** : génère, **note-le quelque part**
   - **Region** : `West EU (Paris)` (latence min depuis France)
   - **Plan** : Free
3. Attends ~2 min provisioning
4. **Settings → API** → copie ces 3 valeurs :
   ```
   Project URL          → NEXT_PUBLIC_SUPABASE_URL
   anon public          → NEXT_PUBLIC_SUPABASE_ANON_KEY
   service_role secret  → SUPABASE_SERVICE_ROLE_KEY
   ```
5. **SQL Editor → New query** → colle tout `cloud/sql/schema.sql` → **Run**
   - Doit afficher `Success. No rows returned.`
6. **Authentication → URL Configuration** → ajoute en redirect URL :
   - `http://localhost:3030/auth/callback` (dev)
   - `https://myfabmesh-cloud.pages.dev/auth/callback` (prod)

---

## 2. Stripe (15 min)

1. https://dashboard.stripe.com/register → signup (email + mot de passe)
2. Tu seras en **Test mode** par défaut → reste dedans pour démarrer
3. **Developers → API keys** :
   ```
   Publishable key (pk_test_…)  → NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
   Secret key      (sk_test_…)  → STRIPE_SECRET_KEY
   ```
4. **Webhook configuration** (à faire après le 1er deploy Cloudflare) :
   - **Developers → Webhooks → Add endpoint**
   - URL : `https://myfabmesh-cloud.pages.dev/api/stripe-webhook`
   - Events : `checkout.session.completed`
   - **Reveal signing secret** → copie → `STRIPE_WEBHOOK_SECRET`

⏱ **Plus tard** pour les vrais paiements :
- Settings → Business settings → Activate payments → KYC
- Pièce d'identité + RIB → délai 1-2 jours
- Une fois activé, tu peux passer en **Live mode** (toggle en haut à gauche)
  et les clés deviennent `sk_live_…` / `pk_live_…`

---

## 3. Cloudflare (Pages + R2) (20 min)

### 3.a Compte + Pages
1. https://dash.cloudflare.com/sign-up → email + password
2. **Workers & Pages** → **Create application → Pages → Connect to Git**
3. Authorize GitHub access → choisis le repo `MeshyMyself`
4. Build configuration :
   - **Project name** : `myfabmesh-cloud`
   - **Production branch** : `master`
   - **Build command** : `npx @cloudflare/next-on-pages`
   - **Build output directory** : `.vercel/output/static`
   - **Root directory** : `cloud/`
5. **Environment variables** → copie toutes celles de `.env.local` produit
   par le script setup-prod.ps1
6. **Settings → Functions → Compatibility flags** → ajoute `nodejs_compat`
7. **Save and Deploy** → ~3 min de build
8. URL finale : `https://myfabmesh-cloud.pages.dev`

### 3.b R2 (storage GLB)
1. Dashboard → **R2 Object Storage** → **Create bucket**
   - Name : `myfabmesh-meshes`
   - Location : automatique
2. Bucket → **Settings → Public access** → enable → note l'URL `pub-xxx.r2.dev`
3. Dashboard → **R2 → Manage API tokens** → **Create API token**
   - Permissions : `Object Read & Write`
   - Bucket : `myfabmesh-meshes` only
   - Token name : `myfabmesh-cloud-app`
   - Copie : `Access Key ID`, `Secret Access Key`, `Account ID` (en haut à droite)

```
R2_ACCOUNT_ID       → Account ID Cloudflare
R2_ACCESS_KEY_ID    → Token's access key
R2_SECRET_ACCESS_KEY → Token's secret
R2_BUCKET           → myfabmesh-meshes
R2_PUBLIC_URL       → https://pub-xxx.r2.dev (du step 2)
```

⏱ **Skippable** : si tu sautes R2, on garde les URLs Replicate (expirent
sous 24h, OK pour le launch beta mais pas pour l'historique long terme).

---

## 4. Replicate (déjà OK)

Token déjà en place dans `build/replicate-token.txt`. Solde : checke
sur https://replicate.com/account/billing.

**Note importante GPU** : dans le dashboard Replicate, va sur ton
modèle `fabienlacaze/myfabmesh-cloud` (une fois pushé) → **Settings →
Hardware** → choisis **Nvidia L40S** (économie -48% vs A100 80GB par
défaut).

---

## 5. Push notre Cog (optionnel pour V1 — 1h30)

> 🟡 Pas bloquant : `fishwowater/trellis2` marche comme fallback.
> Mais notre Cog ajoute auto-rectify + back-view + smooth + face-fix
> + 8K upscale → qualité nettement supérieure.

1. **Installer Docker Desktop Windows** : https://docker.com/products/docker-desktop
   - ~600 MB DL, redémarrage requis
   - Vérifie que WSL2 backend est activé (par défaut depuis Windows 11)
2. **Installer Cog CLI dans WSL2** :
   ```bash
   wsl
   sudo curl -o /usr/local/bin/cog -L https://github.com/replicate/cog/releases/latest/download/cog_Linux_x86_64
   sudo chmod +x /usr/local/bin/cog
   cog --version  # vérifie
   ```
3. **Login Replicate** :
   ```bash
   cog login   # → te demande ton token (build/replicate-token.txt)
   ```
4. **Push** (depuis le repo en WSL) :
   ```bash
   cd /mnt/c/Users/Utilisateur/Desktop/FabWare/MeshyMyself
   cog push r8.im/fabienlacaze/myfabmesh-cloud
   ```
   - Premier push : ~30-60 min (build image ~12 GB)
   - Push suivants : ~10 min (cache layers)
5. Dans `.env.local` (ou via setup-prod.ps1) :
   ```
   REPLICATE_MODEL=fabienlacaze/myfabmesh-cloud
   ```

---

## 6. Domaine custom (optionnel — 15 min)

1. Cloudflare dashboard → **Domain Registration → Register Domains**
2. Cherche `myfabmesh.ai` → achète (~12 €/an avec Cloudflare Registrar,
   sans markup contrairement à GoDaddy/OVH)
3. **Workers & Pages → myfabmesh-cloud → Custom domains → Set up a custom domain**
   - `cloud.myfabmesh.ai` ou `app.myfabmesh.ai` ou racine
   - Cloudflare crée le DNS automatiquement
4. SSL gratuit, automatique, en ~5 min
5. Mets à jour `NEXT_PUBLIC_SITE_URL` dans Cloudflare Pages variables
   d'env → redéploie

---

## Ordre recommandé (optimal pour démarrer vite)

```
J0 (ce soir)     → Test en local en mode MOCK (rien à signer)
                   npm run dev → http://localhost:3030

J1 matin (1h)    → Étapes 1 + 2 + 3 + 4 ci-dessus
                 → .\scripts\setup-prod.ps1 (j'ai prévu un wizard)
                 → wrangler pages deploy
                 → Service VIVANT en test mode sur pages.dev

J1 soir (1h30)   → Étape 5 (Docker + Cog push)
                 → Service avec NOTRE pipeline complet

J2-3             → Étape 6 (domaine) + KYC Stripe live

J3+              → Annonce launch beta, premiers utilisateurs
```

---

## Si tu bloques sur quelque chose

Liste les questions ici quand tu y arrives, ou pendant la session :
- Si une clé ne marche pas → log dans la console navigateur + onglet Network
- Si Supabase rejette le schema → check qu'il n'y a pas de tables homonymes existantes
- Si Cloudflare Pages build fail → check les compatibility flags (`nodejs_compat` requis)
- Si Stripe webhook ne fire pas → tester en local avec `stripe listen --forward-to localhost:3030/api/stripe-webhook`
