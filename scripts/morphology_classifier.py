"""
FabMesh — Morphology Classifier
================================

Maps a rigged GLB (Puppeteer output, UniRig, or any skinned glTF) to one of
six species archetypes used downstream by the AnyTop bridge to pick a
Truebones donor skeleton for motion retargeting.

Archetypes: 'biped' | 'quadruped' | 'hexapod' | 'serpent' | 'winged' | 'blob'

The classifier is pure pygltflib + numpy (no Blender) and relies on three
topology / geometry signals computed from skin.joints + inverseBindMatrices:

  1. terminal joint count (= "limbs / extremities" proxy)
  2. lateral symmetry along X (= wings, paired limbs)
  3. aspect ratio of the joint cloud (= long-thin serpents vs. cuboid blobs)
  4. chain-depth distribution (= snake = one deep chain, blob = none)

Outputs both an archetype and a best-match Truebones species name, sourced
from the AnyTop registry (param_utils.py: BIPEDS, QUADROPEDS, MILLIPEDS,
SNAKES, FLYING). The species pick is the AnyTop entry with the joint count
closest to the input rig — bone-correspondence lookup happens downstream
via the FACE_JOINTS table.

Smoke test at the bottom: runs on c:/tmp/dragon_rig.glb (47-bone winged
biped dragon) and asserts archetype == 'winged'.
"""

from __future__ import annotations
import sys
import os
import numpy as np
import pygltflib

# --- AnyTop registry (mirrored from data_loaders/truebones/.../param_utils.py)
BIPEDS = ["Ostrich", "Flamingo", "Raptor", "Raptor2", "Raptor3", "Trex", "Chicken", "Tyranno"]
QUADROPEDS = ["Horse", "Hippopotamus", "Comodoa", "Camel", "Bear", "Buffalo", "Cat",
              "BrownBear", "Coyote", "Crocodile", "Elephant", "Deer", "Fox", "Gazelle",
              "Goat", "Jaguar", "Lynx", "Tricera", "Stego", "SandMouse", "Raindeer",
              "Puppy", "PolarBear", "Monkey", "Mammoth", "Alligator", "Hamster",
              "Hound", "Leapord", "Lion", "PolarBearB", "Rat", "Rhino",
              "SabreToothTiger", "Skunk", "Turtle"]
MILLIPEDS = ["Cricket", "SpiderG", "Scorpion", "Isopetra", "FireAnt", "Crab",
             "Centipede", "Roach", "Ant", "HermitCrab", "Scorpion-2", "Spider"]
SNAKES = ["Anaconda", "KingCobra"]
FLYING = ["Bat", "Dragon", "Bird", "Buzzard", "Eagle", "Giantbee", "Parrot",
          "Parrot2", "Pigeon", "Pteranodon", "Tukan", "MountainDragon"]

# Approximate joint counts per AnyTop species (from the paper + local data).
# Used only to pick the closest donor — exact numbers refined as we measure them.
SPECIES_JOINT_HINT = {
    "MountainDragon": 142, "Dragon": 111, "Pteranodon": 30, "Bat": 35, "Eagle": 42,
    "Buzzard": 48, "Parrot": 66, "Parrot2": 49, "Bird": 36, "Pigeon": 7, "Tukan": 12,
    "Giantbee": 17,
    "Trex": 51, "Raptor": 20, "Raptor2": 53, "Raptor3": 54, "Tyranno": 45,
    "Ostrich": 37, "Flamingo": 23, "Chicken": 33,
    "Horse": 42, "Bear": 57, "Elephant": 37, "Camel": 33, "Cat": 28, "Fox": 34,
    "Deer": 36, "Wolf": 30, "Lion": 25, "Tricera": 29, "Stego": 28, "Crocodile": 28,
    "Hippopotamus": 35, "Comodoa": 44, "Mammoth": 39, "Turtle": 41,
    "Spider": 28, "SpiderG": 34, "Scorpion": 60, "Scorpion-2": 56, "Centipede": 48,
    "Ant": 31, "FireAnt": 30, "Crab": 52, "HermitCrab": 52, "Roach": 30,
    "Cricket": 37, "Isopetra": 56,
    "Anaconda": 27, "KingCobra": 8,
}

ARCHETYPE_TO_GROUP = {
    "winged": FLYING,
    "biped": BIPEDS,
    "quadruped": QUADROPEDS,
    "hexapod": MILLIPEDS,
    "serpent": SNAKES,
    "blob": ["MountainDragon"],  # safe fallback donor
}


# --- GLB I/O --------------------------------------------------------------

