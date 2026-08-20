// console-capture.js — intercepts console.log/warn/error/info into an
// in-memory ring buffer.
//
// The buffer is ALWAYS kept (it costs nothing and never leaves the tab).
// Sending it to the server is a different matter: it is OFF by default
// and only happens after the user turns "Diagnostic logs" on in Settings.
//
// WHY THE OPT-IN (2026-08-20): this file used to POST the whole console
// to /api/client-log at every Generate — prompts, project names, job ids,
// URL and User-Agent included — for every user, with nothing in the
// privacy policy saying so and nothing ever deleting it. That is personal
// data collected without a legal basis (GDPR art. 6) and without notice
// (art. 13). Convenient for solo debugging; not shippable.
//
// What is sent now, when and only when the user has enabled it:
//   - the console ring buffer, with obvious secrets redacted (see _redact)
//   - the page URL and User-Agent
//   - the current project name and job id
// The server keeps it for 30 days (DIAG_LOG_RETENTION_DAYS in worker.ts)
// and the privacy policy says so. Keep the three in sync.

(function () {
  if (window.__consoleCaptureInstalled) return;
  window.__consoleCaptureInstalled = true;

  const MAX_LINES = 2000;
  const OPTIN_KEY = 'fabmesh.diag.optin';
  const buffer = [];
  const orig = {
    log:   console.log.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
    info:  console.info.bind(console),
    debug: console.debug ? console.debug.bind(console) : console.log.bind(console),
  };

  function isEnabled() {
    try { return localStorage.getItem(OPTIN_KEY) === '1'; }
    catch (_) { return false; }   // storage blocked → stay off
  }

  function setEnabled(on) {
    try { localStorage.setItem(OPTIN_KEY, on ? '1' : '0'); } catch (_) {}
    orig.log('[console-capture] diagnostics', on ? 'ENABLED by user' : 'disabled');
    return isEnabled();
  }

  // Redaction — applied to every line just before it leaves the browser,
  // never to the local buffer (so the developer console stays readable).
  // These are the shapes that actually turn up in this app's logs: Supabase
  // JWTs, Stripe keys, Authorization headers, our own signed-R2 signatures,
  // and e-mail addresses.
  const REDACTIONS = [
    [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[jwt-redacted]'],
    [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g,                 '[stripe-key-redacted]'],
    [/\bwhsec_[A-Za-z0-9]{8,}/g,                                       '[stripe-secret-redacted]'],
    [/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,                          'Bearer [redacted]'],
    [/([?&](?:sig|token|access_token|refresh_token|api[_-]?key)=)[^&\s"']+/gi, '$1[redacted]'],
    [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,            '[email-redacted]'],
  ];

  function _redact(line) {
    let s = String(line);
    for (const [re, to] of REDACTIONS) s = s.replace(re, to);
    return s;
  }

  function _fmt(args) {
    try {
      return Array.from(args).map(a => {
        if (a == null) return String(a);
        if (typeof a === 'string') return a;
        if (typeof a === 'number' || typeof a === 'boolean') return String(a);
        if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack || ''}`;
        try { return JSON.stringify(a); }
        catch { return String(a); }
      }).join(' ');
    } catch { return '[unfmt]'; }
  }

  function _push(level, args) {
    const ts = new Date().toISOString();
    buffer.push(`[${ts}] [${level}] ${_fmt(args)}`);
    if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
  }

  ['log', 'warn', 'error', 'info', 'debug'].forEach(level => {
    console[level] = function () {
      _push(level, arguments);
      try { orig[level].apply(null, arguments); } catch (_) {}
    };
  });

  // Capture uncaught errors and unhandled promise rejections too.
  window.addEventListener('error', (e) => {
    _push('uncaught', [`${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`, e.error?.stack || '']);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    _push('unhandledrejection', [r instanceof Error ? `${r.name}: ${r.message}\n${r.stack}` : _fmt([r])]);
  });

  function _payload(meta) {
    return {
      kind: meta.kind || 'unknown',
      status: meta.status || 'unknown',
      job_id: meta.job_id || null,
      project: meta.project || (window.state?.currentProject?.name || null),
      ua: navigator.userAgent,
      url: _redact(location.href),
      lines: buffer.map(_redact),
    };
  }

  // Flush — POST the current buffer to /api/client-log. No-op unless the
  // user opted in; the caller doesn't have to check.
  async function flush(meta = {}) {
    if (!buffer.length) return { ok: true, skipped: true, reason: 'empty' };
    if (!isEnabled()) return { ok: true, skipped: true, reason: 'diagnostics off' };
    const payload = _payload(meta);
    try {
      const r = await fetch('/api/client-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'include',
        keepalive: true,
      });
      if (!r.ok) {
        orig.warn('[console-capture] flush failed:', r.status);
        return { ok: false, status: r.status };
      }
      const j = await r.json().catch(() => ({}));
      orig.log('[console-capture] flushed', payload.lines.length, 'lines →', j?.path || '(no path)');
      return { ok: true, path: j?.path };
    } catch (e) {
      orig.warn('[console-capture] flush threw:', e?.message || e);
      return { ok: false, error: String(e) };
    }
  }

  // Saves the buffer to a local file — the way to hand over a log without
  // enabling any upload at all.
  function download() {
    const text = buffer.map(_redact).join('\n') + '\n';
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `myfabmesh-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // Expose for manual + auto callers.
  window.__consoleCapture = {
    flush,
    download,
    isEnabled,
    setEnabled,
    buffer: () => buffer.slice(),
    clear: () => { buffer.length = 0; },
    size: () => buffer.length,
  };

  // Last buffer on the way out — same opt-in gate.
  window.addEventListener('beforeunload', () => {
    if (!buffer.length || !isEnabled()) return;
    try {
      const blob = new Blob([JSON.stringify(_payload({ kind: 'beforeunload', status: 'flush' }))],
                            { type: 'application/json' });
      navigator.sendBeacon('/api/client-log', blob);
    } catch (_) {}
  });

  orig.log('[console-capture] installed — buffer max', MAX_LINES,
           'lines; upload', isEnabled() ? 'ENABLED (user opt-in)' : 'off');
})();
