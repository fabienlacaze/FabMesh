# Post-cert checklist — quand MS Store publie MyFabmesh.AI

À exécuter dans l'ordre dès que tu reçois l'email Microsoft
**"Your submission has passed certification"**.

Estimation totale : ~30 min.

---

## 0. Vérifier que l'app est vraiment live

Le lien de la fiche app : https://apps.microsoft.com/detail/9PH6GT8XKQDW

Si la page affiche **"Get"** / **"Install"** avec le logo et la description = LIVE ✅
Si elle affiche **"App not available"** = pas encore publiée, attends quelques minutes.

---

## 1. Tester l'install end-to-end (PRIORITÉ #1) — 5 min

Sur **ta propre machine** (avec SAC actif) :

1. Ouvre https://apps.microsoft.com/detail/9PH6GT8XKQDW
2. Clique **"Get"** ou **"Install"**
3. Microsoft Store s'ouvre → clique **"Get"**
4. L'install se fait automatiquement (~2-3 min DL du .msix signé)
5. Clique **"Open"** une fois installé
6. **SAC doit accepter** (signé par Microsoft) → la fenêtre de l'app s'ouvre 🎉
7. Le wizard premier-run démarre (DL des modèles HF, 15-22 GB)

Si la fenêtre s'ouvre → **bingo**, le flow site web → install → app marche.
Si SAC bloque encore → c'est un cas rare, contacter le support MS Store avec ton Submission ID.

---

## 2. Modifier la description Store pour anonymiser la stack — 10 min

**Pourquoi** : la submission soumise mentionne TRELLIS-2, IP-Adapter, SDXL —
des noms de modèles qui dévoilent ta stack aux concurrents.

1. Va sur https://partner.microsoft.com/en-US/dashboard/products/9PH6GT8XKQDW/store-listing/en-US
2. Edit **Description** → remplace tout le bloc par la version anonymisée dans
   `build/marketing/MS_STORE_LISTING_ANONYMIZED.md`
3. Save
4. Submit cette modification (option : "Update Store listings only" si dispo,
   sinon resubmit la submission — c'est plus rapide qu'une nouvelle review
   complète car le package n'a pas changé : MS valide juste les metadata,
   typiquement < 24h).

---

## 3. Faire les vrais screenshots de l'app — 15 min

Maintenant que l'app installée via Store **passe SAC**, tu peux la lancer
et faire de vraies captures :

1. Lance l'app depuis le menu démarrer ou le raccourci desktop
2. Attends que le wizard finisse (modèles téléchargés) OU rends-toi à
   un projet existant
3. Captures à prendre (sauvegarde dans `build/store_assets/screenshots/`) :
   - `01-projects.png` — page d'accueil "Your projects"
   - `02-workspace.png` — workspace 3-steps avec un projet ouvert
   - `03-mesh-viewer.png` — viewer 3D avec un mesh généré
   - `04-edit.png` — outils d'édition mesh/texture
4. Upload ces 4 captures dans le Store listing en remplaçant les mockups
   `01-wizard.png` / `02-generate.png`
5. Submit (idem : metadata only, < 24h)

---

## 4. Annoncer le launch — 15 min

Les drafts sont dans `build/marketing/LAUNCH_POSTS.md`. Schedule recommandé :

- **Day 0 (jour live), 09:00 CET** : Twitter/X (variant A) + LinkedIn
- **Day 0, 14:00 CET** : Reddit r/gamedev
- **Day 0, 18:00 CET** : Discord servers
- **Day 0, 21:00 CET** : Reddit r/StableDiffusion
- **Day 1, 09:00 CET** : Show HN
- **Day 1, 14:00 CET** : Reddit r/3Dprinting

**Évite vendredi après-midi + weekend** — engagement bas pour les indé.

---

## 5. Update les meta tags Open Graph du site web — 5 min

Le titre actuel des liens partagés sur Twitter/Discord pointe vers une beta
qui n'est plus en attente. Update :

Fichier : `docs/index.html`

```html
<meta property="og:title" content="MyFabmesh.AI — Image to 3D, on your GPU. Now on Microsoft Store">
<meta property="og:description" content="Free Windows app. Drop a photo, get a 3D mesh in 90s. Runs locally on your NVIDIA GPU. No cloud, no subscription.">
```

Commit + push, GitHub Pages redéploie en ~1 min, et les nouvelles previews
des liens partagés utiliseront le nouveau texte.

---

## 6. Suivre les metrics les 48 premières heures

Ouvre **3 onglets toujours visibles** dans ton browser pendant 2 jours :

| Onglet | URL | Quoi monitorer |
|--------|-----|---------------|
| **MS Store dashboard** | https://partner.microsoft.com/en-US/dashboard/products/9PH6GT8XKQDW/analytics | Installs, ratings, reviews, crashes |
| **Sentry** | https://fabienlacaze.sentry.io/projects/myfabmesh-ai-desktop | Crash reports en temps réel |
| **GitHub Issues** | https://github.com/fabienlacaze/MyFabmesh/issues | Bug reports des users |

Si tu vois un crash récurrent → priorité absolue, fix + push tag `v1.0.1`,
le GitHub Actions auto-rebuild (cf `.github/workflows/build-release.yml`)
et tu reuploads sur MS Store en quelques heures.

---

## 7. Backlog pour la suite

Une fois le launch stabilisé (semaine 2+) :

- **Dépôt INPI** "Ayros Studio" (230 €, protection légale FR + UE)
- **Domain custom** : `myfabmesh.ai` ou `ayros.studio` (~12-15 €/an Cloudflare Registrar)
- **Localization French** du Store listing (audience FR doublée)
- **Cloud P2** : push notre Cog Replicate, deploy Next.js sur Cloudflare Pages
- **Marketplace P4** : revente d'assets users

---

## ✅ Cette checklist est prête. À exécuter dès l'email "Passed certification".
