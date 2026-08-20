'use strict';

// ============================================================
// Wizard log forwarder — ships all console output to the main
// process so we get a single wizard.log file in %APPDATA%\fabmesh\.
// Critical because the wizard is the first-run experience: if it
// breaks for a user, this is where Sentry has not had time to
// attach yet, and the user has no app window to read logs from.
// ============================================================
(function _wizardLogShim() {
  const api = (typeof window !== 'undefined') ? window : {};
  const send = (level, args) => {
    try {
      const msg = Array.from(args).map((a) => {
        if (a instanceof Error) return `${a.message}\n${a.stack || ''}`;
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch (_) { return String(a); }
      }).join(' ');
      if (api.electronAPI && api.electronAPI.send) {
        api.electronAPI.send('wizard-log', { level, msg });
      } else if (api.wizardAPI && api.wizardAPI.log) {
        api.wizardAPI.log({ level, msg });
      } else if (window.require) {
        try {
          window.require('electron').ipcRenderer.send('wizard-log', { level, msg });
        } catch (_) {}
      }
    } catch (_) {}
  };
  const wrap = (level, fn) => function (...args) { send(level, args); try { return fn.apply(console, args); } catch (_) {} };
  console.log   = wrap('log',   console.log);
  console.info  = wrap('info',  console.info);
  console.warn  = wrap('warn',  console.warn);
  console.error = wrap('error', console.error);
  console.debug = wrap('debug', console.debug);
  window.addEventListener('error', (e) => send('error', [`window.onerror: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`, e.error && e.error.stack]));
  window.addEventListener('unhandledrejection', (e) => send('error', ['unhandledrejection:', e.reason && e.reason.stack ? e.reason.stack : String(e.reason)]));
  send('boot', ['wizard.js loaded at ' + new Date().toISOString() + ' — UA: ' + navigator.userAgent]);
})();

/* ═══════════════════════════════════════════════════════════════════
   JOURNAL DE PARCOURS

   Six refus de certification, six rapports décrivant un symptôme sans
   jamais dire QUEL ÉCRAN était affiché ni SUR QUELLE MACHINE. Ce journal
   comble ce trou : une ligne JSON par événement, versée dans le fichier
   de diagnostics que le bouton « Export logs » dépose sur le Bureau.

   Ne jamais y mettre de donnée personnelle : ni e-mail, ni jeton, ni
   chemin de projet. Uniquement matériel et navigation.
   ═══════════════════════════════════════════════════════════════════ */
const _t0 = Date.now();
function journal(type, data) {
  try {
    const evt = { type, ms: Date.now() - _t0, etape: (typeof currentStep === 'string' ? currentStep : null), ...(data || {}) };
    if (window.wizardAPI && window.wizardAPI.journal) window.wizardAPI.journal(evt);
  } catch (_) { /* le journal ne doit JAMAIS casser l'assistant */ }
}

const STEPS = ['welcome', 'detect', 'mode', 'download', 'test', 'no-gpu'];
let currentStep = 'welcome';
let hwReport = null;
let chosenMode = null;

// Ouverture de session : la configuration visible depuis le renderer. Le
// matériel complet arrive plus tard, à la fin de la détection.
journal('session', {
  ecran: `${screen.width}x${screen.height}@${window.devicePixelRatio || 1}`,
  fenetre: `${window.innerWidth}x${window.innerHeight}`,
  langue: navigator.language,
  langues: (navigator.languages || []).slice(0, 4),
  plateforme: navigator.platform,
  ua: navigator.userAgent,
  enLigne: navigator.onLine,
});
try {
  window.wizardAPI.getVersion().then((v) => journal('version', { version: v })).catch(() => {});
} catch (_) {}

// Toute erreur du renderer entre au journal : c'est elle qui expliquera un
// écran vide chez un testeur.
window.addEventListener('error', (e) => journal('erreur', {
  message: e.message, fichier: e.filename, ligne: e.lineno, pile: e.error && e.error.stack ? String(e.error.stack).slice(0, 900) : null,
}));
window.addEventListener('unhandledrejection', (e) => journal('erreur', {
  message: 'rejet non gere', detail: String(e.reason && e.reason.message ? e.reason.message : e.reason).slice(0, 500),
}));

// Tout clic sur un bouton, où qu'il soit. Le libellé est tronqué : on veut
// savoir sur quoi le testeur a appuyé, pas archiver l'interface.
document.addEventListener('click', (e) => {
  const b = e.target.closest('button, a');
  if (!b) return;
  journal('clic', {
    id: b.id || null,
    libelle: (b.textContent || '').trim().slice(0, 40),
    inactif: b.disabled === true,
    cible: b.dataset ? (b.dataset.next || b.dataset.back || null) : null,
  });
}, true);  // capture : on journalise même si un gestionnaire arrête la propagation
// Track which steps have already been initialized so going Back/Next
// doesn't re-run detect / re-trigger a download / re-run the smoke test.
const initialized = new Set();

