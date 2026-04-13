const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
// NOTE: do NOT destructure execFile/spawn here — we monkey-patch them below for
// auto-tracking, and a destructured local would bypass the wrapper. Use the
// child_process module directly via wrappers further down.
const _cp = require('child_process');
// Local references for code below (resolved lazily so they pick up the patch)
const execFile = (...a) => _cp.execFile(...a);
const exec     = (...a) => _cp.exec(...a);
const spawn    = (...a) => _cp.spawn(...a);

// Inherit-by-default: set PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True for
// every Python subprocess we launch. This lets PyTorch's allocator grow segments
// instead of failing on fragmentation, eliminating the false-OOM crashes that
// happened with set_per_process_memory_fraction. Set once at startup so all
// child_process spawns inherit it via process.env.
(function _setPyTorchAllocConf() {
  const cur = process.env.PYTORCH_CUDA_ALLOC_CONF || '';
  if (!cur.includes('expandable_segments')) {
    process.env.PYTORCH_CUDA_ALLOC_CONF = (cur ? cur + ',' : '') + 'expandable_segments:True';
  }
})();

// Catch uncaught errors so the app doesn't show the fatal dialog
process.on('uncaughtException', (err) => {
  console.error('[main.js uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main.js unhandledRejection]', reason);
});

// Safe send: never throws, never crashes the app on subprocess data after window close
// Truncate a filename base to avoid Windows 260-char path limit.
// After many edits (inpaint, clone, upscale, refine), the base name
// accumulates suffixes and can exceed the limit, causing ENOENT errors.
// ========== PARENTAL CONTROL ==========
// When enabled (default), blocks NSFW prompts and keeps safety_checker active.
// Disabled only via a PIN code in Settings → "Unrestricted mode".
// The PIN is stored hashed in config.json. FABMESH_UNRESTRICTED env var is set
// to "1" when unrestricted so Python bridges can disable safety_checker.

const NSFW_KEYWORDS = [
  // Sexual / nudity
  'nude', 'naked', 'nsfw', 'porn', 'porno', 'pornograph', 'sex', 'sexual',
  'erotic', 'hentai', 'xxx', 'lewd', 'topless', 'bottomless', 'lingerie',
  'bikini', 'underwear', 'undress', 'strip', 'stripper', 'orgasm', 'orgasme',
  'fetish', 'bdsm', 'bondage', 'dominat', 'submissi', 'sadis', 'masoch',
  'prostitut', 'escort', 'brothel', 'genital', 'penis', 'vagina', 'breast',
  'nipple', 'buttock', 'anus', 'anal', 'oral sex', 'fellat', 'cunniling',
  'masturbat', 'ejaculat', 'cum shot', 'creampie', 'gangbang', 'threesome',
  'orgy', 'sextoy', 'dildo', 'vibrator', 'lolicon', 'shotacon', 'furry nsfw',
  'rule34', 'rule 34', 'ahegao', 'ecchi', 'yaoi', 'yuri',
  'nu', 'nue', 'nus', 'nues', 'sexe', 'sexuel', 'erotique', 'poitrine', 'seins',
  'bite', 'couille', 'couilles', 'queue', 'chatte', 'nichon', 'nichons',
  'enculer', 'baiser', 'foutre', 'salope', 'pute', 'putain',
  'sodomie', 'fellation', 'cunnilingus', 'orgasme', 'jouir',
  'dick', 'cock', 'pussy', 'ass', 'tits', 'boobs', 'cum', 'slut', 'whore',
  // Violence / gore
  'gore', 'gory', 'blood', 'bloody', 'bleed', 'murder', 'murderer',
  'kill', 'killer', 'killing', 'torture', 'torturer', 'dismember',
  'decapitate', 'decapitation', 'mutilat', 'eviscerat', 'disembowel',
  'cannibal', 'flesh', 'corpse', 'cadaver', 'dead body', 'death scene',
  'execution', 'hanging', 'strangul', 'suffocate', 'drown', 'stab',
  'slash', 'wound', 'injury', 'graphic violence', 'brutal', 'savage',
  'massacre', 'slaughter', 'carnage', 'bloodbath', 'snuff',
  'meurtre', 'tuer', 'mort', 'cadavre', 'sang', 'sanglant', 'torture',
  'massacre', 'violence', 'violent', 'cruaut',
  // Children / minors
  'child abuse', 'pedophil', 'paedophil', 'underage', 'minor',
  'loli', 'shota', 'preteen', 'toddler abuse', 'infant abuse',
  'enfant', 'mineur', 'pedophil',
  // Drugs
  'drug', 'drugs', 'cocaine', 'heroin', 'heroine', 'meth', 'methamphet',
  'crack', 'opium', 'fentanyl', 'overdose', 'inject drug', 'snort',
  'drogue', 'stupefi',
  // Terrorism / extremism
  'terrorist', 'terrorism', 'bomb', 'bombing', 'mass shooting', 'genocide',
  'ethnic cleansing', 'hate crime', 'white supremac', 'nazi', 'swastika',
  'isis', 'al qaeda', 'jihad', 'radicali', 'extremis',
  'attentat', 'terroris',
  // Self-harm / suicide
  'suicide', 'self-harm', 'self harm', 'cut myself', 'slit wrist',
  'hang myself', 'jump off', 'overdose',
  // Hate / discrimination
  'racial slur', 'nigger', 'faggot', 'retard', 'kike', 'spic',
  'chink', 'wetback', 'hate speech',
  // Weapons (contextual)
  'how to make bomb', 'how to make gun', 'weapon tutorial',
  'build explosive', 'poison recipe',
];

function isUnrestrictedMode() {
  return process.env.FABMESH_UNRESTRICTED === '1';
}

// Dangerous combinations: if ANY word from group A AND ANY word from group B
// appear together, the prompt is blocked. This catches circumventions like
// "young child without clothes" that individual keywords miss.
const NSFW_COMBOS = [
  // Children + nudity/sexual
  { a: ['child', 'children', 'kid', 'kids', 'boy', 'girl', 'teen', 'teenager', 'young', 'infant', 'baby', 'toddler', 'minor', 'preteen', 'schoolgirl', 'schoolboy', 'enfant', 'fille', 'garcon', 'jeune', 'ado', 'adolescent', 'gamin', 'gamine', 'bebe'],
    b: ['without clothes', 'no clothes', 'unclothed', 'undressed', 'disrobed', 'bare', 'exposed', 'revealing', 'intimate', 'sensual', 'seductive', 'provocative', 'suggestive', 'sexy', 'hot', 'bath', 'shower', 'bedroom', 'bed', 'lingerie', 'underwear', 'panties', 'bra', 'bikini', 'swimsuit', 'diaper only', 'sans vetement', 'sans habit', 'deshabill', 'nu ', 'nue ', 'nus ', 'nues'] },
  // Anyone + extreme sexual
  { a: ['woman', 'man', 'person', 'girl', 'boy', 'female', 'male', 'lady', 'femme', 'homme'],
    b: ['without clothes', 'no clothes', 'unclothed', 'fully exposed', 'spread legs', 'bent over', 'on knees', 'tied up', 'chained', 'whipped', 'spanked'] },
  // Violence + children
  { a: ['child', 'children', 'kid', 'kids', 'baby', 'infant', 'toddler', 'enfant', 'bebe'],
    b: ['hurt', 'hit', 'beat', 'punch', 'slap', 'abuse', 'attack', 'weapon', 'knife', 'gun', 'shoot', 'bleed', 'cry', 'scream', 'pain', 'suffer', 'frapper', 'battre', 'blesser'] },
];

function _matchesKeyword(text, kw) {
  // Short words (<=4 chars): check with spaces around to avoid false positives
  // e.g. "nu" matches " nu " but not "menu"
  if (kw.length <= 4) {
    const padded = ' ' + text + ' ';
    return padded.includes(' ' + kw + ' ') || padded.includes(' ' + kw + ',') ||
           padded.includes(' ' + kw + '.') || padded.includes(' ' + kw + '!') ||
           padded.includes(' ' + kw + '?') || text.startsWith(kw + ' ') ||
           text.endsWith(' ' + kw);
  }
  return text.includes(kw);
}

function checkPromptSafety(prompt) {
  if (isUnrestrictedMode()) return { safe: true };
  const lower = (prompt || '').toLowerCase();

  // Check individual keywords
  for (const kw of NSFW_KEYWORDS) {
    if (_matchesKeyword(lower, kw)) {
      return { safe: false, blocked: kw, reason: `Content filter: "${kw}" is blocked. Disable parental control in Settings to use unrestricted mode.` };
    }
  }

  // Check dangerous combinations
  for (const combo of NSFW_COMBOS) {
    const hasA = combo.a.some(w => _matchesKeyword(lower, w));
    const hasB = combo.b.some(w => _matchesKeyword(lower, w));
    if (hasA && hasB) {
      const matchA = combo.a.find(w => _matchesKeyword(lower, w));
      const matchB = combo.b.find(w => _matchesKeyword(lower, w));
      return { safe: false, blocked: `${matchA} + ${matchB}`, reason: `Content filter: combination "${matchA}" + "${matchB}" is blocked. This type of content is not allowed.` };
    }
  }

  return { safe: true };
}

// Layer 3: AI text classifier (async, non-blocking)
// michellejieli/NSFW_text_classifier — local, Apache 2.0, ~250 MB, no internet after first download
async function checkPromptSafetyAI(prompt) {
  if (isUnrestrictedMode()) return { safe: true };
  return new Promise((resolve) => {
    execFile('python', ['-c', `
import sys
from transformers import pipeline
clf = pipeline('text-classification', model='michellejieli/NSFW_text_classifier', device='cpu')
r = clf(sys.argv[1])[0]
print(r['label'], r['score'])
`, prompt], { timeout: 30000 }, (error, stdout) => {
      if (error) { resolve({ safe: true }); return; }
      const parts = (stdout || '').trim().split(' ');
      const label = parts[0];
      const score = parseFloat(parts[1]) || 0;
      if (label === 'NSFW' && score > 0.7) {
        resolve({ safe: false, blocked: 'AI classifier', reason: `Content filter: AI detected this prompt as inappropriate (${Math.round(score*100)}% confidence). Disable parental control in Settings for unrestricted mode.` });
      } else {
        resolve({ safe: true });
      }
    });
  });
}

function safeBase(base, maxLen = 80) {
  if (base.length <= maxLen) return base;
  return base.slice(0, maxLen);
}

function safeSend(channel, data) {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    }
  } catch (e) {
    // Window destroyed mid-send - ignore silently
  }
}

const MESHES_DIR = path.join(__dirname, '..', '..', 'meshes');
const SCRIPTS_DIR = path.join(__dirname, '..', '..', 'scripts');
const PREVIEWS_DIR = path.join(__dirname, '..', '..', 'previews');
const IMAGES_DIR = path.join(__dirname, '..', '..', 'images');
const HISTORY_DIR = path.join(__dirname, '..', '..', 'history');
const LOGS_DIR = path.join(__dirname, '..', '..', 'logs');
const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.json');

// Ensure directories exist
[MESHES_DIR, SCRIPTS_DIR, PREVIEWS_DIR, IMAGES_DIR, HISTORY_DIR, LOGS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ============================================================
// LOGGING SYSTEM
// ============================================================
// File: logs/fabmesh.log (10 MB rotation -> .1, .2 archives)
const LOG_FILE = path.join(LOGS_DIR, 'fabmesh.log');
const LOG_MAX_BYTES = 10 * 1024 * 1024;
const LOG_KEEP_ARCHIVES = 3;
let _logStream = null;
function _openLogStream() {
  try {
    // Rotate if too big
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      for (let i = LOG_KEEP_ARCHIVES - 1; i >= 1; i--) {
        const src = LOG_FILE + '.' + i;
        const dst = LOG_FILE + '.' + (i + 1);
        if (fs.existsSync(src)) try { fs.renameSync(src, dst); } catch (e) {}
      }
      try { fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch (e) {}
    }
    _logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  } catch (e) {
    console.error('Could not open log file:', e);
  }
}
_openLogStream();

function logToFile(level, source, msg) {
  const ts = new Date().toISOString();
  const line = `${ts} [${level}] [${source}] ${msg}\n`;
  try { _logStream && _logStream.write(line); } catch (e) {}
  // Also forward to renderer console (devtools) so the user can see it live
  try {
    if (typeof mainWindow !== 'undefined' && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('main-log', { level, source, msg, ts });
    }
  } catch (e) {}
}
// Public log helpers
const log = {
  info:  (src, m) => { console.log(`[${src}]`, m); logToFile('INFO',  src, m); },
  warn:  (src, m) => { console.warn(`[${src}]`, m); logToFile('WARN',  src, m); },
  error: (src, m) => { console.error(`[${src}]`, m); logToFile('ERROR', src, m); },
  debug: (src, m) => { logToFile('DEBUG', src, m); },
};
// Capture uncaught exceptions / unhandled rejections of the main process
process.on('uncaughtException', (e) => {
  log.error('main', 'uncaughtException: ' + (e.stack || e.message || e));
});
process.on('unhandledRejection', (reason) => {
  log.error('main', 'unhandledRejection: ' + (reason && reason.stack || reason));
});
log.info('main', '======================================');
log.info('main', `FabMesh started at ${new Date().toISOString()}`);
log.info('main', `Platform: ${process.platform} ${process.arch}, Node ${process.version}, Electron ${process.versions.electron}`);
log.info('main', `Project root: ${path.join(__dirname, '..', '..')}`);
log.info('main', '======================================');

// --- Version History ---
// Each project gets a folder in history/ with a versions.json tracking all versions
function getProjectDir(projectName) {
  const dir = path.join(HISTORY_DIR, projectName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadVersions(projectName) {
  const vFile = path.join(getProjectDir(projectName), 'versions.json');
  if (fs.existsSync(vFile)) return JSON.parse(fs.readFileSync(vFile, 'utf-8'));
  return { name: projectName, currentVersion: -1, versions: [] };
}

function saveVersions(projectName, data) {
  const vFile = path.join(getProjectDir(projectName), 'versions.json');
  fs.writeFileSync(vFile, JSON.stringify(data, null, 2));
}

function addVersion(projectName, { prompt, scriptContent, meshPath, meshFilename, format }) {
  const data = loadVersions(projectName);
  const versionNum = data.versions.length;

  // Copy mesh to history
  const histMeshName = `v${versionNum}_${meshFilename}`;
  const histMeshPath = path.join(getProjectDir(projectName), histMeshName);
  fs.copyFileSync(meshPath, histMeshPath);

  // Save script to history
  const histScriptName = `v${versionNum}_script.py`;
  const histScriptPath = path.join(getProjectDir(projectName), histScriptName);
  fs.writeFileSync(histScriptPath, scriptContent, 'utf-8');

  data.versions.push({
    version: versionNum,
    prompt,
    scriptFile: histScriptName,
    meshFile: histMeshName,
    meshPath: histMeshPath,
    format,
    timestamp: Date.now()
  });
  data.currentVersion = versionNum;
  saveVersions(projectName, data);
  return data;
}

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  }
  return { blenderPath: '' };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

let mainWindow;

// ========== SDXL PERSISTENT SERVER ==========
// Lazy-spawned Python HTTP server that keeps SDXL models in memory
// to avoid 5-10s reload per img2img/inpaint call
let sdxlProc = null;
let sdxlReady = false;
const SDXL_PORT = 5555;
// Auto-shutdown: kill the SDXL server after this many ms of inactivity to
// free ~13 GB VRAM. Bumped from 60s → 300s because the first /mask_inpaint
// call lazy-loads the SDXL inpainting pipeline (~6 GB, ~90-120s on a cold
// HF cache), and we don't want the idle timer to fire DURING that load.
// The server is also protected by `sdxlInflightRequests > 0`, so this is a
// safety net, not the primary mechanism.
const SDXL_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
let sdxlLastUsedAt = 0;
let sdxlIdleTimer = null;
// Number of in-flight HTTP requests to the SDXL server. The idle shutdown
// NEVER fires while this is > 0, even if the wall-clock since `markSdxlUsed`
// exceeds SDXL_IDLE_TIMEOUT_MS. This prevents the server from being killed
// mid-inference when a slow first-time model load blocks the response.
let sdxlInflightRequests = 0;

function markSdxlUsed() {
  sdxlLastUsedAt = Date.now();
  if (sdxlIdleTimer) clearInterval(sdxlIdleTimer);
  // Check every 15s whether the server is idle and should be killed
  sdxlIdleTimer = setInterval(() => {
    if (!sdxlProc || !sdxlReady) return;
    // Never kill while a request is in flight (could be a first-time
    // model load that legitimately takes > idle timeout).
    if (sdxlInflightRequests > 0) { sdxlLastUsedAt = Date.now(); return; }
    const idleMs = Date.now() - sdxlLastUsedAt;
    if (idleMs >= SDXL_IDLE_TIMEOUT_MS) {
      console.log(`[SDXL] Idle for ${Math.round(idleMs/1000)}s, shutting down to free VRAM`);
      stopSdxlServer();
      clearInterval(sdxlIdleTimer);
      sdxlIdleTimer = null;
    }
  }, 15000);
}

function startSdxlServer() {
  if (sdxlProc) return;
  const serverScript = path.join(__dirname, '..', '..', 'scripts', 'sdxl_server.py');
  if (!fs.existsSync(serverScript)) {
    console.warn('SDXL server script not found, falling back to subprocess mode');
    return;
  }
  console.log('[SDXL] Spawning persistent server...');
  try {
    // Forward the VRAM fraction so the server can enforce the cap via PyTorch
    const sdxlEnv = { ...process.env };
    if (sdxlEnv.FABMESH_VRAM_FRACTION) { /* already set */ }
    else { sdxlEnv.FABMESH_VRAM_FRACTION = '0.95'; }
    sdxlProc = require('child_process').spawn('python', [serverScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: sdxlEnv
    });
    sdxlProc.stdout.on('data', d => {
      const msg = d.toString().trim();
      if (msg) console.log('[SDXL]', msg);
      // Mark ready only when models are actually loaded in VRAM
      if (msg.includes('MODELS READY')) {
        sdxlReady = true;
        markSdxlUsed(); // Start the idle timer from this point
      }
    });
    sdxlProc.stderr.on('data', d => console.error('[SDXL stderr]', d.toString().trim()));
    sdxlProc.on('exit', (code) => {
      console.log('[SDXL] server exited with code', code);
      sdxlProc = null;
      sdxlReady = false;
    });
  } catch (e) {
    console.error('[SDXL] failed to spawn:', e);
    sdxlProc = null;
  }
}

function stopSdxlServer() {
  if (sdxlIdleTimer) { clearInterval(sdxlIdleTimer); sdxlIdleTimer = null; }
  if (!sdxlProc) return;
  const pid = sdxlProc.pid;
  try {
    // Best-effort: send HTTP shutdown (clean)
    const http = require('http');
    const req = http.request({ host: '127.0.0.1', port: SDXL_PORT, path: '/shutdown', method: 'POST', timeout: 500 }, () => {});
    req.on('error', () => {});
    req.end();
  } catch(e) {}
  // Force-kill the process tree immediately — don't rely on timers that won't fire during electron quit
  try {
    if (process.platform === 'win32' && pid) {
      // Synchronously kill the entire process tree (taskkill /T = children too, /F = force)
      require('child_process').execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      sdxlProc.kill('SIGKILL');
    }
  } catch(e) {}
  sdxlProc = null;
  sdxlReady = false;
}

// Helper: HTTP POST to SDXL server, returns { ok, output, error }
function sdxlServerCall(endpoint, payload) {
  return new Promise((resolve) => {
    if (!sdxlReady) {
      resolve({ ok: false, error: 'sdxl_server_not_ready' });
      return;
    }
    // Reset the idle timer every time we use the server
    markSdxlUsed();
    sdxlInflightRequests++;
    const done = (result) => {
      sdxlInflightRequests = Math.max(0, sdxlInflightRequests - 1);
      markSdxlUsed(); // reset idle window after the call returns
      resolve(result);
    };
    const http = require('http');
    const body = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1',
      port: SDXL_PORT,
      path: endpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 1800000
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          done(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        } catch(e) {
          done({ ok: false, error: 'parse_error: ' + e.message });
        }
      });
    });
    req.on('error', (err) => done({ ok: false, error: err.message }));
    req.write(body);
    req.end();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'FabMesh',
    icon: path.join(__dirname, '..', '..', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: '#1a1a2e',
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index2.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.setMenuBarVisibility(false);

  // Intercept close: ask the renderer if there are running jobs.
  // The renderer shows its own styled modal and replies via IPC.
  let closeConfirmed = false;
  mainWindow.on('close', (event) => {
    if (closeConfirmed || _isQuitting) return; // already confirmed or quitting via app.quit
    event.preventDefault();
    mainWindow.webContents.send('app-close-requested');
  });
  ipcMain.on('app-close-confirmed', () => {
    closeConfirmed = true;
    mainWindow.close();
  });

  // Open DevTools in dev mode
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  // Allow F12 / Ctrl+Shift+I to toggle DevTools
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // ----------------------------------------------------------
  // Start local Test/Control HTTP API (localhost:7331).
  // Enabled only when FABMESH_TEST_API=1 or when --dev is set.
  // This lets external processes pilot the app: click buttons,
  // grab screenshots, tail logs, trigger generations.
  // ----------------------------------------------------------
  try {
    const { startTestApi } = require('./test_api');
    startTestApi(mainWindow);
  } catch (e) {
    try { log.error('test_api', 'failed to start: ' + e.message); }
    catch (_) { console.error('[test_api] failed to start:', e); }
  }
}

// ========== MCP BRIDGE HTTP SERVER ==========
// Allows the MCP server (scripts/mcp_server.py) to dispatch generation
// commands through Electron so jobs appear in the UI and VRAM is gated.
const MCP_BRIDGE_PORT = 7555;

function startMcpBridge() {
  const http = require('http');
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405); res.end('POST only'); return;
    }
    // Read JSON body
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        const action = req.url.replace(/^\//, '').replace(/\?.*/, '');
        log.info('mcp-bridge', `action=${action} params=${JSON.stringify(body).slice(0, 200)}`);

        let result;
        // Route to the same handlers the renderer uses via ipcMain.handle
        if (action === 'generate-images') {
          result = await handleGenerateImages(body);
        } else if (action === 'image-to-3d') {
          result = await handleImageTo3D(body);
        } else if (action === 'auto-rig-ai') {
          result = await handleAutoRigAI(body);
        } else if (action === 'list-projects') {
          result = await handleListProjects();
        } else if (action === 'remove-background') {
          result = await handleRemoveBackground(body);
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ success: false, error: `Unknown action: ${action}` }));
          return;
        }

        // Tell the renderer to refresh so the new assets appear in the UI
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('mcp-refresh', { action, result: !!result?.success });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        log.error('mcp-bridge', `error: ${e.message}`);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
  });
  server.listen(MCP_BRIDGE_PORT, '127.0.0.1', () => {
    log.info('mcp-bridge', `listening on http://127.0.0.1:${MCP_BRIDGE_PORT}`);
  });
  server.on('error', (e) => {
    log.error('mcp-bridge', `failed to start: ${e.message}`);
  });
}

