"""Thin client wrapper around the `myfabmesh-rokoko` Modal endpoint.

The Electron `src/main/main.js` spawns this as a CPython subprocess:

    node:  spawn('python', [path/to/rokoko_client.py,
                            '--rig', 'C:/tmp/rig.glb',
                            '--fbx', 'C:/tmp/walk.fbx',
                            '--out', 'C:/tmp/out.glb'])

We DON'T import this from Node directly (Modal SDK has C deps that
break electron-builder packaging). Stay in CPython; main.js routes the
stdin/stdout.

Exit codes:
    0  success, GLB written to --out
    2  bad CLI args
    3  network / auth failure after 1 retry  -> caller falls back local
    4  remote raised (Blender returned non-zero on Modal side)
    5  output file write error
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path


def _run_remote(rig_path: Path, fbx_path: Path, labels_path: Path | None,
                out_path: Path, timeout_s: int = 180) -> int:
    """Invoke the Modal function. Returns process exit code."""
    try:
        import modal
    except ImportError:
        print("[rokoko-client] modal package not installed "
              "(`pip install modal`)", file=sys.stderr)
        return 3

    # `from_name` is a pure metadata lookup — fast, doesn't spawn a
    # container. The actual cold-start happens on the first .remote() call.
    try:
        fn = modal.Function.from_name("myfabmesh-rokoko", "retarget")
    except Exception as e:
        print(f"[rokoko-client] from_name failed: {e}", file=sys.stderr)
        return 3

    rig_bytes = rig_path.read_bytes()
    fbx_bytes = fbx_path.read_bytes()
    labels_str = ""
    if labels_path and labels_path.exists():
        labels_str = labels_path.read_text(encoding="utf-8")

    # One retry on network/transient failures. Modal raises
    # `modal.exception.RemoteError` for actual remote exceptions and
    # generic OSError/HTTPException for connectivity blips. We only
    # retry the latter — if the Blender subprocess on Modal side failed
    # (bad rig topology, FBX without armature, etc.) retrying is pointless.
    for attempt in (1, 2):
        t0 = time.time()
        try:
            # Modal SDK call. `.remote()` accepts keyword args matching
            # the function signature exactly — we pass bytes inline
            # (Modal handles the transparent upload over gRPC; up to
            # ~100 MB inputs are fine for the 1-5 MB rig + FBX payloads).
            result = fn.remote(
                rig_glb_bytes=rig_bytes,
                source_fbx_bytes=fbx_bytes,
                labels_json_str=labels_str,
            )
        except Exception as e:
            # Distinguish remote-side failure vs network failure by class
            # name (Modal's exception hierarchy varies across SDK versions).
            kind = type(e).__name__
            is_remote = (
                "RemoteError" in kind
                or "FunctionTimeoutError" in kind
                or "InvocationError" in kind
            )
            print(f"[rokoko-client] attempt {attempt} failed "
                  f"({kind}): {e}", file=sys.stderr)
            if is_remote:
                # Don't retry remote-side failures — they're deterministic
                # given the same inputs.
                return 4
            if attempt == 2:
                return 3
            time.sleep(2.0)
            continue

        # Success. Write GLB to disk.
        try:
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_bytes(result)
        except OSError as e:
            print(f"[rokoko-client] failed to write {out_path}: {e}",
                  file=sys.stderr)
            return 5
        dur = time.time() - t0
        print(f"[rokoko-client] OK -> {out_path} ({len(result) // 1024} KB, "
              f"{dur:.1f}s)")
        return 0
    return 3


def main() -> int:
    ap = argparse.ArgumentParser(description="Modal Rokoko retarget client")
    ap.add_argument("--rig", required=True, help="path to rigged GLB")
    ap.add_argument("--fbx", required=True, help="path to source FBX motion")
    ap.add_argument(
        "--labels", default=None,
        help="path to rig.glb.labels.json (default: <rig>.labels.json next "
             "to rig); pass empty string to disable",
    )
    ap.add_argument("--out", required=True, help="output GLB path")
    ap.add_argument("--timeout", type=int, default=180,
                    help="overall client timeout in seconds (default 180)")
    args = ap.parse_args()

    rig = Path(args.rig)
    fbx = Path(args.fbx)
    out = Path(args.out)
    if not rig.exists():
        print(f"[rokoko-client] --rig not found: {rig}", file=sys.stderr)
        return 2
    if not fbx.exists():
        print(f"[rokoko-client] --fbx not found: {fbx}", file=sys.stderr)
        return 2

    if args.labels == "":
        labels = None
    elif args.labels:
        labels = Path(args.labels)
    else:
        # Default: look for <rig>.labels.json next to the GLB.
        labels = Path(str(rig) + ".labels.json")
        if not labels.exists():
            labels = None

    return _run_remote(rig, fbx, labels, out, timeout_s=args.timeout)


if __name__ == "__main__":
    sys.exit(main())
