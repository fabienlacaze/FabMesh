"""Modal app: AnyTop (Apache-2.0 / MIT, SIGGRAPH 2025) animation
generation, exposed via the same async spawn-poll-stream pattern as
the Puppeteer rig router.

Independent app `myfabmesh-anim`: AnyTop requires Python 3.8 + torch
2.4.1 which conflicts with the rig stack (Python 3.11 + torch 2.7).
Trying to share an image would force one or the other to break.

Endpoints exposed by `anim_router` ASGI app:
  POST /anim-start         — spawn animate_mesh() ; persists call_id
  POST /anim-status        — reload volume ; report ready/error
  POST /anim-fetch         — stream the animated GLB
  GET  /healthz            — liveness probe

Each call writes:
  /anim_data/<job_id>.glb   on success
  /anim_data/<job_id>.err   on failure (JSON with error string)
  /anim_data/<job_id>.call_id — FunctionCall object_id for cancellation

Mirrors `modal_app/_puppeteer_rig.py` 1:1 in structure; only the GPU
work inside `animate_mesh()` differs.
"""
import base64
import json
import os
import subprocess
import sys
import time
import uuid

import modal


# ============================================================
# App + Image
# ============================================================
app = modal.App("myfabmesh-anim")

# AnyTop ships requirements via environment.yaml in their repo. We
# replicate the pinned subset that matters at the python level here.
ANYTOP_REPO = "https://github.com/Anytop2025/Anytop"
ANYTOP_COMMIT = "main"  # pinned to main; bump to a SHA before prod
MOTION_LIB = "git+https://github.com/inbar-2344/Motion.git"

image = (
    # Modal's 2025.06 image builder dropped Python 3.8 (EOL). AnyTop's
    # original environment.yaml pins 3.8 + torch 2.4.1 because that's
    # what the authors tested on. We try torch 2.4.1 on Python 3.10
    # (still supported wheels) and patch any 3.8-only syntax we hit.
    modal.Image.debian_slim(python_version="3.10")
    .apt_install(
        "git", "wget", "build-essential",
        # ffmpeg + libsndfile sometimes pulled in by moviepy / imageio
        "ffmpeg", "libsndfile1",
        "libgl1", "libglib2.0-0",
    )
    .pip_install(
        "torch==2.4.1",
        "torchvision==0.19.1",
        "torchaudio==2.4.1",
        index_url="https://download.pytorch.org/whl/cu121",
    )
    .pip_install(
        "transformers==4.46.3",
        # numpy 1.24 has wheels for Python 3.10 — keep AnyTop's pinned
        # ABI to avoid downstream import errors in their utils.*
        "numpy==1.24.4",
        "scipy==1.10.1",
        "spacy==3.7.2",
        "huggingface-hub==0.30.1",
        "tokenizers==0.20.3",
        "matplotlib==3.7.5",  # 3.1.3 has no py3.10 wheel
        "pillow==10.4.0",
        "requests==2.32.3",
        "pyyaml==6.0.2",
        "sympy==1.13.3",
        "tqdm==4.67.1",
        "imageio==2.35.1",
        "moviepy==1.0.3",
        "bvhsdk>=0.2",
        "pygltflib>=1.16",
        "fastapi[standard]",
        # Imported at top of AnyTop's model/conditioners.py (T5Conditioner
        # path) even when we don't use text-to-motion. Without it,
        # sample.generate ModuleNotFoundError's before it ever loads
        # the checkpoint.
        "num2words==0.5.13",
        # T5Tokenizer.from_pretrained() requires sentencepiece — even
        # when we don't actually feed text to the model, generate.py
        # instantiates the conditioner at startup, which imports T5
        # which needs SentencePiece for its vocab.
        "sentencepiece==0.2.0",
    )
    .pip_install(MOTION_LIB)
    # Clone the AnyTop repo into the container.
    .run_commands(
        f"git clone {ANYTOP_REPO} /AnyTop && cd /AnyTop && git checkout {ANYTOP_COMMIT}",
    )
    # Pre-download the checkpoint snapshot to bake it into the image
    # (avoids a 30-60s cold-start hit fetching ~120 MB on every container).
    .run_commands(
        "cd /AnyTop && python -m utils.download_dependencies || "
        "(echo 'WARN: download_dependencies failed at build, will retry at runtime' && true)",
    )
    # Embed our own glTF helpers + BVH→glTF converter so the GPU function
    # can do all post-processing inline (no extra Modal hop).
    .add_local_file(
        "scripts/bvh_to_gltf_anim.py",
        remote_path="/tmp/bvh_to_gltf_anim.py",
    )
    .add_local_file(
        "scripts/puppeteer_to_skeleton.py",
        remote_path="/tmp/puppeteer_to_skeleton.py",
    )
)

