"""Neural classifier for Puppeteer joint semantic labels (Plan B1 fix).

Problem: Puppeteer auto-rig outputs joints named joint0..jointN with no
semantic info. Need to predict per-joint semantic role (Hips, Spine,
LeftArm, RightHand, etc.) so we can build effectors mapping for
ik_retarget.py and unlock FabMesh skeleton-native training.

Approach: train on labeled skeletons (Truebones BVH, Mixamo, AnyTop
canonical) where joint names have semantic prefixes. At inference,
strip names and predict roles purely from topology + positions.

Training data sources:
  c:/tmp/anytop_pure/assets/Truebones_*/*.bvh        (24 characters)
  c:/tmp/anytop_pure/dataset/truebones/zoo/*.bvh     (if present)
  Manual: a few Mixamo .fbx (optional, has Hips/Spine/etc names)

Features per joint:
  position_xyz (3)
  pos_relative_to_parent (3)
  pos_relative_to_root (3)
  bone_length_to_parent (1)
  num_children (1)
  num_descendants (1)
  is_leaf (1)
  is_root (1)
  depth_from_root (1)
  x_side (signed) (1)
  ----
  total = 16 features per joint

Labels (Anatomical role categories, mirroring AnyTop's
puppeteer_joint_renamer canonical names):
  Hips, Spine, Neck, Head,
  LeftArm, RightArm, LeftLeg, RightLeg,
  LeftWing, RightWing, Tail, Other

Architecture options (model.py):
  A. MLP per-joint (ignores topology)
  B. GCN (graph conv over parent-child edges) — RECOMMENDED
  C. Transformer (attention over joints in canonical traversal order)

CLI:
    # Build dataset from Truebones BVHs
    python scripts/bone_semantic_classifier.py build-dataset \\
        --bvh-dir c:/tmp/anytop_pure/assets \\
        --out c:/tmp/bone_classifier/dataset.npz

    # Train classifier
    python scripts/bone_semantic_classifier.py train \\
        --dataset c:/tmp/bone_classifier/dataset.npz \\
        --epochs 100 \\
        --out c:/tmp/bone_classifier/model.pt

    # Apply to a Puppeteer GLB
    python scripts/bone_semantic_classifier.py predict \\
        --model c:/tmp/bone_classifier/model.pt \\
        --glb c:/tmp/training_rigs/humanoid/humanoid_05_seed47_rigged.glb

Last step in Plan B1: use the predicted labels to write effectors at
runtime in scripts/ik_retarget.py (replacing the static JSON).
"""
from __future__ import annotations
import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np


# ---------------------------------------------------------------------------
# Canonical label vocabulary (must match puppeteer_joint_renamer.py)
# ---------------------------------------------------------------------------
LABELS = [
    "Hips", "Spine", "Neck", "Head",
    "LeftArm", "RightArm", "LeftLeg", "RightLeg",
    "LeftWing", "RightWing", "Tail", "Other",
]
LABEL_TO_IDX = {l: i for i, l in enumerate(LABELS)}
N_CLASSES = len(LABELS)


# ---------------------------------------------------------------------------
# Auto-label heuristic: derive ground truth from BVH joint names.
# Regex patterns inspired by Truebones / Mixamo / Bip01 conventions.
# ---------------------------------------------------------------------------
# Two-pass auto-label: (1) detect base limb role from substrings, (2) detect
# side suffix. Works across Mixamo (LeftArm), Truebones/Apovivor (B_L_Arm,
# backHip_R, _L suffix), Bip01_ prefix, and pure substring names.
_LIMB_REGEX = [
    # Order matters — most specific first.
    (r"(?i)(thigh|upleg|knee|calf|shin|ankle|foot|toe|backHip|backRump|frontHip|frontRump|hipUp|hipDown|leg)", "leg"),
    (r"(?i)(shoulder|clavicle|upperarm|forearm|hand|finger|wrist|backElbow|backArm|frontElbow|frontArm|paw|claw|arm)", "arm"),
    (r"(?i)(wing|feather|primary|secondary)", "wing"),
    (r"(?i)(tail|tale)", "tail"),
    (r"(?i)(neck)", "neck"),
    (r"(?i)(head|skull|jaw|eye|ear)", "head"),
    (r"(?i)(spine|chest|abdomen|torso|ribs|back\d|backbone)", "spine"),
    (r"(?i)(hip|pelvis|root|cog|reference)", "hips"),
]
_SIDE_REGEX = [
    (r"(?i)(left|^l[_0-9]|_l[_0-9$]|_l$|leftSide|^L\b)", "L"),
    (r"(?i)(right|^r[_0-9]|_r[_0-9$]|_r$|rightSide|^R\b)", "R"),
]


