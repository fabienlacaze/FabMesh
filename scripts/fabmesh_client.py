"""
FabMesh Control API — Python client
===================================

Pilot a running FabMesh Electron app from any Python process.

Usage:
    from fabmesh_client import FabMesh

    fm = FabMesh()                            # auto-reads ~/.fabmesh/test_api_token.txt

    # Generic IPC (covers 80+ preload.js methods)
    projects = fm.ipc("listProjects")
    fm.ipc("removeBackground", "C:/.../images/man/ref_0.png")

    # Introspect what's available
    print(fm.ipc_methods())

    # High-level helpers
    fm.generate_image(prompt="an orc warrior", count=1, steps=30)
    fm.wait_job(fm.last_job_id, timeout=300)
    fm.save_screenshot("out.png")

    # Logs
    print(fm.logs(file="fabmesh", lines=50))
    fm.logs_clear("renderer")

    # Visual diff of two versions
    d = fm.compare_thumbs(
        "images/man/ref_0.png",
        "images/man/ref_1.png"
    )
    print(f"diff: {d['diffRatio']*100:.1f}%")

Authentication:
    Every request must carry the Bearer token written by the Electron
    main process at startup. By default the client reads it from
    ~/.fabmesh/test_api_token.txt — override via token="..." or the
    FABMESH_TOKEN env var.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError


class FabMeshError(RuntimeError):
    pass


class FabMesh:
    def __init__(self, host: str = "127.0.0.1", port: int = 7331,
                 token: str | None = None, timeout: float = 60.0):
        self.base = f"http://{host}:{port}"
        self.timeout = timeout
        self.token = token or os.environ.get("FABMESH_TOKEN") or self._read_token()
        self.last_job_id: str | None = None
        if not self.token:
            raise FabMeshError(
                "no auth token — set FABMESH_TOKEN, pass token=..., or ensure "
                "~/.fabmesh/test_api_token.txt exists (written by FabMesh at startup)"
            )

    # ---- low-level ---------------------------------------------------

    @staticmethod
    def _read_token() -> str | None:
        for p in [
            Path.home() / ".fabmesh" / "test_api_token.txt",
            Path(__file__).resolve().parent.parent / ".test_api_token",
        ]:
            try:
                if p.exists():
                    return p.read_text(encoding="utf-8").strip()
            except Exception:
                continue
        return None

    def _req(self, method: str, path: str, body: Any = None,
             params: dict | None = None, raw: bool = False) -> Any:
        url = f"{self.base}{path}"
        if params:
            url += "?" + urlencode(params)
        data = None
        headers = {"Authorization": f"Bearer {self.token}"}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = Request(url, method=method, data=data, headers=headers)
        try:
            with urlopen(req, timeout=self.timeout) as resp:
                payload = resp.read()
        except HTTPError as e:
            payload = e.read()
            try:
                obj = json.loads(payload)
                raise FabMeshError(obj.get("error") or str(e))
            except (ValueError, TypeError):
                raise FabMeshError(f"HTTP {e.code}: {payload[:300]!r}")
        if raw:
            return payload
        obj = json.loads(payload)
        if not obj.get("ok"):
            raise FabMeshError(obj.get("error") or "unknown error")
        return obj.get("data")

    # ---- introspection ----------------------------------------------

    def ping(self) -> dict:
        return self._req("GET", "/")

    def state(self) -> dict:
        return self._req("GET", "/state")

    def ipc_methods(self) -> list[str]:
        return self._req("GET", "/ipc/methods")

    # ---- generic IPC -------------------------------------------------

    def ipc(self, method: str, *args) -> Any:
        """Invoke window.meshyAPI[method](*args). Covers all preload handlers."""
        return self._req("POST", "/ipc", body={"method": method, "args": list(args)})

    # ---- high-level shortcuts ---------------------------------------

    def generate_image(self, prompt: str, engine: str = "local-realvis",
                       count: int = 1, steps: int = 30) -> dict:
        r = self._req("POST", "/generate-image", body={
            "prompt": prompt, "engine": engine, "count": count, "steps": steps
        })
        self.last_job_id = r.get("jobId") if isinstance(r, dict) else None
        return r

    def generate_3d(self, image_index: int = 0, engine: str = "sf3d") -> dict:
        r = self._req("POST", "/generate-3d", body={
            "imageIndex": image_index, "engine": engine
        })
        self.last_job_id = r.get("jobId") if isinstance(r, dict) else None
        return r

    def auto_rig(self) -> dict:
        return self._req("POST", "/auto-rig", body={})

    def select_project(self, name: str) -> dict:
        return self._req("POST", "/select-project", body={"name": name})

    # ---- jobs --------------------------------------------------------

    def jobs(self) -> list:
        return self._req("GET", "/jobs")

    def wait_job(self, job_id: str | None = None, timeout: int = 300) -> dict:
        jid = job_id or self.last_job_id
        if not jid:
            raise FabMeshError("no job id — run a generate_* method first or pass one")
        return self._req("GET", "/wait-job", params={"id": jid, "timeout": timeout})

    # ---- popups ------------------------------------------------------

    def popups(self) -> list:
        return self._req("GET", "/popups")

    def dismiss_popup(self, popup_id: str | None = None) -> dict:
        return self._req("POST", "/dismiss-popup", body={"id": popup_id} if popup_id else {})

    # ---- logs --------------------------------------------------------

    def logs(self, file: str = "fabmesh", lines: int = 200) -> str:
        d = self._req("GET", "/logs", params={"file": file, "lines": lines})
        return d.get("content", "") if isinstance(d, dict) else ""

    def logs_list(self) -> dict:
        return self._req("GET", "/logs/list")

    def logs_clear(self, file: str = "fabmesh") -> dict:
        return self._req("POST", "/logs/clear", body={"file": file})

    def logs_append(self, line: str, file: str = "fabmesh") -> dict:
        return self._req("POST", "/logs/append", body={"file": file, "line": line})

    def logs_rotate(self, file: str = "fabmesh") -> dict:
        return self._req("POST", "/logs/rotate", body={"file": file})

    def logs_stream(self, file: str = "fabmesh") -> Iterable[str]:
        """Yields each new log line in real time (Server-Sent Events)."""
        url = f"{self.base}/logs/stream?file={file}"
        req = Request(url, headers={
            "Authorization": f"Bearer {self.token}",
            "Accept": "text/event-stream",
        })
        with urlopen(req, timeout=None) as resp:
            for raw in resp:
                line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                if line.startswith("data: "):
                    yield line[6:].replace("\\n", "\n")

    # ---- screenshots + visual diff -----------------------------------

    def save_screenshot(self, out_path: str) -> str:
        png = self._req("GET", "/screenshot", raw=True)
        Path(out_path).write_bytes(png)
        return out_path

    def save_file(self, remote_path: str, out_path: str) -> str:
        data = self._req("GET", "/screenshot-file",
                         params={"path": remote_path}, raw=True)
        Path(out_path).write_bytes(data)
        return out_path

    def thumbs(self, project: str, kind: str = "image") -> list[dict]:
        d = self._req("GET", "/thumbs", params={"project": project, "kind": kind})
        return d.get("items", []) if isinstance(d, dict) else []

    def compare_thumbs(self, a: str, b: str, threshold: int = 4) -> dict:
        return self._req("POST", "/compare-thumbs",
                         body={"a": a, "b": b, "threshold": threshold})

    # ---- eval / click / set (UI automation) -------------------------

    def eval(self, code: str) -> Any:
        return self._req("POST", "/eval", body={"code": code})

    def click(self, selector: str) -> dict:
        return self._req("POST", "/click", body={"selector": selector})

    def set_value(self, selector: str, value: Any) -> dict:
        return self._req("POST", "/set", body={"selector": selector, "value": value})


if __name__ == "__main__":
    import sys
    fm = FabMesh()
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print("Usage:")
        print("  python fabmesh_client.py ping")
        print("  python fabmesh_client.py methods")
        print("  python fabmesh_client.py ipc <method> [json-arg ...]")
        print("  python fabmesh_client.py logs [file] [lines]")
        print("  python fabmesh_client.py screenshot <out.png>")
        print("  python fabmesh_client.py tail [file]")
        sys.exit(0)
    cmd = sys.argv[1]
    if cmd == "ping":
        print(json.dumps(fm.ping(), indent=2))
    elif cmd == "methods":
        for m in fm.ipc_methods():
            print(m)
    elif cmd == "ipc":
        method = sys.argv[2]
        args = [json.loads(a) for a in sys.argv[3:]]
        print(json.dumps(fm.ipc(method, *args), indent=2, default=str))
    elif cmd == "logs":
        file = sys.argv[2] if len(sys.argv) > 2 else "fabmesh"
        lines = int(sys.argv[3]) if len(sys.argv) > 3 else 200
        print(fm.logs(file, lines))
    elif cmd == "screenshot":
        out = sys.argv[2] if len(sys.argv) > 2 else "fabmesh_screenshot.png"
        print(fm.save_screenshot(out))
    elif cmd == "tail":
        file = sys.argv[2] if len(sys.argv) > 2 else "fabmesh"
        print(f"[tailing {file} — Ctrl+C to stop]")
        try:
            for line in fm.logs_stream(file):
                print(line)
        except KeyboardInterrupt:
            pass
    else:
        print(f"unknown command: {cmd}", file=sys.stderr)
        sys.exit(2)
