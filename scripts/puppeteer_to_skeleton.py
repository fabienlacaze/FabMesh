"""Rename joints of a Puppeteer-rigged GLB to match a target skeleton template.

Generalization of ``puppeteer_to_orc_m1.py``: instead of hard-coding UE5
humanoid names (``pelvis``, ``upperarm_l``, ...), this script reads the
target bone names from ``scripts/rig_templates/skm/<target>.bones.json``
and remaps the Puppeteer joints accordingly.

The IBM-based world-position classifier (longest spine chain, lateral
arm/leg detection, thumb/index sorting on the hand) is copied verbatim
from ``puppeteer_to_orc_m1.py`` -- it is purely anatomical and works on
any humanoid. The *role -> template-bone-name* mapping is then resolved
by scanning the target template for the bones that match each role.

Usage
-----
    python puppeteer_to_skeleton.py --target <name> <input.glb> <output.glb>

``<name>`` is the basename of the template file
(e.g. ``orc_m1``, ``humanoid_basic``, ``goliath_spider``).

Two special values short-circuit the remap and copy the input as-is:
    --target none
    --target puppeteer_raw

Exits 0 on success, 1 on failure (prints ``AUTORIG_ERROR:`` line).

Backward compat: ``puppeteer_to_orc_m1.py`` is left untouched. New
callers (main.js auto-rig pipeline) should call this script instead.

Author: FabWare / MeshyMyself
"""

import json
import os
import re
import shutil
import struct
import sys

import numpy as np

# UTF-8 stdout shim
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


# --- glTF / GLB low-level IO ------------------------------------------------

GLB_MAGIC = b"glTF"
JSON_CHUNK_TYPE = b"JSON"
BIN_CHUNK_TYPE = b"BIN\x00"


def _read_glb(path):
    with open(path, "rb") as f:
        data = f.read()
    if len(data) < 12 or data[:4] != GLB_MAGIC:
        raise ValueError(f"not a valid GLB: {path}")
    version, total_length = struct.unpack("<II", data[4:12])
    if version != 2:
        raise ValueError(f"unsupported GLB version {version}")
    json_len = struct.unpack("<I", data[12:16])[0]
    json_type = data[16:20]
    if json_type != JSON_CHUNK_TYPE:
        raise ValueError(f"first chunk not JSON: {json_type!r}")
    json_blob = data[20:20 + json_len]
    gltf = json.loads(json_blob.decode("utf-8"))
    cursor = 20 + json_len
    bin_blob = b""
    if cursor < len(data):
        bin_len = struct.unpack("<I", data[cursor:cursor + 4])[0]
        bin_type = data[cursor + 4:cursor + 8]
        if bin_type == BIN_CHUNK_TYPE:
            bin_blob = data[cursor + 8:cursor + 8 + bin_len]
            cursor += 8 + bin_len
    tail = data[cursor:]
    return gltf, json_blob, bin_blob, tail


def _write_glb(out_path, gltf, bin_blob, tail):
    new_json = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    pad = (4 - len(new_json) % 4) % 4
    new_json = new_json + b" " * pad
    bin_pad = (4 - len(bin_blob) % 4) % 4
    bin_padded = bin_blob + b"\x00" * bin_pad
    total = 12 + 8 + len(new_json)
    if bin_padded:
        total += 8 + len(bin_padded)
    total += len(tail)
    header = GLB_MAGIC + struct.pack("<II", 2, total)
    json_header = struct.pack("<I", len(new_json)) + JSON_CHUNK_TYPE
    out = header + json_header + new_json
    if bin_padded:
        out += struct.pack("<I", len(bin_padded)) + BIN_CHUNK_TYPE + bin_padded
    out += tail
    with open(out_path, "wb") as f:
        f.write(out)


# --- Accessor helpers -------------------------------------------------------

_COMPONENT_DTYPE = {
    5120: np.int8, 5121: np.uint8,
    5122: np.int16, 5123: np.uint16,
    5125: np.uint32, 5126: np.float32,
}
_TYPE_COUNT = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def _read_accessor(gltf, bin_blob, accessor_idx):
    acc = gltf["accessors"][accessor_idx]
    bv = gltf["bufferViews"][acc["bufferView"]]
    offset = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    dtype = np.dtype(_COMPONENT_DTYPE[acc["componentType"]]).newbyteorder("<")
    count = acc["count"] * _TYPE_COUNT[acc["type"]]
    raw = bin_blob[offset:offset + count * dtype.itemsize]
    return np.frombuffer(raw, dtype=dtype, count=count).copy()


