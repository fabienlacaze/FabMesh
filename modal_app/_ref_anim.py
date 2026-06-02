"""Modal app: FBX reference-animation pipeline.

Separate app `myfabmesh-fbx-retarget` (NOT folded into
`myfabmesh-anim`) so the heavy AnyTop image stays unchanged and
AnyTop cold-starts stay fast. This app is CPU-only — ~30 s cold start
(bpy + numpy + scipy, no torch / no CUDA).

DEPLOY:
    modal deploy modal_app/_ref_anim.py

INVOKE (via the Worker):
    POST <fbx_retarget_url>/fbx-retarget-start  → { job_id }
    POST <fbx_retarget_url>/fbx-retarget-status → { ready, error?, bytes? }
    POST <fbx_retarget_url>/fbx-retarget-fetch  → binary GLB stream
    GET  <fbx_retarget_url>/healthz             → liveness

Mirrors `modal_app/_anytop_anim.py:anim_router` 1:1 in structure so
the Worker streaming/status code can be cloned with simple URL swaps.

OUTPUT FORMAT (compatible with worker.ts/handleAutoAnimStatus):
  /fbx_data/<job_id>.glb on success (Three.js anim viewer loads this
    identically to AnyTop output — same Puppeteer rig + AnimationClip).
  /fbx_data/<job_id>.err on failure (JSON with error string).
  /fbx_data/<job_id>.call_id — FunctionCall object_id for cancellation.
  /fbx_data/<job_id>.meta — JSON with detected_skeleton_id, etc., so
    the status endpoint can echo it back to the UI for a "Detected:
    UE5 Mannequin" toast.
"""
import json
import os
import sys
import uuid

import modal


# ============================================================
# App + Image
# ============================================================
app = modal.App("myfabmesh-fbx-retarget")

# bpy 5.1+ ships an official PyPI wheel of Blender as a Python module.
# This is the FBX-parsing leg of the pipeline. Keep it pinned so a
# silent upstream API change doesn't break parse_fbx() in prod.
#
# Image size budget: ~390 MB extra for bpy on top of debian_slim.
# Cold start: ~25-40 s (snapshot cannot be used here because bpy has
# its own DLL-style import side effects).
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        # bpy needs a working X (libgl) for headless mesh ops even
        # though we never render. libxrender + libxi + libsm are all
        # imported by the Blender SOs at process start.
        "libgl1", "libxrender1", "libxi6", "libsm6", "libxext6",
        "libxkbcommon0", "libglib2.0-0",
    )
    .pip_install(
        # bpy 5.1.2 → Blender 5.1 — supports FBX 2006-2026 incl. UE5
        # Mannequin and CC4 exports (ORC_M1).
        "bpy==5.1.2",
        "numpy>=1.26,<2",
        "scipy==1.13.1",
        "fastapi[standard]",
        "requests==2.32.3",
    )
    # Mount the retargeter + FBX parser + bone mapping JSONs. We DO
    # NOT mount bvhsdk — this app never reads BVH.
    .add_local_python_source("scripts")
)

output_vol = modal.Volume.from_name(
    "myfabmesh-fbx-retarget-output", create_if_missing=True,
)


def _log(msg: str) -> None:
    print(f"[fbx_retarget] {msg}", flush=True)


