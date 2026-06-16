/**
 * Cloud-only overrides for the desktop renderer UI.
 *
 * The HTML/JS are a verbatim port of the desktop renderer (so the
 * desktop stays untouched). But several Settings panels only make sense
 * when there's a local Electron process + local GPU + local installer:
 *   - AI Assistant > Claude Desktop / Control API token
 *   - Hardware > GPU info + VRAM/util/temp/RAM sliders
 *   - System > Kill processes / Open logs folder / Live logs viewer
 *   - Installation > Reconfigure / Uninstall
 *   - Calibration > Pipeline test (needs the local pipeline)
 *
 * This script runs after DOMContentLoaded and hides those sections by
 * walking from each section header to the next one. It also tags the
 * <body> with .cloud-mode so future CSS-only tweaks can target it.
 */
(function () {
  'use strict';

  // ── Auto-redirect on 401 ─────────────────────────────────────────
  // Anywhere in the /app/ workspace, if a fetch to /api/* comes back
  // 401 we know the Supabase session cookie expired. Send the user
  // straight to /login with a ?next= so they bounce right back here
  // after re-auth. One hard guard: only redirect once per page load
  // to avoid loops if /login itself happens to 401 somehow.
  //
  // On 401, try the silent refresh once before giving up — the user's
  // mfm-refresh cookie may still be valid (30 days) even though the
  // mfm-session access token (1 h) just expired. Without this, a tab
  // left idle past the access-token TTL bounced the user to /login on
  // their very first action even though refresh would have succeeded.
  let _redirectedFor401 = false;
  let _refreshInFlight = null;     // shared Promise so concurrent 401s share one refresh
  const _origFetch = window.fetch.bind(window);

  // Run the refresh AT MOST once at a time. Returns true if a refresh
  // round-trip succeeded (cookies were rotated), false otherwise.
  async function _tryRefresh() {
    if (!_refreshInFlight) {
      _refreshInFlight = (async () => {
        try {
          const r = await _origFetch('/api/auth/refresh', {
            method: 'POST', credentials: 'include',
          });
          return r.ok;
        } catch {
          return false;
        } finally {
          // Clear right after so the NEXT 401 (later in the session)
          // can start a fresh refresh attempt.
          setTimeout(() => { _refreshInFlight = null; }, 0);
        }
      })();
    }
    return _refreshInFlight;
  }

  window.fetch = async function patchedFetch(input, init) {
    let res = await _origFetch(input, init);
    try {
      const url = typeof input === 'string' ? input
                : input instanceof URL ? input.href
                : input?.url ?? '';
      const sameOriginApi = url.startsWith('/api/')
        || url.startsWith(window.location.origin + '/api/');
      const isAuthRoute = url.includes('/api/auth/');
      if (res.status === 401 && sameOriginApi && !isAuthRoute && !_redirectedFor401) {
        // Try to refresh the session ONCE; if it works, replay the
        // original request with the new cookies (browser attaches them
        // automatically). Only redirect if refresh + retry both fail.
        const refreshed = await _tryRefresh();
        if (refreshed) {
          res = await _origFetch(input, init);
        }
        if (res.status === 401) {
          _redirectedFor401 = true;
          const next = encodeURIComponent(window.location.pathname + window.location.search);
          window.location.replace(`/login?next=${next}`);
        }
      }
    } catch (_) { /* ignore */ }
    return res;
  };

  // ── C4: file:/// URL rewriter ────────────────────────────────────
  // The desktop renderer prefixes every asset path with "file:///"
  // because on Electron the renderer is loaded from file://. In the
  // browser, that produces malformed URLs like "file:///https://r2.dev/..."
  // which the browser refuses to load.
  //
  // We intercept HTMLImageElement.src + a MutationObserver to strip the
  // bogus prefix at runtime, so every <img> tag the renderer creates
  // ends up with a clean https/blob/data URL. Same for stylesheets and
  // <a href> if we ever need to.
  (function patchFilePrefix() {
    const stripPrefix = (s) => {
      if (typeof s !== 'string') return s;
      return s.replace(/^file:\/{2,3}(?=https?:|blob:|data:)/i, '');
    };
    // Expose globally so call sites that log/manipulate raw URL strings
    // (e.g. debug console.log traces, manual .src assignments that
    // escape the prototype setter) can normalise the value the same way.
    // The IIFE would otherwise keep this private.
    try { window.__stripFilePrefix = stripPrefix; } catch (_) {}
    // ── Expired Replicate URL guard ────────────────────────────────
    // replicate.delivery URLs are signed and TTL'd (~1 h). Any legacy
    // listing/project that captured one will 404 forever once expired.
    // Rather than render a broken-image icon, swap in a clear "Expired"
    // placeholder so the user knows the asset is gone and needs a
    // regenerate. Mesh GLBs go through THREE.FileLoader and we
    // deliberately let those fail loud (no placeholder), so the loader
    // surfaces the error and the user can purge the stale entry.
    const _EXPIRED_PLACEHOLDER = "data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 200 200\"><rect width=\"200\" height=\"200\" fill=\"%231a1a1a\"/><text x=\"100\" y=\"95\" text-anchor=\"middle\" fill=\"%23ff9800\" font-size=\"24\" font-family=\"sans-serif\">⚠</text><text x=\"100\" y=\"125\" text-anchor=\"middle\" fill=\"%23ff9800\" font-size=\"14\" font-family=\"sans-serif\">Expired</text></svg>";
    function isExpiredReplicateUrl(u) {
      if (typeof u !== "string") return false;
      // Strip a leading file:/// prefix that may precede the real URL
      // (the Electron-era cache-buster).
      let stripped = u.replace(/^file:\/{2,3}(?=https?:|blob:|data:)/i, '');
      try {
        const parsed = new URL(stripped);
        return /(^|\.)replicate\.delivery$/i.test(parsed.hostname);
      } catch (_) {
        return false;
      }
    }
    window.__expiredReplicatePlaceholder = _EXPIRED_PLACEHOLDER;
    window.__isExpiredReplicateUrl = isExpiredReplicateUrl;
    const _EXPIRED_TITLE = 'Legacy cloud asset expired — please regenerate';
    const proto = HTMLImageElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'src');
    if (desc && desc.get && desc.set) {
      Object.defineProperty(proto, 'src', {
        get() { return desc.get.call(this); },
        set(v) {
          const stripped = stripPrefix(v);
          if (isExpiredReplicateUrl(stripped)) {
            try {
              this.dataset.expiredReplicate = '1';
              this.title = _EXPIRED_TITLE;
            } catch (_) { /* ignore */ }
            desc.set.call(this, _EXPIRED_PLACEHOLDER);
            return;
          }
          // Non-expired URL: if this element had been previously marked
          // expired (false-positive recovery), clear the flag + title so
          // the UI doesn't keep showing the stale "Legacy cloud asset
          // expired" tooltip.
          try {
            if (this.dataset && this.dataset.expiredReplicate) {
              delete this.dataset.expiredReplicate;
              if (this.title === _EXPIRED_TITLE) this.title = '';
            }
          } catch (_) { /* ignore */ }
          desc.set.call(this, stripped);
        },
        configurable: true,
      });
    }
    // For images injected via innerHTML the setter doesn't fire — patch
    // them after the fact via a MutationObserver.
    const _guardImgEl = (i) => {
      const raw = i.getAttribute('src');
      if (!raw) return;
      const stripped = stripPrefix(raw);
      if (isExpiredReplicateUrl(stripped)) {
        i.dataset.expiredReplicate = '1';
        i.setAttribute('title', _EXPIRED_TITLE);
        i.setAttribute('src', _EXPIRED_PLACEHOLDER);
        return;
      }
      // Non-expired URL: clear any stale "expired" flag/title from a
      // previous false-positive run.
      if (i.dataset && i.dataset.expiredReplicate) {
        delete i.dataset.expiredReplicate;
        if (i.getAttribute('title') === _EXPIRED_TITLE) {
          i.removeAttribute('title');
        }
      }
      if (/^file:\/{2,3}(?=https?:|blob:|data:)/i.test(raw)) {
        i.setAttribute('src', stripped);
      }
    };
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (!(n instanceof Element)) continue;
          if (n.tagName === 'IMG') _guardImgEl(n);
          n.querySelectorAll?.('img').forEach(_guardImgEl);
        }
      }
    });
    if (document.documentElement) {
      obs.observe(document.documentElement, { childList: true, subtree: true });
    }

    // Three.js GLTFLoader loads URLs via THREE.FileLoader.load — patch
    // that too. Wait for THREE to be defined (loaded lazily by the
    // renderer); fall back silently if it never loads.
    let triesLeft = 50;
    const tryPatchThree = () => {
      const T = window.THREE;
      if (!T || !T.FileLoader || T.FileLoader.prototype.__myfmPatched) {
        if (--triesLeft > 0) return setTimeout(tryPatchThree, 200);
        return;
      }
      const fl = T.FileLoader.prototype;
      const origLoad = fl.load;
      fl.load = function (url, onLoad, onProgress, onError) {
        return origLoad.call(this, stripPrefix(url), onLoad, onProgress, onError);
      };
      fl.__myfmPatched = true;
      // TextureLoader.load goes through ImageLoader → <img>.src, NOT
      // through FileLoader, so the prototype-chain patch above doesn't
      // catch it. Patch its prototype.load directly so .glb textures
      // referenced with a bogus file:/// prefix still resolve.
      try {
        if (T.TextureLoader && !T.TextureLoader.prototype.__myfmPatched) {
          const tl = T.TextureLoader.prototype;
          const origTexLoad = tl.load;
          tl.load = function (url, onLoad, onProgress, onError) {
            return origTexLoad.call(this, stripPrefix(url), onLoad, onProgress, onError);
          };
          tl.__myfmPatched = true;
        }
        if (T.ImageLoader && !T.ImageLoader.prototype.__myfmPatched) {
          const il = T.ImageLoader.prototype;
          const origImgLoad = il.load;
          il.load = function (url, onLoad, onProgress, onError) {
            return origImgLoad.call(this, stripPrefix(url), onLoad, onProgress, onError);
          };
          il.__myfmPatched = true;
        }
      } catch (_) { /* ignore — older THREE builds */ }
    };
    tryPatchThree();
  })();

  function hideSectionByHeader(headerText) {
    const norm = headerText.trim().toLowerCase();
    document.querySelectorAll('.settings-section-header').forEach((h) => {
      if (h.textContent.trim().toLowerCase() !== norm) return;
      h.style.display = 'none';
      // Hide every immediate sibling until the next section header
      let sib = h.nextElementSibling;
      while (sib && !sib.classList.contains('settings-section-header')) {
        sib.style.display = 'none';
        sib = sib.nextElementSibling;
      }
    });
  }

  function hideById(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }

  function applyOverrides() {
    // Cheap DOM patches — safe to re-run every time the Settings/About
    // modal lazy-injects its content. Idempotent (hide* / prune* check
    // before mutating).
    document.body.classList.add('cloud-mode');

    // Whole sections (header + all its boxes)
    hideSectionByHeader('AI Assistant');     // Claude Desktop + Control API
    hideSectionByHeader('Hardware');         // GPU info + sliders
    hideSectionByHeader('System');           // Kill processes
    hideSectionByHeader('Installation');     // Reconfigure / Uninstall
    hideSectionByHeader('Calibration');      // Pipeline test (needs local GPU)

    // Standalone Settings buttons not under a header
    hideById('set-open-logs');
    hideById('set-live-logs');

    // Rigging is now fully functional on cloud: Puppeteer is deployed on
    // Modal (L40S) and exposed via /api/auto-rig. The Step 3 Rig card
    // stays visible — autoRigAI in meshyAPI-cloud.js posts the mesh URL +
    // target skeleton to the worker, which spawns the Modal job and
    // returns the rigged GLB.

    // Defensive — if the Control API box ends up outside the AI Assistant
    // section in a future refactor, hide it explicitly too.
    hideById('set-control-api-box');

    // Adapt engine dropdowns to what Cloud actually wires.
    pruneEngineSelectors();

    // Strip Desktop-only bits from the About modal.
    pruneAboutModal();

    // Hide buttons that need a Three.js sculpting/selection editor in
    // the browser (Sculpt, Paint vertex, Select) — not feasible to
    // port in cloud without a major UI effort. Same for Re-Texture
    // (TRELLIS-2 full): cloud uses the regular Generate-3D path.
    _hideDesktopOnlyButtons();

    // Idempotency guard — everything below installs listeners, observers,
    // setInterval timers, or wraps __cloudCreditsRefresh into a closure.
    // Re-running them on every Settings/About click leaked N+1 chained
    // /api/me calls, accumulated MutationObservers per modal, and
    // stacked focus/visibilitychange listeners.
    if (window.__cloudOverridesApplied) return;
    window.__cloudOverridesApplied = true;

    // Inject the credits pill into the topbar (Cloud-only — desktop has
    // unlimited local GPU and doesn't need this).
    installCreditsPill();

    // 📬 Inbox button immediately to the LEFT of the credits pill.
    // Polls /api/me/inbox every 30 s and shows an unread-count badge.
    installInboxButton();

    // 🛒 Marketplace button — quick jump to /market from anywhere in
    // the workspace topbar. Inserted to the LEFT of the inbox button so
    // the final order reads: Marketplace · Inbox · Credits.
    installMarketplaceButton();

    // Sign-out button next to the credits pill. Sessions are stored in
    // non-httpOnly `sb-<ref>-auth-token` cookies (set by LoginForm.tsx
    // and read by worker.ts:getSessionUser) so JS can delete them.
    installLogoutButton();

    // Wire the live cost meter on the "Generate 3D" button so users
    // see the total credit cost change as they toggle options.
    installMeshCostMeter();

    // Pin a small yellow "N credits" badge on every action button that
    // actually spends credits, so users can read the cost without
    // hovering / clicking. Mirrors what Generate 3D and Smooth already
    // show by hand.
    installActionCostBadges();

    // For every credit-spending tool modal, inject (1) a credit
    // balance pill in the top-right corner of the modal card, and
    // (2) a cost badge inside the primary action button. Centralises
    // the pattern instead of editing each modal HTML by hand.
    installModalCreditBadges();
    // Chain: a spend (handled by the topbar refresh) now also kicks
    // the modal pills. MUST run only once — every call wraps the
    // previous wrapper into a new closure, producing N chained calls
    // to /api/me per credit refresh.
    _wrapTopbarRefresh();
    // Refresh modal balance pills the first time any tool modal opens
    // (cheaper than polling) — picks up balance changes from other
    // tabs/devices the user might have running. MUST run only once —
    // each call attaches a new MutationObserver per modal.
    _watchModalOpens();

    // Pull the live prices set by the admin via /admin > Pricing and
    // overwrite the HTML data-credits attributes + the per-button
    // badges. Without this the UI keeps showing the hardcoded defaults
    // even after the admin saved new values.
    syncLivePricing();
    // Re-sync every 5 min in case the admin changed a price mid-session.
    setInterval(syncLivePricing, 5 * 60_000);

    // Keep the HttpOnly session alive. The mfm-session cookie carries a
    // Supabase access_token that expires after 1 h; without refresh
    // the user got silently kicked out mid-work. We ping /api/auth/refresh
    // every 50 min — well before expiry — to swap in a new pair using
    // the mfm-refresh cookie (30 days). On 401 we let the next API call
    // route the user to /login naturally.
    const _refreshSession = async () => {
      try {
        const r = await fetch('/api/auth/refresh', {
          method: 'POST', credentials: 'include',
        });
        if (!r.ok && r.status !== 401) {
          console.warn('[auth] session refresh got', r.status);
        }
      } catch (e) {
        console.warn('[auth] session refresh failed:', e?.message || e);
      }
    };
    // First refresh after 50 min, then every 50 min.
    setInterval(_refreshSession, 50 * 60_000);
    // Also refresh on tab focus if the last refresh was > 40 min ago —
    // browsers throttle setInterval on background tabs, so a user who
    // left the tab idle for 2 h would otherwise come back to a dead
    // session even though our timer "fired".
    let _lastRefreshAt = Date.now();
    const _refreshIfStale = () => {
      if (document.visibilityState === 'visible' &&
          Date.now() - _lastRefreshAt > 40 * 60_000) {
        _lastRefreshAt = Date.now();
        _refreshSession();
      }
    };
    document.addEventListener('visibilitychange', _refreshIfStale);
    window.addEventListener('focus', _refreshIfStale);

    // Cold-start indicator. Polls /api/modal-status periodically and
    // exposes the result globally so the AI tool buttons / job
    // estimators can size their progress bars + show a warm/cold pill.
    installModalStatusPoll();
  }

  /* ──────────────────────────────────────────────────────────────────
   * Cold-start tracking. The Worker writes a timestamp to R2 every
   * time an image_op call succeeds; /api/modal-status reports whether
   * the last success is within the scaledown window (~9 min).
   *
   * We expose the result on:
   *   window.__modalWarm  — bool (true while warm)
   *   window.__modalExpectedSeconds — number (30 if warm, ~150 if cold)
   *
   * Job creators (pushJob expected duration) read this to size their
   * progress bars correctly. Modals that want a visual indicator can
   * also bind to the same global.
   * ────────────────────────────────────────────────────────────────── */
  let _modalStatusTimer = null;

  async function _pollModalStatus() {
    try {
      const r = await fetch('/api/modal-status', { credentials: 'include' });
      if (!r.ok) {
        // Fail-safe: status endpoint unreachable/erroring → assume warm
        // so the cold-start hint doesn't get stuck on forever.
        window.__modalWarm = true;
        try {
          console.log('[modalStatus]', {
            warm: window.__modalWarm,
            expectedSeconds: window.__modalExpectedSeconds,
            responseOk: r.ok,
          });
        } catch (_) {}
        return;
      }
      const d = await r.json();
      const io = d?.image_op || {};
      window.__modalWarm = !!io.warm;
      window.__modalExpectedSeconds = io.warm
        ? (io.expected_seconds_warm || 30)
        : (io.expected_seconds_cold || 150);
      window.__modalSecondsSinceLastSuccess = io.seconds_since_last_success;
      // Per-container map so callers can pick the right pill based on
      // the op they're about to fire (text2image vs mesh vs rig…).
      window.__modalContainers = {
        image_op:   d?.image_op,
        text2image: d?.text2image,
        back_view:  d?.back_view,
        tpose:      d?.tpose,
        mesh:       d?.mesh,
        rig:        d?.rig,
        anim:       d?.anim,
        mvadapter:  d?.mvadapter,
      };
      // Helper: which Modal container is associated with a job kind?
      window.__modalContainerForKind = function (kind) {
        const map = {
          image:    'text2image',
          view:     'back_view',
          mesh:     'mesh',
          modify:   'image_op',
          img2img:  'image_op',
          inpaint:  'image_op',
          facefix:  'image_op',
          upscale:  'image_op',
          removebg: 'image_op',
          bg:       'image_op',
          rectify:  'tpose',
          rig:      'rig',
          anim:     'anim',
          animation:'anim',
          mvadapter:'mvadapter',
          multiview:'mvadapter',
        };
        const key = map[String(kind || '').toLowerCase()];
        if (!key) return undefined;
        return (window.__modalContainers || {})[key];
      };
      try {
        console.log('[modalStatus]', {
          warm: window.__modalWarm,
          expectedSeconds: window.__modalExpectedSeconds,
          responseOk: r.ok,
        });
      } catch (_) {}
      // Notify any listener (AI tool modals can update their pill).
      try { window.dispatchEvent(new CustomEvent('modal-status', { detail: io })); }
      catch (_) {}
      // Drive the topbar warm-up pill + per-service popover.
      // Pill stays generic ('Server warming up') with a count;
      // hover reveals the detailed list of every container's state.
      try {
        const wrap = document.getElementById('gpu-warmup-wrap');
        const txt  = document.getElementById('gpu-warmup-text');
        const list = document.getElementById('gpu-warmup-list');
        if (wrap) {
          const C = window.__modalContainers || {};
          const SERVICES = [
            { key: 'text2image', label: 'Image generation',  desc: 'Generate image from prompt' },
            { key: 'image_op',   label: 'Image edit',        desc: 'Modify, Inpaint, Upscale, Face Fix, Remove BG' },
            { key: 'mvadapter',  label: 'Multi-view',        desc: 'MV-Adapter 6 orthographic views (creature, animal)' },
            { key: 'back_view',  label: 'Back view',         desc: '2-view back photo generation' },
            { key: 'tpose',      label: 'T-pose rectify',    desc: 'Strict T-pose front rectifier' },
            { key: 'mesh',       label: '3D mesh',           desc: 'Generate 3D from image (TRELLIS-2)' },
            { key: 'rig',        label: 'Rig',               desc: 'Auto-rig via Puppeteer skeleton' },
            { key: 'anim',       label: 'Animation',         desc: 'AnyTop motion + retargeting' },
          ];
          let coldCount = 0;
          let allUnknown = true;
          const rows = SERVICES.map(s => {
            const c = C[s.key];
            const warm = c?.warm;
            if (warm === true || warm === false) allUnknown = false;
            let dot, color, statusText;
            if (warm === true) {
              dot = '#4cd964'; color = '#4cd964';
              statusText = 'warm';
            } else if (warm === false) {
              dot = '#ffaa33'; color = '#ffaa33';
              coldCount++;
              statusText = 'cold';
            } else {
              dot = '#777'; color = 'var(--text-2)';
              statusText = 'unknown';
            }
            return `<div style="display:grid; grid-template-columns:10px 1fr auto; gap:8px; align-items:center;">
                <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${dot};"></span>
                <span><strong style="color:var(--text-1);">${s.label}</strong><br>
                  <span style="color:var(--text-2); font-size:10px;">${s.desc}</span></span>
                <span style="color:${color}; font-size:10px; white-space:nowrap;">${statusText}</span>
              </div>`;
          }).join('');
          if (list) list.innerHTML = rows;
          // Hide pill when all warm OR all unknown (don't surface noise
          // before we have any data).
          if (coldCount === 0) {
            wrap.style.display = 'none';
          } else {
            if (txt) txt.textContent = `Server warming up${coldCount > 1 ? ` (${coldCount} services)` : ''}`;
            wrap.style.display = 'inline-flex';
          }
        }
      } catch (_) {}
    } catch (_) {
      // Network/parse failure → same fail-safe as non-OK.
      window.__modalWarm = true;
      try {
        console.log('[modalStatus]', {
          warm: window.__modalWarm,
          expectedSeconds: window.__modalExpectedSeconds,
          responseOk: false,
        });
      } catch (_e) {}
    }
  }

  function installModalStatusPoll() {
    _pollModalStatus();
    if (_modalStatusTimer) clearInterval(_modalStatusTimer);
    // Poll every 60s — warm/cold state only flips every ~9 min so the
    // pill stays accurate within ±1 min, and it halves R2 read load
    // vs the previous 30s.
    _modalStatusTimer = setInterval(_pollModalStatus, 60_000);
    // Force-refresh after a click on an AI tool button — the click
    // is about to fire an op so we want the freshest answer for the
    // ETA. Throttled to once per 5 s so a furious clicker doesn't
    // hammer the endpoint.
    let _lastClickPoll = 0;
    document.addEventListener('click', (e) => {
      if (e.target && e.target.closest && e.target.closest('.tool-btn')) {
        const now = Date.now();
        if (now - _lastClickPoll > 5000) {
          _lastClickPoll = now;
          _pollModalStatus();
        }
      }
    }, true);
  }

  /* ──────────────────────────────────────────────────────────────────
   * Cost badges on action buttons.
   *
   * The Worker is the source of truth on actual credit cost (worker.ts
   * COST_PER_IMAGE / COST_PER_BACK / COST_PER_RECTIFY etc.). Keep this
   * dict in lockstep with those constants when they change.
   *
   * Pattern: a tiny `<span class="cloud-cost-badge">N</span>` is
   * appended to the button label. Click handlers are untouched.
   * ────────────────────────────────────────────────────────────────── */
  const ACTION_COSTS = {
    // AI tools panel (right side of Image step) ----------------------
    'ws-modify-btn':        2,   // /api/modify-image — SDXL img2img
    'ws-autoinpaint-btn':   3,   // /api/auto-inpaint — CLIPSeg + SDXL inpaint
    'ws-removebg-btn':      1,   // /api/remove-background
    'ws-multiview-btn':     6,   // generateMultiviews — 6 views generated
    'ws-facefix-btn':       2,   // /api/face-fix-image — OpenCV + SDXL inpaint
    'ws-resolution-btn':    2,   // /api/upscale-image — LANCZOS + SDXL refine
    // Style: when the user picks an entry in the style dropdown,
    // index2.js:4754 calls API.img2img with the style as prompt →
    // /api/modify-image → Modal. 2 credits per pick.
    'ws-style-btn':         2,
    // Manual tools — only Draw Mask actually triggers a Modal call
    // (mask_inpaint, 3 cr) when the user clicks "Apply" inside the
    // modal. The dance of painting the mask itself is canvas-only and
    // free, but the end-to-end action (open → paint → apply) costs 3.
    'ws-mask-btn':          3,   // /api/mask-inpaint — user-painted mask
    // Other manual tools (clone, blur, picker, paint, crop, brightness,
    // symmetrize, color pick) are pure canvas ops — no badge.

    // Mesh step — CPU trimesh ops via /api/mesh-op. ~1 credit flat each.
    'ws-mesh-smooth-btn':       1,
    'ws-mesh-decimate-btn':     1,
    'ws-mesh-center-btn':       1,
    'ws-mesh-fixnormals-btn':   1,
    'ws-mesh-fillholes-btn':    1,
    'ws-mesh-watertight-btn':   1,   // voxel remesh on Modal
    'ws-mesh-subdivide-btn':    1,   // Wave 4.2
    'ws-mesh-aligntex-btn':     1,   // Wave 4.2 (no-op for now)
    'ws-mesh-material-btn':     1,   // Wave 4.2 (PBR normalize)
    'ws-mesh-retexture-btn':    1,   // Wave 4.2 (atlas swap)
  };

  // Buttons we hide on cloud. Note: `ws-mesh-sculpt-btn` is now ENABLED
  // on cloud as of 2026-05-29 (ea85cad shipped a client-side Three.js
  // sculpt modal with 6 brushes Push/Pull/Smooth/Flatten/Grab/Inflate
  // + X/Y/Z symmetry — runs in the browser, no server dep).
  // Each remaining ID is kept hidden for its own reason below.
  const CLOUD_HIDE_BUTTONS = [
    'ws-mesh-paintvert-btn',   // vertex paint — still WIP UX-wise
    'ws-mesh-selectface-btn',  // face selection is useless without delete-faces (not landed yet)
    'ws-mesh-trellis2-btn',    // desktop-only TRELLIS-2 retexture path
    // "Open in Blender" / "Show in folder" only work on Desktop where
    // we can spawn `blender` and reveal the file on the user's FS.
    // Browser cannot do either; just hide them on cloud.
    'ws-mesh-blender-btn',
    'ws-mesh-folder-btn',
    'ws-rig-blender-btn',
    'ws-rig-folder-btn',
  ];
  function _hideDesktopOnlyButtons() {
    for (const id of CLOUD_HIDE_BUTTONS) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
  }

  function _ensureCostBadgeStyle() {
    if (document.getElementById('cloud-cost-badge-style')) return;
    const style = document.createElement('style');
    style.id = 'cloud-cost-badge-style';
    style.textContent = `
      /* Force space-between on any tool button hosting a credit badge so
         the chip pins to the right edge (was floating right after the
         text). Matches all legacy class names used as aliases below. */
      .tool-btn:has(> .credit-badge),
      .tool-btn:has(> .cloud-cost-badge) {
        justify-content: space-between !important;
      }
      /* ─────────────────────────────────────────────────────────────
       * .credit-badge — single canonical class for every credit-cost
       * chip in the app. Yellow pill, outlined black lightning ⚡
       * generated via ::before so callers only write the number.
       *
       * Modifiers:
       *   .lg         — bigger pill for the topbar credit balance
       *   .icon-only  — round 20px puck (no text)
       *
       * Legacy aliases kept until every caller migrates:
       *   .cloud-cost-badge     (tool-btn badges, auto-attached)
       *   .generate-cost-pill   (Generate button price chip)
       *   .credits-pill         (Buy page balance)
       * ───────────────────────────────────────────────────────────── */
      .credit-badge,
      .cloud-cost-badge,
      .generate-cost-pill,
      .credits-pill {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 2px 9px;
        background: linear-gradient(135deg, #ffd84a, #f5a623);
        color: #1a1a1a;
        border: 1px solid rgba(255, 255, 255, 0.3);
        border-radius: 999px;
        font-size: 13px;
        font-weight: 800;
        line-height: 1.4;
        font-variant-numeric: tabular-nums;
        vertical-align: middle;
        box-shadow: 0 2px 6px rgba(245, 166, 35, 0.5),
                    inset 0 1px 0 rgba(255, 255, 255, 0.4);
        text-shadow: 0 1px 0 rgba(255, 255, 255, 0.3);
        flex-shrink: 0;
        text-decoration: none;
      }
      /* Tool-btn variant: bigger 24px height + auto-left margin so it
         pins to the right side of the button. */
      .cloud-cost-badge {
        min-width: 30px;
        height: 24px;
        padding: 0 9px 0 7px;
        margin-left: auto;
        font-size: 14px;
        line-height: 1;
      }
      .generate-cost-pill { margin-left: 8px; }
      /* Topbar balance pill — larger so the balance is the first thing
         the user sees. */
      .credit-badge.lg {
        padding: 5px 12px;
        margin-right: 8px;
        font-size: 12px;
        font-weight: 700;
        gap: 6px;
      }
      /* Round icon-only puck (no text). */
      .credit-badge.icon-only {
        padding: 0;
        width: 20px;
        height: 20px;
        justify-content: center;
        gap: 0;
      }
      /* Outlined yellow lightning bolt. Lives on ::before of every
         alias so callers never need to write the emoji manually. */
      .credit-badge::before,
      .cloud-cost-badge::before,
      .generate-cost-pill::before,
      .credits-pill::before {
        content: '\\26A1';
        display: inline-block;
        font-size: 13px;
        line-height: 1;
        color: #ffe066;
        text-shadow:
          -1px -1px 0 #1a1a1a, 1px -1px 0 #1a1a1a,
          -1px  1px 0 #1a1a1a, 1px  1px 0 #1a1a1a,
          0 1px 2px rgba(0,0,0,0.5);
      }
      .cloud-cost-badge::before { margin-right: 3px; }
      .credit-badge.lg::before { font-size: 15px; }
      .credit-badge.icon-only::before { font-size: 12px; }
      /* Legacy .generate-cost-bolt — the inline ⚡ span used inside
         .generate-cost-pill before we moved the bolt to ::before.
         Hidden so existing HTML keeps rendering correctly. */
      .generate-cost-bolt { display: none; }
    `;
    document.head.appendChild(style);
  }

  function _attachCostBadge(button, credits) {
    if (!button) return;
    // Idempotent — skip if we already pinned one (e.g. on re-init).
    if (button.querySelector('.cloud-cost-badge')) return;
    const badge = document.createElement('span');
    badge.className = 'cloud-cost-badge';
    badge.textContent = String(credits);
    badge.title = `${credits} credit${credits === 1 ? '' : 's'}`;
    button.appendChild(badge);
  }

  function installActionCostBadges() {
    _ensureCostBadgeStyle();
    for (const [id, cost] of Object.entries(ACTION_COSTS)) {
      _attachCostBadge(document.getElementById(id), cost);
    }
  }

  /* ──────────────────────────────────────────────────────────────────
   * Per-tool-modal credit affordances. Every modal that triggers a
   * paid action gets:
   *   1. A live "N credits" balance pill anchored in its top-right
   *      corner (refreshed on open + after any spend via the
   *      __cloudCreditsRefresh hook).
   *   2. A cost badge inside its primary action button so the user
   *      sees the exact price on the action they're about to click.
   *
   * Modals already handled by their own JS (variant-modal has a
   * dynamic per-tab cost, modal-mesh-tool is rebuilt every open) get
   * the balance pill only — their cost badge is injected by the
   * existing code path.
   *
   * Keep MODAL_CREDIT_CONFIG narrow: only modals whose action spends
   * a fixed number of credits go here. One-off flows (Face fix,
   * Remove BG, etc.) keep their pre-existing badge handling.
   * ────────────────────────────────────────────────────────────── */
  const MODAL_CREDIT_CONFIG = {
    'modal-modify-image':      { cost: 'modify',       applyBtn: 'mod-apply' },
    'modal-multiview-options': { cost: 'multi_view',   applyBtn: 'mv-opt-start' },
    'modal-auto-inpaint':      { cost: 'auto_inpaint', applyBtn: 'ai-go',
                                 previewBtn: 'ai-preview-btn', previewCost: 'segment' },
    'mask-modal':              { cost: 'mask_inpaint', applyBtn: 'mask-apply' },
    'modal-resolution':        { cost: 'upscale_image', applyBtn: 'res-upscale', extraBtns: ['res-downscale'] },
    // variant-modal: dynamic cost handled in index2.js (var-apply-cost-badge).
    'variant-modal':           { skipCost: true },
    // modal-mesh-tool: cost badge injected per-tool by index2.js.
    'modal-mesh-tool':         { skipCost: true },
    'modal-material-adjust':   { skipCost: true },
  };

  // Pricing key → numeric default. Lives here so the modal balance/cost
  // helpers don't have to wait for /api/pricing — they can render
  // immediately with the default and syncLivePricing rewrites later.
  const _COST_DEFAULTS = {
    modify: 2, multi_view: 6, auto_inpaint: 3,
    mask_inpaint: 3, upscale_image: 2, segment: 1,
  };

  function _ensureModalBalanceStyle() {
    if (document.getElementById('cloud-modal-credit-style')) return;
    const s = document.createElement('style');
    s.id = 'cloud-modal-credit-style';
    // .modal-card needs position:relative so the balance pill can
    // anchor to its top-right corner. We scope the rule so other
    // .modal-card uses elsewhere aren't affected.
    s.textContent = `
      /* Need a positioning context for the absolute balance pill. */
      .modal-card, .modal-card-wide,
      #mask-modal > .modal-content,
      #modal-mesh-tool > .modal-content { position: relative; }
      .modal-balance-badge {
        position: absolute;
        top: 16px;
        right: 56px;
        z-index: 2;
        pointer-events: none;
      }
      /* Make primary-btn flex-align so the injected cost badge sits
         in line with the label (otherwise the badge wraps below). */
      .modal-actions .primary-btn:has(> .credit-badge),
      .primary-btn:has(> .credit-badge) {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
      }
    `;
    document.head.appendChild(s);
  }

  function _injectModalBalanceBadge(modal) {
    if (!modal) return;
    if (modal.querySelector('.modal-balance-badge')) return;
    // .modal-card / .modal-card-wide is the standard wrapper. Some
    // older modals (mask-modal, modal-mesh-tool) use .modal-content
    // instead — falling back to firstElementChild covers both.
    const card = modal.querySelector('.modal-card, .modal-card-wide, .modal-content')
              || modal.firstElementChild;
    if (!card) return;
    const pill = document.createElement('span');
    pill.className = 'credit-badge lg modal-balance-badge';
    pill.textContent = '…';
    pill.title = 'Your current credit balance';
    card.appendChild(pill);
  }

  function _injectModalCostBadge(btnId, cost) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    if (btn.querySelector('.credit-badge')) return;
    const badge = document.createElement('span');
    badge.className = 'credit-badge';
    badge.dataset.cost = String(cost);
    badge.textContent = String(cost);
    btn.appendChild(document.createTextNode(' '));
    btn.appendChild(badge);
  }

  function installModalCreditBadges() {
    _ensureCostBadgeStyle();
    _ensureModalBalanceStyle();
    for (const [modalId, conf] of Object.entries(MODAL_CREDIT_CONFIG)) {
      const modal = document.getElementById(modalId);
      if (!modal) continue;
      _injectModalBalanceBadge(modal);
      if (conf.skipCost) continue;
      const cost = _COST_DEFAULTS[conf.cost] ?? 1;
      if (conf.applyBtn) _injectModalCostBadge(conf.applyBtn, cost);
      (conf.extraBtns || []).forEach((id) => _injectModalCostBadge(id, cost));
      // Secondary action priced differently (e.g. Auto-Inpaint "Preview mask"
      // = 1 segment credit, distinct from the 3-credit Apply).
      if (conf.previewBtn) _injectModalCostBadge(conf.previewBtn, _COST_DEFAULTS[conf.previewCost] ?? 1);
    }
    // First refresh — fills the "…" with the actual balance. The
    // refresh function is exported on window so the existing topbar
    // refresh updates the modal pills too.
    _refreshModalBalances();
  }

  // Re-applies modal balance pills to any new value. Called from
  // __cloudCreditsRefresh so spending a credit updates topbar AND
  // every visible modal pill at once.
  let _lastKnownBalance = null;
  async function _refreshModalBalances() {
    try {
      const r = await fetch('/api/me', { credentials: 'include' });
      if (!r.ok) return;
      const j = await r.json();
      const credits = j?.user?.credits;
      if (typeof credits !== 'number') return;
      _lastKnownBalance = credits;
      document.querySelectorAll('.modal-balance-badge').forEach((el) => {
        el.textContent = `${credits} credit${credits === 1 ? '' : 's'}`;
      });
    } catch { /* network blip — leave previous values visible */ }
  }
  // Lazy hook: any code that mutates the topbar pill should also kick
  // the modal balances. Wraps the existing refresh function so we
  // don't lose the original behaviour.
  function _wrapTopbarRefresh() {
    const existing = window.__cloudCreditsRefresh;
    window.__cloudCreditsRefresh = async function () {
      if (typeof existing === 'function') await existing();
      _refreshModalBalances();
    };
  }

  // Watch all configured modals for hidden→visible transitions and
  // refresh the balance pill at that moment. Cheap (single class
  // attribute observer per modal) and matches user expectation —
  // they see a fresh number every time they open a paid tool.
  function _watchModalOpens() {
    const modalIds = Object.keys(MODAL_CREDIT_CONFIG);
    modalIds.forEach((id) => {
      const modal = document.getElementById(id);
      if (!modal) return;
      const obs = new MutationObserver(() => {
        if (!modal.classList.contains('hidden')) _refreshModalBalances();
      });
      obs.observe(modal, { attributes: true, attributeFilter: ['class'] });
    });
  }

  /* ──────────────────────────────────────────────────────────────────
   * Live mesh-cost meter — sums data-credits on the active preset +
   * every checked option, rewrites the "Generate 3D (N credits)" pill.
   * Re-runs on any change in the advanced texture options.
   * ────────────────────────────────────────────────────────────────── */
  /* Sync the static data-credits attributes + the per-button cost
   * badges with the dynamic pricing the admin set in /admin > Pricing.
   * Maps PRICING_DEFAULTS keys (server-side) to the HTML element ids
   * (UI-side). Runs once on boot — admin tweaks propagate to users
   * within 30s thanks to the public endpoint's Cache-Control + the
   * worker's _getPricing 60s in-memory cache. */
  const PRICING_TO_DATA_CREDITS = {
    mesh_fast:        'ws-trellis2-preset:fast',
    mesh_balanced:    'ws-trellis2-preset:balanced',
    mesh_quality:     'ws-trellis2-preset:quality',
    mesh_ultra_8k:    'ws-trellis2-preset:ultra_8k',
    mesh_multiref:    'ws-trellis2-multiref',
    mesh_refine:      'ws-trellis2-refine',
    mesh_rectify:     'ws-trellis2-rectify',
    mesh_quality_plus:'ws-trellis2-quality-plus',
    mesh_ultra_q:     'ws-trellis2-ultra-q',
    mesh_ultra_hd:    'ws-trellis2-ultra-hd',
    mesh_face_fix:    'ws-trellis2-face-fix',
  };
  // Tool-button badges (ACTION_COSTS keys) -> pricing keys.
  const ACTION_COST_TO_PRICING = {
    'ws-modify-btn':       'modify',
    'ws-autoinpaint-btn':  'auto_inpaint',
    'ws-mask-btn':         'mask_inpaint',
    'ws-facefix-btn':      'face_fix_image',
    'ws-removebg-btn':     'remove_background',
    'ws-resolution-btn':   'upscale',
  };
  async function syncLivePricing() {
    let prices;
    try {
      const r = await fetch('/api/pricing');
      if (!r.ok) return;
      const j = await r.json();
      prices = j.prices || {};
    } catch { return; }
    for (const [pkey, target] of Object.entries(PRICING_TO_DATA_CREDITS)) {
      const v = prices[pkey];
      if (typeof v !== 'number') continue;
      if (target.includes(':')) {
        const [selectId, optVal] = target.split(':');
        const opt = document.querySelector(`#${selectId} option[value="${optVal}"]`);
        if (opt) opt.dataset.credits = String(v);
      } else {
        const el = document.getElementById(target);
        if (el) el.dataset.credits = String(v);
      }
    }
    // Re-attach action cost badges using fresh prices.
    if (typeof window.ACTION_COSTS_OVERRIDE !== 'object') {
      window.ACTION_COSTS_OVERRIDE = {};
    }
    for (const [btnId, pkey] of Object.entries(ACTION_COST_TO_PRICING)) {
      const v = prices[pkey];
      if (typeof v !== 'number') continue;
      const btn = document.getElementById(btnId);
      if (!btn) continue;
      const existing = btn.querySelector('.cloud-cost-badge');
      if (existing) existing.textContent = String(v);
    }
    // Trigger mesh meter recompute (it'll read the fresh data-credits).
    const preset = document.getElementById('ws-trellis2-preset');
    if (preset) preset.dispatchEvent(new Event('change'));
    // Update the image cost pill — refreshButtonLabelsAndHiding reads
    // #ws-image-cost-value, so just bumping its text is enough.
    const imgVal = document.getElementById('ws-image-cost-value');
    if (imgVal && typeof prices.text2image === 'number') {
      imgVal.textContent = String(prices.text2image);
    }
  }

  function installMeshCostMeter() {
    const preset = document.getElementById('ws-trellis2-preset');
    if (!preset) return;
    const optionIds = [
      'ws-trellis2-multiref', 'ws-trellis2-refine', 'ws-trellis2-rectify',
      'ws-trellis2-smooth',   'ws-trellis2-quality-plus',
      'ws-trellis2-ultra-q',  'ws-trellis2-ultra-hd', 'ws-trellis2-face-fix',
    ];

    // Re-query #ws-mesh-cost-value on every tick — refreshButtonLabelsAndHiding
    // rewrites the Generate button's innerHTML when the project gains a
    // mesh, replacing the span we'd otherwise cache here. Without this
    // lookup, the cost meter writes to a detached node and the user
    // sees a frozen "12 credits" no matter which option they toggle.
    function recompute() {
      let total = parseInt(preset.selectedOptions[0]?.dataset?.credits || '1', 10);
      for (const id of optionIds) {
        const el = document.getElementById(id);
        if (el?.checked) total += parseInt(el.dataset.credits || '0', 10);
      }
      const valueEl = document.getElementById('ws-mesh-cost-value');
      if (valueEl) valueEl.textContent = String(total);
    }

    preset.addEventListener('change', recompute);
    for (const id of optionIds) {
      document.getElementById(id)?.addEventListener('change', recompute);
    }
    // Also refresh whenever the renderer swaps the Generate button label
    // (which rebuilds the pill). Watching the button itself is cheap.
    const btn = document.getElementById('ws-generate-mesh');
    if (btn) new MutationObserver(recompute).observe(btn, { childList: true });
    recompute();
  }

  /* ──────────────────────────────────────────────────────────────────
   * About modal — strip the "Updates" section (browser has no auto-
   * updater; the in-house Sentry crash reporter is also disabled).
   * ────────────────────────────────────────────────────────────────── */
  function pruneAboutModal() {
    const upBtn = document.getElementById('about-check-update');
    const upSection = upBtn?.closest('.about-section');
    if (upSection) upSection.style.display = 'none';

    // VRAM/GPU/TEMP/RAM widget on the job-details modal — no local GPU
    // in the browser, so always "--". Just hide it.
    hideById('job-gpu-monitor');

    // Slim the credit line down to the studio name. The full licence
    // list + Sentry mention were too much detail for the contact panel
    // and don't help end-users — keep that info for the legal pages.
    // BUT the DINOv3 License REQUIRES the "Built with DINOv3" attribution
    // (and we keep the Third-Party Licenses link it points to), so those
    // must survive the rewrite. Use innerHTML to preserve the link.
    document.querySelectorAll('.about-card p').forEach((p) => {
      if (!p.textContent) return;
      if (p.textContent.includes('Crash reports sent anonymously via Sentry')
       || p.textContent.includes('OpenRAIL')
       || p.textContent.includes('MIT / Apache')) {
        p.innerHTML = 'An Ayros Studio production · Built with DINOv3 · '
          + 'see <a href="/legal/licenses">Third-Party Licenses</a>.';
      }
    });
  }

  /* ──────────────────────────────────────────────────────────────────
   * Trim the image / 3D engine selectors to the engines we actually
   * route to a Replicate model. The Desktop renderer ships with options
   * for legacy local engines that have no equivalent cloud handler.
   * ────────────────────────────────────────────────────────────────── */
  function pruneEngineSelectors() {
    // 3D engine — cloud only supports trellis2_native (via fishwowater/
    // trellis2).
    const eng3d = document.getElementById('ws-3d-engine');
    if (eng3d) {
      [...eng3d.options].forEach((opt) => {
        if (opt.value !== 'trellis2_native') opt.remove();
      });
      // Relabel the lone remaining option so the user sees what the
      // cloud actually does, not the desktop "in one shot, local" copy.
      if (eng3d.options.length === 1) {
        eng3d.options[0].textContent = 'MyFabmesh.AI 3D Native (cloud GPU · ~100s · 1 credit)';
        eng3d.value = 'trellis2_native';
      }
    }

    // Image engine — only the default path (RealVisXL via our Cog) is
    // wired. The "Pollinations" / "Local SD" options the desktop exposes
    // aren't backed by a cloud handler.
    const engImg = document.getElementById('ws-image-engine');
    if (engImg) {
      [...engImg.options].forEach((opt) => {
        const keep = ['local-flux', 'cloud', 'realvis', ''].includes(opt.value);
        if (!keep) opt.remove();
      });
      if (engImg.options.length >= 1) {
        engImg.options[0].textContent = 'MyFabmesh.AI Image Engine (cloud GPU · 1 credit/image)';
      }
    }
  }

  /* ──────────────────────────────────────────────────────────────────
   * Credits pill — shows the user's Replicate credit balance in the
   * top-right of the /app/ topbar, polled on load + every 30s + after
   * any successful generate/buy action.
   * ────────────────────────────────────────────────────────────────── */
  let _creditsPillEl = null;
  let _creditsPollTimer = null;

  function installCreditsPill() {
    if (_creditsPillEl) return; // already installed
    const right = document.querySelector('#topbar .topbar-right');
    if (!right) return;

    const pill = document.createElement('a');
    pill.id = 'cloud-credits-pill';
    pill.href = '/buy';
    pill.title = 'Click to buy more credits';
    // Uses the unified .credit-badge class (lg modifier = bigger topbar
    // pill). The bolt comes from ::before, the cursor + text-decoration
    // are baked into the class — no inline styles needed anymore.
    pill.className = 'credit-badge lg';
    pill.style.cursor = 'pointer';
    pill.textContent = '…';
    right.insertBefore(pill, right.firstChild);
    _creditsPillEl = pill;

    // First fetch + polling
    refreshCreditsPill();
    if (_creditsPollTimer) clearInterval(_creditsPollTimer);
    _creditsPollTimer = setInterval(refreshCreditsPill, 30_000);
  }

  // Legacy bolt span kept as fallback for any caller that still uses
  // it. New code should rely on the .credit-badge::before instead.
  const _BOLT_HTML = '';

  let _adminForcedLogoutShown = false;
  function _showAdminForcedLogoutPopup() {
    if (_adminForcedLogoutShown) return;
    _adminForcedLogoutShown = true;
    // Full-screen overlay with a forced redirect — bypasses every
    // app modal because the admin needs this to read no matter what
    // the user was doing.
    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'background:rgba(0,0,0,0.85)',
      'display:flex', 'align-items:center', 'justify-content:center',
      'z-index:99999', 'padding:24px',
    ].join(';');
    overlay.innerHTML = `
      <div style="background:#14141a; border:2px solid #ff5252; border-radius:12px; padding:28px; max-width:480px; width:100%; text-align:center; font:14px system-ui,sans-serif; color:#f0f0f0;">
        <div style="font-size:42px; margin-bottom:8px;">🔒</div>
        <h2 style="margin:0 0 12px; color:#ff5252;">Session ended by admin</h2>
        <p style="color:#c0c0cc; line-height:1.6; margin:0 0 18px;">
          An administrator has invalidated all active sessions. You'll be redirected to the login page now.
        </p>
        <button id="admin-forced-logout-ok"
                style="background:linear-gradient(135deg,#ffd84a,#f5a623); color:#1a1a1a; border:1px solid rgba(255,255,255,0.3); padding:10px 24px; border-radius:8px; font-weight:700; cursor:pointer; font-size:14px;">
          Take me to login
        </button>
      </div>
    `;
    document.body.appendChild(overlay);
    const goLogin = () => { window.location.href = '/login'; };
    overlay.querySelector('#admin-forced-logout-ok').addEventListener('click', goLogin);
    setTimeout(goLogin, 6000);  // auto-redirect after 6 s
  }

  async function refreshCreditsPill() {
    if (!_creditsPillEl) return;
    try {
      const r = await fetch('/api/me', { credentials: 'include' });
      if (!r.ok) {
        // Distinguish admin-forced logout from a generic 401 so the
        // user sees a clear "an admin kicked you" popup instead of
        // a silent "Sign in" link swap.
        if (r.status === 401) {
          try {
            const j = await r.json();
            if (j?.reason === 'admin_forced_logout') {
              _showAdminForcedLogoutPopup();
              return;
            }
          } catch {}
        }
        _creditsPillEl.textContent = 'Sign in';
        _creditsPillEl.href = '/login';
        return;
      }
      const j = await r.json();
      const credits = j?.user?.credits;
      if (typeof credits === 'number') {
        // Bolt comes from .credit-badge::before, so we just set text.
        _creditsPillEl.textContent = `${credits} credit${credits === 1 ? '' : 's'}`;
        _creditsPillEl.href = '/buy';
      } else {
        _creditsPillEl.textContent = 'Sign in';
        _creditsPillEl.href = '/login';
      }
    } catch {
      // network issue — leave the previous value visible
    }
  }

  // Expose a hook so other Cloud code can force a refresh after spend.
  window.__cloudCreditsRefresh = refreshCreditsPill;

  /* ────────────────────────── Marketplace button ─────────────────────
   * Tiny purple pill in #topbar .topbar-right that jumps to /market.
   * Mirrors installCreditsPill (same insertion point) but slotted to
   * the LEFT of the inbox button so the topbar reads, left → right:
   *   Marketplace · Inbox · Credits.
   * Purple gradient distinguishes it from the gold credits pill.
   * ────────────────────────────────────────────────────────────────── */
  let _marketplaceBtnEl = null;
  function installMarketplaceButton() {
    if (_marketplaceBtnEl) return;
    if (document.getElementById('cloud-marketplace-btn')) return;
    const right = document.querySelector('#topbar .topbar-right');
    if (!right) return;

    const btn = document.createElement('a');
    btn.id = 'cloud-marketplace-btn';
    btn.href = '/market';
    btn.target = '_self';
    btn.title = 'Browse the marketplace';
    btn.textContent = '🛒 Marketplace';
    const baseShadow = '0 2px 6px rgba(90,79,207,0.5)';
    const hoverShadow = '0 3px 10px rgba(139,92,246,0.7)';
    const baseBg = 'linear-gradient(135deg, #5a4fcf, #8b5cf6)';
    const hoverBg = 'linear-gradient(135deg, #6e63e0, #a78bfa)';
    btn.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'gap:6px',
      'padding:5px 12px',
      'font-size:12px',
      'font-weight:700',
      'border-radius:999px',
      `background:${baseBg}`,
      'color:#fff',
      'text-decoration:none',
      'margin-right:8px',
      `box-shadow:${baseShadow}`,
      'cursor:pointer',
      'transition:background 0.15s ease, box-shadow 0.15s ease',
    ].join(';');
    btn.addEventListener('mouseenter', () => {
      btn.style.background = hoverBg;
      btn.style.boxShadow  = hoverShadow;
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = baseBg;
      btn.style.boxShadow  = baseShadow;
    });

    // Slot to the LEFT of the inbox button so order is:
    // Marketplace · Inbox · Credits. Fall back to before the credits
    // pill, then to firstChild if neither sibling exists yet.
    const inbox = right.querySelector('#cloud-inbox-btn');
    const credits = right.querySelector('#cloud-credits-pill');
    const anchor = inbox || credits || right.firstChild;
    if (anchor) right.insertBefore(btn, anchor);
    else        right.appendChild(btn);
    _marketplaceBtnEl = btn;
  }

  /* ────────────────────────── Logout button ──────────────────────────
   * Moved 2026-05-25 from the topbar to a fresh "Account" section
   * injected at the TOP of the Settings panel — keeps the topbar
   * uncluttered and groups the logout next to the user account
   * controls where users instinctively look for it.
   *
   * Clicking it clears all `sb-*-auth-token` cookies (non-httpOnly,
   * set by Supabase JS + LoginForm.persistSession) and bounces to
   * /login. Any in-memory Supabase client session is dropped at that
   * point too.
   * ────────────────────────────────────────────────────────────────── */
  async function performSignOut() {
    // Step 1: ask the Worker to wipe the HttpOnly cookies (mfm-session,
    // mfm-refresh). The legacy sweep below only deletes JS-readable
    // cookies — without this call the user "logs out" from the
    // renderer but the Worker still authenticates them via the
    // HttpOnly cookies on the next request. Big leak on shared machines.
    try {
      await fetch('/api/auth/signout', { method: 'POST', credentials: 'include' });
    } catch { /* network blip, fall through to local cleanup */ }
    // Step 2: nuke the legacy sb-*-auth-token cookies set by the
    // Supabase JS SDK + the mock-session cookie used in dev mode.
    try {
      document.cookie.split(';').forEach((c) => {
        const name = c.trim().split('=')[0];
        if (!name) return;
        if (/^sb-[^-]+-auth-token(?:\.\d+)?$/.test(name) ||
            name === 'myfm_mock_session') {
          document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax`;
        }
      });
    } catch { /* ignore */ }
    try { sessionStorage.clear(); } catch { /* ignore */ }
    window.location.href = '/login';
  }

  /* ──────────────────────────────────────────────────────────────────
   * Inbox button — 📬 icon in the topbar with an unread-count badge.
   * Mirrors installCreditsPill (inserted into #topbar .topbar-right
   * BEFORE the credits pill). Polled every 30 s. Clicking opens a
   * modal that lists marketplace approvals/rejections, sale alerts,
   * and support replies. Visible unread items are marked read on open.
   * ────────────────────────────────────────────────────────────────── */
  let _inboxBtnEl = null;
  let _inboxBadgeEl = null;
  let _inboxPollTimer = null;
  let _inboxItems = [];

  function _ensureInboxStyle() {
    if (document.getElementById('cloud-inbox-style')) return;
    const s = document.createElement('style');
    s.id = 'cloud-inbox-style';
    s.textContent = `
      #cloud-inbox-btn {
        position: relative;
        width: 32px; height: 32px;
        border-radius: 50%;
        border: 1px solid rgba(255,255,255,0.15);
        background: rgba(255,255,255,0.05);
        color: #eee;
        font-size: 16px; line-height: 1;
        display: inline-flex; align-items: center; justify-content: center;
        cursor: pointer;
        transition: background 0.15s ease;
        margin-right: 8px;
      }
      #cloud-inbox-btn:hover { background: rgba(255,255,255,0.12); }
      #cloud-inbox-badge {
        position: absolute; top: -4px; right: -4px;
        min-width: 16px; height: 16px; padding: 0 4px;
        border-radius: 8px;
        background: #f44336; color: #fff;
        font-size: 10px; font-weight: 700; line-height: 16px;
        text-align: center;
        border: 1px solid #1a1a1a;
        display: none;
      }
      .cloud-inbox-overlay {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.65);
        z-index: 9999;
        display: flex; align-items: center; justify-content: center;
      }
      .cloud-inbox-card {
        max-width: 640px; width: calc(100% - 40px);
        max-height: 80vh; overflow: auto;
        background: var(--bg-1, #1a1a1a);
        color: #eee;
        border-radius: 10px;
        padding: 24px;
        border: 1px solid rgba(255,255,255,0.1);
        box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      }
      .cloud-inbox-header {
        display: flex; align-items: center; justify-content: space-between;
        margin-bottom: 16px;
      }
      .cloud-inbox-header h2 { margin: 0; font-size: 18px; }
      .cloud-inbox-close {
        background: none; border: none; color: #aaa;
        font-size: 22px; cursor: pointer; padding: 0 8px;
      }
      .cloud-inbox-close:hover { color: #fff; }
      .cloud-inbox-item {
        display: flex; gap: 12px;
        padding: 12px;
        border-radius: 8px;
        background: rgba(255,255,255,0.04);
        margin-bottom: 8px;
        position: relative;
      }
      .cloud-inbox-item .thumb-box {
        flex: 0 0 60px; width: 60px; height: 60px;
        border-radius: 6px; overflow: hidden;
        background: rgba(0,0,0,0.35);
        display: flex; align-items: center; justify-content: center;
        font-size: 28px; line-height: 1;
      }
      .cloud-inbox-item .thumb-box img,
      .cloud-inbox-item .thumb-box model-viewer {
        width: 100%; height: 100%; object-fit: cover;
        display: block;
      }
      .cloud-inbox-item .body { flex: 1; min-width: 0; }
      .cloud-inbox-item .title { font-weight: 600; margin-bottom: 4px; }
      .cloud-inbox-item .title a {
        color: var(--accent, #ffc107); text-decoration: none; cursor: pointer;
      }
      .cloud-inbox-item .title a:hover { text-decoration: underline; }
      .cloud-inbox-item .msg   { font-size: 13px; color: #bbb; word-wrap: break-word; }
      .cloud-inbox-item .date  { font-size: 11px; color: #888; margin-top: 6px; }
      .cloud-inbox-item .new-pill {
        position: absolute; top: 8px; right: 8px;
        background: #4caf50; color: #fff;
        font-size: 10px; font-weight: 700;
        padding: 2px 6px; border-radius: 4px;
      }
      .cloud-inbox-empty {
        text-align: center; color: #888; padding: 32px 16px;
      }
    `;
    document.head.appendChild(s);
  }

  function installInboxButton() {
    if (_inboxBtnEl) return;
    const right = document.querySelector('#topbar .topbar-right');
    if (!right) return;
    _ensureInboxStyle();

    const btn = document.createElement('button');
    btn.id = 'cloud-inbox-btn';
    btn.type = 'button';
    btn.title = 'Inbox';
    btn.innerHTML = '📬<span id="cloud-inbox-badge">0</span>';
    // Place BEFORE the credits pill (which itself sits at firstChild
    // thanks to installCreditsPill's insertBefore).
    const credits = right.querySelector('#cloud-credits-pill');
    if (credits) right.insertBefore(btn, credits);
    else         right.insertBefore(btn, right.firstChild);

    btn.addEventListener('click', openInboxPopup);
    _inboxBtnEl = btn;
    _inboxBadgeEl = btn.querySelector('#cloud-inbox-badge');

    refreshInbox();
    if (_inboxPollTimer) clearInterval(_inboxPollTimer);
    _inboxPollTimer = setInterval(refreshInbox, 30_000);
  }

  async function refreshInbox() {
    if (!_inboxBadgeEl) return;
    try {
      const r = await fetch('/api/me/inbox', { credentials: 'include' });
      if (!r.ok) return;
      const j = await r.json();
      _inboxItems = Array.isArray(j.items) ? j.items : [];
      const unread = _inboxItems.filter((it) => !it.read).length;
      if (unread > 0) {
        _inboxBadgeEl.textContent = unread > 99 ? '99+' : String(unread);
        _inboxBadgeEl.style.display = 'block';
      } else {
        _inboxBadgeEl.style.display = 'none';
      }
    } catch { /* network blip — keep previous count */ }
  }
  window.__inboxRefresh = refreshInbox;

  function _inboxIconFor(kind) {
    switch (kind) {
      case 'sale':
      case 'market_sale':
      case 'approved':
      case 'market_approved': return '🛒';
      case 'rejected':
      case 'market_rejected': return '⚠';
      case 'reply':           return '💬';
      default:                return '📬';
    }
  }

  function _inboxKindTitle(kind) {
    switch (kind) {
      case 'market_approved':
      case 'approved': return 'Listing approved';
      case 'market_rejected':
      case 'rejected': return 'Listing rejected';
      case 'market_sale':
      case 'sale':     return 'Sale';
      case 'reply':    return 'Reply from support';
      default:         return '';
    }
  }

  function _escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function _escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function _formatInboxDate(iso) {
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleString();
    } catch { return ''; }
  }

  function openInboxPopup() {
    _ensureInboxStyle();
    // Close any existing instance first.
    document.querySelectorAll('.cloud-inbox-overlay').forEach((n) => n.remove());

    const overlay = document.createElement('div');
    overlay.className = 'cloud-inbox-overlay';
    const card = document.createElement('div');
    card.className = 'cloud-inbox-card';

    const header = document.createElement('div');
    header.className = 'cloud-inbox-header';
    header.innerHTML = `
      <h2>📬 Inbox</h2>
      <button class="cloud-inbox-close" type="button" aria-label="Close">×</button>
    `;
    card.appendChild(header);

    const list = document.createElement('div');
    list.className = 'cloud-inbox-list';
    if (!_inboxItems.length) {
      const empty = document.createElement('div');
      empty.className = 'cloud-inbox-empty';
      empty.textContent = 'No messages yet. Marketplace approvals + support replies will land here.';
      list.appendChild(empty);
    } else {
      _inboxItems.forEach((it) => {
        const row = document.createElement('div');
        row.className = 'cloud-inbox-item';
        const isUnread = !it.read;

        // ── Thumbnail / icon ────────────────────────────────────────
        // Notifications carrying asset_url + asset_kind render a 60×60
        // preview (image or <model-viewer>); reply / contextless notifs
        // fall back to the legacy emoji icon centered in the same box.
        let thumbHtml = `<div class="thumb-box">${_inboxIconFor(it.kind)}</div>`;
        if (it.asset_url) {
          if (it.asset_kind === 'image') {
            thumbHtml = `<div class="thumb-box"><img src="${_escAttr(it.asset_url)}" alt=""></div>`;
          } else if (it.asset_kind === 'mesh') {
            // model-viewer is already loaded globally for the marketplace.
            thumbHtml = `<div class="thumb-box"><model-viewer src="${_escAttr(it.asset_url)}" camera-controls disable-zoom interaction-prompt="none" auto-rotate ar="false" reveal="auto"></model-viewer></div>`;
          }
        }

        // ── Title (clickable when we know which job to open) ────────
        const kindTitle = _inboxKindTitle(it.kind);
        const displayTitle = it.subject || it.title || kindTitle || '(no subject)';
        const navKinds = new Set([
          'market_approved', 'market_rejected', 'market_sale',
          // Tolerate legacy short kinds (audit notes some sites emit just
          // 'approved' / 'rejected' / 'sale').
          'approved', 'rejected', 'sale',
        ]);
        const canNavigate = !!it.job_id && navKinds.has(it.kind);
        const titleInner = canNavigate
          ? `<a data-inbox-nav="1" data-job-id="${_escAttr(it.job_id)}" data-asset-kind="${_escAttr(it.asset_kind || '')}">${_escHtml(displayTitle)}</a>`
          : _escHtml(displayTitle);

        row.innerHTML = `
          ${thumbHtml}
          <div class="body">
            <div class="title">${titleInner}</div>
            <div class="msg"></div>
            <div class="date"></div>
          </div>
          ${isUnread ? '<span class="new-pill">NEW</span>' : ''}
        `;
        row.querySelector('.msg').textContent  = it.message || it.body || it.reply_body || '';
        row.querySelector('.date').textContent = _formatInboxDate(it.created_at || it.replied_at || '');

        if (canNavigate) {
          const a = row.querySelector('a[data-inbox-nav="1"]');
          if (a) a.addEventListener('click', (ev) => {
            ev.preventDefault();
            try { overlay.remove(); } catch {}
            const fn = window.__navigateToInboxAsset;
            if (typeof fn === 'function') fn(it.job_id, it.asset_kind);
          });
        }
        list.appendChild(row);
      });
    }
    card.appendChild(list);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    header.querySelector('.cloud-inbox-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    // Mark all currently-visible unread items as read.
    const unreadIds = _inboxItems.filter((it) => !it.read && it.id != null).map((it) => it.id);
    if (unreadIds.length) {
      fetch('/api/me/inbox/read', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: unreadIds }),
      }).then(() => {
        // Optimistic local update so the badge clears without waiting
        // for the next 30 s poll.
        _inboxItems.forEach((it) => { if (unreadIds.includes(it.id)) it.read = true; });
        if (_inboxBadgeEl) _inboxBadgeEl.style.display = 'none';
      }).catch(() => { /* will reconcile on next refreshInbox */ });
    }
  }

  function installLogoutButton() {
    if (document.querySelector('#cloud-account-section')) return;

    // The settings panel doesn't have a stable wrapper ID, but every
    // section is a `.settings-section-header` sibling of the boxes.
    // We anchor on the FIRST one ("Cloud Services") and insert our
    // Account section right before it so logout sits at the very top.
    const firstHeader = document.querySelector('.settings-section-header');
    if (!firstHeader) return;

    const header = document.createElement('div');
    header.className = 'settings-section-header';
    header.id = 'cloud-account-section';
    header.textContent = 'Account';

    const box = document.createElement('div');
    box.className = 'settings-box';
    box.innerHTML = `
      <div class="settings-box-title">Session</div>
      <div class="settings-box-desc">Sign out of MyFabmesh.AI Cloud on this device.</div>
    `;

    const btn = document.createElement('button');
    btn.id = 'cloud-logout-btn';
    btn.type = 'button';
    btn.textContent = 'Sign out';
    btn.style.cssText = [
      'margin-top:10px', 'padding:8px 18px',
      'background:transparent',
      'border:1px solid #e94560', 'border-radius:8px',
      'color:#e94560', 'font-weight:600', 'cursor:pointer',
      'font-size:13px', 'transition:all 0.15s',
    ].join(';');
    btn.onmouseenter = () => {
      btn.style.background = '#e94560'; btn.style.color = '#fff';
    };
    btn.onmouseleave = () => {
      btn.style.background = 'transparent'; btn.style.color = '#e94560';
    };
    btn.onclick = performSignOut;
    box.appendChild(btn);

    firstHeader.parentNode.insertBefore(header, firstHeader);
    firstHeader.parentNode.insertBefore(box, firstHeader);
  }

  /* ──────────────────────────────────────────────────────────────────
   * Marketplace publish flow — wires the "Publish to marketplace"
   * button (one for mesh step, one for image step) to a single modal
   * collecting title, description, price, licence. POSTs to
   * /api/market/publish and tells the user the listing is pending
   * admin review.
   *
   * The modal carries data-asset-kind="mesh|image" so the submit
   * handler picks the right URL + endpoint payload.
   * ────────────────────────────────────────────────────────────────── */
  // Cached Stripe Connect seller status — fetched lazily the first
  // time the publish modal opens, then reused for subsequent opens to
  // avoid hammering the worker. Shape mirrors /api/market/seller/status:
  //   { has_account, charges_enabled, payouts_enabled, details_submitted }
  let __sellerStatus = null;
  let __sellerStatusFetched = false;

  // Render the "Payout method" indicator at the bottom of the publish
  // modal based on (a) the listing price and (b) the cached seller
  // Connect status. Read-only — purely informational.
  function renderPayoutMethod(priceUSD, status) {
    const el = document.getElementById('pub-payout-method');
    if (!el) return;
    const price = Math.max(0, Number(priceUSD) || 0);
    if (price === 0) {
      el.textContent = 'Payout: free download (no payout).';
      el.style.color = 'var(--text-2)';
      return;
    }
    if (!status || !status.has_account) {
      el.textContent = 'Payout: platform credits (set up Stripe payouts in /account to receive cash instead).';
      el.style.color = 'var(--text-2)';
      return;
    }
    if (!status.charges_enabled) {
      el.textContent = 'Payout: credits (Stripe verification pending — switches to cash once active).';
      el.style.color = '#d4a017';
      return;
    }
    const cash = (price * 0.70).toFixed(2);
    el.textContent = 'Payout: cash via Stripe (~$' + cash + ' to your bank after 30% platform fee).';
    el.style.color = '#3fb950';
  }

  function installMarketplacePublish() {
    const modal = document.getElementById('modal-publish-asset');
    if (!modal) return;
    const meshBtn  = document.getElementById('ws-mesh-publish-btn');
    const imageBtn = document.getElementById('ws-image-publish-btn');
    const cancel = document.getElementById('pub-cancel');
    const go     = document.getElementById('pub-go');
    const close = () => modal.classList.add('hidden');
    cancel?.addEventListener('click', close);
    modal.addEventListener('click', (ev) => { if (ev.target === modal) close(); });

    function openFor(kind) {
      const p = (typeof state !== 'undefined') ? state?.currentProject : null;
      let payload = null;
      let previewUrl = '';
      if (kind === 'mesh') {
        const fn = window.getCurrentMeshObj;
        const m = (typeof fn === 'function') ? fn() : null;
        if (!m) {
          if (typeof window.showToast === 'function') window.showToast('Pick a mesh first.', 'error');
          return;
        }
        const jobId = m.id || m.jobId;
        if (!jobId) {
          if (typeof window.showToast === 'function') window.showToast('This mesh has no job ID — cannot publish.', 'error', 4000);
          return;
        }
        payload = { kind: 'mesh', jobId };
        previewUrl = m.path || m.url || '';
      } else {
        // Image: prefer the image actually shown in the big viewer
        // (previewImagePath — updated by version-thumb clicks). Fall
        // back to selectedImagePath (the last "Use this for 3D" choice)
        // or the <img id="step1-preview"> src as a last resort, so we
        // never publish a stale URL the user hasn't seen.
        let url = p?.previewImagePath || p?.selectedImagePath || '';
        if (!url) {
          const previewEl = document.getElementById('step1-preview');
          if (previewEl && previewEl.getAttribute('src')) {
            url = previewEl.getAttribute('src');
          }
        }
        console.log('[market.publish.openFor] image URL=', url,
          '(previewImagePath=', p?.previewImagePath,
          ', selectedImagePath=', p?.selectedImagePath, ')');
        if (!url) {
          if (typeof window.showToast === 'function') window.showToast('Pick an image first.', 'error');
          return;
        }
        payload = { kind: 'image', imageUrl: url };
        previewUrl = url;
      }
      modal.dataset.assetKind = kind;
      modal.dataset.publishPayload = JSON.stringify(payload);
      // Tweak the title + subtitle so users know whether they're
      // publishing a mesh or an image.
      const h2 = document.getElementById('pub-title-h2');
      if (h2) h2.innerHTML = kind === 'image'
        ? '\u{1F6D2} Publish image to marketplace'
        : '\u{1F6D2} Publish 3D mesh to marketplace';
      const titleInput = document.getElementById('pub-title');
      if (titleInput && !titleInput.value) titleInput.value = p?.name || '';
      // Populate top-right thumbnail. <img> for images, <model-viewer>
      // for meshes (works because the model-viewer script is loaded
      // for the rest of the app).
      const thumb = document.getElementById('pub-thumb');
      if (thumb) {
        if (previewUrl) {
          thumb.style.display = '';
          thumb.innerHTML = kind === 'image'
            ? `<img src="${previewUrl}" style="width:100%; height:100%; object-fit:cover;" />`
            : `<model-viewer src="${previewUrl}" camera-controls auto-rotate
                  style="width:100%; height:100%; background:#0a0a0e;"></model-viewer>`;
        } else {
          thumb.style.display = 'none';
          thumb.innerHTML = '';
        }
      }
      // Wire the live payout hint. Formula:
      //   sellerNet (USD) = priceUSD * (1 - 0.30 platform fee)  = priceUSD * 0.70
      //   credits         = sellerNet * 7 credits/EUR * 1.20 bonus
      //                   = priceUSD * 5.88
      // Guard against double-wiring across openFor() invocations.
      const priceInput = document.getElementById('pub-price');
      const hint = document.getElementById('pub-payout-hint');
      if (priceInput && hint) {
        const syncPayoutHint = () => {
          const p = Math.max(0, Number(priceInput.value) || 0);
          const credits = Math.round(p * 5.88);
          if (p === 0) {
            hint.textContent = 'Free listing — no credit payout.';
          } else {
            hint.textContent = 'You’ll earn ~' + credits +
              ' credits per sale (after 30% platform fee, +20% bonus paid in credits).';
          }
          renderPayoutMethod(p, __sellerStatus);
        };
        if (priceInput.dataset.payoutWired !== '1') {
          priceInput.addEventListener('input', syncPayoutHint);
          priceInput.dataset.payoutWired = '1';
        }
        syncPayoutHint();
      }
      // Fetch Stripe Connect status once per session and re-render the
      // payout indicator with the live answer. Network failure is silent
      // — we just leave the "credits" default in place.
      const showModal = () => {
        renderPayoutMethod(Number(priceInput?.value) || 0, __sellerStatus);
        modal.classList.remove('hidden');
      };
      if (__sellerStatusFetched) {
        showModal();
      } else {
        __sellerStatusFetched = true;
        fetch('/api/market/seller/status', { credentials: 'include' })
          .then(r => r.ok ? r.json() : null)
          .then(ss => {
            if (ss) {
              __sellerStatus = {
                has_account: !!ss.has_account,
                charges_enabled: !!ss.charges_enabled,
                payouts_enabled: !!ss.payouts_enabled,
                details_submitted: !!ss.details_submitted,
              };
            }
          })
          .catch(() => {})
          .finally(showModal);
      }
    }
    meshBtn?.addEventListener('click',  () => openFor('mesh'));
    imageBtn?.addEventListener('click', () => openFor('image'));

    // showToast may not exist (timing / scope) — wrap so failures are
    // never silent. The user reported clicking Submit and seeing
    // "nothing happen", which is the worst possible feedback. We
    // surface every code path via console + alert fallback so the
    // next debugging round has something to read.
    const notify = (msg, type) => {
      console[type === 'error' ? 'error' : 'log']('[market.publish]', msg);
      if (typeof window.showToast === 'function') {
        window.showToast(msg, type || 'info', 5000);
      } else {
        // Fallback: at least alert errors so the user gets feedback.
        if (type === 'error') alert(msg);
      }
    };
    go?.addEventListener('click', async (ev) => {
      ev.preventDefault();
      console.log('[market.publish] Submit clicked');
      const kind = modal.dataset.assetKind || 'mesh';
      let payload = null;
      try { payload = JSON.parse(modal.dataset.publishPayload || '{}'); } catch (e) {
        console.warn('[market.publish] payload parse failed:', e);
      }
      const title       = document.getElementById('pub-title')?.value.trim() || '';
      const description = document.getElementById('pub-description')?.value.trim() || '';
      const priceUSD    = Math.max(0, Number(document.getElementById('pub-price')?.value) || 0);
      const licence     = document.getElementById('pub-licence')?.value || 'personal';
      console.log('[market.publish] payload=', { kind, payload, title, priceUSD, licence });
      if (!title) {
        notify('Title is required.', 'error');
        return;
      }
      // Validate that we have the right id for the kind.
      if (kind === 'mesh' && !payload?.jobId) {
        notify('No mesh selected — close and pick a mesh first.', 'error');
        return;
      }
      if (kind === 'image' && !payload?.imageUrl) {
        notify('No image selected — close and pick an image first.', 'error');
        return;
      }
      go.disabled = true;
      go.textContent = 'Submitting…';
      try {
        const body = {
          title, description,
          price_cents: Math.round(priceUSD * 100),
          currency: 'USD', licence,
          asset_kind: kind,
        };
        if (kind === 'mesh')  body.jobId    = payload.jobId;
        if (kind === 'image') body.imageUrl = payload.imageUrl;
        console.log('[market.publish] POST body=', body);
        const r = await fetch('/api/market/publish', {
          method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        console.log('[market.publish] response status=', r.status);
        if (!r.ok) {
          let errBody = '';
          try { errBody = await r.text(); } catch {}
          throw new Error('HTTP ' + r.status + (errBody ? ' — ' + errBody.slice(0, 200) : ''));
        }
        close();
        notify('✓ Submitted for review — an admin will approve it shortly.', 'success');
        // Refresh the published-assets index so the 🛒 badge appears
        // immediately on the card we just published.
        if (typeof window.__publishedRefresh === 'function') {
          window.__publishedRefresh();
        }
      } catch (e) {
        console.error('[market.publish] failed:', e);
        notify('Publish failed: ' + (e?.message || e), 'error');
      } finally {
        go.disabled = false;
        go.textContent = 'Submit for review';
      }
    });
  }

  /* ──────────────────────────────────────────────────────────────────
   * Marketplace "published" badge on home grid cards. Fetches the
   * current user's listings once at boot (and after every publish
   * via window.__publishedRefresh), indexes them by job_id (mesh)
   * and asset_url (image), then a MutationObserver watches the home
   * grids and stamps a 🛒 badge on every card whose underlying asset
   * is already on the marketplace.
   *
   * Badge colour reflects status:
   *   pending  → yellow  "Pending approval"
   *   approved → green   "Live on marketplace"
   *   rejected → red     "Rejected — re-publish to retry"
   * ────────────────────────────────────────────────────────────────── */
  const _publishedIndex = {
    byJobId: new Map(),   // job_id → { status, listing_id }
    byUrl:   new Map(),   // asset_url → { status, listing_id }
  };
  async function _fetchPublishedIndex() {
    try {
      const r = await fetch('/api/me/published-assets', { credentials: 'include' });
      if (!r.ok) return;
      const j = await r.json();
      _publishedIndex.byJobId.clear();
      _publishedIndex.byUrl.clear();
      (j.items || []).forEach((it) => {
        // Skip rejected listings entirely — they should NOT badge a
        // card. The user already gets the rejection news via the
        // 📬 Inbox, so a card-level red signal is just noise.
        if (it.status === 'rejected') return;
        const meta = { status: it.status, listing_id: it.listing_id, kind: it.kind };
        if (it.job_id)   _publishedIndex.byJobId.set(it.job_id, meta);
        if (it.asset_url) _publishedIndex.byUrl.set(it.asset_url, meta);
      });
      _badgeAllCards();
      _syncPublishButtons();
    } catch { /* network blip — leave previous index */ }
  }
  window.__publishedRefresh = _fetchPublishedIndex;

  function _ensurePublishedBadgeStyle() {
    if (document.getElementById('cloud-published-badge-style')) return;
    const s = document.createElement('style');
    s.id = 'cloud-published-badge-style';
    s.textContent = `
      .published-badge {
        position: absolute; bottom: 6px; left: 6px;
        display: inline-flex; align-items: center; justify-content: center;
        width: 24px; height: 24px;
        font-size: 13px; line-height: 1;
        border-radius: 50%;
        border: 2px solid #1a1a1a;
        box-shadow: 0 2px 6px rgba(0,0,0,0.5);
        z-index: 4; pointer-events: auto;
        cursor: help;
        text-decoration: none;
        transition: transform 0.12s ease, box-shadow 0.12s ease;
      }
      a.published-badge { cursor: pointer; }
      a.published-badge:hover {
        transform: scale(1.1);
        box-shadow: 0 3px 9px rgba(0,0,0,0.6);
      }
      .published-badge.pending  { background:#ffb84d; color:#1a1a1a; }
      .published-badge.approved { background:#4caf50; color:#fff; }
      .published-badge.rejected { background:#f44336; color:#fff; }
      /* Cards are usually static-positioned; we need relative so the
         badge can absolute-position against the card. */
      .all-image-card, .all-mesh-card, .version-thumb { position: relative; }
      /* Version-strip thumbs are ~70-90px wide — shrink the badge so it
         doesn't dwarf the thumbnail. */
      #ws-image-versions .published-badge,
      #ws-mesh-versions  .published-badge {
        width: 18px; height: 18px; font-size: 11px;
        bottom: 4px; left: 4px;
      }
    `;
    document.head.appendChild(s);
  }
  function _badgeCard(card, meta) {
    if (!card) return;
    const existing = card.querySelector('.published-badge');
    // No meta = listing was dropped from the index (rejected, unpublished,
    // deleted). Remove any stale badge so the card returns to its clean
    // state.
    if (!meta) {
      if (existing) existing.remove();
      return;
    }
    if (existing) {
      // Compare current status class against the new meta.status. If
      // identical there's nothing to do — short-circuit so we don't
      // thrash the DOM. If different, update className + title +
      // textContent to reflect the new status (pending → approved).
      const currentStatus = existing.classList.contains('approved') ? 'approved'
                          : existing.classList.contains('pending')  ? 'pending'
                          : existing.classList.contains('rejected') ? 'rejected'
                          : '';
      if (currentStatus === meta.status) {
        // Still refresh href if listing_id became known since last pass.
        if (existing.tagName === 'A' && meta.listing_id && !existing.href) {
          existing.href = '/market?item=' + encodeURIComponent(meta.listing_id);
        }
        return;
      }
      existing.className = 'published-badge ' + meta.status;
      existing.title = 'Marketplace: ' + meta.status;
      existing.textContent = '🛒';
      if (existing.tagName === 'A' && meta.listing_id) {
        existing.href = '/market?item=' + encodeURIComponent(meta.listing_id);
      }
      return;
    }
    // If we know the listing_id, make the badge a clickable anchor that
    // opens the marketplace listing in a new tab. Otherwise fall back to
    // a non-clickable <span> (defensive — no broken /market?item= link).
    let b;
    if (meta.listing_id) {
      b = document.createElement('a');
      b.href = '/market?item=' + encodeURIComponent(meta.listing_id);
      b.target = '_blank';
      b.rel = 'noopener';
      // Card grids have their own click handler — stop propagation so
      // clicking the badge doesn't also select the card behind it.
      b.addEventListener('click', (e) => { e.stopPropagation(); });
    } else {
      b = document.createElement('span');
    }
    b.className = 'published-badge ' + meta.status;
    b.textContent = '🛒';
    b.title = 'Marketplace: ' + meta.status;
    card.appendChild(b);
  }
  // Walks every <img>/<model-viewer> under the three home grids, looks
  // up its src in _publishedIndex.byUrl, and stamps the badge on the
  // closest card ancestor when there's a match. Avoids requiring the
  // existing renderers to emit a `data-card-*` attribute.
  function _badgeAllCards() {
    _ensurePublishedBadgeStyle();
    const containers = [
      document.getElementById('all-images-grid'),
      document.getElementById('all-meshes-grid'),
      document.getElementById('ws-image-versions'),
      document.getElementById('ws-mesh-versions'),
    ].filter(Boolean);
    containers.forEach((root) => {
      root.querySelectorAll('img[src], model-viewer[src]').forEach((media) => {
        const rawSrc = media.getAttribute('src') || '';
        if (!rawSrc) return;
        // Version-strip thumbs use `file:///<path>?t=<mtime>` (cache-busted,
        // slashes normalized). Strip the file:/// prefix and ?t=... query so
        // the lookup matches the canonical asset URL the index was keyed by.
        const candidates = new Set([rawSrc]);
        let s = rawSrc.replace(/\?t=\d+$/, '');
        candidates.add(s);
        if (s.startsWith('file:///')) candidates.add(s.slice('file:///'.length));
        let meta = null;
        for (const k of candidates) {
          meta = _publishedIndex.byUrl.get(k);
          if (meta) break;
        }
        if (!meta) return;
        // Find the closest card-like ancestor. Home grids use
        // .all-image-card / .all-mesh-card; the workspace version
        // strips use .version-thumb.
        const card = media.closest('.all-image-card, .all-mesh-card, .version-thumb')
                   || media.parentElement;
        if (card) _badgeCard(card, meta);
      });
      // Second walker: any element carrying data-job-id (set by
      // renderImageVersions / renderMeshVersions on version-thumb).
      // URL-based matching misses these when the thumb file path on
      // disk diverges from the canonical asset_url (e.g. .png vs .webp,
      // local cache vs replicate.delivery). _badgeCard is idempotent so
      // double-walks don't double-badge.
      root.querySelectorAll('[data-job-id]').forEach((el) => {
        const jid = el.getAttribute('data-job-id');
        if (!jid) return;
        const meta = _publishedIndex.byJobId.get(jid);
        if (!meta) return;
        const card = el.closest('.all-image-card, .all-mesh-card, .version-thumb') || el;
        _badgeCard(card, meta);
      });
      // Third walker: sweep existing badges whose underlying asset is
      // NO LONGER in the index (rejected by admin, unpublished, removed).
      // For each such badge, hand a null meta to _badgeCard so the badge
      // is removed cleanly. This is what makes the 60s poll actually
      // reflect admin-side status changes without a page reload.
      root.querySelectorAll('.published-badge').forEach((badge) => {
        const card = badge.closest('.all-image-card, .all-mesh-card, .version-thumb')
                  || badge.parentElement;
        if (!card) return;
        // Re-derive the same lookup keys _badgeAllCards uses above.
        let stillIndexed = false;
        const media = card.querySelector('img[src], model-viewer[src]');
        if (media) {
          const rawSrc = media.getAttribute('src') || '';
          const candidates = new Set([rawSrc]);
          let s = rawSrc.replace(/\?t=\d+$/, '');
          candidates.add(s);
          if (s.startsWith('file:///')) candidates.add(s.slice('file:///'.length));
          for (const k of candidates) {
            if (_publishedIndex.byUrl.has(k)) { stillIndexed = true; break; }
          }
        }
        if (!stillIndexed) {
          const jobEl = card.matches('[data-job-id]') ? card : card.querySelector('[data-job-id]');
          const jid = jobEl?.getAttribute('data-job-id');
          if (jid && _publishedIndex.byJobId.has(jid)) stillIndexed = true;
        }
        if (!stillIndexed) _badgeCard(card, null);
      });
    });
    // Same tick: refresh publish-button disabled state. This means
    // every grid mutation (project switch, new asset added) also
    // re-evaluates whether the current selection is already published.
    _syncPublishButtons();
  }
  // Disable the workspace "Publish to marketplace" buttons when the
  // currently-selected mesh/image is already in _publishedIndex. Saves
  // the original textContent in dataset.originalLabel on first touch so
  // we can restore it when selection changes to an unpublished asset.
  //
  // Defensive guard: only treat as "already published" when the matched
  // entry has status pending or approved. Stale stub records (e.g. a
  // listing that was approved then deleted by admin, or a job_id collision
  // from legacy data) where status is missing or unexpected fall through
  // to "not published" so the user can re-publish.
  const _ACTIVE_PUBLISHED_STATUSES = new Set(['pending', 'approved']);
  function _syncPublishButtons() {
    const meshBtn  = document.getElementById('ws-mesh-publish-btn');
    const imageBtn = document.getElementById('ws-image-publish-btn');
    const apply = (btn, already) => {
      if (!btn) return;
      if (!btn.dataset.originalLabel) {
        btn.dataset.originalLabel = btn.textContent || '';
      }
      if (already) {
        btn.disabled = true;
        btn.title = 'Already published';
        btn.textContent = '✓ ' + btn.dataset.originalLabel.replace(/^✓\s*/, '');
      } else {
        btn.disabled = false;
        btn.title = '';
        btn.textContent = btn.dataset.originalLabel;
      }
    };
    // Mesh button — check current mesh by job_id, fall back to URL.
    let meshAlready = false;
    let meshDiag = { jobId: null, url: null, matchByJobId: null, matchByUrl: null };
    try {
      const fn = window.getCurrentMeshObj;
      const m = (typeof fn === 'function') ? fn() : null;
      if (m) {
        const jobId = m.id || m.jobId || null;
        const url   = m.path || m.url || '';
        const matchByJobId = jobId ? (_publishedIndex.byJobId.get(jobId) || null) : null;
        const matchByUrl   = url   ? (_publishedIndex.byUrl.get(url)   || null) : null;
        meshDiag = { jobId, url, matchByJobId, matchByUrl };
        const match = matchByJobId || matchByUrl;
        if (match && _ACTIVE_PUBLISHED_STATUSES.has(match.status)) meshAlready = true;
      }
    } catch { /* selection unavailable — leave button enabled */ }
    console.log('[syncPublishButtons] mesh', { ...meshDiag, disabled: meshAlready });
    apply(meshBtn, meshAlready);
    // Image button — check current image URL.
    let imageAlready = false;
    let imageDiag = { jobId: null, url: null, matchByJobId: null, matchByUrl: null };
    try {
      const p = (typeof state !== 'undefined') ? state?.currentProject : null;
      const url = p?.selectedImagePath || '';
      const matchByUrl = url ? (_publishedIndex.byUrl.get(url) || null) : null;
      imageDiag = { jobId: null, url, matchByJobId: null, matchByUrl };
      if (matchByUrl && _ACTIVE_PUBLISHED_STATUSES.has(matchByUrl.status)) imageAlready = true;
    } catch { /* same */ }
    console.log('[syncPublishButtons] image', { ...imageDiag, disabled: imageAlready });
    apply(imageBtn, imageAlready);
  }
  function _installPublishedBadgeWatcher() {
    const targets = [
      document.getElementById('all-images-grid'),
      document.getElementById('all-meshes-grid'),
      document.getElementById('ws-image-versions'),
      document.getElementById('ws-mesh-versions'),
    ].filter(Boolean);
    if (!targets.length) return;
    const obs = new MutationObserver(() => _badgeAllCards());
    targets.forEach((t) => obs.observe(t, { childList: true, subtree: true }));
    _badgeAllCards();
  }

  // Poll the published-index every 60s so badges follow admin status
  // changes (pending → approved → rejected) and unpublishes without
  // requiring a page reload. _fetchPublishedIndex calls _badgeAllCards,
  // which now also sweeps stale badges.
  function _startPublishedIndexPolling() {
    if (window.__publishedIndexPollHandle) return;
    window.__publishedIndexPollHandle = setInterval(_fetchPublishedIndex, 60_000);
  }

  // Force a fresh fetch of the published-asset index whenever the user
  // navigates to the mesh step or touches a mesh/publish control, so the
  // disabled state of the Publish button reflects reality at click time
  // (not whatever the 60s tick last saw). Throttled to 5s to avoid
  // hammering the endpoint on rapid UI interactions.
  let _lastPublishedRefreshAt = 0;
  function _maybeRefreshPublishedIndex() {
    const now = Date.now();
    if (now - _lastPublishedRefreshAt < 5000) return;
    _lastPublishedRefreshAt = now;
    _fetchPublishedIndex();
  }
  function _installPublishedRefreshTriggers() {
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      // Mesh step tab / publish buttons / any mesh tool button.
      if (t.closest('#ws-mesh-publish-btn') ||
          t.closest('#ws-image-publish-btn') ||
          t.closest('[data-step="mesh"]') ||
          t.closest('#step2-card') ||
          t.closest('#ws-mesh-versions') ||
          (t.closest('.tool-btn') && t.closest('.tool-btn').id?.startsWith('ws-mesh-'))) {
        _maybeRefreshPublishedIndex();
      }
    }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      applyOverrides();
      installMarketplacePublish();
      _fetchPublishedIndex();
      _installPublishedBadgeWatcher();
      _startPublishedIndexPolling();
      _installPublishedRefreshTriggers();
    });
  } else {
    applyOverrides();
    installMarketplacePublish();
    _fetchPublishedIndex();
    _installPublishedBadgeWatcher();
    _startPublishedIndexPolling();
    _installPublishedRefreshTriggers();
  }

  // The Settings / About modals sometimes lazy-inject content; re-apply
  // if they open after our first pass. A MutationObserver is overkill;
  // instead wait one frame after any click on either button.
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && (
      t.id === 'btn-settings' || t.closest?.('#btn-settings') ||
      t.id === 'btn-about'    || t.closest?.('#btn-about')
    )) {
      requestAnimationFrame(applyOverrides);
    }
  });
})();
