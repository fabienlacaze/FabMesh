"""Recompute glTF inverseBindMatrices from FK at rest.

When a rig generator (Puppeteer, UniRig, etc.) emits a skin whose
IBMs don't match the actual rest pose of the joint nodes, every
linear-blend-skinned vertex gets multiplied by garbage and the mesh
explodes the first time the animation player binds the skin.

Correct definition (glTF 2.0 spec, Appendix A):
    skinning_matrix[j] = globalJointTransform[j] @ IBM[j]
and at the rest pose this MUST equal identity (joint stays where it
is). So IBM[j] = inverse(world(joint_node_j)) — computed from the
node tree only (no external pose).

This script walks the GLB, recomputes each skin's IBMs from FK on the
node tree, and writes the result back. CLI usage:

    python scripts/fix_glb_ibms.py <input.glb> <output.glb>

Self-test (no args): builds a tiny 2-bone skeleton in memory and
checks that FK @ IBM @ rest_vertex == rest_vertex.
"""
from __future__ import annotations

import os
import struct
import sys
from typing import Dict, List, Tuple

import numpy as np

# Reuse the GLB IO + accessor helpers from the retarget script.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
from anytop_retarget import (  # noqa: E402
    _read_glb,
    _add_buffer_view,
    _add_accessor,
    _write_glb,
)


# ============================================================
# Math helpers
# ============================================================

def _quat_to_mat3(q: List[float]) -> np.ndarray:
    """glTF quaternion (x,y,z,w) -> 3x3 rotation matrix."""
    x, y, z, w = float(q[0]), float(q[1]), float(q[2]), float(q[3])
    n = x * x + y * y + z * z + w * w
    if n > 0:
        s = 2.0 / n
    else:
        s = 0.0
    xx, yy, zz = x * x * s, y * y * s, z * z * s
    xy, xz, yz = x * y * s, x * z * s, y * z * s
    wx, wy, wz = w * x * s, w * y * s, w * z * s
    return np.array([
        [1.0 - (yy + zz), xy - wz,         xz + wy],
        [xy + wz,         1.0 - (xx + zz), yz - wx],
        [xz - wy,         yz + wx,         1.0 - (xx + yy)],
    ], dtype=np.float64)


def _local_matrix(node: dict) -> np.ndarray:
    """Compose node's local TRS into a 4x4 matrix. T * R * S per spec."""
    if "matrix" in node and node["matrix"]:
        # glTF stores matrices column-major; unpack to row-major numpy.
        m = np.asarray(node["matrix"], dtype=np.float64).reshape(4, 4).T
        return m
    T = np.asarray(node.get("translation", [0.0, 0.0, 0.0]), dtype=np.float64)
    R3 = _quat_to_mat3(node.get("rotation", [0.0, 0.0, 0.0, 1.0]))
    S = np.asarray(node.get("scale", [1.0, 1.0, 1.0]), dtype=np.float64)
    M = np.eye(4, dtype=np.float64)
    # R * S (in upper-left 3x3), then T in last column.
    M[:3, :3] = R3 * S[np.newaxis, :]
    M[:3, 3] = T
    return M


def _parent_map(nodes: List[dict]) -> Dict[int, int]:
    """Invert children list -> map child_idx -> parent_idx. Root = -1."""
    parent: Dict[int, int] = {i: -1 for i in range(len(nodes))}
    for i, n in enumerate(nodes):
        for c in (n.get("children") or []):
            parent[int(c)] = i
    return parent


def _world_matrix(node_idx: int, nodes: List[dict],
                  parent: Dict[int, int],
                  cache: Dict[int, np.ndarray]) -> np.ndarray:
    """Walk parents from node_idx up to the root, compose local TRS."""
    if node_idx in cache:
        return cache[node_idx]
    local = _local_matrix(nodes[node_idx])
    p = parent.get(node_idx, -1)
    if p < 0:
        world = local
    else:
        world = _world_matrix(p, nodes, parent, cache) @ local
    cache[node_idx] = world
    return world


# ============================================================
# Core: rewrite IBMs for one skin
# ============================================================

def _rewrite_skin_ibms(gltf: dict, bin_data: bytearray, skin: dict,
                       parent: Dict[int, int]) -> int:
    """Replace skin.inverseBindMatrices with FK-computed IBMs.

    Returns the new accessor index.
    """
    nodes = gltf["nodes"]
    cache: Dict[int, np.ndarray] = {}
    joints = [int(j) for j in skin.get("joints", [])]

    payload = bytearray()
    for j in joints:
        world = _world_matrix(j, nodes, parent, cache)
        ibm = np.linalg.inv(world).astype(np.float32)
        # glTF MAT4 is COLUMN-MAJOR: write column 0, then 1, 2, 3.
        for col in range(4):
            for row in range(4):
                payload.extend(struct.pack("<f", float(ibm[row, col])))

    bv = _add_buffer_view(gltf, bin_data, bytes(payload))
    acc = _add_accessor(gltf, bv, len(joints), 5126, "MAT4")
    skin["inverseBindMatrices"] = acc
    return acc


