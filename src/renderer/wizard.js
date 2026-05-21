'use strict';

const STEPS = ['welcome', 'detect', 'mode', 'download', 'test'];
let currentStep = 'welcome';
let hwReport = null;
let chosenMode = null;

function goto(step) {
  for (const s of STEPS) {
    document.getElementById(`page-${s}`).classList.toggle('active', s === step);
    const head = document.querySelector(`.wiz-step[data-step="${s}"]`);
    if (head) {
      head.classList.toggle('active', s === step);
      head.classList.toggle('done', STEPS.indexOf(s) < STEPS.indexOf(step));
    }
  }
  currentStep = step;
  if (step === 'detect' && !hwReport) runDetect();
  if (step === 'mode' && hwReport) renderModeCards();
  if (step === 'download') startDownload();
  if (step === 'test') runFinalTest();
}

document.addEventListener('click', (e) => {
  if (e.target.matches('[data-next]')) goto(e.target.dataset.next);
  if (e.target.matches('[data-back]')) goto(e.target.dataset.back);
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
    el.className = 'val ' + (cls || '');
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
  setRow('r-bw', (hwReport.bandwidth_mbps || 0) + ' MB/s',
    hwReport.bandwidth_mbps >= 5 ? 'ok' : 'warn');

  if (hwReport.warnings && hwReport.warnings.length) {
    const wbox = document.getElementById('detect-warnings');
    wbox.innerHTML = hwReport.warnings.map(w => `<div class="w">${w}</div>`).join('');
    wbox.classList.remove('hidden');
  }
  document.getElementById('btn-detect-next').disabled = false;
}

// ---------- STEP 3: mode ----------
const MODE_VRAM_REQ = { full: 16 * 1024, standard: 12 * 1024, lite: 6 * 1024, cloud: 0 };

function renderModeCards() {
  const reco = hwReport.recommended_mode;
  const vram = (hwReport.gpu && hwReport.gpu.vram_mb) || 0;
  for (const card of document.querySelectorAll('.mode-card')) {
    const m = card.dataset.mode;
    card.classList.toggle('recommended', m === reco);
    const tooLowVram = vram < MODE_VRAM_REQ[m];
    card.classList.toggle('disabled', tooLowVram && m !== 'cloud');
    card.querySelector('input').disabled = tooLowVram && m !== 'cloud';
  }
  // Auto-select reco
  const recoCard = document.querySelector(`.mode-card[data-mode="${reco}"]`);
  if (recoCard) {
    recoCard.querySelector('input').checked = true;
    recoCard.classList.add('selected');
    chosenMode = reco;
    document.getElementById('btn-mode-next').disabled = false;
  }
}

document.querySelectorAll('.mode-card').forEach(card => {
  card.addEventListener('click', () => {
    if (card.classList.contains('disabled')) return;
    document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    card.querySelector('input').checked = true;
    chosenMode = card.dataset.mode;
    document.getElementById('btn-mode-next').disabled = false;
  });
});

// ---------- STEP 4: download ----------
async function startDownload() {
  document.getElementById('btn-dl-next').disabled = true;
  document.getElementById('btn-dl-back').disabled = true;
  const list = document.getElementById('dl-list');
  list.innerHTML = '<div class="dl-row"><span class="name">Preparing model list...</span></div>';

  if (chosenMode === 'cloud') {
    list.innerHTML = '<div class="dl-row"><span class="name">Cloud mode: no download needed.</span></div>';
    document.getElementById('btn-dl-next').disabled = false;
    document.getElementById('btn-dl-back').disabled = false;
    return;
  }

  const plan = await window.wizardAPI.getDownloadPlan(chosenMode);
  list.innerHTML = '';
  for (const item of plan.items) {
    const row = document.createElement('div');
    row.className = 'dl-row';
    row.dataset.id = item.id;
    row.innerHTML = `
      <span class="name">${item.label}</span>
      <span class="size">${item.size_mb} MB</span>
      <div class="bar"><div class="bar-fill"></div></div>`;
    list.appendChild(row);
  }
  document.getElementById('dl-total').textContent = plan.total_mb;

  window.wizardAPI.onDownloadProgress((p) => {
    const row = document.querySelector(`.dl-row[data-id="${p.id}"]`);
    if (row) {
      row.querySelector('.bar-fill').style.width = p.pct + '%';
      if (p.done) row.classList.add('done');
    }
    document.getElementById('dl-done').textContent = p.total_done_mb || 0;
    document.getElementById('dl-speed').textContent = (p.speed_mbps || 0).toFixed(1);
    document.getElementById('dl-eta').textContent = p.eta || '–';
  });

  try {
    await window.wizardAPI.startDownload(chosenMode);
    document.getElementById('btn-dl-next').disabled = false;
    document.getElementById('btn-dl-back').disabled = false;
  } catch (e) {
    list.innerHTML += `<div class="dl-row"><span class="name" style="color:#c55">Download failed: ${e.message}. <a href="#" id="retry-dl">Retry</a></span></div>`;
    document.getElementById('btn-dl-back').disabled = false;
    document.getElementById('retry-dl')?.addEventListener('click', startDownload);
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
    status.textContent = result.success
      ? '✓ Test passed in ' + result.duration_s + 's. FabMesh is ready.'
      : '⚠ Test failed: ' + result.error;
    status.classList.toggle('error', !result.success);
    document.getElementById('btn-launch').disabled = !result.success;
  } catch (e) {
    status.textContent = '⚠ Test crashed: ' + e.message;
    status.classList.add('error');
  }
}

document.getElementById('btn-launch').addEventListener('click', async () => {
  await window.wizardAPI.completeSetup({ mode: chosenMode, hw: hwReport });
});

// Start fresh on welcome
goto('welcome');
