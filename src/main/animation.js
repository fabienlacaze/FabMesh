// =============================================================================
// src/main/animation.js â€” Animate step IPC handlers (MyFabmesh v1)
// -----------------------------------------------------------------------------
// Wired into the existing Electron main from src/main/main.js:
//
//     // near the bottom of main.js, after MESHES_DIR is initialized
//     require('./animation').register({
//       ipcMain, app, BrowserWindow,
//       MESHES_DIR, isPathAllowed, trackProc,
//     });
//
// Channels exposed:
//   anim:list-motions   ({ class })                  -> { motions: [...] }
//   anim:motion-thumb   ({ id })                     -> { path }
//   anim:retarget       ({ meshPath, motionId, mode })       -> { glbPath }
//   anim:judge          ({ glbPath })                -> { metrics, verdict }
//   anim:export         ({ glbPath, format, dest })  -> { path }
//   anim:cancel         ({ jobId })                  -> { ok }
//
// Streaming events sent to the renderer via mainWindow.webContents.send():
//   anim:progress       { jobId, phase, pct, msg }
//   anim:log            { jobId, line }
// =============================================================================

'use strict';

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const crypto   = require('crypto');
const { spawn, execFile, execSync } = require('child_process');
const { app } = require('electron');
// Lineage sidecar <output>.meta.json (Generation History) — best-effort.
const { writeMeta } = require('./meta');

// -----------------------------------------------------------------------------
// Blender resolution — unified with src/main/main.js (_resolveBlenderPath).
// Order: config.json blenderPath (if it exists) → auto-detection → null.
// Previously this module hard-coded c:/tools/blender-4.4.3-... which never
// exists on a client machine, hard-gating retarget/export on a dev-only path.
// -----------------------------------------------------------------------------
function _dataBase() {
  try {
    return app && app.isPackaged
      ? app.getPath('userData')
      : path.join(__dirname, '..', '..');
  } catch (_) {
    return path.join(__dirname, '..', '..');
  }
}

function _configBlenderPath() {
  try {
    const cfgPath = path.join(_dataBase(), 'config.json');
    if (fs.existsSync(cfgPath)) {
      const j = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (j && j.blenderPath) return j.blenderPath;
    }
  } catch (_) {}
  return '';
}

