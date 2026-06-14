// ============================================================
// FabMesh Control API — public, always-on HTTP control plane
// ============================================================
// Local-only HTTP server on 127.0.0.1:7331 that lets any external
// process (scripts, Claude Code, batch pipelines, CI, other apps)
// drive the Electron app end-to-end:
//   * generate images / meshes / rigs
//   * run every IPC handler exposed by preload.js via POST /ipc
//   * read and edit log files
//   * capture full-page and per-thumbnail screenshots, diff versions
//   * subscribe to state changes and job progress
//
// Always-on: enabled by default. Disable with FABMESH_CONTROL_API=0.
// Back-compat: legacy FABMESH_TEST_API=1 still forces-enables.
//
// SECURITY: Binds to 127.0.0.1 only. Every request requires a Bearer
// token stored in ~/.fabmesh/test_api_token.txt (readable only by the
// current user). Never expose this port externally.
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { ipcMain, app } = require('electron');

const PORT = 7331;
const HOST = '127.0.0.1';

// Auth token: random 32-byte hex generated at startup, stored in a file
// readable only by the current user. Every endpoint requires this token
// in the Authorization header (or ?token= query param) to prevent any
// other local process from invoking the dangerous /eval endpoint.
let _authToken = null;
function _initAuthToken() {
  _authToken = crypto.randomBytes(32).toString('hex');
  const tokenDir = path.join(os.homedir(), '.fabmesh');
  try {
    if (!fs.existsSync(tokenDir)) fs.mkdirSync(tokenDir, { recursive: true });
  } catch (_) {}
  const tokenFile = path.join(tokenDir, 'test_api_token.txt');
  try {
    fs.writeFileSync(tokenFile, _authToken, { encoding: 'utf-8', mode: 0o600 });
  } catch (e) {
    console.error('[test_api] could not write token file:', e.message);
  }
  // Also write to project root for the bash helper — DEV ONLY.
  // In a packaged build __dirname/../.. is the read-only install dir
  // (app.asar / WindowsApps), so this write always fails; skip it.
  try {
    if (!(app && app.isPackaged)) {
      const projectToken = path.join(__dirname, '..', '..', '.test_api_token');
      fs.writeFileSync(projectToken, _authToken, { encoding: 'utf-8', mode: 0o600 });
    }
  } catch (_) {}
  console.log('[test_api] auth token written to', tokenFile);
}
function _checkAuth(req) {
  if (!_authToken) return false;
  // Header form: Authorization: Bearer <token>
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    const t = auth.slice(7).trim();
    if (t === _authToken) return true;
  }
  // Query string fallback: ?token=...
  try {
    const u = new URL(req.url, 'http://' + HOST + ':' + PORT);
    if (u.searchParams.get('token') === _authToken) return true;
  } catch (_) {}
  return false;
}

// Pending renderer commands keyed by id. When the renderer sends
// back test:result, we look up the promise and resolve it.
const _pending = new Map();
let _cmdCounter = 0;

// Renderer console buffer (filled by test:console IPC)
const _consoleBuf = [];
const CONSOLE_MAX = 1000;

// Recent request tracker — ring buffer of the last N hits, used by the
// /status endpoint and the Settings UI to show whether external clients
// are actually using the API.
const _reqHistory = [];
const REQ_HISTORY_MAX = 50;
function _recordRequest(req, statusCode) {
  try {
    _reqHistory.push({
      ts: Date.now(),
      method: req.method,
      path: (req.url || '').split('?')[0],
      remote: (req.socket && req.socket.remoteAddress) || 'unknown',
      ua: (req.headers && req.headers['user-agent']) || '',
      status: statusCode,
    });
    while (_reqHistory.length > REQ_HISTORY_MAX) _reqHistory.shift();
  } catch (_) {}
}

// Cached last known renderer state (filled by test:state-push)
let _lastState = null;

function _newCmdId() {
  _cmdCounter++;
  return 'cmd_' + Date.now() + '_' + _cmdCounter;
}

// Send a command to the renderer and wait for its reply.
function rendererCall(mainWindow, action, payload, timeoutMs = 30000) {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) {
      return resolve({ ok: false, error: 'mainWindow not available' });
    }
    const id = _newCmdId();
    const timer = setTimeout(() => {
      if (_pending.has(id)) {
        _pending.delete(id);
        resolve({ ok: false, error: 'timeout waiting for renderer' });
      }
    }, timeoutMs);
    _pending.set(id, { resolve, timer });
    try {
      mainWindow.webContents.send('test:command', { id, action, payload });
    } catch (e) {
      _pending.delete(id);
      clearTimeout(timer);
      resolve({ ok: false, error: 'send failed: ' + e.message });
    }
  });
}

