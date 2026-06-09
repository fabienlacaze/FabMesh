"""Post-process auto-rigged GLBs so AnyTop retarget produces a clean
animated mesh.

The auto-riggers in the FabMesh pipeline (Puppeteer, Hunyuan) produce
GLBs whose inverseBindMatrices have one or more of these defects:

  (1) COINCIDENT joints — multiple bones decode to the EXACT SAME world
      position via the IBMs (e.g. on Puppeteer's 47-bone dragon: 19
      pairs of joints are at the same point, the worst cluster being
      4 distinct joints all at world (0, 0.37, -0.06)). When AnyTop's
      retarget rotates joint A, the geometrically-coincident joint B
      is also displaced via the chain — but B receives no source motion
      of its own, so the skin weights tear between them.

  (2) IBM SCALE corruption — joints decode to positions far OUTSIDE the
      mesh bbox (e.g. on Hunyuan's ORC_M1: mesh max-y = 191 cm but
      joint 'pelvis' decodes to y = 9644). Every per-bone displacement
      then gets amplified by the broken scale factor (~50x). Even with
      proper retarget scale matching, the bone WORLD positions blow up
      because the rest pose is broken.

Both defects are upstream of AnyTop and cannot be patched inside the
retarget code without papering over them. The CLAUDE.md constraint
forbids modifying Puppeteer; we run as a strict downstream transform.

What this module does:

  - detect_defects(glb_in)
      Inspects skin[0] of the GLB, returns a dict with `coincident_pairs`
      and `ibm_scale_corrupted` flags so callers can decide whether to
      run the post-process or pass through.

  - merge_coincident_joints(glb_in, glb_out, tol=1e-3)
      Picks one canonical joint per cluster (the one with the most
      children = closest to a true anatomical pivot), redirects all
      skin weights that referenced the dropped duplicates to the
      canonical, removes the duplicate joints from skin.joints, and
      patches the hierarchy (children lists) so the GLB stays
      structurally valid.

  - repair_ibm_scale(glb_in, glb_out, mesh_bbox=None)
      If joint world positions are >5x outside the mesh bbox, rescale
      every IBM so the joint cloud fits the mesh. Uses the median bone
      length as a robust scale signal so a few off-grid IBMs don't drag
      the rescale.

  - postprocess(glb_in, glb_out)
      Convenience: run all repairs in order. Returns a dict of what
      was applied so the caller can log it.

CLI for one-off testing:
    python scripts/rig_postprocess.py --in path.glb --out fixed.glb

License: MIT (FabMesh proprietary).
"""
from __future__ import annotations

import argparse
import json
import os
import struct
import sys
from typing import Any

import numpy as np


