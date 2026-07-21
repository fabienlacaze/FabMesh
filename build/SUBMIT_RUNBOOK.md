# Runbook — CRÉER la soumission Microsoft Store (MyFabmesh.AI 1.0.10)

Ordre exact des clics dans Partner Center pour soumettre le paquet.
La soumission API automatisée est INUTILISABLE (compte MSA perso → OAuth 401
vérifié le 2026-07-21), donc **tout se fait à la main dans le navigateur**,
connecté à ton compte Microsoft.

Dashboard produit : https://partner.microsoft.com/dashboard/products/9PH6GT8XKQDW/overview

> ⚠️ Deux points durs indépendants de ce runbook :
> - **Signature / SAC** : le paquet n'est PAS signé par nous — c'est le Store qui
>   signe à la certification, ce qui fait que Smart App Control acceptera l'app
>   installée *via le Store*. (Un `.appx` installé en side-load hors Store, lui,
>   serait bloqué par SAC — d'où l'intérêt de passer par la certification Store.)
> - **Test machine vierge** : l'install ~5 Go (torch 2.8 + kaolin + modèles HF au
>   premier lancement) n'a JAMAIS été validée end-to-end sur un PC propre. Idéal :
>   le faire une fois l'app publiée (cf. `build/POST_CERT_CHECKLIST.md` §1) avant
>   d'annoncer le launch.

---

## Pré-vol — tout est prêt (vérifié 2026-07-21)

| Élément | Valeur / emplacement |
| --- | --- |
| **Paquet à uploader** | `dist/installer/MicrosoftStore/MyFabmesh.AI 1.0.10.appx` (208,6 Mo) |
| **Identity Name** (doit matcher la réservation) | `AyrosStudio.MyFabmesh.AI` |
| **Publisher** | `CN=3767FC33-F877-4481-9639-BC9CFF9D1371` |
| **Publisher display name** | `Ayros Studio` |
| **Version** | `1.0.10.0` · x64 · langues en-US + fr-FR |
| **Application ID** | `9PH6GT8XKQDW` |
| **Captures (1920×1080)** | `build/marketing/store-screenshots/store_1..4_*.png` |
| **Description listing** | `build/marketing/MS_STORE_LISTING_ANONYMIZED.md` (bloc « Description ») |
| **Privacy policy (live, HTTP 200)** | https://fabienlacaze.github.io/MyFabmesh/privacy.html |
| **Support / bug reports** | https://github.com/fabienlacaze/MyFabmesh/issues |

> 💡 Utilise directement la description ANONYMISÉE dès cette soumission
> (pas la peine de leaker TRELLIS-2/SDXL puis de corriger après — c'est une
> nouvelle soumission, autant partir propre).

---

## 1. Créer la soumission — 1 min

1. Dashboard → produit **MyFabmesh.AI** (`9PH6GT8XKQDW`).
2. S'il y a une soumission **en cours / brouillon** (probablement une vieille
   1.0.4) : ouvre-la et clique **« Update »**, sinon **« Start your submission »**
   / **« Create new submission »**.

## 2. Packages — 3 min (+ upload)

1. Onglet **Packages**.
2. Glisse-dépose `MyFabmesh.AI 1.0.10.appx`.
3. Attends la validation d'upload. **Si erreur d'identité** → l'`identityName`
   ou le `Publisher` du paquet ≠ la réservation. Compare la page
   **Product identity** (Product management → Product identity) avec les valeurs
   du tableau ci-dessus ; en cas d'écart, c'est le `package.json > build.appx`
   qu'il faut réaligner puis rebuild (`npm run build:msix`) — dis-le moi.
4. Supprime tout ancien paquet 1.0.x listé pour ne garder que le 1.0.10.

## 3. Pricing and availability — 2 min

- **Base price : Free**.
- **Markets** : tous (ou au moins FR + US + UE).
- **Visibility** : Public.
- **Schedule** : « as soon as it passes certification ».

## 4. Properties — 3 min

- **Category** : **Multimedia design** (à défaut : *Developer tools*).
- **Privacy policy URL** : `https://fabienlacaze.github.io/MyFabmesh/privacy.html`.
- **Support contact info** : l'URL GitHub issues ci-dessus.
- **System requirements** (facultatif mais recommandé) : GPU NVIDIA ≥ 8 Go VRAM,
  16 Go RAM, 30 Go disque, Windows 10/11 64-bit.

## 5. Age ratings (IARC) — 3 min

Remplis le questionnaire. Réponses (app = génération d'images pilotée par
l'utilisateur + filtre NSFW/PIN parental) :

- Contenu violent / sexuel / grossier **fourni par le développeur** : **Non**.
- **Contenu / interactions générés par l'utilisateur** : **Oui** — l'utilisateur
  peut générer des images ; modération en place (classificateur NSFW + PIN
  parental de restriction).
- Achats in-app / publicités / partage de localisation : **Non**.
- Collecte / partage de données personnelles avec des tiers : **Non**
  (crash reports anonymes, sans identifiant machine).

→ Résultat attendu : **PEGI 3 / ESRB Everyone** (avec mention « contenu généré
par l'utilisateur »).

## 6. Store listing (English United States) — 5 min

1. **Description** : colle le bloc de `build/marketing/MS_STORE_LISTING_ANONYMIZED.md`.
2. **Screenshots** : uploade les 4 :
   - `store_1_gallery.png` — la galerie de projets (éventail de contenus)
   - `store_2_pipeline.png` — pipeline image→3D + outils IA
   - `store_3_editor3d.png` — éditeur 3D plein écran
   - `store_4_rig_anim.png` — rig + animation + export Unreal/Blender
3. **Short title / description** : « Image to 3D mesh, on your GPU ».
4. (Optionnel) ajoute une listing **French (France)** — audience FR doublée.

## 7. Soumettre — 1 min

1. **Submit to the Store**.
2. Certification Microsoft : typiquement **24-48 h**.
3. Surveille le statut sur la page **Submissions** (ou l'email
   « passed / failed certification »).

---

## Si la certification ÉCHOUE

Le rapport liste la/les règle(s). Cas probables et réponse :

- **10.1.x / crash au lancement** : c'est le SAC/signature — normalement réglé
  par la signature Store, mais si ça persiste, ouvrir un ticket support MS avec
  le Submission ID (cas rare).
- **runFullTrust** signalé : c'est attendu pour une app Electron/Win32 ; fournir
  la justification (« desktop bridge application, Electron runtime »).
- **Metadata / screenshots** : corriger dans le listing, re-submit (metadata-only,
  < 24 h).

Colle-moi le rapport et je te dis quoi corriger.

---

## Une fois PUBLIÉ

Enchaîne sur `build/POST_CERT_CHECKLIST.md` (test install machine vierge en
priorité #1, puis annonce launch). Les screenshots de ce runbook remplacent
déjà les mockups mentionnés là-bas.
