// ============================================================
// FabMesh Test/Control API - renderer client
// ============================================================
// Loaded as a classic <script> BEFORE index2.js so it can
// monkey-patch console.log/warn/error and capture everything.
// Listens for test:command IPC events from main and executes
// them in the renderer context, sending results back via
// ipcRenderer.send('test:result', ...).
// ============================================================

(function () {
  // Only run inside Electron renderer where ipcRenderer is reachable via
  // the preload bridge. We can't use the contextBridge API here because
  // we need low-level ipcRenderer access. Instead we use a tiny hack:
  // electron exposes require() only if nodeIntegration is on, so we
  // rely on a small additional bridge exposed by preload. If it's not
  // there, we silently no-op (prod mode).
  if (!window.__fabmeshTest || !window.__fabmeshTest.on || !window.__fabmeshTest.send) {
    // Fall back to a marker object so the rest of the code can still run
    // without crashing. Main's rendererCall will just time out, which is
    // fine - the test API is opt-in.
    console.log('[test_api_client] IPC bridge missing (preload did not expose __fabmeshTest). Disabled.');
    return;
  }

  // ----------------------------------------------------------
  // 1. Console capture (circular buffer + forward to main)
  // ----------------------------------------------------------
  const origLog   = console.log.bind(console);
  const origWarn  = console.warn.bind(console);
  const origError = console.error.bind(console);
  const origInfo  = console.info ? console.info.bind(console) : origLog;

  function capture(level, args) {
    try {
      const parts = [];
      for (const a of args) {
        if (a instanceof Error) {
          parts.push(a.stack || (a.name + ': ' + a.message));
        } else if (typeof a === 'object') {
          try { parts.push(JSON.stringify(a)); }
          catch (_) { parts.push(String(a)); }
        } else {
          parts.push(String(a));
        }
      }
      const entry = { ts: Date.now(), level, msg: parts.join(' ') };
      window.__fabmeshTest.send('test:console', entry);
    } catch (_) { /* ignore */ }
  }

  console.log   = function (...a) { capture('log',   a); origLog(...a); };
  console.info  = function (...a) { capture('info',  a); origInfo(...a); };
  console.warn  = function (...a) { capture('warn',  a); origWarn(...a); };
  console.error = function (...a) { capture('error', a); origError(...a); };

  // Catch uncaught errors in the page
  window.addEventListener('error', (e) => {
    capture('error', ['[uncaught]', e.message, 'at', e.filename + ':' + e.lineno + ':' + e.colno]);
  });
  window.addEventListener('unhandledrejection', (e) => {
    capture('error', ['[unhandledrejection]', (e.reason && e.reason.stack) || String(e.reason)]);
  });

  // ----------------------------------------------------------
  // 2. Helper functions
  // ----------------------------------------------------------
  function clickSelector(sel) {
    const el = document.querySelector(sel);
    if (!el) throw new Error('element not found: ' + sel);
    el.scrollIntoView({ block: 'center' });
    // Fire a real click so anchor handlers run
    el.click();
    return { clicked: true, selector: sel, tag: el.tagName, text: (el.textContent || '').slice(0, 80) };
  }

  function setInputValue(sel, val) {
    const el = document.querySelector(sel);
    if (!el) throw new Error('element not found: ' + sel);
    if (el.tagName === 'SELECT') {
      el.value = val;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input',  { bubbles: true }));
    } else if (el.type === 'checkbox' || el.type === 'radio') {
      el.checked = !!val;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.value = String(val == null ? '' : val);
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { selector: sel, value: el.value };
  }

  function evalCode(code) {
    // eslint-disable-next-line no-new-func
    const fn = new Function('return (async()=>{ ' + code + ' })();');
    return fn();
  }

  function snapshotState() {
    const st = (window.state || {});
    const current = st.currentProject || null;
    const jobs = Array.isArray(st.jobs) ? st.jobs.map(j => ({
      id: j.id, name: j.name, status: j.status, progress: j.progress
    })) : [];
    const page = st.page || null;

    // Snapshot common workspace inputs if present
    function val(id) {
      const el = document.getElementById(id);
      if (!el) return null;
      if (el.type === 'checkbox') return el.checked;
      return el.value;
    }
    const inputs = {
      'ws-prompt':         val('ws-prompt'),
      'ws-engine':         val('ws-engine'),
      'ws-count':          val('ws-count'),
      'ws-steps':          val('ws-steps'),
      'ws-3d-engine':      val('ws-3d-engine'),
      'ws-rig-template':   val('ws-rig-template')
    };

    return {
      page,
      currentProject: current ? {
        name: current.name,
        imagesCount: (current.images || []).length,
        meshesCount: (current.meshes || []).length,
        rigsCount:   (current.rigs   || []).length,
        images: (current.images || []).map(i => (typeof i === 'string' ? i : (i && i.path || i && i.file))),
        meshes: (current.meshes || []).map(m => (typeof m === 'string' ? m : (m && m.path || m && m.file))),
        rigs:   (current.rigs   || []).map(r => (typeof r === 'string' ? r : (r && r.path || r && r.file)))
      } : null,
      projects: (st.projects || []).map(p => p && p.name).filter(Boolean),
      jobs,
      inputs,
      url: location.href
    };
  }

  function getJobs()  { const st = window.state || {}; return Array.isArray(st.jobs) ? st.jobs : []; }
  function getJob(id) { return getJobs().find(j => String(j.id) === String(id)) || null; }

  function selectProjectByName(name) {
    const st = window.state || {};
    const projects = st.projects || [];
    const p = projects.find(x => x && x.name === name);
    if (!p) throw new Error('project not found: ' + name);
    if (typeof window.openProject === 'function') {
      window.openProject(p);
    } else {
      // Fallback: click the project card
      const cards = document.querySelectorAll('[data-project-name]');
      for (const c of cards) {
        if (c.getAttribute('data-project-name') === name) { c.click(); break; }
      }
    }
    return { selected: name };
  }

  async function generateImage(payload) {
    const p = payload || {};
    if (p.prompt != null)    setInputValue('#ws-prompt', p.prompt);
    if (p.engine != null)    { try { setInputValue('#ws-engine', p.engine); } catch (_) {} }
    if (p.count  != null)    { try { setInputValue('#ws-count',  p.count);  } catch (_) {} }
    if (p.steps  != null)    { try { setInputValue('#ws-steps',  p.steps);  } catch (_) {} }
    if (p.assetType != null) { try { setInputValue('#ws-asset-type',  p.assetType);  } catch (_) {} }
    if (p.assetStyle != null){ try { setInputValue('#ws-asset-style', p.assetStyle); } catch (_) {} }
    // Set checkboxes through their native .checked prop so the click handler
    // reads the value we asked for (e.g. auto multi-view).
    if (p.multiView != null) {
      const cb = document.querySelector('#ws-auto-multiview');
      if (cb) { cb.checked = !!p.multiView; cb.dispatchEvent(new Event('change', {bubbles:true})); }
    }
    if (p.buildStages != null) {
      const cb = document.querySelector('#ws-img-buildstages');
      if (cb) { cb.checked = !!p.buildStages; cb.dispatchEvent(new Event('change', {bubbles:true})); }
    }
    const before = getJobs().length;
    clickSelector('#ws-generate-image');
    // Return the id of the newly-pushed job (if any) so caller can wait on it.
    await new Promise(r => setTimeout(r, 150));
    const jobs = getJobs();
    const newJob = jobs.length > before ? jobs[jobs.length - 1] : null;
    return { triggered: true, jobId: newJob ? newJob.id : null };
  }

  async function generate3d(payload) {
    const p = payload || {};
    if (p.engine != null) { try { setInputValue('#ws-3d-engine', p.engine); } catch (_) {} }
    // Select image if requested, then promote it to the 3D source.
    if (p.imageIndex != null) {
      const cards = document.querySelectorAll('[data-image-index]');
      const target = Array.from(cards).find(c => String(c.getAttribute('data-image-index')) === String(p.imageIndex));
      if (target) target.click();
      // Wait a tick for the "Use for 3D" bar to appear, then click it.
      await new Promise(r => setTimeout(r, 150));
      const useBtn = document.querySelector('#ws-use-for-3d-btn');
      if (useBtn && useBtn.offsetParent !== null) useBtn.click();
    }
    const before = getJobs().length;
    // Real button id is ws-generate-mesh (not ws-generate-3d). It's disabled
    // until an image is selected as the 3D source — hence the two-step above.
    const btn = document.querySelector('#ws-generate-mesh')
             || document.querySelector('#ws-generate-3d');
    if (!btn) throw new Error('3D generate button not found');
    if (btn.disabled) throw new Error('3D generate button disabled — select an image first');
    btn.click();
    await new Promise(r => setTimeout(r, 300));
    const jobs = getJobs();
    const newJob = jobs.length > before ? jobs[jobs.length - 1] : null;
    return { triggered: true, jobId: newJob ? newJob.id : null };
  }

  // Scan all visible modal overlays and return their text content + any
  // action buttons so the test API can see popups raised by the UI
  // (customError, confirm dialogs, settings, etc).
  function getPopups() {
    const overlays = document.querySelectorAll('.modal-overlay');
    const visible = [];
    overlays.forEach((el) => {
      if (el.classList.contains('hidden')) return;
      // Also skip if display:none via inline style
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      const text = (el.innerText || el.textContent || '').trim().slice(0, 4000);
      const buttons = [];
      el.querySelectorAll('button').forEach((b) => {
        const label = (b.innerText || b.textContent || '').trim().slice(0, 60);
        if (label) buttons.push({ id: b.id || null, label });
      });
      visible.push({
        id: el.id || null,
        title: (el.querySelector('h2, h3, .modal-title')?.innerText || '').trim().slice(0, 200),
        text,
        buttons
      });
    });
    return visible;
  }

  function dismissPopup(payload) {
    const p = payload || {};
    const overlays = Array.from(document.querySelectorAll('.modal-overlay'))
      .filter((el) => !el.classList.contains('hidden'));
    if (!overlays.length) return { dismissed: 0 };
    let target;
    if (p.id) {
      target = overlays.find((el) => el.id === p.id);
      if (!target) throw new Error('no visible modal with id: ' + p.id);
    } else {
      target = overlays[overlays.length - 1]; // topmost
    }
    // Find a safe "close/cancel/ok" button — NEVER click a random button as
    // it might trigger native file dialogs or destructive actions.
    // A button is only safe if it is VISIBLE (ignore display:none / hidden).
    const isVisible = (el) => {
      if (!el) return false;
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
      return true;
    };
    const allButtons = Array.from(target.querySelectorAll('button')).filter(isVisible);
    const scoreBtn = (b) => {
      const id = (b.id || '').toLowerCase();
      const label = (b.innerText || b.textContent || '').trim().toLowerCase();
      // Highest score = best match (safe dismiss action)
      if (id.endsWith('-close') || label === 'close' || label === 'fermer') return 100;
      if (id.endsWith('-cancel') || label === 'cancel' || label === 'annuler') return 90;
      if (id === 'confirm-ok' || label === 'ok' || label === 'dismiss') return 80;
      if (label === '\u00d7' || label === 'x') return 70;
      return 0;
    };
    const candidates = allButtons
      .map((b) => ({ b, s: scoreBtn(b) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    let method;
    if (candidates.length > 0) {
      const best = candidates[0].b;
      best.click();
      method = 'button:' + (best.id || best.textContent.trim().slice(0, 20));
    } else if (target.querySelector('[data-dismiss]')) {
      target.querySelector('[data-dismiss]').click();
      method = 'data-dismiss';
    } else if (target.querySelector('.modal-close')) {
      target.querySelector('.modal-close').click();
      method = 'modal-close';
    } else {
      // Last resort: just hide it without clicking anything
      target.classList.add('hidden');
      method = 'hidden';
    }
    return { dismissed: 1, id: target.id || null, method };
  }

  async function autoRig(_payload) {
    const before = getJobs().length;
    // Prefer the workspace rig button, fall back to the AI-rig button if present.
    let btn = document.querySelector('#ws-auto-rig')
           || document.querySelector('#ws-rig-ai')
           || document.querySelector('#ws-rig-generate');
    if (!btn) throw new Error('auto-rig button not found');
    btn.click();
    await new Promise(r => setTimeout(r, 150));
    const jobs = getJobs();
    const newJob = jobs.length > before ? jobs[jobs.length - 1] : null;
    return { triggered: true, jobId: newJob ? newJob.id : null };
  }

  // ----------------------------------------------------------
  // 3. Command dispatcher (main -> renderer)
  // ----------------------------------------------------------
  window.__fabmeshTest.on('test:command', async (msg) => {
    if (!msg || !msg.id) return;
    const reply = (data, error) => window.__fabmeshTest.send('test:result', { id: msg.id, data, error });
    try {
      let data;
      switch (msg.action) {
        case 'state':          data = snapshotState(); break;
        case 'click':          data = clickSelector(msg.payload.selector); break;
        case 'set':            data = setInputValue(msg.payload.selector, msg.payload.value); break;
        case 'select-project': data = selectProjectByName(msg.payload.name); break;
        case 'generate-image': data = await generateImage(msg.payload); break;
        case 'generate-3d':    data = await generate3d(msg.payload); break;
        case 'auto-rig':       data = await autoRig(msg.payload); break;
        case 'jobs':           data = getJobs().map(j => ({ id: j.id, name: j.name, status: j.status, progress: j.progress })); break;
        case 'get-job':        data = getJob(msg.payload.id); break;
        case 'popups':         data = getPopups(); break;
        case 'dismiss-popup':  data = dismissPopup(msg.payload); break;
        case 'eval':           data = await evalCode(msg.payload.code); break;
        default: throw new Error('unknown action: ' + msg.action);
      }
      reply(data, null);
    } catch (e) {
      reply(null, (e && e.message) || String(e));
    }
  });

  // Expose helpers on window for manual DevTools poking
  window.__fabmeshTestHelpers = {
    clickSelector, setInputValue, evalCode, snapshotState,
    getJobs, getJob, selectProjectByName, generateImage, generate3d, autoRig,
    getPopups, dismissPopup
  };

  origLog('[test_api_client] installed');
})();