// Register IPC listeners once at module load.
function _installIpcHandlers() {
  // Renderer posts back command results
  ipcMain.on('test:result', (_event, msg) => {
    try {
      if (!msg || !msg.id) return;
      const entry = _pending.get(msg.id);
      if (!entry) return;
      _pending.delete(msg.id);
      clearTimeout(entry.timer);
      entry.resolve({ ok: !msg.error, data: msg.data, error: msg.error });
    } catch (e) { /* ignore */ }
  });

  // Renderer streams console log entries
  ipcMain.on('test:console', (_event, entry) => {
    try {
      _consoleBuf.push(entry);
      while (_consoleBuf.length > CONSOLE_MAX) _consoleBuf.shift();
    } catch (e) { /* ignore */ }
  });

  // Renderer pushes a state snapshot whenever it changes
  ipcMain.on('test:state-push', (_event, snap) => {
    _lastState = snap;
  });
}

// Read JSON body from an HTTP request (safe, capped).
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > 2 * 1024 * 1024) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) { resolve({ __parse_error: e.message }); }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, code, payload) {
  try {
    const body = JSON.stringify(payload);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Access-Control-Allow-Origin': '*'
    });
    res.end(body);
  } catch (e) { try { res.end(); } catch (_) {} }
}

function sendOk(res, data)        { sendJson(res, 200, { ok: true,  data }); }
function sendErr(res, err, code=500) { sendJson(res, code, { ok: false, error: String(err && err.message || err) }); }

// Tail last N lines of a file safely.
function tailFile(filePath, lines) {
  try {
    if (!fs.existsSync(filePath)) return '';
    const stat = fs.statSync(filePath);
    const MAX = 512 * 1024;
    const start = Math.max(0, stat.size - MAX);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    const arr = text.split(/\r?\n/);
    return arr.slice(-lines).join('\n');
  } catch (e) {
    return '[tail error: ' + e.message + ']';
  }
}

