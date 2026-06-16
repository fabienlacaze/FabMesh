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
} catch (_) {}

// ============================================================
// CUSTOM CONFIRM MODAL (replaces window.confirm)
// ============================================================
// Map engine value (from <select>) to a human-readable label showing the
// real underlying model. Legacy IDs (sf3d, local) are rerouted by
// main.js to trellis2_native — labels kept for backward display on old
// saved projects but the wording reflects the actual fallback.
const ENGINE_LABELS = {
  // Image engines
  'local-flux':     'MyFabmesh.AI Image Engine (local)',
  // 3D engines — sf3d / local legacy IDs are silently rerouted to
  // the native engine at dispatch.
  'sf3d':           'MyFabmesh.AI 3D Native (rerouted)',
  'local':          'MyFabmesh.AI 3D Native (rerouted)',
  'trellis2_native':'MyFabmesh.AI 3D Native',
  'trellis':        'MyFabmesh.AI 3D Engine',
  // Rigging engine labels (user-visible in job details)
  'puppeteer':      'MyFabmesh.AI Rig',
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
  // Content-filter block → offer a direct "Unlock" shortcut straight to the
  // parental-control disable flow (legal warning popup + PIN) instead of making
  // the user hunt through Settings. The action button reuses customErrorWithAction.
  if (/content filter|parental control|unrestricted mode/i.test(raw)) {
    customErrorWithAction(raw, title || 'Blocked by content filter', '🔓 Unlock')
      .then((unlock) => {
        // Let the shared modal fully close/reset before the warning re-opens it,
        // then unlock AND re-run the blocked operation.
        if (unlock) setTimeout(() => { _unlockThenRetry(); }, 60);
      });
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

// Offer to unlock the content filter when a dropped/imported image is flagged
// NSFW, instead of silently blocking it. Runs the same parental toggle + PIN
// flow as the New Project popup. Returns true if content is (now) unrestricted.
async function _nsfwBlockedUnlock(reloadFn) {
  try {
    const ps = API.getParentalStatus ? await API.getParentalStatus() : null;
    if (ps && ps.unrestricted) return true;
  } catch (_) {}
  const ok = await customConfirm(
    'This image was flagged by the content filter (NSFW). Unlock the content filter to keep and use it?',
    'Content blocked', 'Unlock'
  );
  if (!ok) return false;
  try { await toggleParentalControl(); } catch (_) {}
  try {
    const ps2 = API.getParentalStatus ? await API.getParentalStatus() : null;
    if (ps2 && ps2.unrestricted) { if (reloadFn) await reloadFn(); return true; }
  } catch (_) {}
  return false;
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

// Lightweight text-input modal (customConfirm has no input). Self-contained —
// builds its own DOM so no index2.html change is needed. Resolves to the
// trimmed string on OK / Enter, or null on Cancel / Escape / overlay click.
// `validate(value)` (optional) returns an error string to show INLINE (popup
// stays open) or null/'' to accept. May be async.
function customPrompt(message, defaultValue = '', title = 'Rename', okLabel = 'Save', validate = null) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--panel,#1a1a24);border:1px solid var(--border,#333);border-radius:10px;padding:18px 20px;width:min(420px,90vw);box-shadow:0 10px 40px rgba(0,0,0,0.5);';
    box.innerHTML = `
      <div style="font-size:14px;font-weight:600;color:var(--text-1,#eee);margin-bottom:8px;">${title}</div>
      <div style="font-size:12px;color:var(--text-2,#aaa);margin-bottom:10px;">${message}</div>
      <input type="text" class="cp-input" style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:6px;border:1px solid var(--border,#444);background:#0e0e16;color:#fff;font-size:13px;" />
      <div class="cp-error" style="display:none;color:#ff6b6b;font-size:11.5px;margin-top:7px;"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">
        <button class="cp-cancel" style="padding:6px 14px;border-radius:6px;border:1px solid var(--border,#444);background:transparent;color:#ccc;cursor:pointer;font-size:12px;">Cancel</button>
        <button class="cp-ok" style="padding:6px 14px;border-radius:6px;border:none;background:linear-gradient(90deg,#e0457b,#9b5de5);color:#fff;cursor:pointer;font-size:12px;font-weight:600;">${okLabel}</button>
      </div>`;
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const input = box.querySelector('.cp-input');
    const errorEl = box.querySelector('.cp-error');
    input.value = defaultValue || '';
    const cleanup = (val) => { try { document.body.removeChild(overlay); } catch (_) {} document.removeEventListener('keydown', onKey); resolve(val); };
    const onOk = async () => {
      const val = (input.value || '').trim();
      if (validate) {
        let err = null;
        try { err = await validate(val); } catch (_) {}
        if (err) { errorEl.textContent = err; errorEl.style.display = 'block'; input.focus(); input.select(); return; }
      }
      cleanup(val);
    };
    const onCancel = () => cleanup(null);
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); else if (e.key === 'Enter') onOk(); };
    // Clear the inline error as soon as the user edits the field.
    input.addEventListener('input', () => { errorEl.style.display = 'none'; });
    box.querySelector('.cp-ok').addEventListener('click', onOk);
    box.querySelector('.cp-cancel').addEventListener('click', onCancel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) onCancel(); });
    document.addEventListener('keydown', onKey);
    setTimeout(() => { input.focus(); input.select(); }, 50);
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
    document.getElementById('breadcrumb').textContent =
      (state.currentProject?.displayName || state.currentProject?.name) || '';
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
  // 2026-06-13: scan meshes/animated/ so persisted Rokoko outputs come
  // back into the project model after a refresh. Each animation's
  // rigStem (= the target GLB basename without extension) lets us
  // attribute the clip back to its source rig later in this function.
  const animsOnDisk = (await API.listAnimations?.()) || [];

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
    const POST_SUFFIX = /_(cntile|retexture|decimate|subdivide|smooth|fill_holes|fix_normals|center|set_pivot|watertight|texture_var|trellis2_retex|upscale|refine|augment|vc)(?:_[A-Za-z0-9]{1,16})*$/i;
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

  // Dedupe per-project lists by their URL/path/filename so the same
  // file never appears twice in a strip. Belt-and-braces against the
  // multi-phase main-process enumeration.
  // 2026-06-02: keyless items (computed key falsy because the record
  // came back skeleton-shaped from the main-process enumerator before
  // its url/path/filename was filled in) are PRESERVED, not dropped.
  // The old `if (!k || seen.has(k)) continue;` silently hid mesh/rig
  // records the user expected to see; now we only dedupe when we have
  // a real key.
  function _dedupeBy(arr, keyFn) {
    const seen = new Set();
    const out = [];
    for (const x of (arr || [])) {
      const k = keyFn(x);
      if (k) {
        if (seen.has(k)) continue;
        seen.add(k);
      }
      out.push(x);
    }
    return out;
  }
  // 2026-06-13: attribute each on-disk animation to its source rig's
  // project. The animation filename layout is
  // `${motionStem}__${rigStem}.glb` (rokoko_batch_retarget.py:997), so
  // matching p.rigs[i].filename's basename to the animation's rigStem
  // bucket-sorts the clips back to their projects.
  for (const a of animsOnDisk) {
    if (!a.rigStem) continue;
    for (const p of projectsMap.values()) {
      const hit = (p.rigs || []).some(r => {
        const rBase = (r.filename || '').replace(/\.[^.]+$/, '');
        return rBase === a.rigStem;
      });
      if (hit) {
        p.animations.push({
          id: a.filename,
          batchId: a.filename,  // each on-disk file is its own batch
          type: a.type,
          filename: a.filename,
          path: a.path,
          url: a.url,
          motionId: a.motionStem,
          motionLabel: a.motionStem.replace(/^ANIM_/, '').replace(/_/g, ' '),
          created: a.created,
          mtime: a.mtime,
        });
        break;
      }
    }
  }

  for (const p of projectsMap.values()) {
    p.meshes = _dedupeBy(p.meshes, m => (m.url || m.path || m.filename || '').toLowerCase());
    p.rigs   = _dedupeBy(p.rigs,   r => (r.url || r.path || r.filename || '').toLowerCase());
    p.animations = _dedupeBy(p.animations, a => (a.url || a.path || a.filename || '').toLowerCase());
    p.images = _dedupeBy(p.images, im => (typeof im === 'string' ? im : im?.path || '').toLowerCase());
    // 2026-06-13: factor in rigs and animations into latestTimestamp so
    // a project that was just animated bubbles up to the top of the
    // grid, not just on the most-recent mesh generation.
    const candidates = [
      ...p.meshes.map(m => m.mtime || (m.created && new Date(m.created).getTime()) || 0),
      ...p.rigs.map(r => r.mtime || (r.created && new Date(r.created).getTime()) || 0),
      ...p.animations.map(a => a.mtime || (a.created && new Date(a.created).getTime()) || 0),
    ].filter(Boolean);
    if (candidates.length) {
      const maxTs = Math.max(...candidates);
      if (maxTs > p.latestTimestamp) p.latestTimestamp = maxTs;
    }
  }

  state.projects = Array.from(projectsMap.values()).sort((a, b) => b.latestTimestamp - a.latestTimestamp);
  // Apply user display-name overrides (project rename) without touching files.
  try {
    const _dn = (await API.getProjectDisplayNames?.()) || {};
    for (const _p of state.projects) _p.displayName = _dn[_p.name] || null;
  } catch (_) {}
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
  // 4. Check the displayed THUMBNAIL too — covers mesh-only projects (0
  //    images) whose card thumb is a NSFW source image, which the images[]
  //    checks above would otherwise miss.
  if (p.thumb) {
    const tname = String(p.thumb).split(/[/\\]/).pop();
    if (_nsfwScanCache[tname]) return true;
    if (API.checkImagesNsfwTags) {
      try {
        const tags = await API.checkImagesNsfwTags({ images: [String(p.thumb)] });
        if (tags && tags[String(p.thumb)]) return true;
      } catch (_) {}
    }
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
    if (resp && typeof resp === 'object') {
      // Accept BOTH wrapped { results: [...] } and bare object/array.
      // The pre-fix bug iterated Object.entries(resp) and read 'ok' /
      // 'results' as paths, flagging random projects as NSFW.
      let changed = false;
      if (Array.isArray(resp) || Array.isArray(resp.results)) {
        const items = Array.isArray(resp) ? resp : resp.results;
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
      } else {
        // Legacy { path: bool } map — keep working for desktop's IPC.
        for (const [imgPath, nsfw] of Object.entries(resp)) {
          // Defensive: skip wrapper-style keys.
          if (imgPath === 'ok' || imgPath === 'results') continue;
          const fname = imgPath.split(/[/\\]/).pop();
          _nsfwScanCache[fname] = !!nsfw;
          if (nsfw) { changed = true; console.log('[NSFW] BLOCKED:', fname, imgPath); }
        }
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
 * Home view toggle — Projects / Images / Meshes
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

// 2026-06-02: delegate to _toFileUrl to fix encoding gap. Earlier the
// home Images grid (renderAllImagesGrid -> _imgSrcHome) skipped
// encodeURI, so projects with a space/'#'/'?' in their name rendered
// broken <img>s on home but worked everywhere else (workspace lightbox,
// etc. all routed through _toFileUrl). Also covers 'file:' pass-through
// which the old regex was missing. Hoisting makes the forward reference
// safe — both are top-level function declarations.
function _imgSrcHome(path) {
  return _toFileUrl(path);
}

// Universal path-to-URL helper. Desktop renderer almost always receives
// bare filesystem paths ('C:\\Users\\...\\img.png') and needs the
// file:/// prefix + back-slash normalization + URL-encoding of
// reserved characters (spaces, #, ?). The cloud bundle defines the
// same helper at the same name. Any caller that may already hold an
// https/file/blob/data URL is passed through untouched.
//
// 2026-06-02 — added to fix two references in this file (showAnimSourceRig +
// _toFileUrl callsites in cross-feature inpaint + lightbox paths) that
// otherwise threw a ReferenceError. Exposed on window for classic-script
// helpers (index2-edit-tools.js) to share.
function _toFileUrl(path) {
  if (!path) return '';
  const s = String(path);
  // Already a real URL (http(s), file, data, blob) -> return as-is.
  // Without this guard the file:/// prefix concatenates to
  // 'file:///https://...' which the browser rejects with
  // "Not allowed to load local resource".
  if (/^(?:https?|blob|data|file):/i.test(s)) return s;
  // Normalize back-slashes (Windows) to forward slashes for the URL.
  const fwd = s.replace(/\\/g, '/');
  // URL-encode each path segment so spaces, '#', '?', etc. don't
  // break the <img>/three.js loader. Don't touch the ':' after the
  // drive letter ("C:") — encodeURI leaves it alone.
  return 'file:///' + encodeURI(fwd);
}
window._toFileUrl = _toFileUrl;

// Unified viewer-loading spinner overlay. Works on a CONTAINER id —
// creates/removes a position:absolute overlay with the spinner CSS
// classes. Idempotent; safe to call repeatedly. msg defaults to "Loading…".
// Mirrors the cloud helper (cloud/public/app/index2.js — d5798ea wired
// it to step1, ws-3d-source-preview, ws-rig-source-preview, and
// ws-anim-source-preview); ported here so desktop has the same UX
// feedback during slow mesh / image loads.
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
window.setViewerLoading = setViewerLoading;

function renderAllImagesGrid() {
  const grid = document.getElementById('all-images-grid');
  if (!grid) return;
  const items = [];
  for (const p of state.projects || []) {
    for (const img of (p.images || [])) {
      items.push({ project: p, path: img.path || img });
    }
  }
  if (!items.length) {
    grid.innerHTML = '<div style="grid-column:1/-1; color:var(--text-2); text-align:center; padding:40px;">No images yet.</div>';
    return;
  }
  grid.innerHTML = items.map((it) => `
    <div class="project-card" style="cursor:pointer;" data-project="${escapeHtml(it.project.name)}">
      <div class="project-card-thumb">
        <img src="${escapeHtml(_imgSrcHome(it.path))}" alt="" loading="lazy">
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

// Lazy three.js mesh thumbnail. Spins up a tiny scene + GLTFLoader the
// first time the card scrolls into view (IntersectionObserver), then
// renders ONE frame and disposes the renderer. With 500+ meshes a
// per-card animation loop would melt the GPU; a single static frame is
// enough to identify the asset.
function _mountMeshThumb(card, url) {
  if (!card || !url || card.dataset.thumbMounted) return;
  card.dataset.thumbMounted = '1';
  const slot = card.querySelector('.mesh-thumb-slot');
  if (!slot) return;
  const w = slot.clientWidth || 240;
  const h = slot.clientHeight || 200;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(w, h, false);
  renderer.setClearColor(0x0a0a0e, 1);
  slot.innerHTML = '';
  slot.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, w / h, 0.1, 200);
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const dir = new THREE.DirectionalLight(0xffffff, 1.1);
  dir.position.set(2, 3, 2);
  scene.add(dir);
  const loader = new GLTFLoader();
  loader.load(url, (gltf) => {
    const root = gltf.scene;
    scene.add(root);
    // Frame the model — bbox center to origin, scale to unit, camera back.
    const bbox = new THREE.Box3().setFromObject(root);
    const size = bbox.getSize(new THREE.Vector3());
    const center = bbox.getCenter(new THREE.Vector3());
    root.position.sub(center);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const fitDist = (maxDim / 2) / Math.tan((camera.fov * Math.PI) / 360);
    camera.position.set(fitDist * 0.9, fitDist * 0.7, fitDist * 1.4);
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
    // Free GPU memory after the single frame.
    renderer.dispose();
  }, undefined, (e) => {
    console.warn('[mesh-thumb] load failed:', url, e);
    slot.innerHTML = '<div style="height:100%; display:flex; align-items:center; justify-content:center; color:var(--text-2); font-size:32px;">🧊</div>';
  });
}

let _meshThumbObserver = null;
function _initMeshThumbObserver() {
  if (_meshThumbObserver) return;
  _meshThumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        const card = e.target;
        const url = card.dataset.meshUrl;
        if (url) _mountMeshThumb(card, url);
        _meshThumbObserver.unobserve(card);
      }
    }
  }, { rootMargin: '200px' });
}

// Pagination — 24 meshes per page. Each mesh triggers a WebGL context
// (one per card via three.js); browsers cap around 16 contexts so we
// render in chunks instead of all 500 at once. The "Load more" button
// at the bottom extends the visible window by another 24.
const MESH_PAGE_SIZE = 24;
let _meshPageSize = MESH_PAGE_SIZE;

function _renderMeshCardsHtml(items) {
  return items.map((it) => {
    const url = it.mesh.url || it.mesh.path || '';
    const fname = String(it.mesh.filename || url).split(/[\\/]/).pop();
    const fileUrl = /^(?:https?|file|blob|data):/i.test(url)
      ? url
      : 'file:///' + String(url).replace(/\\/g, '/');
    return `
      <div class="project-card" style="cursor:pointer; padding:8px;" data-project="${escapeHtml(it.project.name)}" data-mesh-url="${escapeHtml(fileUrl)}">
        <div style="font-size:13px; font-weight:600; padding:4px 4px 6px;">${escapeHtml(it.project.name)}</div>
        <div class="mesh-thumb-slot" style="height:200px; background:#0a0a0e; border-radius:6px; overflow:hidden; display:flex; align-items:center; justify-content:center; color:var(--text-2); font-size:14px;">Loading…</div>
        <div class="project-card-meta" style="font-size:11px; padding:6px 4px 0;">${escapeHtml(fname)}</div>
      </div>
    `;
  }).join('');
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
  _initMeshThumbObserver();
  // Reset paging whenever the project list changes underneath us.
  if (_meshPageSize > items.length) _meshPageSize = MESH_PAGE_SIZE;
  const visible = items.slice(0, _meshPageSize);
  const remaining = items.length - visible.length;
  const loadMoreHtml = remaining > 0
    ? `<div id="mesh-load-more" style="grid-column:1/-1; display:flex; justify-content:center; padding:16px;">
         <button class="primary-btn" style="padding:10px 24px;">Load ${Math.min(MESH_PAGE_SIZE, remaining)} more (${remaining} remaining)</button>
       </div>`
    : (items.length > MESH_PAGE_SIZE
        ? `<div style="grid-column:1/-1; color:var(--text-2); text-align:center; padding:12px; font-size:12px;">All ${items.length} meshes loaded.</div>`
        : '');
  grid.innerHTML = _renderMeshCardsHtml(visible) + loadMoreHtml;
  grid.querySelectorAll('[data-project]').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.tagName === 'CANVAS') return;
      const name = el.dataset.project;
      const p = (state.projects || []).find((x) => x.name === name);
      if (p) openProject(p);
    });
    _meshThumbObserver.observe(el);
  });
  const loadMoreBtn = grid.querySelector('#mesh-load-more button');
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', () => {
      _meshPageSize += MESH_PAGE_SIZE;
      renderAllMeshesGrid();
    });
  }
}

// Desktop sibling of the cloud renderAllRigsGrid — same shape, walks the
// per-project p.rigs[] array. Click opens the project.
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
          ? `<img src="file:///${p.thumb.replace(/\\/g, '/')}" alt="${p.name}">`
          : `<span class="project-card-thumb-empty">No image</span>`}
      </div>
      <div class="project-card-body">
        <div class="project-card-name" style="display:flex;align-items:center;">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(p.displayName || p.name)}</span>
          <button class="card-rename-btn" title="Rename project">&#9998;</button>
        </div>
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
    card.querySelector('.card-rename-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const _sanitizeProj = (s) => String(s || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 40).replace(/_+\d+$/, '').replace(/_+$/, '');
      const validate = (val) => {
        const np = _sanitizeProj(val);
        if (!np) return 'Please enter a valid name.';
        if (np === p.name) return null;  // same project — no-op, allowed
        if (state.projects.some(pr => pr && pr.name === np))
          return `A project named "${np}" already exists — choose a different name.`;
        return null;
      };
      const newName = await customPrompt(
        'New project name — renames the image folder + every mesh / rig / animation file on disk:',
        p.name, 'Rename project', 'Rename', validate);
      if (newName === null || !newName.trim() || newName.trim() === p.name) return;
      const r = await API.renameProjectFiles({ oldName: p.name, newName });
      if (r?.success) {
        const c = r.renamed || {};
        showToast?.(`Renamed to "${r.newName}" — ${(c.meshes||0)+(c.rigs||0)} mesh/rig, ${c.folders||0} folder, ${c.anims||0} anim, ${c.sidecars||0} sidecar files`, 'success', 3500);
        if (state.currentProject?.name === p.name) state.currentProject = null;
        await refreshProjectsPage();
      } else {
        showToast?.('Rename failed: ' + (r?.error || 'unknown'), 'error', 5000);
      }
    });
    card.querySelector('.card-delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!await customConfirm(`Delete project "${p.displayName || p.name}" and all its files?`, 'Delete project')) return;
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
  // Sync the alternate home views with fresh project data.
  if (_homeView === 'images') renderAllImagesGrid();
  else if (_homeView === 'meshes') renderAllMeshesGrid();
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
  // Drop-to-create: suggest a project name from the dropped filename.
  const _pf = window.__pendingDroppedFile;
  if (_pf && _pf.fileName) {
    document.getElementById('np-name').value = _pf.fileName.replace(/\.[^.]+$/, '').slice(0, 40);
  }
  document.getElementById('modal-new-project').classList.remove('hidden');
  setTimeout(() => { const el = document.getElementById('np-name'); if (el) { el.focus(); if (el.select) el.select(); } }, 50);
}
function closeNewProjectModal() {
  document.getElementById('modal-new-project').classList.add('hidden');
}
document.getElementById('btn-new-project').addEventListener('click', () => { window.__pendingDroppedFile = null; openNewProjectModal(); });
// Unlock from the New Project popup: run the legal-warning + PIN flow, then if
// the user is now unrestricted, retry creating the project automatically.
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
document.getElementById('np-cancel').addEventListener('click', () => { window.__pendingDroppedFile = null; closeNewProjectModal(); });
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

  // Drop-to-create: the user dropped a file on the projects grid and just NAMED
  // the project here. Import the file into the freshly-named project instead of
  // creating an empty shell, with an NSFW unlock affordance if it's flagged.
  if (window.__pendingDroppedFile) {
    const pf = window.__pendingDroppedFile;
    window.__pendingDroppedFile = null;
    let r;
    try { r = await API.importDroppedFile({ filePath: pf.filePath, projectName: name }); }
    catch (e) { r = { success: false, error: e?.message || String(e) }; }
    if (!r || !r.success) { showToast?.('Import failed: ' + (r?.error || 'unknown'), 'error', 4000); return; }
    if (r.kind === 'image' && r.path && API.batchCheckNsfw) {
      try {
        const nsfw = await API.batchCheckNsfw({ images: [r.path] });
        if (nsfw && nsfw[r.path]) await _nsfwBlockedUnlock(null);
      } catch (_) {}
    }
    const openName = r.projectName || name;
    try {
      if (typeof window.openProjectByName === 'function') await window.openProjectByName(openName);
      else await refreshProjectsPage();
    } catch (_) { try { await refreshProjectsPage(); } catch (_) {} }
    showToast?.('Project created from dropped file', 'success', 1800);
    return;
  }

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
    'ws-trellis2-rectify':      false,  // OFF: rectifier distorts swept wings + long fuselage proportions
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
  // Per-category "Other …" types mirror their category's checkbox profile.
  other_living: {   // like creature
    'ws-trellis2-rectify':      true,
    'ws-trellis2-smooth':       false,
    'ws-trellis2-refine':       true,
    'ws-trellis2-quality-plus': true,
    'ws-trellis2-ultra-q':      true,
    'ws-trellis2-ultra-hd':     true,
    'ws-trellis2-face-fix':     true,
  },
  other_vehicle: {  // like vehicle (refine OFF on smooth surfaces)
    'ws-trellis2-rectify':      true,
    'ws-trellis2-smooth':       true,
    'ws-trellis2-refine':       null,
    'ws-trellis2-quality-plus': true,
    'ws-trellis2-ultra-q':      null,
    'ws-trellis2-ultra-hd':     true,
    'ws-trellis2-face-fix':     null,
  },
  other_built: {    // like building
    'ws-trellis2-rectify':      true,
    'ws-trellis2-smooth':       true,
    'ws-trellis2-refine':       true,
    'ws-trellis2-quality-plus': true,
    'ws-trellis2-ultra-q':      null,
    'ws-trellis2-ultra-hd':     true,
    'ws-trellis2-face-fix':     null,
  },
  other_item: {     // like prop
    'ws-trellis2-rectify':      true,
    'ws-trellis2-smooth':       true,
    'ws-trellis2-refine':       true,
    'ws-trellis2-quality-plus': true,
    'ws-trellis2-ultra-q':      null,
    'ws-trellis2-ultra-hd':     true,
    'ws-trellis2-face-fix':     null,
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

// 2026-06-14: gate "Ultra Quality (1536_cascade)" by available system RAM.
// 1536_cascade peaks at ~27 GB RAM (8 models stay resident ~15 GB + ~8 GB
// for the high-res SLat pass + ~3 GB export). 2026-06-15: bumped the gate
// 24 → 32 GB. A 27 GB machine has a 27 GB PEAK with ZERO headroom → it
// saturates RAM, swaps, and the pipeline OOM-crashes (user hit exactly this
// on a 27 GB box: tank gen failed). You need peak + OS/Electron headroom
// (~5-6 GB), i.e. 32 GB+, to run 1536 safely; below that we DISABLE Ultra and
// silently keep Quality+ (1024_cascade, ~19 GB peak, safe). main.js applies
// the same guard server-side (belt + suspenders).
// Heaviest cascade peak (GB system RAM) per mode + the budget headroom it
// needs. The RAM slider (Settings) sets a *budget* = physicalRAM × ram% ; we
// only let the UI offer a cascade mode whose peak fits that budget, so the box
// never saturates. Lower the slider → tighter budget → lighter mode chosen.
const ULTRA_Q_MIN_RAM_GB   = 32;   // 1536_cascade peaks ~27 GB + OS/Electron headroom
const QUALITY_PLUS_MIN_RAM = 21;   // 1024_cascade peaks ~19 GB + headroom
let _cachedTotalRamGB = null;
// Compute the current RAM budget (GB) from physical RAM × the slider %.
// gpuLimits is defined by the time this runs (callers either await checkRAM
// first, deferring past module-eval, or fire after the slider exists).
function _currentRamBudgetGB() {
  if (_cachedTotalRamGB == null) return null;
  let ramPct = 85;
  try { if (gpuLimits && typeof gpuLimits.ram === 'number') ramPct = gpuLimits.ram; } catch (_) {}
  return _cachedTotalRamGB * (ramPct / 100);
}
function _gateCascadeRow(el, ok, title) {
  if (!el) return;
  el.disabled = !ok;
  if (!ok) el.checked = false;
  const row = el.closest('.form-row') || el.closest('label');
  if (row) { row.style.opacity = ok ? '' : '0.5'; row.title = ok ? '' : title; }
}
async function gateUltraQualityByRAM() {
  try {
    const ultra = document.getElementById('ws-trellis2-ultra-q');
    const qplus = document.getElementById('ws-trellis2-quality-plus');
    if (!ultra && !qplus) return;
    if (_cachedTotalRamGB == null) {
      if (!API.checkRAM) return;
      const ram = await API.checkRAM();
      _cachedTotalRamGB = (ram && ram.totalGB) ? ram.totalGB : null;
    }
    const budgetGB = _currentRamBudgetGB();
    if (budgetGB == null) return;
    const bTxt = `${budgetGB.toFixed(0)} GB`;
    // Ultra (1536_cascade) — needs the largest budget.
    _gateCascadeRow(ultra, budgetGB >= ULTRA_Q_MIN_RAM_GB,
      `Ultra Quality (1536) nécessite un budget RAM ≥ ${ULTRA_Q_MIN_RAM_GB} GB. ` +
      `Budget actuel : ${bTxt}. Monte le curseur RAM (Réglages) ou ajoute de la RAM.`);
    // Quality+ (1024_cascade) — below this we fall back to the base mode.
    _gateCascadeRow(qplus, budgetGB >= QUALITY_PLUS_MIN_RAM,
      `Quality+ (1024) nécessite un budget RAM ≥ ${QUALITY_PLUS_MIN_RAM} GB. ` +
      `Budget actuel : ${bTxt} → mode de base (le plus léger).`);
    // If Ultra is locked out but Quality+ is still available, fall back to it.
    if (ultra && ultra.disabled && qplus && !qplus.disabled && !qplus.checked) {
      qplus.checked = true;
    }
  } catch (e) { console.warn('gateUltraQualityByRAM failed', e); }
}

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
  // Re-apply the RAM gate AFTER the profile so a low-RAM machine never ends
  // up with Ultra Quality re-checked by the asset profile.
  try { gateUltraQualityByRAM(); } catch (_) {}
}
(function _wireAssetOptionsProfile() {
  const sel = document.getElementById('ws-asset-type');
  if (!sel) return;
  sel.addEventListener('change', () => _applyAssetOptionsProfile(sel.value));
  // Apply once on initial render so the default character profile takes effect.
  _applyAssetOptionsProfile(sel.value || 'character');
})();

// Each step has a single fixed engine, so don't show the ENGINE field at all —
// the user never changes it. We KEEP the hidden <select> in the DOM (the
// generators still read its .value) and just hide the label + static display.
(function _hideFixedEngineFields() {
  ['ws-engine', 'ws-3d-engine', 'ws-rig-engine', 'mod-engine'].forEach((id) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const row = sel.closest('.form-row');
    if (row) { row.style.display = 'none'; return; }
    // Modal case (no .form-row): hide the static box + the label right before it.
    const stat = sel.previousElementSibling;
    if (stat && stat.classList && stat.classList.contains('engine-static')) stat.style.display = 'none';
    const lbl = stat ? stat.previousElementSibling : null;
    if (lbl && lbl.tagName === 'LABEL') lbl.style.display = 'none';
  });
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
    // Also re-pick a default skeleton when the user changes asset_type
    // (unless they have already pinned a custom rigTarget for this project).
    sel.addEventListener('change', () => {
      try {
        if (state && state.currentProject) {
          // Clear any auto-picked default so populateRigSkeletonDropdown
          // recomputes from the NEW asset_type. We only clear if the
          // current rigTarget matches what the OLD asset_type would have
          // produced — otherwise we respect the user's explicit pick.
          if (typeof populateRigSkeletonDropdown === 'function') {
            populateRigSkeletonDropdown();
          }
        }
      } catch (_) {}
    });
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
  // 2026-06-13: reset the Step 4 EDIT SELECTED viewer when switching
  // projects so the previously-selected animation (from another
  // project) doesn't leak into the new project's canvas.
  try {
    _selectedAnim = null;
    if (_animViewer) { try { _animViewer.cleanup(); } catch (_) {} _animViewer = null; }
    const ph = document.getElementById('ws-anim-preview-placeholder');
    if (ph) ph.style.display = '';
    const canv = document.getElementById('ws-anim-result-canvas');
    if (canv) {
      const ctx = canv.getContext('2d');
      if (ctx) { ctx.clearRect(0, 0, canv.width, canv.height); }
    }
    const fn = document.getElementById('ws-anim-filename');
    if (fn) fn.textContent = '';
  } catch (_) {}
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
      { id: 'step-card-image',     has: (p.images     && p.images.length     > 0) },
      { id: 'step-card-mesh',      has: (p.meshes     && p.meshes.length     > 0) },
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
  const btnImg = document.getElementById('ws-generate-image');
  if (btnImg) btnImg.textContent = p.images.length > 0 ? 'Generate new version' : 'Generate';
  const btnMesh = document.getElementById('ws-generate-mesh');
  if (btnMesh) {
    btnMesh.disabled = !p.selectedImagePath;
    btnMesh.textContent = p.meshes.length > 0 ? 'Generate new 3D version' : 'Generate 3D';
  }
  // 2026-06-14: append the option-aware time estimate to every Generate
  // button (image/mesh/rig/anim), like cloud credits.
  try { _updateGenButtonsEstimate?.(); } catch (_) {}
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
    // Always remove any stale loading-overlay from the previous project
    // FIRST so it can't masquerade as an idle placeholder below.
    try { setViewerLoading('step1-preview', false); } catch (_) {}
    // Remove img + restore placeholder, KEEP the static expand button
    const oldImg = step1Prev.querySelector('img');
    if (oldImg) oldImg.remove();
    if (!step1Prev.querySelector('.preview-placeholder:not(.viewer-loading-overlay)')) {
      const ph = document.createElement('div');
      ph.className = 'preview-placeholder';
      ph.textContent = 'No image yet';
      step1Prev.insertBefore(ph, step1Prev.firstChild);
    }
    step1Prev.classList.remove('clickable');
    step1Prev.onclick = null;
  }
  // Same cleanup for the other three viewers — covers slow loads from
  // the previous project that didn't finish before the user switched.
  try { setViewerLoading('ws-3d-source-preview', false); } catch (_) {}
  try { setViewerLoading('ws-rig-source-preview', false); } catch (_) {}
  try { setViewerLoading('ws-anim-source-preview', false); } catch (_) {}
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
  // 2026-06-13: populate Step 4 EDIT SELECTED with the project's
  // on-disk animations (from listAnimations -> p.animations in
  // refreshProjectsPage). Without this, the version-thumb strip was
  // empty after a refresh even though the GLBs existed on disk.
  try { if (p && Array.isArray(p.animations) && p.animations.length) renderAnimVersions(p); } catch (e) { console.warn('[populate] renderAnimVersions failed:', e); }
  // 2026-06-02 (mirror cloud c5866be): dispose any 3D viewer state held
  // over from a PREVIOUS project before we re-render the DOM for the
  // new project. NOTE: by the time we get here, openProject has ALREADY
  // swapped state.currentProject = p (see openProject above). Without
  // this dispose, slow rigSrc loads from project A can finish AFTER
  // project B's DOM is up and pollute B's rig viewer with A's mesh —
  // user reports "I still see the dragon while I'm in the orc project".
  // resetWorkspaceUI below also clears these, but we run the dispose
  // FIRST so the rigSrcLoadId bump invalidates A's in-flight callbacks
  // before any subsequent showRigSourceMesh kicks off a fresh load.
  try { if (typeof _disposeAnimModel === 'function') _disposeAnimModel(); } catch (_) {}
  try { if (typeof showRigSourceMesh === 'function') showRigSourceMesh(null); } catch (_) {}
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

  loadRigTemplatesIntoSelect();
  // Re-pick a sensible default skeleton target based on the project's
  // asset_type (character -> orc_m1, animal -> wolf, avion -> crow,
  // bateau/vehicle/prop -> puppeteer_raw, etc.).
  try { populateRigSkeletonDropdown(); } catch (_) {}
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
// Bumped on every renderImageVersions call; awaits inside check
// against this counter to abort if a newer call has started. Prevents
// concurrent renders from each appending their items to the strip
// (the bug that produced 'v1 v0 v1 v0' duplicate thumbs on cloud).
let _renderImageVersionsSeq = 0;
async function renderImageVersions(p) {
  const mySeq = ++_renderImageVersionsSeq;
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
    if (img.path === p.previewImagePath) t.classList.add('selected');
    if (img.path === p.selectedImagePath) t.classList.add('used-for-3d');
    // Cache-bust so Electron/Chromium re-reads ref_0.png after a new
    // generation overwrote it. Without this, the thumbnail shows a stale
    // version (previous generation) even though the file on disk is new.
    const _cb = img.mtime || p._reloadTs || Date.now();
    const hasEmissive = (typeof _emissiveLayerHas === 'function') && _emissiveLayerHas(img.path);
    const emissiveBadge = hasEmissive
      ? '<span class="v-emissive-badge" title="This image has an emissive layer painted on it" style="position:absolute; bottom:2px; right:2px; background:rgba(0,0,0,0.7); border-radius:50%; width:18px; height:18px; display:flex; align-items:center; justify-content:center; font-size:11px; line-height:1; box-shadow:0 0 0 1px rgba(255, 224, 102, 0.85);">💡</span>'
      : '';
    t.innerHTML = `
      <img src="file:///${img.path.replace(/\\/g, '/')}?t=${_cb}">
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
    // Spinner while the <img> decodes — only relevant for big PNGs.
    // Cleared on load/error or after a 10s safety timeout. Mirrors
    // the cloud d5798ea wiring.
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
    target.innerHTML = `<img src="file:///${imgPath.replace(/\\/g, '/')}">`;
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
// 2026-06-02: bump on every showRigSourceMesh entry. Async loader
// callbacks check that their captured ID still matches before adding
// to the scene — otherwise a stale callback (slow load from project A)
// silently appends its mesh on top of the fresh project B load, and
// the user sees two meshes at once (the "lion ghost next to dragon"
// class of bug seen in cloud commit ec1cab1).
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
  // scene.add. Prevents the "lion ghost beside the dragon" bug
  // when a slow load from project A finishes after project B is open.
  const myId = ++rigSrcLoadId;
  if (!meshPath) {
    if (placeholder) placeholder.style.display = '';
    if (rigSrcModel && rigSrcScene) { rigSrcScene.remove(rigSrcModel); rigSrcModel = null; }
    rigSrcMeshPath = null;
    try { setViewerLoading('ws-rig-source-preview', false); } catch (_) {}
    return;
  }
  // Idempotency: if we're already showing the requested mesh, do
  // nothing. Avoids tearing down a working scene during re-entrant
  // refreshButtonStates calls (auto-pick path can re-call this with
  // the same mesh several times during a single open).
  if (rigSrcMeshPath === meshPath && rigSrcModel) {
    try { setViewerLoading('ws-rig-source-preview', false); } catch (_) {}
    return;
  }
  rigSrcMeshPath = meshPath;
  initRigSrcViewer();
  setViewerFilename('ws-rig-source-filename', meshPath);
  if (placeholder) placeholder.style.display = 'none';
  // Show the spinner immediately so the user has visual feedback while
  // the mesh fetch + GLB/FBX parse happen (can take 500ms-2s on big
  // meshes). Cleared in applyLoadedModel / on load error.
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

// setViewerLoading is defined earlier (line ~681) with the
// .viewer-loading-overlay marker class. The previous duplicate
// definition here used .preview-placeholder.loading only — without the
// marker class, resetWorkspaceUI's :not(.viewer-loading-overlay) cleanup
// would wipe the spinner mid-load. Removed to let the canonical
// version above own the behaviour.

function showStep1Preview(imgPath) {
  const preview = document.getElementById('step1-preview');
  // Remove any previous img + placeholder, but KEEP the static expand button + toolbar
  // and KEEP the loading overlay — it's recreated below.
  const placeholder = preview.querySelector('.preview-placeholder:not(.viewer-loading-overlay)');
  if (placeholder) placeholder.remove();
  let imgEl = preview.querySelector('img');
  if (!imgEl) {
    imgEl = document.createElement('img');
    preview.insertBefore(imgEl, preview.firstChild);
  }
  // Loading overlay until <img> fires 'load' (or 'error'). Mirrors cloud
  // d5798ea — big PNGs / freshly-generated multi-view assemblies can take
  // 100-300ms to decode and the previous version flashed empty.
  try { setViewerLoading('step1-preview', true, 'Loading image…'); } catch (_) {}
  imgEl.onload = () => { try { setViewerLoading('step1-preview', false); } catch (_) {} };
  imgEl.onerror = () => {
    try { setViewerLoading('step1-preview', false); } catch (_) {}
    // Replace the broken <img> with our own DOM placeholder so the
    // browser / family-safety extension can't inject 'Blocked by content
    // filter' text on the empty image slot.
    try {
      imgEl.style.display = 'none';
      let fallback = preview.querySelector('.viewer-img-error');
      if (!fallback) {
        fallback = document.createElement('div');
        fallback.className = 'viewer-img-error';
        fallback.style.cssText = 'position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; color:var(--text-3); font-size:13px; text-align:center; padding:20px; pointer-events:none;';
        fallback.innerHTML = '<span style="font-size:36px;">&#9888;</span><span>Image unavailable</span><span style="font-size:11px; color:var(--text-3); max-width:80%;">The file is missing or could not be read from disk.</span>';
        preview.appendChild(fallback);
      }
    } catch (_) {}
  };
  // Clear any prior fallback so a successful reload re-shows the img.
  preview.querySelectorAll('.viewer-img-error').forEach(el => el.remove());
  imgEl.style.display = '';
  // Cache-bust — see version-thumb notes above; Electron holds onto the
  // previous bytes unless we change the URL.
  imgEl.src = _toFileUrl(imgPath) + '?t=' + Date.now();
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
// trellis2_native generates its own native PBR resolution so we hide
// texture-res / triangles unless a legacy engine is picked.
// ----------------------------------------------------------------
function _ws3dEngineSync() {
  const eng = document.getElementById('ws-3d-engine')?.value || 'trellis2_native';
  const qRow = document.getElementById('ws-3d-quality-row');
  const tRow = document.getElementById('ws-3d-triangles-row');
  const qHint = document.getElementById('ws-3d-quality-hint');
  const sf3dHint = document.getElementById('ws-3d-sf3d-hint');
  const trellis2Opts = document.getElementById('ws-3d-trellis2-opts');
  const legacy = ['sf3d'].includes(eng);
  if (qRow) qRow.style.display = legacy ? '' : 'none';
  if (tRow) tRow.style.display = legacy ? '' : 'none';
  if (qHint) qHint.style.display = legacy ? '' : 'none';
  if (sf3dHint) sf3dHint.style.display = legacy ? '' : 'none';
  if (trellis2Opts) trellis2Opts.style.display = (eng === 'trellis2_native') ? '' : 'none';
}
document.getElementById('ws-3d-engine')?.addEventListener('change', _ws3dEngineSync);
_ws3dEngineSync();
// ----------------------------------------------------------------

// 2026-06-14: the standalone "Ultra HD 8K texture" checkbox was removed —
// 8K is now chosen only via the quality preset dropdown. The hidden
// #ws-trellis2-ultra-hd input just mirrors whether the Ultra 8K preset
// is active, so the existing read logic (effectiveUltraHD = checkbox ||
// preset.forceUltraHd) keeps working unchanged.
function _wsTrellis2UltraHdSync() {
  const preset = document.getElementById('ws-trellis2-preset')?.value || 'fast';
  const cb = document.getElementById('ws-trellis2-ultra-hd');
  if (cb) cb.checked = (preset === 'ultra_8k');
}
document.getElementById('ws-trellis2-preset')?.addEventListener('change', _wsTrellis2UltraHdSync);
_wsTrellis2UltraHdSync();
// ----------------------------------------------------------------

// 2026-06-14: show an option-aware time estimate inside every pink
// Generate button (image / mesh / rig / anim), the same way the cloud
// build shows credit cost. The numbers mirror the expectedMs each
// click handler already computes from the selected options.
function _fmtEta(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `~${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `~${m}m${String(r).padStart(2, '0')}s` : `~${m}m`;
}
function _estimateImageMs() {
  const engine = document.getElementById('ws-engine')?.value || 'local-flux';
  const count = parseInt(document.getElementById('ws-count')?.value) || 4;
  const steps = parseInt(document.getElementById('ws-quality')?.value) || 30;
  let mvScope = document.getElementById('ws-mv-scope')?.value || 'auto';
  if (mvScope === 'auto') {
    const at = document.getElementById('ws-asset-type')?.value || 'character';
    mvScope = (at === 'character' || at === 'creature' || at === 'animal') ? 'front_back' : 'front_only';
  }
  const multiView = mvScope !== 'front_only';
  const buildStages = document.getElementById('ws-img-buildstages')?.checked || false;
  let perImage;
  if (engine === 'pollinations') perImage = 5000;
  else if (engine === 'local-sd') perImage = steps * 200 + 1500;
  else perImage = steps * 600 + 5000;
  let total = count;
  if (multiView) total *= 3;
  if (buildStages) total *= 3;
  return total * perImage + 3000;
}
function _estimateMeshMs() {
  const engine = document.getElementById('ws-3d-engine')?.value || 'trellis2_native';
  const quality = document.getElementById('ws-3d-quality')?.value || 'standard';
  const triLevel = document.getElementById('ws-3d-triangles')?.value || '0';
  const preset = (typeof MESH_QUALITY_PRESETS !== 'undefined' && MESH_QUALITY_PRESETS[quality]) || { expectedMs: 130000 };
  const triPreset = (typeof MESH_TRI_PRESETS !== 'undefined' && MESH_TRI_PRESETS[triLevel]) || { extraMs: 0 };
  const buildStages = document.getElementById('ws-3d-buildstages')?.checked || false;
  let ms;
  if (engine === 'sf3d') ms = (preset.expectedMs || 130000) + (triPreset.extraMs || 0);
  else if (engine === 'trellis2_native') ms = 110000;
  else ms = 60000;
  if (buildStages) ms *= 2.5;
  if (document.getElementById('ws-trellis2-refine')?.checked) ms += 90000;
  if (document.getElementById('ws-trellis2-rectify')?.checked) ms += 36000;
  if (document.getElementById('ws-trellis2-smooth')?.checked) ms += 12000;
  // Cascade geometry passes are the real time sinks (the multi-minute SLat
  // sampling), and on a 16-24 GB box they saturate RAM and swap — the old
  // +30s/+50s were wildly optimistic vs the observed ~2 min / ~5-6 min.
  if (document.getElementById('ws-trellis2-quality-plus')?.checked) ms += 120000;  // 1024_cascade ~2min
  if (document.getElementById('ws-trellis2-ultra-q')?.checked) ms += 360000;       // 1536_cascade ~6min (RAM-heavy)
  if (document.getElementById('ws-trellis2-face-fix')?.checked) ms += 60000;
  const t2preset = document.getElementById('ws-trellis2-preset')?.value || 'fast';
  if (document.getElementById('ws-trellis2-ultra-hd')?.checked || t2preset === 'ultra_8k') ms += 280000;
  return ms;
}
function _updateGenButtonsEstimate() {
  const p = state.currentProject;
  const bm = document.getElementById('ws-generate-mesh');
  if (bm) {
    const base = (p && p.meshes && p.meshes.length > 0) ? 'Generate new 3D version' : 'Generate 3D';
    bm.textContent = bm.disabled ? base : `${base} : ${_fmtEta(_estimateMeshMs())}`;
  }
  const bi = document.getElementById('ws-generate-image');
  if (bi) {
    const base = (p && p.images && p.images.length > 0) ? 'Generate new version' : 'Generate';
    bi.textContent = bi.disabled ? base : `${base} : ${_fmtEta(_estimateImageMs())}`;
  }
  const br = document.getElementById('ws-generate-rig-ai');
  if (br) br.textContent = br.disabled ? 'Generate Rig' : `Generate Rig : ${_fmtEta(90000)}`;
  const ba = document.getElementById('ws-generate-anim');
  if (ba) ba.textContent = ba.disabled ? 'Generate Animation' : `Generate Animation : ${_fmtEta(20000)}`;
}
[
  'ws-3d-engine', 'ws-3d-quality', 'ws-3d-triangles', 'ws-3d-buildstages',
  'ws-trellis2-preset', 'ws-trellis2-refine', 'ws-trellis2-rectify',
  'ws-trellis2-smooth', 'ws-trellis2-quality-plus', 'ws-trellis2-ultra-q',
  'ws-trellis2-face-fix', 'ws-engine', 'ws-count', 'ws-quality',
  'ws-mv-scope', 'ws-asset-type', 'ws-img-buildstages', 'ws-anim-type',
].forEach(id => {
  const el = document.getElementById(id);
  if (el) { el.addEventListener('change', _updateGenButtonsEstimate); el.addEventListener('input', _updateGenButtonsEstimate); }
});
_updateGenButtonsEstimate();
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
    }, expectedMs, { sourceImageUrl: mvImagePath, projectName: p.name });
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
  }, expectedMs, { sourceImageUrl: mvImagePath, projectName: p.name });
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
  // Always keep front. If only front exists hide the whole bar (a single
  // button is just noise).
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
  character: 'single isolated 3D character, one character only, full body, T-pose neutral stance, arms extended horizontally, legs apart, strict front view, facing camera, symmetric, RTS unit game asset, plain white background, even studio lighting, no shadows, no other characters, centered, clean silhouette, no text, no UI',
  building: 'ONE building only, single instance, isolated, full structure, plain white background, even studio lighting, no shadows, no characters, centered, strict front view, facing camera, clean silhouette, no text, no UI, no duplicate, no second building, not a village, not a town',
  vehicle: 'ONE car only, single vehicle, only one instance, isolated, complete vehicle, plain white background, even studio lighting, no shadows, no characters, centered, strict front view, facing camera, clean silhouette, no text, no UI, no duplicate, no second car, no twin, no rear view inset',
  weapon: 'ONE weapon only, single instance, isolated, full weapon, plain white background, even studio lighting, no shadows, centered, side profile, clean silhouette, no text, no UI, no duplicate',
  prop: 'ONE prop only, single instance, isolated, full item, plain white background, even studio lighting, no shadows, no characters, centered, strict front view, clean silhouette, no text, no UI, no duplicate',
  creature: '3D game asset reference sheet, full body character sheet, long shot, full figure shot, wide establishing shot, distant camera, entire creature visible from head to feet to tail, body fills 60 percent of frame, ONE creature only, single instance, isolated, neutral stance, front view, facing camera, symmetric, plain white background, even studio lighting, no shadows, no other creatures, centered, clean silhouette, no text, no UI, no duplicate, NOT a portrait, NOT a headshot, NOT a close-up, NOT a head shot, NOT a face shot, NOT a bust shot',
  environment: 'ONE environment piece only, single instance, isolated, full structure, plain white background, even studio lighting, no shadows, no characters, centered, strict front view, clean silhouette, no text, no UI, no duplicate',
  icon: 'single flat icon, app icon, UI icon, ONE element only, isolated subject centered in square frame, transparent or pure white background, soft rim light, vibrant colors, clean silhouette, slight isometric 3/4 angle, glossy material, mobile / desktop application icon style, no text, no logo, no duplicate, no extra elements',
  avion: 'ONE complete passenger aircraft only, single plane, only one instance, isolated, 3/4 isometric view, full body visible from nose to tail, both wings visible, tail fin visible, plain white background, even studio lighting, no shadows, no clouds, no horizon, no contrail, centered, clean silhouette, no text, no UI, no duplicate, no second plane, no formation',
  bateau: 'ONE complete boat only, single vessel, only one instance, isolated, 3/4 isometric view, full body visible from bow to stern, hull and superstructure visible, plain white background, even studio lighting, no shadows, no water, no wake, no horizon, centered, clean silhouette, no text, no UI, no duplicate, no second boat',
  animal: '3D game asset reference sheet, full body character reference, long shot, full figure shot, wide establishing shot, distant camera, entire animal visible from nose to tail to feet, body fills 60 percent of frame, ONE animal only, single creature with ONE single tail only, full body lateral profile, all four feet flat on the ground, body horizontal parallel to floor, belly close to ground, four legs supporting the body from below, plain white background, even studio lighting, no shadows, NEVER bipedal, NEVER upright, NEVER standing on hind legs, NEVER humanoid posture, NEVER T-pose, NEVER cartoon mascot stance, exactly one tail, no extra tails, no multiple tails, no extra limbs, no humanoid anthropomorphism, no second animal, no duplicate, no text, no UI, NOT a portrait, NOT a headshot, NOT a close-up, NOT a head shot, NOT a face shot, NOT a bust shot, NOT head and shoulders',
  // Per-category "Other …" presets: keep the category's framing/staging but
  // drop the SPECIFIC-object bias, so e.g. a catapult under "Other vehicle"
  // stays a vehicle (not a car) instead of a random studio object. A fully
  // generic prompt was too vague (produced a camera on a tripod).
  other_living:  'ONE creature only, single creature, one subject only, full body, isolated, plain white background, even studio lighting, no shadows, no other creatures, centered, strict front view, facing camera, clean silhouette, no text, no UI, no duplicate, no second creature',
  other_vehicle: 'ONE vehicle only, single vehicle, only one instance, isolated, complete vehicle, plain white background, even studio lighting, no shadows, no characters, centered, strict front view, facing camera, clean silhouette, no text, no UI, no duplicate, no second vehicle, no twin',
  other_built:   'ONE structure only, single structure, only one instance, isolated, full structure, plain white background, even studio lighting, no shadows, no characters, centered, strict front view, clean silhouette, no text, no UI, no duplicate, no second structure',
  other_item:    'ONE item only, single item, only one instance, isolated, full item, plain white background, even studio lighting, no shadows, no characters, centered, strict front view, clean silhouette, no text, no UI, no duplicate, no second item',
  custom: '',
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

// Rig-target skeletons exposed in the Generate Rig dropdown. The Python
// remapper (scripts/puppeteer_to_orc_m1.py) only handles orc_m1 today;
// other entries map to bones_json templates listed in
// scripts/rig_templates/skm/registry.json + companions on disk.
const SKELETON_TARGETS = [
  { value: "orc_m1",         emoji: "🤖",  label: "Humanoide bipède",        variete: "Humanoide" },
  { value: "ue5_mannequin",  emoji: "🤖",  label: "UE5 Mannequin std",       variete: "Humanoide" },
  { value: "zebra",          emoji: "🐎",  label: "Quadrupède équidé",       variete: "Quadrupède équidé" },
  { value: "lion",           emoji: "🦁",  label: "Quadrupède félidé",       variete: "Quadrupède félidé" },
  { value: "wolf",           emoji: "🐺",  label: "Quadrupède canidé",       variete: "Quadrupède canidé" },
  { value: "crocodile",      emoji: "🐊",  label: "Reptile quadrupède",      variete: "Reptile" },
  { value: "elephant",       emoji: "🐘",  label: "Pachyderme",              variete: "Pachyderme" },
  { value: "deer",           emoji: "🦌",  label: "Cervidé",                 variete: "Cervidé" },
  { value: "crow",           emoji: "🐦",  label: "Oiseau",                  variete: "Oiseau" },
  { value: "turtle",         emoji: "🐢",  label: "Tortue",                  variete: "Tortue" },
  { value: "spider",         emoji: "🕷️", label: "Arachnide 8-pattes",      variete: "Arachnide" },
  { value: "bat",            emoji: "🦇",  label: "Chiroptère",              variete: "Chiroptère" },
  { value: "dragon",         emoji: "🐉",  label: "Dragon fantastique",      variete: "Dragon" },
  { value: "puppeteer_raw",  emoji: "⚪",  label: "Puppeteer raw (no remap)", variete: "Raw" },
];

// Map an asset_type to the most appropriate default skeleton target.
// Returns a value matching one of SKELETON_TARGETS[*].value.
// User can still override via the dropdown after auto-fill.
function _pickDefaultSkeletonForAsset(assetType) {
  const a = String(assetType || '').toLowerCase();
  if (a === 'character')           return 'orc_m1';
  if (a === 'creature')            return 'orc_m1';     // most creatures are humanoid-ish
  if (a === 'animal')              return 'wolf';        // generic quadruped
  if (a === 'avion')               return 'crow';        // bird/wing skeleton closest to plane
  if (a === 'bateau')              return 'puppeteer_raw';
  if (a === 'vehicle')             return 'puppeteer_raw';
  if (a === 'weapon')              return 'puppeteer_raw';
  if (a === 'prop')                return 'puppeteer_raw';
  if (a === 'building')            return 'puppeteer_raw';
  if (a === 'environment')         return 'puppeteer_raw';
  if (a === 'icon')                return 'puppeteer_raw';
  return 'orc_m1'; // safe default (humanoid)
}

async function populateRigSkeletonDropdown() {
  const sel = document.getElementById('ws-rig-skeleton');
  if (!sel) return;
  // Build options synchronously with "?" counts so the user sees the
  // list immediately; then patch each label with the real bone count
  // once readBonesJson resolves (or skip if the IPC isn't wired yet).
  sel.innerHTML = '';
  for (const t of SKELETON_TARGETS) {
    const opt = document.createElement('option');
    opt.value = t.value;
    opt.textContent = `${t.emoji} ${t.label} (loading...)`;
    opt.dataset.variete = t.variete;
    sel.appendChild(opt);
  }
  // Auto-pick default skeleton based on project asset_type unless the
  // user has already pinned a choice via state.currentProject.rigTarget.
  try {
    const p = (typeof state !== 'undefined' && state && state.currentProject) ? state.currentProject : null;
    let want = (p && p.rigTarget)
      ? p.rigTarget
      : _pickDefaultSkeletonForAsset(p && p.assetType);
    if (![...sel.options].some(o => o.value === want)) want = 'orc_m1';
    sel.value = want;
  } catch (_) {
    sel.value = 'orc_m1';
  }
  // Fetch bone counts (best-effort).
  const hasReader = API && typeof API.readBonesJson === 'function';
  await Promise.all(SKELETON_TARGETS.map(async (t, i) => {
    let count = '?';
    if (hasReader) {
      try {
        const data = await API.readBonesJson(t.value);
        // main.js IPC returns { ok, count, name }; bones_json files
        // themselves store { bone_count, bones[] }. Accept all shapes.
        if (data && typeof data.count === 'number')       count = data.count;
        else if (data && typeof data.bone_count === 'number') count = data.bone_count;
        else if (data && Array.isArray(data.bones))       count = data.bones.length;
      } catch (_) { /* fallback */ }
    }
    const opt = sel.options[i];
    if (opt) opt.textContent = `${t.emoji} ${t.label} (${count} bones)`;
  }));
}

// Populate as soon as the script runs (DOM is parsed before this point
// because index2.js is referenced at the bottom of index2.html).
try { populateRigSkeletonDropdown(); } catch (_) {}

// Persist the selected target on the active project so it survives
// step navigation and reload.
document.getElementById('ws-rig-skeleton')?.addEventListener('change', (e) => {
  if (state && state.currentProject) {
    state.currentProject.rigTarget = e.target.value;
  }
});

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
    'ONE vehicle only', 'ONE structure only', 'ONE item only', 'ONE subject only',
    'one character only', 'single vehicle', 'single structure', 'single item',
    'single creature', 'only one instance',
    'single instance', 'isolated', 'complete vehicle', 'complete object',
    // staging / lighting / framing
    'plain white background', 'even studio lighting', 'no shadows',
    'no characters', 'no other characters', 'no other creatures',
    'centered', 'clean silhouette', 'no text', 'no UI',
    'full body', 'full structure', 'full weapon', 'full item',
    // dedup negatives (sometimes leak into positive)
    'no duplicate', 'no second car', 'no second building',
    'no second vehicle', 'no second structure', 'no second item',
    'no second creature', 'no second instance',
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
    }, expectedMs, { projectName: p.name, assetKind: assetType });
    try {
      const r = await API.generateImages({ prompt, userPrompt, engine, numImages: count, projectName: p.name, steps, multiView, buildStages, jobId: job.id, vramFraction: (gpuLimits?.vram || 90) / 100, assetType });
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
            console.log('[image-gen] post-reload strip rendered, images=',
                        state.currentProject.images?.length);
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
  if (srcImg) srcImg.src = 'file:///' + target.replace(/\\/g, '/') + '?t=' + Date.now();
  modifyModal.dataset.targetPath = target;
  _updateModStrengthHint();
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
    }, modifyExpected, { sourceImageUrl: target, projectName: p.name });
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
    const job = pushJob(`Remove background: ${p.name}`, null, null, undefined, { sourceImageUrl: target, projectName: p.name });
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

const QUICK_EDIT_EXPECTED_MS = {
  crop:       4000,
  brightness: 4000,
  blur:       4000,
  upscale:    20000,
  paint:      4000,
};

// Helper: run a quick image edit via Python PIL and reload the project
async function runQuickEdit(operation, params) {
  const p = state.currentProject;
  const target = editTarget(p);
  if (!target) { showToast('Pick an image first.', 'error'); return; }
  const expectedMs = QUICK_EDIT_EXPECTED_MS[operation] || 6000;
  const imgName = String(target).split(/[\\/]/).pop();
  const job = (typeof pushJob === 'function')
    ? pushJob(`${operation}: ${p.name}`, null, { Image: imgName }, expectedMs, { sourceImageUrl: target, projectName: p.name })
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
  // Draw axis line — with a dark HALO underneath so the green stays visible on
  // light areas (white walls) AND dark areas (sky). Without the halo the line
  // washed out over bright parts of the image and looked "missing".
  octx.save();
  const cos = Math.cos(symState.axisAngle);
  const sin = Math.sin(symState.axisAngle);
  const len = Math.max(w, h);
  const x1 = ax - sin * len, y1 = -cos * len + ay;
  const x2 = ax + sin * len, y2 = cos * len + ay;
  // Dark halo (solid, thicker)
  octx.setLineDash([]);
  octx.strokeStyle = 'rgba(0,0,0,0.75)';
  octx.lineWidth = 6;
  octx.beginPath(); octx.moveTo(x1, y1); octx.lineTo(x2, y2); octx.stroke();
  // Bright green dashed on top
  octx.strokeStyle = '#3bff6a';
  octx.lineWidth = 3;
  octx.setLineDash([9, 5]);
  octx.beginPath(); octx.moveTo(x1, y1); octx.lineTo(x2, y2); octx.stroke();
  // Centre handle: filled green disc with a black + green outline
  octx.setLineDash([]);
  octx.beginPath(); octx.arc(ax, ay, 8, 0, Math.PI * 2);
  octx.fillStyle = 'rgba(59,255,106,0.85)'; octx.fill();
  octx.lineWidth = 3; octx.strokeStyle = 'rgba(0,0,0,0.8)'; octx.stroke();
  octx.lineWidth = 1.5; octx.strokeStyle = '#3bff6a'; octx.stroke();
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

// Brush size slider
document.getElementById('sym-brush-size')?.addEventListener('input', (e) => {
  symState.brushSize = parseInt(e.target.value);
  document.getElementById('sym-brush-val').textContent = e.target.value;
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
    ? pushJob(`Symmetrize: ${p?.name || ''}`, null, { Image: imgName }, 5000, { sourceImageUrl: symState.imgPath, projectName: p?.name })
    : null;
  try {
    const dataUrl = canvas.toDataURL('image/png');
    const r = await API.saveImageDataUrl({
      basePath: symState.imgPath,
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
  const p = state.currentProject;
  const tgt = editTarget(p);
  if (!tgt) return;
  const nw = Math.round(_resW / 2), nh = Math.round(_resH / 2);
  const imgName = String(tgt).split(/[\\/]/).pop();
  const job = (typeof pushJob === 'function')
    ? pushJob(`Downscale: ${p?.name || ''}`, null, { Image: imgName, From: `${_resW}x${_resH}`, To: `${nw}x${nh}` }, 4000, { sourceImageUrl: tgt, projectName: p?.name })
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
    const shPct = parseInt(document.getElementById('bright-sharpness').value, 10);
    const matEl = document.getElementById('bright-sharpen-matrix');
    if (matEl) {
      if (shPct >= 100) {
        const k = (shPct - 100) / 200;
        const side = -k, center = 1 + 4 * k;
        matEl.setAttribute('kernelMatrix', `0 ${side} 0 ${side} ${center} ${side} 0 ${side} 0`);
      } else {
        const k = (100 - shPct) / 100;
        const boxW = (1 / 9) * k;
        const center = 1 - k + boxW;
        matEl.setAttribute('kernelMatrix', `${boxW} ${boxW} ${boxW} ${boxW} ${center} ${boxW} ${boxW} ${boxW} ${boxW}`);
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
  gatedRun('img2img', `Style: ${style.split(',')[0]}`, async () => {
    const job = pushJob(`Style Transfer: ${p.name}`, null, { Style: style.split(',')[0] }, 30000, { sourceImageUrl: tgt, projectName: p.name });
    try {
      const r = await API.img2img({ imagePath: tgt, prompt: style, strength: 0.6, engine: 'local-sdxl' });
      if (r?.success) {
        // Remember which style was applied to this NEW image version only.
        // We deliberately do NOT tag the source image: it was the INPUT, not a
        // result of this style — tagging it overwrote the initial version's own
        // style so going back to v0 wrongly showed the child's style.
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
  // Loupe: reuse #clone-loupe (Clone Stamp / Draw Mask share it).
  // ~6× zoom with crosshair on the sampled pixel + pixel outline.
  function _cpUpdateLoupe(e) {
    const loupeEl = document.getElementById('clone-loupe');
    const loupeCanvas = document.getElementById('clone-loupe-canvas');
    if (!loupeEl || !loupeCanvas) return;
    const lCtx = loupeCanvas.getContext('2d');
    const rect = cpCanvas.getBoundingClientRect();
    // Width and height need separate scale factors — using sx for cy
    // skews the loupe by the H/W ratio on non-square images.
    const sx = cpCanvas.width / rect.width;
    const sy = cpCanvas.height / rect.height;
    const cx = Math.round((e.clientX - rect.left) * sx);
    const cy = Math.round((e.clientY - rect.top) * sy);
    const srcHalf = 20;
    lCtx.clearRect(0, 0, 120, 120);
    lCtx.save();
    lCtx.imageSmoothingEnabled = false;
    lCtx.beginPath(); lCtx.arc(60, 60, 58, 0, Math.PI * 2); lCtx.clip();
    lCtx.drawImage(cpCanvas, cx - srcHalf, cy - srcHalf, srcHalf * 2, srcHalf * 2, 0, 0, 120, 120);
    lCtx.strokeStyle = 'rgba(255,255,255,0.9)'; lCtx.lineWidth = 1;
    lCtx.beginPath();
    lCtx.moveTo(60, 50); lCtx.lineTo(60, 70);
    lCtx.moveTo(50, 60); lCtx.lineTo(70, 60);
    lCtx.stroke();
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
    if (cur) {
      // cpick-cursor's offsetParent is the CONTAINER, but the canvas is
      // CENTERED inside it (canvas.style.left/top offset). Positioning the dot
      // with the canvas rect shifted it by that centering offset → it didn't
      // sit under the mouse. Position relative to the container instead.
      const cont = document.getElementById('cpick-canvas-container');
      const cRect = (cont || cpCanvas.parentElement).getBoundingClientRect();
      cur.style.left = (e.clientX - cRect.left) + 'px';
      cur.style.top = (e.clientY - cRect.top) + 'px';
      cur.style.display = 'block';
    }
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
  const imgName = String(tgt).split(/[\\/]/).pop();
  const job = (typeof pushJob === 'function')
    ? pushJob(`Blur brush: ${p?.name || ''}`, null, { Image: imgName }, 4000, { sourceImageUrl: tgt, projectName: p?.name })
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

// Persistent emissive-layer cache (module scope + localStorage).
const _emissiveLayerCache = new Map();
const _EMISSIVE_LS_KEY = 'fabmesh.emissiveLayers';
(function _loadEmissiveCache() {
  try {
    const raw = localStorage.getItem(_EMISSIVE_LS_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      Object.entries(obj).forEach(([k, v]) => _emissiveLayerCache.set(k, String(v)));
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
// Normalise the cache key so a path saved with backslashes (result.path from
// main) matches the same image listed with any slash direction / case when the
// badge is rendered. Without this, set(newPath) and has(img.path) could miss
// each other → the 💡 emissive badge never appeared on the painted version.
function _emKey(p) { return String(p == null ? '' : p).replace(/\\/g, '/').toLowerCase(); }
function _emissiveLayerSet(imgPath, dataUrl) { _emissiveLayerCache.set(_emKey(imgPath), dataUrl); _saveEmissiveCache(); }
function _emissiveLayerGet(imgPath) { return _emissiveLayerCache.get(_emKey(imgPath)) || null; }
function _emissiveLayerHas(imgPath) { return _emissiveLayerCache.has(_emKey(imgPath)); }

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

// Re-apply the LAST fill with the CURRENT opacity / tolerance / colour. Used so
// dragging those sliders updates the last painted zone live: restore the
// pre-fill canvas, then flood-fill again from the same seed. No new undo entry —
// the original fill-click's pushUndo stays the single undo point.
function _paintReapplyFill() {
  if (paintState.tool !== 'fill' || !paintState.fillLastPoint || !paintState.fillSnapshot || !_paintMgr) return;
  const ctx = _paintMgr.ctx;
  const outCtx = paintState.fillEmissive ? _paintGetEmissiveCtx(_paintMgr) : null;
  const snapCtx = outCtx || ctx;
  try { snapCtx.putImageData(paintState.fillSnapshot, 0, 0); } catch (_) { return; }
  _paintFloodFill(ctx, paintState.fillLastPoint.x, paintState.fillLastPoint.y, paintState.color, paintState.tolerance, outCtx);
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
          // In emissive mode, detect the region on the image but paint into the
          // emissive overlay (so Fill works for emissive too, not just the brush).
          const outCtx = paintState.emissiveMode ? _paintGetEmissiveCtx(mgr) : null;
          const snapCtx = outCtx || ctx;
          // Snapshot the layer that actually changes, so the sliders re-apply
          // this SAME fill live (tune the last painted zone without re-clicking).
          paintState.fillSnapshot = snapCtx.getImageData(0, 0, mgr.w, mgr.h);
          paintState.fillEmissive = !!outCtx;
          paintState.fillLastPoint = { x: Math.round(x), y: Math.round(y) };
          _paintFloodFill(ctx, Math.round(x), Math.round(y), paintState.color, paintState.tolerance, outCtx);
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
        const targetCtx = paintState.emissiveMode ? _paintGetEmissiveCtx(mgr) : ctx;
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
    paintState.fillLastPoint = null;  // last-fill is stale once the tool changes
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
  _paintReapplyFill();  // live-update the last fill
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

// Tolerance (for Fill / Wand) — re-run the live selection/fill
document.getElementById('paint-tolerance')?.addEventListener('input', (e) => {
  paintState.tolerance = parseInt(e.target.value);
  document.getElementById('paint-tolerance-val').textContent = e.target.value;
  if (paintState.tool === 'wand' && paintState.wandLastPoint && _paintMgr) {
    _paintWandSelect(_paintMgr.ctx, paintState.wandLastPoint.x, paintState.wandLastPoint.y, paintState.tolerance);
    _paintShowSelection();
  } else {
    _paintReapplyFill();  // live-update the last fill
  }
});

// Color picker
document.getElementById('paint-color')?.addEventListener('input', (e) => {
  paintState.color = e.target.value;
  _paintReapplyFill();  // recolour the last fill live
});

// Eyedropper (pick from image)
document.getElementById('paint-eyedropper')?.addEventListener('click', () => {
  paintState.eyedropping = !paintState.eyedropping;
  document.getElementById('paint-eyedropper')?.classList.toggle('tool-active', paintState.eyedropping);
  const canvas = document.getElementById('paint-canvas');
  if (canvas) canvas.style.cursor = paintState.eyedropping ? 'crosshair' : 'none';
});

document.getElementById('paint-emissive-toggle')?.addEventListener('click', () => {
  paintState.emissiveMode = !paintState.emissiveMode;
  const btn = document.getElementById('paint-emissive-toggle');
  btn?.classList.toggle('tool-active', paintState.emissiveMode);
  if (paintState.emissiveMode && _paintMgr) _paintGetEmissiveCtx(_paintMgr);
  _paintApplyEmissiveVisibility();
  if (typeof showToast === 'function') {
    showToast(paintState.emissiveMode
      ? '💡 Emissive layer ON — strokes paint the T_emissive map'
      : 'Emissive layer OFF — back to image painting', 'info', 1800);
  }
});

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
  const overlay = document.getElementById('paint-emissive-overlay');
  if (overlay && overlay.width && overlay.height) {
    const p = state.currentProject;
    if (p) {
      try {
        const ctx = overlay.getContext('2d');
        const samp = ctx.getImageData(0, 0, overlay.width, overlay.height).data;
        let hasInk = false;
        // Scan EVERY pixel's alpha (breaks on first hit). The old i += 4*64
        // stride sampled only 1 pixel in 64 and could miss a thin emissive
        // stroke entirely → the layer was never saved → no 💡 badge.
        for (let i = 3; i < samp.length; i += 4) {
          if (samp[i] > 0) { hasInk = true; break; }
        }
        console.log('[emissive] save: hasInk=', hasInk, 'imgPath=', paintState.imgPath);
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
    ? pushJob(`Paint: ${p?.name || ''}`, null, { Image: imgName }, 4000, { sourceImageUrl: paintState.imgPath, projectName: p?.name })
    : null;
  try {
    const result = await window.meshyAPI.saveImageDataUrl({
      basePath: paintState.imgPath, dataUrl, suffix: 'painted',
    });
    if (result && result.success) {
      if (job && typeof completeJob === 'function') completeJob(job.id, true);
      showToast('Painted version saved!', 'success');
      const newPath = result.path || result.newPath || result.url;
      const srcLayer = _emissiveLayerGet(paintState.imgPath);
      if (srcLayer && newPath) _emissiveLayerSet(newPath, srcLayer);
      // Also persist the emissive mask as a real file in the project folder
      // (images/<project>/_emissive/<base>.png) — not just localStorage.
      if (srcLayer && newPath && API.saveEmissiveFile) {
        API.saveEmissiveFile({ imagePath: newPath, dataUrl: srcLayer })
          .then(r => console.log('[emissive] file saved:', r && r.success ? r.path : (r && r.error)))
          .catch(() => {});
      }
      console.log('[emissive] carry: srcLayer=', !!srcLayer, 'newPath=', newPath, 'has(newPath)=', _emissiveLayerHas(newPath));
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
      // FrontSide (cull back faces) — Trellis2 reversed-winding triangles
      // can produce a few dark patches but that's preferable to the
      // 'see-through painted texture' artefact users reported when
      // DoubleSide reveals the inside-out of the front face.
      mat.side = THREE.FrontSide;
      // FORCE OPAQUE: GLTFLoader sometimes carries alphaMode='BLEND' or
      // a stray alpha map from Trellis2/SF3D output that makes the
      // mesh look semi-transparent. Default to opaque; users who need
      // glass can re-enable via Material Adjust.
      if (mat.transparent || (mat.opacity != null && mat.opacity < 1)) {
        mat.transparent = false;
        mat.opacity = 1.0;
        if (mat.alphaMap) mat.alphaMap = null;
        if ('alphaTest' in mat) mat.alphaTest = 0;
        mat.depthWrite = true;
        mat.needsUpdate = true;
      }
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
  // Newest-first guarantee. The main-process handler appends meshes in
  // four phases (jobs → rigged → mesh-op → animations) without a final
  // sort, so a freshly-generated mesh-op output could land BEHIND
  // older jobs. The renderer labels by index (v(N-1-i)) and assumes
  // i=0 is newest, so re-sort defensively here.
  if (Array.isArray(meshes)) {
    // Sort NEWEST-FIRST by real timestamp. `created` arrives as a Date (it's
    // fs birthtime) and `mtime` may be epoch-ms or a Date — compare them
    // NUMERICALLY via getTime(). The previous String(date).localeCompare()
    // compared the locale string "Wed Jun 14 2026 ..." by DAY-OF-WEEK, so
    // meshes from different days sorted randomly and a freshly-generated mesh
    // could land last (labelled v0 on the right). Regression from ef475f2.
    const _ts = (m) => {
      if (!m) return 0;
      const t = new Date(m.created || m.mtime || 0).getTime();
      return Number.isFinite(t) ? t : 0;
    };
    meshes = meshes.slice().sort((a, b) => _ts(b) - _ts(a));
  }
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
    const meshHasEmissive = (typeof _emissiveLayerHas === 'function') && (
      (m.sourceImage && _emissiveLayerHas(m.sourceImage))
      || (p.selectedImagePath && _emissiveLayerHas(p.selectedImagePath))
      || (p.images || []).some((im) => _emissiveLayerHas(im.path))
    );
    const meshEmissiveBadge = meshHasEmissive
      ? '<span class="v-emissive-badge" title="This mesh was generated from an image with an emissive layer painted on it" style="position:absolute; bottom:2px; right:2px; background:rgba(0,0,0,0.7); border-radius:50%; width:18px; height:18px; display:flex; align-items:center; justify-content:center; font-size:11px; line-height:1; box-shadow:0 0 0 1px rgba(255, 224, 102, 0.85);">💡</span>'
      : '';
    t.innerHTML = `
      ${thumbSrc ? `<img src="${thumbSrc}" alt="">` : ''}
      <span class="v-label">v${meshes.length - 1 - i}</span>
      <button class="version-delete-btn" title="Delete this mesh">&#10005;</button>
      ${meshEmissiveBadge}
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

// "Use this rig for Animation ->" — mirrors the mesh→rig handover.
// Pins the currently-previewed rig as the animation source, marks the
// thumb selected, then expands + scrolls to Step 4 (Animation).
document.getElementById('ws-use-for-anim-btn')?.addEventListener('click', () => {
  const p = state.currentProject;
  if (!p || !p.rigs || p.rigs.length === 0) return;
  // Find currently-previewed rig (selected thumb in ws-rig-versions).
  const sel = document.querySelector('#ws-rig-versions .version-thumb.selected');
  const idx = sel ? Array.from(sel.parentElement.children).indexOf(sel) : 0;
  const rig = p.rigs[idx] || p.rigs[0];
  if (!rig) return;
  p.selectedRigPath = rig.path;
  p.selectedRigUrl = rig.url || rig.path;
  // Mark the used-for-anim thumb visually.
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
  try {
    const placeholder = document.getElementById('ws-anim-source-placeholder');
    if (placeholder) placeholder.style.display = 'none';
    const preview = document.getElementById('ws-anim-source-preview');
    if (preview) {
      const filename = (rig.filename || rig.path || '').split(/[/\\]/).pop() || 'rig.glb';
      const url = (typeof _toFileUrl === 'function')
        ? _toFileUrl(rig.path)
        : 'file:///' + (rig.path || '').replace(/\\/g, '/');
      preview.style.position = 'relative';
      preview.style.minHeight = '200px';
      // 2026-06-13: replaced <model-viewer> (custom element not registered
      // in this build — was rendering as an invisible div) with a Three.js
      // inline renderer using the same GLTFLoader pattern as
      // c:/tmp/training_meshes/anim_preview.html.
      preview.innerHTML = `
        <canvas id="ws-anim-rig-canvas" style="position:absolute; inset:0; width:100%; height:100%; background:#0a0a0e; border-radius:6px; display:block;"></canvas>
        <div style="position:absolute; bottom:6px; left:0; right:0; text-align:center; font-size:10px; color:var(--text-2); pointer-events:none; padding:0 8px; word-break:break-all;">${filename}</div>
      `;
      try { setViewerLoading('ws-anim-source-preview', true, 'Loading rig…'); } catch (_) {}
      const clearLoading = () => { try { setViewerLoading('ws-anim-source-preview', false); } catch (_) {} };
      (() => {
        try {
          // Use locally-bundled three / GLTFLoader / OrbitControls
          // (imports at the top of this file). The previous unpkg.com
          // dynamic imports were blocked by Electron's default CSP.
          const canvas = document.getElementById('ws-anim-rig-canvas');
          if (!canvas) { clearLoading(); return; }
          const w = canvas.clientWidth || 300, h = canvas.clientHeight || 200;
          const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
          renderer.setPixelRatio(devicePixelRatio);
          renderer.setSize(w, h, false);
          const scene = new THREE.Scene();
          scene.background = new THREE.Color(0x0a0a0e);
          scene.add(new THREE.AmbientLight(0xffffff, 0.9));
          const sun = new THREE.DirectionalLight(0xffffff, 1.6);
          sun.position.set(2, 3, 2); scene.add(sun);
          const cam = new THREE.PerspectiveCamera(35, w / h, 0.001, 1000);
          cam.position.set(2, 1, 2);
          const ctl = new OrbitControls(cam, canvas); ctl.enableDamping = true;
          ctl.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
          new GLTFLoader().load(url, (g) => {
            const root = g.scene; scene.add(root);
            // Disable frustum culling + grab bbox from skeleton bones
            // (SkinnedMesh.boundingBox is in bind pose, often empty).
            let sk = null;
            root.traverse(o => {
              if (o.isMesh || o.isSkinnedMesh) {
                o.frustumCulled = false;
                if (o.geometry) { o.geometry.computeBoundingBox(); o.geometry.computeBoundingSphere(); }
              }
              if (o.isSkinnedMesh && !sk) sk = o.skeleton;
            });
            const box = new THREE.Box3();
            if (sk) {
              const v = new THREE.Vector3();
              sk.bones.forEach(b => { b.updateMatrixWorld(true); v.setFromMatrixPosition(b.matrixWorld); box.expandByPoint(v); });
            } else {
              box.setFromObject(root);
            }
            const sz = new THREE.Vector3(); box.getSize(sz);
            const c = new THREE.Vector3(); box.getCenter(c);
            const d = Math.max(sz.x, sz.y, sz.z) || 1;
            cam.position.set(c.x + d * 1.8, c.y + d * 1.0, c.z + d * 1.8);
            cam.near = Math.max(d * 0.001, 0.001);
            cam.far = d * 100;
            cam.updateProjectionMatrix();
            ctl.target.copy(c); ctl.update();
            if (sk) {
              const helper = new THREE.SkeletonHelper(root);
              helper.material.linewidth = 2;
              helper.material.color = new THREE.Color(0xff8800);
              scene.add(helper);
            }
            clearLoading();
          }, undefined, (err) => {
            console.error('[anim-source] GLB load error:', err);
            clearLoading();
          });
          (function tick() {
            requestAnimationFrame(tick);
            ctl.update();
            renderer.render(scene, cam);
          })();
          // Handle window resize
          const onResize = () => {
            const nw = canvas.clientWidth, nh = canvas.clientHeight;
            if (nw > 0 && nh > 0) {
              renderer.setSize(nw, nh, false);
              cam.aspect = nw / nh; cam.updateProjectionMatrix();
            }
          };
          window.addEventListener('resize', onResize);
        } catch (err) {
          console.error('[anim-source] preview init failed:', err);
          clearLoading();
        }
      })(); /* end source-rig viewer */
    }
    const genBtn = document.getElementById('ws-generate-anim');
    if (genBtn) {
      genBtn.disabled = false;
      genBtn.title = '';
    }
    const engineSel = document.getElementById('ws-anim-engine');
    if (engineSel && !engineSel.value) {
      engineSel.value = 'rokoko_library';
      engineSel.dispatchEvent(new Event('change'));
    }
  } catch (e) { console.warn('[anim-source] preview populate failed:', e); }
  // Activate Step 4 (Animation) card and scroll to it.
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
      showToast('Filtre désactivé — relance de l\'action…', 'info', 2500);
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

// Count of 3D mesh generations currently IN FLIGHT per project. Used to ASK
// before launching a 2nd gen of the SAME project (the user's earlier "two
// Untitled gens fighting" confusion) — not to hard-block, since a big GPU may
// have room. The VRAM-aware concurrency gate below decides whether it actually
// runs now or queues.
const _meshGenInFlight = new Map(); // projectName -> count
document.getElementById('ws-generate-mesh').addEventListener('click', async () => {
  const p = state.currentProject;
  if (!p || !p.selectedImagePath) { showToast('Pick an image first.', 'error'); return; }
  if ((_meshGenInFlight.get(p.name) || 0) > 0) {
    const proceed = await customConfirm(
      'A 3D generation is already running for this project. Start another one in parallel anyway? It will queue automatically if the GPU is busy.',
      '3D generation already running',
      'Generate anyway'
    );
    if (!proceed) return;
  }
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
  if (trellis2QualityPlus) expectedMs += 120000;  // 1024_cascade ~2min (was 30s — too low)
  const trellis2UltraQ = document.getElementById('ws-trellis2-ultra-q')?.checked || false;
  if (trellis2UltraQ) expectedMs += 360000;  // 1536_cascade ~6min, RAM-heavy (was 50s — way too low)
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
    // 8K (would OOM on RTX 5080) and quality-comparable.
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
    trellis2MultiRef,
    trellis2Refine,
    trellis2RectifySource,
    trellis2Smooth,
    trellis2QualityPlus,
    trellis2UltraQ,
    trellis2FaceFix,
    trellis2UltraHD: effectiveUltraHD,
    // Also send via the snake_case key expected by the python runner.
    ultra_hd: effectiveUltraHD,
    trellis2Preset,
    assetType: document.getElementById('ws-asset-type')?.value || 'character',
  };
  const qualityLabels = { draft: 'Draft', standard: 'Standard', high: 'High' };
  // For TRELLIS-2 native, the user-facing quality is the QUALITY PRESET
  // dropdown (ws-trellis2-preset), NOT the legacy ws-3d-quality select. Show
  // that so the running-task popup matches what the user actually picked
  // (was showing "High" while the user selected "Fast").
  const t2PresetLabels = { fast: 'Fast', balanced: 'Balanced', quality: 'Quality', ultra_8k: 'Ultra 8K' };
  const qualityDisplay = (engine === 'trellis2_native')
    ? (t2PresetLabels[trellis2Preset] || trellis2Preset)
    : (qualityLabels[quality] || quality);
  const jobParams = {
    Engine: engineLabel(engine),
    Quality: qualityDisplay,
    'Target triangles': triPreset.label,
    'Source image': p.selectedImagePath ? p.selectedImagePath.split(/[/\\]/).pop() : '--',
  };
  const _projName = p.name;
  _meshGenInFlight.set(_projName, (_meshGenInFlight.get(_projName) || 0) + 1);
  gatedRun('mesh', `Generate 3D: ${p.name}`, async () => {
    const job = pushJob(`Generate 3D: ${p.name}`, null, jobParams, expectedMs, { sourceImageUrl: p.selectedImagePath, projectName: p.name });
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
    } finally {
      // Free this project's in-flight slot (count-aware: a parallel gen of the
      // same project keeps its own slot).
      const _c = (_meshGenInFlight.get(_projName) || 1) - 1;
      if (_c > 0) _meshGenInFlight.set(_projName, _c); else _meshGenInFlight.delete(_projName);
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
    }, undefined, { sourceImageUrl: m.path, projectName: p.name });
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
  watertight:     12000,
  texture_var:    150000,
  center:         1000,
  set_pivot:      1500,
  retexture:      45000,
  trellis2_retex: 110000,
};

async function runMeshTool(operation, params = []) {
  const p = state.currentProject;
  if (!p || !p.selectedMeshPath) { showToast('Pick a mesh first.', 'error'); return; }
  const meshPath = p.selectedMeshPath;
  const meshName = meshPath.split(/[\\/]/).pop();
  const expectedMs = MESH_TOOL_EXPECTED_MS[operation] || 10000;
  // Show the full "Running task" popup (same component as 3D generation,
  // image ops, etc.) so the user sees ETA + cancel button + progress bar
  // instead of just a toast.
  const job = (typeof pushJob === 'function')
    ? pushJob(`${operation}: ${p.name}`, null, {
        Tool: operation,
        Mesh: meshName,
        Params: params.length ? params.join(', ') : '(none)',
      }, expectedMs, { sourceImageUrl: meshPath, projectName: p.name })
    : null;
  try {
    const result = await API.meshTool({ operation, meshPath, params });
    if (result && result.success) {
      showToast(`${operation} done!`, 'success');
      if (job && typeof completeJob === 'function') completeJob(job.id, true);
      // Register the new mesh version. populateWorkspace only RENDERS
      // p.meshes — it does not re-scan disk — so without this the decimated/
      // filled/… output never appears as a new version and the user keeps
      // seeing the old triangle count.
      const newPath = result.newPath || result.path;
      if (newPath) {
        p.meshes = p.meshes || [];
        const filename = result.filename || newPath.replace(/\\/g, '/').split('/').pop();
        p.meshes.unshift({ path: newPath, filename, size: result.size || 0, mtime: Date.now() });
        p.selectedMeshPath = newPath;  // show the result as the active mesh
      }
      populateWorkspace(p);
    } else {
      // Append the subprocess stderr when present — main.js resolves with
      // result.stderr on a non-zero exit, and that's where the real
      // bridge/projection cause lives (execFile's own error is generic).
      const msg = [
        (result && result.error) || 'unknown',
        result && result.stderr ? String(result.stderr).slice(-400) : '',
      ].filter(Boolean).join(' — ');
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
  // Build adjacency.
  const neigh = Array.from({ length: n }, () => new Set());
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    neigh[a].add(b); neigh[a].add(c);
    neigh[b].add(a); neigh[b].add(c);
    neigh[c].add(a); neigh[c].add(b);
  }
  const arr = new Float32Array(pos.array);
  for (let it = 0; it < iter; it++) {
    const next = new Float32Array(arr);
    for (let v = 0; v < n; v++) {
      const ns = neigh[v];
      if (ns.size === 0) continue;
      let sx = 0, sy = 0, sz = 0;
      ns.forEach(nb => {
        sx += arr[nb * 3]; sy += arr[nb * 3 + 1]; sz += arr[nb * 3 + 2];
      });
      const k = 1 / ns.size;
      const ax = sx * k, ay = sy * k, az = sz * k;
      next[v * 3]     = arr[v * 3]     + lambda * (ax - arr[v * 3]);
      next[v * 3 + 1] = arr[v * 3 + 1] + lambda * (ay - arr[v * 3 + 1]);
      next[v * 3 + 2] = arr[v * 3 + 2] + lambda * (az - arr[v * 3 + 2]);
    }
    arr.set(next);
  }
  pos.array.set(arr);
  pos.needsUpdate = true;
  result.computeVertexNormals();
  return result;
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
    const uvAttr = g.attributes.uv;  // carry UVs through — without them the
    const idx = g.index.array;        // textured material renders all black.
    const newPos = Array.from(pos.array);
    const newUV = uvAttr ? Array.from(uvAttr.array) : null;
    const newIdx = [];
    const midCache = new Map();
    const getMid = (a, b) => {
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (midCache.has(k)) return midCache.get(k);
      const ax = pos.array[a * 3], ay = pos.array[a * 3 + 1], az = pos.array[a * 3 + 2];
      const bx = pos.array[b * 3], by = pos.array[b * 3 + 1], bz = pos.array[b * 3 + 2];
      const m = newPos.length / 3;
      newPos.push((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
      if (newUV) {
        newUV.push(
          (uvAttr.array[a * 2] + uvAttr.array[b * 2]) / 2,
          (uvAttr.array[a * 2 + 1] + uvAttr.array[b * 2 + 1]) / 2,
        );
      }
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
    if (newUV) newGeom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(newUV), 2));
    newGeom.setIndex(new THREE.BufferAttribute(new Uint32Array(newIdx), 1));
    g = newGeom;
  }
  g.computeVertexNormals();
  return g;
}

// Center: translate vertices so the X/Z BBOX center = 0, min Y = 0.
// (bbox midpoint, matching the Python center() — not the arithmetic vertex
// mean, which drifts toward dense regions and won't match the export.)
function _jsCenter(geom) {
  const result = geom.clone();
  const pos = result.attributes.position;
  const arr = pos.array;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity;
  for (let i = 0; i < pos.count; i++) {
    const x = arr[i * 3], y = arr[i * 3 + 1], z = arr[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    if (y < minY) minY = y;
  }
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  for (let i = 0; i < pos.count; i++) {
    arr[i * 3]     -= cx;
    arr[i * 3 + 1] -= minY;
    arr[i * 3 + 2] -= cz;
  }
  pos.needsUpdate = true;
  result.computeVertexNormals();
  return result;
}

// Fix Normals with UV-seam welding (ported from cloud). Plain
// computeVertexNormals leaves split vertices at UV seams with different
// normals → visible criss-cross "cracked-plate" shading on fresh TRELLIS
// meshes. Welding co-located vertices' normals into one averaged normal kills it.
function _jsFixNormalsWelded(geom) {
  const result = geom.clone();
  result.computeVertexNormals();
  const pos = result.attributes.position;
  const norm = result.attributes.normal;
  if (!pos || !norm) return result;
  const arr = pos.array, narr = norm.array, n = pos.count;
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = arr[i * 3], y = arr[i * 3 + 1], z = arr[i * 3 + 2];
    if (x < mnx) mnx = x; if (x > mxx) mxx = x;
    if (y < mny) mny = y; if (y > mxy) mxy = y;
    if (z < mnz) mnz = z; if (z > mxz) mxz = z;
  }
  const diag = Math.hypot(mxx - mnx, mxy - mny, mxz - mnz) || 1;
  const Q = 1e5 / diag;
  const groupKey = new Map();
  const groupOfVertex = new Int32Array(n);
  let G = 0;
  for (let v = 0; v < n; v++) {
    const k = Math.round(arr[v * 3] * Q) + ',' + Math.round(arr[v * 3 + 1] * Q) + ',' + Math.round(arr[v * 3 + 2] * Q);
    let g = groupKey.get(k);
    if (g === undefined) { g = G++; groupKey.set(k, g); }
    groupOfVertex[v] = g;
  }
  const groupN = new Float32Array(G * 3);
  for (let v = 0; v < n; v++) {
    const g = groupOfVertex[v];
    groupN[g * 3] += narr[v * 3]; groupN[g * 3 + 1] += narr[v * 3 + 1]; groupN[g * 3 + 2] += narr[v * 3 + 2];
  }
  for (let g = 0; g < G; g++) {
    const x = groupN[g * 3], y = groupN[g * 3 + 1], z = groupN[g * 3 + 2];
    const len = Math.hypot(x, y, z) || 1;
    groupN[g * 3] = x / len; groupN[g * 3 + 1] = y / len; groupN[g * 3 + 2] = z / len;
  }
  for (let v = 0; v < n; v++) {
    const g = groupOfVertex[v];
    narr[v * 3] = groupN[g * 3]; narr[v * 3 + 1] = groupN[g * 3 + 1]; narr[v * 3 + 2] = groupN[g * 3 + 2];
  }
  norm.needsUpdate = true;
  return result;
}

// Boundary-loop hole finder for the Fill-holes live preview. Returns the
// green fan-fill triangle positions (geom-local) + per-size outline line
// vertices (green=will fill, grey=too small, red=too big) + stats. Adapted
// from the cloud _jsFillHoles.
function _jsHoleFillPreview(geom, minHoleSize, maxHoleSize) {
  const empty = { greenFaces: [], green: [], grey: [], red: [], stats: { loops: 0, filled: 0, tooBig: 0, tooSmall: 0 } };
  if (!geom.index || !geom.attributes.position) return empty;
  const arr = geom.attributes.position.array;
  const n = geom.attributes.position.count;
  const rawIndices = geom.index.array;
  const rawTriCount = Math.floor(rawIndices.length / 3);
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = arr[i * 3], y = arr[i * 3 + 1], z = arr[i * 3 + 2];
    if (x < mnx) mnx = x; if (x > mxx) mxx = x;
    if (y < mny) mny = y; if (y > mxy) mxy = y;
    if (z < mnz) mnz = z; if (z > mxz) mxz = z;
  }
  const bbDiag = Math.hypot(mxx - mnx, mxy - mny, mxz - mnz) || 1;
  // Strip degenerate triangles (TRELLIS marching cubes emits many).
  const indices = [];
  const areaEps = bbDiag * 1e-12;
  for (let t = 0; t < rawTriCount; t++) {
    const i0 = rawIndices[t * 3], i1 = rawIndices[t * 3 + 1], i2 = rawIndices[t * 3 + 2];
    if (i0 === i1 || i1 === i2 || i2 === i0) continue;
    const ax = arr[i0 * 3], ay = arr[i0 * 3 + 1], az = arr[i0 * 3 + 2];
    const ex = arr[i1 * 3] - ax, ey = arr[i1 * 3 + 1] - ay, ez = arr[i1 * 3 + 2] - az;
    const fx = arr[i2 * 3] - ax, fy = arr[i2 * 3 + 1] - ay, fz = arr[i2 * 3 + 2] - az;
    if (Math.hypot(ey * fz - ez * fy, ez * fx - ex * fz, ex * fy - ey * fx) * 0.5 < areaEps) continue;
    indices.push(i0, i1, i2);
  }
  const triCount = Math.floor(indices.length / 3);
  // Weld by quantized position (tol = bbDiag*1e-3, matching the Python fill).
  const Q = 1 / (bbDiag * 1e-3);
  const keyToId = new Map(); const groupOf = new Int32Array(n); let G = 0;
  for (let v = 0; v < n; v++) {
    const k = Math.round(arr[v * 3] * Q) + ',' + Math.round(arr[v * 3 + 1] * Q) + ',' + Math.round(arr[v * 3 + 2] * Q);
    let gid = keyToId.get(k); if (gid === undefined) { gid = G++; keyToId.set(k, gid); } groupOf[v] = gid;
  }
  const repOf = new Int32Array(G).fill(-1);
  for (let v = 0; v < n; v++) { const g = groupOf[v]; if (repOf[g] === -1) repOf[g] = v; }
  const cnt = new Map();
  for (let t = 0; t < triCount; t++) {
    const g0 = groupOf[indices[t * 3]], g1 = groupOf[indices[t * 3 + 1]], g2 = groupOf[indices[t * 3 + 2]];
    for (const [a, b] of [[g0, g1], [g1, g2], [g2, g0]]) { if (a === b) continue; const k = a < b ? a + ',' + b : b + ',' + a; cnt.set(k, (cnt.get(k) || 0) + 1); }
  }
  const succ = new Map();
  for (let t = 0; t < triCount; t++) {
    const g0 = groupOf[indices[t * 3]], g1 = groupOf[indices[t * 3 + 1]], g2 = groupOf[indices[t * 3 + 2]];
    for (const [a, b] of [[g0, g1], [g1, g2], [g2, g0]]) { if (a === b) continue; const k = a < b ? a + ',' + b : b + ',' + a; if (cnt.get(k) !== 1) continue; if (!succ.has(a)) succ.set(a, []); succ.get(a).push(b); }
  }
  const loops = [];
  const popNext = (g) => { const a = succ.get(g); return a && a.length ? a.pop() : null; };
  for (const start of succ.keys()) {
    while ((succ.get(start) || []).length) {
      const loop = []; let g = start;
      for (let s = 0; s < 100000; s++) { loop.push(g); const nx = popNext(g); if (nx == null) break; if (nx === start) break; g = nx; }
      if (loop.length >= 3) loops.push(loop); else break;
    }
  }
  const greenFaces = [], green = [], grey = [], red = [];
  let filled = 0, tooBig = 0, tooSmall = 0;
  for (const loop of loops) {
    let bucket;
    if (loop.length < minHoleSize) { bucket = grey; tooSmall++; }
    else if (loop.length > maxHoleSize) { bucket = red; tooBig++; }
    else { bucket = green; filled++; }
    for (let i = 0; i < loop.length; i++) {
      const va = repOf[loop[i]], vb = repOf[loop[(i + 1) % loop.length]];
      bucket.push(arr[va * 3], arr[va * 3 + 1], arr[va * 3 + 2], arr[vb * 3], arr[vb * 3 + 1], arr[vb * 3 + 2]);
    }
    if (bucket !== green) continue;
    let cx = 0, cy = 0, cz = 0;
    for (const g of loop) { const v = repOf[g]; cx += arr[v * 3]; cy += arr[v * 3 + 1]; cz += arr[v * 3 + 2]; }
    cx /= loop.length; cy /= loop.length; cz /= loop.length;
    for (let i = 0; i < loop.length; i++) {
      const va = repOf[loop[i]], vb = repOf[loop[(i + 1) % loop.length]];
      greenFaces.push(arr[va * 3], arr[va * 3 + 1], arr[va * 3 + 2], arr[vb * 3], arr[vb * 3 + 1], arr[vb * 3 + 2], cx, cy, cz);
    }
  }
  return { greenFaces, green, grey, red, stats: { loops: loops.length, filled, tooBig, tooSmall } };
}

// Remove the Fill-holes preview overlays (green fills + coloured outlines).
function _mtClearOverlays() {
  for (const o of (mtState.overlays || [])) {
    try {
      if (o.parent) o.parent.remove(o);
      o.traverse?.(c => { c.geometry?.dispose?.(); c.material?.dispose?.(); });
      if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose();
    } catch (_) {}
  }
  mtState.overlays = [];
}

// --- Set Pivot Point (ported from cloud) — preview shows a yellow gizmo at
// the chosen pivot WITHOUT moving the mesh; Apply (Python set_pivot) moves it. ---
function _mtComputePivot(mode, ox, oy, oz) {
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (const e of mtState.origGeoms) {
    const g = e.originalGeom; if (!g?.attributes?.position) continue;
    const a = g.attributes.position.array, n = g.attributes.position.count;
    for (let i = 0; i < n; i++) {
      const x = a[i * 3], y = a[i * 3 + 1], z = a[i * 3 + 2];
      if (x < mnx) mnx = x; if (x > mxx) mxx = x;
      if (y < mny) mny = y; if (y > mxy) mxy = y;
      if (z < mnz) mnz = z; if (z > mxz) mxz = z;
    }
  }
  if (!isFinite(mnx)) return null;
  const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2, cz = (mnz + mxz) / 2;
  let px, py, pz;
  switch ((mode || 'bottom')) {
    case 'center': px = cx; py = cy; pz = cz; break;
    case 'top': px = cx; py = mxy; pz = cz; break;
    case 'left': px = mnx; py = cy; pz = cz; break;
    case 'right': px = mxx; py = cy; pz = cz; break;
    case 'front': px = cx; py = cy; pz = mxz; break;
    case 'back': px = cx; py = cy; pz = mnz; break;
    case 'world_origin': px = 0; py = 0; pz = 0; break;
    default: px = cx; py = mny; pz = cz; break;  // bottom
  }
  return { pivot: [px + (ox || 0), py + (oy || 0), pz + (oz || 0)], diag: Math.hypot(mxx - mnx, mxy - mny, mxz - mnz) || 1 };
}
function _makePivotGizmo(size) {
  const grp = new THREE.Group();
  const axes = new THREE.AxesHelper(size);
  axes.material.depthTest = false; axes.material.transparent = true; axes.renderOrder = 999;
  grp.add(axes);
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(size * 0.18, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0xffe066, depthTest: false, transparent: true, opacity: 0.95 }));
  sphere.renderOrder = 999; grp.add(sphere);
  return grp;
}
function _mtBuildPivotGizmo(vals) {
  _mtClearOverlays();
  if (!mtState.origModel) return;
  const r = _mtComputePivot(vals.pivot || 'bottom', Number(vals.offset_x) || 0, Number(vals.offset_y) || 0, Number(vals.offset_z) || 0);
  if (!r) return;
  const giz = _makePivotGizmo(r.diag * 0.08);
  giz.position.set(r.pivot[0], r.pivot[1], r.pivot[2]);
  mtState.origModel.add(giz);
  mtState.overlays.push(giz);
}

// Build the Fill-holes overlays for the current min/max: a light-green
// semi-transparent surface over each fillable hole + coloured outlines.
function _mtBuildFillOverlays(vals) {
  _mtClearOverlays();
  const minE = Math.max(3, Number(vals.min_hole_size) || 3);
  const maxE = Math.max(minE, Number(vals.max_hole_size) || 2000);
  let loops = 0, filled = 0, tooSmall = 0, tooBig = 0;
  const addLines = (mesh, verts, color, opacity) => {
    if (!verts.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false }));
    l.renderOrder = 999; mesh.add(l); mtState.overlays.push(l);
  };
  for (const e of mtState.origGeoms) {
    const r = _jsHoleFillPreview(e.originalGeom, minE, maxE);
    loops += r.stats.loops; filled += r.stats.filled; tooSmall += r.stats.tooSmall; tooBig += r.stats.tooBig;
    if (r.greenFaces.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(r.greenFaces, 3));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x66ff99, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
      m.renderOrder = 998; e.mesh.add(m); mtState.overlays.push(m);
    }
    addLines(e.mesh, r.green, 0x33ff77, 0.95);
    addLines(e.mesh, r.grey, 0x888888, 0.6);
    addLines(e.mesh, r.red, 0xff4455, 0.9);
  }
  return { loops, filled, tooSmall, tooBig };
}

const MESH_TOOL_SCHEMAS = {
  smooth: {
    title: 'Smooth mesh',
    subtitle: 'Laplacian smoothing — live preview.',
    needsImage: false,
    params: [
      { id: 'iterations', label: 'Iterations', type: 'range', min: 1, max: 20, step: 1, default: 3 },
      { id: 'lambda',     label: 'Lambda',     type: 'range', min: 0.0, max: 1.0, step: 0.05, default: 0.5 },
    ],
    build: (vals) => [String(vals.iterations), String(vals.lambda)],
    preview: (geom, vals) => _jsLaplacianSmooth(geom, Math.max(1, vals.iterations | 0), vals.lambda),
  },
  // Merged Triangle-count tool: one slider centered on the current count.
  // Below current → decimate (reduce); above → subdivide (×4 steps).
  triangle_count: {
    title: 'Triangle count',
    subtitle: 'Set the target triangle count. Below the current count REDUCES (decimate); above it INCREASES (subdivide, ×4 steps). ↺ Actuel recenters on the current count.',
    needsImage: false,
    heavyPreview: true,
    params: [
      { id: 'target_faces', label: 'Target triangles', type: 'range', min: 100, max: 200000, step: 100, default: 20000, resetToCurrent: true, pivotCurrent: true },
    ],
    resolveOp: (vals) => {
      const cur = _mtCurrentTriCount() || 0;
      const target = Number(vals.target_faces);
      if (!cur || target < cur * 0.97) return { operation: 'decimate', params: [String(target)] };
      if (target > cur * 1.3) {
        const levels = Math.max(1, Math.min(3, Math.round(Math.log(target / cur) / Math.log(4))));
        return { operation: 'subdivide', params: [String(levels)] };
      }
      return null;  // target ≈ current — nothing to do
    },
    preview: (geom, vals) => {
      const cur = geom.index ? geom.index.count / 3 : (geom.attributes?.position ? geom.attributes.position.count / 3 : 0);
      const target = Number(vals.target_faces);
      if (cur && target > cur * 1.3) {
        const levels = Math.max(1, Math.min(2, Math.round(Math.log(target / cur) / Math.log(4))));
        return _jsMidpointSubdivide(geom, levels);
      }
      return null;  // decimate / no-op: no cheap live preview
    },
  },
  // Kept as a backend op (reached via triangle_count.resolveOp), not opened
  // directly anymore.
  decimate: {
    title: 'Triangle count',
    subtitle: 'Reduce triangle count (Python only — no live preview).',
    needsImage: false,
    params: [
      { id: 'target_faces', label: 'Target triangles', type: 'range', min: 100, max: 100000, step: 100, default: 5000, resetToCurrent: true },
    ],
    build: (vals) => [String(vals.target_faces)],
  },
  subdivide: {
    title: 'Subdivide mesh',
    subtitle: 'Midpoint subdivision — splits each triangle into 4 (×4 per level) for a smoother, denser mesh. Live preview.',
    needsImage: false,
    heavyPreview: true,
    params: [
      { id: 'levels', label: 'Levels', type: 'range', min: 1, max: 3, step: 1, default: 1 },
    ],
    build: (vals) => [String(vals.levels)],
    preview: (geom, vals) => _jsMidpointSubdivide(geom, Math.max(1, vals.levels | 0)),
  },
  fix_normals: {
    title: 'Fix normals (weld UV seams)',
    subtitle: 'Recompute normals + fix winding, and WELD normals across UV seams — kills the criss-cross "cracked-plate" shading on fresh TRELLIS meshes.',
    needsImage: false,
    params: [],
    build: () => [],
    preview: (geom) => _jsFixNormalsWelded(geom),
  },
  fill_holes: {
    title: 'Fill holes',
    subtitle: 'Holes whose boundary loop is between Min and Max edges show in GREEN (will be filled); grey = too small, red = too big. Apply fills them with texture from the surrounding mesh.',
    needsImage: false,
    overlayPreview: true,   // green fill + coloured outlines, not a geom swap
    heavyPreview: true,
    params: [
      { id: 'min_hole_size', label: 'Min hole size (edges)', type: 'range', min: 3, max: 20000, step: 1,  default: 3 },
      { id: 'max_hole_size', label: 'Max hole size (edges)', type: 'range', min: 3, max: 20000, step: 10, default: 2000 },
    ],
    build: (vals) => [String(vals.min_hole_size), String(vals.max_hole_size)],
  },
  center: {
    title: 'Center mesh',
    subtitle: 'Recenters on X/Z and puts feet at Y=0 — live preview.',
    needsImage: false,
    params: [],
    build: () => [],
    preview: (geom) => _jsCenter(geom),
  },
  // Set Pivot Point — supersedes the old plain Center (ported from cloud).
  set_pivot: {
    title: 'Set pivot point',
    subtitle: 'Place the mesh origin (pivot) at a bounding-box landmark, fine-tune with X/Y/Z. The yellow gizmo shows where the pivot lands; Apply moves the mesh so the pivot is at (0,0,0).',
    needsImage: false,
    overlayPreview: 'pivot',
    params: [
      { id: 'pivot', label: 'Pivot preset', type: 'select', default: 'bottom',
        options: [['center', 'Center'], ['bottom', 'Bottom'], ['top', 'Top'],
                  ['left', 'Left'], ['right', 'Right'], ['front', 'Front'],
                  ['back', 'Back'], ['world_origin', 'World Origin']] },
      { id: 'offset_x', label: 'X offset', type: 'range', min: -1, max: 1, step: 0.01, default: 0 },
      { id: 'offset_y', label: 'Y offset', type: 'range', min: -1, max: 1, step: 0.01, default: 0 },
      { id: 'offset_z', label: 'Z offset', type: 'range', min: -1, max: 1, step: 0.01, default: 0 },
    ],
    build: (vals) => [String(vals.pivot || 'bottom'), String(vals.offset_x || 0),
                      String(vals.offset_y || 0), String(vals.offset_z || 0)],
  },
  watertight: {
    title: 'Watertight',
    subtitle: 'Rebuild a CLOSED, watertight shell (voxel remesh). Fuses every disconnected part into one solid with no holes. The original texture is baked onto the new shell as vertex colours (run Re-Texture for crisp PBR). Higher resolution = more detail, slower & heavier.',
    needsImage: false,
    confirm: 'Watertight rebuilds the mesh as a new closed shell (texture kept as vertex colours). Continue?',
    params: [
      { id: 'resolution', label: 'Resolution', type: 'range', min: 48, max: 400, step: 8, default: 192 },
    ],
    build: (vals) => [String(vals.resolution)],
  },
  texture_var: {
    title: 'Texture variations',
    subtitle: 'Regenerate ONLY the texture — geometry & UVs stay exactly the same. Change the Variation seed for a different look; raise Strength for a bigger change. Add a Style word (rusty, golden, camo…) to steer it. ~1–3 min (SDXL).',
    needsImage: false,
    params: [
      { id: 'strength', label: 'Change strength', type: 'range', min: 15, max: 80, step: 5, default: 40 },
      { id: 'seed', label: 'Variation (seed)', type: 'number', min: 0, max: 999999, step: 1, default: 42, randomize: true },
      { id: 'style', label: 'Style (optional)', type: 'text', default: '', placeholder: 'rusty, golden, camouflage…' },
    ],
    // → python mesh_tools.py texture_var <in> <out> <strength0-1> <seed> <style>
    build: (vals) => [String((Number(vals.strength) || 40) / 100), String(vals.seed), vals.style || ''],
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
    title: 'Re-Texture (MyFabmesh.AI 3D Native)',
    subtitle: 'Regenerate the mesh texture with MyFabmesh.AI 3D Native PBR (~90s, GPU). Change the Variation seed for a different texture from the same mesh + reference.',
    needsImage: true,
    params: [
      { id: 'preset', label: 'Quality preset', type: 'select', default: 'fast',
        options: [['fast','Fast (12 steps · 2048px · ~90s)'],
                  ['balanced','Balanced (24 steps · 2048px · ~130s)'],
                  ['quality','Quality (32 steps · 4096px · ~3min)']] },
      { id: 'seed', label: 'Variation (seed)', type: 'number', min: 0, max: 999999, step: 1, default: 42, randomize: true },
    ],
    // preset + seed flow as real CLI params: runMeshTool → mesh-tool IPC →
    // python mesh_tools.py trellis2_retex <in> <out> <imagePath> <preset> <seed>
    // → bridge --steps/--texture-size/--image-resolution --seed.
    build: (vals, ctx) => [ctx.imagePath, vals.preset, String(vals.seed)],
  },
};

// Persistent Three.js state for the mesh-tool modal viewer.
const mtState = {
  renderer: null, scene: null, camera: null, controls: null,
  rafId: null,
  origModel: null,        // the GLTF scene loaded — we mutate its geometries on preview
  origGeoms: [],          // [{ mesh, originalGeom }] — to restore on params change
  schema: null,
  vals: {},
  previewTimer: null,
  overlays: [],           // Fill-holes preview overlays (green fills + outlines)
  wireframes: [],         // wireframe overlays (△ Triangles toggle)
  showWire: false,
};

function _mtCollectVals(body) {
  const vals = {};
  body.querySelectorAll('[data-param-id]').forEach((el) => {
    const id = el.dataset.paramId;
    const t = el.dataset.paramType;
    if (t === 'checkbox') vals[id] = el.checked;
    else if (t === 'number' || t === 'range') vals[id] = Number(el.value);
    else vals[id] = el.value;
  });
  return vals;
}

function _mtSchedulePreview() {
  if (mtState.previewTimer) clearTimeout(mtState.previewTimer);
  mtState.previewTimer = setTimeout(_mtRunPreview, 80);
}

// Spinner overlay on the mesh-tool viewport (shown while a heavy live
// preview recomputes — the JS subdivide on a dense mesh blocks the thread).
function _mtShowSpinner(show) {
  const vp = document.getElementById('mt-viewport');
  if (!vp) return;
  let sp = document.getElementById('mt-spinner');
  if (!sp) {
    if (!document.getElementById('mt-spin-kf')) {
      const st = document.createElement('style');
      st.id = 'mt-spin-kf';
      st.textContent = '@keyframes mtspin{to{transform:rotate(360deg)}}';
      document.head.appendChild(st);
    }
    sp = document.createElement('div');
    sp.id = 'mt-spinner';
    sp.style.cssText = 'position:absolute; inset:0; display:none; align-items:center; justify-content:center; background:rgba(10,10,20,0.45); z-index:5; pointer-events:none; gap:12px; flex-direction:column;';
    sp.innerHTML = '<div style="width:46px; height:46px; border:4px solid rgba(255,255,255,0.16); border-top-color:#6aa6ff; border-radius:50%; animation:mtspin 0.8s linear infinite;"></div><div style="font-size:12px; color:#cdd;">Processing…</div>';
    vp.appendChild(sp);
  }
  sp.style.display = show ? 'flex' : 'none';
}

// Wireframe overlay — "△ Triangles" toggle. Shows the triangle edges of the
// CURRENT (preview) geometry over the textured mesh, so the user can see the
// density change as they decimate / subdivide.
function _mtClearWireframes() {
  for (const w of (mtState.wireframes || [])) {
    try { if (w.parent) w.parent.remove(w); if (w.geometry) w.geometry.dispose(); if (w.material) w.material.dispose(); } catch (_) {}
  }
  mtState.wireframes = [];
}
function _mtBuildWireframes() {
  _mtClearWireframes();
  if (!mtState.showWire) return;
  let total = 0;
  for (const e of mtState.origGeoms) {
    const g = e.mesh.geometry;
    total += g?.index ? g.index.count / 3 : ((g?.attributes?.position?.count || 0) / 3);
  }
  if (total > 1500000) { showToast('Trop de triangles pour l’affichage filaire ici', 'info', 1800); return; }
  for (const e of mtState.origGeoms) {
    const g = e.mesh.geometry;
    if (!g) continue;
    const lines = new THREE.LineSegments(
      new THREE.WireframeGeometry(g),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthTest: true }));
    lines.renderOrder = 997;
    e.mesh.add(lines);
    mtState.wireframes.push(lines);
  }
}
function _mtCreateWireButton() {
  const vp = document.getElementById('mt-viewport');
  if (!vp || document.getElementById('mt-wire-toggle')) return;
  const b = document.createElement('button');
  b.id = 'mt-wire-toggle';
  b.className = 'secondary-btn';
  b.style.cssText = 'position:absolute; top:8px; left:8px; z-index:6; padding:5px 10px; font-size:11px;';
  b.textContent = '△ Triangles';
  const sync = () => {
    b.style.background = mtState.showWire ? 'var(--accent, #6aa6ff)' : '';
    b.style.color = mtState.showWire ? '#fff' : '';
  };
  b.onclick = () => { mtState.showWire = !mtState.showWire; sync(); _mtBuildWireframes(); };
  sync();
  vp.appendChild(b);
}

function _mtRunPreview() {
  if (!mtState.schema || !mtState.origModel) return;
  const body = document.getElementById('mt-body');
  if (!body) return;
  const vals = _mtCollectVals(body);
  mtState.vals = vals;
  const fn = mtState.schema.preview;
  const status = document.getElementById('mt-preview-status');
  const compute = () => {
    _mtClearOverlays();
    for (const e of mtState.origGeoms) {
      if (!fn) { e.mesh.geometry = e.originalGeom; continue; }
      try {
        const out = fn(e.originalGeom, vals);
        if (out && out.attributes && out.attributes.position) e.mesh.geometry = out;
      } catch (err) {
        console.warn('[mesh-tool] preview failed for', mtState.schema.title, err);
        e.mesh.geometry = e.originalGeom;
      }
    }
    if (mtState.schema.overlayPreview === 'pivot') {
      _mtBuildPivotGizmo(vals);
      if (status) status.textContent = `Pivot: ${vals.pivot || 'bottom'} — le gizmo jaune montre où sera l'origine. Apply déplace le mesh.`;
    } else if (mtState.schema.overlayPreview) {
      const st = _mtBuildFillOverlays(vals);
      if (status) {
        status.textContent = st.loops
          ? `Trous : ${st.filled} à remplir (vert) · ${st.tooSmall} trop petits (gris) · ${st.tooBig} trop grands (rouge)`
          : 'Aucun trou à bord simple détecté (mesh déjà fermé ou non-manifold).';
      }
    } else if (status) {
      status.textContent = fn
        ? `Live preview · ${Object.entries(vals).map(([k, v]) => `${k}=${v}`).join(' · ')}`
        : 'No live preview for this op · click Apply to run.';
    }
    _mtBuildWireframes();  // refresh wireframe to match the new geometry
    _mtShowSpinner(false);
  };
  // Heavy previews (subdivide / fill-holes scan on a dense mesh) block the
  // main thread, so show a spinner first and defer the compute past two
  // frames so it actually paints. Cheap previews run synchronously.
  if ((fn || mtState.schema.overlayPreview) && mtState.schema.heavyPreview) {
    _mtShowSpinner(true);
    requestAnimationFrame(() => requestAnimationFrame(compute));
  } else {
    compute();
  }
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
  mtState.scene.background = new THREE.Color(0x1a1a2e);
  mtState.camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 100);
  mtState.camera.position.set(0, 0.5, 2);
  try {
    mtState.controls = new OrbitControls(mtState.camera, canvas);
    mtState.controls.enableDamping = true;
    mtState.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN,
    };
  } catch (e) { console.error('[mesh-tool] OrbitControls error:', e); }
  mtState.scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.0));
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(5, 8, 5);
  mtState.scene.add(dir);
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
  _mtCreateWireButton();
}