// Wrapped handler functions that can be called from both IPC and HTTP bridge.
// These extract the logic from ipcMain.handle callbacks so they can be reused.
// For now they delegate to the IPC handlers by simulating the event object.

async function handleGenerateImages(params) {
  // Reuse the IPC handler by invoking it directly
  const fakeEvent = { sender: mainWindow?.webContents };
  return new Promise((resolve) => {
    // The IPC handler is registered as ipcMain.handle('generate-images', handler).
    // We can't call it directly, so we use the same code path via a local HTTP
    // call to the existing test_api or by extracting the handler. For simplicity,
    // we invoke the Python bridge directly here but send progress to the renderer.
    const safeName = (params.projectName || 'mcp_gen').replace(/[^a-zA-Z0-9_-]/g, '_');
    const imagesDir = path.join(IMAGES_DIR, safeName);
    fs.mkdirSync(imagesDir, { recursive: true });

    // Save prompt
    const promptsFile = path.join(imagesDir, 'prompts.json');
    let history = [];
    try { if (fs.existsSync(promptsFile)) history = JSON.parse(fs.readFileSync(promptsFile, 'utf-8')); } catch(e) {}
    history.push({ prompt: params.userPrompt || params.prompt, timestamp: Date.now() });
    try { fs.writeFileSync(promptsFile, JSON.stringify(history, null, 2)); } catch(e) {}
    try { fs.writeFileSync(path.join(imagesDir, 'prompt.txt'), params.userPrompt || params.prompt, 'utf-8'); } catch(e) {}

    // Notify renderer that a job is starting
    safeSend('mcp-job-start', { type: 'image', name: `MCP: Generate images (${safeName})`, params });

    const bridgeScript = path.join(__dirname, '..', '..', 'scripts', 'local_juggernaut_bridge.py');
    const count = String(params.numImages || params.count || 1);
    const steps = String(params.steps || 30);
    const proc = execFile('python', [bridgeScript, params.prompt, imagesDir, count, steps], {
      timeout: 1800000, maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, PYTHONUNBUFFERED: '1', FABMESH_VRAM_FRACTION: process.env.FABMESH_VRAM_FRACTION || '0.95' },
    }, (error, stdout, stderr) => {
      if (error) {
        safeSend('mcp-job-end', { type: 'image', success: false, error: error.message });
        resolve({ success: false, error: error.message });
        return;
      }
      const imgs = fs.readdirSync(imagesDir).filter(f => /\.png$/i.test(f) && !f.startsWith('.')).map(f => path.join(imagesDir, f));
      safeSend('mcp-job-end', { type: 'image', success: true, count: imgs.length });
      resolve({ success: true, images: imgs, count: imgs.length, project: safeName });
    });
    proc.stdout?.on('data', d => safeSend('ai3d-progress', d.toString()));
    proc.stderr?.on('data', d => safeSend('ai3d-progress', '[stderr] ' + d.toString()));
  });
}

async function handleImageTo3D(params) {
  const safeName = (params.outputName || 'mcp_mesh').replace(/[^a-zA-Z0-9_-]/g, '_');
  const timestamp = Date.now();
  const meshFilename = `${safeName}_sf3d_${timestamp}.glb`;
  const meshPath = path.join(MESHES_DIR, meshFilename);
  const imagePath = params.imagePath;

  if (!imagePath || !fs.existsSync(imagePath)) {
    return { success: false, error: `Image not found: ${imagePath}` };
  }

  safeSend('mcp-job-start', { type: 'mesh', name: `MCP: Generate 3D (${safeName})`, params });

  const bridgeScript = path.join(__dirname, '..', '..', 'scripts', 'local_sf3d_bridge.py');
  const texRes = String(params.textureSize || 1024);
  const verts = String(params.targetFaces || -1);
  const remesh = (params.targetFaces && params.targetFaces > 0) ? 'triangle' : 'none';
  const subdiv = String(params.subdivide || 0);

  return new Promise((resolve) => {
    const proc = execFile('python', [bridgeScript, imagePath, meshPath, texRes, verts, remesh, subdiv], {
      timeout: 1800000, maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, PYTHONUNBUFFERED: '1', FABMESH_VRAM_FRACTION: process.env.FABMESH_VRAM_FRACTION || '0.95' },
    }, (error, stdout, stderr) => {
      if (error) {
        safeSend('mcp-job-end', { type: 'mesh', success: false, error: error.message });
        resolve({ success: false, error: error.message });
        return;
      }
      if (!fs.existsSync(meshPath)) {
        safeSend('mcp-job-end', { type: 'mesh', success: false, error: 'GLB not created' });
        resolve({ success: false, error: 'GLB not created' });
        return;
      }
      try { fs.writeFileSync(meshPath + '.source', imagePath, 'utf-8'); } catch(e) {}
      const stats = fs.statSync(meshPath);
      let meshVerts = null, meshFaces = null;
      const m = (stdout || '').match(/STATS:\s*verts=(\d+)\s*faces=(\d+)/);
      if (m) { meshVerts = parseInt(m[1]); meshFaces = parseInt(m[2]); }
      safeSend('mcp-job-end', { type: 'mesh', success: true, meshPath, meshVerts, meshFaces });
      resolve({ success: true, meshPath, meshFilename, size: stats.size, meshVerts, meshFaces });
    });
    proc.stdout?.on('data', d => safeSend('ai3d-progress', d.toString()));
    proc.stderr?.on('data', d => safeSend('ai3d-progress', '[stderr] ' + d.toString()));
  });
}

async function handleAutoRigAI(params) {
  const meshPath = params.meshPath;
  if (!meshPath || !fs.existsSync(meshPath)) {
    return { success: false, error: `Mesh not found: ${meshPath}` };
  }

  safeSend('mcp-job-start', { type: 'rig', name: `MCP: Auto-rig (${path.basename(meshPath)})`, params });

  const scriptsDir = path.join(__dirname, '..', '..', 'scripts');
  const baseName = path.basename(meshPath, path.extname(meshPath)).replace(/[^a-zA-Z0-9_-]/g, '_');
  const rigTs = Date.now();
  const tempUnirigGlb = path.join(MESHES_DIR, `${baseName}_unirig_temp_${rigTs}.glb`);
  const tempSwapGlb = path.join(MESHES_DIR, `${baseName}_swap_temp_${rigTs}.glb`);
  const outputGlb = path.join(MESHES_DIR, `${baseName}_rigged_unirig_${rigTs}.glb`);

  const runStep = (label, args) => new Promise((resolve) => {
    safeSend('ai3d-progress', `[MCP-${label}] Starting...`);
    const proc = execFile('python', args, { timeout: 600000, maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr });
    });
    proc.stdout?.on('data', d => safeSend('ai3d-progress', `[MCP-${label}] ${d.toString()}`));
    proc.stderr?.on('data', d => safeSend('ai3d-progress', `[MCP-${label}][stderr] ${d.toString()}`));
  });

  // Step 1: UniRig
  const step1 = await runStep('UniRig', [path.join(scriptsDir, 'unirig_bridge.py'), meshPath, tempUnirigGlb]);
  if (step1.error || !fs.existsSync(tempUnirigGlb)) {
    safeSend('mcp-job-end', { type: 'rig', success: false, error: 'UniRig failed' });
    return { success: false, error: 'UniRig failed: ' + (step1.error?.message || step1.stderr?.slice(-300)) };
  }

  // Step 2: Swap skeleton
  const orcBones = path.join(scriptsDir, 'rig_templates', 'skm', 'orc_m1.bones.json');
  const step2 = await runStep('SwapSkeleton', [path.join(scriptsDir, 'swap_skeleton.py'), tempUnirigGlb, orcBones, tempSwapGlb]);
  try { fs.unlinkSync(tempUnirigGlb); } catch(e) {}
  if (step2.error || !fs.existsSync(tempSwapGlb)) {
    safeSend('mcp-job-end', { type: 'rig', success: false, error: 'Skeleton swap failed' });
    return { success: false, error: 'Skeleton swap failed' };
  }

  // Step 3: Bake anims
  const bakeScript = path.join(scriptsDir, 'bake_procedural_anims.py');
  if (fs.existsSync(bakeScript)) {
    const step3 = await runStep('BakeAnims', [bakeScript, tempSwapGlb, orcBones, outputGlb]);
    if (step3.error || !fs.existsSync(outputGlb)) {
      try { fs.copyFileSync(tempSwapGlb, outputGlb); } catch(e) {}
    }
  } else {
    try { fs.copyFileSync(tempSwapGlb, outputGlb); } catch(e) {}
  }
  try { if (fs.existsSync(tempSwapGlb)) fs.unlinkSync(tempSwapGlb); } catch(e) {}

  if (!fs.existsSync(outputGlb)) {
    safeSend('mcp-job-end', { type: 'rig', success: false, error: 'No output' });
    return { success: false, error: 'Rigged GLB not created' };
  }
  const stats = fs.statSync(outputGlb);
  safeSend('mcp-job-end', { type: 'rig', success: true, path: outputGlb });
  return { success: true, path: outputGlb, filename: path.basename(outputGlb), size: stats.size };
}

async function handleListProjects() {
  const projects = [];
  if (fs.existsSync(IMAGES_DIR)) {
    for (const name of fs.readdirSync(IMAGES_DIR)) {
      const d = path.join(IMAGES_DIR, name);
      if (!fs.statSync(d).isDirectory()) continue;
      const imgs = fs.readdirSync(d).filter(f => /\.png$/i.test(f) && !f.startsWith('.')).length;
      const meshes = fs.existsSync(MESHES_DIR) ? fs.readdirSync(MESHES_DIR).filter(f => f.startsWith(name) && f.endsWith('.glb')).length : 0;
      projects.push({ name, images: imgs, meshes });
    }
  }
  return { success: true, projects };
}

async function handleRemoveBackground(params) {
  const imagePath = params.imagePath;
  if (!imagePath || !fs.existsSync(imagePath)) return { success: false, error: 'Image not found' };
  const dir = path.dirname(imagePath);
  const ext = path.extname(imagePath);
  const base = safeBase(path.basename(imagePath, ext));
  const outPath = path.join(dir, `${base}_nobg_${Date.now()}${ext}`);
  const script = path.join(__dirname, '..', '..', 'scripts', 'remove_bg.py');
  // Fallback: use rembg directly
  return new Promise((resolve) => {
    execFile('python', ['-c', `
import rembg, sys
from PIL import Image
img = Image.open(r"${imagePath}")
out = rembg.remove(img)
out.save(r"${outPath}")
print("OK")
`], { timeout: 120000 }, (error, stdout, stderr) => {
      if (error || !fs.existsSync(outPath)) {
        resolve({ success: false, error: error?.message || 'rembg failed' });
      } else {
        resolve({ success: true, newPath: outPath });
      }
    });
  });
}

// --headless flag: run without a visible window, only the MCP bridge HTTP
// server on port 7555. Used by Claude Desktop / Claude Code to dispatch
// batch generation jobs in the background. The user doesn't see FabMesh
// at all — Claude handles the UX and presents results when done.
const HEADLESS = process.argv.includes('--headless');

app.whenReady().then(() => {
  if (HEADLESS) {
    log.info('main', 'Starting in HEADLESS mode (no UI window, MCP bridge only)');
    // In headless mode we still need mainWindow for IPC handlers that
    // reference it, but we never show it. Create a hidden window.
    mainWindow = new BrowserWindow({
      width: 800, height: 600, show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true, nodeIntegration: false,
      },
    });
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index2.html'));
  } else {
    createWindow();
  }

  // MCP Bridge HTTP server — always started (headless or not) so Claude
  // can dispatch commands whether FabMesh is visible or hidden.
  startMcpBridge();

  if (HEADLESS) {
    log.info('main', `Headless mode ready. MCP bridge on http://127.0.0.1:${MCP_BRIDGE_PORT}`);
    log.info('main', 'Waiting for commands... (Ctrl+C to stop)');
  }
});

// Ensure the SDXL server is running. Returns a promise that resolves when the
// server reports "MODELS READY" (or after a short timeout fallback).
function ensureSdxlServer() {
  return new Promise((resolve) => {
    if (sdxlReady) return resolve(true);
    if (!sdxlProc) {
      startSdxlServer();
    }
    if (!sdxlProc) return resolve(false);
    // Poll sdxlReady for up to 120s
    const start = Date.now();
    const poll = setInterval(() => {
      if (sdxlReady) {
        clearInterval(poll);
        resolve(true);
      } else if (Date.now() - start > 120000 || !sdxlProc) {
        clearInterval(poll);
        resolve(sdxlReady);
      }
    }, 500);
  });
}
// Kill all tracked Python subprocesses (cancel-job map) on exit
function killAllActiveProcs() {
  for (const [jobId, proc] of activeProcs.entries()) {
    try {
      if (process.platform === 'win32') {
        execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], () => {});
      } else {
        proc.kill('SIGKILL');
      }
    } catch (e) {}
  }
  activeProcs.clear();
}

let _isQuitting = false;
function fullCleanup() {
  if (_isQuitting) return;
  _isQuitting = true;
  killAllActiveProcs();
  stopSdxlServer();
  try { execFile('wsl', ['--shutdown'], { timeout: 10000 }, () => {}); } catch(e) {}
}

app.on('window-all-closed', () => {
  fullCleanup();
  app.quit();
});
app.on('before-quit', () => {
  fullCleanup();
});
app.on('will-quit', () => {
  fullCleanup();
});

// Show file in explorer
// Image history: backup current image before modifying
function backupImage(imagePath) {
  const dir = path.dirname(imagePath);
  const base = safeBase(path.basename(imagePath, path.extname(imagePath)));
  const ext = path.extname(imagePath);
  const histDir = path.join(dir, '.history');
  if (!fs.existsSync(histDir)) fs.mkdirSync(histDir);
  const timestamp = Date.now();
  const backupPath = path.join(histDir, `${base}_${timestamp}${ext}`);
  fs.copyFileSync(imagePath, backupPath);
  return backupPath;
}

ipcMain.handle('list-image-versions', (event, imagePath) => {
  const dir = path.dirname(imagePath);
  const base = safeBase(path.basename(imagePath, path.extname(imagePath)));
  const histDir = path.join(dir, '.history');
  if (!fs.existsSync(histDir)) return [];
  return fs.readdirSync(histDir)
    .filter(f => f.startsWith(base + '_'))
    .map(f => {
      const fullPath = path.join(histDir, f);
      return {
        path: fullPath,
        filename: f,
        created: fs.statSync(fullPath).birthtime,
        size: fs.statSync(fullPath).size
      };
    })
    .sort((a, b) => new Date(b.created) - new Date(a.created));
});

ipcMain.handle('revert-image', (event, { imagePath, versionPath }) => {
  // Save current as new version, restore the version
  backupImage(imagePath);
  fs.copyFileSync(versionPath, imagePath);
  return true;
});

// Upload image to a temporary public host (catbox.moe - free, anonymous)
async function uploadToCatbox(imagePath) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const imgBuffer = fs.readFileSync(imagePath);
    const boundary = '----FabMesh' + Date.now();
    const filename = path.basename(imagePath);

    let body = '';
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="reqtype"\r\n\r\nfileupload\r\n`;
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="fileToUpload"; filename="${filename}"\r\n`;
    body += `Content-Type: image/png\r\n\r\n`;

    const head = Buffer.from(body, 'utf-8');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
    const fullBody = Buffer.concat([head, imgBuffer, tail]);

    const req = https.request({
      hostname: 'catbox.moe',
      path: '/user/api.php',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': fullBody.length,
        'User-Agent': 'FabMesh/1.0'
      },
      timeout: 60000
    }, (resp) => {
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => {
        const url = Buffer.concat(chunks).toString('utf-8').trim();
        if (url.startsWith('https://')) resolve(url);
        else reject(new Error('Upload failed: ' + url));
      });
    });
    req.on('error', reject);
    req.write(fullBody);
    req.end();
  });
}

// Track active Python processes for cancellation
const activeProcs = new Map(); // jobId -> proc
// Track ALL spawned subprocesses (not just those with a jobId), so cancel-job
// can kill any orphan even when the calling handler did not pass a jobId.
const allActiveProcs = new Set();
function trackProc(proc) {
  if (!proc) return proc;
  allActiveProcs.add(proc);
  proc.on('exit', () => allActiveProcs.delete(proc));
  return proc;
}

// Monkey-patch child_process.execFile and child_process.spawn ONCE so every
// subprocess we launch is auto-tracked. Without this, cancel-job can only
// kill image-to-3d (the only handler that explicitly tracked its proc), and
// every other Python child becomes a VRAM-hogging orphan when cancelled.
(function _autoTrackChildProcesses() {
  const cp = require('child_process');
  if (cp.__fabmeshTracked) return;
  cp.__fabmeshTracked = true;
  const _execFile = cp.execFile;
  const _spawn = cp.spawn;
  cp.execFile = function (...args) { return trackProc(_execFile.apply(this, args)); };
  cp.spawn = function (...args) { return trackProc(_spawn.apply(this, args)); };
})();

// Stop the SDXL server to free VRAM (called when a mesh/rig job is queued
// and the SDXL server is hogging VRAM that the queued job needs).
// Parental control: set/verify PIN + toggle unrestricted mode
ipcMain.handle('set-parental-pin', (_event, { pin }) => {
  if (!pin || pin.length < 4) return { success: false, error: 'PIN must be at least 4 digits' };
  const config = loadConfig();
  // Simple hash (not crypto-secure, but enough for parental control)
  const hash = require('crypto').createHash('sha256').update(pin).digest('hex');
  config.parentalPinHash = hash;
  saveConfig(config);
  return { success: true };
});

ipcMain.handle('verify-parental-pin', (_event, { pin }) => {
  const config = loadConfig();
  if (!config.parentalPinHash) return { success: false, error: 'No PIN set. Set one first.' };
  const hash = require('crypto').createHash('sha256').update(pin || '').digest('hex');
  if (hash !== config.parentalPinHash) return { success: false, error: 'Wrong PIN' };
  return { success: true };
});

ipcMain.handle('toggle-unrestricted', (_event, { pin, enable }) => {
  const config = loadConfig();

  if (!enable) {
    // LOCK: no PIN needed — anyone can re-enable parental control
    delete process.env.FABMESH_UNRESTRICTED;
    try { stopSdxlServer(); } catch(_) {}
    return { success: true, unrestricted: false };
  }

  // UNLOCK: requires PIN
  if (!config.parentalPinHash) {
    // First time: set PIN
    if (!pin || pin.length < 4) return { success: false, error: 'Set a 4+ digit PIN first' };
    const hash = require('crypto').createHash('sha256').update(pin).digest('hex');
    config.parentalPinHash = hash;
    saveConfig(config);
  } else {
    // Verify PIN
    const hash = require('crypto').createHash('sha256').update(pin || '').digest('hex');
    if (hash !== config.parentalPinHash) return { success: false, error: 'Wrong PIN' };
  }
  process.env.FABMESH_UNRESTRICTED = '1';
  try { stopSdxlServer(); } catch(_) {}
  return { success: true, unrestricted: true };
});

// Instant NSFW check: look for .nsfw tag files in a project's image folder.
// Returns true if ANY image in the folder has a .nsfw sidecar file.
// This is O(1) per project (just readdir + filter), no Python, no AI model.
ipcMain.handle('check-project-nsfw', (_event, { folderPath }) => {
  if (isUnrestrictedMode()) return { nsfw: false };
  if (!folderPath || !fs.existsSync(folderPath)) return { nsfw: false };
  try {
    const files = fs.readdirSync(folderPath);
    const hasNsfwTag = files.some(f => f.endsWith('.nsfw'));
    return { nsfw: hasNsfwTag };
  } catch (_) { return { nsfw: false }; }
});

// Return which images in a list have .nsfw tag files (instant, no AI)
ipcMain.handle('check-images-nsfw-tags', (_event, { images }) => {
  if (isUnrestrictedMode()) return {};
  const results = {};
  for (const imgPath of (images || [])) {
    results[imgPath] = fs.existsSync(imgPath + '.nsfw');
  }
  return results;
});

ipcMain.handle('get-nsfw-keywords', () => {
  return NSFW_KEYWORDS;
});

