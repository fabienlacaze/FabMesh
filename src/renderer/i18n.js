/* ============================================================================
 * FabMesh i18n — lightweight, framework-free, shared desktop + cloud.
 *
 * English is the SOURCE language (the UI is authored in English). Each other
 * language is a dictionary mapping the exact English string -> translation.
 * applyLang() walks the DOM (text nodes + placeholder/title/aria-label attrs),
 * caches each node's original English, and swaps it for the active language —
 * so switching back to English restores the originals. Dynamically-added
 * content is re-translated by a childList MutationObserver (debounced).
 *
 * Untranslated strings simply stay English (graceful fallback), so the
 * dictionaries can grow incrementally without ever breaking the UI.
 *
 * Add a language: extend I18N below + add an <option> to #lang-select.
 * Add strings:    add "English": "Traduction" pairs to the language map.
 * In JS code:     wrap user-facing strings with FabI18n.t('English text').
 * ========================================================================== */
(function () {
  'use strict';

  const I18N = {
    fr: {
      // ---- 3D construction stages (Études de construction 3D) ----
      '3D construction stages': 'Études de construction 3D',
      '3D construction study': 'Études de construction 3D',
      "Fabricate the 3D meshes of the construction stages (sliced building + timber frame + scaffolding), navigable and exportable. The final mesh stays intact as the last stage.":
        "Fabrique les meshes 3D des étapes de construction (bâtiment tranché + charpente + échafaudage), navigables et exportables. Le mesh final reste intact et sert de dernière étape.",
      'Number of stages': "Nombre d'étapes",
      'From 2 to 20. Geometric fabrication (~1 s per stage).': 'De 2 à 20. Fabrication géométrique (~1 s/étape).',
      'Scaffold material': "Matériau de l'échafaudage",
      'Wood': 'Bois', 'Metal (galvanized steel)': 'Métal (acier galvanisé)', 'Bamboo': 'Bambou',
      "The texture adapts to the building's render style.": "La texture s'adapte au style de rendu du bâtiment.",
      'Fabricate': 'Fabriquer',
      'Fabricate the 3D meshes of the construction stages (sliced building + frame + scaffolding), navigable and exportable':
        "Fabrique les meshes 3D des étapes de construction (bâtiment tranché + charpente + échafaudage), navigables et exportables",
      // ---- Uninstall popup ----
      'Uninstall MyFabmesh.AI': 'Désinstaller MyFabmesh.AI',
      'This removes the app. Optionally, also delete:': "Ceci retire l'application. En option, supprimer aussi :",
      'Delete the AI models (~17 GB)': 'Supprimer les modèles IA (~17 Go)',
      'Re-downloadable — keep to reinstall without downloading again.': 'Re-téléchargeables — garde-les pour réinstaller sans re-télécharger.',
      'Delete my generated content': 'Supprimer mes contenus générés',
      'Your projects, source images and 3D meshes.': 'Tes projets, images sources et meshes 3D.',
      'Delete my settings': 'Supprimer mes réglages',
      'Config and logs.': 'Configuration et logs.',
      'Nothing checked = your creations and models are kept.': 'Rien de coché = tes créations et modèles sont conservés.',
      'Uncheck an item to keep it after uninstalling.': 'Décoche un élément pour le conserver après la désinstallation.',
      'Uninstall': 'Désinstaller',
      'Uninstalling MyFabmesh.AI… (running silently)': 'Désinstallation de MyFabmesh.AI… (en cours, silencieux)',
      // ---- Part naming (Nommer les zones) ----
      'Name the zones (AI)': 'Nommer les zones (IA)',
      'What kind of object is this? (sets the naming vocabulary)':
        'De quel type d’objet s’agit-il ? (définit le vocabulaire de nommage)',
      'Vehicle': 'Véhicule', 'Character / Creature': 'Personnage / Créature',
      'Building': 'Bâtiment', 'Object (generic)': 'Objet (générique)',
      'Named zones': 'Zones nommées',
      'Unknown': 'Inconnu',
      '{x} zones named': '{x} zones nommées',
      'Naming failed': 'Échec du nommage',
      'Naming error': 'Erreur de nommage',
      'Segment the mesh into parts first (scissors), then name the zones.':
        'Segmente d’abord le mesh en parties (ciseaux), puis nomme les zones.',
      // Labels de parties (source EN prettifiée → FR)
      'Wheel': 'Roue', 'Continuous track': 'Chenille', 'Turret': 'Tourelle',
      'Cannon barrel': 'Canon', 'Hull': 'Caisse', 'Hatch': 'Trappe',
      'Antenna': 'Antenne', 'Headlight': 'Phare', 'Fender': 'Garde-boue',
      'Exhaust': 'Échappement', 'Fuel tank': 'Réservoir', 'Machine gun': 'Mitrailleuse',
      'Propeller': 'Hélice', 'Cockpit': 'Cockpit', 'Rotor': 'Rotor',
      'Head': 'Tête', 'Torso': 'Torse', 'Pelvis': 'Bassin',
      'Left arm': 'Bras gauche', 'Right arm': 'Bras droit', 'Arm': 'Bras',
      'Left leg': 'Jambe gauche', 'Right leg': 'Jambe droite', 'Leg': 'Jambe',
      'Left hand': 'Main gauche', 'Right hand': 'Main droite', 'Hand': 'Main',
      'Left foot': 'Pied gauche', 'Right foot': 'Pied droit', 'Foot': 'Pied',
      'Tail': 'Queue', 'Wing': 'Aile', 'Left wing': 'Aile gauche', 'Right wing': 'Aile droite',
      'Hair': 'Cheveux', 'Weapon': 'Arme', 'Shield': 'Bouclier',
      'Roof': 'Toit', 'Wall': 'Mur', 'Door': 'Porte', 'Window': 'Fenêtre',
      'Stairs': 'Escalier', 'Chimney': 'Cheminée', 'Balcony': 'Balcon',
      'Column': 'Colonne', 'Foundation': 'Fondation',
      'Blade': 'Lame', 'Handle': 'Manche', 'Guard': 'Garde', 'Barrel': 'Canon',
      'Stock': 'Crosse', 'Magazine': 'Chargeur', 'Scope': 'Lunette',
      'Trigger': 'Détente', 'Grip': 'Poignée',
      // ---- Generation history popup ----
      'AI': 'IA',
      'Generation history': 'Historique de génération',
      'View generation history': "Voir l'historique de génération",
      'Source image': 'Image source',
      'Mesh generated': 'Mesh généré',
      'Modification': 'Modification',
      'Parameters not tracked (generated before history tracing)':
        "Paramètres non tracés (généré avant le traçage d'historique)",
      'No history available for this item.': 'Aucun historique disponible pour cet élément.',
      // ---- Version lineage badge (mesh versions strip) ----
      'Version — from {x} after {y}': 'Version — issue de {x} après {y}',
      'Version — after {x}': 'Version — après {x}',
      'View the source image that generated this mesh': "Voir l'image source qui a généré ce mesh",
      'Segmented into parts (AI)': 'Segmenté en parties (IA)',
      'part segmentation': 'segmentation en parties',
      'smoothing': 'lissage',
      'decimation': 'décimation',
      'subdivision': 'subdivision',
      'hole filling': 'bouchage des trous',
      'normals fix': 'correction des normales',
      'recentering': 'recentrage',
      'pivot adjustment': 'réglage du pivot',
      'watertight sealing': 'étanchéification',
      'texture variation': 'variation de texture',
      'editing': 'édition',
      'upscale': 'upscale',
      'refinement': 'affinage',
      'augmentation': 'augmentation',
      'vertex colors': 'couleurs de sommets',
      're-texture': 're-texture',
      // ---- Top bar / nav ----
      'Projects': 'Projets',
      'New project': 'Nouveau projet',
      'New Project': 'Nouveau projet',
      'Marketplace': 'Marketplace',
      'Settings': 'Paramètres',
      'Open Cloud': 'Ouvrir le Cloud',
      // ---- Workspace steps ----
      'Image': 'Image',
      'Mesh': 'Maillage',
      '3D Mesh': 'Maillage 3D',
      'Rig': 'Squelette',
      'Animation': 'Animation',
      'In progress': 'En cours',
      'IN PROGRESS': 'EN COURS',
      'Done': 'Terminé',
      'DONE': 'TERMINÉ',
      'Generating': 'Génération',
      'GENERATING': 'GÉNÉRATION',
      'Create new': 'Créer',
      'CREATE NEW': 'CRÉER',
      'EDIT SELECTED': 'ÉDITER LA SÉLECTION',
      'Edit selected': 'Éditer la sélection',
      'Generate a new image from a text prompt': 'Générer une nouvelle image depuis un texte',
      // ---- Create-new form ----
      'Asset type': "Type d'asset",
      'ASSET TYPE': "TYPE D'ASSET",
      'Style': 'Style',
      'STYLE': 'STYLE',
      'Describe your asset': 'Décrivez votre asset',
      'Description (prompt)': 'Description (prompt)',
      'Count': 'Nombre',
      'COUNT': 'NOMBRE',
      'Quality': 'Qualité',
      'QUALITY': 'QUALITÉ',
      'Engine': 'Moteur',
      'Construction stages (3 progressive versions)': 'Étapes de construction (3 versions progressives)',
      'Copy': 'Copier',
      'Enhance': 'Améliorer',
      'Generate': 'Générer',
      'Generate new version': 'Générer une nouvelle version',
      'Generate Rig': 'Générer le squelette',
      'Generate variant': 'Générer une variante',
      'Live progress of jobs running for this step': 'Progression en direct des tâches de cette étape',
      // ---- Asset type options ----
      'Character / Unit (RTS, RPG)': 'Personnage / Unité (RTS, RPG)',
      'Building / Structure': 'Bâtiment / Structure',
      'Animal': 'Animal',
      'Vehicle': 'Véhicule',
      'Custom (no preset)': 'Personnalisé (sans préréglage)',
      // ---- Common buttons / actions ----
      'Cancel': 'Annuler',
      'Apply': 'Appliquer',
      'Close': 'Fermer',
      'Save': 'Enregistrer',
      'Delete': 'Supprimer',
      'Create project': 'Créer le projet',
      'Unlock': 'Déverrouiller',
      'Check my PC first': "Vérifier mon PC d'abord",
      // ---- Auto Inpaint modal ----
      'Auto Inpaint': 'Retouche auto',
      'Describe what to replace — the AI finds and repaints it.':
        "Décrivez quoi remplacer — l'IA le trouve et le repeint.",
      'Target (what to find)': 'Cible (quoi trouver)',
      'TARGET (WHAT TO FIND)': 'CIBLE (QUOI TROUVER)',
      'Replace with (leave empty = remove)': 'Remplacer par (vide = supprimer)',
      'REPLACE WITH (LEAVE EMPTY = REMOVE)': 'REMPLACER PAR (VIDE = SUPPRIMER)',
      'Detection padding': 'Marge de détection',
      'DETECTION PADDING': 'MARGE DE DÉTECTION',
      'Preview mask': 'Aperçu du masque',
      'Detecting target…': 'Détection de la cible…',
      // ---- Variant modal ----
      'Create variant': 'Créer une variante',
      'Variant': 'Variante',
      'Variation amount': 'Niveau de variation',
      'Number of variants': 'Nombre de variantes',
      // ---- Paint tools ----
      'Select': 'Sélection',
      'Draw': 'Dessin',
      'Color': 'Couleur',
      'Brush': 'Brosse',
      'Opacity': 'Opacité',
      'Hardness': 'Dureté',
      'Tolerance': 'Tolérance',
      'Pen': 'Stylo',
      'Spray': 'Aérographe',
      'Ink': 'Encre',
      'Line': 'Ligne',
      'Smudge': 'Étaler',
      'Fill': 'Remplir',
      'Eraser': 'Gomme',
      'Rect': 'Rectangle',
      'Lasso': 'Lasso',
      'Wand': 'Baguette',
      'Invert': 'Inverser',
      'None': 'Aucune',
      // ---- Misc ----
      'Requirements': 'Configuration requise',
      'Free': 'Gratuit',
      'Language': 'Langue',
      // ---- Update toast ----
      'Update ready': 'Mise à jour prête',
      'A new version is downloaded and ready to install.': 'Une nouvelle version est téléchargée et prête à installer.',
      'Dismiss': 'Ignorer',
      // ---- Drop overlay ----
      'Drop image or mesh file to import': 'Déposez une image ou un fichier de maillage à importer',
      // ---- Top bar (icons / tooltips) ----
      'Back to projects': 'Retour aux projets',
      'Refresh': 'Actualiser',
      'My usage history': "Mon historique d'utilisation",
      'Parental control': 'Contrôle parental',
      'About MyFabmesh.AI': 'À propos de MyFabmesh.AI',
      'Server warming up': 'Serveur en préchauffage',
      'Modal containers': 'Conteneurs Modal',
      'Each container has its own warm-up. Cold = first call takes ~2 min, then warm for ~9 min idle.':
        'Chaque conteneur a son propre préchauffage. À froid = le premier appel prend ~2 min, puis reste chaud ~9 min en veille.',
      // ---- Projects home ----
      'Your projects': 'Vos projets',
      'Search projects...': 'Rechercher des projets...',
      'Select all visible projects': 'Sélectionner tous les projets visibles',
      'Select all': 'Tout sélectionner',
      'Import': 'Importer',
      'Images': 'Images',
      'Meshes': 'Maillages',
      'Rigs': 'Squelettes',
      'No projects yet': 'Aucun projet pour le moment',
      'Create your first 3D character in 3 simple steps.': 'Créez votre premier personnage 3D en 3 étapes simples.',
      '+ Create a project': '+ Créer un projet',
      '+ New project': '+ Nouveau projet',
      // ---- Workspace step statuses ----
      'Pending': 'En attente',
      // ---- Image step (Create new) ----
      'MyFabmesh.AI Image Engine (local)': 'Moteur image MyFabmesh.AI (local)',
      // ---- Asset type options ----
      'Living': 'Vivant',
      'Creature / Beast': 'Créature / Bête',
      'Vehicles': 'Véhicules',
      'Plane': 'Avion',
      'Boat': 'Bateau',
      'Built': 'Construit',
      'Environment piece': "Élément d'environnement",
      'Items': 'Objets',
      'Weapon': 'Arme',
      'Prop / Item': 'Accessoire / Objet',
      'UI Icon (app, button, Unreal widget)': "Icône d'interface (app, bouton, widget Unreal)",
      'Other': 'Autre',
      'Animal (creature)': 'Animal (créature)',
      // ---- Style options ----
      'Realistic': 'Réaliste',
      'PBR (high detail)': 'PBR (haute définition)',
      'Stylized': 'Stylisé',
      'Stylized (mid-poly)': 'Stylisé (mid-poly)',
      'Stylized PBR': 'PBR stylisé',
      'Hand-painted': 'Peint à la main',
      'Cartoon': 'Cartoon',
      'Anime': 'Anime',
      'Painterly': 'Pictural',
      'Comic book': 'Bande dessinée',
      'Ghibli': 'Ghibli',
      'Pixar 3D': 'Pixar 3D',
      'Concept art': 'Concept art',
      'Genre': 'Genre',
      'Dark Fantasy': 'Dark Fantasy',
      'Cyberpunk': 'Cyberpunk',
      'Steampunk': 'Steampunk',
      'Synthwave': 'Synthwave',
      'Horror': 'Horreur',
      'Retro': 'Rétro',
      'Low-poly': 'Low-poly',
      'Pixel art': 'Pixel art',
      'Voxel': 'Voxel',
      'Minecraft': 'Minecraft',
      'Material': 'Matériau',
      'Chrome': 'Chrome',
      'Marble': 'Marbre',
      'Carved wood': 'Bois sculpté',
      'Stained glass': 'Vitrail',
      'Holographic': 'Holographique',
      'Figurine': 'Figurine',
      'Artistic': 'Artistique',
      'Watercolor': 'Aquarelle',
      'Sketch': 'Croquis',
      'Claymation': 'Pâte à modeler',
      'Graffiti': 'Graffiti',
      'Art deco': 'Art déco',
      // ---- Prompt area ----
      'Copy prompt to clipboard': 'Copier le prompt dans le presse-papiers',
      'Enhance the prompt with style and quality keywords': 'Améliorer le prompt avec des mots-clés de style et de qualité',
      'An orc warrior with leather armor...': 'Un guerrier orc en armure de cuir...',
      '30 steps': '30 étapes',
      // ---- Image edit / preview ----
      'No image yet': 'Aucune image pour le moment',
      'View image fullscreen': "Voir l'image en plein écran",
      'Previous version': 'Version précédente',
      'Next version': 'Version suivante',
      'Pick a version, preview it, modify or convert': 'Choisissez une version, prévisualisez-la, modifiez ou convertissez',
      'Copy the prompt used to generate this image': 'Copier le prompt utilisé pour générer cette image',
      'Copy prompt': 'Copier le prompt',
      'Use this image for 3D →': 'Utiliser cette image pour la 3D →',
      // ---- Tool group labels ----
      'File': 'Fichier',
      'AI tools': 'Outils IA',
      'Manual tools': 'Outils manuels',
      'Playback': 'Lecture',
      // ---- Image tools ----
      'Export': 'Exporter',
      'Publish to marketplace': 'Publier sur la marketplace',
      'Modify': 'Modifier',
      'Remove BG': 'Supprimer le fond',
      'Resolution': 'Résolution',
      'Style...': 'Style...',
      'Face Fix': 'Correction du visage',
      'Sym. Auto': 'Sym. auto',
      'Multi-Views': 'Multi-vues',
      'Create variants of the current image — re-roll seed or img2img with controlled strength':
        "Créer des variantes de l'image actuelle — nouvelle seed ou img2img avec une intensité contrôlée",
      'Clone Stamp': 'Tampon de clonage',
      'Draw Mask': 'Dessiner un masque',
      'Crop': 'Rogner',
      'Brightness': 'Luminosité',
      'Color Pick': 'Pipette',
      'Blur Brush': 'Pinceau de flou',
      'Symmetrize': 'Symétriser',
      'Paint': 'Peinture',
      // ---- Mesh step (Create new) ----
      'Convert the selected image into a 3D mesh': "Convertir l'image sélectionnée en maillage 3D",
      'MyFabmesh.AI 3D Native (mesh + PBR in one shot, ~100s, recommended)':
        'MyFabmesh.AI 3D natif (maillage + PBR en une passe, ~100s, recommandé)',
      'Texture': 'Texture',
      'Target triangles': 'Triangles cibles',
      'Construction stages (3 versions)': 'Étapes de construction (3 versions)',
      'Advanced texture options': 'Options de texture avancées',
      'Quality preset': 'Préréglage de qualité',
      'Multi-reference (use front + back photo · +1 cr)': 'Multi-référence (photo avant + arrière · +1 cr)',
      'Detail refine (+~90s · +2 cr · sharper micro-details)': 'Affinage des détails (+~90s · +2 cr · micro-détails plus nets)',
      'Auto-rectify source view (+~36s · +1 cr · better mesh proportions)':
        'Rectification auto de la vue source (+~36s · +1 cr · meilleures proportions de maillage)',
      'Texture smooth (+~12s · free · CPU only, no AI)': "Lissage de texture (+~12s · gratuit · CPU seulement, pas d'IA)",
      'Quality+ (sharper edges · +~30s · +1 cr)': 'Qualité+ (arêtes plus nettes · +~30s · +1 cr)',
      'Ultra Quality (+~50s · +2 cr · fine face detail)': 'Ultra qualité (+~50s · +2 cr · détail fin du visage)',
      'Ultra HD 8K texture (+~5min · +3 cr)': 'Texture Ultra HD 8K (+~5min · +3 cr)',
      'Face fix (+~60s · +2 cr)': 'Correction du visage (+~60s · +2 cr)',
      'PBR baseColor + roughness + metallic exported in the GLB automatically.':
        'baseColor + roughness + metallic PBR exportés automatiquement dans le GLB.',
      'Generate 3D': 'Générer la 3D',
      'Source image for 3D (front)': 'Image source pour la 3D (face)',
      'No image selected': 'Aucune image sélectionnée',
      'Optional back photo (2-view mode)': 'Photo arrière optionnelle (mode 2 vues)',
      'Click to add a back photo for true-back texture': 'Cliquez pour ajouter une photo arrière pour une vraie texture de dos',
      '+ Add back photo': '+ Ajouter une photo arrière',
      'Remove back photo': 'Supprimer la photo arrière',
      'Multi-views (6) — used by texture bake': 'Multi-vues (6) — utilisées par le bake de texture',
      // ---- Mesh edit / preview ----
      'No mesh yet': 'Aucun maillage pour le moment',
      'View 3D fullscreen': 'Voir la 3D en plein écran',
      'Reset camera': 'Réinitialiser la caméra',
      'Camera view': 'Vue caméra',
      'Iso': 'Iso',
      'Front': 'Face',
      'Back': 'Arrière',
      'Left': 'Gauche',
      'Right': 'Droite',
      'Top': 'Dessus',
      'Bottom': 'Dessous',
      'Pivot point': 'Point de pivot',
      'Pivot: bottom': 'Pivot : bas',
      'Pivot: center': 'Pivot : centre',
      'Pivot: top': 'Pivot : haut',
      'Show pivot axes': 'Afficher les axes du pivot',
      'Wireframe': 'Fil de fer',
      'Wire': 'Fil',
      'Toggle PBR / matcap': 'Basculer PBR / matcap',
      'Grid': 'Grille',
      'X-Ray (semi-transparent mesh)': 'Rayons X (maillage semi-transparent)',
      'X-Ray': 'Rayons X',
      'Background': 'Arrière-plan',
      'Dark': 'Sombre',
      'Studio': 'Studio',
      'Black': 'Noir',
      'Gray': 'Gris',
      'Toggle shadows': 'Basculer les ombres',
      'Shadows': 'Ombres',
      'Light intensity': 'Intensité de la lumière',
      'Pick a mesh version, preview, refine or export': 'Choisissez une version de maillage, prévisualisez, affinez ou exportez',
      'Use this mesh for Rig →': 'Utiliser ce maillage pour le squelette →',
      // ---- Mesh tools ----
      'Export...': 'Exporter...',
      'Open in Blender': 'Ouvrir dans Blender',
      'Show in folder': 'Afficher dans le dossier',
      'Smooth': 'Lisser',
      'Reduce the mesh triangle count': 'Réduire le nombre de triangles du maillage',
      'Triangle count': 'Nombre de triangles',
      'Subdivide': 'Subdiviser',
      'Fix Normals': 'Corriger les normales',
      'Fill Holes': 'Boucher les trous',
      'Watertight': 'Étanche',
      'Pivot': 'Pivot',
      'Re-Texture': 'Re-texturer',
      'Sculpt': 'Sculpter',
      'Manually align source photos onto mesh': 'Aligner manuellement les photos source sur le maillage',
      'Align Texture': 'Aligner la texture',
      'Paint Mesh': 'Peindre le maillage',
      'Material adjust': 'Réglage du matériau',
      // ---- Rig step ----
      'Bind a skeleton to your mesh for animation': "Lier un squelette à votre maillage pour l'animation",
      'MyFabmesh.AI Rig (cloud GPU)': 'Squelette MyFabmesh.AI (GPU cloud)',
      'Source mesh for rig': 'Maillage source pour le squelette',
      'No mesh selected': 'Aucun maillage sélectionné',
      'Pick a rig, test animation or export': "Choisissez un squelette, testez l'animation ou exportez",
      'No animation': 'Aucune animation',
      'Play': 'Lire',
      'No rig yet': 'Aucun squelette pour le moment',
      'View rig fullscreen': 'Voir le squelette en plein écran',
      'Show skeleton': 'Afficher le squelette',
      'Bones': 'Os',
      'Use this rig for Animation →': "Utiliser ce squelette pour l'animation →",
      'Export to Unreal': 'Exporter vers Unreal',
      'Edit in Blender': 'Éditer dans Blender',
      'Re-skin only': 'Re-skin uniquement',
      'Landmarks': 'Repères',
      'Test animation': "Tester l'animation",
      // ---- Animation step ----
      'Generate animation clips for your rig via AI': "Générer des clips d'animation pour votre squelette via IA",
      'AnyTop (skeleton-adaptive, BVH)': 'AnyTop (adaptatif au squelette, BVH)',
      'Animations': 'Animations',
      '(check 1+ types — each becomes a new version)': '(cochez 1+ types — chacun devient une nouvelle version)',
      'Prompt': 'Prompt',
      'e.g. dragon breathes fire': 'ex. le dragon crache du feu',
      'Generate Animation': "Générer l'animation",
      'Import reference animation (.fbx)': 'Importer une animation de référence (.fbx)',
      'Auto-detect skeleton': 'Détection auto du squelette',
      'UE5 Mannequin': 'Mannequin UE5',
      'Apovivor ORC_M1': 'Apovivor ORC_M1',
      'Pick an .fbx reference animation': 'Choisir une animation de référence .fbx',
      'Pick .fbx': 'Choisir .fbx',
      'No file': 'Aucun fichier',
      'Retarget the chosen FBX onto your rig': 'Recibler le FBX choisi sur votre squelette',
      'Retarget FBX onto rig': 'Recibler le FBX sur le squelette',
      'Source rig': 'Squelette source',
      'No rig selected': 'Aucun squelette sélectionné',
      'Pick a clip, preview or export': 'Choisissez un clip, prévisualisez ou exportez',
      'No animation selected': 'Aucune animation sélectionnée',
      'Play / Pause': 'Lire / Pause',
      'Loop': 'Boucle',
      'Playback speed': 'Vitesse de lecture',
      'Exposure': 'Exposition',
      'Export FBX': 'Exporter en FBX',
      'Add Animation': 'Ajouter une animation',
      'Import an animated GLB as a new version': 'Importer un GLB animé comme nouvelle version',
      'Import GLB': 'Importer un GLB',
      // ---- New project modal ----
      'Give your project a name and describe what you want to create.':
        'Donnez un nom à votre projet et décrivez ce que vous voulez créer.',
      'Project name': 'Nom du projet',
      // ---- Landmarks fullscreen ----
      'Front view': 'Vue de face',
      'Back view': 'Vue arrière',
      'Left side': 'Côté gauche',
      'Right side': 'Côté droit',
      'Top view': 'Vue de dessus',
      'Bottom view': 'Vue de dessous',
      'Isometric': 'Isométrique',
      'Click a body part on the right, then click on either view to place its marker.':
        "Cliquez sur une partie du corps à droite, puis cliquez sur l'une des vues pour placer son repère.",
      'Undo (Ctrl+Z)': 'Annuler (Ctrl+Z)',
      'Undo': 'Annuler',
      'Redo (Ctrl+Y)': 'Rétablir (Ctrl+Y)',
      'Redo': 'Rétablir',
      'Auto-detect': 'Détection auto',
      'Read bone positions from the currently selected rig': 'Lire les positions des os depuis le squelette sélectionné',
      'From rig': 'Depuis le squelette',
      'Guided': 'Guidé',
      'Clear all': 'Tout effacer',
      "🔒 Freeze mesh while dragging (align bone, don't deform)":
        "🔒 Figer le maillage pendant le glissement (aligner l'os, ne pas déformer)",
      'Re-generate rig with these landmarks': 'Régénérer le squelette avec ces repères',
      'FRONT': 'FACE',
      'SIDE': 'CÔTÉ',
      'RIGHT': 'DROITE',
      'BACK': 'ARRIÈRE',
      'LEFT': 'GAUCHE',
      'TOP': 'DESSUS',
      'BOTTOM': 'DESSOUS',
      // ---- 3D lightbox ----
      'Previous (←)': 'Précédent (←)',
      'Next (→)': 'Suivant (→)',
      'Use this for next step →': "Utiliser ceci pour l'étape suivante →",
      'Show landmarks': 'Afficher les repères',
      // ---- 2D lightbox toolbox ----
      'AI TOOLS': 'OUTILS IA',
      'MANUAL': 'MANUEL',
      'Modify with AI': "Modifier avec l'IA",
      'Remove background': "Supprimer l'arrière-plan",
      'Change resolution': 'Changer la résolution',
      'Fix face details': 'Corriger les détails du visage',
      'Auto symmetry': 'Symétrie auto',
      // ---- Auto Inpaint modal ----
      'hat, shirt, background, sword...': 'chapeau, chemise, arrière-plan, épée...',
      'leather helmet, plain background...': 'casque de cuir, fond uni...',
      'How far to expand the detected mask around the target. 0px = tight to the object; higher widens it to cover edges, shadows or halos. ~15px recommended.':
        "De combien étendre le masque détecté autour de la cible. 0px = collé à l'objet ; plus haut élargit pour couvrir bords, ombres ou halos. ~15px recommandé.",
      'Detect the mask (1 credit per check)': 'Détecter le masque (1 crédit par vérification)',
      // ---- Multi-view options modal ----
      'Generate Multi-Views': 'Générer les multi-vues',
      'A new image version will be created so the original stays untouched.':
        "Une nouvelle version de l'image sera créée afin que l'originale reste intacte.",
      'Mode': 'Mode',
      'Auto 2-view (back photo, ~25s)': 'Auto 2 vues (photo arrière, ~25s)',
      '6 views (front/right/back/left/top/bottom, ~70s)': '6 vues (face/droite/arrière/gauche/dessus/dessous, ~70s)',
      'Start': 'Démarrer',
      // ---- Mesh tool modal ----
      'Mesh tool': 'Outil de maillage',
      'Drag to rotate · wheel to zoom': 'Glissez pour pivoter · molette pour zoomer',
      // ---- Material adjust modal ----
      'Material Adjust': 'Réglage du matériau',
      'Saturation': 'Saturation',
      'Contrast': 'Contraste',
      'Emissive': 'Émissif',
      'Metallic': 'Métallique',
      'Roughness': 'Rugosité',
      'Tint (hue °)': 'Teinte (°)',
      'Reset': 'Réinitialiser',
      'Save as new version': 'Enregistrer comme nouvelle version',
      // ---- Align texture modal ----
      'Translate X': 'Translation X',
      'Translate Y': 'Translation Y',
      'Translate Z': 'Translation Z',
      'Scale': 'Échelle',
      'Rotation Y': 'Rotation Y',
      'Visibility threshold': 'Seuil de visibilité',
      'Overlay opacity': 'Opacité de la superposition',
      'Live project on mesh': 'Projection en direct sur le maillage',
      'Show overlay plane': 'Afficher le plan de superposition',
      'Auto-fit silhouette': 'Ajuster auto à la silhouette',
      'Reset defaults': 'Réinitialiser les valeurs par défaut',
      'Re-project': 'Re-projeter',
      // ---- Paint Mesh modal ----
      'Pen': 'Stylo',
      'Spray': 'Aérographe',
      'Ink': 'Encre',
      'Eraser': 'Gomme',
      'Pipette': 'Pipette',
      'Brush': 'Brosse',
      'Opacity': 'Opacité',
      'Falloff': 'Atténuation',
      'Reset texture': "Réinitialiser la texture",
      'Save new version': 'Enregistrer une nouvelle version',
      // ---- Paint Emissive modal ----
      'Emissive color': 'Couleur émissive',
      'Intensity': 'Intensité',
      'Brush size (px)': 'Taille de brosse (px)',
      'Brush opacity': 'Opacité de la brosse',
      'Soft falloff': 'Atténuation douce',
      'Erase': 'Effacer',
      'Apply (free)': 'Appliquer (gratuit)',
      // ---- Settings modal ----
      'Interface language': "Langue de l'interface",
      'English': 'Anglais',
      'AI Assistant': 'Assistant IA',
      'Token': 'Jeton',
      'Recent requests': 'Requêtes récentes',
      'Hardware': 'Matériel',
      'Loading...': 'Chargement...',
      'Reset all limits to defaults': 'Réinitialiser toutes les limites aux valeurs par défaut',
      'Parental Control': 'Contrôle parental',
      'Content Filter': 'Filtre de contenu',
      'System': 'Système',
      'Processes': 'Processus',
      'Open logs folder': 'Ouvrir le dossier des journaux',
      'Installation': 'Installation',
      'Calibration': 'Calibration',
      'Pipeline test': 'Test du pipeline',
      'Run calibration': 'Lancer la calibration',
      'Open last report': 'Ouvrir le dernier rapport',
      'No run yet.': 'Aucune exécution.',
      // ---- Calibration modals ----
      'Reload': 'Recharger',
      'Live logs': 'Journaux en direct',
      'Auto-scroll': 'Défilement auto',
      'Pause': 'Pause',
      'Clear': 'Effacer',
      'disconnected': 'déconnecté',
      // ---- Confirm modal ----
      'Confirm': 'Confirmer',
      // ---- Refine mesh modal ----
      'Modification': 'Modification',
      'Output format': 'Format de sortie',
      'AI model': 'Modèle IA',
      'Claude (best)': 'Claude (meilleur)',
      'GPT-4o': 'GPT-4o',
      'Local LLM': 'LLM local',
      'Refine': 'Affiner',
      // ---- Export mesh modal ----
      'Export 3D mesh': 'Exporter le maillage 3D',
      'Pick a format and where to save the file.': "Choisissez un format et l'emplacement de sauvegarde du fichier.",
      'Format': 'Format',
      'Licence': 'Licence',
      'Personal use only': 'Usage personnel uniquement',
      'Public domain (CC0)': 'Domaine public (CC0)',
      'Attribution required (CC-BY 4.0)': 'Attribution requise (CC-BY 4.0)',
      'Non-commercial only (CC-BY-NC 4.0)': 'Non commercial uniquement (CC-BY-NC 4.0)',
      'Royalty-free commercial': 'Commercial libre de droits',
      'Output path': 'Chemin de sortie',
      'Browse...': 'Parcourir...',
      // ---- Export image modal ----
      'Export image': "Exporter l'image",
      'Saved as a sibling LICENSE.txt next to your image.': 'Enregistré dans un LICENSE.txt voisin à côté de votre image.',
      // ---- Publish to marketplace modal ----
      'Title': 'Titre',
      'Description': 'Description',
      'Submit for review': 'Soumettre pour examen',
      // ---- Test rig animation modal ----
      'Test rig animation': "Tester l'animation du squelette",
      'Idle': 'Repos',
      'Walk': 'Marche',
      'Run': 'Course',
      // ---- Job details modal ----
      'Running task': 'Tâche en cours',
      'Status': 'Statut',
      'Running': 'En cours',
      'Started': 'Démarrée',
      'Elapsed': 'Écoulé',
      'Estimated': 'Estimé',
      'Project': 'Projet',
      'Go to step': "Aller à l'étape",
      'Open Settings': 'Ouvrir les paramètres',
      'Cancel task': 'Annuler la tâche',
      // ---- Modify image modal ----
      'Modify image': "Modifier l'image",
      'Describe the changes you want. The AI keeps the composition.':
        "Décrivez les changements souhaités. L'IA conserve la composition.",
      'Modification prompt': 'Prompt de modification',
      'make it red, add more details, anime style...': 'le rendre rouge, ajouter des détails, style anime...',
      'Strength': 'Intensité',
      // ---- Variant modal ----
      'Create variant': 'Créer une variante',
      'Generate a variation of the current image — same subject, you control how different it is.':
        "Générez une variation de l'image actuelle — même sujet, vous contrôlez son degré de différence.",
      'Variation amount': 'Niveau de variation',
      'Number of variants': 'Nombre de variantes',
      'Generate variant': 'Générer une variante',
      // ---- Draw Mask modal ----
      'Magnifier': 'Loupe',
      'Replace with:': 'Remplacer par :',
      'Apply Inpaint': 'Appliquer la retouche',
      // ---- Clone Stamp modal ----
      'Flip mode': 'Mode miroir',
      'Clear all paint': 'Effacer toute la peinture',
      'No source point set': 'Aucun point source défini',
      // ---- Jobs panel ----
      'Show running jobs': 'Afficher les tâches en cours',
      'Running jobs': 'Tâches en cours',
      'Collapse jobs panel': 'Réduire le panneau des tâches',
      // ---- Resolution modal ----
      'Downscale 0.5x': 'Réduire 0,5x',
      'Upscale 2x': 'Agrandir 2x',
      // ---- Brightness / Contrast modal ----
      'Brightness / Contrast': 'Luminosité / Contraste',
      'Sharpness': 'Netteté',
      // ---- Color Picker modal ----
      'Color Picker': 'Sélecteur de couleur',
      'Click anywhere on the image to pick a color.': "Cliquez n'importe où sur l'image pour prélever une couleur.",
      'Copy HEX': 'Copier le HEX',
      // ---- Blur Brush modal ----
      'Blur / Sharpen Brush': 'Pinceau flou / netteté',
      'Blur': 'Flou',
      'Sharpen': 'Accentuer',
      // ---- Crop modal ----
      'Auto center': 'Centrage auto',
      'Apply Crop': 'Appliquer le rognage',
      // ---- Symmetrize modal ----
      'Direction:': 'Direction :',
      'Mode:': 'Mode :',
      'Full': 'Complet',
      'Mask': 'Masque',
      'Apply Symmetrize': 'Appliquer la symétrie',
      // ---- Paint Tools modal ----
      'Paint Tools': 'Outils de peinture',
      'Rect': 'Rectangle',
      'Lasso': 'Lasso',
      'Wand': 'Baguette',
      'Invert selection': 'Inverser la sélection',
      'Invert': 'Inverser',
      'Deselect (edit everywhere)': 'Désélectionner (éditer partout)',
      'None': 'Aucune',
      'Line': 'Ligne',
      'Smudge': 'Étaler',
      'Fill': 'Remplir',
      'Pick color': 'Choisir une couleur',
      'Pick from image': "Prélever depuis l'image",
      'Hardness': 'Dureté',
      'Tolerance': 'Tolérance',
      // ---- Mesh Edit modal ----
      'Mesh Edit': 'Édition du maillage',
      'Push': 'Pousser',
      'Pull': 'Tirer',
      'Flatten': 'Aplatir',
      'Grab': 'Saisir',
      'Inflate': 'Gonfler',
      'Symmetry mirror': 'Miroir de symétrie',
      'Selection': 'Sélection',
      'Grow': 'Étendre',
      'Shrink': 'Rétrécir',
      'View': 'Vue',
      'Isolate': 'Isoler',
      'Hide': 'Masquer',
      'Edit': 'Éditer',
      'Duplicate': 'Dupliquer',
      'Flip normals': 'Inverser les normales',
      'Radius': 'Rayon',
      // ---- About modal ----
      'public beta': 'bêta publique',
      "What's this?": "Qu'est-ce que c'est ?",
      'Updates': 'Mises à jour',
      'Check for updates': 'Vérifier les mises à jour',
      'Resources': 'Ressources',
      'Website': 'Site web',
      'Privacy': 'Confidentialité',
      'Terms': 'Conditions',
      'Contact us': 'Nous contacter',
      'Crafted by': 'Réalisé par',
      // ---- Contact modal ----
      'Name': 'Nom',
      'Email': 'E-mail',
      'Subject': 'Sujet',
      'Your message…': 'Votre message…',
      'Send': 'Envoyer',
      // ---- Usage history modal ----
      'Export Excel': 'Exporter en Excel',
      'Date': 'Date',
      'Type': 'Type',
      'Duration': 'Durée',
      'Credits': 'Crédits',
      'Event details': "Détails de l'événement",
      'Loading…': 'Chargement…',
      'Detecting target…': 'Détection de la cible…',
      // ---- Cloud account / auth / parental (some are JS-rendered) ----
      'Account': 'Compte',
      'Session': 'Session',
      'Sign out': 'Se déconnecter',
      'Sign out of MyFabmesh.AI Cloud on this device.': 'Se déconnecter de MyFabmesh.AI Cloud sur cet appareil.',
      'Blocks NSFW, violent, and illegal content in prompts. Disable with a PIN code for unrestricted adult use.':
        'Bloque les contenus NSFW, violents et illégaux dans les prompts. Désactivez avec un code PIN pour un usage adulte sans restriction.',
      'Unrestricted': 'Sans restriction',
      'Restricted (safe)': 'Restreint (sûr)',
      'Unrestricted mode — click to lock': 'Mode sans restriction — cliquez pour verrouiller',
      'Parental control active — click to unlock': 'Contrôle parental actif — cliquez pour déverrouiller',
      'Lock': 'Verrouiller',
      'Locked': 'Verrouillé',
      'Unrestricted mode enabled.': 'Mode sans restriction activé.',
      // ---- Projects grid (JS-rendered) ----
      'No image': 'Aucune image',
      'No images yet.': 'Aucune image pour le moment.',
      'Create a new project': 'Créer un nouveau projet',
      'Server warming up ({n} services)': 'Serveur en préchauffage ({n} services)',
      'No generation in progress': 'Aucune génération en cours',
      // ---- Desktop Settings (Claude / control-plane / hardware / system / calibration) ----
      'Claude Desktop': 'Claude Desktop',
      'Let Claude generate batches of assets for you via text commands.': "Laissez Claude générer des lots d'assets pour vous via des commandes texte.",
      'Connect to Claude Desktop': 'Se connecter à Claude Desktop',
      'Disconnect': 'Déconnecter',
      'Disconnecting...': 'Déconnexion...',
      'Connecting...': 'Connexion...',
      'Connected': 'Connecté',
      'Not connected': 'Non connecté',
      'Disconnected': 'Déconnecté',
      'Restart Claude Desktop to activate.': 'Redémarrez Claude Desktop pour activer.',
      'Failed': 'Échec',
      'Error': 'Erreur',
      'Unknown error': 'Erreur inconnue',
      'Control API · checking...': 'API de contrôle · vérification...',
      'Local HTTP control plane on 127.0.0.1:7331. Drive MyFabmesh.AI from scripts (Claude Code, batch generators, CI...).': 'Plan de contrôle HTTP local sur 127.0.0.1:7331. Pilotez MyFabmesh.AI depuis des scripts (Claude Code, générateurs par lots, CI...).',
      'Disabled (no token)': 'Désactivé (aucun jeton)',
      'Set FABMESH_CONTROL_API=1 (or just relaunch MyFabmesh.AI) to enable.': 'Définissez FABMESH_CONTROL_API=1 (ou relancez simplement MyFabmesh.AI) pour activer.',
      'Unreachable': 'Injoignable',
      '(no requests yet)': '(aucune requête pour le moment)',
      'local': 'local',
      'Temp': 'Temp.',
      'Drag markers to set limits. Jobs queue until all limits are met.': 'Glissez les marqueurs pour définir les limites. Les tâches attendent que toutes les limites soient respectées.',
      'active': 'actif',
      'AI engine': 'Moteur IA',
      'running': 'en cours',
      'stopped': 'arrêté',
      'No active process.': 'Aucun processus actif.',
      'Kill AI engine': 'Arrêter le moteur IA',
      'Kill Processes': 'Arrêter les processus',
      'Kill All': 'Tout arrêter',
      'Kill': 'Arrêter',
      'Go to': 'Aller à',
      'Live logs viewer': 'Visionneuse de journaux en direct',
      'Reconfigure MyFabmesh.AI': 'Reconfigurer MyFabmesh.AI',
      'Re-run the first-time setup wizard to change install mode (Lite / Standard / Full) or re-download a missing model. Your projects and generated meshes are kept.': "Relancez l'assistant de configuration initiale pour changer le mode d'installation (Lite / Standard / Complet) ou re-télécharger un modèle manquant. Vos projets et maillages générés sont conservés.",
      'Uninstall MyFabmesh.AI': 'Désinstaller MyFabmesh.AI',
      "Remove MyFabmesh.AI from your computer. You'll be asked whether to also delete the AI models (~17 GB) and your settings. Your generated meshes folder is never touched.": "Supprimez MyFabmesh.AI de votre ordinateur. On vous demandera si vous souhaitez aussi supprimer les modèles IA (~17 Go) et vos paramètres. Votre dossier de maillages générés n'est jamais touché.",
      'Reconfigure': 'Reconfigurer',
      'Uninstall': 'Désinstaller',
      'Generates a textured mesh from the calibration cube and scores how many of the 6 painted faces end up on the correct axis.': 'Génère un maillage texturé à partir du cube de calibration et évalue combien des 6 faces peintes se retrouvent sur le bon axe.',
      'Ground truth: 6 painted cube faces': 'Vérité terrain : 6 faces de cube peintes',
      'docs': 'docs',
      'Last run loaded.': 'Dernière exécution chargée.',
      'Resume': 'Reprendre',
      // ---- Dynamic JS strings (toasts / errors / status) ----
      'Pick an image first.': 'Choisissez d\'abord une image.',
      'Pick a mesh first.': 'Choisissez d\'abord un maillage.',
      'Pick a source image first.': 'Choisissez d\'abord une image source.',
      'Pick a clip first': 'Choisissez d\'abord un clip',
      'Pick a rig template.': 'Choisissez un modèle de squelette.',
      'Open a project first': 'Ouvrez d\'abord un projet',
      'Type a description first.': 'Saisissez d\'abord une description.',
      'Type a modification first.': 'Saisissez d\'abord une modification.',
      'No prompt to copy': 'Aucun prompt à copier',
      'No selection to invert.': 'Aucune sélection à inverser.',
      'Select faces first': 'Sélectionnez d\'abord des faces',
      'Select an animation first': 'Sélectionnez d\'abord une animation',
      'Select a clip first': 'Sélectionnez d\'abord un clip',
      'Pick at least one animation type': 'Choisissez au moins un type d\'animation',
      'Image imported!': 'Image importée !',
      'Import failed': 'Échec de l\'import',
      'Prompt copied!': 'Prompt copié !',
      'Copy failed': 'Échec de la copie',
      'Prompt already enhanced. Edit manually or clear it.': 'Prompt déjà amélioré. Modifiez-le manuellement ou effacez-le.',
      'Back photo added': 'Photo arrière ajoutée',
      'Back photo ready': 'Photo arrière prête',
      'Generating back photo...': 'Génération de la photo arrière...',
      'Generating 6 multi-views...': 'Génération de 6 multi-vues...',
      'Multi-views generated!': 'Multi-vues générées !',
      'Generating back photos...': 'Génération des photos arrière...',
      'Back photos ready': 'Photos arrière prêtes',
      'Generating 6 views...': 'Génération de 6 vues...',
      '6 views ready': '6 vues prêtes',
      'Regenerating back view...': 'Régénération de la vue arrière...',
      'Back view regenerated.': 'Vue arrière régénérée.',
      'No front image to regenerate from.': 'Aucune image avant pour régénérer.',
      'Symmetrized!': 'Symétrisé !',
      'Cannot load image': 'Impossible de charger l\'image',
      'Crop area too small.': 'Zone de rognage trop petite.',
      'Style applied!': 'Style appliqué !',
      'Saved!': 'Enregistré !',
      'Painted version saved!': 'Version peinte enregistrée !',
      'Paint Mesh saved!': 'Peinture du maillage enregistrée !',
      'Edited mesh saved!': 'Maillage modifié enregistré !',
      'Texture re-projected': 'Texture re-projetée',
      'Need both a mesh and a source image': 'Un maillage et une image source sont requis',
      'Failed to read mesh file': 'Échec de la lecture du fichier de maillage',
      'Failed to load mesh in preview': "Échec du chargement du maillage dans l'aperçu",
      'Selected faces deleted': 'Faces sélectionnées supprimées',
      'Flipped selected faces': 'Faces sélectionnées inversées',
      'Smoothed selection': 'Sélection lissée',
      'Duplicated selection': 'Sélection dupliquée',
      'Kept the rest': 'Reste conservé',
      'Cropped to selection': 'Rogné sur la sélection',
      'No animation tracks in this GLB — nothing to play.': 'Aucune piste d\'animation dans ce GLB — rien à lire.',
      'Imported as new version': 'Importé comme nouvelle version',
      'Pick a .glb or .gltf file': 'Choisissez un fichier .glb ou .gltf',
      'Check at least one type to generate.': 'Cochez au moins un type à générer.',
      'Type what to find first (e.g. "hat", "background")': 'Indiquez d\'abord quoi trouver (ex. « chapeau », « arrière-plan »)',
      'Parental control re-enabled.': 'Contrôle parental réactivé.',
      'PIN must be at least 4 digits.': 'Le code PIN doit comporter au moins 4 chiffres.',
      'AI engine killed. VRAM freed.': 'Moteur IA arrêté. VRAM libérée.',
      'Processes killed. AI engine preserved.': 'Processus arrêtés. Moteur IA préservé.',
      'All processes + AI engine killed. VRAM freed.': 'Tous les processus + le moteur IA arrêtés. VRAM libérée.',
      'This image is blocked by parental control.': 'Cette image est bloquée par le contrôle parental.',
      'Title is required.': 'Le titre est obligatoire.',
      'No mesh selected — close and pick a mesh first.': 'Aucun maillage sélectionné — fermez et choisissez d\'abord un maillage.',
      'No image selected — close and pick an image first.': 'Aucune image sélectionnée — fermez et choisissez d\'abord une image.',
      '✓ Submitted for review — an admin will approve it shortly.': '✓ Soumis pour examen — un administrateur l\'approuvera sous peu.',
      'This mesh has no job ID — cannot publish.': 'Ce maillage n\'a pas d\'identifiant de tâche — publication impossible.',
      'OK': 'OK',
      'Sign in': 'Se connecter',
      'Sending…': 'Envoi…',
      'Submitting…': 'Soumission…',
      'Saving…': 'Enregistrement…',
      'Projecting…': 'Projection…',
      'Re-projecting...': 'Re-projection...',
      'Restarting…': 'Redémarrage…',
      'Cancelling...': 'Annulation...',
      'Loading mesh...': 'Chargement du maillage...',
      'Move cursor over image': "Déplacez le curseur sur l'image",
      'Update check not available in this build.': 'Vérification des mises à jour indisponible dans cette version.',
      'Checking GitHub for updates…': 'Recherche de mises à jour sur GitHub…',
      'You are running the latest version.': 'Vous utilisez la dernière version.',
      'GPU info unavailable': 'Infos GPU indisponibles',
      'Re-skin': 'Re-skin',
      'No mesh available — generate or pick one first.': 'Aucun maillage disponible — générez-en un ou choisissez-en un d\'abord.',
      'Rigging bridge not available.': 'Le pont de rigging n\'est pas disponible.',
      'I understand and accept responsibility': 'Je comprends et j\'accepte la responsabilité',
      // ---- Converted from FR-hardcoded source ----
      'Filter disabled — re-running the action…': 'Filtre désactivé — relance de l\'action…',
      'The job will start automatically once the limits are met.': 'Le job sera lancé automatiquement quand les limites seront satisfaites.',
      'You can adjust the sliders in Settings.': 'Vous pouvez ajuster les sliders dans Settings.',
      'Job queued': 'Job mis en file d\'attente',
    },
  };

  let _lang = 'en';
  try { _lang = localStorage.getItem('fabmesh.lang') || 'en'; } catch (_) {}

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE', 'MODEL-VIEWER', 'CANVAS', 'svg', 'SVG']);

  function _dict() { return _lang === 'en' ? null : (I18N[_lang] || null); }

  function _translateText(root, dict) {
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const pn = n.parentNode;
        if (pn && SKIP_TAGS.has(pn.nodeName)) return NodeFilter.FILTER_REJECT;
        return n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    const nodes = [];
    let n;
    while ((n = tw.nextNode())) nodes.push(n);
    nodes.forEach((node) => _translateNodeValue(node, dict));
  }

  // Translate a single text node, caching its original English on the node so
  // switching back to English restores it. Fallback: if the full trimmed label
  // has no entry, strip a leading icon/emoji run ("💾 Export" -> "💾 " + "Export")
  // and translate the word remainder, so icon-prefixed buttons translate too.
  function _translateNodeValue(node, dict) {
    if (node.__i18n === undefined) node.__i18n = node.nodeValue;
    const orig = node.__i18n;
    const key = orig.trim();
    if (!key) return;
    let translated = orig;  // dict null = English (source) -> restore the cached original
    if (dict) {
      // Strip a leading icon/emoji run ("🔬 Export" -> "🔬 " + "Export") and match the
      // icon-STRIPPED core FIRST. Curated dict entries are keyed without the icon, so this
      // must beat any stale full-string auto-translate cache entry (keyed WITH the icon),
      // which used to shadow curated translations (e.g. "Sharpen texture"->"épingle").
      const m = key.match(/^([^\p{L}\p{N}]+)(\p{L}[\s\S]*)$/u);
      const core = m ? m[2] : key;
      const prefix = m ? m[1] : '';
      if (dict[core]) {
        translated = orig.replace(key, prefix + dict[core]);
      } else if (dict[key]) {
        translated = orig.replace(key, dict[key]);
      } else {
        _queueAuto(core);   // cache by the icon-stripped core so it shares the dict key space
      }
    }
    if (node.nodeValue !== translated) node.nodeValue = translated;
  }

  function _translateAttrs(root, dict) {
    ['placeholder', 'title', 'aria-label'].forEach((attr) => {
      root.querySelectorAll('[' + attr + ']').forEach((el) => {
        const ck = '__i18n_' + attr;
        if (el[ck] === undefined) el[ck] = el.getAttribute(attr);
        const orig = el[ck];
        let translated = orig;
        if (dict && dict[orig]) translated = dict[orig];
        else if (orig && orig.trim()) _queueAuto(orig.trim());
        if (el.getAttribute(attr) !== translated) el.setAttribute(attr, translated);
      });
    });
  }

  // Small country flags next to the selector. Windows doesn't render flag
  // EMOJI (shows "FR"/"GB" letters), so we use inline SVG images instead.
  const _FLAG_SVG = {
    en: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 60 30'><clipPath id='ujs'><path d='M0,0 v30 h60 v-30 z'/></clipPath><clipPath id='ujt'><path d='M30,15 h30 v15 z v15 h-30 z h-30 v-15 z v-15 h30 z'/></clipPath><g clip-path='url(#ujs)'><path d='M0,0 v30 h60 v-30 z' fill='#012169'/><path d='M0,0 L60,30 M60,0 L0,30' stroke='#fff' stroke-width='6'/><path d='M0,0 L60,30 M60,0 L0,30' clip-path='url(#ujt)' stroke='#C8102E' stroke-width='4'/><path d='M30,0 v30 M0,15 h60' stroke='#fff' stroke-width='10'/><path d='M30,0 v30 M0,15 h60' stroke='#C8102E' stroke-width='6'/></g></svg>",
    fr: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 3 2'><rect width='3' height='2' fill='#fff'/><rect width='1' height='2' fill='#002654'/><rect x='2' width='1' height='2' fill='#CE1126'/></svg>",
    es: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 3 2'><rect width='3' height='2' fill='#AA151B'/><rect y='0.5' width='3' height='1' fill='#F1BF00'/></svg>",
    zh: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 30 20'><rect width='30' height='20' fill='#DE2910'/><path d='M5 2.6 6.12 6.05 9.75 6.05 6.81 8.18 7.94 11.63 5 9.5 2.06 11.63 3.19 8.18 0.25 6.05 3.88 6.05 Z' fill='#FFDE00'/></svg>",
    hi: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 9 6'><rect width='9' height='6' fill='#fff'/><rect width='9' height='2' fill='#FF9933'/><rect y='4' width='9' height='2' fill='#138808'/><circle cx='4.5' cy='3' r='0.9' fill='none' stroke='#000080' stroke-width='0.16'/><circle cx='4.5' cy='3' r='0.12' fill='#000080'/></svg>",
    ar: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 6'><rect width='12' height='6' fill='#fff'/><rect width='12' height='2' fill='#00732F'/><rect y='4' width='12' height='2' fill='#000'/><rect width='3' height='6' fill='#FF0000'/></svg>",
  };
  function _flagSrc(code) {
    const svg = _FLAG_SVG[code];
    return svg ? 'data:image/svg+xml,' + encodeURIComponent(svg) : '';
  }
  function _updateFlag(lang) {
    const src = _flagSrc(lang);
    const f = document.getElementById('lang-flag');
    if (f) {
      // The custom dropdown (once built) carries the flag in its button, so the
      // standalone left flag is hidden to avoid showing it twice.
      if (_langDD) f.style.display = 'none';
      else if (src) { f.src = src; f.style.display = ''; }
      else f.style.display = 'none';
    }
    if (_langDD && _langDD.bimg) {
      if (src) { _langDD.bimg.src = src; _langDD.bimg.style.display = ''; }
      else _langDD.bimg.style.display = 'none';
    }
  }

  // Custom language dropdown so each option can show its flag — native <select>
  // <option> elements can't contain <img>. It mirrors the hidden #lang-select
  // (kept as the source of truth, so change events + value reads still work).
  let _langDD = null;
  function _mkFlagImg(code) {
    const im = document.createElement('img');
    im.alt = '';
    const s = _flagSrc(code);
    if (s) im.src = s; else im.style.display = 'none';
    im.style.cssText = 'width:22px;height:15px;border-radius:2px;object-fit:cover;box-shadow:0 0 0 1px rgba(255,255,255,0.14);flex:none;';
    return im;
  }
  function _buildLangDropdown() {
    const sel = document.getElementById('lang-select');
    if (!sel || sel.__fabCustom) return;
    sel.__fabCustom = true;
    sel.style.display = 'none';
    const opts = Array.from(sel.options).map((o) => ({ value: o.value, label: o.textContent.trim() }));
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative; display:inline-block; min-width:160px;';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.style.cssText = 'display:flex; align-items:center; gap:8px; width:100%; padding:6px 10px; background:var(--bg-2,#1a1a24); color:var(--text-0,#fff); border:1px solid var(--border,#3a3a4a); border-radius:6px; cursor:pointer; font-size:13px;';
    const bimg = _mkFlagImg(sel.value);
    const blab = document.createElement('span'); blab.style.cssText = 'flex:1; text-align:start;';
    const chev = document.createElement('span'); chev.textContent = '▾'; chev.style.cssText = 'opacity:0.6; font-size:11px;';
    btn.appendChild(bimg); btn.appendChild(blab); btn.appendChild(chev);
    const menu = document.createElement('div');
    menu.style.cssText = 'position:absolute; top:calc(100% + 4px); left:0; right:0; background:var(--bg-1,#15151d); border:1px solid var(--border,#3a3a4a); border-radius:6px; box-shadow:0 10px 28px rgba(0,0,0,0.55); z-index:99999; overflow:hidden auto; max-height:60vh; display:none;';
    opts.forEach((o) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:8px; padding:8px 10px; cursor:pointer; color:var(--text-0,#fff); font-size:13px;';
      const lab = document.createElement('span'); lab.textContent = o.label;
      row.appendChild(_mkFlagImg(o.value)); row.appendChild(lab);
      row.addEventListener('mouseenter', () => { row.style.background = 'rgba(124,77,255,0.28)'; });
      row.addEventListener('mouseleave', () => { row.style.background = ''; });
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        sel.value = o.value;
        sel.dispatchEvent(new Event('change'));
        menu.style.display = 'none';
      });
      menu.appendChild(row);
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.style.display = (menu.style.display === 'none') ? 'block' : 'none';
    });
    document.addEventListener('click', () => { menu.style.display = 'none'; });
    wrap.appendChild(btn); wrap.appendChild(menu);
    sel.parentNode.insertBefore(wrap, sel.nextSibling);
    _langDD = { btn, bimg, blab, menu };
    _syncLangDropdownButton();
  }
  function _syncLangDropdownButton() {
    const sel = document.getElementById('lang-select');
    if (!sel || !_langDD) return;
    const o = sel.options[sel.selectedIndex];
    const s = _flagSrc(sel.value);
    if (s) { _langDD.bimg.src = s; _langDD.bimg.style.display = ''; } else _langDD.bimg.style.display = 'none';
    _langDD.blab.textContent = o ? o.textContent.trim() : sel.value;
  }

  // --- Runtime auto-translate fallback -------------------------------------
  // Any English UI string with no dict entry is sent to the local Argos worker
  // (EN -> current language) and cached persistently, so the UI is never left in
  // English even for strings we didn't pre-translate. No-ops gracefully when the
  // IPC bridge is absent (e.g. the web/cloud build has no local worker).
  const _AUTO_KEY = 'fabmesh.i18n.auto.v3.';   // v3: cache now keyed by icon-stripped core; drop stale full-string ("🔬 Sharpen" -> "épingle") caches that shadowed curated dict entries
  const _curated = {};   // per-lang Set of register()'d keys — the auto cache must never override these
  const _autoCache = {};
  const _pendingAuto = new Set();
  const _triedAuto = new Set();
  let _autoTimer = null;
  function _loadAutoCache(lang) {
    if (_autoCache[lang]) return _autoCache[lang];
    let m = {};
    try { m = JSON.parse(localStorage.getItem(_AUTO_KEY + lang) || '{}') || {}; } catch (_) { m = {}; }
    _autoCache[lang] = m;
    // Merge the auto cache, but NEVER over a curated register() entry — the cache may hold
    // a stale/bad argos translation (e.g. 'Sharpen texture'->'aiguillage') that would shadow it.
    const _base = I18N[lang] || (I18N[lang] = {});
    for (const _k in m) { if (!(_curated[lang] && _curated[lang].has(_k))) _base[_k] = m[_k]; }
    return m;
  }
  function _shouldAutoTranslate(key) {
    if (!key || key.length > 200) return false;
    if (!/[A-Za-z]/.test(key)) return false;                 // needs letters
    if (/^https?:\/\//i.test(key)) return false;             // url
    if (!/\s/.test(key) && /[._/\\()]|[a-z][A-Z]/.test(key)) return false;  // code-ish token
    // Value-like strings (durations/sizes/measures: "18s", "~19s", "10m 48s",
    // "2.5 GB", "47°C") — NEVER translate (argos turned "18s" into "18 ans").
    // Heuristic: short, starts with a digit (after optional ~/</>), no real 4+ letter word.
    if (key.length <= 24 && !/[A-Za-z]{4,}/.test(key) && /^[~≈<>]?\s*\d/.test(key)) return false;
    return true;
  }
  function _queueAuto(key) {
    if (_lang === 'en' || !key) return;
    if (typeof window === 'undefined' || !window.meshyAPI || !window.meshyAPI.i18nAutoTranslate) return;
    const tk = _lang + '|' + key;
    if (_triedAuto.has(tk) || _pendingAuto.has(key)) return;
    const d = _dict();
    if (d && d[key]) return;
    if (!_shouldAutoTranslate(key)) return;
    _pendingAuto.add(key);
    if (!_autoTimer) _autoTimer = setTimeout(_flushAuto, 450);
  }
  async function _flushAuto() {
    _autoTimer = null;
    if (_lang === 'en' || !_pendingAuto.size) return;
    if (typeof window === 'undefined' || !window.meshyAPI || !window.meshyAPI.i18nAutoTranslate) { _pendingAuto.clear(); return; }
    const lang = _lang;
    const texts = Array.from(_pendingAuto).slice(0, 60);
    texts.forEach((t) => { _pendingAuto.delete(t); _triedAuto.add(lang + '|' + t); });
    let res = null;
    try { res = await window.meshyAPI.i18nAutoTranslate({ texts, to: lang }); } catch (_) { res = null; }
    if (res && typeof res === 'object') {
      const cache = _loadAutoCache(lang);
      let added = 0;
      for (const en of Object.keys(res)) {
        const tr = res[en];
        if (_curated[lang] && _curated[lang].has(en)) continue;  // never override a curated entry
        if (tr && typeof tr === 'string' && tr !== en) { cache[en] = tr; I18N[lang][en] = tr; added++; }
      }
      if (added) {
        try { localStorage.setItem(_AUTO_KEY + lang, JSON.stringify(cache)); } catch (_) {}
        if (lang === _lang) { try { applyLang(lang); } catch (_) {} }
      }
    }
    if (_pendingAuto.size && !_autoTimer) _autoTimer = setTimeout(_flushAuto, 450);
  }
  // -------------------------------------------------------------------------

  function applyLang(lang) {
    _lang = lang || 'en';
    try { localStorage.setItem('fabmesh.lang', _lang); } catch (_) {}
    try { window.meshyAPI && window.meshyAPI.setSpellcheckLang && window.meshyAPI.setSpellcheckLang(_lang); } catch (_) {}
    if (_lang !== 'en') _loadAutoCache(_lang);
    const dict = _dict();
    try {
      _translateText(document.body, dict);
      _translateAttrs(document.body, dict);
    } catch (e) { try { console.warn('[i18n]', e); } catch (_) {} }
    document.documentElement.setAttribute('lang', _lang);
    document.documentElement.setAttribute('dir', _lang === 'ar' ? 'rtl' : 'ltr');
    const sel = document.getElementById('lang-select');
    if (sel && sel.value !== _lang) sel.value = _lang;
    _updateFlag(_lang);
    _syncLangDropdownButton();
  }

  // t(): translate a single string (for JS-built / dynamic UI text).
  function t(s) {
    const dict = _dict();
    return (dict && dict[s]) || s;
  }

  // tf(): translate a TEMPLATE that contains {x}/{y} placeholders, then fill them
  // with args in order. The dict key is the template WITH the placeholders (e.g.
  // 'Generate 3D: {x}'). Falls back to the English template filled in.
  function tf(template, ...args) {
    const dict = _dict();
    const s = (dict && dict[template]) || template;
    let i = 0;
    return s.replace(/\{[xy]\}/g, () => (i < args.length ? String(args[i++]) : ''));
  }

  // Re-translate dynamically-added content SYNCHRONOUSLY (inside the observer
  // callback, before the browser paints) so freshly-rendered English never
  // flashes on screen — fixes the EN<->FR flicker when panels re-render every
  // second during generation. We only walk the newly-added subtrees (not the
  // whole body), so it stays cheap. childList only (NOT characterData) so our
  // own nodeValue swaps never re-trigger us -> no loop.
  const _mo = new MutationObserver((muts) => {
    if (_lang === 'en') return;
    const dict = _dict();
    if (!dict) return;
    for (const mut of muts) {
      if (!mut.addedNodes) continue;
      mut.addedNodes.forEach((node) => {
        if (node.nodeType === 3) {                                   // text node
          _translateNodeValue(node, dict);
        } else if (node.nodeType === 1 && !SKIP_TAGS.has(node.nodeName)) {  // element subtree
          _translateText(node, dict);
          _translateAttrs(node, dict);
        }
      });
    }
  });

  window.FabI18n = {
    applyLang,
    t,
    tf,
    get lang() { return _lang; },
    register(lang, map) {
      I18N[lang] = Object.assign(I18N[lang] || {}, map);
      (_curated[lang] = _curated[lang] || new Set());
      for (const k in map) _curated[lang].add(k);
    },
    languages() { return ['en'].concat(Object.keys(I18N)); },
  };

  function _init() {
    // Wire the Settings language <select> if present.
    const sel = document.getElementById('lang-select');
    if (sel) {
      sel.value = _lang;
      sel.addEventListener('change', () => applyLang(sel.value));
      _buildLangDropdown();
    }
    applyLang(_lang);
    try { _mo.observe(document.body, { childList: true, subtree: true }); } catch (_) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _init);
  else _init();
}());
