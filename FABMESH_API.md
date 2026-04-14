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

## UI Button Catalog — every clickable control

These CSS selectors can be sent straight to `POST /click` or
`fm.click("#selector")`. Clicks go through the full UI handler, so
popups, job progress, and downstream automation fire exactly as they
would for a manual click.

### Step 1 — Image

| Button | Selector | Effect |
|---|---|---|
| Generate image | `#ws-generate-image` | Kicks off image generation using current form values (prompt, engine, count, steps, style, checkboxes) |
| Copy prompt | `#ws-copy-prompt` | Copy the current prompt text to clipboard |
| Enhance prompt | `#ws-enhance-prompt` | AI-augment the prompt with style keywords |
| Use this image for 3D | `#ws-use-for-3d-btn` | Tag the current preview image as the source for step 2 |
| Expand image | `#ws-image-expand-btn` | Open the selected image in the full-screen lightbox |
| Previous / next image | `#ws-img-prev` / `#ws-img-next` | Walk through versions |

Image **AI tools** (each opens a modal or kicks off a background edit):

| Tool | Selector |
|---|---|
| Modify (img2img) | `#ws-modify-btn` |
| Auto Inpaint (CLIPSeg) | `#ws-autoinpaint-btn` |
| Remove BG | `#ws-removebg-btn` |
| Resolution (upscale/downscale) | `#ws-resolution-btn` |
| Style transfer | `#ws-style-btn` (custom dropdown — use `#ws-style-menu .style-option[data-value="..."]`) |
| Face Fix | `#ws-facefix-btn` |
| Symmetrize Auto | `#ws-symmetrize-auto-btn` |
| Generate Multi-Views | `#ws-multiview-btn` |

Image **manual tools** (modals with canvas):

| Tool | Selector |
|---|---|
| Clone Stamp | `#ws-clone-btn` |
| Draw Mask | `#ws-mask-btn` |
| Crop | `#ws-crop-btn` |
| Brightness / Contrast | `#ws-brightness-btn` |
| Color Pick | `#ws-picker-btn` |
| Blur Brush | `#ws-blur-btn` |
| Symmetrize (manual axis) | `#ws-symmetrize-btn` |
| Paint (selection + drawing) | `#ws-paint-btn` |

Image **Export**:

| Button | Selector |
|---|---|
| Export image to disk | `#ws-export-img-btn` |

Image **form fields** (set via `POST /set` or `fm.set_value`):

| Field | Selector | Notes |
|---|---|---|
| Prompt text | `#ws-prompt` | String |
| Asset type | `#ws-asset-type` | character / prop / vehicle / building / creature |
| Asset style | `#ws-asset-style` | realistic / stylized / anime / ... |
| Engine | `#ws-engine` | `local-realvis`, `pollinations`, ... |
| Count | `#ws-count` | Integer |
| Quality (steps) | `#ws-quality` | Integer steps |
| Auto Multi-Views | `#ws-auto-multiview` | Checkbox |
| Construction stages | `#ws-img-buildstages` | Checkbox |

### Step 2 — 3D Mesh

| Button | Selector | Effect |
|---|---|---|
| Generate 3D mesh | `#ws-generate-mesh` | Runs image → mesh pipeline (disabled until step 1 image is "used for 3D") |
| Use this mesh for rig | `#ws-use-for-rig-btn` | Mark current mesh as rig source |
| Expand mesh viewer | `#ws-mesh-expand-btn` | Full-screen 3D viewer |

Mesh **File**:

| Button | Selector |
|---|---|
| Export mesh | `#ws-mesh-export-btn` |
| Open in Blender | `#ws-mesh-blender-btn` |
| Show in folder | `#ws-mesh-folder-btn` |

Mesh **AI tools**:

| Tool | Selector |
|---|---|
| Smooth | `#ws-mesh-smooth-btn` |
| Decimate | `#ws-mesh-decimate-btn` |
| Subdivide | `#ws-mesh-subdivide-btn` |
| Fix normals | `#ws-mesh-fixnormals-btn` |
| Fill holes | `#ws-mesh-fillholes-btn` |
| Center | `#ws-mesh-center-btn` |
| Re-Texture | `#ws-mesh-retexture-btn` |

