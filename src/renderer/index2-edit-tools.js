/* index2-edit-tools.js
 *
 * Classic-script port of the legacy Draw Mask + Clone Stamp modal logic
 * from src/renderer/index.html. Loaded BEFORE index2.js so that index2.js
 * (an ES module) can call:
 *   window.openMaskToolFor(imagePath, projectName, onSuccess)
 *   window.openCloneToolFor(imagePath, projectName, onSuccess)
 *
 * Two changes from the legacy:
 *  - The "selected image" comes from the imagePath argument, not a global.
 *  - After a successful save, we call onSuccess(newPath) instead of touching
 *    the legacy gallery / refine sub-tabs / jobs panel.
 *
 * Legacy helpers (addJob, completeJob, refreshActiveGallery, showLog, etc.)
 * are stubbed out below as no-ops or console.log.
 */
(function () {
  'use strict';

  // ----- Jobs helpers: delegate to the real queue owned by index2.js -----
  // index2.js (ES module) exposes pushJob/completeJob/renderJobs via
  // window.fabmeshJobs. If that's not ready (script order problem) we fall
  // back to stubs so the edit tools keep working without progress UI.
  function addJob(label, kind, imgPath) {
    console.log('[edit-tools] addJob:', label, kind, imgPath);
    if (window.fabmeshJobs && typeof window.fabmeshJobs.push === 'function') {
      // Expected duration: first run of RealVis+Inpaint can take 2-3 min,
      // subsequent runs ~5-15s. We give 180s so the progress bar fills
      // smoothly for the cold path and just caps at 90% for the warm one.
      var params = {
        Engine: 'FabMesh Inpaint Engine (local)',
        'Source image': imgPath ? imgPath.split(/[/\\]/).pop() : '--',
      };
      return window.fabmeshJobs.push(label, null, params, 180000);
    }
    return { id: 'stub-' + Date.now(), progress: 0 };
  }
  function completeJob(id, ok, errorMessage) {
    console.log('[edit-tools] completeJob:', id, ok);
    if (window.fabmeshJobs && typeof window.fabmeshJobs.complete === 'function') {
      window.fabmeshJobs.complete(id, ok, errorMessage);
    }
  }
  function renderJobs() {
    if (window.fabmeshJobs && typeof window.fabmeshJobs.render === 'function') {
      window.fabmeshJobs.render();
    }
  }
  function showLog(msg, level) {
    console.log('[edit-tools][' + (level || 'info') + ']', msg);
    if (level === 'error') {
      try { alert(msg); } catch (e) {}
    }
  }
  function refreshActiveGallery() { /* no-op (handled by onSuccess) */ }
  function refreshGalleryImages() { /* no-op (handled by onSuccess) */ }

  // Per-tool active context: which image we are editing + success callback.
  var maskCtx = { imagePath: null, projectName: null, onSuccess: null };
  var cloneCtx = { imagePath: null, projectName: null, onSuccess: null };

  // ===========================================================
  //                      CLONE STAMP MODAL  (CanvasManager)
  // ===========================================================
  var cloneModal = document.getElementById('clone-modal');
  var cloneCanvas = document.getElementById('clone-canvas');
  // flipMode: 0=none, 1=horizontal, 2=vertical, 3=both
  var cloneFlipMode = 0;
  // Source sampling mode: 'live' = clone from the CURRENT (modified) canvas,
  // refreshed at the start of each stroke so previous edits are usable as
  // source; 'original' = always clone from the image loaded at open.
  // Default 'live' (modified) per user request.
  var cloneSourceMode = 'live';
  var _cloneMgr = null;

  // Clone-stamp-specific state (NOT managed by CanvasManager)
  var cloneState = {
    sourcePoint: null,
    sourceImageData: null,
    offset: null,
    brushSize: 50,
    hardness: 50,
  };

  function cloneStampPaint(ctx, x, y) {
    if (!cloneState.sourcePoint || !cloneState.sourceImageData || !cloneState.offset) return;
    var r = cloneState.brushSize / 2;
    var hardness = cloneState.hardness / 100;
    var src = cloneState.sourceImageData;
    var cw = cloneCanvas.width, ch = cloneCanvas.height;
    var dst = ctx.getImageData(
      Math.max(0, x - r), Math.max(0, y - r),
      Math.min(cw - Math.max(0, x - r), r * 2),
      Math.min(ch - Math.max(0, y - r), r * 2)
    );
    var dW = dst.width, dH = dst.height;
    var ox = Math.max(0, x - r), oy = Math.max(0, y - r);

    for (var py = 0; py < dH; py++) {
      for (var px = 0; px < dW; px++) {
        var dx = (ox + px) - x, dy = (oy + py) - y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > r) continue;
        var t = dist / r;
        var a = 1 - t * t;
        a *= hardness + (1 - hardness) * (1 - t);
        if (a <= 0) continue;

        var rawSx = (ox + px) + cloneState.offset.dx;
        var rawSy = (oy + py) + cloneState.offset.dy;
        var sxi = rawSx, syi = rawSy;
        if (cloneFlipMode === 1 || cloneFlipMode === 3)
          sxi = cloneState.sourcePoint.x - (rawSx - cloneState.sourcePoint.x);
        if (cloneFlipMode === 2 || cloneFlipMode === 3)
          syi = cloneState.sourcePoint.y - (rawSy - cloneState.sourcePoint.y);
        sxi = Math.round(sxi); syi = Math.round(syi);
        if (sxi < 0 || syi < 0 || sxi >= src.width || syi >= src.height) continue;

        var sIdx = (syi * src.width + sxi) * 4;
        var dIdx = (py * dW + px) * 4;
        dst.data[dIdx]     = dst.data[dIdx]     * (1 - a) + src.data[sIdx]     * a;
        dst.data[dIdx + 1] = dst.data[dIdx + 1] * (1 - a) + src.data[sIdx + 1] * a;
        dst.data[dIdx + 2] = dst.data[dIdx + 2] * (1 - a) + src.data[sIdx + 2] * a;
        dst.data[dIdx + 3] = dst.data[dIdx + 3] * (1 - a) + src.data[sIdx + 3] * a;
      }
    }
    ctx.putImageData(dst, ox, oy);
  }

  function cloneShowError(msg) {
    var el = document.getElementById('clone-error');
    if (!el) return;
    el.textContent = '\u2717  ' + msg;
    el.style.display = 'block';
    clearTimeout(cloneShowError._t);
    cloneShowError._t = setTimeout(function () { el.style.display = 'none'; }, 4000);
  }
  window.cloneShowError = cloneShowError;

  function _updateSourceMarkerOnMove(e, x, y, mgr) {
    var srcEl = document.getElementById('clone-source-marker');
    if (!srcEl) return;
    if (!cloneState.sourcePoint) { srcEl.style.display = 'none'; return; }
    var rect = cloneCanvas.getBoundingClientRect();
    var scaleX = rect.width / cloneCanvas.width || 1;
    var displaySize = Math.max(4, cloneState.brushSize * scaleX);
    var sx, sy;
    if (cloneState.offset) {
      sx = x + cloneState.offset.dx;
      sy = y + cloneState.offset.dy;
    } else {
      sx = cloneState.sourcePoint.x;
      sy = cloneState.sourcePoint.y;
    }
    var centerX = rect.left + sx * scaleX;
    var centerY = rect.top + sy * scaleX;
    // Hide if outside the canvas bounds
    if (centerX < rect.left || centerX > rect.right || centerY < rect.top || centerY > rect.bottom) {
      srcEl.style.display = 'none';
      return;
    }
    srcEl.style.width = displaySize + 'px';
    srcEl.style.height = displaySize + 'px';
    srcEl.style.left = (centerX - displaySize / 2) + 'px';
    srcEl.style.top = (centerY - displaySize / 2) + 'px';
    srcEl.style.display = 'block';
  }

  function _closeClone() {
    cloneModal.classList.add('hidden');
    if (_cloneMgr) { _cloneMgr.loupeEnabled = false; }
    var l = document.getElementById('clone-loupe');
    if (l) l.style.display = 'none';
  }

  function _updateCloneSourceBtn() {
    var b = document.getElementById('clone-source-toggle');
    if (!b) return;
    var live = (cloneSourceMode === 'live');
    b.textContent = live ? 'Source: Modified' : 'Source: Original';
    b.classList.toggle('tool-active', live);
    b.title = live
      ? 'Source = modified image (your edits are clonable). Click for Original.'
      : 'Source = original image loaded at open. Click for Modified.';
  }

  if (cloneCanvas) {
    _cloneMgr = new window.CanvasManager({
      canvas: cloneCanvas,
      container: document.getElementById('clone-canvas-container'),
      undoBtn: document.getElementById('clone-undo'),
      redoBtn: document.getElementById('clone-redo'),
      resetBtn: document.getElementById('clone-reset'),
      loupeBtn: document.getElementById('clone-loupe-toggle'),
      brushCursor: document.getElementById('clone-brush-cursor'),
      brushSizeGetter: function () { return cloneState.brushSize; },
      rightClickPan: true,
      // Ctrl+click = set source, normal click = start cloning
      onMouseDown: function (ctx, x, y, e, mgr) {
        if (e.ctrlKey || e.metaKey) {
          cloneState.sourcePoint = { x: Math.round(x), y: Math.round(y) };
          cloneState.offset = null;
          var statusEl = document.getElementById('clone-status');
          if (statusEl) statusEl.textContent = 'Source set at (' + Math.round(x) + ', ' + Math.round(y) + ') - now click & drag to clone';
          var sm = document.getElementById('clone-source-marker');
          if (sm) sm.style.display = 'none';
          return false; // don't paint
        }
        if (!cloneState.sourcePoint) {
          cloneShowError('Set source first with Ctrl+Click');
          return false;
        }
        cloneState.offset = {
          dx: cloneState.sourcePoint.x - Math.round(x),
          dy: cloneState.sourcePoint.y - Math.round(y),
        };
        // Refresh the source buffer at STROKE START per the source mode:
        // 'live' snapshots the current (modified) canvas so prior edits are
        // clonable, while staying stable within this stroke (no self-smear);
        // 'original' uses the frozen image captured at open.
        cloneState.sourceImageData = (cloneSourceMode === 'live')
          ? ctx.getImageData(0, 0, mgr.w, mgr.h)
          : cloneState.originalImageData;
        // Don't paint here — let CanvasManager pushUndo first, then onPaint handles the first dab
        return undefined;
      },
      // Line interpolation between points
      onPaint: function (ctx, x, y, lastPt, mgr) {
        x = Math.round(x); y = Math.round(y);
        if (!lastPt) { cloneStampPaint(ctx, x, y); return; }
        var dx = x - Math.round(lastPt.x), dy = y - Math.round(lastPt.y);
        var dist = Math.sqrt(dx * dx + dy * dy);
        var step = Math.max(1, cloneState.brushSize / 4);
        var steps = Math.ceil(dist / step);
        for (var i = 1; i <= steps; i++) {
          var t = i / steps;
          cloneStampPaint(ctx,
            Math.round(lastPt.x + dx * t),
            Math.round(lastPt.y + dy * t)
          );
        }
      },
      // Update source marker overlay on mouse move
      onMouseMove: function (e, x, y, mgr) {
        _updateSourceMarkerOnMove(e, x, y, mgr);
      },
    });

    // Sliders
    var brushSlider = document.getElementById('clone-brush-size');
    if (brushSlider) brushSlider.addEventListener('input', function (e) {
      cloneState.brushSize = parseInt(e.target.value);
      var v = document.getElementById('clone-brush-val');
      if (v) v.textContent = e.target.value;
    });
    var hardSlider = document.getElementById('clone-hardness');
    if (hardSlider) hardSlider.addEventListener('input', function (e) {
      cloneState.hardness = parseInt(e.target.value);
      var v = document.getElementById('clone-hardness-val');
      if (v) v.textContent = e.target.value;
    });

    // Flip toggle: cycles None / H / V / Both
    var cFlip = document.getElementById('clone-flip-toggle');
    if (cFlip) cFlip.addEventListener('click', function () {
      cloneFlipMode = (cloneFlipMode + 1) % 4;
      var labels = ['Flip: Off', 'Flip: H', 'Flip: V', 'Flip: HV'];
      cFlip.textContent = labels[cloneFlipMode];
      cFlip.classList.toggle('tool-active', cloneFlipMode > 0);
    });

    // Source toggle: modified (live) vs original image as clone source.
    var cSrc = document.getElementById('clone-source-toggle');
    if (cSrc) cSrc.addEventListener('click', function () {
      cloneSourceMode = (cloneSourceMode === 'live') ? 'original' : 'live';
      _updateCloneSourceBtn();
    });

    // Escape
    document.addEventListener('keydown', function (e) {
      if (!cloneModal || cloneModal.classList.contains('hidden')) return;
      if (e.key === 'Escape') _closeClone();
    });

    // Close / Cancel
    var cCancel = document.getElementById('clone-cancel');
    var cClose = document.getElementById('clone-modal-close');
    if (cCancel) cCancel.addEventListener('click', _closeClone);
    if (cClose) cClose.addEventListener('click', _closeClone);

    // Save
    var cSave = document.getElementById('clone-save');
    if (cSave) cSave.addEventListener('click', function () {
      var imgPath = cloneCtx.imagePath;
      if (!imgPath) return;
      var dataUrl = _cloneMgr.toDataURL();
      var job = addJob('Clone Stamp save', 'clone', imgPath);
      job.progress = 50;
      renderJobs();
      Promise.resolve()
        .then(function () {
          return window.meshyAPI.saveImageDataUrl({ basePath: imgPath, dataUrl: dataUrl, suffix: 'cloned' });
        })
        .then(function (result) {
          if (result && result.success) {
            completeJob(job.id, true);
            showLog('Cloned image saved: ' + result.filename, 'success');
            _closeClone();
            if (cloneCtx.onSuccess) {
              try { cloneCtx.onSuccess(result.newPath || result.filename || null); } catch (e) {}
            }
          } else {
            completeJob(job.id, false);
            showLog('Save failed: ' + ((result && result.error) || 'unknown'), 'error');
          }
        })
        .catch(function (e) {
          completeJob(job.id, false);
          showLog('Save error: ' + e.message, 'error');
        });
    });
  }

  function openCloneStampInternal(imagePath, projectName, onSuccess) {
    if (!cloneModal || !cloneCanvas || !_cloneMgr) {
      console.warn('[edit-tools] Clone modal not present in DOM');
      return;
    }
    cloneCtx.imagePath = imagePath;
    cloneCtx.projectName = projectName || null;
    cloneCtx.onSuccess = typeof onSuccess === 'function' ? onSuccess : null;

    cloneModal.classList.remove('hidden');
    _cloneMgr.activate();
    // Wire the recenter button (idempotent — re-assigning onclick is fine).
    var rcBtn = document.getElementById('clone-recenter');
    if (rcBtn) rcBtn.onclick = function () { if (_cloneMgr && _cloneMgr.recenter) _cloneMgr.recenter(); };
    // Reset clone-specific state
    cloneState.sourcePoint = null;
    cloneState.offset = null;
    cloneState.sourceImageData = null;
    cloneFlipMode = 0;
    var flipBtn = document.getElementById('clone-flip-toggle');
    if (flipBtn) { flipBtn.textContent = 'Flip: Off'; flipBtn.classList.remove('tool-active'); }
    // Default source mode = 'live' (modified image) per user request.
    cloneSourceMode = 'live';
    _updateCloneSourceBtn();
    var statusEl = document.getElementById('clone-status');
    if (statusEl) statusEl.textContent = 'No source point set - Ctrl+click to set source';
    var sm = document.getElementById('clone-source-marker');
    if (sm) sm.style.display = 'none';

    requestAnimationFrame(function () {
      // imagePath is either a desktop filesystem path (needs file:///
      // prefix + slash conversion) OR a cloud URL (http://, https://,
      // blob:, data:). The legacy code assumed desktop only; on cloud
      // that produced file:///https:/... which fails to load → empty
      // sourceImageData → "no clone happens when I paint" symptom.
      var srcUrl = /^(?:https?|blob|data|file):/i.test(imagePath)
        ? imagePath
        : 'file:///' + imagePath.replace(/\\/g, '/');
      // Cache-bust only for filesystem URLs — blob: / data: don't accept
      // query strings.
      if (/^(?:https?|file):/i.test(srcUrl)) {
        srcUrl += (srcUrl.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
      }
      _cloneMgr.loadImage(srcUrl).then(function () {
        // Frozen snapshot for 'original' source mode; also the initial
        // 'live' source until the first stroke refreshes it.
        cloneState.originalImageData = _cloneMgr.ctx.getImageData(0, 0, _cloneMgr.w, _cloneMgr.h);
        cloneState.sourceImageData = cloneState.originalImageData;
      }).catch(function (e) {
        console.error('[clone] source image load failed:', e);
        if (typeof window.cloneShowError === 'function')
          window.cloneShowError('source image load failed: ' + (e && e.message || e));
      });
    });
  }

  // ===========================================================
  //                      DRAW MASK MODAL  (CanvasManager)
  // ===========================================================
  var maskModal = document.getElementById('mask-modal');
  var maskBaseCanvas = document.getElementById('mask-base-canvas');
  var maskOverlayCanvas = document.getElementById('mask-overlay-canvas');
  var maskOverlayCtx = maskOverlayCanvas ? maskOverlayCanvas.getContext('2d', { willReadFrequently: true }) : null;
  var _maskMgr = null;
  var maskIsErasing = false;  // current-stroke erase flag (set per mouse-down)
  var maskEraserMode = false; // sticky toggle: eraser tool active

  var maskBrushSize = 50;

  // Wire the brush/eraser toggle buttons
  function _syncMaskToolButtons() {
    var brushBtn = document.getElementById('mask-brush-mode');
    var eraserBtn = document.getElementById('mask-eraser-mode');
    if (brushBtn) brushBtn.classList.toggle('tool-active', !maskEraserMode);
    if (eraserBtn) eraserBtn.classList.toggle('tool-active', maskEraserMode);
  }
  (function _wireMaskToolToggle() {
    var brushBtn = document.getElementById('mask-brush-mode');
    var eraserBtn = document.getElementById('mask-eraser-mode');
    if (brushBtn) brushBtn.addEventListener('click', function () {
      maskEraserMode = false; _syncMaskToolButtons();
    });
    if (eraserBtn) eraserBtn.addEventListener('click', function () {
      maskEraserMode = true; _syncMaskToolButtons();
    });
    // Keyboard shortcuts: B = brush, E = eraser (active only while modal open)
    document.addEventListener('keydown', function (e) {
      var modal = document.getElementById('mask-modal');
      if (!modal || modal.classList.contains('hidden')) return;
      // Skip if typing in a text field
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'b' || e.key === 'B') {
        maskEraserMode = false; _syncMaskToolButtons();
      } else if (e.key === 'e' || e.key === 'E') {
        maskEraserMode = true; _syncMaskToolButtons();
      }
    });
    _syncMaskToolButtons();
  })();

  function maskPaintDab(ctx, x, y, erase) {
    ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    ctx.fillStyle = 'rgb(255, 0, 0)';
    ctx.beginPath();
    ctx.arc(x, y, maskBrushSize / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  function maskHasAnyPainted() {
    if (!maskOverlayCanvas || !maskOverlayCtx) return false;
    try {
      var w = maskOverlayCanvas.width, h = maskOverlayCanvas.height;
      if (w === 0 || h === 0) return false;
      var d = maskOverlayCtx.getImageData(0, 0, w, h).data;
      var count = 0;
      for (var i = 3; i < d.length; i += 4) {
        if (d[i] > 30) { count++; if (count > 50) return true; }
      }
      return false;
    } catch (e) { return false; }
  }
  function updateMaskApplyBtn() {
    var btn = document.getElementById('mask-apply');
    if (!btn) return;
    var has = maskHasAnyPainted();
    btn.disabled = !has;
    btn.style.opacity = has ? '' : '0.4';
    btn.style.cursor = has ? '' : 'not-allowed';
  }

  function _closeMask() {
    maskModal.classList.add('hidden');
    if (_maskMgr) { _maskMgr.loupeEnabled = false; }
    var l = document.getElementById('clone-loupe');
    if (l) l.style.display = 'none';
  }

  if (maskBaseCanvas && maskOverlayCanvas) {
    _maskMgr = new window.CanvasManager({
      canvas: maskBaseCanvas,
      container: document.getElementById('mask-canvas-container'),
      paintCanvas: maskOverlayCanvas,
      undoBtn: document.getElementById('mask-undo'),
      redoBtn: document.getElementById('mask-redo'),
      resetBtn: document.getElementById('mask-clear'),
      loupeBtn: document.getElementById('mask-loupe-toggle'),
      brushCursor: document.getElementById('mask-brush-cursor'),
      brushSizeGetter: function () { return maskBrushSize; },
      // Right-click = erase (legacy shortcut, still works).
      // Alternatively toggle the eraser button (or press E) to use
      // left-click as eraser — same radius as the brush slider.
      onMouseDown: function (ctx, x, y, e, mgr) {
        if (e.button === 2) {
          // Right-click: always erase
          e.preventDefault();
          maskIsErasing = true;
          mgr.pushUndo();
          mgr.painting = true;
          mgr.lastPaintPoint = { x: x, y: y };
          maskPaintDab(ctx, Math.round(x), Math.round(y), true);
          return false;
        }
        // Left click uses the sticky eraser toggle as default mode
        maskIsErasing = maskEraserMode;
        return undefined;
      },
      onPaint: function (ctx, x, y, lastPt, mgr) {
        x = Math.round(x); y = Math.round(y);
        if (!lastPt) { maskPaintDab(ctx, x, y, maskIsErasing); return; }
        var dx = x - Math.round(lastPt.x), dy = y - Math.round(lastPt.y);
        var dist = Math.sqrt(dx * dx + dy * dy);
        var step = Math.max(1, maskBrushSize / 4);
        var steps = Math.ceil(dist / step);
        for (var i = 1; i <= steps; i++) {
          var t = i / steps;
          maskPaintDab(ctx,
            Math.round(lastPt.x + dx * t),
            Math.round(lastPt.y + dy * t),
            maskIsErasing
          );
        }
      },
      onMouseUp: function (mgr) {
        updateMaskApplyBtn();
      },
    });

    // Prevent context menu on overlay (right-click is erase)
    maskOverlayCanvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    // Brush slider
    var mBrush = document.getElementById('mask-brush-size');
    if (mBrush) mBrush.addEventListener('input', function (e) {
      maskBrushSize = parseInt(e.target.value);
      var v = document.getElementById('mask-brush-val');
      if (v) v.textContent = e.target.value;
    });

    // Keyboard: Esc close, plain Z undo (legacy shortcut)
    document.addEventListener('keydown', function (e) {
      if (!maskModal || maskModal.classList.contains('hidden')) return;
      var target = e.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        if (e.key === 'Escape') { target.blur(); }
        return;
      }
      if (e.key.toLowerCase() === 'z' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        _maskMgr.undo();
        updateMaskApplyBtn();
      } else if (e.key === 'Escape') {
        _closeMask();
      }
    });

    // Close / Cancel
    var mCancel = document.getElementById('mask-cancel');
    var mClose = document.getElementById('mask-modal-close');
    if (mCancel) mCancel.addEventListener('click', _closeMask);
    if (mClose) mClose.addEventListener('click', _closeMask);

    // Apply Inpaint
    var mApply = document.getElementById('mask-apply');
    if (mApply) mApply.addEventListener('click', function () {
      console.log('[edit-tools] mask Apply click, imagePath=', maskCtx.imagePath);

      var imgPath = maskCtx.imagePath;
      if (!imgPath) {
        alert('No image selected for inpaint — maskCtx.imagePath is null. Reopen the mask tool from the project workspace.');
        return;
      }

      // Read overlay WHILE modal is still visible (canvas loses backing store when hidden)
      var w = maskOverlayCanvas.width, h = maskOverlayCanvas.height;
      if (!w || !h) { alert('Mask canvas has no size.'); return; }
      var overlayData;
      try { overlayData = maskOverlayCtx.getImageData(0, 0, w, h); }
      catch (readErr) { alert('Could not read mask: ' + (readErr && readErr.message || readErr)); return; }

      var painted = 0;
      for (var i = 3; i < overlayData.data.length; i += 4) {
        if (overlayData.data[i] > 30) painted++;
      }
      if (painted < 50) {
        alert('Paint a mask first — nothing to inpaint.');
        return;
      }

      // Build black/white mask PNG
      var maskCanvas = document.createElement('canvas');
      maskCanvas.width = w; maskCanvas.height = h;
      var mctx = maskCanvas.getContext('2d');
      mctx.fillStyle = 'black';
      mctx.fillRect(0, 0, w, h);
      var md = mctx.getImageData(0, 0, w, h);
      for (var j = 0; j < overlayData.data.length; j += 4) {
        if (overlayData.data[j + 3] > 30) {
          md.data[j] = 255; md.data[j + 1] = 255; md.data[j + 2] = 255;
        }
        md.data[j + 3] = 255;
      }
      mctx.putImageData(md, 0, 0);
      var maskDataUrl = maskCanvas.toDataURL('image/png');

      var promptEl = document.getElementById('mask-prompt');
      var promptText = promptEl ? promptEl.value.trim() : '';

      _closeMask();

      function runInpaint() {
        var job;
        try { job = addJob('Manual mask inpaint', 'inpaint', imgPath); }
        catch (jobErr) { alert('Internal error: could not create job. ' + (jobErr && jobErr.message || jobErr)); return; }
        if (!job || typeof job !== 'object' || job.id == null) {
          alert('Internal error: addJob returned nothing.');
          return;
        }
        if (!window.meshyAPI || !window.meshyAPI.maskInpaint) {
          try { completeJob(job.id, false, 'maskInpaint API not available'); } catch (_) {}
          alert('maskInpaint API not available.');
          return;
        }
        window.meshyAPI.maskInpaint({ imagePath: imgPath, maskDataUrl: maskDataUrl, prompt: promptText })
        .then(function (r) {
          if (r && r.success) {
            try { completeJob(job.id, true); } catch (_) {}
            showLog('Inpaint done: ' + (r.newPath || ''), 'success');
            if (maskCtx.onSuccess) { try { maskCtx.onSuccess(r.newPath || null); } catch (e) {} }
          } else {
            var errMsg = (r && r.error) || 'unknown error';
            try { completeJob(job.id, false, errMsg); } catch (_) {}
            alert('Inpaint failed: ' + errMsg);
          }
        })
        .catch(function (e) {
          var errMsg2 = (e && e.message) || String(e);
          try { completeJob(job.id, false, errMsg2); } catch (_) {}
          alert('Inpaint error: ' + errMsg2);
        });
      }

      if (window.fabmeshJobs && typeof window.fabmeshJobs.enqueue === 'function') {
        window.fabmeshJobs.enqueue('inpaint', 'Manual mask inpaint', runInpaint);
      } else {
        runInpaint();
      }
    });
  }

  function openMaskToolInternal(imagePath, projectName, onSuccess) {
    if (!maskModal || !maskBaseCanvas || !_maskMgr) {
      console.warn('[edit-tools] Mask modal not present in DOM');
      return;
    }
    maskCtx.imagePath = imagePath;
    maskCtx.projectName = projectName || null;
    maskCtx.onSuccess = typeof onSuccess === 'function' ? onSuccess : null;

    maskModal.classList.remove('hidden');
    _maskMgr.activate();
    var mrcBtn = document.getElementById('mask-recenter');
    if (mrcBtn) mrcBtn.onclick = function () { if (_maskMgr && _maskMgr.recenter) _maskMgr.recenter(); };
    // Wait one frame so the container has its layout dimensions before loading
    requestAnimationFrame(function () {
      // Same cloud-vs-desktop URL handling as the clone tool —
      // file:/// for filesystem paths, untouched http/blob/data URLs
      // for cloud. Without this fix Mask Tool on cloud silently fails
      // to load the base image (file:///https:/...) and Apply produces
      // an empty mask.
      var src = /^(?:https?|blob|data|file):/i.test(imagePath)
        ? imagePath
        : 'file:///' + imagePath.replace(/\\/g, '/');
      if (/^(?:https?|file):/i.test(src)) {
        src += (src.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
      }
      _maskMgr.loadImage(src).then(function () {
        // Clear the overlay after base image loads
        maskOverlayCtx.clearRect(0, 0, _maskMgr.w, _maskMgr.h);
        updateMaskApplyBtn();
      }).catch(function (e) {
        console.error('[mask] base image load failed:', e);
        if (typeof showToast === 'function')
          showToast('mask: image load failed: ' + (e && e.message || e), 'error', 5000);
      });
    });
  }

  // ----- Public API exposed on window -----
  window.openMaskToolFor = function (imagePath, projectName, onSuccess) {
    openMaskToolInternal(imagePath, projectName, onSuccess);
  };
  window.openCloneToolFor = function (imagePath, projectName, onSuccess) {
    openCloneStampInternal(imagePath, projectName, onSuccess);
  };
})();
