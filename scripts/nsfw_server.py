#!/usr/bin/env python
"""Persistent NSFW prompt classifier — loads michellejieli/NSFW_text_classifier
ONCE and serves classifications over localhost HTTP, so the desktop doesn't
re-load the ~250 MB model (~20 s) on EVERY generation when parental control is on.
CPU-only. main.js spawns it lazily and kills it on quit.

  POST /classify  {"text": "..."}  -> {"label": "NSFW"|"SFW", "score": 0.0-1.0}
  GET  /ping       -> {"ok": true}
  POST /shutdown   -> exits
"""
import os
import sys
import json
import threading
import time

os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")           # CPU only
os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("FABMESH_NSFW_PORT", "5558"))
_lock = threading.Lock()
_state = {"pipe": None}


def _classify(text):
    if not text or not text.strip():
        return {"label": "SFW", "score": 0.0}
    # Serialize model access; the cost we avoid is the one-time LOAD.
    with _lock:
        if _state["pipe"] is None:
            from transformers import pipeline
            _state["pipe"] = pipeline(
                "text-classification",
                model="michellejieli/NSFW_text_classifier",
                device="cpu",
            )
        r = _state["pipe"](text)[0]
    return {"label": r["label"], "score": float(r["score"])}


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
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
        if self.path == "/classify":
            try:
                self._send(_classify(req.get("text") or ""))
            except Exception as e:
                sys.stderr.write(f"[nsfw-server] error: {e}\n")
                # Fail open like the legacy per-call path — the hard-floor regex
                # (in main.js) still blocks illegal content, and the OUTPUT image
                # is NSFW-checked separately.
                self._send({"label": "SFW", "score": 0.0, "error": str(e)})
            return
        self._send({"error": "not found"}, 404)


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), _Handler)
    print("NSFW READY", flush=True)   # main.js waits for this
    srv.serve_forever()


if __name__ == "__main__":
    main()
