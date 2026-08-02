# Resoumission Microsoft Store — checklist (rapport de certification du 23/07/2026)

> ## ✅ PACKAGE PRÊT À SOUMETTRE
> **`dist/installer/MicrosoftStore/MyFabmesh.AI 1.0.12.appx`** (191 Mo, 576 entrées)
> Version 1.0.12 — 1.0.11 est la version refusée le 23/07, Partner Center exige un numéro supérieur.
> Manifeste : `internetClient` + `runFullTrust`. Audit licence : Michelangelo 0 · PartField 0 · nvdiffrec 0 · sources Puppeteer 0.
> ⚠️ Ne PAS soumettre les anciens .appx présents dans le même dossier.

### Notes for certification — texte prêt à coller

```
This app works on machines WITHOUT an NVIDIA GPU.
On such devices (e.g. Surface Laptop) the setup wizard detects the absence of an
NVIDIA GPU and the app automatically runs in Cloud mode: image generation, 3D mesh
generation, rigging and animation all run on the MyFabmesh cloud service. Nothing
is downloaded, no local AI model is used.

Test account (already funded with credits):
  email:    <A REMPLIR>
  password: <A REMPLIR>

Steps to test image generation:
  1. Launch the app. The wizard shows "No NVIDIA GPU detected - Cloud mode will be
     used". Click "Continue in Cloud mode".
  2. Create a project, type any prompt, click "Generate".
  3. Sign in with the test account when prompted (first time only).
  4. Images are generated in the cloud and appear in the project.

In-app purchases: credits are sold on our website
(https://myfabmesh-cloud.fabien65400.workers.dev), never inside the app - declared
under "This app allows users to make purchases, but does not use the Microsoft
Store commerce system".
```


Rapport : Partner Center → MyFabmesh.AI (Product ID 9PH6GT8XKQDW) → Certification report.
Deux échecs à corriger avant resoumission.

Dernière mise à jour : **2026-07-26** (passe de remédiation A / B / C, branche
`feat/r2-signed-urls`).

---

## 1. 10.8.2 — Achats in-app (« Credits ») — ACTION MANUELLE PARTNER CENTER ⚠️

Microsoft a détecté la vente de crédits hors de leur système de paiement.
Il faut **déclarer** ce comportement (pas le supprimer) :

1. Partner Center → MyFabmesh.AI → **créer une nouvelle soumission**
2. Section **Properties** → **Product Declarations**
3. Cocher : **« This app allows users to make purchases, but does not use
   the Microsoft Store commerce system »**
4. Sauvegarder. (La mention apparaîtra sous le bouton « Get » de la fiche.)

Réf : https://docs.microsoft.com/en-us/windows/uwp/publish/product-declarations

**État : RESTE À FAIRE (action humaine, aucun code impliqué).**

---

## 2. 10.1.2.10 — « Picture creation from AI » inutilisable

Cause racine : les testeurs MS utilisent des **Surface Laptop (aucun GPU
NVIDIA)**. Les moteurs d'images de l'app étaient 100 % locaux CUDA → la
fonctionnalité principale était physiquement intestable chez eux (et chez
la majorité des clients du Store).

Modèle produit final (décision du 25/07) :
- **GPU NVIDIA présent** → app 100 % locale, AUCUNE UI cloud (le toggle
  Compute est masqué). L'expérience desktop ne change pas.
- **Pas de GPU NVIDIA** (cas des testeurs MS) → mode Cloud affiché et forcé,
  génération via le worker MyFabmesh (compte + crédits), lien « Acheter des
  crédits » vers le SITE WEB (aucun achat in-app → cohérent avec 10.8.2).
- PAS de désactivation post-certification : comportement identique avant/après
  (exigence policy 10.1).

### 2.a — Socle matériel / process (fait avant cette passe) ✅

- `detectNvidiaGpu()` en Node au démarrage (cache session, IPC `gpu-status`),
  override de test `FABMESH_FORCE_NO_GPU=1`.
- `isCloudMode()` côté main : ceinture-bretelles matérielle — sans GPU NVIDIA
  le cloud est forcé même si le renderer n'a pas encore annoncé son mode.