def _read_accessor(gltf: pygltflib.GLTF2, blob: bytes, idx: int) -> np.ndarray:
    acc = gltf.accessors[idx]
    bv = gltf.bufferViews[acc.bufferView]
    comp_size = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}[acc.componentType]
    type_counts = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
    n = type_counts[acc.type]
    dtype = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16,
             5125: np.uint32, 5126: np.float32}[acc.componentType]
    off = (bv.byteOffset or 0) + (acc.byteOffset or 0)
    raw = bytes(blob[off: off + acc.count * comp_size * n])
    return np.frombuffer(raw, dtype=dtype).reshape(acc.count, n).copy()


def extract_skeleton(glb_path: str):
    """Return (positions (J,3) world, parents (J,) int with -1 root, joint_names)."""
    gltf = pygltflib.GLTF2().load(glb_path)
    blob = gltf.binary_blob()
    if not gltf.skins:
        raise ValueError(f"{glb_path}: no skins")
    skin = gltf.skins[0]
    joints = list(skin.joints)
    J = len(joints)

    # IBM -> bind world position = -inv(IBM) translation row, but simpler:
    # joint_world = inverse(IBM) @ origin, and inverse of an affine TRS is well-defined.
    ibms = _read_accessor(gltf, blob, skin.inverseBindMatrices).reshape(J, 4, 4)
    # glTF stores matrices column-major
    ibms = ibms.transpose(0, 2, 1)
    positions = np.zeros((J, 3), dtype=np.float64)
    for i in range(J):
        try:
            world = np.linalg.inv(ibms[i])
            positions[i] = world[:3, 3]
        except np.linalg.LinAlgError:
            positions[i] = np.zeros(3)

    # Parent indices among the skin.joints set
    joint_to_skinidx = {n: i for i, n in enumerate(joints)}
    parents = np.full(J, -1, dtype=np.int32)
    for node_idx, node in enumerate(gltf.nodes):
        if not node.children:
            continue
        for c in node.children:
            if c in joint_to_skinidx and node_idx in joint_to_skinidx:
                parents[joint_to_skinidx[c]] = joint_to_skinidx[node_idx]

    names = [gltf.nodes[n].name or f"joint_{n}" for n in joints]
    return positions, parents, names


# --- Topology features ----------------------------------------------------