function _mtLoadMesh(meshPath) {
  if (mtState.origModel && mtState.scene) {
    mtState.scene.remove(mtState.origModel);
  }
  mtState.origModel = null;
  mtState.origGeoms = [];
  const url = 'file:///' + meshPath.replace(/\\/g, '/');
  fetch(url).then(r => r.arrayBuffer()).then(buffer => {
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
      mtState.origModel.traverse(child => {
        if (child.isMesh && child.geometry) {
          mtState.origGeoms.push({ mesh: child, originalGeom: child.geometry });
        }
      });
      // Now that geoms are cached, run the initial preview + refresh the
      // "↺ Actuel" button and center any pivot slider on the real count.
      _mtRefreshResetBtn();
      _mtInitPivotSliders();
      _mtRunPreview();
    });
  });
}

// Current triangle count of the mesh loaded in the mesh-tool viewport.
function _mtCurrentTriCount() {
  let n = 0;
  for (const e of (mtState.origGeoms || [])) {
    const g = e.originalGeom;
    if (!g) continue;
    n += g.index ? g.index.count / 3 : (g.attributes?.position ? g.attributes.position.count / 3 : 0);
  }
  return Math.round(n);
}
// Refresh the "reset to current" button label once the mesh has loaded.
function _mtRefreshResetBtn() {
  const btn = document.getElementById('mt-reset-current');
  if (!btn) return;
  const n = _mtCurrentTriCount();
  btn.textContent = n ? `↺ Actuel : ${n.toLocaleString('fr-FR')}` : '↺ Actuel';
  btn.disabled = !n;
}
// Center any "pivot" slider (Triangle count) on the mesh's current count and
// widen its max so the user can both reduce (decimate) and increase
// (subdivide) from that midpoint.
function _mtInitPivotSliders() {
  const cur = _mtCurrentTriCount();
  if (!cur) return;
  const body = document.getElementById('mt-body');
  if (!body) return;
  body.querySelectorAll('input[data-pivot-current="1"]').forEach((input) => {
    input.max = String(Math.max(Number(input.max) || 0, cur * 4));
    input.value = String(cur);
    input.dispatchEvent(new Event('input'));  // updates the value label + preview
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
      } else if (spec.type === 'text') {
        input = document.createElement('input');
        input.type = 'text';
        input.value = String(spec.default || '');
        if (spec.placeholder) input.placeholder = spec.placeholder;
        input.style.width = '100%';
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
      if (spec.pivotCurrent) input.dataset.pivotCurrent = '1';
      input.addEventListener('input', () => {
        if (spec.type === 'range' || spec.type === 'number') labVal.textContent = String(input.value);
        _mtSchedulePreview();
      });
      input.addEventListener('change', () => _mtSchedulePreview());
      wrap.appendChild(input);
      // Optional "reset to the mesh's current triangle count" button.
      if (spec.resetToCurrent) {
        const rb = document.createElement('button');
        rb.id = 'mt-reset-current';
        rb.className = 'secondary-btn';
        rb.style.cssText = 'margin-top:4px; padding:4px 8px; font-size:11px; width:100%;';
        rb.textContent = '↺ Actuel';
        rb.onclick = () => {
          const n = _mtCurrentTriCount();
          if (!n) { showToast('Mesh pas encore chargé', 'info', 1200); return; }
          if (n > Number(input.max)) input.max = String(n);  // let the slider reach it
          input.value = String(n);
          labVal.textContent = String(n);
          _mtSchedulePreview();
        };
        wrap.appendChild(rb);
      }
      // Optional "🎲 new variation" button (random seed) — each click/open
      // gives a different texture from the same mesh + reference.
      if (spec.randomize) {
        const lo = spec.min || 0, hi = spec.max || 999999;
        const roll = () => Math.floor(Math.random() * (hi - lo + 1)) + lo;
        input.value = String(roll());            // fresh variation on open
        labVal.textContent = String(input.value);
        const db = document.createElement('button');
        db.className = 'secondary-btn';
        db.style.cssText = 'margin-top:4px; padding:4px 8px; font-size:11px; width:100%;';
        db.textContent = '🎲 Nouvelle variation';
        db.onclick = () => {
          input.value = String(roll());
          labVal.textContent = String(input.value);
          _mtSchedulePreview();
        };
        wrap.appendChild(db);
      }
      body.appendChild(wrap);
    });
  }

  const close = () => {
    modal.classList.add('hidden');
    applyBtn.onclick = null;
    cancelBtn.onclick = null;
    if (closeX) closeX.onclick = null;
    _mtClearOverlays();
    _mtClearWireframes();
    // Restore original geoms (memory hygiene).
    for (const e of mtState.origGeoms) { e.mesh.geometry = e.originalGeom; }
  };
  cancelBtn.onclick = close;
  if (closeX) closeX.onclick = close;
  applyBtn.onclick = async () => {
    const vals = _mtCollectVals(body);
    if (schema.confirm && !await customConfirm(schema.confirm, schema.title, 'Continue')) return;
    const ctx = { imagePath: p.selectedImagePath, meshPath: p.selectedMeshPath };
    // A schema can pick the operation at apply time (e.g. Triangle count
    // decides decimate vs subdivide from the target vs the current count).
    if (typeof schema.resolveOp === 'function') {
      const r = schema.resolveOp(vals, ctx);
      if (!r || !r.operation) { showToast('Cible ≈ compte actuel — rien à faire', 'info', 1800); return; }
      close();
      runMeshTool(r.operation, r.params || []);
      return;
    }
    const params = schema.build(vals, ctx);
    close();
    runMeshTool(toolName, params);
  };
  modal.classList.remove('hidden');

  // Init viewport then load mesh; preview kicks off once geoms are cached.
  requestAnimationFrame(async () => {
    await _mtInitViewport();
    _mtLoadMesh(p.selectedMeshPath);
  });
}