function goto(step) {
  if (!STEPS.includes(step)) {
    console.warn('[wizard] unknown step:', step);
    return;
  }
  console.log('[wizard] goto', currentStep, '->', step);
  journal('etape', { de: currentStep, vers: step });
  for (const s of STEPS) {
    document.getElementById(`page-${s}`).classList.toggle('active', s === step);
    const head = document.querySelector(`.wiz-step-tag[data-step="${s}"]`);
    if (head) {
      head.classList.toggle('active', s === step);
      head.classList.toggle('done', STEPS.indexOf(s) < STEPS.indexOf(step));
    }
  }
  currentStep = step;
  // Only initialize a step ONCE — back-navigation must not re-trigger
  // the detect / download / test side-effects. `initialized` n'est marqué
  // qu'en cas de SUCCÈS (voir runDetect) : un échec de détection doit pouvoir
  // être retenté, sinon le wizard devient un cul-de-sac (cert Store 10.1.2.10).
  if (step === 'detect' && !initialized.has('detect')) {
    runDetect();
  }
  if (step === 'mode' && hwReport) {
    // Safe to call every time — just re-renders the card states.
    renderModeCards();
    renderDataLocation();
  }
  if (step === 'no-gpu') {
    renderNoGpuPage();
    // Les étapes « Download » / « Test » ne concernent pas le parcours Cloud :
    // les afficher laisse croire qu'un téléchargement de plusieurs Go reste à
    // venir.
    for (const s of ['download', 'test']) {
      const tag = document.querySelector(`.wiz-step-tag[data-step="${s}"]`);
      if (tag) tag.classList.add('hidden');
    }
  }
  if (step === 'download' && !initialized.has('download')) {
    initialized.add('download'); startDownload();
  }
  if (step === 'test' && !initialized.has('test')) {
    initialized.add('test'); runFinalTest();
  }
}

// Une machine ne peut faire tourner les moteurs locaux QUE si elle a un GPU
// NVIDIA avec assez de VRAM. Test tolérant (JSON partiel, casse, futur
// changement de hw_detect) : tout ce qui n'est pas explicitement un GPU NVIDIA
// exploitable part sur le parcours Cloud.
function needsCloudPath() {
  if (!hwReport) return true;
  const reco = String(hwReport.recommended_mode || '').toLowerCase();
  if (reco === 'cloud') return true;
  const gpu = hwReport.gpu;
  if (!gpu || String(gpu.vendor || '').toUpperCase() !== 'NVIDIA') return true;
  return false;
}

// Use closest() so clicks land even on inner elements (icons, spans).
// Also: ignore clicks on disabled buttons (browsers already prevent
// activation, but closest would otherwise still match and trigger goto).
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-back], [data-next]');
  if (!btn || btn.disabled) return;
  let target = btn.dataset.next || btn.dataset.back;
  // If user is leaving Detect to go to Mode but hardware is incompatible,
  // detour to the dedicated no-gpu page instead.
  if (target === 'mode' && needsCloudPath()) {
    target = 'no-gpu';
  }
  // Mode « Cloud » choisi explicitement sur la page Mode : pas de download.
  if (target === 'download' && chosenMode === 'cloud') {
    target = 'no-gpu';
  }
  goto(target);
});

// SIGNUP_URL a été retiré avec le bouton « Create a free account » : plus
// aucun code de l'assistant n'ouvre le navigateur. L'inscription se fait
// depuis la modale de connexion de l'application, au moment où elle sert.

// Titre/texte de la page no-gpu adaptés au matériel réel : la page s'affiche
// AUSSI pour un GPU NVIDIA à VRAM insuffisante (< 12 Go), où « No NVIDIA GPU
// detected » serait faux.
function renderNoGpuPage() {
  const title = document.getElementById('nogpu-title');
  const lead = document.getElementById('nogpu-lead');
  if (!title || !lead) return;
  const gpu = hwReport && hwReport.gpu;
  const isNvidia = !!(gpu && String(gpu.vendor || '').toUpperCase() === 'NVIDIA');

  // CHOIX VOLONTAIRE — cette page s'affiche AUSSI quand l'utilisateur retient
  // « Cloud » sur la page Mode alors que sa machine peut tout faire en local
  // (goto() reroute 'download' vers 'no-gpu' dans ce cas). On lui disait alors
  // que son GPU etait insuffisant : constate le 2026-08-18 sur une RTX 5080 de
  // 16 Go, a qui la page reprochait d'etre « below the 12 GB ». C'est faux, et
  // c'est le genre d'incoherence qu'un testeur releve.
  if (!needsCloudPath()) {
    title.textContent = 'Cloud mode selected';
    lead.innerHTML = 'You chose to generate in the MyFabmesh cloud'
      + (gpu && gpu.model ? ` rather than on your <b>${gpu.model}</b>` : '')
      + '. <b>Everything works the same</b> — images, 3D meshes, rigs and animations are '
      + 'generated on our servers and downloaded straight into your projects. You can switch '
      + 'back to local mode at any time from the settings.';
    return;
  }

  if (isNvidia) {
    const gb = Math.round((gpu.vram_mb || 0) / 1024);
    title.textContent = 'Cloud mode will be used on this PC';
    lead.innerHTML = `Your GPU (<b>${gpu.model}</b>${gb ? `, ${gb} GB VRAM` : ''}) is below the 12 GB `
      + 'the local 3D engine needs, so it would run out of memory. <b>The app will run in Cloud mode '
      + 'instead: everything still works</b> — images, 3D meshes, rigs and animations are generated on '
      + 'the MyFabmesh cloud and downloaded straight into your projects.';
  } else if (gpu) {
    title.textContent = 'Cloud mode will be used on this PC';
    lead.innerHTML = `This device uses <b>${gpu.model}</b> graphics. The local AI models need an NVIDIA `
      + 'GPU, so <b>the app will run in Cloud mode instead: everything still works</b> — images, 3D '
      + 'meshes, rigs and animations are generated on the MyFabmesh cloud and downloaded straight into '
      + 'your projects.';
  }
  // Sinon : le texte par défaut du HTML (aucun GPU rapporté) est correct.
}

