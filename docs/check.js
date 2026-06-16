/* MyFabmesh.AI — browser-based compatibility check.
   Pure JS, no dependencies. Detects what it can from navigator + WebGL,
   then renders a verdict (Full / Standard / Lite / Cloud) and the
   matching call-to-action buttons.
*/
(function () {
  'use strict';

  function setRow(id, text, cls) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = 'check-val ' + (cls || '');
  }

  function detectOS() {
    var ua = navigator.userAgent || '';
    if (/Windows NT 10|Windows NT 11/.test(ua)) return 'Windows 10/11';
    if (/Windows NT 6\.[123]/.test(ua)) return 'Windows 7/8/8.1';
    if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
    if (/Linux/.test(ua)) return 'Linux';
    if (/Android/.test(ua)) return 'Android';
    if (/iPhone|iPad|iOS/.test(ua)) return 'iOS';
    return 'Unknown';
  }

  function detectGPU() {
    try {
      var canvas = document.createElement('canvas');
      var gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!gl) return null;
      var dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (!dbg) return null;
      var renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '';
      var vendor   = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || '';
      return { renderer: renderer, vendor: vendor };
    } catch (e) {
      return null;
    }
  }

  function lookupGPU(rendererString) {
    if (!rendererString || !window.GPU_DB) return null;
    for (var i = 0; i < window.GPU_DB.length; i++) {
      var e = window.GPU_DB[i];
      if (rendererString.indexOf(e.match) !== -1) {
        return Object.assign({}, e, { fullName: rendererString });
      }
    }
    return { fullName: rendererString, vendor: 'Unknown', vram: null };
  }

  function classifyVerdict(os, gpu) {
    // Windows + NVIDIA only path for Desktop.
    if (!/Windows 10\/11/.test(os))      return 'cloud';
    if (!gpu || gpu.vendor !== 'NVIDIA') return 'cloud';
    if (gpu.vram === null)               return 'unknown';
    if (gpu.vram >= 15 * 1024)           return 'full';
    if (gpu.vram >= 11 * 1024)           return 'standard';
    if (gpu.vram >= 6  * 1024)           return 'lite';
    return 'cloud';
  }

  function render() {
    var os = detectOS();
    setRow('r-os', os, os === 'Windows 10/11' ? 'ok' : 'warn');

    var gpuRaw = detectGPU();
    var gpu = gpuRaw ? lookupGPU(gpuRaw.renderer) : null;
    if (gpu) {
      setRow('r-gpu', gpu.fullName,
        gpu.vendor === 'NVIDIA' ? 'ok' :
        gpu.vendor === 'Unknown' ? 'warn' : 'bad');
      if (gpu.vram !== null) {
        var gb = (gpu.vram / 1024).toFixed(1) + ' GB';
        var cls = gpu.vram >= 12 * 1024 ? 'ok' :
                  gpu.vram >= 6  * 1024 ? 'warn' : 'bad';
        setRow('r-vram', gb, cls);
      } else {
        setRow('r-vram', 'unknown', 'warn');
      }
    } else {
      setRow('r-gpu', 'Not detected', 'bad');
      setRow('r-vram', '—', 'bad');
    }

    setRow('r-cores', (navigator.hardwareConcurrency || '?') + ' threads',
      (navigator.hardwareConcurrency >= 4) ? 'ok' : 'warn');

    var hasWebGPU = !!navigator.gpu;
    setRow('r-webgpu', hasWebGPU ? 'Available' : 'Not available',
      hasWebGPU ? 'ok' : 'warn');

    // Verdict
    var v = classifyVerdict(os, gpu);
    var box = document.getElementById('verdict');
    var cta = document.getElementById('check-cta-row');
    box.classList.remove('verdict-full', 'verdict-std', 'verdict-lite', 'verdict-cloud');

    if (v === 'full') {
      box.classList.add('verdict-full');
      box.textContent = '✓ Compatible — Full mode unlocked';
      cta.innerHTML =
        '<a href="index.html#buy-desktop" class="btn-primary">Buy Desktop — 49,99 € TTC</a>' +
        '<a href="index.html#cloud-soon" class="btn-ghost">Or try Cloud</a>';
    } else if (v === 'standard') {
      box.classList.add('verdict-std');
      box.textContent = '✓ Compatible — Standard mode';
      cta.innerHTML =
        '<a href="index.html#buy-desktop" class="btn-primary">Buy Desktop — 49,99 € TTC</a>' +
        '<a href="index.html#cloud-soon" class="btn-ghost">Or try Cloud</a>';
    } else if (v === 'lite') {
      box.classList.add('verdict-lite');
      box.textContent = '⚠ Compatible — Lite mode only';
      cta.innerHTML =
        '<a href="index.html#buy-desktop" class="btn-primary">Buy Desktop — 49,99 € TTC</a>' +
        '<a href="index.html#cloud-soon" class="btn-ghost">Cloud may be smoother</a>';
    } else if (v === 'unknown') {
      box.classList.add('verdict-std');
      box.textContent = '? GPU model not in our database';
      cta.innerHTML =
        '<a href="index.html#buy-desktop" class="btn-ghost">Buy Desktop (at your own risk)</a>' +
        '<a href="index.html#cloud-soon" class="btn-primary">Try Cloud first (safer)</a>';
    } else {
      box.classList.add('verdict-cloud');
      box.textContent = '✗ Not compatible for Desktop — use Cloud';
      cta.innerHTML =
        '<a href="index.html#cloud-soon" class="btn-primary">Open Cloud — works on your machine</a>';
    }
  }

  // Run after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
})();
