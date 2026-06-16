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
    nodes.forEach((node) => {
      if (node.__i18n === undefined) node.__i18n = node.nodeValue;  // cache original English
      const orig = node.__i18n;
      const key = orig.trim();
      const translated = (dict && dict[key]) ? orig.replace(key, dict[key]) : orig;
      if (node.nodeValue !== translated) node.nodeValue = translated;
    });
  }

  function _translateAttrs(root, dict) {
    ['placeholder', 'title', 'aria-label'].forEach((attr) => {
      root.querySelectorAll('[' + attr + ']').forEach((el) => {
        const ck = '__i18n_' + attr;
        if (el[ck] === undefined) el[ck] = el.getAttribute(attr);
        const orig = el[ck];
        const translated = (dict && dict[orig]) ? dict[orig] : orig;
        if (el.getAttribute(attr) !== translated) el.setAttribute(attr, translated);
      });
    });
  }

  // Small country flags next to the selector. Windows doesn't render flag
  // EMOJI (shows "FR"/"GB" letters), so we use inline SVG images instead.
  const _FLAG_SVG = {
    en: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 60 30'><clipPath id='ujs'><path d='M0,0 v30 h60 v-30 z'/></clipPath><clipPath id='ujt'><path d='M30,15 h30 v15 z v15 h-30 z h-30 v-15 z v-15 h30 z'/></clipPath><g clip-path='url(#ujs)'><path d='M0,0 v30 h60 v-30 z' fill='#012169'/><path d='M0,0 L60,30 M60,0 L0,30' stroke='#fff' stroke-width='6'/><path d='M0,0 L60,30 M60,0 L0,30' clip-path='url(#ujt)' stroke='#C8102E' stroke-width='4'/><path d='M30,0 v30 M0,15 h60' stroke='#fff' stroke-width='10'/><path d='M30,0 v30 M0,15 h60' stroke='#C8102E' stroke-width='6'/></g></svg>",
    fr: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 3 2'><rect width='3' height='2' fill='#fff'/><rect width='1' height='2' fill='#002654'/><rect x='2' width='1' height='2' fill='#CE1126'/></svg>",
  };
  function _updateFlag(lang) {
    const f = document.getElementById('lang-flag');
    if (!f) return;
    const svg = _FLAG_SVG[lang];
    if (svg) { f.src = 'data:image/svg+xml,' + encodeURIComponent(svg); f.style.display = ''; }
    else f.style.display = 'none';
  }

  function applyLang(lang) {
    _lang = lang || 'en';
    try { localStorage.setItem('fabmesh.lang', _lang); } catch (_) {}
    const dict = _dict();
    try {
      _translateText(document.body, dict);
      _translateAttrs(document.body, dict);
    } catch (e) { try { console.warn('[i18n]', e); } catch (_) {} }
    document.documentElement.setAttribute('lang', _lang);
    const sel = document.getElementById('lang-select');
    if (sel && sel.value !== _lang) sel.value = _lang;
    _updateFlag(_lang);
  }

  // t(): translate a single string (for JS-built / dynamic UI text).
  function t(s) {
    const dict = _dict();
    return (dict && dict[s]) || s;
  }

  // Re-translate dynamically-added content. childList only (NOT characterData)
  // so our own nodeValue swaps never re-trigger us -> no loop. Debounced.
  let _moTimer = null;
  const _mo = new MutationObserver((muts) => {
    if (_lang === 'en') return;
    if (!muts.some((m) => m.addedNodes && m.addedNodes.length)) return;
    clearTimeout(_moTimer);
    _moTimer = setTimeout(() => applyLang(_lang), 250);
  });

  window.FabI18n = {
    applyLang,
    t,
    get lang() { return _lang; },
    register(lang, map) { I18N[lang] = Object.assign(I18N[lang] || {}, map); },
    languages() { return ['en'].concat(Object.keys(I18N)); },
  };

  function _init() {
    // Wire the Settings language <select> if present.
    const sel = document.getElementById('lang-select');
    if (sel) {
      sel.value = _lang;
      sel.addEventListener('change', () => applyLang(sel.value));
    }
    applyLang(_lang);
    try { _mo.observe(document.body, { childList: true, subtree: true }); } catch (_) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _init);
  else _init();
}());