// La page « no-gpu » n'a plus qu'UNE action primaire, « Continue in Cloud
// mode », et la navigation « Back ». Les deux boutons qui ouvraient le
// navigateur ont été retirés de wizard.html, leurs gestionnaires avec eux :
//
//   - « Use the website instead » (btn-open-cloud) proposait au testeur de
//     quitter l'application au moment précis où elle venait de lui annoncer
//     qu'elle savait se débrouiller sans GPU ;
//   - « Create a free account » (btn-create-account) ouvrait lui aussi le
//     navigateur. L'inscription reste accessible là où elle sert : l'app
//     présente sa modale de connexion, lien d'inscription compris, dès qu'une
//     action cloud le demande (`needsCloudLogin`).
//
// Cette page est vue par TOUT testeur de certification — ils sont toujours sur
// une machine sans GPU NVIDIA. Elle doit poser une décision, pas un menu.

// ---------- STEP 2: detect ----------
async function runDetect() {
  const status = document.getElementById('detect-status');
  const retryBtn = document.getElementById('btn-detect-retry');
  status.classList.remove('hidden', 'error');
  status.textContent = 'Checking your system (this takes a few seconds)...';
  if (retryBtn) retryBtn.classList.add('hidden');
  try {
    hwReport = await window.wizardAPI.detectHardware();
    if (!hwReport || typeof hwReport !== 'object') throw new Error('empty report');
    initialized.add('detect');
    // LA CONFIG de la machine. C'est ce qui manquait a chaque rapport de
    // certification : « observed on devices running OS build X » ne dit rien
    // du GPU, de la VRAM ni de la RAM de la machine de test.
    journal('config', {
      gpu: hwReport.gpu ? { vendeur: hwReport.gpu.vendor, modele: hwReport.gpu.model, vram_mo: hwReport.gpu.vram_mb, pilote: hwReport.gpu.driver } : null,
      ram_mo: hwReport.ram_mb,
      disque_libre_go: hwReport.disk_free_gb,
      mode_recommande: hwReport.recommended_mode,
      pilote_ok: hwReport.driver_ok,
      avertissements: hwReport.warnings || [],
      parcours_cloud: needsCloudPath(),
    });
  } catch (e) {
    // DÉGRADATION SÛRE : la détection ne doit jamais empêcher d'entrer dans
    // l'application. Sans rapport matériel exploitable on suppose « pas de GPU
    // NVIDIA » → parcours Cloud, qui ne télécharge rien et fonctionne partout.
    console.warn('[wizard] detect failed, falling back to Cloud mode:', (e && e.message) || e);
    hwReport = {
      gpu: null, ram_mb: 0, disk_free_gb: 0,
      recommended_mode: 'cloud', driver_ok: false,
      warnings: ['Hardware check unavailable on this PC — Cloud mode will be used (nothing to download).'],
    };
    status.classList.remove('hidden');
    status.textContent = 'Hardware check unavailable — MyFabmesh.AI will use Cloud mode. Click Continue.';
    if (retryBtn) retryBtn.classList.remove('hidden');
    document.getElementById('btn-detect-next').disabled = false;
    journal('config', { detection: 'ECHEC', raison: String((e && e.message) || e).slice(0, 200), repli: 'cloud' });
    return;
  }
  status.classList.add('hidden');
  document.getElementById('detect-results').classList.remove('hidden');

  const fmtGB = (mb) => (mb / 1024).toFixed(1) + ' GB';
  const gpu = hwReport.gpu;
  const setRow = (id, text, cls) => {
    const el = document.getElementById(id);
    el.textContent = text;
    el.className = 'wiz-val ' + (cls || '');
    // Chaque critère au journal avec son verdict : c'est exactement ce que le
    // testeur a sous les yeux sur la page « Checking your system ».
    journal('verdict', {
      critere: id.replace(/^r-/, ''),
      valeur: String(text).slice(0, 60),
      statut: cls === 'ok' ? 'PASS' : (cls === 'warn' ? 'AVERTISSEMENT' : (cls === 'bad' ? 'REJETE' : 'INCONNU')),
    });
  };

  if (gpu && String(gpu.vendor || '').toUpperCase() === 'NVIDIA') {
    setRow('r-gpu', `${gpu.model}`, 'ok');
    setRow('r-vram', gpu.vram_mb ? fmtGB(gpu.vram_mb) : 'unknown',
      gpu.vram_mb >= 12 * 1024 ? 'ok' : (gpu.vram_mb >= 6 * 1024 ? 'warn' : 'bad'));
    setRow('r-driver', gpu.driver || '–',
      hwReport.driver_ok ? 'ok' : 'warn');
  } else if (gpu) {
    // GPU Intel/AMD : ce n'est PAS une panne, c'est un choix de mode. Affichage
    // informatif (warn) et non « bad » — sinon le tableau matériel se lit comme
    // un diagnostic d'échec (retour de certification Store).
    setRow('r-gpu', `${gpu.model} — Cloud mode`, 'warn');
    setRow('r-vram', gpu.vram_mb ? fmtGB(gpu.vram_mb) : 'n/a', 'warn');
    setRow('r-driver', gpu.driver || 'n/a', 'warn');
  } else {
    setRow('r-gpu', 'No NVIDIA GPU — Cloud mode', 'warn');
    setRow('r-vram', 'n/a', 'warn');
    setRow('r-driver', 'n/a', 'warn');
  }
  const ramMb = hwReport.ram_mb || 0;
  setRow('r-ram', ramMb ? fmtGB(ramMb) : 'n/a',
    ramMb >= 16 * 1024 ? 'ok' : (ramMb >= 8 * 1024 ? 'warn' : 'bad'));
  const diskGb = hwReport.disk_free_gb || 0;
  // En parcours Cloud rien n'est téléchargé : l'espace disque n'est pas un
  // critère bloquant, on ne l'affiche donc pas en rouge.
  const diskCls = needsCloudPath() ? (diskGb >= 2 ? 'ok' : 'warn')
    : (diskGb >= 25 ? 'ok' : (diskGb >= 15 ? 'warn' : 'bad'));
  setRow('r-disk', diskGb + ' GB', diskCls);

  if (hwReport.warnings && hwReport.warnings.length) {
    const wbox = document.getElementById('detect-warnings');
    wbox.innerHTML = hwReport.warnings.map(w => `<div class="w">${w}</div>`).join('');
    wbox.classList.remove('hidden');
  }
  document.getElementById('btn-detect-next').disabled = false;
}