def _joint_world_positions(gltf, bin_blob, skin):
    joints = list(skin["joints"])
    J = len(joints)
    raw = _read_accessor(gltf, bin_blob, skin["inverseBindMatrices"]).reshape(J, 4, 4)
    ibm = raw.transpose(0, 2, 1).astype(np.float64)
    world = np.linalg.inv(ibm)[:, :3, 3]
    return joints, world


# --- Joint topology helpers -------------------------------------------------

def _build_joint_hierarchy(gltf, joints):
    joint_set = set(joints)
    children = {ji: [] for ji in joints}
    parent = {}
    for ni in joints:
        node = gltf["nodes"][ni]
        for ci in node.get("children", []) or []:
            if ci in joint_set:
                children[ni].append(ci)
                parent[ci] = ni
    return children, parent


def _chain_depth(children, ni):
    kids = children.get(ni, [])
    if not kids:
        return 0
    return 1 + max(_chain_depth(children, c) for c in kids)


def _longest_chain(children, start):
    chain = [start]
    cur = start
    while children.get(cur):
        nxt = max(children[cur], key=lambda c: _chain_depth(children, c))
        chain.append(nxt)
        cur = nxt
    return chain


# --- Puppeteer anatomical classifier (returns ROLE -> node_idx) ------------
# Roles use a stable, schema-neutral vocabulary:
#   pelvis, spine_01..spine_05, neck_01..neck_02, head,
#   clavicle_l/r, upperarm_l/r, lowerarm_l/r, hand_l/r,
#   thumb_01_l..thumb_03_l (and _r), index_01_l..index_03_l (and _r),
#   thigh_l/r, calf_l/r, foot_l/r, ball_l/r
# These roles are then translated to the target template's actual names.

