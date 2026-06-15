"""
FABRIK IK solver — pure numpy, MIT license.

FABRIK = Forward And Backward Reaching Inverse Kinematics
Reference: Aristidou & Lasenby, "FABRIK: A fast, iterative solver
for the Inverse Kinematics problem", Graphical Models 2011.

Algorithm summary:
    For each iteration:
      FORWARD (tip -> root):
        Move tip exactly onto target
        For each bone (tip-1 down to root):
          direction = bone.position - child_new_position
          bone_new_position = child_new_position + direction.normalize() * bone_length[bone]
      BACKWARD (root -> tip):
        Move root exactly onto anchor
        For each bone (root+1 up to tip):
          direction = bone.position - parent_new_position
          bone_new_position = parent_new_position + direction.normalize() * bone_length[parent]
      Check distance(tip, target) < tol -> done

This module has zero dependencies beyond numpy, so it's safe to ship inside
FabMesh's commercial Electron build (no torch/scipy at runtime).

License: MIT
"""

from __future__ import annotations

import numpy as np


# ---------------------------------------------------------------------------
# Quaternion helpers (xyzw convention to match scipy / Unreal / Unity layout
# ... wait, we use wxyz here to keep math compact. Functions are internal,
# the public API just returns (N, 4) — the consumer documents convention.)
#
# Convention used in this file: quaternion = [w, x, y, z]
# ---------------------------------------------------------------------------

_EPS = 1e-9