// Retry manuel de la détection (affiché uniquement après un échec).
document.getElementById('btn-detect-retry')?.addEventListener('click', () => {
  initialized.delete('detect');
  runDetect();
});

// ---------- STEP 3: mode ----------
// VRAM thresholds in MB. 16 GB cards (RTX 4080/5080) report ~16300 MB
// after driver overhead, so we use 15 GB as the Full threshold rather
// than a strict 16384 that would lock them out for ~80 MB of fluff.
// La carte « cloud » n'a AUCUNE exigence VRAM : elle reste toujours activable,
// pour qu'aucune machine ne puisse se retrouver avec toutes les cartes grisées.
const MODE_VRAM_REQ = { full: 15 * 1024, standard: 11 * 1024, lite: 6 * 1024, cloud: 0 };

function renderModeCards() {
  const reco = hwReport.recommended_mode;
  const vram = (hwReport.gpu && hwReport.gpu.vram_mb) || 0;
  const isNvidia = !!(hwReport.gpu && String(hwReport.gpu.vendor || '').toUpperCase() === 'NVIDIA');
  for (const card of document.querySelectorAll('.wiz-mode-card')) {
    const m = card.dataset.mode;
    card.classList.toggle('recommended', m === reco);
    // Les modes locaux exigent un GPU NVIDIA ET assez de VRAM ; 'cloud' jamais.
    const req = MODE_VRAM_REQ[m];
    const unavailable = (m !== 'cloud') && (!isNvidia || vram < (req || 0));
    card.classList.toggle('disabled', unavailable);
    const input = card.querySelector('input');
    if (input) input.disabled = unavailable;
  }
  // Auto-select reco if it's not disabled, otherwise the highest
  // available mode (full > standard > lite), Cloud en dernier recours.
  let target = reco;
  const cardFor = (m) => document.querySelector(`.wiz-mode-card[data-mode="${m}"]`);
  if (!cardFor(target) || cardFor(target).classList.contains('disabled')) {
    target = null;
    for (const m of ['full', 'standard', 'lite', 'cloud']) {
      const c = cardFor(m);
      if (c && !c.classList.contains('disabled')) { target = m; break; }
    }
  }
  // Aucune carte disponible (ne devrait plus arriver grâce à la carte Cloud) :
  // on ne laisse SURTOUT pas l'utilisateur bloqué avec Continue grisé.
  if (!target) { goto('no-gpu'); return; }
  const recoCard = cardFor(target);
  if (recoCard) {
    for (const c of document.querySelectorAll('.wiz-mode-card')) c.classList.remove('selected');
    recoCard.querySelector('input').checked = true;
    recoCard.classList.add('selected');
    chosenMode = target;
    journal('mode', { choisi: chosenMode, par: 'recommandation' });
    document.getElementById('btn-mode-next').disabled = false;
  }
}

