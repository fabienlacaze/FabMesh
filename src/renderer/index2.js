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
  modal.classList.remove('hidden');
  return new Promise(resolve => {
    function cleanup() {
      modal.classList.add('hidden');
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
    // Remove trailing engine suffix added by main.js: _hunyuan / _local / _trellis / _ai
    base = base.replace(/_(hunyuan|local|trellis|ai)$/i, '');
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
  // Populate the source-image preview shown next to the "Create new" form
  // in the 3D Mesh card. This is independent of the Edit-selected mesh viewer.
  const target = document.getElementById('ws-3d-source-preview');
  if (!target) return;
  if (imgPath) {
    target.innerHTML = `<img src="file:///${imgPath.replace(/\\/g, '/')}">`;
  } else {
    target.innerHTML = '<div class="preview-placeholder">No image selected</div>';
  }
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
  imgEl.src = 'file:///' + imgPath.replace(/\\/g, '/');
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
    shadows: true,
    bg: 'dark',
    light: 1.0,
  };

  const BG_COLORS = {
    dark: 0x1d1d2c,
    studio: 0xf0f0f0,
    black: 0x000000,
    gray: 0x444444,
  };

  function ensureGrid(viewer) {
    if (!viewer.scene) return;
    if (!viewer.gridHelper && state.grid) {
      const grid = new THREE.GridHelper(10, 20, 0x444466, 0x222233);
      grid.material.opacity = 0.5;
      grid.material.transparent = true;
      viewer.scene.add(grid);
      viewer.gridHelper = grid;
    } else if (viewer.gridHelper && !state.grid) {
      viewer.scene.remove(viewer.gridHelper);
      viewer.gridHelper = null;
    }
  }

  function ensureSkeletonHelper(viewer) {
    if (!viewer.scene || !viewer.model) return;
    if (state.bones && !viewer.skelHelper) {
      const helper = new THREE.SkeletonHelper(viewer.model);
      try { helper.material.linewidth = 2; helper.material.color = new THREE.Color(0xff4488); } catch (e) {}
      helper.name = 'SkeletonHelper';
      viewer.scene.add(helper);
      viewer.skelHelper = helper;
      // Make the mesh semi-transparent so the bones are visible
      viewer.model.traverse(c => {
        if (c.isMesh && c.material) {
          const mats = Array.isArray(c.material) ? c.material : [c.material];
          mats.forEach(m => { m.transparent = true; m.opacity = 0.4; });
        }
      });
    } else if (!state.bones && viewer.skelHelper) {
      viewer.scene.remove(viewer.skelHelper);
      viewer.skelHelper = null;
      if (viewer.model) viewer.model.traverse(c => {
        if (c.isMesh && c.material) {
          const mats = Array.isArray(c.material) ? c.material : [c.material];
          mats.forEach(m => { m.transparent = false; m.opacity = 1.0; });
        }
      });
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

  function applyShadows(viewer) {
    if (!viewer.renderer) viewer.renderer = (viewer === lb3dViewerRef() ? lb3dRenderer : wsRenderer);
    if (viewer.renderer) viewer.renderer.shadowMap.enabled = state.shadows;
    viewer.scene?.traverse(o => {
      if (o.isMesh) {
        o.castShadow = state.shadows;
        o.receiveShadow = state.shadows;
      }
      if (o.isLight && o.castShadow !== undefined) {
        o.castShadow = state.shadows;
      }
    });
    // For shading-on-mesh fakery: if shadows off, increase emissive on materials
    viewer.scene?.traverse(c => {
      if (c.isMesh && c.material) {
        const mats = Array.isArray(c.material) ? c.material : [c.material];
        mats.forEach(m => {
          if ('emissive' in m && m.emissive) {
            if (!state.shadows) {
              if (!m.userData._origEmissive) m.userData._origEmissive = m.emissive.clone();
              m.emissive.setRGB(0.4, 0.4, 0.4);
              m.emissiveIntensity = 1;
            } else if (m.userData._origEmissive) {
              m.emissive.copy(m.userData._origEmissive);
              delete m.userData._origEmissive;
            }
          }
        });
      }
    });
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
      });
    } else if (el.tagName === 'SELECT') {
      el.addEventListener('change', () => {
        const viewer = getViewer();
        if (!viewer) return;
        captureBaseLightIntensities(viewer);
        if (act === 'view') { setView(viewer, el.value); el.value = ''; return; }
        if (act === 'bg') { state.bg = el.value; applyBackground(viewer); return; }
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

// ----- 3D Lightbox -----
let lb3dRenderer, lb3dScene, lb3dCamera, lb3dControls, lb3dModel, lb3dRafId;
function init3DLightbox() {
  if (lb3dRenderer) return;
  const canvas = document.getElementById('lightbox-3d-canvas');
  lb3dRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  lb3dRenderer.setPixelRatio(window.devicePixelRatio);
  lb3dRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  lb3dRenderer.toneMappingExposure = 1.4;
  lb3dScene = new THREE.Scene();
  lb3dScene.background = new THREE.Color(0x0b0b14);
  lb3dCamera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 200);
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
async function openMeshLightbox(meshPath) {
  init3DLightbox();
  ensureLb3dControlsBinding();
  document.getElementById('lightbox-3d').classList.remove('hidden');
  resize3DLightbox();
  // Clear previous model
  if (lb3dModel) { lb3dScene.remove(lb3dModel); lb3dModel = null; }
  const buffer = await API.readMeshFile(meshPath);
  if (!buffer) { alert('Could not load mesh file'); return; }
  const loader = new GLTFLoader();
  loader.parse(buffer, '', (gltf) => {
    lb3dModel = gltf.scene;
    lb3dScene.add(lb3dModel);
    // Fit camera so the model's bottom sits on y=0
    const box = new THREE.Box3().setFromObject(lb3dModel);
    const size = box.getSize(new THREE.Vector3()).length();
    const center = box.getCenter(new THREE.Vector3());
    const sizeVec = box.getSize(new THREE.Vector3());
    lb3dModel.position.x -= center.x;
    lb3dModel.position.z -= center.z;
    lb3dModel.position.y -= box.min.y;
    const lookY = sizeVec.y * 0.5;
    lb3dCamera.position.set(size * 1.3, size * 0.9 + lookY, size * 1.3);
    lb3dCamera.lookAt(0, lookY, 0);
    lb3dControls.target.set(0, lookY, 0);
    lb3dControls.update();
    // Apply default toolbar state to the lightbox viewer
    if (lb3dControlsApi) setTimeout(() => lb3dControlsApi.refreshAll(), 50);
  }, (err) => console.error('GLTF parse error in lightbox', err));
  startLb3dLoop();
}
function closeMeshLightbox() {
  document.getElementById('lightbox-3d').classList.add('hidden');
  stopLb3dLoop();
}
document.getElementById('lightbox-3d-close')?.addEventListener('click', closeMeshLightbox);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.getElementById('lightbox-3d').classList.contains('hidden')) {
    closeMeshLightbox();
  }
});
window.addEventListener('resize', () => {
  if (!document.getElementById('lightbox-3d').classList.contains('hidden')) resize3DLightbox();
});

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
  const multiView = document.getElementById('ws-multiview')?.checked || false;
  const buildStages = document.getElementById('ws-img-buildstages')?.checked || false;
  const job = pushJob(`Generate images: ${p.name}`, null, {
    Engine: engine,
    Count: count,
    Steps: steps,
    'Multi-view': multiView ? 'yes' : 'no',
    'Construction stages': buildStages ? 'yes' : 'no',
    Prompt: prompt,
  });
  try {
    const r = await API.generateImages({ prompt, engine, numImages: count, projectName: p.name, steps, multiView, buildStages });
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
      customError(r?.error || 'unknown', 'Modify failed');
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
  // Show the expand button (hidden until a mesh is actually loaded)
  const expandBtn = document.getElementById('ws-mesh-expand-btn');
  if (expandBtn) {
    expandBtn.classList.remove('hidden');
    expandBtn.onclick = (e) => { e.stopPropagation(); openMeshLightbox(mesh.path); };
  }
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
    // Show the toolbar and refresh its state for this new model
    const tb = document.getElementById('ws-mesh-toolbar');
    if (tb) tb.classList.remove('hidden');
    if (typeof wsMeshControls !== 'undefined' && wsMeshControls) {
      setTimeout(() => wsMeshControls.refreshAll(), 50);
    }
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
  const buildStages = document.getElementById('ws-3d-buildstages')?.checked || false;
  const effortNames = { 1: 'Fast', 2: 'Medium', 3: 'High', 4: 'Very high', 5: 'Max' };
  const job = pushJob(`Generate 3D: ${p.name}`, null, {
    Engine: engine,
    'Max triangles': maxTris === 0 ? 'No limit' : `${maxTris.toLocaleString()}`,
    Effort: effortNames[effort] || effort,
    'Texture size': `${texSize} px`,
    'Construction stages': buildStages ? 'yes' : 'no',
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
      buildStages,
    });
    if (r?.success) {
      completeJob(job.id, true);
      await reloadCurrentProject();
    } else {
      completeJob(job.id, false);
      customError(r?.error || 'unknown', '3D generation failed');
    }
  } catch (e) {
    completeJob(job.id, false);
    customError(e.message, '3D generation error');
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
  const skinMethod = document.getElementById('ws-rig-skin-method')?.value || 'auto';
  const skinSmoothing = parseInt(document.getElementById('ws-rig-skin-smooth')?.value) || 3;
  const mirrorX = document.getElementById('ws-rig-mirror-x')?.checked;
  // Collect placed landmarks from the in-memory map
  const lmData = {};
  for (const id in lmMarkers) {
    const m = lmMarkers[id];
    lmData[id] = [m.position.x, m.position.y, m.position.z];
  }
  const meshPathToUse = p.selectedMeshPath || p.meshes[0].path;
  const job = pushJob(`Auto-rig: ${p.name}`, null, {
    Template: tpl,
    Skinning: skinMethod,
    Smoothing: skinSmoothing,
    'Mirror X': mirrorX ? 'yes' : 'no',
    Landmarks: Object.keys(lmData).length > 0 ? `${Object.keys(lmData).length} placed` : 'auto',
    'Source mesh': meshPathToUse.split(/[/\\]/).pop(),
  });
  try {
    const r = await API.autoRig({
      meshPath: meshPathToUse,
      templateName: tpl,
      skinMethod, skinSmoothing, mirrorX,
      landmarks: Object.keys(lmData).length > 0 ? lmData : null,
    });
    if (r?.success) {
      completeJob(job.id, true);
      await reloadCurrentProject();
    } else {
      completeJob(job.id, false);
      customError(r?.error || 'unknown', 'Rig failed');
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
  // Auto-open the details modal so the user sees the live progress + cancel button
  // without having to click the bubble in the corner.
  try { openJobDetails(id); } catch (e) {}
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
// AUTO INPAINT (CLIPSeg target + replace)
// ============================================================
document.getElementById('ws-autoinpaint-btn')?.addEventListener('click', () => {
  const p = state.currentProject;
  if (!p || !p.previewImagePath) { alert('Pick an image first.'); return; }
  document.getElementById('ai-target').value = '';
  document.getElementById('ai-replace').value = '';
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
  const job = pushJob(`Auto inpaint: ${p.name}`, null, {
    Target: target,
    Replace: replace || '(remove)',
    Padding: dilate + 'px',
  });
  try {
    const r = await API.autoInpaint({ imagePath: p.previewImagePath, targetText: target, prompt: replace, dilate });
    if (r?.success) {
      completeJob(job.id, true);
      await reloadCurrentProject();
    } else {
      completeJob(job.id, false);
      alert('Auto inpaint failed: ' + (r?.error || 'unknown'));
    }
  } catch (e) {
    completeJob(job.id, false);
    alert('Auto inpaint error: ' + e.message);
  }
});

// ============================================================
// SETTINGS MODAL
// ============================================================
document.getElementById('btn-settings')?.addEventListener('click', async () => {
  document.getElementById('modal-settings').classList.remove('hidden');
  // Populate Blender path
  try {
    const cfg = await API.getConfig();
    document.getElementById('set-blender-path').value = cfg?.blenderPath || '';
  } catch (e) {}
  // Populate GPU info
  try {
    const gpu = await API.checkGPU();
    const text = gpu ? (gpu.name || gpu.gpu || JSON.stringify(gpu)) : 'Unknown';
    document.getElementById('set-gpu-info').textContent = text;
  } catch (e) {
    document.getElementById('set-gpu-info').textContent = 'GPU info unavailable';
  }
});
document.getElementById('set-close')?.addEventListener('click', () => {
  document.getElementById('modal-settings').classList.add('hidden');
});
document.getElementById('set-blender-browse')?.addEventListener('click', async () => {
  try {
    const r = await API.setBlenderPath();
    if (r) {
      document.getElementById('set-blender-path').value = r.blenderPath || r;
    }
  } catch (e) { alert('Browse failed: ' + e.message); }
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
      alert('Auto-rig API not available');
      return;
    }
    // Call auto-rig with the same template but reskin-only flag
    const result = await API.autoRig({ meshPath: r.path, templateName: '', skinMethod, skinSmoothing, mirrorX, reskinOnly: true });
    if (result?.success) {
      completeJob(job.id, true);
      await reloadCurrentProject();
    } else {
      completeJob(job.id, false);
      alert('Re-skin failed: ' + (result?.error || 'unknown'));
    }
  } catch (e) {
    completeJob(job.id, false);
    alert('Re-skin error: ' + e.message);
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
      list.appendChild(btn);
    });
  });
}
buildLandmarkList();

function armLandmark(id, btn) {
  document.querySelectorAll('.lm-btn').forEach(b => b.classList.remove('armed'));
  if (lmActive === id) {
    lmActive = null;
    return;
  }
  lmActive = id;
  btn.classList.add('armed');
}

function placeLandmarkMarker(id, point, color) {
  if (!wsScene) return;
  if (lmMarkers[id]) {
    wsScene.remove(lmMarkers[id]);
    lmMarkers[id].geometry?.dispose();
    lmMarkers[id].material?.dispose();
  }
  // Auto-scale radius based on bbox
  let r = 0.03;
  if (wsModel) {
    const box = new THREE.Box3().setFromObject(wsModel);
    const sz = box.getSize(new THREE.Vector3());
    r = Math.max(sz.x, sz.y, sz.z) * 0.015;
  }
  const geo = new THREE.SphereGeometry(r, 16, 16);
  const mat = new THREE.MeshBasicMaterial({ color: color, depthTest: false, transparent: true, opacity: 0.85 });
  const sphere = new THREE.Mesh(geo, mat);
  sphere.position.copy(point);
  sphere.renderOrder = 999;
  wsScene.add(sphere);
  lmMarkers[id] = sphere;
  // Mark the button as placed
  const btn = document.querySelector(`.lm-btn[data-lm="${id}"]`);
  if (btn) btn.classList.add('placed');
}

function clearAllLandmarks() {
  for (const id in lmMarkers) {
    wsScene.remove(lmMarkers[id]);
    try { lmMarkers[id].geometry.dispose(); lmMarkers[id].material.dispose(); } catch (e) {}
  }
  lmMarkers = {};
  document.querySelectorAll('.lm-btn').forEach(b => b.classList.remove('placed', 'armed'));
  lmActive = null;
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
  // Clear current
  for (const id in lmMarkers) {
    wsScene.remove(lmMarkers[id]);
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

function autoDetectLandmarks() {
  if (!wsModel) { alert('Load a mesh first.'); return; }
  const box = new THREE.Box3().setFromObject(wsModel);
  const min = box.min, max = box.max;
  const size = new THREE.Vector3().subVectors(max, min);
  const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
  let upAxis = 'y';
  if (size.z > size.y && size.z > size.x) upAxis = 'z';
  else if (size.x > size.y && size.x > size.z) upAxis = 'x';
  const minU = min[upAxis], sU = max[upAxis] - min[upAxis];
  const lateralAxis = upAxis === 'y' ? 'x' : 'x';
  const depthAxis = upAxis === 'y' ? 'z' : 'z';
  function pt(side, height_pct, depth = 0) {
    const v = new THREE.Vector3();
    v[upAxis] = minU + height_pct * sU;
    v[lateralAxis] = center[lateralAxis] + side * size[lateralAxis];
    v[depthAxis] = center[depthAxis] + depth * size[depthAxis];
    return v;
  }
  const all = {
    head: pt(0, 0.97), neck: pt(0, 0.85), spine_top: pt(0, 0.72), spine_mid: pt(0, 0.62), hips: pt(0, 0.52),
    shoulder_l: pt(0.32, 0.78), elbow_l: pt(0.34, 0.65, 0.05), hand_l: pt(0.36, 0.50),
    shoulder_r: pt(-0.32, 0.78), elbow_r: pt(-0.34, 0.65, 0.05), hand_r: pt(-0.36, 0.50),
    hip_l: pt(0.10, 0.50), knee_l: pt(0.10, 0.27), ankle_l: pt(0.10, 0.04), foot_l: pt(0.10, 0.00, 0.05),
    hip_r: pt(-0.10, 0.50), knee_r: pt(-0.10, 0.27), ankle_r: pt(-0.10, 0.04), foot_r: pt(-0.10, 0.00, 0.05),
  };
  const colorMap = {};
  LM_SCHEMA.forEach(g => g.items.forEach(it => { colorMap[it.id] = it.color; }));
  for (const id in all) {
    const color = parseInt((colorMap[id] || '#ffffff').replace('#', ''), 16);
    placeLandmarkMarker(id, all[id], color);
  }
  saveLandmarksForCurrentMesh();
}

function setupLandmarkRaycasting() {
  const canvas = document.getElementById('ws-mesh-canvas');
  if (!canvas) return;
  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !lmActive || !wsModel) return;
    const rect = canvas.getBoundingClientRect();
    LM_NDC.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    LM_RAYCASTER.setFromCamera(LM_NDC, wsCamera);
    const meshes = [];
    wsModel.traverse(c => { if (c.isMesh) meshes.push(c); });
    const hits = LM_RAYCASTER.intersectObjects(meshes, true);
    if (hits.length > 0) {
      const btn = document.querySelector(`.lm-btn[data-lm="${lmActive}"]`);
      const colorHex = btn?.dataset.color || '#ffffff';
      const color = parseInt(colorHex.replace('#', ''), 16);
      placeLandmarkMarker(lmActive, hits[0].point.clone(), color);
      saveLandmarksForCurrentMesh();
      // Disarm after placement
      btn?.classList.remove('armed');
      lmActive = null;
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
}
setupLandmarkRaycasting();

document.getElementById('ws-lm-auto')?.addEventListener('click', autoDetectLandmarks);
document.getElementById('ws-lm-clear')?.addEventListener('click', async () => {
  if (!await customConfirm('Clear all landmarks for this mesh?', 'Clear landmarks', 'Clear')) return;
  clearAllLandmarks();
});
document.getElementById('ws-lm-guided')?.addEventListener('click', async () => {
  if (!wsModel) { alert('Load a mesh first.'); return; }
  // Walk through each landmark in order, auto-arming the next button
  const all = LM_SCHEMA.flatMap(g => g.items);
  for (const item of all) {
    if (lmMarkers[item.id]) continue; // skip already-placed
    const btn = document.querySelector(`.lm-btn[data-lm="${item.id}"]`);
    if (!btn) continue;
    armLandmark(item.id, btn);
    btn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    // Wait until the user places this landmark, or 60s
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
});

// Reload landmarks whenever the previewed mesh changes — observe the canvas
// for size changes (when the model is loaded, three.js fits the camera).
// Simpler: set up a periodic check that loads landmarks when wsModel changes.
let _lastWsModelRef = null;
setInterval(() => {
  if (wsModel !== _lastWsModelRef) {
    _lastWsModelRef = wsModel;
    if (wsModel) loadLandmarksForCurrentMesh();
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
