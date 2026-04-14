# FabMesh Control API

A local HTTP control plane that lets any external process (shell scripts,
Claude Code, CI pipelines, other apps) drive a running FabMesh Electron
instance end-to-end: generate images, meshes, rigs, inspect state,
capture screenshots, tail logs in real time.

- **Host** : `127.0.0.1:7331` (local only — never expose externally)
- **Always-on** (disable with `FABMESH_CONTROL_API=0`)
- **Auth** : Bearer token written at startup to
  `~/.fabmesh/test_api_token.txt` and `<repo>/.test_api_token`

Every request must carry `Authorization: Bearer <token>` (or `?token=...`).

---

## Quick start

### Python

```python
from scripts.fabmesh_client import FabMesh
fm = FabMesh()                                     # auto-reads token

projects = fm.ipc("listProjects")
fm.ipc("removeBackground", "C:/.../images/man/ref_0.png")

fm.generate_image("an orc warrior", count=1, steps=30)
fm.wait_job(timeout=300)                           # uses last_job_id
fm.save_screenshot("out.png")
```

### curl

```bash
TOKEN=$(cat .test_api_token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7331/

# Generic IPC
curl -s -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"method":"listProjects"}' \
     http://127.0.0.1:7331/ipc | jq

# Live-tail the main log
curl -N -H "Authorization: Bearer $TOKEN" \
     "http://127.0.0.1:7331/logs/stream?file=fabmesh"
```

---

## Endpoints

### Introspection

| Method | Path | Description |
|---|---|---|
| GET | `/` | API metadata + endpoint list |
| GET | `/state` | Cached renderer state snapshot |
| GET | `/ipc/methods` | Every method on `window.meshyAPI` |

### Generic IPC dispatch

| Method | Path | Body | Description |
|---|---|---|---|
| POST | `/ipc` | `{method, args?: [...] \| arg?: x}` | Invoke any `window.meshyAPI.<method>(...args)`. Covers all 80+ preload.js handlers. |

Examples:

```bash
# listProjects has no args
-d '{"method":"listProjects"}'

# removeBackground takes one positional
-d '{"method":"removeBackground","arg":"C:/.../images/man/ref_0.png"}'

# generateImages takes an options object
-d '{"method":"generateImages","args":[{"prompt":"orc","count":2}]}'
```

### High-level workflow helpers

| Method | Path | Body | Description |
|---|---|---|---|
| POST | `/select-project` | `{name}` | Open a project in the UI |
| POST | `/generate-image` | `{prompt, engine?, count?, steps?}` | Triggers image gen, returns `{jobId}` |
| POST | `/generate-3d` | `{imageIndex?, engine?}` | Triggers mesh gen |
| POST | `/auto-rig` | `{}` | Triggers auto-rig pipeline |
| GET | `/jobs` | — | List active + recent jobs |
| GET | `/wait-job?id=&timeout=` | — | Block until a job completes (or times out). Also interrupts early if an error popup appears. |
| GET | `/popups` | — | List visible modal popups |
| POST | `/dismiss-popup` | `{id?}` | Dismiss a specific popup or all |

### UI automation

| Method | Path | Body | Description |
|---|---|---|---|
| POST | `/click` | `{selector}` | Dispatch a click on a DOM element |
| POST | `/set` | `{selector, value}` | Set form control value |
| POST | `/eval` | `{code}` | Run arbitrary JS in the renderer (async IIFE) |

### Logs (read, edit, rotate, live tail)

| Method | Path | Body / Params | Description |
|---|---|---|---|
| GET | `/logs` | `?file=&lines=200` | Tail any registered log. Omit `file` for back-compat `{fabmesh_log, last_error}`. |
| GET | `/logs/list` | — | Registered log names + sizes + mtimes |
| POST | `/logs/clear` | `{file}` | Truncate to empty |
| POST | `/logs/append` | `{file, line \| content}` | Append a line (with LF) or raw content |
| POST | `/logs/rotate` | `{file}` | Archive as `<file>.<iso-ts>` and start fresh |
| GET | `/logs/stream` | `?file=fabmesh` | **Server-Sent Events**, one event per new line. Never closes until the client disconnects. |

Registered log names: `fabmesh` (main), `renderer`, `error` (`last_error.log`),
`agent` (`AGENT_LOG.md`). Extend the registry in `src/main/control_api.js`.

### Screenshots + visual diff

| Method | Path | Body / Params | Description |
|---|---|---|---|
| GET | `/screenshot` | — | Full Electron window as PNG |
| GET | `/screenshot-file` | `?path=` | Stream any PNG/JPG/WEBP inside the project root |
| GET | `/thumbs` | `?project=&kind=image\|mesh` | List every version's on-disk file + size + mtime |
| POST | `/compare-thumbs` | `{a, b, threshold?}` | Pixel diff. Returns `{comparable, pixelCount, diffPixels, diffRatio}` |

### Log shortcuts

| Method | Path | Description |
|---|---|---|
| GET | `/console` | Last 500 renderer console entries |
| GET | `/last-error` | `last_error.log` contents |
| GET | `/devtools-open` | Open Chromium DevTools (detached) |

---

## Common workflows

### Batch generation from a list of prompts

```python
from scripts.fabmesh_client import FabMesh
fm = FabMesh()

for prompt in ["orc warrior", "medieval knight", "wizard"]:
    fm.generate_image(prompt=prompt, count=1, steps=30)
    r = fm.wait_job(timeout=180)
    if r.get("status") != "completed":
        print(f"[{prompt}] failed: {r}")
        continue
    fm.generate_3d(image_index=0, engine="sf3d")
    fm.wait_job(timeout=300)
    fm.save_screenshot(f"out_{prompt.replace(' ', '_')}.png")
```

### Live analysis during a run

```python
fm = FabMesh()
for line in fm.logs_stream("fabmesh"):
    if "ERROR" in line or "MULTIVIEW_PROGRESS" in line:
        print(line)
```

### Visual diff between two image versions

```python
items = fm.thumbs("man", "image")      # [{name, path, sizeBytes, modified}, ...]
v0, v1 = items[0]["path"], items[1]["path"]
d = fm.compare_thumbs(v0, v1)
print(f"diff: {d['diffRatio']*100:.2f}% ({d['diffPixels']}/{d['pixelCount']} pixels)")
```

---

## Security

- Bound to `127.0.0.1` — not reachable from other hosts.
- Bearer token is 32 bytes hex, regenerated at every FabMesh startup.
- Token file has `0o600` permissions when supported by the OS.
- `POST /eval` lets any token holder run arbitrary JS in the renderer —
  treat the token like a password.
- `/screenshot-file` and `/compare-thumbs` block any path outside the
  project root.

## CLI

`scripts/fabmesh_client.py` doubles as a CLI:

```bash
python scripts/fabmesh_client.py ping
python scripts/fabmesh_client.py methods
python scripts/fabmesh_client.py ipc listProjects
python scripts/fabmesh_client.py ipc removeBackground '"C:/.../ref_0.png"'
python scripts/fabmesh_client.py logs fabmesh 100
python scripts/fabmesh_client.py tail renderer
python scripts/fabmesh_client.py screenshot out.png
```
