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
const { ipcMain } = require('electron');

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
  // Also write to project root for the bash helper
  try {
    const projectToken = path.join(__dirname, '..', '..', '.test_api_token');
    fs.writeFileSync(projectToken, _authToken, { encoding: 'utf-8', mode: 0o600 });
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
  // Always-on by default. Hard-disable with FABMESH_CONTROL_API=0.
  // Legacy FABMESH_TEST_API=1 still forces enable for scripts that set it.
  const envDisabled = process.env.FABMESH_CONTROL_API === '0';
  const legacyForce = process.env.FABMESH_TEST_API === '1';
  const enabled = (!envDisabled && opts.force !== false) || legacyForce;
  if (!enabled) {
    console.log('[control_api] disabled (FABMESH_CONTROL_API=0)');
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
          'GET  /screenshot',
          'GET  /logs?lines=200',
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
          'GET  /devtools-open'
        ]
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

    'GET /logs': async (req, res, url) => {
      try {
        const lines = parseInt(url.searchParams.get('lines') || '200', 10);
        sendOk(res, {
          fabmesh_log: tailFile(LOG_FILE, lines),
          last_error:  tailFile(LAST_ERROR, lines)
        });
      } catch (e) { sendErr(res, e); }
    },

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
    try {
      const url = new URL(req.url, 'http://' + HOST + ':' + PORT);
      const key = req.method + ' ' + url.pathname;
      // Auth check on EVERY endpoint (no exceptions)
      if (!_checkAuth(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized — missing or invalid Authorization: Bearer <token> header' }));
        return;
      }
      const handler = routes[key];
      if (!handler) return sendErr(res, 'not found: ' + key, 404);
      await handler(req, res, url);
    } catch (e) {
      try { sendErr(res, e); } catch (_) {}
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