anim_output_volume = modal.Volume.from_name(
    "myfabmesh-anim-output", create_if_missing=True,
)

# Mount our helper scripts so /tmp imports work inside animate_mesh.
ANYTOP_DIR = "/AnyTop"
HELPERS = ["/tmp/bvh_to_gltf_anim.py", "/tmp/puppeteer_to_skeleton.py"]


# ============================================================
# Logging utility (mirrors _puppeteer_rig.py)
# ============================================================
def _log(msg: str) -> None:
    print(f"[anim] {msg}", flush=True)


# ============================================================
# Skeleton extraction from a Puppeteer GLB
# ============================================================
def _extract_bvh_from_glb(glb_path: str, out_bvh: str, n_frames: int = 30,
                          perturb: bool = False) -> None:
    """Read a Puppeteer-rigged GLB and write a BVH the AnyTop pipeline
    can ingest. Per-joint Euler order defaults to ZXY.

    n_frames controls how many T-pose frames are emitted:
      - 1  → use as --tpos_bvh (the reference rest pose)
      - 30 → use as the motion file inside --bvh_dir

    perturb=True adds tiny per-frame Gaussian jitter (≈0.5°) on every
    non-root rotation channel. AnyTop's diffusion sampler trains on
    motion variance; a strictly-zero motion BVH makes Mean/Std collapse
    to (0, 0) and the sampler outputs identity rotations everywhere
    (mesh stays frozen). Tpos stays unperturbed (it's the rest reference).
    """
    import numpy as np
    sys.path.insert(0, "/tmp")
    from puppeteer_to_skeleton import _read_glb, _read_accessor  # type: ignore
    gltf, _json_blob, bin_blob, _tail = _read_glb(glb_path)
    skins = gltf.get("skins") or []
    if not skins:
        raise RuntimeError("GLB has no skin (no skeleton to extract)")
    skin = skins[0]
    joint_idxs = skin["joints"]
    nodes = gltf["nodes"]
    name_by_idx = {i: (nodes[i].get("name") or f"joint_{i}") for i in joint_idxs}
    parent_by_idx = {i: -1 for i in joint_idxs}
    for parent_idx in joint_idxs:
        for child in (nodes[parent_idx].get("children") or []):
            if child in joint_idxs:
                parent_by_idx[child] = parent_idx
    root = next((i for i in joint_idxs if parent_by_idx[i] == -1), joint_idxs[0])

    # Compute WORLD bind positions from inverseBindMatrices.
    # ibm = inverse(joint_to_world_bind) -> joint_to_world_bind = inverse(ibm).
    # The translation column of that matrix is the joint's world position
    # in the bind pose. Puppeteer GLBs don't set node.translation on joints
    # (the rest pose lives entirely in inverseBindMatrices), so we MUST
    # use this — otherwise every BVH OFFSET is zero and AnyTop's
    # process_skeleton collapses the skeleton to the origin and crashes
    # with IndexError on an empty t_pos_motion.
    ibm_acc = skin.get("inverseBindMatrices")
    world_by_idx = {}
    if ibm_acc is not None:
        ibm_flat = _read_accessor(gltf, bin_blob, ibm_acc)
        ibm_mats = np.asarray(ibm_flat).reshape(len(joint_idxs), 4, 4)
        # glTF stores matrices in COLUMN-major order; numpy is row-major.
        # Transpose each 4x4 so the translation lives at mat[:3, 3].
        ibm_mats = np.transpose(ibm_mats, (0, 2, 1))
        for k, jidx in enumerate(joint_idxs):
            try:
                world_mat = np.linalg.inv(ibm_mats[k])
                world_by_idx[jidx] = world_mat[:3, 3]
            except Exception:
                world_by_idx[jidx] = np.array([0.0, 0.0, 0.0])
    # Fallback for joints with no IBM (rare): use node.translation.
    for jidx in joint_idxs:
        if jidx not in world_by_idx:
            tr = nodes[jidx].get("translation") or [0.0, 0.0, 0.0]
            world_by_idx[jidx] = np.asarray(tr, dtype=np.float32)

    lines = ["HIERARCHY"]
    _emit_bvh_node(
        root, joint_idxs, parent_by_idx, name_by_idx, nodes, world_by_idx,
        indent=0, lines=lines, is_root=True,
    )

    # Emit n_frames of T-pose. perturb=False writes strict zeros (for
    # tpos_bvh). perturb=True adds ~0.5° Gaussian jitter on non-root
    # rotation channels so AnyTop's Mean/Std doesn't collapse to 0.
    # Root channels (0..5 = Xpos Ypos Zpos Zrot Xrot Yrot) stay 0 so
    # the character doesn't drift or spin from the perturbation alone.
    n_joints = sum(1 for _ in joint_idxs)
    n_chans_per_frame = 6 + 3 * (n_joints - 1)  # root has 6, others 3
    lines += [
        "MOTION",
        f"Frames: {int(n_frames)}",
        "Frame Time: 0.033333",
    ]
    if not perturb:
        zero_frame = " ".join(["0"] * n_chans_per_frame)
        lines += [zero_frame for _ in range(int(n_frames))]
    else:
        rng = np.random.default_rng(seed=42)  # deterministic per-job
        for _ in range(int(n_frames)):
            chans = [0.0] * 6  # root stays clean
            if n_chans_per_frame > 6:
                chans += rng.normal(0.0, 0.5, size=n_chans_per_frame - 6).tolist()
            lines.append(" ".join(f"{c:.6f}" for c in chans))
    with open(out_bvh, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def _emit_bvh_node(node_idx, joint_idxs, parent_by_idx, name_by_idx, nodes,
                   world_by_idx, indent: int, lines: list, is_root: bool) -> None:
    import numpy as np
    pad = "  " * indent
    name = name_by_idx[node_idx]
    keyword = "ROOT" if is_root else "JOINT"
    lines.append(f"{pad}{keyword} {name}")
    lines.append(f"{pad}{{")
    # OFFSET = joint_world - parent_world (parent-relative).
    # For ROOT, OFFSET is its absolute world position (since there's no parent).
    world = world_by_idx.get(node_idx, np.array([0.0, 0.0, 0.0]))
    if is_root:
        offset = world
    else:
        parent_idx = parent_by_idx.get(node_idx, -1)
        parent_world = world_by_idx.get(parent_idx, np.array([0.0, 0.0, 0.0]))
        offset = world - parent_world
    lines.append(f"{pad}  OFFSET {float(offset[0])} {float(offset[1])} {float(offset[2])}")
    if is_root:
        lines.append(f"{pad}  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation")
    else:
        lines.append(f"{pad}  CHANNELS 3 Zrotation Xrotation Yrotation")
    kids = [c for c in (nodes[node_idx].get("children") or [])
            if c in joint_idxs]
    has_kids = False
    for c in kids:
        _emit_bvh_node(c, joint_idxs, parent_by_idx, name_by_idx, nodes,
                       world_by_idx, indent + 1, lines, is_root=False)
        has_kids = True
    if not has_kids:
        # End Site (required by BVH spec for leaf joints).
        # Give it a small non-zero offset along the parent->joint axis
        # so AnyTop's IK has something to work with even on leaves.
        lines.append(f"{pad}  End Site")
        lines.append(f"{pad}  {{")
        lines.append(f"{pad}    OFFSET 0 0.1 0")
        lines.append(f"{pad}  }}")
    lines.append(f"{pad}}}")


# ============================================================
# GPU function — runs AnyTop sample.generate + BVH→GLB embed
# ============================================================
@app.function(
    image=image,
    gpu="A10G",
    timeout=600,
    volumes={"/anim_data": anim_output_volume},
)
def animate_mesh(
    rig_glb_bytes: bytes,
    anim_type: str = "idle",
    prompt: str = "",
    job_id: str = "",
) -> int:
    """Generate a new animation clip on the given Puppeteer-rigged GLB.

    Writes /anim_data/<job_id>.glb on success, /anim_data/<job_id>.err
    on failure. Returns the number of bytes written.
    """
    if not job_id:
        job_id = uuid.uuid4().hex
    out_path = f"/anim_data/{job_id}.glb"
    err_path = f"/anim_data/{job_id}.err"

    work_dir = f"/tmp/anim_{job_id}"
    # AnyTop's process_object does:
    #   bvh_files = os.listdir(bvh_dir)
    #   bvh_files.remove(os.path.basename(t_pos_path))
    #   for f in bvh_files: ...
    # If both files share the same dir AND tpos basename matches one
    # of them, the loop iterates empty → exit 1. To keep them in the
    # same work_dir (cheaper than subdirs, no path arg explosion) we
    # write DIFFERENT basenames: tpos.bvh (1 frame) + idle.bvh (30
    # frames). listdir → ['tpos.bvh', 'idle.bvh']; remove tpos.bvh
    # → ['idle.bvh']; the motion loop runs.
    os.makedirs(work_dir, exist_ok=True)
    rig_path = os.path.join(work_dir, "rig.glb")
    tpos_bvh = os.path.join(work_dir, "tpos.bvh")    # 1-frame ref pose
    motion_bvh = os.path.join(work_dir, "idle.bvh")  # 30-frame motion
    bvh_anim = os.path.join(work_dir, "anim.bvh")

    sys.path.insert(0, "/tmp")
    sys.path.insert(0, ANYTOP_DIR)

    t0 = time.time()
    try:
        _log(f"job_id={job_id} anim_type={anim_type} prompt={prompt[:60]!r}")
        with open(rig_path, "wb") as f:
            f.write(rig_glb_bytes)

        # ── Step 1: extract BVH skeleton from the GLB ─────────────
        # Two BVH files with DIFFERENT names. Both 30 frames so
        # AnyTop's tpos_first_frame indexing doesn't crash. CRITICAL:
        # motion_bvh gets perturb=True so AnyTop's diffusion sampler
        # sees non-zero Mean/Std and outputs a real animation. Without
        # this the sampler degenerates to identity rotations and the
        # mesh stays frozen on its rest pose.
        _log("step 1: extracting BVH skeleton (tpos clean + idle perturbed)")
        _extract_bvh_from_glb(rig_path, tpos_bvh, n_frames=30, perturb=False)
        _extract_bvh_from_glb(rig_path, motion_bvh, n_frames=30, perturb=True)

        # ── Step 2: preprocess for AnyTop (process_new_skeleton) ──
        # process_new_skeleton needs face_joints_names. We pick from
        # the actual BVH joint names so the heuristic never returns a
        # label that doesn't exist.
        face_joints = _guess_face_joints(motion_bvh)
        skel_name = f"job_{job_id[:8]}"
        ds_dir = os.path.join(ANYTOP_DIR, "dataset", "truebones", "zoo", skel_name)
        os.makedirs(ds_dir, exist_ok=True)
        cmd = [
            sys.executable, "-m", "utils.process_new_skeleton",
            "--object_name", skel_name,
            "--bvh_dir", work_dir,
            "--save_dir", ds_dir,
            "--face_joints_names", *face_joints,
            "--tpos_bvh", tpos_bvh,
        ]
        _log(f"step 2: {' '.join(cmd)}")
        rc = _run_subprocess(cmd, cwd=ANYTOP_DIR)
        if rc != 0:
            raise RuntimeError(f"process_new_skeleton exit {rc}")

        # ── Step 3: pick a checkpoint based on anim_type ──────────
        ckpt_name = _pick_checkpoint(anim_type)
        ckpt = _resolve_checkpoint_path(ckpt_name)
        if not ckpt:
            raise RuntimeError(f"checkpoint not found: {ckpt_name}")
        # ── Step 4: sample.generate ───────────────────────────────
        # --object_type MUST equal --object_name from process_new_skeleton:
        # sample.generate looks up cond_dict[object_type]['parents'] in
        # OUR cond.npy (which has only ONE key — the skel_name we wrote
        # in step 2). The 70-class param_utils.py registry is for
        # AnyTop's training-time skeleton lookup, not the runtime
        # condition dict — passing 'Ostrich' or 'Dragon' here triggers
        # KeyError on cond_dict because that class wasn't written by
        # OUR process_new_skeleton run.
        cmd = [
            sys.executable, "-m", "sample.generate",
            "--model_path", ckpt,
            "--object_type", skel_name,
            "--cond_path", os.path.join(ds_dir, "cond.npy"),
            "--num_repetitions", "1",
            "--motion_length", "5.0",
            "--device", "0",
        ]
        _log(f"step 4: {' '.join(cmd)}")
        rc = _run_subprocess(cmd, cwd=ANYTOP_DIR)
        if rc != 0:
            raise RuntimeError(f"sample.generate exit {rc}")
        # AnyTop writes outputs under save/<ckpt_dir>/samples_*/<...>.bvh
        gen_bvh = _find_latest_bvh(ckpt)
        if not gen_bvh or not os.path.isfile(gen_bvh):
            raise RuntimeError("sample.generate produced no BVH")
        os.replace(gen_bvh, bvh_anim)
        _log(f"step 4 done: bvh={bvh_anim} ({os.path.getsize(bvh_anim)} bytes)")

        # ── Step 5: BVH → glTF animation tracks injected in rig ───
        from bvh_to_gltf_anim import bvh_to_gltf_anim  # type: ignore
        _log("step 5: embedding BVH as glTF tracks on the rig GLB")
        bvh_to_gltf_anim(
            rig_path, bvh_anim, out_path,
            clip_name=anim_type or "clip",
            target_fps=30.0,
        )
        sz = os.path.getsize(out_path)
        _log(f"DONE dt={time.time()-t0:.1f}s out_bytes={sz}")
        anim_output_volume.commit()
        return sz
    except Exception as e:
        import traceback
        err_msg = {
            "error": str(e),
            "type": type(e).__name__,
            "trace": traceback.format_exc()[:4000],
        }
        try:
            with open(err_path, "w") as f:
                json.dump(err_msg, f)
            anim_output_volume.commit()
        except Exception as we:
            _log(f"failed writing .err sentinel: {we}")
        _log(f"FAILED {type(e).__name__}: {e}")
        raise


# ============================================================
# Helpers — checkpoint picker, BVH discovery, subprocess runner
# ============================================================
_CHECKPOINTS = {
    "all": "all_model_dataset_truebones_bs_16_latentdim_128",
    "bipeds": "bipeds_model_dataset_truebones_bs_16_latentdim_128",
    "quadropeds": "quadropeds_model_dataset_truebones_bs_16_latentdim_128",
    "millipeds_snakes": "millipeds_snakes_model_dataset_truebones_bs_16_latentdim_128",
    "flying": "flying_model_dataset_truebones_bs_16_latentdim_128",
}


def _pick_checkpoint(anim_type: str) -> str:
    """Map a user-facing anim_type ('walk', 'fly', 'attack', etc.) to
    one of the 5 AnyTop checkpoint families."""
    t = (anim_type or "").lower()
    if any(k in t for k in ("fly", "wing", "soar", "glide")):
        return "flying"
    if any(k in t for k in ("crawl", "snake", "slither")):
        return "millipeds_snakes"
    if any(k in t for k in ("quad", "wolf", "dog", "horse", "cat")):
        return "quadropeds"
    if any(k in t for k in ("idle", "walk", "run", "attack", "death", "humanoid", "biped")):
        return "bipeds"
    return "all"


# Map each checkpoint family to ONE canonical AnyTop class the model
# was trained on. The class embedding registry lives in AnyTop's
# data_loaders/truebones/truebones_utils/param_utils.py — 70 classes
# total. Passing our synthetic skel_name ('job_<hex>') as --object_type
# silently produces a zero/garbage embedding because the lookup misses,
# so the diffusion sampler conditions on nothing → degenerate output
# (or KeyError, depending on how the lookup is done).
# Picked class per family is the most "neutral" one for retargeting:
#   bipeds   → Ostrich  (vertical biped, no T-Rex tail bias)
#   quadropeds → Horse  (well-trained, balanced quadruped gait)
#   millipeds_snakes → Spider (most-used in TruBones tests)
#   flying   → Dragon  (winged biped — closest topology to our rigged dragons)
#   all      → Flamingo (AnyTop's argparse default)
_OBJECT_TYPE_BY_FAMILY = {
    "bipeds": "Ostrich",
    "quadropeds": "Horse",
    "millipeds_snakes": "Spider",
    "flying": "Dragon",
    "all": "Flamingo",
}


def _pick_object_type(ckpt_family: str) -> str:
    """Pick the --object_type class string the AnyTop checkpoint was
    actually trained on. Falls back to Flamingo (AnyTop default)."""
    return _OBJECT_TYPE_BY_FAMILY.get(ckpt_family, "Flamingo")


def _resolve_checkpoint_path(ckpt_family: str) -> str:
    folder = _CHECKPOINTS.get(ckpt_family) or _CHECKPOINTS["all"]
    save_dir = os.path.join(ANYTOP_DIR, "save", folder)
    if not os.path.isdir(save_dir):
        return ""
    # Pick the .pt with the largest step count.
    best = ""
    best_step = -1
    for fn in os.listdir(save_dir):
        if not fn.startswith("model") or not fn.endswith(".pt"):
            continue
        try:
            step = int(fn.replace("model", "").replace(".pt", ""))
            if step > best_step:
                best_step = step
                best = os.path.join(save_dir, fn)
        except ValueError:
            continue
    return best


def _find_latest_bvh(ckpt_path: str) -> str:
    """AnyTop writes outputs alongside the checkpoint dir."""
    ckpt_dir = os.path.dirname(ckpt_path)
    # Walk samples_*/<...>.bvh subdirs
    best = ""
    best_mtime = -1.0
    for root, _, files in os.walk(ckpt_dir):
        for fn in files:
            if fn.endswith(".bvh"):
                p = os.path.join(root, fn)
                try:
                    mt = os.path.getmtime(p)
                    if mt > best_mtime:
                        best_mtime = mt
                        best = p
                except OSError:
                    continue
    return best


def _guess_face_joints(bvh_path: str) -> list:
    """Pick 4 joints from the BVH that define the skeleton's facing
    plane (AnyTop's `--face_joints_names` arg). AnyTop expects 4 ACTUAL
    joint names that exist in the skeleton — at
    motion_process.py:115 it does `[t_pos_names.index(n) for n in face_joints]`
    and raises ValueError on any missing name.

    The Puppeteer skeleton predicts bones with arbitrary anatomical names
    (e.g. `spine_0`, `wing_l_1`, `leg_r_2`, `tail_3`). The heuristic must
    therefore be flexible enough to also match wing / tail / spine
    patterns. If we still can't find LR markers, fall back to the first
    4 unique joint names from the BVH (NEVER 'root' — that's a literal
    string that doesn't appear in Puppeteer output)."""
    all_joints: list = []
    with open(bvh_path, "r", encoding="utf-8", errors="ignore") as f:
        for ln in f:
            ln = ln.strip()
            if not ln.startswith(("JOINT ", "ROOT ")):
                continue
            name = ln.split(maxsplit=1)[1]
            if name not in all_joints:
                all_joints.append(name)
    if not all_joints:
        raise RuntimeError("BVH has no joints — skeleton extraction failed")

    # Patterns expanded to cover bipeds AND dragons / quadrupeds / wings.
    # The 'L' / 'R' detection looks for explicit side markers.
    def is_left(nl: str) -> bool:
        return any(t in nl for t in ("_l_", "_l.", "left", "_l ", "_lf", "l_"))
    def is_right(nl: str) -> bool:
        return any(t in nl for t in ("_r_", "_r.", "right", "_r ", "_rt", "r_"))

    leg_l, leg_r, arm_l, arm_r = [], [], [], []
    for n in all_joints:
        nl = n.lower()
        if any(t in nl for t in ("thigh", "leg", "hip", "hindleg", "rearleg", "femur")):
            (leg_l if is_left(nl) else leg_r if is_right(nl) else []).append(n)
        elif any(t in nl for t in ("shoulder", "arm", "wing", "forearm", "scapula", "clavicle", "humerus", "elbow", "foreleg", "frontleg")):
            (arm_l if is_left(nl) else arm_r if is_right(nl) else []).append(n)

    out: list = []
    if leg_r: out.append(leg_r[0])
    if leg_l: out.append(leg_l[0])
    if arm_r: out.append(arm_r[0])
    if arm_l: out.append(arm_l[0])

    # If we couldn't find 4 LR-markered joints, fall back to the first 4
    # DISTINCT joint names from the BVH. Better an arbitrary face plane
    # (motion may look wonky) than a hard crash on missing 'root'.
    if len(out) < 4:
        for n in all_joints:
            if n not in out:
                out.append(n)
                if len(out) >= 4:
                    break
    # Last-resort: if still <4 (very small skeleton?), pad with the
    # first joint name. Avoids argparse / list-index errors.
    while len(out) < 4 and all_joints:
        out.append(all_joints[0])
    return out[:4]


def _run_subprocess(cmd, cwd=None) -> int:
    p = subprocess.Popen(
        cmd, cwd=cwd,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
    )
    for line in p.stdout:  # type: ignore[union-attr]
        sys.stdout.write(line)
        sys.stdout.flush()
    return p.wait()


# ============================================================
# ASGI router exposing the async spawn / poll / fetch endpoints
# ============================================================
@app.function(
    image=image,
    cpu=1,
    timeout=120,
    volumes={"/anim_data": anim_output_volume},
    secrets=[modal.Secret.from_name("myfabmesh-shared", required_keys=["SHARED_SECRET"])],
)
@modal.asgi_app()
def anim_router():
    from fastapi import FastAPI, HTTPException, Request
    from fastapi.responses import JSONResponse, FileResponse
    import urllib.request

    api = FastAPI(title="myfabmesh-anim router")

    async def _read_json(request: Request):
        try:
            return await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="invalid JSON body")

    def _check_auth(payload: dict) -> None:
        # Modal injects SHARED_SECRET from the myfabmesh-shared secret.
        # The Worker forwards env.MODAL_SHARED_SECRET in the body as
        # `_auth`. Names match the existing _puppeteer_rig.py convention.
        expected = os.environ.get("SHARED_SECRET", "")
        if not expected:
            return
        if str(payload.get("_auth") or "") != expected:
            raise HTTPException(status_code=401, detail="auth")

    @api.get("/healthz")
    async def healthz():
        return {"ok": True, "fn": "anim_router"}

    @api.post("/anim-start")
    async def anim_start(request: Request):
        payload = await _read_json(request)
        _check_auth(payload)
        op = (payload.get("op_type") or "").strip().lower()
        if op == "cancel":
            jid = (payload.get("job_id") or "").strip()
            call_id_path = f"/anim_data/{jid}.call_id"
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
        if not rig_url:
            raise HTTPException(status_code=400, detail="rig_url required")
        anim_type = (payload.get("anim_type") or "idle").strip().lower()
        prompt = (payload.get("prompt") or "").strip()
        try:
            req = urllib.request.Request(
                rig_url, headers={"User-Agent": "myfabmesh-anim/1.0"},
            )
            with urllib.request.urlopen(req, timeout=60) as resp:
                in_bytes = resp.read()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"rig fetch failed: {e}")
        if not in_bytes or in_bytes[:4] != b"glTF":
            raise HTTPException(status_code=400, detail="rig_url did not return a GLB")
        job_id = (payload.get("job_id") or "").strip() or uuid.uuid4().hex
        call = animate_mesh.spawn(in_bytes, anim_type, prompt, job_id=job_id)
        try:
            with open(f"/anim_data/{job_id}.call_id", "w") as f:
                f.write(call.object_id)
            anim_output_volume.commit()
        except Exception as e:
            print(f"[anim-start] WARN persist call_id {job_id}: {e}", flush=True)
        return {"job_id": job_id, "status": "queued"}

    @api.post("/anim-status")
    async def anim_status(request: Request):
        payload = await _read_json(request)
        _check_auth(payload)
        job_id = (payload.get("job_id") or "").strip()
        if not job_id:
            raise HTTPException(status_code=400, detail="job_id required")
        anim_output_volume.reload()
        out_path = f"/anim_data/{job_id}.glb"
        err_path = f"/anim_data/{job_id}.err"
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
            return JSONResponse({"ready": True, "bytes": sz, "fetch_endpoint": "/anim-fetch"})
        return JSONResponse({"ready": False})

    @api.post("/anim-fetch")
    async def anim_fetch(request: Request):
        payload = await _read_json(request)
        _check_auth(payload)
        job_id = (payload.get("job_id") or "").strip()
        if not job_id or "/" in job_id or ".." in job_id:
            raise HTTPException(status_code=400, detail="job_id required (hex-ish)")
        anim_output_volume.reload()
        out_path = f"/anim_data/{job_id}.glb"
        err_path = f"/anim_data/{job_id}.err"
        if os.path.isfile(err_path):
            raise HTTPException(status_code=410, detail="animation failed; see /anim-status")
        if not os.path.isfile(out_path):
            raise HTTPException(status_code=404, detail="animation not ready yet")
        return FileResponse(out_path,
                            media_type="model/gltf-binary",
                            filename=f"{job_id}.glb")

    return api