Mesh **Manual tools** (open 3D edit modal):

| Tool | Selector |
|---|---|
| Sculpt | `#ws-mesh-sculpt-btn` |
| Paint (vertex) | `#ws-mesh-paintvert-btn` |
| Select (faces) | `#ws-mesh-selectface-btn` |

Mesh **form fields**:

| Field | Selector |
|---|---|
| Engine | `#ws-3d-engine` |
| Quality preset | `#ws-3d-quality` |
| Target triangles | `#ws-3d-triangles` |
| Build stages | `#ws-3d-buildstages` |

### Step 3 — Rig

| Button | Selector | Effect |
|---|---|---|
| Generate rig (AI) | `#ws-generate-rig-ai` | Runs auto-rig pipeline on current mesh |
| Landmarks (manual placement) | `#ws-lm-manual` | Opens full-screen landmark placement modal |

Rig **File**:

| Button | Selector |
|---|---|
| Export to Unreal | `#ws-rig-unreal-btn` |
| Edit in Blender | `#ws-rig-blender-btn` |
| Show in folder | `#ws-rig-folder-btn` |

Rig **AI / Manual**:

| Tool | Selector |
|---|---|
| Re-skin only | `#ws-rig-reskin-btn` |
| Test animation | `#ws-rig-test-btn` |
| Animation selector | `#ws-rig-anim-select` |
| Play animation | `#ws-rig-anim-play` |
| Engine | `#ws-rig-engine` |

### Multi-view selector bars

| Element | Selector | Notes |
|---|---|---|
| Small viewer MV bar | `#ws-multiview-bar .mv-btn[data-view="right"]` | `data-view` = `front`, `30`, `90`, `150`, `210`, `270`, `330` |
| Lightbox MV bar | `#lb-multiview-bar .mv-btn[data-view="..."]` | Same semantics |

### Version strips

| Element | Selector pattern | Notes |
|---|---|---|
| Image version | `#ws-image-versions .version-thumb:nth-child(N)` | 1-indexed; most-recent first |
| Mesh version | `#ws-mesh-versions .version-thumb:nth-child(N)` | |
| Rig version | `#ws-rig-versions .version-thumb:nth-child(N)` | |

### How to find IDs you don't see here

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"code":"Array.from(document.querySelectorAll(\"[id^=ws-]\")).map(e=>e.id)"}' \
     http://127.0.0.1:7331/eval | jq
```

---

## IPC Method Catalog

For actions that don't need the UI (headless automation, background
batches) use `POST /ipc {method, args}` to invoke any preload method.
Get the authoritative live list with `GET /ipc/methods` or
`fm.ipc_methods()`.

Common categories:

| Category | Methods |
|---|---|
| Image gen | `generateImages`, `generateFromPrompt`, `generateFromImage`, `generateBuildStages`, `generateMultiview` |
| Image tools | `removeBackground`, `imageAdjust`, `img2img`, `autoInpaint`, `maskInpaint`, `imageQuickEdit`, `revertImage`, `listImageVersions`, `exportImage` |
| 3D mesh | `imageTo3D`, `imageToTrellis`, `refineMesh`, `meshTool`, `exportMesh`, `openInBlender`, `listMeshes`, `deleteMesh`, `copyMeshToProject` |
| Rig | `autoRig`, `autoRigAI`, `listRigTemplates`, `listRigAnimations`, `saveLandmarks`, `loadLandmarks`, `analyzeSkeleton`, `exportToUnreal` |
| Projects | `listProjects`, `createProjectFromMesh`, `deleteProject`, `importImage`, `importImageFile`, `importMesh` |
| Files | `getFileInfo`, `pickExportPath`, `showInExplorer`, `deleteFile`, `deleteImageFolder`, `openImagesFolder`, `openMeshesFolder`, `openLogsFolder` |
| Config | `getConfig`, `setConfig`, `checkGPU`, `checkRAM`, `setRamLimit`, `setGpuLimits`, `toggleUnrestricted`, `getParentalStatus` |
| Jobs | `cancelJob`, `stopSdxlServer`, `countPython` |
| NSFW guard | `checkProjectNsfw`, `checkImagesNsfwTags`, `getNsfwKeywords`, `checkImageNsfw`, `batchCheckNsfw` |

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
