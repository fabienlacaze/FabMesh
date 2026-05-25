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

    // Adapt engine dropdowns to what Cloud actually wires.
    pruneEngineSelectors();
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyOverrides);
  } else {
    applyOverrides();
  }

  // The Settings modal sometimes lazy-injects content; re-apply if it
  // opens after our first pass. A MutationObserver is overkill; instead
  // wait one frame after any click on the settings button.
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && (t.id === 'btn-settings' || t.closest?.('#btn-settings'))) {
      requestAnimationFrame(applyOverrides);
    }
  });
})();
