// console-capture.js — intercepts console.log/warn/error/info into a
// ring buffer, then auto-flushes the buffer to R2 (via /api/client-log)
// at well-defined moments (every Generate* operation, success or error).
//
// Why: lets me read user-side console logs without copy-paste.
// Each gen produces ~30 KB; R2 free tier is 10 GB → ~330k gens before
// any concern.

(function () {
  if (window.__consoleCaptureInstalled) return;
  window.__consoleCaptureInstalled = true;

  const MAX_LINES = 2000;
  const buffer = [];
  const orig = {
    log:   console.log.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
    info:  console.info.bind(console),
    debug: console.debug ? console.debug.bind(console) : console.log.bind(console),
  };

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

  // Flush — POST the current buffer to /api/client-log and clear the
  // marker so the next flush starts fresh. The full ring buffer is
  // included so we always see context BEFORE the trigger event.
  async function flush(meta = {}) {
    if (!buffer.length) return { ok: true, skipped: true };
    const payload = {
      kind: meta.kind || 'unknown',
      status: meta.status || 'unknown',
      job_id: meta.job_id || null,
      project: meta.project || (window.state?.currentProject?.name || null),
      ua: navigator.userAgent,
      url: location.href,
      lines: buffer.slice(),  // copy so subsequent pushes don't mutate the in-flight payload
    };
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

  // Expose for manual + auto callers.
  window.__consoleCapture = {
    flush,
    buffer: () => buffer.slice(),
    clear: () => { buffer.length = 0; },
    size: () => buffer.length,
  };

  // Also flush on page unload so the last buffer survives a Ctrl+W.
  // navigator.sendBeacon doesn't wait for a response — use it as a
  // last-ditch when fetch keepalive isn't reliable.
  window.addEventListener('beforeunload', () => {
    if (!buffer.length) return;
    try {
      const blob = new Blob([JSON.stringify({
        kind: 'beforeunload',
        status: 'flush',
        project: window.state?.currentProject?.name || null,
        ua: navigator.userAgent,
        url: location.href,
        lines: buffer.slice(),
      })], { type: 'application/json' });
      navigator.sendBeacon('/api/client-log', blob);
    } catch (_) {}
  });

  orig.log('[console-capture] installed — buffer max', MAX_LINES, 'lines');
})();