document.getElementById('ws-mesh-smooth-btn')?.addEventListener('click', () => openMeshToolModal('smooth'));
document.getElementById('ws-mesh-decimate-btn')?.addEventListener('click', () => openMeshToolModal('triangle_count'));
// Subdivide is merged into Triangle count (drag above the current count) —
// hide the standalone button.
(() => { const b = document.getElementById('ws-mesh-subdivide-btn'); if (b) b.style.display = 'none'; })();
document.getElementById('ws-mesh-fixnormals-btn')?.addEventListener('click', () => openMeshToolModal('fix_normals'));
document.getElementById('ws-mesh-fillholes-btn')?.addEventListener('click', () => openMeshToolModal('fill_holes'));
document.getElementById('ws-mesh-center-btn')?.addEventListener('click', () => openMeshToolModal('set_pivot'));
document.getElementById('ws-mesh-watertight-btn')?.addEventListener('click', () => openMeshToolModal('watertight'));
document.getElementById('ws-mesh-texvar-btn')?.addEventListener('click', () => openMeshToolModal('texture_var'));
document.getElementById('ws-mesh-retexture-btn')?.addEventListener('click', () => openMeshToolModal('retexture'));
document.getElementById('ws-mesh-trellis2-btn')?.addEventListener('click', () => openMeshToolModal('trellis2_retex'));

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
    if (atState.controls) atState.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN,
    };
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

