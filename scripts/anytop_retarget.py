"""AnyTop-canonical-BVH -> Puppeteer-rig glTF retargeter.

The default AnyTop pipeline trains class embeddings on ~75 SPECIFIC
artist-rigged skeletons (Dragon 142 joints, Lion 31, Horse 79, …).
Feeding our 47-joint Puppeteer rig with the right `--object_type` is
not enough — the structural conditioning (parents/offsets/mean/std)
in the trained class only makes sense on the original 3ds-Max-biped
topology and 3ds-Max-biped name vocabulary (`Bip01_R_Thigh`, `BN_Tail_03`).

Strategy 1 ("Mixamo-style"): let AnyTop generate motion on its native
trained skeleton, then RETARGET the per-frame rotations onto our
Puppeteer rig at the end. Puppeteer stays untouched (user constraint
[[dont-touch-puppeteer]]).

This file exposes a single function ``retarget_bvh_to_rig`` mounted
into the Modal anim container by ``modal_app/_anytop_anim.py``. The
container side picks the trained class, runs sample.generate, hands
the produced BVH here.

Algorithm:
  1. Parse the BVH (bvhsdk) -> source hierarchy + per-frame Euler
     rotations + rest-pose offsets.
  2. Classify EVERY source bone with ``_anatomical_role_from_bip01``
     which knows the AnyTop canonical naming conventions.
  3. Read the target GLB (skin 0) -> skin.joints[] + IBM positions.
  4. Classify every target bone with the SAME anatomical vocabulary
     using the topology heuristic shipped in
     ``modal_app/_anytop_anim.py:_anatomical_names`` (re-imported
     here so we never get vocabulary drift).
  5. For each TARGET bone with a role, pick the SOURCE bone with the
     same role (or closest chain index for spine/tail/wing/leg
     segments).
  6. For each frame, take source's parent-relative quaternion and
     apply it as target's local rotation. Sign-continuity enforced
     across frames so the Three.js mixer doesn't flip mid-clip.
  7. Embed as glTF AnimationClip alongside the original rig (skin and
     mesh untouched).

What this does NOT do:
  * Inverse kinematics: no IK passes. If source's leg span is wider
    than target's, the foot may slide. Acceptable MVP — the user can
    request a refine pass later.
  * Root translation re-targeting: we copy the source's root pos
    directly (BVH XYZ on the root joint) scaled by the bbox height
    ratio. Won't match perfectly but motion direction is preserved.
"""
from __future__ import annotations

import io
import json
import re
import struct
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np
from scipy.spatial.transform import Rotation as R


# ============================================================
# 1. Source-bone classifier — AnyTop canonical names -> roles
# ============================================================

_SIDE_TOKEN_L = re.compile(r"(_L_|_l_|Left|LeftLeg|LLeg|L_|_l$)", re.IGNORECASE)
_SIDE_TOKEN_R = re.compile(r"(_R_|_r_|Right|RightLeg|RLeg|R_|_r$)", re.IGNORECASE)

# Patterns observed in the bundled cond.npy keys (75+ classes,
# ~3ds-Max-Biped naming). Ordered so more specific first.
_NAME_PATTERNS = [
    # Pelvis / hip — the root of every trained skeleton.
    (re.compile(r"^(?:Bip01_Pelvis|Hips|NPC_Pelvis|N_ALL|locator|kosi|_body_|"
                r"BN_Bip01_Pelvis|Sabrecat__pelv_)$", re.I), "hip", 0),
    (re.compile(r"Pelvis|^Hips$", re.I), "hip", 0),
    # Spine chain
    (re.compile(r"Spine(\d+)", re.I), "spine", 1),
    (re.compile(r"Spine", re.I), "spine", 0),
    (re.compile(r"Neck(\d+)", re.I), "neck", 1),
    (re.compile(r"Neck", re.I), "neck", 0),
    (re.compile(r"Head", re.I), "head", 0),
    # Tail
    (re.compile(r"Tail[_]?(\d+)", re.I), "tail", 1),
    (re.compile(r"Tail", re.I), "tail", 0),
    # Wings (winged classes — Dragon/Bat/Bird/Eagle/Parrot/Pteranodon)
    (re.compile(r"Wing[_]?(\d+)", re.I), "wing", 1),
    (re.compile(r"Wing", re.I), "wing", 0),
    # Leg chain
    (re.compile(r"(Thigh|Femur|UpperLeg|HindLeg|HLeg|RearLeg|RLeg|Hind)", re.I), "leg", 1),
    (re.compile(r"(Calf|Tibia|LowerLeg|Shin|HorseLink|LLeg2)", re.I), "leg", 2),
    (re.compile(r"(Foot|Ankle|LLegAnkle)", re.I), "leg", 3),
    (re.compile(r"(Toe|LLegBall|Ball)", re.I), "leg", 4),
    # Arm chain (humanoid-like classes)
    (re.compile(r"(Clavicle|Shoulder|Scapula|Collarbone)", re.I), "arm", 0),
    (re.compile(r"(UpperArm|Humerus|Arm$|Bip01_[LR]_Arm)", re.I), "arm", 1),
    (re.compile(r"(Forearm|LowerArm|Elbow|Ulna)", re.I), "arm", 2),
    (re.compile(r"(Hand|Palm|Wrist)", re.I), "arm", 3),
    (re.compile(r"(Finger|Thumb|Index|Middle|Ring|Pinky)", re.I), "arm", 4),
    # Generic fallbacks
    (re.compile(r"^BN_leg_", re.I), "leg", 1),
    (re.compile(r"BodyEnd|^o$", re.I), "body", 0),
]


def _classify_source_bone(name: str) -> Tuple[str, Optional[str], int]:
    """Return (role, side_suffix, chain_index) for an AnyTop canonical
    bone name. role is one of: hip, spine, neck, head, tail, wing,
    arm, leg, body, ''. side_suffix is 'l' / 'r' / None. chain_index
    is the segment number along that chain (0 for root or unindexed)."""
    if not name:
        return ('', None, 0)
    # Strip common namespacing artefacts.
    n = name.strip().replace("Bip01_", "Bip01_").replace("BN_", "BN_")
    # Side detection.
    side: Optional[str] = None
    if _SIDE_TOKEN_L.search(n):
        side = 'l'
    elif _SIDE_TOKEN_R.search(n):
        side = 'r'
    # Match patterns.
    for pat, role, base_idx in _NAME_PATTERNS:
        m = pat.search(n)
        if not m:
            continue
        idx = base_idx
        # If the pattern captured a number group, use it.
        try:
            if m.lastindex and m.lastindex >= 1:
                grp = m.group(1)
                if grp and grp.isdigit():
                    idx = int(grp)
        except (IndexError, ValueError):
            pass
        return (role, side, idx)
    return ('', None, 0)


# ============================================================
# 2. BVH parser (bvhsdk) — extract hierarchy + per-frame Eulers
# ============================================================

def _parse_bvh(bvh_path: str) -> dict:
    """Return a dict with keys:
       names     : list[str]                 (BVH order, INCLUDING end-sites)
       parents   : list[int]                 (-1 for root)
       offsets   : np.ndarray (N, 3)         rest-pose parent-relative
       channels  : list[list[str]]           per-bone CHANNELS strings
       n_frames  : int
       frame_time: float                     seconds per frame
       euler     : np.ndarray (F, N, 3)      degrees, in each bone's CHANNELS order
       root_pos  : np.ndarray (F, 3)         from root's Xposition/Yposition/Zposition channels
    """
    import bvhsdk  # pulled in via Modal image (modal_app/_anytop_anim.py)
    bvh = bvhsdk.ReadFile(bvh_path)
    # Collect every joint INCLUDING end-sites in DFS order so indexing
    # matches what AnyTop writes (frames are arranged the same way).
    all_joints: List = []

    def _walk(j, parent_idx):
        idx = len(all_joints)
        all_joints.append((j, parent_idx))
        for c in (j.children or []):
            _walk(c, idx)
    _walk(bvh.root, -1)

    n = len(all_joints)
    names = [j.name for j, _ in all_joints]
    parents = [p for _, p in all_joints]
    offsets = np.zeros((n, 3), dtype=np.float64)
    channels = []
    for i, (j, _) in enumerate(all_joints):
        try:
            offsets[i] = np.asarray(j.offset, dtype=np.float64)
        except Exception:
            offsets[i] = (0.0, 0.0, 0.0)
        channels.append(list(j.channels) if j.channels else [])

    n_frames = int(bvh.frames)
    frame_time = float(bvh.frametime)
    eul = np.zeros((n_frames, n, 3), dtype=np.float64)
    root_pos = np.zeros((n_frames, 3), dtype=np.float64)
    for i, (j, _) in enumerate(all_joints):
        if not j.channels:
            continue
        # bvhsdk exposes per-joint rotation array in CHANNELS order (degrees).
        try:
            rot = np.asarray(j.rotation, dtype=np.float64)  # (F, 3)
            if rot.shape[0] == n_frames and rot.shape[1] == 3:
                eul[:, i, :] = rot
        except Exception:
            pass
        if i == 0:
            try:
                tr = np.asarray(j.translation, dtype=np.float64)  # (F, 3)
                if tr.shape[0] == n_frames and tr.shape[1] == 3:
                    root_pos = tr
            except Exception:
                pass

    return {
        "names": names, "parents": parents, "offsets": offsets,
        "channels": channels, "n_frames": n_frames, "frame_time": frame_time,
        "euler": eul, "root_pos": root_pos,
    }


