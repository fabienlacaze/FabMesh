"""SkinTokens bridge for FabMesh — native-skeleton auto-rigging.

Runs the SkinTokens (TokenRig, VAST-AI, MIT) inference in its dedicated venv and
produces a single rigged GLB (skeleton + per-vertex skin weights, native
skeleton) that FabMesh loads in its viewer. Same CLI contract as
``puppeteer_bridge.py`` / ``unirig_bridge.py`` so the caller stays engine-agnostic:

    python skintokens_bridge.py <mesh_path> <output_glb>

Runtime notes (Windows / RTX 5080 sm_120):
  - SkinTokens runs on torch 2.7 cu128 with an SDPA attention path (no flash-attn
    build, no Smart App Control block). See external/SkinTokens/flash_attn_interface.py
    and the attn_implementation="sdpa" patches.
  - The dedicated venv is resolved from FABMESH_SKINTOKENS_PY, then a short-path
    default, then an in-tree venv. Kept out of the deep repo path because pip's
    long jupyter/labextension file names overflow Windows MAX_PATH under it.
"""
import os
import sys
import subprocess

HERE = os.path.abspath(os.path.dirname(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(HERE, ".."))
SKINTOKENS_DIR = os.path.join(PROJECT_ROOT, "external", "SkinTokens")


def _resolve_python():
    # 1. explicit override
    p = os.environ.get("FABMESH_SKINTOKENS_PY")
    if p and os.path.exists(p):
        return p
    # 2. short-path venv (avoids Windows long-path pip failures)
    for c in (r"C:\tmp\skv\Scripts\python.exe", r"C:\skv\Scripts\python.exe"):
        if os.path.exists(c):
            return c
    # 3. in-tree venv (if a future installer places it there)
    intree = os.path.join(SKINTOKENS_DIR, "venv", "Scripts", "python.exe")
    if os.path.exists(intree):
        return intree
    return None


def log(msg):
    print(f"SKINTOKENS: {msg}", flush=True)


def main():
    if len(sys.argv) < 3:
        print("AUTORIG_ERROR: usage: skintokens_bridge.py <mesh_path> <output_glb>")
        sys.exit(1)
    mesh_path = os.path.abspath(sys.argv[1])
    output_glb = os.path.abspath(sys.argv[2])

    if not os.path.exists(mesh_path):
        print(f"AUTORIG_ERROR: mesh not found: {mesh_path}")
        sys.exit(1)

    venv_py = _resolve_python()
    if not venv_py:
        print("AUTORIG_ERROR: SkinTokens venv not found (set FABMESH_SKINTOKENS_PY "
              "or install the rig engine).")
        sys.exit(1)

    demo = os.path.join(SKINTOKENS_DIR, "demo.py")
    if not os.path.exists(demo):
        print(f"AUTORIG_ERROR: SkinTokens not installed at {SKINTOKENS_DIR}")
        sys.exit(1)

    os.makedirs(os.path.dirname(output_glb), exist_ok=True)
    # --use_transfer keeps the original texture on the rigged mesh.
    cmd = [venv_py, demo, "--input", mesh_path, "--output", output_glb, "--use_transfer"]
    log(f"python={venv_py}")
    log(f"exec: {' '.join(cmd)}")

    proc = subprocess.Popen(
        cmd, cwd=SKINTOKENS_DIR,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
    )
    for line in iter(proc.stdout.readline, ""):
        line = line.rstrip()
        if line:
            print(line, flush=True)
    proc.stdout.close()
    rc = proc.wait()

    if not os.path.exists(output_glb):
        print(f"AUTORIG_ERROR: SkinTokens produced no output (rc={rc}). "
              f"Meshes with no natural skeleton (mechanical objects) are rejected.")
        sys.exit(1)
    print(f"AUTORIG_SUCCESS: {output_glb} ({os.path.getsize(output_glb)} bytes)")
    sys.exit(0)


if __name__ == "__main__":
    main()
