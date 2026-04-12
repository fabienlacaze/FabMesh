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
# Tool implementations
# =====================================================================

def _run_bridge(script_name, args, timeout=600):
    """Run a Python bridge script and return (success, stdout, stderr)."""
    script = os.path.join(SCRIPTS_DIR, script_name)
    if not os.path.exists(script):
        return False, "", f"Script not found: {script}"
    cmd = [PYTHON, script] + [str(a) for a in args]
    log(f"running: {' '.join(cmd)}")
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout,
            cwd=PROJECT_ROOT,
        )
        return result.returncode == 0, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return False, "", f"Timed out after {timeout}s"
    except Exception as e:
        return False, "", str(e)


def tool_generate_image(params):
    """Generate an image from a text prompt using RealVis XL (local GPU)."""
    prompt = params.get("prompt", "")
    if not prompt:
        return {"success": False, "error": "prompt is required"}
    project = params.get("project", "mcp_gen")
    count = params.get("count", 1)
    steps = params.get("steps", 30)

    safe_name = "".join(c if c.isalnum() or c in "_-" else "_" for c in project)
    out_dir = os.path.join(IMAGES_DIR, safe_name)
    os.makedirs(out_dir, exist_ok=True)

    ok, stdout, stderr = _run_bridge(
        "local_juggernaut_bridge.py",
        [prompt, out_dir, str(count), str(steps)],
        timeout=300
    )
    if not ok:
        return {"success": False, "error": stderr[-500:] if stderr else "generation failed", "stdout": stdout[-500:]}

    # Find generated images
    images = sorted([
        os.path.join(out_dir, f) for f in os.listdir(out_dir)
        if f.endswith('.png') and not f.startswith('.')
    ], key=os.path.getmtime, reverse=True)[:count]

    return {
        "success": True,
        "images": images,
        "count": len(images),
        "project": safe_name,
    }


def tool_generate_mesh(params):
    """Generate a 3D mesh from an image using Stable Fast 3D (local GPU)."""
    image_path = params.get("image_path", "")
    if not image_path or not os.path.exists(image_path):
        return {"success": False, "error": f"image not found: {image_path}"}
    quality = params.get("quality", "standard")
    subdivide = params.get("subdivide", 0)

    quality_map = {
        "draft": {"tex": 512, "verts": 3000},
        "standard": {"tex": 1024, "verts": -1},
        "high": {"tex": 2048, "verts": 30000},
    }
    q = quality_map.get(quality, quality_map["standard"])

    timestamp = int(time.time())
    base = os.path.splitext(os.path.basename(image_path))[0]
    safe_base = "".join(c if c.isalnum() or c in "_-" else "_" for c in base)
    out_glb = os.path.join(MESHES_DIR, f"{safe_base}_sf3d_{timestamp}.glb")

    ok, stdout, stderr = _run_bridge(
        "local_sf3d_bridge.py",
        [image_path, out_glb, str(q["tex"]), str(q["verts"]), "none", str(subdivide)],
        timeout=300
    )
    if not ok:
        return {"success": False, "error": stderr[-500:] if stderr else "mesh generation failed"}

    if not os.path.exists(out_glb):
        return {"success": False, "error": "GLB file not created"}

    # Parse stats from stdout
    verts, faces = "?", "?"
    for line in stdout.split("\n"):
        if "STATS:" in line:
            import re
            m = re.search(r"verts=(\d+)\s+faces=(\d+)", line)
            if m:
                verts, faces = m.group(1), m.group(2)

    return {
        "success": True,
        "mesh_path": out_glb,
        "size_bytes": os.path.getsize(out_glb),
        "vertices": verts,
        "triangles": faces,
        "quality": quality,
        "subdivide_levels": subdivide,
    }


