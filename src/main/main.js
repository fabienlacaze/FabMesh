// ===========================================================
// EARLY STARTUP LOGGER — runs BEFORE any other require()
// ===========================================================
// Critical: when the app crashes silently at boot (DLL missing,
// require() throw, unhandled rejection in module init), Sentry
// hasn't had time to attach yet and stderr is invisible to a
// double-click user. This logger writes to a file we can ask the
// user to send us. It exists even if everything else fails.
//
// File: %APPDATA%\fabmesh\startup.log  (Windows)
//       ~/.config/fabmesh/startup.log  (Linux)
//       ~/Library/Application Support/fabmesh/startup.log (macOS)
//
// One file is kept per process; rotated to startup.prev.log on each
// launch so we always have the last 2 runs.
(function _earlyLog() {
  const _path = require('path');
  const _fs = require('fs');
  const _os = require('os');
  let dir;
  try {
    // Use APPDATA on Windows, XDG on Linux, Application Support on Mac.
    if (process.platform === 'win32') {
      dir = _path.join(process.env.APPDATA || _path.join(_os.homedir(), 'AppData', 'Roaming'), 'fabmesh');
    } else if (process.platform === 'darwin') {
      dir = _path.join(_os.homedir(), 'Library', 'Application Support', 'fabmesh');
    } else {
      dir = _path.join(process.env.XDG_CONFIG_HOME || _path.join(_os.homedir(), '.config'), 'fabmesh');
    }
    if (!_fs.existsSync(dir)) _fs.mkdirSync(dir, { recursive: true });
    const log = _path.join(dir, 'startup.log');
    const prev = _path.join(dir, 'startup.prev.log');
    // Rotate previous run
    try { if (_fs.existsSync(log)) _fs.renameSync(log, prev); } catch (_) {}

    const stream = _fs.createWriteStream(log, { flags: 'w' });
    const write = (level, ...args) => {
      const line = `[${new Date().toISOString()}] [${level}] ` +
        args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch (_) { return String(a); } })())).join(' ') + '\n';
      try { stream.write(line); } catch (_) {}
      // Also print to stderr so dev sees it in dev mode (silent in prod).
      if (process.stderr && process.stderr.write) {
        try { process.stderr.write(line); } catch (_) {}
      }
    };
    // Expose globally so other modules can use without import gymnastics.
    global.__startupLog = write;
    write('boot', 'startup.log opened', { pid: process.pid, cwd: process.cwd(), exec: process.execPath });
    write('boot', 'platform=' + process.platform, 'arch=' + process.arch, 'node=' + process.version);
    write('boot', 'argv=' + JSON.stringify(process.argv));
    write('boot', 'ELECTRON_RUN_AS_NODE=' + (process.env.ELECTRON_RUN_AS_NODE || '(unset)'));

    // Catch fatal errors that would otherwise crash silently.
    process.on('uncaughtException', (err) => {
      write('fatal', 'uncaughtException:', err && err.message, err && err.stack);
      try { stream.end(); } catch (_) {}
    });
    process.on('unhandledRejection', (reason) => {
      write('fatal', 'unhandledRejection:', reason && reason.message ? reason.message : String(reason),
        reason && reason.stack ? reason.stack : '');
    });
    process.on('exit', (code) => {
      write('boot', 'process exit code=' + code);
      try { stream.end(); } catch (_) {}
    });
  } catch (e) {
    // We tried — if even this fails, we're out of luck. At least don't crash.
    try { process.stderr.write('[startup] earlyLog failed: ' + e.message + '\n'); } catch (_) {}
  }
})();

const _log = (lvl, ...args) => { try { if (global.__startupLog) global.__startupLog(lvl, ...args); } catch (_) {} };
_log('boot', 'requiring electron…');

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
// Lineage sidecar <output>.meta.json (Generation History) — best-effort, never throws.
const { writeMeta, readMeta } = require('./meta');

// Force UTF-8 in EVERY spawned Python child. The embedded Windows python
// defaults its stdout/file encoding to the console codepage (cp1252 on
// French/German/Spanish/most Western Windows), so any accented / arrow (→) /
// em-dash (—) / emoji character in a print() or file read raises
// UnicodeEncode/DecodeError and CRASHES the generation mid-run. Setting these
// in process.env means all ~38 execFile/spawn sites (which spread
// ...process.env) inherit them without touching each call. PYTHONUTF8 /
// PYTHONIOENCODING are Python-only vars — Node/Electron ignore them, so this
// is safe for the main process itself.
process.env.PYTHONUTF8 = '1';
process.env.PYTHONIOENCODING = 'utf-8';

_log('boot', 'electron required OK, app.getVersion()=' + (app && app.getVersion ? app.getVersion() : '?'));

// ===========================================================
// Sentry crash reporting
// ===========================================================
// Captures unhandled exceptions, native crashes and renderer-side
// errors and ships them to https://sentry.io so we can debug user
// bug reports without asking them to paste a stack trace.
//
// DSN lives in build/sentry-dsn.txt (gitignored) so contributors
// without access don't accidentally send their own crashes. Falls
// back to a no-op transport in dev when the file is missing.
(function _initSentry() {
  let dsn = process.env.SENTRY_DSN || '';
  // Look in two places: the packaged location (resources/sentry-dsn.txt
  // copied by electron-builder's extraResources) and the dev box
  // (build/sentry-dsn.txt, gitignored).
  if (!dsn) {
    const candidates = [
      path.join(process.resourcesPath || '', 'sentry-dsn.txt'),
      path.join(__dirname, '..', '..', 'build', 'sentry-dsn.txt'),
    ];
    for (const p of candidates) {
      try {
        if (p && fs.existsSync(p)) {
          dsn = fs.readFileSync(p, 'utf-8').trim();
          if (dsn) break;
        }
      } catch (_) {}
    }
  }
  if (!dsn) {
    // No DSN configured — silently skip. Dev machines work without it.
    return;
  }
  try {
    const Sentry = require('@sentry/electron/main');
    Sentry.init({
      dsn,
      release: 'myfabmesh-ai@' + (app.getVersion() || '0.0.0'),
      environment: app.isPackaged ? 'production' : 'development',
      // Drop high-volume noise; we only care about real errors.
      tracesSampleRate: 0.0,
      // Strip the user's machine name + Windows username from breadcrumbs.
      beforeSend(event) {
        if (event.user) delete event.user.username;
        if (event.server_name) delete event.server_name;
        return event;
      },
    });
  } catch (e) {
    console.warn('[sentry] init failed:', e.message);
  }
})();

// ===========================================================
// Auto-update via electron-updater
// ===========================================================
// On every launch, check GitHub Releases for a newer version. If
// found, download it in the background and prompt the user before
// installing. Works because we already publish installers to
// fabienlacaze/MyFabmesh releases (the URL pattern electron-builder
// expects).
//
// Manual control: the renderer can call meshyAPI.checkForUpdate()
// to force a check (useful for "About > Check for updates" button).
let _updater = null;
let _updateDownloaded = false;
(function _initAutoUpdate() {
  try {
    // Under MSIX/Store the install dir is read-only and the Store
    // handles updates — electron-updater cannot replace files here.
    if (process.windowsStore) { _updater = null; return; }
    const { autoUpdater } = require('electron-updater');
    _updater = autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;  // we ask the user first
    autoUpdater.logger = null;  // keep Electron's console clean
    autoUpdater.on('update-available', (info) => {
      const v = info?.version || 'unknown';
      // Tell the renderer so it can show a toast / banner.
      if (mainWindow && mainWindow.webContents) {
        try { mainWindow.webContents.send('update-available', { version: v }); } catch (_) {}
      }
    });
    autoUpdater.on('update-downloaded', (info) => {
      _updateDownloaded = true;
      if (mainWindow && mainWindow.webContents) {
        try { mainWindow.webContents.send('update-downloaded', { version: info?.version || '' }); } catch (_) {}
      }
    });
    autoUpdater.on('error', (err) => {
      // Network blip, no release published yet, GitHub rate-limit, etc.
      // Don't spam the user — log to Sentry if it's there, otherwise console.
      try {
        const Sentry = require('@sentry/electron/main');
        Sentry.captureException(err);
      } catch (_) {
        console.warn('[updater] error:', err?.message || err);
      }
    });
  } catch (e) {
    // Module not installed (dev box without npm install) — fine, no-op.
    _updater = null;
  }
})();

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
    b: ['without clothes', 'no clothes', 'unclothed', 'undressed', 'disrobed', 'bare', 'exposed', 'revealing', 'intimate', 'sensual', 'seductive', 'provocative', 'suggestive', 'sexy', 'hot', 'bath', 'shower', 'bedroom', 'bed', 'lingerie', 'underwear', 'panties', 'bra', 'bikini', 'swimsuit', 'diaper only', 'naked', 'nude', 'nsfw', 'sexual', 'erotic', 'porn', 'sans vetement', 'sans habit', 'deshabill', 'nu ', 'nue ', 'nus ', 'nues'] },
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
  // Longer words / stems: match only at a WORD START (left \b boundary) rather
  // than as a raw substring. A stem like "strangul"/"mutilat" still matches
  // "strangulation"/"mutilate" (word begins with the stem), but the keyword no
  // longer fires MID-word — the plain-substring version blocked innocent prompts
  // because e.g. "changing" CONTAINS "hanging", "exchange" contains "hang…",
  // "refresh" ⊄ "flesh" but "fleshy" begins with "flesh" (kept, intended).
  // 2026-07-14: this is what blocked "changing haircut" (Argos translation of
  // « changer la coupe de cheveux ») on the "hanging" keyword. Word-boundary
  // matching is strictly MORE precise → it can only REMOVE false positives.
  const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('\\b' + esc).test(text);
}

// ── HARD FLOOR — illegal content (CSAM / child abuse) that NO setting,
//    including unrestricted mode, may EVER bypass. Checked BEFORE the
//    isUnrestrictedMode() short-circuit. NSFW_COMBOS[0]=child×sexual,
//    NSFW_COMBOS[2]=child×violence are the illegal floor.
const HARD_FLOOR_KEYWORDS = [
  'pedophil', 'paedophil', 'pédophil', 'loli', 'shota', 'lolicon',
  'shotacon', 'child abuse', 'toddler abuse', 'infant abuse',
  'child porn', 'childporn',
];
const HARD_FLOOR_COMBOS = [NSFW_COMBOS[0], NSFW_COMBOS[2]];

function checkHardFloor(prompt) {
  const lower = (prompt || '').toLowerCase();
  for (const kw of HARD_FLOOR_KEYWORDS) {
    if (_matchesKeyword(lower, kw)) {
      return { safe: false, blocked: kw, hardFloor: true,
        reason: 'Blocked: this content is illegal and cannot be generated under any setting.' };
    }
  }
  for (const combo of HARD_FLOOR_COMBOS) {
    const hasA = combo.a.some(w => _matchesKeyword(lower, w));
    const hasB = combo.b.some(w => _matchesKeyword(lower, w));
    if (hasA && hasB) {
      return { safe: false, blocked: 'minor-safety', hardFloor: true,
        reason: 'Blocked: depicting minors in this context is illegal and cannot be generated under any setting.' };
    }
  }
  return { safe: true };
}

function checkPromptSafety(prompt) {
  const floor = checkHardFloor(prompt);
  if (!floor.safe) return floor;            // illegal floor — never bypassable
  if (isUnrestrictedMode()) return { safe: true };  // unrestricted relaxes SOFT filters only
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
  const floor = checkHardFloor(prompt);
  if (!floor.safe) return floor;            // illegal floor — never bypassable
  // AI text classifier DISABLED for blocking. michellejieli/NSFW_text_classifier
  // false-positives heavily on benign game-asset prompts ("bigger and dressed in
  // black" -> 0.92, "Golden crab" -> 0.79), blocking legitimate edits. Safety is
  // still enforced by: (1) checkHardFloor above + the keyword checkPromptSafety
  // (illegal / explicit terms), and (2) the OUTPUT image NSFW check at the gallery
  // / 3D stage. The nsfw_server infra is kept dormant for a future reliable model.
  return { safe: true };
}

// --- Spell checker (Chromium built-in; Hunspell on Windows) -----------------
// Uses the user's UI language so French/Spanish/etc. words aren't flagged as
// English typos. The renderer pushes its language via 'set-spellcheck-lang'.
function _loadUiLang() {
  try { return (loadConfig().uiLang) || 'fr'; } catch (_) { return 'fr'; }
}
function _spellcheckCodesFor(uiLang) {
  try {
    const avail = (mainWindow && mainWindow.webContents.session.availableSpellCheckerLanguages) || [];
    const want = (uiLang || 'en').toLowerCase().slice(0, 2);
    const match = avail.find(c => c.toLowerCase().slice(0, 2) === want);  // e.g. 'fr' -> 'fr', 'es' -> 'es-ES'
    // ONLY the UI language, so the suggestions come from it (not English). If the
    // UI language has no dictionary (e.g. Chinese), fall back to English.
    if (match) return [match];
    const en = avail.find(c => c.toLowerCase().startsWith('en'));
    return en ? [en] : [];
  } catch (_) { return []; }
}
function _applySpellcheckLang(win, uiLang) {
  try {
    const avail = (win && win.webContents.session.availableSpellCheckerLanguages) || [];
    const langs = _spellcheckCodesFor(uiLang);
    const _appLangs = ['fr', 'es', 'zh', 'hi', 'ar'].map(l => l + '=' + (avail.find(c => c.toLowerCase().slice(0, 2) === l) || 'NONE')).join(' ');
    log.info('main', `spellcheck uiLang=${uiLang} -> set ${JSON.stringify(langs)} | appLangs: ${_appLangs}`);
    if (langs.length && win && win.webContents) win.webContents.session.setSpellCheckerLanguages(langs);
  } catch (e) { try { log.warn('main', `spellcheck set failed: ${e && e.message}`); } catch (_) {} }
}
ipcMain.handle('set-spellcheck-lang', (event, lang) => {
  try { const cfg = loadConfig(); cfg.uiLang = lang; saveConfig(cfg); } catch (_) {}
  try { _applySpellcheckLang(mainWindow, lang); } catch (_) {}
  return { ok: true };
});

function safeBase(base, maxLen = 80) {
  if (base.length <= maxLen) return base;
  return base.slice(0, maxLen);
}

// Channels whose payload eventually reaches the user (progress logs,
// live log viewer). Strings going through these channels are filtered
// to replace internal model/library names with branded equivalents.
// Channels NOT in this set (e.g. internal IPC for window state) are
// sent untouched.
const _USER_VISIBLE_CHANNELS = new Set([
  'ai3d-progress', 'calib-progress', 'wizard:test-log',
  'wizard:install-progress', 'log:line', 'mcp-stderr',
]);

// One regex pass per call site is fine — these strings are usually
// under a few KB. Order matters: full repo paths before short names.
const _BRAND_FILTERS = [
  [/\bmicrosoft\/TRELLIS\.?2?[\w.\-]*/gi, 'MyFabmesh.AI 3D Core'],
  [/\bSG161222\/RealVisXL[\w.\-]*/gi,     'Texture engine'],
  [/\bdiffusers\/stable-diffusion-xl-1\.0-inpainting[\w.\-]*/gi, 'Face refiner'],
  [/\bxinsir\/controlnet-openpose-sdxl[\w.\-]*/gi, 'Back-view module'],
  [/\bxinsir\/controlnet-tile-sdxl[\w.\-]*/gi,     'Tile refiner'],
  [/\bh94\/IP-Adapter[\w.\-/]*/gi,                  'Reference module'],
  [/\bmicrosoft\/Florence-2-large/gi,               'Advanced vision analyzer'],
  [/\bSalesforce\/blip-image-captioning-large/gi,   'Vision analyzer'],
  [/\bRealESRGAN_x4plus[\w.\-]*/gi,                 'Upscale engine'],
  [/\bhuanngzh\/mv-adapter[\w.\-/]*/gi,             'Multi-view module'],
  [/\bstabilityai\/[\w.\-]+/gi,                     'AI engine'],
  [/\bTRELLIS\.?2?[\w.\-]*/gi,                      '3D Core'],
  [/\bRealVisXL\s*V?\d?\.?\d?/gi,                   'Texture engine'],
  [/\bRealVis(?!Mesh)\w*/gi,                        'Image engine'],
  [/\bSDXL\s*(?:Turbo|Inpaint(?:ing)?|Lightning)?/gi,'AI engine'],
  [/\bControlNet(?:\s+OpenPose)?/gi,                'pose module'],
  [/\bIP-?Adapter(?:\s+Plus)?/gi,                   'reference module'],
  [/\bFlorence-?2?\b/gi,                            'vision analyzer'],
  [/\bBLIP-?\d?\b/gi,                               'vision analyzer'],
  [/\bReal-?ESRGAN\b/gi,                            'upscale engine'],
  [/\bMV-?Adapter\b/gi,                             'multi-view module'],
  [/\bStable\s*Fast\s*3D\b/gi,                      'mesh engine'],
  [/\bTripoSR\b/gi,                                 'mesh engine'],
  [/\bSF3D\b/gi,                                    'mesh engine'],
  [/\bMeshyMyself\b/g,                              'MyFabmesh.AI'],
  [/\bFabMesh\b/g,                                  'MyFabmesh.AI'],
];

function _filterSensitive(text) {
  let out = String(text);
  for (const [re, sub] of _BRAND_FILTERS) out = out.replace(re, sub);
  return out;
}

function safeSend(channel, data) {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      let payload = data;
      if (_USER_VISIBLE_CHANNELS.has(channel) && typeof data === 'string') {
        payload = _filterSensitive(data);
      }
      mainWindow.webContents.send(channel, payload);
    }
  } catch (e) {
    // Window destroyed mid-send - ignore silently
  }
}

// ------------------------------------------------------------
// Writable data root vs read-only install dir.
// In a packaged build (NSIS, and ESPECIALLY the MSIX/APPX Store
// build) the install dir lives under a READ-ONLY location
// (C:\Program Files\WindowsApps\… and/or inside app.asar). Any
// fs.mkdirSync/createWriteStream against __dirname/../.. throws
// EPERM/EACCES/EROFS/ENOTDIR at MODULE LOAD — before app.whenReady,
// before any window — which the process.on('uncaughtException')
// handlers CANNOT rescue (they only catch async throws). Result:
// silent crash at launch = the Microsoft Store 10.1.2.10 failure.
//
// Fix: writable data goes under app.getPath('userData') (safe to
// call before whenReady). Read-only assets (the Python scripts,
// shipped via extraResources) come from process.resourcesPath.
// ------------------------------------------------------------
const DATA_BASE = app.isPackaged
  ? app.getPath('userData')
  : path.join(__dirname, '..', '..');

const MESHES_DIR   = path.join(DATA_BASE, 'meshes');
const PREVIEWS_DIR = path.join(DATA_BASE, 'previews');
const IMAGES_DIR   = path.join(DATA_BASE, 'images');
const HISTORY_DIR  = path.join(DATA_BASE, 'history');
const LOGS_DIR     = path.join(DATA_BASE, 'logs');
const CONFIG_PATH  = path.join(DATA_BASE, 'config.json');
// HEAVY data (the AI venv + the ~7-22 GB models) is RELOCATABLE: default is
// userData, but config.dataDir can point it at another drive so the big
// download need not land on C:. loadConfig() is hoisted and CONFIG_PATH is
// set above, so reading it here at module init is safe (defaults to DATA_BASE
// on any error). Changing dataDir takes effect after an app restart.
let HEAVY_DIR = DATA_BASE;
try {
  const _dd = loadConfig().dataDir;
  if (_dd && typeof _dd === 'string' && _dd.trim()) HEAVY_DIR = _dd.trim();
} catch (_) {}
// Writable AI Python env (copy of python-embed + pip-installed torch).
const AI_PYTHON_DIR = path.join(HEAVY_DIR, 'python');
// Rig engine (Puppeteer) — SEPARATE env: torch 2.7.0+cu128, incompatible
// with the AI env's torch 2.8. Provisioned by wizard:install-rig.
const RIG_PYTHON_DIR = path.join(HEAVY_DIR, 'python-rig');
const PUPPETEER_DIR  = path.join(HEAVY_DIR, 'puppeteer');
// Part segmentation (SAMPart3D) — SEPARATE env: torch cu128 sm_120 +
// pointops + tiny-cuda-nn (incompatible with the AI + rig envs' torch
// pins). Provisioned by wizard:install-segment. Runs LOCALLY on the
// user's GPU. The SAMPart3D repo clone + ptv3-object.pth live under HEAVY.
const SEGMENT_PYTHON_DIR = path.join(HEAVY_DIR, 'python-segment');
const SAMPART3D_DIR      = path.join(HEAVY_DIR, 'SAMPart3D');
const PARTSAM_DIR        = path.join(HEAVY_DIR, 'PartSAM');   // moteur de découpe feedforward (remplace SAMPart3D)
// HuggingFace model cache (the big download); HF_HOME points here.
const HF_CACHE_DIR  = path.join(HEAVY_DIR, 'hf_cache');

// SCRIPTS_DIR is READ-ONLY: in prod the .py files are copied to
// process.resourcesPath/scripts by electron-builder extraResources.
// In dev they live at repo-root/scripts. Never mkdir this one.
const SCRIPTS_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'scripts')
  : path.join(__dirname, '..', '..', 'scripts');

// Ensure WRITABLE directories exist. Guarded: a failed mkdir must
// NEVER abort module evaluation (that is what crashed the cert VM).
[MESHES_DIR, PREVIEWS_DIR, IMAGES_DIR, HISTORY_DIR, LOGS_DIR].forEach(dir => {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    _log('warn', 'mkdir failed for ' + dir + ': ' + (e && e.message));
  }
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
// ------------------------------------------------------------
// Last-resort fallback window. If the real window failed to be
// created (createWindow threw, loadFile rejected, a startup
// subsystem blew up), we MUST still paint *a* window — the
// Microsoft Store reviewer treats "no window appears" identically
// to "crashes at launch" (10.1.2.10). This shows a minimal error
// page so the product visibly launches and the user gets a log
// pointer instead of a silent exit.
// ------------------------------------------------------------
let _fallbackWindow = null;
function showFallbackWindow(err) {
  try {
    if (typeof app === 'undefined' || !app.isReady || !app.isReady()) return; // can't make a window yet
    // A real, visible window already exists? Don't stack a second one.
    if (typeof mainWindow !== 'undefined' && mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) return;
    if (_fallbackWindow && !_fallbackWindow.isDestroyed()) return;
    _fallbackWindow = new BrowserWindow({
      width: 720, height: 480, show: true, backgroundColor: '#0b0b14',
      title: 'MyFabmesh.AI', webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    const msg = ((err && (err.stack || err.message)) || String(err || 'Unknown error'))
      .replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8">'
      + '<style>body{background:#0b0b14;color:#e6e6f0;font-family:system-ui,sans-serif;padding:28px}'
      + 'h2{color:#ff6b6b;margin:0 0 12px}pre{white-space:pre-wrap;background:#16161f;padding:12px;'
      + 'border-radius:8px;border:1px solid #2a2a3a;font-size:12px}</style></head><body>'
      + '<h2>MyFabmesh.AI could not start normally</h2>'
      + '<p>The app started but hit an error during initialization. Please report this with the log file.</p>'
      + '<pre>' + msg + '</pre>'
      + '<p style="opacity:.7;font-size:12px">Log: %APPDATA%\\myfabmesh-ai\\logs\\fabmesh.log and %APPDATA%\\fabmesh\\startup.log</p>'
      + '</body></html>';
    _fallbackWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    _fallbackWindow.setMenuBarVisibility(false);
  } catch (e2) {
    _log('fatal', 'showFallbackWindow itself failed: ' + (e2 && e2.message));
  }
}

// Capture uncaught exceptions / unhandled rejections of the main process.
// NEVER let one of these kill the process silently: log it everywhere we
// can, and if no visible window exists yet, surface a fallback window so
// the app still "launches" from the reviewer's / user's point of view.
process.on('uncaughtException', (e) => {
  log.error('main', 'uncaughtException: ' + (e && (e.stack || e.message) || e));
  _log('fatal', 'uncaughtException: ' + (e && (e.stack || e.message) || e));
  try { showFallbackWindow(e); } catch (_) {}
});
process.on('unhandledRejection', (reason) => {
  log.error('main', 'unhandledRejection: ' + (reason && reason.stack || reason));
  _log('fatal', 'unhandledRejection: ' + (reason && (reason.stack || reason.message) || reason));
  try { showFallbackWindow(reason); } catch (_) {}
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
// free ~13 GB VRAM. 90s is a compromise: long enough to chain 2-3 tool
// actions without reload, short enough to release VRAM when the user
// switches tasks. The server is protected by `sdxlInflightRequests > 0`
// so a long model load never gets killed mid-inference.
const SDXL_IDLE_TIMEOUT_MS = 90 * 1000;
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
  // Check every 10s whether the server is idle and should be killed
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
  }, 10000);
}

// Cache the AI-engine (SDXL server) VRAM so the Processes panel shows its
// REAL GPU footprint. The process RAM is tiny (~1.8 GB) but the loaded image
// model holds several GB of VRAM — without this the row looks small yet
// killing it frees ~8 GB. Windows (WDDM) doesn't expose per-process VRAM to
// nvidia-smi, so we ask the server itself (/ping returns vram_gb).
let _sdxlVramGb = null;
let _sdxlVramAt = 0;
function _refreshSdxlVram() {
  if (!sdxlProc || !sdxlReady) { _sdxlVramGb = null; return Promise.resolve(); }
  if (Date.now() - _sdxlVramAt < 3000) return Promise.resolve();  // throttle
  return new Promise((resolve) => {
    try {
      const req = require('http').request(
        { host: '127.0.0.1', port: SDXL_PORT, path: '/ping', method: 'GET', timeout: 800 },
        (res) => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => {
            try {
              const j = JSON.parse(body);
              if (typeof j.vram_gb === 'number') { _sdxlVramGb = j.vram_gb; _sdxlVramAt = Date.now(); }
            } catch (_) {}
            resolve();
          });
        }
      );
      req.on('error', () => resolve());
      req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(); });
      req.end();
    } catch (_) { resolve(); }
  });
}

function startSdxlServer() {
  if (sdxlProc) return;
  const serverScript = path.join(SCRIPTS_DIR, 'sdxl_server.py');
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
    sdxlProc = require('child_process').spawn(_aiPython(), [serverScript], {
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

// First-run state: the wizard writes setup_state.json into the user-data
// folder when setup completes. Until that file exists, every launch goes
// through the wizard. Easy to inspect/reset manually for debugging.
const SETUP_STATE_FILE = path.join(app.getPath('userData'), 'setup_state.json');

// Bootstrap migration: when we renamed package.json `name` from "fabmesh"
// to "myfabmesh-ai", Electron's userData path moved from
// %APPDATA%/fabmesh/ to %APPDATA%/myfabmesh-ai/. Existing users would
// otherwise face the wizard again on the first launch after upgrade.
// Migrate the old state file once if the new one is missing.
function _migrateLegacySetupState() {
  try {
    if (fs.existsSync(SETUP_STATE_FILE)) return;
    const legacy = path.join(path.dirname(path.dirname(SETUP_STATE_FILE)), 'fabmesh', 'setup_state.json');
    if (fs.existsSync(legacy)) {
      fs.mkdirSync(path.dirname(SETUP_STATE_FILE), { recursive: true });
      fs.copyFileSync(legacy, SETUP_STATE_FILE);
      log.info('main', `migrated legacy setup_state.json from ${legacy}`);
    }
  } catch (e) {
    log.warn('main', `legacy state migration failed: ${e.message}`);
  }
}

// Detect that the install is "already done" even without setup_state.json:
// if the heavy AI models are present in the HuggingFace cache, the user
// has clearly run the app before. Don't make them sit through the wizard
// again — auto-mark the setup as completed and remember the choice.
function _detectAlreadyInstalled() {
  try {
    const hub = path.join(require('os').homedir(), '.cache', 'huggingface', 'hub');
    // TRELLIS-2 is the largest required model; if it's there, we're set.
    const trellisDir = path.join(hub, 'models--microsoft--TRELLIS.2-4B');
    if (!fs.existsSync(trellisDir)) return false;
    // Size sanity: > 1 GB on disk = real cache, not an empty placeholder.
    let total = 0;
    const walk = (d) => {
      let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else { try { total += fs.statSync(p).size; } catch (_) {} }
        if (total > 1024 * 1024 * 1024) return; // 1 GB early-exit
      }
    };
    walk(trellisDir);
    return total > 1024 * 1024 * 1024;
  } catch (_) { return false; }
}

function isSetupComplete() {
  try {
    _migrateLegacySetupState();
    if (!fs.existsSync(SETUP_STATE_FILE)) {
      // No state file, but maybe the user already has the models.
      // Auto-complete in that case so the wizard never re-appears.
      if (_detectAlreadyInstalled()) {
        try {
          fs.mkdirSync(path.dirname(SETUP_STATE_FILE), { recursive: true });
          fs.writeFileSync(SETUP_STATE_FILE, JSON.stringify({
            completed_at: new Date().toISOString(),
            mode: 'auto-detected',
            note: 'Models already present in HF cache — skipped wizard',
          }, null, 2));
          log.info('main', 'setup auto-completed (models already in HF cache)');
          return true;
        } catch (e) {
          log.warn('main', `auto-complete write failed: ${e.message}`);
        }
      }
      return false;
    }
    const s = JSON.parse(fs.readFileSync(SETUP_STATE_FILE, 'utf-8'));
    return !!(s && s.completed_at);
  } catch (_) { return false; }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'MyFabmesh.AI',
    icon: path.join(__dirname, '..', '..', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: '#1a1a2e',
    // show:true (au lieu de false) : la fenêtre apparaît IMMÉDIATEMENT avec le
    // backgroundColor (pas de flash blanc), sans dépendre de 'ready-to-show'.
    // Sur un Win11 propre (Store cert), SAC peut empêcher le renderer/GPU de
    // peindre → 'ready-to-show' ne fire jamais → avec show:false l'app restait
    // SANS FENÊTRE = « crashes at launch ». show:true garantit une fenêtre.
    show: true
  });

  // Route to the wizard on first launch, to the main app afterwards.
  const startPage = isSetupComplete() ? 'index2.html' : 'wizard.html';
  log.info('main', `loading ${startPage} (setup ${isSetupComplete() ? 'done' : 'pending'})`);
  // .catch : si le chargement de la page échoue (fichier manquant, renderer
  // mort), on bascule sur la fenêtre de secours au lieu d'un reject global muet.
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', startPage))
    .catch((e) => {
      log.error('main', `loadFile(${startPage}) failed: ${e && e.message}`);
      try { if (typeof showFallbackWindow === 'function') showFallbackWindow(e); } catch (_) {}
    });
  // WATCHDOG de révélation : si 'ready-to-show' ne fire pas en 8 s (le renderer
  // n'a jamais peint — SAC/GPU bloqué), on force show() + fenêtre de secours,
  // et on loggue l'état pour diagnostiquer sur la machine de certif.
  let _revealed = false;
  const _revealWatchdog = setTimeout(() => {
    if (_revealed || !mainWindow || mainWindow.isDestroyed()) return;
    try {
      log.error('main', `ready-to-show not fired in 8s — forcing show (visible=${mainWindow.isVisible()} url=${mainWindow.webContents.getURL()})`);
    } catch (_) {}
    try { mainWindow.show(); } catch (_) {}
    try { if (typeof showFallbackWindow === 'function') showFallbackWindow(new Error('renderer failed to paint within 8s (ready-to-show never fired)')); } catch (_) {}
  }, 8000);
  mainWindow.once('ready-to-show', () => {
    _revealed = true;
    clearTimeout(_revealWatchdog);
    try { mainWindow.maximize(); } catch (_) {}
    try { mainWindow.show(); } catch (_) {}
  });
  mainWindow.setMenuBarVisibility(false);

  // Spell checker: apply the stored UI language + a right-click menu offering
  // spelling suggestions, "add to dictionary", and the standard edit actions.
  try { _applySpellcheckLang(mainWindow, _loadUiLang()); } catch (_) {}
  try {
    const _ses = mainWindow.webContents.session;
    _ses.on('spellcheck-dictionary-download-success', (e, lang) => log.info('main', `spellcheck dict downloaded: ${lang}`));
    _ses.on('spellcheck-dictionary-download-failure', (e, lang) => log.warn('main', `spellcheck dict download FAILED: ${lang} (CDN blocked?)`));
    _ses.on('spellcheck-dictionary-initialized', (e, lang) => log.info('main', `spellcheck dict ready: ${lang}`));
  } catch (_) {}
  // GPU / renderer crash recovery. On an old/unstable GPU driver the renderer
  // (GPU) process can die, leaving a permanently BLANK window with no way out.
  // Auto-reload — but NOT during a normal shutdown ('clean-exit'/'killed') or
  // while quitting, which would cause a reload loop. reload() re-loads the
  // current page; in-flight renderer state is lost but that beats a dead window.
  let _rendererReloads = 0;
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    try { log.error('main', 'renderer gone: ' + (details && details.reason)); } catch (_) {}
    if (_isQuitting) return;
    if (details && (details.reason === 'clean-exit' || details.reason === 'killed')) return;
    // Anti-boucle : si le renderer meurt en boucle (GPU/SAC), on ARRÊTE de
    // reload à l'infini après 3 essais et on montre la fenêtre de secours.
    if (++_rendererReloads > 3) {
      log.error('main', 'renderer keeps dying — stop reload loop, showing fallback');
      try { if (typeof showFallbackWindow === 'function') showFallbackWindow(new Error('renderer keeps dying: ' + (details && details.reason))); } catch (_) {}
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.reload(); } catch (_) {} }
  });
  mainWindow.webContents.on('unresponsive', () => {
    try { log.warn('main', 'renderer unresponsive (page may recover)'); } catch (_) {}
  });
  mainWindow.webContents.on('context-menu', (event, params) => {
    if (!params.isEditable && !params.misspelledWord) return;
    const { Menu, MenuItem } = require('electron');
    const menu = new Menu();
    for (const s of (params.dictionarySuggestions || [])) {
      menu.append(new MenuItem({ label: s, click: () => mainWindow.webContents.replaceMisspelling(s) }));
    }
    if (params.misspelledWord) {
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ label: 'Add to dictionary', click: () => mainWindow.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord) }));
    }
    if (params.isEditable) {
      if (menu.items.length) menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ role: 'cut' }));
      menu.append(new MenuItem({ role: 'copy' }));
      menu.append(new MenuItem({ role: 'paste' }));
      menu.append(new MenuItem({ role: 'selectAll' }));
    }
    if (menu.items.length) menu.popup();
  });

  // ----------------------------------------------------------
  // Durcissement Electron : contrôle des window.open / navigations
  // ----------------------------------------------------------
  // Sans handler, un window.open() ou un lien target=_blank ouvre une
  // nouvelle BrowserWindow Chromium DANS l'app (contexte privilégié).
  // On refuse toute création de fenêtre : les URL http/https/mailto
  // partent vers le navigateur système (Chrome), le reste est bloqué.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') {
        shell.openExternal(url).catch((e) => log.warn('main', `openExternal blocked url failed: ${e && e.message}`));
      } else {
        log.warn('main', `window.open denied (protocole non autorisé): ${url}`);
      }
    } catch (_) {
      log.warn('main', `window.open denied (url invalide): ${url}`);
    }
    return { action: 'deny' };
  });
  // Empêche le renderer de naviguer AILLEURS que vers les pages locales
  // de l'app (index2.html / wizard.html). Un clic sur un lien http:// est
  // redirigé vers le navigateur système au lieu de remplacer la page.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'file:') return; // navigation interne autorisée
      event.preventDefault();
      if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') {
        shell.openExternal(url).catch(() => {});
      } else {
        log.warn('main', `will-navigate bloqué: ${url}`);
      }
    } catch (_) {
      event.preventDefault();
    }
  });

  // Intercept close: ask the renderer if there are running jobs.
  // The renderer shows its own styled modal and replies via IPC.
  // Exception: on the wizard, close immediately — there's no risk of
  // losing user work, and a stuck wizard with no exit is a soft-lock.
  let closeConfirmed = false;
  mainWindow.on('close', (event) => {
    if (closeConfirmed || _isQuitting) return;
    const currentUrl = mainWindow.webContents.getURL() || '';
    if (currentUrl.endsWith('wizard.html')) {
      // Wizard window: always allow close. Background downloads (if any)
      // are interrupted; HuggingFace snapshot_download resumes on next run.
      return;
    }
    event.preventDefault();
    mainWindow.webContents.send('app-close-requested');
  });
  ipcMain.on('app-close-confirmed', (_e, opts) => {
    closeConfirmed = true;
    // 2026-06-13:
    //   { killJobs: false }  -> keep running (orphan), skip cleanup
    //   { pauseJobs: true }  -> suspend trees + persist manifests, skip cleanup
    // Both leave the subprocesses alive across the Electron exit.
    if (opts && opts.pauseJobs === true) {
      try { pauseAndPersistJobs(opts.jobStates); } catch (e) { log.warn('main', `pause on quit failed: ${e.message}`); }
      _keepJobsOnQuit = true;
    } else if (opts && opts.killJobs === false) {
      _keepJobsOnQuit = true;
    }
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
    const { startControlApi } = require('./control_api');
    startControlApi(mainWindow);
  } catch (e) {
    try { log.error('control_api', 'failed to start: ' + e.message); }
    catch (_) { console.error('[control_api] failed to start:', e); }
  }
}