- `_localPyLibsUsable()` (override `FABMESH_FORCE_NO_LOCAL_PY=1`) : aucun
  script Python n'est lancé sans venv IA ; les handlers renvoient un message
  produit anglais (`_localEngineMsg`), jamais une traceback.
- Retouches image en natif Electron (`_quickEditNative`) : crop, upscale,
  downscale, symmetrize, extend, brightness/contraste/saturation, facefix —
  couvre 100 % des opérations `runQuickEdit()` sans Python.
- SwiftShader / WebGL logiciel activé côté main.
- Wizard de premier lancement : mode Cloud proposé/forcé sans GPU.

### 2.b — Blocker A : passe renderer ✅ (fait le 2026-07-26)

| Point | État | Détail |
|---|---|---|
| A1 — `needsCloudLogin` sur TOUS les appels cloud | ✅ | Copie de surface de `window.meshyAPI` (`index2.js` ~l.74) qui enveloppe `_CLOUD_LOGIN_METHODS` (generateImages, imageTo3D, imageToTrellis, removeBackground, img2img, maskInpaint, autoInpaint, imageQuickEdit, meshTool, meshSegment, materialAdjust, resizeMesh, generateExplode3d, generateConstructionStages3d, autoRigAI, animKimodo, animateAI) : appel → modale de connexion → UN seul rejeu. `window._withCloudLogin(fn, …)` exposé pour les scripts non-module (`index2-edit-tools.js` → maskInpaint). `animKimodo` re-routé sur la copie `API` (il contournait l'interception). `loadMarket()` gère `needsCloudLogin` comme `loadMine()` (panneau + bouton Sign in). |
| A2 — outils sans route cloud masqués | ✅ | `_CLOUD_HIDDEN_TOOLS`, `_CLOUD_HIDDEN_MESH_TOOLS`, `_CLOUD_HIDDEN_LB3D_TOOLS`, `_BLENDER_TOOLS` + pendants lightbox. Vérifié À L'EXÉCUTION (voir §3). |
| A3 — WebGL | ✅ | `_mkRenderer(opts, hostEl)` (12 sites) + garde dans `lib/Viewer3D.js` : échec de contexte → encart « 3D preview unavailable on this device » au lieu d'une exception qui bloque l'app. Aucun `new THREE.WebGLRenderer` non gardé hors fichier `.backup_`. |
| A4 — moniteur GPU + encart VRAM | ✅ | `_gpuProbeAllowed() = _hasNvidia() && !_isCloudMode()` appliqué à `refreshGpuStats`, `checkGpuLimits`, `getCurrentVramUsedGB`, `hasVramHeadroomFor` ; le `setInterval(…, 500)` de `openSettings()` n'est plus armé. `_applyHardwareCardMask()` masque `#set-gpu-card` et insère « Generated on the MyFabmesh cloud — your GPU is not used. ». L'encart « ~7 GB en VRAM » du panneau de tâche est remplacé par le texte cloud. |
| A5 — chaînes françaises codées en dur | ✅ | `humanizeErrorMessage` déjà en clés anglaises. Cette passe a converti en clé anglaise + entrée fr (`lang/_additions2.js`) : toasts go-to (image/rig/import), lightbox source, resize, stages 2D/3D, Detail++, tampon de clonage 3D, re-texture de zone, sauvegarde de rig ajusté, marqueurs d'os, statuts de l'outil mesh (pivot / trous / non-manifold), garde-fous RAM Ultra-Q, **libellés du sélecteur de squelette** (Humanoide bipède → Biped humanoid, etc.) et **toutes les raisons de file d'attente GPU/RAM**. |

Restes connus, NON bloquants pour la certification (boutons masqués en mode
Cloud, donc invisibles pour le testeur) : le mode d'emploi « FBX Unreal →
Geometry Collection » (`index2.js` ~l.15194) et les libellés d'étapes
« Étape n/N — chantier » des stages 2D restent en français.

### 2.c — Blocker B : erreur 524 (cold start Modal) ✅ code / ⚠️ deploy

Symptôme : « image generation failed (credits refunded): Cloud GPU HTTP 524 »
— Cloudflare coupe toute sous-requête à 100 s alors qu'un conteneur Modal
froid met 2-3 min à démarrer. Le testeur tombait dessus au PREMIER clic.

Worker (`cloud/src/worker.ts`) :
- **Cause racine trouvée** : `/api/heartbeat` était *défini* mais **jamais
  routé** → `isUserOnline()` toujours faux → `preWarmCog()` no-op depuis
  toujours. Route ajoutée (GET+POST, non authentifiée, 1 PUT R2).
- `preWarmCog()` chauffait le mauvais backend (Replicate Cog) alors que la prod
  tourne sur Modal → conservé uniquement comme chemin de repli
  (`if (env.MODAL_TEXT2IMAGE_URL) return;`).
- `preWarmModal()` : GET `…/healthz` (timeout 120 s, erreurs avalées) avec
  garde « déjà chaud < 4 min » lue dans `_meta/last_warm_*.txt`. Chauffe
  text2image (toujours) et image_op/back_view (à la demande). Volontairement
  PAS mesh/rig/segment/anim (leurs routeurs Modal sont des dispatchers CPU).
- `preWarmTick()` = point d'entrée du cron (`scheduled()`), crons inchangés
  (`*/15` + hebdo).
- Retry 524 multi-coups (délais 60 s puis 90 s) porté dans
  `callModalText2Image` et `callModalTpose` (déjà présent dans
  `callModalImageOp`) ; message final honnête au lieu de « Cloud GPU HTTP 524 ».
- `POST /api/prewarm` (session obligatoire, `ctx.waitUntil`), ajouté à
  `MODAL_PATHS` pour respecter le kill switch admin `modal_enabled`.

Desktop (`src/main/cloud_fallback.js`) :
- `_withColdRetry(fn, {label, delayMs})` : détecte 502/503/504/524/timeout,
  affiche « Cloud GPU is starting up (cold start), retrying… » sur le canal
  `ai3d-progress`, attend **60 s** (pas 20 s : un 524 n'annule PAS la requête
  Modal ; rejouer trop tôt fait démarrer un SECOND conteneur froid par
  autoscale) puis rejoue **une seule fois**. Exclusions : `needsCloudLogin`,
  402 (crédits), 429 (quota).
- Pas de double débit : le worker rembourse crédits + budget Modal dans ses
  `catch` avant de répondre (vérifié endpoint par endpoint) — le rejeu est un
  appel neuf, seule la tentative qui aboutit est facturée.
- Message final si le rejeu échoue : « The cloud GPU took too long to start
  (cold start). Please try again in a minute — your credits were refunded. »
- Heartbeat desktop toutes les 2 min (`_startHeartbeat`, silencieux hors mode
  Cloud / sans session) + préchauffage 8 s après le démarrage en mode Cloud
  (`cloudFallback.prewarm()`, debounce client 4 min).

⚠️ **Le worker n'est PAS encore déployé.** Rappel projet :
`cd cloud && npm run build && npx wrangler deploy` (modifier `cloud/public/app/*`
sans `npm run build` ne sort JAMAIS en prod).

### 2.d — Correctifs ajoutés pendant la phase de vérification (2026-07-26)

- `ipcMain.handle('hidream-available')` appelait `nvidia-smi` sans tenir compte
  du mode : en simulation « sans GPU » l'option **HiDream-O1 (moteur LOCAL
  CUDA) restait dans le sélecteur de moteur d'images** → clic = échec = exactement
  le motif du refus 10.1.2.10. Retour immédiat `{available:false}` en mode Cloud
  / sans GPU NVIDIA.
