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

const API = window.meshyAPI;

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
    // Remove trailing timestamp (_<10+ digits>)
    base = base.replace(/_\d{10,}$/, '');
    // Remove trailing engine suffix added by main.js: _sf3d / _meshy / _hunyuan / _local / _trellis / _trellis2 / _triposg / _ai
    base = base.replace(/_(sf3d|meshy|hunyuan|local|trellis2|trellis|triposg|ai)$/i, '');
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
}

function renderProjectsGrid() {
  const grid = document.getElementById('projects-grid');
  const empty = document.getElementById('projects-empty');
  grid.innerHTML = '';
  if (state.projects.length === 0) {
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
  }
  for (const p of state.projects) {
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
document.getElementById('np-cancel').addEventListener('click', closeNewProjectModal);
document.getElementById('np-create').addEventListener('click', async () => {
  const name = document.getElementById('np-name').value.trim() || 'project';
  const prompt = document.getElementById('np-prompt').value.trim();
  closeNewProjectModal();
  // Create an empty project shell and open it
  const proj = {
    name,
    images: [],
    meshes: [],
    rigs: [],
    thumb: null,
    initialPrompt: prompt,
  };
  state.currentProject = proj;
  showPage('workspace');
  populateWorkspace(proj);
  if (prompt) {
    document.getElementById('ws-prompt').value = prompt;
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
    }, 80);
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
  p.previewImagePath = null;
  p.selectedMeshPath = null;
  p.previewMeshPath = null;
  // If a single item exists, it's automatically the one used for the next step.
  // Nothing extra to do here — renderImageVersions/renderMeshVersions handle it.

  // Image step
  renderImageVersions(p);
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
function renderImageVersions(p) {
  const strip = document.getElementById('ws-image-versions');
  strip.innerHTML = '';
  // Default: latest version is both previewed AND selected for 3D
  if (p.images.length > 0) {
    if (!p.previewImagePath) p.previewImagePath = p.images[0].path;
    if (!p.selectedImagePath) p.selectedImagePath = p.images[0].path;
  }
  p.images.forEach((img, i) => {
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
      <span class="v-label">v${p.images.length - 1 - i}</span>
      <button class="version-delete-btn" title="Delete this version">&#10005;</button>
    `;
    t.addEventListener('click', () => {
      strip.querySelectorAll('.version-thumb').forEach(x => x.classList.remove('selected'));
      t.classList.add('selected');
      p.previewImagePath = img.path;
      showStep1Preview(img.path);
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

function showStep2SourceImage(imgPath) {
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
}

// ----- Source mesh preview for the Rig "Create new" stage -----
let rigSrcRenderer, rigSrcScene, rigSrcCamera, rigSrcControls, rigSrcModel, rigSrcRafId;
let rigSrcMeshPath = null; // path of the mesh currently loaded in the rig source viewer
function initRigSrcViewer() {
  if (rigSrcRenderer) return;
  const canvas = document.getElementById('ws-rig-source-canvas');
  if (!canvas) return;
  const w = canvas.clientWidth || 240, h = canvas.clientHeight || 240;
  rigSrcRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  rigSrcRenderer.setSize(w, h, false);
  rigSrcRenderer.setPixelRatio(window.devicePixelRatio);
  rigSrcRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  rigSrcRenderer.toneMappingExposure = 1.4;
  rigSrcScene = new THREE.Scene();
  rigSrcScene.background = new THREE.Color(0x0b0b14);
  rigSrcCamera = new THREE.PerspectiveCamera(45, w / h, 0.01, 100);
  rigSrcCamera.position.set(2, 2, 3);
  rigSrcControls = new OrbitControls(rigSrcCamera, canvas);
  rigSrcControls.enableDamping = true;
  rigSrcScene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 2.0));
  const dir = new THREE.DirectionalLight(0xffffff, 2.5);
  dir.position.set(5, 8, 5);
  rigSrcScene.add(dir);
  rigSrcScene.add(new THREE.AmbientLight(0xffffff, 0.6));
  function tick() {
    const visible = canvas.offsetParent !== null && document.visibilityState !== 'hidden';
    if (visible) {
      rigSrcControls.update();
      rigSrcRenderer.render(rigSrcScene, rigSrcCamera);
    }
    rigSrcRafId = requestAnimationFrame(tick);
  }
  tick();
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
    loader.parse(buffer, '', (gltf) => applyLoadedModel(gltf.scene),
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
}

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
  lb3dRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  lb3dRenderer.setPixelRatio(window.devicePixelRatio);
  lb3dRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  lb3dRenderer.toneMappingExposure = 1.4;
  lb3dScene = new THREE.Scene();
  lb3dScene.background = new THREE.Color(0x0b0b14);
  lb3dCamera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 5000);
  lb3dCamera.position.set(2, 2, 3);
  lb3dControls = new OrbitControls(lb3dCamera, canvas);
  lb3dControls.enableDamping = true;
  // Bright base lighting
  lb3dScene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 2.0));
  const dir = new THREE.DirectionalLight(0xffffff, 2.5);
  dir.position.set(5, 8, 5);
  lb3dScene.add(dir);
  const fill = new THREE.DirectionalLight(0xffffff, 1.0);
  fill.position.set(-5, 3, -5);
  lb3dScene.add(fill);
  lb3dScene.add(new THREE.AmbientLight(0xffffff, 0.6));
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
      loader.parse(buffer, '', (gltf) => fitAndApply(gltf.scene),
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
function openLightbox(imgPath) {
  const lb = document.getElementById('lightbox-2');
  const img = document.getElementById('lightbox-2-img');
  // Build the image list from the current project so prev/next can navigate
  const p = state.currentProject;
  _lightboxImages = (p && p.images) ? p.images.map(i => i.path) : [imgPath];
  _lightboxIndex = Math.max(0, _lightboxImages.indexOf(imgPath));
  img.src = 'file:///' + imgPath.replace(/\\/g, '/') + '?t=' + Date.now();
  updateLightboxBottom(imgPath);
  updateLightboxNavButtons();
  lb.classList.remove('hidden');
}
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
const ASSET_TYPE_PROMPTS = {
  character: 'single isolated 3D character, full body, T-pose neutral stance, RTS unit game asset, plain white background, even studio lighting, no shadows, no other characters, centered, isometric three-quarter view, clean silhouette, no text, no UI',
  building: 'single isolated 3D building, full structure, plain white background, even studio lighting, no shadows, no characters, centered, isometric three-quarter view, clean silhouette, no text, no UI',
  vehicle: 'single isolated 3D vehicle, complete vehicle, plain white background, even studio lighting, no shadows, no characters, centered, three-quarter view, clean silhouette, no text, no UI',
  weapon: 'single isolated 3D weapon, full weapon, plain white background, even studio lighting, no shadows, centered, side view, clean silhouette, no text, no UI',
  prop: 'single isolated 3D prop, full item, plain white background, even studio lighting, no shadows, no characters, centered, three-quarter view, clean silhouette, no text, no UI',
  creature: 'single isolated 3D creature, full body, neutral stance, plain white background, even studio lighting, no shadows, no other creatures, centered, isometric three-quarter view, clean silhouette, no text, no UI',
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
document.getElementById('ws-enhance-prompt')?.addEventListener('click', () => {
  const textarea = document.getElementById('ws-prompt');
  const raw = textarea.value.trim();
  if (!raw) { alert('Type a description first.'); return; }
  const assetType = document.getElementById('ws-asset-type')?.value || 'character';
  const assetStyle = document.getElementById('ws-asset-style')?.value || 'realistic';
  // Check if the prompt already looks enhanced (contains known suffix keywords)
  const alreadyEnhanced = /single isolated 3D|plain white background|sharp details|photorealistic/i.test(raw);
  if (alreadyEnhanced) {
    alert('Prompt already looks enhanced. Edit manually or clear it first.');
    return;
  }
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
  if (!userPrompt) { alert('Type a description first.'); return; }
  const assetType = document.getElementById('ws-asset-type')?.value || 'character';
  const assetStyle = document.getElementById('ws-asset-style')?.value || 'realistic';
  const prompt = buildFullPrompt(userPrompt, assetType, assetStyle);
  const engine = document.getElementById('ws-engine').value;
  const count = parseInt(document.getElementById('ws-count').value) || 4;
  const steps = parseInt(document.getElementById('ws-quality').value) || 30;
  const multiView = document.getElementById('ws-multiview')?.checked || false;
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
  const expectedMs = totalImages * perImage + 3000; // + small warm-up
  gatedRun('image', `Generate images: ${p.name}`, async () => {
    const job = pushJob(`Generate images: ${p.name}`, null, {
      'Asset type': assetType,
      Style: assetStyle,
      Engine: engineLabel(engine),
      Count: count,
      Steps: steps,
      'Multi-view': multiView ? 'yes' : 'no',
      'Construction stages': buildStages ? 'yes' : 'no',
      Prompt: userPrompt,
    }, expectedMs);
    try {
      const r = await API.generateImages({ prompt, userPrompt, engine, numImages: count, projectName: p.name, steps, multiView, buildStages, jobId: job.id, vramFraction: (gpuLimits?.vram || 90) / 100 });
      if (r?.success) {
        completeJob(job.id, true);
        await reloadCurrentProject();
        // After successful image generation, open the Edit stage and scroll
        // to show the newly generated images. Without this the user stays
        // on the "Create new" form and doesn't see the results.
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
// Modify image: opens a popup (consistent with Clone Stamp / Draw Mask)
const modifyModal = document.getElementById('modal-modify-image');
const modStrength = document.getElementById('mod-strength');
const modStrengthVal = document.getElementById('mod-strength-val');
modStrength.addEventListener('input', () => { modStrengthVal.textContent = modStrength.value + '%'; });

document.getElementById('ws-modify-btn').addEventListener('click', () => {
  const p = state.currentProject;
  if (!p || !p.selectedImagePath) { alert('Pick an image first.'); return; }
  // Show the source image inside the modal
  const srcImg = document.getElementById('mod-source-img');
  if (srcImg) srcImg.src = 'file:///' + p.selectedImagePath.replace(/\\/g, '/') + '?t=' + Date.now();
  modifyModal.classList.remove('hidden');
  setTimeout(() => document.getElementById('mod-prompt').focus(), 50);
});
document.getElementById('mod-cancel').addEventListener('click', () => {
  modifyModal.classList.add('hidden');
});
document.getElementById('mod-apply').addEventListener('click', async () => {
  const p = state.currentProject;
  if (!p || !p.selectedImagePath) return;
  const prompt = document.getElementById('mod-prompt').value.trim();
  if (!prompt) { alert('Type a modification first.'); return; }
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
      const r = await API.img2img({ imagePath: p.selectedImagePath, prompt, strength, engine, jobId: job.id });
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

document.getElementById('ws-removebg-btn').addEventListener('click', async () => {
  const p = state.currentProject;
  if (!p || !p.selectedImagePath) { alert('Pick an image first.'); return; }
  gatedRun('bg', `Remove background: ${p.name}`, async () => {
    const job = pushJob(`Remove background: ${p.name}`);
    try {
      const r = await API.removeBackground(p.selectedImagePath);
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
  if (!p || !p.selectedImagePath) { alert('Pick an image first.'); return; }
  window.openCloneToolFor(p.selectedImagePath, p.name, async () => {
    await reloadCurrentProject();
  });
});
document.getElementById('ws-mask-btn').addEventListener('click', () => {
  const p = state.currentProject;
  if (!p || !p.selectedImagePath) { alert('Pick an image first.'); return; }
  window.openMaskToolFor(p.selectedImagePath, p.name, async () => {
    await reloadCurrentProject();
  });
});

// ----- Mesh step -----
let wsRenderer, wsScene, wsCamera, wsControls, wsModel, wsRafId;
function initWsThree() {
  if (wsRenderer) return;
  const canvas = document.getElementById('ws-mesh-canvas');
  const w = canvas.clientWidth || 320, h = canvas.clientHeight || 260;
  // preserveDrawingBuffer is required so canvas.toDataURL() can capture
  // the rendered scene for thumbnail saving (used by job-details overlay).
  wsRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  wsRenderer.setSize(w, h, false);
  wsRenderer.setPixelRatio(window.devicePixelRatio);
  wsRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  wsRenderer.toneMappingExposure = 1.4;
  wsScene = new THREE.Scene();
  wsScene.background = new THREE.Color(0x1d1d2c);
  wsCamera = new THREE.PerspectiveCamera(45, w / h, 0.01, 100);
  wsCamera.position.set(2, 2, 3);
  wsControls = new OrbitControls(wsCamera, canvas);
  wsControls.enableDamping = true;
  // Bright base lighting so the slider has plenty of headroom
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444466, 2.0);
  wsScene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 2.5);
  dir.position.set(5, 8, 5);
  wsScene.add(dir);
  const fill = new THREE.DirectionalLight(0xffffff, 1.0);
  fill.position.set(-5, 3, -5);
  wsScene.add(fill);
  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  wsScene.add(ambient);
  function tick() {
    // Pause rendering when the canvas is offscreen / hidden — saves ~5% CPU
    // and ~10W on the GPU when the user is on the projects page or has the
    // workspace collapsed.
    const visible = canvas.offsetParent !== null && document.visibilityState !== 'hidden';
    if (visible) {
      wsControls.update();
      wsRenderer.render(wsScene, wsCamera);
    }
    wsRafId = requestAnimationFrame(tick);
  }
  tick();
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
    // Save a thumbnail of the mesh after the first render so job-details /
    // rig running-task popup can show the actual 3D model that is being
    // rigged, not the source image. We wait 2 frames so the renderer
    // has rendered the new scene at least once.
    requestAnimationFrame(() => requestAnimationFrame(async () => {
      try {
        wsRenderer.render(wsScene, wsCamera);
        const canvas = document.getElementById('ws-mesh-canvas');
        const dataUrl = canvas.toDataURL('image/png');
        if (API.saveThumbnail) {
          await API.saveThumbnail({ meshPath: mesh.path, dataUrl });
        }
      } catch (e) {
        console.warn('[thumb] save mesh thumbnail failed:', e && e.message);
      }
    }));
  }, (err) => { console.error('GLTF parse error', err); });
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
  wsCamera.position.set(size * 1.2, size * 0.8 + lookY, size * 1.2);
  wsCamera.lookAt(0, lookY, 0);
  wsControls.target.set(0, lookY, 0);
  wsControls.update();
}

function renderMeshVersions(p) {
  const strip = document.getElementById('ws-mesh-versions');
  strip.innerHTML = '';
  // Default: latest mesh is both previewed AND selected for rig
  if (p.meshes.length > 0) {
    if (!p.previewMeshPath) p.previewMeshPath = p.meshes[0].path;
    if (!p.selectedMeshPath) p.selectedMeshPath = p.meshes[0].path;
  }
  p.meshes.forEach((m, i) => {
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
      <span class="v-label">v${p.meshes.length - 1 - i}</span>
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
const MESH_QUALITY_PRESETS = {
  draft:    { tex: 512,  verts: 3000,  expectedMs: 12000 },
  standard: { tex: 1024, verts: -1,    expectedMs: 20000 },
  high:     { tex: 2048, verts: 30000, expectedMs: 45000 },
};
const MESH_TRI_PRESETS = {
  '0': { subdivide: 0, label: '~13K',  extraMs: 0 },
  '1': { subdivide: 1, label: '~50K',  extraMs: 5000 },
  '2': { subdivide: 2, label: '~200K', extraMs: 8000 },
  '3': { subdivide: 3, label: '~800K', extraMs: 15000 },
};
const TEX_LABELS = { 512: '512 px', 1024: '1024 px', 2048: '2048 px' };

function updateMeshHint() {
  const hint = document.getElementById('ws-3d-quality-hint');
  if (!hint) return;
  const q = document.getElementById('ws-3d-quality')?.value || 'standard';
  const t = document.getElementById('ws-3d-triangles')?.value || '0';
  const preset = MESH_QUALITY_PRESETS[q] || MESH_QUALITY_PRESETS.standard;
  const tri = MESH_TRI_PRESETS[t] || MESH_TRI_PRESETS['0'];
  hint.textContent = `${tri.label} triangles · ${TEX_LABELS[preset.tex] || preset.tex} texture`;
}
document.getElementById('ws-3d-quality')?.addEventListener('change', updateMeshHint);
document.getElementById('ws-3d-triangles')?.addEventListener('change', updateMeshHint);

document.getElementById('ws-generate-mesh').addEventListener('click', async () => {
  const p = state.currentProject;
  if (!p || !p.selectedImagePath) { alert('Pick an image first.'); return; }
  const engine = document.getElementById('ws-3d-engine').value;
  const quality = document.getElementById('ws-3d-quality')?.value || 'standard';
  const triLevel = document.getElementById('ws-3d-triangles')?.value || '0';
  const preset = MESH_QUALITY_PRESETS[quality] || MESH_QUALITY_PRESETS.standard;
  const triPreset = MESH_TRI_PRESETS[triLevel] || MESH_TRI_PRESETS['0'];
  const buildStages = document.getElementById('ws-3d-buildstages')?.checked || false;
  let expectedMs;
  if (engine === 'sf3d') {
    expectedMs = preset.expectedMs + triPreset.extraMs;
  } else if (engine === 'meshy') {
    expectedMs = 240000;
  } else {
    expectedMs = 60000;
  }
  if (buildStages) expectedMs *= 2.5;
  const params = {
    imagePath: p.selectedImagePath,
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
  if (!m) { alert('Pick a mesh first.'); return; }
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
  if (!m) { alert('Pick a mesh first.'); return; }
  try { await API.showInExplorer(m.path); } catch (e) { alert(e.message); }
});

document.getElementById('ws-mesh-refine-btn')?.addEventListener('click', () => {
  const m = getCurrentMeshObj();
  if (!m) { alert('Pick a mesh first.'); return; }
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
  if (!modification) { alert('Type a modification first.'); return; }
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

document.getElementById('ws-mesh-export-btn')?.addEventListener('click', () => {
  const m = getCurrentMeshObj();
  if (!m) { alert('Pick a mesh first.'); return; }
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
  const w = canvas.clientWidth || 320, h = canvas.clientHeight || 260;
  rigVwRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  rigVwRenderer.setSize(w, h, false);
  rigVwRenderer.setPixelRatio(window.devicePixelRatio);
  rigVwRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  rigVwRenderer.toneMappingExposure = 1.4;
  rigVwScene = new THREE.Scene();
  rigVwScene.background = new THREE.Color(0x1d1d2c);
  rigVwCamera = new THREE.PerspectiveCamera(45, w / h, 0.01, 5000);
  rigVwCamera.position.set(2, 2, 3);
  rigVwControls = new OrbitControls(rigVwCamera, canvas);
  rigVwControls.enableDamping = true;
  rigVwScene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 2.0));
  const dir = new THREE.DirectionalLight(0xffffff, 2.5);
  dir.position.set(5, 8, 5);
  rigVwScene.add(dir);
  const fill = new THREE.DirectionalLight(0xffffff, 1.0);
  fill.position.set(-5, 3, -5);
  rigVwScene.add(fill);
  rigVwScene.add(new THREE.AmbientLight(0xffffff, 0.6));
  function tick() {
    const visible = canvas.offsetParent !== null && document.visibilityState !== 'hidden';
    if (visible) {
      const now = performance.now() / 1000;
      const dt = Math.min(0.1, now - (rigVwLastTime || now));
      rigVwLastTime = now;
      if (rigVwMixer) rigVwMixer.update(dt);
      rigVwControls.update();
      rigVwRenderer.render(rigVwScene, rigVwCamera);
    } else {
      rigVwLastTime = performance.now() / 1000; // avoid huge dt jump on resume
    }
    requestAnimationFrame(tick);
  }
  tick();
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
  if (!r) { alert('No rig yet.'); return; }
  try { await API.showInExplorer(r.path); } catch (e) { alert(e.message); }
});

document.getElementById('ws-rig-blender-btn')?.addEventListener('click', async () => {
  const r = getCurrentRigObj();
  if (!r) { alert('No rig yet.'); return; }
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
  if (!r) { alert('No rig yet.'); return; }
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
  if (!r) { alert('No rig yet.'); return; }
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
  await refreshProjectsPage();
  const refreshed = state.projects.find(p => p.name === name);
  if (refreshed) {
    // Shared cache-buster timestamp so thumbnails force Electron to reread
    // files that may have been overwritten by a new generation.
    refreshed._reloadTs = Date.now();
    state.currentProject = refreshed;
    populateWorkspace(refreshed);
  }
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
  const PROG_RE = /_PROGRESS:\s*(\d{1,3})/;
  window.meshyAPI.onAI3DProgress((msg) => {
    try {
      if (!msg || typeof msg !== 'string') return;
      const m = PROG_RE.exec(msg);
      if (!m) return;
      const reported = Math.max(0, Math.min(99, parseInt(m[1], 10)));
      // Apply to the most recent running job whose kind is mesh/rig —
      // bridges that emit these markers are all in the 3D/rig pipeline.
      for (let i = state.jobs.length - 1; i >= 0; i--) {
        const j = state.jobs[i];
        if (j.status === 'running' && (j.kind === 'mesh' || j.kind === 'rig')) {
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
  // Smoothly climb from 5 to 90% over expected duration
  job.tickTimer = setInterval(() => {
    if (job.status !== 'running') { clearInterval(job.tickTimer); return; }
    const elapsed = Date.now() - job.startedAt;
    job.progress = Math.min(90, 5 + (elapsed / expected) * 85);
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
  // (the GLB being rigged), not the image. For image/3D gen we show the
  // project's selected image as before.
  const refImg = document.getElementById('jd-ref-img');
  const p = state.currentProject;
  const isRigJob = /rig/i.test(j.name || '');
  let thumbUrl = null;
  if (isRigJob && p && p.selectedMeshPath && API.getThumbnail) {
    try {
      const t = await API.getThumbnail(p.selectedMeshPath);
      if (t) thumbUrl = t + '?t=' + Date.now();
    } catch (_) {}
  }
  if (!thumbUrl && p) {
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
  const hintEl = document.getElementById('jd-first-run-hint');
  if (hintEl) {
    const engineStr = (j.params?.Engine || '').toLowerCase();
    const usesLocalSdxl =
      j.status === 'running' && (
        /realvis|local gpu|sdxl|img2img|inpaint|mask inpaint|clone|local sd/i.test(engineStr)
        || /inpaint|mask inpaint|img2img|remove bg|clone/i.test(j.name || '')
      );
    hintEl.classList.toggle('hidden', !usesLocalSdxl);
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
  if (!p || !p.previewImagePath) { alert('Pick an image first.'); return; }
  document.getElementById('ai-target').value = '';
  document.getElementById('ai-replace').value = '';
  // Show the source image inside the modal
  const srcImg = document.getElementById('ai-source-img');
  if (srcImg) srcImg.src = 'file:///' + p.previewImagePath.replace(/\\/g, '/') + '?t=' + Date.now();
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
  if (!p || !p.previewImagePath) return;
  const target = document.getElementById('ai-target').value.trim();
  if (!target) { alert('Type what to find first (e.g. "hat", "background")'); return; }
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
      const r = await API.autoInpaint({ imagePath: p.previewImagePath, targetText: target, prompt: replace, dilate, jobId: job.id });
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
  // Clamp to safe ranges so the queue logic always has room
  v.vram = Math.max(50, Math.min(100, Number(v.vram) || 90));
  v.util = Math.max(50, Math.min(100, Number(v.util) || 95));
  v.temp = Math.max(60, Math.min(100, Number(v.temp) || 80));
  v.ram  = Math.max(30, Math.min(100, Number(v.ram)  || 85));
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
function setupGpuLimitDragging() {
  document.querySelectorAll('.gpu-bar-limit').forEach(handle => {
    if (handle.dataset.bound) return;
    handle.dataset.bound = '1';
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
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
        pct = Math.max(5, Math.min(100, pct));
        handle.style.left = pct + '%';
        gpuLimits[stat] = pct;
        tip.textContent = formatValue(stat, pct);
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
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
    if (countEl) {
      const n = r.count || 0;
      countEl.textContent = n + (n === 0 ? '  (none)' : (n === 1 ? '  process' : '  processes'));
      countEl.classList.remove('warn', 'ok', 'error');
      if (n === 0) countEl.classList.add('ok');
      else if (n <= 2) countEl.classList.add('warn');
      else countEl.classList.add('error');
    }
    if (sdxlEl) {
      sdxlEl.textContent = r.sdxl ? 'Running (loaded)' : 'Stopped';
      sdxlEl.classList.remove('warn', 'ok', 'error');
      sdxlEl.classList.add(r.sdxl ? 'warn' : 'ok');
    }
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
  log('queue', `Job "${displayName}" queued — ${reason}`);
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

async function refreshGpuStats() {
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
    document.getElementById('set-blender-path').value = cfg?.blenderPath || '';
    const meshyInput = document.getElementById('set-meshy-api-key');
    if (meshyInput) meshyInput.value = cfg?.meshyApiKey || '';
  } catch (e) {}
  applyGpuLimitMarkers();
  setupGpuLimitDragging();
  refreshGpuStats();
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
document.getElementById('set-close')?.addEventListener('click', () => {
  document.getElementById('modal-settings').classList.add('hidden');
  if (_gpuPollTimer) { clearInterval(_gpuPollTimer); _gpuPollTimer = null; }
});
document.getElementById('set-open-logs')?.addEventListener('click', async () => {
  if (API.openLogsFolder) await API.openLogsFolder();
});
document.getElementById('set-kill-python')?.addEventListener('click', async () => {
  const ok = await customConfirm('Kill all Python subprocesses (orphan generations)? The SDXL server will be preserved.', 'Kill stuck Python', 'Kill');
  if (!ok) return;
  if (API.cancelJob) await API.cancelJob(0); // 0 = no specific jobId, triggers the orphan-kill fallback
  // Reload jobs list to clear any zombie entries on the renderer side
  state.jobs = state.jobs.filter(j => j.status !== 'running');
  renderJobs();
});

// Forward main process logs to the renderer console for live debugging
if (API.onMainLog) {
  API.onMainLog((entry) => {
    const fn = entry.level === 'ERROR' ? 'error' : (entry.level === 'WARN' ? 'warn' : 'log');
    console[fn](`[main:${entry.source}]`, entry.msg);
  });
}
document.getElementById('set-blender-browse')?.addEventListener('click', async () => {
  try {
    const r = await API.setBlenderPath();
    if (r) {
      document.getElementById('set-blender-path').value = r.blenderPath || r;
    }
  } catch (e) { alert('Browse failed: ' + e.message); }
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
  if (!r) { alert('No rig yet.'); return; }
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
  lmFsScene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 2.0));
  const dir = new THREE.DirectionalLight(0xffffff, 2.5);
  dir.position.set(5, 8, 5);
  lmFsScene.add(dir);
  lmFsScene.add(new THREE.DirectionalLight(0xffffff, 1.0).translateX(-5).translateY(3).translateZ(-5));
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
    lmFsRendererB.toneMappingExposure = 1.4;
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