# ============================================================
# Heavy function: parse FBX + retarget → GLB
# ============================================================
@app.function(
    image=image,
    cpu=2,
    memory=4096,
    timeout=600,
    volumes={"/fbx_data": output_vol},
)
def retarget(
    rig_bytes: bytes,
    fbx_bytes: bytes,
    source_skel_hint: str = "auto",
    target_family: str = "humanoid_puppeteer",
    clip_name: str = "clip",
    job_id: str = "",
) -> int:
    """Parse the FBX, retarget onto the Puppeteer rig, write the
    animated GLB to the volume keyed by job_id.

    Returns the number of bytes written on success. On failure writes
    an .err JSON sentinel and raises (so the call_id is marked
    failed)."""
    if not job_id:
        job_id = uuid.uuid4().hex

    out_path = f"/fbx_data/{job_id}.glb"
    err_path = f"/fbx_data/{job_id}.err"
    meta_path = f"/fbx_data/{job_id}.meta"

    work_dir = f"/tmp/fbx_{job_id}"
    os.makedirs(work_dir, exist_ok=True)
    rig_path = os.path.join(work_dir, "rig.glb")
    fbx_path = os.path.join(work_dir, "ref.fbx")

    # The mounted `scripts/` package needs to be on sys.path so the
    # `from fbx_motion import parse_fbx` lazy import inside
    # `retarget_fbx_to_rig` works.
    sys.path.insert(0, "/scripts")
    sys.path.insert(0, "/")

    try:
        _log(f"job_id={job_id} hint={source_skel_hint} target={target_family}")
        with open(rig_path, "wb") as f:
            f.write(rig_bytes)
        with open(fbx_path, "wb") as f:
            f.write(fbx_bytes)
        _log(f"wrote rig={len(rig_bytes)}B fbx={len(fbx_bytes)}B")

        # Validate FBX magic. Binary FBX: "Kaydara FBX Binary"; ASCII
        # FBX starts with `; FBX`. Anything else is a malformed input.
        head = fbx_bytes[:24]
        if not (head.startswith(b"Kaydara FBX Binary")
                or head.startswith(b"; FBX")):
            raise RuntimeError(
                f"input is not an FBX (got first 24 bytes: {head!r})"
            )

        # Run the retarget. Pure-Python — no GPU. The bpy subprocess
        # is spawned by parse_fbx() internally.
        from scripts.anytop_retarget import retarget_fbx_to_rig  # type: ignore
        result = retarget_fbx_to_rig(
            rig_glb_path=rig_path,
            fbx_path=fbx_path,
            out_glb_path=out_path,
            source_skel_id=source_skel_hint or "auto",
            target_family=target_family or "humanoid_puppeteer",
            clip_name=clip_name or "clip",
            target_fps=30.0,
            ckpt_family='all',
        )

        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(result, f)
        sz = os.path.getsize(out_path)
        _log(f"DONE bytes={sz} meta={result}")
        output_vol.commit()
        return sz
    except Exception as e:
        import traceback
        err_msg = {
            "error": str(e),
            "type": type(e).__name__,
            "trace": traceback.format_exc()[:4000],
        }
        try:
            with open(err_path, "w", encoding="utf-8") as f:
                json.dump(err_msg, f)
            output_vol.commit()
        except Exception as we:
            _log(f"WARN writing .err sentinel: {we}")
        _log(f"FAILED {type(e).__name__}: {e}")
        raise