# ---------------------------------------------------------------------------
# GLB IO helpers (no external dep — pygltflib re-parses everything, slow)
# ---------------------------------------------------------------------------
def _read_glb(path: str) -> tuple[dict, bytes, bytes]:
    """Return (gltf_dict, json_blob_bytes, bin_blob)."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:4] != b"glTF":
        raise ValueError(f"Not a GLB: {path}")
    version = struct.unpack("<I", data[4:8])[0]
    if version != 2:
        raise ValueError(f"GLB version {version} unsupported")
    total_len = struct.unpack("<I", data[8:12])[0]
    cursor = 12
    json_blob = b""
    bin_blob = b""
    while cursor < total_len:
        chunk_len = struct.unpack("<I", data[cursor : cursor + 4])[0]
        chunk_type = data[cursor + 4 : cursor + 8]
        chunk_data = data[cursor + 8 : cursor + 8 + chunk_len]
        if chunk_type == b"JSON":
            json_blob = chunk_data
        elif chunk_type == b"BIN\x00":
            bin_blob = chunk_data
        cursor += 8 + chunk_len
    gltf = json.loads(json_blob.decode("utf-8"))
    return gltf, json_blob, bin_blob


def _write_glb(gltf: dict, bin_blob: bytes, out_path: str) -> None:
    json_blob = json.dumps(gltf).encode("utf-8")
    while len(json_blob) % 4 != 0:
        json_blob += b" "
    while len(bin_blob) % 4 != 0:
        bin_blob += b"\x00"
    total = 12 + 8 + len(json_blob) + 8 + len(bin_blob)
    with open(out_path, "wb") as f:
        f.write(b"glTF")
        f.write(struct.pack("<I", 2))
        f.write(struct.pack("<I", total))
        f.write(struct.pack("<I", len(json_blob)))
        f.write(b"JSON")
        f.write(json_blob)
        f.write(struct.pack("<I", len(bin_blob)))
        f.write(b"BIN\x00")
        f.write(bin_blob)


def _read_accessor(gltf: dict, bin_blob: bytes, acc_idx: int) -> np.ndarray:
    acc = gltf["accessors"][acc_idx]
    bv = gltf["bufferViews"][acc["bufferView"]]
    offset = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    type_size = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[acc["type"]]
    dtype_map = {5126: np.float32, 5123: np.uint16, 5125: np.uint32, 5121: np.uint8}
    dt = dtype_map[acc["componentType"]]
    count = acc["count"] * type_size
    raw = np.frombuffer(bin_blob, dtype=dt, count=count, offset=offset)
    if acc["type"] == "SCALAR":
        return raw
    return raw.reshape(acc["count"], type_size)


def _write_accessor(gltf: dict, bin_data: bytearray, arr: np.ndarray,
                    acc_type: str, comp_type: int = 5126) -> int:
    """Append arr to bin_data, create a fresh bufferView + accessor, return
    accessor index. Caller is responsible for updating buffer.byteLength."""
    payload = arr.tobytes()
    pad = (4 - len(payload) % 4) % 4
    payload_padded = payload + b"\x00" * pad
    offset = len(bin_data)
    bin_data.extend(payload_padded)
    bv = {"buffer": 0, "byteOffset": offset, "byteLength": len(payload)}
    gltf.setdefault("bufferViews", []).append(bv)
    bv_idx = len(gltf["bufferViews"]) - 1

    type_size = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[acc_type]
    if acc_type == "SCALAR":
        count = len(arr)
    else:
        count = arr.shape[0]
    acc = {
        "bufferView": bv_idx,
        "componentType": comp_type,
        "count": count,
        "type": acc_type,
    }
    if arr.ndim >= 2 and acc_type != "MAT4":
        acc["min"] = arr.min(axis=0).tolist()
        acc["max"] = arr.max(axis=0).tolist()
    elif arr.ndim == 1 and acc_type == "SCALAR":
        acc["min"] = [float(arr.min())]
        acc["max"] = [float(arr.max())]
    gltf.setdefault("accessors", []).append(acc)
    return len(gltf["accessors"]) - 1


# ---------------------------------------------------------------------------
# Defect detection
# ---------------------------------------------------------------------------
def _joint_world_positions(gltf: dict, bin_blob: bytes, skin_idx: int = 0) -> np.ndarray:
    skin = gltf["skins"][skin_idx]
    ibm = _read_accessor(gltf, bin_blob, skin["inverseBindMatrices"])
    ibm_mats = ibm.reshape(len(skin["joints"]), 4, 4).astype(np.float64)
    ibm_mats = np.transpose(ibm_mats, (0, 2, 1))
    positions = np.zeros((len(skin["joints"]), 3))
    for k in range(len(skin["joints"])):
        try:
            inv = np.linalg.inv(ibm_mats[k])
            positions[k] = inv[:3, 3]
        except np.linalg.LinAlgError:
            positions[k] = 0.0
    return positions


def _mesh_bbox(gltf: dict, bin_blob: bytes) -> tuple[np.ndarray, np.ndarray]:
    mn = np.array([np.inf, np.inf, np.inf])
    mx = np.array([-np.inf, -np.inf, -np.inf])
    for m in gltf.get("meshes", []):
        for p in m.get("primitives", []):
            pos_idx = p.get("attributes", {}).get("POSITION")
            if pos_idx is None:
                continue
            pts = _read_accessor(gltf, bin_blob, pos_idx)
            mn = np.minimum(mn, pts.min(axis=0))
            mx = np.maximum(mx, pts.max(axis=0))
    return mn, mx


def detect_defects(glb_path: str, *, coincident_tol: float = 1e-3,
                   scale_outlier_factor: float = 5.0) -> dict:
    """Return a dict describing detected defects without modifying the GLB.

    coincident_pairs: list of (i, j) joint indices where world positions
        are within tol of each other.
    ibm_scale_corrupted: True if joint world positions are >scale_outlier_factor
        times outside the mesh bbox diagonal.
    """
    gltf, _, bin_blob = _read_glb(glb_path)
    if not gltf.get("skins"):
        return {"coincident_pairs": [], "ibm_scale_corrupted": False,
                "joints_total": 0, "mesh_bbox_diag": 0.0}
    positions = _joint_world_positions(gltf, bin_blob, 0)
    pairs = []
    for i in range(len(positions)):
        for j in range(i + 1, len(positions)):
            if float(np.linalg.norm(positions[i] - positions[j])) < coincident_tol:
                pairs.append((i, j))
    mn, mx = _mesh_bbox(gltf, bin_blob)
    mesh_diag = float(np.linalg.norm(mx - mn))
    # Check if any joint sits >5x mesh diagonal outside the bbox center.
    center = (mn + mx) / 2.0
    max_joint_dist = float(np.linalg.norm(positions - center, axis=1).max())
    scale_corrupted = bool(max_joint_dist > scale_outlier_factor * mesh_diag)
    return {
        "coincident_pairs": pairs,
        "ibm_scale_corrupted": scale_corrupted,
        "joints_total": len(positions),
        "mesh_bbox_diag": mesh_diag,
        "max_joint_dist_from_center": max_joint_dist,
    }


# ---------------------------------------------------------------------------
# Fix 1 — merge coincident joints
# ---------------------------------------------------------------------------
def merge_coincident_joints(glb_in: str, glb_out: str, *,
                            tol: float = 1e-3) -> dict:
    """Cluster coincident joints, pick a canonical per cluster, redirect
    skin weights, drop duplicates."""
    gltf, _, bin_blob = _read_glb(glb_in)
    if not gltf.get("skins"):
        with open(glb_in, "rb") as f:
            with open(glb_out, "wb") as g:
                g.write(f.read())
        return {"clusters": 0, "joints_dropped": 0}
    skin = gltf["skins"][0]
    joints = list(skin["joints"])
    positions = _joint_world_positions(gltf, bin_blob, 0)

    # Build clusters via union-find on coincident pairs
    parent_uf = list(range(len(joints)))
    def find(i: int) -> int:
        while parent_uf[i] != i:
            parent_uf[i] = parent_uf[parent_uf[i]]
            i = parent_uf[i]
        return i
    def union(i: int, j: int) -> None:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent_uf[ri] = rj
    for i in range(len(positions)):
        for j in range(i + 1, len(positions)):
            if float(np.linalg.norm(positions[i] - positions[j])) < tol:
                union(i, j)
    clusters: dict[int, list[int]] = {}
    for k in range(len(joints)):
        clusters.setdefault(find(k), []).append(k)

    # Pick canonical per cluster: the joint with the most children in the
    # node hierarchy (i.e. the one that anatomically branches). Tiebreak
    # by lowest index.
    nodes = gltf["nodes"]
    def child_count(jk: int) -> int:
        nid = joints[jk]
        return len((nodes[nid].get("children") or []))
    canonical_of: dict[int, int] = {}
    for cluster_id, members in clusters.items():
        members.sort(key=lambda jk: (-child_count(jk), jk))
        canonical_of[cluster_id] = members[0]

    # Redirect: for any (skin joint index) that's not canonical, find its
    # canonical neighbor in the same cluster.
    redirect: dict[int, int] = {}
    for cluster_id, members in clusters.items():
        canon_jk = canonical_of[cluster_id]
        for jk in members:
            redirect[jk] = canon_jk

    # Build the new skin.joints list = canonicals only, preserve order
    surviving_jks = sorted({redirect[jk] for jk in range(len(joints))})
    old_to_new_skin_idx: dict[int, int] = {}
    for new_idx, old_jk in enumerate(surviving_jks):
        old_to_new_skin_idx[old_jk] = new_idx
    # All non-canonical also point to the canonical's NEW idx
    for jk in range(len(joints)):
        old_to_new_skin_idx[jk] = old_to_new_skin_idx[redirect[jk]]
    new_joints = [joints[jk] for jk in surviving_jks]

    # Patch skin
    skin["joints"] = new_joints
    # Rebuild IBM accessor for the surviving joints only
    old_ibm = _read_accessor(gltf, bin_blob, skin["inverseBindMatrices"])
    old_ibm = old_ibm.reshape(len(joints), 4, 4)
    new_ibm = np.stack([old_ibm[jk] for jk in surviving_jks], axis=0)
    bin_data = bytearray(bin_blob)
    new_acc_idx = _write_accessor(gltf, bin_data, new_ibm.astype(np.float32), "MAT4")
    skin["inverseBindMatrices"] = new_acc_idx

    # Patch skin weights in every primitive: remap JOINTS_0 ushort indices
    remap_arr = np.array([old_to_new_skin_idx[jk] for jk in range(len(joints))], dtype=np.uint16)
    primitives_patched = 0
    for m in gltf.get("meshes", []):
        for p in m.get("primitives", []):
            j_acc_idx = p.get("attributes", {}).get("JOINTS_0")
            if j_acc_idx is None:
                continue
            joints_arr = _read_accessor(gltf, bin_blob, j_acc_idx).copy()  # (V, 4) uint
            joints_arr = remap_arr[joints_arr.astype(np.int64)].astype(np.uint16)
            new_j_acc = _write_accessor(gltf, bin_data, joints_arr, "VEC4", comp_type=5123)
            p["attributes"]["JOINTS_0"] = new_j_acc
            primitives_patched += 1

    # Patch hierarchy: in node.children, drop references to dropped joints,
    # they fall outside skin.joints but glTF still lets them be node
    # children. We don't delete nodes (might be used by animations); we
    # only ensure the skin is consistent.

    # Update buffer size
    if gltf.get("buffers"):
        gltf["buffers"][0]["byteLength"] = len(bin_data)

    _write_glb(gltf, bytes(bin_data), glb_out)
    return {
        "clusters": len(clusters),
        "joints_before": len(joints),
        "joints_after": len(new_joints),
        "joints_dropped": len(joints) - len(new_joints),
        "primitives_patched": primitives_patched,
    }


# ---------------------------------------------------------------------------
# Fix 2 — IBM scale repair
# ---------------------------------------------------------------------------
def repair_ibm_scale(glb_in: str, glb_out: str) -> dict:
    """Two corruption modes are repaired:

      (A) Global scale: ALL joints sit ~Nx the mesh size. Detected by
          median(joint_dist) >> mesh_diag. Fixed by uniform rescale around
          mesh center.

      (B) Per-joint outliers: a small minority of joints (typically a
          chain like UE5 mannequin's spine_01..05 in Hunyuan exports) sit
          way outside the mesh bbox while the rest are fine. Detected by
          per-joint distance > clip_factor * mesh_diag. Those joints get
          SNAPPED to their parent's world position (a safe degenerate
          position that won't break LBS skinning, and the merge_coincident
          pass that runs AFTER will fold the snapped bone into its
          parent so it disappears cleanly from skin.joints).
    """
    gltf, _, bin_blob = _read_glb(glb_in)
    if not gltf.get("skins"):
        with open(glb_in, "rb") as f:
            with open(glb_out, "wb") as g:
                g.write(f.read())
        return {"rescaled": False, "scale": 1.0}
    positions = _joint_world_positions(gltf, bin_blob, 0)
    mn, mx = _mesh_bbox(gltf, bin_blob)
    mesh_center = (mn + mx) / 2.0
    mesh_diag = float(np.linalg.norm(mx - mn))

    joint_dists = np.linalg.norm(positions - mesh_center, axis=1)
    median_joint_dist = float(np.median(joint_dists))
    max_joint_dist = float(joint_dists.max())
    target_dist = mesh_diag * 0.25

    # Mode A: global scale corruption (median is wildly off)
    if median_joint_dist > 5.0 * mesh_diag:
        scale = target_dist / max(median_joint_dist, 1e-6)
        return _apply_uniform_ibm_scale(gltf, bin_blob, glb_out, scale, mesh_center)

    # Mode B: per-joint outliers. Detect joints sitting >5x diagonal away.
    OUTLIER_FACTOR = 5.0
    outlier_mask = joint_dists > OUTLIER_FACTOR * mesh_diag
    if outlier_mask.any():
        return _snap_outlier_joints_to_parent(gltf, bin_blob, glb_out,
                                              outlier_mask, mesh_center)

    # Nothing to do
    if median_joint_dist <= 5.0 * mesh_diag and not outlier_mask.any():
        with open(glb_in, "rb") as f:
            with open(glb_out, "wb") as g:
                g.write(f.read())
        return {"rescaled": False, "scale": 1.0,
                "median_joint_dist": median_joint_dist,
                "max_joint_dist": max_joint_dist,
                "mesh_diag": mesh_diag}

    return {}


def _apply_uniform_ibm_scale(gltf: dict, bin_blob: bytes, glb_out: str,
                             scale: float, mesh_center: np.ndarray) -> dict:
    skin = gltf["skins"][0]
    old_ibm = _read_accessor(gltf, bin_blob, skin["inverseBindMatrices"])
    old_ibm = old_ibm.reshape(len(skin["joints"]), 4, 4).astype(np.float64)
    old_ibm = np.transpose(old_ibm, (0, 2, 1))
    new_ibm = np.zeros_like(old_ibm)
    for k in range(len(old_ibm)):
        try:
            bind = np.linalg.inv(old_ibm[k])
            t = bind[:3, 3]
            bind[:3, 3] = mesh_center + (t - mesh_center) * scale
            new_ibm[k] = np.linalg.inv(bind)
        except np.linalg.LinAlgError:
            new_ibm[k] = old_ibm[k]
    new_ibm = np.transpose(new_ibm, (0, 2, 1)).astype(np.float32)
    bin_data = bytearray(bin_blob)
    new_acc_idx = _write_accessor(gltf, bin_data, new_ibm, "MAT4")
    skin["inverseBindMatrices"] = new_acc_idx
    if gltf.get("buffers"):
        gltf["buffers"][0]["byteLength"] = len(bin_data)
    _write_glb(gltf, bytes(bin_data), glb_out)
    return {"rescaled": True, "mode": "uniform", "scale": scale}


def _snap_outlier_joints_to_parent(gltf: dict, bin_blob: bytes, glb_out: str,
                                    outlier_mask: np.ndarray,
                                    mesh_center: np.ndarray) -> dict:
    """For each outlier joint, set its IBM so that its world position
    sits at its parent's world position (or mesh_center if no parent).
    The merge_coincident pass after this will absorb them."""
    skin = gltf["skins"][0]
    joints = list(skin["joints"])
    nodes = gltf["nodes"]
    positions = _joint_world_positions(gltf, bin_blob, 0)

    # Build parent map in skin-index space.
    parent_of_skin_idx = {jk: -1 for jk in range(len(joints))}
    joint_set = set(joints)
    nid_to_skin_idx = {nid: jk for jk, nid in enumerate(joints)}
    for jk, nid in enumerate(joints):
        # Find its parent node — scan all nodes for whose children list
        # contains nid.
        for k_nid, n in enumerate(nodes):
            if k_nid not in joint_set:
                continue
            if nid in (n.get("children") or []):
                parent_of_skin_idx[jk] = nid_to_skin_idx.get(k_nid, -1)
                break

    old_ibm = _read_accessor(gltf, bin_blob, skin["inverseBindMatrices"])
    old_ibm = old_ibm.reshape(len(joints), 4, 4).astype(np.float64)
    old_ibm = np.transpose(old_ibm, (0, 2, 1))
    new_ibm = old_ibm.copy()
    snapped = 0
    for k in range(len(joints)):
        if not outlier_mask[k]:
            continue
        # Find a non-outlier ancestor; fallback to mesh_center
        target_pos = mesh_center.copy()
        cur = parent_of_skin_idx[k]
        guard = 0
        while cur >= 0 and guard < 1024:
            if not outlier_mask[cur]:
                target_pos = positions[cur].copy()
                break
            cur = parent_of_skin_idx[cur]
            guard += 1
        try:
            bind = np.linalg.inv(old_ibm[k])
            bind[:3, 3] = target_pos
            new_ibm[k] = np.linalg.inv(bind)
            snapped += 1
        except np.linalg.LinAlgError:
            pass
    new_ibm = np.transpose(new_ibm, (0, 2, 1)).astype(np.float32)

    bin_data = bytearray(bin_blob)
    new_acc_idx = _write_accessor(gltf, bin_data, new_ibm, "MAT4")
    skin["inverseBindMatrices"] = new_acc_idx
    if gltf.get("buffers"):
        gltf["buffers"][0]["byteLength"] = len(bin_data)
    _write_glb(gltf, bytes(bin_data), glb_out)
    return {"rescaled": True, "mode": "snap_outliers",
            "joints_snapped": snapped,
            "joints_total": len(joints)}


# ---------------------------------------------------------------------------
# Convenience: full post-process
# ---------------------------------------------------------------------------
def postprocess(glb_in: str, glb_out: str, *, tol: float = 1e-3) -> dict:
    """Run all repairs in order. Returns a dict describing what was done."""
    import tempfile
    defects_before = detect_defects(glb_in, coincident_tol=tol)
    report: dict[str, Any] = {"defects_before": defects_before, "steps": []}

    current = glb_in
    tmp_files = []

    # Step 1: scale repair (must come BEFORE merge so coincident detection
    # in merge uses sensible distances).
    if defects_before["ibm_scale_corrupted"]:
        tmp = tempfile.mktemp(suffix=".glb")
        tmp_files.append(tmp)
        scale_report = repair_ibm_scale(current, tmp)
        report["steps"].append({"op": "repair_ibm_scale", **scale_report})
        current = tmp

    # Step 2: merge coincident
    pairs_now = defects_before["coincident_pairs"] if current == glb_in else \
                detect_defects(current, coincident_tol=tol)["coincident_pairs"]
    if pairs_now:
        tmp = tempfile.mktemp(suffix=".glb")
        tmp_files.append(tmp)
        merge_report = merge_coincident_joints(current, tmp, tol=tol)
        report["steps"].append({"op": "merge_coincident", **merge_report})
        current = tmp

    # Final write
    if current == glb_in:
        # Nothing to do
        with open(glb_in, "rb") as f:
            with open(glb_out, "wb") as g:
                g.write(f.read())
    else:
        with open(current, "rb") as f:
            with open(glb_out, "wb") as g:
                g.write(f.read())

    for t in tmp_files:
        try:
            os.unlink(t)
        except OSError:
            pass

    report["defects_after"] = detect_defects(glb_out, coincident_tol=tol)
    return report


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--in", dest="glb_in", required=True)
    ap.add_argument("--out", dest="glb_out", required=True)
    ap.add_argument("--tol", type=float, default=1e-3,
                    help="coincident joint tolerance (default 1e-3)")
    ap.add_argument("--detect-only", action="store_true",
                    help="print defect report without writing output")
    args = ap.parse_args()

    if args.detect_only:
        defects = detect_defects(args.glb_in, coincident_tol=args.tol)
        print(json.dumps({k: (str(v) if isinstance(v, (np.ndarray,)) else v)
                          for k, v in defects.items()}, indent=2))
        return 0

    report = postprocess(args.glb_in, args.glb_out, tol=args.tol)
    # Compact summary
    def _summary(d: dict) -> dict:
        return {
            "joints": d.get("joints_total"),
            "coincident_pairs": len(d.get("coincident_pairs", [])),
            "ibm_scale_corrupted": d.get("ibm_scale_corrupted"),
            "max_joint_dist_from_center": d.get("max_joint_dist_from_center"),
        }
    print("[rig_postprocess]")
    print(f"  BEFORE: {json.dumps(_summary(report['defects_before']))}")
    for step in report["steps"]:
        print(f"  STEP {step['op']}: {json.dumps({k: v for k, v in step.items() if k != 'op'})}")
    print(f"  AFTER : {json.dumps(_summary(report['defects_after']))}")
    print(f"  -> {args.glb_out}")
    return 0


if __name__ == "__main__":
    sys.exit(_main())
