"""
FabMesh MCP Server — Model Context Protocol for Claude Code integration
========================================================================

Exposes FabMesh generation tools to Claude via the MCP stdio protocol.
Claude Code can call these tools to generate images, 3D meshes, rigs,
and run batch pipelines — all executed locally on the user's GPU.

Usage (configured in .claude/mcp-servers/fabmesh.json):
    python scripts/mcp_server.py

Protocol: JSON-RPC 2.0 over stdin/stdout (MCP specification).
"""
import sys
import os
import json
import subprocess
import time
import traceback

# Project root = parent of scripts/
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
SCRIPTS_DIR = os.path.join(PROJECT_ROOT, 'scripts')
IMAGES_DIR = os.path.join(PROJECT_ROOT, 'images')
MESHES_DIR = os.path.join(PROJECT_ROOT, 'meshes')

# Use the same Python that's running this server
PYTHON = sys.executable


def log(msg):
    """Log to stderr (stdout is reserved for MCP protocol)."""
    print(f"[fabmesh-mcp] {msg}", file=sys.stderr, flush=True)


def send_response(id, result=None, error=None):
    """Send a JSON-RPC response to stdout."""
    resp = {"jsonrpc": "2.0", "id": id}
    if error is not None:
        resp["error"] = {"code": -32000, "message": str(error)}
    else:
        resp["result"] = result
    line = json.dumps(resp)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def send_notification(method, params=None):
    """Send a JSON-RPC notification (no id)."""
    msg = {"jsonrpc": "2.0", "method": method}
    if params:
        msg["params"] = params
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


# =====================================================================
# Electron bridge — all commands go through FabMesh Electron main.js
# so jobs appear in the UI and VRAM is gated.
# =====================================================================

ELECTRON_BRIDGE_URL = "http://127.0.0.1:7555"
_headless_proc = None


