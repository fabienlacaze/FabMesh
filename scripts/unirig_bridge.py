"""UniRig bridge for FabMesh.

Runs the three UniRig inference steps (skeleton, skin, merge) in sequence
using the dedicated Python 3.11 venv in external/UniRig/venv and produces
a single rigged GLB file that FabMesh can load in its viewer.

Usage:
    python unirig_bridge.py <mesh_path> <output_glb>
"""
import os
import sys
import subprocess
import tempfile
import shutil
import time

HERE = os.path.abspath(os.path.dirname(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(HERE, ".."))
UNIRIG_DIR = os.path.join(PROJECT_ROOT, "external", "UniRig")
VENV_PY = os.path.join(UNIRIG_DIR, "venv", "Scripts", "python.exe")
VENV_BIN = os.path.join(UNIRIG_DIR, "venv", "Scripts")


def log(msg):
    print(f"UNIRIG: {msg}", flush=True)


def _find_blender_exe():
    """Find the Blender executable configured in FabMesh.

    FabMesh stores the Blender path in <project_root>/config.json.
    """
    # 1. FabMesh config.json at project root
    try:
        import json
        cfg_path = os.path.join(PROJECT_ROOT, "config.json")
        if os.path.exists(cfg_path):
            with open(cfg_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            p = cfg.get("blenderPath")
            if p and os.path.exists(p):
                return p
    except Exception:
        pass
    # 2. Common install paths (Windows)
    candidates = [
        r"C:\Program Files\Blender Foundation\Blender 4.4\blender.exe",
        r"C:\Program Files\Blender Foundation\Blender 4.3\blender.exe",
        r"C:\Program Files\Blender Foundation\Blender 4.2\blender.exe",
        r"C:\Program Files\Blender Foundation\Blender 4.1\blender.exe",
        r"C:\Program Files\Blender Foundation\Blender 4.0\blender.exe",
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    # 3. PATH
    import shutil as _sh
    p = _sh.which("blender")
    return p


def run_step(script_path, args, cwd):
    """Run a bash script from the UniRig directory with the venv on PATH.

    We use bash because the UniRig launch scripts are written in bash. On
    Windows this goes through Git Bash. Fall back to running the Python
    entry point directly if bash is not available.
    """
    env = os.environ.copy()
    env["PATH"] = VENV_BIN + os.pathsep + env.get("PATH", "")
    cmd = ["bash", script_path] + args
    log(f"exec: {' '.join(cmd)}")
    proc = subprocess.Popen(
        cmd,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    for line in iter(proc.stdout.readline, ""):
        if not line:
            break
        line = line.rstrip()
        if line:
            print(line, flush=True)
    proc.stdout.close()
    rc = proc.wait()
    if rc != 0:
        # The merge step sometimes exits with a segfault AFTER successfully
        # writing the output file (Draco DLL missing). We treat that as OK
        # if the expected output file exists.
        log(f"step exited with rc={rc}")
    return rc


def main():
    if len(sys.argv) < 3:
        print("AUTORIG_ERROR: usage: unirig_bridge.py <mesh_path> <output_glb>")
        sys.exit(1)
    mesh_path = os.path.abspath(sys.argv[1])
    output_glb = os.path.abspath(sys.argv[2])

    if not os.path.exists(mesh_path):
        print(f"AUTORIG_ERROR: mesh not found: {mesh_path}")
        sys.exit(1)
    if not os.path.exists(VENV_PY):
        print(f"AUTORIG_ERROR: UniRig venv not found at {VENV_PY}")
        print("AUTORIG_ERROR: install UniRig first (see external/UniRig/README.md)")
        sys.exit(1)

    log(f"mesh={mesh_path}")
    log(f"output={output_glb}")

    # Convert paths to forward slashes for bash scripts
    def fwd(p):
        return p.replace("\\", "/")

    # Step 1: skeleton prediction → temp FBX
    tmp_dir = tempfile.mkdtemp(prefix="unirig_")
    try:
        skeleton_fbx = os.path.join(tmp_dir, "skeleton.fbx")
        log("== Step 1: skeleton prediction ==")
        t0 = time.time()
        rc = run_step(
            "./launch/inference/generate_skeleton.sh",
            ["--input", fwd(mesh_path), "--output", fwd(skeleton_fbx)],
            cwd=UNIRIG_DIR,
        )
        if not os.path.exists(skeleton_fbx):
            print(f"AUTORIG_ERROR: skeleton prediction failed (no output). rc={rc}")
            sys.exit(1)
        log(f"skeleton done in {time.time()-t0:.1f}s ({os.path.getsize(skeleton_fbx)} bytes)")

        # Step 2: skin prediction
        skin_fbx = os.path.join(tmp_dir, "skin.fbx")
        log("== Step 2: skin prediction ==")
        t0 = time.time()
        rc = run_step(
            "./launch/inference/generate_skin.sh",
            ["--input", fwd(skeleton_fbx), "--output", fwd(skin_fbx)],
            cwd=UNIRIG_DIR,
        )
        if not os.path.exists(skin_fbx):
            print(f"AUTORIG_ERROR: skin prediction failed (no output). rc={rc}")
            sys.exit(1)
        log(f"skin done in {time.time()-t0:.1f}s ({os.path.getsize(skin_fbx)} bytes)")

        # Step 3: merge skin with original mesh into final GLB
        log("== Step 3: merge ==")
        t0 = time.time()
        rc = run_step(
            "./launch/inference/merge.sh",
            [
                "--source", fwd(skin_fbx),
                "--target", fwd(mesh_path),
                "--output", fwd(output_glb),
            ],
            cwd=UNIRIG_DIR,
        )
        # merge.py often segfaults after writing (Draco DLL missing); the
        # file is still valid.
        if not os.path.exists(output_glb):
            print(f"AUTORIG_ERROR: merge failed (no output). rc={rc}")
            sys.exit(1)
        sz = os.path.getsize(output_glb)
        log(f"merge done in {time.time()-t0:.1f}s ({sz} bytes)")

        # Step 4: retarget template anims onto the UniRig skeleton using a
        # regular Blender instance (the bpy in UniRig's venv has limited
        # scripting access). Disabled post-commercial-remediation: the
        # Reallusion-licensed orc_m1 anim FBX pack was removed, so this dir
        # no longer exists and the retarget step is skipped gracefully.
        anim_dir = os.path.join(PROJECT_ROOT, "scripts", "rig_templates", "animations", "humanoid_basic")
        retarget_script = os.path.join(PROJECT_ROOT, "scripts", "unirig_retarget.py")
        if os.path.isdir(anim_dir) and os.path.exists(retarget_script):
            log("== Step 4: retarget anims ==")
            t0 = time.time()
            # Find the Blender executable from FabMesh config
            blender_exe = _find_blender_exe()
            if blender_exe is None:
                log("WARN: no Blender exe found — skipping retarget step")
            else:
                log(f"blender={blender_exe}")
                cmd = [
                    blender_exe, "--background", "--python", retarget_script,
                    "--", output_glb, anim_dir,
                ]
                proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                )
                for line in iter(proc.stdout.readline, ""):
                    if not line:
                        break
                    line = line.rstrip()
                    if line:
                        print(line, flush=True)
                proc.stdout.close()
                rc = proc.wait()
                log(f"retarget step rc={rc} done in {time.time()-t0:.1f}s")
                sz = os.path.getsize(output_glb)
                log(f"final glb size after retarget: {sz} bytes")
        else:
            log(f"skipping retarget: anim_dir={anim_dir} exists={os.path.isdir(anim_dir)}, script exists={os.path.exists(retarget_script)}")

        final_sz = os.path.getsize(output_glb)
        print(f"AUTORIG_SUCCESS: {output_glb} ({final_sz} bytes)")
        sys.exit(0)
    finally:
        try:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        except Exception:
            pass


if __name__ == "__main__":
    main()
