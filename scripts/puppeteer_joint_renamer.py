"""Rename Puppeteer joint_NN/bone_NN -> anatomical names so AnyTop's T5
joint-name conditioner can differentiate appendages.

The AnyTop T5 conditioner (model/conditioners.py:334 `_split_and_replace`)
does `re.sub(r'[\\d_]+', '', part)` which strips digits and underscores.
That means every Puppeteer joint name `joint_0`, `joint_1`, ..., `joint_46`
collapses to a single token "joint" -> identical embedding for every joint
-> AnyTop cannot tell a leg from a wing from a tail -> near-identity
motion ("collapse").

Fix: assign each Puppeteer joint a categorical anatomical name (Hips,
Spine, Neck, Head, LeftArm, RightArm, LeftLeg, RightLeg, LeftWing,
RightWing, Tail). Distinct categories survive `_split_and_replace`;
joints inside the same chain share a category but are differentiated by
the model via the graph (parents, tpos, graph_dist) -- this matches how
Truebones-trained classes work (Dragon's "spine1"/"spine2" tokenize to
the same "spine" word, the model uses position-in-graph to order them).

Two-tier resolution:
  Tier 1 -- rig_mapping JSON effectors (scripts/rig_mappings/*.json).
            Walks each effector chain_bones_target list, emits the role
            (hip/spine/neck/head/arm/leg/wing/tail) for every joint
            index that appears. High-fidelity for known target families
            (flying_quadruped, humanoid_puppeteer, ...).
  Tier 2 -- topology heuristic. Walks the skeleton graph from the root,
            classifies subtrees by world-space direction (up=spine,
            down=legs, sideways=arms, etc.) and side (X sign). Used when
            no rig_mapping matches.

Public API:
  rename_for_anytop(joint_idxs, parent_by_idx, world_by_idx, name_by_idx,
                    *, rig_mapping_path=None) -> dict[int, str]
  is_synthetic_naming(name_by_idx) -> bool
  load_rig_mapping(family_or_path) -> dict | None

Tested by running the resulting BVH through AnyTop's T5 tokenizer and
asserting len(set(tokens)) > 1 (no collapse).
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

import numpy as np


HERE = Path(__file__).resolve().parent
RIG_MAPPINGS_DIR = HERE / "rig_mappings"


# ---------------------------------------------------------------------------
# Anatomical name vocabulary
# ---------------------------------------------------------------------------
# Each role maps to a CapitalizedAnatomical word that survives T5's
# `_split_and_replace`. Side-prefixed variants ("LeftArm") split into
# ["Left", "Arm"] -> "Left Arm" -- still distinct between sides.
ROLE_TO_BASENAME = {
    "hip":   "Hips",
    "spine": "Spine",
    "neck":  "Neck",
    "head":  "Head",
    "arm":   "Arm",
    "leg":   "Leg",
    "wing":  "Wing",
    "tail":  "Tail",
    "foot":  "Foot",
    "hand":  "Hand",
    "shoulder": "Shoulder",
}
SIDE_TO_PREFIX = {
    "l": "Left",
    "r": "Right",
    None: "",
    "": "",
}


def _anatomical_name(role: str, side: str | None, chain_idx: int | None = None) -> str:
    """Compose a name like 'LeftArm', 'Spine', 'Tail'. chain_idx is
    appended as a digit -- T5 strips it but we keep it so two distinct
    BVH JOINT lines don't collide as syntactic duplicates inside the
    same parent block (BVH spec doesn't actually require uniqueness, but
    several parsers reject duplicates)."""
    base = ROLE_TO_BASENAME.get(role, "Joint")
    prefix = SIDE_TO_PREFIX.get(side, "")
    name = f"{prefix}{base}"
    if chain_idx is not None:
        name = f"{name}{int(chain_idx):02d}"
    return name


# ---------------------------------------------------------------------------
# Tier 1 -- rig_mapping effectors
# ---------------------------------------------------------------------------
def load_rig_mapping(family_or_path: str) -> dict | None:
    """Load a rig_mapping JSON. Accepts either a target_family name
    ('flying_quadruped'), a file basename (sans .json), or an absolute
    path. Returns None if not found."""
    if not family_or_path:
        return None
    p = Path(family_or_path)
    if p.is_file():
        return json.loads(p.read_text(encoding="utf-8"))
    if not RIG_MAPPINGS_DIR.is_dir():
        return None
    for fn in RIG_MAPPINGS_DIR.glob("*.json"):
        try:
            data = json.loads(fn.read_text(encoding="utf-8"))
        except Exception:
            continue
        if (data.get("target_family") == family_or_path
                or fn.stem == family_or_path
                or family_or_path in fn.stem):
            return data
    return None


def _names_from_effectors(
    effectors: list[dict],
    joint_idxs: list[int],
) -> dict[int, str]:
    """Walk each effector's chain_bones_target list and assign role-based
    names. Returns a partial mapping; joints not in any chain stay
    unnamed (caller fills with Spine fallback)."""
    EFFECTOR_TO_ROLE_SIDE = {
        "hip":         ("hip", None),
        "head_tip":    ("head", None),       # we'll re-label all but last as Neck below
        "tail_tip":    ("tail", None),
        "hand_l_tip":  ("arm", "l"),
        "hand_r_tip":  ("arm", "r"),
        "foot_l_tip":  ("leg", "l"),
        "foot_r_tip":  ("leg", "r"),
        "wing_l_tip":  ("wing", "l"),
        "wing_r_tip":  ("wing", "r"),
    }
    out: dict[int, str] = {}
    for eff in effectors:
        name = eff.get("name") or ""
        chain = list(eff.get("chain_bones_target") or [])
        role_side = EFFECTOR_TO_ROLE_SIDE.get(name)
        if not role_side or not chain:
            continue
        role, side = role_side
        # chain is ordered chain_root -> ... -> tip. Iterate, assigning
        # increasing chain_idx so duplicates inside the chain don't
        # collide as raw BVH joint names (we still rely on T5 collapsing
        # digits, so this is purely a BVH-parser nicety).
        for idx_in_chain, jidx in enumerate(chain):
            if jidx not in joint_idxs:
                continue
            # head chain: last element = Head, others = Neck
            this_role = role
            if name == "head_tip":
                this_role = "head" if idx_in_chain == len(chain) - 1 else "neck"
            out[jidx] = _anatomical_name(this_role, side, idx_in_chain)
    return out


def _classify_via_rig_mapping(
    joint_idxs: list[int],
    parent_by_idx: dict[int, int],
    rig_mapping: dict,
) -> dict[int, str]:
    """Use effector chains in the rig_mapping. Joints not in any chain
    are tagged 'Spine' (anything connecting Hips up the body) by walking
    from Hips toward the highest neck/head joint."""
    effectors = rig_mapping.get("effectors") or []
    if not effectors:
        return {}
    chain_names = _names_from_effectors(effectors, joint_idxs)
    if not chain_names:
        return {}

    # Fill the spine: any joint along the path from Hips to a head/neck
    # joint that isn't in any chain gets "Spine".
    hip_idx = next((j for j, n in chain_names.items() if n == "Hips"), None)
    if hip_idx is None:
        return chain_names

    # Identify head-side anchors
    head_anchors = [j for j, n in chain_names.items() if n.startswith("Head") or n.startswith("Neck")]
    if head_anchors:
        # Walk parents from the LOWEST neck joint up to (but not
        # including) Hips, tagging untagged joints as Spine.
        # 'Lowest neck' = the neck joint whose parent is NOT another
        # neck/head joint (closest to Hips). Build child-set for that.
        named_set = set(chain_names.keys())
        # BFS from hip going down through children of joints already named.
        # Simpler: any joint between Hips and a head_anchor on the parent
        # path gets named Spine.
        for anchor in head_anchors:
            cur = parent_by_idx.get(anchor, -1)
            seen = set()
            spine_idx = 0
            while cur != -1 and cur != hip_idx and cur not in seen:
                seen.add(cur)
                if cur not in named_set:
                    spine_idx += 1
                    chain_names[cur] = _anatomical_name("spine", None, spine_idx)
                    named_set.add(cur)
                cur = parent_by_idx.get(cur, -1)
    return chain_names


# ---------------------------------------------------------------------------
# Tier 2 -- topology heuristic (fallback for unknown rigs)
# ---------------------------------------------------------------------------
def _classify_via_topology(
    joint_idxs: list[int],
    parent_by_idx: dict[int, int],
    world_by_idx: dict[int, np.ndarray],
) -> dict[int, str]:
    """Heuristic anatomical labeling driven by world-space direction.

    Assumptions:
    - glTF / Puppeteer = Y-up, +Y is the head direction.
    - The root joint is the pelvis ('Hips').
    - Subtrees rooted at children of the root are classified by:
        avg_direction from root_pos
            -> +Y -> spine/neck chain (continues up to head)
            -> -Y -> leg (sided by X sign)
            -> +X -> right arm/wing
            -> -X -> left arm/wing
            -> +/-Z -> tail (back of pelvis)
    - Arm vs Wing: short chain (<=4) = arm; long chain (>=5) with mostly
      sideways extent = wing. Single-side tie-broken by mirroring.
    """
    out: dict[int, str] = {}
    if not joint_idxs:
        return out

    root_idx = next((j for j in joint_idxs if parent_by_idx.get(j, -1) == -1), joint_idxs[0])
    out[root_idx] = "Hips"
    root_pos = world_by_idx.get(root_idx, np.zeros(3))

    # Children of root
    root_children = [j for j in joint_idxs if parent_by_idx.get(j, -1) == root_idx]

    # Build child map
    children_by_idx: dict[int, list[int]] = {j: [] for j in joint_idxs}
    for j in joint_idxs:
        p = parent_by_idx.get(j, -1)
        if p in children_by_idx:
            children_by_idx[p].append(j)

    def descendants(start: int) -> list[int]:
        out_list, stack = [], [start]
        while stack:
            cur = stack.pop()
            out_list.append(cur)
            stack.extend(children_by_idx.get(cur, []))
        return out_list

    def avg_dir(start: int) -> np.ndarray:
        nodes = descendants(start)
        if len(nodes) < 2:
            return world_by_idx.get(start, root_pos) - root_pos
        pts = np.stack([world_by_idx.get(n, root_pos) for n in nodes], axis=0)
        centroid = pts.mean(axis=0)
        return centroid - root_pos

    # Classify each root child's subtree
    subtree_kinds: dict[int, str] = {}
    for ch in root_children:
        d = avg_dir(ch)
        sub = descendants(ch)
        n_in_sub = len(sub)

        ax, ay, az = float(d[0]), float(d[1]), float(d[2])
        abs_x, abs_y, abs_z = abs(ax), abs(ay), abs(az)

        if abs_y > abs_x and abs_y > abs_z:
            # vertical
            if ay > 0:
                subtree_kinds[ch] = "spine_up"
            else:
                subtree_kinds[ch] = ("leg_l" if ax > 0 else "leg_r")
        elif abs_x > abs_y and abs_x > abs_z:
            # lateral -> arm or wing
            side = "l" if ax > 0 else "r"
            if n_in_sub >= 5:
                subtree_kinds[ch] = f"wing_{side}"
            else:
                subtree_kinds[ch] = f"arm_{side}"
        else:
            # along Z -> tail (assume Z+ is forward, tail is opposite)
            subtree_kinds[ch] = "tail"

    def walk_chain(root_of_chain: int, role: str, side: str | None) -> None:
        """Name the chain starting at root_of_chain. Walks down the
        longest descendant path naming each joint with chain_idx."""
        # Find the longest single-branch path
        cur = root_of_chain
        chain_idx = 0
        while True:
            if role == "spine_up":
                # promote final node to Head, mid to Neck, rest to Spine
                pass  # handled by special-case below
            else:
                out[cur] = _anatomical_name(role, side, chain_idx)
            kids = children_by_idx.get(cur, [])
            if not kids:
                break
            # follow the longest descendant
            best = max(kids, key=lambda k: len(descendants(k)))
            cur = best
            chain_idx += 1

    def walk_spine_chain(root_of_chain: int) -> None:
        """Walk spine: bottom -> Spine, near-top -> Neck, top -> Head."""
        path = []
        cur = root_of_chain
        while True:
            path.append(cur)
            kids = children_by_idx.get(cur, [])
            if not kids:
                break
            cur = max(kids, key=lambda k: len(descendants(k)))
        L = len(path)
        # rough partition: top 1 = Head, next 1-2 = Neck, rest = Spine
        for i, j in enumerate(path):
            if i == L - 1 and L >= 2:
                out[j] = _anatomical_name("head", None, 0)
            elif i >= L - 3 and L >= 3:
                out[j] = _anatomical_name("neck", None, L - 1 - i)
            else:
                out[j] = _anatomical_name("spine", None, i)

    for ch, kind in subtree_kinds.items():
        if kind == "spine_up":
            walk_spine_chain(ch)
        elif kind == "tail":
            walk_chain(ch, "tail", None)
        else:
            # role_side like "arm_l", "leg_r", "wing_l"
            parts = kind.split("_")
            role, side = parts[0], parts[1] if len(parts) > 1 else None
            walk_chain(ch, role, side)

    # Fill any unnamed joints (side-branches off main chains) with their
    # parent's role basename + a Branch suffix so they don't all collapse.
    for j in joint_idxs:
        if j not in out:
            p = parent_by_idx.get(j, -1)
            parent_name = out.get(p, "Hips")
            # extract base (strip digits)
            base = re.sub(r"\d+$", "", parent_name) or "Spine"
            out[j] = f"{base}Branch"
    return out


# ---------------------------------------------------------------------------
# Synthetic-naming detector
# ---------------------------------------------------------------------------
_SYNTHETIC_PATTERNS = [
    re.compile(r"^joint[_ ]*\d+$", re.IGNORECASE),
    re.compile(r"^bone[_ ]*\d+$", re.IGNORECASE),
    re.compile(r"^j\d+$", re.IGNORECASE),
    re.compile(r"^b\d+$", re.IGNORECASE),
]


def is_synthetic_naming(name_by_idx: dict[int, str]) -> bool:
    """True if the majority of joint names look auto-generated
    ('joint_0', 'bone_12', etc.) and would collapse under the T5
    tokenizer."""
    if not name_by_idx:
        return False
    names = list(name_by_idx.values())
    n_synthetic = sum(
        1 for n in names if any(p.match(n.strip()) for p in _SYNTHETIC_PATTERNS)
    )
    return n_synthetic >= max(1, int(0.6 * len(names)))


# ---------------------------------------------------------------------------
# Tokenizer simulation (for assertion / sanity check)
# ---------------------------------------------------------------------------
def t5_tokenize_like(name: str) -> str:
    """Replicate AnyTop's `_split_and_replace`. Used by callers to
    assert no two joints collapse to the same token AFTER renaming."""
    # mirrors c:/tmp/anytop_pure/model/conditioners.py:334
    splitted = re.split(r"(?=[A-Z]|_)", name)
    out_words = []
    for part in splitted:
        clean = re.sub(r"[\d_]+", "", part)
        if not clean:
            continue
        if clean in ("L", "l"):
            out_words.append("Left")
        elif clean in ("R", "r"):
            out_words.append("Right")
        elif len(clean) == 1:
            continue
        else:
            out_words.append(clean)
    return " ".join(out_words)


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------
def rename_for_anytop(
    joint_idxs: list[int],
    parent_by_idx: dict[int, int],
    world_by_idx: dict[int, np.ndarray],
    name_by_idx: dict[int, str],
    *,
    rig_mapping_path: str | None = None,
    force: bool = False,
) -> dict[int, str]:
    """Return a name mapping joint_idx -> anatomical name suitable for
    AnyTop's T5 conditioner.

    If names are already anatomical (Mixamo/Truebones style), returns
    name_by_idx unchanged unless `force=True`.
    """
    if not force and not is_synthetic_naming(name_by_idx):
        return dict(name_by_idx)

    # Tier 1: rig_mapping
    rig_mapping = load_rig_mapping(rig_mapping_path) if rig_mapping_path else None
    if rig_mapping is None:
        # Try fingerprinting by joint count
        n = len(joint_idxs)
        if n == 47:
            rig_mapping = load_rig_mapping("flying_quadruped")

    mapping_out: dict[int, str] = {}
    if rig_mapping:
        mapping_out = _classify_via_rig_mapping(joint_idxs, parent_by_idx, rig_mapping)

    # Anything missing -> topology heuristic for the rest
    topo_out = _classify_via_topology(joint_idxs, parent_by_idx, world_by_idx)

    out: dict[int, str] = {}
    for j in joint_idxs:
        if j in mapping_out:
            out[j] = mapping_out[j]
        elif j in topo_out:
            out[j] = topo_out[j]
        else:
            out[j] = name_by_idx.get(j, f"Joint{j:03d}")

    # Sanity-check tokenization: warn (don't crash) if collapse remains.
    tokens = [t5_tokenize_like(n) for n in out.values()]
    distinct = len(set(tokens))
    if distinct < 4:
        sys.stderr.write(
            f"[puppeteer_joint_renamer] WARN: only {distinct} distinct T5 tokens "
            f"after rename -- model may still collapse. Names: {sorted(set(out.values()))}\n"
        )
    return out


# ---------------------------------------------------------------------------
# CLI: inspect a GLB's joint names + show the renamed version
# ---------------------------------------------------------------------------
def _main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--glb", required=True)
    ap.add_argument("--rig-mapping", default=None)
    args = ap.parse_args()

    sys.path.insert(0, str(HERE))
    from puppeteer_to_skeleton import _read_glb, _read_accessor  # type: ignore

    gltf, _, bin_blob, _ = _read_glb(args.glb)
    skins = gltf.get("skins") or []
    if not skins:
        print("GLB has no skin")
        return 1
    skin = skins[0]
    joint_idxs = skin["joints"]
    nodes = gltf["nodes"]
    name_by_idx = {i: (nodes[i].get("name") or f"joint_{i}") for i in joint_idxs}
    parent_by_idx = {i: -1 for i in joint_idxs}
    for p in joint_idxs:
        for c in (nodes[p].get("children") or []):
            if c in joint_idxs:
                parent_by_idx[c] = p
    ibm_acc = skin.get("inverseBindMatrices")
    world_by_idx = {}
    if ibm_acc is not None:
        ibm_flat = _read_accessor(gltf, bin_blob, ibm_acc)
        ibm_mats = np.asarray(ibm_flat).reshape(len(joint_idxs), 4, 4)
        ibm_mats = np.transpose(ibm_mats, (0, 2, 1))
        for k, jidx in enumerate(joint_idxs):
            try:
                w = np.linalg.inv(ibm_mats[k])
                world_by_idx[jidx] = w[:3, 3]
            except Exception:
                world_by_idx[jidx] = np.zeros(3)

    print(f"INPUT: {len(joint_idxs)} joints, synthetic={is_synthetic_naming(name_by_idx)}")
    renamed = rename_for_anytop(
        joint_idxs, parent_by_idx, world_by_idx, name_by_idx,
        rig_mapping_path=args.rig_mapping,
    )
    print(f"RENAME ({len(renamed)} joints):")
    for j in joint_idxs:
        orig = name_by_idx[j]
        new = renamed[j]
        tok = t5_tokenize_like(new)
        print(f"  {j:3d}: {orig:25s} -> {new:25s}  T5='{tok}'")
    tokens = [t5_tokenize_like(n) for n in renamed.values()]
    print(f"DISTINCT T5 TOKENS: {len(set(tokens))} / {len(tokens)}")
    return 0


if __name__ == "__main__":
    sys.exit(_main())
