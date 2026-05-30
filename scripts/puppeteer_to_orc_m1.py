"""Rename joints of a Puppeteer-rigged GLB to orc_m1 / UE5 humanoid names.

This is the post-processor that turns a freshly-rigged Puppeteer GLB
(joints called joint0..joint33, all sitting on X=0 once you accumulate
node.translation naively) into something that downstream tools
(`bake_procedural_anims.py`, the orc_m1 retarget) can address by exact
UE5 bone names: pelvis, spine_01, upperarm_l, hand_r, thigh_l, ...

Reference
---------
See AUDIT_2026-05-29.md for the full mapping derivation. Two findings
drive this script:

1. The Puppeteer GLB has rotations on 29/36 nodes. Summing only
   ``node.translation`` up the parent chain (what swap_skeleton.py does
   at L125-136) collapses every joint onto X=0, which kills any L/R
   classifier that reads the X coordinate. The ONLY reliable source of
   joint world positions in this file is
   ``inverse(skin.inverseBindMatrices[i])[:3, 3]``.

2. The classifier itself is a straightforward topology+geometry walk:
     root          = lowest joint with >=2 joint-children
     spine         = longest upward chain from root
     arms          = upper-half spine branches with lateral spread
     legs          = root branches that drop a lot with low lateral
     fingers       = hand sub-branches, innermost = thumb else index
   Joints that do not match any anatomy keep their original name -- we
   never invent a UE5 name we cannot defend with a position.

Usage
-----
    python puppeteer_to_orc_m1.py <input_puppeteer.glb> <output.glb>

Exits 0 on success, 1 on failure (prints ``AUTORIG_ERROR:`` line).

Author: FabWare / MeshyMyself
"""

import json
import os
import struct
import sys

import numpy as np

# UTF-8 stdout shim -- Puppeteer logs include arrows etc., Windows cp1252
# would otherwise crash on the first non-ASCII char.
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
    """Parse a GLB file into (gltf_json_dict, json_blob, bin_blob, tail).

    ``tail`` is anything past the first two chunks (almost always empty,
    but we preserve it byte-for-byte so we round-trip the file safely).
    """
    with open(path, "rb") as f:
        data = f.read()
    if len(data) < 12 or data[:4] != GLB_MAGIC:
        raise ValueError(f"not a valid GLB: {path}")
    version, total_length = struct.unpack("<II", data[4:12])
    if version != 2:
        raise ValueError(f"unsupported GLB version {version}")

    # JSON chunk
    json_len = struct.unpack("<I", data[12:16])[0]
    json_type = data[16:20]
    if json_type != JSON_CHUNK_TYPE:
        raise ValueError(f"first chunk not JSON: {json_type!r}")
    json_blob = data[20:20 + json_len]
    gltf = json.loads(json_blob.decode("utf-8"))

    # BIN chunk (optional, but Puppeteer always has one)
    cursor = 20 + json_len
    bin_blob = b""
    bin_header_len = 0
    if cursor < len(data):
        bin_len = struct.unpack("<I", data[cursor:cursor + 4])[0]
        bin_type = data[cursor + 4:cursor + 8]
        if bin_type == BIN_CHUNK_TYPE:
            bin_blob = data[cursor + 8:cursor + 8 + bin_len]
            bin_header_len = 8
            cursor += 8 + bin_len
    tail = data[cursor:]
    return gltf, json_blob, bin_blob, tail, bin_header_len


def _write_glb(out_path, gltf, bin_blob, tail):
    """Rewrite a GLB with a fresh JSON chunk + the original BIN chunk."""
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
    """Return (J,3) world-space joint positions via inverse(IBM).

    glTF stores matrices column-major (per spec), so reshape (J,4,4) and
    transpose, then ``world = inv(ibm)[:3, 3]``.
    """
    joints = list(skin["joints"])
    J = len(joints)
    raw = _read_accessor(gltf, bin_blob, skin["inverseBindMatrices"]).reshape(J, 4, 4)
    # glTF matrices: column-major in storage -> row-major numpy via transpose
    ibm = raw.transpose(0, 2, 1).astype(np.float64)
    world = np.linalg.inv(ibm)[:, :3, 3]
    return joints, world


# --- Joint topology helpers -------------------------------------------------

def _build_joint_hierarchy(gltf, joints):
    """Return (children_map, parent_map) restricted to the joints-only tree."""
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


# --- Classifier -------------------------------------------------------------

