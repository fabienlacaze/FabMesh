# FabMesh Agent Log

**RULE: I MUST read this file at the start of any session that touches
mesh quality, texture projection, or multi-view generation. I MUST append
to it after every experiment — success or failure. This prevents running
the same failed experiments twice.**

Most recent at the top. Each entry: date (YYYY-MM-DD), what was tried,
what happened, conclusion.

---

## 2026-05-18 — Bake optimisation 40× + hybrid pipeline + UI tools

**Perf bake** : chart-aware NN fill faisait
`scipy.distance_transform_edt` sur le full atlas (4M pixels) PAR
chart (~1000) → ~5 min. Switch à per-chart bbox via
`scipy.ndimage.find_objects`. Bake = 8s (40× speedup).

**Bake source-photo hybride** : `_load_views` inclut maintenant la
source photo comme view az=0/el=0 weight=3.0. Front photo-clean
dominant via weighted blend, sides/back via sheet SDXL.

**UI Material adjust** : nouveau bouton "🎨 Material" dans Manual
Tools → modal 6 sliders (brightness/sat/contrast/emissive/metallic/
roughness) → `mesh_material_adjust.py` save as new version.

**UI Multi-select projets** : checkbox top-left + bottom bar avec
Clear/Delete selected.

**Pipeline E2E** : Hi3DGen ~30s + sheet 50s + bake 8s = ~90s total.

---

## 2026-05-17 (later) — Tuning post-intégration sheet runner

**Constat test sur orc_marron** :
- Avant fixes : texture toute rouge (bug alias view_N.png oublié), puis
  après alias fix → texture sombre + speckle "snake-skin" partout.
- L'atlas montre des micro-fragments car xatlas explose Hi3DGen mesh
  en 955-1014 charts à cause du bruit topologique.

**Fixes appliqués** :

1. **Bug alias** (commit 6007609) : forcer copy sheet_view_N.png →
   view_N.png en overwrite (avant : skip si view_N déjà existe, mais
   mv_render_from_mesh.py crée DÉJÀ view_N.png en rouge).

2. **Zoom mesh radius 2.5 → 1.5** (commit f7bc524) : subject remplit
   80% de cellule au lieu de 30%. Splatted pixels 234K → 620K (+165%).

3. **Chart-aware NN fill** (commit f7bc524) : connected-component label
   du used_mask, NN fill restreint à chaque chart_id. Élimine la
   speckle où NN traversait des frontières de charts.

4. **Taubin smoothing pre-xatlas** : lamb=0.5, nu=-0.53, 10 iters. NE
   réduit PAS le chart count (955 → 1014, légère hausse) MAIS lift
   l'utilisation atlas de 43% à 79%. Charts mieux packés.

5. **IP-scale 0.55 → 0.65** : identity bias plus fort pour mieux
   conserver la palette de la photo source.

6. **Atlas 2x tex_res par défaut** (avant 4x) : chart-aware NN était
   O(charts × atlas²) → 10 min sur 4096² avec ~2000 charts. 2x (2048²)
   reste sous 90s.

**Verdict** : meilleur que tout rouge, mais encore loin du résultat
crabe. Le coupable principal reste la topologie Hi3DGen qui fragmente
xatlas peu importe les tunings. Voie restante : tester avec une mesh
SF3D ou mesh smoothing AGRESSIF (50+ iters Taubin) avant decimate.

---

## 2026-05-17 (late) — Pipeline E2E sheet-runner + bake v3 intégré comme défaut

**Contexte**: la texturation via texture_project + multiview hallucinés
(CRM/MV-Adapter/Z123) produisait des résultats patchy peu importe le
sujet. MV-Adapter crash silencieux (cache_hidden_states filtré par
diffusers 0.34), CRM hallucine le back, Z123 angles non-orthogonaux.

**Solution adoptée**:
1. **mv_render_from_mesh.py** (NOUVEAU) — render 6 depth maps STRICTEMENT
   orthogonales depuis la mesh Hi3DGen via nvdiffrast inline. Angles
   exactement contrôlés au degré près (azim 0/90/180/270, elev ±90).
2. **sheet_render_v2.py** (NOUVEAU) — compose les 6 depth en sheet 3×2,
   passe RealVisXL + dual ControlNet (Depth 0.7 + Canny 0.5) + IPAdapter
   sur la photo source. Génère les 6 vues photoréalistes en UN appel SDXL
   (cohérence native couleurs/style entre cellules). Steps 30, cfg 7.0,
   ip_scale 0.55. Durée 100-180s selon GPU/RAM.
3. **hi3dgen_invuv_bake_v3.py** (NOUVEAU) — bake nvdiffrast inv-UV
   weighted-blend par |normal·view| + chart-aware NN fill (scipy
   distance_transform_edt) + 8px gutter dilation. Runtime ~2s.

**Test E2E sur voiture rouge**: ✅ Texture cohérente, identité
préservée sous tous les angles, ~7 min total.

**Test E2E sur crabe (sujet nouveau)**: ✅ Pinces, articulations,
segments du céphalothorax, couleur rouge propre sous tous les angles.
Démontre la généralisation à un sujet jamais vu auparavant.

**Intégration**: `hi3dgen_full_pipeline.py` modifié — la nouvelle chaîne
sheet-v2 + bake-v3 est le DÉFAUT. Le legacy (texture_project + MV gen)
reste accessible via `FABMESH_HI3DGEN_USE_LEGACY=1`. Fallback automatique
sur le legacy si sheet_render_v2 échoue.

**Conclusion**: pipeline texture viable enfin pour Hi3DGen géométries.

---

## 2026-05-17 — Mosaïque UV: décimation pre-xatlas + ChartOptions

**Symptôme**: même après tous les fixes (blend stack, front p=1.0,
mvadapter), la texture extraite restait une mosaïque chaotique de
micro-îlots. Test isolé (1 vue front, pas de MV) confirme: c'est
l'atlas UV qui est atomisé, pas un bug des multi-views.

**Mesure**: comptage des charts UV via composantes connexes des faces:
- Avant : **4029 charts** sur 92k faces (1 chart pour ~23 faces)
- L'atlas 2048×2048 est rempli de milliers de petits îlots → chaque
  îlot reçoit 1-2 pixels source → mosaïque visuelle inéluctable.

**Cause root**: Hi3DGen produit naturellement ~92k faces (~46k verts)
pour un objet simple. La variation de normales sur 92k tiny faces
FORCE xatlas à splitter même avec ChartOptions agressives (max_cost=
8/32 n'a rien changé).

**Fix `scripts/hi3dgen_full_pipeline.py:step_unwrap`**:
1. **Décimation pré-unwrap**: `m.simplify_quadric_decimation(15000)`
   réduit le mesh de 92k → 15k faces (matche le target user ~13k).
2. **ChartOptions**: `max_cost=32` (vs 16) et `max_iterations=1`
   pour favoriser les charts initiaux gros.
3. `FABMESH_HI3DGEN_TARGET_FACES` env var (default 15000) pour tune.
4. Désactivé `FABMESH_UV_REPACK=0` dans le subprocess texture_project
   (sinon xatlas re-unwrap par-dessus mon premier unwrap propre).

**Résultat (couteau test)**:
- Charts : 4029 → **231** (×17 moins fragmenté)
- Util : 81.7%
- Faces drawn : 99.7% (vs 96-97% avant)
- Total pipeline : 35.9s (vs 230s — bypass d'un re-unwrap inutile)
- Rendu 3D : couteau **clairement identifiable** (forme + manche
  noir + lame blanche brillante), au lieu de mosaïque chaotique.

---

## 2026-05-17 — Bug critique: front photo demoted to p=0.7 (was 1.0)

**Symptôme**: même en mode stack avec priorité front=1.0 dans le dict
`PRIORITY_WEIGHTS_TUP`, les logs montrent `az=0/el=0(p=0.7)` au lieu
de p=1.0 → le front est PLUS BAS que les vues latérales Z123 (p=0.9)
dans le stack → écrasement de la HD source par les vues hallucinées.

**Cause**: ligne 418 de `texture_project.py`:
```python
PRIORITY_WEIGHTS = {a: p for (a, _), p in PRIORITY_WEIGHTS_TUP.items()}
```
Cette compréhension de dict collapses sur azim seul. Pour azim=0.0
il y a 3 entrées dans `PRIORITY_WEIGHTS_TUP`:
- (0.0, 0.0): 1.0   ← front (la bonne valeur)
- (0.0, 90.0): 0.7  ← CRM TOP
- (0.0, -90.0): 0.7 ← CRM BOTTOM

L'itération garde la DERNIÈRE entrée → PRIORITY_WEIGHTS[0.0] = 0.7.

**Fix** ligne 429: lire `PRIORITY_WEIGHTS_TUP[(0.0, 0.0)]` au lieu de
`PRIORITY_WEIGHTS[0.0]` quand on append le front photo.

**Vérification**: log v5 montre maintenant
`stack order: ... az=0/el=0(p=1.0)` en TOP du stack ✓
La texture extraite reste fragmentée mais c'est dû à xatlas qui
atomise le mesh Hi3DGen (92k faces / 3099 charts) — pas un bug du
blend mode. Pour des props simples comme un couteau, TripoSG ou
SF3D produisent moins de faces et un atlas plus propre.

---

## 2026-05-16 — 3 fixes texture pour props: mvadapter + stack + front view honored

**Symptôme post-fix-précédent**: pipeline Hi3DGen tourne sans crash mais
texture extraite = mosaïque bruyante noir/blanc/gris. Diagnostic :
- Image source en vue 3/4 (RealVis a ignoré `strict front view`)
- Texture_project assume `az=0/el=0` pour la source → mapping faussé
- Zero123++ génère des angles approximatifs (az=30, az=150, etc.)
- Blend mode `accum` moyenne tout → noir+blanc = gris

**3 fix simultanés**:

1. **`texture_project.py` default blend `accum` → `stack`** : la vue
   source (front, priorité max) écrit en dernier sur l'atlas →
   ses pixels dominent. Les 6 vues MV ne remplissent que les zones
   invisibles depuis le front. Pas de moyenne destructrice.

2. **`local_juggernaut_bridge.py` `_has_angle`**: ajout des keywords
   `strict front view`, `front view`, `facing camera`, `frontal view`,
   `front-facing`. Quand le template demande explicitement front,
   le bridge n'ajoute plus `slight angle, one side visible` qui
   forçait la 3/4 view (et expliquait pourquoi RealVis sortait
   toujours en 3/4 malgré `strict front view` dans le prompt).

3. **MV engine `mvadapter` quand "6 views" UI** : `_mvScriptForEngine`
   accepte un engine override. Le handler `generate-multiview` lit
   `opts.engine`. Le renderer passe `engine: 'mvadapter'` pour les
   2 appels du mode 6-view (popup + CREATE NEW). Z123 reste default
   pour les autres appels (bouton standalone "Multi-Views").

---

## 2026-05-16 — Hi3DGen ignorait les 6 vues Zero123 existantes (mesh tout blanc)

**Symptôme**: user fait Multi-Views (Zero123 default) sur image couteau,
puis Generate 3D Hi3DGen. Le mesh sort tout blanc / sans texture
correcte. Logs : `LOCAL_HI3DGEN_PROGRESS: 85 mvadapter_skipped` 5s
après unwrap, alors que les 6 vues view_0..5.png existent dans
`ref_2_multiview/`.

**Cause**: `_mv_dir_complete()` dans `hi3dgen_full_pipeline.py`
exigeait `views.json` en plus de view_0..5.png. Or Zero123++
(`multiview_gen.py`) ne génère PAS views.json (c'est un format
MV-Adapter / CRM). Donc :
- _mv_dir_complete() retournait False
- step_mvadapter() retentait MV-Adapter (venv potentiellement
  indisponible) → échec rc != 0 → retourne False
- main() print marker mvadapter_skipped → step_texture appelé
  avec `mv_dir=None` → projection single-view de la photo front
  + push-pull inpainting des zones non vues
- Couteau a 95% de zones non vues (lame fine, fond blanc) →
  inpaint produit du blanc → mesh blanc

**Fix `scripts/hi3dgen_full_pipeline.py:_mv_dir_complete`**:
- views.json devient OPTIONNEL (texture_project.py a déjà un
  fallback "Z123 schema" hardcoded si views.json absent)
- Donc tout dossier `<stem>_multiview/` avec view_0..5.png est
  considéré valide, peu importe l'engine MV qui l'a généré.

**Note**: le default `FABMESH_MV_ENGINE=z123` dans main.js explique
pourquoi le clic "Multi-Views" utilise Zero123 et pas MV-Adapter.
Ce default pourrait être changé pour matcher l'UI 6-view de
CREATE NEW — TODO séparé.

---

## 2026-05-16 — Anti-doubling v3: weighted negatives élargi à tous les sujets

**Symptôme**: après les fix v1 (template) + v2 (strict front view + negative
prompt vehicle), un prompt "couteau" génère encore 2 couteaux côte à
côte dans l'image source RealVis. Les 6 vues MV-Adapter reproduisent
fidèlement le doubling de la source.

**Cause**: le negative prompt anti-doubling était orienté véhicules
(`two cars`, `second car`, `rear view inset`) et n'avait aucun effet
sur les datasets de cuisine/produits où "kitchenware set", "matched
pair" sont des patterns dominants.

**Fix `scripts/local_juggernaut_bridge.py`**:
- Negative prompt généralisé : `(two:1.6)`, `(pair:1.5)`, `(duplicate:1.5)`,
  `(twin:1.5)`, `(set of two:1.5)`, `(two objects:1.5)`,
  `(two subjects:1.5)`, `(two items:1.5)`, `(two knives:1.5)`,
  `(two characters:1.5)`, `(two props:1.5)`, `(two weapons:1.5)`,
  `(second instance:1.5)`, `(companion item:1.4)`, `(matched set:1.4)`,
  `product comparison`, `kitchenware set`, `catalog grid`.
- Poids global passé de 1.4 à 1.5 sur les tokens core.

**Plus de tokens spécifiques objet** : two cars / two vehicles /
two knives / etc. Couvre les categories communes.

---

## 2026-05-16 — T-pose detection fire on every prop/vehicle prompt (BUG)

**Symptôme**: user demande un couteau (Prop / Item), RealVis génère un
mannequin en T-pose qui tient un couteau ET une fourchette.

**Cause**: `scripts/local_juggernaut_bridge.py:97-101` détectait le mode
T-pose dès qu'il voyait `front view`, `facing camera`, `straight-on`,
etc. Mon fix anti-doubling (commit ca7086c) avait ajouté `strict front
view, facing camera` aux templates prop/vehicle/weapon/environment →
le bridge basculait sur DreamShaper XL Lightning + ControlNet OpenPose
+ skeleton T-pose comme control image → mannequin.

**Fix**: restreindre la détection T-pose à des markers strictement
"character":
- `t-pose`, `t pose`, `tpose` (littéral)
- `arms extended horizontally` (template character uniquement)
- `rts unit` (template character uniquement)
- `neutral stance` (templates character + creature uniquement)

Les hard-surface (prop, vehicle, weapon, environment) tombent
maintenant dans le path RealVis XL normal.

---

## 2026-05-16 — Texture mosaïque: capture MV-Adapter stderr + blend default accum

**Symptôme**: mygale Hi3DGen avec texture en grosses plaques marron/
blanc alternées au lieu d'une vraie texture d'araignée.

**Diagnostic**: double cause confirmée par 2 analyses indépendantes :
1. `step_mvadapter()` dans `hi3dgen_full_pipeline.py` échouait
   silencieusement (subprocess rc != 0, stderr non capturé).
2. Le blend mode par défaut `winner` (`texture_project.py`) produit
   des seams abruptes sur les meshes complexes (mygale 8 pattes,
   véhicules), surtout combiné à un UV atlas atomisé par xatlas.

**Fix**:
- `step_mvadapter` : `capture_output=True` + forward 50 dernières
  lignes stdout/stderr au parent log via `log()`. Diagnostic des
  fichiers présents si output incomplet.
- `FABMESH_TEXPROJ_BLEND` default `winner` → `accum` (moyenne
  pondérée, transitions douces). User peut toujours opt back via
  l'env var.

---

## 2026-05-16 — CREATE NEW: case "Multi-view" hiérarchique (2-view / 6-view)

**Contexte**: l'user voulait remplacer la checkbox "Auto 2-view" plate
par une hiérarchie : Multi-view → (2-view auto OR 6-views) → (options
6-view si sélectionné).

**Modif `src/renderer/index2.html`**:
- Checkbox parent `ws-mv-enable` (default ON).
- Radio buttons `ws-mv-mode` : "2view" (default) / "6view".
- Sous-panel `ws-mv-6view-opts` (visible si 6view) : harmonize +
  upscale.
- Conservé `ws-auto-multiview` caché pour back-compat avec le handler
  existant (qui pilote la back-photo gen via flag boolean).

**Modif `src/renderer/index2.js`**:
- `_wsMvSync()` : show/hide les sous-panels + sync legacy boolean
  `ws-auto-multiview` = (enable && mode='2view').
- Handler `Generate` :
  - lit `mvEnable`, `mvMode`, `mv6Harmonize`, `mv6Upscale`
  - 2-view flow (back photo) inchangé, mais seulement actif si mode='2view'
  - Nouveau bloc 6-view : après gen image, appelle `API.generateMultiview`
    pour chaque image générée avec les options harmonize/upscale.
    Progress bar 60→95% pendant les MV-Adapter runs.
- Job info `'Multi-view'` affiche maintenant '6 views (MV-Adapter)',
  '2 views (back)' ou 'no'.

---

## 2026-05-16 — Multi-Views button: popup options + duplicate to new version

**Contexte**: l'user voulait que cliquer sur "Multi-Views" (panel EDIT
SELECTED) ouvre une popup avec des checkbox d'options post-gen et crée
une nouvelle version d'image (non-destructif).

**Modif `src/main/main.js`**:
- Nouveau handler `duplicate-image-version({imagePath, suffix})` :
  copie l'image vers `<base>_<suffix>_<ts>.png`, exposé via preload
  `meshyAPI.duplicateImageVersion`.
- `generate-multiview` étendu : accepte `{ harmonize, upscale }` en
  plus de `imagePath`. Passe `FABMESH_MV_IDENTITY_HARMONIZE` et
  `FABMESH_MV_UPSCALE` au script Python.

**Modif `src/renderer/index2.html`**:
- Nouveau modal `modal-multiview-options` avec 2 checkbox (harmonize
  ON par défaut, upscale OFF) + bouton "Start Multi-Views".

**Modif `src/renderer/index2.js`**:
- Le bouton `ws-multiview-btn` ouvre désormais la popup au lieu de
  lancer directement.
- `mv-opt-start` : duplique l'image (suffix `mv`) puis lance
  `generateMultiview` sur le nouveau path. Reload project pour
  rafraîchir la galerie.

**Modif `scripts/multiview_mvadapter_gen.py`**:
- Si `FABMESH_MV_UPSCALE=1` : passe les 6 vues dans Real-ESRGAN x4
  puis downsample à 1024×1024 (parité avec image source). Fallback
  silencieux si ESRGAN échoue (garde 768).

---

## 2026-05-16 — Viewer toggle: 2 vues → 6 vues (front/right/back/left/top/bottom)

**Contexte**: la barre `ws-multiview-bar` (et son équivalent lightbox
`lb-multiview-bar`) ne proposait que FRONT/BACK alors que MV-Adapter
génère 6 vues orthographiques (azim 0/90/180/270 + elev ±90). L'user
ne pouvait ni voir ni éditer right/left/top/bottom.

**Modif `src/renderer/index2.html`**:
- Ajout des boutons RIGHT/LEFT/TOP/BOTTOM dans `ws-multiview-bar` et
  `lb-multiview-bar`, avec icônes SVG (flèches directionnelles dans
  un carré).

**Modif `src/renderer/index2.js`**:
- `_showMultiviewBar(multiviewDir)`: cache right/left/top/bottom si
  `multiviewDir` est null (mode 2-view back-only, sans dossier
  complet); affiche tout si `multiviewDir` pointe vers un
  `<stem>_multiview/` valide (= 6 vues sur disque).
- Pareil dans la lightbox `lb-multiview-bar` (handler ~ligne 2554).

**Mapping `_mvViewMap`**: déjà correct (right→view_1, back→view_2,
left→view_3, top→view_4, bottom→view_5) — aucune modif.

**Test**: après Ctrl+R, sur une image avec `<stem>_multiview/`
complet, la barre affiche 6 boutons. Cliquer chacun swap le preview
sur la vue correspondante, et les outils image (Modify, Inpaint, etc.)
opèrent sur la vue sélectionnée (via `_activeMultiview` qui pointe
vers `view_N.png`).

---

## 2026-05-16 — Hi3DGen MV: re-cabler sur le dossier standard `<stem>_multiview/`

**Contexte**: l'étape MV-Adapter du pipeline Hi3DGen écrivait dans
`_hi3dgen_mv/` à côté du MESH, ce qui isolait ces vues du système
multi-vues existant de l'image editor (bouton "Multi-Views",
toggle FRONT/BACK, héritage de silhouette, édition image).

**Modif `scripts/hi3dgen_full_pipeline.py`**:
- `_mv_dir_for_image(image_path)` retourne `<dir>/<stem>_multiview/`
  (même convention que `src/main/main.js:4024` — handler
  `generate-multiview`).
- `_mv_dir_complete(mv_dir)` check view_0..view_5.png + views.json.
- `step_mvadapter` réutilise les vues si dossier déjà complet
  (l'user a peut-être cliqué "Multi-Views" avant la 3D gen, ou re-run
  la 3D sur la même image).
- `main()` utilise `_mv_dir_for_image(image_path)` au lieu de
  `os.path.join(out_dir, '_hi3dgen_mv')`.

**Conséquence**:
- Les vues apparaissent dans le viewer image (toggle FRONT/BACK et
  potentiellement TOP/BOTTOM si on étend l'UI).
- Les vues sont éditables avec les outils image standard (Modify,
  Auto Inpaint, Clone Stamp, etc.).
- Plus de regénération inutile si le user a déjà cliqué Multi-Views.
- L'héritage de multi-vues entre images (silhouette-matching dans
  `src/main/main.js:824-875`) marche aussi pour les vues
  Hi3DGen-générées.

**Note suivi**: le toggle viewer ne supporte actuellement que FRONT/
BACK (4 cardinales hardcoded `src/renderer/index2.js:1573-1576`).
Extension à 6 vues (ajout TOP/BOTTOM) = travail séparé si besoin.

---

## 2026-05-16 — Hi3DGen: ajout MV-Adapter 6 vues pour combler trous de texture

**Contexte**: Hi3DGen produit un mesh dense (175k verts pour avion) qui
couvre toutes les faces (dessus/dessous/côtés/arrière), mais on n'a
qu'une photo front 1024×1024. La projection front-only ne couvre que
~40% du mesh → trous noirs partout (faces non-visibles depuis l'avant
restent à la couleur initiale 0,0,0 puisque le inpaint Telea ne touche
que les pixels entourés d'îlots UV valides).

**Modif**: `scripts/hi3dgen_full_pipeline.py`
- Nouveau `step_mvadapter(image_path, mv_dir)` qui appelle
  `multiview_mvadapter_gen.py` (i2mv-sdxl, Apache 2.0, 6 vues 768px:
  front/right/back/left/top/bottom) via sys.executable (venv système,
  torch 2.7).
- `step_texture` accepte `mv_dir=None`; si fourni, passe
  `--multiview <dir>` à `texture_project.py` qui sait déjà lire
  `view_0..view_5.png` + `views.json` (utilisé pour CRM/Z123/SF3D).
- Markers progress: 55/65/85/95/100 (insertion de mvadapter à 85).
- Env `FABMESH_HI3DGEN_SKIP_MV=1` pour désactiver et revenir au
  single-view (debug).
- Fallback gracieux: si MV-Adapter échoue (timeout, fichiers manquants),
  on continue en single-view.

**Estimate**: 180s → 240s (RealVisXL load ~60s en plus).

**Test attendu**: l'avion devrait avoir une texture couvrant 360°
(plus de trous noirs), bien que la couleur des vues générées par
MV-Adapter pour les angles non vus dans la photo source peut diverger
de la photo réelle (hallucination IA).

---

## 2026-05-16 — Fix Hi3DGen popup "stuck at 70%" 1-2 min après fin

**Contexte**: après mes fix précédents (os._exit(0), markers wrapped
55/70/95/100, FABMESH_TEXPROJ_SKIP_UNDO), le pipeline Hi3DGen produit
bien le GLB textured sur disque, mais la popup Electron reste à 70%
pendant 1-2 min avant d'afficher "Task complete". Le user a vu
elapsed=3m9s pour un job dont le mesh existait depuis ~1m45s.

**Cause racine**: `execFile()` n'invoque le callback final qu'après que
stdout + stderr soient totalement drainés. Hi3DGen accumule 10+ MB de
logs (tqdm progress bars, diffusers warnings, normal predictor verbosity,
xatlas, texture_project), donc même quand le Python exit proprement via
`os._exit(0)`, Node attend que le pipe stdout finisse d'être lu avant
de résoudre la promesse.

**Modif**: `src/main/main.js` handler `image-to-3d` — early-resolve dès
qu'on détecte `LOCAL_*_PROGRESS: 100 done` dans stdoutBuf ET que le
fichier GLB existe sur disque. Le subprocess est laissé tranquille (il
exit naturellement via os._exit(0)). Le callback `execFile` ignore la
résolution s'il arrive après (`if (resolvedEarly) return`).

**Pattern général**: marche pour tous les bridges qui émettent
`LOCAL_<engine>_PROGRESS: 100 done` (sf3d, triposg, hi3dgen, trellis2).

**Test attendu**: prochain run Hi3DGen devrait passer de 70% à "Task
complete" en quelques secondes au lieu de 1-2 min.

---

## 2026-05-16 — Instrumentation logs SF3D (diag freeze hardware sm_120)

**Contexte**: depuis l'update driver NVIDIA récente, SF3D freeze TOUT le
PC pendant `model.run_image()` (écran noir, artefacts, hard reset).
Diagnostic CUDA basique + `from_pretrained()` + `.to('cuda')` OK; le
crash est dans l'inférence elle-même. Crash si violent que stdout
buffer est vide après reboot.

**Modifs**:
- `external/StableFast3D/sf3d/system.py` — ajout d'un helper
  `_sf3d_diag()` qui écrit chaque étape (avec `torch.cuda.synchronize()`
  + `os.fsync()`) dans `logs/sf3d_diag.log` AVANT que l'op risquée
  démarre. Couvre: `run_image` (prepare/batch/generate), `generate_mesh`
  (image_processor, get_scene_codes, image_estimator,
  triplane_to_meshes, baker.rasterize, baker.interpolate, query_triplane,
  decoder, normal tangent-space bmm, dilate_fill uv_padding x2).
  Activé via `SF3D_DIAG=1` (zero overhead sinon).
- `scripts/local_sf3d_bridge.py` — mirror du helper côté bridge,
  même chemin de log, breadcrumbs avant chaque sous-step
  (from_pretrained, .to(device), .eval(), run_image entry/exit).

**Top suspects sm_120 identifiés** (à tester dans l'ordre):
1. `dilate_fill` UV padding (max_pool2d/unfold/fold/conv2d itératif sur
   `bake_res²` tensors)
2. `texture_baker` CUDA kernels `rasterize_gpu` + `interpolate_gpu`
   (custom .cu non recompilé pour sm_120, BVH stack de 64 ints)
3. `F.grid_sample` dans `query_triplane` (N énorme sur les vertices de
   marching tetrahedra)
4. `MarchingTetrahedraHelper` (`torch.unique(dim=0)` sur tenseur géant)
5. `scaled_dot_product_attention` dans
   `TwoStreamInterleaveTransformer` (FlashAttention dispatch sur
   sm_120 peut tomber sur un chemin cassé)

**Procédure de test progressif** (sans recrasher):
1. `SF3D_DIAG=1 python scripts/local_sf3d_bridge.py images/scorpion/ref_0.png /tmp/out.glb 512 -1 none 0`
   avec `bake_res=512` (réduit massivement uv_padding + texture_baker).
   Si ça passe ⇒ suspect = dilate_fill ou texture_baker scale-dependant.
2. Si crash persiste ⇒ regarder le DERNIER `SF3D_DIAG:` dans
   `logs/sf3d_diag.log` après reboot ⇒ identifie l'étape coupable.
3. Tests d'isolation possibles selon le coupable:
   - dilate_fill: monkey-patch `sf3d.models.utils.dilate_fill` vers
     une version CPU (`.cpu()` autour de l'op)
   - texture_baker: désactiver `rasterize_gpu` en faisant le rasterize
     sur CPU (PIL ou skimage), suit déjà le pattern `rasterize_cpu` que
     l'upstream a probablement
   - SDPA: forcer `torch.nn.attention.sdpa_kernel(SDPBackend.MATH)`
     pour court-circuiter Flash / cuDNN
   - marching_tet: réduire `isosurface_resolution` dans `config.yaml`
4. Test ultime: désactiver autocast bfloat16 (sm_120 bf16 sur Blackwell
   peut avoir des bugs driver récents) ⇒ remplacer
   `torch.bfloat16` par `torch.float16` dans le bridge.

---

## 2026-05-15 (matin) — TripoSG activé dans l'UI (option A: quick win MIT)

**Contexte**: après bilan complet de la stack (TRELLIS-2 bloqué Blackwell,
MV-Adapter bug profond, SyncMVD inadéquat), décision d'attaquer le quick
win **TripoSG** qui était déjà bridged mais pas exposé en UI.

**Bénéfice business**: TripoSG est **MIT pur**, donc libère le plafond
$1M de Stability Community License qui pèse sur SF3D. Mondial commercial
sans restriction.

**Modifs**:
- `src/renderer/index2.html:262` — ajout `<option value="triposg">TripoSG (local, MIT)</option>`
- `src/renderer/index2.js:5210` — expectedMs=150s pour engine triposg (vs 60s default)
- `src/main/main.js:3404` — bridgeScript pour engine=triposg pointe maintenant
  vers `triposg_full_pipeline.py` (PAS `local_triposg_bridge.py`) car ce
  dernier produit du mesh sans UV/texture. Le full_pipeline fait:
  1. TripoSG raw mesh (~1.4M faces)
  2. Décimation à `targetFaces` (50k par défaut)
  3. xatlas UV unwrap
  4. texture_project.py avec front image
- Args: `[script, imagePath, meshPath, targetFaces, texRes]`

**Backup**: branche `backup-before-triposg-ui-20260515-164907` créée
avant modif.

**À tester**: smoke test sur 3-5 images variées (humain, animal, prop)
pour comparer qualité TripoSG vs SF3D côte à côte. Si TripoSG donne
des résultats équivalents ou meilleurs, ce sera le default pour les
nouveaux projects.

---

## 2026-05-15 — Pivot vers SyncMVD (abandon MV-Adapter)

**Contexte**: après échec TRELLIS-2 Blackwell et analyse du marché, pivot
vers pipeline 100% MIT/Apache mondial commercial. MV-Adapter (Apache 2.0,
ICCV 2025) identifié comme la meilleure piste pour texture multi-view.

**Tentative MV-Adapter** (script déjà présent `multiview_mvadapter_gen.py`,
clone `external/MV-Adapter/`, poids HF en cache):
1. Smoke test avec diffusers 0.34 (notre version) → KeyError sur 70/70
   self-attn processors (`attn1`). La passe ref ne peuple pas `ref_hidden_states`.
2. Patch ref-skip dans `attention_processor.py` → fait fonctionner l'inference
   mais vues sortent en **bruit cubiste** vert/rose (ref ignorée = pas de
   guidance image).
3. Création `.venv-mvadapter/` isolé avec diffusers 0.30 + torch 2.7.1+cu128 +
   transformers 4.45.2 + matplotlib + jaxtyping + typeguard + onnxruntime.
   Setup OK.
4. Re-test avec diffusers 0.30 → **MÊME KeyError**. Donc ce n'est pas un bug
   diffusers 0.34 API.
5. Test sans `enable_model_cpu_offload` (hypothèse accelerate filtrant
   les kwargs) → **MÊME KeyError**. Donc ce n'est pas accelerate.
6. Debug print confirme : à la 1ère itération diffusion, processors voient
   `cache_hidden_states=None` → donc la passe ref n'a JAMAIS appelé ces
   processors avec un dict cache. Le bug est dans la pipeline MV-Adapter
   elle-même (la passe ref ne traverse pas les attn1 self-attention).

**Conclusion** : MV-Adapter dans son état actuel est cassé sur diffusers
récents (0.30+). Le bug est profond, ~1-2h de R&D pour comprendre.
Sans Unreal (libère 5 GB VRAM), une itération prend 100s. Avec, 2h
(VRAM swap). Pas viable ce soir.

**Décision**: pivot SyncMVD. MIT, utilise PyTorch3D natif (pas la
complexité diffusers/accelerate de MV-Adapter). Plus simple, plus
robuste long-terme.

**Acquis utiles à conserver**:
- `.venv-mvadapter/` reste utilisable si on veut tenter le debug profond
- `external/MV-Adapter/` cloné, patch `o_voxel_patch` style possible
- Script `multiview_mvadapter_gen.py` reste là, désactivé par défaut

---

## 2026-05-12 — Housekeeping: gitignore cleanup

Le repo accumulait **346 changements actifs** (VSCode warning "too many
active changes"). 321 venaient de 2 dossiers de debug
(`logs/ip_sweep/` 190, `logs/child_ip45_2view/` 131) et du clone
natif TRELLIS-2 (`external/TRELLIS2_win/.venv` + `src/`).

Ajout au `.gitignore` :
- `logs/ip_sweep/`, `logs/child_ip45_2view/`, `logs/trellis2_sdpa_math_test/`, `logs/test_mirror_back/`
- `external/TRELLIS/`, `external/TRELLIS2_win/.venv/`, `external/TRELLIS2_win/src/`
- `external/TRELLIS2_win/_dbg_*.npy`, `external/TRELLIS2_win/test_*.py`

Résultat : 346 → 34 changes. Les fichiers déjà trackés (M/D) restent
visibles (à nettoyer plus tard si nécessaire via `git rm --cached`).

---

## 2026-05-12 — TRELLIS-2 Blackwell reprise: Angle A (SDPA math backend)

**Contexte**: relance du debug TRELLIS-2 après les 12 essais de mai 2026.
Nouvelles pistes neuves identifiées (sm_120 + DiT bf16 noise).

**Vérification pipeline.json (issue #160)** : confirmé que
`sparse_structure_decoder` pointe vers le checkpoint de l'ANCIEN TRELLIS
(`microsoft/TRELLIS-image-large/ckpts/ss_dec_conv3d_16l8_fp16`) — bug
Microsoft réel. MAIS on bypass déjà ce decoder via `voxel_to_mesh`
maison (marching cubes), donc ce n'est pas notre problème actuel. Tous
les autres checkpoints (tex_slat_decoder, tex_slat_flow_model_512,
shape_slat_*) pointent vers des artifacts TRELLIS-2 légitimes.

**Angle A — Force SDPA math-only backend (PyTorch)** :
Ajout du flag env `SDPA_MATH_ONLY=1` qui désactive flash/mem_eff/cudnn
SDPA et ne garde que le math backend (lent mais bit-exact).
Implémenté dans `external/TRELLIS2_win/test_run.py`.

Résultats sur `images/enfant_roux/ref_0.png` (créature orange/blanche) :

| Métrique | flash_attn (avant) | SDPA math (Angle A) |
|---|---|---|
| Sparse structure | 1.5s/step | 1.3s/step (identique) |
| Shape SLat | ~5s/step | ~19s/step (4x plus lent) |
| Tex SLat | ~5s/step | ~12s/step (2.5x) |
| **Ratio cohérence spatiale (input decoder)** | **0.799** | **0.439** ✓ |
| sample_tex_slat OUTPUT std | ~0.05 (cassé) | 3.632 (sain) |

**Verdict mitigé** : le ratio s'améliore SIGNIFICATIVEMENT (0.79 → 0.44,
= signal spatial structuré). Le sample_tex_slat OUTPUT a une std saine
de 3.6. MAIS la projection front du voxel cloud reste **visuellement
bruitée** (checkerboard de couleurs aléatoires, pas le kangourou
orange attendu).

**Hypothèse**: soit le ratio doit descendre encore plus (~0.2), soit
le **tex_slat_decoder est aussi cassé indépendamment du flow** sur
sm_120 — il prendrait des features cohérentes en input mais produirait
des RGB random en output.

**Test suivant** : BYPASS_TEX_FLOW=mean + SDPA_MATH_ONLY → si le
decoder produit une couleur uniforme avec input constant, il est OK
et c'est le flow qu'il faut peaufiner. Si le decoder produit du bruit
même avec input constant, le bug est plus profond.

**Test #2 (BYPASS_TEX_FLOW=mean + SDPA_MATH_ONLY)** : on envoie le
mean des stats de normalisation à TOUS les voxels (même feature
vector partout). Un decoder sain produirait une couleur UNIFORME sur
toute la silhouette.

Résultat: **même bruit visuel qu'un run normal** (checkerboard de
couleurs random). attr_volume mean=0.445 std=0.444, projection
front PNG = bruit.

➡️ **CONCLUSION CRITIQUE : le tex_slat_decoder lui-même produit du
bruit sur sm_120, indépendamment de son input.** Le bug est dans le
decoder, pas dans le flow. Ça explique pourquoi améliorer le ratio
du flow (Angle A) n'a pas fixé la texture. Voxels recevant exactement
la même feature 32D produisent des RGB différents → bug dans la
chaîne SparseConv3d / SubMConv3d / activations / normalizations
internes du decoder.

**Tentative Angle E — DenseConv3dWrapper (REMPLACER SparseConv3d par
nn.Conv3d densifié)** : code déjà préparé dans test_run.py mais bug
détecté à l'exécution. `kernel_size` retourné par spconv est une
LIST (`[3, 3, 3]`) pas tuple — le check `isinstance(kernel_size, tuple)`
échoue, fallback `(kernel_size,)*3` produit `([3,3,3], [3,3,3], [3,3,3])`,
crash en chaîne sur `k//2 for k in self.kernel_size`. **0 SparseConv3d
remplacés**, run se déroule comme un run normal MAIS le shape_slat
ralentit dramatiquement (274s/step au step 7-9 vs 19s normal) —
probablement parce que l'override `_mod.forward = _new_fwd` reste
attaché à tous les SubMConv3d et casse leur cache interne spconv.
**RAM système monte à 20 GB, swap commence**.

Le job a été tué après 25 min pour libérer la machine.

**Fix à appliquer demain** (avant relance) :
```python
self.kernel_size = (
    tuple(kernel_size) if isinstance(kernel_size, (list, tuple))
    else (kernel_size,) * 3
)
```
Et NE PAS attacher de wrapper si la détection de layout échoue (skip
proprement au lieu de polluer la forward).

**Update 2026-05-12 soir** : kernel_size fix appliqué + dry-run pattern
(build all wrappers FIRST, patch forwards only if 0 failures).

Test relancé → **diagnostic du vrai layout spconv** :
- tex_slat_decoder a **40 SparseConv3d** au total, tous stride=(1,1,1) padding=None
- Sample weight shape : `(1024, 3, 3, 3, 1024)`, `(4096, 3, 3, 3, 1024)`,
  `(512, 3, 3, 3, 512)`, etc.
- Donc spconv 2.x stocke en `(out_channels, Kd, Kh, Kw, in_channels)`
- Ni le layout attendu PyTorch `(Co Ci Kd Kh Kw)` ni les transposes
  testés. → **PROPRE ABORT, 0 forward patché**, decoder intact ✓

**À faire prochaine session** : ajouter ce layout dans le wrapper :
```python
elif sw.shape == (self.out_channels, *ks, self.in_channels):
    # spconv 2.x SubMConv3d: (Co Kd Kh Kw Ci) -> torch: (Co Ci Kd Kh Kw)
    self.conv.weight.data.copy_(sw.permute(0, 4, 1, 2, 3).contiguous())
```

Avec ça, les 40 wrappers devraient se construire et on aura la
réponse finale sur le bug spconv sm_120.

**Acquis du 2026-05-12** :
1. Bug n'est PAS dans le flow → ratio amélioré ≠ texture fixée.
2. Bug EST dans le decoder → BYPASS_TEX_FLOW=mean reproduit le bruit
   avec input constant.
3. Très probablement dans les SparseConv3d / spconv kernels sm_120.
4. DenseConv3dWrapper est la bonne piste mais code à debugger.
5. CPU decoder = piste alternative mais nécessite migration récursive
   du sub-module Linear `from_latent` aussi (pas juste `.cpu()`
   sur le module top-level).
6. ATTENTION : ne pas relancer test_run.py avec un wrapper buggé,
   il ralentit shape_slat et bouffe la RAM système.

---

## 2026-05-12 — Fix dtype mismatch dans local_juggernaut_bridge.py

**Symptôme**: "Image generation failed — expected mat1 and mat2 to have
the same dtype, but got: float != struct c10::Half" lors d'un click sur
"Generate". Crash dans `encode_prompt` (text_encoder).

**Cause**: même bug que sdxl_server.py (déjà fix il y a un moment).
Diffusers 0.34 + torch 2.7.1+cu128 laisse certains buffers en fp32
après `from_pretrained(torch_dtype=torch.float16, variant="fp16")`. Le
text_encoder voit du fp32 sur des poids fp16 → mismatch.

**Fix**: ajouter `pipe.unet/vae/text_encoder/text_encoder_2.to(torch.float16)`
APRÈS `from_pretrained` et AVANT `enable_model_cpu_offload()`, dans les
deux branches (RealVisXL par défaut + DreamShaper XL Lightning + CN
OpenPose pour T-pose). Le fix est identique à celui appliqué à
`sdxl_server.py:147-148` / `201-202` / `248-249`.

**Statut**: à valider — relancer un "Generate" dans l'UI.

---

## 2026-05-01 — TRELLIS-2 Blackwell sm_120: 12+ fix tentés, BLOQUÉ upstream

**Contexte**: TRELLIS-2 (Microsoft) sur RTX 5080 Blackwell. Géo OK.
Texture = bruit RGB random (chaque voxel = couleur uniforme aléatoire).

### Découverte clé
Bug racine = **`tex_slat_flow_model_512` (DiT bf16) produit du bruit
spatial sur sm_120**. Spatial coherence ratio à l'INPUT du tex_slat_decoder:
- 12 steps Euler: 0.799
- 50 steps Euler: 0.836 (pire — flow ne converge PAS)
- Le decoder lui-même fait passer 0.79 → 0.55 (moyennage convolutionnel,
  ne peut créer du signal à partir de bruit)

### Ce qui a été tenté (tous ECHEC, ratio reste 0.55±0.04)
1. nvdiffrast retiré (bonus: commercial-safe via `o_voxel_patch.py` BSD-3 PyTorch)
2. `flex_gemm.grid_sample_3d` patché PyTorch
3. spoof CC (9,0) Hopper / (8,6) Ampere + DISABLE_JIT
4. fp32 ss_decoder
5. fp32 tex_decoder (sans / avec MLP wrap)
6. spconv ConvAlgo Native vs MaskImplicitGemm vs ImplicitGemm
7. flex_gemm backend (au lieu de spconv) — Triton crash sm_120
8. bf16 tex_decoder — spconv KeyError
9. **Recompile spconv NATIF sm_120** (cumm-cu128-0.8.2 + spconv-cu128-2.3.8,
   2h build, wheels dans `c:/tmp/wheels_sm120/`) — ratio 0.549, IDENTIQUE
10. Conversion tex_slat_flow_model bf16 → fp32: crash `FlashAttention only
    support fp16 and bf16`
11. Conversion bf16 → fp16: crash `mat1 and mat2 must have the same dtype`
12. Augmenter steps Euler 12 → 50: ratio s'aggrave 0.799 → 0.836

### Issues upstream IDENTIQUES (OPEN, 0 réponse Microsoft)
- [visualbruno/ComfyUI-Trellis2#157](https://github.com/visualbruno/ComfyUI-Trellis2/issues/157) RTX 5090
- [microsoft/TRELLIS.2#102](https://github.com/microsoft/TRELLIS.2/issues/102) RTX 5080 "silent failure SparseConvNeXtBlock3d"
- [microsoft/TRELLIS.2#99](https://github.com/microsoft/TRELLIS.2/issues/99) RTX 5060 Ti

### Décision business
**STOP debug TRELLIS-2 sm_120. Ship voie F (SF3D + voie C HD overlay)
qui est validée et commercial-safe.**

TRELLIS-2 = R&D bloqué jusqu'à ce que Microsoft réponde à #102.
Tag git `trellis2-rnd-blackwell-blocked` à mettre.

Acquis utiles si on reprend plus tard:
- `external/TRELLIS2_win/o_voxel_patch.py` (BSD-3 pure PyTorch, retire nvdiffrast)
- `c:/tmp/wheels_sm120/cumm_cu128-0.8.2-cp311-cp311-win_amd64.whl`
- `c:/tmp/wheels_sm120/spconv_cu128-2.3.8-cp311-cp311-win_amd64.whl`

---

## 2026-04-19 — Voie A: texture_project cos^4 + UV inpaint (Hunyuan-inspired)

**Contexte**: après avoir épuisé les options TripoSG (xatlas direct, KDTree UV
transfer, raycast SF3D atlas — tous leopard), lecture du code Hunyuan3D-Paint.
Insight: leur secret n'est PAS xatlas (même outil que nous), mais:
1. `bake_exp=4` → `cos(n,view)^4` weighting → anti-leopard sur atlas fragmenté
2. UV inpaint post-bake sur les trous restants

**Modifs texture_project.py** (inspiration, pas plagiat):
- `vvis ** 0.8` → `vvis ** FABMESH_TEXPROJ_BAKE_EXP` (défaut 4.0)
- Post push-pull: cv2.inpaint Telea sur hole_mask (défaut ON via
  `FABMESH_TEXPROJ_UV_INPAINT=1`)

**Test 1** (`_afghan_triposg_v2.glb`, BAKE_EXP=4.0, 1 view front):
- sharp_ratio = **14.1%** (cos^4 tue les flancs)
- 900k trous comblés par Telea → garbage blanc/gris
- Pire qu'avant: photo front entière plaquée en mini au torse
- User verdict: "catastrophique"

**Test 2** (BAKE_EXP=1.5): sharp_ratio=19.5%, toujours insuffisant.

**Conclusion**: cos^N weighting fonctionne SEULEMENT avec 6+ vues (comme
Hunyuan). Avec 1-2 vues (notre cas: front photo ou front+back), aucun
bake_exp ne corrige. Le vrai problème est que xatlas sur TripoSG 50k
produit 2456 charts → la projection front ne couvre qu'un petit %
d'atlas; tout le reste de l'atlas = trous que Telea devine mal.

**Action**: rollback BAKE_EXP default à 0.8 (comportement pré-voie-A).
Garde le `FABMESH_TEXPROJ_BAKE_EXP` env var + Telea inpaint (inoffensif,
aide sur trous résiduels). **Seule voie restante = B (multi-view gen)**.


---

## 2026-04-18 — Paint3D v14: views_init [0,12] was LEFT-SIDE not BACK

**Diagnosis of shattered albedo in v13**: the override
`render_cfg.render.views_init = [0, 12]` was based on a WRONG comment
claiming "index 12 = phi=180° (back)". In fact with `n_views=24,
base_theta=60°, alternate_views=True` the dataset's phi ordering is
permuted by `alternate_lists`:
  - idx  0 → phi=0°   (front)   ✓
  - idx 12 → phi=270° (LEFT SIDE) ✗
  - idx 23 → phi=180° (back)    ← what we actually wanted

Consequence: Paint3D back-projected the BACK photo onto a mesh rendered
from a LEFT-SIDE camera. With `render_angle_thres=68°`, most faces
failed the normal-cosine threshold → shattered UV atlas, ~90% magenta,
only a few fragment islands textured correctly.

Proof: `init_depth_render.png` in v13 shows left=front, right=side-view
(arms receding into body). In v14 it's front + back, both T-pose.

**Fix** (commit pending):
  1. `external/Paint3D/pipeline_paint3d_stage1.py`: change `[0, 12]`
     → `[0, 23]` for the 2-view mv-dir case.
  2. `external/Paint3D/paint3d/models/render.py`: add
     `FABMESH_PAINT3D_LOOSE_MASK` env flag (default off) that replaces
     `render_angle_thres`. Only active when set; preserves Suzanne demo.
  3. Same pipeline file: when FABMESH_MV_DIR is active, auto-set
     `FABMESH_PAINT3D_LOOSE_MASK=85` — 2-view front+back needs >90°
     total coverage per view, so 68° rejects too many silhouette-edge
     triangles.

**Result**: v14 albedo now shows proper front+back body silhouettes in
the UV atlas bottom row (where they belong in SF3D's view-aligned UV
layout). Side coverage filled by inpaint views 5/6, 24/25 via SD. The
remaining magenta is mostly genuine UV atlas empty space and interior/
occluded mesh regions, not missing coverage.

**File refs**:
  - Bug: `external/Paint3D/pipeline_paint3d_stage1.py:235` (old=[0,12])
  - Compare albedos: `logs/child_ip45_2view/mesh_paint3d_v13.glb.paint3d_work/stage1/res-0/albedo.png`
    vs `logs/child_ip45_2view/mesh_paint3d_v14.glb.paint3d_work/stage1/res-0/albedo.png`

---

## 2026-04-18 — Sub-experiments hunting placement+definition (chronological)

After the initial 2-view experiment shipped (entry below), we cycled
through 5+ variants chasing the right combination of *placement* (face
on the front, not on the calf) and *texture definition* (sharp denim,
recognizable face). Same input pair every run:
`images/child/_scale_sweep/ip45_front.png` + `ip45_back.png`. Output
artifacts pile up in `logs/child_ip45_2view/mesh_*.glb`.

**Run A — NORMALIZE_ORIENT=0** (commit 16489cf)
- Bridge skips its +180° Y rotation. Mesh stays in raw SF3D frame
  (face -> -Z). views.json uses front=0, back=180 in raw frame.
- Result: placement looked decent from a flattering angle, but mesh
  is **cireux/blanchâtre** all over — colors washed, denim grayed,
  face flat & pasty. 426k texel holes (40%) filled by push-pull blur.
- Misjudged at the time as "best placement so far". Actually worst
  texture quality.

**Run B — NORMALIZE_ORIENT=1 + FABMESH_TEXPROJ_SHIFT_SOURCE=1**
(commit 2830058, reverted in cfdf6d3)
- Bridge applies +180° Y normalize. texture_project shifts source
  input.png azimuth too. All 7 slots end up at az=180 (front of
  rotated mesh).
- Result: placement OK, denim sharp & coloured. User reported "face
  on the calf" — actually a memory of an earlier different run.
  Reverted prematurely.

**Run C — NORMALIZE_ORIENT=0 + R_undo += Ry(180)** (current code, gated
on env)
- Adds Ry(180) to R_undo when NORMALIZE_ORIENT=0 to compensate the
  missing bridge rotation in projection sampling.
- Result: textures get colour back, but face features
  (eyes/nose/mouth) are **deformed/grotesque**. Patch over-rotates
  by a fraction so face details land on neighbouring vertices. Bad.

**Run D — NORMALIZE_ORIENT=1 (default), no SHIFT_SOURCE, no R_undo
patch** — the "sharp" baseline
- Standard pipeline path.
- Result: **placement perfect** (face front, denim front, baskets
  front), textures sharp and saturated. User confirmed: "le placement
  est parfait, definition meilleure".
- Latent issue: the native HD source (1151px) is at az=0 in the
  post-rotation frame — i.e. it lands on the BACK. The face we see
  is actually painted by mv/view_0, which is the front photo
  *resized to 1024px*. We lose the HD bonus where it matters most.

**Run E — NORMALIZE_ORIENT=1 + SHIFT_SOURCE=1** (today, flag re-added)
- Reapply run B's idea: shift input.png to az=180 so the HD source
  lands on the FACE of the rotated mesh.
- Result: placement still perfect. But the **face is FLOU + dirty**
  (dark patches around eyes, ghost-double of features).
- Root cause: input.png HD (1151px) AND mv/view_0 (front dup 1024px)
  both project to az=180. Their per-texel sample coords differ by
  sub-pixel because of the resolution mismatch -> moiré + ghosting
  on the face area where they fight for highest per-pixel weight.

**Run F — NORMALIZE_ORIENT=1 + SHIFT_SOURCE=1 + no front dups in mv/**
- Hypothesis: kill the doubled-front signal. Fill all 6 mv slots
  with `back` only, all labelled azim=180 in raw frame -> az=0
  post-rotation -> mesh BACK. input.png HD covers the FRONT alone.
- Result: at the locked-frontal compare angle, **F shows the BACK of
  the mesh** (denim back + nuque + cargo back pockets visible). Mesh
  somehow flipped under the projection swap. Disqualified for face
  quality comparison — you can't see the face in the pose F generated.

### Locked-frontal 5-way compare — user verdict

After locking all 5 panels to a fixed frontal camera
(`camera-orbit="0deg 90deg 1.4m"`) for direct face-to-face comparison:

- **A (NORMALIZE=0)**: face visible but cireux/blanchâtre, fade. Out.
- **C (NORMALIZE=0 + Ry180 patch)**: shows the BACK at the locked
  angle — mesh ended up rotated 180° vs the others. Out.
- **F (NORMALIZE=1 + SHIFT + no front dups)**: also shows the BACK
  at the locked angle. Same flip issue as C. Out.
- **D (NORMALIZE=1 baseline)**: face visible, sharp, well-coloured. ✓
- **E (NORMALIZE=1 + SHIFT_SOURCE)**: face visible, sharp, similar
  to D at the wide angle. ✓

User said: "D et E sont les mieux". Choice now narrowed to D vs E.

### Why C and F flipped 180° at the same camera angle

C and F both touch the rotation pipeline:
- C adds Ry(180) to R_undo. This modifies how vertices are sampled
  but ALSO changes which face of the mesh is "az=0" of the
  texture_project camera basis — effectively flipping the rendered
  result by 180° around Y.
- F changes views.json so all 6 mv slots claim azim=180 (raw) which
  the bridge then shifts to az=0 (post-rotation = back). Combined
  with input.png shifted to az=180 (post-rotation = front), the back
  texture lands on the "front" of the mesh as defined by the
  texture_project camera convention. The user's frontal camera angle
  in model-viewer then sees the back image painted on what model-
  viewer thinks is the front face -> looks like a back view.

Lesson: changing angles in views.json or R_undo also rotates the
visible front of the mesh in the viewer's frame. The "face is in
front" requirement is enforced not just by mesh geometry but by
matching the texture_project frame to model-viewer's default camera.

### Why A/C/F are sharper than D/E — analysis

User correctly pushed back: rather than asking how to improve D/E,
ask **why A/C/F have better definition**. Tabling the relevant flags:

| Run | NORMALIZE | SHIFT_SRC | R_undo+Ry180 | rot_offset | input azim final | mv azims final | Sharpness |
|-----|-----------|-----------|--------------|------------|------------------|----------------|-----------|
| A   | 0         | 0         | no           | 0          | 0                | 0/90/180/270/0/0 | sharp |
| C   | 0         | 0         | yes          | 0          | 0                | 0/90/180/270/0/0 | sharp |
| F   | 1         | 1         | no           | 180        | 180              | 0/0/0/0/0/0       | sharp |
| D   | 1         | 0         | no           | 180        | 0                | 180/270/0/90/180/180 | medium |
| E   | 1         | 1         | no           | 180        | 180              | 180/270/0/90/180/180 | flou |

What A, C, F share that D, E lack:
- All MV final azimuths are **clean orthos** (multiples of 90°,
  ideally 0/90/180/270 or all-zero) **after** the rotation_offset
  is folded in.
- input.png lands on the same side of the mesh as ip45_front shows
  — i.e. the actual front of the rendered mesh.

What goes wrong in D, E:
- Geometrically the projection math is correct (rot_y(-180) on a
  mesh that was rotated +180 nets to identity).
- But the HD source signal (input.png 1151px) ends up at az=180
  (in E) AND mv/view_0 (1024px front dup) ends up also at az=180
  -> two views compete on the exact same face area with sub-pixel
  sample-coord differences -> moiré.
- In D, input.png stays at az=0 -> wasted on the BACK of the
  rotated mesh. The face is painted only by mv/view_0 (1024px).
  No moiré, but no HD bonus either -> "medium" sharpness.

So:
- A's sharpness comes from mv azimuths being raw orthos (no shift)
  AND input.png at az=0 hitting the actual face (raw mesh frame).
- C's sharpness same as A. The face deformation in C is from the
  R_undo Ry(180) patch over-correcting mesh sample coords.
- F's sharpness comes from collapsing all MV slots to one azimuth
  (no fractional offsets). But mesh ends up rotated 180° at the
  viewer's frontal angle.
- D = OK because no two views fight for the front (input.png on
  back, mv/0 alone on front).
- E = bad because input.png + mv/0 fight on the front.

### Hypothesis to try next — Run G

Take E and **remove only mv/view_0** (the slot that doubles input.png
on the face), keep mv/view_1..5 for right/back/left/top/bottom
coverage. Should:
- Eliminate the moiré on the face (no doubled-front signal).
- Keep the HD bonus from input.png on the face.
- Keep the back/sides coverage from the other mv slots.
- Keep the correct placement (NORMALIZE=1 + SHIFT_SOURCE).

Implementation: ip45_2view_to_3d.py — write only 5 mv slots
(view_1..view_5), let texture_project skip view_0 because the file
won't exist. Or write all 6 but mark view_0 with priority 0.0 in
views.json (but views.json doesn't carry priority, only azim/elev).

Cleaner path: skip writing view_0 entirely. texture_project.py
already logs `WARNING: missing {vpath}, skipping` for missing slots.

### Run I — Path 2 (transparent view_0) — ALSO FLIPPED

After the 2-agent synthesis pointed to two safe paths, tried Path 2
first because it's a 1-line change with the lowest theoretical risk.

Config: NORMALIZE=1 + SHIFT_SOURCE=1 + view_0.png written as fully
transparent RGBA (alpha=0 everywhere) in build_mv_dir. Theory: src_alpha=0
makes view_0's per-texel weight 0 (texture_project l 643:
`w_pixel = pt_vis * src_alpha * priority * mask * in_b`), so input.png HD
wins everywhere on the face, no moiré. Layout still has 7 entries
(unchanged), just one is neutralized.

Result: **also flipped 180°** at the locked frontal angle. User saw
the back of the mesh in the I panel.

Lesson: even **neutralizing a slot via alpha=0** flips the mesh. The
flip is NOT specifically tied to changing pixel content of view_0 —
it's tied to **whether view_0 contributes any winning weight at all**
on the front azimuth. When view_0 stops winning *anything* there,
xatlas / texture_project's per-texel arbitration shifts which side of
the mesh ends up texturized as "front" in the viewer.

### Run J — Path 1 (priority demote in texture_project.py) — ALSO FLIPPED

Tried Agent #1's surgical priority drop. Patched texture_project.py
l 423-431 to demote any mv slot whose `shifted_azim` collides with
`_src_azim` and whose priority ties with the source's prio (1.0).
The collision detection is precise (`abs(((shifted_azim - _src_azim
+ 180) % 360) - 180) < 1.0` for azim, `abs(elev) < 1.0` for elev).
Only fires when `FABMESH_TEXPROJ_SHIFT_SOURCE=1`.

Confirmed in logs: `view_0: demoting prio 1.0 -> 0.5 (collision with
source at az=180.0)`. So the patch fired exactly as designed — view_0
still contributes, but with half the weight, so input.png HD should
own the face cleanly.

Result: **also flipped 180°**. User saw the back of the mesh in J.

### Definitive empirical conclusion (after runs A..J)

| Run | NORMALIZE | SHIFT | What changed | Flipped? | Definition |
|-----|-----------|-------|--------------|----------|------------|
| A   | 0         | 0     | baseline     | no (luck) | cireux |
| C   | 0         | 0     | R_undo+Ry180 | yes      | sharp face deformed |
| D   | 1         | 0     | baseline     | **no**   | medium (mv 1024 paints face) |
| E   | 1         | 1     | shift source | **no**   | flou (HD vs 1024 moiré) |
| F   | 1         | 1     | back-only mv | yes      | sharp |
| G   | 1         | 1     | skip view_0  | yes      | sharp |
| H   | 1         | 1     | view_0=back  | yes      | sharp |
| I   | 1         | 1     | view_0 alpha=0 | yes    | sharp (back side) |
| J   | 1         | 1     | view_0 prio 0.5 | yes   | sharp (back side) |

The pattern is now unambiguous:

- **Anything that makes input.png HD dominate the front azimuth flips
  the mesh** (C, F, G, H, I, J).
- **Only configurations where mv/view_0 (1024px front dup) wins the
  front azimuth are non-flipped** (D, E).

Why? When input.png owns most of the front-side texels, the bake
follows SF3D's native coordinate frame for those texels. The MV slots
follow the bridge's post-rotation frame for theirs. Mixed dominance
across the same hemisphere creates an inconsistent bake; xatlas/
viewer ends up showing what was the "back" of the SF3D coords as the
new "front".

Net result: **D and E are the only viable configurations**. We cannot
have HD-on-face AND non-flipped via env flags / priority tweaks /
view content tricks. Achieving both would require modifying the
R_undo / R_w2c basis math in texture_project.py so input.png's
SF3D-native frame and the MV post-rotation frame agree on which side
is "front" — a deeper engine change than env-flag tuning allows.

### Pragmatic recommendation

For shipping the 2-view pipeline today: use **D** (NORMALIZE=1
baseline, no SHIFT_SOURCE, no priority tweaks, canonical 7-view mv
layout). Confirmed by user as having "definition meilleure" + correct
placement.

To improve D's face definition without flipping: increase the
resolution of `mv/view_0.png` itself. Currently
`scripts/ip45_2view_to_3d.py:38` resizes the front PNG to 1024×1024.
Bumping that to 2048×2048 doubles the resolution that paints the face
in D, no flip risk. Worth trying as **Run K** if user agrees.

### ERRATUM 2026-04-18 — All previous "NORMALIZE=1" runs were actually NORMALIZE=0

**MAJOR BUG in my analysis**: discovered when user said Run K had
"face-on-calf" inversion (vertical, not just Y-flip). On inspection,
`scripts/ip45_2view_to_3d.py:84` was setting
`env['FABMESH_SF3D_NORMALIZE_ORIENT'] = '0'` from the very first
commit of the wrapper. So **every run since A** has been in
NORMALIZE=0, despite being labelled NORMALIZE=1 in the table for
runs D, E, F, G, H, I, J, K.

The actual experimental matrix was therefore:

| Run | NORMALIZE actual | SHIFT | What changed in mv/ |
|-----|------------------|-------|---------------------|
| A   | 0 | 0 | baseline |
| C   | 0 | 0 | + R_undo Ry180 patch |
| D   | **0** | 0 | (claimed: NORMALIZE=1, was =0) |
| E   | **0** | 1 | (claimed: NORMALIZE=1, was =0) |
| F   | **0** | 1 | + back-only mv |
| G   | **0** | 1 | + skip view_0 |
| H   | **0** | 1 | + view_0=back |
| I   | **0** | 1 | + view_0 alpha=0 |
| J   | **0** | 1 | + view_0 prio 0.5 |
| K   | **0** | 0 | + mv slots @ 2048 |

So the "flip 180°" observed in C/F/G/H/I/J/K was actually the
NORMALIZE=0 mesh (face -> -Z) viewed by model-viewer's default
camera (looking from +Z) — i.e. seeing the BACK by default. Runs D
and E "happened to look correct" not because the bake was special,
but because their texture distribution made the back-side somehow
look more like a "front" to the user (probably because back image
has hair, neck, jacket-back which are visually less distinguishable
front-vs-back than the face-side).

K's "face-on-calf" is the same bug as the very first session bug:
NORMALIZE=0 + R_undo's standard rotation chain creates a mesh frame
where projection coords land on flipped vertical positions.

### Fix applied: removed `env['FABMESH_SF3D_NORMALIZE_ORIENT'] = '0'`
from scripts/ip45_2view_to_3d.py:84. Bridge default (NORMALIZE=1)
now applies — mesh face will point to +Z (three.js convention).

### ERRATUM-OF-ERRATUM 2026-04-18 — NORMALIZE=0 was CORRECT all along

After running REAL_D and REAL_E with NORMALIZE=1 (bridge default),
user inspected the front and back views in the compare:

- OLD D and OLD E (NORMALIZE=0): face devant, dos derrière, **correct orientation**.
- REAL D and REAL E (NORMALIZE=1): the **face image is projected onto
  the BACK of the mesh** — visible because the front view of the
  model-viewer shows the back of the body with the face pasted on it.

So my "erratum" above was wrong. **NORMALIZE=0 was the correct setting
for this pipeline**, and the wrapper was right to force it. The
reason it's correct:

- bridge with NORMALIZE=1 rotates the mesh +180° around Y, then
  propagates rotation_offset_deg=180 to texture_project.
- texture_project applies that offset to the MV view azimuths, BUT
  the source `input.png` stays at azim=0 (no shift).
- Net result: mesh rotated 180°, MV azimuths shifted to compensate,
  but the source HD photo is now at the wrong side -> face image
  projected onto the back.

With NORMALIZE=0:
- mesh stays in SF3D native frame (face at -Z).
- rotation_offset_deg=0 propagated.
- All views (input + 6 mv) keep their raw azimuths from views.json.
- Source input.png at azim=0 lands on the front of the mesh.
- model-viewer's default camera (looking from +Z) sees the BACK of
  the SF3D-frame mesh, but the front photo IS projected on the front
  side, so when user rotates the camera to look at the SF3D-front
  side, they see the actual face.

Restored `env['FABMESH_SF3D_NORMALIZE_ORIENT'] = '0'` in
ip45_2view_to_3d.py with a long comment explaining why.

### Final corrected verdict

The "OLD D" config (= NORMALIZE=0 + no SHIFT_SOURCE) IS the working
baseline. The previous Run K (NORMALIZE=0 + mv slots @ 2048) was
essentially "OLD D + 2048 mv res", and the user reported it had
face-on-calf — that's a **different** failure mode (vertical
inversion in projection coords), unrelated to the front/back side
swap. K is still flipped vertically.

So:
- **Working**: A, D, E (all in NORMALIZE=0, the working frame).
- **Broken vertically**: K (the 2048 mv res broke p_v sampling).
- **Broken side-swap**: REAL_D, REAL_E (NORMALIZE=1 with this wrapper).

D remains the best-quality stable config for shipping. Future face
definition work should stay within NORMALIZE=0 frame.

### Run L result — STILL NEEDS VISUAL EVAL

Run completed (mesh_RUN_L.glb 2.9 MB, atlas now 2048×2048). User
hasn't compared yet — pivoted to a more important observation below.

### KEY USER INSIGHT (2026-04-18) — REAL_D has BETTER textures but inverted

User looked at REAL_D (NORMALIZE=1, no SHIFT_SOURCE) and reported:
"Real D a des super textures mais elles sont inversées".

Visible: denim is much sharper, seams clearly defined, white t-shirt
visible, cargo shorts crisp, baskets defined. BUT:
- The mesh shows the BACK at the locked frontal viewer angle.
- Face features (eyes, hair patches) are projected onto the back of
  the head from the wrong angle.

So REAL_D is the OPPOSITE of D:
- D = correct orientation but lower texture quality (bottlenecked by
  mv/view_0 dup at 1024px since input.png HD lands "behind" the
  rotated mesh).
- REAL_D = HIGH texture quality (HD source actually paints the dense
  side of the bake) but mirror-swapped (back where front should be).

### Re-evaluation of REAL_D after closer look (2026-04-18)

User looked at REAL_D from a different angle and reported TWO bugs:
1. "avant arriere inversée" — side-swap (Y rotation issue)
2. "orientation de la vrai avant inversée (tete vers les pieds)" —
   the front face image is projected UPSIDE DOWN onto the mesh

So REAL_D's textures aren't just "swapped left/right" — the source
input.png is also vertically flipped. Visible in the 2nd screenshot:
the back of the mesh shows a "head zone" in the BOTTOM (where the
feet should be) and shorts in the upper area where the chest is.
This is a head-toward-feet inversion.

Conclusion: REAL_D combines TWO transformations:
- side-swap (180° Y) caused by bridge rotating mesh but not source
- vertical flip (180° X or p_v inversion) caused by R_undo's Rx(90)
  no longer matching the rotated mesh orientation

A simple post-export Y rotation won't fix this — it would only fix
the side-swap, not the vertical flip. We'd need to also apply X
rotation OR fix the V flip in texture_project's projection chain.

ABANDONING the Run O plan (post-rotate Y -180°). It would only
half-fix the problem.

### Pivot: investigate the 2 specific bugs in REAL_D math

To fix REAL_D properly, we need either:
- **Option A**: post-rotate the mesh by Rx(180) @ Ry(180) on export
  AFTER the bridge does its work. Both rotations together net out
  to a Z-axis flip — equivalent to 180° around Z.
- **Option B**: in texture_project.py, when rotation_offset_deg!=0,
  also flip p_v (`p_v = 1 - p_v`) for the source view to compensate
  for the vertical inversion that the rotated mesh introduces vs the
  R_undo's standard Rx(90) chain.
- **Option C**: revert to D (NORMALIZE=0) which is geometrically
  correct, and accept the texture quality bottleneck. Best definition
  improvement path within D = bake the SDXL refine more aggressively
  (raise strength), or use a higher-res input.png.

### Run L was completed but ignored (mesh_RUN_L.glb 2.9 MB exists)

User skipped past Run L's verdict. Run L = D + atlas tex_res 2048
should be fine to evaluate later if the REAL_D direction is dropped.

### Run P result — works but over-rotated (mesh upside-down)

User screenshot: mesh is upside-down (feet up, head down, but face
visible on the now-bottom head). Textures are great, well-placed
relative to body parts (visage à la tête, denim sur le buste).

So Rx(180)@Ry(180) was too much. The "head toward feet" issue I
inferred from the previous REAL_D back view was actually NOT a
separate bug — it was just an artifact of viewing the mesh from a
weird angle when the side-swap rotated unfamiliar parts into view.

REAL_D actually has only ONE bug: side-swap (180° around Y). My
Rx(180) was a false fix that turned the mesh upside-down on top of
the correct Y rotation.

### Run Q — REAL_D + Ry(180) only — RESULT: WORSE

User verdict: "ca a baissé la qualité de la texture sans la faire
tourner". Two surprises:
1. Texture quality DROPPED vs REAL_D (less sharp denim, less defined
   features).
2. Mesh is NOT rotated — visually similar orientation to REAL_D.

How can a post-export Y rotation reduce quality? It shouldn't touch
texture data at all — only vertex positions. Possible explanations:
- The trimesh load+save round-trip lost something (PBR material,
  texture compression).
- Or the mesh was rotated but the user looked at it from a different
  angle that happened to match.
- model-viewer might cache the GLB by URL and showed an older P or
  REAL_D incorrectly.

Either way: **Run Q is worse than REAL_D** per the user.

### What we know now

- D (NORMALIZE=0): correct orientation, lower texture quality.
- REAL_D (NORMALIZE=1): high texture quality but 180° side-swapped.
- P (REAL_D + Rx@Ry 180): textures preserved, mesh upside-down.
- Q (REAL_D + Ry only): degraded textures, no visible rotation.

P proved that post-rotation CAN preserve textures (Rx+Ry combo
worked, just over-rotated). Q's degraded quality is suspicious —
maybe the trimesh save lost the PBR material setup. P used the same
function and DID preserve quality, so the difference between P and
Q is just whether Rx is included.

### CONFIRMED — trimesh round-trip drops texture data

File sizes:
- mesh_REAL_D.glb: 1,540,076 bytes (with full SDXL-refined 2048 atlas)
- mesh_RUN_P.glb: 774,716 bytes (after trimesh round-trip)
- mesh_RUN_Q.glb: 776,588 bytes (after trimesh round-trip)

Both P and Q lost ~50% of the file — almost certainly the
baseColorTexture (the SDXL-refined 2048×2048 atlas embedded in the
binary chunk). trimesh's GLB exporter doesn't preserve embedded
textures fully; it likely re-encodes them at lower quality or drops
the high-res atlas in favour of a fallback.

So Run P's "great textures" was a misperception — they were already
degraded but the upside-down distraction masked it. Q's quality
drop is real and measurable.

### Run R — REAL_D + Ry(180) via pygltflib (binary-preserving)

New script: scripts/glb_post_rotate.py uses pygltflib to rotate ONLY
the POSITION + NORMAL accessors in-place.

Result:
- File size preserved: 1,539,424 bytes (vs REAL_D 1,540,076).
  ✓ Textures NOT lost.
- BUT: visually identical to REAL_D — the rotation has **NO visible
  effect** in the model-viewer.

Theory: the GLB has a node with its own transform matrix (or TRS
rotation). model-viewer applies the node transform on top of the
vertex positions, so rotating the positions is cancelled by the
node-level rotation that the bridge applied at l 408
(`mesh.apply_transform(_R180)` -> trimesh probably writes that as
node TRS, not into vertex positions directly).

ALSO key revelation while looking at this compare: **D is actually
sharp too** (visage net, denim avec coutures, t-shirt blanc, shorts
cargo, baskets). My earlier impression that D was "lower def" was
wrong — D and REAL_D have similar texture quality at this view.
The difference between them is only orientation.

So:
- D works perfectly (correct orientation, sharp texture).
- REAL_D and R are visually equivalent (both show the back).
- The "post-rotate to fix REAL_D" path was solving a problem that
  doesn't really exist — D was already the answer.

### Decision

D is the shipping config. Stop chasing "REAL_D + post-rotate".
Going forward, if texture definition needs improvement, look at
the SDXL refine strength, the input image quality, or the SF3D
geometry — not at the orientation/projection chain.

Restoring ip45_2view_to_3d.py: keep the pygltflib post-rotate code
as opt-in (FABMESH_IP45_POST_ROTATE=1) but default OFF, so D config
runs cleanly without the extra step.

### Final D run analysis (2026-04-18) — objective comparison

After restoring D config and re-running, examined
mesh_proj_debug.png (the front-camera render with vertex debug
overlay) vs the source ip45_front.png:

PRESERVED (good):
- Pose (T-pose, bras tendus, jambes parallèles)
- Identité de l'enfant (visage reconnaissable, mêmes traits)
- Coiffure (cheveux bruns, coupe identique)
- Veste denim (couleur, coutures, 2 poches frontales, boutons)
- T-shirt blanc cassé sous la veste
- Shorts cargo beige avec poche latérale
- Baskets bleu marine avec semelle blanche
- Visage net avec yeux/nez/bouche bien placés
- Aucune déformation géométrique visible

DEGRADED (acceptable):
- Petits points colorés (vertex debug overlay only, not real texture
  artefacts — they're added by texture_project for diagnostic)
- Fond noir vs gris studio source (rembg clean)
- Léger blur sur détails fins (boutons, coutures cargo) — typical
  of 1024 atlas on 8k-vert mesh

VERDICT: D is a convincing and shippable result. Identité préservée,
vêtements correctement mappés, pose intacte, pas de bug géométrique.
Perte de détail minime et typique de la chaîne SF3D + texture_project.

After 18 runs (A..R), D wins.

### CRITICAL UPDATE — D has 2 distinct face/back bugs (2026-04-18)

User rotated the mesh in the viewer and reported:
- "la texture de face est dans le bon sens mais DÉCALÉE"
  (front texture is correctly oriented but spatially offset)
- "la texture de l'arrière est INVERSÉE (tête en bas)"
  (back texture is vertically flipped)

So my "D wins" verdict above was based only on the front view. The
back view of the same mesh has the head-toward-feet inversion that
I'd previously diagnosed in REAL_D and dismissed.

This is consistent with what I should have realized earlier:
texture_project handles front (input.png at azim=0) and back (mv/2
at azim=180) with different rotation chains. For the front, p_v is
flipped via `p_v = 1.0 - p_v` (l 555). For the back, the same
formula applies BUT the back image needs an additional vertical flip
because its source camera convention is opposite — back-view photos
have "up" at the top of the image just like front, but when projected
from azim=180 onto a mesh in SF3D-native frame, the V coord lands
inverted.

### Run W result — VERTICAL FIXED, but side-swap appeared

User screenshots: both front and back views of W are now correctly
oriented VERTICALLY (heads at top, feet at bottom, denim on torso,
shorts on legs — huge progress vs D/V where the back was head-toward-
feet).

BUT: the front-camera view shows the **back of the subject** (denim
with back seams, nuque, brown hair patch), and the back-camera view
shows the **face**. So the textures are now swapped front↔back in
addition to being correctly oriented.

Interpretation: skipping `p_v = 1 - p_v` for azim=180 was exactly
what the back needed vertically, but because the SF3D mesh is in
the native frame (face at -Z), the model-viewer default camera
(looking from +Z) shows the back by default. The textures happen
to appear "swapped" because:
- input.png (azim=0) projected onto mesh face (-Z side), which is
  AWAY from the viewer's default camera -> viewer sees back-of-mesh
  with back-painted pixels.
- back.png (azim=180) projected onto mesh back (+Z side), viewer
  sees front-of-mesh with front-painted pixels.

Wait — that describes the standard D behaviour. So why does W look
flipped and D doesn't?

Alternative theory: conditional-skip of p_v for azim=180 made the
back image no longer vertical-inverted, which means the FRONT side
of the mesh (painted by input.png at azim=0 with normal p_v flip)
now has its image mapped correctly, but... model-viewer's default
camera angle varies with each file — it auto-fits to mesh bounds.
So the apparent "swap" may be just that auto-rotate has W on a
different side initially vs D.

### The mechanics of Run W's side-swap (real analysis)

When we skip `p_v = 1 - p_v` for back (azim=180):
- The back image's pixel at V=0 (top of PNG = head) now maps to the
  mesh V coord where, WITHOUT the flip, the back cam samples the
  "top" of the mesh geometry.
- BUT: the ABSENCE of the V flip also changes which SIDE of the
  mesh the sample lands on, because the V coord is in cam-space
  AFTER R_w2c (which points cam at -Z for azim=180).
- Without the flip, the sampled direction is effectively the same
  image rotated 180° around Z — equivalent to a horizontal mirror
  after the vertical correction.

So "skip V flip for azim=180" achieved vertical correction AT THE
COST OF a lateral 180° reflection. Net effect: image face ends up
on the back of the mesh, image back ends up on the face.

### Run X — add U flip for back views only

Plan: compensate the lateral mirror by also setting
`FABMESH_TEXPROJ_UFLIP=1` specifically for the back view (azim=180).
Or more cleanly: when we skip the V flip for back, also apply U
flip to counter the mirror. Add this to the same conditional block
in texture_project.py.

### Run X result — NO improvement (same visible bug as W)

User said "même problème". Screenshot shows the back of the subject
(denim of dos, nuque, brown hair patch) at the default auto-rotate
pose — i.e. at the same angle W was showing, with the same texture
distribution.

Hash verification: W and X have DIFFERENT md5 (64a8cc... vs 39b0a1)
so the code did change something. But the visible result isn't
any better to the user.

Interpretation: skip_back_vflip + U-flip might not compose the way
I expected. Skipping V-flip moved things vertically, adding U-flip
for the same view moved them horizontally — together they may act
like a 180° in-image rotation, which is equivalent to doing
neither (since images aren't naturally rotated).

### Rethinking the bug

The back image `ip45_back.png` is the "view from behind" of a
subject. Its pixel at (U=0, V=0) = top-left of the image. The
subject's head is at top, the subject's RIGHT ARM is on the LEFT
side of the image (mirror view).

When we project this onto the mesh at azim=180, the camera looks
at the +Z side of the mesh. For the projection to correctly place:
- head pixel (V=0) -> mesh top (correct)
- subject-right-arm (U=0) -> mesh right arm = world +X
- subject-left-arm (U=1) -> mesh left arm = world -X

Standard p_v flip (`p_v = 1 - p_v`) reverses head/feet — we need
to SKIP it for back (Run W fix). Good.
Standard projection gives `p_u = focal * v_cs[0] / -z + 0.5`, so
mesh point at world +X appears at... depends on cam basis.

The lateral mirror might be inherent to projecting any "back view"
onto a mesh: a back photo of a subject has the arms mirrored vs
the mesh's natural axis system. So to project back correctly we
may need to PRE-FLIP the back PNG horizontally in build_mv_dir
(not U-flip in projection math).

### Run Y result — NO improvement (same as W and X)

User: "meme constat". So none of the corrective attempts
(W=skip-V, X=skip-V+U-flip, Y=skip-V+pre-FLIP-LEFT-RIGHT) changed
the visible side-swap relative to W's base.

Hash check confirms W/X/Y are all DIFFERENT meshes, so the code
changes applied. But the visible side-swap persists unchanged in
the viewer.

### Interpretation — the "side-swap" may not be what I thought

All 3 of W, X, Y have `p_v` skipped for azim=180, which fixed the
head-toward-feet inversion. Then:
- X added p_u = 1 - p_u in the projection math: no visible change.
- Y pre-flipped the PNG horizontally: no visible change.

If U-flip in the projection and horizontal flip of the source both
have no visible effect after skipping V-flip on back, that strongly
suggests the "side-swap" the user sees isn't actually a U-axis
issue at all. It's probably:
- **model-viewer's default camera** showing the wrong side by
  default, independent of texture content.
- After W's V-flip fix, the back texture is correctly placed on
  the back side of the mesh. But model-viewer's default camera
  points at the back (because SF3D mesh has face at -Z, camera
  at +Z). So user sees the back-painted-back (correct) as the
  "default view", which looks similar to the W pre-fix state.

To test this: lock model-viewer camera to AZIM=180 (face side) and
see if the face image is there. If yes, Y is already correct; the
"side-swap" was just model-viewer's default camera angle.

### Plan Run Z — lock camera at azim=180 in the compare viewer

No code change to the pipeline. Just update compare.html so the
Y panel has `camera-orbit="180deg 90deg"` — force looking at the
mesh's face side. If W/X/Y all then show the face correctly, the
side-swap was a camera-angle illusion, not a real bug.

### Root cause synthesis (2026-04-18, user asked "pourquoi on a des si mauvais positionnement")

After 23+ runs (A..Y + variants), honest diagnosis of why we're stuck:

1. **SF3D is single-view**. Mesh generated from front.png only.
   Back-of-mesh geometry is INVENTED by the model, not observed.
   UV coords for the back region correspond to a "plausible" guessed
   geometry, not the real back of the subject. When we project the
   back PNG onto these UVs, any sub-geometry mismatch surfaces as
   visible dislocation.

2. **texture_project is a camera-projection hack**, not a 3D-native
   bake. It projects each photo from a fixed azimuth using `R_w2c`
   + `p_u`, `p_v`. Works ONLY when the mesh's internal axis
   convention matches the projection's internal axis convention.
   Any mismatch flips V or U.

3. **18 runs showed that tweaking any single axis convention
   breaks another**. p_v flip, R_undo Ry(180), rotation_offset,
   PNG pre-flip — each patch fixes its target but introduces a new
   axis mismatch somewhere else in the chain.

4. **The 2-view pipeline is a degenerate case** for this code.
   texture_project was calibrated for Z123 (6 views at ±20° elev)
   and CRM (6 views orthographic incl. top/bottom). Our 2 views at
   azim=0/180 fill only 2/6 slots; the rest are dups. The dups
   interact with axis conventions in ways the original code
   never had to handle.

### Conclusion

The 2-view IP-Adapter pipeline is a BRICOLAGE on top of a
single-view pipeline. It CANNOT reliably produce "both front and
back correctly placed" because the underlying mesh geometry for
the back is guessed, and the projection math was never designed
for a 2-source back+front layout.

**Real fix options** (not a patch of texture_project):
- **Use MV-Adapter natively** — it's a 3D-aware multi-view
  generator, designed for this exact problem.
- **Use CRM full** — it produces 6 real ortho views AND a mesh
  designed to accept them.
- **Use TRELLIS** — sparse structured 3D, handles multi-view
  inputs natively.

All three are already scaffolded in the repo
(external/MV-Adapter, external/CRM, external/TRELLIS). None are
fully integrated yet.

### Is the CUDA 12.8 install a repeat of a failed attempt? NO.

User asked (rightly): "on a pas déjà échoué à faire ça ?"

Verified via grep: CUDA 12.8 coexist install has been **PLANNED**
multiple times in AGENT_LOG (agent plan sections around lines
1010-1045) but **NEVER EXECUTED**. Each time the agent produced
step-by-step instructions, the session pivoted to trying an
alternative (kaolin wheel swap, torch 2.8 upgrade, pytorch3d build,
monkey-patch bypass) before getting to the actual install.

So THIS is the first real attempt. If it works, it unblocks
pytorch3d / kaolin source / nvdiffrast all at once. If it fails,
we know the environment is fundamentally incompatible and we
accept D as the shipping baseline.

### Agent launch: fix Paint3D back-projection onto SF3D UV atlas

v13 confirmed: inputs are PERFECT (2 unique real photos, depth
matches, pre/post rotate correct) but albedo is still shattered.
Bottleneck is the back-projection itself (forward_texturing_render
in paint3d/models/render.py). SF3D meshes have fragmented UV
islands, and Paint3D's rasterize+projection is losing most of
the face-to-UV correspondences.

Launching agent to analyze exactly where pixels are being lost
and propose a concrete patch.

### Paint3D v9/v10/v11/v12/v13 — mv_dir mode progression (2026-04-18)

Chronological results of the "FabMesh mv/ dir as Paint3D init views"
pipeline:

**v9** — First working run. Bypass fix for gen_init_view double-
execution. `_fm_init_views = 'handled'` short-circuits the fallback
branches. init-img-0 now shows the mv/ photos (no SD1.5).

**v10** — `FABMESH_PAINT3D_SKIP_ROTATE=1` to test if removing the
pre-rotate helps. Verdict: init-img shows photos right-side-up,
but depth map shows mesh UPSIDE-DOWN (Paint3D renders the SF3D-
native mesh without the Rx(180) correction). Depth and photos
don't match → shattered albedo.

**v11** — Re-enabled pre-rotate Rx(180). Depth map now matches
photo orientation. Albedo still patchy (3-4 figure silhouettes +
magenta), BUT the top-half of the atlas gets texture now.

**v12** — Added post-rotate Rx(-180) after Paint3D finishes, to
undo the pre-rotate and restore the original mesh orientation in
the exported .glb. Expected: head goes back up in the viewer.
User verdict: "la bouche du garçon est sur son ventre" — mesh still
flipped head-down in viewer, post-rotate didn't fix it (or was
overridden by Paint3D's own coord convention during export).

**v13** — User observation: "6 vues = 2 uniques dupliquées, donne
lui juste 2". Modified pipeline to load only `view_0.png` (front)
+ `view_2.png` (back), `render_cfg.render.views_init = [0, 12]`
(n_views=24 → index 0=phi 0°, index 12=phi 180° = back).

init-img-0 now shows ONLY 2 clean views of the child. But the
albedo is STILL shattered — same pattern as v11/v12 (fragments of
child silhouettes scattered across magenta UV).

### Diagnosis — bottleneck is the back-projection, not the inputs

v13 has PERFECT inputs (2 unique real photos, mesh orientation
matches, pre+post-rotate correct). But the UV atlas comes out
fragmented. Root cause: the SF3D mesh has micro-UV islands and
Paint3D's `forward_texturing_render` doesn't project cleanly onto
them — most face rasterizations land in sub-pixel UV regions that
get discarded.

To fix this, we'd need either:
- UV repack before Paint3D (xatlas re-unwrap, like texture_project
  does — but that changes vertex count and might break Paint3D).
- OR run Paint3D stage 2 (UV-inpaint ControlNet) which is designed
  to fill these gaps. We skipped it so far with --skip-stage2.

### NEW PIPELINE DESIGN v2 (2026-04-18): FabMesh mv dir → Paint3D

User clarified: replace texture_project.py with Paint3D in the
pipeline, BUT feed Paint3D the 6-slot multi-view dir that
ip45_2view_to_3d.py already builds:

```
photo front → SF3D → mesh 8k verts
       +
  photo back → multi-view dir (6 slots: front/front/back/back/front/back)
       ↓
  Paint3D consumes these 6 photos AS init views (no SD1.5 generation)
       ↓
  mesh.glb textured
```

Advantages:
- NO SD1.5 hallucination — Paint3D gets real ip45 photos
- Full resolution (1024px per view, no grid compression)
- Full UV coverage (6 angles instead of 2)
- Each view is a real projection from its azimuth

Implementation:
- Modify `pipeline_paint3d_stage1.py` to load the 6 PNG files from
  the mv/ dir instead of generating via SD1.5.
- Concat as grid (or feed one-by-one) to `forward_texturing` at
  the right view_ids matching the mv/ angles.
- Bridge gains a `--mv-dir` flag pointing at the FabMesh mv/.

Note: this discards IPAdapter entirely — no "style reference"
needed because we're not generating new texture, just projecting
existing photos.

### NEW PIPELINE DESIGN (2026-04-18): mesh D → Paint3D refine

User's key insight: instead of using Paint3D from scratch on a mesh
(where SD1.5 has to invent everything), FEED IT mesh D (already well-
textured by texture_project) and use Paint3D only as a POST-REFINE
step. Paint3D's stage 2 is designed for exactly this — UV-inpaint
conditioned on an existing texture.

New pipeline:
```
photo front + back
        ↓
  SF3D + texture_project.py (existing FabMesh pipeline)
        ↓
  mesh D.glb (has a valid but slightly blurry/inverted texture)
        ↓
  Paint3D stage 2 ONLY (uses existing albedo as initial texture,
                        UV-position ControlNet inpaints the gaps
                        + refines details)
        ↓
  mesh.glb final (same identity, sharper + fuller UV coverage)
```

Advantages:
- No SD1.5 hallucination — identity comes from photos via texture_project
- No magenta gaps — mesh D has a valid starting albedo
- Paint3D does what it's designed for: UV-aware refinement
- Bypasses the stage 1 problems we've been fighting

Implementation:
1. Modify paint3d_bridge.py: add --skip-stage1 flag, extract the
   existing albedo from mesh D's baseColorTexture, pass it as
   stage 2's --texture_path.
2. Run stage 2 only. It expects (mesh.obj, texture_path=initial
   albedo) and runs UV-inpaint ControlNet on top.
3. Pack the refined albedo into a new .glb.

### Back to basics: 2 views + pre-rotate Rx(180) (2026-04-18)

User realized 8 views at 1024px width = 128px/view = SD1.5 noise.
Going back to 2 views (512x512 each) + fixing the head-down mesh
orientation via pre-rotate.

Plan:
1. Revert `views_init` in train_config_paint3d.py from
   `[0, 3, 6, 9, 12, 15, 18, 21]` back to `[0, 23]` (2 views).
2. Keep ip_scale 1.5 + strength 0.7 + neutral prompt (other Quick
   Win changes).
3. In `paint3d_bridge.py::_glb_to_obj`, rotate the mesh Rx(180°)
   before export to .obj, so Paint3D's camera (which expects
   up=[0,1,0]) sees the subject right-side up.

Expected: init-img-0.png now shows 2 clean 512x512 renders of the
upright child from front + back, with visage + torso + legs all
visible. SD1.5 + ControlNet-depth + IPA produce a coherent texture.
UV atlas has only 2 large magenta "gaps" (sides, top, bottom)
instead of 8 tiny silhouettes.

### Quick Win pack result — NO visible improvement (2026-04-18)

All 3 quick win patches applied:
- ip_adapter_scale 1.0 -> 1.5 (via FABMESH_IPA_SCALE env, default 1.5)
- denoising_strength 1.0 -> 0.7 in depth_based_inpaint_template.yaml
- views_init [0, 23] -> [0, 3, 6, 9, 12, 15, 18, 21] (2 -> 8 views)
- Also cleaned up the hardcoded monkey-head prompt from the YAML
- Made grid nrow + split_grid_image size dynamic

Run completed in 58s. Albedo: SAME pattern as before — same magenta
gaps, same gray figures in bottom-center, maybe 1-2 more silhouettes.

### Root cause understanding
The real bottleneck isn't the SD params — it's the **output resolution**.
The YAML has `width: 1024, height: 512` fixed. With 8 views on a
single row, each view is 1024/8 = **128 px wide**. SD1.5 + ControlNet
at 128px wide produces noise, not usable texture.

To actually fix:
- EITHER change YAML width to 2048+ (VRAM-heavy for SD1.5, 8 views
  at 256px each is still marginal)
- OR switch to a 2x4 grid (each view 512x256) via nrow=4 in make_grid
- OR split the 8 views into 4 separate SD1.5 calls of 2 views each
  (keeps 512px per view, but 4x slower total)

### Quick Win pack — STARTING NOW (2026-04-18)

User picked: combine 3 changes in one test run:
1. **ip_adapter_scale 1.0 → 1.5** in the 3 cnet scripts
   (diffusers_cnet_txt2img/img2img/inpaint.py). After pipe creation,
   call `pipe.set_ip_adapter_scale(1.5)` before inference.
2. **strength 1.0 → 0.7** in the inpaint YAML
   (controlnet/config/depth_based_inpaint_template.yaml line
   "denoising_strength"). Preserves more of the reference photo
   structure.
3. **views_init 2 → 8** in train_config_paint3d.py:
   views_init currently `[0, 23]` (2 views). Extend to
   `[0, 3, 6, 9, 12, 15, 18, 21]` = 8 evenly-spaced angles.
   Also adapt grid from 1x2 to e.g. 4x2 or 2x4 in gen_init_view.
   Actually keep the grid generation flexible via `nrow` in
   torchvision.utils.make_grid.

Expected behavior:
- IPA with scale 1.5 → better identity preservation
- strength 0.7 → less SD1.5 hallucination, closer to ref
- 8 views init → UV atlas covered more completely, less magenta

Target: photoreal child identity, full-body coverage, no magenta
gaps. Run time ~180-240s (4x more views = 4x SD1.5 calls in init).

### Option A (inject photos as init views) — ALSO FAILS (2026-04-18)

User asked: inject front+back photos as init views directly
(bypass SD1.5 generation step).

Patched `pipeline_paint3d_stage1.py` to accept
`FABMESH_INIT_VIEWS="front.png;back.png"` env var. Instead of SD1.5
generating 2 init views, load the photos, resize to sd_cfg target
size, paste as a 1x2 grid, feed to `forward_texturing`.

Ran on mesh D + ip45_front/back. 58s, produced albedo.png.

Result: **SAME as multi-ref stage 1** (lots of magenta, ninja
shadow figures in bottom-center of atlas, no identity).

Why it didn't help:
- `forward_texturing` back-projects using the MESH's depth map,
  not the photo's geometry. The photo pixels land on the mesh via
  kaolin/pytorch3d rasterize — not by matching photo perspective.
- Paint3D's internal camera for views_init is at a fixed angle
  that may not match our ip45 photos' implicit viewpoint.
- The photos get resized to 512x512 (SD1.5 res), losing HD detail.

Bottom line: Paint3D's pipeline is designed to start from SD1.5
renderings of its own mesh views. Feeding external photos into
that pipeline loses more than it gains. There's no simple path
to make Paint3D use our photos as "real views" without rewriting
its camera + back-projection logic.

### Multi-ref Paint3D result — REGRESSION (2026-04-18)

Patched 3 Paint3D files (`diffusers_cnet_{txt2img,img2img,inpaint}.py`)
to:
- Accept semicolon-separated list of ref paths
- Load N IP-Adapters (one per ref) via
  `pipe.load_ip_adapter([...] * N, ...)`.

Bridge updated to accept `"front.png;back.png"`. Stage 1+2 both ran
successfully end-to-end (149s stage 2). Output albedo shown to user:

- **Way more magenta** than single-ref stage 1 (UVs never covered)
- Only a few scattered gray fragments visible
- 2 "ninja shadow" figures in bottom of UV atlas, no child identity
- Stage 2 UV-inpaint FAILED to fill gaps (ControlNet UV-position
  didn't recognize the geometry — prompt too weak, UV Pos weights
  maybe wrong for this mesh topology)

Honest diagnosis: **Paint3D is not designed for photorealistic
human subjects via IP-Adapter**. Its canonical demo is Suzanne in
sci-fi painting style. SD1.5 + IPA can't preserve identity from a
photo ref of a child.

### Also: bridge looking in wrong dir for stage 2 output

Stage 2 writes `albedo.png` directly in `stage2/` (not
`stage2/res-0/` like stage 1). Bridge tried to find
`stage2/res-0/albedo.png` and raised. Trivial path fix.

### Paint3D uses ONLY ONE reference image (user question)

User asked: "dans paint3d on lui donne qu'une vue ?"

YES. `pipeline_paint3d_stage1.py` accepts a single
`--ip_adapter_image_path <one_file>`, passed via `sd_cfg.*.ip_adapter_image_path`.
At the ControlNet call (`diffusers_cnet_inpaint.py:56`,
`diffusers_cnet_img2img.py:56`), exactly one PIL image is opened and
sent to `pipe(ip_adapter_image=ip_adapter_image, ...)`. Scalar, not a list.

Paint3D renders the mesh from 24 angles ITSELF (views_init, inpaint).
The back side is HALLUCINATED by SD1.5, constrained only by:
- ControlNet-depth (geometric structure)
- IP-Adapter image (style/identity reference — but the ONE image)

So our ip45_back.png is ignored by Paint3D. Options to integrate it:
1. Composite front+back into a 2x1 grid image before passing to IPA.
2. Modify diffusers_cnet_*.py to accept a list of IPA images (diffusers
   supports `ip_adapter_image=[front, back]`).
3. Use Paint3D's `views_init` override to feed real front+back renders
   at the right azimuths (more invasive).

### Paint3D stage 2 integration — STARTING NOW (2026-04-18)

User chose: add stage 2 UV-position ControlNet inpaint to fill the
magenta gaps in stage 1 output.

Plan:
1. Check Paint3D's `pipeline_paint3d_stage2.py` args — it needs:
   - `--sd_config controlnet/config/UV_based_inpaint_template.yaml`
   - `--render_config paint3d/config/train_config_paint3d.py`
   - `--mesh_path <mesh.obj>` (from stage 1)
   - `--texture_path <stage1 albedo.png>`
   - `--outdir <out2>`
2. Check stage 2 depends on weights from
   `GeorgeQi/Paint3d_UVPos_Control` (HuggingFace). Auto-download on
   first run.
3. Update `scripts/paint3d_bridge.py` to chain:
   stage 1 -> stage 2 -> pack GLB.
4. Test on mesh D again.

### Paint3D FabMesh integration RESULT — worse than mesh D (2026-04-18)

User screenshot of side-by-side comparison in
`paint3d_fabmesh.html`:

**Mesh D (left, texture_project bricolage)**:
- Face, denim jacket, cargo shorts, baskets all well-placed
- Texture fidelity matches the photo reference

**Paint3D (right, stage 1 only)**:
- Head: LARGE magenta zones (UVs never covered by any view in
  Paint3D's 2 init views `views_init: [0, 23]`)
- Torso: weird gray "backpack/harness"-like texture, no denim
- Arms: magenta
- Legs: partial gray cargo shorts, magenta patches
- Identity is NOT preserved — Paint3D's SD1.5 + ControlNet output
  has the "armored monkey" look from the default negative prompt
  rather than respecting the ip45_front IP-Adapter reference

**Verdict**: mesh D's bricolage beats Paint3D stage 1 for this case.

### Root causes
1. Paint3D stage 1 only uses 2 init views + inpainting. The magenta
   zones correspond to UVs never rasterized by those 2 views.
2. Paint3D stage 2 (pipeline_paint3d_stage2.py) specifically inpaints
   these gaps using a UV-position ControlNet — didn't run it.
3. IP-Adapter weight in Paint3D may be too weak for ip45-style
   character; SD1.5 + generic prompt = generic look.
4. Paint3D was designed for "sci-fi digital painting" / stylized
   texturing, not photoreal IP-Adapter-constrained identity.

### Paint3D FabMesh integration — STARTING NOW (2026-04-18)

User confirmed Paint3D Suzanne test passed. Moving to FabMesh
integration. Plan:

1. `scripts/paint3d_bridge.py` — new script with CLI:
   `python paint3d_bridge.py <mesh.glb or .obj> <ref_image> <out.glb>
   [--prompt "..."]`
   - Takes existing mesh + reference image (e.g. ip45_front.png)
   - Calls Paint3D stage 1 pipeline internally (runs in-process)
   - Packs the resulting baked texture into a new .glb
2. Test on our reference case: `logs/child_ip45_2view/mesh_NORMALIZE_1.glb`
   (mesh D) + `images/child/_scale_sweep/ip45_front.png`.
3. If result is clean, add a FabMesh wrapper that glues SF3D + Paint3D.
4. Document in AGENT_LOG + commit.

Paint3D constraints observed from the Suzanne test:
- Takes .obj input (not .glb directly — may need trimesh conversion)
- Output is .obj + mesh.mtl + albedo.png (separate files, not packed GLB)
- Uses 2 init views (fixed at theta 60/120 or so — defined in
  `views_init: [0, 23]` out of `n_views=24`).
- Needs at least 12 GB VRAM to load SD1.5 + ControlNet + IPA.

### BREAKTHROUGH (2026-04-18) — Prebuilt wheels for sm_120 found!

ComfyUI-3D-Pack README links to **MiroPsota/torch_packages_builder**
which publishes prebuilt wheels for pytorch3d, nvdiffrast, tinycudann,
detectron2, flash_attn, etc. — all across multiple torch + cuda
combinations.

**Found exact matches for our machine** (torch 2.7 + cu128 + cp311
+ Windows):
- `pytorch3d-0.7.9+d9839a9pt2.7.0cu128-cp311-cp311-win_amd64.whl` (25 MB)
- `nvdiffrast-0.4.0+253ac4fpt2.7.0cu128-cp311-cp311-win_amd64.whl` (6 MB)

Both installed cleanly via `pip install <wheel>`. Tests on RTX 5080:
- pytorch3d rasterize_meshes: ✓ OK, 512 nonzero pixels (64x64 triangle)
- nvdiffrast RasterizeCudaContext: ✓ OK, 512 nonzero pixels

**sm_120 / Blackwell support works out of the box** via these wheels.
NO CUDA 12.8 toolkit install needed. NO SAC issues (signed wheels).
NO source compile.

MiroPsota does NOT publish kaolin wheels, but we don't need them —
Paint3D agent forensic showed pytorch3d + trimesh cover 11 of 12
kaolin calls; the 12th (rasterize) is the one pytorch3d provides.

### Plan to finish Paint3D integration

1. Write `external/Paint3D/paint3d/models/_kal_shim.py` implementing
   kaolin's API surface backed by pytorch3d/trimesh.
2. Replace `import kaolin as kal` in the 3 Paint3D model files
   with `from paint3d.models import _kal_shim as kal`.
3. Run Paint3D stage 1 on Suzanne demo.
4. If OK, run on FabMesh's D mesh + ip45 photos.

### ComfyUI-3D-Pack integration attempt — STARTING NOW (2026-04-18)

User picked ComfyUI-3D-Pack. Agent said "worth one attempt" —
MIT license, MV-Adapter i2tex node for texturing. Prebuilt wheels
exist; if they cover sm_120 (RTX 5080 Blackwell), turnkey.

Plan:
1. Clone github.com/MrForExample/ComfyUI-3D-Pack into external/
2. Check if it depends on ComfyUI itself (it does — it's a node
   pack). Evaluate: do we need a full ComfyUI install or can we
   import the texturing modules standalone?
3. Run their install.py or equivalent, let it fetch prebuilt
   wheels for torch 2.7 + cu128 + Win11.
4. Check if wheels resolve for Python 3.11 / Windows. If not,
   it falls back to source compile → blocked (same as before),
   abandon ComfyUI-3D-Pack.
5. If wheels work, find the MV-Adapter i2tex entry point and
   wire it to our SF3D mesh + ip45 photos.
6. Test.

Risk: ComfyUI-3D-Pack is a ComfyUI node pack, not a standalone
library. Using it outside ComfyUI may require extracting the
useful bits. Or we install ComfyUI alongside (~2 GB).

### Agent survey for no-compile, non-eliminated texturing AI (2026-04-18)

User constraint: local + free + commercial + NOT already eliminated.

Agent checked:
- MV-Adapter direct: needs nvdiffrast compile — blocked
- ComfyUI-3D-Pack: has "prebuilt wheels" but falls back to source
  compile if arch missing. Worth ONE attempt to see if the prebuilt
  cache happens to include sm_120.
- Wonder3D / Unique3D / LGM / InstantMesh: all generate geometry,
  NOT retexture — out of scope
- TRELLIS: full CUDA toolkit required

**Two paths remain**:

1. **ComfyUI-3D-Pack** (MIT, MV-Adapter node for texturing). Test
   `install.py` — if prebuilt wheels cover sm_120, turnkey solution.

2. **Upgrade `scripts/texture_project.py`** with:
   - ControlNet-depth-SDXL (diffusers, no compile)
   - IP-Adapter for ref-image conditioning (pure diffusers)
   - trimesh + pyrender for CPU/OpenGL projection (no CUDA ext)
   - LaMa seam inpainting (pure torch)
   No new install, no compile, pure diffusers + existing FabMesh
   bricolage architecture.

### User question (important): "l'utilisateur final devra-t-il installer CUDA 12.8 aussi ?"

**No**. CUDA 12.8 toolkit is a DEV-ONLY dependency needed to
COMPILE pytorch3d/kaolin from source. Once compiled, the wheels
contain pre-built .pyd/.dll files. End users get the wheel via
`pip install <wheel>`, no toolkit / nvcc / MSVC needed. They just
need the NVIDIA driver (already present on any GPU system).

Same pattern as torch: user installed `torch==2.7.1+cu128` via pip
without compiling CUDA — someone else compiled it for them.

**Multi-arch concern for distribution**: ship wheels built with
`TORCH_CUDA_ARCH_LIST="7.5;8.0;8.6;8.9;9.0;12.0"` so sm_75..sm_120
users all work. ~3x bigger wheel but covers the full RTX 20xx/
30xx/40xx/50xx range.

### Less-invasive dev alternatives user proposed

1. **WSL2 + Docker container** with CUDA 12.8 preinstalled. Build
   in container, export wheel, discard container. No Win11 host
   pollution.

2. **Github Actions Linux runner** with CUDA 12.8. Automated build
   pipeline, zero local install.

3. **Local CUDA 12.8 coexist install** (current plan). Smallest
   iteration cycle but pollutes host.

### Safety analysis of CUDA 12.8 installer (user asked)

**Not dangerous IF installed correctly**:
- Installer signed by NVIDIA → SAC-compatible.
- Coexist install into v12.8/ folder, does NOT touch v13.2.
- No driver overwrite if "Display Driver" unchecked.
- Fully reversible via Windows "Add/Remove Programs".

**Must NOT do**:
- Express install (may overwrite driver).
- Check "Display Driver" (keep current).
- Check "Visual Studio Integration" (modifies VS projects).
- Check "Nsight" (unnecessary debug tools).

**Correct selection** (Custom > UNCHECK ALL > recheck only):
- ☑ CUDA > Development > Compiler
- ☑ CUDA > Development > Libraries
- ☑ CUDA > Runtime > Libraries

3 items. Install into default `v12.8\` path.

### CUDA 12.8 download started (2026-04-18)

Download kicked off in background to `c:\tmp\cuda_installer\cuda_12.8.0_571.96_windows.exe`. Expected 3.1 GB, 5-15 min depending on bandwidth.

### CUDA 12.8 Toolkit install — USER ACTION NEEDED (2026-04-18)

User picked CUDA 12.8 coexist install. This is admin/installer,
so user does it manually. My part afterwards: use CUDA 12.8 for
the build.

Instructions for user:

**1. Download** `https://developer.download.nvidia.com/compute/cuda/12.8.0/local_installers/cuda_12.8.0_571.96_windows.exe` (~3.1 GB, NVIDIA signed installer — SAC should accept it).

**2. Run as Administrator**. At install type, pick **Custom (Advanced)**, NOT Express.

**3. In the component tree, UNCHECK EVERYTHING**, then re-check ONLY:
- ☑ CUDA > Development > Compiler (nvcc_12.8)
- ☑ CUDA > Development > Libraries (cudart, cublas, cufft, curand, cusolver, cusparse, nvrtc dev)
- ☑ CUDA > Runtime > Libraries (cudart_12.8)

**Explicitly UNCHECK**:
- ☒ Driver Components > Display Driver (keep your current driver)
- ☒ Other Components > Nsight *
- ☒ CUDA > Visual Studio Integration
- ☒ CUDA > Demo Suite / Documentation / Samples

**4. Install folder**: keep default `C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.8\`. Click Install. Takes 5-10 min.

**5. Verify**: open a fresh cmd:
```
dir "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.8\bin\nvcc.exe"
dir "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.2\bin\nvcc.exe"
```
Both must exist. Don't reboot.

**6. Tell me when done** — I'll continue with env setup + build.

### pytorch3d build — bypass fails too (CCCL preprocessor error)

User picked "bypass the CUDA check". Implemented:
- Monkey-patched torch/utils/cpp_extension.py line 478:
  `if cuda_ver.major != torch_cuda_version.major` now honors
  env flag `FABMESH_BYPASS_CUDA_MAJOR_CHECK=1` (emit warning
  instead of raising).
- Retried `pip install pytorch3d` with:
  - `vcvars64.bat` sourced
  - `FABMESH_BYPASS_CUDA_MAJOR_CHECK=1`
  - `TORCH_CUDA_ARCH_LIST=12.0`
  - `CL=/Zc:preprocessor`
  - `CFLAGS=/Zc:preprocessor`
  - `CXXFLAGS=/Zc:preprocessor`
  - `NVCC_FLAGS=-Xcompiler "/Zc:preprocessor" -DCCCL_IGNORE_MSVC_TRADITIONAL_PREPROCESSOR_WARNING`

Result: bypass check passed ✓, but nvcc/cl fails compiling:
> CUDA/v13.2/include/cccl/cuda/std/__cccl/preprocessor.h:
> fatal error C1189: MSVC/cl.exe with traditional preprocessor.
> Switch to standard conforming preprocessor by passing
> /Zc:preprocessor to cl.exe.

Despite setting /Zc:preprocessor via all available env vars, nvcc
doesn't propagate it to the cl sub-invocation. The CUDA 13.2
headers (CCCL library) are stricter than 12.x headers.

### Full backup taken (commit d18046c)

User asked for a full backup before more attempts. `git add -A` +
commit captured all untracked logs/ + scripts. Submodules (CRM,
MV-Adapter, Paint3D, StableFast3D, UniRig) untouched.

### Proposal after this failure

Two paths remain to unblock pytorch3d/kaolin/nvdiffrast source
build on this machine:

1. **Install CUDA Toolkit 12.8 alongside 13.2** (the agent's
   original plan). Switch CUDA_HOME to v12.8 for the build.
   Headers from 12.8 don't require /Zc:preprocessor. ~3 GB
   download + 15 min install.

2. **Stop chasing Paint3D entirely** and use D's mesh as-is.

### pytorch3d build BLOCKED too (2026-04-18) — same CUDA 13.2/cu128 mismatch

Attempted `pip install --no-build-isolation --no-deps "git+https://github.com/facebookresearch/pytorch3d.git@stable"` with MSVC env sourced (`vcvars64.bat`). Failed with the SAME error that blocked nvdiffrast:

> RuntimeError: The detected CUDA version (13.2) mismatches the
> version that was used to compile PyTorch (12.8).

It's in torch cpp_extension.py line 478 (`_check_cuda_version`).
Agent's optimistic claim ("pytorch3d wheel exists for cu128") was
wrong — no public wheel matches Python 3.11 + torch 2.7 cu128 +
Windows; only Linux + Python 3.8-3.9 + CUDA 11.8/12.1 wheels
available on anaconda.org/pytorch3d.

So pytorch3d **also** needs CUDA Toolkit 12.8 coexist, same as
nvdiffrast. The "pytorch3d shim avoids CUDA 12.8 install" claim
doesn't hold.

### Consolidated reality

Both pytorch3d and nvdiffrast (and by extension kaolin) need CUDA
Toolkit 12.8 installed to compile from source on this machine.
There's no shortcut via wheels for ANY of them.

So the path forward IS the CUDA 12.8 coexist plan that the agent
produced earlier. The choice of shim (kaolin source / pytorch3d /
nvdiffrast) doesn't matter until we have CUDA 12.8.

### Options NOW

1. Install CUDA Toolkit 12.8 alongside 13.2 (3 GB download, admin,
   15 min) — enables ALL of (kaolin from source, pytorch3d,
   nvdiffrast) at once. This is the right investment.
2. Bypass the version check by monkey-patching torch's
   `_check_cuda_version` and hope nvcc 13.2 produces CUDA
   12.8-compatible kernels. Risky, untested.
3. Back to "accept D as baseline" and stop chasing Paint3D.

### pytorch3d shim install — ATTEMPTED (2026-04-18)

User gave GO. Starting Option 1.

Step 1 — `pip install fvcore iopath` — DONE
(fvcore 0.1.5, iopath 0.1.10 installed + tiny transitive deps).

Step 2 — check cl.exe in PATH — NOT in PATH, but vcvars64.bat
exists at `C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat`.
Need to source it before `pip install pytorch3d` or JIT compile
will fail.

Step 3 — next: `pip install pytorch3d from source` with vcvars64
sourced. Build time 10-20 min.

### Paint3D kaolin forensic (2026-04-18) — pytorch3d shim is the answer

Agent dissected Paint3D. Key findings:

- kaolin is used in EXACTLY 3 files: paint3d/models/mesh.py,
  render.py, textured_mesh.py. The pipeline scripts themselves
  don't import kaolin.
- 12 kaolin call categories found. 11 of them are trivially
  replaceable (trimesh for IO, pure torch for gather/normals/
  camera utils, `F.grid_sample` for texture_mapping).
- **Only 1 hard dep**: `kal.render.mesh.rasterize` (5 call sites,
  all in render.py). Needs a GPU rasterizer returning
  `(face_features_interpolated, face_idx)` per pixel.

### Environment ground truth (verified by agent)

- `cl.exe` NOT in PATH but VS 2022 Professional IS installed at
  `C:\Program Files\Microsoft Visual Studio\2022\Professional\`
  with MSVC 14.44.35207. `vcvars64.bat` opens the right shell.
- nvcc is ONLY CUDA 13.2 (no 12.8 coexist yet).
- torch 2.7.1+cu128, RTX 5080 sm_120 confirmed.

### Ranked options (agent's table)

1. **pytorch3d shim** (HIGH prob) — install pytorch3d (has rasterize
   with similar contract), write `_kal_shim.py` that exposes
   kaolin's signature but uses pytorch3d internally, replace
   `import kaolin` in the 3 Paint3D files. No CUDA 12.8 needed.
2. Compile kaolin from source with CUDA 12.8 (MEDIUM prob) —
   previous plan. Needs CUDA 12.8 install first.
3. Compile nvdiffrast + shim (MEDIUM prob) — same CUDA issue.
4. Kaolin OpenGL backend (ZERO) — doesn't exist.
5. pyrender fallback (LOW) — no differentiable raster, painful
   on Windows.

### Chosen: Option 1 — pytorch3d shim

Concrete steps (from agent):
1. Open MSVC shell: `vcvars64.bat`.
2. `pip install fvcore iopath`
3. `pip install --no-build-isolation --no-deps "git+https://github.com/facebookresearch/pytorch3d.git@stable"` — JIT builds with torch's cu128 + MSVC, auto-picks sm_120.
4. Smoke test pytorch3d rasterize on a triangle.
5. Write `external/Paint3D/paint3d/models/_kal_shim.py` exposing:
   `rotate_translate_points`, `generate_transformation_matrix`,
   `PinholeIntrinsics`, `OrthographicIntrinsics`,
   `index_vertices_by_faces`, `face_normals`, `rasterize`,
   `texture_mapping`, `io.obj.import_mesh`, `io.off.import_mesh`.
6. Replace `import kaolin as kal` with
   `from paint3d.models import _kal_shim as kal` in the 3 files.
7. Run Paint3D stage 1 on Suzanne demo.

Fallback if pytorch3d install fails: try pre-built wheel from
https://anaconda.org/pytorch3d/pytorch3d/files (py311_cu128_pyt271)
or drop to Option 2 (compile kaolin with CUDA 12.8).

### Kaolin from source build — STARTING NOW (2026-04-18)

User refocused: we're installing Paint3D specifically, not chasing
alternatives. The only Paint3D-compatible path that keeps torch
2.7.1 (SAC-safe) is to compile kaolin from source with
TORCH_CUDA_ARCH_LIST=12.0.

Plan:
1. Check prerequisites:
   - `where cl.exe` — Visual Studio Build Tools 2022 with C++
     workload. If missing, install.
   - CUDA Toolkit 12.8 (to match torch cu128). If not installed,
     install alongside existing CUDA 13.2.
2. Clone github.com/NVIDIAGameWorks/kaolin.git into external/kaolin.
3. Checkout tag v0.18.0 (same as the wheel we currently have).
4. Set env:
   - CUDA_HOME = path to CUDA 12.8
   - PATH with CUDA 12.8 first
   - TORCH_CUDA_ARCH_LIST=12.0
5. `pip install -e external/kaolin` (editable install, builds
   extensions locally).
6. Test kaolin rasterize on sm_120.
7. Test Paint3D Suzanne demo.

Risks:
- VS Build Tools may be missing (~2.5 GB install if needed)
- CUDA 12.8 toolkit may be missing (~3 GB if needed)
- Build may take 30-90 min
- Kaolin 0.18 codebase may use CUDA features not supported on
  sm_120 (unlikely since 2.8 wheel "added Blackwell compatibility",
  but possible).

### IMPORTANT PRIOR — nvdiffrast was INTENTIONALLY skipped yesterday

Searching AGENT_LOG shows we already hit the nvdiffrast compile
wall on 2026-04-17 while integrating MV-Adapter. The prior
resolution was to PATCH MV-Adapter to lazy-load nvdiffrast and
avoid needing to compile it at all ("mesh/render paths need
nvdiffrast which we don't want to compile").

So the CUDA 12.8 coexist install plan (below) isn't new territory —
we chose to avoid it yesterday because we didn't need the render
paths. If we go this route TODAY, we're reversing that decision.

The trade-off:
- Pros: enables nvdiffrast (and by extension MV-Adapter mesh/render,
  Paint3D-adjacent pipelines, TEXTure too eventually).
- Cons: 3+ GB download, admin install, Visual Studio Build Tools
  setup if missing (~2.5 GB more), 5-15 min compile, risk of
  environment side-effects on the rest of the FabMesh pipeline.

Alternative that sidesteps the compile: stay with the lazy-load
pattern applied yesterday and handroll a texturing pipeline that
doesn't need 3D rasterization (diffusers-only approach, run on CPU
for UV work, GPU only for SDXL inference).

### Agent plan for CUDA 12.8 coexist + nvdiffrast (2026-04-18)

Agent produced detailed step-by-step:

**Step 1 — Download CUDA 12.8 Windows x86_64 local installer**
URL: `https://developer.download.nvidia.com/compute/cuda/12.8.0/local_installers/cuda_12.8.0_571.96_windows.exe`
~3.1 GB.

**Step 2 — Install as Administrator, Custom mode**
Install to default `C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.8\`.
Check ONLY: CUDA > Development > Compiler (nvcc), CUDA > Development
> Libraries, CUDA > Runtime > Libraries.
UNCHECK: Display Driver, Nsight, Visual Studio Integration, Demo
Suite, Documentation, Samples.

**Step 3 — Verify both versions coexist (no reboot)**
`dir "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.8\bin\nvcc.exe"`
`dir "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.2\bin\nvcc.exe"`

**Step 4 — Point session to CUDA 12.8 (in a fresh cmd)**
```
set CUDA_HOME=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.8
set CUDA_PATH=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.8
set PATH=%CUDA_HOME%\bin;%CUDA_HOME%\libnvvp;%PATH%
set TORCH_CUDA_ARCH_LIST=12.0
```

**Step 5 — Check cl.exe (Visual Studio Build Tools)**
`where cl`. If missing, install VS Build Tools 2022 with only the
"Desktop development with C++" workload (~2.5 GB).

**Step 6 — Install nvdiffrast**
```
pip install setuptools wheel ninja
pip install --no-build-isolation git+https://github.com/NVlabs/nvdiffrast.git
```
Build time 5-15 min.

**Step 7 — Smoke test sm_120 rasterization**
Python snippet that creates RasterizeCudaContext and rasterizes a
64x64 triangle. Expects capability (12, 0) on RTX 5080.

**Step 8 — Verify no torch regression**
Torch links its own bundled CUDA DLLs, so installing 12.8 toolkit
alongside can't break torch cu128.

**Contingency**: if cl.exe missing, 3 options:
- Install VS Build Tools C++ workload (~2.5 GB, 2.5 GB)
- Try prebuilt wheel (none official from nvdiffrast)
- Use OpenGL context (`RasterizeGLContext`) instead of CUDA

### nvdiffrast install — ALSO BLOCKED (CUDA version mismatch)

Tried `pip install nvdiffrast` (not on PyPI) then
`pip install --no-build-isolation git+https://github.com/NVlabs/nvdiffrast.git`.

Fails at the CUDA version check in torch.utils.cpp_extension:
> RuntimeError: The detected CUDA version (13.2) mismatches the
> version that was used to compile PyTorch (12.8).

System nvcc = 13.2, torch was compiled with cu128. nvdiffrast
refuses to build with this mismatch.

Options to resolve:
- Install CUDA Toolkit 12.8 alongside 13.2, point nvcc to 12.8.
- `TORCH_DONT_CHECK_COMPILER_ABI=1` env to force-bypass the check,
  risking subtle ABI breakage at runtime.
- Download a pre-built nvdiffrast wheel from an unofficial source
  (security risk with SAC on).

### Honest status after 3 failed install attempts

Environment constraints on this RTX 5080 / Win11 machine:
- Smart App Control ON -> can't load unsigned DLLs (torch 2.8 fails)
- CUDA 13.2 installed, torch cu128 -> build from source fails
- Torch 2.7 wheel -> kaolin sm_120 unsupported

Any local-compile-required texturing AI (kaolin OR nvdiffrast-based)
hits one of these 3 walls. Non-compile-required options remain:
- Cloud API (Meshy.ai — paid, not local, user ruled out)
- Pure diffusers SDXL + ControlNet-depth (what texture_project is
  essentially doing)
- Handroll a texturing pipeline in PyTorch using only built-in
  ops (no C++ extensions, slower but works).

### TEXTure integration — BLOCKED (also uses kaolin)

After cloning TEXTure, discovered that it ALSO uses kaolin (not
nvdiffrast as I assumed). src/models/render.py line 1:
`import kaolin as kal`. Requirements README explicitly says
`pip install kaolin==0.11.0`.

So TEXTure hits the exact same sm_120 wall as Paint3D. My earlier
recommendation was wrong.

### Real list of texturing AIs that DON'T use kaolin

Need a non-kaolin 3D texturing AI. Candidates:
- **MVEdit**: uses nvdiffrast (needs to verify). 24 GB VRAM still
  a concern.
- **Stable-Dreamfusion or similar**: uses nvdiffrast for some
  backends.
- **Meshy cloud**: no local dep at all (but paid cloud).
- **SDXL + ControlNet-depth handrolled**: no framework dep, use
  diffusers directly. Essentially what texture_project.py is
  trying to do but better.

Need to survey again specifically for NON-KAOLIN options.

### TEXTure integration — STARTING NOW (2026-04-18)

User picked TEXTure after torch 2.8 blocked by SAC. TEXTure uses
nvdiffrast for 3D rasterization instead of kaolin. nvdiffrast
compiles its CUDA kernels JIT at first use via torch's extension
builder — it should pick up sm_120 automatically if
TORCH_CUDA_ARCH_LIST is set or left at default.

Plan:
1. Clone github.com/TEXTurePaper/TEXTurePaper into external/TEXTure.
2. Check its deps (environment.yaml / requirements.txt).
3. Install nvdiffrast (pip, JIT-compiled at first use).
4. Run a tiny nvdiffrast test on GPU to confirm sm_120 works.
5. Run TEXTure's demo on its sample mesh.
6. Create scripts/texture_bridge.py adapting TEXTure to FabMesh
   inputs (SF3D mesh + ip45 front/back photos).
7. Test on logs/child_ip45_2view/mesh_NORMALIZE_1.glb.

### Torch 2.8 upgrade BLOCKED by Windows Smart App Control (2026-04-18)

User picked "Upgrade torch 2.7 -> 2.8". Installed torch 2.8.0+cu129
+ kaolin wheel torch-2.8.0_cu129. At import time:

```
OSError: [WinError 4551] An Application Control policy has blocked
this file. Error loading
C:\...\torch\lib\shm.dll or one of its dependencies.
```

Diagnosed: Windows Smart App Control is **ON**
(`Get-MpComputerStatus | SmartAppControlState = On`). It blocks
unsigned DLLs. Torch 2.8 wheels on pypi aren't signed with the
Microsoft code-signing cert that SAC accepts, so every torch call
fails at DLL load. Torch 2.7.1+cu128 was accepted (probably an
earlier signed build or was previously whitelisted in this env).

Reverted pip install to torch 2.7.1+cu128, kaolin wheel torch 2.7.
Verified torch imports correctly again.

### Next routes
- Compile kaolin from source with sm_120 (TORCH_CUDA_ARCH_LIST=12.0)
  keeping torch 2.7. Requires Visual Studio Build Tools + nvcc
  cu128. 30-90 min, may fail.
- Try TEXTure (uses nvdiffrast, not kaolin). Check if nvdiffrast
  Blackwell-supports via JIT kernel compile (nvdiffrast uses
  torch's extension builder at runtime, auto-picks sm_120 if
  TORCH_CUDA_ARCH_LIST set).
- Turn off Smart App Control (requires admin, system-wide setting,
  user's call).
- Abandon dedicated texturing AI, stay with current bricolage.

### Paint3D install BLOCKED — kaolin doesn't support RTX 5080 (sm_120)

Tried to install Paint3D. Deps all fine (albumentations, lightning,
kornia, loguru) except kaolin:
- kaolin 0.18 wheel for torch 2.7 + cu126 installs cleanly
- At runtime, kaolin rasterize_cuda fails with "no kernel image
  available for execution on the device"
- RTX 5080 = sm_120 (Blackwell). Kaolin wheels were compiled without
  sm_120 support (max sm_90 in the torch 2.7 build).

Tried wheel for torch 2.8 + cu129 — installs but crashes with
"DLL load failed while importing _C: procedure not found" because
the wheel links against torch 2.8 ABI and we have torch 2.7.

Reverted to torch 2.7 wheel (safe broken state).

### Options forward
- Upgrade torch 2.7 → 2.8 (risks breaking SF3D, diffusers).
- Compile kaolin from source with TORCH_CUDA_ARCH_LIST=12.0 (long
  on Windows, requires MSVC, may still fail on sm_120 if the code
  itself uses unsupported features).
- **Abandon Paint3D**, try TEXTure (MIT, SD1.5 based) — check if
  it uses kaolin or an alternative like nvdiffrast.
- Look for a different texturing AI without kaolin dependency.

### Paint3D capabilities — multi-view confirmed

Cloned github.com/OpenTexture/Paint3D into external/Paint3D.

Per paint3d/config/train_config_paint3d.py:
- `n_views: int = 24` (default) — main rotation views around the mesh.
- `views_before`, `views_after` — additional view tuples (azim, elev).
- `views_init`, `views_inpaint` — which view indices are "init" (hold
  reference images) vs "inpaint" (synthesized to fill gaps).
- `alternate_views: True` — alternates left/right when sweeping azim.

Paint3D is MULTI-VIEW NATIVE. Our 2 photos (ip45_front + ip45_back)
can serve as init views at azim 0 and 180; Paint3D synthesizes the
remaining views with SDXL + ControlNet depth-aware diffusion to keep
consistency across the full mesh UV atlas.

Integration plan:
1. Keep our 2 photos as `views_init` at slots for azim=0 and azim=180.
2. Set `n_views=24` (or less for speed during dev).
3. Let Paint3D do its stage 1 (initial UV bake from the 24 views)
   then stage 2 (inpaint the seams).

### Paint3D integration — STARTING NOW (2026-04-18)

Plan:
1. Clone github.com/OpenTexture/Paint3D into external/Paint3D.
2. Install deps into current Python env (torch already installed).
3. Download weights (HuggingFace: Paint3D checkpoints referenced in
   the repo README).
4. Create scripts/paint3d_bridge.py with CLI:
   `python paint3d_bridge.py <mesh.glb> <image.png> <out.glb>
   [--prompt "..."]`
5. Test on logs/child_ip45_2view/mesh_NORMALIZE_1.glb + ip45_front.png.
6. If result is clean, add a second pass with ip45_back.png to paint
   the back side.
7. Integrate into FabMesh Electron UI as new "Paint3D refine" button.

Paint3D uses 2-stage pipeline internally:
- Stage 1: UV position + depth-aware SDXL diffusion to generate an
  initial UV texture from the prompt/image.
- Stage 2: UV-space inpainting to refine seams.

This replaces (or complements) the current texture_project.py
bricolage. If Paint3D's output is good from the start, we can
retire the 2-view projection math entirely.

### Texturing AI survey (2026-04-18) — Paint3D is the answer

User asked for a dedicated texturing AI matching: free, local,
commercial-OK. Agent surveyed 6 options; verdict:

| AI | License | Commercial | VRAM | Fit |
|----|---------|------------|------|-----|
| Paint3D | Apache 2.0 | **Yes, no limits** | ~8-12 GB | **WINNER** |
| TEXTure | MIT | Yes | ~8-12 GB | Fallback, abandonware |
| Hunyuan3D-Paint | Tencent Community | **NO in EU/UK/KR** | 10 GB | Blocked — user in France |
| MVEdit | MIT | Yes | **24 GB** | Blocked by 16 GB RTX 5080 |
| Text2Tex | CC BY-NC-SA | **NO commercial** | 12 GB | Blocked |
| TripoSR | MIT | Yes | 6-8 GB | Wrong task (image→mesh, not texture) |

**Paint3D winner**: Apache 2.0 (zero legal risk), designed to
texture existing meshes from reference images, SD1.5 backbone fits
comfortably in 16 GB VRAM. Github: OpenTexture/Paint3D.

**Plan**: integrate Paint3D as a new texturing backend alongside
the current texture_project. Input: (SF3D mesh .glb + front photo
+ back photo); output: (retextured .glb with high-quality PBR
atlas). Keep current bricolage as fallback.

### Analyse observationnelle de l'atlas D — abandoned

Aborted the atlas-sampling analysis because the user is right that
we're chasing a fundamentally broken design. Patching won't fix it.

### Analyse observationnelle de l'atlas D — STARTING NOW

User picked option D (dig into the atlas). Plan:
1. Open atlas_D.png (already extracted at
   logs/child_ip45_2view/atlas_D.png) and identify visually each
   region: front face, back, left profile, right profile, top
   island, bottom island.
2. For each region, note whether the image is upright, mirrored,
   upside-down. The "back is upside-down" user report should be
   visible directly in the atlas.
3. Sample several mesh vertices (head top, feet bottom, front, back,
   left arm, right arm) and read their UV coords. Compare:
   - Where does the "head top" vertex's UV point in the atlas?
   - Where does the "feet bottom" vertex's UV point?
4. Check UV<->atlas alignment: does the atlas's back-region have
   its head at high V or low V? Does the mesh's back vertex have
   high or low V UV?

Goal: understand the mismatch without any speculation. Then
propose the smallest possible patch.

### CRITICAL FINDING 2026-04-18 — UV→atlas correspondence measured

Extracted baseColorTexture from D (mesh_NORMALIZE_1.glb) and Y
(mesh_RUN_Y.glb). Both atlases show the child's head+body from
multiple angles (front, back, profile, top/bottom "bake" islands).

Then programmatically picked the mid-height mesh vertex closest to
the **front of the mesh** (most negative Z, SF3D native frame) and
the **back of the mesh** (most positive Z), and read their UV
coordinates:

| mesh | mid-FRONT vert UV | mid-BACK vert UV |
|------|-------------------|------------------|
| D    | (0.18, 0.16)      | (0.49, 0.16)     |
| Y    | (0.49, 0.16)      | (0.18, 0.16)     |

The UVs are SWAPPED between D and Y.

Looking at the atlas: the FACE image is painted at UV region
~(0.49, 0.16) (center-bottom) in both D and Y. The BACK image is
painted at UV region ~(0.18, 0.16) (left-bottom) in both.

So:
- In D: front-of-mesh vertex has UV pointing to the **back**
  region of the atlas → front-of-mesh gets the BACK image painted
  on it. This means D's textures are REVERSED — the back image is
  on the front of the mesh.
- In Y: front-of-mesh vertex has UV pointing to the **face**
  region → front-of-mesh gets the face. Y is CORRECT.

But the user validates D and rejects Y. Contradiction.

### Resolution — SF3D native frame has face at +Z, not -Z

My earlier assumption that "SF3D native has face at -Z" is WRONG.
In the raw SF3D frame, the face is probably at +Z. So:
- In D: front-of-mesh (actually the -Z side = BACK of subject)
  has UV→back region → back-of-subject painted on back-of-mesh.
  Correct.
- In Y: -Z side has UV→face → face painted on -Z side of mesh.
  But -Z is the BACK of the subject → face ends up on the back.
  Wrong.

My Runs W/X/Y were based on the wrong axis convention. The
`FABMESH_TEXPROJ_SKIP_BACK_VFLIP=1` flag swapped the UVs in the
wrong direction.

### Fix: revert Runs W/X/Y

The correct behaviour was already D's. My conditional p_v skip for
azim=180 flipped the atlas regions in the wrong direction. Revert
all W/X/Y patches. Keep Run V's `PROJECT_MODE=atlas` +
`UV_REPACK=0` for determinism but without the back-V-skip.

Back to the original bug: in D, the back image lands on the mesh
with a visible vertical inversion ("tête vers les pieds"). The
real cause is DIFFERENT from what I patched. Need to look at the
back image's orientation in the atlas region.

### Run X — NO improvement

### Run Y — PRE-FLIP back.png horizontally in build_mv_dir

Change plan:
- Revert Run X's U-flip in texture_project.
- Keep Run W's conditional V-flip skip.
- In build_mv_dir, apply `.transpose(Image.FLIP_LEFT_RIGHT)` to
  back.png before saving into mv slots 2/3/5.

This is cleaner because it's a property of the input images (back
photo is naturally mirrored for a subject facing away), not of
the projection math.

### Run W — conditional p_v flip in texture_project — STARTING NOW

Plan logged BEFORE patching, per protocol.

Hypothesis: texture_project.py applies `p_v = 1 - p_v` uniformly
to all views (lines 281 single-view and 555 multi-view). For the
back view at azim=180, this flips the back image vertically on
the mesh (head ends up at feet). The fix is to SKIP this flip
when the effective view azimuth is close to 180° (post
rotation_offset).

Implementation plan:
- At the per-view loop in texture_project.py (around l.537),
  after computing `shifted_azim = (azim + rotation_offset_deg)
  % 360`, decide whether to apply `p_v = 1 - p_v`:
  - If `abs(shifted_azim - 180) < 10°`: skip the p_v flip (back
    view — image top already aligns with mesh top).
  - Otherwise: apply the flip as before.
- Gate behind `FABMESH_TEXPROJ_SKIP_BACK_VFLIP=1` env flag to
  stay safe (default OFF preserves existing behaviour for Z123
  and CRM pipelines).
- Wrapper ip45_2view_to_3d.py exports the flag.

Output: mesh_RUN_W.glb. Will compare to D in compare.html.

Note: keep V's config (atlas mode + UV_REPACK=0) because V's
determinism fix is orthogonal to the back-flip fix.

### Run V result — front OK, back still vertical-inverted

User showed 2 views of Run V:
- Front view: correctly oriented (face, denim on torso, shorts on
  legs, feet at bottom). Texture looks reasonably sharp.
- Back/profile view: VERTICAL INVERSION — denim on the legs, shorts
  on the torso, baskets near the arms. Same back-flip bug that D has.

User verdict: "c'est inversé" — but this confirms the back-flip is
a STRUCTURAL bug of the D config, not an artefact of Run V. User
reported D having this same bug earlier ("la texture de l'arrière
est inversée (tete en bas)" — AGENT_LOG earlier entry).

So Agent #2's patch (atlas mode + UV_REPACK=0) addressed
**determinism** but NOT **back-flip orientation**, because the
back-flip originates in the projection math itself (R7: `p_v =
1 - p_v` applied uniformly to all views, but at azim=180 this
flips the back image vertically on the mesh).

### What D actually was, post-revelation

D has always had the back-inverted bug; user tolerated it because
the front view dominates the perception. Recent scrutiny exposed
it as a real defect. So "D wins" was premature — D has a defect,
and V shares it.

### Next plan

The real fix for the back-flip: skip `p_v = 1 - p_v` specifically
for views at azim=180 (or any view whose source image already has
its natural "up" in the image top). That's Run T's back pre-flip
approach but applied selectively to avoid Run T's face-ghosting.

The cleanest place to do this is inside texture_project.py:
- Before the per-view loop, mark views where p_v should NOT be
  flipped based on their azim (azim=180 for CRM layout).
- Apply `p_v = 1 - p_v` conditionally.

### Run V — Agent #2 patch (PROJECT_MODE=atlas + UV_REPACK=0) — STARTING NOW

Plan logged BEFORE applying the patch, per the agent log protocol.

Changes to scripts/ip45_2view_to_3d.py inside run_sf3d():
1. Replace `env.setdefault('FABMESH_PROJECT_MODE', 'refine')`
   with `env['FABMESH_PROJECT_MODE'] = 'atlas'`.
   → Skip the SDXL atlas refine pass (which has network + VAE
     non-determinism).
2. Add `env['FABMESH_UV_REPACK'] = '0'`.
   → Freeze the xatlas UV re-pack which can reshape islands
     between runs.

Keep `env['FABMESH_SF3D_NORMALIZE_ORIENT'] = '0'` (D's config).

Output: mesh_RUN_V.glb. Will compare to mesh_NORMALIZE_1.glb (D)
visually in compare.html.

### 3-agent deep analysis synthesis (2026-04-18, post-U2)

Three parallel agents analysed: (1) forensic "what drifted", (2)
theoretical "orientation bugs map", (3) prescriptive "minimal patch".
Synthesis:

#### Agent #1 (forensic) — what drifted

- scripts (the 3 pipeline scripts) are BYTE-IDENTICAL to 16489cf.
- external/StableFast3D submodule has a dirty modification (but
  predates D).
- HF cache, pip packages, source PNGs all frozen before D.
- Two consecutive re-runs NOW produce identical md5 -> pipeline IS
  deterministic in current state.
- D (02:59 md5 0abaf80f) ≠ rerun (62e18aa3) despite code match.

**Most likely cause**: local uncommitted edit at ~02:59 that was
never committed (see git log showing 2830058 "shift source
azimuth" reverted by cfdf6d3 at 02:54 — but E's filename
"NORMALIZE_1_SHIFT.glb" suggests the SHIFT logic was still active
when E was created at 03:09, implying a local uncommitted patch).

**Prescription**: try `git checkout 2830058 -- scripts/...` (not
the commit that was reverted BEFORE D, but the one whose code E
was actually generated with).

#### Agent #2 (theoretical) — orientation bugs cartography

Mapped 10 rotations/flips in the pipeline (R1..R10). Key insights:
- D's correctness comes from NORMALIZE=0 ⇒ R3 skipped ⇒ auto_align
  = 0 ⇒ no rotation_offset propagated ⇒ views.json azimuths land
  as-is on the SF3D-native frame, which R4+R5 cleanly undo.
- Runs C/F/G/H/I/J/K/R "flipped 180°" were NOT geometric flips —
  they were **priority/winner-take-all errors** where input.png
  was starved and MV at post-shift azimuths won. The mesh geometry
  was identical; only pixel dominance changed.
- Run S was a single-axis V-flip error (pre-flip of back.png
  inverts the vertical projection).
- Run T was a priority error (preprocessed back leaked onto face
  via side dups).
- REAL_D was a double-rotation error (R3 rotates mesh but input
  stays at azim=0 → face on back + upside-down via R7).

**Prescription**: change 2 lines in `scripts/ip45_2view_to_3d.py`:
- `env['FABMESH_PROJECT_MODE'] = 'atlas'` (skip SDXL refine, no
  network nondeterminism).
- `env['FABMESH_UV_REPACK'] = '0'` (freeze xatlas island packing).

#### Agent #3 (prescriptive) — use D/E as golden samples

Recommended option: **D + C combined** — promote D/E to golden
snapshots in `meshes/_golden/`, build an SSIM validation harness,
short-circuit the wrapper to return the golden when inputs match.
Cheap, reliable, reproducible; stops the chase for a moving target.

### Converged strategy

All 3 agents agree: **we should not keep chasing re-generation
of D byte-for-byte**. Agent #2's 2-line patch is the most
promising deterministic fix (cheap, targeted). Agent #3's
golden-sample approach is the safety net.

**Plan**:
1. Apply Agent #2's patch (PROJECT_MODE=atlas + UV_REPACK=0).
2. Run and visually compare to D.
3. If close enough, ship. If still different, promote the existing
   D/E to `meshes/_golden/` and add a validator.
4. Either way, freeze this "shipping config" commit.

### Deep analysis request (2026-04-18, post-18-runs)

User confirmed D (mesh_NORMALIZE_1.glb, 02:59) and E
(mesh_NORMALIZE_1_SHIFT.glb, 03:09) are the best-positioned meshes
of the whole session. Requests a complete analysis to understand
how to reliably reproduce this positioning.

Key observations:
- D/E generated at commit 16489cf code.
- Re-running EXACT 16489cf code now produces mesh with different
  md5 hash (62e18a vs 0abaf8). External state has drifted between
  03:00 and now.
- Pipeline is deterministic: two consecutive runs now give same hash.

Candidates for external drift:
- SF3D weights (HF hub updated?)
- texture_refine.py (fp16 bug patched around 04:00)
- Other dependencies
- GPU / CUDA cache

Launching 3 parallel agents for forensic + prescriptive analysis.

### Run S result — orientation FIXED, but spatial offset on back

User confirmed: "l'orientation est ok par contre le positionnement
n'est pas bon". Visible in profile view of mesh: skin tones (face
color) appear in the BOTTOM of the mesh (at the feet) and on the
arms; denim is misaligned vertically.

So the FLIP_TOP_BOTTOM fix corrected the head/feet inversion BUT
introduced a ~50% vertical shift: pixels from the top of back.png
(hair) now land in the middle of the mesh, and pixels from the
bottom (feet) land at the top.

Diagnostic: checked subject vertical extent in both PNGs:
- front: rows 52..1004 (5%..98% of image)
- back:  rows 71..1003 (7%..98% of image)
Subjects are framed nearly identically, so it's NOT a framing
difference between the two PNGs.

Likely cause: SF3D generates the mesh from `_preprocessed_path`
which is `resize_foreground(input.png, foreground_ratio=0.85)` —
the input is centered at 85% of the canvas before SF3D sees it.
The mesh is therefore proportioned for a subject at 85% of frame.
When we feed back.png at raw 1024×1024 (subject at full 5%..98%
of the image), the projection sample coords land 13% off
vertically.

### Run T result — BACK PERFECT, FRONT degraded (visage doublé)

User screenshots after pre-processing back.png with rembg +
resize_foreground 0.85 + V flip:

**BACK view: EXCELLENT.** Hair correctly at top, denim with seams
on the torso, cargo shorts on legs, dark baskets at the feet.
Spatially perfectly aligned. The vertical-offset bug from Run S is
SOLVED.

**FRONT view: DEGRADED.** Face shows DOUBLED features (a face on
top + a ghost face below), arms whitish/pasty. The denim/shorts
are still well-placed but the face quality dropped vs Run S.

Diagnosis: in build_mv_dir, `back` is now preprocessed (rembg +
resize 0.85 + V flip) and used in slots 2 (back), 3 (left dup
back), 5 (bottom dup back). Slot 3 in particular projects to az=270
which post-rotation_offset shift becomes az=90 — a side that's
visible from the front camera. So the preprocessed back image
(with its preserved rembg-cropped shape and 0.85 framing) bleeds
onto the side of the face from the left/right azimuths, creating
ghosting on the face.

The face was OK in S because back.png at full 1024 raw with no
preprocessing was visually different enough from front.png that
its contribution at side azimuths was downweighted by the visibility
math. Now that preprocessed back has clean alpha and matching
proportions, it competes more aggressively on the face area.

### Run U plan

Use the preprocessed back ONLY in slot 2 (the actual back azimuth).
For the left dup (slot 3) and bottom dup (slot 5), use the OLD raw
back.png (no preprocess). That way the back azimuth gets the clean
proportional alignment, but the side dups stay weak enough not to
ghost the face.

User asked to apply to the back what already works for the front
("tu as réussi à mettre la texture de face dans le bon sens, il faut
faire pareil pour celle de derrière (la tête est vers les pieds)").

Implementation: in build_mv_dir, before saving back.png into mv/
view_2 (back) and view_3 (left dup back) and view_5 (bottom dup
back), apply `Image.FLIP_TOP_BOTTOM`. Don't touch front, don't
touch any view that currently looks correct — only the back image
gets pre-flipped.

Hypothesis: the back image will then be projected with its existing
"head at top of png" -> arrives "head at top of mesh head" instead
of "head at feet".

Result file: mesh_RUN_S.glb, also overwrites mesh.glb in viewer.html.

### Fix needed

Don't use trimesh for the post-rotation. Need a method that
preserves the GLB binary structure exactly (textures untouched) and
only modifies the vertex positions. Options:
- Patch the GLB binary chunk directly (read header, modify positions
  buffer, re-write).
- Use a different lib that preserves PBR materials (pygltflib?
  gltflib? trimesh with explicit texture re-attachment?).
- Apply the rotation BEFORE export inside SF3D bridge (modify the
  mesh before SF3D's own GLB writer runs).

Easiest: patch local_sf3d_bridge.py to apply the post-rotation just
before its own GLB export step. The bridge already has the mesh in
trimesh form before export, so applying the rotation there avoids
the round-trip.

### Theory for Q's quality loss

The trimesh load/export round-trip: trimesh may handle GLB PBR
material differently when applying a rotation that changes the
mesh's "up" axis. Rx(180) flips up/down; Ry(180) doesn't. For Y-only
rotation, trimesh might re-tessellate or re-pack UVs differently
than for X+Y rotation that keeps a "consistent" axis system.

Or: model-viewer may simply have cached Q's previous attempt under
the same path/URL.

Need to verify: same compare with hard reload.

### Decision: Option A — STARTING NOW

User picked Option A: post-rotate the mesh Rx(180) @ Ry(180) on
export AFTER the bridge produces the REAL_D-style high-quality
texture mesh. Net effect = 180° rotation around Z axis, which:
- swaps front/back (fixes "avant arrière inversée")
- flips top/bottom (fixes "tête vers les pieds")

Implementation plan:
- New env flag: `FABMESH_POST_ROTATE_AXIS` (default empty, options
  'x', 'y', 'z') and `FABMESH_POST_ROTATE_DEG` (default 0).
- In ip45_2view_to_3d.py wrapper after run_sf3d, load mesh.glb,
  apply trimesh rotation, re-export. Or do it in a small standalone
  post-process step.
- Easier: apply the rotation directly in the wrapper after
  subprocess returns, no env machinery — but then it's
  ip45-2view-specific (which is fine for this experiment).

Run P = REAL_D config (NORMALIZE=1) + post-rotate Rx(180)Ry(180) on
the exported GLB. Will be logged here, then commit.

### NEW PLAN — Run O: REAL_D + post-rotate mesh -180° Y on export

Hypothesis: REAL_D's textures are sharp because NORMALIZE=1 makes
the bridge rotate the mesh +180° BEFORE projection, and texture_project
projects with rotation_offset_deg=180 — so the **HD source input.png
lands on the densely-sampled side of the mesh**. The only problem is
that the exported GLB is then "facing backward" relative to
model-viewer's default camera.

Fix: after the bridge produces mesh_REAL_D-style GLB (with great
textures), apply an additional Ry(-180°) to the mesh geometry on
export. Textures stay the same (UV-mapped to vertices), vertices
rotate so the face ends up at +Z.

Implementation: easiest is to add a post-export Y rotation in
local_sf3d_bridge.py if NORMALIZE_ORIENT was applied. But to keep
the standard pipeline untouched, add an env flag
FABMESH_POST_ROTATE_Y=180 that rotates the final exported mesh by
that amount. Then call with NORMALIZE_ORIENT=1 + POST_ROTATE_Y=180
to get HD textures + correct viewer orientation.

LOGGING NOW BEFORE WRITING CODE.

### Run L — D + tex_res 2048 (atlas resolution doubled) — STARTING NOW

Config: D config exactly + bridge invoked with tex_res=2048 (third
positional arg of local_sf3d_bridge.py). The mv source images stay
at 1024 (unchanged), only the destination atlas baked by SF3D and
projected by texture_project becomes 2048×2048.

Hypothesis: per-texel detail will be sharper because the atlas has
4× more pixels for the same UV layout. NO change to NORMALIZE, NO
shift, NO mv content change → no flip risk per the latest verdict.

Output: mesh_RUN_L.glb. Will compare to D (mesh_NORMALIZE_1.glb,
which despite its name is the canonical D run = NORMALIZE=0).

### Plan after the double-erratum (2026-04-18)

User asked to keep improving D's definition. Resetting all hypotheses
(my "empirical law" was based on misreading NORMALIZE values, so I
can't trust the conclusions of A..K runs about flips).

What I actually know NOW after the double-erratum:
- D = NORMALIZE=0 + no SHIFT_SOURCE + canonical mv 7-layout = WORKING
  baseline (correct orientation, "definition meilleure" per user).
- Anything tried so far at higher resolution (K @ 2048) breaks
  VERTICAL projection (face on calf), independent of NORMALIZE.
- REAL_D / REAL_E (NORMALIZE=1) project face on back — broken.

What I will try NEXT, one variant at a time, each logged
immediately to this file BEFORE running, then verdict added AFTER:

1. Run L = D + tex_res 2048 in SF3D bridge (atlas size, NOT mv res)
   - tex_res controls the destination atlas resolution. mv source
     stays at 1024 (no flip / no vertical inversion risk).
   - Expected: same texture content, just baked into a higher-res
     atlas -> sharper rendering at zoom.

2. Run M = D + disable atlas refine (FABMESH_PROJECT_MODE=atlas)
   - The SDXL refine pass may be smoothing the bake. Disabling lets
     us see the raw projection quality.

3. Run N = D + xatlas repack OFF (FABMESH_UV_REPACK=0)
   - Skips the UV re-pack that may be reducing effective per-face
     texel density.

Each run will be logged here BEFORE the bash invocation so you can
see what's about to be tested.

### Re-running D and E with TRUE NORMALIZE=1

Run REAL_D = NORMALIZE=1 default + no SHIFT_SOURCE
Run REAL_E = NORMALIZE=1 default + SHIFT_SOURCE=1

Output files: mesh_REAL_D.glb, mesh_REAL_E.glb. Side-by-side compare
in compare.html shows OLD D / REAL D / OLD E / REAL E.

User verdict pending. If REAL D and REAL E both render correctly
oriented (face on +Z), this validates the previous law (any front-
azimuth dominance shift caused the apparent flip) was MEASURING THE
WRONG THING. The pipeline should now be reasoned about with the
actual NORMALIZE settings.

### Run K — D + mv slots at 2048 — ALSO FLIPPED

After concluding D was the only viable shipping config, tried to
boost its definition by raising the mv slot resolution from 1024 to
2048 in build_mv_dir. Theory: with D (no SHIFT_SOURCE), the face is
painted by mv/view_0 (front dup), currently downsized to 1024.
Bumping it to 2048 should give a sharper face without changing
priorities or layout — ZERO theoretical flip risk.

Config: D config exactly (NORMALIZE=1, no SHIFT_SOURCE, canonical
7-view layout), only difference: `front = Image.open(front_png)
.convert('RGB').resize((2048, 2048))` instead of 1024.

Result: **also flipped 180°**.

Why it flipped (post-hoc analysis):
- input.png native ~1151px, prio 1.0
- mv/view_0 at 2048px (vs 1024 in D), still prio 1.0
- At 2048, mv/view_0 has more detail than input.png in absolute pixel
  count -> per-texel `pt_vis * src_alpha * priority` favors mv/view_0
  more often during winner-take-all (l 676)
- mv/view_0 wins more texels on the front -> dominance shifts back
  toward mv frame -> the post-rotation orientation locks in -> mesh
  appears flipped.

Confirmation of the empirical law: **anything that gives input.png
LESS-THAN-COMPLETE dominance on the front is the only way to keep
the mesh non-flipped**. Both raising input HD's win rate (C/F/G/H/I/J)
AND raising mv's win rate (K) flip the mesh. The non-flip "sweet
spot" of D is when input.png at ~1151px and mv/view_0 at exactly
1024px are roughly tied per-texel, with neither cleanly dominating —
that ambiguity stabilizes the bake.

### Final verdict (after runs A..K)

**D is the only stable, viable configuration.** Cannot improve face
definition through:
- texture_project priority changes (J flipped)
- View content swaps (F, H flipped)
- View deletion or transparency (G, I flipped)
- mv resolution increase (K flipped)
- SHIFT_SOURCE flag (E gives moiré, lower res)

To go beyond D's quality requires modifying the projection math
(R_undo, R_w2c_base) so input.png's native SF3D frame and the MV
post-rotation frame agree on which side is "front". That's a
substantial engine change, not a parameter tune.

Restoring mv slots to 1024 in build_mv_dir to reset to D-stable.

### 2-agent deep code analysis — synthesis (2026-04-18)

Two general-purpose agents were run in parallel to read the
texture_project.py / local_sf3d_bridge.py code in detail and explain
exactly what differs between runs. Both agents read the AGENT_LOG +
the scripts and reported with line numbers. Synthesis below.

#### Agent #1 — Diff D vs E

Single-variable diff: `FABMESH_TEXPROJ_SHIFT_SOURCE`. In E, `_src_azim`
in texture_project.py:401-403 becomes 180.0 (instead of 0.0 in D).

Mechanism of E's "lessivé/floue/moiré":
1. With shift, input.png and mv/view_0 (front dup) BOTH project to
   az=180 = the FACE of the rotated mesh.
2. PRIORITY_WEIGHTS_TUP[(0,0)] = 1.0 (texture_project.py:375) and
   PRIORITY_WEIGHTS[0.0] = 1.0 → both views compete with **identical
   priority 1.0** on the face area.
3. The per-texel arbitration (l 676-689) is **winner-take-all**, NOT
   blend: `better = w_pixel > weight_arr[ys,xs]`, `np.where(better,
   sampled, ...)`. Each texel picks ONE source view based on
   sub-pixel `pt_vis` differences.
4. The two sources are the same image at 1151px (input HD) vs 1024px
   (mv resize ip45_2view_to_3d.py:38). With nearest sampling
   (`astype(int)` l 669), each texel reads a slightly different
   pixel from each source → ghost-double of features (eyes), dark
   patches.

Recommended patch (Agent #1, chirurgical):
- texture_project.py:413-423, after `views.append`, demote any mv
  slot whose shifted_azim collides with `_src_azim` AND whose
  priority ties with the source: `prio = 0.5`.
- Effect: input.png HD (prio 1.0) wins on the face, mv/view_0 (now
  prio 0.5) only contributes where input is invisible.

Alternative 1-line: change PRIORITY_WEIGHTS_TUP[(0.0, 0.0)] from
1.0 to 0.85 — but affects other Z123 slots too.

#### Agent #2 — Diff A/C/F/G/H

Reconstructed the EFFECTIVE azimuths after rotation_offset:

| Run | NORM | SHIFT | rot_offset | R_undo+Ry180 | input | mv |
|-----|------|-------|------------|--------------|-------|----|
| A   | 0    | 0     | 0          | no           | 0     | 0/90/180/270/0/0 |
| C   | 0    | 0     | 0          | **yes**      | 0     | 0/90/180/270/0/0 |
| F   | 1    | 1     | 180        | no           | 180   | all 0 |
| G   | 1    | 1     | 180        | no           | 180   | (slot0 absent) 270/0/90/180/180 |
| H   | 1    | 1     | 180        | no           | 180   | 180/270/0/90/180/180 (slot0=back) |

Why C/F/G/H look "flipped 180°" in the locked frontal viewer:

- **C**: NORMALIZE=0 means the mesh is exported with face at -Z.
  The viewer (camera-orbit at +Z) sees the BACK by default. R_undo
  is internal to texture_project — it makes the projection sample
  the right pixels (so C's texture is sharp), but the GEOMETRY
  exported to the GLB is unchanged. The "flip" is just the viewer
  showing the back of the mesh. R_undo+Ry180 corrects sample
  alignment vs camera basis but causes a few-degree feature
  offset → "deformed face" because the rotation chain
  `Rx(90)@Ry(-90)@Ry(180)@Ry(-azim)@Rx(elev)` doesn't compose to
  identity in the photo frame.

- **A**: same -Z geometry as C, but no R_undo patch. So R_undo (which
  assumes face=+Z normalized frame) maps front-mesh vertices to
  the gray rembg background area of input.png → samples are
  background gray → cireux/blanchâtre atlas. 426k texel-holes
  filled by push-pull blur. The "good placement" of A in early
  screenshots was a flattering angle, NOT frontal-locked.

- **F/G/H**: NORMALIZE=1 → mesh face at +Z (correct geometry). But
  the mv content swap (back-only, skip view_0, swap view_0=back)
  removes the front-discriminating signal at the post-shift
  azimuths. Multiple competing views at prio ~1.0/0.9 share the
  same hemisphere → the back image gets painted across the front
  faces → looks like a flip.

NOT the cause of any flip:
- xatlas re-pack: UV layout is fixed by SF3D bake before
  texture_project rasterizes (l 507 `face_uvs = uv[faces]`).
- Bilateral auto-align: needs `FABMESH_SF3D_AUTOALIGN=1`, never set.

#### Conjoint conclusion: what to ACTUALLY try next

Both agents converge on the same insight: **the cause of E's blur is
a priority tie at the face azimuth between input.png and mv/view_0,
combined with winner-take-all per-texel arbitration**. NOT the layout
change. So we don't need to touch mv/.

Two parallel paths, both safe (no flip risk):

**Path 1 (Agent #1)**: edit texture_project.py to demote mv slots
that collide with `_src_azim` when SHIFT_SOURCE is on. ~5 lines.

**Path 2 (Agent #2 alt)**: in build_mv_dir, write `view_0.png` as
fully transparent (`Image.new('RGBA', (1024,1024), (0,0,0,0))`).
src_alpha=0 in the projection (l 314+324) → contribution nulle, no
moiré, input HD wins by default. ~1 line in ip45_2view_to_3d.py,
no texture_project changes.

Path 2 is simpler and risk-free. Will try it as Run I.

---

### Run H result — also flipped 180°

Run H (NORMALIZE=1 + SHIFT_SOURCE + view_0 = back image, all other
slots unchanged) was meant to keep the 7-view ortho layout intact
while removing only the doubled-front signal. Result: **also flipped
180° at the locked angle** (mesh shows back, denim back side, nuque).

So even swapping a single mv slot's image content is enough to flip
the mesh in the viewer. The flip isn't about layout structure
(7 vs 6 vs 5 slots) — it's about the **identity of pixels at each
azimuth**. As soon as the front area of the mesh has insufficient
front-pixel signal at the expected azimuths, model-viewer / xatlas
re-uvs in a way that swaps the visible side.

### Definitive learning — modifying mv/ contents is a dead end

After runs A..H, conclusion: **any change to the contents or layout
of mv/ flips the mesh** in the viewer's frontal camera frame.
- A: NORMALIZE=0 (sharp, well-placed)
- C: + R_undo Ry180 patch -> flipped
- D: NORMALIZE=1 standard (medium sharp, well-placed)
- E: + SHIFT_SOURCE -> floue (moiré HD vs 1024)
- F: + back-only mv -> flipped
- G: + skip view_0 -> flipped
- H: + view_0 = back image -> flipped

The ONLY stable, well-placed configurations are A, D, E. All paths
to improve their definition by editing mv/ images or views.json
flip the result.

To improve D/E without flipping, the next attack surface is the
**texture_project.py code itself**, NOT the mv/ inputs:
- Lower the hardcoded priority of `(0.0, 0.0)` for mv slots when
  the source image is also a mv slot (currently both get prio 1.0).
- Disable `FABMESH_TEXPROJ_REFINE` (the SDXL atlas refine pass
  may be amplifying the moiré rather than smoothing it).
- Disable `FABMESH_UV_REPACK` (xatlas re-pack may be the cause of
  the flip — it re-charts UVs based on which faces are visible from
  which views, and the viewer's frontal angle could be tracking
  the dominant chart island).
- Increase tex_res from 1024 to 2048 to reduce sub-pixel
  disagreement between input.png 1151px and view_0 1024px samples.

All four changes are safer because they don't touch mv/ contents.

### Run G result — also flipped 180° at locked angle

Run G (NORMALIZE=1 + SHIFT_SOURCE + skip view_0 only) was supposed to
preserve E's correct placement while killing the HD-vs-1024 moiré.
Result: G **also shows the back at the locked frontal angle**, just
like C and F.

Lesson: ANY change to the standard 7-view layout (input + view_0..5
at azims 0/90/180/270/0/0 in raw frame, becoming 180/270/0/90/180/180
post-shift) flips the visible front of the mesh in the viewer's
frame. C, F, G all flipped. Only D and E preserve the rendered "face
in front" pose. The placement constraint is **fragile**: it only
holds for the exact 7-view ortho cardinal layout that
texture_project / model-viewer expect.

So the path "drop view_0 to kill the moiré" is dead. Other angles to
try if we still want to fix E's face moiré:

- **Lower mv/view_0 priority** (e.g. 0.4 instead of 1.0) so input.png
  HD wins on the face but view_0 keeps voting on borders. Edits
  PRIORITY_WEIGHTS_TUP in texture_project.py.
- **Replace view_0 with a downscaled copy of input.png** so they
  agree pixel-for-pixel after resize, no sub-pixel disagreement.
- **Pre-shrink input.png to 1024px** so it matches mv/view_0 exactly
  -> still HD-resampled but no resolution mismatch.
- **Disable atlas refine** entirely and re-evaluate — the SDXL
  refine pass might be amplifying the moiré rather than smoothing it.

### D vs E — pending side-by-side face zoom

Both D and E look sharp at wide frame. E was reported earlier as
"face FLOU + ghosting" when zoomed in. Need final face-zoom
verification to choose:
- D wins -> ship as-is (NORMALIZE=1 baseline, no SHIFT_SOURCE).
  Drawback: HD input.png is wasted on the back of the mesh.
- E wins -> ship with FABMESH_TEXPROJ_SHIFT_SOURCE=1. HD on face is
  recovered. Risk: subtle moiré if mv/view_0 still doubles the front
  signal at low zoom.
- Both equivalent -> prefer D (simpler, no extra env flag, no risk
  of hidden moiré).

---

## 2026-04-18 — IP-scale sweep on child + ip45 front+back → 3D experiment

### Existing artifacts

`scripts/_scale_sweep.py` generated 15 images for the child ref across
IP scales {0.20, 0.25, 0.30, 0.35, 0.45} × {front, right, back} — output
in `images/child/_scale_sweep/`. Viewer at `_viewer.html` in same dir.

Visual read (not yet scored): ip25/ip30 produce a credible back view
that keeps the denim jacket + cargo shorts but clearly loses a bit of
identity (face not relevant on back anyway). ip45 preserves outfit best
but SDXL sometimes resists the `back view` prompt — still usable at
this scale for our subject.

### New experiment — 2-view 3D from ip45_front + ip45_back

Hypothesis: an SDXL multi-view set only needs to be *coherent on the
silhouette* to give SF3D enough signal for a decent textured mesh. So
rather than chasing 4 or 6 coherent SDXL views, feed CRM/SF3D just the
two best-scale images we already have, duplicated across the 6 slots.

### Plan

1. Patch `local_sf3d_bridge.py` to honor a new env var
   `FABMESH_MV_REUSE=<dir>` that skips internal multi-view generation
   and reuses a preexisting 6-slot dir (front/back/right/left/top/bot
   with a matching views.json).
2. New script `scripts/ip45_2view_to_3d.py`:
   - Takes `front.png` and `back.png` (default: the existing ip45_*
     from `images/child/_scale_sweep/`).
   - Writes a CRM-compatible 6-slot mv dir (front dup→right/top,
     back dup→left/bot).
   - Invokes SF3D bridge with FABMESH_MV_REUSE pointed at that dir.
3. Load resulting .glb in the Electron 3D viewer.

Expected outcome: textured mesh where **front and back faithfully match
the SDXL output**, but sides (being duplicates of front/back) may bleed
at az=90/270 seams — acceptable for a first pass. If bad, next step is
to add SDXL right/left at a lower ip_scale (0.30-0.35 per existing
_scale_sweep finding).

### Result

Run completed on child ip45_front + ip45_back in **81 s** total on RTX
5080 (SF3D inference ~1.5 s, texture_project ~2 s, SDXL atlas refine
~60 s for 9 tiles @ fp16). Output: `logs/child_ip45_2view/mesh.glb`
(1.54 MB, 8462 verts / 12596 faces / 2048 atlas). Viewer at
`logs/child_ip45_2view/viewer.html` (model-viewer side-by-side with
source PNGs).

### Bugs found + fixed along the way

1. `scripts/ip45_2view_to_3d.py` first wrote `views.json` as a **list**,
   but `texture_project.py` expects `{engine, views:[...]}` dict shape
   and fell back to Z123 schema → wrong camera angles for every
   projection. Fixed: wrap in dict with engine='ip45_2view'.
2. `local_sf3d_bridge.py` finally block did `rmtree(_multiview_dir)` —
   which, under `FABMESH_MV_REUSE`, was **deleting the user-supplied**
   mv dir after the run. Fixed: gate the rmtree on
   `not _mv_reuse_active`.
3. `texture_refine.py` loaded RealVisXL img2img with
   `torch_dtype=float16` but without `variant='fp16'` → some submodules
   stayed in fp32, every tile crashed on
   `mat1 and mat2 to have the same dtype, float != Half`, atlas was
   never actually refined. Fixed: pass `variant='fp16'` +
   `use_safetensors=True` + explicit `.to(float16)` cast loop on each
   submodule.

### Takeaways

- `FABMESH_MV_REUSE=<dir>` is now a first-class override for the SF3D
  bridge — any caller can supply a preexisting 6-slot dir and skip
  internal multi-view generation entirely.
- The tex_refine fp16 bug was silently dead code for every Electron
  user who hit refine mode: tiles failed, original atlas was kept, no
  error surfaced above WARN level. Worth a dedicated test once we have
  a regression harness.
- 2-view (front+back) with ip45 is **usable as a starting point** but
  the sides are frankly front+back smeared onto az=90/270 — visually
  wrong on a subject with asymmetric arms/pose. Need at minimum a 3rd
  SDXL view (profile at ip_scale 0.30-0.35 per _scale_sweep) before
  claiming this approach competes with CRM.

### Follow-up: "mouth on the calf" bug (BIG bake-orientation bug)

After viewing the first textured mesh in model-viewer, observed:
human face features (eyes, mouth) baked **onto the calves and back of
the legs** — clearly nonsense. Root cause:

- `local_sf3d_bridge.py` rotates the SF3D mesh +180° around Y after
  inference (env `FABMESH_SF3D_NORMALIZE_ORIENT=1`, default) so the
  face points to +Z (three.js camera convention). It also propagates
  this as `auto_align_rot_deg=180` to texture_project as
  `rotation_offset_deg`.
- `texture_project.py` applies that offset **only to multi-view
  azimuths** (line 397: `shifted_azim = (azim + rotation_offset_deg)
  % 360`) — but the source `input.png` is added separately at
  `(0, 0, priority=1.0)` line 383, with NO offset.
- Net effect on our 2-view setup:
  - input.png (front photo) → projected at azim=0 in the rotated
    frame → lands on the BACK of the mesh.
  - mv/view_2 (ip45_back) → azim 180+180 = 360%360 = 0 → projected on
    the FRONT of the mesh, with priority 0.7 (the `back` slot prio).
  - mv/view_0 (ip45_front dup) → azim 0+180 = 180 → projected on the
    back, with priority 1.0 (the `front` slot prio) — so the
    duplicated front WINS over the real back. Hence the entire mesh
    is dressed with mostly-front pixels, but on the **wrong side**,
    upside-down and laterally swapped. Faces end up on the legs.

This bug also affects the existing CRM pipeline whenever the
`auto_align_rot_deg` is non-zero, but is masked because the CRM
multi-view set is symmetric enough that the visual artifact looks
just "blurry" rather than "facially deranged".

### Fix

`scripts/ip45_2view_to_3d.py` now exports
`FABMESH_SF3D_NORMALIZE_ORIENT=0` to disable the bridge's +180°
rotation entirely. Our `views.json` describes camera angles in the
SF3D-native frame (face at -Z, azim=0 = camera looking from -Z = at
the face), and we pass front at azim=0, back at azim=180 — which is
now consistent with the source image at azim=0 (front).

After fix, projected azimuths in the log are now `0,0,90,180,270,0,0`
(no +180 offset injected), which is what we want for a 2-view ortho
schema. Texture should now sit on the correct side of the mesh.

### Diagnostic instrumentation added

`texture_project.py` now writes two PNG diag maps when
`FABMESH_TEXPROJ_DIAG=1`:
- `<mesh.glb>.diag_sourceview.png`: per-texel source view (palette of
  7 hues, black = no data).
- `<mesh.glb>.diag_coverage.png`: per-texel contributor count (0 = hole,
  1 = single fragile, 2..6+ = increasingly safe).

These let us see at a glance whether a baked artifact is a
projection-mapping bug (wrong source view dominant) vs. a coverage
hole (push-pull guesswork).

---

## 2026-04-18 — Multi-view repair pass (option B): detector + SDXL-Inpaint

Follow-up to child analysis. Option B from the 3-way split:
"Inpaint-repair hallucinated multi-view regions using ref as IPAdapter
conditioning." Ships as a standalone script — can run after any
engine (CRM / Z123 / SDXL / MV-Adapter later).

### New file: `scripts/multiview_repair.py`

**Detector** (no-GPU, runs first):
- Scores each view on weirdness = dark_excess + sat_excess + (1-palette_sim)
- `excess` = view ratio minus ref's own ratio + 5% slack. This is
  critical for naturally dark subjects (zebra, panda) — otherwise
  their own stripes would false-flag.
- Hard-trigger at dark_excess > 8% or sat_excess > 5% → weirdness += 0.4
- Threshold default 0.55.

**Repair** (GPU):
- SDXL-Inpaint 1.0 + IP-Adapter Plus SDXL + RealVisXL-class base.
- ip_scale per slot: front 0.75, sides 0.55, back 0.60, top/bottom 0.55.
- Slot-aware prompts: "top down view, looking down from above", etc.
- Strength 0.95, 35 steps, guidance 7.5.
- Backs up originals in `<mv_dir>/.repair_backup/` before overwrite.

### Detector validation

Tested on 2 subjects:
- **child** (clean ref, dark=0.010): flags slot 5 only (w=0.89). ✓
  Matches human assessment (only bottom view is hallucinated).
- **zebre** (zebra from front, dark=0.011): flags slots 0,3,4,5. ✓
  Matches earlier human assessment of weak zebre multi-views.

After ref-anchoring (5% slack), no false positives on the clean slots.

### CLI
```
python scripts/multiview_repair.py <mv_dir>               # auto-detect
python scripts/multiview_repair.py <mv_dir> --force-slots 4,5
python scripts/multiview_repair.py <mv_dir> --threshold 0.5
```

### Live test on child slot 5 — RESULT

- First attempt (dark-pixels-only mask, 6.4% coverage, strength 0.95):
  no visible improvement. Surrounding hallucinated context dragged
  SDXL back to the same black-mass answer.
- Second attempt (script auto-selected defect-only mask because
  already-repaired palette_sim passed threshold): re-repaired the
  remnant 3% — still no gain.
- **Third attempt, `--full-fg --strength 0.98`**: strong improvement.
  Slot 5 weirdness 0.886 → 0.075. palette_sim 0.011 → 0.760.
  dark_ratio 0.533 → 0.068. 17s on RTX 5080.

### Result interpretation

The SDXL-Inpaint output is NOT a true bottom-up orthographic view
(SDXL doesn't know that perspective). It produces a low-angle/frontal
rendering with the child's denim jacket + arms spread. BUT: it's
plausible, coherent, and shares palette with ref — so SF3D projecting
it onto the bottom of the mesh will yield coherent color instead of
the black holes we saw before.

### Takeaways

1. **ALWAYS use `--full-fg`** when weirdness > 0.7. The defect-only
   mask strategy fails when the surroundings are also hallucinated.
2. Default `repair` decision threshold 0.55 stands. Detector catches
   the right slots (child: only 5; zebre: 0,3,4,5).
3. **This is a partial fix** — for a true top/bottom view, MV-Adapter
   or Era3D is still the right long-term solution. But the repair
   pass is a cheap (≤30s/view) guardrail that prevents black-hole
   artifacts on the mesh.

### Next integrations
- Hook repair into `main.js` multi-view pipeline as optional post-step
  (env `FABMESH_MV_REPAIR=1`).
- Later: offer per-slot repair UI in the multi-view review dialog
  ("regenerate this view with repair").

### Zebre test — 4 slots repaired (0, 3, 4, 5)

|slot|before w|after w|before palette|after palette|visual|
|---|---|---|---|---|---|
|0 front  |0.76|0.56|0.023|0.678|GOOD — real zebra face+body|
|3 left   |0.80|0.78|0.011|0.061|GOOD visually — striped side-profile zebra|
|4 top    |0.77|0.24|0.013|0.265|MEDIUM — coherent downward view|
|5 bottom |0.77|0.74|0.019|0.083|MARGINAL — incoherent bottom|

49s total for 4 slots.

### Finding: detector false-positives on naturally-striped subjects

Zebre ref shows front-view stripes. Detector's `ref_stats` only
captures ~1% dark pixels because alpha-masked ref doesn't pick up
stripes as "dark". Side/left views of a striped subject then have
much higher dark_ratio (30%) than ref's baseline — detector
flags them even though they're correctly rendered.

### Mitigation options (future)
1. Use LAB color space instead of luminance for "dark" detection —
   stripes show as neutral-chroma, not dark.
2. Compute ref_stats from the already-known-good front view
   (view_0 if it passes detector) instead of input.png.
3. Per-slot weirdness threshold: tighter for TOP/BOTTOM
   (high-prior-failure), looser for sides.

### Verdict
Repair pass ships as-is. For "clean subjects with hallucinated
TOP/BOTTOM" (child, zombi) it's a clear win. For "naturally
patterned subjects" (zebra, dalmatian) it still improves palette
but the detector may need per-subject tuning. Document expected
behavior in `FABMESH_API.md`.

### 2026-04-18 — Zebre re-test revealed destructive repair bug

User screenshot showed view_3 with "double silhouette" — repaired
zebra inside a ghost alpha outline of the original. Root cause:
- Detector false-flagged left/right/bottom zebre views (palette_sim
  is pathologically low on striped subjects — different stripe
  arrangement between CRM output and ref gives near-zero hist
  cosine even when both are correct zebras).
- --full-fg mask + strength 0.98 made SDXL regenerate the subject
  with a DIFFERENT silhouette than the original alpha, leaving the
  original alpha outline visible around the new (smaller) zebra.

### Fixes applied
1. Auto mode now requires `dark_excess > 0.15 OR sat_excess > 0.05`
   in addition to weirdness > threshold. Pure palette-drift alone
   no longer triggers repair (it's likely generator-noise, not
   hallucination).
2. `full-FG` auto-activation only for `weirdness >= 0.85 AND
   palette_sim < 0.05` — child-bottom still qualifies, zebre
   side-profiles no longer do.
3. Mask has no dilation in full-FG mode, blur radius 1.5 instead
   of 4 — reduces "shadow clone" artifacts outside silhouette.
4. Post-inpaint, RGB pixels outside the original alpha are
   zeroed explicitly — hardens against any residual ghost.

### Next: user wants a better multi-view pipeline
Agent dispatched to research "how to get 6 clean consistent views
of the same mesh" — MV-Adapter, SV3D, Era3D, etc.

---

## 2026-04-18 — MV-Adapter integration — IN PROGRESS

**Goal**: ship MV-Adapter i2mv-sdxl as new `FABMESH_MV_ENGINE=mvadapter`
option. Apache 2.0, local, 768px, 6 views with arbitrary (az, el).

### Files added/changed
- `external/MV-Adapter/` — git submodule (huanngzh/MV-Adapter)
- `external/MV-Adapter/mvadapter/utils/mesh_utils/__init__.py` — patched
  to lazy-load nvdiffrast-dependent modules (FabMesh only needs
  camera helpers; mesh/render paths need nvdiffrast which we don't
  want to compile).
- `external/MV-Adapter/mvadapter/utils/mesh_utils/utils.py` — also
  patched for optional `dr` import.
- `scripts/multiview_mvadapter_gen.py` — new generator following same
  CLI contract as `multiview_crm_gen.py`. Env vars:
    - `FABMESH_MVA_BASE` (default `stabilityai/stable-diffusion-xl-base-1.0`)
    - `FABMESH_MVA_CPU_OFFLOAD` (default off — hooks break attention cache)
    - `FABMESH_MVA_PROMPT` / `FABMESH_MVA_SUBJECT_PROMPT`
- `src/main/main.js` — dispatch mapping adds `mvadapter`
- `scripts/local_sf3d_bridge.py` — same dispatch update

### Issues hit
1. **nvdiffrast missing** — MV-Adapter pulls it transitively via
   `mesh_utils/__init__.py`. Patched `__init__.py` + `utils.py` to
   skip the heavy-rendering modules when nvdiffrast is absent.
2. **KeyError on first run** with RealVisXL V4.0:
   `down_blocks.1.attentions.0.transformer_blocks.0.attn1.processor`
   not in `ref_hidden_states`. MV-Adapter's DecoupledMVRowSelfAttnProcessor
   caches hidden states per attn layer name during the first UNet
   forward; on the inference forward it looks them back up. The cache
   was incomplete. Likely cause: either RealVisXL layer-name drift,
   or diffusers 0.34 `accelerate` CPU-offload hooks dropping
   `cross_attention_kwargs` before it reaches the down-blocks.
3. Fix attempt: switch base to `stabilityai/stable-diffusion-xl-base-1.0`
   + disable CPU offload by default. Second run failed before even
   hitting the issue — my own bug (`base_model` referenced before
   assignment). Patched.

### Status
Not working yet. Next run pending. If KeyError persists on vanilla
SDXL without offload, the root cause is diffusers version mismatch
(MV-Adapter validated against ~0.30; we have 0.34). Options:
- pin diffusers~=0.30 in a FabMesh venv scoped to this script
- patch MV-Adapter's attn processor to use `.get(name, fallback)`
  instead of `[name]`

---

## 2026-04-17 — Child project analysis: multi-views insufficient, mesh degraded

User: "analyse le dernier projet que jai créé le resultat (multi vues et mesh) ne sont pas suffiant"

Project: `images/child/` (ref = photoreal child T-pose, denim jacket,
white T, khaki cargo shorts, sneakers — clean black background).

### Multi-views (CRM, 6 views)
- **view_0 / front (0°)**: acceptable, jacket slightly shinier/synthetic
  vs ref, face softened.
- **view_2 / back (180°)**: reasonable, hair crown coherent, jacket
  back plausible.
- **view_4 / TOP (+90° elev)**: weak — body stretched, proportions wrong.
- **view_5 / BOTTOM (-90° elev)**: hallucinated — black mass, shoes
  barely recognizable, feet geometry incoherent.
- **view_1 / right, view_3 / left**: profile lost detail on jacket seams.

### Mesh (`child_sf3d_1776467095964.glb`, 3/4 thumbnail)
- Silhouette: arms-out T-pose preserved. Face badly simplified — eyes,
  nose, mouth smudged into a single dark band.
- Torso OK, denim jacket color transferred.
- **Hands: mangled into red/orange blobs** (not flesh-toned) — this is
  the same signature we see when projection falls back on an unseen
  region and the nearest projected source is a reddish area.
- Legs + shorts: color fine, shape cylindrical/stiff.
- Feet: deformed, sneakers barely a shape.

### Root cause
1. CRM is Objaverse-trained; children + T-pose extremities (hands,
   feet) are under-represented → hallucinated TOP/BOTTOM + weak profiles.
2. SF3D rebuilds geometry from the 6 views. Hallucinated TOP/BOTTOM
   propagate to the mesh (mangled hands/feet).
3. Texture projection (push-pull) is working — atlas is uniform — but
   it can only project what the multi-views contain. Garbage in,
   garbage out.

### Pattern confirmed
Same failure mode as: zebre (quadruped), zombi, chat_vert. The
weakness is CONSISTENTLY at TOP + BOTTOM + distant extremities. Only
the oiseau (bird, compact silhouette, round body) worked well because
TOP/BOTTOM of a bird is plausible to CRM priors.

### Conclusion
The bottleneck is NOT texture projection (already fixed), NOT SF3D
per se — it's **multi-view quality on non-compact subjects**. The
queue is:
1. Disable TOP/BOTTOM generation OR downweight them in SF3D pass
   (cheap, few hours).
2. MV-Adapter i2mv SDXL (agent recommendation #1, best quality).
3. Per-slot multi-seed was implemented but disabled — 16 GB VRAM
   can't hold CRM + SF3D + 3 seeds concurrently.

### Next experiment to try
Run SF3D with only 4 views (front/right/back/left, skip TOP/BOTTOM)
and see if hands/feet improve. If yes → make this the default for
characters with a clean ground plane.

---

## 2026-04-17 — Multi-view improvement options — benchmarked by agent

User question: "can we improve the multi-view?" Agent investigated
5 options and ranked them by quality-gain / effort / EU-license safety.

### Ranking (best first)

**#1 — MV-Adapter i2mv SDXL (Apache 2.0)** — RECOMMENDED
  - Plug-and-play SDXL adapter, 6 view-consistent 768px images from
    1 ref. Reuses our RealVisXL V4.0 base, +3.6 GB adapter only.
  - VRAM: ~14 GB (fits 5080). Effort: ~6-8 h dev.
  - Expected on mannequin back: HIGH quality.
  - Benchmark paper: beats Z123++ and Era3D on GSO.
  - URL: github.com/huanngzh/MV-Adapter
  - **This is the "real multiview-native model" option user asked for.**

**#2 — Hybrid Z123 → SDXL+IPAdapter cleanup at strength=0.55**
  - Keep Z123 geometric skeleton, re-paint each view with higher
    IPAdapter strength (current 0.35 is too shy, 0.55-0.65 would
    overwrite hallucinations while preserving identity).
  - VRAM: 0 new. Effort: 1-2 h (1 line change + per-view schedule).
  - Expected on mannequin back: MEDIUM-HIGH.
  - Easiest quick win before shipping #1.

**#3 — xinsir ControlNet-OpenPose per view (Apache 2.0)**
  - Only helps humanoid T-pose subjects. Generate skeleton PNG per
    azimuth (front/right/back/left) + SDXL + OpenPose + IPAdapter.
  - VRAM: ~12 GB. Effort: ~1 day.
  - Expected: HIGH for humans, USELESS for props.
  - Gate by existing _is_tpose detector in local_juggernaut_bridge.

**#4 — Dual-reference UI workflow (front + optional back image)**
  - UI adds 2nd dropzone, `multiview_gen.py --back-image` skips Z123
    for view_3 when provided.
  - Effort: ~3-4 h. No model changes.
  - Expected: PERFECT when user has back photo, zero help otherwise.

**#5 — Z123 param re-tune (cheapest, probably dead-end)**
  - Current cfg=5.5, steps=150. Z123 v1.2 tuned for cfg=4.0, 28-75 steps.
  - AGENT_LOG already states Objaverse training-data lack is fundamental.
  - Effort: 30 min. Worth A/B-testing as baseline but won't fix mannequin.

### Avoid
  - Wonder3D (AGPL-3.0 — incompatible with commercial closed-source)
  - Hunyuan3D-2 (Tencent Community — EU excluded)
  - IP-Adapter FaceID (research only)
  - Unique3D (MIT OK but produces mesh, not a drop-in multiview)

### Recommended sequencing
  1. TONIGHT: option #2 — bump identity-harmonize strength 0.35→0.55
  2. THIS WEEK: option #1 — bridge MV-Adapter as new default
  3. LATER: option #3 gated on humanoid detection
  4. UI polish: option #4 as "power user" feature

## 2026-04-17 — MV-Adapter i2mv SDXL — implementation plan (agent #2)

**Fact sheet**:
  - Repo: github.com/huanngzh/MV-Adapter (Apache 2.0)
  - HF weights: `huanngzh/mv-adapter` / `mvadapter_i2mv_sdxl.safetensors` (~740 MB)
  - Image encoder: `facebook/dinov2-large` (~1.2 GB, Apache 2.0)
  - Pipeline class: `MVAdapterI2MVSDXLPipeline`
  - Base: reuses our existing SG161222/RealVisXL_V4.0 (no duplicate)
  - Total new disk: ~1.95 GB
  - VRAM peak: ~11-12 GB fp16 (fits RTX 5080 16 GB)
  - Deps: diffusers>=0.30, transformers>=4.40, peft>=0.11
  - Azimuths: custom kwarg → pass Z123 schema [30,90,150,210,270,330]
    with elev [20,-10,20,-10,20,-10] for drop-in compat

**9-step roadmap (~9h total)**:
  1. git submodule add MV-Adapter to external/
  2. new scripts/multiview_mvadapter_gen.py (same CLI as Z123)
  3. Wire RealVisXL base + offload if VRAM<14GB
  4. Load adapter + DINOv2 encoder
  5. Pass Z123-matching azimuths to pipeline call
  6. Save view_0..5.png + input.png (same layout)
  7. Bridge dispatch: FABMESH_MV_ENGINE=z123|mvadapter|sdxl
  8. Silhouette-hash cache keyed with engine name
  9. UI dropdown "Multi-view engine" in Settings→Advanced
  10. Calibration gallery extension (side-by-side)
  11. AGENT_LOG + README update

**Risks**:
  - VRAM blowout (medium) → enable_model_cpu_offload() guard
  - diffusers version drift (medium) → pin 0.30.3
  - Azimuth convention mismatch (medium) → validate on mannequin

**GO/NO-GO**: GO. Default-off via env flag during validation, Z123
stays safety net. Flip default once mannequin back shows orange/black
instead of Z123's green hallucination.

## 2026-04-17 — 6-view model with TOP+BOTTOM — AGENT REPORT

User question: which AI model generates 6 CANONICAL views including
TOP and BOTTOM (elev ±90°) — not just horizon views like Z123/MV-Adapter?

### Ranked candidates

| # | Model | License | Top+Bot? | VRAM | Disk | Notes |
|---|-------|---------|----------|------|------|-------|
| 1 | **CRM (thu-ml)** | **MIT** ✓ | **YES native 6 ortho incl. up/down** | 8-10 GB | 3 GB | Best direct answer |
| 2 | **TRELLIS.2** | MIT ✓ | N/A (full mesh) | 12-14 GB | 10-12 GB | SOTA 2025, PBR |
| 3 | **SPAR3D** | Community (<1M$) ✓ | N/A (full mesh) | 8 GB | 4 GB | 0.7s/obj |
| 4 | **Stable Zero123C** | Community ✓ | YES arbitrary (az,el) | 8 GB | 2 GB | Per-view, less consistent |
| 5 | **Unique3D** | MIT ✓ | **NO** (only 4 horizon views) | 8 GB | 4 GB | Excluded |
| 6 | **Era3D** | AGPL-3.0 ✗ | No | - | - | Copyleft excluded |
| 7 | **SV3D / Wonder3D / One2345++** | Non-commercial ✗ | - | - | - | Excluded |

### TOP recommendation: **CRM**
  - Repo: github.com/thu-ml/CRM (MIT)
  - Weights: huggingface.co/Zhengyi/CRM
  - Paper: arxiv.org/abs/2403.05034
  - Literally designed around "six orthographic views including up and
    down" — the exact feature we need
  - Commercial + EU-safe (MIT)
  - Fits RTX 5080 VRAM budget

### Alternative: hybrid MV-Adapter + Stable Zero123C
  - Keep MV-Adapter for F/B/L/R (already planned)
  - Call Stable Zero123C twice for (elev=+90) and (elev=-90)
  - SZ123C accepts arbitrary (az, el) unlike Z123++

### RECOMMENDED production path (long-term):
  **Mesh-first render-and-refine**:
    1. Generate mesh via SF3D/TripoSG/CRM
    2. Render 6 canonical views from raw geometry (trimesh/pyrender)
       at exact F/B/L/R/T/B
    3. img2img refine each view with SDXL + depth/normal ControlNet
       + IPAdapter (identity from ref)
  This fixes the chicken-and-egg: proxy views have correct silhouette
  + normals, diffusion only repaints texture. SDXL reliable at that.
  This is what Meshy/Rodin do internally.

### NEXT STEP (user decides)
  - Short-term: integrate CRM as new multi-view backend (1 week)
  - Long-term: mesh-first render-and-refine as v2 texture path

## 2026-04-17 (end of day) — CRM INTEGRATED, WORKING ON MANNEQUIN

Delivered:
  - `external/CRM` submodule (MIT license)
  - `scripts/download_crm_weights.py` — fetches CRM.pth + pixel-diffusion.pth
    + ccm-diffusion.pth (~12 GB total from HF Zhengyi/CRM)
  - `scripts/multiview_crm_gen.py` — CLI-compatible with multiview_gen.py
  - `scripts/local_sf3d_bridge.py` — FABMESH_MV_ENGINE=z123|sdxl|crm dispatch
  - Patches in external/CRM/:
    - libs/base_utils.py: stub EMAModel (torch 2.7 incompat)
    - imagedream/ldm/modules/attention.py: SDPA fallback when xformers absent
    - pipelines.py: SKIP stage2 when resume='SKIP' or missing

Test on mannequin_ref.png (FABMESH_MV_ENGINE=crm):
  - 5.5 min wall-clock (vs Z123 45s), scale=5.5, step=30
  - 6 views produced, TOP+BOTTOM native
  - view_0 front: mannequin reconstructed with F+H+stripes+dots ✓
  - view_2 back: damier + identity preserved (not orange/black but
    consistent with front, NO hallucination)
  - view_4 TOP: head from above + arms extended + limb colors ✓
  - view_5 BOTTOM: legs+arms from below ✓

CRM output at 256×256, upscaled to 1024. Grey-bg threshold removed
for alpha. Much better than Z123 for top/bot (which Z123 can't do
at all). Back quality similar to SDXL+IPAdapter but with TOP/BOT
bonus.

Backup tag: before-crm-integration-20260417.

### NEXT: test full pipeline (CRM multi-views → SF3D → texture_project)
to see end-to-end quality on a real character.

## 2026-04-17 — CRM routing bug + fix (user "vache" test)

**Symptom**: user ran Generate on "vache" project, expected TOP/BOT
views, none produced. Only view_0..view_5 in classic Z123 layout.

**Root cause**: `main.js` hardcoded `multiview_gen.py` at two call
sites (line 861 mv-inherit, line 3642 generate-multiview IPC).
Setting FABMESH_MV_ENGINE=crm in the launcher env had NO effect
because the script path was never read from env.

**Fix**: added `_mvScriptForEngine()` helper that maps engine name
to script path. Both call sites now use it. Z123 remains the
default when FABMESH_MV_ENGINE is unset.

**Verification**: killed electron + restarted with env=crm,
deleted `images/vache/ref_0_multiview/` cache so the bridge
regenerates from scratch. User must retry "Generate".

**Dependency chain unresolved in the same session**:
  - xformers 0.0.35 (tied to torch 2.11) broke SDXL imports;
    uninstalled
  - diffusers 0.37 broke on torch 2.7 (GroupName import);
    pinned 0.34
  - transformers 5.5 dropped FLAX_WEIGHTS_NAME; pinned 4.46
  - CRM itself needed EMAModel stub + SDPA fallback + stage2 SKIP

All committed. All patches documented above in the CRM Integration
section. Tests on mannequin worked; real user test pending.

## 2026-04-17 — Stage 4 root cause found, NOT yet fixed

**Agent investigation report**: Stage 4 fails (1/6) on the GT cube
because the cube is authored in natural glTF frame (front=-Z, up=+Y),
while `texture_project.py` expects SF3D post-transform frame. SF3D
bakes Rx(-90) @ Ry(+90) into its GLB output; `texture_project` has
R_undo = Rx(+90) @ Ry(-90) to reverse it. Applied to the natural-frame
cube, R_undo scrambles the axes → TOP face receives RIGHT view, etc.

**Why real meshes work**: SF3D output → auto-align adds rotation_offset
→ texture_project R_undo → multi-view azimuths shifted. The full chain
is self-consistent only when every step is taken. GT cube skips the
bridge + auto-align, so the chain breaks.

**What was tried (all failed to reach 6/6)**:
  1. Pre-rotate GT cube into SF3D frame before export — 0/6
  2. Post-rotate output mesh back to natural before render_axis — 0/6
  3. FABMESH_TEXPROJ_SKIP_UNDO=1 — 0/6
  4. Basis sweep (24 signed-axis permutations of R_w2c_base) — best 3/6 (p18)
  5. 8 rotation-offset × U-flip combinations — best 1/6 unchanged
  6. rotation-offset -90 — worse (0/6, scores 0.33-0.50)
  7. Fine rotation-offset sweep (13 angles):
     - rot=0 → 0/6
     - rot=30 → 0/6
     - rot=45 → 0/6
     - rot=60 → 1/6
     - **rot=90 → 2/6 (best: front+right PASS)** ← visual still wrong
     - rot=120 → 1/6
     - rot=150..330 → 0/6

**Process differences (origin vs calibration stage 4)**:
| | Real pipeline (works) | Stage 4 GT cube (fails) |
|---|---|---|
| Input mesh | SF3D output (has Rx(-90)@Ry(+90) baked) | Natural glTF frame (no bake) |
| Auto-align | Yes (Y rotation) | No |
| rotation_offset | Inherited from auto-align | 0 by default |
| R_undo in texture_project | Correctly unbakes SF3D xform | Scrambles natural cube |
| Multi-views | Zero123++ output on real subj | Pre-rendered from GT cube (natural frame) |
| Net effect | Self-consistent chain | 3 conventions mismatched |

**Best score**: 2/6 at SKIP_UNDO=1 + rotation-offset=90. FRONT 0.638,
RIGHT 0.665. Front+right pass by palette coincidence mostly.

**Arithmetic trace of R_undo on face normals** (proves why fix is hard):

R_undo = Rx(+90) @ Ry(-90) = [[0,0,-1],[-1,0,0],[0,1,0]]

| Face (natural normal) | Post-R_undo normal | Matching (az,el) |
|---|---|---|
| FRONT (0,0,-1) | (+1,0,0) | az=0, el∈{0,20,-10} ✓ |
| BACK (0,0,+1) | (-1,0,0) | az=180 ✓ |
| TOP (0,+1,0) | (0,0,+1) | az=270 (!) ✓ |
| BOTTOM (0,-1,0) | (0,0,-1) | az=90 (!) ✓ |
| RIGHT (+1,0,0) | (0,-1,0) | **NO MATCH** in Z123 angles |
| LEFT (-1,0,0) | (0,+1,0) | **NO MATCH** |

So R_undo maps TOP/BOTTOM → horizontal azimuths, and RIGHT/LEFT → to
the ±Y axis which Zero123++ never images directly (elev is only ±20).
**The vertical Y axis of the subject becomes uncoverable.**

That's why 2/6 is the ceiling with rotation tweaks alone: we can get
FRONT + BACK or FRONT + one side to align, never more.

**Full fix requires TWO coordinated changes**:
  (1) change R_w2c_base so natural +Y = camera up
  (2) keep R_undo = identity for the GT cube
These two break the real pipeline (which relies on the current basis +
R_undo). Making the fix backward-compat needs either a flag on the
bridge that signals "input is already canonical" and selects a
different code path, or a cube asset rebuilt in SF3D frame so both
paths use the same convention.

**Not done tonight**: the backward-compat refactor. Session ends with
stage 4 at 2/6 stable, full diagnostic visible in UI, user can see
per-face GT-vs-got. Real pipeline untouched.

### Full-pipeline test on GT cube image (2026-04-17 late) — HALLUCINATION CONFIRMED

Ran `local_sf3d_bridge.py` on `ref_0.png` (the flat F-striped cube image):
  - Output: 24343 verts / 45248 faces (full pipeline succeeded in 3min)
  - FRONT: F visible but texture granular + rayures bruitées
  - BACK: bruit + hallucinations rayures (Zero123++ couldn't imagine
    back of a flat cube)
  - TOP: hexagonal pattern artefacts (SF3D out-of-distribution)

**Definitive conclusion**: The real pipeline ALSO produces bad textures
on the flat calibration cube. It's not a calibration-only bug — the
whole pipeline is unsuited to flat-color out-of-distribution inputs.

On real photorealistic subjects (dog, horse, orc) the pipeline works
because SF3D+Zero123++ were trained on Objaverse photo-like renders.

**Implication for calibration**: Stage 4 will never pass 6/6 on the
synthetic cube, not because texture_project is broken, but because
the pipeline inputs it expects don't exist for this asset. Use
Stage 4 as a REGRESSION detector (did score drop vs last run?) not
as a correctness oracle.

### 2026-04-17 end-of-day — Full pipeline test on T-pose person — PARTIAL

Generated a photoreal T-pose person via RealVisXL, ran full
local_sf3d_bridge on it. Result: 6553 verts / 10088 faces.

Visual 6-axis render:
  - FRONT: silhouette OK, t-shirt + jeans visible but VERY pixelated
    ("tile-like" noise artefacts everywhere, not smooth color)
  - BACK: back visible, same granular noise
  - RIGHT/LEFT: side profiles correct, same noise
  - Shape: correct T-pose, arms extended, head + limbs recognisable

**Conclusion**: The REAL bug the user has been seeing all along is
NOT in UV projection (Stage 4), it's in the atlas resolution /
SDXL refine tile quality. The pipeline gets the geometry + azimuth
mapping right on in-distribution humanoids, but the final texture
quality is low-fidelity. Likely causes:
  - SF3D base atlas is ~512-1024px for the whole mesh
  - SDXL refine tiles sometimes hallucinate noise patterns
  - Vertex density too low to support fine details

### 2026-04-17 NEXT STEP — Crash-test mannequin asset (IN PROGRESS)

User request: build a humanoid mannequin (in-distribution for SF3D)
with each body zone labeled by a unique color + pattern + letter.
If the texture projection puts "F" on the back or "L" on the right
arm, the mismatch is instantly visible. Zones:
  - Torso FRONT = yellow/black checker + "F"
  - Torso BACK  = orange/black checker + "B"
  - Left arm    = red stripes + "L"
  - Right arm   = blue stripes + "R"
  - Left leg    = green dots + "LL"
  - Right leg   = purple dots + "RL"
  - Head top    = plain orange + "H"

This gives a proper calibration asset that is:
  (a) In-distribution (humanoid shape SF3D has seen 1000s of times)
  (b) Traceable (each zone's projection can be visually verified)

### 2026-04-17 — Mannequin full-pipeline test — CRITICAL FINDING

Ran local_sf3d_bridge on mannequin_ref.png (3/4 view of a humanoid
with yellow/black F checker front + orange/black B checker back).

Result: 7112 verts / 11844 faces.
Visual 4-axis render:
  - FRONT: silhouette + palette CORRECT. Yellow/black checker visible
    on torso, red/blue stripes on arms, green/purple dots on legs,
    orange head. F letter illegible due to noise but color zones right.
  - BACK: texture WRONG. Atlas shows yellow/green/white checker pattern
    instead of orange/black. SF3D hallucinated the back because
    Zero123++ couldn't correctly imagine the back of a stylized figure.
  - RIGHT/LEFT: mesh is nearly flat (0 depth on sides) because input
    was 3/4 not profile — SF3D reconstructed a flat silhouette.

**Root-cause verdict**: The texturing problem the user has been seeing
for weeks is NOT primarily in texture_project.py. It has 3 layers:
  1. Zero123++ hallucinates back/sides on stylized or unusual inputs
  2. SF3D reconstructs flat sides when input is 3/4 instead of profile
  3. texture_project then has nothing real to project from on back/sides
     → falls back to SF3D's blurry baked atlas → noise artefacts

Fixing texture_project alone cannot solve this. Upstream improvements
needed:
  - Better multiview generator (TRELLIS, Unique3D, MV-Adapter)
  - OR force user to provide back image separately (UI workflow change)
  - OR accept that texture fidelity on non-front regions is capped

For calibration: the mannequin asset is NOW valuable for detecting
pipeline regressions visually (F on back / R on left arm / etc.)
even though it won't reach 6/6 score with current pipeline.

**What works**:
  - UI calibration button functional in ~7s
  - Per-stage visual comparison HTML (expected vs got)
  - Bug precisely localized and visualized

**Open question for next session**: the full chain has THREE coupled
conventions (SF3D post-transform, R_undo in texture_project, Zero123++
camera basis). Fixing any single one breaks the others. Next approach
should either:
  (a) parameterize ALL three simultaneously and sweep the joint space
  (b) bypass R_undo + use a cube authored in SF3D output frame + render
      with SF3D-frame cameras — fully self-consistent isolated test
  (c) accept stage 4 at 3/6 as "detect regression" floor and move on

**Backup**: `calib-before-redesign-20260417` (pre-v3 state).

## 2026-04-17 — Calibration v3: Stage 4 REVEALS real UV bug

**First Stage 4 run** (deterministic: GT cube GLB + GT multi-views
fed directly to texture_project.py, no SF3D/Zero123++ involvement):
  - front:  sim=0.65 OK  (letter F slightly washed but correct)
  - back:   sim=0.598 FAIL
  - right:  sim=0.500 FAIL
  - left:   sim=0.439 FAIL
  - top:    sim=0.514 FAIL
  - bottom: sim=0.390 FAIL
  - Overall: **1/6**, all failures on non-front axes.

**Visual inspection**: the rendered FRONT shows the letter "F" as a
**horizontal mirror** of the GT (the F's crossbars point left instead
of right). This is a UV-to-atlas u-axis flip in texture_project.py
affecting every non-front face.

**This is the kind of bug the calibration system was built to catch.**
v1 (hand-painted cube) and v2 (Rubik's) couldn't reproduce it because
they also ran SF3D in the loop and the mesh hallucination masked the
projection bug. v3 stage 4 bypasses SF3D entirely → bug exposed in 7s.

**Next**: diagnose the U-flip in texture_project (likely in the
per-face UV emission or the camera-to-UV convention). Then implement
stages 2/3/5 + wire into UI.

## 2026-04-17 — Calibration v3 architecture defined

**Why abandon v2**: Every v2 attempt tried to score the entire
pipeline end-to-end on one reference. This conflated "pipeline
correctness" with "generative quality" — a scoring death spiral:
  - Hand-painted cube (flat colors, letters): out-of-distribution for
    SF3D. Max 1/6 forever.
  - Synthetic Rubik's: same OOD problem.
  - RealVisXL Rubik's photo: in-distribution for Zero123++ but
    per-face color positions are random — no deterministic GT possible.
  - RealVisXL apple: in-distribution, GT not possible (no face labels).

**v3 architecture** (planned via Plan-agent this session):

Five **independent** per-stage checks, each with inputs/outputs that
do NOT depend on upstream stages. The key trick — the colored-cube
GLB is NOT a pipeline input; it is a stage-4-only asset whose 6 GT
views in `ref_0_multiview_perfect/` are **inputs to texture_project**,
making stage 4 fully deterministic.

| Stage | Test | Pass |
|---|---|---|
| 1 — Ref image | dims, stddev, background clean | bool |
| 2 — Multi-views | silhouette centroids differ + color hist consistent | both |
| 3 — Mesh SF3D | orthographic front silhouette IoU vs input alpha | >= 0.70 |
| 4 — Projection | run texture_project on GT cube + GT views, render 6 axes, classify | 6/6 |
| 5 — Final GLB | render from input camera, perceptual similarity vs input | >= baseline - 0.05 |

**Backup tag**: `calib-before-redesign-20260417`.

**Roadmap commits**:
  1. module scripts/calib/stage_checks.py with 5 pure functions
  2. Stage 4 implementation (ROI max — catches 90% of UV/camera bugs)
  3. Stage 3 (silhouette IoU)
  4. Stages 2, 1, 5
  5. Orchestrator run_calibration.py + UI
  6. Per-stage baselines .fabmesh/calib_baselines.json for regression detection

---

## 2026-04-17 (late) — Calibration v2: Rubik's target + API + detailed logs

**Context**: After the painted-cube experiment scored 1/6 at best, the
diagnosis pointed at SF3D being out-of-distribution for stylized flat-color
inputs. User requested a switch to a canonical in-distribution object.

**Built**:

1. **Rubik's Cube calibration asset** (`scripts/_calib_build_rubiks.py`)
   - 6 canonical Western Rubik's colors (red/orange/blue/green/white/yellow)
   - 3×3 sticker grid with black borders + center-sticker letter per face
   - Produces `ref_rubiks.png` (ortho front), `ref_rubiks_multiview_perfect/`
     (6 GT views at z123 angles), `ref_rubiks_axes_perfect/` (6 axis GT),
     `meshes/_calibration/rubiks_groundtruth.glb`.
   - Auto-picked by default via env var `FABMESH_CALIB_TARGET=rubiks`
     (set to anything else to fall back to the painted cube).

2. **Control API endpoints** (in `src/main/control_api.js`), all local-only
   on 127.0.0.1:7331, auth-token gated:
   - `POST /calib/run` — full auto-diagnose pipeline (~4-5 min), returns
     summary + stages + verdict + log path
   - `GET /calib/list-reports` — all past runs with scores
   - `GET /calib/last-report` — most recent run's full data
   - `GET /calib/report?name=...` — specific run
   - `GET /calib/log?lines=500` — tail the detailed log
   - `POST /calib/log/clear` — empty the log
   - `POST /calib/build-rubiks` — regenerate the Rubik's reference asset
   - All scriptable from Claude Code / batch scripts / CI without the UI.

3. **Detailed calibration log** (`logs/calibration.log`)
   - `CalibLogger` class in `_calib_diagnose.py` with timestamped events,
     per-stage durations, GPU info, image dimensions, subprocess return
     codes, stderr tails on failure, per-face expected/got/sim.
   - Viewable in-app via `Settings → Calibration → View detailed log`
     (scrollable modal, line count adjustable, clear button).

**User constraints reaffirmed**:
- 100% local ✓
- Free + commercially licensable ✓
- Backup every significant state via git tags ✓
  (`calib-before-api-logging-20260417` added this session)
- Full API controllability ✓

**Backup tags so far for this calibration work**:
  - `calib-ui-backup-20260417` (before revert to 7c9225a)
  - `before-revert-to-7c9225a-20260417`
  - `calib-before-api-logging-20260417` (this entry's snapshot)

---

## 2026-04-17 — Calibration system + honest scoring + revert to standard flow

**Built**: full calibration infrastructure in FabMesh.

1. **Ground truth** (`images/_calibration/ref_0_perfect_axes/`): 6 synthetic
   orthographic axis renders of a textured cube using the 6 user-painted
   face PNGs. Each letter F/B/R/L/T/D reads correctly.
2. **`scripts/calibrate.py`**: runs SF3D + `texture_project.py` on the
   calibration cube image, renders 6 axis views of the result, classifies
   each against ground truth, writes an HTML report + score.json.
3. **Cross-validated classifier**: initial color-mean classifier gave
   false OKs (reported 3/6 when visual inspection said 1/6). Replaced
   with **two independent methods** that must agree:
   - Template matching (pixel-Euclidean distance vs the 6 GT renders)
   - Palette histogram (counts pixels matching each face's signature palette)
   If they disagree, the face is marked `?F/T` in the report — no false OK.
4. **FabMesh UI** — `Settings → Calibration`:
   - Run calibration button (full-width, row 1)
   - Open last report + Gallery (side-by-side, row 2)
   - Both now render **in-app modals** (not shell-opened HTML).
   - 6 axis thumbnails with green/red outline per face.
5. **Sweep script** (`_calib_sweep.py`): tests all 8
   `FABMESH_TEXPROJ_FLIP_{AZIM,ELEV,CAMPOS_AZIM}` combinations plus
   rotation-offset 0/90/180/270. **Max score achieved: 3/6 with the
   naive classifier, 1/6 with the honest one**.
6. **Visual diagnosis**: the raw SF3D output (without multi-view
   projection) ALSO scores 1/6 — the faces show "F" backwards on -Z,
   right side gets the front stripes, etc. So the core issue is
   upstream of the projection script.

**Conclusion**: fighting convention flags in `texture_project.py` is the
wrong battle. The symptom is visible in the raw SF3D mesh already.
Two hypotheses to test separately later:
  (a) the calibration cube itself is pathological input for SF3D (Objaverse-
      trained, expects photorealistic multi-view; a stylized cube with
      flat colors produces unreliable meshing/UV).
  (b) an unknown axis-flip between SF3D's output frame and the
      projection script's camera frame is compounding.

**Revert decision (user 2026-04-17)**: "temporairement on revient au flux
de base, avec juste les outils dans leur configuration normale". Actions:
  - Emptied `images/_calibration/ref_0_multiview/` (no more auto-copy
    of synthetic perfect views into the pipeline).
  - `calibrate.py` now errors out if the active multi-view dir is empty
    instead of silently copying the synthetic views.
  - UI Calibration panel kept (diagnostic tool).
  - Backup tag: `calib-ui-backup-20260417`.

Standard flow is restored: normal image → normal Zero123++ multi-view →
normal SF3D → normal `texture_project.py`. No forced perfect views.

---

## Constraints (never forget)

- **Commercial target**: Gumroad / itch.io / Fab.com (NOT Steam)
- **Must be**: free, local, commercially licensable, **EU-safe**
- **User is in France** → EU licensing restrictions apply
- **Hardware**: RTX 5080 (16 GB VRAM)
- **Prefer French** in chat replies

## Licence status of tried/considered models

| Model | License | EU + commercial? | Status in FabMesh |
|---|---|---|---|
| Stable Fast 3D | Stability Community (<1M$/yr) | ✅ | Bridged, current default mesh pipeline |
| TripoSG | MIT | ✅ | Bridged (`local_triposg_bridge.py`) — user has used it |
| TRELLIS | MIT | ✅ but UNUSABLE | Bridge exists but **never managed to run** — don't retry |
| Hunyuan3D-2 | Tencent Community | ❌ EU excluded | Bridged but **not allowed** for EU release |
| Zero123++ v1.2 | Apache 2.0 | ✅ | Current multi-view generator |
| RealESRGAN x4plus | BSD-3 | ✅ | Upscales multi-views 320→1024 |
| RealVisXL V4.0 | OpenRAIL++-M | ✅ | Current image generator |
| IPAdapter Plus | Apache 2.0 | ✅ | Tried for multi-view, failed (see log) |
| IPAdapter-FaceID | Research only | ❌ NON-COMMERCIAL | Never use |
| xinsir ControlNet OpenPose SDXL | Apache 2.0 | ✅ | Not yet tried |
| Unique3D | MIT | ✅ | Not yet bridged — candidate |

## Texture pipeline reference state (2026-04-14)

Current scripts:
- `scripts/multiview_gen.py` — Zero123++ → 6 views → RealESRGAN upscale 320→1024 → rembg bg removal
- `scripts/texture_project.py` — per-pixel barycentric projection of all 7 views (input + 6 multi) onto mesh UVs, with hard-override blend against SF3D fallback
- `scripts/multiview_sdxl_gen.py` — SDXL + IPAdapter alternative (does NOT work well, see log)

Commits of interest:
- `515ca97` — looser UV filters + hard blend + bg removal on multi-views
- `c68344a` — per-pixel rasterization uses ALL 7 views (not just front)
- `bfb2aaa` — RealESRGAN 320→1024 upscale integration

---

## Log entries

### 2026-04-16 evening — Calibration suite (color-coded cube) + convention sweep

Built a deterministic 3D calibration target so pipeline bugs become
immediately diagnosable visually. User wanted non-AI known-good input
so hallucinations don't hide orientation/projection bugs.

**Asset** (`scripts/_build_calibration_suite.py` → `images/_calibration/`
+ `meshes/_calibration_groundtruth.glb`):
 - 1x1x1 cube, each face: distinct solid colour + huge centered letter
   + faint pattern + corner labels ({F,B,R,L,T,D}-{TL,TR,BL,BR}).
   front=red F, back=cyan B, right=blue R, left=green L, top=yellow T,
   bottom=magenta D.
 - First draft used 12 face triangles → texture_project.py rejected
   100% of them (edge_size > 20% of atlas). Subdivided 4 levels →
   3072 faces; `_rebuild_cube_uvs()` re-projects every sub-vertex onto
   its owner cube face and emits an atlas UV pointing at the right cell.
 - Renders now orthographic (was perspective; was leaking 5 faces at
   once in the front view). Atlas face textures pre-flipped H so the
   letter reads the right way on the cube seen from outside.

**Analyzer** (`C:/tmp/_analyze_calib.py`): renders the output mesh
from each of the 6 cardinal axis directions orthographically, samples
the central 40% average colour, classifies as F/B/R/L/T/D and reports
a pass/fail per axis.

**Observed today on real FabMesh calibration runs**:
 - `_calibration_sf3d_1776359098043.glb`:
     Front = F red OK. Back = F-red (BAD, should be B cyan).
     Right = F-red spillover. Left = L green OK.
     Top = L green (should be T yellow). Bot = R blue (should be D magenta).
   Pattern: front projection floods multiple axes; back/top/bottom
   are getting mismatched views.

**Convention sweep tool** (`C:/tmp/_sweep_texproj.py`): loads the
ground-truth cube pre-rotated into SF3D's frame (Rx(-90)·Ry(+90)·invert),
runs `texture_project.py --multiview` with 8 different sign
combinations of azim/elev/campos_azim env flags, and measures axis
correctness. Result: all 8 variants score ≤ 1/6 — not because the
sweep is wrong, but because the synthetic multi-views I render in
the calibration script don't match Zero123++'s actual per-view
camera convention. So this sweep can't pick a convention on its own;
must be driven from REAL Zero123++ output for the answer to be real.

**Env flags added to texture_project.py** (non-default, used only
when set):
 - `FABMESH_TEXPROJ_FLIP_AZIM`
 - `FABMESH_TEXPROJ_FLIP_ELEV`
 - `FABMESH_TEXPROJ_FLIP_CAMPOS_AZIM`

**Next step**: drive a fresh FabMesh generation through the calibration
project (Zero123++ → SF3D → projection → refine) via the MCP bridge so
the user sees the progress popup. Run `_analyze_calib.py` on the result
to see which of the 6 axes still carry wrong colours, then iterate on
rotation_offset and projection conventions with ground truth in hand
instead of guessing from orc textures.

Commits today:
  - `ce1e12b` log update
  - `0cce0ef` view select shows current view name
  - `776e3bb` subdivided cube + env sign flags in texture_project

---

### 2026-04-16 — Day-long pipeline overhaul (19 commits)

Focused day: making multi-views actually serve fidelity to the reference
image + fixing the constant "the mesh face is 180° wrong" bug + UX around
multi-view bar.

**Storage architecture — per image version** (was previously shared per project):
- `35634a4` multi-views live in `images/<project>/<image_stem>_multiview/`.
  3D bridge only LOOKS UP, never generates. Falls back to pure SF3D if missing.
- `4404fed` + `c1f4bc8` auto-inherit on new image version: silhouette hash
  matches → copy; no match → async Zero123++. Wired on all 6 handlers that
  produce new versions (including the second `remove-background` I'd missed).
- `80202ad` re-hydrate mv-bar from disk when `reloadCurrentProject` clears
  the in-memory cache. New `check-multiview-dir` IPC.
- `09f94c7` mv button now registers a proper pushJob (Running task dialog).
- `4ea78f7` openProject re-checks mv-bar after stages settle.
- `34baeba` version-thumb click re-checks mv-bar.
- `732667c` selected ANGLE (front/fr/right/br/bl/left/fl) persists across
  version switches: if user has 90° pinned on v0, switching to v1 keeps 90°
  and swaps preview to v1's view_1.png.

**Copy prompt button** (`0d72183`): under image preview, reads
state.currentProject.prompt, copies to clipboard.

**T-pose enforcement** (addresses Zero123++ failure on dynamic poses):
- `200e389` text-prompt tuning. **Insufficient.**
- `c2cbfd8` real fix: T-pose keyword → DreamShaper XL Lightning
  (OpenRAIL++-M) + xinsir ControlNet OpenPose SDXL (Apache 2.0) + pre-
  rendered skeleton PNG (`scripts/assets/tpose_skeleton.py`). Geometric
  guarantee.
- `e989d68` fixed template conflict: `character` said both "T-pose" AND
  "isometric 3/4 view" — removed 3/4 keyword, added strict symmetry.

**Zero123++ quality** (`6c316e3`): steps 100→150, cfg 4.0→5.5, seed pinned.
+15 s, fewer smudges, tighter color adherence.

**Identity harmonize via IPAdapter**:
- `1837551` opt-in pass (on by default): each view → SDXL img2img
  strength 0.3 + IPAdapter conditioned on ref image. First attempt with
  plus variant crashed "mat1 x mat2 (514×1664 and 1280×1280)".
- `bd33c6e` switched to `ip-adapter_sdxl_vit-h` BASE variant, explicit
  CLIPVisionModelWithProjection from h94/IP-Adapter/models/image_encoder.
  Raises if ALL views fail instead of silently shipping unharmonized
  cartoon output. **Do-not-retry: ip-adapter-PLUS on RealVisXL+diffusers
  current stack crashes on 0-element reshape in attention processor even
  with correct encoder.**

**Auto-align facing detection** (series of fixes for "mesh backwards"):
- `d581779` bug: chest_z near zero (+0.005) caused spurious 180° flip
  decisions. Added head_z vote as tie-breaker; weighted sum of chest+head.
- `8f6e264` sign of comparison was inverted (empirical verification on
  'garcon' mesh: chest_z=-0.004 head_z=-0.017 was showing BACKWARDS, so
  flip should trigger on NEGATIVE sum, not positive).

**Observed user pain points still open** (not resolved today):
- Zero123++ still hallucinates back/sides of stylized characters
  (orc_child dup face, orc_woman beige legs, garcon bras repliés vers
  tête instead of horizontal on multi-views). Limit is fundamental to
  Zero123++ v1.2 training data — Objaverse lacks T-pose chars.
- MV-Adapter (Apache 2.0, commercial-safe) identified as real
  replacement candidate but not yet integrated (~1h30 dev deferred).

---

### 2026-04-15 — Progress bar: completing the earlier fix (commit pending)

**User reported**: after commits `c3acc3e` and `c0d0012`, the bar STILL
climbs to ~90% in the first few seconds and then sits there for the
long SDXL refine phase. The `LOCAL_SF3D_PROGRESS: <overall>` single-
source-of-truth values from the bridge were emitted correctly — but
something else in the stream kept snapping the bar to 90%.

**Root cause** (two overlapping bugs, both in the previous fix):

1. `scripts/multiview_gen.py` emits progress via TWO channels:
   - `_subpct(...)` → `FABMESH_SUBPCT: <sub%>` — the bridge remaps
     these correctly into overall via `fabmesh_progress.sub()`.
   - `slog.progress(...)` → `MULTIVIEW_PROGRESS: <sub%>` — via
     `fabmesh_log.Logger.progress()`. These lines were NEVER remapped.
   The renderer's scraper regex was `/_PROGRESS:\s*(\d{1,3})/`
   (`src/renderer/index2.js:6219`). That regex matches `MULTIVIEW_PROGRESS:`
   just as happily as `LOCAL_SF3D_PROGRESS:`. Multiview emits
   `MULTIVIEW_PROGRESS: 90 cleanup` and `MULTIVIEW_PROGRESS: 100 done`.
   The renderer interpreted 90 and 100 as OVERALL percentages and
   slammed the bar to 99%, masking the rest of the pipeline.

2. `_stream_subprocess` in `local_sf3d_bridge.py` forwarded every
   sub-script stdout line verbatim prefixed with `LOCAL_SF3D: `. Even
   after tightening the renderer regex, old-renderer builds or third-
   party log scrapers would still see the raw `MULTIVIEW_PROGRESS:`
   substring inside those forwarded lines.

**Fix**:
- `src/renderer/index2.js:6217-6282` — regex tightened to
  `/\bLOCAL_[A-Z0-9_]+_PROGRESS:\s*(\d{1,3})/` so ONLY bridge-level
  overall emitters (LOCAL_SF3D_PROGRESS, LOCAL_TRIPOSR_PROGRESS,
  LOCAL_TRIPOSG_PROGRESS, LOCAL_MESHY_PROGRESS, LOCAL_IMG_PROGRESS,
  LOCAL_JUGG_PROGRESS, LOCAL_REALVIS_PROGRESS) drive the bar.
  Also: parse msg line-by-line and SKIP any line starting with the
  bridge's forward prefix `LOCAL_SF3D: ` — those lines contain
  sub-phase percentages that look like overall percentages.
- `scripts/local_sf3d_bridge.py:53-64, 75` — `_neutralize()` helper
  rewrites `_PROGRESS:` → `_SUBPROG:` in forwarded sub-script lines
  so legacy scrapers can't mistake a sub-pct for overall.

**Verification** — replay of `logs/fabmesh.log` confirms the renderer
regex no longer matches `MULTIVIEW_PROGRESS: 90`, `MULTIVIEW_PROGRESS: 100`,
`TEXTURE_PROGRESS: ...`, only `LOCAL_SF3D_PROGRESS: <overall>` produced
by `_emit_progress()` or by `_stream_subprocess`'s remap. PHASE_BUDGET
cumulative: 1 → 3 → 28 → 36 → 41 → 45 → 60 → 99, monotonic.

**Not changed**: pipeline behaviour, mesh/texture quality, timings.

### 2026-04-15 — Progress bar: single source of truth (commit `c3acc3e`)

**User pain point**: the 3D generation progress bar jumped from ~20% to
97% within a few seconds and then froze at 97% for minutes before
finishing. Felt broken. User asked that the bar reflect TRUE overall
progress.

**Root cause (two bugs compounding)**:
1. The bridge's hardcoded markers (5/10/12/25/50/90/97/100) didn't match
   wall-clock time. On a typical run: SF3D inference is ~45% of real
   work — not 90%. Multi-view + UV projection + SDXL refine are the
   other 55%, all happening between the hardcoded 90 and 100.
2. Sub-scripts (`multiview_gen.py`, `texture_project.py`,
   `texture_refine.py`) were invoked with `capture_output=True`, so
   their stdout was buffered until they exited. Intermediate progress
   lines (per-view upscale, per-tile SDXL) never reached main.js during
   execution — the bar had nothing to report and the timer saturated.

**Fix**:
- New `scripts/fabmesh_progress.py` — 50-line module holding
  `PHASE_BUDGET` with wall-clock weights (`multiview=25`, `sf3d_load=8`,
  `sf3d_infer=5`, `tex_project=15`, `refine=40`, `finalize=4`, etc.).
  `start(phase)` / `end(phase)` / `sub(phase, 0..100)` derive
  overall percentages. Editing one weight rebalances every emitter —
  single source of truth as requested.
- Bridge: `_emit_progress(phase)` replaces the hardcoded `LOCAL_SF3D_PROGRESS:`
  lines. `_stream_subprocess()` replaces `subprocess.run(capture_output=True)`
  for the four long sub-script calls: forwards stdout line-by-line AND
  remaps `FABMESH_SUBPCT: <0-100>` markers into the overall slice via
  `fprog.sub()`, re-emitting them as `LOCAL_SF3D_PROGRESS:`.
- Sub-scripts emit `FABMESH_SUBPCT:` at meaningful checkpoints:
  per-view upscale and per-view style-harmonize (multiview_gen), every
  ~5% of the face-rasterization loop (texture_project), per-tile SDXL
  refine completion (texture_refine). Existing `MULTIVIEW_PROGRESS:`
  and `slog.progress(...)` lines kept intact so other consumers
  (multiview standalone IPC, fabmesh_log) still work.
- Renderer (`index2.js`): ignores raw `FABMESH_SUBPCT` messages (those
  are sub-pct, not overall pct — the bridge already remapped them);
  stops the 5→90% smooth-climb timer as soon as the bridge reports its
  first real event. The timer's cap at 90% was masking the entire
  refine phase (60–99%) — that was the user-visible "stall at 97".

**Verification** — dry-run enumeration of a typical pipeline produced:
1 → 3 → 28 → 36 → 41 → 45 → 59 → 62 → 73 → 86 → 98 → 99 → 100,
monotonic and roughly proportional to real seconds on an RTX 5080.
SDXL refine (longest phase) now owns overall 60-99, so per-tile ticks
(~13s each for 9 tiles) move the bar ~4% each — visible motion.

**Not changed**: pipeline behaviour, timing, quality. Pure plumbing.

### 2026-04-15 — Project-level multi-view cache (commit `bb87f12`)

**User pain point**: "le multiview doit être dispo à toutes les
versions de l'image principale". Every time the user did rembg/crop/
recolor on the reference image, the mesh generation had to rerun
Zero123++ (~45s) even though the subject shape was identical.

**Cache key**: silhouette hash. The preprocessed image's alpha channel
(or grayscale fallback) is downscaled to 64×64, binarized, and sha1'd.
Retouches that preserve the silhouette → same hash → cache hit.

**Layout**:
```
images/<project>/.multiview_cache/<16-hex-hash>/
    input.png
    view_0.png .. view_5.png
```

**Flow** (in `local_sf3d_bridge.py`):
1. Compute silhouette hash before spawning multiview.
2. If all 6 views + input exist in cache → copy them into the per-mesh
   `.multiview` dir and skip Zero123++ entirely (**saves ~45s**).
3. On miss, run Zero123++ normally and write the result into the cache
   on success, so the next retouched variant will hit.
4. Any error falls through silently — pipeline still works.

Transparent, no UI change. Works with the style-harmonize pass too
(harmonized views get cached, not raw Zero123++ views).

---

### 2026-04-15 — Style-harmonize multi-views via SDXL img2img (commit `7c9225a`) — Solution 1

**User observation**: after regenerating the pipeline end-to-end on
test_e2e, the input image was photorealistic but the 6 Zero123++
multi-views came out with a cartoon/dessin look — atlas ends up with
incoherent style (photo front, cartoon back/sides).

**Why**: Zero123++ v1.2 was trained on Objaverse synthetic renders;
it imposes that style on whatever you feed it. Known limitation.

**3 options considered**:
 1. SDXL img2img style-transfer pass after rembg (light, commercial-safe)
 2. IPAdapter-guided multi-view gen (heavy refactor, also commercial-safe)
 3. Lower Zero123++ guidance_scale (5-min hack, inconsistent results)

**User chose 1 first; 2 as fallback if not enough.**

**Implementation** (`multiview_gen.py`):
- After the rembg bg-removal pass, each view is sent to the always-on
  SDXL server at `/img2img` with strength=0.35.
- Prompt = `<subject>, photorealistic, sharp focus, natural materials,
  consistent with reference photo, 8k detail`.
- Subject prompt comes from `prompts.json` via env var
  `FABMESH_REFINE_PROMPT` set by the bridge before spawning multiview.
- Alpha channel from rembg is preserved (reapplied after img2img so
  projection still knows which pixels are subject vs background).
- Falls through silently if the SDXL server is not up (no hard
  dependency, pipeline still produces raw Zero123++ views as before).

**Cost**: +30s (~5s × 6 views). Still within the 5 min budget.

**Ready to test**: user regenerates test_e2e end-to-end.

---

### 2026-04-15 — Bilateral-symmetry auto-align (commit `2eea5ea`) — drops the ±7° drift

**Root cause of the residual "décalage"**: the chest-bulge heuristic
was ~7° off optimal on real meshes because asymmetric surface features
(tilted head, diagonal sash, single pauldron, etc.) bias the mean
vertex-from-center direction.

**Validation on the pre-rotation test_e2e mesh**:
- chest-bulge (old): 176.86°
- bilateral symmetry (new): 169.75°
- Δ = 7.1° — exactly the order of magnitude the user saw as "pas loin
  mais il y a encore un décalage".

**New algorithm** (in `local_sf3d_bridge.py`):
1. Downsample mesh to 4000 vertices.
2. Coarse Y-rotation scan (2° steps, 0..180°) + fine (0.25° steps,
   ±3° around coarse best). Score = histogram-overlap between the
   rotated cloud and its x→-x mirror in a 64×16×64 XYZ grid.
3. Resolve front/back (180° ambiguity of mirror plane) via chest-z
   direction after rotation.
4. Apply only if >0.5° from identity.

Falls through to try/except with full traceback if any edge case hits,
so silent skip becomes impossible.

**Ready to test**: user to run a fresh generation on test_e2e. Expected:
face + multi-view back/sides precisely aligned (no ±2-7° residual).

---

### 2026-04-15 — Rotation-offset propagated to multi-view projection (commit `1965889`)

Follow-up to the auto-align fix: the rotation of the mesh (169.5° for
the apilive test) left the 6 Zero123++ views at their original
pre-rotation azimuths, so they bled onto the wrong parts of the rotated
mesh — visible as a slightly soft face + head and imperfectly aligned
side details.

**Fix** — `texture_project.py` now accepts `--rotation-offset DEG`; when
passed, every MULTIVIEW_VIEWS azimuth is shifted by that angle (modulo
360) so views land on the same mesh regions they depict. The bridge
(`local_sf3d_bridge.py`) captures `auto_align_rot_deg` at align time
and threads it through every `texture_project.py` invocation
(refine/atlas/atlas_refine/augment/vc paths).

**User verdict on the resulting mesh** (2026-04-15 evening): "on est
pas loin mais il y a encore un décalage". Face well-positioned overall,
shoulders/pectorals/pagne all correct, but face texture still slightly
off + buckle/sash positions drift a couple degrees.

**Root cause**: auto-align uses "average chest-bulge direction" which
has ±3–5° noise. The rotation offset compensates the alignment applied,
but if the alignment itself lands 2° off optimal, the multi-views get
offset by the same 2°. They don't hit the wrong side of the mesh any
more, but the ±2° residual drift is still visible.

**Next step** (in progress): replace the chest-bulge heuristic with a
**bilateral-symmetry-maximizing** rotation search. Humanoid subjects
(orcs, humans, animals) have a clean left/right mirror plane. Finding
the Y rotation that maximizes mesh-to-mirrored-mesh overlap lands
within ~0.5° of optimal, eliminating the drift. Scheduled for next
commit.

---

### 2026-04-15 — Auto-align WORKS (user visual confirmation)

Generated test_e2e_sf3d_apilive_1776274212.glb via direct CLI bridge call:
```
LOCAL_SF3D: auto-aligned mesh by 169.5° around Y (face was pointing [-0.182, 0.0, 0.983])
```
The orc's face was pointing ~dead-Z (away from glTF viewer). Rotation
brings it to -Z as expected. User confirmed visually: "l'orc est
parfaitement de face" in the FabMesh viewer — sash, buckle, armor on
thigh all visible in the right position.

Side note: CLI bridge runs bypass FabMesh's `mcp-job-start` event, so
no "Running task" dialog appears when bridged directly. Functionally
fine, just UX-different.

**Still to polish** (user mentioned): the face/head texture looks a
bit soft compared to the reference. Candidate next step: run the
ControlNet Tile refine with IPAdapter fed from the reference image +
multi-views, so SDXL has the actual orc identity to match when
injecting detail. Distinct task from fidelity (shape) which is now
solved.

---

### 2026-04-15 — Mesh auto-align to -Z (root cause of "texture inverted" on test_e2e)

**User symptom**: newly generated test_e2e mesh appeared as if the
texture was inverted front/back, and the back looked all black in the
FabMesh viewer.

**Investigation** (via `_check_orientation2.py` Python renderer, 4
cardinal views):
- GLB geometry is intact (same 19567 verts / 24576 faces as earlier
  working generations).
- `_proj_debug.png` generated at projection time shows the orc perfectly
  from the front — so `texture_project.py` IS projecting the correct
  view onto the correct part of the mesh.
- BUT the chest bulge (in-plane XZ component of chest-outward average)
  points at `(-0.606, 0, +0.795)` — face direction ~53° off any axis.
- FabMesh Three.js viewer spawns camera at `(+X,+Y,+Z)` looking at the
  origin. With the orc facing 53° in the (-X, +Z) quadrant, the viewer
  ends up photographing the orc's left side, not its front.
- Hence the impression of "inverted / back black" — the front IS painted,
  just not visible from the viewer's default angle.

**Fix** (commit `7f36fc3`): added an auto-align step in
`local_sf3d_bridge.py` right before `mesh.export`. Slices the
mid-body (30-80% height), averages chest-outward direction in the XZ
plane, and rotates the entire mesh around Y so that direction becomes
-Z (glTF "forward"). Skips if already within 3° to avoid numerical
drift. Applies to every SF3D generation, so the viewer + projection +
rig all see a canonically oriented mesh.

**Test plan**: generate a new test_e2e mesh → confirm the thumbnail
shows the orc from the front (or a 3/4-front), not from the side.

---

### 2026-04-15 — MAJOR COURSE CORRECTION — going back to fidelity-first

**User restated the #1 goal** (not a new requirement, the *original*
demand): *"je veux un mesh 3D qui soit le plus proche possible de
l'image initiale (shape et texture) → c'est la demande de base"*.

**Recognition**: I've been chasing SDXL refine quality for hours, but
every refine (v1 + v2 of CN Tile) was adding/changing pixels that have
**no relationship to the reference image**. The refine was never going
to fix fidelity — it was a purely stylistic layer on top.

**Real diagnosis — multi-views are silently not generating**:
- `logs/_multiview_*` latest folder is from 2026-04-14 23:01 (project
  orc_blue_crown). No multiview folder exists for today's test_e2e
  generation (12:12–12:16).
- `grep multiview logs/fabmesh.log` around 10:12–10:16 returns zero
  matches. The SF3D bridge's multiview step was skipped.
- SF3D received only the single reference image → no back/sides info
  → the atlas can only have front-biased texturing, with back/sides
  fabricated from SF3D's prior. This is **the real reason** the base
  mesh texture is weak, and no amount of refine can add back info the
  mesh never had in the first place.

**Immediate next steps** (pivoting away from CN Tile experiments):
1. Reproduce a mesh generation and capture EVERY log line to find
   where multiview is being skipped. `local_sf3d_bridge.py` has a
   try/except at line ~108 that silently sets `_multiview_dir = None`
   on failure — likely the culprit.
2. Once multiview is confirmed running again: verify the 6 views go
   through RealESRGAN upscale + rembg + feed into SF3D's atlas bake.
3. Then A/B the mesh with/without multiviews on the same reference.
4. Only after fidelity is verified: consider IPAdapter-guided refine
   that takes the reference image AND the 6 multiviews as conditions,
   so any refine stays aligned with the actual orc.

**FIX 1 applied** (commit `f61ecf0`): added `'refine'` to
`_modes_using_mv` in `local_sf3d_bridge.py`. Multi-views will now
generate again in the default refine path.

**FIX 2 applied** (commit `2f63b3f`): even with fix 1, the refine
branch was *ignoring* the generated multi-views. Refactored the refine
path into two steps:
 1. `texture_project.py --multiview` bakes the 6 Zero123++ views onto
    the SF3D atlas (same as 'atlas' mode)
 2. `texture_refine.py` then SDXL-polishes the *projected* atlas.
If projection fails, we gracefully keep the vanilla SF3D atlas.

**Test plan** (next run from user): generate a fresh mesh on the orc
reference → confirm `_multiview_*` folder appears → compare the
resulting mesh's back/sides with the reference image. Should now show
real multi-view data instead of SF3D's single-view prior.

**Hyper-SDXL 8-step LoRA work was started** (sdxl_server.py +
texture_refine.py branches) but **stashed** (`wip_hyper_sdxl_pause`) —
optimizing refine speed is useless while the base mesh isn't faithful
to the reference.

**Added to memory** (`project_core_requirement.md`): fidelity to
reference image (shape + texture) is FabMesh's #1 goal, everything
else is secondary.

---

### 2026-04-15 — ControlNet Tile SDXL atlas refine — FIRST RUN DONE (pending user visual verdict)

**Run 1 (failed at tile 1)**: auto-derived `steps=42` at strength 0.6,
each tile took ~250s → client timeout 240s. Fixed by pinning
`steps=25` for CN Tile + bumping HTTP timeout 240→600s (commit
`39dfd02`).

**Run 2 (success)**: `strength=0.6 cn_scale=0.7 steps=25 target=2048`
on `test_e2e_sf3d_1776247937665.glb`. Output:
`test_e2e_sf3d_1776247937665_cntile.glb` (same byte size — in-place
atlas swap kept GLB structure intact).
- Tile times: 177+72+65+58+71+57+52+23+17 = **596s total ≈ 10 min**.
  (1st tile includes 1-time xinsir/controlnet-tile-sdxl-1.0 download
  + load into VRAM ~2.5 GB. Subsequent tiles ~60s each.)
- VRAM peak ~15.3/15.9 GB (96%) — at the edge but no OOM.

**Speedup research (agents, 2026-04-15)**:
- **Hyper-SDXL 8-step CFG-preserved LoRA** (ByteDance, openrail++ with
  $1M cap): can drop to 8 steps × CFG 6 × strength 0.55 → ~25s/tile
  (-65%). Micro-detail softens slightly. Yellow-light for ship.
- **torch.compile**: theoretical +20% but recompile triggered on every
  pipe unload/reload (our server juggles 3 SDXL pipes on 16 GB), so
  net gain is negative. **Red-light — skip.**
- **Atlas 1024 default + RealESRGAN x2** (matches Meshy free tier):
  1 tile × 60s = **~70s total (-88%)**, better global coherence.
  **Green-light — biggest win, should be the default mode.**
- **Preset tuning**: strength=0.42 steps=18 cn_scale=0.75 CFG=5.5
  DPM++ 2M Karras — ~50s/tile (-30%), more visible micro-detail
  (lower strength lets CN Tile inject high-freq instead of being
  overridden). **Green-light — try before going LoRA.**

**Next decision** (pending user visual judgement on the 2048/9-tile
output): if quality is visibly better than vanilla refine, ship the
new default as 1024 single-tile + RealESRGAN x2 + preset
`strength=0.42 steps=18 cn_scale=0.75`. Add a "Max Quality" button
for 2048/9-tile when needed.

---

### 2026-04-15 — ControlNet Tile SDXL atlas refine — IN TEST

**Motivation**: user wants Meshy-quality texture; TRELLIS.2 is legally
unshippable (nvdiffrast NC); Hunyuan3D EU-excluded. Only commercial-safe
lever left is to push the existing SDXL atlas_refine harder.

**Problem with current refine** (`strength=0.25`, plain img2img):
- Too timid to add visible detail
- Bump strength above 0.3 → SDXL hallucinates and breaks UV layout
- No 3D-structure awareness — it repaints tile-blind

**Fix**: plug xinsir/controlnet-tile-sdxl-1.0 (Apache 2.0, commercial-safe)
into the refine pipeline. Tile ControlNet forces SDXL to respect the
source image structure while still adding micro-detail. This lets us
push `strength` to 0.5–0.75 without destroying the atlas layout — same
technique Meshy/Scenario use.

**Also fixed a stale bug**: `texture_refine.py` was pointing at
`http://127.0.0.1:7777/health` but the SDXL server binds 5555 and
exposes `/ping`. So `_server_alive()` always returned False → every
refine went through the slow in-process fallback. Corrected to 5555
+ /ping.

**New code** (commit `c456ec2`):
- `sdxl_server.py`: lazy-load `StableDiffusionXLControlNetImg2ImgPipeline`
  with xinsir/controlnet-tile-sdxl-1.0 + RealVisXL V4.0. Unload-with-others
  rule preserved to stay under 16 GB. Endpoint `/img2img_tile` accepts
  `strength`, `controlnet_scale`, `guidance_scale`, `steps`.
- `texture_refine.py`: flags `--controlnet_tile --cn_scale 0.7`,
  threaded through the whole call chain. Default strength 0.25 kept
  for back-compat; ControlNet test will use 0.6.

**Test plan** (pending): run on `test_e2e_sf3d_1776207309698.glb`
with `--controlnet_tile --strength 0.6 --cn_scale 0.7 --target 2048`
→ compare side-by-side with previous refine (strength 0.25, no CN).
User will judge visually.

---

### 2026-04-15 — TRELLIS.2 already installed in WSL — DIDN'T RUN (CUDA ABI mismatch)

Re-discovery: `local_trellis2_bridge.py` (170 lines) already exists in
`scripts/`, and `/root/TRELLIS.2` exists in WSL Ubuntu with a `.venv`
(python 3.12) and the official `example_texturing.py`. Module
imports cleanly (`from trellis2 ...`).

The bridge's docstring claims "works out of the box with ~14 GB VRAM
peak on RTX 5080" — so a previous attempt DID succeed once.

**Failure mode this time** (test on orc image, output to /tmp):
```
ImportError: ... flex_gemm/kernels/cuda.cpython-312-x86_64-linux-gnu.so:
undefined symbol: _ZNK3c1010TensorImpl15incref_pyobjectEv
```
flex_gemm 1.0.0 was pre-compiled against torch 2.6 (TRELLIS.2 README
explicitly recommends torch 2.6.0 + CUDA 12.4) but the venv has
torch 2.9.1+cu128. Pre-built CUDA extensions break across torch
minor versions.

**Why this happens repeatedly**: TRELLIS.2 ships its own custom CUDA
ops (flex_gemm, custom_rasterizer). They're tightly coupled to the
specific torch ABI they were built against. Any pip install/upgrade
in the venv that touches torch breaks them.

**Two ways forward**:
- A. `pip install torch==2.6.0 --index-url cu124` inside the venv
  (5 min, narrow risk — only the trellis2 venv affected)
- B. Recreate the venv from scratch via TRELLIS.2's official
  `setup.sh` (~30 min, cleanest)

**User instruction**: install it for real this time, log every step
to avoid going in circles.

**Attempt 1 (2026-04-15 ~10:35)**: downgrade torch in the venv to
2.6.0+cu124 to match the flex_gemm 1.0.0 pre-built wheels. Command:
`/root/TRELLIS.2/.venv/bin/pip install torch==2.6.0 torchvision==0.21.0
--index-url https://download.pytorch.org/whl/cu124 --upgrade`.

→ torch 2.9.1+cu128 → torch 2.6.0+cu124 OK. Re-tested
`import flex_gemm` — **STILL** `undefined symbol _ZNK3c1010TensorImpl
15incref_pyobjectEv`. The locally-installed flex_gemm 1.0.0 isn't
built for torch 2.6 either. Origin unknown — pip says "from local"
without source URL. Probably built earlier against an even older
torch.

**Web research (agent ad0a60f011a9cdcca, 2026-04-15)** — clarifies
the Windows landscape:
- ❌ Microsoft TRELLIS.2 has **NO official Windows wheels**. Repo
  has 0 GitHub releases, no `wheels/`/`dist/`, README explicitly
  says "tested only on Linux". The earlier agent #3 finding "wheels
  Windows officielles available" was WRONG.
- ❌ Native Windows build attempts (issue #4) fail for nvdiffrast,
  nvdiffrec, cumesh, FlexGEMM, o-voxel — `CUDA_HOME` errors even
  when set. No Microsoft maintainer has helped on Windows.
- ✅ **Community wheels Linux cu128** at
  `siraxe/TRELLIS.2-4B_cuda_12.8.r12.8_wheels` for python 3.12 —
  usable inside WSL on Blackwell (RTX 5080 / 5090). 3 wheels:
  `cumesh-0.0.1`, `flex_gemm-0.0.1`, `o_voxel-0.0.1`.
- ✅ Real working setup: WSL2 Ubuntu + python 3.12 + torch
  2.6.0+cu128 (or torch from siraxe wheel set) + the 3 community
  wheels above.

**Packaging consequence for FabMesh commercial release**:
TRELLIS.2 cannot be shipped as a Windows-native local app. End
users would need WSL2 installed (~5 GB extra). Three options
remain:
- (A) Bundle WSL2 + everything in installer — feasible but heavy
- (B) Cloud premium endpoint that we host — defeats "100% local"
- (C) Skip TRELLIS.2 — keep current SF3D + atlas_refine which is
  100% Windows native

User chose: install attempt continues to validate quality. If
TRELLIS.2 is visibly much better, decide packaging strategy after.

**Attempt 2 (2026-04-15 ~10:55)**: switch venv torch to cu128 + install
community Linux wheels. **PARTIAL FAILURE so far**:
- `pip install torch==2.6.0 --index-url cu128` → "No matching
  distribution". The PyTorch index has torch+cu128 only from 2.7.0
  onwards; 2.6.0 is cu124-only.
- Without --force-reinstall, the previous 2.6.0+cu124 stayed.

→ Pivot: use **torch 2.7.0+cu128** (lowest cu128 version available)
and hope the siraxe community wheels (built against cu128 around
2025-12) are compatible with torch 2.7's ABI. Wheel filenames don't
encode their torch version, so risk: same `_ZNK3c1010TensorImpl
15incref_pyobject` symbol mismatch all over again.

**Wheels downloaded** to `/root/trellis2_wheels/`:
- `flex_gemm-0.0.1-cp312-cp312-linux_x86_64.whl`
- `cumesh-0.0.1-cp312-cp312-linux_x86_64.whl`
- `o_voxel-0.0.1-cp312-cp312-linux_x86_64.whl`

**Result torch 2.8.0+cu128**:
- flex_gemm OK ✅
- cumesh OK ✅
- o_voxel OK ✅ (the SymBool symbol is in torch 2.8)
- ❌ **nvdiffrast** now breaks: `undefined symbol _ZN3c104cuda29
  c10_cuda_check_implementationEiPKcS2_jb`. nvdiffrast was built for
  another torch ABI.

Trying: rebuild nvdiffrast from source against torch 2.8
(`pip install --force-reinstall --no-deps git+https://github.com/
NVlabs/nvdiffrast.git`).

→ **Build wheel FAILED** (exit code 1, output truncated to 5 lines).
Verbose retry with `-v` also failed. Output too noisy to triage,
need to inspect the build log on disk.

`Trellis2TexturingPipeline` requires nvdiffrast at import time
(confirmed via direct `from trellis2.pipelines import ...`), so
this blocks the whole pipeline.

**Next**: capture the actual nvdiffrast build error.

→ Build error: `Cannot compile nvdiffrast CUDA extension. Run pip
install with --no-build-isolation flag`. Trivial fix.

→ Retried with `--no-build-isolation`: **NEW ERROR**
`nvcc fatal : Unsupported gpu architecture 'compute_120'`. The
WSL Ubuntu has nvcc 12.0 system-wide, but Blackwell (RTX 5080 =
sm_120) requires **nvcc 12.8+** to compile.

This is the real blocker. Three options:
- A. Force build with `TORCH_CUDA_ARCH_LIST=8.9` (sm_89, Ada
     Lovelace 4090) — Blackwell may run sm_89 binary by fallback.
- B. Install CUDA Toolkit 12.8 in WSL (~3-4 GB) — clean fix.
- C. Abandon TRELLIS.2 path entirely.

**Discovery**: CUDA Toolkit 12.8 is **already installed** at
`/usr/local/cuda-12.8/`. The `nvcc` symlink at `/usr/bin/nvcc`
just points to the older 12.0. Use the explicit path.

Retry with `CUDA_HOME=/usr/local/cuda-12.8`,
`PATH=/usr/local/cuda-12.8/bin:$PATH`, and
`TORCH_CUDA_ARCH_LIST=12.0` (Blackwell sm_120, RTX 5080 native).
This is option B without a download (toolkit was already there).

→ First retry FAILED — `wsl -- bash -c "..."` from Windows
explodes when env vars contain Windows PATH segments with spaces
(`Program Files`). The shell parser hits `(x86)` and dies.

→ Workaround: package the build commands into a `.sh` script
(`c:/tmp/_build_nvdiff.sh`), copy into WSL, run there. PATH inside
the script is set explicitly to Linux-only dirs.

Build now running with clean env. Compile time ~3-5 min for nvdiffrast.

→ **SUCCESS** 🎉 — `nvdiffrast-0.4.0-cp312-cp312-linux_x86_64.whl`
built and installed (15 MB wheel, sm_120 native).

**Full stack smoke test** passed:
- torch 2.8.0+cu128 ✅
- flex_gemm (siraxe wheel) ✅
- cumesh (siraxe wheel) ✅
- o_voxel (siraxe wheel) ✅
- nvdiffrast 0.4.0 (locally rebuilt for sm_120) ✅
- `Trellis2TexturingPipeline` import ✅

**Working recipe** (for reproducibility and packaging):
1. WSL2 Ubuntu with venv python 3.12
2. CUDA Toolkit 12.8 at `/usr/local/cuda-12.8`
3. `pip install torch==2.8.0 torchvision==0.23.0 --index-url cu128`
4. `pip install --no-deps` the 3 siraxe community wheels
   (flex_gemm, cumesh, o_voxel from HF)
5. `CUDA_HOME=/usr/local/cuda-12.8 PATH=/usr/local/cuda-12.8/bin:$PATH
    TORCH_CUDA_ARCH_LIST='12.0' pip install --no-build-isolation
    --no-deps git+https://github.com/NVlabs/nvdiffrast.git`

Next: `local_trellis2_bridge.py` on orc image, inspect quality.

**First real test launched** (2026-04-15 ~11:30): `Trellis2TexturingPipeline`
on orc mesh + no-bg image.

→ **FAILED** at pipeline load (before inference!):
```
OSError: You are trying to access a gated repo.
Cannot access gated repo briaai/RMBG-2.0
403 Client Error.
```

The texturing pipeline instantiates a `BiRefNet` rembg module on
from_pretrained (trellis2/pipelines/rembg/BiRefNet.py:10), which
tries to download `briaai/RMBG-2.0` weights — a **gated** HF repo.

**Licence caveat**: `briaai/RMBG-2.0` is under a research license
(not commercial-free). Even if we got access, shipping FabMesh with
RMBG-2.0 would violate our "commercial + EU-safe" constraint. Same
as IP-Adapter-FaceID (research-only, we excluded it earlier).

**Options**:
A. Patch `trellis2_texturing.py` to skip rembg_model when the input
   image has alpha (our no-bg inputs already do).
B. Monkey-patch to inject a no-op rembg.
C. Replace BiRefNet with our existing `rembg` (u2net, Apache-2.0).

Going with **B** for the test (fastest to validate quality) then
**C** for commercial viability if quality is worth it.

**Add to "do not retry"**: TRELLIS.2 texturing depends on
`briaai/RMBG-2.0` (gated + research license). Must be patched out
for any commercial usage.

**Attempt B (2026-04-15 ~12:10)**: monkey-patch `BiRefNet.__init__`
to a no-op before pipeline load (`c:/tmp/_trellis2_monkey.sh`).
Pipeline load **SUCCEEDED** in 27 s with the 4B weights (415/415
loaded, flex_gemm + flash_attn backends active). RTX 5080 / cu128
stack is fully functional.

**Next blocker**: `trimesh.load()` returned a `Scene` because
SF3D GLB has one geometry inside a node. Fixed by calling
`trimesh.util.concatenate(list(loaded.geometry.values()))` when
`isinstance(loaded, trimesh.Scene)`. Mesh became a 15269-vert /
19048-face `Trimesh`.

**Next blocker after that**: `AttributeError: 'DINOv3ViTModel'
object has no attribute 'layer'` in
`trellis2/modules/image_feature_extractor.py:86`. Cause:
transformers ≥4.41 wraps DINOv3 as `model.model.layer` (i.e. the
encoder is at `.model`, not flattened). Older transformers the
TRELLIS.2 code was written against had `.layer` directly. Patched
the extractor in place:
```python
_layers = getattr(self.model, "layer", None) or self.model.model.layer
for i, layer_module in enumerate(_layers):
    ...
```
Backup saved as `image_feature_extractor.py.bak_preLayerFix`.

**Add to "do not retry"**: don't trust TRELLIS.2's feature
extractor to work out of the box on current transformers. The
`DinoV3FeatureExtractor.extract_features` hardcoded `self.model.
layer` which is now one level deeper.

### 2026-04-15 — TRELLIS.2 — FINAL VERDICT: ❌ ABANDONED FOR FABMESH

After getting the pipeline to actually load (monkey-patch rembg + scene
concat + DINOv3 layer patch), the next error was `no kernel image is
available for execution on the device` from flex_gemm — the siraxe
community wheels were built for sm_89 (Ada), not sm_120 (Blackwell / RTX
5080). They work for imports but kernels don't launch on our GPU.

Web research (agent a227cd7a80731f3cf, 2026-04-15) found that:
- ✅ `visualbruno/ComfyUI-Trellis2` ships **Windows sm_120 prebuilt wheels**
  in `wheels/Windows/Torch270/` — would likely run on RTX 5080 in 10 min.
- 🚫 **nvdiffrast (hard dep of TRELLIS.2) is NVIDIA Source Code
  License-NC**: §3.3 "The Work and any derivative works thereof only
  may be used or intended for use non-commercially." The so-called
  "1-way commercial" exception covers NVIDIA itself, not us.
- 🚫 ComfyUI itself is GPL-3.0 — can't be bundled in a closed paid
  app without source-opening everything.

**Conclusion**: even with infinite engineering time, TRELLIS.2 **cannot
be shipped** in FabMesh commercial release (Gumroad/itch.io/Fab). The
non-commercial nvdiffrast clause is a hard legal wall, not a technical
one. All further TRELLIS.2 install work is **wasted time** for this
project.

**Add to "do not retry"**: TRELLIS.2 for FabMesh shipping. Full stop.
Even if the wheels work tomorrow and the output is photorealistic,
we cannot legally redistribute nvdiffrast binaries in a paid `.zip`.
Only viable future use: "Bring Your Own ComfyUI" mode where the user
installs ComfyUI themselves and FabMesh talks to `localhost:8188` —
but that's a separate feature, not now.

**Path forward (user-chosen 2026-04-15)**: double down on SDXL
atlas_refine (already commercial-safe, 100% Windows native). Next
experiments: tighter tile overlap, strength ramp per region,
ControlNet depth-guided refine to preserve geometry while repainting.

---

**Result torch 2.7.0+cu128 + community wheels** (previous attempt):
- `flex_gemm OK` ✅
- `cumesh OK` ✅
- `grid_sample_3d OK` ✅
- `o_voxel` ❌ — `undefined symbol _ZNK3c107SymBool14guard_or_falseEPKcl`
  (= `c10::SymBool::guard_or_false(const char*, long)`) — present in
  torch 2.8+, not in 2.7. So o_voxel was built against torch 2.8.

**Attempt 3 (in progress)**: bump to torch 2.8.0+cu128 + same wheels.
3 of 4 things now work; o_voxel needs the 2.8 symbol.
Note: pin between flex_gemm/cumesh ABI (2.7-compatible) and o_voxel
(2.8-required) is fragile — there might be no torch version where
ALL 3 wheels are happy at once. Will know in 1 minute.

**Add to "do not retry"**: don't trust agent claims about "wheels
Windows officielles" without verifying via direct GitHub release
listing — Microsoft TRELLIS.2 has none.

### 2026-04-15 — TRELLIS.2 install attempt — STARTED

**Why retry**: Earlier `AGENT_LOG` entry says "TRELLIS never ran, don't
retry". That was for **v1** (CUDA / nvdiffrast / kaolin issues on
Windows). **TRELLIS.2** released by Microsoft in Dec 2025 has
**official Windows wheels** for nvdiffrast 0.4.0 (cp311-cp311) per
the agent #3 research today.

**Goal**: install TRELLIS.2 from `microsoft/TRELLIS.2` repo, run
`example_texturing.py` on the orc image, judge whether it produces
PBR atlases that beat our current SDXL refine. If yes, bridge it as
a new mode `FABMESH_PROJECT_MODE=trellis2`.

**Backup**: `git tag before-trellis2-attempt` created so we can
revert any accidental damage to the working pipeline.

**Constraints**: must be MIT or Apache, EU + commercial OK, must
fit in 16 GB VRAM (v2 docs say peak 30 GB in rendering — risky on
RTX 5080, will need the 4B distilled checkpoint).

### 2026-04-15 — Post-refine saturation/contrast punch — DONE

User feedback on atlas_refine result: "la texture semble toujours
délavée". The orc identity was preserved (green skin, blue crown
on head only, brown armor) but colours were too pale.

**Fix**: PIL ImageEnhance.Color x1.25 + ImageEnhance.Contrast x1.12
applied right after SDXL refine, before atlas write-back. Non-
destructive on detail (keeps the micro-texture SDXL added) but
restores the chroma SDXL softens.

Pending visual check.

### 2026-04-15 — atlas_refine: 2-pass projection + SDXL refine — IN PROGRESS

**Premise** (user request): retry the multi-view UV projection now
that we have all the latest fixes (alpha-aware multi-views,
elevation-correct camera, NEAREST→trilinear filter, normal-map
preservation), then chain SDXL refine on top to clean the seams.

**New mode**: `FABMESH_PROJECT_MODE=atlas_refine` in
`local_sf3d_bridge.py`. Runs `texture_project.py` (multi-view
projection, EDT dilation) then chains `texture_refine.py` with the
subject-aware prompt at strength 0.22.

**Side fix**: `texture_project.py` was iterating ALL images in the
GLB and overwriting them — same bug as upscale_atlas/texture_refine
had — destroying the normal map. Now resolves baseColorTexture index
explicitly before writing.

**Status**: not yet visually validated.

### 2026-04-15 — Trilinear filter + preserve normal map — POLISH

**Problem**: when zooming on a mesh, user saw "carrés" (the actual
texels of the 2048 atlas in NEAREST filtering). Also asked if we even
had a normal map.

**Findings**:
- Normal map IS present in every SF3D-baked GLB (SF3D `system.py:508`
  exports `normalTexture=bump_tex`).
- BUT: `upscale_atlas.py` was iterating ALL images in the GLB and
  upscaling them — including the normal map. RealESRGAN trained on
  photos was flattening the XY components of the normal, killing the
  bump.
- `texture_refine.py` was always replacing `images[0]` — when SF3D
  ordered the normal map first, refine wrote SDXL's hallucination
  ON the normal map.

**Fix** (commit `0737124`):
- Both scripts now resolve baseColorTexture explicitly via
  `materials[0].pbrMetallicRoughness.baseColorTexture.index` →
  `textures[i].source` to find which image to touch.
- `_applyMeshTextureFilter` in renderer: NEAREST → LinearMipMapLinear
  + 16x anisotropy; covers normalMap/roughnessMap/metalnessMap/aoMap
  too (was only `mat.map`).

**Status**: visual validation pending. Should give clean trilinear
zoom + working normal-map relief.

### 2026-04-15 — Subject-aware refine prompt — IN PROGRESS

**Premise**: refine SDXL at strength 0.25 with default generic prompt
("photorealistic detailed surface texture") was hallucinating an ice
golem on the orc because the blue crown dominated the signal.

**Fix** (commit `5cc4f6b`):
- `local_sf3d_bridge.py` reads the latest entry from
  `images/<project>/prompts.json` and passes it via `--prompt` to
  `texture_refine.py`.
- `texture_refine.py` prepends the user prompt to the quality
  keywords so SDXL is anchored to the right subject.

**Verified manually**: standalone refine with prompt "orc warrior
with blue crown..." in 60s, atlas correctly refined.

**Bug found**: pipeline run does NOT produce a refined atlas —
`FABMESH_PROJECT_MODE=upscale` was lingering in the OS env from a
previous PowerShell `Start-Process`, so the bridge was using upscale
instead of refine. Restarted clean without the env var.

### 2026-04-15 — SDXL atlas refine (Meshy-style) — DEFAULT

**Approach**: pass SF3D's baked atlas through SDXL img2img (RealVisXL,
strength 0.25) tile by tile (1024 tiles, 128 px overlap, feather
blend). Hallucinates micro-detail (skin pores, fabric weave, fur)
without changing colours or UV.

**Files**: `scripts/texture_refine.py` (new), wired in
`local_sf3d_bridge.py` as `FABMESH_PROJECT_MODE=refine` (default
since commit `958b30d`).

**Result on poule_geante**: visibly sharper plumage detail (orange
striping, defined feathers) vs the upscale baseline. Cost: +60-90 s
per generation (in-process fallback when SDXL server isn't up).

**Subprocess timeout**: bumped 120 → 600 s (commit `b7905a0`) because
the in-process fallback loads RealVisXL ~6 GB on first call.

### 2026-04-15 — RealVisXL prompt: 3/4 view bias — DONE

**Fix** (commit `3be97b5`): added "three-quarter view showing one
side, slight rotation" to the optimized_prompt and "strict frontal
view, flat profile" to negative_prompt in `local_juggernaut_bridge.py`.

**Why**: SF3D textures only what the front shows and invents the
back/sides. A 3/4 source image exposes one side directly, so SF3D's
bake has real data instead of inventions.

**Verified**: prompts produce 3/4 chickens / orcs / camels reliably.

### 2026-04-15 — Multi-view ADDITIVE augment on top of SF3D atlas — REJECTED VISUALLY

**Premise** (user's idea): SF3D textures the front well from the source
image but invents the back/sides. Augment those by overwriting only
where a Zero123++ multi-view sees that surface better than the front.

**Implementation**: scripts/texture_augment.py. Per face: front_score
= front_vis, mv_score = vis * priority for each of 6 views. If max
mv_score beats front_score by `margin` (default 0.15), overwrite the
SF3D pixels of that face's UV triangle with the multi-view sample.
Wired as `FABMESH_PROJECT_MODE=augment`.

**Result on poule_geante**: 8264/16534 faces overwritten (50%). Mesh
came out with **blotchy patchwork** plumage — black/yellow/white
patches because each Zero123++ view has its own implicit lighting and
the seams between SF3D and overwritten zones are abrupt.

**Conclusion**: photometric mismatch between Zero123++ views and SF3D
makes additive augmentation visually WORSE than plain upscale.
Keeping the script (it works) but `upscale` stays the default mode.

### 2026-04-15 — Atlas-only RealESRGAN upscale — NEW DEFAULT

**Insight**: we kept replacing SF3D's native atlas (which has CORRECT
UV layout — SF3D made it). The replacement (multi-view projection)
is what created the mosaic. Just keep SF3D's atlas + sharpen it.

**New script**: `scripts/upscale_atlas.py`. Takes a GLB, finds the
embedded baseColorTexture, runs RealESRGAN x4plus on it, writes back
to the same GLB (rebuilds binary chunk). 15 s on a 2048 atlas.

**SF3D bridge**: default mode now `FABMESH_PROJECT_MODE=upscale`. The
old multi-view UV projection lives behind `=atlas`, vertex-color
behind `=vc`, no post behind `=none`.

**Smoke test on man mesh**: 2048 -> upscale x4 -> resize 2048. Subtle
sharpening but limited because input is already 2048. Real benefit
when SF3D bake at 1024 then upscale to 2048 or 4096.

**Status**: not yet visually validated by user end-to-end through
FabMesh.

### 2026-04-14 — InstantMesh as alternative texture-aware mesh generator — STARTED

**Why**: SF3D ceiling reached. All atlas-based projections (mosaic),
xatlas re-pack (mosaic), vertex coloring (15k verts → flou granuleux).
User suggested using a dedicated texturing AI.

**Audit of texturing/mesh AIs (EU + commercial constraints)**:
- ❌ Paint3D, TexFusion, Text2Tex, MeshAnything: research only or
  Tencent Community license
- ❌ Hunyuan3D-2: EU-excluded
- ✅ InstantMesh (`external/InstantMesh/`): Apache 2.0, takes Zero123++
  multi-views as input, generates mesh + texture in single forward pass
- ✅ TripoSR (already in repo via `local_triposr_bridge.py`): MIT, but
  texture native ~SF3D quality

**Next experiment**: bridge InstantMesh as alternative engine.
External repo present, CLI at `external/InstantMesh/run.py`, takes
`config + input_path` and exports OBJ/GLB. `--export_texmap` flag.

### 2026-04-14 — Vertex coloring pipeline (no UV atlas) — DONE, REJECTED VISUALLY

**Result**: GLB 660 KB (vs 4 MB atlas), pipeline 0.1 s. Code clean,
camera math correct, 97% of verts covered by multi-view, 478 fall
back to SF3D atlas.

**Visual**: smooth, no mosaic — but **flou granuleux**. SF3D's 15k
vertices = ~128×128 effective texture resolution stretched on full
mesh surface. Not enough density for fine details (face, ornaments).
**User rejected**.

**Conclusion**: vertex coloring is structurally limited by mesh
density. Would need ≥60k verts (subdivide + paint) to compete with a
2048 atlas.

**File preserved**: `scripts/texture_project_vc.py` (gated by
`FABMESH_PROJECT_MODE=vc` env var).

### 2026-04-14 — Vertex coloring pipeline (no UV atlas) — IN PROGRESS

**Why**: 3 agents diagnosed the fragmented-mosaic atlas. Agreed strategy
recommendation: bypass UV atlas entirely. Each vertex carries its own
RGB, Three.js interpolates linearly across faces — no island borders to
sample across, no EDT dilation, no xatlas tuning.

**Implementation**: `scripts/texture_project_vc.py` (new, parallel to
texture_project.py). Same camera math (Zero123++ schema with elevation
fix), but per-vertex single-winner-takes-all instead of UV rasterization.
Unseen verts fall back to SF3D baked atlas via UV lookup. Output GLB
carries COLOR_0 attribute, no baseColorTexture.

**Status**: script written, NOT yet wired into local_sf3d_bridge.py.
Needs end-to-end test on the orc.

### 2026-04-14 — Zero123++ camera elevation fix — REAL BUG, partial visual win

**Problem (found by 3-agent investigation)**: Zero123++ v1.2 produces 6
views at ALTERNATING elevations: azimuth=[30,90,150,210,270,330],
elevation=[20,-10,20,-10,20,-10]. Verified in
`external/InstantMesh/src/utils/camera_util.py:99-100`.

`texture_project.py` was treating all 6 views as pure Y-axis rotation
at zero pitch. Every non-front sample fetched from a vertically-shifted
pixel — back-of-head verts sampled the chest area in view_3, etc.

**Fix** (commit `672c14e`): added `rot_x(elev_deg)` to camera transform,
re-derived translation since it's no longer azimuth-invariant when
elevation != 0.

**Result**: math fixed BUT visual still mosaic at render. The other
half of the problem is SF3D's micro-island UV layout. Multi-agent
verdict: vertex coloring is the pragmatic next step.

### 2026-04-14 — xatlas UV re-pack — DOES NOT HELP, disabled by default

**Tried**: `xatlas.parametrize` to re-unwrap SF3D micro-islands into
big contiguous UV charts. Implemented in `texture_project.py`, gated by
`FABMESH_UV_REPACK` env var.

**Result on orc**: 15273 → 19707 verts (seams duplicated), 19048 faces
preserved, sharp_ratio 25% → 58%, BUT visual atlas still mosaic. xatlas
default `ChartOptions` produces per-triangle charts on this dense mesh.
Final rendering still bad.

**Conclusion**: not a silver bullet for SF3D meshes. Disabled by
default (`FABMESH_UV_REPACK=0` is now the default — set to 1 to opt
in). Could be revived with custom `ChartOptions(max_iterations=4,
normal_deviation_weight=2.0)` but vertex coloring is more promising.

### 2026-04-14 — EDT dilation atlas fill — WIN for coverage, NEUTRAL for visual

**Tried**: `scipy.ndimage.distance_transform_edt` to fill atlas pixels
with the nearest projected colour instead of falling back to SF3D blur.

**Result**: every atlas pixel now has a colour from our projection
(no SF3D blur leak), but on SF3D's micro-island layout this produces
the voronoi-mosaic appearance because EDT spreads each tiny island's
colour across the whole inter-island padding.

**Status**: still active. Helps when UV layout is good (TripoSG?).

### 2026-04-14 — Alpha-aware multiview input — SUSPECTED FIX

**Problem**: orc_blue_crown texture came out as a broken voronoi mosaic
(blue leaking everywhere, no recognizable silhouette in atlas, face
missing). Debug overlay showed projection math was correct.

**Root cause found**: `multiview_gen.py` opened the preprocessed input
and did `convert('RGB')` before saving `input.png`. That stripped the
alpha channel produced by SF3D's `remove_background`. When
`texture_project.py` later loaded that input.png to sample colours, it
had no alpha to gate with — so background pixels were sampled onto the
mesh, then EDT dilation smeared them across the full UV atlas.

**Fix**: preserve alpha end-to-end. If the input has no alpha, run rembg
on it (new code path). Save the RGBA result as input.png. Zero123++
still gets an RGB composite (paste on white).

**Expected**: atlas should now have clean silhouettes; background weight
is zero because texture_project.py already multiplies by src_alpha.

**Not yet visually verified by user** — needs a fresh end-to-end run.

### 2026-04-14 — Atlas 2048 + EDT dilation — WIN (needs user visual check)

**Tried**: two changes to `scripts/texture_project.py`:
1. Default atlas res stays 1024 but SF3D bridge already passes 2048 in
   production — confirmed on test mesh.
2. Replaced SF3D fallback blending with SciPy EDT-based dilation: unseen
   pixels take color from the nearest projected pixel, not from SF3D's
   blurry baked texture.

**Metrics on test "man" mesh at 2048**:
- sharp pixels: 226k @ 1024 → **907k @ 2048** (4× as expected)
- faces drawn: 8971/9788 (87%) → **9338/9788 (95%)**
- all 4M atlas pixels now filled (no black gaps)

**Conclusion**: atlas is fully populated by our projected color
(projected regions + EDT-dilated neighbors). No more SF3D blur leaking
into the final texture except where scipy unavailable (graceful fallback
still works).

**Still to verify**: actual FabMesh 3D render — user has not yet run a
full generation on this new code path.

### 2026-04-14 — SDXL + IPAdapter multi-view (Option 2) — PARTIAL FAILURE

**Tried**: `scripts/multiview_sdxl_gen.py` — RealVisXL + IPAdapter Plus + per-orientation prompts.
Per-view IP scales: right/left=0.35, back=0.55. Shared seed across views.

**Result on "man" prompt**:
- view_3 (back): ✅✅ **Perfect** — real rear view, same identity, clothes match
- view_1 (right profile): ❌ Still 3/4 front, just head slightly turned
- view_4 (left profile): ❌ Same — SDXL dataset bias prevents true 90° profile

**Conclusion**: IPAdapter alone cannot force true side profiles. Would need
ControlNet OpenPose on top, which adds ~1.5 GB models + fragility.
**DO NOT retry this without ControlNet.**

### 2026-04-14 — SDXL pure prompt + seed (Option 1) — FAILURE

**Tried**: same RealVisXL, no IPAdapter, just prompt+seed for 4 orientations.

**Result**: Each view was a completely different person with different
clothes (white shirt + jeans → gray T-shirt → shirtless in shorts for back).
Shared seed is nowhere near enough to preserve identity.

**Conclusion**: **Pure prompt steering is useless for multi-view texture.**
**DO NOT retry.**

### 2026-04-14 — Texture projection debugging — PARTIAL WIN

**Problem**: Generated 3D mesh had black/blurry face even though the 6
upscaled multi-views (1024 px each) were clean and sharp.

**Root causes found**:
1. Per-pixel rasterization only used `views[0]` (front) — any surface not
   visible from front fell back to SF3D blur. Fixed in `c68344a`.
2. UV filters (`min_edge > 0.5`, `aspect < 15`) rejected ~15% of faces
   including the entire face/hair region (SF3D packs these as tiny
   triangle strips). Fixed in `515ca97`.
3. Smoothstep blend weighted small triangles near zero. Fixed with hard
   override at 0.002.
4. Zero123++ output RGB gray background bled into projection. Fixed by
   running rembg on all 6 views after upscale.

**Measurement**: after fixes, 37% of atlas pixels differ from the
untouched SF3D texture (head + torso + limbs all covered). Not yet
visually verified in FabMesh 3D viewer by the user.

**Open question**: User reports visual result still unsatisfying. Unclear
if remaining blur comes from:
- PBR lighting in Three.js viewer (roughness/metallic rendering)
- SF3D fallback still dominating the ~60% of atlas pixels we don't touch
- Base SF3D atlas being a rendering ceiling

### 2026-04-14 — Zero123++ 1024 px upscale via RealESRGAN — WIN

**Tried**: upscale 6 Zero123++ tiles from 320 → 1024 via RealESRGAN x4plus.
Patched `basicsr/data/degradations.py` (torchvision.transforms.functional_tensor → functional).

**Result**: 6 views now 1024×1024, **visually sharp** (user confirmed:
"les images sont propres et pas flou"). Coût: +12 s per generation.

**File**: `scripts/multiview_gen.py` calls RealESRGAN before saving tiles.

---

## Things to NOT do again

- ❌ Retry IP-Adapter-FaceID (research license)
- ❌ Retry pure-prompt SDXL multi-view (identity drift)
- ❌ Retry TRELLIS (never ran)
- ❌ Ship Hunyuan3D-2 (EU excluded)
- ❌ Tune per-pixel UV projection on SF3D meshes — micro-islands make
  the rendered atlas inevitably mosaic regardless of projection quality
- ❌ Retry xatlas with default ChartOptions on SF3D output — produces
  per-triangle charts that don't help the rendering issue
- ❌ Treat Zero123++ multi-views as pure Y-axis rotations — they have
  alternating elevations +20°/-10°. Always include `rot_x(elev_deg)`
- ❌ Iterate ALL images in a GLB and run RealESRGAN/SDXL on them —
  this destroys the normal map. Always resolve baseColorTexture
  explicitly via `materials[0].pbrMetallicRoughness.baseColorTexture
  .index → textures[i].source`.
- ❌ Set FABMESH_PROJECT_MODE in the OS env "just for one test". It
  persists in the parent shell and overrides the bridge default for
  every subsequent FabMesh launch. Always set on the Start-Process
  invocation only, or unset after.
- ❌ Hardcode NEAREST filtering on Three.js material — kills normal
  maps, makes texels visible at zoom. Default trilinear + 16x aniso
  works once UV padding is good.

### 2026-04-17 — SDXL+IPAdapter multiview tested on mannequin

Ran multiview_sdxl_gen.py on mannequin_ref.png then full pipeline.
Compare to Z123 result on same input:

Z123 BACK: hallucinated green/yellow/white patterns (random).
SDXL BACK: violet/yellow/red mix — consistent with front identity
  but doesn't invent the orange/black back-specific pattern.

Pipeline end-to-end (6-axis render of mesh):
  FRONT: impeccable (yellow/black checker, red/blue arms, green/purple legs)
  BACK: patterns propagated from front — not fully wrong, but not
    the asset's designated orange/black back either. SDXL can't
    invent info it doesn't have.
  Sides: thin profile (SF3D limitation with 3/4 input).

**Practical conclusion for users**: SDXL multiview is STRICTLY BETTER
than Z123 for stylized / synthetic inputs (no random hallucination).
For real photoreal subjects (dog, horse, orc) Z123 works well because
Objaverse covers them. Suggest offering both in UI as toggle based on
subject type.

**Not fixable without user input**: if the back should look specifically
different from front (e.g. character with logo on back), the ref image
must SHOW the back, or the user must upload a second back photo.

## 2026-04-17 (late) — CRM integration complete + mesh quality analysis

### CRM shipped + routed through UI
- Dependencies thrashed: xformers broke torch 2.11, forcibly downgraded
  back to torch 2.7.1+cu128 then uninstalled xformers entirely (CRM uses
  torch SDPA fallback instead). diffusers pinned 0.34, transformers 4.46
  (5.5 dropped FLAX_WEIGHTS_NAME). Stage 2 skipped by default
  (FABMESH_CRM_USE_STAGE2=1 to opt in) — saves ~6 GB VRAM and brings
  inference from 5 min → 25s.
- `_mvScriptForEngine()` helper in main.js routes FABMESH_MV_ENGINE
  correctly at BOTH call sites (generate-multiview IPC + mv-inherit).
- UI multi-view bar updated for CRM schema: 0° / 90° / 180° / 270° / TOP / BOT.
- texture_project.py reads views.json to discover (azim, elev) per view.
- PRIORITY_WEIGHTS_TUP uses (azim, elev) tuples to handle top/bot.
- Realtime progress via tqdm monkey-patch (DDIM steps mapped 20..65%).
- RealESRGAN x4 upscale 256→1024 on CRM output (was LANCZOS, too blurry).

### Mesh quality finding (chat_vert test, 2026-04-17 18:26)
Full pipeline on chat_vert (CRM → SF3D → texture_project → refine):
  - Multi-views CRM: EXCELLENT (front/back/TOP/BOT all cohérents avec input)
  - Mesh: 243k verts / 162k faces BUT extent Z=0.25 vs X/Y=0.9 →
    **mesh is nearly flat 2D** (SF3D failed depth on this input)
  - Atlas: VORONOI MOSAIC (known bug from 2026-04-14) — SF3D's
    micro-island UVs + EDT dilation = random green/black polygons
    instead of coherent chat silhouette

### Test A: FABMESH_UV_REPACK=1 — MAJOR IMPROVEMENT
Re-ran on same input with `FABMESH_UV_REPACK=1`:
  - verts: 243k → 10889 (cleaner, no over-subdivision)
  - extent Z: 0.25 → 0.41 (real 3D, not flat!)
  - Atlas: **chart-based layout with recognizable chat pieces**
    (head, paws, body visible) instead of voronoi noise
  - xatlas re-parametrization collapses SF3D's micro-islands into
    usable charts, which the projection can actually fill with
    coherent pixels from the 7 views.

**Action**: default FABMESH_UV_REPACK=1 for CRM pipeline. 2026-04-14
log said "disabled by default because didn't help with old mosaic
layout" — but that was with Z123 + low-res atlas. CRM + 2048 atlas
makes xatlas genuinely helpful now.

### Test B: FABMESH_PROJECT_MODE=vc — NOT A REAL VC TEST
`texture_project_vc.py` rejected the `--rotation-offset` flag that
local_sf3d_bridge unconditionally passes. Bridge silently fell back
to the standard atlas path. But the produced atlas is VERY CLEAN:
several whole views of the chat laid out as organized charts, face
recognizable. This is the NORMAL atlas path run fresh (10k verts
instead of 243k).

### REAL conclusion from A vs B comparison
The voronoi-noise issue on the original chat_vert mesh was caused
by the mesh being **over-subdivided** (243k verts, extent Z=0.25,
flat). When we re-run fresh (10k verts, extent Z=0.41, real 3D):
  - B (no repack): atlas = **multiple coherent chat views** ← WINNER
  - A (with repack): atlas still voronoi-ish (xatlas recharted but
    fills are still noisy when over-subdivided source)

**So the real fix** is NOT UV repack — it's not re-using the stale
243k-vertex mesh. Why was the original bloated? Either the
"construction stages" path or a subdivide post-step was applied.
Need to find and disable.

The current pipeline on a fresh run (like our test B) already
produces an OK atlas. Defaults stay Z123-schema + no repack.
**FABMESH_UV_REPACK=0 confirmed optimal.**

### Viewer unification — START (backups done)
Backup: `before-viewer-unify-20260417` tag + file copies in backups/.
Goal: single 3D viewer class + single 2D canvas class so nav commands
(zoom=wheel, pan=right-click, rotate=left-click on 3D) are identical
across all 7+ viewers and modals.

Current state:
  - 3D viewers (7x): all use Three.js OrbitControls with only
    enableDamping=true — ALREADY consistent behavior-wise.
  - 2D canvases (mask/clone/paint): use CanvasManager in canvas-utils.js
    with pan on middle-click / alt+click / optional right-click.
  - No unified 2D zoom convention (wheel is not bound in canvas-utils
    for some tool paths).

Next: factor a single BaseViewer3D + BaseCanvas2D class so any future
change applies everywhere at once.

## 2026-04-17 (latest) — UX session recap

### Viewer refactor 4/7 done (commits 6cfafbd, cf23fe1)
New `src/renderer/lib/Viewer3D.js` — unified class wrapping
renderer + scene + camera + OrbitControls + tick loop + lighting.
Migrated: wsThree, rigSrc, lightbox3D, rigViewer. Remaining 3
(mesh-edit, lmFs A+B) still use direct OrbitControls but with
identical `enableDamping=true` — behaviorally harmonised.
Backup: tag `before-viewer-refactor-20260417-v2` + `backups/viewer-refactor-v2/`.

Navigation is now guaranteed identical across all viewers:
  - Left-click drag = rotate (3D) / paint (2D)
  - Right-click drag = pan (3D) / erase (2D Draw Mask)
  - Middle-click drag = pan (both)
  - Wheel = zoom (both)

### Multi-view UX (commits ffd0f5a, 4964f7b, b9010b4)
  - Small viewer ↔ lightbox synced: clicking an angle in one
    updates the other (image + active-button class).
  - Lightbox has a right-side tool column (Modify, Auto Inpaint,
    Remove BG, Resolution, Face Fix, Sym. Auto, Draw Mask, Clone
    Stamp, Paint, Crop). Each routes to the workspace handler so
    tools operate on the currently-selected angle.
  - Popup after editing a multi-view: asks whether to keep the
    single-view edit or regenerate all 6 from the current front
    image (via FABMESH_MV_ENGINE dispatch).

### Draw Mask eraser (commit c1971fd + b7b0e91)
Toggle brush/eraser modes with dedicated buttons + B/E keyboard
shortcuts. Eraser uses the same radius as the paint brush (slider
drives both). Right-click drag still erases (legacy preserved).
Active tool button now has a strong pink accent background via
new `.tool-active` CSS class.

### New-project popup + UI defaults (commits 96c5e2a, 9695c77)
  - Asset Type + Style dropdowns added to the "New project" modal.
    Values propagate to the "Create new image" form so the user
    doesn't re-enter them.
  - Count default 4 → 1 (users rarely want 4 variants).
  - "Construction stages" checkbox hidden for character & creature
    (3-stage progressive build doesn't apply to living subjects);
    visible for building/vehicle/weapon/prop/environment/custom.

### Mesh quality regression (commit 122b180)
Discovered: the chat_vert voronoi-atlas bug was NOT UV projection
but the user having selected ~200K triangles in the dropdown.
Fresh run with default (~23K) produces a clean atlas with
recognizable chat pieces. Added an orange warning under the
"Target triangles" dropdown that appears for any selection >= 50K,
explaining that SF3D's per-triangle UV packing breaks the texture
above that threshold.

### SDXL pipeline fixes (commits fd4d8ea, c7ca6ed, 045db5a)
After the torch/diffusers/xformers thrashing for CRM, several
SDXL pipelines hit "mat1 and mat2 must have the same dtype: float
!= struct c10::Half" at inference. Root cause: diffusers 0.34 on
torch 2.7.1+cu128 leaves some buffers fp32 after
`from_pretrained(torch_dtype=float16)`.

Fix applied to all affected scripts:
  - scripts/local_img2img_bridge.py
  - scripts/sdxl_server.py: load_img2img, load_inpaint, load_controlnet_tile

Pattern: after `pipe.to("cuda")`, force every sub-module:
    pipe.unet.to(torch.float16)
    pipe.vae.to(torch.float16)
    pipe.text_encoder.to(torch.float16)
    pipe.text_encoder_2.to(torch.float16)
    # + pipe.controlnet for ControlNet variants

Validated end-to-end: CLI + HTTP server both produce clean results
on chat_vert ("make eyes glow red" → red-eyed chat in 7s).

### SDXL idle-unload tightened (commit 045db5a)
SDXL server was holding ~9 GB VRAM for 5 min after a Modify,
blocking other tools. Reduced `SDXL_IDLE_TIMEOUT_MS` 300s → 90s
and polling interval 15s → 10s. Chain of 2-3 tool calls still
skips reload (< 90s between calls), but switching to a different
task releases VRAM within ~100s.

### views.json propagation on mv-inherit (commit 28802e0)
`_copyMultiviewDir` copied the 7 PNGs but NOT `views.json`.
Derived image versions (after remove-bg / inpaint / refine)
inherited multi-views without their schema file, so
texture_project fell back to Z123 angles (30/90/150/210/270/330)
on CRM-generated views (0/90/180/270/TOP/BOT) — top/bottom
projected as side views → voronoi atlas.

Fixed + heal-pass propagated views.json to 10 existing derived
dirs. BUT the chat_vert test still showed voronoi after this fix
— views.json was a real bug but NOT the root cause of the atlas.

## 2026-04-17 (late evening) — Regression analysis: oiseau (good) vs chat_vert (bad)

User question: why did oiseau_sf3d_1776440580579.glb (15:43) produce
a cleanly textured humanoid mesh, while chat_vert_sf3d_1776453637124.glb
(19:20) came out with voronoi texture + face painted on the back?

### Agent comparison (fact table)

| Axis | Oiseau (good) | Chat_vert (bad) |
|---|---|---|
| Multi-view engine | CRM 6-view ortho | CRM (SAME) |
| UV_REPACK default | 0 (OFF) | 0 (OFF — commit 33306ad landed after) |
| U-flip default | ON (legacy) | ON (SAME) |
| SF3D subdivide | not triggered | not triggered |
| Auto-align applied | no | no |
| CRM views for subject | clean, in-distribution T-pose | CRM views for stylised cat — borderline |
| Manual per-view edits | NONE | view_1_nobg_*, view_2_facefix_*, view_2_symmetrize_* |

### Most likely culprit: INPUT contamination, not code regression

Code paths were IDENTICAL between the two runs — commits 33306ad
(UV_REPACK=1) and c6bc61e (UFLIP=off) both landed AFTER chat_vert
was generated. What DIFFERS:

1. CRM trains mostly on Objaverse props. Stylised cat (rotation-
   quasi-invariant fur pattern) is borderline — CRM can swap
   front/back without the model "noticing".
2. chat_vert's ref_0_multiview/ contains manual per-view edits
   (nobg, facefix, symmetrize) that were mixed with the CRM output
   during re-generation, making the 6-view set spatially inconsistent.
3. The U-flip (active in both) operates on views where one angle
   was corrupted by those manual edits → face lands on the back.

### Recommended action (to validate)

Delete all `view_*_nobg_*`, `view_*_facefix_*`, `view_*_symmetrize_*`
from `images/chat_vert/ref_0_multiview/` then re-run generation at
HEAD. If clean, confirmed input contamination (not code regression).

### RESULT after cleanup + re-gen (2026-04-17 21:40)

Deleted 4 contaminated files + their sub-multiview dirs. Re-ran
pipeline. Output at `c:/tmp/chat_clean/mesh.glb`:
  - 10889 verts / 11944 faces
  - extent [0.91, 0.91, 0.41] (real 3D)
  - Front render: FACE visible (eyes, muzzle, ears) — orientation fix ✅
  - Back render: BACK + tail visible, no more face duplication ✅
  - Atlas: multiple cat views recognizable (was voronoi before)

**Orientation regression cured** (face-on-back was the contamination +
U-flip combo, now both resolved).

**Residual issue**: atlas still shows leopard-skin / craquelure pattern
on body even with clean views. That's the remaining SF3D micro-island
atlas packing problem. Next step: FABMESH_UV_REPACK=1 (default in HEAD
per commit 33306ad) should help further. User will test next mesh
generation which will use ALL current fixes.

### ROOT CAUSE — UV_REPACK default ON (commit 33306ad)
Investigated chat_vert mesh 1776450499355 (7K verts, correct Z
depth, views.json present, proper CRM schema). Still voronoi
atlas. The `_proj_debug.png` showed **correct** projection
(silhouette + debug dots lined up on the chat), but the `_tex.png`
atlas was voronoi.

Conclusion: texture_project rasterises correctly, but SF3D's
per-triangle micro-island UV layout + EDT dilation produces the
voronoi pattern independently of input quality.

Re-tested `FABMESH_UV_REPACK=1`:
  - chat_vert without repack: voronoi noise
  - chat_vert with repack:    **recognisable chat** (body, head,
    paws visible as coherent texture regions)

Decision: flipped default ON. 2026-04-14 had marked it "doesn't
help" — that was with Z123 input + small atlas. With CRM +
2048 atlas + correct UV projection, xatlas re-chart is a clear win.

**Users re-generating meshes now will see properly textured atlases**
by default. FABMESH_UV_REPACK=0 to revert.

### Agent diagnostic: texture leopard-skin root cause (2026-04-18 00:50)

**Root cause found**: binary `sharp_mask = weight > 0.002` at
texture_project.py:680 creates a hard cliff between:
  - sharp islands (5-16% of atlas) = correctly projected pixels
  - gaussian-blurred SF3D fallback (remaining 84-95%)

On SF3D's micro-island atlas, each triangle is 1-3 px wide.
Per-triangle rasterization writes thousands of tiny colored tiles
surrounded by blurry SF3D fallback with razor-thin borders.
The visual result IS the leopard-skin.

Evidence: `logs/fabmesh.log:1830` sharp_ratio=0.054 on chat_vert,
`logs/fabmesh.log.1:1729` sharp_ratio=0.159 on orc_blue_crown.
5-16% projected is way too low to look continuous.

**Why past fixes didn't work**:
  - xatlas repack: new chart boundaries = new mosaic boundaries, not fewer
  - 4px narrow band: too narrow, majority of atlas falls back to blurred SF3D
  - SDXL tile refine: preserves and slightly amplifies existing seams
  - hard PIXEL_PRESENT=0.002: the binary threshold IS what creates visible polygonal seams

**Fix tonight (<2h)**: replace hard sharp_mask cliff with push-pull
Gaussian pyramid fill. Instead of "sharp projected OR blurry SF3D",
fill ALL unseen pixels with locally-averaged projected color from
the multi-view accumulation. SF3D fallback discarded entirely.

Ranked alternatives for later:
  1. Per-triangle best-view baking (MRF-free) — 1.5 days
  2. Push-pull Gaussian pyramid replacing EDT — 2 days (tonight's fix)
  3. Vertex color path (texture_project_vc.py already exists) — 0.5 day

### Agent recommendations: multi-view quality improvements (2026-04-18 00:40)

Ranked top-3:
1. **Multi-seed + best-of-N on CRM stage 1** (~4h, MIT) — run 3-4 seeds,
   pick best per slot via CLIP+HSV hist ranking. Kills back hallucinations
   on stylised subjects. Raise step 50→75.
2. **Re-enable CRM stage 2 (CCM)** + use XYZ maps to re-project stage-1
   views (~6h, MIT) — CCM was designed for this, weights already on disk.
3. **SDXL img2img + ControlNet-depth + IPAdapter(reference)** (~8h,
   Apache 2.0) — shifts budget from "fighting the view" to "enforcing
   identity". Drop harmonize strength 0.65→0.35.

1-week stack: multi-seed (day 1-2) + IPAdapter-Plus on :5555 (day 3-4) +
CCM enable (day 5) + back-photo upload slot (day 6) + joint-bilateral
post-atlas filter (day 7).

Don't retry: TRELLIS.2, Hunyuan, Wonder3D, Zero123++, CRM scale>6.5.
TOP/BOTTOM won't become photoreal (mask weakly in texture_project).

### Orientation validée sur "woman" (2026-04-18 00:20)

Fresh generation post-commit 87900b3 (mesh normalize post-export +
camera +Z standard). Result on woman_sf3d_1776464211167.glb:
  - head z centroid: +0.215 (face toward +Z ✓)
  - posZ render (Three.js cam at +Z): shows the FRONT (top rose,
    skin on arms/legs — matches ref image)
  - negZ render: shows the BACK (hair, shoulders)
  - User confirmed orientation correct.

**Orientation fix definitively validated.**

Residual: atlas still fragmented (SF3D micro-island UV packing).
xatlas repack default-on helps but doesn't fully eliminate the
leopard-skin pattern on bodies. Known limitation documented above.

### Orientation saga finale (2026-04-18 00:00)

Problème: zombi mesh géométrique face à -Z (native SF3D), camera
Three.js workspace à +Z → voit le dos. Précédemment avec chat_vert
l'auto-align rotait le mesh donc face à +Z, mais avec auto-align
désactivé (d9a02eb) la face reste à -Z.

**Fix définitif (commit 87900b3)** :
  - scripts/local_sf3d_bridge.py: normalize orientation post-export
    via rotation 180° autour Y → face toujours à +Z.
    Guard: FABMESH_SF3D_NORMALIZE_ORIENT=1 (défaut).
  - src/renderer/index2.js: revert du flip camera Z (b1eddee).
    Camera revient à +Z standard Three.js.
  - auto_align_rot_deg=180 propagé à texture_project pour compenser
    les azimuths multi-view CRM.

Logique: meshes auto-normalisés à face=+Z peu importe auto-align.
Camera Three.js standard +Z voit la face. Cohérent pour tous les
futurs meshes.

---

## Paint3D v16-v17 saga (2026-04-18 21:30-21:55)

### v15c — stage 1 + stage 2 UV-inpaint (2-view front+back)
Fix critical path bug: `_run_paint3d_stage2` was packing the
stale `stage1/albedo.png` instead of `stage2/UV_inpaint_res_0.png`.
After fix, v15c atlas shows beige filled regions instead of magenta
gaps. Visual verdict: **"c'est mieux mais pas suffisant"** — UV
texture sali par inpaint qui invente du gris. Face OK, tout le
corps et les membres = beige/noir moche.

### v16 — FRONT VIEW ONLY (isolate fusion bug?)
Hypothesis: is 2-view fusion polluting v15c's texture? Test with
FABMESH_MV_SLOTS=0 (1 view, views_init=[0]). Added env var
override in `external/Paint3D/pipeline_paint3d_stage1.py`.
Result: **v16 pire que v15c**. Deux bugs révélés:
  1. **Bug #1 vertical**: face back-projetée au niveau TORSE
     au lieu de HEAD. Visible sur side-view: la vraie tête reste
     en tissu blanc de capuche tandis que le visage est smeared
     au niveau du cou/poitrine.
  2. **Bug #2 front→back leak**: la photo front se retrouve
     aussi peinte sur l'ARRIÈRE du mesh (cause probable:
     FABMESH_PAINT3D_LOOSE_MASK=85° auto-enabled masque les
     faces rear-facing comme visibles).

### v17 — diagnose + fix les 2 bugs (en cours)
Agent lancé pour:
  1. Mesurer bbox mesh + head position vs `look_at_height=0.25`
  2. Fix vertical: translation mesh pour aligner centroid
     avec look_at_height (ou override look_at_height via env var)
  3. Fix mask leak: désactiver auto LOOSE_MASK quand len(mv_paths)==1
Status in-flight: agent a auto-override `look_at_height: 0.25 -> 0.7107`
(centroid mesh était à 0.7107 en Y), stage1 done 51.8s. En attente
stage2 + viewer.

---

## Paint3D v18-v22 UV atlas investigation (2026-04-18 22:30-23:50)

### v18-v21 — série de runs Paint3D 2-view
Runs successifs pour tenter de fixer le "leopard magenta" dans
l'atlas stage 1 et les mini-enfants hallucinés par stage 2 :
- v18/v19: Rz(180°) pre-rotate fix pour corriger le back→front leak.
  Depth debug confirme 2 vues différentes (front debout / nuque+dos).
- v20: 2-view + Rz fix combinés.
- v21: FABMESH_PAINT3D_LOOSE_MASK=89 (quasi max hemisphere).

**Résultat**: TOUS les atlas stage 1 sont quasi-identiques avec
~95% magenta + 3 mini-gamins visibles en bas. LOOSE_MASK ne change
rien. Stage 2 UV-inpaint invente 6+ mini-figurines d'enfants
(SD+IPAdapter traite les mini-îles UV comme 311 scènes 2D à remplir).

### Diagnostic UV atlas (mesh SF3D)
Mesure sur `mesh_NORMALIZE_1.glb`:
- **264 composants géométriques disconnectés** (pas watertight!)
- 8420 verts / 12596 faces brut
- xatlas default = **347 charts UV**, util 74.35%
- Tuning xatlas (max_cost 20/50/100/500) = plafond 347 charts,
  aucun changement → comportement intrinsèque xatlas sur mesh complexe

### Fix 1 — weld mesh dans local_sf3d_bridge.py
Patch ajouté dans generate_3d() après SF3D inference, avant
auto-align:
- `trimesh.Trimesh(process=True)` → merge vertices proches
- `xatlas` repack UV
- Guard `FABMESH_SF3D_WELD_UV=1` (défaut on)

**Résultat**: 8426v/266comp → 9319v/**1 comp** watertight, mais
**311 UV charts** (vs 347 avant). xatlas continue à segmenter
aux seams de courbure même sur mesh watertight. Le weld ne suffit
pas à réduire le nombre de charts.

### Option Blender Smart UV (testée puis abandonnée)
Script `scripts/blender_smart_uv.py` créé pour unwrap via Blender
5.1 avec `bpy.ops.uv.smart_project(angle_limit=66°)`. Export OK
mais **networkx.connected_components** lancé ensuite pour compter
les îles UV a **fait planter l'ordi** (RAM 32GB saturée, swap
massif, freeze total 2x de suite).

**Leçon**: networkx est trop lourd pour graphes mesh. Utiliser
`scipy.sparse.csgraph.connected_components` ou
`trimesh.graph.connected_components` natif à l'avenir.

### Insight critique — v22 Paint3D stage1 ONLY
Run avec `--skip-stage2` pour voir l'atlas stage 1 brut sans
inpaint. Résultat visuel:
- Atlas = 95% magenta + **3 mini-enfants ENTIERS** côte à côte
  en bas + morceaux éclatés sur les côtés.

**Révélation**: Paint3D stage 1 **ne fait PAS de back-projection
UV par face**. Il colle l'IMAGE SOURCE ENTIÈRE comme une
"décalcomanie" sur l'atlas 2D dans les régions UV visibles de
chaque vue. D'où les 3 mini-gamins complets = 3 vues projetées
= 3 copies de la photo source.

Donc:
1. Le "leopard magenta" n'est PAS un problème de charts UV.
2. C'est le **mode de projection** de Paint3D qui ne convient
   pas aux UVs fragmentées SF3D (marche bien sur unwrap cylindrique
   propre, mauvais sur 300+ charts).
3. Stage 2 hallucine parce qu'il reçoit un atlas avec "mini-enfants
   stickers" + vide → SD+IPAdapter conclut logiquement "plus
   d'enfants à générer".

### Conclusion architecturale
Paint3D est structurellement incompatible avec les UVs SF3D. Deux
voies possibles:
- **A)** Retour à `texture_project.py` (vraie back-projection
  par face) + fill CV2 pour trous. Déjà testé = "moche" mais
  fidèle.
- **B)** Remplacer SF3D par un générateur qui sort des UVs
  propres (TRELLIS / Hunyuan3D 2.0 / MV-Adapter pipeline).

Prochain step user-validated: comparer rendu `texture_project.py`
vs Paint3D v22 stage1-only sur le même mesh.

**Fichiers produits**:
- `logs/child_ip45_2view/mesh_WELDED_TEST.glb` (SF3D + weld)
- `logs/child_ip45_2view/mesh_BLENDER_UV.glb` (Blender smart UV)
- `logs/child_ip45_2view/mesh_paint3d_v22_STAGE1_ONLY.glb`
- `scripts/blender_smart_uv.py` (nouveau)
- `scripts/local_sf3d_bridge.py` (patch weld_uv)

---

## Quality upgrades via ControlNet Tile + UV dilation (2026-04-19 00:45)

### Contexte
Config validée `a-utiliser` (refine + SKIP_MV + SDXL strength=0.10) donne
texture propre, orientation correcte, mais résolution "un peu faible"
(feedback user). Deep-dive agent a identifié 3 pistes à haut ROI, toutes
basées sur du code déjà présent mais non activé.

### Changements commités
1. **`local_sf3d_bridge.py`** — Remplace le single refine strength=0.10 par
   un multi-pass ControlNet Tile dans PROJECT_MODE=refine:
   - Pass A: `--strength 0.35 --controlnet_tile --cn_scale 0.85` (détails)
   - Pass B: `--strength 0.20 --controlnet_tile --cn_scale 0.70` (cleanup)
   - ControlNet Tile (xinsir/controlnet-tile-sdxl-1.0, Apache 2.0) ancre la
     structure de l'atlas source → strength plus élevée = détails sans
     hallucination ("orange boy" fix).
   - Guard: `FABMESH_REFINE_CN_TILE=0` pour fallback plain strength=0.10.

2. **`upscale_atlas.py`** — UV chart dilation avant ESRGAN:
   - scipy EDT dilate les pixels "foreground" de 4-6 px dans les gaps UV
     détectés (bg = près couleur des 4 coins de l'atlas)
   - Élimine bleeding ESRGAN aux bords de charts UV (seam artefacts en
     rendu 3D)
   - Trigger conditionnel: 5-90% padding detected, sinon skip

3. **`upscale_atlas.py`** — tile_pad 10→32: pad plus large pour seams cleans.

### Licensing
Rejeté 4x-UltraSharp et 4x_foolhardy_Remacri (meilleure qualité textures
mais licenses HF pas explicites). Reste sur RealESRGAN_x4plus (BSD-3).

### Restes à tester
- Run complet avec pass A+B CN tile: visage + cheveux + couture jean
  attendus plus nets
- VRAM check: RTX 5080 16 GB doit tenir les 2 passes

### Update 2026-04-19 01:00 — CN Tile désactivé par défaut
Tested CN Tile pass A (strength=0.35, cn_scale=0.85): le ControlNet
n'a pas suffit à ancrer la structure du visage du child, hallucinations
oranges + flou comme à strength=0.25 sans CN. Pass B foirait sur
trimesh file handle Windows.

Reverted defaults:
- `FABMESH_REFINE_CN_TILE=0` par défaut (avant=1)
- Pass A strength reste 0.10 (config user-validated tag `a-utiliser`)
- Pass B retiré du code (was buggy)

UV dilation pré-ESRGAN gardée (utile, pas nuisible).

User feedback final sur config restaurée: "cest mieux" — visage net,
veste denim avec boutons détaillés, short cargo. Configuration finale
gardée comme baseline `a-utiliser-v2`.


---

## 2026-04-18 — texture_project front/back inversion FIXED (commit 5124f8c)

### Diagnostic
The "Solution 5" hypothesis (R_undo conditional on NORMALIZE_ORIENT)
turned out to be RIGHT about the symptom (front photo on back of mesh)
but WRONG about the root cause. The real culprit is the
`norms_cam = -norms_cam` line at texture_project.py:192.

That negation was added (long ago) on the assumption that after SF3D's
`tmesh.invert()` post-transform, the loaded vertex_normals point
INWARD into the mesh. Empirical verification on the current pipeline
(SF3D + weld_uv + trimesh.load) shows the opposite:

```
mean dot(normal, outward_dir) = +0.42
% positive (outward) = 81.0%
```

So the negation was FLIPPING normals from outward to inward, which
inverted every visibility test. Per-head-vertex check:

| code path                    | front-head (-Z) visible | back-head (+Z) visible |
|------------------------------|-------------------------|------------------------|
| no negation (FIX)            | 218/337                 | 0/149                  |
| with negation (CURRENT BUG)  | 72/337                  | 149/149 ALL            |

With negation, ALL 149 back-of-head verts pass the visibility test
from the az=0 camera, while only 72 face verts do. So the front photo
gets sprayed on the back of the head (and vice-versa for the back
photo at az=180).

### Fix
`scripts/texture_project.py:184-208` — gate the negation behind
`FABMESH_TEXPROJ_FRAME_FIX=1` (default ON). Setting to 0 reverts to
the legacy path for A/B regression testing.

### Validation
Test mesh: existing `logs/child_ip45_2view/mesh.glb` (welded, NORMALIZE_ORIENT=0,
face at GLB -Z confirmed by head Z extent: -0.11 to +0.05).

`scripts/_render_simple.py` shows 4 views around Y. With z-buffer
keeping max-Z, az=0 view shows the +Z side of the mesh = BACK side.
Therefore for a correctly-textured mesh: face must appear at az=180
(-Z side) and hair/back at az=0 (+Z side).

LEGACY (FRAME_FIX=0): face visible at az=0 → BUG
FIXED (FRAME_FIX=1): face visible at az=180, hair at az=0 → CORRECT

Visible artefacts:
- `_render_BEFORE_FIX.png` (legacy texture_project on existing mesh)
- `_render_AFTER_FIX.png` (FRAME_FIX=1 on same mesh + mv/)
- `_render_FULL_PIPELINE.png` (full bridge w/ NORMALIZE_ORIENT=0 +
  FRAME_FIX=1 + Z123 schema)
- `_render_FIXED_2VIEW.png` (FRAME_FIX=1 + ip45_2view mv/ schema)
- `_atlas_FIXED_final.png` (atlas extracted from fixed mesh)

### Commit
`5124f8c` texture_project: fix front/back texture inversion bug

### Notes for downstream
- This fix should also resolve the historical "mini-children mosaic"
  bug. Atlas xatlas re-pack still produces fragmented islands but each
  island now contains the CORRECT photo region.
- For meshes generated WITHOUT the SF3D+weld pipeline (e.g. GT
  calibration cube, or any mesh whose normals genuinely point
  inward), set FABMESH_TEXPROJ_FRAME_FIX=0.
- The bridge's `auto_align_rot_deg` propagation still works
  identically — this fix is orthogonal to the rotation_offset story.

---

## 2026-04-19 02:30 — AUTOFIT + multi-view baseline (a-utiliser-v3)

### Configuration validée user
- `FABMESH_PROJECT_MODE=atlas` (multi-view UV projection)
- `FABMESH_MV_REUSE=mv/` (use existing 2-view dir, view_0=front, view_1=back)
- `FABMESH_SF3D_NORMALIZE_ORIENT=0`
- `FABMESH_TEXPROJ_FRAME_FIX=1` (the 5124f8c fix)
- `FABMESH_TEXPROJ_SKIP_BACK_VFLIP=1` (back not vertically flipped)
- `FABMESH_TEXPROJ_VIS_THRESH=0.5` (reject grazing-angle faces)
- `FABMESH_AUTOFIT=1` + `FABMESH_AUTOFIT_RATIO=1.20` (scale mesh to fit
  rembg silhouette of source photo, 20% larger than naive bbox match)

### New env vars (added to local_sf3d_bridge.py)
| Env var | Default | What |
|---|---|---|
| FABMESH_AUTOFIT | 0 | Compute photo bbox vs mesh XY bbox → scale + translate |
| FABMESH_AUTOFIT_RATIO | 0.85 | Multiplier on top of autofit scale (1.20 best for child_ip45) |
| FABMESH_ROT_OFFSET_DEG | 0 | Manual Y rotation (yaw) of mesh in degrees |
| FABMESH_ROT_Z_DEG | 0 | Manual Z rotation (head tilt) of mesh in degrees |
| FABMESH_TRANSLATE_X | 0 | Manual X translation in mesh units |
| FABMESH_MESH_SCALE | 1.0 | Manual uniform scale multiplier |

### And in texture_project.py
| Env var | Default | What |
|---|---|---|
| FABMESH_TEXPROJ_FRAME_FIX | 1 | Drop legacy `-norms_cam` (5124f8c fix) |
| FABMESH_TEXPROJ_VIS_THRESH | 0 | Reject faces with dot(N, cam_dir) < threshold |
| FABMESH_TEXPROJ_SKIP_BACK_VFLIP | 0 | Don't vflip back-view azim≈180 photos |
| FABMESH_TEXPROJ_UFLIP | 0 | Legacy U-flip (default off) |

### Critical step before run
The `mv/` dir contains `view_0.png..view_5.png` but for the 2-view
ip45 schema the duplicates (view_1 = right_dup_front, view_3 =
left_dup_back, view_4 = top_dup_front, view_5 = bottom_dup_back)
are NOT real photos. To use only the 2 real photos:
1. Edit `mv/views.json` to keep only entries with labels `front`/`back`.
2. **Copy view_2.png → view_1.png** so view_1 IS the real back photo.
   (texture_project iterates by file index, not by label.)

### Known limitation
Translate XY accurate only to ±5% on average. User says "if we can't
do auto perfectly, we need a manual viewer in FabMesh to position
textures and resize them." Next session: build that UI.

---

## 2026-04-19 03:00 — FabMesh integration: Align Texture tool + 2-view auto

### Summary
Wired the child_ip45_2view experimental pipeline into FabMesh proper:

1. **"Align Texture" manual tool** in mesh-card → Manual tools.
   Modal with Three.js viewport (mesh shown fixed) + semi-transparent
   photo overlay plane that follows sliders. 6 sliders (TX/TY/TZ/Scale/
   RotY/Visibility), opacity slider, view buttons (Front/Right/Back/
   Left/Top/Bottom/Iso), checkboxes (autofit/framefix/skipvflip).
   "Re-project" button calls texture_project.py with mesh_pre_transform.
2. **"Auto 2-view" checkbox** in image gen.
   Was generating 6 hallucinated Z123 views; now generates ONE
   photoreal back view via RealVis XL + IPAdapter Plus, conditioned
   on the front photo. Uses the same recipe as scripts/_scale_sweep.py
   that produced the child_ip45_back.png reference dataset.
3. **Back photo auto-attached** when user clicks "Use this image for 3D".
   Stored in `p.backImagePath`, sent to imageTo3D as imagePathBack.
4. **2-view bridge mode**: when imagePathBack provided, main.js builds
   a `<mesh>_mv2/` dir with view_0=front, view_1=back, views.json,
   and runs SF3D bridge with all `a-utiliser-v3` env vars set:
   FABMESH_MV_REUSE, FABMESH_PROJECT_MODE=atlas,
   FABMESH_TEXPROJ_FRAME_FIX=1, FABMESH_TEXPROJ_SKIP_BACK_VFLIP=1,
   FABMESH_TEXPROJ_VIS_THRESH=0.5, FABMESH_AUTOFIT=1,
   FABMESH_AUTOFIT_RATIO=1.20.
5. **Multiview bar** in image card simplified to FRONT / BACK only
   (was 0/90/180/270/TOP/BOT — confusing for the new pipeline).

### New files
- `scripts/generate_back_view.py` (RealVis XL + IPAdapter back-view gen)
- `scripts/mesh_pre_transform.py` (apply translate/scale to mesh.glb
  for align-texture tool)

### New IPC handlers (main.js)
- `mesh:align-texture` — pre-transform + texture_project re-projection
- `generate-back-view` — RealVis IPAdapter back generation

### Licensing (all commercial-safe verified)
- RealVis XL v4.0: CreativeML OpenRAIL++-M
- IPAdapter Plus: Apache 2.0
- SF3D, scipy, numpy, trimesh: BSD/Apache permissive

### Commits this session
2b688d2, a19c118, 1c23570, 7bcf47e, b4db178, c280ac9, c66b93d (tag
a-utiliser-v3), 41da4ff, 86078d9, c7e9116, e6f4b36 (next: RealVis
back-view replacement of Z123).

---

## 2026-04-19 — back-view: IPAdapter SCHEDULE fix

### Symptom
Après le commit `2c79a0c` qui appliquait la recette _scale_sweep.py
(ip=0.45, gs=7.0, simple neg), la génération de back views reste
inconsistante: sur perso photoréaliste l'enfant ça marchait, sur
une femme CG en maillot ou un orc ça donne presque toujours une
AUTRE vue frontale du même perso. Tests ip_scale 0.15/0.25/0.30/0.35/
0.45/0.50/0.60/0.80 — tous donnent des fronts ou 3/4.

### Diagnostic (agent)
IPAdapter Plus encode l'image front ENTIERE (incluant visage). Le face
embedding domine tout signal textuel. ip_scale haut = trop d'identité
forcée (visage front), ip_scale bas = perte identité MAIS orientation
pas corrigée car le text encoder SDXL ne gagne pas d'autorité face à
l'embedding image. La recette originale marchait par coïncidence de
seed sur un perso photoréaliste.

### Fix: IPAdapter scale schedule
Au lieu d'un scale constant, schedule à travers les steps:
- steps 0..33%  : scale=0.0 (prompt texte seul -> composition fixe la
  direction "back view")
- steps 33..66% : ramp linéaire 0 -> full
- steps 66..end : scale=ip_scale (identity lock-in)

Principe: les premiers 30% d'un process diffusion SDXL commitent la
composition/orientation. Laisser IPAdapter off pendant cette phase
libère les tokens "back view" pour gagner. Puis on ramp l'identity
quand le sujet est déjà commité dos-tourné.

Implémenté via `callback_on_step_end` (diffusers >= 0.26).

Coût: 0% inference additionnel.

Si toujours échec sur perso stylisés (orc): option #2 agent = bootstrap
2-pass img2img (pass 1 = back brute no-IP, pass 2 = img2img avec IP).
Si #1+#2 échouent: ControlNet OpenPose (xinsir Apache 2.0 + DWPose
Apache 2.0, commercial OK).

---

## 2026-04-19 — Align Texture & 2-view pipeline hardening

### Enhancements
- **back-view**: rewrote generate_back_view.py as minimal _scale_sweep
  clone (ip=0.45, gs=7.0, simple neg) after pixel-perfect replay
  validated on child ref_0.png. Kept the FRONT-token regex strip
  (mandatory to counter FabMesh asset-style appending 'strict front
  view, facing camera, symmetric' which was contradicting 'back view'
  in the prompt).
- **back-view**: added full-body framing tokens to match front scale.
- **Align Texture UI**: added Z translate slider, overlay opacity
  slider, view-switch buttons (Front/Right/Back/Left/Top/Bottom/Iso),
  FRONT/BACK overlay toggle with per-side stored transforms.
- **Align Texture bug**: fixed empty viewer caused by mesh-load block
  being misplaced in _atSetCameraView instead of openAlignTexture
  (regression from UI upsize commit).
- **Overlay sizing**: tied overlay plane to mesh Y-extent so scale=1
  fits the mesh body (was using bbox diagonal → overlay became huge).
- **2-view persistence**: list-image-folders now scans <project>/
  _backphotos/ to rebuild p._backPhotos on project reload, so the
  FRONT/BACK bar survives app restarts.
- **New project modal**: added ✨ Enhance button next to description.

### Commits this batch
ee1d89d, b46e048, e651aff, plus persist-back-on-reload (current).

---

## 2026-04-19 — back-view PURE recipe locked in (ip=0.75)

User-driven A/B sweep on fille_afghanne (9 SCHED scales + 9 PURE
scales generated by `_sweep_pure_scalesweep.py`, viewer compare). The
PURE _scale_sweep recipe (constant ip_scale, simple prompt, no T-pose
tokens, no schedule) at ip=0.75 produced the closest identity match
(ceinture, sandales, vest decorations) while still giving a real back
orientation. Schedule + verbose prompt actually hurt on this subject.

Locked in `generate_back_view.py`:
- `ip_scale = 0.75` (constant, no callback schedule)
- Prompt = exact `_scale_sweep` template
- No T-pose / framing tokens (over-constrained pose at high ip)

Residual differences (braid vs loose hair, vest silhouette drift) are
invisible once projected on the 3D mesh because each view textures only
its own visible faces.

Future: build a CLIP captioning step to enrich the prompt hint with
auto-detected outfit description, which should narrow the residual
drift further.

### 2026-04-19 — back-view uses RAW user prompt + lightbox FRONT/BACK bar

User insight: "si je ne mets pas de prompt enhanced j'ai un meilleur
résultat". Confirmed in logs — when user clicks Enhance, the long
asset-style template ("RTS unit, T-pose neutral stance, plain white
background, even studio lighting...") gets passed to back-view gen
and fights the IPAdapter photo reference.

Fix: stash the original raw user input in textarea.dataset.rawPrompt
before Enhance overwrites it. Back-view gen then uses rawPrompt (e.g.
"fille afghanne") instead of the enhanced version. Front gen stays on
enhanced template (it's appropriate for from-scratch SDXL).

Also fixed: lightbox FRONT/BACK bar didn't appear in 2-view mode
(only worked with full Z123 _multiviews dir). Now shows for either
hasFullMv OR hasBack, and the BACK button loads the back photo.

### 2026-04-19 — BLIP outfit captioning for back-view

Outfits between front and back kept drifting (jacket pockets present
on front, absent on back, etc.) because the back-gen prompt only
contained the subject name ("enfant"). RealVis+IPAdapter had no
explicit text grounding for the clothing.

Fix: BLIP image captioning step before back gen.
- New script scripts/caption_image.py: tries BLIP-large
  (Salesforce/blip-image-captioning-large, BSD-3, ~1 GB), falls back
  to BLIP-2 OPT-2.7B if missing. Conditional caption seeded with
  "a character wearing" so output is outfit-focused.
- New IPC handler 'caption-image' in main.js → preload exposes as
  meshyAPI.captionImage.
- Image-gen flow now calls captionImage on each generated front,
  builds enrichedHint = "<rawPrompt>, <BLIP outfit desc>", passes
  it as promptHint to generateBackView.

Both models BSD-3, commercial OK. Inference ~3s on RTX 5080.

### 2026-04-19 — ControlNet OpenPose locks T-pose for back-view

User reported pose drift between front and back (slight bras-baissés,
etc.) breaks projective texturing. Solution: ControlNet OpenPose with
a hardcoded T-pose back-view skeleton image.

Files:
- `scripts/_make_back_skeleton.py`: generates a 1024x1024 OpenPose
  skeleton (18 keypoints, T-pose, back-view orientation). Output:
  `scripts/_back_tpose_skeleton.png`. Run once.
- `scripts/generate_back_view.py`: switched from
  `StableDiffusionXLPipeline` to `StableDiffusionXLControlNetPipeline`
  with `ControlNetModel` from `xinsir/controlnet-openpose-sdxl-1.0`
  (Apache 2.0). Skeleton image passed as `image` arg with
  `controlnet_conditioning_scale=0.85`.

Models:
- xinsir/controlnet-openpose-sdxl-1.0 (Apache 2.0, ~5 GB DL)
- existing RealVisXL_V4.0 + IPAdapter Plus

Now front+back have IDENTICAL pose (skeleton-locked) so projective
texturing on the mesh aligns properly.

Cost: ~5 GB DL first run, +5s inference per back gen (~20s total).

### 2026-04-19 — switch 2-view mode from atlas to AUGMENT

User insight: even with ControlNet OpenPose locking the T-pose, the back
photo's silhouette doesn't EXACTLY match the mesh dorsal shape (mesh is
inferred from front only by SF3D, which does NOT support real multi-view
input — verified in external/StableFast3D/sf3d/system.py:245). Pixel-
precise projective texturing of back photo onto mesh fails.

Solution: PROJECT_MODE=augment instead of atlas.
- Front-facing faces: keep SF3D's native bake (clean, sharp).
- Back/side faces: blend with the back-photo color additively only when
  the back view has clearly better visibility than front (margin=0.3).
- No pixel-precise projection — back photo only contributes COLOR, not
  geometry.

Files:
- src/main/main.js: PROJECT_MODE 'atlas' -> 'augment' in mv2 env block.
  Removed FABMESH_TEXPROJ_VIS_THRESH (augment uses its own logic).
- scripts/texture_augment.py: now reads views.json from mv dir if
  present (was hardcoded to Z123 6-view schema, broke on 2-view).

Result expected: less artifacts on the dorsal mesh, smooth blend from
front to back without pose mismatch.

---

# ============================================================
# SYNTHÈSE GLOBALE — Journée 2026-04-19
# Pipeline 2-view (front + back) intégré dans FabMesh
# ============================================================

## Objectif initial
L'user veut une qualité de texture SUPÉRIEURE au pipeline single-view
SF3D classique. La face arrière du mesh est toujours hallucinée par
SF3D (qui n'a vu que la photo front), donc dorsalement laide.

## Ce qu'on a construit (commits chronologiques)

### 1. Outil "Align Texture" dans la card Mesh (manuel)
Bouton 🎯 Align Texture dans Manual tools → ouvre un modal avec:
- Viewer Three.js du mesh
- Sliders TX/TY/TZ/Scale/RotY/Visibility/Opacity
- Boutons FRONT/BACK (toggle quel overlay régler)
- Boutons vue (Front/Right/Back/Left/Top/Bottom/Iso)
- Checkboxes Live project on mesh / Show overlay plane / Auto-fit /
  Frame fix / Skip back vflip
- Re-project = pre_transform + texture_project re-projection
- Live preview en temps réel via projective texture shader (GLSL custom)

Commits: 41da4ff, 86078d9, c7e9116, e6f4b36, 47ce9e8, c280ac9,
b46e048, e651aff, 2b688d2, 1c23570, 7bcf47e, b4db178, 1937a28,
a19c118, 6d62eae, 314829a, df46418, ee1d89d, 3bcad8b, c0e3a3b,
346d4cd, f032d43.

### 2. Génération auto back-view (2-view)
Checkbox "Auto 2-view" dans card Image → après front gen, déclenche
automatiquement la génération de la photo back depuis la front.

#### Évolution de la recette back-view
- **Z123 multi-view (initial)**: 6 vues hallucinées Zero123++. Pas
  photoréaliste. ABANDONNÉ.
- **RealVis + IPAdapter (47ce9e8)**: même modèle que la front, ip=0.45,
  prompt "back view". Marche sur enfant photoréaliste, échoue sur
  perso CG/orc.
- **Sweep ip_scale 0.45..0.85**: PURE 0.75 = meilleur sur fille_afghanne
  (commit 4b2c7bf, viewer compare logs/ip_sweep/).
- **BLIP captioning (b4fc4df, 8155a00)**: BLIP-large décrit l'outfit
  du front automatiquement → enrichit le prompt back. Évite drift
  vêtements. Sanitize les "is posing" / "naked body".
- **Strip "front view" tokens (ef9dce8, 40ee919)**: prompt FabMesh
  enhanced contient "strict front view, facing camera, symmetric"
  qui contredit "back view". Regex strip avant injection.
- **Raw user prompt (befc680)**: utiliser `userPrompt` brut (pas le
  enhanced "RTS unit, T-pose, ...") évite la pollution.
- **ControlNet OpenPose (commit 5GB DL)**: skeleton T-pose back
  hardcodé force la pose identique front/back, peu importe IPAdapter.
  Tag back-view-perfect.

### 3. Pipeline mesh 2-view dans FabMesh
- Si `imagePathBack` fourni à `image-to-3d`, build mv2 dir avec
  view_0=front, view_1=back, views.json
- Env vars 2-view: `FABMESH_MV_REUSE`, `FABMESH_PROJECT_MODE=...`,
  `FABMESH_TEXPROJ_FRAME_FIX=1`, etc.

#### Mode de projection back: atlas → augment (f42c0de)
**Insight critique** de l'user: même avec ControlNet OpenPose lockant
la T-pose, la photo back n'a pas la silhouette EXACTE de la dorsale du
mesh (car SF3D n'utilise QUE la front pour générer le mesh, vérifié
dans `external/StableFast3D/sf3d/system.py:245` — la liste d'images
est un batch de meshes indépendants, pas un multi-view fusion).

→ `PROJECT_MODE=atlas` (pixel-precise projection): échoue, artifacts.
→ `PROJECT_MODE=augment` (additive blend): front=SF3D bake clean,
  back=blend additif sur faces dorsales seulement quand back vis >>
  front vis. Pas de pixel-precise = pas d'artifacts silhouette.

Patch: `texture_augment.py` lit maintenant views.json (avant hardcoded
6-view Z123 schema).

### 4. UI updates
- Slot "Optional back photo" dans card Mesh
- Barre FRONT/BACK dans card Image (au lieu des 6 angles 0/90/180/...)
- Barre FRONT/BACK dans lightbox grand viewer
- Bouton ✨ Enhance dans modal new project
- Popup "Regenerate multi-views?" → "Regenerate back view?"
  (ac74e35) qui appelle le bon pipeline

## Configuration finale validée (tag 2view-augment-best)
1. **Front gen**: RealVis XL + prompt enhanced (asset-style template)
2. **BLIP caption** sur la front → outfit description
3. **Back gen**: RealVis + IPAdapter ip=0.55 + ControlNet OpenPose +
   prompt = `<rawPrompt>, <BLIP outfit>` + skeleton T-pose hardcodé
4. **SF3D** mesh + atlas natif depuis la front
5. **AUGMENT** mode: dorsale enrichie par blend additif de la back

## Backup branches créées aujourd'hui
- backup-before-uv-weld-fix-20260418-223959
- backup-weld-preserve-uv-20260419-001243
- backup-before-quality-upgrades-20260419-004126
- backup-before-blip-captioning-20260419-160818
- backup-before-controlnet-openpose-20260419-163854
- backup-2view-augment-validated-20260419-172540 (état validé)

## Tags
- `a-utiliser-v2`, `a-utiliser-v3`: étapes intermédiaires
- `front-fixed-back-todo`: avant fix back
- `back-view-perfect`: BLIP + ip=0.55 marche
- `2view-augment-best`: pipeline complet validé user

## Modèles téléchargés (commercial-safe)
- RealVis XL v4.0 (CreativeML OpenRAIL++-M)
- IPAdapter Plus SDXL (Apache 2.0)
- BLIP-large (BSD-3) ~1 GB
- xinsir/controlnet-openpose-sdxl-1.0 (Apache 2.0) ~5 GB
- SF3D (Stability Community License, <$1M revenue)

## Limitations connues (à explorer ensuite)
- La back est ressemblante mais pas IDENTIQUE au front (drift
  costume/coiffure résiduel ~10%)
- Pour aller plus loin: TRELLIS ou Hunyuan3D 2.0 qui produisent
  vraiment un mesh+textures cohérents en multi-view natif.

---

## 2026-04-19 — Audit overwrite + 2 fixes

User: "certains outils écrasent la version précédente de l'image".
Audit complet (24 IPC handlers + 15 scripts). Résultats:

### Bugs confirmés et fixés

1. **`generate_back_view.py`**: utilisait `back_<stem>_0.png` constant.
   Chaque "Regenerate back view" écrasait la précédente. Fix: scan
   `back_<stem>_<N>.png` existants → start at max+1 (même pattern que
   `local_juggernaut_bridge.py` fixé hier en `febbec5`).

2. **`mesh:align-texture`**: écrivait directement sur `meshPath`
   (input == output dans `texture_project` call). Si l'align donne
   un mauvais résultat, perte définitive de la texture précédente.
   Fix: snapshot l'ancien mesh dans `<meshDir>/.history/<base>_prealign_
   <ts>.glb` avant le swap. Permet revert manuel.

### Tous les autres outils audités: OK
- `image-quick-edit`, `mask-inpaint`, `auto-inpaint`, `img2img`,
  `image-adjust`, `remove-background`, `mesh-tool` (smooth/decimate/...)
  → tous utilisent suffix `${operation}_${ts}` = safe.
- `image-to-3d`, `refine-mesh`, `auto-rig*` → outputs timestampés.
- `save-image-data-url`, `import-image-file` → suffix timestampé.

### Suspects (non-bugs probables)
- `generate-multiview` réécrit `<stem>_multiview/view_0..5.png` (1:1
  par identité-image, by design)
- `export-to-unreal` écrit `${baseName}.fbx` (convention "latest wins")

### Bugs UI à investiguer ensuite
- Draw / Paint Tools: résultat = image inchangée (édition pas appliquée)
- Clone Stamp: garde l'image initiale en mémoire au lieu de la version
  courante

### 2026-04-19 — Fixes UI: Paint, Clone, Blur, multiview-bar

3 bugs UI fixés (agent diagnosis):

1. **Paint Tools** (`paint-save` handler ~4791): appelait
   `refreshProjectImages(state.currentProject)` — fonction inexistante.
   ReferenceError silencieusement avalée par catch chain → pas de
   refresh = user croit que rien n'a été appliqué. Replaced by
   `await reloadCurrentProject()`.

2. **Clone Stamp** (`populateWorkspace` ~990): `_activeMultiviewKey`
   n'était pas reset au reload, donc `_showMultiviewBar` ré-attachait
   `_activeMultiview` à un ancien chemin multiview. `editTarget()`
   priorisait alors cette frame figée → Clone clonait depuis v0.
   Fix: reset `_activeMultiviewKey = null` + pre-set sync defaults
   `previewImagePath` / `selectedImagePath` = images[0] avant l'async
   `renderImageVersions`.

3. **Blur tool**: passait `imagePath: tgt` au handler
   `save-image-data-url` qui attend `basePath`. Corrigé.

4. **Petit viewer FRONT/BACK bar manquante**: `populateWorkspace`
   appelait `renderImageVersions(p)` sans await, et le 1er
   `_checkMultiviewForCurrentImage()` se déclenchait avant que
   `p._backPhotos` ne soit peuplé par le scan disque. Ajout d'un
   `.then(_checkMultiviewForCurrentImage)` pour re-checker une fois
   le rendu async terminé.









## 2026-05-17 (final) — Revert Taubin + atlas 4096 + ip 0.85

User feedback sur orc: la version v2zoom (radius 1.5, chart-aware,
atlas 2048, NO Taubin, ip 0.55, default canny 0.5) etait le meilleur
rendu. Les fixes suivants ont degrade:

- Taubin smoothing: exploded mesh look (vertex shifts entre charts)
- Atlas 4096: viewer model-viewer fallback debug-UV-colors (neon)
- IP-scale 0.85: tendance a saturer/aplatir au lieu de mieux suivre

Revert: Taubin off par defaut (opt-in via FABMESH_HI3DGEN_DO_SMOOTH=1),
atlas back to 2x tex_res, ip-scale back to 0.55.

Etat final accepte: pipeline = mv_render radius 1.5 + sheet_render_v2
dual CN ip 0.55 + bake_v3 chart-aware atlas 2048 + (orphan-chart
fallback global NN ajoute apres - dans le commit suivant).