document.querySelectorAll('.wiz-mode-card').forEach(card => {
  card.addEventListener('click', () => {
    if (card.classList.contains('disabled')) return;
    document.querySelectorAll('.wiz-mode-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    card.querySelector('input').checked = true;
    chosenMode = card.dataset.mode;
    journal('mode', { choisi: chosenMode, par: 'utilisateur' });
    document.getElementById('btn-mode-next').disabled = false;
  });
});

// ---------- Data location (shown on the Mode step) ----------
async function renderDataLocation() {
  try {
    const loc = await window.wizardAPI.getDataLocation();
    const pathEl = document.getElementById('wiz-data-path');
    const freeEl = document.getElementById('wiz-data-free');
    if (pathEl) {
      pathEl.textContent = loc.isDefault ? 'Default (your user folder, on C:)' : loc.path;
      pathEl.title = loc.path;
    }
    if (freeEl) {
      freeEl.style.color = '';
      freeEl.textContent = loc.freeBytes ? '· ' + (loc.freeBytes / 1073741824).toFixed(0) + ' GB free' : '';
    }
  } catch (_) {}
}
(() => {
  const btn = document.getElementById('wiz-data-change');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const r = await window.wizardAPI.pickDataFolder();
      if (r && r.ok) {
        await renderDataLocation();
        if (r.restartNeeded) {
          const ok = await wizConfirm({
            title: 'Restart to apply',
            body: 'MyFabmesh.AI will restart to use the new location:\n' + r.path + '\n\nNothing is downloaded yet, so this is instant.',
            okLabel: 'Restart now', cancelLabel: 'Later',
          });
          if (ok) { await window.wizardAPI.restartApp(); }
        }
      } else if (r && r.error) {
        const freeEl = document.getElementById('wiz-data-free');
        if (freeEl) { freeEl.style.color = 'var(--error)'; freeEl.textContent = '· ' + r.error; }
      }
    } catch (_) {}
    btn.disabled = false;
  });
})();