def classify_puppeteer_roles(gltf, bin_blob, skin_index=0):
    skin = gltf["skins"][skin_index]
    joints, world = _joint_world_positions(gltf, bin_blob, skin)
    pos = {ni: world[i] for i, ni in enumerate(joints)}
    children, parent = _build_joint_hierarchy(gltf, joints)
    roots = [ni for ni in joints if ni not in parent]
    if not roots:
        return {}, pos

    P = world
    bb_min, bb_max = P.min(axis=0), P.max(axis=0)
    size = bb_max - bb_min
    up_axis = 1 if size[1] >= size[2] else 2
    side_candidates = [(size[i], i) for i in range(3) if i != up_axis]
    side_axis = max(side_candidates)[1]
    body_h = float(size[up_axis])

    def UP(v): return float(v[up_axis])
    def SIDE(v): return float(v[side_axis])

    candidates = [r for r in roots if len(children[r]) >= 2]
    if not candidates:
        candidates = roots
    root = min(candidates, key=lambda r: (UP(pos[r]), -len(children[r])))

    spine_root_side = SIDE(pos[root])
    side_gate = body_h * 0.08

    def _on_axis_depth(ni):
        if abs(SIDE(pos[ni]) - spine_root_side) > side_gate:
            return -1
        best = 0
        for c in children.get(ni, []):
            d = _on_axis_depth(c)
            if d >= 0:
                best = max(best, 1 + d)
        return best

    def _is_clavicle_like(ni):
        for c in children.get(ni, []):
            if abs(SIDE(pos[c]) - spine_root_side) > side_gate:
                return True
        return False

    def upward_chain(start):
        chain = [start]
        cur = start
        while children.get(cur):
            kids = children[cur]
            on_axis = [c for c in kids
                       if abs(SIDE(pos[c]) - spine_root_side) <= side_gate
                       and UP(pos[c]) > UP(pos[cur]) - body_h * 0.01
                       and not _is_clavicle_like(c)]
            if not on_axis:
                break
            best = max(on_axis,
                       key=lambda c: (_on_axis_depth(c),
                                      UP(pos[c]) - UP(pos[cur])))
            chain.append(best)
            cur = best
        return chain
    spine = upward_chain(root)
    spine_set = set(spine)

    arm_roots = []
    for sp_ni in spine:
        rel_h = (UP(pos[sp_ni]) - UP(bb_min)) / max(body_h, 1e-6)
        if rel_h < 0.55:
            continue
        for kid in children[sp_ni]:
            if kid in spine_set:
                continue
            k_chain = _longest_chain(children, kid)
            lateral = max(abs(SIDE(pos[c]) - SIDE(pos[sp_ni])) for c in k_chain)
            end = pos[k_chain[-1]]
            if lateral > body_h * 0.08 and UP(end) > UP(pos[root]) + body_h * 0.1:
                signed = SIDE(pos[k_chain[1]] if len(k_chain) > 1 else pos[kid])
                arm_roots.append((kid, signed))
    arm_roots.sort(key=lambda x: abs(x[1]), reverse=True)
    arms = arm_roots[:2]
    arms.sort(key=lambda x: x[1])
    arm_r = arms[0][0] if len(arms) == 2 else None
    arm_l = arms[-1][0] if len(arms) == 2 else None

    leg_sources = []
    seen_src = set()
    for src in [root] + spine[:2]:
        if src in seen_src:
            continue
        seen_src.add(src)
        leg_sources.append(src)
    leg_cands = []
    seen_kid = set()
    for src in leg_sources:
        for kid in children[src]:
            if kid in spine_set:
                continue
            if kid in (arm_l, arm_r):
                continue
            if kid in seen_kid:
                continue
            seen_kid.add(kid)
            k_chain = _longest_chain(children, kid)
            end = pos[k_chain[-1]]
            drop = UP(pos[src]) - UP(end)
            lateral = abs(SIDE(end) - SIDE(pos[src]))
            if drop > body_h * 0.25 and lateral < body_h * 0.30:
                signed_side = max(
                    (SIDE(pos[c]) for c in k_chain),
                    key=lambda s: abs(s),
                )
                leg_cands.append((kid, signed_side))
    leg_cands.sort(key=lambda x: abs(x[1]), reverse=True)
    legs = leg_cands[:2]
    legs.sort(key=lambda x: x[1])
    leg_r = legs[0][0] if len(legs) == 2 else None
    leg_l = legs[-1][0] if len(legs) == 2 else None

    roles = {}  # role_name -> node_idx
    spine_role_names = ["pelvis", "spine_01", "spine_02", "spine_03", "spine_04",
                       "spine_05", "neck_01", "neck_02", "head"]
    spine_assign = list(spine)
    neck_tail = None
    if len(spine_assign) >= 3 and not children.get(spine_assign[-1]):
        tail = spine_assign[-1]
        tail_h = UP(pos[tail])
        arm_h = max((UP(pos[a]) for a, _ in arms), default=tail_h)
        if tail_h >= arm_h - body_h * 0.02:
            neck_tail = spine_assign.pop()
    for i, ni in enumerate(spine_assign):
        if i < len(spine_role_names):
            roles[spine_role_names[i]] = ni
    if neck_tail is not None:
        roles["neck_01"] = neck_tail

    arm_role_names = ["clavicle", "upperarm", "lowerarm", "hand"]
    for side, root_ni in [("_l", arm_l), ("_r", arm_r)]:
        if root_ni is None:
            continue
        chain = _longest_chain(children, root_ni)
        for i, ni in enumerate(chain[:len(arm_role_names)]):
            roles[arm_role_names[i] + side] = ni
        hand_ni = chain[3] if len(chain) > 3 else None
        if hand_ni is not None and children[hand_ni]:
            hand_side = SIDE(pos[hand_ni])
            finger_chains = [_longest_chain(children, c) for c in children[hand_ni]]
            finger_chains = [fc for fc in finger_chains if len(fc) >= 2]
            finger_chains.sort(key=lambda fc: (-len(fc),
                                                abs(SIDE(pos[fc[0]]) - hand_side)))
            finger_chains = sorted(
                finger_chains[:max(2, len(finger_chains))],
                key=lambda fc: abs(SIDE(pos[fc[0]]) - hand_side),
            )
            labels = ["thumb", "index"]
            for j, fc in enumerate(finger_chains[:2]):
                lbl = labels[j]
                for k, fni in enumerate(fc[:3]):
                    roles[f"{lbl}_{k + 1:02d}{side}"] = fni

    leg_role_names = ["thigh", "calf", "foot", "ball"]
    for side, root_ni in [("_l", leg_l), ("_r", leg_r)]:
        if root_ni is None:
            continue
        chain = _longest_chain(children, root_ni)
        for i, ni in enumerate(chain[:len(leg_role_names)]):
            roles[leg_role_names[i] + side] = ni

    return roles, pos