// Scan an image file for NSFW content using Falconsai/nsfw_image_detection (ViT).
// Falls back to skin-ratio heuristic if the model isn't available.
// Returns { nsfw: true/false, score: 0.XX }
ipcMain.handle('check-image-nsfw', async (_event, { imagePath }) => {
  if (isUnrestrictedMode()) return { nsfw: false, score: 0 };
  if (!imagePath || !fs.existsSync(imagePath)) return { nsfw: false, score: 0 };
  return new Promise((resolve) => {
    execFile('python', ['-c', `
import sys, json
try:
    from transformers import pipeline
    from PIL import Image
    clf = pipeline('image-classification', model='Falconsai/nsfw_image_detection', device='cpu')
    r = clf(Image.open(r"${imagePath}"))
    nsfw_score = next((x['score'] for x in r if x['label'] == 'nsfw'), 0)
    print(json.dumps({"nsfw": nsfw_score > 0.5, "score": round(nsfw_score, 3)}))
except Exception as e:
    # Fallback: skin ratio heuristic
    import numpy as np
    from PIL import Image
    img = Image.open(r"${imagePath}").convert('RGB').resize((256,256))
    arr = np.array(img).astype(float)
    r,g,b = arr[:,:,0], arr[:,:,1], arr[:,:,2]
    skin = ((r>95)&(g>40)&(b>20)&(r>g)&(r>b)&((r-g)>15)&(arr.max(2)-arr.min(2)>15))
    ratio = float(skin.sum()) / (256*256)
    print(json.dumps({"nsfw": ratio > 0.35, "score": round(ratio, 3)}))
`], { timeout: 30000 }, (error, stdout) => {
      if (error) { resolve({ nsfw: false, score: 0 }); return; }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (_) {
        resolve({ nsfw: false, score: 0 });
      }
    });
  });
});

// Batch scan multiple images for NSFW in one Python process (loads model once).
// Paths are passed via a temp file to avoid Windows backslash escaping issues.
ipcMain.handle('batch-check-nsfw', async (_event, { images }) => {
  if (isUnrestrictedMode()) return {};
  if (!images || images.length === 0) return {};
  const imgList = images.filter(p => fs.existsSync(p));
  if (imgList.length === 0) return {};

  // Write paths to a temp file (use forward slashes to avoid JSON escape issues)
  const tmpFile = path.join(LOGS_DIR, '_nsfw_scan_paths.json');
  const outFile = path.join(LOGS_DIR, '_nsfw_scan_results.json');
  fs.writeFileSync(tmpFile, JSON.stringify(imgList), 'utf-8');
  const scanScript = path.join(__dirname, '..', '..', 'scripts', 'nsfw_scan.py');

  return new Promise((resolve) => {
    execFile('python', [scanScript, tmpFile, outFile], { timeout: 120000, maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
      try { fs.unlinkSync(tmpFile); } catch(_) {}
      if (error) { log.error('main', `NSFW scan failed: ${stderr?.slice(-200) || error.message}`); resolve({}); return; }
      if (!fs.existsSync(outFile)) { resolve({}); return; }
      try {
        const results = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
        try { fs.unlinkSync(outFile); } catch(_) {}
        log.info('main', `NSFW scan: ${Object.keys(results).length} images scanned, ${Object.values(results).filter(v=>v).length} NSFW`);
        resolve(results);
      } catch (_) { resolve({}); }
    });
  });
});

ipcMain.handle('get-parental-status', () => {
  const config = loadConfig();
  return {
    hasPin: !!config.parentalPinHash,
    unrestricted: process.env.FABMESH_UNRESTRICTED === '1',
  };
});

ipcMain.handle('stop-sdxl-server', () => {
  log.info('main', 'stop-sdxl-server: stopping SDXL server to free VRAM for queued job');
  try { stopSdxlServer(); } catch (e) {}
  return { success: true };
});

ipcMain.handle('cancel-job', (event, jobId) => {
  log.info('main', `cancel-job: jobId=${jobId}, killing ${allActiveProcs.size} tracked procs + orphans`);
  // Kill the specific tracked proc if any
  const proc = activeProcs.get(jobId);
  if (proc) {
    killProcTree(proc);
    activeProcs.delete(jobId);
  }
  // Snapshot procs before iterating (the proc.on('exit') handler removes
  // entries from allActiveProcs, which would mutate the set during iteration).
  // We snapshot {pid, ref} pairs so we can compare and skip the SDXL server.
  const sdxlPid = sdxlProc ? sdxlProc.pid : -1;
  const snapshot = Array.from(allActiveProcs);
  for (const p of snapshot) {
    if (!p || p.pid === sdxlPid) continue;
    try { killProcTree(p); } catch (e) { /* already dead */ }
    allActiveProcs.delete(p);
  }
  // Last resort: WMIC scan for any orphan python child of the main process
  killOrphanPythonSubprocesses();
  return true;
});

function killProcTree(proc) {
  try {
    if (process.platform === 'win32' && proc.pid) {
      // Synchronous taskkill so the kill is done before we return
      require('child_process').execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      proc.kill('SIGKILL');
    }
  } catch (e) {
    log.warn('main', 'killProcTree failed: ' + e.message);
  }
}

// Kill every python.exe except the SDXL persistent server, SYNCHRONOUSLY.
// This is brutal but reliable when a job won't stop responding to soft signals.
function killOrphanPythonSubprocesses() {
  if (process.platform !== 'win32') return;
  const sdxlPid = sdxlProc ? sdxlProc.pid : -1;
  try {
    // List all python.exe pids via tasklist (faster than wmic)
    const out = require('child_process').execFileSync(
      'tasklist', ['/FI', 'IMAGENAME eq python.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf-8' }
    );
    const pids = [];
    out.split(/\r?\n/).forEach(line => {
      const m = line.match(/^"python\.exe","(\d+)"/);
      if (m) pids.push(parseInt(m[1]));
    });
    log.info('main', `killOrphanPython: found ${pids.length} python.exe (sdxl pid=${sdxlPid})`);
    for (const pid of pids) {
      if (pid === sdxlPid) continue;
      try {
        require('child_process').execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        log.info('main', `Killed orphan python pid=${pid}`);
      } catch (e) {
        log.warn('main', `Could not kill pid=${pid}: ` + e.message);
      }
    }
  } catch (e) {
    log.error('main', 'killOrphanPythonSubprocesses failed: ' + e.message);
  }
}

// IPC: count python.exe subprocesses currently running (excluding the SDXL server)
ipcMain.handle('count-python', () => {
  if (process.platform !== 'win32') return { count: 0, sdxl: false };
  const sdxlPid = sdxlProc ? sdxlProc.pid : -1;
  try {
    const out = require('child_process').execFileSync(
      'tasklist', ['/FI', 'IMAGENAME eq python.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf-8' }
    );
    const pids = [];
    out.split(/\r?\n/).forEach(line => {
      const m = line.match(/^"python\.exe","(\d+)"/);
      if (m) pids.push(parseInt(m[1]));
    });
    const others = pids.filter(p => p !== sdxlPid);
    return { count: others.length, sdxl: pids.includes(sdxlPid), total: pids.length };
  } catch (e) {
    return { count: 0, sdxl: false, error: e.message };
  }
});