// ========== MCP BRIDGE HTTP SERVER ==========
// Allows the MCP server (scripts/mcp_server.py) to dispatch generation
// commands through Electron so jobs appear in the UI and VRAM is gated.
// Loopback-only (127.0.0.1), but other local processes (any user-mode
// software, browser tabs hitting localhost) could still issue commands.
// Gate every request behind a Bearer token written to a 0600 file at
// repo root; only processes that can read that file are allowed.
const MCP_BRIDGE_PORT = 7555;
// Token must live in a WRITABLE location. In a packaged build the
// install dir is read-only, so use DATA_BASE (userData) like all
// other runtime state.
const MCP_TOKEN_FILE = path.join(DATA_BASE, '.mcp_bridge_token');

function _loadOrCreateMcpToken() {
  try {
    if (fs.existsSync(MCP_TOKEN_FILE)) {
      const t = fs.readFileSync(MCP_TOKEN_FILE, 'utf-8').trim();
      if (t && t.length >= 32) return t;
    }
  } catch (_) {}
  const t = require('crypto').randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(MCP_TOKEN_FILE, t, { mode: 0o600 });
  } catch (e) {
    log.warn('mcp-bridge', `could not persist token: ${e.message}`);
  }
  return t;
}

let MCP_BRIDGE_TOKEN = '';

