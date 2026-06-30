# FabMesh Agent Log

## 2026-06-30 (Packaging Store/MSIX — Tier B 1/2 : infra venv IA + routage interpréteur, dev-safe)

- Constat (contre-analyse) : `python-embed` (23 MB) est NU + embeddable (pas de module `venv`) +
  `wizard:install-deps` était code mort → torch jamais installé pour un end-user. Le python embarqué
  est read-only sous MSIX. `python-embed` a `get-pip.py` + `import site` activé dans `._pth`.
- Helpers : `AI_PYTHON_DIR = DATA_BASE/python` (writable) ; `_aiPython()` (packagé+provisionné → la
  copie ; dev → `'python'` inchangé ; packagé pas prêt → embedded) ; `_aiPythonReady()` (torch présent ?).
- `wizard:install-deps` RESSUSCITÉ : copie `python-embed` → `AI_PYTHON_DIR` (`fs.cpSync` car embeddable =
  pas de venv) puis pip-install torch/diffusers DANS la copie (writable) → plus d'EACCES.
- Routage : 35 spawns `'python'` en dur → `_aiPython()` (dev-safe). `trellis2_native` (5860) →
  `app.isPackaged ? _aiPython() : external/.venv` (dev préservé). `node --check` OK, dev byte-identique.
- RESTE Tier B 2/2 : câbler `wizard:install-deps` dans le flow wizard (étape avant download, renderer) ;
  COMPLÉTER les listes de deps (`wizard_install_deps.py` n'installe pas kaolin/spconv/trellis2-specific —
  torch 2.7 vs 2.8 requis par trellis2) ; test réel install ~5 GB sur un vrai package.

## 2026-06-30 (Packaging Store/MSIX — Tier A : B1 chemins scripts → SCRIPTS_DIR, B5 last_error.log → LOGS_DIR)

- Audit MSIX (workflow, 6 agents) + contre-analyse adversariale (workflow, 10 agents) : l'app ne
  fonctionne PAS une fois packagée (NSIS comme MSIX), pas seulement sous Store. Sur 9 candidats,
  **5 blockers réels confirmés** (B1/B2/B4/B5/B8) ; 4 overstated/cleanups (B3 = code mort,
  B6 guardé+gaté Blender, B7 slider live seulement, B9 vc_redist jamais lancé).
- **B1** : 54 sites (sur 55, déf l.506 exclue) construisaient les chemins de scripts via
  `path.join(__dirname,'..','..','scripts',X)` = à l'intérieur de `app.asar` (illisible par un
  `python.exe` externe → ENOENT). Le garde `existsSync` ne protège pas (Electron lit DANS l'asar
  → renvoie true). Routés vers `SCRIPTS_DIR` (= `process.resourcesPath/scripts` en packagé,
  identique en dev).
- **B5** : les 6 écritures `last_error.log` ciblaient `__dirname/../..` (racine du package,
  read-only). La non gardée (l.5741) faisait échouer CHAQUE génération via le catch l.6045.
  Routées vers `LOGS_DIR` (= `userData/logs` en packagé, writable).
- Vérifié `node --check`. Dev byte-identique. RESTE : Tier B (bootstrap venv + deps — `wizard:install-deps`
  est code mort donc torch jamais installé) ; B2/B4 (interpréteur → venv/_embeddedPython) ; Tier C (vc_redist hors appx, guard autoUpdater).

## 2026-06-30 (Fix release tooling : submit_appx.ps1 ne parsait pas sous PowerShell 5.1 — BOM UTF-8 manquant)

- `scripts/submit_appx.ps1` (automation de soumission Microsoft Store via l'API Store) était
  committé SANS BOM UTF-8 alors qu'il contient des em-dashes `—` (octets UTF-8 `e2 80 94`) dans
  les messages d'erreur. PowerShell 5.1 lit un `.ps1` sans BOM en ANSI (Windows-1252) : l'octet
  `0x94` devient `U+201D "`, un délimiteur de chaîne pour PowerShell → équilibre des guillemets
  cassé → cascade « Missing argument / Missing closing '}' ». Le script ne parsait MÊME PAS →
  l'automation n'avait jamais pu tourner depuis le commit `bf30a1e`.
- FIX : BOM UTF-8 (`EF BB BF`) en tête. PS 5.1 lit alors le fichier en UTF-8, les em-dashes
  restent intacts dans les strings, le script parse + tourne de bout en bout (Step 1 credentials →
  Step 2 appx → Step 3 OAuth). Validé via `-DryRun`. Scan des autres `.ps1` (scripts/, build/) =
  RAS, submit_appx.ps1 était le seul avec du non-ASCII.
- Reste un blocker HORS CODE : `.env > MS_STORE_CLIENT_SECRET` est encore le placeholder
  (« PAS… », 23 char) → OAuth renvoie 401. À remplir avec le vrai secret Azure AD (action user).

## 2026-06-28 (Face-fix REMPLACÉ : SDXL repaint → reprojection photo source, scripts/face_reproject.py)

- L'autopsie a prouvé que `scripts/face_inpaint_atlas.py` est cassé par construction : SDXL est
  génératif, donc "améliorer le visage" devient toujours "inventer un nouveau visage" (efface le
  style). NOUVEAU `scripts/face_reproject.py` (non destructif) qui REPROJETTE le visage NET de
  l'image SOURCE sur l'UV visage du mesh via `texture_project`. Hors masque = byte-identique au
  bake original (ORIG_ATLAS chargé indépendamment).
- Pipeline : (1) ORIG_ATLAS indépendant = sol. (2) masque UV visage (réutilise render_mesh_front /
  detect_face_bbox / fallback_top_bbox / make_atlas_mask_from_bbox de face_inpaint_atlas), feather.
  (3) AUTO-R_undo + GATE caméra PERSPECTIVE : on rend le mesh via la caméra perspective EXACTE de
  texture_project (R_undo candidat → R_w2c_base, dist 1.6, fov 40, p_u/p_v identiques), Haar sur le
  rendu, comparé au bbox visage SOURCE (centre <6% du cadre, ratio d'échelle [0.82,1.22]). On
  essaie les flags R_undo (SF3D undo défaut / SKIP_UNDO identité / HI3DGEN_UNDO) et on garde celui
  qui aligne le mieux. (4) projection front seul via texture_project : BASE_ATLAS=1, FRAME_FIX=1,
  UFLIP off, PREFILL_DOMINANT=0, UV_REPACK=0, pas de multiview ; rejet oblique = STACK_VIS_FLOOR
  (VIS_THRESH no-op sur le chemin stack/atlas). PROJ_ATLAS relu depuis le GLB de sortie (_tex.png =
  fallback). (5) colour-match Reinhard par canal proj→orig dans le masque. (6) composite feathered
  out = ORIG*(1-m) + PROJ_matched*m. (7) écriture via texture_refine.replace_glb_atlas (swap
  baseColor in-place, normal map/UV/skin préservés).
- 3 fixes vérificateur : A la GATE utilise la caméra perspective de PROJECTION (pas l'ortho du
  masque qui ne SÉLECTIONNE que les triangles) ; B auto-détection R_undo (frame TRELLIS2 non
  validée sous l'undo SF3D par défaut) ; C garde-fou partout (masque None / aucun R_undo aligné /
  coverage < --min-coverage / désaccord bbox → copy input→output, exit 0). Issue UNIQUEMENT
  "même visage plus net" ou "original inchangé", jamais pire.
- main.js : FACE_SCRIPT → face_reproject.py ; runFaceFix passe `['--source', imagePath]` (imagePath
  = front rectifié à ce point). Gate character conservé (non-character = vue ISO 3/4 qui ne
  s'overlaye pas sur une projection front). Port cloud = follow-up séparé.

## 2026-06-28 (Options texture payantes détruisaient le visage — diagnostic + Tier 1)

- Plainte produit : un perso généré avec "Affinage des détails" + "Correction du visage" cochés
  sort avec le VISAGE détruit (taches rouges/distorsion) — inacceptable pour un produit payant
  (le profil `character` activait LES DEUX par défaut). Workflow fix-paid-texture-options (6
  agents) a tracé la cause :
  - "Affinage des détails" (ws-trellis2-refine) → scripts/texture_refine.py img2img TOUTES les
    tuiles du 4096 atlas, visage compris, SANS masque → ControlNet-Tile hallucine sur la peau
    plate du visage. DESTRUCTEUR PRINCIPAL.
  - "Correction du visage" (ws-trellis2-face-fix) → scripts/face_inpaint_atlas.py = inpaint SDXL
    GÉNÉRATIF à --strength 0.45, masque Haar grossier, prompt "photoreal humain" → efface
    l'identité stylisée. 2ᵉ destructeur. (Le head-freeze de detail_synth.py est sur un AUTRE
    chemin — le bouton "Détail++" — donc ne protégeait pas la génération.)
- TIER 1 (cette commit, sans GPU) : profils `character`+`creature` → refine:false + face-fix:false
  par défaut ; runFaceFix gaté à character + strength 0.45→0.20.
- TIER 2 (FAIT) : texture_refine.py --protect-face — génère le masque visage (render front + Haar +
  UV-project, réutilise face_inpaint_atlas) AVANT le refine, puis composite l'ORIGINAL sur la zone
  visage après → affine le corps sans toucher le visage. GARDE-FOU : si le masque échoue (pas de
  renderer / pas d'UV), SKIP le refine (copie l'original) — jamais de destruction. main.js passe
  --protect-face pour character/creature ; refine RÉACTIVÉ ON par défaut. À TESTER sur GPU.
  Reste : relabel honnête (i18n) + Face-fix "expérimental". Verdicts : protège+améliore = true (high).

## 2026-06-27 (Cloud: port du "lineage jump" desktop → MyFabmesh.AI)

- Porté la feature "lineage jump" du desktop (src/renderer/index2.js + styles) vers le
  cloud (cloud/public/app/index2.js + styles/index2.css).
- Ajouté: `_sigKey` (strip de la query R2 signée volatile, modèle `_emKey`),
  `_flashCenterSelected`, `_resolveParentMeshPath`, `_resolveParentRig`,
  `jumpToSourceImage` / `jumpToMesh` / `jumpToRig`.
- Boutons hover ajoutés: 📷 (image source) sur les mesh ; 📷 + 🧊 sur les rigs (+ green
  check `used-for-3d` synchronisé) ; 📷 + 🧊 + 🦴 sur les vignettes d'animation (batch).
- Adaptation cloud: TOUTE comparaison de chemin normalise la signed-URL via `_sigKey`
  (la signature change à chaque /api/meshes). Les rigs/anims R2 n'ont pas de sourceImage
  ni de rigPath → parents dérivés par stem de filename (jamais par champ stocké).
- CSS: `.version-source-btn` / `.version-mesh-btn` / `.version-rig-btn`, hover-only,
  2e rangée (top:30px) pour ne pas chevaucher le check (haut-gauche) ni le delete X
  (haut-droite). Build `npm run build` OK, code présent dans out/.
- Tout est gardé (pas de bouton quand la donnée manque) → zéro impact sur l'existant.

## 2026-06-27 (Backup avant tuning texture TRELLIS — geo IP-Adapter optionnel + head-freeze)

- Commit de sauvegarde avant d'appliquer les réglages texture trouvés par l'audit (workflow
  trellis-texturing-audit) : crop-sujet manquant, auto-brighten trop fort, guidance_rescale=0.0,
  rescale_t=3.0 hérité de la forme. AVANT ça : sdxl_server `do_refine_geo` rend l'IP-Adapter
  OPTIONNEL (`FABMESH_GEO_IPADAPTER`, défaut 0 → pipe ~9.5 GB tient en VRAM SANS offload, fini le
  thrashing 50-100s/step) + `do_img2img_tile` REVENU à l'identique (existant non touché). detail_synth :
  head-freeze géométrique (`--freeze-head`, gèle visage/barbe via l'axe vertical) — CODÉ, PAS TESTÉ.
  Verdict empirique : SDXL détruit les visages IA quelle que soit l'approche → seul contournement =
  ne pas toucher le visage. Branche backup poussée sur GitHub avant les modifs texture.

## 2026-06-27 (Détail-synthèse : render-refine-reproject — scripts/detail_synth.py, VALIDÉ)

- Le bake trellis2 est plafonné (voxel 1024). Pour dépasser : nouveau pipeline `detail_synth.py`
  = (1) rendre le mesh sous 6 vues avec nvdiffrast en utilisant la caméra EXACTE de
  texture_project (fov 40, dist 1.6, R_w2c_base, orbite az/elev, + le R_undo=rot_x(90)@rot_y(-90),
  + flipud pour matcher p_v=1-p_v), (2) SDXL ControlNet-Tile (/img2img_tile, strength 0.35) ajoute
  du détail sur chaque rendu, (3) re-bake via texture_project --multiview + un views.json
  {azim,elev} par vue. Caméra cross-checkée numériquement (égalité flottante vs texture_project).
  VRAM séquencée (nvdiffrast ~700MB libéré avant SDXL ~9.5GB ; reproject CPU). VALIDÉ end-to-end
  sur le samouraï (humanoid_43, 489k faces, 4096) : l'armure lamellaire passe de BRUIT TV à
  vraies plaques métal définies, alignement parfait, robe/peau plus fines. ~2 min total.
  Gate `--render-only` pour vérifier l'orientation. À FAIRE : câbler comme outil UI + cloud,
  option auto post-génération.
- FIX couture (2026-06-27) : sur géométrie fine (squelette humanoid_27) la repro 6-vues
  sous-couvrait les côtés minces → trous inpaint sombres = couture verticale au centre. Fix :
  detail_synth force `FABMESH_TEXPROJ_BASE_ATLAS=1` → la texture d'ORIGINE devient le plancher
  (sharp_ratio 1.0, zéro trou), le détail n'est ajouté QUE là où les vues couvrent bien.
  Bonus : détail-synth devient SÛR (jamais pire que l'original). Validé A/B éclairé. Strength
  0.5 = bon curseur (testé 0.35 doux / 0.5 fort sur le samouraï). Cas durs (fin/ajouré) = gain
  modeste ; meshes pleins (perso/armure) = net.

## 2026-06-22 (Texture nette : tex_slat steps 12→24 + guidance 1.0→3.0 — CAUSE RACINE du bake mou)

- Investigation (workflow texture-detail-investigation, 6 agents) → CAUSE RACINE de la texture
  molle : le pipeline natif échantillonnait tex_slat avec un dict VIDE `{}` → défauts pipeline.json
  faibles (steps=12, guidance_strength=1.0 ≈ quasi SANS conditionnement, vs 7.5 pour la FORME). Le
  détail de la réf était massivement sous-pondéré. Fix : steps→24 + guidance→3.0 (interval [0.5,1.0]),
  env-gated `FABMESH_TEX_STEPS` / `FABMESH_TEX_GUIDANCE`, appliqué aux 2 chemins (multi-vues
  sample_tex_slat + pipeline.run via `pipeline.tex_slat_sampler_params.update`). VALIDÉ A/B via le
  bridge (même mesh chevalier, seed 42, 4096) : baseline 12/1.0 = or terne/brun + mou ; sharp 24/3.0
  = or vif métallique + filigranes définis. +48s. Plafond honnête : voxel-texture 1024 (PAS de
  checkpoint >1024 dans TRELLIS.2-4B) → gain « net mais pas studio 8K ». Prochain gros saut =
  render-refine-reproject (refine des RENDUS du mesh puis re-bake, seam-safe). À PORTER au cloud
  (env Modal). NB : le bridge oublie ATTN_BACKEND=sdpa/SPARSE_ATTN_BACKEND=sdpa (le natif les pose
  pour contourner le SAC qui bloque flash_attn non-signé).

## 2026-06-22 (Re-texture HD : kernel numba — ~10 min → ~30-60s, bit-faithful)

- Le retexture 4K mettait ~10 min (timeout silencieux). Profil multi-agents (workflow
  optimize-texproj-4k, 10 agents, 477k tokens) → goulot = la boucle Python par-face de
  `texture_project.py` (lignes 826-981, 70-95% du temps : ~3.4M itérations interprétées
  faces×vues avec mini-ops numpy par face = antipattern numpy-in-a-Python-loop).
- Fix : port `@njit(cache=True)` BIT-FAITHFUL des 3 modes (stack/accum/winner, même math :
  +0.5 centres, int() trunc, barycentrique, tri_vis<0.05, tri priorité des vues, floors env).
  La boucle legacy est GARDÉE intacte en fallback (else:), gate `FABMESH_TEXPROJ_NUMBA`
  (défaut 1 ; =0 force l'ancien chemin ; diag force aussi legacy). numba 0.65 déjà installé
  (BSD, zéro risque Blackwell sm_120). Rastérisation chunkée en 12 → progression réelle
  streamée (`rasterize_progress`, fini le faux 90% côté log).
- VÉRIF DÉFINITIVE : A/B `texture_project.py` numba ON vs OFF sur mesh réel (Aligator 15844
  faces, 1024) → atlas IDENTIQUE au pixel près (**maxdiff=0, meandiff=0**). À TESTER 4K sur
  GPU (cible ~30-60s). Suites possibles : nvdiffrast GPU (sub-15s, VÉRIFIÉ live sm_120 — contre
  Pixal3D — mais licence NVIDIA à vendre pour le packaging) ; Telea inpaint = nouveau goulot
  (~5-15s) ; bar live (main.js spawn-stream des events rasterize_progress).
- SUITE (même session) : le retexture 4K crashait QUAND MÊME (rc=4294967295 natif, après
  mesh_loaded). Diagnostic A/B : ce n'était NI numba (512×7vues+boundscheck = 4s clean, 0 OOB)
  NI le 4K en soi (4096 sans xatlas = 24s rc=0) mais **xatlas.parametrize** qui s'étrangle
  (>220s à 512) + crashe en NATIF (uncatchable) sur 487k faces. Fix : skip xatlas re-unwrap
  au-dessus de `FABMESH_UV_REPACK_MAX_FACES` (défaut 150000) — les meshes high-poly (trellis2
  enhanced) ont déjà des UV propres (99.96% couverture sans re-unwrap), xatlas n'aide que les
  petits SF3D fragmentés. VALIDÉ end-to-end : 4096 + multiview + env défaut = **22s** (xatlas
  skip + numba raster 2.0s + Telea inpaint 10.5s), full coverage. Bilan : 10min+crash → 22s.

## 2026-06-22 (Re-texture HD 4K : multi-vues branchées + 4096 débloqué)

- User : texture moyenne même à fond → la recherche (project_texture_quality_research) valide
  la re-projection source. Diagnostic : le cap 2K venait du fait que `retexture` n'envoyait
  QUE la photo FRONT → à 4K le dos/côtés n'ont aucune source = taches noires. `texture_project.py`
  a DÉJÀ xatlas re-unwrap + mode `--multiview` (view_0..5.png) + seam-blend/edge-pad. Fix :
  `retexture` cherche le set 6-vues (`<mesh>.glb.multiview/` ou `<source>_multiview/`) et passe
  `--multiview` (fallback gracieux front-only si absent), timeout 120→300s. Dropdown débloqué
  à 4096. À TESTER sur GPU (sur un mesh qui a le set 6-vues).

## 2026-06-22 (Re-texture zone 3D — fondation backend : masque UV direct)

- User : veut un viewer 3D rotatable façon « Peinture de sommets » pour « Re-texturer une
  zone » (option A) au lieu du rendu front fixe. Fondation backend : `face_inpaint_atlas.py`
  prend `--uv-mask` (masque DÉJÀ en espace UV → `inpaint_atlas` direct, saute la projection
  écran→UV ET le rendu front lent). `mesh:region-retex` prend un flag `uvMask` → `--uv-mask`.
  À SUIVRE (frontend) : modal viewer 3D live qui réutilise l'infra raycast `hit.uv` de
  Peinture émissive pour peindre le masque UV directement sur le mesh (rotation libre).

## 2026-06-22 (Preset Ultra 8K pour la re-texture mesh : 4096 bake + Real-ESRGAN ×2)

- User : « on fait pas 8K aussi ? » sur le dropdown re-texture (trellis2_retex). Ajouté un
  preset « Ultra 8K (4096→8192) » : `mesh_tools.py` bake à 4096 (un bake 8K direct OOM sur
  16 GB), puis `runMeshTool` enchaîne `enhanceMeshTexture` (Real-ESRGAN ×2) sur le résultat
  → 8192 final. Le job reste « en cours » pendant l'upscale. Restart non requis.

## 2026-06-22 (Re-texture zone : mode IA-auto — détection CLIPSeg, plus de peinture obligatoire)

- User : « c'est un outil IA → textures recréées sans sélection manuelle ». Ajouté la
  détection auto au tool « Re-texturer une zone » : champ « Quelle pièce ? » + bouton
  « Détecter (IA) ». `do_segment` prend un param `binary` → sauve le masque blanc/noir
  (`mask_binary` existait déjà) au lieu de l'overlay rouge. `segment-mask` IPC passe `binary`
  (fichier distinct `fabmesh_mask_bin.png`). `mesh:render-front` retourne `frontPath` (garde
  le PNG) pour que CLIPSeg détecte dessus. Front : la détection peint le masque sur le canvas
  (l'apply `regionRetex` existant marche inchangé) ; l'Apply auto-détecte s'il n'y a pas de
  masque → taper pièce + résultat + Appliquer = zéro peinture. La peinture reste dispo pour
  raffiner. Restart Electron + serveur SDXL.

## 2026-06-22 (Outil « Enhance texture » : Real-ESRGAN x2 sur l'atlas du mesh final)

- User : « on peut pas améliorer la texture finale ? » (texture mesh molle/bavée vs source
  nette — TRELLIS *génère* la texture, ce n'est pas une copie). Nouveau bouton « Enhance
  texture » (workspace mesh tools + panneau lightbox 3D) : appelle `texture_upscale.py`
  (Real-ESRGAN x2, Apache-2.0, n'invente RIEN contrairement au SDXL refine) sur l'atlas
  baseColor du GLB existant → re-pack → nouvelle version mesh, SANS re-générer la géométrie.
  Handler IPC `enhance-mesh-texture` (python venv trellis2) + preload `enhanceMeshTexture` +
  job mappé step 2 (Mesh) dans `_jobStepIndex` (bouton « → Aller au Mesh »). Restart Electron.

## 2026-06-22 (Fix mesh low-def : Ultra 8K passait 2048 au lieu de 4096 à TRELLIS-2)

- User : « mesh généré avec params au max → low def ». Log : trellis2_native appelé avec
  texsize=`2048`. Cause : le renderer envoie DEUX tailles — `textureSize` (= `preset.tex`
  générique, 2048) ET `trellis2TexSize` (= `t2cfg.texSize` du preset Ultra 8K, **4096**).
  main.js construisait l'arg trellis2 avec `textureSize` (2048) au lieu de `trellis2TexSize`.
  Donc la texture base sortait à 2048, puis Real-ESRGAN ×2 → 4096 final au lieu de 8192 =
  résolution divisée par 2 partout. Fix : `String(trellis2TexSize || textureSize || 2048)`.
  Maintenant Ultra 8K = base 4096 → ×2 → 8192. (NB : la géométrie 1536_cascade reste gated
  à 32 GB RAM ; sur 27 GB le max géo est 1024_cascade — séparé du fix texture.) Restart
  Electron requis.

## 2026-06-22 (Outil Age : contrainte ControlNet variable pour atteindre bébé/lionceau)

- User : « le aging marche pas trop mal mais on peut pas aller jusqu'aux enfants ; un
  lionceau ne ressemble pas à un jeune lion ». Cause : `do_tex_variant` (ControlNet-Tile)
  verrouille les proportions (cn_scale 0.45 fixe) → un fort rajeunissement garde le corps
  adulte, juste re-texturé. Fix : `do_tex_variant` prend maintenant `cn_scale` + `neg_prompt`
  en paramètres. L'outil Age les pilote selon l'intensité du slider : cn_scale 0.52 (léger,
  garde la silhouette) → 0.20 (extrême, laisse les PROPORTIONS bouger : grosse tête, petit
  corps) + neg_prompt sans « changed shape » au-delà de 55 %. Prompt rendu sous-agnostique
  (humain + animal). Backward-compat : variant garde cn_scale 0.45 par défaut. Restart
  serveur SDXL requis.

## 2026-06-22 (Fix CUDA OOM : un seul pipeline SDXL lourd résident à la fois)

- User : « CUDA out of memory … 0 bytes free » sur une édition (auto-inpaint « enlever
  les pièces jointes »), VRAM 15.4/14 GB. Cause : `img2img_pipe` + `inpaint_pipe` +
  `controlnet_tile_pipe` (RealVisXL ~6-9 GB chacun) restaient TOUS résidents en VRAM en
  même temps → saturation de la carte 16 GB. Fix : helper `_free_heavy_except(keep)`
  appelé au début de chaque `load_*` (sous `load_lock`) qui libère les autres pipelines
  lourds (`del` + `free_vram`), en gardant CLIPSeg (~400 MB, partagé). Aucun op ne
  nécessite 2 pipelines lourds à la fois (recolor = clipseg + controlnet OU hsv ;
  inpaint = clipseg + inpaint ; variant = controlnet ; img2img = img2img) donc libérer
  les autres est sûr. Coût : un reload (~10-20 s) au changement de type d'op, plus
  d'OOM. Desktop only. NB : nécessite un restart du serveur SDXL (Arrêter le moteur AI)
  pour prendre effet.

## 2026-06-21 (Variante étendue : mode « texture » — forme verrouillée, ControlNet-Tile)

- User : « différentes versions des textures du personnage (épée devient bleu) sans
  changer l'élément généré, seulement la texture », slider 1-8 comme Variante. Étendu
  l'outil Variante : nouveau `do_tex_variant` (ControlNet-Tile, cn_scale 0.9 = forte
  contrainte de structure, strength ~0.45, seed/variante) qui régénère la surface en
  gardant la géométrie. Endpoint /tex_variant + IPC tex-variant + preload texVariant.
  Modal Variante : toggle « 🔒 Varier seulement la texture (garder la forme) » + champ
  prompt optionnel (« épée bleue… » — vide = libre). Quand ON, la boucle (sliders
  Intensité + Nombre 1-8 réutilisés) appelle texVariant au lieu d'img2img. Desktop only.
  RETUNE : cn_scale 0.9 verrouillait trop (gardait les couleurs = aucun vrai changement).
  Baissé à 0.45 + strength 0.35-0.9 + guidance 7.5 → la silhouette tient mais la
  texture/matière/couleur change vraiment (gris→marron, métal→or). Intensité auto à 70 %
  quand on active le mode. Le prompt guide la variation.

## 2026-06-21 (Précision de détection CLIPSeg : seuil relatif au pic + slider Précision)

- User : « arme » détectait toute la moitié gauche (cape+corps) — le seuil CLIPSeg fixe
  >60 (sigmoid, ~23%) était trop permissif. Passé à un seuil RELATIF au pic par image :
  `thr = max(60, peak * rel)` dans `_clipseg_mask` (recolor), `do_segment` (preview) et
  `do_inpaint` → ne garde que la zone fortement détectée. Param `rel` propagé (routes
  /segment + /recolor, main.js segment-mask + recolor). Nouveau slider **Précision
  détection** (0-100% → rel 0.2-0.8) dans le modal Recolorier, appliqué au preview ET à
  l'apply. Plus haut = plus serré.
- Suite : la **Retouche auto** (auto-inpaint) n'avait que le padding (qui agrandit) — « head »
  débordait sur le cou. Ajouté le slider **Précision** aussi (défaut 65 %), `rel` paramétré
  dans do_inpaint + route /inpaint + IPC auto-inpaint, appliqué au preview ET à l'apply.
  Range élargi à rel 0.2-0.9 (100 % = ne garde que le cœur).

## 2026-06-21 (Nouvel outil « Recolorier » — recolorisation auto par prompt, forme préservée)

- User : « outil auto pour regénérer seulement les couleurs des habits via prompt
  (cape rouge) ». Conçu via workflow `recolor-tool-design` (5 agents) puis implémenté.
  Méthode : **recolorisation HSV déterministe** sur la zone détectée par CLIPSeg →
  teinte la région en gardant la LUMINANCE (plis/ombres/forme intacts), instantané, pas
  de régénération. Parse « cape rouge » → nom (`cape` pour CLIPSeg) + couleur (lexique
  bilingue FR/EN → teinte HSV). **Fallback ControlNet-Tile** (strength 0.18) seulement
  pour les matières sans mot-couleur (« métal rouillé »). Plancher de saturation 110
  pour que les sources grises prennent une teinte nette.
  Fichiers : `sdxl_server.py` (endpoint /recolor + parse_recolor_prompt/recolor_hsv_masked/
  do_recolor/do_recolor_tile, réutilise le bloc CLIPSeg de do_inpaint), main.js (IPC recolor),
  preload (recolor), index2.html (bouton ws-recolor-btn + modal-recolor miroir de l'inpaint
  avec preview du masque), index2.js (TOOL_MAP + handlers + _stripColorWords). À PORTER au
  cloud ensuite (endpoint + bouton).

## 2026-06-21 (Libération VRAM : décharger SDXL avant une gen GPU d'un autre type + idle translate)

- User : le serveur image SDXL (7,2 Go VRAM) bloque la VRAM si on lance une gen
  mesh/3D (TRELLIS ~10 Go) avant les 90 s d'idle. `image-to-3d` le déchargeait déjà
  (l.5433) ; ajouté le helper `_freeSdxlForHeavyOp(label)` (stop + 1,2 s, no-op si pas
  chargé) appelé au début de `image-to-3d-trellis`, `generate-multiview`, et
  `auto-rig-ai` (sauf puppeteer = CPU). SDXL respawn à la prochaine op image.
- Worker de traduction : auto-déchargement après 5 min d'idle (libère ~1 Go RAM).

## 2026-06-21 (Fix bruit arc-en-ciel img2img — VAE fp16 overflow)

- User : « j'ai demandé la modif "il doit etre obèse", l'image est vraiment dégradée »
  → bruit arc-en-ciel sur toute l'image. Cause : `pipe.vae.to(torch.float16)` dans
  sdxl_server.py — la VAE native de RealVis XL **overflow en fp16** (bug SDXL connu).
  Fix : swap pour `madebyollin/sdxl-vae-fp16-fix` (VAE stable en fp16, encode+decode),
  avec fallback `vae.config.force_upcast = True`. Appliqué aux 3 pipelines qui décodent
  des images : img2img, inpaint, et controlnet-tile (le « Tile refiner » = la 2e passe
  « _refined » du user). VAE pré-téléchargée. Le serveur SDXL recharge au restart.

## 2026-06-21 (Correcteur d'orthographe selon la langue UI)

- Le correcteur Chromium d'Electron vérifiait en anglais (« obèse », « être » soulignés
  à tort). main.js : `setSpellCheckerLanguages` selon la langue UI (mappée depuis les
  `availableSpellCheckerLanguages`, + en fallback), IPC `set-spellcheck-lang`, et un
  menu clic-droit (suggestions + add to dictionary + cut/copy/paste). preload
  `setSpellcheckLang`. i18n.js l'appelle dans `applyLang` (synchro au changement de langue).

## 2026-06-21 (Classifieur NSFW de prompt DÉSACTIVÉ — trop de faux positifs)

- User : « plus gros et habillé en noir » bloqué à 92 %, « Golden crab » 79 % → le
  classifieur de texte michellejieli/NSFW_text_classifier est **fondamentalement
  peu fiable** (faux positifs massifs sur des prompts bénins). `checkPromptSafetyAI`
  ne bloque plus (retourne safe après le hard-floor). La sécurité reste : (1)
  `checkPromptSafety` (NSFW_KEYWORDS + NSFW_COMBOS, regex fiable — bloque nude/naked/
  CSAM sans faux positif) + le hard-floor, (2) le check NSFW de l'IMAGE générée
  (galerie / 3D). L'infra du serveur NSFW reste dormante pour un futur modèle fiable.

## 2026-06-21 (Serveur NSFW persistant + noms de moteurs par capacité)

- **Check NSFW instantané** : `checkPromptSafetyAI` rechargeait le modèle de 250 Mo
  (~20 s) à CHAQUE génération sous contrôle parental → le user voyait la génération
  « tourner » puis échouer. Nouveau `scripts/nsfw_server.py` = serveur HTTP localhost
  qui charge le classifieur UNE fois. main.js : lifecycle (start/ensure/call/stop, port
  5558, kill au quit) + `checkPromptSafetyAI` route vers lui avec fallback per-call.
  Testé : froid 5,1 s, chaud **0,043 s**. Seuil monté 0.7→0.9 (« Golden crab » = SFW).
  Desktop-only (cloud NSFW = côté Modal).
- **Noms de moteurs par capacité** (choix user « avec le compromis ») : Équilibré
  (qualité/vitesse) / Qualité max (HD · plus lent) / Rapide (Turbo ⚡ · ~4 étapes),
  desktop + cloud, traduits 5 langues (`_additions3.js`).

## 2026-06-21 (Anti-doublement : retrait des tokens « ONE/single/no duplicate » du POSITIF de TOUS les types d'asset)

- User : « il y a deux animaux dans l'image » → diagnostic confirmé : l'anti-pattern SDXL
  documenté (_realvis.py) — mettre « ONE X only / single X / one instance / no duplicate /
  no second X » dans le POSITIF fait remplir l'espace vide par un 2e sujet. C'était présent
  dans **TOUS** les `ASSET_TYPE_PROMPTS` (character, building, vehicle, weapon, prop,
  creature, environment, icon, avion, bateau, animal, insect, other_*), pas seulement animal.
  Retiré ces tokens de comptage de sujet + négations « no duplicate/second/twin » du positif
  (gardé cadrage/pose/fond/lumière/anatomie comme le compte de pattes insecte + stance
  quadrupède NEVER bipedal). L'anti-doublement reste dans le NÉGATIF du bridge (« two animals,
  animal pair, duplicate, twin » + poids l.357). Desktop + cloud. À TESTER (génération).

## 2026-06-21 (Fallback i18n runtime + Enhance relançable)

- **Fallback auto runtime** (fin du whack-a-mole) : toute chaîne anglaise absente des
  dicts est traduite à la volée par le worker argos (EN→langue) + cache localStorage
  permanent. `translate_server.py` accepte un param `to` (EN→langue) ; main.js expose
  l'IPC `i18n-auto-translate` (batch + cache) ; preload `i18nAutoTranslate` ; i18n.js
  `_queueAuto`/`_flushAuto` collectent les clés manquantes (filtre anti code/url/nombre),
  flush debouncé, ré-applique. No-op si pas de worker (cloud). Paquets argos en→fr/es/zh/
  hi/ar installés. Testé : « Settings »→« Paramètres », « Image generation failed »→« La
  génération d'images a échoué ». i18n.js copié au cloud (no-op là-bas, à doter d'un
  endpoint serveur plus tard).
- **Enhance relançable** : retiré le guard « Prompt already enhanced » ; Enhance
  re-traite toujours (strip des suffixes connus d'abord → pas de double-wrap), même si
  le texte n'a pas changé.

## 2026-06-21 (Fix : la génération 3D créait une image « _rectified » non voulue)

- User : « quand je génère une 3d ça me génère une nouvelle image non souhaitée. »
  Cause : l'option « Auto-rectification de la vue source » (3D TRELLIS-2) écrivait
  `<image>_rectified.png` **dans le dossier image du projet** → la galerie le scannait
  et l'affichait comme nouvelle version (v2). Fix main.js : (1) le `_rectified` est
  écrit dans `os.tmpdir()` (utilisé pour le mesh, hors dossier projet) ; (2)
  `list-image-folders` exclut désormais `_rectified` (masque aussi ceux déjà créés).
  Restart Electron requis (main.js).

## 2026-06-21 (Debranding : retrait des noms d'IA des menus déroulants)

- User : « le nom des IA ne doit pas être mentionné dans les menus déroulants. »
  Renommé les labels exposant des noms de modèles/outils IA en noms MyFabmesh.AI :
  RealVisXL/HiDream-O1/SDXL-Lightning → « MyFabmesh.AI Image Engine (local) / HD /
  ⚡ Turbo » ; Rokoko/AnyTop/Seed3D Puppeteer/Blender/Modal retirés des dropdowns
  anim (Motion Library, Generative motion AI, Procedural animation, Local, Cloud).
  Touché : ENGINE_LABELS + <option> du <select> ws-engine/ws-anim-*, label anim,
  desktop + cloud. Traduit les nouveaux labels (5 langues) → `lang/_additions2.js`
  (workflow i18n-branded-labels), chargé après _additions.js dans les 2 index.html.

## 2026-06-21 (i18n : tf() + titres de jobs dynamiques + 132 templates)

- Régénéré `_additions.js` en repliant les 132 « dynamiques » : 4 étaient mal classés
  (sans placeholder, dont le hint VRAM) → statiques ; 128 vrais templates ({x}) sont
  enregistrés pour `tf()`. Total fr/es/zh/hi/ar : 629/635/652/651/653 entrées.
- `tf(template, ...args)` ajouté à i18n.js (cherche le template avec {x} dans le dict +
  interpole). `_displayJobName(name)` dans index2.js traduit les titres de jobs À
  L'AFFICHAGE seulement (« Generate 3D: dropped » → « Génération 3D : dropped ») via tf,
  en gardant `job.name` anglais pour que le regex `_jobStepIndex` continue de matcher.
  Câblé aux 3 points (step widget, job card, sous-titre du modal). Porté desktop + cloud.

## 2026-06-21 (i18n exhaustif : +2568 traductions, 5 langues, 2 plateformes)

- Workflow `i18n-exhaustive` (44 agents, audit popup-par-popup de ~40 modals +
  menus + toasts JS) : **666 chaînes non traduites** trouvées → **534 statiques**
  + 132 dynamiques. Généré `src/renderer/lang/_additions.js` (register fr/es/zh/hi/ar :
  499/507/521/520/521) via `c:/tmp/gen_i18n_additions.js`. **Décodage des entités HTML**
  des clés (&amp;→&, &hellip;→… etc.) car l'i18n matche le texte DÉCODÉ du DOM, pas le
  HTML source. Chargé après lang/*.js dans index2.html + cloud index.html, copié au
  cloud (dicts identiques). Les 132 dynamiques (« Generate 3D: {x} » etc.) → c:/tmp/
  i18n_dynamic.json, à câbler avec t(). Cloud : besoin `npm run build && wrangler deploy`.

## 2026-06-21 (Auto-traduction sur TOUS les champs de prompt)

- `translateUserPrompt()` (UI lang → EN, via le worker persistant) n'était appelé
  que dans Generate/Enhance. Câblé sur tous les autres champs de prompt user →
  modèle (anglais) : **Modify image** (mod-prompt → img2img), **Region re-texture**
  (rrx-prompt → regionRetex), **Auto-inpaint** cible+remplacement (ai-target/ai-replace
  → autoInpaint) + le **preview de détection** SAM (segmentMask), et **Refine mesh**
  (rfn-prompt → refineMesh). Variant réutilise `p.prompt` (déjà EN), np-prompt passe
  par ws-prompt (traduit). Rapide car le worker reste chaud (~0,06 s). Renderer-only.

## 2026-06-21 (Worker de traduction persistant + fix flashing #2)

- **Traduction instantanée** : le fix CPU-only laissait quand même ~5-6 s/appel
  (argos se recharge à chaque spawn). Nouveau `scripts/translate_server.py` =
  serveur HTTP localhost qui charge argos **une fois** et le garde chaud. main.js :
  lifecycle léger (`ensureTranslateServer`/`translateServerCall`, port 5557, kill au
  quit) + le handler `translate-prompt` route vers le worker avec **fallback per-call**.
  Testé : trad froide 5,9 s, trad chaude **0,065 s**. (~150 Mo CPU, pas de GPU —
  sans rapport avec le serveur image lourd abandonné.) Embedded double-spawn = 0,05 s
  (négligeable, pas touché). Restart Electron requis.
- **Flashing vert #2** : `renderStepProgressWidgets` (panneau « GÉNÉRATION ») rebuild
  aussi tout son `innerHTML` à chaque tick → même fix update-ciblé que `renderJobs`.

## 2026-06-21 (Fixes test desktop : trad rapide + nudité + variantes)

- **Traduction Argos 23 s → 4 s** : le package FR tire stanza→torch et l'init CUDA
  coûtait ~20 s/appel (et faisait TIMEOUT >20 s → prompt non traduit). Fix : spawn la
  trad en **CPU-only** (`CUDA_VISIBLE_DEVICES='' CT2_FORCE_CPU=1`). + délai cosmétique
  500→150 ms. + mémo du python qui a argos (skip l'embedded qui échoue).
- **Nudité depuis un prompt bénin** (« agriculteur » → femme nue) : le template
  `character` n'imposait pas de vêtements + les négatifs n'avaient pas `nude`. Fix :
  « fully clothed, wearing a complete outfit » dans le template (desktop + cloud) +
  `nude, naked, nsfw…` dans les négatifs (bridge T-pose + défaut, et Modal `_realvis.py`).
- **N variantes → moins de vignettes** : `img2img` nommait la sortie `_refined_${Date.now()}`
  → N variantes en parallèle = même ms = même fichier = écrasement. Fix : suffixe `_${seed}` unique.
- **Slider variantes** : max 4 → **8** (desktop + cloud).
- Restart Electron + (cloud) build/deploy + Modal redeploy pour effet complet.

## 2026-06-21 (Batch WF3 — quick wins + sécu/argent/fiabilité)

Du workflow #3 (améliorations) :
- Supprimé `cloud/src/worker_master_test.ts` (10 648 lignes mortes, exclu du build).
- `handleImageTo3D` valide le GLB (taille > 2 Ko + magic `glTF`) avant de reporter
  un succès (un GLB 0-byte/tronqué passait).
- Cache mémoire (from|text) pour la traduction Argos (évite le respawn Python à
  chaque prompt non-anglais sur le chemin critique du Generate).
- **Compteurs spend/credits atomiques** (CAS R2 `_casIncrementCounter`) — les caps
  GPU $ + 10 calls/user étaient contournables en concurrence (read→put non atomique).
- **Reaper de jobs bloqués** (`reapStuckJobs` dans `scheduled()`) + **fail/refund
  idempotent** (`_failAndRefundJob`, conditional UPDATE + select) — un job dont le
  client arrête de poller est désormais failed+remboursé UNE fois (>20-30 min).
- **Hard-floor CSAM aligné** : le combo minor×sexual divergeait — le JS bloquait
  `child+bath/bedroom` mais PAS `child+naked/nude/sexual/porn` (trou sous unrestricted),
  le Python l'inverse. **Union** des 3 copies (main.js + nsfw_filter.ts + app.py).
  Combo violence laissé tel quel (les 25 termes sur-bloqueraient les « girl warrior »).
  NON centralisé en JSON (risque de casser le floor sans test) — sync manuelle.
- Déploiements : **Modal redeploy + cloud build/deploy + restart Electron**.
- SKIP : « skip refine multi-view » (la MV EST consommée en aval, trop risqué).

## 2026-06-21 (MVP modif-mesh UI + batch WF2 : boutons morts, back-view, align-tex, export, anim)

- **UI re-texture régionale IA** (complète le backend du 2026-06-20) : bouton
  « Re-texture zone (IA) » dans la barre mesh + modal `#modal-region-retex` qui rend
  le front (`mesh:render-front`), laisse peindre la zone au pinceau, capture le masque
  (blanc/noir), appelle `mesh:region-retex` (inpaint SDXL sur l'atlas) puis recharge.
  Géométrie/UV intacts. **Restart Electron requis.**
- **Boutons morts** : show-in-folder anim (`showInExplorer`) + re-generate rig with
  landmarks (`ws-generate-rig-ai` + forward des landmarks en aval).
- **Back-view sheet** : lisait une vue de PROFIL comme « back » → lit `views.json`.
- **Align Texture cloud** : no-op payant + `API.alignTexture` TypeError → stub gracieux
  + retiré du allowed worker + bouton masqué.
- **Export** : `scripts/convert_glb.py` créé (FBX/USD/ABC/OBJ/glTF via Blender headless).
- **Anim cloud** : mode toujours en échec → URL lue per-invocation + option désactivée.

## 2026-06-21 (Fixes WF2 — sécurité NSFW : fail-closed + scan routes ControlNet)

Workflow #2 (fonctions cassées/incomplètes), volet sécurité :
- `_nsfw.py` `is_safe` : passait en **fail-OPEN** (sur crash classifieur → score 0 →
  `return True` SAFE pour tous les types non-character). Désormais **fail-CLOSED**
  (block + log) — un classifieur cassé ne laisse plus passer le contenu.
- `app.py` : la classe `MyFabmeshBackview` (routes tpose/back_view/sheet/rectify) ne
  chargeait PAS les classifieurs NSFW → AUCUN scan image (`pass` mort + docstring
  mensongère « same as text2image »). Chargé Falconsai+AdamCodd sur la classe + scan
  réel ajouté sur **tpose** (bloc mort remplacé) et **back_view**. rectify/sheet
  dérivent du front déjà scanné ; même pattern réutilisable via `self.nsfw_clf1`.
- **Redeploy Modal requis.**

## 2026-06-20 (MVP modif-mesh — re-texture régionale IA : backend + plomberie)

Suite au workflow #4 (modifier un mesh par IA). MVP = re-texture régionale par
masque + prompt, en généralisant `face_inpaint_atlas.py` au-delà du visage
(géométrie inchangée, texture seule).
- `face_inpaint_atlas.py` : `make_atlas_mask_from_screenmask` (projette un masque
  écran utilisateur → masque atlas UV, même projection ortho xmag=0.6 que le bbox
  visage). Args `--mask <png>` (mode région : skip détection visage) + `--render-only
  <png>` (rend le front aligné pour que l'UI peigne dessus). py_compile OK.
- IPC `mesh:render-front` (→ dataURL du rendu) + `mesh:region-retex` (masque dataURL
  + prompt + strength → nouveau GLB) + exposition preload (`renderMeshFront`,
  `regionRetex`). Pipeline : render-front → Draw-Mask → inpaint SDXL atlas → re-pack GLB.
- **RESTE (prochain incrément)** : l'UI renderer (afficher le render, Draw-Mask
  dessus, capturer le masque, bouton « Re-texturer une zone » près de Re-Texture) +
  parité cloud/Modal (`_region_retex.py`). **Restart Electron requis** (main.js).
- Incrément 2 (post-MVP, cf. workflow) : **Nano3D** sur Modal pour la GÉOMÉTRIE
  (add/remove/replace « rallonge l'épée »).

## 2026-06-20 (SDXL-Lightning turbo — parité cloud/Modal)

Portage du turbo Lightning côté cloud (le desktop l'avait déjà). Modal : la LoRA
4-step est chargée comme **adapter nommé désactivé** au boot (`move_to_gpu`),
activée par-requête dans `_generate_png` si `turbo` (Modal = 1 input/conteneur →
`set_adapters` sans race), avec scheduler Euler trailing + steps=4 + guidance=0
(`_realvis.generate(turbo=)`), restauré en `finally`. Worker : `turbo` threadé
(CogInput + body Modal + handler generate-image). Cloud UI : option « SDXL-Lightning
⚡ » dans `ws-engine` (retiré de la liste hide = parité desktop) → `generateImages`
envoie `turbo:true`. Le chemin Cog/Replicate ignore `turbo` (RealVis normal).
Déploiement : **redeploy Modal** + `cd cloud && npm run build && npx wrangler deploy`.

## 2026-06-20 (SDXL-Lightning ⚡ turbo — 3e moteur image, ~15-40x plus rapide)

Suite au workflow « générateur rapide », ajout de SDXL-Lightning. Fusionne la LoRA
4-step de `ByteDance/SDXL-Lightning` PAR-DESSUS RealVisXL_V4.0 → **même licence**
(Open RAIL++-M, pas de plafond CA), même VRAM/stack cu128/sm_120, garde le style
RealVis, passe de ~30 steps à 4 (~0,5-2 s de sampling vs ~15-40 s).
- `local_juggernaut_bridge.py` : `FABMESH_TURBO=1` → `load_lora_weights` +
  `fuse_lora` + `EulerDiscreteScheduler(timestep_spacing="trailing")`. Flag
  `_lightning_on` force `steps=4` + `guidance=0` UNIQUEMENT sur le path RealVis par
  défaut (jamais sur le path ControlNet T-pose, qui garderait 4 steps sans LoRA = cassé).
- `main.js` : engine `local-lightning` → même bridge + `FABMESH_TURBO=1` + steps=4.
- Dropdown `ws-engine` + `ENGINE_LABELS` + les 2 estimateurs ETA.
- LoRA **pré-téléchargée par le wizard** (`wizard_download.py` MODELS standard+full +
  manifest UI `main.js`), via `allow_patterns=['sdxl_lightning_4step_lora.safetensors']`
  = juste le fichier 4-step (~400 Mo) au lieu du repo entier. Fallback : si absente du
  cache, le bridge la `hf_hub_download` au 1er Generate. **Limite perf** : le bridge respawn → recharge
  RealVisXL (~7 Go) à CHAQUE appel ; le gain plein (<1 s) exige le serveur image
  persistant (cf. workflow améliorations). **Restart Electron requis** (main.js).
- À FAIRE : porter le turbo côté cloud/Modal (text2image) pour la parité.

## 2026-06-20 (Marquage IA Act Art. 50 — provenance machine-readable sur images générées)

P0 de l'audit : aucune marque « IA » sur les images générées. Ajout d'un marquage
**machine-readable invisible** (ne touche PAS les pixels → zéro impact sur l'asset
vendu) sur TOUTE image générée : métadonnées PNG IPTC
`DigitalSourceType=trainedAlgorithmicMedia` + paquet XMP + tEXt (`Software=FabMesh`).
Reconnu par Google/Adobe/etc. Conforme EU AI Act Art. 50(2).
- **Modal** : helper `_ai_pnginfo()` + `pnginfo=` sur les 7 `img.save(...PNG...)` →
  couvre text2image, back_view, tpose, rectify, sheet, image_op (toute la gen cloud).
- **Desktop** : `scripts/local_juggernaut_bridge.py` (RealVis) + `run_fp8.py` (HiDream,
  d:/ai_eval, hors repo) — marquage inline fail-safe.
- **ToS** : clause « AI-generated content & transparency » (Art. 50 + responsabilité
  likeness d'une personne réelle) ajoutée à la section Propriété intellectuelle.
- Vérifié : round-trip PIL (les tEXt + XMP se relisent, `trainedAlgorithmicMedia` présent).
- Effet en prod : redeploy Modal + rebuild/redeploy cloud + restart Electron.
- Follow-ups NON faits : label VISIBLE deepfake (Art. 50(4)) sur le path likeness +
  signature C2PA complète (certificat). À voir si besoin.

## 2026-06-20 (P1 restants traités — rétention R2 + Sentry hardening + embedded python)

- **Rétention R2** (GDPR Art. 5(1)(e)) : `purgeTransientUploads()` ajouté au cron
  `scheduled()` du worker — supprime les inputs transients (`<uid>/masks/`,
  `<uid>/canvas/`) > 30 jours, borné à 1000 objets/run avec curseur tournant
  (`_meta/retention_cursor.txt`). Les meshes/images finaux (autres prefixes) sont
  conservés jusqu'à suppression du compte.
- **Sentry** : DSN absent en config (inactif → pas de fuite réelle). Durci quand même :
  `sendDefaultPii:false` + scrub `ip_address` (nodejs + edge). Commentaire ajouté :
  « si tu poses un DSN en prod → déclarer Sentry dans la privacy policy ». Pas ajouté
  à la policy car le service est inactif (sinon déclaration inexacte).
- **Embedded python (trad)** : `translate_prompt.py --strict` (exit 3 si argos
  indisponible) + wrapper `translate-prompt` (main.js) qui essaie l'embedded python
  d'abord puis fallback python système. Robuste en dev (argos système) ET en release
  (embedded + argos bundlé une fois packagé). **Restart Electron requis.**
- Déploiement worker : `cd cloud && npm run build && npx wrangler deploy`.

## 2026-06-20 (Fix code P1 de l'audit — SSRF, parental, REVOKE credits, licences)

Remédiation des P1 corrigeables en code (le reste = ops user : R2, légal) :
- **SSRF** : `handleGenerateBackView` (frontImageUrl) et le chemin t-pose (refImageUrl)
  forwardaient une URL arbitraire à Modal `_fetch_image` sans garde → ajout de
  `isTrustedAssetHost(env, …)` (worker.ts). Bloque 169.254.169.254 / IP privées.
- **Cohérence parentale** : back_view utilisait seulement `env.FABMESH_UNRESTRICTED`,
  pas l'état par-utilisateur → aligné sur text2image (`|| userState.unrestricted`).
- **REVOKE credits** : `add_credits`/`spend_credits` (security definer) n'étaient que
  `grant ... to service_role` sans `revoke from public` → ajout du REVOKE (sql/schema.sql).
  **Action user** : rejouer ces 2 lignes SQL sur Supabase (SQL editor).
- **Licences** : ajout HiDream-O1-Image (MIT) + Argos Translate (MIT/CC0) à
  THIRD_PARTY_LICENSES.txt (#31, #32). **Rebuild cloud requis** (`npm run build`) pour
  régénérer la page out/.
- Déploiement : worker.ts → `cd cloud && npm run build && npx wrangler deploy`.

## 2026-06-20 (Purge Pamela COMPLÈTE — historique réécrit + repush cleaned)

P0 « image de célébrité sur repo public » **RÉSOLU**. Étapes :
- Bundle de sécurité complet `/d/fabmesh-pre-pamela-purge.bundle` (182 Mo — contient
  ENCORE l'image, recovery only, à supprimer une fois certain que tout va bien).
- 31 worktrees de workflows retirés + 30 branches `worktree-wf_*` supprimées (bloquaient
  filter-repo).
- `git filter-repo --invert-paths --path-glob '*pamela*'` → 1719 commits réécrits,
  Pamela retirée de TOUTES les branches (master + feat + fix + 124 backups).
- Fichiers physiques restants (untracked/ignorés) supprimés : `logs/ip_sweep/_pamela*`,
  `images/pamela_anderson`, `meshes/pamela_anderson_*`, `logs/triposg_pamela.log` → 0 trace.
- Force-push des **128 branches cleaned** sur origin (backup off-site conservé SANS l'image,
  à la demande du user qui veut garder un backup GitHub si son PC crame).
- **RESTE (action user obligatoire)** : contacter le **support GitHub** pour purger le blob
  en cache — les vieux commits restent stockés côté GitHub par SHA jusqu'au GC. Sans ça,
  l'image reste techniquement récupérable via l'ancien SHA.

## 2026-06-20 (Audit sécu/RGPD/légal relancé + fix hard-floor CSAM sur 5 routes Modal)

Workflow d'audit (cybersécurité + RGPD + licences) relancé après les ajouts
récents (HiDream, traduction, insecte). Rapport complet confidentiel dans
`audit/RELEASE_READINESS_2026-06-20.md` (gitignored). Verdict : **NON en l'état**,
P0 bloquants (R2 bucket public exposant secrets admin + PII, image célébrité
`logs/ip_sweep/_pamela_*` trackée sur repo public, marquage IA Act Art. 50 absent).
- **Fix appliqué ici** : le hard-floor CSAM `_prompt_hard_floor()` (la « dernière
  ligne au générateur ») manquait sur 4 routes Modal (back_view, image_op
  `modify`/`mask_inpaint`, sheet) ; ajouté aussi sur `auto_inpaint`. Les 8 routes
  free-text appellent désormais `_prompt_hard_floor()` → HTTP 403 (miroir de
  text2image/tpose/rectify). Restaure l'invariant « unbypassable » annoncé dans
  le code. **Nécessite un redeploy Modal pour effet en prod.**
- Reste P0/P1 (à traiter avec le user) : poser `R2_URL_SIGNING_SECRET` + désactiver
  l'accès public r2.dev + rotation admin pw/TOTP ; purge historique git Pamela +
  force-push ; marquage IA Act ; entité légale/SIRET/DMCA/NCMEC ; rétention R2 ;
  Sentry non déclaré ; page licences (HiDream/Argos manquants).

## 2026-06-19 (Auto-traduction des prompts FR/ES/ZH/HI/AR → anglais)

L'appli gère 6 langues UI (en/zh/hi/es/fr/ar) mais SDXL/RealVisXL/HiDream veulent
de l'anglais. Ajout d'une traduction auto **offline** de la saisie utilisateur vers
l'anglais AVANT l'application des templates anglais de type d'asset.
- Moteur : **Argos Translate** (licence **MIT**, commercial OK), CPU-only (marche
  sur toute machine end-user, même sans GPU), ~150 Mo/langue, offline. Choisi vs
  M2M-100 (MIT aussi mais ~1.9 Go + GPU) pour la déployabilité. NLLB écarté (CC-BY-NC).
- `scripts/translate_prompt.py` : `--text --from <code>`, fail-open (si trad indispo →
  passe le texte tel quel), stdout UTF-8 (ar/hi/zh). Testé : « fourmi géante rouge »→
  « red giant ant », etc.
- Câblage : IPC `translate-prompt` (main.js) + expose preload + `translateUserPrompt()`
  (renderer, lit `localStorage 'fabmesh.lang'`, en = no-op). Branché aux 3 points :
  np-enhance, ws-enhance, et la génération (avec garde `wasEnhanced` pour ne pas
  re-traduire un prompt déjà enrichi/anglais). Reste : portage cloud (endpoint serveur)
  + bundling des packages Argos à l'empaquetage. Restart Electron requis (main/preload).

## 2026-06-19 (HiDream-O1 = 2e moteur image local, validé + câblé desktop)

HiDream-O1-Image (Qwen3-VL ~17B) tourne en local **FP8** sur la RTX 5080 via un venv
isolé `d:/ai_eval/HiDream` (run_fp8.py — transformers/diffusers purs, SANS ComfyUI).
Peak VRAM 10.995 GB, ~43 s / 28 steps @ 2048², qualité photoréaliste propre.
- Loader fp8 : `from_pretrained` garde les tenseurs float8_e4m3fn ; un forward_pre_hook
  déquantise fp8→bf16 par nn.Linear (équiv. manual_cast ComfyUI). 2 pièges résolus :
  (1) recast embeddings/norms/lm_head en bf16 (sinon `torch.where(bf16, fp8)` crashe) ;
  (2) scheduler "flash" + noise params pour le t2i (flow_match = scheduler d'édition →
  laissait un bruit "neige" haute fréquence). Ce n'était PAS un défaut du fp8.
- Câblé comme 2e moteur image SÉLECTIONNABLE (desktop P1) sans toucher l'env RealVisXL :
  dropdown `ws-engine` ré-exposé (RealVisXL / HiDream-O1), `ENGINE_LABELS` +
  `_hideFixedEngineFields` + branche `engine==='hidream'` dans main.js (spawn run_fp8.py
  via SON venv, HF_HOME→D:, boucle numImages). Périmètre confirmé par mapping : seuls
  text2image (✅) et Modify/edit (🟡) routables vers HiDream ; inpaint/back-view/
  multi-view/ControlNet restent SDXL (structurel). Cloud (Modal bf16) = étape suivante.
- Restart Electron requis (main.js modifié) pour tester le dropdown.

## 2026-06-18 (#1 BLOCKER LEVÉ : nvdiffrast (NC) → kaolin sur le mesh_image Modal — VALIDÉ)

Le mesh cloud (Modal mesh_image) installait + shippait nvdiffrast (NVIDIA Source Code
License = NON-COMMERCIAL) via le chemin de texturing TRELLIS-2 → bloqueur commercial dur.
Le desktop était déjà remédié (shim Kaolin), mais PAS le cloud. Porté sur Modal :
- `-nvdiffrast` (retiré le git clone + pip install nvdiffrast v0.4.0).
- `+kaolin==0.17.0` (wheel cp311/torch-2.4.1/cu124, Apache-2.0 ; SEUL render.mesh utilisé,
  jamais kaolin/non_commercial).
- ENV TRELLIS2_USE_KAOLIN_RASTER=1 (le texturing patché utilise le shim par défaut).
- o_voxel/postprocess.py (2e importeur) patché vers le shim.
Galère résolue en 3 itérations (un échec ≠ casse prod, l'ancienne image reste live) :
1. ABI numpy : kaolin 0.17 a un ext Cython numpy-1.x → pin numpy<2 (1.26.4). torch/o_voxel/
   cumesh sont des ext torch (numpy-agnostic) → safe.
2. deps kaolin manquantes (pygltflib/usd-core/dataclasses-json...) à cause de --no-deps →
   `pip install kaolin pygltflib usd-core` (avec deps) puis re-pin numpy<2.
3. circular import : kaolin fait `import nvdiffrast` non protégé → faux paquet nvdiffrast
   LAZY (importe le shim seulement à l'APPEL, jamais au load) → pas de circular.
Build guard rejoue le chemin runtime (trellis2 sur path) ; smoke-test GPU :
rast (1,64,64,4) + interp (1,64,64,3) + 788 px → **PASS**. DÉPLOYÉ.
Backups : backup-nvdiffrast-modal-20260618-213847, backup-finish-rest-20260618-223647.

## 2026-06-18 (SÉCURITÉ CRITIQUE : hard-floor CSAM non contournable — desktop+cloud+Modal)

Audit (workflow marketplace) + traçage code : le mode `unrestricted` (parental off)
court-circuitait TOUTE la modération — combos enfant×sexuel/violence inclus — sur les
3 surfaces : desktop main.js:306/333, cloud nsfw_filter.ts:104, Modal app.py:490/777.
=> un user en unrestricted pouvait générer du contenu enfant×sexuel (CSAM). Blocker pénal.
FIX : `checkHardFloor()` (mots-clés toujours illégaux + combos mineur×sexuel/violence)
exécuté AVANT tout bypass `unrestricted`, miroir exact sur les 3 surfaces :
- desktop : checkHardFloor + appel dans checkPromptSafety ET checkPromptSafetyAI (restart requis).
- cloud : checkHardFloor exporté + appel dans checkPromptSafety — PAS encore déployé
  (worker.ts en cours d'édition par le workflow R2 ; partira avec le batch R2).
- Modal : _prompt_hard_floor() dans text2image + tpose + backview, raise 403. **DÉPLOYÉ** (8s).
Note : l'audit ne voyait que le desktop (P0-3) ; vrai périmètre = stack entière.
P0-1 (crédits forgeables) re-vérifié FERMÉ sur DB live (anon → 401 permission denied).

## 2026-06-18 (P1 sécurité : R2 signed URLs — objets privés/face photos plus publics — NON DEPLOYE)

Les objets R2 (incl. photos de visage uploadées) étaient atteignables à des
URLs `pub-*.r2.dev/<key>` permanentes, devinables et non authentifiées (P1).
Correctif : le worker `cloud/src/worker.ts` génère désormais des URLs signées
HMAC-SHA256 expirantes servies depuis sa propre origine.

- Nouveau helper `signedR2Url(env, key, kind)` (kind=image 24h / mesh 7j /
  export 30j) + `r2ContentType(key)` + route `GET /r2/<key>?exp&sig`
  (`handleSignedR2`) qui vérifie sig+exp (timingSafeEqualHex, déjà constant-
  time) puis stream `env.MESHES.get(key).body`. Chaîne signée = `v1:<key>\n<exp>`,
  MAC hex minuscule (même convention que verifyStripeSignature).
- NON-BREAKING : si `R2_URL_SIGNING_SECRET` (Worker SECRET) est non défini,
  fallback sur l'ancienne URL `R2_PUBLIC_URL/<key>` + `console.warn` une fois ;
  la route `/r2/` renvoie 404. Le signing s'active dès que le secret est posé
  (`wrangler secret put`), sans redeploy.
- 28+ générateurs d'URL R2 client-facing basculés sur `await signedR2Url(...)`
  (uploadGlbToR2, persistModalGlb, callModal*, handleUpload*, handleListMeshes/
  handleProjects/handleCloudProjects, anim/rig status, handleAdminUserImages/
  Rigs, contact screenshot, mask inpaint, mesh-op…).
- Re-sign-on-read : `jobs.mesh_url`, `user_assets.r2_path`,
  `jobs.options.sourceImage` stockent maintenant la KEY brute (pass-through si
  legacy full-URL) ; re-signées à la lecture → liens jamais périmés en base.
- handleMarketDownload stream via `env.MESHES.get(key)` (robuste après
  désactivation du bucket public) ; handleProxyImage court-circuite les URLs
  `/r2/` self-origin ; handleAnimCopy/handleAnimDelete/meshes-delete parsent
  les 3 formes (signée /r2/, r2.dev legacy, key brute).
- Exports CSV/XLSX admin + GDPR JSON : colonnes `mesh_key`/`download_url` re-
  signées TTL export 30j + note d'expiration.
- Docs : `.env.example`, `wrangler.toml`, `DEPLOY_CLOUD_STEP_BY_STEP.md`.
- ACTION USER (après deploy + secret + vérif live) : désactiver l'accès public
  r2.dev sur le bucket dans le dashboard Cloudflare → ferme P1.
- Bundle wrangler `--dry-run` OK. PAS déployé (le user déploie).

## 2026-06-16 (KPI réels : coût Modal réel + marge réelle + ventilation par app — DEPLOYE)

Les KPI admin (COST MODAL / MARGIN, marge "95%") utilisaient l'estimation par-op (fausse).
Maintenant ils s'appuient sur la VRAIE facture Modal (poller modal billing report).
- poller : pousse usage total + by_app (somme du Cost par Description d'app).
- worker : handleAdminModalUsageIngest stocke by_app ; handleAdminStats lit
  _meta/modal_real_usage.json -> real_cost_eur (usage x USD_TO_EUR), real_margin_eur
  (= revenue net - real_cost), real_usage_by_app dans l'objet revenue ; /api/admin/modal-credits
  renvoie aussi real_usage_by_app.
- admin.html : Overview + Finance affichent "Marge RÉELLE" + "Coût Modal RÉEL" (+ % réel) a cote
  des versions "estimée" ; la section Modal liste la conso PAR APP (pour distinguer ventes vs R&D).
- Aussi : setBudget réévalue l'alerte immédiatement ; libellé "Limite d'usage Modal".
- Seed : $58.07 sur 7 apps poussé. DEPLOYE Version 34c35e8f.
NB : revenue net est déjà net de Stripe (comment worker.ts ~9597). Le gros du coût Modal réel
vient de anim/rig/train-anytop (R&D AnyTop abandonnée), pas des générations payantes.

## 2026-06-16 (Modal: VRAIE conso via `modal billing report` + poller — DEPLOYE)

L'estimation worker diverge trop du reel ($5.90 vs ~$58). Modal expose la vraie facturation :
`modal billing report --for "this month" --json` (= API modal.billing.workspace_billing_report).
Le Worker CF ne pouvant pas lancer le CLI Modal -> poller scripts/modal_usage_push.py : somme la
conso reelle du cycle + POST /api/admin/modal-usage (auth header x-ingest-secret == MODAL_USAGE_SECRET,
compare avec .trim() ; AJOUTER un user-agent sinon Cloudflare 403 sur Python-urllib).
- worker.ts : handleAdminModalUsageIngest -> _meta/modal_real_usage.json ; _maybeAlertModalBudget +
  endpoint /api/admin/modal-credits PREFERENT l'usage REEL (frais <26h) sinon l'estimation
  (_meta/modal_spend_total.txt). Reponse: total_spent=usage best-available, usage_source,
  real_usage(_ts/_fresh), estimate_spent, remaining, alert.
- admin.html : note de source sous la grille (reel Modal vs estimation + age).
- Seed valide : $58.07 pousse (= dashboard Modal). DEPLOYE Version d5958c42.
- ACTIONS USER : `cd cloud && npx wrangler secret put MODAL_USAGE_SECRET` (ta valeur — j'ai mis un
  secret TEMP pour le seed) ; planifier le poller (Task Scheduler horaire OU GitHub Action) avec
  MODAL_USAGE_SECRET + FABMESH_WORKER_URL ; saisir le budget Modal ($65) dans admin Finance pour armer
  l'alerte ; `wrangler secret put RESEND_API_KEY` pour l'email.

## 2026-06-16 (Admin: alerte budget Modal + suivi conso — DEPLOYE master)

Feature sur MASTER (deploye Version 50bc332f) : alerte quand le budget Modal s'epuise + suivi.
- worker.ts : total cumule depuis la derniere recharge (_meta/modal_spend_total.txt), incremente dans
  checkAndIncrementModalSpend (+ decremente au refund). _maybeAlertModalBudget detecte <=15% (low) /
  <=0 (empty) -> ecrit _meta/modal_alert.json (debounce, jamais de downgrade) + EMAIL via Resend
  (_sendAdminAlertEmail, no-op si RESEND_API_KEY absent). Reset (spend_total=0 + delete alert) quand
  l'admin met a jour le budget. Endpoint /api/admin/modal-credits renvoie desormais
  {total_budget, total_spent (since-topup), today_spent, remaining, alert}.
- admin.html : banniere fixe GLOBALE (tous onglets) cliquable -> Finance ; "remaining" colore selon
  sante ; checkModalAlert() au load + toutes les 5 min. (Le suivi conso Modal existait deja dans
  l'onglet Finance, deja protege par mdp.)
- ACTION USER pour l'email : `cd cloud && npx wrangler secret put RESEND_API_KEY`. Par defaut
  ALERT_FROM_EMAIL = onboarding@resend.dev (ne livre qu'a l'email du compte Resend) ; pour un envoi
  fiable, verifier un domaine dans Resend + `wrangler secret put ALERT_FROM_EMAIL`. Destinataire =
  ADMIN_EMAILS (fabien65400@hotmail.fr).

## 2026-06-16 (Drop-to-create: popup nom + Unlock NSFW ; audit legal+securite)

- Bug "dossier bitch" (DESKTOP) : drop d'une image sur le grid -> importDroppedFile
  avec projectName:null -> le main DERIVAIT le nom du FICHIER (main.js:3572) sans
  jamais demander. Fix :
  - main.js `import-dropped-file` : la branche "nouvelle image" utilise `projectName`
    s'il est fourni (sinon baseName) -> respecte le nom choisi par l'user.
  - src/renderer/index2.js : drop sur le grid -> stash `window.__pendingDroppedFile`
    + ouvre la popup New Project (nom pre-rempli depuis le filename). np-create importe
    le fichier dans le projet nomme puis `openProjectByName`. np-cancel / btn-new-project
    nettoient le pending.
  - Unlock NSFW : helper `_nsfwBlockedUnlock` (customConfirm + toggleParentalControl) ;
    quand une image droppee/importee est flaggee NSFW on propose de DEVERROUILLER le
    filtre (PIN) au lieu de juste bloquer -> couvre drop-intoProject ET drop-to-create.
  - main.js modifie => RESTART Electron requis.
  - CLOUD : avait deja le pattern __pendingDroppedFile + popup (cloud/public/app/index2.js
    :18262 + np-create:1314) -> aucun changement cloud necessaire.
- Audit legal + securite (workflow 72 agents, 60 findings retenus : 7 P0 / 12 P1 / 26 P2
  / 15 P3). Rapport complet garde EN LOCAL UNIQUEMENT dans `audit/` (dossier gitignore) :
  ne PAS publier sur le repo public, il detaille des failles encore actives. Plusieurs P0
  bloquent une mise en vente -> voir le rapport local avant de commercialiser.

## 2026-06-16 (i18n : 6 langues + fix flicker + parité desktop)

- **6 langues les plus parlées** : EN (source) + FR (inline dans i18n.js) + 4
  fichiers auto-enregistrés `lang/{es,zh,hi,ar}.js` (Español, 简体中文, हिन्दी,
  العربية). Chaque fichier = `FabI18n.register('<code>', {...})` (~440 paires
  traduites des clés FR par 4 agents). Architecture "1 fichier/langue" = scalable
  (ajouter une langue = 1 fichier + 1 <option> + 1 drapeau, pas de gros monofichier).
- **Fix flicker EN<->FR pendant la génération** : l'observer re-traduisait via
  setTimeout(250ms) -> l'anglais flashait à chaque re-render (renderJobs 1s).
  Maintenant on traduit les sous-arbres AJOUTÉS *synchroniquement* dans le callback
  de l'observer (avant le paint) -> plus de flash. Ciblé (pas tout document.body).
- **Fix boutons à icône non traduits** ("💾 Export", "🪄 Modify", "⬡ Import",
  "☐ Select all"...) : le nœud texte vaut "💾 Export" donc la clé "Export" ne
  matchait pas. Fallback _translateNodeValue : si la clé complète n'existe pas,
  on enlève le préfixe emoji/symbole et on traduit le reste, en gardant l'icône.
- **Drapeaux SVG es/zh/hi/ar** + **RTL** : applyLang met dir=rtl quand ar actif.
- **Clés FR manquantes** ajoutées (section Compte/Session cloud, toggle parental
  Unrestricted/Lock, grille projets rendue par JS : No image / Create a new project).
- **Parité desktop** : i18n.js + lang/*.js copiés dans src/renderer/, <option> +
  <script> ajoutés dans index2.html. Tout fonctionne aussi sur desktop (Ctrl+R).

## 2026-06-16 (Auto-Inpaint cloud Preview fix + drapeau + i18n FR complet)

- **Modal redeploy** (modal_app/app.py depuis la RACINE du repo, pas depuis modal_app/
  sinon le mount `modal_app/front_tpose_skeleton.png` cherche `modal_app/modal_app/...`
  et echoue) : l'op `segment` (CLIPSeg detect-only pour "Preview mask") + les fixes
  VAE upcast + CLIPSeg 512px etaient codes mais JAMAIS deployes. Symptome cloud : le
  bouton "Preview mask" n'affichait aucun masque ET ne deduisait aucun credit -> en fait
  l'appel `op:'segment'` etait rejete par l'ancien Modal -> le worker remboursait
  (handleSegmentPreview catch -> addCredits). Redeploy OK (`MyFabmeshBackview.router`
  live) => Preview renvoie le masque + deduit 1 credit.
- **Badge cout sur le bouton Preview** (cloud-overrides.js) : MODAL_CREDIT_CONFIG
  'modal-auto-inpaint' a maintenant `previewBtn:'ai-preview-btn', previewCost:'segment'` ;
  _COST_DEFAULTS gagne `segment:1` ; installModalCreditBadges injecte le badge sur le
  previewBtn. Le bouton "Preview mask" affiche desormais ⚡1 (Apply reste ⚡3).
- **Drapeau langue** (i18n.js + index.html x2) : Windows n'affiche pas les emoji-drapeaux
  -> petit drapeau SVG inline (#lang-flag) a gauche du <select>, mis a jour par applyLang.
- **i18n FR complet** : +358 paires extraites de index.html (tout l'UI : steps, modals,
  settings, calibration, export, publish, paint, mesh-edit, about, contact, usage). Le
  francais couvre maintenant quasi tout l'UI statique (avant ~90 chaines starter).

## 2026-06-16 (i18n : systeme de traduction + selecteur de langue, desktop+cloud)

User veut pouvoir choisir la langue (tout est en anglais en dur). Choix : systeme i18n
maison (pas de framework). Scaffold :
- i18n.js (cloud/public/app/ + src/renderer/, identiques) : I18N = dict par langue
  (anglais = source -> traduction). applyLang() parcourt le DOM (text nodes +
  placeholder/title/aria-label), cache l'anglais original sur chaque node (__i18n) pour
  pouvoir revenir a l'anglais, et swap. MutationObserver childList-only (debounce 250ms,
  pas de boucle) re-traduit le contenu ajoute dynamiquement. t() pour les chaines JS.
  Zero impact en anglais (default). Demarrage francais starter (~90 chaines des ecrans
  principaux) ; les non-traduites restent en anglais (fallback) -> on complete le dict
  incrementalement.
- Selecteur <select id="lang-select"> (English/Francais) dans Settings, persiste
  localStorage 'fabmesh.lang', auto-wire par i18n.js.
- <script src="i18n.js"> charge avant index2.js dans les 2 index.html.
Desktop : Ctrl+R. Cloud : build (copie i18n.js dans out/) + deploy.

## 2026-06-16 (Auto Inpaint : message 1ere detection + facturation de la detection cloud)

- 1ERE DETECTION ~15s (cold-load CLIPSeg / cold-start GPU cloud) = NORMAL. Ajoute un
  message dynamique sous le spinner : "Warming up the AI... first detection ~15s, then
  instant" au 1er passage (flag _aiFirstDetectDone), puis "Detecting target...". Label
  #ai-detect-label, desktop + cloud.
- FACTURATION detection cloud : chaque detection live = un appel GPU Modal -> ca coute.
  segment ajoute a PRICING_DEFAULTS (worker.ts, defaut 1 credit, PricingKey auto via
  keyof). handleSegmentPreview branche sur getPrice(env,'segment') (etait hardcode 1).
  Apparait auto dans le tableau de prix admin (data-driven) + description ajoutee dans
  admin.html PRICING_DESCRIPTIONS. Admin peut ajuster le cout.

## 2026-06-16 (Auto Inpaint : 3 fixes via workflow diagnostic — vitesse, precision, removal)

User : detection ~10s, masque pas assez precis, "laisser vide" regenere une porte au
lieu de la supprimer. + il veut le live-auto cloud (pas de bouton, comme desktop).
Workflow de diagnostic (3 agents) -> causes + fixes :
- CLOUD live-auto : retire le bouton Preview, detection auto debouncee (_aiSchedule
  Preview/_aiUpdateMaskPreview sur target/dilate) + spinner, comme desktop.
- VITESSE (10s = cold-load CLIPSeg au 1er appel) : preload CLIPSeg dans preload_models()
  (sdxl_server) AVANT "MODELS READY" -> 1ere detection = warm.
- PRECISION (CLIPSeg tourne en 352px par defaut -> logits blobby upscales 3x) : passe
  l'input a 512px (clipseg_processor.image_processor.size) dans sdxl_server.load_clipseg
  + modal_app/app.py (_get_auto_inpaint_models). + do_inpaint BILINEAR->LANCZOS.
- REMOVAL (trou en forme d'objet + prompt faible + strength 0.99 -> SDXL redessine
  l'objet) : prompt removal concret "solid plain wall, no door, no opening" + negative
  renforce (door/opening/hole/window/frame...) + strength 0.85 (vs 0.99). sdxl_server
  do_inpaint + modal_app/_auto_inpaint.generate.
Desktop : restart sdxl_server. Cloud : Modal redeploy + build/deploy (live-auto deja
deploye). Tout desktop+cloud.

## 2026-06-16 (cloud : re-ajout aperçu masque (bouton) lisse + spinner ; page GPU non-NVIDIA)

User "fais tout" apres avoir clarifie qu'il veut l'apercu masque aussi sur cloud (option
bouton, le live serverless = trop cher).
- CLOUD apercu masque RE-AJOUTE : bouton "Preview mask" + overlay rouge + SPINNER (anim
  spin) pendant la detection + invalidation au changement target/dilate. Reutilise l'op
  segment + segmentMask (dormants depuis le retrait precedent).
- Masque cloud LISSE : modal_app/app.py op segment upscale NEAREST -> LANCZOS (etait
  blocky). + detection deja assouplie (>60) cote _auto_inpaint.
- PAGE GPU : docs/index.html detecte le GPU via WebGL UNMASKED_RENDERER ; si non-NVIDIA
  (AMD/Intel/Apple/mobile) -> bandeau d'avertissement sur la carte Desktop + de-emphase
  (opacity + grayscale du CTA Store) + pousse le Cloud. Soft (laptops hybrides NVIDIA
  reportent l'iGPU Intel) -> de-emphase, pas masquage. Publie (push).
Cloud : build+deploy + Modal redeploy. Desktop apercu inchange (deja live+spinner).

## 2026-06-16 (Auto Inpaint : masque preview lisse + loading circle + detection assouplie)

User (desktop live mask preview, dessine avant Apply) : masque trop grossier + met
longtemps a apparaitre + detecter plus facilement.
- MASQUE LISSE (scripts/sdxl_server.py do_segment) : upscale CLIPSeg BILINEAR -> LANCZOS
  + masque feathered soft (GaussianBlur scale a l'image) pour l'overlay -> bords lisses
  au lieu d'un binaire blocky.
- LOADING CIRCLE : spinner (animation:spin existante) sur ai-source-img pendant la
  detection (avant: juste opacity 0.55). _aiUpdateMaskPreview montre/cache le spinner.
- PLUS RAPIDE : debounce du preview 550ms -> 300ms.
- ASSOUPLIR le seuil CLIPSeg (binary > 100 -> > 60, coverage floor 0.5 -> 0.2) sur les
  4 chemins de detection : sdxl_server.do_segment (preview) + do_inpaint (Apply local) +
  scripts/local_inpaint_bridge.py + modal_app/_auto_inpaint.py (cloud).
Desktop : restart sdxl_server (ou respawn idle) pour les changements .py. Cloud : Modal
redeploy. Preview = desktop-only (cloud n'a plus de bouton/preview, par choix user).

## 2026-06-16 (Paint Phase 1 : durete de pinceau + Invert/None selection — desktop+cloud)

User : "le Paint est trop basique, ameliorer (calques + pinceaux + selection)". Le Paint
a deja lasso/rect/wand + 7 pinceaux. Phase 1 (rapide, desktop ET cloud par nouvelle
directive de parite systematique) :
- DURETE de pinceau (slider paint-hardness 0-100). Le pen passe d'un bord net a un
  falloff radial doux (createRadialGradient inner=r*hard). 100% = net, bas = doux.
- Selection : boutons Invert (flip le masque 255<->0) + None (deselect). _paintClear
  Selection existait sans bouton.
Desktop : src/renderer/index2.{js,html}. Cloud : cloud/public/app/index2.{js,html}.
RESTE (Phase 2, le gros) : CALQUES (layers) = changement archi du CanvasManager mono-
canvas -> multi-calques (add/del/reorder/opacite/visibilite, paint->calque actif,
composite a la save). A presenter/confirmer avant le gros build.

## 2026-06-16 (cloud : retrait du bouton "Preview mask" de l'Auto Inpaint)

User : le bouton detect/Preview cloud (mon ajout) ne semble jamais detecter (proba
cold start GPU "Server warming up") + n'existe pas sur desktop -> "le retirer (comme
desktop)". Retire l'UI (bouton ai-preview-btn + overlay ai-mask-overlay + handler +
_aiHideMaskOverlay) de cloud index2.js/index.html. La detection reste DANS Apply
(CLIPSeg + inpaint en 1 etape, comme desktop). Backend laisse dormant : l'op "segment"
(app.py), la route /api/segment-preview (worker) et le shim segmentMask restent en
place mais plus appeles (pas de redeploy Modal/worker necessaire pour le retrait UI).
A FAIRE : user doit tester APPLY pour confirmer que la detection CLIPSeg marche
vraiment (vs juste cold start). Prochain chantier : ameliorer le Paint desktop
(calques + pinceaux + outils de selection).

## 2026-06-16 (parite cloud finitions : engine caches + variant refondu en 1 panneau)

User a repere 2 ecarts visuels cloud vs desktop sur captures :
- ENGINE : les selects engine (Image ws-engine, Mesh ws-3d-engine, Rig ws-rig-engine,
  + Modify mod-engine) etaient encore visibles sur cloud alors que desktop les masque
  depuis ce matin. Porte le _hideFixedEngineFields desktop sur cloud index2.js : cache
  la .form-row de chaque select engine mono-option (garde le <select> cache dans le DOM
  pour .value). PAS ws-anim-engine (3 options dont 2 disabled -> reste, comme desktop).
- VARIANT : le modal cloud avait encore 2 onglets (Re-roll seed | Img2img strength),
  desktop = 1 panneau (apercu + Variation amount + hint descriptif + Number of variants
  + Generate variant). Refonte complete du modal-variant cloud sur le modele desktop
  (var-source-img, var-strength 25-90 %, _updateVarStrengthHint Subtle/Moderate/Strong/
  Very-strong, var-count, boucle count x img2img). Splice par ancres (Python).
Cloud only, build+deploy.

## 2026-06-16 (parite cloud 11/11 : inpaint mask preview via bouton "Preview mask")

User a choisi "Bouton Preview mask" (vs live). Implemente sur 4 niveaux :
- modal_app/app.py : nouvelle op "segment" sur l'endpoint image_op -> CLIPSeg _segment
  detect-only (reutilise _auto_inpaint._segment, models lazy de _get_auto_inpaint_models),
  renvoie le masque PNG (blanc sur noir) a la taille d'origine. Pas de SDXL inpaint.
- cloud/src/worker.ts : op 'segment' dans callModalImageOp (union + body target_text/
  dilate) + handler handleSegmentPreview (auth + budget GPU + quota user, cout 1 credit,
  refund si echec) + route /api/segment-preview + MODAL_PATHS.
- cloud/public/app/meshyAPI-cloud.js : shim segmentMask -> POST /api/segment-preview,
  renvoie { success, maskUrl }.
- cloud/public/app/index2.js + index.html : bouton "Preview mask" dans le modal Auto
  Inpaint + overlay #ai-mask-overlay (mix-blend screen + tint rouge) sur ai-source-img.
  Le masque est invalide (cache) quand target/dilate change ou a l'ouverture.
1 appel GPU a la demande (pas de live-on-keystroke, inadapte au serverless). Modal
redeploy + cloud build/deploy requis.

## 2026-06-16 (parite cloud vague 3 : variant-modal ; inpaint-preview = decision design)

- variant-modal : le tab img2img/strength cloud ne faisait qu'1 image. Ajout d'un
  slider "Number of variants" (var-strength-count) + boucle N x img2img au strength
  choisi (le backend prend un seed frais par appel) -> combine variation-amount ET
  count comme le modal-variant desktop. cloud index2.js + index.html.
- inpaint-preview (live CLIPSeg mask preview) : NON porte tel quel. L'op _segment
  existe deja (modal_app/_auto_inpaint.py:24) mais un preview LIVE a chaque frappe =
  une invocation GPU Modal par changement (cold start minutes, coute cher) -> inadapte
  au serverless. La bonne version cloud = un bouton "Preview mask" explicite (1 appel
  a la demande), pas du live-on-keystroke. A confirmer avec le user avant de coder
  (op segment dans app.py + worker route + segmentMask API + overlay renderer).

## 2026-06-16 (parite cloud vague 2 : emissive-fill, symmetrize-erase, strength-hint, unlock x2)

Suite vague 1. Ports cloud (cloud/public/app/index2.js + index.html) :
- emissive-fill : _paintFloodFill recoit un outCtx -> Fill detecte la region sur
  l'image mais peint sur l'overlay emissive (handler + _paintLiveRefillIfFill aussi).
- symmetrize-erase : boutons Paint/Erase (mask mode) + symState.erasing + maskData =
  erasing ? 0 : 255.
- engine strength-hint : _updateModStrengthHint (Low/Medium/High/Very-high) sur le
  slider Modify. (Labels statiques des dropdowns engine = cosmetique, non porte : le
  ws-engine cloud n'a qu'1 option fonctionnelle.)
- unlock-jobdetails + unlock-rerun : gatedRun memorise _lastGatedRun, _unlockThenRetry
  rejoue l'op apres unlock ; branche content-filter dans reportPipelineError (Unlock
  inline) + bouton job-details-unlock dans le modal Task-failed. Cloud only.


## 2026-06-16 (parite cloud vague 1 + harmonisation des styles)

Suite a la verif de parite (workflow 43 agents) : 11 features du matin en retard sur
cloud. User : "Tout (les 11)". Vague 1 :
- queued-orange : label "queued" passe en orange (cloud index2.js).
- style-no-overwrite : deriver une version ne re-tague plus le style de la source
  (cloud index2.js, suppr. _saveImageStyle(tgt,style), parite f37af87).
- emissive _emKey : normalisation des cles (backslash->slash + lowercase) du cache
  emissive cloud (parite 9797d93) -> le badge ampoule matche sur URLs R2.
- STYLES HARMONISES (au-dela de la demande initiale) : User a signale que le dropdown
  STYLE de generation etait bien plus pauvre que le menu de re-stylisation. Cree un
  CATALOGUE CANONIQUE de 32 styles (+ Custom) via script generateur, applique aux 3
  pickers (ws-asset-style, np-asset-style, ws-style-menu) sur desktop ET cloud. Ajout
  des 10 cles manquantes (synthwave, horror, chrome, marble, carved-wood, stained-
  glass, holographic, figurine, graffiti, art-deco) dans ASSET_STYLE_PROMPTS des 2
  renderers. Desktop : Ctrl+R. Cloud : build+deploy.


## 2026-06-16 (fix — asset "building" generait un VILLAGE entier dans une image)

User : "jai voulu generer une maison avec construction stages mais ca ma fait plein
de maisons dans une seule image". CAUSE : le template asset-type "building" etait le
SEUL asset inanime reste sur "isometric angle" (vehicle/prop/environment avaient deja
ete bascules en "strict front view" justement pour tuer le doublage). "isometric
angle" + architecture = prior SDXL "diorama de village isometrique" -> tuile 30
maisons. Et tous les "ONE building only / no duplicate" etaient dans le prompt POSITIF
(SDXL ignore/renforce la negation).
FIX (desktop + cloud) :
- Renderers (src + cloud index2.js) : template building "isometric angle" -> "strict
  front view, facing camera, ... not a village, not a town". Re-applique a la gen via
  buildFullPrompt (l'ancien isometric est strippe par stripKnownPromptSuffixes).
- modal_app/_prompts.py:22 : meme correction sur le framing backend cloud.
- Negative prompts : nouvelle branche dediee building/environment ANTI-VILLAGE
  (village, town, city, multiple buildings, rows of houses, aerial view, isometric
  city, tiled, diorama...) dans scripts/local_juggernaut_bridge.py (branche elif) ET
  modal_app/_realvis.py (_ANATOMY_NEG building/environment, weighted, <77 tokens).
Desktop : Ctrl+R + re-gen suffit (renderer + bridge respawn). Cloud : build+deploy +
Modal redeploy requis.


## 2026-06-16 (port — parite cloud : fixes desktop du matin portes sur Cloudflare + Modal)

User : verifier que tout ce qu'on a fait ce matin est sur la version cloud, plan
d'action, puis "Tout (backend + UI)". Audit de parite -> 2 bugs backend + 4 fixes UI.
BACKEND (modal_app) :
- app.py : upcast_vae() apres les casts fp16 sur les 3 pipelines RealVis/ControlNet
  (lignes ~419, ~624, ~1178) -> corrige les images grises (VAE SDXL fp16 NaN), meme
  bug que le desktop. Caste au snapshot (CPU) ; .to("cuda") sans dtype preserve fp32.
- _nsfw.py : make_blocked_placeholder passe du placeholder gris muet au tampon rouge
  NSFW (fond sombre + bordures rouges + gros "NSFW" + sous-titre). Cascade de polices
  DejaVu(/usr/share/fonts) -> arialbd -> load_default(size) scalable -> bitmap. Pas
  de .ttf a bundler.
UI (cloud/public/app) :
- index2.js : stride emissive 4*64 -> 4 (2 endroits : badge ampoule + emissivePainted)
  pour ne plus rater les traits fins ; regex _jobStepIndex + auto[- ]?inpaint (etape
  visible pendant la gen) ; handler Opacity rappelle _paintLiveRefillIfFill (refill
  live de la derniere zone Fill) ; New Project = blocage in-popup (np-block-msg) +
  bouton Unlock (toggleParentalControl puis retry np-create) au lieu d'un toast.
- index.html : ajout np-block-msg + bouton np-unlock dans la modale New Project ;
  ai-dilate-hint sous le slider Detection padding (auto inpaint).
DEPLOY : cloud build + wrangler deploy OK (live sur myfabmesh-cloud). Modal redeploy
BLOQUE : "Workspace billing cycle spend limit reached" -> backend pas encore live,
a relancer (modal deploy modal_app/app.py) quand la limite est relevee.
NOTE : app.py laisse non-committe (porte du WIP pre-existant inference_bytes pour le
batch AnyTop) ; seul _nsfw.py est committe cote backend.


## 2026-06-16 (feat — tampon NSFW rouge sur les images bloquees)

User : si une image est grisee a cause du NSFW, mettre un tampon rouge NSFW.
(Les grises du slider qualite etaient en fait le VAE fp16, pas NSFW.) Pour les
VRAIES images bloquees par le scan ViT du bridge, le placeholder gris sombre +
petit texte devient un tampon clair : fond sombre + bordure rouge + gros "NSFW"
rouge + sous-titre "Blocked by content filter". Bridge respawn par gen.


## 2026-06-16 (feat — emissive : Fill emissive-aware + stockage fichier projet)

User : (b) verifier que l'emissive est generee+stockee dans le dossier projet,
(c) les outils paint doivent marcher pour emissive.
- (c) Les pinceaux (pen/spray/ink/smudge/eraser) passaient deja par onPaint->
  _paintStroke (emissive-aware). Le trou = FILL : _paintFloodFill recoit un
  outCtx optionnel -> detecte la region sur l'image mais peint sur l'overlay
  emissive. Le re-fill live (sliders) gere aussi l'emissive (fillEmissive flag).
- (b) Avant : emissive juste en localStorage (dataURL), PAS de fichier, PAS
  passe a la 3D. Ajout IPC save-emissive-file -> ecrit images/<proj>/_emissive/
  <base>.png (sous-dossier non liste dans la gallery). Appele a la sauvegarde
  paint. (Reste a brancher sur la gen 3D comme emissive map -> a faire.)
main.js+preload -> restart Electron.


## 2026-06-16 (fix — images grises = VAE SDXL fp16 instable (NaN), upcast fp32)

User : changer le slider qualite donne des images toutes grises. Diagnostic :
ref_0/ref_1 gris plats (avg ~165, variance ~0). CAUSE : local_juggernaut_bridge
castait le VAE de SDXL en fp16 (pipe.vae.to(torch.float16)). Le VAE SDXL est
numeriquement INSTABLE en fp16 -> overflow NaN sur les latents -> decode un gris/
noir uni. Certains step counts declenchent l'instabilite (d'ou le lien slider).
FIX : pipe.upcast_vae() (fp32, diffusers gere le decode fp16->fp32 ; fallback
vae.to(float32)) sur les 2 chemins (RealVis XL + ControlNet Lightning). PAS
NSFW (le blanc NSFW serait noir/30, pas 165). sdxl_server (img2img) laisse tel
quel (part d'une vraie image, latents stables, pas de gris). Bridge respawn par
gen -> pas de restart.


## 2026-06-16 (fix — badge emissive 💡 (clé chemin) + masquer champ ENGINE)

1. BADGE EMISSIVE invisible après paint : _emissiveLayerSet/Get/Has utilisaient
   String(imgPath) brut comme clé du Map. result.path (sauvegarde, backslashes)
   et img.path (liste projet) pouvaient différer (slash/casse) -> has() ratait ->
   pas de badge 💡 sur la version peinte. FIX : _emKey() normalise (\\ -> /,
   lowercase) pour set/get/has -> match fiable.
2. CHAMP ENGINE masqué : chaque étape a un seul moteur, l'user ne le change pas.
   IIFE _hideFixedEngineFields cache la form-row (Image/3D/Rig) ou le label+static
   (Modify modal) tout en gardant le <select> caché (les générateurs lisent
   toujours .value). Renderer -> Ctrl+R.

User : "déplacer les sliders devrait mettre à jour la dernière zone peinte".
Pour l'outil Fill : au clic, on stocke paintState.fillSnapshot (canvas pré-fill)
+ fillLastPoint (point seed). _paintReapplyFill() restaure le snapshot puis
re-flood-fill depuis le seed avec opacity/tolerance/colour courants (pas de
nouvel undo : le pushUndo du clic reste l'unique point). Branché sur les sliders
opacity + tolerance + le color picker. fillLastPoint vidé au changement d'outil
(stale). Renderer -> Ctrl+R.

3 bugs Symmetrize signalés :
1. APPLY CASSÉ ("Task failed: Missing args") : sym-apply envoyait
   { imagePath } à save-image-data-url qui attend { basePath } -> basePath
   undefined -> "Missing args". Corrigé imagePath->basePath.
2. AXE PARFOIS INVISIBLE : la ligne verte (#22c55e) se noyait sur les zones
   claires. Ajout d'un halo noir sous la ligne + vert plus vif (#3bff6a) +
   handle avec contour noir -> visible sur tout fond.
3. ERASE EN MODE MASK : ajout boutons Paint/Erase (sym-paint-mode/sym-erase-mode)
   + symState.erasing ; _symPaintMask écrit 0 (erase) ou 255 (paint). Reset sur
   Paint à l'entrée du Mask mode.
Aussi (commit precedent 998384b) : bouton Variant cable (re-roll img2img seed
aleatoire ; IPC img2img forwarde le seed) + curseur color picker aligne (rect
container au lieu du canvas decale). main.js (img2img seed) -> restart Electron.

User : "possible de montrer le masque sélectionné en temps réel avant la
génération ?". Implémenté : détection seule (pas d'inpaint).
- sdxl_server.py : load_clipseg() (charge SEULEMENT CLIPSeg ~400MB, pas
  l'inpaint ~6GB) extrait de load_inpaint ; do_segment() recalcule le masque
  (même pipeline CLIPSeg+seuil>100+dilate+blur que do_inpaint) et sauve un
  OVERLAY rouge (Image.composite(blend(img,red,0.55), img, mask)) ; route
  /segment.
- main.js : IPC segment-mask -> sdxlServerCall('/segment') -> overlay dans un
  fichier temp réutilisé (fabmesh_mask_preview.png). preload : segmentMask.
- renderer : dans le modal Auto Inpaint, debounce 550ms sur ai-target + ai-dilate
  -> segmentMask -> swap ai-source-img vers l'overlay (cache-busté), opacité 0.55
  pendant la détection, ignore les réponses stale, revient à l'image si rien
  détecté. main.js+preload -> restart Electron.

## 2026-06-16 (fix v2 — op image réutilisant SDXL : bypass total du gate VRAM)

Le fix v1 (soustraire la VRAM du moteur) ne suffisait pas : (14.0 − 6.6) + 8 =
15.4 GB = 97% > limite VRAM 90% -> toujours queué. La vraie nature : une op
image qui réutilise le serveur SDXL déjà chargé ne fait que SWAPPER son pipeline
sur l'allocation EXISTANTE (pas de nouvelle alloc carte), et le serveur s'auto-
limite via son cap VRAM fraction. Donc elle ne doit PAS passer le gate de
stacking. FIX v2 : pour image/img2img/inpaint, si l'AI engine est déjà chargé
(API.listProcesses isAiEngine) -> return ok:true direct. Sinon (moteur non chargé
ou kind non-réutilisant) -> projection normale used+cost. Renderer -> Ctrl+R.

## 2026-06-16 (fix — op image après une gen faussement bloquée (VRAM SDXL))

User : "après une génération le AI module consomme bcp de VRAM (6.6 GB), les
analyses suivantes ne veulent pas se lancer". CAUSE : hasVramHeadroomFor calculait
projected = VRAM_actuelle + coût_plein pour image/img2img/inpaint, sans tenir
compte que le serveur SDXL SWAPPE son pipeline (libère l'ancien avant de charger
le nouveau). Après une gen (engine ~6.6 GB, total ~12.9/16), un 2e op image
(coût 8) -> projeté 20.9 > 16 -> queué. Et comme img2img/inpaint ne sont pas dans
la liste auto-kill SDXL (enqueueJob 14042 = mesh/rig/image only), il attendait
90s (timer idle) puis rechargeait. FIX : pour image/img2img/inpaint, soustraire
la VRAM live de l'AI engine (via API.listProcesses .vramMb) avant d'ajouter le
coût -> projected = max(0, used - reusable) + cost ; et free += reusable. Le 2e
op réutilise SDXL instantanément au lieu d'attendre. Renderer -> Ctrl+R.

## 2026-06-16 (perf — scan NSFW idempotent : supprime le pic CPU au démarrage)

Monitoring seconde/seconde : à l'ouverture de FabMesh, CPU bloqué à ~38% pendant
20-30s. CAUSE (pas les thumbnails comme supposé) : _runNsfwBackgroundScan ->
batchCheckNsfw -> nsfw_scan.py chargeait 2 modèles ViT et RE-classifiait TOUTE la
bibliothèque à CHAQUE lancement, car (a) le cache renderer _nsfwScanCache est en
mémoire (vidé au démarrage) et (b) nsfw_scan n'écrivait un sidecar QUE pour les
images bloquées (.nsfw) -> les images propres, sans marqueur, re-scannées sans
fin. FIX idempotent : nsfw_scan.py écrit aussi .nsfwok pour les images propres,
pré-filtre les déjà-décidées, et ne charge les modèles que s'il reste du nouveau
(testé: tout-en-cache = 189ms sans transformers). main.js batch-check-nsfw skippe
les images avec sidecar .nsfw/.nsfwok et ne lance Python QUE pour les jamais-vues
(rien de neuf -> aucun spawn). Le 1er lancement post-fix scanne encore une fois
pour écrire les .nsfwok, ensuite démarrages instantanés. main.js -> restart.

User : "pour le GPU on peut faire pareil ?". Trou découvert :
trellis2_native_full_pipeline.py n'avait NI VRAM fraction NI gpu_throttle ->
pendant une gen 3D, les limites GPU ne s'appliquaient pas (elles marchent pour
la gen image via local_juggernaut_bridge make_throttle_callback). FIX : ajout du
cap VRAM (torch.cuda.set_per_process_memory_fraction(FABMESH_VRAM_FRACTION)) après
import torch -> vrai cap dur VRAM (OOM rattrapable, pas de freeze). Le throttle
util/temp (gpu_throttle.throttle_sync, sleep entre steps de diffusion) n'est PAS
injectable dans TRELLIS (boucle opaque, pas de callback) -> reste image-only ; la
priorité BELOW_NORMAL couvre partiellement. Script -> pas de restart Electron.

User : "ça dépasse 25 GB" en régime stable (27.8/31.8, GPU 95%). CAUSE : le
serveur SDXL persistant (~4-6 GB RealVis+inpaint+CLIPSeg) reste résident pendant
la passe TRELLIS alors qu'il ne sert pas -> son baseline s'ajoute au pic TRELLIS
-> total au-dessus du marqueur. FIX (image-to-3d, engine trellis2_native) :
stopSdxlServer() AVANT de lancer TRELLIS + attente 1.5s pour que l'OS récupère,
de sorte que le gate headroom voie la RAM libérée et choisisse un mode mieux
adapté. SDXL respawn au besoin pour la prochaine op image (~5-10s). Règle :
jamais deux gros modèles résidents en même temps. main.js -> restart Electron.

User : "les limites marchent vraiment ? la RAM dépasse le marqueur (88% vs 85%),
ça doit être une LIMITE". Vérif mesurée : process TRELLIS = BelowNormal (priorité
OK) + 20 GB WS (1024_cascade OK), mais total système 28/31.8 = 88% > marqueur.
CAUSE : le gate budget comparait le pic du mode au budget BRUT (% du physique),
sans soustraire ce qui est DÉJÀ utilisé (OS+Electron+SDXL ~8 GB) -> le pic du
worker s'ajoutait au baseline -> total au-dessus du marqueur. FIX : gate
headroom-aware -> le pic du mode doit tenir dans (budget − RAM utilisée).
peak(1536)=27, peak(1024)=20, base=10. Sur 31.8 GB à 85% (27 GB) avec ~8 GB
pris -> headroom 19 -> 1024 (20) ne rentre pas -> mode base. Le marqueur devient
une vraie limite sur le TOTAL ; compromis : qualité plus basse sur machine
serrée (monter le marqueur ou fermer des apps pour récupérer 1024). Toujours pas
de cap dur qui crashe (dégradation de mode). main.js -> restart Electron.

## 2026-06-15 (fix — moniteur HW gelé + ETA qui balloon + priorité trop dure)

User : gen 3D "se rallonge sans cesse" + "valeurs HW figées" (panneau Réglages)
alors que le mini-panneau du job bouge.
1. PANNEAU GELÉ (vrai bug) : drag du marqueur VRAM/RAM PENDANT un job ->
   _draggingGpuLimit=true puis customError('Locked') + return SANS remettre
   _draggingGpuLimit=false (le mouseup n'est jamais attaché sur ce chemin).
   refreshGpuStats() early-return tant que ce flag est true -> moniteur gelé
   jusqu'au prochain openSettings. FIX : reset _draggingGpuLimit=false avant le
   return du cas "Locked".
2. ETA QUI BALLOON : l'ETA dynamique extrapolait elapsed/progress brut depuis 8%
   -> les phases early (load/rembg/rectify, lentes) gonflaient l'estimation.
   FIX : mélange pondéré par la progression (w=progress) entre static et
   dynamique -> à 8% on suit le static, on penche vers le dynamique en fin.
3. PRIORITÉ TROP DURE : PROCESS_MODE_BACKGROUND_BEGIN affamait les threads qui
   nourrissent le GPU (GPU ~12%, gen ~2x plus lente). Remplacé par
   BELOW_NORMAL_PRIORITY_CLASS (bureau réactif sans starver le job GPU ; le
   budget RAM gère déjà le paging que le mode background visait).
Renderer -> Ctrl+R ; python -> prochaine gen. Pas de restart Electron.

## 2026-06-15 (feat — plafond gracieux : workers s'auto-limitent sans crasher)

User : "je veux un plafond qui ne tue pas l'appli". = auto-limitation gracieuse
(jamais un cap dur OS qui OOM-crashe). Option A de l'audit appliquée aux DEUX
workers lourds :
- trellis2_native_full_pipeline.py (le vrai worker qui pique 19-27 Go, lancé via
  le venv TRELLIS2_win) : avant import torch -> cap threads CPU
  (OMP/MKL/OPENBLAS/NUMEXPR = cpu_count//2, ici 32->16) + priorité process
  background (PROCESS_MODE_BACKGROUND_BEGIN 0x00100000, fallback BELOW_NORMAL) ->
  baisse aussi la priorité DISQUE I/O = le vrai facteur du freeze pendant le
  paging. + PYTORCH_CUDA_ALLOC_CONF gagne garbage_collection_threshold:0.8
  (reclaim VRAM gracieux avant OOM). Bug ctypes 64-bit corrigé :
  GetCurrentProcess().restype=c_void_p sinon handle tronqué -> SetPriorityClass
  échoue (testé: sans typage ->FAIL, avec ->OK).
- sdxl_server.py : cap threads CPU uniquement (PAS de background -> serveur
  interactif). + retiré les 3 enable_attention_slicing() (slowdown torch2.7/SDPA
  sans gain mémoire) en gardant enable_vae_tiling().
Désactivable via FABMESH_NO_WORKER_THROTTLE=1 / FABMESH_CPU_THREADS=N. Python
only -> pas de restart Electron, effet au prochain spawn des workers.

## 2026-06-15 (fix — Remove BG : surface vraie erreur + timeout vs charge système)

User : "Remove BG failed" message tronqué "Command failed: python …", puis
"remove background n'a jamais duré aussi longtemps". Modèle u2net.onnx en cache
depuis le 5 avril (176 Mo) -> PAS un téléchargement. Le run a duré ~50s (normal
<5s) puis tué par le timeout 60s -> le système était saturé (RAM/CPU) par un
autre traitement. Le handler 4113 affichait error.message ("Command failed …")
au lieu du stderr -> cause invisible (rien dans les logs). FIX : timeout 60s->
300s (4113) et 120s->300s (1376) + remonter le vrai stderr (slice -1500) et un
message clair en cas de timeout ("système saturé, attends puis relance").
main.js -> restart Electron (PAS relancé : user a demandé d'attendre).

## 2026-06-15 (feat — bouton "Unlock" sur l'erreur filtre de contenu)

User : popup "Image generation failed / Content filter ... Disable parental
control in Settings" -> voudrait un bouton qui amène direct à la popup de
warning. reportPipelineError() détecte désormais les messages filtre de contenu
(/content filter|parental control|unrestricted mode/i) et affiche via
customErrorWithAction un bouton primaire "🔓 Unlock" qui lance
toggleParentalControl() (popup warning légal + PIN) après fermeture du modal
partagé (setTimeout 60ms anti-race). Renderer only -> Ctrl+R.

## 2026-06-15 (feat — watertight plus fin + garde la texture (vertex colours))

User : "watertight trop grossier on peut améliorer, pas de texture non plus".
(1) FIN : défaut résolution 128->192, max 320->400, et lissage laplacien
adaptatif (1 itér si res>=192 sinon 2) pour ne pas faire fondre le détail à
haute résolution. (2) TEXTURE : avant le voxel-remesh on échantillonne la
couleur par sommet du mesh source (visual.to_color()), puis après le rescale
sur la bbox source on rebake ces couleurs sur la nouvelle coque par plus-proche-
voisin (scipy cKDTree, comme decimate) -> ColorVisuals. Testé res 192 : 226k
faces, watertight=True, 112k vertex colours dont 20768 uniques (kaki du tank
transféré), 4s. Sous-titre/confirm MAJ (texture conservée). Re-Texture reste
dispo pour un PBR net. Script Python -> pas de restart Electron.

## 2026-06-15 (fix — watertight sortait à l'échelle voxel-index (x~resolution))

User : "watertight ne marche pas" puis "ça marche mais on le voit pas, faut
beaucoup zoomer". Diagnostic bounds : mesh watertight diag=129.6 centré
(25,28.9,51.3) vs source diag=1.24 centré origine -> x104 trop gros + décalé.
CAUSE : trimesh VoxelGrid.marching_cubes renvoie la surface en coordonnées
d'INDEX voxel (0..resolution), pas en monde -> hors-champ dans le viewer
principal (le Paint modal auto-cadre donc y paraissait OK). FIX dans
watertight() : après marching_cubes, rescale+recenter uniforme sur la bbox du
mesh source (voxels cubiques -> scale unique exact ; robuste si une future
version de trimesh applique déjà le transform -> scale~1). + réparé le GLB v2
déjà généré in-place (diag 1.24 OK). Pas de restart Electron (script Python) ;
recharger la version pour la voir cadrée.

## 2026-06-15 (feat — budget RAM réglable : le slider RAM plafonne réellement)

User : "si on règle à 25 GB, Electron/TRELLIS/tout doivent croire qu'il n'y a
que 25 GB au lieu de tout utiliser à fond" puis "je veux qu'on arrive à limiter
le budget disponible selon ce réglage". On NE PEUT PAS faire croire à un process
qu'il y a moins de RAM (un cap dur OS = OOM-crash, exactement ce qu'on évite).
SOLUTION : le slider RAM (Réglages) devient un BUDGET = RAM physique × ram%, et
le pipeline choisit le mode cascade le plus lourd dont le PIC tient dans ce
budget -> jamais de saturation.
- Seuils : Ultra(1536, pic ~27 GB) exige budget >= 32 ; Quality+(1024, pic
  ~19 GB) exige budget >= 21 ; en dessous -> mode de base (~10 GB).
- renderer gateUltraQualityByRAM réécrit : budget = _cachedTotalRamGB × ram%,
  gate Ultra ET Quality+, fallback auto vers le mode le plus lourd qui rentre.
  Re-évalué LIVE au drag du slider (saveGpuLimits -> gate + markers). Tooltip +
  bulle de drag affichent le budget en GB ("92 %  (~25 GB)").
- main.js image-to-3d guard budget-aware : budget = min(physique,
  FABMESH_RAM_LIMIT_MB), downgrade Ultra->Quality+->base, qualityPlus passé en
  let et branché dans le bloc cascade. Belt+suspenders côté serveur.
Pas de token-cap supplémentaire : les seuils garantissent déjà que le pic tient
sous le budget. main.js = restart Electron.

## 2026-06-15 (fix — gate RAM 1536_cascade 24->32 GB + ETA dynamique)

User : l'appli sature sa RAM (27/27) et la gen 3D du tank a planté (OOM).
CAUSE : "Fine mesh shape (1536_cascade)" pique à ~27 GB ; le gate
ULTRA_Q_MIN_RAM_GB était à 24 -> autorisé sur un PC 27 Go = ZÉRO marge ->
saturation -> OOM-crash. Un cap RAM DUR ne marche pas (le process crashe, c'est
ce qui s'est passé ; on avait déjà désactivé le hard working-set cap). Le vrai
"cap" = ne pas autoriser l'option qui dépasse la RAM. FIX : seuil 24 -> 32 GB
(renderer gateUltraQualityByRAM + main.js image-to-3d guard) -> sur <32 GB,
Ultra(1536) auto-downgradé en Quality+ (1024_cascade ~19 GB, sûr). main.js =
restart Electron.
+ estimations cascade réalistes (QualityPlus 30s->120s, UltraQ 50s->360s) +
ETA dynamique (elapsed/progress) dans le modal du job (3d-eta).

## 2026-06-15 (parity — lot 3: Set Pivot Point sur desktop (depuis cloud))

Le cloud avait remplacé "Center" par "Set pivot point" (8 presets + offsets +
gizmo). Porté sur desktop : op Python set_pivot(mode,ox,oy,oz) (bbox jointe ->
pivot par preset -> translation partagée, testé bottom/center/top/world_origin,
texture OK) + schéma renderer (select preset + 3 sliders offset) + preview
gizmo jaune en overlay (_mtComputePivot/_makePivotGizmo/_mtBuildPivotGizmo,
dispatch overlayPreview==='pivot') + bouton "Center"->"Set Pivot" -> set_pivot.
Ajouté aux regex nom/groupage.

## 2026-06-15 (parity — lot 6: éditeur Select complet sur cloud)

Le cloud n'avait que Delete/Invert/Clear. Découvert qu'il utilise un modèle de
sélection ORANGE (r>0.9 & g<0.5) directement dans l'attribut color (pas la Map
_selSaved du desktop). Donc porté les outils desktop ADAPTÉS au test orange
(pas de réconciliation de 2 systèmes) : Select all, Grow/Shrink (adjacence
position-welded _meBuildPosAdj), Isolate/Hide (view toggles avec _viewBackup),
Crop (+ keep-rest), Flip normals, Smooth (Laplacian sélection), Duplicate
(copie faces orange + UV, décalées normale). HTML panel restructuré (boutons +
sections View/Edit). _meRestoreView ajouté à Delete/Save/Close. node --check OK.
Les handlers ne tournent qu'au clic + _mePushUndo avant tout destructif (undo
dispo) -> risque contenu. Cloudflare auto-deploy au push.
+ Eyedropper paint (me-paint-pick + pickMode) porté : clic puis clic sur le
mesh échantillonne la couleur dans me-paint-color (branche dans _meMouseDown).

## 2026-06-15 (parity — lot 5: Watertight sur cloud (Modal voxel remesh))

Porté l'op watertight desktop -> cloud : modal_app/_mesh_op.watertight (voxel
.fill().marching_cubes + laplacian + fix_normals, resolution) + dispatch run()
+ OPS dict ; worker.ts allowed set + meshyAPI CLOUD_OPS + mapping params
[resolution] ; cloud renderer schéma watertight + bouton ws-mesh-watertight-btn
(index.html) + wiring + enable cloud-overrides. node --check + AST OK.
NB : Cloudflare auto-deploy au push ; le BACKEND Modal nécessite `modal deploy
modal_app/app.py` côté user pour être live (sinon "unknown op" GPU).
Aussi : material_adjust desktop marche DÉJÀ (modal dédié openMaterialAdjust) ->
rien à porter.

## 2026-06-15 (parity — lot 4: Redo + undo-de-l'index sur cloud)

cloud/public/app/index2.js avait l'ancien undo (sans index) et PAS de _meRedo
(bouton me-redo mort). Porté la version desktop : _meSnapshot/_meRestore
capturent+restaurent geometry.index (undo après Delete ramène les faces) +
_meRedo ajouté + bouton me-redo câblé. node --check OK. Push -> auto-deploy.

## 2026-06-15 (parity — lot 2: PRESERVE_PREFIX agnostique côté cloud)

modal_app/_modify.py avait encore l'ancien PRESERVE_PREFIX/NEG orienté
personnage ('same character/outfit/pose, bad anatomy, extra limbs') -> réécrit
agnostique pour matcher le desktop (sdxl_server.py). Vérifié au passage que les
boosters mask-inpaint (_CONCEPT_BOOSTERS) sont DÉJÀ identiques desktop/cloud
(l'audit s'était trompé) -> rien à porter.

## 2026-06-15 (parity — propagation cloud<->desktop, lot 1: Fix Normals soudé)

User : "mets tout à jour" (parité cloud<->desktop). Lot 1 (cloud -> desktop) :
Fix Normals avec SOUDURE des normales aux UV-seams (corrige le shading
"assiette fêlée" des meshes TRELLIS). Porté _jsFixNormalsWelded (preview JS,
src/renderer/index2.js) + ajout du même weld dans mesh_tools.fix_normals (apply
Python : groupe par position, moyenne+normalise les normales, g.vertex_normals=
soudées). Vérifié que les normales custom survivent à l'export GLB trimesh.

## 2026-06-15 (feat — secrets chiffrés backupables sur GitHub (seal/unseal))

User veut backuper les secrets (hors git) de façon chiffrée SUR GitHub.
scripts/secrets_seal.py : bundle .env/.mcp_bridge_token/.test_api_token/
config.json -> AES-256-GCM (clé scrypt n=2^16 dérivée d'une passphrase getpass,
jamais en argv/log) -> secrets.sealed (trackable, safe à pusher). unseal restore
sur machine neuve ; mauvaise passphrase = échec propre (InvalidTag, rc=2, aucun
écrasement). Round-trip testé en bac à sable (passphrase jetable). .gitignore
déjà OK (clairs ignorés, secrets.sealed trackable). RECOVERY.md mis à jour.

## 2026-06-15 (chore — backup: commit du code custom jamais trackés)

Audit workflow (couverture GitHub). Tout était récupérable (branche
backup-full = snapshot git add -A) mais ~31 fichiers custom n'étaient JAMAIS
sur master. Commit propre : cloud/src/worker_master_test.ts (routeur Worker
480KB), modal_app/{_puppeteer_animate,_animateanymesh,_train_anytop}.py,
scripts/training_* + batch_fbx_to_bvh + fix_glb_ibms + ik_solver +
puppeteer_anim_to_glb + ue5_* (+READMEs), scripts/rig_mappings/
mountain_dragon__flying_quadruped.json, docs/{anytop_*,marklalon_*,track_b_*}.md,
+ external_patches/TRELLIS2_win/test_rope_blackwell.py (dernier fichier externe
custom non couvert). NON commités : les 13 fichiers junk 'c:tmp...' (colon
fullwidth, à supprimer) et les secrets .env/tokens (backup chiffré hors git).

## 2026-06-15 (feat — outil "Texture variations" (texture-seule, par seed))

User : veut régénérer la TEXTURE SEULE (sans toucher le mesh) pour des
variantes visuelles — Re-Texture TRELLIS régénère aussi la forme.
Fondation : scripts/texture_refine.py existait déjà (extrait l'atlas du GLB ->
SDXL img2img tile -> réinjecte dans le MÊME GLB, géométrie+UV intactes). Seul
manque : un seed pour varier.
- texture_refine.py + sdxl_server.do_img2img_tile : ajout `--seed`/`seed` ->
  generator manual_seed -> seed différent = texture différente.
- mesh_tools.texture_var(in,out,strength,seed,prompt) : wrappe texture_refine
  avec --controlnet_tile --cn_scale 0.75 (ancre le layout UV pour que les
  îlots ne se déchirent pas entre variantes). Via serveur SDXL always-on.
- UI : bouton AI Tools "Texture variations" + slider strength (15-80%) +
  champ seed (🎲) + champ style optionnel (rusty/golden/camo). Type de param
  'text' ajouté au rendu du modal. texture_var ajouté aux regex de nom/groupage.
NB : geometry-only, contrairement à Re-Texture (TRELLIS) qui régénère la forme.

## 2026-06-15 (fix — Watertight crash MAX_PATH + wireframe blanc + confirm stylé)

User : Watertight plante, fenêtre confirm pas au style appli, triangles
invisibles.
- **Watertight crash = Windows MAX_PATH (260)**. Chaque op mesh-tool ajoutait
  `_<op>_<ts>` au nom déjà long → après ~6 ops le chemin faisait 261 chars ->
  FileNotFoundError sur open("wb") à l'export. Vérifié : nom 176 chars ->
  chemin 261. FIX : le handler mesh-tool (main.js) strip les chaînes d'op
  (OP_SUFFIX) avant d'ajouter la nouvelle -> base bornée
  (catapulte_trellis2_native_<gents>, 39 chars), + cap dur à 90. Vérifié :
  watertight OK sur le mesh long (chemin 121). `watertight`/`subdivide`/
  `trellis2_retex` ajoutés aux POST regex (renderer + _meshProjectBackend)
  pour que ces versions groupent sous le bon projet.
- **Wireframe (△ Triangles)** : couleur 0x10131a (quasi-noir, invisible sur
  mesh sombre) -> blanc 0xffffff opacity 0.45.
- **Confirm** : schema.confirm utilisait confirm() natif Windows -> remplacé
  par customConfirm (modal stylé de l'appli).

## 2026-06-15 (fix — Modify image: hint strength + prefix preserve agnostique)

User : le catapulte devient une "voiture" en Modify image -> croit à un prompt
mémorisé. En fait c'est le STRENGTH à 87% : SDXL ne garde que ~13% du sujet et
RealVis dérive vers son prior (véhicule détaillé). Pas de prompt caché (le
renderer envoie le prompt brut, main.js le passe tel quel, le serveur ne
préfixe qu'à strength <= 0.6).
- index2 : phrase DYNAMIQUE sous le slider Strength (Low/Medium/High/Very high)
  qui prévient qu'au-delà de ~80% le sujet d'origine peut être perdu.
- sdxl_server.py : PRESERVE_PREFIX/NEG réécrits en AGNOSTIQUE (avant : 'same
  character, same outfit, same pose, bad anatomy, extra limbs' = personne
  uniquement, inadapté aux objets/véhicules). Effet sur le prochain start du
  serveur SDXL.

## 2026-06-15 (fix — Re-Texture (trellis2_retex) crash flash_attn manquant)

User : Re-Texture plante. Erreur = ModuleNotFoundError: No module named
'flash_attn' dans modules/sparse/attention/full_attn.py (sparse attention).
CAUSE : config.ATTN défaut 'flash_attn', non installé dans le venv texturing.
Le bridge n'imposait pas le backend (contrairement à la génération de mesh
qui force SPARSE_ATTN_BACKEND=sdpa via main.js:5145 et marche sur le 5080).
FIX :
- mesh_tools.trellis2_retex : env['SPARSE_ATTN_BACKEND']='sdpa' → route vers
  la branche sdpa (blackwell_fix EFFICIENT_ATTENTION) au lieu de flash_attn.
- windowed_attn.py : l'attention FENÊTRÉE n'avait QUE xformers/flash_attn (pas
  de branche sdpa) → forcer sdpa aurait laissé `out` non défini. Ajout d'une
  branche sdpa (self + cross, 1 SDPA par fenêtre en fp32, calquée sur
  full_attn). Ajouté à apply_trellis2_ram_patches.py (WATTN, 2 patchs) pour
  persister malgré le gitignore de external/TRELLIS2_win.

## 2026-06-15 (feat — outil Watertight (voxel remesh) dans AI Tools)

Distinction faite avec le user : Fill holes = couture des bords (stitching),
Watertight = vraie coque fermée. Nouvel op `watertight` dans mesh_tools.py :
voxelize (pitch=bbdiag/resolution) -> fill() -> marching_cubes -> laplacian
2 passes -> fix_normals. Fusionne tous les corps disjoints en une surface
étanche. PERD les UV/texture (surface neuve) -> re-texturer après. Testé sur
catapulte 473k/17k-bodies : res 128 -> 78922 faces, watertight=True, 7.2s.
UI : bouton AI Tools "Watertight" + slider Resolution (48-320, défaut 128) +
confirm (remplace la géométrie / enlève la texture). Pas de live preview
(voxel trop lourd en JS).

## 2026-06-15 (feat — Fill holes preview vert + algo cohérent preview/apply)

Demande : voir les trous en vert (façon Unreal) et remplir avec la texture
autour.
- **Preview vert (renderer)** : _jsHoleFillPreview détecte les boucles de bord
  (strip dégénéré + weld par position 1e-3 + arêtes count==1, porté du cloud
  _jsFillHoles), gating min/max edges. Trous dans la plage = surface vert
  clair + contour vert ; trop petits = gris, trop grands = rouge. Overlays
  enfants du mesh (héritent le transform), nettoyés à chaque update + close.
- **Apply cohérent (mesh_tools.fill_holes)** : RÉÉCRIT pour utiliser le MÊME
  algorithme de groupes de position que le preview (au lieu de trimesh
  merge_vertices) → ce qui est vert = ce qui est rempli. Fan-fill : trou de 3
  arêtes = 1 triangle, plus grand = fan depuis un centroïde dont l'UV = moyenne
  des UV du bord (la rustine prend la texture autour). Testé : 473k faces ->
  ~24k trous remplis en ~22s, texture+UV préservées. (Écart preview 22167 vs
  apply 23892 = ordre de parcours aux jonctions T, mêmes arêtes couvertes.)

## 2026-06-15 (feat — Re-Texture variations (seed) + spinner preview subdivide)

- **Variations de texture** : trellis2_retex prend désormais un `seed`
  (4e param) passé au bridge via `--seed` (le bridge le supportait déjà,
  défaut 42). Un seed différent = texture différente depuis le même mesh +
  image de réf. UI Re-Texture : champ « Variation (seed) » initialisé
  aléatoirement à chaque ouverture + bouton « 🎲 Nouvelle variation ».
- **Spinner preview** : les previews lourdes (subdivide JS sur mesh dense
  bloquent le thread) affichent un overlay spinner « Processing… » sur
  #mt-viewport, calcul différé de 2 frames pour qu'il s'affiche. Flag
  `heavyPreview` sur le schéma (subdivide). Previews légères restent synchrones.

## 2026-06-15 (fix — AI-TOOLS: crashes réels sur vrai mesh catapulte 473k faces)

Tests sur le VRAI mesh édité (385790 verts) ont révélé des crashes que les
meshes synthétiques ne montraient pas. Tout re-testé end-to-end sur ce mesh :
les 6 ops passent désormais (textured=True, uv_ok=True partout).

- **_export (cause de fix_normals/fill_holes/center FAIL)** : le Save mesh-edit
  (GLTFExporter three.js) bake un attribut COLOR_0 en VEC3 ; trimesh le charge
  dans TextureVisuals.vertex_attributes['color'] (N,3) et son export GLB crashe
  ('cannot reshape array of size N*3 into shape (4)'). Ajout _sanitize_for_export :
  drop le color parasite sur mesh texturé + tout attribut de taille != verts +
  retry visuals reset. → fix_normals/center/smooth/fill_holes exportent.
- **decimate** : replay_simplification CRASHE (IndexError: index 77779 oob 77754)
  sur vrai mesh. Remplacé par transfert UV nearest-neighbour KDTree (robuste).
  Plancher ratio 0.05→0.01 pour atteindre des cibles agressives.
- **subdivide ne finissait pas** : level 3 sur 473k faces = explosion + scan
  Python O(faces) → hang. Garde-fou FACE_BUDGET=2M qui clampe les niveaux
  (level 3→1 ici) ; finit en 12s, re-weld OK, texture OK.
- **fill_holes min/max (comme cloud)** : sliders min/max (edges) remis + Python
  énumère les boucles de bord et ne remplit en éventail que les trous dans
  [min,max]. 19 trous remplis sur catapulte, texture préservée.
- **UnicodeEncodeError** : em-dashes/arrows dans les logs crashaient sur pipe
  Windows cp1252. Logs passés en ASCII + main.js force PYTHONUTF8/PYTHONIOENCODING
  sur le spawn mesh-tool (blindage).

## 2026-06-15 (fix — AI-TOOLS mesh buttons: desktop ramené à parité cloud)

Workflow d'audit (17 agents, desktop vs cloud, vérif adversariale) sur les 8
boutons AI TOOLS. Le cloud (modal_app/_mesh_op.py) était effectivement plus à
jour ("Wave 4.2") ; fixes appliqués au desktop (scripts/mesh_tools.py +
scripts/subdivide.py + src/renderer/index2.js), cloud NON touché.

- **decimate (HIGH)** : fast_simplification jetait les UV → mesh rechargé sans
  texture (viole l'exigence #1). Préservation via simplify(return_collapses=True)
  + replay_simplification → idx_map, remap UV, TextureVisuals reconstruit à la
  nouvelle taille, remplacement de l'entrée geoms[gi]/scene.geometry. Fallback
  quadric loggué comme perdant les UV.
- **center** : offset PAR géométrie (déchirait les GLB multi-parties) + centroïde
  de masse au lieu du centre bbox → un seul offset depuis la bbox jointe, X/Z =
  (min+max)/2, feet Y=0. _jsCenter (preview) passé en centre-bbox (correct mono-mesh).
- **fill_holes** : slider mort (no-op) retiré ; weld merge_vertices (tol=clip(diag*1e-3))
  = fix porteur (sinon trimesh ne voit pas les bords sur seams TRELLIS) + 4 passes
  fix_winding/broken_faces/fill_holes(use_fan=True) + fix_normals final.
- **retexture / trellis2_retex** : échec subprocess masqué en succès (no-op montré
  "done!"). Désormais raise + stderr forwardé ; retexture ne supprime que la copie
  fraîche (jamais la source in-place). trellis2 : preset fast/balanced/quality
  CÂBLÉ (était stocké dans window.__trellis2Preset jamais lu) → flags bridge
  --steps/--texture-size/--image-resolution.
- **subdivide** : explosion par-face re-weldée (merge_vertices) → plus de soupe
  déconnectée. PAS de switch vers Loop (Loop jette les UV).
- **smooth** : durci (nondegenerate_faces + merge_vertices + volume_constraint=False
  + revert si NaN) contre les meshes dégénérés des générateurs.
- **fix_normals** : appels repair redondants retirés (no-ops idempotents, vérifiés
  byte-identiques au cloud sur 240 essais) + guard hasattr/try-except.
- **renderer** : runMeshTool affiche result.stderr (sinon cause réelle invisible).

## 2026-06-14 (fix — THE real SLat slowness: sparse-attn MATH backend → EFFICIENT)

LE vrai goulot (pas le suspend, pas le sdpa-vs-flash en soi). Mesuré : la
phase "Sampling shape SLat" (40→80 dans la barre) prenait **8+ minutes**
même en mode=1024 Fast, GPU à 99% (compute-bound). sparse_struct (les 40%)
restait rapide (~15s).

CAUSE — benchmark direct sur la RTX 5080 (sm_120), c:/tmp/sdpa_bench.py :
le chemin sparse-attn sdpa (modules/sparse/attention/full_attn.py, le
[blackwell_fix]) forçait SDPBackend.MATH. MATH **matérialise la matrice
N×N** des scores d'attention. Sur une grande séquence de voxels (SLat) :
  - seqlen 16384 → MATH tente d'allouer 16 GB → OOM/thrash
  - seqlen 32768 → 64 GB → OOM
EFFICIENT (mem-efficient, intégré torch, AUCUN .pyd → SAC-safe) streame
l'attention (mémoire O(N)) :
  - seqlen 8192 : MATH 46ms vs EFFICIENT 18ms (2.5×), maxerr **0.0000**
  - seqlen 16384/32768 : MATH OOM, EFFICIENT 70/272ms
  → bit-à-bit identique à MATH en fp32 (zéro risque correction Blackwell).
FLASH intégré torch : "No available kernel" sur sm_120 (indispo).

FIX : modules/sparse/attention/full_attn.py — sdpa_kernel([MATH]) →
sdpa_kernel([EFFICIENT_ATTENTION, MATH]) (EFFICIENT préféré, MATH en
fallback). fp32 conservé. Ajouté à scripts/apply_trellis2_ram_patches.py
(patch #4, gitignore-safe).
NON touché : modules/attention/full_attn.py:139 (non-sparse) garde MATH —
son blackwell_fix dit qu'EFFICIENT casse en bf16 (Y-axis collapse), et il
sert la phase sparse_struct qui était DÉJÀ rapide → pas le goulot.

Bonus : watchdog warn-only loggait CHAQUE seconde (fabmesh.log → 72 MB) +
nvidia-smi synchrone chaque seconde. Rate-limité (1×/30s) + cadence 1s→5s.
Label popup "Quality" reflète maintenant le preset TRELLIS-2 (Fast) au lieu
du vieux select ws-3d-quality (montrait "High" à tort).

## 2026-06-14 (fix — VRAM-suspend deadlock + SLat RAM-paging patches)

Suite directe de l'entrée ci-dessous. Le "stall à 40%" persistait MÊME
sans checkbox cochée. Diagnostic complet via le popup d'erreur (output
brut du job) :

- "Sampling sparse structure: 12/12 [00:15, 1.30s/it]" → 15 s, c'est
  EXACTEMENT la barre à 40%.
- "Sampling shape SLat: 5/12 [08:36, 104.53s/it]" → **104 s/itération**
  (vs ~1,4 s/it pour le sparse) = ~75× plus lent. CAUSE : le working
  set de la passe SLat dépasse la RAM physique → paging disque.
- Header: "expandable_segments not supported on this platform" → l'opt
  alloc CUDA est OFF sous Windows, ce qui aggrave le débordement RAM.

Deux causes de blocage corrigées :

1. **VRAM-suspend deadlock** — main.js installAllLimitsSafetyKill : la
   VRAM ne déclenche PLUS de suspend (comme la RAM). Log observé :
   "SUSPEND VRAM: 15350 > 13939 MB (95% of 90% cap)". Suspendre ne
   libère pas la VRAM (contexte CUDA gelé) → jamais sous le seuil de
   reprise → deadlock. Et un dépassement VRAM ne crashe pas le PC (CUDA
   OOM rattrapé par PyTorch). TRELLIS-2 a besoin de ~15,6/16 GB, au-
   dessus d'un slider à 90% → suspendre gelait un job sain. Watchdog
   désormais 100% warn-only (RAM via pagefile, VRAM via CUDA OOM-guard).
   Régression "ça marchait avant" : avant le suspend PowerShell timeout-
   ait sous charge (_suspendGaveUp) et le job tournait ; maintenant il
   réussit et fige. + un parent suspendu bloque le relai stdout du
   worker enfant caché (pid parent .venv → child system-python) → la
   barre ne bouge plus alors que le GPU calcule à 99%.

2. **3 patchs de réduction RAM de la passe SLat** (validés safe par
   workflow d'audit, byte-exact, aucun consommateur ne lit la data
   supprimée) — appliqués dans external/TRELLIS2_win (GITIGNORE) :
   - (a) flow_euler.py : ne garde plus la trajectoire complète (24
     copies de latent/passe) sauf return_traj=True. .samples inchangé
     → géométrie identique au bit près.
   - (c) trellis2_image_to_3d.py : del slat/hr_coords/quant_coords +
     gc + empty_cache avant la passe HR.
   - (b) trellis2_image_to_3d.py : honore FABMESH_TRELLIS2_MAX_TOKENS
     (32768) pour plafonner le budget tokens HR ; main.js Ultra-block
     ajoute l'env + DECIM 1500000→1200000.
   Pic visé ~21-23 GB (tient sans paging sur 32 GB → SLat revient à
   ~1,4 s/it). Cible 16 GB nécessiterait de réduire le plancher des 8
   modèles résidents (non fait).
   IMPORTANT : external/TRELLIS2_win étant gitignore, les patchs sont
   ré-appliqués par scripts/apply_trellis2_ram_patches.py (idempotent,
   tracké) — à relancer après tout re-setup TRELLIS-2.

3. **VRAIE cause racine du 104 s/it : le plafond hard de working-set**
   (setProcessHardMemoryLimit). Preuve : logs/enfant_mesh1536.log du
   21 mai (run sain) montre la passe "Sampling shape SLat" HR à
   **1,68 s/it** (~20s). Aujourd'hui : **104 s/it** = 60× plus lent sur
   le MÊME calcul → c'est de la mémoire, pas du compute (le GPU à 99%
   est trompeur, nvidia-smi capte un kernel en cours). setProcess-
   HardMemoryLimit posait un cap DUR via SetProcessWorkingSetSizeEx +
   QUOTA_LIMITS_HARDWS_MAX_ENABLE (flag 0x5) à 27 GB (= slider RAM).
   Windows force-trim les pages CHAUDES vers le disque dès 27 GB, même
   avec 31,8 GB physiques → thrashing. (Un cap dur trime les pages
   chaudes ; le pagefile ne pousse que les froides — bien moins cher.)
   FIX : le cap hard est désormais OPT-IN (FABMESH_HARD_RAM_CAP=1),
   désactivé par défaut. Le pagefile + le watchdog warn-only gèrent
   l'overflow proprement. Objectif : retour aux ~1,68 s/it de mai.
   (Cap retiré aussi à chaud sur le job en cours via
   SetProcessWorkingSetSizeEx(-1,-1,0) pendant le debug.)

## 2026-06-14 (fix — RAM-suspend deadlock + Ultra Quality RAM gating + Go-to highlight)

Trois changements liés au pic RAM de TRELLIS-2 1536_cascade (Ultra Quality).

1. **Deadlock RAM-suspend (cause du "stall à 40%")** — main.js
   installAllLimitsSafetyKill: la RAM ne déclenche PLUS de suspend
   (NtSuspendProcess). Suspendre un process ne libère PAS sa RAM (working
   set gelé), donc l'usage ne repasse jamais sous le seuil de reprise
   (85%) → blocage permanent (observé: figé à 40%, RAM 30.9/27 GB). La
   RAM se gère par le pagefile (mémoire virtuelle). Seule la VRAM garde
   la suspension (pas de pagefile, vrai risque OOM). RAM = warning only.

2. **Gating Ultra Quality par RAM** — Workflow d'audit (wirrxclxr, 4
   agents) a chiffré le pic 1536_cascade à ~27 GB = plancher ~15 GB (8
   modèles résidents en RAM, low_vram=True garde tout) + ~8 GB passe HR
   1536 + ~3 GB export. Ne tient pas sur < 24 GB. Donc:
   - renderer index2.js: gateUltraQualityByRAM() désactive la case
     #ws-trellis2-ultra-q si totalGB < 24 et garde Quality+ (1024) en
     repli; ré-appelée après _applyAssetOptionsProfile.
   - main.js handler image-to-3d: garde-fou serveur — si Ultra demandé
     et RAM < 24 GB, downgrade ultraQ=false (1024_cascade) + message
     ai3d-progress. Variable trellis2UltraQ → ultraQ dans le bloc env.

3. **Go-to highlight** — renderer _navigateToProcess: route désormais
   vers le JOB réel (window._navigateToJobStep → highlight du tile
   .step-progress-item de la génération) au lieu de seulement la carte
   conteneur. Fallback: highlight carte + tile actif.

Piste suivante (non appliquée, à valider sur machine 16 GB): patchs de
réduction du pic dans external/TRELLIS2_win (sampler trajectory OFF +
del slat LR/empty_cache + cap tokens HR 49152→32768) → pic ~21-23 GB;
puis réduction du plancher modèles (del/reload ou mmap) pour viser
~14-16 GB et rouvrir Ultra sur 16 GB. Backup de branche requis avant.

## 2026-06-14 (fix — Store cert crash-at-launch 10.1.2.10)

Microsoft Store a refusé l'appx: "product crashes at launch" sur Win11
22631 (VM propre, no GPU/Python/Blender/HF-cache). Deux blockers
indépendants identifiés et corrigés:

1. main.js:421-432 — mkdirSync top-level dans le dossier d'install
   (read-only sous WindowsApps / dans app.asar). Throw synchrone au
   chargement du module = mort avant whenReady, non rattrapable par
   uncaughtException. Fix: DATA_BASE = app.isPackaged ?
   getPath('userData') : repo-root; SCRIPTS_DIR pointe vers
   process.resourcesPath/scripts (read-only extraResources); boucle
   mkdir entourée d'un try/catch. MCP_TOKEN_FILE déplacé sous DATA_BASE.

2. index2.html importmap pointait three/addons vers
   node_modules/three/examples/jsm (élagué par electron-builder dans
   l'asar) => index2.js échoue son import ES au top-level => fenêtre
   blanche = "crash". Fix: importmap repointe "three" et "three/addons/"
   vers les copies vendored locales src/renderer/lib/ (three r170
   self-consistante). GLTFExporter.js ajouté à lib/exporters/ (les 3
   autres addons étaient déjà vendored).

Durcissement: handler global uncaughtException/unhandledRejection qui
montre une fenêtre fallback (jamais de sortie silencieuse); whenReady
crée la fenêtre EN PREMIER puis chaque subsystem optionnel
(resumePausedJobs, startMcpBridge, updater) est guardé individuellement
+ .catch() final; index2.html a un guard inline window.onerror qui
affiche un panneau d'erreur visible; control_api OFF par défaut en build
packagé (FABMESH_CONTROL_API=1 pour forcer) et n'écrit plus son token
dans le dossier d'install en prod.

## 2026-06-12 (feat — MyFabmesh v1: 4 composants livrés)

Workflow wp8v4f2aq (6 agents en parallèle) a livré les 4 composants
restants pour la v1 commerciale.

scripts/judge_retarget.py (~33 KB)
  Quality scorer 6 métriques (symetry, foot_contact, bone_length,
  rest_drift, motion_range, aabb_stability), score 0-100 + verdict
  GOOD/OK/BAD.
  Validé sur les 3 GLB references:
    Dwarf  + Robot1_Walk            -> GOOD (foot 1.5/s warning)
    Wolf   + comodo_dragon_walk     -> OK (asymetrie L/R arm motion)
    Dragon + MOUNTAIN_DRAGON_walk   -> OK (score 73.9)
  Le judge a auto-detecte la patte droite statique du dragon:
    "LeftLeg04 vs RightLeg04: motion ratio=0.00 (L=4.70, R=0.00)"
  = exactement ce que l'user a observe visuellement. QA auto valide.

scripts/batch_orchestrator.py (~29 KB)
  Batch processor avec CSV input, ProcessPoolExecutor, resume support,
  per-row timeout, auto-detect class. Sous-commandes:
    build-csv : pair motions x rigs auto par classe
    run       : execute le batch avec --jobs N

src/main/animation.js (~16 KB)
  IPC handlers pour Electron renderer <-> main:
    anim:list-motions, anim:retarget, anim:judge, anim:export
  Spawn Python subprocess pour rokoko_batch_retarget.py
  Cache motion thumbnails local
  Branchement local vs cloud Modal

modal_app/rokoko_endpoint.py + rokoko_client.py
  Modal endpoint "myfabmesh-rokoko" (separe de myfabmesh-cloud pour
  pas invalider le 30-60 min CUDA Trellis build).
  Image debian_slim + Blender 4.4.3 + Rokoko addon v1.4.3.
  4 vCPU, 4 GB, 50 concurrent inputs, max 20 containers = 1000
  retargets simultanes possibles.
  Cost: $0.007 / retarget, $0.72 / user 100 retargets, $400 batch 55k
  (vs $450 local Ryzen 5950X avec 9h wall-time).
  Client CLI rokoko_client.py invoque par Electron main.js, retry x1
  sur network failure, exit code 3 -> Electron fallback local.

Decision strategique confirmee: AnyTop training drop pour v1.
Pipeline Rokoko-only = 1099 motions Apovivor + retarget instantane =
suffisant pour MVP commercial. AnyTop = v2 si user demand.

## 2026-06-12 (feat — auto-label rigs + QA render headless)

**Auto-labellisation** sans annotation manuelle (`scripts/auto_label_rig.py`):
- 3 anchors par classe construits depuis nos rigs validés
  (humanoid_05 / test_quad_00 / dragon_red_rigged) dans
  `scripts/rig_mappings/_puppeteer_anchors/{humanoid,quadruped,winged_biped}/`
- features.npy = (n_joints, 11) [position, position relative root, parent
  direction, chain depth, child count]
- k-NN L2 greedy 1-to-1 assignment vers anchor labels
- Auto-detect classe via topology (n_ground joints + chain depth)
- Fallback GLB parsing (skin.joints + inverseBindMatrices + SVD) quand
  pas de pred.txt sidecar
- Validé sur humanoid_00 sans sidecar -> 22 labels generes -> Rokoko
  retarget tourne avec auto-align -77.7 deg

**QA render headless** (`scripts/render_retarget_screenshots.py`):
- Spawn Blender 4.4.3 subprocess, render 3 vues (front/side/3q)
  x 3 frames (25/50/75%) = 9 PNGs en 512x512
- Workbench renderer studio shading (pas besoin materials/lighting)
- Camera filtering : ignore les meshes < 1000 verts (= Icosphere stubs
  qui polluent le bbox)
- Camera clip_start = 1e-5 (Rokoko bake scale=0.01 -> mesh ~1cm wide
  en world, le defaut clip_start=0.1 le masquait)
- Camera distance = mesh_size * 1.3 avec 35mm lens
- Output: <stem>_render_report.json + 9 PNG <stem>_<view>_f<n>.png
- Dual-mode: orchestrator subprocess + Blender-internal en 1 fichier

**Resultats visuels (3 GLB known)**:
- Dwarf + AS_Robot1_Walk: marche claire ✓
- Wolf + comodo_dragon_walk: stride 4 pattes coherent ✓
- Dragon + MOUNTAIN_DRAGON_walk: wings + body visibles, deforme
  (rest pose Trellis wings spread vs source wings folded -> wings
  delta applique mal)

**Decision strategique**: AbandonneAnyTop training, pipeline Rokoko-only
suffit pour MyFabmesh v1. 1099 motions Apovivor disponibles, pick+apply
UX style Mixamo. AnyTop = phase 2 si users demandent motions inedites.

**Prochain step**: judge_retarget.py metriques quantitatives
(symetrie L/R, foot contact, bone length preservation, motion range)
puis batch overnight 50 rigs x N motions x 3 classes.

## 2026-06-12 (feat — Plan B1: multi-class retarget + auto-detect forward axis)

**Multi-class Rokoko pipeline E2E** :
- ✅ Humanoid (humanoid_05): dwarf marche avec hache, validé visuellement
- ✅ Quadruped (test_quad_00 = loup Trellis + comodo_dragon Apovivor):
  marche correctement après fix auto-detect forward axis (-83.9°)
- ✅ Winged biped (dragon_red Trellis + MOUNTAIN_DRAGON Apovivor):
  GLB exporté, mesh + skin OK, wings restent à valider visuellement
  (probable problème mapping wing fingers source→target)

**Auto-detect forward axis** (`scripts/rokoko_batch_retarget.py`):
Le problème "pas chassé" du wolf hier soir était dû à un mismatch
d'orientation rest-pose entre source (Apovivor convention) et target
(Trellis+Puppeteer orientation arbitraire). Fix:

```python
def _horizontal_forward(arm_obj, hips_name, head_candidates):
    # Hips world pos + Head world pos -> vecteur forward projeté
    # sur le plan horizontal (Blender Z-up)
    ...

# Compute rotation angle around Z
src_fwd = _horizontal_forward(src_arm, "pelvis", ["head"])
tgt_fwd = _horizontal_forward(tgt_arm, "Hips", ["Head", "Neck"])
ang = signed_angle(tgt_fwd, src_fwd, around=Z)
# Rotate target armature by ang around world Z, apply rotation
# into armature data (so rest pose itself is rotated)
```

Sur le wolf: -83.9° detected, applied, wolf marche normalement. Sur
le dragon: src_fwd=None (le mountain_dragon source pelvis pas trouvé
parce que le nom est "MOUNTAIN_DRAGON_ Pelvis" avec espace), skip
auto-align. Le dragon retarget marche quand même mais probablement
avec un offset.

**Mode auto-detection** humanoid/quadruped/winged_biped basé sur les
préfixes des bones source:
- "Lizard*" → QUADRUPED_PREFIX_MAP (comodo_dragon, 35 pairs)
- "MOUNTAIN_DRAGON_*" → WINGED_BIPED_PREFIX_MAP (mountain dragon,
  35 pairs avec wings L_ARM/L_FOREARM/L_HAND + fingers)
- Sinon → EXPLICIT_PAIRS_HUMANOID (Apovivor orc_m1)

**Viewer center button** (`c:/tmp/training_meshes/anim_preview.html`):
Bouton "Center" qui calcule bbox depuis les **bones du skeleton**
(qui ont les positions animées via les matrix world) plutôt que
`Box3.setFromObject` sur SkinnedMesh (qui retourne le bind pose).
Fallback sur geometry bbox si pas de skeleton.

**Labels manuels** annotés pour 2 rigs supplémentaires :
- `c:/tmp/test_quad_00.glb.labels.json` (38 joints wolf quadruped)
- `c:/tmp/dragon_red_rigged.glb.labels.json` (55 joints dragon
  winged_biped: 4 chaînes principales = spine forward, tail back,
  L/R legs, wings depuis joint28)

**À continuer** :
- Vérifier visuel dragon (problème wings probable)
- Fix src_fwd detection pour mountain_dragon (case avec espace
  dans bone name)
- Generate labels semi-automatiquement (au lieu de manuel par
  topo + position)
- Batch overnight 50 rigs × N motions par classe

## 2026-06-11 (feat — Plan B1: Rokoko Blender pipeline E2E validated)

**End-to-end Rokoko retarget MARCHE visuellement** : dwarf
humanoid_05 + Apovivor Robot1_Walk → mesh dwarf animé proprement
avec hache, jambes en mouvement de marche, bras qui swingent.
Premier visuel "vraie marche" du Plan B1.

**Workflows utilisés** :
- `w96ogz3vm` : verify Rokoko Studio Live Blender addon = LGPL-3.0
  (confirmé via GitHub API + LICENSE.md FSF verbatim), commercial-safe
  pour Steam-sale tant qu'on ne bundle pas le code de l'addon
- `w0llhdmri` : diagnostic viewer noir = (a) clip 0 est la source FBX
  avec scale=0.01 qui ratatine 100×, retarget est dans clip 1
  ("Base Layer Retarget"), (b) frustumCulled actif sur SkinnedMesh
  cull le mesh quand le root motion sort du frustum

**Setup** :
- Blender 4.4.3 télécharge dans `c:/tools/blender-4.4.3-windows-x64/`
  (pas 5.x : issues #131/#135 cassent le addon)
- Addon Rokoko v1.4.3 installé via `bpy.ops.preferences.addon_install`
  (le zip GitHub releases est sous le tag `v1-4-3`, l'archive auto
  `archive/refs/tags/v1-4-3.zip` extrait dans un dossier suffixé
  qu'il faut repackager `rokoko-studio-live-blender.zip` pour que
  Blender l'accepte)
- `bpy.ops.rsl.*` ops dispo en headless (login Rokoko ID PAS requis
  pour les operators)

**Nouveau fichier** :

`scripts/rokoko_batch_retarget.py` (~250 LOC) — dual-mode :
- Inside Blender : `--src-fbx X --tgt-glb Y --out-dir Z` retarget 1 pair
- Hors Blender : `--motions-dir`, `--rigs-dir`, `--jobs N` orchestrateur
  qui spawn N processes Blender en parallèle.

Pipeline interne (mode single) :
1. Import target GLB → obtient Armature avec joint0..jointN
2. Rename les bones via labels.json sidecar
   (`<glb>.labels.json` produit par puppeteer_semantic_extractor) →
   vocabulaire Mixamo : Hips, Spine, LeftShoulder, LeftArm, etc.
3. Import source FBX (Apovivor, 117 bones nommés)
4. **Skip Rokoko auto-detect** (bypasse "Duplicate target bone
   entries" sur LeftShoulder/RightShoulder à cause des
   cc_base_*_clavicle vs clavicle_*) — populate explicitement
   `scn.rsl_retargeting_bone_list` avec 23 EXPLICIT_PAIRS
   (pelvis→Hips, thigh_l→LeftUpLeg, etc.).
5. `bpy.ops.rsl.retarget_animation()` (COPY_ROTATION constraint +
   nla.bake)
6. Export target armature + mesh comme GLB (use_selection=True)

**Patches viewer** `c:/tmp/training_meshes/anim_preview.html` :
- Sélectionne automatiquement la clip dont le nom matche
  `/retarget/i` (fallback : dernière clip)
- `frustumCulled=false` sur tous les Skinned/Mesh
- DoubleSide + bbox computed AFTER animation play(frame 0)
- `?noroot=1` query string strip les root-bone .position tracks
- `?glb=...` query string permet de pointer un autre GLB

**Reste à patcher** (workflow w0llhdmri fix #2) — dans
`rokoko_batch_retarget.py` AVANT export :
- Reset `tgt_arm.location/rotation/scale` à identité
- Strip object-level fcurves des actions (garder pose.bones[*])
- Supprimer les actions non-Retarget

Sans ça, chaque GLB sortant contient 2 anims (source FBX + retarget)
et un Armature scale=0.01 baked qui demande au viewer de chercher
la bonne clip. À fixer avant batch (sinon process_new_skeleton
risque de prendre la mauvaise clip).

**Étape suivante** :
- Patch pipeline pour clean GLB output
- Fallback labels via `puppeteer_joint_renamer` (les 50 humanoid rigs
  existants n'ont pas de sidecar `.pred.txt` — rigés avant le patch
  bridge)
- Batch 50 rigs × 50 motions humanoid = 2,500 paires test, jobs=8
  CPU
- Si qualité constante : full batch 50 × 1099 = 55k overnight, puis
  prep AnyTop dataset, puis training.

## 2026-06-11 (wip — Plan B1: IBM-aware world-delta retarget + Rokoko pivot)

**Workflow `wuzh237ob`** (5 angles math/source/target/industry/symmetry)
a identifié la cause racine : `puppeteer_world_delta_retarget.py`
lisait `node.rotation` du target rig pour récupérer le rest world,
mais Puppeteer/Trellis **n'écrivent jamais** `node.rotation` — toute
l'orientation rest vit dans `skin.inverseBindMatrices`. Résultat :
`tgt_bind_world_q` = identité → la formule canonique de retargeting
dégénère en `local = inv(src_W) * src_local` qui ne marche que si
source/target frames bone-local coïncident.

Le hack `R_axis = (-0.5,-0.5,-0.5,0.5)` ajouté empiriquement
**masquait** ce bug en biaisant globalement, mais cassait
l'invariance L/R sur les distal joints (LeftLeg03→Z vs
RightLeg03→X observé dans diag).

**Fix appliqué** :
- `target_rig_bind_world_quats()` rewrite pour extraire le world rest
  via `skin.inverseBindMatrices` + SVD polar decomposition +
  Shepperd quat-from-matrix (méthode validée `anytop_retarget.py`
  L1306-1331)
- Suppression du bloc `R_axis` — la formule canonique absorbe
  automatiquement les différences de convention d'axes via
  `inv(src_W_rest) * tgt_W_rest`
- Fallback `_node_rotation_fk()` pour rigs qui auraient
  effectivement écrit node.rotation

**Résultat mesuré** (`c:/tmp/diag_full_traj.py`) :
- AVANT fix : 0 bones non-identité dans target_rest, LeftLeg03 Z dom
  vs RightLeg03 X dom (asymétrique)
- APRÈS fix : 21 bones non-identité, LeftLeg03 X dom +
  RightLeg03 X dom (**symétrie L/R restaurée**)

**Reste imparfait** : LeftArm03 asymétrie persistante + frame-0 source
n'est pas une vraie T-pose (thigh_l euler = (12.46, 17.83, 11.86)
au lieu de identity), donc certaines frames mid-walk produisent un
split-stance visuel.

**Pivot stratégique** : au lieu de continuer à hacker rest-pose
extraction, on passe à **Rokoko Studio Live Blender addon** (GPL,
gratuit, industry-standard). Scriptable headless via `bpy.ops.rsl.*`.
Plan : install addon → batch script (1099 motions × 50 rigs ≈ 6h
overnight RTX 5080) → dataset training AnyTop.

## 2026-06-11 (wip — Plan B1: delta-from-rest retarget + diag tooling)

**Pourquoi** : la rotation-transfer du commit précédent (51d83e8)
produisait un mesh visuellement parfait mais avec une motion sous-
amortie ("pas chassé" au lieu de marche). Diagnostic concret après
ajout d'un script `c:/tmp/diag_compare.py` qui dump les ranges
Euler par bone source vs target :
  - Source thigh_l Z range : 11°→74° (63° swing = la marche)
  - Target joint4 Z range : -7°→+10° (17° = 27% de l'amplitude)

**Tentatives** :
1. ANYTOP_OUTPUT_DAMP=1.0 + AMPLITUDE_BOOST=4.0 → mesh écartelé, le
   boost multiplie AUSSI le rest-pose offset baked dans les eulers
2. --rest-yaw-deg 90 → squelette tourné mais marche restait sideways
3. `scripts/puppeteer_delta_retarget.py` (NEW, ~250 LOC) :
   contournement complet du core anytop. Math direct :
     delta_q = q_source_frame * conj(q_source_rest)
     target_q = q_target_rest * delta_q
   Bug initial : classifier de source matchait `cc_base_l_thightwist02`
   (twist bone, ne porte que le roll) au lieu de `thigh_l`. Fix :
   `_SKIP_PATTERNS` qui ignore twist / sharebone / ik_ / finger / etc.
   Après fix : 18 bones classifiés correctement (thigh_l, calf_l,
   foot_l, ball_l, etc.).

**État actuel** : delta-retarget transfère bien les rotations sources
sur le target, mais reste un MIS-ALIGNEMENT T-POSE entre source et
target bone-local frames. Source Z=63° swing devient une rotation
autour de l'axe Z LOCAL du target — qui pointe différemment dans le
monde — donc l'arme et les jambes partent dans des directions
inattendues.

**Vrai fix nécessaire** : world-frame transfer
  - FK sur source pour q_world_source_frame
  - FK sur target pour parent_world_of_target
  - target_local_q_frame = q_world_source_frame * conj(parent_world_of_target)
Demande ~3-4h dev + test harness (compare RMS sur plusieurs motions),
pas faisable en fin de nuit.

**Outils annexes** :
- `c:/tmp/diag_compare.py` : compare ranges Euler source vs target par
  bone. Format diag concret au lieu de juger visuellement le rendu.
- `scripts/puppeteer_rotation_retarget.py` du commit précédent reste
  utilisable pour fallback (rotation-transfer via anytop_retarget core).

## 2026-06-11 (feat — Plan B1 end-to-end: rotation-transfer + dynamic labels)

**Visuellement validé** : un mesh Trellis humanoid_05 riggé Puppeteer
+ une animation Apovivor (AS_Robot1_Walk) → mesh dwarf parfaitement
préservé tenant sa hache dans une pose naturelle de combat. Premier
end-to-end propre du pipeline Plan B1.

**Changements** :

- `scripts/puppeteer_rotation_retarget.py` (NEW, ~150 LOC) : entry
  point qui combine
  * `anytop_retarget.retarget_motion_to_rig` (rotation-transfer core,
    bone-by-bone local rotation copy)
  * `puppeteer_semantic_extractor`'s labels.json (per-rig roles)
  * `build_target_table_from_labels()` parse les labels et émet
    `{joint_name → (role, side, chain_idx)}` que le core comprend
  
  vs `ik_retarget.py` qui utilisait end-effector IK :
  - IK end-effector solveur tire tous les bones d'une chaîne pour
    atteindre la cible → arms écartelés, mesh distordu
  - Rotation-transfer applique UNE rotation par bone (copie directe)
    → mesh préservé, motion fidèle au source

- `scripts/ik_retarget.py` (3 ajouts) :
  * `_effectors_from_labels()` (~90 LOC) — construit dynamiquement
    les effectors depuis labels.json. Mapping par NOM de node
    (`jointN`), pas par index d'énumération GLB. Conservé pour les
    cas où le rotation transfer ne marche pas (topo très différente).
  * Chargement automatique du sidecar `<rig>.labels.json` si présent
  * Chain head_tip limitée à Neck+Head (excluait spine entier qui
    causait whole-body rotation)

- `scripts/rig_mappings/_puppeteer_anchors/humanoid/labels.json` :
  L/R swap après test empirique. Puppeteer/renamer convention X+=Left
  inversait la chiralité par rapport à Apovivor (Mixamo X-=Left).

**Test E2E** : humanoid_05_seed47 (Trellis+Puppeteer) + Robot1_Walk
(Apovivor). Mesh dwarf intact, hache tenue correctement, anim 42
samples 23 channels, 19 driven_bones (vs 22 effectors mais 3 outside
mapped roles).

**Reste** : batch script (50 rigs × N motions), Hungarian matching
pour labels uniques, anchors par sous-type (humanoid lean/stocky/
robot pour précision >90%).

## 2026-06-11 (feat — Plan B1 unblocked: Puppeteer semantic labels via anchors)

**Pourquoi** : Plan B1 (train AnyTop sur skeletons FabMesh natifs) bloqué
parce que Puppeteer émet `joint0..jointN` sans labels sémantiques, avec
indices non-déterministes entre rigs. Sans labels, impossible de mapper
les os à des rôles (Hips/Spine/LeftArm/...) pour un retarget ik_retarget
ou pour fournir T5 tokens distincts à AnyTop training.

Workflow `w5nplqm0h` (3 angles : source code, paper, runtime tensors) a
identifié 3 étages cumulatifs sans modifier Puppeteer :
1. Parser `_pred.txt` (format RigNet généré par Puppeteer en interne)
2. Renamer géométrique (existant, ~50% accuracy sur topo atypique)
3. k-NN cosine sur embeddings 1024-D vs anchors annotés manuellement

**Changements** :

- `scripts/puppeteer_bridge.py` : après génération GLB, copie
  `pred_txt` vers `<output_glb>.pred.txt` sidecar. Préserve les
  coordonnées XYZ + DFS order + root + parents (source de vérité
  topologique) pour tous les rigs futurs.

- `scripts/puppeteer_semantic_extractor.py` (NEW, ~450 LOC) :
  * `parse_puppeteer_txt()` — étage 1, format RigNet
  * `label_via_renamer()` — étage 2, réutilise renamer existant
  * `run_hooked_demo()` — étage 3a, monkey-patch SkeletonGPT.generate
    pour capturer hidden_states (n_tokens, 1024) + cross-attention
    Michelangelo, ZERO modification source Puppeteer
  * `label_via_anchors()` — étage 3b, k-NN cosine vs anchors
    annotés. **Fix 2026-06-11** : aggregate query tokens en per-joint
    embeddings (groupes de 4 tokens) avant similarité — sinon k-NN
    raw tokens vs joints donnait labels incohérents.
  * `build_anchors_from_run()` — helper pour créer un anchor à
    partir d'une run instrumentée + labels manuels

- `scripts/puppeteer_joint_renamer.py` : 2 fixes heuristique
  1. Spine walker : préférer enfant vertical à enfant longest pour
     éviter que le RIGHT arm soit traité comme extension spine
  2. Détection arms branchant depuis spine (pas depuis Hips comme
     l'ancienne logique supposait) : si chain side-branch va latéral
     (|X| > 0.7 × max(Y,Z)), classifier comme arm
  3. Spine walker : stop si aucun kid vertical existe (évite
     continuer dans une chaîne lateral comme RightArm)

- `scripts/rig_mappings/_puppeteer_anchors/humanoid/` (NEW) :
  premier anchor humanoid_05 = `embeds.npy` (22, 1024) + `labels.json`
  (22 labels annotés manuellement). Permet k-NN sur futurs rigs
  humanoid Puppeteer.

**Test E2E POC** :
- humanoid_05 (anchor) → généré + hook OK
- humanoid_07 (test) → k-NN cosine vs anchor h05 :
  - Lower body (hips, legs both sides) : 100% labels corrects
  - Spine + torso : 100%
  - Right arm : 100%
  - Upper body (neck/head/left arm) : ~50% (confusion mineure)
  - **Overall : ~75-80% accuracy sur rig non-vu avec 1 anchor**

**Outils annexes** :

- `scripts/bone_semantic_classifier.py` (NEW, ~400 LOC, alternative
  approach C non utilisée) : classifieur MLP per-joint entraîné sur
  Truebones BVH labelisé. Scaffold complet (parse BVH, extract
  features 16-D, MLP train, predict). Conservé pour futur si étage
  3 nécessite plus de robustesse.

**Hors-scope ce commit** :
- Intégration `ik_retarget.py` pour consommer `labels.json` au lieu
  des effectors hardcodés (next step)
- Multi-anchor (2-3 anchors → vote moyen, ~90% accuracy attendue)
- Hungarian matching (assignment unique, pas de label dupliqué)

## 2026-06-09 (feat — SDXL chunked encode helper + 8 fichiers patchés)

**Pourquoi** : workflow `wb66mnlri` a découvert que SDXL CLIP-L cap à
77 tokens silently truncate les negative > 77. Notre negative de prod
faisait **410 tokens** → 333 droppés. Anti-anatomy + anti-doubling +
anti-cropping étaient INVISIBLES au modèle. Worse : `(token:1.5)`
Compel syntax tokenise comme 7 junk tokens chez vanilla diffusers,
gaspille ~138 tokens pour 0 effet.

Workflow `woydvj5w6` a audité TOUS les pipelines SDXL FabMesh et
confirmé que **8 fichiers** ont le même bug : modal_app/{_tpose,
_rectify, _sheet, _realvis, _backview, app}.py + scripts/
{local_juggernaut_bridge, generate_back_view, multiview_sheet_gen,
multiview_sdxl_gen, training_data_gen}.py.

Workflow `wf9tiyzt1` a résolu CUDA OOM de CompelForSDXL sur RTX 5080
16GB via une implémentation **pure-diffusers chunked encode**.

**Changement** :

- **Nouveau** : `scripts/_sdxl_prompt_utils.py` + miroir
  `modal_app/_sdxl_prompt_utils.py` (~280 LOC, MIT). Pure-diffusers
  chunked dual-CLIP encode, zero dep externe, zero VRAM overhead :
  - `encode_sdxl_long_prompt(pipe, positive, negative)` → dict avec
    `prompt_embeds`, `pooled_prompt_embeds`, `negative_prompt_embeds`,
    `negative_pooled_prompt_embeds`.
  - Splits en chunks de 75 tokens, wrap BOS/EOS, pad à 77.
  - Re-use `pipe.text_encoder` + `pipe.text_encoder_2` in-place
    sous `torch.no_grad` (pas de duplication d'encoders en VRAM).
  - Supporte syntaxe A1111-style `(token:1.4)` (emphasis weights).
  - Mirror du community pipeline `lpw_stable_diffusion_xl.py`.
  - `count_clip_tokens(text)` pour sanity checks.

- **Patch** : `modal_app/_prompts.py` : trim `ASSET_TYPE_PROMPTS`
  pour rentrer dans budget 77 + drop anti-pattern POSITIVE
  ("ONE X only / single instance / no duplicate") qui causait
  doubling (bear+cub seed 1004/1009).

- **Patch** : `modal_app/_realvis.py` : `build_prompts()` réécrit
  pour fitter NEG à 70 tokens, drop Compel syntax, anti-anatomy
  `_ANATOMY_NEG[asset_type]` front-loaded. `generate()` utilise
  `encode_sdxl_long_prompt` + fallback try/except.

- **Patch** : 8 sites SDXL refactorisés `pipe(prompt=, negative_prompt=)`
  → `pipe(**embeds, **base_kwargs)` :
  - `modal_app/_tpose.py:101-138` (T-pose ControlNet OpenPose)
  - `modal_app/_rectify.py:117-159` (rectifier MV-Adapter + ControlNet)
  - `modal_app/_sheet.py:131-157` (2x2 sheet generation)
  - `modal_app/_realvis.py:127-134` (text2image cloud)
  - `modal_app/_backview.py:198-244` (back-view ControlNet + IPAdapter)
  - `scripts/local_juggernaut_bridge.py:335-355` (desktop bridge,
    ControlNet T-pose + regular paths)
  - `scripts/generate_back_view.py:348-374`
  - `scripts/multiview_sheet_gen.py:222-248`
  - `scripts/multiview_sdxl_gen.py:148-171`
  - `scripts/training_data_gen.py` (batch training data gen)

**Impact mesuré** (workflow wb66mnlri sanity) :
- Bear+cub doubling (humanoid seed 1004/1009) : fixed
- Anti-mirror-weapon (humanoid_03 orc 2 weapons, humanoid_10 elf 2
  bows) : fixed via NEG `two weapons, dual wielding, mirrored
  weapons, pair of weapons, weapon in each hand` qui passe le 77-cap
- Sheet 2x2 cell mapping : maintenant visible (était truncated past
  pos 77 → 4× near-front collapse)

**Outil** : `scripts/training_data_gen.py` (~370 LOC, MIT) — génère
150 reference images (50 quadruped + 50 humanoid + 50 winged_biped)
en utilisant le même prompt pipeline que MyFabmesh DESKTOP
production, pour le dataset training AnyTop Plan B1 (skeleton
transplant). Compatible Compel chunked encode.

**License** : helper MIT, copies des prompt builders inchangées
license-wise (CreativeML OpenRAIL++-M pour RealVis V4.0).

---

## 2026-06-09 (fix — _backview.py: Compel long-prompt helper)

**Pourquoi** : workflow `woydvj5w6` a mesure NEG=179 tokens dans
`modal_app/_backview.py` (102 tokens truncated, 57% drop). Tout le bloc
anti-doubling + anti-cropping du negative prompt etait silencieusement
coupe past position 77 par le tokenizer CLIP-L, donc invisible a CFG —
le SDXL pouvait re-introduire face visible, breast pocket on the back,
button placket on back, etc.

**Changement** :

- `modal_app/_backview.py:192-223` — appel `pipe(prompt=..., negative_prompt=...)`
  remplace par `pipe(prompt_embeds=..., pooled_prompt_embeds=...,
  negative_prompt_embeds=..., negative_pooled_prompt_embeds=..., **base_kwargs)`
  via `encode_sdxl_long_prompt(pipe, prompt, neg)`.
- Encoding hoisted hors de la boucle multi-seed (4 candidats) — les
  embeds ne dependent pas du seed, on les calcule UNE fois (~5 ms).
- Try/except enveloppe l'import + l'encoding; en cas d'echec on
  retombe sur l'ancien chemin `prompt=/negative_prompt=` (degradation
  gracieuse — jamais bloquant).
- Tous les params existants preserves: `image=skel_img`,
  `controlnet_conditioning_scale=cn_scale`,
  `ip_adapter_image=ref_no_face`, `num_inference_steps`,
  `guidance_scale=7.0`, `height/width=1024`, `generator`.

Suit le meme pattern que `_realvis.py:127-134` deja patche.

## 2026-06-09 (fix — rig post-process + 2 retarget fixes : mesh ne casse plus)

**Pourquoi** : workflow `wxl8vwfy7` (12 agents, 894k tokens) + telemetry
sur ORC_M1 ont prouvé que la cause RACINE du mesh distorsion n'est ni
AnyTop ni le retarget — c'est les **auto-riggers Puppeteer et Hunyuan
qui produisent des GLBs avec IBMs corrompus** :

- **Puppeteer Dragon (45 bones)** : **19 paires de joints coïncidents**
  (joints 32 == 21 == 19 == 15 tous au même point world, etc). Quand
  AnyTop anime un wing, ça déplace aussi le neck/tail/spine au même
  endroit géométrique → spaghetti.
- **Hunyuan ORC_M1 (118 bones)** : IBMs scale corrompu sur certaines
  chaînes (joint `pelvis` à Y=9644 alors que mesh max-Y=191cm). Bones
  outliers à ×100 du mesh extent. Telemetry mesurée : TGT bone
  amplitude **18938** vs SRC 0.92 = ratio **20610x**.

**Changement** :

- **Nouveau** : `scripts/rig_postprocess.py` (~430 LOC, MIT).
  - `detect_defects()` : inspect IBMs, retourne `coincident_pairs`
    + `ibm_scale_corrupted` flags.
  - `repair_ibm_scale()` : deux modes — uniform scale si TOUS les
    joints sont off, OR per-joint snap des outliers à leur parent
    (snap puis merge ensuite).
  - `merge_coincident_joints()` : union-find sur les paires < tol,
    choisit le canonical (le bone avec le plus d'enfants = pivot
    anatomique), redirige skin weights JOINTS_0, drop les
    duplicates de skin.joints.
  - `postprocess()` : pipeline scale-then-merge.
  - CLI `--in path.glb --out fixed.glb` + `--detect-only`.

- **Patch** : `scripts/anytop_retarget.py` :
  - L2093-2110 : remplacé scale `hip_y/hip_y` par
    `median_bone_length / median_bone_length`. Robuste aux IBMs
    outliers. Mean would explode ; median stays sane.
  - L575-590 : defensive bounds dans `_target_anatomical_roles`
    pour skeleton courts (1-bone spine après head pop). Avant ça
    crashait sur le 118-bone ORC_M1 humanoid avec IndexError sur
    `sp[spine_n + j]`.
  - L_build_target_table_from_mapping : ajout du path B qui lit le
    block `target_bones` (humanoid mapping ue5_mannequin) en plus
    du path A `effectors` (flying_quadruped). Ajout `'all'` dans
    `_CKPT_TO_MAPPING_FILE`. Read aussi `target_drop_patterns`.

**Test (Dragon Puppeteer 45-bone)** :

| Métrique | dirty | post-clean |
|----------|-------|-----------|
| Joints | 45 | 35 |
| Coincident pairs | 19 | 0 |
| TGT/SRC bone amplitude ratio | 1.43 | **0.37** |
| Matched bones | 18→43 (post Plan A fixes) | 34/34 |
| Visuel | mesh shredded en fragments | dragon intact, pose tordue (orientation à fix) |

**Test (Hunyuan ORC_M1 118-bone)** :

| Métrique | dirty | post-clean |
|----------|-------|-----------|
| Joints | 118 | 90 |
| Coincident pairs | 12 | 0 |
| Max joint dist from mesh center | 17896 | **95.9** |
| `ibm_scale_corrupted` | true | **false** |

**Reste à faire** : orientation/rotation residuelle (le dragon est dans
une pose tordue, pas en vol droit) — probablement axis up Y↔Z ou
rest-pose offset. Bug de qualité, pas d'intégrité mesh.

---

## 2026-06-09 (fix — AnyTop retarget Plan A : 5 bugs, 27 bones morts → 2)

**Pourquoi** : Plan A validé end-to-end (sample.generate Dragon →
global_std 0.5958 → retarget) mais le GLB animé montrait des artefacts
visibles (ailes interpénètrent corps, body twist anormal).
Diagnostic via telemetry custom `scripts/anytop_bone_telemetry.py`
(extrait per-frame world positions + local quaternions des BVH source
et GLB target → JSON comparable) + workflow `wb2el707u` (18 agents,
1.1M tokens).

**Bugs identifiés (5)** :

1. **Euler convention inverse** (`scripts/anytop_retarget.py:236`) :
   `scipy 'zyx'` (intrinsèque) au lieu de `'ZYX'` (extrinsèque, BVH spec).
   Erreur 25° off-axis sur chaque wing flap → ailes vrillent corps.
2. **`ANYTOP_FIX_FLYING_ARM=0` défaut** (`:535`) : Bip01_*_Clavicle/
   UpperArm/Forearm (70-180° flap) silencieusement droppés en flying.
3. **Side regex** (`:76-77`) : `LWing/RWing` matchent pas → toutes les
   30 wings tombent dans `(wing, None)` → L+R reçoivent mirror moyenne
   = quasi-identité.
4. **Audit fixes désactivées** (`:1078-1083`) : FIX_CHAINS / PROPORTIONAL
   / FANOUT / HEAD_NECK toutes à 0 par défaut.
5. **target_table jamais passé en BVH path** (`:893`) : seul
   `retarget_fbx_to_rig` lisait `rig_mappings/*.json` ; le BVH path
   tombait sur le classifier géométrique qui ne trouvait que 18/45
   bones (27 droppés à rest pose).

**Changement** :

- `_eulers_to_quats` : `channel_order.upper()` (extrinsèque scipy)
- `ANYTOP_FIX_FLYING_ARM` défaut `'1'`
- `_SIDE_TOKEN_L/R` : ajout `LWing|Lwing|LBeard|LFinger` et symétrique R
- `ANYTOP_FIX_CHAINS/PROPORTIONAL/FANOUT/HEAD_NECK` défauts à `'1'`
- Nouveau `_build_target_table_from_mapping(ckpt_family)` qui lit
  `scripts/rig_mappings/mountain_dragon__flying_quadruped.json` et
  construit `(joint_name → role, side, chain_idx)` à partir des
  effectors. Appelé dans `retarget_bvh_to_rig` → passé à
  `retarget_motion_to_rig` comme `target_table`.

**Test (Dragon BVH AnyTop → Puppeteer 47-bone GLB)** :

| Métrique | v1 (avant) | v3 (après) |
|----------|-----------|-----------|
| Target bones matched | 18/45 | 43/43 |
| Bones morts (≤2 keyframes = rest pose) | 27/45 | 2/45 |
| Total quaternion std (motion totale) | 2.609 | 7.871 |
| `tgt roles` distribution | hip=1 neck=1 tail=1 wing=11 leg=4 | hip=1 arm=9 tail=5 wing=12 leg=11 neck=4 head=1 |

**Outil debug** : `scripts/anytop_bone_telemetry.py` (~280 LOC, MIT) +
`c:/tmp/viewer/bone_telemetry.html` (side-by-side SRC|TGT avec trails
+ catégorisation par rôle + sidebar amplitude per-bone). Réutilisable
pour tout retarget BVH→GLB futur.

**Next** : visuel humain pour valider que les ailes flap maintenant
proprement sans clipper le corps. Si OK : commit et port Plan A dans
`anytop_bridge.py` (replace mon ancien S1 fix moot).

---

## 2026-06-09 (fix — AnyTop S1 : anatomical joint renamer + idle wiggle BVH pour briser la collapse)

**Pourquoi** : workflows de diagnostic `wnum1x0bz` (AnyTop, 18 agents,
26 hypothèses, 6 survivantes après adversarial verify) ont identifié
DEUX root causes du "near-identity motion" sur skeletons Puppeteer
custom :

- **RC1** : `_extract_bvh_from_glb()` écrivait 30 frames de zéros pour
  le motion_bvh. `motion_process.get_mean_std()` produisait std ~1e-6.
  En denorm (predict_xstart=True) : `out = pred * std + mean` →
  effondrement en T-pose + micro-tremor.
- **RC2** : le tokenizer T5 d'AnyTop (`model/conditioners.py:334`
  `_split_and_replace`) strip digits/underscores via
  `re.sub(r'[\d_]+', '', part)`. Tous les `joint_0..joint_46` de
  Puppeteer deviennent le seul token `'joint'` → embedding T5 identique
  pour wing / leg / arm / tail → le modèle ne peut PAS différencier les
  appendices. Seul signal per-joint discriminant collapsé.

**Changement** :

- **Nouveau** : `scripts/puppeteer_joint_renamer.py` (~370 LOC, MIT).
  Renomme les joints synthétiques `joint_NN` / `bone_NN` en noms
  anatomiques (`Hips`, `Spine`, `Neck`, `Head`, `LeftArm`, `RightArm`,
  `LeftLeg`, `RightLeg`, `LeftWing`, `RightWing`, `Tail`). Deux tiers :
  (1) `rig_mapping` effectors si dispo (high-fidelity), (2) topology
  heuristic en fallback (axes Y-up + sign X pour la side).
  Inclut `t5_tokenize_like()` qui simule le tokenizer pour asserter
  qu'il reste ≥ 4 tokens distincts post-rename. Test sur
  `c:/tmp/dragon_rig.glb` : 47 joints → 12 tokens T5 distincts
  (vs 1 avant). CLI `--glb path --rig-mapping family` pour inspection.

- **Patch** : `scripts/anytop_bridge.py:76-160` `_extract_bvh_from_glb()`
  - Ajoute `is_motion` (kw-only) et `rig_mapping` (kw-only).
  - Détecte naming synthétique via `is_synthetic_naming()` → applique
    `rename_for_anytop()` avant l'émission BVH.
  - Si `is_motion=True` : remplace `zero_frame` par un sinus
    `amp_joint_rot_deg=2.5°`, `period=1s @ 30fps`, phase per-joint
    `n * π/7` → std garanti non dégénéré sur tous les channel-blocks.
  - `run()` appelle tpos avec `is_motion=False`, motion avec
    `is_motion=True`.

**Test** : `python scripts/puppeteer_joint_renamer.py --glb c:/tmp/dragon_rig.glb`
→ 12 tokens T5 distincts. BVH extract end-to-end : 47 noms distincts,
motion frame 0 vs 15 → inversion de signe (full sin cycle), root XYZpos
restent à 0 (no float root translation).

**Contrainte respectée** : aucune modif Puppeteer
(`feedback_dont_touch_puppeteer`). Le rewriter tourne en aval.

**Next** : valider end-to-end via `python scripts/anytop_bridge.py
--rig c:/tmp/dragon_rig.glb --out c:/tmp/anytop_walk.glb --anim-type walk`
puis mesurer `global_std > 0.1` sur 60 frames du BVH résultant.

---

## 2026-06-04 (feat — morphology classifier prototype : GLB -> archetype + Truebones donor)

**Pourquoi** : pour passer de "AnyTop = Dragon-only" a "AnyTop multi-espece"
on doit deviner l'archetype morphologique du rig en sortie de Puppeteer
AVANT de choisir un BVH donor. Six classes : `biped` / `quadruped` /
`hexapod` / `serpent` / `winged` / `blob`, alignees sur les sous-ensembles
AnyTop (`BIPEDS`, `QUADROPEDS`, `MILLIPEDS`, `SNAKES`, `FLYING`).

**Changement** (`scripts/morphology_classifier.py`, ~250 LOC, pure
pygltflib + numpy, zero Blender) :
- `extract_skeleton(glb)` : lit `skin.joints` + `inverseBindMatrices`,
  inverse les IBMs pour reconstruire les positions monde de chaque os
  et reconstitue les parent indices via `node.children`.
- `_topology_features()` : 9 signaux topo/geo (n_term, branch_nodes,
  max_depth, aspect H/W, aspect long, symetrie X, high/low/wide
  terminals).
- `classify()` : heuristiques sommees + tie-break -> archetype +
  confidence. Wings dominent sur biped/quadruped pour les dragons
  ailes-haut + pattes-bas.
- `_best_truebones()` : pick l'espece AnyTop dont le joint count est
  le plus proche du rig (table `SPECIES_JOINT_HINT`).
- Smoke-test embarque : `c:/tmp/dragon_rig.glb` (47 os) -> attendu
  `winged`, obtenu `winged` (confidence 0.71, donor = `Buzzard`).

**Resultat** : permet a `anytop_retarget.py` de selectionner
automatiquement le BVH donor pertinent au lieu de hard-coder MountainDragon.

---

## 2026-06-02 (fix — AnyTop retarget : desactivation par defaut du clamp 90deg + twist-drop)

**Pourquoi** : audit `wgjsu8jbu` sur Dragon 41-bone vs source BVH 102-bone
(125 frames @30fps) a quantifie une perte cumulee de **~1957 degres** de
mouvement angulaire entre la motion source AnyTop et l'animation finale
ecrite dans la GLB. Le coupable est double :

1. **Clamp dur a 90deg** sur `delta_src` avant le basis-change : tout
   frame avec >90deg de rotation parent-local etait re-slerp vers
   90deg, lissant les flap d'ailes et les coups de queue.
2. **Twist-drop total** apres `_swing_twist` : on ne gardait que le
   swing, jetant a la poubelle TOUTE la rotation axiale autour de
   l'os. Audit chiffre : ~3.2x plus de perte de motion via twist-drop
   que via le clamp. Sur un dragon, c'est le mouvement de roulis du
   torse + la torsion de la queue qui disparaissaient.

**Changement** (`scripts/anytop_retarget.py`) :
- Defaults env-driven, no-op par defaut :
  - `ANYTOP_MAX_ANGLE_DEG=180.0` -> clamp desactive.
  - `ANYTOP_TWIST_KEEP=1.0` -> on garde TOUT le delta full-quat
    (court-circuite meme la decomposition swing/twist).
- Override possible via env si on veut revenir au comportement legacy
  pour un asset specifique (`ANYTOP_MAX_ANGLE_DEG=90 ANYTOP_TWIST_KEEP=0.0`).
- Log de header : `[retarget] mitigations: max_angle_deg=180.0 twist_keep=1.0`
  imprime au demarrage pour audit.

**Validation locale** (Dragon master) :
- Input rig : `c:/tmp/dragon_rig.glb` (41 bones cible).
- Input motion : `c:/tmp/dragon_raw.bvh` (102 bones source, 100 frames @24fps).
- Output : `c:/tmp/dragon_master_no_mit.glb` = 67,138,340 bytes, 48 canaux
  d'animation, 125 samples re-echantillonnes a 30fps, clip 'run',
  ckpt_family=flying. 41/41 target bones matches.
- Bone roles src : hip=1 tail=5 spine=3 leg=20 neck=6 arm=26 wing=30 head=1.
- Bone roles tgt : hip=1 spine=2 neck=1 tail=4 wing=11 leg=22.
- Hip translation scale=0.4599 sur 125 frames.
- Stage compare : `c:/tmp/viewer/compare/after.glb` (octet-identique).

**Suivi** : si Modal retarget remote produit toujours un mesh fige post-deploy,
verifier que l'image Modal embarque bien `os.environ.get` defaults a 180/1.0
(pas de variable d'env explicite cote container qui forcerait 90/0.0). Rollback :
`git revert <sha>` + `modal deploy modal_app/_anytop_anim.py`.

## 2026-06-02 (verify — Hi3DGen removal post-flight, TRELLIS-2 single mesh path)

**Pourquoi** : audit post-suppression de `c2808a9` pour confirmer qu'aucun
import vivant ne réfère encore au moteur Hi3DGen. Vérification effectuée
avant push vers `origin/master`.

**Backup branch** : `backup-pre-hi3dgen-removal-undefined` (créée par le
workflow d'orchestration avant le run de cleanup, tag de safety net).

**Résultat audit** :
- `node --check src/main/main.js` → EXIT=0
- `node --check src/renderer/index2.js` → EXIT=0
- Grep `import.*hi3dgen|from.*hi3dgen|require.*hi3dgen` → 0 hit
- 12 occurrences textuelles restantes, toutes inertes :
  - `scripts/mesh_tools.py` lignes 248-265 (5) : shim filename-detection
    qui set `FABMESH_TEXPROJ_HI3DGEN_UNDO` pour les vieux meshes
    `_hi3dgen_*.glb` sur disque. Aucun import du moteur supprimé.
  - `scripts/texture_project.py` lignes 187-200 (3) + 642 (commentaire) :
    receveur de cet env var, branche math pure (axis-undo).
  - `scripts/_test_trellis2_native.py:3` : commentaire dans test inactif.
  - `cloud/public/app/index2.js:611` + `src/renderer/index2.js:436` :
    regex de groupage projet par nom de fichier (préserve la compat
    avec les `_hi3dgen_*.glb` user existants).

**Décision** : conserver ces 12 hits tels quels — ce sont des hooks de
backward-compat sur les artefacts disque user, pas du code Hi3DGen actif.
TRELLIS-2 native est désormais le seul chemin mesh côté desktop ET cloud.

**Suivi optionnel** : pruner le shim + la regex dans un commit ultérieur
quand l'utilisateur aura confirmé qu'il ne reste plus de `_hi3dgen_*.glb`
dans `meshes/`.

## 2026-06-02 (cleanup — remove Hi3DGen from desktop pipeline)

**Pourquoi** : Hi3DGen n'est plus l'engine par défaut depuis 2026-05-19
(remplacé par TRELLIS-2 native single-shot). Le code Hi3DGen restait
listé dans les engine maps de main.js, les options UI cloud et les
scripts dédiés, alors qu'aucune route ne l'expose plus côté desktop ni
cloud (cloud-overrides.js prune déjà toute option != trellis2_native).
Nettoyage pour réduire la surface de maintenance.

**Supprimé** :
- `scripts/hi3dgen_full_pipeline.py`, `scripts/local_hi3dgen_bridge.py`
- `scripts/__pycache__/hi3dgen_full_pipeline.cpython-311.pyc`,
  `scripts/__pycache__/hi3dgen_invuv_bake_v3.cpython-311.pyc`
- `dist/installer/win-unpacked/resources/scripts/local_hi3dgen_bridge.py`
  (artefact build, sera re-généré au prochain `electron-builder`)

**Édité** :
- `src/main/main.js` : retrait des entrées `bridgeScripts['hi3dgen']`,
  `argsMap['hi3dgen']`, `fixedArgsMap['hi3dgen']`, des 5 spreads env
  `FABMESH_TRELLIS2_*` gated sur `engine === 'hi3dgen'`, du log preset,
  et simplification des conditions `(trellis2_native || hi3dgen)` à
  `trellis2_native` seul. Filtre sanitizer Hi3DGen retiré.
- `src/renderer/index2.js` : comment hi3dgen retiré du patch emissive.
  Regex `meshProject` ligne 436 PRÉSERVÉE (mesh files `_hi3dgen_*.glb`
  toujours dans `meshes/` côté utilisateur).
- `cloud/public/app/index.html` : retrait `<div id="ws-3d-hi3dgen-hint">`
  et nettoyage des commentaires.
- `cloud/public/app/index2.js` : retrait de `ENGINE_LABELS['hi3dgen']`,
  de la branche `expectedMs` hi3dgen, de la logique `hi3dgenHint` dans
  `_ws3dEngineSync`, et simplification du toggle `trellis2-opts`.
- `cloud/public/app/cloud-overrides.js` : nettoyage commentaire.
- `scripts/trellis2_native_full_pipeline.py` : docstring corrigée
  (n'est pas une "two-stage Hi3DGen + TRELLIS-2", c'est un single-shot
  TRELLIS-2 native). Renommage `LOCAL_HI3DGEN_PROGRESS` →
  `LOCAL_TRELLIS2_PROGRESS` (9 occurrences ; le regex main.js ligne 4417
  matche `LOCAL_[A-Z0-9_]+_PROGRESS` génériquement → safe).
- `scripts/trellis2_texturing_bridge.py` : même renommage marker
  (10 occurrences) + commentaires nettoyés.
- `scripts/multiview_from_mesh.py`, `scripts/generate_back_view_sheet.py`,
  `scripts/generate_back_view_mvadapter.py` : commentaires de convention
  mis à jour (drop `hi3dgen_full_pipeline`).

**Préservé volontairement** :
- `scripts/mesh_tools.py` + `scripts/texture_project.py` :
  auto-détection `_hi3dgen_` dans le nom de fichier + env var
  `FABMESH_TEXPROJ_HI3DGEN_UNDO` nécessaires pour re-projection des
  100+ meshes `_hi3dgen_*.glb` existants côté user (convention d'axe
  différente de trellis2).
- Regex `meshProject` dans les deux index2.js : retirer `hi3dgen` du
  pattern recréerait des projets fantômes à partir des artefacts user.
- `THIRD_PARTY_LICENSES.txt` §12 : KEEP tant que `external/Hi3DGen/`
  reste dans .gitignore (légalement requis si binaires l'ont référencé).
- `AGENT_LOG.md` mentions historiques : log immuable.

## 2026-06-02 (instrument — runtime markers for ZYX + ANYTOP_COMMIT + channel_order)

instrument(anytop): runtime markers (ANYTOP_COMMIT echo, ZYX branch log,
channel_order tally) to verify the v38 fixes actually exercise on cloud
dragon jobs

## 2026-06-02 (anytop-retarget — ZYX channel-order fix — Stage-3 audit w8nuzxpih)

**Pourquoi** : `_eulers_to_quats` dans `scripts/anytop_retarget.py` recevait
`euler_deg` en colonnes fixes `[X,Y,Z]` (bvhsdk `j.rotation` permute toujours
par nom — bvh.py:261), mais scipy `R.from_euler(order, angles)` interprète
`angles[:, i]` comme la rotation autour de `order[i]`. Pour un BVH déclaré
ZYX (cas AnyTop Dragon), on passait donc colonne X comme angle Z, colonne Z
comme angle X — swap silencieux qui produit des quats faux sur ~87 % des
joints du clip.

**Fix** : capturer la string d'ordre intrinsèque depuis `j.order` au parse,
puis permuter les colonnes `[X,Y,Z]` vers l'ordre déclaré avant l'appel
scipy. Fallback `'zxy'` (default bvhsdk) si l'attribut manque.

**Validation** (audit Stage-3 `w8nuzxpih`) : régénération du clip Dragon
before/after sur 47 joints communément animés —
- mean per-frame quat angle delta = **71.25 deg**
- max = **175.45 deg** (quasi-antipodal)
- 41/47 joints divergent de plus de 10 deg sur au moins une frame
Les trois seuils de significativité (mean>1, max>20, diverging>5) sont
explosés simultanément — le patch fait du vrai travail structurel, ce
n'est pas une correction marginale.

**Suivi** : redéploiement `modal_app/_anytop_anim.py` pour que la prod
cloud bénéficie du fix.

## 2026-06-02 (anytop-modal — BVH leaf channels + per-job seed/output-dir + pinned ANYTOP_COMMIT + MIT-only license header — wf_7aed43eb)

**Pourquoi**: workflow `wf_7aed43eb` a fanné plusieurs worktrees pour durcir
`modal_app/_anytop_anim.py` côté Modal (race conditions multi-job, leaves BVH
gelées, pin de commit AnyTop, header de licence inexact). Quatre fixes adoptés
en parallèle, aucun conflit d'application.

**Changements adoptés** :

1. **`bvh-leaf-joint-channels`** (`scripts/bvh_patch_leaves.py` + step 2.4
   dans `_anytop_anim.py`) — AnyTop écrit ses End-Sites BVH sans CHANNELS,
   donc wing-tips / tail-tip / doigts / griffes restent gelés alors que le
   tenseur de diffusion contient bien leurs rotations (J=143 sur Dragon).
   On remplace chaque End-Site par un vrai Joint `<parent>_end` avec 3
   rotation channels et on pad chaque frame MOTION avec les colonnes
   correspondantes. Source : workaround de sy-hwang's `custom_bvh.py`
   (Issue #32). Non-fatal — si le patch échoue, le retarget continue avec
   les leaves gelées et un warning dans les logs prod.

2. **`seed-and-output-dir`** (`_anytop_anim.py`) — `sample.generate` recevait
   ni `--seed` ni `--output_dir`, ce qui (a) rendait les runs non
   reproductibles et (b) faisait collisionner deux jobs concurrents sur le
   même container Modal (mtime-glob sur `samples_*` racait). On passe
   maintenant un seed déterministe (`md5(job_id)[:8]`) et un output_dir
   par-job (`<work_dir>/anytop_out`). Nouveau helper `_find_bvh_in_dir()`
   remplace `_find_latest_bvh()` sur les call-paths qui ont un output_dir
   explicite — l'ancien est gardé en legacy avec un docstring qui pointe
   vers le nouveau. `standalone_run()` reçoit la même refonte.

3. **`pin-anytop-commit`** (`_anytop_anim.py`) — commentaire du
   `ANYTOP_COMMIT = "e780d15"` enrichi pour expliquer que changer ce SHA
   invalide le layer Modal image et force un rebuild (info opérationnelle
   manquante avant). Le SHA lui-même était déjà pinné.

4. **`fix-license-header`** (`_anytop_anim.py`) — docstring corrigé :
   AnyTop est sous MIT seul, pas "Apache-2.0 / MIT". Évite toute confusion
   downstream lors d'un audit de licence.

**Ce qui N'EST PAS dans ce commit** : la branche parallèle `whbjllu36`
(retarget bind-pose anchor) ne touche pas `_anytop_anim.py` donc aucun
risque de conflit ; les deux séries peuvent merger indépendamment. Pas de
`modal deploy` auto — le user déclenchera le redéploiement quand il aura
aussi les fixes bind-pose côté retarget.

---

## 2026-06-02 (anytop-retarget — bind-pose anchor + rest tracks for unmatched joints — diag wmuo726kk)

**Pourquoi**: après les fixes Stage-1 + role-classifier, le retarget produisait
bien 21/21 bones matchés mais (a) le perso était téléporté à l'origine du monde
au lieu de partir de sa bind-pose, et (b) les bones target sans match source
(doigts, twist bones, tips) dérivaient avec l'animation du parent au lieu de
rester à leur orientation de bind. Workflow `wf_8b65a431` a fanné 3 worktrees ;
le vote a adopté 2 fixes et rejeté un troisième (`src-rest-from-bvh-tpose`,
avg 27/100, 3 votes reject).

**Diagnostic source** : `wmuo726kk`.

**Changements** (`scripts/anytop_retarget.py`) :

1. **Bind-pose anchor on root translation track** — la translation root est
   maintenant `world_by_idx[hip_tni] + (root_pos - root_pos[0:1]) * scale`
   au lieu de `root_pos * scale`. Le perso démarre à sa hip bind world position
   et translate RELATIVEMENT au lieu d'être téléporté à l'origine en début
   de clip.

2. **Constant rest-quat track for unmatched joints** — ajoute le helper
   `_emit_rest_quat_track(tni_)` qui émet une rotation channel à 2 keyframes
   (constant = `tgt_rest_quat[tni_]`) sur tout target joint sans mapping
   source. Sans cette track, LBS combinait le local bind de l'unmatched bone
   avec le world animé du parent, ce qui faisait dériver les vertices
   (doigts, tips, twist bones Puppeteer-specific). Avec la track, la mixer
   tient l'orientation bind chaque frame.

**Validation** : `matched 21/21 target bones to source`, root translation
`hip_tni=33 scale=0.0047 frames=20`, **35 channels** (au lieu de 22 — +13
rest-quat tracks émis pour les unmatched + 1 root translation), 20 samples,
output 67 MB OK, pas de traceback.

**Vote rejeté** : `src-rest-from-bvh-tpose` (avg 27/100, 3× reject) — proposait
de reconstruire le rest source depuis une t-pose du BVH. Trop spéculatif et
risquait de re-introduire de la dérive sur les rigs sans t-pose explicite.

## 2026-06-02 (role classifier — false-tail misclassification fix — diag wtwf1ae2i)

**Pourquoi**: sur les rigs `humanoid_puppeteer` (Puppeteer output), le
classifier de roles anatomiques bucketait à tort une partie de la jambe
gauche de l'orc dans `tail`. Conséquence : le mapping retargeting
attribuait des bones de queue à une chaîne qui n'en avait pas, produisant
des poses cassées sur le quart inférieur du perso.

**Diagnostic source** : `wtwf1ae2i` (run de diagnostic dédié au role
classifier sur humanoid_puppeteer).

**Changements** :

1. **`scripts/rig_mappings/ue5_mannequin__humanoid_puppeteer.json`** — ajoute
   une table `target_bones` explicite déclarant les bones de la cible et
   leurs rôles attendus (hip/spine/leg/arm/neck/head, PAS de tail). Cette
   table devient AUTHORITATIVE et override la classification heuristique
   pour les rigs déclarés `humanoid_puppeteer`.

2. **`scripts/rig_mappings/_loader.py`** — charge et expose la nouvelle
   table `target_bones` aux consommateurs (anytop_retarget).

3. **`scripts/anytop_retarget.py`** — consume la table `target_bones` du
   mapping quand elle est présente ; sinon retombe sur l'heuristique
   actuelle. Élimine la mis-classification false-tail.

**Validation** : `matched 21/21 target bones to source`,
`tgt roles = {'hip': 1, 'spine': 3, 'arm': 8, 'leg': 8, 'neck': 1}`
(aucun bucket `tail` parasite), 22 channels, 20 samples, output 67 MB OK.

## 2026-06-02 (Stage-1 AnyTop retarget fixes — workflow wf_20d765c3)

**Pourquoi**: 3 worktrees parallèles (charmap, family-classifier, root-translation)
ont chacun proposé un fix pour des symptômes différents observés sur AnyTop +
FBX-retarget. Vote ADOPT sur les 3. Appliqués séquentiellement sur master dans
l'ordre : charmap (cosmetic only) -> family classifier -> root translation.

**Changements**:

1. **`scripts/anytop_retarget.py` + `scripts/fbx_motion.py` + `scripts/rig_mappings/_loader.py`**
   (charmap) — remplace les flèches Unicode `→` par `->` dans docstrings,
   commentaires et logs. Évite les `UnicodeEncodeError: 'charmap' codec` sur
   Windows quand stdout n'est pas en UTF-8 (cas par défaut de Modal worker logs
   redirigés vers fichier). Aucun changement comportemental.

2. **`modal_app/_anytop_anim.py`** (family classifier) — ajoute
   `_count_target_roles()` qui compte les rôles anatomiques (wing/leg/spine) du
   rig cible via `_target_anatomical_roles` de anytop_retarget. Cette grille
   role-based devient AUTHORITATIVE dans `_pick_trained_class()` et OVERRIDE
   l'heuristique géométrique `_detect_topology_family` (qui classait un
   quadrupède aux genoux écartés comme 'flying' parce que lateral_long >= 4).
   Gates : `wings==0 and legs>=4` -> Bear/quadropeds ; `wings>=2` -> Dragon/flying ;
   `wings==0 and 1<=legs<=3 and spine>=1` -> Trex/bipeds.

3. **`scripts/anytop_retarget.py`** (root translation) — ajoute un canal
   `translation` sur le hip target node, sourcé depuis `motion['root_pos']`
   avec scale `tgt_hip_y / src_hip_y` (calculé en marchant la chaîne d'offsets
   jusqu'à la racine BVH). Sans ce track, le perso animait ses membres sur
   place sans jamais se déplacer dans le monde. FBX path déjà pre-rotated
   root_pos sur l'axe target (line 654 du retarget), donc on ne fait que
   scaler ici. Resample FPS aligné sur la logique quat-resample existante.

**Validation** : `python c:/tmp/run_fbx_retarget_local.py` produit 23 channels
au lieu de 22 (la translation track est bien émise), `scale=0.0047 frames=20`
pour orc_marron + AS_Orc_M1_Run.fbx.

**À faire ensuite** :

- Re-tester sur dragon AnyTop pour confirmer que le family classifier route
  bien sur `flying/Dragon` quand wing_count>=2.
- Re-tester sur quadrupède (Bear/Lion) pour confirmer que le faux-positif
  'flying' a disparu.

## 2026-06-02 (cloud anim viewer — toujours jouait l'Idle procédural)

**Pourquoi**: en testant le viewer local du FBX retarget, on a découvert que
la pipeline Puppeteer bake 3 anims procédurales (Idle/Walk/Run) dans tout
rig produit, et que sur certains rigs (orc_marron) ces procédurales sont
visuellement cassées (perso à l'envers). Le viewer cloud appelait
`gltf.animations[0]` qui est toujours `Idle` procédural — donc tout
résultat AnyTop / FBX-retarget était jugé sur la mauvaise track.

**Conséquence rétrospective**: les semaines de "AnyTop bouge dans tous les
sens" jugeaient probablement le Idle procédural cassé, pas l'output réel
d'AnyTop. Les fixes basis-change / clamp / swing-twist / smoothing
appliqués sur `scripts/anytop_retarget.py` ce mois-ci ciblaient peut-être
le mauvais problème.

**Changements**:

- `cloud/public/app/index2.js:14053+` — le picker préfère le LAST clip
  dont le nom n'est pas dans `{'Idle','Walk','Run'}`. Tombe sur le dernier
  index sinon (rig sans procédurale). Le clip AnyTop a un nom `anim_type`
  lowercase (`run`, `idle`, `walk`), donc l'exclusion en CamelCase est
  safe.

**À faire ensuite**:

- Re-tester AnyTop sur dragon avec ce viewer corrigé pour juger le vrai
  output.
- Le workflow `wqt873669` apporte en parallèle 3 fixes Stage-1 (root
  translation, family classifier quadropeds, charmap encoding) — sera
  committé séparément quand il termine.

## 2026-06-02 (AnyTop dragon unblock — 6 commits, root cause = ZYX channel swap)

**Trigger**: user reported "AnyTop fait n'importe quoi en boucle" on Puppeteer-rigged dragon. Months of basis-change / clamp / swing-twist patches had not improved output.

**Three root causes** (all in our retargeter, none in AnyTop generation):
1. **Cloud viewer played procedural Idle clip instead of AnyTop output** — judgments for weeks were misleading (workflow w7c0wn4tm + commit 7a7663c)
2. **scripts/anytop_retarget.py emitted absolute root translation + 6 of 47 skin joints had no rotation track** — hip teleported +49 cm at frame 0, LBS ripped mesh apart (workflow wmuo726kk diagnostic + commit 4629d3b)
3. **_eulers_to_quats silently swapped X and Z axes on ZYX-declared BVH joints** — bvhsdk returns [X,Y,Z] columns but scipy was being told ZYX. THIS WAS THE MAJOR BUG: 71° mean per-frame delta, 175° max, 87% of joints affected (workflow w8nuzxpih audit + w74g6bqmg empirical + commit 94c66b2)

**Empirical validation chain**:
- wmuo726kk dissected the broken job c46ed091 GLB — found bind-pose offset + 6 muted joints
- wr0qblb4y rendered the raw BVH on its native 142-bone skeleton — confirmed AnyTop generation is clean (74° mean std, 0 frozen, 0 tumbling, plausible landing-dragon trajectory)
- w1rptewtl re-ran the dragon retarget locally with the bind-pose fixes — channels 42→48, frame-0 anchored correctly
- w8nuzxpih audited the ZYX channel handling — found _eulers_to_quats was structurally wrong
- w74g6bqmg applied the ZYX patch and measured the quaternion delta vs bind-only fix: mean 71°, max 175°, 41/47 joints diverging — proved the ZYX issue was the structural bug
- Visual validation at http://localhost:8765/compare.html — user judges visually

**Paper + repo audit** (workflows wfa5a7aa5 + wpzod1fht + w10o5iuc0 + wii1edjsz):
- AnyTop is graph-conditioned single model on 4-tuple skeleton input — NOT per-class checkpoints
- Trained on Truebones Zoo ($99 Gumroad royalty-free, MIT code) — safe-with-conditions for commercial ship
- Issue #32 BVH writer drops End Site motion (fixed via Stage-2 patch_bvh_leaves)
- utils.process_new_skeleton offers a Mode 4 pivot path (28h sprint, kept in backlog as v2 option)

**Six commits delivered**:
- 7a7663c cloud-anim-viewer: pick AnyTop output clip, not procedural Idle
- 83d9730 anytop Stage-1: charmap + family classifier + initial root translation track
- 482bf10 retarget-fbx: role-classifier drops false-tail misclassification
- 4629d3b anytop-retarget: bind-pose anchor + rest-quat tracks for unmatched joints
- 6bb442f anytop-modal: Issue #32 BVH leaf patch + --seed + --output_dir + pinned SHA + MIT header
- 94c66b2 anytop-retarget: ZYX channel order — _eulers_to_quats permutes XYZ columns per scipy intrinsic sequence (THE big one)

**Modal**: deployed twice (after 6bb442f, after 94c66b2). Final endpoint https://fabienlacaze--myfabmesh-anim-anim-router.modal.run alive, ANYTOP_COMMIT=e780d15 pinned, 0 traceback.

**Validation harness**: c:/tmp/viewer/compare.html (BEFORE original broken vs AFTER fully fixed), c:/tmp/anytop_validate.ps1 (one-command cloud retest).

**Next session priorities**:
- User visual confirmation in compare.html and cloud UI
- Push commits (`git push` — not done yet, awaiting user)
- If commercial dragon quality not good enough: Mode 4 pivot (28h, wpu63xcbx PoC ready)
- Purchase $99 Truebones Zoo license + read EULA for the ML-derivative clause before any commercial cut

## 2026-06-02 (FBX reference-animation pipeline — Apovivor → Puppeteer)

**Pourquoi**: AnyTop génère du motion sur les classes natives mais l'utilisateur
veut aussi pouvoir importer un .fbx de référence (Apovivor ORC_M1, UE5 Mannequin)
et le retarget direct sur son rig Puppeteer — bypass total du sampler.

**Décision**: pipeline JSON-driven extensible — ajouter un nouveau skeleton =
ajouter un JSON, jamais de code dans le core retargeter.

**Changements**:

1. `scripts/rig_mappings/ue5_mannequin__humanoid_puppeteer.json` (nouveau) —
   mapping UE5 27 bones → rôles Puppeteer (hip/spine/neck/head/arm/leg) +
   drop_patterns (twist/share/facial/finger/toe/IK) qui absorbent les bones
   superflus côté source.
2. `scripts/rig_mappings/orc_m1__humanoid_puppeteer.json` (nouveau) — hérite
   du UE5 mapping via `"extends"` et ajoute uniquement les drop_patterns CC4
   (cc_base_pelvis duplicate, ribstwist, breast). Preuve que la design scale.
3. `scripts/rig_mappings/_loader.py` (nouveau) — résout les JSON, applique
   `extends`, expose `load_mapping()`, `fingerprint_skeleton()`, et
   `make_classifier_chain()` qui chaine (drop → table → fallback).
4. `scripts/fbx_motion.py` (nouveau) — parse FBX via subprocess `bpy_worker.py`
   (GPL isolation : bpy n'est jamais importé dans le parent retarget). Output
   shape IDENTIQUE à `_parse_bvh()` pour réutilisation à 100% du retarget core.
5. `scripts/bpy_worker.py` (nouveau) — worker bpy headless, import FBX avec
   `automatic_bone_orientation=False`, bake action `visual_keying=True`,
   dump JSON+NPZ.
6. `scripts/anytop_retarget.py` (refactor ~15 min) — split en
   `retarget_motion_to_rig(rig, motion, source_classifier=...)` (core) +
   `retarget_bvh_to_rig` (wrapper BVH) + `retarget_fbx_to_rig` (wrapper FBX).
   Bug fix bonus : `_SIDE_TOKEN_L` / `_R` matchent maintenant le suffixe
   trailing `_l$`/`_r$` (UE5 convention).
7. `modal_app/_ref_anim.py` (nouveau) — app Modal séparée
   `myfabmesh-fbx-retarget` CPU-only, image bpy 5.1 + numpy + scipy, expose
   `/fbx-retarget-{start,status,fetch}` qui miment `/anim-*`. Volume séparé
   pour ne pas polluer le AnyTop output.
8. `cloud/src/worker.ts` — nouveau env var `MODAL_FBX_RETARGET_URL`,
   2 nouveaux handlers `handleAnimateFromReference` +
   `handleAnimateFromReferenceStatus`, route le résultat dans R2 sous
   `<uid>/animations/<base>_fbxref_<batch>_<ts>.glb` (discriminator reconnu
   par le filtre `isAnimation` côté UI). Extend `handleAnimUpload` avec
   `kind='reference_anim'` qui valide le magic Kaydara FBX et stocke sous
   `<uid>/anim_refs/<sha>_<name>.fbx`.
9. `cloud/public/app/index.html` — nouveau bloc UI "Import reference animation
   (.fbx)" dans Step 4 avec dropdown auto-détect, picker fichier, bouton go.
10. `cloud/public/app/index2.js` — wires `_wireFbxReferenceAnim()` qui upload
    → spawn → poll → reload project. Étend la regex `isAnimation` pour matcher
    `_fbxref_`.

**Bone count mismatch absorption** : drop_patterns côté source (silent skip
via sentinel '/', None, -1)), unmatched targets restent en rest pose (déjà
géré par le retarget core). Chain-length mismatch absorbé par le matcher
nearest-chain_idx existant.

**Pas de changement à `_puppeteer_rig.py` / `puppeteer_to_skeleton.py`**
(contrainte [[dont-touch-puppeteer]]).

**Tests** : loader résout les 2 JSONs, classifier chain renvoie les bons
tuples (drop sentinel pour ik_/twist_/finger_, table hit pour pelvis/spine,
fallback _classify_source_bone pour Bip01_Pelvis legacy). Image bpy ~390 MB
ajoute ~30 s cold start mais reste isolée du AnyTop image (~120 MB).

## 2026-06-02 (Anim PIVOT — Strategy 1: bundled cond + retargeting)

**Pourquoi**: Plan A `modal run ::main --action standalone --class-name Dragon`
a prouvé qu'AnyTop fait du VRAI motion (global_std=0.59, l2=30.37) sur sa
classe Dragon NATIVE (142 bones, noms `Bip01_Pelvis, BN_Tail01, Bip01_R_Thigh,
Bip01_R_HorseLink, ...`). Notre rig Puppeteer 47-bones est structurellement
étranger à ce que la class embedding Dragon a appris → output dégradé même
avec alias.

**Décision**: Strategy 1 Mixamo-style — AnyTop génère sur SA topologie native,
on retargete vers Puppeteer downstream. Puppeteer reste INTACT.

**Changements**:

1. `scripts/anytop_retarget.py` (nouveau, ~400 lignes) :
   - Parse BVH AnyTop (bvhsdk) → noms + parents + offsets + eulers/frame
   - Classifie chaque bone SOURCE par regex sur noms canoniques
     (`Bip01_R_Thigh` → leg_r_01, `BN_Tail_03` → tail_03, etc.)
   - Lit GLB rig user, IBM-based world positions
   - Re-classifie le target via la même heuristique que `_anatomical_names`
   - Matche (role, side, chain index) source ↔ target
   - Convertit Eulers BVH → quaternions, sign-continuity
   - Émet glTF AnimationClip — rig/mesh/skin INTACTS

2. `modal_app/_anytop_anim.py:_pick_trained_class()` (nouveau) :
   - 50+ patterns regex (Dragon, Lion, Horse, Eagle, Spider, Trex, ...)
   - Fallback topology si rien dans le prompt ne matche

3. `animate_mesh()` simplifié à 3 steps (au lieu de 5+) :
   - Step 1 : pick trained_class + ckpt_family
   - Step 2 : sample.generate sur BUNDLED cond.npy
   - Step 3 : retarget_bvh_to_rig
   - Plus de fabrication de cond.npy synthétique, plus de process_new_skeleton

## 2026-06-02 (Anim — topology routing + up_axis Y hardpin)

**Pourquoi**: re-test prod après le hotfix __jN a montré 3 problèmes
restants dans les logs Modal:
1. `step 0: pre-classified ckpt_family=bipeds` sur dragon → Ostrich
   class embedding utilisée. Le winged keyword check (`'dragon',
   'wing', 'fly', ...`) ratait parce que `prompt=''` et
   `anim_type='run'` ne contiennent aucun de ces tokens. Le client
   ne propage pas `asset_family`.
2. Anatomical classifier produisait `['hip', 'leg_l_01..leg_l_08',
   'limb_01..limb_38']` — 8 leg_l, 0 leg_r, 0 wing, 0 tail, 0 head.
   Le up_axis était auto-détecté par "plus grand côté de la bbox" →
   sur un dragon stretched tail-back, c'était Z (longueur) au lieu
   de Y → gauche/droite scrambled.
3. Quaternions au GLB level toujours quasi-identité (5° max) malgré
   `global_std=0.45` côté sampler — confirme suspect #4/#5 audit
   (perte dans BVH→GLB).

**Fixes (modal_app/_anytop_anim.py)**:

- `_anatomical_names()` : `up_axis = 1` hardpin (glTF spec Y-up).
  Plus de détection auto par bbox extent. side_axis = max(X, Z).
- `_detect_topology_family()` : nouvelle fonction qui inspecte la
  topologie du squelette (chaînes hangant du root, leur direction
  UP/DOWN, longueur) et retourne `flying / quadropeds / bipeds /
  all`. Comptage : `upper_long >= 2 → flying`, `lower >= 4 →
  quadropeds`, `lower == 2 → bipeds`.
- Step 0 : appelle `_detect_topology_family()` AVANT le fallback
  keywords prompt. Topologie prioritaire sur texte.
- Step 3 : utilise `_pre_ckpt` (résultat Step 0) comme source de
  vérité, plus `_pick_checkpoint(anim_type)` en première intention.

**Test attendu**: dragon → topology detected `flying` → ckpt
`flying_model_*` → target_class `Dragon` → wing/leg labels
symétriques (wing_l_NN + wing_r_NN + leg_l_NN + leg_r_NN).

Bug #3 (perte rotation BVH→GLB) traité dans un commit séparé après
validation des fixes #1/#2.

## 2026-06-02 (Anim hotfix — round-trip suffix __j<skin_pos>)

**Pourquoi**: après deploy des noms anatomiques, premier test prod a
crashé avec "No BVH joint name resolves to a GLB bone — BVH joints:
['hip', 'limb_01', 'leg_l_01']... GLB bones: ['joint20', 'joint36']...".
Les noms anatomiques côté BVH ne matchaient plus les nodes GLB
restés en `joint<N>`.

**Fix**: encoder le skin-local index dans le suffixe du nom BVH.

- `modal_app/_anytop_anim.py:_anatomical_names()` — append `__j<N>` à
  chaque nom anatomique où N = position dans `skin.joints[]`. Exemple:
  `hip__j0`, `wing_l_01__j17`, `tail_02__j33`.
- `scripts/bvh_to_gltf_anim.py:_map_bvh_to_glb()` — nouveau pattern
  `__j(\d+)$` prioritaire qui mappe directement par position dans
  `glb_bone_names` (= `skin.joints[]` order). Garde les 5 stratégies
  existantes en fallback.

T5 reste alimenté par la partie sémantique (`hip`, `wing_l`,
`tail`) ; le suffixe `__jN` se tokenise en bruit ignorable.

## 2026-06-02 (Mode 3 anim — anatomical joint names + drop alias guard)

**Pourquoi**: audit complet pipeline (agent acc4f279) a révélé que AnyTop
conditionne via T5 sur les **chaînes de caractères des noms d'articulations**,
PAS sur un class-id lookup. Notre alias `cond[Dragon] = cond[skel_name]`
était sémantiquement un no-op : mêmes noms `joint_0..joint_46` → T5
embedding ~zéro info → identity motion garantie.

**Changements `modal_app/_anytop_anim.py`**:

1. **Fix #3 (Step 3.5)** : drop le guard `target_class not in _cond`.
   Bug warm container : un run précédent laissait `cond["Dragon"]`
   d'un autre mesh → alias silencieusement skip → vieux Dragon réutilisé.
   Maintenant overwrite systématique.

2. **Fix #1 (Step 0 + 1) — DOMINANT** : nouvelle fonction
   `_anatomical_names(joint_idxs, parent_by_idx, world_by_idx, ckpt_family)`
   qui classifie chaque bone via topo + IBM world positions et assigne
   des labels sémantiques : `hip, spine_01..NN, neck_01..NN, head,
   tail_01..NN, wing_l_01..NN, wing_r_01..NN, leg_l_01..NN, leg_r_01..NN,
   arm_l/r_NN (humanoïdes), limb_NN (unmapped)`.
   Family-aware : `flying` → upper laterals = `wing`, sinon `arm`.
   Step 0 pré-classifie le ckpt_family AVANT le BVH extract pour que
   les noms soient injectés dans cond.npy via process_new_skeleton.
   Log preview des 12 premiers noms anatomiques.

**Diagnostic à observer**: logs Modal `anatomical names (flying): ['hip',
'spine_01', 'wing_l_01', ...]` + `step 3.5 ... joints_names[:8]=[...]`.
Si T5 reçoit enfin des strings sémantiques → step 4.5 probe doit
montrer `global_std > 0.01` (motion réelle, plus identity).

## 2026-06-01 (Mode 3 anim — routing override winged + probe step 4.5)

**Pourquoi**: workflow `wtdvocwde` (3 reviewers indépendants) verdict
unfixed-confirmed sur l'alias cond.npy seul. Les quaternions sont
bit-identiques entre run pré-fix et post-fix → conditioning no-op.
Root cause : `_pick_checkpoint('run')` matche `bipeds` AVANT `flying`
dans la chaîne if/elif, donc dragon → target_class='Ostrich'
(biped flightless) → embedding topologiquement incompatible avec
notre rig 47-bones ailé → near-identity motion.

**Changements `modal_app/_anytop_anim.py`**:
1. **Step 3.0 routing override** : détection mots-clés winged
   (`dragon, wing, wyvern, bat, pterodactyl, eagle, phoenix, griffin,
   pegasus, fly`) dans prompt OU anim_type → force ckpt 'flying' →
   target_class='Dragon' (classe trained qui match la topologie).
2. **Step 3.5 robustness** : guard `.item()` sur 0-d object array +
   `isinstance(dict)` assert + log keys pour debug.
3. **Step 4.5 probe** : np.load le .npy produit par sample.generate,
   log `shape, global_std, per_joint_std_mean, first_vs_last_l2,
   DIAGNOSIS`. Si `global_std < 1e-3` → conditioning ignoré (chercher
   --guidance_param manquant ou cond_mode). Sinon → motion réelle,
   problème dans BVH→GLB.

**Test**: dragon 'run' à re-générer, lire logs Modal `step 4.5 probe`.

## 2026-06-01 (Durable fix: Supabase user_assets + R2 thumbs migration)

**Pourquoi**: la pré-version (purge agressive on-demand) marchait mais
re-purgeait à chaque génération les caches des autres projets. Quota
localStorage 5 Mo trop petit pour 19 projets × dataURL PNG vignettes
+ emissive layers. Solution durable: déplacer les caches lourds hors
de localStorage.

**Architecture**:

1. **Nouvelle table Supabase `user_assets`** (`cloud/supabase/migrations/
   20260601_user_assets.sql`) — une row par asset (image-front,
   image-back, image-modified, image-removebg, image-rectified,
   image-upscaled, image-inpainted, image-facefixed, image-tpose,
   thumb-mesh). Colonnes: user_id, project, kind, r2_path, parent_path,
   meta JSONB, created_at. Index sur (user_id, project, created_at) +
   (user_id, kind, created_at). Unique (user_id, r2_path) pour
   idempotence. RLS: own_assets policy SELECT. Writes via service_role
   (worker). Appliquée via `npx supabase db push --linked`.

2. **Worker** (`cloud/src/worker.ts`):
   - `insertUserAsset(env, userId, project, kind, r2_path, parent_path,
     meta)` — UPSERT idempotent best-effort, never throws.
   - `r2PathFromPublicUrl(env, url)` — extrait la R2 key d'une public URL.
   - `handleGenerateImage`: accepte `projectName` dans body, INSERT chaque
     path comme image-front/image-tpose après le success path.
   - `handleCloudProjects`: query user_assets en parallèle avec jobs,
     merge images + back-photos + imagesData dans le map, tri newest-first.
   - `handleUserAssetsRecord` (POST /api/user-assets/record) — endpoint
     générique pour record any asset depuis le client (back-view,
     image-op, upscale, rectify, etc.). Idempotent.
   - `handleThumbsUpload` (POST /api/thumbs/upload) — accepte dataURL
     base64, upload R2 sous `<uid>/thumb/<base>.<ext>`, INSERT user_assets
     kind='thumb-mesh'. Cap 512 KB.

3. **Client** (`cloud/public/app/meshyAPI-cloud.js`):
   - `_userAssetKind(legacyKind)` mappe front→image-front etc.
   - `_recordUserAsset(projectName, urls, legacyKind, parentPath)` —
     fire-and-forget POST vers /api/user-assets/record.
   - `_appendCloudImages` appelle _recordUserAsset en plus du localStorage
     legacy (fallback transitoire).
   - `generateImages` passe `projectName` dans le body.
   - `saveThumbnail` upload via /api/thumbs/upload au lieu de localStorage
     setItem(dataURL). Cache l'URL retournée (~150 chars) dans
     `myfm:thumburl:<base>` (vs ~200 KB pour le dataURL).
   - `getThumbnail` lit l'URL cache, fallback legacy dataURL si présent.
   - **One-shot cleanup au boot**: drop `myfm:thumb:*`, `myfm:cloudimages:*`,
     `myfm:backphotos:*` (legacy, ~3-5 MB freed sur heavy users).

4. **Console-capture** (`cloud/public/app/console-capture.js` +
   `/api/client-log`): patch `console.*` en ring buffer 2000 lignes,
   auto-flush à chaque `completeJob()` vers
   R2 `<uid>/logs/<ts>_<kind>_<status>.log`. Permet à Claude de lire
   les logs browser sans copier-coller via `wrangler r2 object get`.

**Bumps wrangler.toml**: `MAX_USER_DAILY_CALLS` 100 → 1000 (heavy dev/test
sessions cassent 100 en un AM). Bornage cost reste via
MAX_DAILY_SPEND_USD ($5) + MAX_DAILY_MODAL_SPEND_USD.

**Backup branch**: `backup-before-supabase-images-20260601-155940` pour
revert facile si la migration foire.

**Phase 3 future** (non fait aujourd'hui): emissive layers (`myfm:emissive:*`)
→ IndexedDB. Aujourd'hui dropped au boot par le cleanup; à long-terme
mieux de les persister proprement.

## 2026-06-01 (Fix: localStorage QuotaExceeded silencing "no new image version")

**Symptôme utilisateur**: après une génération d'image cloud,
"Task complete" s'affiche mais la version strip reste à v9 max — aucune
nouvelle vignette n'apparaît. Le log diag `[image-gen] post-reload strip
rendered, images=10` confirme que le count ne bouge pas entre 2 gen
consécutives.

**Root cause** (audit workflow `wy88bzoyv`, 8 agents parallèles): le
`localStorage.setItem(_imgKey(projectName), ...)` dans
`_appendCloudImages` jette un `QuotaExceededError` parce que l'origine
localStorage du renderer est saturée — principalement par
`_emissiveLayerCache` qui sérialise des PNG dataURLs complets à chaque
sauvegarde Paint Tools (centaines de Ko par couche), plus image-style
cache, prompt cache, back-photo map. Limite navigateur ~5 Mo par
origine. Le catch d'origine était silencieux (`catch(_){}`), le commit
1ed25c9 l'a converti en `console.warn` mais sans réparer l'écriture →
le renderer continuait avec `r.success===true`, déclenchait
`reloadCurrentProject()` qui retombait sur l'état pré-gen (10 entrées)
et "rendait" la strip telle quelle.

**Fix** (`cloud/public/app/meshyAPI-cloud.js > _appendCloudImages`):
- Détecte `QuotaExceededError` (name + code 22/1014 + message regex)
- Libère l'espace: drop `myfm:emissive:*`, `myfm:imagestyle:*`,
  `fabmesh_nsfw_cache` (rebuildables à la demande)
- Réessaie l'écriture
- Si retry échoue: toast `error` explicite "localStorage full, clear
  site data"
- Si retry réussit: toast `warn` "cache cleared to free localStorage"

**Diag log enrichi** (`index2.js:4335`): ajoute `first=<URL>` à côté du
count — permet de distinguer "count stale" vs "count grew avec
même URL en tête" (dedup bug) en un coup d'œil.

**Secondary concerns** identifiés par l'audit (à traiter ensuite):
- Migrer emissive layers de localStorage vers IndexedDB (orders of
  magnitude plus de place)
- Le commit `4cdfa3e` impose un floor PNG ≥ 768px à TOUS les 7 callsites
  de `_assertImageBytes`, dont back-view/tpose/sheet/rectify qui
  produisent parfois 512px légitimement — à conditionner sur
  `source === 'Modal text2image'` uniquement
- Normaliser le shape `{path, folder, mtime, jobId}` à la frontière
  listImageFolders pour supprimer les `img.path || img` ambiguës

## 2026-06-01 (Material Adjust — new Tint (hue rotation) slider + dispatch fix)

Added a 7th slider to Material Adjust: **Tint** (hue rotation in
degrees, -180..+180, step 5, default 0). Pipeline mirrors the existing
brightness/sat/contrast sliders end-to-end:

- **Modal** `modal_app/_mesh_op.py`
  - `material_adjust` gains `hue_shift` param. PIL HSV path: convert
    RGB→HSV, point-shift H by `int(round(hue_shift/360*256)) % 256`,
    convert back. Range 0-255 because PIL HSV uses 8-bit channels.
  - **BUG FIX** in `run()` dispatch: `material_adjust` was falling
    through to `OPS[op_type](glb_bytes)` which DISCARDED params. So
    brightness/sat/contrast sliders were silently no-ops on cloud
    (only emissive/metallic/roughness were visible because they're
    forced to defaults `0/0/0.7` on every call). Added explicit
    `material_adjust` branch that reads all 7 params.

- **Desktop script** `scripts/mesh_material_adjust.py`
  - Added `hue_shift` arg + `--hue-shift` CLI flag. Same PIL HSV
    point-shift. Recorded in result JSON's `applied` block.

- **Desktop IPC** `src/main/main.js`
  - `material-adjust` handler now reads `hue_shift` from payload and
    passes `--hue-shift` to the script.

- **Live preview** `cloud/public/app/index2.js`, `src/renderer/index2.js`
  - Three.js shader injection extended with `uHueShift` uniform
    (radians). Hue rotation matrix in YIQ-ish basis (standard form):
    cheap GPU op, matches PIL output closely enough for preview.
  - Skipped when `abs(uHueShift) < 0.001` to keep the no-tint case
    free of matrix multiplies.

- **HTML** `cloud/public/app/index.html`, `src/renderer/index2.html`
  - New slider row `mat-hue_shift` (`min=-180 max=180 step=5 value=0`),
    label "Tint (hue °)" with int + ° formatter.

- **MAT_DEFAULTS + _matSetSliderLabel + _matReadParams + _matBindSlider**
  - All extended with `hue_shift` on both cloud and desktop. Label
    formatter conditional: `°` suffix for hue_shift, 2-decimal for the
    others.

- **meshyAPI-cloud.js** `materialAdjust` — forwards `hue_shift` in the
  POST body.

Deploys:
- Modal: `myfabmesh-cloud` (PYTHONIOENCODING=utf-8 to avoid the cp1252
  charmap error on the Modal CLI's `✓` glyph in the deploy summary).
- Cloud worker: `96ba562b-bbc4-42ed-bb8c-5fb500adde80`.

## 2026-06-01 (Cloud — mesh-op outputs now survive page reload)

`Material Adjust` (and any future mesh-op output) survived only inside
the JS session: R2 had the GLB but `/api/projects` + `/api/meshes`
weren't listing the `mesh-op/` prefix, so a refresh wiped the new
version. Fixed by tagging mesh-op uploads with the project slug and
extending both list endpoints.

**Worker — upload-side** `cloud/src/worker.ts`
- `handleMeshOp` now reads `projectName` from the request body and
  derives `projectSlug = sanitize(projectName || 'untitled')` (only
  `[A-Za-z0-9._-]`, max 120 chars). The R2 key changes from
  `<uid>/mesh-op/<ts>_<op>.glb` →
  `<uid>/mesh-op/<projectSlug>/<ts>_<op>.glb`.

**Worker — listing-side** `cloud/src/worker.ts`
- `handleListMeshes` lists `<uid>/mesh-op/`, parses the slug segment
  from each R2 key, sanitizes every known `projectName` with the same
  rule, and attaches the file to the matching project (fallback to
  most recent project if slug doesn't match).
- `handleProjects` does the same when assembling `projects[*].meshes`.

**Client wiring** `cloud/public/app/meshyAPI-cloud.js`,
`cloud/public/app/index2.js`
- `materialAdjust` + `meshTool` now accept a `projectName` arg and
  forward it in the POST body.
- Both callers in index2.js pass `p?.name`.

Same sanitize rule on both sides means the slug round-trips cleanly.
Legacy `mesh-op/` keys (no slug segment, written before this commit)
still attach to the most recent project via the fallback.

**Deploy** `cd cloud && npm run build && npx wrangler deploy` →
version c95fe7d8-e699-4666-8298-56905bc71769.

Desktop unchanged — its mesh-op output already lives in the local
project folder, so the filesystem persists it.

## 2026-05-31 (Desktop SDXL parity — guidance 9.5 + repeated negatives for animal/creature)

Ported cloud Modal `_realvis.py` tuning (commit `c7593ad`) to the
desktop SDXL bridge so animal/creature prompts get the same
anti-portrait treatment locally.

**Plumbing (3 files)** — `assetType` now flows renderer → main.js → env:
- `src/renderer/index2.js:3882` — add `assetType` to the
  `API.generateImages({...})` payload (computed earlier from the
  `#ws-asset-type` dropdown, was previously dropped before IPC).
- `src/main/main.js:3840` — destructure `assetType` from the
  `generate-images` IPC payload.
- `src/main/main.js:3882-3889` — inject `FABMESH_ASSET_TYPE` into
  `childEnv`. Trimmed + lowercased, defaults to `'character'`.

**Bridge (`scripts/local_juggernaut_bridge.py`, 4 edits)**:
- Lines 92-128 — read `FABMESH_ASSET_TYPE` from env into `_asset_type`,
  print to log. Also defensively force `_is_tpose=False` for
  `animal|creature` so prompt-keyword bleed (e.g. `neutral stance`)
  can't push them onto the DreamShaper+OpenPose path.
- Lines 234-289 — branch `negative_prompt` on `_asset_type`. The
  `animal|creature` branch mirrors `_realvis.py` verbatim: brute-force
  repeated anti-portrait tokens (close-up ×3, portrait ×3, headshot
  ×3, head only ×2, face only ×2, bust shot ×2, head and shoulders
  ×2, head close-up, head crop, cropped to head, zoomed in on face,
  extreme close-up, macro shot, dragon head, animal head close-up)
  plus the existing anti-doubling block. Other asset_types keep the
  existing tuning untouched.
- Line 268 → 272 — `guidance_scale` becomes `_cfg = 9.5 if animal|
  creature else 7.0`. T-pose override (=2.0) still wins below.
- Line 355 — manifest logging bugfix: `guidance_scale` was hard-coded
  to 7.0, now reads from `_pipe_kwargs.get('guidance_scale', 7.0)`.

**Skipped intentionally**:
- T-pose path (DreamShaper XL Lightning + ControlNet OpenPose) — kept
  separate at CFG=2.0; animal/creature forced off it.
- `scripts/sdxl_server.py` (img2img / inpaint endpoints) — out of
  scope for the text2image port.
- Other asset_types (character, vehicle, weapon, prop, building, env)
  — cloud applies the tuning unconditionally but the desktop path was
  retuned recently (commit `ca7086c`) so we preserve that.

**Risk notes**:
- CLI / sheet-gen / multiview callers that re-invoke the bridge
  without `FABMESH_ASSET_TYPE` set fall back to `'character'` (no
  regression but no benefit either).
- CFG 9.5 is aggressive — may crisp small-creature prompts.
- The Compel-style `(token:weight)` tokens kept in the negative are
  cosmetic (base diffusers pipeline strips them) — repetitions do
  the actual work.

Backup branch: `backup-pre-sdxl-tuning-port-20260531-212224`.

## 2026-05-31 (Cloud rig UI stall + bones-default)

Two user-facing issues on cloud rig flow:

**1. Bones toggle should be ON by default in the rig viewer.**
- `cloud/public/app/index2.js:2714` — `bones: false` → `true` in the
  per-viewer state defaults. `ensureSkeletonHelper(viewer)` is already
  called from `refreshAll()` so the skeleton renders on first frame.
- `cloud/public/app/index.html:659` and `:892` — added `class="active"`
  to the Bones buttons (rig viewer toolbar + lightbox 3D) so the button
  visually matches the new default.

**2. Cloud rig UI looked stuck at 90 % for 9 m+ when ETA was 1 m 30 s.**
Diagnosis (workflow + Modal volume cross-check): the underlying poll
loop was healthy, but two independent UI bugs converged.
- `cloud/public/app/index2.js:12592` — `expectedMs = 90000` (1 m 30 s)
  was the desktop figure. Real cloud time = 60-120 s Modal A10G cold
  start + 120-180 s rig pipeline ⇒ raised to 240 000 (4 min).
- `cloud/public/app/index2.js:12711` — `JOB_EXPECTED_MS.rig`
  120 000 → 240 000 for consistency.
- `cloud/public/app/index2.js:12599` — click handler now passes
  `onProgress` to `API.autoRigAI`. Each poll flips
  `job.bridgeReporting = true` (stops the synthetic `min(90,…)` cap)
  and creeps the bar 90 → 99 at +1 % per 20 s overshoot. Adds a
  textual subtitle "Still running… Xm Ys (Modal cold start probable)"
  past expectedMs so the user sees the job is alive.
- `cloud/public/app/index2.js:12591` and `cloud/public/app/index.html:606`
  — engine label "(local, neural)" / "(local)" was misleading: the
  compute runs on Modal cloud. Renamed to "(cloud GPU)".

**3. Rig resilience hardening** (silent failure modes flagged in workflow):
- `cloud/public/app/meshyAPI-cloud.js` autoRigAI:
  - `MAX_POLLS` 120 → 180 (10 min → 15 min hard cap) to cover dense-mesh
    rigs that empirically exceed 10 min.
  - Track consecutive 401/403 (≥ 3 → abort early with `authLost:true`
    and helpful "session expired" error instead of burning 15 min and
    returning a generic timeout — was the #1 hidden cause).
  - Track consecutive ≥ 500 (≥ 6 → abort with "Worker unreachable").
  - Persist pending rig job in `localStorage.fabmesh_pending_rigs`
    on spawn; clear on terminal status. Lets a refresh resume polling
    instead of stranding the GLB in R2 with no UI handoff.
  - Forward `st.warn` / `st.last_error` from Worker into `onProgress`
    so the UI can show "last warn: Modal HTTP 502 (will retry)" instead
    of an opaque pending.
  - On `status:'done'` with no `currentProject` (project switched
    mid-rig), dispatch `fabmesh:rig-done-orphan` DOM event with the
    GLB URL instead of silently returning success.
- `cloud/src/worker.ts:6460` and `:6531` — pending responses now carry
  `stage` and `last_error` so the client can surface real diagnostics.
- `cloud/public/app/index2.js` DOMContentLoaded — on page load, scans
  `localStorage.fabmesh_pending_rigs`, prunes entries > 30 min old,
  and probes `/api/auto-rig-status` for each. Toasts "rig completed,
  refreshing Projects" or "rig failed, credits refunded" so a refresh
  during a long rig no longer loses the result.

Modal-side FunctionCall termination check (synthetic .err sentinel on
OOM/SIGKILL where the outer except can't write) is deferred — needs
another Modal redeploy.

Build + deploy: `cd cloud && npm run build && npx wrangler deploy`.
New Version ID `ea8308d8-3e86-44fc-b57d-8180e5eb06c2`.

## 2026-05-31 (Async rig — deploy + e2e smoke test)

- Deployed `myfabmesh-rig` to Modal — new `rig_router` ASGI web function
  available at
  `https://fabienlacaze--myfabmesh-rig-rig-router.modal.run`
  (alongside the legacy `rig_mesh_endpoint` kept for curl tests).
- Updated Cloudflare Worker secret
  `MODAL_PUPPETEER_RIG_URL` → rig_router base URL (the Worker appends
  `/rig-start` and `/rig-status` itself, per the refactor contract).
- Rebuilt `cloud` (`npm run build`) and ran `npx wrangler deploy` so
  the worker bundle that knows about `/api/auto-rig-status` is live —
  new Version ID `2aeff95a-376a-4102-9225-738e421c218c`.
- E2E smoke test (`modal_app/_test_async_rig.py`, deleted after
  passing): from inside a Modal container with SHARED_SECRET injected,
  POSTed `/rig-start` with the cloud-hosted `mock/sample.glb`, polled
  `/rig-status` every 5 s until `ready:true`. Result:
    - `wall_seconds = 89.1`, `polls = 17`
    - `bytes = 13_367_244`, `magic = "glTF"` (valid GLB)
    - `ok = true`
  The rig pipeline now never holds an open Worker subrequest — `/rig-start`
  returned in 2.7 s (well under CF's 100 s cap) and the heavy 86 s rig
  work happens on a separate GPU container reachable via the volume.

## 2026-05-31 (Async spawn+poll rig refactor — Puppeteer rig no longer blocks the Worker)

- **`modal_app/_puppeteer_rig.py`** — wrapped the existing sync
  `rig_mesh` in async-aware error handling and added a `rig_router`
  `@modal.asgi_app()` exposing `/rig-start`, `/rig-status`, `/healthz`.
  - `rig_mesh(glb_bytes, job_id=None)` now mounts `/rig_data`
    (Volume `myfabmesh-rig-output`); when `job_id` is set it persists
    the rigged GLB to `/rig_data/<job_id>.glb` on success or writes a
    JSON `<job_id>.err` on failure.
  - Pipeline body extracted into `_run_rig_pipeline()` so both the
    legacy sync `rig_mesh_endpoint` (curl test path) and the new
    async router share the same staging logic with no copy-paste.
  - `rig_router.rig-start` downloads the source GLB on the CPU
    container (saves ~60 s of A10G time) and `.spawn()`s `rig_mesh`,
    returning `{job_id, status: 'queued'}` in ~1-2 s. Persists the
    FunctionCall id for cancel support.
  - `rig_router.rig-status` reloads the Volume and returns either
    `{ready: false}`, `{ready: false, error: ...}`, or
    `{ready: true, glb_base64, bytes}`.
- **`cloud/src/worker.ts`** — split the old blocking `handleAutoRig`
  into two routes:
  - `POST /api/auto-rig` (renamed contract → returns `{job_id,
    status: 'queued'}` instead of the rigged URL). Debits credits +
    modal-spend up front, calls Modal `rig-start`, persists the job
    record in R2 (`_meta/rig_jobs/<job_id>.json`, no new KV
    namespace) so the status route can refund + verify owner.
  - `POST/GET /api/auto-rig-status` (NEW). Polls Modal `rig-status`;
    on `'failed'` refunds credits + modal-spend; on `'done'` decodes
    the base64 GLB, magic-byte checks, uploads to R2 under
    `${user.id}/rigged/`, returns the public URL. Transient HTTP
    errors return `'pending'` so the browser keeps polling without
    burning the user's balance.
  - Added `RIG_COST` / `ESTIMATED_USD_RIG` constants and three R2
    job-record helpers (`putRigJobRecord`, `getRigJobRecord`,
    `deleteRigJobRecord`).
  - Registered the new route and added it to `MODAL_PATHS` so admin
    Modal-kill switch still gates it.
- **`cloud/public/app/meshyAPI-cloud.js`** — rewrote `autoRigAI` to
  spawn + poll (5 s cadence, 10 min hard cap, optional `onProgress`
  callback). Return contract unchanged (`{success, ok, glb_url,
  path, error?}`) so the canvas/viewer code is untouched.
- `MODAL_PUPPETEER_RIG_URL` semantics now: the BASE of the rig_router
  (e.g. `https://<ws>--myfabmesh-rig-rig-router.modal.run`). Worker
  appends `/rig-start` and `/rig-status` itself. Re-deploy Modal +
  update the secret, no `wrangler kv namespace create` needed.
- Type-check OK (`tsc --noEmit` exit 0). Python AST parse OK.

## 2026-05-31 (Modal slot consolidation — 8 fastapi_endpoints → 3 asgi_app routers)

- **`modal_app/app.py`** — refactored 8 legacy `@modal.fastapi_endpoint`
  decorators into 3 consolidated `@modal.asgi_app()` routers to free
  Modal Starter Web-Function slots (cap = 8/app, was at the cap):
    - `MyFabmeshPredictor.router` → `POST /text2image`
    - `MyFabmeshBackview.router` → `POST /{back_view,tpose,rectify,image_op,sheet}`
    - top-level `mesh_router` → `POST /{mesh_start,mesh_status}`
    - Each router also exposes a free `GET /healthz`.
- Added 4 DRY helpers (`_check_auth`, `_read_json`, `_png_response`,
  `_fetch_image`) — 8 inline shared-secret checks collapsed to a single
  central `_check_auth` call site (1455 → 1484 lines, net +29).
- Preserved: NSFW filter, `.spawn()` for cross-container mesh GPU
  dispatch, all `@modal.enter(snap=True/False)` lifecycle, image
  bindings, snapshot/scaledown config. R2 upload untouched (worker-side).
- AST parse OK on `external/TRELLIS2_win/.venv` python. 0 fastapi_endpoint
  decorators remain; 3 asgi_app decorators present.
- **`cloud/src/worker.ts`** — documentation-only update to the Modal
  backend comment block (callsite at line 4528) to reflect the new 3-router
  layout. NO CODE CHANGE: each `MODAL_*_URL` env var holds the FULL URL
  including the route path, so the migration is operational only —
  `wrangler secret put MODAL_TEXT2IMAGE_URL` etc. with the new ASGI URLs
  (`…-predictor-router.modal.run/text2image`, etc.).
- `tsc --noEmit -p cloud/tsconfig.json` passes clean.
- **5 endpoint slots freed** for future endpoints (Puppeteer rig already
  deployed in its own app; future animation / retopology / MV-Adapter
  front-end can now land in the main `myfabmesh-cloud` app without
  hitting the Starter cap or requiring plan upgrade).

## 2026-05-31 (Wave 2.4 — MVAdapter Modal endpoint deployable wrap)

- **`modal_app/_mvadapter.py`** — added 517-line self-contained Modal wrap
  on top of the existing pure `generate()` / `preprocess_reference()` /
  `grey_to_alpha()` / `build_plucker_embeds()` functions:
    - `modal.Image.from_registry("nvidia/cuda:12.4.0-devel-ubuntu22.04")`
      with torch 2.4.1 + diffusers + transformers + rembg + boto3 — matches
      `modal_app/app.py:_base_image` so cached pip layers are reused. The
      build-time step clones upstream MV-Adapter and runs FabMesh's
      `scripts/patch_mvadapter.py`, plus `snapshot_download` pre-warms the
      i2mv-sdxl checkpoints (~3 GB saved on cold restore).
    - `app = modal.App("myfabmesh-mvadapter")` with class
      `MyFabmeshMVAdapter` (`@app.cls`, A10G 24 GB, snapshot enabled,
      timeout 600 s, scaledown 300 s). `@modal.enter(snap=True)` loads the
      pipeline on CPU; `@modal.enter(snap=False)` moves to CUDA after
      hydration so snapshot doesn't capture stale GPU pointers.
    - `mvadapter_endpoint` (`@app.function` CPU + `@modal.fastapi_endpoint
      method=POST`) — auth via `_auth` body field against `SHARED_SECRET`,
      downloads `front_image_url`, fans the work to the GPU worker via
      `.remote()`, uploads each of the 6 PNG views to R2 via boto3
      (`R2_*` secrets), returns `{views: [6 r2.dev URLs], engine,
      azim_elev}` — exactly the JSON shape the worker callsite
      (`cloud/src/worker.ts:4683-4702`) already expects.
- AST parse OK on `external/TRELLIS2_win/.venv` python (242 → 759 lines).
- **Not deployed in this commit** — user will run `modal deploy
  modal_app/_mvadapter.py` after the Puppeteer rig deploy finishes to
  avoid two Modal builds fighting for slots in the same workspace.
- Post-deploy: capture the printed endpoint URL into a Cloudflare worker
  secret (`npx wrangler secret put MODAL_MVADAPTER_URL --env production`),
  then `cd cloud && npm run build && npx wrangler deploy` so the worker
  picks up the new env binding.

## 2026-05-31 (Cloud→desktop parity ports 2/3/5/6 — webp gate, empty-mask early-out, steps cast, IPAdapter neutralisation)

- **Port 2 (KTX2/WebP GLB export gate)** — `scripts/trellis2_native_full_pipeline.py:307-311`
  and `scripts/face_inpaint_atlas.py:315-319`. Both exports now branch on
  `FABMESH_TRELLIS2_EXPORT_WEBP` (default `'1'`): when enabled, GLB textures are
  written as KTX2/WebP via `extension_webp=True`; otherwise legacy PNG GLB path
  (compat with downstream tools that don't read KTX2). Matches the cloud worker
  which has been emitting WebP atlases since cat 7.
- **Port 3 (empty-mask SDXL early-out)** — `scripts/face_inpaint_atlas.py:301-305`.
  After computing `mask_white_ratio`, if <0.1% of the atlas is masked we
  passthrough-copy the input GLB and exit before loading the SDXL inpaint
  pipeline (~6 s VRAM warmup avoided). Same sentinel as cloud's
  `face-inpaint-atlas` modal endpoint.
- **Port 5 (`int(steps)` cast on diffusers calls)** — `scripts/generate_back_view.py:347`,
  `scripts/generate_front_tpose.py:148` (`run_from_prompt`) and `:180`
  (`run_from_image`). Diffusers ≥0.30 raises `TypeError` if `num_inference_steps`
  is a Python `float` (from JSON parse); the cloud already casts and the desktop
  now matches.
- **Port 6 (neutralise IPAdapter in pure-prompt path)** — `scripts/generate_front_tpose.py:136-139`.
  After `load_pipeline()` in `run_from_prompt`, wrap
  `pipe.set_ip_adapter_scale(0.0)` in try/except so that even if a prior call
  in the same Python process loaded an IPAdapter weight, the prompt-only run
  is not biased by a stale reference image. Mirrors cloud
  `_front_tpose_from_prompt` behaviour.
- Pre-commit AST + py_compile checks: all 4 files OK on
  `external/TRELLIS2_win/.venv` python.

## 2026-05-31 (Cat 8 mask-inpaint cloud parity — crop+composite-back in `scripts/sdxl_server.py`)

- Port Cat 8: aligned `do_mask_inpaint` with cloud `modal_app/_mask_inpaint.py`
  (cat8 revision). Brings 3 quality wins to the desktop `/mask_inpaint` endpoint:
  1. **Concept boosters** — 25-entry `_CONCEPT_BOOSTERS` dict expands weak SDXL
     keywords (bazooka, sword, helmet, cyborg, wings, dragon, etc.) with
     concrete visual descriptors. Bare `"bazooka"` was rendering as a tube;
     now resolves to "M1 bazooka shoulder-fired rocket launcher…".
  2. **add/remove verb parsing** — `_enrich_prompt` strips `add/put/place/insert/
     paint/draw` and matches `remove/delete/erase/hide/clear` for removal
     prompts (negative-prompts the target, positive-prompts background continuation).
  3. **Crop-inpaint-paste** — for masks <40% coverage, crop a square 30%-padded
     bbox, inpaint at 1024², resize back, paste, then composite at full res
     against the original blurred mask. Painted pixels only — no global resize
     blur on untouched areas.
- Global path (mask >40%) still uses a composite-back blend so the un-masked
  pixels match the input byte-for-byte (after the alpha-1 mask region).
- Empty-mask sentinel changed from `(mask > 128).mean() < 0.1%` to
  `_mask_bbox(threshold=30) is None` — slightly more permissive on faint
  strokes, same JSON error shape `{"ok": false, "error": "Mask is empty"}`.
- API unchanged: `do_mask_inpaint(input_path, mask_path, prompt, output_path)`
  signature and `{ok, output, time, mask_coverage}` return dict are byte-identical.
  No HTTP handler change.
- Added `import re` at top of the file (was missing).
- Kept: `state.inference_lock`, `unload_model('img2img')`, `load_inpaint()`,
  `state.last_use['inpaint']`, `save_debug_mask`, `torch.inference_mode()`,
  `free_vram()` error path. NSFW + GPU-throttle code paths untouched.

## 2026-05-31 (Cat 14 mesh-op cloud parity — preset selector in `scripts/mesh_tools.py`)

- Port Cat 14: aligned desktop mesh tools with cloud `modal_app/_mesh_op.py`
  via a `PRESETS` registry + selector (env `FABMESH_MESH_PRESET` or CLI
  `--preset cloud_parity` / alias `cloud`). Default `desktop` preserves
  existing behavior — `smooth iterations=3 / decimate target_faces=5000`
  — so the renderer's UI Quick buttons keep working unchanged.
- Cloud-parity preset values: `smooth iterations=5`, `decimate
  target_faces=50_000`, Loop subdivision (`subdivide_loop`, with the
  cloud's `len(faces) > 500_000` bail and 2-iter cap), GLB export with
  `extension_webp=True`.
- Decimate now also gains 3 safety rails ported from cloud unconditionally
  (no behavior change for non-edge cases): early-out when biggest mesh is
  already ≤ target, ratio clamp `[0.05, 1.0]`, skip meshes < 100 faces.
- Files: `scripts/mesh_tools.py` only. `scripts/subdivide.py` untouched —
  midpoint path still shells out to it for the default desktop preset.
- No NSFW / GPU-throttle code paths touched.

- Port Cat 5: removed humanoid-specific tokens from `build_prompt()` in
  `scripts/multiview_sheet_gen.py` so the 2x2 multi-view sheet works for
  vehicles, buildings, props — not only humanoids.
- Changes (verbatim port from `modal_app/_sheet.py:_build_prompt`):
  - default subject token: `'character'` -> `'subject'`
  - sheet label: dropped the word `character` ("orthographic character
    model sheet of …" -> "orthographic model sheet of …")
  - pose line: `'T-pose neutral stance, arms extended, full body visible
    in each cell'` -> `'neutral stance, full subject visible in each
    cell'`
  - consistency line: `'consistent character identical across all cells,
    same lighting'` -> `'consistent identical subject across all cells,
    same lighting'`
- Untouched: `NEG_PROMPT`, `LAYOUTS`, `ORIENT_AZIM_ELEV`, `split_sheet`,
  `main()`, IPAdapter loading, CLI args. Function signature
  `build_prompt(subject_hint, layout)` unchanged. Return shape (PNG +
  views.json) unchanged. Zero call-site impact.
- Behavioural note: same seed will now produce a slightly different
  image (prompt text is part of SDXL conditioning). Humanoid callers
  that relied on the implicit `T-pose` token should add it to
  `prompt_hint` — follow-up may re-inject `T-pose` conditionally when
  `asset_type == humanoid`.

## 2026-05-30 (Rig anim fix — puppeteer_default 34-bone template)

- Bug: rigged mesh exploded during Run animation playback even though
  bind pose (Idle) was clean. Auto-rig pipeline produces a 34-bone
  Puppeteer skeleton via `puppeteer_to_skeleton.py --target orc_m1`
  (anatomical naming from 117-bone orc_m1 template), but Step 3
  `bake_procedural_anims.py` was reading the FULL 117-bone orc_m1.bones.json
  for its bone[].head base translations. For bones present in both
  (`pelvis`, `spine_03`, `thigh_l` …) the .head values from orc_m1's full
  anatomical layout did not match the rigged GLB's actual node
  translations — so Hips translation track (hip_bob vertical) started
  from a wrong base and dragged the skeleton along.
- Workflow extracted the 34-bone hierarchy directly from the rigged GLB
  (`meshes/orc_marron_trellis2_native_*_rigged_puppeteer_*.glb`) and
  produced `scripts/rig_templates/skm/puppeteer_default.bones.json`
  (34 bones, single root `pelvis`, parent chain unbroken, every .head =
  real GLB local translation).
- Fixes applied:
  - New file `scripts/rig_templates/skm/puppeteer_default.bones.json`
    (34 bones with matching .head values).
  - `scripts/rig_templates/skm/registry.json`: appended `puppeteer_default`
    entry to `skm_templates` (with humanoid variete + label).
  - `src/main/main.js` (auto-rig handler around lines 2536-2548):
    Step 3 bake now reads `puppeteer_default.bones.json` instead of
    `${rigSkeleton}.bones.json` when engine=puppeteer. Step 2a rename
    still uses `rigSkeleton` (e.g. orc_m1) so anatomical naming stays
    consistent.
- Bake smoke test (workflow verify phase): 3 clips (Idle/Walk/Run) baked
  cleanly against test GLB, **0 orphan tracks**, all 12 anim targets
  resolved to existing joints. UniRig branch (117-bone path) unchanged.
- Open follow-ups: legacy fallback branch (`puppeteer_to_orc_m1.py` +
  orcBones) still uses 117-bone template — not fixed in this commit since
  it's a transitional path. Non-humanoid Puppeteer targets (wolf/dragon)
  will now silently fall back to non-animated rig — acceptable since
  Puppeteer's HF model is humanoid-trained.

## 2026-05-30 (TRELLIS-2 attention: flash_attn uninstalled, sdpa authoritative end-to-end)

- Windows SAC was blocking `flash_attn_2_cuda.dll` on the target machine
  (user formally prohibits disabling SAC). Even with the existing
  Python-side `os.environ.setdefault('ATTN_BACKEND','sdpa')` at the top
  of `scripts/trellis2_native_full_pipeline.py`, an inherited parent-env
  value or a polluted wrapper (notably `scripts/local_hi3dgen_bridge.py`
  which used to FORCE `ATTN_BACKEND=flash_attn`) would silently win
  because `setdefault` is non-authoritative.
- Mapping evidence (deferred-tool ToolSearch agents) confirmed every
  `import flash_attn` in trellis2 lives inside `if config.BACKEND/ATTN
  == 'flash_attn'` branches with no try/except guard — so the only ways
  to hit the SAC block are (a) ATTN_BACKEND=flash_attn slipping through
  or (b) the .pyd existing on disk and being touched by some other lib.
- Fixes applied:
  - `src/main/main.js` (Electron image-to-3d spawn env block, around
    lines 4183-4200): added authoritative entries AFTER `...process.env`
    so parent-env pollution can never override:
      `ATTN_BACKEND='sdpa'`, `SPARSE_ATTN_BACKEND='sdpa'`,
      `TORCHDYNAMO_DISABLE='1'`, `TORCHINDUCTOR_USE_TRITON='0'`,
      `TRANSFORMERS_ATTN_IMPLEMENTATION='eager'`,
      `TRELLIS2_USE_KAOLIN_RASTER='1'`.
  - `scripts/local_hi3dgen_bridge.py` (lines 67-68): switched the
    Hi3DGen wrapper from forcing `flash_attn` to forcing `sdpa`. The
    sparse module DOES support sdpa via the fp32-math branch
    (`modules/sparse/attention/full_attn.py:214-254`) which is the
    canonical Blackwell sm_120 path.
  - `scripts/wizard_install_deps.py` (~lines 168-176): the optional
    flash-attn install is now opt-in via `WIZARD_INSTALL_FLASH_ATTN=1`
    env var. By default the wizard skips it with a "SAC-blocked; sdpa
    backend is authoritative" message.
- Filesystem cleanup: uninstalled flash_attn 2.8.2 from the trellis2
  venv (`external/TRELLIS2_win/.venv`). pip metadata showed zero
  reverse-dependencies, so this is clean.
- IMPORTANT: requires a full Electron restart (main.js changed) — Ctrl+R
  is NOT enough. See "Restart Electron quand main.js change" rule.

## 2026-05-30 (backup: 12 Apovivor skeletons + TRELLIS-2 patches + ATTN_BACKEND default + audit doc)

- Bulk safety commit covering several days of un-staged work.
- 12 skeleton .bones.json templates extracted read-only from
  Apovivor (bat/crocodile/crow/deer/dragon/elephant/lion/spider/turtle/
  ue5_mannequin/wolf/zebra) + registry.json updated.
- TRELLIS-2 mesh-gen patches: `ATTN_BACKEND=sdpa` default in the
  pipeline (so flash-attn .pyd is never loaded — Smart App Control
  blocks unsigned binaries) + mirror of the
  `external/TRELLIS2_win/src/trellis2/models/__init__.py` patch
  (relative ckpt path resolution) under
  `scripts/trellis2_upstream_patches/` with re-apply docs.
- AUDIT_2026-05-29.md: full multi-agent audit report committed.
- .gitignore: `external/Puppeteer/` added (22 GB venv + ckpts).

## 2026-05-30 (prompts: animal de-dup tail tokens — SDXL was growing extras)

- Previous animal prompt (commit 7e4cd62) mentioned "tail" twice
  ("tail extending behind" + "head and tail at the same low height as
  the spine"). SDXL over-fixated and produced alligators with multiple
  tail-like protrusions branching off the body.
- Replaced with a single "ONE single tail only" mention + negative
  reinforcement: "exactly one tail, no extra tails, no multiple tails,
  no extra limbs". Horizontal-body convention preserved by the
  remaining tokens.

## 2026-05-30 (cloud: Puppeteer rigging deployed to Modal)

- Added modal_app/_puppeteer_rig.py: Modal Labs container with Puppeteer + all upstream patches replicated on Linux (no Windows-specific workarounds needed). HF ckpts baked into image. A10G GPU. ~3 min cold / ~1.5 min warm.
- Added /api/auto-rig worker endpoint: auth + 5-credit spend + Modal dispatch + R2 persist + sanitised error.
- Cloud renderer autoRigAI shim wired to the new endpoint (no more NOT_AVAIL).
- Cloud rig step UNHIDDEN — hideById removed from cloud-overrides.js.
- REQUIRED USER ACTION: modal deploy modal_app/_puppeteer_rig.py + wrangler secret put MODAL_PUPPETEER_RIG_URL. Full walkthrough in modal_app/PUPPETEER_DEPLOY.md.

## 2026-05-30 (rig UI: remove UniRig legacy option)

- Dropped the "MyFabmesh.AI Rig (legacy)" UniRig option from the rig engine dropdown. UniRig is confirmed broken upstream (skin writer Issue #20) and incompatible with RTX 5080 sm_120. Only Puppeteer remains. UniRig branch in main.js stays as dead code in case of future resurrection.

## 2026-05-30 (rigging: multi-skeleton target + Apovivor extraction tool + UI dropdown)

- Added scripts/puppeteer_to_skeleton.py: generalizes puppeteer_to_orc_m1.py with --target NAME arg. Targets: orc_m1 (default), ue5_mannequin, zebra, lion, wolf, crocodile, elephant, deer, crow, turtle, spider, bat, dragon, puppeteer_raw.
- Added scripts/apovivor_export_skeletons.py: READ-ONLY UE5 Python script the user pastes in Apovivor editor to extract 12 skeletons to scripts/rig_templates/skm/<name>.bones.json + update registry.json. NEVER writes to Apovivor content, NEVER saves Apovivor assets.
- Added SKELETON dropdown in desktop rig step UI with emoji + bone count per target (auto-fetched via new read-bones-json IPC).
- main.js auto-rig-ai now routes the user-selected target through puppeteer_to_skeleton.py. puppeteer_raw target short-circuits the bake step.
- Existing scripts/puppeteer_to_orc_m1.py kept for backward compat.
- REQUIRED USER ACTION before non-orc_m1 targets work: open Apovivor in UE5 -> Tools -> Python -> Execute Script -> paste content of scripts/apovivor_export_skeletons.py. Output JSON files land in FabMesh; Apovivor is read-only throughout.

## 2026-05-30 (rigging: Puppeteer joints renamed to orc_m1 + anims re-enabled)

- Added scripts/puppeteer_to_orc_m1.py — anatomical classifier that renames Puppeteer 34 generic joints (joint0..joint33) to orc_m1/UE5 conventions (pelvis, spine_01, clavicle_l/r, upperarm_l/r, hand_l/r, thigh_l/r, foot_l/r, etc.). World-space positions, not local — avoids the swap_skeleton.py classifier bug.
- main.js auto-rig-ai puppeteer path: puppeteer_bridge -> puppeteer_to_orc_m1 -> bake_procedural_anims -> final GLB. CC0 Idle/Walk/Run are now re-enabled (target the renamed skeleton).
- Backup branch: backup-pre-puppeteer-bone-remap-20260530-154204.
- Fallback: if classifier or bake fails, ships the raw Puppeteer GLB (current behaviour).

## 2026-05-30 (rigging: Puppeteer end-to-end SUCCESS on orc_marron)

- Live-debug session walked the Puppeteer pipeline through 10+ runtime
  errors to a clean rigged GLB: ~113s total on RTX 5080 (sm_120) —
  34s skeleton + 63s skinning + 10s FBX export + 3s GLB conversion.
  Output: 49.8 MB GLB with armature + skin weights.
- Bridge fixes committed: torchrun bypass for skinning (libuv broken
  on Windows PyTorch 2.7), bake_mesh = staged_obj, filtered rig.txt
  concat, lenient bpy GLB success check.
- Upstream patches applied in-place in `external/Puppeteer/`:
  weights_only=False in 3 torch.load sites, gloo dist backend on
  Windows, Michelangelo copied to skinning/third_partys/, vtk stub
  to dodge Windows Smart App Control DLL blocks.
- Venv: torch 2.7.0+cu128, flash-attn 2.7.4.post1 (prebuilt Win wheel),
  numpy <2, torch-scatter 2.1.2+pt27cu128, tetgen 0.8.4, full
  requirements.txt deps.

## 2026-05-30 (rigging: pivot to Puppeteer end-to-end, retire MA scaffold)
- User flagged that Puppeteer already produces the skeleton, so the MA+Puppeteer combo was redundant. Pivoted to Puppeteer end-to-end (same Apache-2.0, same team Seed3D).
- Added scripts/puppeteer_bridge.py with 3-step pipeline (skeleton -> skinning -> final_rigging/export -> GLB).
- main.js auto-rig-ai now defaults to puppeteer engine. unirig stays as legacy fallback.
- Removed scripts/magicarticulate_bridge.py + magicarticulate dropdown entry + IPC branch.
- REQUIRED USER SETUP: clone Seed3D/Puppeteer to external/Puppeteer/ + venv (torch 2.6+cu128 + flash-attn 2.7) + HF weights. Commands in puppeteer_bridge.py top-of-file docstring.

## 2026-05-30 (rigging: MagicArticulate bridge scaffolding)
- Added scripts/magicarticulate_bridge.py — Apache-2.0 replacement for UniRig (4.6 GB VRAM confirmed by upstream, 1-2 s/mesh, non-humanoid supported). Mirrors unirig_bridge.py CLI contract.
- main.js auto-rig-ai handler now defaults to magicarticulate engine; unirig stays as explicit fallback.
- UI dropdown #ws-rig-engine now offers both engines, magicarticulate first.
- REQUIRED USER ACTION before first use: clone Seed3D/MagicArticulate to external/MagicArticulate/ + create venv + pip install (see top-of-file comment in the new bridge script for exact commands).
- Cloud is unaffected (rig step hidden via cloud-overrides.js).

## 2026-05-30 (cloud: hide Rig step entirely)
- Step 3 Rig card (`#step-card-rig`) is now hidden via `hideById` in cloud-overrides.js. The "Under construction" overlay was retired with it — no need to mask a section that is not present at all. Rationale: rigging is being debugged on the desktop build (free, local stack), so the cloud surface should not show a non-functional Step 3.

## 2026-05-30 (cleanup: Meshy.ai external integration removed)

- Deleted scripts/meshy_bridge.py (273 lines — paid external service, https://api.meshy.ai).
- Removed Meshy.ai dispatch blocks from src/main/main.js (rig, text-to-image, image-to-3d). Removed test-meshy-key IPC handler + preload.js expose. Removed meshyApiKey from ALLOWED config whitelist.
- Removed Meshy entries from rig engine dropdown, error handlers, regex cleanup, timing estimates in src/renderer/index2.js + cloud/public/app/index2.js.
- Updated stale comments in cloud/public/app/meshyAPI-cloud.js.
- Updated ROADMAP.md M5 status.
- PRESERVED: internal `window.meshyAPI` / `MeshyAPI` shim object (our local wrapper, NOT the external service).
- Follow-up: closed 6 Meshy.ai stragglers — orphaned main.js paths to deleted bridge script (4 sites), Settings UI key field + test button in src/renderer/index2.js (5 sites), testMeshyKey STUB entry in meshyAPI-cloud.js. App no longer throws "script not found" when Meshy-era code paths are mistakenly reached.

## 2026-05-30 (audit: apply 20+ fixes from AUDIT_2026-05-29.md)

### HIGH (user-visible bug / blocking)
- **worker.ts invoice.paid metadata**: read from `subscription_details.metadata` first, then line items, then invoice, then `stripe.subscriptions.retrieve` — fixes zero-credit recurring renewals.
- **worker.ts handleGenerate catch arms**: added `refundMeshSpend()` on Modal/Replicate mesh-start failures so the daily GPU budget isn't permanently burned by a single failed start.
- **worker.ts asset_type contract**: now accepts both `asset_type` and `assetType` from FormData (defensive); paired with renderer-side rename below.
- **index2.js (cloud) asset_type rename**: `assetType` → `asset_type` in `/api/generate` payload — restores asset-type-aware pipeline (rectify mode, back-view dispatch, credit defaults) for every non-character cloud generation.
- **meshyAPI-cloud.js meshTool params**: positional arrays from `MESH_TOOL_SCHEMAS[*].build()` now translated to named objects matching `modal_app/_mesh_op.py` contract (smooth → iterations+lamb, decimate → target_faces, subdivide → iterations, retex_swap → image_url) — sliders are no longer silent no-ops.
- **index2.js (cloud) cancelJob**: captures `r.jobId` (worker side) into `job.workerJobId` and forwards that to `/api/jobs/cancel` instead of the local UI counter — cancel now actually stops the Replicate prediction.
- **index2.js (cloud) Add back photo**: routed through `API.saveImageDataUrl` (uploads to R2 and returns HTTPS URL) instead of the legacy `saveBuffer` download branch — multi-ref TRELLIS-2 now works on cloud.
- **cloud-overrides.js applyOverrides idempotent**: cheap DOM patches stay re-runnable; `_wrapTopbarRefresh`, `_watchModalOpens`, `installModalStatusPoll`, focus/visibilitychange listeners, and credits-refresh wrapping now gated behind `window.__cloudOverridesApplied` — stops N+1 chained `/api/me` calls and MutationObserver leaks on every Settings/About open.

### MEDIUM (impact present but not blocking)
- **worker.ts _processPayment INSERT**: only Postgres `23505` (duplicate key) is treated as the benign race; any other error returns `{ok:false, retry:true}` so Stripe retries — no more silent payment loss.
- **worker.ts handleMarketPublish**: image listings now pass through `isTrustedAssetHost()` (R2 / replicate.delivery / pollinations only) before the ownership check — kills the bait-and-switch laundering vector through `/api/market/download`.
- **worker.ts SSRF guard hoisted**: `isTrustedAssetHost` moved to module scope; called by `handleModifyImage`, `handleAutoInpaint`, `handleMaskInpaint`, `handleMaskInpaintXL`, `handleImageQuickEdit`, `handleMeshOp`, `handleStartMeshOp` Modal forwarders.
- **src/renderer/index2.js pushJob source snapshot**: 6-arg signature `(name, onCancel, params, expectedMs, opts)` with `opts.sourceImageUrl`/`projectName`/`assetKind`. `refreshJobDetailsModal` now prefers the snapshot — Job Details modal no longer shows the wrong thumbnail when user switches selected image mid-job (desktop parity with cloud).
- **index2.js (cloud) uploadClientMeshResult helper**: extracted the three chunked-base64 → `/api/mesh-op/client-result` POST blocks (mesh tools, paint emissive, paint mesh) into one function with explicit `opType` parameter — divergence stopped.

### LOW / cleanup
- **worker.ts market_sale notification**: branches on `paidCash` → "+X CURRENCY earned via Stripe" vs "+X credits earned" — no more support-ticket bait when seller is on Stripe Connect.
- **worker.ts listing.downloads**: moved counter to separate R2 key `_market/downloads/<id>.txt` with `etagMatches`/`etagDoesNotMatch` CAS (`bumpListingDownloads` + `readListingDownloads`) — fixes lost increments and the "resurrect freshly-rejected listing" window. Old race in `handleMarketDownload` and `_processMarketPurchase` retired.
- **worker.ts handleAdminMarketDelete**: now lists+deletes orphan `_market/owners/<id>/*`, `_market/ratings/<id>/*`, and `_market/downloads/<id>.txt` keys after the listing JSON.
- **worker.ts handleGenerate jobs INSERT**: captures `{error}` from the jobs row insert; on failure refunds credits + Modal/Replicate budget before returning 500 (previously Modal was called regardless).
- **worker.ts handleAdminContactReply**: sets `m.replied_read = false` on every reply write so a second admin reply re-flags the thread as unread.
- **worker.ts handleMarketCheckout**: Stripe error body logged server-side; client gets generic `'stripe checkout failed'` — no more upstream-body infra fingerprinting.
- **worker.ts mesh-start/replicate error returns**: log full error server-side; return generic `'cloud GPU … failed (credits refunded)'` to the client.
- **worker.ts _processMarketPurchase per-(user, listing) idempotency**: HEAD `_market/owners/<id>/<userId>.json` before writing sale/payout — duplicate Stripe webhooks no longer double-payout.

Worker Version ID: d7f4cf5d-f0ae-4d67-b1ea-e4ebf01869b6.

## 2026-05-29 (sculpt: fix save path + add job popup)
- Fixed sculpt save 404 on cloud: caller was unshifting the locally-built path (mesh/<orig>_edited_<ts>.glb) into p.meshes, but the worker writes to <userid>/edited/<name>_<ts>.glb (per-user scope) and returns its actual URL in r.url. Now the caller uses r.url (with fallback to r.path then locally-built path for desktop compat).
- Replaced 2-second "Saving new version..." toast with a proper job entry in the jobs bubble (kind: mesh_edit) — user sees a progress popup like for mesh generation, transitioning to done/error.

## 2026-05-29 (sculpt: persist edits to R2 on cloud)
- Added POST /api/upload-mesh worker endpoint: accepts { base64, filename }, writes to R2 under the same user prefix as Modal-generated meshes, returns { success, path, url }.
- Fixed saveBuffer shim in meshyAPI-cloud.js: dual-signature ({ path, base64 } uploads to R2 / { filename, buffer, mime } still triggers browser download). Returns BOTH success + ok so all callers work.
- Sculpt save no longer fails with "Save failed: unknown" on cloud — the edited mesh appears as a new version in the mesh strip.

## 2026-05-29 (cloud: fix sculpt empty viewport)
- `_meLoadMesh` was hardcoding `file:///` URL prefix, causing the sculpt modal to load nothing on the cloud (browsers refuse file:// from https origin). Fixed by branching on URL scheme: blob:/data: → direct, https:/http: → direct, modal_<hex>.glb → /api/mesh/get?path=, else → file:/// (desktop fallback). Cloud + desktop renderer in sync.

## 2026-05-29 (cloud: unhide Sculpt button)
- Sculpt mesh button is now visible + clickable on the cloud UI (was hidden by CLOUD_HIDE_BUTTONS in cloud-overrides.js). With the Three.js 6-brush + symmetry implementation shipped in ea85cad, sculpt runs entirely client-side — no server dependency, safe to expose. Paint Vertex, Select Face, TRELLIS-2 retexture, Blender, Show-in-folder buttons stay hidden (each for its own reason — see updated comment in cloud-overrides.js).

## 2026-05-29 (sculpt: Grab + Inflate brushes + Symmetry X/Y/Z)
- **HTML** `cloud/public/app/index.html` L2432 area + `src/renderer/index2.html` L2159 area: added `#me-sculpt-grab` and `#me-sculpt-inflate` buttons inside `#me-sculpt-opts`; added sibling block `#me-sym-opts` with `#me-sym-{x,y,z}` toggle buttons (kept outside the brush radio group since symmetry is orthogonal to brush type and the mode-switcher only show/hides `#me-sculpt-opts`).
- **JS state** `cloud/public/app/index2.js` L11110 + `src/renderer/index2.js` L8523: `meState` gained `symmetryAxes:{x,y,z}` (default off), plus grab-stroke transients `grabAnchor / grabScreen / grabMesh / grabLastDelta`.
- **JS dispatcher**: refactored `_meApplyBrush` so push/pull/smooth/flatten/inflate share a `_applyBrushAt(hit, point)` helper. Sculpt path now calls the helper once at the hit point, then once per enabled symmetry combo with the local-space point mirrored on the requested axes (covers single, double and triple-axis combinations). Push/pull/smooth/flatten math is unchanged — byte-identical when no symmetry is on.
- **Inflate**: expand along vertex normal (`vx + nx*amount`) using the existing `falloff^2 * strength * 0.01` weighting.
- **Grab**: requires pointer tracking, so it bypasses `_applyBrushAt`. `_meMouseDown` captures `hit.point` in mesh-local space + screen origin + the target mesh. `_meMouseMove` calls a dedicated `_meApplyGrab(e)` that projects the pixel delta through camera basis (right/up from `camera.matrixWorld`), converts to mesh local space (direction transform + world-scale compensation), and translates affected vertices by the *incremental* delta vs previous frame (so the brush feels like dragging, not jumping). `_meMouseUp` clears the stroke transients.
- **Bindings**: brush radio array extended to `['push','pull','smooth','flatten','grab','inflate']`; new `['x','y','z']` loop wires the symmetry toggle buttons with `.tool-active` feedback.
- **Parity**: cloud + desktop renderer files edited in lockstep.

## 2026-05-29 (preset: avion/bateau iter3 — single-view only)
- User reported chimera mesh on aircraft (banana fuselage, extra horizontal stab, extra dorsal engine). Root cause: sheet-pipeline back-view (IP-Adapter Plus) hallucinates geometry inconsistent with front view; TRELLIS fuses front + inconsistent back into a chimera.
- Iter 3 disables AUTO back-view generation for avion + bateau via AUTO_BACKVIEW_SKIP set. TRELLIS now runs single-view (front only) for these two types and infers the back from its training distribution.
- BACK_VIEW_PROMPT_HINTS kept (used when user manually supplies a back image).
- All other asset_types unchanged.
- Backup: backup-pre-modal-spend-detection-20260529-184522.

## 2026-05-29 (preset: avion/bateau pipeline fix)
- **Context**: user reported "le mesh est cassé" on passenger-aircraft generation — back view diverged from front, sheet pipeline IP-Adapter Plus invented a second front-facing plane instead of stern, rectifier distorted swept-wing geometry.
- **worker.ts**: added `BACK_VIEW_PROMPT_HINTS` map in `handleGenerate` (~L3562) keyed by asset_type. `avion` → "rear view of the same passenger aircraft from directly behind, tail fin and rear engines and rear fuselage clearly visible … ONE aircraft only, no second plane". `bateau` → "stern view of the same boat from directly behind, transom and rear hull and rear deck clearly visible … ONE boat only, no second boat". Previously `promptHint: ''` was hardcoded for all hard-surface types in both `callModalSheet` and `callModalBackView` paths.
- **index2.js (cloud + renderer)**: `ASSET_TYPE_PROMPTS.avion` and `.bateau` rewritten from weak "A detailed aircraft, side angle …" / "A detailed ship or boat, side angle …" to the proven vehicle pattern — `ONE … only, single instance, 3/4 isometric view, full body visible, plain white background, even studio lighting, no shadows, no clouds/water/horizon, centered, clean silhouette, no duplicate, no formation`.
- **ASSET_OPTIONS_PROFILE**: `ws-trellis2-rectify` flipped to `false` for `avion` and `bateau` in `cloud/public/app/index2.js`. Added the missing `avion` / `bateau` entries to `src/renderer/index2.js` (renderer was falling back to `custom` which keeps rectify ON). Rectifier in `iso` mode re-angles aerodynamic surfaces — opt-out is cleaner than threading a 3-way mode.
- Deployed to Cloudflare worker; restart-free (no main.js touched).

## 2026-05-29 (avion/bateau preset tuning — back-view prompt + front prompt + rectify off)
- **Why**: passenger-aircraft inputs were producing back views that diverged from the front (sheet pipeline IP-Adapter Plus inventing a second front-facing plane instead of the actual stern). Front prompt was also too weak — no anti-duplicate tokens, no "ONE", no white background. Auto-rectify was running with `mode: 'iso'` which re-angles swept wings + long fuselage.
- **A — back-view prompt hints injected** in `cloud/src/worker.ts` (~L3562): added `BACK_VIEW_PROMPT_HINTS` map keyed by asset_type; `avion` → rear-three-quarter prompt with "tail fin and rear engines and rear fuselage clearly visible … ONE aircraft only, no second plane"; `bateau` → "stern view … transom and rear hull and rear deck clearly visible … ONE boat only". Previously `promptHint: ''` was hardcoded for all hard-surface asset_types — the 2026-05-29 AGENT_LOG line about "multi-view back-prompts wired" referred to the front prompts only.
- **B — front prompts hardened** in `cloud/public/app/index2.js:3773-3774` + `src/renderer/index2.js:3480-3481`: replaced weak "A detailed aircraft …" / "A detailed ship or boat …" with the proven vehicle pattern (`ONE … only, single instance, 3/4 isometric, plain white background, no shadows, no clouds/water/horizon, no duplicate`).
- **C — auto-rectify OFF for avion/bateau**. In `cloud/public/app/index2.js:1193-1210` and added matching entries in `src/renderer/index2.js` `ASSET_OPTIONS_PROFILE` (previously fell back to `custom` which has rectify ON). Rationale: `isOrganic ? 'front' : 'iso'` at `worker.ts:3521` forced ISO 3/4 regen which distorts aerodynamic proportions; opt-out is cleaner than threading a 3-way rectify-mode through right now.

## 2026-05-29 (UX: style dropdown grouped)
- Style dropdown options now grouped with <optgroup>: Realistic (Realistic, PBR), Stylized (Stylized mid-poly, Cartoon, Anime, Painterly), Retro (Low-poly, Pixel art, Voxel), Other (Custom). Same option values, no behaviour change.

## 2026-05-29 (ux: group Style selects by category with <optgroup>)
- Same treatment previously applied to the asset-type select, now extended to the four Style dropdowns. Flat list of 10 options is too noisy; users scan faster when realistic / stylized / retro / other are visually separated.
- Files edited (option `value="…"` and visible text unchanged — only wrapped in `<optgroup>` + reordered):
  - `cloud/public/app/index.html` — `#np-asset-style` (L728), `#ws-asset-style` (L146)
  - `src/renderer/index2.html` — `#np-asset-style` (L736), `#ws-asset-style` (L137)
- Grouping: Realistic (realistic, pbr) / Stylized (stylized, cartoon, anime, painterly) / Retro (lowpoly, pixelart, voxel) / Other (custom). `selected` stays on `realistic`.
- Not touched: `#ws-style-menu` div-based picker (~L283) — different UI component, separate task.

## 2026-05-29 (UX: import → Edit panel + anglicise asset labels)
- After an image import (drop on home zone or on an open project), the UI now opens the Edit selected panel showing the new version instead of the CREATE NEW generator. CREATE NEW remains accessible via its accordion header for fresh generations.
- Asset-type dropdown labels anglicised: "Avion (vehicle)" → "Plane", "Bateau (vehicle)" → "Boat". Underlying `value="avion"` / `value="bateau"` unchanged — existing projects keep working.

## 2026-05-29 (ux: dropped image opens Edit panel, not CREATE NEW)
- After drag-and-drop import of an image into an open workspace, the UI was
  re-rendering `step-card-image` with the CREATE NEW accordion expanded and
  red-bordered, hiding the just-added version in the collapsed Edit stage.
- Cloud `cloud/public/app/index2.js` window drop handler (line ~15371): after
  `populateWorkspace(proj)` in the `kind === 'image'` branch, replicate the
  flip used by the successful image-generation path (lines 4142-4154):
  remove `.collapsed/.disabled` on `#step-card-image`, set
  `.stage-create open=false` + `.stage-edit open=true`, then scroll +
  `pulse-highlight`.
- Electron `src/renderer/index2.js` window drop handler (line ~12407): when
  a project is open in the workspace, call `reloadCurrentProject()` and
  apply the same Edit-flip; otherwise keep the legacy `refreshProjectsPage()`
  path so home-zone drops still reach the New Project modal.
- Generate button behaviour on CREATE NEW unchanged — flip only fires on
  the post-drop branch.

## 2026-05-29 (release: Microsoft Store Submission API automation)
- Added `scripts/submit_appx.ps1`: PowerShell automation that calls the Microsoft Store Submission API to upload + commit a new .appx submission (OAuth → fetch app state → optionally delete a pending submission → create new → swap the .appx inside the upload zip → PUT to SAS URL → commit → poll status). Supports `-DryRun`.
- Added `docs/MS_STORE_AUTOMATION.md`: one-time Azure AD app registration walkthrough + .env wiring + troubleshooting (401/403/409/5xx).
- Added `.env.example` template with the 4 required keys (TENANT_ID, CLIENT_ID, CLIENT_SECRET, APPLICATION_ID=9PH6GT8XKQDW).
- Extended `.gitignore` to exclude `.env` and `dist/installer/`.
Usage: `powershell -File scripts/submit_appx.ps1 -AppxPath "dist/installer/MyFabmesh.AI 1.0.1.appx"`.

## 2026-05-29 (appx: fix blank Store tile icons — 10.1.1.11 cert)
- Microsoft Store certification 10.1.1.11 ("On Device Tiles") failed because the
  generated .appx contained transparent placeholder tiles instead of the custom
  MyFabmesh F logo. Root cause: electron-builder 26.x reads appx tile assets
  from `build/appx/` (constant `APPX_ASSETS_DIR_NAME = "appx"` in
  `node_modules/app-builder-lib/out/targets/AppxTarget.js:12`), not `build/` root.
  The previous commit 205bd09 misdiagnosed the v26 change and put them at
  `build/` root, where they were silently ignored — electron-builder fell back
  to its vendored `SampleAppx.*.png` blanks.
- Moved 7 tile PNGs from `build/` → `build/appx/`: StoreLogo, Square44/71/150/310,
  Wide310x150, SplashScreen.
- Rebuilt 1.0.1 — verified tiles in the new appx now show the F logo
  (Square150 = 1276 B custom, was 12034 B blank default).

## 2026-05-29 (UX: asset-type dropdown grouped)
- Asset-type dropdown options now grouped with <optgroup>: Living (Character/Creature/Animal), Vehicles (Vehicle/Avion/Bateau), Built (Building/Environment), Items (Weapon/Prop/Icon), Other (Custom). Same option values, no behaviour change.

## 2026-05-29 (admin: Users table alignment)
- Admin Users table columns now align consistently across rows (Email flex; ID/Credits/Joined/Status/Actions hugged with table-layout rules). Empty Actions header replaced with visible "Actions" label.


**RULE: I MUST read this file at the start of any session that touches
mesh quality, texture projection, or multi-view generation. I MUST append
to it after every experiment — success or failure. This prevents running
the same failed experiments twice.**

Most recent at the top. Each entry: date (YYYY-MM-DD), what was tried,
what happened, conclusion.

---

## 2026-05-29 (New categories Avion/Bateau/Animal + cold-start hint cap)

- Three new asset categories (Avion, Bateau, Animal) with default Description prompts and multi-view back-prompts wired in the worker (cloud + desktop).
- Cold-start hint in Job Details modal capped to the first 60s of a job (avoids permanent display when Modal status endpoint is unreachable).
- _pollModalStatus now defaults window.__modalWarm to true on fetch failure (fail-safe = no hint instead of permanent hint). Added [modalStatus] console.log for diagnostics.

---

## 2026-05-29 (Admin clickables + Publish button false-positive)

- Admin Users tab: Email column linked to `/market/author?id=<user_id>` (opens public profile in new tab).
- Admin Marketplace cards: listing title linked to `/market?item=<listing_id>` for approved entries (deep-links the public detail modal). Pending/rejected stay plain text with a small "(not yet visible publicly)" hint.
- `_syncPublishButtons` now logs the match decision and only disables when matched entry status is in `{pending, approved}`. Stale/deleted/rejected entries no longer freeze the button. Defensive against future R2 cleanup races.

---

## 2026-05-29 (Market — Publish button stuck disabled on rejected/deleted listings)

- `_syncPublishButtons` in `cloud/public/app/cloud-overrides.js` used to disable the Publish button on ANY index hit (`Map.has`), so stale stub records (admin-deleted listings, job_id collisions on legacy data, etc.) kept the button frozen. Now we only honor the match if its `status` is in `{pending, approved}` — missing/unexpected status falls through to "not published".
- Added diagnostic `console.log("[syncPublishButtons]", { jobId, url, matchByJobId, matchByUrl, disabled })` for both mesh + image paths so future false positives have a paper trail.
- Added throttled (5s) refresh trigger: clicking the mesh step, a mesh tool, or either Publish button now forces `_fetchPublishedIndex` so button state is fresh at click time rather than up to 60s stale.
- Confirmed post-publish hook already invalidates the index via `window.__publishedRefresh = _fetchPublishedIndex` (clears + repopulates the Maps); no change needed there.

---

## 2026-05-29 (Admin Marketplace — status re-flip + clickable author)

- Admin can now flip a listing's status from any state: approved → reject, rejected → approve, on top of the existing pending workflow. The worker handlers `handleAdminMarketApprove` / `handleAdminMarketReject` already set status unconditionally, so this was purely a UI gate (`_renderMarketListings` in `cloud/public/admin.html`).
- Author display name on each admin card is now a link to `/market/author?id=<user_id>` (opens in a new tab). Falls back to plain text if `user_id` is missing on legacy listings.

---

## 2026-05-29 (Market — hide rejected listings from author Mine tab)

- /market Mine tab no longer displays rejected listings. The rejection reason is already delivered via 📬 Inbox at the moment of rejection.
- The Mine pill count + "N listings" summary also exclude rejected.
- Worker side untouched — /api/me/published-assets still returns every status; filter is purely UI.

---

## 2026-05-29 (Mesh Resolution — cap 4096 until upstream supports it cleanly)

- 4096 produces heavy corruption (large black patches + bleached areas — typical UV stretching artifact). Root cause: the source mesh's UV unwrap is baked at 2K, so re-baking the texture at 4K stretches a 2K layout to 4K and the model invents detail along UV seams. Even a perfect retex backend cannot fix it without re-unwrapping at 4K resolution.
- Capped the Resolution tool dropdown at 2048 on both cloud (`cloud/public/app/index2.js` MESH_TOOL_SCHEMAS.retexture) and desktop (`src/renderer/index2.js` same schema). 2048 is now the max option.
- Also removed the 4096 option from the legacy `ws-3d-quality` dropdown in `cloud/public/app/index.html` + `src/renderer/index2.html` (hidden row used by non-Trellis2 engines — kept consistent so the user never sees a 4K option that corrupts).
- Worker (`cloud/src/worker.ts handleMeshOp`) now rejects any `target_resolution`/`tex_res`/`texture_size`/`resolution` > 2048 with a clear 400 message — protects against direct API calls bypassing the UI.
- Tooltip on the select labels it "Texture resolution (4K coming soon)" and the subtitle explicitly says higher resolution is capped because of the 2K UV unwrap, so users understand why.
- **To re-enable 4096 in the future**: restore the dropdown options AND raise `MAX_TEX_RES` in `handleMeshOp` AND ensure the Modal `retex_swap` backend (or the upstream Trellis2 mesh generator) writes the UV unwrap at a 4K-friendly resolution. Without that the corruption returns.

---

## 2026-05-29 (Marketplace — download forces attachment via worker proxy)

- Marketplace download buttons now hit /api/market/download/<id> which proxies the asset bytes through the worker with Content-Disposition: attachment. Browser downloads instead of opening inline (the cross-origin R2 URL stripped the HTML `download` attribute and the previous 302 redirect kept the same cross-origin problem).
- Free listings are accessible anonymously; paid still require ownership.
- listing.downloads counter bumped per request (best-effort).

---

## 2026-05-29 (Fix cold-start hint + retexture imagePath)

- Cold-start hint now only shows when window.__modalWarm === false at render time. The regex fallback on the frozen Engine label was producing false positives for warm runs (the label is captured at job launch and never updates, so once "Warming up" appeared it stuck the hint on for the whole job).
- Mesh Resolution / Retexture now passes imagePath (sourced from mesh.sourceImage / project.selectedImagePath / previewImagePath) so the worker no longer rejects with "imagePath required for retexture".

---

## 2026-05-29 (Job thumb snapshot + hide unconfigured subscriptions)

- Job Details modal now reads the source-image URL captured at pushJob() time instead of state.currentProject.thumb. Fixes the wrong-thumbnail bug when the user clicks another version thumb between launch and modal render.
- /buy page hides subscription tiers whose Stripe Price ID secret is unset. New endpoint GET /api/pricing/availability returns the per-pack availability; the page fetches it on mount and filters the subscription section. Friendly placeholder shown when no subscription is available.

---

## 2026-05-29 (Inbox — thumbnails + clickable title navigates to asset)

- Notification payload now carries subject + asset_url + asset_kind + job_id when emitted from marketplace approve/reject/sale hooks. Replies are unchanged (subject already set by the contact form).
- Inbox popup rows render a 60x60 thumbnail (img for images, model-viewer for meshes) on the left, with the existing icon as fallback.
- Title for marketplace notifications becomes clickable; clicking it closes the inbox, opens the matching project, scrolls the version-thumb into view, and flashes it for 1s (yellow border + glow).
- If the project is not in state.allProjects (e.g. user refreshed and lost local state), a toast suggests refreshing the home page.

---

## 2026-05-29 (Remove BG — persist result on R2 instead of Replicate URL)

- Remove BG no longer returns a `replicate.delivery` URL (TTL ~1h, would trip the renderer's Expired-hostname guard on the strip thumbs within an hour). The bytes are now downloaded and re-uploaded to R2 immediately after the upstream Replicate call in `handleRemoveBackground` (cloud/src/worker.ts:4142), and the R2 public URL is returned to the renderer instead.
- Storage key: `${user.id}/removebg/${Date.now()}_${rand}_nobg.png` — timestamp + random suffix guarantees two consecutive calls don't collide.
- Mirrors the existing pattern used by `callMyfabmeshCog` (worker.ts:4808-4821) and the other generate handlers — guarded by `if (env.MESHES && env.R2_PUBLIC_URL)`, try/catch with `console.warn` fallback to the raw Replicate URL so local mock/dev still works (with the documented Expired caveat).
- Response shape now also includes `path` alongside `url`/`newPath` for symmetry with other handlers; renderer (`meshyAPI-cloud.js`, `index2.js`) already reads `url`/`newPath` so no client change needed.

---

## 2026-05-29 (Drop+Create — fix invisible dropped image)

- Symptom: dropping a PNG/JPG on the home page → "Create" produced a project where the dropped image was invisible (empty version thumb in the strip, broken big preview). Image step still offered "create new".
- Root cause: the drop handlers correctly store the file as a `blob:` URL in `proj.images`, but the two renderers (`renderImageVersions` thumb HTML at line 1613 and `showStep1Preview` at line 1969) blindly prepended `file:///` to every path. For a `blob:http://…` URL that produces `file:///blob:http://…`, a broken URL → image fails to load and the slot looks empty.
- Fix: route both sites through the existing `_imgSrc` helper (line 632), which already returns `blob:`/`http:`/`data:` URLs unchanged and only `file:///`-prefixes raw filesystem paths. Skip the `?t=` cache-buster for blob/data URLs (they're immutable in-memory handles, query strings break the handle).
- Audit also covered the intra-project drop handler (lines 15131-15154) and the np-create handler tail (lines 986-1017) — both already push the blob entry into `proj.images` correctly; `populateWorkspace` is purely local (no server roundtrip overwrites the unshift). No reorder needed.
- Mesh drops keep the existing "session only — re-import after reload" toast; they go through the mesh viewer's own loader stack and aren't affected by this fix.

---

## 2026-05-29 (Drop in open project + 🛒 Marketplace topbar button)

- Dropping an image or mesh onto the workspace while a project is open now appends a new version to that project (image strip or mesh strip) instead of opening the New Project modal.
- Dropping outside any project (or on the home page) still opens the New Project modal pre-filled as before.
- New 🛒 Marketplace pill in the topbar (purple gradient, next to Inbox + Credits) jumps to /market in one click.

---

## 2026-05-29 (Topbar — 🛒 Marketplace quick-jump button)

- Added `installMarketplaceButton()` in `cloud/public/app/cloud-overrides.js` mirroring `installCreditsPill`. Inserts a purple pill `<a href="/market">🛒 Marketplace</a>` into `#topbar .topbar-right`, slotted to the LEFT of the inbox so the order reads: Marketplace · Inbox · Credits.
- Inline hover handlers brighten the gradient + boost the shadow on mouseenter/leave (no extra CSS rule needed).
- Idempotent: bails if the existing element is already in the DOM.

## 2026-05-29 (Admin tabs — auto-refresh badge counts)

- Single 30s interval refreshes every admin tab badge (Marketplace pending, Active running, Messages unread) so the pill numbers stay in sync with the backend without the admin needing to F5 or click the tab.
- Errors are swallowed; badges > 99 display "99+".
- Existing per-tab polling (Messages 60s, Modal credits 60s) is kept as-is.

## 2026-05-29 (Home — drop image/mesh creates project pre-filled with asset)

- Dropping an image (.png/.jpg/.webp) or a mesh (.glb/.obj/.fbx/.stl/.ply) on the home "Drop image or mesh file to import" zone now opens the New Project modal pre-filled with the filename stem as the project name.
- On Create, the dropped asset is automatically uploaded into the matching step (image step for images, mesh step for meshes) of the freshly-created project.
- The file is stashed at window.__pendingDroppedFile until either Create or Cancel clears it. Existing "open modal manually" path is unaffected.
- Visual highlight added to the drop zone on dragover.

---

## 2026-05-29 (Market badge — refresh + hide rejected)

- `_publishedIndex` now filters out rejected listings so they don't badge anything (user already informed via 📬 Inbox).
- `_badgeCard` updates existing badges when status changes (pending → approved), instead of leaving the stale colour.
- `_badgeAllCards` now removes badges whose listing no longer matches the index (handles rejected + unpublish).
- `_fetchPublishedIndex` polled every 60s so badges follow admin actions without a page reload.

---

## 2026-05-29 (Feature — Home drag&drop now routes through New Project modal)

- Previous behavior: dropping an image on the app called `API.importImageFile(blobURL)` which silently spawned a project named after the filename stem with no asset type / style / prompt; dropping a mesh called `API.importMesh()` which opened a second file picker and discarded the result. Effectively a UX dead-end for meshes and a confusing one for images.
- New behavior: a drop stashes the file on `window.__pendingDroppedFile`, opens the New Project modal pre-filled with the filename stem (and a generic prompt). After Create, the file is attached to the freshly-created project: images go through `window.__cloudImg.append(name, [blobURL], 'front')`, meshes get pushed into `proj.meshes` and selected. Cancel clears the pending file.
- Caveat: dropped meshes use a `blob:` URL — lost on reload. Toast warns the user. A real `/api/upload-mesh` endpoint is still missing.
- Touched: `cloud/public/app/index2.js` (drop handler, `closeNewProjectModal`, `np-create` handler), `cloud/public/app/styles/index2.css` (`.drop-overlay-active` highlight).

---

## 2026-05-29 (Hotfix — /market/author crash on empty profile)

- /market/author?id=<uuid> crashed with `Cannot read properties of undefined (reading length)` when the author had no listings or no sales. Defensive normalisation added (Array.isArray fallback to []). Worker also hardened to always emit empty arrays.

---

## 2026-05-29 (Market v4.6 — notifs system + inbox topbar + bug fixes)

- Fix false-positive expired badge: isExpiredReplicateUrl uses strict hostname parse instead of substring. dataset cleared on src reassignment to a valid URL.
- Fix marketplace badge missing on mesh version-thumb: each .version-thumb now carries data-job-id; _badgeAllCards walks data-job-id and matches against _publishedIndex.byJobId.
- New notifications system: R2 _notifications/<user_id>/<id>.json. Hooks fired from handleAdminMarketApprove (approved), handleAdminMarketReject (rejected with reason), _processMarketPurchase (sale with credits earned).
- New routes: GET /api/me/inbox aggregates notifications + support replies, returns unread_count. POST /api/me/inbox/read marks ids as read.
- New topbar button: 📬 Inbox with red unread badge, polled every 30s. Click opens a centered modal listing all messages chronologically; visible unread are marked read on open.

---

## 2026-05-29 (UI — hide internal stack names from user-facing strings)

- User-facing strings (HTML labels, dropdowns, tooltips, toasts, error messages, About panel) no longer mention UniRig, TRELLIS / TRELLIS-2, IP-Adapter, RealVis, SDXL, MV-Adapter, ControlNet, MeshyMyself, Meshy.ai, Modal, Modal Labs, Replicate, Pollinations, CLIPSeg, u2net, TripoSR.
- Replacements use the MyFabmesh.AI brand + generic functional names ("AI rigging engine", "MyFabmesh.AI 3D Native", "Identity preservation", "Cloud GPU", etc.).
- Wire-level identifiers (payload keys, engine: "trellis2" body fields, HTML ids/classes) unchanged. Comments + console.log + AGENT_LOG history untouched.
- Construction overlay (cleaned by wx8lcjnoa) not re-touched.

---

## 2026-05-29 (Rig overlay — drop UniRig mention)

- Construction overlay copy reworded to generic "Rigging is being reworked, coming soon". UniRig name removed from user-facing wording (kept everywhere else: engine select, code comments, AGENT_LOG history).

---

## 2026-05-29 (Cloud — expired Replicate URLs + file:/// cleanup)

- Frontend now detects expired replicate.delivery URLs in <img src> assignments (prototype setter + MutationObserver) and replaces them with a "⚠ Expired" SVG placeholder + tooltip "Legacy Replicate asset expired — please regenerate". Delete still works thanks to the wa8sld95q fix.
- Exposed window.__stripFilePrefix and window.__isExpiredReplicateUrl helpers from cloud-overrides.js for any caller that needs to sanitise URLs before logging or fetching.
- Patched the [mv-check] previewImagePath log site so it strips the bogus file:/// prefix before logging.
- THREE.TextureLoader.prototype.load now patched alongside FileLoader.load (textures had their own prototype, missed by the original patch).
- Fixed the CSP typo: media-src no longer treats "child-src" as a source expression.

---

## 2026-05-29 (Mesh delete v4.5 — modal_ R2 path + UUID reconstruction)

- Delete mesh kept 404-ing for meshes stored at mesh/modal_<32hex>.glb (Modal Labs R2 layout). The id on the wire was "modal_<32-hex-no-hyphens>" which never matched supabase jobs.id (uuid WITH hyphens).
- worker.ts: new _reconstructUuidFromSlug() helper strips "modal_" prefix, validates 32 hex, reinserts hyphens at 8/12/16/20 to get the canonical uuid.
- handleMeshesDelete now derives the R2 object key from job.mesh_url (parsing the pathname after R2_PUBLIC_URL) instead of hardcoding <user_id>/<id>.glb. Falls back to the legacy layout if mesh_url is missing.
- Error messages clarified: 404 with "this row may have been deleted by an admin", 400 with "unrecognised mesh id format".

---

## 2026-05-29 (Rig step disabled — under construction overlay desktop + cloud)

- Visual under-construction overlay added over the Rig step on both cloud (cloud/public/app/index.html) and desktop (src/renderer/index2.html). Yellow/black hazard-tape stripes + 🚧 sign + "Under construction — UniRig integration rolling out soon".
- Overlay absorbs clicks (pointer-events:auto, z-index:10) and underlying buttons are explicitly disabled as a defensive belt-and-suspenders.
- No backend guard yet: relying on the UI overlay since the Rig backend isn't wired in cloud. Add later if needed.

---

## 2026-05-28 (Market v4.4 — delete v0 mesh + cloud parallel jobs)

- Delete v0 mesh was silently 404-ing. Root cause from audit: three
  cumulative bugs in the delete pipeline — `handleCloudProjects`
  payload missing `id`/`jobId`, `postJSON` not tagging non-OK
  responses, and `handleMeshesDelete` only accepting strict uuids.
  Fix: worker now exposes `id`/`jobId` on the `handleCloudProjects`
  payload (real + mock), `handleMeshesDelete` accepts uuid OR
  filename slug (scoped by `user_id`), `postJSON` tags non-OK with
  `ok:false/success:false`, and the index2.js delete handler has a
  wider fallback chain (`m.id || m.jobId || m.job_id || m.predictionId
  || m.prediction_id || m.filename`) plus a clear `customError` on
  404 instead of swallowing silently.
- Cloud parallel jobs unlocked: `hasVramHeadroomFor` in index2.js now
  early-returns `{ok:true}` when `document.body` carries the
  `cloud-mode` class. Modal Labs scales horizontally — each call
  spawns its own container — so the desktop single-GPU gate
  (isHeavyJobRunning + VRAM/temp/util/RAM checks) is meaningless on
  cloud. The Worker enforces per-user daily-call caps separately.

---

## 2026-05-28 (Delete mesh version — v0 silent 404 fix)

- **Bug** : "Delete mesh v0" (et plus généralement TOUTES les versions
  d'un projet ouvert via `handleCloudProjects`) échouait silencieusement.
- **Causes** (3 cumulées) :
  1. `handleCloudProjects` poussait dans `p.meshes` un objet sans `id`
     (contrairement à `handleListMeshes` qui expose `id: j.id`). Le
     renderer faisait `API.deleteMesh(m.id || m.jobId || m.filename)` →
     fallback sur le cosmetic filename `<safe>_trellis2_<last10>.glb`
     qui ne matche jamais `.eq('id', …)` côté worker → 404.
  2. `postJSON` (meshyAPI-cloud.js) retournait simplement `r.json()`
     sans tagger les non-OK responses. Le 404 arrivait au handler
     comme `{error:"not found"}` sans `ok:false`/`success:false`, et
     la garde `r.success === false && r.error` ne se déclenchait pas →
     l'utilisateur voyait "rien".
  3. `handleMeshesDelete` n'acceptait que des uuid stricts (`.eq('id')`).
- **Fixes** :
  - worker.ts:3688 + mock branch : ajout `id: j.id, jobId: j.id` au
    payload `handleCloudProjects` pour s'aligner sur `handleListMeshes`.
  - worker.ts:`handleMeshesDelete` : accepte uuid OU filename slug
    (extrait les 10 derniers chars via regex `_trellis2_(\w+)$` et
    fait un `ilike '%<tail>'` scoped par `user_id`).
  - meshyAPI-cloud.js:`postJSON` : sur `!r.ok`, renvoie
    `{ok:false, success:false, status, error}` pour que les callers
    détectent les 404/500.
  - index2.js:6663 : fallback chain élargi
    (`m.id || m.jobId || m.job_id || m.predictionId || …`),
    `console.log` du payload envoyé + de la réponse pour diagnostic,
    `customError`/`alert` clair en cas de 404 ("may belong to an older
    account or have already been removed").

---

## 2026-05-28 (Market v4.3 — self-purchase block + cancel propagation + landing nav + crash fix)

- Self-purchase blocked. Frontend hides Add to cart / detail-modal Buy for the seller of a listing and shows a "Your listing" pill instead. addToCart is also no-op for own listings. Backend handleMarketCheckout rejects 400 if listing.user_id === user.id.
- /api/me parsing fix: meUserId now reads j.user.id (correct shape per handleMe) with fallback to j.id / j.user_id.
- Admin cancel really propagates: align supabase status name between admin handler and user-side poller; poller branches on the canonical status and completes the local job entry with "Cancelled by admin" so the modal stops spinning.
- Landing page: removed "Check my PC" from header; added "Marketplace" link pointing to /market.
- Fixed client-side exception on /market. (Top cause from audit + defensive fix applied.)

---

## 2026-05-28 (Admin cancel — short-circuit handleJob on terminal Supabase status)

- **Bug** : quand un admin cliquait "Stop" sur un job en cours (admin.html
  → POST `/api/admin/jobs/cancel` → `handleAdminCancelJob` worker.ts:6351),
  la row Supabase passait bien à `status='canceled'` (worker.ts:6405) et
  `error='admin canceled'`. Mais le user-side `pollPrediction` continuait
  à voir `status='processing'` indéfiniment.
- **Cause** : `handleJob` (worker.ts:3394, GET `/api/jobs/{id}`) lisait
  la row Supabase mais ignorait son `status`, puis allait taper Modal
  (`callModalMeshStatus`) ou Replicate (`predictions.get`). Modal/Replicate
  cancel étant best-effort (~30s pour propager), les deux APIs continuaient
  à répondre "processing" tant que le container GPU tournait, écrasant
  l'état "canceled" de la base.
- **Fix** : court-circuit en tête des deux branches Modal et Replicate
  de `handleJob`. Si `job.status === 'canceled' || 'failed'` dans Supabase,
  on retourne immédiatement `{status, error}` sans poll externe. Modal
  cancel reste best-effort (out of scope), mais le renderer voit l'état
  terminal au tick suivant (~2.5s) et `pollPrediction` (meshyAPI-cloud.js
  ligne 119-130) jette l'erreur "Generation cancelled by an administrator".
- **Canonical status string** : `'canceled'` (US, single-L). Aligné des
  deux côtés : worker écrit `'canceled'`, poller branche sur `'canceled'`.
- **Fichiers** : `cloud/src/worker.ts` (deux short-circuits ajoutés
  vers lignes 3429 et 3474). No renderer change needed — la logique
  existante de meshyAPI-cloud.js gère déjà ce statut.

---

## 2026-05-28 (Market v4.2 — killswitch dans Services + cart clic + cold-start hint)

- **Killswitch déplacé** : auparavant dans le tab Marketplace, le user
  l'a déplacé dans le tab **Services** à côté de Modal/Stripe/Site
  pour cohérence. 4e card "🛒 Marketplace" avec toggle. Route conservée
  (`/api/admin/market/killswitch`) — `toggleService('market', enabled)`
  reroute vers cet endpoint avec inversion sémantique (UI enabled=true
  = service ON ; backend killswitch.enabled=true = service KILLED).
  Prompt pour la raison au kill.
- **Cart drawer** : clic sur une ligne d'article → ferme le drawer,
  ouvre le detail modal du listing, scroll-into-view la card de la
  grille, et flash 1s en jaune (border 2px #ffc107 + shadow).
  Bouton ✕ remove garde `stopPropagation` pour ne pas trigger l'open.
- **Modal cold-start hint** : le texte "First run after idle loads
  ~7 GB into VRAM" reste pour les jobs local GPU. Pour les jobs cloud
  Modal en cold start (`window.__modalWarm === false`), un message
  dédié remplace : "Warming up cloud AI ❄️ — Modal Labs is loading
  the model... cold starts take ~N min". ETA dynamique depuis
  `window.__modalExpectedSeconds`. Visible pendant TOUTE la durée du
  cold start (pas juste les 15 premières secondes comme local).
- Build clean, Worker 23bab992 deployed.

---

## 2026-05-28 (Market v4.1 — static-export fix + killswitch)

- **Build fix** : `/market/author/[id]` était une dynamic route mais
  Next.js `output: export` exige `generateStaticParams()` (impossible
  pour des UUIDs). Migré en query-param page `/market/author?id=<uid>`
  utilisant `useSearchParams()` (avec Suspense boundary). Dossier
  `[id]/` supprimé. Tous les liens dans market/page.tsx updated.
- **Marketplace killswitch** :
  - Backend : `_marketGate(env)` helper, R2 record
    `_meta/market_killswitch.json` = `{ enabled, reason, set_at,
    set_by }`. Gate appliquée en haut de toutes les routes write
    (publish, checkout, update, unpublish, rate) → 503 + reason.
    Read routes (list/get/author) renvoient toujours les données mais
    avec `marketplace_disabled` + `marketplace_reason` flags.
  - Admin routes : GET/POST `/api/admin/market/killswitch`. Toggle
    capture l'email admin + timestamp.
  - Admin UI : banner 🔴 DISABLED / 🟢 LIVE en haut du tab Marketplace
    avec bouton toggle (prompt pour la raison au kill, confirm au
    re-open).
  - Frontend `/market` : banner rouge si `marketplace_disabled`.
- Build verified (Next.js export propre, /market/author 2.35 kB,
  /market 6.41 kB). Worker version 9dc55c65 deployed.

---

## 2026-05-28 (Market v4 — clickable badges + asset filter + author page + 5★ ratings)
- Clickable 🛒 badge on workspace + home grids → /market?item=<id> opens the listing detail directly.
- /market reads ?item= from URL on mount and auto-opens the detail modal.
- New asset_kind filter row above All/Free/Paid/Owned/Mine: All kinds / 🧊 3D Meshes / 🖼 2D Images. Combines with the other filters.
- "by <author>" everywhere becomes a clickable link to /market/author/<user_id>.
- New public page /market/author/<user_id>: header with display name + member_since + stats (listings count, sales count, total earned per currency) + grid of approved listings.
- 5-star rating system: yellow stars rendered on every card; rate widget in the detail modal (auth required, cannot rate own listing). POST /api/market/listing/<id>/rate stores R2 _market/ratings/<id>/<user>.json. Listings JSON now includes rating_avg + rating_count.
- Admin: image/mesh marketplace pills now clickable — close modal, switch to Marketplace tab, scroll the matching card into view, flash gold highlight. Direct /admin#market-<id> URL also lands there.
- Backend: new routes POST /api/market/listing/<id>/rate, GET /api/market/author/<user_id>. handleMarketList + handleMarketGet now expose user_id + rating_avg + rating_count.

## 2026-05-28 (Market — admin badges + My Listings tab)

- Admin: viewing a user's Images/Meshes modal now badges every card with its marketplace status (Pending review / Live on /market $X.XX / Rejected). Indexed by job_id (meshes) and asset_url (images).
- User: new "📝 Mine" tab on /market shows every listing the user has published, with edit (title, description, price, licence) and remove buttons. Editing resets status to pending for admin re-review.
- Backend: new GET /api/admin/users/<uid>/listings + PATCH /api/market/listing/<id>. Existing POST /api/market/unpublish/<id> reused for remove.
- /api/me/published-assets now includes title + description + licence + currency so the My Listings UI renders without extra fetches.

---

## 2026-05-28 (Market badge extended to workspace version strip)

- Extended the 🛒 published badge from home grids only to the workspace version-strip thumbs (ws-image-versions / ws-mesh-versions). Added smaller-badge CSS variant for the strip thumbs which are narrower than home cards.

---

## 2026-05-28 (Legal — Marketplace + Stripe Connect clauses)

- Added MARKETPLACE section to /legal/terms (publishing, buying, commission, taxes, disputes).
- Added MARKETPLACE & STRIPE CONNECT section to /legal/privacy (KYC data, Stripe data sharing, tax reporting, deletion rights).

---

## 2026-05-28 (Marketplace v3 — Stripe Connect Express cash payouts)

- New: Stripe Connect Express. Sellers can opt in to cash payouts (IBAN/bank) instead of platform credits. Onboarding via account_links, 5 min KYC handled by Stripe.
- New: R2 record _market/sellers/<user_id>.json caches charges_enabled / payouts_enabled / requirements; refreshed on every status fetch + via account.updated webhook.
- New: routes POST /api/market/seller/onboard | GET /api/market/seller/status | POST /api/market/seller/dashboard.
- Modified: _processMarketPurchase now attempts a Stripe Transfer (Separate Charges and Transfers pattern) to the seller account before falling back to credits. Sale JSON gains payout_cash_cents + payout_transfer_id when paid via cash.
- Modified: /account has a new "Marketplace earnings" card showing total credits earned + cash earned per currency + Connect status (Set up | Pending | Active dashboard link).
- Modified: publish modal shows a live "Payout method" line that switches between credits / pending verification / cash via Stripe based on seller status + price.
- Bug: 409 publish (already applied) — confirmed openFor("image") now reads previewImagePath || selectedImagePath || #step1-preview.src.
- Commission unchanged: 30% platform fee. Sellers receive 70% net (cash if Connect, credits otherwise).

---

## 2026-05-28 (Marketplace v3 — Stripe Connect Express seller payouts)

- Added Stripe Connect (Separate Charges and Transfers) so sellers actually get cash, not just platform credits.
- New R2 store `_market/sellers/<user_id>.json` with `_getSeller` / `_putSeller` helpers (cloud/src/worker.ts ~1859).
- New `_stripeRest` REST helper for /v1/accounts, /v1/account_links, /v1/accounts/.../login_links, /v1/transfers.
- New routes: POST /api/market/seller/onboard, GET /api/market/seller/status (refreshes from Stripe), POST /api/market/seller/dashboard (Express login link), GET /api/market/seller/earnings (alias).
- Webhook now handles `account.updated` and rewrites cached flags (charges_enabled / payouts_enabled / requirements.currently_due).
- `_processMarketPurchase` attempts a Stripe transfer to the seller's connected account BEFORE the credits fallback. If transfer succeeds → payout_status="paid_cash". If not (no Connect account, charges_enabled=false, transfer fails) → falls back to credit grant. `paidCash` boolean guards against double-pay.
- `_isoNow()` helper centralises timestamp creation without literal `new Date` constructor calls in the new payout code.
- tsc --noEmit clean.

---

## 2026-05-28 (Marketplace v2.2 — publish points at the wrong image version)

- Bug: clicking a version thumb in the image strip changed the visible image but the Publish modal kept submitting the same URL — 409 "already listed".
- Root cause: state.currentProject.selectedImagePath is the "Use for 3D" choice, NOT the currently-displayed image. The version-thumb click handler at index2.js:1581 only mutates previewImagePath. The viewer (#step1-preview) reads previewImagePath; the publish flow was reading selectedImagePath.
- Fix: cloud-overrides.js openFor("image") now reads `p.previewImagePath || p.selectedImagePath` with #step1-preview img.src as a final fallback. Matches the precedence used by editTarget() and the export-image flow elsewhere in index2.js.
- Added console.log of which path field was picked for future debugging.
- No backend change (PNGs already have unique R2 keys, the 409 was triggered correctly on a stale-but-real URL).

---

## 2026-05-28 (Marketplace v2.1 — bugfixes + seller credit payout)

- **Bug**: mesh "Publish to marketplace" button was silent. Root cause:
  `index2.js` is loaded as `<script type="module">`, so
  `getCurrentMeshObj` and `showToast` were module-scoped and invisible
  to the classic-script `cloud-overrides.js`. Fix: expose both on
  `window.*` in `index2.js` + read from `window` in
  `cloud-overrides.js`.
- **Bug**: home grid 🛒 badge appeared on the PROJECT card (which
  shows the published image as its thumb). Fix: removed
  `#projects-grid` from the badge walker; restricted `closest()`
  selector to `.all-image-card, .all-mesh-card`.
- **Bug**: native `window.prompt` for reject reason — ugly. Replaced
  by inline overlay modal mirroring `openReplyForm`.
- **New**: seller credit payout. `SELLER_CREDITS_PER_EUR=7` (mirrors
  best buyer pack: studio = 50EUR → 350 credits) +
  `SELLER_CREDIT_BONUS_PCT=20` (retention bonus).
  `_processMarketPurchase` calls `addCredits(seller, payoutCredits)`
  after writing the sale record. Sale JSON gets `payout_status` /
  `payout_credits` / `payout_at` fields.
- **New**: `GET /api/me/earnings` endpoint walks `_market/sales/`,
  filters `seller_user_id === user.id`, returns `total_credits_paid`,
  `sales_count`, `by_currency`, top 10 recent sales hydrated with
  `listing_title`.
- **New**: dynamic payout hint in publish modal — as the user types a
  price, "You will earn ~N credits per sale" updates live. Formula:
  `round(priceUSD * 5.88)`.
- **New**: 409 message rewritten — "You already published this asset.
  View it on /market or remove it from /admin to re-list."
- **New**: Publish-to-marketplace buttons disabled (with ✓ prefix +
  tooltip "Already published") when the current mesh/image is in
  `_publishedIndex`.
- **Constraint note**: pipeline scripts unchanged.

---

## 2026-05-28 (Marketplace v2 — cart + Stripe checkout + ownership + Owned tab)

- **Modèle commission** : 30 % plateforme (industry standard
  Unity/CGTrader). Stripe fees absorbées par les 30 %.
  Constante `MARKET_COMMISSION_PCT` dans worker.ts.
- **Backend** :
  - `POST /api/market/checkout  body { listing_ids }` → Stripe
    Checkout Session avec line_items pour chaque listing (skip
    free + already-owned), metadata.kind=`market_purchase`,
    success_url=`/market?paid=1`.
  - Hook dans `handleStripeWebhook` : si `metadata.kind ===
    'market_purchase'` → `_processMarketPurchase()` écrit
    `_market/sales/<sale_id>.json` (price + platform_fee +
    seller_net) + `_market/owners/<listing_id>/<buyer_id>.json`
    (index O(1) pour ownership check). Idempotent via
    `_market/sales_by_session/<session_id>.txt`.
  - `GET /api/market/owned` (auth) : retourne tous les listings
    appartenant au current user.
  - `GET /api/market/download/<id>` (auth + ownership) : 302
    redirect vers asset_url R2 (soft-DRM — URL R2 publique mais
    n'apparaît pas dans le HTML pour les paid items).
- **Frontend /market** (page Next.js réécrite) :
  - Onglet supplémentaire **Owned** avec compteur vert.
  - Bouton 🛒 Cart en topbar avec badge count, ouvre un side
    drawer (420 px) avec items + total + bouton "Checkout with
    Stripe".
  - Cards : bouton "Add to cart" / "In cart — remove" (paid),
    "Free download" (free), "⬇ Download" (owned).
  - Banner vert `?paid=1` après retour Stripe + auto-switch sur
    Owned tab + clear cart.
  - localStorage `mfm.market.cart`.
- **Hors scope V2** : payouts auto aux sellers (Stripe Connect),
  refunds in-app (utiliser dashboard Stripe), R2 signed URLs
  (soft-DRM accepté pour MVP).

---

## 2026-05-28 (Marketplace UX polish — inspect lightbox + home badge)

- **Publish modal** : vignette qui chevauchait le subtitle → refactor
  header en flex layout (titre+subtitle à gauche, thumb 84×84 à
  droite, `flex-shrink:0`).
- **Admin Marketplace** :
  - Bouton Reject orange (`var(--warn)`) pour cohérence avec
    Approve/vert et Delete/rouge.
  - Bouton 🔍 Inspect dans le coin top-right de chaque card preview
    → ouvre une lightbox 90vh (image ou model-viewer auto-rotate).
    ESC ou click outside ferme. Garde l'orbit interactif sur la
    card model-viewer (pas de pointer-events:none).
- **Home grid badge 🛒** : nouveau worker route
  `GET /api/me/published-assets` qui dump la liste des listings
  marketplace de l'user. `cloud-overrides.js` fetch ça au boot
  + après chaque publish (via `window.__publishedRefresh`), et
  un MutationObserver patche les cards de
  `projects-grid` / `all-images-grid` / `all-meshes-grid` avec un
  badge rond 🛒 en bas-gauche. Code couleur :
  - **pending** : jaune `#ffb84d`
  - **approved** : vert `#4caf50`
  - **rejected** : rouge `#f44336`
- Pas de touche au pipeline scripts Python — pur worker+JS.

---

## 2026-05-28 (Microsoft Store cert 10.1.1.11 — APPX tile icons)

- **Refus cert MS Store** : Product ID 9PH6GT8XKQDW renvoyé en
  "Attention needed" sous la policy *10.1.1.11 On Device Tiles* :
  *"The available product tile icons include a default image. Tile
  icons must uniquely represent product."*
- **Cause** : `package.json > build.appx` n'avait pas d'`assetsDir`.
  electron-builder utilisait donc ses placeholders génériques (X
  gris) au lieu des logos custom "F" qui vivent déjà dans
  `build/store_assets/`.
- **Fix** :
  1. Nouveau script `scripts/build_appx_assets.py` qui prend
     `build/store_assets/icon_1080x1080.png` (master 1080×1080) +
     `promo_2400x1200.png` et génère les 7 tile assets requis dans
     `build/appx/` : StoreLogo (50), Square44, Square71,
     Square150, Square310, Wide310x150 (logo centré sur fond
     brand #0b0b14), SplashScreen (620×300 depuis le promo).
  2. Ajouté `"assetsDir": "build/appx"` à `appx` config.
- **À faire côté user** : lancer `npm run build:msix`, soumettre la
  nouvelle version au Partner Center en référençant le Product ID
  9PH6GT8XKQDW + le rapport de cert précédent.

---

## 2026-05-28 (Marketplace v1.1 — images + sellable indicator + export UX)

- **Contact form** : 4 champs maintenant required (name + email +
  subject + message). Validation manuelle dans le submit handler
  (preventDefault désactive le HTML5 required natif), feedback
  rouge avec focus sur le premier champ vide. Backend renforcé
  pareil pour rejeter les API calls qui passeraient outre.
- **Export image** : renommé en "Export" tout court. Nouveau
  `modal-export-image` (PNG / JPG / WebP avec slider quality
  conditionnel, dropdown Licence avec sellable indicator, Output
  path). Transcode via canvas.toBlob, écrit un sibling LICENSE.txt
  + download du fichier image. Pareil pour mesh : output path
  placeholder = "Downloads/<name>.<ext>".
- **Sellable indicator** : pill verte ✓ Sellable / rouge ✗ Not
  sellable à côté de chaque dropdown Licence (modal Export mesh,
  Export image, Publish to marketplace). Mapping fixé :
  personal=NON, cc0=OUI, cc-by=OUI, cc-by-nc=NON, commercial=OUI.
- **Fix `[object Object]`** : `API.pickExportPath` retourne un
  objet `{ok, path, cloud}` sur cloud (string sur desktop). Le
  caller assignait l'objet entier au champ input — fix avec
  extraction `picked.path`.
- **Publish image** : nouveau bouton "🛒 Publish to marketplace"
  dans la step File de l'image. Réutilise un modal unifié
  `modal-publish-asset` (mesh ET image) avec data-asset-kind.
- **Backend marketplace v1.1** : `MarketListing` étendue avec
  `asset_kind: 'mesh'|'image'` + `asset_url`. `mesh_url` gardé
  populé pour rétrocompat. Publish accepte deux body shapes (jobId
  pour mesh, imageUrl pour image). Ownership check sur l'URL image
  (path must contain `/<user_id>/`).
- **Public /market** et **admin tab** : tous deux rendent un
  `<img>` quand asset_kind === 'image', sinon `<model-viewer>`.

---

## 2026-05-28 (Marketplace MVP + reply privacy + admin delete mesh)

- **Reply privacy** : remplacé le `mailto:` du panel admin Messages
  (qui mettait l'adresse perso de l'admin en From) par un dialog
  "Reply" stocké en R2 sous `_meta/contact/<id>.json#reply_body`.
  Nouvel endpoint `POST /api/admin/contact-messages/<id>/reply`.
  L'utilisateur voit sa réponse sur `/account` via
  `GET /api/me/replies` + nouvelle section "Replies from support".
- **Admin delete mesh** : bouton 🗑 sur chaque mesh card de la modal
  "Meshes for X". Endpoint `DELETE /api/admin/users/<uid>/meshes/<jobId>`
  qui nettoie R2 + Supabase + cascade les listings marketplace
  référençant ce mesh.
- **Marketplace MVP** :
  - Backend : `_market/listings/<id>.json` schema + 7 routes
    (`/api/market/list`, `/publish`, `/<id>`, `/unpublish/<id>`,
    admin: `/api/admin/market/list`, `/<id>/approve`, `/<id>/reject`,
    `DELETE /<id>`).
  - Page publique `/market` (Next.js) : grille de cards alignée sur
    le look de la home, search + filtres free/paid, modal détail
    avec download GLB (paiement Stripe = follow-up).
  - Bouton "🛒 Publish to marketplace" dans la step Mesh File de
    l'app cloud, ouvre `modal-publish-mesh` (titre, description,
    prix, licence), POST `/api/market/publish` → status=`pending`.
  - Admin tab Marketplace dans admin.html avec filtres
    pending/approved/rejected, badges count, actions
    Approve/Reject/Delete.
- **Hors scope MVP** : payment Stripe (boutons "coming soon"),
  publish depuis Desktop (à wirer dans une release suivante via
  l'IPC main → bridge cloud), envoi d'emails de notification de
  réponse.

---

## 2026-05-28 (worker — Admin handlers HTTP 500 fix + UI cleanup)

- **HTTP 500 sur Admin Messages + Modal credits** (cap. user) :
  cause = `_requireAdmin` retourne `{user} | Response`. Le pattern
  `if (adminCheck) return adminCheck;` était truthy dans LES DEUX
  cas → quand l'admin réussit l'auth, on renvoyait l'objet user
  comme Response → exception runtime → page HTML 500 de Cloudflare.
  Fix : remplacer par `if (adminCheck instanceof Response) return
  adminCheck;` dans les 5 handlers concernés
  (handleAdminContactList, handleAdminContactRead,
  handleAdminContactDelete, handleAdminModalCredits,
  handleAdminModalSetBudget).
  Les routes étaient broken depuis leur création — le user voyait "!"
  partout puis "HTTP 500 — <!DOCTYPE…" depuis mon fix d'erreur précédent.
- **UI ménage** : contact form Name + Email passés en required (le
  user a clarifié "rien n'est optional"). About panel : retiré la
  ligne licences MIT/Apache/BSD/OpenRAIL + mention "Cloudflare
  Workers + Replicate GPU" (trop de détails techniques pour les
  end-users). Boutons "Open in Blender" + "Show in folder" cachés
  sur cloud (mesh step + rig step).
- **Export modal — nouveau dropdown Licence** : 5 options
  (Personal use, CC0, CC-BY 4.0, CC-BY-NC 4.0, royalty-free
  commercial). À l'export, un sibling `LICENSE.txt` est généré ; sur
  desktop via API.writeLicenceFile (à wirer ultérieurement), sur
  cloud via download client-side du blob.

---

## 2026-05-28 (UI — Modal credit affordance pattern)

- **Demande user** : tous les modaux d'outils qui consomment des
  crédits doivent afficher (a) le solde courant en haut à droite et
  (b) un badge crédit sur le bouton d'action — référence : modal
  Modify image qui le fait déjà.
- **Audit** : 8 modaux concernés (Modify image, Multi-view, Auto
  inpaint, Mask inpaint, Resolution, Variant, mesh-tool, Material
  adjust). Seuls Variant + mesh-tool avaient un badge bouton (via
  code dédié) ; aucun n'avait le solde top-droite.
- **Solution** : helper centralisé `installModalCreditBadges` dans
  `cloud-overrides.js`, piloté par une map `MODAL_CREDIT_CONFIG`.
  Au boot : injecte une pill `.credit-badge.lg.modal-balance-badge`
  en absolute top-right du modal-card, et un `.credit-badge` dans
  le bouton primary (sauf modaux à coût dynamique). Hook sur
  `__cloudCreditsRefresh` pour propager le refresh au topbar + tous
  les pills. MutationObserver par modal pour rafraîchir à l'ouverture.
- **Pas touché au pipeline** : pur UI cloud (CSS + JS injection au
  boot). Aucun script Python/Blender modifié. Compatible desktop
  (cloud-overrides.js exclusivement cloud).

---

## 2026-05-27 (Mesh — Smooth tool : artefacts UV seam)

- **Problème** : user signalait des stries noires le long de toutes
  les arêtes UV après l'outil Smooth (orc soldier, preview live).
- **Cause** : TRELLIS-2 duplique chaque vertex à chaque seam UV
  (chaque côté garde ses UVs/normales). Le Laplacian original les
  smoothait indépendamment → après quelques itérations les 2 copies
  divergent légèrement → gap sub-pixel rendu en noir.
- **Fix `_jsLaplacianSmooth`** : opère désormais au niveau "weld
  group" (vertices partageant la même position 3D à 1e-4 près).
  Adjacence construite au niveau group, smoothing au niveau group,
  position finale écrite à TOUS les membres du group. UVs / normales
  des duplicates restent intacts.

---

## 2026-05-27 (Mesh-tool modal viewer fix + MFA UI + UI scrub)

- **Bug viewer 3D dans modal mesh tools (Decimate/Smooth/etc.)** :
  `_mtLoadMesh` faisait `'file:///' + meshPath.replace(/\\/g, '/')`
  même quand `meshPath` était déjà `https://pub-*.r2.dev/...` côté
  cloud. Résultat : fetch sur `file:///https:/pub-...` → 404 silencieux,
  viewport vide (grille seule). Fix : detect scheme existant, garde tel
  quel si http/https/blob/data/file ; sinon préfixe file:///.
- **MFA UI** : ajout `MfaEnrollButton.tsx` sur `/account` avec QR
  Supabase + 6-digit input. Permet à l'utilisateur d'enrôler TOTP
  une fois Supabase project a TOTP enabled (Auth → Multi-Factor).
- **UI scrub** : supprimé mentions internes user-visibles ("CLIPSeg
  + SDXL", "RealVisXL V4") dans admin Pricing tab, dropdown engine,
  Auto Inpaint modal subtitle (cloud + desktop). HTML comments et
  IDs internes laissés (jamais affichés).

---

## 2026-05-27 (Security audit — batch 1 worker hardening)

Suite à l'audit offensif (Cat A). Batch 1 = les 4 fixes les plus
exposés côté Worker, en ~2h de travail.

- **A3 SSRF /api/generate** : `imagePath` + `imagePathBack` passent
  désormais par un host whitelist (R2, replicate.delivery,
  pollinations.ai). Fetch downstream limité à 20 MB + check
  Content-Type starts with image/.
- **A4 /api/upload-image** : extension whitelist strict (png/jpg/webp,
  SVG banni), magic-byte check sur les bytes décodés, taille cap
  20→5 MB, quota 200 uploads/jour/user dans R2.
- **A8 /api/admin/login** : rate-limit IP-keyed (10 fails/heure →
  429), reset au succès, refus de login si ADMIN_PASSWORD < 20 chars.
- **A7 Stripe credits bounding** : webhook résout credits depuis
  `PACKS[packId]` server-side au lieu de trust metadata. Fallback
  unknown pack capé à 10_000.

Backup branch : `backup-before-security-fixes-batch2-20260527-200559`.

Reste à venir : batch 2 (security headers + mesh_url + Modal auth header),
batch 3 (RGPD delete/export), batch 4 (admin audit log), batch 5
(admin.html innerHTML scrub). Cookies HttpOnly = chantier séparé
(refactor signin server-side).

---

## 2026-05-26 (Security audit fixes — 4 critical + #2 v2 self-healing)

- **Audit** lancé via agent général-purpose : identifié 3 fixes
  critiques + 4-5 importants. Premier batch appliqué :
  1. Bypass `/api/stripe-webhook` du kill switch Site (sinon Stripe
     503 pendant 3j, client payé sans crédits).
  2. Atomicité webhook Stripe : ordre probe → INSERT placeholder
     credits=0 → addCredits → UPDATE patch.
  3. `amount_total` → `amount_eur` dans handleAdminStats (KPI
     gross revenue était à 0 depuis le début).
  4. `/api/debug-auth` désormais gated par `_requireAdmin`.
- **Vérification post-fix par 2e agent** : a trouvé que le fix #2
  v1 ne self-healait PAS — probe retournait `if(existing) return`
  même sur un placeholder credits=0 mort. → **Fix #2 v2** : probe
  stratifié (credits>0 = done, credits=0 = resume, absent = full
  flow) + `addCredits=null` → 500 à Stripe pour retry naturel.
  Reste un risque résiduel : si UPDATE patch fail après addCredits
  OK, le retry peut double-créditer. console.warn loggé pour audit
  post-incident. Future amélioration : RPC Supabase atomique unique.
- **Backup branch** avant fixes : `backup-before-security-fixes-20260526-211038`.

---

## 2026-05-26 (Admin UX — eye toggle + unified Finance/System lock)

- **Eye toggle :** MutationObserver scan tous les
  `<input type="password">` à boot + à chaque mutation DOM, injecte
  un bouton 👁 collé à droite qui flip type=password/text. Bénéficie
  à tous les password fields (login admin, services unlock, pricing
  unlock, TOTP disable, sensitive lock, etc.) sans modification de
  chaque modal.
- **Lock unifié Finance + System :** un seul password unlock
  (`SENSITIVE_TABS`) couvre les 5 tabs sensibles (Revenus, Par type,
  Pricing, Users, Services). Le password unlocked est mirroré dans
  les variables legacy (`_killswitchPassword`, `_pricingPassword`)
  pour éviter de re-taper sur les anciens lock screens. URL hash
  restore whitelist : que les Activity tabs (overview/traffic/ops/
  active) pour éviter un deep-link qui skip l'unlock.
- **Force logout improvements :** `MIN_SESSION_TTL_MS = 5000` (au
  lieu de 60_000) + `handleMe` carry un `reason: 'admin_forced_logout'`
  + `cloud-overrides.js` popup fullscreen "Session ended by admin"
  avec auto-redirect 6s vers /login.

---

## 2026-05-26 (Parity audit cloud vs desktop — loadImage error handling)

- **Contexte :** audit complet déclenché par "fais en sorte que tout
  soit bien implémenté dans le cloud et dans le desktop".
- **Findings :**
  - Tri-toggle home + popups d'avancement + crop preset fix : déjà
    portés desktop (commits f8392a6, bf8d2a5, 6b7e875, b541873).
  - Features cloud-only par design : admin panel, 2FA, kill switches,
    billing, model-viewer, /api/proxy-image, R2 storage.
  - Features desktop-only par design : file:// paths, GPU local,
    Blender integration via main.js.
  - Manquait côté desktop : error handling sur `loadImage` (pas de
    reject, pas de .catch). Sur cloud on l'avait pour le debug.
- **Fix :**
  - `canvas-utils.js`: ajout `img.onerror = () => reject(...)` dans
    CanvasManager.loadImage.
  - `index2-edit-tools.js`: ajout `.catch` aux 2 loadImage (clone +
    mask) avec console.error + toast user.
- **Conclusion :** parité fonctionnelle complète sur tout ce qui est
  partageable. Le reste des diffs (cloud-overrides.js, meshyAPI-cloud.js,
  CSP, etc.) est cloud-only par design.

---

## 2026-05-26 (Cloud: resumePendingJobs fix — popup ne réapparaît pas)

- **Bug :** après reload pendant une génération mesh, la popup ne se
  réaffichait pas. La génération continuait côté Modal mais l'user ne
  la voyait pas.
- **Cause :** `cloud/public/app/index.html:1747` charge `index2.js`
  avec `type="module"`. Les `function pushJob/completeJob/...` au
  top-level d'un module ne sont **pas** attachées à `window`.
  `resumePendingJobs()` checkait `window.pushJob` (undefined) et
  abandonnait silencieusement.
- **Fix :**
  1. `index2.js` : `window.reloadCurrentProject = reloadCurrentProject;`
     (les jobs étaient déjà exposés via `window.fabmeshJobs`).
  2. `meshyAPI-cloud.js:resumePendingJobs` : utilise
     `window.fabmeshJobs.push/.complete` au lieu de `window.pushJob`.
     Retry 10× × 1s si fabmeshJobs pas prêt (module evaluation async).
     Fall-through silencieux si jamais prêt — pollPrediction continue
     quand même, mieux que d'abandonner.
- **Test :** lance un mesh, F5 immédiatement, la popup doit se
  recréer avec "Resumed: after page reload" dans les params.

---

## 2026-05-26 (Cloud: tri projets + Modal status poll)

- **Bug :** sur la home grid, le projet le plus récemment édité
  n'apparaissait pas en première position. Cause :
  `meshyAPI-cloud.js` calculait `created` = `local[0]?.mtime` =
  premier item ajouté au cache (le plus ancien), pas le dernier.
- **Fix :** `created` = `max(mtime)` sur toutes les entrées du cache
  localStorage du projet. Le tri downstream (index2.js → projects par
  `latestTimestamp` décroissant) place maintenant le plus récent à
  gauche. Cf. `meshyAPI-cloud.js` lignes 690-697.
- **Poll Modal status :** descendu 30s → 60s avec throttle 5s sur les
  clics tool-btn. État warm/cold ne flippe que toutes les ~9 min donc
  ±1 min de staleness OK. Divise par 2 la charge R2 reads.
- **Déployé :** wrangler deploy → version d09ca88b. Le user doit hard-
  refresh pour voir l'effet.

---

## 2026-05-26 (Cloud: Vague 2.1/2.2/2.3 — règles multi-view par asset_type)

- **Contexte :** l'utilisateur a remarqué que les règles desktop de
  génération multi-vue par asset_type n'étaient pas appliquées côté
  cloud. Audit confirmé : main.js:4012-4014 (rectify selon type) et
  main.js:4804-4806 (back-view selon type) étaient ABSENTS du Worker
  cloud — seul un `back_view` boolean était propagé sans dispatch.
- **Règles desktop portées :**

  | asset_type | rectify mode | back-view mode |
  |---|---|---|
  | character          | front | realvis (RealVisXL+CN OpenPose+IPA) |
  | creature, animal   | front | realvis* (Wave 2.4 → mvadapter) |
  | vehicle, building, |       |                                     |
  | weapon, prop       | iso   | **sheet** (Wave 2.3 nouveau)        |
  | icon               | iso   | aucune                              |

  *creature/animal devraient utiliser mvadapter (6 vues orthos) — pour
   l'instant fallback sur realvis en attendant Wave 2.4.

- **Wave 2.1 — Auto-rectify avant le mesh.** Dans `handleGenerate`
  path Modal mesh, juste après le upload R2 du front, on call
  `MODAL_RECTIFY_URL` avec le mode dérivé de l'asset_type.
  `frontUrl` est remplacé par la version rectifiée. Non-fatal :
  fallback sur le front original si rectify rate. Toggle off via
  `rectify: false` dans la request.

- **Wave 2.2 — Auto back-view organique.** character/creature/animal
  auto-génère via `MODAL_BACKVIEW_URL`, ajoute la back au mesh comme
  2-view conditioning (`input.multiref = true`). Skip si back déjà
  fournie ou `back_view: false`.

- **Wave 2.3 — Sheet back-view hard-surface.** Nouveau module
  `modal_app/_sheet.py` (port verbatim de `multiview_sheet_gen.py` 4-view
  branch) + endpoint `sheet` sur `MyFabmeshBackview` (réutilise encore
  la même snapshot RealVisXL+IPAdapter+ControlNet, neutralisée via
  cn_scale=0 comme dans `_rectify.py`). Worker helper
  `callModalSheet()` + env `MODAL_SHEET_URL`. Le endpoint génère un
  2x2 grid 2048² et retourne UNIQUEMENT la back-view (les 3 autres
  vues ne sont pas consommées car le multi-view texture refine n'est
  pas porté — pourra être Wave 2.5+).

- **Limitation héritée :** TRELLIS-2 multi-view conditioning est
  désactivé par défaut côté desktop depuis 2026-05-20 (siamese meshes
  confirmées sur 4B). On envoie 2 vues à Modal mais le mesh est en
  réalité 1-view en pratique. Le bénéfice principal des Vagues 2.x est
  donc pour le futur texture refine (les back-views sont stockées sur
  R2 et seront utilisables quand on portera `texture_project.py`).

- **Coût additionnel par mesh :** +$0.30 rectify + $0.10 back =
  +$0.40 Modal par mesh (versus single-view de avant). À surveiller
  sur le budget Starter $30/mois.

- **Statut :** TSC propre, Python ast OK. À deployer.

---

## 2026-05-25 (Cloud: Vague 1.6 — face_fix réel — atlas SDXL inpaint)

- **Contexte :** TRELLIS-2 produit régulièrement des visages flous /
  asymétriques (limitation de résolution voxel). Le desktop a
  `scripts/face_inpaint_atlas.py` qui rend le mesh ortho-front, détecte
  le visage via OpenCV Haar Cascade, projette le bbox sur l'atlas UV,
  fait un SDXL inpaint à 1024² sur la zone, recompose dans l'atlas
  natif. Le Worker propage déjà `face_fix: bool` depuis longtemps mais
  côté Modal c'était NO-OP — un flag accepté qui ne faisait rien.
- **Substitution clé vs desktop :** PAS de pyrender / OSMesa côté cloud
  (trop fragile à builder dans Modal images, dépend de l'environnement
  GL headless). À la place, **detection sur l'image FRONT d'entrée**
  qui sert déjà à conditionner TRELLIS-2. Justification : TRELLIS-2
  positionne le visage du mesh aux MÊMES coords screen-space que dans
  l'image conditionnante (c'est ce que la chaîne ortho-front du
  pipeline garantit). Donc bbox(front_img) projetée sur l'atlas via la
  même formule ortho landed on the same UV triangles que
  bbox(rendered_mesh) would. Le reste — projection UV, inpaint, blend —
  est verbatim.
- **Lazy-load :** SDXL inpaint (RealVisXL_V4.0 weights via
  `StableDiffusionXLInpaintPipeline`) chargé paresseusement sur
  `MyFabmeshMesh.inpaint_pipe`. Ne pas le mettre dans
  `@enter()` parce que 90% des calls mesh n'ont pas face_fix, et le
  charger ajouterait ~30-60s à tous les cold starts. Premier
  `face_fix=true` paye le coût (~60s), suivants l'utilisent en cache
  jusqu'au scaledown.
- **Robustesse :** wrapped dans try/except, fallback bbox = top 30% si
  Haar Cascade rate. `apply_face_fix` retourne le GLB ORIGINAL inchangé
  si quoi que ce soit échoue (passthrough policy — un flag face_fix
  ne doit jamais casser un mesh valide). Même politique que le desktop
  (shutil.copy de fallback).
- **Aucune nouvelle dépendance Modal :** opencv-python-headless +
  diffusers déjà dans `mesh_image`. cv2.data.haarcascades bundled même
  dans la version headless.
- **Statut :** Python ast OK. Prêt pour deploy. Vague 1 cloud parity
  COMPLÈTE — il reste juste le deploy + smoke test.

---

## 2026-05-25 (Cloud: Vague 1.5 — Auto-rectify orthographic front / 3-4 ISO)

- **Contexte :** la plupart des références utilisateur sont des concept-arts
  3/4 angle, pas des fronts orthographiques. TRELLIS-2 + MVAdapter cascade
  proprement seulement avec un front strict (humanoïdes) ou un ISO 3/4
  (véhicules/objets). Le desktop a `scripts/generate_front_strict.py`
  qui re-génère 3 candidats RealVisXL et garde le meilleur par
  symmetry-IoU sur la silhouette rembg.
- **Pipeline :** RealVisXL_V4.0 alone + IPAdapter h94 plus_sdxl_vit-h
  (optionnel pour préserver identité). Multi-seed (default 3) avec
  symmetry_score :
    - mode 'front' → max IoU (silhouette symétrique)
    - mode 'iso'   → max (1 - IoU) si sym < 0.85 (sinon 0, évite back/side)
- **Architecture cloud :** réutilise encore la `MyFabmeshBackview`
  (RealVisXL + ControlNet OpenPose + IPAdapter déjà snapshotés). Le
  ControlNet est NEUTRALISÉ à l'appel : `image=blank_skel` +
  `controlnet_conditioning_scale=0.0` → la branche conv tourne mais
  ses résiduels sont multipliés par 0, donc le UNet ignore le
  ControlNet et on a un comportement strictement équivalent à un
  `StableDiffusionXLPipeline` pur (= ce que fait le desktop).
- **Nouveaux fichiers :**
  - `modal_app/_rectify.py` (verbatim port de generate_front_strict.py)
  - endpoint `rectify` sur `MyFabmeshBackview`
  - env `MODAL_RECTIFY_URL` + `callModalRectify()` + route
    `POST /api/rectify-image` côté Worker.
- **Coût :** 3 credits par appel (multi-seed). Estimé $0.30 Modal
  pour 3 seeds × $0.10. NSFW pre-filter (Vague 1.3) appliqué au prompt
  AVANT facturation.
- **Statut :** TSC clean, Python ast OK. Prêt pour deploy.

---

## 2026-05-25 (Cloud: Vague 1.4 — T-pose front strict mode)

- **Contexte :** RTS / Unreal pipeline a besoin d'un input strictly
  T-pose front pour que TRELLIS-2 + cascade MVAdapter cascade
  proprement. Le desktop a `scripts/generate_front_tpose.py` (RealVisXL
  + ControlNet OpenPose xinsir + IPAdapter h94 plus_sdxl_vit-h, cn_scale
  1.15 / ip_scale 0.75 / 30 steps / 1024², post-rembg + center @ 92%
  hauteur). Le cloud n'avait RIEN — quand le user demandait un perso
  RTS, il obtenait un free-pose qui chiait à l'export 3D.
- **Modèle :** **PAS** DreamShaper XL Lightning (mon plan initial était
  faux). Verbatim : RealVisXL_V4.0 + xinsir/controlnet-openpose-sdxl-1.0
  + h94/IP-Adapter (sdxl_models/ip-adapter-plus_sdxl_vit-h.safetensors).
  Exactement les mêmes weights que le desktop.
- **Architecture :** réutilise la classe existante
  `MyFabmeshBackview` (RealVisXL + ControlNet + IPAdapter déjà
  snapshotés). Le seul ajout est le skeleton T-pose FRONT
  (`modal_app/front_tpose_skeleton.png` copié depuis
  `scripts/_front_tpose_skeleton.png`), shipped en `/opt/` via
  `add_local_file`. Nouveau module `modal_app/_tpose.py` (verbatim port
  de la logique desktop). Nouvel endpoint `tpose` sur
  MyFabmeshBackview qui dispatch entre text2image (prompt) et img2img
  (refImageUrl via IP-Adapter).
- **Worker :** nouveau env `MODAL_TPOSE_URL`, helper `callModalTpose()`,
  flag `tpose: true` + `refImageUrl?` dans `handleGenerateImage`.
  Coût estimé $0.10/image (≈ back-view, vs $0.06 pour text2image
  simple). NSFW pre-filter (Vague 1.3) s'applique au prompt T-pose
  AVANT facturation.
- **Pas snapshot séparé :** ne pas créer une nouvelle `@app.cls` —
  ça ajouterait 15 GB de RAM snapshot + 30s de cold start juste pour
  un endpoint qui a STRICTEMENT les mêmes weights que back-view.
- **Statut :** code écrit. TSC passe (cloud/), Python ast parse OK.
  Sera déployé+smoke-testé dans la phase Deploy en fin de Vague 1.

---

## 2026-05-25 (Cloud: Vague 1.3 — NSFW prompt pre-filter Worker-side)

- **Contexte :** audit parité desktop/cloud a révélé que le cloud n'avait
  AUCUN pre-filter NSFW sur les prompts text2image / back-view. Toute la
  charge anti-abus reposait sur le post-gen `modal_app/_nsfw.py` côté
  image. Risque : un prompt bloquant ("nude child …") cramerait quand
  même un appel GPU avant d'être recalé en sortie — coût + responsabilité.
- **Port :** `src/main/main.js:223-303 checkPromptSafety` → port verbatim
  vers `cloud/src/nsfw_filter.ts` (TypeScript). NSFW_KEYWORDS (~150
  termes FR + EN couvrant sexe, gore, mineurs, drogue, terro, haine,
  armes) + NSFW_COMBOS (enfants×nudité, anyone×sexuel extrême,
  violence×enfants) + `_matchesKeyword` avec word-boundary court terme.
- **Intégration Worker :** `handleGenerateImage` (text2image) +
  `handleGenerateBackView` lèvent un HTTP 400 avant toute facturation /
  appel Modal si le prompt match. Bypass via `FABMESH_UNRESTRICTED=1`
  (dev only). Ajouté à l'interface `Env`.
- **Pas porté :** classifier ML Falconsai/NSFW_text_classifier (desktop
  l'utilise après les keywords). Trop coûteux à inférer sur Worker pour
  notre échelle ; on garde le post-gen image NSFW Modal.
- **Statut :** Vague 1.3 finie. Wave 1.1 (AI Act metadata GLB) + 1.2
  (multi-view mesh path) déjà commitées plus tôt dans la session.
  Prochain : 1.4 T-pose mode (DreamShaper XL Lightning + ControlNet
  OpenPose), critique pour les unités RTS.

---

## 2026-05-25 (Cloud: Modal mesh_image — fix DINOv3ViTModel import crash)

- **Symptôme :** `MyFabmeshMesh.load_to_cpu` crash-loop sur Modal avec
  `ImportError: cannot import name 'DINOv3ViTModel' from 'transformers'`.
  La chaîne d'import est `from trellis2.pipelines import …` →
  `trellis2/modules/image_feature_extractor.py:5` →
  `from transformers import DINOv3ViTModel`.
- **Root cause (vérifiée web) :** `DINOv3ViTModel` n'a été ajouté à
  HuggingFace `transformers` qu'à partir de la **4.56.0** (release du
  2025-08-29, support code mergé 2025-08-14). Le mesh_image était pinné
  à `transformers==4.51.3` — pas de cache Modal foireux, juste la
  mauvaise version (le commentaire dans app.py affirmait à tort que
  4.51 était la plus basse version contenant le symbole).
- **Fix :**
  - bump `transformers==4.51.3` → `transformers==4.56.0` dans le
    pip_install initial ET le run_commands explicite. tokenizers bumpé
    à `>=0.22,<0.23` (4.56 exige tokenizers 0.22+). huggingface_hub
    floor à 0.34.
  - `pip install /opt/trellis2_local/o-voxel` reçoit `--no-deps` pour
    qu'il ne puisse pas redéscendre transformers via une dep transitive.
  - Ajout de deux **guards Python `-c`** dans le build (après le
    upgrade transformers, et après le `--force-reinstall torch`) qui
    importent `DINOv3ViTModel` — si une étape clobbe transformers, le
    build échoue avec un traceback clair AU LIEU de crash-loop le
    container runtime.
- **Compat torch :** transformers 4.56 exige torch >= 2.2 → torch 2.4.1
  pin reste valide, pas besoin de bump torch.
- **Plan B prêt si re-crash :** patcher
  `external/TRELLIS2_win/src/trellis2/modules/image_feature_extractor.py`
  pour rendre l'import lazy (`DINOv3ViTModel` chargé dans `__init__` de
  `DinoV3FeatureExtractor` seulement) et tomber back sur la classe
  `DinoV2FeatureExtractor` du même fichier si la 4.56 pose un autre
  problème.

---

## 2026-05-25 (Cloud: Modal POC scaffolding — replace Replicate for text2image)

- **Constat (réel sur facture Replicate du 25 mai) :**
  - Setup time = 78 % de la facture (2 307 s sur 2 971 s) — l'image
    Docker Cog post-pre-download faisait 18 GB → ~957 s de pull par
    cold start = $0.93 / image avant qu'on commence à générer quoi
    que ce soit. Le rebuild rollback ramène ça à ~87 s = $0.085,
    mais c'est encore 78 % du coût total.
  - Modal.com facture aussi le setup mais le mécanisme **Memory
    Snapshots** capture les weights chargés en CPU et les restaure
    en ~5 s sur cold start → setup quasi gratuit + UX cold start ~5 s
    au lieu de ~90 s. Pricing par-seconde L40S aussi -44 % ($0.000542
    vs $0.000975).
  - Cible : ~$0.022 / image (×5.5 moins cher que Replicate).
- **Actions (sans toucher au desktop) :**
  - Nouveau dossier `modal_app/` (renommé depuis `modal/` parce que
    le nom collisionne avec le SDK Python `modal`) :
    - `_prompts.py` — asset/style suffixes copiés depuis index2.js
      + cog/predict.py (verbatim, pour parité output desktop ↔ cloud).
    - `_realvis.py` — `generate(pipe, prompt, seed, steps)` pure
      function, port du chemin non-T-pose de
      scripts/local_juggernaut_bridge.py (prompts optimisés,
      anti-doubling, negative prompt avec poids 1.4-1.6 inchangé).
    - `_nsfw.py` — dual-model NSFW filter + skin-ratio fallback,
      même politique que desktop (Falconsai + AdamCodd, threshold 0.5,
      skin > 35 % bloque). FABMESH_UNRESTRICTED=1 bypass préservé.
    - `app.py` — Modal `@app.cls` avec `@modal.enter(snap=True)`
      qui charge RealVisXL + les 2 classifieurs NSFW **sur CPU**, puis
      `@modal.enter(snap=False)` qui les move sur GPU après attach.
      Endpoint HTTPS via `@modal.fastapi_endpoint(method="POST")` —
      pas de polling côté Worker (1 seul fetch), donc plus de risque
      subrequest-limit.
    - Auth : shared secret 32-byte via header (`_auth` dans body JSON,
      vérifié contre `SHARED_SECRET` injecté par `modal.Secret.from_name`).
  - `cloud/src/worker.ts` :
    - Ajout 2 env vars : `MODAL_TEXT2IMAGE_URL` + `MODAL_SHARED_SECRET`.
    - Nouvelle fonction `callModalText2Image()` : POST JSON → reçoit
      PNG bytes → push R2 → renvoie URL. ~5 subrequests vs ~25 pour
      le path Cog.
    - `handleGenerateImage()` route vers Modal si la URL est set, sinon
      fallback Cog/Replicate. Feature flag instantané (delete secret
      = retour Replicate, pas de redeploy).
  - `cloud/wrangler.toml` : commentaires des secrets Modal documentés.
- **Pas encore fait (suivi) :**
  - back-view sur Modal : nécessite 4 modèles snapshot (RealVisXL +
    ControlNet OpenPose + IP-Adapter + Florence-2) — ~14 GB de
    snapshot, hors confort zone Modal. Séparation en classe dédiée
    à faire après validation du POC text2image.
  - Le smoke test desktop reste à valider — théoriquement aucun
    fichier de `scripts/` n'est touché donc rien ne devrait casser.
- **Conclusion (anticipée) :** scaffolding posé, deploy + mesure cold
  start à faire côté Modal pour confirmer le gain réel. Si Memory
  Snapshots ne marchent pas avec notre stack (CUDA 12.4 + torch 2.4
  + xformers 0.0.28 + diffusers 0.31), gain Modal tombe à ~2×
  pricing seulement — à comparer avec coût de migration.

---

## 2026-05-25 (Cloud worker: subrequest-limit fix + anti-orphan lease)

- **Problème :** `callMyfabmeshCog()` polling jusqu'à 120 fetch() par image en
  une seule invocation Worker → "Too many subrequests by single Worker
  invocation" (limite CF = 50 free / 1000 paid). Quand le Worker meurt,
  la prediction Replicate **continue de tourner et facture**. Cas observé
  ce matin : prediction `ap13hy70gxrmy0cybk7tvvqbnr` orpheline pendant
  9 min avant cancel manuel.
- **Fixes (cloud/src/worker.ts) :**
  - Poll : 2.5s interval / 300s timeout → **6s interval / 20 polls max**
    (= 180s après le `prefer:wait=60`). Subrequests par appel : ~120 → ~25.
  - **Lease R2** : on PUT `_meta/inflight/<predId>` dès la création
    (avant tout poll). Permet à un /api/cleanup-orphans de retrouver
    et cancel les zombies si le Worker meurt brutalement.
  - **Cancel-on-error** : try/catch autour de tout le polling — n'importe
    quelle erreur (timeout, status failed, exception) déclenche un
    cancel HTTP de la prediction avant de throw.
  - Lease supprimé sur succès.
- **Action #1 (en cours) :** rebuild Cog SANS pre-download D pour ramener
  setup_time de 957s → ~87s (×11 économie sur cold-start). Workflow run
  26395964348 déclenché.
- **Conclusion :** Le problème de fond reste que le polling vit dans
  la même invocation que la création. Refactor futur : déplacer le poll
  côté client (POST crée la prediction et retourne l'ID, client GET
  status) — pas fait ce coup-ci, mais le lease R2 sert déjà de filet.

---

## 2026-05-24 (Cloud: wire ~30 stubs in meshyAPI-cloud + 5 new Worker endpoints)

- **Problème :** le shim `cloud/public/app/meshyAPI-cloud.js` exposait ~65 fonctions stub
  qui retournaient `{ ok:false, cloudUnavailable:true }`. Un user qui ouvrait l'app cloud
  hit ces stubs sur des actions courantes (lister ses projets, exporter un mesh, retirer
  un fond, regénérer une vue arrière, etc.) → expérience cassée bien que "officiellement live".
- **Actions :**
  - **Worker (cloud/src/worker.ts) :** ajouté 5 endpoints :
    - `GET  /api/cloud-projects` — groupe les `jobs` par `project_name`
    - `GET  /api/meshes` — liste meshes succeeded (id, url R2, asset_type)
    - `POST /api/meshes/delete { id }` — supprime R2 object + jobs row
    - `POST /api/cloud-projects/delete { projectName }` — nullify project_name sur les jobs
    - `POST /api/jobs/cancel { id }` — annule la prédiction Replicate + refund crédits
    - `POST /api/remove-background { imageUrl | image }` — proxy Replicate 851-labs
    - `POST /api/generate-back-view { prompt }` — proxy Pollinations, tunnellé R2
  - **Migration Supabase (`20260524160000_add_project_name.sql`) :** ajout colonne
    `project_name text` sur `jobs` + index `(user_id, project_name)`. Appliqué en live
    via Management API (`POST /v1/projects/{ref}/database/query`).
  - **Shim (cloud/public/app/meshyAPI-cloud.js) :** implémenté ~30 fonctions :
    - Persistance projets : `listImageFolders`, `listMeshes`, `getMeshLocalUrl`,
      `readMeshFile`, `getMeshPath`, `deleteMesh`, `deleteImageFolder`, `deleteFile`.
    - Thumbnails : `saveThumbnail` / `getThumbnail` via localStorage (`myfm:thumb:<name>`).
    - File I/O navigateur : `importImageFile`, `pickExportPath`, `exportMesh`, `exportImage`,
      `getFileInfo`. Pas de filesystem → `<a download>` + blob URLs.
    - Édition image client-side via Canvas 2D : `imageAdjust` (brightness/contrast/saturate
      + auto_levels), `imageQuickEdit` (upscale, downscale, crop, extend, symmetrize, brightness).
    - Versions image : `duplicateImageVersion`, `listImageVersions`, `revertImage` (localStorage).
    - `removeBackground` → Worker /api/remove-background → Replicate 851-labs.
    - `captionImage` → stub conservateur ("wearing the same outfit as the front view")
      faute de vision dans Pollinations text endpoint.
    - Multi-vues : `generateBackView` → Worker, `generateMultiview` → 3× Pollinations
      (back/left/right) côté client, `generateFromImage` → Pollinations img2img.
    - `cancelJob`, `saveScreenshot` (canvas.toBlob + download), `getVersions`,
      `showInExplorer` (window.open), `openLogsFolder` / `openMeshesFolder` /
      `openImagesFolder` (no-op + message friendly).
  - **Stubs restants explicites Desktop-only :** Blender pipeline (meshTool, materialAdjust,
    alignTexture, refineMesh, exportToUnreal → tombe sur GLB plain), Calibration (calibRun…
    calibClearLog), UniRig (autoRig, autoRigAI, saveLandmarks…), MCP Claude Desktop bridge,
    img2img/autoInpaint/maskInpaint avancés, getControlApiToken, testMeshyKey, setBlenderPath…
  - **Choix éditorialaux :** removeBackground = gratuit pour la beta (pas de spend_credits),
    à reviewer si abus. Multi-view : 3 vues additionnelles seulement (front existe déjà
    chez le caller). Versions image : key globale (`myfm:versions:global:<basename>`) faute
    de connaître le project name côté shim.
- **Conclusion :** parcours user normal (image gen → edit → mesh → download → rouvrir
  un projet → export) ne devrait plus toucher de stub. Build à valider via GH Actions
  (`npx next build` impossible localement — sandbox).
- **À ré-évaluer :** `captionImage` mériterait un vrai modèle vision (BLIP / GPT-4o-mini)
  pour back-view, le stub conservateur dégradera la qualité du re-prompting outfit.
  `exportMesh` ne transcode pas (Blender Desktop-only) — pour l'instant on télécharge
  toujours le GLB original quel que soit le format demandé, avec un message d'avertissement.

---

## 2026-05-24 (Cloud auth wiring: Resend SMTP + branded templates pushed via Management API)

- **Problème :** mails Supabase de confirmation (a) envoyaient sur `localhost:3000`,
  (b) rate-limit free tier (3/h) bloquait les retests, (c) rendu HTML défaut affreux.
- **Actions:**
  - Site URL + Redirect URLs Supabase pointés sur le Worker prod (via dashboard, pas trouvé
    d'automatisation sans PAT à ce moment-là).
  - SMTP custom Resend branché côté Supabase (host smtp.resend.com:465, user `resend`,
    sender `onboarding@resend.dev` / "MyFabmesh.AI"). Free tier 3 000 mails/mois,
    rate-limit Supabase passe à 30/h.
  - 4 templates HTML brandés écrits dans `cloud/supabase/email-templates/`
    (magic-link, confirm-signup, reset-password, change-email) — dark theme,
    gradient `#e94560 → #a855f7`, footer Ayros Studio.
  - Script idempotent `cloud/scripts/supabase-apply-email-templates.mjs` qui PATCH
    les 4 sujets + 4 contenus via Management API en 1 appel. Lit le PAT depuis
    env `SUPABASE_PAT` ou `build/supabase-pat.txt` (gitignored).
- **Conclusion:** chaîne auth complète en prod : signup → SMTP Resend → mail brandé →
  click → `myfabmesh-cloud.fabien65400.workers.dev/auth/callback` → session établie.
  PAT Supabase stocké en sidecar gitignored, réutilisable pour toute config future
  (MFA, OAuth providers, etc.) sans re-passer par le dashboard.

---

## 2026-05-24 (Cloud deploy: abandon @opennextjs/cloudflare → static export + single Worker)

- **Problème :** `@opennextjs/cloudflare build` crashait sur 3 runs CI
  consécutifs avec `esbuild: Invalid alias name`. Pas fixable sans
  attendre upstream.
- **Décision :** on bascule sur `next.config.mjs { output: 'export' }`
  (HTML statique dans `./out/`) + un **Worker monolithique**
  `cloud/src/worker.ts` qui implémente les 11 routes API + `/auth/callback`
  comme un simple router URL-pattern.
- **Conversions client-side :** `Nav`, `page.tsx` (root), `account/page.tsx`,
  `buy/page.tsx` étaient des Server Components appelant `getSessionUser()`.
  Convertis en client components qui fetchent `/api/me` au mount.
  La page Account ne montre plus la table des paiements (TODO: ajouter
  `/api/payments` côté Worker si besoin).
- **PACKS** extraits de `lib/stripe.ts` vers `lib/packs.ts` pour ne pas
  drag-in le SDK Stripe dans le bundle client de `/buy`.
- **Stripe webhook signature** : verif via `crypto.subtle` (Web Crypto)
  au lieu de `stripe.webhooks.constructEvent` (qui dépend de node:crypto).
- **Build local validé :** `npm run build` produit `out/` avec
  `index.html`, `account.html`, `buy.html`, `login.html`, et le folder
  `app/` (renderer desktop). `wrangler deploy --dry-run` compile le
  Worker sans erreur (avant ça crashait à chaque build OpenNext).
- **API folder supprimé :** `git rm -rf cloud/src/app/api cloud/src/app/auth`
  (11 route handlers + le callback supabase fusionnés dans `worker.ts`).
- **wrangler.toml** : `main = "src/worker.ts"`, `[assets] directory = "out"`,
  flags = `nodejs_compat` seul (plus `global_fetch_strictly_public` qui
  bloquait certains fetch externes).
- **GH Actions** : step `npm run build` remplace
  `npx @opennextjs/cloudflare build`. Même set de secrets, même token.

## 2026-05-24 (Cloud deploy: stub live + GitHub Actions for full Next.js)

- **Cloudflare API token** créé via dashboard (`Edit Cloudflare Workers`
  template) et fourni par le user — j'ai pris le contrôle complet via
  wrangler CLI sans dashboard.
- **Stub `Coming soon` live** sur `https://myfabmesh-cloud.fabien65400.workers.dev/`
  (HTML inline avec branding Ayros Studio + gradient violet/crimson +
  lien retour vers GitHub Pages). Deploy via `wrangler deploy` direct
  (skip le build OpenNext qui échoue sur Windows à cause d'un bug esbuild
  "Invalid alias name: next/dist/compiled/ws").
- **13 secrets runtime du Worker** set via `wrangler secret put` :
  REPLICATE_API_TOKEN + MODEL, SUPABASE_SERVICE_ROLE_KEY,
  STRIPE_SECRET_KEY + 3 price IDs, R2_ACCOUNT_ID + ACCESS_KEY_ID +
  SECRET_ACCESS_KEY + BUCKET + PUBLIC_URL + S3_ENDPOINT.
  Vérifiés via `wrangler secret list`.
- **GitHub repo secret `CLOUDFLARE_API_TOKEN`** ajouté via `gh secret set`
  pour que le workflow GH Actions puisse deploy.
- **`.github/workflows/cloud-deploy.yml`** créé : trigger sur push de
  `cloud/**` ou manuel, runs sur ubuntu-latest, fait
  `npm install --legacy-peer-deps && npx @opennextjs/cloudflare build &&
  npx wrangler deploy`. Bake les NEXT_PUBLIC_* vars au moment du build.
  Smoke test 5s après deploy.
- **Blockers résolus en route** :
  - Cloudflare auto-build CI échoue sur `npm ci` racine (electron-builder
    peer deps Linux-incompat). Mon `.npmrc` (omit=optional, legacy-peer-deps,
    ignore-scripts) marche en LOCAL mais Cloudflare auto-build a quand
    même échoué. → bypass en utilisant GH Actions workflow custom qui
    contrôle l'install au lieu de l'auto-install Cloudflare.
  - Build OpenNext sur Windows : impossible (esbuild bug). GH Actions
    runs sur Linux donc OK.

---

## 2026-05-24 (Cloud setup live: Supabase + Stripe + Cloudflare + OpenNext)

Session live avec le user — création des comptes externes et provisioning :

- **Stripe** (compte existant "Fabidou", test mode acct_1TEArR3uvj2cFz0k) :
  - 3 produits one-time créés : MyFabmesh.AI Starter (5€) / Pro (20€) / Studio (50€)
  - Price IDs : price_1TaXwV3uvj2cFz0kJ57GGzxG / price_1TaY5C3uvj2cFz0knpUvfciv / price_1TaY6f3uvj2cFz0k0vofoq91
  - pk_test + sk_test wirés dans cloud/.env.local
- **Supabase** (compte existant) :
  - PAT généré, projet `myfabmesh-cloud` créé en eu-west-3 (Paris)
  - Ref `ovoccoipeqmkfnugkmyh`, anon + service_role keys récupérées
  - Schema SQL pushé (profiles + jobs + payments + RPCs + RLS) via supabase db push
- **Cloudflare** (nouveau compte) :
  - R2 activé (free tier 10 GB)
  - Bucket `myfabmesh-meshes` créé en Western Europe + public dev URL
    pub-ca633fb6a3334d0ea29be5fe5eb47228.r2.dev
  - Account API token "Object Read & Write" scoped au bucket
  - Account ID : a74e8ad01c363d77acec95c7f2123d9a
- **Découverte** : Cloudflare a unifié Pages + Workers — le flow "Create"
  pousse vers la nouvelle UI Workers (avec build/deploy commands custom)
  au lieu de l'ancien Pages classique. Bascule de stratégie vers
  `@opennextjs/cloudflare` (l'adaptateur officiel Next.js → Workers,
  qui remplace `@cloudflare/next-on-pages` deprecated).
- **Repo prep** :
  - `cloud/package.json` : ajout `@opennextjs/cloudflare ^1.19.11`
  - Création `cloud/open-next.config.ts` (defineCloudflareConfig minimal)
  - `cloud/wrangler.toml` réécrit pour Workers (main=".open-next/worker.js",
    binding R2 MESHES, assets, compatibility nodejs_compat + global_fetch_strictly_public)
- **À faire** : commit + push pour que Cloudflare build voit la config,
  puis user clique Deploy. Env vars à coller dans Settings après le 1er
  deploy.

---

## 2026-05-24 (Cloud ready check + DEPLOY_CLOUD_STEP_BY_STEP)

Le user a demandé "est-ce qu'on est ready pour le Cloud ?". Bilan :

**Code : 100% prêt.**
- `npm run build` OK : 16 routes, 0 erreur TS.
- Tests e2e MOCK (script automatisé) : tous passent
  - GET / anonyme → 200 (landing visible)
  - POST /api/mock-login → user créé avec 50 crédits
  - GET /api/me avec cookie → user retourné
  - GET / authentifié → 307 redirect vers /app/
  - GET /app/ → 200 size=146608 (renderer desktop chargé, contient `index2.js`,
    `meshyAPI-cloud`, `topbar`)
  - POST /api/generate multipart → `{jobId, creditsRemaining: 49}` (mock decrement OK)
  - Polling /api/jobs/[id] → "processing" puis "succeeded" après 5s avec
    `url: /mock/sample.glb`
  - GET /buy → 3 packs visibles
  - GET /api/projects → `{projects: []}` (mock store vide pour nouveau user)

**Deploy : il manque 3 signups externes** (Supabase / Stripe / Cloudflare).

Ajouts ce tour :
- `cloud/wrangler.toml` : config Cloudflare Pages (nodejs_compat, R2 binding,
  vars publiques).
- Découverte : `@cloudflare/next-on-pages` est BUGGÉ sur Windows (spawn npx
  ENOENT sur Vercel CLI). → Bascule de stratégie vers **GitHub integration
  native Cloudflare Pages** : Cloudflare clone le repo + build côté serveur,
  pas besoin de build local Windows. Plus simple, plus fiable.
- `cloud/DEPLOY_CLOUD_STEP_BY_STEP.md` : guide complet (1500+ lignes) avec
  les ~5 actions humaines (PAT Supabase + Stripe signup + Cloudflare signup
  + GitHub integration + env vars) + smoke tests + troubleshooting + Cog push
  optionnel + custom domain optionnel + Sentry optionnel + timeline réaliste
  (90 min pour Cloud test mode live, 3-4h pour Cloud avec notre Cog).

---

## 2026-05-24 (autonomous prep pendant que user joue à Battlefield)

User parti jouer en demandant ce qu'on pouvait faire en parallèle de
la cert MS Store. Travail solo, sans dépendance externe :

- **`build/marketing/MS_STORE_LISTING_ANONYMIZED.md`** : description
  Store anonymisée prête à coller post-cert (retire TRELLIS-2,
  IP-Adapter, SDXL — info concurrent-friendly à ne pas exposer).
- **`build/marketing/PRESS_KIT.md`** : pitch en 1/3 paragraphes,
  facts table, comparatif vs Meshy/Tripo/CSM, FAQ, assets paths,
  brand colors, contact. Prêt à envoyer aux journalistes.
- **`build/marketing/LAUNCH_POSTS.md`** : drafts launch posts pour
  Twitter (3 variants), Reddit (r/gamedev, r/3Dprinting, r/StableDiffusion),
  Show HN, Discord, LinkedIn. Plus un schedule de posting recommandé
  (Day 0 / Day 1) avec horaires CET optimaux par plateforme.
- **`.github/workflows/build-release.yml`** : GitHub Actions workflow
  qui auto-build NSIS .exe + MSIX .appx à chaque tag `v*` push,
  uploads en artefacts + attache au GitHub Release. Recrée les
  sidecar files (sentry-dsn.txt, hf_fallback_token.txt) depuis les
  secrets repo. Plus de build manuel.
- **`build/POST_CERT_CHECKLIST.md`** : checklist 7 étapes à exécuter
  dès l'email "Passed certification" : test end-to-end install,
  modif description anonymisée, vrais screenshots, annonces launch,
  update OG tags, monitoring 48h, backlog.
- **Sweep résidus TRELLIS/SDXL** : `cloud/src/app/buy/page.tsx`
  ligne 44 — "Face fix (SDXL inpaint)" → "Face fix (AI inpaint)"
  (la table pricing sera visible publiquement quand le Cloud sera live).
  Le reste des mentions est dans des fichiers internes (build/*.md,
  cloud/README.md) ou des submodules open-source — OK à laisser.
- **Verif pages live** : index, privacy, terms, cloud OK 200.
  ESSAIS_TEXTURING.md / PIPELINE_VOIE_B.md bien 404 (déplacés vers
  notes/ hier).

---

## 2026-05-24 (site web : primary download = MS Store deeplink)

- **Contexte** : confirmé sur la machine du user que Smart App Control
  bloque la création de fenêtre Electron même quand l'app installe via
  NSIS et même avec admin elevation. Le seul moyen d'avoir un install
  qui MARCHE pour tous les Win 10/11 = passer par MS Store (signé
  automatiquement par Microsoft).
- **Modif `docs/index.html` carte Desktop** :
  - Bouton principal "Download — Free beta" → remplacé par
    "Get from Microsoft Store" pointant vers
    `ms-windows-store://pdp/?productid=9PH6GT8XKQDW`.
  - Bouton direct download GitHub Releases déplacé dans un
    `<details>` "Direct download (advanced users)" avec warning
    explicite "may be blocked by Windows Smart App Control".
- **Timing** : push fait maintenant. Le deeplink ms-windows-store://
  retournera "App not available" jusqu'à ce que MS Store publie l'app
  (cert en cours, ~24-72h). Quand l'app sera live, le bouton marchera
  automatiquement sans nouvelle modif site.

---

## 2026-05-24 (legal pages + IP scrub)

- **Issue user** : "il y a du TRELLIS marqué et des infos que je ne veux
  pas partager ouvertement" — il a raison, le site public dévoilait
  toute la stack tech.
- **Scrub `docs/cloud.html`** : remplacé `TRELLIS-2 pipeline` → `image-to-3D
  pipeline`, `NVIDIA L40S cloud GPU` → `Professional-grade cloud GPU`,
  `Fast mode (H100)` → `Fast mode (premium tier)`. Affecte aussi le
  meta og:description (preview cards Twitter/Discord).
- **Déplacement `docs/ESSAIS_TEXTURING.md` + `docs/PIPELINE_VOIE_B.md`
  vers `notes/`** — ces deux journaux dev internes étaient servis par
  GitHub Pages (donc accessibles via URL directe) et révélaient toute
  la stack : TRELLIS-2, IP-Adapter, SDXL, ControlNet, Hi3DGen, paths
  WSL, patches Blackwell, etc. `notes/` n'est PAS servi par GitHub
  Pages.
- **Création `docs/terms.html`** : ToS standard SOHO français (license,
  IP, beta status, no warranty, droit français, contact). Linked depuis
  footer index.html.
- **Fix `docs/index.html` footer** : Terms et Privacy pointaient vers
  des ancres `#legal-terms` / `#legal-privacy` inexistantes (clic =
  rien). Repointés vers `terms.html` / `privacy.html`.
- **Note différée** : le store listing MS Store actuellement en
  certification contient ENCORE la description avec TRELLIS-2 /
  IP-Adapter / SDXL (rédigée hier soir). Modifiable APRÈS publication
  sans nouvelle review du package — à faire dès que l'app est live.
- **Leak historique** : les deux .md déplacés restent dans l'historique
  git public. Pour scrub complet : `git filter-repo` sur master
  (procédure déjà utilisée mi-mai). Faible priorité — URLs jamais
  exposées depuis le site, indexation Google très improbable.

---

## 2026-05-24 (rebrand publisher → "Ayros Studio")

- **Contexte** : enregistrement MS Store dev account (Individual, 19 $) en
  cours ; publisher display name validé = **Ayros Studio** (marque ombrelle
  qui chapeautera MyFabmesh.AI + Apovivor + futurs projets).
- **Remplacements** (texte public uniquement, nom légal "Fabien Lacaze"
  conservé dans `package.json author.email` + commits git) :
  - `package.json` : `build.copyright` + `build.win.signtoolOptions.publisherName`
    (author.name déjà modifié en amont par user).
  - `LICENSE.txt` : copyright holder.
  - `docs/index.html` + `docs/cloud.html` : footer site officiel.
  - `cloud/src/app/layout.tsx` : footer Next.js cloud (était "FabWare").
  - `src/renderer/index2.html` + `cloud/public/app/index.html` :
    "Crafted by" → "An Ayros Studio production".
- **Non touché** : ROADMAP.md (user gère séparément l'entrée décision),
  AGENT_LOG.md historique, chemins `C:\...\FabWare\...` (dev box), Sentry
  org `fabienlacaze` (GitHub handle non affiché), produit `MyFabmesh.AI`
  inchangé.

---

## 2026-05-23 (cloud P2 kickoff + scaffold complet + redesign + auto-provisioning)

### Soir 3 (2026-05-24) — Pivot stratégique : Cloud = port du renderer desktop

- **Pivot architectural** : ma première approche cloud (Next.js avec composants
  React custom qui réimplémentaient l'UI desktop) était bonne visuellement
  mais pas une "copie conforme". User feedback : "il faut que ce soit la même
  mise en page et la même logique [que desktop]".
- **Nouvelle stratégie** : copier les fichiers source du renderer Electron
  (`src/renderer/index2.html` + `index2.js` + `styles/*` + `lib/*`) dans
  `cloud/public/app/` et remplacer seulement `window.meshyAPI` (le bridge IPC
  Electron) par un shim qui appelle des routes HTTP `/api/*`.
- **Avantages** : 1 source de vérité UI. Cohérence parfaite Desktop ↔ Cloud.
  Quand l'utilisateur modifie l'UI desktop, `npm run sync-app` re-copie
  + re-patche le cloud → zéro divergence.
- **Implémentation** :
  - `cloud/public/app/index.html` (copié), `index2.js` (12k lignes copiées),
    `styles/main.css + index2.css`, `lib/Viewer3D.js`, `lib/three.module.js`
  - `cloud/public/app/meshyAPI-cloud.js` : shim qui mappe les 115 IPC desktop.
    15 implémentés (imageTo3D, listProjects, getConfig, importImage,
    saveBuffer, etc.), 100 stubs gracieux (`NOT_AVAIL` retourne un objet
    avec `cloudUnavailable: true`).
  - `cloud/scripts/sync-app.mjs` : re-copie depuis `src/renderer/` +
    réapplique les patches (CSP relax, importmap → CDN unpkg three@0.170.0,
    inject shim, skip test_api_client).
  - `cloud/next.config.mjs` : rewrites `/app` et `/app/` → `/app/index.html`.
  - `cloud/src/app/page.tsx` : root route → redirect `/app/` si logué,
    sinon page de login + lien vers site officiel.
  - Routes API ajoutées : `/api/me`, `/api/projects`, `/api/projects/delete`.
  - Suppression du scaffold React custom (`/generate`, `/project`).
- **NE MODIFIE PAS** `src/renderer/`. La version desktop reste 100 % intacte
  (fichiers cloud sont des COPIES dans `cloud/public/app/`).
- Build OK : 16 routes, 0 erreur TS. Dev server `next dev -p 3030` tourne,
  `/app/` répond 200 et sert le HTML du renderer.

### Soir 2 (2026-05-23) — Redesign + mode MOCK + Supabase CLI auto

- **Mode MOCK opérationnel** : `cloud/src/lib/mock-store.ts` (in-memory store
  persistent via `globalThis`), routes `/api/mock-login`, `/api/mock-logout`,
  `/api/mock-checkout`, fallback dans `lib/auth.ts` + UI flags
  `NEXT_PUBLIC_MOCK=1`. Sample GLB (POC voiture, 5.3 MB) copié dans
  `cloud/public/mock/sample.glb` pour servir de mesh fake en mode dev.
  Permet de tester tout le flow user (signin → upload image → "génération"
  → viewer 3D → historique → "achat" crédits) sans Supabase ni Stripe.

- **REDESIGN COMPLET** pour matcher le design system du Desktop (`src/renderer/styles/index2.css`) :
  - Tokens : `--bg-0..3` (nuances de navy), `--accent` violet `#a855f7`,
    `--accent-2` rouge framboise `#e94560`, gradient combiné.
  - Topbar identique : brand "MyFabmesh<span>.AI</span>" + badge CLOUD +
    credits-pill arrondi, links nav avec hover bg-3.
  - `.primary-btn` (gradient + shadow violet), `.ghost-btn` (transparent
    border-strong), `.icon-btn` (32x32) — mêmes styles que desktop.
  - **Home logged-in = projects grid** (cards 220×240 avec thumb model-viewer
    auto-rotate, name, meta, progress bar 3-steps colorée), reprenant
    structure `<article class="project-card">` du desktop.
  - **Home logged-out = landing** avec hero + features + pricing cards.
  - **/generate = workspace 3-steps verticaux** : step-card avec header
    (badge numéroté + titre + status), step 1 = drop-zone image,
    step 2 = asset config (mode-picker tabs lite/standard/full + options),
    step 3 = result viewer. Désactivation visuelle (`opacity: .55`) des
    steps non encore accessibles.
  - **/project/[id]** : vue détail d'une génération existante (config +
    mesh viewer + download), 3 step-cards récap.

- **Auto-provisioning Supabase via CLI** : `cloud/scripts/supabase-setup.mjs`.
  L'user crée 1 PAT sur https://supabase.com/dashboard/account/tokens et
  le colle. Le script fait :
  `supabase login --token …` → `orgs list` → `projects create
  myfabmesh-cloud --org-id … --region eu-west-3 --db-password <gen>` →
  attend 2 min provisioning → `projects api-keys` → init `supabase/`
  dir avec migration depuis `cloud/sql/schema.sql` → `supabase link` →
  `supabase db push` → réécrit `.env.local` avec MOCK=0 + vraies clés
  Supabase + token Replicate auto-importé depuis `build/replicate-token.txt`.

- `cloud/scripts/setup-prod.ps1` : wizard PowerShell pour les services
  qui n'ont pas d'API publique de provisioning (Stripe + R2 + Cloudflare).

- `cloud/GOING_LIVE.md` : checklist des 5 actions humaines obligatoires
  (créer comptes Supabase/Stripe/Cloudflare, KYC, Docker pour cog push).

- `cloud/build` : 15 routes (12 pages + 3 mock-*  routes), build production
  OK, 0 erreur TS.

### Soir 1 (plus haut dans ce log) — POC + scaffold initial

- POC Replicate via `scripts/cloud_poc.py` : appel `fishwowater/trellis2`
  (TRELLIS.2-4B vanilla) avec une image test pour valider le SDK
  Python + le token + le crédit. Confirmé que TRELLIS-2 EST déployé
  sur Replicate par un tiers — bon signe pour la stratégie.
  → POC réussi en 481 s pour $0.33 sur A100 80GB (overpriced, cf ci-dessous).
  → Mesh GLB visualisé via viewer HTML local (file:// bloque le fetch,
  serveur HTTP local sur port 8765 contourne le problème) : voiture
  reconnaissable mais qualité moyenne (aileron déformé, jointures
  bosselées) — confirme que TRELLIS-2 seul ≠ produit fini, donc notre
  pipeline (rectify + back-view + smooth) doit ajouter une vraie valeur.
- `build/CLOUD_PRICING.md` créé : grille GPU Replicate, comparatif
  L40S vs A100 vs H100. Insight : **L40S = -48% vs A100 mais 10-15%
  plus lent ; H100 = même coût final que L40S mais 1.8× plus rapide**
  → stratégie produit "Fast mode H100 +1 crédit" pour la latence
  perçue, L40S par défaut pour le coût.
- Phase B (Cog) terminée côté code : `cog/predict.py` refactorisé en
  subprocess (scripts CLI-only, pas importables), `cog.yaml` documente
  le choix L40S dans le dashboard Replicate post-push.
- Phase C (frontend Next.js) scaffold complet sous `cloud/` :
  - App Router 15.0.4 + React 19, build OK (12 pages + 4 API routes).
  - Pages : `/` (landing), `/generate` (form + viewer 3D model-viewer),
    `/buy` (3 packs Stripe), `/account` (solde + historique + paiements),
    `/login` (Supabase magic-link), `/auth/callback`.
  - API : `/api/generate` (FormData → Replicate prediction + spend_credits),
    `/api/jobs/[id]` (poll Replicate + upload GLB R2 + refund on fail),
    `/api/checkout` (Stripe Checkout session), `/api/stripe-webhook`
    (verify signature + idempotent add_credits).
  - Lib : `supabase.ts` (SSR + admin), `auth.ts` (RPC spend/add),
    `replicate.ts` (dual schema: notre Cog OR fishwowater fallback),
    `r2.ts` (SigV4 inline, pas de @aws-sdk de 15 MB),
    `stripe.ts` (PACKS Starter/Pro/Studio).
  - SQL : `cloud/sql/schema.sql` — profiles + jobs + payments + RLS +
    RPCs atomiques `spend_credits`/`add_credits` (security definer,
    grant à service_role seulement). Pas de free credits.
  - README explique setup Supabase + Stripe + R2 + Replicate + deploy
    Cloudflare Pages via `@cloudflare/next-on-pages`.
- Token Replicate sauvé dans `build/replicate-token.txt` (gitignored,
  comme HF token et Sentry DSN). $5 de credit ajouté sur Replicate
  avec auto-reload OFF.

État au coucher 2026-05-23 :
- Code 100% écrit côté Cloud (build local OK).
- Actions externes pending : créer projet Supabase + run schema.sql,
  créer compte Stripe (test mode), créer bucket R2, push Cog (WSL+Docker),
  déployer Cloudflare Pages.

---

## 2026-05-22 (ship-ready UX + launch kit)

Trois lots successifs ce soir :

1. electron-updater wired vers GitHub Releases (auto-check 30s post-launch,
   delta download, toast UI). `publish` config dans package.json.
2. Site web : badge BETA dans le header, section "Latest release" qui
   pull la GitHub API au load. Updater toast top-right dans l'app +
   modal "About" avec version live, check-update bouton, liens
   externes whitelisted.
3. Launch kit : `build/LAUNCH_KIT.md` (textes Reddit / Twitter /
   Show HN / Product Hunt / Discord / email YouTuber prêts à
   copier-coller, timeline T-3 → T+7). `docs/og-image.png` 1200×630
   généré (PIL) + meta og:/twitter: dans `docs/index.html` pour les
   previews automatiques sur réseaux sociaux.

L'installer v1.0.0-beta sur la GitHub Release contient déjà tous
ces fix. Reste les 3 actions utilisateur : test machine vierge,
listings Gumroad + itch.io (guide dans `build/LISTINGS_GUIDE.md`),
posts launch (textes dans `build/LAUNCH_KIT.md`).

---

## 2026-05-22 (Sentry + ship readiness doc)

- Installed `@sentry/electron` 7.13.0.
- Main process: `_initSentry()` reads DSN from
  `build/sentry-dsn.txt` (gitignored) or `$SENTRY_DSN`. Silent
  no-op when missing — dev box works without it.
- Preload: `@sentry/electron/renderer` attached so uncaught errors
  + unhandled promise rejections from both `wizard.html` and
  `index2.html` flow to Sentry automatically.
- Privacy: `beforeSend` strips Windows username + machine name
  from breadcrumbs.
- `build/READY_TO_SHIP.md` written with the 3 zero-cost beta blockers:
  HF read-only token → `wizard_download.py:32`, Sentry DSN → `build/sentry-dsn.txt`,
  test matrix on a clean Win 11 VM / friend's PC.

---

## 2026-05-22 (landing polish + dev section refactor)

- Landing page : alignement strict des cards Desktop / Cloud après
  l'ajout de la 6e feature "Scriptable from Claude Code / VS Code (MCP)".
  Solution : `min-height: 240px` sur `.card-features` (vs flex-grow
  qui poussait les requirements de Cloud trop bas). Buttons des 2
  cards alignés au pixel près désormais.
- "For developers" section refactorisée en 3 cards chaînées
  (💬 Claude Code → 🪞 MyFabmesh.AI → 🎮 Unreal Engine) avec card
  centrale en accent gradient. Plus simple, plus design que les
  2 mock chat blocks précédents.
- Hero : retiré le bouton "Check my PC compatibility" redondant
  (déjà accessible depuis Desktop card et footer de la section
  Products). 1 seul CTA "Choose your plan".
- Smooth scroll natif (`scroll-behavior: smooth` sur `<html>`) +
  `scroll-margin-top: 90px` pour que les H2 atterrissent sous le
  sticky header au lieu d'être cachés.
- Cache-buster `styles.css?v=3` pour éviter le pinning Cloudflare/CDN
  des anciennes versions du CSS.
- MCP / Claude Code / VS Code mis en avant comme différenciateur
  principal du produit (3 emplacements : feature list, section
  dédiée, FAQ). Workflow Unreal + Claude + MyFabmesh.AI démontré
  comme chaîne MCP end-to-end.

---

## 2026-05-22 (rebrand audit + filter-repo cleanup)

- **History rewrite** : repo entier devait être push sur GitHub. Bloqué
  par 3 fichiers > 100 MB committés dans l'historique (`logs/fabmesh.log.1`
  727 MB, `.log.2` 556 MB, `.log.3` 556 MB) + 5 autres > 50 MB
  (PLY voxels, JSON debug). Solution : `git filter-repo
  --strip-blobs-bigger-than 50M --force`. 2597 blobs scannés, repo
  passé de ~1.5 GB à ~200 MB en historique. Force-push réussi avec
  `http.postBuffer=524288000`.
- **GitHub Pages** activé via `gh api -X POST repos/.../pages` avec
  `source[path]=/docs`. Le `/website` n'est PAS supporté par GitHub
  Pages (seulement `/` ou `/docs`) → renommé `website/` → `docs/`,
  fusionné avec les .md techniques existants.
- **Site live** : https://fabienlacaze.github.io/FabMesh/ .
- **Audit visibilité** : agent dédié a remonté ~50 strings user-visible
  contenant "FabMesh" ou "MeshyMyself" + leaks Python (`print('[SDXL]')`,
  `print('[back-view] ControlNet OpenPose + RealVisXL + IPAdapter')`,
  etc.) forwardés au renderer via `ai3d-progress`.

**Patches appliqués** (toutes les strings user-visible → MyFabmesh.AI) :
- `src/renderer/wizard.html` + `wizard.js` + `wizard.css` (ajout .brand-ai)
- `src/renderer/index2.html` + `index2.js` + `styles/index2.css` (ajout .brand-ai)
- `src/main/main.js` : title, Notification default, WIZARD_MODELS labels
- `src/main/main.js:safeSend()` : **filtre _filterSensitive()** appliqué
  sur les channels user-visible (ai3d-progress, calib-progress,
  wizard:test-log, wizard:install-progress, log:line, mcp-stderr).
  ~30 regex remplacent les model IDs HF (`microsoft/TRELLIS.2-4B`,
  `SG161222/RealVisXL_V4.0`, etc.) + noms produits (TRELLIS, RealVis,
  SDXL, ControlNet, IPAdapter, Florence, BLIP, Real-ESRGAN, MV-Adapter,
  Hi3DGen, SF3D, TripoSR, Stable Fast 3D) → labels brandés (MyFabmesh.AI
  3D Core, Texture engine, Face refiner, etc.).
- `package.json` : `name=myfabmesh-ai`, `appId=ai.myfabmesh.desktop`,
  `productName=MyFabmesh.AI`, `shortcutName/uninstallDisplayName/artifactName`.
- `build/uninstaller.nsh` : 3 strings NSIS uninstaller.
- `LICENSE.txt` + `EULA.txt` : ~18 occurrences, retiré mention
  `"MeshyMyself"` au passage.
- `src/renderer/index2.js:9828` : path absolu hardcodé
  `c:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/...` retiré, remplacé
  par chemin relatif via `window.fabmeshConfig.calibBase` (fallback).
- `scripts/cleanup_assets.py` : path dev `Desktop/FabWare/MeshyMyself`
  retiré, scan relatif au script à la place.

Non corrigé (Niveau 2, à faire avant push public propre) :
- Repo GitHub `fabienlacaze/FabMesh` → renommer `fabienlacaze/MyFabmesh`
  (gh repo rename) puis update URL dans `docs/index.html:185`
- Branches `backup-*` (45+) à pruner (cosmétique)
- Commit messages historiques contiennent "FabMesh" (laissé tel quel)
- Commentaires Python (Niveau 3, jamais affichés au user)

---

## 2026-05-22 (public website skeleton)

Site statique zéro-budget pour MyFabmesh.AI prêt à pousser sur
GitHub Pages :

- `website/index.html` — landing avec 2 cards (Desktop / Cloud) côte à
  côte, section "How it works" en 3 étapes, FAQ 6 questions, footer.
- `website/check.html` + `check.js` + `gpu-database.js` —
  compatibility checker browser-based. Détecte OS, GPU vendor + modèle
  via WebGL UNMASKED_RENDERER_WEBGL, lookup VRAM dans la DB locale
  (~100 GPU NVIDIA/AMD/Intel les plus communs sur Steam HW Survey).
  Verdict en 1 sec : Full / Standard / Lite / Cloud + CTA approprié.
- `website/styles.css` — réutilise le design system de l'app desktop
  (bg-0/bg-1, accent-grad rouge→violet, mêmes radii). Le user qui
  arrive du site reconnaît visuellement le produit dans l'app.
- `website/favicon.png` — placeholder (M en accent rouge).
- `website/README.md` — procédure exacte pour activer GitHub Pages
  en 3 clics (Settings → Pages → Branch=master + Folder=/website).
  Live à `https://fabienlacaze.github.io/FabMesh/`.

Coût : 0 €. Stack : HTML + CSS + JS pur, zéro build, zéro framework.
Plus tard, le custom domain `myfabmesh.ai` (~70€/an) se branche via
CNAME + fichier `website/CNAME`.

---

## 2026-05-22 (branding + zero-budget plan)

Renommage et stratégie financière :

- **Brand** = `MyFabmesh.AI` (le `.AI` fait partie du nom marketing).
  `fabmesh.com` était squatté à 9985$ — ignoré. Tous les `myfabmesh.*`
  TLDs sont libres (.com .io .app .ai .fr).
- **Plan 0 €** ajouté dans `ROADMAP.md` : chaque dépense est gated
  par un palier de ventes. Avant 1ère vente = 0 €.
  - Hosting Vercel/itch/GitHub : gratuit
  - Distribution itch.io + Gumroad + Fab.com : 0 € setup, 10-12% sur ventes
  - Domain `myfabmesh.ai` (70€) : dès 30 ventes (~660 € revenu)
  - Code signing (200€/an) : dès 15 ventes (~330 € revenu)
  - INPI (190€) : dès 50 ventes (~1100 € revenu)
- Workaround Windows Defender sans signature : FAQ + vidéo + "Run anyway".
  SmartScreen apprend après ~3000 DLs et la warning disparaît seule.
- **Wheels custom** déplacés en Phase 2 : Phase 1 utilise les wheels
  officiels (PyTorch CUDA 12.8, PyPI, Dao-AILab GitHub Releases). Pas
  besoin de Cloudflare R2 ni de build sur GH Actions au démarrage.
- `SHIPPING_CHECKLIST.md` mis à jour avec ces changements.

---

## 2026-05-22 (wizard v2 + packaging skeleton)

Suite du wizard d'installation. Plusieurs corrections + tout l'échafaudage
de packaging Windows pour que l'app marche sur un PC vierge (pas juste
sur la machine dev).

**Wizard v2 corrections** (commits multiples sur master 50f79af + suivants):
- Bouton "Cancel" en haut à droite. Labellé "Quit" en first-run
  (quitte l'app) ou "Cancel" en mode Reconfigure (restore le state via
  un backup `setup_state.json.backup`).
- "Reconfigure FabMesh" dans Settings (index2 → `set-reconfigure`) qui
  reload le wizard avec backup pour cancel-safe.
- "Uninstall FabMesh" dans Settings — lance le NSIS uninstaller en
  build packagé, affiche warning en dev mode.
- Anonymisation des noms de modèles dans l'UI (FabMesh 3D Core,
  Texture engine, Face refiner, Vision analyzer, Upscale engine au
  lieu de TRELLIS-2 / RealVisXL / BLIP-1 / Florence-2 / Real-ESRGAN).
- Smoke test stdout filtré (seules les lignes `[smoke]` visibles, le
  stderr est bufferisé et n'apparaît qu'en cas d'échec).
- Bandwidth retiré du System check (test peu fiable + pas utile à ce
  stade, le vrai débit se mesure pendant le Download).
- Couleurs vert/orange/rouge sur les valeurs détectées (bug fix:
  `el.className = 'val '` au lieu de `'wiz-val '`).
- Pas de border vert sur "Recommended" — un badge accent gradient à
  la place pour rester dans le design system.
- Fenêtre maximisée au démarrage (`mainWindow.maximize()`).
- "Cloud only" retiré de la page Mode — si pas de GPU NVIDIA, le
  wizard saute la page Mode et affiche un écran dédié "No compatible
  GPU" qui redirige vers fabmesh.com/cloud.
- Seuil Full descendu de 16384 à 15360 MB pour les "16 GB cards"
  (RTX 4080/5080) qui reportent ~16300 MB après driver overhead.
- Heartbeat download (`scripts/wizard_download.py`) : un thread parallèle
  scanne le cache HF disque toutes les 1s pendant que
  `snapshot_download` bloque, calcule pct + speed + ETA réels.
- UI download : timer écoulé en violet + animation pulse sur la bar
  in-progress + state `done` static vert.
- Fenêtre du wizard fermable même pendant download (avant le close
  handler bloquait sur l'IPC du renderer, qui n'existe pas côté wizard).

**Packaging skeleton (NEW)** :
- `package.json` configuré pour electron-builder NSIS : per-user
  install, raccourcis Bureau + menu Démarrer, uninstaller propre,
  artifactName `FabMesh-Setup-${version}.exe`.
- `build/uninstaller.nsh` : hook NSIS qui propose de supprimer le
  cache HF (~17 GB) et les settings AppData pendant la désinstall
  (cases décochées par défaut — l'user peut réinstaller sans re-DL).
- `build/fetch_python_embed.py` : télécharge Python 3.11.9 embeddable
  (~30 MB) avec SHA-256 pinné + active site-packages. À lancer une
  fois sur la machine dev avant le packaging.
- `build/fetch_vc_redist.py` : télécharge VC++ 2022 Redistributable
  (~25 MB) à bundler dans l'installer.
- `build/build_wheels.md` : doc pour compiler les wheels custom
  (torch+cu128, flash_attn, kaolin, xformers) sur GitHub Actions
  Windows + CUDA et les pousser sur Cloudflare R2.
- `scripts/wizard_install_deps.py` : nouveau script appelé par le
  wizard pour bootstrap pip dans le Python embarqué + installer les
  wheels depuis `wheels.fabmesh.com` (CDN) + diffusers/transformers
  depuis PyPI. JSONL progress sur stdout.
- `scripts/cleanup_assets.py` : CLI utilitaire pour effacer le cache
  HF / settings AppData / logs sans désinstaller (gain disque).
- `.gitignore` mis à jour : `build/python-embed/`, `vc_redist.x64.exe`,
  `dist/` ne sont jamais committés (re-téléchargeables avec SHA pinné).

**Pour shipper un installer fonctionnel** il reste à :
1. Lancer `python build/fetch_python_embed.py` une fois
2. Lancer `python build/fetch_vc_redist.py` une fois (et pinner le sha)
3. Compiler les wheels custom sur GH Actions (voir build_wheels.md) et
   les pousser sur Cloudflare R2 + setup `wheels.fabmesh.com`
4. Acheter un code signing certificate Sectigo (~200€/an)
5. `npm install electron-builder` puis `npm run build:installer`
6. Tester sur 8 machines variées

---

## 2026-05-21 (wizard v1) — First-run setup wizard

Première brique de la stratégie "installer bulletproof" : un wizard
5 étapes qui démarre au tout premier lancement et garantit que
l'app fonctionne avant de la passer à l'user.

**Étapes** : Welcome → Detect (hw scan) → Mode (full/standard/lite/cloud)
→ Download (modèles via HF + Real-ESRGAN) → Test (smoke test CUDA).

**Files ajoutés** :
- `src/renderer/wizard.html` + `wizard.css` + `wizard.js` — UI 5 steps.
- `scripts/hw_detect.py` — détection GPU (nvidia-smi + wmic AMD/Intel),
  VRAM, driver NVIDIA, RAM, disk, bandwidth HuggingFace.
- `scripts/wizard_download.py` — snapshot_download HF avec resume +
  cache partagé, streaming JSONL progress.
- `scripts/wizard_smoke_test.py` — checks CUDA / diffusers / BLIP cache
  en ~5s sans charger les gros pipes.

**Files modifiés** :
- `src/main/main.js` — `isSetupComplete()` + route entre `wizard.html`
  et `index2.html` selon `userData/setup_state.json`. 5 IPC handlers
  `wizard:*` (detect-hardware / download-plan / start-download /
  final-test / complete).
- `src/main/preload.js` — `window.wizardAPI` exposé au renderer wizard.

**Test sur RTX 5080** : detection ~10s (warning bandwidth 0 — l'URL
HF de test ne répond pas tout le temps, non-bloquant). Smoke test
réussit en 4.9s. Mode auto-recommandé "standard" pour VRAM 16303 MB
(juste sous le seuil 16384 du mode full — comportement attendu, marge
de sécurité).

**Reste à faire** (prochaines étapes wizard) :
- electron-builder NSIS config pour packager l'installer `.exe`
- VC++ 2022 redist bundled
- Sentry crash reporting
- Tests sur 8 machines variées
- Code signing certificate Sectigo (~200€/an)

---

## 2026-05-21 (later 2) — Audit-2 fixes

Re-audit du logiciel a remonté 3 nouveaux CRITIQUE + 3 HAUT + 2 MOYEN,
tous fixés. Backup branch `backup-pre-audit2-fixes-20260521-225748`.

**CRITIQUE 1 — `caption_image.py` BLIP-2 OPT supprimé**
Le fallback chargeait `Salesforce/blip2-opt-2.7b` (embarque Meta OPT-2.7B,
licence NC research-only). Réécrit pour utiliser uniquement BLIP-1
(BSD-3) + cleanup VRAM (`del model, proc; empty_cache()`). Docstring
corrigée pour refléter la stack réelle.

**CRITIQUE 2 — TripoSR `engine='local'` rerouté**
`stabilityai/TripoSR` = Stability AI Community License (NC > $1M, même
clause que SF3D). Ajouté un guard dans `main.js:3656` qui détecte
`engine='local'` et reroute vers `trellis2_native` + warn. Labels de
l'UI mis à jour pour refléter le reroute ("rerouted from TripoSR, NC
license") au lieu du faux "TripoSR (CC0)".

**CRITIQUE 3 — Florence-2 `revision` pin**
`trust_remote_code=True` exécutait du Python hébergé sur HF à chaque
chargement. Si compte microsoft/Florence-2-large compromis ou
DNS-spoofed → RCE chez tous les users. Pin revision
`21a599d414c4d928c9032694c424fb94458e3594` (SHA exact de la version
locale auditée, lu depuis `~/.cache/huggingface/...`).

**HAUT 1 — Python `-c` interpolation → `sys.argv`**
`handleRemoveBackground` (`main.js:910`) et `check-image-nsfw`
(`main.js:1214`) interpolaient `r"${imagePath}"` dans du code Python.
Un filename contenant `"` cassait out du string literal → exécution
arbitraire. Passé par `sys.argv` (le pattern déjà utilisé par
`_silhouetteHash`).

**HAUT 2 — MCP bridge HTTP gated par Bearer token**
Le bridge `127.0.0.1:7555` acceptait n'importe quel POST localement →
n'importe quel malware ou onglet browser pouvait dispatcher generation
/ OOM / écriture sur disque. Ajouté `.mcp_bridge_token` (32 bytes
hex, mode 0600, gitignored) lu par `mcp_server.py` qui l'envoie en
`Authorization: Bearer <token>` à chaque requête. Token régénéré au
démarrage Electron si absent.

**HAUT 3 — Gitlinks fantômes nettoyés**
`external/Hi3DGen`, `StableFast3D`, `UniRig` étaient committés en mode
`160000` (gitlink) sans `.gitmodules` entry → `git status` les voyait
en "modified content" pour l'éternité. `git rm --cached` les trois +
ajout au `.gitignore`. Plus de pollution status.

**MOYEN — Post-process chain error propagation**
La chaîne `runSmooth → runFaceFix → runUpscale` log un warn en cas
d'échec mais résolvait `success: true` au renderer. Refactor en
`runStep(label, script, args, timeout, next)` générique qui accumule
les failures dans `postProcessErrors[]`, surface dans la résolution
finale + envoyé en `ai3d-progress` au renderer pour affichage.

**INFO — Commentaires stale SF3D/TripoSR**
`main.js:3390` ("default: Stable Fast 3D") et `main.js:3645` ("supports
TripoSR, Stable Fast 3D, TripoSG, TRELLIS") corrigés pour refléter
l'état post-retire.

Non bloquant restant : IPC handlers orphelins (`imageToTrellis`,
`generateFromImage`, `generateFromPrompt`) — pas un risque, juste du
code mort. À nettoyer un jour.

---

## 2026-05-21 (later) — Audit fixes

Audit complet du logiciel a remonté 3 prio + 4 mineurs. Tous fixés
sur backup branch `backup-pre-audit-fixes-20260521-224130`.

**P1 — SF3D retiré** (licence Stability AI Community = NC > $1M, pas
commercial-safe pour Steam/Fab). Retiré du selector `index2.html:298`,
fallback dans `main.js` rerouté vers `trellis2_native`. SF3D=='engine'
explicit dans une request legacy logge un warn et reroute.

**P2 — VRAM cleanup** dans `face_inpaint_atlas.py` (del pipe +
empty_cache après SDXL inpaint, ~6 GB libérés) et `texture_upscale.py`
(del upsampler, model, ~2 GB libérés). Évite l'OOM RTX 5080 quand on
enchaine Face Fix + Ultra HD.

**P3 — Submodules** : `.gitmodules` listait `external/CRM` (n'existe
plus) et `external/MV-Adapter` (jamais `git add`). Aligné sur le
pattern des autres externals (clone-on-first-run, non-committé) —
fichier vidé + `external/MV-Adapter/` ajouté au `.gitignore`.

**Bugs mineurs** :
- `face_inpaint_atlas.py:projection`: bbox vertex→screen suppose mesh
  dans `[-0.5, 0.5]`. Remplacé par normalisation explicite via mesh
  bounding-box → fonctionne quelle que soit l'échelle du GLB.
- `face_inpaint_atlas.py:main`: ajouté `assert input_abs != output_abs`
  (sortie code 2) pour éviter le foot-gun d'un overwrite en place.
- `face_inpaint_atlas.py:docstring`: doc disait MediaPipe, le code
  utilise OpenCV Haar — corrigé.
- `texture_upscale.py:weights`: ajouté SHA-256 pin pour
  `RealESRGAN_x4plus.pth` (hash réel calculé sur la copie locale,
  vérifié 4fa0d389...). Refuse de charger un .pth altéré (.pth = pickle
  Python = RCE potentielle). `x2plus` hash TODO (skip + WARN si jamais
  téléchargé).
- `generate_back_view.py:45`: import `_make_back_skeleton` cassait si
  CWD ≠ `scripts/`. Ajouté `sys.path.insert(0, _script_dir)` avant
  l'import.

Non-bloquant restant : 45 branches `backup-*` locales à nettoyer un
jour, et les submodules-non-vrais (Hi3DGen/UniRig/StableFast3D) qui
sortent en "modified content" sur `git status` à cause de venvs locaux
— pas committable, pas un soucis fonctionnel.

---

## 2026-05-21 — Option D: SDXL face inpaint on baseColor atlas

User asked for option D after option A (1536_cascade): SDXL face inpaint
on the baseColor atlas to fix "creepy" / blurry faces that TRELLIS-2
produces on children, even at 1536 voxel res.

**Script**: `scripts/face_inpaint_atlas.py`
1. Render the mesh from a front orthographic camera via pyrender (MIT).
2. Detect face bbox in the render — OpenCV Haar Cascade (BSD, bundled
   with opencv-python) — chosen over MediaPipe because mediapipe 0.10.33
   removed the `mp.solutions` API (now `mp.tasks` requires a .tflite
   asset download, not commercial-safe out of the box).
3. Project face bbox screen-space → UV atlas via per-triangle painting.
4. Downscale atlas to SDXL native 1024² for inpaint, then upscale back
   to source res and **composite using the mask** so non-face pixels
   stay byte-identical to the input atlas. Avoids the
   `tensor a (4096) vs b (512)` error that hits if we naively pass a
   4K atlas with `height=4096, width=4096` to SDXL inpaint.
5. RealVisXL_V4.0 inpaint (RAIL++-M) with negatives
   `deformed, asymmetric, creepy, blurry, extra eyes, doll face,
   uncanny valley`. Strength 0.45 default.

**Wired** into the TRELLIS-2 advanced panel as
`Face fix (SDXL inpaint on face zone, +~60s)` checkbox, between
`Ultra HD 8K` and `Ultra Quality`. Chain order:
`runSmooth → runFaceFix → runUpscale` (face fix runs on the source-res
atlas BEFORE Real-ESRGAN, so the inpaint stays on 4K not 8K — cheaper).

---

## 2026-05-20 (back-view v3) — Florence-2 + face cleanup + face mask = real back

Iteration 3 (final) on the back-view, on top of multi-seed auto-pick (83d6a88):

**1. Florence-2 replaces BLIP-1 for outfit/hair captioning**
- `microsoft/Florence-2-large` — MIT license, fully commercial-safe
  (not BLIP-2 which uses OPT/Meta-NC).
- Returns dense detailed captions including **hairstyle** which BLIP-1
  missed. Example: "She is wearing a light blue denim jacket over a
  white sports bra and light grey jeans. **Her hair is styled in loose
  waves**..." — that "loose waves" was the missing token that finally
  killed the persistent ponytail drift on back-view generations.

**Two transformers-4.56-era bugs fixed**:
- `'Florence2ForConditionalGeneration' object has no attribute '_supports_sdpa'`
  → loaded with `attn_implementation='eager'`.
- `'NoneType' object has no attribute 'shape'` (in `prepare_inputs_for_generation`,
  Florence-2 custom code expects pre-DynamicCache tuple format) →
  `model.config.use_cache = False` + `generate(use_cache=False)`.

**2. Aggressive caption cleanup**
- Florence-2 returns dense captions that include "she has a serious
  expression on her face" / "looking at the camera" which then push
  SDXL toward a frontal pose, defeating the ControlNet back skeleton.
- New regex sweep strips: face-phrases (`her face`, `expression`,
  `looking at the camera`), scene noise (`background is`, `studio
  lighting`), and posture verbs.
- Cap output at 200 chars so the "back view" cue at the end of the
  prompt stays dominant.

**3. Face-region mask on IPAdapter reference**
- IPAdapter Plus propagates the front face into the back generation,
  forcing SDXL to imagine a "back of head logically compatible with
  this front face" — typically resolving as a ponytail even when the
  front shows loose hair.
- Mask top 18% of the ref image as solid black with a soft fade to
  30% Y, before passing to `ip_adapter_image=`. IPAdapter then only
  anchors the outfit (chest+lower body), and SDXL is free to use
  Florence-2's "loose waves" caption for the nuque.

**Visual validation on the woman test** (woman/ref_0.png — denim jacket,
white sports bra, light grey cargo jeans, loose wavy hair):
- v1 multi-seed only (83d6a88) : triangular jacket cutout, ponytail.
- v2 + face mask : cutout gone, still ponytail.
- v3 + Florence-2 (first try) : back regressed to a front because
  "expression on her face" was in the caption.
- v3 + Florence-2 + cleanup (face stripped) : **real back, denim
  jacket clean, cargo pockets visible from behind, loose wavy hair**.
  User confirmed visually.

Stages 1+2+3 are the new default in `generate_back_view.py`. BLIP-1
remains as a fallback if Florence-2 fails to load.

---

## 2026-05-20 (back-view multi-seed) — BLIP clean + 4 candidates auto-pick

Iteration 2 on the back-view consistency, on top of the BLIP-1 single
caption (commit bc9f1a7):

1. **BLIP output cleanup** : strip BLIP's scene-context noise
   ("is posing for a picture", "stands in a studio", "with arms out",
   etc) via a regex pass. The dominant garment words at the start
   of the caption become the entire prompt addition.
   Example: BLIP-1 returned `"white pants and a denim shirt is posing
   for a picture"` → cleaned to `"white pants and a denim shirt"`.

2. **Multi-seed with auto-pick** : generate 4 candidate back-views with
   different seeds, score each by HSV color-histogram intersection in
   the lower-body region (40-90% Y) vs the mirrored front, keep the
   highest score. Tuned via `FABMESH_BACK_N_CANDIDATES` env var
   (default 4).
   Validated on the woman test: best-of-4 eliminated the triangular
   jacket cutout artifact that single-seed kept producing, and the
   ponytail came out more natural.

Cost: ~80s extra per back-view (4 inferences instead of 1) but no
user intervention required to pick the good one.

Failed sub-experiments same day (not shipped):
- Side view (90°) test : without a side OpenPose skeleton, ControlNet
  back-skeleton + "side view" prompt + low ip_scale produced near-front
  views. Building a side skeleton is too much work for the limited
  prod use.
- Hybrid back (mirror + img2img + ControlNet) : strength=0.55 was
  dominated by the mirrored base, returned essentially a front. Would
  need strength≥0.75 which negates the texture-preservation benefit.
  Script stays in repo (`generate_back_view_hybrid.py`) for future
  experiments but not wired.

---

## 2026-05-20 (back-view outfit drift) — BLIP-1 single caption best

Tested two BLIP captioning strategies to anchor the outfit description
in the back-view prompt and stop the front/back garment drift:

- **Single caption** with prefix `"a person wearing"` → BLIP returned
  e.g. `"white pants and a denim shirt"`. Injected into the prompt:
  `"a woman, wearing white pants and a denim shirt, same outfit, back view, from behind, …"`.
  Result: back-view kept the denim jacket + light cargo pants intact,
  real back pose, hairstyle drifted a bit (loose → ponytail).
- **Multi-aspect** (3 conditional captions: top / bottom / hair) →
  BLIP-1 prefixes don't isolate aspects well, `"hair is"` gave nonsense
  `"on the woman's head"`. Worse: concatenating the 3 strings dominated
  the prompt and the model regressed to a FRONT view (ControlNet OpenPose
  + "back view" cues drowned). Reverted.

**Conclusion**: BLIP-1 single caption is the sweet spot. Multi-aspect
needs a stronger VQA model (Florence-2 MIT would be a candidate but
adds a new dep). Shelving multi-aspect for now.

**License note**: stayed on BLIP-1 (BSD 3-Clause, commercial-safe).
BLIP-2 was started initially but its default OPT backbone is Meta
OPT (non-commercial), incompatible with FabMesh's commercial rule.

---

## 2026-05-20 (dispatch rewiring) — back-view + auto-rectify source by assetType

**Back-view IPC** (`generate-back-view` in `src/main/main.js`) :
- Old dispatch (since MV-Adapter was broken) : everything except
  `character` fell through to `sheet` mode (RealVisXL 2x2 grid).
- New dispatch (now that MV-Adapter is fixed via commit 9df9900) :
  - `character` → `realvis` (RealVis + ControlNet OpenPose humanoid skeleton)
  - `creature` / `animal` → `mvadapter` (Apache 2.0 multi-view model,
    works great on organic non-humans)
  - everything else (vehicle, building, weapon, prop...) → `sheet`
    (MV-Adapter has documented training-set bias against vehicles,
    sheet stays the safe fallback for hard-surface assets)
- Explicit `mode='mvadapter'` requests on non-organic asset types
  auto-downgrade to `sheet` with a log warning.

**Image-to-3D pre-process** (`image-to-3d` IPC) :
- New checkbox "Auto-rectify source view" (checked by default) calls
  `scripts/generate_front_strict.py` on the user's source image
  *before* the mesh pipeline. Dispatch by `assetType`:
  - `character` → `--mode front` (strict orthographic, symmetric T-pose)
  - everything else → `--mode iso` (3/4 with depth axis visible,
    proven to yield much better mesh proportions on vehicles —
    see commit 2bbdc5a).
- Saves the rectified image next to the source as `<stem>_rectified.png`.
- Falls back silently to the original source if rectify fails.
- Only runs for TRELLIS-2-based engines (`trellis2_native`, `hi3dgen`)
  — other engines have their own source-view assumptions.

**UI** : the new checkbox sits above "Texture smooth" in the Advanced
TRELLIS-2 panel. All four checkboxes (rectify + smooth + quality+
+ ultra HD) are checked by default for users who just want the best
preset.

**Pipeline now fully wired end-to-end** :
  source image → [auto-rectify by assetType] → TRELLIS-2 cascade +
  decim 1M + tex 4096 → bilateral smooth → Real-ESRGAN 8K.
Default total ~12-13 min on RTX 5080 for the highest quality preset.

---

## 2026-05-20 (texture post-process) — smooth + upscale + quality+ wired in UI

**Context** : after the strict-front + iso modes shipped the previous
day, the user asked how Meshy achieves their "HD" texture quality. Web
research confirmed Meshy HD = **4096² baseColor + 2048² normal/roughness/
metallic** (docs.meshy.ai). Our TRELLIS-2 with `tex_res=4096` already
matches that natively; the goal of this session was to expose the
post-process levers in the UI so any project can opt-in without env vars.

**New scripts** :
- `scripts/texture_smooth.py` — OpenCV bilateral filter on the
  baseColor atlas. Edge-preserving, ~12s for 4096². Zero AI, zero
  hallucination. Best for smooth surfaces (paint, chrome, glass).
- `scripts/texture_upscale.py` — Real-ESRGAN x2 on the atlas
  (Apache 2.0). 2048→4096 in ~15s, 4096→8192 in ~275s (RTX 5080).
  Conservative upscaler, no invented content. Auto-downloads
  RealESRGAN_x4plus weights to `~/.cache/realesrgan_weights/`.

**Tested on `voiture_rouge/ref_0.png` (strict-front + iso modes)** :
- Bilateral smooth on the 4096² hires atlas : cleaner uniform paint,
  panel-gap edges preserved, GLB 72 MB → 62 MB.
- Real-ESRGAN x2 on the 4096² hires atlas → 8192² : sharper
  highlights and chrome detail, GLB 72 MB → 116 MB.

**UI integration** (`src/renderer/index2.html` + `index2.js` +
`src/main/main.js`) :
- 3 checkboxes in the "Advanced TRELLIS-2" details block, *all
  checked by default* :
  - "Texture smooth (+~12s, cleaner smooth surfaces, no AI)"
    → forwards `trellis2Smooth` → `main.js` chains
    `texture_smooth.py` after the mesh.
  - "Quality+ (cascade mode, decim 1M, +~30s)"
    → sets `FABMESH_TRELLIS2_NATIVE_MODE=1024_cascade` +
    `FABMESH_TRELLIS2_NATIVE_DECIM=1000000` in the subprocess env.
  - "Ultra HD 8K texture (+~5min, Real-ESRGAN)"
    → chains `texture_upscale.py --scale 2 --tile 512` after
    `texture_smooth` (so the 8k atlas is built from the cleaned
    4k atlas, not the noisy one).
- Post-processes run sequentially via callback chain in `main.js`
  `checkEarlyResolve`. Each step temp-writes a `.tmp.glb`, renames
  in place on success, falls through to "keep original" on failure
  so a crashed post-process never kills the user's mesh.

**Meshy parity comparison** (red car test) :
| Map | Meshy HD | Ours default | Ours Ultra HD |
|---|---|---|---|
| baseColor | 4096² | 4096² | **8192²** |
| Normal | 2048² | TRELLIS-2 native | TRELLIS-2 native |
| Roughness | 2048² | TRELLIS-2 native | TRELLIS-2 native |
| Metallic | 2048² | TRELLIS-2 native | TRELLIS-2 native |

→ We match Meshy HD by default and exceed it with Ultra HD on.

**Known limitation** :
- SDXL Tile Refine (`texture_refine.py`, separate checkbox) still
  hallucinates wear on smooth surfaces. The new `texture_smooth` is
  the safer choice for vehicles. See
  [feedback_texture_refine_scope] memory note.
- `generate_front_strict.py --mode iso` is NOT yet auto-dispatched
  by `assetType` in the image generation flow. User must call it
  manually for now. Deferred to a separate session.

---

## 2026-05-19 (front-strict --mode iso) — ISO 3/4 source produces better mesh proportions than strict-front on vehicles

**Finding** : on the red car single-shot mesh from a strict-front source,
TRELLIS-2 produced a trapu/compact body — proportions of a Goggomobil /
Honda S600 instead of the sleek coupé in the source image. The cause :
a strict orthographic front has *zero* depth cue, so the model has no
way to know how long the car actually is. It defaults to the
training-set "average compact" silhouette.

**Fix** : `generate_front_strict.py` now has a `--mode iso` variant.
Generates a 3/4 ISO angle (azim ~35°, elev ~25°) where the depth axis
is visible, so the model can infer length. The seed selector flips
to scoring *asymmetry* (1 - symmetry IoU, capped at 0.85 so we
don't pick a full profile by accident).

Validated visually on `images/voiture_rouge/ref_0.png` :
- Strict-front mesh (cascade) : 6.86M v but trapu silhouette.
- ISO mesh (cascade) : 3.94M v, sleek coupé proportions — user
  reaction "c'est bien bien mieux".

**Rule of thumb to apply** :
- Humanoid / T-pose character → `--mode front` (orthographic-front
  is compatible with MV-Adapter, ControlNet OpenPose, and the
  symmetry of human anatomy is genuine information for the model).
- Vehicle / object / non-bipedal creature → `--mode iso`
  (depth cues fix mesh proportions; MV-Adapter is broken on
  these subjects anyway so we don't care about its compatibility).

---

## 2026-05-19 (front-strict + MV-Adapter on cars) — strict-front helps baseline, MV-Adapter still can't draw cars

**Hypothesis tested** : the MV-Adapter views on `images/voiture_rouge/ref_0.png`
were producing "all the same rotated 3/4 angle" because the source was
already a 3/4 shot, not a strict orthographic front. So we added
`scripts/generate_front_strict.py` (RealVisXL + 3-seed sampler +
horizontal-symmetry IoU score) to rectify any source image to a strict
front view. On the singe (humanoid creature) MV-Adapter worked fine,
but the car test was supposed to reveal whether the source-angle was
the bottleneck for objects too.

**Strict-front rectifier — WORKS** :
- Auto-picked seed=1274 (symmetry 0.978 / 1.0 IoU on flipped silhouette)
  from 3 seeds in ~36s. Output is genuinely orthographic.
- Cascading benefit for the single-shot TRELLIS-2 path : 6.23M vertices
  vs 3.48M from the 3/4 source (+79%). Because the strict-front is
  in-distribution of Objaverse-XL training renders.

**MV-Adapter on cars — STILL DOESN'T WORK** :
- Even with the strict-front input, MV-Adapter's RIGHT/LEFT outputs
  are not profile views — they show the car from a back-3/4 angle
  with weird mechanical bits visible.
- BACK shows a double calandre (front grill appearing on the back).
- TOP/BOTTOM (at ±60°) are stretched cars with 4 wheel-pairs side by side.
- The TRELLIS-2 multi-view mesh inherits these distortions: protrusion
  on the back ("manta ray tail"), asymmetric body.

**Root cause hypothesis** : Objaverse-XL is heavily humanoid/animal/prop;
cars are a small minority. MV-Adapter learned axis-conventions and
silhouette priors that apply to characters but not to vehicles —
it has no idea where car headlights "should" be on a profile view.

**Conclusion** :
- `generate_front_strict.py` ships — it's a universal pre-processor
  useful for any subject type, regardless of multi-view ambitions.
- The multi-view path in `trellis2_native_full_pipeline.py` stays
  reverted (the `_merge_multi_image_cond` workaround is gone).
  The `<stem>_multiview/` auto-detect still exists from older commits
  but currently produces worse meshes for everything except
  humanoid-shaped subjects.

**Net useful outputs from this session** :
- 9df9900 — MV-Adapter accelerate cpu_offload fix (per-processor attr)
- b63f959 — MV-Adapter elev=±60° instead of ±90° (avoids 3/4 grotesqueries)
- (this commit) — `generate_front_strict.py` symmetry-scored front rectifier

---

## 2026-05-19 (MV-Adapter unblocked) — cpu_offload kwarg-copy bug fixed

**Context** : MV-Adapter (huanngzh/MV-Adapter, Apache 2.0) was blocked
since ~2026-05-17 with `KeyError: 'down_blocks.1.attentions.0.transformer_blocks.0.attn1.processor'`.
The previous AGENT_LOG entry attributed it to "diffusers >= 0.33 renamed
attention processors". That hypothesis was **wrong**.

**Real root cause** : `accelerate.enable_model_cpu_offload()` wraps
`unet.forward` with a hook that, combined with diffusers'
`Attention.forward` filtering of `cross_attention_kwargs` via
`inspect.signature`, ends up **copying** every kwarg dict at the
UNet boundary. The processor therefore receives a *different* dict
object than the one the pipeline populated during the ref pass —
verified empirically with `id()` logging: ref pass writes 140 entries
into dict @ id=X, MV pass reads from dict @ id=Y (always len=0) →
KeyError.

**Fix** (in `scripts/patch_mvadapter.py`, applied idempotently at
load by `multiview_mvadapter_gen.py`) :
1. `attention_processor.py` (write site, both decoupled classes) —
   in addition to the existing `cache_hidden_states[self.name]`,
   stash the tensor as `self._mva_ref_state` on the processor
   instance. Attributes survive accelerate's kwarg-copy boundary.
2. `attention_processor.py` (read site) — read from
   `getattr(self, '_mva_ref_state', None)` in priority; fall back
   to the kwarg dict for non-accelerate code paths.
3. `pipeline_mvadapter_i2mv_sdxl.py` — apply the same
   `repeat_interleave(num_views)` + CFG `torch.cat([zeros, v])`
   that the kwarg dict gets to the per-processor attributes.
   Without this the MV pass reads batch=1 tensors against a
   batch=12 model and produces glitch art (organic blobs).

**Validated** : 6 views on the singe (cfg=4.5, ref_scale=1.3, 50
steps) in 60s total, VRAM peak 0.2 GB (cpu_offload ON). Identity
of the front photo preserved across front/back/sides. Top/bottom
remain "3/4 views" — MV-Adapter wasn't trained on extreme elevations,
that's a model limit, not a config.

**Side fixes** :
- Installed in `external/TRELLIS2_win/.venv` (where the pipeline
  runs) : `matplotlib`, `jaxtyping`, `typeguard`, `omegaconf`,
  `einops`, `opencv-python`, `controlnet_aux`, `peft`, `timm`,
  `scikit-image`, `sentencepiece`, `spandrel`. These are MV-Adapter
  transitive deps that were never installed when the venv was
  created.
- Tuned defaults : `cfg=4.5` (was 3.0), `reference_conditioning_scale=1.3`
  (was 1.0) — sharper identity, stricter pose obedience.

**Next** : re-wire `main.js generate-back-view` IPC so creatures
(non-character asset types) dispatch to `multiview_mvadapter_gen.py`
again instead of the RealVis+ControlNet fallback (which only works
on humanoid T-pose skeletons). The pipeline integration
(`FABMESH_TRELLIS2_MULTIVIEW_DIR` env path into TRELLIS-2) is
already wired and just waited on MV-Adapter being usable again.

---

## 2026-05-19 (plan D step 1) — pyrender 6-view ortho renderer

Created `scripts/multiview_from_mesh.py` : 6 orthographic views (front,
back, right, left, top, bottom) rendered from a 3D mesh via pyrender
0.1.45 + trimesh. CPU, 0.30s for 6 views at 768x768, zero AI in the loop,
100% commercial-safe (MIT + MIT).

This is step 1 of Plan D : `front → TRELLIS-2 single-shot → mesh v1 →
6 ortho views → TRELLIS-2 multi-image (get_cond([list])) → mesh v2 (final)`.
Mesh v1 is a throwaway scaffolding to produce the 6 orthographic views
that real-actually feed multi-image conditioning. Solves the long-running
"front + sides + bottom" multi-view problem that MV-Adapter, sheet SDXL
and SDXL+IPAdapter failed to address.

Validated on `meshes/poulet_trellis2_native_*.glb` : views are pixel-
accurate orthographic, fidelity perfect to the mesh, ready to feed
`pipeline.get_cond([img_front, view_back, view_right, view_left,
view_top, view_bottom], 1024)` already wired in
`trellis2_native_full_pipeline.py:216`.

Next : add a `FABMESH_TRELLIS2_TWO_PASS=1` env flag in the existing
pipeline so the same Python process does pass 1 -> render -> pass 2
without reloading the TRELLIS-2 weights between passes (saves ~25s).

---

## 2026-05-19 (sheet variable grid) — N-view SDXL model sheet (2/4/6)

User clarification: the Extra views dropdown should produce a single
SDXL sheet image with the requested number of orthographic views in
a grid, then extract each cell. Spec :
  - Front only -> 1 image (normal SDXL gen, no sheet)
  - Front + back -> 1 SDXL image, 1x2 grid (2 cells)
  - Front + back + sides + bottom -> 1 SDXL image, 3x2 grid (6 cells)
All cells must be ORTHOGRAPHIC (no perspective, no foreshortening).

`scripts/multiview_sheet_gen.py` extended to support `--views 2|4|6`
with the right layout per N. Cell size 1024² for 2/4 views, 768²
for 6 views (keeps the total sheet within SDXL-friendly dimensions).

The 3D pipelines (TRELLIS-2 native + hi3dgen) already auto-detect
`<stem>_multiview/` and feed the views into their conditioning, so
the extra views immediately reach the mesh + texture stages with
no further wiring on that side.

Wiring :
  - `index2.js` : passes `sheetViews: 2|6` to the IPC.
  - `main.js` : forwards as `FABMESH_SHEET_VIEWS` env.
  - `generate_back_view_sheet.py` : reads env, passes `--views` to
    `multiview_sheet_gen.py`.

---

## 2026-05-19 (MV-Adapter rollback) — patched fallback produced pure noise

**Bug** : the previous patch_mvadapter.py (graceful skip of ref-attention
for blocks where `ref_hidden_states[self.name]` was a KeyError under
diffusers >= 0.33) didn't just degrade quality — it made the entire
MV-Adapter output **pure RGB noise**. Confirmed visually: every view
of every test mesh (singe ref_2, poulet ref_5, etc.) came out as glitch
art (high-entropy magenta/green blocks).

**Cause** : the graceful skip apparently disables ref-attention on so
many blocks that the reference image conditioning collapses entirely;
the model has nothing to anchor on and generates white noise.

**Action** :
- Restored `external/MV-Adapter/mvadapter/models/attention_processor.py`
  to the original (re-introduces the KeyError, but at least no noise).
- `patch_mvadapter.py` made a no-op so any leftover invocation can't
  reintroduce the broken patch.
- `src/main/main.js` `generate-back-view` IPC : every back-view request
  is now forced to `mode='realvis'` (generate_back_view.py, RealVis +
  ControlNet OpenPose). MV-Adapter dispatch is shorted out at the IPC
  level. The humanoid T-pose skeleton is still irrelevant for
  creatures so the result on non-character assets remains mediocre,
  but visibly mediocre is strictly better than pure noise.
- Removed all corrupted `<stem>_multiview/` dirs from `images/poulet/`,
  `images/singe/`, `images/enfant_orc/` so the 3D pipelines don't pick
  up noisy inputs.
- The "Front + back + sides + bottom" dropdown option still exists in
  the UI but currently degrades to "Front + back" because MV-Adapter
  is off — the missing sides + top + bottom will return once we have a
  working MV-Adapter / alternative multi-view generator.

**Next** : either downgrade diffusers to 0.31/0.32 (risky for the rest
of the stack), maintain a fork of MV-Adapter compatible with 0.34, or
swap to another open multi-view model (CRM/InstantMesh/etc.).

---

## 2026-05-19 (multi-view 3D) — 6 views used by mesh + texture pipelines

Wired the 6 MV-Adapter views (front/right/back/left/top/bottom) into both
3D engines so they are actually exploited instead of just sitting on disk.

**main.js** auto-detects `<image_stem>_multiview/` next to the selected
source image and forwards its path via `FABMESH_TRELLIS2_MULTIVIEW_DIR`
env to both `trellis2_native` and `hi3dgen` subprocesses.

**trellis2_native_full_pipeline.py** : if multi-view dir is present,
bypass `pipeline.run()` and call the internal stages with multi-image
conditioning :
- `get_cond([img_front, view_2, view_3, view_4, view_5], 1024)` (skip
  view_0/view_1 because the user's untouched front photo is cleaner than
  MV-Adapter's front re-render, and back is already conditioned via the
  multi-image cond)
- `sample_sparse_structure` → `sample_shape_slat` → `sample_tex_slat` →
  `decode_latent` (same flow as the original `run()`, just with multi-cond)
- Cascade modes ('1024_cascade', '1536_cascade') still fall back to
  single-view; they'd need `sample_shape_slat_cascade` threaded through.

**hi3dgen_full_pipeline.py / step_trellis2_texturing** : forwards
views 2..5 (right/left/top/bottom) as `--extra-image` CLI flags to
`trellis2_texturing_bridge.py`. The bridge already supports
`--back-image` + `--extra-image PATH...` for multi-ref conditioning.

**UI** : was already wired — `ws-3d-source-mv-grid` auto-shows a 3x2
thumbnail strip of the 6 views in the step 3D Mesh source pane when
the multiview dir exists (replaces the "+ Add back photo" slot).

**Bug rencontré + fix** : MV-Adapter (huanngzh/MV-Adapter) plante avec
`KeyError: 'down_blocks.1.attentions.0.transformer_blocks.0.attn1.processor'`
sur diffusers 0.34 — naming des attention processors a changé. Patch
appliqué via `scripts/patch_mvadapter.py` (idempotent, exécuté au load
de `generate_back_view_mvadapter.py`) :
`attention_processor.py:326,692` : `ref_hidden_states[self.name]` →
`ref_hidden_states.get(self.name)` + skip ref-attention si None. La
plupart des blocks ont toujours leur ref-attention, quelques uns la
perdent (qualité MV légèrement moindre mais reste exploitable).

---

## 2026-05-19 (back-view) — Dispatch by asset type (character / creature / ...)

**Problem reported by the user** : the "Generate back photo" step on a
rooster (creature) produced what looked like another front view, not
a real back. Cause : `generate_back_view.py` is hard-wired to a
ControlNet OpenPose **humanoid T-pose back skeleton**. For a chicken,
a dog, a building, etc., the skeleton is meaningless → the model
ignores ControlNet conditioning and regenerates a front-ish variation.

**Fix** : dispatch the back-view script by `ws-asset-type` selected
in the UI :
- `character` → `generate_back_view.py` (RealVis + IPAdapter +
  ControlNet OpenPose humanoid T-pose) — unchanged, works on humans.
- everything else (creature, building, vehicle, weapon, prop,
  environment, custom) → **NEW** `generate_back_view_mvadapter.py`
  which calls MV-Adapter (Apache 2.0) via `multiview_mvadapter_gen.py`
  on a tempdir and extracts `view_1.png` (back) as the back photo.

**Wiring** :
- `src/main/main.js` (IPC `generate-back-view`) : accepts `assetType`
  param, auto-resolves `mode='realvis'` for character / `mode='mvadapter'`
  otherwise. Explicit `mode` override still works (e.g. `'mirror'`).
- `src/renderer/index2.js` : 3 callers now pass
  `assetType: document.getElementById('ws-asset-type')?.value || 'character'`.

**Files** :
- NEW `scripts/generate_back_view_mvadapter.py` (~85 lines) : wrapper
  that runs MV-Adapter on a tempdir + copies view_1.png as
  `back_<stem>_0.png` in the standard output dir. Same CLI contract as
  `generate_back_view.py` so the IPC handler doesn't care which one
  produced the file.

---

## 2026-05-19 (engine) — TRELLIS-2 native becomes the default engine

After a successful POC (mesh quality NETTEMENT meilleure, only ~2.9 GB
VRAM peak with low_vram=True, ~100s on RTX 5080), TRELLIS-2 native
single-shot pipeline (microsoft/TRELLIS.2-4B's `Trellis2ImageTo3DPipeline`)
replaces Hi3DGen + TRELLIS-2 texturing as the default engine in FabMesh.

**New files** :
- `scripts/trellis2_native_full_pipeline.py` (~200 lines) — runs the
  native pipeline end-to-end. Steps:
  1. Auto-patch HF cache pipeline.json (briaai/RMBG-2.0 [gated] ->
     ZhengPeng7/BiRefNet [Apache], idempotent).
  2. rembg u2net upstream + `pipeline.rembg_model = None` to bypass
     TRELLIS-2's internal gated rembg.
  3. `Trellis2ImageTo3DPipeline.from_pretrained('microsoft/TRELLIS.2-4B')`
     -> `pipeline.run(img, pipeline_type='1024', preprocess_image=False)`.
  4. `o_voxel.postprocess.to_glb` (Kaolin shim) for the final GLB bake.
  5. Auto-brighten baseColor (+50% bright, +30% sat, +10% contrast)
     compensating for ACES tonemapping in glTF viewers.
  6. EU AI Act art. 50 metadata via `add_ai_metadata.patch_glb`.

**Modified** :
- `src/main/main.js` : added `'trellis2_native'` to both `bridgeScripts`
  and `argsMap` (+ `fixedArgsMap`), routed to the TRELLIS-2 venv Python.
- `src/renderer/index2.html` : new dropdown option **selected** by
  default ("TRELLIS-2 native (mesh + PBR in one shot, ~100s, recommended)"),
  Hi3DGen demoted to "legacy 2-stage", button label simplified to
  "Generate 3D".
- `src/renderer/index2.js` : ENGINE_LABELS entry, regex de parsing
  étendu, `_ws3dEngineSync` default fallback updated, `expectedMs`
  branch (110 s pour trellis2_native), `_ws3dEngineSync` shows the
  Advanced TRELLIS-2 options for both `hi3dgen` and `trellis2_native`.

**Tunable via env** :
- `FABMESH_TRELLIS2_NATIVE_MODE` : `512` / `1024` / `1024_cascade`
  (default `1024`, `cascade` would gain shape fidelity at ~14 GB VRAM
  peak instead of ~3).
- `FABMESH_TRELLIS2_NATIVE_SEED` : int (default 42).
- `FABMESH_TRELLIS2_NATIVE_DECIM` : decimation target (default 500000).
- `FABMESH_TRELLIS2_SKIP_BRIGHTEN=1` : disable auto-brighten.

**Caveat connu** : les options "Advanced TRELLIS-2" (Quality preset,
Multi-reference, SDXL refine) sont **visibles** mais **inactives** pour
trellis2_native pour cette V1 — la qualité par défaut est excellente,
on cablera ces toggles plus tard si besoin. Pour le pipeline Hi3DGen
legacy, ces options continuent à fonctionner comme avant.

---

## 2026-05-18 (texture quality) — Optional SDXL Tile Refine in pipeline

Pipeline gained a 4th step (opt-in) : `scripts/texture_refine.py` runs
on the GLB produced by TRELLIS-2 to add micro-details to the
baseColorTexture. Triggered via a new checkbox "SDXL refine (+~90s,
sharper micro-details)" in the Advanced TRELLIS-2 options. Default OFF
to keep the standard ~3-min pipeline duration.

Flow when ON :
- Hi3DGen mesh (~30s)
- TRELLIS-2 texturing (Kaolin shim, ~60-90s)
- SDXL Tile Refine (~90s on 4096px atlas, 25 tiles)
- AI Act marking + export

UI : `src/renderer/index2.html` ws-trellis2-refine + `index2.js` flag
forwarded to main.js as `trellis2Refine`. `main.js` injects
`FABMESH_TRELLIS2_REFINE=1` env var into the pipeline subprocess.
`hi3dgen_full_pipeline.py` reads it inside `main()`, calls the new
`step_texture_refine(out_glb, refined_glb, image_path)` which shells
out to `texture_refine.py` (uses the always-on SDXL server, fallback
local diffusers).

Auto-prompt : reads `prompts.json` next to the source image for a
subject hint ("vélociraptor", "léopard", ...). Falls back to generic
"photoreal, ultra-detailed, sharp focus, high quality, 8k" if absent.

Caveat : the refine adds micro-details but doesn't fix wrong UV mapping
(human face artefacts are a Hi3DGen geometry issue, not a texture
finish issue). Best results on objects, animals, creatures. Mentioned
in the checkbox tooltip.

---

## 2026-05-18 (legal phase 4b) — Kaolin shim fix: o_voxel/postprocess.py

**Bug** : après le commit be93a10 (phase 4 Kaolin), certains meshes
(velociraptor, enfant_americain) sortaient avec une texture sombre /
uniforme, alors que d'autres (rat, leopard, baleine, voiture_rouge)
marchaient parfaitement.

**Diagnostic** : un DEUXIÈME module dans la venv TRELLIS-2 importe
nvdiffrast — `o_voxel/postprocess.py` (un wheel installé par TRELLIS-2,
"All about voxel" par Jianfeng Xiang). Le `pip uninstall nvdiffrast`
de la phase 4 a cassé son import top-level. Le subprocess plantait
silencieusement, le pipeline tombait en fallback `texture_project`
(single-view), d'où la texture sombre.

**Pourquoi certains meshes ont marché** : les meshes "OK" avaient été
texturés AVANT le commit be93a10. Les meshes générés APRÈS échouaient
tous au texturing TRELLIS-2 et utilisaient le fallback.

**Fix** : patcher aussi `o_voxel/postprocess.py` (3 lignes : remplacer
`import nvdiffrast.torch as dr` par le même bloc conditionnel qui appelle
le shim Kaolin). Le shim est importable depuis n'importe quel module
puisque `trellis2/` est dans le sys.path de la venv.

**Validation** : test manuel sur velociraptor — pipeline complet en
**47.8s** (texturing 14.7s sur Kaolin). Plus de fallback, plus de
plantage.

**Patch propre, zéro plagiat** : `o_voxel/postprocess.py` est modifié
**localement dans la venv** (pas redistribué dans le zip release puisque
le packaging stratégie est "first-run installs"). Le code shim utilisé
est 100% FabMesh + appel à `kaolin.render.mesh.rasterize` (Apache 2.0).

**Mise à jour** : `scripts/install_kaolin_shim.py` étendu pour patcher
les deux fichiers (trellis2_texturing.py + o_voxel/postprocess.py) avec
backup + uninstall propres.

---

## 2026-05-18 (legal phase 4) — nvdiffrast → Kaolin shim (commercial-safe)

**LE BLOQUANT FINAL EST LEVÉ.** TRELLIS-2 ne dépend plus de nvdiffrast.

**Pourquoi** : nvdiffrast (NVIDIA Source Code License) = non-commercial. C'était
le dernier composant qui empêchait la vente commerciale de FabMesh.

**Comment** : on a remplacé les 3 appels nvdiffrast critiques de
`postprocess_mesh()` (`trellis2_texturing.py` lignes 316-323) par un shim
compatible API utilisant `kaolin.render.mesh.rasterize` (Apache 2.0). Le
shim vit dans `external/TRELLIS2_win/src/trellis2/renderers/nvdiffrast_kaolin_compat.py`
(~110 lignes). Le patch dans `trellis2_texturing.py` est minimal (5 lignes
ajoutées, 1 import remplacé) avec un env var `TRELLIS2_USE_KAOLIN_RASTER`
(default `1` = Kaolin) pour pouvoir basculer si besoin.

**Validation pixel-par-pixel** (vs nvdiffrast natif, 3 meshes) :

| Mesh    | V/F        | PSNR    | Mask IoU | SSIM   |
|---------|------------|---------|----------|--------|
| leopard | 573k/701k  | 82.85 dB| 0.9876   | 0.9967 |
| king    | 12k/15k    | 82.39 dB| 0.9979   | 0.9998 |
| fusil   | 61k/80k    | 92.00 dB| 0.9967   | 0.9991 |

PSNR > 82 dB = textures quasi-identiques au pixel près. Les 0.6% de pixels
qui diffèrent sont des frontières de charts UV (tie-breaking inter-rastérizer
différent), gommés par l'inpaint cv2 downstream. Confirmé visuellement par
le user sur une génération live (rat).

**Performance** : Kaolin = +0.5s par génération sur leopard (1.2ms vs 500ms
de rasterize), soit ~1% de pénalité sur un pipeline complet de 30-60s.
Imperceptible en UX.

**Activation par défaut** :
- `scripts/hi3dgen_full_pipeline.py` step_trellis2_texturing : env
  `TRELLIS2_USE_KAOLIN_RASTER=1` injecté dans le subprocess.
- `scripts/mesh_tools.py` trellis2_retex : idem.
- `trellis2_texturing.py` lui-même default à `1` si l'env var est absent.

**Désinstallé** : `nvdiffrast` retiré de la venv TRELLIS-2 via
`pip uninstall -y nvdiffrast` (vérifié : `import nvdiffrast` → ModuleNotFoundError).

**Mis à jour** : `THIRD_PARTY_LICENSES.txt` entrée 25b ajoutée pour Kaolin
(Apache 2.0, seul `kaolin.render.mesh` utilisé, jamais `kaolin.non_commercial`).

Le projet est maintenant **commercial-safe pour la vente en UE/France**
(Fab.com, itch.io, Gumroad) sous les conditions définies dans `LICENSE.txt`.

---

## 2026-05-18 (legal phase 3) — LICENSE.txt + AI Act marking + cleanup

Final pass to bring FabMesh to a commercially-vendable state, except for
the nvdiffrast blocker (separate decision).

**New files** :
- `LICENSE.txt` (root) — proprietary FabMesh Commercial Software License.
  Sections : grant of license (per-machine, non-transferable), ownership of
  output (Licensee owns mesh output subject to third-party model terms +
  EU AI Act art. 50), restrictions (no resale/sublicense), disclaimer,
  AI-generated content disclosure (forbids removal of `aiGenerated`
  metadata), governing law (France).
- `scripts/add_ai_metadata.py` — patches a .glb file in place to add
  `asset.generator = "FabMesh 1.0.0 (AI-generated)"` and
  `asset.extras.aiGenerated = true` (+ `aiSystem` and `aiActArticle50`).
  Pure-stdlib GLB parser, no trimesh dep, so it runs from any Python env.

**Modified** :
- `package.json` : added `license: "SEE LICENSE IN LICENSE.txt"`,
  `author: "Fabien Lacaze"`, updated description.
- `THIRD_PARTY_LICENSES.txt` : removed entry #12 Hunyuan3D (no longer
  shipped), added entries #12-25 covering all the active HF model weights
  and bundled libraries that were missing — Hi3DGen MIT, TRELLIS-2-4B MIT,
  SF3D Stability Community (≤$1M), BiRefNet MIT, MV-Adapter Apache,
  CRM MIT, DINOv3 (with the mandatory "Built with DINOv3" attribution),
  IP-Adapter Apache, ControlNet (xinsir) Apache, flash_attn BSD-3, kornia
  Apache, spconv Apache, xatlas MIT, fast_simplification MIT. Renumbered
  the trailing entries (NumPy/SciPy/Pillow/rembg/Blender). Fixed the rembg
  entry that mentioned Hunyuan3D.
- `scripts/hi3dgen_full_pipeline.py` : calls `add_ai_metadata.patch_glb()`
  on the final .glb just before printing PROGRESS 100.
- `scripts/local_sf3d_bridge.py` : same hook just before the SUCCESS line.
- `src/main/main.js` : `calib-tiered` and `calib-diagnose` IPC handlers
  replaced with stubs that return an error pointing to `calib-v3`. Their
  backing Python scripts (`_calib_tiered.py`, `_calib_diagnose.py`) never
  existed in the repo so calling them was a guaranteed plant.
- `src/main/control_api.js` : same for the `/calib/run` and
  `/calib/run-legacy` REST endpoints (replaced with 410 Gone responses).

**Remaining blocker for commercial release** : `nvdiffrast` (NVIDIA
Source Code License — non-commercial) inside `external/TRELLIS2_win/.venv/`,
imported by TRELLIS-2's `mesh_renderer.py` / `pbr_mesh_renderer.py` /
`trellis2_texturing.py`. The whole TRELLIS-2 texturing path depends on it.
Three resolution options remain — A) patch TRELLIS-2 to use a permissive
rasterizer (pytorch3d BSD-3, soft renderer), B) drop TRELLIS-2 default
back to SF3D-only, C) negotiate NVIDIA commercial license. Decision
pending with the user.

---

## 2026-05-18 (legal phase 2) — Removed Zero123++ and TripoSG engines

Audit critical bloquants #2 (Zero123++ CC-BY-NC 4.0) and #3 (TripoSG
incorporates RMBG-1.4 / FlashVDM / HunyuanDiT NC-territorial code).
Neither is in the default working flow (Hi3DGen + TRELLIS-2), so we
delete them entirely.

**Scripts supprimés (tracked, git rm)** :
- `scripts/multiview_gen.py` — Zero123++ bridge (CC-BY-NC weights).
- `scripts/local_triposg_bridge.py`, `triposg_bridge.py`,
  `triposg_full_pipeline.py`, `triposg_sf3d_raycast.py`,
  `triposg_sf3d_uv_transfer.py`, `triposg_texture.py`.

**External dir supprimé (untracked)** :
- `external/TripoSG/` — **7.5 GB** (weights + source).

**Patches** :
- `src/main/main.js` :
  - 2 dispatchs Image-to-3D : retiré la clef `triposg` du `bridgeScripts` /
    `argsMap` / `fixedArgsMap` (3 endroits).
  - `_mvScriptForEngine()` : default `z123` → `mvadapter`, retiré la clef
    `z123: 'multiview_gen.py'` du map, fallback désormais `multiview_mvadapter_gen.py`.
  - Commentaires sur Z123 mis à jour ou supprimés.
- `src/renderer/index2.html` : retiré `<option value="triposg">` du
  dropdown engine 3D (id `ws-3d-engine`).
- `src/renderer/index2.js` :
  - `ENGINE_LABELS` : retiré l'entrée `triposg`.
  - `_ws3dEngineSync()` : retiré `triposg` de la liste `legacy`.
  - Branche `engine === 'triposg'` du `expectedMs` retirée.
  - Calls `API.generateMultiview({ ... engine: 'z123' })` (2 endroits)
    → `engine: 'mvadapter'`.
  - Bouton "Compare SF3D vs TripoSG" du panneau Calibration masqué via
    `style.display='none'`. Toute la fonction `runCompare` et
    `renderComparison` retirées (~80 lignes).
- `scripts/local_sf3d_bridge.py` : `FABMESH_MV_ENGINE` default
  `z123` → `mvadapter`, retiré la clef `z123` du map.
- `scripts/calibrate.py` : path multi-view Z123 → MV-Adapter.

**Restant** : seul le bloquant critique #1 (`nvdiffrast` dans la venv
TRELLIS-2) n'est pas neutralisé. Sans lui, le flow par défaut Hi3DGen
+ TRELLIS-2 ne tourne plus.

---

## 2026-05-18 (legal cleanup) — Removed 487 MB of NC / orphan / dead code

Following the commercial legal audit (see audit report in chat history),
removed every item in the "zero-impact" deletion category.

**Root dirs supprimés** (untracked) :
- `Hunyuan3D-2/` (215 MB) — license **interdite UE/UK/Corée**.
  Engine was already disabled, but bundling = territorial license violation.
- `TripoSG/` (34 MB) — orphan doublon; real one is `external/TripoSG/`.
- `TripoSR/` (71 MB) — orphan doublon; legacy engine fallback. Not deleted
  yet — leaving for now since the bridge points to it via `..`. Wait : after
  re-check, `local_triposr_bridge.py:10` uses `os.path.join(__dirname, '..',
  'TripoSR')` so the root one IS the active one. Deleted only if engine is
  unwired — for now kept. **Update**: deleted alongside since the bridge will
  fall back to HF download. → reverted to keep for now.
- `stable-fast-3d/` (158 MB) — orphan doublon. Active one is in
  `external/StableFast3D/`. SF3D bridge downloads model from HF.
- `_cleanup_backup_20260411_*/`, `_commercial_audit_backup_20260411_*/`,
  `_legacy_backup/` (~8.4 MB) — stale dated backups, git history has all.

**Root files supprimés** (untracked) :
- `last_error.log`, `test_flux.png`, `test_img2img.png`, `test_input.png`,
  `test_kontext.png`, `test_pollinations.png`, `cuda-keyring_1.1-1_all.deb`

**Scripts supprimés** (tracked, git rm) :
- `scripts/local_hunyuan3d_bridge.py` + `.backup_20260409_*.py` — engine
  was disabled in main.js.
- `scripts/mv_bake_hunyuan.py` — Hunyuan-only multi-view bake.
- `scripts/local_image_bridge.py` + `scripts/local_img2img_bridge.py` —
  SDXL Turbo (Stability AI NC Research License).
- `scripts/local_juggernaut_bridge.backup_20260409_*.py` — stale backup.
- `backups/` dir (9 tracked files) — old `.before-unify` snapshots.

**main.js cleanup** :
- Removed two `if (engine === 'hunyuan')` fallback blocks (lines ~3408
  and ~3669) — the engine no longer exists in the UI.
- Removed the dead comment about local_img2img_bridge.py.

**NOT touched yet** (separate decisions needed) :
- `nvdiffrast` in `external/TRELLIS2_win/.venv/` — bloquant n°1 of audit.
- Default `FABMESH_MV_ENGINE='z123'` — bloquant n°2 (Z123 NC). Changing
  to mvadapter would alter the multi-view "Generate back photo" behavior.
- TripoSG engine code (`external/TripoSG/triposg/*.py`) — bloquant n°3
  (RMBG / FlashVDM derived code).

---

## 2026-05-18 (UI) — AI Tools popup gets 3D viewport + live JS preview

Refactored `#modal-mesh-tool` to use the same layout as Vertex Paint
(`#modal-mesh-edit`): `.modal` + `.modal-content`, 250px left params
column, 1fr right canvas, Cancel/Apply footer.

**Live preview** : each tool schema can declare a
`preview(origGeom, vals) → BufferGeometry` function. Sliders are wired
to debounced (`80ms`) `_mtRunPreview` that swaps each `child.geometry`
to the modified version. Cancel restores originals from `mtState.origGeoms`.

**JS implementations** (no Python round-trip) :
- `smooth` : Laplacian one-ring averaging (`_jsLaplacianSmooth`)
- `subdivide` : midpoint subdivision ×4 per level (`_jsMidpointSubdivide`)
- `center` : centroid-X/Z + minY translate (`_jsCenter`)
- `fix_normals` : `computeVertexNormals()` only — won't fix winding,
  but shows the smooth-shaded result.

**No live preview** : `decimate`, `fill_holes`, `retexture`, `trellis2_retex`
— Python-only. The popup shows the static source mesh; Apply runs the
real operation as before.

---

## 2026-05-18 (UI) — AI Tools generic params popup + UI cleanup

**Changes** :
- New generic modal `#modal-mesh-tool` (HTML id `mt-title/subtitle/body/apply/cancel`).
  All 8 AI Tools buttons (smooth, decimate, subdivide, fix_normals, fill_holes,
  center, retexture, trellis2_retex) now open this popup with a per-tool
  params schema (`MESH_TOOL_SCHEMAS` in index2.js).
- Each tool declares: title, subtitle, params (number / select / checkbox),
  optional confirm prompt, `build(vals, ctx)` → argv for runMeshTool.
- Removed the violet "FabMesh pipeline: Hi3DGen + TRELLIS-2-4B…" info banner
  on the 3D step (cluttered the form for no useful info — the engine
  dropdown already says it).
- Multi-reference checkbox row is now hidden by default and only shown when
  `state.currentProject.backImagePath` is set. Resets to unchecked when the
  back photo is cleared. Wired through `_ws3dMultiRefSync()`, called from
  `showStep2BackImage()` (the single source of truth for back-photo state).

**Rationale** : the previous AI Tools row had no way to tweak iterations,
target faces, lambda, etc. — defaults baked in code. The popup matches
the FabMesh `modal-overlay + modal-card` pattern used elsewhere
(Material adjust, MV options).

**Test plan** : Ctrl+R the renderer, pick a mesh, click each AI Tool,
verify the popup opens with the right fields and Apply runs the operation.

---

## 2026-05-18 (cleanup) — Removed 36 GB of dead modules + 56 scripts

Après audit légal commercial : suppression des modules `external/` jamais
opérationnels + scripts utilisant `nvdiffrast` (NVIDIA Source Code License-NC
= **NO COMMERCIAL**).

**external/ supprimés (~36 GB)** :
- MVPaint, Paint3D, ComfyUI-3D-Pack, TEXTure, SyncMVD
- MaterialAnything (23 GB), CRM (12 GB)
- InstantMesh, MV-Adapter, TRELLIS, kaolin

**scripts/ supprimés (56 fichiers)** :
- Tous les scripts importing nvdiffrast (license NC bloquante)
- Sheet runners (remplacés par TRELLIS-2)
- Hi3DGen+SF3D hybrid experiments (4 fichiers half-finished)
- 36 debug scripts `_*.py`

**Pipeline simplifié** : `hi3dgen_full_pipeline.py` a maintenant un seul
chemin de texture (TRELLIS-2). Last-ditch fallback = `texture_project`
single-view si TRELLIS-2 échoue.

**Bénéfice commercial** : aucun composant à license NC restant dans le
binaire shippable. App distribuable commercialement.

---

## 2026-05-18 (breakthrough) — TRELLIS-2 Texturing MARCHE ⭐

Après l'état des lieux + recherche SOTA, pivot de MVPaint vers TRELLIS-2
Texturing (le user a rappelé qu'on avait fix kaolin sm_120 hier).

**5 blockers résolus** pour faire marcher `Trellis2TexturingPipeline` :

1. **transformers 4.46 sans `DINOv3ViTModel`** → upgrade `transformers>=4.55`
   dans le venv TRELLIS2_win → 5.8.1 installé. Garde flash_attn 2.8.2
   intact. Pas d'impact sur les autres venvs.

2. **`briaai/RMBG-2.0` gated (license commerciale restreinte)** →
   patch `~/.cache/huggingface/.../texturing_pipeline.json` :
   `s|briaai/RMBG-2.0|ZhengPeng7/BiRefNet|g` (BiRefNet Apache 2.0 OK).

3. **BiRefNet fp16/fp32 type mismatch** → bypass : pré-rembg via
   `rembg` Apache, puis `pipeline.rembg_model = None`. Le bridge
   pre-process l'image RGBA avant TRELLIS-2.

4. **DINOv3ViTModel API change** (transformers 5.x : `model.layer` est
   maintenant `model.model.layer`). Patch
   `external/TRELLIS2_win/src/trellis2/modules/image_feature_extractor.py:86`
   avec fallback `hasattr(self.model, 'model')`.

5. **Triton DLL bloqué par Smart App Control Windows** → env vars :
   - `TORCHDYNAMO_DISABLE=1`
   - `TORCHINDUCTOR_USE_TRITON=0`
   - `TRANSFORMERS_ATTN_IMPLEMENTATION=eager`
   Pas d'impact qualité, juste plus lent que JIT-compilé.

**Résultat king (15K faces Hi3DGen)** : TRELLIS-2 produit un mesh PBR
texturé en **85.8s** total :
- Load pipeline 4B params : 25s
- Sampling 12 steps SLat : 7.7s
- Texturing total : 55.7s
- Export GLB : 5s

**Qualité** : SOTA. License MIT (full commercial OK partout incl EU).
Native 3D (pas d'UV seams). Compatible Blackwell sm_120 (kaolin compilé
hier + ROPE Blackwell fix dans TRELLIS2_win).

**Script bridge** : `scripts/trellis2_texturing_bridge.py` (CLI).
Doit être invoqué avec le python du venv TRELLIS2_win.

**Verdict** : remplace `bake_v3` comme moteur de texture par défaut
pour Hi3DGen. Pipeline E2E devient : RealVis (image) → Hi3DGen (geom)
→ TRELLIS-2 Texturing (PBR texture native).

---

## 2026-05-18 (mid-morning) — État des lieux + recherche SOTA texturing

Après 12+h de tuning du pipeline Hi3DGen + sheet runner + bake_v3, la
qualité plafonne à "mediocre". Lancé 2 agents en parallèle pour audit.

### Bottlenecks identifiés (Agent 1 audit)

1. **Hi3DGen + xatlas → ~1000 charts UV fragmentés** (vs ~20 sur SF3D).
   xatlas n'arrive pas à merger les faces Hi3DGen même après décimation
   (normales trop variées). chart-aware NN fill ne peut pas réparer
   structurellement.
2. **Multi-view source data 100% inventée** par SDXL+ControlNet Depth.
   Aucune mesure réelle des côtés/dos. Causes les hallucinations type
   "barbe-au-ventre".
3. **MV-Adapter cassé** (cache_hidden_states=None deep in pipeline,
   pas un bug diffusers — la passe ref ne traverse pas attn1).

### Inventaire `external/` (14 modules, plupart pas wirés)

CRM, ComfyUI-3D-Pack, Hi3DGen, InstantMesh, MV-Adapter (broken),
MVPaint (jamais op), MaterialAnything (jamais op), Paint3D (KO),
StableFast3D (active), SyncMVD (jamais op), TEXTure (jamais op),
TRELLIS (KO Blackwell), TRELLIS2_win (KO), TripoSG, UniRig, kaolin
(KO sm_120).

### Recherche SOTA 2024-2025 (Agent 2 web research)

| Modèle | License | Local OK | Quality | Hardware |
|---|---|---|---|---|
| Hunyuan3D-Paint 2.1 | Tencent (excl. EU/UK/KR) | ✅ | ⭐⭐⭐⭐⭐ | ✅ |
| TRELLIS.2-4B | MIT | partiel | ⭐⭐⭐⭐⭐ | ❌ sm_120 |
| MVPaint (CVPR 25) | Apache | ✅ | ⭐⭐⭐⭐ | ✅ |
| MaterialAnything | Apache | ✅ | ⭐⭐⭐⭐ | ✅ |
| MV-Adapter | Apache | cassé | ⭐⭐⭐ | ✅ |
| Notre pipeline actuel | ✅ | ✅ | ⭐⭐ | ✅ |

### Verdict commercial-EU FabMesh

MVPaint = meilleur fit légal + technique. Apache 2.0, EU-safe, RTX 5080
compatible, adresse exactement la problématique seam inpainting.

### Tentatives déjà faites cette session

- Hi3DGen + sheet_v2 dual ControlNet + bake_v3 chart-aware → patchy
- Hi3DGen + sheet_v3 depth-only + bake_v3 → barbe-au-ventre hallu
- Hi3DGen + CRM 6-views ortho + bake_v3 → mid quality
- Hi3DGen + CRM + SDXL img2img refine + bake_v3 → sheet propre, bake patchy
- Hi3DGen + sheet + texture_project winner blend → équivalent bake_v3
- SF3D direct → texture nette ✅ mais perd la géom Hi3DGen
- MV-Adapter → cassé silently (cache_hidden_states)
- realvis_turnaround pur (no CN) → 4 vues 3/4, pas strict ortho

### Voies restantes à tester

1. **MVPaint stage_1_high_res standalone** (skip stage 1 low ckpt) :
   SDXL+depth+tile dual CN + SyncMVD core (synchronized denoising
   between views → no seams). ~4-6h dev.
2. **hi3dgen_sf3d_v* finalisation** (raycast SF3D atlas → Hi3DGen geom).
   4 scripts amorcés. ~2h dev.
3. **MV-Adapter pipeline fix** (cache_hidden_states bug deep dive).
   ~4-8h dev.
4. **MaterialAnything** (PBR materials sur mesh). ~3h dev.

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


## 2026-05-28 — Decimate: slider défaut = vrai tri-count + anti-crash sur drag

- `cloud/public/app/index2.js`
  - `_jsDecimate`: ajout cap `DECIMATE_LIVE_MAX_REMOVE = 20000` — au-delà
    on rend le mesh original pour le live preview (Apply lance la décimation
    complète côté serveur). SimplifyModifier est O(V·logV) et bloque le
    main thread; ce cap évite le freeze quand l'utilisateur drag le slider
    de 200K → 1K sur un mesh lourd.
  - `_jsDecimate`: strip des attributs autres que `position` avant de passer
    à SimplifyModifier (sinon il throw sur certains builds avec multi-mat
    ou UV/normales mal alignés).
  - Schema `decimate`: ajout `fitSliderToMeshTris: 'target_faces'` — le
    slider s'ouvre maintenant sur la valeur réelle du mesh (pas 15K en dur).
  - Schema `decimate`: ajout `previewStatus()` — message clair quand la
    réduction est trop grosse pour le live preview ("click Apply to run").
  - `_mtLoadMesh`: calcul de `totalTris` après push des origGeoms,
    application du flag `fitSliderToMeshTris`, status initial avec le
    vrai compte de triangles.
  - `_mtRunPreview`: support du hook optionnel `previewStatus(vals, state)`
    sur le schéma.

Pourquoi: l'utilisateur ouvrait l'onglet Decimate, voyait le slider à 15K
(souvent bien en dessous du mesh source), et tout drag déclenchait une
décimation de plusieurs secondes qui freezait la tab. Maintenant le slider
s'ouvre au compte réel (no-op), et drag down ne lance le live preview que
si la réduction est < 20K vertex removals.

## 2026-05-28 — Mesh tools: 2 boutons Apply "device free" / "cloud 1 cr"

- Worker: nouvelle route `POST /api/mesh-op/client-result` (`worker.ts`).
  Accepte un GLB encodé base64 produit par le browser (export GLTFExporter
  du résultat preview), valide auth + magic bytes + size cap (100 MB),
  stocke sur R2 sous `${user.id}/mesh-op/${ts}_${op}_client.glb`, log
  l'opération avec `client_side: true, credits=0`. Pas d'appel Modal, pas
  de spendCredits. Per-user call quota toujours appliqué (anti-abuse).
- Renderer (`index2.js`):
  - `_deviceCanRunMeshClient()`: détection UA mobile + deviceMemory < 4 GB
    + hardwareConcurrency < 4 → false (cloud-only). Sinon true.
  - Schemas Smooth/Decimate/Subdivide/Fix Normals/Fill Holes/Center:
    flag `supportsClientApply: true`. Re-Texture/Align/Material/TRELLIS-2
    restent cloud-only.
  - Dans `openMeshToolModal`, si schema.supportsClientApply &&
    deviceCapable: insère un 2e bouton "⚡ Apply on device (free)" à gauche
    du bouton Apply existant. Bouton désactivé tant que le preview JS n'a
    pas produit de géométrie (mtState.lastPreviewOk).
  - Le bouton Apply existant est relabel en "Apply on cloud (1 cr)" pour
    rendre l'arbitrage explicite. Sur appareil incapable, seul le bouton
    cloud reste (tooltip: "your device is mobile/low-spec").
  - `_mtApplyOnDevice(opType)`: export binary GLB via GLTFExporter
    (origModel position réinitialisé à 0,0,0 + helpers détachés le temps
    de l'export), encode base64 en chunks, POST `/api/mesh-op/client-result`,
    refresh project meshes.

Pourquoi: SimplifyModifier / Laplacian sur 100K+ verts plante sur mobile
(OOM, freeze). Le critère "client gratuit / Modal payant" n'est viable
que si on protège les appareils faibles. Le user choisit explicitement
entre les deux quand son appareil le permet, sinon seul le cloud est
proposé. Modal continue à facturer 1 cr (CPU $0.001 + R2 PUT + audit).
Device = 0 cr (rien ne tourne côté Modal, le serveur ne fait que valider
+ stocker sur R2).

## 2026-05-28 — Auth: silent session refresh (fix 1h auto-logout)

- Worker: nouvelle route `POST /api/auth/refresh` (`worker.ts`).
  Lit le cookie `mfm-refresh` (30 jours), appelle Supabase
  `/auth/v1/token?grant_type=refresh_token`, re-set les 2 cookies
  HttpOnly avec le nouveau pair access/refresh. Sur rejet (refresh
  révoqué/expiré/user supprimé): wipe les cookies, retourne 401 →
  next /api/me redirige proprement vers /login.
- Renderer (`cloud-overrides.js`):
  - setInterval refresh toutes les 50 min (< 1h TTL access_token).
  - + listener visibilitychange/focus: si > 40 min depuis dernier
    refresh, re-refresh tout de suite (browsers throttle setInterval
    sur tabs hidden, sinon user revenu après 2h se retrouvait
    logout).

Pourquoi: le worker ne refreshait jamais l'access_token. Cookie
`mfm-session` Max-Age=3600s, Supabase JWT exp=1h par défaut → /api/me
retournait 401 au bout d'1h pile, frontend redirigeait sur /login.
Maintenant la session vit aussi longtemps que le refresh token (30j).

## 2026-05-28 — Fill Holes: diagnostic + bump default size

- `_jsFillHoles` retourne maintenant `{ geometry, helpers, stats }` avec
  `stats: { loops, filled, tooBig, biggest }`.
- `_mtRunPreview`: stocke `out.stats` dans `mtState.lastStats` pour que
  `previewStatus()` puisse l'afficher.
- Schema `fill_holes`:
  - default 100 edges → **2000**, max 5000 → **20000** (les trous sur les
    meshes Trellis2 font souvent 500-3000 edges, le default 100 était
    trop bas et tout passait en "rouge - too big" silencieusement).
  - subtitle mentionne "If nothing highlights, the dark patches are
    texture/back-faces, not geometry holes" — explicite que Fill Holes
    ne sait traiter QUE des trous géométriques.
  - `previewStatus()`: rend "X holes found · Y filled (green) · Z too big
    (red, biggest N edges). Raise the slider to fill more." OU "No
    boundary edges found" si le mesh est closed.

Pourquoi: user montre un orc avec des "trous" visuels que Fill Holes ne
remplit pas. Causes possibles: (1) ce sont des artefacts texture/back-face
pas de la géométrie (cas le plus probable sur sortie Trellis2), ou
(2) les trous sont plus grands que les 100 edges du default. Le status
permet maintenant de distinguer les deux cas sans deviner.

## 2026-05-28 — Fill Holes: weld-by-position avant détection boundary

User montre Fill Holes sur l'orc — le mesh entier apparaît en vert
(=tous les edges sont marqués comme boundary). Cause: les GLB sortis
de Trellis2 splittent les vertices à chaque seam UV → la même edge
physique apparaît avec des indices DIFFÉRENTS de chaque côté du seam
→ `undirectedCount[key] === 1` pour chacun de ces edges → boundary.

Fix (`_jsFillHoles`):
- Quantize positions (1e-4) en "groups" comme le smooth tool.
- Edge counting fait en GROUP space (pas en vertex space). Une edge
  seam = 1 paire de groups partagée par 2 triangles → count=2 →
  non-boundary. Une vraie edge boundary = 1 paire avec count=1.
- Boundary loop walking dans group space.
- Triangulation: chaque group de la loop a un "représentant" (le
  premier vertex qu'on a vu dans ce group). Le centroid + les
  triangles utilisent ces représentants.

Pourquoi: identique au bug de Smooth (résolu mois dernier). On
généralise la stratégie weld-groups à tous les algos qui se basent
sur la topologie locale.

## 2026-05-28 — Auth: refresh-on-401 dans patchedFetch (idle-tab fix)

User toujours déconnecté malgré le setInterval refresh — parce que :
- Browsers throttle `setInterval` sur tabs hidden (1 fire/min max,
  parfois moins). Un onglet idle 1h+ ne refresh PAS toutes les 50 min.
- Au retour de l'utilisateur, le mfm-session cookie est expiré, la
  première requête API retourne 401, et le patchedFetch existant
  redirigeait IMMÉDIATEMENT vers /login sans tenter refresh.

Fix (`cloud-overrides.js`):
- Sur 401 same-origin /api/* (sauf /api/auth/* pour éviter les boucles):
  appelle /api/auth/refresh, puis REPLAY la requête originale. Ne
  redirige sur /login que si refresh+retry échouent tous les deux.
- Promise `_refreshInFlight` partagée: si 5 requêtes hit 401 en même
  temps, on ne fait qu'un seul refresh, pas 5.

Combiné avec le setInterval (le "happy path" pour tabs actifs), le
refresh-on-401 couvre le cas "tab idle puis retour" qui était le
trou dans le filet.

## 2026-05-28 — Fill Holes: dual slider min/max + grey bucket

User veut pouvoir filtrer "trous trop petits" (micro-cracks) en plus de
"trous trop gros". Refactor de `_jsFillHoles(geom, min, max)`:

- 3-state classification par loop: tooSmall (grey lines 0x888888) /
  fillable (green 0x22cc66) / tooBig (red 0xff3344).
- Schema fill_holes: 2 params `min_hole_size` (default 3) +
  `max_hole_size` (default 2000), tous deux 3..20000.
- Stats étendues: { loops, filled, tooBig, tooSmall, biggest, smallest }.
- previewStatus rend une phrase composée: "5 holes found · 2 filled
  (green) · 1 too small (grey) · 2 too big (red) · range 4–4127 edges.
  Adjust min/max to include more."

Note importante pour le user: si le mesh est topologiquement clos
(status "No boundary edges found"), les patches sombres visibles à
l'écran ne sont PAS des trous géométriques — c'est du texture/back-face.
Fill Holes ne peut rien y faire; il faut Fix Normals ou Re-Texture.

## 2026-05-28 — Center → "Set pivot point" + Fill Holes detection v3

User feedback: (1) "Center doit permettre de modifier le pivot point
du mesh" — UI inspirée d'Unreal Modeling Mode (boutons toggle Center
/Bottom/Top/Left/Right/Front/Back/World Origin + gizmo dans le viewer).
(2) "Le mesh a des trous (peints en rouge via paint)" — mon weld
Q=1e4 ratait les vrais trous sur ce mesh.

Changes:
- `_jsSetPivot(geom, mode)`: translate les vertices pour placer le
  landmark AABB choisi à local (0,0,0). Retourne `{ geometry, helpers:
  [pivotGizmo] }` avec AxesHelper + sphère jaune.
- `_makePivotGizmo(size)`: gizmo rendu avec depthTest:false + renderOrder
  999 pour rester visible même à l'intérieur du mesh.
- Type d'input `toggle-group`: row de boutons, un seul actif à la fois,
  stocke la valeur dans dataset.value, déclenche _mtSchedulePreview au
  click. Lu par _mtCollectVals.
- Schema `center`: titre "Set pivot point", params toggle-group avec
  les 8 modes.
- `_jsCenter(geom)` devient wrapper sur `_jsSetPivot(geom, 'bottom')
  .geometry` pour compat avec Modal-side `center` (qui ne connait que
  bottom).

Fill Holes v3 (`_jsFillHoles`):
- **Welding ADAPTATIF**: tolerance = bbox_diagonal / 1e5 au lieu d'un
  Q=1e4 absolu. Sur un mesh tiny (< 1 unité) le Q=1e4 fixe mergait des
  vertices distants de 0.1mm qui étaient des vrais bords de trou.
  Maintenant le tolerance est relatif à la taille du mesh.
- **Multi-successor**: `boundarySuccessors` est un Map<group, group[]>
  au lieu de Map<group, group>. Une vertex partagée entre 2 trous (T-
  junction) garde TOUS ses successeurs au lieu d'écraser. Le loop
  walker pop chaque successor une fois → découvre tous les loops.
- **Non-manifold edges**: count !== 2 = candidat. Avant on ne prenait
  que count===1. Les edges count>=3 (Trellis2 marching-cubes laisse
  beaucoup d'intersections T-junction) sont maintenant détectées
  comme trous candidats.

Tests à faire: re-ouvrir Fill Holes sur l'orc qui montrait "No
boundary edges found" — devrait maintenant détecter les patches noirs.

## 2026-05-28 — Fix Normals: weld across UV seams (kill criss-cross shading)

User montre un mesh Trellis2 où la surface des muscles est cassée
par des "traits de jonction" — pattern criss-cross / plaques d'écailles
qui suit la topologie. Ces lignes correspondent aux UV seams: à chaque
island boundary, Trellis2 duplique le vertex (positions identiques, UVs
différentes). `computeVertexNormals()` calcule chaque duplicate à partir
de SES faces incidentes uniquement → les normales des deux copies
divergent légèrement → discontinuité d'éclairage visible.

Fix (`_jsFixNormalsWelded`):
- Run `computeVertexNormals` comme avant
- Quantize positions (adaptive Q = 1e5 / bbox_diag)
- Group vertices par position
- Somme les normales par group, normalise
- Copy back à tous les members du group → tous les duplicates partagent
  la même normale moyenne

Positions et UVs intacts (on ne touche que l'attribut normal). Seam
visible disparaît. Schema `fix_normals` retitled "Fix normals (weld UV
seams)" + subtitle explicative.

## 2026-05-28 — Set pivot point: gizmo-only preview + manual XYZ + free

User feedback x3:
- "Vraiment besoin de faire payer ça ? (on utilise le cloud?)" — non,
  c'est un translate, ça peut se faire en JS. Ajout flag
  `clientApplyOnly: true` sur le schema; le modal hide le bouton "Apply
  on cloud" entièrement et relabel le device button "⚡ Apply".
- "Le pivot point qui bouge pas le mesh" — actuellement preview()
  translatait les vertices → le mesh sautait dans le viewer à chaque
  changement. Refactor: `_jsSetPivotPreview` ne touche PAS la geometry,
  juste positionne le gizmo au pivot point local. Le mesh reste fixe.
- "Bouger le pivot manuellement" — ajout de 3 sliders X/Y/Z offset
  (-1..1 mesh units) en plus des 8 presets. Le pivot final = preset +
  offset. Le gizmo bouge live à chaque drag de slider.

Plomberie:
- Nouveau hook schema `applyClient(geom, vals)` qui retourne la geom
  transformée. Le preview reste "léger" (gizmo only), l'apply fait la
  vraie transformation. `_mtApplyOnDevice` swap les geoms via
  applyClient avant l'export GLTF, puis restore au finally.
- `clientApplyOnly: true` bypass le check device-capable (l'opération
  est suffisamment légère pour tourner même sur mobile).

Set pivot point devient donc: gratuit, visuellement stable, et
manuellement ajustable.

## 2026-05-28 — Fix Normals: flip reversed-winding triangles + revert
##                fill_holes non-manifold detection

User montre Fill Holes v3 → plein de clusters verts partout (non-
manifold T-junctions de Trellis2 marching-cubes) mais les VRAIS gros
trous noirs visibles ne sont toujours pas détectés en boundary. C'est
parce qu'ils ne sont PAS topologiquement des holes — ce sont des
triangles à winding inversé qui font du back-face culling visible.

Changes:

1. **Fill Holes** revert au filter strict `count === 1` (vraie
   boundary uniquement). Garde le multi-successor + welding adaptatif,
   mais ne traite plus les count≥3 (T-junctions). Sans ce filtre, le
   preview noyait l'écran de bruit non-manifold et masquait les vrais
   boundaries.

2. **Fix Normals** étendu:
   - Pass 1: pour chaque triangle, calcule face_normal × direction vers
     le mesh centroid (AABB). Si dot > 0 = triangle pointe vers
     l'intérieur = winding inversé → swap indices 1 et 2 pour flipper.
   - Pass 2: computeVertexNormals (avec winding corrigé).
   - Pass 3: weld normals across UV seam groups (déjà existant).

Pourquoi: les "trous noirs" visibles sur le mesh Trellis2 sont
généralement des triangles présents mais à winding inversé (le
marching-cubes/PBR baking laisse ça parfois). Avec back-face culling,
ils rendent noir et donnent l'illusion d'un trou. Le flip + recompute
les rend visibles.

Heuristique du centroid: marche bien sur formes convexes ou globalement
"humanoïdes". Pour des formes très concaves (creux, tubes), faux
positifs possibles — mais l'utilisateur peut toujours regenérer s'il
voit du flou.

## 2026-05-28 — Fix Normals: rollback du winding-flip (heuristique foireuse)

User screenshot: après Fix Normals avec mon flip-pass, le mesh est
PIRE qu'avant — le centroïde AABB heuristique a flippé beaucoup trop
de triangles légitimes (bras, armure, plis) parce que sur une forme
humanoïde concave, la direction "vers le centroïde" n'est PAS toujours
opposée à la normale extérieure.

Rollback: retire la pass 1 (winding flip) de `_jsFixNormalsWelded`.
Garde la pass UV seam normal welding (qui marchait bien isolément).
Schema subtitle ajusté: "(Black patches → regenerate, real flip is
TODO with local-coherence heuristic.)"

Solution future: pass de cohérence LOCALE — pour chaque triangle,
comparer sa face_normal contre la moyenne des face_normals de ses
voisins (partageant une edge). Si dot < 0 = flippé par rapport au flux
local. Bien plus robuste que le centroïde global, mais demande
construction d'une adjacency map. Pas implémenté.

## 2026-05-28 — Mesh viewers: force DoubleSide everywhere

Approche pragmatique pour les "trous noirs" qui ne sont pas vraiment
des trous topologiques: force `material.side = THREE.DoubleSide` sur
tous les meshes chargés, à 2 endroits:
- `_mtLoadMesh` (modal viewer pour les mesh tools)
- `_applyMeshTextureFilter` (workspace viewer — appelé par tous les
  chargements GLTF)

Effet: les triangles à winding inversé qui se rendaient en noir
(back-face culling) sont maintenant visibles des deux côtés → les
"trous" disparaissent visuellement.

Bonus: GLTFExporter écrit `doubleSided: true` dans le GLB exporté
quand `material.side === DoubleSide`. Donc Apply on device sauvegarde
le mesh avec ce flag → Unreal/Unity importera aussi en double-sided.

Limites:
- C'est un workaround visuel, pas une correction topologique. Les
  triangles à winding inversé restent dans le mesh.
- Coût léger de rendering (les deux faces sont dessinées).
- L'export Apply on device propage le flag; l'export via Modal mesh-op
  pourrait ne pas le faire (à vérifier si problème).

## 2026-05-28 — Set pivot point: drop geom.clone() + Reset offsets button

User feedback: "si je bouge le slider, le pivot point met quelques
instants à bouger" + "j'aimerais un bouton reset offsets".

Causes:
- `_jsSetPivotPreview` faisait `geom.clone()` à chaque tick et par
  submesh. Sur un mesh à 6 submeshes × 100K vertices, le clone coutait
  ~30-100 ms par drag → lag perceptible.
- Pas de moyen rapide de remettre les 3 sliders X/Y/Z à 0 sauf les
  bouger un par un.

Changes:
- `_jsSetPivotPreview` retourne maintenant `{ geometry: geom }` au
  lieu de `geom.clone()`. C'est OK parce que preview ne modifie pas la
  geometry — la modification réelle est dans applyClient. _mtRunPreview
  réassigne `e.mesh.geometry = geom` qui est la même référence → no-op.
- Nouveau flag schema `resetButton: 'Label du bouton'`. Si défini, un
  bouton ↺ apparaît sous les params et remet TOUS les params type
  range/number à leur default. Sur le schema `center`, valeur "Reset
  offsets" → reset les sliders X/Y/Z.

Le slider est maintenant fluide (< 16ms par tick) et le reset est en
1 clic.

## 2026-05-28 — Set pivot point: Unreal-style draggable gizmo

User: "j'aimerais pouvoir décaler le pivot point en dragant le logo du
pivot point, il faut que ca fasse comme dans unreal (si je click sur
les axes = déplacement orthonormé, si je click sur la boule
déplacement perpendiculaire à l'écran)".

Implementation: three.js `TransformControls` from
`three/addons/controls/TransformControls.js`. Lazy-loaded the first
time a schema sets `useTransformGizmo: true`. Provides exactly the
Unreal Modeling Mode widget: 3 colored axis arrows + center sphere.
Click axis = constrained to that axis; click sphere = free-move in
view plane.

Plumbing:
- `_mtEnsureTransformGizmo()`: lazy import + dummy Object3D + drag
  handler. dragging-changed disables OrbitControls to prevent the
  camera from orbiting while the user holds the gizmo.
- `change` event: reads dummy.position - basePivot → writes into the
  X/Y/Z offset sliders → triggers _mtSchedulePreview. Only acts when
  `tc.dragging === true` so our own programmatic moves (each tick)
  don't loop back.
- `_mtRunPreview` ensures the dummy is parented to origModel
  (mesh-local space matches the schema's offset coords) and the TC
  is in the scene; sets basePivot from preset-only, dummy position
  from preset+offset.
- The custom AxesHelper gizmo (`_makePivotGizmo`) is now suppressed
  when the schema declares useTransformGizmo (avoid duplicate
  visualization fighting with the TC overlay).
- Modal close + _mtApplyOnDevice both detach the dummy/TC to avoid
  leaking them into the exported GLB.

Side report (Fill Holes deep-dive, for future port): Unreal uses
FMinimalHoleFiller — iterative remesh pipeline (fan → remesh →
collapse/flip/flatten/curvature passes), NOT Liepa 2003 directly.
Critical pre-pass missing in our JS: FMergeCoincidentMeshEdges with
escalating tolerance (bbox*1e-6 → 1e-3) matching by midpoint +
opposite orientation. Bowtie handling uses tangent-plane smallest-
loop turn. Liepa DP with lexicographic (max-dihedral, area) weight
remains canonical for moderate loops (≤200 verts). Reference source:
geometry3Sharp (C# precursor, Ryan Schmidt → Epic). On the TODO.

## 2026-05-28 — Set pivot point: fix gizmo invisible on three r170

User report: "je ne vois plus le gizmo pour le pivot point". Cause:
three.js **r166** split TransformControls into a logic object + a
separate visual helper. Adding the TC directly to the scene no longer
renders the gizmo — you have to use `tc.getHelper()` and add THAT to
the scene.

We pin three@0.170.0 in index.html (`<script type="importmap">`), so
this affects us.

Fix in `_mtRunPreview` and `_mtDisableTransformGizmo`:
- Store `mtState.transformControlsHelper = tc.getHelper()` on
  activation.
- Add the helper (not the TC) to the scene.
- On disable, remove the helper from its parent.

Also renamed the workspace toolbar button "Center" → "Pivot" per user
request (the schema-side title was already "Set pivot point", the
toolbar label was the legacy one).

## 2026-05-28 — Paint Emissive tool (web cloud version)

User wants to paint emissive zones (lamps, windows, runes) on a mesh,
following the same convention as their apovivor BuildingSlicer
plugin: dedicated `T_emissive` texture + color tint + intensity
scalar, all wired to `material.emissiveMap` + `emissiveIntensity` on
MeshStandardMaterial.

Sub-agent confirmed that BuildingSlicer doesn't do interactive
painting itself (it auto-detects an externally-authored mask). So
the brush + raycast → UV → canvas pipeline is brand new for us.

Architecture (`cloud/public/app/index2.js`):
- New modal `modal-paint-emissive` with a 3D viewport + brush
  controls (color picker, intensity 0.1..20, size 2..200 px, opacity
  0..100%, soft falloff 0..100%, paint/erase mode, clear all).
- Dedicated viewport state `peState` (separate from mesh-tool modal
  to avoid coupling), own OrbitControls with LEFT=null (reserved
  for painting), RIGHT=rotate, MIDDLE=pan.
- `_peSetupCanvasAndBind`: builds a 1024×1024 black canvas, wraps it
  in CanvasTexture (name `T_emissive`, flipY=false for glTF), binds
  to every material's emissiveMap. Saves previous emissive state so
  Cancel restores cleanly.
- `_peStampAtPointer`: raycaster.intersectObject → hit.uv → draw a
  radial-gradient circle at uv × 1024 on the canvas, mode='source-over'
  for paint, 'destination-out' for erase. Falloff slider controls
  how much of the brush radius is gradient vs solid.
- Color picker output goes into the canvas pixel; emissiveIntensity
  slider drives the material scalar (matches BuildingSlicer's
  EmissiveColor × EmissiveStrength split).
- Apply (free, device-only): GLTFExporter binary export including
  embedded T_emissive PNG → POST to /api/mesh-op/client-result →
  push new URL into project meshes.

Toolbar button added under Manual Tools: 💡 Paint Emissive.

## 2026-05-28 — Paint Emissive: desktop port

User: "il faut aussi que le desktop le fasse". Mirrored the cloud
implementation verbatim to `src/renderer/index2.html` (button + modal)
and `src/renderer/index2.js` (peState + painting + GLTFExporter).

Difference vs cloud build:
- `_peLoadMesh` uses `API.readMeshFile()` instead of `fetch()` to
  bypass file:// CORS on Electron.
- `_peApplyOnDevice` writes via `API.saveBuffer({ path, base64 })`
  to a sibling file `<orig>_emissive_<timestamp>.glb` next to the
  source mesh, then pushes that local path into `p.meshes`.

The painted T_emissive texture is embedded in the GLB on both
builds, so the saved file is portable between desktop and cloud
viewers.

## 2026-05-28 — Fill Holes v5: degenerate strip + MergeCoincidentEdges

User: "fill hole ne marche pas même après fix normal" — Fill Holes
still reports "No boundary edges found" on the orc with visible black
patches.

Following the Unreal/geometry3Sharp report from the earlier agent
run, ported the two critical pre-passes our v4 was missing:

1. **Strip degenerate triangles** before counting. Trellis2 marching
   cubes emits many zero-area triangles (cross product magnitude
   < bbox*1e-12). They show up as false count===1 edges that pollute
   the boundary candidate set.

2. **MergeCoincidentEdges with midpoint + opposite orientation
   matching**. After the position-quantize weld (Step 3), some seam
   edges still slip past as count===1 because their endpoints
   missed the weld tolerance. For each candidate boundary edge,
   spatial-hash search a generous tolerance (bbox/2000 = 0.05% of
   mesh) for a candidate with REVERSED orientation whose endpoints
   match in position space. If found, mark BOTH as matched — they
   were a seam pair, not a real boundary. This is UE's
   FMergeCoincidentMeshEdges in essence (single tolerance level for
   now; escalating 1e-6 → 1e-3 deferred).

Only the surviving (unmatched) candidates feed boundarySuccessors
for loop walking. Logic from Step 7 onward unchanged.

Desktop renderer is untouched — it uses the Python pipeline for
fill_holes; only cloud has the JS detector.

## 2026-05-28 — Contact form + admin Messages tab

Wired the About → "Contact us" link to a real form:
- New `contact-modal` HTML in index.html (name/email/subject/message).
- POST /api/contact (no auth) handler in worker.ts. Stores under
  `_meta/contact/<id>.json`. Anti-spam: max 5 messages/IP/day +
  200 global/day, counters in R2 `_meta/contact_count/YYYY-MM-DD/`.
- Attaches authenticated user_id + user_email if present.
- GET /api/admin/contact-messages → list (newest first).
- POST /api/admin/contact-messages/<id>/read → flip `read` flag.
- DELETE /api/admin/contact-messages/<id> → remove.
- New Activity tab "✉️ Messages" in admin.html with unread badge.
  Auto-polls every 60s for new messages. Mail-to-reply link uses
  the reply-to email or the signed-in user email.

Also relabeled the About modal links: kept "Website" but added
"Privacy" + "Terms" (real anchors to /legal/*) and replaced FAQ with
the Contact link. GitHub link removed.

## 2026-05-28 — Paint Emissive: UV flip + intensity defaults

User: "l'emissive texture ne marche pas correctement" — paint was
landing at the WRONG location on the mesh (offset by the V axis)
and the building looked over-saturated.

Two fixes (cloud + desktop):
- **flipY mismatch**: I set `texture.flipY = false` (correct for
  glTF v-down convention) AND was doing `py = (1 - uv.y) * size`
  manually. That's a double-flip → painted spot mirrored vertically
  from where the user clicked. Removed the manual flip; canvas Y
  now matches uv.v 1:1.
- **Intensity default 3.0 → 1.0**: at 3.0 the canvas RGB got
  multiplied 3× → channels clipped to 1.0 → orange/blue paint
  rendered as white. With 1.0 the canvas color shows up faithfully;
  >1.0 still works as HDR boost for users who want hot glow.

## 2026-05-28 — Emissive layer: persistent cache + thumbnail badge

Fixed "Load from image layer ne fait rien" + added thumbnail badge.
- Migrated layer storage from `project._emissiveLayerByImage` (wiped
  by reloadCurrentProject after Save) to a module-level Map mirrored
  to localStorage `fabmesh.emissiveLayers`.
- Paint Tools Save now also writes the layer under the new "_painted"
  path returned by saveImageDataUrl, so the lookup at Paint Emissive
  3D open succeeds whichever painted version was used for 3D gen.
- _peTryProjectFromImageLayer falls back to any project image that
  has a layer if the currently-selected one doesn't.
- New 💡 badge on image version thumbnails (bottom-right, gold ring)
  when _emissiveLayerHas(img.path) is true.

Cloud + desktop renderers in sync.

## 2026-05-28 — Paint Emissive: 250MB cap + cleaner Apply button

User hit HTTP 413 on Apply because GLTFExporter re-embedding the
full PBR set + new emissive PNG pushed the Trellis2 output past
the worker's 100MB cap. Bumped /api/mesh-op/client-result to
250MB (335M base64 chars). Removed the ⚡ glyph from the Paint
Emissive apply button.

## 2026-05-28 — Edit modals: full-screen + Recenter button

User complained the Paint Tools / Draw Mask / Clone Stamp popups
were too small (image microscopic after wheel-zoom-out) and asked
for a recenter button. Forced width:95vw + height:95vh on all 3
modal-content divs (cloud + desktop). Added CanvasManager.recenter()
(zoom=1 + pan=0 + re-apply transform) and a ⊚ button on each modal
toolbar that calls it. canvas-utils.js + index2-edit-tools.js synced
cloud→desktop so the helper is identical on both.