function _autoDetectBlender() {
  if (process.env.BLENDER_EXE && fs.existsSync(process.env.BLENDER_EXE)) {
    return process.env.BLENDER_EXE;
  }
  const pf   = process.env['ProgramFiles']      || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const candidates = [];
  for (const root of [path.join(pf, 'Blender Foundation'), path.join(pf86, 'Blender Foundation')]) {
    try {
      if (fs.existsSync(root)) {
        for (const sub of fs.readdirSync(root)) {
          const exe = path.join(root, sub, 'blender.exe');
          if (fs.existsSync(exe)) candidates.push(exe);
        }
      }
    } catch (_) {}
  }
  for (const steam of [
    path.join(pf86, 'Steam', 'steamapps', 'common', 'Blender', 'blender.exe'),
    path.join(pf,   'Steam', 'steamapps', 'common', 'Blender', 'blender.exe'),
  ]) {
    try { if (fs.existsSync(steam)) candidates.push(steam); } catch (_) {}
  }
  if (candidates.length) {
    candidates.sort();
    return candidates[candidates.length - 1];
  }
  try {
    const out = execSync('where blender', {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const first = out.split(/\r?\n/)[0];
    if (first && fs.existsSync(first)) return first;
  } catch (_) {}
  return null;
}

// Returns a usable blender.exe path, or null if none can be found.
function _resolveBlender() {
  const cfg = _configBlenderPath();
  if (cfg && fs.existsSync(cfg)) return cfg;
  return _autoDetectBlender();
}

// Apovivor FBX library bundled in `external/apovivor/1_Source/` when shipped,
// or pulled from `c:/tmp/apovivor_fbx/1_Source` during dev. We resolve both.
const MOTION_LIB_CANDIDATES = [
  path.join(process.resourcesPath || '', 'apovivor', '1_Source'),
  path.join(__dirname, '..', '..', 'external', 'apovivor', '1_Source'),
  'c:/tmp/apovivor_fbx/1_Source',
];

const CACHE_ROOT = path.join(
  (process.env.APPDATA || os.homedir()), 'fabmesh', 'cache');
const MOTION_THUMBS_DIR = path.join(CACHE_ROOT, 'motion_thumbs');
const MOTION_INDEX_PATH = path.join(CACHE_ROOT, 'motion_index.json');

// Modal cloud endpoint (set in config.json by the wizard)
// Read PER-INVOCATION (not frozen at module load, which the wizard's config
// load never populated) so a URL configured after startup is honoured. Empty
// until a Modal retarget endpoint is actually wired.
function _cloudRetargetUrl() { return process.env.FABMESH_CLOUD_RETARGET_URL || ''; }

// Cost model â€” keep in sync with modal_app/_realvis.py pricing column
const CLOUD_COST_PER_RETARGET_USD = 0.012; // ~CPU container, < 30 s typical

// In-flight jobs so anim:cancel can SIGTERM them
const _jobs = new Map(); // jobId -> { proc, startedAt }

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function _ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (_) {} }
function _safeId() { return crypto.randomBytes(8).toString('hex'); }

function _resolveMotionLib() {
  for (const cand of MOTION_LIB_CANDIDATES) {
    if (cand && fs.existsSync(cand)) return cand;
  }
  return null;
}

/**
 * Build (or refresh) the motion index by reading FBX filenames and bucketing
 * by class. Apovivor uses a `ANIM_<CLASS>_<NAME>_<VERB>.fbx` convention; we
 * map class prefixes to the three Puppeteer anchors.
 */
function _buildMotionIndex(libRoot) {
  // 2026-06-13: Apovivor naming is inconsistent (ANIM_<animal>_<verb> for
  // animals, ANIM_AS_<Robot>_<verb> for humanoids, ANIM_MOUNTAIN_DRAGON_<verb>
  // for dragons). Use a substring rule list instead of strict prefix match.
  const CLASS_RULES = [
    { keywords: ['mountain_dragon', 'wyvern', 'crow', 'phoenix'],
      cls: 'winged_biped' },
    { keywords: ['comodo_dragon', 'wolfhound', 'lizard', 'elephant',
                 'wolf', 'tiger', 'bear', 'horse', 'lion', 'cat', 'dog',
                 'fox', 'deer', 'sheep', 'spider', 'hexapod'],
      cls: 'quadruped' },
    { keywords: ['as_robot', '_robot', 'samurai', 'peasant', 'orc',
                 'humanoid', 'human', 'soldier', 'warrior'],
      cls: 'humanoid' },
  ];
  function detectClass(filename) {
    const lc = filename.toLowerCase();
    for (const rule of CLASS_RULES) {
      if (rule.keywords.some((k) => lc.includes(k))) return rule.cls;
    }
    return 'humanoid';  // safe fallback
  }
  const out = { generatedAt: Date.now(), root: libRoot, motions: [] };
  const files = fs.readdirSync(libRoot).filter((f) => f.toLowerCase().endsWith('.fbx'));
  for (const fname of files) {
    const base = fname.replace(/\.fbx$/i, '');
    const tokens = base.split('_');
    const cls = detectClass(base);
    out.motions.push({
      id: base,
      label: (tokens.slice(1).join(' ') || base),
      cls,
      fbxPath: path.join(libRoot, fname),
      thumb: path.join(MOTION_THUMBS_DIR, `${base}.webp`),
    });
  }
  return out;
}

function _readOrBuildIndex() {
  const lib = _resolveMotionLib();
  if (!lib) return { motions: [], root: null };
  try {
    if (fs.existsSync(MOTION_INDEX_PATH)) {
      const j = JSON.parse(fs.readFileSync(MOTION_INDEX_PATH, 'utf8'));
      if (j.root === lib && Array.isArray(j.motions)) return j;
    }
  } catch (_) {}
  _ensureDir(CACHE_ROOT);
  const idx = _buildMotionIndex(lib);
  try { fs.writeFileSync(MOTION_INDEX_PATH, JSON.stringify(idx, null, 2)); } catch (_) {}
  return idx;
}

function _sendToAllWindows(BrowserWindow, channel, payload) {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    }
  } catch (_) {}
}