def classify_puppeteer(gltf, bin_blob, skin_index=0):
    """Return ``{node_idx: ue5_name}`` for the joints of ``skin_index``.

    Algorithm spec lives in AUDIT_2026-05-29.md section 5.
    """
    skin = gltf["skins"][skin_index]
    joints, world = _joint_world_positions(gltf, bin_blob, skin)
    pos = {ni: world[i] for i, ni in enumerate(joints)}
    children, parent = _build_joint_hierarchy(gltf, joints)
    roots = [ni for ni in joints if ni not in parent]
    if not roots:
        return {}, pos

    # Up / side axes from world bbox.
    # X is never "up" for a humanoid -- in a T-pose the arms stretch X wider
    # than the body is tall, so we restrict the up-axis vote to Y vs Z and
    # let X be the side axis by default (glTF Y-up convention).
    P = world
    bb_min, bb_max = P.min(axis=0), P.max(axis=0)
    size = bb_max - bb_min
    up_axis = 1 if size[1] >= size[2] else 2  # Y vs Z, never X
    # Side axis = the remaining axis with the largest spread (always X for
    # a normal humanoid, but stay defensive).
    side_candidates = [(size[i], i) for i in range(3) if i != up_axis]
    side_axis = max(side_candidates)[1]
    body_h = float(size[up_axis])

    def UP(v): return float(v[up_axis])
    def SIDE(v): return float(v[side_axis])

    # Pelvis = lowest root with >= 2 joint-children
    candidates = [r for r in roots if len(children[r]) >= 2]
    if not candidates:
        candidates = roots
    root = min(candidates, key=lambda r: (UP(pos[r]), -len(children[r])))

    # Spine = longest mostly-vertical chain from root.
    # Two stop conditions:
    #   (a) the next step would go DOWN (Y decreases) -> we've hit a leg fork
    #   (b) the next step deviates laterally from the current SIDE position
    #       more than ~8% of body height -> we've hit a clavicle/arm branch.
    # Among kids that survive the side-deviation gate, prefer the one whose
    # subtree is deepest AND whose own SIDE stays closest to the current node.
    spine_root_side = SIDE(pos[root])
    side_gate = body_h * 0.08

    def _on_axis_depth(ni):
        """Longest chain length through ni where every node stays on the spine axis."""
        if abs(SIDE(pos[ni]) - spine_root_side) > side_gate:
            return -1
        best = 0
        for c in children.get(ni, []):
            d = _on_axis_depth(c)
            if d >= 0:
                best = max(best, 1 + d)
        return best

    def _is_clavicle_like(ni):
        """True if any direct child of ni splays laterally off the spine axis.

        Clavicles sit on the spine line themselves but their immediate child
        (the upperarm) is way off-axis. That's how we tell a clavicle apart
        from a true spine joint, which only ever feeds either another
        on-axis joint or a leaf neck.
        """
        for c in children.get(ni, []):
            if abs(SIDE(pos[c]) - spine_root_side) > side_gate:
                return True
        return False

    def upward_chain(start):
        chain = [start]
        cur = start
        while children.get(cur):
            kids = children[cur]
            # Eligible spine steps: on-axis, going up, NOT a clavicle.
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

    # Arms = upper-half side branches with lateral spread.
    # CRUCIAL: skip kids that are themselves on the spine -- otherwise the
    # k_chain from a spine kid reaches an arm tip and we double-count.
    arm_roots = []  # (root_ni, signed_side)
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
    arms.sort(key=lambda x: x[1])  # most-negative first (= right)
    arm_r = arms[0][0] if len(arms) == 2 else None
    arm_l = arms[-1][0] if len(arms) == 2 else None

    # Legs = root branches dropping a lot, low lateral.
    # Side is taken from the MOST-lateral joint in the chain (often the foot/
    # ball/toe) because the thigh root itself sits under the pelvis at X~=0.
    # The legs usually fork off the pelvis itself but in some rigs the
    # spine_01 joint owns them, so we scan a small window without duplicates.
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
                # Side sign from the joint with maximum |SIDE| in the chain.
                signed_side = max(
                    (SIDE(pos[c]) for c in k_chain),
                    key=lambda s: abs(s),
                )
                leg_cands.append((kid, signed_side))
    # Two legs: the two with the largest |signed_side|, then split by sign.
    leg_cands.sort(key=lambda x: abs(x[1]), reverse=True)
    legs = leg_cands[:2]
    legs.sort(key=lambda x: x[1])  # negative SIDE first -> right leg
    leg_r = legs[0][0] if len(legs) == 2 else None
    leg_l = legs[-1][0] if len(legs) == 2 else None

    # Name assignment
    name = {}
    spine_names = ["pelvis", "spine_01", "spine_02", "spine_03", "spine_04",
                   "spine_05", "neck_01", "neck_02", "head"]
    # If the last spine joint is a leaf sitting at shoulder height (above
    # the highest detected arm root), it is the neck, not another spine_*
    # vertebra. We pop it off the spine chain and label it neck_01 so that
    # downstream animators that look up "neck_01" by exact name still hit.
    spine_assign = list(spine)
    neck_tail = None
    if len(spine_assign) >= 3 and not children.get(spine_assign[-1]):
        tail = spine_assign[-1]
        tail_h = UP(pos[tail])
        arm_h = max((UP(pos[a]) for a, _ in arms), default=tail_h)
        if tail_h >= arm_h - body_h * 0.02:
            neck_tail = spine_assign.pop()
    for i, ni in enumerate(spine_assign):
        if i < len(spine_names):
            name[ni] = spine_names[i]
    if neck_tail is not None:
        name[neck_tail] = "neck_01"

    arm_names = ["clavicle", "upperarm", "lowerarm", "hand"]
    for side, root_ni in [("_l", arm_l), ("_r", arm_r)]:
        if root_ni is None:
            continue
        chain = _longest_chain(children, root_ni)
        for i, ni in enumerate(chain[:len(arm_names)]):
            name[ni] = arm_names[i] + side
        hand_ni = chain[3] if len(chain) > 3 else None
        if hand_ni is not None and children[hand_ni]:
            # Sub-chains off the hand: classify thumb vs index by SIDE.
            # Thumb sits closer to the body midline (smaller |SIDE - hand|).
            hand_side = SIDE(pos[hand_ni])
            finger_chains = [_longest_chain(children, c) for c in children[hand_ni]]
            # Drop single-joint stubs (leaves at hand level are degenerate
            # joints, not real fingers) and prefer longer chains. We then
            # sort by side offset (thumb closer to midline).
            finger_chains = [fc for fc in finger_chains if len(fc) >= 2]
            finger_chains.sort(key=lambda fc: (-len(fc),
                                                abs(SIDE(pos[fc[0]]) - hand_side)))
            # Now pick the 2 closest to body midline among the surviving real
            # finger chains, with thumb being the closer one.
            finger_chains = sorted(
                finger_chains[:max(2, len(finger_chains))],
                key=lambda fc: abs(SIDE(pos[fc[0]]) - hand_side),
            )
            labels = ["thumb", "index"]
            for j, fc in enumerate(finger_chains[:2]):
                lbl = labels[j]
                for k, fni in enumerate(fc[:3]):
                    name[fni] = f"{lbl}_{k + 1:02d}{side}"

    leg_names = ["thigh", "calf", "foot", "ball"]
    for side, root_ni in [("_l", leg_l), ("_r", leg_r)]:
        if root_ni is None:
            continue
        chain = _longest_chain(children, root_ni)
        for i, ni in enumerate(chain[:len(leg_names)]):
            name[ni] = leg_names[i] + side

    return name, pos