def _is_fabmesh_running():
    """Check if FabMesh Electron is reachable on the bridge port."""
    import urllib.request
    try:
        req = urllib.request.Request(f"{ELECTRON_BRIDGE_URL}/list-projects", method='POST',
                                     data=b'{}', headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status == 200
    except Exception:
        return False


def _ensure_fabmesh_running(visible=False):
    """If FabMesh is not running, launch it automatically.

    visible=False (default): headless mode, no window — Claude works silently.
    visible=True: normal mode with UI window — user sees the progress.
    """
    global _headless_proc
    if _is_fabmesh_running():
        return True

    mode = "visible" if visible else "headless"
    log(f"FabMesh not running -- launching in {mode} mode...")
    # Find the electron executable
    electron_cmd = os.path.join(PROJECT_ROOT, 'node_modules', '.bin', 'electron.cmd')
    if not os.path.exists(electron_cmd):
        electron_cmd = os.path.join(PROJECT_ROOT, 'node_modules', '.bin', 'electron')
    if not os.path.exists(electron_cmd):
        log("ERROR: electron not found in node_modules -- is FabMesh installed?")
        return False

    env = os.environ.copy()
    env.pop('ELECTRON_RUN_AS_NODE', None)

    args = [electron_cmd, '.']
    if not visible:
        args.append('--headless')

    _headless_proc = subprocess.Popen(
        args, cwd=PROJECT_ROOT, env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    log(f"Launched FabMesh {mode} (pid={_headless_proc.pid}), waiting for bridge...")

    # Wait up to 30s for the bridge to become ready
    for i in range(60):
        time.sleep(0.5)
        if _is_fabmesh_running():
            log(f"FabMesh {mode} bridge is ready!")
            return True
    log("ERROR: FabMesh did not start in 30s")
    return False


def _call_electron(action, params, timeout=600, visible=False):
    """POST a command to FabMesh Electron's MCP bridge HTTP endpoint.
    Auto-launches FabMesh if not already running.
    visible=True opens the UI window, False runs headless.
    Returns the JSON response dict. Raises RuntimeError on failure."""
    import urllib.request

    # Auto-launch if needed
    if not _is_fabmesh_running():
        if not _ensure_fabmesh_running(visible=visible):
            raise RuntimeError(
                "Cannot start FabMesh. Make sure it is installed "
                "(npm install in the project directory)."
            )

    url = f"{ELECTRON_BRIDGE_URL}/{action}"
    data = json.dumps(params).encode('utf-8')
    req = urllib.request.Request(url, data=data, method='POST',
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode('utf-8')
            return json.loads(body)
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"Cannot reach FabMesh Electron (bridge lost). Error: {e}"
        )
    except Exception as e:
        raise RuntimeError(f"Electron bridge call failed: {e}")


def tool_generate_image(params):
    """Generate an image from a text prompt using RealVis XL (local GPU).
    Dispatched through FabMesh Electron so the job appears in the UI."""
    prompt = params.get("prompt", "")
    if not prompt:
        return {"success": False, "error": "prompt is required"}
    visible = params.get("visible", False)
    return _call_electron("generate-images", {
        "prompt": prompt,
        "userPrompt": prompt,
        "projectName": params.get("project", "mcp_gen"),
        "numImages": params.get("count", 1),
        "steps": params.get("steps", 30),
        "engine": "local-flux",
    }, visible=visible)


def tool_generate_mesh(params):
    """Generate a textured 3D mesh from an image using Stable Fast 3D (local GPU).
    Dispatched through FabMesh Electron so the job appears in the UI."""
    image_path = params.get("image_path", "")
    if not image_path or not os.path.exists(image_path):
        return {"success": False, "error": f"image not found: {image_path}"}
    quality = params.get("quality", "standard")
    quality_map = {
        "draft": {"tex": 512, "verts": 3000},
        "standard": {"tex": 1024, "verts": -1},
        "high": {"tex": 2048, "verts": 30000},
    }
    q = quality_map.get(quality, quality_map["standard"])
    base = os.path.splitext(os.path.basename(image_path))[0]
    safe_base = "".join(c if c.isalnum() or c in "_-" else "_" for c in base)
    return _call_electron("image-to-3d", {
        "imagePath": image_path,
        "outputName": safe_base,
        "engine": "sf3d",
        "textureSize": q["tex"],
        "targetFaces": q["verts"],
        "subdivide": params.get("subdivide", 0),
    })


def tool_generate_rig(params):
    """Auto-rig a 3D mesh for UE5 using UniRig (local GPU).
    Dispatched through FabMesh Electron so the job appears in the UI."""
    mesh_path = params.get("mesh_path", "")
    if not mesh_path or not os.path.exists(mesh_path):
        return {"success": False, "error": f"mesh not found: {mesh_path}"}
    return _call_electron("auto-rig-ai", {
        "meshPath": mesh_path,
        "engine": "unirig",
    })


def tool_list_projects(params):
    """List all FabMesh projects via Electron."""
    return _call_electron("list-projects", {})


def tool_batch_pipeline(params):
    """Run a full image->mesh->rig pipeline for multiple assets in series.
    Set visible=true to show FabMesh UI, false (default) for background gen."""
    assets = params.get("assets", [])
    if not assets:
        return {"success": False, "error": "assets list is required"}
    visible = params.get("visible", False)

    # Ensure FabMesh is running before starting the batch
    if not _is_fabmesh_running():
        if not _ensure_fabmesh_running(visible=visible):
            return {"success": False, "error": "Cannot start FabMesh"}

    results = []
    for i, asset in enumerate(assets):
        log(f"batch [{i+1}/{len(assets)}]: {asset.get('prompt', '?')}")
        asset_result = {"prompt": asset.get("prompt", ""), "steps": []}

        # Step 1: Generate image
        prompt = asset.get("prompt", "a 3D game asset")
        project = asset.get("project", f"batch_{int(time.time())}_{i}")
        img_result = tool_generate_image({
            "prompt": prompt,
            "project": project,
            "count": 1,
            "steps": asset.get("steps", 30),
        })
        asset_result["steps"].append({"stage": "image", **img_result})
        if not img_result.get("success") or not img_result.get("images"):
            asset_result["success"] = False
            asset_result["error"] = "Image generation failed"
            results.append(asset_result)
            continue

        image_path = img_result["images"][0]

        # Step 2: Generate mesh
        mesh_result = tool_generate_mesh({
            "image_path": image_path,
            "quality": asset.get("quality", "standard"),
            "subdivide": asset.get("subdivide", 0),
        })
        asset_result["steps"].append({"stage": "mesh", **mesh_result})
        if not mesh_result.get("success"):
            asset_result["success"] = False
            asset_result["error"] = "Mesh generation failed"
            results.append(asset_result)
            continue

        # Electron returns meshPath (camelCase), bridge returns mesh_path
        mesh_path = mesh_result.get("meshPath") or mesh_result.get("mesh_path", "")

        # Step 3: Rig (optional, skip if asset says skip_rig=true)
        if not asset.get("skip_rig", False):
            rig_result = tool_generate_rig({"mesh_path": mesh_path})
            asset_result["steps"].append({"stage": "rig", **rig_result})
            if not rig_result.get("success"):
                asset_result["success"] = False
                asset_result["error"] = "Rigging failed"
                results.append(asset_result)
                continue

        asset_result["success"] = True
        results.append(asset_result)

    succeeded = sum(1 for r in results if r.get("success"))
    return {
        "success": succeeded == len(assets),
        "total": len(assets),
        "succeeded": succeeded,
        "failed": len(assets) - succeeded,
        "results": results,
    }


# =====================================================================
# MCP protocol handler
# =====================================================================

TOOLS = {
    "generate_image": {
        "description": "Generate an image from a text prompt using RealVis XL (local GPU). Returns the image file path. Set visible=true to show FabMesh UI with live progress, false (default) to run in background.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "Text description of the image to generate"},
                "project": {"type": "string", "description": "Project name (folder name for organizing outputs)", "default": "mcp_gen"},
                "count": {"type": "integer", "description": "Number of images to generate", "default": 1},
                "steps": {"type": "integer", "description": "Diffusion steps (10=fast, 30=balanced, 50=quality)", "default": 30},
                "visible": {"type": "boolean", "description": "Show FabMesh UI window (true) or run in background (false)", "default": False},
            },
            "required": ["prompt"],
        },
        "handler": tool_generate_image,
    },
    "generate_mesh": {
        "description": "Generate a textured 3D mesh (GLB) from an image using Stable Fast 3D (local GPU). Returns mesh path and triangle count.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "image_path": {"type": "string", "description": "Path to the source image (PNG/JPG)"},
                "quality": {"type": "string", "enum": ["draft", "standard", "high"], "description": "Quality preset: draft (~3K tri), standard (~13K tri), high (~30K tri)", "default": "standard"},
                "subdivide": {"type": "integer", "description": "Catmull-Clark subdivision levels (0=none, 1=~50K, 2=~200K, 3=~800K tri)", "default": 0},
            },
            "required": ["image_path"],
        },
        "handler": tool_generate_mesh,
    },
    "generate_rig": {
        "description": "Auto-rig a 3D mesh for UE5 using UniRig (local GPU). Produces a GLB with skeleton + Idle/Walk/Run animations.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "mesh_path": {"type": "string", "description": "Path to the GLB mesh file to rig"},
            },
            "required": ["mesh_path"],
        },
        "handler": tool_generate_rig,
    },
    "list_projects": {
        "description": "List all FabMesh projects with counts of images, meshes, and rigs.",
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
        "handler": tool_list_projects,
    },
    "batch_pipeline": {
        "description": "Run a full image->mesh->rig pipeline for multiple assets in series. Each asset gets a prompt, quality preset, and optional subdivision. Set visible=true to show FabMesh UI, false (default) to run silently in background.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "visible": {"type": "boolean", "description": "Show FabMesh UI window (true) or run in background (false)", "default": False},
                "assets": {
                    "type": "array",
                    "description": "List of assets to generate",
                    "items": {
                        "type": "object",
                        "properties": {
                            "prompt": {"type": "string", "description": "Text description for image generation"},
                            "project": {"type": "string", "description": "Project name"},
                            "quality": {"type": "string", "enum": ["draft", "standard", "high", "ultra"], "default": "standard"},
                            "subdivide": {"type": "integer", "description": "Target triangles: negative=decimate, 0=default 13K, 1-4=subdivision levels, >100=exact target", "default": 0},
                            "steps": {"type": "integer", "default": 30},
                            "skip_rig": {"type": "boolean", "description": "Skip rigging step", "default": False},
                        },
                        "required": ["prompt"],
                    },
                },
            },
            "required": ["assets"],
        },
        "handler": tool_batch_pipeline,
    },
}


