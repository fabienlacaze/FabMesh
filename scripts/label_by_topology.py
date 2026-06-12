"""Topology-based labeller — identifies the 22 canonical humanoid bones
(Hips, Spine x3, Neck, Head, LeftArm x4, RightArm x4, LeftLeg x4, RightLeg x4)
from rig topology without depending on a fixed-joint-count anchor.

Robust to rigs with extra joints (fingers, toes, aux bones): the canonical
22 are picked, the rest get "Aux_<idx>" labels and are ignored by Rokoko.

Algorithm:
  1. Find Hips = root joint (highest Y in lower body, branches into legs+spine)
  2. Find leg roots = branches from Hips going DOWN (Y descending)
  3. Find spine chain = branch from Hips going UP (Y ascending), longest
  4. Find arm roots = branches from upper spine (Spine02/Spine03 area)
  5. Find Head + Neck = top of spine chain
  6. Disambiguate L/R via X sign (Left = X < 0, Right = X > 0)
  7. For each L/R limb (arm or leg) walk down 4 levels and label 00/01/02/03
"""
from __future__ import annotations
from pathlib import Path
import numpy as np


# ---------------------------------------------------------------------------
def topology_label(positions, parent_of, children, root_idx) -> dict[int, str]:
    """Return {joint_idx: canonical_label} for the 22 standard humanoid
    bones, plus "Aux_<idx>" for extra joints."""
    labels: dict[int, str] = {}

    # Convert positions to arrays for easier math
    all_joints = sorted(positions.keys())
    P = np.array([positions[j] for j in all_joints], dtype=np.float64)
    j_to_pi = {j: i for i, j in enumerate(all_joints)}

    y_min = P[:, 1].min()
    y_max = P[:, 1].max()
    y_range = y_max - y_min or 1.0

    # Step 1: Hips
    # Convention: root joint OR joint at "hip level" (Y around 0.45-0.55
    # of the total height) with at least 3 children (spine + 2 legs).
    candidates = []
    for j in all_joints:
        n_children = len(children.get(j, []))
        y_norm = (positions[j][1] - y_min) / y_range
        if n_children >= 3 and 0.35 <= y_norm <= 0.65:
            candidates.append((j, n_children, y_norm))
    if candidates:
        # Prefer the one closest to "hip level" (Y ~ 0.5)
        hips = min(candidates, key=lambda x: abs(x[2] - 0.5))[0]
    else:
        hips = root_idx
    labels[hips] = "Hips"

    # Step 2: leg roots = children of Hips whose subtree goes DOWN
    # (Y decreasing toward the floor)
    hips_y = positions[hips][1]
    hips_x = positions[hips][0]
    legs = []
    spine_root = None
    for c in children.get(hips, []):
        cy = positions[c][1]
        cx = positions[c][0] - hips_x
        if cy < hips_y:
            legs.append((c, cx))
        else:
            # Likely spine root (goes up)
            if spine_root is None or positions[c][1] > positions[spine_root][1]:
                spine_root = c

    # Step 3: spine chain
    spine_chain = []
    cur = spine_root
    while cur is not None:
        spine_chain.append(cur)
        # Next spine joint = the child that continues going UP and has
        # the longest descending chain (not an arm/head branch yet).
        next_c = None
        for c in children.get(cur, []):
            cy = positions[c][1]
            cur_y = positions[cur][1]
            if cy >= cur_y:  # going up
                if next_c is None or positions[c][1] > positions[next_c][1]:
                    next_c = c
        cur = next_c
        if len(spine_chain) > 10:
            break

    # Label spine joints
    # Standard humanoid has Spine00/01/02 (3 spine bones) + Neck00 + Head00.
    # If the spine chain has more joints, distribute Spine + Neck + Head:
    spine_chain_len = len(spine_chain)
    if spine_chain_len >= 5:
        # First 3 = Spine, then Neck, then Head
        for i, jt in enumerate(spine_chain[:3]):
            labels[jt] = f"Spine{i:02d}"
        labels[spine_chain[3]] = "Neck00"
        labels[spine_chain[4]] = "Head00"
        for i, jt in enumerate(spine_chain[5:]):
            labels[jt] = f"Aux_spine_{i}"
    elif spine_chain_len == 4:
        # Spine00, Spine01, Neck00, Head00
        labels[spine_chain[0]] = "Spine00"
        labels[spine_chain[1]] = "Spine01"
        labels[spine_chain[2]] = "Neck00"
        labels[spine_chain[3]] = "Head00"
    elif spine_chain_len == 3:
        labels[spine_chain[0]] = "Spine00"
        labels[spine_chain[1]] = "Neck00"
        labels[spine_chain[2]] = "Head00"
    elif spine_chain_len == 2:
        labels[spine_chain[0]] = "Spine00"
        labels[spine_chain[1]] = "Head00"
    elif spine_chain_len == 1:
        labels[spine_chain[0]] = "Head00"

    # Step 4: arm roots = branches from upper spine (any branch from
    # Spine01/Spine02/Spine03 that ISN'T the next spine joint, going OUT
    # to the sides).
    arm_roots = []
    upper_spine = spine_chain[1:max(4, spine_chain_len)]
    spine_set = set(spine_chain)
    for sj in upper_spine:
        for c in children.get(sj, []):
            if c in spine_set:
                continue
            # Arm root = child whose subtree extends OUTWARDS (|X| grows)
            cx = positions[c][0] - hips_x
            if abs(cx) > 0.03:
                arm_roots.append((c, cx))

    # Disambiguate L/R for arms by X sign (Left = X < 0, Right = X > 0)
    left_arm_root = None
    right_arm_root = None
    for c, cx in arm_roots:
        if cx < 0 and (left_arm_root is None
                       or cx < positions[left_arm_root][0] - hips_x):
            left_arm_root = c
        elif cx > 0 and (right_arm_root is None
                         or cx > positions[right_arm_root][0] - hips_x):
            right_arm_root = c

    # Step 5: walk each limb chain 4 levels deep and label 00/01/02/03
    def walk_limb(root_joint, prefix):
        if root_joint is None:
            return
        chain = [root_joint]
        cur = root_joint
        while children.get(cur):
            # Pick the deepest-going child (longest sub-chain)
            best_child = None
            best_depth = -1
            for c in children[cur]:
                if c in labels:
                    continue
                d = subtree_depth(c)
                if d > best_depth:
                    best_depth = d
                    best_child = c
            if best_child is None:
                break
            chain.append(best_child)
            cur = best_child
            if len(chain) >= 5:
                break
        for i, jt in enumerate(chain[:4]):
            labels[jt] = f"{prefix}{i:02d}"
        for i, jt in enumerate(chain[4:]):
            labels[jt] = f"Aux_{prefix.lower()}_{i}"

    def subtree_depth(j, depth=0, visited=None):
        visited = visited or set()
        if j in visited or depth > 15:
            return depth
        visited.add(j)
        kids = children.get(j, [])
        if not kids:
            return depth
        return max(subtree_depth(c, depth + 1, visited) for c in kids)

    walk_limb(left_arm_root, "LeftArm")
    walk_limb(right_arm_root, "RightArm")

    # Step 6: legs
    legs.sort(key=lambda x: x[1])  # sort by X
    left_leg_root = None
    right_leg_root = None
    if len(legs) >= 2:
        left_leg_root = legs[0][0]  # most negative X
        right_leg_root = legs[-1][0]  # most positive X
    elif len(legs) == 1:
        # Only one leg detected; assign based on X sign
        if legs[0][1] < 0:
            left_leg_root = legs[0][0]
        else:
            right_leg_root = legs[0][0]
    walk_limb(left_leg_root, "LeftLeg")
    walk_limb(right_leg_root, "RightLeg")

    # Step 7: any remaining unlabeled joints get Aux labels
    for j in all_joints:
        if j not in labels:
            labels[j] = f"Aux_{j}"

    return labels


# ---------------------------------------------------------------------------
def main():
    import argparse
    import json
    import sys
    sys.path.insert(0, str(Path(__file__).parent))
    from auto_label_rig import parse_pred_txt, parse_glb_skeleton

    ap = argparse.ArgumentParser()
    ap.add_argument("--rig", required=True)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    rig_path = Path(args.rig)
    pred_txt = Path(str(rig_path) + ".pred.txt")
    if pred_txt.exists():
        positions, parent_of, children, root_idx = parse_pred_txt(pred_txt)
    else:
        positions, parent_of, children, root_idx = parse_glb_skeleton(rig_path)

    labels = topology_label(positions, parent_of, children, root_idx)
    canonical = sum(1 for v in labels.values() if not v.startswith("Aux"))
    print(f"[topo-label] {canonical} canonical + {len(labels) - canonical} aux "
          f"= {len(labels)} total joints")

    out = Path(args.out) if args.out else Path(str(rig_path) + ".labels.json")
    payload = {
        "_comment": f"Topology-based labels for {rig_path.name} "
                    f"({canonical} canonical, {len(labels) - canonical} aux)",
        "labels": {str(k): v for k, v in labels.items()},
    }
    out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"[topo-label] wrote {out}")


if __name__ == "__main__":
    main()