# ============================================================
# ASGI router (FastAPI). Mirrors anim_router 1:1 so worker.ts
# streaming can be cloned with URL swaps.
# ============================================================
@app.function(
    image=image,
    cpu=1,
    timeout=300,
    volumes={"/fbx_data": output_vol},
    secrets=[modal.Secret.from_name("myfabmesh-shared", required_keys=["SHARED_SECRET"])],
)
@modal.asgi_app()
def fbx_retarget_router():
    from fastapi import FastAPI, HTTPException, Request
    from fastapi.responses import FileResponse, JSONResponse
    import urllib.request

    api = FastAPI(title="myfabmesh-fbx-retarget router")

    async def _read_json(request: Request):
        try:
            return await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="invalid JSON body")

    def _check_auth(payload: dict) -> None:
        expected = os.environ.get("SHARED_SECRET", "")
        if not expected:
            return
        if str(payload.get("_auth") or "") != expected:
            raise HTTPException(status_code=401, detail="auth")

    def _fetch_bytes(url: str, max_bytes: int = 80 * 1024 * 1024) -> bytes:
        req = urllib.request.Request(
            url, headers={"User-Agent": "myfabmesh-fbx-retarget/1.0"},
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.read(max_bytes + 1)

    @api.get("/healthz")
    async def healthz():
        return {"ok": True, "fn": "fbx_retarget_router"}

    @api.post("/fbx-retarget-start")
    async def start(request: Request):
        payload = await _read_json(request)
        _check_auth(payload)
        op = (payload.get("op_type") or "").strip().lower()
        if op == "cancel":
            jid = (payload.get("job_id") or "").strip()
            call_id_path = f"/fbx_data/{jid}.call_id"
            if jid and os.path.isfile(call_id_path):
                try:
                    with open(call_id_path) as f:
                        cid = f.read().strip()
                    modal.FunctionCall.from_id(cid).cancel(terminate_containers=True)
                    return {"job_id": jid, "status": "cancelled"}
                except Exception as e:
                    raise HTTPException(status_code=500, detail=f"cancel failed: {e}")
            raise HTTPException(status_code=404, detail="no call_id for job_id")

        rig_url = (payload.get("rig_url") or "").strip()
        ref_url = (payload.get("ref_anim_url") or "").strip()
        if not rig_url:
            raise HTTPException(status_code=400, detail="rig_url required")
        if not ref_url:
            raise HTTPException(status_code=400, detail="ref_anim_url required")
        hint = (payload.get("source_skeleton_id_hint") or "auto").strip()
        target_family = (payload.get("target_family") or "humanoid_puppeteer").strip()
        clip_name = (payload.get("clip_name") or "clip").strip()

        # Download both inputs into bytes. The bytes are passed via the
        # Modal RPC channel to `retarget()` rather than re-downloaded
        # in the function — saves ~5 s and avoids R2 throttling.
        try:
            rig_bytes = _fetch_bytes(rig_url)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"rig fetch failed: {e}")
        if not rig_bytes or rig_bytes[:4] != b"glTF":
            raise HTTPException(status_code=400, detail="rig_url did not return a GLB")

        try:
            fbx_bytes = _fetch_bytes(ref_url)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"ref_anim fetch failed: {e}")
        if not fbx_bytes:
            raise HTTPException(status_code=400, detail="ref_anim_url returned 0 bytes")

        job_id = (payload.get("job_id") or "").strip() or uuid.uuid4().hex
        call = await retarget.spawn.aio(
            rig_bytes, fbx_bytes, hint, target_family, clip_name, job_id=job_id,
        )
        try:
            with open(f"/fbx_data/{job_id}.call_id", "w") as f:
                f.write(call.object_id)
            output_vol.commit()
        except Exception as e:
            print(f"[fbx-retarget-start] WARN persist call_id {job_id}: {e}", flush=True)
        return {"job_id": job_id, "status": "queued"}

    @api.post("/fbx-retarget-status")
    async def status(request: Request):
        payload = await _read_json(request)
        _check_auth(payload)
        job_id = (payload.get("job_id") or "").strip()
        if not job_id:
            raise HTTPException(status_code=400, detail="job_id required")
        output_vol.reload()
        out_path = f"/fbx_data/{job_id}.glb"
        err_path = f"/fbx_data/{job_id}.err"
        meta_path = f"/fbx_data/{job_id}.meta"
        if os.path.isfile(err_path):
            with open(err_path) as f:
                raw = f.read()
            msg = raw
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict) and parsed.get("error"):
                    msg = str(parsed["error"])
            except Exception:
                pass
            return JSONResponse({"ready": False, "error": msg[:500]})
        if os.path.isfile(out_path):
            sz = os.path.getsize(out_path)
            meta = None
            if os.path.isfile(meta_path):
                try:
                    with open(meta_path) as f:
                        meta = json.load(f)
                except Exception:
                    meta = None
            return JSONResponse({
                "ready": True,
                "bytes": sz,
                "fetch_endpoint": "/fbx-retarget-fetch",
                "meta": meta,
            })
        return JSONResponse({"ready": False})

    @api.post("/fbx-retarget-fetch")
    async def fetch(request: Request):
        payload = await _read_json(request)
        _check_auth(payload)
        job_id = (payload.get("job_id") or "").strip()
        if not job_id or "/" in job_id or ".." in job_id:
            raise HTTPException(status_code=400, detail="job_id required (hex-ish)")
        output_vol.reload()
        out_path = f"/fbx_data/{job_id}.glb"
        err_path = f"/fbx_data/{job_id}.err"
        if os.path.isfile(err_path):
            raise HTTPException(status_code=410, detail="retarget failed; see /fbx-retarget-status")
        if not os.path.isfile(out_path):
            raise HTTPException(status_code=404, detail="retarget not ready yet")
        return FileResponse(
            out_path,
            media_type="model/gltf-binary",
            filename=f"{job_id}.glb",
        )

    return api