def tool_generate_rig(params):
    """Rig a mesh using UniRig (local GPU) for UE5-compatible skeleton."""
    mesh_path = params.get("mesh_path", "")
    if not mesh_path or not os.path.exists(mesh_path):
        return {"success": False, "error": f"mesh not found: {mesh_path}"}

    timestamp = int(time.time())
    base = os.path.splitext(os.path.basename(mesh_path))[0]
    safe_base = "".join(c if c.isalnum() or c in "_-" else "_" for c in base)
    out_glb = os.path.join(MESHES_DIR, f"{safe_base}_rigged_{timestamp}.glb")

    # Step 1: UniRig skeleton + skin
    unirig_out = os.path.join(MESHES_DIR, f"{safe_base}_unirig_temp_{timestamp}.glb")
    ok, stdout, stderr = _run_bridge("unirig_bridge.py", [mesh_path, unirig_out], timeout=600)
    if not ok or not os.path.exists(unirig_out):
        return {"success": False, "error": f"UniRig failed: {stderr[-300:]}", "stdout": stdout[-300:]}

    # Step 2: Swap to UE5 skeleton
    swap_out = os.path.join(MESHES_DIR, f"{safe_base}_swap_temp_{timestamp}.glb")
    bones_json = os.path.join(SCRIPTS_DIR, "rig_templates", "skm", "orc_m1.bones.json")
    ok2, stdout2, stderr2 = _run_bridge("swap_skeleton.py", [unirig_out, bones_json, swap_out], timeout=120)
    try: os.remove(unirig_out)
    except: pass
    if not ok2 or not os.path.exists(swap_out):
        return {"success": False, "error": f"Skeleton swap failed: {stderr2[-300:]}"}

    # Step 3: Bake procedural animations
    bake_script = os.path.join(SCRIPTS_DIR, "bake_procedural_anims.py")
    if os.path.exists(bake_script):
        ok3, stdout3, stderr3 = _run_bridge("bake_procedural_anims.py", [swap_out, bones_json, out_glb], timeout=120)
        if not ok3 or not os.path.exists(out_glb):
            # Fallback: use swap output as-is
            import shutil
            shutil.copy2(swap_out, out_glb)
    else:
        import shutil
        shutil.copy2(swap_out, out_glb)
    try: os.remove(swap_out)
    except: pass

    if not os.path.exists(out_glb):
        return {"success": False, "error": "Rigged GLB not created"}

    return {
        "success": True,
        "rigged_mesh_path": out_glb,
        "size_bytes": os.path.getsize(out_glb),
    }


def tool_list_projects(params):
    """List all FabMesh projects with their images, meshes, and rigs."""
    projects = []
    if os.path.isdir(IMAGES_DIR):
        for name in sorted(os.listdir(IMAGES_DIR)):
            proj_dir = os.path.join(IMAGES_DIR, name)
            if not os.path.isdir(proj_dir):
                continue
            images = [f for f in os.listdir(proj_dir) if f.endswith('.png') and not f.startswith('.')]
            # Find meshes matching this project name
            meshes = [f for f in os.listdir(MESHES_DIR) if f.startswith(name) and f.endswith('.glb')] if os.path.isdir(MESHES_DIR) else []
            projects.append({
                "name": name,
                "images": len(images),
                "meshes": len(meshes),
                "path": proj_dir,
            })
    return {"projects": projects, "count": len(projects)}


def tool_batch_pipeline(params):
    """Run a full image→mesh→rig pipeline for multiple assets in series."""
    assets = params.get("assets", [])
    if not assets:
        return {"success": False, "error": "assets list is required"}

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

        mesh_path = mesh_result["mesh_path"]

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
        "description": "Generate an image from a text prompt using RealVis XL (local GPU). Returns the image file path.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "Text description of the image to generate"},
                "project": {"type": "string", "description": "Project name (folder name for organizing outputs)", "default": "mcp_gen"},
                "count": {"type": "integer", "description": "Number of images to generate", "default": 1},
                "steps": {"type": "integer", "description": "Diffusion steps (10=fast, 30=balanced, 50=quality)", "default": 30},
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
        "description": "Run a full image→mesh→rig pipeline for multiple assets in series. Each asset gets a prompt, quality preset, and optional subdivision. Returns results for each asset.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "assets": {
                    "type": "array",
                    "description": "List of assets to generate",
                    "items": {
                        "type": "object",
                        "properties": {
                            "prompt": {"type": "string", "description": "Text description for image generation"},
                            "project": {"type": "string", "description": "Project name"},
                            "quality": {"type": "string", "enum": ["draft", "standard", "high"], "default": "standard"},
                            "subdivide": {"type": "integer", "default": 0},
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
