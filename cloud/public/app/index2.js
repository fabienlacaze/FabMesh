// ============================================================
// MyFabmesh.AI — Renderer 2 (refonte)
// ============================================================
// Architecture:
//   - Page "projects": grid of project cards
//   - Page "workspace": one project, 3 vertical step cards
//   - All IPC calls go through window.meshyAPI
// ============================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SimplifyModifier } from 'three/addons/modifiers/SimplifyModifier.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { Viewer3D } from './lib/Viewer3D.js';

const API = window.meshyAPI;

// MyFabmesh.AI-styled confirm dialog (replaces the OS-native window.confirm
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

// Navigate to a project by name, optionally selecting a specific
// asset URL inside it (image/mesh/rig/anim). Used by the history
// detail modal so the user can jump from an event back to the
// project + asset that produced it.
window.openProjectByName = async function (projectName, focusAssetUrl) {
  try {
    await refreshProjectsPage();
    const target = state.projects.find(p => p.name === projectName)
                || state.projects.find(p => (p.name || '').toLowerCase() === (projectName || '').toLowerCase())
                || state.projects.find(p => p.name?.replace(/[^a-zA-Z0-9_-]/g, '_') === (projectName || ''));
    if (!target) {
      if (typeof showToast === 'function') showToast(`Project "${projectName}" not found`, 'warn', 4000);
      return;
    }
    // Close any open dialogs first.
    const hist = document.getElementById('history-modal');
    const histDetail = document.getElementById('history-detail');
    if (histDetail) histDetail.style.display = 'none';
    if (hist) hist.style.display = 'none';
    await openProject(target);
    // Try to select the focused asset (best-effort).
    if (focusAssetUrl) {
      const isImg = /\.(png|jpg|jpeg|webp)(\?|$)/i.test(focusAssetUrl);
      const isMesh = /\.(glb|gltf|fbx|obj)(\?|$)/i.test(focusAssetUrl);
      if (isImg) {
        const match = (target.images || []).find(im => (typeof im === 'string' ? im : im?.path) === focusAssetUrl);
        if (match) {
          target.selectedImagePath = (typeof match === 'string') ? match : match.path;
          target.previewImagePath = target.selectedImagePath;
          try { renderImageVersions(target); } catch (_) {}
        }
      } else if (isMesh) {
        const match = (target.meshes || []).find(m => m.url === focusAssetUrl || m.path === focusAssetUrl);
        if (match) {
          target.previewMeshPath = match.path;
          target.selectedMeshPath = match.path;
          try { renderMeshVersions(target); } catch (_) {}
        }
      }
    }
  } catch (e) { console.warn('[openProjectByName] failed:', e); }
};
} catch (_) {}

// ────────────────────────────────────────────────────────────────
// uploadClientMeshResult — single source of truth for the three
// client-side mesh edit tools (Mesh Tools, Paint Emissive, Paint
// Mesh) that produce a GLB locally and post it to the Worker for
// free R2 storage.
//
// Server allowlist (cloud/src/worker.ts CLIENT_OPS):
//   smooth, decimate, subdivide, fix_normals, fill_holes, center
// Anything else returns 400. Paint Emissive / Paint Mesh aren't
// real mesh ops on the server — they piggy-back on 'center' purely
// to get the GLB stored, hence the `opType` parameter the caller
// supplies (no hardcoded value here).
// ────────────────────────────────────────────────────────────────
async function uploadClientMeshResult(bytes, opType, extra = {}) {
  // Chunked base64 encode — avoids the "Maximum call stack" trap
  // String.fromCharCode.apply hits on multi-MB buffers.
  let bin = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  const b64 = btoa(bin);
  const r = await fetch('/api/mesh-op/client-result', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ opType, glbBase64: b64, ...extra }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data?.success) {
    throw new Error(data?.error || `HTTP ${r.status}`);
  }
  return data;
}

// ────────────────────────────────────────────────────────────────
// Inbox → project deep-link helper
// ────────────────────────────────────────────────────────────────
// Called from cloud-overrides.js openInboxPopup when the user clicks a
// market_approved / market_rejected / market_sale notification that
// carries the originating job_id. We:
//   1. close the inbox overlay (if still in the DOM)
//   2. scan state.projects for an image / mesh / rig whose id matches
//   3. open that project and flash the matching version-thumb
//   4. fall back to a toast if the project isn't loaded yet
(function installInboxAssetNav() {
  // One-shot CSS injection for the flash animation.
  if (!document.getElementById('inbox-flash-style')) {
    const st = document.createElement('style');
    st.id = 'inbox-flash-style';
    st.textContent = `
      .inbox-flash {
        outline: 2px solid #ffc107 !important;
        box-shadow: 0 0 0 4px rgba(255, 193, 7, 0.4) !important;
        transition: outline 200ms ease, box-shadow 200ms ease;
      }
    `;
    document.head.appendChild(st);
  }

  function _matchesJobId(item, jobId) {
    if (!item) return false;
    const s = String(jobId);
    return String(item.jobId || '') === s
        || String(item.job_id || '') === s
        || String(item.id || '') === s;
  }

  function _findProjectByJobId(jobId) {
    const projects = (window.state && Array.isArray(window.state.projects))
      ? window.state.projects : [];
    for (const p of projects) {
      const buckets = [p.images, p.meshes, p.rigs];
      for (const arr of buckets) {
        if (!Array.isArray(arr)) continue;
        for (const it of arr) {
          if (_matchesJobId(it, jobId)) return p;
        }
      }
    }
    return null;
  }

  window.__navigateToInboxAsset = function __navigateToInboxAsset(jobId, _kind) {
    // 1) Close any lingering inbox overlay (cloud-overrides removes it on
    // click too, but this is defensive in case the helper is invoked from
    // elsewhere later).
    try {
      document.querySelectorAll('.cloud-inbox-overlay').forEach((n) => n.remove());
    } catch {}

    if (jobId == null || jobId === '') {
      if (typeof window.showToast === 'function') {
        window.showToast('Notification has no asset reference.', 'info', 3000);
      }
      return;
    }

    const proj = _findProjectByJobId(jobId);
    if (!proj) {
      if (typeof window.showToast === 'function') {
        window.showToast('Project not loaded — try refreshing the home page.', 'info', 4000);
      }
      return;
    }

    // 2) Open the project (handles setCurrentProject + showPage + populateWorkspace).
    try { window.openProject(proj); } catch (_) {}

    // 3) After populateWorkspace finishes, scroll & flash the matching thumb.
    setTimeout(() => {
      try {
        const sel = `[data-job-id="${CSS.escape(String(jobId))}"]`;
        const el = document.querySelector(sel);
        if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('inbox-flash');
        setTimeout(() => { try { el.classList.remove('inbox-flash'); } catch {} }, 1000);
      } catch (_) {}
    }, 100);
  };
})();

// ============================================================
// CUSTOM CONFIRM MODAL (replaces window.confirm)
// ============================================================
// Map engine value (from <select>) to a human-readable label showing the
// real underlying model. Legacy IDs (sf3d, local) are rerouted by
// main.js to trellis2_native — labels kept for backward display on old
// saved projects but the wording reflects the actual fallback.
const ENGINE_LABELS = {
  // Image engines
  'local-flux':     'Balanced (quality/speed)',
  'local-lightning':'Fast (Turbo ⚡ · ~4 steps)',
  // 3D engines — sf3d / local legacy IDs are silently rerouted to
  // the native engine at dispatch.
  'sf3d':           'MyFabmesh.AI 3D Native (rerouted)',
  'local':          'MyFabmesh.AI 3D Native (rerouted)',
  'trellis2_native':'MyFabmesh.AI 3D Native',
  'trellis':        'MyFabmesh.AI 3D Engine',
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
  modal.style.zIndex = '10200';  // above #modal-job-details (10000) so a confirm opened FROM it is reachable
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
  modal.style.zIndex = '10200';  // above #modal-job-details (10000) so a confirm opened FROM it is reachable
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

// Route an error message to a plain customError. Extracts the most useful
// error line from large Python tracebacks before falling back to the raw text.
function reportPipelineError(errMsg, title) {
  const raw = String(errMsg || '').trim();
  // Content-filter block → offer a direct Unlock shortcut to the parental-
  // control disable flow (legal warning + PIN), then re-run the blocked op.
  if (/content filter|parental control|unrestricted mode/i.test(raw)) {
    customErrorWithAction(raw, title || 'Blocked by content filter', '🔓 Unlock')
      .then((unlock) => { if (unlock) setTimeout(() => { _unlockThenRetry(); }, 60); });
    return;
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
// expose for cloud-overrides.js (classic script, no module scope)
window.showToast = showToast;

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
    modal.style.zIndex = '10200';  // above #modal-job-details (10000) so a confirm opened FROM it is reachable
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
        animations: [],
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
    // f.created is an ISO string ("2026-05-26T00:42:37.000Z") in cloud
    // (and a number ms on desktop) — coerce both to ms so the sort at
    // line 477 actually orders newest-first. Without `new Date(...)`,
    // `"2026..." > 0` evaluates NaN > 0 = false → every imageless-mesh
    // project stays at latestTimestamp = 0 → indeterministic order.
    if (f.created) {
      const ts = typeof f.created === 'number'
        ? f.created
        : new Date(f.created).getTime();
      if (!isNaN(ts) && ts > p.latestTimestamp) p.latestTimestamp = ts;
    }
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
    // Remove trailing engine suffix added by main.js: _sf3d / _hunyuan / _local / _trellis / _trellis2 / _triposg / _ai / _trellis2_native
    // Optionally followed by arbitrary short tags like _apilive, _test, _v2,
    // each possibly followed by its own timestamp. This handles ad-hoc CLI
    // names like test_e2e_sf3d_apilive_1776274212 that would otherwise form
    // their own phantom projects.
    base = base.replace(
      /_(sf3d|hunyuan|local|trellis2_native|trellis2|trellis|triposg|hi3dgen|ai)(?:_[A-Za-z0-9]{1,16})*$/i,
      ''
    );
    // Remove a trailing _<number> if any (legacy index naming)
    base = base.replace(/_\d+$/, '');
    // Patterns that indicate this mesh has no real project — route to
    // _orphans instead of creating a phantom project named after the
    // raw filename:
    //   - raw hash/uuid (modal_<hex32>, bare hex32)
    //   - 'untitled' (worker fallback when jobs.project_name is NULL)
    //   - timestamp-prefixed (mesh-op outputs like 1780268987313_material_adjust)
    //   - bare 'rigged_puppeteer' (worker fallback when no source mesh found)
    //   - generic '_anim_<x>' or just 'anim'
    if (/^(modal_)?[a-f0-9-]{8,}$/i.test(base)) return '_orphans';
    if (base === 'untitled')                    return '_orphans';
    if (/^\d{13}_/.test(base))                  return '_orphans';
    // 'rigged_puppeteer' anywhere → orphan (anim filenames keep this
    // prefix because the source mesh was already named rigged_puppeteer_*).
    if (/^rigged(_puppeteer)?(_|$)/i.test(base)) return '_orphans';
    if (/^anim(_|$)/i.test(base))                return '_orphans';
    return base || '_orphans';
  }
  for (const m of meshes) {
    // Cloud API attaches the original `projectName` directly on each mesh
    // (see worker.ts:handleListMeshes). The desktop fallback `meshProject`
    // derives the name from the filename, which the Worker has to sanitize
    // (spaces → underscores) so the desktop's same regex parser still works.
    // Without this preference, "medieval soldier" (image folder) and
    // "medieval_soldier" (derived from sanitized mesh filename) split into
    // two phantom projects in the UI.
    const project = (m.projectName && String(m.projectName).trim())
                 || meshProject(m.filename);
    const p = ensure(project);
    if (m.asset_type === 'animation' || /_anim_|_animation_/i.test(m.filename)) {
      // Worker now returns anim_type + batch_id parsed from the
      // filename. Fall back to local parsing for legacy entries.
      let animType = (m.anim_type || '').toLowerCase();
      let batchId = m.batch_id || '';
      if (!animType) {
        const m1 = m.filename.match(/_(idle|walk|run|attack|death|fly|jump|custom|clip)_(?:[A-Za-z0-9_-]{4,32}_)?\d{10,}\.glb$/i);
        animType = (m1 ? m1[1] : 'clip').toLowerCase();
      }
      p.animations = p.animations || [];
      p.animations.push({ ...m, type: animType, batchId });
    } else if (/_rigged_/i.test(m.filename)) {
      p.rigs.push(m);
    } else {
      p.meshes.push(m);
    }
    // Use mesh's source image as project thumb if no image folder
    if (!p.thumb && m.sourceImage) p.thumb = m.sourceImage;
    if (m.created) {
      const ts = new Date(m.created).getTime();
      if (ts > p.latestTimestamp) p.latestTimestamp = ts;
    }
  }

  // Dedupe per-project lists by their URL/path/filename so the same R2
  // file never appears twice in a strip. Worker now dedupes too but
  // the client adds a belt-and-braces pass — defends against legacy
  // callers and against the merge with state pushes from autoRigAI.
  function _dedupeBy(arr, keyFn) {
    const seen = new Set();
    const out = [];
    for (const x of (arr || [])) {
      const k = keyFn(x);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(x);
    }
    return out;
  }
  for (const p of projectsMap.values()) {
    p.meshes = _dedupeBy(p.meshes, m => (m.url || m.path || m.filename || '').toLowerCase());
    p.rigs   = _dedupeBy(p.rigs,   r => (r.url || r.path || r.filename || '').toLowerCase());
    p.animations = _dedupeBy(p.animations, a => (a.url || a.path || a.filename || '').toLowerCase());
    p.images = _dedupeBy(p.images, im => (typeof im === 'string' ? im : im?.path || '').toLowerCase());
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
// Purge any localStorage-persisted NSFW cache that may have been
// poisoned by the pre-fix bug that flagged 'ok' / 'results' as
// project filenames. Safe to remove — the next scan re-populates.
try {
  if (typeof localStorage !== 'undefined') {
    const k = localStorage.getItem('fabmesh_nsfw_cache');
    if (k) {
      const parsed = JSON.parse(k);
      if (parsed && (parsed.ok || parsed.results)) {
        localStorage.removeItem('fabmesh_nsfw_cache');
        console.log('[NSFW] purged poisoned cache (had ok/results keys)');
      }
    }
  }
} catch (_) {}
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
    const resp = await API.batchCheckNsfw({ images: toScan });
    console.log('[NSFW] scan results:', resp);
    // The cloud stub returns { ok: true, results: [] }. The old code
    // iterated Object.entries(resp) and read 'ok' / 'results' as paths,
    // flagging 2 random projects as NSFW because both wrapper values
    // happened to be truthy ('true' for ok, '[]' for results — arrays
    // are truthy in JS). Handle the SHAPE properly: results is an
    // array of either path strings or {path/url, nsfw} objects.
    if (resp && typeof resp === 'object') {
      // Accept both wrapped { results: [...] } and bare arrays.
      const items = Array.isArray(resp) ? resp
                  : Array.isArray(resp.results) ? resp.results
                  : [];
      let changed = false;
      for (const item of items) {
        let imgPath, nsfw;
        if (typeof item === 'string') { imgPath = item; nsfw = true; }
        else if (item && typeof item === 'object') {
          imgPath = item.path || item.url || item.image || '';
          nsfw = !!(item.nsfw || item.blocked || item.unsafe);
        } else continue;
        if (!imgPath) continue;
        const fname = imgPath.split(/[/\\]/).pop();
        _nsfwScanCache[fname] = nsfw;
        if (nsfw) { changed = true; console.log('[NSFW] BLOCKED:', fname, imgPath); }
      }
      if (changed) {
        console.log('[NSFW] re-rendering grid to hide',
          Object.values(_nsfwScanCache).filter(v => v).length, 'NSFW projects');
        renderProjectsGrid();
      }
    }
  } catch (_) {}
  _nsfwScanRunning = false;
}

/* ----------------------------------------------------------------------
 * Home view toggle — Projects / Images / Meshes. Same project data,
 * three views: cards (default), flat image grid, flat mesh grid.
 * --------------------------------------------------------------------- */
function _updateHomeViewCounts() {
  let imgN = 0, meshN = 0, rigN = 0, animN = 0;
  for (const p of state.projects || []) {
    imgN += (p.images || []).length;
    meshN += (p.meshes || []).length;
    rigN += (p.rigs || []).length;
    animN += (p.animations || []).length;
  }
  const projN = (state.projects || []).length;
  const set = (k, n) => {
    const el = document.querySelector(`.home-view-count[data-count="${k}"]`);
    if (el) el.textContent = `(${n})`;
  };
  set('projects', projN);
  set('images', imgN);
  set('meshes', meshN);
  set('rigs', rigN);
  set('anims', animN);
}

let _homeView = 'projects';
function _setHomeView(view) {
  _homeView = view;
  document.querySelectorAll('.home-view-btn').forEach((b) => {
    const active = b.dataset.view === view;
    b.classList.toggle('active', active);
    b.style.background = active ? 'var(--accent-grad)' : 'transparent';
    b.style.color = active ? 'white' : 'var(--text-1)';
  });
  const pg = document.getElementById('projects-grid');
  const ig = document.getElementById('all-images-grid');
  const mg = document.getElementById('all-meshes-grid');
  const rg = document.getElementById('all-rigs-grid');
  if (pg) pg.classList.toggle('hidden', view !== 'projects');
  if (ig) ig.classList.toggle('hidden', view !== 'images');
  if (mg) mg.classList.toggle('hidden', view !== 'meshes');
  if (rg) rg.classList.toggle('hidden', view !== 'rigs');
  if (view === 'images') renderAllImagesGrid();
  else if (view === 'meshes') renderAllMeshesGrid();
  else if (view === 'rigs') renderAllRigsGrid();
}
document.addEventListener('click', (e) => {
  const btn = e.target?.closest?.('.home-view-btn');
  if (btn && btn.dataset.view) _setHomeView(btn.dataset.view);
});

function _imgSrc(path) {
  if (!path) return '';
  if (/^(?:https?|blob|data):/i.test(path)) {
    return /^https?:/i.test(path) ? '/api/proxy-image?url=' + encodeURIComponent(path) : path;
  }
  return _toFileUrl(path);
}

// Universal path-to-URL helper. Desktop bundle gets bare filesystem paths
// ('C:\Users\...\img.png') and needs the file:/// prefix. Cloud bundle
// gets HTTPS URLs already and just needs them returned as-is — without
// this guard the prefix concatenates as 'file:///https://...' which the
// browser refuses with "Not allowed to load local resource". Used by
// every viewer / lightbox / preview that loads a path-or-URL.
function _toFileUrl(path) {
  if (!path) return '';
  const s = String(path);
  if (/^(?:https?|blob|data|file):/i.test(s)) return s;
  return 'file:///' + s.replace(/\\/g, '/');
}
window._toFileUrl = _toFileUrl;

function renderAllImagesGrid() {
  const grid = document.getElementById('all-images-grid');
  if (!grid) return;
  const items = [];
  for (const p of state.projects || []) {
    for (const img of (p.images || [])) {
      items.push({ project: p, path: img.path || img });
    }
  }
  // Most-recent project first. Within a project the strip order wins.
  if (!items.length) {
    grid.innerHTML = '<div style="grid-column:1/-1; color:var(--text-2); text-align:center; padding:40px;">No images yet.</div>';
    return;
  }
  grid.innerHTML = items.map((it) => `
    <div class="project-card" style="cursor:pointer;" data-project="${escapeHtml(it.project.name)}">
      <div class="project-card-thumb">
        <img src="${escapeHtml(_imgSrc(it.path))}" alt="" loading="lazy">
      </div>
      <div class="project-card-body">
        <div class="project-card-name" style="font-size:13px;">${escapeHtml(it.project.name)}</div>
        <div class="project-card-meta" style="font-size:11px;">${escapeHtml(String(it.path).split(/[\\/]/).pop())}</div>
      </div>
    </div>
  `).join('');
  grid.querySelectorAll('[data-project]').forEach((el) => {
    el.addEventListener('click', () => {
      const name = el.dataset.project;
      const p = (state.projects || []).find((x) => x.name === name);
      if (p) openProject(p);
    });
  });
}

function renderAllMeshesGrid() {
  const grid = document.getElementById('all-meshes-grid');
  if (!grid) return;
  const items = [];
  for (const p of state.projects || []) {
    for (const m of (p.meshes || [])) {
      items.push({ project: p, mesh: m });
    }
  }
  if (!items.length) {
    grid.innerHTML = '<div style="grid-column:1/-1; color:var(--text-2); text-align:center; padding:40px;">No meshes yet.</div>';
    return;
  }
  grid.innerHTML = items.map((it) => {
    const url = it.mesh.url || it.mesh.path || '';
    const fname = String(it.mesh.filename || url).split(/[\\/]/).pop();
    return `
      <div class="project-card" style="cursor:pointer; padding:8px;" data-project="${escapeHtml(it.project.name)}">
        <div style="font-size:13px; font-weight:600; padding:4px 4px 6px;">${escapeHtml(it.project.name)}</div>
        ${/^https?:/i.test(url)
          ? `<model-viewer src="${escapeHtml(url)}" camera-controls touch-action="pan-y" shadow-intensity="1" exposure="1" style="width:100%; height:200px; background:#0a0a0e; border-radius:6px;"></model-viewer>`
          : `<div style="height:200px; background:#0a0a0e; display:flex; align-items:center; justify-content:center; color:var(--text-2); font-size:11px; border-radius:6px;">${escapeHtml(fname || '(no preview)')}</div>`}
        <div class="project-card-meta" style="font-size:11px; padding:6px 4px 0;">${escapeHtml(fname)}</div>
      </div>
    `;
  }).join('');
  grid.querySelectorAll('[data-project]').forEach((el) => {
    el.addEventListener('click', (e) => {
      // model-viewer interactions shouldn't bubble to open the project
      if (e.target.tagName === 'MODEL-VIEWER') return;
      const name = el.dataset.project;
      const p = (state.projects || []).find((x) => x.name === name);
      if (p) openProject(p);
    });
  });
}

// All rigs across every project — same shape as renderAllMeshesGrid but
// pulls from p.rigs and adds a bone-icon badge. Clicking opens the project
// with its rig viewer expanded.
function renderAllRigsGrid() {
  const grid = document.getElementById('all-rigs-grid');
  if (!grid) return;
  const items = [];
  for (const p of state.projects || []) {
    for (const r of (p.rigs || [])) {
      items.push({ project: p, rig: r });
    }
  }
  if (!items.length) {
    grid.innerHTML = '<div style="grid-column:1/-1; color:var(--text-2); text-align:center; padding:40px;">No rigs yet. Open a project, generate a mesh, then click "Generate Rig".</div>';
    return;
  }
  grid.innerHTML = items.map((it) => {
    const url = it.rig.url || it.rig.path || '';
    const fname = String(it.rig.filename || url).split(/[\\/]/).pop();
    return `
      <div class="project-card" style="cursor:pointer; padding:8px;" data-project="${escapeHtml(it.project.name)}">
        <div style="display:flex; align-items:center; gap:6px; padding:4px 4px 6px;">
          <span style="font-size:14px;">🦴</span>
          <span style="font-size:13px; font-weight:600;">${escapeHtml(it.project.name)}</span>
        </div>
        ${/^https?:/i.test(url)
          ? `<model-viewer src="${escapeHtml(url)}" camera-controls touch-action="pan-y" shadow-intensity="1" exposure="1" style="width:100%; height:200px; background:#0a0a0e; border-radius:6px;"></model-viewer>`
          : `<div style="height:200px; background:#0a0a0e; display:flex; align-items:center; justify-content:center; color:var(--text-2); font-size:11px; border-radius:6px;">${escapeHtml(fname || '(no preview)')}</div>`}
        <div class="project-card-meta" style="font-size:11px; padding:6px 4px 0;">${escapeHtml(fname)}</div>
      </div>
    `;
  }).join('');
  grid.querySelectorAll('[data-project]').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.tagName === 'MODEL-VIEWER') return;
      const name = el.dataset.project;
      const p = (state.projects || []).find((x) => x.name === name);
      if (p) openProject(p);
    });
  });
}

let _renderProjectsGen = 0;
async function renderProjectsGrid() {
  // Re-entrancy guard: async fn clears the grid at the top but appends cards +
  // the "New project" tile AFTER two awaits. Two concurrent calls interleave at
  // those awaits → duplicate "Create a new project" tiles. Only the newest
  // render may touch the DOM after an await.
  const myGen = ++_renderProjectsGen;
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
  if (myGen !== _renderProjectsGen) return;   // superseded by a newer render

  let visibleProjects = state.projects;
  if (restricted) {
    const checks = await Promise.all(state.projects.map(p => _isProjectNSFW(p)));
    if (myGen !== _renderProjectsGen) return; // superseded by a newer render
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
  // Multi-select state (persists across re-renders during this page view).
  if (!state._selectedProjects) state._selectedProjects = new Set();
  // Drop selections of projects that are no longer visible.
  const visibleNames = new Set(visibleProjects.map(p => p.name));
  // Expose visible names so the "Select all" header button can pick them up
  // without recomputing the NSFW / search filters.
  state._visibleProjectNames = visibleNames;
  for (const n of [...state._selectedProjects]) {
    if (!visibleNames.has(n)) state._selectedProjects.delete(n);
  }

  for (const p of visibleProjects) {
    const hasImage = p.images.length > 0;
    const hasMesh = p.meshes.length > 0;
    const hasRig = p.rigs.length > 0;
    const hasAnim = (p.animations || []).length > 0;
    const isSelected = state._selectedProjects.has(p.name);
    const card = document.createElement('div');
    card.className = 'project-card' + (isSelected ? ' selected' : '');
    card.innerHTML = `
      <button class="card-select-checkbox" title="Select project">&#10003;</button>
      <button class="card-delete-btn" title="Delete project">&#10005;</button>
      <div class="project-card-thumb">
        ${p.thumb
          ? `<img src="${_toFileUrl(p.thumb)}" alt="${p.name}">`
          : `<span class="project-card-thumb-empty">No image</span>`}
      </div>
      <div class="project-card-body">
        <div class="project-card-name">${escapeHtml(p.name)}</div>
        <div class="project-card-meta">
          ${p.images.length} img · ${p.meshes.length} mesh · ${p.rigs.length} rig · ${(p.animations||[]).length} anim
        </div>
        <div class="project-card-progress">
          <span class="pcp-step ${hasImage ? 'done' : ''}"></span>
          <span class="pcp-step ${hasMesh ? 'done' : ''}"></span>
          <span class="pcp-step ${hasRig ? 'done' : ''}"></span>
          <span class="pcp-step ${hasAnim ? 'done' : ''}"></span>
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
    card.querySelector('.card-select-checkbox').addEventListener('click', (e) => {
      e.stopPropagation();
      if (state._selectedProjects.has(p.name)) state._selectedProjects.delete(p.name);
      else state._selectedProjects.add(p.name);
      renderProjectsBulkBar();
      card.classList.toggle('selected');
    });
    card.addEventListener('click', () => {
      // If any selection is active, clicks act as selection toggles instead
      // of opening the project (lets the user select multiple without
      // accidentally entering one).
      if (state._selectedProjects.size > 0) {
        if (state._selectedProjects.has(p.name)) state._selectedProjects.delete(p.name);
        else state._selectedProjects.add(p.name);
        renderProjectsBulkBar();
        card.classList.toggle('selected');
        return;
      }
      openProject(p);
    });
    grid.appendChild(card);
  }
  renderProjectsBulkBar();
  _syncSelectAllBtn();
  _updateHomeViewCounts();
  // Keep the alternate views in sync with the freshly-loaded project
  // list so flipping back to Images/Meshes doesn't show stale data.
  if (_homeView === 'images') renderAllImagesGrid();
  else if (_homeView === 'meshes') renderAllMeshesGrid();
  else if (_homeView === 'rigs') renderAllRigsGrid();
  // "+ New" card FIRST (top-left of the grid).
  const newCard = document.createElement('div');
  newCard.className = 'project-card new-card';
  newCard.innerHTML = `
    <div class="new-card-content">
      <div class="new-card-plus">+</div>
      <div>Create a new project</div>
    </div>
  `;
  newCard.addEventListener('click', () => openNewProjectModal());
  grid.querySelectorAll('.new-card').forEach(n => n.remove());  // never leave a stale one
  grid.prepend(newCard);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Update the "Select all / Deselect all" header button label + state
// based on whether every visible project is currently selected.
function _syncSelectAllBtn() {
  const btn = document.getElementById('btn-select-all');
  if (!btn) return;
  const visible = state._visibleProjectNames || new Set();
  const selected = state._selectedProjects || new Set();
  if (visible.size === 0) {
    btn.style.display = 'none';
    return;
  }
  btn.style.display = '';
  const allSelected = visible.size > 0
    && [...visible].every(n => selected.has(n));
  btn.innerHTML = allSelected ? '&#9745; Deselect all' : '&#9744; Select all';
  btn.title = allSelected
    ? 'Deselect all visible projects'
    : 'Select all visible projects';
}

// Wire the header "Select all / Deselect all" toggle. Acts on visible
// projects only (respects the search + NSFW filters).
document.getElementById('btn-select-all')?.addEventListener('click', () => {
  if (!state._selectedProjects) state._selectedProjects = new Set();
  const visible = state._visibleProjectNames || new Set();
  if (visible.size === 0) return;
  const allSelected = [...visible].every(n => state._selectedProjects.has(n));
  if (allSelected) {
    for (const n of visible) state._selectedProjects.delete(n);
  } else {
    for (const n of visible) state._selectedProjects.add(n);
  }
  renderProjectsGrid();
});

function renderProjectsBulkBar() {
  _syncSelectAllBtn();
  let bar = document.getElementById('projects-bulk-bar');
  const selected = state._selectedProjects || new Set();
  const count = selected.size;
  if (count === 0) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'projects-bulk-bar';
    bar.className = 'projects-bulk-bar';
    document.body.appendChild(bar);
  }
  bar.innerHTML = `
    <span class="projects-bulk-bar-count">${count} project${count > 1 ? 's' : ''} selected</span>
    <div class="projects-bulk-bar-actions">
      <button id="bulk-clear">Clear</button>
      <button id="bulk-delete" class="danger">Delete selected</button>
    </div>
  `;
  bar.querySelector('#bulk-clear').addEventListener('click', () => {
    state._selectedProjects.clear();
    renderProjectsGrid();
  });
  bar.querySelector('#bulk-delete').addEventListener('click', async () => {
    const names = [...state._selectedProjects];
    if (!await customConfirm(
        `Delete ${names.length} project${names.length > 1 ? 's' : ''} and all their files?\n\n${names.join('\n')}`,
        'Delete selected projects')) return;
    let ok = 0, fail = 0;
    for (const name of names) {
      try {
        const r = await API.deleteProject({ projectName: name });
        if (r?.ok) ok++; else fail++;
      } catch (_) { fail++; }
    }
    state._selectedProjects.clear();
    await refreshProjectsPage();
    if (fail > 0) alert(`Deleted ${ok}, failed ${fail}`);
  });
}

// ============================================================
// NEW PROJECT MODAL
// ============================================================
function openNewProjectModal() {
  document.getElementById('np-name').value = '';
  document.getElementById('np-prompt').value = '';
  document.getElementById('np-block-msg')?.classList.add('hidden');
  const _npu = document.getElementById('np-unlock'); if (_npu) _npu.style.display = 'none';
  document.getElementById('modal-new-project').classList.remove('hidden');
  setTimeout(() => document.getElementById('np-name').focus(), 50);
}
function closeNewProjectModal() {
  document.getElementById('modal-new-project').classList.add('hidden');
  // If the modal was opened by a file drop and the user cancels, drop the
  // pending file so a later manual "New project" click does not silently
  // pull it in.
  if (window.__pendingDroppedFile) window.__pendingDroppedFile = null;
}
document.getElementById('btn-new-project').addEventListener('click', openNewProjectModal);
// Unlock from the New Project popup: run the parental toggle (PIN flow),
// then if the user is now unrestricted, retry creating the project.
document.getElementById('np-unlock')?.addEventListener('click', async () => {
  try { await toggleParentalControl(); } catch (_) {}
  try {
    const status = API.getParentalStatus ? await API.getParentalStatus() : null;
    if (status && status.unrestricted) {
      document.getElementById('np-block-msg')?.classList.add('hidden');
      const _u = document.getElementById('np-unlock'); if (_u) _u.style.display = 'none';
      document.getElementById('np-create')?.click();  // retry now that it's unlocked
    }
  } catch (_) {}
});
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
    // Word-boundary match: substring "ass" must not flag "asset",
    // "tit" must not flag "title", etc. Multi-word keywords like
    // "naked body" use \b on the outer edges only.
    const blocked = keywords.find(kw => {
      const escaped = kw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('\\b' + escaped + '\\b').test(text);
    });
    if (blocked) {
      // Show the block INSIDE the popup (not a toast) + an Unlock shortcut.
      const _msg = document.getElementById('np-block-msg');
      if (_msg) {
        _msg.textContent = `Blocked: "${blocked}" is not allowed with parental control active. Unlock to disable the content filter.`;
        _msg.classList.remove('hidden');
      }
      const _ub = document.getElementById('np-unlock');
      if (_ub) _ub.style.display = '';
      return;
    }
  }
  // Passed the filter (or unrestricted) — clear any prior block UI.
  document.getElementById('np-block-msg')?.classList.add('hidden');
  const _ub2 = document.getElementById('np-unlock'); if (_ub2) _ub2.style.display = 'none';

  closeNewProjectModal();
  // Create an empty project shell and open it
  const proj = {
    name,
    images: [],
    meshes: [],
    rigs: [],
    animations: [],
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

  // If the modal was opened by a drag&drop, attach the dropped file to
  // the freshly-created project so it appears immediately in the right
  // step. Blob URLs do not survive a reload — warn the user for mesh
  // drops (no upload endpoint yet).
  const pending = window.__pendingDroppedFile;
  window.__pendingDroppedFile = null;
  if (pending && pending.file) {
    try {
      const blobURL = URL.createObjectURL(pending.file);
      if (pending.kind === 'image') {
        try {
          window.__cloudImportedFiles = window.__cloudImportedFiles || {};
          window.__cloudImportedFiles[blobURL] = pending.file;
        } catch (_) {}
        try { window.__cloudImg?.append?.(proj.name, [blobURL], 'front'); } catch (_) {}
        proj.images = proj.images || [];
        proj.images.unshift({ path: blobURL, kind: 'front', mtime: Date.now() });
        try { await populateWorkspace(proj); } catch (_) {}
        try { showToast(`Imported "${pending.name}"`, 'success'); } catch (_) {}
      } else if (pending.kind === 'mesh') {
        proj.meshes = proj.meshes || [];
        proj.meshes.unshift({ path: blobURL, filename: pending.name, size: pending.file.size, mtime: Date.now() });
        proj.selectedMeshPath = blobURL;
        proj.previewMeshPath = blobURL;
        try { await populateWorkspace(proj); } catch (_) {}
        try { showToast(`Imported "${pending.name}" (session only — re-import after reload).`, 'info', 6000); } catch (_) {}
      }
    } catch (err) {
      try { showToast('Import failed: ' + (err?.message || err), 'error', 5000); } catch (_) { alert('Import failed: ' + err); }
    }
  }
});

// ===========================================================
// Asset-type-driven option visibility
// ===========================================================
// Each TRELLIS-2 advanced option (Detail refine, Auto-rectify,
// Texture smooth, Quality+, Ultra Quality 1536, Ultra HD 8K, Face fix)
// is relevant for some asset types and not others. This profile tells
// the UI:
//   true  -> visible + checked by default
//   false -> visible + unchecked by default
//   null  -> hidden (forced off, no UI noise)
//
// 'custom' shows everything (user picks).
const ASSET_OPTIONS_PROFILE = {
  character: {
    'ws-trellis2-rectify':      true,   // strict front T-pose
    'ws-trellis2-smooth':       false,  // skin grain is fine
    'ws-trellis2-refine':       true,   // skin pores, hair detail
    'ws-trellis2-quality-plus': true,
    'ws-trellis2-ultra-q':      true,   // face detail matters
    'ws-trellis2-ultra-hd':     true,
    'ws-trellis2-face-fix':     true,
  },
  creature: {
    'ws-trellis2-rectify':      true,
    'ws-trellis2-smooth':       false,  // fur, scales
    'ws-trellis2-refine':       true,
    'ws-trellis2-quality-plus': true,
    'ws-trellis2-ultra-q':      true,   // creature faces too
    'ws-trellis2-ultra-hd':     true,
    'ws-trellis2-face-fix':     true,
  },
  insect: {
    'ws-trellis2-rectify':      false,  // the 3/4 iso image IS the reference; do NOT re-rectify to a front view (head-on breaks insect meshes)
    'ws-trellis2-smooth':       false,  // exoskeleton / chitin detail
    'ws-trellis2-refine':       true,
    'ws-trellis2-quality-plus': true,
    'ws-trellis2-ultra-q':      false,  // no human face to gain from 1536
    'ws-trellis2-ultra-hd':     true,
    'ws-trellis2-face-fix':     null,   // insects have no human face
  },
  vehicle: {
    'ws-trellis2-rectify':      true,   // 3/4 iso
    'ws-trellis2-smooth':       true,   // paint, chrome
    'ws-trellis2-refine':       null,   // hallucinates wear on smooth surfaces
    'ws-trellis2-quality-plus': true,
    'ws-trellis2-ultra-q':      null,   // no face to gain from 1536
    'ws-trellis2-ultra-hd':     true,
    'ws-trellis2-face-fix':     null,
  },
  building: {
    'ws-trellis2-rectify':      true,
    'ws-trellis2-smooth':       true,
    'ws-trellis2-refine':       true,
    'ws-trellis2-quality-plus': true,
    'ws-trellis2-ultra-q':      null,
    'ws-trellis2-ultra-hd':     true,
    'ws-trellis2-face-fix':     null,
  },
  weapon: {
    'ws-trellis2-rectify':      true,
    'ws-trellis2-smooth':       true,
    'ws-trellis2-refine':       true,
    'ws-trellis2-quality-plus': true,
    'ws-trellis2-ultra-q':      null,
    'ws-trellis2-ultra-hd':     true,
    'ws-trellis2-face-fix':     null,
  },
  prop: {
    'ws-trellis2-rectify':      true,
    'ws-trellis2-smooth':       true,
    'ws-trellis2-refine':       true,
    'ws-trellis2-quality-plus': true,
    'ws-trellis2-ultra-q':      null,
    'ws-trellis2-ultra-hd':     true,
    'ws-trellis2-face-fix':     null,
  },
  environment: {
    'ws-trellis2-rectify':      true,
    'ws-trellis2-smooth':       true,
    'ws-trellis2-refine':       true,
    'ws-trellis2-quality-plus': true,
    'ws-trellis2-ultra-q':      null,
    'ws-trellis2-ultra-hd':     true,
    'ws-trellis2-face-fix':     null,
  },
  icon: {
    'ws-trellis2-rectify':      true,
    'ws-trellis2-smooth':       true,   // icons are glossy / clean
    'ws-trellis2-refine':       null,   // no pores/fur on a flat icon
    'ws-trellis2-quality-plus': true,
    'ws-trellis2-ultra-q':      null,   // overkill for a small icon
    'ws-trellis2-ultra-hd':     null,   // overkill — icons stay small
    'ws-trellis2-face-fix':     null,
  },
  avion: {
    'ws-trellis2-rectify':      false,  // OFF: rectifier (iso 3/4 regen) distorts swept wings + long fuselage proportions; let MV-Adapter handle angles
    'ws-trellis2-smooth':       true,   // metal panels
    'ws-trellis2-refine':       null,   // hallucinates wear on smooth fuselage
    'ws-trellis2-quality-plus': true,
    'ws-trellis2-ultra-q':      null,
    'ws-trellis2-ultra-hd':     true,
    'ws-trellis2-face-fix':     null,
  },
  bateau: {
    'ws-trellis2-rectify':      false,  // OFF: rectifier re-angles hull/superstructure away from a clean broadside
    'ws-trellis2-smooth':       true,   // hull paint
    'ws-trellis2-refine':       null,   // hallucinates wear on smooth hull
    'ws-trellis2-quality-plus': true,
    'ws-trellis2-ultra-q':      null,
    'ws-trellis2-ultra-hd':     true,
    'ws-trellis2-face-fix':     null,
  },
  animal: {
    'ws-trellis2-rectify':      true,
    'ws-trellis2-smooth':       false,  // fur, scales
    'ws-trellis2-refine':       true,
    'ws-trellis2-quality-plus': true,
    'ws-trellis2-ultra-q':      true,   // animal faces matter
    'ws-trellis2-ultra-hd':     true,
    'ws-trellis2-face-fix':     true,
  },
  custom: {
    'ws-trellis2-rectify':      true,
    'ws-trellis2-smooth':       true,
    'ws-trellis2-refine':       false,
    'ws-trellis2-quality-plus': true,
    'ws-trellis2-ultra-q':      false,
    'ws-trellis2-ultra-hd':     true,
    'ws-trellis2-face-fix':     false,
  },
};

function _applyAssetOptionsProfile(assetType) {
  const profile = ASSET_OPTIONS_PROFILE[assetType] || ASSET_OPTIONS_PROFILE.custom;
  for (const [id, state] of Object.entries(profile)) {
    const cb = document.getElementById(id);
    if (!cb) continue;
    const row = cb.closest('.form-row');
    if (state === null) {
      if (row) row.style.display = 'none';
      cb.checked = false;
    } else {
      if (row) row.style.display = '';
      cb.checked = !!state;
    }
  }
}
(function _wireAssetOptionsProfile() {
  const sel = document.getElementById('ws-asset-type');
  if (!sel) return;
  sel.addEventListener('change', () => _applyAssetOptionsProfile(sel.value));
  // Apply once on initial render so the default character profile takes effect.
  _applyAssetOptionsProfile(sel.value || 'character');
})();

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
    // No build stages for living subjects (character/creature/animal) or flat 2D icons.
    const hide = (at === 'character' || at === 'creature' || at === 'animal' || at === 'icon');
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
  // 2026-06-02: dispose any 3D viewer state held over from the
  // previous project BEFORE swapping state.currentProject. User
  // reported "je vois toujours l'animation dragon alors que je
  // suis dans le projet orc rose" — the anim mixer / model + rig
  // source mesh from the previous project stayed in their THREE.js
  // scenes because nothing cleared them on project switch.
  try { if (typeof _disposeAnimModel === 'function') _disposeAnimModel(); } catch (_) {}
  try { if (typeof showRigSourceMesh === 'function') await showRigSourceMesh(null); } catch (_) {}
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
      { id: 'step-card-rig',       has: (p.rigs       && p.rigs.length       > 0) },
      { id: 'step-card-animation', has: (p.animations && p.animations.length > 0) },
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
  // Helper: rewrite the label while preserving the yellow cost pill.
  // The pill <span> is hardcoded in index.html and read by the live
  // meter — using textContent here wiped it (the user saw a bare
  // "Generate new version" with no ⚡ badge).
  const _setLabelWithImgPill = (btn, label) => {
    const curVal = document.getElementById('ws-image-cost-value')?.textContent || '2';
    btn.innerHTML = escapeHtml(label) +
      ` <span class="generate-cost-pill"><span class="generate-cost-bolt">⚡</span>` +
      `<span id="ws-image-cost-value">${escapeHtml(curVal)}</span></span>`;
  };
  const _setLabelWithMeshPill = (btn, label) => {
    const curVal = document.getElementById('ws-mesh-cost-value')?.textContent || '8';
    btn.innerHTML = escapeHtml(label) +
      ` <span id="ws-mesh-cost-pill" class="generate-cost-pill"><span class="generate-cost-bolt">⚡</span>` +
      `<span id="ws-mesh-cost-value">${escapeHtml(curVal)}</span></span>`;
  };
  const btnImg = document.getElementById('ws-generate-image');
  if (btnImg) _setLabelWithImgPill(btnImg, p.images.length > 0 ? 'Generate new version' : 'Generate');
  const btnMesh = document.getElementById('ws-generate-mesh');
  if (btnMesh) {
    btnMesh.disabled = !p.selectedImagePath;
    _setLabelWithMeshPill(btnMesh, p.meshes.length > 0 ? 'Generate new 3D version' : 'Generate 3D');
  }
  // Rigging button (unified: engine selected via #ws-rig-engine -> UniRig).
  // Allow generation if either a mesh is selected for this project OR the
  // rig-source viewer is currently showing one.
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
  // 2026-06-02: unconditionally run _autoPickSourceForCreateNew for
  // every step at project-load time. The previous "only if
  // stage.open" guard skipped the populate when Edit Selected was
  // the default open stage (i.e. project has content), so the user
  // saw "No image/mesh/rig selected" the moment they expanded
  // Create New. The function is idempotent and a no-op when the
  // step has no upstream data.
  ['step-card-mesh', 'step-card-rig', 'step-card-animation'].forEach((cid) => {
    const card = document.getElementById(cid);
    if (card) {
      try { _autoPickSourceForCreateNew(card); } catch (_) {}
    }
  });
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
      if (createStage.open) {
        editStage.open = false;
        // 2026-06-02 UX: auto-pick the latest version from the
        // previous step when the user opens Create New without an
        // explicit source selection. Previously the user saw an empty
        // "No image/mesh/rig selected" placeholder and had to go back
        // a step → click "Use this for X" → return. Now Step 2/3/4
        // each fall back to their previous step's newest version.
        try { _autoPickSourceForCreateNew(card); } catch (_) {}
      }
    });
    editStage.addEventListener('toggle', () => {
      if (editStage.open) createStage.open = false;
    });
  });
}
bindStageMutualExclusion();

// Ensure the Create New SOURCE preview for a given step is populated.
// 2026-06-02 rewrite: this used to only fire when stage.open + no
// selection — both conditions were wrong on the most common case
// (project with content where Edit Selected is the default open
// stage). The new version is idempotent and unconditional: if no
// selection exists, pick the newest from the previous step; THEN
// always (re-)draw the source preview with whatever path is set.
// Safe to call repeatedly; show*() handlers are no-ops on stale path.
function _autoPickSourceForCreateNew(card) {
  const p = state.currentProject;
  if (!p || !card) return;
  const cardId = card.id;
  // Guard against cross-project bleed (mesh-op / rigged / animation
  // attribution upstream sometimes pulls items from other projects
  // into p.meshes/rigs — observed in prod 2026-06-02 when a "lion"
  // mesh appeared as the Source Mesh in the "dragon" project).
  // STRICT: require explicit projectName match. Items with no
  // projectName, "_orphans", or a different project name are
  // rejected — surfacing the upstream attribution bug rather than
  // silently displaying the wrong asset.
  const belongs = (it) => {
    if (!it) return false;
    if (!p || !p.name) return false;
    if (!it.projectName) return false;
    if (it.projectName === '_orphans') return false;
    return it.projectName === p.name;
  };
  // Step 2 (3D Mesh) — source IMAGE.
  if (cardId === 'step-card-mesh') {
    // STALE GUARD: if selectedImagePath doesn't exist in p.images
    // (e.g. user clicked "Use this for X" on an image in another
    // project at some point), reset and re-pick from current project.
    if (p.selectedImagePath && p.images && !p.images.some(it =>
        (typeof it === 'string' ? it : it.path) === p.selectedImagePath)) {
      console.warn('[autoPick] stale selectedImagePath, resetting', p.selectedImagePath);
      p.selectedImagePath = null;
      p.previewImagePath = null;
    }
    if (!p.selectedImagePath && p.images && p.images.length > 0) {
      const newest = (p.images || []).find(it => belongs(it));
      const path = newest && (typeof newest === 'string' ? newest : newest.path);
      if (path) {
        p.selectedImagePath = path;
        p.previewImagePath = path;
      }
    }
    if (p.selectedImagePath) {
      try { showStep2SourceImage(p.selectedImagePath); } catch (_) {}
      try { refreshButtonLabelsAndHiding(p); } catch (_) {}
    }
    return;
  }
  // Step 3 (Rig) — source MESH.
  if (cardId === 'step-card-rig') {
    // STALE GUARD: if selectedMeshPath doesn't point to any of the
    // current project's meshes, drop it so the auto-pick falls back
    // to a valid one (this is what was happening with the "lion in
    // dragon viewer" bug — selectedMeshPath was leaking across
    // projects via the "Use this for X" handoff).
    if (p.selectedMeshPath && p.meshes && !p.meshes.some(m =>
        m && (m.path === p.selectedMeshPath || m.url === p.selectedMeshPath))) {
      console.warn('[autoPick] stale selectedMeshPath, resetting', p.selectedMeshPath);
      p.selectedMeshPath = null;
    }
    if (!p.selectedMeshPath && p.meshes && p.meshes.length > 0) {
      const newest = (p.meshes || []).find(it => belongs(it));
      const path = newest && (newest.path || newest.url);
      if (path) p.selectedMeshPath = path;
    }
    if (p.selectedMeshPath) {
      try { showRigSourceMesh(p.selectedMeshPath); } catch (_) {}
      try { refreshButtonLabelsAndHiding(p); } catch (_) {}
    }
    return;
  }
  // Step 4 (Animation) — source RIG.
  if (cardId === 'step-card-animation') {
    const selRig = p.selectedRigUrl || p.selectedRigPath;
    if (selRig && p.rigs && !p.rigs.some(r =>
        r && (r.url === selRig || r.path === selRig))) {
      console.warn('[autoPick] stale selectedRigUrl, resetting', selRig);
      p.selectedRigUrl = null;
      p.selectedRigPath = null;
    }
    if (!p.selectedRigUrl && !p.selectedRigPath && p.rigs && p.rigs.length > 0) {
      const newest = (p.rigs || []).find(it => belongs(it));
      const url = newest && (newest.url || newest.path);
      if (url) {
        p.selectedRigUrl = url;
        p.selectedRigPath = newest.path || url;
      }
    }
    const sel = p.selectedRigUrl || p.selectedRigPath;
    if (sel && p.rigs && p.rigs.length > 0) {
      const rig = p.rigs.find(r => r && (r.url === sel || r.path === sel)) || p.rigs[0];
      const url = rig.url || rig.path;
      try {
        const preview = document.getElementById('ws-anim-source-preview');
        const placeholder = document.getElementById('ws-anim-source-placeholder');
        if (placeholder) placeholder.style.display = 'none';
        if (preview) {
          const filename = (rig.filename || url).split(/[/\\]/).pop() || 'rig.glb';
          preview.style.position = 'relative';
          preview.style.minHeight = '200px';
          preview.innerHTML = `
            <model-viewer src="${url}"
                          camera-controls touch-action="pan-y"
                          shadow-intensity="1" exposure="1"
                          auto-rotate auto-rotate-delay="3000"
                          style="position:absolute; inset:0; width:100%; height:100%; background:#0a0a0e; border-radius:6px;">
            </model-viewer>
            <div style="position:absolute; bottom:6px; left:0; right:0; text-align:center; font-size:10px; color:var(--text-2); pointer-events:none; padding:0 8px; word-break:break-all;">${filename}</div>
          `;
          try { setViewerLoading('ws-anim-source-preview', true, 'Loading rig…'); } catch (_) {}
          const mv = preview.querySelector('model-viewer');
          if (mv) {
            const clear = () => { try { setViewerLoading('ws-anim-source-preview', false); } catch (_) {} };
            mv.addEventListener('load', clear, { once: true });
            mv.addEventListener('error', clear, { once: true });
            setTimeout(clear, 10000);
          }
        }
        const genBtn = document.getElementById('ws-generate-anim');
        if (genBtn) { genBtn.disabled = false; genBtn.title = ''; }
      } catch (_) {}
    }
  }
}

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
  // Clear the three.js scene if it exists (remove ALL tagged meshes, not just
  // the tracked pointer, so nothing leaks across projects).
  if (typeof _clearWsMeshes === 'function') _clearWsMeshes();
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
  // Make sure no landmark markers leak into the 3D Mesh main viewer
  // from a prior session — they belong only in the rig source viewer
  // and the fullscreen landmarks modal.
  try { clearLandmarkMarkersFromMainViewer(); } catch (_) {}

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
  // Restore Asset type + Style from the project's first generation so a
  // creature-project doesn't default back to character on follow-up gens.
  _restoreProjectMeta(p);

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
  // Enable / disable the 4 rig tool buttons (Export to Unreal, Re-skin
  // only, Landmarks, Test animation) based on whether a rig exists.
  _updateRigToolButtons();
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

  // Anim step — render the version strip so prior generations survive
  // a reload, and auto-load v0 into the viewer if any.
  renderAnimVersions(p);
  if (p.animations && p.animations.length > 0) {
    setStepStatus(4, 'done');
    const animCard = document.getElementById('step-card-animation');
    if (animCard) animCard.classList.remove('disabled', 'collapsed');
  }

  loadRigTemplatesIntoSelect();
}

function setStepStatus(stepNum, status) {
  const card = document.getElementById(`step-card-${['', 'image', 'mesh', 'rig', 'animation'][stepNum]}`);
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
// Bumped on every renderImageVersions call; awaits in this function
// check against this counter to abort if a newer call has started,
// which prevents concurrent renders from each appending their items
// to the strip (the bug that produced 'v1 v0 v1 v0' duplicate thumbs).
let _renderImageVersionsSeq = 0;
async function renderImageVersions(p) {
  const mySeq = ++_renderImageVersionsSeq;
  const strip = document.getElementById('ws-image-versions');
  strip.innerHTML = '';
  console.log('[renderImageVersions] seq=', mySeq, 'project=', p?.name, 'images_count=', p?.images?.length,
              'first_path=', p?.images?.[0]?.path || p?.images?.[0]);

  // Check parental control status
  let restricted = true;
  try {
    if (API.getParentalStatus) {
      const ps = await API.getParentalStatus();
      restricted = !ps.unrestricted;
    }
  } catch(_) {}
  if (mySeq !== _renderImageVersionsSeq) {
    console.log('[renderImageVersions] aborting seq=', mySeq, '(newer seq=', _renderImageVersionsSeq, ')');
    return;
  }

  // Filter out NSFW images when restricted (check .nsfw tag files via IPC)
  let images = p.images;
  if (restricted && p.images.length > 0 && API.checkImagesNsfwTags) {
    try {
      const allPaths = p.images.map(img => img.path || img);
      const tags = await API.checkImagesNsfwTags({ images: allPaths });
      if (mySeq !== _renderImageVersionsSeq) {
        console.log('[renderImageVersions] aborting seq=', mySeq, 'after NSFW (newer seq=', _renderImageVersionsSeq, ')');
        return;
      }
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
    // Stable id so marketplace badge walker (_badgeAllCards) can match by
    // jobId — url matching alone fails when the thumb shows a cache-busted
    // local path that doesn't appear in _publishedIndex.byUrl.
    t.dataset.jobId = img.jobId || img.job_id || img.id || '';
    if (img.path === p.previewImagePath) t.classList.add('selected');
    if (img.path === p.selectedImagePath) t.classList.add('used-for-3d');
    // Cache-bust so Electron/Chromium re-reads ref_0.png after a new
    // generation overwrote it. Without this, the thumbnail shows a stale
    // version (previous generation) even though the file on disk is new.
    const _cb = img.mtime || p._reloadTs || Date.now();
    // Small bottom-right badge when this image has a saved emissive
    // layer painted on it (Paint Tools → 💡 Emissive). Lets the user
    // tell at a glance which versions feed T_emissive.
    const hasEmissive = (typeof _emissiveLayerHas === 'function') && _emissiveLayerHas(img.path);
    const emissiveBadge = hasEmissive
      ? '<span class="v-emissive-badge" title="This image has an emissive layer painted on it" style="position:absolute; bottom:2px; right:2px; background:rgba(0,0,0,0.7); border-radius:50%; width:18px; height:18px; display:flex; align-items:center; justify-content:center; font-size:11px; line-height:1; box-shadow:0 0 0 1px rgba(255, 224, 102, 0.85);">💡</span>'
      : '';
    // _imgSrc handles blob:/http:/data: URLs (dropped-file imports) correctly;
    // bare filesystem paths get the file:/// prefix as before. Skip cache-bust
    // for blob URLs (they're immutable in-memory handles).
    const _thumbSrc = _imgSrc(img.path);
    const _thumbUrl = /^(blob|data):/i.test(img.path) ? _thumbSrc : `${_thumbSrc}?t=${_cb}`;
    t.innerHTML = `
      <img src="${_thumbUrl}">
      <span class="v-used-badge" title="Used for next step">&#10003;</span>
      <span class="v-label">v${images.length - 1 - i}</span>
      <button class="version-delete-btn" title="Delete this version">&#10005;</button>
      ${emissiveBadge}
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

// ============================================================================
// LINEAGE JUMP (ported from desktop src/renderer/index2.js).
// Jump from a derived asset (mesh / rig / animation) back to the source image,
// mesh or rig it descends from, then center + flash the matching version.
//
// CLOUD ADAPTATION: on the cloud every mesh/rig/image/anim ref is an R2 SIGNED
// URL with a VOLATILE ?exp=&sig= query (re-minted on every /api/meshes call), so
// raw === comparison NEVER matches the same object across calls. Mirror _emKey:
// strip the /[?#].*$/ query before EVERY path compare. _sigKey() does exactly
// that (backslash->slash + drop query + lowercase). Basename / filename-stem
// matching is preferred because the R2 key tail is stable.
//
// All additions are GUARDED: a button is only rendered when its target resolves,
// so missing lineage data == zero markup == zero impact on the working app.
// ----------------------------------------------------------------------------

// Normalize a path / signed URL to a stable comparable key: drop the volatile
// ?signature / #fragment, normalize slashes, lowercase. Same rule as _emKey.
function _sigKey(u) {
  return String(u == null ? '' : u)
    .replace(/\\/g, '/')
    .replace(/[?#].*$/, '')
    .toLowerCase();
}

// Center the currently-selected thumb of a versions strip in the viewport (not
// top-aligned) and flash a blue glow twice. Guarded (no-op when strip/sel
// missing). The 140ms delay lets the card expand/render first.
function _flashCenterSelected(stripId) {
  setTimeout(() => {
    const strip = document.getElementById(stripId);
    const sel = strip && strip.querySelector('.version-thumb.selected');
    if (!sel) return;
    try { sel.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }); } catch (_) {}
    try {
      sel.animate(
        [{ boxShadow: '0 0 0 0 rgba(138,180,255,0.95)' },
         { boxShadow: '0 0 0 7px rgba(138,180,255,0)' }],
        { duration: 850, iterations: 2 });
    } catch (_) {}
  }, 140);
}

// Resolve the SOURCE MESH of a rig (or any derived item) by longest-prefix stem
// match against p.meshes — a rig 'X_rigged_<engine>_<ts>' descends from mesh 'X'.
// Stem match is on FILENAME (stable), not the signed URL; the fallback that
// reads item.path strips the query first. Returns a mesh PATH (signed URL on
// cloud) which the consumer (jumpToMesh) re-resolves via _sigKey compare.
function _resolveParentMeshPath(item, p) {
  if (!p || !Array.isArray(p.meshes) || !item) return null;
  const stem = (s) => String(s || '').replace(/\.[^.]+$/, '');
  const itemStem = stem(item.filename || _sigKey(item.path || '').split('/').pop());
  if (!itemStem) return null;
  const cands = p.meshes.filter((m) => {
    const ms = stem(m.filename);
    return ms && (itemStem === ms || itemStem.startsWith(ms + '_'));
  });
  if (!cands.length) return null;
  cands.sort((a, b) => stem(b.filename).length - stem(a.filename).length);
  return cands[0].path;
}

// Resolve the SOURCE RIG of an animation clip by longest-prefix stem match
// against p.rigs. The anim filename embeds the rig stem before the
// _<animType>_<batchId>_<ts>.glb tail; strip it then prefix-match the rig stem.
function _resolveParentRig(clip, p) {
  if (!p || !Array.isArray(p.rigs) || !clip) return null;
  const fn = clip.filename || _sigKey(clip.path || clip.url || '').split('/').pop();
  if (!fn) return null;
  // Strip the animation tail to recover the rig stem.
  const beforeAnim = String(fn)
    .replace(/\.[^.]+$/, '')
    .replace(/_(idle|walk|run|attack|death|fly|jump|custom|clip)_(?:[A-Za-z0-9_-]{4,32}_)?\d{6,}$/i, '')
    .replace(/_(anim|animation)_.*$/i, '');
  const stem = (s) => String(s || '').replace(/\.[^.]+$/, '');
  const cands = p.rigs.filter((r) => {
    const rs = stem(r.filename);
    return rs && (beforeAnim === rs || beforeAnim.startsWith(rs + '_') || rs.startsWith(beforeAnim + '_'));
  });
  if (!cands.length) return null;
  cands.sort((a, b) => stem(b.filename).length - stem(a.filename).length);
  return cands[0];
}

// Jump to the SOURCE IMAGE that produced a mesh/rig/anim. Non-destructive:
// previews the matched version (purple), leaves selectedImagePath (green check)
// untouched. Falls back to the lightbox if the source isn't a current version.
async function jumpToSourceImage(imgPath) {
  if (!imgPath) return;
  const p = state.currentProject;
  try { closeMeshLightbox(); } catch (_) {}
  let matched = null;
  if (p && Array.isArray(p.images)) {
    // CLOUD: both sides are signed URLs — compare on the query-stripped key.
    const _key = (x) => _sigKey(x && x.path ? x.path : x);
    const _bn = (x) => _key(x).split('/').pop();
    const _stem = (s) => s.replace(/\.[^.]+$/, '');
    const target = _sigKey(imgPath);
    const base = target.split('/').pop();
    matched = p.images.find(im => _key(im) === target)
           || p.images.find(im => _bn(im) === base);
    if (!matched) {
      const core = _stem(base)
        .replace(/^fabmesh_rectified_\d+_/, '')
        .replace(/^fabmesh_[a-z]+_\d+_/, '');
      if (core && core !== _stem(base)) {
        const cands = p.images.filter(im => {
          const vs = _stem(_bn(im));
          return vs === core || vs.startsWith(core + '_') || core.startsWith(vs + '_');
        });
        const selKey = _sigKey(p.selectedImagePath);
        const prevKey = _sigKey(p.previewImagePath);
        matched = cands.find(im => _key(im) === selKey)
               || cands.find(im => _key(im) === prevKey)
               || cands[0] || null;
      }
    }
  }
  if (!matched) {
    // Source isn't one of the current versions — show it in the lightbox if
    // the file still exists (the signed URL is directly fetchable as-is).
    try {
      const info = await API.getFileInfo(imgPath);
      if (info && info.ok) {
        showToast("Source absente des versions actuelles — affichée en grand.", 'info');
        openLightbox(imgPath);
        return;
      }
    } catch (_) {}
    showToast("Image source introuvable (déplacée ou supprimée).", 'error');
    return;
  }
  const matchedPath = matched.path || matched;
  p.previewImagePath = matchedPath;
  p._activeMultiview = null;
  const imgCard = document.getElementById('step-card-image');
  if (imgCard) {
    imgCard.classList.remove('collapsed', 'disabled');
    const createStage = imgCard.querySelector('.stage-create');
    const editStage = imgCard.querySelector('.stage-edit');
    if (createStage) createStage.open = false;
    if (editStage) editStage.open = true;
  }
  try { await renderImageVersions(p); } catch (_) {}
  try { showStep1Preview(matchedPath); } catch (_) {}
  try { _restoreStyleDropdown(matchedPath); } catch (_) {}
  _flashCenterSelected('ws-image-versions');
}

// Jump to the MESH a rig/animation was built from. Non-destructive (previews;
// doesn't change which mesh is marked for rigging).
async function jumpToMesh(meshPath) {
  const p = state.currentProject;
  if (!p || !meshPath) return;
  // CLOUD: compare on the query-stripped key (both sides are signed URLs).
  const key = _sigKey(meshPath);
  const mesh = (p.meshes || []).find((m) => _sigKey(m.path) === key);
  if (!mesh) { showToast('Maillage source introuvable.', 'error'); return; }
  try { closeMeshLightbox(); } catch (_) {}
  const card = document.getElementById('step-card-mesh');
  if (card) {
    card.classList.remove('collapsed', 'disabled');
    const cs = card.querySelector('.stage-create');
    const es = card.querySelector('.stage-edit');
    if (cs) cs.open = false;
    if (es) es.open = true;
  }
  p.previewMeshPath = mesh.path;
  try { await renderMeshVersions(p); } catch (_) {}
  try { showStep2Preview(mesh); } catch (_) {}
  _flashCenterSelected('ws-mesh-versions');
}

// Jump to the RIG an animation was retargeted onto: open the Rig step, select +
// center + flash that rig, and move the green used-check to it.
async function jumpToRig(rigPath) {
  const p = state.currentProject;
  if (!p || !rigPath) return;
  // CLOUD: compare on the query-stripped key.
  const key = _sigKey(rigPath);
  const rig = (p.rigs || []).find((r) => _sigKey(r.path) === key);
  if (!rig) { showToast('Rig source introuvable.', 'error'); return; }
  try { closeMeshLightbox(); } catch (_) {}
  const card = document.getElementById('step-card-rig');
  if (card) {
    card.classList.remove('collapsed', 'disabled');
    const cs = card.querySelector('.stage-create');
    const es = card.querySelector('.stage-edit');
    if (cs) cs.open = false;
    if (es) es.open = true;
  }
  try { renderRigVersions(p); } catch (_) {}
  // renderRigVersions defaults to selecting the newest; move the highlight to
  // the target rig (matched by filename, which is set as the thumb title).
  const strip = document.getElementById('ws-rig-versions');
  if (strip) {
    const thumbs = [...strip.querySelectorAll('.version-thumb')];
    const target = thumbs.find((el) => el.title === rig.filename);
    if (target) {
      thumbs.forEach((x) => x.classList.remove('selected', 'used-for-3d'));
      target.classList.add('selected', 'used-for-3d');
    }
  }
  try { showStep3Preview(rig); } catch (_) {}
  _flashCenterSelected('ws-rig-versions');
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
    if (typeof showStep2BackImage === 'function') {
      showStep2BackImage(null);
    }
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
    target.innerHTML = `<img src="${_toFileUrl(imgPath)}">`;
    // Spinner while the <img> decodes — only relevant for big PNGs
    // or remote R2 URLs. Cleared on load/error or after 10s safety.
    try { setViewerLoading('ws-3d-source-preview', true, 'Loading image…'); } catch (_) {}
    const imgEl = target.querySelector('img');
    if (imgEl) {
      const clear = () => { try { setViewerLoading('ws-3d-source-preview', false); } catch (_) {} };
      if (imgEl.complete && imgEl.naturalWidth > 0) {
        clear();
      } else {
        imgEl.addEventListener('load', clear, { once: true });
        imgEl.addEventListener('error', clear, { once: true });
        setTimeout(clear, 10000);
      }
    }
  } else {
    target.innerHTML = '<div class="preview-placeholder">No image selected</div>';
    try { setViewerLoading('ws-3d-source-preview', false); } catch (_) {}
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
  // Decide which optional block to show under the front photo:
  // - 6-view dir present  -> show the MV grid, hide back slot
  // - back photo present  -> show back slot only (legacy 2-view)
  // - neither             -> hide both (single image, no clutter)
  const p = state.currentProject;
  const hasBackPhoto = !!(p && (
    (p._backPhotos && p._backPhotos[imgPath]) ||
    p.backImagePath
  ));
  if (mvDir) {
    mvBlock.classList.remove('hidden');
    if (backBlock) backBlock.classList.add('hidden');
    const LABELS = ['FRONT', 'RIGHT', 'BACK', 'LEFT', 'TOP', 'BOTTOM'];
    grid.innerHTML = LABELS.map((label, i) => {
      const vp = (mvDir + '/view_' + i + '.png').replace(/\\/g, '/');
      return (
        '<div class="stage-source-mv-thumb" style="position:relative;">'
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
    if (backBlock) {
      // Only show the "+ Add back photo" slot when a back photo already
      // exists for this image. Otherwise hide it so single-image jobs
      // aren't cluttered with an unused 2-view slot.
      backBlock.classList.toggle('hidden', !hasBackPhoto);
    }
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
    target.innerHTML = `<img src="${_toFileUrl(imgPath)}">`;
    if (clearBtn) clearBtn.style.display = 'inline-block';
  } else {
    target.innerHTML = '<div class="preview-placeholder">+ Add back photo</div>';
    if (clearBtn) clearBtn.style.display = 'none';
  }
  setViewerFilename('ws-3d-source-back-filename', imgPath);
  _ws3dMultiRefSync();
}

// Multi-reference sync : couples the checkbox state, the checkbox row
// visibility, and the back-photo preview block on the right.
//   - No back photo attached     → checkbox row hidden, back block shows
//                                   the "+ Add back photo" placeholder.
//   - Back photo + checkbox ON   → checkbox row shown checked, back
//                                   preview visible, back image fed to
//                                   TRELLIS-2 at generation.
//   - Back photo + checkbox OFF  → checkbox row shown unchecked, back
//                                   preview HIDDEN, back image NOT fed
//                                   to TRELLIS-2 (user opted out).
function _ws3dMultiRefSync(opts = {}) {
  const row = document.getElementById('ws-trellis2-multiref-row');
  const backBlock = document.getElementById('ws-3d-source-back-block');
  if (!row) return;
  const p = state.currentProject;
  const hasBack = !!(p && p.backImagePath);
  const cb = document.getElementById('ws-trellis2-multiref');
  row.style.display = hasBack ? '' : 'none';
  // Auto-check on first attach unless the user just toggled the box.
  if (cb && !opts.fromCheckbox) cb.checked = hasBack;
  if (backBlock) {
    const showBack = !hasBack || (cb && cb.checked);
    backBlock.style.display = showBack ? '' : 'none';
  }
}
document.getElementById('ws-trellis2-multiref')?.addEventListener('change',
  () => _ws3dMultiRefSync({ fromCheckbox: true }));
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
        // On cloud, saveBuffer falls back to the legacy "download" branch
        // and leaves backImagePath as a local filename string — the
        // Worker can't fetch that, so multi-ref TRELLIS-2 then fails.
        // Route through saveImageDataUrl, which uploads to R2 and
        // returns a stable HTTPS URL the Worker can actually GET.
        const dataUrl = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = () => reject(fr.error || new Error('FileReader failed'));
          fr.readAsDataURL(f);
        });
        const saveRes = await window.meshyAPI.saveImageDataUrl({
          dataUrl,
          suffix: 'back',
          basePath: `${p.name}_back_${Date.now()}.png`,
        });
        const savedPath = saveRes?.newPath || saveRes?.path;
        if (saveRes?.success && savedPath) {
          p.backImagePath = savedPath;
          showStep2BackImage(savedPath);
          showToast('Back photo added', 'success');
        } else {
          showToast(`Add back photo failed: ${saveRes?.error || 'unknown'}`, 'error');
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
// 2026-06-02: bump on every showRigSourceMesh entry. Async loader
// callbacks check that their captured ID still matches before adding
// to the scene — otherwise a stale callback (slow load from project A)
// silently appends its mesh on top of the fresh project B load, and
// the user sees two meshes at once (a lion next to the dragon).
let rigSrcLoadId = 0;
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
  // Bump the load token: any callback from a PREVIOUS call that
  // hasn't fired yet will now find loadId !== myId and skip its
  // scene.add. Prevents the "lion ghost beside the dragon" bug.
  const myId = ++rigSrcLoadId;
  if (!meshPath) {
    if (placeholder) placeholder.style.display = '';
    if (rigSrcModel && rigSrcScene) { rigSrcScene.remove(rigSrcModel); rigSrcModel = null; }
    rigSrcMeshPath = null;
    try { setViewerLoading('ws-rig-source-preview', false); } catch (_) {}
    return;
  }
  // Idempotency: if we're already showing the requested mesh, do
  // nothing. Avoids tearing down a working scene during the
  // refreshButtonStates re-entrancy from the new unconditional
  // auto-pick path.
  if (rigSrcMeshPath === meshPath && rigSrcModel) {
    try { setViewerLoading('ws-rig-source-preview', false); } catch (_) {}
    return;
  }
  rigSrcMeshPath = meshPath;
  initRigSrcViewer();
  setViewerFilename('ws-rig-source-filename', meshPath);
  if (placeholder) placeholder.style.display = 'none';
  // Show the spinner immediately so the user has visual feedback
  // while the mesh fetch + GLB/FBX parse happen (can take 500ms-2s).
  try { setViewerLoading('ws-rig-source-preview', true, 'Loading mesh…'); } catch (_) {}
  // Make sure no leftover landmark markers pollute this clean preview
  if (rigSrcScene) {
    for (const id in lmMarkers) {
      try { rigSrcScene.remove(lmMarkers[id]); } catch (e) {}
    }
  }
  if (rigSrcModel) { rigSrcScene.remove(rigSrcModel); rigSrcModel = null; }
  const ext = (meshPath.split('.').pop() || '').toLowerCase();
  const applyLoadedModel = (obj) => {
    // Stale-callback guard: a slow load that started for a previous
    // path/project just finished, but we've moved on. Drop it on the
    // floor instead of polluting the current scene.
    if (myId !== rigSrcLoadId) {
      try { obj?.traverse?.((c) => { c.geometry?.dispose?.(); c.material?.dispose?.(); }); } catch (_) {}
      return;
    }
    // If a previous load already populated the scene since we cleared
    // it (race when 2 same-id loads overlap), remove its model first.
    if (rigSrcModel && rigSrcScene) {
      try { rigSrcScene.remove(rigSrcModel); } catch (_) {}
    }
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
  const clearSpinner = () => { try { setViewerLoading('ws-rig-source-preview', false); } catch (_) {} };
  if (ext === 'fbx') {
    // FBXLoader needs a URL so it can resolve textures relative to the file
    const url = _toFileUrl(meshPath);
    new FBXLoader().load(url, (obj) => { applyLoadedModel(obj); clearSpinner(); }, undefined, (err) => {
      console.error('FBX load error in rig source viewer', err);
      clearSpinner();
    });
  } else {
    const buffer = await API.readMeshFile(meshPath);
    if (!buffer) { clearSpinner(); return; }
    const loader = new GLTFLoader();
    loader.parse(buffer, '', (gltf) => { _applyMeshTextureFilter(gltf.scene); applyLoadedModel(gltf.scene); clearSpinner(); },
      (err) => { console.error('GLTF parse error in rig source viewer', err); clearSpinner(); });
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
  const placeholder = preview.querySelector('.preview-placeholder');
  if (placeholder) placeholder.remove();
  let imgEl = preview.querySelector('img');
  if (!imgEl) {
    imgEl = document.createElement('img');
    preview.insertBefore(imgEl, preview.firstChild);
  }
  // Loading overlay until <img> fires 'load' (or 'error').
  setViewerLoading('step1-preview', true, 'Loading image…');
  imgEl.onload = () => setViewerLoading('step1-preview', false);
  imgEl.onerror = () => {
    setViewerLoading('step1-preview', false);
    // Replace the broken <img> with our own DOM placeholder so the
    // browser / family-safety extension can't inject 'Blocked by content
    // filter' text on the empty image slot. The image is genuinely
    // missing on R2 (failed upload, deleted, network blocked by DNS
    // filter on *.r2.dev — all surface as 404 here).
    try {
      imgEl.style.display = 'none';
      let fallback = preview.querySelector('.viewer-img-error');
      if (!fallback) {
        fallback = document.createElement('div');
        fallback.className = 'viewer-img-error';
        fallback.style.cssText = 'position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; color:var(--text-3); font-size:13px; text-align:center; padding:20px; pointer-events:none;';
        fallback.innerHTML = '<span style="font-size:36px;">⚠</span><span>Image unavailable</span><span style="font-size:11px; color:var(--text-3); max-width:80%;">The file is missing from storage or your network blocks the R2 domain.</span>';
        preview.appendChild(fallback);
      }
    } catch (_) {}
  };
  // Clear any prior fallback so a successful reload re-shows the img.
  preview.querySelectorAll('.viewer-img-error').forEach(el => el.remove());
  imgEl.style.display = '';
  {
    const _src = _imgSrc(imgPath);
    imgEl.src = /^(blob|data):/i.test(imgPath) ? _src : (_src + '?t=' + Date.now());
  }
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
  if (prevBtn) { prevBtn.classList.remove('hidden'); prevBtn.disabled = false; }
  if (nextBtn) { nextBtn.classList.remove('hidden'); nextBtn.disabled = false; }
  if (counter) { counter.classList.remove('hidden'); counter.textContent = `${curIdx + 1} / ${images.length}`; }
}
function _navigateImage(delta) {
  const p = state.currentProject;
  if (!p || !p.images || p.images.length <= 1) return;
  const images = p.images;
  const curIdx = images.findIndex(i => (i.path || i) === p.previewImagePath);
  const newIdx = ((curIdx + delta) % images.length + images.length) % images.length;  // wrap-around
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
// The "Extra views" dropdown (ws-mv-scope) drives 3 mutually-exclusive
// modes: front_only / front_back / front_full. The legacy hidden checkbox
// ws-auto-multiview is kept in sync so the existing generate-images
// backend path (which expects a single boolean) keeps working — it
// triggers iff the user picked anything other than 'front_only'.
function _wsMvSync() {
  const scope = document.getElementById('ws-mv-scope')?.value || 'front_only';
  const legacy = document.getElementById('ws-auto-multiview');
  if (legacy) legacy.checked = (scope !== 'front_only');
}
document.getElementById('ws-mv-scope')?.addEventListener('change', _wsMvSync);
_wsMvSync();
// ----------------------------------------------------------------

// ----------------------------------------------------------------
// 3D engine selector — toggles visibility of legacy-only fields.
// TRELLIS-2 ignores texture-res and target-triangles (it generates its
// own native PBR resolution). Only show those fields when the legacy
// SF3D engine is selected.
// ----------------------------------------------------------------
function _ws3dEngineSync() {
  const eng = document.getElementById('ws-3d-engine')?.value || 'trellis2_native';
  const qRow = document.getElementById('ws-3d-quality-row');
  const tRow = document.getElementById('ws-3d-triangles-row');
  const qHint = document.getElementById('ws-3d-quality-hint');
  const sf3dHint = document.getElementById('ws-3d-sf3d-hint');
  const trellis2Opts = document.getElementById('ws-3d-trellis2-opts');
  const legacy = ['sf3d'].includes(eng);
  // Hide texture-res / triangles when using TRELLIS-2 native
  // (it has its own internal quality settings).
  if (qRow) qRow.style.display = legacy ? '' : 'none';
  if (tRow) tRow.style.display = legacy ? '' : 'none';
  if (qHint) qHint.style.display = legacy ? '' : 'none';
  if (sf3dHint) sf3dHint.style.display = legacy ? '' : 'none';
  // Advanced TRELLIS-2 options apply to trellis2_native.
  if (trellis2Opts) trellis2Opts.style.display =
    (eng === 'trellis2_native') ? '' : 'none';
}
document.getElementById('ws-3d-engine')?.addEventListener('change', _ws3dEngineSync);
_ws3dEngineSync();
// ----------------------------------------------------------------

// Generate Multi-Views button — opens an options modal first.
// User picks post-gen refinements (RealVis harmonize, ESRGAN upscale)
// and clicks "Start". Then we (a) duplicate the source image into a
// new version (so the original stays clean), (b) generate 6 MVs on
// that new version's <stem>_multiview/ dir, (c) reload the project
// so the gallery shows the new version with MV badge.
// ============================================================
// ✨ CREATE VARIANT — single panel (parity with desktop modal-variant):
// pick a Variation amount (img2img strength) + Number of variants, then
// loop img2img (a fresh seed per call) so you get distinct takes.
// ============================================================
function _updateVarStrengthHint() {
  const el = document.getElementById('var-strength-hint');
  const slider = document.getElementById('var-strength');
  if (!el || !slider) return;
  const v = parseInt(slider.value);
  let t;
  if (v <= 40) t = 'Subtle — small tweaks, stays very close to the original.';
  else if (v <= 60) t = 'Moderate — clear variation, same subject & composition.';
  else if (v <= 75) t = 'Strong — noticeable changes; the subject may shift a little.';
  else t = '⚠ Very strong — big re-interpretation; can drift away from the original.';
  el.textContent = t;
}
document.getElementById('ws-variant-btn')?.addEventListener('click', () => {
  const p = state.currentProject;
  if (!p || !p.selectedImagePath) { showToast('Pick an image first.', 'error'); return; }
  const modal = document.getElementById('variant-modal');
  if (!modal) return;
  const srcImg = document.getElementById('var-source-img');
  if (srcImg) srcImg.src = _toFileUrl(p.selectedImagePath) + (String(p.selectedImagePath).includes('?') ? '&' : '?') + 't=' + Date.now();
  const badge = document.getElementById('var-apply-cost-badge');
  if (badge) badge.textContent = document.getElementById('var-count')?.value || '1';
  _updateVarStrengthHint();
  modal.classList.remove('hidden');
});
document.getElementById('var-strength')?.addEventListener('input', (e) => {
  document.getElementById('var-strength-val').textContent = e.target.value + '%';
  _updateVarStrengthHint();
});
document.getElementById('var-count')?.addEventListener('input', (e) => {
  document.getElementById('var-count-val').textContent = e.target.value;
  const b = document.getElementById('var-apply-cost-badge');
  if (b) b.textContent = e.target.value;
});
const _varClose = () => document.getElementById('variant-modal')?.classList.add('hidden');
document.getElementById('var-cancel')?.addEventListener('click', _varClose);
document.getElementById('var-close-x')?.addEventListener('click', _varClose);
document.getElementById('var-apply')?.addEventListener('click', async () => {
  const p = state.currentProject;
  if (!p || !p.selectedImagePath) { showToast('Pick an image first.', 'error'); return; }
  const strength = (parseInt(document.getElementById('var-strength').value) || 50) / 100;
  const count = parseInt(document.getElementById('var-count').value) || 1;
  _varClose();
  const variantSource = p.selectedImagePath;
  const prompt = (p.prompt || p.initialPrompt) || 'variation';
  const job = (typeof pushJob === 'function')
    ? pushJob(`Variant${count > 1 ? 's' : ''}: ${p.name}`, null,
        { Variants: count, Variation: Math.round(strength * 100) + '%' }, 30000 * count, undefined,
        { sourceImageUrl: variantSource, projectName: p.name })
    : null;
  try {
    for (let i = 0; i < count; i++) {
      const r = await window.meshyAPI?.img2img({ imagePath: variantSource, prompt, strength });
      if (!r?.success) throw new Error(r?.error || 'img2img failed');
    }
    if (job && typeof completeJob === 'function') completeJob(job.id, true);
    if (typeof reloadCurrentProject === 'function') await reloadCurrentProject();
    showToast(`✓ ${count} variant${count > 1 ? 's' : ''} generated.`, 'success');
  } catch (e) {
    if (job && typeof completeJob === 'function') completeJob(job.id, false, e?.message || String(e));
    showToast('Variant failed: ' + (e?.message || e), 'error', 5000);
  }
});

document.getElementById('ws-multiview-btn')?.addEventListener('click', () => {
  const p = state.currentProject;
  if (!p || !p.selectedImagePath) { showToast('Pick an image first.', 'error'); return; }
  const modal = document.getElementById('modal-multiview-options');
  if (modal) modal.classList.remove('hidden');
});

document.getElementById('mv-opt-cancel')?.addEventListener('click', () => {
  document.getElementById('modal-multiview-options')?.classList.add('hidden');
});

// Show/hide the 6-view sub-options block depending on the mode select.
document.getElementById('mv-opt-mode')?.addEventListener('change', () => {
  const mode = document.getElementById('mv-opt-mode')?.value || '6view';
  const block = document.getElementById('mv-opt-6view-block');
  if (block) block.style.display = (mode === '6view') ? '' : 'none';
});

document.getElementById('mv-opt-start')?.addEventListener('click', async () => {
  const modal = document.getElementById('modal-multiview-options');
  if (modal) modal.classList.add('hidden');
  const p = state.currentProject;
  if (!p || !p.selectedImagePath) { showToast('Pick an image first.', 'error'); return; }
  const srcImgPath = p.previewImagePath || p.selectedImagePath;
  const mode = document.getElementById('mv-opt-mode')?.value || '6view';
  const harmonize = document.getElementById('mv-opt-harmonize')?.checked ?? true;
  const upscale   = document.getElementById('mv-opt-upscale')?.checked ?? false;

  // Step 1: duplicate the image into a new version. The new version
  // will host the multi-view dir / back photo; the original image stays
  // untouched so the user can compare or revert.
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

  // Step 2: dispatch based on selected mode.
  if (mode === '2view') {
    const expectedMs = 25000;
    const job = pushJob(`2-view back photo: ${p.name}`, null, {
      Image: (mvImagePath || '').split(/[\\/]/).pop(),
      Mode: '2-view (back photo)',
    }, expectedMs, undefined, { sourceImageUrl: mvImagePath, projectName: p.name });
    showToast('Generating back photo...', 'info', 5000);
    try {
      const rawPrompt = document.getElementById('ws-prompt')?.dataset.rawPrompt
                        || document.getElementById('ws-prompt')?.value || '';
      const bv = await window.meshyAPI.generateBackView({
        frontImage: mvImagePath, promptHint: rawPrompt, numImages: 1,
        assetType: document.getElementById('ws-asset-type')?.value || 'character',
      });
      if (bv?.success && bv.paths?.length) {
        showToast('Back photo ready', 'success');
        if (!p._backPhotos) p._backPhotos = {};
        p._backPhotos[mvImagePath] = bv.paths[0];
        if (job && typeof completeJob === 'function') completeJob(job.id, true);
        if (typeof reloadCurrentProject === 'function') await reloadCurrentProject();
      } else {
        const msg = bv?.error || 'unknown';
        showToast('Back photo failed: ' + msg, 'error', 5000);
        if (job && typeof completeJob === 'function') completeJob(job.id, false, msg);
      }
    } catch (e) {
      showToast('Back photo error: ' + e.message, 'error', 5000);
      if (job && typeof completeJob === 'function') completeJob(job.id, false, e.message);
    }
    return;
  }

  // 6-view mode
  const expectedMs = 70000 + (harmonize ? 30000 : 0) + (upscale ? 10000 : 0);
  const job = pushJob(`Multi-views: ${p.name}`, null, {
    Image: (mvImagePath || '').split(/[\\/]/).pop(),
    Mode: '6 views',
    Harmonize: harmonize ? 'yes' : 'no',
    Upscale: upscale ? 'yes' : 'no',
  }, expectedMs, undefined, { sourceImageUrl: mvImagePath, projectName: p.name });
  showToast('Generating 6 multi-views...', 'info', 5000);
  try {
    const result = await API.generateMultiview({
      imagePath: mvImagePath, harmonize, upscale, engine: 'mvadapter',  // Zero123++ retired (CC-BY-NC 4.0 weights — non-commercial). MV-Adapter is Apache 2.0.
    });
    if (result && result.success) {
      showToast('Multi-views generated!', 'success');
      if (!p._multiviews) p._multiviews = {};
      p._multiviews[mvImagePath] = result.outDir;
      if (job && typeof completeJob === 'function') completeJob(job.id, true);
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

function _showMultiviewBar(multiviewDir, availableViews) {
  const bar = document.getElementById('ws-multiview-bar');
  console.log('[mv-show] bar found?', !!bar, 'current classes:', bar?.className);
  if (!bar) return;
  bar.classList.remove('hidden');
  bar.dataset.dir = multiviewDir;
  bar.querySelectorAll('.mv-btn').forEach(b => b.classList.remove('mv-active'));
  // Dynamic visibility based on what views actually exist for this image.
  // availableViews is an array like ['front'] (1-view), ['front','back']
  // (2-view backview), or ['front','right','back','left','top','bottom']
  // (6-view sheet). When omitted, fall back to legacy heuristic: 2 views
  // (front+back) by default, all 6 if multiviewDir is set.
  let views = Array.isArray(availableViews) && availableViews.length
    ? availableViews.map(v => String(v).toLowerCase())
    : (multiviewDir ? ['front', 'right', 'back', 'left', 'top', 'bottom'] : ['front', 'back']);
  if (views.length <= 1) {
    bar.classList.add('hidden');
    console.log('[mv-show] only 1 view -> hiding bar');
    return;
  }
  const _viewSet = new Set(views);
  bar.querySelectorAll('.mv-btn').forEach(b => {
    const v = b.dataset.view;
    b.style.display = _viewSet.has(v) ? '' : 'none';
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
        imgEl.src = _toFileUrl(imgPath) + '?t=' + Date.now();
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
  const _strip = (window.__stripFilePrefix || ((s) => s));
  console.log('[mv-check] previewImagePath:', _strip(p?.previewImagePath), 'multiviews keys:', p?._multiviews ? Object.keys(p._multiviews) : 'none', 'backphotos:', p?._backPhotos ? Object.keys(p._backPhotos) : 'none');
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
    imgEl.src = _toFileUrl(imgPath) + '?t=' + Date.now();
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
    bones: true, // on by default — users land on a rig viewer wanting to see the skeleton; toggle off if they want plain mesh
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
        // Common + harmless: we now default state.bones=true so the rig viewer
        // shows the skeleton out-of-the-box, but the same toggle applies to
        // the lightbox / source-mesh viewers where there's no rig to render.
        // Demoted to debug to avoid alarming users opening a plain mesh.
        console.debug('[bones] no bones in this model (rig viewer with non-rigged mesh, or rig output missing skeleton)');
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
            mats.forEach(m => {
              m.transparent = false; m.opacity = 1.0;
              m.depthWrite = true; m.depthTest = true;
              if (m.alphaMap) m.alphaMap = null;
              if ('alphaTest' in m) m.alphaTest = 0;
              if ('transmission' in m) m.transmission = 0;
              if ('transmissionMap' in m) m.transmissionMap = null;
              if (m.map) { m.map.premultiplyAlpha = false; m.map.needsUpdate = true; }
              m.needsUpdate = true;
            });
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
      const url = _toFileUrl(meshPath);
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
  img.src = _toFileUrl(imgPath) + '?t=' + Date.now();
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
            if (lbImg) lbImg.src = _toFileUrl(viewPath) + '?t=' + Date.now();
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
  document.getElementById('lightbox-2-img').src = _toFileUrl(imgPath) + '?t=' + Date.now();
  // Also sync the SMALL preview so when the lightbox closes the
  // user sees the same view they were looking at.
  try {
    const smallPreview = document.getElementById('step1-preview');
    const smallImg = smallPreview?.querySelector('img');
    if (smallImg) {
      smallImg.src = _toFileUrl(imgPath) + '?t=' + Date.now();
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
    select:      'ws-select-btn',
    extend:      'ws-extend-btn',
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
                         'paint', 'crop', 'select', 'resolution'];
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
  document.getElementById('lightbox-2-img').src = _toFileUrl(path_) + '?t=' + Date.now();
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
// Anti-doubling tokens: RealVis XL tends to generate 2 instances of the
// subject in one frame when prompted with angle keywords ("three-quarter
// view", "angled side view") because vehicle/product photo datasets
// often pair two angles side-by-side. We now:
//  1. Force "strict front view" on subjects that 6-view MV-Adapter will
//     re-angle anyway (vehicle/prop/weapon/environment) — no angle in
//     source image, MV-Adapter does the work.
//  2. Pile up "ONE X only" / "single instance" tokens.
//  3. Negative prompt (local_juggernaut_bridge.py) blocks grid layouts.
const ASSET_TYPE_PROMPTS = {
  character: 'isolated 3D character, full body, fully clothed, wearing a complete outfit, dressed in appropriate clothing, T-pose neutral stance, arms extended horizontally, legs apart, strict front view, facing camera, symmetric, RTS unit game asset, plain white background, even studio lighting, no shadows, centered, clean silhouette, no text, no UI',
  building: 'architectural building exterior, complete edifice, isolated, full structure, plain white background, even studio lighting, no shadows, centered, strict front view, facing camera, clean silhouette, no text, no UI, not a village, not a town',
  vehicle: 'isolated, complete vehicle, plain white background, even studio lighting, no shadows, no characters, centered, strict front view, facing camera, clean silhouette, no text, no UI, no rear view inset',
  weapon: 'isolated, full weapon, plain white background, even studio lighting, no shadows, centered, side profile, clean silhouette, no text, no UI',
  prop: 'isolated, full item, plain white background, even studio lighting, no shadows, no characters, centered, strict front view, clean silhouette, no text, no UI',
  creature: '3D game asset reference sheet, full body character sheet, long shot, full figure shot, wide establishing shot, distant camera, entire creature visible from head to feet to tail, body fills 60 percent of frame, isolated, neutral stance, front view, facing camera, symmetric, plain white background, even studio lighting, no shadows, centered, clean silhouette, no text, no UI, NOT a portrait, NOT a headshot, NOT a close-up, NOT a head shot, NOT a face shot, NOT a bust shot',
  environment: 'isolated, full structure, plain white background, even studio lighting, no shadows, no characters, centered, strict front view, clean silhouette, no text, no UI',
  icon: 'flat icon, app icon, UI icon, isolated subject centered in square frame, transparent or pure white background, soft rim light, vibrant colors, clean silhouette, slight isometric 3/4 angle, glossy material, mobile / desktop application icon style, no text, no logo, no extra elements',
  avion: 'complete passenger aircraft, isolated, 3/4 isometric view, full body visible from nose to tail, both wings visible, tail fin visible, plain white background, even studio lighting, no shadows, no clouds, no horizon, no contrail, centered, clean silhouette, no text, no UI',
  bateau: 'complete boat, isolated, 3/4 isometric view, full body visible from bow to stern, hull and superstructure visible, plain white background, even studio lighting, no shadows, no water, no wake, no horizon, centered, clean silhouette, no text, no UI',
  animal: '3D game asset reference sheet, full body character reference, long shot, full figure shot, wide establishing shot, distant camera, entire animal visible from nose to tail to feet, body fills 60 percent of frame, full body lateral profile, all four feet flat on the ground, body horizontal parallel to floor, belly close to ground, four legs supporting the body from below, plain white background, even studio lighting, no shadows, NEVER bipedal, NEVER upright, NEVER standing on hind legs, NEVER humanoid posture, NEVER T-pose, NEVER cartoon mascot stance, no text, no UI, NOT a portrait, NOT a headshot, NOT a close-up, NOT a head shot, NOT a face shot, NOT a bust shot, NOT head and shoulders',
  insect: '3D game asset reference sheet, full body reference, long shot, full figure shot, distant camera, entire insect visible, body fills 60 percent of frame, isolated, exactly six legs in total, three legs on the left side and three legs on the right side, six legs and no more, anatomically correct insect leg count, segmented body with distinct head thorax and abdomen, hard exoskeleton, antennae, 3/4 isometric view, high three-quarter angle seen from above and to the side, all six legs clearly visible and separated, plain white background, even studio lighting, no shadows, NOT eight legs, NOT a spider, NOT an arachnid, no extra legs, no doubled legs, no duplicated legs, no overlapping duplicate limbs, no mirrored extra legs, NO tail, no fur, NOT a mammal, NOT a quadruped, no humanoid posture, NOT a front head-on view, NOT a portrait, NOT a close-up, NOT a headshot, no text, no UI',
  custom: '',
  other_living:  'full body, isolated, plain white background, even studio lighting, no shadows, centered, strict front view, facing camera, clean silhouette, no text, no UI',
  other_vehicle: 'complete vehicle, isolated, plain white background, even studio lighting, no shadows, no characters, centered, strict front view, facing camera, clean silhouette, no text, no UI',
  other_built:   'full structure, isolated, plain white background, even studio lighting, no shadows, no characters, centered, strict front view, clean silhouette, no text, no UI',
  other_item:    'ONE item only, single item, only one instance, isolated, full item, plain white background, even studio lighting, no shadows, no characters, centered, strict front view, clean silhouette, no text, no UI, no duplicate, no second item',
};

const ASSET_STYLE_PROMPTS = {
  realistic:    'realistic style, photorealistic, sharp details, detailed materials',
  stylized:     'stylized art, mid-poly game asset, hand-painted textures, fantasy game style',
  lowpoly:      'low-poly 3D art, flat-shaded, faceted geometry, minimalist, geometric shapes, vibrant colors',
  cartoon:      'cartoon style, bold outlines, cel-shading, vibrant flat colors, expressive shapes',
  anime:        'anime style, soft cel-shading, expressive features, japanese animation aesthetic',
  pixelart:     'pixel art style, 16-bit retro game aesthetic, limited palette, sharp pixel edges',
  painterly:    'painterly style, brushstroke textures, hand-painted concept art look',
  pbr:          'PBR materials, ultra detailed, 8k textures, high-poly cinematic quality, film-grade lighting',
  voxel:        'voxel art, minecraft-inspired blocky 3D style, cubic geometry, clean voxels',
  'stylized-pbr':'stylized PBR, Overwatch and Fortnite style, hand-painted shading on PBR maps, clean game asset',
  'hand-painted':'hand-painted texture, WoW-style stylized, painterly diffuse, no realistic PBR maps, vibrant',
  ghibli:       'Studio Ghibli style, soft anime, gentle warm palette, hand-drawn animation, expressive nature',
  pixar:        'Pixar 3D animated movie, clean stylized 3D, family-friendly polish, expressive characters',
  comic:        'comic book style, ink outlines, halftone shading, bold saturated colors, dynamic poses',
  'dark-fantasy':'dark fantasy, gothic grimdark, dramatic chiaroscuro lighting, weathered ornate detail, brooding',
  cyberpunk:    'cyberpunk sci-fi, neon accents, futuristic mechanical detail, gritty urban',
  steampunk:    'steampunk, brass copper rivets, victorian mechanical, leather and gears, ornate clockwork',
  minecraft:    'Minecraft blocky low-fi, cubic geometry, pixelated 16x16 texture, voxel inspired',
  watercolor:   'watercolor painting, soft pigment washes, paper texture, gentle bleeding edges',
  concept:      'concept art, rough painterly, dramatic lighting, production design, key art quality',
  sketch:       'pencil sketch, line art, graphite shading, minimal color, hand-drawn',
  claymation:   'claymation, plasticine model, soft stop-motion surface, Aardman style, handmade charm',
  synthwave:     'synthwave vaporwave, retro 80s neon, purple and cyan gradients, chrome grid glow',
  horror:        'horror creepy, dark unsettling atmosphere, eerie grim, weathered decay',
  chrome:        'polished chrome metal, mirror reflections, liquid metal surface, glossy',
  marble:        'marble statue, carved stone sculpture, veined polished white marble',
  'carved-wood':   'carved wood, natural wood grain, hand-carved artisan woodwork',
  'stained-glass': 'stained glass, colored glass panels, dark lead outlines, luminous backlit',
  holographic:   'holographic iridescent, rainbow sheen, pearlescent shimmer, prismatic',
  figurine:      'toy figurine, glossy molded plastic, collectible model, smooth vinyl',
  graffiti:      'graffiti street art, spray paint, vibrant urban colors, bold outlines',
  'art-deco':      'art deco, geometric gold ornament, elegant symmetrical 1920s luxury',
  custom:       '',
};

// Each step has a single fixed engine, so don't show the ENGINE field at all
// (parity with desktop). Keep the hidden <select> in the DOM — generators
// still read its .value — and just hide the row / label.
(function _hideFixedEngineFields() {
  // Same list as desktop _hideFixedEngineFields — NOT ws-anim-engine, which
  // has multiple (some disabled) options and stays a real dropdown.
  ['ws-3d-engine', 'ws-rig-engine', 'mod-engine'].forEach((id) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    if (sel.options && sel.options.length > 1) return;  // a real choice → keep it
    const row = sel.closest('.form-row');
    if (row) { row.style.display = 'none'; return; }
    // Modal case (no .form-row): hide the select + a preceding engine-static
    // box + the label right before it.
    sel.style.display = 'none';
    let prev = sel.previousElementSibling;
    if (prev && prev.classList && prev.classList.contains('engine-static')) {
      prev.style.display = 'none';
      prev = prev.previousElementSibling;
    }
    if (prev && prev.tagName === 'LABEL') prev.style.display = 'none';
  });
})();

// Category PREFIXES (ported from desktop) — lead with the category so a
// dominant noun in the user's text (e.g. "robot house") doesn't win the early,
// higher-weighted SDXL tokens and render a FIGURE instead of the building.
const ASSET_TYPE_PREFIXES = {
  building:    'an architectural building, a complete standalone structure',
  environment: 'an architectural structure',
};

function buildFullPrompt(userPrompt, assetType, assetStyle) {
  const typePrefix = ASSET_TYPE_PREFIXES[assetType] || '';
  const typeSuffix = ASSET_TYPE_PROMPTS[assetType] || '';
  const stylePrefix = ASSET_STYLE_PROMPTS[assetStyle] || '';
  const parts = [stylePrefix, typePrefix, userPrompt, typeSuffix].filter(Boolean);
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
    ...Object.values(ASSET_TYPE_PREFIXES),
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
  // Token-level pass: kill any leftover canonical tokens from previous
  // template versions (legacy projects don't match the exact current
  // template strings, but the individual tokens still pollute the user
  // textarea and end up doubled with the new template at gen time).
  const KNOWN_TOKENS = [
    // angle keywords (any version)
    'three-quarter view', 'three quarter view', '3/4 view',
    'angled side view', 'angled view', 'isometric three-quarter view',
    'isometric three-quarter', 'isometric angle', 'isometric view',
    'side view', 'side profile', 'strict front view', 'front view',
    'facing camera',
    // isolation / dedup tokens
    'single isolated 3D character', 'single isolated 3D building',
    'single isolated 3D vehicle', 'single isolated 3D weapon',
    'single isolated 3D prop', 'single isolated 3D creature',
    'single isolated 3D environment piece',
    'one single character', 'one single building', 'one single vehicle',
    'one single weapon', 'one single prop', 'one single creature',
    'one single environment piece',
    'ONE car only', 'ONE building only', 'ONE weapon only',
    'ONE prop only', 'ONE creature only', 'ONE environment piece only',
    'one character only', 'single vehicle', 'only one instance',
    'single instance', 'isolated', 'complete vehicle',
    // staging / lighting / framing
    'plain white background', 'even studio lighting', 'no shadows',
    'no characters', 'no other characters', 'no other creatures',
    'centered', 'clean silhouette', 'no text', 'no UI',
    'full body', 'full structure', 'full weapon', 'full item',
    // dedup negatives (sometimes leak into positive)
    'no duplicate', 'no second car', 'no second building',
    'no twin', 'no rear view inset',
    // T-pose tokens (legacy character)
    'T-pose neutral stance', 'arms extended horizontally', 'legs apart',
    'symmetric', 'RTS unit game asset', 'neutral stance',
    // style tokens (any version)
    'realistic style', 'photorealistic', 'sharp details',
    'detailed materials',
  ];
  for (const tok of KNOWN_TOKENS) {
    const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|,\\s*)' + esc + '(?=$|,\\s*)', 'gi');
    txt = txt.replace(re, (_, sep) => '');
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
  const rawTextarea = document.getElementById('ws-prompt').value.trim();
  if (!rawTextarea) { showToast('Type a description first.', 'error'); return; }
  // Strip any leftover enrichment from a previous template version so
  // buildFullPrompt() doesn't pile up legacy tokens on top of the
  // current template (e.g. user textarea still has the old
  // "angled side view" from an earlier session — without this strip,
  // the next gen would receive both that AND the new "strict front
  // view", triggering RealVis's 2-cars hallucination).
  const userPrompt = stripKnownPromptSuffixes(rawTextarea);
  const assetType = document.getElementById('ws-asset-type')?.value || 'character';
  const assetStyle = document.getElementById('ws-asset-style')?.value || 'realistic';
  // Persist per-project so the next visit to this project pre-fills the
  // form with the asset type/style used here (avoid Creature project
  // silently falling back to Character on a follow-up gen).
  _saveProjectMeta(p.name, { assetType, assetStyle });
  const prompt = buildFullPrompt(userPrompt, assetType, assetStyle);
  const engine = document.getElementById('ws-engine').value;
  const count = parseInt(document.getElementById('ws-count').value) || 4;
  const steps = parseInt(document.getElementById('ws-quality').value) || 30;
  // Extra views: auto-determined from the active asset type. The old
  // user-facing dropdown was removed 2026-05-20 — instead we pick the
  // right scope automatically since:
  //   - hard-surface assets (vehicle/building/weapon/prop/env) get
  //     unreliable back-photos from the sheet generator, so we skip the
  //     back-gen entirely (front_only).
  //   - humanoids/creatures benefit from a back photo for texturing,
  //     so we run the back-gen IPC (front_back).
  //   - front_full (6-view sheet) is no longer auto-selected since
  //     TRELLIS-2 multi-image cond is gated behind FABMESH_USE_EXTRA_VIEWS
  //     and produces siamese meshes when on.
  let mvScope = document.getElementById('ws-mv-scope')?.value || 'auto';
  if (mvScope === 'auto') {
    const at = document.getElementById('ws-asset-type')?.value || 'character';
    if (at === 'character' || at === 'creature' || at === 'animal') {
      mvScope = 'front_back';
    } else {
      mvScope = 'front_only';
    }
  }
  const multiView = (mvScope !== 'front_only');
  const mvForceFull = (mvScope === 'front_full');
  const mv6view = false; // 6-view sheet flow is replaced by mvScope
  const mv6Harmonize = true;
  const mv6Upscale = false;
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
      'Multi-view': mv6view ? '6 views' : (multiView ? '2 views (back)' : 'no'),
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
            showToast('Generating back photos...', 'info', 10000);
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
                assetType: document.getElementById('ws-asset-type')?.value || 'character',
                // sheetViews: 2 for "front + back", 6 for "front + back +
                // sides + bottom". Forwarded to multiview_sheet_gen.py
                // via env so the SDXL prompt asks for the right grid.
                sheetViews: mvForceFull ? 6 : 2,
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
            showToast('Generating 6 views...', 'info', 8000);
            for (const imgPath of r.images) {
              const mvRes = await API.generateMultiview({
                imagePath: imgPath,
                harmonize: mv6Harmonize,
                upscale: mv6Upscale,
                engine: 'mvadapter',  // Zero123++ retired (CC-BY-NC 4.0 weights — non-commercial). MV-Adapter is Apache 2.0.
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
        // Force-await the version strip render so the new thumbnail
        // appears before the scroll/pulse animation runs. Without this
        // populateWorkspace fires renderImageVersions in the background
        // and the user can see the strip stuck on the previous state.
        if (state.currentProject) {
          try {
            await renderImageVersions(state.currentProject);
            const _firstImg = state.currentProject.images?.[0];
            const _firstPath = (typeof _firstImg === 'string') ? _firstImg : _firstImg?.path;
            console.log('[image-gen] post-reload strip rendered, images=',
                        state.currentProject.images?.length,
                        'first=', _firstPath);
          } catch (e) { console.warn('[image-gen] strip render failed:', e); }
        }
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
        Regenerates the back view via MyFabmesh.AI Photoreal + Identity preservation + Pose guide
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
        assetType: document.getElementById('ws-asset-type')?.value || 'character',
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
// Explain how Strength behaves — high values regenerate so much that the
// original subject (e.g. a catapult) can drift into something else (a car).
function _updateModStrengthHint() {
  const el = document.getElementById('mod-strength-hint');
  if (!el) return;
  const v = parseInt(modStrength.value);
  let t;
  if (v <= 45) t = 'Low (30–45%) — keeps the subject & composition, only adds/edits fine detail.';
  else if (v <= 65) t = 'Medium (46–65%) — clear changes while keeping the same subject (recommended for "add X").';
  else if (v <= 80) t = 'High (66–80%) — strong transformation; the subject may start to drift.';
  else t = '⚠ Very high (81–95%) — near full re-generation. The original subject can be lost (a catapult can turn into a car). Lower it to keep the shape.';
  el.textContent = t;
}
modStrength.addEventListener('input', () => {
  modStrengthVal.textContent = modStrength.value + '%';
  _updateModStrengthHint();
});

document.getElementById('ws-modify-btn').addEventListener('click', () => {
  const p = state.currentProject;
  const target = editTarget(p);
  if (!target) { showToast('Pick an image first.', 'error'); return; }
  // Show the source image inside the modal
  const srcImg = document.getElementById('mod-source-img');
  if (srcImg) srcImg.src = _toFileUrl(target) + '?t=' + Date.now();
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
  const modifySource = target;
  const modifyProject = p.name;
  gatedRun('img2img', `Modify image: ${p.name}`, async () => {
    const job = pushJob(`Modify image: ${p.name}`, null, {
      Engine: engineLabel(engine),
      Strength: `${Math.round(strength * 100)}%`,
      Prompt: prompt,
    }, modifyExpected, undefined, { sourceImageUrl: modifySource, projectName: modifyProject });
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

// Image-side LICENCE bodies — mirror EXPORT_LICENCES (defined later
// for the mesh modal). Repeated here so the image export can ship
// the LICENSE.txt sidecar with the right text per licence.
const EXPORT_LICENCES_IMAGE = {
  personal:   'This image is licensed for personal, non-commercial use by the original purchaser only. Redistribution, resale, sublicensing, or use in commercial products is not permitted without explicit written permission.',
  cc0:        'This image is released into the public domain under Creative Commons CC0 1.0 Universal. You may copy, modify, distribute, and use it freely, including for commercial purposes, without asking permission. See https://creativecommons.org/publicdomain/zero/1.0/',
  'cc-by':    'This image is licensed under Creative Commons Attribution 4.0 International (CC-BY 4.0). You may share and adapt it for any purpose, including commercial, provided you give appropriate credit to the original author. See https://creativecommons.org/licenses/by/4.0/',
  'cc-by-nc': 'This image is licensed under Creative Commons Attribution-NonCommercial 4.0 International (CC-BY-NC 4.0). You may share and adapt it for non-commercial purposes only, with attribution. Commercial use is not permitted. See https://creativecommons.org/licenses/by-nc/4.0/',
  commercial: 'This image is licensed for royalty-free commercial use by the original purchaser. You may use it in unlimited commercial projects, but redistribution or resale of the image itself (standalone or as part of a marketplace pack) is not permitted.',
};
const LICENCE_LABELS_IMAGE = {
  personal: 'Personal use only', cc0: 'Public domain (CC0)',
  'cc-by': 'CC-BY 4.0', 'cc-by-nc': 'CC-BY-NC 4.0', commercial: 'Royalty-free commercial',
};

document.getElementById('ws-export-img-btn')?.addEventListener('click', () => {
  const p = state.currentProject;
  const target = editTarget(p);
  if (!target) { showToast('Pick an image first.', 'error'); return; }
  const modal = document.getElementById('modal-export-image');
  const baseName = (p.name || 'image') + '_' + (target.split(/[\\/]/).pop().replace(/\.[^.]+$/, ''));
  document.getElementById('expimg-path').value = '';
  document.getElementById('expimg-path').placeholder = `Downloads/${baseName}.<ext>`;
  modal.classList.remove('hidden');
});
document.getElementById('expimg-cancel')?.addEventListener('click', () => {
  document.getElementById('modal-export-image').classList.add('hidden');
});
// Quality slider only relevant for lossy formats (JPG/WebP).
(function _wireExpimgFormat() {
  const fmt = document.getElementById('expimg-format');
  const qLabel = document.getElementById('expimg-quality-label');
  const qInput = document.getElementById('expimg-quality');
  const qVal   = document.getElementById('expimg-quality-val');
  if (!fmt) return;
  const sync = () => {
    const lossy = fmt.value === 'jpg' || fmt.value === 'webp';
    qLabel.style.display = lossy ? '' : 'none';
    qInput.style.display = lossy ? '' : 'none';
  };
  fmt.addEventListener('change', sync);
  qInput?.addEventListener('input', () => { qVal.textContent = qInput.value + '%'; });
  sync();
})();
document.getElementById('expimg-browse')?.addEventListener('click', async () => {
  const p = state.currentProject;
  const target = editTarget(p);
  if (!target) return;
  const format = document.getElementById('expimg-format').value;
  const defaultName = (p.name || 'image') + '_' + (target.split(/[\\/]/).pop().replace(/\.[^.]+$/, ''));
  if (!API.pickExportPath) return;
  const picked = await API.pickExportPath({ defaultName, format });
  const pickedPath = typeof picked === 'string'
    ? picked
    : (picked && typeof picked === 'object' && picked.path) ? picked.path : '';
  if (pickedPath) document.getElementById('expimg-path').value = pickedPath;
});
document.getElementById('expimg-go')?.addEventListener('click', async () => {
  const p = state.currentProject;
  const target = editTarget(p);
  if (!target) return;
  const format = document.getElementById('expimg-format').value;
  const quality = Math.max(0.5, Math.min(1.0, Number(document.getElementById('expimg-quality').value) / 100));
  const licenceKey = document.getElementById('expimg-licence')?.value || 'personal';
  const baseName = (p.name || 'image') + '_' + (target.split(/[\\/]/).pop().replace(/\.[^.]+$/, ''));
  document.getElementById('modal-export-image').classList.add('hidden');
  const job = pushJob(`Export image (${format}): ${p.name}`, null, {
    Licence: LICENCE_LABELS_IMAGE[licenceKey] || licenceKey,
  });
  try {
    // Format-transcode via canvas before downloading. PNG keeps
    // alpha, JPG flattens onto white, WebP uses the same encoder
    // as Chromium's canvas API.
    const r = await fetch(target);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob();
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = URL.createObjectURL(blob);
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (format === 'jpg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(img.src);
    const mime = format === 'png' ? 'image/png' : format === 'jpg' ? 'image/jpeg' : 'image/webp';
    const outBlob = await new Promise((res) => canvas.toBlob(res, mime, quality));
    if (!outBlob) throw new Error('canvas.toBlob returned null');
    const fileName = baseName + '.' + format;
    // Trigger download
    const url = URL.createObjectURL(outBlob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    // Sibling LICENSE.txt
    const licTxt = `${LICENCE_LABELS_IMAGE[licenceKey] || licenceKey}\n\n${EXPORT_LICENCES_IMAGE[licenceKey] || ''}\n\nExported ${new Date().toISOString()} via MyFabmesh.AI.`;
    const licBlob = new Blob([licTxt], { type: 'text/plain' });
    const licUrl = URL.createObjectURL(licBlob);
    const la = document.createElement('a');
    la.href = licUrl; la.download = baseName + '_LICENSE.txt';
    document.body.appendChild(la); la.click(); la.remove();
    setTimeout(() => URL.revokeObjectURL(licUrl), 1500);
    completeJob(job.id, true);
    showToast('✓ Image exported as ' + format.toUpperCase(), 'success');
  } catch (e) {
    completeJob(job.id, false);
    customError(e?.message || String(e), 'Export image failed');
  }
});

document.getElementById('ws-removebg-btn').addEventListener('click', async () => {
  const p = state.currentProject;
  const target = editTarget(p);
  if (!target) { showToast('Pick an image first.', 'error'); return; }
  const removeBgSource = target;
  const removeBgProject = p.name;
  gatedRun('bg', `Remove background: ${p.name}`, async () => {
    const job = pushJob(`Remove background: ${p.name}`, null, null, undefined, undefined, {
      sourceImageUrl: removeBgSource, projectName: removeBgProject,
    });
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
document.getElementById('ws-select-btn')?.addEventListener('click', () => {
  const p = state.currentProject;
  const target = editTarget(p);
  if (!target) { showToast('Pick an image first.', 'error'); return; }
  window.openSelectToolFor(target, p.name, async () => {
    await reloadCurrentProject();
  });
});

// ----------- New image tools -----------

// Helper: run a quick image edit via Python PIL and reload the project
const QUICK_EDIT_EXPECTED_MS = {
  crop:       4000,
  brightness: 4000,
  blur:       4000,
  upscale:    20000,
  paint:      4000,
};

async function runQuickEdit(operation, params) {
  const p = state.currentProject;
  const target = editTarget(p);
  if (!target) { showToast('Pick an image first.', 'error'); return; }
  const expectedMs = QUICK_EDIT_EXPECTED_MS[operation] || 6000;
  const imgName = String(target).split(/[\\/]/).pop();
  const job = (typeof pushJob === 'function')
    ? pushJob(`${operation}: ${p.name}`, null, { Image: imgName }, expectedMs)
    : null;
  try {
    const r = await API.imageQuickEdit({ imagePath: target, operation, params });
    if (r?.success) {
      if (job && typeof completeJob === 'function') completeJob(job.id, true);
      showToast(`${operation} done`, 'success');
      await reloadCurrentProject();
    } else {
      const msg = r?.error || 'unknown';
      if (job && typeof completeJob === 'function') completeJob(job.id, false, msg);
      showToast(`${operation} failed: ${msg}`, 'error', 5000);
    }
  } catch (e) {
    if (job && typeof completeJob === 'function') completeJob(job.id, false, e.message);
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
  const onReady = (img) => {
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
  const loadFrom = (finalSrc) => {
    const img = new Image();
    img.onload = () => onReady(img);
    img.onerror = () => showToast('symmetrize: image load failed (' + finalSrc.slice(0, 80) + ')', 'error', 5000);
    img.src = finalSrc;
  };
  // Cloud port: imgPath is now an http(s) URL on cloud (R2) — the
  // legacy `file:///...` prefix produces file:///https:/... which
  // silently fails. Fetch to blob: bypasses CORS + canvas-tainting +
  // gives us a real onerror.
  const src = symState.imgPath;
  if (/^(?:https?|blob|data):/i.test(src)) {
    if (/^https?:/i.test(src)) {
      // Route via /api/proxy-image — same-origin → no CORS.
      const proxied = '/api/proxy-image?url=' + encodeURIComponent(src);
      fetch(proxied, { credentials: 'omit' })
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
        .then(blob => loadFrom(URL.createObjectURL(blob)))
        .catch(e => showToast('symmetrize: fetch failed: ' + (e?.message || e), 'error', 5000));
    } else {
      loadFrom(src);
    }
  } else {
    // Desktop filesystem path.
    loadFrom(_toFileUrl(src) + '?t=' + Date.now());
  }
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
  symState.erasing = false;  // default to Paint each time Mask mode is entered
  document.getElementById('sym-mode-mask')?.classList.add('tool-active');
  document.getElementById('sym-mode-full')?.classList.remove('tool-active');
  document.getElementById('sym-paint-mode')?.classList.add('tool-active');
  document.getElementById('sym-erase-mode')?.classList.remove('tool-active');
  document.getElementById('sym-brush-label').style.display = 'flex';
  _symDrawPreview();
});

// Paint / Erase toggle (Mask mode): paint adds to the mask, erase removes it.
document.getElementById('sym-paint-mode')?.addEventListener('click', () => {
  symState.erasing = false;
  document.getElementById('sym-paint-mode')?.classList.add('tool-active');
  document.getElementById('sym-erase-mode')?.classList.remove('tool-active');
});
document.getElementById('sym-erase-mode')?.addEventListener('click', () => {
  symState.erasing = true;
  document.getElementById('sym-erase-mode')?.classList.add('tool-active');
  document.getElementById('sym-paint-mode')?.classList.remove('tool-active');
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
        // Erase mode clears the mask (0), paint mode selects it (255).
        symState.maskData[py * w + px] = symState.erasing ? 0 : 255;
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
  _closeSym();
  const p = state.currentProject;
  const imgName = String(symState.imgPath).split(/[\\/]/).pop();
  const job = (typeof pushJob === 'function')
    ? pushJob(`Symmetrize: ${p?.name || ''}`, null, { Image: imgName }, 5000)
    : null;
  try {
    const dataUrl = canvas.toDataURL('image/png');
    const r = await API.saveImageDataUrl({
      imagePath: symState.imgPath,
      dataUrl: dataUrl,
      suffix: 'symmetrized',
    });
    if (r?.success) {
      if (job && typeof completeJob === 'function') completeJob(job.id, true);
      showToast('Symmetrized!', 'success');
      await reloadCurrentProject();
    } else {
      const msg = r?.error || 'unknown';
      if (job && typeof completeJob === 'function') completeJob(job.id, false, msg);
      showToast('Save failed: ' + msg, 'error');
    }
  } catch (e) {
    if (job && typeof completeJob === 'function') completeJob(job.id, false, e.message);
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
  preview.src = _toFileUrl(tgt) + '?t=' + Date.now();
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
  const p = state.currentProject;
  const tgt = editTarget(p);
  if (!tgt) return;
  const nw = Math.round(_resW / 2), nh = Math.round(_resH / 2);
  const imgName = String(tgt).split(/[\\/]/).pop();
  const job = (typeof pushJob === 'function')
    ? pushJob(`Downscale: ${p?.name || ''}`, null, { Image: imgName, From: `${_resW}x${_resH}`, To: `${nw}x${nh}` }, 4000)
    : null;
  try {
    const r = await API.imageQuickEdit({ imagePath: tgt, operation: 'downscale', params: {} });
    if (r?.success) {
      if (job && typeof completeJob === 'function') completeJob(job.id, true);
      showToast('Downscale done', 'success');
      await reloadCurrentProject();
    } else {
      const msg = r?.error || 'unknown';
      if (job && typeof completeJob === 'function') completeJob(job.id, false, msg);
      showToast('Downscale failed: ' + msg, 'error');
    }
  } catch (e) {
    if (job && typeof completeJob === 'function') completeJob(job.id, false, e.message);
    showToast('Downscale error: ' + e.message, 'error');
  }
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
  preview.src = _toFileUrl(tgt) + '?t=' + Date.now();
  // Reset sliders
  ['brightness', 'contrast', 'saturation', 'sharpness'].forEach(k => {
    const sl = document.getElementById('bright-' + k);
    const val = document.getElementById('bright-' + k + '-val');
    if (sl) sl.value = '100';
    if (val) val.textContent = '100%';
  });
  // Live preview via CSS filter + SVG feConvolveMatrix for Sharpness
  // (CSS has no native sharpen, so we drive an SVG kernel from JS).
  const updatePreview = () => {
    const b = document.getElementById('bright-brightness').value / 100;
    const c = document.getElementById('bright-contrast').value / 100;
    const s = document.getElementById('bright-saturation').value / 100;
    const shPct = parseInt(document.getElementById('bright-sharpness').value, 10);
    // sharpness: 100 = no change, >100 = unsharp-mask, <100 = blur.
    // For values >100 we use a standard 4-neighbour sharpen kernel
    // with strength scaled from the % above 100 (0 → 1.5 strength
    // at 300 %). For values <100 we use a 3×3 box blur kernel mixed
    // back with identity by (1-pct).
    const matEl = document.getElementById('bright-sharpen-matrix');
    if (matEl) {
      if (shPct >= 100) {
        const k = (shPct - 100) / 200;   // 0..1
        const side = -k;
        const center = 1 + 4 * k;
        matEl.setAttribute('kernelMatrix',
          `0 ${side} 0 ${side} ${center} ${side} 0 ${side} 0`);
      } else {
        const k = (100 - shPct) / 100;   // 0..1
        const boxW = (1 / 9) * k;
        const center = 1 - k + boxW;
        matEl.setAttribute('kernelMatrix',
          `${boxW} ${boxW} ${boxW} ${boxW} ${center} ${boxW} ${boxW} ${boxW} ${boxW}`);
      }
    }
    preview.style.filter = `brightness(${b}) contrast(${c}) saturate(${s}) url(#bright-sharpen-filter)`;
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
  // Reset the SVG sharpen kernel to identity too — otherwise the
  // stale matrix from a previous session would still apply.
  const matEl = document.getElementById('bright-sharpen-matrix');
  if (matEl) matEl.setAttribute('kernelMatrix', '0 0 0 0 1 0 0 0 0');
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
document.getElementById('ws-facefix-btn')?.addEventListener('click', async () => {
  // Cloud-aware: prefer the real faceFixImage API when present (Modal
  // SDXL inpaint via OpenCV face detection), fall back to the
  // runQuickEdit('facefix') canvas version on desktop. Desktop never
  // wires faceFixImage.
  const p = state.currentProject;
  const target = editTarget(p);
  if (!target) { showToast('Pick an image first.', 'error'); return; }
  if (typeof window.meshyAPI?.faceFixImage !== 'function') {
    runQuickEdit('facefix');
    return;
  }
  // Wrap in pushJob so the user gets the same progress popup the
  // other AI tools show. Size the progress bar from the live
  // warm/cold hint (window.__modalExpectedSeconds, populated by
  // cloud-overrides.js _pollModalStatus). Falls back to 45s if the
  // hint hasn't loaded yet.
  const expectedMs = (window.__modalExpectedSeconds || 45) * 1000;
  const warmLabel = window.__modalWarm === false
    ? `Warming up AI (~${Math.round((window.__modalExpectedSeconds || 150) / 60)} min cold start)`
    : 'Cloud GPU (MyFabmesh.AI Refine)';
  const faceFixSource = target;
  const faceFixProject = p.name;
  gatedRun('img2img', `Face Fix: ${p.name}`, async () => {
    const job = pushJob(`Face Fix: ${p.name}`, null, {
      Engine: warmLabel,
      Detection: 'OpenCV Haar (face)',
      Cost: '2 credits',
    }, expectedMs, undefined, { sourceImageUrl: faceFixSource, projectName: faceFixProject });
    try {
      const r = await window.meshyAPI.faceFixImage({ imagePath: target });
      if (r?.success) {
        completeJob(job.id, true);
        await reloadCurrentProject();
      } else {
        completeJob(job.id, false, r?.error || 'unknown');
        if (!job.cancelled) reportPipelineError(r?.error, 'Face Fix failed');
      }
    } catch (e) {
      completeJob(job.id, false, e?.error || e?.message || String(e));
      if (!job.cancelled) reportPipelineError(e?.error || e?.message || String(e), 'Face Fix error');
    }
  });
});
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
  img.src = _toFileUrl(cropState.imgPath) + '?t=' + Date.now();
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
    cropState.x1 = 0.1; cropState.y1 = 0.1; cropState.x2 = 0.9; cropState.y2 = 0.9;
    cropState.aspect = null;
  } else if (typeof aspect === 'number' && aspect > 0) {
    const W = cropState.w, H = cropState.h;
    if (W && H) {
      let cwn = 0.9;
      let chn = (cwn * W) / (H * aspect);
      if (chn > 0.9) { chn = 0.9; cwn = (chn * H * aspect) / W; }
      cropState.x1 = (1 - cwn) / 2;
      cropState.x2 = (1 + cwn) / 2;
      cropState.y1 = (1 - chn) / 2;
      cropState.y2 = (1 + chn) / 2;
    }
  }
  _cropDrawOverlay();
  _cropUpdateLabel();
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
// Per-project metadata (asset type + style) saved in localStorage so the
// next visit to the project pre-fills the dropdowns with the values used
// during the project's first generation. Without this the form falls
// back to default 'character / realistic' even when the project is
// clearly a creature/animal.
function _saveProjectMeta(projName, meta) {
  if (!projName || !meta) return;
  try {
    const key = 'fabmesh-project-meta';
    const map = JSON.parse(localStorage.getItem(key) || '{}');
    map[projName] = { ...(map[projName] || {}), ...meta };
    localStorage.setItem(key, JSON.stringify(map));
  } catch (_) {}
}

function _getProjectMeta(projName) {
  if (!projName) return null;
  try {
    const key = 'fabmesh-project-meta';
    const map = JSON.parse(localStorage.getItem(key) || '{}');
    return map[projName] || null;
  } catch (_) { return null; }
}

function _restoreProjectMeta(p) {
  if (!p?.name) return;
  const meta = _getProjectMeta(p.name);
  if (!meta) return;
  const atSel = document.getElementById('ws-asset-type');
  if (atSel && meta.assetType) {
    atSel.value = meta.assetType;
    atSel.dispatchEvent(new Event('change'));
  }
  const styleSel = document.getElementById('ws-asset-style');
  if (styleSel && meta.assetStyle) {
    styleSel.value = meta.assetStyle;
    styleSel.dispatchEvent(new Event('change'));
  }
}

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
  const styleSource = tgt;
  const styleProject = p.name;
  gatedRun('img2img', `Style: ${style.split(',')[0]}`, async () => {
    const job = pushJob(`Style Transfer: ${p.name}`, null, { Style: style.split(',')[0] }, 30000, undefined, {
      sourceImageUrl: styleSource, projectName: styleProject,
    });
    try {
      const r = await API.img2img({ imagePath: tgt, prompt: style, strength: 0.6, engine: 'local-sdxl' });
      if (r?.success) {
        // Remember which style was applied to this new image version.
        // Deliberately do NOT tag the source image — that would overwrite
        // the source version's own dropdown selection (desktop f37af87).
        if (r.newPath) _saveImageStyle(r.newPath, style);
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
  const loadFrom = (finalSrc) => {
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width; canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
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
    img.onerror = () => showToast('Color picker: load failed', 'error', 4000);
    img.src = finalSrc;
  };
  if (/^https?:/i.test(tgt)) {
    const proxied = '/api/proxy-image?url=' + encodeURIComponent(tgt);
    fetch(proxied, { credentials: 'omit' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
      .then(blob => loadFrom(URL.createObjectURL(blob)))
      .catch(e => showToast('Color picker: fetch failed: ' + (e?.message || e), 'error', 5000));
  } else if (/^(?:blob|data):/i.test(tgt)) {
    loadFrom(tgt);
  } else {
    loadFrom(_toFileUrl(tgt) + '?t=' + Date.now());
  }
});
(() => {
  const cpCanvas = document.getElementById('cpick-canvas');
  if (!cpCanvas) return;
  // Loupe: reuse the global #clone-loupe element (also used by Clone
  // Stamp / Draw Mask). Shows a 6× magnified ring around the pointer
  // with a crosshair at the sample pixel — same UX as Photoshop's
  // colour picker zoom.
  function _cpUpdateLoupe(e) {
    const loupeEl = document.getElementById('clone-loupe');
    const loupeCanvas = document.getElementById('clone-loupe-canvas');
    if (!loupeEl || !loupeCanvas) return;
    const lCtx = loupeCanvas.getContext('2d');
    const rect = cpCanvas.getBoundingClientRect();
    // The image can be non-square AND fit-letterboxed inside the
    // container, so width and height need their own scale factors.
    // Using sx for cy (the previous bug) skewed the loupe down by
    // the H/W ratio — visible as "the loupe shows the gloves when
    // I'm hovering the hand".
    const sx = cpCanvas.width / rect.width;
    const sy = cpCanvas.height / rect.height;
    const cx = Math.round((e.clientX - rect.left) * sx);
    const cy = Math.round((e.clientY - rect.top) * sy);
    const srcHalf = 20;  // ~6× zoom (120 / 20)
    lCtx.clearRect(0, 0, 120, 120);
    lCtx.save();
    lCtx.imageSmoothingEnabled = false;  // crisp per-pixel preview
    lCtx.beginPath(); lCtx.arc(60, 60, 58, 0, Math.PI * 2); lCtx.clip();
    lCtx.drawImage(cpCanvas,
                   cx - srcHalf, cy - srcHalf, srcHalf * 2, srcHalf * 2,
                   0, 0, 120, 120);
    // Crosshair at the sampled pixel.
    lCtx.strokeStyle = 'rgba(255,255,255,0.9)'; lCtx.lineWidth = 1;
    lCtx.beginPath();
    lCtx.moveTo(60, 50); lCtx.lineTo(60, 70);
    lCtx.moveTo(50, 60); lCtx.lineTo(70, 60);
    lCtx.stroke();
    // Tiny outline around the exact sampled pixel (3px box at zoom).
    lCtx.strokeStyle = 'rgba(0,0,0,0.6)';
    lCtx.strokeRect(57.5, 57.5, 5, 5);
    lCtx.restore();
    const container = document.getElementById('cpick-canvas-container');
    const cRect = (container || cpCanvas.parentElement).getBoundingClientRect();
    let lx = e.clientX + 20, ly = e.clientY - 140;
    if (lx + 120 > cRect.right) lx = e.clientX - 140;
    if (ly < cRect.top) ly = e.clientY + 20;
    if (lx < cRect.left) lx = cRect.left + 4;
    if (ly + 120 > cRect.bottom) ly = cRect.bottom - 124;
    loupeEl.style.left = lx + 'px';
    loupeEl.style.top  = ly + 'px';
    loupeEl.style.display = 'block';
  }
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
    _cpUpdateLoupe(e);
    return hex;
  }
  cpCanvas.addEventListener('mousemove', _cpSample);
  cpCanvas.addEventListener('mouseleave', () => {
    const cur = document.getElementById('cpick-cursor');
    if (cur) cur.style.display = 'none';
    const l = document.getElementById('clone-loupe');
    if (l) l.style.display = 'none';
  });
  cpCanvas.addEventListener('click', (e) => {
    const hex = _cpSample(e);
    navigator.clipboard.writeText(hex).catch(() => {});
    showToast(hex + ' copied!', 'success', 1500);
  });
})();
// Hide the shared loupe when the Color Picker modal closes — otherwise
// it can stay visible behind other modals.
['cpick-close', 'cpick-close-x'].forEach((id) => {
  document.getElementById(id)?.addEventListener('click', () => {
    const l = document.getElementById('clone-loupe');
    if (l) l.style.display = 'none';
  });
});
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
  // Load AFTER modal is visible so container has real dimensions.
  // Cloud-aware: pass http/blob/data URLs straight through (CanvasManager
  // fetches them as blob: to bypass CORS). file:/// only for local paths.
  const blurSrc = /^(?:https?|blob|data|file):/i.test(tgt)
    ? tgt
    : _toFileUrl(tgt);
  try {
    await _blurMgr.loadImage(blurSrc);
  } catch (e) {
    showToast('blur: image load failed: ' + (e?.message || e), 'error', 5000);
  }
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
  const imgName = String(tgt).split(/[\\/]/).pop();
  const job = (typeof pushJob === 'function')
    ? pushJob(`Blur brush: ${p?.name || ''}`, null, { Image: imgName }, 4000)
    : null;
  try {
    const dataUrl = bCanvas.toDataURL('image/png');
    const r = await API.saveImageDataUrl({ basePath: tgt, dataUrl, suffix: 'blur' });
    if (r?.success) {
      if (job && typeof completeJob === 'function') completeJob(job.id, true);
      showToast('Saved!', 'success');
      await reloadCurrentProject();
    } else {
      const msg = r?.error || 'unknown';
      if (job && typeof completeJob === 'function') completeJob(job.id, false, msg);
      showToast('Save failed: ' + msg, 'error');
    }
  } catch (e) {
    if (job && typeof completeJob === 'function') completeJob(job.id, false, e.message);
    showToast('Error: ' + e.message, 'error');
  }
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
  // Emissive layer mode: when true, every paint stroke is drawn on a
  // separate overlay canvas (paint-emissive-overlay) instead of the
  // main image. The overlay is persisted per source image so we can
  // project it onto the generated mesh's T_emissive map later.
  emissiveMode: false,
  emissiveOverlayInited: false,
  // Selection state
  selection: null,        // Uint8Array (w*h), 255=selected, 0=not — null means no selection (= all selected)
  selUndoStack: [],
  selRedoStack: [],
  wandLastPoint: null,    // {x,y} last wand click for re-select on tolerance change
  selRectStart: null,     // {x,y} for rect select drag
  selPreviewData: null,   // ImageData snapshot for rect select preview
  lassoPoints: null,      // [{x,y}, ...] for lasso
};

// Persistent emissive-layer cache keyed by image path. Lives at
// module scope (NOT on state.currentProject) so reloadCurrentProject
// after Save can't wipe it. Also persists across full page reloads
// via localStorage so the user can come back the next day.
const _emissiveLayerCache = new Map();
const _EMISSIVE_LS_KEY = 'fabmesh.emissiveLayers';
(function _loadEmissiveCache() {
  try {
    const raw = localStorage.getItem(_EMISSIVE_LS_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      Object.entries(obj).forEach(([k, v]) => _emissiveLayerCache.set(_emKey(k), String(v)));
    }
  } catch {}
})();
function _saveEmissiveCache() {
  try {
    const obj = {};
    _emissiveLayerCache.forEach((v, k) => { obj[k] = v; });
    localStorage.setItem(_EMISSIVE_LS_KEY, JSON.stringify(obj));
  } catch (e) {
    console.warn('[emissive] localStorage save failed:', e?.message || e);
  }
}
// Normalize path keys (backslash->slash + lowercase) so the 💡 badge matches
// across renamed / case-differing / R2-URL paths (desktop 9797d93).
function _emKey(p) {
  // Normalize so the 💡 badge matches across renamed / case-differing paths AND
  // R2 SIGNED URLs: drop the volatile ?signature / #fragment so the same object
  // keys identically regardless of the per-request signature (which changes on
  // every /api/meshes call). Without this, m.sourceImage (a signed URL) never
  // matched the painted image's cache key.
  return String(p == null ? '' : p)
    .replace(/\\/g, '/')
    .replace(/[?#].*$/, '')
    .toLowerCase();
}
function _emissiveLayerSet(imgPath, dataUrl) {
  _emissiveLayerCache.set(_emKey(imgPath), dataUrl);
  _saveEmissiveCache();
}
function _emissiveLayerGet(imgPath) {
  return _emissiveLayerCache.get(_emKey(imgPath)) || null;
}

// Parallel cache for MESHES that received emissive paint via the 3D
// Paint Mesh tool (the image-side _emissiveLayerCache wouldn't catch
// these). Stored as a Set of mesh paths in localStorage so the
// thumbnail badge survives reloads.
const _meshEmissivePaintedSet = new Set();
const _MESH_EMISSIVE_LS_KEY = 'fabmesh.meshEmissivePainted';
(function _loadMeshEmissiveSet() {
  try {
    const raw = localStorage.getItem(_MESH_EMISSIVE_LS_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) arr.forEach((p) => _meshEmissivePaintedSet.add(String(p)));
  } catch {}
})();
function _saveMeshEmissiveSet() {
  try {
    localStorage.setItem(_MESH_EMISSIVE_LS_KEY, JSON.stringify([..._meshEmissivePaintedSet]));
  } catch {}
}
function _meshEmissiveMark(meshPath) {
  _meshEmissivePaintedSet.add(String(meshPath));
  _saveMeshEmissiveSet();
}
function _meshEmissiveHas(meshPath) { return _meshEmissivePaintedSet.has(String(meshPath)); }
function _emissiveLayerHas(imgPath) {
  return _emissiveLayerCache.has(_emKey(imgPath));
}

// Sync the emissive overlay canvas size to match the main paint
// canvas, returning its 2D context. If a stored layer exists for
// this image, load it the first time we touch the overlay.
function _paintGetEmissiveCtx(mgr) {
  const overlay = document.getElementById('paint-emissive-overlay');
  if (!overlay) return null;
  const main = document.getElementById('paint-canvas');
  if (overlay.width !== main.width || overlay.height !== main.height) {
    overlay.width = main.width;
    overlay.height = main.height;
    overlay.style.width = main.style.width;
    overlay.style.height = main.style.height;
  }
  const ctx = overlay.getContext('2d');
  if (!paintState.emissiveOverlayInited) {
    paintState.emissiveOverlayInited = true;
    const saved = _emissiveLayerGet(paintState.imgPath);
    if (saved) {
      const img = new Image();
      img.onload = () => {
        try {
          ctx.clearRect(0, 0, overlay.width, overlay.height);
          ctx.drawImage(img, 0, 0, overlay.width, overlay.height);
        } catch {}
      };
      img.src = saved;
    }
  }
  return ctx;
}

// Show/hide the emissive overlay above the main image. Hidden when
// emissive mode is OFF so the user only sees their image; visible (with
// lighten blend) when ON so they can see what they're painting.
function _paintApplyEmissiveVisibility() {
  const overlay = document.getElementById('paint-emissive-overlay');
  if (!overlay) return;
  overlay.style.display = paintState.emissiveMode ? 'block' : 'none';
}

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
    // Hardness: 100% = crisp edge, lower = soft radial falloff.
    const hard = (paintState.hardness != null ? paintState.hardness : 100) / 100;
    if (hard >= 0.99 || r < 1.5) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const grad = ctx.createRadialGradient(x, y, Math.max(0, r * hard), x, y, r);
      grad.addColorStop(0, paintState.color);
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
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
// `outCtx` (optional): detect the region on `ctx` (the underlying image) but
// PAINT into a different canvas — used for emissive, so clicking a wall fills
// that wall's region on the emissive overlay instead of the diffuse image.
function _paintFloodFill(ctx, startX, startY, fillColor, tolerance, outCtx) {
  const w = _paintMgr.w, h = _paintMgr.h;
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;
  const sepOut = !!(outCtx && outCtx !== ctx);
  const outImg = sepOut ? outCtx.getImageData(0, 0, w, h) : imgData;
  const od = outImg.data;
  const idx = (startY * w + startX) * 4;
  const sr = data[idx], sg = data[idx+1], sb = data[idx+2], sa = data[idx+3];
  // Parse fill color
  const tmp = document.createElement('canvas'); tmp.width = 1; tmp.height = 1;
  const tc = tmp.getContext('2d'); tc.fillStyle = fillColor; tc.fillRect(0, 0, 1, 1);
  const fc = tc.getImageData(0, 0, 1, 1).data;
  const fr = fc[0], fg = fc[1], fb = fc[2];
  // Already same color? (only meaningful when painting back onto the same layer)
  if (!sepOut && Math.abs(sr - fr) + Math.abs(sg - fg) + Math.abs(sb - fb) < 3) return;
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
    if (sepOut) {
      // Paint the full colour at the chosen opacity onto the (transparent) layer.
      od[pi] = fr; od[pi+1] = fg; od[pi+2] = fb; od[pi+3] = Math.round(alpha * 255);
    } else {
      od[pi]   = Math.round(od[pi]   * (1 - alpha) + fr * alpha);
      od[pi+1] = Math.round(od[pi+1] * (1 - alpha) + fg * alpha);
      od[pi+2] = Math.round(od[pi+2] * (1 - alpha) + fb * alpha);
      od[pi+3] = 255;
    }
    stack.push([cx+1, cy], [cx-1, cy], [cx, cy+1], [cx, cy-1]);
  }
  (sepOut ? outCtx : ctx).putImageData(outImg, 0, 0);
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
          // paint.net-style live re-fill: snapshot the canvas BEFORE
          // we splat colour, store the click point + active mgr. While
          // the user stays in Fill mode, dragging the Tolerance /
          // Color / Opacity sliders restores the snapshot and re-runs
          // the fill at the same point so they can dial in the value.
          // In emissive mode, detect the region on the image but paint into
          // the emissive overlay (so Fill works for emissive too, not just
          // the brush).
          const rx = Math.round(x), ry = Math.round(y);
          const outCtx = paintState.emissiveMode ? _paintGetEmissiveCtx(mgr) : null;
          const snapCtx = outCtx || ctx;
          paintState.lastFill = {
            x: rx, y: ry,
            mgr,
            emissive: !!outCtx,
            snap: snapCtx.getImageData(0, 0, mgr.w, mgr.h),
          };
          _paintFloodFill(ctx, rx, ry, paintState.color, paintState.tolerance, outCtx);
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
      onPaint: (ctx, x, y, lastPt, mgr) => {
        // Redirect to the emissive overlay when in Emissive layer mode.
        // The overlay is initialised lazily on the first stroke; CanvasManager
        // ignores it for undo so we keep our own emissive-undo logic in step 2.
        const useEmissive = paintState.emissiveMode;
        const targetCtx = useEmissive ? _paintGetEmissiveCtx(mgr) : ctx;
        _paintStroke(targetCtx, x, y, lastPt, mgr);
      },
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
    const paintSrc = /^(?:https?|blob|data|file):/i.test(paintState.imgPath)
      ? paintState.imgPath
      : _toFileUrl(paintState.imgPath);
    _paintMgr.loadImage(paintSrc).catch(e => {
      showToast('paint: image load failed: ' + (e?.message || e), 'error', 5000);
    });
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
    // Switching away from Fill commits the last fill — clear the
    // snapshot so changing sliders later doesn't try to live-refill.
    if (paintState.tool === 'fill' && tool !== 'fill') paintState.lastFill = null;
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
  _paintLiveRefillIfFill();
});

// Hardness (Pen soft↔hard edge)
document.getElementById('paint-hardness')?.addEventListener('input', (e) => {
  paintState.hardness = parseInt(e.target.value);
  document.getElementById('paint-hardness-val').textContent = e.target.value + '%';
});

// Selection refine: Invert flips the current mask; None clears it.
document.getElementById('paint-sel-invert')?.addEventListener('click', () => {
  if (!paintState.selection) { showToast('No selection to invert.', 'info', 2000); return; }
  _paintPushSelUndo();
  const sel = paintState.selection;
  for (let i = 0; i < sel.length; i++) sel[i] = sel[i] === 255 ? 0 : 255;
  _paintShowSelection();
});
document.getElementById('paint-sel-none')?.addEventListener('click', () => {
  _paintClearSelection();
});

// Restore the snapshot we took before the last flood-fill and re-run
// the fill at the same point with the current tolerance/color/opacity.
// paint.net-style live tuning — works as long as the user stays in
// the Fill tool. Moving to a different tool clears `lastFill` and the
// previous fill becomes committed.
function _paintLiveRefillIfFill() {
  const lf = paintState.lastFill;
  if (!lf || paintState.tool !== 'fill' || !_paintMgr) return;
  const outCtx = lf.emissive ? _paintGetEmissiveCtx(_paintMgr) : null;
  const snapCtx = outCtx || _paintMgr.ctx;
  snapCtx.putImageData(lf.snap, 0, 0);
  _paintFloodFill(_paintMgr.ctx, lf.x, lf.y, paintState.color, paintState.tolerance, outCtx);
}

// Tolerance (for Fill / Wand) — re-run wand selection live OR re-run
// the last flood-fill if the Fill tool is active.
document.getElementById('paint-tolerance')?.addEventListener('input', (e) => {
  paintState.tolerance = parseInt(e.target.value);
  document.getElementById('paint-tolerance-val').textContent = e.target.value;
  if (paintState.tool === 'wand' && paintState.wandLastPoint && _paintMgr) {
    _paintWandSelect(_paintMgr.ctx, paintState.wandLastPoint.x, paintState.wandLastPoint.y, paintState.tolerance);
    _paintShowSelection();
  }
  _paintLiveRefillIfFill();
});

// Color picker — also re-runs the last Fill with the new colour.
document.getElementById('paint-color')?.addEventListener('input', (e) => {
  paintState.color = e.target.value;
  _paintLiveRefillIfFill();
});

// Eyedropper (pick from image)
document.getElementById('paint-eyedropper')?.addEventListener('click', () => {
  paintState.eyedropping = !paintState.eyedropping;
  document.getElementById('paint-eyedropper')?.classList.toggle('tool-active', paintState.eyedropping);
  const canvas = document.getElementById('paint-canvas');
  if (canvas) canvas.style.cursor = paintState.eyedropping ? 'crosshair' : 'none';
});

// 💡 Emissive layer mode — paint a separate layer that becomes the
// T_emissive map of the generated mesh (see Step 3, projection).
document.getElementById('paint-emissive-toggle')?.addEventListener('click', () => {
  paintState.emissiveMode = !paintState.emissiveMode;
  const btn = document.getElementById('paint-emissive-toggle');
  btn?.classList.toggle('tool-active', paintState.emissiveMode);
  // Pre-init the overlay so it picks up any saved layer for this image.
  if (paintState.emissiveMode && _paintMgr) _paintGetEmissiveCtx(_paintMgr);
  _paintApplyEmissiveVisibility();
  if (typeof showToast === 'function') {
    showToast(paintState.emissiveMode
      ? '💡 Emissive layer ON — strokes paint the T_emissive map'
      : 'Emissive layer OFF — back to image painting', 'info', 1800);
  }
});

// Recenter (fit-to-view): reset zoom + pan via CanvasManager.
document.getElementById('paint-recenter')?.addEventListener('click', () => {
  if (_paintMgr && typeof _paintMgr.recenter === 'function') _paintMgr.recenter();
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
  // Capture the emissive overlay BEFORE the modal closes (close()
  // hides the overlay and we'd otherwise lose access to its pixels).
  // Stored on the project keyed by source image path; Step 3 projects
  // this layer onto the generated mesh's T_emissive map.
  const overlay = document.getElementById('paint-emissive-overlay');
  if (overlay && overlay.width && overlay.height) {
    const p = state.currentProject;
    if (p) {
      // Only persist if the overlay actually has content (any non-zero
      // alpha pixel). Cheap stride sample to avoid full pixel scan.
      try {
        const ctx = overlay.getContext('2d');
        const samp = ctx.getImageData(0, 0, overlay.width, overlay.height).data;
        let hasInk = false;
        for (let i = 3; i < samp.length; i += 4) {
          if (samp[i] > 0) { hasInk = true; break; }
        }
        if (hasInk) {
          _emissiveLayerSet(paintState.imgPath, overlay.toDataURL('image/png'));
        }
      } catch {}
    }
  }
  const dataUrl = _paintMgr.toDataURL();
  _closePaint();
  const p = state.currentProject;
  const imgName = String(paintState.imgPath).split(/[\\/]/).pop();
  const job = (typeof pushJob === 'function')
    ? pushJob(`Paint: ${p?.name || ''}`, null, { Image: imgName }, 4000)
    : null;
  try {
    const result = await window.meshyAPI.saveImageDataUrl({
      basePath: paintState.imgPath, dataUrl, suffix: 'painted',
    });
    if (result && result.success) {
      if (job && typeof completeJob === 'function') completeJob(job.id, true);
      showToast('Painted version saved!', 'success');
      // Propagate the emissive layer to the new painted image path
      // so a mesh generated from "<img>_painted.png" still finds it.
      const newPath = result.path || result.newPath || result.url;
      const srcLayer = _emissiveLayerGet(paintState.imgPath);
      if (srcLayer && newPath) _emissiveLayerSet(newPath, srcLayer);
      if (state.currentProject) await reloadCurrentProject();
    } else {
      const msg = (result && result.error) || 'unknown';
      if (job && typeof completeJob === 'function') completeJob(job.id, false, msg);
      showToast('Save failed: ' + msg, 'error');
    }
  } catch (e) {
    if (job && typeof completeJob === 'function') completeJob(job.id, false, e.message);
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

// Remove EVERY workspace mesh from the scene (tagged __wsMesh) — defensive so
// a lost wsModel pointer (rapid switch / project change) can't leave an orphan
// mesh visible under the current one.
function _clearWsMeshes() {
  if (!wsScene) { wsModel = null; return; }
  const stale = [];
  wsScene.traverse(o => { if (o.userData && o.userData.__wsMesh) stale.push(o); });
  for (const o of stale) {
    wsScene.remove(o);
    o.traverse(c => {
      if (c.isMesh) {
        c.geometry?.dispose?.();
        const m = c.material;
        if (Array.isArray(m)) m.forEach(mm => mm?.dispose?.()); else m?.dispose?.();
      }
    });
  }
  wsModel = null;
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
  // Clear any previously-loaded mesh SYNCHRONOUSLY (before the await) so a
  // rapid version switch / project change can't leak a stale mesh.
  _clearWsMeshes();
  // Load the GLB
  setViewerLoading('step2-preview', true, 'Loading mesh…');
  console.log('[mesh-viewer] fetching mesh:', mesh.path);
  const buffer = await API.readMeshFile(mesh.path);
  if (!buffer) {
    setViewerLoading('step2-preview', false);
    console.error('[mesh-viewer] readMeshFile returned null for', mesh.path);
    return;
  }
  // Stale-request guard: user switched mesh while this was loading.
  if (state.currentProject && state.currentProject.previewMeshPath !== mesh.path) return;
  console.log('[mesh-viewer] buffer bytes:', buffer.byteLength);
  _clearWsMeshes();
  const loader = new GLTFLoader();
  loader.parse(buffer, '', (gltf) => {
    if (state.currentProject && state.currentProject.previewMeshPath !== mesh.path) return;
    _clearWsMeshes();   // last-moment cleanup for out-of-order parse callbacks
    setViewerLoading('step2-preview', false);
    console.log('[mesh-viewer] parse OK, scene children:', gltf.scene.children.length);
    wsModel = gltf.scene;
    wsModel.userData.__wsMesh = true;
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
      // Use FrontSide (default) so we cull the BACK faces — otherwise
      // when looking at the dragon from behind, the inside-out side
      // of the front-facing belly (painted red) shows through the
      // back, looking like fake transparency. Trellis2 occasionally
      // emits reversed-winding triangles which would show as black
      // voids with FrontSide; we accept a few dark patches over the
      // very confusing 'see-through painted texture' artefact.
      mat.side = THREE.FrontSide;
      // FORCE OPAQUE — applied UNCONDITIONALLY because Trellis2/SF3D
      // outputs commonly land with transparent=false BUT carry one of:
      //   - alphaMap texture        → cutout / see-through holes
      //   - alphaTest > 0           → fragment discard, looks like swiss cheese
      //   - transmission > 0        → PBR physical "glass"
      //   - the baseColor texture's alpha channel < 1 in some pixels →
      //     even with transparent=false, alphaTest=0, three.js may still
      //     mix in transparency if the canvas blend mode picks it up.
      // Real see-through materials (glass) aren't a primary use case here,
      // so default to opaque. If user needs transparency they can flip
      // the baseColor alpha in Material Adjust.
      mat.transparent = false;
      mat.opacity = 1.0;
      mat.depthWrite = true;
      mat.depthTest = true;
      if (mat.alphaMap)  mat.alphaMap = null;
      if ('alphaTest' in mat) mat.alphaTest = 0;
      // MeshPhysicalMaterial properties — if undefined the assigns are no-ops.
      if ('transmission' in mat)      mat.transmission = 0;
      if ('thickness' in mat)         mat.thickness = 0;
      if ('transmissionMap' in mat)   mat.transmissionMap = null;
      if ('attenuationDistance' in mat) mat.attenuationDistance = Infinity;
      // If the baseColor (mat.map) has an alpha channel that's <1 in
      // some pixels, force the GPU to read it as fully opaque via
      // premultipliedAlpha=false + format swap on next upload. Stripping
      // the alpha channel itself would require canvas roundtrip; cheaper
      // is to disable premultiplied + alphaTest as belt-and-braces.
      if (mat.map) {
        mat.map.premultiplyAlpha = false;
        mat.map.needsUpdate = true;
      }
      // Some PBR materials carry an emissive that's tinted by a black
      // alpha — strip the emissive alpha contribution as well.
      if (mat.emissiveMap) {
        mat.emissiveMap.premultiplyAlpha = false;
        mat.emissiveMap.needsUpdate = true;
      }
      mat.needsUpdate = true;
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
  }, (err) => {
    console.error('[mesh-viewer] GLTFLoader.parse ERROR:', err);
    if (typeof showToast === 'function') {
      showToast('Mesh load error: ' + (err?.message || err), 'error');
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

// Libellés SOURCE (anglais) des opérations mesh — traduits à l'affichage via
// FabI18n.t. Nom du DERNIER suffixe = modif qui a produit cette version. Aligné
// sur OP_SUFFIX du worker. Cf. desktop index2.js.
const _OP_LABEL = {
  cntile: 'ControlNet Tile', retexture: 're-texture', trellis2_retex: 're-texture',
  retex: 're-texture', decimate: 'decimation', subdivide: 'subdivision', smooth: 'smoothing',
  fill_holes: 'hole filling', fix_normals: 'normals fix', center: 'recentering',
  set_pivot: 'pivot adjustment', watertight: 'watertight sealing', texture_var: 'texture variation',
  edited: 'editing', upscale: 'upscale', refine: 'refinement', augment: 'augmentation',
  vc: 'vertex colors', segment: 'part segmentation',
};
const _OP_RE = /_(cntile|retexture|trellis2_retex|retex|decimate|subdivide|smooth|fill_holes|fix_normals|center|set_pivot|watertight|texture_var|edited|upscale|refine|augment|vc|segment)(?:_\d{6,})?$/i;
function _i18nT(s) { return (window.FabI18n && FabI18n.t) ? FabI18n.t(s) : s; }
function _i18nTf(s, ...a) {
  if (window.FabI18n && FabI18n.tf) return FabI18n.tf(s, ...a);
  let i = 0; return String(s).replace(/\{[xy]\}/g, () => (i < a.length ? String(a[i++]) : ''));
}
// Mesh dérivé `${base}_${op}_${ts}.glb` → op du DERNIER suffixe, ou
// isVersion=false pour un ORIGINAL (généré direct depuis une image).
function _meshVersionInfo(filename) {
  const stem = String(filename || '').replace(/\.[^.]+$/, '');
  const m = stem.match(_OP_RE);
  if (!m) return { isVersion: false, opKey: null, opLabel: null };
  const key = m[1].toLowerCase();
  return { isVersion: true, opKey: key, opLabel: _OP_LABEL[key] || key };
}
// Racine (tous suffixes d'op retirés) — le worker collapse la chaîne à
// `${racine}_${dernièreOp}_${ts}` → parent approximé par la version la plus
// récente plus ancienne de même racine.
function _meshRootBase(filename) {
  let s = String(filename || '').replace(/\.[^.]+$/, '');
  let prev; do { prev = s; s = s.replace(_OP_RE, ''); } while (s !== prev);
  return s;
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
    // Stable id so marketplace badge walker (_badgeAllCards) can match by
    // jobId — the thumb's <img> shows the source image PNG, not the GLB
    // URL, so url-only matching against _publishedIndex.byUrl always fails.
    t.dataset.jobId = m.jobId || m.job_id || m.id || '';
    if (m.path === p.previewMeshPath) t.classList.add('selected');
    if (m.path === p.selectedMeshPath) t.classList.add('used-for-3d'); // reuse same green check style
    // Resolve a thumbnail: prefer the mesh's own thumb (if main process generated one),
    // fall back to the source image used to generate this mesh, then to the project thumb.
    let thumbSrc = '';
    if (m.thumb) {
      thumbSrc = m.thumb.startsWith('file:') ? m.thumb : _toFileUrl(m.thumb);
    } else if (m.sourceImage) {
      thumbSrc = _toFileUrl(m.sourceImage);
    } else if (p.thumb) {
      thumbSrc = _toFileUrl(p.thumb);
    }
    // Show 💡 when the mesh's source image (or, if missing on cloud,
    // ANY project image) has a saved emissive layer in the cache. The
    // fallback chain handles cloud meshes that don't carry a
    // sourceImage field but were generated from an image with a
    // saved layer.
    const meshHasEmissive =
      // Direct: the mesh was painted with emissive via Paint Mesh 3D.
      (typeof _meshEmissiveHas === 'function' && _meshEmissiveHas(m.path))
      // Inherited: ONLY this mesh's own source image has a saved layer. (The
      // two project-wide clauses removed here made the badge leak onto every
      // mesh as soon as ANY project image had emissive — same bug as desktop.
      // Now safe because _emKey strips the signed-URL query so m.sourceImage
      // matches the painted image's key.)
      || ((typeof _emissiveLayerHas === 'function')
        && m.sourceImage && _emissiveLayerHas(m.sourceImage));
    const meshEmissiveBadge = meshHasEmissive
      ? '<span class="v-emissive-badge" title="This mesh was generated from an image with an emissive layer painted on it" style="position:absolute; bottom:2px; right:2px; background:rgba(0,0,0,0.7); border-radius:50%; width:18px; height:18px; display:flex; align-items:center; justify-content:center; font-size:11px; line-height:1; box-shadow:0 0 0 1px rgba(255, 224, 102, 0.85);">💡</span>'
      : '';
    // Coin haut-gauche : JUMP 📷 vers l'image source (mesh ORIGINAL) OU
    // indicateur « V » de lignée (mesh DÉRIVÉ par une op). Sur un dérivé, pas de
    // saut vers l'image (ce n'est qu'une version) — le « V » survolé cite le
    // MESH PARENT (version précédente) + la modif. Cf. desktop index2.js.
    const _vinfo = _meshVersionInfo(m.filename);
    let meshSourceBtn = '';
    if (_vinfo.isVersion) {
      const _opTxt = _i18nT(_vinfo.opLabel);
      const _root = _meshRootBase(m.filename);
      let _parentLabel = '';
      for (let j = i + 1; j < meshes.length; j++) {
        if (_meshRootBase(meshes[j].filename) === _root) { _parentLabel = 'v' + (meshes.length - 1 - j); break; }
      }
      const _tip = _parentLabel
        ? _i18nTf('Version — from {x} after {y}', _parentLabel, _opTxt)
        : _i18nTf('Version — after {x}', _opTxt);
      meshSourceBtn = `<span class="version-verbadge" title="${escapeHtml(_tip)}">V</span>`;
    } else if (m.sourceImage) {
      meshSourceBtn = `<button class="version-source-btn" title="${escapeHtml(_i18nT('View the source image that generated this mesh'))}">&#128247;</button>`;
    }
    t.innerHTML = `
      ${thumbSrc ? `<img src="${thumbSrc}" alt="">` : ''}
      <span class="v-used-badge" title="Used for next step">&#10003;</span>
      <span class="v-label">v${meshes.length - 1 - i}</span>
      <button class="version-delete-btn" title="Delete this mesh">&#10005;</button>
      ${meshSourceBtn}
      ${meshEmissiveBadge}
    `;
    t.title = m.filename;
    t.addEventListener('click', () => {
      strip.querySelectorAll('.version-thumb').forEach(x => x.classList.remove('selected'));
      t.classList.add('selected');
      p.previewMeshPath = m.path;
      showStep2Preview(m);
    });
    if (m.sourceImage) {
      t.querySelector('.version-source-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        jumpToSourceImage(m.sourceImage);
      });
    }
    t.querySelector('.version-delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!await customConfirm(`Delete mesh v${p.meshes.length - 1 - i}? This cannot be undone.`, 'Delete mesh version')) return;
      // Cloud needs either the Supabase job UUID OR the R2 path. The
      // path is the most reliable because mesh-op outputs live under
      // <uid>/mesh-op/<projectSlug>/ which the worker can extract
      // directly via r2PathFromPublicUrl. Prefer it when available;
      // fall back to id/filename for jobs-table meshes.
      const deleteKey = (m.url || m.path) || m.id || m.jobId || m.job_id || m.predictionId || m.prediction_id || m.filename;
      console.log('[deleteMesh] sending id=', deleteKey, 'from mesh=', m);
      const r = await API.deleteMesh(deleteKey);
      console.log('[deleteMesh] response=', r);
      const failed = r && (r.success === false || r.ok === false || r.error);
      if (failed) {
        const msg = (r && r.error) ? String(r.error) : 'Unknown error';
        const detail = /404|not found/i.test(msg)
          ? `${msg} — this mesh may belong to an older account or have already been removed.`
          : msg;
        if (typeof customError === 'function') customError(detail, 'Delete failed');
        else { console.error('[deleteMesh] failed:', detail); alert('Delete failed: ' + detail); }
        return;
      }
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

// "Use this rig for Animation ->" — mirrors the mesh→rig handover.
// Pins the currently-previewed rig as the animation source, marks the
// thumb selected, then expands + scrolls to Step 4 (Animation).
document.getElementById('ws-use-for-anim-btn')?.addEventListener('click', () => {
  const p = state.currentProject;
  if (!p || !p.rigs || p.rigs.length === 0) return;
  const sel = document.querySelector('#ws-rig-versions .version-thumb.selected');
  const idx = sel ? Array.from(sel.parentElement.children).indexOf(sel) : 0;
  const rig = p.rigs[idx] || p.rigs[0];
  if (!rig) return;
  p.selectedRigPath = rig.path;
  p.selectedRigUrl = rig.url || rig.path; // ensure both shapes available
  const strip = document.getElementById('ws-rig-versions');
  if (strip) {
    strip.querySelectorAll('.version-thumb').forEach(x => x.classList.remove('used-for-anim'));
    if (strip.children[idx]) strip.children[idx].classList.add('used-for-anim');
  }
  const btn = document.getElementById('ws-use-for-anim-btn');
  if (btn) {
    btn.disabled = false;
    btn.classList.add('used-state');
    btn.textContent = '✓ Used for Animation generation →';
  }
  // Populate the Step 4 SOURCE RIG preview + enable the Generate button.
  // Without this the user sees "No rig selected" in Step 4 even though
  // they just handed off a rig.
  try {
    const placeholder = document.getElementById('ws-anim-source-placeholder');
    if (placeholder) placeholder.style.display = 'none';
    const preview = document.getElementById('ws-anim-source-preview');
    if (preview) {
      const filename = (rig.filename || rig.url || '').split(/[/\\]/).pop() || 'rig.glb';
      const url = rig.url || rig.path;
      // model-viewer with absolute fill so the parent's CSS height
      // (stage-source-img class) drives the canvas size. position:relative
      // on the host so the absolute child is contained.
      preview.style.position = 'relative';
      preview.style.minHeight = '200px';
      preview.innerHTML = `
        <model-viewer src="${url}"
                      camera-controls touch-action="pan-y"
                      shadow-intensity="1" exposure="1"
                      auto-rotate auto-rotate-delay="3000"
                      style="position:absolute; inset:0; width:100%; height:100%; background:#0a0a0e; border-radius:6px;">
        </model-viewer>
        <div style="position:absolute; bottom:6px; left:0; right:0; text-align:center; font-size:10px; color:var(--text-2); pointer-events:none; padding:0 8px; word-break:break-all;">${filename}</div>
      `;
      // Spinner while <model-viewer> fetches + parses the GLB.
      try { setViewerLoading('ws-anim-source-preview', true, 'Loading rig…'); } catch (_) {}
      const mv = preview.querySelector('model-viewer');
      if (mv) {
        const clear = () => { try { setViewerLoading('ws-anim-source-preview', false); } catch (_) {} };
        mv.addEventListener('load', clear, { once: true });
        mv.addEventListener('error', clear, { once: true });
        // Safety net: clear after 10s no matter what so the spinner never gets stuck.
        setTimeout(clear, 10000);
      }
    }
    const genBtn = document.getElementById('ws-generate-anim');
    if (genBtn) {
      genBtn.disabled = false;
      genBtn.title = '';
    }
    // Force the engine dropdown to AnyTop (the only wired engine) and
    // collapse the Seed3D / Procedural options behind a disabled state.
    const engineSel = document.getElementById('ws-anim-engine');
    if (engineSel && engineSel.value !== 'anytop') {
      engineSel.value = 'anytop';
      engineSel.dispatchEvent(new Event('change'));
    }
  } catch (e) { console.warn('[anim-source] preview populate failed:', e); }
  const step4Card = document.getElementById('step-card-animation');
  if (step4Card) {
    step4Card.classList.remove('collapsed', 'disabled');
    setStepStatus(4, 'active');
    document.getElementById('step-card-image')?.classList.add('collapsed');
    document.getElementById('step-card-mesh')?.classList.add('collapsed');
    document.getElementById('step-card-rig')?.classList.add('collapsed');
    const step4CreateStage = step4Card.querySelector('.stage-create');
    const step4EditStage = step4Card.querySelector('.stage-edit');
    requestAnimationFrame(() => {
      if (step4EditStage) step4EditStage.open = false;
      if (step4CreateStage) step4CreateStage.open = true;
    });
    step4Card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    step4Card.classList.add('pulse-highlight');
    setTimeout(() => step4Card.classList.remove('pulse-highlight'), 1500);
  }
});

// Wrap a generate handler so it goes through the queue if VRAM is tight.
// We also remember the last gated operation so the "Unlock" flow can RE-RUN it
// after the user disables the content filter (a content-filter-blocked job would
// otherwise just sit failed — the user expects it to resume once unlocked).
let _lastGatedRun = null;
function gatedRun(kind, displayName, runFn) {
  _lastGatedRun = { kind, displayName, runFn };
  enqueueJob(kind, displayName, runFn);
}

// Open the legal-warning + PIN flow; if the user completes it (now unrestricted),
// re-run the operation that was blocked by the content filter.
async function _unlockThenRetry() {
  const retry = _lastGatedRun;  // capture before any await
  try { await toggleParentalControl(); } catch (_) {}
  try {
    const status = API.getParentalStatus ? await API.getParentalStatus() : null;
    if (status && status.unrestricted && retry && typeof retry.runFn === 'function') {
      showToast(FabI18n.t('Filter disabled — re-running the action…'), 'info', 2500);
      gatedRun(retry.kind, retry.displayName, retry.runFn);
    }
  } catch (_) {}
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
  } else if (engine === 'trellis2_native') {
    // TRELLIS-2 native pipeline (single-shot mesh + PBR):
    //   - pipeline load: ~60s (cached after 1st run -> ~5s)
    //   - inference: ~15s on 1024 mode
    //   - export GLB (bake Kaolin): ~25s
    // Total ~100s (~10-20s with warm cache).
    expectedMs = 110000;
  } else {
    expectedMs = 60000;
  }
  if (buildStages) expectedMs *= 2.5;
  // TRELLIS-2 texture options.
  const trellis2Preset = document.getElementById('ws-trellis2-preset')?.value || 'fast';
  const trellis2MultiRef = document.getElementById('ws-trellis2-multiref')?.checked || false;
  const trellis2Refine = document.getElementById('ws-trellis2-refine')?.checked || false;
  if (trellis2Refine) expectedMs += 90000;  // ~90s for SDXL Tile Refine
  const trellis2RectifySource = document.getElementById('ws-trellis2-rectify')?.checked || false;
  if (trellis2RectifySource) expectedMs += 36000;  // ~36s for front-strict rectify
  const trellis2Smooth = document.getElementById('ws-trellis2-smooth')?.checked || false;
  if (trellis2Smooth) expectedMs += 12000;  // ~12s for bilateral smooth
  const trellis2QualityPlus = document.getElementById('ws-trellis2-quality-plus')?.checked || false;
  if (trellis2QualityPlus) expectedMs += 30000;  // ~30s extra for cascade mode
  const trellis2UltraQ = document.getElementById('ws-trellis2-ultra-q')?.checked || false;
  if (trellis2UltraQ) expectedMs += 50000;  // ~50s extra for 1536_cascade
  const trellis2FaceFix = document.getElementById('ws-trellis2-face-fix')?.checked || false;
  if (trellis2FaceFix) expectedMs += 60000;  // ~60s for SDXL face inpaint
  const trellis2UltraHD = document.getElementById('ws-trellis2-ultra-hd')?.checked || false;
  if (trellis2UltraHD) expectedMs += 280000;  // ~280s for Real-ESRGAN x2 atlas 4k→8k
  const TRELLIS2_PRESETS = {
    fast:     { steps: 12, texSize: 2048, imgRes: 1024 },
    balanced: { steps: 24, texSize: 2048, imgRes: 1024 },
    quality:  { steps: 32, texSize: 4096, imgRes: 2048 },
    // Ultra 8K = Quality (TRELLIS atlas 4096) + forced Real-ESRGAN x2
    // post-process → 8192px final. Cheaper than re-running TRELLIS at
    // 8K (would OOM on A10G 24GB) and quality-comparable.
    ultra_8k: { steps: 32, texSize: 4096, imgRes: 2048, forceUltraHd: true },
  };
  const t2cfg = TRELLIS2_PRESETS[trellis2Preset] || TRELLIS2_PRESETS.fast;
  // Ultra 8K forces ultra_hd ON regardless of the checkbox.
  const effectiveUltraHD = trellis2UltraHD || !!t2cfg.forceUltraHd;
  if (t2cfg.forceUltraHd && !trellis2UltraHD) {
    expectedMs += 280000; // add Real-ESRGAN x2 time not yet accounted for
  }

  const params = {
    imagePath: p.selectedImagePath,
    // 2-view mode only when the user actually wants multi-ref. Unticking
    // the checkbox tells TRELLIS-2 to ignore the back photo entirely.
    imagePathBack: (trellis2MultiRef && p.backImagePath) ? p.backImagePath : null,
    outputName: p.name,
    engine,
    textureSize: preset.tex,
    targetFaces: preset.verts,
    effort: 2,
    buildStages,
    subdivide: triPreset.subdivide,
    vramFraction: (gpuLimits?.vram || 90) / 100,
    trellis2Steps: t2cfg.steps,
    trellis2TexSize: t2cfg.texSize,
    trellis2ImgRes: t2cfg.imgRes,
    // Cloud wire names — worker reads these from FormData, then forwards
    // to the Replicate Cog payload. Without this mapping, the worker's
    // form.get('quality_plus') reads `null` and every advanced checkbox
    // becomes a paid no-op.
    multiref:     trellis2MultiRef,
    refine:       trellis2Refine,
    rectify:      trellis2RectifySource,
    smooth:       trellis2Smooth,
    quality_plus: trellis2QualityPlus,
    ultra_q:      trellis2UltraQ,
    face_fix:     trellis2FaceFix,
    ultra_hd:     effectiveUltraHD,
    preset:       trellis2Preset,
    // Keep the legacy keys around in case the desktop main process or
    // any other listener reads them. They're harmless on cloud.
    trellis2MultiRef,
    trellis2Refine,
    trellis2RectifySource,
    trellis2Smooth,
    trellis2QualityPlus,
    trellis2UltraQ,
    trellis2FaceFix,
    trellis2UltraHD: effectiveUltraHD,
    trellis2Preset,
    // Network-boundary key: the Worker (/api/generate) reads `asset_type`.
    // Sending `assetType` here was a silent no-op that disabled the
    // asset-type-aware pipeline routing on the server side.
    asset_type: document.getElementById('ws-asset-type')?.value || 'character',
  };
  const qualityLabels = { draft: 'Draft', standard: 'Standard', high: 'High' };
  const jobParams = {
    Engine: engineLabel(engine),
    Quality: qualityLabels[quality] || quality,
    'Target triangles': triPreset.label,
    'Source image': p.selectedImagePath ? p.selectedImagePath.split(/[/\\]/).pop() : '--',
  };
  // SNAPSHOT the source image NOW (before gatedRun queues) so the Job
  // Details modal can never show a different version the user clicks
  // while the job is running.
  const meshSourceImage = p.selectedImagePath || p.previewImagePath || null;
  const meshProjectName = p.name;
  const meshAssetKind = document.getElementById('ws-asset-type')?.value || null;
  gatedRun('mesh', `Generate 3D: ${p.name}`, async () => {
    const job = pushJob(`Generate 3D: ${p.name}`, null, jobParams, expectedMs, undefined, {
      sourceImageUrl: meshSourceImage,
      projectName: meshProjectName,
      assetKind: meshAssetKind,
    });
    try {
      const r = await API.imageTo3D(params);
      // Capture the REAL worker-side job id so cancelJob can
      // forward it to /api/jobs/cancel. Without this, the renderer
      // was sending its local UI counter (state.jobIdCounter), which
      // the Worker has no row for — every cancel was a silent no-op.
      if (r?.jobId) job.workerJobId = r.jobId;
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
// expose for cloud-overrides.js (classic script, no module scope)
window.getCurrentMeshObj = getCurrentMeshObj;

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
// Expected duration per AI tool (ms) for the progress popup ETA.
const MESH_TOOL_EXPECTED_MS = {
  smooth:         5000,
  decimate:       12000,
  subdivide:      15000,
  fix_normals:    2000,
  fill_holes:     8000,
  center:         1000,
  retexture:      45000,
  trellis2_retex: 110000,
};

async function runMeshTool(operation, params = []) {
  const p = state.currentProject;
  if (!p || !p.selectedMeshPath) { showToast('Pick a mesh first.', 'error'); return; }
  const meshPath = p.selectedMeshPath;
  const meshName = meshPath.split(/[\\/]/).pop();
  const expectedMs = MESH_TOOL_EXPECTED_MS[operation] || 10000;
  // For texture ops (retexture/trellis2_retex) the cloud worker needs
  // an explicit imagePath — without it /api/mesh-op 400s with
  // "imagePath required for retexture". Prefer the mesh's own
  // sourceImage (so resolution-rebake stays bound to the mesh's actual
  // source, not whatever happens to be selected in the image step),
  // then fall back to the project's currently selected/preview image.
  const selectedMesh = (p.meshes || []).find(m => m && m.path === meshPath);
  const meshImagePath = (selectedMesh && selectedMesh.sourceImage)
    || p.selectedImagePath
    || p.previewImagePath
    || null;
  // Show the full "Running task" popup (same component as 3D generation,
  // image ops, etc.) so the user sees ETA + cancel button + progress bar
  // instead of just a toast.
  const job = (typeof pushJob === 'function')
    ? pushJob(`${operation}: ${p.name}`, null, {
        Tool: operation,
        Mesh: meshName,
        Params: params.length ? params.join(', ') : '(none)',
      }, expectedMs)
    : null;
  try {
    const result = await API.meshTool({ operation, meshPath, imagePath: meshImagePath, params, projectName: p?.name || null });
    if (result && result.success) {
      // fill_holes returns a verdict — drive a smarter toast and
      // optionally suppress the new-version push when nothing was filled.
      let toastMsg = `${operation} done!`, toastKind = 'success', suppressPush = false;
      if (operation === 'fill_holes' && result.stats) {
        const s = result.stats;
        const d = s.holes_filled_delta_faces || 0;
        switch (s.verdict) {
          case 'CLOSED_OK':
            if (d > 0) toastMsg = `Filled holes: +${d} faces, mesh is watertight.`;
            else { toastMsg = 'Mesh already watertight — no holes to fill. Dark patches are texture/back-faces; try Fix Normals or Re-Texture.'; toastKind = 'info'; suppressPush = true; }
            break;
          case 'OPEN_HOLES':
            toastMsg = `Filled some holes (+${d} faces); some remain unpatched. Re-run with a higher max or run Fix Normals first.`; break;
          case 'WINDING_INCONSISTENT':
            toastMsg = 'Winding inconsistent — run Fix Normals first, then Fill Holes again.'; toastKind = 'warning'; break;
          case 'NONMANIFOLD_OR_DOUBLE_SKINNED':
            toastMsg = 'Mesh is non-manifold / double-skinned — Fill Holes can\'t help. Re-mesh from source (Generate 3D).'; toastKind = 'warning'; break;
        }
      }
      showToast(toastMsg, toastKind, toastKind === 'success' ? 3000 : 6000);
      if (job && typeof completeJob === 'function') completeJob(job.id, true);
      const newUrl = result.newPath || result.path || result.mesh_url;
      if (newUrl && !suppressPush) {
        const filename = String(newUrl).split('/').pop() || `${operation}.glb`;
        p.meshes = p.meshes || [];
        p.meshes.unshift({ path: newUrl, filename, size: 0, mtime: Date.now() });
        p.selectedMeshPath = newUrl;
        p.previewMeshPath = newUrl;
      }
      if (!suppressPush) populateWorkspace(p);
    } else {
      const msg = (result && result.error) || 'unknown';
      showToast(`${operation} failed: ${msg}`, 'error', 5000);
      if (job && typeof completeJob === 'function') completeJob(job.id, false, msg);
    }
  } catch (e) {
    showToast(`${operation} error: ${e.message}`, 'error', 5000);
    if (job && typeof completeJob === 'function') completeJob(job.id, false, e.message);
  }
}

// ============================================================
// AI Tools — generic params popup with live 3D preview
// Each tool declares: params schema + optional `preview(origGeom, vals)`
// → modified BufferGeometry (or null = use original).
// Re-runs the preview on every slider tick (debounced).
// ============================================================

// Laplacian smoothing in JS (vertex one-ring averaging).
// `iter` iterations of vertex ← vertex + lambda*(avgNeighbor - vertex).
function _jsLaplacianSmooth(geom, iter, lambda) {
  const result = geom.clone();
  if (!result.index) return result; // need indexed geom
  const pos = result.attributes.position;
  const idx = result.index.array;
  const n = pos.count;

  // Mesh-coming-out-of-TRELLIS-2 has UV seams: at every island
  // boundary the geometry vertex is duplicated so each side can carry
  // its own UV/normal. If we smooth each duplicate independently the
  // two copies drift apart and a black gap appears along every seam.
  // Solution: weld duplicates by 3D position into "groups", smooth at
  // the group level, then copy the result back into all member
  // vertices so the seams stay watertight.
  const arr = new Float32Array(pos.array);
  // Position quantization key — 1e-4 unit precision is finer than any
  // float drift inside one frame; collisions for genuinely-distinct
  // vertices are impossibly rare at this scale.
  const Q = 1e4;
  const groupOfVertex = new Int32Array(n);
  const groupKeyToId = new Map();
  const groupVertices = []; // groupId -> array of vertex indices
  for (let v = 0; v < n; v++) {
    const k = (Math.round(arr[v * 3]     * Q) | 0) + ',' +
              (Math.round(arr[v * 3 + 1] * Q) | 0) + ',' +
              (Math.round(arr[v * 3 + 2] * Q) | 0);
    let gid = groupKeyToId.get(k);
    if (gid === undefined) {
      gid = groupVertices.length;
      groupKeyToId.set(k, gid);
      groupVertices.push([]);
    }
    groupOfVertex[v] = gid;
    groupVertices[gid].push(v);
  }
  const G = groupVertices.length;

  // Adjacency at the group level — connects edges across seams.
  const groupNeigh = Array.from({ length: G }, () => new Set());
  for (let i = 0; i < idx.length; i += 3) {
    const ga = groupOfVertex[idx[i]];
    const gb = groupOfVertex[idx[i + 1]];
    const gc = groupOfVertex[idx[i + 2]];
    if (ga !== gb) { groupNeigh[ga].add(gb); groupNeigh[gb].add(ga); }
    if (gb !== gc) { groupNeigh[gb].add(gc); groupNeigh[gc].add(gb); }
    if (ga !== gc) { groupNeigh[ga].add(gc); groupNeigh[gc].add(ga); }
  }

  // One position per group (initial = the position of any member —
  // they all share it by construction).
  const groupPos = new Float32Array(G * 3);
  for (let g = 0; g < G; g++) {
    const v0 = groupVertices[g][0];
    groupPos[g * 3]     = arr[v0 * 3];
    groupPos[g * 3 + 1] = arr[v0 * 3 + 1];
    groupPos[g * 3 + 2] = arr[v0 * 3 + 2];
  }

  // Laplacian iterations at the group level.
  for (let it = 0; it < iter; it++) {
    const next = new Float32Array(groupPos);
    for (let g = 0; g < G; g++) {
      const ns = groupNeigh[g];
      if (ns.size === 0) continue;
      let sx = 0, sy = 0, sz = 0;
      ns.forEach((nb) => {
        sx += groupPos[nb * 3];
        sy += groupPos[nb * 3 + 1];
        sz += groupPos[nb * 3 + 2];
      });
      const k = 1 / ns.size;
      next[g * 3]     = groupPos[g * 3]     + lambda * (sx * k - groupPos[g * 3]);
      next[g * 3 + 1] = groupPos[g * 3 + 1] + lambda * (sy * k - groupPos[g * 3 + 1]);
      next[g * 3 + 2] = groupPos[g * 3 + 2] + lambda * (sz * k - groupPos[g * 3 + 2]);
    }
    groupPos.set(next);
  }

  // Spread the new positions back to every vertex that belongs to the
  // group — both sides of every seam now share the same coordinate.
  for (let g = 0; g < G; g++) {
    const members = groupVertices[g];
    const gx = groupPos[g * 3], gy = groupPos[g * 3 + 1], gz = groupPos[g * 3 + 2];
    for (const v of members) {
      arr[v * 3] = gx;
      arr[v * 3 + 1] = gy;
      arr[v * 3 + 2] = gz;
    }
  }
  pos.array.set(arr);
  pos.needsUpdate = true;
  result.computeVertexNormals();
  return result;
}

// Fill Holes — Unreal-Modeling-Mode-style preview.
// Highlights every detected hole boundary with a coloured line loop:
//   grey   → smaller than minHoleSize, left untouched (e.g. micro-cracks
//             you don't want to weld over).
//   green  → minHoleSize ≤ size ≤ maxHoleSize → filled with a centroid-
//             fan triangulation in the preview.
//   red    → bigger than maxHoleSize, left untouched.
// Caller drives both ends via the live sliders, so dragging shifts loops
// between buckets in real time.
//
// Returns { geometry, helpers, stats: { loops, filled, tooBig, tooSmall,
// biggest, smallest } } so the modal can render the status line.
function _jsFillHoles(geom, minHoleSize, maxHoleSize) {
  if (!geom.index) {
    return { geometry: geom.clone(), helpers: [], stats: { loops: 0, filled: 0, tooBig: 0, tooSmall: 0, biggest: 0, smallest: 0 } };
  }
  const posAttr = geom.attributes.position;
  const rawIndices = geom.index.array;
  const rawTriCount = Math.floor(rawIndices.length / 3);
  const n = posAttr.count;
  const arr = posAttr.array;

  // ── Step 1: Bbox + adaptive scales.
  let bbMinX = Infinity, bbMinY = Infinity, bbMinZ = Infinity;
  let bbMaxX = -Infinity, bbMaxY = -Infinity, bbMaxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = arr[i*3], y = arr[i*3+1], z = arr[i*3+2];
    if (x < bbMinX) bbMinX = x; if (x > bbMaxX) bbMaxX = x;
    if (y < bbMinY) bbMinY = y; if (y > bbMaxY) bbMaxY = y;
    if (z < bbMinZ) bbMinZ = z; if (z > bbMaxZ) bbMaxZ = z;
  }
  const bbDiag = Math.hypot(bbMaxX-bbMinX, bbMaxY-bbMinY, bbMaxZ-bbMinZ) || 1;

  // ── Step 2: Strip degenerate triangles (zero-area, duplicate index).
  // Trellis2 marching cubes emits a lot of these and they show up as
  // false boundary edges later. Mirror of UE's MeshAutoRepair early
  // cleanup.
  const indices = [];
  const areaEps = bbDiag * 1e-12;
  for (let t = 0; t < rawTriCount; t++) {
    const i0 = rawIndices[t*3], i1 = rawIndices[t*3+1], i2 = rawIndices[t*3+2];
    if (i0 === i1 || i1 === i2 || i2 === i0) continue;
    const ax = arr[i0*3], ay = arr[i0*3+1], az = arr[i0*3+2];
    const bx = arr[i1*3], by = arr[i1*3+1], bz = arr[i1*3+2];
    const cx = arr[i2*3], cy = arr[i2*3+1], cz = arr[i2*3+2];
    const ex = bx-ax, ey = by-ay, ez = bz-az;
    const fx = cx-ax, fy = cy-ay, fz = cz-az;
    const cross = Math.hypot(ey*fz-ez*fy, ez*fx-ex*fz, ex*fy-ey*fx);
    if (cross * 0.5 < areaEps) continue;
    indices.push(i0, i1, i2);
  }
  const triCount = Math.floor(indices.length / 3);

  // ── Step 3: Weld vertices by quantized position. Tolerance bumped
  // from bbDiag/1e5 to bbDiag/1e4 (10x more aggressive) so meshes whose
  // hole borders store 4-5 digit drift on the same conceptual position
  // (very common in Puppeteer / TRELLIS-2 output) merge correctly. The
  // previous strict value reported 'mesh is closed' on rigs that
  // clearly had visible holes because the duplicate-vertex pairs at
  // the hole border never merged into the same group.
  const tol = bbDiag / 1e4;
  const Q = 1 / tol;
  const groupKeyToId = new Map();
  const groupOfVertex = new Int32Array(n);
  let G = 0;
  for (let v = 0; v < n; v++) {
    const kx = Math.round(arr[v*3]   * Q);
    const ky = Math.round(arr[v*3+1] * Q);
    const kz = Math.round(arr[v*3+2] * Q);
    const k = kx + ',' + ky + ',' + kz;
    let gid = groupKeyToId.get(k);
    if (gid === undefined) { gid = G++; groupKeyToId.set(k, gid); }
    groupOfVertex[v] = gid;
  }
  const repOfGroup = new Int32Array(G).fill(-1);
  for (let v = 0; v < n; v++) {
    const g = groupOfVertex[v];
    if (repOfGroup[g] === -1) repOfGroup[g] = v;
  }

  // ── Step 4: Count undirected edges in group space.
  const undirectedCount = new Map();
  for (let t = 0; t < triCount; t++) {
    const i0 = indices[t*3], i1 = indices[t*3+1], i2 = indices[t*3+2];
    const g0 = groupOfVertex[i0], g1 = groupOfVertex[i1], g2 = groupOfVertex[i2];
    for (const [ga, gb] of [[g0,g1],[g1,g2],[g2,g0]]) {
      if (ga === gb) continue;
      const key = ga < gb ? ga + ',' + gb : gb + ',' + ga;
      undirectedCount.set(key, (undirectedCount.get(key) || 0) + 1);
    }
  }

  // ── Step 5: Collect directed boundary candidates (count === 1).
  //   { ga, gb, mx, my, mz }
  const candidates = [];
  for (let t = 0; t < triCount; t++) {
    const i0 = indices[t*3], i1 = indices[t*3+1], i2 = indices[t*3+2];
    const g0 = groupOfVertex[i0], g1 = groupOfVertex[i1], g2 = groupOfVertex[i2];
    for (const [ga, gb] of [[g0,g1],[g1,g2],[g2,g0]]) {
      if (ga === gb) continue;
      const key = ga < gb ? ga + ',' + gb : gb + ',' + ga;
      if (undirectedCount.get(key) !== 1) continue;
      const vA = repOfGroup[ga], vB = repOfGroup[gb];
      const mx = (arr[vA*3]   + arr[vB*3])   * 0.5;
      const my = (arr[vA*3+1] + arr[vB*3+1]) * 0.5;
      const mz = (arr[vA*3+2] + arr[vB*3+2]) * 0.5;
      candidates.push({ ga, gb, mx, my, mz, matched: false });
    }
  }

  // ── Step 6: MergeCoincidentEdges — for each boundary candidate,
  // search nearby candidates (spatial hash on midpoint) and match if
  // there's one with OPPOSITE orientation AND midpoint distance < a
  // generous tolerance (bbox/2000). This rescues seam edges whose
  // endpoint positions slipped past the vertex weld in Step 3 — same
  // logic as UE's FMergeCoincidentMeshEdges escalating tolerance.
  const mergeTol = bbDiag / 2000;
  const mergeTolSq = mergeTol * mergeTol;
  const cellSize = mergeTol;
  const cellQ = 1 / cellSize;
  const spatial = new Map();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const cx = Math.floor(c.mx * cellQ);
    const cy = Math.floor(c.my * cellQ);
    const cz = Math.floor(c.mz * cellQ);
    const k = cx + ',' + cy + ',' + cz;
    let bucket = spatial.get(k);
    if (!bucket) { bucket = []; spatial.set(k, bucket); }
    bucket.push(i);
  }
  for (let i = 0; i < candidates.length; i++) {
    const c1 = candidates[i];
    if (c1.matched) continue;
    const cx = Math.floor(c1.mx * cellQ);
    const cy = Math.floor(c1.my * cellQ);
    const cz = Math.floor(c1.mz * cellQ);
    let matched = false;
    for (let dx = -1; dx <= 1 && !matched; dx++) {
      for (let dy = -1; dy <= 1 && !matched; dy++) {
        for (let dz = -1; dz <= 1 && !matched; dz++) {
          const k = (cx+dx) + ',' + (cy+dy) + ',' + (cz+dz);
          const bucket = spatial.get(k);
          if (!bucket) continue;
          for (const j of bucket) {
            if (j === i) continue;
            const c2 = candidates[j];
            if (c2.matched) continue;
            // Opposite orientation: c2.ga's POSITION ≈ c1.gb's POSITION
            // (and vice-versa). We compare positions, not groups, so a
            // welding miss in Step 3 still gets caught here.
            const v1a = repOfGroup[c1.ga], v1b = repOfGroup[c1.gb];
            const v2a = repOfGroup[c2.ga], v2b = repOfGroup[c2.gb];
            const dA = (arr[v1a*3]-arr[v2b*3])**2 + (arr[v1a*3+1]-arr[v2b*3+1])**2 + (arr[v1a*3+2]-arr[v2b*3+2])**2;
            const dB = (arr[v1b*3]-arr[v2a*3])**2 + (arr[v1b*3+1]-arr[v2a*3+1])**2 + (arr[v1b*3+2]-arr[v2a*3+2])**2;
            if (dA > mergeTolSq || dB > mergeTolSq) continue;
            const dM = (c1.mx-c2.mx)**2 + (c1.my-c2.my)**2 + (c1.mz-c2.mz)**2;
            if (dM > mergeTolSq) continue;
            c1.matched = true;
            c2.matched = true;
            matched = true;
            break;
          }
        }
      }
    }
  }

  // ── Step 7: Build boundarySuccessors from the SURVIVING candidates
  // (still unmatched after the merge pass).
  const candidatesBeforeMerge = candidates.length;
  let candidatesAfterMerge = 0;
  const boundarySuccessors = new Map();
  for (const c of candidates) {
    if (c.matched) continue;
    candidatesAfterMerge++;
    if (!boundarySuccessors.has(c.ga)) boundarySuccessors.set(c.ga, []);
    boundarySuccessors.get(c.ga).push(c.gb);
  }

  // Walk loops by popping successors. Each successor is consumed once;
  // a group with N unbalanced edges produces up to N loops branching
  // through it (T-junction).
  const loops = [];
  const popNext = (g) => {
    const arr2 = boundarySuccessors.get(g);
    if (!arr2 || !arr2.length) return null;
    return arr2.pop();
  };
  for (const start of boundarySuccessors.keys()) {
    while ((boundarySuccessors.get(start) || []).length) {
      const loop = [];
      let g = start;
      for (let safety = 0; safety < 100000; safety++) {
        loop.push(g);
        const nxt = popNext(g);
        if (nxt == null) break;
        if (nxt === start) break;
        g = nxt;
      }
      if (loop.length >= 3) loops.push(loop);
      else break;
    }
  }

  // Build the new geometry: copy of original + fan triangles for
  // loops within budget. UVs on new center vertices = (0, 0).
  const newPositions = Array.from(posAttr.array);
  const newIndices = Array.from(indices);
  const hasUV = !!geom.attributes.uv;
  const newUVs = hasUV ? Array.from(geom.attributes.uv.array) : null;

  // Pre-collect line vertices for the helpers.
  // grey  = below minHoleSize (skipped on purpose)
  // green = within [min,max] (will be filled in the preview)
  // red   = above maxHoleSize (skipped — raise the max to include them)
  const greyLineVerts = [];
  const greenLineVerts = [];
  const redLineVerts = [];

  for (const loop of loops) {
    let bucket;
    if (loop.length < minHoleSize) bucket = greyLineVerts;
    else if (loop.length > maxHoleSize) bucket = redLineVerts;
    else bucket = greenLineVerts;
    const willFill = bucket === greenLineVerts;
    // Build the loop line geometry — LineSegments expects pairs, so
    // we emit each edge as two vertices.
    for (let i = 0; i < loop.length; i++) {
      const va = repOfGroup[loop[i]];
      const vb = repOfGroup[loop[(i + 1) % loop.length]];
      bucket.push(
        newPositions[va * 3], newPositions[va * 3 + 1], newPositions[va * 3 + 2],
        newPositions[vb * 3], newPositions[vb * 3 + 1], newPositions[vb * 3 + 2],
      );
    }
    if (!willFill) continue;

    // Centroid fan triangulation. Cheap, works on convex-ish holes.
    let cx = 0, cy = 0, cz = 0;
    for (const g of loop) {
      const v = repOfGroup[g];
      cx += newPositions[v * 3];
      cy += newPositions[v * 3 + 1];
      cz += newPositions[v * 3 + 2];
    }
    cx /= loop.length; cy /= loop.length; cz /= loop.length;
    const centerIdx = newPositions.length / 3;
    newPositions.push(cx, cy, cz);
    if (newUVs) newUVs.push(0, 0);
    // Add triangles fanning out from the centroid. Boundary edges
    // point ga->gb with the outside on the right, so we orient
    // (a, b, center) — using the representative vertex of each group
    // — to keep the fill facing the right way.
    for (let i = 0; i < loop.length; i++) {
      const va = repOfGroup[loop[i]];
      const vb = repOfGroup[loop[(i + 1) % loop.length]];
      newIndices.push(va, vb, centerIdx);
    }
  }

  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.Float32BufferAttribute(newPositions, 3));
  if (newUVs) result.setAttribute('uv', new THREE.Float32BufferAttribute(newUVs, 2));
  result.setIndex(newIndices);
  result.computeVertexNormals();

  const helpers = [];
  if (greyLineVerts.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(greyLineVerts, 3));
    helpers.push(new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      color: 0x888888, depthTest: false, transparent: true, opacity: 0.85,
    })));
  }
  if (greenLineVerts.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(greenLineVerts, 3));
    helpers.push(new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      color: 0x22cc66, depthTest: false, transparent: true, opacity: 0.95,
    })));
  }
  if (redLineVerts.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(redLineVerts, 3));
    helpers.push(new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      color: 0xff3344, depthTest: false, transparent: true, opacity: 0.95,
    })));
  }
  // Render the lines on top of the mesh so they're not z-buried.
  for (const h of helpers) h.renderOrder = 999;
  // Stats so the modal can surface "0 loops found" (probably texture,
  // not geometry) vs "5 loops, 2 filled, 1 too small, 2 too big".
  let filled = 0, tooBig = 0, tooSmall = 0, biggest = 0, smallest = Infinity;
  for (const loop of loops) {
    if (loop.length > biggest) biggest = loop.length;
    if (loop.length < smallest) smallest = loop.length;
    if (loop.length < minHoleSize) tooSmall++;
    else if (loop.length > maxHoleSize) tooBig++;
    else filled++;
  }
  if (loops.length === 0) smallest = 0;
  return {
    geometry: result,
    helpers,
    stats: { loops: loops.length, filled, tooBig, tooSmall, biggest, smallest,
             rawCandidates: candidatesBeforeMerge,
             unmatched: candidatesAfterMerge },
  };
}

// Edge-collapse decimation via three.js SimplifyModifier. Quadric
// metric — keeps silhouette and important features. The modifier
// counts VERTICES to remove, not triangles, so we estimate the
// target vertex count from the target triangle count assuming a
// closed manifold (Euler: F ≈ 2V → V ≈ F/2). Conservative: never
// upscale, and bail early if the mesh is already smaller than target.
const _decimator = new SimplifyModifier();
const DECIMATE_LIVE_MAX_REMOVE = 20000;
function _jsDecimate(geom, targetFaces) {
  const currentFaces = geom.index
    ? Math.floor(geom.index.count / 3)
    : Math.floor(geom.attributes.position.count / 3);
  if (targetFaces >= currentFaces) return geom.clone();
  const currentVerts = geom.attributes.position.count;
  const targetVerts = Math.max(4, Math.ceil(targetFaces / 2));
  const removeCount = Math.max(0, currentVerts - targetVerts);
  if (removeCount === 0) return geom.clone();
  // Live preview cap: SimplifyModifier is O(V·logV) and locks the
  // main thread; >20k vertex removals can freeze the tab for many
  // seconds. Show the original on big drags — the slider value still
  // updates, and Apply runs the full server-side decimation.
  if (removeCount > DECIMATE_LIVE_MAX_REMOVE) return geom.clone();
  // SimplifyModifier only understands `position` — extra attributes
  // (uv, normal, color, multi-material groups) make it throw on some
  // builds. Feed it a stripped-down clone so it can't choke.
  const stripped = new THREE.BufferGeometry();
  stripped.setAttribute('position', geom.attributes.position);
  if (geom.index) stripped.setIndex(geom.index);
  try {
    return _decimator.modify(stripped, removeCount);
  } catch (e) {
    console.warn('[decimate] preview failed:', e);
    return geom.clone();
  }
}

// Midpoint subdivision: 1 triangle → 4 triangles. Single-pass; recurse for levels.
function _jsMidpointSubdivide(geom, levels) {
  let g = geom.clone();
  if (!g.index) {
    g = g.toNonIndexed();
    // build a trivial index
    const n = g.attributes.position.count;
    g.setIndex(new THREE.BufferAttribute(new Uint32Array([...Array(n).keys()]), 1));
  }
  for (let lv = 0; lv < levels; lv++) {
    const pos = g.attributes.position;
    const idx = g.index.array;
    const newPos = Array.from(pos.array);
    const newIdx = [];
    const midCache = new Map();
    const getMid = (a, b) => {
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (midCache.has(k)) return midCache.get(k);
      const ax = pos.array[a * 3], ay = pos.array[a * 3 + 1], az = pos.array[a * 3 + 2];
      const bx = pos.array[b * 3], by = pos.array[b * 3 + 1], bz = pos.array[b * 3 + 2];
      const m = newPos.length / 3;
      newPos.push((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
      midCache.set(k, m);
      return m;
    };
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i], b = idx[i + 1], c = idx[i + 2];
      const ab = getMid(a, b), bc = getMid(b, c), ca = getMid(c, a);
      newIdx.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    const newGeom = new THREE.BufferGeometry();
    newGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(newPos), 3));
    newGeom.setIndex(new THREE.BufferAttribute(new Uint32Array(newIdx), 1));
    g = newGeom;
  }
  g.computeVertexNormals();
  return g;
}

// Center: translate vertices so X/Z centroid = 0, min Y = 0.
// Recompute vertex normals AND weld them across position-welded
// groups. Without this, vertices duplicated at UV seams (every island
// in a Trellis2 GLB) get independent normals → each side of the seam
// gets normals averaged over its own incident faces → lighting cracks
// visibly at every seam. Welding flattens those discontinuities while
// keeping the UV split intact (positions/UVs are untouched, only the
// normal attribute is rewritten).
//
// Note: an earlier version of this function also tried to flip
// inward-facing triangles via an AABB-centroid heuristic, but that
// caught too many false positives on concave/articulated meshes (orc
// arms, armour plates, etc.) and visibly broke the rendering. Until
// we have a real local-coherence flip pass (compare each triangle
// normal against its neighbors' average), we leave winding alone.
function _jsFixNormalsWelded(geom) {
  const result = geom.clone();
  result.computeVertexNormals();
  const pos = result.attributes.position;
  const norm = result.attributes.normal;
  if (!pos || !norm) return result;
  const arr = pos.array;
  const narr = norm.array;
  const n = pos.count;
  // Adaptive weld tolerance — same trick as fill_holes, so a tiny prop
  // doesn't over-weld and a huge character doesn't under-weld.
  let bbMinX = Infinity, bbMinY = Infinity, bbMinZ = Infinity;
  let bbMaxX = -Infinity, bbMaxY = -Infinity, bbMaxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = arr[i*3], y = arr[i*3+1], z = arr[i*3+2];
    if (x < bbMinX) bbMinX = x; if (x > bbMaxX) bbMaxX = x;
    if (y < bbMinY) bbMinY = y; if (y > bbMaxY) bbMaxY = y;
    if (z < bbMinZ) bbMinZ = z; if (z > bbMaxZ) bbMaxZ = z;
  }
  const diag = Math.hypot(bbMaxX-bbMinX, bbMaxY-bbMinY, bbMaxZ-bbMinZ) || 1;
  const Q = 1e5 / diag;
  const groupKey = new Map();
  const groupOfVertex = new Int32Array(n);
  let G = 0;
  for (let v = 0; v < n; v++) {
    const k = Math.round(arr[v*3]*Q) + ',' + Math.round(arr[v*3+1]*Q) + ',' + Math.round(arr[v*3+2]*Q);
    let g = groupKey.get(k);
    if (g === undefined) { g = G++; groupKey.set(k, g); }
    groupOfVertex[v] = g;
  }
  // Sum the per-vertex normals into a per-group accumulator, then
  // copy the normalized group normal back to every member.
  const groupN = new Float32Array(G * 3);
  for (let v = 0; v < n; v++) {
    const g = groupOfVertex[v];
    groupN[g*3]   += narr[v*3];
    groupN[g*3+1] += narr[v*3+1];
    groupN[g*3+2] += narr[v*3+2];
  }
  for (let g = 0; g < G; g++) {
    const x = groupN[g*3], y = groupN[g*3+1], z = groupN[g*3+2];
    const len = Math.hypot(x, y, z) || 1;
    groupN[g*3]   = x / len;
    groupN[g*3+1] = y / len;
    groupN[g*3+2] = z / len;
  }
  for (let v = 0; v < n; v++) {
    const g = groupOfVertex[v];
    narr[v*3]   = groupN[g*3];
    narr[v*3+1] = groupN[g*3+1];
    narr[v*3+2] = groupN[g*3+2];
  }
  norm.needsUpdate = true;
  return result;
}

function _jsCenter(geom) {
  return _jsSetPivotApply(geom, 'bottom', 0, 0, 0);
}

// Compute the pivot point coordinates in the mesh's LOCAL space, given
// a preset landmark on the AABB + an X/Y/Z offset for fine tuning.
function _computePivotPoint(geom, mode, ox, oy, oz) {
  const pos = geom.attributes.position;
  const arr = pos.array;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const x = arr[i*3], y = arr[i*3+1], z = arr[i*3+2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  let px, py, pz;
  switch ((mode || 'bottom').toLowerCase()) {
    case 'center':       px = cx;   py = cy;   pz = cz; break;
    case 'top':          px = cx;   py = maxY; pz = cz; break;
    case 'left':         px = minX; py = cy;   pz = cz; break;
    case 'right':        px = maxX; py = cy;   pz = cz; break;
    case 'front':        px = cx;   py = cy;   pz = maxZ; break;
    case 'back':         px = cx;   py = cy;   pz = minZ; break;
    case 'world_origin': px = 0;    py = 0;    pz = 0; break;
    case 'bottom':
    default:             px = cx;   py = minY; pz = cz; break;
  }
  return {
    pivot: [px + (ox || 0), py + (oy || 0), pz + (oz || 0)],
    diag: Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1,
  };
}

// PREVIEW path — does NOT translate the mesh. Just drops a yellow
// gizmo at the chosen pivot point so the user can see WHERE the pivot
// will land without the mesh "jumping" each time they change the
// preset or drag a slider. The actual translate is deferred to
// `applyClient` (run by _mtApplyOnDevice at Apply time).
//
// We return `geom` (the SAME reference) instead of a clone so the
// slider feedback is instant — on a 6-submesh mesh, cloning each one
// on every tick was costing 30-100 ms per drag and produced visible
// lag between dragging the slider and the gizmo moving.
function _jsSetPivotPreview(geom, mode, ox, oy, oz) {
  const { pivot, diag } = _computePivotPoint(geom, mode, ox, oy, oz);
  const gizmo = _makePivotGizmo(diag * 0.08);
  gizmo.position.set(pivot[0], pivot[1], pivot[2]);
  return { geometry: geom, helpers: [gizmo] };
}

// APPLY path — actually translate the vertices so the chosen pivot
// lands at local (0,0,0). Used only when the user clicks Apply.
function _jsSetPivotApply(geom, mode, ox, oy, oz) {
  const { pivot } = _computePivotPoint(geom, mode, ox, oy, oz);
  const result = geom.clone();
  const pos = result.attributes.position;
  const arr = pos.array;
  const [px, py, pz] = pivot;
  for (let i = 0; i < pos.count; i++) {
    arr[i*3]   -= px;
    arr[i*3+1] -= py;
    arr[i*3+2] -= pz;
  }
  pos.needsUpdate = true;
  result.computeVertexNormals();
  return result;
}

function _makePivotGizmo(size) {
  const g = new THREE.Group();
  const axes = new THREE.AxesHelper(size);
  // Render on top of the mesh so it stays visible even when inside it.
  axes.material.depthTest = false;
  axes.material.transparent = true;
  axes.material.opacity = 1.0;
  axes.renderOrder = 999;
  g.add(axes);
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(size * 0.18, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0xffe066, depthTest: false, transparent: true, opacity: 0.95 }),
  );
  sphere.renderOrder = 999;
  g.add(sphere);
  return g;
}

const MESH_TOOL_SCHEMAS = {
  smooth: {
    title: 'Smooth mesh',
    subtitle: 'Laplacian smoothing — live preview.',
    needsImage: false,
    supportsClientApply: true,
    params: [
      { id: 'iterations', label: 'Iterations', type: 'range', min: 1, max: 20, step: 1, default: 3 },
      { id: 'lambda',     label: 'Lambda',     type: 'range', min: 0.0, max: 1.0, step: 0.05, default: 0.5 },
    ],
    build: (vals) => [String(vals.iterations), String(vals.lambda)],
    preview: (geom, vals) => _jsLaplacianSmooth(geom, Math.max(1, vals.iterations | 0), vals.lambda),
  },
  decimate: {
    title: 'Triangle count',
    subtitle: 'Reduce triangle count — drag the slider down to preview the reduction.',
    needsImage: false,
    expensivePreview: true,
    supportsClientApply: true,
    fitSliderToMeshTris: 'target_faces',
    params: [
      { id: 'target_faces', label: 'Target triangles', type: 'range', min: 200, max: 1_000_000, step: 100, default: 15000 },
    ],
    build: (vals) => [String(vals.target_faces)],
    preview: (geom, vals) => _jsDecimate(geom, Math.max(200, vals.target_faces | 0)),
    previewStatus: (vals, st) => {
      const total = st.totalTris || 0;
      const target = Math.max(200, (vals.target_faces | 0));
      if (target >= total) return `Source: ${total.toLocaleString()} triangles · no reduction (drag slider down).`;
      // V ≈ F/2 → removeCount ≈ totalVerts - targetVerts ≈ (total - target) / 2
      const removeApprox = Math.max(0, Math.ceil((total - target) / 2));
      if (removeApprox > DECIMATE_LIVE_MAX_REMOVE) {
        return `Target: ${target.toLocaleString()} tris · reduction too large for live preview — click Apply to run.`;
      }
      return `Live preview · ${target.toLocaleString()} / ${total.toLocaleString()} triangles.`;
    },
  },
  subdivide: {
    title: 'Subdivide mesh',
    subtitle: 'Midpoint subdivision — live preview (×4 triangles per level).',
    needsImage: false,
    supportsClientApply: true,
    params: [
      { id: 'levels', label: 'Levels', type: 'range', min: 1, max: 3, step: 1, default: 1 },
    ],
    build: (vals) => [String(vals.levels)],
    preview: (geom, vals) => _jsMidpointSubdivide(geom, Math.max(1, vals.levels | 0)),
  },
  fix_normals: {
    title: 'Fix normals (weld UV seams)',
    subtitle: 'Recompute vertex normals + weld them across UV seams — kills the criss-cross / cracked-plate shading on a fresh Trellis2 mesh. (Black patches that look like voids are usually triangles with reversed winding — a flip pass is on the todo list; for now regenerate the mesh if you see large dark voids.)',
    needsImage: false,
    supportsClientApply: true,
    params: [],
    build: () => [],
    preview: (geom) => _jsFixNormalsWelded(geom),
  },
  fill_holes: {
    title: 'Fill holes',
    subtitle: 'Cap mesh holes. Reports one of four outcomes: CLOSED_OK (watertight), OPEN_HOLES (some remain — re-run with a higher max), WINDING_INCONSISTENT (run Fix Normals first), NONMANIFOLD_OR_DOUBLE_SKINNED (re-mesh from source). Preview: green outlines will be filled, grey are smaller than min, red bigger than max.',
    needsImage: false,
    supportsClientApply: true,
    params: [
      { id: 'min_hole_size', label: 'Min hole size (edges)', type: 'range', min: 3,  max: 20000, step: 1,  default: 3 },
      { id: 'max_hole_size', label: 'Max hole size (edges)', type: 'range', min: 3,  max: 20000, step: 10, default: 2000 },
    ],
    build: (vals) => [String(vals.min_hole_size), String(vals.max_hole_size)],
    preview: (geom, vals) => _jsFillHoles(
      geom,
      Math.max(3, vals.min_hole_size | 0),
      Math.max(3, vals.max_hole_size | 0),
    ),
    previewStatus: (vals, st) => {
      const s = st.lastStats;
      if (!s) return 'Computing…';
      // Diagnostic suffix so we can SEE if the merge pass is killing
      // candidates: rawCandidates = count===1 edges found, unmatched =
      // what survived the MergeCoincidentEdges pass.
      const diag = (s.rawCandidates != null)
        ? ` [debug: ${s.rawCandidates} raw boundary edges → ${s.unmatched} after seam-merge]`
        : '';
      if (s.loops === 0) {
        if (s.rawCandidates > 0 && s.unmatched === 0) {
          return `Detector found ${s.rawCandidates} boundary edges but merged them ALL as seam pairs — likely a false positive on the merge pass. (try Fix Normals first; then re-run)${diag}`;
        }
        // The cloud pipeline runs T-junction splitting + winding fix
        // that the local preview doesn't — it can find holes the JS
        // detector misses. Surface that explicitly so the user clicks
        // Apply instead of giving up.
        return 'Local preview found 0 boundary edges, but the cloud detector has extra steps (T-junction split, winding repair) that may find holes this preview misses. Try "Apply on cloud" — you\'ll get one of 4 verdicts: CLOSED_OK / OPEN_HOLES / WINDING_INCONSISTENT / NONMANIFOLD.' + diag;
      }
      if (s.filled === s.loops) {
        return `Filled ${s.filled} hole${s.filled > 1 ? 's' : ''} (range ${s.smallest}–${s.biggest} edges).${diag}`;
      }
      const parts = [];
      parts.push(`${s.loops} hole${s.loops > 1 ? 's' : ''} found`);
      if (s.filled) parts.push(`${s.filled} filled (green)`);
      if (s.tooSmall) parts.push(`${s.tooSmall} too small (grey)`);
      if (s.tooBig) parts.push(`${s.tooBig} too big (red)`);
      parts.push(`range ${s.smallest}–${s.biggest} edges`);
      return parts.join(' · ') + '. Adjust min/max to include more.' + diag;
    },
  },
  watertight: {
    title: 'Watertight',
    subtitle: 'Rebuild a CLOSED, watertight shell (voxel remesh) — fuses every disconnected part into one solid with no holes. This REPLACES the geometry and removes the texture, so Re-Texture afterwards. Higher resolution = more detail, slower.',
    needsImage: false,
    confirm: 'Watertight rebuilds the mesh as a new closed shell and removes its texture (re-texture afterwards). Continue?',
    params: [
      { id: 'resolution', label: 'Resolution', type: 'range', min: 48, max: 512, step: 8, default: 128 },
    ],
    build: (vals) => [String(vals.resolution)],
  },
  center: {
    title: 'Set pivot point',
    subtitle: 'Place the local origin of the mesh (its pivot) at an AABB landmark, or fine-tune with the X/Y/Z sliders. Yellow gizmo = new pivot.',
    needsImage: false,
    supportsClientApply: true,
    // 100% client-side — it's a single translation, no Modal work.
    clientApplyOnly: true,
    params: [
      { id: 'pivot', label: 'Pivot preset', type: 'toggle-group', default: 'bottom',
        options: [
          ['center', 'Center'], ['bottom', 'Bottom'], ['top', 'Top'],
          ['left', 'Left'], ['right', 'Right'],
          ['front', 'Front'], ['back', 'Back'],
          ['world_origin', 'World Origin'],
        ],
      },
      { id: 'offset_x', label: 'X offset', type: 'range', min: -1, max: 1, step: 0.01, default: 0 },
      { id: 'offset_y', label: 'Y offset', type: 'range', min: -1, max: 1, step: 0.01, default: 0 },
      { id: 'offset_z', label: 'Z offset', type: 'range', min: -1, max: 1, step: 0.01, default: 0 },
    ],
    build: (vals) => [String(vals.pivot || 'bottom'),
                      String(vals.offset_x || 0),
                      String(vals.offset_y || 0),
                      String(vals.offset_z || 0)],
    // Preview = drop gizmo, mesh stays put.
    preview: (geom, vals) => _jsSetPivotPreview(
      geom, vals.pivot || 'bottom',
      Number(vals.offset_x) || 0,
      Number(vals.offset_y) || 0,
      Number(vals.offset_z) || 0,
    ),
    // Apply = actually translate vertices so pivot lands at (0,0,0).
    applyClient: (geom, vals) => _jsSetPivotApply(
      geom, vals.pivot || 'bottom',
      Number(vals.offset_x) || 0,
      Number(vals.offset_y) || 0,
      Number(vals.offset_z) || 0,
    ),
    // Adds a "↺ Reset offsets" button under the params that snaps
    // every numeric/range slider back to its default value.
    resetButton: 'Reset offsets',
    // Drag the pivot directly with an Unreal-style gizmo (3 axes +
    // center sphere). Axis arrow = constrained to that axis; sphere
    // = free-move in the view plane. Sliders update live as you drag.
    useTransformGizmo: true,
  },
  retexture: {
    title: 'Resolution',
    subtitle: 'Re-bake the mesh texture at a different resolution by reprojecting the source photo onto the UVs. Higher resolution (4096+) coming soon — currently capped at 2048 because the upstream UV unwrap is baked at 2K and stretching produces corruption (black patches / bleached areas).',
    needsImage: true,
    params: [
      { id: 'tex_res', label: 'Texture resolution (4K coming soon)', type: 'select', default: '2048',
        options: [['1024','1024 px'],['2048','2048 px (max)']] },
    ],
    build: (vals, ctx) => [ctx.imagePath, String(vals.tex_res)],
  },
  trellis2_retex: {
    title: 'Re-Texture (AI native)',
    subtitle: 'Native PBR re-texturing on cloud GPU (~90s).',
    needsImage: true,
    params: [
      { id: 'preset', label: 'Quality preset', type: 'select', default: 'fast',
        options: [['fast','Fast (12 steps · 2048px · ~90s)'],
                  ['balanced','Balanced (24 steps · 2048px · ~130s)'],
                  ['quality','Quality (32 steps · 4096px · ~3min)']] },
    ],
    build: (vals, ctx) => {
      // Forward preset via env to mesh_tools → trellis2_retex bridge.
      // We can't pass env directly from runMeshTool, so we set
      // window.__trellis2Preset for the IPC layer to pick up if wired,
      // otherwise the bridge uses its 'fast' default.
      window.__trellis2Preset = vals.preset;
      return [ctx.imagePath];
    },
  },
};

// Persistent Three.js state for the mesh-tool modal viewer.
const mtState = {
  renderer: null, scene: null, camera: null, controls: null,
  rafId: null,
  origModel: null,        // the GLTF scene loaded — we mutate its geometries on preview
  origGeoms: [],          // [{ mesh, originalGeom }] — to restore on params change
  helpers: [],            // Object3D overlays added by the preview hook (Fill Holes boundary lines etc.)
  schema: null,
  vals: {},
  previewTimer: null,
  lastPreviewOk: false,   // last _mtRunPreview succeeded → safe to export current state
  // TransformControls integration (Unreal-style draggable pivot gizmo).
  // Lazy-loaded the first time a schema declares `useTransformGizmo`.
  // dummy is the Object3D that TC moves around; the modal reads its
  // position back into the schema's offset sliders.
  transformControls: null,
  dummy: null,
  basePivot: null,        // preset-only pivot position (Vector3, local space)
};

// Device-side mesh ops are heavy (SimplifyModifier / Laplacian over
// 100k+ verts can pin a CPU thread for 5–10 s). Mobile and low-spec
// browsers will freeze or OOM, so we only offer the "free, on device"
// path when the hardware is realistically able to do the work.
// Heuristic combines:
//   - touch-only UA → almost always mobile/tablet
//   - navigator.deviceMemory (Chromium): < 4 GB → no
//   - navigator.hardwareConcurrency: < 4 cores → no
// Conservative on purpose — we'd rather charge a credit than crash
// the user's browser. The cloud path always works.
function _deviceCanRunMeshClient() {
  try {
    const ua = (navigator.userAgent || '').toLowerCase();
    if (/iphone|ipad|ipod|android|mobile|tablet/.test(ua)) return false;
    const mem = navigator.deviceMemory;  // GB, Chromium only
    if (typeof mem === 'number' && mem < 4) return false;
    const cores = navigator.hardwareConcurrency;
    if (typeof cores === 'number' && cores < 4) return false;
    return true;
  } catch { return false; }
}

function _mtCollectVals(body) {
  const vals = {};
  body.querySelectorAll('[data-param-id]').forEach((el) => {
    const id = el.dataset.paramId;
    const t = el.dataset.paramType;
    if (t === 'checkbox') vals[id] = el.checked;
    else if (t === 'number' || t === 'range') vals[id] = Number(el.value);
    else if (t === 'toggle-group') vals[id] = el.dataset.value;
    else vals[id] = el.value;
  });
  return vals;
}

function _mtSchedulePreview() {
  if (mtState.previewTimer) clearTimeout(mtState.previewTimer);
  // Expensive preview (Decimate's quadric edge collapse) can take a
  // few seconds on 200K+ tris; use a longer debounce so a drag
  // doesn't fire ten compute passes back-to-back.
  const delay = mtState.schema?.expensivePreview ? 400 : 80;
  mtState.previewTimer = setTimeout(_mtRunPreview, delay);
}

// Remove every helper Object3D we added on a previous preview tick.
// Helpers are parented to origModel (not scene) so they inherit the
// centring + Y-lift we apply when framing the mesh.
function _mtClearHelpers() {
  if (!mtState.helpers) return;
  for (const h of mtState.helpers) {
    h.parent?.remove(h);
    if (h.geometry) h.geometry.dispose?.();
    if (h.material) {
      if (Array.isArray(h.material)) h.material.forEach((m) => m.dispose?.());
      else h.material.dispose?.();
    }
  }
  mtState.helpers = [];
}

// Export the *current* mtState.origModel (which carries the preview's
// updated geometries) to a binary GLB, POST it to the server, and
// attach the resulting R2 URL to the active project as a new mesh
// version. No credit charge — the server-side route validates auth +
// magic bytes + size and only stores.
async function _mtApplyOnDevice(opType) {
  if (!mtState.origModel) throw new Error('no model loaded');
  // Temporarily strip our boundary-line / debug overlays from the
  // model before export — they don't belong in the saved GLB. Also
  // zero out the centring transform we apply in _mtLoadMesh so the
  // exported origin matches the source mesh.
  const detachedHelpers = [];
  for (const h of (mtState.helpers || [])) {
    if (h.parent === mtState.origModel) {
      mtState.origModel.remove(h);
      detachedHelpers.push(h);
    }
  }
  // Also detach the TransformControls dummy if it's parented to the
  // model — exporting an empty Object3D inside the GLB would leak the
  // pivot widget into the saved mesh.
  const dummyWasAttached = mtState.dummy && mtState.dummy.parent === mtState.origModel;
  if (dummyWasAttached) mtState.origModel.remove(mtState.dummy);
  const savedPos = mtState.origModel.position.clone();
  mtState.origModel.position.set(0, 0, 0);
  // Some schemas (Set pivot point) keep the preview cheap by only
  // moving a gizmo, then commit the real geometry edit at Apply time
  // via the `applyClient(geom, vals)` hook. Run that hook now on each
  // submesh, swap in the transformed geometry, and remember the old
  // one so we can restore in `finally`.
  const swappedGeoms = [];
  if (mtState.schema?.applyClient && mtState.vals) {
    for (const e of mtState.origGeoms) {
      try {
        const out = mtState.schema.applyClient(e.originalGeom, mtState.vals);
        if (out && out.attributes && out.attributes.position) {
          swappedGeoms.push({ mesh: e.mesh, prev: e.mesh.geometry });
          e.mesh.geometry = out;
        }
      } catch (err) {
        console.warn('[mesh-tool] applyClient failed:', err);
      }
    }
  }
  try {
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    const exporter = new GLTFExporter();
    const arrayBuffer = await new Promise((resolve, reject) => {
      exporter.parse(
        mtState.origModel,
        (result) => {
          if (result instanceof ArrayBuffer) resolve(result);
          else reject(new Error('GLTFExporter returned non-binary output'));
        },
        (err) => reject(err),
        { binary: true, embedImages: true },
      );
    });
    const bytes = new Uint8Array(arrayBuffer);
    const data = await uploadClientMeshResult(bytes, opType);
    const newUrl = data.path || data.newPath || data.mesh_url;
    showToast(`${opType} done (free, on device)`, 'success');
    // populateWorkspace re-renders from p.meshes — push the new URL
    // into the list (same as the cloud Apply path does) so the
    // version strip shows it instead of staying on the old mesh.
    const p = state.currentProject;
    if (p && newUrl) {
      const filename = String(newUrl).split('/').pop() || `${opType}.glb`;
      p.meshes = p.meshes || [];
      p.meshes.unshift({ path: newUrl, filename, size: 0, mtime: Date.now() });
      p.selectedMeshPath = newUrl;
      p.previewMeshPath = newUrl;
      if (typeof populateWorkspace === 'function') {
        try { await populateWorkspace(p); } catch {}
      }
    }
    return newUrl;
  } finally {
    // Restore swapped geometries so the modal viewer cleanup runs
    // against the same originals the rest of the code expects.
    for (const s of swappedGeoms) s.mesh.geometry = s.prev;
    mtState.origModel.position.copy(savedPos);
    for (const h of detachedHelpers) mtState.origModel.add(h);
    if (dummyWasAttached && mtState.dummy) mtState.origModel.add(mtState.dummy);
  }
}

function _mtRunPreview() {
  if (!mtState.schema || !mtState.origModel) return;
  const body = document.getElementById('mt-body');
  if (!body) return;
  const vals = _mtCollectVals(body);
  mtState.vals = vals;
  const fn = mtState.schema.preview;
  _mtClearHelpers();
  mtState.lastStats = null;
  let allOk = !!fn;
  // Without preview fn, just restore originals (mesh stays static).
  for (const e of mtState.origGeoms) {
    if (!fn) { e.mesh.geometry = e.originalGeom; continue; }
    try {
      const out = fn(e.originalGeom, vals);
      // Preview hooks can return either a BufferGeometry directly, or
      // { geometry, helpers: [Object3D] } when the tool wants to draw
      // extra overlays (boundary lines on Fill Holes, etc.).
      let nextGeom = null;
      let nextHelpers = null;
      if (out && out.attributes && out.attributes.position) {
        nextGeom = out;
      } else if (out && out.geometry && out.geometry.attributes && out.geometry.attributes.position) {
        nextGeom = out.geometry;
        if (Array.isArray(out.helpers)) nextHelpers = out.helpers;
        // Surface tool-specific stats (e.g. Fill Holes loop count) so
        // previewStatus() can render them in the status bar.
        if (out.stats) mtState.lastStats = out.stats;
      }
      if (nextGeom) e.mesh.geometry = nextGeom;
      else allOk = false;
      // When the schema drives an interactive TransformControls gizmo,
      // skip the custom Object3D helpers — TC has its own overlay
      // (3 axes + center sphere) and a second gizmo on top looks
      // duplicate / fights the drag interaction.
      if (nextHelpers && !mtState.schema.useTransformGizmo) {
        // Parent helpers to origModel so they inherit the centring +
        // Y-lift transform applied at load. Without this they sit at
        // world origin and visibly offset from the mesh.
        const parent = mtState.origModel || mtState.scene;
        for (const h of nextHelpers) {
          parent.add(h);
          mtState.helpers.push(h);
        }
      }
    } catch (err) {
      console.warn('[mesh-tool] preview failed for', mtState.schema.title, err);
      e.mesh.geometry = e.originalGeom;
      allOk = false;
    }
  }
  mtState.lastPreviewOk = allOk;
  // Drive TransformControls for schemas that opt in. We position
  // - the dummy (= what TC drags) at the CURRENT pivot (preset + offset)
  // - the basePivot reference at the preset-only pivot, so the change
  //   handler can derive `offset = dummy.position - basePivot`.
  // Skip the position write while the user is mid-drag (would fight them).
  if (mtState.schema?.useTransformGizmo && mtState.origGeoms.length) {
    _mtEnsureTransformGizmo().then(() => {
      const tc = mtState.transformControls;
      if (!tc || !mtState.dummy || !mtState.origModel) return;
      // three.js r166+ split TransformControls into a logic object and
      // a separate visual helper. The HELPER is what we add to the
      // scene; the TC object itself is event-driven and doesn't render
      // anything when added directly.
      const tcHelper = (typeof tc.getHelper === 'function') ? tc.getHelper() : tc;
      mtState.transformControlsHelper = tcHelper;
      if (!tcHelper.parent) mtState.scene.add(tcHelper);
      if (mtState.dummy.parent !== mtState.origModel) {
        mtState.origModel.add(mtState.dummy);
      }
      const firstGeom = mtState.origGeoms[0]?.originalGeom;
      if (!firstGeom) return;
      const mode = vals.pivot || 'bottom';
      const ox = Number(vals.offset_x) || 0;
      const oy = Number(vals.offset_y) || 0;
      const oz = Number(vals.offset_z) || 0;
      const base = _computePivotPoint(firstGeom, mode, 0, 0, 0);
      const cur  = _computePivotPoint(firstGeom, mode, ox, oy, oz);
      mtState.basePivot = new THREE.Vector3(base.pivot[0], base.pivot[1], base.pivot[2]);
      if (!tc.dragging) {
        mtState.dummy.position.set(cur.pivot[0], cur.pivot[1], cur.pivot[2]);
      }
      // Size the gizmo against the mesh so it stays readable on tiny
      // props and big characters alike.
      tc.setSize(Math.max(0.4, Math.min(1.5, base.diag * 0.08 / 0.1)));
    });
  } else if (mtState.transformControls) {
    _mtDisableTransformGizmo();
  }
  // Update the "Apply on device" button's availability based on
  // whether the current preview actually produced new geometry. If the
  // preview was skipped (Decimate's expensivePreview before slider
  // move, or removeCount > LIVE_MAX), the user can't apply locally.
  const devBtn = document.getElementById('mt-apply-device');
  if (devBtn) {
    if (allOk) {
      devBtn.disabled = false;
      devBtn.title = 'Apply on this device — no credits used.';
    } else {
      devBtn.disabled = true;
      devBtn.title = 'Move a slider to compute a preview before applying on device.';
    }
  }
  const status = document.getElementById('mt-preview-status');
  if (status) {
    if (mtState.schema.previewStatus) {
      status.textContent = mtState.schema.previewStatus(vals, mtState);
    } else {
      status.textContent = fn
        ? `Live preview · ${Object.entries(vals).map(([k,v]) => `${k}=${v}`).join(' · ')}`
        : 'No live preview for this op · click Apply to run.';
    }
  }
}

// Lazy-load TransformControls and wire the drag → slider feedback loop.
// Called from _mtRunPreview the first time a schema with
// `useTransformGizmo` is active. After this, the user can grab the
// gizmo (3 colored axes + center sphere) in the viewer:
//   - axis arrow  → translate along that axis only (orthonormal)
//   - center sphere → translate in the view plane (free move)
// matching the Unreal Modeling Mode pivot widget.
async function _mtEnsureTransformGizmo() {
  if (mtState.transformControls) return;
  if (!mtState.scene || !mtState.camera || !mtState.renderer) return;
  const { TransformControls } = await import('three/addons/controls/TransformControls.js');
  mtState.dummy = new THREE.Object3D();
  const tc = new TransformControls(mtState.camera, mtState.renderer.domElement);
  tc.setMode('translate');
  tc.setSize(0.8);
  tc.attach(mtState.dummy);
  mtState.transformControls = tc;
  // While the user holds the gizmo, suspend the orbit camera so panning
  // doesn't fight the drag.
  tc.addEventListener('dragging-changed', (e) => {
    if (mtState.controls) mtState.controls.enabled = !e.value;
  });
  // Live-update the X/Y/Z offset sliders so they reflect the dragged
  // position, then re-trigger preview for any side effects.
  tc.addEventListener('change', () => {
    if (!tc.dragging) return;  // ignore our own programmatic position writes
    const base = mtState.basePivot;
    if (!base || !mtState.dummy) return;
    const newOffX = mtState.dummy.position.x - base.x;
    const newOffY = mtState.dummy.position.y - base.y;
    const newOffZ = mtState.dummy.position.z - base.z;
    const body = document.getElementById('mt-body');
    if (!body) return;
    const map = { offset_x: newOffX, offset_y: newOffY, offset_z: newOffZ };
    for (const [id, val] of Object.entries(map)) {
      const el = body.querySelector(`[data-param-id="${id}"]`);
      if (!el) continue;
      const min = Number(el.min); const max = Number(el.max);
      const clamped = Math.max(
        Number.isFinite(min) ? min : -Infinity,
        Math.min(Number.isFinite(max) ? max : Infinity, val),
      );
      el.value = clamped.toFixed(2);
      const lab = el.previousElementSibling;
      const labVal = lab && lab.lastElementChild;
      if (labVal) labVal.textContent = el.value;
    }
    _mtSchedulePreview();
  });
  // Render TC inside the modal's tick loop (it draws its own
  // overlay-on-top gizmo helpers).
}

// Detach the gizmo + dummy from the scene tree when switching to a
// schema that doesn't use it (or when closing the modal).
function _mtDisableTransformGizmo() {
  const tc = mtState.transformControls;
  if (!tc) return;
  tc.detach();
  // Remove the visual helper from the scene (r166+ split — see
  // _mtEnsureTransformGizmo for context).
  const tcHelper = mtState.transformControlsHelper;
  if (tcHelper?.parent) tcHelper.parent.remove(tcHelper);
  if (tc.parent) tc.parent.remove(tc);
  if (mtState.dummy?.parent) mtState.dummy.parent.remove(mtState.dummy);
  if (mtState.controls) mtState.controls.enabled = true;
  mtState.basePivot = null;
}

async function _mtInitViewport() {
  if (mtState.renderer) return;
  const container = document.getElementById('mt-viewport');
  const canvas = document.getElementById('mt-canvas');
  const w = container.clientWidth || 800;
  const h = container.clientHeight || 600;
  mtState.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  mtState.renderer.setSize(w, h, false);
  mtState.renderer.setPixelRatio(window.devicePixelRatio);
  mtState.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  mtState.renderer.toneMappingExposure = 1.0;
  mtState.scene = new THREE.Scene();
  // Match the main workspace viewer (Viewer3D) bg + lighting rig so
  // the mesh keeps its texture/color exactly as it appears elsewhere
  // in the app. Without the fill light the shadow side falls into the
  // hemisphere ground tint (violet-grey 0x444466) and meshes look
  // monochrome-brown.
  mtState.scene.background = new THREE.Color(0x0b0b14);
  mtState.camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 100);
  mtState.camera.position.set(0, 0.5, 2);
  try {
    mtState.controls = new OrbitControls(mtState.camera, canvas);
    mtState.controls.enableDamping = true;
  } catch (e) { console.error('[mesh-tool] OrbitControls error:', e); }
  mtState.scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.0));
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(5, 8, 5);
  mtState.scene.add(dir);
  const fill = new THREE.DirectionalLight(0xffffff, 0.5);
  fill.position.set(-5, 3, -5);
  mtState.scene.add(fill);
  mtState.scene.add(new THREE.AmbientLight(0xffffff, 0.3));
  mtState.scene.add(new THREE.GridHelper(2, 20, 0x444466, 0x333355));
  const tick = () => {
    if (!document.getElementById('modal-mesh-tool')?.classList.contains('hidden')) {
      mtState.controls?.update();
      mtState.renderer.render(mtState.scene, mtState.camera);
    }
    mtState.rafId = requestAnimationFrame(tick);
  };
  tick();
  new ResizeObserver(() => {
    const cw = container.clientWidth, ch = container.clientHeight;
    if (cw > 0 && ch > 0) {
      mtState.renderer.setSize(cw, ch, false);
      mtState.camera.aspect = cw / ch;
      mtState.camera.updateProjectionMatrix();
    }
  }).observe(container);
}

function _mtLoadMesh(meshPath) {
  if (mtState.origModel && mtState.scene) {
    mtState.scene.remove(mtState.origModel);
  }
  mtState.origModel = null;
  mtState.origGeoms = [];
  // meshPath comes in two flavours:
  //  - desktop: Windows filesystem path (backslashes) → needs file:///
  //  - cloud:   already a full https://pub-*.r2.dev/... URL → leave alone
  // The legacy code unconditionally prefixed file:/// which produced
  // file:///https:/pub-... on cloud and 404'd silently — the modal
  // viewport stayed empty (just the grid).
  const url = /^(?:https?|blob|data|file):/i.test(meshPath)
    ? meshPath
    : _toFileUrl(meshPath);
  fetch(url, { credentials: 'omit' })
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    })
    .then((buffer) => {
      const loader = new GLTFLoader();
      loader.parse(buffer, '', (gltf) => {
        mtState.origModel = gltf.scene;
        mtState.scene.add(mtState.origModel);
        const box = new THREE.Box3().setFromObject(mtState.origModel);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        mtState.origModel.position.sub(center);
        mtState.origModel.position.y += size.y / 2;
        mtState.camera.position.set(0, size.y * 0.5, maxDim * 2);
        mtState.controls?.target.set(0, size.y * 0.5, 0);
        mtState.controls?.update();
        mtState.origModel.traverse((child) => {
          if (child.isMesh && child.geometry) {
            mtState.origGeoms.push({ mesh: child, originalGeom: child.geometry });
            // Force DoubleSide rendering in the modal viewer. Trellis2
            // sometimes emits triangles with reversed winding — under
            // single-sided rendering they appear as black voids
            // ("trous"). DoubleSide makes both faces visible so the
            // user sees their mesh as it actually is, and a future
            // Apply that re-exports preserves doubleSided=true in the
            // GLB (GLTFExporter writes the side property through).
            const setDoubleSide = (m) => { if (m) m.side = THREE.DoubleSide; };
            if (Array.isArray(child.material)) child.material.forEach(setDoubleSide);
            else setDoubleSide(child.material);
          }
        });
        // Total triangle count across all submeshes — used by tools
        // that want the slider to default to the actual mesh size
        // (Decimate) and to report it in the status line.
        let totalTris = 0;
        for (const e of mtState.origGeoms) {
          const g = e.originalGeom;
          totalTris += g.index
            ? Math.floor(g.index.count / 3)
            : Math.floor(g.attributes.position.count / 3);
        }
        mtState.totalTris = totalTris;
        // If the schema asked the slider to fit the mesh, rewrite its
        // max + value (capped to the schema's hard max) so the user
        // opens on a no-op decimation rather than 15K-tris.
        const fitId = mtState.schema?.fitSliderToMeshTris;
        if (fitId) {
          const input = document.querySelector(`#mt-body [data-param-id="${fitId}"]`);
          if (input) {
            const hardMax = Number(input.max) || totalTris;
            const hardMin = Number(input.min) || 1;
            const v = Math.max(hardMin, Math.min(hardMax, totalTris));
            input.value = String(v);
            const lab = input.previousElementSibling;
            const labVal = lab && lab.lastElementChild;
            if (labVal) labVal.textContent = String(v);
          }
        }
        // Run the initial preview. Skip for `expensivePreview` tools
        // (Decimate) so the modal opens instantly and the heavy
        // SimplifyModifier compute only kicks in once the user
        // actually moves the slider.
        const status = document.getElementById('mt-preview-status');
        if (!mtState.schema?.expensivePreview) {
          _mtRunPreview();
        } else if (status) {
          status.textContent = `Mesh: ${totalTris.toLocaleString()} triangles · drag the slider down to preview the reduction.`;
        }
      });
    })
    .catch((e) => {
      console.error('[mesh-tool] load failed:', e);
      if (typeof showToast === 'function') {
        showToast('Mesh load failed: ' + (e?.message || e), 'error', 5000);
      }
    });
}

function openMeshToolModal(toolName) {
  const schema = MESH_TOOL_SCHEMAS[toolName];
  if (!schema) { showToast(`Unknown tool: ${toolName}`, 'error'); return; }
  const p = state.currentProject;
  if (!p || !p.selectedMeshPath) { showToast('Pick a mesh first.', 'error'); return; }
  if (schema.needsImage && !p.selectedImagePath) { showToast('Pick a source image first.', 'error'); return; }

  const modal = document.getElementById('modal-mesh-tool');
  const title = document.getElementById('mt-title');
  const subtitle = document.getElementById('mt-subtitle');
  const body = document.getElementById('mt-body');
  const cancelBtn = document.getElementById('mt-cancel');
  const closeX = document.getElementById('mt-close-x');
  const applyBtn = document.getElementById('mt-apply');
  if (!modal || !body || !applyBtn) { showToast('Mesh-tool modal missing.', 'error'); return; }

  mtState.schema = schema;
  title.textContent = schema.title;
  subtitle.textContent = schema.subtitle || '';
  body.innerHTML = '';

  if (schema.params.length === 0) {
    const note = document.createElement('div');
    note.style.cssText = 'color: var(--text-muted); font-size:12px;';
    note.textContent = 'No parameters — click Apply to run.';
    body.appendChild(note);
  } else {
    schema.params.forEach((spec) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex; flex-direction:column; gap:4px;';
      const lab = document.createElement('div');
      lab.style.cssText = 'display:flex; justify-content:space-between; font-size:11px;';
      const labText = document.createElement('span');
      labText.style.cssText = 'color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;';
      labText.textContent = spec.label;
      const labVal = document.createElement('span');
      labVal.style.cssText = 'color:var(--text-1);';
      labVal.textContent = String(spec.default);
      lab.appendChild(labText); lab.appendChild(labVal);
      wrap.appendChild(lab);

      let input;
      if (spec.type === 'select') {
        input = document.createElement('select');
        spec.options.forEach(([val, lbl]) => {
          const opt = document.createElement('option');
          opt.value = val; opt.textContent = lbl;
          if (String(spec.default) === String(val)) opt.selected = true;
          input.appendChild(opt);
        });
        labVal.style.display = 'none';
      } else if (spec.type === 'checkbox') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!spec.default;
        labVal.style.display = 'none';
      } else if (spec.type === 'toggle-group') {
        // Row of buttons, one active at a time. Selection is stored on
        // `input.dataset.value` and read back by _mtCollectVals.
        input = document.createElement('div');
        input.style.cssText = 'display:flex; flex-wrap:wrap; gap:6px;';
        const setActive = (val) => {
          input.dataset.value = String(val);
          input.querySelectorAll('button').forEach((b) => {
            const on = b.dataset.value === String(val);
            b.classList.toggle('selected', on);
            b.style.background = on ? 'var(--accent, #5a4fcf)' : '';
            b.style.color = on ? '#fff' : '';
            b.style.borderColor = on ? 'var(--accent, #5a4fcf)' : '';
          });
        };
        spec.options.forEach(([val, lbl]) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'ghost-btn';
          btn.textContent = lbl;
          btn.dataset.value = String(val);
          btn.style.cssText = 'padding:6px 12px; font-size:12px; margin:0;';
          btn.addEventListener('click', () => {
            setActive(val);
            _mtSchedulePreview();
          });
          input.appendChild(btn);
        });
        setActive(spec.default);
        labVal.style.display = 'none';
      } else {
        input = document.createElement('input');
        input.type = spec.type === 'range' ? 'range' : 'number';
        if (spec.min !== undefined) input.min = String(spec.min);
        if (spec.max !== undefined) input.max = String(spec.max);
        if (spec.step !== undefined) input.step = String(spec.step);
        input.value = String(spec.default);
        input.style.width = '100%';
      }
      input.dataset.paramId = spec.id;
      input.dataset.paramType = spec.type || 'number';
      input.addEventListener('input', () => {
        if (spec.type === 'range' || spec.type === 'number') labVal.textContent = String(input.value);
        _mtSchedulePreview();
      });
      input.addEventListener('change', () => _mtSchedulePreview());
      wrap.appendChild(input);
      body.appendChild(wrap);
    });
  }

  // Optional reset button — snaps every numeric/range param back to
  // its default. Useful for tools where the user dials in offsets and
  // wants to clear them in one click.
  if (schema.resetButton) {
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'ghost-btn';
    resetBtn.textContent = '↺ ' + schema.resetButton;
    resetBtn.style.cssText = 'padding:6px 12px; font-size:11px; margin-top:6px; width:auto; align-self:flex-start;';
    resetBtn.addEventListener('click', () => {
      schema.params.forEach((spec) => {
        if (spec.type !== 'range' && spec.type !== 'number') return;
        const el = body.querySelector(`[data-param-id="${spec.id}"]`);
        if (!el || spec.default === undefined) return;
        el.value = String(spec.default);
        const lab = el.previousElementSibling;
        const labVal = lab && lab.lastElementChild;
        if (labVal) labVal.textContent = String(spec.default);
      });
      _mtSchedulePreview();
    });
    body.appendChild(resetBtn);
  }

  // Optional second button: "Apply on this device (free)". Only added
  // when the schema declares a pure-JS pipeline AND the device looks
  // capable (mobile/low-RAM → cloud path only, so we don't crash the
  // user's browser). Inserted left of the existing cloud Apply button.
  const applyParent = applyBtn.parentElement;
  let deviceBtn = document.getElementById('mt-apply-device');
  if (deviceBtn) deviceBtn.remove();
  // Lightweight client-only ops (Set pivot point — a single translate)
  // ignore the device capability check: any browser can do them, even
  // mobile, so we don't punish mobile users with "no Apply button"
  // on tools that would never crash them.
  const deviceCapable = !!schema.clientApplyOnly || _deviceCanRunMeshClient();
  if (schema.supportsClientApply && deviceCapable && applyParent) {
    deviceBtn = document.createElement('button');
    deviceBtn.id = 'mt-apply-device';
    deviceBtn.className = 'secondary-btn';
    deviceBtn.style.cssText = 'margin:0; padding:8px 18px; width:auto;';
    // Free icon (💻) reserved for "runs on user hardware". The ⚡
    // emoji is reserved for the credit badge so the two are never
    // confused in the UI.
    deviceBtn.textContent = '💻 Apply on device (free)';
    deviceBtn.title = 'Move a slider to compute a preview before applying on device.';
    deviceBtn.disabled = true;
    applyParent.insertBefore(deviceBtn, applyBtn);
  }
  // Relabel the cloud Apply button to make the trade-off explicit
  // (clear that it costs 1 credit) when both options are visible.
  // For purely client-side ops (Set pivot point — just a translate),
  // hide the cloud button entirely so the user isn't asked to pay 1
  // credit for work the browser can do alone.
  const originalApplyLabel = applyBtn.textContent;
  const cloudHidden = !!schema.clientApplyOnly;
  // Apply-on-cloud label with a real .credit-badge instead of the
  // text "(1 cr)" — keeps the credit indicator consistent with every
  // other place in the app.
  const cloudApplyHTML = 'Apply on cloud <span class="credit-badge" style="margin-left:6px;">1</span>';
  if (cloudHidden) {
    applyBtn.style.display = 'none';
    if (deviceBtn) deviceBtn.textContent = '💻 Apply';
  } else if (schema.supportsClientApply && deviceCapable) {
    applyBtn.innerHTML = cloudApplyHTML;
  } else if (schema.supportsClientApply && !deviceCapable) {
    applyBtn.innerHTML = cloudApplyHTML;
    applyBtn.title = 'This device is mobile/low-spec — only the cloud path is available.';
  } else {
    applyBtn.textContent = originalApplyLabel || 'Apply';
  }

  const close = () => {
    modal.classList.add('hidden');
    applyBtn.onclick = null;
    cancelBtn.onclick = null;
    if (closeX) closeX.onclick = null;
    // Reset the cloud Apply button to its original label so the next
    // tool that doesn't relabel it starts from a clean state.
    applyBtn.textContent = originalApplyLabel || 'Apply';
    applyBtn.removeAttribute('title');
    applyBtn.style.display = '';
    deviceBtn?.remove();
    // Restore original geoms (memory hygiene) + clear any helper
    // overlays the preview hook added (Fill Holes boundary lines, ...).
    for (const e of mtState.origGeoms) { e.mesh.geometry = e.originalGeom; }
    _mtClearHelpers();
    // Tear down the draggable pivot widget so the next tool's modal
    // doesn't see a stale gizmo (and OrbitControls regains focus).
    if (mtState.transformControls) _mtDisableTransformGizmo();
  };
  cancelBtn.onclick = close;
  if (closeX) closeX.onclick = close;
  applyBtn.onclick = async () => {
    const vals = _mtCollectVals(body);
    if (schema.confirm && !confirm(schema.confirm)) return;
    const ctx = { imagePath: p.selectedImagePath, meshPath: p.selectedMeshPath };
    const params = schema.build(vals, ctx);
    close();
    runMeshTool(toolName, params);
  };
  if (deviceBtn) {
    deviceBtn.onclick = async () => {
      if (deviceBtn.disabled) return;
      if (schema.confirm && !confirm(schema.confirm)) return;
      const prevText = deviceBtn.textContent;
      deviceBtn.disabled = true;
      deviceBtn.textContent = 'Saving…';
      try {
        await _mtApplyOnDevice(toolName);
        close();
      } catch (e) {
        showToast(`${toolName} (device) failed: ${e?.message || e}`, 'error', 5000);
        deviceBtn.textContent = prevText;
        deviceBtn.disabled = false;
      }
    };
  }
  modal.classList.remove('hidden');

  // Init viewport then load mesh; preview kicks off once geoms are cached.
  requestAnimationFrame(async () => {
    await _mtInitViewport();
    _mtLoadMesh(p.selectedMeshPath);
  });
}

document.getElementById('ws-mesh-smooth-btn')?.addEventListener('click', () => openMeshToolModal('smooth'));
document.getElementById('ws-mesh-decimate-btn')?.addEventListener('click', () => openMeshToolModal('decimate'));
document.getElementById('ws-mesh-subdivide-btn')?.addEventListener('click', () => openMeshToolModal('subdivide'));
document.getElementById('ws-mesh-fixnormals-btn')?.addEventListener('click', () => openMeshToolModal('fix_normals'));
document.getElementById('ws-mesh-fillholes-btn')?.addEventListener('click', () => openMeshToolModal('fill_holes'));
document.getElementById('ws-mesh-watertight-btn')?.addEventListener('click', () => openMeshToolModal('watertight'));
document.getElementById('ws-mesh-center-btn')?.addEventListener('click', () => openMeshToolModal('center'));
document.getElementById('ws-mesh-retexture-btn')?.addEventListener('click', () => openMeshToolModal('retexture'));
document.getElementById('ws-mesh-trellis2-btn')?.addEventListener('click', () => openMeshToolModal('trellis2_retex'));

// ── Segment parts (AI) — SAMPart3D part-segmentation on cloud GPU ──
// Async spawn+poll (like auto-rig). Output = a segmented GLB (named,
// colored per-part submeshes) added as a new MESH version.
function openSegmentModal() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10200;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);';
    const box = document.createElement('div');
    box.style.cssText = 'background:#1b1d22;color:#eee;border:1px solid #3a3d44;border-radius:12px;padding:20px 22px;max-width:430px;width:90%;box-shadow:0 10px 40px rgba(0,0,0,.5);font-family:inherit;';
    box.innerHTML =
      '<div style="font-size:16px;font-weight:600;margin-bottom:6px;">✂ ' + FabI18n.t('Segment parts (AI)') + '</div>' +
      '<div style="font-size:13px;opacity:.8;line-height:1.4;margin-bottom:16px;">' +
        FabI18n.t('Split the mesh into semantic parts (head / torso / arms / legs — wheel / chassis / cabin). Runs on cloud GPU (SAMPart3D), ~8 min. The result is added as a new colored mesh version.') +
      '</div>' +
      '<label style="font-size:13px;font-weight:500;">' + FabI18n.t('Granularity') + ': <span id="seg-gran-label"></span></label>' +
      '<input id="seg-gran" type="range" min="0" max="2" step="0.5" value="1" style="width:100%;margin:8px 0 4px;">' +
      '<div style="display:flex;justify-content:space-between;font-size:11px;opacity:.65;margin-bottom:18px;">' +
        '<span>' + FabI18n.t('Fine (more parts)') + '</span><span>' + FabI18n.t('Coarse (fewer parts)') + '</span></div>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end;">' +
        '<button id="seg-cancel" class="ghost-btn" style="padding:8px 16px;">' + FabI18n.t('Cancel') + '</button>' +
        '<button id="seg-go" class="primary-btn" style="padding:8px 16px;">' + FabI18n.t('Segment') + '</button></div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const slider = box.querySelector('#seg-gran');
    const label = box.querySelector('#seg-gran-label');
    const names = { '0': FabI18n.t('Very fine'), '0.5': FabI18n.t('Fine'), '1': FabI18n.t('Medium'), '1.5': FabI18n.t('Coarse'), '2': FabI18n.t('Very coarse') };
    const sync = () => { label.textContent = names[slider.value] || slider.value; };
    slider.addEventListener('input', sync); sync();
    function cleanup(val) { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(val); }
    function onKey(e) { if (e.key === 'Escape') cleanup(null); }
    box.querySelector('#seg-cancel').addEventListener('click', () => cleanup(null));
    box.querySelector('#seg-go').addEventListener('click', () => cleanup(parseFloat(slider.value)));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });
    document.addEventListener('keydown', onKey);
  });
}

document.getElementById('ws-mesh-segment-btn')?.addEventListener('click', async () => {
  const p = state.currentProject;
  if (!p) return;
  const meshPathToUse = p.selectedMeshPath
    || (p.meshes && p.meshes[0] && p.meshes[0].path);
  if (!meshPathToUse) { showToast(FabI18n.t('Pick or generate a mesh first.'), 'error'); return; }
  if (!API.meshSegmentAI) { showToast('Segmentation backend not available.', 'error'); return; }
  const scale = await openSegmentModal();
  if (scale == null) return;  // cancelled
  const expectedMs = 480000;  // ~8 min A100 (train 5000 iters + render + SAM)
  gatedRun('mesh', `Segment parts: ${p.name}`, async () => {
    const job = pushJob(`Segment parts (AI): ${p.name}`, null, {
      Granularity: scale.toFixed(1),
      'Source mesh': String(meshPathToUse).split(/[/\\]/).pop(),
    }, expectedMs);
    try {
      const r = await API.meshSegmentAI({
        meshPath: meshPathToUse,
        scale,
        projectName: p.name,
        onProgress: ({ polls, elapsedMs, lastWarn }) => {
          const j = state.jobs.find(x => x.id === job.id);
          if (!j || j.status !== 'running') return;
          j.bridgeReporting = true;
          const overTime = Math.max(0, elapsedMs - expectedMs);
          const target = Math.min(99, 90 + Math.min(9, overTime / 20000));
          if (target > (j.progress || 0)) j.progress = target;
          j.subtitle = (elapsedMs > expectedMs)
            ? `Still segmenting... ${Math.floor(elapsedMs / 60000)}m ${Math.floor((elapsedMs % 60000) / 1000)}s (Modal cold start probable)`
            : `Polling Modal (${polls} polls)`;
          if (lastWarn) j.subtitle += ` — last warn: ${String(lastWarn).slice(0, 80)}`;
          renderJobs();
        },
      });
      if (r?.success) {
        completeJob(job.id, true);
        const newUrl = r.mesh_url || r.glb_url || r.path;
        if (newUrl) {
          const filename = String(newUrl).split('/').pop() || 'segmented.glb';
          p.meshes = p.meshes || [];
          p.meshes.unshift({ path: newUrl, filename, size: 0, mtime: Date.now() });
          p.selectedMeshPath = newUrl;
          p.previewMeshPath = newUrl;
        }
        populateWorkspace(p);
        showToast(FabI18n.t('Segmentation done — parts version added.'), 'success');
      } else {
        completeJob(job.id, false, r?.error || 'unknown');
        if (!job.cancelled) reportPipelineError(r?.error, 'Segmentation failed');
      }
    } catch (e) {
      completeJob(job.id, false, e?.error || e?.message || String(e));
      if (!job.cancelled) reportPipelineError(e?.error || e?.message || String(e), 'Segmentation error');
    }
  });
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
    // GLTFLoader is already imported at the top of this file — the
    // dynamic './lib/loaders/...' path doesn't exist in the cloud
    // build, which is why Align Texture opened then never loaded the
    // mesh (the dynamic import would throw and the user saw an empty
    // modal).
    const loader = new GLTFLoader();
    // Use the path as-is when it's already an absolute URL (R2 / blob
    // / data); only the desktop-style raw filesystem path gets the
    // file:// prefix.
    const url = _atResolveUrl(meshPath);
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

// Resolve a project asset path to a fetchable URL: pass through if it
// already has a scheme (http/https/blob/data), prepend file:// for raw
// disk paths. Used by Align Texture's loaders so they work on cloud
// (R2 URLs) as well as desktop.
function _atResolveUrl(path) {
  if (!path) return '';
  return /^[a-z]+:/i.test(path) ? path : _toFileUrl(path);
}

function _atMakeOverlayPlane(imgPath, opacity) {
  const tex = new THREE.TextureLoader().load(
    _atResolveUrl(imgPath) + '?t=' + Date.now()
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
      _atResolveUrl(p.selectedImagePath) + '?t=' + Date.now()
    );
    atState.frontTex.colorSpace = THREE.SRGBColorSpace;
  }
  const backPath = p._backPhotos?.[p.selectedImagePath] || p.backImagePath;
  if (backPath && !atState.backTex) {
    atState.backTex = new THREE.TextureLoader().load(
      _atResolveUrl(backPath) + '?t=' + Date.now()
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

// ============================================================
// PAINT EMISSIVE TOOL — raycast-driven painting onto a separate
// emissive texture. UX is inspired by the user's BuildingSlicer
// plugin (apovivor): a dedicated T_emissive map + color tint +
// intensity scalar; here those values feed THREE.MeshStandardMaterial's
// emissiveMap + emissiveIntensity. Painted texture is embedded in the
// GLB at Apply time and uploaded for FREE via /api/mesh-op/client-result.
// ============================================================
const PE_TEX_SIZE = 1024;

const peState = {
  renderer: null, scene: null, camera: null, controls: null,
  rafId: null,
  origModel: null,
  meshes: [],                  // array of { mesh, prev: [{ mat, emissiveMap, ... }] }
  raycaster: null,
  pointer: null,
  canvases: null,              // Map<Mesh, { canvas, ctx, texture }>
  brushColor: '#ffaa33',
  brushSize: 40,
  brushOpacity: 1.0,
  brushFalloff: 0.5,
  brushMode: 'paint',          // 'paint' | 'erase'
  intensity: 1.0,              // 1.0 = canvas color is the emissive 1:1; >1 boosts brightness (HDR)
  isPainting: false,
  // Undo/redo: snapshots of every canvas at the END of each stroke.
  // Each snapshot is Map<Mesh, ImageData>. Capped to avoid runaway
  // memory on long sessions.
  history: [],
  historyIndex: -1,
};
const PE_HISTORY_MAX = 30;
function _peSnapshotAll() {
  if (!peState.canvases) return null;
  const snap = new Map();
  peState.canvases.forEach((entry, mesh) => {
    snap.set(mesh, entry.ctx.getImageData(0, 0, PE_TEX_SIZE, PE_TEX_SIZE));
  });
  return snap;
}
function _peApplySnapshot(snap) {
  if (!snap) return;
  peState.canvases?.forEach((entry, mesh) => {
    const img = snap.get(mesh);
    if (!img) return;
    entry.ctx.putImageData(img, 0, 0);
    entry.texture.needsUpdate = true;
  });
}
function _peHistoryPush() {
  const snap = _peSnapshotAll();
  if (!snap) return;
  peState.history.length = peState.historyIndex + 1;
  peState.history.push(snap);
  if (peState.history.length > PE_HISTORY_MAX) peState.history.shift();
  peState.historyIndex = peState.history.length - 1;
  _peUpdateUndoRedoButtons();
}
function _peUndo() {
  if (peState.historyIndex <= 0) return;
  peState.historyIndex--;
  _peApplySnapshot(peState.history[peState.historyIndex]);
  _peUpdateUndoRedoButtons();
}
function _peRedo() {
  if (peState.historyIndex >= peState.history.length - 1) return;
  peState.historyIndex++;
  _peApplySnapshot(peState.history[peState.historyIndex]);
  _peUpdateUndoRedoButtons();
}
function _peUpdateUndoRedoButtons() {
  const u = document.getElementById('pe-undo');
  const r = document.getElementById('pe-redo');
  if (u) u.disabled = peState.historyIndex <= 0;
  if (r) r.disabled = peState.historyIndex >= peState.history.length - 1;
}

async function _peInitViewport() {
  if (peState.renderer) return;
  const canvas = document.getElementById('pe-canvas');
  const wrap = document.getElementById('pe-viewport-wrap');
  if (!canvas || !wrap) return;
  const w = wrap.clientWidth || 800;
  const h = wrap.clientHeight || 560;
  peState.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  peState.renderer.setSize(w, h, false);
  peState.renderer.setPixelRatio(window.devicePixelRatio);
  peState.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  peState.renderer.toneMappingExposure = 1.0;
  peState.scene = new THREE.Scene();
  peState.scene.background = new THREE.Color(0x0b0b14);
  peState.camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 100);
  peState.camera.position.set(0, 0.5, 2);
  try {
    peState.controls = new OrbitControls(peState.camera, canvas);
    peState.controls.enableDamping = true;
    // Left-click is reserved for painting; orbit on right, pan on middle.
    peState.controls.mouseButtons = {
      LEFT: null,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.ROTATE,
    };
  } catch (e) { console.error('[paint-emissive] OrbitControls error:', e); }
  peState.scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.0));
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(5, 8, 5);
  peState.scene.add(dir);
  const fill = new THREE.DirectionalLight(0xffffff, 0.5);
  fill.position.set(-5, 3, -5);
  peState.scene.add(fill);
  peState.scene.add(new THREE.AmbientLight(0xffffff, 0.3));
  peState.scene.add(new THREE.GridHelper(2, 20, 0x444466, 0x333355));
  peState.raycaster = new THREE.Raycaster();
  peState.pointer = new THREE.Vector2();
  const tick = () => {
    if (!document.getElementById('modal-paint-emissive')?.classList.contains('hidden')) {
      peState.controls?.update();
      peState.renderer.render(peState.scene, peState.camera);
    }
    peState.rafId = requestAnimationFrame(tick);
  };
  tick();
  new ResizeObserver(() => {
    const cw = wrap.clientWidth, ch = wrap.clientHeight;
    if (cw > 0 && ch > 0) {
      peState.renderer.setSize(cw, ch, false);
      peState.camera.aspect = cw / ch;
      peState.camera.updateProjectionMatrix();
    }
  }).observe(wrap);
}

// Build ONE 1024×1024 paint canvas PER submesh + bind each as its
// material's emissiveMap. Per-submesh canvases are critical when the
// mesh has overlapping UV layouts across submeshes (the common case
// for Trellis2 output) — a single shared canvas would mean painting
// one spot lit up unrelated geometry that shared the same UV region.
function _peSetupCanvasAndBind() {
  peState.canvases = new Map();   // mesh → { canvas, ctx, texture }
  peState.meshes.forEach((entry) => {
    const canvas = document.createElement('canvas');
    canvas.width = PE_TEX_SIZE;
    canvas.height = PE_TEX_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, PE_TEX_SIZE, PE_TEX_SIZE);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false;             // glTF UV convention
    texture.name = 'T_emissive';        // surfaces in the GLB metadata
    texture.needsUpdate = true;
    peState.canvases.set(entry.mesh, { canvas, ctx, texture });

    const m = entry.mesh.material;
    const mats = Array.isArray(m) ? m : [m];
    entry.prev = mats.map((mat) => ({
      mat,
      emissiveMap: mat.emissiveMap,
      emissiveIntensity: mat.emissiveIntensity,
      emissive: mat.emissive?.clone(),
    }));
    mats.forEach((mat) => {
      mat.emissiveMap = texture;
      mat.emissive = new THREE.Color(0xffffff);  // white tint, the canvas carries the per-pixel color
      mat.emissiveIntensity = peState.intensity;
      mat.needsUpdate = true;
    });
  });
  // Reset history with the blank canvases as the base state so the
  // first undo brings the user back to "nothing painted".
  peState.history = [];
  peState.historyIndex = -1;
  _peHistoryPush();
}

function _peRestoreMaterials() {
  peState.meshes.forEach((entry) => {
    if (!entry.prev) return;
    entry.prev.forEach(({ mat, emissiveMap, emissiveIntensity, emissive }) => {
      mat.emissiveMap = emissiveMap;
      mat.emissiveIntensity = emissiveIntensity;
      if (emissive) mat.emissive = emissive;
      mat.needsUpdate = true;
    });
  });
}

function _peLoadMesh(meshPath) {
  // Clean any previous load.
  if (peState.origModel) {
    peState.scene.remove(peState.origModel);
    peState.origModel = null;
  }
  peState.meshes = [];
  const url = (typeof meshPath === 'string' && /^[a-z]+:/i.test(meshPath))
    ? meshPath
    : _toFileUrl(meshPath);
  fetch(url, { credentials: 'omit' })
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
    .then((buffer) => {
      const loader = new GLTFLoader();
      loader.parse(buffer, '', (gltf) => {
        peState.origModel = gltf.scene;
        peState.scene.add(peState.origModel);
        const box = new THREE.Box3().setFromObject(peState.origModel);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        peState.origModel.position.sub(center);
        peState.origModel.position.y += size.y / 2;
        peState.camera.position.set(0, size.y * 0.5, maxDim * 2);
        peState.controls?.target.set(0, size.y * 0.5, 0);
        peState.controls?.update();
        peState.origModel.traverse((child) => {
          if (child.isMesh && child.geometry && child.material) {
            peState.meshes.push({ mesh: child });
          }
        });
        _peSetupCanvasAndBind();
        // Auto-project the image emissive layer (if the project has
        // one for the source image) onto the mesh's T_emissive canvas.
        // Asynchronous; shows a toast when done.
        _peTryProjectFromImageLayer();
      });
    })
    .catch((e) => {
      console.error('[paint-emissive] load failed:', e);
      if (typeof showToast === 'function') {
        showToast('Mesh load failed: ' + (e?.message || e), 'error', 5000);
      }
    });
}

// Raycast at the current pointer position. Returns the hit { object,
// uv } or null. Only considers the loaded mesh's submeshes (NOT the
// grid or any helper) so painting can't be confused by background
// geometry.
function _peRaycast(clientX, clientY) {
  if (!peState.origModel || !peState.raycaster) return null;
  const canvas = peState.renderer.domElement;
  const rect = canvas.getBoundingClientRect();
  const x = ((clientX - rect.left) / rect.width)  *  2 - 1;
  const y = ((clientY - rect.top)  / rect.height) * -2 + 1;
  peState.pointer.set(x, y);
  peState.raycaster.setFromCamera(peState.pointer, peState.camera);
  const meshes = peState.meshes.map((e) => e.mesh);
  const hits = peState.raycaster.intersectObjects(meshes, false);
  if (!hits.length || !hits[0].uv) return null;
  return hits[0];
}

// Paint a soft circle into the canvas that owns the hit submesh, at
// uv × canvasSize. Brush parameters all come from the modal sliders.
// Painting goes ONLY into the hit mesh's own canvas — never to other
// submeshes that share the same UV region.
function _peStampAtPointer(clientX, clientY) {
  const hit = _peRaycast(clientX, clientY);
  if (!hit) return;
  const entry = peState.canvases?.get(hit.object);
  if (!entry) return;
  const ctx = entry.ctx;
  const TEX = PE_TEX_SIZE;
  const px = Math.max(0, Math.min(1, hit.uv.x)) * TEX;
  const py = Math.max(0, Math.min(1, hit.uv.y)) * TEX;
  const r = Math.max(1, peState.brushSize * 0.5);
  const fall = Math.max(0, Math.min(1, peState.brushFalloff));
  const innerColor = peState.brushMode === 'erase'
    ? `rgba(0, 0, 0, ${peState.brushOpacity})`
    : _peHexToRgba(peState.brushColor, peState.brushOpacity);
  const edgeColor = peState.brushMode === 'erase'
    ? 'rgba(0, 0, 0, 0)'
    : _peHexToRgba(peState.brushColor, 0);
  const grad = ctx.createRadialGradient(px, py, 0, px, py, r);
  grad.addColorStop(0, innerColor);
  grad.addColorStop(1 - fall, innerColor);
  grad.addColorStop(1, edgeColor);

  const mesh = hit.object;
  const geom = mesh.geometry;
  const uvAttr = geom.attributes.uv;
  const posAttr = geom.attributes.position;
  const idx = geom.index?.array;

  ctx.globalCompositeOperation = peState.brushMode === 'erase' ? 'destination-out' : 'source-over';

  if (!uvAttr || !posAttr) {
    // No UVs → fall back to plain disc stamp.
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    entry.texture.needsUpdate = true;
    return;
  }

  // 3D-aware stamping: only paint canvas regions that come from
  // triangles physically close to the hit point. This kills the
  // "stray paint on the ground when I clicked the sign" issue caused
  // by overlapping UV islands in Trellis2's texture atlas — far-away
  // mesh parts that happen to share UV space with the hit no longer
  // pick up the brush.
  const localHit = mesh.worldToLocal(hit.point.clone());
  // 3D brush radius scales with the brush's CSS pixel size and the
  // camera-to-hit distance via the perspective FOV (so a 40-px brush
  // covers a similar mesh footprint regardless of zoom).
  const cam = peState.camera;
  const camDist = cam.position.distanceTo(hit.point);
  const viewH = peState.renderer.domElement.clientHeight || 600;
  const heightAtDist = 2 * camDist * Math.tan((cam.fov * Math.PI / 180) / 2);
  const unitsPerPx = heightAtDist / viewH;
  const R3D = peState.brushSize * 0.5 * unitsPerPx * 1.2; // 1.2 = small overshoot so triangle edges aren't clipped
  const R3DSq = R3D * R3D;

  const posArr = posAttr.array;
  const uvArr = uvAttr.array;
  const triCount = idx ? Math.floor(idx.length / 3) : Math.floor(posAttr.count / 3);

  // Clip the canvas operations to the brush circle around the hit UV
  // — combined with the per-triangle fills below, this gives a soft,
  // gradient-shaped paint that respects 3D locality.
  ctx.save();
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = grad;

  for (let t = 0; t < triCount; t++) {
    const i0 = idx ? idx[t*3]   : t*3;
    const i1 = idx ? idx[t*3+1] : t*3+1;
    const i2 = idx ? idx[t*3+2] : t*3+2;
    const p0x = posArr[i0*3],   p0y = posArr[i0*3+1], p0z = posArr[i0*3+2];
    const p1x = posArr[i1*3],   p1y = posArr[i1*3+1], p1z = posArr[i1*3+2];
    const p2x = posArr[i2*3],   p2y = posArr[i2*3+1], p2z = posArr[i2*3+2];
    // Reject the triangle if all 3 vertices are outside the 3D
    // brush sphere. Cheap and good enough for an interactive tool.
    const d0 = (p0x-localHit.x)**2 + (p0y-localHit.y)**2 + (p0z-localHit.z)**2;
    if (d0 < R3DSq) { /* keep */ }
    else {
      const d1 = (p1x-localHit.x)**2 + (p1y-localHit.y)**2 + (p1z-localHit.z)**2;
      if (d1 < R3DSq) { /* keep */ }
      else {
        const d2 = (p2x-localHit.x)**2 + (p2y-localHit.y)**2 + (p2z-localHit.z)**2;
        if (d2 >= R3DSq) continue;
      }
    }
    // Fill the triangle on the canvas — the clip path above limits
    // the actual painted area to the brush circle intersection.
    const u0x = uvArr[i0*2] * TEX, u0y = uvArr[i0*2+1] * TEX;
    const u1x = uvArr[i1*2] * TEX, u1y = uvArr[i1*2+1] * TEX;
    const u2x = uvArr[i2*2] * TEX, u2y = uvArr[i2*2+1] * TEX;
    ctx.beginPath();
    ctx.moveTo(u0x, u0y);
    ctx.lineTo(u1x, u1y);
    ctx.lineTo(u2x, u2y);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
  entry.texture.needsUpdate = true;
}

function _peHexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Project a saved image emissive layer onto each submesh's T_emissive
// canvas via front-view raycast. For every non-transparent pixel of
// the image layer, cast a ray from an orthographic front camera
// through that pixel into the mesh; the hit triangle's UV becomes
// the write target on its submesh's canvas.
//
// Returns true if the projection ran (a layer existed for the source
// image), false otherwise.
async function _peProjectImageLayer(imgPath) {
  const layerDataUrl = _emissiveLayerGet(imgPath);
  if (!layerDataUrl) return false;
  if (!peState.origModel || !peState.canvases) return false;
  if (peState.projecting) return false;
  peState.projecting = true;
  // GPU-baked projection: instead of N image_pixels × M triangles
  // raycasts (the old loop took 10-30 s on a 1024² × 100k-tri mesh),
  // we render each submesh once with a UV-encoding shader (R=u, G=v,
  // B=hit-mask), read the pixels back, and then for every painted
  // image pixel look up the canvas write position from that buffer.
  // ~100 ms total on a typical mesh.

  // Decode the image emissive layer into an off-screen canvas we can
  // sample pixel-by-pixel.
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = layerDataUrl;
  });
  const srcW = img.width, srcH = img.height;
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = srcW; srcCanvas.height = srcH;
  const srcCtx = srcCanvas.getContext('2d');
  srcCtx.drawImage(img, 0, 0);
  const srcData = srcCtx.getImageData(0, 0, srcW, srcH).data;
  // Pre-compute the bbox of non-transparent pixels — for a typical
  // user, only a small portion of the image carries strokes, so
  // iterating the WHOLE image was mostly wasted raycasts. We sample
  // every Nth row/col to find min/max, then only project within that
  // rectangle (with a small padding).
  let bbXmin = srcW, bbXmax = 0, bbYmin = srcH, bbYmax = 0;
  const scanStride = Math.max(1, Math.floor(Math.min(srcW, srcH) / 256));
  for (let y = 0; y < srcH; y += scanStride) {
    for (let x = 0; x < srcW; x += scanStride) {
      if (srcData[(y * srcW + x) * 4 + 3] >= 8) {
        if (x < bbXmin) bbXmin = x;
        if (x > bbXmax) bbXmax = x;
        if (y < bbYmin) bbYmin = y;
        if (y > bbYmax) bbYmax = y;
      }
    }
  }
  if (bbXmax < bbXmin || bbYmax < bbYmin) {
    peState.projecting = false;
    return false;  // nothing painted
  }
  const pad = scanStride * 2;
  bbXmin = Math.max(0, bbXmin - pad);
  bbYmin = Math.max(0, bbYmin - pad);
  bbXmax = Math.min(srcW - 1, bbXmax + pad);
  bbYmax = Math.min(srcH - 1, bbYmax + pad);

  // Set up an orthographic camera positioned at +Z, looking down -Z,
  // sized to encompass the model's XY footprint. This matches how the
  // user views their image-side painting (camera-facing view).
  const box = new THREE.Box3().setFromObject(peState.origModel);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  // Account for the framing lift we applied in _peLoadMesh
  // (origModel.position) so the camera is in WORLD space relative to
  // the actual displayed bounds.
  const halfW = size.x * 0.5 + 1e-4;
  const halfH = size.y * 0.5 + 1e-4;
  const orthoCam = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.01, size.z * 4 + 10);
  orthoCam.position.set(center.x, center.y, center.z + size.z * 2 + 1);
  orthoCam.lookAt(center.x, center.y, center.z);
  orthoCam.updateMatrixWorld();

  const TEX = PE_TEX_SIZE;
  const status = document.getElementById('pe-status');
  const RT_W = Math.min(srcW, 2048);
  const RT_H = Math.min(srcH, 2048);
  const renderTarget = new THREE.WebGLRenderTarget(RT_W, RT_H, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  const uvMat = new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: 'varying vec2 vUv; void main(){gl_FragColor=vec4(vUv.x,vUv.y,1.0,1.0);}',
    side: THREE.DoubleSide,
  });
  const uvBuffer = new Uint8Array(RT_W * RT_H * 4);
  const origRT = peState.renderer.getRenderTarget();
  let painted = 0;
  try {
    let submeshIdx = 0;
    for (const entry of peState.meshes) {
      submeshIdx++;
      const targetMesh = entry.mesh;
      const canvasEntry = peState.canvases.get(targetMesh);
      if (!canvasEntry) continue;
      // Render JUST this submesh by hiding the others.
      const visStates = peState.meshes.map((e) => ({ m: e.mesh, v: e.mesh.visible }));
      peState.meshes.forEach((e) => { e.mesh.visible = (e.mesh === targetMesh); });
      const origMat = targetMesh.material;
      targetMesh.material = uvMat;
      peState.renderer.setRenderTarget(renderTarget);
      peState.renderer.setClearColor(0x000000, 0);
      peState.renderer.clear();
      peState.renderer.render(peState.origModel, orthoCam);
      peState.renderer.readRenderTargetPixels(renderTarget, 0, 0, RT_W, RT_H, uvBuffer);
      targetMesh.material = origMat;
      visStates.forEach(({ m, v }) => { m.visible = v; });
      if (status) {
        status.textContent = `Projecting image emissive layer onto mesh… ${submeshIdx}/${peState.meshes.length}`;
      }
      await new Promise((r) => requestAnimationFrame(r));
      const ctx = canvasEntry.ctx;
      // Iterate painted pixels inside the bbox; look up the matching
      // entry in the UV buffer (Y flipped: image is top-down, ReadPixels
      // is bottom-up).
      for (let y = bbYmin; y <= bbYmax; y++) {
        const ry = RT_H - 1 - Math.round((y / srcH) * RT_H);
        if (ry < 0 || ry >= RT_H) continue;
        const ryRow = ry * RT_W * 4;
        const srcRow = y * srcW * 4;
        for (let x = bbXmin; x <= bbXmax; x++) {
          const si = srcRow + x * 4;
          const a = srcData[si + 3];
          if (a < 8) continue;
          const rx = Math.round((x / srcW) * RT_W);
          if (rx < 0 || rx >= RT_W) continue;
          const ri = ryRow + rx * 4;
          if (uvBuffer[ri + 2] < 200) continue;  // no mesh at this pixel
          const px = (uvBuffer[ri] / 255) * TEX;
          const py = (uvBuffer[ri + 1] / 255) * TEX;
          ctx.fillStyle = `rgba(${srcData[si]}, ${srcData[si+1]}, ${srcData[si+2]}, ${a / 255})`;
          // 4×4 splat fills the gaps left by the 256-level UV encoding.
          ctx.fillRect(px - 2, py - 2, 4, 4);
          painted++;
        }
      }
      canvasEntry.texture.needsUpdate = true;
    }
  } finally {
    peState.renderer.setRenderTarget(origRT);
    renderTarget.dispose();
    uvMat.dispose();
    peState.projecting = false;
  }
  return painted > 0;
}

async function _peTryProjectFromImageLayer() {
  if (peState.projecting) return;  // one projection at a time
  const p = state.currentProject;
  if (!p) return;
  let imgPath = p.selectedImagePath || p.previewImagePath;
  if (!imgPath || !_emissiveLayerHas(imgPath)) {
    const projImgs = (p.images || []).map((im) => im.path);
    imgPath = projImgs.find(_emissiveLayerHas);
    if (!imgPath) return;
  }
  try {
    if (typeof showToast === 'function') {
      showToast('Projecting image emissive layer onto mesh…', 'info', 1800);
    }
    const ok = await _peProjectImageLayer(imgPath);
    if (ok) {
      // Reset history so undo doesn't go past the projection state.
      peState.history = [];
      peState.historyIndex = -1;
      _peHistoryPush();
      if (typeof showToast === 'function') {
        showToast('Image emissive layer projected onto T_emissive', 'success', 2000);
      }
    }
  } catch (e) {
    console.warn('[paint-emissive] image-layer projection failed:', e);
  }
}

function openPaintEmissive() {
  const p = state.currentProject;
  if (!p || !p.selectedMeshPath) { showToast('Pick a mesh first.', 'error'); return; }
  const modal = document.getElementById('modal-paint-emissive');
  if (!modal) return;
  modal.classList.remove('hidden');

  // Hook up the brush controls (idempotent — we just overwrite handlers).
  const $ = (id) => document.getElementById(id);
  const sync = (id, valId, parse, sink) => {
    const el = $(id), lab = $(valId);
    if (!el) return;
    el.oninput = () => {
      const v = parse(el.value);
      sink(v);
      if (lab) lab.textContent = String(el.value);
    };
  };
  $('pe-color').oninput = (e) => { peState.brushColor = e.target.value; };
  peState.brushColor = $('pe-color').value;
  sync('pe-intensity', 'pe-intensity-val', Number, (v) => {
    peState.intensity = v;
    peState.meshes.forEach((entry) => {
      const mats = Array.isArray(entry.mesh.material) ? entry.mesh.material : [entry.mesh.material];
      mats.forEach((m) => { m.emissiveIntensity = v; m.needsUpdate = true; });
    });
  });
  sync('pe-brush-size', 'pe-brush-size-val', Number, (v) => { peState.brushSize = v; });
  $('pe-brush-opacity-val').textContent = $('pe-brush-opacity').value + '%';
  $('pe-brush-opacity').oninput = (e) => {
    peState.brushOpacity = Number(e.target.value) / 100;
    $('pe-brush-opacity-val').textContent = e.target.value + '%';
  };
  $('pe-brush-falloff').oninput = (e) => {
    peState.brushFalloff = Number(e.target.value) / 100;
    $('pe-brush-falloff-val').textContent = e.target.value + '%';
  };
  $('pe-brush-falloff-val').textContent = $('pe-brush-falloff').value + '%';
  const paintBtn = $('pe-mode-paint');
  const eraseBtn = $('pe-mode-erase');
  const setMode = (mode) => {
    peState.brushMode = mode;
    paintBtn.style.background = mode === 'paint' ? 'var(--accent, #5a4fcf)' : '';
    paintBtn.style.color      = mode === 'paint' ? '#fff' : '';
    eraseBtn.style.background = mode === 'erase' ? 'var(--accent, #5a4fcf)' : '';
    eraseBtn.style.color      = mode === 'erase' ? '#fff' : '';
  };
  paintBtn.onclick = () => setMode('paint');
  eraseBtn.onclick = () => setMode('erase');
  $('pe-clear').onclick = () => {
    if (!peState.canvases) return;
    peState.canvases.forEach((entry) => {
      entry.ctx.fillStyle = '#000000';
      entry.ctx.fillRect(0, 0, PE_TEX_SIZE, PE_TEX_SIZE);
      entry.texture.needsUpdate = true;
    });
    _peHistoryPush();
  };
  $('pe-undo').onclick = () => _peUndo();
  $('pe-redo').onclick = () => _peRedo();
  $('pe-load-image-layer').onclick = async () => {
    const btn = $('pe-load-image-layer');
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'Projecting…';
    try {
      await _peTryProjectFromImageLayer();
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  };
  // Toggle the emissive texture on/off — flips material.emissiveMap
  // between our canvas and null on every submesh, leaving the painted
  // canvas data intact so the user can flip back and forth without
  // losing work. Acts like "preview with vs without my emissive".
  let emissiveOn = true;
  $('pe-toggle-emissive').onclick = () => {
    if (!peState.canvases) return;
    emissiveOn = !emissiveOn;
    peState.canvases.forEach((entry, mesh) => {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((mat) => {
        mat.emissiveMap = emissiveOn ? entry.texture : null;
        mat.needsUpdate = true;
      });
    });
    const btn = $('pe-toggle-emissive');
    btn.textContent = emissiveOn ? '💡 Emissive ON' : '🌑 Emissive OFF';
    btn.style.background = emissiveOn ? 'var(--accent, #5a4fcf)' : '';
    btn.style.color = emissiveOn ? '#fff' : '';
  };
  // Keyboard: Ctrl/Cmd+Z = undo, Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z = redo.
  const onKey = (e) => {
    if (modal.classList.contains('hidden')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    if (e.key === 'z' || e.key === 'Z') {
      e.preventDefault();
      if (e.shiftKey) _peRedo(); else _peUndo();
    } else if (e.key === 'y' || e.key === 'Y') {
      e.preventDefault();
      _peRedo();
    }
  };
  document.addEventListener('keydown', onKey);

  // Init viewport then load mesh.
  requestAnimationFrame(async () => {
    await _peInitViewport();
    // Set up a CSS brush preview that follows the cursor over the
    // viewport. It's an unscaled CSS-pixel circle (size = brushSize)
    // — not pixel-perfect against the UV footprint, but a clear
    // indicator of "where the brush is" + "how big it roughly is".
    const wrap = document.getElementById('pe-viewport-wrap');
    let preview = document.getElementById('pe-brush-preview');
    if (!preview) {
      preview = document.createElement('div');
      preview.id = 'pe-brush-preview';
      preview.style.cssText = 'position:absolute; border:2px solid #ffe066; border-radius:50%; pointer-events:none; transform:translate(-50%,-50%); box-shadow:0 0 4px rgba(0,0,0,0.5); display:none; z-index:10;';
      wrap.appendChild(preview);
    }
    const cv = peState.renderer.domElement;
    const updateBrushPreview = (e) => {
      const rect = wrap.getBoundingClientRect();
      preview.style.left = `${e.clientX - rect.left}px`;
      preview.style.top  = `${e.clientY - rect.top}px`;
      preview.style.width  = `${peState.brushSize}px`;
      preview.style.height = `${peState.brushSize}px`;
      preview.style.borderColor = peState.brushMode === 'erase' ? '#ff4466' : peState.brushColor;
      preview.style.display = 'block';
    };
    const down = (e) => {
      if (e.button !== 0) return;  // only left click
      peState.isPainting = true;
      cv.setPointerCapture(e.pointerId);
      _peStampAtPointer(e.clientX, e.clientY);
    };
    const move = (e) => {
      updateBrushPreview(e);
      if (!peState.isPainting) return;
      _peStampAtPointer(e.clientX, e.clientY);
    };
    const up = (e) => {
      if (peState.isPainting) {
        peState.isPainting = false;
        // End of stroke → snapshot every canvas for undo.
        _peHistoryPush();
      }
      try { cv.releasePointerCapture(e.pointerId); } catch {}
    };
    const leave = () => { preview.style.display = 'none'; };
    cv.onpointerdown = down;
    cv.onpointermove = move;
    cv.onpointerup = up;
    cv.onpointercancel = up;
    cv.onpointerleave = leave;
    _peLoadMesh(p.selectedMeshPath);
  });

  const close = (restore) => {
    modal.classList.add('hidden');
    if (restore) _peRestoreMaterials();
    const preview = document.getElementById('pe-brush-preview');
    if (preview) preview.style.display = 'none';
  };
  $('pe-cancel').onclick = () => close(true);
  $('pe-apply-device').onclick = async () => {
    const btn = $('pe-apply-device');
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      await _peApplyOnDevice();
      close(false);
    } catch (e) {
      showToast(`Paint Emissive failed: ${e?.message || e}`, 'error', 5000);
      btn.textContent = orig;
      btn.disabled = false;
    }
  };
}

async function _peApplyOnDevice() {
  if (!peState.origModel) throw new Error('no model loaded');
  // Zero out the framing offset for export so the saved GLB origin
  // matches the source mesh.
  const savedPos = peState.origModel.position.clone();
  peState.origModel.position.set(0, 0, 0);
  try {
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    const exporter = new GLTFExporter();
    const arrayBuffer = await new Promise((resolve, reject) => {
      exporter.parse(
        peState.origModel,
        (result) => (result instanceof ArrayBuffer)
          ? resolve(result)
          : reject(new Error('GLTFExporter returned non-binary output')),
        (err) => reject(err),
        { binary: true, embedImages: true },
      );
    });
    const bytes = new Uint8Array(arrayBuffer);
    // Reuse the client-result endpoint that the other free tools use
    // (auth + magic-byte check + R2 store, no credit charge). Paint
    // Emissive isn't on the server allowlist, so we tunnel through
    // 'center' purely to store the modified GLB.
    const data = await uploadClientMeshResult(bytes, 'center');
    const newUrl = data.path || data.newPath || data.mesh_url;
    showToast('Paint Emissive applied (free, on device)', 'success');
    const p = state.currentProject;
    if (p && newUrl) {
      const filename = String(newUrl).split('/').pop() || 'paint_emissive.glb';
      p.meshes = p.meshes || [];
      p.meshes.unshift({ path: newUrl, filename, size: 0, mtime: Date.now() });
      p.selectedMeshPath = newUrl;
      p.previewMeshPath = newUrl;
      if (typeof populateWorkspace === 'function') {
        try { await populateWorkspace(p); } catch {}
      }
    }
  } finally {
    peState.origModel.position.copy(savedPos);
  }
}

// Both Manual Tools buttons funnel into the unified Paint Mesh modal —
// "Paint Emissive" just pre-toggles the emissive layer so the user
// lands directly on the glow workflow without an extra click.
document.getElementById('ws-mesh-paint-emissive-btn')?.addEventListener('click', () => openPaintMesh({ emissiveMode: true }));

// ============================================================
// PAINT MESH TOOL — paint directly on the diffuse texture
// (material.map) via the same raycast-to-UV pipeline used by Paint
// Emissive. UI is patterned on the 2D Paint Tools sidebar (Pen /
// Spray / Ink / Eraser + color + brush / opacity / falloff sliders).
// Canvas is initialised from each submesh's current map so the
// user paints on top of the existing texture.
// ============================================================
const pmState = {
  renderer: null, scene: null, camera: null, controls: null,
  rafId: null,
  origModel: null,
  meshes: [],                  // [{ mesh, prev: [{mat, mapWas, emissiveMapWas, emissiveWas, emissiveIntensityWas}] }]
  raycaster: null,
  pointer: null,
  // Map<Mesh, {
  //   diffuse:  { canvas, ctx, texture, w, h },
  //   emissive: { canvas, ctx, texture, w, h }  ← created lazily
  // }>
  canvases: null,
  tool: 'pen',                 // 'pen' | 'spray' | 'ink' | 'eraser'
  color: '#ff0000',
  brushSize: 20,
  opacity: 1.0,
  falloff: 0.3,
  emissiveMode: false,         // false = paint diffuse map, true = paint emissive map
  isPainting: false,
  history: [],
  historyIndex: -1,
};
const PM_HISTORY_MAX = 20;

// Pick the active layer (diffuse vs emissive) for the current
// emissiveMode. Used by stamp, history snapshot, restore.
function _pmActiveLayer(entry) {
  return pmState.emissiveMode ? entry.emissive : entry.diffuse;
}
function _pmSnapshotAll() {
  if (!pmState.canvases) return null;
  const snap = new Map();
  pmState.canvases.forEach((entry, mesh) => {
    const L = _pmActiveLayer(entry);
    if (!L) return;
    snap.set(mesh, { mode: pmState.emissiveMode, img: L.ctx.getImageData(0, 0, L.w, L.h) });
  });
  return snap;
}
function _pmApplySnapshot(snap) {
  if (!snap) return;
  pmState.canvases?.forEach((entry, mesh) => {
    const s = snap.get(mesh);
    if (!s) return;
    const L = s.mode ? entry.emissive : entry.diffuse;
    if (!L) return;
    L.ctx.putImageData(s.img, 0, 0);
    L.texture.needsUpdate = true;
  });
}
function _pmHistoryPush() {
  const snap = _pmSnapshotAll();
  if (!snap) return;
  pmState.history.length = pmState.historyIndex + 1;
  pmState.history.push(snap);
  if (pmState.history.length > PM_HISTORY_MAX) pmState.history.shift();
  pmState.historyIndex = pmState.history.length - 1;
  _pmUpdateUndoRedo();
}
function _pmUndo() {
  if (pmState.historyIndex <= 0) return;
  pmState.historyIndex--;
  _pmApplySnapshot(pmState.history[pmState.historyIndex]);
  _pmUpdateUndoRedo();
}
function _pmRedo() {
  if (pmState.historyIndex >= pmState.history.length - 1) return;
  pmState.historyIndex++;
  _pmApplySnapshot(pmState.history[pmState.historyIndex]);
  _pmUpdateUndoRedo();
}
function _pmUpdateUndoRedo() {
  const u = document.getElementById('pm-undo');
  const r = document.getElementById('pm-redo');
  if (u) u.disabled = pmState.historyIndex <= 0;
  if (r) r.disabled = pmState.historyIndex >= pmState.history.length - 1;
}

async function _pmInitViewport() {
  if (pmState.renderer) return;
  const canvas = document.getElementById('pm-canvas');
  const wrap = document.getElementById('pm-viewport-wrap');
  if (!canvas || !wrap) return;
  const w = wrap.clientWidth || 800;
  const h = wrap.clientHeight || 560;
  pmState.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  pmState.renderer.setSize(w, h, false);
  pmState.renderer.setPixelRatio(window.devicePixelRatio);
  pmState.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  pmState.renderer.toneMappingExposure = 1.0;
  pmState.scene = new THREE.Scene();
  pmState.scene.background = new THREE.Color(0x0b0b14);
  pmState.camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 100);
  pmState.camera.position.set(0, 0.5, 2);
  try {
    pmState.controls = new OrbitControls(pmState.camera, canvas);
    pmState.controls.enableDamping = true;
    pmState.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
  } catch (e) { console.error('[paint-mesh] OrbitControls:', e); }
  pmState.scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.0));
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(5, 8, 5); pmState.scene.add(dir);
  const fill = new THREE.DirectionalLight(0xffffff, 0.5);
  fill.position.set(-5, 3, -5); pmState.scene.add(fill);
  pmState.scene.add(new THREE.AmbientLight(0xffffff, 0.3));
  pmState.scene.add(new THREE.GridHelper(2, 20, 0x444466, 0x333355));
  pmState.raycaster = new THREE.Raycaster();
  pmState.pointer = new THREE.Vector2();
  const tick = () => {
    if (!document.getElementById('modal-paint-mesh')?.classList.contains('hidden')) {
      pmState.controls?.update();
      pmState.renderer.render(pmState.scene, pmState.camera);
    }
    pmState.rafId = requestAnimationFrame(tick);
  };
  tick();
  new ResizeObserver(() => {
    const cw = wrap.clientWidth, ch = wrap.clientHeight;
    if (cw > 0 && ch > 0) {
      pmState.renderer.setSize(cw, ch, false);
      pmState.camera.aspect = cw / ch;
      pmState.camera.updateProjectionMatrix();
    }
  }).observe(wrap);
}

// For each submesh, create a 2D canvas the size of its current diffuse
// map (cap 2048 for memory), prime it with the existing texture content,
// and bind it as material.map. Saves the previous map so Cancel can
// restore.
async function _pmSetupCanvasAndBind() {
  pmState.canvases = new Map();
  for (const entry of pmState.meshes) {
    const m = entry.mesh.material;
    const mats = Array.isArray(m) ? m : [m];
    entry.prev = mats.map((mat) => ({
      mat,
      mapWas: mat.map,
      emissiveMapWas: mat.emissiveMap,
      emissiveWas: mat.emissive?.clone(),
      emissiveIntensityWas: mat.emissiveIntensity,
    }));
    // Diffuse canvas: starts from current map content.
    const baseTex = mats[0]?.map;
    const baseImg = baseTex?.image;
    let w = 1024, h = 1024;
    if (baseImg && baseImg.width && baseImg.height) {
      w = Math.min(2048, baseImg.width);
      h = Math.min(2048, baseImg.height);
    }
    const dCanvas = document.createElement('canvas');
    dCanvas.width = w; dCanvas.height = h;
    const dCtx = dCanvas.getContext('2d');
    if (baseImg && baseImg.width && baseImg.height) {
      try { dCtx.drawImage(baseImg, 0, 0, w, h); }
      catch { dCtx.fillStyle = '#ffffff'; dCtx.fillRect(0, 0, w, h); }
    } else { dCtx.fillStyle = '#ffffff'; dCtx.fillRect(0, 0, w, h); }
    const dTex = new THREE.CanvasTexture(dCanvas);
    dTex.colorSpace = THREE.SRGBColorSpace;
    dTex.flipY = baseTex ? baseTex.flipY : false;
    dTex.wrapS = THREE.RepeatWrapping;
    dTex.wrapT = THREE.RepeatWrapping;
    dTex.name = baseTex?.name || 'T_diffuse';
    dTex.needsUpdate = true;
    // Emissive canvas: black, same size, same flipY.
    const eCanvas = document.createElement('canvas');
    eCanvas.width = w; eCanvas.height = h;
    const eCtx = eCanvas.getContext('2d');
    eCtx.fillStyle = '#000000'; eCtx.fillRect(0, 0, w, h);
    const eTex = new THREE.CanvasTexture(eCanvas);
    eTex.colorSpace = THREE.SRGBColorSpace;
    eTex.flipY = dTex.flipY;
    eTex.wrapS = THREE.RepeatWrapping;
    eTex.wrapT = THREE.RepeatWrapping;
    eTex.name = 'T_emissive';
    eTex.needsUpdate = true;
    // Snapshot the diffuse canvas so the Eraser tool can restore the
    // ORIGINAL texture pixel instead of wiping to transparent. We
    // only snapshot diffuse — emissive baseline is "all black" which
    // a plain fill handles cheaper than a putImageData.
    let dBaseline = null;
    try { dBaseline = dCtx.getImageData(0, 0, w, h); } catch {}
    pmState.canvases.set(entry.mesh, {
      diffuse:  { canvas: dCanvas, ctx: dCtx, texture: dTex, w, h, baseline: dBaseline },
      emissive: { canvas: eCanvas, ctx: eCtx, texture: eTex, w, h },
    });
    mats.forEach((mat) => {
      mat.map = dTex;
      mat.emissiveMap = eTex;
      mat.emissive = new THREE.Color(0xffffff);
      mat.emissiveIntensity = 1.0;
      mat.needsUpdate = true;
    });
  }
  pmState.history = [];
  pmState.historyIndex = -1;
  _pmHistoryPush();
}

function _pmRestoreMaterials() {
  pmState.meshes.forEach((entry) => {
    if (!entry.prev) return;
    entry.prev.forEach(({ mat, mapWas, emissiveMapWas, emissiveWas, emissiveIntensityWas }) => {
      mat.map = mapWas;
      mat.emissiveMap = emissiveMapWas;
      if (emissiveWas) mat.emissive = emissiveWas;
      if (typeof emissiveIntensityWas === 'number') mat.emissiveIntensity = emissiveIntensityWas;
      mat.needsUpdate = true;
    });
  });
}

async function _pmLoadMesh(meshPath) {
  if (pmState.origModel) {
    pmState.scene.remove(pmState.origModel);
    pmState.origModel = null;
  }
  pmState.meshes = [];
  const url = (typeof meshPath === 'string' && /^[a-z]+:/i.test(meshPath))
    ? meshPath
    : _toFileUrl(meshPath);
  try {
    const r = await fetch(url, { credentials: 'omit' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = await r.arrayBuffer();
    const loader = new GLTFLoader();
    loader.parse(buf, '', async (gltf) => {
      pmState.origModel = gltf.scene;
      pmState.scene.add(pmState.origModel);
      const box = new THREE.Box3().setFromObject(pmState.origModel);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      pmState.origModel.position.sub(center);
      pmState.origModel.position.y += size.y / 2;
      pmState.camera.position.set(0, size.y * 0.5, maxDim * 2);
      pmState.controls?.target.set(0, size.y * 0.5, 0);
      pmState.controls?.update();
      pmState.origModel.traverse((child) => {
        if (child.isMesh && child.geometry && child.material) {
          pmState.meshes.push({ mesh: child });
        }
      });
      await _pmSetupCanvasAndBind();
      const status = document.getElementById('pm-status');
      if (status) status.textContent = 'Ready — left-click to paint, right-click to orbit.';
    });
  } catch (e) {
    console.error('[paint-mesh] load failed:', e);
    if (typeof showToast === 'function') showToast('Mesh load failed: ' + (e?.message || e), 'error', 5000);
  }
}

function _pmHexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  return `rgba(${parseInt(h.slice(0,2),16)||0}, ${parseInt(h.slice(2,4),16)||0}, ${parseInt(h.slice(4,6),16)||0}, ${alpha})`;
}

function _pmRaycast(clientX, clientY) {
  if (!pmState.origModel || !pmState.raycaster) return null;
  const cv = pmState.renderer.domElement;
  const rect = cv.getBoundingClientRect();
  pmState.pointer.set(
    ((clientX - rect.left) / rect.width)  *  2 - 1,
    ((clientY - rect.top)  / rect.height) * -2 + 1,
  );
  pmState.raycaster.setFromCamera(pmState.pointer, pmState.camera);
  const meshes = pmState.meshes.map((e) => e.mesh);
  const hits = pmState.raycaster.intersectObjects(meshes, false);
  if (!hits.length || !hits[0].uv) return null;
  return hits[0];
}

// Stamp a brush dab on the hit submesh's canvas using the active tool
// (pen / spray / ink / eraser). Same 3D-distance filter as Paint
// Emissive to avoid bleed across overlapping UV islands.
function _pmStampAtPointer(clientX, clientY) {
  const hit = _pmRaycast(clientX, clientY);
  if (!hit) return;
  const entryAll = pmState.canvases?.get(hit.object);
  if (!entryAll) return;
  const entry = _pmActiveLayer(entryAll);
  if (!entry) return;
  const ctx = entry.ctx;
  const W = entry.w, H = entry.h;
  let uvX = Math.max(0, Math.min(1, hit.uv.x));
  let uvY = Math.max(0, Math.min(1, hit.uv.y));
  if (entry.texture.flipY) uvY = 1 - uvY;
  const px = uvX * W;
  const py = uvY * H;
  // Pipette mode: sample the canvas at the hit UV, write the colour
  // back into the color picker, and auto-switch to Pen.
  if (pmState.tool === 'pipette') {
    try {
      const ix = Math.max(0, Math.min(W - 1, Math.round(px)));
      const iy = Math.max(0, Math.min(H - 1, Math.round(py)));
      const px4 = ctx.getImageData(ix, iy, 1, 1).data;
      const hex = '#' + [px4[0], px4[1], px4[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
      pmState.color = hex;
      const colorEl = document.getElementById('pm-color');
      if (colorEl) colorEl.value = hex;
      // Snap back to Pen so the next click starts painting with the
      // freshly picked colour.
      const penBtn = document.getElementById('pm-tool-pen');
      penBtn?.click();
    } catch {}
    return;
  }
  const r = Math.max(1, pmState.brushSize * 0.5);
  const fall = Math.max(0, Math.min(1, pmState.falloff));
  ctx.save();
  const mesh = hit.object;
  const geom = mesh.geometry;
  const posAttr = geom.attributes.position;
  const uvAttr = geom.attributes.uv;
  const idx = geom.index?.array;
  // 3D-distance clip: same logic as Paint Emissive.
  if (uvAttr && posAttr) {
    const localHit = mesh.worldToLocal(hit.point.clone());
    const cam = pmState.camera;
    const camDist = cam.position.distanceTo(hit.point);
    const viewH = pmState.renderer.domElement.clientHeight || 600;
    const heightAtDist = 2 * camDist * Math.tan((cam.fov * Math.PI / 180) / 2);
    const unitsPerPx = heightAtDist / viewH;
    const R3D = pmState.brushSize * 0.5 * unitsPerPx * 1.2;
    const R3DSq = R3D * R3D;
    const posArr = posAttr.array;
    const uvArr = uvAttr.array;
    const triCount = idx ? Math.floor(idx.length / 3) : Math.floor(posAttr.count / 3);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.clip();
    const inner = pmState.tool === 'eraser'
      ? `rgba(255, 255, 255, ${pmState.opacity})`
      : _pmHexToRgba(pmState.color, pmState.opacity);
    const edge  = pmState.tool === 'eraser'
      ? 'rgba(255, 255, 255, 0)'
      : _pmHexToRgba(pmState.color, 0);
    const grad = ctx.createRadialGradient(px, py, 0, px, py, r);
    grad.addColorStop(0, inner);
    grad.addColorStop(1 - fall, inner);
    grad.addColorStop(1, edge);
    ctx.fillStyle = grad;
    for (let t = 0; t < triCount; t++) {
      const i0 = idx ? idx[t*3]   : t*3;
      const i1 = idx ? idx[t*3+1] : t*3+1;
      const i2 = idx ? idx[t*3+2] : t*3+2;
      const p0x = posArr[i0*3], p0y = posArr[i0*3+1], p0z = posArr[i0*3+2];
      const p1x = posArr[i1*3], p1y = posArr[i1*3+1], p1z = posArr[i1*3+2];
      const p2x = posArr[i2*3], p2y = posArr[i2*3+1], p2z = posArr[i2*3+2];
      const d0 = (p0x-localHit.x)**2 + (p0y-localHit.y)**2 + (p0z-localHit.z)**2;
      if (d0 >= R3DSq) {
        const d1 = (p1x-localHit.x)**2 + (p1y-localHit.y)**2 + (p1z-localHit.z)**2;
        if (d1 >= R3DSq) {
          const d2 = (p2x-localHit.x)**2 + (p2y-localHit.y)**2 + (p2z-localHit.z)**2;
          if (d2 >= R3DSq) continue;
        }
      }
      let u0y = uvArr[i0*2+1], u1y = uvArr[i1*2+1], u2y = uvArr[i2*2+1];
      if (entry.texture.flipY) { u0y = 1 - u0y; u1y = 1 - u1y; u2y = 1 - u2y; }
      ctx.beginPath();
      ctx.moveTo(uvArr[i0*2] * W, u0y * H);
      ctx.lineTo(uvArr[i1*2] * W, u1y * H);
      ctx.lineTo(uvArr[i2*2] * W, u2y * H);
      ctx.closePath();
      // Tool-specific stamp behaviour. Pen/Ink: gradient fill.
      // Spray: random pixel-sprinkle inside the triangle. Eraser uses
      // destination-out on top of the gradient fill.
      if (pmState.tool === 'eraser') {
        // Eraser should only undo the user's own strokes, NOT punch
        // a hole in the baseline texture. In diffuse mode we paint
        // the baseline pixels under the brush back. In emissive mode
        // black IS the baseline, so destination-out works fine.
        if (pmState.emissiveMode || !entry.baseline) {
          ctx.globalCompositeOperation = 'destination-out';
          ctx.fill();
          ctx.globalCompositeOperation = 'source-over';
        } else {
          // Build a temporary canvas with the baseline pixels and
          // use it as the fillStyle pattern, then clip-fill the
          // brush triangle with it.
          if (!entry._baselineCanvas) {
            const bc = document.createElement('canvas');
            bc.width = entry.w; bc.height = entry.h;
            bc.getContext('2d').putImageData(entry.baseline, 0, 0);
            entry._baselineCanvas = bc;
          }
          const prev = ctx.fillStyle;
          ctx.fillStyle = ctx.createPattern(entry._baselineCanvas, 'no-repeat');
          ctx.fill();
          ctx.fillStyle = prev;
        }
      } else if (pmState.tool === 'spray') {
        // For spray we approximate by re-filling with random small
        // squares — gradient + clip already shape it to the brush
        // and triangle. Re-fill with low alpha is the cheap option.
        ctx.globalAlpha = 0.4 * pmState.opacity;
        ctx.fill();
        ctx.globalAlpha = 1;
      } else {
        ctx.fill();
      }
    }
  } else {
    // No UVs / fallback: simple disc stamp.
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    const grad = ctx.createRadialGradient(px, py, 0, px, py, r);
    grad.addColorStop(0, _pmHexToRgba(pmState.color, pmState.opacity));
    grad.addColorStop(1, _pmHexToRgba(pmState.color, 0));
    ctx.fillStyle = grad;
    ctx.fill();
  }
  ctx.restore();
  entry.texture.needsUpdate = true;
}

function openPaintMesh(opts = {}) {
  const p = state.currentProject;
  if (!p || !p.selectedMeshPath) { showToast('Pick a mesh first.', 'error'); return; }
  const modal = document.getElementById('modal-paint-mesh');
  if (!modal) return;
  modal.classList.remove('hidden');
  // Pre-set the layer mode from caller (Paint Emissive alias passes
  // emissiveMode: true so the user lands directly on the glow layer).
  pmState.emissiveMode = !!opts.emissiveMode;
  const $ = (id) => document.getElementById(id);
  // Wire tool selection.
  const toolBtns = ['pen', 'spray', 'ink', 'eraser', 'pipette'];
  const setTool = (t) => {
    pmState.tool = t;
    toolBtns.forEach((nm) => {
      $('pm-tool-' + nm)?.classList.toggle('tool-active', nm === t);
    });
  };
  toolBtns.forEach((nm) => { $('pm-tool-' + nm).onclick = () => setTool(nm); });
  setTool('pen');
  $('pm-color').oninput = (e) => { pmState.color = e.target.value; };
  pmState.color = $('pm-color').value;
  $('pm-brush-size').oninput = (e) => {
    pmState.brushSize = Number(e.target.value); $('pm-brush-val').textContent = e.target.value;
  };
  $('pm-opacity').oninput = (e) => {
    pmState.opacity = Number(e.target.value) / 100; $('pm-opacity-val').textContent = e.target.value + '%';
  };
  $('pm-falloff').oninput = (e) => {
    pmState.falloff = Number(e.target.value) / 100; $('pm-falloff-val').textContent = e.target.value + '%';
  };
  $('pm-undo').onclick = _pmUndo;
  $('pm-redo').onclick = _pmRedo;
  // Apply the title/subtitle/button-state for the current mode.
  const refreshModeUI = () => {
    const title = $('pm-title');
    const subtitle = $('pm-subtitle');
    const tBtn = $('pm-toggle-emissive');
    if (pmState.emissiveMode) {
      if (title)    title.textContent = '💡 Paint Mesh — Emissive layer';
      if (subtitle) subtitle.textContent = 'Strokes go on the emissive map (T_emissive). Toggle off to paint the diffuse instead.';
    } else {
      if (title)    title.textContent = '🎨 Paint Mesh';
      if (subtitle) subtitle.textContent = "Paint directly on the mesh's diffuse texture. Left-click + drag to paint, right-click to orbit.";
    }
    tBtn?.classList.toggle('tool-active', pmState.emissiveMode);
    if (tBtn) {
      tBtn.style.background = pmState.emissiveMode ? 'var(--accent, #5a4fcf)' : '';
      tBtn.style.color      = pmState.emissiveMode ? '#fff' : '';
    }
  };
  refreshModeUI();
  $('pm-toggle-emissive').onclick = () => {
    pmState.emissiveMode = !pmState.emissiveMode;
    refreshModeUI();
  };
  // Reset clears the ACTIVE layer back to its base state (diffuse →
  // original texture, emissive → black). Leaves the other layer alone.
  $('pm-reset').onclick = () => {
    if (!pmState.canvases) return;
    pmState.canvases.forEach((entryAll, mesh) => {
      if (pmState.emissiveMode) {
        const L = entryAll.emissive;
        L.ctx.fillStyle = '#000000';
        L.ctx.fillRect(0, 0, L.w, L.h);
        L.texture.needsUpdate = true;
      } else {
        const L = entryAll.diffuse;
        const orig = entryAll.diffuse && pmState.meshes.find((e) => e.mesh === mesh)?.prev?.[0]?.mapWas?.image;
        L.ctx.clearRect(0, 0, L.w, L.h);
        if (orig) {
          try { L.ctx.drawImage(orig, 0, 0, L.w, L.h); }
          catch { L.ctx.fillStyle = '#ffffff'; L.ctx.fillRect(0, 0, L.w, L.h); }
        } else { L.ctx.fillStyle = '#ffffff'; L.ctx.fillRect(0, 0, L.w, L.h); }
        L.texture.needsUpdate = true;
      }
    });
    _pmHistoryPush();
  };
  const onKey = (e) => {
    if (modal.classList.contains('hidden')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    if (e.key === 'z' || e.key === 'Z') {
      e.preventDefault(); if (e.shiftKey) _pmRedo(); else _pmUndo();
    } else if (e.key === 'y' || e.key === 'Y') {
      e.preventDefault(); _pmRedo();
    }
  };
  document.addEventListener('keydown', onKey);

  requestAnimationFrame(async () => {
    await _pmInitViewport();
    const cv = pmState.renderer.domElement;
    cv.onpointerdown = (e) => {
      if (e.button !== 0) return;
      pmState.isPainting = true;
      cv.setPointerCapture(e.pointerId);
      _pmStampAtPointer(e.clientX, e.clientY);
    };
    cv.onpointermove = (e) => {
      if (!pmState.isPainting) return;
      _pmStampAtPointer(e.clientX, e.clientY);
    };
    const up = (e) => {
      if (pmState.isPainting) { pmState.isPainting = false; _pmHistoryPush(); }
      try { cv.releasePointerCapture(e.pointerId); } catch {}
    };
    cv.onpointerup = up;
    cv.onpointercancel = up;
    _pmLoadMesh(p.selectedMeshPath);
  });

  const close = (restore) => {
    modal.classList.add('hidden');
    if (restore) _pmRestoreMaterials();
  };
  $('pm-cancel').onclick = () => close(true);
  $('pm-close-x').onclick = () => close(true);
  $('pm-save').onclick = async () => {
    const btn = $('pm-save'); const orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'Saving…';
    try { await _pmApplyOnDevice(); close(false); }
    catch (e) {
      showToast('Paint Mesh failed: ' + (e?.message || e), 'error', 5000);
      btn.textContent = orig; btn.disabled = false;
    }
  };
}

async function _pmApplyOnDevice() {
  if (!pmState.origModel) throw new Error('no model loaded');
  const savedPos = pmState.origModel.position.clone();
  pmState.origModel.position.set(0, 0, 0);
  try {
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    const exporter = new GLTFExporter();
    const buf = await new Promise((resolve, reject) => {
      exporter.parse(pmState.origModel,
        (r) => r instanceof ArrayBuffer ? resolve(r) : reject(new Error('non-binary export')),
        (err) => reject(err),
        { binary: true, embedImages: true },
      );
    });
    const bytes = new Uint8Array(buf);
    // Same tunneling as Paint Emissive: Paint Mesh isn't on the
    // server allowlist (smooth/decimate/subdivide/fix_normals/
    // fill_holes/center), so we pass 'center' to store the GLB.
    const data = await uploadClientMeshResult(bytes, 'center');
    const newUrl = data.path || data.newPath || data.mesh_url;
    showToast('Paint Mesh saved!', 'success');
    const p = state.currentProject;
    if (p && newUrl) {
      const filename = String(newUrl).split('/').pop() || 'paint_mesh.glb';
      p.meshes = p.meshes || [];
      p.meshes.unshift({ path: newUrl, filename, size: 0, mtime: Date.now() });
      p.selectedMeshPath = newUrl;
      p.previewMeshPath = newUrl;
      // If the user painted on the emissive layer (any non-zero pixel),
      // tag the new mesh so the 💡 badge shows on its thumbnail.
      try {
        let emissivePainted = false;
        pmState.canvases?.forEach((entryAll) => {
          if (emissivePainted) return;
          const eL = entryAll.emissive;
          if (!eL) return;
          const samp = eL.ctx.getImageData(0, 0, eL.w, eL.h).data;
          for (let i = 0; i < samp.length; i += 4) {
            if (samp[i] || samp[i+1] || samp[i+2]) { emissivePainted = true; break; }
          }
        });
        if (emissivePainted) _meshEmissiveMark(newUrl);
      } catch {}
      if (typeof populateWorkspace === 'function') {
        try { await populateWorkspace(p); } catch {}
      }
    }
  } finally {
    pmState.origModel.position.copy(savedPos);
  }
}

document.getElementById('ws-mesh-paint-mesh-btn')?.addEventListener('click', openPaintMesh);

// ============================================================
// MATERIAL ADJUST MODAL
// Sliders for brightness / saturation / contrast / emissive /
// metallic / roughness on the selected mesh. Wraps
// scripts/mesh_material_adjust.py via IPC.
// ============================================================
const MAT_DEFAULTS = {
  brightness: 1.0, saturation: 1.0, contrast: 1.0,
  emissive: 0.0,   metallic: 0.0,    roughness: 0.7,
  hue_shift: 0,
};

function _matSetSliderLabel(id, value) {
  const el = document.getElementById(`mat-${id}-val`);
  if (!el) return;
  // hue_shift is in DEGREES (-180..+180) — display as int + °, not 2-decimal.
  if (id === 'hue_shift') el.textContent = `${Math.round(Number(value))}°`;
  else el.textContent = Number(value).toFixed(2);
}

function _matBindSlider(id) {
  const slider = document.getElementById(`mat-${id}`);
  if (!slider) return;
  slider.addEventListener('input', () => {
    _matSetSliderLabel(id, slider.value);
    // ALL 6 sliders update the preview live now.
    _matApplyLivePBR();
  });
}

function _matReadParams() {
  return {
    brightness: parseFloat(document.getElementById('mat-brightness').value),
    saturation: parseFloat(document.getElementById('mat-saturation').value),
    contrast:   parseFloat(document.getElementById('mat-contrast').value),
    emissive:   parseFloat(document.getElementById('mat-emissive').value),
    metallic:   parseFloat(document.getElementById('mat-metallic').value),
    roughness:  parseFloat(document.getElementById('mat-roughness').value),
    hue_shift:  parseFloat(document.getElementById('mat-hue_shift')?.value ?? 0),
  };
}

function _matWriteSliders(p) {
  for (const k of Object.keys(p)) {
    const s = document.getElementById(`mat-${k}`);
    if (s) { s.value = p[k]; _matSetSliderLabel(k, p[k]); }
  }
  // Push the new values through the live PBR preview so Reset visibly
  // updates the mesh; the slider 'input' listener only fires on user
  // drags, not on programmatic .value writes.
  if (typeof _matApplyLivePBR === 'function') _matApplyLivePBR();
}

// Three.js viewer state for the Material Adjust modal.
let _matViewer = null;
let _matModel = null;

async function openMaterialAdjust() {
  const p = state.currentProject;
  if (!p || !p.selectedMeshPath) {
    showToast('Pick a mesh first.', 'error'); return;
  }
  _matWriteSliders(MAT_DEFAULTS);
  document.getElementById('modal-material-adjust').classList.remove('hidden');

  // Lazy-init the Three.js viewer for the modal canvas.
  const canvas = document.getElementById('mat-canvas');
  if (!_matViewer && canvas) {
    _matViewer = new Viewer3D({
      canvas, fov: 45, bgColor: 0x1b1b1b, cameraPos: [2, 2, 3],
      lighting: true,
    });
    _matViewer.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    _matViewer.renderer.toneMappingExposure = 1.0;
    _matViewer.startTickLoop();
  }
  // Wait one frame so the canvas has a layout size, then resize.
  await new Promise(r => requestAnimationFrame(r));
  if (_matViewer) _matViewer.renderer.setSize(
    canvas.clientWidth || 600, canvas.clientHeight || 520, false);

  // Load the selected mesh into the viewer scene.
  if (_matModel) { _matViewer.scene.remove(_matModel); _matModel = null; }
  const buffer = await API.readMeshFile(p.selectedMeshPath);
  if (!buffer) {
    showToast('Failed to read mesh file', 'error');
    return;
  }
  const loader = new GLTFLoader();
  loader.parse(buffer, '', (gltf) => {
    _matModel = gltf.scene;
    _matViewer.scene.add(_matModel);
    // Patch every material with brightness/sat/contrast shader uniforms.
    // Also DETACH any pre-existing emissive map — otherwise the GLB's
    // baked-in emissive setup (e.g. emissiveMap=baseColor) would
    // double-apply on top of the slider, giving a clipped-white preview.
    _matModel.traverse(obj => {
      if (!obj.isMesh || !obj.material) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        // Remove pre-existing emissive map so slider isn't additive.
        if (mat.emissiveMap) mat.emissiveMap = null;
        if (mat.emissive) mat.emissive.setRGB(0, 0, 0);
        _matInjectShader(mat);
        mat.needsUpdate = true;
      }
    });
    // Fit camera to model bounding box.
    const box = new THREE.Box3().setFromObject(_matModel);
    const size = box.getSize(new THREE.Vector3()).length();
    const center = box.getCenter(new THREE.Vector3());
    _matModel.position.x -= center.x;
    _matModel.position.y -= center.y;
    _matModel.position.z -= center.z;
    _matViewer.camera.near = size / 100;
    _matViewer.camera.far = size * 100;
    _matViewer.camera.updateProjectionMatrix();
    _matViewer.camera.position.copy(new THREE.Vector3(size * 0.8, size * 0.5, size * 0.8));
    _matViewer.controls?.target.set(0, 0, 0);
    _matViewer.controls?.update();
    // Apply initial PBR values from defaults.
    _matApplyLivePBR();
  }, (err) => {
    console.error('Material modal: GLTF parse error', err);
    showToast('Failed to load mesh in preview', 'error');
  });
}

// Patches a Three.js material's shader to add brightness / saturation /
// contrast uniforms. Uses onBeforeCompile which is the standard Three.js
// way to inject GLSL without forking the material class.
function _matInjectShader(mat) {
  if (mat.userData._matShaderInjected) return;
  mat.userData._matShaderInjected = true;
  mat.userData._matUniforms = {
    uBrightness: { value: 1.2 },
    uSaturation: { value: 1.0 },
    uContrast:   { value: 1.0 },
    uHueShift:   { value: 0.0 }, // radians
  };
  const prevOBC = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prevOBC) prevOBC(shader, renderer);
    shader.uniforms.uBrightness = mat.userData._matUniforms.uBrightness;
    shader.uniforms.uSaturation = mat.userData._matUniforms.uSaturation;
    shader.uniforms.uContrast   = mat.userData._matUniforms.uContrast;
    shader.uniforms.uHueShift   = mat.userData._matUniforms.uHueShift;
    // Inject uniforms + RGB/HSV helpers into the fragment shader header.
    // The hue rotation uses a real RGB→HSV→shift→RGB roundtrip so it
    // matches PIL's behaviour exactly (the previous YIQ-style matrix
    // had bad coefficients and produced wrong colours).
    shader.fragmentShader =
      'uniform float uBrightness;\nuniform float uSaturation;\nuniform float uContrast;\nuniform float uHueShift;\n' +
      'vec3 _matRgb2Hsv(vec3 c){vec4 K=vec4(0.0,-1.0/3.0,2.0/3.0,-1.0);vec4 p=mix(vec4(c.bg,K.wz),vec4(c.gb,K.xy),step(c.b,c.g));vec4 q=mix(vec4(p.xyw,c.r),vec4(c.r,p.yzx),step(p.x,c.r));float d=q.x-min(q.w,q.y);float e=1.0e-10;return vec3(abs(q.z+(q.w-q.y)/(6.0*d+e)),d/(q.x+e),q.x);}\n' +
      'vec3 _matHsv2Rgb(vec3 c){vec4 K=vec4(1.0,2.0/3.0,1.0/3.0,3.0);vec3 p=abs(fract(c.xxx+K.xyz)*6.0-K.www);return c.z*mix(K.xxx,clamp(p-K.xxx,0.0,1.0),c.y);}\n' +
      shader.fragmentShader;
    // Inject the post-process step before output_fragment include.
    // The include name varies between three.js versions; we cover both
    // 'output_fragment' (newer) and 'dithering_fragment' (older).
    const inject = `
      // MyFabmesh.AI Material Adjust live shader
      vec3 _matCol = gl_FragColor.rgb;
      _matCol *= uBrightness;
      float _matLuma = dot(_matCol, vec3(0.299, 0.587, 0.114));
      _matCol = mix(vec3(_matLuma), _matCol, uSaturation);
      _matCol = (_matCol - 0.5) * uContrast + 0.5;
      // True HSV hue rotation + saturation floor so grey/dark pixels
      // also pick up the tint (otherwise only the saturated parts of
      // the mesh change colour and the rest stays grey). PIL on save
      // uses the same floor so preview ≈ save.
      if (abs(uHueShift) > 0.001) {
        float _hueNorm = uHueShift / 6.28318530718;
        vec3 _hsv = _matRgb2Hsv(clamp(_matCol, 0.0, 1.0));
        _hsv.x = fract(_hsv.x + _hueNorm);
        _hsv.y = max(_hsv.y, abs(_hueNorm) * 0.5);
        _matCol = _matHsv2Rgb(_hsv);
      }
      gl_FragColor.rgb = clamp(_matCol, 0.0, 1.0);
    `;
    if (shader.fragmentShader.includes('#include <output_fragment>')) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <output_fragment>',
        inject + '\n#include <output_fragment>'
      );
    } else if (shader.fragmentShader.includes('#include <dithering_fragment>')) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        inject + '\n#include <dithering_fragment>'
      );
    } else {
      // Last resort: append at end of main() — close-enough for preview.
      shader.fragmentShader = shader.fragmentShader.replace(
        /}\s*$/,
        inject + '\n}'
      );
    }
    mat.userData._matShaderRef = shader;
  };
  mat.needsUpdate = true;
}

// Live-update ALL 6 material params on the loaded preview's three.js
// materials. PBR (emissive/metallic/roughness) via material properties;
// brightness/saturation/contrast via injected shader uniforms (see
// _matInjectShader).
function _matApplyLivePBR() {
  if (!_matModel) return;
  const params = _matReadParams();
  _matModel.traverse(obj => {
    if (!obj.isMesh || !obj.material) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if ('metalness' in mat) mat.metalness = params.metallic;
      if ('roughness' in mat) mat.roughness = params.roughness;
      if (mat.emissive) {
        mat.emissive.setRGB(params.emissive, params.emissive, params.emissive);
      }
      // Slider > 0 → emissive uses the base color texture as map so the
      // self-illumination preserves the colours of the painted texture.
      // Slider = 0 → emissive off (already RGB(0,0,0)).
      if (params.emissive > 0.001 && mat.map && mat.emissiveMap !== mat.map) {
        mat.emissiveMap = mat.map;
        mat.needsUpdate = true;
      } else if (params.emissive <= 0.001 && mat.emissiveMap) {
        mat.emissiveMap = null;
        mat.needsUpdate = true;
      }
      // Update injected shader uniforms for brightness/sat/contrast/hue.
      if (mat.userData?._matUniforms) {
        mat.userData._matUniforms.uBrightness.value = params.brightness;
        mat.userData._matUniforms.uSaturation.value = params.saturation;
        mat.userData._matUniforms.uContrast.value   = params.contrast;
        // Slider is in degrees, shader expects radians.
        mat.userData._matUniforms.uHueShift.value   = (params.hue_shift || 0) * Math.PI / 180;
      }
    }
  });
}

function closeMaterialAdjust() {
  document.getElementById('modal-material-adjust').classList.add('hidden');
}

// Bind sliders + buttons once.
['brightness', 'saturation', 'contrast', 'emissive', 'metallic', 'roughness', 'hue_shift']
  .forEach(_matBindSlider);
document.getElementById('mat-reset-btn')?.addEventListener('click', () =>
  _matWriteSliders(MAT_DEFAULTS));
document.getElementById('mat-cancel-btn')?.addEventListener('click', closeMaterialAdjust);
document.getElementById('mat-apply-btn')?.addEventListener('click', async () => {
  const p = state.currentProject;
  if (!p || !p.selectedMeshPath) {
    showToast('Pick a mesh first.', 'error'); return;
  }
  const params = _matReadParams();
  // Use a real job popup so the user sees progress + can cancel, instead
  // of a 2s toast. Mirrors the rig/anim pattern.
  const sourceFn = (p.selectedMeshPath || '').split(/[/\\]/).pop() || 'mesh.glb';
  const job = pushJob(`Material Adjust: ${p.name}`, null, {
    Brightness: params.brightness?.toFixed(2),
    Saturation: params.saturation?.toFixed(2),
    Contrast: params.contrast?.toFixed(2),
    Emissive: params.emissive?.toFixed(2),
    Metallic: params.metallic?.toFixed(2),
    Roughness: params.roughness?.toFixed(2),
    'Source mesh': sourceFn,
  }, 30000); // Modal mesh-op typically returns in 10-20s
  closeMaterialAdjust();
  try {
    const r = await API.materialAdjust({
      meshPath: p.selectedMeshPath,
      projectName: p?.name || null,
      ...params,
    });
    if (r?.success) {
      completeJob(job.id, true);
      // Push the new GLB into p.meshes so it shows up as a new version
      // immediately, without waiting for a project reload. Then refresh
      // from R2 in the background to pick up any server-side metadata.
      // Push the new GLB into p.meshes so it shows up as a new version
      // immediately. We do NOT call reloadCurrentProject() because the
      // server's /api/projects + /api/meshes only list under <user.id>/
      // projects/ and <user.id>/rigged/ — mesh-op outputs live under
      // <user.id>/mesh-op/ and would not be picked up by a reload,
      // wiping our locally-pushed version.
      try {
        const newUrl = r.mesh_url || r.newPath || r.path;
        if (newUrl && p) {
          p.meshes = p.meshes || [];
          const filename = (r.filename || newUrl.split('/').pop() || 'mesh.glb');
          const already = p.meshes.some(m => m.url === newUrl || m.path === newUrl);
          if (!already) {
            p.meshes.unshift({
              filename, url: newUrl, path: newUrl,
              asset_type: 'mesh', size: 0,
              created: new Date().toISOString(),
            });
            p.selectedMeshPath = newUrl;
          }
        }
      } catch (e) { console.warn('[material-adjust] state push failed:', e); }
      showToast(`Material applied → new version saved`, 'success', 4000);
      // Re-render the mesh version strip directly. populateWorkspace
      // would normally do this but it re-runs a bunch of stage logic;
      // we only need the version strip to repaint with the new entry.
      try { renderMeshVersions(p); } catch (_) {}
      // Auto-select the new version in the viewer so the user sees the
      // result immediately. The version-strip click handler does this
      // when the user clicks a thumb; we do it programmatically here.
      try {
        const strip = document.getElementById('ws-mesh-versions');
        if (strip && strip.children && strip.children[0]) {
          strip.children[0].click();
        }
      } catch (_) {}
    } else {
      completeJob(job.id, false, r?.error || 'unknown');
      if (!job.cancelled) reportPipelineError(r?.error, 'Material Adjust failed');
    }
  } catch (e) {
    completeJob(job.id, false, e?.message || String(e));
    if (!job.cancelled) reportPipelineError(e?.message || String(e), 'Material Adjust error');
  }
});
document.getElementById('ws-mesh-material-btn')?.addEventListener('click', openMaterialAdjust);
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
  sculptMode: 'push',    // push | pull | smooth | flatten | grab | inflate
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
  symmetryAxes: { x: false, y: false, z: false },
  grabAnchor: null,      // mesh-local anchor point captured on pointerdown
  grabScreen: null,      // {x,y} screen coords captured on pointerdown
  grabMesh: null,        // mesh object the grab stroke is acting on
  grabLastDelta: null,   // last applied local-space translation (THREE.Vector3)
};

function openMeshEdit(mode) {
  const p = state.currentProject;
  // Edit the mesh currently PREVIEWED (previewMeshPath), like the other
  // Edit-selected tools — not the "used for rig" pick (selectedMeshPath).
  const editPath = (p && (p.previewMeshPath || p.selectedMeshPath)) || null;
  if (!p || !editPath) { showToast('Pick a mesh first.', 'error'); return; }
  meState.mode = mode;
  meState.meshPath = editPath;

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
    _meLoadMesh(meState.meshPath);
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
  let url;
  if (/^(?:blob|data):/i.test(meshPath)) {
    url = meshPath; // already a usable resource URL
  } else if (/^https?:/i.test(meshPath)) {
    url = meshPath; // R2 or other CDN — direct fetch (CORS must be set on the bucket)
  } else if (/^modal_[a-f0-9]+\.glb$/i.test(meshPath)) {
    url = "/api/mesh/get?path=" + encodeURIComponent(meshPath);
  } else {
    url = "file:///" + String(meshPath).replace(/\\/g, "/");
  }
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

function _meSnapshot() {
  const snap = [];
  meState.mesh?.traverse(c => {
    if (c.isMesh && c.geometry) {
      snap.push({
        mesh: c,
        positions: c.geometry.attributes.position.array.slice(),
        colors: c.geometry.attributes.color ? c.geometry.attributes.color.array.slice() : null,
        // Capture the index too — Delete rewrites it, so without this undo
        // can't bring deleted faces back.
        index: c.geometry.index ? c.geometry.index.array.slice() : null,
      });
    }
  });
  return snap;
}
function _meRestore(snapshot) {
  for (const s of snapshot) {
    const geom = s.mesh.geometry;
    geom.attributes.position.array.set(s.positions);
    geom.attributes.position.needsUpdate = true;
    if (s.colors && geom.attributes.color) {
      geom.attributes.color.array.set(s.colors);
      geom.attributes.color.needsUpdate = true;
    }
    if (s.index) geom.setIndex(new THREE.BufferAttribute(s.index, 1));
    geom._selSaved = new Map();
    geom._posGroups = null;
    geom._posKeyByIndex = null;
    geom.computeVertexNormals();
  }
  if (typeof _meUpdateSelButtons === 'function') _meUpdateSelButtons();
}
function _mePushUndo() {
  meState.undoStack.push(_meSnapshot());
  if (meState.undoStack.length > 20) meState.undoStack.shift();
  meState.redoStack = [];
  _meUpdateUndoBtns();
}
function _meUndo() {
  if (meState.undoStack.length === 0) return;
  meState.redoStack.push(_meSnapshot());   // current -> redo
  _meRestore(meState.undoStack.pop());
  _meUpdateUndoBtns();
}
function _meRedo() {
  if (meState.redoStack.length === 0) return;
  meState.undoStack.push(_meSnapshot());   // current -> undo
  _meRestore(meState.redoStack.pop());
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
  // Eyedropper: sample the colour under the cursor instead of painting.
  if (meState.mode === 'paint' && meState.pickMode) {
    const geom = hit.object.geometry, fa = hit.face?.a;
    if (geom.attributes.color && fa != null) {
      const col = geom.attributes.color;
      const hex = '#' + [col.getX(fa), col.getY(fa), col.getZ(fa)]
        .map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
      meState.color = hex;
      const inp = document.getElementById('me-paint-color'); if (inp) inp.value = hex;
    }
    meState.pickMode = false;
    document.getElementById('me-paint-pick')?.classList.remove('tool-active');
    return;
  }
  meState.painting = true;
  _mePushUndo();
  meState.controls.enabled = false;
  // Grab brush: capture anchor in mesh-local space + screen origin
  if (meState.mode === 'sculpt' && meState.sculptMode === 'grab') {
    const anchor = hit.point.clone();
    hit.object.worldToLocal(anchor);
    meState.grabAnchor = anchor;
    meState.grabScreen = { x: e.clientX, y: e.clientY };
    meState.grabMesh = hit.object;
    meState.grabLastDelta = new THREE.Vector3(0, 0, 0);
    return; // no immediate translation; movement drives the brush
  }
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
  // Grab uses screen-space delta, not raycast intersection
  if (meState.mode === 'sculpt' && meState.sculptMode === 'grab' && meState.grabAnchor && meState.grabMesh) {
    _meApplyGrab(e);
    return;
  }
  const hit = _meGetIntersection(e);
  if (hit) _meApplyBrush(hit);
}

function _meMouseUp() {
  if (meState.painting) {
    meState.painting = false;
    meState.controls.enabled = true;
    meState.grabAnchor = null;
    meState.grabScreen = null;
    meState.grabMesh = null;
    meState.grabLastDelta = null;
    // Recompute normals after sculpt stroke
    meState.mesh?.traverse(c => {
      if (c.isMesh && c.geometry?._normsDirty) {
        c.geometry.computeVertexNormals();
        c.geometry._normsDirty = false;
      }
    });
  }
}

// Grab: translate vertices in falloff around the anchor by a camera-relative delta
function _meApplyGrab(e) {
  const mesh = meState.grabMesh;
  if (!mesh) return;
  const geom = mesh.geometry;
  const pos = geom.attributes.position;
  const canvas = document.getElementById('me-canvas');
  const rect = canvas.getBoundingClientRect();
  const sdx = (e.clientX - meState.grabScreen.x);
  const sdy = (e.clientY - meState.grabScreen.y);
  // Convert pixel delta to world units roughly proportional to current view
  const sens = (meState.brushRadius * 4) / Math.max(40, rect.width * 0.25);
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  meState.camera.matrixWorld.extractBasis(right, up, new THREE.Vector3());
  const worldDelta = right.multiplyScalar(sdx * sens).add(up.multiplyScalar(-sdy * sens));
  // Express delta in mesh local space (direction only; ignore translation)
  const localDelta = worldDelta.clone();
  const m = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
  // Strip translation: transform as a direction
  localDelta.transformDirection(m);
  // Scale by the inverse of mesh world scale magnitude so delta keeps real length
  const ws = new THREE.Vector3();
  mesh.getWorldScale(ws);
  const avgScale = (Math.abs(ws.x) + Math.abs(ws.y) + Math.abs(ws.z)) / 3 || 1;
  localDelta.multiplyScalar(worldDelta.length() / (localDelta.length() * avgScale || 1));
  // Incremental delta vs previous frame so vertices don't jitter
  const inc = localDelta.clone().sub(meState.grabLastDelta);
  meState.grabLastDelta = localDelta;
  const anchor = meState.grabAnchor;
  const r = meState.brushRadius;
  const rSq = r * r;
  const strength = meState.strength;
  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i);
    const dx = vx - anchor.x, dy = vy - anchor.y, dz = vz - anchor.z;
    if (Math.abs(dx) > r || Math.abs(dy) > r || Math.abs(dz) > r) continue;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq > rSq) continue;
    const dist = Math.sqrt(distSq);
    const falloff = 1 - (dist / r);
    const w = falloff * falloff * strength;
    pos.setXYZ(i, vx + inc.x * w, vy + inc.y * w, vz + inc.z * w);
  }
  pos.needsUpdate = true;
  geom._normsDirty = true;
}

// Apply brush body at a (possibly mirrored) local-space point.
// Push/pull/smooth/flatten use the same math as before so behaviour is byte-identical
// when no symmetry axis is enabled.
function _applyBrushAt(hit, point) {
  const geom = hit.object.geometry;
  const pos = geom.attributes.position;
  const normals = geom.attributes.normal;
  const r = meState.brushRadius;
  const rSq = r * r;
  const strength = meState.strength;
  const px = point.x, py = point.y, pz = point.z;
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
    } else if (meState.sculptMode === 'inflate') {
      // Expand along vertex normal; negative strength deflates via slider sign
      const nx = normals.getX(i), ny = normals.getY(i), nz = normals.getZ(i);
      pos.setXYZ(i, vx + nx * amount, vy + ny * amount, vz + nz * amount);
    }
  }
  pos.needsUpdate = true;
  // Defer normal recompute to mouseup (expensive)
  geom._normsDirty = true;
}

function _meApplyBrush(hit) {
  const point = hit.point.clone();
  hit.object.worldToLocal(point);

  if (meState.mode === 'sculpt') {
    if (meState.sculptMode === 'grab') return; // grab is driven by _meApplyGrab
    _applyBrushAt(hit, point);
    // Symmetry: mirror the brush LOCATION in mesh local space, reapply per enabled axis
    const ax = meState.symmetryAxes;
    if (ax.x || ax.y || ax.z) {
      const combos = [];
      if (ax.x) combos.push({ x: -1, y: 1, z: 1 });
      if (ax.y) combos.push({ x: 1, y: -1, z: 1 });
      if (ax.z) combos.push({ x: 1, y: 1, z: -1 });
      if (ax.x && ax.y) combos.push({ x: -1, y: -1, z: 1 });
      if (ax.x && ax.z) combos.push({ x: -1, y: 1, z: -1 });
      if (ax.y && ax.z) combos.push({ x: 1, y: -1, z: -1 });
      if (ax.x && ax.y && ax.z) combos.push({ x: -1, y: -1, z: -1 });
      for (const c of combos) {
        const mp = point.clone();
        mp.x *= c.x; mp.y *= c.y; mp.z *= c.z;
        _applyBrushAt(hit, mp);
      }
    }
  } else if (meState.mode === 'paint') {
    const geom = hit.object.geometry;
    const pos = geom.attributes.position;
    const r = meState.brushRadius;
    const rSq = r * r;
    const strength = meState.strength;
    const px = point.x, py = point.y, pz = point.z;
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
    const geom = hit.object.geometry;
    const pos = geom.attributes.position;
    const r = meState.brushRadius;
    const rSq = r * r;
    const px = point.x, py = point.y, pz = point.z;
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
  if (typeof _meRestoreView === 'function') _meRestoreView();
  document.getElementById('modal-mesh-edit')?.classList.add('hidden');
}

// Wire buttons
document.getElementById('ws-mesh-sculpt-btn')?.addEventListener('click', () => openMeshEdit('sculpt'));
document.getElementById('ws-mesh-paintvert-btn')?.addEventListener('click', () => openMeshEdit('paint'));
document.getElementById('ws-mesh-selectface-btn')?.addEventListener('click', () => openMeshEdit('select'));
document.getElementById('me-close-x')?.addEventListener('click', _closeMeshEdit);
document.getElementById('me-cancel')?.addEventListener('click', _closeMeshEdit);
document.getElementById('me-undo')?.addEventListener('click', _meUndo);
document.getElementById('me-redo')?.addEventListener('click', _meRedo);

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
['push', 'pull', 'smooth', 'flatten', 'grab', 'inflate'].forEach(sm => {
  document.getElementById('me-sculpt-' + sm)?.addEventListener('click', () => {
    meState.sculptMode = sm;
    ['push', 'pull', 'smooth', 'flatten', 'grab', 'inflate'].forEach(s => document.getElementById('me-sculpt-' + s)?.classList.toggle('tool-active', s === sm));
  });
});
// Symmetry toggles
['x', 'y', 'z'].forEach(axis => {
  const btn = document.getElementById('me-sym-' + axis);
  btn?.addEventListener('click', () => {
    meState.symmetryAxes[axis] = !meState.symmetryAxes[axis];
    btn.classList.toggle('tool-active', meState.symmetryAxes[axis]);
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
document.getElementById('me-paint-pick')?.addEventListener('click', () => {
  meState.pickMode = !meState.pickMode;
  document.getElementById('me-paint-pick')?.classList.toggle('tool-active', meState.pickMode);
});
document.getElementById('me-paint-color')?.addEventListener('input', (e) => {
  meState.color = e.target.value;
});
// Select actions
document.getElementById('me-sel-delete')?.addEventListener('click', () => {
  if (!meState.mesh) return;
  _meRestoreView();
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
  _meRestoreView();
  meState.mesh?.traverse(c => {
    if (!c.isMesh || !c.geometry?.attributes?.color) return;
    const color = c.geometry.attributes.color;
    for (let i = 0; i < color.count; i++) color.setXYZ(i, 0.7, 0.7, 0.7);
    color.needsUpdate = true;
    c.material.vertexColors = false;
    c.material.needsUpdate = true;
  });
});

// ── Extended Select tools (ported from desktop, adapted to the cloud's
// orange-selection model: a vertex is selected when r>0.9 & g<0.5). ──
const _meOrange = (col, i) => col.getX(i) > 0.9 && col.getY(i) < 0.5;
function _meEnsureSelColor(c) {
  const geom = c.geometry;
  if (!geom.attributes.color) {
    geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(geom.attributes.position.count * 3).fill(0.7), 3));
  }
  c.material.vertexColors = true; c.material.needsUpdate = true;
  return geom.attributes.color;
}
function _meSelHas() {
  let has = false;
  meState.mesh?.traverse(c => {
    if (has || !c.isMesh || !c.geometry?.attributes?.color) return;
    const col = c.geometry.attributes.color;
    for (let i = 0; i < col.count; i++) { if (_meOrange(col, i)) { has = true; break; } }
  });
  return has;
}
function _meBuildPosAdj(geom) {
  if (geom._posGroups && geom._posKeyByIndex) return;
  const pos = geom.attributes.position;
  const groups = new Map(), keyByIndex = new Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const k = Math.round(pos.getX(i) * 1e5) + ',' + Math.round(pos.getY(i) * 1e5) + ',' + Math.round(pos.getZ(i) * 1e5);
    keyByIndex[i] = k;
    let arr = groups.get(k); if (!arr) { arr = []; groups.set(k, arr); } arr.push(i);
  }
  geom._posGroups = groups; geom._posKeyByIndex = keyByIndex;
}
function _meRestoreView() {
  if (!meState.viewMode || meState.viewMode === 'none') return;
  meState.mesh?.traverse(c => {
    if (c.isMesh && c.geometry && c.geometry._viewBackup) {
      c.geometry.setIndex(c.geometry._viewBackup);
      c.geometry._viewBackup = null;
      c.geometry.attributes.position.needsUpdate = true;
    }
  });
  meState.viewMode = 'none';
  document.getElementById('me-sel-isolate')?.classList.remove('tool-active');
  document.getElementById('me-sel-hide')?.classList.remove('tool-active');
}
function _meApplyView(mode) {
  if (!meState.mesh) return;
  const wasActive = meState.viewMode === mode;
  _meRestoreView();
  if (wasActive) return;
  if (!_meSelHas()) { showToast('Select faces first', 'info', 1400); return; }
  meState.mesh.traverse(c => {
    if (!c.isMesh || !c.geometry?.index || !c.geometry.attributes.color) return;
    const geom = c.geometry, col = geom.attributes.color, idx = geom.index.array;
    geom._viewBackup = new THREE.BufferAttribute(idx.slice(), 1);
    const keep = [];
    for (let i = 0; i < idx.length; i += 3) {
      const hit = _meOrange(col, idx[i]) || _meOrange(col, idx[i + 1]) || _meOrange(col, idx[i + 2]);
      if (mode === 'isolate' ? hit : !hit) keep.push(idx[i], idx[i + 1], idx[i + 2]);
    }
    geom.setIndex(keep);
    geom.attributes.position.needsUpdate = true;
  });
  meState.viewMode = mode;
  document.getElementById('me-sel-' + mode)?.classList.add('tool-active');
}
document.getElementById('me-sel-isolate')?.addEventListener('click', () => _meApplyView('isolate'));
document.getElementById('me-sel-hide')?.addEventListener('click', () => _meApplyView('hide'));
document.getElementById('me-sel-all')?.addEventListener('click', () => {
  meState.mesh?.traverse(c => {
    if (!c.isMesh || !c.geometry?.attributes?.position) return;
    const col = _meEnsureSelColor(c);
    for (let i = 0; i < col.count; i++) col.setXYZ(i, 1.0, 0.3, 0.1);
    col.needsUpdate = true;
  });
});
document.getElementById('me-sel-grow')?.addEventListener('click', () => {
  meState.mesh?.traverse(c => {
    if (!c.isMesh || !c.geometry?.index || !c.geometry.attributes.color) return;
    const geom = c.geometry, col = geom.attributes.color, idx = geom.index.array;
    _meBuildPosAdj(geom);
    const keyOf = geom._posKeyByIndex, groups = geom._posGroups, selKeys = new Set();
    for (let i = 0; i < col.count; i++) if (_meOrange(col, i)) selKeys.add(keyOf[i]);
    if (!selKeys.size) return;
    const addKeys = new Set();
    for (let t = 0; t < idx.length; t += 3) {
      const ka = keyOf[idx[t]], kb = keyOf[idx[t + 1]], kd = keyOf[idx[t + 2]];
      if (selKeys.has(ka) || selKeys.has(kb) || selKeys.has(kd)) { addKeys.add(ka); addKeys.add(kb); addKeys.add(kd); }
    }
    for (const k of addKeys) for (const v of groups.get(k)) col.setXYZ(v, 1.0, 0.3, 0.1);
    col.needsUpdate = true;
  });
});
document.getElementById('me-sel-shrink')?.addEventListener('click', () => {
  meState.mesh?.traverse(c => {
    if (!c.isMesh || !c.geometry?.index || !c.geometry.attributes.color) return;
    const geom = c.geometry, col = geom.attributes.color, idx = geom.index.array;
    _meBuildPosAdj(geom);
    const keyOf = geom._posKeyByIndex, groups = geom._posGroups, selKeys = new Set();
    for (let i = 0; i < col.count; i++) if (_meOrange(col, i)) selKeys.add(keyOf[i]);
    if (!selKeys.size) return;
    const removeKeys = new Set();
    for (let t = 0; t < idx.length; t += 3) {
      const ka = keyOf[idx[t]], kb = keyOf[idx[t + 1]], kd = keyOf[idx[t + 2]];
      const sa = selKeys.has(ka), sb = selKeys.has(kb), sd = selKeys.has(kd);
      if (!(sa && sb && sd)) { if (sa) removeKeys.add(ka); if (sb) removeKeys.add(kb); if (sd) removeKeys.add(kd); }
    }
    for (const k of removeKeys) for (const v of groups.get(k)) col.setXYZ(v, 0.7, 0.7, 0.7);
    col.needsUpdate = true;
  });
});
document.getElementById('me-sel-crop')?.addEventListener('click', () => {
  if (!meState.mesh || !_meSelHas()) return;
  const keepRest = !!document.getElementById('me-sel-crop-keeprest')?.checked;
  _meRestoreView(); _mePushUndo();
  meState.mesh.traverse(c => {
    if (!c.isMesh || !c.geometry?.index || !c.geometry.attributes.color) return;
    const geom = c.geometry, col = geom.attributes.color, idx = geom.index.array, keep = [];
    for (let i = 0; i < idx.length; i += 3) {
      const hit = _meOrange(col, idx[i]) || _meOrange(col, idx[i + 1]) || _meOrange(col, idx[i + 2]);
      if (keepRest ? !hit : hit) keep.push(idx[i], idx[i + 1], idx[i + 2]);
    }
    geom.setIndex(keep); geom.attributes.position.needsUpdate = true;
    geom._posGroups = null; geom._posKeyByIndex = null;
  });
  showToast(keepRest ? 'Kept the rest' : 'Cropped to selection', 'success', 1500);
});
document.getElementById('me-sel-flip')?.addEventListener('click', () => {
  if (!meState.mesh || !_meSelHas()) return;
  _meRestoreView(); _mePushUndo();
  meState.mesh.traverse(c => {
    if (!c.isMesh || !c.geometry?.index || !c.geometry.attributes.color) return;
    const geom = c.geometry, col = geom.attributes.color, idx = geom.index.array;
    for (let i = 0; i < idx.length; i += 3) {
      if (_meOrange(col, idx[i]) || _meOrange(col, idx[i + 1]) || _meOrange(col, idx[i + 2])) {
        const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t;
      }
    }
    geom.index.needsUpdate = true; geom.computeVertexNormals();
  });
  showToast('Flipped selected faces', 'success', 1400);
});
document.getElementById('me-sel-smooth')?.addEventListener('click', () => {
  if (!meState.mesh || !_meSelHas()) return;
  _meRestoreView(); _mePushUndo();
  meState.mesh.traverse(c => {
    if (!c.isMesh || !c.geometry?.index || !c.geometry.attributes.position || !c.geometry.attributes.color) return;
    const geom = c.geometry, pos = geom.attributes.position, col = geom.attributes.color, idx = geom.index.array;
    _meBuildPosAdj(geom);
    const keyOf = geom._posKeyByIndex, groups = geom._posGroups, neigh = new Map();
    const addN = (a, b) => { let s = neigh.get(keyOf[a]); if (!s) { s = new Set(); neigh.set(keyOf[a], s); } s.add(keyOf[b]); };
    for (let i = 0; i < idx.length; i += 3) { const a = idx[i], b = idx[i + 1], d = idx[i + 2]; addN(a, b); addN(a, d); addN(b, a); addN(b, d); addN(d, a); addN(d, b); }
    const keyPos = new Map();
    for (const [k, ids] of groups) { const v = ids[0]; keyPos.set(k, [pos.getX(v), pos.getY(v), pos.getZ(v)]); }
    const lambda = 0.5;
    for (let it = 0; it < 2; it++) {
      const next = new Map();
      for (const [k, ns] of neigh) {
        if (!ns.size) continue;
        let sx = 0, sy = 0, sz = 0; for (const nk of ns) { const p = keyPos.get(nk); sx += p[0]; sy += p[1]; sz += p[2]; }
        const inv = 1 / ns.size, cur = keyPos.get(k);
        next.set(k, [cur[0] + lambda * (sx * inv - cur[0]), cur[1] + lambda * (sy * inv - cur[1]), cur[2] + lambda * (sz * inv - cur[2])]);
      }
      for (const [k, p] of next) keyPos.set(k, p);
    }
    for (let i = 0; i < col.count; i++) if (_meOrange(col, i)) { const p = keyPos.get(keyOf[i]); if (p) pos.setXYZ(i, p[0], p[1], p[2]); }
    pos.needsUpdate = true; geom.computeVertexNormals();
  });
  showToast('Smoothed selection', 'success', 1400);
});
document.getElementById('me-sel-duplicate')?.addEventListener('click', () => {
  if (!meState.mesh || !_meSelHas()) return;
  _meRestoreView(); _mePushUndo();
  meState.mesh.traverse(c => {
    if (!c.isMesh || !c.geometry?.index || !c.geometry.attributes.color) return;
    const geom = c.geometry, col = geom.attributes.color, pos = geom.attributes.position, idx = geom.index.array, tris = [];
    for (let i = 0; i < idx.length; i += 3) { if (_meOrange(col, idx[i]) || _meOrange(col, idx[i + 1]) || _meOrange(col, idx[i + 2])) tris.push(idx[i], idx[i + 1], idx[i + 2]); }
    if (!tris.length) return;
    geom.computeBoundingBox();
    const bb = geom.boundingBox, eps = (bb ? bb.min.distanceTo(bb.max) : 1) * 0.01;
    const oldV = pos.count, addV = tris.length;
    const newPos = new Float32Array((oldV + addV) * 3); newPos.set(pos.array.subarray(0, oldV * 3));
    const newCol = new Float32Array((oldV + addV) * 3); newCol.set(col.array.subarray(0, oldV * 3));
    const uv = geom.attributes.uv || null;
    const newUV = uv ? new Float32Array((oldV + addV) * 2) : null;
    if (uv) newUV.set(uv.array.subarray(0, oldV * 2));
    const newIdx = Array.from(idx);
    const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vD = new THREE.Vector3(), n = new THREE.Vector3(), tmp = new THREE.Vector3();
    let w = oldV;
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t], b = tris[t + 1], d = tris[t + 2];
      vA.fromBufferAttribute(pos, a); vB.fromBufferAttribute(pos, b); vD.fromBufferAttribute(pos, d);
      n.subVectors(vB, vA).cross(tmp.subVectors(vD, vA)).normalize().multiplyScalar(eps);
      const base = w, ids = [a, b, d];
      for (let k = 0; k < 3; k++) {
        const s = ids[k];
        newPos[w * 3] = pos.getX(s) + n.x; newPos[w * 3 + 1] = pos.getY(s) + n.y; newPos[w * 3 + 2] = pos.getZ(s) + n.z;
        newCol[w * 3] = 1.0; newCol[w * 3 + 1] = 0.3; newCol[w * 3 + 2] = 0.1;
        if (uv) { newUV[w * 2] = uv.getX(s); newUV[w * 2 + 1] = uv.getY(s); }
        w++;
      }
      newIdx.push(base, base + 1, base + 2);
    }
    geom.setAttribute('position', new THREE.BufferAttribute(newPos, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(newCol, 3));
    if (uv) geom.setAttribute('uv', new THREE.BufferAttribute(newUV, 2));
    geom.setIndex(newIdx);
    geom._posGroups = null; geom._posKeyByIndex = null;
    geom.attributes.position.needsUpdate = true; geom.attributes.color.needsUpdate = true;
    geom.computeVertexNormals();
    c.material.vertexColors = true; c.material.needsUpdate = true;
  });
  showToast('Duplicated selection', 'success', 1500);
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
  _meRestoreView();   // never bake an isolated/hidden view into the saved GLB
  const projName = state.currentProject?.name || '';
  const job = pushJob(`Save mesh edit: ${projName}`, null, null, 8000, undefined, {
    projectName: projName,
    assetKind: 'mesh_edit',
  });
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
          // Cloud worker writes to a different R2 location (per-user prefix)
          // and returns the actual URL in r.url. Falling back to r.path keeps
          // desktop unchanged (save-buffer IPC returns { success, path }).
          const actualPath = (r && (r.url || r.path)) || newPath;
          // Add to project mesh list
          const p = state.currentProject;
          if (p) {
            const filename = actualPath.replace(/\\/g, '/').split('/').pop();
            const info = await API.getFileInfo(actualPath);
            p.meshes.unshift({
              path: actualPath,
              filename,
              size: info?.size || buf.length,
              mtime: Date.now(),
            });
            p.selectedMeshPath = actualPath;
          }
          completeJob(job.id, true);
          showToast('Edited mesh saved!', 'success', 2000);
          _closeMeshEdit();
          populateWorkspace(state.currentProject);
        } else {
          const msg = (r && r.error) || 'unknown';
          completeJob(job.id, false, msg);
          showToast('Save failed: ' + msg, 'error', 3000);
        }
      } catch (err) {
        console.error('[mesh-edit] save error:', err);
        completeJob(job.id, false, err.message);
        showToast('Save error: ' + err.message, 'error', 3000);
      }
    }, (err) => {
      completeJob(job.id, false, String(err));
      showToast('Export error: ' + err, 'error', 3000);
    }, { binary: true });
  } catch (err) {
    completeJob(job.id, false, err.message);
    showToast('Export failed: ' + err.message, 'error', 3000);
  }
});

// Maps each licence to whether it allows commercial sale. Surfaced
// next to the licence dropdown as a green/red pill so the user knows
// instantly what they're committing to.
const SELLABLE_LICENCES = {
  personal:   false,
  cc0:        true,
  'cc-by':    true,
  'cc-by-nc': false,
  commercial: true,
};
function _renderLicenceSellable(spanId, licence) {
  const el = document.getElementById(spanId);
  if (!el) return;
  const sellable = SELLABLE_LICENCES[licence];
  // "by users" makes it explicit that this is about end-users
  // monetising the asset they exported / publish, not about the
  // platform's right to sell.
  el.textContent = sellable ? '✓ Sellable by users' : '✗ Not sellable by users';
  const colorMain = sellable ? 'var(--ok, #4caf50)' : 'var(--err, #f44336)';
  const colorBg   = sellable ? 'rgba(76,175,80,0.15)' : 'rgba(244,67,54,0.15)';
  const colorBd   = sellable ? 'rgba(76,175,80,0.4)'  : 'rgba(244,67,54,0.4)';
  el.style.cssText = 'display:inline-flex; align-items:center; gap:4px; '
    + 'padding:1px 8px; border-radius:999px; font-size:10px; font-weight:700; '
    + 'color:' + colorMain + '; '
    + 'background:' + colorBg + '; '
    + 'border:1px solid ' + colorBd + ';';
}
function _wireLicenceSellable(selectId, spanId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const sync = () => _renderLicenceSellable(spanId, sel.value);
  sel.addEventListener('change', sync);
  sync();
}
// Wire all three licence dropdowns at boot.
document.addEventListener('DOMContentLoaded', () => {
  _wireLicenceSellable('exp-licence',    'exp-licence-sellable');
  _wireLicenceSellable('expimg-licence', 'expimg-licence-sellable');
  _wireLicenceSellable('pub-licence',    'pub-licence-sellable');
  // Pending rigs left over from a previous tab/refresh. autoRigAI stashes
  // {jobId, projectName, meshUrl, createdAt} in localStorage so this page
  // can surface the orphan and resume polling instead of silently losing
  // the user's credit. We keep at most the 10 most recent entries.
  //
  // Resumed rigs re-create the original "work in progress" popup (via
  // pushJob with startedAt=p.createdAt so the elapsed timer continues
  // from the real launch time) and a poll loop drives the bar to done
  // or error.
  try {
    const raw = localStorage.getItem('fabmesh_pending_rigs') || '[]';
    const pending = JSON.parse(raw);
    if (!Array.isArray(pending) || pending.length === 0) return;
    const now = Date.now();
    // Drop anything >30 min old — likely already completed and visible in
    // Projects, or definitively timed out.
    const fresh = pending.filter(p => p && p.jobId && (now - (p.createdAt || 0)) < 30 * 60 * 1000);
    if (fresh.length !== pending.length) {
      localStorage.setItem('fabmesh_pending_rigs', JSON.stringify(fresh));
    }
    if (fresh.length === 0) return;

    const _dropPending = (jobId) => {
      try {
        const after = (JSON.parse(localStorage.getItem('fabmesh_pending_rigs') || '[]') || [])
          .filter(x => x.jobId !== jobId);
        localStorage.setItem('fabmesh_pending_rigs', JSON.stringify(after));
      } catch (e) { /* ignore */ }
    };

    fresh.forEach((p) => {
      const projectLabel = p.projectName || p.jobId;
      // Re-create the live progress popup. pushJob computes the initial
      // progress from (Date.now() - startedAt) / expectedMs so the bar
      // appears where it actually is, not at 0%.
      const job = pushJob(
        `Auto-rig AI (resumed): ${projectLabel}`,
        null,                                    // no client-side cancel — server still owns the job
        { 'Project': projectLabel, 'Resumed': 'yes' },
        180 * 1000,                              // expected ~3 min (matches autoRigAI cadence)
        p.createdAt || Date.now(),
        { projectName: p.projectName || null, sourceImageUrl: p.meshUrl || null },
      );

      let cancelled = false;
      const POLL_INTERVAL_MS = 5000;
      const MAX_POLLS = 180;        // 15 min absolute ceiling
      let polls = 0;
      let consecutiveErr = 0;

      const tick = async () => {
        if (cancelled) return;
        if (polls++ >= MAX_POLLS) {
          if (typeof completeJob === 'function') completeJob(job.id, false, 'auto-rig timeout (>15 min) — check Projects later');
          _dropPending(p.jobId);
          return;
        }
        try {
          const resp = await fetch(`/api/auto-rig-status?job_id=${encodeURIComponent(p.jobId)}`, {
            method: 'GET', credentials: 'same-origin',
          });
          if (!resp.ok) {
            consecutiveErr++;
            if (consecutiveErr >= 30) {
              if (typeof completeJob === 'function') completeJob(job.id, false, `backend unreachable (${resp.status})`);
              _dropPending(p.jobId);
              return;
            }
            setTimeout(tick, POLL_INTERVAL_MS);
            return;
          }
          consecutiveErr = 0;
          const st = await resp.json();
          if (st?.status === 'done') {
            if (typeof completeJob === 'function') completeJob(job.id, true);
            _dropPending(p.jobId);
            // Push the new rig into state if we're on the right project,
            // else fire the orphan event so the projects list picks it up.
            const glbUrl = st.mesh_url || st.url || st.path || null;
            if (glbUrl && state.currentProject && state.currentProject.name === p.projectName) {
              state.currentProject.rigs = state.currentProject.rigs || [];
              if (!state.currentProject.rigs.some(r => r.url === glbUrl)) {
                state.currentProject.rigs.push({
                  filename: glbUrl.split('/').pop() || 'rigged.glb',
                  url: glbUrl, path: glbUrl, asset_type: 'rig',
                  size: 0, created: new Date().toISOString(),
                });
              }
              if (typeof window._updateRigToolButtons === 'function') {
                try { window._updateRigToolButtons(); } catch (e) {}
              }
            }
            if (typeof refreshProjectsPage === 'function') refreshProjectsPage();
            return;
          }
          if (st?.status === 'failed') {
            if (typeof completeJob === 'function') completeJob(job.id, false, st.error || 'auto-rig failed');
            _dropPending(p.jobId);
            return;
          }
          // 'pending' — keep polling. The job bar continues to advance on
          // its own via the tickTimer inside pushJob.
          setTimeout(tick, POLL_INTERVAL_MS);
        } catch (e) {
          consecutiveErr++;
          if (consecutiveErr >= 30) {
            if (typeof completeJob === 'function') completeJob(job.id, false, e?.message || String(e));
            _dropPending(p.jobId);
            return;
          }
          setTimeout(tick, POLL_INTERVAL_MS);
        }
      };
      // Stagger the first tick by 1s so multiple resumed jobs don't all
      // hit the worker at the exact same instant.
      setTimeout(tick, 1000);
    });
  } catch (e) { /* localStorage parse fail, ignore */ }

  // 2026-06-02: SERVER-SIDE resume of in-flight jobs. The localStorage
  // path above only knows about rigs that THIS browser launched —
  // anim/mesh jobs from other tabs or post-refresh lose their progress
  // widget. Hit /api/me/active-jobs on boot, re-push everything that
  // Supabase still considers in-flight, then poll the same endpoint
  // every 8s. When a job disappears from the active list it must have
  // succeeded/failed; mark it locally + refresh the current project so
  // the new asset shows up immediately.
  try {
    if (typeof fetch !== 'function') return;
    const _kindFromAssetType = (at, name) => {
      const a = String(at || '').toLowerCase();
      if (a === 'animation' || a === 'anim') return 'anim';
      if (a === 'rig' || a === 'rigging') return 'rig';
      if (a === 'mesh' || a === '3d' || a === 'image-to-3d') return 'mesh';
      if (a === 'image' || a === 'text-to-image') return 'image';
      return inferKind(name || '') || 'image';
    };
    const _displayName = (row) => {
      const kind = _kindFromAssetType(row.asset_type, '');
      const project = row.project_name || (row.options && row.options.project_name) || row.id.slice(0, 8);
      const verb = ({
        anim: `Animate ${row.mode || 'run'}`,
        rig: 'Auto-rig AI (unirig)',
        mesh: 'Generate 3D',
        image: 'Generate images',
      })[kind] || 'Job';
      return `${verb}: ${project}`;
    };
    const _expectedFor = (kind) => ({ anim: 180000, rig: 180000, mesh: 110000, image: 30000 })[kind] || 60000;
    const _serverPolledIds = new Set();  // local job.id we created → server job.id
    const _jobByServerId = new Map();     // server job.id → local job

    const _fetchActive = async () => {
      try {
        const r = await fetch('/api/me/active-jobs', { credentials: 'same-origin' });
        if (!r.ok) return null;
        const j = await r.json();
        return Array.isArray(j?.jobs) ? j.jobs : [];
      } catch (_) { return null; }
    };
    const _resumeOne = (row) => {
      const kind = _kindFromAssetType(row.asset_type, '');
      const project = row.project_name || (row.options && row.options.project_name) || null;
      const startedAt = row.created_at ? Date.parse(row.created_at) : Date.now();
      const params = {
        Project: project || '—',
        Type: row.asset_type || '—',
        Resumed: 'yes',
      };
      const local = pushJob(
        _displayName(row),
        null,
        params,
        _expectedFor(kind),
        startedAt,
        { projectName: project || null },
      );
      _jobByServerId.set(row.id, local);
      _serverPolledIds.add(local.id);
    };

    const _bootAndPoll = async () => {
      const rows = await _fetchActive();
      if (!Array.isArray(rows)) return;
      rows.forEach(_resumeOne);
      // Subsequent ticks: if any tracked server id disappears, mark the
      // local job done (success — without a status endpoint per-kind we
      // can't tell error vs done here, so we assume success and let the
      // project reload bring up the actual asset). Errors will surface
      // via the next handleListMeshes/projects refresh.
      const _tick = async () => {
        const cur = await _fetchActive();
        if (!Array.isArray(cur)) {
          setTimeout(_tick, 12000);
          return;
        }
        const stillActive = new Set(cur.map(r => r.id));
        for (const [sid, local] of Array.from(_jobByServerId.entries())) {
          if (!stillActive.has(sid)) {
            try { completeJob(local.id, true); } catch (_) {}
            _jobByServerId.delete(sid);
            // Refresh the current project view so the new mesh/rig/anim
            // shows in the strip without a full reload.
            try {
              if (state.currentProject && typeof reloadCurrentProject === 'function') {
                reloadCurrentProject();
              }
            } catch (_) {}
          }
        }
        // Also pick up jobs we didn't know about yet (e.g. spawned in
        // another tab).
        for (const row of cur) {
          if (!_jobByServerId.has(row.id)) _resumeOne(row);
        }
        setTimeout(_tick, 8000);
      };
      setTimeout(_tick, 8000);
    };
    // Defer slightly so initial pushJob calls don't clash with the
    // localStorage rig-resume path above.
    setTimeout(_bootAndPoll, 1200);
  } catch (_) { /* never block app boot on resume */ }
});

document.getElementById('ws-mesh-export-btn')?.addEventListener('click', () => {
  const m = getCurrentMeshObj();
  if (!m) { showToast('Pick a mesh first.', 'error'); return; }
  const modal = document.getElementById('modal-export-mesh');
  const baseName = m.filename.replace(/\.[^.]+$/, '');
  // Output path defaults to the OS Downloads folder. On cloud the
  // browser writes there by default for any <a download>; on
  // desktop the IPC handler resolves "Downloads/" via app.getPath.
  document.getElementById('exp-path').value = '';
  document.getElementById('exp-path').placeholder = `Downloads/${baseName}.<ext>`;
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
  // Desktop returns a plain string ("C:\Users\…"), cloud returns an
  // object { ok, path, cloud }. Normalise to a string before
  // writing into the input — without this the cloud path produced
  // a literal "[object Object]" in the UI.
  const pickedPath = typeof picked === 'string'
    ? picked
    : (picked && typeof picked === 'object' && picked.path) ? picked.path : '';
  if (pickedPath) document.getElementById('exp-path').value = pickedPath;
});
// Licence options chosen by the user in the Export modal. Keys
// match the <select id="exp-licence"> value attributes; bodies are
// shipped as a sibling LICENSE.txt next to the exported mesh.
const EXPORT_LICENCES = {
  personal: {
    label: 'Personal use only',
    body: 'This 3D asset is licensed for personal, non-commercial use by the original purchaser only. Redistribution, resale, sublicensing, or use in commercial products is not permitted without explicit written permission.',
  },
  cc0: {
    label: 'Public domain (CC0 1.0)',
    body: 'This 3D asset is released into the public domain under Creative Commons CC0 1.0 Universal. You may copy, modify, distribute, and use it freely, including for commercial purposes, without asking permission. See https://creativecommons.org/publicdomain/zero/1.0/',
  },
  'cc-by': {
    label: 'Attribution required (CC-BY 4.0)',
    body: 'This 3D asset is licensed under Creative Commons Attribution 4.0 International (CC-BY 4.0). You may share and adapt it for any purpose, including commercial, provided you give appropriate credit to the original author. See https://creativecommons.org/licenses/by/4.0/',
  },
  'cc-by-nc': {
    label: 'Non-commercial only (CC-BY-NC 4.0)',
    body: 'This 3D asset is licensed under Creative Commons Attribution-NonCommercial 4.0 International (CC-BY-NC 4.0). You may share and adapt it for non-commercial purposes only, with attribution. Commercial use is not permitted. See https://creativecommons.org/licenses/by-nc/4.0/',
  },
  commercial: {
    label: 'Royalty-free commercial',
    body: 'This 3D asset is licensed for royalty-free commercial use by the original purchaser. You may use it in unlimited commercial projects, but redistribution or resale of the asset itself (standalone or as part of a marketplace pack) is not permitted.',
  },
};

// Live licence hint — rewrites the small grey description under the
// licence dropdown so the user sees what they're committing to before
// they hit Export.
(function _wireLicenceHint() {
  const sel = document.getElementById('exp-licence');
  const hint = document.getElementById('exp-licence-hint');
  if (!sel || !hint) return;
  const sync = () => {
    const lic = EXPORT_LICENCES[sel.value];
    if (!lic) return;
    const short = lic.body.length > 180 ? lic.body.slice(0, 175) + '…' : lic.body;
    hint.textContent = short + ' (Saved as a sibling LICENSE.txt next to your mesh.)';
  };
  sel.addEventListener('change', sync);
  sync();
})();

document.getElementById('exp-go')?.addEventListener('click', async () => {
  const m = getCurrentMeshObj();
  if (!m) return;
  const format = document.getElementById('exp-format').value;
  const outputPath = document.getElementById('exp-path').value.trim() || null;
  const licenceKey = document.getElementById('exp-licence')?.value || 'personal';
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
  const licence = EXPORT_LICENCES[licenceKey] || EXPORT_LICENCES.personal;
  const job = pushJob(`Export ${format}: ${m.filename}`, null, { Licence: licence.label });
  try {
    const r = await API.exportMesh({ sourcePath, targetFormat: format, outputPath, licence: licenceKey });
    const outPath = r?.outputPath || r?.path;
    if (outPath) {
      completeJob(job.id, true);
      // Drop a sibling LICENSE.txt next to the mesh so the licence
      // travels with the asset. On cloud this triggers a second
      // browser download; on desktop the IPC handler writes it on
      // disk via fs.writeFile.
      try {
        const baseName = String(m.filename || 'mesh').replace(/\.[^.]+$/, '');
        const txt = `${licence.label}\n\n${licence.body}\n\nExported ${new Date().toISOString()} via MyFabmesh.AI.`;
        if (API.writeLicenceFile) {
          await API.writeLicenceFile({ outputPath: outPath, content: txt });
        } else {
          // Cloud fallback — trigger a client download.
          const blob = new Blob([txt], { type: 'text/plain' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = baseName + '_LICENSE.txt';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1500);
        }
      } catch (licErr) {
        console.warn('[export] LICENSE sidecar failed:', licErr);
      }
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
  // (UniRig). Keep the function as a no-op so the existing call sites
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
  // Toggle the "Use this rig for Animation -> " bar based on rig presence.
  const useAnimBar = document.getElementById('ws-use-for-anim-bar');
  if (useAnimBar) useAnimBar.classList.toggle('hidden', !rig);
  if (rig) {
    const animBtn = document.getElementById('ws-use-for-anim-btn');
    const p = state.currentProject;
    if (animBtn) {
      const isSelected = p && p.selectedRigPath === rig.path;
      animBtn.disabled = false;
      animBtn.classList.toggle('used-state', isSelected);
      animBtn.textContent = isSelected ? '✓ Used for Animation generation →' : 'Use this rig for Animation →';
    }
  }
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
  // Aggressive scene purge — same fix as the anim viewer. Project
  // switches sometimes leave a previous-project mesh hanging in the
  // scene (the rigVwModel ref gets cleared but the Object3D is still
  // a child). Walk and remove everything that isn't a light/camera.
  if (rigVwScene) {
    const toRemove = [];
    rigVwScene.children.forEach(c => {
      if (c.isLight || c.isCamera) return;
      if (c.userData?._viewerKeep) return;
      toRemove.push(c);
    });
    for (const c of toRemove) {
      try {
        rigVwScene.remove(c);
        c.traverse?.(o => {
          try {
            o.geometry?.dispose?.();
            const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
            mats.forEach(m => { try { m.dispose?.(); } catch (_) {} });
          } catch (_) {}
        });
      } catch (_) {}
    }
  }
  const ext = (rig.filename || '').toLowerCase().split('.').pop();
  // Infer the rig template name from the filename: <base>_rigged_<template>_<ts>.fbx
  // → captures things like "orc_m1", "ue5_mannequin", "humanoid".
  let inferredTemplate = null;
  const _tplMatch = rig.filename && rig.filename.match(/_rigged_([a-z0-9_-]+?)(?:_\d{10,})?\.[^.]+$/i);
  if (_tplMatch) inferredTemplate = _tplMatch[1];
  setViewerLoading('step3-preview', true, 'Loading rig…');
  try {
    if (ext === 'fbx') {
      // FBXLoader needs a URL because it loads textures relative to the file
      const url = _toFileUrl(rig.path);
      const loader = new FBXLoader();
      loader.load(url, async (obj) => {
        setViewerLoading('step3-preview', false);
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
                  const aurl = _toFileUrl(af.path);
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
      if (!buffer) { setViewerLoading('step3-preview', false); return; }
      const loader = new GLTFLoader();
      loader.parse(buffer, '', (gltf) => {
        setViewerLoading('step3-preview', false);
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
    // Selected rig also gets the green used-for-3d check (kept in sync with
    // jumpToRig + on click), mirroring desktop.
    if (i === 0) t.classList.add('selected', 'used-for-3d');
    // Resolve the parent mesh once: drives both the 🧊 mesh-jump button and the
    // 📷 source-image button (R2-listed rigs carry sourceImage:null on cloud, so
    // the source image is inherited from the parent mesh).
    const _rigMeshPath = _resolveParentMeshPath(r, p);
    let _rigSourceImage = r.sourceImage || null;
    if (!_rigSourceImage && _rigMeshPath) {
      const pm = (p.meshes || []).find((m) => _sigKey(m.path) === _sigKey(_rigMeshPath));
      if (pm && pm.sourceImage) _rigSourceImage = pm.sourceImage;
    }
    let thumbSrc = '';
    if (r.thumb) {
      thumbSrc = r.thumb.startsWith('file:') ? r.thumb : _toFileUrl(r.thumb);
    } else if (r.sourceImage) {
      thumbSrc = _toFileUrl(r.sourceImage);
    } else if (p.thumb) {
      thumbSrc = _toFileUrl(p.thumb);
    }
    // Lineage buttons (guarded). 📷 = source image, 🧊 = parent mesh.
    const rigSrcBtn = _rigSourceImage
      ? '<button class="version-source-btn" title="Voir l\'image source">&#128247;</button>' : '';
    const rigMeshBtn = _rigMeshPath
      ? '<button class="version-mesh-btn" title="Voir le maillage source">&#129482;</button>' : '';
    t.innerHTML = `
      ${thumbSrc ? `<img src="${thumbSrc}" alt="">` : ''}
      <span class="v-used-badge" title="Used for next step">&#10003;</span>
      <span class="v-label">v${p.rigs.length - 1 - i}</span>
      <button class="version-delete-btn" title="Delete this rig">&#10005;</button>
      ${rigSrcBtn}
      ${rigMeshBtn}
    `;
    t.title = r.filename;
    t.addEventListener('click', () => {
      strip.querySelectorAll('.version-thumb').forEach(x => x.classList.remove('selected', 'used-for-3d'));
      t.classList.add('selected', 'used-for-3d');
      showStep3Preview(r);
    });
    if (_rigSourceImage) {
      t.querySelector('.version-source-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        jumpToSourceImage(_rigSourceImage);
      });
    }
    if (_rigMeshPath) {
      t.querySelector('.version-mesh-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        jumpToMesh(_rigMeshPath);
      });
    }
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
// Toggle the 4 EDIT SELECTED rig tool buttons based on whether a rig
// is selectable. Each button has class="rig-tool-btn" so we can flip
// the whole set in one query. Without this, all 4 buttons sit disabled
// in markup forever and the user can never click them, even after a
// successful rig generation.
function _updateRigToolButtons() {
  const hasRig = !!(state.currentProject?.rigs?.length);
  document.querySelectorAll('.rig-tool-btn').forEach((btn) => {
    btn.disabled = !hasRig;
    btn.style.opacity = hasRig ? '' : '0.5';
    btn.style.cursor = hasRig ? '' : 'not-allowed';
    btn.title = hasRig ? '' : 'Generate a rig first';
  });
  // Test animation needs an in-viewer mixer + clips loaded — separate gate.
  const testBtn = document.getElementById('ws-rig-test-btn');
  if (testBtn && hasRig) {
    const haveClips = !!(window.rigVwMixer && window.rigVwClips && window.rigVwClips.length > 0);
    if (!haveClips) {
      testBtn.title = 'Loading rig animations…';
    } else {
      testBtn.title = `Play ${window.rigVwClips.length} embedded clip(s)`;
    }
  }
}
window._updateRigToolButtons = _updateRigToolButtons;

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

// AUTO-RIG AI button handler — engine selected via #ws-rig-engine (unirig)
document.getElementById('ws-generate-rig-ai')?.addEventListener('click', async () => {
  const p = state.currentProject;
  if (!p) return;
  const meshPathToUse = p.selectedMeshPath
    || (p.meshes && p.meshes[0] && p.meshes[0].path)
    || rigSrcMeshPath;
  if (!meshPathToUse) { alert('No mesh available — generate or pick one first.'); return; }
  if (!API.autoRigAI) { alert('Rigging bridge not available.'); return; }
  const rigEngine = document.getElementById('ws-rig-engine')?.value || 'unirig';
  const engineLabel = 'MyFabmesh.AI Rig (cloud GPU)';
  // Realistic budget: Modal A10G cold-start 60-120s + Puppeteer pipeline 120-180s.
  // 1m30s was the pre-cloud desktop figure and made the bar look dead within 90s.
  const expectedMs = 240000;
  gatedRun('rig', `Auto-rig AI: ${p.name}`, async () => {
    const job = pushJob(`Auto-rig AI (${rigEngine}): ${p.name}`, null, {
      Engine: engineLabel,
      'Source mesh': meshPathToUse.split(/[/\\]/).pop(),
    }, expectedMs);
    try {
      // Wire onProgress so the synthetic ticker stops fighting the real poll.
      // Without this the bar parks at 90 and looks frozen even though /api/auto-rig-status
      // is still being polled successfully every 5s.
      const r = await API.autoRigAI({
        meshPath: meshPathToUse,
        engine: rigEngine,
        onProgress: ({ polls, elapsedMs, lastWarn }) => {
          const j = state.jobs.find(x => x.id === job.id);
          if (!j || j.status !== 'running') return;
          j.bridgeReporting = true; // stops the synthetic min(90,...) cap
          // Past expectedMs we creep 90 → 99 at +1% per 20s overshoot.
          const overTime = Math.max(0, elapsedMs - expectedMs);
          const target = Math.min(99, 90 + Math.min(9, overTime / 20000));
          if (target > (j.progress || 0)) j.progress = target;
          j.subtitle = (elapsedMs > expectedMs)
            ? `Still running... ${Math.floor(elapsedMs/60000)}m ${Math.floor((elapsedMs%60000)/1000)}s (Modal cold start probable)`
            : `Polling Modal (${polls} polls)`;
          if (lastWarn) j.subtitle += ` — last warn: ${String(lastWarn).slice(0, 80)}`;
          renderJobs();
        },
      });
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
// STEP 4: ANIMATION (Seed3D Puppeteer / procedural / AnyTop)
// UI scaffold only — backend wiring TBD.
// ============================================================
// Anim engine dropdown drives which sub-fields are visible.
function _wsAnimEngineSync() {
  const engine = document.getElementById('ws-anim-engine')?.value || 'anytop';
  const animType = document.getElementById('ws-anim-type')?.value || 'idle';
  const promptRow = document.getElementById('ws-anim-prompt-row');
  const videoRow = document.getElementById('ws-anim-video-row');
  // Prompt only when animType === 'custom'. AnyTop itself ignores
  // free-text prompts at inference (T5 is for joint-name embedding only),
  // so the row stays hidden for the standard anim types.
  const showPrompt = (animType === 'custom');
  // Seed3D would require a reference video, but it's deferred (no wired
  // engine consumes it).
  const showVideo = false && (engine === 'seed3d_puppeteer');
  if (promptRow) promptRow.style.display = showPrompt ? '' : 'none';
  if (videoRow) videoRow.style.display = showVideo ? '' : 'none';
}
document.getElementById('ws-anim-engine')?.addEventListener('change', _wsAnimEngineSync);
document.getElementById('ws-anim-type')?.addEventListener('change', _wsAnimEngineSync);
_wsAnimEngineSync();

// Render animation versions strip (placeholder).
// User model: 1 VERSION = 1 batch of generation (all clips spawned by
// the same "Generate" click share a batch_id). Right-side strip shows
// v0/v1/v2/... per BATCH (newest first). Type buttons under the viewer
// show which clips are in the CURRENTLY-SELECTED version.
let _step4SelectedBatch = null;
let _step4SelectedClipInBatch = null;
function renderAnimVersions(p) {
  const typeBtns = document.getElementById('ws-anim-type-buttons');
  const strip = document.getElementById('ws-anim-versions');
  if (!strip || !typeBtns) return;
  const anims = p?.animations || [];
  if (!anims.length) {
    typeBtns.innerHTML = '';
    strip.innerHTML = '<div style="color:var(--text-2); font-size:12px; padding:4px;">No animations yet. Pick types in Create new and click Generate Animation.</div>';
    return;
  }
  const iconFor = (t) => t === 'idle' ? '😴' : t === 'walk' ? '🚶'
    : t === 'run' ? '🏃' : t === 'attack' ? '⚔️'
    : t === 'death' ? '💀' : t === 'fly' ? '✈️' : '🎬';
  // Group by batchId. Animations without one (legacy keys) each
  // become their own batch — keyed by filename so they stay distinct.
  const byBatch = new Map();
  for (const a of anims) {
    const key = a.batchId || `single_${a.filename || a.url}`;
    if (!byBatch.has(key)) byBatch.set(key, []);
    byBatch.get(key).push(a);
  }
  // Sort batches by newest member's timestamp, newest first.
  const batches = [...byBatch.entries()].map(([id, clips]) => {
    const latest = Math.max(...clips.map(c => new Date(c.created || 0).getTime()));
    return { id, clips, latest };
  }).sort((a, b) => b.latest - a.latest);

  // Default selection = newest batch + its first clip.
  if (!_step4SelectedBatch || !byBatch.has(_step4SelectedBatch)) {
    _step4SelectedBatch = batches[0].id;
    _step4SelectedClipInBatch = batches[0].clips[0];
  }
  const currentBatch = batches.find(b => b.id === _step4SelectedBatch);
  const clipsInBatch = currentBatch ? currentBatch.clips : [];
  if (!clipsInBatch.includes(_step4SelectedClipInBatch)) {
    _step4SelectedClipInBatch = clipsInBatch[0] || null;
  }

  // RIGHT strip = the versions (batches). Each thumb stacks the type
  // icons of all clips in that batch so the user can tell them apart
  // at a glance (e.g. v0 thumb shows 🏃😴 for a Run+Idle batch).
  // Small × button in top-right of each thumb deletes that batch's
  // clips from R2.
  // Same scheme as rig: newest = highest vN (display order newest-first).
  // Thumbnail uses the project's source image (p.thumb) so all version
  // strips look consistent. The type icons stack overlays on top so the
  // user can still distinguish a Run+Idle batch from a Run-only one.
  const projThumb = (typeof p?.thumb === 'string' && p.thumb)
    ? (typeof _toFileUrl === 'function' ? _toFileUrl(p.thumb) : p.thumb) : '';
  strip.innerHTML = batches.map((b, i) => {
    const vNum = batches.length - 1 - i;
    // Lineage: the cloud has no per-clip rigPath/sourceImage, so derive from a
    // representative clip of the batch (filename-stem matching). Guarded — a
    // button is omitted when its parent can't be resolved.
    const clip = (b.clips && b.clips[0]) || null;
    const parentRig = clip ? _resolveParentRig(clip, p) : null;
    const parentMeshPath = parentRig ? _resolveParentMeshPath(parentRig, p) : null;
    let sourceImage = parentRig && parentRig.sourceImage ? parentRig.sourceImage : null;
    if (!sourceImage && parentMeshPath) {
      const pm = (p.meshes || []).find((m) => _sigKey(m.path) === _sigKey(parentMeshPath));
      if (pm && pm.sourceImage) sourceImage = pm.sourceImage;
    }
    const imgBtn = sourceImage
      ? '<button class="version-source-btn anim-jump" data-jump="img" title="Voir l\'image source">&#128247;</button>' : '';
    const meshBtn = parentMeshPath
      ? '<button class="version-mesh-btn anim-jump" data-jump="mesh" title="Voir le maillage source">&#129482;</button>' : '';
    const rigBtn = parentRig
      ? '<button class="version-rig-btn anim-jump" data-jump="rig" title="Voir le rig source">&#129460;</button>' : '';
    return `
      <div class="version-thumb${b.id === _step4SelectedBatch ? ' selected' : ''}" data-batch-id="${b.id}">
        ${projThumb ? `<img src="${projThumb}" alt="">` : ''}
        <span class="v-used-badge" title="Used for next step">&#10003;</span>
        <span class="v-label">v${vNum}</span>
        <button class="version-delete-btn" data-batch-id="${b.id}" title="Delete this version">&#10005;</button>
        ${imgBtn}${meshBtn}${rigBtn}
      </div>`;
  }).join('');
  strip.querySelectorAll('.version-thumb').forEach(t => {
    t.addEventListener('click', (e) => {
      // Ignore clicks on the delete button or the lineage jump buttons
      // (each has its own handler).
      if (e.target.classList?.contains('version-delete-btn')) return;
      if (e.target.classList?.contains('anim-jump')) return;
      _step4SelectedBatch = t.dataset.batchId;
      _step4SelectedClipInBatch = null;
      renderAnimVersions(p);
    });
    // Lineage jump buttons: resolve from a representative clip of this batch.
    t.querySelectorAll('.anim-jump').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const batch = batches.find(b => b.id === t.dataset.batchId);
        const clip = batch && batch.clips && batch.clips[0];
        if (!clip) return;
        const kind = btn.dataset.jump;
        const parentRig = _resolveParentRig(clip, p);
        if (kind === 'rig') {
          if (parentRig) jumpToRig(parentRig.path);
        } else if (kind === 'mesh') {
          const mp = parentRig ? _resolveParentMeshPath(parentRig, p) : null;
          if (mp) jumpToMesh(mp);
        } else if (kind === 'img') {
          let src = parentRig && parentRig.sourceImage ? parentRig.sourceImage : null;
          const mp = parentRig ? _resolveParentMeshPath(parentRig, p) : null;
          if (!src && mp) {
            const pm = (p.meshes || []).find((m) => _sigKey(m.path) === _sigKey(mp));
            if (pm && pm.sourceImage) src = pm.sourceImage;
          }
          if (src) jumpToSourceImage(src);
        }
      });
    });
  });
  strip.querySelectorAll('.version-delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const batchId = btn.dataset.batchId;
      const batch = batches.find(b => b.id === batchId);
      if (!batch) return;
      const vNum = batches.length - 1 - batches.indexOf(batch);
      const ok = await customConfirm(
        `Delete version v${vNum} (${batch.clips.length} clip${batch.clips.length > 1 ? 's' : ''})? This is permanent.`,
        'Delete animation version',
        'Delete',
      );
      if (!ok) return;
      try {
        // Delete every clip in the batch from R2. postJSON lives in
        // meshyAPI-cloud and isn't exposed in this scope — use fetch
        // directly with credentials so the session cookie rides along.
        await Promise.all(batch.clips.map(c =>
          fetch('/api/animations/delete', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: c.url || c.path }),
          }).catch(err => console.warn('[anim del]', c.url, err))
        ));
        // Drop locally so the strip updates immediately.
        p.animations = (p.animations || []).filter(a => !batch.clips.includes(a));
        // Reset selection if we just deleted the active batch.
        if (_step4SelectedBatch === batchId) {
          _step4SelectedBatch = null;
          _step4SelectedClipInBatch = null;
        }
        renderAnimVersions(p);
        showToast(`Deleted version v${vNum}`, 'success', 2500);
      } catch (err) {
        showToast(`Delete failed: ${err.message}`, 'error', 5000);
      }
    });
  });

  // BOTTOM = the clips contained in the selected version (1 button
  // per type — clicking one swaps the viewer to that clip).
  typeBtns.innerHTML = clipsInBatch.map(c => {
    const isSel = c === _step4SelectedClipInBatch;
    return `
      <button class="anim-type-btn${isSel ? ' selected' : ''}" data-clip-id="${c.id}"
              style="display:flex; flex-direction:column; align-items:center; gap:2px; padding:8px 12px; min-width:64px;
                     background:${isSel ? 'var(--bg-2)' : 'transparent'};
                     border:2px solid ${isSel ? 'var(--accent)' : 'var(--border)'};
                     border-radius:6px; cursor:pointer; color:var(--text-0); font-size:11px;">
        <span style="font-size:18px;">${iconFor(c.type)}</span>
        <span style="text-transform:uppercase; font-weight:600;">${c.type || 'clip'}</span>
      </button>`;
  }).join('');
  typeBtns.querySelectorAll('.anim-type-btn').forEach(b => {
    b.addEventListener('click', () => {
      _step4SelectedClipInBatch = clipsInBatch.find(c => c.id === b.dataset.clipId) || clipsInBatch[0];
      renderAnimVersions(p);
    });
  });

  if (_step4SelectedClipInBatch) showStep4AnimPreview(_step4SelectedClipInBatch);
}

// Three.js-based animation viewer. Replaces the previous model-viewer
// approach because model-viewer doesn't expose its internal scene, so
// Bones overlay was impossible. With Viewer3D + AnimationMixer +
// SkeletonHelper we own the render loop and can toggle bones natively.
let _step4ActiveAnim = null;
let _animVw = null;      // Viewer3D
let _animMixer = null;
let _animAction = null;
let _animModel = null;
// Loader race token — same purpose as rigSrcLoadId. If a previous
// loader callback fires after a fresh _disposeAnimModel + new load,
// we drop the stale model instead of letting it ghost into the
// scene next to the new one ("static skeleton next to the animated
// one" reported in prod 2026-06-02).
let _animLoadId = 0;
let _animHelper = null;
let _animHelperRefresh = null;
let _animLastTime = 0;
let _animLooping = true;
let _animPlaybackRate = 1;

// Unified viewer-loading spinner overlay. Works on a CONTAINER id —
// creates/removes a position:absolute overlay with the spinner CSS
// classes. Idempotent; safe to call repeatedly. msg defaults to "Loading…".
function setViewerLoading(containerId, on, msg) {
  const card = document.getElementById(containerId);
  if (!card) return;
  // Ensure the card is a positioning context so absolute children center.
  if (getComputedStyle(card).position === 'static') {
    card.style.position = 'relative';
  }
  let overlay = card.querySelector(':scope > .viewer-loading-overlay');
  if (on) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'preview-placeholder loading viewer-loading-overlay';
      card.appendChild(overlay);
    }
    if (msg) {
      overlay.classList.add('with-msg');
      overlay.setAttribute('data-loading-msg', msg);
    } else {
      overlay.classList.remove('with-msg');
      overlay.removeAttribute('data-loading-msg');
    }
  } else if (overlay) {
    overlay.remove();
  }
}

function _initAnimViewer() {
  if (_animVw) return;
  const canvas = document.getElementById('ws-anim-canvas');
  if (!canvas) return;
  const _v = new Viewer3D({
    canvas, fov: 45, bgColor: 0x0a0a0e, far: 5000, cameraPos: [2, 2, 3],
    lighting: true,
    onBeforeRender: () => {
      const now = performance.now() / 1000;
      const dt = Math.min(0.1, now - (_animLastTime || now));
      _animLastTime = now;
      if (_animMixer) _animMixer.update(dt * _animPlaybackRate);
      // Keep the custom bone overlay in sync with the animated skeleton.
      if (typeof _animHelperRefresh === 'function' && _animHelper && _animHelper.visible) {
        try { _animHelperRefresh(); } catch (_) {}
      }
    },
  });
  _animVw = _v;
  _v.startTickLoop();
}

function _disposeAnimModel() {
  if (_animMixer) { try { _animMixer.stopAllAction(); } catch (_) {} _animMixer = null; }
  _animAction = null;
  if (_animHelper) {
    try { _animHelper.parent?.remove(_animHelper); _animHelper.material?.dispose?.(); } catch (_) {}
    _animHelper = null;
  }
  if (_animModel && _animVw?.scene) {
    try { _animVw.scene.remove(_animModel); } catch (_) {}
    _animModel = null;
  }
  // Aggressive purge: even if _animModel got dereferenced (project
  // switch, hot reload, race), walk the scene and remove ANY non-light
  // non-camera child that isn't part of the viewer's own setup. Without
  // this, previous-project meshes ghost behind the new one.
  if (_animVw?.scene) {
    const toRemove = [];
    _animVw.scene.children.forEach(c => {
      // Keep lights, cameras, and Viewer3D's helper objects.
      if (c.isLight || c.isCamera) return;
      if (c.userData?._viewerKeep) return;
      // Everything else (meshes, groups, skeleton helpers) goes.
      toRemove.push(c);
    });
    for (const c of toRemove) {
      try {
        _animVw.scene.remove(c);
        c.traverse?.(o => {
          try {
            o.geometry?.dispose?.();
            const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
            mats.forEach(m => {
              ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap'].forEach(k => {
                try { m[k]?.dispose?.(); } catch (_) {}
              });
              try { m.dispose?.(); } catch (_) {}
            });
          } catch (_) {}
        });
      } catch (_) {}
    }
  }
}

function showStep4AnimPreview(anim) {
  _step4ActiveAnim = anim || null;
  const card = document.getElementById('step4-preview');
  if (!card) return;
  const placeholder = document.getElementById('step4-placeholder');
  const canvas = document.getElementById('ws-anim-canvas');
  // Clean any leftover model-viewer node from a prior build.
  const prev = card.querySelector('model-viewer.anim-mv');
  if (prev) prev.remove();
  if (!anim) {
    if (placeholder) placeholder.style.display = '';
    if (canvas) canvas.style.display = '';
    _disposeAnimModel();
    setViewerFilename('ws-anim-filename', '');
    return;
  }
  if (canvas) canvas.style.display = '';
  setViewerFilename('ws-anim-filename', anim.filename || anim.path || anim.url || '');
  _initAnimViewer();
  _disposeAnimModel();
  const myId = ++_animLoadId;
  // Loading overlay (purple spinner + 'Loading…') until the GLB
  // resolves and the model lands in the scene.
  setViewerLoading('step4-preview', true, 'Loading animation…');
  const url = anim.url || anim.path || '';
  const loader = new GLTFLoader();
  loader.load(url, (gltf) => {
    // Stale-callback guard.
    if (myId !== _animLoadId) {
      try { gltf.scene?.traverse?.((c) => { c.geometry?.dispose?.(); c.material?.dispose?.(); }); } catch (_) {}
      return;
    }
    setViewerLoading('step4-preview', false);
    _animModel = gltf.scene;
    _animVw.scene.add(_animModel);
    // Disable frustum culling — skinned bounds at rest don't include the
    // animated extent, so culling makes the mesh vanish during motion.
    _animModel.traverse(o => { o.frustumCulled = false; });
    // Fit camera to the model.
    try {
      const box = new THREE.Box3().setFromObject(_animModel);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3()).length() || 1;
      _animVw.camera.position.set(center.x + size * 0.9, center.y + size * 0.5, center.z + size * 0.9);
      _animVw.camera.near = size / 100;
      _animVw.camera.far = size * 100;
      _animVw.camera.updateProjectionMatrix();
      _animVw.controls?.target?.copy(center);
      _animVw.controls?.update?.();
    } catch (e) { console.warn('[anim-vw] fit camera failed:', e); }
    // Inventory diagnostics + HIDE duplicate non-skinned meshes.
    // Some retarget outputs end up with a SkinnedMesh + a plain Mesh
    // sharing the same vertex data — one animates, the other sits at
    // bind pose and ghosts behind the moving copy. We hide the plain
    // Mesh in that case.
    let skinCount = 0, totalBones = 0, plainCount = 0, hiddenCount = 0;
    const allMeshes = [];
    _animModel.traverse(o => {
      if (o.isSkinnedMesh) {
        skinCount++;
        totalBones += o.skeleton?.bones?.length || 0;
        allMeshes.push({ kind: 'skin', name: o.name, mesh: o });
      } else if (o.isMesh) {
        plainCount++;
        allMeshes.push({ kind: 'plain', name: o.name, mesh: o });
      }
    });
    // If we have at least one SkinnedMesh, hide every plain Mesh.
    if (skinCount > 0) {
      _animModel.traverse(o => {
        if (o.isMesh && !o.isSkinnedMesh) { o.visible = false; hiddenCount++; }
      });
    }
    console.log('[anim-vw] loaded GLB:',
      'animations=', gltf.animations?.length || 0,
      'tracks0=', gltf.animations?.[0]?.tracks?.length || 0,
      'duration=', gltf.animations?.[0]?.duration || 0,
      'skinnedMeshes=', skinCount, 'plainMeshes=', plainCount,
      'totalBones=', totalBones, 'hidden=', hiddenCount,
      'meshes=', allMeshes.map(m => `${m.kind}:${m.name || '(anon)'}`));
    // Mixer + play first clip — bound to the GLB scene root so every
    // track's nodePath resolves correctly.
    if (gltf.animations?.length) {
      // The Puppeteer rig bakes procedural Idle/Walk/Run clips at
      // indices [0..2]. Any AnyTop / FBX-retarget output is APPENDED
      // after them by scripts/anytop_retarget.py:1232. Picking
      // animations[0] showed the procedural Idle (which is broken on
      // some rigs — orc-marron flips upside down) and made AnyTop
      // output look broken even when it wasn't. Prefer the last clip
      // that isn't a procedural baseline name.
      const PROC_NAMES = new Set(['Idle', 'Walk', 'Run']);
      let pickIdx = gltf.animations.length - 1;
      for (let i = gltf.animations.length - 1; i >= 0; i--) {
        if (!PROC_NAMES.has(gltf.animations[i].name || '')) { pickIdx = i; break; }
      }
      const clip = gltf.animations[pickIdx];
      console.log('[anim-vw] picked clip', pickIdx, 'of', gltf.animations.length,
                  '-> name:', clip.name, '(skipping procedural Idle/Walk/Run if present)');
      // DIAG: list track names + check if those nodes exist under
      // _animModel. If a track targets a node by name that doesn't
      // exist, the mixer silently no-ops that track.
      const sampleTracks = clip.tracks.slice(0, 5).map(t => t.name);
      const allModelNames = new Set();
      _animModel.traverse(o => { if (o.name) allModelNames.add(o.name); });
      const trackTargets = clip.tracks.map(t => t.name.split('.')[0]);
      const resolvedHits = trackTargets.filter(n => allModelNames.has(n)).length;
      console.log('[anim-vw] clip:', clip.name, 'tracks=', clip.tracks.length,
                  'duration=', clip.duration,
                  'sample track names=', sampleTracks,
                  'tracks resolving to model nodes:', resolvedHits, '/', trackTargets.length);
      if (resolvedHits === 0) {
        console.warn('[anim-vw] NO tracks resolve! First target:', trackTargets[0],
                     'First 8 model node names:', [...allModelNames].slice(0, 8));
      }
      _animMixer = new THREE.AnimationMixer(_animModel);
      _animAction = _animMixer.clipAction(clip);
      _animAction.setLoop(_animLooping ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      _animAction.clampWhenFinished = !_animLooping;
      _animAction.enabled = true;
      _animAction.reset();
      _animAction.play();
      _animLastTime = 0;
      console.log('[anim-vw] mixer started, action.isRunning =', _animAction.isRunning(),
                  'paused =', _animAction.paused);
    } else {
      showToast('⚠ This GLB has no animation tracks embedded.', 'warning', 6000);
    }
    // Custom sphere+cylinder skeleton overlay — replaces THREE.
    // SkeletonHelper which renders 1px LineSegments invisible against
    // dark meshes (WebGL2 ignores material.linewidth). Same fix we
    // applied to the landmarks modal.
    let firstSkin = null;
    const allBones = [];
    _animModel.traverse(o => {
      if (!firstSkin && o.isSkinnedMesh) firstSkin = o;
      if (o.isBone) allBones.push(o);
      else if (o.isSkinnedMesh && o.skeleton) {
        for (const b of o.skeleton.bones) if (!allBones.includes(b)) allBones.push(b);
      }
    });
    if (allBones.length) {
      const overlay = new THREE.Group();
      overlay.name = 'AnimSkeletonOverlay';
      overlay.visible = _step4BonesOn;
      const tmpBox = new THREE.Box3().setFromObject(_animModel);
      const sz = tmpBox.getSize(new THREE.Vector3()).length();
      const dotR = sz * 0.008;
      const linR = sz * 0.0035;
      const dotGeo = new THREE.SphereGeometry(dotR, 8, 8);
      const dotMat = new THREE.MeshBasicMaterial({
        color: 0xff00ff, depthTest: false, transparent: true, opacity: 1.0,
      });
      const boneMat = new THREE.MeshBasicMaterial({
        color: 0x00ffd0, depthTest: false, transparent: true, opacity: 0.9,
      });
      // Spheres at each bone world position (live: parented to the bone
      // so they follow the animation).
      const boneSet = new Set(allBones);
      const wpRefresh = []; // [{bone, mesh}] to update per frame
      for (const b of allBones) {
        const dot = new THREE.Mesh(dotGeo, dotMat);
        dot.renderOrder = 999;
        const wp = new THREE.Vector3(); b.getWorldPosition(wp);
        dot.position.copy(wp);
        overlay.add(dot);
        wpRefresh.push({ bone: b, mesh: dot });
      }
      // Cylinder bones (parent → child) — also refreshed per frame.
      const segRefresh = []; // [{a, b, mesh, geo}]
      for (const child of allBones) {
        if (!child.parent || !boneSet.has(child.parent)) continue;
        const a = new THREE.Vector3(); child.parent.getWorldPosition(a);
        const c = new THREE.Vector3(); child.getWorldPosition(c);
        const dir = new THREE.Vector3().subVectors(c, a);
        const len = dir.length();
        if (len < 1e-5) continue;
        const cylGeo = new THREE.CylinderGeometry(linR, linR, Math.max(len, 1e-4), 6);
        const cyl = new THREE.Mesh(cylGeo, boneMat);
        cyl.renderOrder = 998;
        cyl.position.copy(a).add(dir.clone().multiplyScalar(0.5));
        cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
        overlay.add(cyl);
        segRefresh.push({ a: child.parent, b: child, mesh: cyl });
      }
      _animVw.scene.add(overlay);
      _animHelper = overlay;
      _animHelperRefresh = function () {
        const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpD = new THREE.Vector3();
        for (const { bone, mesh } of wpRefresh) bone.getWorldPosition(mesh.position);
        for (const s of segRefresh) {
          s.a.getWorldPosition(tmpA); s.b.getWorldPosition(tmpB);
          tmpD.subVectors(tmpB, tmpA);
          const len = tmpD.length();
          if (len < 1e-5) continue;
          s.mesh.position.copy(tmpA).add(tmpD.clone().multiplyScalar(0.5));
          s.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tmpD.clone().normalize());
          s.mesh.scale.y = len / s.mesh.geometry.parameters.height;
        }
      };
      console.log('[anim-vw] custom skeleton overlay added, bones=', allBones.length,
                  'skinned=', !!firstSkin, 'visible=', overlay.visible);
    } else {
      _animHelperRefresh = null;
      console.warn('[anim-vw] no bones found in GLB');
    }
  }, undefined, (err) => {
    setViewerLoading('step4-preview', false);
    console.error('[anim-vw] GLB load failed:', err);
    showToast(`Animation load failed: ${err?.message || err}`, 'error', 5000);
  });
}

// Shim for the legacy _getStep4MV() callers — returns an object with
// the play/pause/loop interface they expect, backed by the Three.js
// mixer instead of model-viewer.
function _getStep4MV() {
  if (!_animAction) return null;
  return {
    get paused() { return _animAction.paused; },
    play()  { _animAction.paused = false; },
    pause() { _animAction.paused = true; },
    set animationName(_) {},
    get availableAnimations() { return _animAction ? [_animAction.getClip().name] : []; },
    hasAttribute(n) { return n === 'loop' && _animLooping; },
    setAttribute(n) {
      if (n === 'loop') { _animLooping = true; _animAction.setLoop(THREE.LoopRepeat, Infinity); }
    },
    removeAttribute(n) {
      if (n === 'loop') { _animLooping = false; _animAction.setLoop(THREE.LoopOnce, 1); }
    },
    set playbackRate(v) { _animPlaybackRate = Number(v) || 1; },
    set cameraOrbit(_) {},
    set exposure(v) {
      if (_animVw?.renderer) _animVw.renderer.toneMappingExposure = Number(v) || 1;
    },
    resetTurntableRotation() {
      if (_animVw?.controls && _animModel) {
        const box = new THREE.Box3().setFromObject(_animModel);
        const center = box.getCenter(new THREE.Vector3());
        _animVw.controls.target.copy(center);
        _animVw.controls.update();
      }
    },
    requestUpdate() {},
    style: { background: '' },
  };
}
document.getElementById('ws-anim-play-btn')?.addEventListener('click', (e) => {
  const mv = _getStep4MV();
  if (!mv) { showToast('Pick a clip first', 'error'); return; }
  const tracks = mv.availableAnimations || [];
  if (tracks.length === 0) {
    showToast('No animation tracks in this GLB — nothing to play.', 'warning', 5000);
    return;
  }
  if (mv.paused) {
    mv.play();
    e.currentTarget.classList.add('active');
  } else {
    mv.pause();
    e.currentTarget.classList.remove('active');
  }
});
document.getElementById('ws-anim-loop-btn')?.addEventListener('click', (e) => {
  const mv = _getStep4MV();
  if (!mv) return;
  const next = !mv.hasAttribute('loop');
  if (next) mv.setAttribute('loop', '');
  else mv.removeAttribute('loop');
  e.currentTarget.classList.toggle('active', next);
});
document.getElementById('ws-anim-export-btn')?.addEventListener('click', async () => {
  const a = _step4ActiveAnim;
  if (!a?.url && !a?.path) { showToast('Select an animation first', 'error'); return; }
  // FBX export not available on cloud; offer the raw GLB download instead.
  const url = a.url || a.path;
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = (a.filename || url.split('/').pop() || 'animation.glb');
    document.body.appendChild(link); link.click(); link.remove();
    showToast('Animation GLB downloaded (FBX export requires desktop)', 'info', 4000);
  } catch (e) {
    showToast(`Download failed: ${e.message}`, 'error');
  }
});
// Bones toggle — model-viewer exposes its internal Three.js scene at
// mv[Symbol.for('three')]. We traverse for SkinnedMeshes, attach a
// THREE.SkeletonHelper under each, toggle visibility on click. The
// helper auto-updates each frame from the bones it watches, so it
// follows the running animation.
let _step4BonesOn = false;
function _toggleAnimBones() {
  if (!_animVw) { showToast('Select a clip first', 'error'); return; }
  _step4BonesOn = !_step4BonesOn;
  const btn = document.querySelector('#ws-anim-toolbar [data-act="bones"]');
  if (btn) btn.classList.toggle('active', _step4BonesOn);
  if (_animHelper) _animHelper.visible = _step4BonesOn;
  showToast(`Bones ${_step4BonesOn ? 'on' : 'off'}`, 'info', 1500);
}

// Wire the anim viewer toolbar (Reset / View / Play / Loop / Bones /
// Speed / Bg / Light). Each control adjusts the model-viewer attached
// to step4-preview via _getStep4MV().
document.querySelectorAll('#ws-anim-toolbar [data-act]').forEach(el => {
  const act = el.dataset.act;
  const isButton = el.tagName === 'BUTTON';
  if (isButton) {
    el.addEventListener('click', () => {
      if (act === 'bones') _toggleAnimBones();
      else if (act === 'play') document.getElementById('ws-anim-play-btn')?.click();
      else if (act === 'loop') document.getElementById('ws-anim-loop-btn')?.click();
      else if (act === 'reset') {
        const mv = _getStep4MV();
        if (mv) { mv.resetTurntableRotation?.(); mv.cameraOrbit = 'auto auto auto'; }
      }
    });
  }
});
document.querySelector('#ws-anim-toolbar [data-act="view"]')?.addEventListener('change', (e) => {
  const mv = _getStep4MV();
  if (!mv) return;
  const orbits = {
    iso:    '45deg 65deg auto',
    front:  '0deg 90deg auto',
    back:   '180deg 90deg auto',
    left:   '-90deg 90deg auto',
    right:  '90deg 90deg auto',
    top:    '0deg 0deg auto',
    bottom: '0deg 180deg auto',
  };
  if (orbits[e.target.value]) mv.cameraOrbit = orbits[e.target.value];
});
document.querySelector('#ws-anim-toolbar [data-act="speed"]')?.addEventListener('change', (e) => {
  const mv = _getStep4MV();
  if (!mv) return;
  const s = parseFloat(e.target.value);
  if (Number.isFinite(s) && s > 0) mv.playbackRate = s;
});
document.querySelector('#ws-anim-toolbar [data-act="bg"]')?.addEventListener('change', (e) => {
  const mv = _getStep4MV();
  if (!mv) return;
  const bgs = { dark: '#0a0a0e', studio: '#222233', black: '#000', gray: '#444' };
  mv.style.background = bgs[e.target.value] || '#0a0a0e';
});
document.querySelector('#ws-anim-toolbar [data-act="light"]')?.addEventListener('input', (e) => {
  const mv = _getStep4MV();
  if (!mv) return;
  mv.exposure = (parseFloat(e.target.value) / 100) || 1;
});

// Generate AnyTop AI — opens the dedicated modal, pre-checks any
// types the project already has, runs the same batch flow on confirm.
// Stays inside the Edit selected stage so the user doesn't lose
// context.
document.getElementById('ws-anim-gen-more-btn')?.addEventListener('click', () => {
  const p = state.currentProject;
  if (!p) { showToast('Open a project first', 'error'); return; }
  if (!p.rigs || p.rigs.length === 0) {
    customError('You need a rigged mesh first. Generate a Rig in Step 3, then come back.', 'No rig available');
    return;
  }
  // 'Existing' = types in the CURRENTLY-SELECTED version (matches the
  // type buttons shown under the viewer). Using all-batches here was
  // confusing — the modal would say RUN/ATTACK already existed even
  // when the user was looking at an IDLE-only batch.
  const currentBatchClips = ((p.animations || [])
    .filter(a => a.batchId === _step4SelectedBatch));
  const existingTypes = new Set(currentBatchClips.map(c => (c.type || '').toLowerCase()));
  const modal = document.getElementById('modal-anim-gen');
  const checkboxes = modal.querySelectorAll('input[name="modal-anim-type"]');
  checkboxes.forEach(cb => {
    cb.checked = existingTypes.has(cb.value);
    const label = cb.closest('label');
    if (!label) return;
    label.querySelector('.anim-existing-tag')?.remove();
    if (existingTypes.has(cb.value)) {
      const tag = document.createElement('span');
      tag.className = 'anim-existing-tag';
      tag.style.cssText = 'margin-left:auto; font-size:10px; color:var(--accent); font-weight:600; letter-spacing:0.4px;';
      tag.textContent = '• EXISTING';
      label.style.justifyContent = 'flex-start';
      label.appendChild(tag);
    }
  });
  // Snapshot the initial state so Generate stays greyed unless the
  // user actually adds or removes a type. No-op clicks don't burn
  // credits.
  const initialSnapshot = [...checkboxes].map(cb => `${cb.value}=${cb.checked}`).join('|');
  const goBtn = document.getElementById('modal-anim-go');
  const updateGoState = () => {
    const current = [...checkboxes].map(cb => `${cb.value}=${cb.checked}`).join('|');
    const anyChecked = [...checkboxes].some(cb => cb.checked);
    const changed = current !== initialSnapshot;
    if (goBtn) {
      goBtn.disabled = !(anyChecked && changed);
      goBtn.title = !anyChecked
        ? 'Pick at least one animation type'
        : !changed
          ? 'Add or remove a type to enable Generate'
          : '';
    }
  };
  checkboxes.forEach(cb => cb.addEventListener('change', updateGoState));
  updateGoState();
  modal.classList.remove('hidden');
});

document.getElementById('modal-anim-cancel')?.addEventListener('click', () => {
  document.getElementById('modal-anim-gen')?.classList.add('hidden');
});

document.getElementById('modal-anim-go')?.addEventListener('click', () => {
  // Mirror the checkbox state from the modal into the canonical
  // Create-new checklist (#ws-anim-types), then trigger the existing
  // Generate handler — single source of truth for the batch loop.
  const modal = document.getElementById('modal-anim-gen');
  const picked = [...modal.querySelectorAll('input[name="modal-anim-type"]:checked')].map(cb => cb.value);
  if (!picked.length) { showToast('Pick at least one animation type', 'error'); return; }
  document.querySelectorAll('#ws-anim-types input[name="anim-type"]').forEach(cb => {
    cb.checked = picked.includes(cb.value);
  });
  modal.classList.add('hidden');
  // The Create-new Generate button starts disabled (HTML default until
  // a rig is detected). We've already gated on p.rigs at the opener,
  // so force-enable before clicking — otherwise .click() is a no-op
  // and nothing happens.
  const genBtn = document.getElementById('ws-generate-anim');
  if (genBtn) {
    genBtn.disabled = false;
    genBtn.click();
  }
});

// Manual import — user picks an animated GLB → POST to
// /api/animations/upload → R2 → reload project so it appears as a
// new version v(N) in the strip.
document.getElementById('ws-anim-import-btn')?.addEventListener('click', () => {
  document.getElementById('ws-anim-import-file')?.click();
});
document.getElementById('ws-anim-import-file')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = ''; // reset so the same file can be picked twice
  if (!file) return;
  const p = state.currentProject;
  if (!p) { showToast('Open a project first', 'error'); return; }
  if (!/\.(glb|gltf)$/i.test(file.name)) {
    showToast('Pick a .glb or .gltf file', 'error');
    return;
  }
  // Quick animType prompt — let the user label it (defaults to 'clip').
  const animType = (prompt('Animation type? (idle / walk / run / attack / death / fly / clip)', 'clip') || 'clip').trim().toLowerCase();
  const job = pushJob(`Import animation: ${file.name}`, null, {
    File: file.name,
    'Size': `${(file.size / 1024).toFixed(0)} KB`,
    Type: animType,
  }, 10000);
  try {
    const form = new FormData();
    form.append('file', file);
    form.append('animType', animType);
    form.append('projectName', p.name || '');
    const r = await fetch('/api/animations/upload', {
      method: 'POST',
      credentials: 'same-origin',
      body: form,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data?.ok) {
      throw new Error(data?.error || `HTTP ${r.status}`);
    }
    completeJob(job.id, true);
    showToast(`Imported as new version`, 'success', 3000);
    await reloadCurrentProject();
  } catch (err) {
    completeJob(job.id, false, err?.message || String(err));
    showToast(`Import failed: ${err?.message || err}`, 'error', 5000);
  }
});

document.getElementById('ws-anim-folder-btn')?.addEventListener('click', () => {
  const a = _step4ActiveAnim;
  if (!a?.url && !a?.path) { showToast('Select an animation first', 'error'); return; }
  // On cloud this opens the R2 URL in a new tab; desktop overrides this.
  window.open(a.url || a.path, '_blank');
});

document.getElementById('ws-generate-anim')?.addEventListener('click', async () => {
  const p = state.currentProject;
  if (!p) return;
  if (!p.rigs || p.rigs.length === 0) {
    customError('You need a rigged mesh first. Generate a Rig in Step 3, then come back.', 'No rig available');
    return;
  }
  // selectedRigUrl is set by "Use this rig for Animation"; selectedRigPath
  // is its desktop-style alias. Either match accepts since on cloud
  // rig.url === rig.path.
  const sel = p.selectedRigUrl || p.selectedRigPath || '';
  const rig = p.rigs.find(r => r.url === sel || r.path === sel) || p.rigs[0];
  if (!rig?.url) {
    customError('No rig selected. Click "Use this rig for Animation" in Step 3 first.', 'No rig selected');
    return;
  }
  const engine = document.getElementById('ws-anim-engine')?.value || 'anytop';
  // Multi-select: read all checked anim-type checkboxes. Fall back to
  // the legacy single-select for any callsite still using it.
  const checked = Array.from(document.querySelectorAll('#ws-anim-types input[name="anim-type"]:checked'))
    .map(cb => cb.value);
  const animTypes = checked.length
    ? checked
    : [document.getElementById('ws-anim-type')?.value || 'idle'];
  const prompt = (document.getElementById('ws-anim-prompt')?.value || '').trim();
  if (engine !== 'anytop') {
    customError(
      `Only the AnyTop engine is wired in this build. Procedural / Seed3D Puppeteer engines come later.`,
      'Engine not yet wired',
    );
    return;
  }
  if (!API.autoAnimAI) {
    customError('autoAnimAI not exposed on this build', 'API missing');
    return;
  }
  // 2026-06-02: user explicitly requested "Si je create une animation, il
  // ne faut pas copier une version précédente qui existe deja, il faut
  // systematiquement regénérer". The previous toCopy/toRun split silently
  // copied any anim_type that already existed in the currently-selected
  // batch — which surprised the user (2s "New version with 1 clip" toast
  // and no Modal call). Now every checked type is regenerated.
  if (!animTypes.length) {
    showToast('Check at least one type to generate.', 'info', 4000);
    return;
  }
  const toCopy = [];          // intentionally empty — no copy path anymore
  const toRun = animTypes.slice();
  // batchId shared across all freshly-generated clips so the server
  // groups them into ONE new version (v(N+1)).
  const batchId = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // STEP B — generate every checked type via Modal. ONE master batch
  // job (instead of per-type popups) — the user sees a single Running
  // task that walks through 1/N → N/N. No copy path: every checked
  // type is always regenerated.
  gatedRun('anim', `Animate ${toRun.join('+')}: ${p.name}`, async () => {
    const batchJob = pushJob(`Animate ${toRun.join('+')}: ${p.name}`, null, {
      Engine: 'AnyTop (cloud GPU)',
      Types: toRun.join(', '),
      Prompt: prompt || '—',
      'Source rig': (rig.filename || rig.url).split(/[/\\]/).pop(),
      Batch: `0/${toRun.length}`,
    }, 180000 * toRun.length);
    let done = 0;
    for (const animType of toRun) {
      const bj = state.jobs.find(x => x.id === batchJob.id);
      if (bj) {
        bj.params.Batch = `${done + 1}/${toRun.length} (${animType})`;
        bj.subtitle = `Spawning Modal for ${animType}...`;
        renderJobs();
      }
      try {
        const r = await API.autoAnimAI({
          rigUrl: rig.url,
          animType,
          prompt,
          engine,
          batchId,
          projectName: p?.name || null,
          onProgress: ({ polls, elapsedMs, lastWarn }) => {
            const j = state.jobs.find(x => x.id === batchJob.id);
            if (!j || j.status !== 'running') return;
            j.bridgeReporting = true;
            // Per-type progress slice. Each type covers (100/N)% of the
            // master bar; within a type we go 0 → (100/N) over time.
            const slice = 100 / toRun.length;
            const tFrac = Math.min(1, elapsedMs / 60000); // 60s = a slice
            const target = Math.min(99, done * slice + tFrac * slice * 0.95);
            if (target > (j.progress || 0)) j.progress = target;
            j.subtitle = `${animType} (${done + 1}/${toRun.length}) — ${(elapsedMs > 180000)
              ? `cold start ${Math.floor(elapsedMs/60000)}m ${Math.floor((elapsedMs%60000)/1000)}s`
              : `polling ${polls}x`}`;
            if (lastWarn) j.subtitle += ` — ${String(lastWarn).slice(0, 60)}`;
            renderJobs();
          },
        });
        if (r?.success) {
          done++;
          const j = state.jobs.find(x => x.id === batchJob.id);
          if (j) {
            j.progress = (done / toRun.length) * 100;
            j.subtitle = `${done}/${toRun.length} done`;
            renderJobs();
          }
          renderAnimVersions(p);
        } else {
          completeJob(batchJob.id, false, r?.error || 'unknown');
          if (!batchJob.cancelled) reportPipelineError(r?.error, `Animate failed (${animType})`);
          break;
        }
      } catch (e) {
        completeJob(batchJob.id, false, e?.error || e?.message || String(e));
        if (!batchJob.cancelled) reportPipelineError(e?.error || e?.message || String(e), `Animate error (${animType})`);
        break;
      }
    }
    if (done === toRun.length) {
      completeJob(batchJob.id, true);
    }
    // After the batch: refresh from server so persistence picks up all
    // new clips, then reveal Step 4 Edit panel.
    await reloadCurrentProject();
    const animCard = document.getElementById('step-card-animation');
    if (animCard) {
      animCard.classList.remove('collapsed', 'disabled');
      const editStage = animCard.querySelector('.stage-edit');
      if (editStage) editStage.open = true;
      animCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      animCard.classList.add('pulse-highlight');
      setTimeout(() => animCard.classList.remove('pulse-highlight'), 1500);
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
  if (!refreshed) {
    // The project no longer matches anything in the projects scan — most
    // likely the user just deleted its last image. Don't leave the UI
    // frozen on the stale data: present an empty shell so they can
    // regenerate from scratch via the "Create new" stage (which
    // setStageOpenState auto-expands when images.length === 0).
    console.log('[reload] empty shell for', name);
    const emptyShell = {
      name: state.currentProject.name,
      images: [], meshes: [], rigs: [],
      animations: [],
            _reloadTs: Date.now(),
    };
    state.currentProject = emptyShell;
    populateWorkspace(emptyShell);
    return;
  }
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
        { id: 'step-card-image',     has: refreshed.images?.length     > 0 },
        { id: 'step-card-mesh',      has: refreshed.meshes?.length     > 0 },
        { id: 'step-card-rig',       has: refreshed.rigs?.length       > 0 },
        { id: 'step-card-animation', has: refreshed.animations?.length > 0 },
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
  'rig':     240000,  // ~4 min cloud (Modal A10G cold-start + Puppeteer pipeline); desktop ~2 min
  'inpaint': 180000,
};

function inferKind(name) {
  const n = name.toLowerCase();
  if (n.includes('inpaint') || n.includes('mask')) return 'inpaint';
  if (n.includes('3d') || n.includes('mesh')) return 'mesh';
  if (n.includes('rig')) return 'rig';
  if (n.includes('animate') || n.includes('anim ') || n.includes('animation') || /\banim$/.test(n) || /\banim:/.test(n) || /\banim\b/.test(n)) return 'anim';
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
function pushJob(name, onCancel, params, expectedMsOverride, startedAtOverride, opts) {
  const id = ++state.jobIdCounter;
  const kind = inferKind(name);
  // Pre-compute expected: caller wins, else infer container-aware
  // ETA from window.__modalContainers (warm vs cold). The legacy
  // JOB_EXPECTED_MS lookup is the final fallback for jobs that don't
  // map to a Modal container (local desktop ops).
  let expected;
  if (typeof expectedMsOverride === 'number' && expectedMsOverride > 0) {
    expected = expectedMsOverride;
  } else {
    const c = typeof window.__modalContainerForKind === 'function'
      ? window.__modalContainerForKind(kind) : null;
    if (c && (c.warm === true || c.warm === false)) {
      const sec = c.warm ? (c.expected_seconds_warm || 30) : (c.expected_seconds_cold || 150);
      expected = sec * 1000;
    } else {
      expected = JOB_EXPECTED_MS[kind] || 60000;
    }
  }
  // 2026-06-02: cold-start toast suppressed per user request — the
  // floating "Image gen container is cold..." popup was redundant
  // with the "Warming up cloud AI" hint inside the Running task
  // modal. The popup now lives ONLY inside the modal (jd-hint-coldstart)
  // for users who explicitly open the task to check progress.
  // Original toast kept for reference: see git blame.
  // startedAt can be overridden when resuming a job that began before a
  // page reload — lets the popup show ELAPSED measured from the real
  // start instead of "0s" right after refresh.
  const startedAt = (typeof startedAtOverride === 'number' && startedAtOverride > 0)
    ? startedAtOverride
    : Date.now();
  // Seed the initial progress higher when resuming so the bar reflects
  // the time already spent (capped at 90, leaves room for the bridge).
  const elapsedNow = Math.max(0, Date.now() - startedAt);
  const initialProgress = Math.min(90, Math.max(5, 5 + (elapsedNow / expected) * 85));
  // SNAPSHOT the source image at launch time. Without this, the Job
  // Details modal reads state.currentProject.thumb at RENDER time, which
  // may have changed if the user clicked another version thumbnail
  // between launch and the modal refresh (bug: "Generate 3D: porte-avion"
  // showed a knight thumb because the user switched versions mid-job).
  const o = opts || {};
  const job = {
    id,
    name,
    kind,
    progress: initialProgress,
    status: 'running',
    startedAt,
    expectedMs: expected,
    onCancel: onCancel || null,
    tickTimer: null,
    params: params || null,
    sourceImageUrl: o.sourceImageUrl || null,
    projectName: o.projectName || (state.currentProject ? state.currentProject.name : null),
    assetKind: o.assetKind || null,
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
  // 2026-06-02 liveliness: trigger the one-shot bounce-and-flash on
  // the matching step card so the user gets a satisfying visual cue
  // that something just succeeded. CSS animation is 1.5s; we remove
  // the class after 1600ms so it can re-fire on the next completion.
  try {
    if (success) {
      const stepIdx = _jobStepIndex(j);
      if (stepIdx > 0) {
        const cardId = ['step-card-image','step-card-mesh','step-card-rig','step-card-animation'][stepIdx - 1];
        const card = document.getElementById(cardId);
        if (card) {
          card.classList.add('just-done');
          setTimeout(() => card.classList.remove('just-done'), 1600);
        }
      }
    }
  } catch (_) {}
  renderJobs();
  // Auto-flush the console buffer to R2 so server-side debug has the
  // full log of every Generate* operation. Fire-and-forget; the lib
  // handles auth + R2 put. We derive `kind` from the job name so the
  // R2 key reads e.g. <uid>/logs/<ts>_image_done.log.
  try {
    if (window.__consoleCapture && typeof window.__consoleCapture.flush === 'function') {
      const name = (j.name || '').toLowerCase();
      let kind = 'job';
      if (/image|generate/.test(name)) kind = 'image';
      else if (/mesh/.test(name))       kind = 'mesh';
      else if (/rig/.test(name))        kind = 'rig';
      else if (/anim/.test(name))       kind = 'anim';
      else if (/back|view|multi/.test(name)) kind = 'view';
      window.__consoleCapture.flush({
        kind,
        status: success ? 'done' : 'error',
        job_id: j.id,
        project: state.currentProject?.name || null,
      });
    }
  } catch (_) { /* never block job completion on log flush */ }
  // Done jobs linger so the user can SEE that they finished — both
  // in the sidebar and in the per-step Create New widget. Failed
  // jobs linger even longer so the user has time to open the
  // details modal and read the error message.
  // 2026-06-02: bumped success TTL from 4s → 8s after user reported
  // the per-step "Animate run: dragon" bandeau disappearing too
  // quickly. Matches the sidebar's perceived dwell time.
  const ttl = success ? 8000 : 30000;
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
  push: (name, onCancel, params, expectedMs, startedAt, opts) => pushJob(name, onCancel, params, expectedMs, startedAt, opts),
  enqueue: (kind, name, runFn) => enqueueJob(kind, name, runFn),
  complete: (id, success, errorMessage) => completeJob(id, success, errorMessage),
  render: () => renderJobs(),
};
// index2.js is loaded as a module so top-level declarations don't
// auto-attach to window. Expose the bits the cloud's pending-job
// resume needs (see meshyAPI-cloud.js:resumePendingJobs).
window.reloadCurrentProject = reloadCurrentProject;

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
  // If the IPC supports cancellation, fire it.
  // Forward the REAL worker job id (captured when /api/generate
  // returned), not the local UI counter `id` — the Worker indexes
  // jobs by its own id, not ours.
  try {
    if (API.cancelJob) await API.cancelJob(j.workerJobId || id);
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

// Classify a job into one of the 4 Create New steps so the per-step
// progress widget can show only the jobs relevant to its own panel.
// Returns 1..4 or 0 for "no step" (don't render in any step widget).
function _jobStepIndex(j) {
  const n = (j && j.name) || '';
  // Step 1 (image) — generation, edits, variants, view rectifiers.
  // 2026-06-02 add: re-roll / variant patterns. Previously the
  // resumed "Re-roll variant: orc rose" job missed every regex and
  // fell to 0 → no Go-to button, no per-step widget.
  if (/^(generate images?|generating (back|6) views|generate back views|multi[- ]?views|auto[- ]?inpaint|modify|inpaint|face[- ]?fix|remove[- ]?bg|rectif|upscal|back[- ]?view|t[- ]?pose|re[- ]?roll|variant|img2img|sdxl|flux)/i.test(n)) return 1;
  if (/^(generate 3d|mesh op|fill[- ]?holes|smooth|material[- ]?adjust|generate mesh|texture|pbr)/i.test(n)) return 2;
  // Mesh-editor saves + manual mesh tools produce a new mesh version → step 2.
  if (/(retex|re-?texture|mesh edit|save mesh|sculpt|watertight|decimate|set[- ]?pivot|fix[- ]?normals)/i.test(n)) return 2;
  if (/(rig|skeleton)/i.test(n)) return 3;
  if (/^(animate|animation)/i.test(n)) return 4;
  return 0;
}

// Pull the project name a job was launched on. We prefer the SNAPSHOT
// stored on the job (params.Project, sourceProject, or projectName),
// then fall back to extracting "...: <name>" from the title, then to
// current project. The j.projectName fallback was added 2026-06-02 to
// match desktop renderer, where pushJob writes that field directly;
// harmless on cloud where sourceProject is the canonical field.
function _jobProjectName(j) {
  if (!j) return null;
  if (j.params && j.params.Project) return j.params.Project;
  if (j.sourceProject) return j.sourceProject;
  if (j.projectName) return j.projectName;
  const m = (j.name || '').match(/[:—–-]\s*([^:—–-]+)\s*$/);
  if (m) return m[1].trim();
  return null;
}

// Open the project (if different from current) and scroll/expand the
// step card matching this job. Exposed on window so HTML onclick can
// reach it from anywhere.
window._navigateToJobStep = async function(jobId) {
  const j = state.jobs.find(x => x.id === jobId);
  if (!j) return;
  const stepIdx = _jobStepIndex(j);
  if (!stepIdx) return;
  const targetName = _jobProjectName(j);
  const cur = state.currentProject && state.currentProject.name;
  if (targetName && targetName !== cur) {
    try {
      const p = (state.projects || []).find(x => x && x.name === targetName);
      if (p && typeof openProject === 'function') {
        await openProject(p);
      } else if (typeof window.openProjectByName === 'function') {
        await window.openProjectByName(targetName);
      }
    } catch (_) {}
  }
  const cardId = ['step-card-image','step-card-mesh','step-card-rig','step-card-animation'][stepIdx - 1];
  const card = document.getElementById(cardId);
  if (!card) return;
  card.classList.remove('collapsed');
  // Expand its Create New stage if collapsed.
  const stage = card.querySelector('.stage-create');
  if (stage && !stage.open) stage.open = true;
  // 2026-06-02 fix: scrollIntoView right after toggling <details> open
  // landed the user at the BOTTOM of the page because layout hadn't
  // reflowed yet — the card's bounding box was still its pre-expand
  // (collapsed) value. Wait two rAFs so the browser has time to
  // compute the new heights, then resolve the absolute Y from a
  // fresh getBoundingClientRect and use window.scrollTo so we never
  // depend on the surrounding scroll container.
  const _scrollToCard = () => {
    // 2026-06-02: scrollIntoView is more reliable across nested
    // overflow containers (the workspace area in cloud/app uses a
    // scrollable wrapper). window.scrollTo only moves the document
    // root viewport — when the workspace has its own scroll context,
    // it has no effect and the user reports "click does nothing".
    let scrolled = false;
    try {
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      scrolled = true;
    } catch (_) {}
    if (!scrolled) {
      try {
        const rect = card.getBoundingClientRect();
        const top = (window.scrollY || 0) + rect.top - 16;
        window.scrollTo({ top, behavior: 'smooth' });
      } catch (__) {
        try { card.scrollIntoView({ block: 'start' }); } catch (___) {}
      }
    }
    // 2026-06-02 UX: pulse-highlight the SPECIFIC running-job tile
    // inside the step's Create New widget so the user immediately
    // sees the tile that matches the job they came from. Falls back
    // to the whole card if the widget hasn't rendered the tile yet
    // (e.g. the job just transitioned, no Create New tile present).
    const stepIdx2 = _jobStepIndex(j);
    const targetTile = stepIdx2
      ? document.querySelector(`#step-progress-${stepIdx2} .step-progress-item[data-job-id="${jobId}"]`)
      : null;
    const flashEl = targetTile || card;
    flashEl.classList.add('pulse-highlight');
    setTimeout(() => flashEl.classList.remove('pulse-highlight'), 1500);
  };
  requestAnimationFrame(() => requestAnimationFrame(_scrollToCard));
};

// Track per-step "last seen hasRunning" so we only auto-toggle the
// stage when the state CHANGES. Without this, the every-second render
// tick would clobber the user's manual expand (they open it, next
// render closes it). With this, the user's toggle wins until the
// running state flips.
const _stageGenLastRunning = { 1: null, 2: null, 3: null, 4: null };

function _toggleGeneratingStage(stepIdx, hasRunning) {
  const cardId = ['step-card-image','step-card-mesh','step-card-rig','step-card-animation'][stepIdx - 1];
  const card = document.getElementById(cardId);
  if (!card) return;
  const stage = card.querySelector('.stage-generating');
  if (!stage) return;
  // Hide the whole GENERATING section when this step has no jobs/tiles
  // (the empty "No generation in progress" state). renderStepProgressWidgets
  // sets the widget's .has-jobs class BEFORE calling us, so it is reliable;
  // recently done/error tiles keep .has-jobs for a few seconds and stay
  // visible — only the truly-idle panel is hidden.
  const _pw = stage.querySelector('.step-progress-widget');
  stage.style.display = (_pw && _pw.classList.contains('has-jobs')) ? '' : 'none';
  // Only force the open state on TRANSITION (running ↔ idle). User's
  // manual click between transitions is respected.
  const last = _stageGenLastRunning[stepIdx];
  if (last !== hasRunning) {
    stage.open = !!hasRunning;
    _stageGenLastRunning[stepIdx] = hasRunning;
  }
  // Liveliness: badge pulse + icon spin animate via CSS picking up
  // .has-running on the step card.
  card.classList.toggle('has-running', !!hasRunning);
}

// Populate every per-step progress widget from state.jobs. Only jobs
// belonging to the currently-open project show up — the widget lives
// inside that project's workspace, so cross-project bleed would be
// confusing. Empty widgets get the hidden state (no .has-jobs class).
// Translate a job title for DISPLAY only — the stored job.name stays English so
// the step-matching regex (_jobStepIndex) keeps working. Handles "Prefix: value"
// templates ("Generate 3D: dropped") via tf(), else a plain t() lookup.
function _displayJobName(name) {
  const I = window.FabI18n;
  if (!I || I.lang === 'en' || !name) return name || '';
  const m = String(name).match(/^(.*?): (.+)$/);
  if (m && I.tf) {
    const out = I.tf(m[1] + ': {x}', m[2]);
    if (out && out !== m[1] + ': ' + m[2]) return out;  // had a template translation
  }
  return (I.t && I.t(name)) || name;
}

function renderStepProgressWidgets() {
  const curName = state.currentProject && state.currentProject.name;
  for (let s = 1; s <= 4; s++) {
    const widget = document.getElementById(`step-progress-${s}`);
    if (!widget) continue;
    const matching = state.jobs.filter(j => {
      if (_jobStepIndex(j) !== s) return false;
      const pn = _jobProjectName(j);
      // No project label on the job → show in the current project's
      // widget only (best-effort). With a label, show only if matching.
      return !pn || pn === curName;
    });
    if (!matching.length) {
      widget.classList.remove('has-jobs');
      widget.innerHTML = '<div class="step-progress-empty">No generation in progress</div>';
      try { _toggleGeneratingStage(s, false); } catch (_) {}
      continue;
    }
    widget.classList.add('has-jobs');
    // Step badge only pulses while at least one job is STILL running.
    // Done/error tiles keep showing for ~8s but the step itself stops
    // being "active" so we let the badge calm down.
    const hasRunning = matching.some(j => j.status === 'running');
    try { _toggleGeneratingStage(s, hasRunning); } catch (_) {}
    widget.innerHTML = matching.map(j => {
      const pct = Math.round(j.progress || 0);
      const canCancel = j.status === 'running';
      // 2026-06-02: status class drives bar/pct colour (green on
      // done, red on error). Mirrors the sidebar's .job-item-2
      // status-coloring CSS so the per-step tile gives the same
      // success/fail signal.
      const statusClass = j.status === 'done' ? ' done'
                        : j.status === 'error' ? ' error'
                        : '';
      const elapsed = j.startedAt ? fmtDuration(Date.now() - j.startedAt) : '';
      // 2026-06-02: small source-asset thumbnail on every tile so the
      // user instantly recognises which generation is theirs. Uses
      // sourceImageUrl snapshot stamped at pushJob time → never the
      // currently-selected version (race-safe).
      const thumbUrl = j.sourceImageUrl ? (
        /^(https?:|data:|blob:)/i.test(j.sourceImageUrl)
          ? j.sourceImageUrl
          : (typeof _toFileUrl === 'function' ? _toFileUrl(j.sourceImageUrl) : j.sourceImageUrl)
      ) : '';
      const thumbHtml = thumbUrl
        ? `<img src="${escapeHtml(thumbUrl)}" alt="" class="step-progress-item-thumb"/>`
        : '';
      return `
        <div class="step-progress-item${statusClass}" data-job-id="${j.id}">
          <div class="step-progress-item-header">
            ${thumbHtml}
            <div class="step-progress-item-name">${escapeHtml(_displayJobName(j.name))}</div>
            ${canCancel ? `<button class="step-progress-cancel-btn" onclick="event.stopPropagation(); window._cancelJob(${j.id})" title="Cancel job">&#10005;</button>` : ''}
          </div>
          <div class="step-progress-item-bar">
            <div class="step-progress-item-bar-fill" style="width:${pct}%"></div>
          </div>
          <div class="step-progress-item-pct">${elapsed ? `<span style="color:var(--text-2); margin-right:8px; font-weight:normal;">${elapsed}</span>` : ''}${pct}%</div>
        </div>`;
    }).join('');
    widget.querySelectorAll('.step-progress-item[data-job-id]').forEach(el => {
      el.addEventListener('click', () => {
        const id = parseInt(el.dataset.jobId);
        openJobDetails(id);
      });
    });
  }
}

function renderJobs() {
  const bubble = document.getElementById('jobs-bubble-2');
  const panel = document.getElementById('jobs-panel-2');
  const runningCount = state.jobs.filter(j => j.status === 'running').length;
  const queuedCount = queuedJobs.length;
  const totalCount = state.jobs.length + queuedCount;
  const badgeText = queuedCount > 0 ? `${runningCount}+${queuedCount}` : String(runningCount);
  document.getElementById('jobs-bubble-count-2').textContent = badgeText;
  // Per-step widgets piggy-back on the same refresh tick.
  try { renderStepProgressWidgets(); } catch (_) {}
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
    // Show a "Go to step" pill when the job maps to a known step so the
    // user can jump straight to its Create New widget instead of hunting
    // for it across projects.
    const hasStep = _jobStepIndex(j) > 0;
    const elapsed = j.startedAt ? fmtDuration(Date.now() - j.startedAt) : '';
    const sbThumbUrl = j.sourceImageUrl ? (
      /^(https?:|data:|blob:)/i.test(j.sourceImageUrl)
        ? j.sourceImageUrl
        : (typeof _toFileUrl === 'function' ? _toFileUrl(j.sourceImageUrl) : j.sourceImageUrl)
    ) : '';
    const sbThumbHtml = sbThumbUrl
      ? `<img src="${escapeHtml(sbThumbUrl)}" alt="" class="step-progress-item-thumb"/>`
      : '';
    return `
      <div class="job-item-2 ${j.status}" data-job-id="${j.id}">
        <div class="job-item-2-header">
          ${sbThumbHtml}
          <div class="job-item-2-name">${escapeHtml(_displayJobName(j.name))}</div>
          ${hasStep ? `<button class="job-goto-btn" onclick="event.stopPropagation(); window._navigateToJobStep(${j.id})" title="Jump to this step">Go to</button>` : ''}
          ${canCancel ? `<button class="job-cancel-btn" onclick="event.stopPropagation(); window._cancelJob(${j.id})" title="Cancel job">&#10005;</button>` : ''}
        </div>
        <div class="job-item-2-bar">
          <div class="job-item-2-bar-fill" style="width:${pct}%"></div>
        </div>
        <div class="job-item-2-pct">${elapsed ? `<span style="color:var(--text-2); margin-right:8px; font-weight:normal;">${elapsed}</span>` : ''}${pct}%</div>
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
        <div class="job-item-2-pct" style="color:var(--warning, #f59e0b); font-weight:600;">queued</div>
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
  document.getElementById('job-details-subtitle').textContent = _displayJobName(j.name);
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
        const full = String(v == null ? '--' : v);
        // The value column now wraps (CSS overflow-wrap), so allow a longer
        // filename before truncating; the full name is always in the tooltip.
        const val = full.length > 120 ? full.slice(0, 117) + '...' : full;
        return `<div class="jd-row"><span class="jd-label">${escapeHtml(k)}</span><span class="jd-value" title="${escapeHtml(full)}">${escapeHtml(val)}</span></div>`;
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
  //
  // PRIORITY: job.sourceImageUrl (the SNAPSHOT taken at pushJob time) wins
  // over state.currentProject.* — because the user can click another
  // version thumb between launch and the modal refresh, which would swap
  // the displayed source image to a completely different asset (the
  // "knight thumb for porte-avion" bug).
  const refImg = document.getElementById('jd-ref-img');
  const p = state.currentProject;
  const isRigJob = /rig/i.test(j.name || '');
  // Match all phases of an image-creation job so the popup never shows the
  // previously-selected image as a thumb. The phase-2 rename ("Generating
  // 6 views: ..." / "Generate back views: ...") used to escape the original
  // regex and reveal the stale thumb mid-generation.
  const isImageGenJob = /^(generate images?|generating (back|6) views|generate back views|multi-views)\b/i.test(j.name || '');
  let thumbUrl = null;
  let thumbSource = null;
  // 1) Snapshot wins — set at launch time, immune to UI state mutations.
  if (j.sourceImageUrl && !isImageGenJob) {
    const u = j.sourceImageUrl;
    if (/^https?:|^file:|^data:|^blob:/i.test(u)) {
      thumbUrl = u + (u.includes('?') ? '&' : '?') + 't=' + Date.now();
    } else {
      thumbUrl = _toFileUrl(u) + '?t=' + Date.now();
    }
    thumbSource = 'job.sourceImageUrl';
  }
  // 2) Rig jobs: show the source mesh thumbnail (not an image).
  if (!thumbUrl && isRigJob && p && p.selectedMeshPath && API.getThumbnail) {
    try {
      const t = await API.getThumbnail(p.selectedMeshPath);
      if (t) { thumbUrl = t + '?t=' + Date.now(); thumbSource = 'mesh.thumbnail'; }
    } catch (_) {}
  }
  // 3) Fallback to the current project's image path (legacy behaviour).
  //    NOTE: this is what was buggy — it reads LIVE state.
  if (!thumbUrl && p && !isImageGenJob) {
    const imgPath = p.selectedImagePath || p.previewImagePath || p.thumb;
    if (imgPath) {
      thumbUrl = _toFileUrl(imgPath) + '?t=' + Date.now();
      thumbSource = 'state.currentProject (fallback)';
    }
  }
  // Log once per refresh tick — helps diagnose future "wrong thumb" reports.
  // Only log when the resolved URL CHANGES to avoid spamming the console
  // (refreshJobDetailsModal runs every 1s while the modal is open).
  if (refImg && refImg.dataset._lastResolvedUrl !== (thumbUrl || '')) {
    refImg.dataset._lastResolvedUrl = thumbUrl || '';
    try { console.log('[jobDetails] thumb resolved from', thumbSource, 'url=', thumbUrl); } catch(_) {}
  }
  if (thumbUrl && refImg) {
    refImg.src = thumbUrl;
    refImg.style.display = '';
  } else if (refImg) {
    // Defensive: if no snapshot AND no project thumb, HIDE rather than
    // show a stale image from a different asset.
    refImg.removeAttribute('src');
    refImg.style.display = 'none';
  }
  const pct = Math.round(j.progress);
  document.getElementById('jd-progress-fill').style.width = pct + '%';
  document.getElementById('jd-progress-pct').textContent = pct + '%';
  // First-run hint — shown while a local SDXL-server-backed job is running,
  // so the user understands why the first call takes 1-3 minutes (model
  // download + VRAM load). Hidden for cloud jobs (pollinations) and
  // for jobs that have already finished.
  // First-run hint: only show when the job JUST started (first 15s) AND
  // it's a local GPU job. After 15s the model is either loaded (hint no
  // longer relevant) or the job already has real progress. This prevents
  // the hint from appearing on every single generation.
  const hintEl = document.getElementById('jd-first-run-hint');
  if (hintEl) {
    const elapsed = Date.now() - j.startedAt;
    const isRunning = j.status === 'running';
    const isLocalGpu = /realvis|sf3d|stable fast|unirig|sdxl|inpaint/i.test(
      (j.params?.Engine || '') + ' ' + (j.name || '')
    );
    // Cloud Modal cold-start detection: window.__modalWarm is set to
    // false by cloud-overrides._pollModalStatus when the container
    // isn't warm. While cold, we show a dedicated message instead of
    // the local-GPU VRAM blurb. Visible for the whole cold start, not
    // just the first 15s — the user needs to know why nothing's
    // happening yet.
    //
    // IMPORTANT: rely ONLY on the live window.__modalWarm flag. An older
    // regex fallback matched "warming up" inside j.params.Engine, but
    // that string is FROZEN at job launch time — once Modal becomes
    // warm seconds later, the regex kept matching and the hint stayed
    // up for the whole run, misleading the user on warm jobs.
    // Default to NOT cold when __modalWarm has never been polled (i.e.
    // strictly === false), so warm/unknown both hide the hint.
    // Cap the cold-start hint to a 180s window from job start. Modal's
    // typical cold-start is 60-150s on the heaviest containers
    // (RealVis, TRELLIS-2). The previous 60s cap was lying to the user
    // after the first minute. If we're still flagged cold after 3 min
    // the status endpoint is probably stale — that's the only case the
    // cap saves us from.
    // Pick the SPECIFIC container this job will hit (not the legacy
    // global __modalWarm which only tracks image_op). Without this,
    // the popup wrongly said 'Warming up' for mesh/rig jobs when the
    // mesh container was actually warm — and vice versa.
    const containerForKind = {
      image: 'text2image', view: 'back_view',
      mesh: 'mesh',
      modify: 'image_op', inpaint: 'image_op',
      facefix: 'image_op', upscale: 'image_op', removebg: 'image_op',
      rectify: 'tpose',
    };
    const ckey = containerForKind[j.kind];
    const jobContainer = (window.__modalContainers || {})[ckey];
    const jobContainerWarm = jobContainer ? jobContainer.warm : undefined;
    const isCloudCold = isRunning && jobContainerWarm === false && elapsed < 180000;
    // Rate-limit the diag log: only print when the decision FLIPS, not
    // on every render tick. Otherwise long-running jobs (60s+) flood
    // the console with hundreds of identical entries.
    if (!window.__coldstartHintLast || window.__coldstartHintLast.kind !== j.kind
        || window.__coldstartHintLast.decision !== isCloudCold) {
      window.__coldstartHintLast = { kind: j.kind, decision: isCloudCold };
      try {
        console.log('[coldstart-hint]', {
          __modalWarm: window.__modalWarm,
          kind: j.kind,
          status: j.status,
          decision: isCloudCold,
        });
      } catch (_e) {}
    }
    const isLocalEarly = isRunning && isLocalGpu && elapsed < 15000;
    const showHint = isCloudCold || isLocalEarly;
    hintEl.classList.toggle('hidden', !showHint);
    if (showHint) {
      const dflt = document.getElementById('jd-hint-default');
      const cold = document.getElementById('jd-hint-coldstart');
      const etaEl = document.getElementById('jd-hint-coldstart-eta');
      if (isCloudCold && cold && dflt) {
        cold.style.display = '';
        dflt.style.display = 'none';
        if (etaEl) {
          const secs = window.__modalExpectedSeconds || 150;
          etaEl.textContent = secs >= 60
            ? `${Math.round(secs / 60)} min`
            : `${secs} s`;
        }
      } else if (cold && dflt) {
        cold.style.display = 'none';
        dflt.style.display = '';
      }
    }
  }
  // Cancel button: only enabled while running
  const cancelBtn = document.getElementById('job-details-cancel');
  cancelBtn.disabled = j.status !== 'running';
  cancelBtn.style.display = j.status === 'running' ? '' : 'none';
  // Error box — shown when the job failed with a message.
  const errBox = document.getElementById('jd-error-box');
  const openSettingsBtn = document.getElementById('job-details-open-settings');
  const unlockBtn = document.getElementById('job-details-unlock');
  if (errBox) {
    if (j.status === 'error' && j.errorMessage) {
      errBox.textContent = j.errorMessage;
      errBox.classList.remove('hidden');
      // Content-filter block → offer a direct Unlock shortcut.
      const isContentFilter = /content filter|parental control|unrestricted mode/i.test(j.errorMessage);
      if (unlockBtn) unlockBtn.style.display = isContentFilter ? '' : 'none';
    } else {
      errBox.textContent = '';
      errBox.classList.add('hidden');
      if (unlockBtn) unlockBtn.style.display = 'none';
    }
  }
  if (openSettingsBtn) openSettingsBtn.style.display = 'none';
  // Go-to-step button: visible whenever this job maps to a Create New
  // step (image / mesh / rig / anim). Clicking it opens the matching
  // project and scroll-expands its step card.
  const gotoBtn = document.getElementById('job-details-goto-step');
  if (gotoBtn) {
    const stepIdx = _jobStepIndex(j);
    gotoBtn.style.display = stepIdx > 0 ? '' : 'none';
    if (stepIdx > 0) {
      // On success point at the RESULT; while running/error point at the
      // generation step. Unified label (ported from desktop).
      gotoBtn.textContent = j.status === 'done' ? '→ Go to generated item' : '→ Go to generation';
    }
  }
}
document.getElementById('job-details-close-x')?.addEventListener('click', closeJobDetails);
document.getElementById('job-details-unlock')?.addEventListener('click', () => {
  // Close this modal, open the legal-warning + PIN flow, then re-run the blocked job.
  closeJobDetails();
  setTimeout(() => { _unlockThenRetry(); }, 60);
});
document.getElementById('job-details-goto-step')?.addEventListener('click', () => {
  const id = state._jobDetailsOpenId;
  if (!id) return;
  closeJobDetails();
  window._navigateToJobStep(id);
});
document.getElementById('job-details-open-settings')?.addEventListener('click', () => {
  closeJobDetails();
  openSettings();
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
// 2026-06-02: also tick the sidebar + per-step tiles every second so
// the elapsed-time chip next to the % updates live. Only re-renders
// when there are running jobs to avoid useless DOM work when idle.
setInterval(() => {
  if (state.jobs && state.jobs.some(j => j.status === 'running')) {
    try { renderJobs(); } catch (_) {}
  }
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
  if (srcImg) srcImg.src = _toFileUrl(target) + '?t=' + Date.now();
  _aiHideMaskOverlay();  // fresh modal → clear any stale mask preview
  document.getElementById('modal-auto-inpaint').classList.remove('hidden');
});
// Live CLIPSeg mask preview — auto-detect (debounced) as the user types the
// TARGET / changes the padding, exactly like desktop (no button). Each detection
// is a GPU call on serverless, so we debounce; a spinner shows progress.
let _aiPreviewTimer = null;
function _aiHideMaskOverlay() {
  const ov = document.getElementById('ai-mask-overlay');
  if (ov) { ov.style.display = 'none'; ov.removeAttribute('src'); }
}
let _aiFirstDetectDone = false;  // first cloud detection cold-starts the GPU (~15s)
// On-demand mask preview — each detection is a PAID GPU call on cloud (1 credit),
// so it runs only when the user clicks "Preview mask", not on every keystroke.
document.getElementById('ai-preview-btn')?.addEventListener('click', async () => {
  const p = state.currentProject;
  const imagePath = editTarget(p);
  if (!imagePath || !window.meshyAPI?.segmentMask) { showToast('Pick an image first.', 'error'); return; }
  const target = (document.getElementById('ai-target').value || '').trim();
  if (!target) {
    showToast('Type what to find first (e.g. "hat", "background")', 'error');
    document.getElementById('ai-target')?.focus();
    return;
  }
  const dilate = parseInt(document.getElementById('ai-dilate').value) || 15;
  const spinner = document.getElementById('ai-detect-spinner');
  const label = document.getElementById('ai-detect-label');
  const btn = document.getElementById('ai-preview-btn');
  const prevHtml = btn ? btn.innerHTML : '';
  if (label) label.textContent = _aiFirstDetectDone
    ? 'Detecting target…'
    : 'Warming up the cloud GPU… first detection ~15s, then fast.';
  if (spinner) spinner.style.display = 'flex';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Detecting…'; }
  try {
    const r = await window.meshyAPI.segmentMask({ imagePath, targetText: target, dilate });
    _aiFirstDetectDone = true;
    const ov = document.getElementById('ai-mask-overlay');
    if (r?.success && r.maskUrl && ov) {
      ov.src = r.maskUrl + (r.maskUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
      ov.style.display = 'block';
    } else {
      _aiHideMaskOverlay();
      showToast('Nothing detected for “' + target + '”.', 'info', 4000);
    }
  } catch (e) {
    _aiHideMaskOverlay();
    showToast('Mask preview error: ' + (e?.message || e), 'error', 5000);
  } finally {
    if (spinner) spinner.style.display = 'none';
    if (btn) { btn.disabled = false; btn.innerHTML = prevHtml; }
  }
});
// Typing a new target / changing padding invalidates the shown preview.
document.getElementById('ai-target')?.addEventListener('input', _aiHideMaskOverlay);
const aiDilate = document.getElementById('ai-dilate');
if (aiDilate) aiDilate.addEventListener('input', () => {
  document.getElementById('ai-dilate-val').textContent = aiDilate.value + 'px';
  _aiHideMaskOverlay();
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
  const inpaintSource = imagePath;
  const inpaintProject = p.name;
  gatedRun('inpaint', `Auto inpaint: ${p.name}`, async () => {
    const job = pushJob(`Auto inpaint: ${p.name}`, null, {
      Target: target,
      Replace: replace || '(remove)',
      Padding: dilate + 'px',
    }, 180000, undefined, { sourceImageUrl: inpaintSource, projectName: inpaintProject });
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
  // Clamp to functional ranges so MyFabmesh.AI stays usable. Minimums match
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

  // Cloud (Modal Labs) scales horizontally — each call spawns its
  // own container, so the local-GPU "one heavy job at a time"
  // guard from the desktop build is dead weight here. Skip every
  // VRAM/temperature/util check; the Worker enforces per-user
  // daily-call caps separately if needed.
  if (document.body.classList.contains("cloud-mode")) {
    return { ok: true };
  }
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
      customError(reason + '\n\n' + FabI18n.t('The job will start automatically once the limits are met.') + '\n' + FabI18n.t('You can adjust the sliders in Settings.'), FabI18n.t('Job queued'));
    } else {
      alert(FabI18n.t('Job queued') + ': ' + reason);
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

// About / Help modal — show version, links, update check.
(() => {
  const btn       = document.getElementById('btn-about');
  const modal     = document.getElementById('about-modal');
  const closeBtn  = document.getElementById('about-close');
  const backdrop  = document.getElementById('about-backdrop');
  const versEl    = document.getElementById('about-version-num');
  const checkBtn  = document.getElementById('about-check-update');
  const statusEl  = document.getElementById('about-update-status');
  const linkSite     = document.getElementById('about-link-site');
  const linkPrivacy  = document.getElementById('about-link-privacy');
  const linkTerms    = document.getElementById('about-link-terms');
  const linkContact  = document.getElementById('about-link-contact');
  if (!btn || !modal) return;

  // Site link opens externally (desktop uses an IPC because the
  // allowed-host list lives there). Privacy/Terms are in-app routes.
  const openExt = (url) => {
    if (window.wizardAPI?.openExternal) window.wizardAPI.openExternal(url);
    else window.open(url, '_blank');
  };
  linkSite?.addEventListener('click', (e) => {
    // On cloud we ARE on the site already; keep default behaviour (load /).
    if (!window.wizardAPI?.openExternal) return;
    e.preventDefault();
    openExt('https://fabienlacaze.github.io/MyFabmesh/');
  });
  // Privacy / Terms — let the browser follow the in-app href.
  // (No extra wiring; they're real anchors to /legal/* pages.)

  // Contact link opens the contact modal.
  linkContact?.addEventListener('click', (e) => {
    e.preventDefault();
    const cm = document.getElementById('contact-modal');
    if (!cm) return;
    modal.classList.add('hidden');
    cm.classList.remove('hidden');
  });

  const show = async () => {
    modal.classList.remove('hidden');
    // Populate version from app at open time so it stays in sync
    // with the running build.
    try {
      const v = await (window.wizardAPI?.getVersion?.() ?? Promise.resolve(null));
      versEl.textContent = v || '—';
    } catch (_) { versEl.textContent = '—'; }
  };
  const hide = () => modal.classList.add('hidden');
  btn.addEventListener('click', show);
  closeBtn?.addEventListener('click', hide);
  backdrop?.addEventListener('click', hide);
  document.addEventListener('keydown', (e) => {
    if (!modal.classList.contains('hidden') && e.key === 'Escape') hide();
  });

  checkBtn?.addEventListener('click', async () => {
    if (!window.meshyAPI?.checkForUpdate) {
      statusEl.textContent = 'Update check not available in this build.';
      return;
    }
    checkBtn.disabled = true;
    statusEl.textContent = 'Checking GitHub for updates…';
    try {
      const r = await window.meshyAPI.checkForUpdate();
      if (!r.ok) {
        statusEl.textContent = r.error === 'dev build, skipping'
          ? 'Running a development build — no updates available.'
          : 'Update check failed: ' + (r.error || 'unknown');
      } else if (r.hasUpdate) {
        statusEl.textContent = `Version ${r.version} is downloading. We'll show a toast when it's ready.`;
      } else {
        statusEl.textContent = 'You are running the latest version.';
      }
    } catch (e) {
      statusEl.textContent = 'Update check failed: ' + e.message;
    } finally {
      checkBtn.disabled = false;
    }
  });
})();

// Contact modal — POSTs to /api/contact which stores the message in
// R2 so the admin can read it under /admin > Messages.
//
// 2026-06-01: Send is disabled until ALL four fields are non-empty AND
// the email looks valid. Optional screenshot attachments (up to 5 × 5 MB)
// are previewed in-place and posted as multipart/form-data.
(() => {
  const modal      = document.getElementById('contact-modal');
  const closeBtn   = document.getElementById('contact-close');
  const cancelBtn  = document.getElementById('contact-cancel');
  const backdrop   = document.getElementById('contact-backdrop');
  const form       = document.getElementById('contact-form');
  const submitBtn  = document.getElementById('contact-submit');
  const feedback   = document.getElementById('contact-feedback');
  const fileInput  = document.getElementById('contact-screenshots');
  const previewBox = document.getElementById('contact-screenshots-preview');
  if (!modal || !form) return;
  const nameEl    = document.getElementById('contact-name');
  const emailEl   = document.getElementById('contact-email');
  const subjectEl = document.getElementById('contact-subject');
  const bodyEl    = document.getElementById('contact-body');
  const MAX_FILES = 5;
  const MAX_SIZE  = 5 * 1024 * 1024;
  // Selected files survive separate from the input.files FileList so
  // the user can remove individual items via the preview's ✕ button.
  let selectedFiles = [];

  function isValidEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }
  function refreshSubmitState() {
    const ok = nameEl.value.trim()
            && isValidEmail(emailEl.value.trim())
            && subjectEl.value.trim()
            && bodyEl.value.trim();
    submitBtn.disabled = !ok;
    // Soft visual cue when disabled.
    submitBtn.style.opacity = ok ? '1' : '0.5';
    submitBtn.style.cursor  = ok ? 'pointer' : 'not-allowed';
  }
  ['input', 'change', 'keyup'].forEach(ev => {
    nameEl.addEventListener(ev, refreshSubmitState);
    emailEl.addEventListener(ev, refreshSubmitState);
    subjectEl.addEventListener(ev, refreshSubmitState);
    bodyEl.addEventListener(ev, refreshSubmitState);
  });
  refreshSubmitState();

  function renderPreviews() {
    previewBox.innerHTML = '';
    selectedFiles.forEach((f, i) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:relative; width:72px; height:72px; border:1px solid var(--border); border-radius:6px; overflow:hidden; background:var(--bg-2);';
      const img = document.createElement('img');
      img.src = URL.createObjectURL(f);
      img.style.cssText = 'width:100%; height:100%; object-fit:cover;';
      img.onload = () => URL.revokeObjectURL(img.src);
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = '✕';
      rm.title = 'Remove';
      rm.style.cssText = 'position:absolute; top:2px; right:2px; width:20px; height:20px; padding:0; border-radius:50%; border:none; background:rgba(0,0,0,0.7); color:#fff; cursor:pointer; font-size:11px; line-height:1;';
      rm.addEventListener('click', () => {
        selectedFiles.splice(i, 1);
        renderPreviews();
      });
      wrap.appendChild(img);
      wrap.appendChild(rm);
      previewBox.appendChild(wrap);
    });
  }
  fileInput?.addEventListener('change', () => {
    const added = Array.from(fileInput.files || []);
    for (const f of added) {
      if (selectedFiles.length >= MAX_FILES) {
        feedback.style.background = 'rgba(239, 68, 68, 0.15)';
        feedback.style.color = '#f87171';
        feedback.textContent = `⚠ Max ${MAX_FILES} screenshots — extras ignored.`;
        feedback.style.display = 'block';
        break;
      }
      if (f.size > MAX_SIZE) {
        feedback.style.background = 'rgba(239, 68, 68, 0.15)';
        feedback.style.color = '#f87171';
        feedback.textContent = `⚠ "${f.name}" is too large (${(f.size / 1024 / 1024).toFixed(1)} MB > 5 MB).`;
        feedback.style.display = 'block';
        continue;
      }
      selectedFiles.push(f);
    }
    // Reset the input so re-picking the same file re-fires change.
    fileInput.value = '';
    renderPreviews();
  });

  const hide = () => {
    modal.classList.add('hidden');
    feedback.style.display = 'none';
    feedback.textContent = '';
    selectedFiles = [];
    renderPreviews();
  };
  closeBtn?.addEventListener('click', hide);
  cancelBtn?.addEventListener('click', hide);
  backdrop?.addEventListener('click', hide);
  document.addEventListener('keydown', (e) => {
    if (!modal.classList.contains('hidden') && e.key === 'Escape') hide();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name    = nameEl.value.trim();
    const email   = emailEl.value.trim();
    const subject = subjectEl.value.trim();
    const body    = bodyEl.value.trim();
    // Defensive — the button is disabled while any field is empty, but
    // re-validate in case someone bypasses the UI.
    if (!name || !email || !subject || !body || !isValidEmail(email)) {
      refreshSubmitState();
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';
    feedback.style.display = 'none';
    try {
      let r;
      if (selectedFiles.length > 0) {
        // multipart/form-data so the worker can stream the image bytes
        // straight into R2 without base64 overhead.
        const fd = new FormData();
        fd.append('name', name);
        fd.append('email', email);
        fd.append('subject', subject);
        fd.append('message', body);
        selectedFiles.forEach((f, i) => fd.append(`screenshot_${i}`, f, f.name));
        r = await fetch('/api/contact', {
          method: 'POST', credentials: 'include', body: fd,
        });
      } else {
        r = await fetch('/api/contact', {
          method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, email, subject, message: body }),
        });
      }
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data?.success) throw new Error(data?.error || `HTTP ${r.status}`);
      feedback.style.background = 'rgba(34, 197, 94, 0.15)';
      feedback.style.color = '#4ade80';
      feedback.textContent = '✓ Message sent. Thanks — we read everything that lands in the inbox.';
      feedback.style.display = 'block';
      form.reset();
      selectedFiles = [];
      renderPreviews();
      refreshSubmitState();
      setTimeout(hide, 3000);
    } catch (err) {
      feedback.style.background = 'rgba(239, 68, 68, 0.15)';
      feedback.style.color = '#f87171';
      feedback.textContent = '⚠ Could not send: ' + (err?.message || err);
      feedback.style.display = 'block';
    } finally {
      submitBtn.textContent = 'Send';
      refreshSubmitState();
    }
  });
})();

// Auto-update toast. Listens for events from the main process (sent
// by electron-updater once a new release is downloaded) and shows a
// non-blocking toast in the top-right. User clicks "Restart & install"
// to apply.
(() => {
  if (!window.meshyAPI?.onUpdateDownloaded) return;
  const toast   = document.getElementById('update-toast');
  const versEl  = document.getElementById('update-toast-version');
  const btnGo   = document.getElementById('update-toast-install');
  const btnX    = document.getElementById('update-toast-close');
  if (!toast || !btnGo) return;
  window.meshyAPI.onUpdateDownloaded(({ version }) => {
    if (version) versEl.textContent = `MyFabmesh.AI ${version} is downloaded and ready to install.`;
    toast.classList.remove('hidden');
  });
  btnGo.addEventListener('click', async () => {
    btnGo.disabled = true;
    btnGo.textContent = 'Restarting…';
    try { await window.meshyAPI.installUpdateNow(); } catch (_) {}
  });
  btnX.addEventListener('click', () => toast.classList.add('hidden'));
})();

// Brand in the topbar = link to the public website. Opens in the
// user's default browser (not inside Electron) via the whitelisted
// app:open-website IPC.
(() => {
  const brand = document.querySelector('#topbar .brand');
  if (!brand) return;
  brand.style.cursor = 'pointer';
  brand.title = 'Open myfabmesh.ai';
  brand.addEventListener('click', async () => {
    try { await window.meshyAPI.openWebsite(); } catch (_) {}
  });
})();
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

// Reconfigure MyFabmesh.AI: relaunch the first-time setup wizard. Models on
// disk and generated meshes are kept; only the "setup done" flag is
// cleared so the wizard reopens at next launch.
document.getElementById('set-reconfigure')?.addEventListener('click', async () => {
  const ok = await customConfirm(
    'This will reopen the setup wizard so you can change install mode '
    + 'or re-download a missing model. Your projects and generated meshes '
    + 'are kept. Continue?',
    'Reconfigure MyFabmesh.AI', 'Reconfigure');
  if (!ok) return;
  try {
    await window.meshyAPI.reconfigureFabmesh();
  } catch (e) {
    showToast('Reconfigure failed: ' + e.message, 'error');
  }
});

// Uninstall MyFabmesh.AI: launches the Windows NSIS uninstaller. The
// uninstaller itself asks the user whether to also delete models and
// settings — we don't ask twice here, just confirm intent and quit.
document.getElementById('set-uninstall')?.addEventListener('click', async () => {
  const ok = await customConfirm(
    'This will launch the Windows uninstaller. You can choose to also '
    + 'delete the AI models (~17 GB) and your settings in the next '
    + 'step. Generated meshes in your projects folder are never '
    + 'touched. Continue?',
    'Uninstall MyFabmesh.AI', 'Uninstall');
  if (!ok) return;
  try {
    const r = await window.meshyAPI.uninstallFabmesh();
    if (!r.ok && r.mode === 'dev') {
      showToast(r.error, 'warning', 8000);
    }
  } catch (e) {
    showToast('Uninstall failed: ' + e.message, 'error');
  }
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
        // Path used in calibration debug view. Falls back to a relative
        // file URI so the dev path never leaks in the packaged build.
        const mvBase = (window.fabmeshConfig && window.fabmeshConfig.calibBase)
          || 'images/_calibration/ref_rubiks_multiview/';
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
      stageCardWithThumbs('1. MyFabmesh.AI 3D Fast raw mesh', s1, (d) => {
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
      message: 'This will stop the pipeline immediately (MyFabmesh.AI 3D Fast, Zero123++, projection). Any partial output for this run will be discarded.',
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

  // SF3D vs TripoSG side-by-side comparison removed — TripoSG engine
  // is no longer shipped (RMBG / FlashVDM derived code, non-commercial).
  const btnCompare = document.getElementById('set-calib-compare');
  if (btnCompare) btnCompare.style.display = 'none';

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
      <p style="color:#aaa; margin-top:0;">Calibration v3 — 5 independent per-stage checks in ~7s. Stage 4 tests UV projection in isolation (skips MyFabmesh.AI 3D Fast + auto-align), so its ceiling is 2/6 on the GT cube by design. Real pipeline uses the full chain and produces clean textures. Use this view to spot regressions, not as an absolute quality metric.</p>
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
            setTierState(t, 'running', ev.message || 'MyFabmesh.AI 3D Fast...');
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
      verdict = `<b>Plateau at ${t3.best_score}/${t3.target}.</b> No projection config reached a perfect score — the remaining loss is upstream (MyFabmesh.AI 3D Fast mesh quality or Zero123++ hallucinations), not a projection flag issue.`;
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
      const gt = _toFileUrl(reportDir).replace(/\/reports\/[^/]+$/, '/ref_0_perfect_axes/') + r.axis + '.png';
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
      if (det) det.textContent = 'Set FABMESH_CONTROL_API=1 (or just relaunch MyFabmesh.AI) to enable.';
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
      // Always fully opaque + clickable. Use an amber tint when unrestricted
      // to signal 'danger zone' instead of dimming the icon (which read as
      // disabled / unclickable to the user).
      lockIcon.style.opacity = '1';
      lockIcon.style.cursor = 'pointer';
      lockIcon.style.pointerEvents = 'auto';
      lockIcon.style.background = r.unrestricted ? 'rgba(245, 158, 11, 0.18)' : '';
      lockIcon.style.borderColor = r.unrestricted ? 'var(--warning, #f59e0b)' : '';
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
          MyFabmesh.AI and its developers assume NO liability for content generated by users in unrestricted mode.
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
    showToast('AI engine killed. VRAM freed.', 'success');
    setTimeout(refreshPythonStats, 1000);
  } catch(e) {
    showToast('Kill AI engine failed: ' + e.message, 'error');
  }
});

// Kill Processes: kill running Python subprocesses (generations) but keep SDXL
document.getElementById('set-kill-python')?.addEventListener('click', async () => {
  try {
    if (API.cancelJob) await API.cancelJob(0);
  } catch(_) {}
  state.jobs = state.jobs.filter(j => j.status !== 'running');
  renderJobs();
  showToast('Processes killed. AI engine preserved.', 'success');
  setTimeout(refreshPythonStats, 1000);
});

// Kill All: kill SDXL + all Python subprocesses
document.getElementById('set-kill-all')?.addEventListener('click', async () => {
  try { if (API.stopSdxlServer) await API.stopSdxlServer(); } catch(_) {}
  try { if (API.cancelJob) await API.cancelJob(0); } catch(_) {}
  state.jobs = state.jobs.filter(j => j.status !== 'running');
  renderJobs();
  showToast('All processes + AI engine killed. VRAM freed.', 'success');
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
  // Cloud short-circuit: Re-skin requires the Puppeteer skinning step
  // to be reachable as a standalone Modal endpoint, which isn't deployed
  // yet. For now route the user back to "Generate new rig version" which
  // re-runs the full pipeline and produces a new rig variant — they get
  // a different skinning result via a different seed rather than a
  // targeted re-skin. When MODAL_PUPPETEER_RIG_URL gains a /rig-reskin
  // endpoint this short-circuit can come out.
  if (window.__isCloud) {
    customError(
      'Re-skin only is not yet wired on the cloud build. Click "Generate new rig version" to re-roll the rig — you will get a fresh skinning attempt as a side effect. (Tracking: needs a /rig-reskin endpoint on Modal.)',
      'Re-skin (cloud)',
    );
    return;
  }
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
// ----------------------------------------------------------
// Dropping a file onto the window opens the New Project modal
// pre-filled with the file's stem. After the user confirms,
// the file is attached to the freshly created project.
// __pendingDroppedFile carries the file across the modal.
// ============================================================
const dropOverlay = document.getElementById('drop-overlay');
let dragCounter = 0;
window.__pendingDroppedFile = null;

function _detectDroppedKind(file) {
  if (!file) return null;
  const name = file.name || '';
  const mime = file.type || '';
  if (mime.startsWith('image/') || /\.(png|jpg|jpeg|webp|gif|bmp)$/i.test(name)) return 'image';
  if (/\.(glb|gltf|obj|stl|ply|fbx)$/i.test(name)) return 'mesh';
  return null;
}

window.addEventListener('dragenter', (e) => {
  if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
    dragCounter++;
    dropOverlay.classList.remove('hidden');
    dropOverlay.classList.add('drop-overlay-active');
  }
});
window.addEventListener('dragleave', (e) => {
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    dropOverlay.classList.add('hidden');
    dropOverlay.classList.remove('drop-overlay-active');
  }
});
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  dragCounter = 0;
  dropOverlay.classList.add('hidden');
  dropOverlay.classList.remove('drop-overlay-active');
  const files = Array.from(e.dataTransfer?.files || []);
  if (files.length === 0) return;
  const f = files[0];
  const kind = _detectDroppedKind(f);
  if (!kind) {
    try { showToast('Unsupported file. Drop a .png/.jpg/.webp image or a .glb/.gltf/.obj/.stl/.ply/.fbx mesh.', 'error', 5000); }
    catch (_) { alert('Unsupported file type.'); }
    return;
  }
  // If a project is currently open in the workspace, route the dropped
  // file as a new version into that project instead of opening the
  // New Project modal.
  const proj = state.currentProject;
  if (proj && state.page === 'workspace') {
    try {
      const blobURL = URL.createObjectURL(f);
      const ts = Date.now();
      window.__cloudImportedFiles = window.__cloudImportedFiles || {};
      window.__cloudImportedFiles[blobURL] = f;
      if (kind === 'image') {
        proj.images = proj.images || [];
        proj.images.unshift({ path: blobURL, kind: 'front', mtime: ts });
        try { window.__cloudImg?.append?.(proj.name, [blobURL], 'front'); } catch (_) {}
        await populateWorkspace(proj);
        // After successful image import, open the Edit stage (not CREATE NEW) and scroll
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
        try { showToast('✓ Imported as new image version', 'success'); } catch (_) {}
      } else if (kind === 'mesh') {
        proj.meshes = proj.meshes || [];
        proj.meshes.unshift({ path: blobURL, filename: f.name, size: f.size, mtime: ts });
        proj.selectedMeshPath = blobURL;
        proj.previewMeshPath = blobURL;
        await populateWorkspace(proj);
        try { showToast('✓ Imported as new mesh version (session only — re-import after reload)', 'info', 6000); } catch (_) {}
      }
    } catch (err) {
      try { showToast('Import failed: ' + (err?.message || err), 'error', 5000); } catch (_) { alert('Import failed: ' + err); }
    }
    return;
  }
  // No project open — fall back to the New Project modal flow.
  // Stash for the modal's Create handler to pick up.
  window.__pendingDroppedFile = { file: f, kind, name: f.name };
  // Open the New Project modal pre-filled with the file's stem.
  try { openNewProjectModal(); } catch (_) {}
  try {
    const stem = String(f.name || '').replace(/\.[^.]+$/, '') || 'project';
    const nameInput = document.getElementById('np-name');
    if (nameInput) nameInput.value = stem;
    const promptInput = document.getElementById('np-prompt');
    if (promptInput && !promptInput.value) promptInput.value = `Imported from ${f.name}.`;
  } catch (_) {}
});

// ============================================================
// LANDMARKS (manual placement on the 3D mesh viewer)
// ============================================================
// Schema: 22 landmarks across 6 categories
// ----------------------------------------------------------------
// Rig topology auto-detection.
//
// Analyses a list of THREE.Bones and returns a structural map:
//   { type: 'humanoid'|'winged_biped'|'quadruped'|'hexapod'|'custom',
//     spine: [bone, …]    // longest mostly-vertical chain from root
//     limbs: [ { name, dir, bones, endpoint } ]   // every other long chain
//   }
//
// Limb classification by endpoint direction relative to spine origin:
//   up + lateral → 'wing' (if endpoint y above spine top) or 'arm'
//   down + lateral → 'leg'
//   horizontal long → 'tail'
function analyzeRigTopology(bones) {
  if (!bones || !bones.length) return { type: 'custom', spine: [], limbs: [] };
  const boneSet = new Set(bones);
  const wp = new Map();
  for (const b of bones) {
    const p = new THREE.Vector3(); b.getWorldPosition(p); wp.set(b, p);
  }
  // Root = bone whose parent is not a bone (skeleton root).
  const roots = bones.filter(b => !b.parent || !boneSet.has(b.parent));
  let root = roots[0] || bones[0];
  // If multiple roots, pick the one with the most descendants in our set.
  if (roots.length > 1) {
    let bestCount = -1;
    for (const r of roots) {
      let count = 0;
      r.traverse(c => { if (boneSet.has(c)) count++; });
      if (count > bestCount) { bestCount = count; root = r; }
    }
  }
  // Walk longest chain UP from root for the spine.
  const visited = new Set([root]);
  function walkLongest(start, dirFn) {
    const path = [start];
    let cur = start;
    while (cur.children && cur.children.length) {
      const candidates = cur.children.filter(c => c.isBone && boneSet.has(c) && !visited.has(c));
      if (!candidates.length) break;
      const curPos = wp.get(cur);
      let best = null, bestScore = -Infinity;
      for (const c of candidates) {
        const d = wp.get(c).clone().sub(curPos);
        const score = dirFn(d, d.length());
        if (score > bestScore) { bestScore = score; best = c; }
      }
      if (!best || bestScore < 0.2) break;
      path.push(best);
      visited.add(best);
      cur = best;
    }
    return path;
  }
  // Spine = most upward chain.
  const spine = walkLongest(root, (d, len) => len > 1e-6 ? d.y / len : -1);
  // Other limb chains = every child of a spine bone that we haven't yet
  // visited. Walk each to its leaf without direction restriction.
  const limbs = [];
  for (const sb of spine) {
    const sChildren = (sb.children || []).filter(c => c.isBone && boneSet.has(c) && !visited.has(c));
    for (const start of sChildren) {
      visited.add(start);
      const chain = [start];
      let cur = start;
      while (cur.children && cur.children.length) {
        const next = cur.children.find(x => x.isBone && boneSet.has(x) && !visited.has(x));
        if (!next) break;
        visited.add(next);
        chain.push(next);
        cur = next;
      }
      // Classify by direction of (endpoint - chain origin) and where on
      // the spine the chain attaches (top vs bottom).
      const origin = wp.get(chain[0]);
      const end = wp.get(chain[chain.length - 1]);
      const d = end.clone().sub(origin);
      const len = d.length();
      // Spine fraction: how high up the spine does this chain attach?
      const spineIdx = spine.indexOf(sb);
      const spineFrac = spine.length > 1 ? spineIdx / (spine.length - 1) : 0.5;
      const lateralAxis = Math.abs(d.x) > Math.abs(d.z) ? 'x' : 'z';
      const side = lateralAxis === 'x' ? (d.x >= 0 ? 'left' : 'right') : (d.z >= 0 ? 'left' : 'right');
      let kind;
      if (chain.length < 2 || len < 1e-3) kind = 'stub';
      else if (spineFrac > 0.6 && end.y >= origin.y - len * 0.2) {
        // High attach + mostly horizontal/upward → arm or wing.
        kind = (len > spine.length * 0.5) ? 'wing' : 'arm';
      } else if (spineFrac < 0.4 && end.y < origin.y) kind = 'leg';
      else if (Math.abs(d.y) < len * 0.3) kind = 'tail';      // horizontal off spine middle
      else kind = 'limb';
      limbs.push({ kind, side, bones: chain, length: len, attach: spineFrac, endpoint: end.clone() });
    }
  }
  // Determine type from limb counts.
  const count = (k) => limbs.filter(l => l.kind === k).length;
  const wings = count('wing'), arms = count('arm'), legs = count('leg'), tail = count('tail');
  let type = 'custom';
  if (wings === 2 && legs === 2) type = 'winged_biped';
  else if (arms === 2 && legs === 2) type = 'humanoid';
  else if (legs === 4) type = 'quadruped';
  else if (legs === 6) type = 'hexapod';
  return { type, spine, limbs, root };
}

// Generates a LM_SCHEMA tailored to a topology analysis result. Returns
// the same shape as the static LM_SCHEMA (array of { cat, items: [] }).
function buildDynamicLmSchema(topo) {
  if (!topo || !topo.type) return LM_SCHEMA;
  const palette = {
    head: '#ff4444', neck: '#ff8844', spine_top: '#ff6622', spine_mid: '#cc5511', hips: '#ffaa00',
    armL: ['#22cc88', '#88ff88', '#44ff44'],
    armR: ['#11aa66', '#66cc66', '#44aa44'],
    legL: ['#ffcc00', '#88aaff', '#5577ee', '#4444ff'],
    legR: ['#dd9900', '#6688cc', '#4466bb', '#4477ff'],
    wingL: ['#22ccff', '#66ddff', '#88eeff'],
    wingR: ['#11aaee', '#55aacc', '#7799cc'],
    tail: ['#cc66ff', '#aa44cc', '#882299'],
  };
  const out = [
    { cat: 'Head & Spine', items: [
      { id: 'head', label: 'Head', color: palette.head },
      { id: 'neck', label: 'Neck', color: palette.neck },
      { id: 'spine_top', label: 'Upper spine', color: palette.spine_top },
      { id: 'spine_mid', label: 'Mid spine', color: palette.spine_mid },
      { id: 'hips', label: 'Hips/Root', color: palette.hips },
    ]},
  ];
  const hasWings = topo.limbs.filter(l => l.kind === 'wing').length >= 1;
  const armCount = topo.limbs.filter(l => l.kind === 'arm').length;
  const legCount = topo.limbs.filter(l => l.kind === 'leg').length;
  if (hasWings) {
    out.push({ cat: 'Left wing', items: [
      { id: 'wing_root_l', label: 'L Wing root', color: palette.wingL[0] },
      { id: 'wing_mid_l',  label: 'L Wing mid',  color: palette.wingL[1] },
      { id: 'wing_tip_l',  label: 'L Wing tip',  color: palette.wingL[2] },
    ]});
    out.push({ cat: 'Right wing', items: [
      { id: 'wing_root_r', label: 'R Wing root', color: palette.wingR[0] },
      { id: 'wing_mid_r',  label: 'R Wing mid',  color: palette.wingR[1] },
      { id: 'wing_tip_r',  label: 'R Wing tip',  color: palette.wingR[2] },
    ]});
  }
  if (armCount >= 1) {
    out.push({ cat: 'Left arm', items: [
      { id: 'shoulder_l', label: 'L Shoulder', color: palette.armL[0] },
      { id: 'elbow_l',    label: 'L Elbow',    color: palette.armL[1] },
      { id: 'hand_l',     label: 'L Wrist',    color: palette.armL[2] },
    ]});
    if (armCount >= 2) {
      out.push({ cat: 'Right arm', items: [
        { id: 'shoulder_r', label: 'R Shoulder', color: palette.armR[0] },
        { id: 'elbow_r',    label: 'R Elbow',    color: palette.armR[1] },
        { id: 'hand_r',     label: 'R Wrist',    color: palette.armR[2] },
      ]});
    }
  }
  if (legCount >= 1) {
    out.push({ cat: 'Left leg', items: [
      { id: 'hip_l',   label: 'L Hip',    color: palette.legL[0] },
      { id: 'knee_l',  label: 'L Knee',   color: palette.legL[1] },
      { id: 'ankle_l', label: 'L Ankle',  color: palette.legL[2] },
      { id: 'foot_l',  label: 'L Foot',   color: palette.legL[3] },
    ]});
    if (legCount >= 2) {
      out.push({ cat: 'Right leg', items: [
        { id: 'hip_r',   label: 'R Hip',    color: palette.legR[0] },
        { id: 'knee_r',  label: 'R Knee',   color: palette.legR[1] },
        { id: 'ankle_r', label: 'R Ankle',  color: palette.legR[2] },
        { id: 'foot_r',  label: 'R Foot',   color: palette.legR[3] },
      ]});
    }
  }
  // Extra legs (quadruped front + back, hexapod, etc.)
  if (legCount >= 3) {
    for (let i = 2; i < Math.min(legCount, 8); i++) {
      out.push({ cat: `Leg ${i+1}`, items: [
        { id: `leg${i}_hip`,   label: `Leg${i+1} hip`,   color: palette.legL[i % 4] },
        { id: `leg${i}_knee`,  label: `Leg${i+1} knee`,  color: palette.legL[(i+1) % 4] },
        { id: `leg${i}_foot`,  label: `Leg${i+1} foot`,  color: palette.legL[(i+2) % 4] },
      ]});
    }
  }
  // Tail
  const tailCount = topo.limbs.filter(l => l.kind === 'tail').length;
  if (tailCount >= 1) {
    out.push({ cat: 'Tail', items: [
      { id: 'tail_base', label: 'Tail base', color: palette.tail[0] },
      { id: 'tail_mid',  label: 'Tail mid',  color: palette.tail[1] },
      { id: 'tail_tip',  label: 'Tail tip',  color: palette.tail[2] },
    ]});
  }
  return out;
}

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
  // Landmarks are a rig *input*, not an overlay to display on the
  // finished rig viewer or on the 3D Mesh main viewer (cluttered the
  // dragon viewer for the user).
  // Priority: fullscreen modal > rig source (clean mesh preview).
  // The main 3D Mesh viewer (wsScene/wsModel) is INTENTIONALLY excluded
  // here so markers never pollute the primary preview.
  const lmFsOpen = document.getElementById('lm-fullscreen') && !document.getElementById('lm-fullscreen').classList.contains('hidden');
  if (lmFsOpen && lmFsModel) return { model: lmFsModel, scene: lmFsScene };
  if (rigSrcModel) return { model: rigSrcModel, scene: rigSrcScene };
  return null;
}

// Cleanup: ensure no marker survives in the 3D Mesh main viewer
// scene. Called from populateWorkspace so opening a project always
// starts with a clean dragon preview.
function clearLandmarkMarkersFromMainViewer() {
  if (!wsScene) return;
  for (const id in lmMarkers) {
    try { wsScene.remove(lmMarkers[id]); } catch (_) {}
  }
}

// ----------------------------------------------------------------
// Extract landmark positions from an already-generated rig.
//
// Loads the user's currently-selected rig GLB, walks the bone tree,
// fuzzy-matches each bone's name against the LM_SCHEMA ids, and
// places a landmark marker at each matched bone's WORLD position
// (after computing matrices). The result is the same as a manual
// click-placement, so 'Re-generate rig with these landmarks' will
// see them as input.
//
// Coordinates: the loaded rig is positioned into lmFsScene with the
// same fit transform as the mesh in openLandmarksFullscreen (centered
// on x/z, bottom on y=0). Bone world positions read after we apply
// the same transform are in the same space as user-placed markers.
async function extractLandmarksFromRig() {
  const p = state.currentProject;
  // Pick the selected rig if any, fall back to the first one.
  const rigPath = p?.selectedRigPath
              || (p?.rigs && p.rigs[0]?.url)
              || (p?.rigs && p.rigs[0]?.path);
  if (!rigPath) {
    customError('Generate a rig first (Step 3 Rig → Generate Rig).', 'From rig');
    return;
  }
  // Fuzzy mapping from bone-name → landmark id. Supports the major
  // rig naming conventions:
  //  - Mixamo: mixamorig:Head, mixamorig:LeftArm, …
  //  - Puppeteer/AnyTop: Head, Neck, Spine2, LeftShoulder, …
  //  - orc_m1 (Apovivor game): head, chest, belt, shoulder_l, …
  const BONE_RULES = [
    { id: 'head',       patterns: [/^head$/i, /skull/i, /mixamo.*head/i, /bip01.*head/i] },
    { id: 'neck',       patterns: [/^neck/i, /mixamo.*neck/i, /bip01.*neck/i] },
    { id: 'spine_top',  patterns: [/spine.?2$/i, /spine.?upper/i, /upper.?spine/i, /chest$/i, /sternum/i] },
    { id: 'spine_mid',  patterns: [/spine.?1$/i, /spine.?mid/i, /mid.?spine/i, /^spine$/i, /belt/i] },
    { id: 'hips',       patterns: [/^hips?$/i, /pelvis/i, /^root$/i, /mixamo.*hips/i] },
    { id: 'shoulder_l', patterns: [/(^l[_.]?|left)shoulder/i, /(^l[_.]?|left)clavicle/i, /(^l[_.]?|left)arm$/i, /mixamo.*leftarm$/i] },
    { id: 'elbow_l',    patterns: [/(^l[_.]?|left)elbow/i, /(^l[_.]?|left)forearm/i, /mixamo.*leftforearm/i] },
    { id: 'hand_l',     patterns: [/(^l[_.]?|left)wrist/i, /(^l[_.]?|left)hand$/i, /mixamo.*lefthand$/i] },
    { id: 'shoulder_r', patterns: [/(^r[_.]?|right)shoulder/i, /(^r[_.]?|right)clavicle/i, /(^r[_.]?|right)arm$/i, /mixamo.*rightarm$/i] },
    { id: 'elbow_r',    patterns: [/(^r[_.]?|right)elbow/i, /(^r[_.]?|right)forearm/i, /mixamo.*rightforearm/i] },
    { id: 'hand_r',     patterns: [/(^r[_.]?|right)wrist/i, /(^r[_.]?|right)hand$/i, /mixamo.*righthand$/i] },
    { id: 'hip_l',      patterns: [/(^l[_.]?|left)upleg/i, /(^l[_.]?|left)thigh/i, /(^l[_.]?|left)hip/i] },
    { id: 'knee_l',     patterns: [/(^l[_.]?|left)leg$/i, /(^l[_.]?|left)knee/i, /(^l[_.]?|left)shin/i] },
    { id: 'ankle_l',    patterns: [/(^l[_.]?|left)ankle/i, /(^l[_.]?|left)foot$/i] },
    { id: 'foot_l',     patterns: [/(^l[_.]?|left)toe/i, /(^l[_.]?|left)toebase/i, /(^l[_.]?|left)ball/i] },
    { id: 'hip_r',      patterns: [/(^r[_.]?|right)upleg/i, /(^r[_.]?|right)thigh/i, /(^r[_.]?|right)hip/i] },
    { id: 'knee_r',     patterns: [/(^r[_.]?|right)leg$/i, /(^r[_.]?|right)knee/i, /(^r[_.]?|right)shin/i] },
    { id: 'ankle_r',    patterns: [/(^r[_.]?|right)ankle/i, /(^r[_.]?|right)foot$/i] },
    { id: 'foot_r',     patterns: [/(^r[_.]?|right)toe/i, /(^r[_.]?|right)toebase/i, /(^r[_.]?|right)ball/i] },
  ];
  function classifyBone(name) {
    // Strip the 'mixamorig:' prefix for cleaner matching against the
    // standardized rules. Tests run against BOTH original and stripped.
    const clean = String(name || '').replace(/^mixamo[^:]*:/i, '').trim();
    for (const r of BONE_RULES) {
      for (const p of r.patterns) {
        if (p.test(name) || p.test(clean)) return r.id;
      }
    }
    return null;
  }

  try {
    lmPushHistory(); // so Ctrl+Z restores whatever the user had before.
    // Read bones DIRECTLY from lmFsModel (the rig already loaded into
    // the modal viewer and centered in fitFs). Reading from a freshly-
    // re-parsed offscreen instance had subtle bbox/centering drift
    // that decoupled marker positions from the visible skeleton.
    if (!lmFsModel) {
      customError('Wait for the rig to finish loading.', 'From rig');
      return;
    }
    lmFsModel.updateMatrixWorld(true);
    const bones = [];
    lmFsModel.traverse((c) => {
      if (c.isBone) bones.push(c);
      else if (c.isSkinnedMesh && c.skeleton) {
        for (const b of c.skeleton.bones) if (!bones.includes(b)) bones.push(b);
      }
    });
    if (!bones.length) {
      customError('No bones found in the selected rig.', 'From rig');
      return;
    }
    let matched = 0;
    const seen = new Set();
    // Build a color lookup from LM_SCHEMA so each marker shows the
    // right colour in the silhouette panel.
    const colorById = {};
    for (const cat of LM_SCHEMA) for (const it of cat.items) colorById[it.id] = it.color;
    for (const b of bones) {
      const id = classifyBone(b.name);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const pos = new THREE.Vector3();
      b.getWorldPosition(pos);
      placeLandmarkMarker(id, pos, colorById[id] || '#ffffff');
      // Link the marker to the bone so drag can move the bone too.
      if (lmMarkers[id]) lmMarkers[id].userData._linkedBone = b;
      matched++;
    }
    // Removed the geometric / hierarchical fallback — it was unreliable
    // on non-humanoid rigs (dragon wings, multi-leg creatures, tails…)
    // and placed markers at confusingly wrong positions. When name
    // matching gives 0 results we now just SHOW THE SKELETON via the
    // SkeletonHelper added in openLandmarksFullscreen and ask the user
    // to manually click each landmark button → bone, which is what they
    // wanted to do anyway.
    if (false && matched === 0) {
      // Pre-compute every bone world position once.
      const boneWorld = bones.map(b => {
        const p = new THREE.Vector3(); b.getWorldPosition(p); return { bone: b, pos: p };
      });
      // Identify roots (bone-parents of nothing OR root of the tree).
      const boneSet = new Set(bones);
      const roots = bones.filter(b => !b.parent || !boneSet.has(b.parent));
      // Pick the root closest to the model's geometric centerline.
      const rbox = new THREE.Box3().setFromObject(lmFsModel);
      const center = rbox.getCenter(new THREE.Vector3());
      center.y = rbox.min.y; // root lives near the base
      let root = roots[0] || bones[0];
      if (roots.length > 1) {
        let bestD = Infinity;
        for (const r of roots) {
          const wp = new THREE.Vector3(); r.getWorldPosition(wp);
          const d = wp.distanceTo(center);
          if (d < bestD) { bestD = d; root = r; }
        }
      }
      const rootPos = new THREE.Vector3(); root.getWorldPosition(rootPos);
      // Walk up the spine: from root, repeatedly pick the child whose
      // direction is most vertical (largest |delta.y|/delta.length).
      // Stops when we reach a bone with no children or non-vertical kids.
      const spine = [root];
      let cur = root;
      const visited = new Set([root]);
      while (cur.children && cur.children.length) {
        const childBones = cur.children.filter(c => c.isBone && boneSet.has(c) && !visited.has(c));
        if (!childBones.length) break;
        const curPos = new THREE.Vector3(); cur.getWorldPosition(curPos);
        let bestChild = null;
        let bestScore = -Infinity;
        for (const c of childBones) {
          const cp = new THREE.Vector3(); c.getWorldPosition(cp);
          const d = cp.clone().sub(curPos);
          const len = d.length();
          if (len < 1e-6) continue;
          const verticality = d.y / len; // 1 = straight up, -1 = down
          // Prefer up, but if root is below origin, accept slight side.
          if (verticality > bestScore) { bestScore = verticality; bestChild = c; }
        }
        if (!bestChild || bestScore < 0.3) break;
        spine.push(bestChild);
        visited.add(bestChild);
        cur = bestChild;
      }
      // Assign spine landmarks evenly along the chain.
      function placeAt(id, vec) {
        placeLandmarkMarker(id, vec, colorById[id] || '#ffffff');
        matched++;
      }
      const spinePos = spine.map(b => { const p = new THREE.Vector3(); b.getWorldPosition(p); return p; });
      if (spinePos.length >= 1) placeAt('hips', spinePos[0]);
      if (spinePos.length >= 2) placeAt('head', spinePos[spinePos.length - 1]);
      if (spinePos.length >= 3) placeAt('neck', spinePos[Math.floor(spinePos.length * 0.85)]);
      if (spinePos.length >= 4) placeAt('spine_top', spinePos[Math.floor(spinePos.length * 0.65)]);
      if (spinePos.length >= 5) placeAt('spine_mid', spinePos[Math.floor(spinePos.length * 0.4)]);

      // Find limb chains: walk children of each spine bone that
      // ARE NOT part of the spine itself.
      const limbs = [];
      for (const sb of spine) {
        const sChildren = (sb.children || []).filter(c => c.isBone && boneSet.has(c) && !visited.has(c));
        for (const c of sChildren) {
          // Walk the chain to its end.
          const chain = [c];
          let n = c;
          while (n.children && n.children.length) {
            const next = n.children.find(x => x.isBone && boneSet.has(x));
            if (!next) break;
            chain.push(next);
            n = next;
          }
          limbs.push(chain);
        }
      }
      // Sort limbs by total length descending (longer chains first =
      // probably the main limbs, not finger sub-chains).
      limbs.sort((a, b) => b.length - a.length);
      // Map first 4 long limbs to arms+legs, classified by Y direction
      // of their endpoint relative to their origin: end.y > origin.y →
      // arm (up/lateral); end.y < origin.y → leg (down).
      const armLefts = [], armRights = [], legLefts = [], legRights = [];
      for (const chain of limbs.slice(0, 6)) {
        const origin = new THREE.Vector3(); chain[0].getWorldPosition(origin);
        const end = new THREE.Vector3(); chain[chain.length - 1].getWorldPosition(end);
        const up = end.y >= origin.y;
        const left = end.x >= origin.x;
        if (up && left)  armLefts.push(chain);
        else if (up)     armRights.push(chain);
        else if (left)   legLefts.push(chain);
        else             legRights.push(chain);
      }
      function placeChain(chain, ids) {
        if (!chain || !chain.length) return;
        // Place markers at fixed fractions of the chain length.
        const wps = chain.map(b => { const p = new THREE.Vector3(); b.getWorldPosition(p); return p; });
        const fracs = ids.length === 3 ? [0, 0.5, 1] : ids.length === 4 ? [0, 0.4, 0.8, 1] : [];
        for (let i = 0; i < ids.length; i++) {
          const idx = Math.min(wps.length - 1, Math.round(fracs[i] * (wps.length - 1)));
          placeAt(ids[i], wps[idx]);
        }
      }
      placeChain(armLefts[0]  || limbs[2], ['shoulder_l', 'elbow_l', 'hand_l']);
      placeChain(armRights[0] || limbs[3], ['shoulder_r', 'elbow_r', 'hand_r']);
      placeChain(legLefts[0]  || limbs[0], ['hip_l', 'knee_l', 'ankle_l', 'foot_l']);
      placeChain(legRights[0] || limbs[1], ['hip_r', 'knee_r', 'ankle_r', 'foot_r']);
    }
    if (matched === 0) {
      // Non-humanoid rig (joint<N> / opaque names). Don't auto-place
      // markers — they end up confusingly off-bone. Just tell the
      // user to use the SkeletonHelper visible and place markers
      // manually by clicking each landmark button → bone.
      if (typeof showToast === 'function') {
        showToast(
          `${bones.length} bones detected but the rig uses opaque names (${bones.slice(0, 3).map(b => b.name).join(', ')}…). Click a landmark button on the right, then click on a bone to place it.`,
          'info', 8000,
        );
      }
      return;
    }
    if (typeof showToast === 'function') {
      showToast(`Imported ${matched} landmark(s) from rig (name-matched) — drag them to adjust, then click "Re-generate rig".`, 'success', 5000);
    }
  } catch (e) {
    console.error('[extractLandmarksFromRig]', e);
    customError('Failed to read the rig: ' + (e?.message || e), 'From rig');
  }
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
        // Snap to the CLOSEST bone if a rig is loaded — the user
        // is usually trying to target a specific bone visible via
        // the skeleton overlay. Without this, markers stick to the
        // mesh surface, sometimes far from the bone they meant.
        // Also remember WHICH bone we snapped to, so a future drag
        // can update that bone's position (direct rig editing).
        let placePt = pt;
        let snappedBone = null;
        try {
          const bones = [];
          model.traverse(c => {
            if (c.isBone) bones.push(c);
            else if (c.isSkinnedMesh && c.skeleton) {
              for (const b of c.skeleton.bones) if (!bones.includes(b)) bones.push(b);
            }
          });
          if (bones.length) {
            let bestBone = null;
            let best = null;
            let bestD = Infinity;
            const bp = new THREE.Vector3();
            for (const b of bones) {
              b.getWorldPosition(bp);
              const d = bp.distanceTo(pt);
              if (d < bestD) { bestD = d; best = bp.clone(); bestBone = b; }
            }
            if (best) {
              const bbox = new THREE.Box3().setFromObject(model);
              const sz = bbox.getSize(new THREE.Vector3()).length();
              if (bestD < sz * 0.125) { placePt = best; snappedBone = bestBone; }
            }
          }
        } catch (_) { /* fall through to raw pt */ }
        placeLandmarkMarker(lmActive, placePt, color);
        if (snappedBone && lmMarkers[lmActive]) {
          lmMarkers[lmActive].userData._linkedBone = snappedBone;
        }
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
      // If this marker is linked to an AI bone, move the bone.
      // Two modes (controlled by the "Freeze mesh" checkbox):
      //   - DEFORM  (unchecked): skinning follows bone → mesh warps.
      //                          Use when posing the model.
      //   - FREEZE  (checked, default): mesh stays put, bone moves
      //                          alone. Use when realigning bones to
      //                          a mesh that the AI got wrong.
      // Freeze works by recalculating the boneInverse for this bone:
      // new_inverse = inverse(new_world_matrix). The skinning formula
      // boneMatrix · boneInverse · vertex_bind then produces the same
      // vertex_world it did before the move → mesh appears unchanged.
      const linkedBone = marker.userData?._linkedBone;
      if (linkedBone && linkedBone.parent) {
        try {
          linkedBone.parent.updateMatrixWorld(true);
          const localPos = linkedBone.parent.worldToLocal(corrected.clone());
          linkedBone.position.copy(localPos);
          linkedBone.updateMatrixWorld(true);
          // Freeze the mesh: recompute boneInverse so skinning yields
          // the same world position the vertex had before the move.
          const freezeMesh = document.getElementById('lm-fs-freeze-mesh')?.checked;
          if (freezeMesh && lmFsModel) {
            lmFsModel.traverse((c) => {
              if (!c.isSkinnedMesh || !c.skeleton) return;
              const boneIdx = c.skeleton.bones.indexOf(linkedBone);
              if (boneIdx < 0) return;
              if (!c.skeleton.boneInverses[boneIdx]) return;
              const newInv = new THREE.Matrix4();
              newInv.copy(linkedBone.matrixWorld).invert();
              c.skeleton.boneInverses[boneIdx].copy(newInv);
            });
          }
        } catch (e) { /* ignore */ }
      }
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
  // Bright lighting — user reported the dragon was nearly invisible
  // with the previous defaults. Match the main 3D Mesh viewer rig.
  lmFsScene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.8));
  const dir = new THREE.DirectionalLight(0xffffff, 2.0);
  dir.position.set(5, 8, 5);
  lmFsScene.add(dir);
  const fill = new THREE.DirectionalLight(0xffffff, 1.0);
  fill.position.set(-5, 3, -5);
  lmFsScene.add(fill);
  const back = new THREE.DirectionalLight(0xffffff, 0.7);
  back.position.set(0, 5, -8);
  lmFsScene.add(back);
  lmFsScene.add(new THREE.AmbientLight(0xffffff, 0.6));
  // Pane A (Front by default)
  lmFsRenderer = new THREE.WebGLRenderer({ canvas: canvasA, antialias: true, alpha: true });
  lmFsRenderer.setPixelRatio(window.devicePixelRatio);
  lmFsRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  lmFsRenderer.toneMappingExposure = 1.4;
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
  // 2026-06-01: prefer the currently-selected RIG so the user can see
  // the AI-generated bones and drag the landmark markers exactly onto
  // them. Fall back to the source mesh if no rig exists yet.
  const p = state.currentProject;
  // Critical: only use rigSrcMeshPath if it belongs to the CURRENT
  // project — without this check it survives project-switches and
  // shows the wrong model.
  const rigSrcBelongsHere = rigSrcMeshPath
    && (p?.meshes || []).some(m => m.path === rigSrcMeshPath || m.url === rigSrcMeshPath);
  const rigPath = p?.selectedRigPath
               || (p?.rigs && p.rigs[0]?.url)
               || (p?.rigs && p.rigs[0]?.path);
  const meshPath = (rigSrcBelongsHere ? rigSrcMeshPath : null)
                || p?.selectedMeshPath
                || (p?.meshes && p.meshes[0]?.path);
  const sourcePath = rigPath || meshPath;
  if (!sourcePath) {
    customError('Generate a mesh or rig first.', 'Manual landmarks');
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
    // 2026-06-01: visualise the AI-generated bone chains over the
    // mesh so the user can drag landmark markers onto them.
    // Use a custom rendering (spheres + thick cylinder bones) instead
    // of THREE.SkeletonHelper because WebGL2 ignores material.linewidth
    // so the helper's LineSegments rendered as 1px-wide lines that were
    // invisible against the dark dragon.
    try {
      lmFsModel.updateMatrixWorld(true);
      const bones = [];
      obj.traverse((c) => {
        if (c.isBone) bones.push(c);
        else if (c.isSkinnedMesh && c.skeleton) {
          for (const b of c.skeleton.bones) if (!bones.includes(b)) bones.push(b);
        }
      });
      if (bones.length) {
        const overlay = new THREE.Group();
        overlay.renderOrder = 998;
        // Size sphere/cylinder relative to model bbox.
        const tmpBox = new THREE.Box3().setFromObject(lmFsModel);
        const sz = tmpBox.getSize(new THREE.Vector3()).length();
        const dotR = sz * 0.008;
        const linR = sz * 0.0035;
        const sphereGeo = new THREE.SphereGeometry(dotR, 8, 8);
        const matJoint = new THREE.MeshBasicMaterial({
          color: 0xff00ff, depthTest: false, transparent: true, opacity: 1.0,
        });
        const matBone = new THREE.MeshBasicMaterial({
          color: 0x00ffd0, depthTest: false, transparent: true, opacity: 0.9,
        });
        // Pre-compute world positions.
        const wp = new Map();
        for (const b of bones) {
          const p = new THREE.Vector3(); b.getWorldPosition(p); wp.set(b, p);
        }
        // Joint dots
        for (const b of bones) {
          const dot = new THREE.Mesh(sphereGeo, matJoint);
          dot.position.copy(wp.get(b));
          dot.renderOrder = 999;
          overlay.add(dot);
        }
        // Bone lines as thin cylinders between parent and child bones.
        for (const child of bones) {
          if (!child.parent || !wp.has(child.parent)) continue;
          const a = wp.get(child.parent), c = wp.get(child);
          const dir = new THREE.Vector3().subVectors(c, a);
          const len = dir.length();
          if (len < 1e-5) continue;
          const cyl = new THREE.Mesh(
            new THREE.CylinderGeometry(linR, linR, len, 6),
            matBone,
          );
          cyl.position.copy(a).add(dir.clone().multiplyScalar(0.5));
          cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
          cyl.renderOrder = 998;
          overlay.add(cyl);
        }
        lmFsScene.add(overlay);
        lmFsModel.userData._skelOverlay = overlay;
        console.log('[lm] custom skeleton overlay added —', bones.length, 'bones');
      } else {
        console.warn('[lm] no bones found in model — no skeleton overlay');
      }
    } catch (e) { console.warn('[lm] skeleton overlay failed:', e); }
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
      const url = _toFileUrl(sourcePath);
      new FBXLoader().load(url, fitFs, undefined, (err) => console.error('FBX load failed', err));
    } else {
      const buffer = await API.readMeshFile(sourcePath);
      if (!buffer) return;
      new GLTFLoader().parse(buffer, '', (gltf) => fitFs(gltf.scene));
    }
  } catch (e) { console.error('openLandmarksFullscreen', e); }
  // Build the side list of landmark buttons
  buildLmFsList();
  // Auto-extract landmarks from the selected rig (if any) on the
  // first open of this session. Only runs if no markers have been
  // placed yet — avoids stomping the user's manual edits when they
  // re-open the modal mid-tweak.
  const hasExistingMarkers = Object.keys(lmMarkers).length > 0;
  const hasRig = !!(state.currentProject?.selectedRigPath
                 || (state.currentProject?.rigs && state.currentProject.rigs[0]));
  if (!hasExistingMarkers && hasRig) {
    // Slight delay so the canvases are sized and the fit transform
    // settled before we read bone world positions.
    setTimeout(() => {
      try { extractLandmarksFromRig(); }
      catch (e) { console.warn('[lm] auto-extract from rig failed:', e); }
    }, 200);
  }
}

// Currently-active landmark schema. Defaults to the static humanoid
// LM_SCHEMA; replaced by buildDynamicLmSchema() in extractLandmarksFromRig
// when a non-humanoid topology is detected.
let _activeLmSchema = LM_SCHEMA;

function buildLmFsList() {
  const list = document.getElementById('lm-fs-list');
  if (!list) return;
  list.innerHTML = '';
  _activeLmSchema.forEach(group => {
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
document.getElementById('lm-fs-from-rig')?.addEventListener('click', () => {
  extractLandmarksFromRig();
});
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
      'Quit MyFabmesh.AI',
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
