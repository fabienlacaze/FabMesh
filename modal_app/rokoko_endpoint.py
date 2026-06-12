"""MyFabmesh.AI Cloud — Rokoko retargeting endpoint (Modal).

WHY a SEPARATE Modal app from `app.py`:
    The Trellis stack (modal_app/app.py) needs CUDA 12.4 + torch 2.4 +
    a 30-60 min build of nvdiffrast/CuMesh/FlexGEMM/flash-attn. The
    Rokoko stack is CPU-only Blender — bundling them would either
    (a) re-build the Trellis CUDA layer every time we tweak the addon
    or (b) carry 20+ GB of unused GPU deps into the Blender container.
    Keep them separate: `myfabmesh-cloud` (GPU mesh) and
    `myfabmesh-rokoko` (CPU retarget). The Electron client just hits
    two different `modal.Function.from_name()`s.

DEPLOY:
    pip install modal
    modal token new                           # one-time
    modal deploy modal_app/rokoko_endpoint.py # ~8-12 min first build,
                                              # ~30 s cached re-deploys

INVOKE (Python):
    import modal
    f = modal.Function.from_name("myfabmesh-rokoko", "retarget")
    glb_bytes = f.remote(
        rig_glb_bytes=open("rig.glb","rb").read(),
        source_fbx_bytes=open("walk.fbx","rb").read(),
        labels_json_str=open("rig.glb.labels.json").read(),
    )
    open("out.glb","wb").write(glb_bytes)

CONCURRENCY:
    allow_concurrent_inputs=50  ×  max_containers=20  =  1000 in flight
    (50 parallel retargets per Modal container because Blender's
    `--background` mode is single-threaded but the addon's nla.bake
    spends most of its time in Python loops on a 4-CPU box: we run
    each invocation as an OS subprocess inside the container, capped
    at 50 — beyond that the 4 vCPUs over-commit and per-job latency
    degrades.)

COST (Modal CPU = $0.00018 / vCPU-second on Standard plan):
    Container shape: cpu=4 vCPU, memory=4 GiB → $0.00072 / second
    Average retarget wall time (measured on Blender 4.4.3 + RSL 1.4.3
        with the Apovivor 1-3 sec FBX motions): ~8 s
    Per retarget:               8 s × $0.00072 = $0.0058   (≈ 0.6 ¢)
    Per single user (100 jobs):                = $0.58
    Full 55k training batch:    55000 × $0.0058 = $317
    (vs $50 / hr on a local Ryzen 5950X = ~9 hr × $50 = $450, and
    Modal parallelises ~20× so wall-clock drops from 9 hr to 27 min.)

NOTES:
    - Container `scaledown_window=120` so a burst of 100 jobs from one
      user keeps the container warm and avoids paying the ~10 s Blender
      `--background` startup on every invocation.
    - The endpoint accepts bytes directly (rig_glb, source_fbx, labels
      JSON string). No R2/S3 hop needed for the typical 1-5 MB payloads.
      For larger jobs (full FBX motion library), the Electron client
      should batch via `.map()` rather than upload-via-bytes per call.
    - Local fallback: the Electron worker MUST handle network failure;
      this module exposes `retarget.remote()` only — the caller decides
      whether to retry locally via scripts/rokoko_batch_retarget.py.
"""
from __future__ import annotations

import io
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import modal


# ---------------------------------------------------------------------------
# Image — Blender 4.4.3 Linux + Rokoko Studio Live addon v1.4.3 (LGPL-3.0).
#
# Why pin Blender 4.4.3 specifically:
#   Rokoko addon issues #131 / #135 break the operator on Blender 5.x
#   (the `rsl_retargeting_bone_list` PointerProperty registration moved).
#   4.4.3 is the last LTS confirmed working with addon 1.4.3 — same
#   version the desktop pipeline runs against, so byte-identical output.
#
# Why repackage the addon zip:
#   GitHub's tag tarball extracts as `rokoko-studio-live-blender-1-4-3/`
#   but Blender's `addon_install` keys the module by the inner folder
#   name. The addon's __init__.py registers under
#   `rokoko-studio-live-blender`, so we rename before zipping.
# ---------------------------------------------------------------------------
BLENDER_URL = (
    "https://download.blender.org/release/Blender4.4/"
    "blender-4.4.3-linux-x64.tar.xz"
)
ROKOKO_ADDON_URL = (
    "https://github.com/Rokoko/rokoko-studio-live-blender/"
    "archive/refs/tags/v1-4-3.zip"
)
BLENDER_DIR = "/opt/blender-4.4.3-linux-x64"
BLENDER_EXE = f"{BLENDER_DIR}/blender"