def _topology_features(positions: np.ndarray, parents: np.ndarray) -> dict:
    J = len(positions)
    # children map
    children = [[] for _ in range(J)]
    for i, p in enumerate(parents):
        if p >= 0:
            children[p].append(i)

    terminals = [i for i in range(J) if not children[i]]
    n_term = len(terminals)
    branch_nodes = sum(1 for c in children if len(c) >= 2)

    # longest chain depth
    def depth(i):
        if not children[i]:
            return 0
        return 1 + max(depth(k) for k in children[i])
    roots = [i for i in range(J) if parents[i] == -1]
    max_depth = max((depth(r) for r in roots), default=0)
    sys.setrecursionlimit(max(1000, J * 4))

    # bounding box aspect ratio
    mn = positions.min(axis=0)
    mx = positions.max(axis=0)
    ext = mx - mn
    ext = np.where(ext < 1e-6, 1e-6, ext)
    # Convention: Y-up (glTF). X = lateral, Z = forward.
    height = ext[1]
    lateral = ext[0]
    forward = ext[2]
    aspect_h_over_w = height / max(lateral, forward, 1e-6)
    aspect_long = max(forward, height) / max(lateral, 1e-6)

    # symmetry along X: count terminals that have a mirror twin within tol
    centre_x = (mn[0] + mx[0]) / 2.0
    tol = 0.05 * max(ext)
    mirrored_pairs = 0
    used = set()
    for i, ti in enumerate(terminals):
        if ti in used:
            continue
        pi = positions[ti]
        for tj in terminals[i + 1:]:
            if tj in used:
                continue
            pj = positions[tj]
            if (abs((pi[0] - centre_x) + (pj[0] - centre_x)) < tol
                    and abs(pi[1] - pj[1]) < tol
                    and abs(pi[2] - pj[2]) < tol):
                mirrored_pairs += 1
                used.add(ti); used.add(tj)
                break
    symmetry = mirrored_pairs / max(n_term // 2, 1)

    # terminal height profile: are some leaves clearly ABOVE the body centre?
    body_centre_y = (mn[1] + mx[1]) / 2.0
    high_terms = sum(1 for t in terminals if positions[t][1] > body_centre_y + 0.15 * height)
    low_terms = sum(1 for t in terminals if positions[t][1] < body_centre_y - 0.15 * height)
    # wide_terms: leaves far from X centre (limbs / wing tips, not head/tail)
    wide_terms = sum(1 for t in terminals if abs(positions[t][0] - centre_x) > 0.25 * lateral)

    return dict(
        J=J, n_term=n_term, branch_nodes=branch_nodes, max_depth=max_depth,
        aspect_h_over_w=aspect_h_over_w, aspect_long=aspect_long,
        symmetry=symmetry, high_terms=high_terms, low_terms=low_terms,
        wide_terms=wide_terms,
    )


# --- Classification -------------------------------------------------------

def _best_truebones(archetype: str, J: int) -> str:
    candidates = ARCHETYPE_TO_GROUP.get(archetype, FLYING)
    best, best_d = candidates[0], 1e9
    for sp in candidates:
        d = abs(SPECIES_JOINT_HINT.get(sp, 30) - J)
        if d < best_d:
            best, best_d = sp, d
    return best


def classify(positions: np.ndarray, parents: np.ndarray) -> dict:
    f = _topology_features(positions, parents)
    J = f["J"]
    scores = {k: 0.0 for k in ("biped", "quadruped", "hexapod", "serpent", "winged", "blob")}

    # serpent: low terminals, very long chain, no symmetry, long & thin
    if f["n_term"] <= 3 and f["max_depth"] >= max(8, J * 0.4) and f["aspect_long"] > 2.5:
        scores["serpent"] += 0.9
    if J < 15 and f["branch_nodes"] <= 2:
        scores["serpent"] += 0.2

    # hexapod: 6+ symmetric ground-level terminals
    if f["low_terms"] >= 6 and f["symmetry"] > 0.5:
        scores["hexapod"] += 0.85
    if f["n_term"] >= 8 and f["wide_terms"] >= 6:
        scores["hexapod"] += 0.2

    # quadruped: 4 low symmetric terminals, modest height, long along Z
    if 3 <= f["low_terms"] <= 5 and f["symmetry"] > 0.4 and f["aspect_h_over_w"] < 1.4:
        scores["quadruped"] += 0.8

    # biped: 2 low terminals (feet) symmetric + head up + arms ~mid
    if 2 <= f["low_terms"] <= 3 and f["high_terms"] >= 1 and f["aspect_h_over_w"] >= 1.0:
        scores["biped"] += 0.7

    # winged: at least one pair of wide+high terminals (wing tips) AND a body
    # Wings dominate over biped/quadruped — that's why dragons land here.
    if f["wide_terms"] >= 2 and f["high_terms"] >= 2 and f["symmetry"] > 0.3:
        scores["winged"] += 0.95
    # winged also accepts the dragon case (wings up + legs down)
    if f["wide_terms"] >= 2 and f["low_terms"] >= 2 and f["high_terms"] >= 1:
        scores["winged"] += 0.3

    # blob: nothing else fits / very few joints / no symmetry
    if J < 8 or f["n_term"] <= 1:
        scores["blob"] += 0.6
    if f["symmetry"] < 0.15 and f["n_term"] < 4:
        scores["blob"] += 0.3

    archetype, score = max(scores.items(), key=lambda kv: kv[1])
    if score < 0.4:
        archetype, score = "blob", 0.4

    # confidence: top score normalised, capped at 0.99
    total = sum(scores.values()) or 1.0
    confidence = min(0.99, score / total + 0.1)

    return dict(
        archetype=archetype,
        confidence=round(confidence, 3),
        truebones_match=_best_truebones(archetype, J),
        scores={k: round(v, 3) for k, v in scores.items()},
        features=f,
    )


def classify_glb(glb_path: str) -> dict:
    positions, parents, names = extract_skeleton(glb_path)
    out = classify(positions, parents)
    out["joint_count"] = len(positions)
    out["source"] = glb_path
    return out


# --- Smoke test -----------------------------------------------------------

if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else r"c:/tmp/dragon_rig.glb"
    if not os.path.isfile(path):
        print(f"[morphology] missing rig: {path}")
        sys.exit(2)
    result = classify_glb(path)
    print("[morphology]", path)
    for k, v in result.items():
        if k == "features":
            print(f"  features: {v}")
        else:
            print(f"  {k}: {v}")
    if path.endswith("dragon_rig.glb"):
        assert result["archetype"] == "winged", \
            f"smoke-test FAIL: expected 'winged', got {result['archetype']}"
        print("[smoke] OK — dragon_rig.glb -> winged")