# --- Target template loading + role -> template-name resolution ------------

TEMPLATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "rig_templates", "skm")


def _load_template(target):
    path = os.path.join(TEMPLATE_DIR, f"{target}.bones.json")
    if not os.path.isfile(path):
        raise FileNotFoundError(
            f"target template not found: {target} "
            f"(looked in scripts/rig_templates/skm/)")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f), path


def _normalize(name):
    return re.sub(r"[^a-z0-9]+", "", name.lower())


def _resolve_role_to_template_name(role, template_bones):
    """Return the template bone name that best matches a given role.

    Strategy:
      1. Exact (case-insensitive) match: ``upperarm_l`` == ``upperarm_l``.
      2. Substring / token match on normalized names:
         ``upperarm_l`` -> ``LeftArm`` (contains "arm" + "l" side hint).
      3. Per-role synonyms table (Mixamo, UE5, Maya, CC, generic).
    Returns ``None`` if no confident match was found.
    """
    bone_names = [b["name"] for b in template_bones]
    name_set_lower = {n.lower(): n for n in bone_names}
    norm_to_orig = {_normalize(n): n for n in bone_names}

    # 1. Exact match
    if role.lower() in name_set_lower:
        return name_set_lower[role.lower()]
    if _normalize(role) in norm_to_orig:
        return norm_to_orig[_normalize(role)]

    # 2. Synonyms table. Each role -> ordered list of candidate names/patterns.
    side_suffix = ""
    base_role = role
    if role.endswith("_l"):
        side_suffix = "l"
        base_role = role[:-2]
    elif role.endswith("_r"):
        side_suffix = "r"
        base_role = role[:-2]

    SYNONYMS = {
        "pelvis":   ["pelvis", "hips", "hip", "root", "bip01pelvis"],
        "spine_01": ["spine_01", "spine01", "spine1", "spine", "bip01spine"],
        "spine_02": ["spine_02", "spine02", "spine2", "bip01spine1"],
        "spine_03": ["spine_03", "spine03", "spine3", "chest", "bip01spine2"],
        "spine_04": ["spine_04", "spine04", "upperchest"],
        "spine_05": ["spine_05", "spine05"],
        "neck_01":  ["neck_01", "neck01", "neck"],
        "neck_02":  ["neck_02", "neck02", "neck1"],
        "head":     ["head"],
        "clavicle": ["clavicle", "shoulder", "collar"],
        "upperarm": ["upperarm", "arm", "uparm", "shoulderarm"],
        "lowerarm": ["lowerarm", "forearm", "elbow"],
        "hand":     ["hand", "wrist", "palm"],
        "thigh":    ["thigh", "upleg", "upperleg", "leg"],
        "calf":     ["calf", "leg", "knee", "lowerleg", "shin"],
        "foot":     ["foot", "ankle"],
        "ball":     ["ball", "toebase", "toe"],
        "thumb":    ["thumb"],
        "index":    ["index"],
    }

    # Finger roles like "thumb_01_l" -> split index too.
    finger_idx = None
    m = re.match(r"^(thumb|index)_(\d+)$", base_role)
    if m:
        base_role = m.group(1)
        finger_idx = int(m.group(2))

    candidates = SYNONYMS.get(base_role, [base_role])

    # 3. Score every template bone against candidates + side suffix + finger idx
    best = None
    best_score = -1
    side_tokens_l = ["_l", "l_", "left", ".l", "-l", "lf"]
    side_tokens_r = ["_r", "r_", "right", ".r", "-r", "rt"]
    for bone_name in bone_names:
        norm = _normalize(bone_name)
        lower = bone_name.lower()
        score = 0
        for cand in candidates:
            if cand in norm:
                score += 10 if cand == _normalize(base_role) else 6
                break
        if score == 0:
            continue
        if side_suffix == "l":
            if any(t in lower for t in side_tokens_l):
                score += 5
            elif any(t in lower for t in side_tokens_r):
                score -= 5
        elif side_suffix == "r":
            if any(t in lower for t in side_tokens_r):
                score += 5
            elif any(t in lower for t in side_tokens_l):
                score -= 5
        if finger_idx is not None:
            idx_strs = [f"{finger_idx:02d}", f"{finger_idx}", f"_0{finger_idx}"]
            if any(s in norm for s in idx_strs):
                score += 4
        # Penalise IK / twist / corrective bones -- we want the deform bone.
        for bad in ("ik", "twist", "ctrl", "control", "helper", "corrective"):
            if bad in norm:
                score -= 3
                break
        if score > best_score:
            best_score = score
            best = bone_name

    if best_score < 6:
        return None
    return best


