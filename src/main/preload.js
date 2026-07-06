const { contextBridge, ipcRenderer } = require('electron');

// ----------------------------------------------------------
// _stripFns — defense-in-depth for IPC payloads
// ----------------------------------------------------------
// Electron's ipcRenderer.invoke uses the structured-clone algorithm
// which throws DataCloneError on Function values. A caller that
// accidentally embeds a callback (onProgress, onCancel, etc.) inside
// opts crashes the IPC with "An object could not be cloned". This
// helper walks the object 2 levels deep and drops any function-valued
// property before invoke. Used by IPC bridges that take arbitrary
// caller-shaped opts (autoRigAI, etc.).
function _stripFns(val) {
  if (val == null || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(_stripFns);
  const out = {};
  for (const k of Object.keys(val)) {
    const v = val[k];
    if (typeof v === 'function') continue; // drop
    out[k] = (v && typeof v === 'object') ? _stripFns(v) : v;
  }
  return out;
}

// ----------------------------------------------------------
// Sentry — renderer-side error capture
// ----------------------------------------------------------
// The main process initializes Sentry. The renderer SDK auto-attaches
// to that and forwards uncaught errors / unhandled promise rejections
// from index2 and wizard. No DSN is read here; the renderer SDK
// inherits configuration from the main process via IPC.
try {
  require('@sentry/electron/renderer').init({});
} catch (_) {
  // Module not installed (dev box) — quietly skip.
}

// ----------------------------------------------------------
// Wizard API (first-run setup only)
// ----------------------------------------------------------
contextBridge.exposeInMainWorld('wizardAPI', {
  // Forward all wizard console logs to %APPDATA%\fabmesh\wizard.log
  // for post-mortem debugging of first-run issues.
  log: (payload) => ipcRenderer.send('wizard-log', payload),
  detectHardware: () => ipcRenderer.invoke('wizard:detect-hardware'),
  getDownloadPlan: (mode) => ipcRenderer.invoke('wizard:download-plan', mode),
  freeSpace: () => ipcRenderer.invoke('wizard:free-space'),
  startDownload: (mode) => ipcRenderer.invoke('wizard:start-download', mode),
  onDownloadProgress: (cb) => ipcRenderer.on('wizard:download-progress', (_e, p) => cb(p)),
  runFinalTest: (mode) => ipcRenderer.invoke('wizard:final-test', mode),
  onTestLog: (cb) => ipcRenderer.on('wizard:test-log', (_e, line) => cb(line)),
  completeSetup: (state) => ipcRenderer.invoke('wizard:complete', state),
  openExternal: (url) => ipcRenderer.invoke('wizard:open-external', url),
  getVersion: () => ipcRenderer.invoke('wizard:get-version'),
  resetSetup: () => ipcRenderer.invoke('wizard:reset-setup'),
  getMode: () => ipcRenderer.invoke('wizard:get-mode'),
  cancel: () => ipcRenderer.invoke('wizard:cancel'),
  installDeps: () => ipcRenderer.invoke('wizard:install-deps'),
  onInstallProgress: (cb) => ipcRenderer.on('wizard:install-progress', (_e, p) => cb(p)),
  exportDiagnostics: () => ipcRenderer.invoke('export-diagnostics'),
  getDataLocation: () => ipcRenderer.invoke('get-data-location'),
  pickDataFolder: () => ipcRenderer.invoke('pick-data-folder'),
  restartApp: () => ipcRenderer.invoke('restart-app'),
});

// ----------------------------------------------------------
// Test/Control API bridge
// ----------------------------------------------------------
// Minimal ipc bridge used by src/renderer/test_api_client.js so
// the external HTTP control server (src/main/test_api.js) can
// dispatch commands into the renderer. Only whitelisted channels
// are allowed; this is safe to ship even in prod because nothing
// happens unless the renderer client decides to hook in.
const _TEST_ALLOWED_SEND = new Set(['test:result', 'test:console', 'test:state-push']);
const _TEST_ALLOWED_ON   = new Set(['test:command']);
contextBridge.exposeInMainWorld('__fabmeshTest', {
  send: (channel, payload) => {
    if (_TEST_ALLOWED_SEND.has(channel)) ipcRenderer.send(channel, payload);
  },
  on: (channel, cb) => {
    if (_TEST_ALLOWED_ON.has(channel)) {
      ipcRenderer.on(channel, (_e, msg) => { try { cb(msg); } catch (_) {} });
    }
  }
});

contextBridge.exposeInMainWorld('meshyAPI', {
  reconfigureFabmesh: () => ipcRenderer.invoke('wizard:reset-setup'),
  uninstallFabmesh: () => ipcRenderer.invoke('app:uninstall'),
  openWebsite: () => ipcRenderer.invoke('app:open-website'),
  checkForUpdate: () => ipcRenderer.invoke('app:check-for-update'),
  installUpdateNow: () => ipcRenderer.invoke('app:install-update-now'),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_e, info) => cb(info)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', (_e, info) => cb(info)),
  generateFromPrompt: (opts) => ipcRenderer.invoke('generate-from-prompt', opts),
  generateFromImage: (opts) => ipcRenderer.invoke('generate-from-image', opts),
  generateImages: (opts) => ipcRenderer.invoke('generate-images', opts),
  hidreamAvailable: () => ipcRenderer.invoke('hidream-available'),
  translatePrompt: (opts) => ipcRenderer.invoke('translate-prompt', opts),
  i18nAutoTranslate: (opts) => ipcRenderer.invoke('i18n-auto-translate', opts),
  setSpellcheckLang: (lang) => ipcRenderer.invoke('set-spellcheck-lang', lang),
  generateBuildStages: (opts) => ipcRenderer.invoke('generate-build-stages', opts),
  imageToTrellis: (opts) => ipcRenderer.invoke('image-to-3d-trellis', opts),
  imageTo3D: (opts) => ipcRenderer.invoke('image-to-3d', opts),
  onAI3DProgress: (cb) => ipcRenderer.on('ai3d-progress', (e, msg) => cb(msg)),
  onBuildStageProgress: (cb) => ipcRenderer.on('build-stage-progress', (e, data) => cb(data)),
  refineMesh: (opts) => ipcRenderer.invoke('refine-mesh', opts),
  saveScreenshot: (opts) => ipcRenderer.invoke('save-screenshot', opts),
  getVersions: (name) => ipcRenderer.invoke('get-versions', name),
  revertToVersion: (opts) => ipcRenderer.invoke('revert-to-version', opts),
  listProjects: () => ipcRenderer.invoke('list-projects'),
  connectClaudeDesktop: () => ipcRenderer.invoke('connect-claude-desktop'),
  disconnectClaudeDesktop: () => ipcRenderer.invoke('disconnect-claude-desktop'),
  checkClaudeDesktop: () => ipcRenderer.invoke('check-claude-desktop'),
  onMcpJobStart: (cb) => ipcRenderer.on('mcp-job-start', (e, data) => cb(data)),
  onMcpJobEnd: (cb) => ipcRenderer.on('mcp-job-end', (e, data) => cb(data)),
  onMcpRefresh: (cb) => ipcRenderer.on('mcp-refresh', (e, data) => cb(data)),
  getConfig: () => ipcRenderer.invoke('get-config'),
  getControlApiToken: () => ipcRenderer.invoke('get-control-api-token'),
  setConfig: (patch) => ipcRenderer.invoke('set-config', patch),
  setBlenderPath: () => ipcRenderer.invoke('set-blender-path'),
  runBlenderScript: (opts) => ipcRenderer.invoke('run-blender-script', opts),
  openInBlender: (opts) => ipcRenderer.invoke('open-in-blender', opts),
  listMeshes: () => ipcRenderer.invoke('list-meshes'),
  getMeshPath: (filename) => ipcRenderer.invoke('get-mesh-path', filename),
  deleteMesh: (filename) => ipcRenderer.invoke('delete-mesh', filename),
  openMeshesFolder: () => ipcRenderer.invoke('open-meshes-folder'),
  openImagesFolder: () => ipcRenderer.invoke('open-images-folder'),
  listImageFolders: () => ipcRenderer.invoke('list-image-folders'),
  readMeshFile: (filePath) => ipcRenderer.invoke('read-mesh-file', filePath),
  getMeshLocalUrl: (filePath) => ipcRenderer.invoke('get-mesh-local-url', filePath),
  exportMesh: (opts) => ipcRenderer.invoke('export-mesh', opts),
  exportImage: (opts) => ipcRenderer.invoke('export-image', opts),
  pickExportPath: (opts) => ipcRenderer.invoke('pick-export-path', opts),
  getFileInfo: (filePath) => ipcRenderer.invoke('get-file-info', filePath),
  importMesh: () => ipcRenderer.invoke('import-mesh'),
  meshTool: (opts) => ipcRenderer.invoke('mesh-tool', opts),
  materialAdjust: (opts) => ipcRenderer.invoke('material-adjust', opts),
  alignTexture: (opts) => ipcRenderer.invoke('mesh:align-texture', opts),
  renderMeshFront: (opts) => ipcRenderer.invoke('mesh:render-front', opts),
  regionRetex: (opts) => ipcRenderer.invoke('mesh:region-retex', opts),
  generateBackView: (opts) => ipcRenderer.invoke('generate-back-view', opts),
  captionImage: (opts) => ipcRenderer.invoke('caption-image', opts),
  saveBuffer: (opts) => ipcRenderer.invoke('save-buffer', opts),
  logToFile: (line) => ipcRenderer.send('renderer-log', line),
  generateMultiview: (opts) => ipcRenderer.invoke('generate-multiview', opts),
  checkMultiviewDir: (imagePath) => ipcRenderer.invoke('check-multiview-dir', imagePath),
  duplicateImageVersion: (opts) => ipcRenderer.invoke('duplicate-image-version', opts),
  copyMeshToProject: (srcPath) => ipcRenderer.invoke('copy-mesh-to-project', srcPath),
  createProjectFromMesh: (opts) => ipcRenderer.invoke('create-project-from-mesh', opts),
  flashTaskbar: () => ipcRenderer.invoke('flash-taskbar'),
  checkGPU: () => ipcRenderer.invoke('check-gpu'),
  checkRAM: () => ipcRenderer.invoke('check-ram'),
  setRamLimit: (pct) => ipcRenderer.invoke('set-ram-limit', pct),
  setGpuLimits: (limits) => ipcRenderer.invoke('set-gpu-limits', limits),
  showInExplorer: (filePath) => ipcRenderer.invoke('show-in-explorer', filePath),
  deleteImageFolder: (folderPath) => ipcRenderer.invoke('delete-image-folder', folderPath),
  importImage: () => ipcRenderer.invoke('import-image'),
  deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
  deleteProject: (opts) => ipcRenderer.invoke('delete-project', opts),
  onAppCloseRequested: (cb) => ipcRenderer.on('app-close-requested', () => cb()),
  confirmAppClose: (opts) => ipcRenderer.send('app-close-confirmed', opts || {}),
  openLogsFolder: () => ipcRenderer.invoke('open-logs-folder'),
  exportDiagnostics: () => ipcRenderer.invoke('export-diagnostics'),
  calibRun: (opts) => ipcRenderer.invoke('calib-run', opts || {}),
  calibLastReport: () => ipcRenderer.invoke('calib-last-report'),
  calibOpenReport: (opts) => ipcRenderer.invoke('calib-open-report', opts || {}),
  calibListReports: () => ipcRenderer.invoke('calib-list-reports'),
  calibDiagnose: (opts) => ipcRenderer.invoke('calib-diagnose', opts || {}),
  calibTiered: () => ipcRenderer.invoke('calib-tiered'),
  calibV3: (opts = {}) => ipcRenderer.invoke('calib-v3', opts),
  calibCancel: () => ipcRenderer.invoke('calib-cancel'),
  calibReadLog: (opts) => ipcRenderer.invoke('calib-read-log', opts || {}),
  calibClearLog: () => ipcRenderer.invoke('calib-clear-log'),
  onCalibProgress: (cb) => ipcRenderer.on('calib-progress', (e, data) => cb(data)),
  countPython: () => ipcRenderer.invoke('count-python'),
  readLogTail: (opts) => ipcRenderer.invoke('read-log-tail', opts),
  rendererLog: (opts) => ipcRenderer.invoke('renderer-log', opts),
  onMainLog: (cb) => ipcRenderer.on('main-log', (e, data) => cb(data)),
  saveThumbnail: (opts) => ipcRenderer.invoke('save-thumbnail', opts),
  getThumbnail: (meshPath) => ipcRenderer.invoke('get-thumbnail', meshPath),
  removeBackground: (imagePath) => ipcRenderer.invoke('remove-background', imagePath),
  imageAdjust: (opts) => ipcRenderer.invoke('image-adjust', opts),
  saveImageDataUrl: (opts) => ipcRenderer.invoke('save-image-data-url', opts),
  importImageFile: (filePath) => ipcRenderer.invoke('import-image-file', filePath),
  importDroppedFile: (args) => ipcRenderer.invoke('import-dropped-file', args),
  downloadToTemp: (url) => ipcRenderer.invoke('download-to-temp', url),
  renameProject: (args) => ipcRenderer.invoke('rename-project', args),
  renameProjectFiles: (args) => ipcRenderer.invoke('rename-project-files', args),
  getProjectDisplayNames: () => ipcRenderer.invoke('get-project-display-names'),
  showNotification: (opts) => ipcRenderer.invoke('show-notification', opts),
  exportToUnreal: (opts) => ipcRenderer.invoke('export-to-unreal', opts),
  autoRig: (opts) => ipcRenderer.invoke('auto-rig', opts),
  autoRigAI: (opts) => ipcRenderer.invoke('auto-rig-ai', _stripFns(opts)),
  animateAI: (opts) => ipcRenderer.invoke('animate-ai', _stripFns(opts)),
  readBonesJson: (name) => ipcRenderer.invoke('read-bones-json', name),
  listRigTemplates: () => ipcRenderer.invoke('list-rig-templates'),
  listRigAnimations: (opts) => ipcRenderer.invoke('list-rig-animations', opts),
  saveLandmarks: (opts) => ipcRenderer.invoke('save-landmarks', opts),
  loadLandmarks: (opts) => ipcRenderer.invoke('load-landmarks', opts),
  analyzeSkeleton: (opts) => ipcRenderer.invoke('analyze-skeleton', opts),
  cancelJob: (jobId) => ipcRenderer.invoke('cancel-job', jobId),
  stopSdxlServer: () => ipcRenderer.invoke('stop-sdxl-server'),
  toggleUnrestricted: (opts) => ipcRenderer.invoke('toggle-unrestricted', opts),
  getParentalStatus: () => ipcRenderer.invoke('get-parental-status'),
  checkProjectNsfw: (opts) => ipcRenderer.invoke('check-project-nsfw', opts),
  checkImagesNsfwTags: (opts) => ipcRenderer.invoke('check-images-nsfw-tags', opts),
  getNsfwKeywords: () => ipcRenderer.invoke('get-nsfw-keywords'),
  checkImageNsfw: (opts) => ipcRenderer.invoke('check-image-nsfw', opts),
  batchCheckNsfw: (opts) => ipcRenderer.invoke('batch-check-nsfw', opts),
  img2img: (opts) => ipcRenderer.invoke('img2img', opts),
  autoInpaint: (opts) => ipcRenderer.invoke('auto-inpaint', opts),
  segmentMask: (opts) => ipcRenderer.invoke('segment-mask', opts),
  recolor: (opts) => ipcRenderer.invoke('recolor', opts),
  texVariant: (opts) => ipcRenderer.invoke('tex-variant', opts),
  enhanceMeshTexture: (opts) => ipcRenderer.invoke('enhance-mesh-texture', opts),
  detailSynth: (opts) => ipcRenderer.invoke('detail-synth', opts),
  saveEmissiveFile: (opts) => ipcRenderer.invoke('save-emissive-file', opts),
  maskInpaint: (opts) => ipcRenderer.invoke('mask-inpaint', opts),
  listImageVersions: (imagePath) => ipcRenderer.invoke('list-image-versions', imagePath),
  revertImage: (opts) => ipcRenderer.invoke('revert-image', opts),
  imageQuickEdit: (opts) => ipcRenderer.invoke('image-quick-edit', opts),

  // 2026-06-12: v1 animation pipeline (Rokoko retarget + judge + library)
  listAnimations: () => ipcRenderer.invoke('list-animations'),
  jobsRunningCount: () => ipcRenderer.invoke('jobs:running-count'),
  jobsKillAll: () => ipcRenderer.invoke('jobs:kill-all'),
  listProcesses: () => ipcRenderer.invoke('list-processes'),
  killProcess: (pid) => ipcRenderer.invoke('kill-process', pid),
  onJobsResumed: (cb) => ipcRenderer.on('jobs-resumed', (_e, data) => cb(data)),
  onJobPidExited: (cb) => ipcRenderer.on('job-pid-exited', (_e, data) => cb(data)),
  animListMotions: (opts) => ipcRenderer.invoke('anim:list-motions', opts || {}),
  animMotionThumb: (opts) => ipcRenderer.invoke('anim:motion-thumb', opts),
  animRetarget: (opts) => ipcRenderer.invoke('anim:retarget', opts),
  animJudge: (opts) => ipcRenderer.invoke('anim:judge', opts),
  animExport: (opts) => ipcRenderer.invoke('anim:export', opts),
  animCancel: (opts) => ipcRenderer.invoke('anim:cancel', opts),
  animCostEstimate: (opts) => ipcRenderer.invoke('anim:cost-estimate', opts),
  // Canal 'anim:progress' (colon) — c'est ce que src/main/animation.js émet
  // (6 sites) ; l'ancien 'anim-progress' (tiret) n'était émis nulle part et
  // laissait la barre de progression du retarget morte.
  onAnimProgress: (cb) => ipcRenderer.on('anim:progress', (e, data) => cb(data)),
});
