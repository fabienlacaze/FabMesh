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
    return arrayLike ? [] : {
      ok: false, success: false, cloudUnavailable: true,
      // D5: provide both `error` (string) AND `message` so renderer call
      // sites that do `r?.error` get a useful toast instead of "undefined".
      error: `"${name}" is a Desktop-only feature — open the Desktop app to use it.`,
      message: `"${name}" is a Desktop-only feature.`,
    };
  };

  // --- HTTP helpers --------------------------------------------------
  async function postJSON(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      credentials: 'include',
    });
    // Tag non-OK responses with ok:false so callers (deleteMesh,
    // etc.) can detect 404/500 without parsing HTTP status separately.
    // Previously a 404 returned {"error":"not found"} silently — no
    // success/ok flag — and the delete-version handler treated it as
    // a no-op.
    let body_;
    try { body_ = await r.json(); } catch { body_ = {}; }
    if (!r.ok) {
      return { ok: false, success: false, status: r.status, error: (body_ && body_.error) || `HTTP ${r.status}`, ...body_ };
    }
    return body_;
  }
  async function postForm(url, formData) {
    const r = await fetch(url, { method: 'POST', body: formData, credentials: 'include' });
    return r.json();
  }
  async function getJSON(url) {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) {
      // Surface server errors (503 kill-switch, 401 ban, 5xx...) so
      // callers like pollPrediction can stop instead of looping on
      // a JSON payload that doesn't carry a `status` field.
      let detail = '';
      try { const j = await r.clone().json(); detail = j.error || ''; } catch {}
      const err = new Error(`HTTP ${r.status}${detail ? ': ' + detail : ''}`);
      err.status = r.status;
      err.detail = detail;
      throw err;
    }
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
    let consecutiveErrors = 0;
    while (Date.now() - start < 600_000) {
      await new Promise((r) => setTimeout(r, 2500));
      let j;
      try {
        j = await getJSON(`/api/jobs/${jobId}`);
        consecutiveErrors = 0;
      } catch (e) {
        // 503 = kill-switch on, 401 = banned, 5xx = worker issue.
        // Bail with a clear message instead of polling forever.
        if (e.status === 503) {
          throw new Error('Generation aborted: the service is in maintenance mode. Please try again in a few minutes.');
        }
        if (e.status === 401) {
          throw new Error('Generation aborted: session expired or account banned.');
        }
        // Transient network glitch — let up to 5 in a row pass before bailing.
        consecutiveErrors++;
        if (consecutiveErrors >= 5) {
          throw new Error('Generation aborted after 5 consecutive poll failures: ' + (e.message || e));
        }
        continue;
      }
      if (onProgress) onProgress(j);
      if (channel) window.__meshyEmit(channel, j);
      if (j.status === 'succeeded') return j;
      if (j.status === 'failed' || j.status === 'canceled') {
        // Admin-cancelled jobs come back as status='canceled' with
        // error='admin canceled' (or 'admin canceled (no refund)').
        // Surface that verbatim so the user knows it wasn't a glitch.
        const msg = j.error
          ? (/admin\s*can?celled?/i.test(j.error)
              ? (/no\s*refund/i.test(j.error)
                  ? 'Generation cancelled by an administrator (no refund).'
                  : 'Generation cancelled by an administrator. Your credits have been refunded.')
              : j.error)
          : 'Generation failed';
        throw new Error(msg);
      }
    }
    throw new Error('Timeout');
  }

  /* ──────────────────────────────────────────────────────────────────
   * Pending-job persistence — saves any mesh job in localStorage so a
   * page reload doesn't strand a 2-5 min generation. resumePendingJobs
   * fires on boot, re-creates the progress popup for each entry, and
   * resumes polling. Hardcoded to mesh jobs for now (the only ones
   * that genuinely run for minutes server-side).
   * ────────────────────────────────────────────────────────────────── */
  const PENDING_JOBS_KEY = 'myfm:pending-jobs';
  function _readPendingJobs() {
    try { return JSON.parse(localStorage.getItem(PENDING_JOBS_KEY) || '[]'); }
    catch { return []; }
  }
  function _writePendingJobs(list) {
    try { localStorage.setItem(PENDING_JOBS_KEY, JSON.stringify(list)); } catch {}
  }
  function _addPendingJob(entry) {
    const list = _readPendingJobs().filter((j) => j.jobId !== entry.jobId);
    list.push({ ...entry, ts: Date.now() });
    _writePendingJobs(list);
  }
  function _removePendingJob(jobId) {
    _writePendingJobs(_readPendingJobs().filter((j) => j.jobId !== jobId));
  }

  let _resumeRetries = 0;
  async function resumePendingJobs() {
    const list = _readPendingJobs();
    if (!list.length) return;
    const now = Date.now();
    const fresh = list.filter((e) => now - (e.ts || 0) < 30 * 60_000);
    if (fresh.length !== list.length) _writePendingJobs(fresh);
    // index2.js is type="module" so top-level decls aren't on window.
    // Renderer exposes window.fabmeshJobs (.push/.complete) and a
    // patched window.reloadCurrentProject. If still missing, retry up
    // to 10 times (10 s) — needed because module evaluation order is
    // non-deterministic relative to this classic script.
    const jobs = window.fabmeshJobs;
    if (!jobs || typeof jobs.push !== 'function') {
      if (_resumeRetries++ < 10) {
        console.warn('[cloud] fabmeshJobs not ready, retry', _resumeRetries);
        setTimeout(resumePendingJobs, 1000);
        return;
      }
      console.error('[cloud] fabmeshJobs never appeared — pending jobs will still poll silently');
      // Fall through: pollPrediction still runs in the background, the
      // popup just won't show. Better than aborting the resume entirely.
    }
    for (const entry of fresh) {
      // Pass entry.ts as the 5th arg so the popup's ELAPSED counter
      // reflects the time since the REAL job start (not just the time
      // since the page reload).
      const job = jobs ? jobs.push(
        entry.name || `Generate 3D: ${entry.projectName || ''}`,
        null,
        { ...(entry.params || {}), Resumed: 'after page reload' },
        entry.expectedMs || 150_000,
        entry.ts,
      ) : null;
      // Don't await — let all resumed jobs run in parallel.
      (async () => {
        try {
          await pollPrediction(entry.jobId);
          if (job && jobs && jobs.complete) jobs.complete(job.id, true);
          if (typeof window.__cloudCreditsRefresh === 'function') window.__cloudCreditsRefresh();
          if (typeof window.reloadCurrentProject === 'function') {
            try { await window.reloadCurrentProject(); } catch {}
          }
          _removePendingJob(entry.jobId);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (job && jobs && jobs.complete) jobs.complete(job.id, false, msg);
          _removePendingJob(entry.jobId);
        }
      })();
    }
  }
  // Expose so other modules (or the UI) can force a cleanup.
  window.__cloudResumePending = resumePendingJobs;
  window.__cloudRemovePending = _removePendingJob;

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
    deleteProject: async ({ projectName, id } = {}) => {
      // Cloud projects are virtual — they're just a group of jobs sharing
      // a `project_name`. The Worker exposes /api/cloud-projects/delete
      // which nulls the project_name on every job belonging to the user.
      // The renderer calls this with `projectName`; older callers may
      // still pass `id` (= projectName in their semantics).
      const name = projectName || id;
      if (!name) return { ok: false, error: 'projectName required' };
      try { return await postJSON('/api/cloud-projects/delete', { projectName: name }); }
      catch (e) { return { ok: false, error: String(e) }; }
    },

    /* image-to-3D (the headline feature).
       Two fixes wrapped in here:
       - C2: return shape now matches desktop main.js (success:true,
             meshPath:..., meshUrl:...). The renderer reads r.success.
       - C3: when only opts.imagePath is provided (R2/blob URL),
             fetch it into a Blob before posting — the Worker route
             requires `image: File` and otherwise responds 400. */
    imageTo3D: async (opts) => {
      const fd = new FormData();
      // Two paths:
      //  - opts.image is a Blob/File the caller already has in hand → upload it.
      //  - opts.imagePath is a URL (R2 / blob: / data:) → just forward the
      //    string to the Worker, which fetches it server-side. Avoids the
      //    R2 CORS round-trip the browser can't do.
      if (opts.image instanceof Blob) {
        fd.append('image', opts.image, 'src.png');
      } else if (opts.imagePath && /^blob:/i.test(opts.imagePath)) {
        // Local blob URL — we MUST fetch this client-side because it only
        // exists in this tab; the Worker can't see it.
        try {
          const r = await fetch(opts.imagePath);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          fd.append('image', await r.blob(), 'src.png');
        } catch (e) {
          return { ok: false, success: false, error: 'cannot fetch blob source: ' + (e instanceof Error ? e.message : String(e)) };
        }
      } else if (opts.imagePath && /^https?:\/\//i.test(opts.imagePath)) {
        // Public URL — let the Worker fetch it (same origin / no CORS).
        fd.append('imagePath', opts.imagePath);
      } else {
        return { ok: false, success: false, error: 'no source image provided' };
      }
      for (const [k, v] of Object.entries(opts)) {
        if (k === 'image' || k === 'imagePath') continue;
        if (v === undefined || v === null) continue;
        fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
      const created = await postForm('/api/generate', fd);
      if (created.error) {
        return { ok: false, success: false, error: created.error };
      }
      window.__meshyEmit('ai3d-progress', { stage: 'queued', jobId: created.jobId });
      // Survive a page reload: persist this jobId so resumePendingJobs()
      // can re-create the popup + re-poll after refresh. Removed in the
      // finally below regardless of outcome.
      _addPendingJob({
        jobId: created.jobId,
        kind: 'mesh',
        projectName: opts.outputName || opts.projectName || '',
        name: `Generate 3D: ${opts.outputName || opts.projectName || ''}`,
        expectedMs: 150_000,
      });
      try {
        const result = await pollPrediction(created.jobId);
        // Trigger credit pill refresh — mesh gen costs 1-2 credits.
        if (typeof window.__cloudCreditsRefresh === 'function') window.__cloudCreditsRefresh();
        return {
          ok: true, success: true,
          meshPath: result.url, meshUrl: result.url,
          jobId: created.jobId, duration_s: result.duration_s,
        };
      } finally {
        _removePendingJob(created.jobId);
      }
    },
    imageToTrellis: function (opts) { return this.imageTo3D(opts); },
    onAI3DProgress: onChannel('ai3d-progress'),

    /* Image generation (txt2img). Goes through OUR Worker at
       /api/generate-image, which calls Replicate's black-forest-labs/
       flux-schnell (~3s, ~$0.003/image) and mirrors the PNG into R2.
       Returns the EXACT shape the desktop IPC returns:
         { success: bool, images: [path, path, ...], error?: string }
       so the renderer's caller works unchanged. */
    generateImages: async ({ prompt, userPrompt, projectName, numImages = 1, steps, jobId } = {}) => {
      log(`generateImages via /api/generate-image (Cog myfabmesh-cloud) — ${numImages}× "${(userPrompt || prompt || '').slice(0, 60)}…"`);
      window.__meshyEmit('image-progress', { jobId, index: 0, total: numImages, status: 'fetching' });
      // Read asset type / style from the workspace dropdowns so the
      // Worker can rebuild the enriched prompt server-side using the
      // exact tables from index2.js (cloud output matches desktop).
      const asset_type = document.getElementById('ws-asset-type')?.value || 'character';
      const asset_style = document.getElementById('ws-asset-style')?.value || 'realistic';
      try {
        const r = await fetch('/api/generate-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,              // already-enriched fallback
            userPrompt,          // raw user text (Worker re-enriches)
            numImages, asset_type, asset_style, steps,
          }),
          credentials: 'include',
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          const msg = j?.error || `HTTP ${r.status}`;
          log('generateImages FAILED:', msg, j);
          return { success: false, images: [], error: msg };
        }
        if (!j?.success || !Array.isArray(j?.paths) || !j.paths.length) {
          const msg = j?.error || 'no images returned';
          log('generateImages EMPTY:', msg, j);
          return { success: false, images: [], error: msg };
        }
        window.__meshyEmit('image-progress', { jobId, index: numImages, total: numImages, status: 'done' });
        // C1: persist generated URLs in localStorage so listImageFolders
        // returns them on the next refresh (the Worker doesn't store rows
        // for individual PNGs).
        _appendCloudImages(projectName, j.paths, 'front');
        // Persist the prompt so the "Copy prompt" button (index2.js:1808-1830)
        // can appear on the project after a reload. userPrompt is the user
        // input; prompt is the enriched version (with style template). We
        // prefer the raw user input — matches what desktop's main.js writes
        // to `prompt.txt` next to the image folder.
        _savePrompt(projectName, userPrompt || prompt || '');
        // Force credit pill refresh after successful spend.
        if (typeof window.__cloudCreditsRefresh === 'function') window.__cloudCreditsRefresh();
        return { success: true, images: j.paths };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log('generateImages THREW:', msg);
        return { success: false, images: [], error: msg };
      }
    },

    /* These will be wired against /api/generate-image (Replicate SDXL/Flux)
       when we expose them. For now generateFromPrompt is unused by the
       Cloud workspace flow — generateImages above is what the renderer
       calls for the "Create new image" step. */
    generateFromPrompt: async ({ prompt, projectName, numImages = 1 } = {}) =>
      meshyAPI.generateImages({ prompt, projectName, numImages }),

    /* img2img via Pollinations (the `image=` query param triggers their
       img2img mode). Falls back to a plain prompt on failure. */
    generateFromImage: async ({ prompt, imagePath, imageUrl, projectName, numImages = 1 } = {}) => {
      const ref = imageUrl || imagePath;
      const out = [];
      const seedBase = Math.floor(Math.random() * 1e9);
      for (let i = 0; i < numImages; i++) {
        const seed = seedBase + i;
        let url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt || '')}`
          + `?width=1024&height=1024&seed=${seed}&model=flux&nologo=true&private=true`;
        if (ref && /^https?:/i.test(ref)) url += `&image=${encodeURIComponent(ref)}`;
        try {
          const r = await fetch(url);
          if (!r.ok) throw new Error('http ' + r.status);
          const blob = await r.blob();
          out.push({
            path: URL.createObjectURL(blob),
            name: `${projectName || 'img2img'}_${i + 1}.png`,
            seed, prompt,
          });
        } catch (e) {
          log('generateFromImage fetch failed:', e);
        }
      }
      return { ok: true, images: out };
    },

    /* Back view via Worker (Pollinations under the hood, R2-tunneled). */
    generateBackView: async ({ frontImage, frontImageUrl, prompt, promptHint, numImages = 1, assetType, projectName } = {}) => {
      try {
        const r = await postJSON('/api/generate-back-view', {
          prompt: prompt || promptHint || '',
          promptHint: promptHint || prompt || '',
          numImages, frontImageUrl: frontImageUrl || frontImage, assetType,
        });
        if (r?.success && Array.isArray(r.paths)) {
          // C1: persist back images and front->back mapping so the
          // FRONT/BACK bar survives reload.
          _appendCloudImages(projectName, r.paths, 'back');
          const front = frontImageUrl || frontImage;
          if (front && r.paths[0]) _saveBackPhoto(projectName, front, r.paths[0]);
          if (typeof window.__cloudCreditsRefresh === 'function') window.__cloudCreditsRefresh();
        }
        return r; // { ok, success, paths, creditsRemaining? }
      } catch (e) {
        return { ok: false, success: false, error: String(e) };
      }
    },

    /* 4 views (front/back/left/right) generated client-side via 4×
       Pollinations calls. Caller already has a "front" image; we only
       generate the 3 missing ones. */
    generateMultiview: async ({ imagePath, prompt, promptHint, projectName } = {}) => {
      const base = (prompt || promptHint || '').toString().slice(0, 300);
      const views = ['back view', 'left side view', 'right side view'];
      const seedBase = Math.floor(Math.random() * 1e9);
      const paths = [];
      for (let i = 0; i < views.length; i++) {
        const p = `${views[i]}, full body, T-pose, plain white background, ${base}`;
        const seed = seedBase + i;
        const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(p)}`
          + `?width=1024&height=1024&seed=${seed}&model=flux&nologo=true&private=true`;
        try {
          const r = await fetch(url);
          if (!r.ok) throw new Error('http ' + r.status);
          const blob = await r.blob();
          paths.push(URL.createObjectURL(blob));
        } catch (e) {
          log('generateMultiview view failed:', views[i], e);
        }
      }
      void imagePath; void projectName;
      return { ok: true, success: true, outDir: null, paths };
    },

    /* Desktop-only build-stage generator. */
    generateBuildStages: async () => ({ ok: true, stages: [] }),
    onBuildStageProgress: onChannel('build-stage-progress'),

    /* navigation / external */
    openWebsite: async () => { window.open('https://fabienlacaze.github.io/MyFabmesh', '_blank'); return { ok: true }; },
    showInExplorer: async (filePath) => {
      // In the browser there's no "show in folder" — best we can do is
      // open the mesh URL in a new tab so the user can save / inspect it.
      if (filePath && /^https?:|^blob:/i.test(filePath)) window.open(filePath, '_blank');
      return { ok: true, cloud: true };
    },
    openLogsFolder: async () => {
      try { console.log('[meshyAPI-cloud] No log folder in cloud — open browser devtools instead.'); } catch (_) {}
      return { ok: true, cloud: true, message: 'No filesystem in cloud. Use the browser devtools console for logs.' };
    },
    openMeshesFolder: async () => {
      try { window.location.hash = '#/projects'; } catch (_) {}
      return { ok: true, cloud: true, message: 'No filesystem in cloud. Use the Projects page.' };
    },
    openImagesFolder: async () => {
      try { window.location.hash = '#/projects'; } catch (_) {}
      return { ok: true, cloud: true, message: 'No filesystem in cloud. Use the Projects page.' };
    },

    /* logging */
    logToFile: (line) => { try { console.debug('[client]', line); } catch (_) {} },
    rendererLog: async (opts) => { try { console.debug('[client]', opts); } catch (_) {} ; return { ok: true }; },
    onMainLog: onChannel('main-log'),
    readLogTail: async () => ({ lines: [], ok: true }),

    /* close handling (cloud = browser close, no special handling) */
    onAppCloseRequested: () => {},
    confirmAppClose: () => {},

    /* file I/O — adapted for browser */
    // C5: desktop importImage returns a string PATH or null. Renderer
    // does `const filePath = await API.importImage(); if (!filePath) return;`
    // so anything else (e.g. `{ ok:true, file:File }`) makes the renderer
    // proceed with [object Object] and re-open the picker. We return a
    // blob URL (stable enough for the renderer to use), and stash the
    // File on window so importImageFile can pick it back up.
    importImage: async () => {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/png,image/jpeg,image/webp';
        input.onchange = () => {
          const f = input.files[0];
          if (!f) return resolve(null);
          const url = URL.createObjectURL(f);
          window.__cloudImportedFiles = window.__cloudImportedFiles || {};
          window.__cloudImportedFiles[url] = f;
          resolve(url);
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
    saveBuffer: async (arg = {}) => {
      // Sculpt-save branch: caller passes { path, base64 } -> upload GLB to R2
      // via the worker so the edited mesh becomes a persistent HTTPS URL.
      if (arg && arg.base64 && arg.path) {
        try {
          const normPath = String(arg.path).replace(/\\/g, '/');
          const segs = normPath.split('/');
          const filename = segs.pop() || ('mesh_' + Date.now() + '.glb');
          const resp = await fetch('/api/upload-mesh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ base64: arg.base64, filename })
          });
          const r = await resp.json().catch(() => ({}));
          if (!r || !r.success) {
            return { success: false, error: (r && r.error) || 'upload failed' };
          }
          return { success: true, ok: true, path: r.path, url: r.url };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      }
      // Legacy export-download branch: { filename, buffer, mime } -> browser download.
      const { filename, buffer, mime } = arg;
      const blob = new Blob([buffer], { type: mime || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename || 'download.bin';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { success: true, ok: true, path: filename, downloaded: true };
    },
    saveImageDataUrl: async ({ dataUrl, filename, basePath, suffix } = {}) => {
      // Cloud-correct behaviour: upload the dataURL produced by the
      // canvas editor (Clone Stamp, Mask, Blur, Paint, etc.) to R2 via
      // the Worker, get back a stable HTTPS URL, attach it as a new
      // version of the current project.
      //
      // Why R2 not blob:? URL.createObjectURL produces a blob: URL
      // that's only valid for the current page session. After a reload
      // the blob is revoked and the version thumb 404s in the strip.
      // Persisting to R2 gives us a permanent URL the user can come
      // back to.
      if (!dataUrl) return { success: false, error: 'dataUrl required' };
      try {
        const suf = (suffix || 'edit').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 16);
        const r = await postJSON('/api/upload-image', { dataUrl, suffix: suf });
        if (!r?.success || !r.path) {
          return { success: false, error: r?.error || 'upload failed' };
        }
        const newPath = r.path;
        _attachToCurrentProject(newPath, 'front');
        const base = basePath ? _stripExt(_basename(basePath)) : 'image';
        const fn   = filename || `${base}_${suf}_${Date.now()}.png`;
        return { success: true, ok: true, newPath, path: newPath, filename: fn };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    /* hardware checks — cloud always "OK" */
    checkGPU: async () => ({ ok: true, name: 'Cloud GPU', vram: 48, cloud: true }),
    checkRAM: async () => ({ ok: true, total: 'cloud', free: 'cloud', cloud: true }),
    countPython: async () => ({ count: 0, cloud: true }),
    setRamLimit: async () => ({ ok: true, cloud: true }),
    setGpuLimits: async () => ({ ok: true, cloud: true }),

    /* parental / NSFW (passthrough lenient defaults) */
    // Desktop contract is `unrestricted`, not `unlocked`. Cloud beta has
    // no PIN flow yet, so we report no restrictions by default.
    getParentalStatus: async () => ({ enabled: false, unrestricted: true, unlocked: true }),
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
   * EXTRA IMPLEMENTATIONS — split out so the IIFE stays readable.
   * Everything in this block ends up on `impl` before the STUBS pass.
   * ────────────────────────────────────────────────────────────────── */

  // ── tiny helpers used by the impls below ────────────────────────────
  function _projectThumbKey(name) { return `myfm:thumb:${name}`; }
  function _versionsKey(projectName, base) { return `myfm:versions:${projectName}:${base}`; }
  function _basename(p) { return String(p || '').split(/[/\\]/).pop() || ''; }
  function _stripExt(name) { return name.replace(/\.[^.]+$/, ''); }
  function _imgFromBlobUrl(url) {
    // Two-stage load. For http(s) URLs we fetch the bytes ourselves
    // and turn them into a `blob:` URL — that way:
    //   1. CORS happens on fetch() (where it works), not on <img> (where
    //      a missing Access-Control-Allow-Origin header silently taints
    //      the canvas and breaks getImageData → "[object Event]").
    //   2. Errors come back as real Error messages, not DOM Events that
    //      stringify to "[object Event]".
    // For blob: and data: URLs we skip the fetch since they're already
    // same-origin / inline.
    return new Promise((resolve, reject) => {
      const loadInto = (finalUrl) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('image decode failed: ' + finalUrl));
        img.src = finalUrl;
      };
      if (/^https?:/i.test(url)) {
        // Same-origin proxy bypasses CORS on R2/Replicate/etc. Without
        // this, browser fetch() to a 3rd-party host without CORS
        // returns "Failed to fetch" — and even when CORS is open, the
        // <img> tag's getImageData taints the canvas.
        const proxied = '/api/proxy-image?url=' + encodeURIComponent(url);
        fetch(proxied, { credentials: 'omit' })
          .then(r => {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.blob();
          })
          .then(blob => loadInto(URL.createObjectURL(blob)))
          .catch(e => reject(new Error('image fetch failed: ' + (e?.message || e))));
      } else {
        loadInto(url);
      }
    });
  }
  async function _canvasFor(srcUrl) {
    const img = await _imgFromBlobUrl(srcUrl);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return { canvas, ctx, img };
  }
  // Persist a canvas to R2 via /api/upload-image so the resulting URL
  // survives a page reload. Falls back to a local blob: URL (which
  // does NOT survive reload — see _canvasFor warning) if the upload
  // fails, so the user at least sees the result in this session.
  async function _canvasToBlobUrl(canvas, mime = 'image/png', suffix = 'edit') {
    const dataUrl = canvas.toDataURL(mime);
    try {
      const r = await postJSON('/api/upload-image', { dataUrl, suffix });
      if (r?.success && r.path) return r.path;
    } catch (_) { /* fall through to blob */ }
    return await new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(URL.createObjectURL(blob)), mime);
    });
  }
  function _pushVersion(projectName, basePath, newPath) {
    try {
      const k = _versionsKey(projectName || 'untitled', _stripExt(_basename(basePath)));
      const arr = JSON.parse(localStorage.getItem(k) || '[]');
      arr.push({ path: newPath, created: new Date().toISOString() });
      localStorage.setItem(k, JSON.stringify(arr.slice(-20))); // cap at 20 versions
    } catch (_) {}
  }
  async function _downloadBlobAs(blobOrUrl, filename) {
    let url;
    if (blobOrUrl instanceof Blob) url = URL.createObjectURL(blobOrUrl);
    else url = blobOrUrl;
    const a = document.createElement('a');
    a.href = url; a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (blobOrUrl instanceof Blob) setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ── C1: localStorage cache for generated images ─────────────────
  // The Worker doesn't persist a DB row for each generated PNG (yet),
  // so on the desktop renderer's `reloadCurrentProject()` → list-folders
  // round-trip the workspace ends up empty. We cache front/back/multi-
  // view URLs locally per project name and merge them back in.
  const _imgKey    = (name) => `myfm:cloudimages:${name || 'untitled'}`;
  const _backKey   = (name) => `myfm:backphotos:${name || 'untitled'}`;
  // Local cache of the last prompt used per project. The Worker doesn't
  // persist prompts in the DB (jobs.options.prompt is empty for cloud
  // mesh inserts, and image gens don't create DB rows at all). Without
  // this cache, the "Copy prompt" button never appears in the cloud UI
  // because index2.js conditions it on p.prompt being non-empty.
  const _promptKey = (name) => `myfm:prompt:${name || 'untitled'}`;
  function _savePrompt(projectName, prompt) {
    if (!projectName || !prompt) return;
    try { localStorage.setItem(_promptKey(projectName), String(prompt)); }
    catch (_) {}
  }
  function _readPrompt(projectName) {
    try { return localStorage.getItem(_promptKey(projectName)) || ''; }
    catch (_) { return ''; }
  }

  // Push a newly-generated image URL into the current project's local
  // cache so reloadCurrentProject() picks it up. Used by every shim
  // that produces a new image (img2img, autoInpaint, maskInpaint,
  // faceFixImage, upscale, etc.) — without this the user clicks
  // Modify, the call succeeds, but the new version is invisible
  // because the Worker stores it under /users/<id>/modified/ not
  // /users/<id>/<project>/.
  function _attachToCurrentProject(newPath, kind /* 'front'|'back' */) {
    if (!newPath) return;
    try {
      const projectName = window.state?.currentProject?.name;
      if (projectName) _appendCloudImages(projectName, [newPath], kind || 'front');
    } catch (_) { /* ignore */ }
  }
  function _appendCloudImages(projectName, urls, kind /* 'front'|'back'|'view' */) {
    try {
      const k = _imgKey(projectName);
      const arr = JSON.parse(localStorage.getItem(k) || '[]');
      for (const u of urls || []) arr.push({ path: u, kind, mtime: Date.now() });
      // Cap at 200 entries to keep localStorage sane.
      localStorage.setItem(k, JSON.stringify(arr.slice(-200)));
    } catch (_) {}
  }
  function _readCloudImages(projectName) {
    try { return JSON.parse(localStorage.getItem(_imgKey(projectName)) || '[]'); }
    catch (_) { return []; }
  }
  function _saveBackPhoto(projectName, frontUrl, backUrl) {
    try {
      const k = _backKey(projectName);
      const m = JSON.parse(localStorage.getItem(k) || '{}');
      m[frontUrl] = backUrl;
      localStorage.setItem(k, JSON.stringify(m));
    } catch (_) {}
  }
  function _readBackPhotos(projectName) {
    try { return JSON.parse(localStorage.getItem(_backKey(projectName)) || '{}'); }
    catch (_) { return {}; }
  }
  function _projectsFromLocalCache() {
    // Discover all project names we've cached locally.
    const names = new Set();
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i) || '';
        if (k.startsWith('myfm:cloudimages:')) names.add(k.slice('myfm:cloudimages:'.length));
      }
    } catch (_) {}
    return Array.from(names);
  }
  // Expose so other Cloud code can use them.
  window.__cloudImg = { append: _appendCloudImages, read: _readCloudImages,
                       saveBack: _saveBackPhoto, readBack: _readBackPhotos };

  Object.assign(impl, {
    /* ── projects / meshes (Worker-backed + localStorage cache) ──── */
    listImageFolders: async () => {
      let projects = [];
      try {
        const r = await getJSON('/api/cloud-projects');
        projects = Array.isArray(r) ? r : (r.projects || []);
      } catch (e) { log('listImageFolders failed:', e); }
      // Merge in projects that only exist in localStorage (just generated).
      const byName = new Map(projects.map(p => [p.name, p]));
      for (const localName of _projectsFromLocalCache()) {
        if (!byName.has(localName)) {
          byName.set(localName, { name: localName, images: [], imagesData: [], path: '', created: new Date().toISOString(), prompt: '', backPhotos: {} });
        }
      }
      return Array.from(byName.values()).map(p => {
        const local = _readCloudImages(p.name);
        const frontUrls = local.filter(x => x.kind === 'front' || x.kind === 'view').map(x => x.path);
        const backCache = _readBackPhotos(p.name);
        // Merge: server images first, then locally-cached ones we don't
        // already have. Dedup on URL.
        const seen = new Set(p.images || []);
        const merged = [...(p.images || [])];
        for (const u of frontUrls) if (!seen.has(u)) { seen.add(u); merged.push(u); }
        // Desktop convention: index2.js labels versions as
        // `v${images.length - 1 - i}`, expecting the most recent image at
        // i=0 (label = max version number). On desktop main.js sorts
        // folder entries by mtime DESC; cloud accumulates them push-order
        // (newest last) via _appendCloudImages. Reverse the merged list
        // so the freshest generation appears as vN, not v0.
        merged.reverse();
        return {
          name: p.name,
          path: p.path,
          images: merged,
          imagesData: p.imagesData || [],
          count: merged.length,
          // `created` is the LATEST activity timestamp for the project,
          // not the first one — the projects-home grid sorts on this so
          // a project that was just Modify'd / Auto-Inpainted should
          // float to the left. Picks the max(mtime) over every cached
          // local image, falling back to the server-side timestamp or
          // "now" for projects that have no local trace yet.
          created: (function () {
            let latest = 0;
            for (const x of local) {
              if (x && typeof x.mtime === 'number' && x.mtime > latest) latest = x.mtime;
            }
            if (latest > 0) return new Date(latest).toISOString();
            return p.created || new Date().toISOString();
          })(),
          // Prefer server-side prompt (from a mesh job's options); fall
          // back to the localStorage cache populated by generateImages.
          // Either source feeds the "Copy prompt" button in the UI.
          prompt: p.prompt || _readPrompt(p.name) || '',
          backPhotos: { ...(p.backPhotos || {}), ...backCache },
        };
      });
    },
    listMeshes: async () => {
      try {
        const r = await getJSON('/api/meshes');
        return Array.isArray(r) ? r : (r.meshes || []);
      } catch (e) { log('listMeshes failed:', e); return []; }
    },
    getMeshPath: async (filename) => {
      // In cloud "path" === URL. If the caller passed a job id (no
      // extension), fall back to a R2 lookup by id.
      if (!filename) return null;
      if (/^https?:|^blob:/i.test(filename)) return filename;
      // It's just a filename; consult the meshes list.
      try {
        const meshes = await impl.listMeshes();
        const m = meshes.find(x => x.filename === filename || x.id === filename);
        return m ? m.url : null;
      } catch (_) { return null; }
    },
    getMeshLocalUrl: async (filePath) => {
      if (!filePath) return null;
      if (/^https?:|^blob:/i.test(filePath)) return filePath;
      return await impl.getMeshPath(filePath);
    },
    readMeshFile: async (filePath) => {
      const url = await impl.getMeshLocalUrl(filePath);
      if (!url) return null;
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.arrayBuffer();
      } catch (e) { log('readMeshFile failed:', e); return null; }
    },
    deleteMesh: async (filenameOrId) => {
      // Resolve to a job id. The Worker accepts uuid, "<safe>_trellis2_<tail>"
      // slug, or "modal_<32hex>" R2 path stem — see _reconstructUuidFromSlug
      // in worker.ts. We strip any URL prefix, leading path segments, and
      // the file extension to give the worker the cleanest slug possible.
      let id = String(filenameOrId || '');
      // Drop "https://..." / "http://..." / "cloud://..." prefixes.
      id = id.replace(/^[a-z]+:\/\/[^/]+/i, '');
      // Drop everything before the last "/" (any leading path).
      const slash = id.lastIndexOf('/');
      if (slash >= 0) id = id.slice(slash + 1);
      // Strip extension.
      id = id.replace(/\.[^.]+$/, '');
      try { return await postJSON('/api/meshes/delete', { id }); }
      catch (e) { return { ok: false, error: String(e) }; }
    },
    deleteImageFolder: async (folderPath) => {
      // In cloud "folder" === project name. The renderer often passes
      // the path; strip "cloud://" or trailing slash.
      let name = String(folderPath || '');
      name = name.replace(/^cloud:\/\//, '').replace(/\/+$/, '');
      if (!name) return { ok: false, error: 'no project' };
      try { return await postJSON('/api/cloud-projects/delete', { projectName: name }); }
      catch (e) { return { ok: false, error: String(e) }; }
    },
    deleteFile: async (filePath) => {
      if (!filePath) return { ok: false };
      if (/\.(glb|gltf|fbx|obj|stl|ply)$/i.test(filePath)) {
        return impl.deleteMesh(_basename(filePath));
      }
      // Image versions: drop the URL from the project's localStorage
      // cache so reloadCurrentProject() stops returning it. We don't
      // delete the R2 blob — keeps undo cheap and the per-mesh-op
      // storage cost is tiny. Also remove the back-photo mapping if
      // this image had one attached.
      try {
        const projectName = window.state?.currentProject?.name;
        if (projectName) {
          const k = _imgKey(projectName);
          const arr = JSON.parse(localStorage.getItem(k) || '[]');
          const filtered = arr.filter(x => (x.path || x) !== filePath);
          localStorage.setItem(k, JSON.stringify(filtered));
          // Also clear any back-photo mapping that pointed to or from
          // this image so the FRONT/BACK bar doesn't show a ghost.
          const bk = _backKey(projectName);
          const bm = JSON.parse(localStorage.getItem(bk) || '{}');
          let changed = false;
          if (bm[filePath]) { delete bm[filePath]; changed = true; }
          for (const k2 of Object.keys(bm)) {
            if (bm[k2] === filePath) { delete bm[k2]; changed = true; }
          }
          if (changed) localStorage.setItem(bk, JSON.stringify(bm));
        }
        return { ok: true, success: true, cloud: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },

    /* ── thumbnails (localStorage) ──────────────────────────────── */
    saveThumbnail: async ({ meshPath, dataUrl } = {}) => {
      try {
        // Key by mesh URL/filename so reloading a project still finds
        // the thumb. Cap at ~256KB to avoid blowing the localStorage
        // quota — most PNG thumbs are already under that.
        const key = `myfm:thumb:${_basename(meshPath)}`;
        if (dataUrl && dataUrl.length < 262144) {
          localStorage.setItem(key, dataUrl);
        }
        return { ok: true };
      } catch (e) { return { ok: false, error: String(e) }; }
    },
    getThumbnail: async (meshPath) => {
      try { return localStorage.getItem(`myfm:thumb:${_basename(meshPath)}`) || null; }
      catch (_) { return null; }
    },

    /* ── file I/O (browser-native) ──────────────────────────────── */
    importImageFile: async (filePath) => {
      // Desktop: copy a file from disk into the project images dir.
      // Cloud: there's no disk. If `filePath` already looks like a
      // blob/dataURL/http URL we just register it; otherwise open a
      // file picker so the user can pick the actual file (the desktop
      // `importImage` path returned by `meshyAPI.importImage()` IS the
      // blob URL — we hand it straight through).
      if (filePath && /^(blob:|data:|https?:)/i.test(filePath)) {
        // Recover the original File (if any) we stashed in importImage()
        // so we get a real project name instead of an opaque blob URL.
        const stashed = (window.__cloudImportedFiles || {})[filePath];
        const name = stashed?.name || _basename(filePath) || 'imported.png';
        const pname = _stripExt(name) || 'imported';
        // Also cache it under that project so listImageFolders sees it.
        _appendCloudImages(pname, [filePath], 'front');
        return { ok: true, path: filePath, name, projectName: pname };
      }
      // Fallback: open picker.
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/png,image/jpeg,image/webp';
        input.onchange = () => {
          const f = input.files && input.files[0];
          if (!f) return resolve({ ok: false, cancelled: true });
          const url = URL.createObjectURL(f);
          resolve({ ok: true, path: url, name: f.name, projectName: _stripExt(f.name) || 'imported' });
        };
        input.click();
      });
    },
    pickExportPath: async ({ defaultName, format } = {}) => {
      // No filesystem in browser. Return a sentinel so the caller
      // proceeds with the in-memory export and the actual save is
      // triggered by exportMesh / exportImage via `<a download>`.
      const ext = (format || 'glb').replace('fbx_unreal', 'fbx');
      return {
        ok: true, canceled: false,
        path: `${defaultName || 'mesh'}.${ext}`,
        cloud: true,
      };
    },
    exportMesh: async ({ sourcePath, targetFormat, outputPath } = {}) => {
      try {
        const url = await impl.getMeshLocalUrl(sourcePath);
        if (!url) return { ok: false, error: 'mesh not found' };
        // In cloud we only have whatever Replicate produced (GLB).
        // For non-GLB targets we still hand the GLB bytes and let
        // the user know we can't transcode without Blender. Better
        // than failing silently.
        const r = await fetch(url);
        if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
        const blob = await r.blob();
        const baseName = _stripExt(_basename(outputPath || sourcePath || 'mesh'));
        const fmt = (targetFormat || 'glb').replace('fbx_unreal', 'fbx');
        const want = baseName + '.' + fmt;
        const note = (fmt !== 'glb');
        await _downloadBlobAs(blob, want);
        return {
          ok: true, success: true, outputPath: want, path: want,
          message: note ? 'Downloaded as GLB (Cloud has no transcoder yet — open in Blender to re-export as ' + fmt + ').' : 'Downloaded.',
        };
      } catch (e) { return { ok: false, error: String(e) }; }
    },
    exportImage: async ({ srcPath, defaultName } = {}) => {
      try {
        if (!srcPath) return { ok: false, error: 'no source' };
        const r = await fetch(srcPath);
        if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
        const blob = await r.blob();
        const name = (defaultName || _stripExt(_basename(srcPath)) || 'image') + (srcPath.match(/\.(png|jpg|jpeg|webp)/i) ? srcPath.match(/\.(png|jpg|jpeg|webp)/i)[0] : '.png');
        await _downloadBlobAs(blob, name);
        return { ok: true, path: name, downloaded: true };
      } catch (e) { return { ok: false, error: String(e) }; }
    },
    getFileInfo: async (filePath) => {
      if (!filePath) return { ok: false, error: 'no path' };
      try {
        // For blob: URLs we have to GET the whole thing to learn size.
        const head = await fetch(filePath, { method: 'HEAD' }).catch(() => null);
        if (head && head.ok) {
          const size = parseInt(head.headers.get('content-length') || '0', 10) || 0;
          return {
            ok: true,
            filename: _basename(filePath),
            path: filePath,
            sizeBytes: size,
            sizeHuman: size > 1048576 ? (size / 1048576).toFixed(1) + ' MB' : (size / 1024).toFixed(0) + ' KB',
            ext: (_basename(filePath).split('.').pop() || '').toLowerCase(),
          };
        }
        // Fallback (blob: URLs ignore HEAD on some browsers): full GET.
        const r = await fetch(filePath);
        const blob = await r.blob();
        return {
          ok: true,
          filename: _basename(filePath),
          path: filePath,
          sizeBytes: blob.size,
          sizeHuman: blob.size > 1048576 ? (blob.size / 1048576).toFixed(1) + ' MB' : (blob.size / 1024).toFixed(0) + ' KB',
          ext: (_basename(filePath).split('.').pop() || '').toLowerCase(),
        };
      } catch (e) { return { ok: false, error: String(e) }; }
    },

    /* ── client-side image editing (Canvas 2D) ──────────────────── */
    imageAdjust: async ({ imagePath, operation, params } = {}) => {
      try {
        const { canvas, ctx } = await _canvasFor(imagePath);
        const p = params || {};
        if (operation === 'auto_levels' || operation === 'auto_contrast') {
          // Simple histogram stretch on luminance.
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const data = img.data;
          let lo = 255, hi = 0;
          for (let i = 0; i < data.length; i += 4) {
            const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            if (y < lo) lo = y; if (y > hi) hi = y;
          }
          if (hi - lo > 1) {
            const scale = 255 / (hi - lo);
            for (let i = 0; i < data.length; i += 4) {
              data[i]     = Math.max(0, Math.min(255, (data[i]     - lo) * scale));
              data[i + 1] = Math.max(0, Math.min(255, (data[i + 1] - lo) * scale));
              data[i + 2] = Math.max(0, Math.min(255, (data[i + 2] - lo) * scale));
            }
            ctx.putImageData(img, 0, 0);
          }
        } else {
          // Brightness / contrast / saturation via canvas filter.
          const b = p.brightness != null ? p.brightness : 1.0;
          const c = p.contrast   != null ? p.contrast   : 1.0;
          const s = p.saturation != null ? p.saturation : 1.0;
          ctx.filter = `brightness(${b}) contrast(${c}) saturate(${s})`;
          const tmp = document.createElement('canvas');
          tmp.width = canvas.width; tmp.height = canvas.height;
          tmp.getContext('2d').drawImage(canvas, 0, 0);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(tmp, 0, 0);
          ctx.filter = 'none';
        }
        const newPath = await _canvasToBlobUrl(canvas);
        return { success: true, newPath };
      } catch (e) { return { success: false, error: String(e) }; }
    },
    imageQuickEdit: async ({ imagePath, operation, params } = {}) => {
      // Cloud override: 'upscale' routes to Modal SDXL refine pass for
      // a real AI upscale (instead of the desktop's pure-LANCZOS
      // canvas drawImage). Costs 2 credits at x2, 3 at x4. The
      // canvas-only operations (downscale, symmetrize, crop, brightness,
      // extend) stay local — they're instant and don't need GPU.
      if (operation === 'upscale' && imagePath) {
        try {
          const r = await postJSON('/api/upscale-image', { imageUrl: imagePath, scale: (params?.scale === 4 ? 4 : 2) });
          if (r?.success && (r.newPath || r.path)) {
            const newPath = r.newPath || r.path;
            _attachToCurrentProject(newPath, 'front');
            if (typeof window.__cloudCreditsRefresh === 'function') window.__cloudCreditsRefresh();
            return { success: true, newPath };
          }
          // Fall through to the canvas path on cloud upscale failure so
          // the user gets *something* (at worst the desktop's behaviour).
        } catch (_) { /* fall through */ }
      }
      try {
        const { canvas, ctx, img } = await _canvasFor(imagePath);
        const w = canvas.width, h = canvas.height;
        const p = params || {};
        let out = canvas;
        if (operation === 'upscale') {
          out = document.createElement('canvas');
          out.width = w * 2; out.height = h * 2;
          out.getContext('2d').drawImage(img, 0, 0, w * 2, h * 2);
        } else if (operation === 'downscale') {
          out = document.createElement('canvas');
          out.width = Math.max(1, w >> 1); out.height = Math.max(1, h >> 1);
          out.getContext('2d').drawImage(img, 0, 0, out.width, out.height);
        } else if (operation === 'symmetrize' || operation === 'symmetrize_right') {
          out = document.createElement('canvas');
          out.width = w; out.height = h;
          const c2 = out.getContext('2d');
          if (operation === 'symmetrize') {
            // Left half + mirrored left half.
            c2.drawImage(img, 0, 0, w / 2, h, 0, 0, w / 2, h);
            c2.save(); c2.scale(-1, 1);
            c2.drawImage(img, 0, 0, w / 2, h, -w, 0, w / 2, h);
            c2.restore();
          } else {
            // Right half + mirrored right half.
            c2.drawImage(img, w / 2, 0, w / 2, h, w / 2, 0, w / 2, h);
            c2.save(); c2.scale(-1, 1);
            c2.drawImage(img, w / 2, 0, w / 2, h, -(w / 2), 0, w / 2, h);
            c2.restore();
          }
        } else if (operation === 'crop') {
          const l = Math.floor(w * (p.left ?? 0));
          const t = Math.floor(h * (p.top ?? 0));
          const rg = Math.floor(w * (p.right ?? 1));
          const bg = Math.floor(h * (p.bottom ?? 1));
          out = document.createElement('canvas');
          out.width = Math.max(1, rg - l); out.height = Math.max(1, bg - t);
          out.getContext('2d').drawImage(img, l, t, out.width, out.height, 0, 0, out.width, out.height);
        } else if (operation === 'extend') {
          const pad = Math.floor(Math.max(w, h) * (p.padding ?? 0.2));
          out = document.createElement('canvas');
          out.width = w + pad * 2; out.height = h + pad * 2;
          const c2 = out.getContext('2d');
          c2.fillStyle = '#ffffff'; c2.fillRect(0, 0, out.width, out.height);
          c2.drawImage(img, pad, pad);
        } else if (operation === 'brightness') {
          ctx.filter = `brightness(${p.brightness ?? 1}) contrast(${p.contrast ?? 1}) saturate(${p.saturation ?? 1})`;
          const tmp = document.createElement('canvas');
          tmp.width = w; tmp.height = h;
          tmp.getContext('2d').drawImage(img, 0, 0);
          ctx.drawImage(tmp, 0, 0); ctx.filter = 'none';
          out = canvas;
        } else {
          return { success: false, error: 'Unknown operation: ' + operation };
        }
        const newPath = await _canvasToBlobUrl(out);
        _attachToCurrentProject(newPath, 'front');
        return { success: true, newPath };
      } catch (e) { return { success: false, error: String(e) }; }
    },

    /* ── image version history (localStorage) ───────────────────── */
    duplicateImageVersion: async ({ imagePath, suffix } = {}) => {
      try {
        const r = await fetch(imagePath);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const blob = await r.blob();
        const newPath = URL.createObjectURL(blob);
        // Track in the version list. The "project name" is derived from
        // the calling page; we don't have it here, so we use 'global'.
        _pushVersion('global', imagePath, newPath);
        const suf = (suffix || 'copy').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 16);
        return {
          success: true, path: newPath,
          filename: `${_stripExt(_basename(imagePath))}_${suf}_${Date.now()}.png`,
        };
      } catch (e) { return { success: false, error: String(e) }; }
    },
    listImageVersions: async (imagePath) => {
      try {
        const k = _versionsKey('global', _stripExt(_basename(imagePath)));
        const arr = JSON.parse(localStorage.getItem(k) || '[]');
        return arr.map(v => ({
          path: v.path, filename: _basename(v.path) || 'version.png',
          created: v.created, size: 0,
        }));
      } catch (_) { return []; }
    },
    revertImage: async ({ imagePath, versionPath } = {}) => {
      // No filesystem to overwrite — just return the version path so
      // the renderer can swap its in-memory pointer to it.
      void imagePath;
      return { success: true, ok: true, path: versionPath };
    },

    /* ── background removal (Worker / Replicate) ────────────────── */
    removeBackground: async (imagePathOrUrl) => {
      const imageUrl = imagePathOrUrl;
      // The Worker accepts JSON with imageUrl OR multipart with image=Blob.
      // Blob URLs aren't fetchable from Replicate, so we upload via
      // multipart when we don't have an http(s) URL.
      try {
        let r;
        if (/^https?:/i.test(imageUrl)) {
          r = await postJSON('/api/remove-background', { imageUrl });
        } else {
          // blob: or data: → POST as multipart so Replicate gets the bytes.
          const blob = await (await fetch(imageUrl)).blob();
          const fd = new FormData();
          fd.append('image', blob, 'src.png');
          r = await postForm('/api/remove-background', fd);
        }
        if (r?.success && (r.newPath || r.path)) {
          _attachToCurrentProject(r.newPath || r.path, 'front');
        }
        return r;
      } catch (e) { return { success: false, ok: false, error: String(e) }; }
    },

    /* ── BLIP-style captioning (Pollinations text endpoint) ─────── */
    captionImage: async ({ imagePath } = {}) => {
      // Pollinations text endpoint will happily generate a description
      // when nudged. Without vision support we fall back to a generic
      // hint so callers (back-view gen) still get *something*.
      void imagePath;
      try {
        // Conservative default the back-view caller can splice into its
        // prompt without making things worse.
        return { success: true, caption: 'wearing the same outfit as the front view' };
      } catch (e) { return { success: false, error: String(e) }; }
    },

    /* ── misc plumbing ──────────────────────────────────────────── */
    saveScreenshot: async ({ dataUrl, projectName } = {}) => {
      try {
        const name = `screenshot_${projectName || 'mesh'}_${Date.now()}.png`;
        if (dataUrl) {
          await _downloadBlobAs(dataUrl, name);
          return { ok: true, path: name };
        }
        // No dataUrl? Look for a known canvas in the workspace.
        const canvas = document.getElementById('ws-mesh-canvas') || document.querySelector('canvas');
        if (canvas) {
          return await new Promise((resolve) => {
            canvas.toBlob(async (blob) => {
              if (!blob) return resolve({ ok: false, error: 'canvas empty' });
              await _downloadBlobAs(blob, name);
              resolve({ ok: true, path: name });
            }, 'image/png');
          });
        }
        return { ok: false, error: 'no canvas / dataUrl' };
      } catch (e) { return { ok: false, error: String(e) }; }
    },
    getVersions: async (_name) => {
      // Desktop returns the project version history object. In cloud
      // we don't keep one — return the app version metadata instead so
      // callers that just want "what version is this?" still get an
      // answer.
      return {
        app: 'cloud-1.0.0-beta', git: 'cloud',
        // Shape compatible with renderer's mesh-history viewer:
        versions: [], currentVersion: -1,
      };
    },
    revertToVersion: async () => ({ ok: false, cloud: true, message: 'Version history is desktop-only.' }),

    cancelJob: async (jobId) => {
      try {
        if (!jobId) return { ok: true };
        return await postJSON('/api/jobs/cancel', { id: jobId });
      } catch (e) { return { ok: false, error: String(e) }; }
    },

    /* desktop-only helpers — explicit messages so users know why */
    refineMesh: async () => ({ success: false, ok: false, error: 'Mesh refine (Blender + Claude) is Desktop-only.' }),
    stopSdxlServer: async () => ({ ok: true }),
    checkMultiviewDir: async () => ({ ok: true, exists: false, files: [] }),
    img2img: async ({ imagePath, prompt, strength } = {}) => {
      // Cloud port of the desktop /img2img IPC handler (main.js:2874).
      // Worker POSTs to MODAL_MODIFY_URL with imageUrl + prompt + strength
      // and returns the URL of the freshly written R2 PNG. We expose the
      // same { success, newPath } shape so the renderer's `Modify Image`
      // button works unchanged.
      if (!imagePath) return { success: false, error: 'imagePath required' };
      if (!prompt)    return { success: false, error: 'prompt required' };
      try {
        const r = await postJSON('/api/modify-image', {
          imageUrl: imagePath, prompt, strength: strength ?? 0.55,
        });
        if (r?.success && (r.newPath || r.path)) {
          const newPath = r.newPath || r.path;
          _attachToCurrentProject(newPath, 'front');
          if (typeof window.__cloudCreditsRefresh === 'function') window.__cloudCreditsRefresh();
          return { success: true, newPath };
        }
        return { success: false, error: r?.error || 'unknown' };
      } catch (e) { return { success: false, error: String(e) }; }
    },
    autoInpaint: async ({ imagePath, targetText, prompt, dilate } = {}) => {
      // Cloud port of the desktop /auto-inpaint IPC handler
      // (main.js:2824). CLIPSeg detects the area + SDXL Inpaint paints
      // the new content. Returns { success, newPath } so the renderer
      // can drop the result back into the version strip unchanged.
      if (!imagePath)  return { success: false, error: 'imagePath required' };
      if (!targetText) return { success: false, error: 'targetText required' };
      try {
        const r = await postJSON('/api/auto-inpaint', {
          imageUrl: imagePath, targetText, prompt: prompt || '', dilate: dilate || 15,
        });
        if (r?.success && (r.newPath || r.path)) {
          const newPath = r.newPath || r.path;
          _attachToCurrentProject(newPath, 'front');
          if (typeof window.__cloudCreditsRefresh === 'function') window.__cloudCreditsRefresh();
          return { success: true, newPath };
        }
        return { success: false, error: r?.error || 'unknown' };
      } catch (e) { return { success: false, error: String(e) }; }
    },
    maskInpaint: async ({ imagePath, maskDataUrl, prompt } = {}) => {
      // Cloud port of the desktop /mask-inpaint IPC (main.js:2790).
      // Frontend sends image URL + base64 mask + prompt; Worker
      // decodes the mask, uploads it to R2, and forwards to Modal's
      // image_op endpoint with op='mask_inpaint'.
      if (!imagePath)   return { success: false, error: 'imagePath required' };
      if (!maskDataUrl) return { success: false, error: 'maskDataUrl required' };
      if (!prompt)      return { success: false, error: 'prompt required' };
      try {
        const r = await postJSON('/api/mask-inpaint', { imageUrl: imagePath, maskDataUrl, prompt });
        if (r?.success && (r.newPath || r.path)) {
          const newPath = r.newPath || r.path;
          _attachToCurrentProject(newPath, 'front');
          if (typeof window.__cloudCreditsRefresh === 'function') window.__cloudCreditsRefresh();
          return { success: true, newPath };
        }
        return { success: false, error: r?.error || 'unknown' };
      } catch (e) { return { success: false, error: String(e) }; }
    },
    // Image-level Face Fix (NOT the 3D atlas one). OpenCV Haar Cascade
    // → SDXL Inpaint over the face bbox. Was a stub before Wave 3.
    faceFixImage: async ({ imagePath, strength } = {}) => {
      if (!imagePath) return { success: false, error: 'imagePath required' };
      try {
        const r = await postJSON('/api/face-fix-image', { imageUrl: imagePath, strength });
        if (r?.success && (r.newPath || r.path)) {
          const newPath = r.newPath || r.path;
          _attachToCurrentProject(newPath, 'front');
          if (typeof window.__cloudCreditsRefresh === 'function') window.__cloudCreditsRefresh();
          return { success: true, newPath };
        }
        return { success: false, error: r?.error || 'unknown' };
      } catch (e) { return { success: false, error: String(e) }; }
    },
    copyMeshToProject: async ({ meshPath, meshUrl, meshId, targetProject, projectName } = {}) => {
      // Cloud port — backed by /api/copy-mesh-to-project. In the cloud
      // DB model a project is just a `project_name` field on jobs, so
      // copying is a 0-cost INSERT pointing at the same R2 mesh URL.
      const target = targetProject || projectName;
      if (!target) return { ok: false, error: 'targetProject required' };
      const body = { meshUrl: meshUrl || meshPath, meshId, targetProject: target };
      try {
        const r = await postJSON('/api/copy-mesh-to-project', body);
        if (r?.success) return { ok: true, id: r.id, project_name: r.project_name };
        return { ok: false, error: r?.error || 'unknown' };
      } catch (e) { return { ok: false, error: String(e) }; }
    },
    createProjectFromMesh: async ({ meshPath, meshUrl, meshId, projectName, name } = {}) => {
      // Same endpoint as copyMeshToProject — semantically "create a new
      // project from this mesh" is just copyMeshToProject with a
      // brand-new project_name. The user-facing distinction (the
      // desktop renderer has separate buttons) is preserved at the API
      // level so future divergence is easy.
      const target = projectName || name;
      if (!target) return { ok: false, error: 'projectName required' };
      const body = { meshUrl: meshUrl || meshPath, meshId, targetProject: target };
      try {
        const r = await postJSON('/api/copy-mesh-to-project', body);
        if (r?.success) return { ok: true, cloud: true, id: r.id, project_name: r.project_name };
        return { ok: false, error: r?.error || 'unknown' };
      } catch (e) { return { ok: false, error: String(e) }; }
    },
    exportToUnreal: async ({ sourcePath } = {}) => {
      // Best-effort: just download the GLB so the user can manually
      // drag-drop it into Unreal. Real FBX-for-Unreal export requires
      // Blender (Desktop-only).
      return impl.exportMesh({ sourcePath, targetFormat: 'glb' });
    },
    // Auto-rig AI via Puppeteer on Modal — async spawn + poll.
    //
    // The Worker no longer waits for the rig to finish (CF subrequest
    // cap = 100 s, rig takes ~120-150 s on A10G + cold start). Flow:
    //   1. POST /api/auto-rig → { job_id, status: 'queued' } in <2 s.
    //   2. Poll GET /api/auto-rig-status?job_id=… every 5 s.
    //      The Worker returns 'pending' until Modal writes either an
    //      error file or the rigged GLB to its Volume. On 'done' it
    //      uploads the GLB to R2 and returns the public URL.
    //
    // Same return contract as the desktop bridge:
    //   { success, ok, glb_url, path, error? }
    // so callers can hot-swap the mesh in the viewer without knowing
    // anything changed under the hood.
    autoRigAI: async ({ meshPath, meshUrl, engine, skeleton, onProgress } = {}) => {
      const url = meshUrl || meshPath;
      if (!url) return { success: false, ok: false, error: 'meshPath or meshUrl required' };

      // ── 1. Spawn ──
      let jobId;
      try {
        const spawn = await postJSON('/api/auto-rig', {
          mesh_url: url, skeleton: skeleton || 'orc_m1', engine: engine || 'puppeteer',
        });
        if (typeof window.__cloudCreditsRefresh === 'function') window.__cloudCreditsRefresh();
        if (!spawn?.success || !spawn?.job_id) {
          return { success: false, ok: false, error: spawn?.error || 'auto-rig spawn failed' };
        }
        jobId = String(spawn.job_id);
      } catch (e) {
        return { success: false, ok: false, error: e?.message || String(e) };
      }

      // Register the job in localStorage so a page reload can pick it up.
      // Without this, refreshing during a 5-15 min poll strands the rig:
      // the GLB still lands in R2 but the active UI never gets the "done"
      // handoff (the closure is gone) — the user's only recovery is to
      // open the project later when /api/meshes lists the rigged file.
      try {
        const pending = JSON.parse(localStorage.getItem('fabmesh_pending_rigs') || '[]');
        const projectId = window.state?.currentProject?.id || null;
        const projectName = window.state?.currentProject?.name || null;
        pending.push({ jobId, projectId, projectName, meshUrl: url, createdAt: Date.now() });
        localStorage.setItem('fabmesh_pending_rigs', JSON.stringify(pending.slice(-10)));
      } catch (e) { /* localStorage may be disabled */ }

      const clearPending = () => {
        try {
          const pending = JSON.parse(localStorage.getItem('fabmesh_pending_rigs') || '[]');
          const filtered = pending.filter(p => p.jobId !== jobId);
          localStorage.setItem('fabmesh_pending_rigs', JSON.stringify(filtered));
        } catch (e) { /* ignore */ }
      };

      // ── 2. Poll ──
      // 5 s cadence × 180 polls = 15 min hard cap. Typical rig is ~2
      // min hot / 4-6 min cold start. Empirically a dense-mesh rig with
      // unlucky Modal queue can exceed 10 min — 15 min is the new ceiling.
      const POLL_INTERVAL_MS = 5000;
      const MAX_POLLS = 180;
      const MAX_CONSECUTIVE_AUTH_ERRORS = 3;  // abort on 401/403 streak (session expired)
      const MAX_CONSECUTIVE_SERVER_ERRORS = 6; // abort on 5xx streak (Worker truly down)
      const t0 = Date.now();
      let consecutiveAuthErrors = 0;
      let consecutiveServerErrors = 0;
      let lastWarn = null;
      for (let i = 0; i < MAX_POLLS; i++) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        let st;
        let httpStatus = 0;
        try {
          const resp = await fetch(
            `/api/auto-rig-status?job_id=${encodeURIComponent(jobId)}`,
            { method: 'GET', credentials: 'same-origin' },
          );
          httpStatus = resp.status;
          if (!resp.ok) {
            console.warn(`[auto-rig] status HTTP ${resp.status} poll=${i + 1}`);
            lastWarn = `HTTP ${resp.status}`;
            // Auth errors: session expired during the long poll. Abort
            // early with a typed error so the caller can prompt re-login
            // instead of burning the full 15 min.
            if (resp.status === 401 || resp.status === 403) {
              consecutiveAuthErrors++;
              if (consecutiveAuthErrors >= MAX_CONSECUTIVE_AUTH_ERRORS) {
                clearPending();
                return {
                  success: false, ok: false,
                  error: 'session expired during auto-rig — please log in and check Projects (the rig may have completed and be visible there)',
                  authLost: true,
                };
              }
            } else if (resp.status >= 500) {
              consecutiveServerErrors++;
              if (consecutiveServerErrors >= MAX_CONSECUTIVE_SERVER_ERRORS) {
                clearPending();
                return {
                  success: false, ok: false,
                  error: `Cloudflare Worker returned ${resp.status} on ${MAX_CONSECUTIVE_SERVER_ERRORS} consecutive polls — backend unreachable`,
                };
              }
            }
            if (typeof onProgress === 'function') {
              try { onProgress({ polls: i + 1, elapsedMs: Date.now() - t0, lastWarn }); } catch {}
            }
            continue;
          }
          consecutiveAuthErrors = 0;
          consecutiveServerErrors = 0;
          st = await resp.json();
        } catch (e) {
          console.warn(`[auto-rig] status fetch threw poll=${i + 1}`, e);
          lastWarn = e?.message || String(e);
          if (typeof onProgress === 'function') {
            try { onProgress({ polls: i + 1, elapsedMs: Date.now() - t0, lastWarn }); } catch {}
          }
          continue;
        }

        if (st?.status === 'pending') {
          if (st.warn || st.last_error) lastWarn = st.warn || st.last_error;
          if (typeof onProgress === 'function') {
            try { onProgress({ polls: i + 1, elapsedMs: Date.now() - t0, lastWarn }); } catch {}
          }
          continue;
        }
        if (st?.status === 'failed') {
          clearPending();
          if (typeof window.__cloudCreditsRefresh === 'function') window.__cloudCreditsRefresh();
          return { success: false, ok: false, error: st.error || 'auto-rig failed' };
        }
        if (st?.status === 'done') {
          clearPending();
          const glbUrl = st.mesh_url || st.url || st.path || null;
          if (!glbUrl) {
            return { success: false, ok: false, error: 'auto-rig done but no URL returned' };
          }
          // Force-push the new rig into state so the workspace re-renders
          // immediately, even if reloadCurrentProject doesn't pick it up
          // from /api/meshes (browser cache, stale state, etc.).
          try {
            if (window.state?.currentProject) {
              const filename = glbUrl.split('/').pop() || 'rigged_puppeteer.glb';
              window.state.currentProject.rigs = window.state.currentProject.rigs || [];
              const already = window.state.currentProject.rigs.some(r => r.url === glbUrl);
              if (!already) {
                window.state.currentProject.rigs.push({
                  filename, url: glbUrl, path: glbUrl,
                  asset_type: 'rig', size: 0, created: new Date().toISOString(),
                });
              }
            } else {
              // Project switched mid-rig — fire a dom event so anyone listening
              // (page-load resume handler, projects list) can pick it up. The
              // GLB is already in R2 so /api/meshes will list it on next load.
              try {
                window.dispatchEvent(new CustomEvent('fabmesh:rig-done-orphan', {
                  detail: { jobId, glbUrl },
                }));
              } catch (e) { /* ignore */ }
              console.warn('[auto-rig] done but no currentProject — dispatched fabmesh:rig-done-orphan');
            }
          } catch (e) { console.warn('[auto-rig] state push failed:', e); }
          return { success: true, ok: true, glb_url: glbUrl, path: glbUrl };
        }
        // Unknown status — log and keep polling, but expose to caller via lastWarn.
        console.warn(`[auto-rig] unexpected status poll=${i + 1}`, st);
        lastWarn = `unexpected status: ${JSON.stringify(st).slice(0, 80)}`;
        if (typeof onProgress === 'function') {
          try { onProgress({ polls: i + 1, elapsedMs: Date.now() - t0, lastWarn }); } catch {}
        }
      }

      clearPending();
      return {
        success: false, ok: false,
        error: `auto-rig timeout after ${MAX_POLLS} polls (${Math.round((Date.now() - t0) / 1000)} s) — the rig may have completed; refresh Projects to check.`,
      };
    },
    // CPU mesh quick edits via /api/mesh-op → trimesh on Modal.
    // Supports: smooth, decimate, center, fix_normals, fill_holes.
    // Anything else returns Desktop-only (Blender etc.).
    meshTool: async ({ operation, meshPath, meshUrl, meshId, imagePath, params } = {}) => {
      // 'retexture' is the desktop's quick re-texture (UV reproject via
      // Blender). Cloud has no Blender → we do a best-effort
      // baseColorTexture swap, which works when the new image was
      // derived from the original front view (Modify/Style/AutoInpaint
      // output etc.). The new image URL is the imagePath arg.
      const opMap = {
        'retexture': 'retex_swap',
      };
      const realOp = opMap[operation] || operation;
      const CLOUD_OPS = new Set([
        'smooth', 'decimate', 'center', 'fix_normals', 'fill_holes',
        'subdivide', 'align_texture', 'material', 'retex_swap',
      ]);
      // 'trellis2_retex' = full TRELLIS-2 retexture. On cloud we don't
      // have a texture-only pipeline; the closest equivalent is to
      // re-generate the mesh from the same image with the same prompt
      // — same effective output (new texture from same input). Wire
      // that explicit redirect here so the button isn't a stub.
      if (operation === 'trellis2_retex') {
        return { success: false, ok: false,
          error: 'Re-Texture (MyFabmesh.AI 3D Native) on cloud uses the standard "Generate 3D" path — please use the Image step\'s Modify/Style tool to change the source, then click Generate 3D to re-bake.' };
      }
      if (!CLOUD_OPS.has(realOp)) {
        return { success: false, ok: false,
          error: `mesh op '${operation}' is Desktop-only on cloud (advanced mesh editor / Auto-rig / sculpt required).` };
      }
      const url = meshUrl || meshPath;
      if (!url && !meshId) return { success: false, error: 'meshPath, meshUrl or meshId required' };
      // Normalize params → named object matching modal_app/_mesh_op.py
      // contract. The renderer's MESH_TOOL_SCHEMAS[*].build(vals) returns
      // a POSITIONAL array (e.g. smooth → ["5","0.5"]); `Object.assign({},
      // arr)` produced {0:"5",1:"0.5"} which Modal silently ignored, so
      // sliders were no-ops while still burning 1 credit. Map by op
      // explicitly here. If a caller already passes a named object
      // (Object, non-array), pass it through as-is.
      let finalParams;
      if (Array.isArray(params)) {
        const a = params;
        switch (realOp) {
          case 'smooth':
            // build → [iterations, lambda]; Modal reads `iterations` + `lamb`
            finalParams = {};
            if (a[0] != null) finalParams.iterations = Number(a[0]);
            if (a[1] != null) finalParams.lamb = Number(a[1]);
            break;
          case 'decimate':
            // build → [target_faces]
            finalParams = {};
            if (a[0] != null) finalParams.target_faces = Number(a[0]);
            break;
          case 'subdivide':
            // build → [levels]; Modal reads `iterations`
            finalParams = {};
            if (a[0] != null) finalParams.iterations = Number(a[0]);
            break;
          case 'retex_swap':
            // build (retexture) → [image_url] or empty; fall back to
            // imagePath arg below.
            finalParams = {};
            if (a[0]) finalParams.image_url = String(a[0]);
            break;
          // center/fix_normals/fill_holes/align_texture/material take
          // no params on the Modal side — drop positional values.
          default:
            finalParams = {};
            break;
        }
      } else {
        finalParams = Object.assign({}, params || {});
      }
      if (realOp === 'retex_swap' && !finalParams.image_url) {
        if (!imagePath) return { success: false, error: 'imagePath required for retexture' };
        finalParams.image_url = imagePath;
      }
      try {
        const r = await postJSON('/api/mesh-op', {
          meshUrl: url, meshId, opType: realOp, params: finalParams,
        });
        if (r?.success && (r.path || r.newPath || r.mesh_url)) {
          if (typeof window.__cloudCreditsRefresh === 'function') window.__cloudCreditsRefresh();
          return { success: true, newPath: r.path || r.newPath || r.mesh_url };
        }
        return { success: false, error: r?.error || 'unknown' };
      } catch (e) { return { success: false, error: String(e) }; }
    },
  });

  /* ──────────────────────────────────────────────────────────────────
   * STUBS — still desktop-only. Listed so the renderer can call them
   * without crashing on `meshyAPI.xxx is not a function`.
   * Most return an empty array (list-like) or `{ ok:false, ... }`.
   * ────────────────────────────────────────────────────────────────── */
  const STUBS = [
    // Wizard / installer (no installer in cloud)
    'reconfigureFabmesh', 'uninstallFabmesh',
    // Claude Desktop MCP bridge
    'connectClaudeDesktop', 'disconnectClaudeDesktop', 'checkClaudeDesktop',
    // Internal config tools
    'getControlApiToken',
    // Blender pipeline (no Blender in cloud)
    'setBlenderPath', 'runBlenderScript', 'openInBlender',
    'materialAdjust', 'alignTexture',
    // Calibration (Desktop diagnostics tool)
    'calibRun', 'calibLastReport', 'calibOpenReport', 'calibListReports',
    'calibDiagnose', 'calibTiered', 'calibV3', 'calibCancel',
    'calibReadLog', 'calibClearLog',
    // UniRig + landmarks (Desktop-only for now). autoRigAI is wired
    // above to /api/auto-rig (Puppeteer on Modal) — keep it OUT of
    // the stubs list so the real implementation isn't overwritten.
    'autoRig', 'listRigTemplates', 'listRigAnimations',
    'saveLandmarks', 'loadLandmarks', 'analyzeSkeleton',
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
  // Resume any mesh job a previous tab left behind. Delayed so the
  // renderer has time to wire pushJob / reloadCurrentProject onto
  // window before we fire pollPrediction.
  setTimeout(() => { try { resumePendingJobs(); } catch (e) { console.warn('[cloud] resume failed:', e); } }, 1500);
})();