def fix_glb_ibms(in_path: str, out_path: str) -> None:
    gltf, _json_blob, bin_blob = _read_glb(in_path)
    nodes = gltf.get("nodes") or []
    skins = gltf.get("skins") or []
    if not skins:
        raise RuntimeError(f"{in_path}: no skins found, nothing to fix")
    parent = _parent_map(nodes)

    bin_data = bytearray(bin_blob)
    for s_idx, skin in enumerate(skins):
        n_joints = len(skin.get("joints", []))
        acc = _rewrite_skin_ibms(gltf, bin_data, skin, parent)
        print(f"[fix_glb_ibms] skin {s_idx}: rewrote {n_joints} IBMs "
              f"-> accessor {acc}")

    _write_glb(gltf, bytes(bin_data), out_path)
    print(f"[fix_glb_ibms] wrote {out_path}")


# ============================================================
# Self-test
# ============================================================

def _self_test() -> bool:
    """2-bone skeleton: root at origin, child translated +Y by 1.

    A rest vertex sitting at the child joint's world position should
    survive global @ IBM unchanged.
    """
    print("[self-test] building 2-bone skeleton...")
    nodes = [
        {"name": "root", "translation": [0.0, 0.0, 0.0],
         "rotation": [0.0, 0.0, 0.0, 1.0], "children": [1]},
        {"name": "child", "translation": [0.0, 1.0, 0.0],
         "rotation": [0.0, 0.0, 0.0, 1.0]},
    ]
    parent = _parent_map(nodes)
    assert parent == {0: -1, 1: 0}, f"parent map wrong: {parent}"

    cache: Dict[int, np.ndarray] = {}
    w_root = _world_matrix(0, nodes, parent, cache)
    w_child = _world_matrix(1, nodes, parent, cache)

    # Sanity: child world position should be (0,1,0).
    child_pos = w_child[:3, 3]
    ok_pos = np.allclose(child_pos, [0.0, 1.0, 0.0])
    print(f"[self-test] child world pos = {child_pos.tolist()} "
          f"(expect [0,1,0]) -> {'OK' if ok_pos else 'FAIL'}")

    ibm_root = np.linalg.inv(w_root)
    ibm_child = np.linalg.inv(w_child)

    # Rest vertex at child joint's world position.
    v_rest = np.array([0.0, 1.0, 0.0, 1.0], dtype=np.float64)
    # Fully bound to child (weight = 1).
    skin_mat = w_child @ ibm_child
    v_skinned = skin_mat @ v_rest
    ok_skin = np.allclose(v_skinned, v_rest)
    print(f"[self-test] skin_mat @ v_rest = {v_skinned.tolist()} "
          f"(expect {v_rest.tolist()}) -> {'OK' if ok_skin else 'FAIL'}")

    # skin_mat should be identity at rest.
    ok_iden = np.allclose(skin_mat, np.eye(4))
    print(f"[self-test] skin_mat == identity -> "
          f"{'OK' if ok_iden else 'FAIL'}")

    # Test rotation case: child rotated 90 deg around Z.
    nodes[1]["rotation"] = [0.0, 0.0, np.sin(np.pi / 4), np.cos(np.pi / 4)]
    cache2: Dict[int, np.ndarray] = {}
    w_child2 = _world_matrix(1, nodes, parent, cache2)
    ibm_child2 = np.linalg.inv(w_child2)
    skin2 = w_child2 @ ibm_child2
    ok_rot = np.allclose(skin2, np.eye(4))
    print(f"[self-test] rotated child skin_mat == identity -> "
          f"{'OK' if ok_rot else 'FAIL'}")

    # Column-major write check: pack ibm_child into bytes the way the
    # real path does, then decode and compare.
    payload = bytearray()
    for col in range(4):
        for row in range(4):
            payload.extend(struct.pack("<f", float(ibm_child[row, col])))
    floats = struct.unpack("<16f", bytes(payload))
    # glTF reader will see this as column-major MAT4: column c, row r
    # -> floats[c * 4 + r].
    decoded = np.zeros((4, 4), dtype=np.float64)
    for c in range(4):
        for r in range(4):
            decoded[r, c] = floats[c * 4 + r]
    ok_pack = np.allclose(decoded, ibm_child.astype(np.float32), atol=1e-6)
    print(f"[self-test] column-major round-trip -> "
          f"{'OK' if ok_pack else 'FAIL'}")

    all_ok = ok_pos and ok_skin and ok_iden and ok_rot and ok_pack
    print(f"[self-test] {'ALL PASS' if all_ok else 'FAIL'}")
    return all_ok


# ============================================================
# CLI
# ============================================================

if __name__ == "__main__":
    if len(sys.argv) == 1:
        ok = _self_test()
        sys.exit(0 if ok else 1)
    if len(sys.argv) != 3:
        print("Usage: python scripts/fix_glb_ibms.py <input.glb> <output.glb>",
              file=sys.stderr)
        print("       python scripts/fix_glb_ibms.py        # run self-test",
              file=sys.stderr)
        sys.exit(2)
    fix_glb_ibms(sys.argv[1], sys.argv[2])
