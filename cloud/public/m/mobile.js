/* ===========================================================================
 * MyFabmesh.AI — mobile/tablet web UI (route /m/)
 *
 * Talks ONLY to the existing Cloudflare Worker API (cloud/src/worker.ts) —
 * the exact same endpoints the desktop SPA (cloud/public/app/) uses. No new
 * backend. Every fetch uses credentials:'include' so the HttpOnly mfm-session
 * cookie is sent.
 *
 * Endpoints wired (verified against worker.ts route table):
 *   GET  /api/me              -> { user: { id, email, credits, is_admin } } | 401 { user:null, reason }
 *   GET  /api/cloud-projects  -> { projects: [{ name, images[], meshes[], ... }] }
 *   GET  /api/meshes          -> { meshes: [{ id, filename, url, created, sourceImage, projectName }] }
 *   GET  /api/pricing         -> { prices: { text2image, mesh_fast, ... } }   (cost display only)
 *   POST /api/generate-image  -> SYNCHRONOUS: { ok, success, paths[], creditsRemaining }
 *   POST /api/generate        -> ASYNC multipart: { jobId, creditsRemaining }
 *   GET  /api/jobs/:id         -> { status, url?, duration_s?, error? }
 *   POST /api/auth/signout    -> { ok:true } (clears cookies)
 * ========================================================================= */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- helpers */
  const $ = (id) => document.getElementById(id);

  function toast(msg, kind) {
    const host = $('toast-host');
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 320);
    }, kind === 'error' ? 5200 : 3200);
  }

  async function apiGet(url) {
    const r = await fetch(url, { credentials: 'include' });
    return r;
  }
  async function apiPostJSON(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body || {}),
    });
  }

  /* ---------------------------------------------------------------- state */
  const state = {
    user: null,
    meshes: [],
    // "New" flow scratch state
    lastImageUrl: null,
  };

  /* ---------------------------------------------------------------- views */
  const VIEWS = ['auth', 'home', 'mesh', 'new'];
  function show(view) {
    for (const v of VIEWS) {
      const el = $('view-' + v);
      if (el) el.hidden = (v !== view);
    }
    // Bottom nav highlight (auth view hides the nav entirely).
    const authed = view !== 'auth';
    $('bottom-nav').hidden = !authed;
    $('app-header').style.display = '';
    document.querySelectorAll('.nav-btn[data-nav]').forEach((b) => {
      b.classList.toggle('active', b.dataset.nav === view);
    });
    window.scrollTo(0, 0);
  }

  /* ---------------------------------------------------------------- auth */
  async function checkSession() {
    let r;
    try { r = await apiGet('/api/me'); }
    catch (_) { showAuthGate(); return false; }

    if (r.status === 401) {
      let reason = null;
      try { reason = (await r.json())?.reason; } catch (_) {}
      showAuthGate(reason);
      return false;
    }
    if (!r.ok) { showAuthGate(); return false; }

    let j;
    try { j = await r.json(); } catch (_) { showAuthGate(); return false; }
    if (!j || !j.user) { showAuthGate(); return false; }

    state.user = j.user;
    renderCredits(j.user.credits);
    $('btn-signout').hidden = false;
    return true;
  }

  function showAuthGate(reason) {
    state.user = null;
    show('auth');
    $('btn-signout').hidden = true;
    const link = $('login-link');
    const next = encodeURIComponent('/m/');
    link.href = `/login?next=${next}`;
    $('credits-value').textContent = '—';
    $('credits-pill').href = `/login?next=${next}`;
    if (reason === 'admin_forced_logout') {
      toast('Your session was ended by an administrator. Please sign in again.', 'error');
    }
  }

  function renderCredits(credits) {
    if (typeof credits !== 'number') return;
    $('credits-value').textContent = String(credits);
    $('credits-pill').href = '/buy';
    state.user && (state.user.credits = credits);
  }

  async function refreshCredits() {
    try {
      const r = await apiGet('/api/me');
      if (!r.ok) return;
      const j = await r.json();
      if (j?.user && typeof j.user.credits === 'number') renderCredits(j.user.credits);
    } catch (_) { /* ignore */ }
  }

  /* ---------------------------------------------------------------- pricing */
  // Best-effort: fill the ⚡ cost pills from /api/pricing. Falls back to the
  // HTML defaults (1) if the endpoint is unavailable. Display-only — the
  // Worker is the source of truth and enforces real costs server-side.
  async function loadPricing() {
    try {
      const r = await apiGet('/api/pricing');
      if (!r.ok) return;
      const j = await r.json();
      const p = j?.prices || {};
      if (typeof p.text2image === 'number') $('cost-image').textContent = String(p.text2image);
      if (typeof p.mesh_fast === 'number') $('cost-mesh').textContent = String(p.mesh_fast);
    } catch (_) { /* keep defaults */ }
  }

  /* ---------------------------------------------------------------- home */
  async function loadHome() {
    $('home-loading').hidden = false;
    $('home-empty').hidden = true;
    const grid = $('mesh-grid');
    grid.innerHTML = '';

    // Build a source-image lookup from /api/cloud-projects so each mesh card
    // can show a thumbnail (meshes have no rendered thumb server-side).
    const sourceByProject = {};
    try {
      const rp = await apiGet('/api/cloud-projects');
      if (rp.ok) {
        const jp = await rp.json();
        const projects = Array.isArray(jp) ? jp : (jp.projects || []);
        for (const proj of projects) {
          if (proj && proj.name && Array.isArray(proj.images) && proj.images.length) {
            sourceByProject[proj.name] = proj.images[0];
          }
        }
      }
    } catch (_) { /* non-fatal — cards just won't have project thumbs */ }

    let meshes = [];
    try {
      const r = await apiGet('/api/meshes');
      if (r.ok) {
        const j = await r.json();
        meshes = Array.isArray(j) ? j : (j.meshes || []);
      }
    } catch (e) {
      toast('Could not load your meshes.', 'error');
    }

    state.meshes = meshes;
    $('home-loading').hidden = true;

    if (!meshes.length) {
      $('home-empty').hidden = false;
      return;
    }

    for (const m of meshes) {
      const thumb = m.sourceImage || (m.projectName && sourceByProject[m.projectName]) || '';
      const card = document.createElement('div');
      card.className = 'mesh-card';
      const title = m.projectName || prettyName(m.filename) || 'Mesh';
      card.innerHTML = `
        <div class="mesh-card-thumb">${thumb ? '' : '🧊'}</div>
        <div class="mesh-card-body">
          <div class="mesh-card-title"></div>
          <div class="mesh-card-sub">${fmtDate(m.created)}</div>
        </div>`;
      card.querySelector('.mesh-card-title').textContent = title;
      if (thumb) {
        const t = card.querySelector('.mesh-card-thumb');
        t.style.backgroundImage = `url("${cssUrl(thumb)}")`;
        t.textContent = '';
      }
      card.addEventListener('click', () => openMesh(m));
      grid.appendChild(card);
    }
  }

  /* ---------------------------------------------------------------- mesh detail */
  function openMesh(m) {
    const url = m.url || m.path;
    if (!url) { toast('This mesh has no downloadable URL.', 'error'); return; }
    $('mesh-detail-title').textContent = m.projectName || prettyName(m.filename) || 'Mesh';
    const viewer = $('mesh-detail-viewer');
    viewer.setAttribute('src', url);
    const dl = $('mesh-detail-download');
    dl.href = url;
    dl.setAttribute('download', (m.filename || 'mesh') + (/\.glb$/i.test(m.filename || '') ? '' : '.glb'));
    show('mesh');
  }

  /* ---------------------------------------------------------------- NEW flow */
  function resetNewFlow() {
    state.lastImageUrl = null;
    $('image-progress').hidden = true;
    $('image-result').hidden = true;
    $('step-mesh').hidden = true;
    $('mesh-progress').hidden = true;
    $('mesh-result').hidden = true;
    $('new-mesh-download').hidden = true;
    $('btn-generate-mesh').hidden = false;
    setBusy($('btn-generate-image'), false, 'Generate image');
    setBusy($('btn-generate-mesh'), false, 'Convert to 3D');
  }

  function setBusy(btn, busy, label) {
    if (!btn) return;
    btn.classList.toggle('is-busy', busy);
    btn.disabled = busy;
  }

  // STEP 1: prompt -> image. /api/generate-image is SYNCHRONOUS (returns
  // paths[] directly, no jobId). We show an indeterminate-ish bar while it
  // runs server-side, then render the first returned image.
  async function generateImage() {
    const prompt = $('new-prompt').value.trim();
    if (!prompt) { toast('Please describe your asset first.', 'error'); return; }
    const btn = $('btn-generate-image');
    setBusy(btn, true);
    $('image-result').hidden = true;
    $('step-mesh').hidden = true;
    const prog = $('image-progress');
    prog.hidden = false;
    fakeProgress($('image-progress-bar'), $('image-progress-label'), 'Generating image…');

    try {
      const r = await apiPostJSON('/api/generate-image', {
        userPrompt: prompt,
        prompt: prompt,
        numImages: 1,
        asset_type: $('new-type').value,
        asset_style: $('new-style').value,
        steps: 30,
        projectName: makeProjectName(prompt),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) { showAuthGate(); return; }
      if (!r.ok || !j.success || !Array.isArray(j.paths) || !j.paths.length) {
        const msg = j.error || `Image generation failed (HTTP ${r.status})`;
        toast(msg, 'error');
        return;
      }
      completeProgress($('image-progress-bar'));
      if (typeof j.creditsRemaining === 'number') renderCredits(j.creditsRemaining);
      else refreshCredits();

      state.lastImageUrl = j.paths[0];
      const img = $('image-result-img');
      img.src = state.lastImageUrl;
      $('image-result').hidden = false;
      // Reveal step 2.
      $('step-mesh').hidden = false;
      $('btn-generate-mesh').hidden = false;
      $('mesh-result').hidden = true;
      $('new-mesh-download').hidden = true;
      $('step-mesh').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      toast('Image generation error: ' + (e && e.message ? e.message : e), 'error');
    } finally {
      setBusy(btn, false);
      setTimeout(() => { prog.hidden = true; }, 600);
    }
  }

  // STEP 2: image -> mesh. /api/generate is multipart + ASYNC: returns
  // { jobId }; we poll /api/jobs/:id until status==='succeeded' (mirrors the
  // SPA's pollPrediction in meshyAPI-cloud.js).
  async function generateMesh() {
    if (!state.lastImageUrl) { toast('Generate an image first.', 'error'); return; }
    const btn = $('btn-generate-mesh');
    setBusy(btn, true);
    const prog = $('mesh-progress');
    prog.hidden = false;
    $('mesh-result').hidden = true;
    $('new-mesh-download').hidden = true;

    try {
      // The Worker accepts a public image URL via the `imagePath` form field
      // and fetches it server-side (no browser CORS round-trip), exactly like
      // meshyAPI-cloud.js imageTo3D does for https URLs.
      const fd = new FormData();
      fd.append('imagePath', state.lastImageUrl);
      fd.append('asset_type', $('new-type').value);
      fd.append('preset', 'fast');
      fd.append('projectName', makeProjectName($('new-prompt').value.trim()));

      const r = await fetch('/api/generate', {
        method: 'POST',
        body: fd,
        credentials: 'include',
      });
      const created = await r.json().catch(() => ({}));
      if (r.status === 401) { showAuthGate(); return; }
      if (!r.ok || !created.jobId) {
        toast(created.error || `Could not start 3D generation (HTTP ${r.status})`, 'error');
        return;
      }
      if (typeof created.creditsRemaining === 'number') renderCredits(created.creditsRemaining);

      const result = await pollJob(created.jobId, $('mesh-progress-bar'), $('mesh-progress-label'));
      // Success
      refreshCredits();
      const url = result.url;
      if (!url) { toast('Mesh finished but returned no URL.', 'error'); return; }
      const viewer = $('new-mesh-viewer');
      viewer.setAttribute('src', url);
      $('mesh-result').hidden = false;
      const dl = $('new-mesh-download');
      dl.href = url;
      dl.setAttribute('download', makeProjectName($('new-prompt').value.trim()) + '.glb');
      dl.hidden = false;
      $('btn-generate-mesh').hidden = true;
      toast('3D model ready!', 'ok');
      $('mesh-result').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) {
      toast('3D generation failed: ' + (e && e.message ? e.message : e), 'error');
    } finally {
      setBusy(btn, false);
      setTimeout(() => { prog.hidden = true; }, 600);
    }
  }

  // Poll /api/jobs/:id. Mirrors meshyAPI-cloud.js pollPrediction: 2.5s
  // interval, 10 min cap, tolerate transient errors, surface failed/canceled.
  async function pollJob(jobId, barEl, labelEl) {
    const start = Date.now();
    let consecutiveErrors = 0;
    let pct = 6;
    while (Date.now() - start < 600000) {
      await new Promise((res) => setTimeout(res, 2500));
      let r, j;
      try {
        r = await apiGet('/api/jobs/' + encodeURIComponent(jobId));
        if (r.status === 503) throw new Error('Service is in maintenance mode. Try again shortly.');
        if (r.status === 401) throw new Error('Session expired. Please sign in again.');
        j = await r.json();
        consecutiveErrors = 0;
      } catch (e) {
        if (/maintenance|sign in/i.test(e.message || '')) throw e;
        if (++consecutiveErrors >= 5) throw new Error('Lost connection while building the mesh.');
        continue;
      }
      // Advance a soft progress bar (no real % from the API).
      pct = Math.min(94, pct + 3);
      if (barEl) { barEl.classList.remove('indeterminate'); barEl.style.width = pct + '%'; }
      if (labelEl) {
        const secs = Math.round((Date.now() - start) / 1000);
        labelEl.textContent = `Building 3D mesh… ${secs}s (status: ${j.status || 'processing'})`;
      }
      if (j.status === 'succeeded') {
        completeProgress(barEl);
        return j;
      }
      if (j.status === 'failed' || j.status === 'canceled') {
        throw new Error(j.error || 'Generation ' + j.status);
      }
    }
    throw new Error('Timed out after 10 minutes.');
  }

  /* ---------------------------------------------------------------- progress fx */
  // Soft animated bar for the synchronous image call (no server %).
  function fakeProgress(barEl, labelEl, label) {
    if (!barEl) return;
    barEl.classList.remove('indeterminate');
    barEl.style.width = '8%';
    if (labelEl) labelEl.textContent = label;
    let pct = 8;
    const t = setInterval(() => {
      pct = Math.min(90, pct + Math.random() * 9);
      barEl.style.width = pct + '%';
    }, 700);
    barEl.__timer = t;
  }
  function completeProgress(barEl) {
    if (!barEl) return;
    if (barEl.__timer) { clearInterval(barEl.__timer); barEl.__timer = null; }
    barEl.classList.remove('indeterminate');
    barEl.style.width = '100%';
  }

  /* ---------------------------------------------------------------- utils */
  function prettyName(filename) {
    if (!filename) return '';
    return String(filename).replace(/\.[^.]+$/, '').replace(/_trellis2_[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim();
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function cssUrl(u) { return String(u).replace(/["\\]/g, '\\$&'); }
  function makeProjectName(prompt) {
    const base = (prompt || 'mobile').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'mobile';
    return base + '-' + Date.now().toString(36).slice(-4);
  }

  /* ---------------------------------------------------------------- nav wiring */
  function wireNav() {
    document.querySelectorAll('[data-nav]').forEach((el) => {
      if (el.tagName === 'A') return; // real links navigate on their own
      el.addEventListener('click', () => {
        const target = el.dataset.nav;
        if (!state.user) { show('auth'); return; }
        if (target === 'home') { show('home'); loadHome(); }
        else if (target === 'new') { resetNewFlow(); show('new'); }
        else show(target);
      });
    });

    $('btn-refresh').addEventListener('click', () => { loadHome(); refreshCredits(); });
    $('btn-generate-image').addEventListener('click', generateImage);
    $('btn-generate-mesh').addEventListener('click', generateMesh);

    $('btn-signout').addEventListener('click', async () => {
      try { await apiPostJSON('/api/auth/signout', {}); } catch (_) {}
      window.location.href = '/login?next=/m/';
    });
  }

  /* ---------------------------------------------------------------- boot */
  async function boot() {
    wireNav();
    const authed = await checkSession();
    if (!authed) return;          // auth gate already shown
    loadPricing();
    show('home');
    await loadHome();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
