// ============================================================
// FabMesh — Renderer 2 (refonte)
// ============================================================
// Architecture:
//   - Page "projects": grid of project cards
//   - Page "workspace": one project, 3 vertical step cards
//   - All IPC calls go through window.meshyAPI
// ============================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { Viewer3D } from './lib/Viewer3D.js';

const API = window.meshyAPI;

// FabMesh-styled confirm dialog (replaces the OS-native window.confirm
// popup, which looks out of place against the dark UI).
function fabConfirm({ title = 'Confirm', message = '', okLabel = 'Confirm',
                     cancelLabel = 'Cancel', icon = '\u26A0\uFE0F',
                     danger = true } = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById('modal-confirm');
    const titleEl = document.getElementById('confirm-title');
    const msgEl = document.getElementById('confirm-message');
    const iconEl = document.getElementById('confirm-icon');
    const okBtn = document.getElementById('confirm-ok');
    const cancelBtn = document.getElementById('confirm-cancel');
    if (!modal || !okBtn) { resolve(window.confirm(message)); return; }
    titleEl.textContent = title;
    msgEl.textContent = message;
    iconEl.textContent = icon;
    okBtn.textContent = okLabel;
    cancelBtn.textContent = cancelLabel;
    okBtn.classList.toggle('danger', !!danger);
    function cleanup(v) {
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(v);
    }
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onBackdrop = (e) => { if (e.target === modal) cleanup(false); };
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup(false);
      else if (e.key === 'Enter') cleanup(true);
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    modal.classList.remove('hidden');
    setTimeout(() => okBtn.focus(), 50);
  });
}
window.fabConfirm = fabConfirm;

// Forward all console.log/warn/error to main process log file for debugging.
// test_api_client.js already wrapped console.* — we wrap their wrapped versions.
// Helper for action logging — called from button handlers
function logAction(action, details) {
  const ts = new Date().toISOString();
  const msg = `[ACTION] ${action}` + (details ? ' ' + JSON.stringify(details) : '');
  try { window.meshyAPI?.logToFile?.(msg); } catch(_){}
  console.log(msg);
}

// Auto-log all clicks on important buttons (those with data-log-action attr)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button, [data-log-action]');
  if (!btn) return;
  const id = btn.id || btn.getAttribute('data-log-action') || btn.className;
  // Only log buttons that look like meaningful actions (skip nav, toolbar etc)
  if (id && (id.includes('generate') || id.includes('save') || id.includes('use-for') ||
             id.includes('-btn') || id.includes('export') || id.includes('apply') ||
             id.includes('mv-btn'))) {
    logAction('click:' + (btn.id || id.slice(0,40)));
  }
}, true);

function _installLogForwarder() {
  if (!API?.logToFile) return;
  const origLog = console.log, origWarn = console.warn, origErr = console.error, origInfo = console.info;
  const fmt = (args) => args.map(a => {
    if (a instanceof Error) return a.message + '\n' + (a.stack || '');
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch(_) { return String(a); } }
    return String(a);
  }).join(' ');
  console.log = function (...args) { try { API.logToFile('[log] ' + fmt(args)); } catch(_){} return origLog.apply(console, args); };
  console.info = function (...args) { try { API.logToFile('[info] ' + fmt(args)); } catch(_){} return origInfo.apply(console, args); };
  console.warn = function (...args) { try { API.logToFile('[warn] ' + fmt(args)); } catch(_){} return origWarn.apply(console, args); };
  console.error = function (...args) { try { API.logToFile('[err] ' + fmt(args)); } catch(_){} return origErr.apply(console, args); };
  window.addEventListener('error', (e) => { try { API.logToFile('[uncaught] ' + e.message + ' @ ' + e.filename + ':' + e.lineno); } catch(_){} });
  window.addEventListener('unhandledrejection', (e) => { try { API.logToFile('[unhandledrejection] ' + (e.reason?.message || e.reason)); } catch(_){} });
}
_installLogForwarder();

// ============================================================
// STATE
// ============================================================
const state = {
  page: 'projects',          // 'projects' | 'workspace'
  currentProject: null,      // { name, images: [], meshes: [], rigs: [] }
  projects: [],
  jobs: [],                  // { id, name, progress, status }
  jobIdCounter: 0,
};

// Expose state to the test/control API client (src/renderer/test_api_client.js).
// Module-scoped bindings are invisible to classic <script>s; we forward a live
// reference on window so the test client can snapshot jobs, projects, etc.
// openProject is a hoisted function declaration and is safe to reference here.
try {
  window.state = state;
  window.openProject = openProject;
} catch (_) {}

// ============================================================
// CUSTOM CONFIRM MODAL (replaces window.confirm)
// ============================================================
// Map engine value (from <select>) to a human-readable label showing the
// real underlying model. Used in job-details so the user sees
// "TripoSR (CC0)" instead of the internal "local" identifier.
const ENGINE_LABELS = {
  // Image engines
  'local-flux':     'RealVis XL (local)',
  // 3D engines
  'sf3d':           'Stable Fast 3D (PBR, Stability Community License)',
  'local':          'TripoSR (CC0)',
  'triposg':        'TripoSG (MIT)',
  'hi3dgen':        'Hi3DGen (MIT, ByteDance+CUHK)',
  'trellis':        'Trellis 2 (MIT)',
  'meshy':          'Meshy.ai (cloud, CC-BY 4.0)',
};
function engineLabel(v) {
  return ENGINE_LABELS[v] || v;
}

// Show a long error message in a styled modal instead of native alert()
function customError(message, title = 'Error') {
  // Truncate insanely long messages but keep them scrollable
  const safe = String(message || 'Unknown error');
  const modal = document.getElementById('modal-confirm');
  const titleEl = document.getElementById('confirm-title');
  const msgEl = document.getElementById('confirm-message');
  const okBtn = document.getElementById('confirm-ok');
  const cancelBtn = document.getElementById('confirm-cancel');
  titleEl.textContent = title;
  msgEl.textContent = safe;
  msgEl.style.maxHeight = '50vh';
  msgEl.style.overflowY = 'auto';
  msgEl.style.whiteSpace = 'pre-wrap';
  msgEl.style.fontFamily = 'monospace';
  msgEl.style.fontSize = '11px';
  msgEl.style.textAlign = 'left';
  okBtn.textContent = 'OK';
  okBtn.classList.remove('danger');
  cancelBtn.style.display = 'none';
  const _prevZ = modal.style.zIndex;
  modal.style.zIndex = '10000';
  modal.classList.remove('hidden');
  return new Promise(resolve => {
    function cleanup() {
      modal.classList.add('hidden');
      modal.style.zIndex = _prevZ;
      okBtn.removeEventListener('click', onOk);
      modal.removeEventListener('click', onOverlay);
      // Reset for normal customConfirm reuse
      msgEl.style.maxHeight = '';
      msgEl.style.overflowY = '';
      msgEl.style.whiteSpace = '';
      msgEl.style.fontFamily = '';
      msgEl.style.fontSize = '';
      msgEl.style.textAlign = '';
      okBtn.classList.add('danger');
      cancelBtn.style.display = '';
      resolve();
    }
    function onOk() { cleanup(); }
    function onOverlay(e) { if (e.target === modal) cleanup(); }
    okBtn.addEventListener('click', onOk);
    modal.addEventListener('click', onOverlay);
    setTimeout(() => okBtn.focus(), 50);
  });
}

// Variant of customError that shows an action button (e.g. "Open Settings")
// in addition to the standard OK dismiss. Returns true if the user clicked the
// action button, false on OK/overlay/Escape. The caller is responsible for
// performing the action after awaiting the promise.
function customErrorWithAction(message, title, actionLabel) {
  const safe = String(message || 'Unknown error');
  const modal = document.getElementById('modal-confirm');
  const titleEl = document.getElementById('confirm-title');
  const msgEl = document.getElementById('confirm-message');
  const okBtn = document.getElementById('confirm-ok');
  const cancelBtn = document.getElementById('confirm-cancel');
  titleEl.textContent = title || 'Error';
  msgEl.textContent = safe;
  msgEl.style.maxHeight = '50vh';
  msgEl.style.overflowY = 'auto';
  msgEl.style.whiteSpace = 'pre-wrap';
  msgEl.style.fontSize = '13px';
  msgEl.style.textAlign = 'left';
  // Repurpose the two buttons: cancel = OK dismiss, ok = action (primary).
  okBtn.textContent = actionLabel || 'Open Settings';
  okBtn.classList.remove('danger');
  cancelBtn.textContent = 'OK';
  cancelBtn.style.display = '';
  const _prevZ = modal.style.zIndex;
  modal.style.zIndex = '10000';
  modal.classList.remove('hidden');
  return new Promise((resolve) => {
    function cleanup(result) {
      modal.classList.add('hidden');
      modal.style.zIndex = _prevZ;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onOverlay);
      document.removeEventListener('keydown', onKey);
      // Reset shared modal styles/buttons so later customConfirm/customError
      // calls start from a clean state.
      msgEl.style.maxHeight = '';
      msgEl.style.overflowY = '';
      msgEl.style.whiteSpace = '';
      msgEl.style.fontSize = '';
      msgEl.style.textAlign = '';
      okBtn.classList.add('danger');
      cancelBtn.textContent = 'Cancel';
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onOverlay(e) { if (e.target === modal) cleanup(false); }
    function onKey(e) {
      if (e.key === 'Escape') cleanup(false);
      else if (e.key === 'Enter') cleanup(true);
    }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onOverlay);
    document.addEventListener('keydown', onKey);
    setTimeout(() => okBtn.focus(), 50);
  });
}

// Route an error message to either the Meshy-key-missing flow (with a
// shortcut button to Settings) or a plain customError. This is used by the
// 3 Meshy-aware handlers (image gen, mesh gen, rig gen) so any of them can
// surface the "API key not configured" error the same way.
function reportPipelineError(errMsg, title) {
  const raw = String(errMsg || '').trim();
  if (/meshy.*api key not configured/i.test(raw)) {
    return showMeshyKeyMissingError(title);
  }
  // Extract the most useful error line from a potentially huge Python dump.
  // Python tracebacks end with the actual error on the last non-empty line
  // (e.g. "OutOfMemoryError: CUDA out of memory. Tried to allocate 1.69 GiB.")
  // Show that as a short summary + the raw dump scrollable underneath.
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  const pyError = lines.reverse().find(l =>
    /Error:|Exception:|CUDA|OOM|killed|Traceback|FAILED/i.test(l)
  );
  if (pyError && raw.length > 300) {
    // Show a short human-readable summary + the full dump below
    const short = pyError.replace(/^.*?Error:\s*/i, '').trim();
    const summary = short.length > 200 ? short.slice(0, 200) + '...' : short;
    return customError(
      summary + '\n\n─── Full output ───\n' + raw.slice(-2000),
      title
    );
  }
  return customError(raw || 'unknown', title);
}

// Show a "Meshy API key not configured" error with a shortcut button to the
// Settings modal. Dedicated helper because this error is raised from 3
// different code paths (image gen, mesh gen, rigging).
async function showMeshyKeyMissingError(errorTitle) {
  const wantsOpen = await customErrorWithAction(
    'Meshy.ai API key not configured.\n\nOpen Settings and paste your key, then try again.\nGet a free key at https://www.meshy.ai/api',
    errorTitle || 'Meshy.ai API key missing',
    'Open Settings'
  );
  if (wantsOpen) {
    openSettings();
    // Focus the API key field after the modal has rendered
    setTimeout(() => {
      const el = document.getElementById('set-meshy-api-key');
      if (el) { el.focus(); el.select?.(); }
    }, 120);
  }
}

// Inline toast banner — appears at the bottom of the screen for 3s then fades.
// type: 'error' (red), 'success' (green), 'info' (blue)
function showToast(message, type = 'info', durationMs = 3000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.style.cssText = 'position:fixed; bottom:20px; left:50%; transform:translateX(-50%); z-index:99999; display:flex; flex-direction:column; gap:6px; align-items:center; pointer-events:none;';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  const colors = {
    error: 'rgba(220,38,38,0.9)',
    success: 'rgba(22,163,74,0.9)',
    info: 'rgba(99,102,241,0.9)',
  };
  toast.style.cssText = `background:${colors[type] || colors.info}; color:white; padding:10px 20px; border-radius:8px; font-size:13px; font-weight:600; pointer-events:auto; box-shadow:0 4px 12px rgba(0,0,0,0.3); transition:opacity 0.3s; max-width:500px; text-align:center;`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, durationMs);
}

function customConfirm(message, title = 'Confirm', okLabel = 'Delete') {
  return new Promise((resolve) => {
    const modal = document.getElementById('modal-confirm');
    const titleEl = document.getElementById('confirm-title');
    const msgEl = document.getElementById('confirm-message');
    const okBtn = document.getElementById('confirm-ok');
    const cancelBtn = document.getElementById('confirm-cancel');
    titleEl.textContent = title;
    msgEl.textContent = message;
    okBtn.textContent = okLabel;
    // Bump above the landmarks fullscreen (9600) and 3D lightbox (9500).
    // Restored in cleanup() so we don't pollute unrelated modals.
    const _prevZ = modal.style.zIndex;
    modal.style.zIndex = '10000';
    modal.classList.remove('hidden');
    function cleanup(result) {
      modal.classList.add('hidden');
      modal.style.zIndex = _prevZ;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onOverlayClick(e) { if (e.target === modal) cleanup(false); }
    function onKey(e) {
      if (e.key === 'Escape') cleanup(false);
      else if (e.key === 'Enter') cleanup(true);
    }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKey);
    setTimeout(() => okBtn.focus(), 50);
  });
}

// ============================================================
// ROUTING
// ============================================================
function showPage(name) {
  state.page = name;
  document.getElementById('page-projects').classList.toggle('hidden', name !== 'projects');
  document.getElementById('page-workspace').classList.toggle('hidden', name !== 'workspace');
  document.body.classList.toggle('workspace-mode', name === 'workspace');
  if (name === 'projects') {
    document.getElementById('breadcrumb').textContent = '';
    refreshProjectsPage();
    refreshParentalStatus();
  } else {
    document.getElementById('breadcrumb').textContent = state.currentProject?.name || '';
  }
}

document.getElementById('back-to-projects').addEventListener('click', () => showPage('projects'));
document.getElementById('btn-refresh').addEventListener('click', async () => {
  if (state.page === 'projects') await refreshProjectsPage();
  else if (state.currentProject) await reloadCurrentProject();
});

// ============================================================
// PAGE 1: PROJECTS HOME
// ============================================================
async function refreshProjectsPage() {
  const folders = (await API.listImageFolders()) || [];
  const meshes  = (await API.listMeshes()) || [];

  // Group by project name (folder = base name without trailing _NNN)
  const projectsMap = new Map();
  function ensure(name) {
    if (!projectsMap.has(name)) {
      projectsMap.set(name, {
        name,
        images: [],
        meshes: [],
        rigs: [],
        thumb: null,
        latestTimestamp: 0,
      });
    }
    return projectsMap.get(name);
  }
  for (const f of folders) {
    if (!f.count) continue;
    const cleanName = f.name.replace(/_\d+$/, '');
    const p = ensure(cleanName);
    p.images.push(...(f.images || []).map(img => ({ path: img, folder: f.name })));
    if (!p.thumb && f.images && f.images[0]) p.thumb = f.images[0];
    if (f.created && f.created > p.latestTimestamp) p.latestTimestamp = f.created;
    // Keep the latest prompt for the project (folders are listed newest first)
    if (!p.prompt && f.prompt) p.prompt = f.prompt;
    // Merge back-photo map from disk so the FRONT/BACK bar shows even
    // after a reload (previously only in-memory after generation).
    if (f.backPhotos && Object.keys(f.backPhotos).length) {
      if (!p._backPhotos) p._backPhotos = {};
      Object.assign(p._backPhotos, f.backPhotos);
    }
  }
  // Meshes don't carry a project field — derive from filename.
  // Convention examples:
  //   orc_42.glb                          -> orc
  //   test_hunyuan_1775589123456.glb      -> test
  //   spider_local_1775589000000.glb      -> spider
  //   mesh_3_rigged_orc_v1.fbx            -> mesh
  function meshProject(filename) {
    // Strip extension
    let base = filename.replace(/\.[^.]+$/, '');
    // Remove "_rigged_<anything>" suffix
    base = base.replace(/_rigged_.+$/i, '');
    // Iteratively peel post-processing suffixes produced by the refine /
    // decimate / retexture / smooth / etc. scripts, possibly followed by
    // another timestamp. Order matters: run until nothing changes.
    // Known suffixes: cntile, retexture, decimate, smooth, fill_holes,
    // fix_normals, center, upscale, refine, augment, vc (vertex color).
    // Optionally followed by a timestamp OR a short tag (_v2, _test, etc.).
    const POST_SUFFIX = /_(cntile|retexture|decimate|smooth|fill_holes|fix_normals|center|upscale|refine|augment|vc)(?:_[A-Za-z0-9]{1,16})*$/i;
    let prev;
    do {
      prev = base;
      base = base.replace(POST_SUFFIX, '');
      // Remove trailing timestamp (_<10+ digits>)
      base = base.replace(/_\d{10,}$/, '');
    } while (base !== prev);
    // Remove trailing engine suffix added by main.js: _sf3d / _meshy / _hunyuan / _local / _trellis / _trellis2 / _triposg / _ai
    // Optionally followed by arbitrary short tags like _apilive, _test, _v2,
    // each possibly followed by its own timestamp. This handles ad-hoc CLI
    // names like test_e2e_sf3d_apilive_1776274212 that would otherwise form
    // their own phantom projects.
    base = base.replace(
      /_(sf3d|meshy|hunyuan|local|trellis2|trellis|triposg|hi3dgen|ai)(?:_[A-Za-z0-9]{1,16})*$/i,
      ''
    );
    // Remove a trailing _<number> if any (legacy index naming)
    base = base.replace(/_\d+$/, '');
    return base || 'untitled';
  }
  for (const m of meshes) {
    const project = meshProject(m.filename);
    const p = ensure(project);
    if (/_rigged_/i.test(m.filename)) p.rigs.push(m);
    else p.meshes.push(m);
    // Use mesh's source image as project thumb if no image folder
    if (!p.thumb && m.sourceImage) p.thumb = m.sourceImage;
    if (m.created) {
      const ts = new Date(m.created).getTime();
      if (ts > p.latestTimestamp) p.latestTimestamp = ts;
    }
  }

  state.projects = Array.from(projectsMap.values()).sort((a, b) => b.latestTimestamp - a.latestTimestamp);
  renderProjectsGrid();
  // Start background NSFW scan (non-blocking, re-renders when done)
  _runNsfwBackgroundScan();
}

// NSFW keywords for project name / prompt filtering (renderer-side).
// Fetched from main.js on first use so both sides share the same list.
let _nsfwKeywordsCache = null;
async function _getNsfwKeywords() {
  if (_nsfwKeywordsCache) return _nsfwKeywordsCache;
  try {
    if (API.getNsfwKeywords) {
      _nsfwKeywordsCache = await API.getNsfwKeywords();
      return _nsfwKeywordsCache;
    }
  } catch (_) {}
  // Fallback minimal list if IPC not available
  return ['nude','naked','nsfw','porn','sex','gore','blood','murder','kill','drug','terrorist'];
}
// NSFW scan cache: { filename: true/false }
const _nsfwScanCache = {};
let _nsfwScanRunning = false;

async function _isProjectNSFW(p) {
  // 1. Check name + prompt against keyword list (instant, no IPC)
  const keywords = await _getNsfwKeywords();
  const text = ((p.name || '') + ' ' + (p.prompt || '')).toLowerCase();
  if (keywords.some(kw => text.includes(kw))) return true;

  // 2. Check for .nsfw tag files in the project folder (instant, 1 readdir)
  if (p.images && p.images.length > 0) {
    const firstImg = p.images[0].path || p.images[0];
    if (firstImg && API.checkProjectNsfw) {
      const folder = firstImg.replace(/[/\\][^/\\]+$/, '');
      try {
        const r = await API.checkProjectNsfw({ folderPath: folder });
        if (r?.nsfw) return true;
      } catch (_) {}
    }
  }

  // 3. Fallback: check ViT scan cache (populated by background scan)
  for (const img of (p.images || [])) {
    const imgPath = img.path || img;
    if (!imgPath) continue;
    const fname = imgPath.split(/[/\\]/).pop();
    if (_nsfwScanCache[fname]) return true;
  }
  return false;
}

// Background scan: runs once after page load, scans ALL project thumbnails
// in a single Python batch process (loads the ViT model once, scans all images).
// Re-renders the grid when done.
async function _runNsfwBackgroundScan() {
  console.log('[NSFW] _runNsfwBackgroundScan called, batchCheckNsfw=', !!API.batchCheckNsfw, 'projects=', state.projects.length);
  if (_nsfwScanRunning) { console.log('[NSFW] already running, skip'); return; }
  if (!API.batchCheckNsfw) { console.log('[NSFW] API.batchCheckNsfw not available'); return; }
  // Collect only THUMBNAIL images that haven't been scanned or tagged yet.
  // The .nsfw tag files handle per-image detection; this scan is just for
  // thumbnails of projects that don't have any tags yet (migration path).
  const toScan = [];
  for (const p of state.projects) {
    if (!p.thumb) continue;
    const fname = p.thumb.split(/[/\\]/).pop();
    if (fname in _nsfwScanCache) continue;
    toScan.push(p.thumb);
  }
  if (toScan.length === 0) { console.log('[NSFW] nothing to scan'); return; }
  console.log('[NSFW] scanning', toScan.length, 'thumbnails...');
  _nsfwScanRunning = true;
  try {
    const results = await API.batchCheckNsfw({ images: toScan });
    console.log('[NSFW] scan results:', results);
    if (results && typeof results === 'object') {
      let changed = false;
      for (const [imgPath, nsfw] of Object.entries(results)) {
        const fname = imgPath.split(/[/\\]/).pop();
        _nsfwScanCache[fname] = !!nsfw;
        if (nsfw) { changed = true; console.log('[NSFW] BLOCKED:', fname, imgPath); }
      }
      console.log('[NSFW] cache keys:', Object.keys(_nsfwScanCache).filter(k => _nsfwScanCache[k]));
      if (changed) {
        console.log('[NSFW] re-rendering grid to hide', Object.values(_nsfwScanCache).filter(v=>v).length, 'NSFW projects');
        renderProjectsGrid();
      }
    }
  } catch (_) {}
  _nsfwScanRunning = false;
}

async function renderProjectsGrid() {
  const grid = document.getElementById('projects-grid');
  const empty = document.getElementById('projects-empty');
  grid.innerHTML = '';
  // Check parental status
  let restricted = true;
  try {
    if (API.getParentalStatus) {
      const ps = await API.getParentalStatus();
      restricted = !ps.unrestricted;
    }
  } catch(_) {}

  let visibleProjects = state.projects;
  if (restricted) {
    const checks = await Promise.all(state.projects.map(p => _isProjectNSFW(p)));
    visibleProjects = state.projects.filter((_, i) => !checks[i]);
  }

  // Apply search filter
  const searchInput = document.getElementById('project-search');
  const query = (searchInput?.value || '').trim().toLowerCase();
  if (query) {
    visibleProjects = visibleProjects.filter(p => p.name.toLowerCase().includes(query));
  }

  if (visibleProjects.length === 0) {
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
  }
  for (const p of visibleProjects) {
    const hasImage = p.images.length > 0;
    const hasMesh = p.meshes.length > 0;
    const hasRig = p.rigs.length > 0;
    const card = document.createElement('div');
    card.className = 'project-card';
    card.innerHTML = `
      <button class="card-delete-btn" title="Delete project">&#10005;</button>
      <div class="project-card-thumb">
        ${p.thumb
          ? `<img src="file:///${p.thumb.replace(/\\/g, '/')}" alt="${p.name}">`
          : `<span class="project-card-thumb-empty">No image</span>`}
      </div>
      <div class="project-card-body">
        <div class="project-card-name">${escapeHtml(p.name)}</div>
        <div class="project-card-meta">
          ${p.images.length} img · ${p.meshes.length} mesh · ${p.rigs.length} rig
        </div>
        <div class="project-card-progress">
          <span class="pcp-step ${hasImage ? 'done' : ''}"></span>
          <span class="pcp-step ${hasMesh ? 'done' : ''}"></span>
          <span class="pcp-step ${hasRig ? 'done' : ''}"></span>
        </div>
      </div>
    `;
    card.querySelector('.card-delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!await customConfirm(`Delete project "${p.name}" and all its files?`, 'Delete project')) return;
      const r = await API.deleteProject({ projectName: p.name });
      if (r?.ok) await refreshProjectsPage();
      else alert('Delete failed: ' + (r?.error || 'unknown'));
    });
    card.addEventListener('click', () => openProject(p));
    grid.appendChild(card);
  }
  // Add the "+ New" card at the end
  const newCard = document.createElement('div');
  newCard.className = 'project-card new-card';
  newCard.innerHTML = `
    <div class="new-card-content">
      <div class="new-card-plus">+</div>
      <div>Create a new project</div>
    </div>
  `;
  newCard.addEventListener('click', () => openNewProjectModal());
  grid.appendChild(newCard);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ============================================================
// NEW PROJECT MODAL
// ============================================================
function openNewProjectModal() {
  document.getElementById('np-name').value = '';
  document.getElementById('np-prompt').value = '';
  document.getElementById('modal-new-project').classList.remove('hidden');
  setTimeout(() => document.getElementById('np-name').focus(), 50);
}
function closeNewProjectModal() {
  document.getElementById('modal-new-project').classList.add('hidden');
}
document.getElementById('btn-new-project').addEventListener('click', openNewProjectModal);
document.getElementById('project-search')?.addEventListener('input', () => renderProjectsGrid());
document.getElementById('np-cancel').addEventListener('click', closeNewProjectModal);
document.getElementById('np-create').addEventListener('click', async () => {
  const name = document.getElementById('np-name').value.trim() || 'project';
  const prompt = document.getElementById('np-prompt').value.trim();
  const assetType = document.getElementById('np-asset-type')?.value || 'character';
  const assetStyle = document.getElementById('np-asset-style')?.value || 'realistic';

  // Parental control: check name + prompt for blocked content
  let restricted = true;
  try {
    if (API.getParentalStatus) {
      const ps = await API.getParentalStatus();
      restricted = !ps.unrestricted;
    }
  } catch(_) {}
  if (restricted) {
    const keywords = await _getNsfwKeywords();
    const text = (name + ' ' + prompt).toLowerCase();
    const blocked = keywords.find(kw => text.includes(kw));
    if (blocked) {
      showToast(`Blocked: "${blocked}" is not allowed with parental control active.`, 'error', 5000);
      return;
    }
  }

  closeNewProjectModal();
  // Create an empty project shell and open it
  const proj = {
    name,
    images: [],
    meshes: [],
    rigs: [],
    thumb: null,
    initialPrompt: prompt,
    assetType,
    assetStyle,
  };
  state.currentProject = proj;
  showPage('workspace');
  populateWorkspace(proj);
  if (prompt) {
    document.getElementById('ws-prompt').value = prompt;
  }
  // Pre-fill the "Create new image" form with the project's choices
  const atSel = document.getElementById('ws-asset-type');
  if (atSel) { atSel.value = assetType; atSel.dispatchEvent(new Event('change')); }
  const asSel = document.getElementById('ws-asset-style');
  if (asSel) asSel.value = assetStyle;
});

// Show/hide "Construction stages" checkbox based on asset type —
// hidden for living subjects (character, creature) where 3-stage
// progressive build doesn't make sense. Visible for buildings,
// vehicles, weapons, props, environment, custom — assets that have
// a natural "blueprint → rough → finished" progression.
(function _wireBuildStagesVisibility() {
  const applyVisibility = () => {
    const at = document.getElementById('ws-asset-type')?.value || 'character';
    const row = document.getElementById('ws-img-buildstages-row');
    if (!row) return;
    const hide = (at === 'character' || at === 'creature');
    row.style.display = hide ? 'none' : '';
    if (hide) {
      const cb = document.getElementById('ws-img-buildstages');
      if (cb) cb.checked = false;
    }
  };
  const sel = document.getElementById('ws-asset-type');
  if (sel) {
    sel.addEventListener('change', applyVisibility);
    // Run once on load so default view is correct
    applyVisibility();
  }
})();

// Import Image → create project with imported image
document.getElementById('btn-import-image')?.addEventListener('click', async () => {
  const filePath = await API.importImage();
  if (!filePath) return;
  const result = await API.importImageFile(filePath);
  if (!result || !result.path) { showToast('Import failed', 'error'); return; }
  showToast('Image imported!', 'success', 1500);
  // NSFW scan on imported image
  if (API.batchCheckNsfw) {
    try {
      const nsfwResult = await API.batchCheckNsfw({ images: [result.path] });
      const isNsfw = nsfwResult && nsfwResult[result.path] && nsfwResult[result.path].nsfw;
      if (isNsfw) {
        _nsfwScanCache[result.path.split(/[/\\]/).pop()] = true;
      }
    } catch (e) { console.warn('[import] NSFW scan failed:', e); }
  }
  // Refresh project list then open the new project
  await renderProjectsGrid();
  const proj = state.projects.find(p => p.name === result.projectName);
  if (proj) {
    state.currentProject = proj;
    showPage('workspace');
    populateWorkspace(proj);
  }
});

// ============================================================
// PAGE 2: PROJECT WORKSPACE
// ============================================================
async function openProject(p) {
  state.currentProject = p;
  showPage('workspace');
  populateWorkspace(p);
  // For each step that already has content, expand the card and open its
  // "Edit selected" stage (closing "Create new"). Then smooth-scroll to the
  // MOST ADVANCED one (rig > mesh > image) so the user lands where they
  // most likely want to continue working.
  // Deferred via requestAnimationFrame so populateWorkspace finishes its
  // own setStageOpenState calls first (otherwise they'd clobber ours).
  requestAnimationFrame(() => {
    const steps = [
      { id: 'step-card-image', has: (p.images && p.images.length > 0) },
      { id: 'step-card-mesh',  has: (p.meshes && p.meshes.length > 0) },
      { id: 'step-card-rig',   has: (p.rigs   && p.rigs.length   > 0) },
    ];
    let scrollTargetId = null;
    for (const s of steps) {
      const card = document.getElementById(s.id);
      if (!card) continue;
      if (s.has) {
        card.classList.remove('collapsed', 'disabled');
        const createStage = card.querySelector('.stage-create');
        const editStage = card.querySelector('.stage-edit');
        if (createStage) createStage.open = false;
        if (editStage) editStage.open = true;
        scrollTargetId = s.id; // last one wins → most advanced
      }
    }
    if (!scrollTargetId) return;
    setTimeout(() => {
      document.getElementById(scrollTargetId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Re-check multi-view bar now that all stages are open and the preview
      // image has been rendered. openProject's earlier showStep1Preview call
      // fires _checkMultiviewForCurrentImage async — but if the disk fallback
      // (checkMultiviewDir IPC) hadn't resolved yet when the DOM settled,
      // the bar stayed hidden until the user manually refreshed. Re-calling
      // here gives the async path a second chance after the stages expanded.
      _checkMultiviewForCurrentImage();
    }, 200);
  });
}

// Refresh only button labels/disabled states + hide empty Edit stages. Does
// NOT touch which <details> is open — use refreshStageOpenStates() or the
// full refreshButtonStates() for that.
function refreshButtonLabelsAndHiding(p) {
  if (!p) return;
  const btnImg = document.getElementById('ws-generate-image');
  if (btnImg) btnImg.textContent = p.images.length > 0 ? 'Generate new version' : 'Generate';
  const btnMesh = document.getElementById('ws-generate-mesh');
  if (btnMesh) {
    btnMesh.disabled = !p.selectedImagePath;
    btnMesh.textContent = p.meshes.length > 0 ? 'Generate new 3D version' : 'Generate 3D';
  }
  // Rigging button (unified: engine selected via #ws-rig-engine → UniRig or Meshy).
  // Allow generation if either a mesh is selected for this project OR the
  // rig-source viewer is currently showing one (could be from another project
  // the user dragged in / picked manually).
  const btnRigAI = document.getElementById('ws-generate-rig-ai');
  if (btnRigAI) {
    btnRigAI.disabled = !p.selectedMeshPath && !rigSrcModel;
    btnRigAI.textContent = p.rigs.length > 0 ? 'Generate new rig version' : 'Generate Rig';
  }
  // Hide each "Edit selected" stage when there is nothing to edit yet
  toggleEditStage('step-card-image', p.images.length > 0);
  toggleEditStage('step-card-mesh',  p.meshes.length > 0);
  toggleEditStage('step-card-rig',   p.rigs.length   > 0);
}
function refreshButtonStates(p) {
  refreshButtonLabelsAndHiding(p);
  if (!p) return;
  // Auto-collapse the "Create new" stage if the step already has content,
  // and open the "Edit selected" stage in its place. The user can re-expand
  // Create new manually to make a new version.
  setStageOpenState('step-card-image', p.images.length > 0);
  setStageOpenState('step-card-mesh',  p.meshes.length > 0);
  setStageOpenState('step-card-rig',   p.rigs.length   > 0);
}

function toggleEditStage(cardId, show) {
  const card = document.getElementById(cardId);
  if (!card) return;
  const editStage = card.querySelector('.stage-edit');
  if (editStage) editStage.style.display = show ? '' : 'none';
}

function setStageOpenState(cardId, hasContent) {
  const card = document.getElementById(cardId);
  if (!card) return;
  const createStage = card.querySelector('.stage-create');
  const editStage = card.querySelector('.stage-edit');
  if (hasContent) {
    if (createStage) createStage.open = false;
    if (editStage) editStage.open = true;
  } else {
    if (createStage) createStage.open = true;
    if (editStage) editStage.open = false;
  }
}

// Make the step-card headers (Image / 3D Mesh / Rig) collapsible
function bindStepCardCollapse() {
  document.querySelectorAll('.step-card').forEach(card => {
    const header = card.querySelector('.step-card-header');
    if (!header) return;
    header.addEventListener('click', (e) => {
      // Don't toggle if user clicked the status badge or any inner button
      if (e.target.closest('button')) return;
      card.classList.toggle('collapsed');
    });
  });
}
bindStepCardCollapse();

// Mutual exclusion between Create new / Edit selected stages: opening one
// automatically collapses the other within the same step card.
function bindStageMutualExclusion() {
  document.querySelectorAll('.step-card').forEach(card => {
    const createStage = card.querySelector('.stage-create');
    const editStage = card.querySelector('.stage-edit');
    if (!createStage || !editStage) return;
    createStage.addEventListener('toggle', () => {
      if (createStage.open) editStage.open = false;
    });
    editStage.addEventListener('toggle', () => {
      if (editStage.open) createStage.open = false;
    });
  });
}
bindStageMutualExclusion();

function resetWorkspaceUI() {
  // Image step
  const step1Prev = document.getElementById('step1-preview');
  if (step1Prev) {
    // Remove img + restore placeholder, KEEP the static expand button
    const oldImg = step1Prev.querySelector('img');
    if (oldImg) oldImg.remove();
    if (!step1Prev.querySelector('.preview-placeholder')) {
      const ph = document.createElement('div');
      ph.className = 'preview-placeholder';
      ph.textContent = 'No image yet';
      step1Prev.insertBefore(ph, step1Prev.firstChild);
    }
    step1Prev.classList.remove('clickable');
    step1Prev.onclick = null;
  }
  const imgExpandBtn = document.getElementById('ws-image-expand-btn');
  if (imgExpandBtn) imgExpandBtn.classList.add('hidden');
  setViewerFilename('ws-image-filename', '');
  setViewerFilename('ws-mesh-filename', '');
  setViewerFilename('ws-rig-source-filename', '');
  setViewerFilename('ws-3d-source-filename', '');
  const useBar = document.getElementById('ws-use-for-3d-bar');
  if (useBar) useBar.classList.add('hidden');
  const imgStrip = document.getElementById('ws-image-versions');
  if (imgStrip) imgStrip.innerHTML = '';

  // Mesh step
  const step2Prev = document.getElementById('step2-preview');
  const step2Placeholder = document.getElementById('step2-placeholder');
  if (step2Placeholder) step2Placeholder.style.display = '';
  if (step2Prev) {
    step2Prev.classList.remove('clickable');
  }
  // Reset the source-image preview in the Create new section
  const srcPreview = document.getElementById('ws-3d-source-preview');
  if (srcPreview) srcPreview.innerHTML = '<div class="preview-placeholder">No image selected</div>';
  // Reset the source-mesh preview in the Rig Create new section
  showRigSourceMesh(null);
  const meshExpandBtn = document.getElementById('ws-mesh-expand-btn');
  if (meshExpandBtn) meshExpandBtn.classList.add('hidden');
  // Clear the three.js scene if it exists
  if (wsModel && wsScene) {
    wsScene.remove(wsModel);
    wsModel = null;
  }
  const useRigBar = document.getElementById('ws-use-for-rig-bar');
  if (useRigBar) useRigBar.classList.add('hidden');
  const meshStrip = document.getElementById('ws-mesh-versions');
  if (meshStrip) meshStrip.innerHTML = '';

  // Rig step
  const step3Placeholder = document.getElementById('step3-placeholder');
  if (step3Placeholder) {
    step3Placeholder.style.display = '';
    step3Placeholder.textContent = 'No rig yet';
  }
  if (rigVwModel && rigVwScene) {
    rigVwScene.remove(rigVwModel);
    rigVwModel = null;
  }
  const rigExpandBtn = document.getElementById('ws-rig-expand-btn');
  if (rigExpandBtn) rigExpandBtn.classList.add('hidden');
  const rigStrip = document.getElementById('ws-rig-versions');
  if (rigStrip) rigStrip.innerHTML = '';
}

function populateWorkspace(p) {
  // Reset UI first so stale previews/versions from a previous project are wiped
  resetWorkspaceUI();

  // Prompt resolution priority:
  //   1. Locally edited (localStorage) — survives reloads
  //   2. Saved on disk (prompt.txt of latest folder)
  //   3. Initial prompt from "New project" modal
  let savedLocal = '';
  try { savedLocal = localStorage.getItem('fabmesh-prompt-' + p.name) || ''; } catch (e) {}
  // Legacy projects accumulated style/type suffixes in their persisted prompt
  // on every generation. Strip any known suffix so the textarea only shows the
  // raw user intent (the suffixes are re-added by buildFullPrompt at gen time).
  const rawPrompt = stripKnownPromptSuffixes(savedLocal || p.prompt || p.initialPrompt || '');
  document.getElementById('ws-prompt').value = rawPrompt;
  // Heal localStorage too so next open doesn't re-read the polluted version.
  if (rawPrompt && savedLocal && savedLocal !== rawPrompt) {
    try { localStorage.setItem('fabmesh-prompt-' + p.name, rawPrompt); } catch (e) {}
  }

  // Reset image / mesh paths — they belonged to the previous project.
  // The renderXxxVersions() functions will then auto-select the latest item
  // (index 0 because the lists are sorted newest first).
  p.selectedImagePath = null;
  p._activeMultiview = null;
  p._activeMultiviewKey = null;  // <-- also reset, otherwise the bar's
                                  // stored key from a previous session
                                  // re-attaches to the OLD multiview path
                                  // and Clone Stamp picks v0 instead of
                                  // the latest version
  p.previewImagePath = null;
  p.selectedMeshPath = null;
  p.previewMeshPath = null;
  // SYNC default: pre-set the latest image as preview so editTarget()
  // never sees null while the async renderImageVersions completes.
  // Otherwise tools like Clone Stamp / Paint can fire with a stale or
  // null target during the brief NSFW-check race.
  if (p.images && p.images.length > 0) {
    p.previewImagePath = p.images[0].path;
    p.selectedImagePath = p.images[0].path;
  }
  // If a single item exists, it's automatically the one used for the next step.
  // Nothing extra to do here — renderImageVersions/renderMeshVersions handle it.

  // Image step. renderImageVersions is async (NSFW check) — chain a
  // multiview-bar refresh once it settles, otherwise the small viewer's
  // FRONT/BACK bar can stay hidden after a cold reload because the
  // p._backPhotos map was populated AFTER the first showStep1Preview.
  renderImageVersions(p).then(() => {
    _checkMultiviewForCurrentImage();
  }).catch(() => {});
  if (p.images.length > 0) {
    setStepStatus(1, 'done');
    showStep1Preview(p.images[0].path);
    enableStep(2);
    // Make sure the Image card itself is expanded (a previous "Use for X"
    // click may have collapsed it). The Edit selected stage will then be
    // opened by setStageOpenState below.
    document.getElementById('step-card-image')?.classList.remove('collapsed');
  } else {
    setStepStatus(1, 'active');
    setStepStatus(2, 'pending');
    setStepStatus(3, 'pending');
  }

  refreshButtonStates(p);

  // Restore style dropdown for the currently selected image
  _restoreStyleDropdown(p.previewImagePath || p.selectedImagePath);

  // Mesh step
  renderMeshVersions(p);
  if (p.meshes.length > 0) {
    setStepStatus(2, 'done');
    showStep2Preview(p.meshes[0]);
    enableStep(3);
  } else if (p.selectedImagePath) {
    // No mesh yet but an image is queued for 3D — show it as the source preview
    showStep2SourceImage(p.selectedImagePath);
    setStepStatus(2, 'active');
    const step2Card = document.getElementById('step-card-mesh');
    if (step2Card) step2Card.classList.remove('disabled');
  }

  // Rig step
  renderRigVersions(p);
  if (p.rigs.length > 0) {
    setStepStatus(3, 'done');
    showStep3Preview(p.rigs[0]);
  }
  // Auto-populate the source-mesh preview in the Rig Create new section.
  // Force-open the Rig Create new stage briefly so the canvas gets a real
  // size before three.js tries to fit the camera. We snapshot BOTH the
  // create-new and edit-selected open states so we can restore them after,
  // because flipping create-new open fires the mutual-exclusion handler
  // which closes edit-selected as a side effect.
  if (p.selectedMeshPath) {
    const rigCard = document.getElementById('step-card-rig');
    const rigCreateStage = rigCard?.querySelector('.stage-create');
    const rigEditStage = rigCard?.querySelector('.stage-edit');
    const wasCreateOpen = rigCreateStage?.open;
    const wasEditOpen = rigEditStage?.open;
    if (rigCreateStage && !wasCreateOpen) rigCreateStage.open = true;
    requestAnimationFrame(() => {
      showRigSourceMesh(p.selectedMeshPath);
      // Restore the user-preferred state on the next frame (after the canvas init)
      requestAnimationFrame(() => {
        if (rigCreateStage && !wasCreateOpen && p.rigs.length > 0) rigCreateStage.open = false;
        // Restore edit-selected if it was open before the create-new flip
        // closed it via mutual exclusion.
        if (rigEditStage && wasEditOpen && !rigEditStage.open) rigEditStage.open = true;
      });
    });
  }

  loadRigTemplatesIntoSelect();
}

function setStepStatus(stepNum, status) {
  const card = document.getElementById(`step-card-${['', 'image', 'mesh', 'rig'][stepNum]}`);
  if (!card) return;
  card.classList.remove('active', 'done', 'disabled');
  if (status === 'done') card.classList.add('done');
  else if (status === 'active') card.classList.add('active');
  else if (status === 'pending') card.classList.add('disabled');
  const statusEl = document.getElementById(`step${stepNum}-status`);
  if (statusEl) {
    statusEl.textContent = status === 'done' ? 'Done' : (status === 'active' ? 'In progress' : 'Pending');
  }
}

function enableStep(stepNum) {
  const card = document.getElementById(`step-card-${['', 'image', 'mesh', 'rig'][stepNum]}`);
  if (card && card.classList.contains('disabled') && !card.classList.contains('done')) {
    card.classList.remove('disabled');
    setStepStatus(stepNum, 'active');
  }
}

// ----- Image step -----
// Two paths per project:
//   previewImagePath: what is shown in the big preview (clicking a thumb updates it)
//   selectedImagePath: the image that will be sent to the 3D step when the user clicks "Use this for 3D"
async function renderImageVersions(p) {
  const strip = document.getElementById('ws-image-versions');
  strip.innerHTML = '';

  // Check parental control status
  let restricted = true;
  try {
    if (API.getParentalStatus) {
      const ps = await API.getParentalStatus();
      restricted = !ps.unrestricted;
    }
  } catch(_) {}

  // Filter out NSFW images when restricted (check .nsfw tag files via IPC)
  let images = p.images;
  if (restricted && p.images.length > 0 && API.checkImagesNsfwTags) {
    try {
      const allPaths = p.images.map(img => img.path || img);
      const tags = await API.checkImagesNsfwTags({ images: allPaths });
      if (tags && typeof tags === 'object') {
        images = p.images.filter(img => {
          const imgPath = img.path || img;
          return !tags[imgPath];
        });
      }
    } catch(_) {}
  }

  // Default: latest version is both previewed AND selected for 3D
  if (images.length > 0) {
    if (!p.previewImagePath || !images.find(i => (i.path||i) === p.previewImagePath)) {
      p.previewImagePath = images[0].path;
    }
    if (!p.selectedImagePath || !images.find(i => (i.path||i) === p.selectedImagePath)) {
      p.selectedImagePath = images[0].path;
    }
  }
  images.forEach((img, i) => {
    const t = document.createElement('div');
    t.className = 'version-thumb';
    if (img.path === p.previewImagePath) t.classList.add('selected');
    if (img.path === p.selectedImagePath) t.classList.add('used-for-3d');
    // Cache-bust so Electron/Chromium re-reads ref_0.png after a new
    // generation overwrote it. Without this, the thumbnail shows a stale
    // version (previous generation) even though the file on disk is new.
    const _cb = img.mtime || p._reloadTs || Date.now();
    t.innerHTML = `
      <img src="file:///${img.path.replace(/\\/g, '/')}?t=${_cb}">
      <span class="v-label">v${images.length - 1 - i}</span>
      <button class="version-delete-btn" title="Delete this version">&#10005;</button>
    `;
    t.addEventListener('click', () => {
      strip.querySelectorAll('.version-thumb').forEach(x => x.classList.remove('selected'));
      t.classList.add('selected');
      p.previewImagePath = img.path;
      // Drop the active-path cache but KEEP _activeMultiviewKey so when the
      // new version's mv-bar shows, it restores the same angle (e.g. 90°).
      // _showMultiviewBar reads _activeMultiviewKey and re-selects the
      // matching button + swaps preview to the matching view file.
      p._activeMultiview = null;
      showStep1Preview(img.path);
      // Restore the style that was applied to this specific image
      _restoreStyleDropdown(img.path);
      // Force re-evaluate multi-view bar even if showStep1Preview's internal
      // call races with other UI updates (observed on 'garcon' v1 where the
      // bar stayed hidden even though the _multiview/ folder existed). Fires
      // after a short delay to let the DOM settle.
      setTimeout(() => { _checkMultiviewForCurrentImage(); }, 30);
    });
    t.querySelector('.version-delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!await customConfirm(`Delete version v${p.images.length - 1 - i}? This cannot be undone.`, 'Delete image version')) return;
      const ok = await API.deleteFile(img.path);
      if (ok) {
        await reloadCurrentProject();
      } else {
        alert('Could not delete this version.');
      }
    });
    strip.appendChild(t);
  });
}

// "Use this image for 3D" button handler
document.getElementById('ws-use-for-3d-btn')?.addEventListener('click', () => {
  const p = state.currentProject;
  if (!p || !p.previewImagePath) return;
  p.selectedImagePath = p.previewImagePath;
  // Auto-attach the back photo if 2-view was generated for this image.
  if (p._backPhotos && p._backPhotos[p.selectedImagePath]) {
    p.backImagePath = p._backPhotos[p.selectedImagePath];
    if (typeof showStep2BackImage === 'function') {
      showStep2BackImage(p.backImagePath);
    }
  } else {
    p.backImagePath = null;
  }
  // Mark the used-for-3d thumb visually
  const strip = document.getElementById('ws-image-versions');
  strip.querySelectorAll('.version-thumb').forEach(x => x.classList.remove('used-for-3d'));
  const imgs = p.images;
  for (let i = 0; i < imgs.length; i++) {
    if (imgs[i].path === p.selectedImagePath) {
      strip.children[i].classList.add('used-for-3d');
      break;
    }
  }
  // Update the "Use for 3D" button label
  showStep1Preview(p.previewImagePath);
  refreshButtonStates(p);
  // Show the source image in the step-2 preview so the user sees what will be converted
  showStep2SourceImage(p.selectedImagePath);
  // Move step 2 to "active" state if it wasn't already done
  const step2Card = document.getElementById('step-card-mesh');
  if (step2Card && !step2Card.classList.contains('done')) {
    step2Card.classList.remove('disabled');
    setStepStatus(2, 'active');
  }
  // Make sure the target card is expanded, and collapse the others to focus
  step2Card?.classList.remove('collapsed');
  document.getElementById('step-card-image')?.classList.add('collapsed');
  document.getElementById('step-card-rig')?.classList.add('collapsed');
  // Open Create new + force-close Edit selected (don't rely on toggle event,
  // it doesn't fire if Create new is already open)
  const step2CreateStage = step2Card?.querySelector('.stage-create');
  const step2EditStage = step2Card?.querySelector('.stage-edit');
  if (step2EditStage) step2EditStage.open = false;
  if (step2CreateStage) step2CreateStage.open = true;
  // Smooth-scroll to the 3D mesh card
  step2Card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // Briefly highlight the 3D card with a pulse effect
  step2Card?.classList.add('pulse-highlight');
  setTimeout(() => step2Card?.classList.remove('pulse-highlight'), 1500);
});

async function showStep2SourceImage(imgPath) {
  // Populate the source-image preview shown next to the "Create new" form
  // in the 3D Mesh card. This is independent of the Edit-selected mesh viewer.
  const target = document.getElementById('ws-3d-source-preview');
  if (!target) return;
  if (imgPath) {
    target.innerHTML = `<img src="file:///${imgPath.replace(/\\/g, '/')}">`;
  } else {
    target.innerHTML = '<div class="preview-placeholder">No image selected</div>';
  }
  setViewerFilename('ws-3d-source-filename', imgPath);
  // Auto-detect multi-view dir for the selected image:
  // - 6 ortho views present (<stem>_multiview/ complete) -> show grid, hide back slot
  // - Otherwise -> show back slot (2-view legacy), hide grid
  await _refreshStep2MvPreviews(imgPath);
}

async function _refreshStep2MvPreviews(imgPath) {
  const mvBlock = document.getElementById('ws-3d-source-mv-block');
  const backBlock = document.getElementById('ws-3d-source-back-block');
  const grid = document.getElementById('ws-3d-source-mv-grid');
  if (!mvBlock || !grid) return;
  let mvDir = null;
  try {
    if (imgPath && window.meshyAPI?.checkMultiviewDir) {
      const info = await window.meshyAPI.checkMultiviewDir(imgPath);
      if (info && info.exists && info.dir) mvDir = info.dir;
    }
  } catch (_) { /* ignore */ }
  if (mvDir) {
    mvBlock.classList.remove('hidden');
    if (backBlock) backBlock.classList.add('hidden');
    const LABELS = ['FRONT', 'RIGHT', 'BACK', 'LEFT', 'TOP', 'BOTTOM'];
    grid.innerHTML = LABELS.map((label, i) => {
      const vp = (mvDir + '/view_' + i + '.png').replace(/\\/g, '/');
      return (
        '<div class="stage-source-img stage-source-mv-thumb" '
        + 'style="position:relative; aspect-ratio:1/1;">'
        + '<img src="file:///' + vp + '?t=' + Date.now() + '">'
        + '<span style="position:absolute; bottom:2px; left:2px; '
        + 'background:rgba(0,0,0,0.7); color:#fff; font-size:9px; '
        + 'padding:1px 4px; border-radius:3px; letter-spacing:0.5px;">'
        + label + '</span>'
        + '</div>'
      );
    }).join('');
  } else {
    mvBlock.classList.add('hidden');
    if (backBlock) backBlock.classList.remove('hidden');
    grid.innerHTML = '';
  }
}

// ============================================================
// 2-VIEW: optional back-photo selector under the front photo.
// Sets state.currentProject.backImagePath which is then sent to
// the image-to-3d IPC as imagePathBack.
// ============================================================
function showStep2BackImage(imgPath) {
  const target = document.getElementById('ws-3d-source-back-preview');
  const clearBtn = document.getElementById('ws-3d-source-back-clear');
  if (!target) return;
  if (imgPath) {
    target.innerHTML = `<img src="file:///${imgPath.replace(/\\/g, '/')}">`;
    if (clearBtn) clearBtn.style.display = 'inline-block';
  } else {
    target.innerHTML = '<div class="preview-placeholder">+ Add back photo</div>';
    if (clearBtn) clearBtn.style.display = 'none';
  }
  setViewerFilename('ws-3d-source-back-filename', imgPath);
}
document.getElementById('ws-3d-source-back-preview')?.addEventListener('click', async () => {
  const p = state.currentProject;
  if (!p) { showToast('Open a project first', 'error'); return; }
  // Use Electron native file picker via meshyAPI if exposed, else simple input
  try {
    const res = await API.importMesh
      ? await window.meshyAPI.importMesh()  // reuse import dialog if present
      : null;
    // Fallback: hidden input
    if (!res || !res.path) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/png,image/jpeg,image/webp';
      input.onchange = async () => {
        const f = input.files?.[0];
        if (!f) return;
        const arrBuf = await f.arrayBuffer();
        const saveRes = await window.meshyAPI.saveBuffer({
          buffer: Array.from(new Uint8Array(arrBuf)),
          filename: `${p.name}_back_${Date.now()}.png`,
          subdir: 'images',
        });
        if (saveRes?.path) {
          p.backImagePath = saveRes.path;
          showStep2BackImage(saveRes.path);
          showToast('Back photo added', 'success');
        }
      };
      input.click();
    }
  } catch (e) {
    showToast(`Add back photo failed: ${e.message || e}`, 'error');
  }
});
document.getElementById('ws-3d-source-back-clear')?.addEventListener('click', () => {
  const p = state.currentProject;
  if (!p) return;
  p.backImagePath = null;
  showStep2BackImage(null);
});

// ----- Source mesh preview for the Rig "Create new" stage -----
let rigSrcRenderer, rigSrcScene, rigSrcCamera, rigSrcControls, rigSrcModel, rigSrcRafId;
let rigSrcMeshPath = null; // path of the mesh currently loaded in the rig source viewer
function initRigSrcViewer() {
  if (rigSrcRenderer) return;
  const canvas = document.getElementById('ws-rig-source-canvas');
  if (!canvas) return;
  const w = canvas.clientWidth || 240, h = canvas.clientHeight || 240;
  const _rsV = new Viewer3D({
    canvas, fov: 45, bgColor: 0x0b0b14, cameraPos: [2, 2, 3],
    lighting: false,  // custom lights below (no fill light here)
  });
  rigSrcRenderer = _rsV.renderer;
  rigSrcScene = _rsV.scene;
  rigSrcCamera = _rsV.camera;
  rigSrcControls = _rsV.controls;
  rigSrcScene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.0));
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(5, 8, 5);
  rigSrcScene.add(dir);
  rigSrcScene.add(new THREE.AmbientLight(0xffffff, 0.3));
  _rsV.startTickLoop();
  rigSrcRafId = -1;
}

async function showRigSourceMesh(meshPath) {
  const placeholder = document.getElementById('ws-rig-source-placeholder');
  if (!meshPath) {
    if (placeholder) placeholder.style.display = '';
    if (rigSrcModel && rigSrcScene) { rigSrcScene.remove(rigSrcModel); rigSrcModel = null; }
    rigSrcMeshPath = null;
    return;
  }
  rigSrcMeshPath = meshPath;
  initRigSrcViewer();
  setViewerFilename('ws-rig-source-filename', meshPath);
  if (placeholder) placeholder.style.display = 'none';
  // Make sure no leftover landmark markers pollute this clean preview
  if (rigSrcScene) {
    for (const id in lmMarkers) {
      try { rigSrcScene.remove(lmMarkers[id]); } catch (e) {}
    }
  }
  if (rigSrcModel) { rigSrcScene.remove(rigSrcModel); rigSrcModel = null; }
  const ext = (meshPath.split('.').pop() || '').toLowerCase();
  const applyLoadedModel = (obj) => {
    rigSrcModel = obj;
    rigSrcScene.add(rigSrcModel);
    const box = new THREE.Box3().setFromObject(rigSrcModel);
    const sizeVec = box.getSize(new THREE.Vector3());
    const size = sizeVec.length();
    const center = box.getCenter(new THREE.Vector3());
    rigSrcModel.position.x -= center.x;
    rigSrcModel.position.z -= center.z;
    rigSrcModel.position.y -= box.min.y;
    const lookY = sizeVec.y * 0.5;
    // Handle FBX in cm scale (e.g. Unreal export) — same camera far-plane
    // widening as the mesh and lightbox viewers.
    rigSrcCamera.near = Math.max(0.01, size * 0.001);
    rigSrcCamera.far = Math.max(2000, size * 100);
    rigSrcCamera.updateProjectionMatrix();
    rigSrcCamera.position.set(size * 1.3, size * 0.9 + lookY, size * 1.3);
    rigSrcCamera.lookAt(0, lookY, 0);
    rigSrcControls.target.set(0, lookY, 0);
    rigSrcControls.update();
    // Re-evaluate button labels/disabled now that rigSrcModel is set (the
    // Generate Rig button depends on either selectedMeshPath or rigSrcModel
    // being truthy). Use the lightweight labels-only refresh so we don't
    // clobber which stage is currently open — the "Use this mesh for Rig"
    // flow explicitly opens Create new on the next frame and we must not
    // asynchronously re-open Edit selected here.
    try { refreshButtonLabelsAndHiding(state.currentProject); } catch (_e) {}
  };
  if (ext === 'fbx') {
    // FBXLoader needs a URL so it can resolve textures relative to the file
    const url = 'file:///' + meshPath.replace(/\\/g, '/');
    new FBXLoader().load(url, applyLoadedModel, undefined, (err) => {
      console.error('FBX load error in rig source viewer', err);
    });
  } else {
    const buffer = await API.readMeshFile(meshPath);
    if (!buffer) return;
    const loader = new GLTFLoader();
    loader.parse(buffer, '', (gltf) => { _applyMeshTextureFilter(gltf.scene); applyLoadedModel(gltf.scene); },
      (err) => console.error('GLTF parse error in rig source viewer', err));
  }
}

function basename(p) {
  return (p || '').split(/[/\\]/).pop() || '';
}
function setViewerFilename(elId, p) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = p ? basename(p) : '';
  el.title = p || '';
}

function showStep1Preview(imgPath) {
  const preview = document.getElementById('step1-preview');
  // Remove any previous img + placeholder, but KEEP the static expand button + toolbar
  const placeholder = preview.querySelector('.preview-placeholder');
  if (placeholder) placeholder.remove();
  let imgEl = preview.querySelector('img');
  if (!imgEl) {
    imgEl = document.createElement('img');
    preview.insertBefore(imgEl, preview.firstChild);
  }
  // Cache-bust — see version-thumb notes above; Electron holds onto the
  // previous bytes unless we change the URL.
  imgEl.src = 'file:///' + imgPath.replace(/\\/g, '/') + '?t=' + Date.now();
  setViewerFilename('ws-image-filename', imgPath);
  preview.classList.add('clickable');
  preview.onclick = (e) => {
    // Ignore clicks on the use-for-3d bar buttons that bubble up
    if (e.target.closest('button')) return;
    openLightbox(imgPath);
  };
  // Show + wire the expand button
  const expandBtn = document.getElementById('ws-image-expand-btn');
  if (expandBtn) {
    expandBtn.classList.remove('hidden');
    expandBtn.onclick = (e) => { e.stopPropagation(); openLightbox(imgPath); };
  }
  // Update navigation arrows + multiview bar
  _updateImageNav();
  _checkMultiviewForCurrentImage();
  // Show the "use for 3D" helper bar — always clickable, even when already selected
  const useBar = document.getElementById('ws-use-for-3d-bar');
  if (useBar) {
    const p = state.currentProject;
    const isSelected = p && p.selectedImagePath === imgPath;
    useBar.classList.remove('hidden');
    const btn = document.getElementById('ws-use-for-3d-btn');
    if (btn) {
      btn.disabled = false;
      btn.classList.toggle('used-state', isSelected);
      btn.textContent = isSelected ? '\u2713 Used for 3D generation \u2192' : 'Use this image for 3D \u2192';
    }
  }
  // Image actions bar — Copy prompt button.
  const actionsBar = document.getElementById('ws-image-actions');
  const copyBtn = document.getElementById('ws-copy-prompt-btn');
  if (actionsBar && copyBtn) {
    const p = state.currentProject;
    const promptText = (p && (p.prompt || p.initialPrompt)) || '';
    if (promptText) {
      actionsBar.classList.remove('hidden');
      copyBtn.onclick = async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(promptText);
          const orig = copyBtn.textContent;
          copyBtn.textContent = '\u2713 Copied';
          copyBtn.disabled = true;
          setTimeout(() => { copyBtn.textContent = orig; copyBtn.disabled = false; }, 1500);
        } catch (err) {
          if (typeof showToast === 'function') showToast('Copy failed: ' + err.message, 'error');
        }
      };
    } else {
      actionsBar.classList.add('hidden');
    }
  }
}

// Image navigation arrows
function _updateImageNav() {
  const p = state.currentProject;
  const prevBtn = document.getElementById('ws-img-prev');
  const nextBtn = document.getElementById('ws-img-next');
  const counter = document.getElementById('ws-img-counter');
  if (!p || !p.images || p.images.length <= 1) {
    if (prevBtn) prevBtn.classList.add('hidden');
    if (nextBtn) nextBtn.classList.add('hidden');
    if (counter) counter.classList.add('hidden');
    return;
  }
  const images = p.images;
  const curIdx = images.findIndex(i => (i.path || i) === p.previewImagePath);
  if (prevBtn) { prevBtn.classList.remove('hidden'); prevBtn.disabled = curIdx <= 0; }
  if (nextBtn) { nextBtn.classList.remove('hidden'); nextBtn.disabled = curIdx >= images.length - 1; }
  if (counter) { counter.classList.remove('hidden'); counter.textContent = `${curIdx + 1} / ${images.length}`; }
}
function _navigateImage(delta) {
  const p = state.currentProject;
  if (!p || !p.images || p.images.length <= 1) return;
  const images = p.images;
  const curIdx = images.findIndex(i => (i.path || i) === p.previewImagePath);
  const newIdx = Math.max(0, Math.min(images.length - 1, curIdx + delta));
  if (newIdx === curIdx) return;
  const newImg = images[newIdx];
  p.previewImagePath = newImg.path || newImg;
  p._activeMultiview = null;
  showStep1Preview(p.previewImagePath);
  _updateImageNav();
  // Sync version strip selection
  const strip = document.getElementById('ws-image-versions');
  if (strip) {
    strip.querySelectorAll('.version-thumb').forEach((t, i) => {
      t.classList.toggle('selected', i === newIdx);
    });
  }
}
document.getElementById('ws-img-prev')?.addEventListener('click', (e) => { e.stopPropagation(); _navigateImage(-1); });
document.getElementById('ws-img-next')?.addEventListener('click', (e) => { e.stopPropagation(); _navigateImage(1); });

// ----------------------------------------------------------------
// CREATE NEW form: Multi-view checkbox + 2-view/6-view radio + 6-view sub-options.
// Visibility rules:
//   - mv-mode-row visible iff ws-mv-enable is checked
//   - mv-6view-opts visible iff ws-mv-enable is checked AND mode = '6view'
// The legacy hidden checkbox ws-auto-multiview is kept in sync so the
// existing generate-images backend path (which expects a single boolean)
// keeps working: it triggers iff enable && mode='2view'.
function _wsMvSync() {
  const enable = document.getElementById('ws-mv-enable')?.checked ?? true;
  const mode = document.getElementById('ws-mv-mode-select')?.value || '2view';
  const modeRow = document.getElementById('ws-mv-mode-row');
  const sixOpts = document.getElementById('ws-mv-6view-opts');
  const legacy = document.getElementById('ws-auto-multiview');
  if (modeRow) modeRow.style.display = enable ? '' : 'none';
  if (sixOpts) sixOpts.classList.toggle('hidden', !(enable && mode === '6view'));
  if (legacy) legacy.checked = enable && mode === '2view';
}
document.getElementById('ws-mv-enable')?.addEventListener('change', _wsMvSync);
document.getElementById('ws-mv-mode-select')?.addEventListener('change', _wsMvSync);
_wsMvSync();
// ----------------------------------------------------------------

// Generate Multi-Views button — opens an options modal first.
// User picks post-gen refinements (RealVis harmonize, ESRGAN upscale)
// and clicks "Start". Then we (a) duplicate the source image into a
// new version (so the original stays clean), (b) generate 6 MVs on
// that new version's <stem>_multiview/ dir, (c) reload the project
// so the gallery shows the new version with MV badge.
document.getElementById('ws-multiview-btn')?.addEventListener('click', () => {
  const p = state.currentProject;
  if (!p || !p.selectedImagePath) { showToast('Pick an image first.', 'error'); return; }
  const modal = document.getElementById('modal-multiview-options');
  if (modal) modal.classList.remove('hidden');
});

document.getElementById('mv-opt-cancel')?.addEventListener('click', () => {
  document.getElementById('modal-multiview-options')?.classList.add('hidden');
});

document.getElementById('mv-opt-start')?.addEventListener('click', async () => {
  const modal = document.getElementById('modal-multiview-options');
  if (modal) modal.classList.add('hidden');
  const p = state.currentProject;
  if (!p || !p.selectedImagePath) { showToast('Pick an image first.', 'error'); return; }
  const srcImgPath = p.previewImagePath || p.selectedImagePath;
  const harmonize = document.getElementById('mv-opt-harmonize')?.checked ?? true;
  const upscale   = document.getElementById('mv-opt-upscale')?.checked ?? false;

  // Step 1: duplicate the image into a new version. The new version
  // will host the multi-view dir; the original image stays untouched
  // so the user can compare or revert.
  let mvImagePath = srcImgPath;
  try {
    const dup = await window.meshyAPI.duplicateImageVersion({
      imagePath: srcImgPath, suffix: 'mv',
    });
    if (dup && dup.success) {
      mvImagePath = dup.path;
    } else {
      showToast('Could not duplicate image: ' + (dup?.error || 'unknown'), 'error', 5000);
      return;
    }
  } catch (e) {
    showToast('Duplicate failed: ' + e.message, 'error', 5000);
    return;
  }

  // Step 2: kick off the multi-view generation on the duplicated image.
  const expectedMs = 70000 + (harmonize ? 30000 : 0) + (upscale ? 10000 : 0);
  const job = pushJob(`Multi-views: ${p.name}`, null, {
    Image: (mvImagePath || '').split(/[\\/]/).pop(),
    Harmonize: harmonize ? 'yes' : 'no',
    Upscale: upscale ? 'yes' : 'no',
  }, expectedMs);
  showToast('Generating 6 multi-views...', 'info', 5000);
  try {
    const result = await API.generateMultiview({
      imagePath: mvImagePath, harmonize, upscale,
    });
    if (result && result.success) {
      showToast('Multi-views generated!', 'success');
      if (!p._multiviews) p._multiviews = {};
      p._multiviews[mvImagePath] = result.outDir;
      if (job && typeof completeJob === 'function') completeJob(job.id, true);
      // Reload project so the duplicated image shows up in the gallery
      // (as the newest "v0"), then select it so the MV bar appears.
      if (typeof reloadCurrentProject === 'function') {
        await reloadCurrentProject();
      }
    } else {
      const msg = (result && result.error) || 'unknown';
      showToast('Multi-view failed: ' + msg, 'error', 5000);
      if (job && typeof completeJob === 'function') completeJob(job.id, false, msg);
    }
  } catch (e) {
    showToast('Multi-view error: ' + e.message, 'error', 5000);
    if (job && typeof completeJob === 'function') completeJob(job.id, false, e.message);
  }
});

// Multi-view face selector
// CRM engine (default now) produces:
//   view_0=front(0°), view_1=right(90°), view_2=back(180°),
//   view_3=left(270°), view_4=TOP(elev +90°), view_5=BOTTOM(elev -90°)
// Legacy Z123 aliases kept for backward compat with older projects.
const _mvViewMap = {
  front:  'input',    // original image (0°, el=0)
  right:  'view_1',   // 90°
  back:   'view_2',   // 180°
  left:   'view_3',   // 270°
  top:    'view_4',   // elev +90°
  bottom: 'view_5',   // elev -90°
  // Legacy Z123 keys (30/150/210/330) map to the closest CRM slot:
  'fr':   'view_1',   // 30° -> right
  'br':   'view_2',   // 150° -> back
  'bl':   'view_3',   // 210° -> left
  'fl':   'view_1',   // 330° -> right (closest front-right equiv)
};

function _showMultiviewBar(multiviewDir) {
  const bar = document.getElementById('ws-multiview-bar');
  console.log('[mv-show] bar found?', !!bar, 'current classes:', bar?.className);
  if (!bar) return;
  bar.classList.remove('hidden');
  bar.dataset.dir = multiviewDir;
  bar.querySelectorAll('.mv-btn').forEach(b => b.classList.remove('mv-active'));
  // 2-view mode (no full multiview dir): hide right/left/top/bottom, keep
  // only front + back. With a full <stem>_multiview/ dir we have 6 ortho
  // views and show them all.
  const has6 = !!multiviewDir;
  bar.querySelectorAll('.mv-btn').forEach(b => {
    const v = b.dataset.view;
    const shouldShow = (v === 'front' || v === 'back') || has6;
    b.style.display = shouldShow ? '' : 'none';
  });
  // Restore the previously selected angle if the user has one pinned.
  // Multi-views use the same 6 standardized keys (front/fr/right/br/bl/
  // left/fl) across every image version, so switching from v0 to v1 while
  // having 90° (right) selected should keep 90° selected — plus the
  // preview image should swap to that angle's file in the new version.
  const p = state.currentProject;
  const activeKey = (p && p._activeMultiviewKey) || 'front';
  const activeBtn = bar.querySelector(`[data-view="${activeKey}"]`)
                 || bar.querySelector('[data-view="front"]');
  if (activeBtn) activeBtn.classList.add('mv-active');
  // If the active key is a non-front view, load that view's image into the
  // preview (we can't trigger a real click synchronously because the preview
  // was just swapped to the base image; do it via the same swap logic).
  if (p && activeKey && activeKey !== 'front') {
    const filename = _mvViewMap[activeKey];
    if (filename) {
      const imgPath = multiviewDir + '/' + filename + '.png';
      p._activeMultiview = imgPath;
      const preview = document.getElementById('step1-preview');
      const imgEl = preview?.querySelector('img');
      if (imgEl) {
        imgEl.src = 'file:///' + imgPath.replace(/\\/g, '/') + '?t=' + Date.now();
      }
    }
  }
  console.log('[mv-show] after show, classes:', bar.className, 'display:', getComputedStyle(bar).display);
}

function _hideMultiviewBar() {
  const bar = document.getElementById('ws-multiview-bar');
  if (bar) bar.classList.add('hidden');
}

function _normPath(p) { return (p || '').replace(/\\/g, '/'); }

async function _checkMultiviewForCurrentImage() {
  const p = state.currentProject;
  console.log('[mv-check] previewImagePath:', p?.previewImagePath, 'multiviews keys:', p?._multiviews ? Object.keys(p._multiviews) : 'none', 'backphotos:', p?._backPhotos ? Object.keys(p._backPhotos) : 'none');
  if (!p || !p.previewImagePath) { _hideMultiviewBar(); return; }
  const key = _normPath(p.previewImagePath);
  // 2-view mode: if a back photo was generated for this image, show the
  // FRONT/BACK bar even without a full 6-view dir.
  if (p._backPhotos) {
    const backFound = Object.keys(p._backPhotos).find(k => _normPath(k) === key);
    if (backFound) {
      _showMultiviewBar(null);  // null = no full mv dir, just front+back
      return;
    }
  }
  // First try the in-memory cache (populated when user clicks
  // Multi-Views during the same session).
  if (p._multiviews) {
    const found = Object.keys(p._multiviews).find(k => _normPath(k) === key);
    if (found) {
      _showMultiviewBar(p._multiviews[found]);
      return;
    }
  }
  // Fall back to disk: reloadCurrentProject() clears _multiviews,
  // so after a 3D gen / refresh the bar would vanish even though the
  // <image_stem>_multiview/ folder still exists next to the image.
  // Ask main.js whether it's there and re-populate the cache.
  try {
    const info = await window.meshyAPI.checkMultiviewDir(p.previewImagePath);
    if (info && info.exists && info.dir) {
      if (!p._multiviews) p._multiviews = {};
      p._multiviews[p.previewImagePath] = info.dir;
      _showMultiviewBar(info.dir);
      return;
    }
  } catch (e) { /* ignore, bar stays hidden */ }
  _hideMultiviewBar();
}

document.getElementById('ws-multiview-bar')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.mv-btn');
  if (!btn) return;
  e.stopPropagation();
  const view = btn.dataset.view;
  const bar = document.getElementById('ws-multiview-bar');
  const dir = bar?.dataset.dir;
  if (!view) return;

  // Update active button
  bar.querySelectorAll('.mv-btn').forEach(b => b.classList.remove('mv-active'));
  btn.classList.add('mv-active');

  // Resolve the view's on-disk path. 'front' = the project's original
  // image (kept on its own path); other views live inside the multiview
  // dir alongside the 'input.png' copy.
  const p = state.currentProject;
  let imgPath;
  if (view === 'front') {
    imgPath = p?.previewImagePath || (dir ? dir + '/input.png' : null);
    if (p) { p._activeMultiview = null; p._activeMultiviewKey = 'front'; }
  } else if (view === 'back' && p?._backPhotos && p.previewImagePath) {
    // 2-view mode: use the RealVis-generated back photo for this image
    const key = _normPath(p.previewImagePath);
    const found = Object.keys(p._backPhotos).find(k => _normPath(k) === key);
    if (found) {
      imgPath = p._backPhotos[found];
      p._activeMultiview = imgPath;
      p._activeMultiviewKey = 'back';
    }
  } else if (dir) {
    const filename = _mvViewMap[view] || 'input';
    imgPath = dir + '/' + filename + '.png';
    if (p) { p._activeMultiview = imgPath; p._activeMultiviewKey = view; }
  }
  if (!imgPath) return;

  const preview = document.getElementById('step1-preview');
  const imgEl = preview?.querySelector('img');
  if (imgEl) {
    imgEl.src = 'file:///' + imgPath.replace(/\\/g, '/') + '?t=' + Date.now();
  }
});

// ============================================================
// MESH VIEWER CONTROLS (toolbar logic shared between mini + lightbox)
// ============================================================
// State per viewer: a Set of options. Each viewer has its own state.
function createMeshViewerControls(toolbarEl, getViewer) {
  if (!toolbarEl) return;
  // viewer = { scene, camera, controls, model, renderer, gridHelper, skelHelper, lightDir }
  const state = {
    wireframe: false,
    pbr: true,
    grid: true,
    bones: false,
    shadows: false, // off by default — the renderer has no shadow map configured until applyShadows sets it up
    xray: false, // when true, mesh becomes semi-transparent so the rig/landmarks show through
    bg: 'dark',
    light: 1.0,
    pivot: 'bottom', // 'bottom' | 'center' | 'top'
    showPivot: false,
    landmarksVisible: true, // toggled by the lm-show toolbar button
  };

  const BG_COLORS = {
    dark: 0x1d1d2c,
    studio: 0xf0f0f0,
    black: 0x000000,
    gray: 0x444444,
  };

  function ensureGrid(viewer) {
    if (!viewer.scene) return;
    // Find existing gridHelper directly on the scene (since `viewer` is a fresh
    // object returned by getViewer() on each call, we can't use it as storage)
    let existing = null;
    viewer.scene.traverse(o => { if (o.userData && o.userData._isFabmeshGrid) existing = o; });
    if (state.grid && !existing) {
      const grid = new THREE.GridHelper(10, 20, 0x444466, 0x222233);
      grid.material.opacity = 0.5;
      grid.material.transparent = true;
      grid.userData._isFabmeshGrid = true;
      viewer.scene.add(grid);
    } else if (!state.grid && existing) {
      viewer.scene.remove(existing);
      try { existing.geometry.dispose(); existing.material.dispose(); } catch (e) {}
    }
  }

  function ensureSkeletonHelper(viewer) {
    if (!viewer.scene || !viewer.model) return;
    // Look up the helper directly inside the model so the search survives
    // viewer-literal recreation. Adding the helper as a CHILD of the model
    // (not the scene) is critical: SkeletonHelper renders bone segments in
    // its parent's local space, so attaching it under the model makes the
    // bones inherit the model's centering/rotation/scale and line up
    // perfectly with the visible mesh.
    let existing = null;
    viewer.model.traverse(o => { if (o.name === 'SkeletonHelper') existing = o; });
    if (state.bones && !existing) {
      const helper = new THREE.SkeletonHelper(viewer.model);
      // WebGL on Windows/ANGLE ignores linewidth, so we boost visibility via
      // a bright color + always-on-top rendering. The helper auto-updates each
      // frame from the bones it watches, so animations play correctly.
      try {
        helper.material.linewidth = 3;
        helper.material.color = new THREE.Color(0x00ffff); // bright cyan
        helper.material.depthTest = false;
        helper.material.transparent = true;
        helper.material.opacity = 1.0;
      } catch (e) {}
      helper.renderOrder = 998; // above the mesh, below landmark markers
      helper.name = 'SkeletonHelper';
      viewer.model.add(helper);
      // Add cyan spheres directly as children of each bone so they inherit
      // the animated transformations and follow the skeleton during playback.
      // We use a small radius proportional to the model size.
      const box = new THREE.Box3().setFromObject(viewer.model);
      const sz = box.getSize(new THREE.Vector3()).length();
      const r = Math.max(0.005, sz * 0.008);
      const jointMat = new THREE.MeshBasicMaterial({ color: 0x00ffff, depthTest: false, transparent: true, opacity: 0.95 });
      const jointGeo = new THREE.SphereGeometry(r, 12, 12);
      const bones = [];
      viewer.model.traverse(c => { if (c.isBone) bones.push(c); });
      // Debug: log how many bones we found and their world bbox so we can
      // diagnose rigs that look wrong (e.g. all bones collapsing to a point).
      if (bones.length > 0) {
        const bbb = new THREE.Box3();
        bones.forEach(b => {
          const wp = new THREE.Vector3();
          b.getWorldPosition(wp);
          bbb.expandByPoint(wp);
        });
        console.log('[bones] count=', bones.length, 'world bbox min=', bbb.min, 'max=', bbb.max, 'size=', bbb.getSize(new THREE.Vector3()));
      } else {
        console.warn('[bones] NO BONES FOUND in model — the rig has no skeleton');
      }
      bones.forEach(b => {
        const s = new THREE.Mesh(jointGeo, jointMat);
        s.name = '__fmJoint__';
        s.renderOrder = 999;
        b.add(s); // attach as child of the bone — auto-follows animation
      });
      // Make the mesh semi-transparent so the bones are visible
      viewer.model.traverse(c => {
        if (c.isMesh && c.material) {
          const mats = Array.isArray(c.material) ? c.material : [c.material];
          mats.forEach(m => { m.transparent = true; m.opacity = 0.35; });
        }
      });
    } else if (!state.bones && existing) {
      if (existing.parent) existing.parent.remove(existing);
      try { existing.dispose && existing.dispose(); } catch (e) {}
      // Remove the joint spheres attached as children of each bone
      if (viewer.model) {
        const toRemove = [];
        viewer.model.traverse(o => { if (o.name === '__fmJoint__') toRemove.push(o); });
        toRemove.forEach(s => {
          if (s.parent) s.parent.remove(s);
          try { s.geometry.dispose(); s.material.dispose(); } catch (_e) {}
        });
        viewer.model.traverse(c => {
          if (c.isMesh && c.material) {
            const mats = Array.isArray(c.material) ? c.material : [c.material];
            mats.forEach(m => { m.transparent = false; m.opacity = 1.0; });
          }
        });
      }
    }
  }

  function applyWireframe(viewer) {
    if (!viewer.model) return;
    viewer.model.traverse(c => {
      if (c.isMesh && c.material) {
        const mats = Array.isArray(c.material) ? c.material : [c.material];
        mats.forEach(m => { if ('wireframe' in m) m.wireframe = state.wireframe; });
      }
    });
  }

  // X-Ray mode: makes the mesh translucent so the bones / landmarks behind it
  // are clearly visible. Skips bone helpers and grid helpers themselves.
  function applyXray(viewer) {
    if (!viewer.model) return;
    viewer.model.traverse(c => {
      if (!c.isMesh || !c.material) return;
      // Don't touch helper meshes (joint spheres, ground plane, etc.)
      if (c.name === '__fmJoint__' || c.name === '__shadowGround__') return;
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      mats.forEach(m => {
        if (state.xray) {
          if (m.userData._origTransparent === undefined) m.userData._origTransparent = !!m.transparent;
          if (m.userData._origOpacity === undefined) m.userData._origOpacity = (typeof m.opacity === 'number') ? m.opacity : 1.0;
          m.transparent = true;
          m.opacity = 0.25;
          m.depthWrite = false;
        } else {
          // Restore original values
          if (m.userData._origTransparent !== undefined) {
            m.transparent = m.userData._origTransparent;
            delete m.userData._origTransparent;
          }
          if (m.userData._origOpacity !== undefined) {
            m.opacity = m.userData._origOpacity;
            delete m.userData._origOpacity;
          }
          m.depthWrite = true;
        }
        m.needsUpdate = true;
      });
    });
  }

  function applyPBR(viewer) {
    if (!viewer.model) return;
    // PBR on = original materials. PBR off = MeshNormalMaterial-like flat shading.
    viewer.model.traverse(c => {
      if (c.isMesh && c.material) {
        if (state.pbr) {
          if (c.userData._origMat) {
            c.material = c.userData._origMat;
            delete c.userData._origMat;
          }
        } else {
          if (!c.userData._origMat) {
            c.userData._origMat = c.material;
            c.material = new THREE.MeshNormalMaterial({ flatShading: true });
          }
        }
      }
    });
  }

  function applyBackground(viewer) {
    if (!viewer.scene) return;
    viewer.scene.background = new THREE.Color(BG_COLORS[state.bg] || 0x1d1d2c);
  }

  function applyLight(viewer) {
    if (!viewer.scene) return;
    viewer.scene.traverse(o => {
      if (o.isLight) o.intensity = (o.userData._baseIntensity || 1) * state.light;
    });
  }

  function applyPivot(viewer) {
    if (!viewer.model) return;
    const box = new THREE.Box3().setFromObject(viewer.model);
    const sizeVec = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    // Reset to origin first: undo any previous pivot offset
    viewer.model.position.x -= center.x;
    viewer.model.position.z -= center.z;
    if (state.pivot === 'bottom') {
      viewer.model.position.y -= box.min.y;
    } else if (state.pivot === 'center') {
      viewer.model.position.y -= center.y;
    } else if (state.pivot === 'top') {
      viewer.model.position.y -= box.max.y;
    }
    // Refresh the axes helper to follow the new pivot
    if (state.showPivot) ensurePivotAxes(viewer);
  }

  function ensurePivotAxes(viewer) {
    if (!viewer.scene) return;
    let existing = null;
    viewer.scene.traverse(o => { if (o.userData && o.userData._isPivotAxes) existing = o; });
    if (state.showPivot && !existing) {
      // Size the axes proportionally to the model
      const box = viewer.model ? new THREE.Box3().setFromObject(viewer.model) : null;
      const size = box ? box.getSize(new THREE.Vector3()).length() : 1;
      const axes = new THREE.AxesHelper(size * 0.3);
      axes.userData._isPivotAxes = true;
      // The pivot is at world (0, 0, 0) since we positioned the model relative to it
      axes.position.set(0, 0, 0);
      // Make the axes always render on top so they're visible through the mesh
      axes.material.depthTest = false;
      axes.material.depthWrite = false;
      axes.renderOrder = 9999;
      viewer.scene.add(axes);
    } else if (!state.showPivot && existing) {
      viewer.scene.remove(existing);
      try { existing.geometry.dispose(); existing.material.dispose(); } catch (e) {}
    }
  }

  function applyShadows(viewer) {
    // Pick the right renderer for this viewer (works for all of ws, rigSrc,
    // rigVw, lb3d and lmFs since each passes its own renderer via getViewer).
    if (!viewer.renderer) {
      if (viewer.scene === (typeof lb3dScene !== 'undefined' ? lb3dScene : null)) viewer.renderer = lb3dRenderer;
      else if (viewer.scene === (typeof rigVwScene !== 'undefined' ? rigVwScene : null)) viewer.renderer = rigVwRenderer;
      else if (viewer.scene === (typeof rigSrcScene !== 'undefined' ? rigSrcScene : null)) viewer.renderer = rigSrcRenderer;
      else viewer.renderer = wsRenderer;
    }
    const r = viewer.renderer;
    if (r) {
      r.shadowMap.enabled = state.shadows;
      r.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    // Find the main directional light in the scene (the brightest one). We
    // promote it to a shadow caster and configure its shadow camera to match
    // the current model's bounding box — otherwise the default ±5 frustum
    // clips everything out and the whole mesh turns black.
    let mainLight = null;
    let maxIntensity = 0;
    viewer.scene?.traverse(o => {
      if (o.isDirectionalLight && o.intensity > maxIntensity) {
        mainLight = o;
        maxIntensity = o.intensity;
      }
    });
    if (mainLight) {
      mainLight.castShadow = state.shadows;
      if (state.shadows && viewer.model) {
        // Size the shadow camera around the model's bbox
        const box = new THREE.Box3().setFromObject(viewer.model);
        const size = box.getSize(new THREE.Vector3()).length();
        const r2 = Math.max(2, size * 0.8);
        mainLight.shadow.mapSize.set(1024, 1024);
        mainLight.shadow.camera.left = -r2;
        mainLight.shadow.camera.right = r2;
        mainLight.shadow.camera.top = r2;
        mainLight.shadow.camera.bottom = -r2;
        mainLight.shadow.camera.near = 0.1;
        mainLight.shadow.camera.far = size * 4;
        mainLight.shadow.bias = -0.0005;
        mainLight.shadow.normalBias = 0.02;
        mainLight.shadow.camera.updateProjectionMatrix();
      }
    }
    // Mesh flags
    viewer.scene?.traverse(o => {
      if (o.isMesh) {
        o.castShadow = state.shadows;
        o.receiveShadow = state.shadows;
      }
    });
    // Ensure a ground-receiver plane exists under the model when shadows are
    // on — otherwise there's nothing to project onto and shadows are invisible
    const GROUND_NAME = '__shadowGround__';
    let ground = viewer.scene?.getObjectByName(GROUND_NAME);
    if (state.shadows && viewer.scene && viewer.model) {
      const box = new THREE.Box3().setFromObject(viewer.model);
      const size = box.getSize(new THREE.Vector3()).length();
      if (!ground) {
        const g = new THREE.PlaneGeometry(size * 4, size * 4);
        const m = new THREE.ShadowMaterial({ opacity: 0.35 });
        ground = new THREE.Mesh(g, m);
        ground.name = GROUND_NAME;
        ground.rotation.x = -Math.PI / 2;
        ground.receiveShadow = true;
        viewer.scene.add(ground);
      }
      ground.position.y = box.min.y;
    } else if (!state.shadows && ground && viewer.scene) {
      viewer.scene.remove(ground);
      try { ground.geometry.dispose(); ground.material.dispose(); } catch (e) {}
    }
  }
  // Helper to find lb3d viewer (used in applyShadows)
  function lb3dViewerRef() {
    return typeof lb3dScene !== 'undefined' && lb3dScene ? { scene: lb3dScene } : null;
  }

  function captureBaseLightIntensities(viewer) {
    viewer.scene.traverse(o => {
      if (o.isLight && !o.userData._baseIntensity) {
        o.userData._baseIntensity = o.intensity;
      }
    });
  }

  function setView(viewer, view) {
    if (!viewer.camera || !viewer.controls || !viewer.model) return;
    const box = new THREE.Box3().setFromObject(viewer.model);
    const sizeVec = box.getSize(new THREE.Vector3());
    const size = sizeVec.length();
    // Model is centered on X/Z and sits on y=0. Look at mid-height.
    const cx = 0, cz = 0;
    const cy = sizeVec.y * 0.5;
    const d = size * 1.4;
    const positions = {
      front:  [cx, cy, cz + d],
      back:   [cx, cy, cz - d],
      left:   [cx - d, cy, cz],
      right:  [cx + d, cy, cz],
      top:    [cx, cy + d, cz + 0.001],
      bottom: [cx, cy - d, cz + 0.001],
      iso:    [cx + d * 0.7, cy + d * 0.5, cz + d * 0.7],
    };
    const p = positions[view];
    if (!p) return;
    viewer.camera.position.set(p[0], p[1], p[2]);
    viewer.camera.lookAt(cx, cy, cz);
    viewer.controls.target.set(cx, cy, cz);
    viewer.controls.update();
  }

  function resetCamera(viewer) {
    if (!viewer.model) return;
    const box = new THREE.Box3().setFromObject(viewer.model);
    const sizeVec = box.getSize(new THREE.Vector3());
    const size = sizeVec.length();
    // The model is already positioned so its bottom sits on y=0; aim at mid-height
    const lookY = sizeVec.y * 0.5;
    viewer.camera.position.set(size * 1.2, size * 0.8 + lookY, size * 1.2);
    viewer.camera.lookAt(0, lookY, 0);
    viewer.controls.target.set(0, lookY, 0);
    viewer.controls.update();
  }

  // Event bindings on the toolbar
  toolbarEl.querySelectorAll('button[data-act], select[data-act], input[data-act]').forEach(el => {
    const act = el.dataset.act;
    if (el.tagName === 'BUTTON') {
      el.addEventListener('click', () => {
        const viewer = getViewer();
        if (!viewer) return;
        captureBaseLightIntensities(viewer);
        if (act === 'reset') { resetCamera(viewer); return; }
        if (act === 'wire') { state.wireframe = !state.wireframe; el.classList.toggle('active', state.wireframe); applyWireframe(viewer); return; }
        if (act === 'pbr') { state.pbr = !state.pbr; el.classList.toggle('active', !state.pbr); applyPBR(viewer); return; }
        if (act === 'grid') { state.grid = !state.grid; el.classList.toggle('active', state.grid); ensureGrid(viewer); return; }
        if (act === 'bones') { state.bones = !state.bones; el.classList.toggle('active', state.bones); ensureSkeletonHelper(viewer); return; }
        if (act === 'shadows') { state.shadows = !state.shadows; el.classList.toggle('active', state.shadows); applyShadows(viewer); return; }
        if (act === 'xray') { state.xray = !state.xray; el.classList.toggle('active', state.xray); applyXray(viewer); return; }
        if (act === 'pivot-show') { state.showPivot = !state.showPivot; el.classList.toggle('active', state.showPivot); ensurePivotAxes(viewer); return; }
        if (act === 'lm-show') {
          // Toggle visibility of all placed landmark markers (in every scene —
          // the markers object is a global map, each entry is a THREE.Mesh that
          // may live in wsScene, rigSrcScene, rigVwScene or lmFsScene). Also
          // toggle the clones mirrored into the 3D lightbox scene.
          state.landmarksVisible = state.landmarksVisible === false ? true : false;
          el.classList.toggle('active', state.landmarksVisible);
          for (const id in lmMarkers) {
            if (lmMarkers[id]) lmMarkers[id].visible = state.landmarksVisible;
          }
          if (typeof lb3dLandmarkClones !== 'undefined' && lb3dLandmarkClones) {
            for (const c of lb3dLandmarkClones) c.visible = state.landmarksVisible;
          }
          return;
        }
      });
    } else if (el.tagName === 'SELECT') {
      el.addEventListener('change', () => {
        const viewer = getViewer();
        if (!viewer) return;
        captureBaseLightIntensities(viewer);
        if (act === 'view') { setView(viewer, el.value); el.value = ''; return; }
        if (act === 'bg') { state.bg = el.value; applyBackground(viewer); return; }
        if (act === 'pivot') { state.pivot = el.value; applyPivot(viewer); return; }
      });
    } else if (el.type === 'range' && act === 'light') {
      const updateFill = () => {
        const min = parseFloat(el.min) || 0;
        const max = parseFloat(el.max) || 100;
        const v = parseFloat(el.value) || 0;
        const pct = ((v - min) / (max - min)) * 100;
        el.style.setProperty('--val', pct + '%');
      };
      updateFill();
      el.addEventListener('input', () => {
        updateFill();
        const viewer = getViewer();
        if (!viewer) return;
        captureBaseLightIntensities(viewer);
        state.light = parseInt(el.value) / 100;
        applyLight(viewer);
      });
    }
  });

  // Apply default state once a viewer becomes available
  return {
    refreshAll() {
      const viewer = getViewer();
      if (!viewer) return;
      captureBaseLightIntensities(viewer);
      ensureGrid(viewer);
      applyBackground(viewer);
      applyWireframe(viewer);
      applyPBR(viewer);
      ensureSkeletonHelper(viewer);
      applyLight(viewer);
      applyShadows(viewer);
      applyPivot(viewer);
      ensurePivotAxes(viewer);
    }
  };
}

// Bind controls for the small mesh viewer (step 2 preview)
const wsMeshControls = createMeshViewerControls(
  document.getElementById('ws-mesh-toolbar'),
  () => wsScene && wsCamera && wsControls && wsModel ? {
    scene: wsScene, camera: wsCamera, controls: wsControls, model: wsModel
  } : null
);
// Bind controls for the rig viewer (step 3 preview)
const wsRigControls = createMeshViewerControls(
  document.getElementById('ws-rig-toolbar'),
  () => rigVwScene && rigVwCamera && rigVwControls && rigVwModel ? {
    scene: rigVwScene, camera: rigVwCamera, controls: rigVwControls, model: rigVwModel
  } : null
);
// Bind controls for the lightbox viewer (initialized lazily)
let lb3dControlsApi = null;
function ensureLb3dControlsBinding() {
  if (lb3dControlsApi) return;
  lb3dControlsApi = createMeshViewerControls(
    document.getElementById('lightbox-3d-toolbar'),
    () => lb3dScene && lb3dCamera && lb3dControls && lb3dModel ? {
      scene: lb3dScene, camera: lb3dCamera, controls: lb3dControls, model: lb3dModel
    } : null
  );
}

// Toolbar refresh is triggered from showStep2Preview itself (search "ws-mesh-toolbar" lower in file).

// ----- Viewer info overlay helpers (used by image / 3D / landmarks lightboxes) -----
// Counts triangles in a Three.js model by traversing all meshes and summing
// either the index buffer or position buffer length / 3.
function countTrianglesInModel(model) {
  if (!model) return 0;
  let total = 0;
  model.traverse((child) => {
    if (child.isMesh && child.geometry) {
      const g = child.geometry;
      if (g.index) total += Math.floor(g.index.count / 3);
      else if (g.attributes && g.attributes.position) total += Math.floor(g.attributes.position.count / 3);
    }
  });
  return total;
}
// Format a triangle count with thousands separator (and k/M for large meshes)
function formatTriCount(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}
// Format an ISO date as a short, readable string
function formatModified(d) {
  try {
    const dt = new Date(d);
    const yyyy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    const hh = String(dt.getHours()).padStart(2, '0');
    const mi = String(dt.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  } catch (e) { return ''; }
}
// Render the info overlay for a file (image / mesh / rig).
// extras: optional array of {label, value} for things we know on the renderer side
//   (e.g. triangle count, position 5/12, animation count).
async function renderViewerInfo(targetEl, filePath, extras) {
  if (!targetEl || !filePath) return;
  try {
    const info = await API.getFileInfo(filePath);
    if (!info || !info.ok) { targetEl.innerHTML = ''; return; }
    const rows = [];
    rows.push(`<span class="vi-row"><b>Format:</b> ${(info.ext || '?').toUpperCase()}</span>`);
    rows.push(`<span class="vi-row"><b>Size:</b> ${info.sizeHuman}</span>`);
    if (info.width && info.height) {
      rows.push(`<span class="vi-row"><b>Dimensions:</b> ${info.width} \u00d7 ${info.height}</span>`);
    }
    if (info.modified) {
      rows.push(`<span class="vi-row"><b>Modified:</b> ${formatModified(info.modified)}</span>`);
    }
    if (Array.isArray(extras)) {
      for (const e of extras) {
        if (e && e.label && (e.value !== undefined && e.value !== null && e.value !== '')) {
          rows.push(`<span class="vi-row"><b>${e.label}:</b> ${e.value}</span>`);
        }
      }
    }
    targetEl.innerHTML = `<span class="vi-title">${info.filename}</span>` + rows.join('');
  } catch (e) {
    console.warn('renderViewerInfo failed', e);
    targetEl.innerHTML = '';
  }
}

// ----- 3D Lightbox -----
let lb3dRenderer, lb3dScene, lb3dCamera, lb3dControls, lb3dModel, lb3dRafId;
let lb3dLandmarkClones = []; // clones of lmMarkers mirrored into lb3dScene
function init3DLightbox() {
  if (lb3dRenderer) return;
  const canvas = document.getElementById('lightbox-3d-canvas');
  const _lbV = new Viewer3D({
    canvas, fov: 45, bgColor: 0x0b0b14, far: 5000, cameraPos: [2, 2, 3],
    lighting: true, autoResize: false,
  });
  lb3dRenderer = _lbV.renderer;
  lb3dScene = _lbV.scene;
  lb3dCamera = _lbV.camera;
  lb3dControls = _lbV.controls;
  // NOTE: lightbox uses its own manual start/stop loop (startLb3dLoop)
  // rather than Viewer3D's auto tick — we leave it to the existing code.
}
function resize3DLightbox() {
  if (!lb3dRenderer) return;
  const w = window.innerWidth, h = window.innerHeight;
  lb3dRenderer.setSize(w, h, false);
  lb3dCamera.aspect = w / h;
  lb3dCamera.updateProjectionMatrix();
}
function startLb3dLoop() {
  if (lb3dRafId) cancelAnimationFrame(lb3dRafId);
  function tick() {
    lb3dControls.update();
    lb3dRenderer.render(lb3dScene, lb3dCamera);
    lb3dRafId = requestAnimationFrame(tick);
  }
  tick();
}
function stopLb3dLoop() {
  if (lb3dRafId) cancelAnimationFrame(lb3dRafId);
  lb3dRafId = null;
}
let _lb3dPaths = [];
let _lb3dIndex = 0;
let _lb3dKind = 'mesh'; // 'mesh' or 'rig' — controls Use button label

async function openMeshLightbox(meshPath, kind) {
  console.log('[lb3d] openMeshLightbox', { meshPath, kind });
  if (!meshPath) {
    customError('No mesh path provided', 'Lightbox error');
    return;
  }
  // Build a navigable list from the current project, depending on what kind
  // of viewer the lightbox is showing
  const p = state.currentProject;
  try {
    _lb3dKind = kind || (p && p.rigs && p.rigs.find && p.rigs.find(r => r.path === meshPath) ? 'rig' : 'mesh');
  } catch (e) {
    _lb3dKind = 'mesh';
  }
  _lb3dPaths = [];
  if (p) {
    const collection = _lb3dKind === 'rig' ? (p.rigs || []) : (p.meshes || []);
    _lb3dPaths = collection.map(m => m.path);
  }
  if (_lb3dPaths.indexOf(meshPath) === -1) _lb3dPaths.unshift(meshPath);
  _lb3dIndex = Math.max(0, _lb3dPaths.indexOf(meshPath));
  console.log('[lb3d] kind=', _lb3dKind, 'paths=', _lb3dPaths.length, 'index=', _lb3dIndex);
  await _lb3dLoadAt(meshPath);
}

async function _lb3dLoadAt(meshPath) {
  console.log('[lb3d] _lb3dLoadAt', meshPath);
  init3DLightbox();
  ensureLb3dControlsBinding();
  document.getElementById('lightbox-3d').classList.remove('hidden');
  // Defer resize to next frame so flex layout has time to apply
  requestAnimationFrame(() => resize3DLightbox());
  // Update the bottom bar (filename + Use button label)
  const fnEl = document.getElementById('lightbox-3d-filename');
  if (fnEl) fnEl.textContent = (basename(meshPath) || '') + (_lb3dPaths.length > 1 ? `  ·  ${_lb3dIndex + 1} / ${_lb3dPaths.length}` : '');
  const useBtn = document.getElementById('lightbox-3d-use');
  if (useBtn) {
    useBtn.textContent = _lb3dKind === 'rig'
      ? 'Export this rig \u2192'
      : 'Use this mesh for Rig \u2192';
  }
  // Show the landmarks toolbar button only when the lightbox displays a rig
  // (no point showing/toggling landmarks on a raw mesh preview).
  const lmBtn = document.getElementById('lb3d-lm-btn');
  if (lmBtn) lmBtn.classList.toggle('hidden', _lb3dKind !== 'rig');
  // Same for the Bones button — only meaningful for rig viewer
  const bonesBtn = document.getElementById('lb3d-bones-btn');
  if (bonesBtn) bonesBtn.classList.toggle('hidden', _lb3dKind !== 'rig');
  _lb3dUpdateNavButtons();
  // Show file metadata immediately (without tri count); refreshed once the
  // model is loaded so we can include the triangle count
  const infoEl = document.getElementById('lightbox-3d-info');
  if (infoEl) {
    const baseExtras = _lb3dPaths.length > 1
      ? [{ label: 'Position', value: `${_lb3dIndex + 1} / ${_lb3dPaths.length}` }]
      : [];
    renderViewerInfo(infoEl, meshPath, baseExtras);
  }
  // Clear previous model
  if (lb3dModel) { lb3dScene.remove(lb3dModel); lb3dModel = null; }
  const ext = (meshPath.split('.').pop() || '').toLowerCase();
  function fitAndApply(obj) {
    console.log('[lb3d] fitAndApply, model:', obj);
    lb3dModel = obj;
    lb3dScene.add(lb3dModel);
    const box = new THREE.Box3().setFromObject(lb3dModel);
    const sizeVec = box.getSize(new THREE.Vector3());
    const size = sizeVec.length();
    const center = box.getCenter(new THREE.Vector3());
    console.log('[lb3d] bbox size=', sizeVec, 'diag=', size, 'center=', center);
    lb3dModel.position.x -= center.x;
    lb3dModel.position.z -= center.z;
    lb3dModel.position.y -= box.min.y;
    const lookY = sizeVec.y * 0.5;
    // Increase camera far plane in case the FBX is in cm scale (Unreal export)
    lb3dCamera.near = Math.max(0.01, size * 0.001);
    lb3dCamera.far = Math.max(2000, size * 100);
    lb3dCamera.updateProjectionMatrix();
    lb3dCamera.position.set(size * 1.3, size * 0.9 + lookY, size * 1.3);
    lb3dCamera.lookAt(0, lookY, 0);
    lb3dControls.target.set(0, lookY, 0);
    lb3dControls.update();
    if (lb3dControlsApi) setTimeout(() => lb3dControlsApi.refreshAll(), 50);
    // Force a resize after the model is in scene (in case canvas dimensions
    // weren't applied yet when we called resize3DLightbox earlier)
    resize3DLightbox();
    // Mirror any placed landmark markers into this lightbox scene. The
    // originals were raycasted against a model that was recentered with the
    // same algorithm we just applied to lb3dModel, so their positions match
    // directly — no offset needed. We clone them so toggling visibility or
    // navigating the lightbox doesn't mutate the originals.
    if (lb3dLandmarkClones && lb3dLandmarkClones.length) {
      for (const c of lb3dLandmarkClones) {
        lb3dScene.remove(c);
        try { c.geometry.dispose(); c.material.dispose(); } catch (e) {}
      }
    }
    lb3dLandmarkClones = [];
    // Scale markers proportionally to the mesh size (the source spheres
    // were sized for the small workspace viewers)
    const markerScale = Math.max(0.005, size * 0.012);
    for (const id in lmMarkers) {
      const src = lmMarkers[id];
      if (!src) continue;
      const geom = new THREE.SphereGeometry(markerScale, 16, 16);
      // Mirror the always-on-top flags from the originals so markers are
      // visible even when occluded by the mesh geometry.
      const mat = new THREE.MeshBasicMaterial({
        color: src.material?.color?.getHex?.() || 0xff4477,
        depthTest: false,
        transparent: true,
        opacity: 0.85,
      });
      const clone = new THREE.Mesh(geom, mat);
      clone.position.copy(src.position);
      clone.renderOrder = 999;
      clone.visible = src.visible !== false;
      clone.name = '__lb3dLm__' + id;
      lb3dScene.add(clone);
      lb3dLandmarkClones.push(clone);
    }
    // Refresh the info overlay with mesh-derived stats (triangles, bones)
    const infoEl2 = document.getElementById('lightbox-3d-info');
    if (infoEl2) {
      const tris = countTrianglesInModel(lb3dModel);
      const extras2 = _lb3dPaths.length > 1
        ? [{ label: 'Position', value: `${_lb3dIndex + 1} / ${_lb3dPaths.length}` }]
        : [];
      extras2.push({ label: 'Triangles', value: formatTriCount(tris) });
      // For rigs, also show bone count and animation count
      let boneCount = 0;
      let animCount = (lb3dModel.animations && lb3dModel.animations.length) || 0;
      lb3dModel.traverse((c) => { if (c.isBone) boneCount++; });
      if (boneCount > 0) extras2.push({ label: 'Bones', value: boneCount });
      if (animCount > 0) extras2.push({ label: 'Animations', value: animCount });
      renderViewerInfo(infoEl2, _lb3dPaths[_lb3dIndex] || '', extras2);
    }
  }
  try {
    if (ext === 'fbx') {
      // FBXLoader needs a URL so it can resolve textures relative to the file
      const url = 'file:///' + meshPath.replace(/\\/g, '/');
      const loader = new FBXLoader();
      loader.load(url, fitAndApply, undefined, (err) => {
        console.error('FBX load error in lightbox', err);
        customError('Could not load FBX: ' + (err?.message || err), 'Lightbox error');
      });
    } else {
      // GLB / GLTF binary path
      const buffer = await API.readMeshFile(meshPath);
      if (!buffer) { customError('Could not read mesh file', 'Lightbox error'); return; }
      const loader = new GLTFLoader();
      loader.parse(buffer, '', (gltf) => { _applyMeshTextureFilter(gltf.scene); fitAndApply(gltf.scene); },
        (err) => console.error('GLTF parse error in lightbox', err));
    }
  } catch (e) {
    console.error('openMeshLightbox failed', e);
  }
  startLb3dLoop();
}
function _lb3dUpdateNavButtons() {
  const prev = document.getElementById('lightbox-3d-prev');
  const next = document.getElementById('lightbox-3d-next');
  if (prev) prev.disabled = _lb3dIndex <= 0;
  if (next) next.disabled = _lb3dIndex >= _lb3dPaths.length - 1;
}
document.getElementById('lightbox-3d-prev')?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (_lb3dIndex > 0) {
    _lb3dIndex--;
    _lb3dLoadAt(_lb3dPaths[_lb3dIndex]);
  }
});
document.getElementById('lightbox-3d-next')?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (_lb3dIndex < _lb3dPaths.length - 1) {
    _lb3dIndex++;
    _lb3dLoadAt(_lb3dPaths[_lb3dIndex]);
  }
});
document.getElementById('lightbox-3d-use')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const path_ = _lb3dPaths[_lb3dIndex];
  if (!path_) return;
  closeMeshLightbox();
  if (_lb3dKind === 'rig') {
    // Trigger Export to Unreal for the selected rig
    document.getElementById('ws-rig-unreal-btn')?.click();
  } else {
    // Trigger "Use this mesh for Rig" on the workspace
    const p = state.currentProject;
    if (p) {
      p.previewMeshPath = path_;
      p.selectedMeshPath = path_;
    }
    document.getElementById('ws-use-for-rig-btn')?.click();
  }
});

function closeMeshLightbox() {
  document.getElementById('lightbox-3d').classList.add('hidden');
  stopLb3dLoop();
  const infoEl = document.getElementById('lightbox-3d-info');
  if (infoEl) infoEl.innerHTML = '';
  // Dispose landmark clones so they don't linger for the next open
  if (lb3dLandmarkClones && lb3dLandmarkClones.length) {
    for (const c of lb3dLandmarkClones) {
      if (lb3dScene) lb3dScene.remove(c);
      try { c.geometry.dispose(); c.material.dispose(); } catch (e) {}
    }
    lb3dLandmarkClones = [];
  }
}
document.getElementById('lightbox-3d-close')?.addEventListener('click', closeMeshLightbox);
document.addEventListener('keydown', (e) => {
  const lb3dVisible = !document.getElementById('lightbox-3d').classList.contains('hidden');
  if (!lb3dVisible) return;
  if (e.key === 'Escape') closeMeshLightbox();
  else if (e.key === 'ArrowLeft' && _lb3dIndex > 0) {
    _lb3dIndex--;
    _lb3dLoadAt(_lb3dPaths[_lb3dIndex]);
  } else if (e.key === 'ArrowRight' && _lb3dIndex < _lb3dPaths.length - 1) {
    _lb3dIndex++;
    _lb3dLoadAt(_lb3dPaths[_lb3dIndex]);
  }
});
window.addEventListener('resize', () => {
  if (!document.getElementById('lightbox-3d').classList.contains('hidden')) resize3DLightbox();
});

// ----- Lightbox -----
let _lightboxImages = []; // array of paths for prev/next
let _lightboxIndex = 0;
async function openLightbox(imgPath) {
  // Parental control: block opening NSFW images in fullscreen
  try {
    if (API.getParentalStatus && API.checkImagesNsfwTags) {
      const ps = await API.getParentalStatus();
      if (!ps.unrestricted) {
        const tags = await API.checkImagesNsfwTags({ images: [imgPath] });
        if (tags && tags[imgPath]) {
          showToast('This image is blocked by parental control.', 'error');
          return;
        }
      }
    }
  } catch(_) {}

  const lb = document.getElementById('lightbox-2');
  const img = document.getElementById('lightbox-2-img');
  const p = state.currentProject;
  _lightboxImages = (p && p.images) ? p.images.map(i => i.path) : [imgPath];
  _lightboxIndex = Math.max(0, _lightboxImages.indexOf(imgPath));
  img.src = 'file:///' + imgPath.replace(/\\/g, '/') + '?t=' + Date.now();
  updateLightboxBottom(imgPath);
  updateLightboxNavButtons();
  // Show multiview bar in lightbox if available for this image
  const lbMvBar = document.getElementById('lb-multiview-bar');
  if (lbMvBar) {
    const hasFullMv = !!(p?._multiviews?.[imgPath]);
    const hasBack   = !!(p?._backPhotos?.[imgPath]);
    if (hasFullMv || hasBack) {
      lbMvBar.classList.remove('hidden');
      lbMvBar.dataset.dir = hasFullMv ? p._multiviews[imgPath] : '';
      lbMvBar.querySelectorAll('.mv-btn').forEach(b => b.classList.remove('mv-active'));
      // Hide right/left/top/bottom in 2-view mode (back-only, no full dir).
      lbMvBar.querySelectorAll('.mv-btn').forEach(b => {
        const v = b.dataset.view;
        const shouldShow = (v === 'front' || v === 'back') || hasFullMv;
        b.style.display = shouldShow ? '' : 'none';
      });
      // Respect whichever angle the user had selected in the small
      // preview so small and big viewer stay in sync.
      const currentKey = (p && p._activeMultiviewKey) || 'front';
      const activeBtn = lbMvBar.querySelector(`[data-view="${currentKey}"]`)
                     || lbMvBar.querySelector('[data-view="front"]');
      if (activeBtn) activeBtn.classList.add('mv-active');
      // If active key is non-front, swap the lightbox image to that view
      if (currentKey && currentKey !== 'front') {
        let viewPath = null;
        if (currentKey === 'back' && hasBack) {
          viewPath = p._backPhotos[imgPath];
        } else if (hasFullMv) {
          const filename = _mvViewMap[currentKey];
          if (filename) viewPath = p._multiviews[imgPath] + '/' + filename + '.png';
        }
        if (viewPath) {
          setTimeout(() => {
            const lbImg = document.getElementById('lightbox-2-img');
            if (lbImg) lbImg.src = 'file:///' + viewPath.replace(/\\/g, '/') + '?t=' + Date.now();
          }, 0);
        }
      }
    } else {
      lbMvBar.classList.add('hidden');
    }
  }
  lb.classList.remove('hidden');
}
// Lightbox multiview click handler
document.getElementById('lb-multiview-bar')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.mv-btn');
  if (!btn) return;
  const bar = document.getElementById('lb-multiview-bar');
  const dir = bar?.dataset.dir;
  const view = btn.dataset.view;
  if (!view) return;
  bar.querySelectorAll('.mv-btn').forEach(b => b.classList.remove('mv-active'));
  btn.classList.add('mv-active');
  const p = state.currentProject;
  const currentFront = _lightboxImages[_lightboxIndex];
  let imgPath;
  if (view === 'front') {
    imgPath = currentFront || (dir ? dir + '/input.png' : null);
    if (p) { p._activeMultiview = null; p._activeMultiviewKey = 'front'; }
  } else if (view === 'back' && p?._backPhotos?.[currentFront]) {
    // 2-view: use the RealVis-generated back photo for this front
    imgPath = p._backPhotos[currentFront];
    p._activeMultiview = imgPath;
    p._activeMultiviewKey = 'back';
  } else if (dir) {
    const filename = _mvViewMap[view] || 'input';
    imgPath = dir + '/' + filename + '.png';
    // Persist BOTH the path (for tools) AND the key (so small and big
    // viewers stay in sync when the user flips between them).
    if (p) { p._activeMultiview = imgPath; p._activeMultiviewKey = view; }
  }
  if (!imgPath) return;
  document.getElementById('lightbox-2-img').src = 'file:///' + imgPath.replace(/\\/g, '/') + '?t=' + Date.now();
  // Also sync the SMALL preview so when the lightbox closes the
  // user sees the same view they were looking at.
  try {
    const smallPreview = document.getElementById('step1-preview');
    const smallImg = smallPreview?.querySelector('img');
    if (smallImg) {
      smallImg.src = 'file:///' + imgPath.replace(/\\/g, '/') + '?t=' + Date.now();
    }
    // Mirror active button state in the small bar too.
    const smallBar = document.getElementById('ws-multiview-bar');
    if (smallBar) {
      smallBar.querySelectorAll('.mv-btn').forEach(b => b.classList.remove('mv-active'));
      smallBar.querySelector(`[data-view="${view}"]`)?.classList.add('mv-active');
    }
  } catch (_) {}
});

// Lightbox tool column: each button routes to the workspace handler
// (clicking the workspace button). Tools read editTarget(p) which
// follows _activeMultiview — already in sync with the lightbox.
(function _wireLightboxToolbox() {
  const TOOL_MAP = {
    modify:      'ws-modify-btn',
    autoinpaint: 'ws-autoinpaint-btn',
    removebg:    'ws-removebg-btn',
    resolution:  'ws-resolution-btn',
    facefix:     'ws-facefix-btn',
    symmetry:    'ws-symmetrize-auto-btn',
    mask:        'ws-mask-btn',
    clone:       'ws-clone-btn',
    paint:       'ws-paint-btn',
    crop:        'ws-crop-btn',
  };
  const box = document.getElementById('lb-toolbox');
  if (!box) return;
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-lb-tool]');
    if (!btn) return;
    const toolKey = btn.getAttribute('data-lb-tool');
    const wsBtnId = TOOL_MAP[toolKey];
    if (!wsBtnId) return;
    const wsBtn = document.getElementById(wsBtnId);
    if (!wsBtn) { console.warn('lb-tool: missing ws button', wsBtnId); return; }
    // Some tools (Modify, Draw Mask, Clone, Paint, Auto Inpaint)
    // open their own modal. The lightbox stays open in the background;
    // close it so the modal gets focus and isn't layered under.
    const OPENS_MODAL = ['modify', 'autoinpaint', 'mask', 'clone',
                         'paint', 'crop', 'resolution'];
    if (OPENS_MODAL.includes(toolKey)) {
      closeLightbox();
    }
    // Defer so the close animation doesn't fight the modal open
    setTimeout(() => wsBtn.click(), 30);
  });
})();

function closeLightbox() {
  document.getElementById('lightbox-2').classList.add('hidden');
  const infoEl = document.getElementById('lightbox-2-info');
  if (infoEl) infoEl.innerHTML = '';
}
function lightboxShowAt(idx) {
  if (idx < 0 || idx >= _lightboxImages.length) return;
  _lightboxIndex = idx;
  const path_ = _lightboxImages[idx];
  document.getElementById('lightbox-2-img').src = 'file:///' + path_.replace(/\\/g, '/') + '?t=' + Date.now();
  updateLightboxBottom(path_);
  updateLightboxNavButtons();
}
function updateLightboxBottom(imgPath) {
  const fn = document.getElementById('lightbox-2-filename');
  if (fn) fn.textContent = (imgPath.split(/[/\\]/).pop() || '') + `  ·  ${_lightboxIndex + 1} / ${_lightboxImages.length}`;
  // Update the "Use for 3D" button label/state
  const useBtn = document.getElementById('lightbox-2-use-3d');
  if (useBtn) {
    const p = state.currentProject;
    const isAlready = p && p.selectedImagePath === imgPath;
    useBtn.classList.toggle('used-state', isAlready);
    useBtn.textContent = isAlready ? '\u2713 Used for 3D generation \u2192' : 'Use this image for 3D \u2192';
  }
  // Update the floating info overlay (top-left)
  const infoEl = document.getElementById('lightbox-2-info');
  if (infoEl) {
    const extras = [{ label: 'Position', value: `${_lightboxIndex + 1} / ${_lightboxImages.length}` }];
    renderViewerInfo(infoEl, imgPath, extras);
  }
}
function updateLightboxNavButtons() {
  const prev = document.getElementById('lightbox-2-prev');
  const next = document.getElementById('lightbox-2-next');
  if (prev) prev.disabled = _lightboxIndex <= 0;
  if (next) next.disabled = _lightboxIndex >= _lightboxImages.length - 1;
}
document.getElementById('lightbox-2-prev')?.addEventListener('click', (e) => {
  e.stopPropagation();
  lightboxShowAt(_lightboxIndex - 1);
});
document.getElementById('lightbox-2-next')?.addEventListener('click', (e) => {
  e.stopPropagation();
  lightboxShowAt(_lightboxIndex + 1);
});
document.getElementById('lightbox-2-use-3d')?.addEventListener('click', async (e) => {
  e.stopPropagation();
  const p = state.currentProject;
  if (!p) return;
  const imgPath = _lightboxImages[_lightboxIndex];
  if (!imgPath) return;
  // Sync the preview state so the green button handler picks up the right image
  p.previewImagePath = imgPath;
  // Close the lightbox first so the user sees the result
  closeLightbox();
  // Then trigger the same flow as the in-page green button:
  // assigns selectedImagePath, marks the thumb, scrolls + collapses + opens Create new
  document.getElementById('ws-use-for-3d-btn')?.click();
});
document.getElementById('lightbox-2').addEventListener('click', (e) => {
  // Close when clicking the background (not the image / nav / bottom bar)
  if (e.target.id === 'lightbox-2' || e.target.id === 'lightbox-2-close') closeLightbox();
});
document.addEventListener('keydown', (e) => {
  const lbVisible = !document.getElementById('lightbox-2').classList.contains('hidden');
  if (!lbVisible) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') lightboxShowAt(_lightboxIndex - 1);
  else if (e.key === 'ArrowRight') lightboxShowAt(_lightboxIndex + 1);
});

// Persist prompt edits to localStorage so they survive a reload
document.getElementById('ws-prompt').addEventListener('input', (e) => {
  if (state.currentProject) {
    try { localStorage.setItem('fabmesh-prompt-' + state.currentProject.name, e.target.value); } catch (err) {}
  }
});

// Quality slider live update
const qualityEl = document.getElementById('ws-quality');
const qualityLabel = document.getElementById('ws-quality-val');
if (qualityEl && qualityLabel) {
  const updateQualityLabel = () => {
    const v = parseInt(qualityEl.value);
    let tier = 'Medium';
    if (v <= 15) tier = 'Fast';
    else if (v <= 25) tier = 'Low';
    else if (v <= 35) tier = 'Medium';
    else if (v <= 45) tier = 'High';
    else tier = 'Ultra';
    qualityLabel.textContent = `${v} steps · ${tier}`;
  };
  qualityEl.addEventListener('input', updateQualityLabel);
  updateQualityLabel();
}

// Build a final prompt by wrapping the user input with type/style suffixes.
// Asset type controls framing, pose, isolation. Style controls the visual look.
//
// T-pose reminder (2026-04-16): templates for SUBJECTS THAT WILL BE 3D-MESHED
// must use "T-pose, front view, facing camera" WITHOUT conflicting
// view keywords like "isometric three-quarter view". The juggernaut bridge
// auto-detects T-pose keywords and swaps to DreamShaper XL + ControlNet
// OpenPose which guarantees the T-pose — but that only works if the prompt
// doesn't also scream "3/4 view" at the model. Inanimate assets (buildings,
// vehicles, props) keep the 3/4 view since they don't need rigging.
const ASSET_TYPE_PROMPTS = {
  character: 'single isolated 3D character, full body, T-pose neutral stance, arms extended horizontally, legs apart, strict front view, facing camera, symmetric, RTS unit game asset, plain white background, even studio lighting, no shadows, no other characters, centered, clean silhouette, no text, no UI',
  building: 'single isolated 3D building, full structure, plain white background, even studio lighting, no shadows, no characters, centered, isometric three-quarter view, clean silhouette, no text, no UI',
  vehicle: 'single isolated 3D vehicle, complete vehicle, plain white background, even studio lighting, no shadows, no characters, centered, three-quarter view, clean silhouette, no text, no UI',
  weapon: 'single isolated 3D weapon, full weapon, plain white background, even studio lighting, no shadows, centered, side view, clean silhouette, no text, no UI',
  prop: 'single isolated 3D prop, full item, plain white background, even studio lighting, no shadows, no characters, centered, three-quarter view, clean silhouette, no text, no UI',
  creature: 'single isolated 3D creature, full body, neutral stance, front view, facing camera, symmetric, plain white background, even studio lighting, no shadows, no other creatures, centered, clean silhouette, no text, no UI',
  environment: 'single isolated 3D environment piece, full structure, plain white background, even studio lighting, no shadows, no characters, centered, three-quarter view, clean silhouette, no text, no UI',
  custom: '',
};

const ASSET_STYLE_PROMPTS = {
  realistic:  'realistic style, photorealistic, sharp details, detailed materials',
  stylized:   'stylized art, mid-poly game asset, hand-painted textures, fantasy game style',
  lowpoly:    'low-poly 3D art, flat-shaded, faceted geometry, minimalist, geometric shapes, vibrant colors',
  cartoon:    'cartoon style, bold outlines, cel-shading, vibrant flat colors, expressive shapes',
  anime:      'anime style, soft cel-shading, expressive features, japanese animation aesthetic',
  pixelart:   'pixel art style, 16-bit retro game aesthetic, limited palette, sharp pixel edges',
  painterly:  'painterly style, brushstroke textures, hand-painted concept art look',
  pbr:        'PBR materials, ultra detailed, 8k textures, high-poly cinematic quality, film-grade lighting',
  voxel:      'voxel art, minecraft-inspired blocky 3D style, cubic geometry, clean voxels',
  custom:     '',
};

function buildFullPrompt(userPrompt, assetType, assetStyle) {
  const typeSuffix = ASSET_TYPE_PROMPTS[assetType] || '';
  const stylePrefix = ASSET_STYLE_PROMPTS[assetStyle] || '';
  const parts = [stylePrefix, userPrompt, typeSuffix].filter(Boolean);
  return parts.join(', ');
}

// Legacy projects saved the ENRICHED prompt (with style/type suffixes
// concatenated) to prompt.txt, then each new generation re-concatenated the
// suffixes, producing an ever-growing mess. This helper strips every known
// prefix/suffix so rehydrating the workspace textarea falls back to the raw
// user intent.
function stripKnownPromptSuffixes(raw) {
  if (!raw || typeof raw !== 'string') return raw || '';
  let txt = raw;
  const allSuffixes = [
    ...Object.values(ASSET_TYPE_PROMPTS),
    ...Object.values(ASSET_STYLE_PROMPTS),
  ].filter(s => s && s.length > 10);
  // Multi-pass removal: each suffix may appear several times in legacy data.
  let changed = true;
  let safety = 20;
  while (changed && safety-- > 0) {
    changed = false;
    for (const s of allSuffixes) {
      const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Allow an optional leading ", " so we can eat the separator we inserted.
      const re = new RegExp('(^|,\\s*)' + esc + '(?=$|,\\s*)', 'g');
      const next = txt.replace(re, (_, sep) => (sep === ',' || sep === ', ' ? '' : ''));
      if (next !== txt) { txt = next; changed = true; }
    }
  }
  // Collapse any resulting double commas / leading comma / extra whitespace.
  txt = txt.replace(/\s*,\s*,\s*/g, ', ').replace(/^\s*,\s*/, '').replace(/\s*,\s*$/, '').trim();
  return txt;
}

// Enhance prompt: expand the user's short description into a rich, detailed
// prompt by combining the raw text with the selected style + asset type keywords.
// The user sees exactly what the AI engine will receive and can tweak it further.
document.getElementById('ws-copy-prompt')?.addEventListener('click', () => {
  const text = document.getElementById('ws-prompt')?.value?.trim();
  if (!text) { showToast('No prompt to copy', 'error'); return; }
  navigator.clipboard.writeText(text).then(() => showToast('Prompt copied!', 'success', 1500))
    .catch(() => showToast('Copy failed', 'error'));
});

// Enhance prompt in the "New project" modal (same logic as the one in the
// workspace, using np-* inputs instead of ws-* inputs).
document.getElementById('np-enhance-prompt')?.addEventListener('click', () => {
  const textarea = document.getElementById('np-prompt');
  const raw = textarea.value.trim();
  if (!raw) { showToast('Type a description first.', 'error'); return; }
  const assetType = document.getElementById('np-asset-type')?.value || 'character';
  const assetStyle = document.getElementById('np-asset-style')?.value || 'realistic';
  const alreadyEnhanced = /single isolated 3D|plain white background|sharp details|photorealistic/i.test(raw);
  if (alreadyEnhanced) {
    showToast('Prompt already enhanced. Edit manually or clear it.', 'info');
    return;
  }
  textarea.value = buildFullPrompt(raw, assetType, assetStyle);
  const btn = document.getElementById('np-enhance-prompt');
  if (btn) {
    const orig = btn.innerHTML;
    btn.innerHTML = '&#10003; Enhanced';
    btn.disabled = true;
    setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 1500);
  }
});

document.getElementById('ws-enhance-prompt')?.addEventListener('click', () => {
  const textarea = document.getElementById('ws-prompt');
  const raw = textarea.value.trim();
  if (!raw) { showToast('Type a description first.', 'error'); return; }
  const assetType = document.getElementById('ws-asset-type')?.value || 'character';
  const assetStyle = document.getElementById('ws-asset-style')?.value || 'realistic';
  // Check if the prompt already looks enhanced (contains known suffix keywords)
  const alreadyEnhanced = /single isolated 3D|plain white background|sharp details|photorealistic/i.test(raw);
  if (alreadyEnhanced) {
    showToast('Prompt already enhanced. Edit manually or clear it.', 'info');
    return;
  }
  // Stash the original raw prompt so the back-view generator can use it
  // (clean subject description, no asset-style pollution).
  textarea.dataset.rawPrompt = raw;
  const enhanced = buildFullPrompt(raw, assetType, assetStyle);
  textarea.value = enhanced;
  // Persist to localStorage
  if (state.currentProject) {
    try { localStorage.setItem('fabmesh-prompt-' + state.currentProject.name, enhanced); } catch (e) {}
  }
  // Brief visual feedback
  const btn = document.getElementById('ws-enhance-prompt');
  if (btn) {
    const orig = btn.innerHTML;
    btn.innerHTML = '&#10003; Enhanced';
    btn.disabled = true;
    setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 1500);
  }
});

document.getElementById('ws-generate-image').addEventListener('click', async () => {
  const p = state.currentProject;
  if (!p) return;
  const userPrompt = document.getElementById('ws-prompt').value.trim();
  if (!userPrompt) { showToast('Type a description first.', 'error'); return; }
  const assetType = document.getElementById('ws-asset-type')?.value || 'character';
  const assetStyle = document.getElementById('ws-asset-style')?.value || 'realistic';
  const prompt = buildFullPrompt(userPrompt, assetType, assetStyle);
  const engine = document.getElementById('ws-engine').value;
  const count = parseInt(document.getElementById('ws-count').value) || 4;
  const steps = parseInt(document.getElementById('ws-quality').value) || 30;
  const multiView = document.getElementById('ws-auto-multiview')?.checked || false;
  // 6-view mode flags (CREATE NEW form). When user picks "6 views" radio,
  // multiView (= 2-view legacy) is false and we trigger MV-Adapter post-gen
  // instead of the RealVis+IPAdapter back photo.
  const mvEnable = document.getElementById('ws-mv-enable')?.checked ?? false;
  const mvMode = document.getElementById('ws-mv-mode-select')?.value || '2view';
  const mv6view = mvEnable && mvMode === '6view';
  const mv6Harmonize = document.getElementById('ws-mv-6v-harmonize')?.checked ?? true;
  const mv6Upscale   = document.getElementById('ws-mv-6v-upscale')?.checked ?? false;
  const buildStages = document.getElementById('ws-img-buildstages')?.checked || false;
  // Estimate: Juggernaut ~0.5s/step on RTX 5080, plus model load ~10s on first call.
  // SDXL Turbo ~0.2s/step. Pollinations ~5s/image.
  // Observed on RTX 5080 + torch 2.7.1 cu128: RealVisXL is ~0.6s/step
  // (pipeline setup + actual denoising). First run includes ~5s warm-up.
  let perImage;
  if (engine === 'pollinations') perImage = 5000;
  else if (engine === 'local-sd') perImage = steps * 200 + 1500;
  else perImage = steps * 600 + 5000; // local-flux RealVisXL
  let totalImages = count;
  if (multiView) totalImages *= 3;
  if (buildStages) totalImages *= 3;
  let expectedMs = totalImages * perImage + 3000; // + small warm-up
  // 6-view mode adds MV-Adapter run per image (NOT multiplied by 3 like
  // 2-view back gen because each MV run produces 6 views from 1 image).
  // MV-Adapter base ~70s + 30s if harmonize + 10s if upscale.
  if (mv6view) {
    const mvPerImage = 70000 + (mv6Harmonize ? 30000 : 0) + (mv6Upscale ? 10000 : 0);
    expectedMs += count * mvPerImage;
  }
  gatedRun('image', `Generate images: ${p.name}`, async () => {
    const job = pushJob(`Generate images: ${p.name}`, null, {
      'Asset type': assetType,
      Style: assetStyle,
      Engine: engineLabel(engine),
      Count: count,
      Steps: steps,
      'Multi-view': mv6view ? '6 views (MV-Adapter)' : (multiView ? '2 views (back)' : 'no'),
      'Construction stages': buildStages ? 'yes' : 'no',
      Prompt: userPrompt,
    }, expectedMs);
    try {
      const r = await API.generateImages({ prompt, userPrompt, engine, numImages: count, projectName: p.name, steps, multiView, buildStages, jobId: job.id, vramFraction: (gpuLimits?.vram || 90) / 100 });
      if (r?.success) {
        // Save the creation style for each generated image so the Style
        // dropdown shows the correct style when selecting any of them.
        const stylePrompt = ASSET_STYLE_PROMPTS[assetStyle] || '';
        if (stylePrompt && r.images) {
          for (const imgPath of r.images) {
            _saveImageStyle(imgPath, stylePrompt);
          }
        }
        // 2-view mode: generate a PHOTOREALISTIC back photo via RealVis XL
        // + IPAdapter (replaces Zero123++ which was hallucinated). Conditioned
        // on the front photo, prompted with the user's original asset prompt.
        if (multiView && r.images?.length > 0) {
          // Phase 2 — front image is done, now generating back views.
          // Without this bump, the progress bar would stay frozen at ~40%
          // while back-view runs silently for ~30s (no progress markers),
          // making the user think the job is stuck even though the listing
          // already shows the generated front image.
          if (job.tickTimer) { clearInterval(job.tickTimer); job.tickTimer = null; }
          job.progress = Math.max(job.progress, 60);
          job.name = `Generate back views: ${p.name}`;
          renderJobs();
          // Start a new smooth-climb timer for Phase 2 (60->92%) so the
          // progress bar keeps moving while back-view IPAdapter runs without
          // emitting progress markers. ~30s per image is a typical RealVis
          // + IPAdapter back-view; once completeJob() fires it'll snap to 100%.
          const _ph2Start = Date.now();
          const _ph2Total = 30000 * r.images.length;
          job.tickTimer = setInterval(() => {
            const _elapsed = Date.now() - _ph2Start;
            const _pct = Math.min(1, _elapsed / _ph2Total);
            const _np = 60 + (92 - 60) * _pct;
            if (_np > job.progress) {
              job.progress = _np;
              renderJobs();
            }
          }, 500);
          try {
            showToast('Generating back photos (RealVis + IPAdapter)...', 'info', 10000);
            // Use the RAW user prompt (subject only, no asset-style template)
            // for the back view. The enhanced prompt's 'RTS unit, T-pose
            // neutral stance, plain white background' tokens hurt IPAdapter
            // because they fight the photo reference style.
            const rawPrompt = document.getElementById('ws-prompt')?.dataset.rawPrompt
                              || userPrompt || '';
            for (const imgPath of r.images) {
              // STEP 1: BLIP-caption the front photo to extract outfit
              // description. This is added to the prompt so the back has
              // the same clothing as the front.
              let outfitDesc = '';
              try {
                const cap = await window.meshyAPI.captionImage({ imagePath: imgPath });
                if (cap?.success && cap.caption) {
                  outfitDesc = cap.caption;
                  console.log('[caption]', imgPath, '->', outfitDesc);
                }
              } catch (e) {
                console.warn('[caption] failed:', e);
              }
              // Combine: subject (from raw user prompt) + outfit (BLIP)
              const enrichedHint = outfitDesc
                ? `${rawPrompt}, ${outfitDesc}`
                : rawPrompt;
              const bvResult = await window.meshyAPI.generateBackView({
                frontImage: imgPath,
                promptHint: enrichedHint,
                numImages: 1,
              });
              if (bvResult?.success && bvResult.paths?.length) {
                if (!p._backPhotos) p._backPhotos = {};
                p._backPhotos[imgPath] = bvResult.paths[0];
              } else {
                console.warn('[back-view] failed for', imgPath, bvResult?.error);
              }
            }
            showToast('Back photos ready', 'success');
          } catch (e) {
            console.warn('[2-view back gen]', e);
            showToast('Back photo generation failed (continuing with front-only)', 'warn');
          }
        }
        // 6-view mode: after image gen, run MV-Adapter on each generated
        // image. The 2-view back gen above is skipped (multiView=false in
        // this branch). Reuses _wsMvSync's UI state (mv6Harmonize/Upscale).
        if (mv6view && r.images?.length > 0) {
          if (job.tickTimer) { clearInterval(job.tickTimer); job.tickTimer = null; }
          job.progress = Math.max(job.progress, 60);
          job.name = `Generating 6 views: ${p.name}`;
          renderJobs();
          const _mvStart = Date.now();
          const _mvTotal = (70000 + (mv6Harmonize?30000:0) + (mv6Upscale?10000:0)) * r.images.length;
          job.tickTimer = setInterval(() => {
            const _pct = Math.min(1, (Date.now()-_mvStart)/_mvTotal);
            const _np = 60 + (95 - 60) * _pct;
            if (_np > job.progress) { job.progress = _np; renderJobs(); }
          }, 500);
          try {
            showToast('Generating 6 views (MV-Adapter)...', 'info', 8000);
            for (const imgPath of r.images) {
              const mvRes = await API.generateMultiview({
                imagePath: imgPath,
                harmonize: mv6Harmonize,
                upscale: mv6Upscale,
              });
              if (mvRes?.success) {
                if (!p._multiviews) p._multiviews = {};
                p._multiviews[imgPath] = mvRes.outDir;
              } else {
                console.warn('[mv-6view] failed for', imgPath, mvRes?.error);
              }
            }
            showToast('6 views ready', 'success');
          } catch (e) {
            console.warn('[mv-6view]', e);
            showToast('Multi-view generation failed (continuing with front-only)', 'warn');
          }
        }
        completeJob(job.id, true);
        await reloadCurrentProject();
        // After successful image generation, open the Edit stage and scroll
        const imgCard = document.getElementById('step-card-image');
        if (imgCard) {
          imgCard.classList.remove('collapsed', 'disabled');
          const createStage = imgCard.querySelector('.stage-create');
          const editStage = imgCard.querySelector('.stage-edit');
          if (createStage) createStage.open = false;
          if (editStage) editStage.open = true;
          setTimeout(() => {
            imgCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
            imgCard.classList.add('pulse-highlight');
            setTimeout(() => imgCard.classList.remove('pulse-highlight'), 1500);
          }, 120);
        }
      } else {
        completeJob(job.id, false, r?.error || 'unknown');
        if (!job.cancelled) reportPipelineError(r?.error, 'Image generation failed');
      }
    } catch (e) {
      completeJob(job.id, false, e?.error || e?.message || String(e));
      if (!job.cancelled) reportPipelineError(e?.error || e?.message || String(e), 'Image generation error');
    }
  });
});

// ----- Image edit tools -----
// Image tools operate on whatever the user is CURRENTLY LOOKING AT:
//   1. An active multi-view (e.g. "Right" button clicked) -> that view
//   2. Otherwise the previewed image version (thumb strip / arrows)
//   3. Otherwise the image tagged "used for 3D" (first-load fallback)
function editTarget(p) {
  if (!p) return null;
  // Track that the user is about to edit a multi-view so that after
  // the tool finishes we can ask whether to regenerate the others.
  const path_ = p._activeMultiview || p.previewImagePath || p.selectedImagePath;
  if (p._activeMultiview && p._activeMultiviewKey && p._activeMultiviewKey !== 'front') {
    _pendingMvEdit = {
      projectName: p.name,
      viewKey: p._activeMultiviewKey,
      viewPath: p._activeMultiview,
    };
  } else {
    _pendingMvEdit = null;
  }
  return path_;
}

// After a tool finishes, if the target was a multi-view, ask the
// user whether to regenerate the other views for consistency or
// keep the single-view edit localised.
let _pendingMvEdit = null;
function _offerMultiviewRegenerate() {
  const info = _pendingMvEdit;
  _pendingMvEdit = null;
  if (!info) return;
  const p = state.currentProject;
  if (!p || p.name !== info.projectName) return;
  // Build a minimal inline confirm modal (no extra HTML needed).
  const existing = document.getElementById('mv-regen-modal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'mv-regen-modal';
  modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.75); z-index:10000; display:flex; align-items:center; justify-content:center;';
  const isBack = info.viewKey === 'back';
  modal.innerHTML = `
    <div style="background:#1a1a2a; border:1px solid #3a3a4d; border-radius:8px; padding:20px; max-width:480px;">
      <h3 style="margin:0 0 8px; color:#fff;">Regenerate back view?</h3>
      <p style="color:#aaa; margin:0 0 16px; font-size:13px;">
        You edited the <b>${info.viewKey.toUpperCase()}</b> view.
        ${isBack
          ? 'The back is now out of sync with the front photo it was generated from.'
          : 'The back view was generated from the previous front, it may now look inconsistent.'}
      </p>
      <div style="display:flex; gap:8px; justify-content:flex-end;">
        <button id="mv-regen-keep" class="ghost-btn">Keep current</button>
        <button id="mv-regen-do" class="primary-btn">Regenerate back from front</button>
      </div>
      <p style="color:#777; font-size:11px; margin:10px 0 0;">
        Regenerates the back view via RealVis + IPAdapter + ControlNet
        OpenPose using the current front image. Takes ~25 s.
      </p>
    </div>`;
  document.body.appendChild(modal);
  document.getElementById('mv-regen-keep').onclick = () => modal.remove();
  document.getElementById('mv-regen-do').onclick = async () => {
    modal.remove();
    const frontImg = p.previewImagePath || p.selectedImagePath;
    if (!frontImg) {
      showToast('No front image to regenerate from.', 'error');
      return;
    }
    showToast('Regenerating back view...', 'info', 5000);
    try {
      // Optional outfit captioning (same as the auto pipeline)
      let outfitDesc = '';
      try {
        const cap = await window.meshyAPI.captionImage({ imagePath: frontImg });
        if (cap?.success && cap.caption) outfitDesc = cap.caption;
      } catch (_) {}
      const rawPrompt = document.getElementById('ws-prompt')?.dataset.rawPrompt
                        || (p.prompt || '');
      const enrichedHint = outfitDesc ? `${rawPrompt}, ${outfitDesc}` : rawPrompt;
      const r = await window.meshyAPI.generateBackView({
        frontImage: frontImg,
        promptHint: enrichedHint,
        numImages: 1,
      });
      if (r?.success && r.paths?.length) {
        if (!p._backPhotos) p._backPhotos = {};
        p._backPhotos[frontImg] = r.paths[0];
        showToast('Back view regenerated.', 'success');
        await reloadCurrentProject();
      } else {
        showToast('Regeneration failed: ' + (r?.error || 'unknown'), 'error');
      }
    } catch (e) {
      showToast('Regeneration error: ' + e.message, 'error');
    }
  };
}

// Modify image: opens a popup (consistent with Clone Stamp / Draw Mask)
const modifyModal = document.getElementById('modal-modify-image');
const modStrength = document.getElementById('mod-strength');
const modStrengthVal = document.getElementById('mod-strength-val');
modStrength.addEventListener('input', () => { modStrengthVal.textContent = modStrength.value + '%'; });

document.getElementById('ws-modify-btn').addEventListener('click', () => {
  const p = state.currentProject;
  const target = editTarget(p);
  if (!target) { showToast('Pick an image first.', 'error'); return; }
  // Show the source image inside the modal
  const srcImg = document.getElementById('mod-source-img');
  if (srcImg) srcImg.src = 'file:///' + target.replace(/\\/g, '/') + '?t=' + Date.now();
  modifyModal.dataset.targetPath = target;
  modifyModal.classList.remove('hidden');
  setTimeout(() => document.getElementById('mod-prompt').focus(), 50);
});
document.getElementById('mod-cancel').addEventListener('click', () => {
  modifyModal.classList.add('hidden');
});
document.getElementById('mod-apply').addEventListener('click', async () => {
  const p = state.currentProject;
  const target = modifyModal.dataset.targetPath || editTarget(p);
  if (!target) return;
  const prompt = document.getElementById('mod-prompt').value.trim();
  if (!prompt) { showToast('Type a modification first.', 'error'); return; }
  const engine = document.getElementById('mod-engine').value;
  const strength = parseInt(modStrength.value) / 100;
  modifyModal.classList.add('hidden');
  // img2img is fast: ~5s on SDXL Turbo, ~20s on cloud
  const modifyExpected = engine === 'pollinations' ? 30000 : 15000;
  gatedRun('img2img', `Modify image: ${p.name}`, async () => {
    const job = pushJob(`Modify image: ${p.name}`, null, {
      Engine: engineLabel(engine),
      Strength: `${Math.round(strength * 100)}%`,
      Prompt: prompt,
    }, modifyExpected);
    try {
      const r = await API.img2img({ imagePath: target, prompt, strength, engine, jobId: job.id });
      if (r?.success) {
        completeJob(job.id, true);
        await reloadCurrentProject();
      } else {
        completeJob(job.id, false);
        if (!job.cancelled) customError(r?.error || 'unknown', 'Modify failed');
      }
    } catch (e) {
      completeJob(job.id, false);
      if (!job.cancelled) customError(e?.error || e?.message || String(e), 'Modify error');
    }
  });
});

document.getElementById('ws-export-img-btn')?.addEventListener('click', async () => {
  const p = state.currentProject;
  const target = editTarget(p);
  if (!target) { showToast('Pick an image first.', 'error'); return; }
  try {
    const base = (p.name || 'image') + '_' + (target.split(/[\\/]/).pop().replace(/\.[^.]+$/, ''));
    const r = await API.exportImage({ srcPath: target, defaultName: base });
    if (r?.ok) showToast('Image exported: ' + r.path, 'success');
    else if (!r?.cancelled) showToast('Export failed: ' + (r?.error || 'unknown'), 'error');
  } catch (e) {
    showToast('Export error: ' + e.message, 'error');
  }
});

document.getElementById('ws-removebg-btn').addEventListener('click', async () => {
  const p = state.currentProject;
  const target = editTarget(p);
  if (!target) { showToast('Pick an image first.', 'error'); return; }
  gatedRun('bg', `Remove background: ${p.name}`, async () => {
    const job = pushJob(`Remove background: ${p.name}`);
    try {
      const r = await API.removeBackground(target);
      if (r?.success) {
        completeJob(job.id, true);
        await reloadCurrentProject();
      } else {
        completeJob(job.id, false);
        if (!job.cancelled) customError(r?.error || 'unknown', 'Remove BG failed');
      }
    } catch (e) {
      completeJob(job.id, false);
      if (!job.cancelled) customError(e?.error || e?.message || String(e), 'Remove BG error');
    }
  });
});

document.getElementById('ws-clone-btn').addEventListener('click', () => {
  const p = state.currentProject;
  const target = editTarget(p);
  if (!target) { showToast('Pick an image first.', 'error'); return; }
  window.openCloneToolFor(target, p.name, async () => {
    await reloadCurrentProject();
  });
});
document.getElementById('ws-mask-btn').addEventListener('click', () => {
  const p = state.currentProject;
  const target = editTarget(p);
  if (!target) { showToast('Pick an image first.', 'error'); return; }
  window.openMaskToolFor(target, p.name, async () => {
    await reloadCurrentProject();
  });
});

// ----------- New image tools -----------

// Helper: run a quick image edit via Python PIL and reload the project
async function runQuickEdit(operation, params) {
  const p = state.currentProject;
  const target = editTarget(p);
  if (!target) { showToast('Pick an image first.', 'error'); return; }
  showToast(`${operation}...`, 'info', 1500);
  try {
    const r = await API.imageQuickEdit({ imagePath: target, operation, params });
    if (r?.success) {
      showToast(`${operation} done`, 'success');
      await reloadCurrentProject();
    } else {
      showToast(`${operation} failed: ${r?.error || 'unknown'}`, 'error', 5000);
    }
  } catch (e) {
    showToast(`${operation} error: ${e.message}`, 'error', 5000);
  }
}

// ============================================================
// SYMMETRIZE TOOL — interactive modal with draggable/rotatable axis + mask
// ============================================================
const symState = {
  imgPath: null, origData: null, w: 0, h: 0,
  axisX: 0.5,   // normalized X position of axis (0-1)
  axisAngle: 0,  // rotation in radians
  direction: 'lr', // 'lr' = left→right, 'rl' = right→left
  mode: 'full',    // 'full' or 'mask'
  brushSize: 40,
  maskData: null,  // Uint8Array mask (255=symmetrize, 0=keep)
  dragging: false, rotating: false,
  painting: false,
  undoStack: [], redoStack: [],
  zoom: 1, panX: 0, panY: 0, panning: false, panStart: null,
};

function _symUpdateUndoBtns() {
  const u = document.getElementById('sym-undo');
  const r = document.getElementById('sym-redo');
  if (u) u.disabled = symState.undoStack.length === 0;
  if (r) r.disabled = symState.redoStack.length === 0;
}

function _symApplyView() {
  const canvas = document.getElementById('sym-canvas');
  const overlay = document.getElementById('sym-overlay');
  const container = document.getElementById('sym-canvas-container');
  if (!canvas || !overlay || !container) return;
  const cw = container.clientWidth, ch = container.clientHeight;
  const baseScale = Math.min(cw / symState.w, ch / symState.h, 1);
  const totalScale = baseScale * symState.zoom;
  const dw = Math.round(symState.w * totalScale), dh = Math.round(symState.h * totalScale);
  const left = Math.round((cw - dw) / 2 + symState.panX);
  const top = Math.round((ch - dh) / 2 + symState.panY);
  canvas.style.width = dw + 'px'; canvas.style.height = dh + 'px';
  overlay.style.width = dw + 'px'; overlay.style.height = dh + 'px';
  canvas.style.left = left + 'px'; canvas.style.top = top + 'px';
  overlay.style.left = left + 'px'; overlay.style.top = top + 'px';
}

// Zoom + pan for Symmetrize
(() => {
  const container = document.getElementById('sym-canvas-container');
  if (!container) return;
  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    symState.zoom = Math.max(0.2, Math.min(10, symState.zoom * factor));
    _symApplyView();
  }, { passive: false });
  container.addEventListener('mousedown', (e) => {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      symState.panning = true;
      symState.panStart = { x: e.clientX - symState.panX, y: e.clientY - symState.panY };
      container.style.cursor = 'grabbing';
      e.preventDefault();
    }
  });
  window.addEventListener('mousemove', (e) => {
    if (symState.panning && symState.panStart) {
      symState.panX = e.clientX - symState.panStart.x;
      symState.panY = e.clientY - symState.panStart.y;
      _symApplyView();
    }
  });
  window.addEventListener('mouseup', () => {
    if (symState.panning) {
      symState.panning = false;
      symState.panStart = null;
      const c = document.getElementById('sym-canvas-container');
      if (c) c.style.cursor = '';
    }
  });
})();

function openSymmetrize() {
  const p = state.currentProject;
  const target = editTarget(p);
  if (!target) { showToast('Pick an image first.', 'error'); return; }
  symState.imgPath = target;
  const modal = document.getElementById('modal-symmetrize');
  const canvas = document.getElementById('sym-canvas');
  const overlay = document.getElementById('sym-overlay');
  if (!modal || !canvas || !overlay) return;
  const ctx = canvas.getContext('2d');
  const octx = overlay.getContext('2d');
  modal.classList.remove('hidden');
  const img = new Image();
  img.onload = () => {
    canvas.width = img.width; canvas.height = img.height;
    overlay.width = img.width; overlay.height = img.height;
    ctx.drawImage(img, 0, 0);
    symState.w = img.width; symState.h = img.height;
    symState.zoom = 1; symState.panX = 0; symState.panY = 0;
    _symApplyView();
    symState.origData = ctx.getImageData(0, 0, img.width, img.height);
    symState.axisX = 0.5; symState.axisAngle = 0;
    symState.maskData = new Uint8Array(img.width * img.height);
    symState.undoStack = [];
    _symDrawPreview();
  };
  img.src = 'file:///' + symState.imgPath.replace(/\\/g, '/') + '?t=' + Date.now();
}

function _symDrawPreview() {
  const canvas = document.getElementById('sym-canvas');
  const overlay = document.getElementById('sym-overlay');
  if (!canvas || !overlay || !symState.origData) return;
  const ctx = canvas.getContext('2d');
  const octx = overlay.getContext('2d');
  const w = symState.w, h = symState.h;
  const orig = symState.origData;

  // Draw symmetrized image — mirror across rotated axis line
  const result = ctx.createImageData(w, h);
  result.data.set(orig.data);
  const ax = symState.axisX * w;       // axis point X
  const ay = h / 2;                     // axis point Y (center)
  const angle = symState.axisAngle;
  // Direction vector of the axis line (from the drawing code)
  const dx = Math.sin(angle);
  const dy = Math.cos(angle);
  const dLen2 = dx * dx + dy * dy; // always 1 for unit vector, but keep for clarity
  // Normal to the axis (points to the "right" side)
  const nx = dy, ny = -dx;
  const useMask = symState.mode === 'mask';

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      // Signed distance from axis: positive = right side, negative = left side
      const side = (x - ax) * nx + (y - ay) * ny;

      if (useMask) {
        if (symState.maskData[y * w + x] === 0) continue;
      } else {
        // In full mode: only replace destination side
        if (symState.direction === 'lr' && side <= 0) continue;
        if (symState.direction === 'rl' && side >= 0) continue;
      }
      // Reflect (x,y) across the axis line
      const t = ((x - ax) * dx + (y - ay) * dy) / dLen2;
      const srcX = Math.round(2 * (ax + t * dx) - x);
      const srcY = Math.round(2 * (ay + t * dy) - y);
      if (srcX < 0 || srcX >= w || srcY < 0 || srcY >= h) continue;
      const srcIdx = (srcY * w + srcX) * 4;
      result.data[idx] = orig.data[srcIdx];
      result.data[idx+1] = orig.data[srcIdx+1];
      result.data[idx+2] = orig.data[srcIdx+2];
      result.data[idx+3] = orig.data[srcIdx+3];
    }
  }
  ctx.putImageData(result, 0, 0);

  // Draw axis line + mask overlay
  octx.clearRect(0, 0, w, h);
  // Draw mask overlay (red semi-transparent, like Draw Mask tool)
  if (useMask) {
    const maskImg = octx.createImageData(w, h);
    for (let i = 0; i < symState.maskData.length; i++) {
      if (symState.maskData[i] > 0) {
        maskImg.data[i*4] = 255;
        maskImg.data[i*4+1] = 50;
        maskImg.data[i*4+2] = 50;
        maskImg.data[i*4+3] = 100;
      }
    }
    octx.putImageData(maskImg, 0, 0);
  }
  // Draw axis line
  octx.save();
  octx.strokeStyle = '#22c55e';
  octx.lineWidth = 3;
  octx.setLineDash([8, 4]);
  octx.beginPath();
  // Rotated line (ax, ay already defined above)
  const cos = Math.cos(symState.axisAngle);
  const sin = Math.sin(symState.axisAngle);
  const len = Math.max(w, h);
  octx.moveTo(ax - sin * len, -cos * len + ay);
  octx.lineTo(ax + sin * len, cos * len + ay);
  octx.stroke();
  // Draw axis handle (circle at center)
  octx.beginPath();
  octx.arc(ax, ay, 8, 0, Math.PI * 2);
  octx.fillStyle = 'rgba(34,197,94,0.5)';
  octx.fill();
  octx.strokeStyle = '#22c55e';
  octx.setLineDash([]);
  octx.lineWidth = 2;
  octx.stroke();
  octx.restore();
}

// Auto symmetrize (1-click, mirrors left→right at center)
document.getElementById('ws-symmetrize-auto-btn')?.addEventListener('click', () => runQuickEdit('symmetrize'));
// Manual symmetrize (opens interactive modal)
document.getElementById('ws-symmetrize-btn')?.addEventListener('click', openSymmetrize);

// Symmetrize: direction buttons
document.getElementById('sym-dir-lr')?.addEventListener('click', () => {
  symState.direction = 'lr';
  document.getElementById('sym-dir-lr')?.classList.add('tool-active');
  document.getElementById('sym-dir-rl')?.classList.remove('tool-active');
  _symDrawPreview();
});
document.getElementById('sym-dir-rl')?.addEventListener('click', () => {
  symState.direction = 'rl';
  document.getElementById('sym-dir-rl')?.classList.add('tool-active');
  document.getElementById('sym-dir-lr')?.classList.remove('tool-active');
  _symDrawPreview();
});

// Symmetrize: mode buttons
document.getElementById('sym-mode-full')?.addEventListener('click', () => {
  symState.mode = 'full';
  document.getElementById('sym-mode-full')?.classList.add('tool-active');
  document.getElementById('sym-mode-mask')?.classList.remove('tool-active');
  document.getElementById('sym-brush-label').style.display = 'none';
  _symDrawPreview();
});
document.getElementById('sym-mode-mask')?.addEventListener('click', () => {
  symState.mode = 'mask';
  document.getElementById('sym-mode-mask')?.classList.add('tool-active');
  document.getElementById('sym-mode-full')?.classList.remove('tool-active');
  document.getElementById('sym-brush-label').style.display = 'flex';
  _symDrawPreview();
});

// Brush size slider
document.getElementById('sym-brush-size')?.addEventListener('input', (e) => {
  symState.brushSize = parseInt(e.target.value);
  document.getElementById('sym-brush-val').textContent = e.target.value;
});

// Canvas interactions: drag axis, shift+drag rotate, paint mask
const _symOverlay = document.getElementById('sym-overlay');
if (_symOverlay) {
  function _symCanvasCoords(e) {
    const rect = _symOverlay.getBoundingClientRect();
    const sx = symState.w / rect.width;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sx };
  }

  _symOverlay.addEventListener('mousedown', (e) => {
    const p = _symCanvasCoords(e);
    const axPx = symState.axisX * symState.w;
    if (e.shiftKey) {
      // Shift+drag = rotate axis (works in both modes)
      symState.rotating = true;
    } else if (e.ctrlKey || e.metaKey) {
      // Ctrl+drag = move axis (works in both modes)
      symState.dragging = true;
    } else if (symState.mode === 'full' && Math.abs(p.x - axPx) < 20) {
      // Near axis in full mode = drag axis
      symState.dragging = true;
    } else if (symState.mode === 'mask') {
      // Save undo before painting
      symState.undoStack.push(new Uint8Array(symState.maskData));
      if (symState.undoStack.length > 20) symState.undoStack.shift();
      symState.redoStack = [];
      _symUpdateUndoBtns();
      symState.painting = true;
      _symPaintMask(p.x, p.y);
      _symDrawPreview();
    }
  });

  _symOverlay.addEventListener('mousemove', (e) => {
    const p = _symCanvasCoords(e);
    if (symState.dragging) {
      symState.axisX = Math.max(0.05, Math.min(0.95, p.x / symState.w));
      _symDrawPreview();
    } else if (symState.rotating) {
      const cy = symState.h / 2;
      const ax = symState.axisX * symState.w;
      symState.axisAngle = Math.atan2(p.x - ax, p.y - cy);
      _symDrawPreview();
    } else if (symState.painting) {
      _symPaintMask(p.x, p.y);
      _symDrawPreview();
    }
    // Brush cursor for mask mode
    const symCur = document.getElementById('sym-brush-cursor');
    if (symState.mode === 'mask' && symCur) {
      const rect = _symOverlay.getBoundingClientRect();
      const scaleX = rect.width / symState.w;
      const displaySize = Math.max(4, symState.brushSize * scaleX);
      symCur.style.width = displaySize + 'px';
      symCur.style.height = displaySize + 'px';
      symCur.style.left = (e.clientX - displaySize / 2) + 'px';
      symCur.style.top = (e.clientY - displaySize / 2) + 'px';
      symCur.style.display = 'block';
      _symOverlay.style.cursor = 'none';
    } else {
      if (symCur) symCur.style.display = 'none';
      const axPx = symState.axisX * symState.w;
      _symOverlay.style.cursor = Math.abs(p.x - axPx) < 20 ? 'ew-resize' : 'default';
    }
    // Loupe (inline — Symmetrize doesn't use CanvasManager yet)
    _symUpdateLoupe(e);
  });

  _symOverlay.addEventListener('mouseleave', () => {
    const cur = document.getElementById('sym-brush-cursor');
    if (cur) cur.style.display = 'none';
  });

  window.addEventListener('mouseup', () => {
    symState.dragging = false;
    symState.rotating = false;
    symState.painting = false;
  });
}

function _symPaintMask(cx, cy) {
  const r = symState.brushSize / 2;
  const w = symState.w, h = symState.h;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx*dx + dy*dy > r*r) continue;
      const px = Math.round(cx + dx), py = Math.round(cy + dy);
      if (px >= 0 && px < w && py >= 0 && py < h) {
        symState.maskData[py * w + px] = 255;
      }
    }
  }
}

// Sym loupe state + toggle
let _symLoupeEnabled = true;
function _symUpdateLoupe(e) {
  const loupeEl = document.getElementById('clone-loupe');
  if (!_symLoupeEnabled || !loupeEl) { if (loupeEl) loupeEl.style.display = 'none'; return; }
  const loupeCanvas = document.getElementById('clone-loupe-canvas');
  if (!loupeCanvas) return;
  const lCtx = loupeCanvas.getContext('2d');
  const canvas = document.getElementById('sym-canvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const sx = symState.w / rect.width;
  const cx = Math.round((e.clientX - rect.left) * sx);
  const cy = Math.round((e.clientY - rect.top) * sx);
  const srcSize = Math.max(8, 20);
  lCtx.clearRect(0, 0, 120, 120);
  lCtx.save();
  lCtx.beginPath(); lCtx.arc(60, 60, 58, 0, Math.PI * 2); lCtx.clip();
  lCtx.drawImage(canvas, cx - srcSize, cy - srcSize, srcSize * 2, srcSize * 2, 0, 0, 120, 120);
  lCtx.strokeStyle = 'rgba(255,255,255,0.6)'; lCtx.lineWidth = 1;
  lCtx.beginPath(); lCtx.moveTo(60, 50); lCtx.lineTo(60, 70); lCtx.moveTo(50, 60); lCtx.lineTo(70, 60); lCtx.stroke();
  lCtx.restore();
  const cRect = canvas.parentElement.getBoundingClientRect();
  let lx = e.clientX + 20, ly = e.clientY - 140;
  if (lx + 120 > cRect.right) lx = e.clientX - 140;
  if (ly < cRect.top) ly = e.clientY + 20;
  if (lx < cRect.left) lx = cRect.left + 4;
  if (ly + 120 > cRect.bottom) ly = cRect.bottom - 124;
  loupeEl.style.left = lx + 'px'; loupeEl.style.top = ly + 'px'; loupeEl.style.display = 'block';
}
document.getElementById('sym-loupe-toggle')?.addEventListener('click', () => {
  _symLoupeEnabled = !_symLoupeEnabled;
  const btn = document.getElementById('sym-loupe-toggle');
  if (btn) btn.classList.toggle('tool-active', _symLoupeEnabled);
  if (!_symLoupeEnabled) { const l = document.getElementById('clone-loupe'); if (l) l.style.display = 'none'; }
});
// Set loupe button active by default
(() => { const b = document.getElementById('sym-loupe-toggle'); if (b) b.classList.add('tool-active'); })();

// Undo / Redo / Reset
document.getElementById('sym-undo')?.addEventListener('click', () => {
  if (symState.undoStack.length > 0) {
    symState.redoStack.push(new Uint8Array(symState.maskData));
    symState.maskData = symState.undoStack.pop();
    _symUpdateUndoBtns();
    _symDrawPreview();
  }
});
document.getElementById('sym-redo')?.addEventListener('click', () => {
  if (symState.redoStack.length > 0) {
    symState.undoStack.push(new Uint8Array(symState.maskData));
    symState.maskData = symState.redoStack.pop();
    _symUpdateUndoBtns();
    _symDrawPreview();
  }
});
document.getElementById('sym-reset')?.addEventListener('click', () => {
  symState.maskData = new Uint8Array(symState.w * symState.h);
  symState.axisX = 0.5;
  symState.axisAngle = 0;
  symState.undoStack = [];
  symState.redoStack = [];
  _symUpdateUndoBtns();
  _symDrawPreview();
});

// Close / Cancel
function _closeSym() {
  document.getElementById('modal-symmetrize')?.classList.add('hidden');
  const l = document.getElementById('clone-loupe'); if (l) l.style.display = 'none';
}
document.getElementById('sym-close')?.addEventListener('click', _closeSym);
document.getElementById('sym-cancel')?.addEventListener('click', _closeSym);

// Keyboard: Ctrl+Z undo, Ctrl+Y redo, Esc close
document.addEventListener('keydown', (e) => {
  const modal = document.getElementById('modal-symmetrize');
  if (!modal || modal.classList.contains('hidden')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    document.getElementById('sym-undo')?.click();
  } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
    e.preventDefault();
    document.getElementById('sym-redo')?.click();
  } else if (e.key === 'Escape') {
    _closeSym();
  }
});

// Apply: save the symmetrized image as a new version
document.getElementById('sym-apply')?.addEventListener('click', async () => {
  const canvas = document.getElementById('sym-canvas');
  if (!canvas || !symState.imgPath) return;
  document.getElementById('modal-symmetrize')?.classList.add('hidden');
  showToast('Saving symmetrized version...', 'info', 1500);
  try {
    const dataUrl = canvas.toDataURL('image/png');
    const r = await API.saveImageDataUrl({
      imagePath: symState.imgPath,
      dataUrl: dataUrl,
      suffix: 'symmetrized',
    });
    if (r?.success) {
      showToast('Symmetrized!', 'success');
      await reloadCurrentProject();
    } else {
      showToast('Save failed: ' + (r?.error || ''), 'error');
    }
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
});
// Resolution modal
let _resW = 0, _resH = 0;
function openResolutionModal() {
  const p = state.currentProject;
  const tgt = editTarget(p);
  if (!tgt) { showToast('Pick an image first.', 'error'); return; }
  const modal = document.getElementById('modal-resolution');
  const preview = document.getElementById('res-preview');
  const current = document.getElementById('res-current');
  const target = document.getElementById('res-target');
  if (!modal) return;
  preview.src = 'file:///' + tgt.replace(/\\/g, '/') + '?t=' + Date.now();
  const img = new Image();
  img.onload = () => {
    _resW = img.naturalWidth; _resH = img.naturalHeight;
    current.textContent = `${_resW} x ${_resH}`;
    target.textContent = '';
    modal.classList.remove('hidden');
  };
  img.onerror = () => { showToast('Cannot load image', 'error'); };
  img.src = preview.src;
}
document.getElementById('ws-resolution-btn')?.addEventListener('click', openResolutionModal);
document.getElementById('res-close')?.addEventListener('click', () => {
  document.getElementById('modal-resolution')?.classList.add('hidden');
});
document.getElementById('modal-resolution')?.addEventListener('click', (e) => {
  if (e.target.id === 'modal-resolution') document.getElementById('modal-resolution')?.classList.add('hidden');
});
document.getElementById('res-upscale')?.addEventListener('click', async () => {
  document.getElementById('modal-resolution')?.classList.add('hidden');
  showToast(`Upscaling ${_resW}x${_resH} -> ${_resW*2}x${_resH*2}...`, 'info', 2000);
  await runQuickEdit('upscale');
});
document.getElementById('res-downscale')?.addEventListener('click', async () => {
  document.getElementById('modal-resolution')?.classList.add('hidden');
  const nw = Math.round(_resW / 2), nh = Math.round(_resH / 2);
  showToast(`Downscaling ${_resW}x${_resH} -> ${nw}x${nh}...`, 'info', 2000);
  const p = state.currentProject;
  const tgt = editTarget(p);
  if (!tgt) return;
  try {
    const r = await API.imageQuickEdit({ imagePath: tgt, operation: 'downscale', params: {} });
    if (r?.success) { showToast('Downscale done', 'success'); await reloadCurrentProject(); }
    else showToast('Downscale failed: ' + (r?.error || ''), 'error');
  } catch (e) { showToast('Downscale error: ' + e.message, 'error'); }
});
function _showResTarget(nw, nh, up) {
  const arrow = document.getElementById('res-arrow');
  const target = document.getElementById('res-target');
  if (arrow) { arrow.textContent = '→'; arrow.style.color = up ? '#22c55e' : '#ef4444'; arrow.style.display = ''; }
  if (target) { target.textContent = `${nw} x ${nh}`; target.style.color = up ? '#22c55e' : '#ef4444'; target.style.display = ''; }
}
function _hideResTarget() {
  const arrow = document.getElementById('res-arrow');
  const target = document.getElementById('res-target');
  if (arrow) arrow.style.display = 'none';
  if (target) target.style.display = 'none';
}
document.getElementById('res-upscale')?.addEventListener('mouseenter', () => _showResTarget(_resW*2, _resH*2, true));
document.getElementById('res-downscale')?.addEventListener('mouseenter', () => _showResTarget(Math.round(_resW/2), Math.round(_resH/2), false));
document.querySelectorAll('#res-upscale, #res-downscale').forEach(el => el.addEventListener('mouseleave', _hideResTarget));
// ============================================================
// BRIGHTNESS / CONTRAST MODAL
// ============================================================
document.getElementById('ws-brightness-btn')?.addEventListener('click', () => {
  const p = state.currentProject;
  const tgt = editTarget(p);
  if (!tgt) { showToast('Pick an image first.', 'error'); return; }
  const modal = document.getElementById('modal-brightness');
  const preview = document.getElementById('bright-preview');
  if (!modal || !preview) return;
  modal.dataset.targetPath = tgt;
  preview.src = 'file:///' + tgt.replace(/\\/g, '/') + '?t=' + Date.now();
  // Reset sliders
  ['brightness', 'contrast', 'saturation', 'sharpness'].forEach(k => {
    const sl = document.getElementById('bright-' + k);
    const val = document.getElementById('bright-' + k + '-val');
    if (sl) sl.value = '100';
    if (val) val.textContent = '100%';
  });
  // Live preview via CSS filter
  const updatePreview = () => {
    const b = document.getElementById('bright-brightness').value / 100;
    const c = document.getElementById('bright-contrast').value / 100;
    const s = document.getElementById('bright-saturation').value / 100;
    preview.style.filter = `brightness(${b}) contrast(${c}) saturate(${s})`;
    document.getElementById('bright-brightness-val').textContent = document.getElementById('bright-brightness').value + '%';
    document.getElementById('bright-contrast-val').textContent = document.getElementById('bright-contrast').value + '%';
    document.getElementById('bright-saturation-val').textContent = document.getElementById('bright-saturation').value + '%';
    document.getElementById('bright-sharpness-val').textContent = document.getElementById('bright-sharpness').value + '%';
  };
  ['brightness', 'contrast', 'saturation', 'sharpness'].forEach(k => {
    document.getElementById('bright-' + k)?.addEventListener('input', updatePreview);
  });
  modal.classList.remove('hidden');
});
document.getElementById('bright-reset')?.addEventListener('click', () => {
  ['brightness', 'contrast', 'saturation', 'sharpness'].forEach(k => {
    const sl = document.getElementById('bright-' + k);
    const val = document.getElementById('bright-' + k + '-val');
    if (sl) sl.value = '100';
    if (val) val.textContent = '100%';
  });
  const preview = document.getElementById('bright-preview');
  if (preview) preview.style.filter = '';
});
document.getElementById('bright-cancel')?.addEventListener('click', () => {
  document.getElementById('modal-brightness')?.classList.add('hidden');
});
document.getElementById('bright-close-x')?.addEventListener('click', () => {
  document.getElementById('modal-brightness')?.classList.add('hidden');
});
document.getElementById('bright-apply')?.addEventListener('click', async () => {
  document.getElementById('modal-brightness')?.classList.add('hidden');
  const b = document.getElementById('bright-brightness').value / 100;
  const c = document.getElementById('bright-contrast').value / 100;
  const s = document.getElementById('bright-saturation').value / 100;
  const sh = document.getElementById('bright-sharpness').value / 100;
  await runQuickEdit('brightness', { brightness: b, contrast: c, saturation: s, sharpness: sh });
});
document.getElementById('ws-facefix-btn')?.addEventListener('click', () => runQuickEdit('facefix'));
document.getElementById('ws-extend-btn')?.addEventListener('click', () => runQuickEdit('extend', { padding: 0.15 }));
// ============================================================
// CROP TOOL — interactive modal with drag selection + presets
// ============================================================
const cropState = { x1: 0, y1: 0, x2: 1, y2: 1, dragging: false, aspect: null, w: 0, h: 0, imgPath: null };

document.getElementById('ws-crop-btn')?.addEventListener('click', () => {
  const p = state.currentProject;
  const tgt = editTarget(p);
  if (!tgt) { showToast('Pick an image first.', 'error'); return; }
  cropState.imgPath = tgt;
  const modal = document.getElementById('modal-crop');
  const canvas = document.getElementById('crop-canvas');
  const overlay = document.getElementById('crop-overlay');
  if (!modal || !canvas || !overlay) return;
  const ctx = canvas.getContext('2d');
  // Show modal FIRST so container has real dimensions for centering
  modal.classList.remove('hidden');
  const img = new Image();
  img.onload = () => {
    const container = document.getElementById('crop-canvas-container');
    const cw = container.clientWidth || 800;
    const ch = container.clientHeight || 600;
    const scale = Math.min(cw / img.width, ch / img.height, 1);
    const dw = Math.round(img.width * scale), dh = Math.round(img.height * scale);
    canvas.width = img.width; canvas.height = img.height;
    overlay.width = img.width; overlay.height = img.height;
    canvas.style.width = dw + 'px'; canvas.style.height = dh + 'px';
    overlay.style.width = dw + 'px'; overlay.style.height = dh + 'px';
    const left = Math.round((cw - dw) / 2), top = Math.round((ch - dh) / 2);
    canvas.style.left = left + 'px'; canvas.style.top = top + 'px';
    overlay.style.left = left + 'px'; overlay.style.top = top + 'px';
    ctx.drawImage(img, 0, 0);
    cropState.w = img.width; cropState.h = img.height;
    cropState.x1 = 0.1; cropState.y1 = 0.1; cropState.x2 = 0.9; cropState.y2 = 0.9;
    cropState.aspect = null;
    _cropDrawOverlay();
    _cropUpdateLabel();
    // Reset preset buttons
    document.querySelectorAll('[id^="crop-preset-"]').forEach(b => b.classList.remove('tool-active'));
    document.getElementById('crop-preset-free')?.classList.add('tool-active');
  };
  img.src = 'file:///' + cropState.imgPath.replace(/\\/g, '/') + '?t=' + Date.now();
});

function _cropDrawOverlay() {
  const overlay = document.getElementById('crop-overlay');
  if (!overlay) return;
  const ctx = overlay.getContext('2d');
  const w = cropState.w, h = cropState.h;
  ctx.clearRect(0, 0, w, h);
  // Darken outside crop area
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, 0, w, h);
  // Clear the crop area (transparent)
  const cx1 = Math.round(cropState.x1 * w), cy1 = Math.round(cropState.y1 * h);
  const cx2 = Math.round(cropState.x2 * w), cy2 = Math.round(cropState.y2 * h);
  ctx.clearRect(cx1, cy1, cx2 - cx1, cy2 - cy1);
  // Draw crop border
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 3]);
  ctx.strokeRect(cx1, cy1, cx2 - cx1, cy2 - cy1);
  // Rule of thirds grid
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  const cw = cx2 - cx1, ch2 = cy2 - cy1;
  for (let i = 1; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(cx1 + cw * i / 3, cy1); ctx.lineTo(cx1 + cw * i / 3, cy2);
    ctx.moveTo(cx1, cy1 + ch2 * i / 3); ctx.lineTo(cx2, cy1 + ch2 * i / 3);
    ctx.stroke();
  }
  // Corner handles
  ctx.fillStyle = '#22c55e';
  const hs = 6;
  [[cx1,cy1],[cx2,cy1],[cx1,cy2],[cx2,cy2]].forEach(([x,y]) => {
    ctx.fillRect(x - hs/2, y - hs/2, hs, hs);
  });
}

function _cropUpdateLabel() {
  const label = document.getElementById('crop-size-label');
  if (!label) return;
  const cw = Math.round((cropState.x2 - cropState.x1) * cropState.w);
  const ch = Math.round((cropState.y2 - cropState.y1) * cropState.h);
  label.textContent = `${cw} x ${ch} px`;
}

// Overlay mouse interactions
(() => {
  const ov = document.getElementById('crop-overlay');
  if (!ov) return;
  function _coords(e) {
    const rect = ov.getBoundingClientRect();
    const sx = cropState.w / rect.width;
    return { x: (e.clientX - rect.left) * sx / cropState.w, y: (e.clientY - rect.top) * sx / cropState.h };
  }
  ov.addEventListener('mousedown', (e) => {
    const p = _coords(e);
    cropState.x1 = p.x; cropState.y1 = p.y;
    cropState.x2 = p.x; cropState.y2 = p.y;
    cropState.dragging = true;
  });
  ov.addEventListener('mousemove', (e) => {
    if (!cropState.dragging) return;
    const p = _coords(e);
    cropState.x2 = Math.max(0, Math.min(1, p.x));
    cropState.y2 = Math.max(0, Math.min(1, p.y));
    // Enforce aspect ratio if set
    if (cropState.aspect) {
      const dw = Math.abs(cropState.x2 - cropState.x1);
      const dh = dw / cropState.aspect * (cropState.w / cropState.h);
      cropState.y2 = cropState.y1 + (cropState.y2 > cropState.y1 ? dh : -dh);
    }
    _cropDrawOverlay();
    _cropUpdateLabel();
  });
  window.addEventListener('mouseup', () => {
    if (!cropState.dragging) return;
    cropState.dragging = false;
    // Normalize so x1<x2, y1<y2
    if (cropState.x1 > cropState.x2) { const t = cropState.x1; cropState.x1 = cropState.x2; cropState.x2 = t; }
    if (cropState.y1 > cropState.y2) { const t = cropState.y1; cropState.y1 = cropState.y2; cropState.y2 = t; }
    _cropDrawOverlay();
    _cropUpdateLabel();
  });
})();

// Presets
function _cropSetPreset(aspect, id) {
  document.querySelectorAll('[id^="crop-preset-"]').forEach(b => b.classList.remove('tool-active'));
  document.getElementById(id)?.classList.add('tool-active');
  cropState.aspect = aspect;
  if (aspect === 'center') {
    // Auto-center: crop 10% from each edge
    cropState.x1 = 0.1; cropState.y1 = 0.1; cropState.x2 = 0.9; cropState.y2 = 0.9;
    cropState.aspect = null;
    _cropDrawOverlay(); _cropUpdateLabel();
  }
}
document.getElementById('crop-preset-free')?.addEventListener('click', () => _cropSetPreset(null, 'crop-preset-free'));
document.getElementById('crop-preset-1-1')?.addEventListener('click', () => _cropSetPreset(1, 'crop-preset-1-1'));
document.getElementById('crop-preset-4-3')?.addEventListener('click', () => _cropSetPreset(4/3, 'crop-preset-4-3'));
document.getElementById('crop-preset-16-9')?.addEventListener('click', () => _cropSetPreset(16/9, 'crop-preset-16-9'));
document.getElementById('crop-preset-center')?.addEventListener('click', () => _cropSetPreset('center', 'crop-preset-center'));

// Close / Cancel
document.getElementById('crop-close-x')?.addEventListener('click', () => document.getElementById('modal-crop')?.classList.add('hidden'));
document.getElementById('crop-cancel')?.addEventListener('click', () => document.getElementById('modal-crop')?.classList.add('hidden'));

// Apply crop
document.getElementById('crop-apply')?.addEventListener('click', async () => {
  document.getElementById('modal-crop')?.classList.add('hidden');
  // Normalize
  const left = Math.min(cropState.x1, cropState.x2);
  const top = Math.min(cropState.y1, cropState.y2);
  const right = Math.max(cropState.x1, cropState.x2);
  const bottom = Math.max(cropState.y1, cropState.y2);
  if (right - left < 0.05 || bottom - top < 0.05) {
    showToast('Crop area too small.', 'error');
    return;
  }
  await runQuickEdit('crop', { left, top, right, bottom });
});

// Per-image style memory (stored in localStorage as a JSON map path→styleValue)
function _saveImageStyle(imgPath, styleValue) {
  if (!imgPath || !styleValue) return;
  try {
    const key = 'fabmesh-image-styles';
    const map = JSON.parse(localStorage.getItem(key) || '{}');
    // Use just the filename as key (paths change between machines)
    const fname = imgPath.split(/[/\\]/).pop();
    map[fname] = styleValue;
    // Keep only last 500 entries to avoid bloat
    const keys = Object.keys(map);
    if (keys.length > 500) { for (let i = 0; i < keys.length - 500; i++) delete map[keys[i]]; }
    localStorage.setItem(key, JSON.stringify(map));
  } catch(_) {}
}
function _getImageStyle(imgPath) {
  if (!imgPath) return null;
  try {
    const key = 'fabmesh-image-styles';
    const map = JSON.parse(localStorage.getItem(key) || '{}');
    const fname = imgPath.split(/[/\\]/).pop();
    return map[fname] || null;
  } catch(_) { return null; }
}
function _restoreStyleDropdown(imgPath) {
  const label = document.getElementById('ws-style-label');
  if (!label) return;
  const saved = _getImageStyle(imgPath);
  const menu = document.getElementById('ws-style-menu');
  if (saved && menu) {
    const opt = menu.querySelector(`.style-option[data-value="${saved.replace(/"/g, '\\"')}"]`);
    if (opt) { label.innerHTML = '&#127912; ' + opt.textContent; return; }
  }
  label.innerHTML = '&#127912; Style...';
}

// Custom style dropdown: toggle menu on button click
document.getElementById('ws-style-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('ws-style-menu')?.classList.toggle('hidden');
});
// Close the menu on outside click
document.addEventListener('click', (e) => {
  const menu = document.getElementById('ws-style-menu');
  if (!menu || menu.classList.contains('hidden')) return;
  if (!menu.contains(e.target) && e.target.id !== 'ws-style-btn') {
    menu.classList.add('hidden');
  }
});
// Option click → apply style (same pipeline as the old <select> change)
document.getElementById('ws-style-menu')?.addEventListener('click', async (e) => {
  const opt = e.target.closest('.style-option');
  if (!opt) return;
  e.stopPropagation();
  document.getElementById('ws-style-menu').classList.add('hidden');
  const style = opt.dataset.value;
  const label = document.getElementById('ws-style-label');
  if (label) label.innerHTML = '&#127912; ' + opt.textContent;
  if (!style) return;
  // Save last used style so it persists across reloads
  try { localStorage.setItem('fabmesh-last-style', style); } catch(_) {}
  const p = state.currentProject;
  const tgt = editTarget(p);
  if (!tgt) { showToast('Pick an image first.', 'error'); return; }
  showToast(`Applying style: ${style.split(',')[0]}...`, 'info', 2000);
  gatedRun('img2img', `Style: ${style.split(',')[0]}`, async () => {
    const job = pushJob(`Style Transfer: ${p.name}`, null, { Style: style.split(',')[0] }, 30000);
    try {
      const r = await API.img2img({ imagePath: tgt, prompt: style, strength: 0.6, engine: 'local-sdxl' });
      if (r?.success) {
        // Remember which style was applied to this new image version
        if (r.newPath) _saveImageStyle(r.newPath, style);
        // Also tag the source image with its style (it was the input)
        _saveImageStyle(tgt, style);
        completeJob(job.id, true);
        await reloadCurrentProject();
        showToast('Style applied!', 'success');
      } else {
        completeJob(job.id, false, r?.error);
        showToast('Style transfer failed: ' + (r?.error || 'unknown'), 'error');
      }
    } catch (err) {
      completeJob(job.id, false, err?.message);
      showToast('Style transfer error: ' + (err?.message || err), 'error');
    }
  });
});

// ============================================================
// COLOR PICKER MODAL
// ============================================================
document.getElementById('ws-picker-btn')?.addEventListener('click', () => {
  const p = state.currentProject;
  const tgt = editTarget(p);
  if (!tgt) { showToast('Pick an image first.', 'error'); return; }
  const modal = document.getElementById('modal-colorpick');
  const canvas = document.getElementById('cpick-canvas');
  if (!modal || !canvas) return;
  const ctx = canvas.getContext('2d');
  modal.classList.remove('hidden');
  const img = new Image();
  img.onload = () => {
    canvas.width = img.width; canvas.height = img.height;
    ctx.drawImage(img, 0, 0);
    // Center canvas in container
    const container = document.getElementById('cpick-canvas-container');
    const cw = container.clientWidth || 800;
    const ch = container.clientHeight || 600;
    const scale = Math.min(cw / img.width, ch / img.height, 1);
    const dw = Math.round(img.width * scale), dh = Math.round(img.height * scale);
    canvas.style.width = dw + 'px'; canvas.style.height = dh + 'px';
    canvas.style.left = Math.round((cw - dw) / 2) + 'px';
    canvas.style.top = Math.round((ch - dh) / 2) + 'px';
    document.getElementById('cpick-swatch').style.background = '#000';
    document.getElementById('cpick-hex').textContent = '';
    document.getElementById('cpick-rgb').textContent = 'Move cursor over image';
  };
  img.src = 'file:///' + tgt.replace(/\\/g, '/') + '?t=' + Date.now();
});
(() => {
  const cpCanvas = document.getElementById('cpick-canvas');
  if (!cpCanvas) return;
  function _cpSample(e) {
    const rect = cpCanvas.getBoundingClientRect();
    const sx = cpCanvas.width / rect.width;
    const x = Math.max(0, Math.min(Math.round((e.clientX - rect.left) * sx), cpCanvas.width - 1));
    const y = Math.max(0, Math.min(Math.round((e.clientY - rect.top) * sx), cpCanvas.height - 1));
    const ctx = cpCanvas.getContext('2d');
    const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
    const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
    document.getElementById('cpick-swatch').style.background = hex;
    document.getElementById('cpick-hex').textContent = hex;
    document.getElementById('cpick-rgb').textContent = `rgb(${r}, ${g}, ${b})`;
    const cur = document.getElementById('cpick-cursor');
    if (cur) { cur.style.left = (e.clientX - rect.left) + 'px'; cur.style.top = (e.clientY - rect.top) + 'px'; cur.style.display = 'block'; }
    return hex;
  }
  cpCanvas.addEventListener('mousemove', _cpSample);
  cpCanvas.addEventListener('click', (e) => {
    const hex = _cpSample(e);
    navigator.clipboard.writeText(hex).catch(() => {});
    showToast(hex + ' copied!', 'success', 1500);
  });
})();
document.getElementById('cpick-copy')?.addEventListener('click', () => {
  const hex = document.getElementById('cpick-hex')?.textContent;
  if (hex) { navigator.clipboard.writeText(hex).catch(() => {}); showToast(hex + ' copied!', 'success', 1500); }
});
document.getElementById('cpick-close')?.addEventListener('click', () => document.getElementById('modal-colorpick')?.classList.add('hidden'));
document.getElementById('cpick-close-x')?.addEventListener('click', () => document.getElementById('modal-colorpick')?.classList.add('hidden'));

// ============================================================
// BLUR / SHARPEN BRUSH MODAL
// ============================================================
const blurState = { mode: 'blur', brushSize: 30, strength: 5 };
let _blurMgr = null;

document.getElementById('ws-blur-btn')?.addEventListener('click', async () => {
  const p = state.currentProject;
  const tgt = editTarget(p);
  if (!tgt) { showToast('Pick an image first.', 'error'); return; }
  const modal = document.getElementById('modal-blur');
  modal && (modal.dataset.targetPath = tgt);
  if (!modal) return;
  if (!_blurMgr) {
    _blurMgr = new CanvasManager({
      canvas: document.getElementById('blur-canvas'),
      container: document.getElementById('blur-canvas-container'),
      undoBtn: document.getElementById('blur-undo'),
      redoBtn: document.getElementById('blur-redo'),
      resetBtn: document.getElementById('blur-reset'),
      loupeBtn: document.getElementById('blur-loupe-toggle'),
      brushCursor: document.getElementById('blur-brush-cursor'),
      brushSizeGetter: () => blurState.brushSize,
      onPaint: (ctx, x, y, _lastPt, mgr) => {
        const r = blurState.brushSize / 2;
        const s = blurState.strength;
        const ax = Math.max(0, Math.round(x - r));
        const ay = Math.max(0, Math.round(y - r));
        const aw = Math.min(mgr.w - ax, Math.round(r * 2));
        const ah = Math.min(mgr.h - ay, Math.round(r * 2));
        if (aw <= 0 || ah <= 0) return;
        const tmp = document.createElement('canvas');
        tmp.width = aw; tmp.height = ah;
        const tCtx = tmp.getContext('2d');
        if (blurState.mode === 'blur') {
          tCtx.filter = 'blur(' + Math.max(1, s) + 'px)';
          tCtx.drawImage(mgr.canvas, ax, ay, aw, ah, 0, 0, aw, ah);
        } else {
          tCtx.drawImage(mgr.canvas, ax, ay, aw, ah, 0, 0, aw, ah);
          const t2 = document.createElement('canvas');
          t2.width = aw; t2.height = ah;
          const t2c = t2.getContext('2d');
          t2c.filter = 'contrast(' + (100 + s * 15) + '%) brightness(' + (100 + s * 2) + '%)';
          t2c.drawImage(mgr.canvas, ax, ay, aw, ah, 0, 0, aw, ah);
          tCtx.globalAlpha = 0.5;
          tCtx.drawImage(t2, 0, 0);
          tCtx.globalAlpha = 1;
        }
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(tmp, ax, ay);
        ctx.restore();
      },
    });
  }
  modal.classList.remove('hidden');
  _blurMgr.activate();
  // Load AFTER modal is visible so container has real dimensions
  await _blurMgr.loadImage('file:///' + tgt.replace(/\\/g, '/') + '?t=' + Date.now());
});

// Mode toggle
document.getElementById('blur-mode-blur')?.addEventListener('click', () => {
  blurState.mode = 'blur';
  document.getElementById('blur-mode-blur')?.classList.add('tool-active');
  document.getElementById('blur-mode-sharpen')?.classList.remove('tool-active');
});
document.getElementById('blur-mode-sharpen')?.addEventListener('click', () => {
  blurState.mode = 'sharpen';
  document.getElementById('blur-mode-sharpen')?.classList.add('tool-active');
  document.getElementById('blur-mode-blur')?.classList.remove('tool-active');
});
document.getElementById('blur-brush-size')?.addEventListener('input', (e) => {
  blurState.brushSize = parseInt(e.target.value);
  document.getElementById('blur-brush-val').textContent = e.target.value;
});
document.getElementById('blur-strength')?.addEventListener('input', (e) => {
  blurState.strength = parseInt(e.target.value);
  document.getElementById('blur-strength-val').textContent = e.target.value;
});

// Global Escape handler for all tool modals that don't have their own
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const modals = ['modal-blur', 'modal-crop', 'modal-brightness', 'modal-colorpick', 'modal-resolution'];
  for (const id of modals) {
    const m = document.getElementById(id);
    if (m && !m.classList.contains('hidden')) { m.classList.add('hidden'); e.preventDefault(); return; }
  }
});

// Blur mode/slider handlers (CanvasManager handles undo/redo/loupe/zoom/cursor)
document.getElementById('blur-cancel')?.addEventListener('click', () => document.getElementById('modal-blur')?.classList.add('hidden'));
document.getElementById('blur-close-x')?.addEventListener('click', () => document.getElementById('modal-blur')?.classList.add('hidden'));
document.getElementById('blur-save')?.addEventListener('click', async () => {
  const bCanvas = _blurMgr?.canvas || document.getElementById('blur-canvas');
  const p = state.currentProject;
  const modal = document.getElementById('modal-blur');
  const tgt = (modal && modal.dataset.targetPath) || editTarget(p);
  if (!bCanvas || !tgt) return;
  modal?.classList.add('hidden');
  showToast('Saving...', 'info', 1500);
  try {
    const dataUrl = bCanvas.toDataURL('image/png');
    const r = await API.saveImageDataUrl({ basePath: tgt, dataUrl, suffix: 'blur' });
    if (r?.success) { showToast('Saved!', 'success'); await reloadCurrentProject(); }
    else showToast('Save failed: ' + (r?.error || ''), 'error');
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
});

// ============================================================
// PAINT TOOLS — Selection + Drawing tools
// ============================================================
let _paintMgr = null;
const paintState = {
  tool: 'pen',
  brushSize: 20,
  opacity: 100,
  color: '#ff0000',
  tolerance: 32,
  eyedropping: false,
  imgPath: null,
  lineStart: null,
  linePreviewData: null,
  smudgeLastColor: null,
  // Selection state
  selection: null,        // Uint8Array (w*h), 255=selected, 0=not — null means no selection (= all selected)
  selUndoStack: [],
  selRedoStack: [],
  wandLastPoint: null,    // {x,y} last wand click for re-select on tolerance change
  selRectStart: null,     // {x,y} for rect select drag
  selPreviewData: null,   // ImageData snapshot for rect select preview
  lassoPoints: null,      // [{x,y}, ...] for lasso
};

function _paintHasSelection() {
  return paintState.selection !== null;
}
function _paintIsSelected(x, y) {
  if (!paintState.selection) return true; // no selection = everything is selected
  const idx = Math.round(y) * _paintMgr.w + Math.round(x);
  return paintState.selection[idx] === 255;
}
function _paintPushSelUndo() {
  paintState.selUndoStack.push(paintState.selection ? new Uint8Array(paintState.selection) : null);
  if (paintState.selUndoStack.length > 20) paintState.selUndoStack.shift();
  paintState.selRedoStack = [];
}
function _paintSelUndo() {
  if (paintState.selUndoStack.length === 0) return;
  paintState.selRedoStack.push(paintState.selection ? new Uint8Array(paintState.selection) : null);
  paintState.selection = paintState.selUndoStack.pop();
  _paintShowSelection();
}
function _paintSelRedo() {
  if (paintState.selRedoStack.length === 0) return;
  paintState.selUndoStack.push(paintState.selection ? new Uint8Array(paintState.selection) : null);
  paintState.selection = paintState.selRedoStack.pop();
  _paintShowSelection();
}
function _paintClearSelection() {
  _paintPushSelUndo();
  paintState.selection = null;
  const ov = document.getElementById('paint-sel-overlay');
  if (ov) { const c = ov.getContext('2d'); c.clearRect(0, 0, ov.width, ov.height); }
}
function _paintSelectAll() {
  _paintPushSelUndo();
  paintState.selection = null;
  const ov = document.getElementById('paint-sel-overlay');
  if (ov) { const c = ov.getContext('2d'); c.clearRect(0, 0, ov.width, ov.height); }
}

// Fill selection mask using flood fill algorithm
function _paintWandSelect(ctx, startX, startY, tolerance) {
  const w = _paintMgr.w, h = _paintMgr.h;
  const imgData = ctx.getImageData(0, 0, w, h).data;
  const idx = (startY * w + startX) * 4;
  const sr = imgData[idx], sg = imgData[idx+1], sb = imgData[idx+2], sa = imgData[idx+3];
  const tol = tolerance;
  const sel = new Uint8Array(w * h);
  const stack = [[startX, startY]];
  while (stack.length > 0) {
    const [cx, cy] = stack.pop();
    const ci = cy * w + cx;
    if (cx < 0 || cx >= w || cy < 0 || cy >= h || sel[ci]) continue;
    const pi = ci * 4;
    if (Math.abs(imgData[pi] - sr) > tol || Math.abs(imgData[pi+1] - sg) > tol ||
        Math.abs(imgData[pi+2] - sb) > tol || Math.abs(imgData[pi+3] - sa) > tol) continue;
    sel[ci] = 255;
    stack.push([cx+1, cy], [cx-1, cy], [cx, cy+1], [cx, cy-1]);
  }
  paintState.selection = sel;
}

// Rectangle select: fill mask for rect region
function _paintRectSelect(x1, y1, x2, y2) {
  const w = _paintMgr.w, h = _paintMgr.h;
  const sel = new Uint8Array(w * h);
  const minX = Math.max(0, Math.min(Math.round(x1), Math.round(x2)));
  const maxX = Math.min(w - 1, Math.max(Math.round(x1), Math.round(x2)));
  const minY = Math.max(0, Math.min(Math.round(y1), Math.round(y2)));
  const maxY = Math.min(h - 1, Math.max(Math.round(y1), Math.round(y2)));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      sel[y * w + x] = 255;
    }
  }
  paintState.selection = sel;
}

// Lasso select: fill mask using polygon
function _paintLassoSelect(points) {
  if (!points || points.length < 3) return;
  const w = _paintMgr.w, h = _paintMgr.h;
  const sel = new Uint8Array(w * h);
  // Find bounding box
  let minX = w, maxX = 0, minY = h, maxY = 0;
  for (const p of points) {
    minX = Math.min(minX, Math.round(p.x)); maxX = Math.max(maxX, Math.round(p.x));
    minY = Math.min(minY, Math.round(p.y)); maxY = Math.max(maxY, Math.round(p.y));
  }
  minX = Math.max(0, minX); maxX = Math.min(w - 1, maxX);
  minY = Math.max(0, minY); maxY = Math.min(h - 1, maxY);
  // Point-in-polygon (ray casting) for each pixel in bbox
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const yi = points[i].y, yj = points[j].y, xi = points[i].x, xj = points[j].x;
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
      if (inside) sel[y * w + x] = 255;
    }
  }
  paintState.selection = sel;
}

// Delete selected pixels (make transparent)
function _paintDeleteSelection(ctx) {
  if (!paintState.selection) return; // no selection = don't delete everything
  const w = _paintMgr.w, h = _paintMgr.h;
  const imgData = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < paintState.selection.length; i++) {
    if (paintState.selection[i] === 255) {
      imgData.data[i * 4 + 3] = 0; // set alpha to 0
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

// Draw selection overlay on separate canvas
function _paintShowSelection() {
  const ov = document.getElementById('paint-sel-overlay');
  if (!ov || !_paintMgr) return;
  const w = _paintMgr.w, h = _paintMgr.h;
  if (ov.width !== w || ov.height !== h) { ov.width = w; ov.height = h; }
  const octx = ov.getContext('2d');
  octx.clearRect(0, 0, w, h);
  if (!paintState.selection) return;
  const sel = paintState.selection;
  // Draw dark overlay on NON-selected pixels (selected area stays clear)
  const td = octx.createImageData(w, h);
  for (let i = 0; i < sel.length; i++) {
    if (sel[i] === 0) {
      // Darken non-selected area
      td.data[i*4] = 0; td.data[i*4+1] = 0; td.data[i*4+2] = 0; td.data[i*4+3] = 140;
    }
  }
  octx.putImageData(td, 0, 0);
  // Draw dashed border around selection
  octx.strokeStyle = '#ffffff';
  octx.lineWidth = 1.5;
  octx.setLineDash([5, 5]);
  octx.beginPath();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (sel[y * w + x] !== 255) continue;
      const isBorder = (x === 0 || sel[y * w + x - 1] === 0) ||
                       (x === w-1 || sel[y * w + x + 1] === 0) ||
                       (y === 0 || sel[(y-1) * w + x] === 0) ||
                       (y === h-1 || sel[(y+1) * w + x] === 0);
      if (isBorder) octx.rect(x, y, 1, 1);
    }
  }
  octx.stroke();
}

function _paintDab(ctx, x, y, _lastPt, mgr) {
  x = Math.round(x); y = Math.round(y);
  const r = paintState.brushSize / 2;
  const alpha = paintState.opacity / 100;

  if (paintState.tool === 'eraser') {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  if (paintState.tool === 'smudge') {
    _paintSmudgeDab(ctx, x, y, r);
    return;
  }

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = paintState.color;

  if (paintState.tool === 'pen') {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  } else if (paintState.tool === 'spray') {
    const dots = Math.round(r * r * 0.15);
    for (let i = 0; i < dots; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * r;
      ctx.fillRect(Math.round(x + Math.cos(angle) * dist), Math.round(y + Math.sin(angle) * dist), 1, 1);
    }
  } else if (paintState.tool === 'ink') {
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, paintState.color);
    grad.addColorStop(0.6, paintState.color);
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function _paintStroke(ctx, x, y, lastPt, mgr) {
  x = Math.round(x); y = Math.round(y);
  if (paintState.tool === 'line') {
    // Line tool: preview rubber band line
    if (paintState.linePreviewData) ctx.putImageData(paintState.linePreviewData, 0, 0);
    if (paintState.lineStart) {
      ctx.save();
      ctx.globalAlpha = paintState.opacity / 100;
      ctx.strokeStyle = paintState.color;
      ctx.lineWidth = paintState.brushSize;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(paintState.lineStart.x, paintState.lineStart.y);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.restore();
    }
    return;
  }
  if (!lastPt) { _paintDab(ctx, x, y, null, mgr); return; }
  const dx = x - Math.round(lastPt.x), dy = y - Math.round(lastPt.y);
  const dist = Math.sqrt(dx * dx + dy * dy);
  const step = Math.max(1, paintState.brushSize / (paintState.tool === 'spray' ? 2 : (paintState.tool === 'smudge' ? 2 : 4)));
  const steps = Math.ceil(dist / step);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    _paintDab(ctx, Math.round(lastPt.x + dx * t), Math.round(lastPt.y + dy * t), null, mgr);
  }
}

// --- Smudge: sample average color under brush, paint it shifted ---
function _paintSmudgeDab(ctx, x, y, r) {
  const sr = Math.max(2, Math.round(r * 0.6));
  const w = _paintMgr.w, h = _paintMgr.h;
  const sx = Math.max(0, x - sr), sy = Math.max(0, y - sr);
  const sw = Math.min(w - sx, sr * 2), sh = Math.min(h - sy, sr * 2);
  if (sw <= 0 || sh <= 0) return;
  const data = ctx.getImageData(sx, sy, sw, sh).data;
  let tr = 0, tg = 0, tb = 0, cnt = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 30) { tr += data[i]; tg += data[i+1]; tb += data[i+2]; cnt++; }
  }
  if (cnt === 0) return;
  const avg = `rgba(${Math.round(tr/cnt)},${Math.round(tg/cnt)},${Math.round(tb/cnt)},${paintState.opacity / 100})`;
  ctx.save();
  const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
  grad.addColorStop(0, avg);
  grad.addColorStop(1, 'transparent');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// --- Flood fill (paint bucket) ---
function _paintFloodFill(ctx, startX, startY, fillColor, tolerance) {
  const w = _paintMgr.w, h = _paintMgr.h;
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;
  const idx = (startY * w + startX) * 4;
  const sr = data[idx], sg = data[idx+1], sb = data[idx+2], sa = data[idx+3];
  // Parse fill color
  const tmp = document.createElement('canvas'); tmp.width = 1; tmp.height = 1;
  const tc = tmp.getContext('2d'); tc.fillStyle = fillColor; tc.fillRect(0, 0, 1, 1);
  const fc = tc.getImageData(0, 0, 1, 1).data;
  const fr = fc[0], fg = fc[1], fb = fc[2];
  // Already same color?
  if (Math.abs(sr - fr) + Math.abs(sg - fg) + Math.abs(sb - fb) < 3) return;
  const tol = tolerance;
  function match(i) {
    return Math.abs(data[i] - sr) <= tol && Math.abs(data[i+1] - sg) <= tol && Math.abs(data[i+2] - sb) <= tol && Math.abs(data[i+3] - sa) <= tol;
  }
  const stack = [[startX, startY]];
  const visited = new Uint8Array(w * h);
  const alpha = paintState.opacity / 100;
  while (stack.length > 0) {
    const [cx, cy] = stack.pop();
    const ci = cy * w + cx;
    if (cx < 0 || cx >= w || cy < 0 || cy >= h || visited[ci]) continue;
    const pi = ci * 4;
    if (!match(pi)) continue;
    visited[ci] = 1;
    data[pi]   = Math.round(data[pi]   * (1 - alpha) + fr * alpha);
    data[pi+1] = Math.round(data[pi+1] * (1 - alpha) + fg * alpha);
    data[pi+2] = Math.round(data[pi+2] * (1 - alpha) + fb * alpha);
    data[pi+3] = 255;
    stack.push([cx+1, cy], [cx-1, cy], [cx, cy+1], [cx, cy-1]);
  }
  ctx.putImageData(imgData, 0, 0);
}

// --- Magic Wand is now in the selection system above (_paintWandSelect) ---

function _closePaint() {
  document.getElementById('modal-paint')?.classList.add('hidden');
  if (_paintMgr) _paintMgr.loupeEnabled = false;
  const l = document.getElementById('clone-loupe'); if (l) l.style.display = 'none';
}

// Open Paint Tools
document.getElementById('ws-paint-btn')?.addEventListener('click', () => {
  const p = state.currentProject;
  const tgt = editTarget(p);
  if (!tgt) { showToast('Pick an image first.', 'error'); return; }
  paintState.imgPath = tgt;
  const modal = document.getElementById('modal-paint');
  if (!modal) return;

  if (!_paintMgr) {
    _paintMgr = new CanvasManager({
      canvas: document.getElementById('paint-canvas'),
      container: document.getElementById('paint-canvas-container'),
      undoBtn: document.getElementById('paint-undo'),
      redoBtn: document.getElementById('paint-redo'),
      resetBtn: document.getElementById('paint-reset'),
      loupeBtn: document.getElementById('paint-loupe-toggle'),
      brushCursor: document.getElementById('paint-brush-cursor'),
      brushSizeGetter: () => paintState.brushSize,
      onMouseDown: (ctx, x, y, e, mgr) => {
        if (paintState.eyedropping) {
          const px = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
          const hex = '#' + [px[0], px[1], px[2]].map(v => v.toString(16).padStart(2, '0')).join('');
          paintState.color = hex;
          document.getElementById('paint-color').value = hex;
          paintState.eyedropping = false;
          document.getElementById('paint-eyedropper')?.classList.remove('tool-active');
          document.getElementById('paint-canvas').style.cursor = 'none';
          return false;
        }
        if (paintState.tool === 'fill') {
          mgr.pushUndo();
          _paintFloodFill(ctx, Math.round(x), Math.round(y), paintState.color, paintState.tolerance);
          return false;
        }
        if (paintState.tool === 'wand') {
          _paintPushSelUndo();
          paintState.wandLastPoint = { x: Math.round(x), y: Math.round(y) };
          _paintWandSelect(ctx, Math.round(x), Math.round(y), paintState.tolerance);
          _paintShowSelection();
          return false;
        }
        if (paintState.tool === 'sel-rect') {
          paintState.selRectStart = { x: Math.round(x), y: Math.round(y) };
          paintState.selPreviewData = ctx.getImageData(0, 0, mgr.w, mgr.h);
          paintState._selDragging = true;
          return false;
        }
        if (paintState.tool === 'sel-lasso') {
          paintState.lassoPoints = [{ x: Math.round(x), y: Math.round(y) }];
          paintState.selPreviewData = ctx.getImageData(0, 0, mgr.w, mgr.h);
          paintState._selDragging = true;
          return false;
        }
        if (paintState.tool === 'line') {
          paintState.lineStart = { x: Math.round(x), y: Math.round(y) };
          paintState.linePreviewData = ctx.getImageData(0, 0, mgr.w, mgr.h);
          return undefined; // let CanvasManager pushUndo
        }
        // Don't paint here — let CanvasManager pushUndo first, then onPaint handles the first dab
        return undefined;
      },
      onPaint: _paintStroke,
      onBrushResize: (delta, mgr) => {
        paintState.brushSize = Math.max(1, Math.min(200, paintState.brushSize + delta));
        document.getElementById('paint-brush-size').value = paintState.brushSize;
        document.getElementById('paint-brush-val').textContent = paintState.brushSize;
      },
      onMouseUp: (mgr) => {
        if (paintState.tool === 'line' && paintState.lineStart) {
          paintState.lineStart = null;
          paintState.linePreviewData = null;
        }
      },
    });
  }

  modal.classList.remove('hidden');
  _paintMgr.activate();
  paintState.eyedropping = false;
  document.getElementById('paint-eyedropper')?.classList.remove('tool-active');
  requestAnimationFrame(() => {
    _paintMgr.loadImage('file:///' + paintState.imgPath.replace(/\\/g, '/') + '?t=' + Date.now());
  });
});

// Selection drag: global mousemove + mouseup for rect/lasso (runs outside CanvasManager)
document.getElementById('paint-canvas')?.addEventListener('mousemove', (e) => {
  if (!paintState._selDragging || !_paintMgr) return;
  const p = _paintMgr.getCanvasCoords(e);
  const ov = document.getElementById('paint-sel-overlay');
  if (!ov) return;
  if (ov.width !== _paintMgr.w || ov.height !== _paintMgr.h) { ov.width = _paintMgr.w; ov.height = _paintMgr.h; }
  const octx = ov.getContext('2d');
  octx.clearRect(0, 0, ov.width, ov.height);
  octx.save();
  octx.strokeStyle = '#4488ff'; octx.lineWidth = 2; octx.setLineDash([6, 3]);
  if (paintState.tool === 'sel-rect' && paintState.selRectStart) {
    paintState._selLastX = Math.round(p.x);
    paintState._selLastY = Math.round(p.y);
    const rx = Math.min(paintState.selRectStart.x, paintState._selLastX);
    const ry = Math.min(paintState.selRectStart.y, paintState._selLastY);
    const rw = Math.abs(paintState._selLastX - paintState.selRectStart.x);
    const rh = Math.abs(paintState._selLastY - paintState.selRectStart.y);
    octx.strokeRect(rx, ry, rw, rh);
    octx.fillStyle = 'rgba(80,140,255,0.15)';
    octx.fillRect(rx, ry, rw, rh);
  }
  if (paintState.tool === 'sel-lasso' && paintState.lassoPoints) {
    paintState.lassoPoints.push({ x: Math.round(p.x), y: Math.round(p.y) });
    octx.beginPath();
    octx.moveTo(paintState.lassoPoints[0].x, paintState.lassoPoints[0].y);
    for (let i = 1; i < paintState.lassoPoints.length; i++) {
      octx.lineTo(paintState.lassoPoints[i].x, paintState.lassoPoints[i].y);
    }
    octx.stroke();
  }
  octx.restore();
});
window.addEventListener('mouseup', () => {
  if (!paintState._selDragging || !_paintMgr) return;
  paintState._selDragging = false;
  if (paintState.tool === 'sel-rect' && paintState.selRectStart) {
    // Get last mouse position from overlay
    _paintPushSelUndo();
    const ov = document.getElementById('paint-sel-overlay');
    // We need the end point — use the selPreviewData trick or just read from overlay bounds
    // Actually, we can read the current overlay drawing to find the rect
    // Simpler: store the last point during mousemove
    _paintRectSelect(paintState.selRectStart.x, paintState.selRectStart.y,
      paintState._selLastX || paintState.selRectStart.x, paintState._selLastY || paintState.selRectStart.y);
    _paintShowSelection();
    paintState.selRectStart = null;
    paintState.selPreviewData = null;
  }
  if (paintState.tool === 'sel-lasso' && paintState.lassoPoints) {
    _paintPushSelUndo();
    _paintLassoSelect(paintState.lassoPoints);
    _paintShowSelection();
    paintState.lassoPoints = null;
    paintState.selPreviewData = null;
  }
});

// Tool selection buttons
const _paintTools = ['sel-rect', 'sel-lasso', 'wand', 'pen', 'spray', 'ink', 'line', 'smudge', 'fill', 'eraser'];
const _selectionTools = ['sel-rect', 'sel-lasso', 'wand'];
_paintTools.forEach(tool => {
  document.getElementById('paint-tool-' + tool)?.addEventListener('click', () => {
    paintState.tool = tool;
    _paintTools.forEach(t => {
      document.getElementById('paint-tool-' + t)?.classList.toggle('tool-active', t === tool);
    });
    // Show tolerance slider for fill/wand
    const tolGroup = document.getElementById('paint-tolerance-group');
    if (tolGroup) tolGroup.style.display = (tool === 'fill' || tool === 'wand') ? 'flex' : 'none';
    // Cursor: crosshair for selection/fill tools, none for brush tools
    const canvas = document.getElementById('paint-canvas');
    if (canvas) canvas.style.cursor = (_selectionTools.includes(tool) || tool === 'fill') ? 'crosshair' : 'none';
  });
});

// Brush size
document.getElementById('paint-brush-size')?.addEventListener('input', (e) => {
  paintState.brushSize = parseInt(e.target.value);
  document.getElementById('paint-brush-val').textContent = e.target.value;
});

// Opacity
document.getElementById('paint-opacity')?.addEventListener('input', (e) => {
  paintState.opacity = parseInt(e.target.value);
  document.getElementById('paint-opacity-val').textContent = e.target.value + '%';
});

// Tolerance (for Fill / Wand) — re-run wand selection live
document.getElementById('paint-tolerance')?.addEventListener('input', (e) => {
  paintState.tolerance = parseInt(e.target.value);
  document.getElementById('paint-tolerance-val').textContent = e.target.value;
  if (paintState.tool === 'wand' && paintState.wandLastPoint && _paintMgr) {
    _paintWandSelect(_paintMgr.ctx, paintState.wandLastPoint.x, paintState.wandLastPoint.y, paintState.tolerance);
    _paintShowSelection();
  }
});

// Color picker
document.getElementById('paint-color')?.addEventListener('input', (e) => {
  paintState.color = e.target.value;
});

// Eyedropper (pick from image)
document.getElementById('paint-eyedropper')?.addEventListener('click', () => {
  paintState.eyedropping = !paintState.eyedropping;
  document.getElementById('paint-eyedropper')?.classList.toggle('tool-active', paintState.eyedropping);
  const canvas = document.getElementById('paint-canvas');
  if (canvas) canvas.style.cursor = paintState.eyedropping ? 'crosshair' : 'none';
});

// Close / Cancel
document.getElementById('paint-close-x')?.addEventListener('click', _closePaint);
document.getElementById('paint-cancel')?.addEventListener('click', _closePaint);
document.addEventListener('keydown', (e) => {
  const modal = document.getElementById('modal-paint');
  if (!modal || modal.classList.contains('hidden')) return;
  if (e.key === 'Escape') { _closePaint(); return; }
  // Delete = erase selected pixels
  if (e.key === 'Delete' && _paintHasSelection()) {
    _paintMgr.pushUndo();
    _paintDeleteSelection(_paintMgr.ctx);
    _paintClearSelection();
    return;
  }
  // Ctrl+A = select all, Ctrl+D = deselect
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); _paintSelectAll(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); _paintClearSelection(); return; }
  // Ctrl+Z/Y for selection tools — intercept before CanvasManager handles it
  const isSelTool = ['sel-rect', 'sel-lasso', 'wand'].includes(paintState.tool);
  if (isSelTool && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault(); _paintSelUndo(); return;
  }
  if (isSelTool && (e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
    e.preventDefault(); _paintSelRedo(); return;
  }
  // [ / ] = decrease / increase brush size
  if (e.key === '[') {
    paintState.brushSize = Math.max(1, paintState.brushSize - (e.shiftKey ? 10 : 3));
    document.getElementById('paint-brush-size').value = paintState.brushSize;
    document.getElementById('paint-brush-val').textContent = paintState.brushSize;
    return;
  }
  if (e.key === ']') {
    paintState.brushSize = Math.min(200, paintState.brushSize + (e.shiftKey ? 10 : 3));
    document.getElementById('paint-brush-size').value = paintState.brushSize;
    document.getElementById('paint-brush-val').textContent = paintState.brushSize;
    return;
  }
  // 1-9 = opacity 10%-90%, 0 = 100%
  if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key >= '0' && e.key <= '9') {
    paintState.opacity = e.key === '0' ? 100 : parseInt(e.key) * 10;
    document.getElementById('paint-opacity').value = paintState.opacity;
    document.getElementById('paint-opacity-val').textContent = paintState.opacity + '%';
    return;
  }
});

// Save
document.getElementById('paint-save')?.addEventListener('click', async () => {
  if (!paintState.imgPath || !_paintMgr) return;
  const dataUrl = _paintMgr.toDataURL();
  try {
    const result = await window.meshyAPI.saveImageDataUrl({
      basePath: paintState.imgPath, dataUrl, suffix: 'painted',
    });
    if (result && result.success) {
      showToast('Painted version saved!', 'success');
      _closePaint();
      // refreshProjectImages doesn't exist — use reloadCurrentProject
      // which rebuilds the version strip + previews.
      if (state.currentProject) await reloadCurrentProject();
    } else {
      showToast('Save failed: ' + ((result && result.error) || 'unknown'), 'error');
    }
  } catch (e) {
    showToast('Save error: ' + e.message, 'error');
  }
});

// ----- Mesh step -----
let wsRenderer, wsScene, wsCamera, wsControls, wsModel, wsRafId;
function initWsThree() {
  if (wsRenderer) return;
  const canvas = document.getElementById('ws-mesh-canvas');
  // Unified Viewer3D (see src/renderer/lib/Viewer3D.js).
  // preserveDrawingBuffer is required so canvas.toDataURL() can capture
  // the rendered scene for thumbnail saving.
  const _wsV = new Viewer3D({
    canvas, fov: 45, bgColor: 0x1d1d2c, cameraPos: [2, 2, 3],
    lighting: true,
  });
  // Renderer needs preserveDrawingBuffer → patch after construction.
  // (Viewer3D's renderer was created without it; recreate using the
  // same canvas with the flag on.)
  _wsV.renderer.dispose();
  _wsV.renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, alpha: true, preserveDrawingBuffer: true,
  });
  _wsV.renderer.setSize(canvas.clientWidth || 320, canvas.clientHeight || 260, false);
  _wsV.renderer.setPixelRatio(window.devicePixelRatio);
  _wsV.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  _wsV.renderer.toneMappingExposure = 1.0;
  wsRenderer = _wsV.renderer;
  wsScene = _wsV.scene;
  wsCamera = _wsV.camera;
  wsControls = _wsV.controls;
  _wsV.startTickLoop();
  wsRafId = -1;  // (Viewer3D owns the RAF; kept for legacy shutdown code)
}

async function showStep2Preview(mesh) {
  initWsThree();
  setViewerFilename('ws-mesh-filename', mesh?.path || mesh?.filename);
  document.getElementById('step2-placeholder').style.display = 'none';
  // Remove the source-image overlay if it was shown
  const overlay = document.querySelector('.step2-source-overlay');
  if (overlay) overlay.remove();
  // Show the expand button (hidden until a mesh is actually loaded)
  const expandBtn = document.getElementById('ws-mesh-expand-btn');
  if (expandBtn) {
    expandBtn.classList.remove('hidden');
    expandBtn.onclick = (e) => { e.stopPropagation(); openMeshLightbox(mesh.path); };
  }
  // Track which mesh is currently previewed
  const p = state.currentProject;
  if (p) p.previewMeshPath = mesh.path;
  // Show the "use for rig" bar — always clickable, even when already selected
  const useRigBar = document.getElementById('ws-use-for-rig-bar');
  if (useRigBar) {
    useRigBar.classList.remove('hidden');
    const btn = document.getElementById('ws-use-for-rig-btn');
    if (btn) {
      const isSelected = p && p.selectedMeshPath === mesh.path;
      btn.disabled = false;
      btn.classList.toggle('used-state', isSelected);
      btn.textContent = isSelected ? '\u2713 Used for Rig generation \u2192' : 'Use this mesh for Rig \u2192';
    }
  }
  // Load the GLB
  const buffer = await API.readMeshFile(mesh.path);
  if (!buffer) return;
  if (wsModel) { wsScene.remove(wsModel); wsModel = null; }
  const loader = new GLTFLoader();
  loader.parse(buffer, '', (gltf) => {
    wsModel = gltf.scene;
    wsScene.add(wsModel);
    _applyMeshTextureFilter(wsModel);
    fitWsCamera(wsModel);
    // Count verts/triangles and display under the filename
    let totalVerts = 0, totalTris = 0;
    wsModel.traverse(child => {
      if (child.isMesh && child.geometry) {
        const geo = child.geometry;
        totalVerts += geo.attributes.position ? geo.attributes.position.count : 0;
        totalTris += geo.index ? (geo.index.count / 3) : (totalVerts / 3);
      }
    });
    const statsEl = document.getElementById('ws-mesh-stats');
    if (statsEl) {
      statsEl.textContent = `${totalVerts.toLocaleString()} vertices · ${Math.round(totalTris).toLocaleString()} triangles`;
    }
    // Show the toolbar and refresh its state for this new model
    const tb = document.getElementById('ws-mesh-toolbar');
    if (tb) tb.classList.remove('hidden');
    if (typeof wsMeshControls !== 'undefined' && wsMeshControls) {
      setTimeout(() => wsMeshControls.refreshAll(), 50);
    }
    // Save a thumbnail of the mesh after a few render passes have
    // settled. Thumb caused 'white burnout' previously because we were
    // capturing while toneMappingExposure 1.4 + 4 lights overcooked
    // bright-base PBR materials. We:
    //   1) wait 4 frames for camera + materials to stabilise
    //   2) temporarily lower the exposure to 1.0 for the snapshot
    //   3) restore the live exposure after capture
    let _fr = 0;
    const _capture = async () => {
      _fr++;
      if (_fr < 4) { requestAnimationFrame(_capture); return; }
      try {
        const _origExposure = wsRenderer.toneMappingExposure;
        wsRenderer.toneMappingExposure = 1.0;
        wsRenderer.render(wsScene, wsCamera);
        const canvas = document.getElementById('ws-mesh-canvas');
        const dataUrl = canvas.toDataURL('image/png');
        // Restore original exposure + render again so the live viewer
        // doesn't flicker dim for a frame.
        wsRenderer.toneMappingExposure = _origExposure;
        wsRenderer.render(wsScene, wsCamera);
        if (API.saveThumbnail) {
          await API.saveThumbnail({ meshPath: mesh.path, dataUrl });
        }
      } catch (e) {
        console.warn('[thumb] save mesh thumbnail failed:', e && e.message);
      }
    };
    requestAnimationFrame(_capture);
  }, (err) => { console.error('GLTF parse error', err); });
}

// Walk a loaded GLTF scene and force NEAREST filtering on every base
// color texture. Default Three.js bilinear filtering bleeds across UV
// island borders — on SF3D meshes (1000+ micro-islands) this produces
// a checkerboard / mosaic of neighbouring island colours. NEAREST
// samples a single texel, no border artifacts. Mipmaps off for the
// same reason.
function _applyMeshTextureFilter(root) {
  if (!root || typeof root.traverse !== 'function') return;
  // Use trilinear (linear + mipmaps) + anisotropic filtering on every
  // PBR map. Earlier we forced NEAREST to hide the SF3D micro-island
  // bleed; that worked but pixels were visible on close zoom and broke
  // normal maps. The refine pipeline now bakes proper UV padding so we
  // can go back to clean trilinear without the moire artefacts.
  let renderer = null;
  try {
    if (typeof wsRenderer !== 'undefined') renderer = wsRenderer;
  } catch (_) {}
  const maxAniso = renderer ? renderer.capabilities.getMaxAnisotropy() : 8;
  root.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of mats) {
      if (!mat) continue;
      const slots = [mat.map, mat.normalMap, mat.roughnessMap,
                     mat.metalnessMap, mat.aoMap, mat.emissiveMap];
      for (const tex of slots) {
        if (!tex) continue;
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearMipMapLinearFilter;  // trilinear minify
        tex.generateMipmaps = true;
        tex.anisotropy = Math.min(16, maxAniso);
        tex.needsUpdate = true;
      }
    }
  });
}

function fitWsCamera(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3()).length();
  const center = box.getCenter(new THREE.Vector3());
  // Translate so the model's bottom (min.y) sits on y=0 (the grid plane),
  // and X / Z are centered on the origin
  obj.position.x -= center.x;
  obj.position.z -= center.z;
  obj.position.y -= box.min.y;
  // Look at the model's vertical mid-height instead of (0,0,0)
  const sizeVec = box.getSize(new THREE.Vector3());
  const lookY = sizeVec.y * 0.5;
  // SF3D outputs meshes with the subject's face pointing toward -Z
  // (head verts cluster in -Z, confirmed on chat_vert 1776453637124).
  // Place the initial camera in -Z so the user sees the face first,
  // not the back. User can still orbit freely.
  wsCamera.position.set(size * 1.2, size * 0.8 + lookY, size * 1.2);
  wsCamera.lookAt(0, lookY, 0);
  wsControls.target.set(0, lookY, 0);
  wsControls.update();
}

async function renderMeshVersions(p) {
  const strip = document.getElementById('ws-mesh-versions');
  strip.innerHTML = '';

  // Filter NSFW meshes: check if the source image has a .nsfw tag
  let meshes = p.meshes;
  let restricted = true;
  try {
    if (API.getParentalStatus) {
      const ps = await API.getParentalStatus();
      restricted = !ps.unrestricted;
    }
  } catch(_) {}
  if (restricted && meshes.length > 0 && API.checkImagesNsfwTags) {
    try {
      const sourceImages = meshes.map(m => m.sourceImage).filter(Boolean);
      if (sourceImages.length > 0) {
        const tags = await API.checkImagesNsfwTags({ images: sourceImages });
        if (tags) {
          meshes = meshes.filter(m => !m.sourceImage || !tags[m.sourceImage]);
        }
      }
    } catch(_) {}
  }

  if (meshes.length > 0) {
    if (!p.previewMeshPath || !meshes.find(m => m.path === p.previewMeshPath)) {
      p.previewMeshPath = meshes[0].path;
    }
    if (!p.selectedMeshPath || !meshes.find(m => m.path === p.selectedMeshPath)) {
      p.selectedMeshPath = meshes[0].path;
    }
  }
  meshes.forEach((m, i) => {
    const t = document.createElement('div');
    t.className = 'version-thumb';
    if (m.path === p.previewMeshPath) t.classList.add('selected');
    if (m.path === p.selectedMeshPath) t.classList.add('used-for-3d'); // reuse same green check style
    // Resolve a thumbnail: prefer the mesh's own thumb (if main process generated one),
    // fall back to the source image used to generate this mesh, then to the project thumb.
    let thumbSrc = '';
    if (m.thumb) {
      thumbSrc = m.thumb.startsWith('file:') ? m.thumb : 'file:///' + m.thumb.replace(/\\/g, '/');
    } else if (m.sourceImage) {
      thumbSrc = 'file:///' + m.sourceImage.replace(/\\/g, '/');
    } else if (p.thumb) {
      thumbSrc = 'file:///' + p.thumb.replace(/\\/g, '/');
    }
    t.innerHTML = `
      ${thumbSrc ? `<img src="${thumbSrc}" alt="">` : ''}
      <span class="v-label">v${meshes.length - 1 - i}</span>
      <button class="version-delete-btn" title="Delete this mesh">&#10005;</button>
    `;
    t.title = m.filename;
    t.addEventListener('click', () => {
      strip.querySelectorAll('.version-thumb').forEach(x => x.classList.remove('selected'));
      t.classList.add('selected');
      p.previewMeshPath = m.path;
      showStep2Preview(m);
    });
    t.querySelector('.version-delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!await customConfirm(`Delete mesh v${p.meshes.length - 1 - i}? This cannot be undone.`, 'Delete mesh version')) return;
      await API.deleteMesh(m.filename);
      await reloadCurrentProject();
    });
    strip.appendChild(t);
  });
}

// "Use this mesh for Rig" button handler
document.getElementById('ws-use-for-rig-btn')?.addEventListener('click', () => {
  const p = state.currentProject;
  if (!p || !p.previewMeshPath) return;
  p.selectedMeshPath = p.previewMeshPath;
  // Mark the used-for-rig thumb visually (reuse the green check class)
  const strip = document.getElementById('ws-mesh-versions');
  strip.querySelectorAll('.version-thumb').forEach(x => x.classList.remove('used-for-3d'));
  for (let i = 0; i < p.meshes.length; i++) {
    if (p.meshes[i].path === p.selectedMeshPath) {
      strip.children[i].classList.add('used-for-3d');
      break;
    }
  }
  // Update the button label — keep it clickable so it can scroll to the next step
  const btn = document.getElementById('ws-use-for-rig-btn');
  if (btn) {
    btn.disabled = false;
    btn.classList.add('used-state');
    btn.textContent = '\u2713 Used for Rig generation \u2192';
  }
  refreshButtonStates(p);
  // Update the source-mesh preview in the Rig Create new section
  showRigSourceMesh(p.selectedMeshPath);
  // Move step 3 to active state if not done
  const step3Card = document.getElementById('step-card-rig');
  if (step3Card && !step3Card.classList.contains('done')) {
    step3Card.classList.remove('disabled');
    setStepStatus(3, 'active');
  }
  // Make sure the target card is expanded, and collapse the others to focus
  step3Card?.classList.remove('collapsed');
  document.getElementById('step-card-image')?.classList.add('collapsed');
  document.getElementById('step-card-mesh')?.classList.add('collapsed');
  // Open Create new + force-close Edit selected. Defer to the next frame so
  // the synchronous refreshButtonStates() above (which calls setStageOpenState
  // and may re-open Edit selected because a rig already exists) has had its
  // toggle events dispatched first — otherwise those events fire AFTER us and
  // silently re-collapse Create new.
  const step3CreateStage = step3Card?.querySelector('.stage-create');
  const step3EditStage = step3Card?.querySelector('.stage-edit');
  requestAnimationFrame(() => {
    if (step3EditStage) step3EditStage.open = false;
    if (step3CreateStage) step3CreateStage.open = true;
  });
  // Smooth-scroll to the rig card
  step3Card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  step3Card?.classList.add('pulse-highlight');
  setTimeout(() => step3Card?.classList.remove('pulse-highlight'), 1500);
});

// Wrap a generate handler so it goes through the queue if VRAM is tight
function gatedRun(kind, displayName, runFn) {
  enqueueJob(kind, displayName, runFn);
}

// 3D quality presets: map a single dropdown to safe (tex_res, vertex_count) combos.
// These are VRAM-safe on 16 GB cards. The Python bridge auto-clamps further
// based on actual GPU VRAM detected at runtime.
// Pipeline complet SF3D ~ multi-view(30s) + inference(30s) + SDXL refine 9 tiles
// (~35s) + atlas final(~10s). Mygale 1024px ran in 2m10s real time, validated
// 2026-05-16. Previous estimates assumed SF3D inference alone (~20s).
const MESH_QUALITY_PRESETS = {
  draft:    { tex: 512,  verts: 3000,  expectedMs: 80000 },
  standard: { tex: 1024, verts: -1,    expectedMs: 130000 },
  high:     { tex: 2048, verts: -1,    expectedMs: 180000 },
  ultra:    { tex: 4096, verts: -1,    expectedMs: 300000 },
};
// subdivide value convention:
//   negative = decimate to abs(val) faces (low-poly)
//   0 = SF3D default (~13K)
//   1-4 = subdivision levels (each ×4 triangles)
//   '100k'-'1m' = subdivide then decimate to exact target
const MESH_TRI_PRESETS = {
  '500':  { subdivide: -500,    label: '~500',  extraMs: 2000 },
  '1000': { subdivide: -1000,   label: '~1K',   extraMs: 2000 },
  '3000': { subdivide: -3000,   label: '~3K',   extraMs: 2000 },
  '5000': { subdivide: -5000,   label: '~5K',   extraMs: 2000 },
  '0':    { subdivide: 0,       label: '~13K',  extraMs: 0 },
  '20k':  { subdivide: 20000,   label: '~20K',  extraMs: 2000 },
  '30k':  { subdivide: 30000,   label: '~30K',  extraMs: 2000 },
  '1':    { subdivide: 1,       label: '~50K',  extraMs: 3000 },
  '75k':  { subdivide: 75000,   label: '~75K',  extraMs: 4000 },
  '100k': { subdivide: 100000,  label: '~100K', extraMs: 5000 },
  '150k': { subdivide: 150000,  label: '~150K', extraMs: 5000 },
  '2':    { subdivide: 2,       label: '~200K', extraMs: 5000 },
  '250k': { subdivide: 250000,  label: '~250K', extraMs: 6000 },
  '300k': { subdivide: 300000,  label: '~300K', extraMs: 7000 },
  '500k': { subdivide: 500000,  label: '~500K', extraMs: 10000 },
  '3':    { subdivide: 3,       label: '~800K', extraMs: 12000 },
  '1m':   { subdivide: 1000000, label: '~1M',   extraMs: 18000 },
  '4':    { subdivide: 4,       label: '~3M',   extraMs: 25000 },
};
function updateMeshHint() {
  const hint = document.getElementById('ws-3d-quality-hint');
  if (!hint) return;
  const q = document.getElementById('ws-3d-quality')?.value || 'standard';
  const t = document.getElementById('ws-3d-triangles')?.value || '0';
  const preset = MESH_QUALITY_PRESETS[q] || MESH_QUALITY_PRESETS.standard;
  const tri = MESH_TRI_PRESETS[t] || MESH_TRI_PRESETS['0'];
  hint.textContent = `${tri.label} triangles · ${preset.tex} px texture`;
}
document.getElementById('ws-3d-quality')?.addEventListener('change', updateMeshHint);
document.getElementById('ws-3d-triangles')?.addEventListener('change', updateMeshHint);

// High triangle count warning: above ~50K, SF3D's per-triangle UV
// packing + 2048 atlas produces incoherent voronoi texture. Warn
// the user before they commit to the long generation.
(function _wireHighPolyWarning() {
  const HIGH_POLY_VALUES = new Set([
    '1', '75k', '100k', '150k', '2', '250k', '300k', '500k',
    '3', '1m', '4',
  ]);
  const triSel = document.getElementById('ws-3d-triangles');
  const warn = document.getElementById('ws-3d-highcount-warn');
  if (!triSel || !warn) return;
  const sync = () => {
    const isHigh = HIGH_POLY_VALUES.has(triSel.value);
    warn.classList.toggle('hidden', !isHigh);
  };
  triSel.addEventListener('change', sync);
  sync();
})();

document.getElementById('ws-generate-mesh').addEventListener('click', async () => {
  const p = state.currentProject;
  if (!p || !p.selectedImagePath) { showToast('Pick an image first.', 'error'); return; }
  const engine = document.getElementById('ws-3d-engine').value;
  const quality = document.getElementById('ws-3d-quality')?.value || 'standard';
  const triLevel = document.getElementById('ws-3d-triangles')?.value || '0';
  const preset = MESH_QUALITY_PRESETS[quality] || MESH_QUALITY_PRESETS.standard;
  const triPreset = MESH_TRI_PRESETS[triLevel] || MESH_TRI_PRESETS['0'];
  const buildStages = document.getElementById('ws-3d-buildstages')?.checked || false;
  let expectedMs;
  if (engine === 'sf3d') {
    expectedMs = preset.expectedMs + triPreset.extraMs;
  } else if (engine === 'triposg') {
    // TripoSG full pipeline: geo ~30s + decim + xatlas + texture_project ~90s
    expectedMs = 150000;
  } else if (engine === 'hi3dgen') {
    // Hi3DGen full pipeline (with MV-Adapter 6 views):
    //   - Hi3DGen inference: ~30s
    //   - xatlas unwrap on 200K verts: ~45s
    //   - MV-Adapter 6 views (RealVisXL + adapter): ~60s
    //   - texture_project bake at 1024 (6 views): ~60s
    // Total ~3-4 min for complex meshes, ~2 min for simple.
    expectedMs = 240000;
  } else if (engine === 'meshy') {
    expectedMs = 240000;
  } else {
    expectedMs = 60000;
  }
  if (buildStages) expectedMs *= 2.5;
  const params = {
    imagePath: p.selectedImagePath,
    imagePathBack: p.backImagePath || null,  // 2-view mode if set
    outputName: p.name,
    engine,
    textureSize: preset.tex,
    targetFaces: preset.verts,
    effort: 2,
    buildStages,
    subdivide: triPreset.subdivide,
    vramFraction: (gpuLimits?.vram || 90) / 100,
  };
  const qualityLabels = { draft: 'Draft', standard: 'Standard', high: 'High' };
  const jobParams = {
    Engine: engineLabel(engine),
    Quality: qualityLabels[quality] || quality,
    'Target triangles': triPreset.label,
    'Source image': p.selectedImagePath ? p.selectedImagePath.split(/[/\\]/).pop() : '--',
  };
  gatedRun('mesh', `Generate 3D: ${p.name}`, async () => {
    const job = pushJob(`Generate 3D: ${p.name}`, null, jobParams, expectedMs);
    try {
      const r = await API.imageTo3D(params);
      if (r?.success) {
        // Show mesh stats in the job details before completing
        if (r.meshVerts || r.meshFaces) {
          job.params = {
            ...job.params,
            'Vertices': r.meshVerts ? r.meshVerts.toLocaleString() : '?',
            'Triangles': r.meshFaces ? r.meshFaces.toLocaleString() : '?',
            'File size': r.size ? `${(r.size / 1024).toFixed(0)} KB` : '?',
          };
        }
        completeJob(job.id, true);
        await reloadCurrentProject();
      } else {
        completeJob(job.id, false, r?.error || 'unknown');
        if (!job.cancelled) reportPipelineError(r?.error, '3D generation failed');
      }
    } catch (e) {
      completeJob(job.id, false, e?.error || e?.message || String(e));
      if (!job.cancelled) reportPipelineError(e?.error || e?.message || String(e), '3D generation error');
    }
  });
});

// ----- Mesh edit tools -----
function getCurrentMeshObj() {
  const p = state.currentProject;
  if (!p) return null;
  const path_ = p.previewMeshPath || p.selectedMeshPath;
  if (!path_) return null;
  return p.meshes.find(m => m.path === path_) || null;
}

document.getElementById('ws-mesh-blender-btn')?.addEventListener('click', async () => {
  const m = getCurrentMeshObj();
  if (!m) { showToast('Pick a mesh first.', 'error'); return; }
  try {
    if (API.openInBlender) {
      const r = await API.openInBlender({ meshPath: m.path });
      if (!r?.success) {
        customError(r?.error || 'unknown', 'Open in Blender failed');
      }
    } else {
      // Fallback: reveal in explorer
      await API.showInExplorer(m.path);
    }
  } catch (e) { customError(e?.message || String(e), 'Open in Blender failed'); }
});

document.getElementById('ws-mesh-folder-btn')?.addEventListener('click', async () => {
  const m = getCurrentMeshObj();
  if (!m) { showToast('Pick a mesh first.', 'error'); return; }
  try { await API.showInExplorer(m.path); } catch (e) { alert(e.message); }
});

document.getElementById('ws-mesh-refine-btn')?.addEventListener('click', () => {
  const m = getCurrentMeshObj();
  if (!m) { showToast('Pick a mesh first.', 'error'); return; }
  document.getElementById('rfn-prompt').value = '';
  document.getElementById('modal-refine-mesh').classList.remove('hidden');
  setTimeout(() => document.getElementById('rfn-prompt').focus(), 50);
});
document.getElementById('rfn-cancel')?.addEventListener('click', () => {
  document.getElementById('modal-refine-mesh').classList.add('hidden');
});
document.getElementById('rfn-go')?.addEventListener('click', async () => {
  const p = state.currentProject;
  const m = getCurrentMeshObj();
  if (!p || !m) return;
  const modification = document.getElementById('rfn-prompt').value.trim();
  if (!modification) { showToast('Type a modification first.', 'error'); return; }
  const format = document.getElementById('rfn-format').value;
  const model = document.getElementById('rfn-model').value;
  document.getElementById('modal-refine-mesh').classList.add('hidden');
  // Refine doesn't load a heavy local model (uses Claude CLI + Blender), so
  // it's classified as 'rig' (light VRAM cost)
  gatedRun('rig', `Refine mesh: ${p.name}`, async () => {
    const job = pushJob(`Refine mesh: ${p.name}`, null, {
      Modification: modification,
      Format: format,
      'AI model': model,
      'Source mesh': m.filename,
    });
    try {
      const r = await API.refineMesh({ projectName: p.name, modification, format, model, jobId: job.id });
      if (r?.success || r?.meshPath) {
        completeJob(job.id, true);
        await reloadCurrentProject();
      } else {
        completeJob(job.id, false);
        if (!job.cancelled) customError(r?.error || 'unknown', 'Refine failed');
      }
    } catch (e) {
      completeJob(job.id, false);
      if (!job.cancelled) customError(e?.error || e?.message || String(e), 'Refine error');
    }
  });
});

// ============================================================
// MESH TOOLS — automated operations
// ============================================================
async function runMeshTool(operation, params = []) {
  const p = state.currentProject;
  if (!p || !p.selectedMeshPath) { showToast('Pick a mesh first.', 'error'); return; }
  const meshPath = p.selectedMeshPath;
  showToast(`Running ${operation}...`, 'info', 2000);
  try {
    const result = await API.meshTool({ operation, meshPath, params });
    if (result && result.success) {
      showToast(`${operation} done!`, 'success');
      // Refresh mesh list
      populateWorkspace(p);
    } else {
      showToast(`${operation} failed: ${(result && result.error) || 'unknown'}`, 'error', 5000);
    }
  } catch (e) {
    showToast(`${operation} error: ${e.message}`, 'error', 5000);
  }
}

document.getElementById('ws-mesh-smooth-btn')?.addEventListener('click', () => runMeshTool('smooth', ['3', '0.5']));
document.getElementById('ws-mesh-decimate-btn')?.addEventListener('click', () => runMeshTool('decimate', ['5000']));
document.getElementById('ws-mesh-subdivide-btn')?.addEventListener('click', () => runMeshTool('subdivide', ['1']));
document.getElementById('ws-mesh-fixnormals-btn')?.addEventListener('click', () => runMeshTool('fix_normals'));
document.getElementById('ws-mesh-fillholes-btn')?.addEventListener('click', () => runMeshTool('fill_holes'));
document.getElementById('ws-mesh-center-btn')?.addEventListener('click', () => runMeshTool('center'));
document.getElementById('ws-mesh-retexture-btn')?.addEventListener('click', () => {
  const p = state.currentProject;
  if (!p || !p.selectedImagePath) { showToast('Pick a source image first.', 'error'); return; }
  runMeshTool('retexture', [p.selectedImagePath, '2048']);
});

// ============================================================
// ALIGN TEXTURE TOOL — manual position/scale/rotation of source
// photos onto the mesh (texture_project re-projection with sliders).
// ============================================================
const atState = {
  renderer: null,
  scene: null,
  camera: null,
  controls: null,
  mesh: null,
  overlayFront: null,   // front photo plane
  overlayBack: null,    // back photo plane
  meshHeight: 1,        // mesh Y-extent (used to size overlay)
  overlayDistance: 1,   // mesh half-size for plane positioning
  activeSide: 'front',  // which overlay is currently being adjusted
  // Per-side transforms (so switching FRONT/BACK restores values)
  transforms: {
    front: { tx: 0, ty: 0, tz: 0, sc: 1.0, ry: 0 },
    back:  { tx: 0, ty: 0, tz: 0, sc: 1.0, ry: 0 },
  },
  // Projective texture shader state
  projectiveMats: [],   // materials we injected (for cleanup/toggle)
  origMaterials: [],    // original materials of mesh submeshes
  frontTex: null,
  backTex: null,
};

async function _atInitViewport() {
  const canvas = document.getElementById('at-preview-canvas');
  const wrap = document.getElementById('at-preview-canvas-wrap');
  if (!canvas || !wrap) return;
  // Force a layout flush so flex sizing is computed before we measure
  void wrap.offsetWidth;
  let w = wrap.clientWidth || 800;
  let h = wrap.clientHeight || 560;
  if (w < 50 || h < 50) {
    // Layout not ready yet; defer one frame
    await new Promise(r => requestAnimationFrame(r));
    w = wrap.clientWidth || 800;
    h = wrap.clientHeight || 560;
  }
  console.log('[align-tex] viewport size', w, h);
  if (!atState.renderer) {
    atState.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    atState.renderer.setSize(w, h, false);
    atState.renderer.setPixelRatio(window.devicePixelRatio);
    atState.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    atState.renderer.toneMappingExposure = 1.0;
    atState.scene = new THREE.Scene();
    atState.scene.background = new THREE.Color(0x1b1b1b);
    atState.camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 100);
    atState.camera.position.set(0, 0.4, 2.0);
    try {
      atState.controls = new OrbitControls(atState.camera, canvas);
      atState.controls.enableDamping = true;
    } catch (e) {
      try {
        const { OrbitControls: OC } = await import('./lib/controls/OrbitControls.js');
        atState.controls = new OC(atState.camera, canvas);
        atState.controls.enableDamping = true;
      } catch (_) { /* ignore */ }
    }
    atState.scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.0));
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(5, 8, 5);
    atState.scene.add(dir);
    atState.scene.add(new THREE.AmbientLight(0xffffff, 0.3));
    function tick() {
      if (!document.getElementById('modal-align-texture')?.classList.contains('hidden')) {
        if (atState.controls) atState.controls.update();
        atState.renderer.render(atState.scene, atState.camera);
      }
      requestAnimationFrame(tick);
    }
    tick();
  } else {
    atState.renderer.setSize(w, h, false);
    atState.camera.aspect = w / h;
    atState.camera.updateProjectionMatrix();
  }
}

async function _atLoadMesh(meshPath) {
  if (!atState.scene) return;
  if (atState.mesh) {
    atState.scene.remove(atState.mesh);
    atState.mesh.traverse?.(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (o.material.map) o.material.map.dispose();
        o.material.dispose();
      }
    });
    atState.mesh = null;
  }
  // Dispose previous overlays so reopening the modal starts fresh.
  for (const k of ['overlayFront', 'overlayBack']) {
    const ov = atState[k];
    if (ov) {
      atState.scene.remove(ov);
      ov.geometry?.dispose();
      if (ov.material?.map) ov.material.map.dispose();
      ov.material?.dispose();
      atState[k] = null;
    }
  }
  // Dispose shared textures + projective shader state from previous mesh
  for (const k of ['frontTex', 'backTex']) {
    if (atState[k]) { atState[k].dispose(); atState[k] = null; }
  }
  for (const pm of atState.projectiveMats || []) pm.dispose();
  atState.projectiveMats = [];
  atState.origMaterials = [];
  const status = document.getElementById('at-preview-status');
  if (status) { status.textContent = 'Loading mesh...'; status.style.display = 'block'; }
  try {
    const { GLTFLoader } = await import('./lib/loaders/GLTFLoader.js');
    const loader = new GLTFLoader();
    // Read file via fs (Electron file:// works via fetch in renderer with full path)
    const url = 'file:///' + meshPath.replace(/\\/g, '/');
    const cacheBuster = '?t=' + Date.now();
    console.log('[align-tex] loading mesh from', url + cacheBuster);
    loader.load(url + cacheBuster, (gltf) => {
      console.log('[align-tex] mesh loaded', gltf);
      const obj = gltf.scene || gltf.scenes[0];
      // Center + frame mesh
      const box = new THREE.Box3().setFromObject(obj);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3()).length();
      obj.position.sub(center);
      atState.mesh = obj;
      atState.scene.add(obj);
      // Compute mesh dims for overlay plane sizing/positioning
      const bsize = box.getSize(new THREE.Vector3());
      atState.meshHeight = bsize.y;
      // overlayDistance = half-depth of mesh bounding box (Z).
      // Plane sits exactly in front of mesh (+Z for front, -Z for back).
      atState.overlayDistance = (bsize.z * 0.5) + 0.01;
      // Frame camera on FRONT view by default (looking down -Z)
      atState.camera.position.set(0, 0, size * 1.4);
      atState.camera.lookAt(0, 0, 0);
      if (atState.controls) {
        atState.controls.target.set(0, 0, 0);
        atState.controls.update();
      }
      if (status) status.style.display = 'none';
      // Re-create / refresh overlay photo planes (front + back)
      _atUpdateOverlay();
    }, (p) => { console.log('[align-tex] progress', p); },
       (err) => {
      console.error('[align-tex] load error', err);
      if (status) {
        status.textContent = 'Load error: ' + (err?.message || err);
        status.style.display = 'block';
      }
    });
  } catch (e) {
    console.error('[align-tex] loader error', e);
    if (status) {
      status.textContent = 'Loader error: ' + (e?.message || e);
      status.style.display = 'block';
    }
  }
}

// =============================================================
// Projective texturing: replace the mesh material with a shader that
// samples the front/back photo textures using orthographic projection
// from +Z (front cam) and -Z (back cam) with per-side TRS.
// The shader picks front or back based on the vertex's world normal:
//   normal.z > 0 -> front texture, normal.z < 0 -> back texture.
// =============================================================
function _atBuildProjectiveMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uFront: { value: atState.frontTex || null },
      uBack:  { value: atState.backTex  || null },
      // front transform: translate + 2D scale + rotY (in UV-style space)
      uFrontTx: { value: 0 },
      uFrontTy: { value: 0 },
      uFrontSc: { value: 1 },
      uFrontRy: { value: 0 },
      uBackTx:  { value: 0 },
      uBackTy:  { value: 0 },
      uBackSc:  { value: 1 },
      uBackRy:  { value: 0 },
      // plane size (world units) = meshHeight
      uPlaneSize: { value: atState.meshHeight || 1 },
      uFallback:  { value: new THREE.Color(0.55, 0.55, 0.55) },
    },
    vertexShader: `
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      uniform sampler2D uFront;
      uniform sampler2D uBack;
      uniform float uFrontTx, uFrontTy, uFrontSc, uFrontRy;
      uniform float uBackTx,  uBackTy,  uBackSc,  uBackRy;
      uniform float uPlaneSize;
      uniform vec3  uFallback;

      // Project world (x,y) onto a plane of uPlaneSize, with TRS.
      // Returns UV in [0,1] or -1 if out-of-bounds.
      // Project world XY -> UV [0,1] of a virtual photo plane.
      // The plane is centered, scaled by sc, translated by (tx,ty),
      // and rotated by ry around its own center.
      // To sample the texture at world point (wp.x, wp.y):
      //   1. Translate world point by -(tx,ty) to undo plane translation
      //   2. Rotate by -ry to undo plane rotation
      //   3. Divide by sc to undo plane scale
      //   4. Map [-planeSize/2, +planeSize/2] -> [0, 1]
      vec2 project(vec3 wp, float tx, float ty, float sc, float ry) {
        // Step 1: undo translation
        float x = wp.x - tx;
        float y = wp.y - ty;
        // Step 2: undo rotation (R(-ry) = R(ry).T)
        float cr = cos(ry), sr = sin(ry);
        float xr = cr * x + sr * y;
        float yr = -sr * x + cr * y;
        // Step 3: undo scale
        xr /= sc; yr /= sc;
        // Step 4: normalize to UV [0,1]
        float u = xr / uPlaneSize + 0.5;
        float v = yr / uPlaneSize + 0.5;
        return vec2(u, v);
      }
      void main() {
        // SF3D meshes have their face at -Z (native convention), so
        // normal.z < 0 means a front-facing surface (camera looking +Z->-Z).
        float nz = vWorldNormal.z;
        vec3 color = uFallback;
        if (nz < 0.0) {
          // FRONT face of mesh: project front photo
          vec2 uv = project(vWorldPos, uFrontTx, uFrontTy, uFrontSc, uFrontRy);
          if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
            color = texture2D(uFront, uv).rgb;
          }
        } else {
          // BACK face of mesh: project back photo (X flipped so left-right
          // not mirrored when seen from behind).
          vec2 uv = project(vec3(-vWorldPos.x, vWorldPos.y, vWorldPos.z),
                            uBackTx, uBackTy, uBackSc, uBackRy);
          if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
            color = texture2D(uBack, uv).rgb;
          }
        }
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
}

function _atApplyProjectiveToMesh(enable) {
  if (!atState.mesh) return;
  if (enable) {
    atState.origMaterials = [];
    atState.projectiveMats = [];
    atState.mesh.traverse(obj => {
      if (obj.isMesh) {
        atState.origMaterials.push({ obj, mat: obj.material });
        const pm = _atBuildProjectiveMaterial();
        atState.projectiveMats.push(pm);
        obj.material = pm;
      }
    });
    _atUpdateProjectiveUniforms();
  } else {
    // Restore original materials
    for (const { obj, mat } of atState.origMaterials) {
      obj.material = mat;
    }
    for (const pm of atState.projectiveMats) pm.dispose();
    atState.origMaterials = [];
    atState.projectiveMats = [];
  }
}

function _atUpdateProjectiveUniforms() {
  if (!atState.projectiveMats.length) return;
  const tf = atState.transforms;
  for (const m of atState.projectiveMats) {
    m.uniforms.uFront.value  = atState.frontTex;
    m.uniforms.uBack.value   = atState.backTex;
    m.uniforms.uFrontTx.value = tf.front.tx;
    m.uniforms.uFrontTy.value = tf.front.ty;
    m.uniforms.uFrontSc.value = tf.front.sc;
    m.uniforms.uFrontRy.value = tf.front.ry;
    m.uniforms.uBackTx.value  = tf.back.tx;
    m.uniforms.uBackTy.value  = tf.back.ty;
    m.uniforms.uBackSc.value  = tf.back.sc;
    m.uniforms.uBackRy.value  = tf.back.ry;
    m.uniforms.uPlaneSize.value = atState.meshHeight;
  }
}

function _atMakeOverlayPlane(imgPath, opacity) {
  const tex = new THREE.TextureLoader().load(
    'file:///' + imgPath.replace(/\\/g, '/') + '?t=' + Date.now()
  );
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, opacity, depthTest: false,
    side: THREE.DoubleSide,
  });
  const geom = new THREE.PlaneGeometry(1, 1);
  const plane = new THREE.Mesh(geom, mat);
  plane.renderOrder = 999;
  return plane;
}

function _atUpdateOverlay() {
  if (!atState.scene) return;
  const p = state.currentProject;
  if (!p || !p.selectedImagePath) return;
  // Load textures (shared with projective shader)
  if (!atState.frontTex) {
    atState.frontTex = new THREE.TextureLoader().load(
      'file:///' + p.selectedImagePath.replace(/\\/g, '/') + '?t=' + Date.now()
    );
    atState.frontTex.colorSpace = THREE.SRGBColorSpace;
  }
  const backPath = p._backPhotos?.[p.selectedImagePath] || p.backImagePath;
  if (backPath && !atState.backTex) {
    atState.backTex = new THREE.TextureLoader().load(
      'file:///' + backPath.replace(/\\/g, '/') + '?t=' + Date.now()
    );
    atState.backTex.colorSpace = THREE.SRGBColorSpace;
  }
  // Front overlay: the project's selected image
  if (!atState.overlayFront) {
    atState.overlayFront = _atMakeOverlayPlane(p.selectedImagePath, 0.55);
    atState.scene.add(atState.overlayFront);
  }
  // Back overlay: the 2-view-generated back photo, if present
  if (backPath && !atState.overlayBack) {
    atState.overlayBack = _atMakeOverlayPlane(backPath, 0.55);
    atState.scene.add(atState.overlayBack);
  }
  _atApplyOverlayTransforms();
  // If live-project is checked, swap mesh material to projective shader
  const liveProj = document.getElementById('at-project-live')?.checked;
  if (liveProj) _atApplyProjectiveToMesh(true);
}

// Apply stored per-side transforms to both overlays. Plane size is based
// on the mesh HEIGHT (Y extent) times scale slider, so the photo covers
// the mesh body at scale=1.
function _atApplyOverlayTransforms() {
  const baseSize = atState.meshHeight || 1;
  const d = atState.overlayDistance || 0.5;
  const apply = (plane, tf, z_sign) => {
    if (!plane) return;
    plane.scale.set(baseSize * tf.sc, baseSize * tf.sc, 1);
    plane.position.set(tf.tx, tf.ty, z_sign * (d + tf.tz));
    // Back plane is rotated 180° around Y so its texture faces the
    // -Z side of the mesh (back of the character).
    plane.rotation.set(0, (z_sign < 0 ? Math.PI : 0) + tf.ry, 0);
  };
  apply(atState.overlayFront, atState.transforms.front, +1);
  apply(atState.overlayBack,  atState.transforms.back,  -1);
}

// Slider input -> update active side transform + re-apply
function _atUpdateOverlayTransform() {
  const side = atState.activeSide;
  const tf = atState.transforms[side];
  tf.tx = parseFloat(document.getElementById('at-tx')?.value) || 0;
  tf.ty = parseFloat(document.getElementById('at-ty')?.value) || 0;
  tf.tz = parseFloat(document.getElementById('at-tz')?.value) || 0;
  tf.sc = parseFloat(document.getElementById('at-scale')?.value) || 1;
  tf.ry = (parseFloat(document.getElementById('at-roty')?.value) || 0)
          * Math.PI / 180;
  _atApplyOverlayTransforms();
  _atUpdateProjectiveUniforms();
}

// Switch which side the sliders control. Loads the stored values for
// that side back into the slider UI.
function _atSetActiveSide(side) {
  if (side !== 'front' && side !== 'back') return;
  atState.activeSide = side;
  const tf = atState.transforms[side];
  document.getElementById('at-tx').value = tf.tx;
  document.getElementById('at-ty').value = tf.ty;
  document.getElementById('at-tz').value = tf.tz;
  document.getElementById('at-scale').value = tf.sc;
  document.getElementById('at-roty').value = (tf.ry * 180 / Math.PI).toFixed(0);
  // Re-trigger value displays
  ['at-tx','at-ty','at-tz','at-scale','at-roty'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.dispatchEvent(new Event('input'));
  });
  // Visual: highlight the active side button
  document.querySelectorAll('#at-side-buttons button[data-side]').forEach(b => {
    b.classList.toggle('tool-active', b.dataset.side === side);
  });
}

function openAlignTexture() {
  const p = state.currentProject;
  if (!p || !p.selectedMeshPath) { showToast('Pick a mesh first.', 'error'); return; }
  if (!p.selectedImagePath) { showToast('Pick a source image first.', 'error'); return; }
  const modal = document.getElementById('modal-align-texture');
  if (!modal) return;
  modal.classList.remove('hidden');
  // Bind slider value displays
  const sync = (id, valId, fmt) => {
    const el = document.getElementById(id);
    const valEl = document.getElementById(valId);
    if (!el || !valEl) return;
    const update = () => { valEl.textContent = fmt(el.value); };
    el.oninput = update;
    update();
  };
  sync('at-tx', 'at-tx-val', v => Number(v).toFixed(2));
  sync('at-ty', 'at-ty-val', v => Number(v).toFixed(2));
  sync('at-tz', 'at-tz-val', v => Number(v).toFixed(2));
  sync('at-scale', 'at-scale-val', v => Number(v).toFixed(2));
  sync('at-roty', 'at-roty-val', v => `${v}\u00B0`);
  sync('at-vis', 'at-vis-val', v => Number(v).toFixed(2));

  // Live preview: move the photo overlay plane as sliders move; the
  // mesh itself stays fixed. The overlay shows where the source photo
  // will project. Actual re-projection on Re-project click.
  ['at-tx', 'at-ty', 'at-tz', 'at-scale', 'at-roty'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', _atUpdateOverlayTransform);
  });
  // Overlay opacity slider
  const opacityEl = document.getElementById('at-opacity');
  const opacityValEl = document.getElementById('at-opacity-val');
  if (opacityEl) {
    const updateOpacity = () => {
      const v = parseFloat(opacityEl.value);
      if (atState.overlay) atState.overlay.material.opacity = v / 100;
      if (opacityValEl) opacityValEl.textContent = `${v}%`;
    };
    opacityEl.addEventListener('input', updateOpacity);
    updateOpacity();
  }
  // View buttons (front/right/back/left/top/bottom/iso)
  document.querySelectorAll('#at-view-buttons button[data-view]').forEach(btn => {
    btn.addEventListener('click', () => _atSetCameraView(btn.dataset.view));
  });
  // Side toggle (which overlay the sliders control)
  document.querySelectorAll('#at-side-buttons button[data-side]').forEach(btn => {
    btn.onclick = () => _atSetActiveSide(btn.dataset.side);
  });
  // Default to FRONT
  _atSetActiveSide('front');
  // Live project toggle
  document.getElementById('at-project-live')?.addEventListener('change', (e) => {
    _atApplyProjectiveToMesh(!!e.target.checked);
  });
  // Show overlay toggle
  document.getElementById('at-show-overlay')?.addEventListener('change', (e) => {
    const visible = !!e.target.checked;
    if (atState.overlayFront) atState.overlayFront.visible = visible;
    if (atState.overlayBack)  atState.overlayBack.visible = visible;
  });
  // Init viewer + load current mesh (must be last, after modal is visible
  // so canvas has real dimensions)
  requestAnimationFrame(async () => {
    console.log('[align-tex] init start, meshPath=', p.selectedMeshPath);
    await _atInitViewport();
    _atLoadMesh(p.selectedMeshPath);
  });
}

function _atSetCameraView(view) {
  if (!atState.camera || !atState.controls) return;
  const d = (atState.overlayDistance || 1) * 2.5;
  const positions = {
    front:  [0, 0, d],
    back:   [0, 0, -d],
    right:  [d, 0, 0],
    left:   [-d, 0, 0],
    top:    [0, d, 0],
    bottom: [0, -d, 0],
    iso:    [d * 0.7, d * 0.6, d * 0.7],
  };
  const pos = positions[view] || positions.front;
  atState.camera.position.set(pos[0], pos[1], pos[2]);
  atState.controls.target.set(0, 0, 0);
  atState.controls.update();
}
document.getElementById('ws-mesh-aligntex-btn')?.addEventListener('click', openAlignTexture);
document.getElementById('at-cancel')?.addEventListener('click', () => {
  document.getElementById('modal-align-texture')?.classList.add('hidden');
});
document.getElementById('at-reset')?.addEventListener('click', () => {
  document.getElementById('at-tx').value = 0;
  document.getElementById('at-ty').value = 0;
  document.getElementById('at-tz').value = 0;
  document.getElementById('at-scale').value = 1.20;
  document.getElementById('at-roty').value = 0;
  document.getElementById('at-vis').value = 0.5;
  document.getElementById('at-autofit').checked = true;
  document.getElementById('at-framefix').checked = true;
  document.getElementById('at-skipvflip').checked = true;
  // Re-trigger value displays
  ['at-tx','at-ty','at-tz','at-scale','at-roty','at-vis'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.dispatchEvent(new Event('input'));
  });
});
document.getElementById('at-reproject')?.addEventListener('click', async () => {
  const p = state.currentProject;
  if (!p || !p.selectedMeshPath || !p.selectedImagePath) {
    showToast('Need both a mesh and a source image', 'error');
    return;
  }
  const params = {
    meshPath: p.selectedMeshPath,
    imagePath: p.selectedImagePath,
    translateX: parseFloat(document.getElementById('at-tx').value),
    translateY: parseFloat(document.getElementById('at-ty').value),
    translateZ: parseFloat(document.getElementById('at-tz').value),
    meshScale: parseFloat(document.getElementById('at-scale').value),
    rotY: parseFloat(document.getElementById('at-roty').value),
    visThresh: parseFloat(document.getElementById('at-vis').value),
    autofit: document.getElementById('at-autofit').checked,
    frameFix: document.getElementById('at-framefix').checked,
    skipVflip: document.getElementById('at-skipvflip').checked,
  };
  const btn = document.getElementById('at-reproject');
  btn.disabled = true;
  btn.textContent = 'Re-projecting...';
  try {
    const res = await API.alignTexture(params);
    if (res?.ok) {
      showToast('Texture re-projected', 'success');
      // Reload mesh in viewer
      if (typeof showStep2Preview === 'function') {
        showStep2Preview({ path: p.selectedMeshPath });
      }
    } else {
      showToast(`Re-project failed: ${res?.error || 'unknown'}`, 'error');
    }
  } catch (e) {
    showToast(`Error: ${e.message || e}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '\uD83C\uDFAF Re-project';
  }
});

// ============================================================
// MESH EDIT TOOLS — Sculpt, Paint, Select (Three.js modal)
// ============================================================
const meState = {
  mode: 'sculpt',        // sculpt | paint | select
  sculptMode: 'push',    // push | pull | smooth | flatten
  brushRadius: 0.05,
  strength: 0.5,
  color: '#ff0000',
  painting: false,
  renderer: null,
  scene: null,
  camera: null,
  controls: null,
  mesh: null,
  meshPath: null,
  raycaster: (() => { const r = new THREE.Raycaster(); r.firstHitOnly = true; return r; })(),
  mouse: new THREE.Vector2(),
  undoStack: [],
  redoStack: [],
};

function openMeshEdit(mode) {
  const p = state.currentProject;
  if (!p || !p.selectedMeshPath) { showToast('Pick a mesh first.', 'error'); return; }
  meState.mode = mode;
  meState.meshPath = p.selectedMeshPath;

  const modal = document.getElementById('modal-mesh-edit');
  const title = document.getElementById('mesh-edit-title');
  if (title) title.textContent = mode === 'sculpt' ? 'Sculpt Mesh' : mode === 'paint' ? 'Vertex Paint' : 'Select Faces';
  modal.classList.remove('hidden');

  // Update tool buttons
  ['sculpt', 'paint', 'select'].forEach(t => {
    document.getElementById('me-tool-' + t)?.classList.toggle('tool-active', t === mode);
  });
  document.getElementById('me-sculpt-opts').style.display = mode === 'sculpt' ? 'flex' : 'none';
  document.getElementById('me-paint-opts').style.display = mode === 'paint' ? 'flex' : 'none';

  // Wait for modal layout then init viewport
  requestAnimationFrame(async () => {
    await _meInitViewport();
    _meLoadMesh(p.selectedMeshPath);
  });
}

async function _meInitViewport() {
  if (meState.renderer) return; // already init
  const container = document.getElementById('me-viewport');
  const canvas = document.getElementById('me-canvas');
  const w = container.clientWidth || 800;
  const h = container.clientHeight || 600;

  meState.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  meState.renderer.setSize(w, h, false);
  meState.renderer.setPixelRatio(window.devicePixelRatio);
  meState.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  meState.renderer.toneMappingExposure = 1.0;

  meState.scene = new THREE.Scene();
  meState.scene.background = new THREE.Color(0x1a1a2e);
  meState.camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 100);
  meState.camera.position.set(0, 0.5, 2);

  try {
    meState.controls = new OrbitControls(meState.camera, canvas);
    meState.controls.enableDamping = true;
  } catch (e) {
    console.error('[mesh-edit] OrbitControls error:', e);
    // Fallback: try from local lib
    try {
      const { OrbitControls: OC } = await import('./lib/controls/OrbitControls.js');
      meState.controls = new OC(meState.camera, canvas);
      meState.controls.enableDamping = true;
    } catch (e2) {
      console.error('[mesh-edit] OrbitControls fallback also failed:', e2);
    }
  }

  // Lights
  meState.scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.0));
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(5, 8, 5);
  meState.scene.add(dir);
  meState.scene.add(new THREE.AmbientLight(0xffffff, 0.3));

  // Grid
  meState.scene.add(new THREE.GridHelper(2, 20, 0x444466, 0x333355));

  // Render loop
  function tick() {
    if (!document.getElementById('modal-mesh-edit')?.classList.contains('hidden')) {
      meState.controls.update();
      meState.renderer.render(meState.scene, meState.camera);
    }
    requestAnimationFrame(tick);
  }
  tick();

  // Resize
  new ResizeObserver(() => {
    const cw = container.clientWidth, ch = container.clientHeight;
    if (cw > 0 && ch > 0) {
      meState.renderer.setSize(cw, ch, false);
      meState.camera.aspect = cw / ch;
      meState.camera.updateProjectionMatrix();
    }
  }).observe(container);

  // Mouse events for brush
  canvas.addEventListener('mousedown', _meMouseDown);
  canvas.addEventListener('mousemove', _meMouseMove);
  canvas.addEventListener('mouseup', _meMouseUp);
}

function _meLoadMesh(meshPath) {
  // Remove old mesh
  if (meState.mesh && meState.scene) {
    meState.scene.remove(meState.mesh);
  }
  meState.undoStack = [];
  meState.redoStack = [];
  _meUpdateUndoBtns();

  const loader = new GLTFLoader();
  const url = 'file:///' + meshPath.replace(/\\/g, '/');
  console.log('[mesh-edit] loading', url);
  fetch(url).then(r => {
    if (!r.ok) throw new Error('fetch failed: ' + r.status);
    return r.arrayBuffer();
  }).then(buffer => {
    console.log('[mesh-edit] buffer size:', buffer.byteLength);
    loader.parse(buffer, '', (gltf) => {
      console.log('[mesh-edit] GLTF parsed, children:', gltf.scene.children.length);
      meState.mesh = gltf.scene;
      _applyMeshTextureFilter(meState.mesh);
      meState.scene.add(meState.mesh);

      // Center and scale
      const box = new THREE.Box3().setFromObject(meState.mesh);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      meState.mesh.position.sub(center);
      meState.mesh.position.y += size.y / 2;
      meState.camera.position.set(0, size.y * 0.5, maxDim * 2);
      meState.controls.target.set(0, size.y * 0.5, 0);

      meState.mesh.traverse(child => {
        if (child.isMesh && child.geometry) {
          child.geometry.computeVertexNormals();
        }
      });
    }, (err) => {
      console.error('[mesh-edit] GLTF parse error:', err);
      showToast('Failed to load mesh: ' + err, 'error');
    });
  }).catch(err => {
    console.error('[mesh-edit] fetch error:', err);
    showToast('Failed to fetch mesh: ' + err.message, 'error');
  });
}

function _meGetIntersection(e) {
  const canvas = document.getElementById('me-canvas');
  const rect = canvas.getBoundingClientRect();
  meState.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  meState.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  meState.raycaster.setFromCamera(meState.mouse, meState.camera);
  if (!meState.mesh) return null;
  const meshes = [];
  meState.mesh.traverse(c => { if (c.isMesh) meshes.push(c); });
  const hits = meState.raycaster.intersectObjects(meshes, false);
  return hits.length > 0 ? hits[0] : null;
}

function _mePushUndo() {
  // Save vertex positions of all meshes
  const snapshot = [];
  meState.mesh?.traverse(c => {
    if (c.isMesh && c.geometry) {
      snapshot.push({
        mesh: c,
        positions: c.geometry.attributes.position.array.slice(),
        colors: c.geometry.attributes.color ? c.geometry.attributes.color.array.slice() : null,
      });
    }
  });
  meState.undoStack.push(snapshot);
  if (meState.undoStack.length > 20) meState.undoStack.shift();
  meState.redoStack = [];
  _meUpdateUndoBtns();
}

function _meUndo() {
  if (meState.undoStack.length === 0) return;
  // Save current for redo
  const current = [];
  meState.mesh?.traverse(c => {
    if (c.isMesh && c.geometry) {
      current.push({
        mesh: c,
        positions: c.geometry.attributes.position.array.slice(),
        colors: c.geometry.attributes.color ? c.geometry.attributes.color.array.slice() : null,
      });
    }
  });
  meState.redoStack.push(current);
  // Restore
  const snapshot = meState.undoStack.pop();
  for (const s of snapshot) {
    s.mesh.geometry.attributes.position.array.set(s.positions);
    s.mesh.geometry.attributes.position.needsUpdate = true;
    if (s.colors && s.mesh.geometry.attributes.color) {
      s.mesh.geometry.attributes.color.array.set(s.colors);
      s.mesh.geometry.attributes.color.needsUpdate = true;
    }
    s.mesh.geometry.computeVertexNormals();
  }
  _meUpdateUndoBtns();
}

function _meUpdateUndoBtns() {
  const u = document.getElementById('me-undo');
  const r = document.getElementById('me-redo');
  if (u) u.disabled = meState.undoStack.length === 0;
  if (r) r.disabled = meState.redoStack.length === 0;
}

function _meMouseDown(e) {
  if (e.button !== 0 || e.altKey) return;
  const hit = _meGetIntersection(e);
  if (!hit) return;
  meState.painting = true;
  _mePushUndo();
  meState.controls.enabled = false;
  _meApplyBrush(hit);
}

let _meLastBrushTime = 0;
function _meMouseMove(e) {
  // Always update cursor position (cheap, no raycasting)
  const cursor = document.getElementById('me-brush-cursor');
  if (cursor) {
    const screenSize = meState.brushRadius * 500;
    cursor.style.width = screenSize + 'px';
    cursor.style.height = screenSize + 'px';
    cursor.style.left = (e.clientX - screenSize / 2) + 'px';
    cursor.style.top = (e.clientY - screenSize / 2) + 'px';
    cursor.style.display = 'block';
  }
  if (!meState.painting) return;
  // Throttle: max 15fps for brush (raycasting is expensive)
  const now = performance.now();
  if (now - _meLastBrushTime < 66) return;
  _meLastBrushTime = now;
  const hit = _meGetIntersection(e);
  if (hit) _meApplyBrush(hit);
}

function _meMouseUp() {
  if (meState.painting) {
    meState.painting = false;
    meState.controls.enabled = true;
    // Recompute normals after sculpt stroke
    meState.mesh?.traverse(c => {
      if (c.isMesh && c.geometry?._normsDirty) {
        c.geometry.computeVertexNormals();
        c.geometry._normsDirty = false;
      }
    });
  }
}

function _meApplyBrush(hit) {
  const geom = hit.object.geometry;
  const pos = geom.attributes.position;
  const normals = geom.attributes.normal;
  const point = hit.point.clone();
  hit.object.worldToLocal(point);

  const r = meState.brushRadius;
  const rSq = r * r;
  const strength = meState.strength;
  const px = point.x, py = point.y, pz = point.z;

  if (meState.mode === 'sculpt') {
    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i);
      const dx = vx - px, dy = vy - py, dz = vz - pz;
      // Fast bounding box reject
      if (Math.abs(dx) > r || Math.abs(dy) > r || Math.abs(dz) > r) continue;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > rSq) continue;
      const dist = Math.sqrt(distSq);
      const falloff = 1 - (dist / r);
      const amount = falloff * falloff * strength * 0.01;

      if (meState.sculptMode === 'push' || meState.sculptMode === 'pull') {
        const nx = normals.getX(i), ny = normals.getY(i), nz = normals.getZ(i);
        const dir = meState.sculptMode === 'push' ? 1 : -1;
        pos.setXYZ(i, vx + nx * amount * dir, vy + ny * amount * dir, vz + nz * amount * dir);
      } else if (meState.sculptMode === 'smooth') {
        // Move vertex toward local average (simplified)
        pos.setXYZ(i, vx * (1 - amount * 0.5) + point.x * amount * 0.5,
                      vy * (1 - amount * 0.5) + point.y * amount * 0.5,
                      vz * (1 - amount * 0.5) + point.z * amount * 0.5);
      } else if (meState.sculptMode === 'flatten') {
        // Project vertex onto the plane defined by hit point + hit normal
        const hn = hit.face.normal.clone();
        hit.object.worldToLocal(hn.add(hit.point)).sub(point);
        const d = dx * hn.x + dy * hn.y + dz * hn.z;
        pos.setXYZ(i, vx - hn.x * d * amount, vy - hn.y * d * amount, vz - hn.z * d * amount);
      }
    }
    pos.needsUpdate = true;
    // Defer normal recompute to mouseup (expensive)
    geom._normsDirty = true;
  } else if (meState.mode === 'paint') {
    // Ensure vertex colors exist
    if (!geom.attributes.color) {
      const colors = new Float32Array(pos.count * 3).fill(1);
      geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      hit.object.material.vertexColors = true;
      hit.object.material.needsUpdate = true;
    }
    const colorAttr = geom.attributes.color;
    const c = new THREE.Color(meState.color);
    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i);
      const dx = vx - px, dy = vy - py, dz = vz - pz;
      if (Math.abs(dx) > r || Math.abs(dy) > r || Math.abs(dz) > r) continue;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > rSq) continue;
      const dist = Math.sqrt(distSq);
      const falloff = 1 - (dist / r);
      const blend = falloff * falloff * strength;
      const cr = colorAttr.getX(i), cg = colorAttr.getY(i), cb = colorAttr.getZ(i);
      colorAttr.setXYZ(i,
        cr * (1 - blend) + c.r * blend,
        cg * (1 - blend) + c.g * blend,
        cb * (1 - blend) + c.b * blend
      );
    }
    colorAttr.needsUpdate = true;
  } else if (meState.mode === 'select') {
    // Highlight face
    const faceIndex = hit.faceIndex;
    if (!geom.attributes.color) {
      const colors = new Float32Array(pos.count * 3).fill(0.7);
      geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      hit.object.material.vertexColors = true;
      hit.object.material.needsUpdate = true;
    }
    const colorAttr = geom.attributes.color;
    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i);
      const dx = vx - px, dy = vy - py, dz = vz - pz;
      if (Math.abs(dx) > r || Math.abs(dy) > r || Math.abs(dz) > r) continue;
      if (dx * dx + dy * dy + dz * dz > rSq) continue;
      colorAttr.setXYZ(i, 1.0, 0.3, 0.1); // orange highlight
    }
    colorAttr.needsUpdate = true;
  }
}

// Close mesh edit
function _closeMeshEdit() {
  document.getElementById('modal-mesh-edit')?.classList.add('hidden');
}

// Wire buttons
document.getElementById('ws-mesh-sculpt-btn')?.addEventListener('click', () => openMeshEdit('sculpt'));
document.getElementById('ws-mesh-paintvert-btn')?.addEventListener('click', () => openMeshEdit('paint'));
document.getElementById('ws-mesh-selectface-btn')?.addEventListener('click', () => openMeshEdit('select'));
document.getElementById('me-close-x')?.addEventListener('click', _closeMeshEdit);
document.getElementById('me-cancel')?.addEventListener('click', _closeMeshEdit);
document.getElementById('me-undo')?.addEventListener('click', _meUndo);

// Mode switching
['sculpt', 'paint', 'select'].forEach(mode => {
  document.getElementById('me-tool-' + mode)?.addEventListener('click', () => {
    meState.mode = mode;
    ['sculpt', 'paint', 'select'].forEach(m => document.getElementById('me-tool-' + m)?.classList.toggle('tool-active', m === mode));
    document.getElementById('me-sculpt-opts').style.display = mode === 'sculpt' ? 'flex' : 'none';
    document.getElementById('me-paint-opts').style.display = mode === 'paint' ? 'flex' : 'none';
    document.getElementById('me-select-opts').style.display = mode === 'select' ? 'flex' : 'none';
  });
});
// Sculpt sub-modes
['push', 'pull', 'smooth', 'flatten'].forEach(sm => {
  document.getElementById('me-sculpt-' + sm)?.addEventListener('click', () => {
    meState.sculptMode = sm;
    ['push', 'pull', 'smooth', 'flatten'].forEach(s => document.getElementById('me-sculpt-' + s)?.classList.toggle('tool-active', s === sm));
  });
});
// Sliders
document.getElementById('me-brush-size')?.addEventListener('input', (e) => {
  meState.brushRadius = parseInt(e.target.value) / 500;
  document.getElementById('me-brush-val').textContent = meState.brushRadius.toFixed(3);
});
document.getElementById('me-strength')?.addEventListener('input', (e) => {
  meState.strength = parseInt(e.target.value) / 100;
  document.getElementById('me-strength-val').textContent = meState.strength.toFixed(2);
});
document.getElementById('me-paint-color')?.addEventListener('input', (e) => {
  meState.color = e.target.value;
});
// Select actions
document.getElementById('me-sel-delete')?.addEventListener('click', () => {
  if (!meState.mesh) return;
  _mePushUndo();
  meState.mesh.traverse(c => {
    if (!c.isMesh || !c.geometry?.attributes?.color) return;
    const geom = c.geometry;
    const pos = geom.attributes.position;
    const color = geom.attributes.color;
    // Find selected vertices (orange = r>0.9, g<0.5)
    const keep = [];
    if (geom.index) {
      const idx = geom.index.array;
      for (let i = 0; i < idx.length; i += 3) {
        const a = idx[i], b = idx[i+1], ci2 = idx[i+2];
        const sel = (color.getX(a) > 0.9 && color.getY(a) < 0.5) ||
                    (color.getX(b) > 0.9 && color.getY(b) < 0.5) ||
                    (color.getX(ci2) > 0.9 && color.getY(ci2) < 0.5);
        if (!sel) keep.push(a, b, ci2);
      }
      geom.setIndex(keep);
    }
    geom.attributes.position.needsUpdate = true;
  });
  showToast('Selected faces deleted', 'success', 1500);
});
document.getElementById('me-sel-invert')?.addEventListener('click', () => {
  meState.mesh?.traverse(c => {
    if (!c.isMesh || !c.geometry?.attributes?.color) return;
    const color = c.geometry.attributes.color;
    for (let i = 0; i < color.count; i++) {
      const isSelected = color.getX(i) > 0.9 && color.getY(i) < 0.5;
      if (isSelected) color.setXYZ(i, 0.7, 0.7, 0.7);
      else color.setXYZ(i, 1.0, 0.3, 0.1);
    }
    color.needsUpdate = true;
  });
});
document.getElementById('me-sel-clear')?.addEventListener('click', () => {
  meState.mesh?.traverse(c => {
    if (!c.isMesh || !c.geometry?.attributes?.color) return;
    const color = c.geometry.attributes.color;
    for (let i = 0; i < color.count; i++) color.setXYZ(i, 0.7, 0.7, 0.7);
    color.needsUpdate = true;
    c.material.vertexColors = false;
    c.material.needsUpdate = true;
  });
});
// Keyboard
document.addEventListener('keydown', (e) => {
  const modal = document.getElementById('modal-mesh-edit');
  if (!modal || modal.classList.contains('hidden')) return;
  if (e.key === 'Escape') _closeMeshEdit();
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); _meUndo(); }
});
// Save
document.getElementById('me-save')?.addEventListener('click', async () => {
  if (!meState.mesh || !meState.meshPath) return;
  showToast('Saving new version...', 'info', 2000);
  try {
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    const exporter = new GLTFExporter();
    exporter.parse(meState.mesh, async (result) => {
      try {
        const buf = result instanceof ArrayBuffer ? new Uint8Array(result) : new Uint8Array(result);
        // Build path: same directory as original mesh, with _edited_ suffix
        const origName = meState.meshPath.replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '');
        const meshDir = meState.meshPath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
        const newPath = meshDir + '/' + origName + '_edited_' + Date.now() + '.glb';
        // Send as base64 to avoid IPC array length limit
        let binary = '';
        const bytes = buf;
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        const b64 = btoa(binary);
        const r = await API.saveBuffer({ path: newPath, base64: b64 });
        if (r && r.success) {
          showToast('Edited mesh saved!', 'success');
          // Add to project mesh list
          const p = state.currentProject;
          if (p) {
            const filename = newPath.replace(/\\/g, '/').split('/').pop();
            const info = await API.getFileInfo(newPath);
            p.meshes.unshift({
              path: newPath,
              filename,
              size: info?.size || 0,
              mtime: Date.now(),
            });
          }
          _closeMeshEdit();
          populateWorkspace(state.currentProject);
        } else {
          showToast('Save failed: ' + ((r && r.error) || 'unknown'), 'error');
        }
      } catch (err) {
        console.error('[mesh-edit] save error:', err);
        showToast('Save error: ' + err.message, 'error');
      }
    }, (err) => {
      showToast('Export error: ' + err, 'error');
    }, { binary: true });
  } catch (err) {
    showToast('Export failed: ' + err.message, 'error');
  }
});

document.getElementById('ws-mesh-export-btn')?.addEventListener('click', () => {
  const m = getCurrentMeshObj();
  if (!m) { showToast('Pick a mesh first.', 'error'); return; }
  const modal = document.getElementById('modal-export-mesh');
  document.getElementById('exp-path').value = '';
  document.getElementById('exp-path').placeholder = '(default: meshes/' + m.filename.replace(/\.[^.]+$/, '') + '.<ext>)';
  modal.classList.remove('hidden');
});
document.getElementById('exp-cancel')?.addEventListener('click', () => {
  document.getElementById('modal-export-mesh').classList.add('hidden');
});
document.getElementById('exp-browse')?.addEventListener('click', async () => {
  const m = getCurrentMeshObj();
  if (!m) return;
  const format = document.getElementById('exp-format').value;
  const defaultName = m.filename.replace(/\.[^.]+$/, '');
  if (!API.pickExportPath) return;
  const picked = await API.pickExportPath({ defaultName, format });
  if (picked) document.getElementById('exp-path').value = picked;
});
document.getElementById('exp-go')?.addEventListener('click', async () => {
  const m = getCurrentMeshObj();
  if (!m) return;
  const format = document.getElementById('exp-format').value;
  const outputPath = document.getElementById('exp-path').value.trim() || null;
  document.getElementById('modal-export-mesh').classList.add('hidden');
  // Prefer the original GLB as the source whenever possible. If the user
  // selected a previously-exported FBX version (which may have broken texture
  // references pointing to a missing .fbm sidecar), look for a sibling GLB
  // with the same base name and use that instead — textures are embedded in
  // GLBs, so re-exports always start from a clean source.
  let sourcePath = m.path;
  if (/\.fbx$/i.test(sourcePath)) {
    const p = state.currentProject;
    const baseName = m.filename.replace(/\.[^.]+$/, '');
    const glbSibling = (p?.meshes || []).find(x => x.filename === baseName + '.glb');
    if (glbSibling) {
      console.log('[export] re-routing source from FBX to sibling GLB:', glbSibling.path);
      sourcePath = glbSibling.path;
    }
  }
  const job = pushJob(`Export ${format}: ${m.filename}`);
  try {
    const r = await API.exportMesh({ sourcePath, targetFormat: format, outputPath });
    const outPath = r?.outputPath || r?.path;
    if (outPath) {
      completeJob(job.id, true);
      try { await API.showInExplorer(outPath); } catch (e) {}
    } else {
      completeJob(job.id, false);
      customError(r?.error || 'Export returned no output path', 'Export failed');
    }
  } catch (e) {
    completeJob(job.id, false);
    const msg = e?.error || e?.message || String(e);
    customError(msg, 'Export error');
  }
});

// ----- Rig step -----
async function loadRigTemplatesIntoSelect() {
  // The template dropdown was removed from the UI in favor of AI rigging
  // (UniRig / Meshy). Keep the function as a no-op so the existing call sites
  // don't break.
  const sel = document.getElementById('ws-rig-template');
  if (!sel) return;
  if (sel.dataset.loaded) return;
  try {
    const tpls = await API.listRigTemplates();
    sel.innerHTML = '';
    // Shape: { skm: [...], generic: [...] } OR a flat array (legacy)
    const skm = (tpls && tpls.skm) || [];
    const generic = (tpls && tpls.generic) || [];
    const flat = Array.isArray(tpls) ? tpls : [];
    const all = [...skm, ...generic, ...flat];
    if (all.length === 0) {
      sel.innerHTML = '<option value="">No templates found</option>';
      return;
    }
    // Templates carry an `id` (alphanum-underscore, valid for the backend) and
    // a `name` (display label, may contain spaces). Always use `id` as the value.
    function makeOpt(t) {
      const opt = document.createElement('option');
      opt.value = t.id || t.name || t.filename || t;
      opt.textContent = t.name || t.label || t.id || t.filename || t;
      return opt;
    }
    if (skm.length > 0) {
      const group = document.createElement('optgroup');
      group.label = 'SKM templates';
      skm.forEach(t => group.appendChild(makeOpt(t)));
      sel.appendChild(group);
    }
    if (generic.length > 0) {
      const group = document.createElement('optgroup');
      group.label = 'Generic templates';
      generic.forEach(t => group.appendChild(makeOpt(t)));
      sel.appendChild(group);
    }
    if (skm.length === 0 && generic.length === 0) {
      flat.forEach(t => sel.appendChild(makeOpt(t)));
    }
    sel.dataset.loaded = '1';
  } catch (e) {
    console.error('loadRigTemplatesIntoSelect failed:', e);
    sel.innerHTML = '<option value="">Error loading templates</option>';
  }
}

// ----- Step 3 viewer (rigged FBX) -----
let rigVwRenderer, rigVwScene, rigVwCamera, rigVwControls, rigVwModel;
let rigVwMixer = null;
let rigVwClips = [];
let rigVwActiveAction = null;
let rigVwLastTime = 0;
function initRigViewer() {
  if (rigVwRenderer) return;
  const canvas = document.getElementById('ws-rig-canvas');
  if (!canvas) return;
  // The rig viewer has an animation mixer that must update each frame,
  // so we use Viewer3D with an onBeforeRender hook.
  const _rvV = new Viewer3D({
    canvas, fov: 45, bgColor: 0x1d1d2c, far: 5000, cameraPos: [2, 2, 3],
    lighting: true,
    onBeforeRender: () => {
      const now = performance.now() / 1000;
      const dt = Math.min(0.1, now - (rigVwLastTime || now));
      rigVwLastTime = now;
      if (rigVwMixer) rigVwMixer.update(dt);
    },
  });
  rigVwRenderer = _rvV.renderer;
  rigVwScene = _rvV.scene;
  rigVwCamera = _rvV.camera;
  rigVwControls = _rvV.controls;
  _rvV.startTickLoop();
}

async function showStep3Preview(rig) {
  const placeholder = document.getElementById('step3-placeholder');
  setViewerFilename('ws-rig-filename', rig?.path || rig?.filename);
  if (!rig) {
    if (placeholder) placeholder.style.display = '';
    if (rigVwModel && rigVwScene) { rigVwScene.remove(rigVwModel); rigVwModel = null; }
    return;
  }
  initRigViewer();
  if (placeholder) placeholder.style.display = 'none';
  const expandBtn = document.getElementById('ws-rig-expand-btn');
  if (expandBtn) {
    expandBtn.classList.remove('hidden');
    expandBtn.onclick = (e) => { e.stopPropagation(); openMeshLightbox(rig.path); };
  }
  if (rigVwModel) { rigVwScene.remove(rigVwModel); rigVwModel = null; }
  // Reset previous animation state
  if (rigVwMixer) { rigVwMixer.stopAllAction(); rigVwMixer = null; }
  rigVwClips = [];
  rigVwActiveAction = null;
  populateRigAnimDropdown([]);
  const ext = (rig.filename || '').toLowerCase().split('.').pop();
  // Infer the rig template name from the filename: <base>_rigged_<template>_<ts>.fbx
  // → captures things like "orc_m1", "ue5_mannequin", "humanoid".
  let inferredTemplate = null;
  const _tplMatch = rig.filename && rig.filename.match(/_rigged_([a-z0-9_-]+?)(?:_\d{10,})?\.[^.]+$/i);
  if (_tplMatch) inferredTemplate = _tplMatch[1];
  try {
    if (ext === 'fbx') {
      // FBXLoader needs a URL because it loads textures relative to the file
      const url = 'file:///' + rig.path.replace(/\\/g, '/');
      const loader = new FBXLoader();
      loader.load(url, async (obj) => {
        rigVwModel = obj;
        rigVwScene.add(rigVwModel);
        // Disable frustum culling on all meshes (FBX bbox is computed from
        // the rest pose, skinning animation can move vertices outside it
        // which causes the mesh to disappear silently).
        let skinnedCount = 0;
        obj.traverse(c => {
          c.frustumCulled = false;
          if (c.isSkinnedMesh) {
            skinnedCount++;
            // Force Three.js to reset the bind to the current rest pose of
            // the skeleton. This fixes FBXLoader bindMatrix mismatches seen
            // with rigs exported after armature_apply in Blender.
            c.pose();
          }
        });
        console.log('[rig] found', skinnedCount, 'SkinnedMesh(es) in FBX');
        try {
          const _sm2 = obj.getObjectByProperty('isSkinnedMesh', true);
          if (_sm2) {
            const _parents = [];
            let _p = _sm2.parent;
            while (_p) { _parents.push(_p.name || '(unnamed)'); _p = _p.parent; }
            const _msg = 'SkinnedMesh parents=' + JSON.stringify(_parents) +
              ' bonesParent=' + (_sm2.skeleton?.bones?.[0]?.parent?.name || 'none');
            API.rendererLog && API.rendererLog({ tag: 'rig-load', msg: _msg });
          }
        } catch(_e) {}
        try {
          const _sm = obj.getObjectByProperty('isSkinnedMesh', true);
          if (_sm) {
            const _bb = new THREE.Box3().setFromObject(_sm);
            const _sz = _bb.getSize(new THREE.Vector3());
            console.log('[rig] SkinnedMesh bbox size:', _sz.x.toFixed(3), _sz.y.toFixed(3), _sz.z.toFixed(3));
            const _sk = _sm.skeleton;
            if (_sk && _sk.bones && _sk.bones.length > 0) {
              const _bmin = new THREE.Vector3(1e9,1e9,1e9);
              const _bmax = new THREE.Vector3(-1e9,-1e9,-1e9);
              _sk.bones.forEach(b => {
                const p = new THREE.Vector3();
                b.getWorldPosition(p);
                _bmin.min(p); _bmax.max(p);
              });
              console.log('[rig] skeleton bbox min:', _bmin.x.toFixed(1), _bmin.y.toFixed(1), _bmin.z.toFixed(1),
                          'max:', _bmax.x.toFixed(1), _bmax.y.toFixed(1), _bmax.z.toFixed(1));
            }
          }
        } catch(e) { console.warn('[rig] debug bbox failed', e); }
        fitRigVwCamera(rigVwModel);
        // Set up the animation mixer if the FBX has clips
        rigVwMixer = new THREE.AnimationMixer(obj);
        rigVwClips = (obj.animations || []).slice();
        if (rigVwClips.length > 0) {
          console.log('[rig] using', rigVwClips.length, 'embedded animation clip(s):', rigVwClips.map(c => c.name));
        }
        // Fallback: if the rig FBX has no embedded animations (legacy rigs),
        // load external animation FBX files for this template.
        if (rigVwClips.length === 0 && inferredTemplate && API.listRigAnimations) {
          try {
            const animFiles = await API.listRigAnimations({ templateName: inferredTemplate });
            if (animFiles && animFiles.length > 0) {
              const fbxLoader2 = new FBXLoader();
              for (const af of animFiles) {
                await new Promise((resolveLoad) => {
                  const aurl = 'file:///' + af.path.replace(/\\/g, '/');
                  fbxLoader2.load(aurl, (animObj) => {
                    if (animObj.animations && animObj.animations.length > 0) {
                      animObj.animations.forEach((clip, ci) => {
                        // Use the file name as the clip label for the dropdown
                        clip.name = af.name + (animObj.animations.length > 1 ? `_${ci}` : '');
                        rigVwClips.push(clip);
                      });
                    }
                    resolveLoad();
                  }, undefined, (err) => {
                    console.warn('External anim load failed for', af.name, err);
                    resolveLoad();
                  });
                });
              }
            }
          } catch (e) {
            console.warn('listRigAnimations failed:', e);
          }
        }
        populateRigAnimDropdown(rigVwClips);
      }, undefined, (err) => {
        console.error('FBX load error', err);
        if (placeholder) {
          placeholder.style.display = '';
          placeholder.textContent = 'Failed to load rig: ' + (err?.message || err);
        }
      });
    } else if (ext === 'glb' || ext === 'gltf') {
      const buffer = await API.readMeshFile(rig.path);
      if (!buffer) return;
      const loader = new GLTFLoader();
      loader.parse(buffer, '', (gltf) => {
        rigVwModel = gltf.scene;
        _applyMeshTextureFilter(rigVwModel);
        let skinnedCount = 0;
        // Add model to scene FIRST (like the FBX path) so that
        // updateMatrixWorld propagates correct bone world matrices.
        rigVwScene.add(rigVwModel);

        rigVwModel.traverse(c => {
          c.frustumCulled = false;
          if (c.isSkinnedMesh) {
            skinnedCount++;
            if (c.skeleton) {
              // Log bind state for debugging
              const bm = c.bindMatrix?.elements;
              const _msg = `bindMode=${c.bindMode} bones=${c.skeleton.bones.length} boneInverses=${c.skeleton.boneInverses.length} bindMatrix=[${bm ? bm.slice(0,4).map(v=>v.toFixed(2)) : 'null'}...]`;
              console.log('[rig] SkinnedMesh:', _msg);
              try { API.rendererLog && API.rendererLog({ tag: 'rig-skin', msg: _msg }); } catch(_) {}
              // Check if any boneInverse is all-zeros (broken)
              let zeroCount = 0;
              for (const bi of c.skeleton.boneInverses) {
                const e = bi.elements;
                if (Math.abs(e[0]) + Math.abs(e[5]) + Math.abs(e[10]) < 0.001) zeroCount++;
              }
              console.log('[rig] zero boneInverses:', zeroCount, '/', c.skeleton.boneInverses.length);
              try { API.rendererLog && API.rendererLog({ tag: 'rig-skin', msg: 'zeroBoneInverses=' + zeroCount + '/' + c.skeleton.boneInverses.length }); } catch(_) {}
              // Check skinIndex + skinWeight attributes on the geometry
              const geo = c.geometry;
              const hasSkinIdx = !!(geo?.attributes?.skinIndex);
              const hasSkinWt = !!(geo?.attributes?.skinWeight);
              const vtxCount = geo?.attributes?.position?.count || 0;
              let nonZeroWeights = 0;
              if (hasSkinWt) {
                const sw = geo.attributes.skinWeight;
                for (let i = 0; i < Math.min(sw.count, 200); i++) {
                  const sum = Math.abs(sw.getX(i)) + Math.abs(sw.getY(i)) + Math.abs(sw.getZ(i)) + Math.abs(sw.getW(i));
                  if (sum > 0.001) nonZeroWeights++;
                }
              }
              const matType = c.material?.type || 'unknown';
              const skinMsg = `skinIndex=${hasSkinIdx} skinWeight=${hasSkinWt} verts=${vtxCount} nonZeroWeightsIn200=${nonZeroWeights} material=${matType} morphTargets=${!!geo?.morphAttributes?.position}`;
              console.log('[rig]', skinMsg);
              try { API.rendererLog && API.rendererLog({ tag: 'rig-skin', msg: skinMsg }); } catch(_) {}
              // Check max skinIndex vs bone count
              if (hasSkinIdx) {
                const si = geo.attributes.skinIndex;
                let maxIdx = 0;
                for (let i = 0; i < Math.min(si.count, 1000); i++) {
                  maxIdx = Math.max(maxIdx, si.getX(i), si.getY(i), si.getZ(i), si.getW(i));
                }
                const idxMsg = `maxSkinIndex(first1000)=${maxIdx} vs bones=${c.skeleton.bones.length}`;
                console.log('[rig]', idxMsg);
                try { API.rendererLog && API.rendererLog({ tag: 'rig-skin', msg: idxMsg }); } catch(_) {}
              }

              // ── Fix GLB skinning deformation ──
              // The GLTFLoader binds with an identity bindMatrix; in
              // "attached" mode Three.js recomputes bindMatrixInverse
              // from the mesh's matrixWorld each frame.  For this to
              // produce correct rest-pose offsets the bone LOCAL
              // transforms must be consistent with the boneInverses
              // stored in the GLTF.  pose() enforces that (same as
              // the FBX path at line ~2525).
              c.pose();
              // Normalize skin weights (guards against malformed exports).
              c.normalizeSkinWeights();
              // Propagate world matrices now that the model is in the
              // scene graph so skeleton.update() computes real offsets.
              rigVwModel.updateMatrixWorld(true);
              // Eagerly create the bone DataTexture and fill it with
              // correct rest-pose data so the very first rendered
              // frame is not stale.
              c.skeleton.computeBoneTexture();
              c.skeleton.update();

              // Verify bone matrixWorld is not identity
              const b0 = c.skeleton.bones[0];
              if (b0) {
                const wm = b0.matrixWorld.elements;
                const b0msg = `bone0(${b0.name}) worldMat=[${wm.slice(12,15).map(v=>v.toFixed(2))}]`;
                console.log('[rig]', b0msg);
                try { API.rendererLog && API.rendererLog({ tag: 'rig-skin', msg: b0msg }); } catch(_) {}
              }
            }
          }
        });
        console.log('[rig] GLB loaded — SkinnedMesh count=', skinnedCount);
        try { API.rendererLog && API.rendererLog({ tag: 'rig-load', msg: 'GLB SkinnedMesh count=' + skinnedCount + ' animations=' + (gltf.animations?.length || 0) }); } catch(_) {}
        rigVwMixer = new THREE.AnimationMixer(rigVwModel);
        rigVwClips = (gltf.animations || []).slice();
        // Skip external anim fallback for GLB — baked anims are in the file
        populateRigAnimDropdown(rigVwClips);
        fitRigVwCamera(rigVwModel);
      });
    } else {
      if (placeholder) {
        placeholder.style.display = '';
        placeholder.textContent = 'Unsupported format: ' + ext;
      }
    }
  } catch (e) {
    console.error('showStep3Preview error', e);
  }
}

function populateRigAnimDropdown(clips) {
  const sel = document.getElementById('ws-rig-anim-select');
  const bar = document.getElementById('ws-rig-anim-bar');
  if (!sel || !bar) return;
  sel.innerHTML = '';
  if (!clips || clips.length === 0) {
    sel.innerHTML = '<option value="">No animation embedded</option>';
    bar.classList.add('hidden');
    return;
  }
  clips.forEach((c, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = c.name || `Clip ${i}`;
    sel.appendChild(opt);
  });
  bar.classList.remove('hidden');
}

document.getElementById('ws-rig-anim-play')?.addEventListener('click', () => {
  if (!rigVwMixer || rigVwClips.length === 0) return;
  const sel = document.getElementById('ws-rig-anim-select');
  const idx = parseInt(sel.value || '0');
  const clip = rigVwClips[idx];
  if (!clip) return;
  if (rigVwActiveAction && rigVwActiveAction.isRunning()) {
    rigVwActiveAction.stop();
    document.getElementById('ws-rig-anim-play').innerHTML = '\u25B6 Play';
    return;
  }
  rigVwMixer.stopAllAction();
  rigVwActiveAction = rigVwMixer.clipAction(clip);
  rigVwActiveAction.reset();
  rigVwActiveAction.setLoop(THREE.LoopRepeat, Infinity);
  rigVwActiveAction.play();
  document.getElementById('ws-rig-anim-play').innerHTML = '\u23F8 Pause';
  // Debug diagnostics written to logs/fabmesh.log (renderer-log IPC)
  try {
    const _log = (m) => { try { API.rendererLog && API.rendererLog({ tag: 'rig-play', msg: m }); } catch (_) {} console.log('[rig-play]', m); };
    const _sm = (() => { let _found = null; rigVwModel?.traverse?.(c => { if (!_found && c.isSkinnedMesh) _found = c; }); return _found; })();
    if (!_sm) { _log('NO SkinnedMesh found in rigVwModel'); }
    else {
      const _sk = _sm.skeleton;
      const _b0 = _sk?.bones?.[0];
      const _qBefore = _b0 ? _b0.quaternion.clone() : null;
      const _clipTracks = clip.tracks.length;
      const _trackNames = clip.tracks.slice(0, 5).map(t => t.name);
      _log('clip=' + clip.name + ' tracks=' + _clipTracks + ' bones=' + (_sk?.bones?.length || 0));
      _log('firstBone=' + (_b0?.name) + ' bindMode=' + _sm.bindMode);
      _log('sampleTracks=' + JSON.stringify(_trackNames));
      if (_clipTracks > 0) {
        const _t = clip.tracks[0];
        const _boneName = _t.name.split('.')[0];
        const _found = _sk.bones.find(b => b.name === _boneName);
        _log('track0 targets ' + _boneName + ' resolved=' + !!_found);
        // Check all tracks: how many resolve to actual bones?
        const _resolved = clip.tracks.filter(t => {
          const bn = t.name.split('.')[0];
          return _sk.bones.some(b => b.name === bn);
        }).length;
        _log('resolved tracks ' + _resolved + '/' + _clipTracks);
      }
      setTimeout(() => {
        if (!_b0 || !_qBefore) return;
        const _qAfter = _b0.quaternion;
        const _dq = Math.abs(_qBefore.x - _qAfter.x) + Math.abs(_qBefore.y - _qAfter.y) + Math.abs(_qBefore.z - _qAfter.z) + Math.abs(_qBefore.w - _qAfter.w);
        _log('after 300ms firstBone quaternionDelta=' + _dq.toFixed(5) + (_dq < 1e-5 ? ' STATIC' : ' MOVING'));
      }, 300);
    }
  } catch(e) { console.warn('[rig-play] debug failed', e); }
});
document.getElementById('ws-rig-anim-select')?.addEventListener('change', () => {
  // Stop the previous action when switching clips
  if (rigVwActiveAction) {
    rigVwActiveAction.stop();
    rigVwActiveAction = null;
    document.getElementById('ws-rig-anim-play').innerHTML = '\u25B6 Play';
  }
});

function fitRigVwCamera(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  const sizeVec = box.getSize(new THREE.Vector3());
  const size = sizeVec.length();
  const center = box.getCenter(new THREE.Vector3());
  // Translate so the rig sits on y=0
  obj.position.x -= center.x;
  obj.position.z -= center.z;
  obj.position.y -= box.min.y;
  const lookY = sizeVec.y * 0.5;
  // Far plane high enough for FBX rigs in cm scale
  rigVwCamera.far = Math.max(rigVwCamera.far, size * 100);
  rigVwCamera.updateProjectionMatrix();
  rigVwCamera.position.set(size * 1.2, size * 0.8 + lookY, size * 1.2);
  rigVwCamera.lookAt(0, lookY, 0);
  rigVwControls.target.set(0, lookY, 0);
  rigVwControls.update();
  // Show + refresh the toolbar
  const tb = document.getElementById('ws-rig-toolbar');
  if (tb) tb.classList.remove('hidden');
  if (typeof wsRigControls !== 'undefined' && wsRigControls) {
    setTimeout(() => wsRigControls.refreshAll(), 50);
  }
}

function renderRigVersions(p) {
  const strip = document.getElementById('ws-rig-versions');
  strip.innerHTML = '';
  p.rigs.forEach((r, i) => {
    const t = document.createElement('div');
    t.className = 'version-thumb';
    if (i === 0) t.classList.add('selected');
    let thumbSrc = '';
    if (r.thumb) {
      thumbSrc = r.thumb.startsWith('file:') ? r.thumb : 'file:///' + r.thumb.replace(/\\/g, '/');
    } else if (r.sourceImage) {
      thumbSrc = 'file:///' + r.sourceImage.replace(/\\/g, '/');
    } else if (p.thumb) {
      thumbSrc = 'file:///' + p.thumb.replace(/\\/g, '/');
    }
    t.innerHTML = `
      ${thumbSrc ? `<img src="${thumbSrc}" alt="">` : ''}
      <span class="v-label">v${p.rigs.length - 1 - i}</span>
      <button class="version-delete-btn" title="Delete this rig">&#10005;</button>
    `;
    t.title = r.filename;
    t.addEventListener('click', () => {
      strip.querySelectorAll('.version-thumb').forEach(x => x.classList.remove('selected'));
      t.classList.add('selected');
      showStep3Preview(r);
    });
    t.querySelector('.version-delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!await customConfirm(`Delete rig v${p.rigs.length - 1 - i}? This cannot be undone.`, 'Delete rig version')) return;
      await API.deleteMesh(r.filename);
      await reloadCurrentProject();
    });
    strip.appendChild(t);
  });
}

// ----- Rig edit tools -----
function getCurrentRigObj() {
  const p = state.currentProject;
  if (!p || p.rigs.length === 0) return null;
  // Use the first selected rig (default = latest)
  const sel = document.querySelector('#ws-rig-versions .version-thumb.selected');
  if (sel) {
    const idx = Array.from(sel.parentElement.children).indexOf(sel);
    return p.rigs[idx] || p.rigs[0];
  }
  return p.rigs[0];
}

document.getElementById('ws-rig-folder-btn')?.addEventListener('click', async () => {
  const r = getCurrentRigObj();
  if (!r) { showToast('No rig yet.', 'error'); return; }
  try { await API.showInExplorer(r.path); } catch (e) { alert(e.message); }
});

document.getElementById('ws-rig-blender-btn')?.addEventListener('click', async () => {
  const r = getCurrentRigObj();
  if (!r) { showToast('No rig yet.', 'error'); return; }
  try {
    if (API.openInBlender) {
      const res = await API.openInBlender({ meshPath: r.path });
      if (!res?.success) customError(res?.error || 'unknown', 'Edit in Blender failed');
    } else {
      await API.showInExplorer(r.path);
    }
  } catch (e) { customError(e?.message || String(e), 'Edit in Blender failed'); }
});

document.getElementById('ws-rig-unreal-btn')?.addEventListener('click', async () => {
  const r = getCurrentRigObj();
  if (!r) { showToast('No rig yet.', 'error'); return; }
  const job = pushJob(`Export to Unreal: ${r.filename}`);
  try {
    if (!API.exportToUnreal) {
      completeJob(job.id, false);
      customError('Unreal export not available', 'Unreal export');
      return;
    }
    const result = await API.exportToUnreal({ sourcePath: r.path });
    if (result?.success || result?.outputPath) {
      completeJob(job.id, true);
      try { await API.showInExplorer(result.outputPath || r.path); } catch (e) {}
    } else {
      completeJob(job.id, false);
      if (!job.cancelled) customError(result?.error || 'unknown', 'Unreal export failed');
    }
  } catch (e) {
    completeJob(job.id, false);
    if (!job.cancelled) customError(e?.error || e?.message || String(e), 'Unreal export error');
  }
});

// Test animation button: plays the rig's embedded animation directly inside
// the in-app rig viewer (Three.js AnimationMixer) — no Blender spawn.
// If multiple clips are embedded, plays the first one and scrolls the user
// to the animation toolbar so they can pick a different clip.
document.getElementById('ws-rig-test-btn')?.addEventListener('click', () => {
  const r = getCurrentRigObj();
  if (!r) { showToast('No rig yet.', 'error'); return; }
  if (!rigVwMixer || rigVwClips.length === 0) {
    customError('This rig has no embedded animations to play. Re-generate the rig with an animated template, or use a clip-bearing FBX.', 'Test animation');
    return;
  }
  // Reuse the play button's existing logic by clicking it programmatically
  const playBtn = document.getElementById('ws-rig-anim-play');
  const sel = document.getElementById('ws-rig-anim-select');
  if (sel && (!sel.value || sel.value === '')) sel.value = '0';
  // If currently playing, clicking again pauses (matches the play button toggle)
  if (playBtn) playBtn.click();
  // Make sure the animation bar is visible to the user
  const bar = document.getElementById('ws-rig-anim-bar');
  if (bar) {
    bar.classList.remove('hidden');
    bar.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
});

// Legacy template-based rig path. The #ws-generate-rig button was removed from
// the UI in favor of the unified AI "Generate Rig" button above, but we keep
// the click handler (guarded) in case a legacy build or test harness still
// dispatches a click on it. `ws-rig-template`, `ws-rig-skin-method`, etc. are
// allowed to be null and default to safe values.
document.getElementById('ws-generate-rig')?.addEventListener('click', async () => {
  const p = state.currentProject;
  if (!p) return;
  const meshPathToUse = p.selectedMeshPath
    || (p.meshes && p.meshes[0] && p.meshes[0].path)
    || rigSrcMeshPath;
  if (!meshPathToUse) { alert('No mesh available — generate or pick one first.'); return; }
  const tpl = document.getElementById('ws-rig-template')?.value || '';
  if (!tpl) { alert('Pick a rig template.'); return; }
  const skinMethod = document.getElementById('ws-rig-skin-method')?.value || 'auto';
  const skinSmoothing = parseInt(document.getElementById('ws-rig-skin-smooth')?.value) || 3;
  const mirrorX = document.getElementById('ws-rig-mirror-x')?.checked;
  // If no landmarks are placed yet, run the auto-detect now so the user sees
  // them on the source mesh and can correct them via Manual before clicking
  // Generate Rig again. This replaces the old "Auto-place landmarks" checkbox:
  // we always send landmarks from the renderer now, generated client-side
  // either by auto-detect or by the user's manual/guided placement.
  if (Object.keys(lmMarkers).length === 0) {
    try { autoDetectLandmarks(); } catch (e) { console.warn('autoDetect before rig failed:', e); }
  }
  // Convert marker world positions to NORMALIZED (0..1) coordinates inside
  // the source mesh's bbox. This avoids any coordinate-space mismatch on the
  // Python side: the bridge re-scales them to the loaded mesh bbox before
  // aiming the bones, regardless of whether the FBX/GLB units are m or cm
  // and regardless of any centering applied in the viewer.
  const refModel = (rigSrcModel || lmFsModel || wsModel);
  let bboxMin = null, bboxMax = null;
  if (refModel) {
    const bb = new THREE.Box3().setFromObject(refModel);
    bboxMin = bb.min; bboxMax = bb.max;
  }
  function _normalize(p) {
    if (!bboxMin || !bboxMax) return [p.x, p.y, p.z];
    const dx = bboxMax.x - bboxMin.x || 1;
    const dy = bboxMax.y - bboxMin.y || 1;
    const dz = bboxMax.z - bboxMin.z || 1;
    return [
      (p.x - bboxMin.x) / dx,
      (p.y - bboxMin.y) / dy,
      (p.z - bboxMin.z) / dz,
    ];
  }
  const lmData = {};
  for (const id in lmMarkers) {
    const m = lmMarkers[id];
    lmData[id] = _normalize(m.position);
  }
  // Add a flag so the bridge knows these are normalized values
  lmData.__normalized__ = true;
  // Auto-rig estimate: depends on skinning method
  let rigExpected = 60000; // auto weights ~1 min
  if (skinMethod === 'heat') rigExpected = 120000; // heat diffusion ~2 min
  if (skinMethod === 'voxel') rigExpected = 180000; // voxel ~3 min
  gatedRun('rig', `Auto-rig: ${p.name}`, async () => {
    const job = pushJob(`Auto-rig: ${p.name}`, null, {
      Template: tpl,
      Skinning: skinMethod,
      Smoothing: skinSmoothing,
      'Mirror X': mirrorX ? 'yes' : 'no',
      Landmarks: Object.keys(lmData).length > 0 ? `${Object.keys(lmData).length} placed` : 'auto',
      'Source mesh': meshPathToUse.split(/[/\\]/).pop(),
    }, rigExpected);
    try {
      const r = await API.autoRig({
        meshPath: meshPathToUse,
        templateName: tpl,
        skinMethod, skinSmoothing, mirrorX,
        landmarks: lmData, // always send — populated client-side by auto-detect or manual placement
        jobId: job.id,
      });
      if (r?.success) {
        completeJob(job.id, true);
        await reloadCurrentProject();
        // Focus the rig card: collapse sibling cards, close Create new, open
        // Edit selected (which shows the freshly-generated rig), smooth-scroll
        // + pulse. Mirrors the image→mesh and mesh→rig transitions.
        const rigCard = document.getElementById('step-card-rig');
        if (rigCard) {
          rigCard.classList.remove('collapsed', 'disabled');
          document.getElementById('step-card-image')?.classList.add('collapsed');
          document.getElementById('step-card-mesh')?.classList.add('collapsed');
          const createStage = rigCard.querySelector('.stage-create');
          const editStage = rigCard.querySelector('.stage-edit');
          if (createStage) createStage.open = false;
          if (editStage) editStage.open = true;
          setTimeout(() => {
            rigCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
            rigCard.classList.add('pulse-highlight');
            setTimeout(() => rigCard.classList.remove('pulse-highlight'), 1500);
          }, 120);
        }
      } else {
        completeJob(job.id, false);
        if (!job.cancelled) customError(r?.error || 'unknown', 'Rig failed');
      }
    } catch (e) {
      completeJob(job.id, false);
      if (!job.cancelled) customError(e?.error || e?.message || String(e), 'Rig error');
    }
  });
});

// AUTO-RIG AI button handler — engine selected via #ws-rig-engine (unirig | meshy)
document.getElementById('ws-generate-rig-ai')?.addEventListener('click', async () => {
  const p = state.currentProject;
  if (!p) return;
  const meshPathToUse = p.selectedMeshPath
    || (p.meshes && p.meshes[0] && p.meshes[0].path)
    || rigSrcMeshPath;
  if (!meshPathToUse) { alert('No mesh available — generate or pick one first.'); return; }
  if (!API.autoRigAI) { alert('Rigging bridge not available.'); return; }
  const rigEngine = document.getElementById('ws-rig-engine')?.value || 'unirig';
  const engineLabel = rigEngine === 'meshy' ? 'Meshy.ai (cloud)' : 'UniRig (local, neural)';
  const expectedMs = rigEngine === 'meshy' ? 120000 : 90000;
  gatedRun('rig', `Auto-rig AI: ${p.name}`, async () => {
    const job = pushJob(`Auto-rig AI (${rigEngine}): ${p.name}`, null, {
      Engine: engineLabel,
      'Source mesh': meshPathToUse.split(/[/\\]/).pop(),
    }, expectedMs);
    try {
      const r = await API.autoRigAI({ meshPath: meshPathToUse, engine: rigEngine });
      if (r?.success) {
        completeJob(job.id, true);
        await reloadCurrentProject();
        const rigCard = document.getElementById('step-card-rig');
        if (rigCard) {
          rigCard.classList.remove('collapsed', 'disabled');
          document.getElementById('step-card-image')?.classList.add('collapsed');
          document.getElementById('step-card-mesh')?.classList.add('collapsed');
          const createStage = rigCard.querySelector('.stage-create');
          const editStage = rigCard.querySelector('.stage-edit');
          if (createStage) createStage.open = false;
          if (editStage) editStage.open = true;
          setTimeout(() => {
            rigCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
            rigCard.classList.add('pulse-highlight');
            setTimeout(() => rigCard.classList.remove('pulse-highlight'), 1500);
          }, 120);
        }
      } else {
        completeJob(job.id, false, r?.error || 'unknown');
        if (!job.cancelled) reportPipelineError(r?.error, 'Auto-rig AI failed');
      }
    } catch (e) {
      completeJob(job.id, false, e?.error || e?.message || String(e));
      if (!job.cancelled) reportPipelineError(e?.error || e?.message || String(e), 'Auto-rig AI error');
    }
  });
});

// ============================================================
// HELPER: reload current project from disk
// ============================================================
async function reloadCurrentProject() {
  if (!state.currentProject) return;
  const name = state.currentProject.name;
  const sanitizedName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  await refreshProjectsPage();
  // Try exact match first, then sanitized match (spaces → underscores)
  const refreshed = state.projects.find(p => p.name === name)
    || state.projects.find(p => p.name === sanitizedName)
    || state.projects.find(p => p.name.replace(/[^a-zA-Z0-9_-]/g, '_') === sanitizedName);
  if (refreshed) console.log('[reload] matched project:', refreshed.name, 'for requested:', name);
  else console.log('[reload] NO MATCH for project:', name, '(sanitized:', sanitizedName, ') in:', state.projects.map(p => p.name).slice(0, 10));
  if (refreshed) {
    refreshed._reloadTs = Date.now();
    // Carry over multiview data + 2-view back photos (not on disk in
    // a way reload would naturally pick up — they live in _backphotos/
    // and are referenced by per-image map state)
    if (state.currentProject._multiviews) refreshed._multiviews = state.currentProject._multiviews;
    if (state.currentProject._backPhotos) refreshed._backPhotos = state.currentProject._backPhotos;
    state.currentProject = refreshed;
    console.log('[reload] images:', refreshed.images?.length, 'meshes:', refreshed.meshes?.length);
    populateWorkspace(refreshed);

    // Open "Edit selected" stage for steps that have content.
    // Use a short timeout (not rAF) so populateWorkspace's own rAFs finish first.
    setTimeout(() => {
      const steps = [
        { id: 'step-card-image', has: refreshed.images?.length > 0 },
        { id: 'step-card-mesh',  has: refreshed.meshes?.length > 0 },
        { id: 'step-card-rig',   has: refreshed.rigs?.length > 0 },
      ];
      for (const s of steps) {
        if (!s.has) continue;
        const card = document.getElementById(s.id);
        if (!card) continue;
        card.classList.remove('collapsed', 'disabled');
        const createStage = card.querySelector('.stage-create');
        const editStage = card.querySelector('.stage-edit');
        if (createStage) createStage.open = false;
        if (editStage) editStage.open = true;
      }
      // Check multiview after the stage is opened (previewImagePath is now set)
      _checkMultiviewForCurrentImage();
    }, 150);

    _checkMultiviewForCurrentImage();
  }
  // If the user just edited a multi-view, offer to regenerate the others.
  // Deferred so the reload UI settles first.
  setTimeout(_offerMultiviewRegenerate, 250);
}

// ============================================================
// JOBS BUBBLE
// ============================================================
// Expected duration per job kind, in ms — used to fake a smooth progress bar.
// Values are calibrated against real observed runs on a 16 GB RTX 5080
// with torch 2.7.1+cu128. If you see the progress bar reach 90% and stall
// for a long time, bump the matching value here.
const JOB_EXPECTED_MS = {
  'image':   30000,   // ~30 s for a 1-image RealVisXL batch at 25 steps
  'img2img': 30000,
  'bg':      8000,
  'mesh':    90000,   // ~90 s for TripoSR 512 + bake_texture (baked UV)
  'rig':     120000,  // ~2 min: UniRig skel + swap + voxel skin + anims bake
  'inpaint': 180000,
};

function inferKind(name) {
  const n = name.toLowerCase();
  if (n.includes('inpaint') || n.includes('mask')) return 'inpaint';
  if (n.includes('3d') || n.includes('mesh')) return 'mesh';
  if (n.includes('rig')) return 'rig';
  if (n.includes('background')) return 'bg';
  if (n.includes('modify') || n.includes('img2img')) return 'img2img';
  return 'image';
}

// Subscribe ONCE to stdout progress markers from the Python bridges so
// the job progress bar reflects actual work instead of a fake time-based
// climb. Bridges emit lines like:
//   LOCAL_TRIPOSR_PROGRESS: 65 some_label
// We parse the integer and clamp the matching running job to at least
// that value.
if (!window.__fabmesh_ai3d_listener_installed && window.meshyAPI && window.meshyAPI.onAI3DProgress) {
  window.__fabmesh_ai3d_listener_installed = true;
  // Match ONLY bridge-level overall emitters (LOCAL_SF3D_PROGRESS,
  // LOCAL_TRIPOSR_PROGRESS, LOCAL_TRIPOSG_PROGRESS, LOCAL_MESHY_PROGRESS,
  // LOCAL_IMG_PROGRESS, LOCAL_JUGG_PROGRESS, LOCAL_REALVIS_PROGRESS).
  // The previous regex `/_PROGRESS:/` also matched MULTIVIEW_PROGRESS and
  // TEXTURE_*_PROGRESS that sub-scripts emit via slog.progress(). Those
  // are sub-phase percentages (0-100 *within* multiview, not overall), so
  // treating them as overall snapped the bar to ~90% as soon as multiview
  // finished — hiding the full refine phase (the "stuck at 90%" bug).
  const PROG_RE = /\bLOCAL_[A-Z0-9_]+_PROGRESS:\s*(\d{1,3})/;
  // Sub-script lines are forwarded by the bridge with a "LOCAL_SF3D: " prefix;
  // we must NOT scrape their embedded sub-phase percentages. The bridge
  // already re-emits a remapped LOCAL_SF3D_PROGRESS: line for those.
  const SUB_PREFIX = 'LOCAL_SF3D: ';
  window.meshyAPI.onAI3DProgress((msg) => {
    try {
      if (!msg || typeof msg !== 'string') return;
      // DIAGNOSTIC: log every chunk containing a progress marker, with the
      // matched value — reveals whether the bar stalls because the bridge
      // sent nothing, or because the renderer rejected a line, or because
      // main.js batched updates. Filter to progress-relevant chunks so the
      // console doesn't drown.
      if (msg.indexOf('_PROGRESS:') !== -1 || msg.indexOf('FABMESH_SUBPCT') !== -1) {
        console.log('[progress-diag]', Date.now(), JSON.stringify(msg.slice(0, 300)));
      }
      // Ignore sub-phase raw percentages — the bridge already remaps those
      // into proper LOCAL_SF3D_PROGRESS overall values. Without this guard
      // a 99% FABMESH_SUBPCT (tile 6/6 of refine) would incorrectly snap
      // the bar to 99% while the overall slice only covers 60..99.
      if (msg.indexOf('FABMESH_SUBPCT') !== -1) return;
      // msg may be a multi-line chunk — parse line by line so sub-script
      // forwarded lines (prefixed `LOCAL_SF3D: `) don't leak their inner
      // `MULTIVIEW_PROGRESS` values as fake overall percentages.
      const lines = msg.split(/\r?\n/);
      let reported = -1;
      for (const rawLine of lines) {
        if (!rawLine) continue;
        // Forwarded sub-script lines: the bridge prefixes them with
        // "LOCAL_SF3D: " before printing. Their embedded *_PROGRESS
        // markers are SUB-PHASE values — skip.
        if (rawLine.startsWith(SUB_PREFIX)) continue;
        const mm = PROG_RE.exec(rawLine);
        if (mm) {
          const v = parseInt(mm[1], 10);
          console.log('[progress-diag] matched line:', rawLine.trim(), '-> v=', v);
          if (v > reported) reported = v;
        } else if (rawLine.indexOf('_PROGRESS:') !== -1) {
          console.log('[progress-diag] NO MATCH but has _PROGRESS:', rawLine.trim());
        }
      }
      if (reported < 0) return;
      reported = Math.max(0, Math.min(99, reported));
      // Synthesize a match object so the downstream code path (which used
      // to read `m`) still compiles. We only need `reported` below.
      const m = [null, String(reported)];
      if (!m) return;
      // Apply to the most recent running job whose kind is mesh/rig —
      // bridges that emit these markers are all in the 3D/rig pipeline.
      for (let i = state.jobs.length - 1; i >= 0; i--) {
        const j = state.jobs[i];
        if (j.status === 'running' && (j.kind === 'mesh' || j.kind === 'rig')) {
          // Mark that we've seen a real bridge progress event. Once the
          // bridge starts reporting, the local smooth-climb timer should
          // stop fighting it: its cap at 90 hides the refine phase (60-99)
          // that now emits real values, so the bar would sit at 90% for
          // minutes even though the bridge is actively moving.
          j.bridgeReporting = true;
          if (reported > j.progress) {
            j.progress = reported;
            renderJobs();
          }
          break;
        }
      }
    } catch (e) { /* ignore */ }
  });
}

// Expose jobs API on window so classic-script helpers (index2-edit-tools.js)
// can push/complete jobs in the same queue the rest of the app uses.
// Because index2.js is an ES module, plain `function foo()` declarations
// don't land on `window`; we wire them up explicitly below after definition.
function pushJob(name, onCancel, params, expectedMsOverride) {
  const id = ++state.jobIdCounter;
  const kind = inferKind(name);
  const expected = (typeof expectedMsOverride === 'number' && expectedMsOverride > 0)
    ? expectedMsOverride
    : (JOB_EXPECTED_MS[kind] || 60000);
  const job = {
    id,
    name,
    kind,
    progress: 5,
    status: 'running',
    startedAt: Date.now(),
    expectedMs: expected,
    onCancel: onCancel || null,
    tickTimer: null,
    params: params || null,
  };
  // Smoothly climb from 5 to 90% over expected duration UNTIL the bridge
  // starts emitting real progress events. After that, the bridge is the
  // single source of truth (it reaches 99% gradually across multi-view,
  // SF3D, UV projection, and SDXL refine). The old behaviour kept the
  // timer running to 90% and hid the bridge's more accurate values —
  // producing the "jumps to 97% then stalls" feel the user complained
  // about: the bar was the timer, not the pipeline.
  // IMPORTANT: never DECREASE progress — real values always win.
  job.bridgeReporting = false;
  job.tickTimer = setInterval(() => {
    if (job.status !== 'running') { clearInterval(job.tickTimer); return; }
    if (job.bridgeReporting) return; // bridge is driving the bar now
    const elapsed = Date.now() - job.startedAt;
    const estimated = Math.min(90, 5 + (elapsed / expected) * 85);
    job.progress = Math.max(job.progress, estimated);
    renderJobs();
  }, 800);
  state.jobs.push(job);
  renderJobs();
  // Auto-open the details modal so the user sees the live progress + cancel button
  // without having to click the bubble in the corner.
  try { openJobDetails(id); } catch (e) {}
  return job;
}

function completeJob(id, success, errorMessage) {
  const j = state.jobs.find(j => j.id === id);
  if (!j) return;
  if (j.tickTimer) { clearInterval(j.tickTimer); j.tickTimer = null; }
  j.progress = 100;
  j.status = success ? 'done' : 'error';
  if (!success && errorMessage) {
    j.errorMessage = String(errorMessage);
  }
  renderJobs();
  // Failed jobs linger longer than successful ones so the user has time to
  // open the details modal and click the recovery button (e.g. "Open Settings"
  // when a Meshy API key is missing).
  const ttl = success ? 4000 : 30000;
  setTimeout(() => {
    state.jobs = state.jobs.filter(x => x.id !== id);
    renderJobs();
  }, ttl);
}

// Export jobs API for classic-script helpers (index2-edit-tools.js).
// - push: create a job right now (no gating) — use for lightweight or already-gated work
// - enqueue: go through the VRAM/GPU/RAM gate, queue if limits exceeded — use for heavy GPU work
// - complete: mark a job done/error + optional error message
// - render: force a UI redraw of the jobs panel
window.fabmeshJobs = {
  push: (name, onCancel, params, expectedMs) => pushJob(name, onCancel, params, expectedMs),
  enqueue: (kind, name, runFn) => enqueueJob(kind, name, runFn),
  complete: (id, success, errorMessage) => completeJob(id, success, errorMessage),
  render: () => renderJobs(),
};

async function cancelJob(id) {
  const j = state.jobs.find(j => j.id === id);
  if (!j) return;
  if (j.status !== 'running') return;
  const ok = await customConfirm(`Cancel "${j.name}"? The current operation will be stopped.`, 'Cancel job', 'Cancel job');
  if (!ok) return;
  // Mark the job as cancelled BEFORE killing the process so the awaiting
  // promise can detect the cancellation and skip the error popup
  j.cancelled = true;
  if (j.tickTimer) { clearInterval(j.tickTimer); j.tickTimer = null; }
  j.status = 'error';
  j.progress = 100;
  j.name += ' (cancelled)';
  renderJobs();
  // If the IPC supports cancellation, fire it
  try {
    if (API.cancelJob) await API.cancelJob(id);
  } catch (e) { console.warn('cancelJob IPC failed:', e); }
  if (j.onCancel) {
    try { j.onCancel(); } catch (e) {}
  }
  setTimeout(() => {
    state.jobs = state.jobs.filter(x => x.id !== id);
    renderJobs();
  }, 3000);
}
window._cancelJob = cancelJob;

function renderJobs() {
  const bubble = document.getElementById('jobs-bubble-2');
  const panel = document.getElementById('jobs-panel-2');
  const runningCount = state.jobs.filter(j => j.status === 'running').length;
  const queuedCount = queuedJobs.length;
  const totalCount = state.jobs.length + queuedCount;
  const badgeText = queuedCount > 0 ? `${runningCount}+${queuedCount}` : String(runningCount);
  document.getElementById('jobs-bubble-count-2').textContent = badgeText;
  if (totalCount === 0) {
    bubble.classList.add('hidden');
    panel.classList.add('hidden');
    return;
  }
  // Always show the bubble when there are active or queued jobs and the panel
  // is closed — this was the bug: queued jobs were invisible because they
  // weren't in state.jobs and the bubble only appeared for state.jobs.length > 0.
  if (panel.classList.contains('hidden')) {
    bubble.classList.remove('hidden');
  }
  const list = document.getElementById('jobs-list-2');
  // Active jobs
  let html = state.jobs.map(j => {
    const pct = Math.round(j.progress);
    const canCancel = j.status === 'running';
    return `
      <div class="job-item-2 ${j.status}" data-job-id="${j.id}">
        <div class="job-item-2-header">
          <div class="job-item-2-name">${escapeHtml(j.name)}</div>
          ${canCancel ? `<button class="job-cancel-btn" onclick="event.stopPropagation(); window._cancelJob(${j.id})" title="Cancel job">&#10005;</button>` : ''}
        </div>
        <div class="job-item-2-bar">
          <div class="job-item-2-bar-fill" style="width:${pct}%"></div>
        </div>
        <div class="job-item-2-pct">${pct}%</div>
      </div>
    `;
  }).join('');
  // Queued jobs (waiting for VRAM/GPU headroom)
  if (queuedCount > 0) {
    html += queuedJobs.map((q, idx) => `
      <div class="job-item-2 queued">
        <div class="job-item-2-header">
          <div class="job-item-2-name">&#9202; ${escapeHtml(q.displayName || 'Queued job')}</div>
          <button class="job-cancel-btn" onclick="event.stopPropagation(); window._cancelQueuedJob(${idx})" title="Remove from queue">&#10005;</button>
        </div>
        <div class="job-item-2-bar">
          <div class="job-item-2-bar-fill queued-fill" style="width:0%"></div>
        </div>
        <div class="job-item-2-pct" style="color:var(--text-2);">queued</div>
      </div>
    `).join('');
  }
  list.innerHTML = html;
  // Bind click on each active job item to open the details modal
  list.querySelectorAll('.job-item-2[data-job-id]').forEach(el => {
    el.addEventListener('click', () => {
      const id = parseInt(el.dataset.jobId);
      openJobDetails(id);
    });
  });
  // If the details modal is open and showing this job, refresh its values too
  if (state._jobDetailsOpenId) {
    refreshJobDetailsModal(state._jobDetailsOpenId);
  }
}
// Cancel a queued job (remove from the queue before it ever starts)
window._cancelQueuedJob = function(idx) {
  if (idx >= 0 && idx < queuedJobs.length) {
    const removed = queuedJobs.splice(idx, 1);
    console.log('[queue] removed queued job:', removed[0]?.displayName);
    renderQueueIndicator();
    renderJobs();
  }
};

// ----- Job details modal -----
let _jobGpuTimer = null;
async function refreshJobGpuMonitor() {
  if (!API.checkGPU) return;
  // Skip the IPC round-trip if the window is not visible — saves CPU when
  // the user has the app in the background while a long job runs.
  if (document.visibilityState === 'hidden') return;
  try {
    const gpu = await API.checkGPU();
    if (!gpu || !gpu.available) return;
    const vram = document.getElementById('jgm-vram');
    const util = document.getElementById('jgm-util');
    const temp = document.getElementById('jgm-temp');
    // Convert the 0-100 slider positions to the same units shown next to
    // each line so the limit and the current value are directly comparable.
    const vramLimitPct  = Math.round(gpuLimits?.vram ?? 90);
    const vramLimitGB   = (gpu.totalGB * vramLimitPct / 100);
    const utilLimitPct  = Math.round(gpuLimits?.util ?? 95);
    // Temperature slider uses the same 30-100°C mapping as the tooltip
    const tempLimitC    = Math.round(30 + ((gpuLimits?.temp ?? 80) / 100) * 70);
    if (vram) {
      const vramPct = (gpu.usedGB / gpu.totalGB) * 100;
      vram.textContent = `${gpu.usedGB.toFixed(1)} / ${vramLimitGB.toFixed(0)}`;
      vram.classList.remove('warn', 'error');
      if (vramPct > vramLimitPct) vram.classList.add('error');
      else if (vramPct > 70) vram.classList.add('warn');
    }
    if (util) {
      util.textContent = (gpu.gpuUtil || 0) + ' / ' + utilLimitPct + '%';
      util.classList.remove('warn', 'error');
      if ((gpu.gpuUtil || 0) > utilLimitPct) util.classList.add('error');
      else if ((gpu.gpuUtil || 0) > 70) util.classList.add('warn');
    }
    if (temp) {
      temp.textContent = (gpu.tempC || 0) + ' / ' + tempLimitC + '°C';
      temp.classList.remove('warn', 'error');
      if ((gpu.tempC || 0) > tempLimitC) temp.classList.add('error');
      else if ((gpu.tempC || 0) > 65) temp.classList.add('warn');
    }
    // RAM mini-monitor
    const ramEl = document.getElementById('jgm-ram');
    if (ramEl && API.checkRAM) {
      try {
        const ram = await API.checkRAM();
        const ramPct = (ram.usedGB / ram.totalGB) * 100;
        const ramLimitPct = Math.round(gpuLimits?.ram ?? 85);
        const ramLimitGB  = (ram.totalGB * ramLimitPct / 100);
        ramEl.textContent = `${ram.usedGB.toFixed(1)} / ${ramLimitGB.toFixed(0)} GB`;
        ramEl.classList.remove('warn', 'error');
        if (ramPct > ramLimitPct) ramEl.classList.add('error');
        else if (ramPct > 70) ramEl.classList.add('warn');
      } catch (e2) {}
    }
  } catch (e) {}
}

function openJobDetails(id) {
  const j = state.jobs.find(x => x.id === id);
  if (!j) return;
  state._jobDetailsOpenId = id;
  document.getElementById('modal-job-details').classList.remove('hidden');
  refreshJobDetailsModal(id);
  // Start the GPU mini monitor (2s tick — was 1s; halved to reduce nvidia-smi calls)
  refreshJobGpuMonitor();
  if (_jobGpuTimer) clearInterval(_jobGpuTimer);
  // 500ms tick so the user sees real-time VRAM/GPU/temp/RAM on the
  // overlay inside the job-details modal (same cadence as Settings).
  _jobGpuTimer = setInterval(refreshJobGpuMonitor, 500);
}
function closeJobDetails() {
  state._jobDetailsOpenId = null;
  document.getElementById('modal-job-details').classList.add('hidden');
  if (_jobGpuTimer) { clearInterval(_jobGpuTimer); _jobGpuTimer = null; }
}
function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}
async function refreshJobDetailsModal(id) {
  const j = state.jobs.find(x => x.id === id);
  if (!j) { closeJobDetails(); return; }
  document.getElementById('job-details-title').textContent = j.status === 'done' ? 'Task complete' : (j.status === 'error' ? 'Task failed' : 'Running task');
  document.getElementById('job-details-subtitle').textContent = j.name;
  document.getElementById('jd-status').textContent = j.status === 'running' ? 'Running' : (j.status === 'done' ? 'Done' : 'Error');
  document.getElementById('jd-started').textContent = new Date(j.startedAt).toLocaleTimeString();
  document.getElementById('jd-elapsed').textContent = fmtDuration(Date.now() - j.startedAt);
  document.getElementById('jd-estimated').textContent = '~' + fmtDuration(j.expectedMs);
  document.getElementById('jd-project').textContent = state.currentProject ? state.currentProject.name : '--';
  // Parameters block
  const paramsBox = document.getElementById('jd-params');
  if (paramsBox) {
    if (j.params && Object.keys(j.params).length > 0) {
      const rows = Object.entries(j.params).map(([k, v]) => {
        let val = String(v == null ? '--' : v);
        if (val.length > 60) val = val.slice(0, 57) + '...';
        return `<div class="jd-row"><span class="jd-label">${escapeHtml(k)}</span><span class="jd-value">${escapeHtml(val)}</span></div>`;
      }).join('');
      paramsBox.innerHTML = rows;
      paramsBox.classList.remove('hidden');
    } else {
      paramsBox.innerHTML = '';
      paramsBox.classList.add('hidden');
    }
  }
  // Reference thumbnail: for rig jobs we want to show the SOURCE 3D MESH
  // (the GLB being rigged), not the image. For 3D-gen / modify / inpaint
  // / back-view we show the source image. But for a FRESH image generation
  // (`Generate images: ...`) there is no source asset yet — showing the
  // project's previously-selected image is misleading ("looks like the new
  // gen has the old image"), so we hide the thumb in that case.
  const refImg = document.getElementById('jd-ref-img');
  const p = state.currentProject;
  const isRigJob = /rig/i.test(j.name || '');
  const isImageGenJob = /^generate images?\b/i.test(j.name || '');
  let thumbUrl = null;
  if (isRigJob && p && p.selectedMeshPath && API.getThumbnail) {
    try {
      const t = await API.getThumbnail(p.selectedMeshPath);
      if (t) thumbUrl = t + '?t=' + Date.now();
    } catch (_) {}
  }
  if (!thumbUrl && p && !isImageGenJob) {
    const imgPath = p.selectedImagePath || p.previewImagePath || p.thumb;
    if (imgPath) thumbUrl = 'file:///' + imgPath.replace(/\\/g, '/') + '?t=' + Date.now();
  }
  if (thumbUrl && refImg) {
    refImg.src = thumbUrl;
    refImg.style.display = '';
  } else if (refImg) {
    refImg.removeAttribute('src');
    refImg.style.display = 'none';
  }
  const pct = Math.round(j.progress);
  document.getElementById('jd-progress-fill').style.width = pct + '%';
  document.getElementById('jd-progress-pct').textContent = pct + '%';
  // First-run hint — shown while a local SDXL-server-backed job is running,
  // so the user understands why the first call takes 1-3 minutes (model
  // download + VRAM load). Hidden for cloud jobs (pollinations / meshy) and
  // for jobs that have already finished.
  // First-run hint: only show when the job JUST started (first 15s) AND
  // it's a local GPU job. After 15s the model is either loaded (hint no
  // longer relevant) or the job already has real progress. This prevents
  // the hint from appearing on every single generation.
  const hintEl = document.getElementById('jd-first-run-hint');
  if (hintEl) {
    const elapsed = Date.now() - j.startedAt;
    const isEarly = j.status === 'running' && elapsed < 15000;
    const isLocalGpu = /realvis|sf3d|stable fast|unirig|sdxl|inpaint/i.test(
      (j.params?.Engine || '') + ' ' + (j.name || '')
    );
    hintEl.classList.toggle('hidden', !(isEarly && isLocalGpu));
  }
  // Cancel button: only enabled while running
  const cancelBtn = document.getElementById('job-details-cancel');
  cancelBtn.disabled = j.status !== 'running';
  cancelBtn.style.display = j.status === 'running' ? '' : 'none';
  // Error box + contextual "Open Settings" shortcut.
  // Shown when the job failed with a message. If the error message matches
  // the Meshy "API key not configured" pattern, we surface a dedicated
  // primary button that opens Settings and focuses the Meshy key field.
  const errBox = document.getElementById('jd-error-box');
  const openSettingsBtn = document.getElementById('job-details-open-settings');
  if (errBox && openSettingsBtn) {
    if (j.status === 'error' && j.errorMessage) {
      errBox.textContent = j.errorMessage;
      errBox.classList.remove('hidden');
      const needsApiKey = /api key not configured/i.test(j.errorMessage);
      openSettingsBtn.style.display = needsApiKey ? '' : 'none';
    } else {
      errBox.textContent = '';
      errBox.classList.add('hidden');
      openSettingsBtn.style.display = 'none';
    }
  }
}
document.getElementById('job-details-close').addEventListener('click', closeJobDetails);
document.getElementById('job-details-open-settings')?.addEventListener('click', () => {
  closeJobDetails();
  openSettings();
  // Focus the Meshy API key field after the Settings modal has rendered
  setTimeout(() => {
    const el = document.getElementById('set-meshy-api-key');
    if (el) { el.focus(); el.select?.(); }
  }, 120);
});
document.getElementById('job-details-cancel').addEventListener('click', async () => {
  const id = state._jobDetailsOpenId;
  if (!id) return;
  await cancelJob(id);
  closeJobDetails();
});
// Close on overlay click
document.getElementById('modal-job-details').addEventListener('click', (e) => {
  if (e.target.id === 'modal-job-details') closeJobDetails();
});
// Tick the modal every second so elapsed time updates
setInterval(() => {
  if (state._jobDetailsOpenId) refreshJobDetailsModal(state._jobDetailsOpenId);
}, 1000);
document.getElementById('jobs-bubble-2').addEventListener('click', () => {
  document.getElementById('jobs-panel-2').classList.remove('hidden');
  document.getElementById('jobs-bubble-2').classList.add('hidden');
});
document.getElementById('jobs-close-2').addEventListener('click', () => {
  document.getElementById('jobs-panel-2').classList.add('hidden');
  if (state.jobs.length > 0) document.getElementById('jobs-bubble-2').classList.remove('hidden');
});

// ============================================================
// AUTO INPAINT (CLIPSeg target + replace)
// ============================================================
document.getElementById('ws-autoinpaint-btn')?.addEventListener('click', () => {
  const p = state.currentProject;
  const target = editTarget(p);
  if (!target) { showToast('Pick an image first.', 'error'); return; }
  document.getElementById('ai-target').value = '';
  document.getElementById('ai-replace').value = '';
  // Show the source image inside the modal — use the ACTIVE view
  // (multiview angle if selected, else front) so the preview matches
  // what the user is looking at in the workspace.
  const srcImg = document.getElementById('ai-source-img');
  if (srcImg) srcImg.src = 'file:///' + target.replace(/\\/g, '/') + '?t=' + Date.now();
  document.getElementById('modal-auto-inpaint').classList.remove('hidden');
});
const aiDilate = document.getElementById('ai-dilate');
if (aiDilate) aiDilate.addEventListener('input', () => {
  document.getElementById('ai-dilate-val').textContent = aiDilate.value + 'px';
});
document.getElementById('ai-cancel')?.addEventListener('click', () => {
  document.getElementById('modal-auto-inpaint').classList.add('hidden');
});
document.getElementById('ai-go')?.addEventListener('click', async () => {
  const p = state.currentProject;
  const imagePath = editTarget(p);
  if (!imagePath) return;
  const target = document.getElementById('ai-target').value.trim();
  if (!target) {
    showToast('Type what to find first (e.g. "hat", "background")', 'error');
    document.getElementById('ai-target')?.focus();
    return;
  }
  const replace = document.getElementById('ai-replace').value.trim();
  const dilate = parseInt(document.getElementById('ai-dilate').value) || 15;
  document.getElementById('modal-auto-inpaint').classList.add('hidden');
  // Auto-inpaint: CLIPSeg detection + SDXL inpaint, ~3 min on RTX 5080
  gatedRun('inpaint', `Auto inpaint: ${p.name}`, async () => {
    const job = pushJob(`Auto inpaint: ${p.name}`, null, {
      Target: target,
      Replace: replace || '(remove)',
      Padding: dilate + 'px',
    }, 180000);
    try {
      const r = await API.autoInpaint({ imagePath, targetText: target, prompt: replace, dilate, jobId: job.id });
      if (r?.success) {
        completeJob(job.id, true);
        await reloadCurrentProject();
      } else {
        completeJob(job.id, false);
        if (!job.cancelled) customError(r?.error || 'unknown', 'Auto inpaint failed');
      }
    } catch (e) {
      completeJob(job.id, false);
      if (!job.cancelled) customError(e?.error || e?.message || String(e), 'Auto inpaint error');
    }
  });
});

// ============================================================
// SETTINGS MODAL
// ============================================================
let _gpuPollTimer = null;
// GPU usage limits (persisted in localStorage). We clamp the loaded values
// to a sensible minimum so a user can never lock themselves out by dragging
// the slider too low (a previous bug allowed vram=28%, which made the queue
// permanently block any heavy job because cost > limit).
const GPU_LIMITS_KEY = 'fabmesh-gpu-limits';
const gpuLimits = (() => {
  let v = { vram: 90, util: 95, temp: 80, ram: 85 };
  try {
    const stored = localStorage.getItem(GPU_LIMITS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed && typeof parsed === 'object') v = { ...v, ...parsed };
    }
  } catch (e) {}
  // Clamp to functional ranges so FabMesh stays usable. Minimums match
  // the per-stat MIN_BY_STAT table used while dragging (setupGpuLimitDragging):
  //   RAM   ≥ 50% : SF3D needs ~8 GB at tex_res=1024 → 50% of 32 GB
  //   VRAM  ≥ 60% : SDXL + SF3D need ~9 GB → 60% of 16 GB
  //   GPU%  ≥ 30% : below = throttle 70% of time (unusable)
  //   TEMP  ≥ 50% : slider 50% maps to 65°C (below = throttle constant)
  v.vram = Math.max(60, Math.min(100, Number(v.vram) || 90));
  v.util = Math.max(30, Math.min(100, Number(v.util) || 95));
  v.temp = Math.max(50, Math.min(100, Number(v.temp) || 80));
  v.ram  = Math.max(50, Math.min(100, Number(v.ram)  || 85));
  return v;
})();
function saveGpuLimits() {
  try { localStorage.setItem(GPU_LIMITS_KEY, JSON.stringify(gpuLimits)); } catch (e) {}
  // Push RAM limit to main process so Python subprocesses inherit FABMESH_RAM_LIMIT_MB
  if (API.setRamLimit) API.setRamLimit(gpuLimits.ram).catch(() => {});
  // Push GPU util/temp/vram limits so:
  //  - Python bridges throttle via gpu_throttle.py (util/temp live)
  //  - SDXL server respawns with the new VRAM PyTorch cap (vram)
  //  - New subprocesses inherit all 3 via env vars
  if (API.setGpuLimits) {
    API.setGpuLimits({ util: gpuLimits.util, temp: gpuLimits.temp, vram: gpuLimits.vram }).catch(() => {});
  }
}
// Push limits on startup so they're set before any job runs
if (API.setRamLimit) API.setRamLimit(gpuLimits.ram).catch(() => {});
if (API.setGpuLimits) API.setGpuLimits({ util: gpuLimits.util, temp: gpuLimits.temp, vram: gpuLimits.vram }).catch(() => {});
function applyGpuLimitMarkers() {
  const v = document.getElementById('set-gpu-vram-limit');
  const u = document.getElementById('set-gpu-util-limit');
  const t = document.getElementById('set-gpu-temp-limit');
  const r = document.getElementById('set-ram-limit');
  if (v) v.style.left = gpuLimits.vram + '%';
  if (u) u.style.left = gpuLimits.util + '%';
  if (t) t.style.left = gpuLimits.temp + '%';
  if (r) r.style.left = gpuLimits.ram + '%';
}
function isJobRunning() {
  return state.jobs.some(j => j.status === 'running');
}
// Minimums per stat — also used by the disabled-zone overlay.
const GPU_LIMITS_MIN = {
  ram: 50, vram: 60, util: 30, temp: 50,
};
// Defaults used by the Reset button.
const GPU_LIMITS_DEFAULTS = {
  ram: 85, vram: 90, util: 95, temp: 80,
};
// Paint the gray "disabled" zone on each slider (from 0% to MIN_BY_STAT).
function paintGpuDisabledZones() {
  document.querySelectorAll('.gpu-bar').forEach(bar => {
    const stat = bar.dataset.stat;
    const minPct = GPU_LIMITS_MIN[stat] || 5;
    let zone = bar.querySelector('.gpu-bar-disabled-zone');
    if (!zone) {
      zone = document.createElement('div');
      zone.className = 'gpu-bar-disabled-zone';
      bar.insertBefore(zone, bar.firstChild);
    }
    zone.style.width = minPct + '%';
  });
}
// Reset all sliders to their default values.
function resetGpuLimits() {
  Object.assign(gpuLimits, GPU_LIMITS_DEFAULTS);
  saveGpuLimits();
  applyGpuLimitMarkers();
}
function setupGpuLimitDragging() {
  paintGpuDisabledZones();
  const resetBtn = document.getElementById('gpu-limits-reset');
  if (resetBtn && !resetBtn.dataset.bound) {
    resetBtn.dataset.bound = '1';
    resetBtn.addEventListener('click', resetGpuLimits);
  }
  document.querySelectorAll('.gpu-bar-limit').forEach(handle => {
    if (handle.dataset.bound) return;
    handle.dataset.bound = '1';
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      _draggingGpuLimit = true;
      // GPU/temp sliders are LIVE: drag them even during a running job
      // and the Python throttle will pick up the new limit within ~0.5s
      // via scripts/.gpu_limit.json. VRAM/RAM limits are still "next-job
      // only" because they map to set_per_process_memory_fraction which
      // is set once at subprocess start.
      const bar = handle.parentElement;
      const stat = bar.dataset.stat;
      const liveStats = new Set(['util', 'temp']);
      if (isJobRunning() && !liveStats.has(stat)) {
        customError('VRAM/RAM limits can only be changed between jobs — they apply at subprocess start. GPU usage and temperature limits can be dragged live.', 'Locked');
        return;
      }
      // Create or reuse a tooltip bubble that shows the current value while dragging
      let tip = handle.querySelector('.gpu-bar-limit-tip');
      if (!tip) {
        tip = document.createElement('div');
        tip.className = 'gpu-bar-limit-tip';
        handle.appendChild(tip);
      }
      const formatValue = (s, pct) => {
        if (s === 'temp') {
          // Map 0-100% slider to a 30-100°C displayed range (matches the
          // tempC → bar width mapping used elsewhere in the UI).
          const c = Math.round(30 + (pct / 100) * 70);
          return c + ' °C';
        }
        return Math.round(pct) + ' %';
      };
      tip.textContent = formatValue(stat, gpuLimits[stat]);
      tip.classList.add('visible');
      function onMove(ev) {
        const rect = bar.getBoundingClientRect();
        let pct = ((ev.clientX - rect.left) / rect.width) * 100;
        const minPct = GPU_LIMITS_MIN[stat] || 5;
        pct = Math.max(minPct, Math.min(100, pct));
        handle.style.left = pct + '%';
        gpuLimits[stat] = pct;
        tip.textContent = formatValue(stat, pct);
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        _draggingGpuLimit = false;
        saveGpuLimits();
        // Keep tip visible briefly after release so the user can read the final value
        setTimeout(() => { tip.classList.remove('visible'); }, 800);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}
// Reflect the lock state visually on the GPU limit handles.
// Only VRAM and RAM handles lock during a running job (they apply at
// subprocess start); GPU-util and temperature handles stay draggable
// because the Python throttle rereads them live via .gpu_limit.json.
function refreshGpuLimitLockState() {
  const running = isJobRunning();
  const liveStats = new Set(['util', 'temp']);
  document.querySelectorAll('.gpu-bar-limit').forEach(h => {
    const stat = h.parentElement && h.parentElement.dataset && h.parentElement.dataset.stat;
    const locked = running && !liveStats.has(stat);
    h.classList.toggle('locked', locked);
    h.title = locked
      ? 'Locked while a generation is running (applied at subprocess start)'
      : (running && liveStats.has(stat)
          ? 'Drag to adjust live — throttle picks up new limit within 0.5s'
          : 'Drag to set max threshold');
  });
}

// Returns true if the GPU is currently over any user-defined limit
async function checkGpuLimits() {
  if (!API.checkGPU) return { ok: true };
  try {
    const gpu = await API.checkGPU();
    if (!gpu || !gpu.available) return { ok: true };
    const reasons = [];
    const vramPct = (gpu.usedGB / gpu.totalGB) * 100;
    if (vramPct > gpuLimits.vram) reasons.push(`VRAM at ${vramPct.toFixed(0)}% > ${gpuLimits.vram.toFixed(0)}% limit`);
    if ((gpu.gpuUtil || 0) > gpuLimits.util) reasons.push(`GPU usage at ${gpu.gpuUtil}% > ${gpuLimits.util.toFixed(0)}% limit`);
    if ((gpu.tempC || 0) > gpuLimits.temp) reasons.push(`Temperature ${gpu.tempC}°C > ${gpuLimits.temp.toFixed(0)}°C limit`);
    // Check system RAM limit
    try {
      if (API.checkRAM) {
        const ram = await API.checkRAM();
        const ramPct = (ram.usedGB / ram.totalGB) * 100;
        if (ramPct > gpuLimits.ram) reasons.push(`RAM at ${ramPct.toFixed(0)}% > ${gpuLimits.ram.toFixed(0)}% limit`);
      }
    } catch (e2) {}
    return { ok: reasons.length === 0, reasons };
  } catch (e) {
    return { ok: true };
  }
}

async function refreshPythonStats() {
  try {
    if (!API.countPython) return;
    const r = await API.countPython();
    const countEl = document.getElementById('set-python-count');
    const sdxlEl = document.getElementById('set-python-sdxl');
    const killBtn = document.getElementById('set-kill-python');
    const n = r.count || 0;
    if (countEl) countEl.textContent = String(n);
    if (sdxlEl) {
      sdxlEl.textContent = r.sdxl ? 'running' : 'stopped';
      sdxlEl.style.color = r.sdxl ? 'var(--warning)' : '';
    }
    if (killBtn) killBtn.disabled = (n === 0);
    const killSdxlBtn = document.getElementById('set-kill-sdxl');
    if (killSdxlBtn) killSdxlBtn.disabled = !r.sdxl;
    const killAllBtn = document.getElementById('set-kill-all');
    if (killAllBtn) killAllBtn.disabled = (n === 0 && !r.sdxl);
  } catch (e) {}
}

// ============================================================
// JOB QUEUE: throttle generation when GPU is too busy
// ============================================================
// Estimated VRAM cost per job kind (in GB). Used to predict whether a new
// job would exceed the user's VRAM limit before launching it.
const JOB_VRAM_COST_GB = {
  // Real per-pipeline peak VRAM on RTX 50-series, fp16.
  // SDXL server auto-unloads the other pipeline so img2img/inpaint never
  // stack — the cost is the SINGLE pipeline's peak, not the sum.
  'image':   8,    // RealVis XL V4.0 pipeline + activations
  'img2img': 8,    // RealVis XL img2img (same model, loaded via Img2ImgPipeline)
  'inpaint': 9,    // SDXL Inpainting + activations + CLIPSeg (~0.4 GB small)
  'mesh':    7,    // Stable Fast 3D peak (~6.2 GB observed) + margin
  'rig':     4,    // UniRig (~3 GB) + margin
  'bg':      1,    // rembg u2net (~150 MB) — effectively unrestricted
};
const queuedJobs = []; // [{ kind, run: () => Promise }]
let _queueProcessing = false;

async function getCurrentVramUsedGB() {
  try {
    const gpu = await API.checkGPU();
    if (gpu && gpu.available) return { used: gpu.usedGB, total: gpu.totalGB };
  } catch (e) {}
  return null;
}

// Returns true if we have enough headroom (VRAM, temperature, GPU usage) to
// launch a job of this kind. Heavy jobs are blocked when any user-defined
// limit is exceeded; light jobs (bg, rig) are never blocked.
async function hasVramHeadroomFor(kind) {
  // Returns { ok: true } or { ok: false, reason: "..." } so callers can show
  // a meaningful popup explaining WHY a job was queued.
  //
  // Strategy: PREDICT post-allocation VRAM (current used + expected cost) and
  // compare against the user's slider limit. This correctly blocks a job that
  // would push VRAM from 85% → 98% when the slider is at 92%, which the old
  // AND-based logic missed because it only looked at current usage.
  if (isHeavyJobRunning() && kind !== 'bg') {
    return { ok: false, reason: "Un autre job lourd est en cours d'exécution." };
  }
  const cost = JOB_VRAM_COST_GB[kind] || 8;
  // Background removal (u2net) is tiny — never gate it.
  if (cost <= 1) return { ok: true };

  // Check VRAM, temperature, GPU utilization
  try {
    const gpu = await API.checkGPU();
    if (!gpu || !gpu.available) return { ok: true };

    if ((gpu.tempC || 0) > gpuLimits.temp) {
      return { ok: false, reason: `GPU trop chaud (${gpu.tempC}°C > limite ${gpuLimits.temp}°C). Le job attendra.` };
    }
    if ((gpu.gpuUtil || 0) > gpuLimits.util) {
      return { ok: false, reason: `GPU utilisé à ${gpu.gpuUtil}% (> limite ${gpuLimits.util}%). Le job attendra.` };
    }

    // Predicted VRAM after the job allocates its pipeline.
    // The SDXL server unloads its other pipeline before loading a new one,
    // so the real cost is capped at ONE pipeline size (~6-7 GB), not the sum.
    // But we still add the cost to current usage to account for misc buffers
    // and activations that any running pipeline needs.
    const projectedUsedGB = gpu.usedGB + cost;
    const projectedPct = (projectedUsedGB / gpu.totalGB) * 100;
    if (projectedPct > gpuLimits.vram) {
      return {
        ok: false,
        reason: `VRAM insuffisante: ${gpu.usedGB.toFixed(1)}/${gpu.totalGB.toFixed(1)} GB utilisés, ce job a besoin de ~${cost} GB supplémentaires → ${projectedPct.toFixed(0)}% > limite ${gpuLimits.vram}%. Le job attendra que la VRAM se libère.`
      };
    }
    // Also check absolute free headroom: even below the slider, refuse to
    // start if there's genuinely not enough free VRAM on the card.
    const freeGB = gpu.totalGB - gpu.usedGB;
    if (freeGB < cost) {
      return {
        ok: false,
        reason: `VRAM libre insuffisante: ${freeGB.toFixed(1)} GB disponibles, ce job a besoin de ~${cost} GB. Le job attendra.`
      };
    }
  } catch (e) {
    return { ok: true };
  }
  // RAM gate
  try {
    if (API.checkRAM) {
      const ram = await API.checkRAM();
      const ramPct = (ram.usedGB / ram.totalGB) * 100;
      if (ramPct > gpuLimits.ram) {
        return { ok: false, reason: `RAM système saturée (${ram.usedGB.toFixed(1)}/${ram.totalGB.toFixed(1)} GB, ${ramPct.toFixed(0)}% > limite ${gpuLimits.ram}%). Le job attendra.` };
      }
    }
  } catch (e) {}
  return { ok: true };
}

// Backward-compat wrapper (some callers expect a boolean)
async function _hasHeadroomBool(kind) {
  const r = await hasVramHeadroomFor(kind);
  return r && r.ok;
}

function isHeavyJobRunning() {
  return state.jobs.some(j => j.status === 'running' && j.kind && j.kind !== 'bg');
}

// Enqueue a job (or run it immediately if there's headroom).
// `runFn` is an async function that performs the actual API call + cleanup.
async function enqueueJob(kind, displayName, runFn) {
  const r = await hasVramHeadroomFor(kind);
  if (r && r.ok) {
    runFn();
    return;
  }
  const reason = (r && r.reason) || 'Limites GPU/RAM dépassées';
  // No room — push to queue and surface a visible notice
  queuedJobs.push({ kind, displayName, run: runFn, queuedAt: Date.now() });
  renderQueueIndicator();
  renderJobs(); // Show queued jobs in the panel immediately
  // Force the jobs panel open so the user sees the queued job
  const _panel = document.getElementById('jobs-panel-2');
  const _bubble = document.getElementById('jobs-bubble-2');
  if (_panel) _panel.classList.remove('hidden');
  if (_bubble) _bubble.classList.add('hidden');
  log('queue', `Job "${displayName}" queued — ${reason}`);
  // Auto-kill SDXL server when a mesh/rig job is queued because of VRAM.
  // The SDXL server holds ~6.6 GB that the queued job needs. We kill it
  // and wait a moment for the VRAM to be freed before processQueue polls.
  if (kind === 'mesh' || kind === 'rig' || kind === 'image') {
    try {
      log('queue', 'Auto-killing SDXL server to free VRAM for queued job');
      if (API.stopSdxlServer) {
        await API.stopSdxlServer();
        // Give the OS a moment to reclaim the VRAM
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (_) {}
  }
  // Show a popup so the user knows WHY the job didn't start immediately
  try {
    if (typeof customError === 'function') {
      customError(reason + '\n\nLe job sera lancé automatiquement quand les limites seront satisfaites.\nVous pouvez ajuster les sliders dans Settings.', 'Job mis en file d\'attente');
    } else {
      alert(`Job mis en file d'attente: ${reason}`);
    }
  } catch (e) {}
  processQueue();
}

function log(src, msg) { try { console.log(`[${src}]`, msg); } catch (e) {} }

async function processQueue() {
  if (_queueProcessing) return;
  _queueProcessing = true;
  while (queuedJobs.length > 0) {
    const next = queuedJobs[0];
    // Wait for GPU limits to clear (poll every 3s, with a hard 10-min cap so
    // we never spin forever if the user's sliders are misconfigured)
    let res = await hasVramHeadroomFor(next.kind);
    const waitStart = Date.now();
    while (!(res && res.ok)) {
      if (Date.now() - waitStart > 600000) {
        console.warn('[queue] gave up waiting after 10 min, forcing run');
        break;
      }
      await new Promise(r => setTimeout(r, 3000));
      res = await hasVramHeadroomFor(next.kind);
    }
    queuedJobs.shift();
    renderQueueIndicator();
    try { next.run(); } catch (e) { console.error('queued job failed', e); }
    // Give the started job a moment to allocate VRAM before checking the next one
    await new Promise(r => setTimeout(r, 5000));
  }
  _queueProcessing = false;
}

function renderQueueIndicator() {
  // Show a small badge in the jobs panel header indicating how many are queued
  let panel = document.getElementById('jobs-panel-2');
  if (!panel) return;
  let badge = document.getElementById('queue-badge');
  if (queuedJobs.length === 0) {
    if (badge) badge.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'queue-badge';
    badge.className = 'queue-badge';
    const header = panel.querySelector('.jobs-panel-header');
    if (header) header.appendChild(badge);
  }
  badge.textContent = `${queuedJobs.length} queued`;
}

// Set true while the user is dragging a limit handle so the 500ms
// polling skips its DOM/IPC work and the drag stays smooth.
let _draggingGpuLimit = false;
async function refreshGpuStats() {
  if (_draggingGpuLimit) return;
  try {
    refreshPythonStats();
    const gpu = await API.checkGPU();
    if (!gpu || !gpu.available) {
      document.getElementById('set-gpu-name').textContent = 'GPU info unavailable';
      return;
    }
    document.getElementById('set-gpu-name').textContent = gpu.name || 'GPU';
    // VRAM
    const vramPct = (gpu.usedGB / gpu.totalGB) * 100;
    document.getElementById('set-gpu-vram-val').textContent =
      `${gpu.usedGB.toFixed(1)} / ${gpu.totalGB.toFixed(1)} GB  (${vramPct.toFixed(0)}%)`;
    document.getElementById('set-gpu-vram-fill').style.width = vramPct + '%';
    document.querySelector('.gpu-bar[data-stat="vram"]')?.classList.toggle('over-limit', vramPct > gpuLimits.vram);
    // GPU utilization
    const util = gpu.gpuUtil || 0;
    document.getElementById('set-gpu-util-val').textContent = util.toFixed(0) + '%';
    document.getElementById('set-gpu-util-fill').style.width = util + '%';
    document.querySelector('.gpu-bar[data-stat="util"]')?.classList.toggle('over-limit', util > gpuLimits.util);
    // Temperature (scale 0-100°C → 0-100% bar, red zone after 80)
    const temp = gpu.tempC || 0;
    document.getElementById('set-gpu-temp-val').textContent = temp.toFixed(0) + ' °C';
    document.getElementById('set-gpu-temp-fill').style.width = Math.min(100, temp) + '%';
    document.querySelector('.gpu-bar[data-stat="temp"]')?.classList.toggle('over-limit', temp > gpuLimits.temp);
    refreshGpuLimitLockState();
  } catch (e) {
    document.getElementById('set-gpu-name').textContent = 'GPU info unavailable: ' + e.message;
  }
  // System RAM stats
  try {
    if (API.checkRAM) {
      const ram = await API.checkRAM();
      const ramPct = (ram.usedGB / ram.totalGB) * 100;
      const ramValEl = document.getElementById('set-ram-val');
      const ramFillEl = document.getElementById('set-ram-fill');
      if (ramValEl) ramValEl.textContent = `${ram.usedGB.toFixed(1)} / ${ram.totalGB.toFixed(1)} GB  (${ramPct.toFixed(0)}%)`;
      if (ramFillEl) ramFillEl.style.width = ramPct + '%';
      document.querySelector('.gpu-bar[data-stat="ram"]')?.classList.toggle('over-limit', ramPct > gpuLimits.ram);
    }
  } catch (e) {}
}

async function openSettings() {
  document.getElementById('modal-settings').classList.remove('hidden');
  try {
    const cfg = await API.getConfig();
    const blenderEl = document.getElementById('set-blender-path');
    if (blenderEl) blenderEl.value = cfg?.blenderPath || '';
    const meshyInput = document.getElementById('set-meshy-api-key');
    if (meshyInput) meshyInput.value = cfg?.meshyApiKey || '';
  } catch (e) {}
  applyGpuLimitMarkers();
  setupGpuLimitDragging();
  refreshGpuStats();
  checkClaudeDesktopStatus();
  refreshParentalStatus();
  // Ensure main process has the current RAM limit
  if (API.setRamLimit) API.setRamLimit(gpuLimits.ram).catch(() => {});
  if (_gpuPollTimer) clearInterval(_gpuPollTimer);
  // 500ms tick while Settings is open so the user sees real-time VRAM/GPU/RAM.
  // The timer is cleared as soon as the panel closes (set-close handler).
  _gpuPollTimer = setInterval(refreshGpuStats, 500);
}
document.getElementById('btn-settings')?.addEventListener('click', openSettings);
// Clicking the in-modal GPU monitor overlay also opens Settings so the
// user can adjust limits directly from the job-details panel. We close
// job-details first so Settings isn't rendered behind it (same z-index).
document.getElementById('job-gpu-monitor')?.addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('modal-job-details')?.classList.add('hidden');
  openSettings();
});
function closeSettings() {
  document.getElementById('modal-settings').classList.add('hidden');
  if (_gpuPollTimer) { clearInterval(_gpuPollTimer); _gpuPollTimer = null; }
}
document.getElementById('set-close')?.addEventListener('click', closeSettings);
document.getElementById('set-close-x')?.addEventListener('click', closeSettings);
document.getElementById('set-open-logs')?.addEventListener('click', async () => {
  if (API.openLogsFolder) await API.openLogsFolder();
});

// ============================================================
// CALIBRATION panel wiring
// ============================================================
(() => {
  const btnOpen = document.getElementById('set-calib-open');
  const btnGallery = document.getElementById('set-calib-gallery');
  const statusEl = document.getElementById('set-calib-status');
  const scoreRow = document.getElementById('set-calib-score-row');
  const scoreEl = document.getElementById('set-calib-score');
  const simEl = document.getElementById('set-calib-similarity');
  const tsEl = document.getElementById('set-calib-timestamp');
  const axesEl = document.getElementById('set-calib-axes');
  if (!statusEl) return;

  function renderScore(score, reportDir) {
    if (!score) { scoreRow.style.display = 'none'; return; }
    scoreRow.style.display = 'block';
    const s = score.score, total = score.total;
    scoreEl.textContent = `${s}/${total}`;
    const ratio = s / total;
    scoreEl.style.background = ratio >= 0.83 ? '#1a5c1a' : ratio >= 0.5 ? '#8a6a1a' : '#8a1a1a';
    simEl.textContent = `similarity ${(score.avg_similarity || 0).toFixed(2)}`;
    tsEl.textContent = score.timestamp || '';
    axesEl.innerHTML = '';
    for (const r of (score.results || [])) {
      const cell = document.createElement('div');
      cell.style.cssText = 'position:relative; border-radius:4px; overflow:hidden; outline:2px solid ' +
        (r.correct ? '#3a3' : '#c33') + ';';
      const img = document.createElement('img');
      if (reportDir) {
        const sep = reportDir.includes('\\') ? '\\' : '/';
        img.src = 'file:///' + (reportDir + sep + r.got_img).replace(/\\/g, '/');
      }
      img.style.cssText = 'width:100%; display:block; background:#fff;';
      const lbl = document.createElement('div');
      lbl.style.cssText = 'position:absolute; bottom:0; left:0; right:0; background:rgba(0,0,0,0.75); ' +
        'padding:2px 3px; font-size:9px; text-align:center; color:#fff; line-height:1.1;';
      lbl.innerHTML = `${r.axis}<br><b>${r.expected}&rarr;${r.got}</b>`;
      cell.appendChild(img); cell.appendChild(lbl);
      axesEl.appendChild(cell);
    }
  }

  async function loadLast() {
    try {
      const res = await API.calibLastReport();
      if (res && res.success && res.score) {
        renderScore(res.score, res.reportDir);
        statusEl.textContent = 'Last run loaded.';
      } else {
        statusEl.textContent = 'No run yet.';
      }
    } catch (e) { statusEl.textContent = 'Error: ' + e.message; }
  }

  btnOpen?.addEventListener('click', () => openReportModal());
  btnGallery?.addEventListener('click', () => openGalleryModal());

  // ---- Detailed log modal ---------------------------------------------
  const btnLog = document.getElementById('set-calib-log');
  const logModal = document.getElementById('modal-calib-log');
  const logBody = document.getElementById('calib-log-body');
  const logLinesInput = document.getElementById('calib-log-lines');
  document.getElementById('calib-log-close')?.addEventListener('click',
    () => logModal.classList.add('hidden'));
  logModal?.addEventListener('click', (e) => {
    if (e.target === logModal) logModal.classList.add('hidden');
  });
  async function loadCalibLog() {
    const lines = parseInt(logLinesInput?.value || '500', 10);
    logBody.textContent = 'Loading...';
    const res = await API.calibReadLog({ lines });
    if (res && res.success) {
      logBody.textContent = res.log || '(empty)';
      logBody.scrollTop = logBody.scrollHeight;
    } else {
      logBody.textContent = 'Error: ' + (res && res.error || 'unknown');
    }
  }
  document.getElementById('calib-log-refresh')?.addEventListener('click', loadCalibLog);
  btnLog?.addEventListener('click', () => {
    logModal.classList.remove('hidden');
    loadCalibLog();
  });

  // ---- Auto-diagnose button -------------------------------------------
  const btnDiagnose = document.getElementById('set-calib-diagnose');
  const diagModal = document.getElementById('modal-calib-diagnose');
  const diagBody = document.getElementById('calib-diagnose-body');
  document.getElementById('calib-diagnose-close')?.addEventListener('click',
    () => diagModal.classList.add('hidden'));
  diagModal?.addEventListener('click', (e) => {
    if (e.target === diagModal) diagModal.classList.add('hidden');
  });

  function stageCard(title, data, extract) {
    if (!data || !data.ok) {
      const err = (data && data.error) ? data.error.slice(0, 160) : 'not run';
      return `<div style="background:#1a0e0e; border:2px solid #633; border-radius:8px; padding:14px; text-align:center;">
        <h3 style="margin:0 0 8px; color:#f88; font-size:14px;">${title}</h3>
        <p style="color:#f66; font-size:12px;">Failed: ${err}</p></div>`;
    }
    const { score, sub, bg } = extract(data);
    return `<div style="background:#161616; border:2px solid #333; border-radius:8px; padding:14px; text-align:center;">
      <h3 style="margin:0 0 8px; color:#9cf; font-size:14px;">${title}</h3>
      <div style="display:inline-block; padding:10px 22px; background:${bg}; border-radius:8px; font-size:2em; font-weight:bold; color:#fff;">${score}</div>
      <p style="margin:6px 0 0; font-size:12px; color:#aaa;">${sub}</p></div>`;
  }

  function renderDiagnose(res) {
    if (!res || !res.success) {
      const err = (res && res.error) || 'unknown';
      const stderr = (res && res.stderr) || '';
      diagBody.innerHTML = `<p style="color:#f66">Error: ${err}</p>` +
        (stderr ? `<pre style="background:#111; padding:10px; border-radius:4px; font-size:11px; color:#faa; max-height:300px; overflow:auto;">${stderr.replace(/</g, '&lt;')}</pre>` : '');
      return;
    }
    const s1 = res.stage1, s2 = res.stage2, s3 = res.stage3, v = res.verdict;
    const causeColors = { sf3d: '#cc3', zero123: '#c60', projection: '#c36',
                          none_clear: '#888', projection_or_sf3d: '#888', unknown: '#555' };
    const causeColor = causeColors[v?.primary_cause] || '#555';
    // Helper: mini-thumbnails for a stage's per-axis results.
    function stageThumbs(stageData, kind) {
      if (!stageData || !stageData.ok) return '';
      if (kind === 'axes') {
        const reportDir = stageData.report;
        const results = stageData.score?.results || [];
        if (!reportDir || !results.length) return '';
        const sep = reportDir.includes('\\') ? '\\' : '/';
        const cells = results.map(r => {
          const img = 'file:///' + (reportDir + sep + r.got_img).replace(/\\/g, '/');
          const border = r.correct ? '#3a3' : '#c33';
          return `<div style="position:relative; outline:2px solid ${border}; border-radius:3px; overflow:hidden;">
            <img src="${img}" style="width:100%; display:block; background:#fff;">
            <div style="position:absolute; bottom:0; left:0; right:0; background:rgba(0,0,0,0.8); font-size:9px; padding:1px 2px; text-align:center; color:#fff; line-height:1.1;">
              ${r.axis}<br><b>${r.expected}&rarr;${r.got}</b>
            </div>
          </div>`;
        }).join('');
        return `<div style="display:grid; grid-template-columns:repeat(6,1fr); gap:2px; margin-top:10px;">${cells}</div>`;
      }
      if (kind === 'views') {
        // Show view_0..5 from the active multiview dir
        const views = stageData.views || [];
        const mvBase = 'file:///' + encodeURI(
          'c:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/images/_calibration/ref_rubiks_multiview/'
            .replace(/\\/g, '/')
        );
        const cells = views.map(v => {
          const border = v.ok ? '#3a3' : '#c33';
          return `<div style="position:relative; outline:2px solid ${border}; border-radius:3px; overflow:hidden;">
            <img src="${mvBase}view_${v.i}.png" style="width:100%; display:block; background:#fff;">
            <div style="position:absolute; bottom:0; left:0; right:0; background:rgba(0,0,0,0.8); font-size:9px; padding:1px 2px; text-align:center; color:#fff; line-height:1.1;">
              v${v.i}<br>sim ${(v.similarity||0).toFixed(2)}
            </div>
          </div>`;
        }).join('');
        return `<div style="display:grid; grid-template-columns:repeat(6,1fr); gap:2px; margin-top:10px;">${cells}</div>`;
      }
      return '';
    }

    function stageCardWithThumbs(title, data, extract, kind) {
      if (!data || !data.ok) {
        const err = (data && data.error) ? data.error.slice(0, 160) : 'not run';
        return `<div style="background:#1a0e0e; border:2px solid #633; border-radius:8px; padding:14px; text-align:center;">
          <h3 style="margin:0 0 8px; color:#f88; font-size:14px;">${title}</h3>
          <p style="color:#f66; font-size:12px;">Failed: ${err}</p></div>`;
      }
      const { score, sub, bg } = extract(data);
      return `<div style="background:#161616; border:2px solid #333; border-radius:8px; padding:14px;">
        <h3 style="margin:0 0 8px; color:#9cf; font-size:14px; text-align:center;">${title}</h3>
        <div style="text-align:center;">
          <div style="display:inline-block; padding:10px 22px; background:${bg}; border-radius:8px; font-size:2em; font-weight:bold; color:#fff;">${score}</div>
          <p style="margin:6px 0 0; font-size:12px; color:#aaa;">${sub}</p>
        </div>
        ${stageThumbs(data, kind)}
      </div>`;
    }

    const cards = [
      stageCardWithThumbs('1. SF3D raw mesh', s1, (d) => {
        const s = d.score?.score || 0, t = d.score?.total || 6;
        const bg = s >= 4 ? '#1a5c1a' : s >= 2 ? '#8a6a1a' : '#8a1a1a';
        return { score: `${s}/${t}`, sub: `sim ${(d.score?.avg_similarity || 0).toFixed(2)}`, bg };
      }, 'axes'),
      stageCardWithThumbs('2. Zero123++ views', s2, (d) => {
        const s = d.good_views || 0, t = d.total || 6;
        const bg = s >= 4 ? '#1a5c1a' : s >= 2 ? '#8a6a1a' : '#8a1a1a';
        return { score: `${s}/${t}`, sub: `avg sim ${(d.avg_similarity || 0).toFixed(2)}`, bg };
      }, 'views'),
      stageCardWithThumbs('3. Final projection', s3, (d) => {
        const s = d.score?.score || 0, t = d.score?.total || 6;
        const bg = s >= 4 ? '#1a5c1a' : s >= 2 ? '#8a6a1a' : '#8a1a1a';
        return { score: `${s}/${t}`, sub: `sim ${(d.score?.avg_similarity || 0).toFixed(2)}`, bg };
      }, 'axes'),
    ];
    const detailsList = (v?.details || []).map(d => `<li>${d}</li>`).join('');
    diagBody.innerHTML = `
      <p style="color:#aaa; margin-top:0;">Ran each pipeline stage independently, scored each one.</p>
      <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:12px; margin:14px 0;">${cards.join('')}</div>
      <div style="border-left:6px solid ${causeColor}; padding:14px 18px; background:#1a1a1a; border-radius:0 8px 8px 0;">
        <h3 style="margin:0 0 10px;">Verdict
          <span style="display:inline-block; background:${causeColor}; color:#000; padding:2px 10px; border-radius:3px; font-size:0.8em; text-transform:uppercase; margin-left:8px;">${v?.primary_cause || 'unknown'}</span>
        </h3>
        <ul style="margin:0 0 12px; line-height:1.6; padding-left:22px;">${detailsList}</ul>
        <p style="margin:0;"><b>Recommendation:</b></p>
        <p style="margin:6px 0 0; color:#ddd;">${v?.recommendation || ''}</p>
      </div>`;
  }

  const btnCancel = document.getElementById('calib-diagnose-cancel');
  btnCancel?.addEventListener('click', async () => {
    const ok = await fabConfirm({
      title: 'Cancel calibration?',
      message: 'This will stop the pipeline immediately (SF3D, Zero123++, projection). Any partial output for this run will be discarded.',
      okLabel: 'Cancel run',
      cancelLabel: 'Keep running',
    });
    if (!ok) return;
    btnCancel.disabled = true;
    btnCancel.textContent = 'Cancelling...';
    try { await API.calibCancel(); } catch (e) {}
  });

  async function runDiagnose(engine) {
    diagModal.classList.remove('hidden');
    diagBody.innerHTML = `<p style="color:#aaa">Running ${engine.toUpperCase()} pipeline — ~4-5 min (${engine} + Zero123++ + projection)...</p>`;
    btnDiagnose.disabled = true;
    if (btnCompare) btnCompare.disabled = true;
    if (btnCancel) {
      btnCancel.style.display = '';
      btnCancel.disabled = false;
      btnCancel.innerHTML = '&#9209;&#65039; Cancel';
    }
    const t0 = Date.now();
    const fmt = (ms) => { const s = Math.floor(ms/1000); const m = Math.floor(s/60); return m>0 ? `${m}m${String(s%60).padStart(2,'0')}s` : `${s}s`; };
    const progressEl = document.createElement('p');
    progressEl.style.cssText = 'color:#9cf; font-family:monospace; font-size:12px;';
    diagBody.appendChild(progressEl);
    const timer = setInterval(() => { progressEl.textContent = `[${fmt(Date.now()-t0)}] running ${engine}...`; }, 1000);
    let lastLine = '';
    const unsub = API.onCalibProgress ? API.onCalibProgress((d) => {
      lastLine = (String(d).split('\n').filter(l => l.trim()).pop() || '').slice(0, 120);
      progressEl.textContent = `[${fmt(Date.now()-t0)}] ${lastLine}`;
    }) : null;
    try {
      const res = await API.calibDiagnose({ engine });
      clearInterval(timer);
      if (res && res.cancelled) {
        diagBody.innerHTML = `<p style="color:#f88">Cancelled after ${fmt(Date.now()-t0)}.</p>`;
      } else {
        renderDiagnose(res);
      }
    } catch (e) {
      clearInterval(timer);
      diagBody.innerHTML = `<p style="color:#f66">Error: ${e.message}</p>`;
    }
    if (btnCancel) btnCancel.style.display = 'none';
    btnDiagnose.disabled = false;
    if (btnCompare) btnCompare.disabled = false;
  }

  // Side-by-side comparison: run SF3D then TripoSG, show both verdicts.
  async function runCompare() {
    diagModal.classList.remove('hidden');
    diagBody.innerHTML = '<p style="color:#aaa">Running both engines sequentially — ~8-10 min total...</p>';
    btnDiagnose.disabled = true;
    if (btnCompare) btnCompare.disabled = true;
    if (btnCancel) {
      btnCancel.style.display = ''; btnCancel.disabled = false;
      btnCancel.innerHTML = '&#9209;&#65039; Cancel';
    }
    const t0 = Date.now();
    const fmt = (ms) => { const s = Math.floor(ms/1000); const m = Math.floor(s/60); return m>0 ? `${m}m${String(s%60).padStart(2,'0')}s` : `${s}s`; };
    const progressEl = document.createElement('p');
    progressEl.style.cssText = 'color:#9cf; font-family:monospace; font-size:12px;';
    diagBody.appendChild(progressEl);
    let phase = 'SF3D';
    const timer = setInterval(() => { progressEl.textContent = `[${fmt(Date.now()-t0)}] ${phase} ${lastLine||'...'}`; }, 1000);
    let lastLine = '';
    const unsub = API.onCalibProgress ? API.onCalibProgress((d) => {
      lastLine = (String(d).split('\n').filter(l => l.trim()).pop() || '').slice(0, 120);
    }) : null;
    try {
      const resSf3d = await API.calibDiagnose({ engine: 'sf3d' });
      phase = 'TripoSG';
      const resTriposg = await API.calibDiagnose({ engine: 'triposg' });
      clearInterval(timer);
      diagBody.innerHTML = renderComparison(resSf3d, resTriposg);
    } catch (e) {
      clearInterval(timer);
      diagBody.innerHTML = `<p style="color:#f66">Error: ${e.message}</p>`;
    }
    if (btnCancel) btnCancel.style.display = 'none';
    btnDiagnose.disabled = false;
    if (btnCompare) btnCompare.disabled = false;
  }

  function renderComparison(resA, resB) {
    function miniCard(label, res) {
      if (!res || !res.success) {
        return `<div style="flex:1; background:#1a0e0e; border:2px solid #633; border-radius:8px; padding:14px;">
          <h3 style="margin:0 0 8px; color:#f88;">${label}</h3>
          <p style="color:#f66; font-size:12px;">Failed: ${(res && res.error) || 'unknown'}</p></div>`;
      }
      const v = res.verdict || {};
      const s1 = v.stage1_sf3d_score || '?';
      const s2 = v.stage2_mv_similarity || '?';
      const s3 = v.stage3_final_score || '?';
      return `<div style="flex:1; background:#161616; border:2px solid #333; border-radius:8px; padding:14px;">
        <h3 style="margin:0 0 10px; color:#9cf;">${label}</h3>
        <table style="width:100%; font-family:monospace; font-size:13px;">
          <tr><td>Mesh (stage 1)</td><td style="text-align:right;"><b>${s1}</b></td></tr>
          <tr><td>Multi-views (stage 2)</td><td style="text-align:right;"><b>${s2}</b></td></tr>
          <tr><td>Final projected (stage 3)</td><td style="text-align:right;"><b>${s3}</b></td></tr>
        </table>
        <p style="font-size:11px; color:#aaa; margin-top:10px;">Primary cause: <b>${v.primary_cause || 'unknown'}</b></p>
      </div>`;
    }
    // Winner: highest stage3 score
    function parseScore(res) {
      const s = res?.verdict?.stage3_final_score;
      if (!s) return -1;
      const m = String(s).match(/^(\d+)/);
      return m ? parseInt(m[1], 10) : -1;
    }
    const sfScore = parseScore(resA);
    const tpScore = parseScore(resB);
    let winner = '';
    if (sfScore > tpScore) winner = '<div style="padding:14px; margin-top:14px; background:#1a5c1a; border-radius:8px;"><b>WINNER: SF3D</b> (' + sfScore + ' vs ' + tpScore + ')</div>';
    else if (tpScore > sfScore) winner = '<div style="padding:14px; margin-top:14px; background:#1a5c1a; border-radius:8px;"><b>WINNER: TripoSG</b> (' + tpScore + ' vs ' + sfScore + ')</div>';
    else winner = '<div style="padding:14px; margin-top:14px; background:#555; border-radius:8px;"><b>TIE</b> (' + sfScore + '/6 each)</div>';
    return `
      <h3 style="margin-top:0;">Engine comparison on the same calibration input</h3>
      <p style="color:#aaa;">Both engines ran the full pipeline (mesh → multi-views → projection → scoring).</p>
      <div style="display:flex; gap:14px;">
        ${miniCard('SF3D', resA)}
        ${miniCard('TripoSG', resB)}
      </div>
      ${winner}
    `;
  }

  const btnCompare = document.getElementById('set-calib-compare');
  btnCompare?.addEventListener('click', runCompare);

  // ---- NEW: Tiered calibration (test -> analyze -> auto-tune) ---------
  function tierRow(num, name, state = 'pending') {
    const icons = { pending: '⏳', pass: '✅', fail: '❌', skipped: '⊘' };
    const colors = { pending: '#555', running: '#f59e0b', pass: '#3a3', fail: '#c33', skipped: '#666' };
    return `<div class="tier-row" id="tier-row-${num}" data-state="${state}" style="display:flex; align-items:center; gap:12px; padding:12px; background:#161616; border-left:4px solid ${colors[state]}; border-radius:4px; margin-bottom:8px;">
      <div style="font-size:1.6em; width:32px; text-align:center;" id="tier-icon-${num}">${state === 'running' ? '<span class="tier-spinner"></span>' : icons[state]}</div>
      <div style="flex:1;">
        <div style="font-weight:bold; color:#9cf;">Tier ${num}. ${name}</div>
        <div id="tier-msg-${num}" style="font-size:12px; color:#aaa; font-family:monospace; margin-top:4px;">waiting...</div>
      </div>
      <div id="tier-timer-${num}" style="font-size:12px; color:#888; font-family:monospace; min-width:50px; text-align:right;"></div>
    </div>`;
  }

  // Timer state: when a tier becomes 'running' we store its start time
  // and update the displayed elapsed every 500ms. When it leaves running
  // state we freeze the value.
  const _tierStart = { 1: null, 2: null, 3: null };
  const _tierFrozen = { 1: null, 2: null, 3: null };
  let _tierTimerId = null;
  function _fmtSec(ms) {
    const s = Math.floor(ms / 1000); const m = Math.floor(s / 60);
    return m > 0 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
  }
  function _updateTierTimers() {
    for (const num of [1, 2, 3]) {
      const el = document.getElementById(`tier-timer-${num}`);
      if (!el) continue;
      if (_tierFrozen[num] !== null) {
        el.textContent = _tierFrozen[num];
      } else if (_tierStart[num] !== null) {
        el.textContent = _fmtSec(Date.now() - _tierStart[num]);
      }
    }
  }

  function setTierState(num, state, message) {
    const row = document.getElementById(`tier-row-${num}`);
    const icon = document.getElementById(`tier-icon-${num}`);
    const msg = document.getElementById(`tier-msg-${num}`);
    if (!row) return;
    const icons = { pending: '⏳', pass: '✅', fail: '❌', skipped: '⊘' };
    const colors = { pending: '#555', running: '#f59e0b', pass: '#3a3', fail: '#c33', skipped: '#666' };
    row.style.borderLeftColor = colors[state] || '#555';
    row.dataset.state = state;
    // Spinner while running, static icon otherwise
    icon.innerHTML = state === 'running' ? '<span class="tier-spinner"></span>' : (icons[state] || '⏳');
    if (message !== undefined) msg.textContent = message;
    // Timer transitions
    if (state === 'running' && _tierStart[num] === null) {
      _tierStart[num] = Date.now();
      _tierFrozen[num] = null;
    } else if ((state === 'pass' || state === 'fail' || state === 'skipped') && _tierStart[num] !== null && _tierFrozen[num] === null) {
      _tierFrozen[num] = _fmtSec(Date.now() - _tierStart[num]);
    } else if (state === 'skipped') {
      _tierFrozen[num] = '—';
    }
    _updateTierTimers();
  }

  async function runTieredCalibration() {
    diagModal.classList.remove('hidden');
    // Reset timer state
    for (const k of [1, 2, 3]) { _tierStart[k] = null; _tierFrozen[k] = null; }
    if (_tierTimerId) { clearInterval(_tierTimerId); _tierTimerId = null; }
    _tierTimerId = setInterval(_updateTierTimers, 500);
    diagBody.innerHTML = `
      <p style="color:#aaa; margin-top:0;">Calibration v3 — 5 independent per-stage checks in ~7s. Stage 4 tests UV projection in isolation (skips SF3D + auto-align), so its ceiling is 2/6 on the GT cube by design. Real pipeline uses the full chain and produces clean textures. Use this view to spot regressions, not as an absolute quality metric.</p>
      <div id="tiered-footer" style="margin-top:14px; padding:14px; background:#1a1a1a; border-radius:8px; border-left:6px solid #555; color:#aaa;">
        Running...
      </div>`;
    btnDiagnose.disabled = true;
    if (btnCompare) btnCompare.disabled = true;
    if (btnCancel) {
      btnCancel.style.display = '';
      btnCancel.disabled = false;
      btnCancel.innerHTML = '&#9209;&#65039; Cancel';
    }

    // Parse TIER_JSON lines streamed from Python
    let currentTier = 0;
    const unsub = API.onCalibProgress ? API.onCalibProgress((data) => {
      String(data).split('\n').forEach(line => {
        const m = line.match(/TIER_JSON:\s*(\{.+\})/);
        if (!m) return;
        try {
          const ev = JSON.parse(m[1]);
          const t = ev.tier; currentTier = t;
          if (ev.phase === 'start') {
            setTierState(t, 'running', `Starting: ${ev.name || ''}`);
          } else if (ev.phase === 'pass') {
            setTierState(t, 'pass', `OK · contrast=${ev.contrast_spread?.toFixed?.(0) || '?'}, size=${(ev.size || []).join('x')}`);
          } else if (ev.phase === 'fail') {
            setTierState(t, 'fail', `Failed: ${ev.reason || '?'}`);
          } else if (ev.phase === 'skipped') {
            setTierState(t, 'skipped', `Skipped: ${ev.reason || '?'}`);
          } else if (ev.phase === 'tune') {
            setTierState(t, 'running', `Tuning iter ${ev.iter}/${ev.total}: ${ev.variant || ''}`);
          } else if (ev.phase === 'iter_done') {
            if (t === 2) {
              setTierState(t, 'running', `${ev.variant}: avg_sim=${ev.avg_sim}`);
            } else {
              setTierState(t, 'running', `${ev.variant}: ${ev.score} (sim ${ev.sim})`);
            }
          } else if (ev.phase === 'iter_fail') {
            setTierState(t, 'running', `iter ${ev.variant} failed: ${(ev.error || '').slice(0, 60)}`);
          } else if (ev.phase === 'sf3d') {
            setTierState(t, 'running', ev.message || 'SF3D...');
          } else if (ev.phase === 'done') {
            const ok = ev.passed;
            const detail = t === 2
              ? `best ${ev.winning_variant} · sim ${ev.score} (threshold ${ev.threshold})`
              : `best ${ev.best_variant} · ${ev.best_score}`;
            setTierState(t, ok ? 'pass' : 'fail', detail);
          }
        } catch (e) {}
      });
    }) : null;

    try {
      // Calibration v3: per-stage independent checks.
      // Stage 4 is deterministic and runs in ~7s — it catches UV/camera
      // bugs that v1/v2 could not isolate because they ran SF3D+Zero123++
      // in the loop. We call v3 by default now.
      const res = await API.calibV3({});
      if (res && res.cancelled) {
        document.getElementById('tiered-footer').innerHTML = `<span style="color:#f88">Cancelled.</span>`;
      } else if (!res || !res.success) {
        document.getElementById('tiered-footer').innerHTML =
          `<span style="color:#f66">Failed: ${(res && res.error) || 'unknown'}</span>`;
        if (res && res.stderr) {
          document.getElementById('tiered-footer').innerHTML +=
            `<pre style="margin-top:8px; font-size:11px; color:#faa; max-height:200px; overflow:auto;">${String(res.stderr).replace(/</g, '&lt;')}</pre>`;
        }
      } else {
        renderCalibV3Result(res.result);
      }
    } catch (e) {
      document.getElementById('tiered-footer').innerHTML =
        `<span style="color:#f66">Error: ${e.message}</span>`;
    }
    if (btnCancel) btnCancel.style.display = 'none';
    btnDiagnose.disabled = false;
    if (btnCompare) btnCompare.disabled = false;
    if (_tierTimerId) { clearInterval(_tierTimerId); _tierTimerId = null; }
  }

  function renderCalibV3Result(r) {
    if (!r || !r.summary) return;
    const footer = document.getElementById('tiered-footer');
    if (!footer) return;
    const s = r.summary;
    const stageLabel = {1:'Ref image', 2:'Multi-views', 3:'Mesh silhouette',
                       4:'UV projection', 5:'Final render'};
    const rows = (s.per_stage || []).map((st, idx) => {
      const col = st.ok ? '#3a3' : '#c33';
      const bg  = st.ok ? '#1a3c1a' : '#3c1a1a';
      const regBadge = st.regression
        ? ' <span style="background:#c33;color:#fff;padding:1px 6px;border-radius:3px;font-size:10px;">REGRESSION</span>'
        : '';
      const name = stageLabel[st.stage] || st.name;
      // Find matching full stage object (has details incl. compare_html)
      const full = (r.stages || [])[idx] || {};
      const compareHtml = full.details && full.details.compare_html;
      const viewBtn = compareHtml
        ? ` <button class="v3-view-btn" data-path="${compareHtml.replace(/\\/g, '/')}"
             style="margin-left:8px; padding:2px 8px; font-size:11px;
                    background:#4d7eff; color:#fff; border:none; border-radius:3px; cursor:pointer;">
             View expected vs got</button>`
        : '';
      return `<div style="padding:6px 10px; background:${bg}; border-left:3px solid ${col}; margin-bottom:4px;">
        <b>Stage ${st.stage} — ${name}</b>
        <span style="float:right; color:${col};">${st.ok ? 'PASS' : 'FAIL'} · score ${st.score.toFixed(2)}</span>${regBadge}${viewBtn}
      </div>`;
    }).join('');
    const overallCol = s.all_ok ? '#3a3' : '#c33';
    const verdict = s.all_ok
      ? '<b>All stages passed.</b> Baselines updated.'
      : (s.per_stage.find(x => !x.ok)
          ? `<b>First failing stage: ${s.per_stage.find(x => !x.ok).stage}</b> — this is where pipeline bugs are localized.`
          : 'Nothing ran.');
    footer.innerHTML = `
      <div style="padding:10px; background:#1a1a1a; border:1px solid #333; border-radius:4px;">
        <div style="margin-bottom:8px; color:${overallCol}; font-size:14px;">
          Calibration v3 · ${s.stages_run} stages · ${s.elapsed_s}s${s.any_regression ? ' · <b style="color:#f60">REGRESSION</b>' : ''}
        </div>
        ${rows}
        <div style="margin-top:10px; padding:8px; background:#222; border-radius:3px; font-size:12px;">${verdict}</div>
      </div>`;
    // Wire up "View expected vs got" buttons to open the HTML compare page
    footer.querySelectorAll('.v3-view-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const p = btn.getAttribute('data-path');
        if (!p) return;
        // Open the comparison HTML in a fresh modal iframe
        let modal = document.getElementById('v3-compare-modal');
        if (!modal) {
          modal = document.createElement('div');
          modal.id = 'v3-compare-modal';
          modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.85); z-index:10000; display:flex; flex-direction:column;';
          modal.innerHTML = `
            <div style="padding:10px; background:#1a1a1a; display:flex; justify-content:space-between; align-items:center;">
              <b style="color:#ddd;">Stage comparison — expected vs got</b>
              <button id="v3-compare-close" style="padding:4px 12px; background:#c33; color:#fff; border:none; border-radius:3px; cursor:pointer;">Close</button>
            </div>
            <iframe id="v3-compare-frame" style="flex:1; border:0; width:100%; height:100%; background:#111;"></iframe>`;
          document.body.appendChild(modal);
          modal.querySelector('#v3-compare-close').addEventListener('click', () => modal.remove());
        }
        const frame = modal.querySelector('#v3-compare-frame');
        frame.src = 'file:///' + p;
      });
    });
  }

  function renderTieredResult(r) {
    if (!r) return;
    const t3 = r.tier3 || {};
    const finalScore = r.final_score || '?';
    const ok = t3.ok;
    const color = ok ? '#3a3' : (t3.skipped ? '#666' : '#c33');
    const bg = ok ? '#1a3c1a' : (t3.skipped ? '#222' : '#3c1a1a');
    let verdict = '';
    if (t3.skipped) {
      verdict = `<b>Blocked upstream</b> — ${t3.reason || 'an earlier tier failed'}. Fix the upstream issue first.`;
    } else if (ok) {
      verdict = `<b>Perfect score reached.</b> The winning projection config has been persisted and will be used automatically for future runs.`;
    } else {
      verdict = `<b>Plateau at ${t3.best_score}/${t3.target}.</b> No projection config reached a perfect score — the remaining loss is upstream (SF3D mesh quality or Zero123++ hallucinations), not a projection flag issue.`;
    }
    const cfg = t3.best_combo ? `<pre style="margin-top:10px; background:#0a0a0a; padding:10px; border-radius:4px; font-size:11px;">${JSON.stringify(t3.best_combo, null, 2)}</pre>` : '';
    document.getElementById('tiered-footer').outerHTML = `
      <div style="margin-top:14px; padding:16px; background:${bg}; border-left:6px solid ${color}; border-radius:8px;">
        <div style="font-size:1.3em; margin-bottom:8px;">Final score: <b>${finalScore}</b> · elapsed ${r.elapsed_s}s</div>
        <div>${verdict}</div>
        ${cfg}
      </div>`;
  }

  btnDiagnose?.addEventListener('click', runTieredCalibration);

  // ---- In-app Report modal --------------------------------------------
  const reportModal = document.getElementById('modal-calib-report');
  const reportBody = document.getElementById('calib-report-body');
  document.getElementById('calib-report-close')?.addEventListener('click',
    () => reportModal.classList.add('hidden'));
  reportModal?.addEventListener('click', (e) => {
    if (e.target === reportModal) reportModal.classList.add('hidden');
  });

  function buildReportHtml(score, reportDir) {
    if (!score) return '<p>No report available.</p>';
    const sep = reportDir.includes('\\') ? '\\' : '/';
    const s = score.score, total = score.total;
    const ratio = s / total;
    const bg = ratio >= 0.83 ? '#1a5c1a' : ratio >= 0.5 ? '#8a6a1a' : '#8a1a1a';
    const rows = score.results.map(r => {
      const got = 'file:///' + (reportDir + sep + r.got_img).replace(/\\/g, '/');
      const gt = 'file:///' + reportDir.replace(/\\/g, '/').replace(/\/reports\/[^/]+$/, '/ref_0_perfect_axes/') + r.axis + '.png';
      const cls = r.correct ? '#1a3c1a' : '#3c1a1a';
      const mark = r.correct ? '<span style="color:#6f6">OK</span>' : '<span style="color:#f66">XX</span>';
      return `<tr style="background:${cls};">
        <td style="padding:8px; min-width:100px;"><b>${r.axis}</b><br><small style="color:#aaa">${r.desc||''}</small></td>
        <td style="padding:8px;"><img src="${gt}" width="140" style="display:block; border:1px solid #333;"></td>
        <td style="padding:8px;"><img src="${got}" width="140" style="display:block; border:1px solid #333;"></td>
        <td style="padding:8px; font-family:monospace; font-size:13px;">${r.expected} &rarr; ${r.got} ${mark}<br>
          <small style="color:#aaa">sim ${(r.similarity||0).toFixed(2)}<br>conf ${(r.confidence||0).toFixed(2)}</small></td>
      </tr>`;
    }).join('');
    return `
      <p style="color:#aaa; margin:0 0 12px;"><code>${score.mesh||''}</code><br>
         <small>${score.timestamp||''}</small></p>
      <div style="margin-bottom:16px;">
        <span style="font-size:2em; font-weight:bold; padding:6px 18px; border-radius:8px; background:${bg}; color:#fff;">${s}/${total}</span>
        <span style="margin-left:12px; color:#aaa;">avg similarity ${(score.avg_similarity||0).toFixed(2)}</span>
      </div>
      <table style="border-collapse:collapse; width:100%;">
        <tr style="background:var(--bg-1);">
          <th style="padding:8px; text-align:left;">Axis</th>
          <th style="padding:8px; text-align:left;">Expected (ground truth)</th>
          <th style="padding:8px; text-align:left;">Got (generated)</th>
          <th style="padding:8px; text-align:left;">Result</th>
        </tr>
        ${rows}
      </table>`;
  }

  async function openReportModal() {
    const res = await API.calibLastReport();
    if (res && res.success && res.score) {
      reportBody.innerHTML = buildReportHtml(res.score, res.reportDir);
    } else {
      reportBody.innerHTML = '<p>No calibration run yet. Click "Run calibration" first.</p>';
    }
    reportModal.classList.remove('hidden');
  }

  // ---- In-app Gallery modal -------------------------------------------
  const galleryModal = document.getElementById('modal-calib-gallery');
  const galleryBody = document.getElementById('calib-gallery-body');
  const galleryCount = document.getElementById('calib-gallery-count');
  document.getElementById('calib-gallery-close')?.addEventListener('click',
    () => galleryModal.classList.add('hidden'));
  document.getElementById('calib-gallery-refresh')?.addEventListener('click',
    () => renderGallery());
  galleryModal?.addEventListener('click', (e) => {
    if (e.target === galleryModal) galleryModal.classList.add('hidden');
  });

  function buildGalleryCard(rep) {
    const sep = rep.dir.includes('\\') ? '\\' : '/';
    const ratio = rep.score / rep.total;
    const bg = ratio >= 0.83 ? '#1a5c1a' : ratio >= 0.5 ? '#8a6a1a' : '#8a1a1a';
    const meshFile = (rep.mesh || '').replace(/.*[\\/]/, '');
    const axes = (rep.results || []).map(r => {
      const img = 'file:///' + (rep.dir + sep + r.got_img).replace(/\\/g, '/');
      const border = r.correct ? '#3a3' : '#c33';
      return `<div style="position:relative; border-radius:4px; overflow:hidden; outline:2px solid ${border};">
          <img src="${img}" style="width:100%; display:block; background:#fff;">
          <div style="position:absolute; bottom:0; left:0; right:0; background:rgba(0,0,0,0.75); padding:2px 3px; font-size:9px; text-align:center; color:#fff;">
            ${r.axis}<br><b>${r.expected}&rarr;${r.got}</b>
          </div>
        </div>`;
    }).join('');
    return `<div class="calib-card" data-name="${rep.name}"
        style="background:#161616; border:1px solid #333; border-radius:8px; padding:12px; cursor:pointer;">
      <div style="display:flex; justify-content:space-between; gap:10px; align-items:baseline;">
        <div style="font-size:0.85em; color:#9cf; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; font-family:monospace;">${meshFile || rep.name}</div>
        <span style="padding:3px 10px; border-radius:4px; background:${bg}; color:#fff; font-weight:bold;">${rep.score}/${rep.total}</span>
      </div>
      <div style="font-size:10px; color:#888; margin:4px 0 8px;">${rep.timestamp||''} · sim ${(rep.similarity||0).toFixed(2)}</div>
      <div style="display:grid; grid-template-columns:repeat(6,1fr); gap:3px;">${axes}</div>
    </div>`;
  }

  async function renderGallery() {
    galleryBody.innerHTML = '<p style="color:#aaa">Loading...</p>';
    const res = await API.calibListReports();
    if (!res || !res.success) {
      galleryBody.innerHTML = `<p style="color:#f66">Error: ${res && res.error || 'unknown'}</p>`;
      return;
    }
    const reports = res.reports || [];
    galleryCount.textContent = `${reports.length} runs`;
    if (!reports.length) {
      galleryBody.innerHTML = '<p>No runs yet. Click "Run calibration" first.</p>';
      return;
    }
    galleryBody.innerHTML = '<div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(380px,1fr)); gap:12px;">' +
      reports.map(buildGalleryCard).join('') + '</div>';
    // Click a card to open its report
    galleryBody.querySelectorAll('.calib-card').forEach((el, i) => {
      el.addEventListener('click', () => {
        const rep = reports[i];
        reportBody.innerHTML = buildReportHtml({
          mesh: rep.mesh, score: rep.score, total: rep.total,
          avg_similarity: rep.similarity, timestamp: rep.timestamp,
          results: rep.results,
        }, rep.dir);
        reportModal.classList.remove('hidden');
      });
    });
  }

  function openGalleryModal() {
    galleryModal.classList.remove('hidden');
    renderGallery();
  }

  // Auto-load last result when Settings opens
  document.getElementById('btn-settings')?.addEventListener('click', () => {
    setTimeout(loadLast, 50);
  });
})();

// ============================================================
// LIVE LOGS VIEWER — streams logs/fabmesh.log (or any registered file)
// via the Control API SSE endpoint. Reuses the same token the control
// API wrote to .fabmesh/test_api_token.txt at startup.
// ============================================================
(() => {
  const modal = document.getElementById('modal-live-logs');
  const output = document.getElementById('ll-output');
  const fileSel = document.getElementById('ll-file');
  const filterInput = document.getElementById('ll-filter');
  const autoscrollCb = document.getElementById('ll-autoscroll');
  const pauseBtn = document.getElementById('ll-pause');
  const clearBtn = document.getElementById('ll-clear');
  const closeBtn = document.getElementById('ll-close');
  const statusEl = document.getElementById('ll-status');
  const countEl = document.getElementById('ll-count');
  if (!modal || !output) return;

  let eventSource = null;
  let paused = false;
  let buffered = []; // lines received while paused
  let lineCount = 0;
  let filterRe = null;

  function setStatus(txt, color) {
    if (statusEl) { statusEl.textContent = txt; statusEl.style.color = color || ''; }
  }

  function appendLine(line) {
    if (filterRe && !filterRe.test(line)) return;
    // Syntax-highlight by level
    const span = document.createElement('span');
    if (/level=ERROR|\bERROR\b/i.test(line)) span.style.color = '#ff6b6b';
    else if (/level=WARN|\bWARN\b/i.test(line)) span.style.color = '#ffd166';
    else if (/level=INFO/.test(line)) span.style.color = '#8ecae6';
    else span.style.color = '#ddd';
    span.textContent = line + '\n';
    output.appendChild(span);
    lineCount++;
    if (countEl) countEl.textContent = lineCount + ' lines';
    // Cap at 5000 lines to avoid runaway memory
    while (output.childNodes.length > 5000) output.removeChild(output.firstChild);
    if (autoscrollCb?.checked) output.scrollTop = output.scrollHeight;
  }

  async function readToken() {
    // The main process writes the token to .fabmesh/test_api_token.txt
    // and to <root>/.test_api_token. We can't read files from the
    // renderer directly, but main.js exposes a read-log-tail IPC we
    // can repurpose. Simpler: ask main via a tiny new IPC.
    try {
      const r = await API.getControlApiToken?.();
      return r || null;
    } catch { return null; }
  }

  async function openStream() {
    const file = fileSel?.value || 'fabmesh';
    const token = await readToken();
    if (!token) {
      setStatus('no token — is the Control API enabled?', '#ff6b6b');
      return;
    }
    closeStream();
    setStatus('loading history...', '#8ecae6');

    // Load the last 300 lines as initial context so the window isn't empty
    // before the first new log event arrives.
    try {
      const r = await fetch(`http://127.0.0.1:7331/logs?file=${encodeURIComponent(file)}&lines=300`, {
        headers: { 'Authorization': 'Bearer ' + token },
      });
      const j = await r.json();
      const text = (j && j.data && j.data.content) || '';
      for (const line of text.split(/\r?\n/)) {
        if (line) appendLine(line);
      }
    } catch (e) {
      appendLine('[viewer] failed to load history: ' + e.message);
    }

    setStatus('connecting to ' + file + '...', '#8ecae6');
    // EventSource doesn't support custom headers; use ?token= fallback.
    const url = `http://127.0.0.1:7331/logs/stream?file=${encodeURIComponent(file)}&token=${encodeURIComponent(token)}`;
    eventSource = new EventSource(url);
    eventSource.onopen = () => setStatus('live: ' + file, '#06d6a0');
    eventSource.onerror = () => setStatus('disconnected — retrying...', '#ff6b6b');
    eventSource.onmessage = (ev) => {
      const line = (ev.data || '').replace(/\\n/g, '\n');
      if (paused) { buffered.push(line); if (buffered.length > 1000) buffered.shift(); return; }
      appendLine(line);
    };
  }
  function closeStream() {
    if (eventSource) { try { eventSource.close(); } catch {} eventSource = null; }
    setStatus('disconnected');
  }

  document.getElementById('set-live-logs')?.addEventListener('click', () => {
    modal.classList.remove('hidden');
    document.getElementById('modal-settings')?.classList.add('hidden');
    output.innerHTML = '';
    lineCount = 0;
    if (countEl) countEl.textContent = '0 lines';
    openStream();
  });

  closeBtn?.addEventListener('click', () => {
    closeStream();
    modal.classList.add('hidden');
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) { closeStream(); modal.classList.add('hidden'); }
  });

  fileSel?.addEventListener('change', () => {
    output.innerHTML = ''; lineCount = 0;
    if (countEl) countEl.textContent = '0 lines';
    openStream();
  });

  filterInput?.addEventListener('input', () => {
    try { filterRe = filterInput.value ? new RegExp(filterInput.value, 'i') : null; }
    catch { filterRe = null; }
  });

  pauseBtn?.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.innerHTML = paused ? '\u25B6\uFE0F Resume' : '\u23F8\uFE0F Pause';
    if (!paused && buffered.length) {
      for (const l of buffered) appendLine(l);
      buffered = [];
    }
  });

  clearBtn?.addEventListener('click', () => {
    output.innerHTML = ''; lineCount = 0;
    if (countEl) countEl.textContent = '0 lines';
  });

  document.getElementById('ll-copy')?.addEventListener('click', async () => {
    const text = output.innerText || output.textContent || '';
    try {
      await navigator.clipboard.writeText(text);
      const btn = document.getElementById('ll-copy');
      if (btn) {
        const prev = btn.innerHTML;
        btn.innerHTML = '\u2713 Copied';
        setTimeout(() => { btn.innerHTML = prev; }, 1400);
      }
    } catch (e) {
      // Fallback: use a hidden textarea
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta);
      ta.select(); document.execCommand('copy');
      ta.remove();
    }
  });
})();

// ============================================================
// CONTROL API STATUS PANEL — Settings → Control API
// ============================================================
// Polls GET /status every 2 s while the Settings modal is open and
// fills in the Control API box with: green/red dot, full bearer
// token (read-only + copy), traffic counters, last 10 requests.
(() => {
  const dot   = document.getElementById('set-api-dot');
  const stat  = document.getElementById('set-api-status');
  const det   = document.getElementById('set-api-detail');
  const tok   = document.getElementById('set-api-token');
  const cpy   = document.getElementById('set-api-copy-token');
  const traf  = document.getElementById('set-api-traffic');
  const recent = document.getElementById('set-api-recent');
  const settingsModal = document.getElementById('modal-settings');
  if (!dot || !settingsModal) return;

  let _timer = null;
  let _token = null;

  async function fetchToken() {
    if (_token) return _token;
    try { _token = await API.getControlApiToken?.(); } catch { _token = null; }
    if (_token && tok) tok.value = _token;
    return _token;
  }

  function fmtTimeAgo(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    return Math.round(s / 3600) + 'h ago';
  }

  async function poll() {
    const t = await fetchToken();
    if (!t) {
      dot.style.background = '#666';
      stat.textContent = 'Disabled (no token)';
      if (det) det.textContent = 'Set FABMESH_CONTROL_API=1 (or just relaunch FabMesh) to enable.';
      return;
    }
    try {
      const r = await fetch('http://127.0.0.1:7331/status',
        { headers: { 'Authorization': 'Bearer ' + t } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const d = j.data;
      dot.style.background = '#06d6a0';
      stat.textContent = `Listening on ${d.host}:${d.port}`;
      if (det) det.textContent = `v${d.version} · uptime ${Math.floor((d.uptime_s||0)/60)}m${(d.uptime_s||0)%60}s`;
      if (traf) {
        const clients = Object.keys(d.recent_clients || {}).length;
        traf.innerHTML = `<strong style="color:#9bbac8;">Traffic:</strong> ${d.request_count_5min} requests in last 5min, ${d.request_count_total} total · ${clients} distinct client${clients>1?'s':''}`;
      }
      if (recent) {
        const rows = (d.recent_requests || []).slice().reverse().map(r =>
          `${fmtTimeAgo(r.ts).padStart(7)}  ${String(r.status).padEnd(3)} ${r.method.padEnd(4)} ${r.path}`
        );
        recent.textContent = rows.length ? rows.join('\n') : '(no requests yet)';
      }
    } catch (e) {
      dot.style.background = '#ef4444';
      stat.textContent = 'Unreachable';
      if (det) det.textContent = 'Server not responding: ' + (e.message || e);
    }
  }

  // Poll only while Settings modal is visible
  function startPolling() {
    if (_timer) return;
    poll();
    _timer = setInterval(poll, 2000);
  }
  function stopPolling() {
    if (_timer) { clearInterval(_timer); _timer = null; }
  }
  // MutationObserver on the modal's hidden class
  const mo = new MutationObserver(() => {
    if (!settingsModal.classList.contains('hidden')) startPolling();
    else stopPolling();
  });
  mo.observe(settingsModal, { attributes: true, attributeFilter: ['class'] });
  // First check at page load if modal is already open
  if (!settingsModal.classList.contains('hidden')) startPolling();

  // Copy token button
  cpy?.addEventListener('click', async () => {
    if (!_token) return;
    try {
      await navigator.clipboard.writeText(_token);
      const prev = cpy.textContent;
      cpy.textContent = '\u2713 Copied';
      setTimeout(() => { cpy.textContent = prev; }, 1400);
    } catch { /* clipboard refused */ }
  });
})();

// ============================================================
// PARENTAL CONTROL
// ============================================================
async function refreshParentalStatus() {
  const statusEl = document.getElementById('parental-status');
  const toggleBtn = document.getElementById('parental-toggle');
  const lockIcon = document.getElementById('btn-parental-lock');
  if (!statusEl || !toggleBtn || !API.getParentalStatus) return;
  try {
    const r = await API.getParentalStatus();
    // Topbar lock icon: always visible, changes icon based on state
    // 🔒 (U+1F512) = locked/restricted, 🔓 (U+1F513) = unlocked/unrestricted
    if (lockIcon) {
      lockIcon.style.display = '';
      lockIcon.innerHTML = r.unrestricted ? '&#128275;' : '&#128274;';
      lockIcon.title = r.unrestricted ? 'Unrestricted mode — click to lock' : 'Parental control active — click to unlock';
      lockIcon.style.opacity = r.unrestricted ? '0.4' : '0.8';
    }
    if (r.unrestricted) {
      statusEl.textContent = '🔓 Unrestricted';
      statusEl.style.color = '#f59e0b';
      toggleBtn.textContent = 'Lock';
      toggleBtn.classList.add('danger');
    } else {
      statusEl.textContent = '🔒 Restricted (safe)';
      statusEl.style.color = '#22c55e';
      toggleBtn.textContent = r.hasPin ? 'Unlock' : 'Set PIN & Unlock';
      toggleBtn.classList.remove('danger');
    }
  } catch(_) {}
}

// Shared function: prompt for PIN and toggle parental control
async function toggleParentalControl() {
  if (!API.getParentalStatus || !API.toggleUnrestricted) return;
  const status = await API.getParentalStatus();

  if (status.unrestricted) {
    // Lock — no PIN needed, instant
    const r = await API.toggleUnrestricted({ pin: 'lock', enable: false });
    if (r?.success) {
      showToast('Parental control re-enabled.', 'success');
      refreshParentalStatus();
      _nsfwKeywordsCache = null;
      renderProjectsGrid();
      _runNsfwBackgroundScan();
      // Refresh the open project workspace to hide/show NSFW images
      if (state.currentProject) {
        renderImageVersions(state.currentProject);
      }
    }
  } else {
    // Unlock — show legal warning first, then prompt for PIN
    const accepted = await _showNsfwWarning();
    if (!accepted) return;
    const pin = await _promptPin(status.hasPin ? 'Enter your PIN to unlock:' : 'Create a PIN (4+ digits) to enable unrestricted mode:');
    if (!pin) return;
    if (pin.length < 4) { showToast('PIN must be at least 4 digits.', 'error'); return; }
    const r = await API.toggleUnrestricted({ pin, enable: true });
    if (r?.success) {
      showToast('Unrestricted mode enabled.', 'info');
      refreshParentalStatus();
      _nsfwKeywordsCache = null;
      renderProjectsGrid();
      if (state.currentProject) {
        renderImageVersions(state.currentProject);
      }
    } else {
      showToast(r?.error || 'Wrong PIN', 'error');
    }
  }
}

// Legal warning before disabling parental control
function _showNsfwWarning() {
  return new Promise((resolve) => {
    const modal = document.getElementById('modal-confirm');
    const titleEl = document.getElementById('confirm-title');
    const msgEl = document.getElementById('confirm-message');
    const okBtn = document.getElementById('confirm-ok');
    const cancelBtn = document.getElementById('confirm-cancel');

    titleEl.textContent = '⚠️ WARNING — Legal Notice';
    msgEl.innerHTML = `
      <div style="text-align:left; line-height:1.6;">
        <p style="color:#ef4444; font-weight:700; font-size:14px; margin-bottom:12px;">
          You are about to disable the content filter. By proceeding, you confirm that:
        </p>
        <ul style="color:#fca5a5; font-size:12px; padding-left:20px; margin-bottom:12px;">
          <li><strong>You are over 18 years old</strong> (or the legal age of majority in your country)</li>
          <li>You take <strong>full personal responsibility</strong> for all content you generate</li>
          <li>You will <strong>NOT</strong> generate any content involving minors, children, or underage persons in any sexual, violent, or exploitative context</li>
          <li>You will <strong>NOT</strong> generate content depicting non-consensual acts, torture, or extreme violence against real persons</li>
        </ul>
        <p style="color:#ef4444; font-weight:700; font-size:13px; margin-bottom:8px;">
          ⚖️ LEGAL REMINDER
        </p>
        <p style="color:#d4d4d8; font-size:11px; margin-bottom:8px;">
          The creation, possession, or distribution of child sexual abuse material (CSAM) is a <strong>serious criminal offense</strong> in all jurisdictions worldwide, punishable by imprisonment.
        </p>
        <p style="color:#d4d4d8; font-size:11px; margin-bottom:8px;">
          Content depicting violence, terrorism, or hate speech may also violate local laws. <strong>You are solely responsible</strong> for ensuring that your use of this software complies with all applicable laws in your jurisdiction.
        </p>
        <p style="color:#fbbf24; font-size:11px; font-weight:600;">
          FabMesh and its developers assume NO liability for content generated by users in unrestricted mode.
        </p>
      </div>
    `;
    okBtn.textContent = 'I understand and accept responsibility';
    okBtn.classList.add('danger');
    okBtn.style.fontSize = '11px';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.display = '';
    const _prevZ = modal.style.zIndex;
    modal.style.zIndex = '99999';
    modal.classList.remove('hidden');

    function cleanup(result) {
      modal.classList.add('hidden');
      modal.style.zIndex = _prevZ;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onOverlay);
      okBtn.style.fontSize = '';
      okBtn.classList.remove('danger');
      msgEl.innerHTML = '';
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onOverlay(e) { if (e.target === modal) cleanup(false); }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onOverlay);
  });
}

// PIN prompt using the confirm modal (repurposed)
function _promptPin(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById('modal-confirm');
    const titleEl = document.getElementById('confirm-title');
    const msgEl = document.getElementById('confirm-message');
    const okBtn = document.getElementById('confirm-ok');
    const cancelBtn = document.getElementById('confirm-cancel');
    titleEl.textContent = 'Parental Control';
    // Create an inline input inside the message area
    msgEl.innerHTML = `<div style="margin-bottom:12px;">${message}</div>
      <input type="password" id="_pin-input" placeholder="PIN" maxlength="8"
        style="width:100%; padding:8px 12px; font-size:16px; text-align:center; letter-spacing:8px;
        background:var(--bg-0); border:1px solid var(--border); color:var(--text-0); border-radius:6px;" />`;
    okBtn.textContent = 'Confirm';
    okBtn.classList.remove('danger');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.display = '';
    const _prevZ = modal.style.zIndex;
    modal.style.zIndex = '99999'; // above Settings modal (9000)
    modal.classList.remove('hidden');
    setTimeout(() => document.getElementById('_pin-input')?.focus(), 50);

    function cleanup(result) {
      modal.classList.add('hidden');
      modal.style.zIndex = _prevZ;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onOverlay);
      msgEl.innerHTML = '';
      resolve(result);
    }
    function onOk() {
      const val = document.getElementById('_pin-input')?.value || '';
      cleanup(val);
    }
    function onCancel() { cleanup(null); }
    function onOverlay(e) { if (e.target === modal) cleanup(null); }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onOverlay);
  });
}

// Both the topbar lock icon and the settings button use the same function
document.getElementById('parental-toggle')?.addEventListener('click', toggleParentalControl);
document.getElementById('btn-parental-lock')?.addEventListener('click', toggleParentalControl);

// Kill SDXL server only (free ~6.6 GB VRAM)
document.getElementById('set-kill-sdxl')?.addEventListener('click', async () => {
  try {
    if (API.stopSdxlServer) await API.stopSdxlServer();
    showToast('SDXL server killed. VRAM freed.', 'success');
    setTimeout(refreshPythonStats, 1000);
  } catch(e) {
    showToast('Kill SDXL failed: ' + e.message, 'error');
  }
});

// Kill Processes: kill running Python subprocesses (generations) but keep SDXL
document.getElementById('set-kill-python')?.addEventListener('click', async () => {
  try {
    if (API.cancelJob) await API.cancelJob(0);
  } catch(_) {}
  state.jobs = state.jobs.filter(j => j.status !== 'running');
  renderJobs();
  showToast('Processes killed. SDXL preserved.', 'success');
  setTimeout(refreshPythonStats, 1000);
});

// Kill All: kill SDXL + all Python subprocesses
document.getElementById('set-kill-all')?.addEventListener('click', async () => {
  try { if (API.stopSdxlServer) await API.stopSdxlServer(); } catch(_) {}
  try { if (API.cancelJob) await API.cancelJob(0); } catch(_) {}
  state.jobs = state.jobs.filter(j => j.status !== 'running');
  renderJobs();
  showToast('All processes + SDXL killed. VRAM freed.', 'success');
  setTimeout(refreshPythonStats, 1000);
});

// Forward main process logs to the renderer console for live debugging
if (API.onMainLog) {
  API.onMainLog((entry) => {
    const fn = entry.level === 'ERROR' ? 'error' : (entry.level === 'WARN' ? 'warn' : 'log');
    console[fn](`[main:${entry.source}]`, entry.msg);
  });
}

// ============================================================
// MCP JOB TRACKING — jobs dispatched by Claude via the MCP server
// appear in the same job panel as user-triggered jobs.
// ============================================================
const _mcpJobs = new Map(); // type -> job.id
if (API.onMcpJobStart) {
  API.onMcpJobStart((data) => {
    const name = data.name || `MCP: ${data.type || 'task'}`;
    const expectedMs = { image: 120000, mesh: 45000, rig: 120000 }[data.type] || 90000;
    const job = pushJob(name, null, data.params || {}, expectedMs);
    _mcpJobs.set(data.type, job.id);
    console.log(`[MCP] job started: ${name} (id=${job.id})`);
    // Force the jobs panel open so the user sees what Claude is doing
    const panel = document.getElementById('jobs-panel-2');
    const bubble = document.getElementById('jobs-bubble-2');
    if (panel) panel.classList.remove('hidden');
    if (bubble) bubble.classList.add('hidden');
  });
}
if (API.onMcpJobEnd) {
  API.onMcpJobEnd((data) => {
    const jobId = _mcpJobs.get(data.type);
    if (jobId != null) {
      completeJob(jobId, !!data.success, data.error || null);
      _mcpJobs.delete(data.type);
      console.log(`[MCP] job ended: ${data.type} success=${data.success}`);
    }
    // Refresh the project workspace to show newly generated assets
    reloadCurrentProject().catch(() => {});
  });
}
if (API.onMcpRefresh) {
  API.onMcpRefresh(() => {
    // Refresh projects list + current workspace when MCP finishes any action
    reloadCurrentProject().catch(() => {});
  });
}
// Legacy: Blender browse button (removed from UI but handler kept to avoid crash
// if any code path still references it).
document.getElementById('set-blender-browse')?.addEventListener('click', async () => {
  try {
    const r = await API.setBlenderPath();
    if (r) {
      const el = document.getElementById('set-blender-path');
      if (el) el.value = r.blenderPath || r;
    }
  } catch (e) {}
});

// ----------- Meshy.ai API key: persist on blur, test via button ----------
const meshyKeyEl = document.getElementById('set-meshy-api-key');
if (meshyKeyEl) {
  // Persist the key to config.json as soon as the user leaves the field.
  meshyKeyEl.addEventListener('change', async () => {
    const key = meshyKeyEl.value.trim();
    try {
      await API.setConfig({ meshyApiKey: key });
    } catch (e) {
      console.warn('setConfig(meshyApiKey) failed', e);
    }
  });
}
document.getElementById('set-meshy-test')?.addEventListener('click', async () => {
  const btn = document.getElementById('set-meshy-test');
  const key = document.getElementById('set-meshy-api-key').value.trim();
  if (!key) { alert('Enter your Meshy API key first.'); return; }
  const orig = btn.textContent;
  btn.textContent = 'Testing...';
  btn.disabled = true;
  try {
    // Persist before testing so the user doesn't lose the typed key if the test roundtrips.
    await API.setConfig({ meshyApiKey: key });
    const r = await API.testMeshyKey(key);
    if (r && r.ok) {
      btn.textContent = 'OK';
      btn.style.background = '#1f6f3a';
      setTimeout(() => { btn.textContent = orig; btn.style.background = ''; btn.disabled = false; }, 1800);
    } else {
      btn.textContent = 'Failed';
      btn.style.background = '#7f1d1d';
      alert('Meshy key test failed: ' + (r?.error || 'unknown error'));
      setTimeout(() => { btn.textContent = orig; btn.style.background = ''; btn.disabled = false; }, 1800);
    }
  } catch (e) {
    btn.textContent = 'Error';
    alert('Test error: ' + e.message);
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
  }
});

// ----------- Claude Desktop: connect button + status check ----------
document.getElementById('set-claude-connect')?.addEventListener('click', async () => {
  const btn = document.getElementById('set-claude-connect');
  const status = document.getElementById('set-claude-status');
  const orig = btn.innerHTML;
  btn.innerHTML = 'Connecting...';
  btn.disabled = true;
  try {
    const r = await API.connectClaudeDesktop();
    if (r && r.success) {
      btn.innerHTML = '&#10003; Connected';
      btn.style.borderColor = '#1f6f3a';
      if (status) status.textContent = 'Restart Claude Desktop to activate.';
      if (status) status.style.color = '#86efac';
    } else {
      btn.innerHTML = 'Failed';
      if (status) status.textContent = r?.error || 'Unknown error';
      if (status) status.style.color = '#fca5a5';
    }
  } catch (e) {
    btn.innerHTML = 'Error';
    if (status) status.textContent = e.message;
  }
  setTimeout(() => {
    btn.innerHTML = orig; btn.disabled = false;
    checkClaudeDesktopStatus();
  }, 2000);
});
document.getElementById('set-claude-disconnect')?.addEventListener('click', async () => {
  const btn = document.getElementById('set-claude-disconnect');
  btn.disabled = true;
  btn.textContent = 'Disconnecting...';
  try {
    if (API.disconnectClaudeDesktop) {
      const r = await API.disconnectClaudeDesktop();
      if (r && r.success) {
        // Immediately update UI without waiting for timer
        btn.style.display = 'none';
        const connectBtn = document.getElementById('set-claude-connect');
        if (connectBtn) connectBtn.style.display = '';
        const status = document.getElementById('set-claude-status');
        if (status) { status.textContent = 'Disconnected'; status.style.color = 'var(--text-3)'; }
      }
    }
  } catch (e) {}
  btn.disabled = false;
  btn.textContent = 'Disconnect';
});
// Check connection status and toggle Connect/Disconnect buttons
async function checkClaudeDesktopStatus() {
  const status = document.getElementById('set-claude-status');
  const connectBtn = document.getElementById('set-claude-connect');
  const disconnectBtn = document.getElementById('set-claude-disconnect');
  if (!status || !API.checkClaudeDesktop) return;
  try {
    const r = await API.checkClaudeDesktop();
    const connected = !!(r && r.connected);
    status.textContent = connected ? 'Connected' : 'Not connected';
    status.style.color = connected ? '#86efac' : 'var(--text-2)';
    if (connectBtn) connectBtn.style.display = connected ? 'none' : '';
    if (disconnectBtn) disconnectBtn.style.display = connected ? '' : 'none';
  } catch (e) { /* ignore */ }
}

// ============================================================
// SKINNING SLIDER LABEL
// ============================================================
const skinSlider = document.getElementById('ws-rig-skin-smooth');
const skinSliderVal = document.getElementById('ws-rig-skin-smooth-val');
if (skinSlider && skinSliderVal) {
  const upd = () => { skinSliderVal.textContent = skinSlider.value; };
  skinSlider.addEventListener('input', upd);
  upd();
}

// ============================================================
// RE-SKIN ONLY (post-rig)
// ============================================================
document.getElementById('ws-rig-reskin-btn')?.addEventListener('click', async () => {
  const r = getCurrentRigObj();
  if (!r) { showToast('No rig yet.', 'error'); return; }
  const ok = await customConfirm('Re-skin this rig with current skinning options? The rig structure stays unchanged.', 'Re-skin', 'Re-skin');
  if (!ok) return;
  const skinMethod = document.getElementById('ws-rig-skin-method')?.value || 'auto';
  const skinSmoothing = parseInt(document.getElementById('ws-rig-skin-smooth')?.value) || 3;
  const mirrorX = document.getElementById('ws-rig-mirror-x')?.checked;
  const job = pushJob(`Re-skin: ${r.filename}`, null, {
    'Skinning': skinMethod,
    'Smoothing': skinSmoothing,
    'Mirror X': mirrorX ? 'yes' : 'no',
  });
  try {
    if (!API.autoRig) {
      completeJob(job.id, false);
      customError('Auto-rig API not available', 'Re-skin');
      return;
    }
    // Call auto-rig with the same template but reskin-only flag
    const result = await API.autoRig({ meshPath: r.path, templateName: '', skinMethod, skinSmoothing, mirrorX, reskinOnly: true });
    if (result?.success) {
      completeJob(job.id, true);
      await reloadCurrentProject();
    } else {
      completeJob(job.id, false);
      if (!job.cancelled) customError(result?.error || 'unknown', 'Re-skin failed');
    }
  } catch (e) {
    completeJob(job.id, false);
    if (!job.cancelled) customError(e?.error || e?.message || String(e), 'Re-skin error');
  }
});

// ============================================================
// DRAG & DROP (image / mesh files)
// ============================================================
const dropOverlay = document.getElementById('drop-overlay');
let dragCounter = 0;
window.addEventListener('dragenter', (e) => {
  if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
    dragCounter++;
    dropOverlay.classList.remove('hidden');
  }
});
window.addEventListener('dragleave', (e) => {
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    dropOverlay.classList.add('hidden');
  }
});
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.classList.add('hidden');
  const files = Array.from(e.dataTransfer?.files || []);
  if (files.length === 0) return;
  const f = files[0];
  const path_ = f.path || '';
  const isImage = /\.(png|jpg|jpeg|webp)$/i.test(f.name);
  const isMesh = /\.(glb|gltf|obj|fbx|stl|ply)$/i.test(f.name);
  if (!isImage && !isMesh) {
    alert('Unsupported file type. Drop a .png, .jpg, .glb, .fbx, .obj, .stl or .ply');
    return;
  }
  try {
    if (isImage && API.importImageFile) {
      await API.importImageFile(path_);
    } else if (isMesh && API.importMesh) {
      await API.importMesh();
    }
    await refreshProjectsPage();
  } catch (err) { alert('Import failed: ' + err.message); }
});

// ============================================================
// LANDMARKS (manual placement on the 3D mesh viewer)
// ============================================================
// Schema: 22 landmarks across 6 categories
const LM_SCHEMA = [
  { cat: 'Head & Spine', items: [
    { id: 'head', label: 'Head', color: '#ff4444' },
    { id: 'neck', label: 'Neck', color: '#ff8844' },
    { id: 'spine_top', label: 'Upper spine', color: '#ff6622' },
    { id: 'spine_mid', label: 'Mid spine', color: '#cc5511' },
    { id: 'hips', label: 'Hips center', color: '#ffaa00' },
  ]},
  { cat: 'Left arm', items: [
    { id: 'shoulder_l', label: 'L Shoulder', color: '#22cc88' },
    { id: 'elbow_l', label: 'L Elbow', color: '#88ff88' },
    { id: 'hand_l', label: 'L Wrist', color: '#44ff44' },
  ]},
  { cat: 'Right arm', items: [
    { id: 'shoulder_r', label: 'R Shoulder', color: '#11aa66' },
    { id: 'elbow_r', label: 'R Elbow', color: '#66cc66' },
    { id: 'hand_r', label: 'R Wrist', color: '#44aa44' },
  ]},
  { cat: 'Left leg', items: [
    { id: 'hip_l', label: 'L Hip', color: '#ffcc00' },
    { id: 'knee_l', label: 'L Knee', color: '#88aaff' },
    { id: 'ankle_l', label: 'L Ankle', color: '#5577ee' },
    { id: 'foot_l', label: 'L Foot', color: '#4444ff' },
  ]},
  { cat: 'Right leg', items: [
    { id: 'hip_r', label: 'R Hip', color: '#dd9900' },
    { id: 'knee_r', label: 'R Knee', color: '#6688cc' },
    { id: 'ankle_r', label: 'R Ankle', color: '#4466bb' },
    { id: 'foot_r', label: 'R Foot', color: '#4477ff' },
  ]},
];
const LM_RAYCASTER = new THREE.Raycaster();
const LM_NDC = new THREE.Vector2();
let lmActive = null; // currently armed landmark id
let lmMarkers = {}; // id -> THREE.Mesh

// ----- Landmarks undo/redo history -----
// Stack of snapshots {id: [x, y, z]}. We push a snapshot BEFORE each mutation
// (place, drag end, clear, auto-detect), so Undo restores the pre-mutation
// state. Redo replays snapshots in the forward direction.
const LM_HISTORY_LIMIT = 50;
let lmHistoryPast = [];
let lmHistoryFuture = [];
let _lmHistoryApplying = false; // guard to avoid re-pushing during undo/redo

function _lmSnapshot() {
  const snap = {};
  for (const id in lmMarkers) {
    const m = lmMarkers[id];
    if (!m) continue;
    snap[id] = [m.position.x, m.position.y, m.position.z];
  }
  return snap;
}
function lmPushHistory() {
  if (_lmHistoryApplying) return;
  lmHistoryPast.push(_lmSnapshot());
  if (lmHistoryPast.length > LM_HISTORY_LIMIT) lmHistoryPast.shift();
  lmHistoryFuture = []; // any new mutation clears the redo stack
  _updateLmUndoRedoButtons();
}
// Reflect the current undo/redo stack state on the UI buttons (disabled
// when there's nothing to undo / redo respectively).
function _updateLmUndoRedoButtons() {
  const undoBtn = document.getElementById('lm-fs-undo');
  const redoBtn = document.getElementById('lm-fs-redo');
  if (undoBtn) undoBtn.disabled = lmHistoryPast.length === 0;
  if (redoBtn) redoBtn.disabled = lmHistoryFuture.length === 0;
}
function _lmApplySnapshot(snap) {
  _lmHistoryApplying = true;
  // Remove current markers from every scene, then rebuild from the snapshot
  const colorMap = {};
  LM_SCHEMA.forEach(g => g.items.forEach(it => { colorMap[it.id] = it.color; }));
  for (const id in lmMarkers) {
    if (wsScene) wsScene.remove(lmMarkers[id]);
    if (rigSrcScene) rigSrcScene.remove(lmMarkers[id]);
    if (rigVwScene) rigVwScene.remove(lmMarkers[id]);
    if (typeof lmFsScene !== 'undefined' && lmFsScene) lmFsScene.remove(lmMarkers[id]);
    try { lmMarkers[id].geometry.dispose(); lmMarkers[id].material.dispose(); } catch (e) {}
  }
  lmMarkers = {};
  // Also wipe lightbox clones so they get re-made next time the lightbox opens
  if (typeof lb3dLandmarkClones !== 'undefined' && lb3dLandmarkClones && lb3dLandmarkClones.length) {
    for (const c of lb3dLandmarkClones) {
      if (typeof lb3dScene !== 'undefined' && lb3dScene) lb3dScene.remove(c);
      try { c.geometry.dispose(); c.material.dispose(); } catch (e) {}
    }
    lb3dLandmarkClones = [];
  }
  document.querySelectorAll('.lm-btn').forEach(b => b.classList.remove('placed', 'armed'));
  for (const id in snap) {
    const arr = snap[id];
    if (!Array.isArray(arr) || arr.length !== 3) continue;
    const color = parseInt((colorMap[id] || '#ffffff').replace('#', ''), 16);
    placeLandmarkMarker(id, new THREE.Vector3(arr[0], arr[1], arr[2]), color);
  }
  try { refreshLmFsSilhouetteDots && refreshLmFsSilhouetteDots(); } catch (_e) {}
  _lmHistoryApplying = false;
  saveLandmarksForCurrentMesh();
}
function lmUndo() {
  if (lmHistoryPast.length === 0) return;
  lmHistoryFuture.push(_lmSnapshot());
  const snap = lmHistoryPast.pop();
  _lmApplySnapshot(snap);
  _updateLmUndoRedoButtons();
}
function lmRedo() {
  if (lmHistoryFuture.length === 0) return;
  lmHistoryPast.push(_lmSnapshot());
  const snap = lmHistoryFuture.pop();
  _lmApplySnapshot(snap);
  _updateLmUndoRedoButtons();
}
// Global Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) — only active while a landmark
// surface is in use (workspace step 3 viewer or the landmarks fullscreen).
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  // Don't steal the shortcut if the user is typing in an input/textarea
  const tag = (e.target && e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;
  if (e.key === 'z' || e.key === 'Z') {
    if (e.shiftKey) lmRedo(); else lmUndo();
    e.preventDefault();
  } else if (e.key === 'y' || e.key === 'Y') {
    lmRedo();
    e.preventDefault();
  }
});

function buildLandmarkList() {
  const list = document.getElementById('ws-lm-list');
  if (!list) return;
  list.innerHTML = '';
  LM_SCHEMA.forEach(group => {
    const cat = document.createElement('div');
    cat.className = 'lm-cat';
    cat.textContent = group.cat;
    list.appendChild(cat);
    group.items.forEach(item => {
      const btn = document.createElement('button');
      btn.className = 'lm-btn';
      btn.dataset.lm = item.id;
      btn.dataset.color = item.color;
      btn.innerHTML = `<span class="lm-color" style="background:${item.color}"></span><span>${item.label}</span>`;
      btn.addEventListener('click', () => armLandmark(item.id, btn));
      // Mirror the 3D-viewer hover effect on the sidebar button: moving the
      // mouse onto an item scales the matching 3D marker and highlights its
      // silhouette dot across all panes.
      btn.addEventListener('mouseenter', () => setLandmarkHover(item.id));
      btn.addEventListener('mouseleave', () => setLandmarkHover(null));
      list.appendChild(btn);
    });
  });
}
buildLandmarkList();

function armLandmark(id, btn) {
  document.querySelectorAll('.lm-btn').forEach(b => b.classList.remove('armed'));
  if (lmActive === id) {
    lmActive = null;
    // Update the silhouette hint dot so it disappears when disarming
    try { refreshLmFsSilhouetteDots && refreshLmFsSilhouetteDots(); } catch (_e) {}
    return;
  }
  lmActive = id;
  btn.classList.add('armed');
  // Show a pulsing hint dot on the SVG silhouette at the target position
  try { refreshLmFsSilhouetteDots && refreshLmFsSilhouetteDots(); } catch (_e) {}
}

function placeLandmarkMarker(id, point, color) {
  // Pick the active scene + model: prefer rig source viewer, fall back to step 2
  const ctx = getActiveLandmarkModel();
  if (!ctx) return;
  const targetScene = ctx.scene;
  const targetModel = ctx.model;
  if (lmMarkers[id]) {
    // Remove from ALL scenes — the previous marker might have been added
    // to any of the viewers earlier in this session
    if (wsScene) wsScene.remove(lmMarkers[id]);
    if (rigSrcScene) rigSrcScene.remove(lmMarkers[id]);
    if (rigVwScene) rigVwScene.remove(lmMarkers[id]);
    if (typeof lmFsScene !== 'undefined' && lmFsScene) lmFsScene.remove(lmMarkers[id]);
    try { lmMarkers[id].geometry.dispose(); lmMarkers[id].material.dispose(); } catch (e) {}
  }
  // Auto-scale radius based on bbox
  let r = 0.03;
  if (targetModel) {
    const box = new THREE.Box3().setFromObject(targetModel);
    const sz = box.getSize(new THREE.Vector3());
    r = Math.max(sz.x, sz.y, sz.z) * 0.015;
  }
  const geo = new THREE.SphereGeometry(r, 16, 16);
  const mat = new THREE.MeshBasicMaterial({ color: color, depthTest: false, transparent: true, opacity: 0.85 });
  const sphere = new THREE.Mesh(geo, mat);
  sphere.position.copy(point);
  sphere.renderOrder = 999;
  targetScene.add(sphere);
  lmMarkers[id] = sphere;
  // Mark all matching buttons as placed (there can be one in the workspace
  // and one in the fullscreen modal)
  document.querySelectorAll(`.lm-btn[data-lm="${id}"]`).forEach(btn => btn.classList.add('placed'));
  // Refresh the SVG silhouette dots if the fullscreen modal is open
  if (typeof refreshLmFsSilhouetteDots === 'function') refreshLmFsSilhouetteDots();
}

function clearAllLandmarks() {
  lmPushHistory(); // snapshot so Ctrl+Z can restore the cleared markers
  // Remove from ALL scenes — markers may have been placed in any viewer
  // (workspace, rig source, rig viewer, lmFs fullscreen modal)
  for (const id in lmMarkers) {
    if (wsScene) wsScene.remove(lmMarkers[id]);
    if (rigSrcScene) rigSrcScene.remove(lmMarkers[id]);
    if (rigVwScene) rigVwScene.remove(lmMarkers[id]);
    if (typeof lmFsScene !== 'undefined' && lmFsScene) lmFsScene.remove(lmMarkers[id]);
    try { lmMarkers[id].geometry.dispose(); lmMarkers[id].material.dispose(); } catch (e) {}
  }
  lmMarkers = {};
  // Also dispose the landmark clones mirrored into the 3D lightbox scene,
  // otherwise stale clones stay visible after Clear all while the lightbox
  // is open.
  if (typeof lb3dLandmarkClones !== 'undefined' && lb3dLandmarkClones && lb3dLandmarkClones.length) {
    for (const c of lb3dLandmarkClones) {
      if (typeof lb3dScene !== 'undefined' && lb3dScene) lb3dScene.remove(c);
      try { c.geometry.dispose(); c.material.dispose(); } catch (e) {}
    }
    lb3dLandmarkClones = [];
  }
  document.querySelectorAll('.lm-btn').forEach(b => b.classList.remove('placed', 'armed'));
  lmActive = null;
  // Refresh the silhouette SVG dots inside the lm fullscreen modal if open
  try { refreshLmFsSilhouetteDots && refreshLmFsSilhouetteDots(); } catch (_e) {}
  saveLandmarksForCurrentMesh();
}

async function saveLandmarksForCurrentMesh() {
  const p = state.currentProject;
  if (!p || !p.selectedMeshPath) return;
  const data = {};
  for (const id in lmMarkers) {
    const m = lmMarkers[id];
    data[id] = [m.position.x, m.position.y, m.position.z];
  }
  try { await API.saveLandmarks?.({ meshPath: p.selectedMeshPath, landmarks: data }); }
  catch (e) { console.warn('saveLandmarks failed:', e); }
}

async function loadLandmarksForCurrentMesh() {
  // Clear current — remove from all scenes (rig source + rig viewer + step 2)
  for (const id in lmMarkers) {
    if (wsScene) wsScene.remove(lmMarkers[id]);
    if (rigSrcScene) rigSrcScene.remove(lmMarkers[id]);
    if (rigVwScene) rigVwScene.remove(lmMarkers[id]);
    try { lmMarkers[id].geometry.dispose(); lmMarkers[id].material.dispose(); } catch (e) {}
  }
  lmMarkers = {};
  document.querySelectorAll('.lm-btn').forEach(b => b.classList.remove('placed', 'armed'));
  lmActive = null;
  const p = state.currentProject;
  if (!p || !p.selectedMeshPath) return;
  try {
    const data = await API.loadLandmarks?.({ meshPath: p.selectedMeshPath });
    if (data && typeof data === 'object') {
      const colorMap = {};
      LM_SCHEMA.forEach(g => g.items.forEach(it => { colorMap[it.id] = it.color; }));
      for (const id in data) {
        const arr = data[id];
        if (Array.isArray(arr) && arr.length === 3) {
          const color = parseInt((colorMap[id] || '#ffffff').replace('#', ''), 16);
          placeLandmarkMarker(id, new THREE.Vector3(arr[0], arr[1], arr[2]), color);
        }
      }
    }
  } catch (e) {}
}

function getActiveLandmarkModel() {
  // Landmarks are a rig *input*, not an overlay to display on the finished
  // rig viewer. The rig viewer (rigVwModel) has potentially a different
  // unit scale (cm for FBX vs m for GLB source), so showing the stored
  // mesh-space landmarks there produces wrong positions.
  // Priority: fullscreen modal > rig source (clean mesh preview) > ws-mesh.
  const lmFsOpen = document.getElementById('lm-fullscreen') && !document.getElementById('lm-fullscreen').classList.contains('hidden');
  if (lmFsOpen && lmFsModel) return { model: lmFsModel, scene: lmFsScene };
  if (rigSrcModel) return { model: rigSrcModel, scene: rigSrcScene };
  if (wsModel) return { model: wsModel, scene: wsScene };
  return null;
}

function autoDetectLandmarks() {
  const ctx = getActiveLandmarkModel();
  if (!ctx) { customError('Load a mesh first (use the "Use this mesh for Rig" button in the 3D Mesh card).', 'Auto-detect landmarks'); return; }
  lmPushHistory(); // snapshot current state before replacing everything
  const targetModel = ctx.model;
  const box = new THREE.Box3().setFromObject(targetModel);
  const min = box.min, max = box.max;
  const size = new THREE.Vector3().subVectors(max, min);
  const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
  // Human bbox: up = tallest axis, then lateral, then depth (shortest)
  const axes = [
    { k: 'x', v: size.x }, { k: 'y', v: size.y }, { k: 'z', v: size.z }
  ].sort((a, b) => b.v - a.v);
  const upAxis = axes[0].k;
  const lateralAxis = axes[1].k;
  const depthAxis = axes[2].k;
  const minU = min[upAxis], maxU = max[upAxis], sU = maxU - minU;
  const sL = size[lateralAxis];
  const sD = size[depthAxis];

  const meshList = [];
  targetModel.traverse(c => { if (c.isMesh && c.geometry) meshList.push(c); });

  // ---------- Slice analysis ----------
  // For a given height (y), find the lateral and depth bounds of the mesh
  // by raycasting from all 4 cardinal directions toward the centerline at
  // that height. Returns { left, right, front, back, midL, midD } in world
  // coordinates, or null if the slice is empty (e.g. above the head).
  const _ray = new THREE.Raycaster();
  function _castFrom(originVal, axis, dirSign, otherAxesValues) {
    const origin = new THREE.Vector3();
    origin[upAxis] = otherAxesValues.up;
    origin[lateralAxis] = otherAxesValues.lat;
    origin[depthAxis] = otherAxesValues.dep;
    origin[axis] = originVal;
    const dir = new THREE.Vector3();
    dir[axis] = -dirSign;
    _ray.set(origin, dir.normalize());
    const hits = _ray.intersectObjects(meshList, true);
    return hits.length > 0 ? hits[0].point[axis] : null;
  }
  function sliceAt(yWorld) {
    // Lateral bounds: cast from +lateral and -lateral, at depth = center
    const right = _castFrom(center[lateralAxis] + sL * 1.5, lateralAxis, +1, { up: yWorld, lat: 0, dep: center[depthAxis] });
    const left  = _castFrom(center[lateralAxis] - sL * 1.5, lateralAxis, -1, { up: yWorld, lat: 0, dep: center[depthAxis] });
    // Depth bounds: cast from +depth and -depth, at lateral = center
    const front = _castFrom(center[depthAxis] + sD * 1.5, depthAxis, +1, { up: yWorld, lat: center[lateralAxis], dep: 0 });
    const back  = _castFrom(center[depthAxis] - sD * 1.5, depthAxis, -1, { up: yWorld, lat: center[lateralAxis], dep: 0 });
    if (right === null && left === null && front === null && back === null) return null;
    const midL = (right !== null && left !== null) ? (right + left) / 2 : center[lateralAxis];
    const midD = (front !== null && back !== null) ? (front + back) / 2 : center[depthAxis];
    return {
      left:  left  !== null ? left  : center[lateralAxis] - sL * 0.5,
      right: right !== null ? right : center[lateralAxis] + sL * 0.5,
      front: front !== null ? front : center[depthAxis] + sD * 0.5,
      back:  back  !== null ? back  : center[depthAxis] - sD * 0.5,
      midL, midD,
    };
  }
  // Build a Vector3 in world space from up/lat/dep components
  function makePt(upVal, latVal, depVal) {
    const v = new THREE.Vector3();
    v[upAxis] = upVal;
    v[lateralAxis] = latVal;
    v[depthAxis] = depVal;
    return v;
  }
  // Convenience: world Y for a fraction of total height
  const Y = (frac) => minU + sU * frac;

  // ---------- Centerline landmarks ----------
  // Use the slice midpoint at each height for the most accurate centerline.
  function centerlineAt(frac) {
    const y = Y(frac);
    const s = sliceAt(y);
    if (!s) return makePt(y, center[lateralAxis], center[depthAxis]);
    return makePt(y, s.midL, s.midD);
  }

  const raw = {};
  raw.head      = centerlineAt(0.94); // crown
  raw.neck      = centerlineAt(0.86);
  raw.spine_top = centerlineAt(0.78); // sternum
  raw.spine_mid = centerlineAt(0.62); // navel
  raw.hips      = centerlineAt(0.52);

  // ---------- Shoulders ----------
  // Shoulders sit at the WIDEST part of the upper torso. Sample a few heights
  // around 0.78–0.84 and pick the one with the largest lateral spread.
  let bestShoulderY = Y(0.82), bestShoulderSpan = 0;
  for (let f = 0.76; f <= 0.86; f += 0.01) {
    const s = sliceAt(Y(f));
    if (!s) continue;
    const span = s.right - s.left;
    if (span > bestShoulderSpan) { bestShoulderSpan = span; bestShoulderY = Y(f); }
  }
  const shoulderSlice = sliceAt(bestShoulderY);
  if (shoulderSlice) {
    const inset = (shoulderSlice.right - shoulderSlice.left) * 0.08; // pull in slightly so we land on the deltoid, not air
    raw.shoulder_l = makePt(bestShoulderY, shoulderSlice.right - inset, shoulderSlice.midD);
    raw.shoulder_r = makePt(bestShoulderY, shoulderSlice.left  + inset, shoulderSlice.midD);
  }

  // ---------- Hips (left/right) ----------
  // Slice at hip height; left and right hip live ~halfway between centerline
  // and the lateral edge of the slice.
  const hipSlice = sliceAt(Y(0.52));
  if (hipSlice) {
    const half = (hipSlice.right - hipSlice.left) * 0.25;
    raw.hip_l = makePt(Y(0.52), hipSlice.midL + half, hipSlice.midD);
    raw.hip_r = makePt(Y(0.52), hipSlice.midL - half, hipSlice.midD);
  }

  // ---------- Legs (knees, ankles, feet) ----------
  // The legs separation is fixed at the hips and the lateral spacing only
  // shrinks slightly toward the feet. Rather than relying on the slice midL
  // (which can collapse to centerline if the slice is solid), we copy the
  // hip lateral spacing down through the leg chain.
  let hipLatHalf = sL * 0.11; // safe default
  if (raw.hip_l && raw.hip_r) {
    hipLatHalf = Math.abs((raw.hip_l[lateralAxis] - raw.hip_r[lateralAxis]) / 2);
  }
  const hipLatCenter = raw.hips ? raw.hips[lateralAxis] : center[lateralAxis];
  function legPair(frac, idL, idR, latShrink = 1.0) {
    const y = Y(frac);
    const s = sliceAt(y);
    const half = hipLatHalf * latShrink;
    const dep = s ? s.midD : center[depthAxis];
    raw[idL] = makePt(y, hipLatCenter + half, dep);
    raw[idR] = makePt(y, hipLatCenter - half, dep);
  }
  legPair(0.30, 'knee_l', 'knee_r', 0.85); // knees slightly inward
  legPair(0.06, 'ankle_l', 'ankle_r', 0.85);
  // Feet: same lateral spacing as ankles, lower Y, depth toward front of slice
  const footY = Y(0.02);
  const footSlice = sliceAt(footY);
  if (footSlice) {
    const toeD = footSlice.front - sD * 0.04;
    raw.foot_l = makePt(footY, hipLatCenter + hipLatHalf * 0.85, toeD);
    raw.foot_r = makePt(footY, hipLatCenter - hipLatHalf * 0.85, toeD);
  }

  // ---------- Arms (elbows, hands) ----------
  // Arms typically hang along the body in a rest pose. We use a depth-based
  // raycast to find the arm by casting horizontally (front-to-back) at the
  // arm height, on each side of the body. The first hit on a side beyond
  // the torso is the arm.
  function findArm(yFrac, sideSign) {
    const y = Y(yFrac);
    const s = sliceAt(y);
    if (!s) return null;
    // Arm lateral coordinate: outside the torso, on the requested side
    const torsoHalf = (s.right - s.left) * 0.5;
    const armLat = sideSign > 0
      ? s.right - torsoHalf * 0.15  // a bit inside the lateral edge
      : s.left  + torsoHalf * 0.15;
    // Cast from front to back at this lateral; the first hit IS the arm
    const armDep = _castFrom(center[depthAxis] + sD * 1.5, depthAxis, +1, { up: y, lat: armLat, dep: 0 });
    if (armDep === null) {
      // Fallback: place at slice midD
      return makePt(y, armLat, s.midD);
    }
    // Pull slightly forward so it sits on the surface, not embedded
    return makePt(y, armLat, armDep + sD * 0.02);
  }
  raw.shoulder_l = findArm(0.82, +1) || raw.shoulder_l;
  raw.elbow_l    = findArm(0.66, +1) || raw.elbow_l;
  raw.hand_l     = findArm(0.50, +1) || raw.hand_l;
  raw.shoulder_r = findArm(0.82, -1) || raw.shoulder_r;
  raw.elbow_r    = findArm(0.66, -1) || raw.elbow_r;
  raw.hand_r     = findArm(0.50, -1) || raw.hand_r;

  const colorMap = {};
  LM_SCHEMA.forEach(g => g.items.forEach(it => { colorMap[it.id] = it.color; }));
  for (const id in raw) {
    const color = parseInt((colorMap[id] || '#ffffff').replace('#', ''), 16);
    placeLandmarkMarker(id, raw[id], color);
  }
  saveLandmarksForCurrentMesh();
}

function setupLandmarkRaycasting() {
  bindLandmarkRaycaster(document.getElementById('ws-mesh-canvas'), () => wsModel, () => wsCamera, () => wsControls);
  bindLandmarkRaycaster(document.getElementById('ws-rig-source-canvas'), () => rigSrcModel, () => rigSrcCamera, () => rigSrcControls);
  bindLandmarkRaycaster(document.getElementById('ws-rig-canvas'), () => rigVwModel, () => rigVwCamera, () => rigVwControls);
  // Note: the landmarks fullscreen modal has two canvases bound later in
  // initLmFullscreen() with their own cameras. Don't bind here.
}

// Raycast helper: returns the 3D hit point on `model` under the mouse event,
// or null if no hit. Takes a canvas + camera for the NDC transform.
function _raycastModel(canvas, camera, model, ev) {
  if (!canvas || !camera || !model) return null;
  const rect = canvas.getBoundingClientRect();
  LM_NDC.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  LM_RAYCASTER.setFromCamera(LM_NDC, camera);
  const meshes = [];
  model.traverse(c => { if (c.isMesh) meshes.push(c); });
  const hits = LM_RAYCASTER.intersectObjects(meshes, true);
  return hits.length > 0 ? hits[0].point.clone() : null;
}

// Raycast the landmark marker spheres to see if the mouse is over one. We
// cast against ALL markers in lmMarkers (they may live in different scenes)
// but we filter by the hit camera so only markers in the viewer's active
// scene can match — achieved by testing that the marker's parent chain
// contains the camera's scene.
function _raycastMarkers(canvas, camera, ev) {
  if (!canvas || !camera) return null;
  const rect = canvas.getBoundingClientRect();
  LM_NDC.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  LM_RAYCASTER.setFromCamera(LM_NDC, camera);
  const all = [];
  for (const id in lmMarkers) {
    const m = lmMarkers[id];
    if (m && m.visible) { m.userData._lmId = id; all.push(m); }
  }
  if (all.length === 0) return null;
  const hits = LM_RAYCASTER.intersectObjects(all, false);
  if (hits.length === 0) return null;
  return hits[0].object.userData._lmId || null;
}

function bindLandmarkRaycaster(canvas, getModel, getCamera, getControls) {
  if (!canvas) return;
  let dragging = null; // id of marker being dragged, or null

  canvas.addEventListener('mousedown', (e) => {
    const model = getModel();
    const camera = getCamera();
    const controls = getControls?.();
    if (e.button !== 0 || !model || !camera) return;

    // CASE 1: a landmark is armed in the sidebar → place it at the click point
    if (lmActive) {
      const pt = _raycastModel(canvas, camera, model, e);
      if (pt) {
        lmPushHistory(); // snapshot before mutation for undo
        const btn = document.querySelector(`.lm-btn[data-lm="${lmActive}"]`);
        const colorHex = btn?.dataset.color || '#ffffff';
        const color = parseInt(colorHex.replace('#', ''), 16);
        placeLandmarkMarker(lmActive, pt, color);
        saveLandmarksForCurrentMesh();
        btn?.classList.remove('armed');
        lmActive = null;
        e.stopPropagation();
        e.preventDefault();
      }
      return;
    }

    // CASE 2: the user clicked on an existing marker → start dragging it.
    // Disable OrbitControls on BOTH landmark-fullscreen panes (not just the
    // one where the click started) so the camera doesn't rotate when the
    // mouse drifts into the other pane during the drag — that was also
    // clearing the "active view" highlight of the other pane.
    const hitId = _raycastMarkers(canvas, camera, e);
    if (hitId && lmMarkers[hitId]) {
      lmPushHistory(); // capture pre-drag position for undo
      dragging = hitId;
      if (controls) controls.enabled = false;
      if (typeof lmFsControls !== 'undefined' && lmFsControls) lmFsControls.enabled = false;
      if (typeof lmFsControlsB !== 'undefined' && lmFsControlsB) lmFsControlsB.enabled = false;
      canvas.style.cursor = 'grabbing';
      // Attach the move/up listeners to the document so the drag survives
      // the mouse leaving the canvas (common when dragging near edges or
      // between the two split panes).
      document.addEventListener('mousemove', _dragMove, true);
      document.addEventListener('mouseup', _dragUp, true);
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);

  function _dragMove(e) {
    if (!dragging) return;
    const model = getModel();
    const camera = getCamera();
    if (!model || !camera) return;
    // Raycast against the mesh to get the surface point under the cursor
    const pt = _raycastModel(canvas, camera, model, e);
    const marker = lmMarkers[dragging];
    if (pt && marker) {
      // Project the hit point onto the plane perpendicular to the camera's
      // view direction that passes through the marker's ORIGINAL position.
      // This locks the "depth" along the camera axis so dragging in the
      // front view only affects X/Y, dragging in the side view only affects
      // Y/Z, etc. — the other pane's perpendicular coordinate stays put.
      const camDir = new THREE.Vector3();
      camera.getWorldDirection(camDir); // unit vector, camera forward
      // Depth of the marker along the camera axis (relative to origin)
      const markerDepth = marker.position.clone().sub(camera.position).dot(camDir);
      // Depth of the raycast hit along the same axis
      const hitDepth = pt.clone().sub(camera.position).dot(camDir);
      // Slide the hit point along the camera ray so its depth matches
      // the marker's — i.e. keep the marker on its original slice plane.
      const corrected = pt.clone().addScaledVector(camDir, markerDepth - hitDepth);
      marker.position.copy(corrected);
      try { refreshLmFsSilhouetteDots && refreshLmFsSilhouetteDots(); } catch (_e) {}
    }
    e.stopPropagation();
    e.preventDefault();
  }
  function _dragUp(e) {
    if (!dragging) return;
    dragging = null;
    // Restore orbit controls on both panes
    const _ctl = getControls?.();
    if (_ctl) _ctl.enabled = true;
    if (typeof lmFsControls !== 'undefined' && lmFsControls) lmFsControls.enabled = true;
    if (typeof lmFsControlsB !== 'undefined' && lmFsControlsB) lmFsControlsB.enabled = true;
    canvas.style.cursor = '';
    saveLandmarksForCurrentMesh();
    document.removeEventListener('mousemove', _dragMove, true);
    document.removeEventListener('mouseup', _dragUp, true);
    if (e) { e.stopPropagation(); e.preventDefault(); }
  }

  // Hover affordance: grab cursor + enlarge the hovered marker (and its
  // silhouette SVG dot) so the user sees which landmark is under the mouse.
  canvas.addEventListener('mousemove', (e) => {
    if (dragging || lmActive) return;
    const camera = getCamera();
    if (!camera) return;
    const hitId = _raycastMarkers(canvas, camera, e);
    canvas.style.cursor = hitId ? 'grab' : '';
    setLandmarkHover(hitId);
  });
  canvas.addEventListener('mouseleave', () => setLandmarkHover(null));
}
setupLandmarkRaycasting();

// Track the currently-hovered landmark id across all viewers. Applies a
// visual scale bump to the 3D marker and a highlight class to the matching
// silhouette SVG dots in the fullscreen modal. Null clears the hover.
let _lmHoverId = null;
function setLandmarkHover(id) {
  if (_lmHoverId === id) return;
  // Restore the previously-hovered marker
  if (_lmHoverId && lmMarkers[_lmHoverId]) {
    lmMarkers[_lmHoverId].scale.set(1, 1, 1);
  }
  // Also restore any lightbox clone that was bumped
  if (typeof lb3dLandmarkClones !== 'undefined' && lb3dLandmarkClones) {
    for (const c of lb3dLandmarkClones) {
      if (c && c.name === '__lb3dLm__' + _lmHoverId) c.scale.set(1, 1, 1);
    }
  }
  _lmHoverId = id;
  if (_lmHoverId && lmMarkers[_lmHoverId]) {
    lmMarkers[_lmHoverId].scale.set(1.6, 1.6, 1.6);
  }
  if (typeof lb3dLandmarkClones !== 'undefined' && lb3dLandmarkClones) {
    for (const c of lb3dLandmarkClones) {
      if (c && c.name === '__lb3dLm__' + _lmHoverId) c.scale.set(1.6, 1.6, 1.6);
    }
  }
  // Sync the silhouette SVG highlight — rebuild the dots so the hovered one
  // is drawn with the `hovered` class (larger radius + stronger stroke).
  try { refreshLmFsSilhouetteDots && refreshLmFsSilhouetteDots(); } catch (_e) {}
  // Also reflect the hover on the side-panel list buttons
  document.querySelectorAll('.lm-btn').forEach(b => b.classList.remove('hovered'));
  if (_lmHoverId) {
    document.querySelectorAll(`.lm-btn[data-lm="${_lmHoverId}"]`).forEach(b => b.classList.add('hovered'));
  }
}

document.getElementById('ws-lm-auto')?.addEventListener('click', autoDetectLandmarks);
document.getElementById('ws-lm-clear')?.addEventListener('click', async () => {
  if (!await customConfirm('Clear all landmarks for this mesh?', 'Clear landmarks', 'Clear')) return;
  clearAllLandmarks();
});
// ============================================================
// LANDMARKS FULLSCREEN MODAL
// ============================================================
// Dual-pane landmark fullscreen: two independent renderers/cameras/controls
// sharing a single scene and model. Markers are added to the shared scene
// so both panes see them; placing or dragging in one pane mirrors into the
// other automatically (same Three.js object).
let lmFsRenderer, lmFsScene, lmFsCamera, lmFsControls, lmFsModel;
let lmFsRendererB, lmFsCameraB, lmFsControlsB;
function initLmFullscreen() {
  if (lmFsRenderer) return;
  const canvasA = document.getElementById('lm-fs-canvas');
  const canvasB = document.getElementById('lm-fs-canvas-b');
  if (!canvasA) return;
  // Shared scene + lights
  lmFsScene = new THREE.Scene();
  lmFsScene.background = new THREE.Color(0x0b0b14);
  lmFsScene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.0));
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(5, 8, 5);
  lmFsScene.add(dir);
  lmFsScene.add(new THREE.DirectionalLight(0xffffff, 0.5).translateX(-5).translateY(3).translateZ(-5));
  lmFsScene.add(new THREE.AmbientLight(0xffffff, 0.3));
  // Pane A (Front by default)
  lmFsRenderer = new THREE.WebGLRenderer({ canvas: canvasA, antialias: true, alpha: true });
  lmFsRenderer.setPixelRatio(window.devicePixelRatio);
  lmFsRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  lmFsRenderer.toneMappingExposure = 1.0;
  lmFsCamera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
  lmFsControls = new OrbitControls(lmFsCamera, canvasA);
  lmFsControls.enableDamping = true;
  // Clear the "active view" button highlight when the user actually ROTATES
  // the camera — not on any mousedown. We detect a real rotation by comparing
  // the current camera azimuth/polar to the snapshot we took the last time a
  // preset was applied. A tiny epsilon filters out jitter from control damping.
  lmFsControls.addEventListener('change', () => {
    _checkLmFsPresetDrift('a');
  });
  // Pane B (Side by default) — only created if the second canvas exists
  if (canvasB) {
    lmFsRendererB = new THREE.WebGLRenderer({ canvas: canvasB, antialias: true, alpha: true });
    lmFsRendererB.setPixelRatio(window.devicePixelRatio);
    lmFsRendererB.toneMapping = THREE.ACESFilmicToneMapping;
    lmFsRendererB.toneMappingExposure = 1.0;
    lmFsCameraB = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
    lmFsControlsB = new OrbitControls(lmFsCameraB, canvasB);
    lmFsControlsB.enableDamping = true;
    lmFsControlsB.addEventListener('change', () => {
      _checkLmFsPresetDrift('b');
    });
  }
  function tick() {
    if (!document.getElementById('lm-fullscreen').classList.contains('hidden')) {
      lmFsControls.update();
      lmFsRenderer.render(lmFsScene, lmFsCamera);
      if (lmFsRendererB) {
        lmFsControlsB.update();
        lmFsRendererB.render(lmFsScene, lmFsCameraB);
      }
    }
    requestAnimationFrame(tick);
  }
  tick();
  // Bind raycaster on both canvases. Pane A uses camera A, pane B uses camera B.
  bindLandmarkRaycaster(canvasA, () => lmFsModel, () => lmFsCamera, () => lmFsControls);
  if (canvasB) {
    bindLandmarkRaycaster(canvasB, () => lmFsModel, () => lmFsCameraB, () => lmFsControlsB);
  }
}

function resizeLmFullscreen() {
  if (!lmFsRenderer) return;
  const canvasA = document.getElementById('lm-fs-canvas');
  if (canvasA) {
    const w = canvasA.clientWidth, h = canvasA.clientHeight;
    lmFsRenderer.setSize(w, h, false);
    lmFsCamera.aspect = w / h;
    lmFsCamera.updateProjectionMatrix();
  }
  if (lmFsRendererB) {
    const canvasB = document.getElementById('lm-fs-canvas-b');
    if (canvasB) {
      const w = canvasB.clientWidth, h = canvasB.clientHeight;
      lmFsRendererB.setSize(w, h, false);
      lmFsCameraB.aspect = w / h;
      lmFsCameraB.updateProjectionMatrix();
    }
  }
}

async function openLandmarksFullscreen() {
  // Always load the SOURCE MESH (clean GLB) into the fullscreen modal — never
  // the generated rig FBX. Landmarks are an INPUT to the rigger; they live in
  // mesh-space coordinates, so showing them on a rig that may be in different
  // units (cm vs m) would place them off-screen or offset.
  const sourcePath = rigSrcMeshPath
    || state.currentProject?.selectedMeshPath
    || (state.currentProject?.meshes && state.currentProject.meshes[0]?.path);
  if (!sourcePath) {
    customError('Load a mesh first.', 'Manual landmarks');
    return;
  }
  initLmFullscreen();
  document.getElementById('lm-fullscreen').classList.remove('hidden');
  setTimeout(resizeLmFullscreen, 50);
  _updateLmUndoRedoButtons();
  // Show file info in the top-left overlay
  const lmInfoEl = document.getElementById('lm-fs-info');
  if (lmInfoEl) renderViewerInfo(lmInfoEl, sourcePath, []);
  // Clear previous model
  if (lmFsModel && lmFsScene) { lmFsScene.remove(lmFsModel); lmFsModel = null; }
  const ext = sourcePath.split('.').pop().toLowerCase();
  function fitFs(obj) {
    lmFsModel = obj;
    lmFsScene.add(lmFsModel);
    const box = new THREE.Box3().setFromObject(lmFsModel);
    const sizeVec = box.getSize(new THREE.Vector3());
    const size = sizeVec.length();
    const center = box.getCenter(new THREE.Vector3());
    lmFsModel.position.x -= center.x;
    lmFsModel.position.z -= center.z;
    lmFsModel.position.y -= box.min.y;
    const lookY = sizeVec.y * 0.5;
    const d = size * 1.4;
    // Make sure the canvases have the right size BEFORE we compute fov-based
    // framing — otherwise the first render uses a 1:1 aspect from init.
    resizeLmFullscreen();
    // Pane A = FRONT view. Pull the camera back far enough so the entire
    // character fits in the viewport regardless of canvas aspect ratio.
    const canvasA = document.getElementById('lm-fs-canvas');
    const aspectA = canvasA ? (canvasA.clientWidth / Math.max(1, canvasA.clientHeight)) : 1;
    // Fit the TALLER of (model height / aspect) or (model width) in the frustum
    const fovRad = lmFsCamera.fov * Math.PI / 180;
    const fitH = (sizeVec.y * 1.1) / (2 * Math.tan(fovRad / 2));
    const fitW = (Math.max(sizeVec.x, sizeVec.z) * 1.1) / (2 * Math.tan(fovRad / 2) * aspectA);
    const dFront = Math.max(fitH, fitW);
    lmFsCamera.far = Math.max(lmFsCamera.far, size * 100);
    lmFsCamera.updateProjectionMatrix();
    lmFsCamera.position.set(0, lookY, dFront);
    lmFsCamera.lookAt(0, lookY, 0);
    lmFsControls.target.set(0, lookY, 0);
    lmFsControls.update();
    // Snapshot + active NOW (after update settled). Wait one tick to avoid
    // the 'change' event fired by this update() from clearing the flag via
    // _checkLmFsPresetDrift before we've snapshotted.
    setTimeout(() => {
      _snapshotLmFsPreset('a');
      _setLmFsActiveViewBtn('a', 'front');
    }, 100);
    // Pane B = SIDE (right) view — same fit math
    if (lmFsCameraB && lmFsControlsB) {
      const canvasB = document.getElementById('lm-fs-canvas-b');
      const aspectB = canvasB ? (canvasB.clientWidth / Math.max(1, canvasB.clientHeight)) : 1;
      const fitH2 = (sizeVec.y * 1.1) / (2 * Math.tan(fovRad / 2));
      const fitW2 = (Math.max(sizeVec.x, sizeVec.z) * 1.1) / (2 * Math.tan(fovRad / 2) * aspectB);
      const dSide = Math.max(fitH2, fitW2);
      lmFsCameraB.far = Math.max(lmFsCameraB.far, size * 100);
      lmFsCameraB.updateProjectionMatrix();
      lmFsCameraB.position.set(dSide, lookY, 0);
      lmFsCameraB.lookAt(0, lookY, 0);
      lmFsControlsB.target.set(0, lookY, 0);
      lmFsControlsB.update();
      setTimeout(() => {
        _snapshotLmFsPreset('b');
        _setLmFsActiveViewBtn('b', 'right');
      }, 100);
    }
    // Re-add any existing markers to this scene
    for (const id in lmMarkers) {
      lmFsScene.add(lmMarkers[id]);
    }
    refreshLmFsSilhouetteDots();
    // Refresh the info overlay with mesh-derived stats
    const lmInfoEl2 = document.getElementById('lm-fs-info');
    if (lmInfoEl2) {
      const tris = countTrianglesInModel(lmFsModel);
      const extras = [{ label: 'Triangles', value: formatTriCount(tris) }];
      let bones = 0;
      lmFsModel.traverse((c) => { if (c.isBone) bones++; });
      if (bones > 0) extras.push({ label: 'Bones', value: bones });
      renderViewerInfo(lmInfoEl2, sourcePath, extras);
    }
  }
  try {
    if (ext === 'fbx') {
      const url = 'file:///' + sourcePath.replace(/\\/g, '/');
      new FBXLoader().load(url, fitFs, undefined, (err) => console.error('FBX load failed', err));
    } else {
      const buffer = await API.readMeshFile(sourcePath);
      if (!buffer) return;
      new GLTFLoader().parse(buffer, '', (gltf) => fitFs(gltf.scene));
    }
  } catch (e) { console.error('openLandmarksFullscreen', e); }
  // Build the side list of landmark buttons
  buildLmFsList();
}

function buildLmFsList() {
  const list = document.getElementById('lm-fs-list');
  if (!list) return;
  list.innerHTML = '';
  LM_SCHEMA.forEach(group => {
    const cat = document.createElement('div');
    cat.className = 'lm-cat';
    cat.style.gridColumn = '1 / -1';
    cat.textContent = group.cat;
    list.appendChild(cat);
    group.items.forEach(item => {
      const btn = document.createElement('button');
      btn.className = 'lm-btn';
      btn.dataset.lm = item.id;
      btn.dataset.color = item.color;
      if (lmMarkers[item.id]) btn.classList.add('placed');
      btn.innerHTML = `<span class="lm-color" style="background:${item.color}"></span><span>${item.label}</span>`;
      btn.addEventListener('click', () => armLandmark(item.id, btn));
      btn.addEventListener('mouseenter', () => setLandmarkHover(item.id));
      btn.addEventListener('mouseleave', () => setLandmarkHover(null));
      list.appendChild(btn);
    });
  });
}

// SVG body proportions: front view (X centered around 50, Y from head ~22 to feet ~178)
// Returns {x, y} on a 100x200 SVG canvas, for either 'front' or 'side'.
// Tweaked so paired L/R landmarks in the side profile are slightly offset
// (the silhouette only shows one leg/arm but we draw two dots so the user
// sees both indicators).
const LM_SVG_POSITIONS = {
  front: {
    head:       { x: 50, y: 38 },
    neck:       { x: 50, y: 55 },
    spine_top:  { x: 50, y: 70 },
    spine_mid:  { x: 50, y: 88 },
    hips:       { x: 50, y: 108 },
    shoulder_l: { x: 35, y: 60 },
    elbow_l:    { x: 22, y: 88 },
    hand_l:     { x: 19, y: 112 },
    shoulder_r: { x: 65, y: 60 },
    elbow_r:    { x: 78, y: 88 },
    hand_r:     { x: 81, y: 112 },
    hip_l:      { x: 43, y: 112 },
    knee_l:     { x: 43, y: 140 },
    ankle_l:    { x: 43, y: 165 },
    foot_l:     { x: 43, y: 176 },
    hip_r:      { x: 57, y: 112 },
    knee_r:     { x: 57, y: 140 },
    ankle_r:    { x: 57, y: 165 },
    foot_r:     { x: 57, y: 176 },
  },
  // Side view (right profile, character facing +X). Front of body is at
  // higher x, back at lower x. Paired L/R dots are offset by 2 px so they
  // don't overlap exactly.
  side: {
    head:       { x: 52, y: 38 },
    neck:       { x: 50, y: 55 },
    spine_top:  { x: 50, y: 70 },
    spine_mid:  { x: 50, y: 88 },
    hips:       { x: 50, y: 108 },
    shoulder_l: { x: 49, y: 60 },
    elbow_l:    { x: 47, y: 88 },
    hand_l:     { x: 49, y: 112 },
    shoulder_r: { x: 51, y: 60 },
    elbow_r:    { x: 49, y: 88 },
    hand_r:     { x: 51, y: 112 },
    hip_l:      { x: 49, y: 112 },
    knee_l:     { x: 49, y: 140 },
    ankle_l:    { x: 49, y: 165 },
    foot_l:     { x: 58, y: 176 },
    hip_r:      { x: 51, y: 112 },
    knee_r:     { x: 51, y: 140 },
    ankle_r:    { x: 51, y: 165 },
    foot_r:     { x: 60, y: 176 },
  },
};

function refreshLmFsSilhouetteDots() {
  const colorMap = {};
  LM_SCHEMA.forEach(grp => grp.items.forEach(it => { colorMap[it.id] = it.color; }));
  ['front', 'side'].forEach(view => {
    const g = document.getElementById('lm-fs-svg-' + view + '-dots');
    if (!g) return;
    g.innerHTML = '';
    // 1) draw the placed-landmark dots (small solid circles)
    for (const id in lmMarkers) {
      const pos = LM_SVG_POSITIONS[view][id];
      if (!pos) continue;
      const hovered = (typeof _lmHoverId !== 'undefined' && _lmHoverId === id);
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', pos.x);
      c.setAttribute('cy', pos.y);
      c.setAttribute('r', hovered ? 5 : 3);
      c.setAttribute('class', hovered ? 'dot hovered' : 'dot');
      c.setAttribute('data-lm', id);
      c.setAttribute('fill', colorMap[id] || '#ffffff');
      c.setAttribute('stroke', '#fff');
      c.setAttribute('stroke-width', hovered ? 1 : 0.5);
      c.style.color = colorMap[id] || '#ffffff';
      g.appendChild(c);
    }
    // 2) Highlight the currently-armed landmark (including during Guided)
    //    with a pulsing outer ring — this tells the user where to click on
    //    the 3D mesh on the left before the marker is actually placed.
    if (lmActive && !lmMarkers[lmActive]) {
      const pos = LM_SVG_POSITIONS[view][lmActive];
      if (pos) {
        const color = colorMap[lmActive] || '#ffffff';
        // Outer pulsing halo
        const halo = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        halo.setAttribute('cx', pos.x);
        halo.setAttribute('cy', pos.y);
        halo.setAttribute('r', 7);
        halo.setAttribute('class', 'lm-hint-halo');
        halo.setAttribute('fill', 'none');
        halo.setAttribute('stroke', color);
        halo.setAttribute('stroke-width', '1.5');
        g.appendChild(halo);
        // Inner solid dot
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', pos.x);
        dot.setAttribute('cy', pos.y);
        dot.setAttribute('r', 3.5);
        dot.setAttribute('class', 'lm-hint-dot');
        dot.setAttribute('fill', color);
        dot.setAttribute('stroke', '#fff');
        dot.setAttribute('stroke-width', '0.8');
        g.appendChild(dot);
      }
    }
  });
}

function closeLandmarksFullscreen() {
  document.getElementById('lm-fullscreen').classList.add('hidden');
  const lmInfoEl = document.getElementById('lm-fs-info');
  if (lmInfoEl) lmInfoEl.innerHTML = '';
  // Move markers back into the active scene (rig viewer or step 2)
  const ctx = getActiveLandmarkModel();
  if (ctx && ctx.scene) {
    for (const id in lmMarkers) {
      if (lmFsScene) lmFsScene.remove(lmMarkers[id]);
      ctx.scene.add(lmMarkers[id]);
    }
  }
}
document.getElementById('ws-lm-manual')?.addEventListener('click', openLandmarksFullscreen);
document.getElementById('lm-fs-close')?.addEventListener('click', closeLandmarksFullscreen);
document.getElementById('lm-fs-auto')?.addEventListener('click', () => {
  autoDetectLandmarks();
  refreshLmFsSilhouetteDots();
});
document.getElementById('lm-fs-clear')?.addEventListener('click', async () => {
  if (!await customConfirm('Clear all landmarks?', 'Clear', 'Clear')) return;
  clearAllLandmarks();
  refreshLmFsSilhouetteDots();
});
document.getElementById('lm-fs-undo')?.addEventListener('click', () => lmUndo());
document.getElementById('lm-fs-redo')?.addEventListener('click', () => lmRedo());
// Re-generate rig with the currently-placed landmarks. Closes the modal,
// then programmatically clicks the workspace Generate Rig button — which
// already collects lmMarkers and sends them to the auto-rig bridge.
document.getElementById('lm-fs-regen-rig')?.addEventListener('click', () => {
  closeLandmarksFullscreen();
  setTimeout(() => {
    document.getElementById('ws-generate-rig')?.click();
  }, 80);
});

// View-orientation toolbars for the landmarks fullscreen (front/back/left/...).
// Each sub-pane (A and B) has its own toolbar inside `.lm-fs-subviewer`; the
// toolbar's `data-pane` attribute selects which camera to move.
// Helper: mark the active button within a toolbar (so the user sees which
// preset view the camera is currently pointing at). Null clears it.
function _setLmFsActiveViewBtn(pane, view) {
  const toolbar = document.querySelector(`.lm-fs-view-toolbar[data-pane="${pane}"]`);
  if (!toolbar) return;
  toolbar.querySelectorAll('button[data-view]').forEach(b => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  // Update the pane label to reflect the current preset (uppercase)
  const label = document.getElementById('lm-fs-pane-label-' + pane);
  if (label) {
    label.textContent = view ? view.toUpperCase() : '';
  }
}
// Snapshot of the camera angles at the moment a preset view was applied,
// per pane. Used to detect when the user has manually orbited away from the
// preset and clear the active highlight accordingly.
const _lmFsPresetSnapshot = { a: null, b: null };
function _snapshotLmFsPreset(pane) {
  const ctrl = pane === 'b' ? lmFsControlsB : lmFsControls;
  if (!ctrl) return;
  _lmFsPresetSnapshot[pane] = {
    az: ctrl.getAzimuthalAngle(),
    po: ctrl.getPolarAngle(),
    dist: ctrl.getDistance(),
  };
}
function _checkLmFsPresetDrift(pane) {
  const snap = _lmFsPresetSnapshot[pane];
  if (!snap) return; // no preset tracked → nothing to clear
  const ctrl = pane === 'b' ? lmFsControlsB : lmFsControls;
  if (!ctrl) return;
  const az = ctrl.getAzimuthalAngle();
  const po = ctrl.getPolarAngle();
  const dist = ctrl.getDistance();
  // Epsilon: ~0.5° for angles, 1% for distance (tolerates damping jitter)
  const EPS = 0.009;
  if (Math.abs(az - snap.az) > EPS || Math.abs(po - snap.po) > EPS || Math.abs(dist - snap.dist) / Math.max(1, snap.dist) > 0.01) {
    _setLmFsActiveViewBtn(pane, null);
    _lmFsPresetSnapshot[pane] = null; // stop checking until next preset applied
  }
}
document.getElementById('lm-fullscreen')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.lm-fs-view-toolbar button[data-view]');
  if (!btn || !lmFsModel) return;
  const toolbar = btn.closest('.lm-fs-view-toolbar');
  const pane = toolbar?.dataset.pane || 'a';
  const cam = pane === 'b' ? lmFsCameraB : lmFsCamera;
  const ctrl = pane === 'b' ? lmFsControlsB : lmFsControls;
  if (!cam || !ctrl) return;
  const view = btn.dataset.view;
  const box = new THREE.Box3().setFromObject(lmFsModel);
  const sizeVec = box.getSize(new THREE.Vector3());
  const size = sizeVec.length();
  // Model is recentered on X/Z with its bottom on y=0 in the lmFs scene
  // (see openLandmarksFullscreen fitFs). Look at mid-height.
  const cx = 0, cz = 0;
  const cy = sizeVec.y * 0.5;
  const d = size * 1.4;
  const positions = {
    front:  [cx, cy, cz + d],
    back:   [cx, cy, cz - d],
    left:   [cx - d, cy, cz],
    right:  [cx + d, cy, cz],
    top:    [cx, cy + d, cz + 0.001],
    bottom: [cx, cy - d, cz + 0.001],
    iso:    [cx + d * 0.7, cy + d * 0.5, cz + d * 0.7],
  };
  const p = positions[view];
  if (!p) return;
  cam.position.set(p[0], p[1], p[2]);
  cam.lookAt(cx, cy, cz);
  ctrl.target.set(cx, cy, cz);
  ctrl.update();
  // Snapshot the camera angles now so _checkLmFsPresetDrift can detect when
  // the user rotates away from this preset and clear the highlight.
  _setLmFsActiveViewBtn(pane, view);
  _snapshotLmFsPreset(pane);
});

window.addEventListener('resize', () => {
  if (!document.getElementById('lm-fullscreen').classList.contains('hidden')) resizeLmFullscreen();
});

// Shared Guided-landmark-placement flow. Walks the schema in order,
// arming each landmark in turn, and waits for the user to click on the
// mesh to place it. `prefix` selects which side panel's buttons to target
// — '' for the workspace step 3 (ws-*), 'lm-fs-' for the fullscreen modal.
// Always clears existing markers first so re-clicking Guided restarts the
// flow from scratch (otherwise previously placed points would be skipped
// and the button would appear to do nothing).
async function runGuidedLandmarkPlacement(prefix) {
  const ctx = getActiveLandmarkModel();
  if (!ctx) { customError('Load a mesh first (use the "Use this mesh for Rig" button in the 3D Mesh card).', 'Guided placement'); return; }
  // Restart from zero — wipe all existing markers so we actually walk the
  // whole schema again instead of silently skipping them all.
  clearAllLandmarks();
  const btnSelector = (id) => prefix
    ? `#${prefix}list .lm-btn[data-lm="${id}"]`
    : `.lm-btn[data-lm="${id}"]`;
  const all = LM_SCHEMA.flatMap(g => g.items);
  for (const item of all) {
    if (lmMarkers[item.id]) continue; // shouldn't happen after clearAll, kept defensive
    const btn = document.querySelector(btnSelector(item.id)) || document.querySelector(`.lm-btn[data-lm="${item.id}"]`);
    if (!btn) continue;
    armLandmark(item.id, btn);
    btn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    const placed = await new Promise(resolve => {
      const start = Date.now();
      const check = setInterval(() => {
        if (lmMarkers[item.id]) { clearInterval(check); resolve(true); }
        else if (Date.now() - start > 60000) { clearInterval(check); resolve(false); }
        else if (lmActive !== item.id) { clearInterval(check); resolve(false); } // user disarmed
      }, 200);
    });
    if (!placed) break;
  }
}
document.getElementById('ws-lm-guided')?.addEventListener('click', () => runGuidedLandmarkPlacement(''));
document.getElementById('lm-fs-guided')?.addEventListener('click', () => runGuidedLandmarkPlacement('lm-fs-'));

// Reload landmarks whenever the previewed mesh changes — observe the canvas
// for size changes (when the model is loaded, three.js fits the camera).
// Simpler: set up a periodic check that loads landmarks when either viewer
// model reference changes.
let _lastWsModelRef = null;
let _lastRigSrcModelRef = null;
setInterval(() => {
  if (wsModel !== _lastWsModelRef) {
    _lastWsModelRef = wsModel;
    if (wsModel) loadLandmarksForCurrentMesh();
  }
  if (rigSrcModel !== _lastRigSrcModelRef) {
    _lastRigSrcModelRef = rigSrcModel;
    if (rigSrcModel) loadLandmarksForCurrentMesh();
  }
}, 500);

// ============================================================
// CLOSE CONFIRMATION (when jobs are running)
// ============================================================
if (API.onAppCloseRequested) {
  API.onAppCloseRequested(async () => {
    const runningCount = state.jobs.filter(j => j.status === 'running').length;
    if (runningCount === 0) {
      // No job running, just confirm immediately
      API.confirmAppClose();
      return;
    }
    const ok = await customConfirm(
      `${runningCount} task${runningCount > 1 ? 's are' : ' is'} running. They will be cancelled if you quit now. Continue?`,
      'Quit FabMesh',
      'Quit and cancel'
    );
    if (ok) {
      // Cancel all running jobs first (so the user sees them stop), then quit
      try {
        for (const j of state.jobs.filter(j => j.status === 'running')) {
          if (API.cancelJob) await API.cancelJob(j.id);
        }
      } catch (e) {}
      API.confirmAppClose();
    }
    // If "ok === false", we do nothing — the close is cancelled because
    // main.js called event.preventDefault() and we never sent the confirm IPC.
  });
}

// ============================================================
// INIT
// ============================================================
showPage('projects');