def _eulers_to_quats(euler_deg: np.ndarray, channel_order: List[str]) -> np.ndarray:
    """euler_deg: (F, 3) in CHANNELS order. Return quats (F, 4) (xyzw)."""
    order = ''
    for ch in channel_order:
        c = ch.lower()
        if 'rotation' not in c and 'rot' not in c:
            continue
        if 'x' in c:
            order += 'x'
        elif 'y' in c:
            order += 'y'
        elif 'z' in c:
            order += 'z'
    if len(order) != 3:
        order = 'zxy'  # bvhsdk default
    # scipy: lowercase = intrinsic (matches BVH convention).
    try:
        q = R.from_euler(order, euler_deg, degrees=True).as_quat()
    except Exception:
        q = np.tile([0.0, 0.0, 0.0, 1.0], (euler_deg.shape[0], 1))
    # Sign-continuity across frames.
    for i in range(1, q.shape[0]):
        if np.dot(q[i], q[i - 1]) < 0.0:
            q[i] = -q[i]
    return q


# ============================================================
# 3. glTF reader/writer (header-only, minimal deps)
# ============================================================

def _read_glb(glb_path: str) -> Tuple[dict, bytes, bytes]:
    with open(glb_path, "rb") as f:
        head = f.read(12)
        if len(head) < 12 or head[:4] != b'glTF':
            raise RuntimeError(f"not a binary glTF: {glb_path}")
        # Read JSON chunk
        ch_len = struct.unpack("<I", f.read(4))[0]
        ch_type = f.read(4)
        if ch_type != b'JSON':
            raise RuntimeError("first chunk is not JSON")
        json_blob = f.read(ch_len).rstrip(b'\x00')
        gltf = json.loads(json_blob.decode('utf-8'))
        # Bin chunk (optional).
        bin_blob = b''
        try:
            b_len = struct.unpack("<I", f.read(4))[0]
            b_type = f.read(4)
            if b_type == b'BIN\x00':
                bin_blob = f.read(b_len)
        except struct.error:
            pass
    return gltf, json_blob, bin_blob


def _read_accessor_floats(gltf: dict, bin_blob: bytes, acc_idx: int) -> np.ndarray:
    acc = gltf["accessors"][acc_idx]
    bv = gltf["bufferViews"][acc["bufferView"]]
    offs = (bv.get("byteOffset", 0) or 0) + (acc.get("byteOffset", 0) or 0)
    cnt = acc["count"]
    typ_to_n = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
    n_per = typ_to_n.get(acc["type"], 1)
    fmt = f"<{cnt * n_per}f"
    sz = 4 * cnt * n_per
    raw = bin_blob[offs:offs + sz]
    if len(raw) < sz:
        raise RuntimeError(f"accessor {acc_idx} underflow")
    return np.asarray(struct.unpack(fmt, raw), dtype=np.float32)


def _add_buffer_view(gltf: dict, bin_data: bytearray, payload: bytes) -> int:
    # Pad to 4-byte boundary for valid glTF.
    while len(bin_data) % 4 != 0:
        bin_data.append(0)
    offset = len(bin_data)
    bin_data.extend(payload)
    while len(bin_data) % 4 != 0:
        bin_data.append(0)
    bv = {"buffer": 0, "byteOffset": offset, "byteLength": len(payload)}
    gltf.setdefault("bufferViews", []).append(bv)
    return len(gltf["bufferViews"]) - 1


def _add_accessor(gltf: dict, bv_idx: int, count: int,
                  comp_type: int, acc_type: str,
                  minv: Optional[List[float]] = None,
                  maxv: Optional[List[float]] = None) -> int:
    acc = {"bufferView": bv_idx, "byteOffset": 0,
           "componentType": comp_type, "count": count, "type": acc_type}
    if minv is not None:
        acc["min"] = minv
    if maxv is not None:
        acc["max"] = maxv
    gltf.setdefault("accessors", []).append(acc)
    return len(gltf["accessors"]) - 1


def _write_glb(gltf: dict, bin_data: bytes, out_path: str) -> None:
    # Update buffer 0 byteLength.
    while len(bin_data) % 4 != 0:
        bin_data = bin_data + b'\x00'
    bufs = gltf.get("buffers") or []
    if not bufs:
        gltf["buffers"] = [{"byteLength": len(bin_data)}]
    else:
        bufs[0]["byteLength"] = len(bin_data)
        bufs[0].pop("uri", None)
    json_blob = json.dumps(gltf, separators=(',', ':')).encode('utf-8')
    while len(json_blob) % 4 != 0:
        json_blob += b' '
    total = 12 + 8 + len(json_blob) + 8 + len(bin_data)
    with open(out_path, "wb") as f:
        f.write(b'glTF')
        f.write(struct.pack("<I", 2))
        f.write(struct.pack("<I", total))
        f.write(struct.pack("<I", len(json_blob)))
        f.write(b'JSON')
        f.write(json_blob)
        f.write(struct.pack("<I", len(bin_data)))
        f.write(b'BIN\x00')
        f.write(bin_data)


# ============================================================
# 4. Target rig anatomical classification (replays the helper from
#    modal_app/_anytop_anim.py so vocabulary stays in lockstep).
# ============================================================