# --- Main remap -------------------------------------------------------------

def remap_glb(input_path, output_path, target):
    if target in ("none", "puppeteer_raw"):
        shutil.copyfile(input_path, output_path)
        out_size = os.path.getsize(output_path)
        print(f"MAPPING_SUMMARY: copied verbatim (target={target})", flush=True)
        print(f"REMAP_SUCCESS: {output_path} ({out_size} bytes)", flush=True)
        return

    template, tpl_path = _load_template(target)
    template_bones = template.get("bones", [])
    if not template_bones:
        raise ValueError(f"template {tpl_path} has no 'bones' array")
    print(f"TEMPLATE: {os.path.basename(tpl_path)} "
          f"({len(template_bones)} bones)", flush=True)

    gltf, _json_blob, bin_blob, tail = _read_glb(input_path)
    if "skins" not in gltf or not gltf["skins"]:
        raise ValueError("GLB has no skin -- not a rigged file")

    roles, pos = classify_puppeteer_roles(gltf, bin_blob, skin_index=0)

    # Resolve every detected role to its target-template name.
    role_to_target = {}
    skipped_roles = []
    for role in roles:
        tgt_name = _resolve_role_to_template_name(role, template_bones)
        if tgt_name is None:
            skipped_roles.append(role)
        else:
            role_to_target[role] = tgt_name

    # Build node_idx -> target name (skip collisions, first-come-first-served).
    node_to_name = {}
    used_names = set()
    for role, ni in roles.items():
        tgt = role_to_target.get(role)
        if not tgt or tgt in used_names:
            continue
        node_to_name[ni] = tgt
        used_names.add(tgt)

    skin = gltf["skins"][0]
    joints = list(skin["joints"])
    total = len(joints)
    classified = 0
    kept = 0
    for ni in joints:
        node = gltf["nodes"][ni]
        old = node.get("name") or f"joint_{ni}"
        new = node_to_name.get(ni)
        p = pos[ni]
        if new:
            node["name"] = new
            classified += 1
            print(f"MAP: {old} ({p[0]:+.3f}, {p[1]:+.3f}, {p[2]:+.3f}) -> {new}",
                  flush=True)
        else:
            if not node.get("name"):
                node["name"] = old
            kept += 1
            print(f"KEEP: {old} ({p[0]:+.3f}, {p[1]:+.3f}, {p[2]:+.3f}) -> unmapped",
                  flush=True)

    for role in skipped_roles:
        print(f"MAP_SKIP: role '{role}' has no matching bone in template "
              f"'{target}'", flush=True)

    _write_glb(output_path, gltf, bin_blob, tail)
    out_size = os.path.getsize(output_path)
    print(f"MAPPING_SUMMARY: {classified}/{total} joints classified, "
          f"{kept}/{total} kept generic "
          f"(target={target}, skipped_roles={len(skipped_roles)})", flush=True)
    print(f"REMAP_SUCCESS: {output_path} ({out_size} bytes)", flush=True)


# --- CLI --------------------------------------------------------------------

def _parse_args(argv):
    target = "orc_m1"
    positional = []
    i = 1
    while i < len(argv):
        a = argv[i]
        if a == "--target" and i + 1 < len(argv):
            target = argv[i + 1]
            i += 2
            continue
        if a.startswith("--target="):
            target = a.split("=", 1)[1]
            i += 1
            continue
        positional.append(a)
        i += 1
    return target, positional


def main(argv):
    target, positional = _parse_args(argv)
    if len(positional) != 2:
        print("usage: python puppeteer_to_skeleton.py --target <name> "
              "<input.glb> <output.glb>", flush=True)
        return 1
    inp, out = positional
    if not os.path.isfile(inp):
        print(f"AUTORIG_ERROR: input not found: {inp}", flush=True)
        return 1
    try:
        remap_glb(inp, out, target)
    except FileNotFoundError as e:
        print(f"AUTORIG_ERROR: {e}", flush=True)
        return 1
    except Exception as e:
        print(f"AUTORIG_ERROR: {type(e).__name__}: {e}", flush=True)
        import traceback
        traceback.print_exc()
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
