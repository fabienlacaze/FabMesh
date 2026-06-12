"""Auto-label Puppeteer-rigged GLB joints using position-based k-NN
against per-class anchor rigs.

Pipeline:
  1. Read <rig>.pred.txt (positions + parents + root)
  2. Detect class (humanoid / quadruped / winged_biped) from topology:
       - root degree (# children of root)
       - count of "ground-level" joints (Y near min) = feet count
       - max chain depth from root
  3. Load class anchor: <anchor_dir>/positions.json + labels.json
  4. For each joint in the new rig: extract feature vector
     [normalized XYZ, chain depth, child count, parent X, parent Y, parent Z]
  5. k-NN cosine on features against anchor feature vectors
  6. Output: <rig>.labels.json (dict pred_idx -> role)

Anchor format (per class):
  scripts/rig_mappings/_puppeteer_anchors/<class>/positions.json
    { "<joint_idx>": [x, y, z], ... }
  scripts/rig_mappings/_puppeteer_anchors/<class>/topology.json
    { "root": <int>, "parents": { "<joint_idx>": <parent_idx>, ... } }
  scripts/rig_mappings/_puppeteer_anchors/<class>/labels.json
    { "<joint_idx>": "Hips" / "Spine00" / "LeftLeg00" / ... }

Build anchor from a manually-labeled rig:
  python auto_label_rig.py --build-anchor \\
      --rig c:/tmp/test_quad_00.glb \\
      --labels c:/tmp/test_quad_00.glb.labels.json \\
      --class quadruped

Use anchor to label a new rig:
  python auto_label_rig.py \\
      --rig c:/tmp/training_rigs/humanoid/humanoid_00_seed42_rigged.glb \\
      --out c:/tmp/training_rigs/humanoid/humanoid_00_seed42_rigged.glb.labels.json
"""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

import numpy as np


HERE = Path(__file__).resolve().parent
ANCHOR_ROOT = HERE / "rig_mappings" / "_puppeteer_anchors"


# ---------------------------------------------------------------------------
# Parse Puppeteer .pred.txt sidecar
# ---------------------------------------------------------------------------
def parse_pred_txt(path: Path):
    """Return {joint_idx: (x,y,z)}, parent_of: {idx: parent_idx}, root_idx."""
    positions: dict[int, tuple[float, float, float]] = {}
    children: dict[int, list[int]] = {}
    root_idx = None
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            parts = line.split()
            if parts[0] == "joints":
                # joints joint5 x y z
                idx = int(parts[1].replace("joint", ""))
                positions[idx] = (float(parts[2]), float(parts[3]), float(parts[4]))
            elif parts[0] == "root":
                # root joint9
                root_idx = int(parts[1].replace("joint", ""))
            elif parts[0] == "hier":
                # hier joint_parent joint_child
                p = int(parts[1].replace("joint", ""))
                c = int(parts[2].replace("joint", ""))
                children.setdefault(p, []).append(c)

    if root_idx is None:
        # Detect root: joint with no parent in any hier line
        all_children = {c for lst in children.values() for c in lst}
        roots = [i for i in positions if i not in all_children]
        if not roots:
            raise RuntimeError("Cannot detect root in pred.txt")
        root_idx = roots[0]

    parent_of: dict[int, int] = {root_idx: -1}
    for p, kids in children.items():
        for c in kids:
            parent_of[c] = p

    # Fill orphans (rare) with -1
    for i in positions:
        if i not in parent_of:
            parent_of[i] = -1

    return positions, parent_of, children, root_idx


