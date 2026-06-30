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

const STEPS = ['welcome', 'detect', 'mode', 'download', 'test', 'no-gpu'];
let currentStep = 'welcome';
let hwReport = null;
let chosenMode = null;
// Track which steps have already been initialized so going Back/Next
// doesn't re-run detect / re-trigger a download / re-run the smoke test.
const initialized = new Set();

function goto(step) {
  if (!STEPS.includes(step)) {
    console.warn('[wizard] unknown step:', step);
    return;
  }
  console.log('[wizard] goto', currentStep, '->', step);
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
  // the detect / download / test side-effects.
  if (step === 'detect' && !initialized.has('detect')) {
    initialized.add('detect'); runDetect();
  }
  if (step === 'mode' && hwReport) {
    // Safe to call every time — just re-renders the card states.
    renderModeCards();
  }
  if (step === 'download' && !initialized.has('download')) {
    initialized.add('download'); startDownload();
  }
  if (step === 'test' && !initialized.has('test')) {
    initialized.add('test'); runFinalTest();
  }
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
  if (target === 'mode' && hwReport && hwReport.recommended_mode === 'cloud') {
    target = 'no-gpu';
  }
  goto(target);
});

// Cloud redirect button (no-gpu page).
document.addEventListener('DOMContentLoaded', () => {
  const cloudBtn = document.getElementById('btn-open-cloud');
  if (cloudBtn) {
    cloudBtn.addEventListener('click', () => {
      // Opening the cloud URL relies on the main process — we just send
      // an IPC. For now, fall back to window.open if wizardAPI doesn't
      // expose openExternal yet.
      const url = 'https://fabmesh.com/cloud';
      if (window.wizardAPI && window.wizardAPI.openExternal) {
        window.wizardAPI.openExternal(url);
      } else {
        window.open(url, '_blank');
      }
    });
  }
});

// ---------- STEP 2: detect ----------
async function runDetect() {
  const status = document.getElementById('detect-status');
  status.textContent = 'Detecting hardware (this takes ~10 seconds)...';
  status.classList.remove('error');
  try {
    hwReport = await window.wizardAPI.detectHardware();
  } catch (e) {
    status.classList.add('error');
    status.textContent = 'Detection failed: ' + e.message;
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
  };

  if (gpu) {
    setRow('r-gpu', `${gpu.model}`, gpu.vendor === 'NVIDIA' ? 'ok' : 'warn');
    setRow('r-vram', gpu.vram_mb ? fmtGB(gpu.vram_mb) : 'unknown',
      gpu.vram_mb >= 12 * 1024 ? 'ok' : (gpu.vram_mb >= 6 * 1024 ? 'warn' : 'bad'));
    setRow('r-driver', gpu.driver || '–',
      hwReport.driver_ok ? 'ok' : 'warn');
  } else {
    setRow('r-gpu', 'Not detected', 'bad');
    setRow('r-vram', '–', 'bad');
    setRow('r-driver', '–', 'bad');
  }
  setRow('r-ram', fmtGB(hwReport.ram_mb),
    hwReport.ram_mb >= 16 * 1024 ? 'ok' : (hwReport.ram_mb >= 8 * 1024 ? 'warn' : 'bad'));
  setRow('r-disk', hwReport.disk_free_gb + ' GB',
    hwReport.disk_free_gb >= 25 ? 'ok' : (hwReport.disk_free_gb >= 15 ? 'warn' : 'bad'));

  if (hwReport.warnings && hwReport.warnings.length) {
    const wbox = document.getElementById('detect-warnings');
    wbox.innerHTML = hwReport.warnings.map(w => `<div class="w">${w}</div>`).join('');
    wbox.classList.remove('hidden');
  }
  document.getElementById('btn-detect-next').disabled = false;
}

// ---------- STEP 3: mode ----------
// VRAM thresholds in MB. 16 GB cards (RTX 4080/5080) report ~16300 MB
// after driver overhead, so we use 15 GB as the Full threshold rather
// than a strict 16384 that would lock them out for ~80 MB of fluff.
const MODE_VRAM_REQ = { full: 15 * 1024, standard: 11 * 1024, lite: 6 * 1024 };

function renderModeCards() {
  const reco = hwReport.recommended_mode;
  const vram = (hwReport.gpu && hwReport.gpu.vram_mb) || 0;
  for (const card of document.querySelectorAll('.wiz-mode-card')) {
    const m = card.dataset.mode;
    card.classList.toggle('recommended', m === reco);
    const tooLowVram = vram < MODE_VRAM_REQ[m];
    card.classList.toggle('disabled', tooLowVram);
    card.querySelector('input').disabled = tooLowVram;
  }
  // Auto-select reco if it's not disabled, otherwise the highest
  // available mode (full > standard > lite).
  let target = reco;
  if (!document.querySelector(`.wiz-mode-card[data-mode="${target}"]`)
      || document.querySelector(`.wiz-mode-card[data-mode="${target}"]`).classList.contains('disabled')) {
    for (const m of ['full', 'standard', 'lite']) {
      const c = document.querySelector(`.wiz-mode-card[data-mode="${m}"]`);
      if (c && !c.classList.contains('disabled')) { target = m; break; }
    }
  }
  const recoCard = document.querySelector(`.wiz-mode-card[data-mode="${target}"]`);
  if (recoCard) {
    recoCard.querySelector('input').checked = true;
    recoCard.classList.add('selected');
    chosenMode = target;
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
    document.getElementById('btn-mode-next').disabled = false;
  });
});

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

  // ---- Phase 1: provision the AI engine (torch/diffusers) into a
  // writable per-user Python env. REQUIRED before the model download,
  // which itself needs huggingface_hub installed here.
  list.innerHTML = `
    <div class="wiz-dl-row in-progress" data-id="__aienv">
      <span class="name">Installing AI engine (PyTorch, diffusers)…</span>
      <span class="timer" id="aienv-step"></span>
      <span class="size">~5 GB</span>
      <div class="bar"><div class="bar-fill"></div></div>
    </div>`;
  window.wizardAPI.onInstallProgress((p) => {
    const row = document.querySelector('.wiz-dl-row[data-id="__aienv"]');
    if (!row) return;
    if (typeof p.pct === 'number') row.querySelector('.bar-fill').style.width = p.pct + '%';
    const step = document.getElementById('aienv-step');
    if (step) step.textContent = p.current ? '' : (p.msg || p.step || '');
    if (p.done) { row.classList.add('done'); row.classList.remove('in-progress'); }
  });
  try {
    await window.wizardAPI.installDeps();
  } catch (e) {
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

  try {
    await window.wizardAPI.startDownload(chosenMode);
    document.getElementById('btn-dl-next').disabled = false;
  } catch (e) {
    list.innerHTML += `<div class="wiz-dl-row"><span class="name" style="color:var(--error)">Download failed: ${e.message}. <a href="#" id="retry-dl">Retry</a></span></div>`;
    document.getElementById('retry-dl')?.addEventListener('click', () => {
      initialized.delete('download');
      startDownload();
    });
  }
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
  }
}

document.getElementById('btn-launch').addEventListener('click', async () => {
  await window.wizardAPI.completeSetup({ mode: chosenMode, hw: hwReport });
});

// Brand in the topbar = link to the public website.
(() => {
  const brand = document.querySelector('#topbar .brand');
  if (!brand) return;
  brand.style.cursor = 'pointer';
  brand.title = 'Open myfabmesh.ai';
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
    try { await window.wizardAPI.cancel(); } catch (_) {}
  });
})();

// Start fresh on welcome
goto('welcome');
