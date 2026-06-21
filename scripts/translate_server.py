#!/usr/bin/env python
"""Persistent translation server — loads Argos Translate ONCE and serves
translations over localhost HTTP, so the desktop doesn't re-import argos
(~5 s, incl. stanza/torch CPU) on every prompt. CPU-only. Lightweight
(~150 MB RAM, no GPU). main.js spawns it and kills it on quit.

  POST /translate  {"text": "...", "from": "fr"}  -> {"text": "..."}
  GET  /ping       -> {"ok": true}
  POST /shutdown   -> exits
"""
import os
import sys
import json
import threading
import time

# No GPU -> torch (pulled in by some Argos language packages via stanza) imports
# fast instead of paying the ~20 s CUDA init.
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
os.environ.setdefault("CT2_FORCE_CPU", "1")
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("FABMESH_TRANSLATE_PORT", "5557"))
_lock = threading.Lock()


def _translate(text, src):
    src = (src or "en").lower()
    if src == "en" or not text.strip():
        return text
    # Serialize argos access (ctranslate2 model is not re-entrant) — the cost we
    # avoid is the IMPORT/LOAD, which happens once on the first call.
    with _lock:
        from argostranslate import translate as _t
        try:
            out = _t.translate(text, src, "en")
            if out:
                return out
        except Exception:
            pass
        langs = _t.get_installed_languages()
        from_lang = next((l for l in langs if l.code == src), None)
        to_lang = next((l for l in langs if l.code == "en"), None)
        if from_lang and to_lang:
            return from_lang.get_translation(to_lang).translate(text) or text
    return text


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # silence per-request access logging
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/ping":
            self._send({"ok": True})
        else:
            self._send({"error": "not found"}, 404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            req = json.loads(raw or b"{}")
        except Exception:
            req = {}
        if self.path == "/shutdown":
            self._send({"ok": True})
            threading.Thread(target=lambda: (time.sleep(0.2), os._exit(0)),
                             daemon=True).start()
            return
        if self.path == "/translate":
            text = req.get("text") or ""
            try:
                self._send({"text": _translate(text, req.get("from") or "en")})
            except Exception as e:
                sys.stderr.write(f"[translate-server] error: {e}\n")
                self._send({"text": text, "error": str(e)})  # fail open
            return
        self._send({"error": "not found"}, 404)


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), _Handler)
    # main.js waits for this line before routing requests here.
    print("TRANSLATE READY", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