// ============================================================
// PAINT EMISSIVE TOOL (desktop) — raycast-driven painting onto a
// separate T_emissive texture. Mirrors the cloud build verbatim
// except the Apply path: cloud uploads to R2 via the worker, desktop
// saves locally via API.saveBuffer next to the source mesh.
// ============================================================
const PE_TEX_SIZE = 1024;

const peState = {
  renderer: null, scene: null, camera: null, controls: null,
  rafId: null,
  origModel: null,
  meshes: [],                  // [{ mesh, prev: [{ mat, emissiveMap, ... }] }]
  raycaster: null,
  pointer: null,
  canvases: null,              // Map<Mesh, { canvas, ctx, texture }>
  brushColor: '#ffaa33',
  brushSize: 40,
  brushOpacity: 1.0,
  brushFalloff: 0.5,
  brushMode: 'paint',
  intensity: 1.0,
  isPainting: false,
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
    peState.controls.mouseButtons = {
      LEFT: null,
      MIDDLE: THREE.MOUSE.ROTATE,
      RIGHT: THREE.MOUSE.PAN,
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

function _peSetupCanvasAndBind() {
  peState.canvases = new Map();
  peState.meshes.forEach((entry) => {
    const canvas = document.createElement('canvas');
    canvas.width = PE_TEX_SIZE;
    canvas.height = PE_TEX_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, PE_TEX_SIZE, PE_TEX_SIZE);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false;
    texture.name = 'T_emissive';
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
      mat.emissive = new THREE.Color(0xffffff);
      mat.emissiveIntensity = peState.intensity;
      mat.needsUpdate = true;
    });
  });
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