// -----------------------------------------------------------------------------
// Subprocess runner â€” local Blender retarget
// -----------------------------------------------------------------------------
function _spawnLocalRetarget({
  jobId, meshPath, motion, outGlb, BrowserWindow, trackProc,
}) {
  return new Promise((resolve, reject) => {
    const scriptsDir = path.join(__dirname, '..', '..', 'scripts');
    const scriptPath = path.join(scriptsDir, 'rokoko_batch_retarget.py');
    const blenderExe = _resolveBlender();
    if (!blenderExe || !fs.existsSync(blenderExe)) {
      return reject(new Error(
        "Blender est requis pour l'animation (retarget) mais reste introuvable. " +
        "Installez Blender (blender.org) puis indiquez son chemin dans Réglages."
      ));
    }
    if (!fs.existsSync(scriptPath)) {
      return reject(new Error('rokoko_batch_retarget.py missing'));
    }
    const args = [
      '--background', '--factory-startup',
      '--python', scriptPath, '--',
      '--src-fbx', motion.fbxPath,
      '--tgt-glb', meshPath,
      '--out-dir', path.dirname(outGlb),
      '--out-name', path.basename(outGlb),
    ];
    const proc = spawn(blenderExe, args, {
      cwd: scriptsDir,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    if (typeof trackProc === 'function') trackProc(proc);
    _jobs.set(jobId, { proc, startedAt: Date.now() });

    let stderr = '';
    const onLine = (chunk) => {
      const line = chunk.toString();
      _sendToAllWindows(BrowserWindow, 'anim:log', { jobId, line });
      // Cheap progress parse: "[rokoko-single] phase=bake frame=42/120"
      const m = line.match(/phase=(\w+)\s+frame=(\d+)\/(\d+)/);
      if (m) {
        const pct = Math.round((Number(m[2]) / Math.max(1, Number(m[3]))) * 100);
        _sendToAllWindows(BrowserWindow, 'anim:progress',
          { jobId, phase: m[1], pct });
      }
    };
    proc.stdout.on('data', onLine);
    proc.stderr.on('data', (c) => { stderr += c.toString(); onLine(c); });

    proc.on('error', (err) => {
      _jobs.delete(jobId);
      reject(err);
    });
    proc.on('close', (code) => {
      _jobs.delete(jobId);
      if (code === 0 && fs.existsSync(outGlb)) {
        resolve({ glbPath: outGlb });
      } else {
        reject(new Error(`Blender exited code=${code}\n${stderr.slice(-2000)}`));
      }
    });
  });
}

// -----------------------------------------------------------------------------
// Generative motion AI (Kimodo) — text -> motion diffusion, local RTX GPU.
// scripts/kimodo_bridge.py: prompt -> BVH SOMA -> retarget onto the rig GLB.
// Needs the Kimodo venv (FABMESH_KIMODO_PY or c:\tmp\kmv312).
// -----------------------------------------------------------------------------
function _resolveKimodoPython() {
  const cands = [
    process.env.FABMESH_KIMODO_PY,
    'c:\\tmp\\kmv312\\Scripts\\python.exe',
  ];
  for (const c of cands) { if (c && fs.existsSync(c)) return c; }
  return null;
}

// animType -> English prompt (Kimodo is text-conditioned; the dropdown
// values map to fixed prompts so the UX stays one-click).
const KIMODO_PROMPTS = {
  idle:   'a person stands idle, shifting weight and looking around.',
  walk:   'a person walks forward.',
  run:    'a person runs fast forward.',
  attack: 'a person throws a powerful punch attack.',
  death:  'a person collapses to the ground and lies still.',
  fly:    'a person leaps high into the air.',
};

function _spawnKimodo({ jobId, meshPath, prompt, animType, outGlb, BrowserWindow, trackProc }) {
  return new Promise((resolve, reject) => {
    const scriptsDir = path.join(__dirname, '..', '..', 'scripts');
    const scriptPath = path.join(scriptsDir, 'kimodo_bridge.py');
    const py = _resolveKimodoPython();
    if (!py) {
      return reject(new Error(
        "Le moteur IA de mouvement n'est pas installé sur cette machine " +
        '(venv Kimodo introuvable — FABMESH_KIMODO_PY ou c:\\tmp\\kmv312).'));
    }
    if (!fs.existsSync(scriptPath)) {
      return reject(new Error('kimodo_bridge.py missing'));
    }
    const args = [scriptPath,
      '--rig', meshPath, '--out', outGlb,
      '--prompt', prompt, '--clip-name', animType];
    const proc = spawn(py, args, {
      cwd: scriptsDir,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    if (typeof trackProc === 'function') trackProc(proc);
    _jobs.set(jobId, { proc, startedAt: Date.now() });

    let stderr = '';
    const onLine = (chunk) => {
      const line = chunk.toString();
      _sendToAllWindows(BrowserWindow, 'anim:log', { jobId, line });
      const m = line.match(/LOCAL_KIMODO_PROGRESS:\s*(\d+)/);
      if (m) {
        _sendToAllWindows(BrowserWindow, 'anim:progress',
          { jobId, phase: 'kimodo', pct: Number(m[1]) });
      }
    };
    proc.stdout.on('data', onLine);
    proc.stderr.on('data', (c) => { stderr += c.toString(); onLine(c); });
    proc.on('error', (err) => { _jobs.delete(jobId); reject(err); });
    proc.on('close', (code) => {
      _jobs.delete(jobId);
      if (code === 0 && fs.existsSync(outGlb)) {
        resolve({ glbPath: outGlb });
      } else {
        reject(new Error(`kimodo_bridge exited code=${code}\n${stderr.slice(-2000)}`));
      }
    });
  });
}

// -----------------------------------------------------------------------------
// Cloud retarget â€” POST to Modal endpoint, stream multipart, save GLB
// -----------------------------------------------------------------------------
async function _runCloudRetarget({ jobId, meshPath, motion, outGlb, BrowserWindow }) {
  const CLOUD_RETARGET_URL = _cloudRetargetUrl();
  if (!CLOUD_RETARGET_URL) {
    throw new Error('Cloud retarget is not configured yet — use Local mode.');
  }
  _sendToAllWindows(BrowserWindow, 'anim:progress',
    { jobId, phase: 'upload', pct: 0 });
  const form = new FormData();
  form.append('mesh', new Blob([fs.readFileSync(meshPath)]),
    path.basename(meshPath));
  form.append('motion_id', motion.id);
  const res = await fetch(CLOUD_RETARGET_URL, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Cloud retarget HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  _ensureDir(path.dirname(outGlb));
  fs.writeFileSync(outGlb, buf);
  _sendToAllWindows(BrowserWindow, 'anim:progress',
    { jobId, phase: 'done', pct: 100 });
  return { glbPath: outGlb };
}

// -----------------------------------------------------------------------------
// Judge â€” call scripts/render_retarget_screenshots.py + metrics parser
// -----------------------------------------------------------------------------
function _runJudge(glbPath) {
  return new Promise((resolve) => {
    const scriptsDir = path.join(__dirname, '..', '..', 'scripts');
    const judgeScript = path.join(scriptsDir, 'render_retarget_screenshots.py');
    if (!fs.existsSync(judgeScript)) {
      return resolve({ verdict: 'skipped', metrics: {} });
    }
    execFile('python', [judgeScript, '--glb', glbPath, '--json'],
      { cwd: scriptsDir, timeout: 60_000 },
      (err, stdout) => {
        if (err) return resolve({ verdict: 'error', error: String(err) });
        try {
          const m = JSON.parse(stdout);
          const verdict = (m.global_std || 0) > 0.3 ? 'pass' : 'static';
          resolve({ verdict, metrics: m });
        } catch (_) {
          resolve({ verdict: 'unparsed', metrics: {} });
        }
      });
  });
}

// -----------------------------------------------------------------------------
// Export (GLB / FBX / USD) â€” reuse Blender for FBX/USD conversion
// -----------------------------------------------------------------------------
function _runExport({ glbPath, format, dest }) {
  return new Promise((resolve, reject) => {
    if (format === 'glb') {
      fs.copyFileSync(glbPath, dest);
      return resolve({ path: dest });
    }
    const scriptsDir = path.join(__dirname, '..', '..', 'scripts');
    const convertScript = path.join(scriptsDir, 'convert_glb.py');
    const blenderExe = _resolveBlender();
    if (!fs.existsSync(convertScript) || !blenderExe || !fs.existsSync(blenderExe)) {
      return reject(new Error(
        `Impossible de convertir en ${format} : Blender introuvable ou script manquant. ` +
        "Installez Blender (blender.org) puis renseignez son chemin dans Réglages."
      ));
    }
    execFile(blenderExe, [
      '--background', '--factory-startup',
      '--python', convertScript, '--',
      '--in', glbPath, '--out', dest, '--format', format,
    ], { timeout: 180_000 }, (err) => {
      if (err) return reject(err);
      resolve({ path: dest });
    });
  });
}

// =============================================================================
// register({ ipcMain, app, BrowserWindow, MESHES_DIR, isPathAllowed, trackProc })
// =============================================================================
function register(deps) {
  const { ipcMain, app, BrowserWindow, MESHES_DIR, isPathAllowed, trackProc, isCloudMode } = deps;
  const _cloud = () => { try { return typeof isCloudMode === 'function' && isCloudMode(); } catch (_) { return false; } };
  _ensureDir(MOTION_THUMBS_DIR);

  // ---------------------------------------------------------------------------
  // anim:list-motions â€” return motions filtered by detected class
  // ---------------------------------------------------------------------------
  ipcMain.handle('anim:list-motions', async (_e, { class: cls } = {}) => {
    const idx = _readOrBuildIndex();
    const filtered = cls
      ? idx.motions.filter((m) => m.cls === cls)
      : idx.motions;
    return { motions: filtered.slice(0, 500), total: filtered.length };
  });

  // ---------------------------------------------------------------------------
  // anim:motion-thumb â€” lazy-render a small loop preview if missing
  // ---------------------------------------------------------------------------
  ipcMain.handle('anim:motion-thumb', async (_e, { id } = {}) => {
    const idx = _readOrBuildIndex();
    const m = idx.motions.find((x) => x.id === id);
    if (!m) return { path: null };
    if (fs.existsSync(m.thumb)) return { path: m.thumb };
    // Defer to a Python renderer if available; for v1 we accept a missing
    // thumbnail and let the renderer show a placeholder.
    const scriptsDir = path.join(__dirname, '..', '..', 'scripts');
    const thumbScript = path.join(scriptsDir, 'render_motion_thumb.py');
    if (!fs.existsSync(thumbScript)) return { path: null };
    await new Promise((resolve) => {
      execFile('python', [thumbScript, '--fbx', m.fbxPath, '--out', m.thumb],
        { timeout: 30_000 }, () => resolve());
    });
    return { path: fs.existsSync(m.thumb) ? m.thumb : null };
  });

  // ---------------------------------------------------------------------------
  // anim:retarget â€” main work, local or cloud
  // ---------------------------------------------------------------------------
  ipcMain.handle('anim:retarget', async (_e, opts = {}) => {
    const { meshPath, motionId, mode } = opts;
    if (!meshPath || !fs.existsSync(meshPath)) {
      return { success: false, error: 'Mesh not found' };
    }
    if (typeof isPathAllowed === 'function' && !isPathAllowed(meshPath)) {
      return { success: false, error: 'Mesh path not allowed' };
    }
    // Mode Cloud : pipeline Rokoko/Blender local sans équivalent worker —
    // ceinture+bretelles (l'option rokoko_library est aussi masquée côté
    // renderer par _applyCloudFeatureMask).
    if (_cloud()) {
      return { success: false,
        error: 'Bibliothèque de mouvements indisponible en mode Cloud — utilisez le moteur génératif.' };
    }
    const idx = _readOrBuildIndex();
    const motion = idx.motions.find((m) => m.id === motionId);
    if (!motion) return { success: false, error: `Unknown motionId=${motionId}` };

    const jobId = _safeId();
    const outDir = path.join(MESHES_DIR || os.tmpdir(), 'animated');
    _ensureDir(outDir);
    // 2026-06-13: align with rokoko_batch_retarget.py:997 which writes
    // `${Path(src_fbx).stem}__${Path(tgt_glb).stem}.glb` — we must
    // compute the same filename so fs.existsSync(outGlb) succeeds at
    // proc.close. Previously animation.js used a timestamped name
    // that never existed -> "Blender exited code=0" misleading.
    const motionStem = path.basename(motion.fbxPath, path.extname(motion.fbxPath));
    const rigStem = path.basename(meshPath, path.extname(meshPath));
    const outGlb = path.join(outDir, `${motionStem}__${rigStem}.glb`);

    const motionDisplay = motion.label || motion.id || 'motion';
    _sendToAllWindows(BrowserWindow, 'anim:progress',
      { jobId, phase: 'start', pct: 0,
        msg: `Retargeting "${motionDisplay}" (${mode})` });

    try {
      const runner = (mode === 'cloud')
        ? _runCloudRetarget
        : _spawnLocalRetarget;
      const { glbPath } = await runner({
        jobId, meshPath, motion, outGlb, BrowserWindow, trackProc,
      });
      // Lineage sidecar: clip + mode + rig parent explicite (l'objet riche
      // du renderer était RAM-only, perdu au reload).
      writeMeta(glbPath, {
        kind: 'anim', engine: 'rokoko_retarget', parent: meshPath,
        params: { motionId, motionLabel: motion.label || motion.id, mode: mode || 'local' },
      });
      _sendToAllWindows(BrowserWindow, 'anim:progress',
        { jobId, phase: 'done', pct: 100 });
      return { success: true, jobId, glbPath };
    } catch (err) {
      _sendToAllWindows(BrowserWindow, 'anim:progress',
        { jobId, phase: 'error', pct: 0, msg: String(err.message || err) });
      return { success: false, jobId, error: String(err.message || err) };
    }
  });

  // ---------------------------------------------------------------------------
  // anim:kimodo — generative motion AI (text -> motion), humanoid rigs only
  // ---------------------------------------------------------------------------
  ipcMain.handle('anim:kimodo', async (_e, opts = {}) => {
    const { meshPath, animType, prompt } = opts;
    if (!meshPath || !fs.existsSync(meshPath)) {
      return { success: false, error: 'Mesh not found' };
    }
    if (typeof isPathAllowed === 'function' && !isPathAllowed(meshPath)) {
      return { success: false, error: 'Mesh path not allowed' };
    }
    const type = String(animType || 'walk').toLowerCase();
    const effPrompt = (prompt && String(prompt).trim())
      || KIMODO_PROMPTS[type] || KIMODO_PROMPTS.walk;

    const jobId = _safeId();
    const outDir = path.join(MESHES_DIR || os.tmpdir(), 'animated');
    _ensureDir(outDir);
    const rigStem = path.basename(meshPath, path.extname(meshPath));
    const outGlb = path.join(outDir, `kimodo_${type}__${rigStem}.glb`);

    // ── Mode Cloud : POST /api/animate (AnyTop, 5 crédits) + polling
    // GET /api/animate-status (5 s, cap 15 min). Même nommage local
    // (kimodo_<type>__<rigStem>.glb) → list-animations/strip inchangés.
    // require paresseux : cloudFallback.register(...) est appelé par main.js
    // APRÈS ce register — au moment de l'appel IPC ses deps sont posées.
    if (_cloud()) {
      _sendToAllWindows(BrowserWindow, 'anim:progress',
        { jobId, phase: 'start', pct: 5, msg: `[cloud] Génération "${type}" (moteur cloud)…` });
      try {
        const cloudFallback = require('./cloud_fallback');
        const start = await cloudFallback.startMeshJob({
          meshPath, startPath: '/api/animate',
          bodyFor: (u) => ({
            rig_url: u, anim_type: type, prompt: effPrompt,
            engine: 'anytop', batch_id: `d${Date.now().toString(36)}`,
          }),
        });
        if (!start.success) {
          throw new Error(start.error
            || (start.needsCloudLogin ? 'Session cloud expirée — reconnectez-vous.' : 'cloud animate start failed'));
        }
        const done = await cloudFallback.pollJob({
          statusPath: '/api/animate-status', jobId: start.jobId, outPath: outGlb,
          urlKeys: ['anim_url', 'url'], intervalMs: 5000, capMs: 15 * 60 * 1000, minBytes: 1000,
          onTick: (st, polls, js) => {
            const pct = Math.min(90, 10 + polls * 2);
            _sendToAllWindows(BrowserWindow, 'anim:progress',
              { jobId, phase: 'progress', pct,
                msg: `[cloud] ${(js && js.stage) || st || 'en cours'}…` });
          },
        });
        if (!done.success) throw new Error(done.error || 'cloud animation failed');
        writeMeta(outGlb, {
          kind: 'anim', engine: 'anytop_cloud', parent: meshPath,
          params: { animType: type, prompt: effPrompt, mode: 'cloud', r2_url: done.resultUrl },
        });
        _sendToAllWindows(BrowserWindow, 'anim:progress',
          { jobId, phase: 'done', pct: 100 });
        return { success: true, jobId, glbPath: outGlb };
      } catch (err) {
        _sendToAllWindows(BrowserWindow, 'anim:progress',
          { jobId, phase: 'error', pct: 0, msg: String(err.message || err) });
        return { success: false, jobId, error: String(err.message || err) };
      }
    }

    _sendToAllWindows(BrowserWindow, 'anim:progress',
      { jobId, phase: 'start', pct: 0, msg: `Generating "${type}" (AI, local)` });
    try {
      const { glbPath } = await _spawnKimodo({
        jobId, meshPath, prompt: effPrompt, animType: type, outGlb,
        BrowserWindow, trackProc,
      });
      writeMeta(glbPath, {
        kind: 'anim', engine: 'kimodo', parent: meshPath,
        params: { animType: type, prompt: effPrompt, mode: 'local' },
      });
      _sendToAllWindows(BrowserWindow, 'anim:progress',
        { jobId, phase: 'done', pct: 100 });
      return { success: true, jobId, glbPath };
    } catch (err) {
      _sendToAllWindows(BrowserWindow, 'anim:progress',
        { jobId, phase: 'error', pct: 0, msg: String(err.message || err) });
      return { success: false, jobId, error: String(err.message || err) };
    }
  });

  // ---------------------------------------------------------------------------
  // anim:judge â€” run headless QA renderer + parse metrics
  // ---------------------------------------------------------------------------
  // ── Banque de mouvements : clips tout faits retargetes sur le squelette
  // SkinTokens du mesh (decision user 2026-08-08 : le squelette reste celui de
  // SkinTokens, les banques l'animent).
  //   m2m      = 8 creatures / 73 clips CC0 (Mesh2Motion), livres avec l'app
  //   apovivor = clips FBX exportes d'Unreal par l'utilisateur (perso, jamais
  //              redistribues — licence Fab)
  // Les ponts n'ont besoin que de numpy/scipy : python systeme par defaut,
  // FABMESH_ANIM_PY pour forcer un interpreteur.
  const _CREATURES_M2M = new Set(['spider', 'dragon', 'snake', 'kaiju',
                                  'horse', 'bird', 'fox', 'shark']);
  function _dossierClipsM2M() {
    const cands = [
      process.env.FABMESH_M2M_CLIPS,
      process.resourcesPath ? path.join(process.resourcesPath, 'm2m_clips') : null,
      path.join(__dirname, '..', '..', 'build', 'm2m'),
    ];
    for (const c of cands) { if (c && fs.existsSync(c)) return c; }
    return null;
  }
  // Lire les noms de clips d'un GLB SANS python : en-tete JSON du conteneur.
  function _nomsClipsGlb(p) {
    try {
      const fd = fs.openSync(p, 'r');
      const tete = Buffer.alloc(20);
      fs.readSync(fd, tete, 0, 20, 0);
      if (tete.readUInt32LE(0) !== 0x46546C67) { fs.closeSync(fd); return []; }
      const lgJson = tete.readUInt32LE(12);
      const json = Buffer.alloc(lgJson);
      fs.readSync(fd, json, 0, lgJson, 20);
      fs.closeSync(fd);
      const doc = JSON.parse(json.toString('utf8'));
      return (doc.animations || []).map((a, i) => a.name || ('clip_' + i));
    } catch (_) { return []; }
  }

  ipcMain.handle('anim:banque-liste', async () => {
    const out = { m2m: [], apovivor: [] };
    const dir = _dossierClipsM2M();
    if (dir) {
      for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.glb'))) {
        const creature = f.replace(/\.glb$/, '').replace(/-animations$/, '');
        if (!_CREATURES_M2M.has(creature)) continue;
        for (const nom of _nomsClipsGlb(path.join(dir, f))) {
          if (/rest/i.test(nom)) continue;      // poses de repos statiques
          out.m2m.push({ creature, clip: nom });
        }
      }
    }
    const adir = process.env.FABMESH_APOVIVOR_CLIPS || 'C:\\tmp\\apovivor_fbx\\glb';
    if (fs.existsSync(adir)) {
      for (const f of fs.readdirSync(adir).filter(x => x.endsWith('.glb'))) {
        out.apovivor.push({ clip: f.replace(/\.glb$/, ''), path: path.join(adir, f) });
      }
    }
    return { success: true, ...out };
  });

  ipcMain.handle('anim:banque', async (_e, opts = {}) => {
    const { meshPath, source, creature, clip, clipPath } = opts;
    if (!meshPath || !fs.existsSync(meshPath)) {
      return { success: false, error: 'Mesh not found' };
    }
    if (typeof isPathAllowed === 'function' && !isPathAllowed(meshPath)) {
      return { success: false, error: 'Mesh path not allowed' };
    }
    const jobId = _safeId();
    const outDir = path.join(MESHES_DIR || os.tmpdir(), 'animated');
    _ensureDir(outDir);
    const rigStem = path.basename(meshPath, path.extname(meshPath));
    const slug = String(clip || 'clip').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 24);
    const outGlb = path.join(outDir, `banque_${slug}__${rigStem}.glb`);

    const scriptsDir = path.join(__dirname, '..', '..', 'scripts');
    const py = process.env.FABMESH_ANIM_PY || 'python';
    const env = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1' };
    const dirM2M = _dossierClipsM2M();
    if (dirM2M) env.FABMESH_M2M_CLIPS = dirM2M;
    // Attenuation PAR CLIP : les clips violents (course, saut, attaque)
    // debordent a pleine puissance — constate sur la course du wolfhound, une
    // patte passait le point de bascule. Les clips calmes restent a 1.0.
    if (!env.ANYTOP_OUTPUT_DAMP && /run|course|jump|saut|attack|roar/i.test(String(clip || clipPath || ''))) {
      env.ANYTOP_OUTPUT_DAMP = '0.6';
    }
    let args;
    if (source === 'apovivor') {
      if (!clipPath || !fs.existsSync(clipPath)) {
        return { success: false, error: 'Clip introuvable : ' + clipPath };
      }
      args = [path.join(scriptsDir, 'apovivor_bridge.py'),
              '--rig', meshPath, '--clip', clipPath, '--out', outGlb,
              '--clip-name', slug];
    } else {
      args = [path.join(scriptsDir, 'mesh2motion_bridge.py'),
              '--rig', meshPath, '--out', outGlb,
              '--creature', String(creature || 'spider'), '--clip', String(clip || 'Walk')];
    }

    _sendToAllWindows(BrowserWindow, 'anim:progress',
      { jobId, phase: 'start', pct: 2, msg: `Retargeting « ${clip} »…` });
    const { spawn } = require('child_process');
    return await new Promise((resolve) => {
      let dernieres = '';
      const proc = spawn(py, args, { env, windowsHide: true });
      if (typeof trackProc === 'function') { try { trackProc(jobId, proc); } catch (_) {} }
      const surLigne = (l) => {
        const m = String(l).match(/LOCAL_M2M_PROGRESS:\s*(\d+)/);
        if (m) {
          _sendToAllWindows(BrowserWindow, 'anim:progress',
            { jobId, phase: 'progress', pct: Number(m[1]) });
        }
        dernieres = (dernieres + String(l)).slice(-2000);
      };
      proc.stdout?.on('data', surLigne);
      proc.stderr?.on('data', surLigne);
      proc.on('close', () => {
        if (fs.existsSync(outGlb) && fs.statSync(outGlb).size > 1000) {
          writeMeta(outGlb, {
            kind: 'anim', engine: 'banque_clips', parent: meshPath,
            params: { source, creature, clip, damp: env.ANYTOP_OUTPUT_DAMP || '1.0' },
          });
          _sendToAllWindows(BrowserWindow, 'anim:progress', { jobId, phase: 'done', pct: 100 });
          resolve({ success: true, jobId, glbPath: outGlb });
        } else {
          _sendToAllWindows(BrowserWindow, 'anim:progress',
            { jobId, phase: 'error', pct: 0, msg: dernieres.slice(-300) });
          resolve({ success: false, jobId, error: dernieres.slice(-300) || 'bridge failed' });
        }
      });
      proc.on('error', (e) => resolve({ success: false, jobId, error: String(e.message || e) }));
    });
  });

  ipcMain.handle('anim:judge', async (_e, { glbPath } = {}) => {
    if (!glbPath || !fs.existsSync(glbPath)) {
      return { verdict: 'missing', metrics: {} };
    }
    return _runJudge(glbPath);
  });

  // ---------------------------------------------------------------------------
  // anim:export â€” GLB pass-through, FBX/USD via Blender
  // ---------------------------------------------------------------------------
  ipcMain.handle('anim:export', async (_e, { glbPath, format, dest } = {}) => {
    if (!glbPath || !fs.existsSync(glbPath)) {
      return { success: false, error: 'Source GLB missing' };
    }
    const fmt = (format || 'glb').toLowerCase();
    if (!['glb', 'fbx', 'usd', 'abc'].includes(fmt)) {
      return { success: false, error: `Unsupported format=${fmt}` };
    }
    const target = dest || path.join(
      app.getPath('documents'), 'MyFabmesh', 'exports',
      `${path.basename(glbPath, '.glb')}.${fmt}`);
    _ensureDir(path.dirname(target));
    try {
      const { path: outPath } = await _runExport({ glbPath, format: fmt, dest: target });
      return { success: true, path: outPath };
    } catch (err) {
      return { success: false, error: String(err.message || err) };
    }
  });

  // ---------------------------------------------------------------------------
  // anim:cancel â€” SIGTERM an in-flight job
  // ---------------------------------------------------------------------------
  ipcMain.handle('anim:cancel', async (_e, { jobId } = {}) => {
    const job = _jobs.get(jobId);
    if (!job) return { ok: false, error: 'unknown jobId' };
    try { job.proc.kill('SIGTERM'); } catch (_) {}
    _jobs.delete(jobId);
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // anim:cost-estimate â€” used by the UI cloud cost badge
  // ---------------------------------------------------------------------------
  ipcMain.handle('anim:cost-estimate', async (_e, { count = 1 } = {}) => {
    return {
      perItemUSD: CLOUD_COST_PER_RETARGET_USD,
      totalUSD:   Number((count * CLOUD_COST_PER_RETARGET_USD).toFixed(3)),
    };
  });

  console.log('[animation] IPC handlers registered');
}

module.exports = { register };