def parse_glb_skeleton(glb_path: Path):
    """Fallback when no pred.txt sidecar exists. Extracts joints + parents
    + world rest positions from the GLB skin + node hierarchy.

    Returns (positions, parent_of, children, root_idx) keyed by
    "joint index" (= the position of the joint within skin.joints[]),
    matching the convention used by Puppeteer pred.txt.
    """
    import pygltflib
    import struct
    g = pygltflib.GLTF2().load(str(glb_path))
    blob = g.binary_blob()
    if not g.skins:
        raise RuntimeError(f"{glb_path}: no skin")
    skin = g.skins[0]
    joint_nodes = list(skin.joints or [])
    if not joint_nodes:
        raise RuntimeError(f"{glb_path}: skin has no joints")

    # Map node_idx -> joint_idx
    node_to_joint = {n: i for i, n in enumerate(joint_nodes)}

    # Build parent map of all nodes
    parent_of_node: dict[int, int] = {}
    for pi, p in enumerate(g.nodes):
        for c in (p.children or []):
            parent_of_node[c] = pi

    # Compute world rest matrices by chaining local TRS up the node tree
    import numpy as _np
    def trs_to_mat(node):
        T = _np.eye(4, dtype=_np.float64)
        if node.translation:
            T[0, 3], T[1, 3], T[2, 3] = node.translation
        R = _np.eye(4, dtype=_np.float64)
        if node.rotation:
            qx, qy, qz, qw = node.rotation
            x2, y2, z2 = qx * 2, qy * 2, qz * 2
            xx, yy, zz = qx * x2, qy * y2, qz * z2
            xy, xz, yz = qx * y2, qx * z2, qy * z2
            wx, wy, wz = qw * x2, qw * y2, qw * z2
            R[0, 0] = 1 - (yy + zz); R[0, 1] = xy - wz;       R[0, 2] = xz + wy
            R[1, 0] = xy + wz;       R[1, 1] = 1 - (xx + zz); R[1, 2] = yz - wx
            R[2, 0] = xz - wy;       R[2, 1] = yz + wx;       R[2, 2] = 1 - (xx + yy)
        S = _np.eye(4, dtype=_np.float64)
        if node.scale:
            S[0, 0], S[1, 1], S[2, 2] = node.scale
        return T @ R @ S

    world_mat: dict[int, _np.ndarray] = {}
    def world_of(node_idx: int) -> _np.ndarray:
        if node_idx in world_mat:
            return world_mat[node_idx]
        local = trs_to_mat(g.nodes[node_idx])
        p = parent_of_node.get(node_idx, -1)
        if p < 0:
            world_mat[node_idx] = local
        else:
            world_mat[node_idx] = world_of(p) @ local
        return world_mat[node_idx]

    # If inverseBindMatrices are present, prefer them — they encode the
    # actual bind world matrix directly (no traversal needed).
    use_ibm = skin.inverseBindMatrices is not None
    if use_ibm:
        acc = g.accessors[skin.inverseBindMatrices]
        bv = g.bufferViews[acc.bufferView]
        offs = (bv.byteOffset or 0) + (acc.byteOffset or 0)
        n_per_mat = 16
        sz = 4 * acc.count * n_per_mat
        raw = blob[offs:offs + sz]
        flat = _np.array(struct.unpack(f"<{acc.count * n_per_mat}f", raw),
                         dtype=_np.float32)
        ibm = flat.reshape(acc.count, 4, 4).astype(_np.float64)
        # glTF stores column-major
        ibm = _np.transpose(ibm, (0, 2, 1))

    positions: dict[int, tuple[float, float, float]] = {}
    for joint_idx, node_idx in enumerate(joint_nodes):
        if use_ibm:
            try:
                world = _np.linalg.inv(ibm[joint_idx])
            except _np.linalg.LinAlgError:
                world = world_of(node_idx)
        else:
            world = world_of(node_idx)
        positions[joint_idx] = (float(world[0, 3]),
                                float(world[1, 3]),
                                float(world[2, 3]))

    # parent in JOINT space: walk parent_of_node up until we hit another joint
    parent_of: dict[int, int] = {}
    children: dict[int, list[int]] = {}
    for joint_idx, node_idx in enumerate(joint_nodes):
        p_node = parent_of_node.get(node_idx, -1)
        while p_node >= 0 and p_node not in node_to_joint:
            p_node = parent_of_node.get(p_node, -1)
        if p_node < 0:
            parent_of[joint_idx] = -1
        else:
            parent_of[joint_idx] = node_to_joint[p_node]
            children.setdefault(node_to_joint[p_node], []).append(joint_idx)

    roots = [j for j, p in parent_of.items() if p < 0]
    if not roots:
        raise RuntimeError(f"{glb_path}: no skin root joint")
    # Pick the root with the most descendants (in case of multiple roots)
    def descendants(j, visited=None):
        visited = visited or set()
        visited.add(j)
        for c in children.get(j, []):
            if c not in visited:
                descendants(c, visited)
        return len(visited)
    root_idx = max(roots, key=descendants)
    return positions, parent_of, children, root_idx


# ---------------------------------------------------------------------------
# Feature extraction
# ---------------------------------------------------------------------------
def chain_depth(joint_idx: int, parent_of: dict[int, int]) -> int:
    d = 0
    cur = joint_idx
    while parent_of.get(cur, -1) >= 0 and d < 30:
        cur = parent_of[cur]
        d += 1
    return d