async function _peLoadMesh(meshPath) {
  if (peState.origModel) {
    peState.scene.remove(peState.origModel);
    peState.origModel = null;
  }
  peState.meshes = [];
  // Desktop uses API.readMeshFile to bypass file:// CORS rules.
  let buffer;
  try {
    buffer = await API.readMeshFile(meshPath);
  } catch (e) {
    console.error('[paint-emissive] readMeshFile failed:', e);
    showToast('Mesh load failed: ' + (e?.message || e), 'error', 5000);
    return;
  }
  if (!buffer) {
    showToast('Mesh load returned empty buffer.', 'error', 5000);
    return;
  }
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
    _peTryProjectFromImageLayer();
  });
}

async function _peProjectImageLayer(imgPath) {
  const layerDataUrl = _emissiveLayerGet(imgPath);
  if (!layerDataUrl) return false;
  if (!peState.origModel || !peState.canvases) return false;
  if (peState.projecting) return false;
  peState.projecting = true;
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
    return false;
  }
  const pad = scanStride * 2;
  bbXmin = Math.max(0, bbXmin - pad);
  bbYmin = Math.max(0, bbYmin - pad);
  bbXmax = Math.min(srcW - 1, bbXmax + pad);
  bbYmax = Math.min(srcH - 1, bbYmax + pad);
  const box = new THREE.Box3().setFromObject(peState.origModel);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
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
          if (uvBuffer[ri + 2] < 200) continue;
          const px = (uvBuffer[ri] / 255) * TEX;
          const py = (uvBuffer[ri + 1] / 255) * TEX;
          ctx.fillStyle = `rgba(${srcData[si]}, ${srcData[si+1]}, ${srcData[si+2]}, ${a / 255})`;
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
  if (peState.projecting) return;
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
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    entry.texture.needsUpdate = true;
    return;
  }
  // 3D-aware stamping — kills the "stray paint on the ground when I
  // clicked the sign" issue from overlapping UV islands in Trellis2's
  // texture atlas. Only triangles physically close (in 3D) to the
  // hit point can pick up the brush.
  const localHit = mesh.worldToLocal(hit.point.clone());
  const cam = peState.camera;
  const camDist = cam.position.distanceTo(hit.point);
  const viewH = peState.renderer.domElement.clientHeight || 600;
  const heightAtDist = 2 * camDist * Math.tan((cam.fov * Math.PI / 180) / 2);
  const unitsPerPx = heightAtDist / viewH;
  const R3D = peState.brushSize * 0.5 * unitsPerPx * 1.2;
  const R3DSq = R3D * R3D;
  const posArr = posAttr.array;
  const uvArr = uvAttr.array;
  const triCount = idx ? Math.floor(idx.length / 3) : Math.floor(posAttr.count / 3);
  ctx.save();
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.clip();
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

function openPaintEmissive() {
  const p = state.currentProject;
  if (!p || !p.selectedMeshPath) { showToast('Pick a mesh first.', 'error'); return; }
  const modal = document.getElementById('modal-paint-emissive');
  if (!modal) return;
  modal.classList.remove('hidden');

  const $ = (id) => document.getElementById(id);
  $('pe-color').oninput = (e) => { peState.brushColor = e.target.value; };
  peState.brushColor = $('pe-color').value;
  $('pe-intensity').oninput = (e) => {
    const v = Number(e.target.value);
    peState.intensity = v;
    $('pe-intensity-val').textContent = String(v);
    peState.meshes.forEach((entry) => {
      const mats = Array.isArray(entry.mesh.material) ? entry.mesh.material : [entry.mesh.material];
      mats.forEach((m) => { m.emissiveIntensity = v; m.needsUpdate = true; });
    });
  };
  $('pe-brush-size').oninput = (e) => {
    peState.brushSize = Number(e.target.value);
    $('pe-brush-size-val').textContent = e.target.value;
  };
  $('pe-brush-opacity').oninput = (e) => {
    peState.brushOpacity = Number(e.target.value) / 100;
    $('pe-brush-opacity-val').textContent = e.target.value + '%';
  };
  $('pe-brush-falloff').oninput = (e) => {
    peState.brushFalloff = Number(e.target.value) / 100;
    $('pe-brush-falloff-val').textContent = e.target.value + '%';
  };
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
    try { await _peTryProjectFromImageLayer(); }
    finally { btn.disabled = false; btn.textContent = orig; }
  };
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

  requestAnimationFrame(async () => {
    await _peInitViewport();
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
      if (e.button !== 0) return;
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
    let bin = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    const b64 = btoa(bin);
    // Desktop: write the new GLB next to the source with an _emissive
    // suffix + timestamp, then push the local path into project.meshes.
    const p = state.currentProject;
    const srcPath = (p?.selectedMeshPath || 'mesh.glb').replace(/\\/g, '/');
    const meshDir = srcPath.split('/').slice(0, -1).join('/');
    const origName = (srcPath.split('/').pop() || 'mesh.glb').replace(/\.[^.]+$/, '');
    const newPath = (meshDir ? meshDir + '/' : '') + origName + '_emissive_' + Date.now() + '.glb';
    const r = await API.saveBuffer({ path: newPath, base64: b64 });
    if (!r || !r.success) {
      throw new Error((r && r.error) || 'saveBuffer returned no success');
    }
    showToast('Paint Emissive saved!', 'success');
    if (p) {
      const filename = newPath.split('/').pop();
      let size = 0;
      try { const info = await API.getFileInfo(newPath); size = info?.size || 0; } catch {}
      p.meshes = p.meshes || [];
      p.meshes.unshift({ path: newPath, filename, size, mtime: Date.now() });
      p.selectedMeshPath = newPath;
      p.previewMeshPath = newPath;
      if (typeof populateWorkspace === 'function') {
        try { await populateWorkspace(p); } catch {}
      }
    }
  } finally {
    peState.origModel.position.copy(savedPos);
  }
}

document.getElementById('ws-mesh-paint-emissive-btn')?.addEventListener('click', openPaintEmissive);

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
    // Hue rotation uses a real RGB→HSV→shift→RGB roundtrip so it matches
    // PIL's behaviour on save (previous YIQ-style matrix had bad coefs).
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
  showToast('Applying material adjustments…', 'info', 2000);
  try {
    const r = await API.materialAdjust({
      meshPath: p.selectedMeshPath,
      ...params,
    });
    if (r?.success) {
      showToast(`Material saved → ${r.filename}`, 'success');
      closeMaterialAdjust();
      populateWorkspace(p);
    } else {
      showToast('Material adjust failed: ' + (r?.error || 'unknown'), 'error', 5000);
    }
  } catch (e) {
    showToast('Material adjust error: ' + e.message, 'error', 5000);
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
  symOffset: { x: 0, y: 0, z: 0 },   // symmetry plane position along each axis (mesh-local)
  symPlanes: { x: null, y: null, z: null },
  symHandles: { x: null, y: null, z: null },  // draggable gizmo per plane
  draggingPlane: null,   // axis currently being dragged via its gizmo
  grabAnchor: null,      // mesh-local anchor point captured on pointerdown
  grabScreen: null,      // {x,y} screen coords captured on pointerdown
  grabMesh: null,        // mesh object the grab stroke is acting on
  grabLastDelta: null,   // last applied local-space translation (THREE.Vector3)
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
  // Was missing — opening straight into Select mode left the Selection/Edit
  // panel hidden until you clicked the Select button a second time.
  document.getElementById('me-select-opts').style.display = mode === 'select' ? 'flex' : 'none';
  // Default the Select sub-mode to Add each time the panel opens.
  meState.selectErase = false;
  meState.viewMode = 'none';
  document.getElementById('me-sel-add')?.classList.add('tool-active');
  document.getElementById('me-sel-erase')?.classList.remove('tool-active');
  document.getElementById('me-sel-isolate')?.classList.remove('tool-active');
  document.getElementById('me-sel-hide')?.classList.remove('tool-active');
  _meUpdateSelButtons();

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
  if (meState.controls) {
    // Left button stays FREE for the brush (paint / sculpt / select directly
    // on the mesh — no more "click next to the mesh to rotate"). Rotate with
    // the MIDDLE (wheel) button drag, pan with right, scroll wheel zooms.
    try {
      meState.controls.mouseButtons = {
        LEFT: null,
        MIDDLE: THREE.MOUSE.ROTATE,
        RIGHT: THREE.MOUSE.PAN,
      };
    } catch (_) {}
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
    // Selection + adjacency caches reference indices/positions that just
    // changed — drop them so they rebuild, and the restored faces aren't
    // left "selected".
    geom._selSaved = new Map();
    geom._posGroups = null;
    geom._posKeyByIndex = null;
    geom.computeVertexNormals();
  }
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
  _meUpdateSelButtons();
  _meUpdateUndoBtns();
}
function _meRedo() {
  if (meState.redoStack.length === 0) return;
  meState.undoStack.push(_meSnapshot());   // current -> undo
  _meRestore(meState.redoStack.pop());
  _meUpdateSelButtons();
  _meUpdateUndoBtns();
}

function _meUpdateUndoBtns() {
  const u = document.getElementById('me-undo');
  const r = document.getElementById('me-redo');
  if (u) u.disabled = meState.undoStack.length === 0;
  if (r) r.disabled = meState.redoStack.length === 0;
}

// Raycast the symmetry-plane gizmo handles; returns the grabbed axis or null.
function _meRaycastHandles(e) {
  const handles = [];
  for (const a of ['x', 'y', 'z']) if (meState.symHandles[a]) handles.push(meState.symHandles[a]);
  if (!handles.length) return null;
  const rect = meState.renderer.domElement.getBoundingClientRect();
  meState.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  meState.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  meState.raycaster.setFromCamera(meState.mouse, meState.camera);
  const hits = meState.raycaster.intersectObjects(handles, false);
  return hits.length ? hits[0].object.userData.symAxis : null;
}
// Drag the grabbed symmetry plane along its axis: closest point on the axis
// line (through the origin) to the mouse ray sets the offset.
function _meDragPlaneAxis(e) {
  const axis = meState.draggingPlane;
  const rect = meState.renderer.domElement.getBoundingClientRect();
  meState.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  meState.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  meState.raycaster.setFromCamera(meState.mouse, meState.camera);
  const ray = meState.raycaster.ray;
  const ld = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
  // Line through the handle's (corner) in-plane position, parameterised along
  // the axis — so dragging the corner handle maps directly to the offset.
  const handle = meState.symHandles[axis];
  const lp = handle ? handle.position.clone() : new THREE.Vector3(0, 0, 0);
  lp[axis] = 0;
  const w0 = lp.clone().sub(ray.origin);
  const b = ld.dot(ray.direction), d = ld.dot(w0), eDot = ray.direction.dot(w0);
  const denom = 1 - b * b;
  if (Math.abs(denom) > 1e-5) {
    let s = (b * eDot - d) / denom;
    s = Math.max(-3, Math.min(3, s));
    meState.symOffset[axis] = s;
    _meUpdateSymPlanes();
  }
}
function _meMouseDown(e) {
  if (e.button !== 0 || e.altKey) return;
  // Grabbing a symmetry-plane gizmo handle starts a drag (not a paint stroke).
  const gAxis = _meRaycastHandles(e);
  if (gAxis) {
    meState.draggingPlane = gAxis;
    if (meState.controls) meState.controls.enabled = false;
    return;
  }
  const hit = _meGetIntersection(e);
  if (!hit) return;
  // Eyedropper: sample the colour under the cursor instead of painting.
  if (meState.mode === 'paint' && meState.pickMode) {
    const geom = hit.object.geometry;
    const fa = hit.face?.a;
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
  // Dragging a symmetry-plane gizmo handle takes priority over the brush.
  if (meState.draggingPlane) { _meDragPlaneAxis(e); return; }
  // Always update cursor position (cheap, no raycasting)
  const cursor = document.getElementById('me-brush-cursor');
  if (cursor) {
    // Size the ring to the REAL brush footprint in screen pixels (was a fixed
    // *500 that ignored zoom). Project the world-space brush radius at the
    // camera→target depth: pxPerWorld = canvasHeight / (2*dist*tan(fov/2)).
    let screenSize = meState.brushRadius * 500;  // fallback
    try {
      const cam = meState.camera, ctrl = meState.controls, rndr = meState.renderer;
      if (cam && ctrl && rndr) {
        const dist = cam.position.distanceTo(ctrl.target);
        const canvasH = rndr.domElement.clientHeight || 600;
        const pxPerWorld = canvasH / (2 * dist * Math.tan((cam.fov * Math.PI / 180) / 2));
        screenSize = 2 * meState.brushRadius * pxPerWorld;
      }
    } catch (_) {}
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
  if (meState.draggingPlane) {
    meState.draggingPlane = null;
    if (meState.controls) meState.controls.enabled = true;
    return;
  }
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
    if (meState.mode === 'select') _meUpdateSelButtons();
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
  localDelta.transformDirection(m);
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

// Per-geometry selection set: Map<vertexIndex, [r,g,b]> storing the colour that
// was under each selected vertex (so deselect/clear restores the paint instead
// of wiping it). Selection is tracked here, NOT inferred from the cyan colour.
function _meSelMap(geom) {
  if (!geom._selSaved) geom._selSaved = new Map();
  return geom._selSaved;
}
function _meHasSelection() {
  let has = false;
  meState.mesh?.traverse(c => { if (c.isMesh && c.geometry?._selSaved && c.geometry._selSaved.size > 0) has = true; });
  return has;
}
// Position-welded adjacency: GLB meshes often duplicate vertices at seams, so
// index adjacency alone stops Grow/Shrink at those gaps. Group vertices by
// rounded position so co-located vertices act as one for organic spreading.
function _meBuildPosAdj(geom) {
  if (geom._posGroups && geom._posKeyByIndex) return;
  const pos = geom.attributes.position;
  const groups = new Map();
  const keyByIndex = new Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const k = Math.round(pos.getX(i) * 1e5) + ',' + Math.round(pos.getY(i) * 1e5) + ',' + Math.round(pos.getZ(i) * 1e5);
    keyByIndex[i] = k;
    let arr = groups.get(k);
    if (!arr) { arr = []; groups.set(k, arr); }
    arr.push(i);
  }
  geom._posGroups = groups;
  geom._posKeyByIndex = keyByIndex;
}
// Enable selection-dependent buttons only when something is selected.
function _meUpdateSelButtons() {
  const has = _meHasSelection();
  // The "Garder le reste" row only makes sense alongside a usable Crop.
  const keepRestRow = document.getElementById('me-sel-crop-keeprest-row');
  if (keepRestRow) keepRestRow.style.display = has ? 'flex' : 'none';
  for (const id of ['me-sel-grow', 'me-sel-shrink', 'me-sel-clear', 'me-sel-delete', 'me-sel-duplicate', 'me-sel-crop', 'me-sel-isolate', 'me-sel-hide', 'me-sel-flip', 'me-sel-smooth']) {
    const b = document.getElementById(id);
    if (!b) continue;
    b.disabled = !has;
    b.style.opacity = has ? '' : '0.4';
    b.style.cursor = has ? '' : 'not-allowed';
  }
}
// Brush application points: the hit point + its mirror across each active
// symmetry axis (mesh-local space) so paint/select honour symmetry like sculpt.
function _meBrushPoints(point) {
  const pts = [point];
  const ax = meState.symmetryAxes;
  const o = meState.symOffset || { x: 0, y: 0, z: 0 };
  if (ax.x || ax.y || ax.z) {
    // Each combo = which axes to reflect; reflection across the plane at the
    // gizmo offset: coord -> 2*offset - coord (not just -coord around origin).
    const combos = [];
    if (ax.x) combos.push([1, 0, 0]);
    if (ax.y) combos.push([0, 1, 0]);
    if (ax.z) combos.push([0, 0, 1]);
    if (ax.x && ax.y) combos.push([1, 1, 0]);
    if (ax.x && ax.z) combos.push([1, 0, 1]);
    if (ax.y && ax.z) combos.push([0, 1, 1]);
    if (ax.x && ax.y && ax.z) combos.push([1, 1, 1]);
    for (const c of combos) {
      const mp = point.clone();
      if (c[0]) mp.x = 2 * o.x - point.x;
      if (c[1]) mp.y = 2 * o.y - point.y;
      if (c[2]) mp.z = 2 * o.z - point.z;
      pts.push(mp);
    }
  }
  return pts;
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
    // Ensure vertex colors exist
    if (!geom.attributes.color) {
      const colors = new Float32Array(pos.count * 3).fill(1);
      geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      hit.object.material.vertexColors = true;
      hit.object.material.needsUpdate = true;
    }
    const colorAttr = geom.attributes.color;
    const c = new THREE.Color(meState.color);
    const pts = _meBrushPoints(point);  // main point + symmetry mirrors
    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i);
      let distSq = Infinity;  // nearest brush point (main or mirrored)
      for (const pt of pts) {
        const dx = vx - pt.x, dy = vy - pt.y, dz = vz - pt.z;
        if (Math.abs(dx) > r || Math.abs(dy) > r || Math.abs(dz) > r) continue;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < distSq) distSq = d2;
      }
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
    const geom = hit.object.geometry;
    const pos = geom.attributes.position;
    const r = meState.brushRadius;
    const rSq = r * r;
    if (!geom.attributes.color) {
      // White base so unselected faces keep the texture untinted.
      const colors = new Float32Array(pos.count * 3).fill(1);
      geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      hit.object.material.vertexColors = true;
      hit.object.material.needsUpdate = true;
    }
    const colorAttr = geom.attributes.color;
    const sel = _meSelMap(geom);   // index -> saved (paint) colour under the selection
    const pts = _meBrushPoints(point);  // main point + symmetry mirrors
    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i);
      let inBrush = false;
      for (const pt of pts) {
        const dx = vx - pt.x, dy = vy - pt.y, dz = vz - pt.z;
        if (Math.abs(dx) > r || Math.abs(dy) > r || Math.abs(dz) > r) continue;
        if (dx * dx + dy * dy + dz * dz <= rSq) { inBrush = true; break; }
      }
      if (!inBrush) continue;
      if (meState.selectErase) {
        // Deselect: restore the painted colour we saved (NOT gray) so vertex
        // paint survives an erase.
        if (sel.has(i)) { const o = sel.get(i); colorAttr.setXYZ(i, o[0], o[1], o[2]); sel.delete(i); }
      } else {
        // Select: remember the current (painted) colour, then show cyan.
        if (!sel.has(i)) sel.set(i, [colorAttr.getX(i), colorAttr.getY(i), colorAttr.getZ(i)]);
        colorAttr.setXYZ(i, 0.0, 1.0, 1.0);
      }
    }
    colorAttr.needsUpdate = true;
  }
}