def handle_request(request):
    """Handle a single MCP JSON-RPC request."""
    method = request.get("method", "")
    id = request.get("id")
    params = request.get("params", {})

    if method == "initialize":
        send_response(id, {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {
                "name": "fabmesh",
                "version": "1.0.0",
            },
        })
    elif method == "notifications/initialized":
        pass  # No response needed for notifications
    elif method == "tools/list":
        tools_list = []
        for name, tool in TOOLS.items():
            tools_list.append({
                "name": name,
                "description": tool["description"],
                "inputSchema": tool["inputSchema"],
            })
        send_response(id, {"tools": tools_list})
    elif method == "tools/call":
        tool_name = params.get("name", "")
        tool_args = params.get("arguments", {})
        tool = TOOLS.get(tool_name)
        if not tool:
            send_response(id, error=f"Unknown tool: {tool_name}")
            return
        try:
            log(f"calling tool {tool_name} with {json.dumps(tool_args)[:200]}")
            result = tool["handler"](tool_args)
            send_response(id, {
                "content": [{"type": "text", "text": json.dumps(result, indent=2)}],
            })
        except Exception as e:
            log(f"tool {tool_name} error: {e}")
            traceback.print_exc(file=sys.stderr)
            send_response(id, {
                "content": [{"type": "text", "text": json.dumps({"success": False, "error": str(e)})}],
                "isError": True,
            })
    elif method == "ping":
        send_response(id, {})
    else:
        if id is not None:
            send_response(id, error=f"Unknown method: {method}")


def main():
    log("FabMesh MCP server starting...")
    log(f"project root: {PROJECT_ROOT}")
    log(f"python: {PYTHON}")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            handle_request(request)
        except json.JSONDecodeError as e:
            log(f"invalid JSON: {e}")
        except Exception as e:
            log(f"error handling request: {e}")
            traceback.print_exc(file=sys.stderr)


if __name__ == "__main__":
    main()
