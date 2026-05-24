/**
 * MyFabmesh.AI Cloud — meshyAPI cloud shim.
 *
 * The desktop app renderer expects `window.meshyAPI.<fn>()` to talk to
 * the Electron main process via IPC. In the cloud, there's no main
 * process — we replace IPC by HTTP fetch() calls to /api/* served by
 * Next.js, plus a few in-browser implementations (file dialogs, local
 * storage caching).
 *
 * Every function the desktop renderer might call MUST exist here so the
 * UI doesn't crash. Functions that don't make sense in cloud return a
 * graceful "not available" object instead of throwing.
 *
 * Source of truth for the API surface: src/main/preload.js in desktop.
 * Keep this file in sync via `npm run sync-app` (cloud/scripts/sync-app.mjs).
 */
(function () {
  'use strict';

  const log = (...args) => console.log('[meshyAPI-cloud]', ...args);

  // Return shape per stub name. The desktop renderer often does
  // `for (const x of (await meshyAPI.listFoo()))` or
  // `(arr).find(...)` on the result, so a stub that returns
  // `{ ok: false, ... }` crashes the UI with "X is not iterable"
  // or ".find is not a function".
  //
  // Heuristic: anything that reads like a list / collection returns []
  // (an empty array is the safest "I have nothing for you" answer);
  // other reads return a graceful object; writes return { ok: false }.
  const ARRAY_LIKE_RE = /^(list|get(?:All)?(?:Image|Mesh|Folder|Rig|Animation|Version)s?$|get.*List|.*Folders?$|.*Meshes?$|.*Keywords?$|.*Versions?$|.*Templates?$|.*Animations?$|.*Reports?$)/i;
  const NOT_AVAIL = (name) => async (...args) => {
    const arrayLike = ARRAY_LIKE_RE.test(name);
    log(`stub: ${name}() — not yet implemented in Cloud`, arrayLike ? '[]' : '{ok:false}', args);
    return arrayLike ? [] : { ok: false, cloudUnavailable: true, message: `"${name}" is not yet available in Cloud v1.` };
  };

  // --- HTTP helpers --------------------------------------------------
  async function postJSON(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      credentials: 'include',
    });
    return r.json();
  }
  async function postForm(url, formData) {
    const r = await fetch(url, { method: 'POST', body: formData, credentials: 'include' });
    return r.json();
  }
  async function getJSON(url) {
    const r = await fetch(url, { credentials: 'include' });
    return r.json();
  }

  /* ──────────────────────────────────────────────────────────────────
   * EVENT BUS — desktop uses ipcRenderer.on(channel, cb) for streaming
   * progress. In cloud we use EventTarget + SSE / polling fallback.
   * ────────────────────────────────────────────────────────────────── */
  const bus = new EventTarget();
  function onChannel(channel) {
    return (cb) => bus.addEventListener(channel, (e) => cb(e.detail));
  }
  // Expose helper so app routes can dispatch events back to the UI
  window.__meshyEmit = (channel, payload) => {
    bus.dispatchEvent(new CustomEvent(channel, { detail: payload }));
  };

  /* ──────────────────────────────────────────────────────────────────
   * Poll a Replicate prediction and emit progress events the desktop
   * renderer is already wired to listen for.
   * ────────────────────────────────────────────────────────────────── */
  async function pollPrediction(jobId, { onProgress, channel = 'ai3d-progress' } = {}) {
    const start = Date.now();
    while (Date.now() - start < 600_000) {
      await new Promise((r) => setTimeout(r, 2500));
      const j = await getJSON(`/api/jobs/${jobId}`);
      if (onProgress) onProgress(j);
      if (channel) window.__meshyEmit(channel, j);
      if (j.status === 'succeeded') return j;
      if (j.status === 'failed' || j.status === 'canceled') {
        throw new Error(j.error || 'Generation failed');
      }
    }
    throw new Error('Timeout');
  }

  /* ──────────────────────────────────────────────────────────────────
   * IMPLEMENTED — these are the calls the cloud actually services.
   * ────────────────────────────────────────────────────────────────── */
  const impl = {
    /* config / session */
    getConfig: async () => {
      // Desktop reads ~/.fabmesh/config.json. Cloud reads from cookies
      // + localStorage (user preferences) + /api/me (account info).
      const me = await getJSON('/api/me').catch(() => null);
      const local = {};
      try { Object.assign(local, JSON.parse(localStorage.getItem('fabmesh_config') || '{}')); } catch (_) {}
      return {
        mode: 'cloud',
        version: 'cloud-1.0.0-beta',
        cloud: true,
        user: me?.user || null,
        credits: me?.user?.credits ?? 0,
        ...local,
      };
    },
    setConfig: async (patch) => {
      try {
        const cur = JSON.parse(localStorage.getItem('fabmesh_config') || '{}');
        const next = { ...cur, ...patch };
        localStorage.setItem('fabmesh_config', JSON.stringify(next));
        return { ok: true, config: next };
      } catch (e) { return { ok: false, error: String(e) }; }
    },

    /* version + update — cloud doesn't have an installer, no-op */
    checkForUpdate: async () => ({ updateAvailable: false }),
    installUpdateNow: async () => ({ ok: false, reason: 'cloud — no installer' }),
    onUpdateAvailable: onChannel('update-available'),
    onUpdateDownloaded: onChannel('update-downloaded'),

    /* projects (Supabase-backed in cloud) */
    listProjects: async () => {
      const j = await getJSON('/api/projects');
      return Array.isArray(j) ? j : (j.projects || []);
    },
    deleteProject: async ({ id } = {}) => postJSON('/api/projects/delete', { id }),

    /* image-to-3D (the headline feature) */
    imageTo3D: async (opts) => {
      const fd = new FormData();
      // The desktop sends a path; here the renderer should pass a Blob
      // (we'll patch the calling sites if needed). For now, accept both.
      if (opts.image instanceof Blob) fd.append('image', opts.image);
      else if (opts.imagePath) fd.append('imagePath', opts.imagePath);
      for (const [k, v] of Object.entries(opts)) {
        if (k !== 'image' && k !== 'imagePath') fd.append(k, String(v));
      }
      const created = await postForm('/api/generate', fd);
      if (created.error) throw new Error(created.error);
      window.__meshyEmit('ai3d-progress', { stage: 'queued', jobId: created.jobId });
      const result = await pollPrediction(created.jobId);
      return { ok: true, meshUrl: result.url, jobId: created.jobId, duration_s: result.duration_s };
    },
    imageToTrellis: function (opts) { return this.imageTo3D(opts); },
    onAI3DProgress: onChannel('ai3d-progress'),

    /* image generation (txt2img). Uses Pollinations.ai's public endpoint
       directly from the browser — free, no API key, CORS-OK. Same engine
       the desktop calls behind its Python proxy. The image URL is the
       finished PNG; we save it into the project as a Blob URL so the
       renderer can display + later upload it for the mesh step. */
    generateImages: async ({ prompt, projectName, numImages = 1, steps = 30, jobId } = {}) => {
      log(`generateImages via pollinations.ai — ${numImages}× "${(prompt || '').slice(0, 60)}…"`);
      const out = [];
      const seedBase = Math.floor(Math.random() * 1e9);
      for (let i = 0; i < numImages; i++) {
        const seed = seedBase + i;
        const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`
          + `?width=1024&height=1024&seed=${seed}&model=flux&nologo=true`
          + `&enhance=false&private=true`;
        window.__meshyEmit('image-progress', { jobId, index: i, total: numImages, status: 'fetching' });
        const r = await fetch(url);
        if (!r.ok) throw new Error(`pollinations HTTP ${r.status}`);
        const blob = await r.blob();
        const blobUrl = URL.createObjectURL(blob);
        // The renderer indexes images by path. We use the blob URL as the
        // pseudo-path; downstream code reads it via fetch(path) when sending
        // to /api/generate, which works for blob: URLs in modern browsers.
        out.push({
          path: blobUrl, name: `${projectName || 'img'}_${i + 1}.png`,
          seed, steps, prompt,
        });
        window.__meshyEmit('image-progress', { jobId, index: i, total: numImages, status: 'done' });
      }
      return { ok: true, images: out };
    },

    /* These will be wired against /api/generate-image (Replicate SDXL/Flux)
       when we expose them. For now generateFromPrompt is unused by the
       Cloud workspace flow — generateImages above is what the renderer
       calls for the "Create new image" step. */
    generateFromPrompt: NOT_AVAIL('generateFromPrompt'),
    generateFromImage: NOT_AVAIL('generateFromImage'),
    generateBackView:  NOT_AVAIL('generateBackView'),
    generateMultiview: NOT_AVAIL('generateMultiview'),
    generateBuildStages: NOT_AVAIL('generateBuildStages'),
    onBuildStageProgress: onChannel('build-stage-progress'),

    /* navigation / external */
    openWebsite: async () => { window.open('https://fabienlacaze.github.io/MyFabmesh', '_blank'); return { ok: true }; },
    showInExplorer: NOT_AVAIL('showInExplorer'),
    openLogsFolder: NOT_AVAIL('openLogsFolder'),
    openMeshesFolder: NOT_AVAIL('openMeshesFolder'),
    openImagesFolder: NOT_AVAIL('openImagesFolder'),

    /* logging */
    logToFile: (line) => { try { console.debug('[client]', line); } catch (_) {} },
    rendererLog: async (opts) => { try { console.debug('[client]', opts); } catch (_) {} ; return { ok: true }; },
    onMainLog: onChannel('main-log'),
    readLogTail: async () => ({ lines: [], ok: true }),

    /* close handling (cloud = browser close, no special handling) */
    onAppCloseRequested: () => {},
    confirmAppClose: () => {},

    /* file I/O — adapted for browser */
    importImage: async () => {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/png,image/jpeg,image/webp';
        input.onchange = () => {
          const f = input.files[0];
          if (!f) return resolve({ ok: false, cancelled: true });
          const reader = new FileReader();
          reader.onload = () => resolve({ ok: true, file: f, dataUrl: reader.result, name: f.name });
          reader.readAsDataURL(f);
        };
        input.click();
      });
    },
    importMesh: async () => {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.glb,.gltf,.obj,.fbx,.ply';
        input.onchange = () => {
          const f = input.files[0];
          if (!f) return resolve({ ok: false, cancelled: true });
          resolve({ ok: true, file: f, name: f.name });
        };
        input.click();
      });
    },
    saveBuffer: async ({ filename, buffer, mime } = {}) => {
      const blob = new Blob([buffer], { type: mime || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename || 'download.bin';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { ok: true, path: filename, downloaded: true };
    },
    saveImageDataUrl: async ({ dataUrl, filename } = {}) => {
      const a = document.createElement('a');
      a.href = dataUrl; a.download = filename || 'image.png';
      a.click();
      return { ok: true, path: filename, downloaded: true };
    },

    /* hardware checks — cloud always "OK" */
    checkGPU: async () => ({ ok: true, name: 'Cloud GPU (Replicate)', vram: 48, cloud: true }),
    checkRAM: async () => ({ ok: true, total: 'cloud', free: 'cloud', cloud: true }),
    countPython: async () => ({ count: 0, cloud: true }),
    setRamLimit: async () => ({ ok: true, cloud: true }),
    setGpuLimits: async () => ({ ok: true, cloud: true }),

    /* parental / NSFW (passthrough lenient defaults) */
    getParentalStatus: async () => ({ enabled: false, unlocked: true }),
    toggleUnrestricted: async () => ({ ok: true }),
    checkProjectNsfw: async () => ({ ok: true, safe: true }),
    checkImagesNsfwTags: async () => ({ ok: true, safe: true }),
    // Renderer does `keywords.find(...)` directly on the return value,
    // so we MUST return a plain array (not { keywords: [] }).
    getNsfwKeywords: async () => [],
    checkImageNsfw: async () => ({ ok: true, safe: true }),
    batchCheckNsfw: async () => ({ ok: true, results: [] }),

    /* notifications (browser-native) */
    showNotification: async ({ title, body } = {}) => {
      try {
        if (Notification.permission === 'granted') new Notification(title || 'MyFabmesh', { body });
        else if (Notification.permission !== 'denied') {
          const p = await Notification.requestPermission();
          if (p === 'granted') new Notification(title || 'MyFabmesh', { body });
        }
      } catch (_) {}
      return { ok: true };
    },
    flashTaskbar: async () => { /* no-op in browser */ return { ok: true }; },
  };

  /* ──────────────────────────────────────────────────────────────────
   * STUBS — every API function present in preload.js but not yet
   * implemented for cloud. We list them so the renderer can call them
   * without crashing on `meshyAPI.xxx is not a function`.
   * ────────────────────────────────────────────────────────────────── */
  const STUBS = [
    'reconfigureFabmesh', 'uninstallFabmesh',
    'refineMesh', 'saveScreenshot', 'getVersions', 'revertToVersion',
    'connectClaudeDesktop', 'disconnectClaudeDesktop', 'checkClaudeDesktop',
    'getControlApiToken', 'testMeshyKey',
    'setBlenderPath', 'runBlenderScript', 'openInBlender',
    'listMeshes', 'getMeshPath', 'deleteMesh',
    'listImageFolders', 'readMeshFile', 'getMeshLocalUrl',
    'exportMesh', 'exportImage', 'pickExportPath', 'getFileInfo',
    'meshTool', 'materialAdjust', 'alignTexture',
    'captionImage', 'checkMultiviewDir', 'duplicateImageVersion',
    'copyMeshToProject', 'createProjectFromMesh',
    'deleteImageFolder', 'deleteFile',
    'calibRun', 'calibLastReport', 'calibOpenReport', 'calibListReports',
    'calibDiagnose', 'calibTiered', 'calibV3', 'calibCancel',
    'calibReadLog', 'calibClearLog',
    'saveThumbnail', 'getThumbnail',
    'removeBackground', 'imageAdjust', 'importImageFile',
    'exportToUnreal',
    'autoRig', 'autoRigAI', 'listRigTemplates', 'listRigAnimations',
    'saveLandmarks', 'loadLandmarks', 'analyzeSkeleton',
    'cancelJob', 'stopSdxlServer',
    'img2img', 'autoInpaint', 'maskInpaint',
    'listImageVersions', 'revertImage', 'imageQuickEdit',
  ];
  const STUB_EVENTS = [
    'onMcpJobStart', 'onMcpJobEnd', 'onMcpRefresh', 'onCalibProgress',
  ];

  const meshyAPI = { ...impl };
  for (const name of STUBS) if (!meshyAPI[name]) meshyAPI[name] = NOT_AVAIL(name);
  for (const name of STUB_EVENTS) if (!meshyAPI[name]) meshyAPI[name] = () => {};

  /* ──────────────────────────────────────────────────────────────────
   * Wizard API — desktop has a first-run wizard. In cloud we skip it.
   * ────────────────────────────────────────────────────────────────── */
  const wizardAPI = new Proxy({}, {
    get(_t, name) {
      if (name === 'getMode') return async () => 'cloud';
      if (name === 'getVersion') return async () => 'cloud-1.0.0-beta';
      return NOT_AVAIL(`wizardAPI.${String(name)}`);
    },
  });

  /* ──────────────────────────────────────────────────────────────────
   * Mount on window
   * ────────────────────────────────────────────────────────────────── */
  window.meshyAPI = meshyAPI;
  window.wizardAPI = wizardAPI;
  window.__isCloud = true;
  log(`mounted — ${Object.keys(meshyAPI).length} methods, ${STUBS.length} stubs`);
})();