def normalize_positions(positions: dict[int, tuple[float, float, float]]):
    """Center on root XZ, normalize by overall extent (max axis range)."""
    P = np.array(list(positions.values()), dtype=np.float32)
    cx = float(P[:, 0].mean())
    cy = float(P[:, 1].min())  # floor = lowest Y
    cz = float(P[:, 2].mean())
    span = float(max(P[:, 0].max() - P[:, 0].min(),
                     P[:, 1].max() - P[:, 1].min(),
                     P[:, 2].max() - P[:, 2].min(), 1e-6))
    out: dict[int, tuple[float, float, float]] = {}
    for i, (x, y, z) in positions.items():
        out[i] = ((x - cx) / span, (y - cy) / span, (z - cz) / span)
    return out, span


def feature_vec(joint_idx: int,
                positions: dict[int, tuple[float, float, float]],
                parent_of: dict[int, int],
                children: dict[int, list[int]],
                root_idx: int) -> np.ndarray:
    """Build a small feature vector for k-NN matching."""
    pos = positions[joint_idx]
    p = parent_of.get(joint_idx, -1)
    parent_pos = positions[p] if p >= 0 else positions[root_idx]
    n_children = len(children.get(joint_idx, []))
    depth = chain_depth(joint_idx, parent_of)
    # Vector relative to parent (limb direction at this joint)
    dx = pos[0] - parent_pos[0]
    dy = pos[1] - parent_pos[1]
    dz = pos[2] - parent_pos[2]
    # Relative to root
    rx = pos[0] - positions[root_idx][0]
    ry = pos[1] - positions[root_idx][1]
    rz = pos[2] - positions[root_idx][2]
    return np.array([
        pos[0], pos[1], pos[2],       # normalized position
        rx, ry, rz,                   # position relative to root
        dx, dy, dz,                   # direction from parent
        float(depth) / 10.0,
        float(n_children) / 5.0,
    ], dtype=np.float32)


def build_features(positions, parent_of, children, root_idx):
    norm_pos, span = normalize_positions(positions)
    feats = {}
    for j in positions:
        feats[j] = feature_vec(j, norm_pos, parent_of, children, root_idx)
    return feats, norm_pos, span


# ---------------------------------------------------------------------------
# Topology-based class detection
# ---------------------------------------------------------------------------
def detect_class(positions, parent_of, children, root_idx) -> str:
    """Heuristic classifier: humanoid / quadruped / winged_biped."""
    n_joints = len(positions)
    P = np.array(list(positions.values()), dtype=np.float32)
    y_min = float(P[:, 1].min())
    y_max = float(P[:, 1].max())
    y_range = y_max - y_min
    if y_range < 1e-6:
        y_range = 1.0
    # Count "ground" joints (Y in lowest 10% of range)
    ground_thresh = y_min + y_range * 0.10
    ground_joints = [j for j, p in positions.items() if p[1] <= ground_thresh]
    n_ground = len(ground_joints)
    # Count high joints
    high_thresh = y_min + y_range * 0.80
    n_high = sum(1 for p in positions.values() if p[1] >= high_thresh)
    # Root degree
    root_deg = len(children.get(root_idx, []))
    # Count chain depth > 5 (long limbs = wings or tail)
    long_chains = sum(1 for j in positions if chain_depth(j, parent_of) > 5)

    # Heuristic
    if n_ground >= 6:
        # 4 feet + 2 wing tips? probably winged
        return "winged_biped" if n_high > 5 else "quadruped"
    if n_ground >= 4 and n_high < 4:
        return "quadruped"
    if n_ground >= 6 and n_high > 5:
        return "winged_biped"
    return "humanoid"


# ---------------------------------------------------------------------------
# Anchor I/O
# ---------------------------------------------------------------------------
def save_anchor(class_name: str, positions, parent_of, children, root_idx,
                labels: dict[int, str]) -> Path:
    out_dir = ANCHOR_ROOT / class_name
    out_dir.mkdir(parents=True, exist_ok=True)
    feats, norm_pos, span = build_features(positions, parent_of, children, root_idx)
    # Order features and labels by joint_idx so we have parallel arrays
    joint_idxs = sorted(positions.keys())
    feat_arr = np.array([feats[j] for j in joint_idxs], dtype=np.float32)
    np.save(out_dir / "features.npy", feat_arr)
    (out_dir / "anchor_meta.json").write_text(json.dumps({
        "class": class_name,
        "joint_idxs": joint_idxs,
        "labels": {str(j): labels.get(j, f"joint{j}") for j in joint_idxs},
        "root_idx": root_idx,
        "span": span,
    }, indent=2), encoding="utf-8")
    print(f"[anchor] wrote {out_dir}/features.npy ({feat_arr.shape}) "
          f"+ anchor_meta.json")
    return out_dir