// Close mesh edit
function _closeMeshEdit() {
  _meRestoreView();
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
    // Title reflects the active mode.
    const _t = document.getElementById('mesh-edit-title');
    if (_t) _t.textContent = mode === 'sculpt' ? 'Sculpt Mesh' : mode === 'paint' ? 'Vertex Paint' : 'Select Faces';
    if (mode === 'select') _meUpdateSelButtons();
  });
});
// Refresh selection-button enabled state after any Select-panel action.
document.getElementById('me-select-opts')?.addEventListener('click', () => setTimeout(_meUpdateSelButtons, 0));
// Sculpt sub-modes
['push', 'pull', 'smooth', 'flatten', 'grab', 'inflate'].forEach(sm => {
  document.getElementById('me-sculpt-' + sm)?.addEventListener('click', () => {
    meState.sculptMode = sm;
    ['push', 'pull', 'smooth', 'flatten', 'grab', 'inflate'].forEach(s => document.getElementById('me-sculpt-' + s)?.classList.toggle('tool-active', s === sm));
  });
});
// Semi-transparent symmetry plane(s) in the viewport — one per active mirror
// axis (the plane the brush mirrors across, at the world origin). Sized to the
// mesh bounds. Colours: X=red, Y=green, Z=blue.
function _meUpdateSymPlanes() {
  if (!meState.scene) return;
  if (!meState.symPlanes) meState.symPlanes = { x: null, y: null, z: null };
  let size = 2;
  try {
    if (meState.mesh) {
      const s = new THREE.Box3().setFromObject(meState.mesh).getSize(new THREE.Vector3());
      size = (Math.max(s.x, s.y, s.z) || 1.5) * 1.4;
    }
  } catch (_) {}
  const defs = {
    x: { color: 0xff5577, rot: [0, Math.PI / 2, 0] },   // YZ plane, normal X
    y: { color: 0x55ff77, rot: [-Math.PI / 2, 0, 0] },  // XZ plane, normal Y
    z: { color: 0x5599ff, rot: [0, 0, 0] },             // XY plane, normal Z
  };
  for (const axis of ['x', 'y', 'z']) {
    const want = meState.symmetryAxes[axis];
    let plane = meState.symPlanes[axis];
    let handle = meState.symHandles[axis];
    if (want && !plane) {
      const mat = new THREE.MeshBasicMaterial({ color: defs[axis].color, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
      plane = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
      plane.rotation.set(defs[axis].rot[0], defs[axis].rot[1], defs[axis].rot[2]);
      plane.renderOrder = 999;
      meState.scene.add(plane);
      meState.symPlanes[axis] = plane;
      // Draggable gizmo handle (bright sphere) at the plane centre — drag it
      // along the axis to move the symmetry plane.
      const hmat = new THREE.MeshBasicMaterial({ color: defs[axis].color, depthTest: false, transparent: true, opacity: 0.9 });
      handle = new THREE.Mesh(new THREE.SphereGeometry(Math.max(size * 0.026, 0.014), 16, 12), hmat);
      handle.renderOrder = 1000;
      handle.userData.symAxis = axis;  // tag so the pointer handler can grab it
      meState.scene.add(handle);
      meState.symHandles[axis] = handle;
    } else if (!want && plane) {
      meState.scene.remove(plane);
      try { plane.geometry.dispose(); plane.material.dispose(); } catch (_) {}
      meState.symPlanes[axis] = null;
      if (handle) { meState.scene.remove(handle); try { handle.geometry.dispose(); handle.material.dispose(); } catch (_) {} meState.symHandles[axis] = null; }
      continue;
    } else if (want && plane) {
      try { plane.geometry.dispose(); plane.geometry = new THREE.PlaneGeometry(size, size); } catch (_) {}
    }
    // Plane centred at the offset; handle parked at a CORNER of the plane so
    // it doesn't sit over the mesh. Its axis coord still = the plane offset.
    if (plane) { plane.position.set(0, 0, 0); plane.position[axis] = meState.symOffset[axis]; }
    if (handle) {
      const cc = size * 0.42;
      const inp = { x: ['y', 'z'], y: ['x', 'z'], z: ['x', 'y'] }[axis];
      handle.position.set(0, 0, 0);
      handle.position[axis] = meState.symOffset[axis];
      handle.position[inp[0]] = cc;
      handle.position[inp[1]] = cc;
    }
  }
}
// Symmetry toggles
['x', 'y', 'z'].forEach(axis => {
  const btn = document.getElementById('me-sym-' + axis);
  const col = { x: '#ff5577', y: '#55ff77', z: '#5599ff' }[axis];
  btn?.addEventListener('click', () => {
    const on = !meState.symmetryAxes[axis];
    meState.symmetryAxes[axis] = on;
    // Active state = the axis colour, NOT the default orange. !important beats
    // the .tool-active class, and we don't add that class for these buttons.
    btn.classList.remove('tool-active');
    btn.style.setProperty('background', on ? col : 'transparent', 'important');
    btn.style.setProperty('color', on ? '#111' : col, 'important');
    btn.style.setProperty('border-color', col, 'important');
    _meUpdateSymPlanes();
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
// Select sub-mode: paint to Add (cyan) vs Erase (back to unselected base).
document.getElementById('me-sel-add')?.addEventListener('click', () => {
  meState.selectErase = false;
  document.getElementById('me-sel-add')?.classList.add('tool-active');
  document.getElementById('me-sel-erase')?.classList.remove('tool-active');
});
document.getElementById('me-sel-erase')?.addEventListener('click', () => {
  meState.selectErase = true;
  document.getElementById('me-sel-erase')?.classList.add('tool-active');
  document.getElementById('me-sel-add')?.classList.remove('tool-active');
});
// Select actions
document.getElementById('me-sel-delete')?.addEventListener('click', () => {
  if (!meState.mesh) return;
  _meRestoreView();
  _mePushUndo();
  let any = false;
  meState.mesh.traverse(c => {
    if (!c.isMesh || !c.geometry || !c.geometry.index) return;
    const geom = c.geometry;
    const sel = geom._selSaved;
    if (!sel || sel.size === 0) return;
    const idx = geom.index.array;
    const keep = [];
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i], b = idx[i + 1], d = idx[i + 2];
      if (!(sel.has(a) || sel.has(b) || sel.has(d))) keep.push(a, b, d);
    }
    geom.setIndex(keep);
    geom.attributes.position.needsUpdate = true;
    geom._selSaved = new Map();   // selection consumed
    any = true;
  });
  showToast(any ? 'Selected faces deleted' : 'Nothing selected', any ? 'success' : 'info', 1500);
});
document.getElementById('me-sel-invert')?.addEventListener('click', () => {
  meState.mesh?.traverse(c => {
    if (!c.isMesh || !c.geometry?.attributes?.color) return;
    const color = c.geometry.attributes.color;
    const sel = _meSelMap(c.geometry);
    for (let i = 0; i < color.count; i++) {
      if (sel.has(i)) { const o = sel.get(i); color.setXYZ(i, o[0], o[1], o[2]); sel.delete(i); }
      else { sel.set(i, [color.getX(i), color.getY(i), color.getZ(i)]); color.setXYZ(i, 0.0, 1.0, 1.0); }
    }
    color.needsUpdate = true;
  });
});
document.getElementById('me-sel-clear')?.addEventListener('click', () => {
  meState.mesh?.traverse(c => {
    if (!c.isMesh || !c.geometry?.attributes?.color) return;
    const color = c.geometry.attributes.color;
    const sel = c.geometry._selSaved;
    if (sel && sel.size) {
      // Deselect everything but KEEP the paint underneath.
      for (const [i, o] of sel) color.setXYZ(i, o[0], o[1], o[2]);
      color.needsUpdate = true;
      c.geometry._selSaved = new Map();
    }
  });
});
// --- Extra Select tools: All / Grow / Shrink ---
function _meEnsureColor(c) {
  const geom = c.geometry;
  if (!geom.attributes.color) {
    geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(geom.attributes.position.count * 3).fill(1), 3));
    c.material.vertexColors = true; c.material.needsUpdate = true;
  }
  return geom.attributes.color;
}
document.getElementById('me-sel-all')?.addEventListener('click', () => {
  meState.mesh?.traverse(c => {
    if (!c.isMesh || !c.geometry?.attributes?.position) return;
    const color = _meEnsureColor(c), sel = _meSelMap(c.geometry);
    for (let i = 0; i < color.count; i++) {
      if (!sel.has(i)) sel.set(i, [color.getX(i), color.getY(i), color.getZ(i)]);
      color.setXYZ(i, 0, 1, 1);
    }
    color.needsUpdate = true;
  });
});
document.getElementById('me-sel-grow')?.addEventListener('click', () => {
  meState.mesh?.traverse(c => {
    if (!c.isMesh || !c.geometry?.index || !c.geometry.attributes.color) return;
    const geom = c.geometry, color = geom.attributes.color, sel = _meSelMap(geom), idx = geom.index.array;
    if (sel.size === 0) return;
    _meBuildPosAdj(geom);
    const keyOf = geom._posKeyByIndex, groups = geom._posGroups;
    const selKeys = new Set();
    for (const i of sel.keys()) selKeys.add(keyOf[i]);
    // Any triangle touching a selected POSITION pulls in all its vertices'
    // position groups → spreads organically across welded/unwelded seams.
    const addKeys = new Set();
    for (let t = 0; t < idx.length; t += 3) {
      const ka = keyOf[idx[t]], kb = keyOf[idx[t + 1]], kd = keyOf[idx[t + 2]];
      if (selKeys.has(ka) || selKeys.has(kb) || selKeys.has(kd)) { addKeys.add(ka); addKeys.add(kb); addKeys.add(kd); }
    }
    for (const k of addKeys) for (const v of groups.get(k)) {
      if (!sel.has(v)) { sel.set(v, [color.getX(v), color.getY(v), color.getZ(v)]); color.setXYZ(v, 0, 1, 1); }
    }
    color.needsUpdate = true;
  });
});
document.getElementById('me-sel-shrink')?.addEventListener('click', () => {
  meState.mesh?.traverse(c => {
    if (!c.isMesh || !c.geometry?.index || !c.geometry.attributes.color) return;
    const geom = c.geometry, color = geom.attributes.color, sel = _meSelMap(geom), idx = geom.index.array;
    if (sel.size === 0) return;
    _meBuildPosAdj(geom);
    const keyOf = geom._posKeyByIndex, groups = geom._posGroups;
    const selKeys = new Set();
    for (const i of sel.keys()) selKeys.add(keyOf[i]);
    // A selected position on the boundary (a triangle that also has an
    // unselected position) gets peeled off.
    const removeKeys = new Set();
    for (let t = 0; t < idx.length; t += 3) {
      const ka = keyOf[idx[t]], kb = keyOf[idx[t + 1]], kd = keyOf[idx[t + 2]];
      const sa = selKeys.has(ka), sb = selKeys.has(kb), sd = selKeys.has(kd);
      if (!(sa && sb && sd)) { if (sa) removeKeys.add(ka); if (sb) removeKeys.add(kb); if (sd) removeKeys.add(kd); }
    }
    for (const k of removeKeys) for (const v of groups.get(k)) {
      if (sel.has(v)) { const o = sel.get(v); color.setXYZ(v, o[0], o[1], o[2]); sel.delete(v); }
    }
    color.needsUpdate = true;
  });
});
// --- View toggles: Isolate (show only selection) / Hide (hide selection) ---
// Non-destructive: backs up the live index, never touches the undo stack.
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
  _meRestoreView();                  // always start from the full mesh
  if (wasActive) return;             // clicking the active toggle turns it off
  if (!_meHasSelection()) { showToast('Select faces first', 'info', 1400); return; }
  let any = false;
  meState.mesh.traverse(c => {
    if (!c.isMesh || !c.geometry?.index) return;
    const geom = c.geometry, sel = geom._selSaved;
    if (!sel || !sel.size) return;
    geom._viewBackup = new THREE.BufferAttribute(geom.index.array.slice(), 1);
    const idx = geom.index.array, keep = [];
    for (let i = 0; i < idx.length; i += 3) {
      const hit = sel.has(idx[i]) || sel.has(idx[i + 1]) || sel.has(idx[i + 2]);
      if (mode === 'isolate' ? hit : !hit) keep.push(idx[i], idx[i + 1], idx[i + 2]);
    }
    geom.setIndex(keep);
    geom.attributes.position.needsUpdate = true;
    any = true;
  });
  if (any) {
    meState.viewMode = mode;
    document.getElementById('me-sel-' + mode)?.classList.add('tool-active');
  }
}
document.getElementById('me-sel-isolate')?.addEventListener('click', () => _meApplyView('isolate'));
document.getElementById('me-sel-hide')?.addEventListener('click', () => _meApplyView('hide'));

// --- Crop: keep ONLY the selected faces — or, when "Garder le reste" is
// checked, keep the REST and drop the selection instead. ---
document.getElementById('me-sel-crop')?.addEventListener('click', () => {
  if (!meState.mesh || !_meHasSelection()) return;
  const keepRest = !!document.getElementById('me-sel-crop-keeprest')?.checked;
  _meRestoreView();
  _mePushUndo();
  let any = false;
  meState.mesh.traverse(c => {
    if (!c.isMesh || !c.geometry?.index) return;
    const geom = c.geometry, sel = geom._selSaved;
    if (!sel || !sel.size) return;
    const idx = geom.index.array, keep = [];
    for (let i = 0; i < idx.length; i += 3) {
      const hit = sel.has(idx[i]) || sel.has(idx[i + 1]) || sel.has(idx[i + 2]);
      // keepRest → keep the unselected faces; else → keep the selected faces.
      if (keepRest ? !hit : hit) keep.push(idx[i], idx[i + 1], idx[i + 2]);
    }
    // Restore the selection's real colours (drop the cyan highlight), then
    // clear the selection.
    const color = geom.attributes.color;
    if (color) { for (const [i, o] of sel) color.setXYZ(i, o[0], o[1], o[2]); color.needsUpdate = true; }
    geom.setIndex(keep);
    geom.attributes.position.needsUpdate = true;
    geom._selSaved = new Map();
    geom._posGroups = null; geom._posKeyByIndex = null;
    any = true;
  });
  _meUpdateSelButtons();
  showToast(any ? (keepRest ? 'Kept the rest (selection removed)' : 'Cropped to selection') : 'Nothing selected', any ? 'success' : 'info', 1600);
});

// --- Flip normals: reverse the winding of every selected face so an
// inside-out patch faces the right way. ---
document.getElementById('me-sel-flip')?.addEventListener('click', () => {
  if (!meState.mesh || !_meHasSelection()) return;
  _meRestoreView();
  _mePushUndo();
  let n = 0;
  meState.mesh.traverse(c => {
    if (!c.isMesh || !c.geometry?.index) return;
    const geom = c.geometry, sel = geom._selSaved;
    if (!sel || !sel.size) return;
    const idx = geom.index.array;
    for (let i = 0; i < idx.length; i += 3) {
      if (sel.has(idx[i]) || sel.has(idx[i + 1]) || sel.has(idx[i + 2])) {
        const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t;  // swap b,c
        n++;
      }
    }
    geom.index.needsUpdate = true;
    geom.computeVertexNormals();
  });
  showToast(n ? `Flipped ${n} faces` : 'Nothing selected', n ? 'success' : 'info', 1400);
});

// --- Smooth selection: Laplacian smoothing applied ONLY to selected
// vertices (position-welded so it crosses GLB seams). ---
document.getElementById('me-sel-smooth')?.addEventListener('click', () => {
  if (!meState.mesh || !_meHasSelection()) return;
  _meRestoreView();
  _mePushUndo();
  let moved = 0;
  meState.mesh.traverse(c => {
    if (!c.isMesh || !c.geometry?.index || !c.geometry.attributes.position) return;
    const geom = c.geometry, sel = geom._selSaved;
    if (!sel || !sel.size) return;
    const pos = geom.attributes.position, idx = geom.index.array;
    _meBuildPosAdj(geom);
    const keyOf = geom._posKeyByIndex, groups = geom._posGroups;
    // One-ring neighbours by position key (welds seams).
    const neigh = new Map();
    const addN = (a, b) => { let s = neigh.get(keyOf[a]); if (!s) { s = new Set(); neigh.set(keyOf[a], s); } s.add(keyOf[b]); };
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i], b = idx[i + 1], d = idx[i + 2];
      addN(a, b); addN(a, d); addN(b, a); addN(b, d); addN(d, a); addN(d, b);
    }
    // Average position per key.
    const keyPos = new Map();
    for (const [k, ids] of groups) { const v = ids[0]; keyPos.set(k, [pos.getX(v), pos.getY(v), pos.getZ(v)]); }
    const lambda = 0.5;
    for (let it = 0; it < 2; it++) {
      const next = new Map();
      for (const [k, ns] of neigh) {
        if (!ns.size) continue;
        let sx = 0, sy = 0, sz = 0;
        for (const nk of ns) { const p = keyPos.get(nk); sx += p[0]; sy += p[1]; sz += p[2]; }
        const inv = 1 / ns.size, cur = keyPos.get(k);
        next.set(k, [cur[0] + lambda * (sx * inv - cur[0]), cur[1] + lambda * (sy * inv - cur[1]), cur[2] + lambda * (sz * inv - cur[2])]);
      }
      for (const [k, p] of next) keyPos.set(k, p);
    }
    // Write back ONLY selected vertices.
    for (const v of sel.keys()) {
      const p = keyPos.get(keyOf[v]);
      if (p) { pos.setXYZ(v, p[0], p[1], p[2]); moved++; }
    }
    pos.needsUpdate = true;
    geom.computeVertexNormals();
  });
  showToast(moved ? 'Smoothed selection' : 'Nothing selected', moved ? 'success' : 'info', 1400);
});

// --- Duplicate: copy the selected faces into new geometry, nudged along
// their normals so the copy is visible, then select the copy. ---
document.getElementById('me-sel-duplicate')?.addEventListener('click', () => {
  if (!meState.mesh || !_meHasSelection()) return;
  _meRestoreView();
  _mePushUndo();
  let total = 0;
  meState.mesh.traverse(c => {
    if (!c.isMesh || !c.geometry?.index) return;
    const geom = c.geometry, sel = geom._selSaved;
    if (!sel || !sel.size) return;
    const idx = geom.index.array, pos = geom.attributes.position, col = _meEnsureColor(c);
    // Collect selected triangles (any vertex selected).
    const tris = [];
    for (let i = 0; i < idx.length; i += 3) {
      if (sel.has(idx[i]) || sel.has(idx[i + 1]) || sel.has(idx[i + 2])) tris.push(idx[i], idx[i + 1], idx[i + 2]);
    }
    if (!tris.length) return;
    // Restore the source faces' real colours first so both copies show paint,
    // not the cyan highlight.
    for (const [i, o] of sel) col.setXYZ(i, o[0], o[1], o[2]);
    geom.computeBoundingBox();
    const bb = geom.boundingBox;
    const eps = (bb ? bb.min.distanceTo(bb.max) : 1) * 0.01;
    const oldV = pos.count, addV = tris.length;
    const newPos = new Float32Array((oldV + addV) * 3); newPos.set(pos.array.subarray(0, oldV * 3));
    const newCol = new Float32Array((oldV + addV) * 3); newCol.set(col.array.subarray(0, oldV * 3));
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
        newCol[w * 3] = col.getX(s); newCol[w * 3 + 1] = col.getY(s); newCol[w * 3 + 2] = col.getZ(s);
        w++;
      }
      newIdx.push(base, base + 1, base + 2);
    }
    geom.setAttribute('position', new THREE.BufferAttribute(newPos, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(newCol, 3));
    geom.setIndex(newIdx);
    // Select the duplicate (cyan), drop the old selection.
    const nsel = new Map(), ncol = geom.attributes.color;
    for (let v = oldV; v < w; v++) { nsel.set(v, [ncol.getX(v), ncol.getY(v), ncol.getZ(v)]); ncol.setXYZ(v, 0, 1, 1); }
    geom._selSaved = nsel;
    geom._posGroups = null; geom._posKeyByIndex = null;
    geom.attributes.position.needsUpdate = true;
    geom.attributes.color.needsUpdate = true;
    geom.computeVertexNormals();
    total += addV / 3;
  });
  _meUpdateSelButtons();
  showToast(total ? `Duplicated ${total} faces` : 'Nothing selected', total ? 'success' : 'info', 1500);
});