// ---------- STEP 4: download ----------
async function startDownload() {
  // Only block "Continue" until the download is done — Back stays
  // enabled so the user can never get stuck on this step. If they
  // navigate away mid-download, the next time they hit Continue the
  // huggingface_hub resume kicks in from where it left off.
  document.getElementById('btn-dl-next').disabled = true;
  const list = document.getElementById('dl-list');
  list.innerHTML = '<div class="wiz-dl-row"><span class="name">Preparing model list...</span></div>';

  if (chosenMode === 'cloud') {
    list.innerHTML = '<div class="wiz-dl-row"><span class="name">Cloud mode: no download needed.</span></div>';
    document.getElementById('btn-dl-next').disabled = false;
    return;
  }

  // ---- Preflight: is there enough free disk on the data drive? A multi-GB
  // install that dies half-way on a full disk leaves a permanently-broken
  // setup, so warn UP FRONT. Needed ≈ models (from the plan) + ~7 GB for the
  // torch/diffusers env. Non-fatal if the probe itself fails (fall through).
  try {
    const _plan0 = await window.wizardAPI.getDownloadPlan(chosenMode);
    const _fs0 = await window.wizardAPI.freeSpace();
    if (_fs0 && _fs0.ok && typeof _fs0.freeBytes === 'number') {
      // models (plan) + ~7 GB AI env + ~14 GB rig engine (torch 2.7 env
      // 4 GB + Puppeteer checkpoints ~10 GB, Phase 3)
      const neededGb = ((_plan0.total_mb || 0) / 1024) + 7 + 14;
      const freeGb = _fs0.freeBytes / (1024 ** 3);
      if (freeGb < neededGb) {
        list.innerHTML = `<div class="wiz-dl-row"><span class="name" style="color:var(--error)">Not enough free space on ${_fs0.drive || 'your data drive'}: about <b>${neededGb.toFixed(0)} GB</b> is needed but only <b>${freeGb.toFixed(1)} GB</b> is free.<br>Free up space (or change the data folder to a bigger drive), then <a href="#" id="retry-dl">Retry</a>.</span></div>`;
        document.getElementById('retry-dl')?.addEventListener('click', () => {
          initialized.delete('download');
          startDownload();
        });
        return;  // btn-dl-next stays disabled — can't proceed until space is freed
      }
    }
  } catch (_) { /* probe failed — don't block, let the install try */ }

  // ---- Phase 1: provision the AI engine (torch/diffusers) into a
  // writable per-user Python env. REQUIRED before the model download.
  // This is a big (~5 GB) one-time install — show CLEAR, PATIENT progress
  // with named steps so users don't think it froze (it can take 10-20 min
  // on a slow connection; the pip phase reports by step, not by bytes).
  const _AIENV_STEPS = {
    'copy-python': 'Preparing the Python environment…',
    'pip-bootstrap': 'Setting up the installer…',
    'torch': 'Downloading PyTorch (~2.5 GB)…',
    'pypi': 'Installing libraries (diffusers, transformers…)…',
    'xformers-optional': 'Installing xformers (speed boost)…',
    'flash-attn-optional': 'Finishing up…',
    'done': 'AI engine ready ✓',
  };
  list.innerHTML = `
    <div class="wiz-dl-row in-progress" data-id="__aienv">
      <span class="name" id="aienv-name">Installing the AI engine…</span>
      <span class="size">~5 GB</span>
      <div class="bar"><div class="bar-fill"></div></div>
    </div>
    <div class="wiz-dl-row"><span class="name" style="opacity:.65" id="aienv-note">One-time setup (~5 GB). Your PC may feel slow and the progress bar may pause for a few minutes during the big downloads — this is normal. You can leave it running; just keep this window open.</span></div>`;
  // The byte/speed/ETA counters are for the MODEL download, not this pip
  // install (which reports by step, not by bytes) — show "—" meanwhile so
  // they don't read as "frozen at 0".
  for (const id of ['dl-done', 'dl-total', 'dl-speed', 'dl-eta']) {
    const el = document.getElementById(id); if (el) el.textContent = '—';
  }
  window.wizardAPI.onInstallProgress((p) => {
    const fill = document.querySelector('.wiz-dl-row[data-id="__aienv"] .bar-fill');
    if (fill && typeof p.pct === 'number') fill.style.width = Math.max(3, p.pct) + '%';
    const name = document.getElementById('aienv-name');
    if (name && p.step && _AIENV_STEPS[p.step]) name.textContent = _AIENV_STEPS[p.step];
    if (p.done) {
      const row = document.querySelector('.wiz-dl-row[data-id="__aienv"]');
      if (row) { row.classList.add('done'); row.classList.remove('in-progress'); }
    }
  });
  console.log('[wizard] Phase 1: installing AI engine (torch/diffusers)…');
  try {
    await window.wizardAPI.installDeps();
    console.log('[wizard] Phase 1: AI engine install OK');
  } catch (e) {
    console.error('[wizard] AI engine install FAILED:', (e && e.message) || e);
    list.innerHTML += `<div class="wiz-dl-row"><span class="name" style="color:var(--error)">AI engine install failed: ${e.message}. <a href="#" id="retry-dl">Retry</a></span></div>`;
    document.getElementById('retry-dl')?.addEventListener('click', () => {
      initialized.delete('download');
      startDownload();
    });
    return;
  }

  // ---- Phase 2: download the model weights.
  list.innerHTML = '<div class="wiz-dl-row"><span class="name">Preparing model list…</span></div>';
  const plan = await window.wizardAPI.getDownloadPlan(chosenMode);
  list.innerHTML = '';
  for (const item of plan.items) {
    const row = document.createElement('div');
    row.className = 'wiz-dl-row';
    row.dataset.id = item.id;
    row.innerHTML = `
      <span class="name">${item.label}</span>
      <span class="timer"></span>
      <span class="size">${item.size_mb} MB</span>
      <div class="bar"><div class="bar-fill"></div></div>`;
    list.appendChild(row);
  }
  document.getElementById('dl-total').textContent = plan.total_mb;

  window.wizardAPI.onDownloadProgress((p) => {
    // A per-model error: essential-model failures also reject the whole
    // promise (Retry path below), but OPTIONAL models (upscaler / extra
    // captioner) only warn and keep going — surface which one failed inline
    // so a "complete"-looking list isn't silently missing a model.
    if (p.error && p.id && p.id !== '__all__') {
      const erow = document.querySelector(`.wiz-dl-row[data-id="${p.id}"]`);
      if (erow && !erow.dataset.errShown) {
        erow.dataset.errShown = '1';
        erow.classList.remove('in-progress');
        const nm = erow.querySelector('.name');
        if (nm) nm.insertAdjacentHTML('beforeend', ` <span style="color:var(--error)">— failed</span>`);
      }
      return;
    }
    const row = document.querySelector(`.wiz-dl-row[data-id="${p.id}"]`);
    if (row) {
      row.querySelector('.bar-fill').style.width = p.pct + '%';
      const timer = row.querySelector('.timer');
      if (p.done) {
        row.classList.add('done');
        row.classList.remove('in-progress');
        if (timer) timer.textContent = '';
      } else if (p.in_progress) {
        row.classList.add('in-progress');
        if (timer) timer.textContent = (p.elapsed_s || 0).toFixed(0) + 's';
      }
    }
    document.getElementById('dl-done').textContent = p.total_done_mb || 0;
    document.getElementById('dl-speed').textContent = (p.speed_mbps || 0).toFixed(1);
    document.getElementById('dl-eta').textContent = p.eta || '–';
  });

  console.log(`[wizard] Phase 2: downloading models (mode=${chosenMode}, ${plan.total_mb} MB)…`);
  try {
    await window.wizardAPI.startDownload(chosenMode);
    console.log('[wizard] Phase 2: model download OK');
  } catch (e) {
    console.error('[wizard] Model download FAILED:', (e && e.message) || e);
    list.innerHTML += `<div class="wiz-dl-row"><span class="name" style="color:var(--error)">Download failed: ${e.message}. <a href="#" id="retry-dl">Retry</a></span></div>`;
    document.getElementById('retry-dl')?.addEventListener('click', () => {
      initialized.delete('download');
      startDownload();
    });
    return;
  }

  // ---- Phase 3: rig engine (Puppeteer auto-rig). SEPARATE Python env
  // (torch 2.7 — incompatible with the AI env's 2.8) + code tree + 3
  // checkpoints (~9.6 GB, resumable). A failure here does NOT block the
  // wizard: mesh generation works without rigging, so Continue stays
  // available with a clear warning.
  const _RIG_STEPS = {
    'rig-copy-python': 'Preparing the rig Python environment…',
    'rig-pip-bootstrap': 'Setting up the rig installer…',
    'rig-torch': 'Downloading PyTorch for the rig engine (~3.3 GB)…',
    'rig-scatter': 'Installing rig libraries (torch-scatter)…',
    'rig-flash-attn': 'Installing rig libraries (flash-attention)…',
    'rig-pypi': 'Installing rig libraries…',
    'rig-code': 'Installing the rig engine code…',
    'done': 'Rig engine ready ✓',
  };
  list.innerHTML += `
    <div class="wiz-dl-row in-progress" data-id="__rigenv">
      <span class="name" id="rigenv-name">Installing the rig engine (auto-rig)…</span>
      <span class="size">~14 GB</span>
      <div class="bar"><div class="bar-fill"></div></div>
    </div>`;
  window.wizardAPI.onRigProgress((p) => {
    const fill = document.querySelector('.wiz-dl-row[data-id="__rigenv"] .bar-fill');
    if (fill && typeof p.pct === 'number') fill.style.width = Math.max(3, p.pct) + '%';
    const name = document.getElementById('rigenv-name');
    if (name && p.step) {
      if (_RIG_STEPS[p.step]) name.textContent = _RIG_STEPS[p.step];
      else if (p.step.startsWith('rig-ckpt-')) name.textContent = `Downloading rig model ${p.step.slice(9)}…`;
    }
    if (p.done && !p.error) {
      const row = document.querySelector('.wiz-dl-row[data-id="__rigenv"]');
      if (row) { row.classList.add('done'); row.classList.remove('in-progress'); }
    }
  });
  console.log('[wizard] Phase 3: installing rig engine (Puppeteer)…');
  try {
    await window.wizardAPI.installRig();
    console.log('[wizard] Phase 3: rig engine install OK');
  } catch (e) {
    console.error('[wizard] Rig engine install FAILED:', (e && e.message) || e);
    list.innerHTML += `<div class="wiz-dl-row"><span class="name" style="color:var(--error)">Rig engine install failed: ${e.message}.<br>You can continue — 3D generation works without it, but auto-rigging will be unavailable until you re-run setup (Settings → Reconfigure). <a href="#" id="retry-rig">Retry now</a></span></div>`;
    document.getElementById('retry-rig')?.addEventListener('click', () => {
      initialized.delete('download');
      startDownload();
    });
  }
  document.getElementById('btn-dl-next').disabled = false;
}

