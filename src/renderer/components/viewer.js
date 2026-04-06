// Three.js 3D Viewer for FabMesh
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let scene, camera, renderer, controls, gridHelper, currentModel;
let isWireframe = false;
let isGridVisible = true;

window.initViewer = async function() {
  const canvas = document.getElementById('three-canvas');
  const container = document.getElementById('viewer-container');

  // Renderer
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setClearColor(0x0f0f1a);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;

  // Scene
  scene = new THREE.Scene();

  // Camera
  camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
  camera.position.set(3, 2.5, 3);

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0.5, 0);
  controls.update();

  // Lights
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(5, 8, 5);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(1024, 1024);
  scene.add(dirLight);

  const fillLight = new THREE.DirectionalLight(0x8888ff, 0.3);
  fillLight.position.set(-3, 2, -3);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0xff8888, 0.2);
  rimLight.position.set(0, -2, -5);
  scene.add(rimLight);

  // Grid
  gridHelper = new THREE.GridHelper(10, 20, 0x2a2a4a, 0x1a1a2e);
  scene.add(gridHelper);

  // Ground plane (subtle shadow catcher)
  const groundGeo = new THREE.PlaneGeometry(20, 20);
  const groundMat = new THREE.ShadowMaterial({ opacity: 0.3 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Handle resize
  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  window.addEventListener('resize', resize);
  new ResizeObserver(resize).observe(container);
  resize();

  // Animation loop
  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();
};

window.clearModel = function() {
  if (currentModel) {
    scene.remove(currentModel);
    currentModel.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    });
    currentModel = null;
  }
};

function fitCameraToModel(model) {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = camera.fov * (Math.PI / 180);
  let cameraZ = maxDim / (2 * Math.tan(fov / 2));
  cameraZ *= 1.8;

  camera.position.set(center.x + cameraZ * 0.7, center.y + cameraZ * 0.5, center.z + cameraZ * 0.7);
  controls.target.copy(center);
  controls.update();

  // Update mesh info
  let vertexCount = 0;
  let faceCount = 0;
  model.traverse((child) => {
    if (child.isMesh && child.geometry) {
      vertexCount += child.geometry.attributes.position ? child.geometry.attributes.position.count : 0;
      faceCount += child.geometry.index ? child.geometry.index.count / 3 : vertexCount / 3;
    }
  });

  const infoEl = document.getElementById('mesh-info');
  if (infoEl) {
    infoEl.textContent = `${vertexCount.toLocaleString()} verts | ${Math.round(faceCount).toLocaleString()} faces | ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}`;
  }
}

window.loadMeshFromBuffer = async function(buffer, format) {
  window.clearModel();

  const emptyMsg = document.getElementById('viewer-empty');
  if (emptyMsg) emptyMsg.classList.add('hidden');

  format = format.toLowerCase();

  if (format === 'glb' || format === 'gltf') {
    const loader = new GLTFLoader();
    return new Promise((resolve, reject) => {
      loader.parse(buffer, '', (gltf) => {
        currentModel = gltf.scene;
        currentModel.traverse((child) => {
          if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
            if (isWireframe) child.material.wireframe = true;
          }
        });
        scene.add(currentModel);
        fitCameraToModel(currentModel);
        resolve();
      }, reject);
    });
  } else if (format === 'obj') {
    const loader = new OBJLoader();
    const text = new TextDecoder().decode(buffer);
    const obj = loader.parse(text);
    currentModel = obj;
    const defaultMat = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, roughness: 0.6, metalness: 0.2 });
    currentModel.traverse((child) => {
      if (child.isMesh) {
        if (!child.material || child.material.color?.getHex() === 0xffffff) {
          child.material = defaultMat;
        }
        child.castShadow = true;
        child.receiveShadow = true;
        if (isWireframe) child.material.wireframe = true;
      }
    });
    scene.add(currentModel);
    fitCameraToModel(currentModel);
  } else if (format === 'stl') {
    const loader = new STLLoader();
    const geometry = loader.parse(buffer);
    const material = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, roughness: 0.6, metalness: 0.2 });
    if (isWireframe) material.wireframe = true;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    currentModel = new THREE.Group();
    currentModel.add(mesh);
    scene.add(currentModel);
    fitCameraToModel(currentModel);
  }
};

window.toggleWireframe = function() {
  isWireframe = !isWireframe;
  if (currentModel) {
    currentModel.traverse((child) => {
      if (child.isMesh && child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m.wireframe = isWireframe);
        } else {
          child.material.wireframe = isWireframe;
        }
      }
    });
  }
  return isWireframe;
};

window.toggleGrid = function() {
  isGridVisible = !isGridVisible;
  if (gridHelper) gridHelper.visible = isGridVisible;
  return isGridVisible;
};

window.resetCamera = function() {
  if (currentModel) {
    fitCameraToModel(currentModel);
  } else {
    camera.position.set(3, 2.5, 3);
    controls.target.set(0, 0.5, 0);
    controls.update();
  }
};
