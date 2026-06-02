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
import re
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
    .add_local_file(
        "scripts/anytop_retarget.py",
        remote_path="/tmp/anytop_retarget.py",
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
def _detect_topology_family(joint_idxs, parent_by_idx, world_by_idx) -> str:
    """Return one of 'flying' / 'quadropeds' / 'bipeds' / 'all' based on
    the skin topology alone. Used to pre-classify the AnyTop ckpt
    family WITHOUT relying on the upstream prompt / asset_family hint
    (which is empty in current cloud anim payloads).

    Heuristic on root-children chains:
      * count "upper" chains (tips above root → wings/arms)
      * count "lower" chains (tips below root → legs)
      * count chains with significant FORWARD extent + low UP   → tail/spine
      * if upper_count >= 2 AND those upper chains are LONG    → flying
      * if lower_count >= 4                                    → quadropeds
      * if lower_count == 2                                    → bipeds
      * else                                                   → 'all'
    """
    import numpy as np
    if not joint_idxs:
        return 'all'
    pos = {ji: np.asarray(world_by_idx.get(ji, [0.0, 0.0, 0.0]), dtype=np.float32)
           for ji in joint_idxs}
    arr = np.array([pos[ji] for ji in joint_idxs])
    bb_min, bb_max = arr.min(axis=0), arr.max(axis=0)
    size = bb_max - bb_min
    up_axis, side_axis, fwd_axis = 1, 0, 2  # see _anatomical_names
    body_h = max(float(size[up_axis]), 1e-6)
    body_s = max(float(size[side_axis]), 1e-6)
    UP = lambda v: float(v[up_axis])
    SIDE = lambda v: float(v[side_axis])

    children = {ji: [] for ji in joint_idxs}
    for ji in joint_idxs:
        p = parent_by_idx.get(ji, -1)
        if p in children:
            children[p].append(ji)
    roots = [ji for ji in joint_idxs if parent_by_idx.get(ji, -1) not in joint_idxs]
    root = roots[0] if roots else joint_idxs[0]
    branchy = [r for r in roots if len(children[r]) >= 2]
    if branchy:
        root = min(branchy, key=lambda r: UP(pos[r]))

    def descendants(ji):
        out, stack = [], list(children[ji])
        while stack:
            x = stack.pop()
            out.append(x)
            stack.extend(children[x])
        return out
    def longest_chain(ji):
        chain = [ji]
        cur = ji
        while children[cur]:
            cur = max(children[cur], key=lambda c: len(descendants(c)))
            chain.append(cur)
        return chain

    # 2026-06-02 fix #3: walk the WHOLE spine chain, not just children
    # of root. Dragon wings attach to mid/upper spine (shoulder area),
    # not directly to the pelvis — the previous root-only iteration
    # never saw them and topology_family kept returning 'all'.
    root_y = UP(pos[root])
    root_side = SIDE(pos[root])
    # Find the main spine = longest on-axis upward chain from root.
    spine_chain = []
    cur = root
    seen = {root}
    while children[cur]:
        # next bone on axis (small lateral span, going up or flat)
        on_axis = [c for c in children[cur]
                   if abs(SIDE(pos[c]) - root_side) <= max(body_s * 0.10, 1e-3)
                   and (UP(pos[c]) >= UP(pos[cur]) - body_h * 0.05)]
        if not on_axis:
            break
        nxt = max(on_axis, key=lambda c: len(descendants(c)))
        if nxt in seen:
            break
        spine_chain.append(nxt)
        seen.add(nxt)
        cur = nxt

    # Now collect lateral kids hanging off EITHER the root OR any
    # spine bone — that's where wings, arms, and legs all attach.
    lateral_long = 0
    lower = 0
    spine_like = 0
    branch_sources = [root] + spine_chain
    for src in branch_sources:
        for kid in children[src]:
            if kid in seen:
                continue
            ch = longest_chain(kid)
            tip = pos[ch[-1]]
            side_span = max(abs(SIDE(pos[c]) - root_side) for c in ch)
            rise = UP(tip) - root_y
            if side_span > body_s * 0.10 and len(ch) >= 3:
                lateral_long += 1
            elif rise < -body_h * 0.05 and len(ch) >= 2:
                lower += 1
            elif abs(rise) <= body_h * 0.15 and len(ch) >= 3:
                spine_like += 1
    # Heuristics:
    #   * 2+ lateral chains + 2+ lower legs → winged-biped (dragon, bat)
    #   * 2+ lateral chains only            → bird perch (eagle, parrot)
    #   * 4+ lower legs                     → quadruped
    #   * 2 lower legs                      → biped
    print(f"[topology] root_y={root_y:.3f} root_side={root_side:.3f} "
          f"spine_len={len(spine_chain)} lateral_long={lateral_long} "
          f"lower={lower} spine_like={spine_like} body_h={body_h:.3f} "
          f"body_s={body_s:.3f}", flush=True)
    if lateral_long >= 2 and lower >= 2:
        return 'flying'
    if lateral_long >= 2 and lower == 0:
        return 'flying'
    if lower >= 4:
        return 'quadropeds'
    if lower == 2:
        return 'bipeds'
    return 'all'


def _anatomical_names(joint_idxs, parent_by_idx, world_by_idx, ckpt_family: str = 'all'):
    """Build a name_by_idx that uses anatomical strings derived from
    topology + world bind positions, so AnyTop's T5 conditioner gets
    semantic signal instead of the cloud-rigged GLB's default
    ``joint_<N>`` placeholders.

    Each returned name is suffixed with ``__j<skin_pos>`` where
    ``skin_pos`` is the joint's position in the GLB's ``skin.joints[]``
    array. This survives the AnyTop round-trip in BVH joint names and
    is parsed back by ``bvh_to_gltf_anim._map_bvh_to_glb`` to recover
    the exact GLB bone — without this, renaming the BVH names to
    anatomical strings makes the post-sampler mapper find 0 GLB
    matches and the whole anim job fails ("No BVH joint name resolves
    to a GLB bone" — observed in prod 2026-06-02).

    Audit (acc4f279) ranked this as the dominant Mode-3 failure: AnyTop
    conditions on T5-encoded joint name STRINGS, not on a class-id
    embedding. ``joint_17`` → T5 embedding ≈ zero info → near-identity
    motion. Anatomical strings like ``"wing_l_03"`` carry meaning T5
    actually trained on.

    Heuristic — no external deps, runs in <10 ms:
      * root          → "hip"  (lowest-up joint that has children)
      * spine chain   → "spine_01" … "spine_NN" (longest upward-on-axis chain)
      * neck/head     → last 1-2 spine bones get neck_01 / head if topmost
      * tail chain    → "tail_01" … (longest chain going DOWN+BACK from root)
      * wings         → "wing_l_NN" / "wing_r_NN" (upper laterals, long chain)
      * legs          → "leg_l_NN" / "leg_r_NN" (lower laterals, going down)
      * arms          → "arm_l_NN" / "arm_r_NN" (mid laterals, only if no wings)
      * unmapped      → "limb_NN" (still > "joint_N" semantically)
    """
    import numpy as np
    if not joint_idxs:
        return {}

    pos = {ji: np.asarray(world_by_idx.get(ji, [0.0, 0.0, 0.0]), dtype=np.float32)
           for ji in joint_idxs}
    arr = np.array([pos[ji] for ji in joint_idxs])
    bb_min, bb_max = arr.min(axis=0), arr.max(axis=0)
    size = bb_max - bb_min
    # 2026-06-02 fix: glTF spec mandates Y-up, so hard-pin up_axis = 1.
    # Previous "largest-extent picks up_axis" heuristic broke on
    # horizontally-elongated creatures (dragon with extended tail/wings):
    # bbox Z (length) > Y (height) → up_axis=Z → left/right scrambled
    # → 8 leg_l + 0 leg_r + 0 wing observed in prod logs 2026-06-02.
    up_axis = 1
    # 2026-06-02 fix #2: side_axis = X (axis 0) hardpin. Puppeteer
    # rigs follow the standard "character faces +Z, Y up, X is left-
    # right" convention. The previous `max(X, Z)` heuristic picked Z
    # on tail-elongated rigs (dragon ~3-4m head-to-tail, ~2m wingspan)
    # → wings projected onto Z → classified as forward/backward chains
    # instead of left/right → 7 arm + 0 leg + 0 wing observed in prod
    # logs 2026-06-02 (Bear retarget run).
    side_axis = 0
    fwd_axis = 2
    body_h = max(float(size[up_axis]), 1e-6)
    UP = lambda v: float(v[up_axis])
    SIDE = lambda v: float(v[side_axis])
    FWD = lambda v: float(v[fwd_axis])

    children = {ji: [] for ji in joint_idxs}
    for ji in joint_idxs:
        p = parent_by_idx.get(ji, -1)
        if p in children:
            children[p].append(ji)

    roots = [ji for ji in joint_idxs if parent_by_idx.get(ji, -1) not in joint_idxs]
    root = roots[0] if roots else joint_idxs[0]
    # Prefer a root that actually branches (avoids picking a stray bone).
    branchy = [r for r in roots if len(children[r]) >= 2]
    if branchy:
        root = min(branchy, key=lambda r: UP(pos[r]))

    def descendants(ji):
        out, stack = [], list(children[ji])
        while stack:
            x = stack.pop()
            out.append(x)
            stack.extend(children[x])
        return out

    def longest_chain(ji):
        chain = [ji]
        cur = ji
        while children[cur]:
            cur = max(children[cur], key=lambda c: len(descendants(c)))
            chain.append(cur)
        return chain

    root_side = SIDE(pos[root])
    side_gate = body_h * 0.10

    def on_axis_chain(ji, direction_up=True):
        chain = [ji]
        cur = ji
        while children[cur]:
            kids = [c for c in children[cur]
                    if abs(SIDE(pos[c]) - root_side) <= side_gate
                    and ((UP(pos[c]) >= UP(pos[cur]) - body_h * 0.02) if direction_up
                         else (UP(pos[c]) <= UP(pos[cur]) + body_h * 0.02))]
            if not kids:
                break
            best = max(kids, key=lambda c: len(descendants(c)))
            chain.append(best)
            cur = best
        return chain

    # Spine = upward chain from root, on the body axis. Always include root.
    spine = on_axis_chain(root, direction_up=True)

    # Tail = downward+backward chain that ISN'T the spine. Look for
    # root's children NOT in spine with negative or stable UP.
    spine_set = set(spine)
    tail_root = None
    for kid in children[root]:
        if kid in spine_set:
            continue
        if abs(SIDE(pos[kid]) - root_side) > side_gate:
            continue
        # Tail-like: tip below or at root height, length >= 2.
        chain_test = longest_chain(kid)
        end_p = pos[chain_test[-1]]
        if UP(end_p) <= UP(pos[root]) + body_h * 0.05 and len(chain_test) >= 2:
            tail_root = kid
            break
    tail = []
    if tail_root is not None:
        tail = on_axis_chain(tail_root, direction_up=False)

    # Limbs = remaining lateral chains rooted on the spine.
    # Classify each into wings/arms/legs by:
    #   * UP(start) vs spine span → upper (wings) or lower (legs)
    #   * winged ckpt_family bumps "upper" → wings; else "upper" → arms
    #   * sign of SIDE → _l / _r
    used = set(spine) | set(tail)
    spine_lateral_kids = []
    for sp_ni in spine:
        for k in children[sp_ni]:
            if k in used:
                continue
            if abs(SIDE(pos[k]) - root_side) <= side_gate:
                continue  # still on-axis, not a real lateral
            spine_lateral_kids.append((sp_ni, k))

    # Group by sign of SIDE relative to root_side.
    left_chains, right_chains = [], []
    for sp_ni, k in spine_lateral_kids:
        ch = longest_chain(k)
        signed = SIDE(pos[k]) - root_side
        rec = {
            'chain': ch,
            'attach_height': UP(pos[sp_ni]),
            'tip_height': UP(pos[ch[-1]]),
            'span': max(abs(SIDE(pos[c]) - root_side) for c in ch),
            'length': len(ch),
            'side_sign': signed,
        }
        (left_chains if signed > 0 else right_chains).append(rec)

    # For each side, classify upper-most longest as wing/arm,
    # next as leg if its tip is BELOW root.
    spine_top = UP(pos[spine[-1]]) if spine else UP(pos[root])
    spine_btm = UP(pos[spine[0]])

    def split_upper_lower(chains):
        if not chains:
            return None, None
        # Upper = attaches in top half of spine OR tip above root
        upper = sorted(
            [c for c in chains if c['attach_height'] > (spine_btm + 0.5 * (spine_top - spine_btm))
             or c['tip_height'] > UP(pos[root]) + body_h * 0.1],
            key=lambda c: (-c['length'], -c['span']),
        )
        lower = sorted(
            [c for c in chains
             if c['tip_height'] < UP(pos[root]) - body_h * 0.05
             and c not in upper],
            key=lambda c: (-c['length'], -c['span']),
        )
        return (upper[0] if upper else None,
                lower[0] if lower else None)

    upper_l, lower_l = split_upper_lower(left_chains)
    upper_r, lower_r = split_upper_lower(right_chains)

    is_winged_family = ckpt_family in ('flying',)
    upper_role = 'wing' if is_winged_family else 'arm'

    name_by_idx = {}

    # ── ROOT
    name_by_idx[root] = 'hip'

    # ── SPINE / NECK / HEAD
    # Last spine joint = head if it's near the top AND has no kids.
    spine_assign = list(spine[1:])  # skip root
    if spine_assign:
        head_ni = None
        if (UP(pos[spine_assign[-1]]) >= spine_top - body_h * 0.02
                and not children[spine_assign[-1]]):
            head_ni = spine_assign.pop()
        # Last 1-2 remaining = neck
        neck_count = min(2, max(1, len(spine_assign) // 6))
        spine_count = max(0, len(spine_assign) - neck_count)
        for i in range(spine_count):
            name_by_idx[spine_assign[i]] = f'spine_{i + 1:02d}'
        for j in range(neck_count):
            ni = spine_assign[spine_count + j]
            name_by_idx[ni] = f'neck_{j + 1:02d}'
        if head_ni is not None:
            name_by_idx[head_ni] = 'head'

    # ── TAIL
    if tail:
        for i, ni in enumerate(tail):
            name_by_idx[ni] = f'tail_{i + 1:02d}'

    # ── LIMBS
    def name_chain(chain, role, side_suffix):
        for i, ni in enumerate(chain):
            name_by_idx[ni] = f'{role}_{side_suffix}_{i + 1:02d}'

    if upper_l: name_chain(upper_l['chain'], upper_role, 'l')
    if upper_r: name_chain(upper_r['chain'], upper_role, 'r')
    if lower_l: name_chain(lower_l['chain'], 'leg', 'l')
    if lower_r: name_chain(lower_r['chain'], 'leg', 'r')

    # ── FALLBACK for anything still unnamed (extra fingers, tail
    #   branches, accessories). Use "limb_NN" indexed by insertion
    #   order — still T5-meaningful as "limb" vs "joint".
    unnamed = [ji for ji in joint_idxs if ji not in name_by_idx]
    for i, ni in enumerate(unnamed):
        name_by_idx[ni] = f'limb_{i + 1:02d}'

    # ── Suffix every name with __j<skin_pos> for round-trip mapping.
    # See docstring: bvh_to_gltf_anim parses this suffix back to the
    # exact GLB bone position. Without it, the post-sampler mapping
    # gets 0 matches between anatomical BVH names and joint_<N> GLB
    # bones, and the anim job fails before it can write the GLB.
    for skin_pos, ji in enumerate(joint_idxs):
        if ji in name_by_idx:
            name_by_idx[ji] = f"{name_by_idx[ji]}__j{skin_pos}"

    return name_by_idx


def _extract_bvh_from_glb(glb_path: str, out_bvh: str, n_frames: int = 30,
                          perturb: bool = False, ckpt_family: str = 'all') -> None:
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
    parent_by_idx = {i: -1 for i in joint_idxs}
    for parent_idx in joint_idxs:
        for child in (nodes[parent_idx].get("children") or []):
            if child in joint_idxs:
                parent_by_idx[child] = parent_idx
    root = next((i for i in joint_idxs if parent_by_idx[i] == -1), joint_idxs[0])
    # name_by_idx is filled below from anatomical heuristics so AnyTop's
    # T5 conditioner gets semantic signal (audit acc4f279 finding #1).

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

    # ── Anatomical rename (Fix #1 from audit acc4f279). ──────────
    # T5 conditioner reads joint name strings. Cloud rig emits
    # joint_<N> placeholders → near-zero embedding → identity motion.
    # Replace with topology+IBM-derived semantic names ("hip",
    # "wing_l_03", "tail_02", ...) before BVH emission so downstream
    # cond.npy["joints_names"] carries meaning.
    name_by_idx = _anatomical_names(joint_idxs, parent_by_idx, world_by_idx, ckpt_family=ckpt_family)
    # Defensive fallback in case the heuristic returns empty.
    for ji in joint_idxs:
        if ji not in name_by_idx:
            name_by_idx[ji] = (nodes[ji].get("name") or f"joint_{ji}")
    _log(f"anatomical names ({ckpt_family}): {list(name_by_idx.values())[:12]}...")

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

        # ── Step 0: topology probe — used as ckpt_family fallback ──
        # We still classify the rig (winged / quadruped / biped) but
        # ONLY as a fallback for class selection when the prompt
        # doesn't mention an explicit species. Class selection runs
        # against the BUNDLED cond.npy keyword table — see
        # _pick_trained_class().
        _topo_family = 'all'
        try:
            sys.path.insert(0, "/tmp")
            from puppeteer_to_skeleton import _read_glb, _read_accessor  # type: ignore
            import numpy as _np_topo
            _gltf_topo, _, _bin_topo, _ = _read_glb(rig_path)
            _skin_topo = (_gltf_topo.get("skins") or [{}])[0]
            _ji_topo = _skin_topo.get("joints") or []
            _nodes_topo = _gltf_topo.get("nodes") or []
            _parent_topo = {i: -1 for i in _ji_topo}
            for _p in _ji_topo:
                for _c in (_nodes_topo[_p].get("children") or []):
                    if _c in _ji_topo:
                        _parent_topo[_c] = _p
            _world_topo = {}
            _ibm_acc = _skin_topo.get("inverseBindMatrices")
            if _ibm_acc is not None:
                _ibm = _np_topo.asarray(_read_accessor(_gltf_topo, _bin_topo, _ibm_acc))
                _ibm = _ibm.reshape(len(_ji_topo), 4, 4).transpose(0, 2, 1)
                for _k, _ji in enumerate(_ji_topo):
                    try:
                        _w = _np_topo.linalg.inv(_ibm[_k])[:3, 3]
                        _world_topo[_ji] = _w
                    except Exception:
                        _world_topo[_ji] = _np_topo.array([0.0, 0.0, 0.0])
            for _ji in _ji_topo:
                if _ji not in _world_topo:
                    _tr = _nodes_topo[_ji].get("translation") or [0.0, 0.0, 0.0]
                    _world_topo[_ji] = _np_topo.asarray(_tr, dtype=_np_topo.float32)
            _topo_family = _detect_topology_family(_ji_topo, _parent_topo, _world_topo)
        except Exception as _e:
            _log(f"step 0: topology probe failed ({_e!r})")
        _log(f"step 0: topology_family={_topo_family} (used as class-selection fallback)")

        # ── Step 1 (Strategy 1, 2026-06-02): pick the BUNDLED trained
        # class whose topology+motion best matches the user's intent,
        # then run sample.generate on AnyTop's NATIVE cond.npy. No
        # more rig-to-AnyTop translation — Puppeteer's 47-bone output
        # never reaches the sampler. The bundled cond.npy at
        #   /AnyTop/dataset/truebones/zoo/truebones_processed/cond.npy
        # contains ALL 75+ trained classes as dict keys, each with
        # the structural data (parents, offsets, mean, std, ...) the
        # learned class embedding was conditioned on.
        target_class, ckpt_family = _pick_trained_class(
            prompt=prompt, anim_type=anim_type, asset_family='',
            topology_family=_topo_family,
        )
        ckpt = _resolve_checkpoint_path(ckpt_family)
        if not ckpt:
            raise RuntimeError(f"checkpoint not found for family {ckpt_family}")
        bundled_cond = os.path.join(
            ANYTOP_DIR, "dataset", "truebones", "zoo",
            "truebones_processed", "cond.npy",
        )
        if not os.path.isfile(bundled_cond):
            raise RuntimeError(
                f"bundled cond.npy not found at {bundled_cond} — "
                "container build didn't ship AnyTop's processed dataset")
        _log(f"step 1: target_class={target_class!r} ckpt_family={ckpt_family} "
             f"ckpt={os.path.basename(ckpt)}")

        # ── Step 2: sample.generate on the BUNDLED class. AnyTop
        # writes <class>_rep_*.bvh + .npy under samples_*/ alongside
        # the checkpoint.
        cmd = [
            sys.executable, "-m", "sample.generate",
            "--model_path", ckpt,
            "--object_type", target_class,
            "--cond_path", bundled_cond,
            "--num_repetitions", "1",
            "--motion_length", "5.0",
            "--device", "0",
        ]
        _log(f"step 2: {' '.join(cmd)}")
        rc = _run_subprocess(cmd, cwd=ANYTOP_DIR)
        if rc != 0:
            raise RuntimeError(f"sample.generate exit {rc}")
        gen_bvh = _find_latest_bvh(ckpt)
        if not gen_bvh or not os.path.isfile(gen_bvh):
            raise RuntimeError("sample.generate produced no BVH")
        os.replace(gen_bvh, bvh_anim)
        _log(f"step 2 done: bvh={bvh_anim} ({os.path.getsize(bvh_anim)} bytes)")

        # ── Step 2.5: probe the raw .npy motion magnitude — sanity
        # check that AnyTop's native run actually produced real motion.
        try:
            import glob as _glob
            import numpy as _np
            ckpt_dir = os.path.dirname(ckpt)
            cand = _glob.glob(os.path.join(ckpt_dir, "samples_*", f"{target_class}_rep_*.npy"))
            if cand:
                cand.sort(key=lambda p: os.path.getmtime(p), reverse=True)
                _npy = cand[0]
                _arr = _np.load(_npy, allow_pickle=True)
                if isinstance(_arr, _np.ndarray) and _arr.dtype != object and _arr.size > 1:
                    _gstd = float(_arr.std())
                    _per = (float(_arr.std(axis=tuple(range(_arr.ndim - 1))).mean())
                            if _arr.ndim >= 2 else _gstd)
                    _l2 = (float(_np.linalg.norm(_arr[0] - _arr[-1]))
                           if _arr.shape[0] > 1 else 0.0)
                    _log(f"step 2.5 probe: shape={_arr.shape} "
                         f"global_std={_gstd:.4f} per_joint_std_mean={_per:.4f} "
                         f"first_vs_last_l2={_l2:.4f} "
                         f"DIAGNOSIS={'near-identity' if _gstd < 1e-3 else 'has motion'}")
        except Exception as _e:
            _log(f"step 2.5 probe FAILED: {_e!r}")

        # ── Step 3: retarget BVH → user's Puppeteer rig. Source has
        # ~30-142 bones (depends on class); target has whatever
        # Puppeteer produced. The retargeter classifies bones on both
        # sides by anatomical role, matches by (role, side, chain
        # index), and copies parent-relative quaternions frame-by-
        # frame. Puppeteer rig stays byte-identical except for the
        # added AnimationClip.
        if 'anytop_retarget' in sys.modules:
            del sys.modules['anytop_retarget']
        from anytop_retarget import retarget_bvh_to_rig  # type: ignore
        _log("step 3: retargeting BVH → Puppeteer rig")
        retarget_bvh_to_rig(
            rig_glb_path=rig_path,
            bvh_path=bvh_anim,
            out_glb_path=out_path,
            clip_name=anim_type or "clip",
            target_fps=30.0,
            ckpt_family=ckpt_family,
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


# Strategy 1 (Mixamo-style retargeting) — pick the BUNDLED trained
# class whose topology best matches the user's mesh. Keyword-driven
# but easy to extend; the topology detection from the Puppeteer rig
# is used as a fallback when nothing in the prompt / anim_type / job
# context is decisive. See [[project_anytop_strategy]].
_TRAINED_CLASS_BY_KEYWORD = [
    # (keyword regex, trained class, ckpt family for sample.generate)
    (r'\bdragon\b|\bwyvern\b|\bicy\s*dragon\b',           'Dragon',      'flying'),
    (r'\bbat\b',                                           'Bat',         'flying'),
    (r'\beagle\b|\bhawk\b|\bfalcon\b',                    'Eagle',       'flying'),
    (r'\bparrot\b',                                        'Parrot',      'flying'),
    (r'\bbird\b|\bsparrow\b|\bswallow\b|\bcrow\b|\bowl\b','Bird',        'flying'),
    (r'\bchicken\b|\brooster\b|\bhen\b',                  'Chicken',     'flying'),
    (r'\bflamingo\b',                                      'Flamingo',    'flying'),
    (r'\bbuzzard\b|\bvulture\b',                          'Buzzard',     'flying'),
    (r'\bostrich\b',                                       'Ostrich',     'bipeds'),
    (r'\bpteranodon\b|\bpterodactyl\b',                   'Pteranodon',  'flying'),
    (r'\bgiantbee\b|\bbee\b|\bwasp\b|\bhornet\b',         'Giantbee',    'flying'),
    (r'\bt[- ]?rex\b|\btyranno(saurus)?\b',               'Trex',        'bipeds'),
    (r'\braptor\b|\bvelociraptor\b',                      'Raptor',      'bipeds'),
    (r'\btricera(tops)?\b',                                'Tricera',     'quadropeds'),
    (r'\bstegosaurus\b|\bstego\b',                        'Stego',       'quadropeds'),
    (r'\bcrocodile\b|\balligator\b|\bgator\b',            'Crocodile',   'quadropeds'),
    (r'\bcomodo\b|\bkomodo\b|\blizard\b',                 'Comodoa',     'quadropeds'),
    (r'\blion\b',                                          'Lion',        'quadropeds'),
    (r'\btiger\b|\bsabre[- ]?tooth\b',                    'SabreToothTiger', 'quadropeds'),
    (r'\bjaguar\b',                                        'Jaguar',      'quadropeds'),
    (r'\bleopard\b|\bcheetah\b',                          'Leapord',     'quadropeds'),
    (r'\blynx\b',                                          'Lynx',        'quadropeds'),
    (r'\bcat\b|\bkitten\b',                               'Cat',         'quadropeds'),
    (r'\bfox\b',                                           'Fox',         'quadropeds'),
    (r'\bwolf\b|\bcoyote\b|\bjackal\b',                   'Coyote',      'quadropeds'),
    (r'\bdog\b|\bhound\b|\bpuppy\b',                      'Hound',       'quadropeds'),
    (r'\bhorse\b|\bstallion\b|\bmare\b',                  'Horse',       'quadropeds'),
    (r'\bdeer\b|\belk\b|\bmoose\b',                       'Deer',        'quadropeds'),
    (r'\braindeer\b|\breindeer\b',                        'Raindeer',    'quadropeds'),
    (r'\bgazelle\b|\bantelope\b|\bimpala\b',              'Gazelle',     'quadropeds'),
    (r'\bgoat\b|\bsheep\b|\bram\b',                       'Goat',        'quadropeds'),
    (r'\bbuffalo\b|\bbison\b|\bcow\b|\bbull\b|\bcattle\b','Buffalo',     'quadropeds'),
    (r'\brhino\b|\brhinoceros\b',                         'Rhino',       'quadropeds'),
    (r'\bhippo(potamus)?\b',                              'Hippopotamus','quadropeds'),
    (r'\belephant\b',                                      'Elephant',    'quadropeds'),
    (r'\bmammoth\b',                                       'Mammoth',     'quadropeds'),
    (r'\bbear\b|\bgrizzly\b',                             'Bear',        'quadropeds'),
    (r'\bpolar[- ]?bear\b',                               'PolarBear',   'quadropeds'),
    (r'\bbrown[- ]?bear\b',                               'BrownBear',   'quadropeds'),
    (r'\bmonkey\b|\bape\b|\bgorilla\b|\bchimp\b',         'Monkey',      'quadropeds'),
    (r'\bhamster\b|\brat\b|\bmouse\b|\bsandmouse\b',      'Hamster',     'quadropeds'),
    (r'\bcamel\b',                                         'Camel',       'quadropeds'),
    (r'\bskunk\b',                                         'Skunk',       'quadropeds'),
    (r'\bspider\b|\btarantula\b',                         'Spider',      'millipeds_snakes'),
    (r'\bcentipede\b|\bmillipede\b',                      'Centipede',   'millipeds_snakes'),
    (r'\bcricket\b|\bgrasshopper\b|\blocust\b',           'Cricket',     'millipeds_snakes'),
    (r'\bant\b|\bfireant\b',                              'FireAnt',     'millipeds_snakes'),
    (r'\bcrab\b|\bhermit[- ]?crab\b',                     'Crab',        'millipeds_snakes'),
    (r'\bscorpion\b',                                      'Scorpion',    'millipeds_snakes'),
    (r'\broach\b|\bcockroach\b|\bbeetle\b',               'Roach',       'millipeds_snakes'),
    (r'\bisopetra\b|\bisopod\b',                          'Isopetra',    'millipeds_snakes'),
    (r'\bturtle\b|\btortoise\b',                          'Turtle',      'quadropeds'),
    (r'\bcobra\b|\bsnake\b|\bserpent\b|\bnaga\b',         'KingCobra',   'millipeds_snakes'),
    (r'\bfish\b|\bpiranha\b|\bpirrana\b|\bshark\b',       'Pirrana',     'millipeds_snakes'),
    (r'\bpigeon\b|\bdove\b',                              'Pigeon',      'flying'),
]


def _pick_trained_class(prompt: str, anim_type: str, asset_family: str = '',
                        topology_family: str = '') -> tuple:
    """Return (trained_class, ckpt_family) by inspecting (in order):
       * prompt text (any keyword from _TRAINED_CLASS_BY_KEYWORD)
       * asset_family the upstream client passed
       * anim_type (rare — usually 'run'/'idle' but maybe 'fly')
       * topology_family (from _detect_topology_family on the rig)

    Falls back to (Bear, quadropeds) — the highest-bone-count
    quadruped which we found to retarget reasonably to almost any
    creature. Never returns Flamingo as a default (its trained
    motion is bird-perch-specific and looks weird on quadrupeds)."""
    haystack = ' '.join([
        (prompt or ''), (asset_family or ''), (anim_type or ''),
    ]).lower()
    for pat, cls, fam in _TRAINED_CLASS_BY_KEYWORD:
        if re.search(pat, haystack):
            return (cls, fam)
    # Topology fallback.
    if topology_family == 'flying':
        return ('Dragon', 'flying')
    if topology_family == 'millipeds_snakes':
        return ('Spider', 'millipeds_snakes')
    if topology_family == 'quadropeds':
        return ('Bear', 'quadropeds')
    if topology_family == 'bipeds':
        return ('Trex', 'bipeds')  # better than Ostrich for most user-gen biped meshes
    return ('Bear', 'quadropeds')


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
# Debug helpers — Plan A: prove AnyTop works on its OWN data
# before we polish the rig-bridge layer. Run via:
#   modal run modal_app/_anytop_anim.py::inspect_anytop
#   modal run modal_app/_anytop_anim.py::standalone_run --class-name Dragon
# ============================================================
@app.function(image=image, cpu=1, timeout=120)
def inspect_bundled_classes() -> dict:
    """Dump the FULL list of trained classes inside AnyTop's bundled
    cond.npy with each class's joint count + sample joint names.
    Used to design the asset_family → trained_class mapping for the
    retargeting bridge (Strategy 1)."""
    import os, json
    import numpy as _np
    bundled = os.path.join(ANYTOP_DIR, "dataset", "truebones", "zoo",
                           "truebones_processed", "cond.npy")
    out = {"path": bundled, "exists": os.path.isfile(bundled)}
    if not out["exists"]:
        return out
    raw = _np.load(bundled, allow_pickle=True)
    cond = raw.item() if hasattr(raw, "item") and getattr(raw, "ndim", 1) == 0 else raw
    if not isinstance(cond, dict):
        out["error"] = f"cond is {type(cond).__name__}, expected dict"
        return out
    classes = []
    for name, entry in cond.items():
        jn = entry.get("joints_names") if hasattr(entry, "get") else None
        parents = entry.get("parents") if hasattr(entry, "get") else None
        classes.append({
            "name": name,
            "joint_count": len(jn) if jn is not None else (len(parents) if parents is not None else 0),
            "joints_names_sample": list(jn[:6]) if jn is not None else [],
            "joints_names_tail": list(jn[-3:]) if jn is not None and len(jn) > 6 else [],
        })
    classes.sort(key=lambda c: c["name"])
    out["total"] = len(classes)
    out["classes"] = classes
    print("[inspect_bundled_classes]", json.dumps({"total": out["total"]}, indent=2))
    for c in classes:
        print(f"  {c['name']:18s}  {c['joint_count']:>4d}  {c['joints_names_sample']}")
    return out


@app.function(image=image, cpu=1, timeout=60)
def inspect_anytop() -> dict:
    """List what AnyTop has bundled in the container so we know if
    sample.generate can run on its own trained data without our
    rig-extraction bridge. Reports:
      * /AnyTop/dataset/truebones/zoo/ subdirectories (per-class data)
      * which subdirs have a cond.npy (the actual conditioning file)
      * /AnyTop/save/ checkpoint folders
    Returns a structured dict so the local entrypoint can pretty-print
    it without scrolling through ANSI logs."""
    import os, json
    result = {"ANYTOP_DIR": ANYTOP_DIR}
    ds_root = os.path.join(ANYTOP_DIR, "dataset", "truebones", "zoo")
    result["dataset_root"] = ds_root
    result["dataset_root_exists"] = os.path.isdir(ds_root)
    classes = []
    if result["dataset_root_exists"]:
        for name in sorted(os.listdir(ds_root)):
            sub = os.path.join(ds_root, name)
            if not os.path.isdir(sub):
                continue
            cond_npy = os.path.join(sub, "cond.npy")
            bvh_files = [f for f in os.listdir(sub) if f.lower().endswith(".bvh")]
            classes.append({
                "name": name,
                "has_cond_npy": os.path.isfile(cond_npy),
                "cond_npy_size": os.path.getsize(cond_npy) if os.path.isfile(cond_npy) else 0,
                "bvh_count": len(bvh_files),
                "bvh_sample": bvh_files[:3],
            })
    result["classes"] = classes
    result["total_classes"] = len(classes)
    result["classes_with_cond_npy"] = sum(1 for c in classes if c["has_cond_npy"])

    save_root = os.path.join(ANYTOP_DIR, "save")
    result["save_root_exists"] = os.path.isdir(save_root)
    ckpts = []
    if result["save_root_exists"]:
        for name in sorted(os.listdir(save_root)):
            sub = os.path.join(save_root, name)
            if not os.path.isdir(sub):
                continue
            pts = [f for f in os.listdir(sub) if f.endswith(".pt")]
            ckpts.append({"folder": name, "pt_count": len(pts), "pt_sample": pts[:2]})
    result["checkpoints"] = ckpts

    print("[inspect_anytop]", json.dumps(result, indent=2))
    return result


@app.function(image=image, gpu="A10G", timeout=600,
              volumes={"/anim_data": anim_output_volume})
def standalone_run(class_name: str = "Dragon", motion_length: float = 5.0) -> dict:
    """Run sample.generate using AnyTop's OWN bundled cond.npy for the
    given class, with NO rig translation, NO BVH extraction, NO bridge
    code from our side. Whatever AnyTop produces here is what AnyTop
    is capable of by itself.

    Returns the .npy stats (shape, global_std, per_joint_std_mean,
    first_vs_last_l2) so we can tell whether AnyTop generates real
    motion. If global_std is healthy here → our bridge is the problem.
    If it's near zero here too → AnyTop is broken in our container."""
    import os, glob as _glob, json, time
    import numpy as _np

    sys.path.insert(0, "/tmp")
    sys.path.insert(0, ANYTOP_DIR)

    # 1. Pick the right ckpt family for the requested class.
    family_by_class = {v: k for k, v in _OBJECT_TYPE_BY_FAMILY.items()}
    family = family_by_class.get(class_name, "all")
    ckpt = _resolve_checkpoint_path(family)
    print(f"[standalone_run] class={class_name} family={family} ckpt={ckpt}")

    # 2. AnyTop ships ONE big cond.npy at
    #    /AnyTop/dataset/truebones/zoo/truebones_processed/cond.npy
    # containing all 70 trained classes as dict keys. There is NO
    # per-class folder layout — that's why our earlier attempts to
    # alias `cond[Dragon] = cond[skel_name]` produced wrong results:
    # the model expects the FULL dict with the canonical class keys.
    bundled = os.path.join(ANYTOP_DIR, "dataset", "truebones", "zoo",
                           "truebones_processed", "cond.npy")
    result = {
        "class_name": class_name, "family": family, "ckpt": ckpt,
        "bundled_cond_path": bundled,
        "bundled_cond_exists": os.path.isfile(bundled),
    }
    if not os.path.isfile(ckpt):
        result["error"] = f"checkpoint not found at {ckpt}"
        print(f"[standalone_run] ERROR: {result['error']}")
        return result
    if not os.path.isfile(bundled):
        result["error"] = (f"bundled cond.npy not found at {bundled} — "
                          "AnyTop processed dataset is not in this container.")
        print(f"[standalone_run] ERROR: {result['error']}")
        return result

    # 3. Peek inside the bundled cond.npy: keys, target class structure.
    cond_path = bundled
    try:
        _raw = _np.load(cond_path, allow_pickle=True)
        _cond = _raw.item() if hasattr(_raw, "item") and getattr(_raw, "ndim", 1) == 0 else _raw
        if isinstance(_cond, dict):
            keys = list(_cond.keys())
            result["cond_total_keys"] = len(keys)
            result["cond_keys_sample"] = keys[:30]
            result["class_in_cond"] = class_name in _cond
            if class_name in _cond:
                entry = _cond[class_name]
                if hasattr(entry, "get"):
                    jn = entry.get("joints_names", None)
                    parents = entry.get("parents", None)
                    offsets = entry.get("offsets", None)
                    result["cond_joints_names_count"] = len(jn) if jn is not None else 0
                    result["cond_joints_names_sample"] = list(jn[:16]) if jn is not None else None
                    result["cond_parents_shape"] = (
                        list(_np.asarray(parents).shape) if parents is not None else None)
                    result["cond_offsets_shape"] = (
                        list(_np.asarray(offsets).shape) if offsets is not None else None)
                    result["cond_entry_keys"] = list(entry.keys()) if hasattr(entry, "keys") else None
    except Exception as e:
        result["cond_load_warn"] = repr(e)

    # 4. Run sample.generate exactly as AnyTop intends.
    t0 = time.time()
    cmd = [
        sys.executable, "-m", "sample.generate",
        "--model_path", ckpt,
        "--object_type", class_name,
        "--cond_path", cond_path,
        "--num_repetitions", "1",
        "--motion_length", str(motion_length),
        "--device", "0",
    ]
    print(f"[standalone_run] CMD: {' '.join(cmd)}")
    rc = _run_subprocess(cmd, cwd=ANYTOP_DIR)
    result["sample_generate_rc"] = rc
    result["sample_generate_secs"] = round(time.time() - t0, 1)
    if rc != 0:
        result["error"] = f"sample.generate exit {rc}"
        return result

    # 5. Probe the generated .npy (same logic as step 4.5 in animate_mesh).
    ckpt_dir = os.path.dirname(ckpt)
    cand = _glob.glob(os.path.join(ckpt_dir, "samples_*", f"{class_name}_rep_*.npy"))
    cand.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    if not cand:
        result["error"] = f"no .npy produced under {ckpt_dir}/samples_*"
        return result
    npy_path = cand[0]
    result["output_npy"] = os.path.basename(npy_path)
    arr = _np.load(npy_path, allow_pickle=True)
    if isinstance(arr, _np.ndarray) and arr.dtype != object:
        result["shape"] = list(arr.shape)
        result["dtype"] = str(arr.dtype)
        result["global_std"] = float(arr.std())
        if arr.ndim >= 2:
            result["per_joint_std_mean"] = float(arr.std(axis=tuple(range(arr.ndim - 1))).mean())
        result["first_vs_last_l2"] = float(_np.linalg.norm(arr[0] - arr[-1])) if arr.shape[0] > 1 else 0.0
        result["DIAGNOSIS"] = ("near-identity (engine broken)"
                              if result["global_std"] < 1e-3
                              else "real motion")
    else:
        result["arr_type"] = type(arr).__name__

    # 6. Also expose the BVH so the user can convert & view it locally.
    bvh_path = _find_latest_bvh(ckpt)
    if bvh_path and os.path.isfile(bvh_path):
        result["bvh_path_in_container"] = bvh_path
        # Persist to the shared volume so the local entrypoint can fetch it.
        out_bvh = f"/anim_data/STANDALONE_{class_name}_{int(time.time())}.bvh"
        try:
            with open(bvh_path, "rb") as fin, open(out_bvh, "wb") as fout:
                fout.write(fin.read())
            anim_output_volume.commit()
            result["bvh_persisted_to_volume"] = out_bvh
        except Exception as e:
            result["bvh_persist_warn"] = repr(e)

    print(f"[standalone_run] RESULT: {json.dumps(result, indent=2)}")
    return result


@app.local_entrypoint()
def main(action: str = "inspect", class_name: str = "Dragon",
         motion_length: float = 5.0) -> None:
    """`modal run modal_app/_anytop_anim.py::main --action inspect`
    `modal run modal_app/_anytop_anim.py::main --action standalone --class-name Dragon`"""
    import json
    if action == "classes":
        r = inspect_bundled_classes.remote()
        print(f"\n=== {r.get('total', 0)} trained classes in bundled cond.npy ===\n")
        for c in r.get("classes", []):
            print(f"  {c['name']:18s}  {c['joint_count']:>4d}  {c['joints_names_sample']}")
        return
    if action == "inspect":
        r = inspect_anytop.remote()
        print("\n=== inspect_anytop summary ===")
        print(f"dataset_root_exists: {r['dataset_root_exists']}")
        print(f"total_classes: {r['total_classes']}")
        print(f"classes_with_cond_npy: {r['classes_with_cond_npy']}")
        print(f"save_root_exists: {r['save_root_exists']}")
        print(f"checkpoints: {[c['folder'] for c in r['checkpoints']]}")
        print(f"\nfirst 10 classes:")
        for c in r["classes"][:10]:
            print(f"  {c['name']:20s} cond={c['has_cond_npy']} bvh={c['bvh_count']}")
    elif action == "standalone":
        r = standalone_run.remote(class_name=class_name, motion_length=motion_length)
        print("\n=== standalone_run summary ===")
        print(json.dumps(r, indent=2))
    else:
        print(f"unknown action {action!r}; choose 'inspect' or 'standalone'")


# ============================================================
# ASGI router exposing the async spawn / poll / fetch endpoints
# ============================================================
@app.function(
    image=image,
    cpu=1,
    # Was 120s — bumped to 300s after 2026-06-02 prod incident where
    # anim-start failed with "Modal animation backend unreachable:
    # The operation was aborted due to timeout" when the rig fetch
    # from R2 + animate_mesh.spawn() chain hit the 120s ceiling on
    # a cold container restart after a fresh deploy.
    timeout=300,
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
        # 2026-06-02: use the .spawn.aio() async variant so the FastAPI
        # event loop isn't blocked while Modal enqueues the call. The
        # sync version was emitting "blocking Modal interface used in
        # async context" warnings and contributed to the 120s timeout.
        call = await animate_mesh.spawn.aio(in_bytes, anim_type, prompt, job_id=job_id)
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
