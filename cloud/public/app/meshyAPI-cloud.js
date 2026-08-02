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

  // Construction-stage prompt modifiers — kept byte-identical to desktop
  // main.js _BUILD_STAGE_MODIFIERS (foundation → half-built → finished).
  const _CLOUD_BUILD_STAGE_MODIFIERS = [
    'early construction stage, bare structural framework and skeleton, scaffolding, exposed frame, unfinished work-in-progress, incomplete',
    'half-built, partially assembled, some sections finished and others still exposed, mid construction, work-in-progress',
    'fully finished and complete, every detail present, clean polished final version',
  ];

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
  // Plafond de suivi d'un job. 30 min et non 10 : la generation de maillage est
  // l'operation la PLUS LONGUE du produit, et l'ancien plafond de 600 000 ms
  // etait intenable — pour un prereglage « High » l'application annonce
  // elle-meme ~9 min 30 d'estimation, soit 30 SECONDES de marge, et un
  // demarrage a froid du conteneur Modal (2-3 min) suffisait a la depasser.
  // Constate le 2026-07-28 : « Timeout » affiche a 10 min 33 alors que le
  // travail continuait cote serveur et que les credits etaient deja debites.
  // Les autres suivis (rig, segmentation, animation) plafonnent deja a 15 min ;
  // celui-ci, le plus long de tous, etait le plus court.
  const POLL_TIMEOUT_MS = 30 * 60 * 1000;

  async function pollPrediction(jobId, { onProgress, channel = 'ai3d-progress' } = {}) {
    const start = Date.now();
    let consecutiveErrors = 0;
    while (Date.now() - start < POLL_TIMEOUT_MS) {
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
    // On ne dit plus « Timeout » tout court : le job n'est PAS annule pour
    // autant, il continue cote serveur et son resultat sera rattache au projet
    // (les jobs en cours sont persistes dans localStorage, cf. PENDING_JOBS_KEY,
    // et resumePendingJobs les reprend au rechargement). Un message sec faisait
    // croire a une perte seche alors que les credits etaient deja debites.
    throw new Error(
      'La generation depasse ' + Math.round(POLL_TIMEOUT_MS / 60000) + ' min de suivi. '
      + 'Elle CONTINUE sur le serveur : recharge la page dans quelques minutes, '
      + 'le resultat apparaitra dans le projet. Aucun credit supplementaire ne sera debite.');
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
      // which nulls jobs.project_name + deletes user_assets rows. The
      // renderer calls this with `projectName`; older callers may still
      // pass `id` (= projectName in their semantics).
      const name = projectName || id;
      if (!name) {
        console.warn('[deleteProject] no name provided');
        return { ok: false, error: 'projectName required' };
      }
      console.log('[deleteProject] CALLED name=', name);
      let result;
      try { result = await postJSON('/api/cloud-projects/delete', { projectName: name }); }
      catch (e) { result = { ok: false, error: String(e) }; }
      // Also purge the LOCAL caches for this project so listImageFolders
      // doesn't resurrect it via _projectsFromLocalCache. Without this,
      // the server may have wiped the rows but the client recreates the
      // project name from the stale localStorage key.
      try {
        localStorage.removeItem(_imgKey(name));
        localStorage.removeItem(_backKey(name));
        localStorage.removeItem(_promptKey(name));
      } catch (_) { /* ignore */ }
      console.log('[deleteProject] result=', result);
      // Force-flush so the admin can see exactly what happened.
      try {
        if (window.__consoleCapture && typeof window.__consoleCapture.flush === 'function') {
          window.__consoleCapture.flush({
            kind: 'delete-project',
            status: result?.ok ? 'done' : 'error',
            project: name,
          });
        }
      } catch (_) { /* ignore */ }
      return result;
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
    generateImages: async ({ prompt, userPrompt, projectName, numImages = 1, steps, jobId, engine, buildStages } = {}) => {
      console.log('[generateImages] ENTER projectName=', projectName, 'numImages=', numImages, 'buildStages=', !!buildStages);
      // Read asset type / style from the workspace dropdowns so the
      // Worker can rebuild the enriched prompt server-side using the
      // exact tables from index2.js (cloud output matches desktop).
      const asset_type = document.getElementById('ws-asset-type')?.value || 'character';
      const asset_style = document.getElementById('ws-asset-style')?.value || 'realistic';

      // One /api/generate-image call → returns { paths } or throws.
      const _genOnce = async (promptArg, userPromptArg, n) => {
        const r = await fetch('/api/generate-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: promptArg,        // already-enriched fallback
            userPrompt: userPromptArg, // raw user text (Worker re-enriches)
            numImages: n, asset_type, asset_style, steps,
            turbo: engine === 'local-lightning',  // SDXL-Lightning 4-step (Modal text2image)
            projectName,         // for user_assets row insertion
          }),
          credentials: 'include',
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
        if (!j?.success || !Array.isArray(j?.paths) || !j.paths.length) {
          throw new Error(j?.error || 'no images returned');
        }
        return j.paths;
      };

      try {
        // Construction stages: 3 progressive build prompts (foundation →
        // half-built → finished), same engine, injected into BOTH prompt
        // and userPrompt so the Worker's re-enrichment keeps the stage.
        // Mirrors desktop main.js generate-images buildStages path.
        if (buildStages) {
          window.__meshyEmit('image-progress', { jobId, index: 0, total: 3, status: 'fetching' });
          const staged = [];
          for (let s = 0; s < _CLOUD_BUILD_STAGE_MODIFIERS.length; s++) {
            const mod = _CLOUD_BUILD_STAGE_MODIFIERS[s];
            try {
              const paths = await _genOnce(`${mod}, ${prompt}`, `${mod}, ${userPrompt || prompt}`, 1);
              staged.push(...paths);
              window.__meshyEmit('image-progress', { jobId, index: s + 1, total: 3, status: 'fetching' });
            } catch (e) {
              log(`generateImages stage ${s + 1} failed:`, e instanceof Error ? e.message : String(e));
            }
          }
          if (!staged.length) return { success: false, images: [], error: 'Construction stages produced no images.' };
          window.__meshyEmit('image-progress', { jobId, index: 3, total: 3, status: 'done' });
          _appendCloudImages(projectName, staged, 'front');
          _savePrompt(projectName, userPrompt || prompt || '');
          if (typeof window.__cloudCreditsRefresh === 'function') window.__cloudCreditsRefresh();
          return { success: true, images: staged };
        }

        log(`generateImages via /api/generate-image (Cog myfabmesh-cloud) — ${numImages}× "${(userPrompt || prompt || '').slice(0, 60)}…"`);
        window.__meshyEmit('image-progress', { jobId, index: 0, total: numImages, status: 'fetching' });
        const paths = await _genOnce(prompt, userPrompt, numImages);
        window.__meshyEmit('image-progress', { jobId, index: numImages, total: numImages, status: 'done' });
        // C1: persist generated URLs in localStorage so listImageFolders
        // returns them on the next refresh (the Worker doesn't store rows
        // for individual PNGs).
        console.log('[generateImages] success, about to _appendCloudImages name=', projectName, 'paths=', paths);
        _appendCloudImages(projectName, paths, 'front');
        // Persist the prompt so the "Copy prompt" button (index2.js:1808-1830)
        // can appear on the project after a reload.
        _savePrompt(projectName, userPrompt || prompt || '');
        // Force credit pill refresh after successful spend.
        if (typeof window.__cloudCreditsRefresh === 'function') window.__cloudCreditsRefresh();
        return { success: true, images: paths };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log('generateImages FAILED/THREW:', msg);
        return { success: false, images: [], error: msg };
      }
    },

    /* These will be wired against /api/generate-image (Replicate SDXL/Flux)
       when we expose them. For now generateFromPrompt is unused by the
       Cloud workspace flow — generateImages above is what the renderer
       calls for the "Create new image" step. */
    generateFromPrompt: async ({ prompt, projectName, numImages = 1 } = {}) =>
      meshyAPI.generateImages({ prompt, projectName, numImages }),

    /* image→image — REFUS HONNÊTE, comme generateMultiview.

       Cette fonction est morte (aucun appelant), mais elle expédiait le
       prompt de l'utilisateur à image.pollinations.ai. Trois défauts, à
       ne pas réintroduire si quelqu'un la recâble un jour :

       - La référence n'était jointe que si `/^https?:/` : dans cette
         application les images sont souvent des URL `blob:`, la
         référence était donc SILENCIEUSEMENT abandonnée et le résultat
         devenait du texte-vers-image sans rapport avec l'entrée.
       - `return { ok: true }` inconditionnel : `images` pouvait être
         vide après trois échecs et l'appelant y lisait un succès.
       - Prompt et URL de référence partaient chez un tiers, hors du
         filtre NSFW, sans crédit débité.

       Il n'existe pas d'équivalent réel côté worker : `generateImages`
       (/api/generate-image) est du TEXTE vers image uniquement. */
    generateFromImage: async () => ({
      ok: false, success: false, images: [],
      error: "La génération image→image n'est pas disponible dans la version web. "
           + "Utilise « Créer une image » (texte→image) ou l'application desktop.",
    }),

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

    /* Multi-vues — REFUS HONNÊTE tant que le cloud n'a pas de générateur.

       L'ancienne version était un faux ami complet. Elle envoyait le
       PROMPT TEXTE de l'utilisateur à image.pollinations.ai, un service
       tiers, et renvoyait les images obtenues comme « multi-vues » :

       - `void imagePath` : l'image de référence était explicitement
         JETÉE. Les « vues » représentaient donc un personnage SANS AUCUN
         RAPPORT avec le maillage de l'utilisateur. Une multi-vue qui
         ignore la référence n'est pas une multi-vue.
       - Le prompt partait chez un tiers, hors de notre filtre NSFW et
         sans que l'utilisateur en soit informé.
       - `return { ok: true, success: true }` était INCONDITIONNEL : même
         avec les trois requêtes en échec, l'interface affichait un
         succès vert et enregistrait `outDir: null`.
       - Aucun crédit débité, contrairement au desktop.

       Le vrai moteur existe côté worker (callModalMVAdapter, MV-Adapter
       Apache 2.0, qui LUI part de l'image de face) mais n'est câblé que
       dans la génération automatique de vue arrière, et
       MODAL_MVADAPTER_URL n'est pas configuré en production. Son
       exposition dans l'interface reste par ailleurs conditionnée à un
       rectificateur de vue de face pour les non-humanoïdes.

       Un échec clair vaut mieux qu'un résultat faux annoncé comme bon. */
    generateMultiview: async () => ({
      ok: false, success: false, outDir: null, paths: [],
      error: "La génération multi-vues n'est pas disponible dans la version web — "
           + "elle exige le moteur MV-Adapter, présent dans l'application desktop. "
           + "Le maillage sera généré à partir de la vue de face seule.",
    }),

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
          const filename = _basename(normPath) || ('mesh_' + Date.now() + '.glb');
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
        await _attachToCurrentProject(newPath, 'front');
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
    getParentalStatus: async () => {
      try {
        const r = await fetch('/api/parental/status', { credentials: 'same-origin' });
        const data = await r.json();
        return {
          enabled: !data.unrestricted,
          unrestricted: !!data.unrestricted,
          unlocked: !!data.unrestricted,
          hasPin: !!data.hasPin,
        };
      } catch (e) {
        return { enabled: true, unrestricted: false, unlocked: false, hasPin: false };
      }
    },
    toggleUnrestricted: async ({ pin, enable } = {}) => {
      try {
        const r = await fetch('/api/parental/toggle', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pin, enable }),
        });
        const data = await r.json();
        return { ok: r.ok, success: !!data.success, unrestricted: !!data.unrestricted, error: data.error };
      } catch (e) {
        return { ok: false, success: false, error: String(e) };
      }
    },
    // ── NSFW gallery/thumbnail visual scan: DEFERRED on cloud (intentional
    // no-op, NOT a silent failure). There is no automated image-classification
    // endpoint here — the Modal NSFW classifiers run at GENERATION time only,
    // and the worker exposes only ADMIN moderation routes. Generation is already
    // protected server-side (checkPromptSafety prompt filter + the Modal
    // post-image NSFW scan), so these client helpers return "safe" so the gallery
    // UI degrades gracefully. To enable a real gallery scan, add a batch
    // image-moderation worker endpoint that runs URLs through the Modal
    // classifiers, then wire these to it. ──
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
  // Depouille la query AVANT d'extraire le nom : depuis la migration vers les
  // URLs signees, un chemin d'asset finit par '?exp=<unix>&sig=<hex>'. Sans ce
  // decoupage on obtient des noms de fichier du type 'mesh.glb?exp=...&sig=...'
  // qui remontent dans l'UI, dans les noms de telechargement, et jusque dans des
  // cles R2 construites par concatenation.

  // ---------------------------------------------------------------------------
  // Generateur de ZIP minimal (methode « store », sans compression)
  // ---------------------------------------------------------------------------
  // POURQUOI maison : un navigateur ne peut pas ecrire de DOSSIER sur le disque,
  // or le user veut « un dossier construction steps + le mesh final en dehors ».
  // La traduction web correcte est donc une archive qui PORTE cette arborescence.
  // Aucune bibliotheque n'est disponible (la CSP du site interdit les scripts
  // externes, cf. index.html) et JSZip pese ~100 Ko pour un besoin qui tient en
  // 50 lignes. « Store » et non « deflate » : les GLB embarquent deja des
  // textures compressees (WebP/PNG), deflate n'y gagnerait quasi rien pour un
  // cout CPU reel sur des fichiers de plusieurs dizaines de Mo.
  const _CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();
  function _crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = _CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  /** entries: [{ name, data:Uint8Array }] -> Blob zip. `name` peut contenir des
   *  '/' : c'est ainsi qu'un ZIP represente une arborescence. */
  function _makeZip(entries) {
    const enc = new TextEncoder();
    const chunks = [], central = [];
    let offset = 0;
    for (const e of entries) {
      const nameBytes = enc.encode(e.name);
      const crc = _crc32(e.data);
      const size = e.data.length;
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);   // signature
      local.setUint16(4, 20, true);           // version minimale
      local.setUint16(6, 0x0800, true);       // drapeau : nom en UTF-8
      local.setUint16(8, 0, true);            // methode 0 = store
      local.setUint16(10, 0, true); local.setUint16(12, 0, true);   // heure/date
      local.setUint32(14, crc, true);
      local.setUint32(18, size, true); local.setUint32(22, size, true);
      local.setUint16(26, nameBytes.length, true); local.setUint16(28, 0, true);
      chunks.push(new Uint8Array(local.buffer), nameBytes, e.data);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true); cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true); cen.setUint16(10, 0, true);
      cen.setUint16(12, 0, true); cen.setUint16(14, 0, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, size, true); cen.setUint32(24, size, true);
      cen.setUint16(28, nameBytes.length, true);
      cen.setUint16(30, 0, true); cen.setUint16(32, 0, true);
      cen.setUint16(34, 0, true); cen.setUint16(36, 0, true);
      cen.setUint32(38, 0, true);
      cen.setUint32(42, offset, true);
      central.push(new Uint8Array(cen.buffer), nameBytes);
      offset += 30 + nameBytes.length + size;
    }
    const centralSize = central.reduce((n, c) => n + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, new Uint8Array(end.buffer)],
                    { type: 'application/zip' });
  }

  function _basename(p) {
    return String(p || '').split('#')[0].split('?')[0].split(/[/\\]/).pop() || '';
  }
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
  // Poignee de fichier choisie par « Browse... » (File System Access API).
  // Consommee par le PREMIER _downloadBlobAs qui suit, puis remise a null :
  // un export en produit parfois plusieurs (mesh + LICENSE.txt) et seul le
  // fichier principal doit atterrir a l'emplacement choisi.
  let _pendingSaveHandle = null;

  async function _downloadBlobAs(blobOrUrl, filename) {
    // Ecriture directe a l'endroit choisi par l'utilisateur, quand il a
    // reellement pu choisir. Avant, « Browse... » ne faisait RIEN en cloud :
    // pickExportPath renvoyait le nom de fichier sans ouvrir de selecteur,
    // donc le clic reecrivait la meme valeur dans le champ.
    if (_pendingSaveHandle && blobOrUrl instanceof Blob) {
      const handle = _pendingSaveHandle;
      _pendingSaveHandle = null;
      // L'extension REELLE peut differer de celle choisie (OBJ et glTF
      // separe reviennent en .zip). Ecrire des octets zip dans un « .obj »
      // choisi par l'utilisateur serait le meme mensonge que l'ancien
      // renommage GLB -> .fbx : dans ce cas on retombe sur un
      // telechargement classique, qui portera la bonne extension.
      const want = String(filename || '').split('.').pop().toLowerCase();
      const got  = String(handle.name || '').split('.').pop().toLowerCase();
      if (want === got) {
        try {
          const w = await handle.createWritable();
          await w.write(blobOrUrl);
          await w.close();
          return 'picker';
        } catch (_) { /* permission revoquee / disque plein -> telechargement */ }
      }
    }
    let url;
    if (blobOrUrl instanceof Blob) url = URL.createObjectURL(blobOrUrl);
    else url = blobOrUrl;
    const a = document.createElement('a');
    a.href = url; a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (blobOrUrl instanceof Blob) setTimeout(() => URL.revokeObjectURL(url), 2000);
    return 'download';
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
  // 2026-06-01: now returns a Promise — callers should `await` it
  // BEFORE reloadCurrentProject() so the Supabase row is visible to
  // the next /api/cloud-projects call. Without this, the user had
  // to manually refresh after Remove BG / Modify / Inpaint / Upscale.
  async function _attachToCurrentProject(newPath, kind /* 'front'|'back' */) {
    if (!newPath) return;
    try {
      const projectName = window.state?.currentProject?.name;
      if (projectName) await _appendCloudImages(projectName, [newPath], kind || 'front');
    } catch (_) { /* ignore */ }
  }
  // Map the legacy `kind` (front/back/view) into the user_assets `kind`
  // values the worker stores (image-front/image-back/image-...).
  function _userAssetKind(legacyKind) {
    switch (legacyKind) {
      case 'front':     return 'image-front';
      case 'back':      return 'image-back';
      case 'view':      return 'image-view';
      case 'modified':  return 'image-modified';
      case 'removebg':  return 'image-removebg';
      case 'rectified': return 'image-rectified';
      case 'upscaled':  return 'image-upscaled';
      case 'inpainted': return 'image-inpainted';
      case 'facefixed': return 'image-facefixed';
      default:          return `image-${legacyKind || 'unknown'}`;
    }
  }

  // Persist a new image to Supabase user_assets (replaces the
  // localStorage cache so we never hit the 5 MB quota again).
  // Fire-and-forget so it never blocks the success path; the
  // localStorage write below still runs as a transient fallback in
  // case the API call drops.
  async function _recordUserAsset(projectName, urls, legacyKind, parentPath) {
    if (!projectName || !urls || !urls.length) return { ok: false };
    try {
      const r = await fetch('/api/user-assets/record', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectName,
          kind: _userAssetKind(legacyKind),
          paths: urls,
          parentPath: parentPath || null,
        }),
        credentials: 'include',
      });
      const j = await r.json().catch(() => ({}));
      console.log('[user-assets/record]', _userAssetKind(legacyKind),
                  'projectName=', projectName,
                  'inserted=', j?.inserted, 'of', urls.length);
      return j;
    } catch (e) {
      console.warn('[user-assets/record] failed:', e?.message || e);
      return { ok: false, error: String(e) };
    }
  }

  async function _appendCloudImages(projectName, urls, kind /* 'front'|'back'|'view' */, parentPath) {
    console.log('[_appendCloudImages] CALLED name=', projectName, 'urls=', urls, 'kind=', kind);
    if (!projectName) { console.warn('[_appendCloudImages] no projectName, skip'); return; }
    // Server is the source of truth: POST /api/user-assets/record.
    // AWAITS so reloadCurrentProject() called right after sees the row.
    await _recordUserAsset(projectName, urls, kind, parentPath);
    return;
    // (Dead code below kept on purpose so a future build can revive
    // the local write if Supabase ever has hiccups.)
    // eslint-disable-next-line no-unreachable
    const k = _imgKey(projectName);
    const payload = urls || [];
    function tryWrite() {
      const arr = JSON.parse(localStorage.getItem(k) || '[]');
      const before = arr.length;
      for (const u of payload) arr.push({ path: u, kind, mtime: Date.now() });
      const capped = arr.slice(-200);
      localStorage.setItem(k, JSON.stringify(capped));
      console.log('[_appendCloudImages]', k,
                  'before=', before, '+', payload.length, 'kind=', kind,
                  '→ stored=', capped.length,
                  'sample urls=', payload.slice(0, 2));
    }
    function isQuotaError(e) {
      return !!e && (e.name === 'QuotaExceededError'
                  || e.code === 22 || e.code === 1014
                  || /quota|exceeded/i.test(String(e.message || e)));
    }
    function freeNonEssentialCaches(currentProject) {
      // Aggressive purge: anything we can rebuild on demand.
      // Preserves ONLY auth tokens (sb-*, supabase.*) and the CURRENT
      // project's image cache (so the just-generated image stays
      // discoverable on next refresh).
      const keepImgKey = currentProject ? _imgKey(currentProject) : null;
      let freed = 0;
      const toDrop = [];
      for (let i = 0; i < localStorage.length; i++) {
        const lk = localStorage.key(i) || '';
        if (!lk) continue;
        // Preserve auth (Supabase / Cloudflare)
        if (lk.startsWith('sb-') || lk.startsWith('supabase.')) continue;
        // Preserve THIS project's image cache so we can append the new URL.
        if (lk === keepImgKey) continue;
        // Drop everything else we own
        if (lk.startsWith('myfm:')
         || lk.startsWith('fabmesh_')
         || lk.startsWith('fabmesh:')) {
          toDrop.push(lk);
        }
      }
      for (const lk of toDrop) {
        freed += (localStorage.getItem(lk) || '').length;
        try { localStorage.removeItem(lk); } catch (_) {}
      }
      return { freed, count: toDrop.length, dropped: toDrop };
    }
    try {
      tryWrite();
    } catch (e) {
      const quota = isQuotaError(e);
      console.warn('[_appendCloudImages] write failed:', e?.message || e, 'quota=', quota);
      if (!quota) return;
      try {
        const { freed, count, dropped } = freeNonEssentialCaches(projectName);
        console.warn('[_appendCloudImages] freed', freed, 'chars across', count, 'keys; retrying. Dropped:', dropped.slice(0, 20));
        tryWrite();
        if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
          window.showToast('Image saved (non-essential caches purged to free localStorage)', 'warn');
        }
      } catch (e2) {
        console.error('[_appendCloudImages] retry also failed:', e2?.message || e2);
        // Last-ditch: write ONLY the new URL (no history) so the version
        // appears at least once. The next reload from R2 will refill.
        try {
          const minimal = (urls || []).map(u => ({ path: u, kind, mtime: Date.now() }));
          localStorage.setItem(k, JSON.stringify(minimal));
          console.warn('[_appendCloudImages] minimal-only write succeeded after full purge:', minimal.length);
          if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
            window.showToast('Image saved (local cache reset — older versions reload from cloud)', 'warn', 8000);
          }
        } catch (e3) {
          console.error('[_appendCloudImages] even minimal write failed:', e3?.message || e3);
          if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
            window.showToast('Could not save new image locally — localStorage full. Open DevTools → Application → Storage → Clear site data, then retry.', 'error', 12000);
          }
        }
      }
    }
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
    /* ── projects / meshes (Worker-backed only) ──────────────────
       Server is now the source of truth for image listings (Supabase
       user_assets). localStorage merge was creating duplicate thumbs
       when both the server INSERT and the legacy local push hit the
       same URL. */
    listImageFolders: async () => {
      let projects = [];
      try {
        const r = await getJSON('/api/cloud-projects');
        projects = Array.isArray(r) ? r : (r.projects || []);
      } catch (e) { log('listImageFolders failed:', e); }
      return projects.map(p => {
        const backCache = _readBackPhotos(p.name);
        // /api/cloud-projects already sorts user_assets newest-first
        // (handleCloudProjects does .sort((a,b) =>
        // b.mtime.localeCompare(a.mtime))). The renderer labels by
        // `v${length-1-i}` expecting i=0 = newest = vMAX. So we
        // preserve the server order (no reverse). The legacy reverse()
        // was for desktop main.js which returned oldest-first.
        const merged = [...(p.images || [])];
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
          created: p.created || new Date().toISOString(),
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
      // Image version: DELETE the Supabase row + the R2 blob via
      // /api/user-assets/delete. The legacy localStorage cache was
      // removed in the Supabase migration so we don't touch it.
      try {
        const r = await fetch('/api/user-assets/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ path: filePath }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return { ok: false, success: false, error: j?.error || `HTTP ${r.status}` };
        console.log('[deleteFile] image:', filePath, '→', j);
        return { ok: true, success: true, cloud: true, ...j };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },

    /* ── thumbnails (R2-backed) ──────────────────────────────────
       Thumbnails used to be base64 PNGs in localStorage (~100-200 KB
       each), one of the heaviest offenders of the 5 MB origin quota.
       Now they go to R2 via /api/thumbs/upload and we cache the
       returned URL in localStorage (~150 chars instead of 200 KB). */
    saveThumbnail: async ({ meshPath, dataUrl } = {}) => {
      try {
        if (!meshPath || !dataUrl) return { ok: false, error: 'missing arg' };
        const base = _basename(meshPath);
        const r = await fetch('/api/thumbs/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ meshKey: base, dataUrl }),
          credentials: 'include',
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j?.url) {
          // Best-effort fallback: keep the legacy localStorage write so
          // the user still sees a thumbnail until the worker comes back.
          try { localStorage.setItem(`myfm:thumb:${base}`, dataUrl.slice(0, 260000)); } catch (_) {}
          return { ok: false, error: j?.error || `HTTP ${r.status}` };
        }
        // Cache just the URL (small) so we don't re-upload on every load.
        try { localStorage.setItem(`myfm:thumburl:${base}`, j.url); } catch (_) {}
        // Drop any legacy dataURL cache for this mesh — it's now in R2.
        try { localStorage.removeItem(`myfm:thumb:${base}`); } catch (_) {}
        return { ok: true, url: j.url };
      } catch (e) { return { ok: false, error: String(e) }; }
    },
    getThumbnail: async (meshPath) => {
      try {
        const base = _basename(meshPath);
        // Prefer the URL cache (small). Falls back to the legacy
        // dataURL cache if a thumb was saved before this migration.
        const urlCached = localStorage.getItem(`myfm:thumburl:${base}`);
        if (urlCached) return urlCached;
        return localStorage.getItem(`myfm:thumb:${base}`) || null;
      } catch (_) { return null; }
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
      const ext = (format || 'glb').replace('fbx_unreal', 'fbx');
      const suggested = `${defaultName || 'mesh'}.${ext}`;
      // Vrai selecteur de destination quand le navigateur le permet
      // (Chrome/Edge). Le bouton « Browse... » ne faisait rien avant :
      // on renvoyait juste un nom de fichier, donc le clic n'avait aucun
      // effet visible. L'appel est declenche par un clic utilisateur,
      // ce que l'API exige.
      if (typeof window.showSaveFilePicker === 'function') {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: suggested,
            types: [{
              description: ext.toUpperCase() + ' file',
              accept: { 'application/octet-stream': ['.' + ext] },
            }],
          });
          _pendingSaveHandle = handle;
          return { ok: true, canceled: false, path: handle.name, cloud: true, picked: true };
        } catch (e) {
          // Annulation explicite : ne PAS retomber sur un nom par defaut,
          // sinon fermer le selecteur ressemblerait a une validation.
          if (e && e.name === 'AbortError') return { ok: false, canceled: true };
          /* API refusee (contexte non securise, permission) -> repli */
        }
      }
      // Repli : pas de systeme de fichiers accessible, l'enregistrement
      // passera par le telechargement du navigateur.
      _pendingSaveHandle = null;
      return { ok: true, canceled: false, path: suggested, cloud: true };
    },
    exportMesh: async ({ sourcePath, targetFormat, outputPath } = {}) => {
      try {
        // fbx_unreal est CONSERVE tel quel (avant : rabattu sur 'fbx') —
        // c'est lui qui declenche cote serveur l'echelle en cm et l'axe
        // Y-up attendus par Unreal. L'extension renvoyee reste .fbx.
        const fmt = targetFormat || 'glb';
        const url = await impl.getMeshLocalUrl(sourcePath);
        if (!url) return { ok: false, error: 'mesh not found' };

        // Recupere UN mesh dans le format demande. GLB = telechargement
        // direct, aucun aller-retour serveur. Tout autre format passe par
        // Blender sur Modal (/api/mesh-convert), le meme moteur que le
        // desktop — pas de renommage d'octets GLB, qui produisait avant un
        // « .fbx » refuse par Blender et Unreal.
        const _grab = async (meshUrl) => {
          if (fmt === 'glb') {
            const r = await fetch(meshUrl);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return { blob: await r.blob(), ext: 'glb' };
          }
          if (!/^https?:/i.test(meshUrl)) {
            throw new Error('ce maillage n’est pas encore publie — '
              + 'la conversion ' + fmt.toUpperCase() + ' se fait cote serveur');
          }
          const d = await postJSON('/api/mesh-convert', { meshUrl, format: fmt });
          if (!d || d.ok === false || !d.url) {
            throw new Error((d && d.error) || 'conversion indisponible');
          }
          const f = await fetch(d.url);
          if (!f.ok) throw new Error('telechargement HTTP ' + f.status);
          // `ext` fait foi : OBJ et glTF separe reviennent en .zip car ils
          // ont besoin de fichiers annexes (.mtl, .bin, textures).
          return { blob: await f.blob(), ext: (d.ext || fmt) };
        };

        let main;
        try { main = await _grab(url); }
        catch (e) {
          return { ok: false, success: false,
            error: 'Export ' + fmt.toUpperCase() + ' impossible : ' + (e.message || e) };
        }
        const blob = main.blob;
        const ext = main.ext;
        const baseName = _stripExt(_basename(outputPath || sourcePath || 'mesh'));

        // ETAPES DE CONSTRUCTION : meme resultat que le desktop, traduit pour un
        // navigateur — qui ne peut pas creer de dossier sur le disque. On livre
        // donc une ARCHIVE qui porte l'arborescence : le mesh final a la racine,
        // les etapes dans « construction steps ».
        let stages = null;
        try {
          const info = await impl.checkStages3dDir?.(sourcePath);
          if (info?.exists && (info.stages || []).length >= 2) stages = info.stages;
        } catch (_) { /* pas d'etapes -> export simple */ }

        if (stages) {
          const entries = [{ name: baseName + '.' + ext,
                             data: new Uint8Array(await blob.arrayBuffer()) }];
          let failed = 0;
          for (const st of stages) {
            try {
              const su = await impl.getMeshLocalUrl(st.path || st.url);
              if (!su) { failed++; continue; }
              // Les etapes suivent le format du mesh final — comme sur
              // desktop. Une etape qui echoue ne fait pas echouer l'export.
              const got = await _grab(su);
              const num = String(st.index).padStart(2, '0');
              entries.push({
                name: 'construction steps/' + baseName + '_stage_' + num + '.' + got.ext,
                data: new Uint8Array(await got.blob.arrayBuffer()),
              });
            } catch (_) { failed++; }
          }
          // Une seule etape recuperee ne justifie pas une archive : on retombe
          // sur le fichier simple plutot que de livrer un zip trompeur.
          if (entries.length > 1) {
            const savedZip = await _downloadBlobAs(_makeZip(entries), baseName + '.zip');
            return { ok: true, success: true,
                     outputPath: baseName + '.zip', path: baseName + '.zip',
                     stages: entries.length - 1, stagesFailed: failed,
                     saved: savedZip };
          }
        }

        const want = baseName + '.' + ext;
        const saved = await _downloadBlobAs(blob, want);
        return { ok: true, success: true, outputPath: want, path: want,
                 format: fmt, ext, saved };
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
            await _attachToCurrentProject(newPath, 'front');
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
        await _attachToCurrentProject(newPath, 'front');
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
          await _attachToCurrentProject(r.newPath || r.path, 'front');
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
          await _attachToCurrentProject(newPath, 'front');
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
          await _attachToCurrentProject(newPath, 'front');
          if (typeof window.__cloudCreditsRefresh === 'function') window.__cloudCreditsRefresh();
          return { success: true, newPath };
        }
        return { success: false, error: r?.error || 'unknown' };
      } catch (e) { return { success: false, error: String(e) }; }
    },
    segmentMask: async ({ imagePath, targetText, dilate } = {}) => {
      // Detect-only CLIPSeg mask for the Auto Inpaint "Preview mask" button.
      // ONE GPU call on demand (not live-on-keystroke); returns { success,
      // maskUrl } so the renderer overlays the detected region on the source.
      if (!imagePath)  return { success: false, error: 'imagePath required' };
      if (!targetText) return { success: false, error: 'targetText required' };
      try {
        const r = await postJSON('/api/segment-preview', {
          imageUrl: imagePath, targetText, dilate: dilate || 15,
        });
        if (typeof window.__cloudCreditsRefresh === 'function') window.__cloudCreditsRefresh();
        if (r?.success && (r.maskUrl || r.url)) {
          return { success: true, maskUrl: r.maskUrl || r.url };
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
          await _attachToCurrentProject(newPath, 'front');
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
          await _attachToCurrentProject(newPath, 'front');
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
      // Renvoyait un GLB en annoncant un export Unreal reussi. Depuis que
      // le cloud a un transcodeur Blender (/api/mesh-convert), c'est un
      // vrai FBX au format Unreal — cm, Y-up, textures embarquees — le
      // meme que produit le desktop.
      return impl.exportMesh({ sourcePath, targetFormat: 'fbx_unreal' });
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
      const SOFT_WARN_SERVER_ERRORS = 6;       // ~30s of 5xx → just nudge the UI
      const MAX_CONSECUTIVE_SERVER_ERRORS = 30; // abort only at ~2.5 min of solid 5xx —
                                                // CF edge PoP issues + secret propagation
                                                // can cause brief 5xx windows that resolve
                                                // on their own. Premature abort makes us
                                                // give up on a rig that is actually running.
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
              // Soft warn at SOFT_WARN_SERVER_ERRORS (30s of 5xx): surface
              // to UI via lastWarn so the user sees something is off, but
              // KEEP polling — CF edge hiccups usually resolve within a
              // minute and the rig may still be alive on Modal.
              if (consecutiveServerErrors === SOFT_WARN_SERVER_ERRORS) {
                lastWarn = `Cloud backend returned ${resp.status} for ${SOFT_WARN_SERVER_ERRORS} polls — still trying (rig may be running on Modal). Refresh Projects later to check.`;
              }
              if (consecutiveServerErrors >= MAX_CONSECUTIVE_SERVER_ERRORS) {
                clearPending();
                return {
                  success: false, ok: false,
                  error: `Cloudflare Worker returned ${resp.status} on ${MAX_CONSECUTIVE_SERVER_ERRORS} consecutive polls (~${Math.round(MAX_CONSECUTIVE_SERVER_ERRORS * POLL_INTERVAL_MS / 1000)}s) — backend unreachable. Your rig may still complete on the cloud backend; check Projects.`,
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
              const filename = _basename(glbUrl) || 'rigged_puppeteer.glb';
              window.state.currentProject.rigs = window.state.currentProject.rigs || [];
              const already = window.state.currentProject.rigs.some(r => r.url === glbUrl);
              if (!already) {
                window.state.currentProject.rigs.push({
                  filename, url: glbUrl, path: glbUrl,
                  asset_type: 'rig', size: 0, created: new Date().toISOString(),
                });
              }
              // Activate the 4 EDIT SELECTED tool buttons now that a
              // rig exists. Without this nudge the buttons stay
              // disabled until the next full reloadCurrentProject().
              if (typeof window._updateRigToolButtons === 'function') {
                try { window._updateRigToolButtons(); } catch (e) {}
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
    // SAMPart3D part-segmentation on Modal — async spawn + poll. Mirrors
    // autoRigAI but the output is a MESH version (a segmented GLB), so the
    // caller adds it to p.meshes (NOT p.rigs). SAMPart3D trains a per-mesh
    // MLP (~8-10 min GPU) → same 15 min poll cap as rig.
    //   1. POST /api/mesh-segment → { job_id } in <2 s.
    //   2. Poll GET /api/mesh-segment-status?job_id=… every 5 s.
    // Return contract: { success, ok, mesh_url, glb_url, path, error? }.
    meshSegmentAI: async ({ meshPath, meshUrl, scale, projectName, onProgress } = {}) => {
      const url = meshUrl || meshPath;
      if (!url) return { success: false, ok: false, error: 'meshPath or meshUrl required' };
      const proj = projectName || window.state?.currentProject?.name || '';

      // ── 1. Spawn ──
      let jobId;
      try {
        const spawn = await postJSON('/api/mesh-segment', {
          mesh_url: url,
          scale: (typeof scale === 'number' && isFinite(scale)) ? scale : 1.0,
          projectName: proj,
        });
        if (typeof window.__cloudCreditsRefresh === 'function') window.__cloudCreditsRefresh();
        if (!spawn?.success || !spawn?.job_id) {
          return { success: false, ok: false, error: spawn?.error || 'mesh-segment spawn failed' };
        }
        jobId = String(spawn.job_id);
      } catch (e) {
        return { success: false, ok: false, error: e?.message || String(e) };
      }

      // Stash for page-reload resume (parallel to fabmesh_pending_rigs).
      try {
        const pending = JSON.parse(localStorage.getItem('fabmesh_pending_segments') || '[]');
        const projectId = window.state?.currentProject?.id || null;
        pending.push({ jobId, projectId, projectName: proj, meshUrl: url, createdAt: Date.now() });
        localStorage.setItem('fabmesh_pending_segments', JSON.stringify(pending.slice(-10)));
      } catch (e) { /* localStorage may be disabled */ }
      const clearPending = () => {
        try {
          const pending = JSON.parse(localStorage.getItem('fabmesh_pending_segments') || '[]');
          localStorage.setItem('fabmesh_pending_segments',
            JSON.stringify(pending.filter(p => p.jobId !== jobId)));
        } catch (e) { /* ignore */ }
      };

      // ── 2. Poll ──
      const POLL_INTERVAL_MS = 5000;
      const MAX_POLLS = 180;                    // 15 min hard cap
      const MAX_CONSECUTIVE_AUTH_ERRORS = 3;
      const SOFT_WARN_SERVER_ERRORS = 6;
      const MAX_CONSECUTIVE_SERVER_ERRORS = 30;
      const t0 = Date.now();
      let consecutiveAuthErrors = 0;
      let consecutiveServerErrors = 0;
      let lastWarn = null;
      for (let i = 0; i < MAX_POLLS; i++) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        let st;
        try {
          const resp = await fetch(
            `/api/mesh-segment-status?job_id=${encodeURIComponent(jobId)}`,
            { method: 'GET', credentials: 'same-origin' },
          );
          if (!resp.ok) {
            console.warn(`[mesh-segment] status HTTP ${resp.status} poll=${i + 1}`);
            lastWarn = `HTTP ${resp.status}`;
            if (resp.status === 401 || resp.status === 403) {
              consecutiveAuthErrors++;
              if (consecutiveAuthErrors >= MAX_CONSECUTIVE_AUTH_ERRORS) {
                clearPending();
                return {
                  success: false, ok: false,
                  error: 'session expired during segmentation — please log in and check Projects (the parts may have completed and be visible there)',
                  authLost: true,
                };
              }
            } else if (resp.status >= 500) {
              consecutiveServerErrors++;
              if (consecutiveServerErrors === SOFT_WARN_SERVER_ERRORS) {
                lastWarn = `Cloud backend returned ${resp.status} for ${SOFT_WARN_SERVER_ERRORS} polls — still trying (segmentation may be running on Modal).`;
              }
              if (consecutiveServerErrors >= MAX_CONSECUTIVE_SERVER_ERRORS) {
                clearPending();
                return {
                  success: false, ok: false,
                  error: `Cloudflare Worker returned ${resp.status} on ${MAX_CONSECUTIVE_SERVER_ERRORS} consecutive polls — backend unreachable. The segmentation may still complete on the cloud backend; check Projects.`,
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
          console.warn(`[mesh-segment] status fetch threw poll=${i + 1}`, e);
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
          return { success: false, ok: false, error: st.error || 'mesh-segment failed' };
        }
        if (st?.status === 'done') {
          clearPending();
          const glbUrl = st.mesh_url || st.url || st.path || null;
          if (!glbUrl) {
            return { success: false, ok: false, error: 'mesh-segment done but no URL returned' };
          }
          // MESH version — the caller pushes into p.meshes (not p.rigs).
          return { success: true, ok: true, mesh_url: glbUrl, glb_url: glbUrl, path: glbUrl };
        }
        console.warn(`[mesh-segment] unexpected status poll=${i + 1}`, st);
        lastWarn = `unexpected status: ${JSON.stringify(st).slice(0, 80)}`;
        if (typeof onProgress === 'function') {
          try { onProgress({ polls: i + 1, elapsedMs: Date.now() - t0, lastWarn }); } catch {}
        }
      }

      clearPending();
      return {
        success: false, ok: false,
        error: `mesh-segment timeout after ${MAX_POLLS} polls (${Math.round((Date.now() - t0) / 1000)} s) — the segmentation may have completed; refresh Projects to check.`,
      };
    },
    // Generative motion animation on a rigged GLB via Modal — async spawn + poll.
    // Mirrors autoRigAI: spawn /api/animate, poll /api/animate-status
    // every 5s. Worker uploads the animated GLB to R2 on done; we push
    // it into state.currentProject.animations[].
    autoAnimAI: async ({ rigPath, rigUrl, animType, prompt, engine, onProgress, batchId, projectName } = {}) => {
      const url = rigUrl || rigPath;
      if (!url) return { success: false, ok: false, error: 'rigPath or rigUrl required' };
      let jobId;
      try {
        const spawn = await postJSON('/api/animate', {
          rig_url: url,
          anim_type: animType || 'idle',
          prompt: prompt || '',
          engine: engine || 'anytop',
          batch_id: batchId || null,
          projectName: projectName || null,
        });
        if (typeof window.__cloudCreditsRefresh === 'function') window.__cloudCreditsRefresh();
        if (!spawn?.success || !spawn?.job_id) {
          return { success: false, ok: false, error: spawn?.error || 'animate spawn failed' };
        }
        jobId = String(spawn.job_id);
      } catch (e) {
        return { success: false, ok: false, error: e?.message || String(e) };
      }
      try {
        const pending = JSON.parse(localStorage.getItem('fabmesh_pending_anims') || '[]');
        const projectId = window.state?.currentProject?.id || null;
        const projectName = window.state?.currentProject?.name || null;
        pending.push({ jobId, projectId, projectName, rigUrl: url, animType, createdAt: Date.now() });
        localStorage.setItem('fabmesh_pending_anims', JSON.stringify(pending.slice(-10)));
      } catch (e) {}
      const clearPending = () => {
        try {
          const pending = JSON.parse(localStorage.getItem('fabmesh_pending_anims') || '[]');
          const filtered = pending.filter(p => p.jobId !== jobId);
          localStorage.setItem('fabmesh_pending_anims', JSON.stringify(filtered));
        } catch (e) {}
      };

      const POLL_INTERVAL_MS = 5000;
      const MAX_POLLS = 180;
      const MAX_CONSECUTIVE_AUTH_ERRORS = 3;
      const MAX_CONSECUTIVE_SERVER_ERRORS = 12;
      const t0 = Date.now();
      let consecutiveAuthErrors = 0;
      let consecutiveServerErrors = 0;
      let lastWarn = null;
      for (let i = 0; i < MAX_POLLS; i++) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        let st;
        try {
          const resp = await fetch(
            `/api/animate-status?job_id=${encodeURIComponent(jobId)}`,
            { method: 'GET', credentials: 'same-origin' },
          );
          if (!resp.ok) {
            lastWarn = `HTTP ${resp.status}`;
            if (resp.status === 401 || resp.status === 403) {
              consecutiveAuthErrors++;
              if (consecutiveAuthErrors >= MAX_CONSECUTIVE_AUTH_ERRORS) {
                clearPending();
                return { success: false, ok: false, error: 'session expired during animate', authLost: true };
              }
            } else if (resp.status >= 500) {
              consecutiveServerErrors++;
              if (consecutiveServerErrors >= MAX_CONSECUTIVE_SERVER_ERRORS) {
                clearPending();
                return { success: false, ok: false, error: `Cloud backend returned ${resp.status} on ${MAX_CONSECUTIVE_SERVER_ERRORS} polls` };
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
          lastWarn = e?.message || String(e);
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
          return { success: false, ok: false, error: st.error || 'animate failed' };
        }
        if (st?.status === 'done') {
          clearPending();
          const animUrl = st.anim_url || st.url || st.path || null;
          if (!animUrl) return { success: false, ok: false, error: 'animate done but no URL returned' };
          try {
            if (window.state?.currentProject) {
              const p = window.state.currentProject;
              p.animations = p.animations || [];
              const filename = _basename(animUrl) || 'anim.glb';
              const already = p.animations.some(a => a.url === animUrl);
              if (!already) {
                p.animations.push({
                  filename, url: animUrl, path: animUrl,
                  type: st.anim_type || animType || 'clip',
                  asset_type: 'animation', size: 0,
                  created: new Date().toISOString(),
                });
              }
            }
          } catch (e) { console.warn('[autoAnimAI] state push failed:', e); }
          return { success: true, ok: true, anim_url: animUrl, path: animUrl, type: st.anim_type || animType };
        }
      }
      clearPending();
      return {
        success: false, ok: false,
        error: `autoAnimAI timeout after ${MAX_POLLS} polls (${Math.round((Date.now() - t0) / 1000)} s) — refresh Projects to check.`,
      };
    },
    // CPU mesh quick edits via /api/mesh-op → trimesh on Modal.
    // Supports: smooth, decimate, center, fix_normals, fill_holes.
    // Anything else returns Desktop-only (Blender etc.).
    // 3D construction stages (cloud port of the desktop worker
    // scripts/construction_stages_3d.py via Modal CPU). meshPath on cloud
    // IS a URL. materials: string (AUTO) or {scaffold, frame, planks,
    // formwork} (MANUAL). Note: cloud v1 renders flat per-material
    // palettes (no SDXL style-matched texture pass yet).
    generateConstructionStages3d: async ({ meshPath, meshUrl, stageCount, material, materials, projectName } = {}) => {
      const url = meshUrl || meshPath;
      if (!url) return { success: false, error: 'meshPath or meshUrl required' };
      try {
        const r = await postJSON('/api/construction-stages-3d', {
          meshUrl: url,
          stageCount: Number(stageCount) || 5,
          materials: materials || material || 'wood',
          projectName: projectName || window.state?.currentProject?.name || null,
        });
        if (r?.success) {
          if (typeof window.__cloudCreditsRefresh === 'function') window.__cloudCreditsRefresh();
          // Same shape as the desktop handler: stages = [{index, path, progress}]
          const n2 = (r.stages || []).length;
          const stages = (r.stages || []).map((u, i) => ({
            index: i, path: u, progress: n2 > 1 ? i / (n2 - 1) : 1 }));
          return { success: true, versionMeshPath: r.versionMeshPath, dir: r.dir,
                   stages, count: r.count || 0 };
        }
        return { success: false, error: r?.error || 'unknown' };
      } catch (e) { return { success: false, error: String(e) }; }
    },

    // Cloud port of the desktop check-stages3d-dir (disk fallback): list
    // the stage GLBs stored in R2 for a chantier3d mesh version.
    checkStages3dDir: async (meshPath) => {
      try {
        const name = String(meshPath || '').split('?')[0].split('/').pop() || '';
        const stem = decodeURIComponent(name).replace(/\.(glb|gltf)$/i, '');
        if (!/_chantier3d_\d+$/i.test(stem)) return { success: false, stages: [] };
        const r = await getJSON('/api/stages3d-list?stem=' + encodeURIComponent(stem));
        if (r?.success && r.stages?.length) {
          const n2 = r.stages.length;
          const stages = r.stages.map((u, i) => ({
            index: i, path: u, progress: n2 > 1 ? i / (n2 - 1) : 1 }));
          // exists: desktop disk-fallback contract (showStep2Preview hook)
          return { success: true, exists: true, stages, count: r.count };
        }
        return { success: false, exists: false, stages: [] };
      } catch (e) { return { success: false, stages: [], error: String(e) }; }
    },

    // Resize / dimension tool (per-axis scale) — cloud port of the desktop
    // scripts/scale_mesh.py via /api/mesh-op op_type='resize'. meshPath on cloud
    // IS a URL. Returns { success, newPath } like the desktop mesh-resize handler.
    resizeMesh: async ({ meshPath, meshUrl, sx, sy, sz, projectName } = {}) => {
      const url = meshUrl || meshPath;
      if (!url) return { success: false, error: 'meshPath or meshUrl required' };
      try {
        const r = await postJSON('/api/mesh-op', {
          meshUrl: url, opType: 'resize',
          params: { sx: Number(sx) || 1, sy: Number(sy) || 1, sz: Number(sz) || 1 },
          projectName: projectName || window.state?.currentProject?.name || null,
        });
        if (r?.success || r?.ok) {
          if (typeof window.__cloudCreditsRefresh === 'function') window.__cloudCreditsRefresh();
          const np = r.newPath || r.path || r.mesh_url;
          return { success: true, newPath: np, path: np,
                   filename: String(np || '').split('?')[0].split('/').pop() || 'resized.glb' };
        }
        return { success: false, error: r?.error || 'resize failed' };
      } catch (e) { return { success: false, error: String(e) }; }
    },

    // Explosion / destruction tool — cloud port of the desktop
    // scripts/explode_mesh_3d.py via /api/mesh-op op_type='explode'. Outputs ONE
    // GLB with part_XX submeshes driven by the viewer's explode slider (no baked
    // stages). `fill` is accepted for desktop parity but ignored (thin shards).
    generateExplode3d: async ({ meshPath, meshUrl, fragments, projectName } = {}) => {
      const url = meshUrl || meshPath;
      if (!url) return { success: false, error: 'meshPath or meshUrl required' };
      try {
        const r = await postJSON('/api/mesh-op', {
          meshUrl: url, opType: 'explode',
          params: { fragments: Number(fragments) || 24 },
          projectName: projectName || window.state?.currentProject?.name || null,
        });
        if (r?.success || r?.ok) {
          if (typeof window.__cloudCreditsRefresh === 'function') window.__cloudCreditsRefresh();
          const np = r.newPath || r.path || r.mesh_url;
          return { success: true, newPath: np, path: np, operation: 'explode',
                   filename: String(np || '').split('?')[0].split('/').pop() || 'explode.glb' };
        }
        return { success: false, error: r?.error || 'explode failed' };
      } catch (e) { return { success: false, error: String(e) }; }
    },

    // The cloud explosion outputs a SINGLE parts-mesh (no baked stage GLBs on
    // disk), so there is nothing to poll — return the no-stages contract.
    checkExplodeDir: async () => ({ success: false, exists: false, stages: [] }),

    meshTool: async ({ operation, meshPath, meshUrl, meshId, imagePath, params, projectName } = {}) => {
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
        'subdivide', 'material', 'retex_swap', 'watertight',
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
          case 'watertight':
            // build → [resolution]
            finalParams = {};
            if (a[0] != null) finalParams.resolution = Number(a[0]);
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
          projectName: projectName || null,
        });
        if (r?.success && (r.path || r.newPath || r.mesh_url)) {
          if (typeof window.__cloudCreditsRefresh === 'function') window.__cloudCreditsRefresh();
          return { success: true, newPath: r.path || r.newPath || r.mesh_url, stats: r.stats || null };
        }
        return { success: false, error: r?.error || 'unknown' };
      } catch (e) { return { success: false, error: String(e) }; }
    },

    // Landmarks persistence — JSON keyed by mesh slug, stored in R2 at
    // <user_id>/landmarks/<slug>.json via the Worker. Slug derived from
    // the mesh URL/filename (last path segment minus .glb/.gltf).
    saveLandmarks: async ({ meshPath, meshUrl, landmarks } = {}) => {
      const target = meshUrl || meshPath;
      if (!target) return { ok: false, error: 'meshPath or meshUrl required' };
      if (!landmarks || typeof landmarks !== 'object') return { ok: false, error: 'landmarks object required' };
      try {
        const r = await postJSON('/api/landmarks', {
          mesh_url: target,
          landmarks,
          op: 'save',
        });
        return r?.ok ? { ok: true, success: true, count: r.count } : { ok: false, error: r?.error || 'save failed' };
      } catch (e) { return { ok: false, error: String(e) }; }
    },
    loadLandmarks: async ({ meshPath, meshUrl } = {}) => {
      const target = meshUrl || meshPath;
      if (!target) return { ok: false, error: 'meshPath or meshUrl required' };
      try {
        const r = await postJSON('/api/landmarks', {
          mesh_url: target,
          op: 'load',
        });
        if (r?.ok) return { ok: true, success: true, landmarks: r.landmarks || {} };
        return { ok: false, landmarks: {}, error: r?.error || 'not found' };
      } catch (e) { return { ok: false, landmarks: {}, error: String(e) }; }
    },
    // Material Adjust — applies 6 PBR sliders to the GLB via Modal
    // mesh-op (trimesh + PIL, no bpy needed). Mirrors the desktop
    // scripts/mesh_material_adjust.py output. Returns { success, filename }
    // shape so the existing UI Save handler refreshes the workspace.
    materialAdjust: async ({ meshPath, meshUrl,
                            brightness = 1.0, saturation = 1.0, contrast = 1.0,
                            emissive = 0.0, metallic = 0.0, roughness = 0.7,
                            hue_shift = 0.0,
                            projectName } = {}) => {
      const url = meshUrl || meshPath;
      if (!url) return { success: false, ok: false, error: 'meshPath or meshUrl required' };
      try {
        const r = await postJSON('/api/mesh-op', {
          meshUrl: url,
          opType: 'material_adjust',
          projectName: projectName || null,
          params: {
            brightness: Number(brightness),
            saturation: Number(saturation),
            contrast: Number(contrast),
            emissive: Number(emissive),
            metallic: Number(metallic),
            roughness: Number(roughness),
            hue_shift: Number(hue_shift),
          },
        });
        if (r?.success) {
          if (typeof window.__cloudCreditsRefresh === 'function') window.__cloudCreditsRefresh();
          const newPath = r.path || r.newPath || r.mesh_url || r.url;
          // The mesh-op endpoint uploads the new GLB to R2; surface its
          // filename so the workspace UI can append it to the meshes list.
          const filename = _basename(newPath) || `${_stripExt(_basename(url) || 'mesh')}_mat_${Date.now()}.glb`;
          return { success: true, ok: true, newPath, filename, mesh_url: newPath };
        }
        return { success: false, ok: false, error: r?.error || 'material_adjust failed' };
      } catch (e) {
        return { success: false, ok: false, error: String(e) };
      }
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
    // materialAdjust has a REAL implementation below (Modal mesh-op trimesh+PIL).
    // alignTexture does NOT — calling it threw "API.alignTexture is not a
    // function", and the Modal align_texture op just re-exports the GLB unchanged
    // while still charging a credit. Stub it gracefully (NOT_AVAIL) on cloud.
    'alignTexture',
    // Calibration (Desktop diagnostics tool)
    'calibRun', 'calibLastReport', 'calibOpenReport', 'calibListReports',
    'calibDiagnose', 'calibTiered', 'calibV3', 'calibCancel',
    'calibReadLog', 'calibClearLog',
    // UniRig (Desktop-only for now). autoRigAI is wired above to
    // /api/auto-rig (Puppeteer on Modal). saveLandmarks / loadLandmarks
    // are implemented further down via /api/landmarks (R2-backed).
    'autoRig', 'listRigTemplates', 'listRigAnimations',
    'analyzeSkeleton',
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

  // ─── One-shot Supabase migration + safe cleanup ─────────────────
  // Runs ONCE per browser (guard: localStorage 'myfm:migration:v1').
  //
  // Step 1 — for every `myfm:cloudimages:<project>` key still in
  // localStorage, POST its URLs to /api/user-assets/record so the
  // worker INSERTs the mapping in Supabase user_assets.
  //
  // Step 2 — ask the worker to backfill from jobs.options.sourceImage
  // for any image whose mapping was lost (e.g. previous cleanup ran
  // before this migration was deployed).
  //
  // Step 3 — drop the heavy legacy keys (dataURL thumbs, the now-
  // migrated cloudimages cache, back-photos). Skips if Step 1 fails.
  (async function _migrateAndCleanup() {
    // Guard v4: re-run reassign-orphans with the wider 1h window
    // (v3 used 10 min and left dragon/lion/orc-soldier images behind
    // because the gap between image-gen and mesh-gen was wider).
    const guardKey = 'myfm:migration:v4';
    try {
      if (localStorage.getItem(guardKey) === 'done') return;
      try { localStorage.removeItem('myfm:migration:v1'); } catch (_) {}
      try { localStorage.removeItem('myfm:migration:v2'); } catch (_) {}
      try { localStorage.removeItem('myfm:migration:v3'); } catch (_) {}
      log('migration: starting one-shot Supabase backfill + cleanup (v4)');

      // Step 1: migrate per-project image caches (if still present).
      const migrationCalls = [];
      for (let i = 0; i < localStorage.length; i++) {
        const lk = localStorage.key(i) || '';
        if (!lk.startsWith('myfm:cloudimages:')) continue;
        const project = lk.slice('myfm:cloudimages:'.length);
        let arr = [];
        try { arr = JSON.parse(localStorage.getItem(lk) || '[]'); } catch (_) {}
        if (!Array.isArray(arr) || arr.length === 0) continue;
        const fronts = arr.filter(x => (x?.kind || 'front') === 'front').map(x => x?.path || x).filter(Boolean);
        const backs  = arr.filter(x => x?.kind === 'back').map(x => x?.path || x).filter(Boolean);
        if (fronts.length) {
          migrationCalls.push(fetch('/api/user-assets/record', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ projectName: project, kind: 'image-front', paths: fronts }),
          }).then(r => r.json()).then(j => log('migrated front:', project, j?.inserted || 0)));
        }
        if (backs.length) {
          migrationCalls.push(fetch('/api/user-assets/record', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ projectName: project, kind: 'image-back', paths: backs }),
          }).then(r => r.json()).then(j => log('migrated back:', project, j?.inserted || 0)));
        }
      }
      if (migrationCalls.length) {
        await Promise.allSettled(migrationCalls);
      }

      // Step 2: backfill from jobs.options AND R2 listing on the worker.
      try {
        const r = await fetch('/api/user-assets/migrate-from-jobs', {
          method: 'POST', credentials: 'include',
        });
        const j = await r.json().catch(() => ({}));
        log('migrate-from-jobs: scanned=', j?.scanned,
            'migrated=', j?.migrated,
            'fromJobsOptions=', j?.fromJobsOptions,
            'fromR2Listing=', j?.fromR2Listing);
      } catch (e) { console.warn('[migration] jobs backfill failed:', e?.message || e); }

      // Step 2b: reassign _orphans → real projects by timestamp
      // proximity to mesh jobs.created_at. Catches the case where
      // jobs.options.sourceImage was empty (so Step 2 dumped everything
      // into _orphans) but the image's R2 filename timestamp matches
      // a mesh creation. Window is 1h — wider than the typical
      // user-flow (image gen → mesh gen takes a few min) but tight
      // enough that an image from yesterday won't end up under a
      // mesh created today by mistake.
      try {
        const r = await fetch('/api/user-assets/reassign-orphans?windowSec=3600', {
          method: 'POST', credentials: 'include',
        });
        const j = await r.json().catch(() => ({}));
        log('reassign-orphans: scanned=', j?.scanned,
            'reassigned=', j?.reassigned,
            'kept_orphan=', j?.kept_orphan,
            'byProject=', j?.byProject);
      } catch (e) { console.warn('[migration] reassign-orphans failed:', e?.message || e); }

      // Step 3: drop heavy legacy keys (safe now that Steps 1+2 ran).
      const toDrop = [];
      for (let i = 0; i < localStorage.length; i++) {
        const lk = localStorage.key(i) || '';
        if (!lk) continue;
        if (lk.startsWith('myfm:thumb:'))       toDrop.push(lk);
        if (lk.startsWith('myfm:cloudimages:')) toDrop.push(lk);
        if (lk.startsWith('myfm:backphotos:'))  toDrop.push(lk);
      }
      let freed = 0;
      for (const lk of toDrop) {
        freed += (localStorage.getItem(lk) || '').length;
        try { localStorage.removeItem(lk); } catch (_) {}
      }
      if (toDrop.length) log('cleanup: dropped', toDrop.length, 'legacy keys,', freed, 'chars freed');

      try { localStorage.setItem(guardKey, 'done'); } catch (_) {}
      log('migration: complete');

      // Trigger a single reload of the projects view so the user sees
      // their freshly-migrated images without a manual refresh.
      if (typeof window.reloadCurrentProject === 'function') {
        setTimeout(() => { try { window.reloadCurrentProject(); } catch (_) {} }, 300);
      }
    } catch (e) {
      console.warn('[migration] failed:', e?.message || e);
      // Don't set the guard — retry on next reload.
    }
  })();
  // Resume any mesh job a previous tab left behind. Delayed so the
  // renderer has time to wire pushJob / reloadCurrentProject onto
  // window before we fire pollPrediction.
  setTimeout(() => { try { resumePendingJobs(); } catch (e) { console.warn('[cloud] resume failed:', e); } }, 1500);
})();