// ============================================================
// Start HTTP server
// ============================================================
function startControlApi(mainWindow, opts = {}) {
  // Default OFF in packaged/Store builds: an always-listening localhost
  // HTTP control plane is exactly the kind of thing a Store reviewer /
  // static analyzer flags, and its token write targets a read-only dir.
  // Dev box: still always-on. Force-enable in prod with FABMESH_CONTROL_API=1.
  // Legacy FABMESH_TEST_API=1 still forces enable for scripts that set it.
  const envDisabled = process.env.FABMESH_CONTROL_API === '0';
  const envForced = process.env.FABMESH_CONTROL_API === '1';
  const legacyForce = process.env.FABMESH_TEST_API === '1';
  const packaged = !!(app && app.isPackaged);
  const enabled = legacyForce || envForced
    || (!envDisabled && opts.force !== false && !packaged);
  if (!enabled) {
    console.log('[control_api] disabled (packaged=' + packaged + ')');
    return null;
  }

  _initAuthToken();
  _installIpcHandlers();

  const rootDir = path.join(__dirname, '..', '..');
  const LOG_FILE      = path.join(rootDir, 'logs', 'fabmesh.log');
  const LAST_ERROR    = path.join(rootDir, 'last_error.log');

  const routes = {
    'GET /': async (req, res) => {
      sendOk(res, {
        name: 'FabMesh Control API',
        version: 2,
        endpoints: [
          'GET  /',
          'GET  /state',
          'GET  /screenshot                 (full Electron window PNG)',
          'GET  /screenshot-file?path=      (stream any PNG/JPG inside project root)',
          'GET  /thumbs?project=&kind=      (list image|mesh versions + paths)',
          'POST /compare-thumbs             {a, b, threshold?}  pixel-diff two files',
          'GET  /logs?file=&lines=200       (file optional; back-compat default: fabmesh + error)',
          'GET  /logs/list',
          'POST /logs/clear                 {file}',
          'POST /logs/append                {file, line | content}',
          'POST /logs/rotate                {file}',
          'GET  /logs/stream?file=fabmesh   (Server-Sent Events live tail)',
          'GET  /console',
          'GET  /ipc/methods                   (list every window.meshyAPI.* method)',
          'POST /ipc                {method, args?: [...] | arg?: ...}  generic IPC dispatch',
          'POST /click              {selector}',
          'POST /eval               {code}',
          'POST /set                {selector, value}',
          'POST /select-project     {name}',
          'POST /generate-image     {prompt, engine, count, steps}',
          'POST /generate-3d        {imageIndex, engine}',
          'POST /auto-rig           {}',
          'GET  /jobs',
          'GET  /wait-job?id=xxx&timeout=300',
          'GET  /popups',
          'POST /dismiss-popup     {id?}',
          'GET  /last-error',
          'GET  /devtools-open',
          'POST /calib/run                  run full auto-diagnose (SF3D + z123 + projection)',
          'GET  /calib/list-reports',
          'GET  /calib/last-report',
          'GET  /calib/report?name=...',
          'GET  /calib/log?lines=500        tail logs/fabmesh.log filtered by [calib]',
          'POST /calib/build-rubiks        rebuild the Rubik\'s calibration reference'
        ]
      });
    },

    // Status endpoint for the in-app Settings panel. Returns the
    // server's "I'm alive" info plus recent request history so the UI
    // can show whether external clients are currently using the API.
    'GET /status': async (req, res) => {
      const now = Date.now();
      const last5min = _reqHistory.filter(r => now - r.ts < 5 * 60 * 1000);
      // Distinct user-agents (truncated) seen in last 5 min — gives a
      // hint of what clients are talking to us.
      const ua_set = {};
      for (const r of last5min) {
        const k = (r.ua || 'unknown').slice(0, 60);
        ua_set[k] = (ua_set[k] || 0) + 1;
      }
      sendOk(res, {
        listening: true,
        host: HOST,
        port: PORT,
        version: 2,
        uptime_s: process.uptime ? Math.floor(process.uptime()) : null,
        token_hint: _authToken ? (_authToken.slice(0, 8) + '...' + _authToken.slice(-4)) : null,
        request_count_total: _reqHistory.length,
        request_count_5min: last5min.length,
        recent_clients: ua_set,
        recent_requests: _reqHistory.slice(-10).map(r => ({
          ts: r.ts,
          method: r.method,
          path: r.path,
          remote: r.remote,
          status: r.status,
        })),
      });
    },

    'GET /state': async (req, res) => {
      const r = await rendererCall(mainWindow, 'state', {});
      if (!r.ok) return sendErr(res, r.error);
      sendOk(res, r.data);
    },

    'GET /screenshot': async (req, res) => {
      try {
        if (!mainWindow || mainWindow.isDestroyed()) return sendErr(res, 'no window');
        const img = await mainWindow.webContents.capturePage();
        const png = img.toPNG();
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': png.length,
          'Access-Control-Allow-Origin': '*'
        });
        res.end(png);
      } catch (e) { sendErr(res, e); }
    },

    // GET /screenshot-file?path=<abs path>
    // Stream any PNG/JPG on disk directly. Useful for fetching a version
    // thumbnail (e.g. images/<project>/ref_2.png) without going through
    // the Electron webContents capture (which captures the whole window).
    'GET /screenshot-file': async (req, res, url) => {
      try {
        const p = url.searchParams.get('path');
        if (!p) return sendErr(res, 'missing path', 400);
        if (!fs.existsSync(p)) return sendErr(res, 'not found: ' + p, 404);
        // Allow only paths INSIDE the project root to prevent arbitrary reads
        const abs = path.resolve(p);
        if (!abs.startsWith(rootDir)) {
          return sendErr(res, 'path outside project root', 400);
        }
        const ext = path.extname(abs).slice(1).toLowerCase();
        const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
                       webp: 'image/webp', gif: 'image/gif' }[ext] || 'application/octet-stream';
        const data = fs.readFileSync(abs);
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Length': data.length,
          'Access-Control-Allow-Origin': '*',
        });
        res.end(data);
      } catch (e) { sendErr(res, e); }
    },

    // GET /thumbs?project=<name>&kind=image|mesh
    // List every version's on-disk file + size + mtime for a project.
    // Lets a remote analyser iterate versions and pull their bytes via
    // /screenshot-file.
    'GET /thumbs': async (req, res, url) => {
      try {
        const project = url.searchParams.get('project');
        const kind = (url.searchParams.get('kind') || 'image').toLowerCase();
        if (!project) return sendErr(res, 'missing project', 400);
        let dir, filter;
        if (kind === 'image') {
          dir = path.join(rootDir, 'images', project);
          filter = f => /\.(png|jpe?g|webp)$/i.test(f);
        } else if (kind === 'mesh') {
          dir = path.join(rootDir, 'meshes');
          filter = f => f.toLowerCase().includes(project.toLowerCase()) && /\.glb$/i.test(f);
        } else {
          return sendErr(res, 'kind must be image or mesh', 400);
        }
        if (!fs.existsSync(dir)) return sendOk(res, { project, kind, items: [] });
        const files = fs.readdirSync(dir).filter(filter).map(f => {
          const abs = path.join(dir, f);
          const st = fs.statSync(abs);
          return { name: f, path: abs, sizeBytes: st.size, modified: st.mtime };
        }).sort((a, b) => a.modified - b.modified);
        sendOk(res, { project, kind, items: files });
      } catch (e) { sendErr(res, e); }
    },

    // POST /compare-thumbs {a, b, threshold?}
    // Pixel-diff between two images. Returns
    //   { widthA, heightA, widthB, heightB,
    //     comparable, pixelCount, diffPixels, diffRatio }
    // 'comparable' is false when dimensions differ. threshold is the
    // per-channel delta below which a pixel is considered unchanged
    // (default 4). Uses plain Node Buffer reads — no external deps.
    'POST /compare-thumbs': async (req, res) => {
      try {
        const body = await readBody(req);
        const a = body && body.a, b = body && body.b;
        if (!a || !b) return sendErr(res, 'missing a and b paths', 400);
        const absA = path.resolve(a);
        const absB = path.resolve(b);
        if (!absA.startsWith(rootDir) || !absB.startsWith(rootDir)) {
          return sendErr(res, 'paths must be inside project root', 400);
        }
        if (!fs.existsSync(absA) || !fs.existsSync(absB)) {
          return sendErr(res, 'one or both files missing', 404);
        }
        const threshold = Math.max(0, parseInt(body.threshold || '4', 10));
        // Decode via Electron's nativeImage (bundled, no deps).
        const { nativeImage } = require('electron');
        const imgA = nativeImage.createFromPath(absA);
        const imgB = nativeImage.createFromPath(absB);
        const sizeA = imgA.getSize(), sizeB = imgB.getSize();
        if (sizeA.width !== sizeB.width || sizeA.height !== sizeB.height) {
          return sendOk(res, {
            comparable: false,
            widthA: sizeA.width, heightA: sizeA.height,
            widthB: sizeB.width, heightB: sizeB.height,
          });
        }
        const bufA = imgA.toBitmap();   // BGRA, same layout both sides
        const bufB = imgB.toBitmap();
        const pixelCount = sizeA.width * sizeA.height;
        let diff = 0;
        for (let i = 0; i < bufA.length; i += 4) {
          const db = Math.abs(bufA[i]   - bufB[i]);
          const dg = Math.abs(bufA[i+1] - bufB[i+1]);
          const dr = Math.abs(bufA[i+2] - bufB[i+2]);
          if (db > threshold || dg > threshold || dr > threshold) diff++;
        }
        sendOk(res, {
          comparable: true,
          widthA: sizeA.width, heightA: sizeA.height,
          widthB: sizeB.width, heightB: sizeB.height,
          pixelCount, diffPixels: diff,
          diffRatio: diff / pixelCount,
          threshold,
        });
      } catch (e) { sendErr(res, e); }
    },

    // Log registry — short name -> absolute path.
    // Extend here if you add new log streams; the endpoints below accept
    // any registered name via ?file=<name>.
    ...(function() {
      const logsDir = path.join(rootDir, 'logs');
      const REGISTRY = {
        fabmesh:  LOG_FILE,                            // main process log
        renderer: path.join(logsDir, 'renderer.log'),  // renderer console mirror
        error:    LAST_ERROR,                          // latest error dump
        agent:    path.join(rootDir, 'AGENT_LOG.md'),  // claude's durable notes
      };
      function resolveLog(name) {
        const f = REGISTRY[name || 'fabmesh'];
        if (!f) throw new Error('unknown log file: ' + name);
        return f;
      }

      return {
        // GET /logs?file=fabmesh&lines=200   (file optional, default fabmesh)
        // Back-compat: with no file param returns { fabmesh_log, last_error }.
        'GET /logs': async (req, res, url) => {
          try {
            const lines = parseInt(url.searchParams.get('lines') || '200', 10);
            const file = url.searchParams.get('file');
            if (!file) {
              // Legacy shape
              return sendOk(res, {
                fabmesh_log: tailFile(LOG_FILE, lines),
                last_error:  tailFile(LAST_ERROR, lines),
              });
            }
            const target = resolveLog(file);
            sendOk(res, { file, path: target, content: tailFile(target, lines) });
          } catch (e) { sendErr(res, e); }
        },

        // GET /logs/list — registered log names + current sizes.
        'GET /logs/list': async (req, res) => {
          const out = {};
          for (const [name, p] of Object.entries(REGISTRY)) {
            try {
              const st = fs.statSync(p);
              out[name] = { path: p, sizeBytes: st.size, modified: st.mtime };
            } catch (_) {
              out[name] = { path: p, sizeBytes: 0, modified: null, missing: true };
            }
          }
          sendOk(res, out);
        },

        // POST /logs/clear {file} — truncate to empty.
        'POST /logs/clear': async (req, res) => {
          try {
            const body = await readBody(req);
            const target = resolveLog(body.file);
            fs.writeFileSync(target, '');
            sendOk(res, { file: body.file || 'fabmesh', cleared: target });
          } catch (e) { sendErr(res, e); }
        },

        // POST /logs/append {file, line}  — append a single line with LF.
        //   {file, content} — append arbitrary content verbatim.
        'POST /logs/append': async (req, res) => {
          try {
            const body = await readBody(req);
            const target = resolveLog(body.file);
            const text = body.content != null
              ? String(body.content)
              : (body.line != null ? String(body.line) + '\n' : '');
            if (!text) return sendErr(res, 'missing line or content', 400);
            fs.appendFileSync(target, text);
            sendOk(res, { file: body.file || 'fabmesh', appended: text.length });
          } catch (e) { sendErr(res, e); }
        },

        // POST /logs/rotate {file}  — move current log to <name>.<ts>.log
        // and start a fresh empty file.
        'POST /logs/rotate': async (req, res) => {
          try {
            const body = await readBody(req);
            const target = resolveLog(body.file);
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const archived = target + '.' + ts;
            if (fs.existsSync(target)) {
              fs.renameSync(target, archived);
            }
            fs.writeFileSync(target, '');
            sendOk(res, { file: body.file || 'fabmesh', archived });
          } catch (e) { sendErr(res, e); }
        },

        // GET /logs/stream?file=fabmesh — Server-Sent Events of new lines.
        // Clients get one `data: <line>\n\n` per appended line until they
        // disconnect. Useful for live-tailing during a batch run.
        'GET /logs/stream': async (req, res, url) => {
          try {
            const file = url.searchParams.get('file') || 'fabmesh';
            const target = resolveLog(file);
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'Access-Control-Allow-Origin': '*',
            });
            res.write(': fabmesh log stream started\n\n');

            let pos = 0;
            try { pos = fs.statSync(target).size; } catch (_) {}
            let closed = false;
            const interval = setInterval(() => {
              if (closed) return;
              try {
                const st = fs.statSync(target);
                if (st.size < pos) { pos = 0; }       // log was rotated
                if (st.size === pos) return;
                const fd = fs.openSync(target, 'r');
                const buf = Buffer.alloc(st.size - pos);
                fs.readSync(fd, buf, 0, buf.length, pos);
                fs.closeSync(fd);
                pos = st.size;
                const text = buf.toString('utf8');
                for (const line of text.split(/\r?\n/)) {
                  if (line) res.write('data: ' + line.replace(/\n/g, '\\n') + '\n\n');
                }
              } catch (_) { /* ignore transient read errors */ }
            }, 500);

            req.on('close', () => { closed = true; clearInterval(interval); });
          } catch (e) { sendErr(res, e); }
        },
      };
    })(),

    'GET /console': async (req, res, url) => {
      const lines = parseInt(url.searchParams.get('lines') || '500', 10);
      sendOk(res, _consoleBuf.slice(-lines));
    },

    'POST /click': async (req, res) => {
      const body = await readBody(req);
      if (!body.selector) return sendErr(res, 'missing selector', 400);
      const r = await rendererCall(mainWindow, 'click', { selector: body.selector });
      if (!r.ok) return sendErr(res, r.error);
      sendOk(res, r.data);
    },

    'POST /eval': async (req, res) => {
      const body = await readBody(req);
      if (!body.code) return sendErr(res, 'missing code', 400);
      try {
        // Use Electron's executeJavaScript which runs in isolated world.
        const result = await mainWindow.webContents.executeJavaScript(
          '(async()=>{ try { return { ok:true, data: await (async()=>{' + body.code + '})() }; } catch(e){ return { ok:false, error: e && e.message || String(e) }; } })()',
          true
        );
        if (result && result.ok === false) return sendErr(res, result.error);
        sendOk(res, result && result.data);
      } catch (e) { sendErr(res, e); }
    },

    // Generic IPC dispatch — calls any method on window.meshyAPI with
    // the given args. Covers all 80+ preload handlers without needing a
    // dedicated endpoint per action.
    // Body: { method: "generateImages", args: [ {...} ] }  OR
    //       { method: "generateImages", arg:  {...}      }
    'POST /ipc': async (req, res) => {
      const body = await readBody(req);
      const method = body && body.method;
      if (!method || typeof method !== 'string') {
        return sendErr(res, 'missing method (e.g. "generateImages")', 400);
      }
      // Never allow reaching into non-exposed properties or prototype.
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(method)) {
        return sendErr(res, 'invalid method name', 400);
      }
      const args = Array.isArray(body.args)
        ? body.args
        : (body.arg !== undefined ? [body.arg] : []);
      try {
        const script = `(async () => {
          try {
            const api = window.meshyAPI;
            if (!api) return { ok:false, error:'meshyAPI not exposed yet' };
            const fn = api[${JSON.stringify(method)}];
            if (typeof fn !== 'function') {
              return { ok:false, error:'meshyAPI.${method} is not a function' };
            }
            const out = await fn(...${JSON.stringify(args)});
            return { ok:true, data: out };
          } catch (e) {
            return { ok:false, error: (e && e.message) || String(e) };
          }
        })()`;
        const result = await mainWindow.webContents.executeJavaScript(script, true);
        if (result && result.ok === false) return sendErr(res, result.error);
        sendOk(res, result && result.data);
      } catch (e) { sendErr(res, e); }
    },

    // Introspection — list every method exposed on window.meshyAPI.
    'GET /ipc/methods': async (req, res) => {
      try {
        const result = await mainWindow.webContents.executeJavaScript(
          '(() => ({ ok:true, data: Object.keys(window.meshyAPI || {}).sort() }))()',
          true
        );
        sendOk(res, result && result.data);
      } catch (e) { sendErr(res, e); }
    },

    'POST /set': async (req, res) => {
      const body = await readBody(req);
      if (!body.selector) return sendErr(res, 'missing selector', 400);
      const r = await rendererCall(mainWindow, 'set', { selector: body.selector, value: body.value });
      if (!r.ok) return sendErr(res, r.error);
      sendOk(res, r.data);
    },

    'POST /select-project': async (req, res) => {
      const body = await readBody(req);
      if (!body.name) return sendErr(res, 'missing name', 400);
      const r = await rendererCall(mainWindow, 'select-project', { name: body.name });
      if (!r.ok) return sendErr(res, r.error);
      sendOk(res, r.data);
    },

    'POST /generate-image': async (req, res) => {
      const body = await readBody(req);
      const r = await rendererCall(mainWindow, 'generate-image', body, 60000);
      if (!r.ok) return sendErr(res, r.error);
      sendOk(res, r.data);
    },

    'POST /generate-3d': async (req, res) => {
      const body = await readBody(req);
      const r = await rendererCall(mainWindow, 'generate-3d', body, 60000);
      if (!r.ok) return sendErr(res, r.error);
      sendOk(res, r.data);
    },

    'POST /auto-rig': async (req, res) => {
      const body = await readBody(req);
      const r = await rendererCall(mainWindow, 'auto-rig', body, 60000);
      if (!r.ok) return sendErr(res, r.error);
      sendOk(res, r.data);
    },

    // ============================================================
    // CALIBRATION endpoints — full pipeline + per-stage scoring.
    // Lets scripts (Claude Code, CI, batch sweeps) run calibration
    // without the UI. Uses the same Python script as the Settings UI.
    // ============================================================
    // /calib/run and /calib/run-legacy removed in 2026-05-18 legal cleanup
    // — their backing scripts (_calib_tiered.py, _calib_diagnose.py) never
    // existed in the repo. Use /calib/run-v3 instead (calls
    // run_calibration_v3.py which is present).
    'POST /calib/run': async (_req, res) => {
      sendErr(res, 'endpoint removed; use POST /calib/run-v3', 410);
    },

    'GET /calib/list-reports': async (req, res) => {
      try {
        const reportsDir = path.join(__dirname, '..', '..', 'images', '_calibration', 'reports');
        if (!fs.existsSync(reportsDir)) return sendOk(res, { reports: [] });
        const out = [];
        for (const name of fs.readdirSync(reportsDir)) {
          if (name.startsWith('sweep_')) continue;
          const dir = path.join(reportsDir, name);
          const sp = path.join(dir, 'score.json');
          if (!fs.existsSync(sp)) continue;
          try {
            const s = JSON.parse(fs.readFileSync(sp, 'utf-8'));
            out.push({
              name, dir, mtime: fs.statSync(dir).mtimeMs,
              score: s.score, total: s.total,
              similarity: s.avg_similarity, timestamp: s.timestamp,
              mesh: s.mesh, results: s.results,
            });
          } catch (_) {}
        }
        out.sort((a, b) => b.mtime - a.mtime);
        sendOk(res, { reports: out });
      } catch (e) { sendErr(res, e.message, 500); }
    },

    'GET /calib/last-report': async (req, res) => {
      try {
        const reportsDir = path.join(__dirname, '..', '..', 'images', '_calibration', 'reports');
        if (!fs.existsSync(reportsDir)) return sendErr(res, 'no reports dir', 404);
        const entries = fs.readdirSync(reportsDir)
          .filter(n => !n.startsWith('sweep_'))
          .map(n => ({ n, t: fs.statSync(path.join(reportsDir, n)).mtimeMs }))
          .sort((a, b) => b.t - a.t);
        if (!entries.length) return sendErr(res, 'no reports', 404);
        const dir = path.join(reportsDir, entries[0].n);
        const score = JSON.parse(fs.readFileSync(path.join(dir, 'score.json'), 'utf-8'));
        sendOk(res, {
          name: entries[0].n, dir, score,
          html: path.join(dir, 'index.html'),
        });
      } catch (e) { sendErr(res, e.message, 500); }
    },

    'GET /calib/report': async (req, res, url) => {
      const name = url.searchParams.get('name');
      if (!name) return sendErr(res, 'missing name', 400);
      try {
        const reportsDir = path.join(__dirname, '..', '..', 'images', '_calibration', 'reports');
        const dir = path.join(reportsDir, name);
        if (!fs.existsSync(dir)) return sendErr(res, 'not found', 404);
        const result = { name, dir };
        for (const fn of ['score.json', 'stage1_sf3d.json', 'stage2_mv.json',
                          'stage3_projected.json', 'verdict.json']) {
          const p = path.join(dir, fn);
          if (fs.existsSync(p)) {
            try { result[fn.replace('.json', '')] = JSON.parse(fs.readFileSync(p, 'utf-8')); }
            catch (_) {}
          }
        }
        sendOk(res, result);
      } catch (e) { sendErr(res, e.message, 500); }
    },

    'GET /calib/log': async (req, res, url) => {
      const lines = parseInt(url.searchParams.get('lines') || '500', 10);
      // Filter the main fabmesh.log by [calib] source.
      if (!fs.existsSync(LOG_FILE)) return sendOk(res, { log: '', path: LOG_FILE });
      const content = fs.readFileSync(LOG_FILE, 'utf-8');
      const calibLines = content.split(/\r?\n/).filter(l => l.includes('[calib]'));
      const tail = calibLines.slice(-lines).join('\n');
      sendOk(res, { log: tail, path: LOG_FILE, total_bytes: content.length });
    },

    'POST /calib/build-rubiks': async (req, res) => {
      // Was : rebuild the Rubik's calibration reference. Backing script
      // (_calib_build_rubiks.py) was never present in the repo (see the
      // similar removal of _calib_tiered/_calib_diagnose in the 2026-05-18
      // legal cleanup). Endpoint left as 410 Gone for any external caller
      // that still depends on it.
      sendErr(res, 'calib/build-rubiks: removed (backing script missing). '
        + 'Use /calib/run-v3 for the active calibration flow.', 410);
    },

    'GET /jobs': async (req, res) => {
      const r = await rendererCall(mainWindow, 'jobs', {});
      if (!r.ok) return sendErr(res, r.error);
      sendOk(res, r.data);
    },

    'GET /wait-job': async (req, res, url) => {
      const id = url.searchParams.get('id');
      const timeoutSec = parseInt(url.searchParams.get('timeout') || '300', 10);
      if (!id) return sendErr(res, 'missing id', 400);
      const deadline = Date.now() + timeoutSec * 1000;
      while (Date.now() < deadline) {
        const r = await rendererCall(mainWindow, 'get-job', { id });
        if (r.ok && r.data) {
          const st = r.data.status;
          if (st === 'completed' || st === 'failed' || st === 'cancelled') {
            return sendOk(res, r.data);
          }
        }
        // Interrupt fast if an error popup appeared: the renderer often
        // shows customError() before the job status is flipped, and
        // waiting out the timeout would mean minutes of wasted time.
        // We detect any visible modal whose title matches /fail|error|failed/i.
        const pr = await rendererCall(mainWindow, 'popups', {});
        if (pr.ok && Array.isArray(pr.data)) {
          const errPopup = pr.data.find(p => {
            const title = (p.title || '').toLowerCase();
            return /fail|error|erreur|\u00e9chec/.test(title);
          });
          if (errPopup) {
            return sendOk(res, {
              job: r.ok ? r.data : null,
              interrupted: true,
              errorPopup: {
                id: errPopup.id,
                title: errPopup.title,
                text: errPopup.text,
              },
            });
          }
        }
        await new Promise(rv => setTimeout(rv, 500));
      }
      sendErr(res, 'timeout');
    },

    'GET /popups': async (req, res) => {
      const r = await rendererCall(mainWindow, 'popups', {});
      if (!r.ok) return sendErr(res, r.error);
      sendOk(res, r.data);
    },

    'POST /dismiss-popup': async (req, res) => {
      const body = await readBody(req);
      const r = await rendererCall(mainWindow, 'dismiss-popup', body);
      if (!r.ok) return sendErr(res, r.error);
      sendOk(res, r.data);
    },

    'GET /last-error': async (req, res) => {
      try {
        const content = fs.existsSync(LAST_ERROR) ? fs.readFileSync(LAST_ERROR, 'utf8') : '';
        sendOk(res, { content });
      } catch (e) { sendErr(res, e); }
    },

    'GET /devtools-open': async (req, res) => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.openDevTools({ mode: 'detach' });
        }
        sendOk(res, { opened: true });
      } catch (e) { sendErr(res, e); }
    }
  };

  const server = http.createServer(async (req, res) => {
    let _statusForLog = 0;
    // Wrap writeHead so we can capture the final status without
    // touching every handler.
    const _origWriteHead = res.writeHead.bind(res);
    res.writeHead = function (code, ...rest) {
      _statusForLog = code;
      return _origWriteHead(code, ...rest);
    };
    try {
      const url = new URL(req.url, 'http://' + HOST + ':' + PORT);
      const key = req.method + ' ' + url.pathname;
      // Auth check on EVERY endpoint (no exceptions)
      if (!_checkAuth(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized — missing or invalid Authorization: Bearer <token> header' }));
        _recordRequest(req, 401);
        return;
      }
      const handler = routes[key];
      if (!handler) {
        sendErr(res, 'not found: ' + key, 404);
        _recordRequest(req, 404);
        return;
      }
      await handler(req, res, url);
      _recordRequest(req, _statusForLog || 200);
    } catch (e) {
      try { sendErr(res, e); } catch (_) {}
      _recordRequest(req, _statusForLog || 500);
    }
  });

  server.on('error', (err) => {
    console.error('[test_api] server error:', err.message);
  });

  server.listen(PORT, HOST, () => {
    console.log('[control_api] listening on http://' + HOST + ':' + PORT);
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.once('did-finish-load', () => {
          // Nothing to do - renderer installs its own handler.
        });
      }
    } catch (e) { /* ignore */ }
  });

  return server;
}

module.exports = { startControlApi, startTestApi: startControlApi };
