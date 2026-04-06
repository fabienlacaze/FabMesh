// Gallery management for FabMesh

let meshList = [];
let selectedMesh = null;

window.getSelectedMesh = () => selectedMesh;
window.setSelectedMesh = (m) => { selectedMesh = m; };

window.refreshGallery = async function() {
  meshList = await window.meshyAPI.listMeshes();
  renderGallery();
};

function renderGallery() {
  const container = document.getElementById('mesh-list');
  if (meshList.length === 0) {
    container.innerHTML = '<div class="gallery-empty">No meshes yet.<br>Generate your first one!</div>';
    return;
  }

  container.innerHTML = meshList.map((mesh, i) => {
    const date = new Date(mesh.created);
    const dateStr = date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const sizeStr = window.formatSize(mesh.size);
    const isActive = selectedMesh && selectedMesh.filename === mesh.filename;

    return `
      <div class="mesh-item ${isActive ? 'active' : ''}" data-index="${i}" onclick="window.selectMesh(${i})">
        <div class="mesh-item-name">${mesh.filename.replace(/\.[^.]+$/, '').replace(/_\d+$/, '')}</div>
        <div class="mesh-item-info">
          <span>${dateStr}</span>
          <span class="mesh-item-format">${mesh.format}</span>
        </div>
        <div class="mesh-item-info">
          <span>${sizeStr}</span>
        </div>
        <div class="mesh-item-actions">
          <button class="small-btn" onclick="event.stopPropagation(); window.deleteMeshItem(${i})">Delete</button>
        </div>
      </div>
    `;
  }).join('');
}

window.selectMesh = async function(index) {
  selectedMesh = meshList[index];
  renderGallery();

  document.getElementById('export-section').style.display = 'block';

  try {
    const buffer = await window.meshyAPI.readMeshFile(selectedMesh.path);
    if (buffer) {
      await window.loadMeshFromBuffer(buffer, selectedMesh.format);
    }
  } catch (err) {
    console.error('Failed to load mesh:', err);
  }
};

window.deleteMeshItem = async function(index) {
  const mesh = meshList[index];
  if (confirm(`Delete ${mesh.filename}?`)) {
    await window.meshyAPI.deleteMesh(mesh.filename);
    if (selectedMesh && selectedMesh.filename === mesh.filename) {
      selectedMesh = null;
      document.getElementById('export-section').style.display = 'none';
      window.clearModel();
      document.getElementById('viewer-empty').classList.remove('hidden');
      document.getElementById('mesh-info').textContent = '';
    }
    await window.refreshGallery();
  }
};

window.formatSize = function(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
};
