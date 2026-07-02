/**
 * Viewer3D — unified 3D viewer class for FabMesh.
 *
 * Wraps: THREE.WebGLRenderer + THREE.Scene + THREE.PerspectiveCamera
 * + OrbitControls + a default lighting preset + a render loop.
 *
 * Navigation controls (IDENTICAL across every instance):
 *   - Left-click drag    = orbit (rotate around target)
 *   - Middle-click drag  = orbit (rotate around target)
 *   - Right-click drag   = pan
 *   - Mouse wheel        = zoom
 *   - Pinch (touch)      = zoom
 *   - Double-click       = reset camera (viewer-specific handler)
 *
 * Usage:
 *   import { Viewer3D } from './lib/Viewer3D.js';
 *   const viewer = new Viewer3D({ canvas, fov: 45, bgColor: 0x0b0b14 });
 *   viewer.scene.add(myMesh);
 *   viewer.startTickLoop();
 *   viewer.dispose(); // when unmounting
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class Viewer3D {
  /**
   * @param {Object} opts
   * @param {HTMLCanvasElement} opts.canvas            REQUIRED
   * @param {number} [opts.fov=45]                     Camera FOV
   * @param {number} [opts.near=0.01]                  Camera near plane
   * @param {number} [opts.far=100]                    Camera far plane
   * @param {number} [opts.bgColor=0x0b0b14]           Scene background
   * @param {boolean} [opts.alpha=true]                Transparent canvas
   * @param {Array<number>} [opts.cameraPos=[2,2,3]]   Initial camera pos
   * @param {boolean} [opts.lighting=true]             Add default lights
   * @param {boolean} [opts.toneMapping=true]          ACESFilmic tone mapping
   * @param {boolean} [opts.damping=true]              OrbitControls damping
   * @param {boolean} [opts.autoResize=true]           Resize on window events
   */
  constructor(opts) {
    if (!opts || !opts.canvas) {
      throw new Error('Viewer3D: canvas is required');
    }
    this.canvas = opts.canvas;
    const w = this.canvas.clientWidth || this.canvas.width || 512;
    const h = this.canvas.clientHeight || this.canvas.height || 512;

    // Renderer — GUARD WebGL creation. On a machine with no usable WebGL
    // context (weak/old Intel iGPU on Chromium's GL blocklist, RDP, a VM,
    // "disable hardware acceleration" on), `new THREE.WebGLRenderer` THROWS.
    // Uncaught, that exception bubbles to the app-level error panel and bricks
    // the WHOLE app — even a cloud-only user who just wants to VIEW a mesh.
    // Catch it, mark the viewer unavailable + show an inline note, and leave
    // the instance inert-but-safe (renderer-using methods no-op below).
    this.renderer = null;
    this.webglUnavailable = false;
    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        antialias: true,
        alpha: opts.alpha !== false,
      });
      this.renderer.setSize(w, h, false);
      // Cap the device pixel ratio: at 200% HiDPI devicePixelRatio=2 → 4x the
      // pixels to shade, which melts weak iGPUs. 1.5 stays crisp without the
      // 4x blowup.
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      if (opts.toneMapping !== false) {
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.0;
      }
    } catch (e) {
      this.renderer = null;
      this.webglUnavailable = true;
      try { this._renderWebglFallback(); } catch (_) {}
    }

    // Scene
    this.scene = new THREE.Scene();
    if (opts.bgColor !== undefined && opts.bgColor !== null) {
      this.scene.background = new THREE.Color(opts.bgColor);
    }

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      opts.fov || 45,
      w / h,
      opts.near || 0.01,
      opts.far || 100,
    );
    const cp = opts.cameraPos || [2, 2, 3];
    this.camera.position.set(cp[0], cp[1], cp[2]);

    // Controls
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = opts.damping !== false;
    // Middle (wheel) button drag rotates too — users expect to grab the
    // wheel and orbit; the OrbitControls default maps MIDDLE to dolly/zoom.
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.ROTATE,
      RIGHT: THREE.MOUSE.PAN,
    };

    // Lighting (optional)
    if (opts.lighting !== false) {
      this._addDefaultLighting();
    }

    // Tick loop state
    this._rafId = null;
    this._ticking = false;
    this._onBeforeRender = opts.onBeforeRender || null;

    // Resize
    this._resizeObserver = null;
    if (opts.autoResize !== false) {
      this._setupAutoResize();
    }

    // Exposed initial camera target for reset()
    this._initialCamPos = this.camera.position.clone();
    this._initialTarget = this.controls.target.clone();
  }

  _addDefaultLighting() {
    // Bumped from 1.0/1.2/0.5/0.3 — meshes baked with PBR metallic/
    // roughness swallow ambient and the previous values left dragons,
    // dark armours, etc. essentially unreadable in the viewer.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.6));
    const dir = new THREE.DirectionalLight(0xffffff, 1.8);
    dir.position.set(5, 8, 5);
    this.scene.add(dir);
    const fill = new THREE.DirectionalLight(0xffffff, 0.9);
    fill.position.set(-5, 3, -5);
    this.scene.add(fill);
    const back = new THREE.DirectionalLight(0xffffff, 0.6);
    back.position.set(0, 5, -8);
    this.scene.add(back);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    if (this.renderer) this.renderer.toneMappingExposure = 1.3;
  }

  _setupAutoResize() {
    if (typeof ResizeObserver === 'undefined') return;
    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(this.canvas);
  }

  /** Inject an inline "3D preview unavailable" note when WebGL can't start,
   *  so the app stays fully usable (generation + file output still work). */
  _renderWebglFallback() {
    const host = this.canvas.parentElement || this.canvas;
    const note = document.createElement('div');
    note.className = 'webgl-fallback';
    note.textContent = '3D preview unavailable on this display (no WebGL / graphics acceleration). Generation still works and the mesh is saved to disk.';
    note.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:16px;color:#aab;font-size:13px;line-height:1.5;opacity:.85;';
    try {
      if (host !== this.canvas && getComputedStyle(host).position === 'static') host.style.position = 'relative';
      host.appendChild(note);
      this.canvas.style.display = 'none';
    } catch (_) {}
  }

  /** Resize renderer + camera to current canvas size. */
  resize() {
    if (!this.renderer) return;
    const w = this.canvas.clientWidth || 512;
    const h = this.canvas.clientHeight || 512;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Start a render-on-visible tick loop. Idempotent. */
  startTickLoop() {
    if (!this.renderer) return;  // no WebGL → nothing to render (safe no-op)
    if (this._ticking) return;
    this._ticking = true;
    const tick = () => {
      if (!this._ticking) return;
      this._rafId = requestAnimationFrame(tick);
      const visible = this.canvas.offsetParent !== null
        && document.visibilityState !== 'hidden';
      if (!visible) return;
      this.controls.update();
      if (this._onBeforeRender) {
        try { this._onBeforeRender(this); } catch (e) { /* swallow */ }
      }
      this.renderer.render(this.scene, this.camera);
    };
    tick();
  }

  /** Stop the tick loop but keep renderer/scene alive. */
  stopTickLoop() {
    this._ticking = false;
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  /** Reset camera to its initial position + target. */
  reset() {
    this.camera.position.copy(this._initialCamPos);
    this.controls.target.copy(this._initialTarget);
    this.controls.update();
  }

  /**
   * Frame an object (center + fit). Works on any Object3D with a
   * computable bounding box.
   */
  frame(object3d, fitScale = 1.4) {
    const box = new THREE.Box3().setFromObject(object3d);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxSize = Math.max(size.x, size.y, size.z);
    const distance = maxSize * fitScale / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const dir = this.camera.position.clone().sub(this.controls.target)
      .normalize();
    this.camera.position.copy(center.clone().add(dir.multiplyScalar(distance)));
    this.controls.target.copy(center);
    this.camera.near = Math.max(0.01, distance / 100);
    this.camera.far = distance * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    // Save as new "reset" pose
    this._initialCamPos = this.camera.position.clone();
    this._initialTarget = this.controls.target.clone();
  }

  /** Dispose GL + resize observer. Call when removing from DOM. */
  dispose() {
    this.stopTickLoop();
    if (this._resizeObserver) {
      try { this._resizeObserver.disconnect(); } catch (_) {}
      this._resizeObserver = null;
    }
    try { this.controls.dispose(); } catch (_) {}
    try { this.renderer.dispose(); } catch (_) {}
    // Traverse scene and dispose geometries/materials/textures
    this.scene.traverse(obj => {
      if (obj.geometry) { try { obj.geometry.dispose(); } catch (_) {} }
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach(m => {
          if (m.map) { try { m.map.dispose(); } catch (_) {} }
          try { m.dispose(); } catch (_) {}
        });
      }
    });
  }
}

// Convenience helper for old-style callers: create + return the same
// tuple of {renderer, scene, camera, controls} the legacy code expects.
export function createViewer3D(opts) {
  const v = new Viewer3D(opts);
  v.startTickLoop();
  return v;
}