// IPC: open the logs folder in the OS file explorer
ipcMain.handle('open-logs-folder', () => {
  try {
    shell.openPath(LOGS_DIR);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// IPC: read the last N lines of the log file (for an in-app log viewer later)
// Renderer -> file log passthrough for debug instrumentation
ipcMain.handle('renderer-log', (event, { tag, msg } = {}) => {
  try { logToFile('INFO', 'renderer:' + (tag || 'dbg'), String(msg || '')); } catch (e) {}
  return true;
});
ipcMain.handle('read-log-tail', (event, { lines = 200 } = {}) => {
  try {
    if (!fs.existsSync(LOG_FILE)) return { success: true, lines: [] };
    const content = fs.readFileSync(LOG_FILE, 'utf-8');
    const all = content.split(/\r?\n/);
    return { success: true, lines: all.slice(-lines) };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Save a PNG dataUrl as a new versioned image next to basePath
ipcMain.handle('save-image-data-url', (event, { basePath, dataUrl, suffix }) => {
  try {
    if (!basePath || !dataUrl) return { success: false, error: 'Missing args' };
    if (!isPathAllowed(basePath)) return { success: false, error: 'Path not allowed' };
    const dir = path.dirname(basePath);
    const ext = '.png';
    const base = path.basename(basePath, path.extname(basePath));
    const ts = Date.now();
    const outPath = path.join(dir, `${base}_${suffix || 'edit'}_${ts}${ext}`);
    const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
    return { success: true, path: outPath, filename: path.basename(outPath) };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Image adjustments (auto_levels, auto_contrast)
ipcMain.handle('image-adjust', async (event, { imagePath, operation }) => {
  try {
    if (!imagePath || !fs.existsSync(imagePath)) {
      return { success: false, error: 'Image not found' };
    }
    if (!isPathAllowed(imagePath)) {
      return { success: false, error: 'Path not allowed' };
    }
    const validOps = ['auto_levels', 'auto_contrast'];
    if (!validOps.includes(operation)) {
      return { success: false, error: 'Invalid operation' };
    }

    const dir = path.dirname(imagePath);
    const ext = path.extname(imagePath);
    const base = safeBase(path.basename(imagePath, ext));
    const ts = Date.now();
    const newImagePath = path.join(dir, `${base}_${operation}_${ts}${ext}`);

    const script = path.join(__dirname, '..', '..', 'scripts', 'image_adjust_bridge.py');

    return await new Promise((resolve) => {
      const proc = execFile('python', [script, operation, imagePath, newImagePath], {
        timeout: 60000,
        maxBuffer: 50 * 1024 * 1024
      }, (error, stdout, stderr) => {
        if (error) {
          resolve({ success: false, error: error.message, stderr });
        } else if (fs.existsSync(newImagePath)) {
          resolve({ success: true, newPath: newImagePath });
        } else {
          resolve({ success: false, error: 'Output not created', stdout, stderr });
        }
      });
      proc.stderr?.on('data', d => safeSend('ai3d-progress', '[stderr] ' + d.toString()));
      proc.on('error', e => resolve({ success: false, error: e.message }));
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Analyze a SKM template's skeleton: returns the bones JSON (cached)
ipcMain.handle('analyze-skeleton', async (event, { templateId }) => {
  try {
    if (!templateId) return { success: false, error: 'no templateId' };
    // Find the template FBX path from registry
    const registryPath = path.join(__dirname, '..', '..', 'scripts', 'rig_templates', 'skm', 'registry.json');
    if (!fs.existsSync(registryPath)) return { success: false, error: 'registry missing' };
    const reg = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    const tpl = (reg.skm_templates || []).find(t => t.id === templateId);
    if (!tpl) return { success: false, error: 'template not in registry' };
    const fbxPath = path.join(__dirname, '..', '..', 'scripts', 'rig_templates', tpl.fbx);
    if (!fs.existsSync(fbxPath)) return { success: false, error: 'fbx missing' };

    // Cache: <fbx>.bones.json next to the FBX
    const cachePath = fbxPath + '.bones.json';
    // If cache exists and is newer than the FBX, use it
    if (fs.existsSync(cachePath)) {
      try {
        const cs = fs.statSync(cachePath);
        const fs2 = fs.statSync(fbxPath);
        if (cs.mtimeMs >= fs2.mtimeMs) {
          const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
          return { success: true, data, cached: true };
        }
      } catch(e) {}
    }

    // Run blender to extract bones
    const config = loadConfig();
    if (!config.blenderPath) return { success: false, error: 'Blender path not configured' };
    const script = path.join(__dirname, '..', '..', 'scripts', 'analyze_skeleton.py');

    return await new Promise((resolve) => {
      const proc = execFile('python', [script, fbxPath, cachePath, config.blenderPath], {
        timeout: 120000,
        maxBuffer: 50 * 1024 * 1024
      }, (error, stdout, stderr) => {
        if (error) {
          resolve({ success: false, error: error.message, stderr });
          return;
        }
        if (!fs.existsSync(cachePath)) {
          resolve({ success: false, error: 'output not created' });
          return;
        }
        try {
          const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
          resolve({ success: true, data, cached: false });
        } catch (e) {
          resolve({ success: false, error: 'parse failed: ' + e.message });
        }
      });
      proc.stderr?.on('data', d => safeSend('ai3d-progress', '[stderr] ' + d.toString()));
      proc.on('error', e => resolve({ success: false, error: e.message }));
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Save / load rig landmarks (per-mesh JSON file)
ipcMain.handle('save-landmarks', (event, { meshPath, landmarks }) => {
  try {
    if (!meshPath || !isPathAllowed(meshPath)) return { success: false };
    const lmPath = meshPath + '.landmarks.json';
    if (!landmarks || Object.keys(landmarks).length === 0) {
      // Empty -> delete
      if (fs.existsSync(lmPath)) fs.unlinkSync(lmPath);
    } else {
      fs.writeFileSync(lmPath, JSON.stringify(landmarks, null, 2));
    }
    return { success: true };
  } catch (e) {
    console.error('save-landmarks failed:', e);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('load-landmarks', (event, { meshPath }) => {
  try {
    if (!meshPath) return null;
    const lmPath = meshPath + '.landmarks.json';
    if (!fs.existsSync(lmPath)) return null;
    return JSON.parse(fs.readFileSync(lmPath, 'utf-8'));
  } catch (e) {
    return null;
  }
});

// List available SKM templates (custom FBX) and generic templates from registry
ipcMain.handle('list-rig-templates', () => {
  try {
    const registryPath = path.join(__dirname, '..', '..', 'scripts', 'rig_templates', 'skm', 'registry.json');
    if (!fs.existsSync(registryPath)) return { skm: [], generic: [] };
    const data = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    return {
      skm: data.skm_templates || [],
      generic: data.generic_templates || []
    };
  } catch (e) {
    console.error('list-rig-templates failed:', e);
    return { skm: [], generic: [] };
  }
});

// List animation FBX files for a given rig template (e.g. "orc_m1" → returns
// the absolute paths of every .fbx in scripts/rig_templates/animations/<name>/)
ipcMain.handle('list-rig-animations', (event, { templateName }) => {
  try {
    if (!templateName || !/^[a-z0-9_-]+$/i.test(templateName)) return [];
    const dir = path.join(__dirname, '..', '..', 'scripts', 'rig_templates', 'animations', templateName);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
    return fs.readdirSync(dir)
      .filter(f => /\.fbx$/i.test(f))
      .map(f => ({
        name: f.replace(/\.[^.]+$/, ''),
        path: path.join(dir, f),
      }));
  } catch (e) {
    console.error('list-rig-animations failed:', e);
    return [];
  }
});

// Auto-rigging via UniRig AI model → swap to orc_m1 UE5 skeleton (2-step pipeline)
// OR via Meshy.ai cloud API (rigging + walk/run anims), depending on `engine`.
ipcMain.handle('auto-rig-ai', async (event, { meshPath, engine }) => {
  const _t0 = Date.now();
  const rigEngine = engine || 'unirig';
  console.log(`[auto-rig-ai] START mesh=${meshPath} engine=${rigEngine} @${new Date(_t0).toISOString()}`);
  try {
    if (!meshPath || !fs.existsSync(meshPath)) {
      return { success: false, error: 'Mesh not found' };
    }
    if (!isPathAllowed(meshPath)) {
      return { success: false, error: 'Mesh path not allowed' };
    }
    const scriptsDir = path.join(__dirname, '..', '..', 'scripts');

    // ------------------------------------------------------------------
    // MESHY.AI cloud rigging path
    // ------------------------------------------------------------------
    if (rigEngine === 'meshy') {
      const cfg = loadConfig();
      const key = (cfg && cfg.meshyApiKey) || '';
      if (!key.trim()) {
        return { success: false, error: 'Meshy.ai API key not configured. Open Settings and paste your key.' };
      }
      const meshyScript = path.join(scriptsDir, 'meshy_bridge.py');
      if (!fs.existsSync(meshyScript)) {
        return { success: false, error: 'meshy_bridge.py not found' };
      }
      const baseName = path.basename(meshPath, path.extname(meshPath)).replace(/[^a-zA-Z0-9_-]/g, '_');
      const outputGlb = path.join(MESHES_DIR, `${baseName}_rigged_meshy_${Date.now()}.glb`);
      const meshyResult = await new Promise((resolve) => {
        safeSend('ai3d-progress', '[MeshyRig] Starting...');
        const proc = execFile(
          'python',
          [meshyScript, 'rig', key, meshPath, outputGlb, '1.7'],
          { timeout: 1800000, maxBuffer: 50 * 1024 * 1024 },
          (error, stdout, stderr) => resolve({ error, stdout, stderr })
        );
        proc.stdout?.on('data', d => safeSend('ai3d-progress', `[MeshyRig] ${d.toString()}`));
        proc.stderr?.on('data', d => safeSend('ai3d-progress', `[MeshyRig][stderr] ${d.toString()}`));
      });
      const durM = ((Date.now() - _t0) / 1000).toFixed(2);
      console.log(`[auto-rig-ai meshy] END duration=${durM}s error=${!!meshyResult.error}`);
      if (meshyResult.error || !fs.existsSync(outputGlb)) {
        const errMsg = extractErrorDetail(meshyResult) || (meshyResult.error && meshyResult.error.message) || 'Meshy rigging failed';
        return { success: false, error: errMsg, stdout: meshyResult.stdout, stderr: meshyResult.stderr };
      }
      const statsM = fs.statSync(outputGlb);
      return { success: true, path: outputGlb, filename: path.basename(outputGlb), size: statsM.size };
    }

    // ------------------------------------------------------------------
    // LOCAL: UniRig pipeline (3 steps: unirig -> swap_skeleton -> bake anims)
    // ------------------------------------------------------------------
    const unirigScript = path.join(scriptsDir, 'unirig_bridge.py');
    const swapScript = path.join(scriptsDir, 'swap_skeleton.py');
    const bakeAnimScript = path.join(scriptsDir, 'bake_procedural_anims.py');
    const orcBones = path.join(scriptsDir, 'rig_templates', 'skm', 'orc_m1.bones.json');
    if (!fs.existsSync(unirigScript)) {
      return { success: false, error: 'unirig_bridge.py not found' };
    }
    if (!fs.existsSync(swapScript)) {
      return { success: false, error: 'swap_skeleton.py not found' };
    }
    const baseName = path.basename(meshPath, path.extname(meshPath)).replace(/[^a-zA-Z0-9_-]/g, '_');
    const rigTs = Date.now();
    const tempUnirigGlb = path.join(MESHES_DIR, `${baseName}_unirig_temp_${rigTs}.glb`);
    const tempSwapGlb = path.join(MESHES_DIR, `${baseName}_swap_temp_${rigTs}.glb`);
    const outputGlb = path.join(MESHES_DIR, `${baseName}_rigged_unirig_${rigTs}.glb`);

    // Helper: run a python script and stream progress
    const runStep = (label, args) => new Promise((resolve) => {
      safeSend('ai3d-progress', `[${label}] Starting...`);
      const proc = execFile('python', args, {
        timeout: 600000,
        maxBuffer: 50 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        resolve({ error, stdout, stderr });
      });
      proc.stdout?.on('data', d => safeSend('ai3d-progress', `[${label}] ${d.toString()}`));
      proc.stderr?.on('data', d => safeSend('ai3d-progress', `[${label}][stderr] ${d.toString()}`));
      proc.on('error', e => resolve({ error: e, stdout: '', stderr: '' }));
    });

    // Step 1: UniRig skeleton + skin prediction (34 bones) → temp GLB
    const step1 = await runStep('UniRig', [unirigScript, meshPath, tempUnirigGlb]);
    if (step1.error || !fs.existsSync(tempUnirigGlb)) {
      const dur = ((Date.now() - _t0) / 1000).toFixed(2);
      console.log(`[auto-rig-ai] Step 1 FAILED duration=${dur}s`);
      try {
        fs.writeFileSync(
          path.join(__dirname, '..', '..', 'last_error.log'),
          `[${new Date().toISOString()}] auto-rig-ai step1 (duration=${dur}s)\nmesh: ${meshPath}\n\n=== STDOUT ===\n${step1.stdout || ''}\n\n=== STDERR ===\n${step1.stderr || ''}\n`
        );
      } catch (_e) {}
      const errMsg = extractErrorDetail(step1) || (step1.error && step1.error.message) || 'UniRig failed - no output';
      return { success: false, error: errMsg, stdout: step1.stdout, stderr: step1.stderr };
    }

    // Step 2: Swap skeleton to orc_m1 (117 bones) → temp swap GLB
    const step2 = await runStep('SwapSkeleton', [swapScript, tempUnirigGlb, orcBones, tempSwapGlb]);
    // Clean up UniRig temp
    try { fs.unlinkSync(tempUnirigGlb); } catch (_e) {}

    if (step2.error || !fs.existsSync(tempSwapGlb)) {
      const dur2 = ((Date.now() - _t0) / 1000).toFixed(2);
      console.log(`[auto-rig-ai] Step 2 FAILED duration=${dur2}s`);
      try {
        fs.writeFileSync(
          path.join(__dirname, '..', '..', 'last_error.log'),
          `[${new Date().toISOString()}] auto-rig-ai step2 (duration=${dur2}s)\nmesh: ${meshPath}\n\n=== STEP1 STDOUT ===\n${step1.stdout || ''}\n=== STEP1 STDERR ===\n${step1.stderr || ''}\n\n=== STEP2 STDOUT ===\n${step2.stdout || ''}\n=== STEP2 STDERR ===\n${step2.stderr || ''}\n`
        );
      } catch (_e) {}
      const errMsg = extractErrorDetail(step2) || (step2.error && step2.error.message) || 'Skeleton swap failed - no output';
      return { success: false, error: errMsg, stdout: step2.stdout, stderr: step2.stderr };
    }

    // Step 3: Bake procedural Idle/Walk/Run (CC0) animations into final GLB
    let step3 = { error: null, stdout: '', stderr: '' };
    if (fs.existsSync(bakeAnimScript)) {
      step3 = await runStep('BakeAnims', [bakeAnimScript, tempSwapGlb, orcBones, outputGlb]);
      if (step3.error || !fs.existsSync(outputGlb)) {
        // Bake failed - fall back to the swap output so the user still gets a rigged mesh
        console.log('[auto-rig-ai] Step 3 (bake anims) failed, falling back to non-animated rig');
        try { fs.copyFileSync(tempSwapGlb, outputGlb); } catch (_e) {}
      }
    } else {
      // No bake script - ship the swap output as-is
      try { fs.copyFileSync(tempSwapGlb, outputGlb); } catch (_e) {}
    }
    // Clean up swap temp
    try { if (fs.existsSync(tempSwapGlb)) fs.unlinkSync(tempSwapGlb); } catch (_e) {}

    const dur = ((Date.now() - _t0) / 1000).toFixed(2);
    console.log(`[auto-rig-ai] END duration=${dur}s error=${!!step3.error}`);
    try {
      fs.writeFileSync(
        path.join(__dirname, '..', '..', 'last_error.log'),
        `[${new Date().toISOString()}] auto-rig-ai (duration=${dur}s)\nmesh: ${meshPath}\noutput: ${outputGlb}\n\n=== STEP1 STDOUT ===\n${step1.stdout || ''}\n=== STEP1 STDERR ===\n${step1.stderr || ''}\n\n=== STEP2 STDOUT ===\n${step2.stdout || ''}\n=== STEP2 STDERR ===\n${step2.stderr || ''}\n\n=== STEP3 STDOUT ===\n${step3.stdout || ''}\n=== STEP3 STDERR ===\n${step3.stderr || ''}\n`
      );
    } catch (_e) {}

    if (!fs.existsSync(outputGlb)) {
      const errMsg = extractErrorDetail(step3) || (step3.error && step3.error.message) || 'Bake procedural anims failed - no output';
      return { success: false, error: errMsg, stdout: step3.stdout, stderr: step3.stderr };
    }
    const stats = fs.statSync(outputGlb);
    return { success: true, path: outputGlb, filename: path.basename(outputGlb), size: stats.size };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Extract last meaningful error line from a step's output
function extractErrorDetail(step) {
  const combined = (step.stdout || '') + '\n' + (step.stderr || '');
  const lines = combined.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i].trim();
    if (!ln) continue;
    if (/AUTORIG_ERROR|Error|Exception|Traceback/i.test(ln)) return ln;
  }
  return lines.filter(l => l.trim()).slice(-3).join(' | ');
}

// Auto-rigging: applies a skeleton template to a mesh and exports rigged FBX
ipcMain.handle('auto-rig', async (event, { meshPath, templateName, landmarks }) => {
  const _autorigT0 = Date.now();
  console.log(`[auto-rig] START mesh=${meshPath} template=${templateName} @${new Date(_autorigT0).toISOString()}`);
  try {
    if (!meshPath || !fs.existsSync(meshPath)) {
      return { success: false, error: 'Mesh not found' };
    }
    if (!isPathAllowed(meshPath)) {
      return { success: false, error: 'Mesh path not allowed' };
    }

    const config = loadConfig();
    if (!config.blenderPath || !fs.existsSync(config.blenderPath)) {
      return { success: false, error: 'Blender not configured (Settings)' };
    }

    // Validate template name (allow alphanum + underscore + hyphen only)
    if (!templateName || !/^[a-z0-9_-]+$/i.test(templateName)) {
      return { success: false, error: 'Invalid template name' };
    }

    const baseName = path.basename(meshPath, path.extname(meshPath)).replace(/[^a-zA-Z0-9_-]/g, '_');
    // Include a timestamp so each generation creates a new version instead of
    // silently overwriting the previous one. The versions-strip uses the file
    // list from the meshes/ folder, so stable file names == 1 version only.
    const rigTimestamp = Date.now();
    const outputFbx = path.join(MESHES_DIR, `${baseName}_rigged_${templateName}_${rigTimestamp}.glb`);

    const script = path.join(__dirname, '..', '..', 'scripts', 'auto_rig_bridge.py');

    // Write landmarks to a temp file (avoids long argv on Windows)
    const args = [script, meshPath, templateName, outputFbx, config.blenderPath];
    if (landmarks && Object.keys(landmarks).length > 0) {
      const lmTmp = path.join(SCRIPTS_DIR, `_landmarks_${Date.now()}.json`);
      try {
        fs.writeFileSync(lmTmp, JSON.stringify(landmarks));
        args.push(lmTmp);
      } catch(e) { console.warn('write landmarks tmp failed:', e); }
    }

    return await new Promise((resolve) => {
      const proc = execFile('python', args, {
        timeout: 300000,
        maxBuffer: 50 * 1024 * 1024
      }, (error, stdout, stderr) => {
        const _dur = ((Date.now() - _autorigT0) / 1000).toFixed(2);
        console.log(`[auto-rig] END duration=${_dur}s error=${!!error}`);
        // Always write the full Python output to last_error.log so the user
        // can inspect what went wrong (the styled customError modal only
        // shows the truncated error message).
        try {
          fs.writeFileSync(
            path.join(__dirname, '..', '..', 'last_error.log'),
            `[${new Date().toISOString()}] auto-rig (duration=${_dur}s)\nmesh: ${meshPath}\noutput: ${outputFbx}\ntemplate: ${templateName}\n\n=== STDOUT ===\n${stdout || ''}\n\n=== STDERR ===\n${stderr || ''}\n`
          );
        } catch (_e) {}
        if (error) {
          // Surface the last AUTORIG_ERROR / Traceback line so the user gets
          // an actionable message rather than just "Command failed: python ...".
          const combined = (stdout || '') + '\n' + (stderr || '');
          const lines = combined.split(/\r?\n/);
          let detail = '';
          for (let i = lines.length - 1; i >= 0; i--) {
            const ln = lines[i].trim();
            if (!ln) continue;
            if (/AUTORIG_ERROR|Error|Exception|Traceback/i.test(ln)) {
              detail = ln;
              break;
            }
          }
          if (!detail) detail = lines.filter(l => l.trim()).slice(-3).join(' | ');
          resolve({ success: false, error: detail || error.message, stdout, stderr });
        } else if (fs.existsSync(outputFbx)) {
          const stats = fs.statSync(outputFbx);
          resolve({ success: true, path: outputFbx, filename: path.basename(outputFbx), size: stats.size });
        } else {
          resolve({ success: false, error: 'Output FBX not created', stdout, stderr });
        }
      });
      proc.stdout?.on('data', d => {
        safeSend('ai3d-progress', d.toString());
      });
      proc.stderr?.on('data', d => {
        safeSend('ai3d-progress', '[stderr] ' + d.toString());
      });
      proc.on('error', e => resolve({ success: false, error: e.message }));
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Show Windows native notification
const { Notification } = require('electron');
ipcMain.handle('show-notification', (event, { title, body }) => {
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title: title || 'FabMesh', body: body || '', silent: false });
      n.show();
      return true;
    }
  } catch(e) { console.error('notification failed:', e); }
  return false;
});

// Export mesh to Unreal-friendly FBX (cm scale, Y-up axis)
ipcMain.handle('export-to-unreal', async (event, { sourcePath, customName }) => {
  try {
    if (!isPathAllowed(sourcePath)) throw new Error('Source not allowed');
    if (!fs.existsSync(sourcePath)) throw new Error('Source not found');
    const config = loadConfig();
    if (!config.blenderPath) throw new Error('Blender path not configured (Settings)');

    let baseName;
    if (customName) {
      baseName = customName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    } else {
      baseName = path.basename(sourcePath, path.extname(sourcePath)).replace(/[^a-zA-Z0-9_-]/g, '_') + '_unreal';
    }
    const outputPath = path.join(MESHES_DIR, `${baseName}.fbx`);

    const exportScript = `
import bpy
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

src = ${JSON.stringify(sourcePath.replace(/\\/g, '/'))}
ext = src.rsplit('.', 1)[-1].lower()
if ext in ('glb','gltf'):
    bpy.ops.import_scene.gltf(filepath=src)
elif ext == 'obj':
    bpy.ops.wm.obj_import(filepath=src)
elif ext == 'fbx':
    bpy.ops.import_scene.fbx(filepath=src)
elif ext == 'stl':
    bpy.ops.import_mesh.stl(filepath=src)

# Scale to cm (Unreal default unit) and set Y-up (Unreal axis)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.transform.resize(value=(100, 100, 100))

out = ${JSON.stringify(outputPath.replace(/\\/g, '/'))}
bpy.ops.export_scene.fbx(
    filepath=out,
    use_selection=False,
    global_scale=1.0,
    apply_unit_scale=True,
    apply_scale_options='FBX_SCALE_NONE',
    axis_forward='-Z',
    axis_up='Y',
    object_types={'MESH'},
    use_mesh_modifiers=True,
    mesh_smooth_type='FACE',
    path_mode='COPY',
    embed_textures=True
)
`;
    const tmpScript = path.join(SCRIPTS_DIR, `unreal_export_${Date.now()}.py`);
    fs.writeFileSync(tmpScript, exportScript);

    return await new Promise((resolve) => {
      const cleanup = () => { try { if (fs.existsSync(tmpScript)) fs.unlinkSync(tmpScript); } catch(e) {} };
      const proc = execFile(config.blenderPath, ['--background', '--python', tmpScript], { timeout: 120000 }, (error, stdout, stderr) => {
        cleanup();
        if (error) resolve({ success: false, error: error.message, stderr });
        else if (!fs.existsSync(outputPath)) resolve({ success: false, error: 'Export failed' });
        else resolve({ success: true, path: outputPath, filename: path.basename(outputPath) });
      });
      proc.on('error', err => { cleanup(); resolve({ success: false, error: err.message }); });
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Import an image file (drag&drop or picker) into the images folder
ipcMain.handle('import-image-file', (event, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const ext = path.extname(filePath).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return null;
    const baseName = path.basename(filePath, ext).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
    const projDir = path.join(IMAGES_DIR, baseName);
    fs.mkdirSync(projDir, { recursive: true });
    const ts = Date.now();
    const dest = path.join(projDir, `imported_${ts}${ext}`);
    fs.copyFileSync(filePath, dest);
    fs.writeFileSync(path.join(projDir, 'prompt.txt'), '[Imported] ' + path.basename(filePath), 'utf-8');
    return { path: dest, projectName: baseName };
  } catch (e) {
    console.error('import-image-file failed:', e);
    return null;
  }
});

// Manual mask inpaint: user paints the mask in-app, we send it to SDXL
ipcMain.handle('mask-inpaint', async (event, { imagePath, maskDataUrl, prompt }) => {
  try {
    if (!imagePath || !maskDataUrl) {
      return { success: false, error: 'imagePath and maskDataUrl required' };
    }
    const dir = path.dirname(imagePath);
    const ext = path.extname(imagePath);
    const base = safeBase(path.basename(imagePath, ext));
    const ts = Date.now();
    const newImagePath = path.join(dir, `${base}_inpaint_${ts}${ext}`);
    // Decode dataURL to a temp PNG file
    const m = /^data:image\/\w+;base64,(.+)$/.exec(maskDataUrl);
    if (!m) return { success: false, error: 'invalid maskDataUrl' };
    const tmpDir = path.join(dir, '.debug');
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) {}
    const maskPath = path.join(tmpDir, `${base}_usermask_${ts}.png`);
    fs.writeFileSync(maskPath, Buffer.from(m[1], 'base64'));

    await ensureSdxlServer();
    if (!sdxlReady) return { success: false, error: 'SDXL server failed to start' };
    const r = await sdxlServerCall('/mask_inpaint', {
      input: imagePath, mask: maskPath, prompt: prompt || '', output: newImagePath
    });
    if (r.ok) return { success: true, newPath: newImagePath };
    return { success: false, error: r.error || 'SDXL server error' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Auto-inpaint: CLIPSeg segments target area + SDXL Inpainting replaces it
ipcMain.handle('auto-inpaint', async (event, { imagePath, targetText, prompt, dilate }) => {
  try {
    const dir = path.dirname(imagePath);
    const ext = path.extname(imagePath);
    const base = safeBase(path.basename(imagePath, ext));
    const ts = Date.now();
    const newImagePath = path.join(dir, `${base}_inpaint_${ts}${ext}`);

    // Lazy-start the persistent SDXL server (no model reload between calls)
    await ensureSdxlServer();
    if (sdxlReady) {
      console.log('[inpaint] Using persistent SDXL server');
      const r = await sdxlServerCall('/inpaint', {
        input: imagePath, target: targetText, prompt: prompt || '', output: newImagePath, dilate: dilate || 15
      });
      if (r.ok) return { success: true, newPath: newImagePath };
      console.warn('[inpaint] SDXL server failed, falling back to subprocess:', r.error);
    }

    const script = path.join(__dirname, '..', '..', 'scripts', 'local_inpaint_bridge.py');
    return new Promise((resolve) => {
      const proc = execFile('python', [script, imagePath, targetText, prompt || '', newImagePath, String(dilate || 15)], {
        timeout: 300000, maxBuffer: 50 * 1024 * 1024
      }, (error, stdout, stderr) => {
        if (error) {
          resolve({ success: false, error: error.message, stdout, stderr });
        } else if (fs.existsSync(newImagePath)) {
          resolve({ success: true, newPath: newImagePath });
        } else {
          resolve({ success: false, error: 'Output not created', stdout, stderr });
        }
      });
      proc.stdout?.on('data', d => {
        safeSend('ai3d-progress', d.toString());
      });
      proc.stderr?.on('data', d => {
        safeSend('ai3d-progress', '[stderr] ' + d.toString());
      });
      proc.on('error', e => resolve({ success: false, error: e.message }));
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Img2img: local SDXL by default, or cloud Pollinations if explicitly chosen
ipcMain.handle('img2img', async (event, { imagePath, prompt, strength, engine }) => {
  try {
    const safety = checkPromptSafety(prompt);
    if (!safety.safe) return { success: false, error: safety.reason };
    const aiSafety = await checkPromptSafetyAI(prompt);
    if (!aiSafety.safe) return { success: false, error: aiSafety.reason };
    // Create new version path in same folder
    const dir = path.dirname(imagePath);
    const ext = path.extname(imagePath);
    const base = safeBase(path.basename(imagePath, ext));
    const ts = Date.now();
    const newImagePath = path.join(dir, `${base}_refined_${ts}${ext}`);

    const useCloud = (engine === 'pollinations');

    if (!useCloud) {
      // Lazy-start the persistent SDXL server (RealVis XL) and wait for ready.
      // No fallback to local_img2img_bridge.py (SDXL Turbo, non-commercial).
      await ensureSdxlServer();
      if (!sdxlReady) {
        return { success: false, error: 'SDXL server failed to start. Try again in a few seconds.' };
      }
      console.log('[img2img] Using persistent SDXL server (RealVis XL)');
      const r = await sdxlServerCall('/img2img', {
        input: imagePath, prompt, output: newImagePath, strength: strength || 0.55
      });
      if (r.ok) return { success: true, newPath: newImagePath };
      return { success: false, error: r.error || 'img2img failed on SDXL server' };
    }

    // Explicit cloud path (user selected Pollinations)
    console.log('[img2img] Using Pollinations (cloud, user-selected)');

    let uploadPath = imagePath;
    const tempResized = imagePath + '.resize.png';

    // Upload image to catbox.moe to get a public URL
    const publicUrl = await uploadToCatbox(uploadPath);
    console.log('Uploaded to:', publicUrl);

    // Use kontext via Pollinations - try multiple times with different settings
    const https = require('https');
    const http = require('http');
    const enc = encodeURIComponent(prompt);

    const attempts = [
      `https://image.pollinations.ai/prompt/${enc}?model=kontext&image=${encodeURIComponent(publicUrl)}&nologo=true`,
      `https://image.pollinations.ai/prompt/${enc}?model=kontext&image=${encodeURIComponent(publicUrl)}`,
      `https://image.pollinations.ai/prompt/${enc}?model=flux&image=${encodeURIComponent(publicUrl)}&nologo=true`,
    ];

    let lastError = null;
    for (const url of attempts) {
      try {
        await new Promise((resolve, reject) => {
          const followRedirect = (u, depth) => {
            if (depth > 5) return reject(new Error('Too many redirects'));
            const lib = u.startsWith('https') ? https : http;
            lib.get(u, { headers: { 'User-Agent': 'FabMesh/1.0' }, timeout: 180000 }, (resp) => {
              if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
                return followRedirect(resp.headers.location, depth + 1);
              }
              if (resp.statusCode !== 200) return reject(new Error(`HTTP ${resp.statusCode}`));
              const chunks = [];
              resp.on('data', c => chunks.push(c));
              resp.on('end', () => {
                const buf = Buffer.concat(chunks);
                if (buf.length < 1000) return reject(new Error('Response too small'));
                fs.writeFileSync(newImagePath, buf);
                resolve();
              });
              resp.on('error', reject);
            }).on('error', reject);
          };
          followRedirect(url, 0);
        });
        // Cleanup temp
        if (fs.existsSync(tempResized)) fs.unlinkSync(tempResized);
        return { success: true, newPath: newImagePath };
      } catch (e) {
        lastError = e;
        console.log('Attempt failed:', e.message);
      }
    }

    if (fs.existsSync(tempResized)) fs.unlinkSync(tempResized);
    return { success: false, error: lastError ? lastError.message : 'All attempts failed' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Quick image edits: symmetrize, upscale, brightness, crop, etc.
// All done via a single Python one-liner using PIL — fast, no GPU needed.
ipcMain.handle('image-quick-edit', async (event, { imagePath, operation, params }) => {
  try {
    if (!imagePath || !fs.existsSync(imagePath)) return { success: false, error: 'Image not found' };
    const dir = path.dirname(imagePath);
    const ext = path.extname(imagePath);
    const base = safeBase(path.basename(imagePath, ext));
    const ts = Date.now();
    const outPath = path.join(dir, `${base}_${operation}_${ts}${ext}`);
    const p = params || {};

    const scripts = {
      symmetrize: `
from PIL import Image
img = Image.open(r"${imagePath}")
w, h = img.size
half = img.crop((0, 0, w//2, h))
flipped = half.transpose(Image.FLIP_LEFT_RIGHT)
out = Image.new(img.mode, (w, h))
out.paste(half, (0, 0))
out.paste(flipped, (w//2, 0))
out.save(r"${outPath}")
print("OK")`,

      symmetrize_right: `
from PIL import Image
img = Image.open(r"${imagePath}")
w, h = img.size
half = img.crop((w//2, 0, w, h))
flipped = half.transpose(Image.FLIP_LEFT_RIGHT)
out = Image.new(img.mode, (w, h))
out.paste(flipped, (0, 0))
out.paste(half, (w//2, 0))
out.save(r"${outPath}")
print("OK")`,

      upscale: `
from PIL import Image
img = Image.open(r"${imagePath}")
w, h = img.size
out = img.resize((w*2, h*2), Image.LANCZOS)
out.save(r"${outPath}")
print("OK")`,

      downscale: `
from PIL import Image
img = Image.open(r"${imagePath}")
w, h = img.size
out = img.resize((max(1,w//2), max(1,h//2)), Image.LANCZOS)
out.save(r"${outPath}")
print("OK")`,

      brightness: `
from PIL import Image, ImageEnhance, ImageFilter
img = Image.open(r"${imagePath}")
img = ImageEnhance.Brightness(img).enhance(${p.brightness || 1.0})
img = ImageEnhance.Contrast(img).enhance(${p.contrast || 1.0})
img = ImageEnhance.Color(img).enhance(${p.saturation || 1.0})
sh = ${p.sharpness || 1.0}
if sh != 1.0:
    img = ImageEnhance.Sharpness(img).enhance(sh)
img.save(r"${outPath}")
print("OK")`,

      crop: `
from PIL import Image
img = Image.open(r"${imagePath}")
w, h = img.size
l = int(w * ${p.left || 0})
t = int(h * ${p.top || 0})
r = int(w * ${p.right || 1})
b = int(h * ${p.bottom || 1})
out = img.crop((l, t, r, b))
out.save(r"${outPath}")
print("OK")`,

      extend: `
from PIL import Image
img = Image.open(r"${imagePath}")
w, h = img.size
pad = int(max(w, h) * ${p.padding || 0.2})
out = Image.new(img.mode, (w + pad*2, h + pad*2), (255,255,255) if img.mode == 'RGB' else (255,255,255,0))
out.paste(img, (pad, pad))
out.save(r"${outPath}")
print("OK")`,

      facefix: `
from PIL import Image, ImageFilter
img = Image.open(r"${imagePath}")
w, h = img.size
# Simple face region: top 40% center 60%
fl = int(w * 0.2)
ft = 0
fr = int(w * 0.8)
fb = int(h * 0.4)
face = img.crop((fl, ft, fr, fb))
face = face.filter(ImageFilter.SMOOTH_MORE)
from PIL import ImageEnhance
face = ImageEnhance.Sharpness(face).enhance(1.5)
img.paste(face, (fl, ft))
img.save(r"${outPath}")
print("OK")`,
    };

    const script = scripts[operation];
    if (!script) return { success: false, error: `Unknown operation: ${operation}` };

    return await new Promise((resolve) => {
      execFile('python', ['-c', script], { timeout: 120000 }, (error, stdout, stderr) => {
        if (error || !fs.existsSync(outPath)) {
          resolve({ success: false, error: (error?.message || stderr || 'failed').slice(-300) });
        } else {
          resolve({ success: true, newPath: outPath });
        }
      });
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('remove-background', async (event, imagePath) => {
  return new Promise((resolve) => {
    const dir = path.dirname(imagePath);
    const ext = path.extname(imagePath);
    const base = safeBase(path.basename(imagePath, ext));
    const timestamp = Date.now();
    const newImagePath = path.join(dir, `${base}_nobg_${timestamp}${ext}`);
    const cleanup = () => { try { if (fs.existsSync(newImagePath)) fs.unlinkSync(newImagePath); } catch(e) {} };

    try {
      fs.copyFileSync(imagePath, newImagePath);
    } catch(e) {
      resolve({ success: false, error: 'Could not copy source: ' + e.message });
      return;
    }

    const script = path.join(__dirname, '..', '..', 'scripts', 'remove_bg.py');
    const proc = execFile('python', [script, newImagePath], { timeout: 60000 }, (error, stdout, stderr) => {
      if (error) {
        cleanup();
        resolve({ success: false, error: error.message, stderr });
      } else {
        // Script may output a different path (e.g. .png instead of .jpeg)
        const outMatch = (stdout || '').match(/OK:\s*(.+)/);
        const actualPath = outMatch ? outMatch[1].trim() : newImagePath;
        resolve({ success: true, newPath: actualPath });
      }
    });
    proc.stderr?.on('data', d => {
      safeSend('ai3d-progress', '[stderr] ' + d.toString());
    });
    proc.on('error', err => { cleanup(); resolve({ success: false, error: err.message }); });
  });
});

ipcMain.handle('save-thumbnail', (event, { meshPath, dataUrl }) => {
  const thumbPath = meshPath.replace(/\.[^.]+$/, '_thumb.png');
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(thumbPath, base64, 'base64');
  return thumbPath;
});

ipcMain.handle('get-thumbnail', (event, meshPath) => {
  const thumbPath = meshPath.replace(/\.[^.]+$/, '_thumb.png');
  if (fs.existsSync(thumbPath)) {
    return 'file:///' + thumbPath.replace(/\\/g, '/');
  }
  return null;
});

ipcMain.handle('show-in-explorer', (event, filePath) => {
  shell.showItemInFolder(filePath);
});

// Check GPU status
ipcMain.handle('check-gpu', async () => {
  // Use nvidia-smi for instant GPU stats (no PyTorch load, ~50 ms)
  return new Promise((resolve) => {
    execFile('nvidia-smi',
      ['--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu', '--format=csv,noheader,nounits'],
      { timeout: 3000 },
      (error, stdout) => {
        if (error) {
          resolve({ available: false, error: error.message });
          return;
        }
        // Parse first GPU line: "GeForce RTX 5080, 16380, 1234, 15146, 12, 45"
        const line = (stdout || '').split('\n').filter(l => l.trim())[0] || '';
        const parts = line.split(',').map(s => s.trim());
        if (parts.length < 4) {
          resolve({ available: false, error: 'Unexpected nvidia-smi output' });
          return;
        }
        const totalMB = parseFloat(parts[1]);
        const usedMB  = parseFloat(parts[2]);
        const freeMB  = parseFloat(parts[3]);
        const util    = parseFloat(parts[4] || '0');
        const temp    = parseFloat(parts[5] || '0');
        resolve({
          available: true,
          name: parts[0],
          totalGB: +(totalMB / 1024).toFixed(2),
          usedGB:  +(usedMB / 1024).toFixed(2),
          freeGB:  +(freeMB / 1024).toFixed(2),
          gpuUtil: util,
          tempC: temp,
        });
      });
  });
});

// Set system RAM limit (called from renderer when user drags the RAM slider)
ipcMain.handle('set-ram-limit', (event, limitPct) => {
  // Convert percentage to absolute MB based on total system RAM
  const totalMB = Math.round(os.totalmem() / (1024 * 1024));
  const limitMB = Math.round(totalMB * (limitPct / 100));
  process.env.FABMESH_RAM_LIMIT_MB = String(limitMB);
  return { limitMB, totalMB };
});

// Set GPU util/temp/vram limits (called when user drags the GPU sliders in Settings).
// We do THREE things so the throttle reacts for new AND running processes:
//   1. process.env.FABMESH_GPU_LIMIT / FABMESH_TEMP_LIMIT / FABMESH_VRAM_FRACTION
//      → inherited by new children subprocesses
//   2. scripts/.gpu_limit.json → re-read every step by gpu_throttle.py in any
//      already-running Python process (live slider behaviour for GPU/temp)
//   3. If the VRAM slider moves, stop the SDXL server so that next time it's
//      needed it respawns with the new fraction (VRAM hard cap is applied via
//      torch.cuda.set_per_process_memory_fraction at process startup).
ipcMain.handle('set-gpu-limits', (event, limits) => {
  const l = limits || {};
  if (typeof l.util === 'number' && l.util > 0 && l.util <= 100) {
    process.env.FABMESH_GPU_LIMIT = String(Math.round(l.util));
  }
  if (typeof l.temp === 'number' && l.temp > 0 && l.temp <= 120) {
    process.env.FABMESH_TEMP_LIMIT = String(Math.round(l.temp));
  }
  let vramChanged = false;
  if (typeof l.vram === 'number' && l.vram > 0 && l.vram <= 100) {
    const newFrac = (Math.round(l.vram) / 100).toFixed(2);
    if (process.env.FABMESH_VRAM_FRACTION !== newFrac) {
      process.env.FABMESH_VRAM_FRACTION = newFrac;
      vramChanged = true;
    }
  }
  try {
    const limitsFile = path.join(__dirname, '..', '..', 'scripts', '.gpu_limit.json');
    const payload = {
      gpu:  process.env.FABMESH_GPU_LIMIT  ? Number(process.env.FABMESH_GPU_LIMIT)  : null,
      temp: process.env.FABMESH_TEMP_LIMIT ? Number(process.env.FABMESH_TEMP_LIMIT) : null,
      vramFraction: process.env.FABMESH_VRAM_FRACTION ? Number(process.env.FABMESH_VRAM_FRACTION) : null,
      updatedAt: Date.now(),
    };
    fs.writeFileSync(limitsFile, JSON.stringify(payload), 'utf-8');
  } catch (e) {
    console.error('[main] could not write gpu_limit.json:', e.message);
  }
  // If the VRAM fraction changed, kill the SDXL server so the next img2img /
  // inpaint call respawns it with the new PyTorch memory cap. The idle timer
  // would eventually do this anyway after 5 min, but an explicit stop here
  // guarantees the new limit takes effect right now.
  if (vramChanged && sdxlProc) {
    console.log('[SDXL] VRAM slider changed to', process.env.FABMESH_VRAM_FRACTION, '- stopping server so it respawns with the new cap');
    try { stopSdxlServer(); } catch (e) { console.error('[SDXL] stop on slider change failed:', e.message); }
  }
  return {
    gpuLimit: process.env.FABMESH_GPU_LIMIT || null,
    tempLimit: process.env.FABMESH_TEMP_LIMIT || null,
    vramFraction: process.env.FABMESH_VRAM_FRACTION || null,
  };
});

// Check system RAM stats
ipcMain.handle('check-ram', () => {
  const totalBytes = os.totalmem();
  const freeBytes  = os.freemem();
  const usedBytes  = totalBytes - freeBytes;
  const totalGB    = +(totalBytes / (1024 ** 3)).toFixed(2);
  const usedGB     = +(usedBytes / (1024 ** 3)).toFixed(2);
  const freeGB     = +(freeBytes / (1024 ** 3)).toFixed(2);
  return { totalGB, usedGB, freeGB };
});

// Flash taskbar when generation completes
ipcMain.handle('flash-taskbar', () => {
  if (mainWindow && !mainWindow.isFocused()) {
    mainWindow.flashFrame(true);
  }
});

// --- Utility: extract Python code from Claude output ---
function extractPythonCode(raw) {
  let code = raw.trim();
  // If there's a ```python block, extract it
  const pyBlockMatch = code.match(/```python\s*\n([\s\S]*?)```/);
  if (pyBlockMatch) return pyBlockMatch[1].trim();
  // If there's a generic ``` block, extract it
  const blockMatch = code.match(/```\s*\n([\s\S]*?)```/);
  if (blockMatch) return blockMatch[1].trim();
  // If it starts with text before "import bpy", strip the text
  const importIdx = code.indexOf('import bpy');
  if (importIdx > 0) return code.slice(importIdx).trim();
  // If starts with ``` on first line
  if (code.startsWith('```python')) code = code.replace(/^```python\n?/, '').replace(/\n?```$/, '');
  else if (code.startsWith('```')) code = code.replace(/^```\n?/, '').replace(/\n?```$/, '');
  return code.trim();
}

// --- Helper: call Claude CLI ---
function callClaude(claudePath, aiModel, prompt) {
  return new Promise((resolve, reject) => {
    const cleanEnv = { ...process.env };
    delete cleanEnv.ELECTRON_RUN_AS_NODE;
    let stdout = '', stderr = '';
    const proc = spawn(claudePath, ['--print', '--model', aiModel], {
      env: cleanEnv, shell: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: 300000
    });
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('error', err => reject(new Error(`Claude CLI: ${err.message}`)));
    proc.on('close', code => {
      if (code !== 0) { reject(new Error(`Claude exited ${code}\n${stderr.slice(0, 300)}`)); return; }
      const result = extractPythonCode(stdout);
      if (!result) { reject(new Error('Claude returned no Python code')); return; }
      resolve(result);
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// --- Helper: run Blender script, retry once on error ---
async function runBlenderWithRetry(config, scriptPath, meshPath, scriptContent, claudePath, aiModel) {
  const runBlender = () => new Promise((resolve, reject) => {
    execFile(config.blenderPath, ['--background', '--python', scriptPath], {
      timeout: 120000, maxBuffer: 50 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) { reject({ error: error.message, stdout, stderr }); return; }
      if (!fs.existsSync(meshPath)) { reject({ error: 'Mesh not created', stdout, stderr }); return; }
      const stats = fs.statSync(meshPath);
      resolve({ size: stats.size, stdout, stderr });
    });
  });

  try {
    return await runBlender();
  } catch (blenderErr) {
    // Retry: send error back to Claude to fix
    const errMsg = (blenderErr.stderr || blenderErr.stdout || blenderErr.error || '').slice(0, 500);
    const fixPrompt = `The following Blender Python script has an error. Fix it.

--- SCRIPT WITH ERROR ---
${scriptContent}
--- END SCRIPT ---

--- BLENDER ERROR ---
${errMsg}
--- END ERROR ---

Output ONLY the fixed Python code. No explanations, no markdown.`;

    try {
      const fixedCode = await callClaude(claudePath, 'sonnet', fixPrompt);
      fs.writeFileSync(scriptPath, fixedCode, 'utf-8');
      return await runBlender();
    } catch (retryErr) {
      throw blenderErr; // throw original error if retry also fails
    }
  }
}

// --- AI Generation via Claude CLI ---

ipcMain.handle('generate-from-prompt', async (event, { prompt, outputName, format, model, maxTris }) => {
  try {
    const config = loadConfig();
    if (!config.blenderPath) {
      return { success: false, step: 'ai', error: 'Blender path not configured. Click the gear icon to set it.' };
    }

    const ext = format || 'glb';
    const aiModel = model || 'opus';
    const safeName = outputName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = Date.now();
    const meshFilename = `${safeName}_${timestamp}.${ext}`;
    const scriptFilename = `${safeName}_${timestamp}.py`;
    const meshPath = path.join(MESHES_DIR, meshFilename);
    const scriptPath = path.join(SCRIPTS_DIR, scriptFilename);
    const outputPathEscaped = meshPath.replace(/\\/g, '/');

    // Build the Claude prompt - expert level
    const claudePrompt = `You are an expert Blender 3D artist and Python developer. Generate a production-quality Blender Python script that creates: "${prompt}"

YOU MUST OUTPUT ONLY PYTHON CODE. No explanations, no markdown, no backticks.

TECHNICAL REQUIREMENTS:
1. IMPORTS: import bpy, bmesh, math, from mathutils import Vector, Matrix, Euler
2. SCENE SETUP: Clear all objects, meshes, materials first
3. GEOMETRY - use advanced techniques:
   - Use bmesh for complex shapes (extrude, inset, bevel edges)
   - Combine primitives with boolean modifiers for complex forms
   - Add Subdivision Surface modifier (levels=2, render=3) for smooth organic shapes
   - Add Bevel modifier on hard-surface objects for realistic edges
   - Use proportional editing concepts (scale vertices by distance)
   - Create proper edge loops and topology
4. MATERIALS - create realistic PBR materials:
   - Use Principled BSDF with proper Base Color (NEVER pure black)
   - Set Metallic (0.0 for non-metals, 0.9+ for metals)
   - Set Roughness appropriately (0.1-0.3 polished, 0.5-0.8 rough)
   - Add Bump/Normal nodes with Noise Texture for surface detail
   - Use Color Ramp + Noise Texture for color variation
   - Mix multiple materials on the same object using material slots and face assignment
5. NORMALS: After EVERY mesh edit, recalculate normals:
   bpy.ops.object.editmode_toggle()
   bpy.ops.mesh.select_all(action='SELECT')
   bpy.ops.mesh.normals_make_consistent(inside=False)
   bpy.ops.object.editmode_toggle()
6. SHADING: Apply Shade Smooth + Auto Smooth on all objects
7. DETAILS: Add small details that make the object believable (scratches, wear, beveled edges, slight imperfections)
8. SCALE: Keep objects at realistic scale (1 unit = 1 meter)

EXPORT - use this exact code at the end:
output_path = "${outputPathEscaped}"
if output_path.endswith('.glb') or output_path.endswith('.gltf'):
    fmt = 'GLB' if output_path.endswith('.glb') else 'GLTF_SEPARATE'
    bpy.ops.export_scene.gltf(filepath=output_path, export_format=fmt)
elif output_path.endswith('.obj'):
    bpy.ops.wm.obj_export(filepath=output_path)
elif output_path.endswith('.fbx'):
    bpy.ops.export_scene.fbx(filepath=output_path)
elif output_path.endswith('.stl'):
    bpy.ops.export_mesh.stl(filepath=output_path)
print("FABMESH_SUCCESS")

TRIANGLE BUDGET: ${maxTris > 0 ? `The final mesh MUST stay under ${maxTris.toLocaleString()} triangles total. Use a Decimate modifier (type='COLLAPSE', ratio adjusted) at the end if needed to reduce polycount. Add this check before export:
total_tris = sum(len(obj.data.polygons) for obj in bpy.data.objects if obj.type == 'MESH')
if total_tris > ${maxTris}:
    for obj in bpy.data.objects:
        if obj.type == 'MESH':
            mod = obj.modifiers.new('Decimate', 'DECIMATE')
            mod.ratio = ${maxTris} / max(total_tris, 1)
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.modifier_apply(modifier='Decimate')
Adapt your geometry complexity to stay within budget. ${maxTris <= 1000 ? 'Use LOW-POLY style: flat shading, minimal vertices, stylized look.' : maxTris <= 5000 ? 'Use MEDIUM detail: good topology, some bevels but keep it efficient.' : 'Use HIGH detail: subdivision, detailed bevels, rich geometry.'}` : 'No triangle limit — use as much detail as needed for quality.'}

Generate detailed geometry that looks like a professional 3D model. Output ONLY Python code.`;

    // Step 1: Call Claude CLI
    const claudePath = path.join(process.env.APPDATA || '', 'npm', 'claude.cmd');
    if (!fs.existsSync(claudePath)) {
      return { success: false, step: 'ai', error: `Claude CLI not found at: ${claudePath}` };
    }

    let scriptContent;
    try {
      scriptContent = await callClaude(claudePath, aiModel, claudePrompt);
    } catch (err) {
      return { success: false, step: 'ai', error: err.message };
    }

    fs.writeFileSync(scriptPath, scriptContent, 'utf-8');

    // Step 2: Run in Blender (with auto-retry on error)
    try {
      const blenderResult = await runBlenderWithRetry(config, scriptPath, meshPath, scriptContent, claudePath, aiModel);
      const result = { meshPath, meshFilename, scriptPath, scriptFilename, format: ext, size: blenderResult.size, scriptContent };
      // Save to version history
      const versionData = addVersion(safeName, {
        prompt,
        scriptContent,
        meshPath: result.meshPath,
        meshFilename: result.meshFilename,
        format: ext
      });

      return { success: true, ...result, versionData };
    } catch (err) {
      return { success: false, step: 'blender', error: err.error || err.message || String(err) };
    }
  } catch (err) {
    return { success: false, step: 'ai', error: `Unexpected error: ${err.message || err}` };
  }
});

// --- Save screenshot from renderer ---
ipcMain.handle('save-screenshot', async (event, { dataUrl, projectName }) => {
  const screenshotPath = path.join(getProjectDir(projectName), `screenshot_${Date.now()}.png`);
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(screenshotPath, base64, 'base64');
  return screenshotPath;
});

// --- Refine existing mesh ---
ipcMain.handle('refine-mesh', async (event, { projectName, modification, format, screenshotPath, model }) => {
  try {
    const config = loadConfig();
    const aiModel = model || 'opus';
    if (!config.blenderPath) {
      return { success: false, step: 'ai', error: 'Blender path not configured.' };
    }

    const data = loadVersions(projectName);
    if (data.versions.length === 0) {
      return { success: false, step: 'ai', error: 'No previous version found to refine.' };
    }

    const currentV = data.versions[data.currentVersion];
    const prevScriptPath = path.join(getProjectDir(projectName), currentV.scriptFile);
    const prevScript = fs.readFileSync(prevScriptPath, 'utf-8');
    const isImported = currentV.imported || prevScript.startsWith('# Imported mesh');

    const ext = format || 'glb';
    const timestamp = Date.now();
    const meshFilename = `${projectName}_${timestamp}.${ext}`;
    const scriptFilename = `${projectName}_${timestamp}.py`;
    const meshPath = path.join(MESHES_DIR, meshFilename);
    const scriptPath = path.join(SCRIPTS_DIR, scriptFilename);
    const outputPathEscaped = meshPath.replace(/\\/g, '/');

    // Encode screenshot as base64 to embed in prompt if available
    let screenshotB64 = '';
    if (screenshotPath && fs.existsSync(screenshotPath)) {
      const imgBuf = fs.readFileSync(screenshotPath);
      screenshotB64 = imgBuf.toString('base64');
    }

    let claudePrompt;

    if (isImported) {
      // Imported mesh — import the original file in Blender and modify it
      const originalMeshPath = currentV.meshPath.replace(/\\/g, '/');
      const originalExt = path.extname(currentV.meshPath).slice(1).toLowerCase();

      // Determine import command based on format
      let importCmd = '';
      if (originalExt === 'fbx') importCmd = `bpy.ops.import_scene.fbx(filepath="${originalMeshPath}")`;
      else if (originalExt === 'obj') importCmd = `bpy.ops.wm.obj_import(filepath="${originalMeshPath}")`;
      else if (originalExt === 'glb' || originalExt === 'gltf') importCmd = `bpy.ops.import_scene.gltf(filepath="${originalMeshPath}")`;
      else if (originalExt === 'stl') importCmd = `bpy.ops.import_mesh.stl(filepath="${originalMeshPath}")`;

      claudePrompt = `You are an expert Blender 3D artist. The user has an imported 3D mesh and wants to modify it IN PLACE.

Generate a Blender Python script that:
1. Clears the default scene
2. Imports the original mesh with: ${importCmd}
3. Applies the user's modification: "${modification}"
4. Exports the result

IMPORTANT: You are MODIFYING the imported mesh, NOT recreating it from scratch. The original geometry and materials must be preserved. Only add/change what the user asks for.

Techniques you can use to modify the imported mesh:
- Add new objects (primitives, meshes) alongside the imported ones
- Select imported objects by name and modify them (scale, move, add modifiers)
- Use bmesh to edit geometry of selected objects
- Add/modify materials on existing objects
- Duplicate parts of the mesh and transform them
- Use boolean modifiers to cut or add geometry

CRITICAL RULES:
- Output ONLY Python code, no markdown, no backticks, no explanations
- Start by clearing default objects, then import the original mesh
- Preserve the original mesh and its materials/textures as much as possible
- Any NEW objects you add MUST have realistic PBR materials that MATCH the style of the existing mesh
- IMPORTANT: After importing, inspect existing materials to understand the visual style. Copy or reuse existing materials where possible:
  for mat in bpy.data.materials:
      if mat.use_nodes:
          # reuse this material on new objects if appropriate
- For NEW objects: REUSE the existing materials from the imported mesh. After import, get the main material and assign it to new objects:
  main_mat = None
  for mat in bpy.data.materials:
      if mat.use_nodes:
          for node in mat.node_tree.nodes:
              if node.type == 'TEX_IMAGE' and node.image:
                  main_mat = mat
                  break
  # Then for each new object: new_obj.data.materials.append(main_mat)
- This ensures new objects share the same texture as the imported mesh
- If you need a different look (e.g. metal cap), create a simple material with Base Color set directly (no Noise/ColorRamp nodes - those don't export to GLTF)
- Make new geometry detailed: use bevels, loop cuts, and subdivision for realistic shapes - NOT just plain cubes/cylinders
- NEVER leave any object with the default white material
- Recalculate normals after any mesh modifications
- Use Shade Smooth where appropriate
- IMPORTANT: Before export, you MUST ensure textures are preserved. Add this code block BEFORE the export:

# Fix materials for GLTF export - ensure all use Principled BSDF
for mat in bpy.data.materials:
    if mat.use_nodes:
        for node in mat.node_tree.nodes:
            if node.type == 'BSDF_DIFFUSE' or node.type == 'BSDF_GLOSSY':
                # Already has Principled? Skip
                pass
bpy.ops.file.pack_all()

The export code at the end MUST be exactly:

bpy.ops.file.pack_all()
output_path = "${outputPathEscaped}"
if output_path.endswith('.glb') or output_path.endswith('.gltf'):
    fmt = 'GLB' if output_path.endswith('.glb') else 'GLTF_SEPARATE'
    bpy.ops.export_scene.gltf(filepath=output_path, export_format=fmt, export_image_format='AUTO', export_materials='EXPORT')
elif output_path.endswith('.obj'):
    bpy.ops.wm.obj_export(filepath=output_path)
elif output_path.endswith('.fbx'):
    bpy.ops.export_scene.fbx(filepath=output_path)
elif output_path.endswith('.stl'):
    bpy.ops.export_mesh.stl(filepath=output_path)
print("FABMESH_SUCCESS")

Output ONLY valid Python code.`;
    } else {
      // Normal refine — has previous script
      claudePrompt = `Here is an existing Blender Python script that creates a 3D object:

--- EXISTING SCRIPT ---
${prevScript}
--- END SCRIPT ---

The user wants to MODIFY this object with the following request: "${modification}"

Generate a NEW complete Blender Python script that includes the modification. Keep everything that was good in the original script, and apply the requested changes.

CRITICAL RULES:
- Output ONLY the Python code, no markdown, no backticks, no explanations
- Keep the same overall structure but apply the modifications
- Recalculate normals outward after mesh edits
- Use Shade Smooth on objects
- Apply realistic PBR materials with visible colors (never pure black)
- Ensure all faces have correct normals so nothing appears dark/invisible

The export code at the end MUST be exactly:

output_path = "${outputPathEscaped}"
if output_path.endswith('.glb') or output_path.endswith('.gltf'):
    fmt = 'GLB' if output_path.endswith('.glb') else 'GLTF_SEPARATE'
    bpy.ops.export_scene.gltf(filepath=output_path, export_format=fmt)
elif output_path.endswith('.obj'):
    bpy.ops.wm.obj_export(filepath=output_path)
elif output_path.endswith('.fbx'):
    bpy.ops.export_scene.fbx(filepath=output_path)
elif output_path.endswith('.stl'):
    bpy.ops.export_mesh.stl(filepath=output_path)
print("FABMESH_SUCCESS")

Output ONLY valid Python code.`;
    }

    const claudePath = path.join(process.env.APPDATA || '', 'npm', 'claude.cmd');
    if (!fs.existsSync(claudePath)) {
      return { success: false, step: 'ai', error: 'Claude CLI not found.' };
    }

    let scriptContent;
    try {
      scriptContent = await callClaude(claudePath, aiModel, claudePrompt);
    } catch (err) {
      return { success: false, step: 'ai', error: err.message };
    }

    fs.writeFileSync(scriptPath, scriptContent, 'utf-8');

    try {
      const blenderResult = await runBlenderWithRetry(config, scriptPath, meshPath, scriptContent, claudePath, aiModel);
      const result = { meshPath, meshFilename, scriptPath, scriptFilename, format: ext, size: blenderResult.size, scriptContent };

      const versionData = addVersion(projectName, {
        prompt: `[Refine] ${modification}`,
        scriptContent,
        meshPath: result.meshPath,
        meshFilename: result.meshFilename,
        format: ext
      });

      return { success: true, ...result, versionData };
    } catch (err) {
      return { success: false, step: 'blender', error: err.error || err.message || String(err) };
    }
  } catch (err) {
    return { success: false, step: 'ai', error: `Unexpected: ${err.message}` };
  }
});

// --- Version history handlers ---
ipcMain.handle('get-versions', (event, projectName) => {
  return loadVersions(projectName);
});

ipcMain.handle('revert-to-version', async (event, { projectName, versionNum }) => {
  const data = loadVersions(projectName);
  if (versionNum < 0 || versionNum >= data.versions.length) {
    return { success: false, error: 'Invalid version number' };
  }
  data.currentVersion = versionNum;
  saveVersions(projectName, data);
  const v = data.versions[versionNum];
  return { success: true, meshPath: v.meshPath, meshFile: v.meshFile, format: v.format, versionData: data };
});

ipcMain.handle('list-projects', () => {
  if (!fs.existsSync(HISTORY_DIR)) return [];
  return fs.readdirSync(HISTORY_DIR)
    .filter(d => fs.existsSync(path.join(HISTORY_DIR, d, 'versions.json')))
    .map(d => {
      const data = loadVersions(d);
      return { name: d, versionCount: data.versions.length, currentVersion: data.currentVersion };
    });
});

// --- Construction Mode: 3 build stages ---
ipcMain.handle('generate-build-stages', async (event, { prompt, outputName, engine }) => {
  try {
    const safeName = outputName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const results = [];

    const stagePrompts = [
      { name: 'stage1', label: 'Stage 1: Construction Site', imgPrompt: `construction site foundation of ${prompt}, building materials piles, scaffolding, cleared ground, early construction phase, no building yet, isometric view, white background, 3D render` },
      { name: 'stage2', label: 'Stage 2: Under Construction', imgPrompt: `half-built ${prompt}, walls partially built, wooden frame visible, scaffolding, roof beams without tiles, unfinished building, isometric view, white background, 3D render` },
      { name: 'stage3', label: 'Stage 3: Complete', imgPrompt: `completed finished ${prompt}, full detail, roof tiles, windows doors installed, decorative details, polished building, isometric view, white background, 3D render` }
    ];

    for (let i = 0; i < stagePrompts.length; i++) {
      const stage = stagePrompts[i];
      safeSend('build-stage-progress', { stage: i, total: 3, label: stage.label });

      const timestamp = Date.now();
      const imgDir = path.join(IMAGES_DIR, `${safeName}_${stage.name}_${timestamp}`);
      fs.mkdirSync(imgDir, { recursive: true });

      // Step 1: Generate image via Pollinations
      const imgPath = path.join(imgDir, 'ref_0.png');
      try {
        const https = require('https');
        const encoded = encodeURIComponent(stage.imgPrompt);
        const url = `https://image.pollinations.ai/prompt/${encoded}?model=flux&width=1344&height=1344&nologo=true&enhance=true&seed=${timestamp}`;
        await new Promise((resolve, reject) => {
          const req = https.get(url, { headers: { 'User-Agent': 'FabMesh/1.0' }, timeout: 120000 }, (resp) => {
            if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
              https.get(resp.headers.location, { headers: { 'User-Agent': 'FabMesh/1.0' } }, (r2) => {
                const chunks = []; r2.on('data', c => chunks.push(c)); r2.on('end', () => { fs.writeFileSync(imgPath, Buffer.concat(chunks)); resolve(); }); r2.on('error', reject);
              });
              return;
            }
            const chunks = []; resp.on('data', c => chunks.push(c)); resp.on('end', () => { fs.writeFileSync(imgPath, Buffer.concat(chunks)); resolve(); }); resp.on('error', reject);
          });
          req.on('error', reject);
        });
      } catch (e) {
        results.push({ stage: i, success: false, label: stage.label, error: `Image failed: ${e.message}` });
        continue;
      }

      // Step 2: Convert image to 3D (default: Stable Fast 3D — native PBR textures)
      const meshFilename = `${safeName}_${stage.name}_${timestamp}.glb`;
      const meshPath = path.join(MESHES_DIR, meshFilename);
      let selectedEngine = engine || 'sf3d';
      if (selectedEngine === 'hunyuan') {
        console.warn('[image-to-3d] Hunyuan3D is disabled (license territorial restriction). Falling back to SF3D.');
        selectedEngine = 'sf3d';
      }
      const bridgeScripts = {
        'local':   path.join(__dirname, '..', '..', 'scripts', 'local_triposr_bridge.py'),
        'sf3d':    path.join(__dirname, '..', '..', 'scripts', 'local_sf3d_bridge.py'),
        'triposg': path.join(__dirname, '..', '..', 'scripts', 'local_triposg_bridge.py'),
        'trellis': path.join(__dirname, '..', '..', 'scripts', 'trellis_bridge.py')
      };
      const bridgeScript = bridgeScripts[selectedEngine] || bridgeScripts['sf3d'];
      const argsMap = {
        'local':   [bridgeScript, imgPath, meshPath, '512'],
        'sf3d':    [bridgeScript, imgPath, meshPath, '1024', '-1', 'none'],
        'triposg': [bridgeScript, imgPath, meshPath, '30', '7.0'],
        'trellis': [bridgeScript, imgPath, meshPath, '0.95', '1024']
      };
      const args = argsMap[selectedEngine] || argsMap['sf3d'];

      try {
        await new Promise((resolve, reject) => {
          execFile('python', args, { timeout: 1800000, maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) { reject({ error: error.message, stdout, stderr }); return; }
            if (!fs.existsSync(meshPath)) { reject({ error: 'Mesh not created' }); return; }
            resolve();
          });
        });
        const stats = fs.statSync(meshPath);
        results.push({ stage: i, success: true, label: stage.label, meshPath, meshFilename, format: 'glb', size: stats.size, imagePath: imgPath });
      } catch (err) {
        results.push({ stage: i, success: false, label: stage.label, error: `3D conversion failed: ${err.error || err.message}` });
      }
    }

    return { success: true, stages: results };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// --- Text-to-3D: Step 1 - Generate images ---
// `prompt` is the FULL enriched prompt (user text + style suffix + type suffix)
// that we send to the generator. `userPrompt` is the raw text the user typed,
// WITHOUT any style/type decoration — this is what we persist to prompt.txt so
// that re-opening the project rehydrates the textarea cleanly (no repeated
// "single isolated 3D character, ..." suffixes each time).
ipcMain.handle('generate-images', async (event, { prompt, userPrompt, numImages, projectName, engine, quality, steps, vramFraction }) => {
  try {
    // Parental control: check prompt for blocked content
    const safety = checkPromptSafety(prompt);
    if (!safety.safe) {
      return { success: false, error: safety.reason };
    }
    // Layer 3: AI text classifier (local, no internet)
    const aiSafety = await checkPromptSafetyAI(prompt);
    if (!aiSafety.safe) {
      return { success: false, error: aiSafety.reason };
    }
    const timestamp = Date.now();
    const safeName = (projectName || 'gen').replace(/[^a-zA-Z0-9_-]/g, '_');
    // Group by project name (no timestamp suffix) - all images for same project go in same folder
    const imagesDir = path.join(IMAGES_DIR, safeName);
    fs.mkdirSync(imagesDir, { recursive: true });

    // Save prompt history (append to prompts.json). We keep both the raw
    // user prompt and the enriched one for later inspection / versioning.
    const rawPrompt = (typeof userPrompt === 'string' && userPrompt.trim()) ? userPrompt.trim() : prompt;
    const promptsFile = path.join(imagesDir, 'prompts.json');
    let promptsHistory = [];
    if (fs.existsSync(promptsFile)) {
      try { promptsHistory = JSON.parse(fs.readFileSync(promptsFile, 'utf-8')); } catch(e) {}
    }
    promptsHistory.push({ prompt: rawPrompt, fullPrompt: prompt, timestamp });
    fs.writeFileSync(promptsFile, JSON.stringify(promptsHistory, null, 2));
    // prompt.txt holds the RAW user text so the workspace textarea can be
    // rehydrated without accumulating style/type suffixes on each gen.
    fs.writeFileSync(path.join(imagesDir, 'prompt.txt'), rawPrompt, 'utf-8');

    // Build env with VRAM fraction for PyTorch hard cap + expandable segments allocator.
    const fracVal = (typeof vramFraction === 'number' && vramFraction > 0 && vramFraction <= 1)
      ? vramFraction : 0.95;
    // Persist on main process env so future SDXL server restarts inherit the latest value
    process.env.FABMESH_VRAM_FRACTION = String(fracVal);
    const _prevAlloc = process.env.PYTORCH_CUDA_ALLOC_CONF || '';
    const _allocConf = _prevAlloc.includes('expandable_segments') ? _prevAlloc : (_prevAlloc ? _prevAlloc + ',' : '') + 'expandable_segments:True';
    const _ramLimitMB = process.env.FABMESH_RAM_LIMIT_MB || '';
    const _gpuLimit = process.env.FABMESH_GPU_LIMIT || '';
    const _tempLimit = process.env.FABMESH_TEMP_LIMIT || '';
    const childEnv = {
      ...process.env,
      FABMESH_VRAM_FRACTION: String(fracVal),
      PYTORCH_CUDA_ALLOC_CONF: _allocConf,
      ..._ramLimitMB ? { FABMESH_RAM_LIMIT_MB: _ramLimitMB } : {},
      ..._gpuLimit   ? { FABMESH_GPU_LIMIT:   _gpuLimit   } : {},
      ..._tempLimit  ? { FABMESH_TEMP_LIMIT:  _tempLimit  } : {},
    };

    // LOCAL GPU: Juggernaut XL v9 (recommended, photorealistic SDXL fine-tune)
    if (engine === 'local-flux') {
      const bridgeScript = path.join(__dirname, '..', '..', 'scripts', 'local_juggernaut_bridge.py');
      const stepsClamped = Math.max(4, Math.min(60, parseInt(steps) || 30));
      const result = await new Promise((resolve, reject) => {
        const proc = execFile('python', [bridgeScript, prompt, imagesDir, String(numImages || 4), String(stepsClamped)], {
          timeout: 1800000, maxBuffer: 50 * 1024 * 1024,
          env: childEnv,
        }, (error, stdout, stderr) => {
          if (error) { reject({ error: error.message, stdout, stderr }); return; }
          const imgs = fs.readdirSync(imagesDir).filter(f => /\.png$/i.test(f)).map(f => path.join(imagesDir, f));
          resolve({ images: imgs, stdout });
        });
        proc.stdout.on('data', d => { safeSend('ai3d-progress', d.toString()); });
        proc.stderr?.on('data', d => { safeSend('ai3d-progress', '[stderr] ' + d.toString()); });
      });
      return { success: true, images: result.images };
    }

    // CLOUD: Meshy.ai text-to-image (nano-banana). Uses the user's API key
    // saved in config.json (set via Settings modal). Free tier = CC-BY 4.0.
    if (engine === 'meshy') {
      const cfg = loadConfig();
      const key = (cfg && cfg.meshyApiKey) || '';
      if (!key.trim()) {
        return { success: false, error: 'Meshy.ai API key not configured. Open Settings and paste your key.' };
      }
      const bridgeScript = path.join(__dirname, '..', '..', 'scripts', 'meshy_bridge.py');
      const result = await new Promise((resolve, reject) => {
        const proc = execFile(
          'python',
          [bridgeScript, 'text2image', key, prompt, imagesDir, String(numImages || 1)],
          { timeout: 1800000, maxBuffer: 50 * 1024 * 1024, env: childEnv },
          (error, stdout, stderr) => {
            if (error) { reject({ error: error.message, stdout, stderr }); return; }
            const imgs = fs.readdirSync(imagesDir)
              .filter(f => /^meshy_.*\.png$/i.test(f))
              .map(f => path.join(imagesDir, f));
            resolve({ images: imgs, stdout });
          }
        );
        proc.stdout.on('data', d => { safeSend('ai3d-progress', d.toString()); });
        proc.stderr?.on('data', d => { safeSend('ai3d-progress', '[stderr] ' + d.toString()); });
      });
      return { success: true, images: result.images };
    }

    // LOCAL GPU: Stable Diffusion XL Turbo — REMOVED.
    // SDXL Turbo is distributed under the SAI Non-Commercial Research License,
    // which disqualifies it from our "free AND commercially sellable" rule.
    // Legacy saved projects that still reference engine='local-sd' silently
    // fall back to RealVis XL (local-flux) above.
    if (engine === 'local-sd') {
      console.warn('[generate-images] local-sd (SDXL Turbo) is disabled (non-commercial license).');
      return { success: false, error: 'SDXL Turbo is non-commercial. Please pick RealVis XL or Meshy.ai.' };
    }

    // Pollinations: community service without formal commercial ToS on outputs.
    // Disabled for the Steam release. Legacy projects that still reference
    // engine='pollinations' get a clear error directing them to RealVis or Meshy.
    if (engine === 'pollinations') {
      console.warn('[generate-images] pollinations disabled (no formal commercial ToS on outputs).');
      return { success: false, error: 'Pollinations has been removed. Please pick RealVis XL (local) or Meshy.ai (cloud).' };
    }

    // CLOUD: Pollinations (legacy code path kept for reference; unreachable because
    // the engine='pollinations' case above short-circuits before we get here)
    // Quality 1=Fast, 2=Medium, 3=High (default), 4=Ultra
    const qualityConfig = {
      1: { model: 'turbo',   width: 1024, height: 1024, enhance: false, suffix: '' },
      2: { model: 'flux',    width: 1024, height: 1024, enhance: false, suffix: ', detailed' },
      3: { model: 'flux',    width: 1344, height: 1344, enhance: true,  suffix: ', masterpiece, highly detailed, 8k, sharp focus, professional photography, studio lighting' },
      4: { model: 'flux',    width: 1536, height: 1536, enhance: true,  suffix: ', masterpiece, ultra detailed, 16k, sharp focus, professional photography, studio lighting, perfect composition, award winning, intricate details' },
    };
    const q = qualityConfig[quality || 3] || qualityConfig[3];
    const optimizedPrompt = `${prompt}${q.suffix}, single object centered on plain white background, product shot, no text, no watermark`;
    const total = numImages || 4;

    // PARALLEL: download all images at once to a temp folder, then atomically move
    // This avoids the race where partial images appear in the gallery during generation
    const tempDir = path.join(imagesDir, '.tmp_' + timestamp);
    fs.mkdirSync(tempDir, { recursive: true });

    const downloadOne = async (i) => {
      const seed = timestamp + i;
      const encoded = encodeURIComponent(optimizedPrompt);
      const enhanceParam = q.enhance ? '&enhance=true' : '';
      const url = `https://image.pollinations.ai/prompt/${encoded}?model=${q.model}&width=${q.width}&height=${q.height}&nologo=true${enhanceParam}&seed=${seed}`;
      const tempPath = path.join(tempDir, `ref_${timestamp}_${i}.png`);
      const https = require('https');

      const followGet = (u, depth = 0) => new Promise((resolve, reject) => {
        if (depth > 5) return reject(new Error('Too many redirects'));
        const req = https.get(u, { headers: { 'User-Agent': 'FabMesh/1.0' }, timeout: 180000 }, (resp) => {
          if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
            return followGet(resp.headers.location, depth + 1).then(resolve).catch(reject);
          }
          if (resp.statusCode !== 200) {
            return reject(new Error(`HTTP ${resp.statusCode}`));
          }
          const chunks = [];
          resp.on('data', c => chunks.push(c));
          resp.on('end', () => {
            const buf = Buffer.concat(chunks);
            if (buf.length < 1000) return reject(new Error('Response too small'));
            try {
              fs.writeFileSync(tempPath, buf);
              resolve(tempPath);
            } catch (e) { reject(e); }
          });
          resp.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
      });

      try {
        const path_ok = await followGet(url);
        return { ok: true, path: path_ok, idx: i };
      } catch (e) {
        console.error(`Image ${i} failed:`, e.message);
        return { ok: false, error: e.message, idx: i };
      }
    };

    // Launch all downloads in parallel
    const results = await Promise.all(Array.from({ length: total }, (_, i) => downloadOne(i)));

    // Atomically move successful images from temp to final dir
    const images = [];
    for (const r of results) {
      if (r.ok && fs.existsSync(r.path)) {
        const finalPath = path.join(imagesDir, path.basename(r.path));
        try {
          fs.renameSync(r.path, finalPath);
          images.push(finalPath);
          safeSend('ai3d-progress', `IMAGE_GENERATED:${r.idx}:${finalPath}`);
        } catch (e) {
          console.error('Move failed:', e.message);
        }
      }
    }

    // Cleanup temp dir
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}

    return { success: images.length > 0, images };
  } catch (err) {
    return { success: false, error: err.error || err.message };
  }
});

// --- Image-to-3D: supports TripoSR, Stable Fast 3D, TripoSG, TRELLIS ---
ipcMain.handle('image-to-3d', async (event, { imagePath: _imagePath, outputName, textureSize, engine: _engine, targetFaces, effort, jobId, vramFraction, subdivide }) => {
  let imagePath = _imagePath;
  let engine = _engine;
  try {
    const safeName = outputName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = Date.now();
    if (engine === 'hunyuan') {
      console.warn('[image-to-3d] Hunyuan3D is disabled (license territorial restriction). Falling back to SF3D.');
      engine = 'sf3d';
    }
    const meshFilename = `${safeName}_${engine || 'ai'}_${timestamp}.glb`;
    const meshPath = path.join(MESHES_DIR, meshFilename);
    const bridgeScripts = {
      'local':   path.join(__dirname, '..', '..', 'scripts', 'local_triposr_bridge.py'),
      'sf3d':    path.join(__dirname, '..', '..', 'scripts', 'local_sf3d_bridge.py'),
      'triposg': path.join(__dirname, '..', '..', 'scripts', 'local_triposg_bridge.py'),
      'trellis': path.join(__dirname, '..', '..', 'scripts', 'trellis_bridge.py'),
      'meshy':   path.join(__dirname, '..', '..', 'scripts', 'meshy_bridge.py')
    };
    const bridgeScript = bridgeScripts[engine] || bridgeScripts['sf3d'];

    // SF3D args: <img> <out> <tex_res> <vertex_count> <remesh> <subdivide_levels>
    const sf3dTexRes = String(textureSize || 1024);
    const sf3dVerts = (targetFaces && Number(targetFaces) > 0) ? String(Math.max(500, Number(targetFaces) * 0.5)) : '-1';
    const sf3dRemesh = (targetFaces && Number(targetFaces) > 0) ? 'triangle' : 'none';
    const sf3dSubdivide = String(typeof subdivide === 'number' ? subdivide : 0);

    // Meshy needs its API key as argv[2] — fetched from config.json.
    const meshyApiKey = (loadConfig() || {}).meshyApiKey || '';
    const meshyTargetFaces = (targetFaces && Number(targetFaces) > 0) ? String(Math.min(300000, Number(targetFaces))) : '50000';

    const effortVal = String(effort || 2);
    const argsMap = {
      'local':   [bridgeScript, imagePath, meshPath, '512'],
      'sf3d':    [bridgeScript, imagePath, meshPath, sf3dTexRes, sf3dVerts, sf3dRemesh, sf3dSubdivide],
      'triposg': [bridgeScript, imagePath, meshPath, '30', '7.0'],
      'trellis': [bridgeScript, imagePath, meshPath, '0.95', String(textureSize || 1024)],
      'meshy':   [bridgeScript, 'image2mesh', meshyApiKey, imagePath, meshPath, meshyTargetFaces, sf3dTexRes],
    };
    const args = argsMap[engine] || argsMap['sf3d'];

    // Meshy requires an API key — fail fast with a clear message rather than
    // waiting for the Python bridge to explode on an empty argv.
    if (engine === 'meshy' && !meshyApiKey.trim()) {
      return { success: false, error: 'Meshy.ai API key not configured. Open Settings and paste your key.' };
    }

    // Fix truncated image path (known bug: last char gets cut)
    if (!fs.existsSync(imagePath)) {
      const fixes = ['g', 'ng', 'png', 'pg', 'jpg', 'peg'];
      for (const fix of fixes) {
        if (fs.existsSync(imagePath + fix)) {
          imagePath = imagePath + fix;
          break;
        }
      }
      if (!fs.existsSync(imagePath)) {
        return { success: false, error: `Image not found: ${imagePath}` };
      }
    }
    // Rebuild args with fixed path
    const fixedArgsMap = {
      'local':   [bridgeScript, imagePath, meshPath, '512'],
      'sf3d':    [bridgeScript, imagePath, meshPath, sf3dTexRes, sf3dVerts, sf3dRemesh, sf3dSubdivide],
      'triposg': [bridgeScript, imagePath, meshPath, '30', '7.0'],
      'trellis': [bridgeScript, imagePath, meshPath, '0.95', String(textureSize || 1024)],
      'meshy':   [bridgeScript, 'image2mesh', meshyApiKey, imagePath, meshPath, meshyTargetFaces, sf3dTexRes],
    };
    const fixedArgs = fixedArgsMap[engine] || fixedArgsMap['sf3d'];

    console.log('IMAGE-TO-3D fixedArgs:', JSON.stringify(fixedArgs));
    fs.writeFileSync(path.join(__dirname, '..', '..', 'last_error.log'), `imagePath: ${imagePath}\nfixedArgs: ${JSON.stringify(fixedArgs)}\n`);
    // VRAM fraction enforced in Python via torch.cuda.set_per_process_memory_fraction.
    const fraction = (typeof vramFraction === 'number' && vramFraction > 0 && vramFraction <= 1)
      ? vramFraction : 0.95;
    // Persist on main process env so future SDXL server restarts inherit the latest value
    process.env.FABMESH_VRAM_FRACTION = String(fraction);
    const prevAlloc = process.env.PYTORCH_CUDA_ALLOC_CONF || '';
    const allocConf = prevAlloc.includes('expandable_segments') ? prevAlloc : (prevAlloc ? prevAlloc + ',' : '') + 'expandable_segments:True';
    const _ramLimitMB2 = process.env.FABMESH_RAM_LIMIT_MB || '';
    const _gpuLimit2   = process.env.FABMESH_GPU_LIMIT   || '';
    const _tempLimit2  = process.env.FABMESH_TEMP_LIMIT  || '';
    const env = {
      ...process.env,
      // Unbuffered stdout so LOCAL_TRIPOSR_PROGRESS markers arrive in
      // real time (not buffered in 4 KB chunks by the Python runtime).
      PYTHONUNBUFFERED: '1',
      FABMESH_VRAM_FRACTION: String(fraction),
      PYTORCH_CUDA_ALLOC_CONF: allocConf,
      ..._ramLimitMB2 ? { FABMESH_RAM_LIMIT_MB: _ramLimitMB2 } : {},
      ..._gpuLimit2   ? { FABMESH_GPU_LIMIT:   _gpuLimit2   } : {},
      ..._tempLimit2  ? { FABMESH_TEMP_LIMIT:  _tempLimit2  } : {},
    };
    log.info('main', `image-to-3d: launching with PYTORCH_CUDA_ALLOC_CONF=${allocConf}`);
    const result = await new Promise((resolve, reject) => {
      let stdoutBuf = '';
      let stderrBuf = '';
      let lastSent = 0;
      const proc = execFile('python', fixedArgs, {
        timeout: 1800000,
        maxBuffer: 50 * 1024 * 1024,
        env,
      }, (error, stdout, stderr) => {
        if (jobId) activeProcs.delete(jobId);
        if (error) { reject({ error: error.message, stdout, stderr }); return; }
        if (!fs.existsSync(meshPath)) { reject({ error: 'GLB not created (Python did not produce output)', stdout, stderr }); return; }
        const stats = fs.statSync(meshPath);
        // Save source image path for later display in viewer
        try { fs.writeFileSync(meshPath + '.source', imagePath, 'utf-8'); } catch(e) {}
        // Parse mesh stats from bridge stdout (LOCAL_SF3D_STATS: verts=N faces=N tex=N)
        let meshVerts = null, meshFaces = null;
        const statsMatch = (stdout || '').match(/STATS:\s*verts=(\d+)\s*faces=(\d+)/);
        if (statsMatch) {
          meshVerts = parseInt(statsMatch[1]);
          meshFaces = parseInt(statsMatch[2]);
          log.info('main', `image-to-3d OK: ${meshVerts} verts, ${meshFaces} faces (${(stats.size/1024).toFixed(0)} KB)`);
        }
        resolve({ meshPath, meshFilename, format: 'glb', size: stats.size, sourceImage: imagePath, stdout, meshVerts, meshFaces });
      });
      if (jobId) activeProcs.set(jobId, proc);
      const flushStdout = () => {
        if (stdoutBuf) {
          safeSend('ai3d-progress', stdoutBuf);
          stdoutBuf = '';
          lastSent = Date.now();
        }
      };
      proc.stdout?.on('data', d => {
        stdoutBuf += d.toString();
        const now = Date.now();
        if (now - lastSent > 200) flushStdout();
      });
      proc.stdout?.on('end', flushStdout);
      // Forward stderr too - Python errors were silently ignored!
      proc.stderr?.on('data', d => {
        const s = d.toString();
        stderrBuf += s;
        safeSend('ai3d-progress', '[stderr] ' + s);
      });
      proc.on('error', err => {
        console.error('image-to-3d process error:', err);
        reject({ error: err.message, stdout: stdoutBuf, stderr: stderrBuf });
      });
    });

    return { success: true, ...result };
  } catch (err) {
    const errMsg = err.error || err.message || String(err);
    // Log to the structured logger so `fabmesh.log` has useful context.
    // Extract the last meaningful Python error line from stderr/stdout for
    // a concise summary — the full dump goes to last_error.log.
    const combined = (err.stdout || '') + '\n' + (err.stderr || '');
    const pyErrorLine = combined.split(/\r?\n/).reverse()
      .find(l => /Error|Exception|CUDA|OOM|killed|Traceback/i.test(l.trim())) || '';
    log.error('main', `image-to-3d FAILED: ${pyErrorLine || errMsg}`);
    // Overwrite (not append) so last_error.log doesn't grow unboundedly.
    try {
      fs.writeFileSync(
        path.join(__dirname, '..', '..', 'last_error.log'),
        `[${new Date().toISOString()}]\nERROR: ${errMsg}\n\n=== PYTHON STDOUT (last 100 lines) ===\n${(err.stdout || '').split('\n').slice(-100).join('\n')}\n\n=== PYTHON STDERR (last 50 lines) ===\n${(err.stderr || '').split('\n').slice(-50).join('\n')}\n`
      );
    } catch (e) { /* disk full / readonly */ }
    return { success: false, error: errMsg, stdout: err.stdout, stderr: err.stderr };
  }
});

// --- Legacy: TRELLIS only (kept for compatibility) ---
ipcMain.handle('image-to-3d-trellis', async (event, { imagePath, outputName, textureSize }) => {
  try {
    const safeName = outputName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = Date.now();
    const meshFilename = `${safeName}_${timestamp}.glb`;
    const meshPath = path.join(MESHES_DIR, meshFilename);
    const bridgeScript = path.join(__dirname, '..', '..', 'scripts', 'trellis_bridge.py');

    const result = await new Promise((resolve, reject) => {
      const proc = execFile('python', [bridgeScript, imagePath, meshPath, String(textureSize || 1024)], {
        timeout: 1800000,
        maxBuffer: 50 * 1024 * 1024
      }, (error, stdout, stderr) => {
        if (error) { reject({ error: error.message, stdout, stderr }); return; }
        if (!fs.existsSync(meshPath)) { reject({ error: 'GLB not created', stdout, stderr }); return; }
        const stats = fs.statSync(meshPath);
        resolve({ meshPath, meshFilename, format: 'glb', size: stats.size, stdout });
      });
      proc.stdout.on('data', d => { safeSend('ai3d-progress', d.toString()); });
    });

    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.error || err.message, stdout: err.stdout, stderr: err.stderr };
  }
});

// --- TRELLIS Image-to-3D via Hugging Face ---
ipcMain.handle('generate-from-image', async (event, { imagePath, outputName }) => {
  try {
    const safeName = outputName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = Date.now();
    const meshFilename = `${safeName}_${timestamp}.glb`;
    const meshPath = path.join(MESHES_DIR, meshFilename);
    const bridgeScript = path.join(__dirname, '..', '..', 'scripts', 'trellis_bridge.py');

    const result = await new Promise((resolve, reject) => {
      execFile('python', [bridgeScript, imagePath, meshPath], {
        timeout: 300000,
        maxBuffer: 50 * 1024 * 1024
      }, (error, stdout, stderr) => {
        if (error) {
          reject({ error: error.message, stdout, stderr });
          return;
        }
        if (!fs.existsSync(meshPath)) {
          reject({ error: 'GLB file was not created', stdout, stderr });
          return;
        }
        const stats = fs.statSync(meshPath);
        resolve({
          meshPath,
          meshFilename,
          format: 'glb',
          size: stats.size,
          stdout
        });
      });
    });

    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.error || err.message || String(err), stdout: err.stdout, stderr: err.stderr };
  }
});

// --- IPC Handlers ---

ipcMain.handle('import-mesh', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import 3D Mesh',
    filters: [
      { name: '3D Meshes', extensions: ['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return null;
  const srcPath = result.filePaths[0];
  return copyMeshToMeshes(srcPath);
});

ipcMain.handle('copy-mesh-to-project', (event, srcPath) => {
  return copyMeshToMeshes(srcPath);
});

function copyMeshToMeshes(srcPath) {
  const ext = path.extname(srcPath).slice(1).toLowerCase();
  const baseName = path.basename(srcPath, path.extname(srcPath)).replace(/[^a-zA-Z0-9_-]/g, '_');
  const timestamp = Date.now();
  const filename = `${baseName}_${timestamp}.${ext}`;
  const destPath = path.join(MESHES_DIR, filename);
  fs.copyFileSync(srcPath, destPath);
  const stats = fs.statSync(destPath);
  return {
    meshPath: destPath,
    meshFilename: filename,
    format: ext,
    size: stats.size
  };
}

ipcMain.handle('create-project-from-mesh', (event, { projectName, meshPath, meshFilename, format }) => {
  const data = loadVersions(projectName);
  if (data.versions.length > 0) return data; // already exists

  // Copy mesh to history
  const histMeshName = `v0_${meshFilename}`;
  const histMeshPath = path.join(getProjectDir(projectName), histMeshName);
  fs.copyFileSync(meshPath, histMeshPath);

  // Create a placeholder script that just describes the import
  const histScriptName = `v0_script.py`;
  const histScriptPath = path.join(getProjectDir(projectName), histScriptName);
  fs.writeFileSync(histScriptPath, `# Imported mesh: ${meshFilename}\n# No generation script available - this was imported from an external file.\n`, 'utf-8');

  data.versions.push({
    version: 0,
    prompt: `[Imported] ${meshFilename}`,
    scriptFile: histScriptName,
    meshFile: histMeshName,
    meshPath: histMeshPath,
    format: format || 'glb',
    imported: true,
    timestamp: Date.now()
  });
  data.currentVersion = 0;
  saveVersions(projectName, data);
  return data;
});

ipcMain.handle('get-config', () => loadConfig());

// Patch-merge into config.json. Caller passes e.g. {meshyApiKey: 'msy_...'}.
// Only whitelisted fields are accepted to avoid the renderer corrupting arbitrary keys.
ipcMain.handle('set-config', (_event, patch) => {
  if (!patch || typeof patch !== 'object') return { success: false, error: 'invalid patch' };
  const config = loadConfig();
  const ALLOWED = new Set(['blenderPath', 'meshyApiKey']);
  for (const [k, v] of Object.entries(patch)) {
    if (ALLOWED.has(k)) config[k] = v;
  }
  saveConfig(config);
  return { success: true };
});

// Validate a Meshy.ai API key by hitting a cheap authenticated endpoint.
// Returns { ok: true } on success, { ok: false, error } otherwise.
ipcMain.handle('test-meshy-key', async (_event, apiKey) => {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 8) {
    return { ok: false, error: 'API key looks empty or too short' };
  }
  return await new Promise((resolve) => {
    const https = require('https');
    const req = https.request({
      method: 'GET',
      hostname: 'api.meshy.ai',
      // This endpoint exists and requires auth — any 2xx means the key is valid.
      // If the endpoint name changes, we simply fall back to checking the HTTP code.
      path: '/openapi/v1/text-to-image?page_size=1',
      headers: {
        'Authorization': `Bearer ${apiKey.trim()}`,
        'Accept': 'application/json',
      },
      timeout: 10000,
    }, (resp) => {
      const code = resp.statusCode || 0;
      let body = '';
      resp.on('data', (c) => { body += c.toString('utf-8'); });
      resp.on('end', () => {
        if (code >= 200 && code < 300) return resolve({ ok: true });
        if (code === 401 || code === 403) return resolve({ ok: false, error: `Meshy rejected the key (HTTP ${code})` });
        return resolve({ ok: false, error: `Meshy returned HTTP ${code}: ${body.slice(0, 200)}` });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timed out contacting Meshy.ai' }); });
    req.on('error', (err) => resolve({ ok: false, error: `Network error: ${err.message}` }));
    req.end();
  });
});

// Connect FabMesh to Claude Desktop by writing the MCP server config into
// Claude Desktop's settings file (%APPDATA%\Claude\claude_desktop_config.json).
// This is a one-click operation: the user clicks "Connect to Claude Desktop"
// in FabMesh Settings, and Claude Desktop discovers FabMesh's MCP tools
// (generate_image, generate_mesh, generate_rig, batch_pipeline) on next restart.
ipcMain.handle('connect-claude-desktop', async () => {
  try {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const claudeDir = path.join(appData, 'Claude');
    const configPath = path.join(claudeDir, 'claude_desktop_config.json');
    const mcpServerScript = path.join(__dirname, '..', '..', 'scripts', 'mcp_server.py').replace(/\\/g, '\\\\');
    const projectRoot = path.join(__dirname, '..', '..').replace(/\\/g, '\\\\');

    // Read existing config or start fresh
    let config = {};
    if (fs.existsSync(configPath)) {
      try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch (e) {}
    }
    if (!config.mcpServers) config.mcpServers = {};

    // Add/update FabMesh MCP server entry
    config.mcpServers.fabmesh = {
      command: 'python',
      args: [mcpServerScript],
      cwd: projectRoot,
    };

    // Write back
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    log.info('main', `Claude Desktop config written to ${configPath}`);
    return { success: true, configPath };
  } catch (e) {
    log.error('main', `connect-claude-desktop failed: ${e.message}`);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('disconnect-claude-desktop', async () => {
  try {
    // Remove from Claude Desktop config
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const configPath = path.join(appData, 'Claude', 'claude_desktop_config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.mcpServers && config.mcpServers.fabmesh) {
        delete config.mcpServers.fabmesh;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
        log.info('main', 'Removed FabMesh from Claude Desktop config');
      }
    }
    // Also remove the fabmesh entry from the local .claude/mcp.json
    // (DON'T delete the whole file — it may contain other MCP servers)
    const localMcp = path.join(__dirname, '..', '..', '.claude', 'mcp.json');
    if (fs.existsSync(localMcp)) {
      try {
        const localConfig = JSON.parse(fs.readFileSync(localMcp, 'utf-8'));
        if (localConfig.mcpServers && localConfig.mcpServers.fabmesh) {
          delete localConfig.mcpServers.fabmesh;
          fs.writeFileSync(localMcp, JSON.stringify(localConfig, null, 2), 'utf-8');
          log.info('main', 'Removed fabmesh from local .claude/mcp.json');
        }
      } catch (e) {
        log.error('main', 'Failed to update local .claude/mcp.json: ' + e.message);
      }
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('check-claude-desktop', async () => {
  try {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const configPath = path.join(appData, 'Claude', 'claude_desktop_config.json');
    if (!fs.existsSync(configPath)) return { connected: false };
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const hasFabmesh = !!(config.mcpServers && config.mcpServers.fabmesh);
    return { connected: hasFabmesh };
  } catch (e) {
    return { connected: false };
  }
});

ipcMain.handle('set-blender-path', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Blender executable',
    filters: [{ name: 'Blender', extensions: ['exe'] }],
    properties: ['openFile']
  });
  if (!result.canceled && result.filePaths.length > 0) {
    const config = loadConfig();
    config.blenderPath = result.filePaths[0];
    saveConfig(config);
    return config.blenderPath;
  }
  return null;
});

// Open a mesh file in Blender (foreground GUI). Used by the workspace
// "Open in Blender" / "Edit in Blender" buttons.
ipcMain.handle('open-in-blender', async (event, { meshPath }) => {
  try {
    if (!meshPath || !fs.existsSync(meshPath)) {
      return { success: false, error: 'Mesh file not found' };
    }
    if (!isPathAllowed(meshPath)) {
      return { success: false, error: 'Path not allowed' };
    }
    const config = loadConfig();
    if (!config.blenderPath || !fs.existsSync(config.blenderPath)) {
      return { success: false, error: 'Blender path not configured (Settings)' };
    }
    // Build a tiny Python launcher that imports the mesh and opens the GUI
    const ext = path.extname(meshPath).slice(1).toLowerCase();
    const importLine = {
      'glb':  `bpy.ops.import_scene.gltf(filepath=${JSON.stringify(meshPath)})`,
      'gltf': `bpy.ops.import_scene.gltf(filepath=${JSON.stringify(meshPath)})`,
      'fbx':  `bpy.ops.import_scene.fbx(filepath=${JSON.stringify(meshPath)})`,
      'obj':  `bpy.ops.wm.obj_import(filepath=${JSON.stringify(meshPath)})`,
      'stl':  `bpy.ops.import_mesh.stl(filepath=${JSON.stringify(meshPath)})`,
      'ply':  `bpy.ops.import_mesh.ply(filepath=${JSON.stringify(meshPath)})`,
    }[ext];
    if (!importLine) return { success: false, error: 'Unsupported mesh format: ' + ext };
    const script = `import bpy
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
${importLine}
`;
    const tmpScript = path.join(SCRIPTS_DIR, `_open_blender_${Date.now()}.py`);
    fs.writeFileSync(tmpScript, script, 'utf-8');
    // Spawn Blender in foreground (GUI mode), don't wait for it to close
    const proc = spawn(config.blenderPath, ['--python', tmpScript], {
      detached: true,
      stdio: 'ignore',
    });
    proc.unref();
    // Cleanup the script file after a short delay (Blender has loaded it by then)
    setTimeout(() => { try { fs.unlinkSync(tmpScript); } catch (e) {} }, 5000);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('run-blender-script', async (event, { scriptContent, outputName, format }) => {
  const config = loadConfig();
  if (!config.blenderPath) {
    throw new Error('Blender path not configured. Please set it in settings.');
  }

  const ext = format || 'glb';
  const safeName = outputName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const timestamp = Date.now();
  const meshFilename = `${safeName}_${timestamp}.${ext}`;
  const scriptFilename = `${safeName}_${timestamp}.py`;
  const meshPath = path.join(MESHES_DIR, meshFilename);
  const scriptPath = path.join(SCRIPTS_DIR, scriptFilename);

  // Inject the output path into the script
  const fullScript = scriptContent.replace(/__OUTPUT_PATH__/g, meshPath.replace(/\\/g, '/'));
  fs.writeFileSync(scriptPath, fullScript, 'utf-8');

  return new Promise((resolve, reject) => {
    const args = ['--background', '--python', scriptPath];
    const proc = execFile(config.blenderPath, args, {
      timeout: 120000,
      maxBuffer: 50 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        reject({ error: error.message, stdout, stderr });
        return;
      }
      if (!fs.existsSync(meshPath)) {
        reject({ error: 'Mesh file was not created', stdout, stderr });
        return;
      }
      const stats = fs.statSync(meshPath);
      resolve({
        meshPath: meshPath,
        meshFilename,
        scriptPath,
        scriptFilename,
        format: ext,
        size: stats.size,
        stdout,
        stderr
      });
    });
  });
});

ipcMain.handle('list-meshes', async () => {
  if (!fs.existsSync(MESHES_DIR)) return [];
  const fsp = fs.promises;
  let files;
  try { files = await fsp.readdir(MESHES_DIR); } catch (e) { return []; }
  // Filter and stat in parallel — was sequential statSync which blocks main
  // thread on slow disks / NAS / Windows Defender scans.
  const candidates = files.filter(f => /\.(glb|gltf|obj|fbx|stl|ply)$/i.test(f));
  const results = await Promise.all(candidates.map(async (f) => {
    const fullPath = path.join(MESHES_DIR, f);
    let stats;
    try { stats = await fsp.stat(fullPath); } catch (e) { return null; }
    const thumbPath = path.join(MESHES_DIR, f.replace(/\.[^.]+$/, '_thumb.png'));
    const sourcePath = fullPath + '.source';
    const [thumbExists, source] = await Promise.all([
      fsp.access(thumbPath).then(() => true).catch(() => false),
      fsp.readFile(sourcePath, 'utf-8').then(s => s.trim()).catch(() => null),
    ]);
    return {
      filename: f,
      path: fullPath,
      size: stats.size,
      created: stats.birthtime,
      format: path.extname(f).slice(1).toUpperCase(),
      thumb: thumbExists ? 'file:///' + thumbPath.replace(/\\/g, '/') : null,
      sourceImage: source
    };
  }));
  return results
    .filter(Boolean)
    .sort((a, b) => new Date(b.created) - new Date(a.created));
});

ipcMain.handle('get-mesh-path', (event, filename) => {
  return path.join(MESHES_DIR, filename);
});

ipcMain.handle('delete-mesh', (event, filename) => {
  // Delete from meshes/
  const meshPath = path.join(MESHES_DIR, filename);
  if (fs.existsSync(meshPath)) {
    fs.unlinkSync(meshPath);
  }

  // Also delete from version history if it exists
  const projName = filename.replace(/\.[^.]+$/, '').replace(/_\d+$/, '');
  const projDir = path.join(HISTORY_DIR, projName);
  if (fs.existsSync(path.join(projDir, 'versions.json'))) {
    const data = loadVersions(projName);
    // Find matching version by mesh filename
    const vIdx = data.versions.findIndex(v => {
      const vMeshBase = v.meshFile.replace(/^v\d+_/, '');
      return filename === vMeshBase || filename.endsWith(vMeshBase);
    });
    if (vIdx >= 0) {
      const v = data.versions[vIdx];
      // Delete history mesh file
      const histMesh = path.join(projDir, v.meshFile);
      if (fs.existsSync(histMesh)) fs.unlinkSync(histMesh);
      // Delete history script file
      const histScript = path.join(projDir, v.scriptFile);
      if (fs.existsSync(histScript)) fs.unlinkSync(histScript);
      // Remove from versions array
      data.versions.splice(vIdx, 1);
      // Renumber remaining versions
      data.versions.forEach((ver, i) => ver.version = i);
      // Adjust currentVersion
      if (data.versions.length === 0) {
        data.currentVersion = -1;
        // Remove the whole project dir if empty
        try { fs.unlinkSync(path.join(projDir, 'versions.json')); fs.rmdirSync(projDir); } catch(e) {}
      } else {
        if (data.currentVersion >= data.versions.length) data.currentVersion = data.versions.length - 1;
        else if (data.currentVersion > vIdx) data.currentVersion--;
        saveVersions(projName, data);
      }
    }
  }

  return true;
});

ipcMain.handle('import-image', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select an image',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// Security: only allow deletion inside managed directories
function isPathAllowed(p) {
  const real = path.resolve(p);
  const allowed = [MESHES_DIR, IMAGES_DIR, SCRIPTS_DIR, HISTORY_DIR].map(d => path.resolve(d));
  return allowed.some(d => real === d || real.startsWith(d + path.sep));
}

// Delete an entire project: image folders matching the name, all meshes
// derived from it, and the version history folder.
ipcMain.handle('delete-project', (event, { projectName }) => {
  if (!projectName) return { ok: false, error: 'projectName required' };
  let removed = { folders: 0, meshes: 0, history: 0 };
  // 1) Image folders: any folder under IMAGES_DIR named exactly projectName or projectName_<digits>
  try {
    if (fs.existsSync(IMAGES_DIR)) {
      const re = new RegExp('^' + projectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(_\\d+)?$');
      for (const entry of fs.readdirSync(IMAGES_DIR)) {
        const full = path.join(IMAGES_DIR, entry);
        if (re.test(entry) && fs.statSync(full).isDirectory()) {
          fs.rmSync(full, { recursive: true, force: true });
          removed.folders++;
        }
      }
    }
  } catch (e) { console.warn('delete-project: image folders failed:', e.message); }
  // 2) Mesh files: any file in MESHES_DIR whose base name starts with projectName_
  try {
    if (fs.existsSync(MESHES_DIR)) {
      const prefix = projectName + '_';
      for (const entry of fs.readdirSync(MESHES_DIR)) {
        if (entry === projectName || entry.startsWith(prefix) || entry.startsWith(projectName + '.')) {
          try { fs.unlinkSync(path.join(MESHES_DIR, entry)); removed.meshes++; } catch (e) {}
        }
      }
    }
  } catch (e) { console.warn('delete-project: meshes failed:', e.message); }
  // 3) History folder
  try {
    const histDir = path.join(HISTORY_DIR, projectName);
    if (fs.existsSync(histDir)) {
      fs.rmSync(histDir, { recursive: true, force: true });
      removed.history++;
    }
  } catch (e) { console.warn('delete-project: history failed:', e.message); }
  return { ok: true, removed };
});

ipcMain.handle('delete-file', (event, filePath) => {
  if (!isPathAllowed(filePath)) {
    console.warn('delete-file: blocked path outside allowed dirs:', filePath);
    return false;
  }
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
});

ipcMain.handle('delete-image-folder', (event, folderPath) => {
  if (!isPathAllowed(folderPath)) {
    console.warn('delete-image-folder: blocked path outside allowed dirs:', folderPath);
    return false;
  }
  if (fs.existsSync(folderPath)) {
    fs.rmSync(folderPath, { recursive: true, force: true });
    return true;
  }
  return false;
});

ipcMain.handle('open-meshes-folder', () => {
  shell.openPath(MESHES_DIR);
});

ipcMain.handle('open-images-folder', () => {
  shell.openPath(IMAGES_DIR);
});

ipcMain.handle('list-image-folders', () => {
  if (!fs.existsSync(IMAGES_DIR)) return [];
  return fs.readdirSync(IMAGES_DIR)
    .filter(d => fs.statSync(path.join(IMAGES_DIR, d)).isDirectory())
    .map(d => {
      const dir = path.join(IMAGES_DIR, d);
      const imgs = fs.readdirSync(dir)
        .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
        // Exclude debug/auxiliary files (masks, temp files)
        .filter(f => !f.includes('_mask') && !f.startsWith('.') && !f.startsWith('_'))
        .map(f => {
          const fp = path.join(dir, f);
          const st = fs.statSync(fp);
          return { path: fp, created: st.birthtime, mtime: st.mtime, size: st.size };
        })
        .sort((a, b) => new Date(b.created) - new Date(a.created));
      const promptFile = path.join(dir, 'prompt.txt');
      const prompt = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf-8').trim() : '';
      // Get latest folder mtime from latest image
      const latestTime = imgs.length > 0 ? imgs[0].created : fs.statSync(dir).birthtime;
      return {
        name: d,
        path: dir,
        images: imgs.map(i => i.path),
        imagesData: imgs,
        count: imgs.length,
        created: latestTime,
        prompt
      };
    })
    .sort((a, b) => new Date(b.created) - new Date(a.created));
});

ipcMain.handle('get-mesh-local-url', (event, filePath) => {
  if (!fs.existsSync(filePath)) return null;
  // Return file:// URL for direct loading by Three.js loaders
  return 'file:///' + filePath.replace(/\\/g, '/');
});

ipcMain.handle('read-mesh-file', (event, filePath) => {
  if (!fs.existsSync(filePath)) return null;
  const buffer = fs.readFileSync(filePath);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
});

ipcMain.handle('export-mesh', async (event, { sourcePath, targetFormat, customName, outputPath: customOutputPath }) => {
  const config = loadConfig();
  if (!config.blenderPath) throw new Error('Blender path not configured');

  // Validate inputs against injection
  const validFormats = ['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply', 'fbx_unreal'];
  if (!validFormats.includes(targetFormat)) throw new Error('Invalid target format: ' + targetFormat);
  if (!isPathAllowed(sourcePath)) throw new Error('Source path not allowed');
  // For Unreal export the actual file extension is .fbx
  const realFormat = targetFormat === 'fbx_unreal' ? 'fbx' : targetFormat;
  const isUnreal = targetFormat === 'fbx_unreal';

  // Resolve the destination path
  let outputPath;
  if (customOutputPath) {
    outputPath = customOutputPath;
  } else {
    let baseName;
    if (customName) {
      baseName = customName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    } else {
      baseName = path.basename(sourcePath, path.extname(sourcePath)).replace(/[^a-zA-Z0-9_-]/g, '_');
    }
    outputPath = path.join(MESHES_DIR, `${baseName}.${realFormat}`);
  }
  try { fs.mkdirSync(path.dirname(outputPath), { recursive: true }); } catch (e) {}

  const exportScript = `
import bpy
import sys

# Clear scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# Import
src = "${sourcePath.replace(/\\/g, '/')}"
ext = src.rsplit('.', 1)[-1].lower()
if ext in ('glb', 'gltf'):
    bpy.ops.import_scene.gltf(filepath=src)
elif ext == 'obj':
    bpy.ops.wm.obj_import(filepath=src)
elif ext == 'fbx':
    bpy.ops.import_scene.fbx(filepath=src)
elif ext == 'stl':
    bpy.ops.import_mesh.stl(filepath=src)

# -------------------------------------------------------------------------
# GLB import packs textures as in-memory bpy.data.images, but Blender's FBX
# exporter with embed_textures=True only works reliably if each image has a
# real filepath on disk. We save every image to a temp folder and assign
# the filepath, so the exporter can read them back.
#
# Extra robustness for sources that are themselves broken FBXs: we try to
# reload zero-sized images from their declared filepath, and skip images
# whose filepath points to a missing .fbm sidecar.
# -------------------------------------------------------------------------
import os, tempfile
tex_tmp_dir = os.path.join(tempfile.gettempdir(), "fabmesh_export_tex_" + str(os.getpid()))
os.makedirs(tex_tmp_dir, exist_ok=True)
saved = 0
broken = 0
for img in list(bpy.data.images):
    if img is None or img.type != 'IMAGE':
        continue
    # If the image is 0x0 (e.g. came from a broken FBX referencing a missing
    # .fbm folder), try to reload from its filepath. If that fails too, drop
    # it so it doesn't confuse the exporter later.
    if img.size[0] == 0 or img.size[1] == 0:
        try:
            img.reload()
        except Exception:
            pass
        if img.size[0] == 0 or img.size[1] == 0:
            print(f"EXPORT: skipping broken 0x0 image '{img.name}' (filepath='{img.filepath_raw}')")
            try: bpy.data.images.remove(img)
            except Exception: pass
            broken += 1
            continue
    safe_name = "".join(c if c.isalnum() or c in "._-" else "_" for c in (img.name or "tex"))
    if not safe_name.lower().endswith(('.png', '.jpg', '.jpeg', '.tga', '.bmp')):
        safe_name += ".png"
    target = os.path.join(tex_tmp_dir, safe_name)
    try:
        img.filepath_raw = target
        img.file_format = 'PNG'
        img.save()
        # Re-pack so the image lives in the .blend AND has a real filepath
        try: img.pack()
        except Exception: pass
        saved += 1
        print(f"EXPORT: saved image '{img.name}' -> {target}")
    except Exception as e:
        print(f"EXPORT: could not save image '{img.name}': {e}")
print(f"EXPORT: saved {saved} image(s), dropped {broken} broken, temp={tex_tmp_dir}")

if saved == 0:
    print("EXPORT: WARNING — no textures in source mesh, FBX will have black materials")

try:
    bpy.ops.file.pack_all()
    print("EXPORT: pack_all() ok")
except Exception as e:
    print("EXPORT: pack_all() failed: " + str(e))

# -------------------------------------------------------------------------
# Auto-generate Normal + Roughness + Metalness from the baseColor texture.
# The 3D engines (TripoSR, Trellis 2) only produce a diffuse/albedo map, so
# Unreal's Material_0 ends up with no normal/roughness connected → characters
# look flat or black depending on lighting. We synthesise:
#   * Normal map via a height-to-normal Sobel pass on the baseColor luminance
#   * Roughness map = 1.0 - clamped_luminance (dark = rough, bright = smooth)
#   * Metalness map = solid black (non-metal — correct for organic chars)
# These textures are created as packed in-memory Blender images so FBX
# export's embed_textures=True will bake them into the .fbx.
# -------------------------------------------------------------------------
import math
def _find_base_color_image(mat):
    if not mat or not mat.use_nodes or not mat.node_tree:
        return None, None
    nt = mat.node_tree
    for n in nt.nodes:
        if n.type == 'BSDF_PRINCIPLED':
            bc_input = n.inputs.get('Base Color')
            if bc_input and bc_input.is_linked:
                src = bc_input.links[0].from_node
                if src.type == 'TEX_IMAGE' and src.image:
                    return n, src.image
    return None, None

def _luminance_and_size(img, max_dim=256):
    # Downsample to max_dim so the pure-Python pixel loops below finish in
    # a few seconds instead of minutes. Derived PBR maps don't need higher.
    w, h = img.size
    scale = 1.0
    if max(w, h) > max_dim:
        scale = max_dim / max(w, h)
        nw = max(8, int(w * scale))
        nh = max(8, int(h * scale))
    else:
        nw, nh = w, h
    px = list(img.pixels[:])
    lum = [0.0] * (nw * nh)
    for ny in range(nh):
        sy = int(ny / scale) if scale < 1.0 else ny
        if sy >= h: sy = h - 1
        row_out = ny * nw
        row_src = sy * w * 4
        for nx in range(nw):
            sx = int(nx / scale) if scale < 1.0 else nx
            if sx >= w: sx = w - 1
            i = row_src + sx * 4
            lum[row_out + nx] = 0.2126*px[i] + 0.7152*px[i+1] + 0.0722*px[i+2]
    return lum, nw, nh

def _make_image(name, w, h, pixels_rgba):
    img = bpy.data.images.new(name, width=w, height=h, alpha=False, float_buffer=False)
    img.pixels = pixels_rgba
    # Save to the same temp dir as the source textures so the FBX exporter
    # can find a real file to copy/embed (generated-only images are skipped
    # by export_scene.fbx's embed_textures=True path).
    try:
        safe = name + ".png"
        target = os.path.join(tex_tmp_dir, safe)
        img.filepath_raw = target
        img.file_format = 'PNG'
        img.save()
        img.pack()
    except Exception as e:
        print(f"EXPORT: could not save generated image '{name}': {e}")
    return img

def _generate_normal(lum, w, h, strength=3.0):
    # Sobel-ish: sample neighbours, convert to normal vector, pack as 0..1 RGB
    out = [0.0] * (w * h * 4)
    for y in range(h):
        y0 = max(0, y-1)
        y1 = min(h-1, y+1)
        for x in range(w):
            x0 = max(0, x-1)
            x1 = min(w-1, x+1)
            dx = (lum[y*w + x1] - lum[y*w + x0]) * strength
            dy = (lum[y1*w + x] - lum[y0*w + x]) * strength
            # Normal vector (invert Y for OpenGL / Blender convention)
            nx = -dx
            ny = -dy
            nz = 1.0
            l = math.sqrt(nx*nx + ny*ny + nz*nz) or 1.0
            nx /= l; ny /= l; nz /= l
            i = (y*w + x) * 4
            out[i+0] = nx*0.5 + 0.5
            out[i+1] = ny*0.5 + 0.5
            out[i+2] = nz*0.5 + 0.5
            out[i+3] = 1.0
    return out

def _generate_roughness(lum, w, h):
    # Dark pixels → rough, bright pixels → smooth. Clamp to a reasonable range
    # so fabrics don't become mirror-smooth and hair doesn't become sand.
    out = [0.0] * (w * h * 4)
    for i in range(w * h):
        r = 1.0 - lum[i]
        # Compress into 0.35..0.9 range (avoids extreme values)
        r = 0.35 + r * 0.55
        if r < 0.0: r = 0.0
        if r > 1.0: r = 1.0
        out[i*4+0] = r
        out[i*4+1] = r
        out[i*4+2] = r
        out[i*4+3] = 1.0
    return out

def _hookup_maps(mat, principled, normal_img, rough_img):
    if not mat or not principled:
        return
    nt = mat.node_tree
    links = nt.links
    # Normal map chain: Image -> Normal Map -> Principled.Normal
    tex_n = nt.nodes.new('ShaderNodeTexImage')
    tex_n.image = normal_img
    tex_n.image.colorspace_settings.name = 'Non-Color'
    tex_n.location = (principled.location[0] - 700, principled.location[1] - 300)
    nmap = nt.nodes.new('ShaderNodeNormalMap')
    nmap.location = (principled.location[0] - 350, principled.location[1] - 300)
    nmap.inputs['Strength'].default_value = 1.0
    links.new(tex_n.outputs['Color'], nmap.inputs['Color'])
    links.new(nmap.outputs['Normal'], principled.inputs['Normal'])
    # Roughness chain: Image -> Principled.Roughness (as non-color data)
    tex_r = nt.nodes.new('ShaderNodeTexImage')
    tex_r.image = rough_img
    tex_r.image.colorspace_settings.name = 'Non-Color'
    tex_r.location = (principled.location[0] - 700, principled.location[1] - 550)
    links.new(tex_r.outputs['Color'], principled.inputs['Roughness'])
    # Metalness: leave input at 0 (constant) — no map needed for organic chars

try:
    gen_count = 0
    for mat in bpy.data.materials:
        principled, bc_img = _find_base_color_image(mat)
        if not bc_img:
            continue
        bw, bh = bc_img.size
        if bw == 0 or bh == 0:
            print(f"EXPORT: skipping material '{mat.name}', base color image is 0x0")
            continue
        print(f"EXPORT: generating PBR maps for material '{mat.name}' (source {bw}x{bh})")
        lum, w, h = _luminance_and_size(bc_img, max_dim=256)
        print(f"EXPORT:   working at {w}x{h}")
        nrm_px = _generate_normal(lum, w, h, strength=3.0)
        rgh_px = _generate_roughness(lum, w, h)
        nrm_img = _make_image(mat.name + "_Normal", w, h, nrm_px)
        rgh_img = _make_image(mat.name + "_Roughness", w, h, rgh_px)
        _hookup_maps(mat, principled, nrm_img, rgh_img)
        gen_count += 1
    print(f"EXPORT: generated PBR maps for {gen_count} materials")
    # Re-pack so the newly generated images are also embeddable
    try: bpy.ops.file.pack_all()
    except Exception: pass
except Exception as e:
    print("EXPORT: PBR map generation failed: " + str(e))

# Unreal-specific transforms (cm units)
unreal = ${isUnreal ? 'True' : 'False'}
if unreal:
    for obj in bpy.context.scene.objects:
        if obj.type in ('MESH', 'ARMATURE'):
            obj.scale = (100, 100, 100)
    bpy.context.view_layer.update()

# Export
out = "${outputPath.replace(/\\/g, '/')}"
fmt = "${realFormat}"
if fmt in ('glb', 'gltf'):
    bpy.ops.export_scene.gltf(filepath=out, export_format='${realFormat === 'glb' ? 'GLB' : 'GLTF_SEPARATE'}')
elif fmt == 'obj':
    bpy.ops.wm.obj_export(filepath=out)
elif fmt == 'fbx':
    # Debug: list images that will (hopefully) be embedded
    print("EXPORT: images in bpy.data at export time:")
    for _img in bpy.data.images:
        if _img.type == 'IMAGE' and _img.size[0] > 0:
            print(f"  - {_img.name} size={tuple(_img.size)} filepath='{_img.filepath_raw}' packed={bool(_img.packed_file)}")
    if unreal:
        bpy.ops.export_scene.fbx(
            filepath=out,
            apply_unit_scale=True,
            apply_scale_options='FBX_SCALE_NONE',
            axis_forward='-Z',
            axis_up='Y',
            bake_space_transform=True,
            mesh_smooth_type='FACE',
            # Embed textures inside the .fbx so Unreal imports a self-contained file
            path_mode='COPY',
            embed_textures=True,
        )
    else:
        bpy.ops.export_scene.fbx(
            filepath=out,
            path_mode='COPY',
            embed_textures=True,
        )
    # Report final FBX size to make sure textures were embedded
    try:
        _sz = os.path.getsize(out)
        print(f"EXPORT: final FBX size = {_sz} bytes")
    except Exception: pass
elif fmt == 'stl':
    bpy.ops.export_mesh.stl(filepath=out)
elif fmt == 'ply':
    bpy.ops.export_mesh.ply(filepath=out)
`;

  const tmpScript = path.join(SCRIPTS_DIR, `export_${Date.now()}.py`);
  fs.writeFileSync(tmpScript, exportScript);

  return new Promise((resolve, reject) => {
    const cleanup = () => { try { if (fs.existsSync(tmpScript)) fs.unlinkSync(tmpScript); } catch(e) {} };
    const proc = execFile(config.blenderPath, ['--background', '--python', tmpScript], {
      timeout: 60000,
      maxBuffer: 50 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      cleanup();
      // Write Blender's full stdout/stderr to last_error.log so the user can
      // inspect the EXPORT: lines that tell what textures were embedded.
      try {
        fs.writeFileSync(
          path.join(__dirname, '..', '..', 'last_error.log'),
          `[${new Date().toISOString()}] export-mesh\nsource: ${sourcePath}\noutput: ${outputPath}\nformat: ${targetFormat}\n\n=== STDOUT ===\n${stdout || ''}\n\n=== STDERR ===\n${stderr || ''}\n`
        );
      } catch (e) {}
      // Also nuke any .fbm sidecar folder Blender created next to the FBX
      // (it appears when embed_textures fails silently)
      try {
        const fbmDir = outputPath.replace(/\.[^.]+$/, '') + '.fbm';
        if (fs.existsSync(fbmDir)) fs.rmSync(fbmDir, { recursive: true, force: true });
      } catch (e) {}
      if (error) reject({ error: error.message, stderr });
      else if (!fs.existsSync(outputPath)) reject({ error: 'Export failed' });
      else resolve({ path: outputPath, filename: path.basename(outputPath) });
    });
    proc.on('error', err => { cleanup(); reject({ error: err.message }); });
  });
});

// Ask the user where to save an exported mesh (returns full file path or null)
ipcMain.handle('pick-export-path', async (event, { defaultName, format }) => {
  const extByFmt = {
    glb: 'glb', gltf: 'gltf', obj: 'obj', fbx: 'fbx', stl: 'stl', ply: 'ply', fbx_unreal: 'fbx',
  };
  const ext = extByFmt[format] || 'glb';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export mesh as...',
    defaultPath: (defaultName || 'mesh') + '.' + ext,
    filters: [{ name: format.toUpperCase(), extensions: [ext] }],
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

// Get basic file info (size, mtime, dimensions for images, tris for meshes)
ipcMain.handle('get-file-info', async (event, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'Not found' };
    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const info = {
      ok: true,
      filename: path.basename(filePath),
      path: filePath,
      sizeBytes: stat.size,
      sizeHuman: stat.size > 1048576 ? (stat.size/1048576).toFixed(1) + ' MB' : (stat.size/1024).toFixed(0) + ' KB',
      modified: stat.mtime,
      ext,
    };
    // Image dimensions via image-size lib if available, else skip
    if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
      try {
        const { imageSize } = require('image-size');
        const buffer = fs.readFileSync(filePath);
        const dim = imageSize(buffer);
        info.width = dim.width;
        info.height = dim.height;
      } catch (e) { /* image-size not installed, skip */ }
    }
    return info;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