def _normalize(v: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(v)
    if n < _EPS:
        return np.zeros_like(v)
    return v / n


def _quat_identity() -> np.ndarray:
    return np.array([1.0, 0.0, 0.0, 0.0])


def _quat_mul(q1: np.ndarray, q2: np.ndarray) -> np.ndarray:
    """Hamilton product, wxyz."""
    w1, x1, y1, z1 = q1
    w2, x2, y2, z2 = q2
    return np.array([
        w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
        w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
        w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
        w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    ])


def _quat_conj(q: np.ndarray) -> np.ndarray:
    return np.array([q[0], -q[1], -q[2], -q[3]])


def _quat_rotate(q: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Rotate vector v by quaternion q (wxyz)."""
    vq = np.array([0.0, v[0], v[1], v[2]])
    out = _quat_mul(_quat_mul(q, vq), _quat_conj(q))
    return out[1:]


def _quat_from_two_vectors(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """
    Shortest-arc rotation that maps unit-vector a onto unit-vector b.
    Returns identity if either vector is degenerate.
    Handles the antiparallel (180 deg) case by picking an arbitrary
    perpendicular axis.
    """
    a = _normalize(a)
    b = _normalize(b)
    if np.linalg.norm(a) < _EPS or np.linalg.norm(b) < _EPS:
        return _quat_identity()

    d = float(np.dot(a, b))

    # Already aligned.
    if d > 1.0 - _EPS:
        return _quat_identity()

    # Antiparallel — pick any axis perpendicular to a.
    if d < -1.0 + _EPS:
        # Find a vector not parallel to a.
        if abs(a[0]) < 0.9:
            ref = np.array([1.0, 0.0, 0.0])
        else:
            ref = np.array([0.0, 1.0, 0.0])
        axis = _normalize(np.cross(a, ref))
        # 180 deg rotation about that axis: w = 0, xyz = axis.
        return np.array([0.0, axis[0], axis[1], axis[2]])

    axis = np.cross(a, b)
    w = 1.0 + d
    q = np.array([w, axis[0], axis[1], axis[2]])
    return q / np.linalg.norm(q)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def solve_chain(
    bone_positions_world: np.ndarray,
    target_world: np.ndarray,
    anchor_world: np.ndarray | None = None,
    bone_lengths: np.ndarray | None = None,
    max_iterations: int = 10,
    tol: float = 1e-4,
) -> np.ndarray:
    """
    Solve a single IK chain using FABRIK.

    Args:
        bone_positions_world: (N, 3) world positions of each bone.
            Index 0 is the root (anchored), index N-1 is the tip (reaches target).
        target_world: (3,) world position the tip should reach.
        anchor_world: (3,) world position the root should stay at.
            Defaults to bone_positions_world[0].
        bone_lengths: (N-1,) precomputed segment lengths. If None,
            derived from the rest positions.
        max_iterations: maximum FABRIK iterations.
        tol: convergence tolerance — stop when |tip - target| < tol.

    Returns:
        (N, 3) updated world positions after IK.
    """
    pts = np.asarray(bone_positions_world, dtype=np.float64).copy()
    target = np.asarray(target_world, dtype=np.float64).reshape(3)
    anchor = np.asarray(anchor_world if anchor_world is not None else pts[0],
                       dtype=np.float64).reshape(3)

    n = pts.shape[0]
    if n < 2:
        # Single bone — nothing to solve, just return as-is (root pinned).
        out = pts.copy()
        out[0] = anchor
        return out

    if bone_lengths is None:
        bone_lengths = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    else:
        bone_lengths = np.asarray(bone_lengths, dtype=np.float64).reshape(-1)
        assert bone_lengths.shape[0] == n - 1, \
            f"bone_lengths must have shape (N-1,) = ({n - 1},), got {bone_lengths.shape}"

    total_length = float(np.sum(bone_lengths))
    root_to_target = float(np.linalg.norm(target - anchor))

    # Unreachable target — fully extend along (target - anchor).
    if root_to_target > total_length + _EPS:
        direction = _normalize(target - anchor)
        out = np.zeros_like(pts)
        out[0] = anchor
        for i in range(1, n):
            out[i] = out[i - 1] + direction * bone_lengths[i - 1]
        return out

    # Reachable — iterate FORWARD then BACKWARD until tip ~ target.
    for _ in range(max_iterations):
        if np.linalg.norm(pts[-1] - target) < tol:
            break

        # FORWARD pass: tip -> root.
        pts[-1] = target
        for i in range(n - 2, -1, -1):
            direction = _normalize(pts[i] - pts[i + 1])
            pts[i] = pts[i + 1] + direction * bone_lengths[i]

        # BACKWARD pass: root -> tip.
        pts[0] = anchor
        for i in range(1, n):
            direction = _normalize(pts[i] - pts[i - 1])
            pts[i] = pts[i - 1] + direction * bone_lengths[i - 1]

    return pts


def positions_to_local_rotations(
    rest_positions_world: np.ndarray,
    new_positions_world: np.ndarray,
    parent_world_rest: np.ndarray,
) -> np.ndarray:
    """
    Compute per-bone PARENT-LOCAL rotation quaternions needed to move
    rest_positions -> new_positions.

    For each bone i (0..N-2), we compute the rotation that maps the rest bone
    direction (from bone i to bone i+1, expressed in the parent frame) onto
    the new bone direction (same vector, in the parent frame). The last bone
    (the tip) has no child to define a direction, so it inherits the previous
    bone's parent-local rotation (identity in its own parent frame).

    Quaternion convention: [w, x, y, z].

    Args:
        rest_positions_world: (N, 3) bone WORLD positions in rest pose.
        new_positions_world: (N, 3) bone WORLD positions after IK.
        parent_world_rest: (4,) parent world rotation quat in rest, for the
            first bone's parent frame. Use identity [1,0,0,0] if the chain
            root has no parent.

    Returns:
        (N, 4) per-bone parent-local rotation quaternions.
    """
    rest = np.asarray(rest_positions_world, dtype=np.float64)
    new = np.asarray(new_positions_world, dtype=np.float64)
    assert rest.shape == new.shape and rest.shape[1] == 3
    n = rest.shape[0]

    # Track the accumulated world rotation of each bone, so we can express the
    # next bone's direction in its own parent frame.
    out = np.zeros((n, 4), dtype=np.float64)
    bone_world_rot = np.zeros((n, 4), dtype=np.float64)

    # The "parent" of bone 0 is given by the caller.
    parent_rot = np.asarray(parent_world_rest, dtype=np.float64).reshape(4)
    parent_rot = parent_rot / max(np.linalg.norm(parent_rot), _EPS)

    for i in range(n - 1):
        rest_dir_world = rest[i + 1] - rest[i]
        new_dir_world = new[i + 1] - new[i]

        # Express both directions in the parent's local frame.
        parent_conj = _quat_conj(parent_rot)
        rest_dir_local = _quat_rotate(parent_conj, rest_dir_world)
        new_dir_local = _quat_rotate(parent_conj, new_dir_world)

        # Rotation in parent-local frame that maps rest_dir -> new_dir.
        q_local = _quat_from_two_vectors(rest_dir_local, new_dir_local)
        out[i] = q_local

        # This bone's world rotation = parent_world * local.
        bone_world_rot[i] = _quat_mul(parent_rot, q_local)
        parent_rot = bone_world_rot[i]

    # Tip: no child direction. Default to identity in its parent frame.
    out[n - 1] = _quat_identity()
    return out


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # 3-bone chain along +Y in rest pose.
    rest = np.array([
        [0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 2.0, 0.0],
    ])

    target = np.array([1.0, 1.0, 0.0])
    tol = 1e-4

    new_positions = solve_chain(rest, target, max_iterations=10, tol=tol)

    tip_err = float(np.linalg.norm(new_positions[-1] - target))
    root_err = float(np.linalg.norm(new_positions[0] - rest[0]))

    # Verify bone lengths preserved.
    rest_lens = np.linalg.norm(np.diff(rest, axis=0), axis=1)
    new_lens = np.linalg.norm(np.diff(new_positions, axis=0), axis=1)
    len_err = float(np.max(np.abs(rest_lens - new_lens)))

    print(f"rest positions:\n{rest}")
    print(f"new positions:\n{new_positions}")
    print(f"target: {target}")
    print(f"tip error:  {tip_err:.3e}  (tol={tol})")
    print(f"root error: {root_err:.3e}")
    print(f"max bone-length error: {len_err:.3e}")

    assert tip_err < tol, f"tip did not reach target: err={tip_err}"
    assert root_err < 1e-6, f"root moved away from anchor: err={root_err}"
    assert len_err < 1e-6, f"bone lengths drifted: err={len_err}"

    # Quaternion conversion smoke test.
    quats = positions_to_local_rotations(
        rest_positions_world=rest,
        new_positions_world=new_positions,
        parent_world_rest=np.array([1.0, 0.0, 0.0, 0.0]),
    )
    assert quats.shape == (3, 4)
    # Each row must be a unit quaternion.
    norms = np.linalg.norm(quats, axis=1)
    assert np.all(np.abs(norms - 1.0) < 1e-6), f"non-unit quats: {norms}"
    print(f"local quats:\n{quats}")

    print("FABRIK self-test passed")
