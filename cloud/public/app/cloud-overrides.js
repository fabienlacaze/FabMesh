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
  let _redirectedFor401 = false;
  const _origFetch = window.fetch.bind(window);
  window.fetch = async function patchedFetch(input, init) {
    const res = await _origFetch(input, init);
    try {
      const url = typeof input === 'string' ? input
                : input instanceof URL ? input.href
                : input?.url ?? '';
      const sameOriginApi = url.startsWith('/api/')
        || url.startsWith(window.location.origin + '/api/');
      if (res.status === 401 && sameOriginApi && !_redirectedFor401) {
        _redirectedFor401 = true;
        const next = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.replace(`/login?next=${next}`);
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
    // Resolution / Face Fix / Sym. Auto are canvas-only at the moment
    // (no Modal call) → no badge so they read as "free" by absence.
  };

  function _ensureCostBadgeStyle() {
    if (document.getElementById('cloud-cost-badge-style')) return;
    const style = document.createElement('style');
    style.id = 'cloud-cost-badge-style';
    style.textContent = `
      .cloud-cost-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 30px;
        height: 24px;
        padding: 0 9px 0 7px;
        margin-left: 8px;
        background: linear-gradient(135deg, #ffd84a, #f5a623);
        color: #1a1a1a;
        border: 1px solid rgba(255, 255, 255, 0.3);
        border-radius: 999px;
        font-size: 14px;
        font-weight: 800;
        line-height: 1;
        font-variant-numeric: tabular-nums;
        vertical-align: middle;
        box-shadow: 0 2px 6px rgba(245, 166, 35, 0.5),
                    inset 0 1px 0 rgba(255, 255, 255, 0.4);
        text-shadow: 0 1px 0 rgba(255, 255, 255, 0.3);
      }
      /* Inline SVG bolt — dark gold fill with white outline + drop
         shadow. Much higher contrast than the emoji ⚡ which renders
         pale yellow against the gold badge background. */
      .cloud-cost-badge::before {
        content: '';
        display: inline-block;
        width: 11px; height: 16px;
        margin-right: 4px;
        background: no-repeat center/contain
          url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 32"><path d="M14 0 L0 18 L9 18 L7 32 L24 12 L14 12 Z" fill="%231a1a1a" stroke="%23ffffff" stroke-width="1.5" stroke-linejoin="round"/></svg>');
        filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.35));
      }
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
   * Live mesh-cost meter — sums data-credits on the active preset +
   * every checked option, rewrites the "Generate 3D (N credits)" pill.
   * Re-runs on any change in the advanced texture options.
   * ────────────────────────────────────────────────────────────────── */
  function installMeshCostMeter() {
    const preset = document.getElementById('ws-trellis2-preset');
    const valueEl = document.getElementById('ws-mesh-cost-value');
    if (!preset || !valueEl) return;
    const optionIds = [
      'ws-trellis2-multiref', 'ws-trellis2-refine', 'ws-trellis2-rectify',
      'ws-trellis2-smooth',   'ws-trellis2-quality-plus',
      'ws-trellis2-ultra-q',  'ws-trellis2-ultra-hd', 'ws-trellis2-face-fix',
    ];

    function recompute() {
      let total = parseInt(preset.selectedOptions[0]?.dataset?.credits || '1', 10);
      for (const id of optionIds) {
        const el = document.getElementById(id);
        if (el?.checked) total += parseInt(el.dataset.credits || '0', 10);
      }
      valueEl.textContent = String(total);
    }

    preset.addEventListener('change', recompute);
    for (const id of optionIds) {
      document.getElementById(id)?.addEventListener('change', recompute);
    }
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

    // Rewrite the bottom credit line so it doesn't claim Sentry crash
    // reporting that we haven't wired up yet on Cloud.
    document.querySelectorAll('.about-card p').forEach((p) => {
      if (p.textContent && p.textContent.includes('Crash reports sent anonymously via Sentry')) {
        p.textContent = 'An Ayros Studio production · MIT / Apache / BSD / OpenRAIL++-M models · runs on Cloudflare Workers + Replicate GPU.';
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
        eng3d.options[0].textContent = 'MyFabmesh.AI 3D Native (cloud GPU · TRELLIS-2 · ~100s · 1 credit)';
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
        engImg.options[0].textContent = 'MyFabmesh.AI Image Engine (cloud GPU · RealVisXL V4 · 1 credit/image)';
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
    pill.textContent = '… credits';
    pill.style.cssText = [
      'display:inline-flex', 'align-items:center', 'gap:6px',
      'padding:5px 12px', 'margin-right:8px',
      'background:linear-gradient(135deg,#e94560,#a855f7)',
      'color:#ffffff', 'border-radius:999px',
      'font-size:12px', 'font-weight:600',
      'text-decoration:none', 'cursor:pointer',
      'box-shadow:0 1px 4px rgba(168,85,247,0.4)',
    ].join(';');
    right.insertBefore(pill, right.firstChild);
    _creditsPillEl = pill;

    // First fetch + polling
    refreshCreditsPill();
    if (_creditsPollTimer) clearInterval(_creditsPollTimer);
    _creditsPollTimer = setInterval(refreshCreditsPill, 30_000);
  }

  async function refreshCreditsPill() {
    if (!_creditsPillEl) return;
    try {
      const r = await fetch('/api/me', { credentials: 'include' });
      if (!r.ok) {
        _creditsPillEl.textContent = 'Sign in';
        _creditsPillEl.href = '/login';
        return;
      }
      const j = await r.json();
      const credits = j?.user?.credits;
      if (typeof credits === 'number') {
        _creditsPillEl.textContent = `⚡ ${credits} credit${credits === 1 ? '' : 's'}`;
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
  function performSignOut() {
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
