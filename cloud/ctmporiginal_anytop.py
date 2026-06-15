"""AnyTop-canonical-BVH → Puppeteer-rig glTF retargeter.

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
  1. Parse the BVH (bvhsdk) → source hierarchy + per-frame Euler
     rotations + rest-pose offsets.
  2. Classify EVERY source bone with ``_anatomical_role_from_bip01``
     which knows the AnyTop canonical naming conventions.
  3. Read the target GLB (skin 0) → skin.joints[] + IBM positions.
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
from typing import Dict, List, Optional, Tuple

import numpy as np
from scipy.spatial.transform import Rotation as R


# ============================================================
# 1. Source-bone classifier — AnyTop canonical names → roles
# ============================================================

_SIDE_TOKEN_L = re.compile(r"(_L_|_l_|Left|LeftLeg|LLeg|L_)", re.IGNORECASE)
_SIDE_TOKEN_R = re.compile(r"(_R_|_r_|Right|RightLeg|RLeg|R_)", re.IGNORECASE)

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

    # 2026-06-02 fix (mirrors modal_app/_anytop_anim.py:_anatomical_names):
    # collect ANY non-spine/tail kid whose chain has lateral span OR
    # tips below root. The previous gate `abs(SIDE(first)) > side_gate`
    # dropped legs because the hip joint sits ~centerline.
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

    left = [c for c in laterals if c['sign'] > 0]
    right = [c for c in laterals if c['sign'] <= 0]
    spine_top = UP(pos[spine[-1]]) if spine else UP(pos[root])
    spine_btm = UP(pos[spine[0]])
    midline = spine_btm + 0.5 * (spine_top - spine_btm)

    # 2026-06-02: keep ALL upper and ALL lower per side (not just one).
    # A dragon has 2 legs per side (front + back); the previous "ONE
    # upper + ONE lower" output dropped the second leg into the
    # 'limb_NN' fallback bucket. We now numerically index them, so
    # caller gets leg_l_01..N for every leg chain on the left.
    def split_all(chs):
        upper = sorted([c for c in chs if c['attach'] > midline or c['tip'] > UP(pos[root]) + body_h * 0.1],
                       key=lambda c: (-c['len'], -c['attach']))
        lower = sorted([c for c in chs if c['tip'] < UP(pos[root]) - body_h * 0.05 and c not in upper],
                       key=lambda c: (-c['len'], -c['attach']))
        return upper, lower

    upper_l_list, lower_l_list = split_all(left)
    upper_r_list, lower_r_list = split_all(right)
    upper_l = upper_l_list[0] if upper_l_list else None
    upper_r = upper_r_list[0] if upper_r_list else None
    lower_l = lower_l_list[0] if lower_l_list else None
    lower_r = lower_r_list[0] if lower_r_list else None
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
    # 2026-06-02: enumerate ALL upper/lower chains per side so a
    # quadruped dragon's 2 legs per side both get labeled. Bone idx
    # continues across chains so each target bone has a UNIQUE
    # (role, side, idx) triple.
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
    src_roles: Dict[int, Tuple[str, Optional[str], int]],   # src_bvh_idx → (role, side, idx)
    tgt_roles: Dict[int, Tuple[str, Optional[str], int]],   # tgt_node_idx → (role, side, idx)
) -> Dict[int, int]:
    """For every target bone with a role, pick the BEST source bone:
      * same role + same side, closest chain index
      * fallback: same role, ignore side
      * fallback: hip → hip, head → head (sideless)
    Returns dict target_node_idx → source_bvh_idx. Unmapped targets stay
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

    The GLB's mesh, materials, skin, and bone hierarchy are kept
    BYTE-IDENTICAL — we only append a new AnimationClip referencing
    the existing nodes.

    Args:
      rig_glb_path: input Puppeteer rig GLB (47-bone-ish).
      bvh_path: AnyTop canonical BVH (variable bone count by class).
      out_glb_path: where to write the animated GLB.
      clip_name: glTF AnimationClip name field.
      target_fps: optional FPS resampling; pass 0 to skip.
      ckpt_family: passed to the target classifier so it knows whether
        to label upper laterals as 'wing' (flying) or 'arm'."""
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

    # World bind positions for the target's anatomical classifier.
    world_by_idx: Dict[int, np.ndarray] = {}
    ibm_acc = skin.get("inverseBindMatrices")
    if ibm_acc is not None:
        ibm_flat = _read_accessor_floats(gltf, bin_blob, ibm_acc)
        ibm_mats = np.asarray(ibm_flat).reshape(len(joint_node_idxs), 4, 4)
        ibm_mats = np.transpose(ibm_mats, (0, 2, 1))
        for k, jidx in enumerate(joint_node_idxs):
            try:
                world_mat = np.linalg.inv(ibm_mats[k])
                world_by_idx[jidx] = world_mat[:3, 3].astype(np.float64)
            except Exception:
                world_by_idx[jidx] = np.array([0.0, 0.0, 0.0], dtype=np.float64)
    for jidx in joint_node_idxs:
        if jidx not in world_by_idx:
            tr = nodes[jidx].get("translation") or [0.0, 0.0, 0.0]
            world_by_idx[jidx] = np.asarray(tr, dtype=np.float64)

    print(f"[retarget] reading bvh: {bvh_path}")
    bvh = _parse_bvh(bvh_path)
    n_frames = bvh["n_frames"]
    if n_frames <= 0:
        raise RuntimeError("BVH has 0 frames")

    # Classify source + target.
    src_roles: Dict[int, Tuple[str, Optional[str], int]] = {}
    for sidx, sname in enumerate(bvh["names"]):
        src_roles[sidx] = _classify_source_bone(sname)
    tgt_roles = _target_anatomical_roles(
        joint_node_idxs, parent_by_idx, world_by_idx, ckpt_family=ckpt_family
    )

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

    # Delta-based retargeting (2026-06-02): the source skeleton's
    # REST orientation (frame 0 of the BVH, which AnyTop emits at
    # T-pose) is rarely identity — wings fold down, tails curl, etc.
    # If we apply source's CURRENT-frame quaternion directly as the
    # target's local rotation, the target's wing/limb snaps to the
    # source's absolute orientation and the mesh visually breaks
    # (one wing shoots far off, one leg goes through the body).
    #
    # Fix: compute the per-frame DELTA from the source's frame-0 rest
    # pose, then apply that delta on top of the target's rest pose.
    #   Q_delta(frame)  = Q_src(frame) * inv(Q_src(0))
    #   Q_tgt(frame)    = Q_tgt_rest * Q_delta(frame)
    # The target's rest rotation comes from the node's 'rotation'
    # field if present (set by Puppeteer or the GLTFLoader); else
    # we default to identity (a reasonable assumption for skinned
    # rigs where the rest pose lives in IBM, not node TRS).
    tgt_rest_quat: Dict[int, np.ndarray] = {}
    for tni in joint_node_idxs:
        q_rest = nodes[tni].get("rotation")
        if q_rest is not None and len(q_rest) == 4:
            tgt_rest_quat[tni] = np.asarray(q_rest, dtype=np.float64)
        else:
            tgt_rest_quat[tni] = np.array([0.0, 0.0, 0.0, 1.0])  # identity

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

    # Build per-target track. Unmapped targets get rest-pose (no
    # rotation track → renderer keeps the static node rotation).
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

    for tni in joint_node_idxs:
        sidx = mapping.get(tni)
        if sidx is None:
            continue
        src_q = src_quats[sidx]
        # Delta-based retargeting: subtract source's rest pose
        # (frame 0) and apply the residual to target's rest pose.
        src_rest = src_q[0].copy()
        src_rest_inv = _q_inv(src_rest)
        tgt_rest = tgt_rest_quat[tni]
        # Per-frame: Q_tgt = Q_tgt_rest * (Q_src * inv(Q_src_rest))
        q = np.empty_like(src_q)
        for fi in range(src_q.shape[0]):
            delta = _q_mul(src_q[fi], src_rest_inv)
            q[fi] = _q_mul(tgt_rest, delta)
        # Sign-continuity across frames (preserved through the mul,
        # but re-assert after delta to be safe).
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

    anim_obj = {
        "name": clip_name,
        "samplers": samplers,
        "channels": channels_anim,
    }
    gltf.setdefault("animations", []).append(anim_obj)
    _write_glb(gltf, bytes(bin_data), out_glb_path)
    print(f"[retarget] wrote {out_glb_path}: "
          f"{len(channels_anim)} channels, {len(new_t)} samples")