# --- Main -------------------------------------------------------------------

def remap_glb(input_path, output_path):
    gltf, _json_blob, bin_blob, tail, _bin_hdr = _read_glb(input_path)
    if "skins" not in gltf or not gltf["skins"]:
        raise ValueError("GLB has no skin -- not a rigged file")

    mapping, pos = classify_puppeteer(gltf, bin_blob, skin_index=0)

    skin = gltf["skins"][0]
    joints = list(skin["joints"])
    total = len(joints)
    classified = 0
    kept = 0
    used_names = set()
    for ni in joints:
        node = gltf["nodes"][ni]
        old = node.get("name") or f"joint_{ni}"
        new = mapping.get(ni)
        p = pos[ni]
        if new and new not in used_names:
            node["name"] = new
            used_names.add(new)
            classified += 1
            print(f"MAP: {old} ({p[0]:+.3f}, {p[1]:+.3f}, {p[2]:+.3f}) -> {new}",
                  flush=True)
        else:
            if new and new in used_names:
                # Name collision -- keep original to avoid breaking downstream
                # exact-name lookups in bake_procedural_anims.
                print(f"SKIP: {old} would collide with already-used '{new}', keeping original",
                      flush=True)
            else:
                print(f"KEEP: {old} ({p[0]:+.3f}, {p[1]:+.3f}, {p[2]:+.3f}) -> unmapped",
                      flush=True)
            # Make sure the node has *some* stable name
            if not node.get("name"):
                node["name"] = old
            kept += 1

    _write_glb(output_path, gltf, bin_blob, tail)
    out_size = os.path.getsize(output_path)
    print(f"MAPPING_SUMMARY: {classified}/{total} joints classified, "
          f"{kept}/{total} kept generic", flush=True)
    print(f"REMAP_SUCCESS: {output_path} ({out_size} bytes)", flush=True)


def main(argv):
    if len(argv) != 3:
        print("usage: python puppeteer_to_orc_m1.py <input.glb> <output.glb>",
              flush=True)
        return 1
    inp, out = argv[1], argv[2]
    if not os.path.isfile(inp):
        print(f"AUTORIG_ERROR: input not found: {inp}", flush=True)
        return 1
    try:
        remap_glb(inp, out)
    except Exception as e:
        print(f"AUTORIG_ERROR: {type(e).__name__}: {e}", flush=True)
        import traceback
        traceback.print_exc()
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