// ---------- STEP 5: final test ----------
async function runFinalTest() {
  const status = document.getElementById('test-status');
  const log = document.getElementById('test-log');
  status.textContent = 'Running test generation...';
  log.textContent = '';

  window.wizardAPI.onTestLog((line) => {
    log.textContent += line + '\n';
    log.scrollTop = log.scrollHeight;
  });

  try {
    const result = await window.wizardAPI.runFinalTest(chosenMode);
    journal('test_final', {
      statut: result && result.success ? 'PASS' : 'REJETE',
      mode: chosenMode,
      duree_s: result ? result.duration_s : null,
      erreur: result && !result.success ? String(result.error || '').slice(0, 300) : null,
    });
    if (result.success) {
      // 2026-06-14: animated success — a checkmark that draws itself in
      // a popping circle, then the text fades up. Replaces the plain
      // "✓ Test passed" line.
      status.classList.remove('error');
      status.innerHTML = `
        <div class="wiz-test-success">
          <svg class="wiz-check" viewBox="0 0 52 52" aria-hidden="true">
            <circle class="wiz-check-circle" cx="26" cy="26" r="24" fill="none"/>
            <path class="wiz-check-path" fill="none" d="M14 27 l8 8 l16 -18"/>
          </svg>
          <div class="wiz-test-success-text">
            <div class="wiz-test-success-title">Test passed</div>
            <div class="wiz-test-success-sub">Completed in ${result.duration_s}s · MyFabmesh.AI is ready</div>
          </div>
        </div>`;
      // Trigger the launch button with a subtle highlight.
      const launch = document.getElementById('btn-launch');
      launch.disabled = false;
      launch.classList.add('wiz-launch-ready');
    } else {
      status.textContent = '⚠ Test failed: ' + result.error;
      status.classList.add('error');
      document.getElementById('btn-launch').disabled = true;
    }
  } catch (e) {
    status.textContent = '⚠ Test crashed: ' + e.message;
    status.classList.add('error');
    journal('test_final', { statut: 'PLANTE', mode: chosenMode, erreur: String(e && e.message).slice(0, 300) });
  }
}

document.getElementById('btn-launch').addEventListener('click', async () => {
  journal('fin', { sortie: 'lancement', mode: chosenMode });
  await window.wizardAPI.completeSetup({ mode: chosenMode, hw: hwReport });
});

