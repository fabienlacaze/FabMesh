/**
 * FabMesh Canvas Utils — shared interactive canvas features.
 *
 * Provides: centering, zoom (wheel), undo/redo (Ctrl+Z/Y), loupe,
 * brush cursor with center dot, keyboard shortcuts.
 *
 * Usage:
 *   const mgr = new CanvasManager({
 *     canvas: document.getElementById('my-canvas'),
 *     container: document.getElementById('my-container'),
 *     undoBtn: document.getElementById('my-undo'),
 *     redoBtn: document.getElementById('my-redo'),
 *     resetBtn: document.getElementById('my-reset'),
 *     loupeBtn: document.getElementById('my-loupe'),
 *     brushCursor: document.getElementById('my-cursor'),
 *     brushSizeGetter: () => 50,
 *     onPaint: (ctx, x, y, mgr) => { ... },
 *   });
 *   mgr.loadImage(path);
 */

class CanvasManager {
  constructor(opts) {
    this.canvas = opts.canvas;
    this.container = opts.container;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.undoBtn = opts.undoBtn;
    this.redoBtn = opts.redoBtn;
    this.resetBtn = opts.resetBtn;
    this.loupeBtn = opts.loupeBtn;
    this.brushCursor = opts.brushCursor;
    this.brushSizeGetter = opts.brushSizeGetter || (() => 50);
    this.onPaint = opts.onPaint || null;
    this.onMouseMove = opts.onMouseMove || null;
    this.onMouseDown = opts.onMouseDown || null;  // (ctx, x, y, e, mgr) → false to skip auto-paint
    this.onMouseUp = opts.onMouseUp || null;
    this.paintCanvas = opts.paintCanvas || null;   // optional: paint on a different canvas (e.g. overlay)
    this.lastPaintPoint = null;
    this.rightClickPan = !!opts.rightClickPan;     // use right-click for pan instead of middle-click

    this.origData = null;
    this.undoStack = [];
    this.redoStack = [];
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.painting = false;
    this.panning = false;
    this.panStart = null;
    this.loupeEnabled = true;
    this.w = 0;
    this.h = 0;

    this._bindEvents();
    this._updateBtns();
    if (this.loupeBtn) this.loupeBtn.classList.add('tool-active');
  }

  /** Call when (re-)opening the modal to ensure loupe is on + button synced */
  activate() {
    this.loupeEnabled = true;
    if (this.loupeBtn) this.loupeBtn.classList.add('tool-active');
  }