def load_anchor(class_name: str):
    in_dir = ANCHOR_ROOT / class_name
    feats = np.load(in_dir / "features.npy")
    meta = json.loads((in_dir / "anchor_meta.json").read_text(encoding="utf-8"))
    return feats, meta


# ---------------------------------------------------------------------------
# k-NN auto-label
# ---------------------------------------------------------------------------
def auto_label(rig_pred_txt: Path, class_hint: str | None = None,
               glb_fallback: Path | None = None) -> dict[int, str]:
    if glb_fallback is not None:
        positions, parent_of, children, root_idx = parse_glb_skeleton(glb_fallback)
    else:
        positions, parent_of, children, root_idx = parse_pred_txt(rig_pred_txt)
    cls = class_hint or detect_class(positions, parent_of, children, root_idx)
    print(f"[auto-label] detected class: {cls}")
    feats, norm_pos, span = build_features(positions, parent_of, children, root_idx)
    anchor_feats, anchor_meta = load_anchor(cls)
    anchor_joint_idxs = anchor_meta["joint_idxs"]
    anchor_labels_by_idx = {int(k): v for k, v in anchor_meta["labels"].items()}

    out_labels: dict[int, str] = {}
    used_labels: set[str] = set()
    # Sort target joints by importance: Hips/Spine first, then limbs
    target_joints = sorted(positions.keys())
    # We do a greedy 1-to-1 assignment: for each target joint, pick the
    # best matching anchor joint whose label is still available.
    for j in target_joints:
        v = feats[j]
        # Cosine similarity vs each anchor row
        # Note: small-dim vectors, use raw L2 distance instead — more robust
        d = np.linalg.norm(anchor_feats - v[None, :], axis=1)
        # Sort anchor joints by distance, pick the first whose label isn't used
        order = np.argsort(d)
        chosen = None
        for k in order:
            ai = anchor_joint_idxs[k]
            lbl = anchor_labels_by_idx[ai]
            if lbl not in used_labels:
                chosen = lbl
                used_labels.add(lbl)
                break
        if chosen is None:
            # All labels used — pick best non-Hips
            ai = anchor_joint_idxs[int(order[0])]
            chosen = anchor_labels_by_idx[ai]
        out_labels[j] = chosen
    return out_labels


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rig", required=True,
                    help="Puppeteer-rigged GLB. Reads <rig>.pred.txt sidecar.")
    ap.add_argument("--out", default=None,
                    help="Output labels.json. Default: <rig>.labels.json")
    ap.add_argument("--class", dest="cls", default=None,
                    help="Force class (humanoid/quadruped/winged_biped). Auto-detect if absent.")

    # Anchor builder mode
    ap.add_argument("--build-anchor", action="store_true",
                    help="Build an anchor from a manually-labeled rig.")
    ap.add_argument("--labels",
                    help="Required with --build-anchor: path to manual labels.json")
    args = ap.parse_args()

    rig_path = Path(args.rig)
    pred_txt = Path(str(rig_path) + ".pred.txt")
    use_glb_fallback = not pred_txt.exists()
    if use_glb_fallback:
        print(f"[auto-label] no sidecar — parsing skeleton from {rig_path.name}")

    def load_topology():
        if use_glb_fallback:
            return parse_glb_skeleton(rig_path)
        return parse_pred_txt(pred_txt)

    if args.build_anchor:
        if not args.cls or not args.labels:
            print("ERR --build-anchor needs --class and --labels")
            sys.exit(2)
        positions, parent_of, children, root_idx = load_topology()
        raw = json.loads(Path(args.labels).read_text(encoding="utf-8"))
        # accept (a) top-level dict, (b) {"labels": {...}}, (c) list (index = pred_idx)
        if isinstance(raw, dict):
            labels_obj = raw.get("labels", raw)
        else:
            labels_obj = raw
        if isinstance(labels_obj, list):
            labels = {i: v for i, v in enumerate(labels_obj) if isinstance(v, str)}
        else:
            labels = {int(k): v for k, v in labels_obj.items()
                      if isinstance(v, str) and not str(k).startswith("_")}
        save_anchor(args.cls, positions, parent_of, children, root_idx, labels)
        print(f"[anchor] {args.cls} anchor built from {rig_path.name}")
        return

    out_path = Path(args.out) if args.out else Path(str(rig_path) + ".labels.json")
    labels = auto_label(pred_txt, args.cls,
                        glb_fallback=rig_path if use_glb_fallback else None)
    payload = {"_comment": f"Auto-labeled by auto_label_rig.py from {pred_txt.name}",
               "labels": {str(k): v for k, v in labels.items()}}
    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"[auto-label] wrote {out_path} ({len(labels)} entries)")


if __name__ == "__main__":
    main()