- `ipcMain.handle('check-gpu')` : même garde côté main (le renderer avait déjà
  la sienne) — plus aucun `nvidia-smi` lancé en mode Cloud.

---

## 3. Parcours testeur simulé — VÉRIFIÉ le 2026-07-26

Lancement : `FABMESH_FORCE_NO_GPU=1 FABMESH_FORCE_NO_LOCAL_PY=1 electron .`

**`logs/fabmesh_start.log`** (extraits) :

```
[main] loading index2.html (setup done)
[compute-mode] cloud (aucun GPU NVIDIA détecté au démarrage)
[compute-mode] cloud
[main] NSFW scan: all 218 already decided (sidecars) — no AI run
```

**`logs/renderer.log`** (hors bruit NSFW, 4 lignes en tout) :

```
[engine] HiDream hidden — cloud mode (no local CUDA engine)
[main:compute-mode] cloud
```

Contrôles effectués (via l'API de test locale `127.0.0.1:7331`) :

- **Aucun process Python / `nvidia-smi`** lancé : `Get-CimInstance Win32_Process`
  filtré sur `python*` / `nvidia-smi*` → **0 résultat**.
- **Mode cloud actif** côté main ET renderer (`window._computeMode() === 'cloud'`).
- **Console renderer : 31 lignes, niveaux `{log: 31}` — 0 `error`, 0 `warn`.**
- **Option HiDream absente** du sélecteur (`#ws-engine option[value=hidream]` → nul).
- **Aucun élément visible** ne mentionne VRAM / CUDA / GPU ; la carte
  « Hardware » des réglages est masquée et remplacée par la note cloud.
- **Masquage des outils** (68 boutons `ws-*-btn` inspectés à l'exécution) —
  masqués : `age`, `anim-export`, `buildstages`, `mesh-aligntex`, `mesh-blender`,
  `mesh-center`, `mesh-detail-synth`, `mesh-enhance-tex`, `mesh-name`,
  `mesh-region-retex`, `mesh-subdivide`, `mesh-texvar`, `mesh-trellis2`,
  `multiview`, `recolor`, `rig-blender`, `rig-reskin`, `rig-test`, `rig-unreal`.
  Lightbox : `lb:age`, `lb:multiview`, `lb:recolor`, `lb3d:aligntex`,
  `lb3d:blender`, `lb3d:center`, `lb3d:enhancetex`, `lb3d:regionretex`,
  `lb3d:texvar`.
- **Croisement handler ↔ route cloud** : chaque bouton resté visible est soit
  routé vers le worker (`/api/*`, `mesh-op` whitelisté — dont `subdivide`), soit
  100 % local sans Python (canvas 2D + `save-image-data-url`, éditeur mesh
  three.js + `save-buffer`, ouverture de dossier, export GLB par copie ; les
  autres formats d'export sont désactivés en Cloud).
- **Helper `_withCloudLogin` testé à l'exécution** : une réponse
  `{needsCloudLogin:true}` ouvre bien la modale de connexion ; une annulation
  renvoie le résultat d'origine (message anglais) sans rejeu ; un appel sans
  `needsCloudLogin` est rendu tel quel (transparence en mode local).

Builds : `node --check` OK sur les 6 `.js` modifiés ; `cd cloud && npm run build`
OK (15 routes exportées) ; `npx tsc --noEmit` OK ; `npx wrangler deploy --dry-run`
OK (118 assets, 1 525 KiB).

**Aucun commit n'a été créé pendant cette passe** (`git status` : 10 fichiers
modifiés non commités).

---

## 4. Avant de resoumettre — checklist des actions HUMAINES

- [ ] Cocher la déclaration **10.8.2** (§1 ci-dessus) — Partner Center.
- [ ] **Déployer le worker** : `cd cloud && npm run build && npx wrangler deploy`
      (le correctif 524 / préchauffage n'existe qu'en local tant que ce n'est
      pas fait).
- [ ] Vérifier après déploiement : `POST /api/heartbeat` → 200, puis
      `POST /api/prewarm` avec une session → 200 immédiat, puis une génération
      d'image dans la minute qui suit (doit répondre sans 524).
- [ ] Committer + pusher la branche `feat/r2-signed-urls` (rien n'est commité).
- [ ] **Test d'installation réelle** du package sur machine propre (~5 Go,
      premier lancement, téléchargement des modèles) — resté à faire depuis la
      remédiation MSIX.
- [ ] Idéalement : test sur une VRAIE machine sans GPU NVIDIA (les overrides
      `FABMESH_FORCE_NO_GPU` / `FABMESH_FORCE_NO_LOCAL_PY` simulent le
      logiciel, pas le pilote graphique ni WebGL logiciel réel).
- [ ] Créer un compte de test MyFabmesh **avec des crédits offerts** et le
      fournir dans les « Notes for certification » (sans compte, le testeur ne
      peut rien générer en mode Cloud → risque de re-refus 10.1.2.10).
- [ ] Configuration matérielle recommandée dans la fiche Store : « GPU NVIDIA
      (8 Go VRAM) recommandé pour la génération 3D locale ; la création
      d'images fonctionne sans GPU (cloud) ».
- [ ] Soumission MANUELLE via Partner Center (l'API Azure AD de soumission est
      morte — compte MSA Graph, constaté en juillet).
- [ ] Audit de release 7 dimensions (règle projet) si version publique.

---

# Resoumission 1.0.13 — rapport de certification du 28/07/2026

## Le grief

`10.1.2.10 Functionality` — un seul point :

> Unusable Feature: Image generation failed - Error: The cloud GPU took too long
> to start (cold start). Please try again in a minute your credits were refunded.
> Observed On: Dell Inspiron 5379

## La cause (trouvée le 28/07)

Ce n'était pas le calendrier de rejeu, ni le message d'erreur. Le préchauffage
GPU **ne se déclenchait jamais au premier lancement** :

1. L'app démarre → 8 s plus tard `cloud_fallback.prewarm()` s'exécute.
2. `prewarm()` commence par `getAccessToken()` et sort sur `needsCloudLogin`
   quand aucune session n'existe. Au PREMIER lancement le testeur n'est pas
   encore connecté : **Modal n'est jamais contacté**.
3. `login()` ne déclenchait aucun préchauffage.
4. Le renderer n'appelait jamais le pont `cloudPrewarm`, pourtant exposé dans
   `preload.js` depuis le début.

Le premier clic du testeur payait donc systématiquement un démarrage à froid
complet (~3 min), que la fenêtre de rejeu (0 s / +60 s / +90 s) ne couvrait pas
toujours.

## Le correctif (1.0.13)

- `cloud_fallback.login()` déclenche `prewarm({force:true})` + `_startHeartbeat()`
  dès la connexion réussie. `force` contourne le débounce de 4 min qu'une
  tentative sans session vient d'armer.
- `src/renderer/index2.js` préchauffe au focus des champs `ws-prompt`,
  `np-prompt`, `ws-trellis2-preset`, `ws-asset-type` — le GPU démarre pendant
  que l'utilisateur tape sa description. Parité avec le web
  (`cloud-overrides.installPrewarm`).

⚠️ RISQUE RÉSIDUEL ASSUMÉ : si le testeur clique sur Generate dans les
secondes qui suivent sa connexion, la première tentative tombera encore sur un
conteneur en cours de démarrage. Les rejeux doivent alors la rattraper. D'où la
mention explicite du délai dans les notes ci-dessous.

## Notes for certification — texte prêt à coller (1.0.13)

```
This app works on machines WITHOUT an NVIDIA GPU. On such devices the setup
wizard detects the absence of an NVIDIA GPU and the app runs in Cloud mode:
image generation, 3D mesh generation, rigging and animation all run on the
MyFabmesh cloud service. No local AI model is downloaded or used.

IMPORTANT - PLEASE ALLOW TIME FOR THE FIRST GENERATION
Our cloud GPUs are started on demand rather than kept running, to keep the
service affordable. The FIRST image generation after a period of inactivity
therefore takes up to 3 minutes while a GPU container boots. The app shows a
progress bar and a "Warming up cloud AI" notice during this time - this is
normal, not a failure. Subsequent generations complete in about 30 seconds.

The previous submission was reported as failing with "The cloud GPU took too
long to start". This build fixes the underlying cause: the app now begins
warming a GPU as soon as you sign in, and again when you click into the
description field, so the container is ready before you press Generate.

Test account (already funded with credits):
  email:    <A REMPLIR>
  password: <A REMPLIR>

Steps to test image generation:
  1. Launch the app. The wizard shows "No NVIDIA GPU detected - Cloud mode will
     be used". Click "Continue in Cloud mode".
  2. Sign in with the test account above. (Signing in already starts warming a
     cloud GPU in the background.)
  3. Create a project, type any prompt, click "Generate".
  4. Wait for the progress bar to complete - up to 3 minutes on the very first
     generation, ~30 seconds afterwards.

In-app purchases: credits are sold on our website
(https://myfabmesh-cloud.fabien65400.workers.dev), never inside the app.
```

## À FAIRE AVANT DE SOUMETTRE

- [ ] Renseigner les identifiants du compte de test dans les notes ci-dessus
- [ ] Cocher la case 10.8.2 dans Partner Center (achats hors application)
- [ ] TESTER LE SCÉNARIO DU TESTEUR : basculer en mode Cloud, se déconnecter,
      se reconnecter, générer une image. C'est le seul moyen de valider le
      correctif avant de brûler un nouveau cycle de plusieurs semaines.

---

# Resoumission 1.0.14 — rapport de certification du 30/07/2026

## Le grief (NOUVEAU — différent de celui du 28/07)

`10.1.2.10 Functionality` :

> The app appeared to be unresponsive for a long time after launch. If the app
> has time-intensive operations to perform at launch, include a progress
> indicator in the splash screen.

Ce n'est plus le démarrage à froid du GPU cloud. C'est l'application elle-même
qui paraît figée au lancement.

## La cause

Au PREMIER lancement, Windows (Defender + Smart App Control) vérifie chaque
binaire du paquet : ~218 Mo, un `app.asar` de 130 Mo, Python embarqué et des
dizaines de `.pyd`. C'est long et on ne peut pas l'empêcher — c'est d'ailleurs
le même mécanisme que le popup SAC « Une partie de cette application a été
bloquée » observé en développement.

Hypothèses écartées en cours de route, pour mémoire :
- Le CSS bloquant du renderer : 193 Ko en local, négligeable.
- Un travail lourd dans le processus principal : `app.whenReady` crée déjà la
  fenêtre EN PREMIER, tout le reste est non bloquant et protégé.
- La fenêtre absente : `show:true` est déjà en place depuis un refus antérieur.

La fenêtre apparaît donc bien tout de suite… mais comme un rectangle sombre
vide, tant que la page n'a pas peint. D'où la perception « unresponsive ».

## Le correctif (1.0.14)

`createSplash()` / `closeSplash()` dans `src/main/main.js` : une fenêtre de
démarrage sans cadre, centrée, affichée AVANT tout le reste dans
`createWindow()`, fermée sur `ready-to-show` ET sur le watchdog de 8 s.

Choix de conception, tous délibérés :
- AUCUNE ressource externe (pas de CSS, pas d'image, pas de police) : tout est
  inline dans une `data:` URL, le même procédé que `showFallbackWindow` déjà
  éprouvé ici. Un splash qui attendrait un fichier serait ralenti par ce qu'il
  est censé masquer.
- Barre de progression INDÉTERMINÉE : on ne peut pas connaître l'avancement
  d'une analyse antivirus. Une barre chiffrée serait un mensonge de plus.
- Texte explicite : « The first launch takes longer while Windows verifies the
  application. This happens only once. »
- Tout sous try/catch + minuterie de sécurité de 180 s : ce splash ne doit
  JAMAIS pouvoir empêcher l'app de se lancer ni rester orphelin à l'écran.

Vérifié au lancement réel : l'app démarre normalement, aucune erreur splash
dans les logs, l'API de contrôle répond.

## Notes for certification — à ajouter au texte 1.0.13

```
ADDITION FOR THIS BUILD:
The previous review reported the app as unresponsive for a long time after
launch. The app now shows a splash screen with an animated progress indicator
immediately at startup, which stays until the main window has finished
painting. It also explains that the first launch is slower because Windows
verifies the application package (~218 MB) the first time it runs.
```