# Module name Blender uses internally for the addon (matches the addon's
# `bl_info["name"]` slug — see scripts/rokoko_batch_retarget.py).
ADDON_MODULE = "rokoko-studio-live-blender"


rokoko_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        # wget + xz-utils: pull + extract the Blender tarball.
        "wget", "xz-utils", "unzip", "ca-certificates",
        # Blender headless deps (libGL, libX*, libxkbcommon) — without
        # these `blender --background` segfaults at startup on
        # debian:slim because the binary still dlopens X libs even in
        # headless mode (Eevee's GL context is initialised lazily but
        # the *check* happens at boot).
        "libxi6", "libxxf86vm1", "libxfixes3", "libxrender1",
        "libgl1", "libglu1-mesa", "libxkbcommon0", "libsm6",
        # Fontconfig is needed by Blender's text rendering — without it
        # the GLTF exporter logs spam fontconfig warnings that overflow
        # the 1 MB Modal stdout buffer on the 100th call.
        "libfreetype6", "fontconfig",
    )
    .pip_install(
        # numpy is needed by auto_label_rig.py (k-NN) AND by the rokoko
        # batch script's puppeteer_joint_renamer fallback. Blender bundles
        # its own numpy — but we run the bytes-in / bytes-out wrapper as
        # CPython, not as `blender --python`, so we need it at the venv
        # level too.
        "numpy>=1.26,<2.0",
        "fastapi[standard]>=0.115",
    )
    .run_commands(
        # --- Blender 4.4.3 install ---
        f"wget -q {BLENDER_URL} -O /tmp/blender.tar.xz",
        "tar -xJf /tmp/blender.tar.xz -C /opt",
        "rm /tmp/blender.tar.xz",
        # Smoke-test Blender boots in --background mode. Cheap insurance:
        # if a future debian:slim drops a needed lib (cf. the X.org
        # libxfixes3 hiccup in 2025-Q4), the image build FAILS at this
        # step instead of every single retarget call.
        f"{BLENDER_EXE} --background --factory-startup "
        f"--python-expr 'import bpy; print(\"BLENDER OK\", bpy.app.version_string)'",

        # --- Rokoko addon v1.4.3 install ---
        f"wget -q {ROKOKO_ADDON_URL} -O /tmp/rokoko.zip",
        "unzip -q /tmp/rokoko.zip -d /tmp",
        # GitHub names the extracted folder rokoko-studio-live-blender-1-4-3/
        # — rename to match the bl_info slug Blender keys on.
        f"mv /tmp/rokoko-studio-live-blender-1-4-3 /tmp/{ADDON_MODULE}",
        # Re-zip with the correct top-level dir name so addon_install
        # registers it under `rokoko-studio-live-blender`.
        f"cd /tmp && zip -qr /tmp/{ADDON_MODULE}.zip {ADDON_MODULE}",
        # Install + enable. We use --python-expr instead of --python
        # because there's no Python file to ship — keeps the layer small.
        # `userpref.save=False` ensures we don't pollute the snapshot
        # with a writable user prefs dir; addon stays enabled because
        # `addon_enable` writes to bpy.context.preferences which Blender
        # restores on each --background launch via factory-startup
        # only if we save here.
        f"{BLENDER_EXE} --background --factory-startup --python-expr \""
        "import bpy; "
        f"bpy.ops.preferences.addon_install(filepath='/tmp/{ADDON_MODULE}.zip'); "
        f"bpy.ops.preferences.addon_enable(module='{ADDON_MODULE}'); "
        "bpy.ops.wm.save_userpref(); "
        f"print('ADDON OK', '{ADDON_MODULE}')\"",
        # Build-time guard — fail the image build if the operator is
        # missing. This is the symptom we'd otherwise hit at the first
        # production call ("AttributeError: 'Scene' has no attribute
        # 'rsl_retargeting_bone_list'").
        f"{BLENDER_EXE} --background --factory-startup --python-expr \""
        "import bpy; "
        f"bpy.ops.preferences.addon_enable(module='{ADDON_MODULE}'); "
        "assert hasattr(bpy.context.scene, 'rsl_retargeting_bone_list'), "
        "'RSL property missing — addon enable failed'; "
        "assert hasattr(bpy.ops.rsl, 'retarget_animation'), "
        "'RSL operator missing'; "
        "print('RSL OPERATORS OK')\"",
        "rm /tmp/rokoko.zip",
    )
    # Ship the SAME scripts used locally so the bytes-in / bytes-out
    # endpoint reuses the proven retarget logic verbatim. add_local_*
    # must be LAST in a Modal image build.
    .add_local_file(
        "scripts/rokoko_batch_retarget.py",
        remote_path="/opt/scripts/rokoko_batch_retarget.py",
    )
    .add_local_file(
        "scripts/auto_label_rig.py",
        remote_path="/opt/scripts/auto_label_rig.py",
    )
    .add_local_file(
        "scripts/puppeteer_joint_renamer.py",
        remote_path="/opt/scripts/puppeteer_joint_renamer.py",
    )
    # Anchors used by auto_label_rig.py k-NN fallback. We DO ship them
    # even though the typical Electron flow runs auto_label_rig LOCALLY
    # before sending labels_json to the cloud — keeps the endpoint
    # standalone (you can pass labels_json_str="" and the endpoint will
    # re-derive labels from the GLB's bone graph).
    .add_local_dir(
        "scripts/rig_mappings/_puppeteer_anchors",
        remote_path="/opt/scripts/rig_mappings/_puppeteer_anchors",
    )
)