// Page « no-gpu » : lancer l'app EN MODE CLOUD (et non le site web). Sans ce
// bouton, une machine sans GPU NVIDIA (Surface des testeurs Store, laptops)
// n'avait AUCUN moyen d'ouvrir l'application — le wizard renvoyait vers le
// navigateur. Le mode Cloud route désormais tout le pipeline vers le worker.
document.getElementById('btn-launch-cloud')?.addEventListener('click', async () => {
  const b = document.getElementById('btn-launch-cloud');
  if (b) { b.disabled = true; b.textContent = 'Starting…'; }
  try { localStorage.setItem('fab-compute-mode', 'cloud'); } catch (_) {}
  journal('fin', { sortie: 'lancement_cloud', mode: 'cloud' });
  await window.wizardAPI.completeSetup({ mode: 'cloud', hw: hwReport });
});

// Export logs button — one click → diagnostics .txt on the Desktop,
// so a user (or a friend testing the app) can send it to support
// instead of hunting through %APPDATA%.
(() => {
  const btn = document.getElementById('wiz-export-logs');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'Exporting…';
    let label = 'Export failed';
    try {
      const r = await window.wizardAPI.exportDiagnostics();
      if (r && r.ok) label = 'Saved to Desktop ✓';
    } catch (_) {}
    btn.textContent = label;
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3500);
  });
})();

// Brand in the topbar = link to the public website.
(() => {
  const brand = document.querySelector('#topbar .brand');
  if (!brand) return;
  brand.style.cursor = 'pointer';
  brand.title = 'Open the MyFabmesh.AI website';  // matches the github.io destination (myfabmesh.ai is not live)
  brand.addEventListener('click', () => {
    if (window.wizardAPI?.openExternal) {
      window.wizardAPI.openExternal('https://fabienlacaze.github.io/MyFabmesh/');
    }
  });
})();

// Show app version in the bottom-right corner.
(async () => {
  try {
    const v = await window.wizardAPI.getVersion();
    const el = document.getElementById('wiz-version');
    if (el && v) el.textContent = 'MyFabmesh.AI v' + v;
  } catch (_) {}
})();

// Branded confirm modal. Replaces window.confirm (native dialog is
// styled by the OS — ugly title bar showing the package name).
function wizConfirm({ title, body, okLabel = 'Confirm', cancelLabel = 'Cancel' }) {
  return new Promise((resolve) => {
    const modal  = document.getElementById('wiz-confirm');
    const titleE = document.getElementById('wiz-confirm-title');
    const bodyE  = document.getElementById('wiz-confirm-body');
    const okE    = document.getElementById('wiz-confirm-ok');
    const cancE  = document.getElementById('wiz-confirm-cancel');
    if (!modal) return resolve(window.confirm(body));
    titleE.textContent = title || 'Are you sure?';
    bodyE.textContent  = body;
    okE.textContent    = okLabel;
    cancE.textContent  = cancelLabel;
    modal.classList.remove('hidden');
    let cleanup = null;
    const close = (val) => {
      modal.classList.add('hidden');
      okE.onclick = cancE.onclick = null;
      modal.querySelector('.wiz-modal-backdrop').onclick = null;
      if (cleanup) document.removeEventListener('keydown', cleanup);
      resolve(val);
    };
    okE.onclick   = () => close(true);
    cancE.onclick = () => close(false);
    modal.querySelector('.wiz-modal-backdrop').onclick = () => close(false);
    cleanup = (e) => {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter')  close(true);
    };
    document.addEventListener('keydown', cleanup);
  });
}

// Cancel button: label depends on whether this is a first-run or a
// reconfigure (user clicked "Reconfigure MyFabmesh.AI" from Settings).
(async () => {
  const btn = document.getElementById('wiz-cancel-btn');
  if (!btn) return;
  let wizMode = 'first-run';
  try {
    const r = await window.wizardAPI.getMode();
    wizMode = r?.mode || 'first-run';
  } catch (_) {}
  btn.textContent = (wizMode === 'reconfigure') ? 'Cancel' : 'Quit';
  btn.addEventListener('click', async () => {
    const isReco = wizMode === 'reconfigure';
    const ok = await wizConfirm({
      title: isReco ? 'Cancel reconfiguration?' : 'Quit setup?',
      body: isReco
        ? 'Your previous install mode will be restored and you will return to MyFabmesh.AI.'
        : 'MyFabmesh.AI will close. You can re-run the setup wizard at any time by launching MyFabmesh.AI again.',
      okLabel: isReco ? 'Cancel reconfiguration' : 'Quit MyFabmesh.AI',
      cancelLabel: 'Keep setting up',
    });
    if (!ok) return;
    // Un testeur qui QUITTE l'assistant, et a quelle etape, est l'information
    // la plus precieuse d'un refus : elle dit ou il a renonce.
    journal('fin', { sortie: isReco ? 'reconfiguration_annulee' : 'abandon', mode: chosenMode });
    try { await window.wizardAPI.cancel(); } catch (_) {}
  });
})();

// Start fresh on welcome
goto('welcome');