  loadImage(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        this.w = img.width;
        this.h = img.height;
        this.canvas.width = img.width;
        this.canvas.height = img.height;
        this.ctx.drawImage(img, 0, 0);
        this.origData = this.ctx.getImageData(0, 0, img.width, img.height);
        this.undoStack = [];
        this.redoStack = [];
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
        this._applyTransform();
        this._updateBtns();
        resolve();
      };
      img.src = src;
    });
  }

  _applyTransform() {
    const cw = this.container.clientWidth;
    const ch = this.container.clientHeight;
    const baseScale = Math.min(cw / this.w, ch / this.h, 1);
    const totalScale = baseScale * this.zoom;
    const dw = Math.round(this.w * totalScale);
    const dh = Math.round(this.h * totalScale);
    this.canvas.style.width = dw + 'px';
    this.canvas.style.height = dh + 'px';
    this.canvas.style.position = 'absolute';
    this.canvas.style.left = Math.round((cw - dw) / 2 + this.panX) + 'px';
    this.canvas.style.top = Math.round((ch - dh) / 2 + this.panY) + 'px';
    // Also position any overlay canvas (sibling) — only resize on first load,
    // NOT on every zoom/pan, because setting .width clears canvas content.
    const overlay = this.canvas.nextElementSibling;
    if (overlay && overlay.tagName === 'CANVAS') {
      if (overlay.width !== this.w || overlay.height !== this.h) {
        overlay.width = this.w;
        overlay.height = this.h;
      }
      overlay.style.width = dw + 'px';
      overlay.style.height = dh + 'px';
      overlay.style.position = 'absolute';
      overlay.style.left = this.canvas.style.left;
      overlay.style.top = this.canvas.style.top;
    }
  }

  getCanvasCoords(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = this.w / rect.width;
    const sy = this.h / rect.height;
    return {
      x: (e.clientX - rect.left) * sx,
      y: (e.clientY - rect.top) * sy,
    };
  }

  _undoCtx() {
    return this.paintCanvas ? this.paintCanvas.getContext('2d', { willReadFrequently: true }) : this.ctx;
  }

  pushUndo() {
    const c = this._undoCtx();
    this.undoStack.push(c.getImageData(0, 0, this.w, this.h));
    if (this.undoStack.length > 20) this.undoStack.shift();
    this.redoStack = [];
    this._updateBtns();
  }

  undo() {
    if (this.undoStack.length === 0) return;
    const c = this._undoCtx();
    this.redoStack.push(c.getImageData(0, 0, this.w, this.h));
    c.putImageData(this.undoStack.pop(), 0, 0);
    this._updateBtns();
  }

  redo() {
    if (this.redoStack.length === 0) return;
    const c = this._undoCtx();
    this.undoStack.push(c.getImageData(0, 0, this.w, this.h));
    c.putImageData(this.redoStack.pop(), 0, 0);
    this._updateBtns();
  }

  reset() {
    if (this.paintCanvas) {
      // For overlay-based tools: clear the overlay
      const c = this.paintCanvas.getContext('2d');
      c.clearRect(0, 0, this.w, this.h);
    } else if (this.origData) {
      this.ctx.putImageData(this.origData, 0, 0);
    }
    this.undoStack = [];
    this.redoStack = [];
    this._updateBtns();
  }

  _updateBtns() {
    if (this.undoBtn) this.undoBtn.disabled = this.undoStack.length === 0;
    if (this.redoBtn) this.redoBtn.disabled = this.redoStack.length === 0;
  }

  _updateBrushCursor(e) {
    if (!this.brushCursor) return;
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = rect.width / this.w;
    const bs = this.brushSizeGetter();
    const ds = Math.max(4, bs * scaleX);
    this.brushCursor.style.width = ds + 'px';
    this.brushCursor.style.height = ds + 'px';
    this.brushCursor.style.left = (e.clientX - ds / 2) + 'px';
    this.brushCursor.style.top = (e.clientY - ds / 2) + 'px';
    this.brushCursor.style.display = 'block';
  }

  _updateLoupe(e) {
    const loupeEl = document.getElementById('clone-loupe');
    if (!this.loupeEnabled || !loupeEl) {
      if (loupeEl) loupeEl.style.display = 'none';
      return;
    }
    const loupeCanvas = document.getElementById('clone-loupe-canvas');
    if (!loupeCanvas) return;
    const lCtx = loupeCanvas.getContext('2d');
    const rect = this.canvas.getBoundingClientRect();
    const sx = this.w / rect.width;
    const cx = Math.round((e.clientX - rect.left) * sx);
    const cy = Math.round((e.clientY - rect.top) * sx);
    // srcSize adapts to zoom level: fewer source pixels when zoomed in → more detail in loupe
    const srcSize = Math.max(8, Math.round(20 / this.zoom));
    lCtx.clearRect(0, 0, 120, 120);
    lCtx.save();
    lCtx.beginPath();
    lCtx.arc(60, 60, 58, 0, Math.PI * 2);
    lCtx.clip();
    lCtx.drawImage(this.canvas, cx - srcSize, cy - srcSize, srcSize * 2, srcSize * 2, 0, 0, 120, 120);
    lCtx.strokeStyle = 'rgba(255,255,255,0.6)';
    lCtx.lineWidth = 1;
    lCtx.beginPath();
    lCtx.moveTo(60, 50); lCtx.lineTo(60, 70);
    lCtx.moveTo(50, 60); lCtx.lineTo(70, 60);
    lCtx.stroke();
    lCtx.restore();
    // Clamp inside container
    const cRect = this.container.getBoundingClientRect();
    let lx = e.clientX + 20, ly = e.clientY - 140;
    if (lx + 120 > cRect.right) lx = e.clientX - 140;
    if (ly < cRect.top) ly = e.clientY + 20;
    if (lx < cRect.left) lx = cRect.left + 4;
    if (ly + 120 > cRect.bottom) ly = cRect.bottom - 124;
    loupeEl.style.left = lx + 'px';
    loupeEl.style.top = ly + 'px';
    loupeEl.style.display = 'block';
  }

  _bindEvents() {
    // Mouse events on canvas (listen on paintCanvas too if it's an overlay)
    const evtTarget = this.paintCanvas || this.canvas;
    evtTarget.addEventListener('contextmenu', (e) => { if (this.rightClickPan) e.preventDefault(); });
    evtTarget.addEventListener('mousedown', (e) => {
      if (e.button === 1 || (e.button === 0 && e.altKey) || (this.rightClickPan && e.button === 2)) {
        // Middle click, Alt+click, or right-click (when enabled) = pan
        this.panning = true;
        this.panStart = { x: e.clientX - this.panX, y: e.clientY - this.panY };
        evtTarget.style.cursor = 'grabbing';
        e.preventDefault();
        return;
      }
      if (e.button === 0) {
        const p = this.getCanvasCoords(e);
        // Let onMouseDown intercept (return false to skip auto-paint)
        if (this.onMouseDown) {
          const pCtx = this.paintCanvas ? this.paintCanvas.getContext('2d', { willReadFrequently: true }) : this.ctx;
          if (this.onMouseDown(pCtx, p.x, p.y, e, this) === false) return;
        }
        if (this.onPaint) {
          this.painting = true;
          this.pushUndo();
          this.lastPaintPoint = p;
          const pCtx = this.paintCanvas ? this.paintCanvas.getContext('2d', { willReadFrequently: true }) : this.ctx;
          this.onPaint(pCtx, p.x, p.y, null, this);
        }
      }
    });

    evtTarget.addEventListener('mousemove', (e) => {
      if (this.panning && this.panStart) {
        this.panX = e.clientX - this.panStart.x;
        this.panY = e.clientY - this.panStart.y;
        this._applyTransform();
        return;
      }
      this._updateBrushCursor(e);
      this._updateLoupe(e);
      if (this.painting && this.onPaint) {
        const p = this.getCanvasCoords(e);
        const pCtx = this.paintCanvas ? this.paintCanvas.getContext('2d', { willReadFrequently: true }) : this.ctx;
        this.onPaint(pCtx, p.x, p.y, this.lastPaintPoint, this);
        this.lastPaintPoint = p;
      }
      if (this.onMouseMove) {
        const p = this.getCanvasCoords(e);
        this.onMouseMove(e, p.x, p.y, this);
      }
    });

    evtTarget.addEventListener('mouseleave', () => {
      if (this.brushCursor) this.brushCursor.style.display = 'none';
      const loupeEl = document.getElementById('clone-loupe');
      if (loupeEl) loupeEl.style.display = 'none';
    });

    window.addEventListener('mouseup', () => {
      if (this.painting) {
        this.painting = false;
        this.lastPaintPoint = null;
        if (this.onMouseUp) this.onMouseUp(this);
      }
      if (this.panning) {
        this.panning = false;
        this.panStart = null;
        evtTarget.style.cursor = '';
      }
    });

    // Zoom (wheel)
    this.container.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      this.zoom = Math.max(0.2, Math.min(10, this.zoom * factor));
      this._applyTransform();
      this._updateBrushCursor(e);
      this._updateLoupe(e);
    }, { passive: false });

    // Keyboard: Ctrl+Z/Y
    document.addEventListener('keydown', (e) => {
      // Only handle if our modal is visible
      if (!this.canvas.offsetParent) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        this.undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        this.redo();
      }
    });

    // Buttons
    if (this.undoBtn) this.undoBtn.addEventListener('click', () => this.undo());
    if (this.redoBtn) this.redoBtn.addEventListener('click', () => this.redo());
    if (this.resetBtn) this.resetBtn.addEventListener('click', () => this.reset());
    if (this.loupeBtn) {
      this.loupeBtn.addEventListener('click', () => {
        this.loupeEnabled = !this.loupeEnabled;
        this.loupeBtn.classList.toggle('tool-active', this.loupeEnabled);
        if (!this.loupeEnabled) {
          const l = document.getElementById('clone-loupe');
          if (l) l.style.display = 'none';
        }
      });
    }
  }

  toDataURL() {
    return this.canvas.toDataURL('image/png');
  }
}

// Export for use in index2.js (ES module)
window.CanvasManager = CanvasManager;