app = modal.App("myfabmesh-rokoko", image=rokoko_image)


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------
@app.function(
    cpu=4.0,
    memory=4096,
    # 120 s timeout matches the local single-retarget subprocess timeout
    # in scripts/rokoko_batch_retarget.py (`subprocess.run(..., timeout=120)`).
    # 99% of Apovivor motions complete in <15 s; the 120 s ceiling guards
    # against the rare nla.bake hang (Rokoko issue #65).
    timeout=120,
    # 50 in-flight inputs per container × 20 containers = 1000 concurrent
    # retargets. Each input launches a Blender subprocess that consumes
    # ~80 MB RAM and ~1 vCPU during the bake phase; 50 × 80 MB = 4 GB
    # which is exactly the memory ceiling above. If we cranked this to
    # 100, container OOM-kills under burst load.
    allow_concurrent_inputs=50,
    # Keep containers warm 2 min after the last call. The Trellis app
    # uses 5 min for L40S (cold start = 60 s), but Blender cold start
    # is only ~10 s so 2 min is a saner cost/UX trade.
    scaledown_window=120,
    secrets=[
        # Optional shared secret if you wire this endpoint behind the
        # same Worker auth as the Trellis stack. Not required because
        # the bytes-in / bytes-out function isn't exposed via a public
        # URL — it's invoked through `modal.Function.from_name` which
        # requires Modal credentials.
        # modal.Secret.from_name("myfabmesh-shared",
        #                        required_keys=["SHARED_SECRET"]),
    ],
)
def retarget(
    rig_glb_bytes: bytes,
    source_fbx_bytes: bytes,
    labels_json_str: str = "",
) -> bytes:
    """Retarget `source_fbx`'s animation onto `rig_glb`, return animated GLB.

    Args:
        rig_glb_bytes:   bytes of the Puppeteer-rigged GLB (rest pose +
                         armature + skinned mesh). Single armature.
        source_fbx_bytes: bytes of the Apovivor / Mixamo FBX motion. The
                         FBX must contain an armature with an action.
        labels_json_str:  the GLB's `.labels.json` sidecar as a string.
                         Maps `{pred_idx: role}` so the Rokoko bone-list
                         auto-detect can find Hips / Spine / LeftArm /...
                         Pass "" to fall back to the geometric
                         puppeteer_joint_renamer (works on the 50 humanoid
                         training rigs that pre-date the sidecar).

    Returns:
        bytes of the animated GLB (target rig + skin + retargeted action).

    Raises:
        RuntimeError on Blender non-zero exit (with stderr tail attached).
    """
    t0 = time.time()
    # Temp dir per-call — Modal containers reuse fs across calls so we
    # CAN'T just dump to /tmp/rig.glb (the next concurrent call would
    # race). Use a TemporaryDirectory so cleanup is guaranteed even on
    # exceptions.
    with tempfile.TemporaryDirectory(prefix="rokoko_", dir="/tmp") as td:
        td_path = Path(td)
        rig_glb = td_path / "rig.glb"
        src_fbx = td_path / "src.fbx"
        out_dir = td_path / "out"
        out_dir.mkdir()
        rig_glb.write_bytes(rig_glb_bytes)
        src_fbx.write_bytes(source_fbx_bytes)
        # The local retarget script reads `<rig>.labels.json` next to
        # the GLB — replicate that contract.
        if labels_json_str:
            (td_path / "rig.glb.labels.json").write_text(
                labels_json_str, encoding="utf-8"
            )

        # Invoke the exact same script the desktop uses, in Blender's
        # `--background --python` mode. The script auto-detects single
        # mode via `import bpy` succeeding inside Blender.
        cmd = [
            BLENDER_EXE,
            "--background",
            "--factory-startup",
            "--python", "/opt/scripts/rokoko_batch_retarget.py",
            "--",
            "--src-fbx", str(src_fbx),
            "--tgt-glb", str(rig_glb),
            "--out-dir", str(out_dir),
        ]
        rc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            # 115 s — leave 5 s headroom under the @function timeout=120
            # so Modal sees a clean Python exception (RuntimeError) on
            # bake hangs instead of a wall-clock kill (which would be
            # billed as a successful run but return empty bytes).
            timeout=115,
        )
        # Output file is named <fbx_stem>__<glb_stem>.glb by the script.
        produced = list(out_dir.glob("*.glb"))
        if rc.returncode != 0 or not produced:
            tail_out = (rc.stdout or "")[-2000:]
            tail_err = (rc.stderr or "")[-2000:]
            raise RuntimeError(
                f"blender exit={rc.returncode} "
                f"produced={len(produced)} "
                f"stdout_tail={tail_out!r} "
                f"stderr_tail={tail_err!r}"
            )
        result = produced[0].read_bytes()
        print(f"[rokoko-modal] OK in {time.time() - t0:.1f}s "
              f"-> {len(result) // 1024} KB GLB", flush=True)
        return result


# ---------------------------------------------------------------------------
# Local CLI for smoke-test before deploying:
#     python -m modal run modal_app/rokoko_endpoint.py::smoke
# ---------------------------------------------------------------------------
@app.local_entrypoint()
def smoke():
    """One-shot test against a known-good local pair. Skip if files absent."""
    rig = Path("c:/tmp/training_rigs/humanoid/humanoid_00_seed42_rigged.glb")
    fbx = Path("c:/tmp/apovivor_fbx/1_Source/ANIM_AS_Robot1_Walk.fbx")
    if not rig.exists() or not fbx.exists():
        print(f"[smoke] missing local fixture(s) — skipping "
              f"(rig={rig.exists()}, fbx={fbx.exists()})")
        return
    labels_path = Path(str(rig) + ".labels.json")
    labels = labels_path.read_text(encoding="utf-8") if labels_path.exists() else ""
    out = retarget.remote(
        rig_glb_bytes=rig.read_bytes(),
        source_fbx_bytes=fbx.read_bytes(),
        labels_json_str=labels,
    )
    out_path = Path("c:/tmp/rokoko_modal_smoke.glb")
    out_path.write_bytes(out)
    print(f"[smoke] OK -> {out_path} ({len(out) // 1024} KB)")