def auto_label_joint(name: str) -> str:
    """Return canonical label for a BVH/FBX joint name. 'Other' if none match."""
    # Pass 1: detect base role
    base = None
    for pat, lbl in _LIMB_REGEX:
        if re.search(pat, name):
            base = lbl
            break
    if base is None:
        return "Other"
    # Pass 2: side (only matters for paired limbs)
    side = None
    for pat, s in _SIDE_REGEX:
        if re.search(pat, name):
            side = s
            break
    if base == "leg":
        return {"L": "LeftLeg", "R": "RightLeg"}.get(side, "RightLeg")
    if base == "arm":
        return {"L": "LeftArm", "R": "RightArm"}.get(side, "RightArm")
    if base == "wing":
        return {"L": "LeftWing", "R": "RightWing"}.get(side, "RightWing")
    return {"hips": "Hips", "spine": "Spine", "neck": "Neck",
            "head": "Head", "tail": "Tail"}.get(base, "Other")


# ---------------------------------------------------------------------------
# BVH parser (minimal — just hierarchy + offsets)
# ---------------------------------------------------------------------------
def parse_bvh_skeleton(bvh_path: Path) -> list[dict]:
    """Return [{name, parent_idx, offset_xyz}] in DFS order.

    Only reads the HIERARCHY section. Ignores MOTION.
    """
    with open(bvh_path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()

    joints: list[dict] = []
    stack: list[int] = []
    cur_idx = -1
    tokens = text.split()
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok in ("ROOT", "JOINT"):
            name = tokens[i + 1]
            parent = stack[-1] if stack else -1
            joints.append({"name": name, "parent_idx": parent, "offset": (0.0, 0.0, 0.0)})
            cur_idx = len(joints) - 1
            i += 2
            continue
        if tok == "End":
            # Skip end-site
            depth = 0
            while i < len(tokens):
                if tokens[i] == "{":
                    depth += 1
                elif tokens[i] == "}":
                    depth -= 1
                    if depth == 0:
                        i += 1
                        break
                i += 1
            continue
        if tok == "{":
            stack.append(cur_idx)
            i += 1
            continue
        if tok == "}":
            if stack:
                stack.pop()
            i += 1
            continue
        if tok == "OFFSET":
            x, y, z = float(tokens[i + 1]), float(tokens[i + 2]), float(tokens[i + 3])
            joints[cur_idx]["offset"] = (x, y, z)
            i += 4
            continue
        if tok == "MOTION":
            break
        i += 1

    return joints


# ---------------------------------------------------------------------------
# Feature extraction
# ---------------------------------------------------------------------------
def compute_world_positions(joints: list[dict]) -> np.ndarray:
    """DFS-compute world positions from offsets + parents."""
    pos = np.zeros((len(joints), 3), dtype=np.float32)
    for i, j in enumerate(joints):
        offset = np.asarray(j["offset"], dtype=np.float32)
        p = j["parent_idx"]
        pos[i] = offset + (pos[p] if p >= 0 else np.zeros(3))
    return pos


def extract_features(joints: list[dict]) -> np.ndarray:
    """Per-joint feature vector (16-dim) — see module docstring."""
    n = len(joints)
    parents = np.array([j["parent_idx"] for j in joints], dtype=np.int64)
    pos = compute_world_positions(joints)
    # Normalize positions to unit bbox so scale doesn't dominate
    mn, mx = pos.min(axis=0), pos.max(axis=0)
    span = np.maximum(mx - mn, 1e-6)
    pos_n = (pos - mn) / span

    parent_rel = np.where(
        parents[:, None] >= 0,
        pos_n - pos_n[np.maximum(parents, 0)],
        np.zeros_like(pos_n),
    )
    root_pos = pos_n[0] if n > 0 else np.zeros(3)
    root_rel = pos_n - root_pos

    # Child counts + descendants + depth
    children: dict[int, list[int]] = {i: [] for i in range(n)}
    for i, p in enumerate(parents):
        if p >= 0:
            children[int(p)].append(i)
    num_children = np.array([len(children[i]) for i in range(n)], dtype=np.float32)
    is_leaf = (num_children == 0).astype(np.float32)
    is_root = (parents == -1).astype(np.float32)

    # Depth via BFS from root
    depth = np.zeros(n, dtype=np.float32)
    for i in range(n):
        d, cur = 0, i
        while parents[cur] >= 0:
            cur = parents[cur]
            d += 1
            if d > 100:
                break
        depth[i] = d
    depth_n = depth / max(depth.max(), 1)

    # Descendant count
    desc = np.zeros(n, dtype=np.float32)
    for i in range(n - 1, -1, -1):
        desc[i] = 1 + sum(desc[c] for c in children[i])
    desc_n = desc / max(desc.max(), 1)

    # X side signed (post-normalization, centered around 0.5)
    x_side = pos_n[:, 0] - 0.5

    feats = np.column_stack([
        pos_n,                              # 3
        parent_rel,                         # 3
        root_rel,                           # 3
        np.linalg.norm(parent_rel, axis=1, keepdims=False)[:, None].squeeze(),  # 1
        num_children / max(num_children.max(), 1),  # 1
        desc_n,                             # 1
        is_leaf,                            # 1
        is_root,                            # 1
        depth_n,                            # 1
        x_side,                             # 1
    ]).astype(np.float32)
    return feats


# ---------------------------------------------------------------------------
# Dataset builder
# ---------------------------------------------------------------------------
def cmd_build_dataset(args):
    bvh_root = Path(args.bvh_dir)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    bvh_files = list(bvh_root.rglob("*.bvh"))
    # Group by character. For "ANIM_AS_Robot1_Walk.bvh" the character is
    # "AS_Robot1"; strip the leading "ANIM_" prefix and the trailing
    # motion word(s). Fall back to parent dir name when no convention.
    by_char: dict[str, Path] = {}
    def _char_key(p: Path) -> str:
        stem = p.stem
        stem = re.sub(r"^ANIM_", "", stem, flags=re.I)
        # Cut at the LAST underscore-separated word — heuristic
        # (better naming would be per-character subfolders).
        parts = stem.split("_")
        if len(parts) > 2:
            return "_".join(parts[:-1])  # drop last token (motion name)
        return p.parent.name
    for f in bvh_files:
        char = _char_key(f)
        if char not in by_char:
            by_char[char] = f
        elif "TPOSE" in f.name.upper() or "REST" in f.name.upper():
            by_char[char] = f

    print(f"[build] {len(by_char)} unique characters from {len(bvh_files)} BVHs")
    X, y, meta = [], [], []
    for char, path in by_char.items():
        try:
            joints = parse_bvh_skeleton(path)
        except Exception as e:
            print(f"  SKIP {char}: {e}")
            continue
        if len(joints) < 5:
            print(f"  SKIP {char}: too few joints ({len(joints)})")
            continue
        feats = extract_features(joints)
        labels = np.array([LABEL_TO_IDX[auto_label_joint(j["name"])] for j in joints],
                          dtype=np.int64)
        X.append(feats)
        y.append(labels)
        meta.append({"char": char, "n_joints": len(joints), "path": str(path)})
        print(f"  {char}: {len(joints)} joints, labels={dict((LABELS[i], int((labels==i).sum())) for i in range(N_CLASSES) if (labels==i).any())}")

    if not X:
        print("[build] no usable BVHs found"); return 1
    # Save as (variable-length-per-sample) — pack into separate arrays
    np.savez_compressed(out,
                       X=np.array(X, dtype=object),
                       y=np.array(y, dtype=object),
                       meta=meta)
    print(f"[build] wrote {out} ({len(X)} samples)")
    return 0


# ---------------------------------------------------------------------------
# Model (simple per-joint MLP — sufficient for v1)
# ---------------------------------------------------------------------------
def _build_model(in_dim: int = 16, hidden: int = 128, out_dim: int = N_CLASSES):
    import torch
    import torch.nn as nn
    return nn.Sequential(
        nn.Linear(in_dim, hidden),
        nn.ReLU(),
        nn.Dropout(0.2),
        nn.Linear(hidden, hidden),
        nn.ReLU(),
        nn.Dropout(0.2),
        nn.Linear(hidden, out_dim),
    )


def cmd_train(args):
    import torch
    from torch.utils.data import DataLoader

    data = np.load(args.dataset, allow_pickle=True)
    X_list = list(data["X"])
    y_list = list(data["y"])
    # Flatten per-joint (each joint = 1 sample)
    X_all = np.concatenate(X_list, axis=0)
    y_all = np.concatenate(y_list, axis=0)
    print(f"[train] {X_all.shape[0]} joint samples across {len(X_list)} skeletons")
    print(f"[train] class counts: " +
          ", ".join(f"{LABELS[c]}={int((y_all==c).sum())}" for c in range(N_CLASSES)))

    # Train/val split — leave 20% of CHARACTERS out (avoid joint-level leakage)
    n_char = len(X_list)
    val_chars = np.random.RandomState(0).permutation(n_char)[:max(1, n_char // 5)]
    val_mask_per_skel = np.zeros(n_char, dtype=bool); val_mask_per_skel[val_chars] = True
    X_train, y_train, X_val, y_val = [], [], [], []
    for k in range(n_char):
        if val_mask_per_skel[k]:
            X_val.append(X_list[k]); y_val.append(y_list[k])
        else:
            X_train.append(X_list[k]); y_train.append(y_list[k])
    X_train = torch.from_numpy(np.concatenate(X_train, axis=0)).float()
    y_train = torch.from_numpy(np.concatenate(y_train, axis=0)).long()
    X_val = torch.from_numpy(np.concatenate(X_val, axis=0)).float()
    y_val = torch.from_numpy(np.concatenate(y_val, axis=0)).long()
    print(f"[train] train={len(X_train)} val={len(X_val)}")

    model = _build_model(in_dim=X_train.shape[1])
    opt = torch.optim.Adam(model.parameters(), lr=1e-3)
    crit = torch.nn.CrossEntropyLoss()

    for epoch in range(args.epochs):
        model.train()
        # Mini-batch shuffle
        perm = torch.randperm(len(X_train))
        bsz = 256
        train_loss = 0.0
        for i in range(0, len(perm), bsz):
            idx = perm[i:i+bsz]
            opt.zero_grad()
            logits = model(X_train[idx])
            loss = crit(logits, y_train[idx])
            loss.backward()
            opt.step()
            train_loss += float(loss) * len(idx)
        train_loss /= len(X_train)

        model.eval()
        with torch.no_grad():
            logits = model(X_val)
            val_loss = crit(logits, y_val).item()
            val_acc = (logits.argmax(dim=1) == y_val).float().mean().item()
        if (epoch + 1) % 10 == 0 or epoch == 0:
            print(f"  ep {epoch+1:3d} | train_loss {train_loss:.4f} | "
                  f"val_loss {val_loss:.4f} | val_acc {val_acc:.3f}")

    torch.save({"model_state": model.state_dict(),
                "in_dim": X_train.shape[1],
                "labels": LABELS}, args.out)
    print(f"[train] saved -> {args.out}")
    return 0


def cmd_predict(args):
    import torch
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from anytop_retarget import _read_glb

    gltf, _, _ = _read_glb(args.glb)
    nodes = gltf.get("nodes", [])
    parent_of = [-1] * len(nodes)
    for pi, p in enumerate(nodes):
        for c in (p.get("children") or []):
            parent_of[c] = pi
    # Convert to "joints" structure (filter for nodes that are actually skeleton joints)
    joints = []
    for i, n in enumerate(nodes):
        if "joint" not in n.get("name", "").lower():
            continue
        offset = n.get("translation", [0, 0, 0])
        joints.append({"name": n["name"], "parent_idx": -1, "offset": offset, "_orig_idx": i})
    # Rebuild parent_idx (relative to joints list)
    orig_to_local = {j["_orig_idx"]: k for k, j in enumerate(joints)}
    for k, j in enumerate(joints):
        p_orig = parent_of[j["_orig_idx"]]
        j["parent_idx"] = orig_to_local.get(p_orig, -1)

    feats = extract_features(joints)
    ckpt = torch.load(args.model, map_location="cpu")
    model = _build_model(in_dim=ckpt["in_dim"])
    model.load_state_dict(ckpt["model_state"])
    model.eval()
    with torch.no_grad():
        logits = model(torch.from_numpy(feats).float())
        preds = logits.argmax(dim=1).numpy()

    print(f"[predict] {len(joints)} joints in {args.glb}")
    for k, j in enumerate(joints):
        print(f"  {j['_orig_idx']:3d} {j['name']:15s} -> {LABELS[preds[k]]}")
    return 0


# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("build-dataset")
    p.add_argument("--bvh-dir", required=True)
    p.add_argument("--out", default="c:/tmp/bone_classifier/dataset.npz")
    p.set_defaults(fn=cmd_build_dataset)

    p = sub.add_parser("train")
    p.add_argument("--dataset", required=True)
    p.add_argument("--epochs", type=int, default=100)
    p.add_argument("--out", default="c:/tmp/bone_classifier/model.pt")
    p.set_defaults(fn=cmd_train)

    p = sub.add_parser("predict")
    p.add_argument("--model", required=True)
    p.add_argument("--glb", required=True)
    p.set_defaults(fn=cmd_predict)

    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