// --- Extra Paint tools: Pick / Fill / Smooth / Reset ---
document.getElementById('me-paint-pick')?.addEventListener('click', () => {
  meState.pickMode = !meState.pickMode;
  document.getElementById('me-paint-pick')?.classList.toggle('tool-active', meState.pickMode);
});
document.getElementById('me-paint-fill')?.addEventListener('click', () => {
  if (!meState.mesh) return;
  _mePushUndo();
  const col = new THREE.Color(meState.color);
  meState.mesh.traverse(c => {
    if (!c.isMesh || !c.geometry?.attributes?.position) return;
    const color = _meEnsureColor(c);
    for (let i = 0; i < color.count; i++) color.setXYZ(i, col.r, col.g, col.b);
    color.needsUpdate = true;
  });
  showToast('Filled with current colour', 'success', 1200);
});
document.getElementById('me-paint-reset')?.addEventListener('click', () => {
  if (!meState.mesh) return;
  _mePushUndo();
  meState.mesh.traverse(c => {
    if (!c.isMesh || !c.geometry?.attributes?.color) return;
    const color = c.geometry.attributes.color;
    for (let i = 0; i < color.count; i++) color.setXYZ(i, 1, 1, 1);
    color.needsUpdate = true;
    c.geometry._selSaved = new Map();
  });
  showToast('Paint reset', 'success', 1200);
});
document.getElementById('me-paint-smooth')?.addEventListener('click', () => {
  if (!meState.mesh) return;
  _mePushUndo();
  meState.mesh.traverse(c => {
    if (!c.isMesh || !c.geometry?.index || !c.geometry.attributes.color) return;
    const geom = c.geometry, color = geom.attributes.color, idx = geom.index.array, n = color.count;
    const sr = new Float32Array(n), sg = new Float32Array(n), sb = new Float32Array(n), cnt = new Float32Array(n);
    const acc = (i, j) => { sr[i] += color.getX(j); sg[i] += color.getY(j); sb[i] += color.getZ(j); cnt[i]++; };
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], d = idx[t + 2];
      acc(a, b); acc(a, d); acc(b, a); acc(b, d); acc(d, a); acc(d, b);
    }
    for (let i = 0; i < n; i++) {
      if (!cnt[i]) continue;
      color.setXYZ(i,
        color.getX(i) * 0.4 + (sr[i] / cnt[i]) * 0.6,
        color.getY(i) * 0.4 + (sg[i] / cnt[i]) * 0.6,
        color.getZ(i) * 0.4 + (sb[i] / cnt[i]) * 0.6);
    }
    color.needsUpdate = true;
  });
  showToast('Colours smoothed', 'success', 1200);
});
// Keyboard
document.addEventListener('keydown', (e) => {
  const modal = document.getElementById('modal-mesh-edit');
  if (!modal || modal.classList.contains('hidden')) return;
  if (e.key === 'Escape') _closeMeshEdit();
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); _meUndo(); }
  if ((e.ctrlKey || e.metaKey) && (e.shiftKey && e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) { e.preventDefault(); _meRedo(); }
});
// Save
document.getElementById('me-save')?.addEventListener('click', async () => {
  if (!meState.mesh || !meState.meshPath) return;
  _meRestoreView();   // never bake an isolated/hidden view into the saved GLB
  const projName = state.currentProject?.name || '';
  const job = pushJob(`Save mesh edit: ${projName}`, null, null, 8000, { sourceImageUrl: meState.meshPath, projectName: projName });
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
  const job = pushJob(`Export ${format}: ${m.filename}`, null, null, undefined, { sourceImageUrl: sourcePath, projectName: state.currentProject?.name });
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
  // Show / hide the "Use this rig for Animation -> " bar based on whether
  // there's a rig loaded. Same pattern as "Use this mesh for Rig" in step 2.
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
  // Defensive newest-first sort by real timestamp (same as renderMeshVersions)
  // so the freshest rig always gets the highest v# and the selected (i===0)
  // slot, regardless of how p.rigs was assembled upstream.
  const _ts = (m) => { if (!m) return 0; const t = new Date(m.created || m.mtime || 0).getTime(); return Number.isFinite(t) ? t : 0; };
  const rigs = (p.rigs || []).slice().sort((a, b) => _ts(b) - _ts(a));
  rigs.forEach((r, i) => {
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
// Toggle the EDIT SELECTED rig tool buttons based on whether a rig is
// available in the current project. Each button has class="rig-tool-btn"
// so we can flip the whole set in one query. Without this, the buttons
// stay at their HTML default forever and don't reflect rig presence.
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
  const job = pushJob(`Export to Unreal: ${r.filename}`, null, null, undefined, { sourceImageUrl: r.path, projectName: state.currentProject?.name });
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
    }, rigExpected, { sourceImageUrl: meshPathToUse, projectName: p.name });
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

// AUTO-RIG AI button handler — engine selected via #ws-rig-engine (puppeteer)
document.getElementById('ws-generate-rig-ai')?.addEventListener('click', async () => {
  const p = state.currentProject;
  if (!p) return;
  const meshPathToUse = p.selectedMeshPath
    || (p.meshes && p.meshes[0] && p.meshes[0].path)
    || rigSrcMeshPath;
  if (!meshPathToUse) { alert('No mesh available — generate or pick one first.'); return; }
  if (!API.autoRigAI) { alert('Rigging bridge not available.'); return; }
  const rigEngine = document.getElementById('ws-rig-engine')?.value || 'puppeteer';
  const engineLabel = 'MyFabmesh.AI Rig (local, neural)';
  const expectedMs = 90000;
  gatedRun('rig', `Auto-rig AI: ${p.name}`, async () => {
    const job = pushJob(`Auto-rig AI (local): ${p.name}`, null, {
      Engine: engineLabel,
      'Source mesh': meshPathToUse.split(/[/\\]/).pop(),
    }, expectedMs, { sourceImageUrl: meshPathToUse, projectName: p.name });
    try {
      const skeleton = state.currentProject?.rigTarget
        || document.getElementById('ws-rig-skeleton')?.value
        || 'orc_m1';
      // NOTE: do NOT pass onProgress here on desktop. API.autoRigAI is
      // exposed through Electron preload as a thin wrapper around
      // ipcRenderer.invoke('auto-rig-ai', opts), and structured clone
      // refuses functions -> "An object could not be cloned" crash.
      // Desktop progress already arrives via the LOCAL_*_PROGRESS bridge
      // listener (Python bridge prints, main.js webContents.send, the
      // global onAI3DProgress listener bumps job.progress). The cloud
      // path keeps its own onProgress because it stays in-process (no
      // IPC crossing).
      const r = await API.autoRigAI({
        meshPath: meshPathToUse,
        engine: rigEngine,
        skeleton,
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
// UI scaffold only — backend wiring in follow-up commit.
// ============================================================
function _wsAnimEngineSync() {
  const engine = document.getElementById('ws-anim-engine')?.value || 'anytop';
  const animType = document.getElementById('ws-anim-type')?.value || 'idle';
  const promptRow = document.getElementById('ws-anim-prompt-row');
  const videoRow = document.getElementById('ws-anim-video-row');
  // Prompt only when animType === 'custom'. AnyTop itself ignores
  // free-text prompts at inference (T5 is for joint-name embedding only).
  const showPrompt = (animType === 'custom');
  const showVideo = false && (engine === 'seed3d_puppeteer');
  if (promptRow) promptRow.style.display = showPrompt ? '' : 'none';
  if (videoRow) videoRow.style.display = showVideo ? '' : 'none';
}
document.getElementById('ws-anim-engine')?.addEventListener('change', _wsAnimEngineSync);
document.getElementById('ws-anim-type')?.addEventListener('change', _wsAnimEngineSync);
_wsAnimEngineSync();

// 2026-06-13: animation selection state + Three.js animated viewer
let _selectedAnim = null;
let _animPlaying = true;
let _animLoop = true;

function renderAnimVersions(p) {
  const strip = document.getElementById('ws-anim-versions');
  if (!strip) return;
  // Defensive newest-first sort by real timestamp (same as the other strips).
  const _ts = (m) => { if (!m) return 0; const t = new Date(m.created || m.mtime || 0).getTime(); return Number.isFinite(t) ? t : 0; };
  const anims = (p?.animations || []).slice().sort((a, b) => _ts(b) - _ts(a));
  if (!anims.length) {
    strip.innerHTML = '<div style="color:var(--text-2); font-size:12px; padding:4px;">No animations yet. Pick an engine and click Generate Animation.</div>';
    return;
  }
  const iconFor = (t) => t === 'idle' ? '😴' : t === 'walk' ? '🚶'
    : t === 'run' ? '🏃' : t === 'attack' ? '⚔️'
    : t === 'death' ? '💀' : t === 'fly' ? '✈️' : '🎬';
  const selectedIdx = anims.findIndex(a => _selectedAnim && a.id === _selectedAnim.id);
  const activeIdx = selectedIdx >= 0 ? selectedIdx : 0;
  strip.innerHTML = anims.map((a, i) => `
    <div class="version-thumb${i === activeIdx ? ' selected' : ''}" data-anim-idx="${i}" style="width:80px; height:80px; background:#1a1a24; border-radius:6px; padding:6px; cursor:pointer; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; border:2px solid ${i === activeIdx ? 'var(--accent)' : 'transparent'};" title="${(a.motionLabel || a.filename || '').replace(/"/g, '&quot;')}">
      <span style="font-size:18px;">${iconFor(a.type)}</span>
      <span style="font-size:11px; font-weight:600;">${a.type || 'clip'}</span>
      <span style="font-size:9px; color:var(--text-2);">v${anims.length - 1 - i}</span>
    </div>
  `).join('');
  // Wire clicks: select on thumb
  strip.querySelectorAll('.version-thumb').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.animIdx, 10);
      if (Number.isFinite(idx) && anims[idx]) _selectAnim(anims[idx]);
    });
  });
  // Auto-select first if nothing selected yet
  if (!_selectedAnim && anims[0]) _selectAnim(anims[0]);
}

// Renders the animated GLB in the EDIT SELECTED preview area using
// Three.js (GLTFLoader + AnimationMixer), reusing the same pattern
// as c:/tmp/training_meshes/anim_preview.html which we already
// validated end-to-end on dwarf/wolf/dragon.
function _selectAnim(anim) {
  if (!anim) return;
  _selectedAnim = anim;
  // The HTML now mirrors Step 2: .step-card-preview wraps a <canvas>
  // (full-bleed via CSS) + a placeholder overlay. Hide the placeholder
  // and let Three.js paint on the canvas.
  const previewBox = document.getElementById('ws-anim-preview');
  const placeholder = document.getElementById('ws-anim-preview-placeholder');
  const canvas = document.getElementById('ws-anim-result-canvas');
  const fnEl = document.getElementById('ws-anim-filename');
  if (!previewBox || !canvas) return;
  if (placeholder) placeholder.style.display = 'none';
  if (fnEl) {
    fnEl.textContent = (anim.motionLabel || anim.filename || '')
      + (anim.verdict ? ` · judge: ${anim.verdict}` : '');
  }
  // Dispose any previous renderer/mixer so we don't leak across selects
  if (_animViewer) {
    try { _animViewer.cleanup(); } catch (_) {}
    _animViewer = null;
  }
  _initAnimResultViewer(anim);
}

let _animViewer = null;
function _initAnimResultViewer(anim) {
  let canvas = document.getElementById('ws-anim-result-canvas');
  if (!canvas) { console.warn('[anim-result] no canvas in DOM yet'); return; }
  // Replace the canvas with a fresh node so any previous WebGL context
  // (from a disposed renderer) is detached. cloneNode(false) drops the
  // children but keeps the id + class.
  const fresh = canvas.cloneNode(false);
  canvas.parentNode.replaceChild(fresh, canvas);
  canvas = fresh;
  // Wait for layout. If the containing <details> is still collapsing
  // (or the project just opened), clientWidth/Height may still be 0
  // on the first rAF. Poll up to ~500ms before bailing.
  let tries = 0;
  function waitForSize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if ((w === 0 || h === 0) && tries < 30) {
      tries++;
      setTimeout(waitForSize, 16);
      return;
    }
    _bootAnimResultViewer(canvas, anim, w || 400, h || 440);
  }
  requestAnimationFrame(waitForSize);
}

function _bootAnimResultViewer(canvas, anim, w, h) {
  console.log('[anim-result] canvas size', w, 'x', h);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(devicePixelRatio);
    renderer.setSize(w, h, false);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0e);
    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(2, 3, 2); scene.add(sun);
    const cam = new THREE.PerspectiveCamera(35, w / h, 0.001, 1000);
    cam.position.set(2, 1, 2);
    const ctl = new OrbitControls(cam, canvas); ctl.enableDamping = true;
    ctl.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
    let mixer = null, action = null, raf = 0, disposed = false;
    const url = anim.url || ('file:///' + (anim.path || '').replace(/\\/g, '/'));
    console.log('[anim-result] loading', url);
    new GLTFLoader().load(url, (g) => {
      if (disposed) return;
      const root = g.scene; scene.add(root);
      let sk = null;
      root.traverse(o => {
        if (o.isMesh || o.isSkinnedMesh) {
          o.frustumCulled = false;
          if (o.geometry) { o.geometry.computeBoundingBox(); o.geometry.computeBoundingSphere(); }
        }
        if (o.isSkinnedMesh && !sk) sk = o.skeleton;
      });
      const clips = g.animations || [];
      let pickIdx = clips.findIndex(a => /retarget/i.test(a.name || ''));
      if (pickIdx < 0) pickIdx = clips.length - 1;
      console.log('[anim-result] mesh+skin loaded, clips=' + clips.length + ' pick=' + pickIdx);
      if (clips[pickIdx]) {
        const clip = clips[pickIdx];
        console.log('[anim-result] clip name=', clip.name, 'duration=', clip.duration, 'tracks=', clip.tracks.length);
        mixer = new THREE.AnimationMixer(root);
        action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopRepeat);
        action.clampWhenFinished = false;
        action.enabled = true;
        action.reset();
        action.play();
        _animPlaying = true;
        // Debug: log mixer.time after 1s to confirm it advances
        setTimeout(() => console.log('[anim-result] mixer.time after 1s =', mixer ? mixer.time.toFixed(3) : 'null'), 1000);
      } else {
        console.warn('[anim-result] no clips found in GLB');
      }
      const box = new THREE.Box3();
      if (sk) {
        const v = new THREE.Vector3();
        sk.bones.forEach(b => { b.updateMatrixWorld(true); v.setFromMatrixPosition(b.matrixWorld); box.expandByPoint(v); });
      } else {
        box.setFromObject(root);
      }
      const sz = new THREE.Vector3(); box.getSize(sz);
      const c = new THREE.Vector3(); box.getCenter(c);
      const d = Math.max(sz.x, sz.y, sz.z) || 1;
      cam.position.set(c.x + d * 1.8, c.y + d * 1.0, c.z + d * 1.8);
      cam.near = Math.max(d * 0.001, 0.001);
      cam.far = d * 100;
      cam.updateProjectionMatrix();
      ctl.target.copy(c); ctl.update();
      if (sk) {
        const helper = new THREE.SkeletonHelper(root);
        helper.material.linewidth = 2;
        helper.material.color = new THREE.Color(0xff8800);
        scene.add(helper);
      }
    }, undefined, (err) => console.error('[anim-result] GLTFLoader failed:', err));
    const clk = new THREE.Clock();
    (function tick() {
      if (disposed) return;
      raf = requestAnimationFrame(tick);
      if (mixer && _animPlaying) mixer.update(clk.getDelta());
      ctl.update();
      renderer.render(scene, cam);
    })();
  _animViewer = {
    cleanup() {
      disposed = true;
      cancelAnimationFrame(raf);
      try { renderer.dispose(); } catch (_) {}
    }
  };
}

// Wire EDIT SELECTED toolbar buttons (Play / Loop / Export FBX / Show in folder)
document.getElementById('ws-anim-play-btn')?.addEventListener('click', () => {
  _animPlaying = !_animPlaying;
});
document.getElementById('ws-anim-loop-btn')?.addEventListener('click', () => {
  _animLoop = !_animLoop;
});
document.getElementById('ws-anim-folder-btn')?.addEventListener('click', async () => {
  if (!_selectedAnim?.path) return;
  try { await window.meshyAPI.showInFolder?.(_selectedAnim.path); } catch (_) {}
});
document.getElementById('ws-anim-export-btn')?.addEventListener('click', async () => {
  if (!_selectedAnim?.path) return;
  try {
    const res = await window.meshyAPI.animExport?.({ glbPath: _selectedAnim.path, format: 'fbx' });
    if (res?.success) showToast?.(`Exported: ${res.path}`, 'success');
    else showToast?.(`Export failed: ${res?.error || 'unknown'}`, 'error');
  } catch (e) { showToast?.(`Export error: ${e.message}`, 'error'); }
});

// 2026-06-13: reuse the existing pushJob/completeJob "Running task"
// modal (same UX as image-to-3D / rig / refine) for the animation
// retarget. Active jobs in this session are tracked here so the
// streaming anim:progress channel can keep updating the right one.
let _activeAnimJob = null;
if (window.meshyAPI?.onAnimProgress) {
  window.meshyAPI.onAnimProgress((data) => {
    if (!_activeAnimJob || typeof updateJobProgress !== 'function') return;
    // Drive the progress bar by phase (no real % from the backend yet).
    const phaseToPct = { start: 5, search: 15, match: 25, retarget: 60, bake: 85, judge: 95, done: 100 };
    const pct = (typeof data?.pct === 'number' && data.pct > 0)
      ? data.pct : (phaseToPct[data?.phase] ?? null);
    if (pct != null) {
      try { updateJobProgress(_activeAnimJob.id, pct, data.msg); } catch (_) {}
    }
  });
}

document.getElementById('ws-generate-anim')?.addEventListener('click', async () => {
  const engine = document.getElementById('ws-anim-engine')?.value || 'rokoko_library';
  const animType = document.getElementById('ws-anim-type')?.value || 'walk';
  const mode = document.getElementById('ws-anim-mode')?.value || 'local';
  const status = document.getElementById('ws-anim-status');
  const btn = document.getElementById('ws-generate-anim');
  const setStatus = (msg, isErr = false) => {
    if (status) {
      status.textContent = msg;
      status.style.color = isErr ? 'var(--danger, #f55)' : 'var(--text-2)';
    }
  };

  if (engine !== 'rokoko_library') {
    customError(`${engine} not wired yet — only Motion Library is available in v1.`, 'Engine not ready');
    return;
  }
  // Resolve the current rigged GLB from the active project state
  const proj = state.currentProject;
  const rigPath = proj?.activeRigPath || proj?.rigs?.[proj.rigs.length - 1]?.path;
  if (!rigPath) {
    setStatus('No rigged mesh on this project. Run Step 3 first.', true);
    return;
  }
  // Detect class from rig filename: looks for "quadruped" / "winged" / etc.
  const lower = rigPath.toLowerCase();
  let detectedClass = 'humanoid';
  if (lower.includes('quadruped') || lower.includes('quadrup')) detectedClass = 'quadruped';
  else if (lower.includes('winged') || lower.includes('dragon')) detectedClass = 'winged_biped';

  btn.disabled = true;
  // Open the standard "Running task" modal so the user sees the same UX
  // as the other steps (image-to-3D, rig, refine, etc.).
  const meshNameDisplay = (rigPath || '').split(/[\\/]/).pop();
  _activeAnimJob = (typeof pushJob === 'function')
    ? pushJob(`Animate: ${animType}`, null, {
        Engine: 'MyFabmesh.AI Anim (local, Rokoko)',
        'Source mesh': meshNameDisplay,
        Class: detectedClass,
        Animation: animType,
        Mode: mode,
      }, 20000, { sourceImageUrl: rigPath, projectName: proj?.name })
    : null;
  try {
    setStatus(`Listing ${animType} motions for ${detectedClass}…`);
    const list = await window.meshyAPI.animListMotions({ class: detectedClass });
    const target = animType.toLowerCase();
    // Match against id (= filename) and label (= human-readable tokens)
    const matching = (list.motions || []).filter(m => {
      const id = (m.id || '').toLowerCase();
      const label = (m.label || '').toLowerCase();
      return id.includes(target) || label.includes(target);
    });
    if (!matching.length) {
      // Fallback: any class (motion library may be sparse for non-humanoid)
      const allList = await window.meshyAPI.animListMotions({});
      const anyMatch = (allList.motions || []).filter(m =>
        ((m.id || '') + (m.label || '')).toLowerCase().includes(target)
      );
      if (!anyMatch.length) {
        setStatus(`No "${animType}" motion found in library (${list.total || 0} for ${detectedClass}, ${allList.total || 0} total).`, true);
        btn.disabled = false;
        return;
      }
      matching.push(...anyMatch);
    }
    const motion = matching[0];
    setStatus(`Picked "${motion.label || motion.id}" (${matching.length} candidates), starting…`);
    console.log('[anim] rigPath:', rigPath, 'motion:', motion);
    setStatus(`Retargeting "${motion.name}" (${mode})…`);
    const result = await window.meshyAPI.animRetarget({
      meshPath: rigPath,
      motionId: motion.id,
      mode,
    });
    if (!result?.success) {
      setStatus(`Retarget failed: ${result?.error || 'unknown'}`, true);
      btn.disabled = false;
      return;
    }
    // Run the auto-judge for a quick verdict
    let verdict = 'n/a';
    try {
      const judged = await window.meshyAPI.animJudge({ glbPath: result.glbPath });
      verdict = judged?.verdict || 'n/a';
    } catch (_) {}
    setStatus(`Done — ${result.glbPath?.split(/[\\/]/).pop()} (judge: ${verdict})`);

    // 2026-06-13: push the new animation into the project model so the
    // version strip + EDIT SELECTED viewer pick it up, matching the
    // cloud renderer pattern in cloud/public/app/index2.js:653.
    const proj2 = state.currentProject;
    if (proj2) {
      proj2.animations = proj2.animations || [];
      const filename = result.glbPath.split(/[\\/]/).pop();
      proj2.animations.unshift({
        id: result.jobId || `${Date.now()}`,
        batchId: `local_${Date.now()}`,
        type: animType,
        filename,
        path: result.glbPath,
        url: 'file:///' + result.glbPath.replace(/\\/g, '/'),
        engine: 'rokoko_library',
        mode,
        motionId: motion.id,
        motionLabel: motion.label,
        verdict,
        created: new Date().toISOString(),
      });
      // Refresh the version strip + EDIT SELECTED viewer.
      try { renderAnimVersions(proj2); } catch (_) {}
      try { _selectAnim?.(proj2.animations[0]); } catch (_) {}
      try { window.dispatchEvent(new CustomEvent('anim:new', { detail: proj2.animations[0] })); } catch (_) {}
    }
    if (_activeAnimJob && typeof completeJob === 'function') {
      try { completeJob(_activeAnimJob.id, true); } catch (_) {}
      _activeAnimJob = null;
    }
  } catch (err) {
    setStatus(`Error: ${err.message || err}`, true);
    if (_activeAnimJob && typeof completeJob === 'function') {
      try { completeJob(_activeAnimJob.id, false, String(err.message || err)); } catch (_) {}
      _activeAnimJob = null;
    }
  } finally {
    btn.disabled = false;
  }
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
function pushJob(name, onCancel, params, expectedMsOverride, opts, _cloudOpts) {
  // Cross-signature guard. Cloud's pushJob is
  //   (name, onCancel, params, expectedMsOverride, startedAtOverride, opts)
  // — a future cloud->desktop sync paste of a 6-arg call would land opts in
  // _cloudOpts (slot 6) and a number (or undefined) in slot 5. Detect that
  // shape and shift opts back into place so the projectName/sourceImageUrl
  // snapshot still survives. Also handles the legacy case where opts was
  // accidentally passed in the expectedMsOverride slot.
  if (_cloudOpts && typeof _cloudOpts === 'object') {
    opts = _cloudOpts;
  } else if (opts === undefined && expectedMsOverride
             && typeof expectedMsOverride === 'object') {
    opts = expectedMsOverride;
    expectedMsOverride = undefined;
  }
  const id = ++state.jobIdCounter;
  const kind = inferKind(name);
  const expected = (typeof expectedMsOverride === 'number' && expectedMsOverride > 0)
    ? expectedMsOverride
    : (JOB_EXPECTED_MS[kind] || 60000);
  // SNAPSHOT the source image at launch time. Without this, the Job
  // Details modal reads state.currentProject.* at RENDER time, which
  // may have changed if the user clicked another version thumbnail
  // between launch and the modal refresh (bug: modal shows wrong
  // thumb because the user switched selected image mid-job).
  const o = opts || {};
  // Resolve a stable project label ONCE: callers may pass it through opts,
  // else snapshot whatever the current project is at launch (the user can
  // switch projects mid-job, and the popup must keep pointing at the project
  // that started the job — not whichever is open now).
  const projectName = o.projectName || (state.currentProject ? state.currentProject.name : null);
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
    sourceImageUrl: o.sourceImageUrl || null,
    projectName,
    // 2026-06-02 — mirror cloud's `sourceProject` field so _jobProjectName
    // (the cross-project navigation helper used by the running-job tile click)
    // has a reliable source independent of the legacy title-regex parse,
    // which breaks on project names containing colons / em-dashes
    // (e.g. "Orc rose: chapter 2" was matched as project="chapter 2").
    sourceProject: o.sourceProject || projectName,
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

// Resolve a job's owning project name. Mirrors cloud's _jobProjectName
// (cloud/public/app/index2.js). Priority:
//   1. j.params.Project  — set by some legacy MCP paths
//   2. j.sourceProject   — set by pushJob (preferred, snapshot at launch)
//   3. j.projectName     — current pushJob field, equivalent to sourceProject
//   4. title-regex tail  — last-ditch fallback for jobs that pre-date the
//                          opts param (kept for backwards-compat). Fragile
//                          on names with ':' or '—' so the above sources
//                          should hit first.
function _jobProjectName(j) {
  if (!j) return null;
  if (j.params && j.params.Project) return j.params.Project;
  if (j.sourceProject) return j.sourceProject;
  if (j.projectName) return j.projectName;
  const m = (j.name || '').match(/[:—–-]\s*([^:—–-]+)\s*$/);
  if (m) return m[1].trim();
  return null;
}
window._jobProjectName = _jobProjectName;

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
  // Failed jobs linger longer than successful ones so the user has time to
  // open the details modal and click the recovery button (e.g. "Open Settings").
  // 2026-06-02: extend the done dwell to 8s so the user can read the
  // result tile inside the per-step widget instead of having it vanish.
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
  push: (name, onCancel, params, expectedMs, opts) => pushJob(name, onCancel, params, expectedMs, opts),
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

// Classify a job into one of the 4 Create New steps so the per-step
// progress widget can show only the jobs relevant to its own panel.
// Returns 1..4 or 0 for "no step" (don't render in any step widget).
function _jobStepIndex(j) {
  const n = (j && j.name) || '';
  // Step 1 (image) — generation, edits, variants, view rectifiers.
  if (/^(generate images?|generating (back|6) views|generate back views|multi[- ]?views|modify|inpaint|face[- ]?fix|remove[- ]?bg|rectif|upscal|back[- ]?view|t[- ]?pose|re[- ]?roll|variant|img2img|sdxl|flux|image[- ]?to[- ]?image)/i.test(n)) return 1;
  // 2026-06-14: manual image-edit tools are named "Manual mask inpaint",
  // "Clone stamp: ...", "Draw mask: ...", etc. — they don't START with an
  // image keyword, so the anchored test above missed them and they never
  // showed in the Image step's GENERATING widget (only in the global
  // running-jobs panel). Match them anywhere in the name.
  if (/(mask inpaint|auto[- ]?inpaint|manual (mask|inpaint|paint|crop)|clone stamp|draw mask|brightness|symmetri[sz]e|color pick|blur brush|\bcrop\b|\bpaint\b)/i.test(n)) return 1;
  if (/^(generate 3d|mesh op|fill[- ]?holes|smooth|material[- ]?adjust|generate mesh|texture|pbr)/i.test(n)) return 2;
  if (/(rig|skeleton)/i.test(n)) return 3;
  if (/^(animate|animation)/i.test(n)) return 4;
  return 0;
}

// Track per-step "last seen hasRunning" so we only auto-toggle the
// GENERATING stage when the state CHANGES. Without this, the every-
// second render tick would clobber the user's manual expand (they
// open it, next render closes it). With this, the user's toggle wins
// until the running state flips.
const _stageGenLastRunning = { 1: null, 2: null, 3: null, 4: null };

function _toggleGeneratingStage(stepIdx, hasRunning) {
  const cardId = ['step-card-image','step-card-mesh','step-card-rig','step-card-animation'][stepIdx - 1];
  const card = document.getElementById(cardId);
  if (!card) return;
  const stage = card.querySelector('.stage-generating');
  if (!stage) return;
  stage.style.display = '';  // always visible
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
  // Wait a beat for the details to fully reflow before scrolling so the
  // browser has settled on its final layout box.
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  try { card.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) {}
  // Pulse-highlight the destination card so the user gets a visual cue
  // that the navigation actually happened.
  try {
    card.classList.add('pulse-highlight');
    setTimeout(() => card.classList.remove('pulse-highlight'), 1600);
  } catch (_) {}
  // Pulse the specific job tile inside the step widget if present.
  try {
    const tile = document.querySelector(`.step-progress-item[data-job-id="${jobId}"]`);
    if (tile) {
      tile.classList.add('pulse-highlight');
      setTimeout(() => tile.classList.remove('pulse-highlight'), 1600);
    }
  } catch (_) {}
};

// Populate every per-step progress widget from state.jobs. Only jobs
// belonging to the currently-open project show up — the widget lives
// inside that project's workspace, so cross-project bleed would be
// confusing. Empty widgets get the hidden state (no .has-jobs class).
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
    // Done/error tiles keep showing for ~3-8s but the step itself
    // stops being "active" so we let the badge calm down.
    const hasRunning = matching.some(j => j.status === 'running');
    try { _toggleGeneratingStage(s, hasRunning); } catch (_) {}
    widget.innerHTML = matching.map(j => {
      const pct = Math.round(j.progress || 0);
      const canCancel = j.status === 'running';
      const statusClass = j.status === 'done' ? ' done'
                        : j.status === 'error' ? ' error'
                        : '';
      const elapsed = j.startedAt ? fmtDuration(Date.now() - j.startedAt) : '';
      // Small source-asset thumbnail so the user recognises which
      // generation is theirs. Snapshot stamped at pushJob time —
      // never the currently-selected version (race-safe).
      const thumbUrl = j.sourceImageUrl ? (
        /^(https?:|data:|blob:|file:|app:)/i.test(j.sourceImageUrl)
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
            <div class="step-progress-item-name">${escapeHtml(j.name)}</div>
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
      /^(https?:|data:|blob:|file:|app:)/i.test(j.sourceImageUrl)
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
          <div class="job-item-2-name">${escapeHtml(j.name)}</div>
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
      // GPU at 100% is normal during a gen (unlike RAM saturation) — show the
      // usage plainly, never colour it red.
      util.textContent = (gpu.gpuUtil || 0) + '%';
      util.classList.remove('warn', 'error');
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
  // Estimated total: start from the static estimate, but once the job has real
  // progress (>=8%) trust a DYNAMIC estimate (elapsed / fraction) — it adapts
  // to whatever is actually happening (RAM swap, cascade slowness) that the
  // static number can't predict.
  let _estMs = j.expectedMs;
  if (j.status === 'running' && j.startedAt && typeof j.progress === 'number' && j.progress >= 8 && j.progress < 100) {
    const _elapsed = Date.now() - j.startedAt;
    const _dyn = _elapsed / (j.progress / 100);
    // Blend static + dynamic, weighted by progress. The early phases (model
    // load, rembg, rectify) are disproportionately slow, so a raw elapsed/
    // fraction extrapolation BALLOONS the estimate ("ça se rallonge sans
    // cesse"). We trust the static estimate while progress is low and only lean
    // on the dynamic one as the job nears completion (where it's accurate).
    const _w = Math.min(1, j.progress / 100);
    const _blended = _w * _dyn + (1 - _w) * (j.expectedMs || _dyn);
    _estMs = Math.max(_blended, _elapsed);  // never below already-elapsed
  }
  document.getElementById('jd-estimated').textContent = '~' + fmtDuration(_estMs);
  // Show the job's OWN project (snapshot at pushJob time) instead of whatever
  // is currently open. If the user switches projects mid-job the popup must
  // keep pointing at the project that started the job.
  document.getElementById('jd-project').textContent = _jobProjectName(j) || (state.currentProject ? state.currentProject.name : '--');
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
  // PRIORITY: job.sourceImageUrl (the SNAPSHOT taken at pushJob time) wins
  // over state.currentProject.* — because the user can click another
  // version thumb between launch and the modal refresh, which would swap
  // the displayed source image to a completely different asset.
  const refImg = document.getElementById('jd-ref-img');
  const p = state.currentProject;
  const isRigJob = /rig/i.test(j.name || '');
  // Match all phases of an image-creation job so the popup never shows the
  // previously-selected image as a thumb. The phase-2 rename ("Generating
  // 6 views: ..." / "Generate back views: ...") used to escape the original
  // regex and reveal the stale thumb mid-generation.
  const isImageGenJob = /^(generate images?|generating (back|6) views|generate back views|multi-views)\b/i.test(j.name || '');
  let thumbUrl = null;
  // 1) Snapshot wins — set at launch time, immune to UI state mutations.
  if (j.sourceImageUrl && !isImageGenJob) {
    const u = j.sourceImageUrl;
    if (/^https?:|^file:|^data:|^blob:/i.test(u)) {
      thumbUrl = u + (u.includes('?') ? '&' : '?') + 't=' + Date.now();
    } else {
      thumbUrl = 'file:///' + String(u).replace(/\\/g, '/') + '?t=' + Date.now();
    }
  }
  // 2) Rig jobs: show the source mesh thumbnail (not an image).
  if (!thumbUrl && isRigJob && p && p.selectedMeshPath && API.getThumbnail) {
    try {
      const t = await API.getThumbnail(p.selectedMeshPath);
      if (t) thumbUrl = t + '?t=' + Date.now();
    } catch (_) {}
  }
  // 3) Fallback to the current project's image path (legacy behaviour).
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
    const blob = (j.params?.Engine || '') + ' ' + (j.name || '') + ' ' + (j.kind || '');
    const isLocalGpu = /realvis|sf3d|stable fast|unirig|sdxl|inpaint|img2img|style|modify/i.test(blob);
    const isImageJob = /realvis|sdxl|inpaint|img2img|style|modify|image/i.test(blob);
    let show = isEarly && isLocalGpu;
    // Image ops reuse the PERSISTENT SDXL server: if it's already loaded (a gen
    // ran just before), there is no ~7 GB cold load — the op finishes in
    // seconds — so the "first run after idle" notice is misleading. Hide it when
    // the AI engine is already resident. (3D/rig spawn a fresh process each run,
    // so they genuinely cold-load every time → keep the hint for them.)
    if (show && isImageJob && API.listProcesses) {
      try {
        const pl = await API.listProcesses();
        if (((pl && pl.procs) || []).some(p => p.isAiEngine)) show = false;
      } catch (_) {}
    }
    hintEl.classList.toggle('hidden', !show);
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
  const unlockBtn = document.getElementById('job-details-unlock');
  if (errBox && openSettingsBtn) {
    if (j.status === 'error' && j.errorMessage) {
      errBox.textContent = j.errorMessage;
      errBox.classList.remove('hidden');
      const needsApiKey = /api key not configured/i.test(j.errorMessage);
      openSettingsBtn.style.display = needsApiKey ? '' : 'none';
      // Content-filter block → offer a direct Unlock shortcut to the parental-
      // control disable flow (legal warning + PIN), like reportPipelineError does.
      const isContentFilter = /content filter|parental control|unrestricted mode/i.test(j.errorMessage);
      if (unlockBtn) unlockBtn.style.display = isContentFilter ? '' : 'none';
    } else {
      errBox.textContent = '';
      errBox.classList.add('hidden');
      openSettingsBtn.style.display = 'none';
      if (unlockBtn) unlockBtn.style.display = 'none';
    }
  }
  // Go-to-step button: visible whenever this job maps to a Create New
  // step (image / mesh / rig / anim). Clicking it opens the matching
  // project and scroll-expands its step card.
  const gotoBtn = document.getElementById('job-details-goto-step');
  if (gotoBtn) {
    const stepIdx = _jobStepIndex(j);
    gotoBtn.style.display = stepIdx > 0 ? '' : 'none';
    if (stepIdx > 0) {
      const labels = ['Image','3D Mesh','Rig','Animation'];
      gotoBtn.textContent = `→ Go to ${labels[stepIdx - 1]}`;
    }
  }
}
document.getElementById('job-details-close').addEventListener('click', closeJobDetails);
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
// Also tick the sidebar + per-step tiles every second so the elapsed-
// time chip next to the % updates live. Only re-renders when there
// are running jobs to avoid useless DOM work when idle.
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
// Variant: open a modal to choose the variation AMOUNT (img2img strength) and
// the number of variants, then re-roll via img2img (a fresh random seed each).
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
  const target = editTarget(p);
  if (!target) { showToast('Pick an image first.', 'error'); return; }
  const modal = document.getElementById('modal-variant');
  if (!modal) return;
  const srcImg = document.getElementById('var-source-img');
  if (srcImg) srcImg.src = 'file:///' + target.replace(/\\/g, '/') + '?t=' + Date.now();
  modal.dataset.targetPath = target;
  _updateVarStrengthHint();
  modal.classList.remove('hidden');
});
document.getElementById('var-strength')?.addEventListener('input', (e) => {
  document.getElementById('var-strength-val').textContent = e.target.value + '%';
  _updateVarStrengthHint();
});
document.getElementById('var-count')?.addEventListener('input', (e) => {
  document.getElementById('var-count-val').textContent = e.target.value;
});
document.getElementById('var-cancel')?.addEventListener('click', () => {
  document.getElementById('modal-variant')?.classList.add('hidden');
});
document.getElementById('var-apply')?.addEventListener('click', () => {
  const p = state.currentProject;
  const modal = document.getElementById('modal-variant');
  const target = (modal && modal.dataset.targetPath) || editTarget(p);
  if (!target) return;
  const strength = (parseInt(document.getElementById('var-strength').value) || 50) / 100;
  const count = parseInt(document.getElementById('var-count').value) || 1;
  if (modal) modal.classList.add('hidden');
  const prompt = (p && (p.prompt || p.initialPrompt)) || 'high quality, detailed';
  showToast(`Generating ${count} variant${count > 1 ? 's' : ''}…`, 'info', 2000);
  for (let i = 0; i < count; i++) {
    const seed = Math.floor(Math.random() * 1000000);
    const label = count > 1 ? `Variant ${i + 1}/${count}: ${p.name}` : `Variant: ${p.name}`;
    gatedRun('img2img', label, async () => {
      const job = pushJob(`Variant: ${p.name}`, null,
        { Seed: seed, Variation: Math.round(strength * 100) + '%' }, 30000,
        { sourceImageUrl: target, projectName: p.name });
      try {
        const r = await API.img2img({ imagePath: target, prompt, strength, engine: 'local-sdxl', seed });
        if (r?.success) { completeJob(job.id, true); await reloadCurrentProject(); }
        else { completeJob(job.id, false, r?.error); showToast('Variant failed: ' + (r?.error || 'unknown'), 'error'); }
      } catch (e) {
        completeJob(job.id, false, e?.error || e?.message || String(e));
      }
    });
  }
});

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
  if (srcImg) { srcImg.src = 'file:///' + target.replace(/\\/g, '/') + '?t=' + Date.now(); srcImg.style.opacity = ''; }
  _aiSrcPath = target;
  document.getElementById('modal-auto-inpaint').classList.remove('hidden');
});
// --- Live mask preview: run CLIPSeg detection ONLY (no inpaint) and overlay the
// detected region in red, so the user sees EXACTLY what Auto Inpaint will
// repaint before committing. Debounced on the TARGET text + padding slider. ---
let _aiSrcPath = null;
let _aiPreviewTimer = null;
let _aiFirstDetectDone = false;  // the FIRST detection loads the model (~15s) — reassure the user
async function _aiUpdateMaskPreview() {
  const srcImg = document.getElementById('ai-source-img');
  if (!srcImg || !_aiSrcPath) return;
  const target = (document.getElementById('ai-target').value || '').trim();
  const dilate = parseInt(document.getElementById('ai-dilate').value) || 15;
  const origUrl = 'file:///' + _aiSrcPath.replace(/\\/g, '/') + '?t=0';
  if (!target) { srcImg.src = origUrl; srcImg.style.opacity = ''; return; }
  if (!API.segmentMask) return;
  const spinner = document.getElementById('ai-detect-spinner');
  const label = document.getElementById('ai-detect-label');
  if (label) label.textContent = _aiFirstDetectDone
    ? 'Detecting target…'
    : 'Warming up the AI… the first detection takes ~15s (loading the model), then it’s instant.';
  if (spinner) spinner.style.display = 'flex';   // loading circle on the image
  srcImg.style.opacity = '0.6';
  try {
    const r = await API.segmentMask({ imagePath: _aiSrcPath, targetText: target, dilate });
    // Ignore a stale response if the target changed while we were detecting —
    // the newer in-flight call owns the UI (and will hide the spinner).
    if (((document.getElementById('ai-target').value || '').trim()) !== target) return;
    _aiFirstDetectDone = true;   // engine warm now → next detections are fast
    srcImg.style.opacity = '';
    if (spinner) spinner.style.display = 'none';
    if (r && r.success && r.overlayPath) {
      srcImg.src = 'file:///' + r.overlayPath.replace(/\\/g, '/') + '?t=' + Date.now();
    } else {
      srcImg.src = origUrl;  // nothing detected → show the plain image
    }
  } catch (_) {
    srcImg.style.opacity = '';
    if (spinner) spinner.style.display = 'none';
  }
}
function _aiSchedulePreview() {
  if (_aiPreviewTimer) clearTimeout(_aiPreviewTimer);
  _aiPreviewTimer = setTimeout(_aiUpdateMaskPreview, 300);
}
document.getElementById('ai-target')?.addEventListener('input', _aiSchedulePreview);
const aiDilate = document.getElementById('ai-dilate');
if (aiDilate) aiDilate.addEventListener('input', () => {
  document.getElementById('ai-dilate-val').textContent = aiDilate.value + 'px';
  _aiSchedulePreview();
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
    }, 180000, { sourceImageUrl: imagePath, projectName: p.name });
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
let _lastProcList = 0;  // 2026-06-14: throttle list-processes to ~2s inside the 500ms GPU poll
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
  // The RAM slider IS the budget — re-evaluate which cascade modes fit the new
  // budget and refresh the marker's GB tooltip live as the user drags it.
  try { gateUltraQualityByRAM(); } catch (_) {}
  try { applyGpuLimitMarkers(); } catch (_) {}
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
  if (r) {
    r.style.left = gpuLimits.ram + '%';
    // Show the budget in GB so the user sets an understandable ceiling:
    // budget = physical RAM × ram%. This is the real cap the pipeline fits
    // under (it picks a lighter cascade mode rather than saturating).
    if (_cachedTotalRamGB != null) {
      const budgetGB = _cachedTotalRamGB * (gpuLimits.ram / 100);
      r.title = `Budget RAM : ${budgetGB.toFixed(0)} GB (${gpuLimits.ram}% de ${_cachedTotalRamGB.toFixed(0)} GB). ` +
        `Glisse pour plafonner ce que l'appli peut utiliser.`;
    } else {
      r.title = 'Glisse pour plafonner le budget RAM (max RAM usage)';
    }
  }
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
        // CRITICAL: reset the drag flag before bailing. refreshGpuStats() early-
        // returns while _draggingGpuLimit is true, so leaving it stuck here (the
        // mouseup handler is never attached on this path) FROZE the whole live
        // hardware panel until the next Settings re-open.
        _draggingGpuLimit = false;
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
        if (s === 'ram' && _cachedTotalRamGB != null) {
          // RAM marker = budget ceiling. Show it in GB so the user dials in an
          // understandable number ("I want a 25 GB budget") instead of a %.
          const gb = _cachedTotalRamGB * (pct / 100);
          return Math.round(pct) + ' %  (~' + gb.toFixed(0) + ' GB)';
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
    const sdxlEl = document.getElementById('set-python-sdxl');
    const killBtn = document.getElementById('set-kill-python');
    const n = r.count || 0;
    // 2026-06-14: the "N active" count is set by refreshProcList from the
    // number of JOB rows (top-level tracked processes), NOT here from the
    // raw python.exe count. A single 3D-mesh job spawns a worker child, so
    // tasklist sees 2 python.exe while the list shows 1 job — that
    // mismatch confused the user. The kill-button enable logic still uses
    // the raw python count (n) so it works even for orphan children.
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

// 2026-06-14: live per-process list with an independent Kill per row.
// Driven by the existing Settings poll (throttled to 2s). p.label is a
// fixed whitelist from _jobLabelFromArgs, so innerHTML interpolation is
// safe here; if labels ever become path/user-derived, switch to
// textContent.
async function refreshProcList() {
  const box = document.getElementById('set-proc-list');
  if (!box || !API.listProcesses) return;
  let r;
  try { r = await API.listProcesses(); } catch (_) { return; }
  const procs = (r && r.procs) || [];
  // 2026-06-14: the "N active" header counts JOB rows (top-level tracked
  // processes), so it always matches the list below. Worker children a
  // job spawns are part of that job, not separate rows.
  const countEl = document.getElementById('set-python-count');
  if (countEl) countEl.textContent = String(procs.length);
  if (!procs.length) {
    box.innerHTML = '<div style="font-size:11px;color:var(--text-2);padding:4px 0;">No active process.</div>';
    return;
  }
  const fmtMs = ms => {
    const s = Math.round(ms / 1000);
    return s < 60 ? s + 's' : Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0');
  };
  box.innerHTML = procs.map(p => {
    const ram = p.ramMb != null ? ` · ${(p.ramMb / 1024).toFixed(1)} GB RAM` : '';
    // The AI engine (image model) holds several GB of VRAM that the tiny RAM
    // figure hides — surface it so killing it isn't a surprise -8 GB.
    const vram = p.vramMb != null ? ` · <span style="color:var(--accent)">${(p.vramMb / 1024).toFixed(1)} GB VRAM</span>` : '';
    const susp = p.suspended ? ' <span style="color:var(--warning)">(suspended)</span>' : '';
    const tag = p.isAiEngine ? 'AI engine' : (p.kind || 'job');
    // "Go to" only when we resolved a project to navigate to.
    const goBtn = p.projectName
      ? `<button class="ghost-btn proc-goto" data-project="${encodeURIComponent(p.projectName)}" data-kind="${p.kind || ''}" style="padding:3px 8px;font-size:10px;flex:none;">Go to</button>`
      : '';
    return `<div class="proc-row" style="display:flex;align-items:center;gap:6px;padding:5px 0;border-top:1px solid var(--border);">
      <div style="flex:1;min-width:0;">
        <div style="font-size:11px;color:var(--text-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.label}${susp}</div>
        <div style="font-size:10px;color:var(--text-2);">pid ${p.pid} · ${tag} · ${fmtMs(p.elapsedMs)}${ram}${vram}</div>
      </div>
      ${goBtn}
      <button class="ghost-btn danger proc-kill" data-pid="${p.pid}" style="padding:3px 8px;font-size:10px;flex:none;">Kill</button>
    </div>`;
  }).join('');
  box.querySelectorAll('.proc-kill').forEach(btn => {
    btn.addEventListener('click', async () => {
      const pid = parseInt(btn.dataset.pid, 10);
      btn.disabled = true; btn.textContent = '…';
      try { await API.killProcess(pid); showToast?.('Process ' + pid + ' killed.', 'success'); }
      catch (e) { showToast?.('Kill failed: ' + e.message, 'error'); }
      setTimeout(() => { refreshPythonStats(); refreshProcList(); }, 600);
    });
  });
  box.querySelectorAll('.proc-goto').forEach(btn => {
    btn.addEventListener('click', () => {
      const project = decodeURIComponent(btn.dataset.project || '');
      const kind = btn.dataset.kind || '';
      _navigateToProcess(project, kind);
    });
  });
}

// 2026-06-14: navigate from a process row to its project + the step the
// process is working on. Reuses openProject + the step-card scroll/pulse
// pattern from _navigateToJobStep.
async function _navigateToProcess(projectName, kind) {
  if (!projectName) return;
  // Close the Settings modal so the user lands on the workspace.
  try { document.getElementById('modal-settings')?.classList.add('hidden'); } catch (_) {}

  // Prefer routing to the actual running JOB so we highlight the GENERATION
  // itself (its progress tile), not just the step card that contains it.
  // Match a live job in this project whose step matches the process kind.
  const kindToStep = { image: 1, inpaint: 1, mesh: 2, rig: 3, anim: 4 };
  const wantStep = kindToStep[kind] || 2;
  try {
    const jobs = (state.jobs || []).filter(j => {
      if (!j || _jobProjectName(j) !== projectName) return false;
      return _jobStepIndex(j) === wantStep;
    });
    // Prefer an active job (running/queued/paused) over a finished one.
    const rank = (j) => {
      const s = String(j.status || '').toLowerCase();
      if (s === 'running' || s === 'active') return 0;
      if (s === 'queued' || s === 'paused' || s === '') return 1;
      return 2;
    };
    jobs.sort((a, b) => rank(a) - rank(b));
    if (jobs.length && typeof window._navigateToJobStep === 'function') {
      await window._navigateToJobStep(jobs[0].id);
      return;
    }
  } catch (_) {}

  // Fallback (no matching job object): open the project, highlight the step
  // card AND the active progress tile inside it (not just the card).
  const cur = state.currentProject && state.currentProject.name;
  if (projectName !== cur) {
    try {
      const p = (state.projects || []).find(x => x && x.name === projectName);
      if (p && typeof openProject === 'function') await openProject(p);
      else if (typeof window.openProjectByName === 'function') await window.openProjectByName(projectName);
    } catch (_) {}
  }
  const kindToCard = {
    image: 'step-card-image', inpaint: 'step-card-image',
    mesh: 'step-card-mesh', rig: 'step-card-rig', anim: 'step-card-animation',
  };
  const cardId = kindToCard[kind] || 'step-card-mesh';
  const card = document.getElementById(cardId);
  if (!card) return;
  card.classList.remove('collapsed', 'disabled');
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  try { card.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) {}
  try {
    card.classList.add('pulse-highlight');
    setTimeout(() => card.classList.remove('pulse-highlight'), 1600);
  } catch (_) {}
  // Highlight the running generation tile inside the card, not just the card.
  try {
    const tile = card.querySelector('.step-progress-item.running')
      || card.querySelector('.step-progress-item.active')
      || card.querySelector('.step-progress-item');
    if (tile) {
      tile.classList.add('pulse-highlight');
      setTimeout(() => tile.classList.remove('pulse-highlight'), 1600);
    }
  } catch (_) {}
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
// Realistic PEAK VRAM per heavy job — used ONLY to decide how many can run in
// PARALLEL (maxConcurrent = floor(vramLimit / peak)). Distinct from the lighter
// COST above (which gates the FIRST job's headroom). TRELLIS-2 mesh genuinely
// peaks ~15 GB (≈ a whole 16 GB card), so a 16 GB card runs 1 at a time while a
// 48 GB card runs ~3.
const JOB_VRAM_PEAK_GB = {
  'image': 9, 'img2img': 9, 'inpaint': 10, 'mesh': 15, 'rig': 5, 'bg': 1,
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
  // VRAM-aware concurrency (replaces the old "one heavy job at a time" hard
  // block that needlessly serialized even on big GPUs). Allow as many heavy
  // jobs in parallel as the card's VRAM budget fits: maxConcurrent =
  // floor(vramLimit / realPeak). A 16 GB card runs 1 TRELLIS at a time, a
  // 48 GB card ~3. The per-project confirm dialog handles same-project dupes.
  if (kind !== 'bg') {
    const runningHeavy = state.jobs.filter(j => j.status === 'running' && j.kind && j.kind !== 'bg').length;
    if (runningHeavy > 0) {
      let maxConcurrent = 1;
      try {
        const gpu = await API.checkGPU();
        if (gpu && gpu.available && gpu.totalGB) {
          const peak = JOB_VRAM_PEAK_GB[kind] || 12;
          const limitGB = gpu.totalGB * ((gpuLimits?.vram || 90) / 100);
          maxConcurrent = Math.max(1, Math.floor(limitGB / peak));
        }
      } catch (_) {}
      if (runningHeavy >= maxConcurrent) {
        return { ok: false, reason: `${runningHeavy} génération(s) lourde(s) en cours — ta carte en supporte ${maxConcurrent} en parallèle. La suivante attend qu'une se libère.` };
      }
    }
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

    // SDXL-reusing op (image/img2img/inpaint): if the image engine is ALREADY
    // loaded, the op just SWAPS the server's pipeline on its EXISTING allocation
    // — no new card allocation — and the server self-limits via its own VRAM
    // fraction cap. So it must NOT be gated on card VRAM: otherwise a follow-up
    // image op right after a gen (14 GB used incl. 6.6 GB engine → projected 97%
    // > 90% limit) gets queued, waits up to 90s for the idle timer, then RELOADS
    // the model — instead of just reusing it instantly. The stacking gate is for
    // NEW heavy allocations, which reusing the loaded server is not.
    if (kind === 'image' || kind === 'img2img' || kind === 'inpaint') {
      let engineLoaded = false;
      if (API.listProcesses) {
        try {
          const pl = await API.listProcesses();
          engineLoaded = ((pl && pl.procs) || []).some(p => p.isAiEngine);
        } catch (_) {}
      }
      if (engineLoaded) return { ok: true };
    }
    // Otherwise (engine not loaded, or a non-reusing kind): predict the VRAM the
    // job's pipeline will allocate and compare against the slider limit.
    const projectedUsedGB = gpu.usedGB + cost;
    const projectedPct = (projectedUsedGB / gpu.totalGB) * 100;
    if (projectedPct > gpuLimits.vram) {
      return {
        ok: false,
        reason: `VRAM insuffisante: ${gpu.usedGB.toFixed(1)}/${gpu.totalGB.toFixed(1)} GB utilisés, ce job a besoin de ~${cost} GB supplémentaires → ${projectedPct.toFixed(0)}% > limite ${gpuLimits.vram}%. Le job attendra que la VRAM se libère.`
      };
    }
    // Also check absolute free headroom: even below the slider, refuse to start
    // if there's genuinely not enough free VRAM on the card.
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
    // Throttle the per-process list to ~2s while reusing the 500ms tick.
    if (Date.now() - _lastProcList > 2000) { _lastProcList = Date.now(); refreshProcList(); }
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
    document.querySelector('.gpu-bar[data-stat="util"]')?.classList.remove('over-limit');  // GPU at 100% is normal — never flag it red
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
  refreshProcList();  // 2026-06-14: immediate first paint of the process list + count
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
  const linkSite  = document.getElementById('about-link-site');
  const linkGH    = document.getElementById('about-link-github');
  const linkFAQ   = document.getElementById('about-link-faq');
  if (!btn || !modal) return;

  // Wire the "Website" / "GitHub" / "FAQ" links to open externally
  // (use the IPC because the allowed-host list lives there).
  const open = (url) => {
    if (window.wizardAPI?.openExternal) window.wizardAPI.openExternal(url);
    else window.open(url, '_blank');
  };
  linkSite?.addEventListener('click', (e) => { e.preventDefault(); open('https://fabienlacaze.github.io/MyFabmesh/'); });
  linkGH?.addEventListener('click',   (e) => { e.preventDefault(); open('https://github.com/fabienlacaze/MyFabmesh'); });
  linkFAQ?.addEventListener('click',  (e) => { e.preventDefault(); open('https://fabienlacaze.github.io/MyFabmesh/#faq'); });

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
      stageCardWithThumbs('1. Raw mesh', s1, (d) => {
        const s = d.score?.score || 0, t = d.score?.total || 6;
        const bg = s >= 4 ? '#1a5c1a' : s >= 2 ? '#8a6a1a' : '#8a1a1a';
        return { score: `${s}/${t}`, sub: `sim ${(d.score?.avg_similarity || 0).toFixed(2)}`, bg };
      }, 'axes'),
      stageCardWithThumbs('2. Multi-view generation', s2, (d) => {
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
      message: 'This will stop the pipeline immediately (mesh, multi-view, projection). Any partial output for this run will be discarded.',
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
    diagBody.innerHTML = `<p style="color:#aaa">Running ${engine.toUpperCase()} pipeline — ~4-5 min (${engine} + multi-view + projection)...</p>`;
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
      <p style="color:#aaa; margin-top:0;">Calibration v3 — 5 independent per-stage checks in ~7s. Stage 4 tests UV projection in isolation (skips mesh + auto-align), so its ceiling is 2/6 on the GT cube by design. Real pipeline uses the full chain and produces clean textures. Use this view to spot regressions, not as an absolute quality metric.</p>
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
            setTierState(t, 'running', ev.message || 'Mesh...');
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
      verdict = `<b>Plateau at ${t3.best_score}/${t3.target}.</b> No projection config reached a perfect score — the remaining loss is upstream (mesh quality or multi-view hallucinations), not a projection flag issue.`;
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
      // Always fully opaque + clickable. Use an amber tint when
      // unrestricted to signal 'danger zone' instead of dimming the
      // icon (which read as disabled / unclickable to the user).
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
    const job = pushJob(name, null, data.params || {}, expectedMs, {
      sourceImageUrl: data.sourceImageUrl || data.imagePath || data.meshPath || null,
      projectName: data.projectName || (state.currentProject ? state.currentProject.name : null),
    });
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
  const ok = await customConfirm('Re-skin this rig with current skinning options? The rig structure stays unchanged.', 'Re-skin', 'Re-skin');
  if (!ok) return;
  const skinMethod = document.getElementById('ws-rig-skin-method')?.value || 'auto';
  const skinSmoothing = parseInt(document.getElementById('ws-rig-skin-smooth')?.value) || 3;
  const mirrorX = document.getElementById('ws-rig-mirror-x')?.checked;
  const job = pushJob(`Re-skin: ${r.filename}`, null, {
    'Skinning': skinMethod,
    'Smoothing': skinSmoothing,
    'Mirror X': mirrorX ? 'yes' : 'no',
  }, undefined, { sourceImageUrl: r.path, projectName: state.currentProject?.name });
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
  // Capture dataTransfer SYNCHRONOUSLY — it is invalidated after the first
  // await (the download below). A file dragged from the OS has a real .path;
  // an image dragged from a web page (e.g. Google Images) has NO local path,
  // only a URL in text/html / text/uri-list / text/plain — download it first.
  const files = Array.from(e.dataTransfer?.files || []);
  const dt = e.dataTransfer;
  const uriList = dt?.getData?.('text/uri-list') || '';
  const htmlData = dt?.getData?.('text/html') || '';
  const plainData = dt?.getData?.('text/plain') || '';

  let path_ = '';
  let fileName = '';
  const localFile = files[0];
  if (localFile && localFile.path) {
    path_ = localFile.path;
    fileName = localFile.name || '';
  } else {
    const _extractUrl = () => {
      if (htmlData) {
        const m = htmlData.match(/<img[^>]+src=["']([^"']+)["']/i);
        if (m && /^https?:/i.test(m[1])) return m[1];
      }
      if (uriList) {
        const line = uriList.split(/\r?\n/).map(s => s.trim())
          .find(s => s && !s.startsWith('#') && /^https?:/i.test(s));
        if (line) return line;
      }
      const p = (plainData || '').trim();
      if (/^https?:\/\//i.test(p)) return p;
      return '';
    };
    const webUrl = _extractUrl();
    if (!webUrl) {
      showToast?.('Drop a local file, or drag an actual image from a web page.', 'error', 4500);
      return;
    }
    showToast?.('Downloading dragged image…', 'info', 2500);
    try {
      const dl = await API.downloadToTemp(webUrl);
      if (!dl || !dl.success || !dl.path) {
        showToast?.('Could not download the dragged image: ' + (dl?.error || 'unknown'), 'error', 4500);
        return;
      }
      path_ = dl.path;
      fileName = dl.filename || '';
    } catch (err) {
      showToast?.('Download failed: ' + err.message, 'error', 4500);
      return;
    }
  }

  const isImage = /\.(png|jpg|jpeg|webp|gif)$/i.test(fileName);
  const isMesh = /\.(glb|gltf|obj|fbx|stl|ply)$/i.test(fileName);
  if (!isImage && !isMesh) {
    showToast?.('Unsupported file type. Use png/jpg/webp or glb/obj/fbx/stl/ply.', 'error', 4500);
    return;
  }
  // Context-aware:
  //  - inside an open project (workspace) -> add a NEW VERSION of the element
  //    (image / mesh / rig / animation) to the right strip.
  //  - on the projects grid -> CREATE a new project from the dropped element.
  const intoProject = !!(state.currentProject && state.page === 'workspace');
  if (!intoProject) {
    // Drop on the projects grid: open the New Project popup so the user NAMES the
    // project (it used to auto-derive a name from the filename and silently create
    // a project). np-create imports __pendingDroppedFile into the named project.
    window.__pendingDroppedFile = { filePath: path_, fileName, isImage, isMesh };
    openNewProjectModal();
    return;
  }
  const _dirOf = (x) => {
    const s = typeof x === 'string' ? x : (x && x.path) || '';
    return s.replace(/[\\/][^\\/]*$/, '');
  };
  const intoImageDir = intoProject
    ? _dirOf(state.currentProject.selectedImagePath
        || state.currentProject.images?.[0]?.path
        || state.currentProject.images?.[0])
    : null;
  try {
    const r = await API.importDroppedFile({
      filePath: path_,
      projectName: intoProject ? state.currentProject.name : null,
      intoImageDir,
    });
    if (!r || !r.success) {
      showToast?.('Import failed: ' + (r?.error || 'unknown'), 'error', 4000);
      return;
    }
    // NSFW filter on the dropped element (esp. images dragged from the web).
    // batchCheckNsfw runs nsfw_scan.py which writes the .nsfw sidecar for
    // flagged images; the version strips already hide tagged images when
    // parental control is on. Returns {} in unrestricted mode (no-op).
    if (r.kind === 'image' && r.path && API.batchCheckNsfw) {
      try {
        const nsfw = await API.batchCheckNsfw({ images: [r.path] });
        if (nsfw && nsfw[r.path]) {
          const kept = await _nsfwBlockedUnlock(async () => {
            if (typeof reloadCurrentProject === 'function') await reloadCurrentProject();
          });
          if (!kept) {
            if (typeof reloadCurrentProject === 'function') await reloadCurrentProject();
            return;
          }
          // unlocked -> image now allowed; fall through to the normal post-import
        }
      } catch (e) { console.warn('[drop] NSFW scan failed:', e); }
    }
    if (intoProject) {
      if (typeof reloadCurrentProject === 'function') await reloadCurrentProject();
      // Flip the strip matching the dropped element to its Edit stage + pulse.
      const cardId = r.kind === 'image' ? 'step-card-image'
        : r.kind === 'rig' ? 'step-card-rig'
        : r.kind === 'anim' ? 'step-card-animation'
        : 'step-card-mesh';
      const card = document.getElementById(cardId);
      if (card) {
        card.classList.remove('collapsed', 'disabled');
        const createStage = card.querySelector('.stage-create');
        const editStage = card.querySelector('.stage-edit');
        if (createStage) createStage.open = false;
        if (editStage) editStage.open = true;
        setTimeout(() => {
          card.scrollIntoView({ behavior: 'smooth', block: 'start' });
          card.classList.add('pulse-highlight');
          setTimeout(() => card.classList.remove('pulse-highlight'), 1500);
        }, 120);
      }
      showToast?.(`Added a new ${r.kind} version`, 'success', 1800);
    } else {
      await refreshProjectsPage();
      showToast?.('New project created from import', 'success', 1800);
    }
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

// ----------------------------------------------------------------
// Extract landmark positions from an already-generated rig.
// Loads the selected rig GLB, walks the bone tree, fuzzy-matches each
// bone name against the LM_SCHEMA ids, and places a landmark marker
// at each matched bone's WORLD position. Equivalent to manual
// click-placement so "Re-generate rig with these landmarks" sees them.
async function extractLandmarksFromRig() {
  const p = state.currentProject;
  const rigPath = p?.selectedRigPath
              || (p?.rigs && p.rigs[0]?.url)
              || (p?.rigs && p.rigs[0]?.path);
  if (!rigPath) {
    if (typeof customError === 'function')
      customError('Generate a rig first (Step 3 Rig → Generate Rig).', 'From rig');
    return;
  }
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
    const clean = String(name || '').replace(/^mixamo[^:]*:/i, '').trim();
    for (const r of BONE_RULES) {
      for (const p of r.patterns) {
        if (p.test(name) || p.test(clean)) return r.id;
      }
    }
    return null;
  }
  try {
    lmPushHistory();
    const buffer = await API.readMeshFile(rigPath);
    if (!buffer) {
      if (typeof customError === 'function') customError('Could not load rig file.', 'From rig');
      return;
    }
    const rigScene = await new Promise((resolve, reject) => {
      new GLTFLoader().parse(buffer, '', (gltf) => resolve(gltf.scene), reject);
    });
    const box = new THREE.Box3().setFromObject(rigScene);
    const center = box.getCenter(new THREE.Vector3());
    rigScene.position.x -= center.x;
    rigScene.position.z -= center.z;
    rigScene.position.y -= box.min.y;
    rigScene.updateMatrixWorld(true);
    const bones = [];
    rigScene.traverse((c) => {
      if (c.isBone) bones.push(c);
      else if (c.isSkinnedMesh && c.skeleton) {
        for (const b of c.skeleton.bones) if (!bones.includes(b)) bones.push(b);
      }
    });
    if (!bones.length) {
      if (typeof customError === 'function') customError('No bones found in the selected rig.', 'From rig');
      return;
    }
    let matched = 0;
    const seen = new Set();
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
    if (matched === 0) {
      if (typeof customError === 'function')
        customError(`Found ${bones.length} bone(s) but none matched a known landmark name.\n\nFirst few names: ${bones.slice(0, 8).map(b => b.name).join(', ')}`, 'From rig');
      return;
    }
    if (typeof showToast === 'function') {
      showToast(`Imported ${matched} landmark(s) from rig — drag them to adjust, then click "Re-generate rig".`, 'success', 5000);
    }
  } catch (e) {
    console.error('[extractLandmarksFromRig]', e);
    if (typeof customError === 'function') customError('Failed to read the rig: ' + (e?.message || e), 'From rig');
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
        // Snap to the CLOSEST bone if a rig is loaded — the user is
        // usually trying to target a specific bone visible via the
        // skeleton overlay. Also remember which bone we snapped to so
        // a future drag can update that bone's position.
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
      // If this marker is linked to an AI bone, move the bone too.
      // Two modes (controlled by the "Freeze mesh" checkbox):
      //   - DEFORM (unchecked): skinning follows bone → mesh warps.
      //   - FREEZE (checked, default): recompute boneInverse so the
      //     skinning identity preserves vertex world positions →
      //     mesh stays put, bone gizmo moves alone.
      const linkedBone = marker.userData?._linkedBone;
      if (linkedBone && linkedBone.parent) {
        try {
          linkedBone.parent.updateMatrixWorld(true);
          const localPos = linkedBone.parent.worldToLocal(corrected.clone());
          linkedBone.position.copy(localPos);
          linkedBone.updateMatrixWorld(true);
          const freezeMesh = document.getElementById('lm-fs-freeze-mesh')?.checked;
          if (freezeMesh && typeof lmFsModel !== 'undefined' && lmFsModel) {
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
        } catch (_e) { /* ignore */ }
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
  // Bright lighting — match the main 3D Mesh viewer rig (dark meshes
  // were nearly invisible in the landmark modal with the previous defaults).
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
  lmFsControls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
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
    lmFsControlsB.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
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
  // project — without this guard it survives project-switches and
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
  // Auto-extract landmarks from the selected rig (if any) on the first
  // open of this session. Only runs when no markers have been placed
  // yet — avoids stomping the user's manual edits when they re-open
  // the modal mid-tweak.
  try {
    const hasExistingMarkers = (typeof lmMarkers === 'object')
      && lmMarkers && Object.keys(lmMarkers).length > 0;
    const cp = state.currentProject;
    const hasRig = !!(cp?.selectedRigPath || (cp?.rigs && cp.rigs[0]));
    if (!hasExistingMarkers && hasRig) {
      setTimeout(() => {
        try { extractLandmarksFromRig(); }
        catch (e) { console.warn('[lm] auto-extract from rig failed:', e); }
      }, 200);
    }
  } catch (_) {}
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
document.getElementById('lm-fs-from-rig')?.addEventListener('click', () => {
  extractLandmarksFromRig().then(() => {
    try { if (typeof refreshLmFsSilhouetteDots === 'function') refreshLmFsSilhouetteDots(); } catch (_) {}
  });
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
// 2026-06-13: styled 4-choice quit modal.
// Returns 'stop' | 'pause' | 'keep' | 'cancel'.
function customQuitChoice(runningCount) {
  return new Promise((resolve) => {
    const modal = document.getElementById('modal-quit-jobs');
    const msg = document.getElementById('quit-jobs-message');
    const stopBtn = document.getElementById('quit-jobs-stop');
    const pauseBtn = document.getElementById('quit-jobs-pause');
    const keepBtn = document.getElementById('quit-jobs-keep');
    const cancelBtn = document.getElementById('quit-jobs-cancel');
    if (!modal) { resolve('stop'); return; }
    msg.textContent = `${runningCount} job${runningCount > 1 ? 's are' : ' is'} still running.`;
    modal.classList.remove('hidden');
    function cleanup(result) {
      modal.classList.add('hidden');
      stopBtn.removeEventListener('click', onStop);
      pauseBtn.removeEventListener('click', onPause);
      keepBtn.removeEventListener('click', onKeep);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onOverlay);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onStop() { cleanup('stop'); }
    function onPause() { cleanup('pause'); }
    function onKeep() { cleanup('keep'); }
    function onCancel() { cleanup('cancel'); }
    function onOverlay(e) { if (e.target === modal) cleanup('cancel'); }
    function onKey(e) { if (e.key === 'Escape') cleanup('cancel'); }
    stopBtn.addEventListener('click', onStop);
    pauseBtn.addEventListener('click', onPause);
    keepBtn.addEventListener('click', onKeep);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onOverlay);
    document.addEventListener('keydown', onKey);
    setTimeout(() => cancelBtn.focus(), 50);
  });
}

// 2026-06-13: re-create the "Running task" popup for jobs that main.js
// resumed on launch. We lost the original stdout pipe, so progress is
// indeterminate — the popup shows the job is in-flight, and main.js
// watches the PID and fires job-pid-exited when it finishes so we can
// complete the popup. Map rootPid -> renderer jobId.
const _resumedJobByPid = new Map();
if (window.meshyAPI?.onJobsResumed) {
  window.meshyAPI.onJobsResumed(({ resumed, dropped, jobs }) => {
    if (Array.isArray(jobs)) {
      for (const job of jobs) {
        try {
          const expectedMs = job.expectedMs || 120000;
          const j = (typeof pushJob === 'function')
            ? pushJob(`${job.label} (resumed)`, null, {
                State: 'Resumed from a paused session',
              }, expectedMs)
            : null;
          if (j) {
            // Resume the time-based bar EXACTLY where it was: set
            // startedAt back so elapsed = the pausedElapsed we saved,
            // and restore the last known % so it doesn't visibly dip.
            if (job.pausedElapsed != null) {
              j.startedAt = Date.now() - job.pausedElapsed;
            }
            if (job.progress != null) {
              j.progress = Math.max(j.progress || 0, job.progress);
            }
            try { renderJobs?.(); } catch (_) {}
            _resumedJobByPid.set(job.rootPid, j.id);
          }
        } catch (_) {}
      }
    }
    if (resumed > 0) {
      showToast?.(`Resumed ${resumed} paused job${resumed > 1 ? 's' : ''} — finishing in the background.`, 'success', 8000);
    }
    if (dropped > 0) {
      showToast?.(`${dropped} paused job${dropped > 1 ? 's' : ''} could not be resumed (process no longer alive). Re-generate if needed.`, 'error', 8000);
    }
  });
}
if (window.meshyAPI?.onJobPidExited) {
  window.meshyAPI.onJobPidExited(({ rootPid }) => {
    const jobId = _resumedJobByPid.get(rootPid);
    if (jobId != null && typeof completeJob === 'function') {
      try { completeJob(jobId, true); } catch (_) {}
      _resumedJobByPid.delete(rootPid);
    }
    // Refresh the current view so the new output (mesh / rig / animation)
    // appears without the user having to manually reload.
    try {
      if (state.page === 'projects') refreshProjectsPage?.();
      else if (state.currentProject) reloadCurrentProject?.();
    } catch (_) {}
  });
}

if (API.onAppCloseRequested) {
  API.onAppCloseRequested(async () => {
    // Count BOTH the renderer-tracked jobs and any subprocess still
    // alive in main.js (in case the renderer was F5'd while a job ran).
    let runningCount = state.jobs.filter(j => j.status === 'running').length;
    try {
      const backend = await API.jobsRunningCount?.();
      if (typeof backend === 'number') runningCount = Math.max(runningCount, backend);
    } catch (_) {}
    if (runningCount === 0) {
      API.confirmAppClose({ killJobs: true });
      return;
    }
    const choice = await customQuitChoice(runningCount);
    if (choice === 'cancel') {
      // Stay open — main.js already called event.preventDefault() and we
      // never reply, so the window doesn't close.
      return;
    }
    if (choice === 'stop') {
      // Cancel renderer jobs first so the user sees them stop, then tell
      // main to kill everything + close.
      try {
        for (const j of state.jobs.filter(j => j.status === 'running')) {
          if (API.cancelJob) await API.cancelJob(j.id);
        }
      } catch (_) {}
      API.confirmAppClose({ killJobs: true });
    } else if (choice === 'pause') {
      // Snapshot each running job's progress so it can resume EXACTLY
      // where it was. pausedElapsed = how much wall-time the time-based
      // bar had accumulated; on resume we set startedAt = now -
      // pausedElapsed so the bar picks up at the same %.
      const jobStates = state.jobs
        .filter(j => j.status === 'running')
        .map(j => ({
          kind: j.kind || inferKind(j.name || ''),
          label: j.name || 'Background job',
          expectedMs: j.expectedMs || 60000,
          progress: j.progress || 5,
          pausedElapsed: Math.max(0, Date.now() - (j.startedAt || Date.now())),
        }));
      // Suspend the subprocess trees + persist; they resume on next launch.
      API.confirmAppClose({ pauseJobs: true, jobStates });
    } else if (choice === 'keep') {
      // Close the window but leave subprocesses running.
      API.confirmAppClose({ killJobs: false });
    }
  });
}

// ============================================================
// INIT
// ============================================================
showPage('projects');
