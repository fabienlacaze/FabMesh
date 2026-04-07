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

// ============================================================
// CUSTOM CONFIRM MODAL (replaces window.confirm)
// ============================================================
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
    modal.classList.remove('hidden');
    function cleanup(result) {
      modal.classList.add('hidden');
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
// LEGACY UI (escape hatch)
// ============================================================
document.getElementById('open-old-ui').addEventListener('click', () => {
  // Reload main window pointing to legacy index.html
  // Easiest: tell main process via a tiny IPC OR just navigate the window
  window.location.href = 'index.html';
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
  // Convention: <projectName>_<index>_<extra>.<ext> e.g. orc_42.glb, mesh_3_rigged_orc_v1.fbx
  function meshProject(filename) {
    // Strip extension
    let base = filename.replace(/\.[^.]+$/, '');
    // Remove "_rigged_<anything>" suffix
    base = base.replace(/_rigged_.+$/i, '');
    // Remove trailing _<number> (the index)
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
}

function refreshButtonStates(p) {
  if (!p) return;
  const btnImg = document.getElementById('ws-generate-image');
  if (btnImg) btnImg.textContent = p.images.length > 0 ? 'Generate new version' : 'Generate';
  const btnMesh = document.getElementById('ws-generate-mesh');
  if (btnMesh) {
    btnMesh.disabled = !p.selectedImagePath;
    btnMesh.textContent = p.meshes.length > 0 ? 'Generate new 3D version' : 'Generate 3D';
  }
  const btnRig = document.getElementById('ws-generate-rig');
  if (btnRig) {
    btnRig.disabled = !p.selectedMeshPath;
    btnRig.textContent = p.rigs.length > 0 ? 'Generate new rig version' : 'Generate Rig';
  }
}

function resetWorkspaceUI() {
  // Image step
  const step1Prev = document.getElementById('step1-preview');
  if (step1Prev) {
    step1Prev.innerHTML = '<div class="preview-placeholder">No image yet</div>';
    step1Prev.classList.remove('clickable');
    step1Prev.onclick = null;
  }
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
    // Remove any source-image overlay left from a previous project
    const overlay = step2Prev.querySelector('.step2-source-overlay');
    if (overlay) overlay.remove();
  }
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
  const step3Prev = document.getElementById('step3-preview');
  if (step3Prev) step3Prev.innerHTML = '<div class="preview-placeholder">No rig yet</div>';
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
  document.getElementById('ws-prompt').value = savedLocal || p.prompt || p.initialPrompt || '';

  // Reset image / mesh paths — they belonged to the previous project
  p.selectedImagePath = null;
  p.previewImagePath = null;
  p.selectedMeshPath = null;
  p.previewMeshPath = null;

  // Image step
  renderImageVersions(p);
  if (p.images.length > 0) {
    setStepStatus(1, 'done');
    showStep1Preview(p.images[0].path);
    enableStep(2);
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
  }

  // Rig step
  renderRigVersions(p);
  if (p.rigs.length > 0) {
    setStepStatus(3, 'done');
    showStep3Preview(p.rigs[0]);
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
    t.innerHTML = `
      <img src="file:///${img.path.replace(/\\/g, '/')}">
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
  // Smooth-scroll to the 3D mesh card
  step2Card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // Briefly highlight the 3D card with a pulse effect
  step2Card?.classList.add('pulse-highlight');
  setTimeout(() => step2Card?.classList.remove('pulse-highlight'), 1500);
});

function showStep2SourceImage(imgPath) {
  // If no mesh has been generated yet, show the source image as a hint in the step-2 preview
  const p = state.currentProject;
  if (p && p.meshes.length > 0) return; // mesh already present, don't overwrite
  const preview = document.getElementById('step2-preview');
  const placeholder = document.getElementById('step2-placeholder');
  if (placeholder) placeholder.style.display = 'none';
  if (preview) {
    // Keep the canvas element in the DOM for three.js, but add an overlay img
    let overlay = preview.querySelector('.step2-source-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'step2-source-overlay';
      preview.appendChild(overlay);
    }
    overlay.innerHTML = `
      <img src="file:///${imgPath.replace(/\\/g, '/')}">
      <div class="step2-source-label">Source image for 3D</div>
    `;
  }
}

function showStep1Preview(imgPath) {
  const preview = document.getElementById('step1-preview');
  preview.innerHTML = `
    <img src="file:///${imgPath.replace(/\\/g, '/')}">
    <button class="preview-expand-btn" title="Open full size">&#x26F6;</button>
  `;
  preview.classList.add('clickable');
  preview.onclick = (e) => {
    // Don't double-trigger when clicking the button
    openLightbox(imgPath);
  };
  // The button is inside the preview div so its click bubbles up — that's fine,
  // both the button and the image trigger the same lightbox.
  // Show the "use for 3D" helper bar
  const useBar = document.getElementById('ws-use-for-3d-bar');
  if (useBar) {
    const p = state.currentProject;
    const isSelected = p && p.selectedImagePath === imgPath;
    useBar.classList.remove('hidden');
    const btn = document.getElementById('ws-use-for-3d-btn');
    if (btn) {
      btn.disabled = isSelected;
      btn.textContent = isSelected ? '\u2713 Used for 3D generation' : 'Use this image for 3D \u2192';
    }
  }
}

// ----- Lightbox -----
function openLightbox(imgPath) {
  const lb = document.getElementById('lightbox-2');
  const img = document.getElementById('lightbox-2-img');
  img.src = 'file:///' + imgPath.replace(/\\/g, '/') + '?t=' + Date.now();
  lb.classList.remove('hidden');
}
function closeLightbox() {
  document.getElementById('lightbox-2').classList.add('hidden');
}
document.getElementById('lightbox-2').addEventListener('click', (e) => {
  // Close when clicking the background (not the image itself)
  if (e.target.id === 'lightbox-2' || e.target.id === 'lightbox-2-close') closeLightbox();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.getElementById('lightbox-2').classList.contains('hidden')) {
    closeLightbox();
  }
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

document.getElementById('ws-generate-image').addEventListener('click', async () => {
  const p = state.currentProject;
  if (!p) return;
  const prompt = document.getElementById('ws-prompt').value.trim();
  if (!prompt) { alert('Type a description first.'); return; }
  const engine = document.getElementById('ws-engine').value;
  const count = parseInt(document.getElementById('ws-count').value) || 4;
  const steps = parseInt(document.getElementById('ws-quality').value) || 30;
  const job = pushJob(`Generate images: ${p.name}`, null, {
    Engine: engine,
    Count: count,
    Steps: steps,
    Prompt: prompt,
  });
  try {
    const r = await API.generateImages({ prompt, engine, numImages: count, projectName: p.name, steps });
    if (r?.success) {
      completeJob(job.id, true);
      // Refresh the project's images from disk
      await reloadCurrentProject();
    } else {
      completeJob(job.id, false);
      alert('Generation failed: ' + (r?.error || 'unknown'));
    }
  } catch (e) {
    completeJob(job.id, false);
    alert('Generation error: ' + e.message);
  }
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
  const job = pushJob(`Modify image: ${p.name}`, null, {
    Engine: engine,
    Strength: `${Math.round(strength * 100)}%`,
    Prompt: prompt,
  });
  try {
    const r = await API.img2img({ imagePath: p.selectedImagePath, prompt, strength, engine });
    if (r?.success) {
      completeJob(job.id, true);
      await reloadCurrentProject();
    } else {
      completeJob(job.id, false);
      alert('Modify failed: ' + (r?.error || 'unknown'));
    }
  } catch (e) {
    completeJob(job.id, false);
    alert('Modify error: ' + e.message);
  }
});

document.getElementById('ws-removebg-btn').addEventListener('click', async () => {
  const p = state.currentProject;
  if (!p || !p.selectedImagePath) { alert('Pick an image first.'); return; }
  const job = pushJob(`Remove background: ${p.name}`);
  try {
    const r = await API.removeBackground(p.selectedImagePath);
    if (r?.success) {
      completeJob(job.id, true);
      await reloadCurrentProject();
    } else {
      completeJob(job.id, false);
      alert('Remove BG failed: ' + (r?.error || 'unknown'));
    }
  } catch (e) {
    completeJob(job.id, false);
    alert('Remove BG error: ' + e.message);
  }
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
let wsRenderer, wsScene, wsCamera, wsControls, wsModel;
function initWsThree() {
  if (wsRenderer) return;
  const canvas = document.getElementById('ws-mesh-canvas');
  const w = canvas.clientWidth || 320, h = canvas.clientHeight || 260;
  wsRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  wsRenderer.setSize(w, h, false);
  wsRenderer.setPixelRatio(window.devicePixelRatio);
  wsScene = new THREE.Scene();
  wsScene.background = new THREE.Color(0x1d1d2c);
  wsCamera = new THREE.PerspectiveCamera(45, w / h, 0.01, 100);
  wsCamera.position.set(2, 2, 3);
  wsControls = new OrbitControls(wsCamera, canvas);
  wsControls.enableDamping = true;
  const light = new THREE.HemisphereLight(0xffffff, 0x444466, 1.0);
  wsScene.add(light);
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(5, 5, 5);
  wsScene.add(dir);
  function tick() {
    wsControls.update();
    wsRenderer.render(wsScene, wsCamera);
    requestAnimationFrame(tick);
  }
  tick();
}

async function showStep2Preview(mesh) {
  initWsThree();
  document.getElementById('step2-placeholder').style.display = 'none';
  // Remove the source-image overlay if it was shown
  const overlay = document.querySelector('.step2-source-overlay');
  if (overlay) overlay.remove();
  // Track which mesh is currently previewed
  const p = state.currentProject;
  if (p) p.previewMeshPath = mesh.path;
  // Show the "use for rig" bar
  const useRigBar = document.getElementById('ws-use-for-rig-bar');
  if (useRigBar) {
    useRigBar.classList.remove('hidden');
    const btn = document.getElementById('ws-use-for-rig-btn');
    if (btn) {
      const isSelected = p && p.selectedMeshPath === mesh.path;
      btn.disabled = isSelected;
      btn.textContent = isSelected ? '\u2713 Used for Rig generation' : 'Use this mesh for Rig \u2192';
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
  }, (err) => { console.error('GLTF parse error', err); });
}

function fitWsCamera(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3()).length();
  const center = box.getCenter(new THREE.Vector3());
  obj.position.sub(center);
  wsCamera.position.set(size * 1.2, size * 0.8, size * 1.2);
  wsCamera.lookAt(0, 0, 0);
  wsControls.target.set(0, 0, 0);
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
    t.innerHTML = `
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
  // Update the button label
  const btn = document.getElementById('ws-use-for-rig-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '\u2713 Used for Rig generation';
  }
  refreshButtonStates(p);
  // Move step 3 to active state if not done
  const step3Card = document.getElementById('step-card-rig');
  if (step3Card && !step3Card.classList.contains('done')) {
    step3Card.classList.remove('disabled');
    setStepStatus(3, 'active');
  }
  // Smooth-scroll to the rig card
  step3Card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  step3Card?.classList.add('pulse-highlight');
  setTimeout(() => step3Card?.classList.remove('pulse-highlight'), 1500);
});

// Effort slider label
const effortEl = document.getElementById('ws-3d-effort');
const effortLabel = document.getElementById('ws-3d-effort-val');
if (effortEl && effortLabel) {
  const effortNames = { 1: 'Fast', 2: 'Medium', 3: 'High', 4: 'Very high', 5: 'Max' };
  const updateEffortLabel = () => {
    effortLabel.textContent = effortNames[effortEl.value] || effortEl.value;
  };
  effortEl.addEventListener('input', updateEffortLabel);
  updateEffortLabel();
}

document.getElementById('ws-generate-mesh').addEventListener('click', async () => {
  const p = state.currentProject;
  if (!p || !p.selectedImagePath) { alert('Pick an image first.'); return; }
  const engine = document.getElementById('ws-3d-engine').value;
  const maxTris = parseInt(document.getElementById('ws-3d-maxtris').value) || 0;
  const effort = parseInt(document.getElementById('ws-3d-effort').value) || 2;
  const texSize = parseInt(document.getElementById('ws-3d-texsize').value) || 1024;
  const effortNames = { 1: 'Fast', 2: 'Medium', 3: 'High', 4: 'Very high', 5: 'Max' };
  const job = pushJob(`Generate 3D: ${p.name}`, null, {
    Engine: engine,
    'Max triangles': maxTris === 0 ? 'No limit' : `${maxTris.toLocaleString()}`,
    Effort: effortNames[effort] || effort,
    'Texture size': `${texSize} px`,
    'Source image': p.selectedImagePath ? p.selectedImagePath.split(/[/\\]/).pop() : '--',
  });
  try {
    const r = await API.imageTo3D({
      imagePath: p.selectedImagePath,
      outputName: p.name,
      engine,
      textureSize: texSize,
      targetFaces: maxTris || 50000,
      effort,
    });
    if (r?.success) {
      completeJob(job.id, true);
      await reloadCurrentProject();
    } else {
      completeJob(job.id, false);
      alert('3D generation failed: ' + (r?.error || 'unknown'));
    }
  } catch (e) {
    completeJob(job.id, false);
    alert('3D generation error: ' + e.message);
  }
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
    if (API.runBlenderScript) {
      await API.runBlenderScript({ meshPath: m.path });
    } else {
      // Fallback: open the file with the OS default app
      await API.showInExplorer(m.path);
    }
  } catch (e) { alert('Open in Blender failed: ' + e.message); }
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
  const job = pushJob(`Refine mesh: ${p.name}`, null, {
    Modification: modification,
    Format: format,
    'AI model': model,
    'Source mesh': m.filename,
  });
  try {
    const r = await API.refineMesh({ projectName: p.name, modification, format, model });
    if (r?.success || r?.meshPath) {
      completeJob(job.id, true);
      await reloadCurrentProject();
    } else {
      completeJob(job.id, false);
      alert('Refine failed: ' + (r?.error || 'unknown'));
    }
  } catch (e) {
    completeJob(job.id, false);
    alert('Refine error: ' + e.message);
  }
});

document.getElementById('ws-mesh-export-btn')?.addEventListener('click', () => {
  const m = getCurrentMeshObj();
  if (!m) { alert('Pick a mesh first.'); return; }
  const modal = document.getElementById('modal-export-mesh');
  document.getElementById('exp-filename').value = m.filename.replace(/\.[^.]+$/, '');
  modal.classList.remove('hidden');
});
document.getElementById('exp-cancel')?.addEventListener('click', () => {
  document.getElementById('modal-export-mesh').classList.add('hidden');
});
document.getElementById('exp-go')?.addEventListener('click', async () => {
  const m = getCurrentMeshObj();
  if (!m) return;
  const format = document.getElementById('exp-format').value;
  const customName = document.getElementById('exp-filename').value.trim();
  document.getElementById('modal-export-mesh').classList.add('hidden');
  const job = pushJob(`Export ${format}: ${customName || m.filename}`);
  try {
    const r = await API.exportMesh({ sourcePath: m.path, targetFormat: format, customName });
    if (r?.success || r?.outputPath) {
      completeJob(job.id, true);
      try { await API.showInExplorer(r.outputPath || r.path); } catch (e) {}
    } else {
      completeJob(job.id, false);
      alert('Export failed: ' + (r?.error || 'unknown'));
    }
  } catch (e) {
    completeJob(job.id, false);
    alert('Export error: ' + e.message);
  }
});

// ----- Rig step -----
async function loadRigTemplatesIntoSelect() {
  const sel = document.getElementById('ws-rig-template');
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
    if (skm.length > 0) {
      const group = document.createElement('optgroup');
      group.label = 'SKM templates';
      skm.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.name || t.filename || t;
        opt.textContent = t.label || t.name || t.filename || t;
        group.appendChild(opt);
      });
      sel.appendChild(group);
    }
    if (generic.length > 0) {
      const group = document.createElement('optgroup');
      group.label = 'Generic templates';
      generic.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.name || t.filename || t;
        opt.textContent = t.label || t.name || t.filename || t;
        group.appendChild(opt);
      });
      sel.appendChild(group);
    }
    if (skm.length === 0 && generic.length === 0) {
      flat.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.name || t.filename || t;
        opt.textContent = t.label || t.name || t.filename || t;
        sel.appendChild(opt);
      });
    }
    sel.dataset.loaded = '1';
  } catch (e) {
    console.error('loadRigTemplatesIntoSelect failed:', e);
    sel.innerHTML = '<option value="">Error loading templates</option>';
  }
}