function startMcpBridge() {
  MCP_BRIDGE_TOKEN = _loadOrCreateMcpToken();
  const http = require('http');
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405); res.end('POST only'); return;
    }
    // Auth check: every request must carry the bridge token. Refuse
    // immediately on missing / wrong token, before parsing the body
    // (avoids burning CPU on hostile callers).
    const auth = req.headers['authorization'] || '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!provided || provided !== MCP_BRIDGE_TOKEN) {
      log.warn('mcp-bridge', `unauthorized request from ${req.socket.remoteAddress}`);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'unauthorized' }));
      return;
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

    const bridgeScript = path.join(SCRIPTS_DIR, 'local_juggernaut_bridge.py');
    const count = String(params.numImages || params.count || 1);
    const steps = String(params.steps || 30);
    // Snapshot the directory BEFORE generation so we can compute the diff
    // (= only the images produced by this call). Without this, the caller
    // would iterate over every image already in the project and re-run
    // expensive follow-up steps (MV-Adapter back-view, etc.) on each.
    const filesBefore = new Set(
      fs.existsSync(imagesDir)
        ? fs.readdirSync(imagesDir).filter(f => /\.png$/i.test(f) && !f.startsWith('.'))
        : []
    );
    const proc = execFile(_aiPython(), [bridgeScript, params.prompt, imagesDir, count, steps], {
      timeout: 1800000, maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, PYTHONUNBUFFERED: '1', FABMESH_VRAM_FRACTION: process.env.FABMESH_VRAM_FRACTION || '0.95' },
    }, (error, stdout, stderr) => {
      if (error) {
        safeSend('mcp-job-end', { type: 'image', success: false, error: error.message });
        resolve({ success: false, error: error.message });
        return;
      }
      const imgs = fs.readdirSync(imagesDir)
        .filter(f => /\.png$/i.test(f) && !f.startsWith('.'))
        .filter(f => !filesBefore.has(f))  // only NEW files
        .map(f => path.join(imagesDir, f));
      safeSend('mcp-job-end', { type: 'image', success: true, count: imgs.length });
      resolve({ success: true, images: imgs, count: imgs.length, project: safeName });
    });
    installJobLimitsWatchdog(proc, 'generate-image (RealVis)');
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

  const bridgeScript = path.join(SCRIPTS_DIR, 'local_sf3d_bridge.py');
  const texRes = String(params.textureSize || 1024);
  const verts = String(params.targetFaces || -1);
  const remesh = (params.targetFaces && params.targetFaces > 0) ? 'triangle' : 'none';
  const subdiv = String(params.subdivide || 0);

  return new Promise((resolve) => {
    const proc = execFile(_aiPython(), [bridgeScript, imagePath, meshPath, texRes, verts, remesh, subdiv], {
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
      // Guard against a 0-byte / truncated GLB passing as success: require a
      // plausible size and the glTF binary magic header (a real mesh is 10s of KB+).
      try {
        const _sz = fs.statSync(meshPath).size;
        let _magicOk = true;
        if (/\.glb$/i.test(meshPath)) {
          const _fd = fs.openSync(meshPath, 'r');
          const _mg = Buffer.alloc(4);
          fs.readSync(_fd, _mg, 0, 4, 0); fs.closeSync(_fd);
          _magicOk = _mg.toString('ascii') === 'glTF';
        }
        if (_sz < 2048 || !_magicOk) {
          safeSend('mcp-job-end', { type: 'mesh', success: false, error: `invalid GLB (size=${_sz})` });
          resolve({ success: false, error: `GLB invalid or truncated (${_sz} bytes)` });
          return;
        }
      } catch (_e) { /* validation error → don't block (existsSync already passed) */ }
      try { fs.writeFileSync(meshPath + '.source', imagePath, 'utf-8'); } catch(e) {}
      const stats = fs.statSync(meshPath);
      let meshVerts = null, meshFaces = null;
      const m = (stdout || '').match(/STATS:\s*verts=(\d+)\s*faces=(\d+)/);
      if (m) { meshVerts = parseInt(m[1]); meshFaces = parseInt(m[2]); }
      safeSend('mcp-job-end', { type: 'mesh', success: true, meshPath, meshVerts, meshFaces });
      resolve({ success: true, meshPath, meshFilename, size: stats.size, meshVerts, meshFaces });
    });
    installJobLimitsWatchdog(proc, `image-to-3d (${engine})`);
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

  const scriptsDir = path.join(SCRIPTS_DIR);
  const baseName = path.basename(meshPath, path.extname(meshPath)).replace(/[^a-zA-Z0-9_-]/g, '_');
  const rigTs = Date.now();
  const tempUnirigGlb = path.join(MESHES_DIR, `${baseName}_unirig_temp_${rigTs}.glb`);
  const tempSwapGlb = path.join(MESHES_DIR, `${baseName}_swap_temp_${rigTs}.glb`);
  const outputGlb = path.join(MESHES_DIR, `${baseName}_rigged_unirig_${rigTs}.glb`);

  const runStep = (label, args) => new Promise((resolve) => {
    safeSend('ai3d-progress', `[MCP-${label}] Starting...`);
    const proc = execFile(_aiPython(), args, { timeout: 600000, maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
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

// ============================================================
// Multi-view auto-inheritance on image-version creation
// ============================================================
// Rule (user 2026-04-15, option C):
//   When a new image version is created in the SAME project (auto-paint,
//   inpaint, rembg, etc.), look at whether any existing image version in
//   the same folder has `<stem>_multiview/` matching the NEW image's
//   silhouette. If so, copy that multi-view folder to the new image's
//   own `<new_stem>_multiview/`. Otherwise, fire off Zero123++ to build
//   new views. This keeps the "multi-views belong to a version" rule
//   intact while sparing the user 45 s of regeneration when the change
//   didn't alter the silhouette (rembg, color tweak, minor retouch).
//
// Silhouette hash = sha1 of the 64×64 alpha binarization, first 16 hex.

function _silhouetteHash(imgPath) {
  // Tiny self-contained Python one-liner via execFileSync — avoids pulling
  // in canvas/jimp for one hash. Returns 16 hex chars or '' on failure.
  try {
    const py = `
import sys, hashlib
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGBA')
a = im.split()[-1].resize((64,64))
bits = bytes(1 if p > 64 else 0 for p in a.getdata())
print(hashlib.sha1(bits).hexdigest()[:16])
`.trim();
    const { execFileSync } = require('child_process');
    const out = execFileSync('python', ['-c', py, imgPath], {
      timeout: 10000,
      encoding: 'utf-8',
      windowsHide: true,
    });
    return (out || '').trim();
  } catch (e) {
    return '';
  }
}

function _copyMultiviewDir(srcDir, dstDir) {
  try {
    fs.mkdirSync(dstDir, { recursive: true });
    // Include views.json — without it, texture_project.py falls back to
    // the Z123 schema (30/90/150/210/270/330) even if the views were
    // generated by CRM (0/90/180/270/TOP/BOT), which shreds the atlas.
    for (const fn of ['input.png', 'view_0.png', 'view_1.png', 'view_2.png',
                      'view_3.png', 'view_4.png', 'view_5.png',
                      'views.json']) {
      const src = path.join(srcDir, fn);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(dstDir, fn));
      }
    }
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Called right after a new image version is written to disk.
 * Inherits or regenerates the `<stem>_multiview/` for that image.
 *
 * @param {string} newImagePath absolute path to the new image version
 * @returns {Promise<{inherited: boolean, regenerated: boolean, hash: string}>}
 */
async function _handleMultiviewInheritance(newImagePath) {
  try {
    if (!fs.existsSync(newImagePath)) return { inherited: false, regenerated: false, hash: '' };
    const imgDir = path.dirname(newImagePath);
    const newStem = path.basename(newImagePath, path.extname(newImagePath));
    const newMvDir = path.join(imgDir, `${newStem}_multiview`);
    if (fs.existsSync(path.join(newMvDir, 'view_5.png'))) {
      // Already has its own multi-views — nothing to do.
      return { inherited: false, regenerated: false, hash: '' };
    }
    const newHash = _silhouetteHash(newImagePath);
    if (!newHash) return { inherited: false, regenerated: false, hash: '' };

    // Scan the project's images folder for existing <stem>_multiview/ dirs
    // whose source image matches the silhouette hash.
    const entries = fs.readdirSync(imgDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory() || !ent.name.endsWith('_multiview')) continue;
      const candStem = ent.name.slice(0, -'_multiview'.length);
      if (candStem === newStem) continue;
      // Find the image file that stem came from (png/jpg)
      let candImg = null;
      for (const x of ['.png', '.jpg', '.jpeg', '.webp']) {
        const p = path.join(imgDir, candStem + x);
        if (fs.existsSync(p)) { candImg = p; break; }
      }
      if (!candImg) continue;
      const candHash = _silhouetteHash(candImg);
      if (candHash && candHash === newHash) {
        // Silhouette match — inherit.
        const copied = _copyMultiviewDir(path.join(imgDir, ent.name), newMvDir);
        if (copied) {
          log.info('mv-inherit', `new=${newStem} reused from=${candStem} hash=${newHash}`);
          return { inherited: true, regenerated: false, hash: newHash };
        }
      }
    }

    // 2026-06-14: NO silhouette match — previously this auto-fired
    // Zero123++/MV-Adapter to regenerate multi-views. That surprised the
    // user: a simple "Remove background" or "Draw mask" edit changes the
    // silhouette, so it never matched and silently kicked off an
    // expensive (minutes, GPU-heavy) multi-view regeneration they never
    // asked for. We now SKIP auto-regeneration. The edited image simply
    // has no multi-views until the user explicitly clicks the
    // "Multi-Views" button — which is the expected behaviour for an edit.
    log.info('mv-inherit', `new=${newStem} no silhouette match — skipping auto-regen (use Multi-Views button to generate)`);
    return { inherited: false, regenerated: false, hash: newHash };
  } catch (e) {
    log.error('mv-inherit', `error: ${e.message}`);
    return { inherited: false, regenerated: false, hash: '' };
  }
}

async function handleRemoveBackground(params) {
  const imagePath = params.imagePath;
  if (!imagePath || !fs.existsSync(imagePath)) return { success: false, error: 'Image not found' };
  const dir = path.dirname(imagePath);
  const ext = path.extname(imagePath);
  const base = safeBase(path.basename(imagePath, ext));
  const outPath = path.join(dir, `${base}_nobg_${Date.now()}${ext}`);
  const script = path.join(SCRIPTS_DIR, 'remove_bg.py');
  // Fallback: use rembg directly. Paths go through sys.argv (not string
  // interpolation) — a filename containing a double-quote would break
  // out of the `r"..."` literal and let an attacker run arbitrary
  // Python.
  const pyCode = `
import rembg, sys
from PIL import Image
img = Image.open(sys.argv[1])
out = rembg.remove(img)
out.save(sys.argv[2])
print("OK")
`;
  return new Promise((resolve) => {
    execFile(_aiPython(), ['-c', pyCode, imagePath, outPath],
        { timeout: 300000 }, (error, stdout, stderr) => {
      if (error || !fs.existsSync(outPath)) {
        const st = (stderr || '').trim();
        let msg;
        if (error && (error.killed || /timed out|ETIMEDOUT/i.test(error.message || ''))) {
          msg = 'Remove BG a expiré (timeout). Le système était probablement saturé (RAM/CPU) par un autre traitement — attends qu\'il finisse puis relance.';
        } else {
          msg = st ? st.slice(-1500) : (error?.message || 'rembg failed');
        }
        resolve({ success: false, error: msg });
      } else {
        _handleMultiviewInheritance(outPath).catch(() => {});
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
  // ----------------------------------------------------------
  // STEP 1 — Create & paint the window FIRST, in isolation.
  // Everything else (job resume, MCP bridge, updater, control
  // API) is OPTIONAL and must never be able to prevent the
  // window from appearing. If createWindow throws, we still
  // surface a fallback window so the app visibly launches.
  // ----------------------------------------------------------
  try {
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
  } catch (e) {
    log.error('main', 'createWindow threw: ' + (e && (e.stack || e.message)));
    _log('fatal', 'createWindow threw: ' + (e && (e.stack || e.message)));
    if (!HEADLESS) { try { showFallbackWindow(e); } catch (_) {} }
  }

  // ----------------------------------------------------------
  // STEP 2 — Optional subsystems, each independently guarded.
  // A failure in any one must NOT stop the others and must NOT
  // crash the process or hide the window.
  // ----------------------------------------------------------

  // 2026-06-13: resume any jobs the user paused on the last quit.
  try { resumePausedJobs(); } catch (e) { log.warn('main', `resumePausedJobs failed: ${e.message}`); }

  // MCP Bridge HTTP server — always started (headless or not) so Claude
  // can dispatch commands whether FabMesh is visible or hidden.
  try { startMcpBridge(); } catch (e) { log.warn('main', `startMcpBridge failed: ${e.message}`); }

  // Trigger an update check 30 seconds after launch so we don't compete
  // with the heavy first-paint of the main app. Silent if already
  // up-to-date or if GitHub is unreachable.
  if (_updater && app.isPackaged) {
    setTimeout(() => {
      try { _updater.checkForUpdatesAndNotify(); } catch (_) {}
    }, 30 * 1000);
  }

  if (HEADLESS) {
    log.info('main', `Headless mode ready. MCP bridge on http://127.0.0.1:${MCP_BRIDGE_PORT}`);
    log.info('main', 'Waiting for commands... (Ctrl+C to stop)');
  }
}).catch((e) => {
  // whenReady itself rejected — last line of defense.
  log.error('main', 'whenReady rejected: ' + (e && (e.stack || e.message)));
  _log('fatal', 'whenReady rejected: ' + (e && (e.stack || e.message)));
  try { showFallbackWindow(e); } catch (_) {}
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
// =============================================================================
// 2026-06-13: PAUSE / RESUME running subprocess trees across app restarts.
//
// Windows has no built-in "suspend process" CLI, but ntdll exports
// NtSuspendProcess / NtResumeProcess. We P/Invoke them from a short
// PowerShell snippet (no external binary needed — verified working).
// A process *tree* is suspended/resumed by enumerating descendants via
// CIM Win32_Process(ParentProcessId).
//
// On "Quit & pause jobs":
//   1. For every tracked subprocess: collect its descendant tree, suspend
//      every PID, and write a manifest to userData/paused_jobs/<pid>.json
//      recording { rootPid, treePids, spawnfile, spawnargs }.
//   2. Skip killAllActiveProcs so the (now-suspended) children survive the
//      parent Electron exit (Node child_process doesn't job-object them).
//
// On next launch resumePausedJobs():
//   - Read every manifest. If the root PID is still alive, resume the whole
//     tree and notify the renderer. If it's dead (e.g. reboot), drop the
//     manifest. Output files the job writes are picked up by the normal
//     list-* scans / a renderer refresh.
// =============================================================================
const PAUSED_JOBS_DIR = path.join(app.getPath('userData'), 'paused_jobs');

function _ensurePausedDir() {
  try { if (!fs.existsSync(PAUSED_JOBS_DIR)) fs.mkdirSync(PAUSED_JOBS_DIR, { recursive: true }); } catch (_) {}
}

// Collect a PID + all its descendant PIDs (depth-first) via CIM.
function _collectProcTree(rootPid) {
  try {
    const ps = `$ErrorActionPreference='SilentlyContinue';`
      + `$all=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId;`
      + `$out=New-Object System.Collections.Generic.List[int];`
      + `function Walk($pid){ $out.Add([int]$pid); foreach($c in $all){ if($c.ParentProcessId -eq $pid){ Walk $c.ProcessId } } }`
      + `Walk ${rootPid}; $out -join ','`;
    const res = require('child_process').execFileSync(
      'powershell', ['-NoProfile', '-Command', ps],
      { timeout: 8000, encoding: 'utf-8' });
    return res.trim().split(',').map(s => parseInt(s, 10)).filter(n => Number.isFinite(n));
  } catch (e) {
    return [rootPid];
  }
}

// Suspend or resume a list of PIDs via NtSuspendProcess / NtResumeProcess.
function _ntSuspendResume(pids, action) {
  if (!pids || !pids.length) return;
  const fn = action === 'resume' ? 'NtResumeProcess' : 'NtSuspendProcess';
  const list = pids.join(',');
  const ps = `$sig=@"
[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h);
[DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);
"@;`
    + `$nt=Add-Type -MemberDefinition $sig -Name NtCtl -Namespace W -PassThru;`
    + `foreach($id in @(${list})){ try{ $h=(Get-Process -Id $id -ErrorAction Stop).Handle; [void]$nt::${fn}($h) }catch{} }`;
  try {
    require('child_process').execFileSync(
      'powershell', ['-NoProfile', '-Command', ps],
      { timeout: 15000 });
  } catch (e) {
    log.warn('main', `_ntSuspendResume(${action}) failed: ${e.message}`);
  }
}

// Best-effort human label for a job from its spawn command line.
function _jobLabelFromArgs(spawnargs) {
  const j = Array.isArray(spawnargs) ? spawnargs.join(' ').toLowerCase() : String(spawnargs || '').toLowerCase();
  if (j.includes('rokoko_batch_retarget')) return 'Animation (retarget)';
  if (j.includes('trellis')) return '3D Mesh generation';
  if (j.includes('puppeteer') || j.includes('unirig')) return 'Auto-rig';
  if (j.includes('sdxl') || j.includes('realvis') || j.includes('text2image')) return 'Image generation';
  if (j.includes('refine')) return 'Mesh refine';
  return 'Background job';
}

// Coarse job kind from the spawn command line — must use the SAME
// vocabulary as the renderer's inferKind() so we can match each tracked
// subprocess back to the renderer-side job state at pause time.
function _jobKindFromArgs(spawnargs) {
  const j = Array.isArray(spawnargs) ? spawnargs.join(' ').toLowerCase() : String(spawnargs || '').toLowerCase();
  if (j.includes('rokoko_batch_retarget')) return 'anim';
  if (j.includes('trellis')) return 'mesh';
  if (j.includes('puppeteer') || j.includes('unirig')) return 'rig';
  if (j.includes('inpaint') || j.includes('mask')) return 'inpaint';
  if (j.includes('sdxl') || j.includes('realvis') || j.includes('text2image')) return 'image';
  return 'other';
}

// Map the renderer's inferKind vocabulary onto _jobKindFromArgs so the
// two sides agree. inferKind returns: inpaint/mesh/rig/bg/img2img/image.
function _normalizeRendererKind(k) {
  if (k === 'mesh') return 'mesh';
  if (k === 'rig') return 'rig';
  if (k === 'inpaint') return 'inpaint';
  if (k === 'image' || k === 'img2img' || k === 'bg') return 'image';
  if (k === 'anim') return 'anim';
  return 'other';
}

// Suspend every tracked job tree + persist manifests. Called on quit-pause.
// `jobStates` (from the renderer) carries each running job's progress so
// the bar can resume where it was: [{kind,label,expectedMs,pausedElapsed}].
function pauseAndPersistJobs(jobStates) {
  _ensurePausedDir();
  // Pool the renderer states by normalized kind so we can hand the right
  // progress snapshot to each matching subprocess.
  const pool = {};
  for (const s of (Array.isArray(jobStates) ? jobStates : [])) {
    const k = _normalizeRendererKind(s.kind);
    (pool[k] = pool[k] || []).push(s);
  }
  let count = 0;
  for (const proc of Array.from(allActiveProcs)) {
    const pid = proc && proc.pid;
    if (!pid) continue;
    try {
      const tree = _collectProcTree(pid);
      _ntSuspendResume(tree, 'suspend');
      const kind = _jobKindFromArgs(proc.spawnargs);
      // Pull a renderer state of the same kind (FIFO), else any leftover.
      let state = (pool[kind] && pool[kind].shift()) || null;
      if (!state) {
        for (const k of Object.keys(pool)) {
          if (pool[k].length) { state = pool[k].shift(); break; }
        }
      }
      const manifest = {
        rootPid: pid,
        treePids: tree,
        spawnfile: proc.spawnfile || null,
        spawnargs: proc.spawnargs || null,
        kind,
        label: (state && state.label) || _jobLabelFromArgs(proc.spawnargs),
        expectedMs: (state && state.expectedMs) || null,
        progress: (state && state.progress) || null,
        pausedElapsed: (state && state.pausedElapsed) || null,
        pausedAt: Date.now(),
      };
      fs.writeFileSync(
        path.join(PAUSED_JOBS_DIR, `${pid}.json`),
        JSON.stringify(manifest, null, 2));
      count++;
    } catch (e) {
      log.warn('main', `pauseAndPersistJobs: failed for pid=${pid}: ${e.message}`);
    }
  }
  log.info('main', `pauseAndPersistJobs: suspended ${count} job tree(s)`);
  return count;
}

// Poll a resumed (orphaned) PID until it exits, then tell the renderer
// so it can complete the Running task popup. We resumed but did not
// spawn the process, so there's no exit code — completion is neutral.
function _watchResumedPid(rootPid, label) {
  const iv = setInterval(() => {
    let alive = false;
    try { process.kill(rootPid, 0); alive = true; } catch (_) { alive = false; }
    if (!alive) {
      clearInterval(iv);
      try {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
          mainWindow.webContents.send('job-pid-exited', { rootPid, label });
        }
      } catch (_) {}
    }
  }, 2500);
  // Don't let the watcher keep the event loop alive on quit.
  if (iv.unref) iv.unref();
}

// On launch: resume any manifests whose root PID is still alive.
function resumePausedJobs() {
  _ensurePausedDir();
  let files;
  try { files = fs.readdirSync(PAUSED_JOBS_DIR).filter(f => f.endsWith('.json')); }
  catch (_) { return; }
  let dropped = 0;
  const resumedJobs = [];  // { rootPid, label }
  for (const f of files) {
    const full = path.join(PAUSED_JOBS_DIR, f);
    let m;
    try { m = JSON.parse(fs.readFileSync(full, 'utf-8')); } catch (_) { try { fs.unlinkSync(full); } catch (_) {} continue; }
    // Is the root PID still alive?
    let alive = false;
    try { process.kill(m.rootPid, 0); alive = true; } catch (_) { alive = false; }
    if (alive) {
      // Re-enumerate the tree (children may have changed) + resume.
      const tree = _collectProcTree(m.rootPid);
      _ntSuspendResume(tree.length ? tree : (m.treePids || [m.rootPid]), 'resume');
      resumedJobs.push({
        rootPid: m.rootPid,
        label: m.label || 'Background job',
        expectedMs: m.expectedMs || null,
        progress: m.progress || null,
        pausedElapsed: m.pausedElapsed || null,
      });
    } else {
      dropped++;
    }
    try { fs.unlinkSync(full); } catch (_) {}
  }
  const resumed = resumedJobs.length;
  if (resumed || dropped) {
    log.info('main', `resumePausedJobs: resumed ${resumed}, dropped ${dropped} dead`);
    // Tell the renderer so it can re-create the "Running task" popup for
    // each resumed job and toast the user. Then watch each PID and notify
    // on exit so the popup can complete.
    let _sentOnce = false;
    const send = () => {
      if (_sentOnce) return;  // guard: did-finish-load AND the fallback
      _sentOnce = true;       // timeout both call this — fire only once.
      try {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
          mainWindow.webContents.send('jobs-resumed', { resumed, dropped, jobs: resumedJobs });
        }
      } catch (_) {}
    };
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.once('did-finish-load', send);
      setTimeout(send, 4000);  // fallback if load already fired
    }
    for (const job of resumedJobs) {
      _watchResumedPid(job.rootPid, job.label);
    }
  }
}

// 2026-06-13: set true when the user picks "Quit and keep jobs running"
// (or "pause jobs") so fullCleanup leaves the Python/Blender
// subprocesses alive instead of killing them.
let _keepJobsOnQuit = false;
function fullCleanup() {
  if (_isQuitting) return;
  _isQuitting = true;
  if (!_keepJobsOnQuit) {
    killAllActiveProcs();
    stopSdxlServer();
    try { stopTranslateServer(); } catch (_) {}
    try { stopNsfwServer(); } catch (_) {}
    // WSL shutdown also kills any WSL-side work — skip when keeping jobs.
    try { execFile('wsl', ['--shutdown'], { timeout: 10000 }, () => {}); } catch(e) {}
  } else {
    log.info('main', 'fullCleanup: keeping jobs running per user choice (subprocesses left alive)');
  }
}

// 2026-06-13: number of live tracked subprocesses, exposed to the
// renderer so its styled quit modal can count backend jobs even after
// a renderer F5 (main.js process didn't reload, children still tracked).
function _runningJobsCount() {
  try { return allActiveProcs ? allActiveProcs.size : 0; } catch (_) { return 0; }
}
// The quit-confirm dialog must count only real GENERATION jobs (activeProcs,
// keyed by jobId) — NOT persistent helpers (SDXL server, MCP bridge, etc.)
// which live in allActiveProcs. Counting helpers popped the "jobs running"
// dialog when nothing was actually generating. _runningJobsCount() (all
// procs) stays for kill-all / the Settings process panel.
ipcMain.handle('jobs:running-count', () => { try { return activeProcs ? activeProcs.size : 0; } catch (_) { return 0; } });
ipcMain.handle('jobs:kill-all', () => {
  const n = _runningJobsCount();
  killAllActiveProcs();
  return { ok: true, killed: n };
});

// 2026-06-14: per-process detail + independent kill for the Settings
// SYSTEM > Processes panel.
// Batched RAM lookup (one tasklist spawn, not per-row) -> Map<pid, ramMB>.
// 2026-06-14 FIX: was execFileSync — under heavy generation load tasklist
// can take several seconds, and a synchronous spawn BLOCKS the Electron
// main process, freezing the whole UI (the user reported "les stats ont
// freeze durant la génération"). Now async (execFile + Promise) so the
// event loop keeps turning. Caller awaits it.
function _ramByPidWin() {
  return new Promise((resolve) => {
    const m = new Map();
    if (process.platform !== 'win32') { resolve(m); return; }
    try {
      require('child_process').execFile(
        'tasklist', ['/FI', 'IMAGENAME eq python.exe', '/FO', 'CSV', '/NH'],
        { encoding: 'utf-8', timeout: 5000, windowsHide: true },
        (err, stdout) => {
          if (!err && stdout) {
            stdout.split(/\r?\n/).forEach(line => {
              const mm = line.match(/^"python\.exe","(\d+)".*,"([\d.,]+) K"\s*$/);
              if (mm) m.set(parseInt(mm[1]), Math.round(parseInt(mm[2].replace(/[.,]/g, ''), 10) / 1024));
            });
          }
          resolve(m);
        });
    } catch (_) { resolve(m); }
  });
}

// Derive the owning project name from a subprocess command line so the
// Settings process list can offer a "Go to" button. Most jobs pass an
// images/<folder>/ path; the folder is <project>_<timestamp>, and the
// renderer groups projects by stripping that trailing _<digits>.
function _projectNameFromArgs(spawnargs) {
  const j = Array.isArray(spawnargs) ? spawnargs.join(' ') : String(spawnargs || '');
  let m = j.match(/[\\/]images[\\/]([^\\/]+)[\\/]/i);
  if (m) return m[1].replace(/_\d+$/, '');
  m = j.match(/[\\/]meshes[\\/]([^\\/]+?)(?:_trellis2|_rigged|_unirig|\.glb)/i);
  if (m) return m[1].replace(/_\d+$/, '');
  return null;
}

ipcMain.handle('list-processes', async () => {
  const now = Date.now();
  const sdxlPid = sdxlProc ? sdxlProc.pid : -1;
  const [ram] = await Promise.all([
    _ramByPidWin(),     // async — never blocks the main process
    _refreshSdxlVram(), // refresh the AI-engine VRAM (cached, throttled 3s)
  ]);
  const rows = [];
  for (const proc of Array.from(allActiveProcs)) {  // snapshot — exit handler mutates the Set
    if (!proc || !proc.pid) continue;
    if (proc.exitCode !== null && proc.exitCode !== undefined) continue;  // already exited
    const isAiEngine = proc.pid === sdxlPid;
    rows.push({
      pid: proc.pid,
      label: isAiEngine
        ? (sdxlReady ? 'AI engine (image model loaded)' : 'AI engine (loading…)')
        : _jobLabelFromArgs(proc.spawnargs),
      kind: isAiEngine ? 'image' : _jobKindFromArgs(proc.spawnargs),
      projectName: isAiEngine ? null : _projectNameFromArgs(proc.spawnargs),
      elapsedMs: now - (proc.__startedAt || now),
      ramMb: ram.get(proc.pid) || null,
      vramMb: isAiEngine && _sdxlVramGb != null ? Math.round(_sdxlVramGb * 1024) : null,
      suspended: !!proc._suspended,
      isAiEngine,
    });
  }
  // Safety net: surface the SDXL engine even if it isn't in the Set.
  if (sdxlProc && !rows.some(r => r.pid === sdxlPid)) {
    rows.push({ pid: sdxlPid,
      label: sdxlReady ? 'AI engine (image model loaded)' : 'AI engine (loading…)',
      kind: 'image', elapsedMs: now - (sdxlProc.__startedAt || now),
      ramMb: ram.get(sdxlPid) || null,
      vramMb: _sdxlVramGb != null ? Math.round(_sdxlVramGb * 1024) : null,
      suspended: false, isAiEngine: true });
  }
  rows.sort((a, b) => (a.isAiEngine === b.isAiEngine) ? a.pid - b.pid : (a.isAiEngine ? 1 : -1));
  return { procs: rows, sdxl: sdxlProc != null && sdxlReady };
});

ipcMain.handle('kill-process', (event, arg) => {
  const pid = (arg && typeof arg === 'object') ? arg.pid : arg;
  if (!pid) return { ok: false, error: 'no pid' };
  const sdxlPid = sdxlProc ? sdxlProc.pid : -1;
  // AI engine row -> clean shutdown path (HTTP /shutdown + VRAM free +
  // sdxlProc=null bookkeeping). Never killProcTree the SDXL pid directly
  // or the idle timer / state vars desync.
  if (pid === sdxlPid) {
    try { stopSdxlServer(); return { ok: true, killed: pid, engine: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  }
  // Independent per-row kill: prefer the tracked object (its exit handler
  // removes it from the Set); fall back to a {pid} shim for orphans
  // (killProcTree's win32 branch only reads proc.pid).
  const target = Array.from(allActiveProcs).find(p => p && p.pid === pid);
  try {
    killProcTree(target || { pid });
    if (target) allActiveProcs.delete(target);
    return { ok: true, killed: pid };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

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
  proc.__startedAt = Date.now();   // 2026-06-14: powers the per-process elapsed column
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
  // Image path passed via sys.argv to avoid `r"${imagePath}"` injection.
  const pyCode = `
import sys, json
img_path = sys.argv[1]
try:
    from transformers import pipeline
    from PIL import Image
    clf = pipeline('image-classification', model='Falconsai/nsfw_image_detection', device='cpu')
    r = clf(Image.open(img_path))
    nsfw_score = next((x['score'] for x in r if x['label'] == 'nsfw'), 0)
    print(json.dumps({"nsfw": nsfw_score > 0.5, "score": round(nsfw_score, 3)}))
except Exception as e:
    # Fallback: skin ratio heuristic
    import numpy as np
    from PIL import Image
    img = Image.open(img_path).convert('RGB').resize((256,256))
    arr = np.array(img).astype(float)
    r,g,b = arr[:,:,0], arr[:,:,1], arr[:,:,2]
    skin = ((r>95)&(g>40)&(b>20)&(r>g)&(r>b)&((r-g)>15)&(arr.max(2)-arr.min(2)>15))
    ratio = float(skin.sum()) / (256*256)
    print(json.dumps({"nsfw": ratio > 0.35, "score": round(ratio, 3)}))
`;
  return new Promise((resolve) => {
    execFile(_aiPython(), ['-c', pyCode, imagePath],
        { timeout: 30000 }, (error, stdout) => {
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

  // IDEMPOTENT: skip images that already carry a persisted verdict. Flagged
  // images have a `.nsfw` sidecar, clean ones a `.nsfwok` sidecar (both written
  // by nsfw_scan.py). Only never-seen images go to the AI scanner — so on a
  // relaunch with no new images we DON'T spawn Python at all. This removes the
  // ~38% CPU / 20-30s startup spike where the whole library was re-classified
  // through two CPU ViT models every launch (verdicts were renderer-RAM only).
  const decided = {};
  const toScan = [];
  for (const p of imgList) {
    if (fs.existsSync(p + '.nsfw'))        decided[p] = true;
    else if (fs.existsSync(p + '.nsfwok')) decided[p] = false;
    else                                   toScan.push(p);
  }
  if (toScan.length === 0) {
    log.info('main', `NSFW scan: all ${imgList.length} already decided (sidecars) — no AI run`);
    return decided;
  }

  // Write paths to a temp file (use forward slashes to avoid JSON escape issues)
  const tmpFile = path.join(LOGS_DIR, '_nsfw_scan_paths.json');
  const outFile = path.join(LOGS_DIR, '_nsfw_scan_results.json');
  fs.writeFileSync(tmpFile, JSON.stringify(toScan), 'utf-8');
  const scanScript = path.join(SCRIPTS_DIR, 'nsfw_scan.py');

  return new Promise((resolve) => {
    execFile(_aiPython(), [scanScript, tmpFile, outFile], { timeout: 120000, maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
      try { fs.unlinkSync(tmpFile); } catch(_) {}
      if (error) { log.error('main', `NSFW scan failed: ${stderr?.slice(-200) || error.message}`); resolve(decided); return; }
      if (!fs.existsSync(outFile)) { resolve(decided); return; }
      try {
        const results = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
        try { fs.unlinkSync(outFile); } catch(_) {}
        const merged = { ...decided, ...results };
        log.info('main', `NSFW scan: ${toScan.length} new scanned (${imgList.length - toScan.length} cached), ${Object.values(merged).filter(v=>v).length} NSFW`);
        resolve(merged);
      } catch (_) { resolve(decided); }
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

// OS-level hard memory cap: applies a Windows Working Set hard limit to
// the spawned Python process via SetProcessWorkingSetSizeEx() with
// QUOTA_LIMITS_HARDWS_MAX_ENABLE. Once set, Windows pages the process to
// disk (swap) instead of letting it allocate more physical RAM. The job
// stays alive but runs slower under memory pressure — exactly what the
// user asked for: "ça mettra plus de temps mais ne dépassera pas".
//
// Limit source: FABMESH_RAM_LIMIT_GB (preferred, absolute GB) OR
// FABMESH_RAM_LIMIT_PCT (% of total RAM, default 90%).
//
// On non-Windows or if PowerShell fails, this is a no-op — the existing
// pre-flight gate (handleImageTo3D) prevents impossible-to-fit jobs from
// being launched.
function setProcessHardMemoryLimit(proc, jobName) {
  if (process.platform !== 'win32' || !proc || !proc.pid) return;
  // 2026-06-14: the HARD working-set cap (QUOTA_LIMITS_HARDWS_MAX_ENABLE) is
  // OFF by default. It was the 3rd and worst cause of the "stuck at 40%":
  // Windows force-trims the process's HOT pages to disk the instant it hits
  // the cap (27 GB from the RAM slider), even though 32 GB is physically
  // present. The shape-SLat pass then thrashes at ~104 s/iteration instead
  // of ~1.4 s/it. A hard cap trims hot pages; the pagefile pages cold ones —
  // the latter is far cheaper. With the watchdog now warn-only, the pagefile
  // is the graceful overflow path. Re-enable the hard cap only if the user
  // explicitly opts in via FABMESH_HARD_RAM_CAP=1 (e.g. a true low-RAM box
  // where bounding the working set matters more than speed).
  if (process.env.FABMESH_HARD_RAM_CAP !== '1') {
    log.info('main', `[ram-cap] hard working-set cap DISABLED for ${jobName} pid=${proc.pid} (pagefile handles overflow; set FABMESH_HARD_RAM_CAP=1 to force it)`);
    return;
  }
  const pid = proc.pid;
  const _os = require('os');
  const totalRam = _os.totalmem();
  // Priority: MB cap from RAM slider (FABMESH_RAM_LIMIT_MB, populated by
  // ipcMain.handle('set-ram-limit') when the user drags the Settings
  // slider) > explicit GB cap > percentage > default 90%
  let capBytes;
  const sliderMB = parseFloat(process.env.FABMESH_RAM_LIMIT_MB || '');
  const explicitGB = parseFloat(process.env.FABMESH_RAM_LIMIT_GB || '');
  if (sliderMB > 0) {
    capBytes = Math.round(sliderMB * 1024 * 1024);
  } else if (explicitGB > 0) {
    capBytes = Math.round(explicitGB * 1024 ** 3);
  } else {
    const pct = Math.min(99, Math.max(50, parseFloat(process.env.FABMESH_RAM_LIMIT_PCT || '90'))) / 100;
    capBytes = Math.round(totalRam * pct);
  }
  // Min working set = 100 MB. Max = our cap. Flags = HARDWS_MIN (0x1) | HARDWS_MAX (0x4).
  const minBytes = 100 * 1024 * 1024;
  // PowerShell + P/Invoke into kernel32.dll. Delayed so Python has time to spawn.
  setTimeout(() => {
    try {
      const psScript = `
$sig = @'
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool SetProcessWorkingSetSizeEx(IntPtr hProcess, IntPtr min, IntPtr max, uint flags);
'@;
Add-Type -MemberDefinition $sig -Name K -Namespace W;
$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue;
if ($p) {
  $ok = [W.K]::SetProcessWorkingSetSizeEx($p.Handle, [IntPtr]${minBytes}, [IntPtr]${capBytes}, 0x5);
  if ($ok) { Write-Output "OK" } else { Write-Output "FAIL $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
} else { Write-Output "NOPROC" }
      `.trim();
      const _out = require('child_process').execFileSync(
        'powershell', ['-NoProfile', '-Command', psScript],
        { encoding: 'utf-8', timeout: 5000 }
      );
      const _r = (_out || '').trim();
      if (_r === 'OK') {
        log.info('main', `[ram-cap] set hard working set ${(capBytes / 1024 ** 3).toFixed(1)} GB on ${jobName} pid=${pid}`);
      } else {
        log.warn('main', `[ram-cap] SetProcessWorkingSetSizeEx returned ${_r} for pid=${pid} (job=${jobName})`);
      }
    } catch (e) {
      log.warn('main', `[ram-cap] failed to set hard working set on pid=${pid}: ${e.message}`);
    }
  }, 300);
}

// SAFETY watchdog: monitors ALL 4 user-configured limits (RAM, VRAM,
// GPU utilization, GPU temperature) every 1s, and kills the job if
// ANY metric exceeds 99% of its limit for 2 consecutive readings.
// This is the LAST LINE OF DEFENSE: if a limit is hit, the user
// explicitly said "stop the work" rather than let it crash the PC.
//
// User intent: "je veux que si on atteint 99% pour n'importe quelle
// limite on arrete le travail en cours".
//
// Limits source (env vars set by Settings sliders):
//   FABMESH_RAM_LIMIT_MB   : RAM cap in MB (user slider)
//   FABMESH_VRAM_FRACTION  : VRAM cap as 0..1 fraction (e.g. 0.9 = 90%)
//   FABMESH_GPU_LIMIT      : GPU utilization % cap
//   FABMESH_TEMP_LIMIT     : GPU temp slider 0..100 -> maps to 30..100°C
//
// Trigger is at 99% of each limit. Kill via killProcTree + nuke orphans.
function installAllLimitsSafetyKill(proc, jobName) {
  if (!proc || !proc.pid) return;
  const _os = require('os');
  const totalRamMB = _os.totalmem() / (1024 * 1024);
  // SAFETY_FRACTION 0.95 instead of 0.99: PyTorch can allocate >1 GB
  // between two polls (observed: 14589 -> 15721 MB in 1s). A 5% margin
  // ensures the actual VRAM usage stays under the user's slider value
  // even when the allocator burst-grabs memory between two ticks.
  const SAFETY_FRACTION = 0.95;
  // Track consecutive breaches per metric. VRAM uses threshold=1
  // (immediate suspend) because GPU allocations escalate fast; RAM
  // uses threshold=2 (more stable signal, less prone to transient
  // spikes from filesystem cache).
  const _breaches = { ram: 0, vram: 0, gpu: 0, temp: 0 };
  const _vramBreachThreshold = 1;
  const _ramBreachThreshold = 2;
  const _interval = setInterval(() => {
    if (proc.killed || proc.exitCode !== null) {
      // If we exit while suspended, the process would stay frozen forever.
      // Try a best-effort resume on exit just in case.
      if (proc._suspended) {
        try {
          require('child_process').execFileSync(
            'powershell', ['-NoProfile', '-Command',
              `$sig='[DllImport(\"ntdll.dll\")] public static extern int NtResumeProcess(IntPtr h);'; ` +
              `Add-Type -MemberDefinition $sig -Name N -Namespace W -ErrorAction SilentlyContinue; ` +
              `$p=Get-Process -Id ${proc.pid} -ErrorAction SilentlyContinue; ` +
              `if ($p) { [W.N]::NtResumeProcess($p.Handle) | Out-Null }`
            ], { stdio: 'ignore', timeout: 2000 }
          );
        } catch (e) {}
      }
      clearInterval(_interval);
      return;
    }
    // --- RAM (system-wide, in MB) ---
    const _free = _os.freemem();
    const _usedMB = (_os.totalmem() - _free) / (1024 * 1024);
    const _ramLimitMB = parseFloat(process.env.FABMESH_RAM_LIMIT_MB || '');
    let _tripped = null;
    let _detail = '';
    // RAM is NEVER a suspend trigger. Suspending a process does NOT free
    // its RAM — the working set stays allocated and merely frozen, so the
    // suspend can never bring usage back down. The resume hysteresis
    // (usage < 85% of limit) then never fires because nothing releases the
    // memory → the job DEADLOCKS suspended forever (observed: stuck at 40%,
    // RAM 30.9/27 GB). Windows' pagefile (virtual memory) safely absorbs
    // RAM overflow instead: the high-res TRELLIS pass spills to disk (a bit
    // slower) rather than crashing. So for RAM we ONLY warn, never suspend.
    if (_ramLimitMB > 0 && _usedMB > _ramLimitMB * SAFETY_FRACTION) {
      _breaches.ram += 1;
      _detail = `RAM ${_usedMB.toFixed(0)} MB > ${(_ramLimitMB * SAFETY_FRACTION).toFixed(0)} MB (${(SAFETY_FRACTION*100).toFixed(0)}% of ${_ramLimitMB} MB limit) — pagefile absorbs overflow, NOT suspending`;
      // intentionally NO `_tripped = 'ram'` — see comment above
    } else _breaches.ram = 0;
    // --- VRAM + GPU + TEMP via single nvidia-smi call ---
    if (!_tripped) {
      try {
        const _gpuOut = require('child_process').execFileSync(
          'nvidia-smi',
          ['--query-gpu=memory.used,memory.total,utilization.gpu,temperature.gpu',
            '--format=csv,noheader,nounits'],
          { encoding: 'utf-8', timeout: 1500 }
        );
        const _cols = (_gpuOut.split('\n')[0] || '').split(',').map(s => parseFloat(s.trim()));
        if (_cols.length >= 4) {
          const [vramUsed, vramTotal, gpuUtil, tempC] = _cols;
          const _vramFrac = parseFloat(process.env.FABMESH_VRAM_FRACTION || '');
          const _gpuLimit = parseFloat(process.env.FABMESH_GPU_LIMIT || '');
          const _tempLimitSlider = parseFloat(process.env.FABMESH_TEMP_LIMIT || '');
          // VRAM — WARN ONLY, never suspend (2026-06-14). Suspending the
          // Python process does NOT free its VRAM: the CUDA context keeps
          // every allocation resident while the process is frozen, so VRAM
          // never falls back under the resume threshold → the job DEADLOCKS
          // suspended forever (observed: SUSPEND VRAM 15350>13939 MB, stuck
          // at 40%, GPU still 99%). And a real VRAM overrun does NOT crash
          // the PC — CUDA returns an out-of-memory error that PyTorch's
          // allocator (expandable_segments) retries/handles. TRELLIS-2
          // legitimately needs ~15.6/16 GB, which exceeds a 90% slider cap,
          // so suspending here only freezes a perfectly healthy job. Like
          // GPU%/TEMP below, the VRAM slider stays a SOFT limit (throttle
          // via gpu_throttle.py), not a panic suspend.
          if (_vramFrac > 0 && vramTotal > 0) {
            const _vramLimitMB = vramTotal * _vramFrac;
            if (vramUsed > _vramLimitMB * SAFETY_FRACTION) {
              _breaches.vram += 1;
              _detail = `VRAM ${vramUsed.toFixed(0)} MB > ${(_vramLimitMB * SAFETY_FRACTION).toFixed(0)} MB (${(SAFETY_FRACTION*100).toFixed(0)}% of ${(_vramFrac * 100).toFixed(0)}% cap on ${vramTotal} MB) — CUDA OOM-guards, NOT suspending`;
              // intentionally NO `_tripped = 'vram'` — suspending can't free
              // VRAM and would deadlock the job. See comment above.
            } else _breaches.vram = 0;
          }
          // NOTE: GPU util % and TEMP are NOT safety-killed here.
          // - GPU 100% is the normal/healthy state during a 3D inference;
          //   killing on GPU% would tear down every healthy job (mygale
          //   was killed at GPU 97% > 89%, but the job was fine).
          // - TEMP throttling is already handled by gpu_throttle.py inside
          //   each Python bridge (sleeps between steps when temp too high).
          //   No need to kill — let the throttle slow the work instead.
          // The GPU and TEMP sliders STILL apply via gpu_throttle.py
          // (read FABMESH_GPU_LIMIT / FABMESH_TEMP_LIMIT). They are
          // soft limits (throttle), not panic kills.
        }
      } catch (e) { /* nvidia-smi failed; skip GPU checks this tick */ }
    }
    if (_tripped) {
      // SUSPEND instead of kill: freeze the Python process so it stops
      // allocating. Windows can then swap its pages out, RAM falls,
      // and we resume the process. The job slows down (stop/start) but
      // stays alive and never crashes the PC.
      if (!proc._suspended && !proc._suspendGaveUp) {
        log.warn('main', `[safety] SUSPEND ${_tripped.toUpperCase()}: ${_detail} — freezing pid=${proc.pid} (will resume when below 85% of limit)`);
        try { safeSend('limit-suspend', { metric: _tripped, detail: _detail, job: jobName }); } catch (e) {}
        try {
          require('child_process').execFileSync(
            'powershell', ['-NoProfile', '-Command',
              `$sig='[DllImport(\"ntdll.dll\")] public static extern int NtSuspendProcess(IntPtr h);'; ` +
              `Add-Type -MemberDefinition $sig -Name N -Namespace W -ErrorAction SilentlyContinue; ` +
              `$p=Get-Process -Id ${proc.pid} -ErrorAction SilentlyContinue; ` +
              `if ($p) { [W.N]::NtSuspendProcess($p.Handle) | Out-Null }`
            // 2026-06-13: 3000ms was too short — PowerShell cold-start +
            // Add-Type C# compile takes 5-8s when the box is already
            // under heavy GPU/RAM load (exactly when this fires), so it
            // ETIMEDOUT every tick and spam-spawned PowerShell, making
            // the load worse. Bumped to 15s + give-up backoff below.
            ], { stdio: 'ignore', timeout: 15000 }
          );
          proc._suspended = true;
          proc._suspendFails = 0;
        } catch (e) {
          proc._suspendFails = (proc._suspendFails || 0) + 1;
          log.warn('main', `[safety] suspend failed for pid=${proc.pid} (attempt ${proc._suspendFails}): ${e.message}`);
          // After 2 failed attempts, stop trying — re-spawning PowerShell
          // every monitoring tick only compounds the load it's meant to
          // relieve. Let the process run; nvidia-smi/torch will OOM-guard
          // on their own, and the user can still cancel manually.
          if (proc._suspendFails >= 2) {
            proc._suspendGaveUp = true;
            log.warn('main', `[safety] giving up suspend for pid=${proc.pid} after ${proc._suspendFails} timeouts — letting it run`);
          }
        }
      }
    } else if (proc._suspended) {
      // We're suspended AND no metric is tripped — check if we should resume.
      // Resume hysteresis: only resume when usage falls below 85% of limit
      // (avoid oscillating between suspend/resume).
      let _stillHigh = false;
      if (_ramLimitMB > 0 && _usedMB > _ramLimitMB * 0.85) _stillHigh = true;
      // (VRAM hysteresis would need re-querying nvidia-smi — keep simple,
      //  rely on RAM being the dominant trigger.)
      if (!_stillHigh) {
        log.info('main', `[safety] RESUME pid=${proc.pid} (RAM ${_usedMB.toFixed(0)} MB now under 85% of ${_ramLimitMB} MB)`);
        try { safeSend('limit-resume', { job: jobName }); } catch (e) {}
        try {
          require('child_process').execFileSync(
            'powershell', ['-NoProfile', '-Command',
              `$sig='[DllImport(\"ntdll.dll\")] public static extern int NtResumeProcess(IntPtr h);'; ` +
              `Add-Type -MemberDefinition $sig -Name N -Namespace W -ErrorAction SilentlyContinue; ` +
              `$p=Get-Process -Id ${proc.pid} -ErrorAction SilentlyContinue; ` +
              `if ($p) { [W.N]::NtResumeProcess($p.Handle) | Out-Null }`
            ], { stdio: 'ignore', timeout: 15000 }
          );
          proc._suspended = false;
        } catch (e) {
          log.warn('main', `[safety] resume failed for pid=${proc.pid}: ${e.message}`);
        }
      }
    } else if (_detail) {
      // Throttle: the watchdog is warn-only now, so it must NOT log every
      // tick — that bloated fabmesh.log to tens of MB and buried the real
      // pipeline output. Warn at most once per 30s per process.
      const _now = Date.now();
      if (!proc._lastSafetyWarn || _now - proc._lastSafetyWarn > 30000) {
        proc._lastSafetyWarn = _now;
        log.warn('main', `[safety] ${_detail} (consecutive ${Math.max(_breaches.ram, _breaches.vram, _breaches.gpu, _breaches.temp)}/2)`);
      }
    }
    // 5s cadence (was 1s): nothing suspends anymore, so the watchdog only
    // needs to advise. Polling nvidia-smi synchronously every second was
    // pure overhead (and ran nvidia-smi ON the GPU the job is using).
  }, 5000);
  proc.on('exit', () => clearInterval(_interval));
  proc.on('close', () => clearInterval(_interval));
}

// Back-compat alias: legacy spawn sites call installJobLimitsWatchdog.
// Apply BOTH the working-set cap (preventive) AND the safety kill
// (emergency last line of defense for ALL 4 limits).
function installJobLimitsWatchdog(proc, jobName) {
  setProcessHardMemoryLimit(proc, jobName);
  installAllLimitsSafetyKill(proc, jobName);
}

function killProcTree(proc) {
  if (process.platform !== 'win32' || !proc.pid) {
    try { proc.kill('SIGKILL'); } catch (e) {}
    return;
  }
  // Two-step Windows kill: taskkill /T /F is usually enough but fails on
  // CUDA-zombie processes (driver hang). PowerShell Stop-Process gets them.
  const pid = String(proc.pid);
  try {
    require('child_process').execFileSync('taskkill', ['/pid', pid, '/T', '/F'], { stdio: 'ignore' });
  } catch (e) {
    log.warn('main', `killProcTree taskkill failed for pid=${pid}, trying Stop-Process: ${e.message}`);
    try {
      require('child_process').execFileSync(
        'powershell', ['-NoProfile', '-Command', `Stop-Process -Force -Id ${pid} -ErrorAction Stop`],
        { stdio: 'ignore' }
      );
      log.info('main', `Stop-Process succeeded for pid=${pid}`);
    } catch (e2) {
      log.error('main', `killProcTree FAILED for pid=${pid} (both taskkill and Stop-Process): ${e2.message}`);
    }
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
      const pidStr = String(pid);
      try {
        require('child_process').execFileSync('taskkill', ['/pid', pidStr, '/T', '/F'], { stdio: 'ignore' });
        log.info('main', `Killed orphan python pid=${pid}`);
      } catch (e) {
        // taskkill failed (usually CUDA-zombie) — fall back to PowerShell Stop-Process.
        try {
          require('child_process').execFileSync(
            'powershell', ['-NoProfile', '-Command', `Stop-Process -Force -Id ${pidStr} -ErrorAction Stop`],
            { stdio: 'ignore' }
          );
          log.info('main', `Killed orphan python pid=${pid} via Stop-Process fallback`);
        } catch (e2) {
          log.warn('main', `Could NOT kill pid=${pid} (both taskkill and Stop-Process failed) — process is CUDA-locked, RAM will leak until reboot: ${e2.message}`);
        }
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

// IPC: calibration pipeline
ipcMain.handle('calib-run', async (event, { skipSf3d = false, env = {}, tag = '' } = {}) => {
  const calibScript = path.join(SCRIPTS_DIR, 'calibrate.py');
  const args = [calibScript];
  if (skipSf3d) args.push('--skip-sf3d');
  if (tag) { args.push('--tag', String(tag)); }
  for (const [k, v] of Object.entries(env || {})) {
    args.push('--env', `${k}=${v}`);
  }
  return new Promise((resolve) => {
    const proc = execFile(_aiPython(), args, {
      timeout: 1800000, maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, PYTHONUNBUFFERED: '1', HF_HOME: HF_CACHE_DIR, HUGGINGFACE_HUB_CACHE: path.join(HF_CACHE_DIR, 'hub') },
      cwd: path.join(__dirname, '..', '..'),
    }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: error.message, stderr: (stderr || '').slice(-500) });
        return;
      }
      // Find the latest report
      try {
        const reportsDir = path.join(__dirname, '..', '..', 'images', '_calibration', 'reports');
        const entries = fs.readdirSync(reportsDir)
          .filter(n => !n.startsWith('sweep_'))
          .map(n => ({ n, t: fs.statSync(path.join(reportsDir, n)).mtimeMs }))
          .sort((a, b) => b.t - a.t);
        if (!entries.length) { resolve({ success: true, score: null }); return; }
        const reportPath = path.join(reportsDir, entries[0].n);
        const scorePath = path.join(reportPath, 'score.json');
        const score = JSON.parse(fs.readFileSync(scorePath, 'utf-8'));
        resolve({ success: true, score, reportDir: reportPath, reportHtml: path.join(reportPath, 'index.html') });
      } catch (e) {
        resolve({ success: false, error: e.message });
      }
    });
    proc.stdout?.on('data', d => safeSend('calib-progress', d.toString()));
    proc.stderr?.on('data', d => safeSend('calib-progress', '[stderr] ' + d.toString()));
  });
});

ipcMain.handle('calib-last-report', () => {
  try {
    const reportsDir = path.join(__dirname, '..', '..', 'images', '_calibration', 'reports');
    if (!fs.existsSync(reportsDir)) return { success: false, error: 'no reports dir' };
    const entries = fs.readdirSync(reportsDir)
      .filter(n => !n.startsWith('sweep_'))
      .map(n => ({ n, t: fs.statSync(path.join(reportsDir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (!entries.length) return { success: false, error: 'no reports' };
    const reportPath = path.join(reportsDir, entries[0].n);
    const scorePath = path.join(reportPath, 'score.json');
    const score = JSON.parse(fs.readFileSync(scorePath, 'utf-8'));
    return { success: true, score, reportDir: reportPath, reportHtml: path.join(reportPath, 'index.html') };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('calib-open-report', (event, { html } = {}) => {
  try {
    if (html && fs.existsSync(html)) { shell.openPath(html); return { success: true }; }
    // default: latest
    const reportsDir = path.join(__dirname, '..', '..', 'images', '_calibration', 'reports');
    const entries = fs.readdirSync(reportsDir)
      .filter(n => !n.startsWith('sweep_'))
      .map(n => ({ n, t: fs.statSync(path.join(reportsDir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (!entries.length) return { success: false, error: 'no reports' };
    const p = path.join(reportsDir, entries[0].n, 'index.html');
    shell.openPath(p);
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

let _calibDiagnoseProc = null;
let _calibCancelFlag = false;

ipcMain.handle('calib-cancel', () => {
  if (_calibDiagnoseProc && !_calibDiagnoseProc.killed) {
    try {
      _calibCancelFlag = true;
      // Kill the python process AND its children (SF3D subprocess etc.)
      if (process.platform === 'win32') {
        require('child_process').execSync(`taskkill /pid ${_calibDiagnoseProc.pid} /T /F`, { stdio: 'ignore' });
      } else {
        _calibDiagnoseProc.kill('SIGTERM');
      }
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  }
  return { success: false, error: 'no active calibration' };
});

ipcMain.handle('calib-v3', async (event, opts = {}) => {
  // Calibration v3: per-stage independent checks.
  // Stage 4 runs unconditionally (deterministic, ~7s, no SF3D/Zero123++).
  // Other stages run only if --ref / --mesh / --mv-dir are passed.
  const script = path.join(SCRIPTS_DIR, 'run_calibration_v3.py');
  const args = [script];
  if (opts.ref) args.push('--ref', opts.ref);
  if (opts.mvDir) args.push('--mv-dir', opts.mvDir);
  if (opts.mesh) args.push('--mesh', opts.mesh);
  if (opts.skipStage4) args.push('--skip-stage4');
  return new Promise((resolve) => {
    _calibCancelFlag = false;
    const proc = execFile(_aiPython(), args, {
      timeout: 3600000, maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, PYTHONUNBUFFERED: '1', HF_HOME: HF_CACHE_DIR, HUGGINGFACE_HUB_CACHE: path.join(HF_CACHE_DIR, 'hub') },
      cwd: path.join(__dirname, '..', '..'),
    }, (error, stdout, stderr) => {
      _calibDiagnoseProc = null;
      // Exit 1 is not a fatal error for v3 — it means "at least one stage
      // failed". The CALIB_RESULT line in stdout still has the data we need.
      // Only treat as fatal if the process was cancelled or stdout is empty.
      const cancelled = _calibCancelFlag && error;
      _calibCancelFlag = false;
      if (cancelled) {
        return resolve({ success: false, cancelled: true,
                         error: 'cancelled by user' });
      }
      const m = (stdout || '').match(/CALIB_RESULT:\s*(\{[\s\S]+?\})\s*$/m);
      if (m) {
        try { return resolve({ success: true, result: JSON.parse(m[1]) }); }
        catch (e) { return resolve({ success: false, error: e.message }); }
      }
      // No CALIB_RESULT line — real failure
      resolve({ success: false,
                error: error ? error.message : 'no CALIB_RESULT line',
                stderr: (stderr || '').slice(-800),
                stdout: (stdout || '').slice(-1200) });
    });
    _calibDiagnoseProc = proc;
    proc.stdout?.on('data', d => safeSend('calib-progress', d.toString()));
    proc.stderr?.on('data', d => safeSend('calib-progress', '[stderr] ' + d.toString()));
  });
});

// calib-tiered and calib-diagnose IPC handlers removed in 2026-05-18 legal
// cleanup — their Python scripts (_calib_tiered.py, _calib_diagnose.py) were
// never in the repo, so the handlers had no implementation. calib-v3 above
// is the live calibration path.
ipcMain.handle('calib-tiered', async () => {
  return { success: false, error: 'calib-tiered removed — use calib-v3' };
});

ipcMain.handle('calib-diagnose', async (_event, { engine = 'sf3d' } = {}) => {
  return { success: false, error: 'calib-diagnose removed — use calib-v3' };
});

ipcMain.handle('calib-read-log', (event, { lines = 500 } = {}) => {
  try {
    // Read from the main fabmesh.log, filter lines with the [calib] source.
    if (!fs.existsSync(LOG_FILE)) return { success: true, log: '(no log yet)' };
    const content = fs.readFileSync(LOG_FILE, 'utf-8');
    const calibLines = content.split(/\r?\n/).filter(l => l.includes('[calib]'));
    const tail = calibLines.slice(-lines).join('\n');
    return { success: true, log: tail, total_bytes: content.length, path: LOG_FILE };
  } catch (e) { return { success: false, error: e.message }; }
});

// No separate calib log to clear — fabmesh.log rotation handles size.
// The 'clear' button in the UI now just refreshes the filtered view.
ipcMain.handle('calib-clear-log', () => {
  return { success: false, error: 'calibration entries are part of logs/fabmesh.log; use log rotation instead' };
});

// List every report dir with score.json — fed into the in-app gallery.
ipcMain.handle('calib-list-reports', () => {
  try {
    const reportsDir = path.join(__dirname, '..', '..', 'images', '_calibration', 'reports');
    if (!fs.existsSync(reportsDir)) return { success: true, reports: [] };
    const out = [];
    for (const name of fs.readdirSync(reportsDir)) {
      if (name.startsWith('sweep_')) continue;
      const dir = path.join(reportsDir, name);
      const scorePath = path.join(dir, 'score.json');
      if (!fs.existsSync(scorePath)) continue;
      try {
        const s = JSON.parse(fs.readFileSync(scorePath, 'utf-8'));
        out.push({
          name,
          dir,
          mtime: fs.statSync(dir).mtimeMs,
          score: s.score,
          total: s.total,
          similarity: s.avg_similarity,
          timestamp: s.timestamp,
          mesh: s.mesh,
          results: s.results,
        });
      } catch (e) {}
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return { success: true, reports: out };
  } catch (e) { return { success: false, error: e.message }; }
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

// Save the emissive mask of an image as a real file in the project folder, in an
// `_emissive/` subfolder so it never shows up as a gallery version. This makes
// the emissive map a persistent asset (the 3D pipeline / export can pick it up),
// not just a localStorage dataURL.
ipcMain.handle('save-emissive-file', (event, { imagePath, dataUrl }) => {
  try {
    if (!imagePath || !dataUrl) return { success: false, error: 'Missing args' };
    if (!isPathAllowed(imagePath)) return { success: false, error: 'Path not allowed' };
    const dir = path.join(path.dirname(imagePath), '_emissive');
    fs.mkdirSync(dir, { recursive: true });
    const base = path.basename(imagePath, path.extname(imagePath));
    const outPath = path.join(dir, `${base}.png`);
    const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
    return { success: true, path: outPath };
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

    const script = path.join(SCRIPTS_DIR, 'image_adjust_bridge.py');

    return await new Promise((resolve) => {
      const proc = execFile(_aiPython(), [script, operation, imagePath, newImagePath], {
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
    const registryPath = path.join(SCRIPTS_DIR, 'rig_templates', 'skm', 'registry.json');
    if (!fs.existsSync(registryPath)) return { success: false, error: 'registry missing' };
    const reg = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    const tpl = (reg.skm_templates || []).find(t => t.id === templateId);
    if (!tpl) return { success: false, error: 'template not in registry' };
    const fbxPath = path.join(SCRIPTS_DIR, 'rig_templates', tpl.fbx);
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
    const script = path.join(SCRIPTS_DIR, 'analyze_skeleton.py');

    return await new Promise((resolve) => {
      const proc = execFile(_aiPython(), [script, fbxPath, cachePath, config.blenderPath], {
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
    const registryPath = path.join(SCRIPTS_DIR, 'rig_templates', 'skm', 'registry.json');
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
    const dir = path.join(SCRIPTS_DIR, 'rig_templates', 'animations', templateName);
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

// Read a target skeleton .bones.json template and return its bone count
ipcMain.handle('read-bones-json', async (_event, targetName) => {
  const safe = String(targetName || '').replace(/[^a-z0-9_-]/gi, '');
  if (!safe) return { ok: false, error: 'name required' };
  const p = path.join(SCRIPTS_DIR, 'rig_templates', 'skm', safe + '.bones.json');
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const bones = Array.isArray(raw.bones) ? raw.bones : [];
    return { ok: true, count: bones.length, name: safe };
  } catch (e) {
    return { ok: false, error: String(e.message || e), name: safe };
  }
});

// Auto-rigging via Puppeteer (default) or UniRig fallback → rename to target skeleton (orc_m1 UE5 etc.) → bake anims
ipcMain.handle('auto-rig-ai', async (event, { meshPath, engine, skeleton }) => {
  const _t0 = Date.now();
  const rigEngine = engine || 'puppeteer';
  const rigSkeleton = (skeleton || 'orc_m1').replace(/[^a-z0-9_-]/gi, '');
  console.log(`[auto-rig-ai] START mesh=${meshPath} engine=${rigEngine} skeleton=${rigSkeleton} @${new Date(_t0).toISOString()}`);
  try {
    if (rigEngine !== 'puppeteer') await _freeSdxlForHeavyOp('rigging IA');
    if (!meshPath || !fs.existsSync(meshPath)) {
      return { success: false, error: 'Mesh not found' };
    }
    if (!isPathAllowed(meshPath)) {
      return { success: false, error: 'Mesh path not allowed' };
    }
    const scriptsDir = path.join(SCRIPTS_DIR);

    // ------------------------------------------------------------------
    // Step-1 bridge selection: Puppeteer (default) or UniRig (legacy fallback)
    // Both bridges share the same CLI contract: <mesh_path> <output_glb>
    // Step-2 (swap_skeleton) and Step-3 (bake_procedural_anims) are shared.
    // ------------------------------------------------------------------
    const unirigScript = path.join(scriptsDir, 'unirig_bridge.py');
    const puppeteerScript = path.join(scriptsDir, 'puppeteer_bridge.py');
    const swapScript = path.join(scriptsDir, 'swap_skeleton.py');
    const bakeAnimScript = path.join(scriptsDir, 'bake_procedural_anims.py');
    const orcBones = path.join(scriptsDir, 'rig_templates', 'skm', 'orc_m1.bones.json');
    // Packaged: rig env + code tree provisioned by wizard:install-rig under
    // HEAVY_DIR. Dev: the external/Puppeteer checkout + its venv, as before.
    const puppeteerRoot = app.isPackaged
      ? PUPPETEER_DIR
      : path.join(__dirname, '..', '..', 'external', 'Puppeteer');
    const puppeteerVenvPython = app.isPackaged
      ? path.join(RIG_PYTHON_DIR, 'python.exe')
      : path.join(puppeteerRoot, 'venv', 'Scripts', 'python.exe');

    // Resolve step-1 bridge + python interpreter based on selected engine
    let step1Script;
    let step1Python = 'python';
    let step1Label;
    let engineSuffix;
    if (rigEngine === 'unirig') {
      // Legacy path: bridge handles its own venv switching internally
      if (!fs.existsSync(unirigScript)) {
        return { success: false, error: 'unirig_bridge.py not found' };
      }
      step1Script = unirigScript;
      step1Label = 'UniRig';
      engineSuffix = 'unirig';
    } else {
      // Default: Puppeteer
      if (!fs.existsSync(puppeteerScript)) {
        return { success: false, error: 'puppeteer_bridge.py not found' };
      }
      if (!fs.existsSync(puppeteerVenvPython)) {
        return { success: false, error: app.isPackaged
          ? 'Rig engine not installed yet. Open Settings → Reconfigure FabMesh and complete the "Rig engine" step of the setup wizard (~14 GB download).'
          : 'Puppeteer venv not found at external/Puppeteer/venv (dev checkout missing).' };
      }
      if (app.isPackaged && !fs.existsSync(path.join(puppeteerRoot, 'skeleton', 'demo.py'))) {
        return { success: false, error: 'Rig engine files missing. Open Settings → Reconfigure FabMesh and re-run the "Rig engine" setup step.' };
      }
      step1Script = puppeteerScript;
      step1Python = puppeteerVenvPython;
      step1Label = 'Puppeteer';
      engineSuffix = 'puppeteer';
    }

    if (!fs.existsSync(swapScript)) {
      return { success: false, error: 'swap_skeleton.py not found' };
    }
    const baseName = path.basename(meshPath, path.extname(meshPath)).replace(/[^a-zA-Z0-9_-]/g, '_');
    const rigTs = Date.now();
    const tempUnirigGlb = path.join(MESHES_DIR, `${baseName}_${engineSuffix}_temp_${rigTs}.glb`);
    const tempSwapGlb = path.join(MESHES_DIR, `${baseName}_swap_temp_${rigTs}.glb`);
    const outputGlb = path.join(MESHES_DIR, `${baseName}_rigged_${engineSuffix}_${rigTs}.glb`);

    // Helper: run a python script and stream progress
    const runStep = (label, args, pythonBin, extraEnv) => new Promise((resolve) => {
      safeSend('ai3d-progress', `[${label}] Starting...`);
      const proc = execFile(pythonBin || 'python', args, {
        timeout: 600000,
        maxBuffer: 50 * 1024 * 1024,
        ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
      }, (error, stdout, stderr) => {
        resolve({ error, stdout, stderr });
      });
      proc.stdout?.on('data', d => safeSend('ai3d-progress', `[${label}] ${d.toString()}`));
      proc.stderr?.on('data', d => safeSend('ai3d-progress', `[${label}][stderr] ${d.toString()}`));
      proc.on('error', e => resolve({ error: e, stdout: '', stderr: '' }));
    });

    // Step 1: AI skeleton+skin prediction → temp GLB (engine-dependent).
    // Packaged Puppeteer: route the bridge onto the provisioned tree/venv
    // + the shared HF cache (opt-350m config pre-seeded by install-rig).
    const step1Env = (engineSuffix === 'puppeteer' && app.isPackaged) ? {
      FABMESH_PUPPETEER_ROOT: puppeteerRoot,
      FABMESH_PUPPETEER_PYTHON: puppeteerVenvPython,
      HF_HOME: HF_CACHE_DIR,
      HUGGINGFACE_HUB_CACHE: path.join(HF_CACHE_DIR, 'hub'),
    } : undefined;
    const step1 = await runStep(step1Label, [step1Script, meshPath, tempUnirigGlb], step1Python, step1Env);
    if (step1.error || !fs.existsSync(tempUnirigGlb)) {
      const dur = ((Date.now() - _t0) / 1000).toFixed(2);
      console.log(`[auto-rig-ai] Step 1 FAILED duration=${dur}s`);
      try {
        fs.writeFileSync(
          path.join(LOGS_DIR, 'last_error.log'),
          `[${new Date().toISOString()}] auto-rig-ai step1 (duration=${dur}s)\nmesh: ${meshPath}\n\n=== STDOUT ===\n${step1.stdout || ''}\n\n=== STDERR ===\n${step1.stderr || ''}\n`
        );
      } catch (_e) {}
      const errMsg = extractErrorDetail(step1) || (step1.error && step1.error.message) || `${step1Label} failed - no output`;
      return { success: false, error: errMsg, stdout: step1.stdout, stderr: step1.stderr };
    }

    // Puppeteer pipeline (new):
    //   Step 2a: puppeteer_to_orc_m1.py renames joint0..joint33 -> orc_m1
    //            anatomical names (pelvis, spine_01, upperarm_l, ...) by
    //            walking the IBM-derived bind world positions. Keeps Puppeteer's
    //            own bind matrices + skin weights intact (no skeleton swap).
    //   Step 3:  bake_procedural_anims.py bakes CC0 Idle/Walk/Run onto the
    //            renamed skeleton (lookup by exact bone name).
    // UniRig pipeline (legacy): swap_skeleton.py + bake_procedural_anims.py.
    const puppeteerRenameScript = path.join(scriptsDir, 'puppeteer_to_skeleton.py');
    const legacyRenameScript = path.join(scriptsDir, 'puppeteer_to_orc_m1.py');
    let step2 = { error: null, stdout: '', stderr: '' };
    let step3 = { error: null, stdout: '', stderr: '' };

    if (rigEngine === 'puppeteer') {
      if (rigSkeleton === 'puppeteer_raw') {
        // Short-circuit: ship raw Puppeteer output, skip rename + bake
        console.log('[auto-rig-ai] skeleton=puppeteer_raw, shipping raw Puppeteer GLB');
        try { fs.copyFileSync(tempUnirigGlb, outputGlb); } catch (_e) {}
      } else if (fs.existsSync(puppeteerRenameScript)) {
        // Step 2a: rename Puppeteer joints to target skeleton convention
        step2 = await runStep('PuppeteerToSkeleton', [puppeteerRenameScript, '--target', rigSkeleton, tempUnirigGlb, tempSwapGlb], 'python');
        if (step2.error || !fs.existsSync(tempSwapGlb)) {
          // Fallback: ship raw Puppeteer output (un-renamed); anims skipped.
          console.log(`[auto-rig-ai] Step 2a (puppeteer_to_skeleton --target ${rigSkeleton}) failed, shipping raw Puppeteer GLB`);
          try { fs.copyFileSync(tempUnirigGlb, outputGlb); } catch (_e) {}
        } else {
          // Step 3: bake CC0 anims onto the renamed skeleton.
          // Puppeteer outputs a 34-bone skeleton (joint0..joint33 renamed to a
          // 34-name anatomical subset of orc_m1). The orc_m1 117-bone template
          // contains bones absent from the rigged GLB -> bake would emit tracks
          // for missing bones and the mesh would explode. Use the dedicated
          // puppeteer_default.bones.json (34 bones, same anatomical names with
          // proper parent hierarchy for the 34-bone reality) instead.
          const skelBones = path.join(scriptsDir, 'rig_templates', 'skm', 'puppeteer_default.bones.json');
          if (fs.existsSync(bakeAnimScript) && fs.existsSync(skelBones)) {
            step3 = await runStep('BakeAnims', [bakeAnimScript, tempSwapGlb, skelBones, outputGlb], 'python');
            if (step3.error || !fs.existsSync(outputGlb)) {
              console.log('[auto-rig-ai] Step 3 (bake anims) failed on Puppeteer, falling back to non-animated rig');
              try { fs.copyFileSync(tempSwapGlb, outputGlb); } catch (_e) {}
            }
          } else {
            try { fs.copyFileSync(tempSwapGlb, outputGlb); } catch (_e) {}
          }
        }
      } else if (fs.existsSync(legacyRenameScript)) {
        // Legacy fallback: orc_m1-only rename script
        console.log('[auto-rig-ai] puppeteer_to_skeleton.py not found, falling back to legacy puppeteer_to_orc_m1.py');
        step2 = await runStep('PuppeteerToOrcM1', [legacyRenameScript, tempUnirigGlb, tempSwapGlb], 'python');
        if (step2.error || !fs.existsSync(tempSwapGlb)) {
          try { fs.copyFileSync(tempUnirigGlb, outputGlb); } catch (_e) {}
        } else if (fs.existsSync(bakeAnimScript)) {
          step3 = await runStep('BakeAnims', [bakeAnimScript, tempSwapGlb, orcBones, outputGlb], 'python');
          if (step3.error || !fs.existsSync(outputGlb)) {
            try { fs.copyFileSync(tempSwapGlb, outputGlb); } catch (_e) {}
          }
        } else {
          try { fs.copyFileSync(tempSwapGlb, outputGlb); } catch (_e) {}
        }
      } else {
        // Script not yet deployed: ship raw Puppeteer output as before.
        console.log('[auto-rig-ai] no rename script found, shipping raw Puppeteer GLB');
        try { fs.copyFileSync(tempUnirigGlb, outputGlb); } catch (_e) {}
      }
      // Cleanup temps
      try { if (fs.existsSync(tempUnirigGlb)) fs.unlinkSync(tempUnirigGlb); } catch (_e) {}
      try { if (fs.existsSync(tempSwapGlb)) fs.unlinkSync(tempSwapGlb); } catch (_e) {}
    } else {
      // Step 2: Swap skeleton to orc_m1 (117 bones) → temp swap GLB
      step2 = await runStep('SwapSkeleton', [swapScript, tempUnirigGlb, orcBones, tempSwapGlb]);
      // Clean up UniRig temp
      try { fs.unlinkSync(tempUnirigGlb); } catch (_e) {}

      if (step2.error || !fs.existsSync(tempSwapGlb)) {
        const dur2 = ((Date.now() - _t0) / 1000).toFixed(2);
        console.log(`[auto-rig-ai] Step 2 FAILED duration=${dur2}s`);
        try {
          fs.writeFileSync(
            path.join(LOGS_DIR, 'last_error.log'),
            `[${new Date().toISOString()}] auto-rig-ai step2 (duration=${dur2}s)\nmesh: ${meshPath}\n\n=== STEP1 STDOUT ===\n${step1.stdout || ''}\n=== STEP1 STDERR ===\n${step1.stderr || ''}\n\n=== STEP2 STDOUT ===\n${step2.stdout || ''}\n=== STEP2 STDERR ===\n${step2.stderr || ''}\n`
          );
        } catch (_e) {}
        const errMsg = extractErrorDetail(step2) || (step2.error && step2.error.message) || 'Skeleton swap failed - no output';
        return { success: false, error: errMsg, stdout: step2.stdout, stderr: step2.stderr };
      }

      // Step 3: Bake procedural Idle/Walk/Run (CC0) animations into final GLB
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
    }

    const dur = ((Date.now() - _t0) / 1000).toFixed(2);
    console.log(`[auto-rig-ai] END duration=${dur}s error=${!!step3.error}`);
    try {
      fs.writeFileSync(
        path.join(LOGS_DIR, 'last_error.log'),
        `[${new Date().toISOString()}] auto-rig-ai (duration=${dur}s)\nmesh: ${meshPath}\noutput: ${outputGlb}\n\n=== STEP1 STDOUT ===\n${step1.stdout || ''}\n=== STEP1 STDERR ===\n${step1.stderr || ''}\n\n=== STEP2 STDOUT ===\n${step2.stdout || ''}\n=== STEP2 STDERR ===\n${step2.stderr || ''}\n\n=== STEP3 STDOUT ===\n${step3.stdout || ''}\n=== STEP3 STDERR ===\n${step3.stderr || ''}\n`
      );
    } catch (_e) {}

    if (!fs.existsSync(outputGlb)) {
      const errMsg = extractErrorDetail(step3) || (step3.error && step3.error.message) || 'Bake procedural anims failed - no output';
      return { success: false, error: errMsg, stdout: step3.stdout, stderr: step3.stderr };
    }
    const stats = fs.statSync(outputGlb);
    // Lineage sidecar: engine + squelette cible + mesh parent explicite
    // (le squelette/assetType n'étaient persistés nulle part).
    writeMeta(outputGlb, {
      kind: 'rig', engine: rigEngine, parent: meshPath,
      params: { skeleton: rigSkeleton },
    });
    return { success: true, path: outputGlb, filename: path.basename(outputGlb), size: stats.size };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// AnyTop animation on a rigged GLB (desktop side). Spawns
// scripts/anytop_bridge.py via Python and writes the animated GLB
// under the project's animations/ folder.
ipcMain.handle('animate-ai', async (event, { rigPath, animType, prompt, engine, projectName }) => {
  const _t0 = Date.now();
  const safeAnim = (animType || 'idle').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'idle';
  console.log(`[animate-ai] START rig=${rigPath} engine=${engine || 'anytop'} animType=${safeAnim} @${new Date(_t0).toISOString()}`);
  try {
    if (!rigPath || !fs.existsSync(rigPath)) {
      return { success: false, error: 'Rig file not found' };
    }
    if (!isPathAllowed(rigPath)) {
      return { success: false, error: 'Rig path not allowed' };
    }
    if ((engine || 'anytop') !== 'anytop') {
      return { success: false, error: `Engine '${engine}' not implemented on desktop yet — only 'anytop' is wired` };
    }
    // Build output path: <project_dir>/animations/<animType>_<ts>.glb
    const rigDir = path.dirname(rigPath);
    // Prefer the project root (one up from meshes/ rigs/) if recognisable.
    let projectDir = rigDir;
    const parent = path.dirname(rigDir);
    if (path.basename(rigDir) === 'rigs' || path.basename(rigDir) === 'meshes') {
      projectDir = parent;
    }
    const animsDir = path.join(projectDir, 'animations');
    try { fs.mkdirSync(animsDir, { recursive: true }); } catch (_) {}
    const outPath = path.join(animsDir, `${safeAnim}_${Date.now()}.glb`);

    const bridge = path.join(SCRIPTS_DIR, 'anytop_bridge.py');
    if (!fs.existsSync(bridge)) {
      return { success: false, error: 'anytop_bridge.py missing — reinstall FabMesh' };
    }
    const args = [
      bridge,
      '--rig', rigPath,
      '--out', outPath,
      '--anim-type', safeAnim,
    ];
    if (prompt && typeof prompt === 'string') {
      args.push('--prompt', prompt.slice(0, 400));
    }
    const { spawn } = require('child_process');
    const proc = spawn(_aiPython(), args, { cwd: path.dirname(bridge) });
    let stderrBuf = '';
    let lastStdoutJson = null;
    proc.stdout?.on('data', (d) => {
      const txt = d.toString();
      safeSend('ai3d-progress', `[anytop] ${txt}`);
      // Capture last JSON line (error path prints a JSON dict on a single line).
      const lines = txt.split(/\r?\n/);
      for (const ln of lines) {
        const s = ln.trim();
        if (s.startsWith('{') && s.endsWith('}')) {
          try { lastStdoutJson = JSON.parse(s); } catch (_) {}
        }
      }
    });
    proc.stderr?.on('data', (d) => {
      const txt = d.toString();
      stderrBuf += txt;
      safeSend('ai3d-progress', `[anytop][stderr] ${txt}`);
    });
    const exitCode = await new Promise((resolve) => proc.on('close', resolve));
    if (exitCode !== 0) {
      const errMsg = lastStdoutJson?.error
        || stderrBuf.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ')
        || `python exit ${exitCode}`;
      // setup_required: surface as a friendlier error so the renderer can hint.
      if (lastStdoutJson?.setup_required) {
        return { success: false, error: errMsg, setupRequired: true };
      }
      return { success: false, error: errMsg };
    }
    if (!fs.existsSync(outPath)) {
      return { success: false, error: 'AnyTop ran but no output GLB was produced' };
    }
    console.log(`[animate-ai] DONE dt=${((Date.now()-_t0)/1000).toFixed(1)}s out=${outPath}`);
    return {
      success: true,
      ok: true,
      anim_url: outPath,
      path: outPath,
      animPath: outPath,
      type: safeAnim,
    };
  } catch (e) {
    console.error('[animate-ai] error:', e);
    return { success: false, error: e?.message || String(e) };
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

    const script = path.join(SCRIPTS_DIR, 'auto_rig_bridge.py');

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
      const proc = execFile(_aiPython(), args, {
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
            path.join(LOGS_DIR, 'last_error.log'),
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
      const n = new Notification({ title: title || 'MyFabmesh.AI', body: body || '', silent: false });
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
    let baseName = path.basename(filePath, ext).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30)
      .replace(/_+\d+$/, '').replace(/_+$/, '');   // no trailing digits -> meshProject round-trips
    if (!baseName) baseName = 'imported';
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

// Drag-and-drop import. Context-aware:
//  - dropped on the projects grid (no projectName) -> CREATE a new project
//    holding the dropped element.
//  - dropped inside an open project (projectName + intoImageDir given) -> ADD
//    a new VERSION of that element to the right strip (image / mesh / rig /
//    animation), attributed to the current project.
// File-type routing: image -> project image dir; *_rigged_*.glb -> rig strip;
// <a>__<b>.glb -> animations; any other model -> mesh strip. Mesh/rig names
// are crafted so meshProject() maps them back to the target project.
ipcMain.handle('import-dropped-file', (event, arg) => {
  try {
    const { filePath, projectName, intoImageDir } = arg || {};
    if (!filePath || !fs.existsSync(filePath)) return { success: false, error: 'file not found' };
    const ext = path.extname(filePath).toLowerCase();
    const baseName = path.basename(filePath, ext);
    const ts = Date.now();
    const IMG = ['.png', '.jpg', '.jpeg', '.webp'];
    const MODEL = ['.glb', '.gltf', '.obj', '.fbx', '.stl', '.ply'];
    const isImage = IMG.includes(ext);
    const isModel = MODEL.includes(ext);
    if (!isImage && !isModel) return { success: false, error: 'unsupported type' };
    const intoProj = !!projectName;
    const safeExt = ext === '.jpeg' ? '.jpg' : ext;

    if (isImage) {
      if (intoProj && intoImageDir) {
        // Guard: the target dir must live under IMAGES_DIR.
        const resolved = path.resolve(intoImageDir);
        if (!resolved.startsWith(path.resolve(IMAGES_DIR)) || !fs.existsSync(resolved)) {
          return { success: false, error: 'invalid project dir' };
        }
        // ref_ prefix + non-(_/.) name so the folder scan lists it.
        const dest = path.join(resolved, `ref_imported_${ts}${safeExt}`);
        fs.copyFileSync(filePath, dest);
        return { success: true, kind: 'image', version: true, path: dest };
      }
      // New project from the dropped image. If the renderer passed an explicit
      // projectName (drop on the projects grid -> the user named it in the New
      // Project popup), use THAT; otherwise derive the name from the filename.
      // Strip a trailing _<digits> from the base so the project name doesn't END
      // in digits — otherwise meshProject() (which strips trailing digits when
      // attributing a mesh) would later put the generated 3D in a DIFFERENT,
      // shorter project (the "dropped_<ts>" image vs "dropped" mesh split bug).
      const nameSource = (projectName && String(projectName).trim()) || baseName;
      const safeBase = (nameSource.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30)
        .replace(/_+\d+$/, '').replace(/_+$/, '')) || 'imported';
      const projDir = path.join(IMAGES_DIR, `${safeBase}_${ts}`);
      fs.mkdirSync(projDir, { recursive: true });
      const dest = path.join(projDir, `ref_0${safeExt}`);
      fs.copyFileSync(filePath, dest);
      try { fs.writeFileSync(path.join(projDir, 'prompt.txt'), '[Imported] ' + path.basename(filePath), 'utf-8'); } catch (_) {}
      return { success: true, kind: 'image', projectName: safeBase, path: dest };
    }

    // --- model: mesh / rig / animation ---
    const lower = path.basename(filePath).toLowerCase();
    const isRig = /_rigged_|rigged/.test(lower);
    const isAnim = ext === '.glb' && path.basename(baseName).includes('__');
    // Into an open project: keep its exact name. New project: strip trailing
    // digits so the mesh's derived project name is stable (see note above).
    const targetProj = intoProj
      ? (projectName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'imported')
      : ((baseName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
          .replace(/_+\d+$/, '').replace(/_+$/, '')) || 'imported');

    if (isAnim) {
      const animDir = path.join(MESHES_DIR, 'animated');
      fs.mkdirSync(animDir, { recursive: true });
      // <motion>__<rigStem> layout so it attributes to the project's rig.
      const dest = path.join(animDir, `imported_${ts}__${targetProj}${ext}`);
      fs.copyFileSync(filePath, dest);
      return { success: true, kind: 'anim', path: dest };
    }
    // mesh / rig -> MESHES_DIR named so meshProject() maps it to targetProj.
    const destName = isRig
      ? `${targetProj}_rigged_imported_${ts}${ext}`
      : `${targetProj}_${ts}${ext}`;
    const dest = path.join(MESHES_DIR, destName);
    fs.copyFileSync(filePath, dest);
    return { success: true, kind: isRig ? 'rig' : 'mesh', path: dest };
  } catch (e) {
    console.error('import-dropped-file failed:', e);
    return { success: false, error: e.message };
  }
});

// Download an image dragged from a web page (no local file path) to a temp
// file so the normal import flow can handle it. Follows redirects, picks the
// extension from the content-type, and refuses non-image responses.
ipcMain.handle('download-to-temp', async (event, url) => {
  return new Promise((resolve) => {
    try {
      if (!url || !/^https?:\/\//i.test(url)) return resolve({ success: false, error: 'invalid url' });
      const os = require('os');
      const tmpDir = path.join(os.tmpdir(), 'fabmesh_dl');
      try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) {}
      const doGet = (u, redirects) => {
        let mod;
        try { mod = u.startsWith('https') ? require('https') : require('http'); }
        catch (_) { return resolve({ success: false, error: 'no http module' }); }
        const req = mod.get(u, { headers: { 'User-Agent': 'Mozilla/5.0 FabMesh/1.0' }, timeout: 20000 }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
            res.resume();
            let next;
            try { next = new URL(res.headers.location, u).toString(); } catch (_) { next = res.headers.location; }
            return doGet(next, redirects + 1);
          }
          if (res.statusCode !== 200) { res.resume(); return resolve({ success: false, error: 'HTTP ' + res.statusCode }); }
          const ct = (res.headers['content-type'] || '').toLowerCase();
          let ext = '';
          if (ct.includes('jpeg') || ct.includes('jpg')) ext = '.jpg';
          else if (ct.includes('png')) ext = '.png';
          else if (ct.includes('webp')) ext = '.webp';
          else if (ct.includes('gif')) ext = '.gif';
          else if (!ct.includes('image')) { res.resume(); return resolve({ success: false, error: 'not an image (' + (ct || 'unknown') + ')' }); }
          else ext = '.png';
          const dest = path.join(tmpDir, `dropped_${Date.now()}${ext}`);
          const out = fs.createWriteStream(dest);
          let bytes = 0;
          res.on('data', (c) => { bytes += c.length; });
          res.pipe(out);
          out.on('finish', () => out.close(() => {
            if (bytes < 100) { try { fs.unlinkSync(dest); } catch (_) {} return resolve({ success: false, error: 'empty download' }); }
            resolve({ success: true, path: dest, filename: path.basename(dest) });
          }));
          out.on('error', (e) => resolve({ success: false, error: e.message }));
        });
        req.on('error', (e) => resolve({ success: false, error: e.message }));
        req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve({ success: false, error: 'timeout' }); });
      };
      doGet(url, 0);
    } catch (e) { resolve({ success: false, error: e.message }); }
  });
});

// Project rename = a DISPLAY-NAME override (stored in config), not a file
// rename. Renaming the image folder + every mesh/rig/animation filename would
// be error-prone (meshProject() parsing, animation rigStem links), so we keep
// the on-disk names as the stable internal key and only override what the UI
// shows. config.projectDisplayNames maps derivedName -> displayName.
ipcMain.handle('rename-project', (event, { oldName, newName }) => {
  try {
    if (!oldName) return { success: false, error: 'missing project' };
    const clean = String(newName || '').trim().slice(0, 60);
    const config = loadConfig();
    if (!config.projectDisplayNames) config.projectDisplayNames = {};
    if (!clean || clean === oldName) {
      delete config.projectDisplayNames[oldName];  // reset to derived name
      saveConfig(config);
      return { success: true, displayName: null };
    }
    config.projectDisplayNames[oldName] = clean;
    saveConfig(config);
    return { success: true, displayName: clean };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('get-project-display-names', () => {
  try { return loadConfig().projectDisplayNames || {}; }
  catch (_) { return {}; }
});

// TRUE project rename = rename the image folder + every mesh/rig/animation
// file on disk so the derived project name actually becomes newName. Mirrors
// the renderer's meshProject() to identify which files belong (NOT a naive
// prefix match — "orc" must not grab "orc_marron_*"). Plans every move first
// and aborts on any collision, so it never half-renames.
function _meshProjectBackend(filename) {
  let base = filename.replace(/\.[^.]+$/, '');
  base = base.replace(/_rigged_.+$/i, '');
  const POST = /_(cntile|retexture|decimate|subdivide|smooth|fill_holes|fix_normals|center|set_pivot|watertight|texture_var|trellis2_retex|upscale|refine|augment|vc)(?:_[A-Za-z0-9]{1,16})*$/i;
  let prev;
  do { prev = base; base = base.replace(POST, ''); base = base.replace(/_\d{10,}$/, ''); } while (base !== prev);
  base = base.replace(/_(sf3d|hunyuan|local|trellis2_native|trellis2|triposg|hi3dgen|ai)(?:_[A-Za-z0-9]{1,16})*$/i, '');
  base = base.replace(/_\d+$/, '');
  return base || 'untitled';
}
ipcMain.handle('rename-project-files', (event, { oldName, newName }) => {
  try {
    if (!oldName) return { success: false, error: 'missing project' };
    let newProj = String(newName || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
      .replace(/_+\d+$/, '').replace(/_+$/, '');   // no trailing digits -> meshProject round-trips
    if (!newProj) return { success: false, error: 'invalid name' };
    if (newProj === oldName) return { success: true, newName: oldName, renamed: {} };
    const _esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Reject if a DIFFERENT project already uses this derived name — two
    // projects with the same cleanName would silently MERGE in the grid.
    const _nameTaken = () => {
      if (fs.existsSync(IMAGES_DIR)) {
        for (const d of fs.readdirSync(IMAGES_DIR)) {
          try { if (!fs.statSync(path.join(IMAGES_DIR, d)).isDirectory()) continue; } catch (_) { continue; }
          if (d.replace(/_\d+$/, '') === newProj) return true;
        }
      }
      if (fs.existsSync(MESHES_DIR)) {
        for (const f of fs.readdirSync(MESHES_DIR)) {
          if (!/\.(glb|gltf|obj|fbx|stl|ply)$/i.test(f)) continue;
          if (_meshProjectBackend(f) === newProj) return true;
        }
      }
      return false;
    };
    if (_nameTaken()) return { success: false, error: `A project named "${newProj}" already exists — choose a different name.` };
    const ts = Date.now();
    const moves = [];   // [src, dest] — planned, executed only if no collision

    // 1. Image folder(s) whose cleanName == oldName.
    if (fs.existsSync(IMAGES_DIR)) {
      let fi = 0;
      for (const d of fs.readdirSync(IMAGES_DIR)) {
        const full = path.join(IMAGES_DIR, d);
        try { if (!fs.statSync(full).isDirectory()) continue; } catch (_) { continue; }
        if (d.replace(/_\d+$/, '') === oldName) {
          moves.push([full, path.join(IMAGES_DIR, `${newProj}_${ts}${fi ? '_' + fi : ''}`)]);
          fi++;
        }
      }
    }
    // 2. Mesh / rig files (+ their .source / _thumb sidecars) belonging to oldName.
    const meshRe = new RegExp('^' + _esc(oldName) + '(_|\\.)');
    if (fs.existsSync(MESHES_DIR)) {
      for (const f of fs.readdirSync(MESHES_DIR)) {
        const full = path.join(MESHES_DIR, f);
        try { if (!fs.statSync(full).isFile()) continue; } catch (_) { continue; }
        // Match the mesh itself OR its sidecars (X.glb.source / X_thumb.png).
        const meshBase = f.replace(/\.source$/, '').replace(/_thumb\.png$/, '');
        if (_meshProjectBackend(meshBase) === oldName && meshRe.test(f)) {
          moves.push([full, path.join(MESHES_DIR, f.replace(meshRe, newProj + '$1'))]);
        }
      }
      // 3. Animations: <motion>__<rigStem>.glb whose rigStem belongs to oldName.
      const animDir = path.join(MESHES_DIR, 'animated');
      if (fs.existsSync(animDir)) {
        for (const f of fs.readdirSync(animDir)) {
          const sep = f.indexOf('__');
          if (sep < 0) continue;
          const rigStem = f.slice(sep + 2).replace(/\.[^.]+$/, '');
          if (_meshProjectBackend(rigStem) === oldName && new RegExp('__' + _esc(oldName) + '(_|\\.)').test(f)) {
            moves.push([path.join(animDir, f), path.join(animDir, f.replace('__' + oldName, '__' + newProj))]);
          }
        }
      }
    }
    // Collision check — abort before touching anything if any dest exists.
    for (const [, dest] of moves) {
      if (fs.existsSync(dest)) return { success: false, error: `target already exists: ${path.basename(dest)}` };
    }
    // Execute.
    const renamed = { folders: 0, meshes: 0, rigs: 0, anims: 0, sidecars: 0 };
    const folderMap = [];     // [oldFolderBasename, newFolderBasename]
    const sourceDests = [];   // renamed .glb.source files to repath
    for (const [src, dest] of moves) {
      fs.renameSync(src, dest);
      if (src.includes(path.join(MESHES_DIR, 'animated'))) renamed.anims++;
      else if (/\.source$/.test(src)) { renamed.sidecars++; sourceDests.push(dest); }
      else if (/_thumb\.png$/.test(src)) renamed.sidecars++;
      else if (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) { renamed.folders++; folderMap.push([path.basename(src), path.basename(dest)]); }
      else if (/_rigged_/i.test(path.basename(src))) renamed.rigs++;
      else renamed.meshes++;
    }
    // Repath the source-image path stored inside each renamed .glb.source so it
    // points at the moved image folder (else the mesh's source link breaks).
    for (const sp of sourceDests) {
      try {
        let txt = fs.readFileSync(sp, 'utf-8');
        let changed = false;
        for (const [oldB, newB] of folderMap) {
          const re = new RegExp('([\\\\/])' + oldB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([\\\\/])', 'g');
          const nt = txt.replace(re, '$1' + newB + '$2');
          if (nt !== txt) { txt = nt; changed = true; }
        }
        if (changed) fs.writeFileSync(sp, txt, 'utf-8');
      } catch (_) {}
    }
    // Clear any stale display-name override for the old derived name.
    try {
      const config = loadConfig();
      if (config.projectDisplayNames && config.projectDisplayNames[oldName]) {
        delete config.projectDisplayNames[oldName];
        saveConfig(config);
      }
    } catch (_) {}
    return { success: true, newName: newProj, renamed };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Duplicate an image into a new version (same project dir, suffix + timestamp).
// Used by Multi-Views button so the original image stays untouched while the
// new version receives the 6-view dir + any subsequent view edits.
ipcMain.handle('duplicate-image-version', (event, { imagePath, suffix }) => {
  try {
    if (!imagePath || !fs.existsSync(imagePath)) {
      return { success: false, error: 'Source image not found' };
    }
    if (!isPathAllowed(imagePath)) {
      return { success: false, error: 'Path not allowed' };
    }
    const dir = path.dirname(imagePath);
    const ext = path.extname(imagePath);
    const base = path.basename(imagePath, ext);
    const safeSuffix = (suffix || 'copy').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 16);
    const ts = Date.now();
    const dest = path.join(dir, `${base}_${safeSuffix}_${ts}${ext}`);
    fs.copyFileSync(imagePath, dest);
    return { success: true, path: dest, filename: path.basename(dest) };
  } catch (e) {
    return { success: false, error: e.message };
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
    if (r.ok) {
      _handleMultiviewInheritance(newImagePath).catch(() => {});
      return { success: true, newPath: newImagePath };
    }
    return { success: false, error: r.error || 'SDXL server error' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Auto-inpaint: CLIPSeg segments target area + SDXL Inpainting replaces it
// Live mask preview for Auto Inpaint: run CLIPSeg detection ONLY (no inpaint)
// and return a red-overlay image so the user sees what will be repainted before
// committing. Reuses one temp file (cache-busted by the renderer).
ipcMain.handle('segment-mask', async (event, { imagePath, targetText, dilate, rel, binary }) => {
  try {
    if (!imagePath || !targetText || !String(targetText).trim()) return { success: false, error: 'missing target' };
    await ensureSdxlServer();
    if (!sdxlReady) return { success: false, error: 'engine not ready' };
    // binary mode (AI region re-texture) -> white/black mask in a distinct file so it
    // doesn't clobber the red preview overlay used by Recolor/Auto-inpaint.
    const outPath = path.join(require('os').tmpdir(), binary ? 'fabmesh_mask_bin.png' : 'fabmesh_mask_preview.png');
    const r = await sdxlServerCall('/segment', {
      input: imagePath, target: targetText, output: outPath, dilate: dilate || 15,
      rel: (rel != null ? rel : 0.5), binary: !!binary,
    });
    if (r && r.ok && fs.existsSync(outPath)) {
      return { success: true, overlayPath: outPath, coverage: r.coverage };
    }
    return { success: false, error: (r && r.error) || 'segment failed' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Texture variant: ControlNet-Tile re-texture (shape/geometry locked) — used by the
// Variante tool's "vary texture only" mode. Each seed = a different surface/texture.
// Enhance the FINAL mesh texture: Real-ESRGAN x2 on the baked baseColor atlas
// (texture_upscale.py extracts -> upscales -> re-packs the GLB). Sharper texture
// WITHOUT inventing content (unlike SDXL refine) and without re-generating geometry.
ipcMain.handle('enhance-mesh-texture', async (event, { meshPath, jobId }) => {
  try {
    if (!meshPath || !fs.existsSync(meshPath)) return { success: false, error: 'Mesh not found' };
    const dir = path.dirname(meshPath);
    const ext = path.extname(meshPath) || '.glb';
    const base = safeBase(path.basename(meshPath, ext));
    const newMeshPath = path.join(dir, `${base}_enhanced_${Date.now()}${ext}`);
    const venvPy = path.join(__dirname, '..', '..', 'external', 'TRELLIS2_win', '.venv', 'Scripts', 'python.exe');
    const py = fs.existsSync(venvPy) ? venvPy : 'python';
    const UPSCALE_SCRIPT = path.join(SCRIPTS_DIR, 'texture_upscale.py');
    return await new Promise((resolve) => {
      const proc = execFile(py, [UPSCALE_SCRIPT, meshPath, newMeshPath, '--scale', '2', '--tile', '512'],
        { timeout: 600000, maxBuffer: 50 * 1024 * 1024 }, (error) => {
          if (!error && fs.existsSync(newMeshPath)) resolve({ success: true, newPath: newMeshPath });
          else resolve({ success: false, error: (error?.message || 'texture enhance failed').slice(-300) });
        });
      proc.stdout?.on('data', d => safeSend('ai3d-progress', d.toString()));
      proc.stderr?.on('data', d => safeSend('ai3d-progress', '[stderr] ' + d.toString()));
      if (jobId) activeProcs.set(jobId, proc);
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Détail++ : render -> SDXL ControlNet-Tile refine -> reproject. Adds GENUINE
// high-frequency surface detail beyond the TRELLIS-2 ceiling (scripts/detail_synth.py).
// REQUIRES the SDXL tile server up (stage 2 POSTs to /img2img_tile). Returns the
// same { success, newPath } shape as enhance-mesh-texture so the renderer treats
// the result identically (adds it as a new mesh version).
const DETAIL_SYNTH_PROMPTS = {
  character: 'highly detailed character, sharp fine surface detail, realistic skin fabric and metal, intricate crisp texture, photoreal high detail',
  humanoid: 'highly detailed character, sharp fine surface detail, realistic skin fabric and metal, intricate crisp texture, photoreal high detail',
  armor: 'polished steel armor plates, riveted scales, crisp metallic highlights, intricate engraved detail, photoreal forged metal',
  knight: 'polished steel armor plates, riveted scales, crisp metallic highlights, intricate engraved detail, photoreal forged metal',
  creature: 'detailed creature skin, scales fur and horn, sharp organic surface detail, photoreal',
  beast: 'detailed creature skin, scales fur and horn, sharp organic surface detail, photoreal',
  animal: 'detailed creature skin, scales fur and horn, sharp organic surface detail, photoreal',
  vehicle: 'polished panels, sharp mechanical detail, crisp edges, realistic worn metal and paint',
};
const DETAIL_SYNTH_DEFAULT_PROMPT = 'sharp intricate fine surface detail, crisp high-detail texture, photoreal materials';

ipcMain.handle('detail-synth', async (event, { meshPath, jobId, strength, prompt, assetType, textureSize }) => {
  try {
    if (!meshPath || !fs.existsSync(meshPath)) return { success: false, error: 'Mesh not found' };
    // Stage 2 POSTs renders to the SDXL tile server — make sure it's up first.
    await ensureSdxlServer();
    if (!sdxlReady) return { success: false, error: 'SDXL server failed to start. Try again in a few seconds.' };
    const dir = path.dirname(meshPath);
    const ext = path.extname(meshPath) || '.glb';
    const base = safeBase(path.basename(meshPath, ext));
    const ts = Date.now();
    const outPath = path.join(dir, `${base}_detail_${ts}${ext}`);
    // Derive a default prompt from the asset type when the caller didn't pass one.
    const effPrompt = (prompt && String(prompt).trim())
      ? String(prompt)
      : (DETAIL_SYNTH_PROMPTS[String(assetType || '').toLowerCase()] || DETAIL_SYNTH_DEFAULT_PROMPT);
    const workdir = path.join(dir, '.debug', `detail_${ts}`);
    try { fs.mkdirSync(workdir, { recursive: true }); } catch (e) {}
    const DETAIL_SCRIPT = path.join(SCRIPTS_DIR, 'detail_synth.py');
    // detail_synth.py imports trimesh / nvdiffrast / requests — uses SYSTEM python
    // (NOT the trellis venv), same as the mesh-tool handler.
    const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
    return await new Promise((resolve) => {
      const proc = execFile(_aiPython(), [
        DETAIL_SCRIPT, meshPath, outPath,
        '--strength', String(strength != null ? strength : 0.5),
        '--texture-size', String(textureSize != null ? textureSize : 4096),
        '--prompt', effPrompt,
        '--workdir', workdir,
      ], { timeout: 600000, maxBuffer: 50 * 1024 * 1024, env }, (error) => {
        if (!error && fs.existsSync(outPath)) resolve({ success: true, newPath: outPath });
        else resolve({ success: false, error: (error?.message || 'detail synth failed').slice(-300) });
      });
      proc.stdout?.on('data', d => safeSend('ai3d-progress', d.toString()));
      proc.stderr?.on('data', d => safeSend('ai3d-progress', '[stderr] ' + d.toString()));
      if (jobId) activeProcs.set(jobId, proc);
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('tex-variant', async (event, { imagePath, prompt, strength, seed, cnScale, negPrompt }) => {
  try {
    const dir = path.dirname(imagePath);
    const ext = path.extname(imagePath);
    const base = safeBase(path.basename(imagePath, ext));
    const _uniq = (seed != null && seed !== '') ? seed : Math.floor(Math.random() * 1e9);
    const newImagePath = path.join(dir, `${base}_texvar_${Date.now()}_${_uniq}${ext}`);
    await ensureSdxlServer();
    if (!sdxlReady) return { success: false, error: 'SDXL server failed to start. Try again in a few seconds.' };
    const r = await sdxlServerCall('/tex_variant', {
      input: imagePath, prompt: prompt || '', output: newImagePath,
      strength: (strength != null ? strength : 0.45), seed: parseInt(_uniq),
      cn_scale: (cnScale != null ? cnScale : 0.45), neg_prompt: negPrompt || null,
    });
    if (r.ok) {
      _handleMultiviewInheritance(newImagePath).catch(() => {});
      return { success: true, newPath: newImagePath };
    }
    return { success: false, error: r.error || 'texture variant failed' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Recolor: auto-detect a part (CLIPSeg) and recolor ONLY it, shape preserved.
ipcMain.handle('recolor', async (event, { imagePath, prompt, strength, dilate, rel, recolorAll }) => {
  try {
    const dir = path.dirname(imagePath);
    const ext = path.extname(imagePath);
    const base = safeBase(path.basename(imagePath, ext));
    const newImagePath = path.join(dir, `${base}_recolor_${Date.now()}${ext}`);
    await ensureSdxlServer();
    if (!sdxlReady) return { success: false, error: 'SDXL server failed to start. Try again in a few seconds.' };
    const r = await sdxlServerCall('/recolor', {
      input: imagePath, prompt: prompt || '', output: newImagePath,
      strength: (strength != null ? strength : 1.0), dilate: dilate || 15,
      rel: (rel != null ? rel : 0.5), recolor_all: !!recolorAll,
    });
    if (r.ok) {
      _handleMultiviewInheritance(newImagePath).catch(() => {});
      return { success: true, newPath: newImagePath };
    }
    return { success: false, error: r.error || 'recolor failed' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('auto-inpaint', async (event, { imagePath, targetText, prompt, dilate, rel }) => {
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
        input: imagePath, target: targetText, prompt: prompt || '', output: newImagePath, dilate: dilate || 15,
        rel: (rel != null ? rel : 0.5)
      });
      if (r.ok) {
        _handleMultiviewInheritance(newImagePath).catch(() => {});
        return { success: true, newPath: newImagePath };
      }
      console.warn('[inpaint] SDXL server failed, falling back to subprocess:', r.error);
    }

    const script = path.join(SCRIPTS_DIR, 'local_inpaint_bridge.py');
    return new Promise((resolve) => {
      const proc = execFile(_aiPython(), [script, imagePath, targetText, prompt || '', newImagePath, String(dilate || 15)], {
        timeout: 300000, maxBuffer: 50 * 1024 * 1024
      }, (error, stdout, stderr) => {
        if (error) {
          resolve({ success: false, error: error.message, stdout, stderr });
        } else if (fs.existsSync(newImagePath)) {
          _handleMultiviewInheritance(newImagePath).catch(() => {});
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
ipcMain.handle('img2img', async (event, { imagePath, prompt, strength, engine, seed }) => {
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
    // Include the seed (or a random suffix) so PARALLEL variant calls — which
    // hit Date.now() in the same millisecond — don't collide on the same output
    // path and overwrite each other (the "N variants -> fewer thumbnails" bug).
    const _uniq = (seed != null && seed !== '') ? seed : Math.floor(Math.random() * 1e9);
    const newImagePath = path.join(dir, `${base}_refined_${ts}_${_uniq}${ext}`);

    const useCloud = (engine === 'pollinations');

    if (!useCloud) {
      // Lazy-start the persistent SDXL server (RealVis XL) and wait for ready.
      await ensureSdxlServer();
      if (!sdxlReady) {
        return { success: false, error: 'SDXL server failed to start. Try again in a few seconds.' };
      }
      console.log('[img2img] Using persistent SDXL server (RealVis XL)');
      const r = await sdxlServerCall('/img2img', {
        input: imagePath, prompt, output: newImagePath, strength: strength || 0.55,
        ...(seed != null ? { seed: parseInt(seed) } : {}),
      });
      if (r.ok) {
        _handleMultiviewInheritance(newImagePath).catch(() => {});
        return { success: true, newPath: newImagePath };
      }
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
        _handleMultiviewInheritance(newImagePath).catch(() => {});
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
from PIL import Image, ImageFilter, ImageEnhance
img = Image.open(r"${imagePath}").convert('RGB')
w, h = img.size
# Upper region (top 40%, center 60%) where the face usually sits.
fl, ft, fr, fb = int(w * 0.2), 0, int(w * 0.8), int(h * 0.4)
face = img.crop((fl, ft, fr, fb))
# SHARPEN + bring out detail. The old pass used SMOOTH_MORE which just BLURRED it.
face = face.filter(ImageFilter.UnsharpMask(radius=2, percent=140, threshold=2))
face = ImageEnhance.Sharpness(face).enhance(1.25)
face = ImageEnhance.Contrast(face).enhance(1.05)
img.paste(face, (fl, ft))
img.save(r"${outPath}")
print("OK")`,
    };

    const script = scripts[operation];
    if (!script) return { success: false, error: `Unknown operation: ${operation}` };

    return await new Promise((resolve) => {
      execFile(_aiPython(), ['-c', script], { timeout: 120000 }, (error, stdout, stderr) => {
        if (error || !fs.existsSync(outPath)) {
          resolve({ success: false, error: (error?.message || stderr || 'failed').slice(-300) });
        } else {
          _handleMultiviewInheritance(outPath).catch(() => {});
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

    const script = path.join(SCRIPTS_DIR, 'remove_bg.py');
    // 300s, not 60s: Remove BG is normally <5s, but under system memory/CPU
    // pressure (a heavy job paging to disk) onnxruntime inference can crawl and
    // the old 60s timeout KILLED it — the user then only saw an opaque "Command
    // failed". The wider timeout + surfacing real stderr makes it diagnosable.
    const proc = execFile(_aiPython(), [script, newImagePath], { timeout: 300000 }, (error, stdout, stderr) => {
      if (error) {
        cleanup();
        const st = (stderr || '').trim();
        let msg;
        if (error.killed || /timed out|ETIMEDOUT/i.test(error.message || '')) {
          msg = 'Remove BG a expiré (timeout). Le système était probablement saturé (RAM/CPU) par un autre traitement — attends qu\'il finisse puis relance.';
        } else {
          // Surface the REAL Python error (stderr) instead of the useless
          // "Command failed: python …" that execFile puts in error.message.
          msg = st ? st.slice(-1500) : (error.message || 'Remove BG failed');
        }
        resolve({ success: false, error: msg, stderr: st });
      } else {
        // Script may output a different path (e.g. .png instead of .jpeg)
        const outMatch = (stdout || '').match(/OK:\s*(.+)/);
        const actualPath = outMatch ? outMatch[1].trim() : newImagePath;
        _handleMultiviewInheritance(actualPath).catch(() => {});
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

// Whether HiDream-O1 (the 2nd image engine) can run on THIS machine: it needs
// a CUDA GPU with enough VRAM (FP8 peaks ~11 GB → require ~12 GB) AND the
// isolated HiDream runtime present. The renderer uses this to hide the HiDream
// dropdown option on machines that can't run it (they keep RealVisXL).
ipcMain.handle('hidream-available', async () => {
  const HIDREAM_PY = 'd:/ai_eval/HiDream/.venv/Scripts/python.exe';
  const MIN_VRAM_MB = 12000;
  let hasRuntime = false;
  try { hasRuntime = fs.existsSync(HIDREAM_PY); } catch (_) {}
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 3000 }, (error, stdout) => {
        if (error) { resolve({ available: false, reason: 'no NVIDIA GPU detected', hasRuntime }); return; }
        const line = (stdout || '').split('\n').filter(l => l.trim())[0] || '';
        const parts = line.split(',').map(s => s.trim());
        const totalMB = parseFloat(parts[1] || '0');
        const gpu = parts[0] || 'GPU';
        const vramOk = totalMB >= MIN_VRAM_MB;
        const available = vramOk && hasRuntime;
        const reason = !hasRuntime ? 'HiDream runtime not installed on this machine'
                     : !vramOk ? `HiDream needs ~12 GB VRAM (this GPU has ${(totalMB / 1024).toFixed(0)} GB)`
                     : 'ok';
        resolve({ available, reason, gpu, vramGB: +(totalMB / 1024).toFixed(1), hasRuntime });
      });
  });
});

// Translate a user's prompt to English (Argos Translate, offline, MIT) using
// their interface language as the source. en / unknown / failure → passthrough
// (fail open), so generation never breaks. SDXL/RealVisXL/HiDream need English.
const _translateCache = new Map();  // `${from}|${text}` -> translated; avoids re-spawning Python on the Generate critical path
let _translateWorkingPy = null;     // remember which interpreter has argostranslate (skip the failing embedded attempt next time)

// Persistent translation server — loads Argos ONCE and keeps it warm, so each
// translation is ~instant instead of re-importing argos (~5s) per spawn.
// Lightweight (~150 MB CPU, no GPU). Lazy-started on first translate, killed on
// quit. The translate-prompt handler falls back to a per-call spawn if it's down.
let translateProc = null;
let translateReady = false;
const TRANSLATE_PORT = 5557;
let translateIdleTimer = null;
const TRANSLATE_IDLE_MS = 5 * 60 * 1000;  // unload the argos translator after 5 min idle to free ~1 GB RAM
function _bumpTranslateIdle() {
  if (translateIdleTimer) clearTimeout(translateIdleTimer);
  translateIdleTimer = setTimeout(() => {
    translateIdleTimer = null;
    try { stopTranslateServer(); } catch (_) {}
    try { log.info('main', 'translate worker unloaded (idle)'); } catch (_) {}
  }, TRANSLATE_IDLE_MS);
}
function startTranslateServer() {
  if (translateProc) return;
  const scriptT = path.join(SCRIPTS_DIR, 'translate_server.py');
  if (!fs.existsSync(scriptT)) return;
  try {
    translateProc = require('child_process').spawn(_aiPython(), [scriptT], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, CUDA_VISIBLE_DEVICES: '', CT2_FORCE_CPU: '1', FABMESH_TRANSLATE_PORT: String(TRANSLATE_PORT) },
    });
    translateProc.stdout.on('data', d => { if (String(d).includes('TRANSLATE READY')) translateReady = true; });
    translateProc.stderr.on('data', () => {});
    translateProc.on('exit', () => { translateProc = null; translateReady = false; });
  } catch (_) { translateProc = null; }
}
function stopTranslateServer() {
  if (translateIdleTimer) { clearTimeout(translateIdleTimer); translateIdleTimer = null; }
  if (!translateProc) return;
  const pid = translateProc.pid;
  try {
    const req = require('http').request({ host: '127.0.0.1', port: TRANSLATE_PORT, path: '/shutdown', method: 'POST', timeout: 400 }, () => {});
    req.on('error', () => {}); req.end();
  } catch (_) {}
  try {
    if (process.platform === 'win32' && pid) require('child_process').execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else translateProc.kill('SIGKILL');
  } catch (_) {}
  translateProc = null; translateReady = false;
}
async function ensureTranslateServer() {
  if (translateReady) return true;
  if (!translateProc) startTranslateServer();
  for (let i = 0; i < 60 && !translateReady; i++) await new Promise(r => setTimeout(r, 200));
  return translateReady;
}
function translateServerCall(text, from, to) {
  return new Promise((resolve) => {
    if (!translateReady) { resolve(null); return; }
    _bumpTranslateIdle();
    const body = JSON.stringify({ text, from, to: to || 'en' });
    const req = require('http').request({ host: '127.0.0.1', port: TRANSLATE_PORT, path: '/translate', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 30000 },
      (res) => { let buf = ''; res.on('data', c => buf += c); res.on('end', () => { try { const j = JSON.parse(buf); resolve(typeof j.text === 'string' ? j.text : null); } catch (_) { resolve(null); } }); });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(null); });
    req.write(body); req.end();
  });
}

// Persistent NSFW prompt classifier — loads the ~250 MB text classifier ONCE
// (it was reloaded ~20s on EVERY generation under parental control). Lazy-started,
// killed on quit. checkPromptSafetyAI falls back to a per-call spawn if it's down.
let nsfwProc = null;
let nsfwReady = false;
const NSFW_PORT = 5558;
function startNsfwServer() {
  if (nsfwProc) return;
  const scriptN = path.join(SCRIPTS_DIR, 'nsfw_server.py');
  if (!fs.existsSync(scriptN)) return;
  try {
    nsfwProc = require('child_process').spawn(_aiPython(), [scriptN], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, CUDA_VISIBLE_DEVICES: '', FABMESH_NSFW_PORT: String(NSFW_PORT) },
    });
    nsfwProc.stdout.on('data', d => { if (String(d).includes('NSFW READY')) nsfwReady = true; });
    nsfwProc.stderr.on('data', () => {});
    nsfwProc.on('exit', () => { nsfwProc = null; nsfwReady = false; });
  } catch (_) { nsfwProc = null; }
}
function stopNsfwServer() {
  if (!nsfwProc) return;
  const pid = nsfwProc.pid;
  try { const req = require('http').request({ host: '127.0.0.1', port: NSFW_PORT, path: '/shutdown', method: 'POST', timeout: 400 }, () => {}); req.on('error', () => {}); req.end(); } catch (_) {}
  try {
    if (process.platform === 'win32' && pid) require('child_process').execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else nsfwProc.kill('SIGKILL');
  } catch (_) {}
  nsfwProc = null; nsfwReady = false;
}
async function ensureNsfwServer() {
  if (nsfwReady) return true;
  if (!nsfwProc) startNsfwServer();
  for (let i = 0; i < 90 && !nsfwReady; i++) await new Promise(r => setTimeout(r, 200));
  return nsfwReady;
}
function nsfwServerCall(text) {
  return new Promise((resolve) => {
    if (!nsfwReady) { resolve(null); return; }
    const body = JSON.stringify({ text });
    const req = require('http').request({ host: '127.0.0.1', port: NSFW_PORT, path: '/classify', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 30000 },
      (res) => { let buf = ''; res.on('data', c => buf += c); res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (_) { resolve(null); } }); });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(null); });
    req.write(body); req.end();
  });
}
// Runtime UI auto-translate: EN -> target language for any string the dicts miss.
// Used by i18n.js to fill gaps live (cached so each string is translated once).
ipcMain.handle('i18n-auto-translate', async (event, { texts, to } = {}) => {
  const out = {};
  if (!Array.isArray(texts) || !texts.length || !to || to === 'en') return out;
  try {
    await ensureTranslateServer();
    for (const tx of texts) {
      if (!tx || typeof tx !== 'string') continue;
      const _ck = 'en>' + to + '|' + tx;
      if (_translateCache.has(_ck)) { out[tx] = _translateCache.get(_ck); continue; }
      const tr = await translateServerCall(tx, 'en', to);
      if (tr != null && tr !== '') {
        if (_translateCache.size > 1000) _translateCache.clear();
        _translateCache.set(_ck, tr);
        out[tx] = tr;
      }
    }
  } catch (_) { /* fail open */ }
  return out;
});

ipcMain.handle('translate-prompt', async (event, { text, from } = {}) => {
  const src = (from || 'en').toLowerCase();
  if (src === 'en' || !text || !text.trim()) return { text: text || '' };
  const _ck = src + '|' + text;
  if (_translateCache.has(_ck)) return { text: _translateCache.get(_ck) };
  // Fast path: the persistent translate server (argos kept warm).
  try {
    await ensureTranslateServer();
    const sv = await translateServerCall(text, src);
    if (sv != null && sv !== '') {
      if (_translateCache.size > 500) _translateCache.clear();
      _translateCache.set(_ck, sv);
      return { text: sv };
    }
  } catch (_) { /* fall through to per-call */ }
  const script = path.join(SCRIPTS_DIR, 'translate_prompt.py');
  // End-users have no python on PATH → prefer the bundled embedded interpreter.
  // If it lacks argostranslate (--strict → exit 3), fall back to system python
  // (the dev box has argos there). Last resort: fail open with the original text.
  const embedded = _embeddedPython();
  const baseAttempts = embedded === 'python'
    ? [['python', false]]
    : [[embedded, true], ['python', false]];
  // Try the known-good interpreter first (non-strict) so we don't re-pay a
  // failing embedded-python spawn on every call.
  const attempts = _translateWorkingPy
    ? [[_translateWorkingPy, false], ...baseAttempts.filter(([p]) => p !== _translateWorkingPy)]
    : baseAttempts;
  const tryRun = (py, strict) => new Promise((resolve) => {
    const argv = [script, '--text', text, '--from', src];
    if (strict) argv.push('--strict');
    // Force CPU-only: the FR/etc. Argos packages pull stanza -> torch, and
    // torch's CUDA init (pynvml probe) adds several seconds per call. Hiding
    // the GPU makes the import fast. CT2_FORCE_CPU keeps ctranslate2 off-GPU too.
    execFile(py, argv, { timeout: 20000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
        env: { ...process.env, CUDA_VISIBLE_DEVICES: '', CT2_FORCE_CPU: '1' } },
      (error, stdout) => {
        if (error || !stdout || !String(stdout).trim()) { resolve(null); return; }
        resolve(String(stdout).trim());
      });
  });
  for (const [py, strict] of attempts) {
    const out = await tryRun(py, strict);
    if (out) {
      if (_translateCache.size > 500) _translateCache.clear();  // simple cap
      _translateCache.set(_ck, out);
      return { text: out };
    }
  }
  return { text };  // fail open → original (don't cache failures)
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
    const limitsFile = path.join(SCRIPTS_DIR, '.gpu_limit.json');
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

      // Step 2: Convert image to 3D (default: Trellis — SF3D/TripoSR retired for NC license)
      const meshFilename = `${safeName}_${stage.name}_${timestamp}.glb`;
      const meshPath = path.join(MESHES_DIR, meshFilename);
      let selectedEngine = engine || 'trellis';
      if (selectedEngine === 'sf3d') selectedEngine = 'trellis';
      const bridgeScripts = {
        'local':   path.join(SCRIPTS_DIR, 'local_triposr_bridge.py'),
        'trellis': path.join(SCRIPTS_DIR, 'trellis_bridge.py')
      };
      const bridgeScript = bridgeScripts[selectedEngine] || bridgeScripts['trellis'];
      const argsMap = {
        'local':   [bridgeScript, imgPath, meshPath, '512'],
        'trellis': [bridgeScript, imgPath, meshPath, '0.95', '1024']
      };
      const args = argsMap[selectedEngine] || argsMap['trellis'];

      try {
        await new Promise((resolve, reject) => {
          execFile(_aiPython(), args, { timeout: 1800000, maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
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
// Construction-stage prompt modifiers, front-loaded (SDXL weights early
// tokens more). Generic enough for buildings, vehicles, weapons, props,
// environment — the checkbox is hidden for living subjects (see
// _wireBuildStagesVisibility). Applied over the already-enriched prompt.
const _BUILD_STAGE_MODIFIERS = [
  'early construction stage, bare structural framework and skeleton, scaffolding, exposed frame, unfinished work-in-progress, incomplete',
  'half-built, partially assembled, some sections finished and others still exposed, mid construction, work-in-progress',
  'fully finished and complete, every detail present, clean polished final version',
];

ipcMain.handle('generate-images', async (event, { prompt, userPrompt, numImages, projectName, engine, quality, steps, vramFraction, assetType, buildStages }) => {
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
    const _assetType = (typeof assetType === 'string' && assetType.trim()) ? assetType.trim().toLowerCase() : 'character';
    const childEnv = {
      ...process.env,
      HF_HOME: HF_CACHE_DIR,
      HUGGINGFACE_HUB_CACHE: path.join(HF_CACHE_DIR, 'hub'),
      FABMESH_VRAM_FRACTION: String(fracVal),
      FABMESH_ASSET_TYPE: _assetType,
      PYTORCH_CUDA_ALLOC_CONF: _allocConf,
      ..._ramLimitMB ? { FABMESH_RAM_LIMIT_MB: _ramLimitMB } : {},
      ..._gpuLimit   ? { FABMESH_GPU_LIMIT:   _gpuLimit   } : {},
      ..._tempLimit  ? { FABMESH_TEMP_LIMIT:  _tempLimit  } : {},
    };

    // LOCAL GPU: Juggernaut XL v9 (recommended, photorealistic SDXL fine-tune)
    if (engine === 'local-flux' || engine === 'local-lightning') {
      const turbo = engine === 'local-lightning';
      const bridgeScript = path.join(SCRIPTS_DIR, 'local_juggernaut_bridge.py');
      const stepsClamped = turbo ? 4 : Math.max(4, Math.min(60, parseInt(steps) || 30));
      // One bridge invocation → returns only the NEW png paths it produced.
      const runBridge = (promptArg, n) => new Promise((resolve, reject) => {
        const filesBefore = new Set(
          fs.existsSync(imagesDir)
            ? fs.readdirSync(imagesDir).filter(f => /\.png$/i.test(f))
            : []
        );
        const proc = execFile(_aiPython(), [bridgeScript, promptArg, imagesDir, String(n), String(stepsClamped)], {
          timeout: 1800000, maxBuffer: 50 * 1024 * 1024,
          env: turbo ? { ...childEnv, FABMESH_TURBO: '1' } : childEnv,
        }, (error, stdout, stderr) => {
          if (error) { reject({ error: error.message, stdout, stderr }); return; }
          const imgs = fs.readdirSync(imagesDir)
            .filter(f => /\.png$/i.test(f))
            .filter(f => !filesBefore.has(f))  // NEW files only
            .map(f => path.join(imagesDir, f));
          resolve(imgs);
        });
        proc.stdout.on('data', d => { safeSend('ai3d-progress', d.toString()); });
        proc.stderr?.on('data', d => { safeSend('ai3d-progress', '[stderr] ' + d.toString()); });
      });

      // Construction stages: 3 images with 3 progressive build prompts
      // (foundation → half-built → finished), same engine. One bridge call
      // per stage so each stage gets its own prompt; ordered foundation-first.
      if (buildStages) {
        const staged = [];
        for (let s = 0; s < _BUILD_STAGE_MODIFIERS.length; s++) {
          safeSend('ai3d-progress', `[build-stages] Stage ${s + 1}/3…\n`);
          const stagePrompt = `${_BUILD_STAGE_MODIFIERS[s]}, ${prompt}`;
          try {
            const imgs = await runBridge(stagePrompt, 1);
            staged.push(...imgs);
          } catch (e) {
            safeSend('ai3d-progress', `[build-stages] Stage ${s + 1} failed: ${(e && e.error) || e}\n`);
          }
        }
        if (!staged.length) return { success: false, error: 'Construction stages produced no images (see logs).' };
        return { success: true, images: staged };
      }

      const images = await runBridge(prompt, numImages || 4);
      return { success: true, images };
    }

    // LOCAL GPU: HiDream-O1 FP8 (second image engine). Runs from its OWN
    // isolated venv at d:/ai_eval/HiDream so we never touch the working
    // RealVisXL / TRELLIS2 env. run_fp8.py produces ONE image per call →
    // loop numImages with a varying seed. Model weights are cached on D:
    // (C: is near-full) so we point HF_HOME there.
    if (engine === 'hidream') {
      const hiPython = 'd:/ai_eval/HiDream/.venv/Scripts/python.exe';
      const hiScript = 'd:/ai_eval/HiDream/run_fp8.py';
      const stepsClamped = Math.max(4, Math.min(60, parseInt(steps) || 28));
      const hiEnv = { ...childEnv, HF_HOME: 'D:/hf_cache', HUGGINGFACE_HUB_CACHE: 'D:/hf_cache/hub' };
      const ts = Date.now();
      const images = [];
      for (let i = 0; i < (numImages || 4); i++) {
        const outPath = path.join(imagesDir, `ref_${ts}_${i}.png`);
        try {
          await new Promise((resolve, reject) => {
            const proc = execFile(hiPython, [hiScript,
              '--prompt', prompt, '--out', outPath,
              '--steps', String(stepsClamped),
              '--width', '1024', '--height', '1024',
              '--seed', String(ts + i),
            ], { cwd: 'd:/ai_eval/HiDream', timeout: 1800000, maxBuffer: 50 * 1024 * 1024, env: hiEnv },
              (error) => { if (error) { reject({ error: error.message }); return; } resolve(); });
            proc.stdout.on('data', d => { safeSend('ai3d-progress', d.toString()); });
            proc.stderr?.on('data', d => { safeSend('ai3d-progress', '[stderr] ' + d.toString()); });
          });
          if (fs.existsSync(outPath)) images.push(outPath);
        } catch (e) {
          safeSend('ai3d-progress', '[hidream] error: ' + (e && e.error ? e.error : e));
        }
      }
      if (!images.length) return { success: false, error: 'HiDream produced no images (see logs).' };
      return { success: true, images };
    }

    // LOCAL GPU: Stable Diffusion XL Turbo — REMOVED.
    // SDXL Turbo is distributed under the SAI Non-Commercial Research License,
    // which disqualifies it from our "free AND commercially sellable" rule.
    // Legacy saved projects that still reference engine='local-sd' silently
    // fall back to RealVis XL (local-flux) above.
    if (engine === 'local-sd') {
      console.warn('[generate-images] local-sd (SDXL Turbo) is disabled (non-commercial license).');
      return { success: false, error: 'SDXL Turbo is non-commercial. Please pick RealVis XL.' };
    }

    // Pollinations: community service without formal commercial ToS on outputs.
    // Disabled for the Steam release. Legacy projects that still reference
    // engine='pollinations' get a clear error directing them to RealVis.
    if (engine === 'pollinations') {
      console.warn('[generate-images] pollinations disabled (no formal commercial ToS on outputs).');
      return { success: false, error: 'Pollinations has been removed. Please pick RealVis XL (local).' };
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

// --- Image-to-3D: TRELLIS-2 native (default). SF3D and TripoSR have
// been retired for non-commercial license; legacy requests for those
// engines are silently rerouted to trellis2_native. ---
ipcMain.handle('image-to-3d', async (event, { imagePath: _imagePath, imagePathBack, outputName, textureSize, engine: _engine, targetFaces, effort, jobId, vramFraction, subdivide, trellis2Steps, trellis2TexSize, trellis2ImgRes, trellis2MultiRef, trellis2Refine, trellis2RectifySource, trellis2Smooth, trellis2QualityPlus, trellis2UltraQ, trellis2FaceFix, trellis2UltraHD, trellis2Preset, assetType }) => {
  let imagePath = _imagePath;
  let engine = _engine;
  // SF3D and TripoSR both disabled at the UI level — Stability AI
  // Community license is non-commercial above $1M rev. Any legacy
  // project still requesting them is silently rerouted to
  // trellis2_native (commercial-safe default).
  if (engine === 'sf3d') {
    log.warn('main', 'engine=sf3d requested but disabled (NC license); rerouting to trellis2_native');
    engine = 'trellis2_native';
  }
  if (engine === 'local') {
    log.warn('main', 'engine=local (TripoSR) requested but disabled (Stability NC license); rerouting to trellis2_native');
    engine = 'trellis2_native';
  }
  const useTwoView = false;

  // SEQUENTIAL RESIDENCY — free the persistent SDXL server's RAM (~4-6 GB:
  // RealVis + inpaint + CLIPSeg) BEFORE the heavy TRELLIS pass. SDXL is not used
  // during 3D generation, and keeping it resident is exactly the cross-model
  // overlap that pushed total RAM over the budget marker. It respawns on demand
  // for the next image op (~5-10 s). Rule: never hold two big models at once.
  // We stop it FIRST, then briefly let the OS reclaim, so the RAM gate below
  // sees the freed headroom and can pick a better-fitting cascade mode.
  if (engine === 'trellis2_native') {
    try {
      stopSdxlServer();
      safeSend('ai3d-progress', '[main] SDXL libéré pour la passe 3D (rechargé au besoin ensuite)\n');
      await new Promise(r => setTimeout(r, 1500));
    } catch (_) {}
  }

  // RAM BUDGET guard — the RAM slider (Settings → RAM marker) is a REAL ceiling
  // on TOTAL system RAM, enforced by picking the heaviest cascade mode whose
  // PEAK still fits the budget HEADROOM = budget − what's ALREADY in use (OS +
  // Electron + SDXL server + other apps). Gating on the raw budget alone (the
  // old bug) let the total drift OVER the marker, because the worker's peak was
  // added ON TOP of the existing baseline. We never hard-cap the process (that
  // just OOM-crashes it); we degrade the mode so the TOTAL provably stays under
  // the marker — at worst dropping to base mode (lower quality) on a tight box.
  //   peak(1536_cascade Ultra)   ≈ 27 GB worker RAM
  //   peak(1024_cascade Quality+) ≈ 20 GB worker RAM  (measured WS)
  //   peak(base mode)             ≈ 10 GB
  // A mode is allowed only if its peak ≤ headroom. Lower the slider → tighter
  // ceiling → lighter mode chosen. Enforced server-side (belt + suspenders).
  const PEAK_1536_GB = 27;
  const PEAK_1024_GB = 20;
  let ultraQ      = trellis2UltraQ;
  let qualityPlus = trellis2QualityPlus;
  let _ramHeadroomGB = null;
  try {
    const _os = require('os');
    const _physGB  = _os.totalmem() / (1024 ** 3);
    const _usedGB  = (_os.totalmem() - _os.freemem()) / (1024 ** 3);
    const _limitMB = parseFloat(process.env.FABMESH_RAM_LIMIT_MB || '');
    const _budgetGB = (_limitMB && _limitMB > 0)
      ? Math.min(_physGB, _limitMB / 1024)
      : _physGB;
    // Headroom under the budget right now. The chosen mode's peak must fit here
    // for the TOTAL (baseline + worker) to stay under the marker.
    const _headroomGB = _budgetGB - _usedGB;
    _ramHeadroomGB = _headroomGB;
    log.info('main', `image-to-3d RAM gate: budget=${_budgetGB.toFixed(1)}GB used=${_usedGB.toFixed(1)}GB headroom=${_headroomGB.toFixed(1)}GB`);
    if (ultraQ && PEAK_1536_GB > _headroomGB) {
      log.warn('main', `image-to-3d: Ultra (1536, ~${PEAK_1536_GB}GB) > headroom ${_headroomGB.toFixed(1)}GB — downgrading to Quality+ (1024)`);
      try { safeSend('ai3d-progress', `[main] Ultra (1536, ~${PEAK_1536_GB} GB) dépasse le budget restant (${_headroomGB.toFixed(0)} GB libres sous le marqueur) → Quality+ (1024)\n`); } catch (_) {}
      ultraQ = false;
    }
    if ((ultraQ || qualityPlus) && PEAK_1024_GB > _headroomGB) {
      log.warn('main', `image-to-3d: Quality+ (1024, ~${PEAK_1024_GB}GB) > headroom ${_headroomGB.toFixed(1)}GB — downgrading to base mode`);
      try { safeSend('ai3d-progress', `[main] Quality+ (1024, ~${PEAK_1024_GB} GB) dépasse le budget restant (${_headroomGB.toFixed(0)} GB libres sous le marqueur) → mode de base (~10 GB)\n`); } catch (_) {}
      ultraQ = false;
      qualityPlus = false;
    }
  } catch (_) {}

  // Pre-flight RAM abort: if even base mode (~10 GB peak) won't fit the current
  // headroom, fail FAST with a clear message instead of starting a ~3-minute run
  // that OOM-crashes at pipeline load (the case the user kept hitting). Tunable
  // via FABMESH_RAM_ABORT_GB.
  const _PEAK_BASE_GB = parseFloat(process.env.FABMESH_RAM_ABORT_GB || '10');
  if (_ramHeadroomGB != null && _ramHeadroomGB < _PEAK_BASE_GB) {
    const _msg = `Pas assez de RAM pour générer : ~${Math.max(0, _ramHeadroomGB).toFixed(0)} GB `
      + `disponibles, ~${_PEAK_BASE_GB.toFixed(0)} GB requis (même en mode de base). Fermez des `
      + `applications lourdes (Unreal Engine, navigateurs, autres gros logiciels) puis réessayez.`;
    log.warn('main', `image-to-3d ABORTED pre-flight: headroom ${_ramHeadroomGB.toFixed(1)}GB < ${_PEAK_BASE_GB}GB`);
    try { safeSend('ai3d-progress', `[main] ${_msg}\n`); } catch (_) {}
    return { success: false, error: _msg };
  }

  // PRE-PROCESS: auto-rectify the source image to a canonical view.
  // - assetType='character' -> strict orthographic front (good for MV-Adapter
  //   and ControlNet OpenPose paths, T-pose symmetric).
  // - everything else        -> 3/4 ISO (depth axis visible, better mesh
  //   proportions for vehicles / objects / non-bipedal creatures).
  // Pre-process gates: only run for TRELLIS-2-based engines — other
  // engines have their own opinions about the source view.
  if (trellis2RectifySource && imagePath && fs.existsSync(imagePath)
      && engine === 'trellis2_native') {
    const rectifyScript = path.join(SCRIPTS_DIR, 'generate_front_strict.py');
    // Write the rectified image INTO the project image folder so it becomes a
    // real gallery VERSION: it is the actual input that generated the mesh, so
    // the user wants to see it (and "jump to source" lands on it). The gallery
    // '_rectified' exclusion in list-image-folders was relaxed to match. (User
    // chose this over recording the original source.)
    const _rectBase = path.basename(imagePath).replace(/\.(png|jpg|jpeg|webp)$/i, '');
    const rectifiedPath = path.join(path.dirname(imagePath), `fabmesh_rectified_${Date.now()}_${_rectBase}.png`);
    // assetType drives the canonical source view we want for mesh
    // generation. Icons want a slight 3/4 ISO so the depth axis is
    // visible in the final mesh — same as vehicles and props.
    const rectifyMode = (assetType === 'character') ? 'front'
                      : (assetType === 'icon')       ? 'iso'
                      : 'iso';
    log.info('main', `auto-rectify source: ${path.basename(imagePath)} `
      + `-> ${path.basename(rectifiedPath)} (mode=${rectifyMode}, assetType=${assetType})`);
    safeSend('ai3d-progress', `[main] auto-rectify source view (mode=${rectifyMode})...\n`);
    const pythonExeForRectify = (engine === 'trellis2_native')
      ? path.join(__dirname, '..', '..', 'external', 'TRELLIS2_win', '.venv', 'Scripts', 'python.exe')
      : 'python';
    try {
      await new Promise((resolve, reject) => {
        const proc = execFile(pythonExeForRectify, [
          rectifyScript, 'auto', rectifiedPath,
          '--from-image', imagePath,
          '--mode', rectifyMode,
          '--seeds', '3',
        ], { timeout: 180000, maxBuffer: 10 * 1024 * 1024,
             env: { ...process.env, PYTHONUNBUFFERED: '1', HF_HOME: HF_CACHE_DIR, HUGGINGFACE_HUB_CACHE: path.join(HF_CACHE_DIR, 'hub') } },
        (err) => err ? reject(err) : resolve());
        proc.stdout?.on('data', d => safeSend('ai3d-progress', d.toString()));
        proc.stderr?.on('data', d => safeSend('ai3d-progress', '[stderr] ' + d.toString()));
      });
      if (fs.existsSync(rectifiedPath)) {
        log.info('main', 'auto-rectify done, using rectified image for mesh');
        imagePath = rectifiedPath;
      }
    } catch (e) {
      log.warn('main', `auto-rectify failed: ${e.message}, falling back to original source`);
    }
  }

  try {
    const safeName = outputName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = Date.now();
    const meshFilename = `${safeName}_${engine || 'ai'}_${timestamp}.glb`;
    const meshPath = path.join(MESHES_DIR, meshFilename);
    const bridgeScripts = {
      'local':   path.join(SCRIPTS_DIR, 'local_triposr_bridge.py'),
      'sf3d':    path.join(SCRIPTS_DIR, 'local_sf3d_bridge.py'),
      // TRELLIS-2 native: single-shot mesh + PBR texture via
      // microsoft/TRELLIS.2-4B's Trellis2ImageTo3DPipeline. Default engine
      // since 2026-05-19.
      'trellis2_native': path.join(SCRIPTS_DIR, 'trellis2_native_full_pipeline.py'),
      'trellis': path.join(SCRIPTS_DIR, 'trellis_bridge.py')
    };
    const bridgeScript = bridgeScripts[engine] || bridgeScripts['trellis2_native'];

    // SF3D args: <img> <out> <tex_res> <vertex_count> <remesh> <subdivide_levels>
    const sf3dTexRes = String(textureSize || 1024);
    const sf3dVerts = (targetFaces && Number(targetFaces) > 0) ? String(Math.max(500, Number(targetFaces) * 0.5)) : '-1';
    const sf3dRemesh = (targetFaces && Number(targetFaces) > 0) ? 'triangle' : 'none';
    const sf3dSubdivide = String(typeof subdivide === 'number' ? subdivide : 0);

    const effortVal = String(effort || 2);
    const argsMap = {
      'local':   [bridgeScript, imagePath, meshPath, '512'],
      'sf3d':    [bridgeScript, imagePath, meshPath, sf3dTexRes, sf3dVerts, sf3dRemesh, sf3dSubdivide],
      'trellis2_native': [bridgeScript, imagePath, meshPath, String(trellis2TexSize || textureSize || 2048)],
      'trellis': [bridgeScript, imagePath, meshPath, '0.95', String(textureSize || 1024)],
    };
    const args = argsMap[engine] || argsMap['trellis2_native'];

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
      'trellis2_native': [bridgeScript, imagePath, meshPath, String(trellis2TexSize || textureSize || 2048)],
      'trellis': [bridgeScript, imagePath, meshPath, '0.95', String(textureSize || 1024)],
    };
    const fixedArgs = fixedArgsMap[engine] || fixedArgsMap['trellis2_native'];

    console.log('IMAGE-TO-3D fixedArgs:', JSON.stringify(fixedArgs));
    fs.writeFileSync(path.join(LOGS_DIR, 'last_error.log'), `imagePath: ${imagePath}\nfixedArgs: ${JSON.stringify(fixedArgs)}\n`);
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
    // 2-view mode: pre-build mv/ dir alongside the mesh with view_0=front,
    // view_1=back, then pass FABMESH_MV_REUSE + the child-style env vars.
    let mv2Dir = null;
    if (useTwoView) {
      try {
        const meshDir = path.dirname(meshPath);
        const meshBase = path.basename(meshPath, '.glb');
        mv2Dir = path.join(meshDir, `${meshBase}_mv2`);
        fs.mkdirSync(mv2Dir, { recursive: true });
        // Copy front + back as view_0 / view_1 (texture_project iterates by
        // file index, so view_1 must literally be the back photo).
        fs.copyFileSync(imagePath, path.join(mv2Dir, 'view_0.png'));
        fs.copyFileSync(imagePathBack, path.join(mv2Dir, 'view_1.png'));
        const viewsJson = {
          engine: 'fabmesh_2view',
          views: [
            { azim: 0, elev: 0, label: 'front' },
            { azim: 180, elev: 0, label: 'back' },
          ],
        };
        fs.writeFileSync(path.join(mv2Dir, 'views.json'),
                         JSON.stringify(viewsJson, null, 2));
        log.info('main', `2-view mode: built mv dir at ${mv2Dir}`);
      } catch (mvErr) {
        log.error('main', `2-view mv build failed: ${mvErr.message}`);
        mv2Dir = null;
      }
    }
    const env = {
      ...process.env,
      // Unbuffered stdout so LOCAL_TRIPOSR_PROGRESS markers arrive in
      // real time (not buffered in 4 KB chunks by the Python runtime).
      PYTHONUNBUFFERED: '1',
      FABMESH_VRAM_FRACTION: String(fraction),
      PYTORCH_CUDA_ALLOC_CONF: allocConf,
      // 2026-05-30 — Authoritative TRELLIS-2 attention backend config.
      // Forces sdpa (Blackwell-correct, fp32-math in dense + sparse paths)
      // and disables torchdynamo/triton/flash_attn so SAC never blocks on
      // flash_attn_2_cuda.dll. These must NOT rely on Python setdefault
      // because a polluted parent env used to force flash_attn. Set
      // authoritatively here to override.
      ATTN_BACKEND: 'sdpa',
      SPARSE_ATTN_BACKEND: 'sdpa',
      TORCHDYNAMO_DISABLE: '1',
      TORCHINDUCTOR_USE_TRITON: '0',
      TRANSFORMERS_ATTN_IMPLEMENTATION: 'eager',
      TRELLIS2_USE_KAOLIN_RASTER: '1',
      // Packaged: the TRELLIS-2 source tree ships in extraResources
      // (TRELLIS2_win/src). Dev: unset → the pipeline falls back to its
      // relative external/TRELLIS2_win/src default.
      ...(app.isPackaged
        ? { FABMESH_TRELLIS2_SRC: path.join(process.resourcesPath, 'TRELLIS2_win', 'src') }
        : {}),
      ..._ramLimitMB2 ? { FABMESH_RAM_LIMIT_MB: _ramLimitMB2 } : {},
      ..._gpuLimit2   ? { FABMESH_GPU_LIMIT:   _gpuLimit2   } : {},
      ..._tempLimit2  ? { FABMESH_TEMP_LIMIT:  _tempLimit2  } : {},
      // 2-view config (a-utiliser-v3 baseline) when back photo provided.
      // PROJECT_MODE=augment: SF3D bake stays as-is on front-facing faces,
      // only back/side faces get blended with the back photo (additive,
      // no pixel-precise projection — avoids artifacts when the back
      // photo's silhouette doesn't perfectly match the mesh dorsal shape).
      ...(mv2Dir ? {
        FABMESH_MV_REUSE: mv2Dir,
        FABMESH_PROJECT_MODE: 'augment',
        FABMESH_SF3D_NORMALIZE_ORIENT: '0',
        FABMESH_TEXPROJ_FRAME_FIX: '1',
        FABMESH_TEXPROJ_SKIP_BACK_VFLIP: '1',
        FABMESH_AUTOFIT: '1',
        FABMESH_AUTOFIT_RATIO: '1.20',
      } : {}),
      // Quality presets: Ultra Quality (1536_cascade) > Quality+ (1024_cascade)
      // > default (1024). Ultra wins if both checked.
      ...(engine === 'trellis2_native' && ultraQ
        ? {
            FABMESH_TRELLIS2_NATIVE_MODE: '1536_cascade',
            FABMESH_TRELLIS2_NATIVE_DECIM: '1200000',
            FABMESH_TRELLIS2_MAX_TOKENS: '32768',
          }
        : (engine === 'trellis2_native' && qualityPlus
            ? {
                FABMESH_TRELLIS2_NATIVE_MODE: '1024_cascade',
                FABMESH_TRELLIS2_NATIVE_DECIM: '1000000',
              } : {})),
      // TRELLIS-2 native: auto-feed extra views to the mesh
      // pipeline when the user generated them. DISABLED BY DEFAULT since
      // 2026-05-20 — confirmed via the singe / red car tests that
      // TRELLIS-2 4B was not trained on multi-image cond and produces
      // siamese / fragmented meshes when fed N>1 cond images (see
      // AGENT_LOG.md 2026-05-19 entry "MV-Adapter on cars"). The
      // multi-view dir is still useful for UI preview, just not as
      // mesh conditioning. Set FABMESH_USE_EXTRA_VIEWS=1 to re-enable
      // for experimentation.
      ...((engine === 'trellis2_native'
            && process.env.FABMESH_USE_EXTRA_VIEWS === '1'
            && imagePath
            && fs.existsSync(path.join(
                  path.dirname(imagePath),
                  path.basename(imagePath, path.extname(imagePath))
                    + '_multiview')))
        ? {
            FABMESH_TRELLIS2_MULTIVIEW_DIR: path.join(
              path.dirname(imagePath),
              path.basename(imagePath, path.extname(imagePath))
                + '_multiview'),
          }
        : {}),
    };
    if (mv2Dir) {
      log.info('main', '2-view env applied: AUGMENT mode (front=SF3D bake, back=additive blend)');
    }
    // Lineage sidecar (Generation History): capture les params de génération
    // qui étaient jetés après le subprocess (argv/env éphémères). Appelé aux
    // DEUX sites de résolution (callback execFile + early-resolve).
    const _writeMeshGenMeta = () => writeMeta(meshPath, {
      kind: 'mesh', engine, source: imagePath,
      params: {
        textureSize: trellis2TexSize || textureSize || 2048,
        targetFaces, effort, subdivide, assetType,
        steps: trellis2Steps, imgRes: trellis2ImgRes, preset: trellis2Preset,
        multiRef: trellis2MultiRef, refine: trellis2Refine,
        rectifySource: trellis2RectifySource, smooth: trellis2Smooth,
        qualityPlus: trellis2QualityPlus, ultraQ: trellis2UltraQ,
        faceFix: trellis2FaceFix, ultraHD: trellis2UltraHD,
        voxelMode: env.FABMESH_TRELLIS2_NATIVE_MODE || '1024',
        maxTokens: env.FABMESH_TRELLIS2_MAX_TOKENS,
        seed: 42,  // défaut du bridge (FABMESH_TRELLIS2_NATIVE_SEED jamais posé)
      },
    });
    log.info('main', `image-to-3d: launching with PYTORCH_CUDA_ALLOC_CONF=${allocConf}`);
    // TRELLIS-2 native needs torch 2.8 + flash_attn + kaolin, which only
    // live in external/TRELLIS2_win/.venv. Other engines use the system
    // Python (torch 2.7.1). Pick the right interpreter per engine.
    // Packaged: every engine runs on the provisioned AI venv (_aiPython).
    // Dev: keep the per-engine behavior — trellis2_native uses its own
    // external/.venv (torch 2.8 + kaolin), others use the dev's python.
    const _pythonExe = app.isPackaged
      ? _aiPython()
      : ((engine === 'trellis2_native')
          ? path.join(__dirname, '..', '..', 'external', 'TRELLIS2_win', '.venv', 'Scripts', 'python.exe')
          : 'python');
    const result = await new Promise((resolve, reject) => {
      let stdoutBuf = '';
      let stderrBuf = '';
      let lastSent = 0;
      let resolvedEarly = false;
      const proc = execFile(_pythonExe, fixedArgs, {
        timeout: 1800000,
        maxBuffer: 50 * 1024 * 1024,
        env,
      }, (error, stdout, stderr) => {
        if (jobId) activeProcs.delete(jobId);
        if (resolvedEarly) return;
        if (error) { reject({ error: error.message, stdout, stderr }); return; }
        if (!fs.existsSync(meshPath)) { reject({ error: 'GLB not created (Python did not produce output)', stdout, stderr }); return; }
        const stats = fs.statSync(meshPath);
        // Save source image path for later display in viewer
        try { fs.writeFileSync(meshPath + '.source', imagePath, 'utf-8'); } catch(e) {}
        _writeMeshGenMeta();
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
      // Early-resolve: once a bridge emits LOCAL_*_PROGRESS: 100 done AND the
      // GLB exists on disk, resolve immediately without waiting for the
      // subprocess to exit. Some bridges accumulate 10+ MB of tqdm/diffusers
      // stdout that Node has to fully drain before firing execFile's
      // callback — causing a 1-2 min "stuck at 70%" delay even though the
      // mesh has been written. The process is left to exit on its own
      // (wrapper calls os._exit(0)).
      const checkEarlyResolve = () => {
        if (resolvedEarly) return;
        if (!/LOCAL_[A-Z0-9_]+_PROGRESS:\s*100\s+done/.test(stdoutBuf)) return;
        if (!fs.existsSync(meshPath)) return;
        resolvedEarly = true;
        if (jobId) activeProcs.delete(jobId);

        // Accumulator: post-process steps that failed (still recoverable
        // — we kept the original mesh — but the user should know which
        // option silently no-op'd so they can retry or report.
        const postProcessErrors = [];

        const finishAndResolve = () => {
          // Guarded stat: if the mesh vanished (swap failure + antivirus
          // lock, disk pulled, …) reject cleanly — an unguarded throw here
          // happens inside the execFile callback and leaves the Promise
          // pending FOREVER (renderer stuck on await, job frozen).
          let stats;
          try {
            stats = fs.statSync(meshPath);
          } catch (e) {
            log.error('main', `image-to-3d: final mesh missing at resolve: ${e.message}`);
            reject({ error: `final mesh missing after post-process: ${e.message}`,
                     stdout: stdoutBuf, postProcessErrors });
            return;
          }
          try { fs.writeFileSync(meshPath + '.source', imagePath, 'utf-8'); } catch(e) {}
          _writeMeshGenMeta();
          let meshVerts = null, meshFaces = null;
          const statsMatch = stdoutBuf.match(/STATS:\s*verts=(\d+)\s*faces=(\d+)/);
          if (statsMatch) {
            meshVerts = parseInt(statsMatch[1]);
            meshFaces = parseInt(statsMatch[2]);
          }
          if (postProcessErrors.length) {
            log.warn('main', `image-to-3d post-process partial failures: ${postProcessErrors.join(' | ')}`);
            safeSend('ai3d-progress', `[main] WARN post-process step(s) failed (kept original mesh): ${postProcessErrors.join(', ')}\n`);
          }
          log.info('main', `image-to-3d EARLY-RESOLVE: marker 100 done + GLB ready (${(stats.size/1024).toFixed(0)} KB)`);
          resolve({ meshPath, meshFilename, format: 'glb', size: stats.size, sourceImage: imagePath, stdout: stdoutBuf, meshVerts, meshFaces, postProcessErrors });
        };

        // Generic post-process runner — replaces the three near-duplicate
        // closures. Each step takes a name + script + extra args + timeout.
        // On success: swap meshPath atomically (delete + rename tempOut).
        // On failure: log + record in postProcessErrors so finishAndResolve
        // can surface it, then keep the previous meshPath untouched.
        const runStep = (label, script, extraArgs, timeout, next) => {
          const tempOut = meshPath + `.${label}.tmp.glb`;
          log.info('main', `image-to-3d: running ${label} post-process...`);
          safeSend('ai3d-progress', `[main] ${label}: starting...\n`);
          const proc = execFile(_pythonExe, [script, meshPath, tempOut, ...extraArgs], {
            timeout, maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env, PYTHONUNBUFFERED: '1', HF_HOME: HF_CACHE_DIR, HUGGINGFACE_HUB_CACHE: path.join(HF_CACHE_DIR, 'hub') },
          }, (err) => {
            if (!err && fs.existsSync(tempOut)) {
              // Safe swap: park the original as .bak BEFORE promoting the
              // new mesh, so a rename failure (antivirus/indexer lock on
              // Windows) can never destroy the freshly generated GLB —
              // the old delete+rename lost it forever on that exact path.
              const bak = meshPath + `.${label}.bak.glb`;
              try {
                fs.renameSync(meshPath, bak);
                fs.renameSync(tempOut, meshPath);
                try { fs.unlinkSync(bak); } catch (e) {}
                log.info('main', `${label} done`);
              } catch (e) {
                try {
                  if (!fs.existsSync(meshPath) && fs.existsSync(bak)) fs.renameSync(bak, meshPath);
                } catch (e2) {}
                try { fs.existsSync(tempOut) && fs.unlinkSync(tempOut); } catch (e2) {}
                postProcessErrors.push(`${label}: swap failed (${e.message})`);
                log.warn('main', `${label} swap failed: ${e.message}, original mesh kept`);
              }
            } else {
              const reason = err?.killed ? 'timeout/killed' : (err?.message || 'no output written');
              postProcessErrors.push(`${label}: ${reason}`);
              log.warn('main', `${label} failed: ${reason}, keeping original`);
              try { fs.existsSync(tempOut) && fs.unlinkSync(tempOut); } catch (e) {}
            }
            next();
          });
          proc.stdout?.on('data', d => safeSend('ai3d-progress', d.toString()));
          proc.stderr?.on('data', d => safeSend('ai3d-progress', '[stderr] ' + d.toString()));
        };

        const REFINE_SCRIPT = path.join(SCRIPTS_DIR, 'texture_refine.py');
        const SMOOTH_SCRIPT = path.join(SCRIPTS_DIR, 'texture_smooth.py');
        // Face-fix REPLACED 2026-06-28: face_inpaint_atlas.py (SDXL repaint) is
        // doomed by construction — a generative model repaints/erases stylized
        // faces. face_reproject.py instead re-projects the SHARP face from the
        // user SOURCE image onto the mesh face UV (non-destructive: outside the
        // face mask stays byte-identical; guardrail passthrough on any failure
        // so the paid option never ships a WORSE face).
        const FACE_SCRIPT   = path.join(SCRIPTS_DIR, 'face_reproject.py');
        const UPSCALE_SCRIPT= path.join(SCRIPTS_DIR, 'texture_upscale.py');

        // 2026-06-13: wire "Detail refine". texture_refine.py was already
        // present (SDXL Tile img2img on the baked atlas) but the checkbox
        // (trellis2Refine) was destructured and never used — a dead toggle.
        // Run it FIRST (refine the 4k atlas) so smooth/face/upscale operate
        // on the sharpened texture. Low default strength (0.22) so it adds
        // micro-detail without inventing damage; the per-asset-type UI
        // defaults already turn it OFF for smooth surfaces (vehicles/icons).
        // 'refine' img2img's the atlas. For asset types WITH a human-ish face,
        // pass --protect-face so texture_refine preserves the face UV island
        // (composite the original back) and only sharpens the BODY -> the paid
        // option improves without wrecking the AI face. If the mask can't be
        // built, texture_refine SKIPS the refine rather than damage the face.
        const _refineArgs = ['--strength', '0.22', '--controlnet_tile'];
        if (['character', 'creature', 'other_living'].includes(assetType)) _refineArgs.push('--protect-face');
        const runRefine  = (next) => trellis2Refine   ? runStep('refine',  REFINE_SCRIPT,  _refineArgs, 240000, next) : next();
        const runSmooth  = (next) => trellis2Smooth   ? runStep('smooth',  SMOOTH_SCRIPT,  [],                                    120000, next) : next();
        // Face-fix now re-projects the SHARP SOURCE face onto the mesh face UV
        // (face_reproject.py), NOT an SDXL repaint. imagePath is the rectified
        // front at this point — exactly the front view the projection overlays.
        // Keep the character-only gate: for non-character the source is a 3/4
        // ISO view that would not overlay a front projection, so reprojecting
        // there would misalign. The script self-guardrails (copy input->output)
        // on any misalignment/low-coverage, so it can never ship a worse face.
        const runFaceFix = (next) => (trellis2FaceFix && assetType === 'character') ? runStep('face', FACE_SCRIPT, ['--source', imagePath], 240000, next) : next();
        const runUpscale = (next) => trellis2UltraHD  ? runStep('8k',      UPSCALE_SCRIPT, ['--scale', '2', '--tile', '512'],     600000, next) : next();

        runRefine(() => runSmooth(() => runFaceFix(() => runUpscale(finishAndResolve))));
      };
      if (jobId) activeProcs.set(jobId, proc);
      // Two-layer memory safety:
      //   1) Working-set cap: tell Windows to swap THIS process to disk
      //      if it tries to grow beyond the per-process RAM limit.
      //      Slower behavior, no kill (Windows pages naturally).
      //   2) All-limits panic kill: kill the job if ANY of the 4 user
      //      limits (RAM, VRAM, GPU%, TEMP) is reached at 99%. Saves
      //      the PC when working-set cap is not enough (cumulative
      //      subprocesses, commit charge, GPU overheat, etc).
      setProcessHardMemoryLimit(proc, `image-to-3d (${engine})`);
      installAllLimitsSafetyKill(proc, `image-to-3d (${engine})`);
      const flushStdout = () => {
        if (stdoutBuf) {
          safeSend('ai3d-progress', stdoutBuf);
          stdoutBuf = '';
          lastSent = Date.now();
        }
      };
      proc.stdout?.on('data', d => {
        const chunk = d.toString();
        stdoutBuf += chunk;
        // Diagnostic: log any LOCAL_*_PROGRESS line we see coming from the
        // bridge, with a timestamp — lets us tell if the bar stays at 5%
        // because (a) the bridge never emits higher values or (b) main.js
        // buffers them or (c) the renderer filters them out.
        const progLines = chunk.split(/\r?\n/).filter(l => /LOCAL_[A-Z0-9_]+_PROGRESS:/.test(l));
        for (const pl of progLines) {
          log.info('progress-diag', `t+${Date.now()}: ${pl.trim()}`);
        }
        const now = Date.now();
        if (now - lastSent > 200) flushStdout();
        checkEarlyResolve();
      });
      proc.stdout?.on('end', () => { flushStdout(); checkEarlyResolve(); });
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
    let errMsg = err.error || err.message || String(err);
    // Extract the last meaningful Python error line — but SKIP benign import
    // warnings (kaolin's optional ipyevents/visualize import contains the word
    // "Error" yet is only a warning, not the failure). Full dump → last_error.log.
    const combined = (err.stdout || '') + '\n' + (err.stderr || '');
    const _isWarn = (l) => /warnings\.warn|UserWarning|FutureWarning|DeprecationWarning|importing kaolin|ipyevents/i.test(l);
    const _isHeader = (l) => /^\s*Traceback \(most recent call last\)/.test(l);
    // The real cause is the EXCEPTION line ("RuntimeError: …", "MemoryError", …),
    // NOT the "Traceback (most recent call last):" header. A traceback that shows
    // only the header means the process was KILLED mid-print (OOM/crash) → leave
    // pyErrorLine empty so the resource-exhaustion branch below fires.
    const pyErrorLine = combined.split(/\r?\n/).reverse()
      .find(l => /MemoryError|CUDA|out of memory|Killed|bad_alloc|Cannot allocate|\b\w*(Error|Exception)\b\s*:/i.test(l.trim())
                 && !_isWarn(l) && !_isHeader(l)) || '';
    // Resource-exhaustion heuristic: an OOM / killed crash leaves NO real Python
    // traceback (only warnings) and the run never reached 100% — the process was
    // killed mid-load. Detect explicit memory markers OR "no real error + did not
    // finish", and surface a clear, actionable message instead of the raw warning.
    const _oomMarker = /MemoryError|CUDA out of memory|out of memory|Killed|bad_alloc|Cannot allocate|paging file|std::bad_alloc/i.test(combined);
    const _reachedDone = /LOCAL_[A-Z0-9_]+_PROGRESS:\s*100\b/.test(combined);
    if (_oomMarker || (!pyErrorLine && !_reachedDone)) {
      errMsg = "La génération s'est interrompue — le plus souvent un manque de mémoire "
        + "(RAM/VRAM saturée). Fermez les applications lourdes (Unreal Engine, navigateurs, "
        + "autres gros logiciels) et réessayez ; un preset plus léger (2048 px) aide si la RAM "
        + "est juste. (Le warning « kaolin / ipyevents » ci-dessous est inoffensif.) "
        + "Détails complets : last_error.log.";
    } else if (pyErrorLine) {
      errMsg = pyErrorLine;
    }
    log.error('main', `image-to-3d FAILED: ${pyErrorLine || errMsg}`);
    // Overwrite (not append) so last_error.log doesn't grow unboundedly.
    try {
      fs.writeFileSync(
        path.join(LOGS_DIR, 'last_error.log'),
        `[${new Date().toISOString()}]\nERROR: ${errMsg}\n\n=== PYTHON STDOUT (last 100 lines) ===\n${(err.stdout || '').split('\n').slice(-100).join('\n')}\n\n=== PYTHON STDERR (last 50 lines) ===\n${(err.stderr || '').split('\n').slice(-50).join('\n')}\n`
      );
    } catch (e) { /* disk full / readonly */ }
    return { success: false, error: errMsg, stdout: err.stdout, stderr: err.stderr };
  }
});

// --- Legacy: TRELLIS only (kept for compatibility) ---
// Free the persistent SDXL image server (7+ GB VRAM) before a heavy NON-image
// GPU op (mesh/3D, multi-view, GPU rig) so the two don't fight over VRAM on a
// 16 GB card. No-op if SDXL isn't loaded; it respawns on the next image op.
async function _freeSdxlForHeavyOp(label) {
  if (!sdxlProc) return;
  try {
    stopSdxlServer();
    try { safeSend('ai3d-progress', `[main] SDXL libéré pour ${label} (rechargé au besoin)\n`); } catch (_) {}
    await new Promise(r => setTimeout(r, 1200));   // let the OS reclaim the VRAM
  } catch (_) {}
}

ipcMain.handle('image-to-3d-trellis', async (event, { imagePath, outputName, textureSize }) => {
  try {
    await _freeSdxlForHeavyOp('mesh 3D');
    const safeName = outputName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = Date.now();
    const meshFilename = `${safeName}_${timestamp}.glb`;
    const meshPath = path.join(MESHES_DIR, meshFilename);
    const bridgeScript = path.join(SCRIPTS_DIR, 'trellis_bridge.py');

    const result = await new Promise((resolve, reject) => {
      const proc = execFile(_aiPython(), [bridgeScript, imagePath, meshPath, String(textureSize || 1024)], {
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
    const bridgeScript = path.join(SCRIPTS_DIR, 'trellis_bridge.py');

    const result = await new Promise((resolve, reject) => {
      execFile(_aiPython(), [bridgeScript, imagePath, meshPath], {
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

// --- Multi-View Generation IPC ---
// Check whether a given image already has `<stem>_multiview/` on disk
// with all 6 views + input. Used by the renderer to re-hydrate the
// multi-view bar after reloadCurrentProject() clears its in-memory cache.
ipcMain.handle('check-multiview-dir', async (_event, imagePath) => {
  try {
    if (!imagePath || !fs.existsSync(imagePath)) return { exists: false };
    const stem = path.basename(imagePath, path.extname(imagePath));
    const mvDir = path.join(path.dirname(imagePath), stem + '_multiview');
    if (!fs.existsSync(mvDir)) return { exists: false };
    for (let i = 0; i < 6; i++) {
      if (!fs.existsSync(path.join(mvDir, `view_${i}.png`))) return { exists: false };
    }
    return { exists: true, dir: mvDir };
  } catch (e) {
    return { exists: false };
  }
});

// Multi-view engine dispatch (shared with mv-inherit).
// Selects the Python script based on FABMESH_MV_ENGINE:
//   mvadapter (default) — MV-Adapter i2mv-sdxl (6 ortho views, 768px, Apache 2.0)
//   sdxl                — SDXL + IPAdapter
//   crm                 — CRM (6 ortho views incl. TOP/BOTTOM, MIT)
// Zero123++ (CC-BY-NC 4.0 weights) removed for commercial distribution.
function _mvScriptForEngine(engineOverride) {
  const engine = (engineOverride
                  || process.env.FABMESH_MV_ENGINE
                  || 'mvadapter').toLowerCase();
  const map = {
    sdxl:      'multiview_sdxl_gen.py',
    crm:       'multiview_crm_gen.py',
    mvadapter: 'multiview_mvadapter_gen.py',
  };
  const name = map[engine] || 'multiview_mvadapter_gen.py';
  log.info('multiview', `engine=${engine} script=${name}`);
  return path.join(SCRIPTS_DIR, name);
}

ipcMain.handle('generate-multiview', async (_event, opts) => {
  const { imagePath, harmonize, upscale, engine: engineOverride } = (opts || {});
  // Per-call engine override: defaults to MV-Adapter (true ortho
  // azim 0/90/180/270, same SDXL base as RealVis so colours match).
  const script = _mvScriptForEngine(engineOverride);
  await _freeSdxlForHeavyOp('multi-vues');
  // Multi-views are tied to the EXACT image version. Output dir derived
  // from the image file path:
  //   images/dog/ref_0.png        → images/dog/ref_0_multiview/
  //   images/dog/ref_0_nobg_X.png → images/dog/ref_0_nobg_X_multiview/
  // This lets the 3D bridge look up "<image_stem>_multiview/" and use those
  // views. Editing a multi-view will create a new image version later.
  const imgBasename = path.basename(imagePath, path.extname(imagePath));
  const outDir = path.join(path.dirname(imagePath), imgBasename + '_multiview');
  return new Promise((resolve) => {
    // Options forwarded from the renderer's Multi-Views modal:
    // - harmonize (default true): RealVis img2img strength 0.3 to recover
    //   photoreal style on top of the MV-Adapter output (+30s).
    // - upscale (default false): Real-ESRGAN 768->1024 to match source
    //   resolution (+10s). Read by the Python multiview scripts.
    const harmonizeFlag = (harmonize === undefined ? true : !!harmonize) ? '1' : '0';
    const upscaleFlag   = (upscale === true) ? '1' : '0';
    const mvEnv = {
      ...process.env,
      PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:True',
      FABMESH_MV_IDENTITY_HARMONIZE: harmonizeFlag,
      FABMESH_MV_UPSCALE: upscaleFlag,
    };
    log.info('multiview', `options: harmonize=${harmonizeFlag} upscale=${upscaleFlag}`);
    const proc = execFile(_aiPython(), [script, imagePath, outDir], {
      timeout: 900000, maxBuffer: 10 * 1024 * 1024,
      env: mvEnv
    }, (error, stdout, stderr) => {
      if (stdout) {
        log.info('multiview', stdout.trim());
        safeSend('multiview-progress', stdout);
      }
      if (error) {
        log.error('multiview', error.message);
        resolve({ success: false, error: error.message });
      } else {
        // Collect output images
        const views = [];
        for (let i = 0; i < 6; i++) {
          const vp = path.join(outDir, `view_${i}.png`);
          if (fs.existsSync(vp)) views.push(vp);
        }
        const inputCopy = path.join(outDir, 'input.png');
        resolve({ success: true, views, inputCopy, outDir });
      }
    });
    installJobLimitsWatchdog(proc, 'generate-multiview');
    // Forward progress — multiview is the last 10% of the parent job
    // (image gen 0..90, multiview 90..99, finalise 100). Map the
    // sub-script's 0..100 into the 90..99 slice and re-emit as
    // LOCAL_IMG_PROGRESS so the renderer's existing
    // LOCAL_*_PROGRESS scraper (index2.js:6375 PROG_RE) picks it up
    // and actually moves the progress bar instead of sitting at 90.
    proc.stdout?.on('data', d => {
      const txt = d.toString();
      const matches = txt.matchAll(/MULTIVIEW_PROGRESS:\s*(\d+)/g);
      let lastSub = -1;
      for (const m of matches) {
        const v = parseInt(m[1]);
        if (v > lastSub) lastSub = v;
      }
      if (lastSub >= 0) {
        safeSend('multiview-progress', { progress: lastSub });
        // Remap lastSub (0..100) into overall 90..99
        const overall = Math.min(99, 90 + Math.round(lastSub * 9 / 100));
        // The renderer's LOCAL_*_PROGRESS scraper (index2.js PROG_RE)
        // listens on 'ai3d-progress' (preload onAI3DProgress) — the old
        // 'mcp-job-progress' channel had NO bridge nor listener, so the
        // bar sat at 90% during the whole multiview phase.
        safeSend('ai3d-progress', `LOCAL_IMG_PROGRESS: ${overall}\n`);
      }
    });
  });
});

// --- Renderer log forwarding (for Claude Code debugging) ---
// In dev: writes to <repo>/logs/renderer.log so we can tail it.
// In prod (packaged): writes to %APPDATA%\fabmesh\renderer.log (writable).
const _userDataDir = (() => {
  try { return app.getPath('userData'); } catch (_) { return path.join(os.homedir(), '.fabmesh'); }
})();
try { if (!fs.existsSync(_userDataDir)) fs.mkdirSync(_userDataDir, { recursive: true }); } catch (_) {}
const _devLogDir = path.join(__dirname, '..', '..', 'logs');
const RENDERER_LOG = app.isPackaged
  ? path.join(_userDataDir, 'renderer.log')
  : path.join(_devLogDir, 'renderer.log');
ipcMain.on('renderer-log', (_event, line) => {
  try {
    fs.appendFileSync(RENDERER_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch (_) {}
});

// --- Wizard log (separate file for first-run issues — most painful bugs) ---
// Lives in %APPDATA%\fabmesh\wizard.log so we can ask the user to send it
// even if they got blocked before the main app could log anywhere else.
const WIZARD_LOG = path.join(_userDataDir, 'wizard.log');
const WIZARD_LOG_PREV = path.join(_userDataDir, 'wizard.prev.log');
// Rotate at every main-process start, so each wizard run has its own log
// without losing the previous one.
try {
  if (fs.existsSync(WIZARD_LOG)) {
    try { fs.renameSync(WIZARD_LOG, WIZARD_LOG_PREV); } catch (_) {}
  }
  fs.writeFileSync(WIZARD_LOG, `[${new Date().toISOString()}] [boot] wizard.log opened (main pid=${process.pid})\n`);
} catch (_) {}
ipcMain.on('wizard-log', (_event, payload) => {
  try {
    const { level = 'log', msg = '' } = (payload && typeof payload === 'object') ? payload : { msg: String(payload) };
    fs.appendFileSync(WIZARD_LOG, `[${new Date().toISOString()}] [${level}] ${msg}\n`);
    if (global.__startupLog) global.__startupLog('wizard', `[${level}] ${msg}`);
  } catch (_) {}
});

// --- Save Buffer IPC (for GLTFExporter output) ---
ipcMain.handle('save-buffer', async (_event, { path: filePath, buffer, base64 }) => {
  try {
    if (base64) {
      fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    } else {
      fs.writeFileSync(filePath, Buffer.from(buffer));
    }
    return { success: true, path: filePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// --- Mesh Tools IPC ---
// AI region re-texture (MVP modif-mesh): render the mesh front so the user can
// draw a mask aligned to face_inpaint_atlas.py's projection, then re-texture the
// painted region with a prompt (generalises face inpaint beyond the face).
ipcMain.handle('mesh:render-front', async (_e, { meshPath } = {}) => {
  const script = path.join(SCRIPTS_DIR, 'face_inpaint_atlas.py');
  const out = path.join(os.tmpdir(), `fabmesh_front_${Date.now()}.png`);
  return new Promise((resolve) => {
    // Distinct dummy output so the script's in==out guard passes; --render-only
    // exits before any GLB is written.
    execFile(_aiPython(), [script, meshPath, meshPath + '.ignore', '--render-only', out],
      { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (error) => {
        if (error || !fs.existsSync(out)) { resolve({ ok: false, error: (error && error.message) || 'render failed' }); return; }
        try {
          const dataUrl = 'data:image/png;base64,' + fs.readFileSync(out).toString('base64');
          // Keep the rendered front on disk so CLIPSeg auto-detect can run on it.
          resolve({ ok: true, dataUrl, frontPath: out });
        } catch (e) { resolve({ ok: false, error: String(e) }); }
      });
  });
});
ipcMain.handle('mesh:region-retex', async (_e, { meshPath, maskDataUrl, prompt, strength, uvMask } = {}) => {
  const script = path.join(SCRIPTS_DIR, 'face_inpaint_atlas.py');
  const maskPath = path.join(os.tmpdir(), `fabmesh_mask_${Date.now()}.png`);
  try {
    fs.writeFileSync(maskPath, Buffer.from(String(maskDataUrl || '').replace(/^data:image\/\w+;base64,/, ''), 'base64'));
  } catch (e) { return { ok: false, error: 'mask write failed: ' + String(e) }; }
  const base = path.basename(meshPath, path.extname(meshPath));
  const out = path.join(path.dirname(meshPath), `${base}_retex_${Date.now()}.glb`);
  return new Promise((resolve) => {
    execFile(_aiPython(), [script, meshPath, out,
      (uvMask ? '--uv-mask' : '--mask'), maskPath, '--prompt', String(prompt || 'detailed texture'),
      '--strength', String(strength || 0.8)],
      { timeout: 600000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
        try { fs.unlinkSync(maskPath); } catch (_) {}
        if (error || !fs.existsSync(out)) { resolve({ ok: false, error: (error && error.message) || 'retex failed', stdout }); return; }
        // Lineage sidecar: prompt + strength du retex masqué + parent explicite.
        writeMeta(out, {
          kind: 'op', op: 'retex', parent: meshPath,
          params: { prompt: String(prompt || ''), strength: strength || 0.8, uvMask: !!uvMask },
        });
        resolve({ ok: true, path: out });
      });
  });
});

ipcMain.handle('mesh-tool', async (_event, { operation, meshPath, params, namedParams }) => {
  const script = path.join(SCRIPTS_DIR, 'mesh_tools.py');
  const timestamp = Date.now();
  const ext = path.extname(meshPath);
  let base = path.basename(meshPath, ext);
  // Strip prior op-suffix chains so the output filename doesn't grow past
  // Windows MAX_PATH (260) after repeated ops (e.g. _smooth_…_fill_holes_…_
  // watertight_… → FileNotFoundError on export). Versions still group: the
  // renderer derives the project from the stripped root either way.
  const OP_SUFFIX = /_(cntile|retexture|decimate|subdivide|smooth|fill_holes|fix_normals|center|set_pivot|watertight|texture_var|trellis2_retex|edited|upscale|refine|augment|vc|segment)(?:_\d{6,})?$/i;
  let _prev;
  do { _prev = base; base = base.replace(OP_SUFFIX, ''); } while (base !== _prev);
  if (base.length > 90) base = base.slice(0, 90);  // hard cap, belt-and-braces
  const outPath = path.join(path.dirname(meshPath), `${base}_${operation}_${timestamp}${ext}`);
  const args = [script, operation, meshPath, outPath, ...(params || [])];

  return new Promise((resolve) => {
    // Force UTF-8 stdio so a non-ASCII log line (accent, arrow, …) can't
    // crash the script with a cp1252 UnicodeEncodeError on Windows.
    const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
    execFile(_aiPython(), args, { timeout: 900000, maxBuffer: 10 * 1024 * 1024, env }, (error, stdout, stderr) => {
      if (stdout) log.info('mesh-tool', stdout.trim());
      if (error) {
        log.error('mesh-tool', error.message);
        resolve({ success: false, error: error.message, stderr });
      } else if (!fs.existsSync(outPath)) {
        resolve({ success: false, error: 'Output file not created' });
      } else {
        const stats = fs.statSync(outPath);
        // Lineage sidecar: op + params (nommés si le renderer les fournit,
        // sinon l'argv positionnel) + parent EXPLICITE (le nom de fichier est
        // aplati par OP_SUFFIX — sans ce champ la chaîne d'ops est perdue).
        writeMeta(outPath, {
          kind: 'op', op: operation, parent: meshPath,
          params: namedParams || { args: params || [] },
        });
        resolve({
          success: true,
          newPath: outPath,
          filename: path.basename(outPath),
          size: stats.size,
          operation,
        });
      }
    });
  });
});

// ── SAMPart3D part segmentation (LOCAL, RTX 5080) ──────────────────────
// Splits the mesh into named, colored parts. Long GPU job (~6-10 min):
// streams progress on 'ai3d-progress' and returns a new MESH version
// (a segmented GLB) — same {success,newPath,filename,size} contract as
// mesh-tool, so runMeshSegment in the renderer reuses the add-version +
// go-to machinery. Runs in the dedicated SAMPart3D env (torch cu128 sm_120
// + pointops + tiny-cuda-nn), provisioned by wizard:install-segment.
ipcMain.handle('mesh-segment', async (_event, { meshPath, granularity, scale }) => {
  const _t0 = Date.now();
  try {
    if (!meshPath || !fs.existsSync(meshPath)) return { success: false, error: 'Mesh not found' };
    if (!isPathAllowed(meshPath)) return { success: false, error: 'Mesh path not allowed' };

    // PartSAM (feedforward, ~40-90 s) — remplace SAMPart3D (optim ~4 min).
    // Pas de Blender, pas de rendu multi-vues : natif 3D.
    const segPython = app.isPackaged
      ? path.join(SEGMENT_PYTHON_DIR, 'python.exe')
      : path.join(__dirname, '..', '..', 'python-segment', 'python.exe');
    const segRepo = app.isPackaged
      ? PARTSAM_DIR
      : path.join(__dirname, '..', '..', 'PartSAM');
    if (!fs.existsSync(segPython) || !fs.existsSync(path.join(segRepo, 'evaluation', 'eval_everypart.py'))) {
      return { success: false, error: app.isPackaged
        ? 'Part-segmentation engine (PartSAM) not installed yet. Open Settings → Reconfigure FabMesh and complete the "Part segmentation" setup step.'
        : 'PartSAM not found at ./PartSAM (dev checkout missing).' };
    }
    const ckpt = path.join(segRepo, 'pretrained', 'model.safetensors');
    if (!fs.existsSync(ckpt)) return { success: false, error: 'PartSAM weights (model.safetensors) missing — re-run the setup step.' };
    const bridge = path.join(SCRIPTS_DIR, 'partsam_bridge.py');
    if (!fs.existsSync(bridge)) return { success: false, error: 'partsam_bridge.py not found' };

    const ts = Date.now();
    const ext = path.extname(meshPath);
    let base = path.basename(meshPath, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    const OP_SUFFIX = /_(cntile|retexture|decimate|subdivide|smooth|fill_holes|fix_normals|center|set_pivot|watertight|texture_var|trellis2_retex|edited|upscale|refine|augment|vc|segment)(?:_\d{6,})?$/i;
    let _p; do { _p = base; base = base.replace(OP_SUFFIX, ''); } while (base !== _p);
    if (base.length > 90) base = base.slice(0, 90);
    // Output is always a GLB scene (multiple named submeshes). MUST NOT
    // contain `_rigged_`/`_anim_` or it lands in the rigs/anims bucket.
    const outPath = path.join(path.dirname(meshPath), `${base}_segment_${ts}.glb`);

    // granularité 0.0 (grossier, ~10 parties propres) → 1.0 (fin, ~45 parties).
    // Rétro-compat : ancienne UI envoyait `scale` 0-2 → on le ramène en 0-1.
    const g = Number.isFinite(+granularity)
      ? Math.max(0, Math.min(1, +granularity))
      : (Number.isFinite(+scale) ? Math.max(0, Math.min(1, +scale / 2)) : 0.2);
    const args = [bridge, meshPath, outPath, String(g)];
    const env = {
      ...process.env,
      PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
      FABMESH_PARTSAM_DIR: segRepo,
      HF_HOME: HF_CACHE_DIR,
      PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:True',
    };
    safeSend('ai3d-progress', '[Segment] Starting part segmentation (PartSAM)…');
    return await new Promise((resolve) => {
      const proc = execFile(segPython, args, { timeout: 600000, maxBuffer: 50 * 1024 * 1024, env }, (error, _stdout, stderr) => {
        if (error) {
          log.error('mesh-segment', error.message + ' :: ' + String(stderr || '').slice(-600));
          resolve({ success: false, error: String(stderr || error.message || 'segmentation failed').slice(-500) });
        } else if (!fs.existsSync(outPath)) {
          resolve({ success: false, error: 'Segmented mesh not created' });
        } else {
          const stats = fs.statSync(outPath);
          console.log(`[mesh-segment] DONE in ${((Date.now() - _t0) / 1000).toFixed(0)}s → ${outPath}`);
          // Lineage sidecar: la granularité effective + le mesh parent explicite.
          writeMeta(outPath, {
            kind: 'op', op: 'segment', engine: 'partsam', parent: meshPath,
            params: { granularity: g },
          });
          resolve({ success: true, newPath: outPath, filename: path.basename(outPath), size: stats.size, operation: 'segment' });
        }
      });
      proc.stdout?.on('data', d => safeSend('ai3d-progress', `[Segment] ${d.toString()}`));
      proc.stderr?.on('data', d => safeSend('ai3d-progress', `[Segment] ${d.toString()}`));
      proc.on('error', e => resolve({ success: false, error: e.message }));
    });
  } catch (e) {
    log.error('mesh-segment', e && e.message);
    return { success: false, error: e && e.message };
  }
});

// Material adjust: wraps scripts/mesh_material_adjust.py for the
// Manual Tools > Material slider modal in the renderer.
// ── Nommage des parties (roue/chenille/tourelle — bras/jambe/tête) ──────
// Sur un mesh SEGMENTÉ (sous-meshes part_XX), route par assetType :
//   vivant + rig → voie squelette (skin weights) ; sinon → voie vision
//   (rendu isolé + CLIP + priors géométriques). Écrit <mesh>.parts.json
//   {parts:[{part_id,label,confidence,abstained}]} et le renvoie. Tourne
//   dans l'env segment (torch cu128 + transformers + CLIP-L en cache).
ipcMain.handle('name-parts', async (_event, { meshPath, assetType, rigPath }) => {
  const _t0 = Date.now();
  try {
    if (!meshPath || !fs.existsSync(meshPath)) return { success: false, error: 'Mesh not found' };
    if (!isPathAllowed(meshPath)) return { success: false, error: 'Mesh path not allowed' };
    const segPython = app.isPackaged
      ? path.join(SEGMENT_PYTHON_DIR, 'python.exe')
      : path.join(__dirname, '..', '..', 'python-segment', 'python.exe');
    if (!fs.existsSync(segPython)) {
      return { success: false, error: app.isPackaged
        ? 'Part engine not installed. Open Settings → Reconfigure FabMesh and complete the "Part segmentation" setup step.'
        : 'python-segment not found (dev checkout missing).' };
    }
    const script = path.join(SCRIPTS_DIR, 'name_parts.py');
    if (!fs.existsSync(script)) return { success: false, error: 'name_parts.py not found' };

    const sidecar = meshPath + '.parts.json';
    const at = String(assetType || 'other').replace(/[^a-z_]/gi, '').slice(0, 20) || 'other';
    const args = [script, meshPath, sidecar, '--asset-type', at];
    if (rigPath && fs.existsSync(rigPath) && isPathAllowed(rigPath)) args.push('--rig', rigPath);
    const env = {
      ...process.env,
      PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
      // CLIP-L vit dans le cache HF PAR DÉFAUT (~/.cache/huggingface) — NE PAS
      // forcer HF_HOME vers hf_cache (app) qui ne le contient pas. Offline pour
      // éviter toute tentative réseau. TODO packaging : provisionner CLIP-L dans
      // le cache par défaut de la machine cible via le wizard.
      HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
      PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:True',
    };
    safeSend('ai3d-progress', '[Name] Naming parts…');
    return await new Promise((resolve) => {
      const proc = execFile(segPython, args, { timeout: 300000, maxBuffer: 20 * 1024 * 1024, env }, (error, _stdout, stderr) => {
        if (error) {
          log.error('name-parts', (error.message || '') + ' :: ' + String(stderr || '').slice(-500));
          resolve({ success: false, error: String(stderr || error.message || 'naming failed').slice(-500) });
          return;
        }
        let data = null;
        try { data = JSON.parse(fs.readFileSync(sidecar, 'utf-8')); } catch (e) {
          resolve({ success: false, error: 'parts.json unreadable: ' + e.message }); return;
        }
        if (!data || data.source === 'error') {
          resolve({ success: false, error: (data && data.error) || 'naming produced no result' }); return;
        }
        console.log(`[name-parts] DONE in ${((Date.now() - _t0) / 1000).toFixed(0)}s → ${(data.parts || []).length} parts (${data.source})`);
        resolve({ success: true, sidecar, parts: data.parts || [], source: data.source, assetType: at });
      });
      proc.stdout?.on('data', d => safeSend('ai3d-progress', `[Name] ${d.toString()}`));
      proc.stderr?.on('data', d => safeSend('ai3d-progress', `[Name] ${d.toString()}`));
      proc.on('error', e => resolve({ success: false, error: e.message }));
    });
  } catch (e) {
    log.error('name-parts', e && e.message);
    return { success: false, error: e && e.message };
  }
});

ipcMain.handle('material-adjust', async (_event, {
  meshPath, brightness, saturation, contrast,
  emissive, metallic, roughness, hue_shift,
}) => {
  const script = path.join(SCRIPTS_DIR, 'mesh_material_adjust.py');
  const timestamp = Date.now();
  const ext = path.extname(meshPath);
  const base = path.basename(meshPath, ext);
  const outPath = path.join(path.dirname(meshPath), `${base}_mat_${timestamp}${ext}`);
  const args = [
    script, meshPath, outPath,
    '--brightness', String(brightness),
    '--saturation', String(saturation),
    '--contrast',   String(contrast),
    '--emissive',   String(emissive),
    '--metallic',   String(metallic),
    '--roughness',  String(roughness),
    '--hue-shift',  String(hue_shift ?? 0),
  ];
  return new Promise((resolve) => {
    execFile(_aiPython(), args, {
      timeout: 120000, maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (stdout) log.info('material-adjust', stdout.trim());
      if (error) {
        log.error('material-adjust', error.message);
        resolve({ success: false, error: error.message, stderr });
      } else if (!fs.existsSync(outPath)) {
        resolve({ success: false, error: 'Output file not created' });
      } else {
        const stats = fs.statSync(outPath);
        // Lineage sidecar: réglages matériau + parent explicite.
        writeMeta(outPath, {
          kind: 'op', op: 'mat', parent: meshPath,
          params: { brightness, saturation, contrast, emissive, metallic, roughness, hue_shift },
        });
        resolve({
          success: true,
          newPath: outPath,
          filename: path.basename(outPath),
          size: stats.size,
        });
      }
    });
  });
});

// ============================================================
// CAPTION IMAGE — BLIP describes the front photo (clothes, hair, etc.)
// for back-view prompt enrichment. Output is added to the back-view
// promptHint so SDXL+IPAdapter generates the same outfit on the back.
// ============================================================
ipcMain.handle('caption-image', async (_event, { imagePath }) => {
  if (!imagePath || !fs.existsSync(imagePath)) {
    return { success: false, error: `image not found: ${imagePath}` };
  }
  const script = path.join(SCRIPTS_DIR, 'caption_image.py');
  return new Promise((resolve) => {
    const env = { ...process.env, PYTHONUNBUFFERED: '1' };
    execFile(_aiPython(), [script, imagePath], {
      env, timeout: 180000, maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (stdout) log.info('caption-image', stdout.trim().slice(-500));
      if (error) {
        log.error('caption-image', error.message);
        resolve({ success: false, error: error.message });
      } else {
        // Parse "CAPTION: ..." line
        const match = (stdout || '').match(/CAPTION:\s*(.+)/);
        const text = match ? match[1].trim() : '';
        resolve({ success: true, caption: text });
      }
    });
  });
});

// ============================================================
// GENERATE BACK VIEW — RealVis XL + IPAdapter, replaces Z123 for the
// 2-view texturing pipeline. Produces a photoreal back view of the
// same subject, conditioned on the front photo.
// ============================================================
ipcMain.handle('generate-back-view', async (_event, { frontImage, promptHint, numImages, mode, assetType, sheetViews }) => {
  if (!frontImage || !fs.existsSync(frontImage)) {
    return { success: false, error: `front image not found: ${frontImage}` };
  }
  // Save back photos in a subdir so the project image scan doesn't pick
  // them up as new versions. The back is data attached to the front, not
  // a sibling version.
  const outDir = path.join(path.dirname(frontImage), '_backphotos');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  // Per-front-image suffix so different fronts don't overwrite each other
  const frontStem = path.basename(frontImage, path.extname(frontImage));
  // Mode selection:
  //   - mode='mirror'    -> generate_back_view_mirror.py (mirror+inpaint)
  //   - mode='realvis'   -> generate_back_view.py (RealVis + ControlNet
  //                         OpenPose humanoid T-pose; ONLY for human/character
  //                         assets — irrelevant skeleton for animals/objects)
  //   - mode='mvadapter' -> generate_back_view_mvadapter.py (MV-Adapter
  //                         multi-view consistent; universal, recommended
  //                         for creatures/animals/objects/vehicles)
  //   - default          -> auto: 'realvis' for assetType='character',
  //                         'mvadapter' otherwise.
  // Back-view dispatch (mirror was reverted 2026-05-20 evening —
  // mirror-flip is fundamentally just a horizontal flip with the head
  // inpainted as "back of head". The torso, arms, asymmetric garments
  // (open jacket, etc) still read as a FRONT view, which is anatomically
  // impossible and looks wrong. Back-view of a humanoid needs a real
  // pose rotation, which only the ControlNet OpenPose back-skeleton
  // path provides.):
  //   - character           -> realvis (RealVis + ControlNet OpenPose
  //                            humanoid back skeleton). Real back pose.
  //                            Outfit drift mitigated by BLIP captioning
  //                            the source image and injecting the
  //                            garment description into the prompt.
  //   - creature / animal   -> mvadapter (huanngzh/MV-Adapter, Apache 2.0).
  //                            Trained on Objaverse-XL — works great on
  //                            organic shapes (animals, monsters, biped
  //                            non-human characters).
  //   - vehicle/building/   -> sheet (RealVisXL 4-view model-sheet).
  //     weapon/prop/...        MV-Adapter fails on vehicles (training set
  //                            bias toward humanoids). Sheet is the safe
  //                            fallback for hard-surface assets.
  let resolvedMode = mode;
  if (!resolvedMode) {
    if (assetType === 'character') resolvedMode = 'realvis';
    else if (assetType === 'creature') resolvedMode = 'mvadapter';
    // ANIMAL: MV-Adapter is humanoid-biased and reinterprets quadrupeds
    // as bipeds in the back-view (see fabmesh#alligator-bipede bug). Use
    // the sheet pipeline instead — it preserves the 4-leg stance.
    else if (assetType === 'animal') resolvedMode = 'sheet';
    else resolvedMode = 'sheet';
  } else if (resolvedMode === 'mvadapter' && assetType
             && assetType !== 'character' && assetType !== 'creature') {
    // Explicit mvadapter request on a non-organic asset — fall back to
    // sheet to avoid the documented car/object distortions AND the
    // quadruped-to-biped reinterpretation on `animal`.
    log.info('generate-back-view',
      `mvadapter requested on assetType=${assetType}, falling back to sheet`);
    resolvedMode = 'sheet';
  }
  const SCRIPT_BY_MODE = {
    sheet:     'generate_back_view_sheet.py',
    mirror:    'generate_back_view_mirror.py',
    realvis:   'generate_back_view.py',
    mvadapter: 'generate_back_view_mvadapter.py',
  };
  const scriptName = SCRIPT_BY_MODE[resolvedMode] || 'generate_back_view.py';
  const script = path.join(SCRIPTS_DIR, scriptName);
  log.info('generate-back-view', `mode=${resolvedMode} assetType=${assetType || '(none)'} -> ${scriptName}`);
  // Pass the front stem as a 5th arg so the python script names files
  // back_<stem>_0.png (avoids collision when multiple fronts in same project).
  const args = [script, frontImage, outDir, promptHint || '', String(numImages || 1), frontStem];
  return new Promise((resolve) => {
    const env = { ...process.env, PYTHONUNBUFFERED: '1' };
    // Forward the requested view count to the sheet generator. Valid:
    // 2 (front+back), 4 (front+right+back+left), 6 (+top+bottom).
    if (sheetViews && [2, 4, 6].includes(Number(sheetViews))) {
      env.FABMESH_SHEET_VIEWS = String(sheetViews);
    }
    execFile(_aiPython(), args, {
      env, timeout: 600000, maxBuffer: 50 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (stdout) log.info('generate-back-view', stdout.trim().slice(-2000));
      if (error) {
        log.error('generate-back-view', error.message);
        resolve({ success: false, error: error.message,
                  stderr: (stderr || '').slice(-1000) });
      } else {
        const paths = (stdout || '').split('\n')
          .filter(l => l.startsWith('BACK_VIEW_PATH:'))
          .map(l => l.replace('BACK_VIEW_PATH:', '').trim());
        resolve({ success: true, paths });
      }
    });
  });
});

// ============================================================
// ALIGN TEXTURE — manual photo→mesh projection re-trigger.
// Calls texture_project.py directly with user-tweaked params from
// the Align Texture modal. Writes back to the same mesh path.
// ============================================================
ipcMain.handle('mesh:align-texture', async (_event, params) => {
  const {
    meshPath, imagePath,
    translateX = 0, translateY = 0, translateZ = 0,
    meshScale = 1.0, rotY = 0,
    visThresh = 0.5,
    autofit = true, frameFix = true, skipVflip = true,
  } = params || {};
  if (!meshPath || !fs.existsSync(meshPath)) {
    return { ok: false, error: `mesh not found: ${meshPath}` };
  }
  if (!imagePath || !fs.existsSync(imagePath)) {
    return { ok: false, error: `image not found: ${imagePath}` };
  }
  const projectScript = path.join(SCRIPTS_DIR,
                                   'texture_project.py');
  const args = [projectScript, meshPath, imagePath, meshPath, '1024'];
  // Look for an mv/ dir alongside the mesh to enable multi-view.
  const meshDir = path.dirname(meshPath);
  const mvDir = path.join(meshDir, 'mv');
  if (fs.existsSync(mvDir) && fs.existsSync(path.join(mvDir, 'views.json'))) {
    args.push('--multiview', mvDir);
  }
  // rotation_offset_deg propagated for multi-view azimuth shift.
  if (Math.abs(rotY) > 0.01) {
    args.push('--rotation-offset', String(rotY));
  }
  const env = {
    ...process.env,
    FABMESH_TEXPROJ_FRAME_FIX: frameFix ? '1' : '0',
    FABMESH_TEXPROJ_SKIP_BACK_VFLIP: skipVflip ? '1' : '0',
    FABMESH_TEXPROJ_VIS_THRESH: String(visThresh),
  };
  // Translate/scale: pre-transform mesh in a temp copy if any transform
  // is non-default, then re-project on the transformed copy. The original
  // mesh stays untouched until success, then we swap.
  const needsPreTransform = (
    Math.abs(translateX) > 0.001 ||
    Math.abs(translateY) > 0.001 ||
    Math.abs(translateZ) > 0.001 ||
    Math.abs(meshScale - 1) > 0.001
  );
  let workMeshPath = meshPath;
  if (needsPreTransform) {
    const tmpPath = meshPath.replace(/\.glb$/i, '.aligntemp.glb');
    const preScript = path.join(SCRIPTS_DIR,
                                 'mesh_pre_transform.py');
    try {
      await new Promise((resolve, reject) => {
        execFile(_aiPython(), [preScript, meshPath, tmpPath,
                            String(translateX), String(translateY),
                            String(meshScale), String(translateZ)], {
          timeout: 60000, maxBuffer: 4 * 1024 * 1024,
        }, (error, stdout, stderr) => {
          if (stdout) log.info('mesh:align-texture/pre', stdout.trim().slice(-1000));
          if (error) reject(new Error(`pre_transform: ${error.message}`));
          else resolve();
        });
      });
      workMeshPath = tmpPath;
      // Update args to use the transformed mesh as input AND output
      args[1] = tmpPath;
      args[3] = tmpPath;
    } catch (preErr) {
      return { ok: false, error: preErr.message };
    }
  }
  return new Promise((resolve) => {
    execFile(_aiPython(), args, {
      env, timeout: 300000, maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (stdout) log.info('mesh:align-texture', stdout.trim().slice(-2000));
      if (error) {
        log.error('mesh:align-texture', error.message);
        if (workMeshPath !== meshPath) {
          try { fs.unlinkSync(workMeshPath); } catch (_) {}
        }
        resolve({ ok: false, error: error.message, stderr: (stderr || '').slice(-1000) });
      } else {
        // BACKUP previous version before overwriting (mesh history).
        // Even when texture_project rewrites in place (workMeshPath === meshPath),
        // we want a snapshot so the user can revert a bad align.
        try {
          const meshDir = path.dirname(meshPath);
          const meshExt = path.extname(meshPath);
          const meshBase = path.basename(meshPath, meshExt);
          const histDir = path.join(meshDir, '.history');
          if (!fs.existsSync(histDir)) fs.mkdirSync(histDir, { recursive: true });
          // Snapshot the OLD mesh (if any). If we used a temp pre-transform
          // copy, the original meshPath still has the un-edited mesh.
          if (fs.existsSync(meshPath)) {
            const backupPath = path.join(histDir,
              `${meshBase}_prealign_${Date.now()}${meshExt}`);
            fs.copyFileSync(meshPath, backupPath);
            log.info('mesh:align-texture',
                     `backed up previous mesh to ${backupPath}`);
          }
        } catch (bkErr) {
          log.warn('mesh:align-texture', `backup failed: ${bkErr.message}`);
        }
        // Swap transformed+textured mesh into the original path on success
        if (workMeshPath !== meshPath) {
          try {
            fs.copyFileSync(workMeshPath, meshPath);
            fs.unlinkSync(workMeshPath);
          } catch (swapErr) {
            log.error('mesh:align-texture', `swap failed: ${swapErr.message}`);
          }
        }
        resolve({ ok: true, meshPath });
      }
    });
  });
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

// =====================================================================
// First-run wizard IPC handlers
// =====================================================================
// All wizard:* IPC calls live here. Keep the surface minimal — every
// extra channel is one more thing to validate.
ipcMain.handle('wizard:detect-hardware', async () => {
  const script = path.join(SCRIPTS_DIR, 'hw_detect.py');
  return new Promise((resolve, reject) => {
    execFile(_aiPython(), [script], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      try { resolve(JSON.parse(stdout.trim().split(/\r?\n/).pop())); }
      catch (e) { reject(new Error('cannot parse hw_detect output: ' + e.message)); }
    });
  });
});

// Manifest of models per mode — keep in sync with what each script actually
// needs. Sizes are HF download approximations (MB).
// Generic UI labels (no model brand visible). Internal IDs stay so the
// download/test scripts know what they're pulling.
const WIZARD_MODELS = {
  lite:     [
    { id: 'trellis2',  label: 'MyFabmesh.AI 3D Core',                          repo: 'microsoft/TRELLIS.2-4B',                         size_mb: 4100 },
    { id: 'blip1',     label: 'Vision analyzer',                          repo: 'Salesforce/blip-image-captioning-large',         size_mb: 990 },
  ],
  standard: [
    { id: 'trellis2',  label: 'MyFabmesh.AI 3D Core',                          repo: 'microsoft/TRELLIS.2-4B',                         size_mb: 4100 },
    { id: 'realvis',   label: 'Texture engine',                           repo: 'SG161222/RealVisXL_V4.0',                        size_mb: 6500 },
    { id: 'lightning', label: 'Turbo engine (Lightning)',                 repo: 'ByteDance/SDXL-Lightning',                       size_mb: 400  },
    { id: 'cn_pose',   label: 'Back-view module',                         repo: 'xinsir/controlnet-openpose-sdxl-1.0',            size_mb: 2400 },
    { id: 'ipadapter', label: 'Reference module',                         repo: 'h94/IP-Adapter',                                 size_mb: 700  },
    { id: 'blip1',     label: 'Vision analyzer',                          repo: 'Salesforce/blip-image-captioning-large',         size_mb: 990  },
    { id: 'esrgan',    label: 'Upscale engine',                           repo: 'github://RealESRGAN_x4plus',                      size_mb: 70   },
  ],
  full:     [
    { id: 'trellis2',  label: 'MyFabmesh.AI 3D Core (Ultra)',                  repo: 'microsoft/TRELLIS.2-4B',                         size_mb: 4100 },
    { id: 'realvis',   label: 'Texture engine',                           repo: 'SG161222/RealVisXL_V4.0',                        size_mb: 6500 },
    { id: 'lightning', label: 'Turbo engine (Lightning)',                 repo: 'ByteDance/SDXL-Lightning',                       size_mb: 400  },
    { id: 'sdxl_inp',  label: 'Face refiner',                             repo: 'diffusers/stable-diffusion-xl-1.0-inpainting-0.1', size_mb: 6500 },
    { id: 'cn_pose',   label: 'Back-view module',                         repo: 'xinsir/controlnet-openpose-sdxl-1.0',            size_mb: 2400 },
    { id: 'ipadapter', label: 'Reference module',                         repo: 'h94/IP-Adapter',                                 size_mb: 700  },
    { id: 'florence2', label: 'Advanced vision analyzer',                 repo: 'microsoft/Florence-2-large',                     size_mb: 1700 },
    { id: 'blip1',     label: 'Basic vision analyzer',                    repo: 'Salesforce/blip-image-captioning-large',         size_mb: 990  },
    { id: 'esrgan',    label: 'Upscale engine',                           repo: 'github://RealESRGAN_x4plus',                      size_mb: 70   },
  ],
};

ipcMain.handle('wizard:download-plan', (_e, mode) => {
  const items = WIZARD_MODELS[mode] || [];
  const total_mb = items.reduce((s, x) => s + x.size_mb, 0);
  return { mode, items, total_mb };
});

// Free-space probe for the drive that will hold the AI env + models
// (HEAVY_DIR / the configured dataDir). The wizard calls this BEFORE starting
// a multi-GB download so a user with too little space is warned up front,
// instead of after 30 min of downloading into a disk that then fills and
// leaves a half-written, permanently-broken install. Probes the drive ROOT
// (always exists) rather than HF_CACHE_DIR (may not be created yet).
ipcMain.handle('wizard:free-space', () => {
  try {
    const root = path.parse(HF_CACHE_DIR).root || HEAVY_DIR;
    const s = fs.statfsSync(root);
    return { ok: true, freeBytes: s.bavail * s.bsize, drive: root };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('wizard:start-download', async (event, mode) => {
  const items = WIZARD_MODELS[mode] || [];
  if (!items.length) return { skipped: true };
  // We delegate the actual snapshot_download() to a small Python helper
  // that knows about HuggingFace's resume + cache, and streams JSONL
  // progress lines to our stdout listener.
  const script = path.join(SCRIPTS_DIR, 'wizard_download.py');
  log.info('wizard', `start-download: mode=${mode}, ${items.length} model(s), cache=${HF_CACHE_DIR}`);
  return new Promise((resolve, reject) => {
    // Capture stderr so a real failure (wizard_download.py exits 1 and writes
    // the failing model(s) to stderr) surfaces a MEANINGFUL message to the
    // wizard's Retry UI instead of Node's generic "Command failed". maxBuffer
    // bumped to 64 MB: a long download with retries emits many progress lines.
    let stderrBuf = '';
    const proc = execFile(_aiPython(), [script, '--mode', mode], {
      timeout: 0, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PYTHONUNBUFFERED: '1', HF_HOME: HF_CACHE_DIR, HUGGINGFACE_HUB_CACHE: path.join(HF_CACHE_DIR, 'hub') },
    }, (err) => {
      if (err) {
        const detail = (stderrBuf.trim() || err.message || 'download failed');
        log.error('wizard', `start-download FAILED (mode=${mode}): ${detail.slice(-1500)}`);
        return reject(new Error(detail));
      }
      log.info('wizard', `start-download: mode=${mode} completed OK`);
      resolve({ ok: true });
    });
    let buf = '';
    proc.stdout?.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const p = JSON.parse(line);
          // Journal per-model outcomes (not every progress tick) so a remote
          // fabmesh.log has a clear timeline for support without spamming.
          if (p.error) log.warn('wizard', `download ${p.id}: ERROR ${p.error}`);
          else if (p.warn) log.warn('wizard', `download ${p.id}: WARN ${p.warn}`);
          else if (p.msg && /retry/i.test(p.msg)) log.info('wizard', `download ${p.id}: ${p.msg}`);
          else if (p.done && p.id && p.id !== '__all__') log.info('wizard', `download ${p.id}: done`);
          event.sender.send('wizard:download-progress', p);
        } catch (_) {}
      }
    });
    proc.stderr?.on('data', (d) => {
      stderrBuf += d.toString();
      if (stderrBuf.length > 65536) stderrBuf = stderrBuf.slice(-65536);
    });
  });
});

ipcMain.handle('wizard:final-test', async (event, mode) => {
  // Cloud mode has nothing to test locally — succeed immediately.
  if (mode === 'cloud') return { success: true, duration_s: 0 };
  const script = path.join(SCRIPTS_DIR, 'wizard_smoke_test.py');
  const t0 = Date.now();
  return new Promise((resolve) => {
    // Buffer stderr (PyTorch warnings, CUDA path traces) instead of
    // streaming it live to the wizard — those leak internal model
    // identifiers and confuse the user. Only flush on failure.
    let stderrBuf = '';
    const proc = execFile(_aiPython(), [script, '--mode', mode], {
      timeout: 180000, maxBuffer: 5 * 1024 * 1024,
      env: { ...process.env, PYTHONUNBUFFERED: '1', HF_HOME: HF_CACHE_DIR, HUGGINGFACE_HUB_CACHE: path.join(HF_CACHE_DIR, 'hub') },
    }, (err) => {
      const duration_s = Math.round((Date.now() - t0) / 1000);
      if (err) {
        // Only on failure: surface the buffered stderr so the user can
        // copy/paste it into a support ticket.
        if (stderrBuf) {
          event.sender.send('wizard:test-log', '\n--- diagnostics ---\n' + stderrBuf);
        }
        return resolve({ success: false, duration_s, error: err.message });
      }
      resolve({ success: true, duration_s });
    });
    proc.stdout?.on('data', d => {
      // Stream stdout only — and only lines that come from our smoke
      // test (prefixed [smoke]). Anything else is a leaked framework
      // log line.
      const text = d.toString();
      const filtered = text.split(/\r?\n/)
        .filter(l => !l || l.startsWith('[smoke]'))
        .join('\n');
      if (filtered.trim()) event.sender.send('wizard:test-log', filtered);
    });
    proc.stderr?.on('data', d => { stderrBuf += d.toString(); });
  });
});

ipcMain.handle('wizard:get-version', () => app.getVersion());

// Auto-update IPC for the renderer.
ipcMain.handle('app:check-for-update', async () => {
  if (!_updater) return { ok: false, error: 'updater not available' };
  if (!app.isPackaged) return { ok: false, error: 'dev build, skipping' };
  try {
    const result = await _updater.checkForUpdates();
    return { ok: true, hasUpdate: !!result?.updateInfo, version: result?.updateInfo?.version || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('app:install-update-now', () => {
  if (!_updater || !_updateDownloaded) {
    return { ok: false, error: 'no update downloaded yet' };
  }
  // quitAndInstall closes the app, runs the installer, relaunches.
  setImmediate(() => _updater.quitAndInstall(false, true));
  return { ok: true };
});

// Returns the path to the embedded Python interpreter shipped with
// FabMesh. In a packaged build, electron-builder copies build/python-embed/
// to <install>/resources/python-embed/. In dev mode, falls back to the
// system 'python' on PATH (we assume the dev has one).
function _embeddedPython() {
  const packagedPath = path.join(
    process.resourcesPath || '', 'python-embed', 'python.exe');
  if (fs.existsSync(packagedPath)) return packagedPath;
  const devPath = path.join(__dirname, '..', '..', 'build',
                             'python-embed', 'python.exe');
  if (fs.existsSync(devPath)) return devPath;
  return 'python';  // dev fallback
}

// One-click diagnostics export: bundles the logs + system info into a
// single .txt on the user's Desktop so they (or a friend testing the
// app) can send it to support without hunting through %APPDATA%.
ipcMain.handle('export-diagnostics', async () => {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19).replace('T', '_');
    const out = path.join(app.getPath('desktop'), `MyFabmesh-diagnostics-${stamp}.txt`);
    const tail = (name, max = 500 * 1024) => {
      try {
        const b = fs.readFileSync(path.join(LOGS_DIR, name));
        return b.length > max
          ? '...(truncated, last ' + Math.round(max / 1024) + ' KB)...\n' + b.slice(b.length - max).toString('utf8')
          : b.toString('utf8');
      } catch (e) { return '(not available: ' + (e && e.message) + ')'; }
    };
    const body = [
      'MyFabmesh.AI diagnostics',
      'generated : ' + new Date().toISOString(),
      'version   : ' + app.getVersion() + '   packaged: ' + app.isPackaged,
      'os        : ' + process.platform + ' ' + os.release() + ' ' + process.arch,
      'dataBase  : ' + DATA_BASE,
      'aiPython  : exists=' + fs.existsSync(path.join(AI_PYTHON_DIR, 'python.exe')) + '  torchReady=' + _aiPythonReady(),
      '',
      '===== fabmesh.log =====', tail('fabmesh.log'),
      '', '===== wizard.log =====', tail('wizard.log'),
      '', '===== last_error.log =====', tail('last_error.log'),
    ].join('\n');
    fs.writeFileSync(out, body, 'utf8');
    try { shell.showItemInFolder(out); } catch (_) {}
    return { ok: true, path: out };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// Interpreter for AI scripts (need torch/diffusers). Resolution order:
//  - packaged + provisioned -> the writable copy under userData/python
//  - dev                    -> system 'python' (the dev already has torch)
//  - packaged, not set up    -> embedded (bare; AI scripts must wait for
//    first-run setup to finish before they are invoked)
function _aiPython() {
  const provisioned = path.join(AI_PYTHON_DIR, 'python.exe');
  if (fs.existsSync(provisioned)) return provisioned;
  if (!app.isPackaged) return 'python';
  return _embeddedPython();
}
// True once torch has been installed into the writable copy.
function _aiPythonReady() {
  return fs.existsSync(path.join(AI_PYTHON_DIR, 'Lib', 'site-packages', 'torch'));
}
ipcMain.handle('wizard:get-python-exe', () => _embeddedPython());
ipcMain.handle('wizard:ai-python-ready', () => _aiPythonReady());

// Data location (relocatable heavy data: AI venv + models). Lets the user
// move the ~7-22 GB download off C: onto another drive (config.dataDir).
ipcMain.handle('get-data-location', () => {
  let freeBytes = null;
  try {
    const base = fs.existsSync(HEAVY_DIR) ? HEAVY_DIR : path.parse(HEAVY_DIR).root;
    const s = fs.statfsSync(base);
    freeBytes = s.bavail * s.bsize;
  } catch (_) {}
  return { path: HEAVY_DIR, isDefault: HEAVY_DIR === DATA_BASE, freeBytes };
});
ipcMain.handle('pick-data-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose where to store the AI models + engine (~7-22 GB)',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false };
  const dir = path.join(r.filePaths[0], 'MyFabmesh-data');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, error: e.message }; }
  try { const t = path.join(dir, '.write_test'); fs.writeFileSync(t, 'ok'); fs.unlinkSync(t); }
  catch (e) { return { ok: false, error: 'Folder is not writable: ' + e.message }; }
  let freeBytes = null;
  try { const s = fs.statfsSync(dir); freeBytes = s.bavail * s.bsize; } catch (_) {}
  const cfg = loadConfig(); cfg.dataDir = dir; saveConfig(cfg);
  log.info('main', 'data location set to ' + dir + ' (restart to apply)');
  return { ok: true, path: dir, freeBytes, restartNeeded: HEAVY_DIR !== dir };
});
// HEAVY_DIR is read once at boot, so a new location applies after a restart.
ipcMain.handle('restart-app', () => { app.relaunch(); app.exit(0); });

// First-run AI env provisioning. The embedded python (resources/
// python-embed) is read-only under MSIX and has no venv module, so we
// COPY it to a writable per-user dir (AI_PYTHON_DIR) once, then pip-
// install torch/diffusers/etc. INTO the copy via wizard_install_deps.py.
// Streams JSONL progress via wizard:install-progress.
ipcMain.handle('wizard:install-deps', async (event) => {
  const destPy = path.join(AI_PYTHON_DIR, 'python.exe');
  log.info('main', 'install-deps: START. AI_PYTHON_DIR=' + AI_PYTHON_DIR + ' destPy exists=' + fs.existsSync(destPy));
  // 1. Copy the embedded interpreter to the writable location (once).
  if (!fs.existsSync(destPy)) {
    const srcDir = path.dirname(_embeddedPython());
    log.info('main', 'install-deps: copying ' + srcDir + ' -> ' + AI_PYTHON_DIR);
    event.sender.send('wizard:install-progress', { step: 'copy-python', pct: 0, done: false, msg: 'Preparing Python environment' });
    try {
      fs.cpSync(srcDir, AI_PYTHON_DIR, { recursive: true });
      log.info('main', 'install-deps: copy done (destPy now exists=' + fs.existsSync(destPy) + ')');
    } catch (e) {
      log.error('main', 'install-deps: COPY FAILED: ' + (e && e.message));
      return { ok: false, error: 'copy failed: ' + (e && e.message) };
    }
  }
  // 2. pip-install torch + diffusers + etc. INTO the writable copy.
  const script = path.join(SCRIPTS_DIR, 'wizard_install_deps.py');
  log.info('main', 'install-deps: spawning ' + destPy + ' ' + script);
  return new Promise((resolve, reject) => {
    let stderrBuf = '';
    const proc = execFile(destPy, [script, '--python', destPy], {
      timeout: 0, maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env, PYTHONUNBUFFERED: '1', HF_HOME: HF_CACHE_DIR,
        HUGGINGFACE_HUB_CACHE: path.join(HF_CACHE_DIR, 'hub'),
        // TRELLIS-2 custom wheels (o-voxel/cumesh/flex-gemm/spconv) bundled
        // in extraResources — wizard_install_deps tries this dir before the
        // FabMesh CDN. Absent in dev (CDN fallback applies).
        ...(app.isPackaged
          ? { FABMESH_WHEELS_DIR: path.join(process.resourcesPath, 'wheels') }
          : {}),
      },
    }, (err) => {
      if (err) {
        log.error('main', 'install-deps: FAILED code=' + err.code + ' msg=' + err.message + ' | stderr tail: ' + stderrBuf.slice(-2000));
        reject(new Error(err.message + (stderrBuf ? ' | ' + stderrBuf.slice(-400) : '')));
      } else {
        log.info('main', 'install-deps: process exited 0 — SUCCESS. torchReady=' + _aiPythonReady());
        resolve({ ok: true });
      }
    });
    let buf = '';
    proc.stdout?.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const p = JSON.parse(line);
          if (p.step) log.info('main', 'install-deps step=' + p.step + ' pct=' + p.pct + (p.error ? ' ERROR=' + p.error : '') + (p.warn ? ' warn=' + p.warn : ''));
          event.sender.send('wizard:install-progress', p);
        } catch (_) {}
      }
    });
    proc.stderr?.on('data', (d) => { stderrBuf += d.toString(); if (stderrBuf.length > 200000) stderrBuf = stderrBuf.slice(-100000); });
  });
});

// Provision the Puppeteer rig engine (Phase 3 of the wizard): copy the
// embedded Python to a SECOND env (torch 2.7, incompatible with the AI
// env's torch 2.8), pip the pinned rig stack, copy the Puppeteer code tree
// from resources, download the 3 checkpoints (~9.6 GB) from HuggingFace.
// Streams JSONL progress via wizard:rig-progress.
ipcMain.handle('wizard:install-rig', async (event) => {
  const destPy = path.join(RIG_PYTHON_DIR, 'python.exe');
  log.info('main', 'install-rig: START. RIG_PYTHON_DIR=' + RIG_PYTHON_DIR + ' destPy exists=' + fs.existsSync(destPy));
  if (!fs.existsSync(destPy)) {
    const srcDir = path.dirname(_embeddedPython());
    event.sender.send('wizard:rig-progress', { step: 'rig-copy-python', pct: 0, done: false });
    try {
      fs.cpSync(srcDir, RIG_PYTHON_DIR, { recursive: true });
    } catch (e) {
      log.error('main', 'install-rig: COPY FAILED: ' + (e && e.message));
      return { ok: false, error: 'copy failed: ' + (e && e.message) };
    }
  }
  const script = path.join(SCRIPTS_DIR, 'wizard_install_rig.py');
  const codeSrc = app.isPackaged
    ? path.join(process.resourcesPath, 'Puppeteer')
    : path.join(__dirname, '..', '..', 'external', 'Puppeteer');
  log.info('main', 'install-rig: spawning ' + destPy + ' ' + script);
  return new Promise((resolve, reject) => {
    let stderrBuf = '';
    const proc = execFile(destPy, [script, '--python', destPy], {
      timeout: 0, maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env, PYTHONUNBUFFERED: '1',
        HF_HOME: HF_CACHE_DIR,
        HUGGINGFACE_HUB_CACHE: path.join(HF_CACHE_DIR, 'hub'),
        FABMESH_PUPPETEER_CODE: codeSrc,
        FABMESH_PUPPETEER_DIR: PUPPETEER_DIR,
      },
    }, (err) => {
      if (err) {
        log.error('main', 'install-rig: FAILED code=' + err.code + ' msg=' + err.message + ' | stderr tail: ' + stderrBuf.slice(-2000));
        reject(new Error(err.message + (stderrBuf ? ' | ' + stderrBuf.slice(-400) : '')));
      } else {
        log.info('main', 'install-rig: SUCCESS. rigReady=' + fs.existsSync(path.join(PUPPETEER_DIR, 'skeleton', 'demo.py')));
        resolve({ ok: true });
      }
    });
    let buf = '';
    proc.stdout?.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const p = JSON.parse(line);
          if (p.step) log.info('main', 'install-rig step=' + p.step + ' pct=' + p.pct + (p.error ? ' ERROR=' + p.error : '') + (p.warn ? ' warn=' + p.warn : ''));
          event.sender.send('wizard:rig-progress', p);
        } catch (_) {}
      }
    });
    proc.stderr?.on('data', (d) => { stderrBuf += d.toString(); if (stderrBuf.length > 200000) stderrBuf = stderrBuf.slice(-100000); });
  });
});

// Provision the SAMPart3D part-segmentation engine (optional wizard phase):
// copy embedded Python to a THIRD env (torch cu128 + source-built spconv/
// pointops — incompatible with the AI + rig envs), clone+patch the repo,
// build the CUDA deps, download ptv3-object.pth + SAM ViT-H + Blender 4.0.
// Streams JSONL progress via wizard:segment-progress. NOTE: this env needs a
// C++/CUDA build toolchain (VS Build Tools + CUDA Toolkit 12.8); the wizard
// checks for it up front and fails clearly if missing.
ipcMain.handle('wizard:install-segment', async (event) => {
  const destPy = path.join(SEGMENT_PYTHON_DIR, 'python.exe');
  log.info('main', 'install-segment: START. SEGMENT_PYTHON_DIR=' + SEGMENT_PYTHON_DIR + ' destPy exists=' + fs.existsSync(destPy));
  if (!fs.existsSync(destPy)) {
    const srcDir = path.dirname(_embeddedPython());
    event.sender.send('wizard:segment-progress', { step: 'seg-copy-python', pct: 0, done: false });
    try {
      fs.cpSync(srcDir, SEGMENT_PYTHON_DIR, { recursive: true });
    } catch (e) {
      log.error('main', 'install-segment: COPY FAILED: ' + (e && e.message));
      return { ok: false, error: 'copy failed: ' + (e && e.message) };
    }
  }
  const script = path.join(SCRIPTS_DIR, 'wizard_install_segment.py');
  log.info('main', 'install-segment: spawning ' + destPy + ' ' + script);
  return new Promise((resolve, reject) => {
    let stderrBuf = '';
    const proc = execFile(destPy, [script, '--python', destPy], {
      timeout: 0, maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1',
        HF_HOME: HF_CACHE_DIR,
        HUGGINGFACE_HUB_CACHE: path.join(HF_CACHE_DIR, 'hub'),
        FABMESH_SEGMENT_DIR: SAMPART3D_DIR,
      },
    }, (err) => {
      if (err) {
        log.error('main', 'install-segment: FAILED code=' + err.code + ' msg=' + err.message + ' | stderr tail: ' + stderrBuf.slice(-2000));
        reject(new Error(err.message + (stderrBuf ? ' | ' + stderrBuf.slice(-400) : '')));
      } else {
        log.info('main', 'install-segment: SUCCESS. segReady=' + fs.existsSync(path.join(SAMPART3D_DIR, 'ckpts', 'ptv3-object.pth')));
        resolve({ ok: true });
      }
    });
    let buf = '';
    proc.stdout?.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const p = JSON.parse(line);
          if (p.step) log.info('main', 'install-segment step=' + p.step + ' pct=' + p.pct + (p.error ? ' ERROR=' + p.error : '') + (p.warn ? ' warn=' + p.warn : ''));
          event.sender.send('wizard:segment-progress', p);
        } catch (_) {}
      }
    });
    proc.stderr?.on('data', (d) => { stderrBuf += d.toString(); if (stderrBuf.length > 200000) stderrBuf = stderrBuf.slice(-100000); });
  });
});

// Reconfigure FabMesh: wipe setup_state.json and reload the wizard.
// Models cached on disk + user projects are kept (only the "setup
// done" flag is reset), so the wizard reopens but the heavy assets
// are still there if the user only wants to change install mode.
// Trouve le désinstalleur NSIS de façon ROBUSTE. Le nom exact dépend du
// productName (« Uninstall MyFabmesh.AI.exe » — l'ancien code cherchait
// « Uninstall FabMesh.exe » et ne le trouvait donc JAMAIS). On tente, dans
// l'ordre : (1) à côté de l'exe (packagé) par glob « Uninstall *.exe », puis
// (2) l'UninstallString du registre Windows — ce qui marche AUSSI en dev tant
// que l'app est installée sur la machine.
function _findUninstaller() {
  try {
    const appDir = path.dirname(app.getPath('exe'));
    const hit = fs.readdirSync(appDir).find((f) => /^Uninstall .*\.exe$/i.test(f));
    if (hit) return path.join(appDir, hit);
  } catch (_) {}
  if (process.platform === 'win32') {
    for (const root of ['HKCU', 'HKLM']) {
      try {
        const out = require('child_process').execFileSync('reg',
          ['query', `${root}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, '/s'],
          { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
        // Cherche une UninstallString qui pointe vers notre désinstalleur.
        const re = /UninstallString\s+REG_SZ\s+(.+)/gi;
        let m;
        while ((m = re.exec(out))) {
          const val = m[1].trim();
          if (!/myfabmesh/i.test(val)) continue;
          const q = val.match(/^"([^"]+\.exe)"/i) || val.match(/^([^\s"]+\.exe)/i);
          const exe = q ? q[1] : null;
          if (exe && fs.existsSync(exe)) return exe;
        }
      } catch (_) {}
    }
  }
  return null;
}

// Launch the NSIS uninstaller (from the app or from dev — resolved via the
// exe folder or the Windows registry). The uninstaller itself asks whether to
// also delete models/generated content/settings.
ipcMain.handle('app:uninstall', async (_e, opts = {}) => {
  const uninstaller = _findUninstaller();
  if (uninstaller) {
    const { spawn } = require('child_process');
    // On lance le désinstalleur en SILENCIEUX (/S) : les questions (confirmer,
    // supprimer modèles / contenus générés / réglages) sont déjà posées par la
    // jolie popup in-app → plus AUCUN dialogue Windows moche. Les choix sont
    // transmis via variables d'env, lues par customUnInstall (build/uninstaller.nsh).
    const env = {
      ...process.env,
      FABMESH_UNINST_MODELS: opts.models ? '1' : '0',
      FABMESH_UNINST_GENERATED: opts.generated ? '1' : '0',
      FABMESH_UNINST_SETTINGS: opts.settings ? '1' : '0',
    };
    spawn(uninstaller, ['/S', '/currentuser'], { detached: true, stdio: 'ignore', env }).unref();
    // En build packagé, on quitte pour libérer les fichiers verrouillés ;
    // en dev l'app installée est distincte, on ne tue pas l'éditeur.
    if (app.isPackaged) setTimeout(() => app.quit(), 500);
    return { ok: true, mode: 'nsis', packaged: app.isPackaged };
  }
  return {
    ok: false,
    mode: 'not-installed',
    error: "Désinstalleur introuvable — MyFabmesh.AI n'est pas installé sur "
         + 'cette machine (ou a déjà été désinstallé). Rien à faire.',
  };
});

// Stash the current setup_state.json before reloading the wizard. The
// backup lets the user cancel mid-reconfigure and end up exactly where
// they were. Wiped on wizard:complete; restored on wizard:cancel.
const SETUP_BACKUP_FILE = SETUP_STATE_FILE + '.backup';

ipcMain.handle('wizard:reset-setup', () => {
  try {
    if (fs.existsSync(SETUP_STATE_FILE)) {
      fs.copyFileSync(SETUP_STATE_FILE, SETUP_BACKUP_FILE);
      fs.unlinkSync(SETUP_STATE_FILE);
    }
    log.info('wizard', 'setup_state stashed — reloading wizard');
  } catch (e) {
    log.warn('wizard', `cannot stash setup_state: ${e.message}`);
    return { ok: false, error: e.message };
  }
  if (mainWindow) {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'wizard.html'));
  }
  return { ok: true };
});

// First-run = no backup (user never installed before). Reconfigure =
// backup present (the wizard is being relaunched from Settings). The
// wizard uses this to decide between "Quit" and "Cancel" labels.
ipcMain.handle('wizard:get-mode', () => {
  return { mode: fs.existsSync(SETUP_BACKUP_FILE) ? 'reconfigure' : 'first-run' };
});

ipcMain.handle('wizard:cancel', () => {
  if (fs.existsSync(SETUP_BACKUP_FILE)) {
    try {
      fs.copyFileSync(SETUP_BACKUP_FILE, SETUP_STATE_FILE);
      fs.unlinkSync(SETUP_BACKUP_FILE);
      log.info('wizard', 'reconfigure cancelled, prior state restored');
    } catch (e) {
      log.warn('wizard', `restore failed: ${e.message}`);
    }
    if (mainWindow) {
      mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index2.html'));
    }
    return { ok: true, mode: 'reconfigure' };
  }
  // First-run cancel: nothing to restore, just quit the app.
  log.info('wizard', 'first-run cancelled — quitting');
  setTimeout(() => app.quit(), 100);
  return { ok: true, mode: 'first-run' };
});

// Whitelisted external destinations the renderer is allowed to open
// via the default browser. Anything else is rejected — the renderer
// (which could be exploited by a hostile asset) cannot launch
// arbitrary protocols or sketchy domains.
const _EXTERNAL_HOST_ALLOWLIST = [
  'myfabmesh.ai',           // future custom domain (also covers cloud.myfabmesh.ai)
  'fabmesh.com',            // legacy redirect domain
  'fabienlacaze.github.io', // current GitHub Pages URL
  'github.com',             // for /MyFabmesh repo links
  'myfabmesh-cloud.fabien65400.workers.dev', // LIVE cloud host (the no-GPU "Open Cloud" button)
];

function _isAllowedExternal(u) {
  try {
    if (u.protocol !== 'https:') return false;
    return _EXTERNAL_HOST_ALLOWLIST.some(
      h => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch (_) { return false; }
}

ipcMain.handle('wizard:open-external', async (_e, url) => {
  try {
    const u = new URL(url);
    if (!_isAllowedExternal(u)) {
      return { ok: false, error: 'url not allowed' };
    }
    const { shell } = require('electron');
    await shell.openExternal(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Opens the MyFabmesh.AI website in the user's default browser.
// Called when the user clicks the brand in the main app header.
ipcMain.handle('app:open-website', async () => {
  const url = 'https://fabienlacaze.github.io/MyFabmesh/';
  try {
    const { shell } = require('electron');
    await shell.openExternal(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('wizard:complete', (_e, state) => {
  try {
    fs.mkdirSync(path.dirname(SETUP_STATE_FILE), { recursive: true });
    fs.writeFileSync(SETUP_STATE_FILE, JSON.stringify({
      completed_at: new Date().toISOString(),
      mode: state?.mode || null,
      hw: state?.hw || null,
    }, null, 2));
    // Setup successfully finished: drop the backup. Any future cancel
    // would just quit (no rollback target).
    if (fs.existsSync(SETUP_BACKUP_FILE)) {
      try { fs.unlinkSync(SETUP_BACKUP_FILE); } catch (_) {}
    }
    log.info('wizard', `setup completed (mode=${state?.mode})`);
  } catch (e) {
    log.warn('wizard', `cannot persist setup_state: ${e.message}`);
  }
  if (mainWindow) {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index2.html'));
  }
  return { ok: true };
});

ipcMain.handle('get-config', () => loadConfig());

// Return the Control API Bearer token so the renderer's live-logs viewer
// can open an authenticated EventSource to /logs/stream.
ipcMain.handle('get-control-api-token', () => {
  try {
    const p = path.join(__dirname, '..', '..', '.test_api_token');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8').trim();
  } catch (_) {}
  return null;
});

// Patch-merge into config.json. Only whitelisted fields are accepted to
// avoid the renderer corrupting arbitrary keys.
ipcMain.handle('set-config', (_event, patch) => {
  if (!patch || typeof patch !== 'object') return { success: false, error: 'invalid patch' };
  const config = loadConfig();
  const ALLOWED = new Set(['blenderPath']);
  for (const [k, v] of Object.entries(patch)) {
    if (ALLOWED.has(k)) config[k] = v;
  }
  saveConfig(config);
  return { success: true };
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
    const mcpServerScript = path.join(SCRIPTS_DIR, 'mcp_server.py').replace(/\\/g, '\\\\');
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

// Lineage sidecar reader (Generation History popup) — renvoie le .meta.json
// parsé de n'importe quel artefact (image/mesh/rig/anim), ou null.
ipcMain.handle('get-lineage-meta', async (_e, { filePath } = {}) => {
  try {
    if (!filePath || !isPathAllowed(filePath)) return null;
    return readMeta(filePath);
  } catch (_) { return null; }
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
    const [thumbExists, source, lineage, partsData] = await Promise.all([
      fsp.access(thumbPath).then(() => true).catch(() => false),
      fsp.readFile(sourcePath, 'utf-8').then(s => s.trim()).catch(() => null),
      // Lineage sidecar (Generation History): engine/op/parent/params.
      fsp.readFile(fullPath + '.meta.json', 'utf-8')
        .then(s => JSON.parse(s)).catch(() => null),
      // Part-naming sidecar (zones nommées) : parts:[{part_id,label,confidence,abstained}].
      fsp.readFile(fullPath + '.parts.json', 'utf-8')
        .then(s => JSON.parse(s)).catch(() => null),
    ]);
    return {
      filename: f,
      path: fullPath,
      size: stats.size,
      created: stats.birthtime,
      format: path.extname(f).slice(1).toUpperCase(),
      thumb: thumbExists ? 'file:///' + thumbPath.replace(/\\/g, '/') : null,
      sourceImage: source,
      meta: lineage || null,
      parts: (partsData && Array.isArray(partsData.parts)) ? partsData.parts : null
    };
  }));
  const list = results.filter(Boolean);
  // Future-inherit: a derived mesh (retex / rig / fill_holes / smooth / …) shares
  // its parent's source image. For any mesh still missing a .source sidecar, find
  // the closest ancestor (longest filename-stem prefix) that HAS one, adopt +
  // persist it. Covers every derived op without patching each call site; the
  // sidecar is written once, then read from disk on subsequent lists.
  try {
    const _stem = (f) => f.replace(/\.[^.]+$/, '');
    const _withSrc = list.filter((r) => r.sourceImage)
      .map((r) => ({ src: r.sourceImage, s: _stem(r.filename) }))
      .sort((a, b) => b.s.length - a.s.length);
    for (const m of list) {
      if (m.sourceImage) continue;
      const cs = _stem(m.filename);
      const parent = _withSrc.find((p) => cs === p.s || cs.startsWith(p.s + '_'));
      if (parent) {
        m.sourceImage = parent.src;
        fsp.writeFile(path.join(MESHES_DIR, m.filename + '.source'),
                      parent.src, 'utf-8').catch(() => {});
      }
    }
  } catch (e) { /* inherit is best-effort */ }
  return list.sort((a, b) => new Date(b.created) - new Date(a.created));
});

ipcMain.handle('get-mesh-path', (event, filename) => {
  return path.join(MESHES_DIR, filename);
});

// 2026-06-13: list everything in meshes/animated/ so the renderer can
// rebuild p.animations after a reload. Rokoko outputs land here as
// `${motionFbxStem}__${rigGlbStem}.glb`, so we can attribute each
// clip back to its source rig by suffix match.
ipcMain.handle('list-animations', async () => {
  const animDir = path.join(MESHES_DIR, 'animated');
  if (!fs.existsSync(animDir)) return [];
  const fsp = fs.promises;
  let files;
  try { files = await fsp.readdir(animDir); } catch (e) { return []; }
  const glbs = files.filter(f => f.toLowerCase().endsWith('.glb'));
  const results = await Promise.all(glbs.map(async (f) => {
    const fullPath = path.join(animDir, f);
    let stats;
    try { stats = await fsp.stat(fullPath); } catch (e) { return null; }
    const base = f.replace(/\.glb$/i, '');
    const sep = base.indexOf('__');
    const motionStem = sep > 0 ? base.slice(0, sep) : base;
    const rigStem    = sep > 0 ? base.slice(sep + 2) : '';
    // Pull a friendly animation type out of the motion stem when present.
    const lc = motionStem.toLowerCase();
    const KNOWN = ['idle', 'walk', 'run', 'attack', 'death', 'fly',
                   'jump', 'dance', 'bite', 'hit', 'sit', 'crawl'];
    const type = KNOWN.find(t => lc.includes(t)) || 'clip';
    return {
      filename: f,
      path: fullPath,
      size: stats.size,
      created: stats.birthtime,
      mtime: stats.mtimeMs,
      url: 'file:///' + fullPath.replace(/\\/g, '/'),
      motionStem,
      rigStem,
      type,
    };
  }));
  return results.filter(Boolean).sort((a, b) => b.mtime - a.mtime);
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

// =============================================================================
// 2026-06-12: register the v1 animation pipeline (Rokoko retarget + judge +
// motion library). Defined in ./animation.js — exposes:
//   anim:list-motions  (filtered by detected class)
//   anim:motion-thumb  (lazy thumbnail)
//   anim:retarget      (local subprocess or Modal cloud)
//   anim:judge         (quality scorer)
//   anim:export        (GLB / FBX / USD)
// =============================================================================
try {
  require('./animation').register({
    ipcMain, app, BrowserWindow,
    MESHES_DIR, isPathAllowed, trackProc,
  });
} catch (e) {
  console.error('[animation] register failed:', e.message);
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
    log.warn('delete-file', `blocked path outside allowed dirs: ${filePath}`);
    return false;
  }
  // Always also drop the .nsfw sidecar (parental control tag) if it
  // exists — it's bound to the PNG, not data on its own.
  const sidecar = filePath + '.nsfw';
  let sidecarDeleted = false;
  if (fs.existsSync(sidecar)) {
    try { fs.unlinkSync(sidecar); sidecarDeleted = true; } catch (_) {}
  }
  if (!fs.existsSync(filePath)) {
    // The PNG itself doesn't exist (typical case: NSFW filter blocked
    // the generation and only the .nsfw sidecar was written). If we
    // managed to clean the sidecar, count that as a successful delete
    // so the UI removes the dead version from the strip.
    if (sidecarDeleted) {
      log.info('delete-file', `PNG missing but cleaned orphan sidecar: ${sidecar}`);
      return true;
    }
    log.warn('delete-file', `file does not exist: ${filePath}`);
    return false;
  }
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (e) {
    // Windows often holds a file lock when the image is displayed in the
    // renderer's <img> element. Best-effort: rename it to .pending_delete
    // so the UI loses its reference, then delete on next launch via
    // garbage collection.
    log.warn('delete-file', `unlink failed (${e.code || e.name}): ${e.message}`);
    try {
      const stash = filePath + '.pending_delete_' + Date.now();
      fs.renameSync(filePath, stash);
      log.info('delete-file', `renamed for deferred delete: ${stash}`);
      return true;
    } catch (e2) {
      log.error('delete-file', `rename fallback also failed: ${e2.message}`);
      return false;
    }
  }
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
        .filter(f => /\.(png|jpg|jpeg|webp|gif)$/i.test(f))
        // Exclude debug/auxiliary files (masks, internal artifacts). NOTE:
        // '_rectified' images ARE shown as versions on purpose now — they are
        // the actual auto-rectified input that generated the mesh, so the user
        // can see them and "jump to source" can highlight them.
        .filter(f => !f.includes('_mask') && !f.startsWith('.') && !f.startsWith('_'))
        .map(f => {
          const fp = path.join(dir, f);
          const st = fs.statSync(fp);
          return { path: fp, created: st.birthtime, mtime: st.mtime, size: st.size };
        })
        .sort((a, b) => new Date(b.created) - new Date(a.created));
      const promptFile = path.join(dir, 'prompt.txt');
      const prompt = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf-8').trim() : '';
      // 2-view: look for back photos in <project>/_backphotos/ and map them
      // back to their matching front by filename stem (back_<stem>_0.png).
      const backDir = path.join(dir, '_backphotos');
      const backPhotos = {};
      if (fs.existsSync(backDir)) {
        try {
          const backFiles = fs.readdirSync(backDir)
            .filter(f => /^back_.*\.png$/i.test(f));
          for (const bf of backFiles) {
            // back_<stem>_<i>.png — derive stem, find matching front image
            const m = bf.match(/^back_(.+)_\d+\.png$/i);
            if (!m) continue;
            const stem = m[1];
            const frontMatch = imgs.find(img => {
              const fn = path.basename(img.path, path.extname(img.path));
              return fn === stem;
            });
            if (frontMatch) {
              backPhotos[frontMatch.path] = path.join(backDir, bf);
            }
          }
        } catch (_) { /* ignore */ }
      }
      // Get latest folder mtime from latest image
      const latestTime = imgs.length > 0 ? imgs[0].created : fs.statSync(dir).birthtime;
      return {
        name: d,
        path: dir,
        images: imgs.map(i => i.path),
        imagesData: imgs,
        count: imgs.length,
        created: latestTime,
        prompt,
        backPhotos,
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

// -----------------------------------------------------------------------------
// Blender resolution — shared by export-mesh (FBX/rig) and src/main/animation.js.
// Order: config.blenderPath (if it exists) → auto-detection → null.
// Kept self-contained (no external deps) so both call sites resolve identically.
// -----------------------------------------------------------------------------
function _autoDetectBlender() {
  // Explicit dev override wins.
  if (process.env.BLENDER_EXE && fs.existsSync(process.env.BLENDER_EXE)) {
    return process.env.BLENDER_EXE;
  }
  const pf   = process.env['ProgramFiles']      || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const candidates = [];
  // Program Files\Blender Foundation\Blender X.Y\blender.exe
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
  // Steam install
  for (const steam of [
    path.join(pf86, 'Steam', 'steamapps', 'common', 'Blender', 'blender.exe'),
    path.join(pf,   'Steam', 'steamapps', 'common', 'Blender', 'blender.exe'),
  ]) {
    try { if (fs.existsSync(steam)) candidates.push(steam); } catch (_) {}
  }
  if (candidates.length) {
    // Highest version last alphabetically → sort desc so "Blender 4.4" beats "4.2".
    candidates.sort();
    return candidates[candidates.length - 1];
  }
  // Last resort: PATH lookup.
  try {
    const out = require('child_process').execSync('where blender', {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const first = out.split(/\r?\n/)[0];
    if (first && fs.existsSync(first)) return first;
  } catch (_) {}
  return null;
}

function _resolveBlenderPath() {
  const config = loadConfig();
  if (config.blenderPath && fs.existsSync(config.blenderPath)) return config.blenderPath;
  const auto = _autoDetectBlender();
  if (auto) {
    // Persist so later calls (and animation.js) reuse it without re-scanning.
    try { config.blenderPath = auto; saveConfig(config); } catch (_) {}
    return auto;
  }
  return null;
}

// Convert a mesh to a non-FBX format WITHOUT Blender, using the AI Python env's
// trimesh. glb→glb (same container) is a straight copy; everything else is a
// trimesh load+export. FBX is the only format that still requires Blender.
function _exportViaTrimesh({ sourcePath, outputPath, targetFormat }) {
  return new Promise((resolve, reject) => {
    const srcExt = path.extname(sourcePath).slice(1).toLowerCase();
    if (srcExt === targetFormat) {
      try {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.copyFileSync(sourcePath, outputPath);
        return resolve({ path: outputPath, filename: path.basename(outputPath) });
      } catch (e) { return reject({ error: e.message }); }
    }
    const pyCode = [
      'import sys, trimesh',
      'src, out, fmt = sys.argv[1], sys.argv[2], sys.argv[3]',
      'obj = trimesh.load(src, process=False)',
      'obj.export(out, file_type=fmt)',
      'print("TRIMESH_EXPORT_OK", out)',
    ].join('\n');
    const proc = execFile(_aiPython(), ['-c', pyCode, sourcePath, outputPath, targetFormat], {
      timeout: 120000, maxBuffer: 50 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      try {
        fs.writeFileSync(
          path.join(LOGS_DIR, 'last_error.log'),
          `[${new Date().toISOString()}] export-mesh (trimesh)\nsource: ${sourcePath}\noutput: ${outputPath}\nformat: ${targetFormat}\n\n=== STDOUT ===\n${stdout || ''}\n\n=== STDERR ===\n${stderr || ''}\n`
        );
      } catch (_) {}
      if (error) return reject({ error: 'Conversion trimesh échouée : ' + error.message, stderr });
      if (!fs.existsSync(outputPath)) return reject({ error: 'Export failed (aucun fichier produit)' });
      resolve({ path: outputPath, filename: path.basename(outputPath) });
    });
    proc.on('error', err => reject({ error: err.message }));
  });
}

ipcMain.handle('export-mesh', async (event, { sourcePath, targetFormat, customName, outputPath: customOutputPath }) => {
  const config = loadConfig();

  // Validate inputs against injection
  const validFormats = ['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply', 'fbx_unreal'];
  if (!validFormats.includes(targetFormat)) throw new Error('Invalid target format: ' + targetFormat);
  if (!isPathAllowed(sourcePath)) throw new Error('Source path not allowed');
  // For Unreal export the actual file extension is .fbx
  const realFormat = targetFormat === 'fbx_unreal' ? 'fbx' : targetFormat;
  const isUnreal = targetFormat === 'fbx_unreal';

  // Only FBX needs Blender. glb/gltf/obj/stl/ply go through trimesh below.
  const needsBlender = (realFormat === 'fbx');
  let blenderPath = null;
  if (needsBlender) {
    blenderPath = _resolveBlenderPath();
    if (!blenderPath) {
      throw new Error(
        "Blender est requis pour l'export FBX mais reste introuvable. " +
        "Installez Blender (blender.org) puis indiquez son chemin dans Réglages, " +
        "ou exportez en GLB/OBJ/STL/PLY/GLTF (aucun Blender requis)."
      );
    }
  }

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

  // Non-FBX formats: convert via trimesh (no Blender). The source mesh is a GLB,
  // so glb→glb is a copy and glb→obj/stl/ply/gltf is a trimesh re-export.
  if (!needsBlender) {
    return _exportViaTrimesh({ sourcePath, outputPath, targetFormat: realFormat });
  }

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
    const proc = execFile(blenderPath, ['--background', '--python', tmpScript], {
      timeout: 60000,
      maxBuffer: 50 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      cleanup();
      // Write Blender's full stdout/stderr to last_error.log so the user can
      // inspect the EXPORT: lines that tell what textures were embedded.
      try {
        fs.writeFileSync(
          path.join(LOGS_DIR, 'last_error.log'),
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

// Export an image to a user-picked location. Copies the source file as-is
// (no transcoding) so layers/alpha are preserved. Returns the written path
// or null if the user cancelled.
ipcMain.handle('export-image', async (event, { srcPath, defaultName }) => {
  try {
    if (!srcPath || !fs.existsSync(srcPath)) {
      return { ok: false, error: 'Source not found' };
    }
    const srcExt = path.extname(srcPath).slice(1).toLowerCase() || 'png';
    const base = defaultName || path.basename(srcPath, path.extname(srcPath));
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export image as...',
      defaultPath: base + '.' + srcExt,
      filters: [
        { name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
    fs.copyFileSync(srcPath, result.filePath);
    return { ok: true, path: result.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
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
    // For 3D meshes, surface the source image recorded in the <mesh>.source
    // sidecar (written at generation time) so viewers can offer a
    // "jump to source image" link.
    if (['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply'].includes(ext)) {
      try {
        const sidecar = filePath + '.source';
        if (fs.existsSync(sidecar)) {
          const src = fs.readFileSync(sidecar, 'utf-8').trim();
          if (src) info.sourceImage = src;
        }
      } catch (e) { /* no sidecar — skip */ }
    }
    return info;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
