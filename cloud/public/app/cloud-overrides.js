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
    const proto = HTMLImageElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'src');
    if (desc && desc.get && desc.set) {
      Object.defineProperty(proto, 'src', {
        get() { return desc.get.call(this); },
        set(v) { desc.set.call(this, stripPrefix(v)); },
        configurable: true,
      });
    }
    // For images injected via innerHTML the setter doesn't fire — patch
    // them after the fact via a MutationObserver.
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (!(n instanceof Element)) continue;
          if (n.tagName === 'IMG') {
            const raw = n.getAttribute('src');
            if (raw && /^file:\/{2,3}(?=https?:|blob:|data:)/i.test(raw)) {
              n.setAttribute('src', stripPrefix(raw));
            }
          }
          n.querySelectorAll?.('img').forEach((i) => {
            const raw = i.getAttribute('src');
            if (raw && /^file:\/{2,3}(?=https?:|blob:|data:)/i.test(raw)) {
              i.setAttribute('src', stripPrefix(raw));
            }
          });
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

    // Defensive — if the Control API box ends up outside the AI Assistant
    // section in a future refactor, hide it explicitly too.
    hideById('set-control-api-box');

    // Inject the credits pill into the topbar (Cloud-only — desktop has
    // unlimited local GPU and doesn't need this).
    installCreditsPill();

    // Sign-out button next to the credits pill. Sessions are stored in
    // non-httpOnly `sb-<ref>-auth-token` cookies (set by LoginForm.tsx
    // and read by worker.ts:getSessionUser) so JS can delete them.
    installLogoutButton();

    // Adapt engine dropdowns to what Cloud actually wires.
    pruneEngineSelectors();

    // Strip Desktop-only bits from the About modal.
    pruneAboutModal();

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
    // the modal pills.
    _wrapTopbarRefresh();
    // Refresh modal balance pills the first time any tool modal opens
    // (cheaper than polling) — picks up balance changes from other
    // tabs/devices the user might have running.
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

    // Hide buttons that need a Three.js sculpting/selection editor in
    // the browser (Sculpt, Paint vertex, Select) — not feasible to
    // port in cloud without a major UI effort. Same for Re-Texture
    // (TRELLIS-2 full): cloud uses the regular Generate-3D path.
    _hideDesktopOnlyButtons();

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
      if (!r.ok) return;
      const d = await r.json();
      const io = d?.image_op || {};
      window.__modalWarm = !!io.warm;
      window.__modalExpectedSeconds = io.warm
        ? (io.expected_seconds_warm || 30)
        : (io.expected_seconds_cold || 150);
      window.__modalSecondsSinceLastSuccess = io.seconds_since_last_success;
      // Notify any listener (AI tool modals can update their pill).
      try { window.dispatchEvent(new CustomEvent('modal-status', { detail: io })); }
      catch (_) {}
    } catch (_) { /* ignore */ }
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
    'ws-mesh-subdivide-btn':    1,   // Wave 4.2
    'ws-mesh-aligntex-btn':     1,   // Wave 4.2 (no-op for now)
    'ws-mesh-material-btn':     1,   // Wave 4.2 (PBR normalize)
    'ws-mesh-retexture-btn':    1,   // Wave 4.2 (atlas swap)
  };

  // Buttons we hide on cloud because they need a Three.js sculpting /
  // selection editor in the browser (gros chantier, Wave 5+ if ever).
  // Better to remove the affordance than show a "Desktop-only" toast
  // on every click.
  const CLOUD_HIDE_BUTTONS = [
    'ws-mesh-sculpt-btn',
    'ws-mesh-paintvert-btn',
    'ws-mesh-selectface-btn',
    'ws-mesh-trellis2-btn',  // full TRELLIS-2 retexture — explained in shim error
    // "Open in Blender" / "Show in folder" only work on Desktop where
    // we can spawn `blender` and reveal the file on the user's FS.
    // In the browser they'd 404; just hide them on cloud.
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
    'modal-auto-inpaint':      { cost: 'auto_inpaint', applyBtn: 'ai-go' },
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
    mask_inpaint: 3, upscale_image: 2,
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

    // Slim the credit line down to just the studio name. The licence
    // list + infra mention were too much detail for the contact panel
    // and don't help end-users — keep that info for the legal pages.
    document.querySelectorAll('.about-card p').forEach((p) => {
      if (!p.textContent) return;
      if (p.textContent.includes('Crash reports sent anonymously via Sentry')
       || p.textContent.includes('OpenRAIL')
       || p.textContent.includes('MIT / Apache')) {
        p.textContent = 'An Ayros Studio production.';
      }
    });
  }

  /* ──────────────────────────────────────────────────────────────────
   * Trim the image / 3D engine selectors to the engines we actually
   * route to a Replicate model. The Desktop renderer ships with options
   * for legacy local engines, Meshy.ai, etc. that have no equivalent
   * cloud handler.
   * ────────────────────────────────────────────────────────────────── */
  function pruneEngineSelectors() {
    // 3D engine — cloud only supports trellis2_native (via fishwowater/
    // trellis2). The "MyFabmesh.AI Legacy" (hi3dgen) and "Meshy.ai"
    // options aren't wired server-side and would 404.
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
    // wired. The "Meshy.ai" / "Pollinations" / "Local SD" options the
    // desktop exposes aren't backed by a cloud handler.
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyOverrides);
  } else {
    applyOverrides();
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