function showStep3Preview(rig) {
  // Reuse the same wsRenderer; for simplicity, just show the rig's filename for now
  const preview = document.getElementById('step3-preview');
  preview.innerHTML = `<div class="preview-placeholder">${escapeHtml(rig.filename)}</div>`;
}

function renderRigVersions(p) {
  const strip = document.getElementById('ws-rig-versions');
  strip.innerHTML = '';
  p.rigs.forEach((r, i) => {
    const t = document.createElement('div');
    t.className = 'version-thumb';
    if (i === 0) t.classList.add('selected');
    t.innerHTML = `
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
    if (API.runBlenderScript) {
      await API.runBlenderScript({ meshPath: r.path });
    } else {
      await API.showInExplorer(r.path);
    }
  } catch (e) { alert('Open in Blender failed: ' + e.message); }
});

document.getElementById('ws-rig-unreal-btn')?.addEventListener('click', async () => {
  const r = getCurrentRigObj();
  if (!r) { alert('No rig yet.'); return; }
  const job = pushJob(`Export to Unreal: ${r.filename}`);
  try {
    if (!API.exportToUnreal) {
      completeJob(job.id, false);
      alert('Unreal export not available');
      return;
    }
    const result = await API.exportToUnreal({ rigPath: r.path });
    if (result?.success || result?.outputPath) {
      completeJob(job.id, true);
      try { await API.showInExplorer(result.outputPath || r.path); } catch (e) {}
    } else {
      completeJob(job.id, false);
      alert('Unreal export failed: ' + (result?.error || 'unknown'));
    }
  } catch (e) {
    completeJob(job.id, false);
    alert('Unreal export error: ' + e.message);
  }
});

document.getElementById('ws-rig-test-btn')?.addEventListener('click', () => {
  const r = getCurrentRigObj();
  if (!r) { alert('No rig yet.'); return; }
  document.getElementById('modal-test-anim').classList.remove('hidden');
});
document.getElementById('anim-cancel')?.addEventListener('click', () => {
  document.getElementById('modal-test-anim').classList.add('hidden');
});
document.getElementById('anim-go')?.addEventListener('click', async () => {
  const r = getCurrentRigObj();
  if (!r) return;
  const anim = document.getElementById('anim-select').value;
  document.getElementById('modal-test-anim').classList.add('hidden');
  const job = pushJob(`Test ${anim}: ${r.filename}`);
  try {
    if (API.runBlenderScript) {
      await API.runBlenderScript({ meshPath: r.path, animation: anim });
      completeJob(job.id, true);
    } else {
      completeJob(job.id, false);
      alert('Blender integration not available');
    }
  } catch (e) {
    completeJob(job.id, false);
    alert('Test animation error: ' + e.message);
  }
});

document.getElementById('ws-generate-rig').addEventListener('click', async () => {
  const p = state.currentProject;
  if (!p || p.meshes.length === 0) { alert('Generate a 3D mesh first.'); return; }
  const tpl = document.getElementById('ws-rig-template').value;
  if (!tpl) { alert('Pick a rig template.'); return; }
  const job = pushJob(`Auto-rig: ${p.name}`, null, {
    Template: tpl,
    'Source mesh': p.selectedMeshPath ? p.selectedMeshPath.split(/[/\\]/).pop() : '--',
  });
  try {
    const r = await API.autoRig({ meshPath: p.meshes[0].path, templateName: tpl });
    if (r?.success) {
      completeJob(job.id, true);
      await reloadCurrentProject();
    } else {
      completeJob(job.id, false);
      alert('Rig failed: ' + (r?.error || 'unknown'));
    }
  } catch (e) {
    completeJob(job.id, false);
    alert('Rig error: ' + e.message);
  }
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
    state.currentProject = refreshed;
    populateWorkspace(refreshed);
  }
}

// ============================================================
// JOBS BUBBLE
// ============================================================
// Expected duration per job kind, in ms — used to fake a smooth progress bar.
const JOB_EXPECTED_MS = {
  'image':   90000,   // ~1.5 min for a 4-image batch
  'img2img': 60000,
  'bg':      10000,
  'mesh':    180000,  // ~3 min for hunyuan / triposr
  'rig':     60000,
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

function pushJob(name, onCancel, params) {
  const id = ++state.jobIdCounter;
  const kind = inferKind(name);
  const expected = JOB_EXPECTED_MS[kind] || 60000;
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
  return job;
}

function completeJob(id, success) {
  const j = state.jobs.find(j => j.id === id);
  if (!j) return;
  if (j.tickTimer) { clearInterval(j.tickTimer); j.tickTimer = null; }
  j.progress = 100;
  j.status = success ? 'done' : 'error';
  renderJobs();
  setTimeout(() => {
    state.jobs = state.jobs.filter(x => x.id !== id);
    renderJobs();
  }, 4000);
}

async function cancelJob(id) {
  const j = state.jobs.find(j => j.id === id);
  if (!j) return;
  if (j.status !== 'running') return;
  const ok = await customConfirm(`Cancel "${j.name}"? The current operation will be stopped.`, 'Cancel job', 'Cancel job');
  if (!ok) return;
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
  const count = state.jobs.filter(j => j.status === 'running').length;
  document.getElementById('jobs-bubble-count-2').textContent = String(count);
  if (state.jobs.length === 0) {
    bubble.classList.add('hidden');
    panel.classList.add('hidden');
    return;
  }
  if (panel.classList.contains('hidden')) {
    bubble.classList.remove('hidden');
  }
  const list = document.getElementById('jobs-list-2');
  list.innerHTML = state.jobs.map(j => {
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
  // Bind click on each job item to open the details modal
  list.querySelectorAll('.job-item-2').forEach(el => {
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

// ----- Job details modal -----
function openJobDetails(id) {
  const j = state.jobs.find(x => x.id === id);
  if (!j) return;
  state._jobDetailsOpenId = id;
  document.getElementById('modal-job-details').classList.remove('hidden');
  refreshJobDetailsModal(id);
}
function closeJobDetails() {
  state._jobDetailsOpenId = null;
  document.getElementById('modal-job-details').classList.add('hidden');
}
function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}
function refreshJobDetailsModal(id) {
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
  // Reference image: prefer the project's currently selected image, fall back to its thumbnail
  const refImg = document.getElementById('jd-ref-img');
  const p = state.currentProject;
  let imgPath = null;
  if (p) {
    imgPath = p.selectedImagePath || p.previewImagePath || p.thumb;
  }
  if (imgPath && refImg) {
    refImg.src = 'file:///' + imgPath.replace(/\\/g, '/');
    refImg.style.display = '';
  } else if (refImg) {
    refImg.removeAttribute('src');
    refImg.style.display = 'none';
  }
  const pct = Math.round(j.progress);
  document.getElementById('jd-progress-fill').style.width = pct + '%';
  document.getElementById('jd-progress-pct').textContent = pct + '%';
  // Cancel button: only enabled while running
  const cancelBtn = document.getElementById('job-details-cancel');
  cancelBtn.disabled = j.status !== 'running';
  cancelBtn.style.display = j.status === 'running' ? '' : 'none';
}
document.getElementById('job-details-close').addEventListener('click', closeJobDetails);
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
// INIT
// ============================================================
showPage('projects');