def _target_anatomical_roles(joint_node_idxs: List[int], parent_by_idx: Dict[int, int],
                             world_by_idx: Dict[int, np.ndarray],
                             ckpt_family: str = 'all') -> Dict[int, Tuple[str, Optional[str], int]]:
    """Same heuristic as modal_app/_anytop_anim.py:_anatomical_names but
    returns structured (role, side, idx) tuples instead of strings so
    the role-matching in step 5 doesn't have to re-parse names."""
    if not joint_node_idxs:
        return {}
    pos = {ji: np.asarray(world_by_idx.get(ji, [0.0, 0.0, 0.0]), dtype=np.float32)
           for ji in joint_node_idxs}
    arr = np.array([pos[ji] for ji in joint_node_idxs])
    bb_min, bb_max = arr.min(axis=0), arr.max(axis=0)
    size = bb_max - bb_min
    # See modal_app/_anytop_anim.py:_anatomical_names — both hard-pinned
    # to Y-up + X-side per glTF convention so role classification
    # matches between source and target (and between this and
    # _detect_topology_family). Auto-detecting either axis breaks on
    # tail-elongated rigs (dragon: Z > X) — left/right detection
    # scrambles and 0 wings/legs get classified.
    up_axis = 1
    side_axis = 0
    body_h = max(float(size[up_axis]), 1e-6)
    UP = lambda v: float(v[up_axis])
    SIDE = lambda v: float(v[side_axis])

    children = {ji: [] for ji in joint_node_idxs}
    for ji in joint_node_idxs:
        p = parent_by_idx.get(ji, -1)
        if p in children:
            children[p].append(ji)
    roots = [ji for ji in joint_node_idxs if parent_by_idx.get(ji, -1) not in joint_node_idxs]
    root = roots[0] if roots else joint_node_idxs[0]
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

    def on_axis_chain(ji, up=True):
        chain = [ji]
        cur = ji
        while children[cur]:
            kids = [c for c in children[cur]
                    if abs(SIDE(pos[c]) - root_side) <= side_gate
                    and ((UP(pos[c]) >= UP(pos[cur]) - body_h * 0.02) if up
                         else (UP(pos[c]) <= UP(pos[cur]) + body_h * 0.02))]
            if not kids:
                break
            best = max(kids, key=lambda c: len(descendants(c)))
            chain.append(best)
            cur = best
        return chain

    spine = on_axis_chain(root, up=True)
    spine_set = set(spine)
    tail_root = None
    for kid in children[root]:
        if kid in spine_set:
            continue
        if abs(SIDE(pos[kid]) - root_side) > side_gate:
            continue
        ch_test = longest_chain(kid)
        end_p = pos[ch_test[-1]]
        if UP(end_p) <= UP(pos[root]) + body_h * 0.05 and len(ch_test) >= 2:
            tail_root = kid
            break
    tail = on_axis_chain(tail_root, up=False) if tail_root is not None else []

    # 2026-06-02 (re-applied after basis-fix workflow stomped this):
    # Collect ANY non-spine/non-tail kid whose CHAIN has lateral span
    # OR tips below root. The strict `side_gate` check on the FIRST
    # bone dropped legs because the hip joint sits ~centerline; only
    # knee/foot bones extend sideways. Decide L/R from the chain's
    # most-lateral bone instead of the first one.
    used = set(spine) | set(tail)
    laterals = []
    for sp_ni in spine:
        for k in children[sp_ni]:
            if k in used:
                continue
            ch = longest_chain(k)
            span = max(abs(SIDE(pos[c]) - root_side) for c in ch)
            tip_below = UP(pos[ch[-1]]) < UP(pos[root]) - body_h * 0.02
            if span <= side_gate and not tip_below:
                continue
            far_bone = max(ch, key=lambda c: abs(SIDE(pos[c]) - root_side))
            side_val = SIDE(pos[far_bone]) - root_side
            if abs(side_val) < 1e-4:
                side_val = SIDE(pos[k]) - root_side
            laterals.append({
                'chain': ch,
                'attach': UP(pos[sp_ni]),
                'tip': UP(pos[ch[-1]]),
                'len': len(ch),
                'sign': side_val,
            })
    print(f"[retarget] anatomical: spine={len(spine)} tail={len(tail)} "
          f"laterals_collected={len(laterals)} from {sum(len(children[sp]) for sp in spine)} candidates",
          flush=True)

    left = [c for c in laterals if c['sign'] > 0]
    right = [c for c in laterals if c['sign'] <= 0]
    spine_top = UP(pos[spine[-1]]) if spine else UP(pos[root])
    spine_btm = UP(pos[spine[0]])
    midline = spine_btm + 0.5 * (spine_top - spine_btm)

    def split_all(chs):
        # Direction-based split: legs go DOWN from their attach
        # (rise = tip - attach < 0), wings/arms stay at or above the
        # attach. Returns ALL chains per category so quadrupeds with
        # front + back legs both get labeled.
        upper, lower = [], []
        root_up = UP(pos[root])
        for c in chs:
            rise = c['tip'] - c['attach']
            tip_below_root = c['tip'] < root_up - body_h * 0.05
            tip_above_root = c['tip'] > root_up + body_h * 0.1
            if rise < -body_h * 0.05 or tip_below_root:
                lower.append(c)
            elif rise > body_h * 0.05 or tip_above_root:
                upper.append(c)
            else:
                # Ambiguous (near-horizontal): longer chains tend to
                # be wings/arms; short stubs are usually feet.
                (upper if c['len'] >= 4 else lower).append(c)
        upper.sort(key=lambda c: (-c['len'], -c['attach']))
        lower.sort(key=lambda c: (-c['len'], -c['attach']))
        return upper, lower

    upper_l_list, lower_l_list = split_all(left)
    upper_r_list, lower_r_list = split_all(right)
    upper_role = 'wing' if ckpt_family == 'flying' else 'arm'

    roles: Dict[int, Tuple[str, Optional[str], int]] = {}
    roles[root] = ('hip', None, 0)
    sp = list(spine[1:])
    if sp:
        head = None
        if UP(pos[sp[-1]]) >= spine_top - body_h * 0.02 and not children[sp[-1]]:
            head = sp.pop()
        neck_n = min(2, max(1, len(sp) // 6))
        spine_n = max(0, len(sp) - neck_n)
        for i in range(spine_n):
            roles[sp[i]] = ('spine', None, i + 1)
        for j in range(neck_n):
            roles[sp[spine_n + j]] = ('neck', None, j + 1)
        if head is not None:
            roles[head] = ('head', None, 0)
    for i, ni in enumerate(tail):
        roles[ni] = ('tail', None, i + 1)
    # Enumerate ALL upper/lower chains per side with continuous
    # chain_idx so each target bone gets a UNIQUE (role, side, idx) —
    # a dragon's 2 legs per side both become leg_l_01..N then
    # leg_l_(N+1)..M, etc. Without this enumeration, the second leg
    # falls through to the unmapped 'limb' bucket.
    def _label(chains_list, role, side):
        off = 0
        for rec in chains_list:
            for i, ni in enumerate(rec['chain']):
                roles[ni] = (role, side, off + i + 1)
            off += len(rec['chain'])
    _label(upper_l_list, upper_role, 'l')
    _label(upper_r_list, upper_role, 'r')
    _label(lower_l_list, 'leg', 'l')
    _label(lower_r_list, 'leg', 'r')
    return roles


# ============================================================
# 5. Role matching
# ============================================================

def _match_targets_to_sources(
    src_roles: Dict[int, Tuple[str, Optional[str], int]],   # src_bvh_idx -> (role, side, idx)
    tgt_roles: Dict[int, Tuple[str, Optional[str], int]],   # tgt_node_idx -> (role, side, idx)
) -> Dict[int, int]:
    """For every target bone with a role, pick the BEST source bone:
      * same role + same side, closest chain index
      * fallback: same role, ignore side
      * fallback: hip -> hip, head -> head (sideless)
    Returns dict target_node_idx -> source_bvh_idx. Unmapped targets stay
    pinned to their rest pose."""
    # Group sources by (role, side).
    by_role: Dict[Tuple[str, Optional[str]], List[Tuple[int, int]]] = {}
    for sidx, (role, side, idx) in src_roles.items():
        if not role:
            continue
        by_role.setdefault((role, side), []).append((idx, sidx))
    # Also a sideless bucket: collect both sides into 'any'.
    by_role_any: Dict[str, List[Tuple[int, int]]] = {}
    for sidx, (role, side, idx) in src_roles.items():
        if not role:
            continue
        by_role_any.setdefault(role, []).append((idx, sidx))

    out: Dict[int, int] = {}
    for tni, (role, side, idx) in tgt_roles.items():
        if not role:
            continue
        cand = by_role.get((role, side), [])
        if not cand:
            cand = by_role_any.get(role, [])
        if not cand:
            continue
        # Pick closest chain index.
        best = min(cand, key=lambda kv: abs(kv[0] - idx))
        out[tni] = best[1]
    return out


# ============================================================
# 6. Main entry point — called by Modal animate_mesh post-sample
# ============================================================

def retarget_bvh_to_rig(
    rig_glb_path: str,
    bvh_path: str,
    out_glb_path: str,
    clip_name: str = "clip",
    target_fps: float = 30.0,
    ckpt_family: str = 'all',
) -> None:
    """Read AnyTop's BVH, read the user's Puppeteer GLB, retarget the
    BVH motion onto the GLB's skin, and write the result GLB.

    Thin wrapper over `retarget_motion_to_rig` for the BVH path —
    kept so existing callers in `modal_app/_anytop_anim.py` continue
    to compile. The FBX path goes through `retarget_fbx_to_rig` which
    also funnels into `retarget_motion_to_rig` with a different
    source_classifier."""
    print(f"[retarget] reading bvh: {bvh_path}")
    motion = _parse_bvh(bvh_path)
    return retarget_motion_to_rig(
        rig_glb_path=rig_glb_path,
        motion=motion,
        out_glb_path=out_glb_path,
        clip_name=clip_name,
        target_fps=target_fps,
        ckpt_family=ckpt_family,
        source_classifier=None,  # use default _classify_source_bone
    )


def retarget_fbx_to_rig(
    rig_glb_path: str,
    fbx_path: str,
    out_glb_path: str,
    source_skel_id: str = "ue5_mannequin",
    target_family: str = "humanoid_puppeteer",
    clip_name: str = "clip",
    target_fps: float = 30.0,
    ckpt_family: str = 'all',
) -> dict:
    """Retarget an FBX animation onto a Puppeteer GLB. Reuses
    `retarget_motion_to_rig` so the BVH path and the FBX path share
    100% of the heavy lifting (target classification, swing-twist
    decomposition, glTF AnimationClip emission).

    Args:
      rig_glb_path: input Puppeteer rig GLB.
      fbx_path: input reference animation (.fbx).
      out_glb_path: where to write the animated GLB.
      source_skel_id: 'ue5_mannequin' | 'orc_m1' | 'auto'. 'auto' runs
        the fingerprint inside parse_fbx.
      target_family: 'humanoid_puppeteer' (V1) | 'winged_puppeteer'
        (future) — passed to `load_mapping`.
      clip_name, target_fps, ckpt_family: forwarded to
        `retarget_motion_to_rig`.

    Returns:
      A dict with `mapped_pairs` (int), `detected_skeleton_id` (str),
      `source_skel_id_used` (str) — surfaced to the caller / UI for
      diagnostics.
    """
    # Lazy import — keeps the parent retarget module usable in Modal
    # containers that don't ship the rig_mappings package.
    # Modal mounts `scripts/` via add_local_python_source("scripts"),
    # so the package-qualified form (`scripts.fbx_motion`) is the only
    # one that resolves there. We try both to stay compatible with
    # local CLI runs where `scripts/` itself is on sys.path.
    try:
        from scripts.fbx_motion import parse_fbx  # type: ignore
        from scripts.rig_mappings import load_mapping, make_classifier_chain  # type: ignore
    except ImportError:
        from fbx_motion import parse_fbx  # type: ignore
        from rig_mappings import load_mapping, make_classifier_chain  # type: ignore

    print(f"[retarget_fbx] parsing FBX: {fbx_path} hint={source_skel_id}")
    motion = parse_fbx(fbx_path, source_skel_hint=source_skel_id)
    detected = motion.get("detected_skeleton_id")

    # Resolve which mapping to use. 'auto' -> fingerprint; else trust
    # the caller. Fall back to UE5 mannequin on a miss so we never
    # 500 — degraded retarget is better than failed retarget.
    effective_skel = source_skel_id
    if source_skel_id == "auto":
        effective_skel = detected or "ue5_mannequin"
    try:
        mapping = load_mapping(effective_skel, target_family)
    except KeyError:
        print(f"[retarget_fbx] WARN no mapping for ({effective_skel},{target_family}); "
              f"falling back to ue5_mannequin", flush=True)
        effective_skel = "ue5_mannequin"
        mapping = load_mapping(effective_skel, target_family)

    # Apply the axis-convention rotation to OFFSETS and ROOT_POS so
    # the retarget core's FK pass sees a pre-rotated Y-up rest pose.
    # Per-bone PARENT-RELATIVE rotations are axis-system-invariant
    # once the world rest is rotated consistently — leave the euler
    # array alone.
    if mapping.axis_source != mapping.axis_target:
        try:
            motion["offsets"] = mapping.axis_to_target(motion["offsets"])
            motion["root_pos"] = mapping.axis_to_target(motion["root_pos"])
            print(f"[retarget_fbx] axis rotation applied: "
                  f"{mapping.axis_source} -> {mapping.axis_target}", flush=True)
        except Exception as e:
            print(f"[retarget_fbx] WARN axis rotation failed: {e}", flush=True)

    # Build the two-stage classifier: mapping first, _classify_source_bone fallback.
    classifier = make_classifier_chain(mapping, _classify_source_bone)

    retarget_motion_to_rig(
        rig_glb_path=rig_glb_path,
        motion=motion,
        out_glb_path=out_glb_path,
        clip_name=clip_name,
        target_fps=target_fps,
        ckpt_family=ckpt_family,
        source_classifier=classifier,
        target_table=mapping.target_table,
        target_drop_re=mapping.target_drop_re,
    )
    return {
        "detected_skeleton_id": detected,
        "source_skel_id_used": effective_skel,
        "target_family": target_family,
        "n_frames": int(motion.get("n_frames", 0)),
    }


def retarget_motion_to_rig(
    rig_glb_path: str,
    motion: dict,
    out_glb_path: str,
    clip_name: str = "clip",
    target_fps: float = 30.0,
    ckpt_family: str = 'all',
    source_classifier: Optional[Callable[[str], Tuple[str, Optional[str], int]]] = None,
    target_table: Optional[Dict[str, Tuple[str, Optional[str], int]]] = None,
    target_drop_re: "Optional[re.Pattern]" = None,
) -> None:
    """Generic retarget core: take a parsed motion dict (BVH or FBX),
    read the Puppeteer GLB, append an AnimationClip.

    The motion dict must have these keys (matches `_parse_bvh`):
      names, parents, offsets, channels, n_frames, frame_time,
      euler, root_pos.

    `source_classifier` is the function that takes a source bone name
    and returns (role, side, chain_idx). If None, falls back to the
    built-in `_classify_source_bone` (AnyTop canonical vocab).

    The GLB's mesh, materials, skin, and bone hierarchy are kept
    BYTE-IDENTICAL — we only append a new AnimationClip referencing
    the existing nodes."""
    # Two-stage classifier: caller-provided first, generic fallback
    # second. Lets the FBX path use a JSON-driven mapping while
    # unknown bones still benefit from the AnyTop generic regex.
    _classify = source_classifier or _classify_source_bone

    print(f"[retarget] reading rig: {rig_glb_path}")
    gltf, _json_blob, bin_blob = _read_glb(rig_glb_path)
    skins = gltf.get("skins") or []
    if not skins:
        raise RuntimeError("GLB has no skin to retarget onto")
    skin = skins[0]
    joint_node_idxs: List[int] = list(skin.get("joints") or [])
    nodes = gltf.get("nodes") or []
    name_by_idx = {i: (nodes[i].get("name") or f"node_{i}") for i in joint_node_idxs}
    parent_by_idx = {i: -1 for i in joint_node_idxs}
    for parent_idx in joint_node_idxs:
        for child in (nodes[parent_idx].get("children") or []):
            if child in joint_node_idxs:
                parent_by_idx[child] = parent_idx

    # World bind positions AND world rest rotations for the target.
    # Puppeteer-rigged GLBs never write node.rotation — the rest
    # orientation of every bone lives ENTIRELY inside the
    # inverseBindMatrices. Recovering it here is the only way the
    # per-frame retarget can produce a correct bind-pose at frame 0.
    world_by_idx: Dict[int, np.ndarray] = {}
    world_rot_by_idx: Dict[int, np.ndarray] = {}
    ibm_acc = skin.get("inverseBindMatrices")
    if ibm_acc is not None:
        ibm_flat = _read_accessor_floats(gltf, bin_blob, ibm_acc)
        ibm_mats = np.asarray(ibm_flat).reshape(len(joint_node_idxs), 4, 4)
        ibm_mats = np.transpose(ibm_mats, (0, 2, 1))
        for k, jidx in enumerate(joint_node_idxs):
            try:
                world_mat = np.linalg.inv(ibm_mats[k])
                world_by_idx[jidx] = world_mat[:3, 3].astype(np.float64)
                # Polar-decompose the rotation block to strip any
                # scale or shear that sloppy rig authoring might have
                # baked into the bind matrix. SVD gives the closest
                # orthonormal rotation in Frobenius norm.
                M = world_mat[:3, :3].astype(np.float64)
                U, _, Vt = np.linalg.svd(M)
                Rmat = U @ Vt
                # Force a right-handed rotation (det = +1). SVD on a
                # reflection produces a mirror; flipping the smallest
                # singular column fixes it.
                if np.linalg.det(Rmat) < 0:
                    U[:, -1] *= -1
                    Rmat = U @ Vt
                world_rot_by_idx[jidx] = Rmat
            except Exception:
                world_by_idx[jidx] = np.array([0.0, 0.0, 0.0], dtype=np.float64)
                world_rot_by_idx[jidx] = np.eye(3)
    for jidx in joint_node_idxs:
        if jidx not in world_by_idx:
            tr = nodes[jidx].get("translation") or [0.0, 0.0, 0.0]
            world_by_idx[jidx] = np.asarray(tr, dtype=np.float64)
        if jidx not in world_rot_by_idx:
            world_rot_by_idx[jidx] = np.eye(3)

    # `motion` is the parsed source (BVH or FBX). Same schema for both
    # paths so the rest of this function is source-agnostic. `bvh` is
    # kept as the local variable name for blame-friendly diffs.
    bvh = motion
    n_frames = bvh["n_frames"]
    if n_frames <= 0:
        raise RuntimeError("motion has 0 frames")
    print(f"[retarget] motion: bones={len(bvh['names'])} frames={n_frames} "
          f"frame_time={bvh.get('frame_time')}", flush=True)

    # Classify source + target.
    src_roles: Dict[int, Tuple[str, Optional[str], int]] = {}
    for sidx, sname in enumerate(bvh["names"]):
        src_roles[sidx] = _classify(sname)

    # ---- Renumber source bones per (role, side) by depth-from-root ----
    # The regex classifier has two known bugs that collapse multiple
    # bones onto the same chain_idx:
    #   (a) `Wing` (no captured digit) falls through to idx=0 so every
    #       single wing bone (clavicle..forearm..hand..fingertip) ends
    #       up at chain_idx=0 -> every target wing bone maps to the SAME
    #       source bone -> wings concertina-explode.
    #   (b) `Calf` and `HorseLink` are both pinned to base_idx=2 -> dragon
    #       legs get duplicated mapping.
    # Fix: for every (role, side) chain with non-unique indices, walk
    # back to the chain root in the BVH hierarchy and renumber by depth.
    bvh_parents_list = bvh["parents"]
    _ROLES_TO_RENUMBER = {"wing", "arm", "leg", "tail", "spine", "neck"}

    def _chain_root(s: int) -> int:
        role_s, side_s, _ = src_roles[s]
        cur = s
        while True:
            p = bvh_parents_list[cur]
            if p < 0:
                return cur
            pr, psd, _ = src_roles.get(p, ('', None, 0))
            if pr != role_s or psd != side_s:
                return cur
            cur = p

    def _depth_from(s: int, root: int) -> int:
        d, cur = 0, s
        # Hard cap so a malformed BVH cannot infinite-loop.
        for _ in range(1024):
            if cur == root or bvh_parents_list[cur] < 0:
                return d
            cur = bvh_parents_list[cur]
            d += 1
        return d

    # Bucket by (role, side, chain_root) so distinct symmetric chains
    # (e.g. left vs right wings) don't get merged.
    chains: Dict[Tuple[str, Optional[str], int], List[int]] = {}
    for s, (role, side, _) in src_roles.items():
        if role not in _ROLES_TO_RENUMBER:
            continue
        key = (role, side, _chain_root(s))
        chains.setdefault(key, []).append(s)

    # Merge across chain-roots within the same (role, side) so we get
    # one ordered list per (role, side). Within each bucket, sort by
    # depth-from-its-own-root. Sort chains by their root's BVH index
    # so the renumbering is deterministic across runs.
    by_rs: Dict[Tuple[str, Optional[str]], List[int]] = {}
    for (role, side, root), bones in sorted(chains.items(), key=lambda kv: kv[0][2]):
        bones.sort(key=lambda b: _depth_from(b, root))
        by_rs.setdefault((role, side), []).extend(bones)

    for (role, side), bones in by_rs.items():
        cur_idxs = [src_roles[b][2] for b in bones]
        # If indices are already all distinct AND none is 0 (the
        # Wing fallback sentinel), trust the regex.
        if len(set(cur_idxs)) == len(cur_idxs) and 0 not in cur_idxs:
            continue
        for n, b in enumerate(bones, start=1):
            r_b, sd_b, _ = src_roles[b]
            src_roles[b] = (r_b, sd_b, n)

    tgt_roles = _target_anatomical_roles(
        joint_node_idxs, parent_by_idx, world_by_idx, ckpt_family=ckpt_family
    )

    # JSON-driven overlay: explicit per-bone classification from the
    # mapping JSON wins over the geometric heuristic. The geometric
    # `_target_anatomical_roles` mis-tags the humanoid left leg as
    # 'tail' (its centerline + below-root chain heuristic at
    # anytop_retarget.py:402-415 picks `thigh_l` as a tail root and
    # breaks, so calf_l/foot_l/ball_l also fall under 'tail'/None) and
    # silently drops ball_l from the role table; clavicle_l gets
    # mistaken for 'neck'. Overlay only fires when a target_table is
    # supplied — unknown rigs keep the geometric fallback.
    if target_table:
        # Iterate over the union of currently-classified joints and the
        # full joint list so bones missing from the geometric pass
        # (e.g. ball_l) can be added back via the JSON table.
        all_joints = list(tgt_roles.keys()) + [
            j for j in joint_node_idxs if j not in tgt_roles
        ]
        for tni in all_joints:
            lower = (name_by_idx.get(tni) or "").strip().lower()
            if target_drop_re is not None and lower and target_drop_re.search(lower):
                tgt_roles.pop(tni, None)
                continue
            if lower in target_table:
                tgt_roles[tni] = target_table[lower]

    # Log a summary so the user can diagnose missing matches.
    src_role_count: Dict[str, int] = {}
    for r, _, _ in src_roles.values():
        if r:
            src_role_count[r] = src_role_count.get(r, 0) + 1
    tgt_role_count: Dict[str, int] = {}
    for r, _, _ in tgt_roles.values():
        if r:
            tgt_role_count[r] = tgt_role_count.get(r, 0) + 1
    print(f"[retarget] src roles: {src_role_count}")
    print(f"[retarget] tgt roles: {tgt_role_count}")

    # Match.
    mapping = _match_targets_to_sources(src_roles, tgt_roles)
    print(f"[retarget] matched {len(mapping)}/{len(tgt_roles)} target bones to source")

    # Pre-compute source quats (F, N_src, 4).
    src_quats: Dict[int, np.ndarray] = {}
    eul = bvh["euler"]            # (F, N, 3)
    channels = bvh["channels"]    # list[N]
    for sidx in set(mapping.values()):
        src_quats[sidx] = _eulers_to_quats(eul[:, sidx, :], channels[sidx])

    # ---------------- Quaternion helpers ----------------
    def _q_mul(a: np.ndarray, b: np.ndarray) -> np.ndarray:
        """Hamilton product, (x,y,z,w) convention to match glTF."""
        ax, ay, az, aw = a
        bx, by, bz, bw = b
        return np.array([
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz,
        ])

    def _q_inv(q: np.ndarray) -> np.ndarray:
        x, y, z, w = q
        n = x * x + y * y + z * z + w * w
        if n < 1e-12:
            return np.array([0.0, 0.0, 0.0, 1.0])
        return np.array([-x, -y, -z, w]) / n

    def _swing_twist(q: np.ndarray, axis: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
        """Decompose q into (swing, twist) around `axis` (unit vector).
        q = swing * twist where:
          twist = rotation about `axis`
          swing = rotation that takes axis to its new direction (axis-changing)
        Returns (swing_q, twist_q). axis MUST be a unit vector in the
        SAME frame as q (typically the parent-local frame).

        Used 2026-06-02 for retargeting: source bones in AnyTop's
        artist-rigged Dragon often carry rest-pose twists that don't
        exist on our Puppeteer rig. Transferring the full delta
        propagates those twists onto the wrong axes (-> "moves in all
        directions"). Transferring only the swing keeps the
        directional intent and discards the spin-around-axis component.
        """
        # Project q's vector part onto axis to build the twist quaternion.
        vx, vy, vz, vw = float(q[0]), float(q[1]), float(q[2]), float(q[3])
        v = np.array([vx, vy, vz], dtype=np.float64)
        proj = float(np.dot(v, axis))
        twist = np.array([proj * axis[0], proj * axis[1], proj * axis[2], vw], dtype=np.float64)
        n = np.linalg.norm(twist)
        if n < 1e-9:
            twist = np.array([0.0, 0.0, 0.0, 1.0])
        else:
            twist = twist / n
        # swing = q * inv(twist)
        swing = _q_mul(q, _q_inv(twist))
        # Normalize for safety.
        sn = np.linalg.norm(swing)
        if sn > 1e-9:
            swing = swing / sn
        else:
            swing = np.array([0.0, 0.0, 0.0, 1.0])
        return swing, twist

    def _quat_from_mat(Rm: np.ndarray) -> np.ndarray:
        """Convert a 3x3 rotation matrix to a glTF-style (x,y,z,w) quat.
        Shepperd's branchless-friendly method, returns a unit quaternion.
        """
        # Defensive: if the matrix is garbage (NaN, zero), return identity.
        if not np.all(np.isfinite(Rm)):
            return np.array([0.0, 0.0, 0.0, 1.0])
        tr = Rm[0, 0] + Rm[1, 1] + Rm[2, 2]
        if tr > 0.0:
            s = np.sqrt(tr + 1.0) * 2.0
            w = 0.25 * s
            x = (Rm[2, 1] - Rm[1, 2]) / s
            y = (Rm[0, 2] - Rm[2, 0]) / s
            z = (Rm[1, 0] - Rm[0, 1]) / s
        elif Rm[0, 0] > Rm[1, 1] and Rm[0, 0] > Rm[2, 2]:
            s = np.sqrt(1.0 + Rm[0, 0] - Rm[1, 1] - Rm[2, 2]) * 2.0
            w = (Rm[2, 1] - Rm[1, 2]) / s
            x = 0.25 * s
            y = (Rm[0, 1] + Rm[1, 0]) / s
            z = (Rm[0, 2] + Rm[2, 0]) / s
        elif Rm[1, 1] > Rm[2, 2]:
            s = np.sqrt(1.0 + Rm[1, 1] - Rm[0, 0] - Rm[2, 2]) * 2.0
            w = (Rm[0, 2] - Rm[2, 0]) / s
            x = (Rm[0, 1] + Rm[1, 0]) / s
            y = 0.25 * s
            z = (Rm[1, 2] + Rm[2, 1]) / s
        else:
            s = np.sqrt(1.0 + Rm[2, 2] - Rm[0, 0] - Rm[1, 1]) * 2.0
            w = (Rm[1, 0] - Rm[0, 1]) / s
            x = (Rm[0, 2] + Rm[2, 0]) / s
            y = (Rm[1, 2] + Rm[2, 1]) / s
            z = 0.25 * s
        q = np.array([x, y, z, w], dtype=np.float64)
        n = np.linalg.norm(q)
        if n < 1e-12:
            return np.array([0.0, 0.0, 0.0, 1.0])
        return q / n

    # ---------- TARGET rest rotations from IBM ----------
    # Puppeteer's skin never writes node.rotation: the rig's rest
    # orientation lives entirely in inverseBindMatrices. Build:
    #   tgt_rest_quat[tni]  = parent-relative LOCAL rest (what we
    #                          multiply animation deltas onto)
    #   tgt_world_rest[tni] = bone's world-space rest rotation
    #                          (basis-change reference vs source)
    tgt_rest_quat: Dict[int, np.ndarray] = {}
    tgt_world_rest: Dict[int, np.ndarray] = {}
    for tni in joint_node_idxs:
        Rw = world_rot_by_idx.get(tni, np.eye(3))
        tgt_world_rest[tni] = _quat_from_mat(Rw)
        p = parent_by_idx.get(tni, -1)
        if p < 0 or p not in world_rot_by_idx:
            Rp = np.eye(3)
        else:
            Rp = world_rot_by_idx[p]
        # Local rest = R_parent^T * R_world  (parent-to-self rotation)
        R_local = Rp.T @ Rw
        tgt_rest_quat[tni] = _quat_from_mat(R_local)

    # ---------- SOURCE world rest rotation via FK on BVH frame 0 ----------
    # The BVH's frame-0 local quaternion IS the AnyTop class T-pose
    # (wings folded, tails curled, …). Composing them along the BVH
    # parent chain yields each bone's world-space rest orientation,
    # which the basis change needs as a reference.
    #
    # Critical: we need frame-0 quats for EVERY ancestor of every
    # mapped bone, not just the mapped ones — otherwise FK would
    # silently treat unmapped intermediate bones as identity rotation
    # and the world rest of mapped descendants would be wrong.
    src_world_rest: Dict[int, np.ndarray] = {}
    bvh_parents_for_fk = bvh["parents"]
    n_src = len(bvh["names"])
    bvh_channels = bvh["channels"]
    bvh_eul0 = bvh["euler"][0]   # (N_src, 3) — frame 0 Eulers in CHANNELS order
    # Process in topological order. _parse_bvh emits joints in DFS
    # order so parents always come before children. Compose each
    # bone's local frame-0 quat onto its parent's world rest.
    for sidx in range(n_src):
        if sidx in src_quats:
            q_local0 = src_quats[sidx][0]
        else:
            # Compute the local frame-0 quat on demand from this
            # bone's Euler row + channel order so FK is correct
            # through unmapped intermediate joints.
            try:
                q_local0 = _eulers_to_quats(
                    bvh_eul0[sidx:sidx + 1, :], bvh_channels[sidx]
                )[0]
            except Exception:
                q_local0 = np.array([0.0, 0.0, 0.0, 1.0])
        p = bvh_parents_for_fk[sidx]
        if p < 0 or p not in src_world_rest:
            src_world_rest[sidx] = q_local0
        else:
            src_world_rest[sidx] = _q_mul(src_world_rest[p], q_local0)

    # Build per-target track. Unmapped targets get rest-pose (no
    # rotation track -> renderer keeps the static node rotation).
    times = np.arange(n_frames, dtype=np.float32) * float(bvh["frame_time"])
    if target_fps and target_fps > 0:
        new_t = np.arange(0.0, float(times[-1]) + 1.0 / target_fps,
                          1.0 / target_fps, dtype=np.float32)
    else:
        new_t = times

    bin_data = bytearray(bin_blob)
    samplers: List[dict] = []
    channels_anim: List[dict] = []

    # One shared INPUT accessor (timeline) reused by every output.
    input_bv = _add_buffer_view(gltf, bin_data, new_t.astype("<f4").tobytes())
    input_acc = _add_accessor(
        gltf, input_bv, count=len(new_t),
        comp_type=5126, acc_type="SCALAR",
        minv=[float(new_t[0])], maxv=[float(new_t[-1])],
    )

    IDENT_Q = np.array([0.0, 0.0, 0.0, 1.0])

    # Pre-compute the target BONE AXIS in parent-local frame for each
    # joint. Used by the swing-twist decomposition below. The bone axis
    # at rest is `(world_self - world_parent)` rotated into parent's
    # local frame by `inv(R_parent_world)`. We normalize; degenerate
    # bones (zero-length offset) get a fallback +Y axis.
    tgt_bone_axis: Dict[int, np.ndarray] = {}
    for tni in joint_node_idxs:
        ws = world_by_idx.get(tni, np.zeros(3))
        p = parent_by_idx.get(tni, -1)
        if p < 0:
            wp = np.zeros(3)
            Rp = np.eye(3)
        else:
            wp = world_by_idx.get(p, np.zeros(3))
            Rp = world_rot_by_idx.get(p, np.eye(3))
        d_world = np.asarray(ws, dtype=np.float64) - np.asarray(wp, dtype=np.float64)
        n = np.linalg.norm(d_world)
        if n < 1e-9:
            tgt_bone_axis[tni] = np.array([0.0, 1.0, 0.0])
            continue
        d_world = d_world / n
        # Bring into parent-local: v_local = R_parent^T @ v_world
        v_local = Rp.T @ d_world
        nl = np.linalg.norm(v_local)
        tgt_bone_axis[tni] = (v_local / nl) if nl > 1e-9 else np.array([0.0, 1.0, 0.0])

    for tni in joint_node_idxs:
        sidx = mapping.get(tni)
        if sidx is None:
            continue
        src_q = src_quats[sidx]
        # Per-frame source PARENT-LOCAL delta vs its own rest:
        #   Q_src(f) = delta_src * Q_src_rest   (pre-multiply)
        #   delta_src = Q_src(f) * inv(Q_src_rest)
        # delta_src is therefore expressed in SOURCE-PARENT frame.
        src_rest = src_q[0].copy()
        src_rest_inv = _q_inv(src_rest)
        tgt_rest = tgt_rest_quat[tni]

        # --- BUG-A fix: use PARENT world rest, not the bone's own ---
        # delta_src lives in the source PARENT frame, so the basis-
        # change must rotate it from source-parent to target-parent.
        # Pull each bone's PARENT (not self) world-space rest quat.
        p_src = bvh_parents_for_fk[sidx] if sidx < len(bvh_parents_for_fk) else -1
        p_tgt = parent_by_idx.get(tni, -1)
        Ps = src_world_rest.get(p_src, IDENT_Q) if p_src >= 0 else IDENT_Q
        Pt = tgt_world_rest.get(p_tgt, IDENT_Q) if p_tgt >= 0 else IDENT_Q

        # Surface silent fallbacks: when a mapped bone's parent world
        # rest is missing (root or untracked node) we degrade to
        # identity and the user should know.
        if p_src >= 0 and p_src not in src_world_rest:
            print(f"[retarget][warn] src parent world rest missing for sidx={sidx} "
                  f"(parent={p_src}, name={bvh['names'][sidx]!r}); falling back to identity")
        if p_tgt >= 0 and p_tgt not in tgt_world_rest:
            print(f"[retarget][warn] tgt parent world rest missing for tni={tni} "
                  f"(parent={p_tgt}, name={name_by_idx.get(tni, '?')!r}); falling back to identity")

        # --- BUG-B fix: correct conjugation form ---
        # Derivation: a vector v_s in source-parent frame relates to its
        # target-parent expression via v_t = Pt^-1 * Ps * v_s * Ps^-1 * Pt
        # (rotate v_s to world via Ps, then into target-parent via Pt^-1).
        # So basis = Pt^-1 * Ps takes source-parent vectors to
        # target-parent vectors, and a rotation R in source-parent
        # becomes basis * R * inv(basis) in target-parent.
        basis = _q_mul(_q_inv(Pt), Ps)
        basis_inv = _q_inv(basis)

        # Per-frame:
        #   delta_tgt = basis * delta_src * basis^-1   (re-express in target-parent)
        #   Q_tgt_local(f) = delta_tgt * Q_tgt_rest    (pre-multiply on rest, so
        #                                               delta lives in PARENT frame
        #                                               matching the source convention)
        # At frame 0 delta_src = identity, so delta_tgt = identity, so
        # Q_tgt_local(0) = Q_tgt_rest exactly (round-trip preserved).
        #
        # 2026-06-02: ANGLE CLAMP added on top of basis math. AnyTop's
        # 142-bone Dragon and our 47-bone Puppeteer rig have different
        # bone LENGTHS and ATTACH ANGLES; correct quaternion transfer
        # still produces "exploded limbs" when the source bone rotates
        # 150-180° (folded wing unfolding, tail curling). Cap each
        # per-frame delta to MAX_ANGLE so the worst-case extreme is
        # softened. Real IK would solve this properly — see audit
        # workflow a9b4d2e3 recommendation for pan-motion-retargeting
        # / Blender headless pivot. This clamp is a pragmatic stopgap.
        # 2026-06-02: SWING-TWIST DECOMPOSITION
        # Per web-audit a9b4d2e3 — "moves in all directions" is the
        # expected failure mode of basis-only retargeting between
        # mismatched skeletons because the source bones carry
        # rest-pose twists baked in by the original artist that don't
        # exist on our Puppeteer rig. Discarding the twist component
        # (rotation around the bone's own axis) and keeping only the
        # swing (rotation perpendicular to the axis, ie. WHERE the
        # bone points) preserves the directional intent without
        # propagating axis-spin artifacts that look like "wrong limbs
        # going wrong directions" on screen.
        #
        # We decompose AFTER basis-change so the axis can be expressed
        # in the TARGET parent-local frame (which is where delta_tgt
        # lives). The target bone axis was pre-computed above from
        # IBM-derived world positions.
        MAX_ANGLE_RAD = np.deg2rad(90.0)
        bone_axis = tgt_bone_axis.get(tni, np.array([0.0, 1.0, 0.0]))
        q = np.empty_like(src_q)
        for fi in range(src_q.shape[0]):
            delta_src = _q_mul(src_q[fi], src_rest_inv)
            # Clamp delta_src angle before basis (similarity preserves angle).
            ds = delta_src
            ds_w = max(-1.0, min(1.0, float(ds[3])))
            ang = 2.0 * np.arccos(ds_w)
            if ang > MAX_ANGLE_RAD:
                f = MAX_ANGLE_RAD / max(ang, 1e-6)
                sinh = np.sin(ang / 2.0)
                sinhf = np.sin(ang * f / 2.0)
                if abs(sinh) > 1e-6:
                    scale = sinhf / sinh
                    ds = np.array([ds[0] * scale, ds[1] * scale, ds[2] * scale,
                                   np.cos(ang * f / 2.0)])
            # Basis change source-parent -> target-parent.
            delta_tgt_full = _q_mul(_q_mul(basis, ds), basis_inv)
            # Decompose around target bone axis (in target parent frame).
            swing, _twist = _swing_twist(delta_tgt_full, bone_axis)
            # Apply ONLY swing on top of rest.
            q[fi] = _q_mul(swing, tgt_rest)
        # Sign-continuity across frames (preserved through the mul,
        # but re-assert after delta to be safe).
        for i in range(1, q.shape[0]):
            if np.dot(q[i], q[i - 1]) < 0.0:
                q[i] = -q[i]
        # 2026-06-02: TEMPORAL SMOOTHING — short boxcar over 5 frames
        # (centered, edge-clamped) to remove single-frame spikes that
        # would otherwise look like jitter to the user. Quaternion
        # averages are normalized after the sum so the result stays
        # on the unit hypersphere.
        if q.shape[0] >= 5:
            sm = np.empty_like(q)
            W = 2  # half-window: covers 5 frames total (i-2..i+2)
            for i in range(q.shape[0]):
                lo = max(0, i - W)
                hi = min(q.shape[0], i + W + 1)
                # Sign-align neighbours to q[i] before averaging.
                base = q[i]
                acc = np.zeros(4)
                for j in range(lo, hi):
                    qq = q[j]
                    if np.dot(qq, base) < 0.0:
                        qq = -qq
                    acc += qq
                n = np.linalg.norm(acc)
                sm[i] = (acc / n) if n > 1e-9 else q[i]
            q = sm
            # Re-assert sign continuity after smoothing.
            for i in range(1, q.shape[0]):
                if np.dot(q[i], q[i - 1]) < 0.0:
                    q[i] = -q[i]
        # Resample to target FPS if needed (nearest-neighbour quat —
        # good enough for ~30 Hz when source is also ~30 Hz).
        if target_fps and target_fps > 0 and len(new_t) != n_frames:
            idxs = np.clip((new_t / max(times[-1], 1e-6)) * (n_frames - 1), 0, n_frames - 1)
            idxs = idxs.round().astype(np.int64)
            q = q[idxs]
            for i in range(1, q.shape[0]):
                if np.dot(q[i], q[i - 1]) < 0.0:
                    q[i] = -q[i]
        q = q.astype("<f4")
        out_bv = _add_buffer_view(gltf, bin_data, q.tobytes())
        out_acc = _add_accessor(
            gltf, out_bv, count=q.shape[0],
            comp_type=5126, acc_type="VEC4",
        )
        s_idx = len(samplers)
        samplers.append({"input": input_acc, "output": out_acc, "interpolation": "LINEAR"})
        channels_anim.append({
            "sampler": s_idx,
            "target": {"node": tni, "path": "rotation"},
        })

    # ---- ROOT TRANSLATION TRACK (Fix #1) ----
    # Without this, the character animates limbs in place and never
    # translates through the world. Emit a TRS-translation channel on
    # the hip target node, sourced from motion['root_pos']. Apply a
    # hip-rest-height scale so the character doesn't sink/float on
    # skeletons of different stature. FBX path already pre-rotated
    # root_pos to target axes (line 654) — just scale here.
    hip_tni = next(
        (tni for tni, (r, _, _) in tgt_roles.items() if r == 'hip'),
        None,
    )
    if hip_tni is not None and 'root_pos' in bvh:
        root_pos = np.asarray(bvh['root_pos'], dtype=np.float64)  # (F, 3)
        if root_pos.ndim == 2 and root_pos.shape[0] == n_frames and root_pos.shape[1] == 3:
            # Target hip world rest Y (up_axis=1, confirmed by GLB convention).
            tgt_hip_y = abs(float(world_by_idx.get(hip_tni, np.zeros(3))[1]))
            # Source hip world rest Y: walk offsets from hip up to root.
            src_hip_idx = mapping.get(hip_tni, -1)
            src_offsets = bvh.get('offsets')
            src_parents = bvh.get('parents')
            src_hip_y = 0.0
            if src_hip_idx >= 0 and src_offsets is not None and src_parents is not None:
                cur = src_hip_idx
                for _ in range(1024):
                    if cur < 0:
                        break
                    try:
                        src_hip_y += float(np.asarray(src_offsets[cur])[1])
                        cur = int(src_parents[cur])
                    except (IndexError, TypeError, ValueError):
                        break
            src_hip_y = abs(src_hip_y)
            scale = (tgt_hip_y / src_hip_y) if (tgt_hip_y > 1e-6 and src_hip_y > 1e-6) else 1.0
            tr = (root_pos * scale).astype(np.float64)
            # Resample to target FPS — mirror the quat-resample logic above.
            if target_fps and target_fps > 0 and len(new_t) != n_frames:
                idxs = np.clip((new_t / max(times[-1], 1e-6)) * (n_frames - 1), 0, n_frames - 1)
                idxs = idxs.round().astype(np.int64)
                tr = tr[idxs]
            tr = tr.astype("<f4")
            tr_bv = _add_buffer_view(gltf, bin_data, tr.tobytes())
            tr_acc = _add_accessor(
                gltf, tr_bv, count=tr.shape[0],
                comp_type=5126, acc_type="VEC3",
            )
            s_idx_tr = len(samplers)
            samplers.append({"input": input_acc, "output": tr_acc, "interpolation": "LINEAR"})
            channels_anim.append({
                "sampler": s_idx_tr,
                "target": {"node": hip_tni, "path": "translation"},
            })
            print(
                f"[retarget] root translation track: hip_tni={hip_tni} "
                f"scale={scale:.4f} frames={tr.shape[0]}"
            )
        else:
            print(
                f"[retarget][warn] root_pos shape {root_pos.shape} mismatch "
                f"(expected ({n_frames}, 3)); skipping translation track"
            )
    else:
        print(f"[retarget][warn] no hip target node OR no root_pos; skipping translation track")

    anim_obj = {
        "name": clip_name,
        "samplers": samplers,
        "channels": channels_anim,
    }
    gltf.setdefault("animations", []).append(anim_obj)
    _write_glb(gltf, bytes(bin_data), out_glb_path)
    print(f"[retarget] wrote {out_glb_path}: "
          f"{len(channels_anim)} channels, {len(new_t)} samples")


# ============================================================
# 7. Inline self-test for the basis-change math (BUG-A/BUG-B fix)
# ============================================================

def _self_test_basis_change() -> None:
    """Verify the parent-frame basis-change is correct.

    Synthetic setup (independent of any BVH/glTF):
      * Source parent is rotated +30 deg about world +Z at rest.
      * Target parent is rotated -45 deg about world +X at rest.
      * Source bone's own rest is identity in its parent frame.
      * Target bone's own rest is identity in its parent frame.
      * At frame F, source bone gets a parent-local rotation of
        +90 deg about its parent-local +Y axis. In WORLD frame that
        rotation's axis is Ps * y_hat * Ps^-1 (axis rotated by Ps).
      * In target-parent frame that SAME world rotation must have
        axis Pt^-1 * world_axis * Pt and the same 90 deg angle.

    Assertions:
      (a) Frame 0 (delta_src = identity) -> Q_tgt_local = Q_tgt_rest.
      (b) Frame F: applying Q_tgt_local then walking the target chain
          to world produces a world-space rotation whose axis matches
          the source's world-space rotation axis, and whose angle is
          90 deg.
    """

    def _q_mul(a, b):
        ax, ay, az, aw = a
        bx, by, bz, bw = b
        return np.array([
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz,
        ])

    def _q_inv(q):
        x, y, z, w = q
        n = x * x + y * y + z * z + w * w
        return np.array([-x, -y, -z, w]) / n

    def _q_axis_angle(axis, deg):
        a = np.asarray(axis, dtype=np.float64)
        a = a / np.linalg.norm(a)
        th = np.deg2rad(deg) * 0.5
        s = np.sin(th)
        return np.array([a[0] * s, a[1] * s, a[2] * s, np.cos(th)])

    def _q_rotate_vec(q, v):
        # v as pure quat (vx, vy, vz, 0)
        v4 = np.array([v[0], v[1], v[2], 0.0])
        out = _q_mul(_q_mul(q, v4), _q_inv(q))
        return out[:3]

    def _quat_to_axis_angle(q):
        q = q / np.linalg.norm(q)
        w = max(-1.0, min(1.0, q[3]))
        ang = 2.0 * np.arccos(w)
        s = np.sqrt(max(0.0, 1.0 - w * w))
        if s < 1e-8:
            return np.array([1.0, 0.0, 0.0]), 0.0
        return np.array([q[0] / s, q[1] / s, q[2] / s]), np.rad2deg(ang)

    IDENT = np.array([0.0, 0.0, 0.0, 1.0])

    # Synthetic parent world rests.
    Ps = _q_axis_angle([0, 0, 1], 30.0)   # source parent: +30° about Z
    Pt = _q_axis_angle([1, 0, 0], -45.0)  # target parent: -45° about X

    # Source bone rest = identity in parent frame; ditto target.
    Q_src_rest = IDENT.copy()
    Q_tgt_rest = IDENT.copy()

    # Basis change per the fixed formula.
    basis = _q_mul(_q_inv(Pt), Ps)
    basis_inv = _q_inv(basis)

    # ---- Assertion (a): frame 0 round-trip ----
    delta_src_0 = _q_mul(Q_src_rest, _q_inv(Q_src_rest))  # identity
    delta_tgt_0 = _q_mul(_q_mul(basis, delta_src_0), basis_inv)
    Q_tgt_local_0 = _q_mul(delta_tgt_0, Q_tgt_rest)
    err0 = np.linalg.norm(Q_tgt_local_0 - Q_tgt_rest)
    assert err0 < 1e-9, f"frame 0 round-trip failed: err={err0}"
    print(f"[self-test] frame 0 round-trip OK (err={err0:.2e})")

    # ---- Assertion (b): frame F = 5, +90 deg about parent-local +Y ----
    spin = _q_axis_angle([0, 1, 0], 90.0)
    Q_src_F = _q_mul(spin, Q_src_rest)   # source local at frame F
    delta_src_F = _q_mul(Q_src_F, _q_inv(Q_src_rest))   # parent-local delta
    delta_tgt_F = _q_mul(_q_mul(basis, delta_src_F), basis_inv)
    Q_tgt_local_F = _q_mul(delta_tgt_F, Q_tgt_rest)

    # World-space rotations on each side:
    #   src world rotation = Ps * Q_src_local * inv(Ps * Q_src_rest)
    # which simplifies (since rest=identity) to:
    #   Q_src_world_rot = Ps * delta_src * Ps^-1 (parent-frame delta to world)
    # Equivalent direct form: world rotation axis = Ps applied to +Y.
    src_world_rot = _q_mul(_q_mul(Ps, delta_src_F), _q_inv(Ps))
    tgt_world_rot = _q_mul(_q_mul(Pt, delta_tgt_F), _q_inv(Pt))

    axis_s, ang_s = _quat_to_axis_angle(src_world_rot)
    axis_t, ang_t = _quat_to_axis_angle(tgt_world_rot)
    # Axes can flip sign if angles are interpreted as -ang; normalize.
    if np.dot(axis_s, axis_t) < 0:
        axis_t = -axis_t
        ang_t = -ang_t
    axis_err = np.linalg.norm(axis_s - axis_t)
    ang_err = abs(abs(ang_s) - abs(ang_t))
    assert axis_err < 1e-6, f"world axis mismatch: src={axis_s} tgt={axis_t} err={axis_err}"
    assert ang_err < 1e-6, f"world angle mismatch: src={ang_s} tgt={ang_t} err={ang_err}"
    assert abs(abs(ang_s) - 90.0) < 1e-6, f"expected 90 deg, got {ang_s}"
    print(f"[self-test] frame F world rotation OK "
          f"(axis={axis_s}, angle={ang_s:.4f} deg; "
          f"axis_err={axis_err:.2e}, ang_err={ang_err:.2e})")

    # ---- Extra: pure +Y WORLD rotation on source must map to pure +Y
    # WORLD rotation on target (with the same angle). Express +Y world
    # as a source-parent-frame delta: delta_src_parent = Ps^-1 * spin * Ps.
    spin_world_Y = _q_axis_angle([0, 1, 0], 90.0)
    delta_src_p_world = _q_mul(_q_mul(_q_inv(Ps), spin_world_Y), Ps)
    delta_tgt_p = _q_mul(_q_mul(basis, delta_src_p_world), basis_inv)
    tgt_world_rot_Y = _q_mul(_q_mul(Pt, delta_tgt_p), _q_inv(Pt))
    axis_y, ang_y = _quat_to_axis_angle(tgt_world_rot_Y)
    if axis_y[1] < 0:
        axis_y = -axis_y
        ang_y = -ang_y
    assert np.linalg.norm(axis_y - np.array([0, 1, 0])) < 1e-6, \
        f"+Y world on src did not map to +Y world on tgt: got axis={axis_y}"
    assert abs(abs(ang_y) - 90.0) < 1e-6, f"angle mismatch: {ang_y}"
    print(f"[self-test] +Y world preserved across basis change "
          f"(axis={axis_y}, angle={ang_y:.4f} deg)")

    # ---- Negative control: confirm the OLD (buggy) formula breaks ----
    # Old: basis_old = Q_tgt_world_rest * inv(Q_src_world_rest), using
    # the BONE's own world rest (not the parent's). Since bone rest = I
    # here, Q_self_world = Ps and Pt respectively, so:
    basis_old = _q_mul(Pt, _q_inv(Ps))
    delta_tgt_F_old = _q_mul(_q_mul(basis_old, delta_src_F), _q_inv(basis_old))
    Q_tgt_local_F_old = _q_mul(delta_tgt_F_old, Q_tgt_rest)
    tgt_world_rot_old = _q_mul(_q_mul(Pt, delta_tgt_F_old), _q_inv(Pt))
    axis_o, ang_o = _quat_to_axis_angle(tgt_world_rot_old)
    if np.dot(axis_o, axis_s) < 0:
        axis_o = -axis_o
        ang_o = -ang_o
    diff_old = np.linalg.norm(axis_o - axis_s)
    print(f"[self-test] OLD formula produces axis={axis_o} (vs correct {axis_s}); "
          f"diff={diff_old:.4f} — confirms old code was wrong when "
          f"parents differ from self-rests.")


if __name__ == "__main__":
    _self_test_basis_change()
    print("[self-test] ALL PASS")
