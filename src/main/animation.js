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
const { spawn, execFile } = require('child_process');

// -----------------------------------------------------------------------------
// Paths / configuration
// -----------------------------------------------------------------------------
const BLENDER_EXE = (process.env.BLENDER_EXE
  || 'c:/tools/blender-4.4.3-windows-x64/blender.exe');

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
const CLOUD_RETARGET_URL = process.env.FABMESH_CLOUD_RETARGET_URL || '';

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
    if (!fs.existsSync(BLENDER_EXE)) {
      return reject(new Error(`Blender 4.4.3 not found at ${BLENDER_EXE}`));
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
    const proc = spawn(BLENDER_EXE, args, {
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
// Cloud retarget â€” POST to Modal endpoint, stream multipart, save GLB
// -----------------------------------------------------------------------------
async function _runCloudRetarget({ jobId, meshPath, motion, outGlb, BrowserWindow }) {
  if (!CLOUD_RETARGET_URL) {
    throw new Error('Cloud mode not configured (FABMESH_CLOUD_RETARGET_URL).');
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
    if (!fs.existsSync(convertScript) || !fs.existsSync(BLENDER_EXE)) {
      return reject(new Error(`Cannot convert to ${format}: missing tooling`));
    }
    execFile(BLENDER_EXE, [
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
  const { ipcMain, app, BrowserWindow, MESHES_DIR, isPathAllowed, trackProc } = deps;
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
