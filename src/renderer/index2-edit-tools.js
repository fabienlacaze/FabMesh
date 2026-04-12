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
        Engine: 'RealVis XL (local, SDXL Inpaint)',
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
  //                      CLONE STAMP MODAL
  // ===========================================================
  var cloneModal = document.getElementById('clone-modal');
  var cloneCanvas = document.getElementById('clone-canvas');
  var cloneCtx2d = cloneCanvas ? cloneCanvas.getContext('2d', { willReadFrequently: true }) : null;
  // flipMode: 0=none, 1=horizontal, 2=vertical, 3=both
  var cloneFlipMode = 0;
  var cloneState = {
    sourcePoint: null,
    sourceImageData: null,
    isDown: false,
    lastPoint: null,
    offset: null,
    undoStack: [],
    redoStack: [],
    brushSize: 50,
    hardness: 50,
    zoom: 1,
    panX: 0,
    panY: 0,
    isPanning: false,
    panStart: null,
    baseW: 0,
    baseH: 0,
  };

  function openCloneStampInternal(imagePath, projectName, onSuccess) {
    if (!cloneModal || !cloneCanvas) {
      console.warn('[edit-tools] Clone modal not present in DOM');
      return;
    }
    cloneCtx.imagePath = imagePath;
    cloneCtx.projectName = projectName || null;
    cloneCtx.onSuccess = typeof onSuccess === 'function' ? onSuccess : null;

    cloneModal.classList.remove('hidden');
    var img = new Image();
    img.onload = function () {
      var maxW = window.innerWidth * 0.85;
      var maxH = window.innerHeight * 0.65;
      var w = img.width, h = img.height;
      var scale = Math.min(maxW / w, maxH / h, 1);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
      cloneCanvas.width = img.width;
      cloneCanvas.height = img.height;
      cloneState.baseW = w;
      cloneState.baseH = h;
      cloneState.zoom = 1;
      cloneState.panX = 0;
      cloneState.panY = 0;
      applyCloneView();
      cloneCtx2d.drawImage(img, 0, 0);
      cloneState.sourceImageData = cloneCtx2d.getImageData(0, 0, img.width, img.height);
      cloneState.sourcePoint = null;
      cloneState.offset = null;
      cloneState.undoStack = [];
      cloneState.redoStack = [];
      updateCloneUndoBtn();
      cloneState.lastPoint = null;
      var statusEl = document.getElementById('clone-status');
      if (statusEl) statusEl.textContent = 'No source point set - Ctrl+click to set source';
      var sm = document.getElementById('clone-source-marker');
      if (sm) sm.style.display = 'none';
    };
    img.src = 'file:///' + imagePath.replace(/\\/g, '/') + '?t=' + Date.now();
  }

  function applyCloneView() {
    var w = cloneState.baseW * cloneState.zoom;
    var h = cloneState.baseH * cloneState.zoom;
    var container = document.getElementById('clone-canvas-container');
    if (!container) return;
    var cw = container.clientWidth;
    var ch = container.clientHeight;
    var left = (cw - w) / 2 + cloneState.panX;
    var top = (ch - h) / 2 + cloneState.panY;
    cloneCanvas.style.width = w + 'px';
    cloneCanvas.style.height = h + 'px';
    cloneCanvas.style.left = left + 'px';
    cloneCanvas.style.top = top + 'px';
    cloneCanvas.style.transform = '';
  }

  function getCanvasCoords(evt) {
    var rect = cloneCanvas.getBoundingClientRect();
    var scaleX = cloneCanvas.width / rect.width;
    var scaleY = cloneCanvas.height / rect.height;
    return {
      x: Math.round((evt.clientX - rect.left) * scaleX),
      y: Math.round((evt.clientY - rect.top) * scaleY),
    };
  }

  function pushUndo() {
    try {
      cloneState.undoStack.push(cloneCtx2d.getImageData(0, 0, cloneCanvas.width, cloneCanvas.height));
      if (cloneState.undoStack.length > 20) cloneState.undoStack.shift();
      cloneState.redoStack = [];
      updateCloneUndoBtn();
    } catch (e) {}
  }

  function cloneStampPaint(x, y) {
    if (!cloneState.sourcePoint || !cloneState.sourceImageData) return;
    var r = cloneState.brushSize / 2;
    var hardness = cloneState.hardness / 100;
    var src = cloneState.sourceImageData;
    var dst = cloneCtx2d.getImageData(
      Math.max(0, x - r), Math.max(0, y - r),
      Math.min(cloneCanvas.width - Math.max(0, x - r), r * 2),
      Math.min(cloneCanvas.height - Math.max(0, y - r), r * 2)
    );
    var dW = dst.width;
    var dH = dst.height;
    var ox = Math.max(0, x - r);
    var oy = Math.max(0, y - r);

    for (var py = 0; py < dH; py++) {
      for (var px = 0; px < dW; px++) {
        var dx = (ox + px) - x;
        var dy = (oy + py) - y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > r) continue;
        var t = dist / r;
        var a = 1 - t * t;
        a *= hardness + (1 - hardness) * (1 - t);
        if (a <= 0) continue;

        var rawSx = (ox + px) + cloneState.offset.dx;
        var rawSy = (oy + py) + cloneState.offset.dy;
        // Apply flip around the source point
        var sxi = rawSx;
        var syi = rawSy;
        if (cloneFlipMode === 1 || cloneFlipMode === 3) {
          // Horizontal flip: mirror X around source point
          sxi = cloneState.sourcePoint.x - (rawSx - cloneState.sourcePoint.x);
        }
        if (cloneFlipMode === 2 || cloneFlipMode === 3) {
          // Vertical flip: mirror Y around source point
          syi = cloneState.sourcePoint.y - (rawSy - cloneState.sourcePoint.y);
        }
        sxi = Math.round(sxi);
        syi = Math.round(syi);
        if (sxi < 0 || syi < 0 || sxi >= src.width || syi >= src.height) continue;

        var sIdx = (syi * src.width + sxi) * 4;
        var dIdx = (py * dW + px) * 4;
        dst.data[dIdx]     = dst.data[dIdx]     * (1 - a) + src.data[sIdx]     * a;
        dst.data[dIdx + 1] = dst.data[dIdx + 1] * (1 - a) + src.data[sIdx + 1] * a;
        dst.data[dIdx + 2] = dst.data[dIdx + 2] * (1 - a) + src.data[sIdx + 2] * a;
        dst.data[dIdx + 3] = dst.data[dIdx + 3] * (1 - a) + src.data[sIdx + 3] * a;
      }
    }
    cloneCtx2d.putImageData(dst, ox, oy);
  }

  function updateCloneUndoBtn() {
    var u = document.getElementById('clone-undo');
    var rEl = document.getElementById('clone-redo');
    if (u) {
      var canU = cloneState.undoStack.length > 0;
      u.disabled = !canU;
      u.style.opacity = canU ? '' : '0.4';
      u.style.cursor = canU ? '' : 'not-allowed';
    }
    if (rEl) {
      var canR = cloneState.redoStack.length > 0;
      rEl.disabled = !canR;
      rEl.style.opacity = canR ? '' : '0.4';
      rEl.style.cursor = canR ? '' : 'not-allowed';
    }
  }
  window.updateCloneUndoBtn = updateCloneUndoBtn;

  function cloneShowError(msg) {
    var el = document.getElementById('clone-error');
    if (!el) return;
    el.textContent = '\u2717  ' + msg;
    el.style.display = 'block';
    clearTimeout(cloneShowError._t);
    cloneShowError._t = setTimeout(function () { el.style.display = 'none'; }, 4000);
  }
  window.cloneShowError = cloneShowError;

  function updateSourceMarker() {
    // No-op: real update happens in updateBrushCursor on mousemove.
  }

  function updateBrushCursor(e) {
    var cur = document.getElementById('clone-brush-cursor');
    if (!cur) return;
    var rect = cloneCanvas.getBoundingClientRect();
    var scaleX = rect.width / cloneCanvas.width || 1;
    var displaySize = Math.max(4, cloneState.brushSize * scaleX);
    cur.style.width = displaySize + 'px';
    cur.style.height = displaySize + 'px';
    cur.style.left = (e.clientX - displaySize / 2) + 'px';
    cur.style.top = (e.clientY - displaySize / 2) + 'px';
    cur.style.display = 'block';

    var srcEl = document.getElementById('clone-source-marker');
    if (!srcEl) return;
    if (!cloneState.sourcePoint) {
      srcEl.style.display = 'none';
      return;
    }
    var sx, sy;
    if (cloneState.offset) {
      var p = getCanvasCoords(e);
      sx = p.x + cloneState.offset.dx;
      sy = p.y + cloneState.offset.dy;
    } else {
      sx = cloneState.sourcePoint.x;
      sy = cloneState.sourcePoint.y;
    }
    var screenX = rect.left + sx * scaleX;
    var screenY = rect.top + sy * scaleX;
    srcEl.style.width = displaySize + 'px';
    srcEl.style.height = displaySize + 'px';
    srcEl.style.left = (screenX - displaySize / 2) + 'px';
    srcEl.style.top = (screenY - displaySize / 2) + 'px';
    srcEl.style.display = 'block';

    // Update loupe magnifier if active (defined later, called via closure)
    try { if (loupeEnabled && typeof updateLoupe !== 'undefined') updateLoupe(e); } catch(_) {}
  }

  if (cloneCanvas) {
    var cloneContainer = document.getElementById('clone-canvas-container');

    if (cloneContainer) {
      cloneContainer.addEventListener('contextmenu', function (e) { e.preventDefault(); });

      cloneContainer.addEventListener('mousedown', function (e) {
        if (e.button === 2) {
          e.preventDefault();
          cloneState.isPanning = true;
          cloneState.panStart = { x: e.clientX - cloneState.panX, y: e.clientY - cloneState.panY };
          cloneContainer.style.cursor = 'grabbing';
          return;
        }
      }, true);

      cloneContainer.addEventListener('wheel', function (e) {
        e.preventDefault();
        var cRect = cloneContainer.getBoundingClientRect();
        var oldZoom = cloneState.zoom;
        var factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
        var newZoom = Math.max(0.1, Math.min(10, oldZoom * factor));
        var ratio = newZoom / oldZoom;
        var canvasLeft = (cRect.width  - cloneState.baseW * oldZoom) / 2 + cloneState.panX;
        var canvasTop  = (cRect.height - cloneState.baseH * oldZoom) / 2 + cloneState.panY;
        var mx = (e.clientX - cRect.left) - canvasLeft;
        var my = (e.clientY - cRect.top)  - canvasTop;
        cloneState.panX += mx * (1 - ratio) + (cloneState.baseW * (newZoom - oldZoom)) / 2;
        cloneState.panY += my * (1 - ratio) + (cloneState.baseH * (newZoom - oldZoom)) / 2;
        cloneState.zoom = newZoom;
        applyCloneView();
        updateSourceMarker();
      }, { passive: false });

      cloneContainer.addEventListener('mouseenter', function (e) { updateBrushCursor(e); });
      cloneContainer.addEventListener('mouseleave', function () {
        var cur = document.getElementById('clone-brush-cursor');
        if (cur) cur.style.display = 'none';
      });
      cloneContainer.addEventListener('mousemove', updateBrushCursor);
    }

    cloneCanvas.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      var p = getCanvasCoords(e);
      if (e.ctrlKey || e.metaKey) {
        cloneState.sourcePoint = p;
        cloneState.offset = null;
        var statusEl = document.getElementById('clone-status');
        if (statusEl) statusEl.textContent = 'Source set at (' + p.x + ', ' + p.y + ') - now click & drag to clone';
        updateSourceMarker();
        return;
      }
      if (!cloneState.sourcePoint) {
        cloneShowError('Set source first with Ctrl+Click');
        return;
      }
      cloneState.offset = {
        dx: cloneState.sourcePoint.x - p.x,
        dy: cloneState.sourcePoint.y - p.y,
      };
      pushUndo();
      cloneState.isDown = true;
      cloneState.lastPoint = p;
      cloneStampPaint(p.x, p.y);
    });

    cloneCanvas.addEventListener('mousemove', function (e) {
      updateBrushCursor(e);
      if (cloneState.isPanning && cloneState.panStart) {
        cloneState.panX = e.clientX - cloneState.panStart.x;
        cloneState.panY = e.clientY - cloneState.panStart.y;
        applyCloneView();
        updateSourceMarker();
        return;
      }
      if (!cloneState.isDown) return;
      var p = getCanvasCoords(e);
      var dx = p.x - cloneState.lastPoint.x;
      var dy = p.y - cloneState.lastPoint.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var step = Math.max(1, cloneState.brushSize / 4);
      var steps = Math.ceil(dist / step);
      for (var i = 1; i <= steps; i++) {
        var t = i / steps;
        cloneStampPaint(
          Math.round(cloneState.lastPoint.x + dx * t),
          Math.round(cloneState.lastPoint.y + dy * t)
        );
      }
      cloneState.lastPoint = p;
    });

    window.addEventListener('mouseup', function () {
      cloneState.isDown = false;
      if (cloneState.isPanning) {
        cloneState.isPanning = false;
        cloneState.panStart = null;
        cloneCanvas.style.cursor = 'none';
      }
    });

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

    var cloneUndoFn = function () {
      if (cloneState.undoStack.length > 0) {
        try { cloneState.redoStack.push(cloneCtx2d.getImageData(0, 0, cloneCanvas.width, cloneCanvas.height)); } catch (e) {}
        var last = cloneState.undoStack.pop();
        cloneCtx2d.putImageData(last, 0, 0);
        updateCloneUndoBtn();
      }
    };
    var cloneRedoFn = function () {
      if (cloneState.redoStack.length > 0) {
        try { cloneState.undoStack.push(cloneCtx2d.getImageData(0, 0, cloneCanvas.width, cloneCanvas.height)); } catch (e) {}
        var next = cloneState.redoStack.pop();
        cloneCtx2d.putImageData(next, 0, 0);
        updateCloneUndoBtn();
      }
    };
    var cu = document.getElementById('clone-undo');
    var cr = document.getElementById('clone-redo');
    if (cu) cu.addEventListener('click', cloneUndoFn);
    if (cr) cr.addEventListener('click', cloneRedoFn);

    document.addEventListener('keydown', function (e) {
      if (!cloneModal || cloneModal.classList.contains('hidden')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        cloneUndoFn();
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        cloneRedoFn();
      } else if (e.key === 'Escape') {
        cloneModal.classList.add('hidden');
      }
    });

    var cReset = document.getElementById('clone-reset');
    if (cReset) cReset.addEventListener('click', function () {
      if (cloneState.sourceImageData) {
        cloneCtx2d.putImageData(cloneState.sourceImageData, 0, 0);
        cloneState.undoStack = [];
        cloneState.redoStack = [];
        updateCloneUndoBtn();
      }
    });

    // Loupe toggle
    var loupeEnabled = false;
    var loupeEl = document.getElementById('clone-loupe');
    var loupeCanvas = document.getElementById('clone-loupe-canvas');
    var loupeCtx = loupeCanvas ? loupeCanvas.getContext('2d') : null;
    var cLoupeBtn = document.getElementById('clone-loupe-toggle');
    if (cLoupeBtn) cLoupeBtn.addEventListener('click', function () {
      loupeEnabled = !loupeEnabled;
      cLoupeBtn.style.borderColor = loupeEnabled ? 'var(--accent)' : '';
      cLoupeBtn.style.color = loupeEnabled ? 'var(--accent)' : '';
      if (!loupeEnabled && loupeEl) loupeEl.style.display = 'none';
    });

    function updateLoupe(e) {
      if (!loupeEnabled || !loupeEl || !loupeCtx || !cloneCanvas) {
        if (loupeEl) loupeEl.style.display = 'none';
        return;
      }
      var rect = cloneCanvas.getBoundingClientRect();
      var scaleX = cloneCanvas.width / rect.width;
      var cx = Math.round((e.clientX - rect.left) * scaleX);
      var cy = Math.round((e.clientY - rect.top) * scaleX);
      // Draw zoomed portion of the canvas (3x zoom, 40px radius in canvas coords)
      var zoomFactor = 3;
      var srcSize = 40;
      loupeCtx.clearRect(0, 0, 120, 120);
      loupeCtx.save();
      // Clip to circle
      loupeCtx.beginPath();
      loupeCtx.arc(60, 60, 58, 0, Math.PI * 2);
      loupeCtx.clip();
      loupeCtx.drawImage(cloneCanvas,
        cx - srcSize, cy - srcSize, srcSize * 2, srcSize * 2,
        0, 0, 120, 120
      );
      // Draw crosshair at center
      loupeCtx.strokeStyle = 'rgba(255,255,255,0.6)';
      loupeCtx.lineWidth = 1;
      loupeCtx.beginPath();
      loupeCtx.moveTo(60, 50); loupeCtx.lineTo(60, 70);
      loupeCtx.moveTo(50, 60); loupeCtx.lineTo(70, 60);
      loupeCtx.stroke();
      loupeCtx.restore();
      // Position the loupe above-right of the cursor
      loupeEl.style.left = (e.clientX + 20) + 'px';
      loupeEl.style.top = (e.clientY - 140) + 'px';
      loupeEl.style.display = 'block';
    }

    // Flip toggle: cycles None / H / V / Both
    var cFlip = document.getElementById('clone-flip-toggle');
    if (cFlip) cFlip.addEventListener('click', function () {
      cloneFlipMode = (cloneFlipMode + 1) % 4;
      var labels = ['Flip: Off', 'Flip: H', 'Flip: V', 'Flip: HV'];
      cFlip.textContent = labels[cloneFlipMode];
      cFlip.style.borderColor = cloneFlipMode > 0 ? 'var(--accent)' : '';
      cFlip.style.color = cloneFlipMode > 0 ? 'var(--accent)' : '';
    });

    var cCancel = document.getElementById('clone-cancel');
    var cClose = document.getElementById('clone-modal-close');
    if (cCancel) cCancel.addEventListener('click', function () { cloneModal.classList.add('hidden'); });
    if (cClose) cClose.addEventListener('click', function () { cloneModal.classList.add('hidden'); });

    var cSave = document.getElementById('clone-save');
    if (cSave) cSave.addEventListener('click', function () {
      var imgPath = cloneCtx.imagePath;
      if (!imgPath) return;
      var dataUrl = cloneCanvas.toDataURL('image/png');
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
            cloneModal.classList.add('hidden');
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

  // ===========================================================
  //                      DRAW MASK MODAL
  // ===========================================================
  var maskModal = document.getElementById('mask-modal');
  var maskBaseCanvas = document.getElementById('mask-base-canvas');
  var maskOverlayCanvas = document.getElementById('mask-overlay-canvas');
  var maskBaseCtx = maskBaseCanvas ? maskBaseCanvas.getContext('2d') : null;
  var maskOverlayCtx = maskOverlayCanvas ? maskOverlayCanvas.getContext('2d', { willReadFrequently: true }) : null;
  var maskState = {
    isDown: false,
    isErasing: false,
    lastPoint: null,
    brushSize: 50,
    undoStack: [],
    redoStack: [],
    baseW: 0,
    baseH: 0,
    zoom: 1,
    panX: 0,
    panY: 0,
    isPanning: false,
    panStart: null,
  };

  function applyMaskView() {
    var w = maskState.baseW * maskState.zoom;
    var h = maskState.baseH * maskState.zoom;
    var container = document.getElementById('mask-canvas-container');
    if (!container) return;
    var cw = container.clientWidth;
    var ch = container.clientHeight;
    var left = (cw - w) / 2 + maskState.panX;
    var top = (ch - h) / 2 + maskState.panY;
    maskBaseCanvas.style.width = w + 'px';
    maskBaseCanvas.style.height = h + 'px';
    maskOverlayCanvas.style.width = w + 'px';
    maskOverlayCanvas.style.height = h + 'px';
    maskBaseCanvas.style.left = left + 'px';
    maskBaseCanvas.style.top = top + 'px';
    maskOverlayCanvas.style.left = left + 'px';
    maskOverlayCanvas.style.top = top + 'px';
  }

  function updateMaskUndoBtn() {
    var u = document.getElementById('mask-undo');
    var rEl = document.getElementById('mask-redo');
    if (u) {
      var canU = maskState.undoStack.length > 0;
      u.disabled = !canU;
      u.style.opacity = canU ? '' : '0.4';
      u.style.cursor = canU ? '' : 'not-allowed';
    }
    if (rEl) {
      var canR = maskState.redoStack.length > 0;
      rEl.disabled = !canR;
      rEl.style.opacity = canR ? '' : '0.4';
      rEl.style.cursor = canR ? '' : 'not-allowed';
    }
  }

  function openMaskToolInternal(imagePath, projectName, onSuccess) {
    if (!maskModal || !maskOverlayCanvas) {
      console.warn('[edit-tools] Mask modal not present in DOM');
      return;
    }
    maskCtx.imagePath = imagePath;
    maskCtx.projectName = projectName || null;
    maskCtx.onSuccess = typeof onSuccess === 'function' ? onSuccess : null;

    maskModal.classList.remove('hidden');
    var img = new Image();
    img.onload = function () {
      var maxW = window.innerWidth * 0.85;
      var maxH = window.innerHeight * 0.65;
      var w = img.width, h = img.height;
      var scale = Math.min(maxW / w, maxH / h, 1);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
      maskState.baseW = w;
      maskState.baseH = h;
      maskState.zoom = 1;
      maskState.panX = 0;
      maskState.panY = 0;

      maskBaseCanvas.width = img.width;
      maskBaseCanvas.height = img.height;
      maskOverlayCanvas.width = img.width;
      maskOverlayCanvas.height = img.height;
      applyMaskView();

      maskBaseCtx.drawImage(img, 0, 0);
      maskOverlayCtx.clearRect(0, 0, img.width, img.height);
      maskState.undoStack = [];
      maskState.redoStack = [];
      updateMaskUndoBtn();
      updateMaskApplyBtn();
    };
    img.src = 'file:///' + imagePath.replace(/\\/g, '/') + '?t=' + Date.now();
  }

  function maskGetCoords(e) {
    var rect = maskOverlayCanvas.getBoundingClientRect();
    var sx = maskOverlayCanvas.width / rect.width;
    var sy = maskOverlayCanvas.height / rect.height;
    return {
      x: Math.round((e.clientX - rect.left) * sx),
      y: Math.round((e.clientY - rect.top) * sy),
    };
  }

  function maskPaint(x, y, erase) {
    maskOverlayCtx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    maskOverlayCtx.fillStyle = 'rgb(255, 0, 0)';
    maskOverlayCtx.beginPath();
    maskOverlayCtx.arc(x, y, maskState.brushSize / 2, 0, Math.PI * 2);
    maskOverlayCtx.fill();
    maskOverlayCtx.globalCompositeOperation = 'source-over';
  }

  function maskPushUndo() {
    try {
      maskState.undoStack.push(maskOverlayCtx.getImageData(0, 0, maskOverlayCanvas.width, maskOverlayCanvas.height));
      if (maskState.undoStack.length > 20) maskState.undoStack.shift();
      maskState.redoStack = [];
      updateMaskUndoBtn();
    } catch (e) {}
  }

  // Enable/disable Apply Inpaint based on whether the mask has any painted pixels
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

  function updateMaskCursor(e) {
    var cur = document.getElementById('mask-brush-cursor');
    if (!cur) return;
    var rect = maskOverlayCanvas.getBoundingClientRect();
    var scale = rect.width / maskOverlayCanvas.width || 1;
    var displaySize = Math.max(4, maskState.brushSize * scale);
    cur.style.width = displaySize + 'px';
    cur.style.height = displaySize + 'px';
    cur.style.left = (e.clientX - displaySize / 2) + 'px';
    cur.style.top = (e.clientY - displaySize / 2) + 'px';
    cur.style.display = 'block';
  }

  if (maskOverlayCanvas) {
    var maskContainer = document.getElementById('mask-canvas-container');

    if (maskContainer) {
      maskContainer.addEventListener('contextmenu', function (e) { e.preventDefault(); });

      maskContainer.addEventListener('wheel', function (e) {
        e.preventDefault();
        var cRect = maskContainer.getBoundingClientRect();
        var oldZoom = maskState.zoom;
        var factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
        var newZoom = Math.max(0.1, Math.min(10, oldZoom * factor));
        var ratio = newZoom / oldZoom;
        var canvasLeft = (cRect.width  - maskState.baseW * oldZoom) / 2 + maskState.panX;
        var canvasTop  = (cRect.height - maskState.baseH * oldZoom) / 2 + maskState.panY;
        var mx = (e.clientX - cRect.left) - canvasLeft;
        var my = (e.clientY - cRect.top)  - canvasTop;
        maskState.panX += mx * (1 - ratio) + (maskState.baseW * (newZoom - oldZoom)) / 2;
        maskState.panY += my * (1 - ratio) + (maskState.baseH * (newZoom - oldZoom)) / 2;
        maskState.zoom = newZoom;
        applyMaskView();
      }, { passive: false });

      maskContainer.addEventListener('mousedown', function (e) {
        if (e.button === 1) {
          e.preventDefault();
          maskState.isPanning = true;
          maskState.panStart = { x: e.clientX - maskState.panX, y: e.clientY - maskState.panY };
        }
      });

      maskContainer.addEventListener('mouseenter', updateMaskCursor);
      maskContainer.addEventListener('mousemove', updateMaskCursor);
      maskContainer.addEventListener('mouseleave', function () {
        var cur = document.getElementById('mask-brush-cursor');
        if (cur) cur.style.display = 'none';
      });
    }

    window.addEventListener('mousemove', function (e) {
      if (maskState.isPanning && maskState.panStart) {
        maskState.panX = e.clientX - maskState.panStart.x;
        maskState.panY = e.clientY - maskState.panStart.y;
        applyMaskView();
      }
    });
    window.addEventListener('mouseup', function () { maskState.isPanning = false; });

    maskOverlayCanvas.addEventListener('mousedown', function (e) {
      if (e.button === 1) return;
      e.preventDefault();
      maskPushUndo();
      maskState.isDown = true;
      maskState.isErasing = (e.button === 2);
      var p = maskGetCoords(e);
      maskState.lastPoint = p;
      maskPaint(p.x, p.y, maskState.isErasing);
      updateMaskApplyBtn();
    });

    window.addEventListener('mouseup', function () {
      if (maskState.isDown) {
        maskState.isDown = false;
        updateMaskApplyBtn();
      }
    });

    maskOverlayCanvas.addEventListener('mousemove', function (e) {
      updateMaskCursor(e);
      if (!maskState.isDown) return;
      var p = maskGetCoords(e);
      var dx = p.x - maskState.lastPoint.x;
      var dy = p.y - maskState.lastPoint.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var step = Math.max(1, maskState.brushSize / 4);
      var steps = Math.ceil(dist / step);
      for (var i = 1; i <= steps; i++) {
        var t = i / steps;
        maskPaint(
          Math.round(maskState.lastPoint.x + dx * t),
          Math.round(maskState.lastPoint.y + dy * t),
          maskState.isErasing
        );
      }
      maskState.lastPoint = p;
    });

    // Duplicate mouseup listener kept for backward compat — updateMaskApplyBtn is called in the other one.

    var mBrush = document.getElementById('mask-brush-size');
    if (mBrush) mBrush.addEventListener('input', function (e) {
      maskState.brushSize = parseInt(e.target.value);
      var v = document.getElementById('mask-brush-val');
      if (v) v.textContent = e.target.value;
    });

    function maskUndoFn() {
      if (maskState.undoStack.length > 0) {
        try { maskState.redoStack.push(maskOverlayCtx.getImageData(0, 0, maskOverlayCanvas.width, maskOverlayCanvas.height)); } catch (e) {}
        maskOverlayCtx.putImageData(maskState.undoStack.pop(), 0, 0);
        updateMaskUndoBtn();
        updateMaskApplyBtn();
      }
    }
    function maskRedoFn() {
      if (maskState.redoStack.length > 0) {
        try { maskState.undoStack.push(maskOverlayCtx.getImageData(0, 0, maskOverlayCanvas.width, maskOverlayCanvas.height)); } catch (e) {}
        maskOverlayCtx.putImageData(maskState.redoStack.pop(), 0, 0);
        updateMaskUndoBtn();
        updateMaskApplyBtn();
      }
    }
    var mUndo = document.getElementById('mask-undo');
    if (mUndo) mUndo.addEventListener('click', maskUndoFn);
    var mRedo = document.getElementById('mask-redo');
    if (mRedo) mRedo.addEventListener('click', maskRedoFn);

    // Keyboard shortcuts for mask modal: Ctrl+Z undo, Ctrl+Y / Ctrl+Shift+Z redo, Esc close
    document.addEventListener('keydown', function (e) {
      if (!maskModal || maskModal.classList.contains('hidden')) return;
      // Ignore if user is typing in the prompt input
      var target = e.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        if (e.key === 'Escape') { target.blur(); }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        maskUndoFn();
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        maskRedoFn();
      } else if (e.key.toLowerCase() === 'z' && !e.ctrlKey && !e.metaKey) {
        // Legacy shortcut: plain Z for undo (mentioned in the modal help text)
        e.preventDefault();
        maskUndoFn();
      } else if (e.key === 'Escape') {
        maskModal.classList.add('hidden');
      }
    });

    var mClear = document.getElementById('mask-clear');
    if (mClear) mClear.addEventListener('click', function () {
      maskPushUndo();
      maskOverlayCtx.clearRect(0, 0, maskOverlayCanvas.width, maskOverlayCanvas.height);
      updateMaskApplyBtn();
    });

    var mCancel = document.getElementById('mask-cancel');
    var mClose = document.getElementById('mask-modal-close');
    if (mCancel) mCancel.addEventListener('click', function () { maskModal.classList.add('hidden'); });
    if (mClose) mClose.addEventListener('click', function () { maskModal.classList.add('hidden'); });

    var mApply = document.getElementById('mask-apply');
    if (mApply) mApply.addEventListener('click', function () {
      console.log('[edit-tools] mask Apply click, imagePath=', maskCtx.imagePath);

      // --------- 0. Pre-flight checks BEFORE hiding the popup ---------
      var imgPath = maskCtx.imagePath;
      if (!imgPath) {
        alert('No image selected for inpaint — maskCtx.imagePath is null. Reopen the mask tool from the project workspace.');
        return;
      }

      // --------- 1. Read the overlay WHILE the modal is still visible ---------
      // Hiding the modal first was a bug: on some browsers the canvas context
      // loses its backing store when the parent becomes display:none, and
      // getImageData() returns all zeros → we were silently bailing out.
      var w = maskOverlayCanvas.width;
      var h = maskOverlayCanvas.height;
      if (!w || !h) {
        alert('Mask canvas has no size. Close the dialog and reopen the mask tool.');
        return;
      }
      var overlayData;
      try {
        overlayData = maskOverlayCtx.getImageData(0, 0, w, h);
      } catch (readErr) {
        console.error('[edit-tools] getImageData failed', readErr);
        alert('Could not read mask: ' + (readErr && readErr.message || readErr));
        return;
      }
      var painted = 0;
      for (var i = 3; i < overlayData.data.length; i += 4) {
        if (overlayData.data[i] > 30) painted++;
      }
      console.log('[edit-tools] painted pixels:', painted, '/ canvas', w, 'x', h);
      if (painted < 50) {
        alert('Paint a mask first — nothing to inpaint. Draw over the area you want to replace then click Apply Inpaint again.');
        return;
      }

      // --------- 2. Build the black/white mask PNG data URL ---------
      var maskCanvas = document.createElement('canvas');
      maskCanvas.width = w;
      maskCanvas.height = h;
      var mctx = maskCanvas.getContext('2d');
      mctx.fillStyle = 'black';
      mctx.fillRect(0, 0, w, h);
      var md = mctx.getImageData(0, 0, w, h);
      for (var j = 0; j < overlayData.data.length; j += 4) {
        if (overlayData.data[j + 3] > 30) {
          md.data[j] = 255;
          md.data[j + 1] = 255;
          md.data[j + 2] = 255;
        }
        md.data[j + 3] = 255;
      }
      mctx.putImageData(md, 0, 0);
      var maskDataUrl = maskCanvas.toDataURL('image/png');
      console.log('[edit-tools] maskDataUrl length:', maskDataUrl.length);

      var promptEl = document.getElementById('mask-prompt');
      var promptText = promptEl ? promptEl.value.trim() : '';

      // --------- 3. NOW hide the popup — we have everything we need ---------
      maskModal.classList.add('hidden');

      // --------- 4. Enqueue the job through the VRAM/GPU gate ---------
      // We wrap the actual work in a closure and hand it to fabmeshJobs.enqueue,
      // which will:
      //  (a) check VRAM/temp/GPU util/RAM limits BEFORE starting,
      //  (b) queue the job if any limit is exceeded (and poll until safe),
      //  (c) only then create the visible job entry and fire the IPC.
      //
      // This is the same gating path that Generate Image / Generate 3D use,
      // so the sliders in Settings finally apply to draw-mask inpaint.
      function runInpaint() {
        var job;
        try {
          job = addJob('Manual mask inpaint', 'inpaint', imgPath);
        } catch (jobErr) {
          console.error('[edit-tools] addJob threw', jobErr);
          alert('Internal error: could not create job. ' + (jobErr && jobErr.message || jobErr));
          return;
        }
        if (!job || typeof job !== 'object' || job.id == null) {
          alert('Internal error: addJob returned nothing. Is the renderer fully loaded?');
          return;
        }

        if (!window.meshyAPI || !window.meshyAPI.maskInpaint) {
          try { completeJob(job.id, false, 'maskInpaint API not available'); } catch (_) {}
          alert('maskInpaint API not available — preload.js did not expose it.');
          return;
        }

        window.meshyAPI.maskInpaint({
          imagePath: imgPath,
          maskDataUrl: maskDataUrl,
          prompt: promptText
        })
        .then(function (r) {
          if (r && r.success) {
            try { completeJob(job.id, true); } catch (_) {}
            showLog('Inpaint done: ' + (r.newPath || ''), 'success');
            if (maskCtx.onSuccess) {
              try { maskCtx.onSuccess(r.newPath || null); } catch (e) {}
            }
          } else {
            var errMsg = (r && r.error) || 'unknown error';
            try { completeJob(job.id, false, errMsg); } catch (_) {}
            console.error('[edit-tools] mask_inpaint failed:', r);
            alert('Inpaint failed: ' + errMsg);
          }
        })
        .catch(function (e) {
          var errMsg2 = (e && e.message) || String(e);
          try { completeJob(job.id, false, errMsg2); } catch (_) {}
          console.error('[edit-tools] mask_inpaint exception:', e);
          alert('Inpaint error: ' + errMsg2);
        });
      }

      if (window.fabmeshJobs && typeof window.fabmeshJobs.enqueue === 'function') {
        window.fabmeshJobs.enqueue('inpaint', 'Manual mask inpaint', runInpaint);
      } else {
        // Fallback: no gating exposed — run immediately.
        console.warn('[edit-tools] window.fabmeshJobs.enqueue not available, running without gating');
        runInpaint();
      }
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
