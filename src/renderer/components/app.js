// Main app logic for FabMesh

async function init() {
  // Initialize Three.js viewer
  await window.initViewer();

  // Load gallery
  await window.refreshGallery();

  // Load config
  const config = await window.meshyAPI.getConfig();
  updateBlenderPathDisplay(config.blenderPath);

  // --- Generate from prompt (main button) ---
  document.getElementById('btn-generate').addEventListener('click', async () => {
    const prompt = document.getElementById('prompt-input').value.trim();
    if (!prompt) {
      showLog('Please describe the 3D object you want to create.', 'error');
      return;
    }

    const meshName = document.getElementById('mesh-name').value.trim() || 'mesh';
    const format = document.getElementById('export-format').value;

    setGenerating(true);
    showStatus(true);
    setStep('ai', 'active');

    try {
      const result = await window.meshyAPI.generateFromPrompt({
        prompt,
        outputName: meshName,
        format
      });

      if (!result.success) {
        // Error returned from main process
        const failedStep = result.step || 'ai';
        setStep(failedStep, 'error');
        showLog(result.error, 'error');
        setGenerating(false);
        return;
      }

      setStep('ai', 'done');
      setStep('blender', 'done');
      setStep('load', 'active');

      // Load in viewer
      const buffer = await window.meshyAPI.readMeshFile(result.meshPath);
      if (buffer) {
        await window.loadMeshFromBuffer(buffer, format);
        document.getElementById('export-section').style.display = 'block';
        window.setSelectedMesh({ path: result.meshPath, filename: result.meshFilename, format: format.toUpperCase() });
      }

      setStep('load', 'done');
      await window.refreshGallery();
      showLog(`Success! Created: ${result.meshFilename} (${window.formatSize(result.size)})`, 'success');

    } catch (err) {
      setStep('ai', 'error');
      showLog(`Unexpected error: ${err.message || err}`, 'error');
    }

    setGenerating(false);
  });

  // --- Run script manually (advanced) ---
  document.getElementById('btn-run-script').addEventListener('click', async () => {
    const scriptContent = document.getElementById('script-input').value.trim();
    if (!scriptContent) {
      showLog('Please paste a Blender Python script.', 'error');
      return;
    }

    const meshName = document.getElementById('mesh-name').value.trim() || 'mesh';
    const format = document.getElementById('export-format').value;

    setGenerating(true);

    try {
      const result = await window.meshyAPI.runBlenderScript({
        scriptContent,
        outputName: meshName,
        format
      });

      showLog(`Success! Exported: ${result.meshFilename} (${window.formatSize(result.size)})`, 'success');
      await window.refreshGallery();

      const buffer = await window.meshyAPI.readMeshFile(result.meshPath);
      if (buffer) {
        await window.loadMeshFromBuffer(buffer, format);
        document.getElementById('export-section').style.display = 'block';
        window.setSelectedMesh({ path: result.meshPath, filename: result.meshFilename, format: format.toUpperCase() });
      }
    } catch (err) {
      const errMsg = typeof err === 'object' ? (err.error || err.message || JSON.stringify(err)) : err;
      showLog(`Error: ${errMsg}`, 'error');
    }

    setGenerating(false);
  });

  // --- Settings ---
  document.getElementById('btn-settings').addEventListener('click', () => {
    document.getElementById('settings-modal').classList.remove('hidden');
  });

  document.getElementById('btn-close-settings').addEventListener('click', () => {
    document.getElementById('settings-modal').classList.add('hidden');
  });

  document.getElementById('btn-browse-blender').addEventListener('click', async () => {
    const p = await window.meshyAPI.setBlenderPath();
    if (p) updateBlenderPathDisplay(p);
  });

  document.getElementById('btn-open-folder').addEventListener('click', () => {
    window.meshyAPI.openMeshesFolder();
  });

  document.getElementById('btn-refresh').addEventListener('click', window.refreshGallery);

  // --- Viewer toolbar ---
  document.getElementById('btn-reset-camera').addEventListener('click', window.resetCamera);

  document.getElementById('btn-wireframe').addEventListener('click', () => {
    const active = window.toggleWireframe();
    document.getElementById('btn-wireframe').classList.toggle('active', active);
  });

  document.getElementById('btn-grid').addEventListener('click', () => {
    const active = window.toggleGrid();
    document.getElementById('btn-grid').classList.toggle('active', active);
  });

  // --- Convert ---
  document.getElementById('btn-convert').addEventListener('click', async () => {
    const selected = window.getSelectedMesh();
    if (!selected) return;
    const targetFormat = document.getElementById('convert-format').value;
    try {
      setGenerating(true);
      const result = await window.meshyAPI.exportMesh({
        sourcePath: selected.path,
        targetFormat
      });
      showLog(`Converted to: ${result.filename}`, 'success');
      await window.refreshGallery();
    } catch (err) {
      showLog(`Convert error: ${err.error || err.message}`, 'error');
    }
    setGenerating(false);
  });

  document.getElementById('btn-clear-log').addEventListener('click', () => {
    document.getElementById('output-log').classList.add('hidden');
  });

  document.getElementById('settings-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('settings-modal')) {
      document.getElementById('settings-modal').classList.add('hidden');
    }
  });

  // Allow Enter to generate (Ctrl+Enter)
  document.getElementById('prompt-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      document.getElementById('btn-generate').click();
    }
  });
}

function setGenerating(loading) {
  const btn = document.getElementById('btn-generate');
  const loader = document.getElementById('viewer-loading');
  btn.disabled = loading;
  btn.textContent = loading ? 'Generating...' : '▶ Generate 3D Mesh';
  loader.classList.toggle('hidden', !loading);
}

function showStatus(visible) {
  const el = document.getElementById('generation-status');
  el.classList.toggle('hidden', !visible);
  if (visible) {
    // Reset all steps
    ['ai', 'blender', 'load'].forEach(id => setStep(id, 'pending'));
  }
}

function setStep(stepId, state) {
  const el = document.getElementById(`step-${stepId}`);
  if (!el) return;
  el.className = 'status-step ' + (state === 'pending' ? '' : state);
  const icon = el.querySelector('.step-icon');
  if (state === 'active') icon.textContent = '🔄';
  else if (state === 'done') icon.textContent = '✅';
  else if (state === 'error') icon.textContent = '❌';
  else icon.textContent = '⬜';
}

function showLog(text, type) {
  const logEl = document.getElementById('output-log');
  const content = document.getElementById('log-content');
  logEl.classList.remove('hidden');
  content.textContent = text;
  content.style.color = type === 'error' ? '#f87171' : type === 'success' ? '#4ade80' : '#8892b0';
}

function updateBlenderPathDisplay(path) {
  const el = document.getElementById('blender-path-display');
  el.textContent = path || 'Not set';
  el.style.color = path ? '#4ade80' : '#f87171';
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
