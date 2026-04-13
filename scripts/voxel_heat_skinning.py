"""
Voxel Heat Diffusion Skinning — standalone module for FabMesh auto-rigging.

Computes per-vertex per-bone skinning weights using voxelized heat diffusion,
based on Baran & Popovic 2007 (Pinocchio) and the UniRig voxel_skin algorithm.

Dependencies: numpy, scipy, trimesh (no torch, no pyrender, no open3d).
Runs fully headless — no OpenGL or display required.

Usage:
    from voxel_heat_skinning import compute_skin_weights
    weights = compute_skin_weights(vertices, faces, joint_positions)

Author: FabWare / MeshyMyself
"""

import time
import numpy as np
from scipy.spatial import cKDTree
from scipy.sparse import csr_matrix, coo_matrix
from scipy.sparse.csgraph import shortest_path


def _voxelize_trimesh(vertices, faces, grid_resolution):
    """
    Voxelize a mesh using trimesh (no OpenGL needed).

    Returns:
        grid_coords: (M, 3) float array of interior voxel center positions,
                     in the same coordinate space as the input vertices.
    """
    import trimesh

    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)

    # Compute pitch from mesh bounding box
    extents = mesh.bounding_box.extents
    max_extent = max(extents)
    pitch = max_extent / grid_resolution

    # Voxelize the mesh surface, then flood-fill interior
    voxel_grid = mesh.voxelized(pitch)
    voxel_grid = voxel_grid.fill()  # fills interior cavities

    # Extract voxel center coordinates in world space
    grid_coords = voxel_grid.points  # (M, 3) centers of filled voxels

    return grid_coords, pitch


def compute_skin_weights(
    vertices,
    faces,
    joint_positions,
    grid_resolution=64,
    alpha=0.5,
    grid_query=27,
    vertex_query=27,
    grid_weight=3.0,
    mode="square",
    verbose=True,
):
    """
    Compute per-vertex per-bone skinning weights using voxelized heat diffusion.

    This replaces Blender's ARMATURE_AUTO / Envelope weights with a pure-Python
    implementation that runs headlessly on CPU.

    Algorithm (from UniRig / Pinocchio):
        1. Voxelize the mesh interior using trimesh
        2. Build a graph connecting mesh edges, interior voxels (26-neighbors),
           and surface-to-voxel links, all weighted by Euclidean distance
        3. Snap each joint to its nearest graph node
        4. Dijkstra shortest paths from each joint through the interior
        5. Convert distances to weights via inverse-square falloff
        6. Normalize per-vertex so weights sum to 1.0

    Args:
        vertices:        (N, 3) float array of mesh vertex positions
        faces:           (F, 3) int array of triangle face indices
        joint_positions: (J, 3) float array of bone joint positions
        grid_resolution: voxel grid resolution (default 64)
        alpha:           blending parameter for distance falloff (default 0.5)
        grid_query:      k-neighbors for voxel-to-voxel linking (default 27 = 3x3x3)
        vertex_query:    k-neighbors for voxel-to-vertex linking (default 27)
        grid_weight:     weight multiplier for voxel-voxel edges (default 3.0)
        mode:            'square' or 'exp' distance-to-weight conversion
        verbose:         print timing info

    Returns:
        weights: (N, J) float array, rows normalized to sum to 1.0
    """
    vertices = np.asarray(vertices, dtype=np.float64)
    faces = np.asarray(faces, dtype=np.int64)
    joint_positions = np.asarray(joint_positions, dtype=np.float64)

    assert mode in ("square", "exp"), f"mode must be 'square' or 'exp', got '{mode}'"

    J = joint_positions.shape[0]
    N = vertices.shape[0]

    t0 = time.time()

    # --- Step 1: Voxelize -------------------------------------------------
    grid_coords, pitch = _voxelize_trimesh(vertices, faces, grid_resolution)
    M = grid_coords.shape[0]
    if verbose:
        print(f"  [skin] voxelized: {M} interior voxels, pitch={pitch:.5f}  "
              f"({time.time()-t0:.2f}s)")

    # The neighbor-distance threshold: voxels within sqrt(3)*pitch are 26-neighbors
    neighbor_threshold = pitch * 1.75  # slightly above sqrt(3) ~ 1.732

    # --- Step 2: Build graph ----------------------------------------------
    t1 = time.time()

    # Combined node array: [0..N-1] = mesh vertices, [N..N+M-1] = voxel centers
    combined = np.concatenate([vertices, grid_coords], axis=0)

    # 2a) Mesh edges from faces (vertex-to-vertex)
    src_v2v = np.concatenate([faces[:, 0], faces[:, 1], faces[:, 2]])
    dst_v2v = np.concatenate([faces[:, 1], faces[:, 2], faces[:, 0]])
    w_v2v = np.linalg.norm(vertices[src_v2v] - vertices[dst_v2v], axis=1)

    # 2b) Voxel-to-voxel (26-neighbors within the grid)
    grid_tree = cKDTree(grid_coords)
    actual_grid_query = min(grid_query, M)
    dist_g, idx_g = grid_tree.query(grid_coords, k=actual_grid_query)
    # Exclude self (column 0)
    dist_g = dist_g[:, 1:]
    idx_g = idx_g[:, 1:]
    mask_g = (dist_g > 0) & (dist_g < neighbor_threshold)
    src_g2g = np.repeat(np.arange(M), actual_grid_query - 1)[mask_g.ravel()] + N
    dst_g2g = idx_g[mask_g] + N
    w_g2g = dist_g[mask_g] * grid_weight

    # 2c) Voxel-to-surface-vertex links
    vertex_tree = cKDTree(vertices)
    actual_vertex_query = min(vertex_query, N)
    dist_gv, idx_gv = vertex_tree.query(grid_coords, k=actual_vertex_query)
    mask_gv = (dist_gv > 0) & (dist_gv < neighbor_threshold)
    src_g2v = np.repeat(np.arange(M), actual_vertex_query)[mask_gv.ravel()] + N
    dst_g2v = idx_gv[mask_gv]
    w_g2v = dist_gv[mask_gv]

    # 2d) Close-vertex merging (co-located vertices)
    link_dis = 1e-5
    dist_close, idx_close = vertex_tree.query(vertices, k=4)
    dist_close = dist_close[:, 1:]
    idx_close = idx_close[:, 1:]
    mask_close = (dist_close > 0) & (dist_close < link_dis * 1.001)
    src_close = np.repeat(np.arange(N), 3)[mask_close.ravel()]
    dst_close = idx_close[mask_close]
    w_close = dist_close[mask_close]

    # Assemble sparse graph
    all_src = np.concatenate([src_close, src_v2v, src_g2g, src_g2v])
    all_dst = np.concatenate([dst_close, dst_v2v, dst_g2g, dst_g2v])
    all_w = np.concatenate([w_close, w_v2v, w_g2g, w_g2v])

    graph = csr_matrix((all_w, (all_src, all_dst)), shape=(N + M, N + M))

    if verbose:
        print(f"  [skin] graph built: {len(all_w)} edges, {N+M} nodes  "
              f"({time.time()-t1:.2f}s)")

    # --- Step 3: Snap joints to nearest graph node ------------------------
    combined_tree = cKDTree(combined)
    _, joint_indices = combined_tree.query(joint_positions)

    # --- Step 4: Dijkstra from each joint ---------------------------------
    t2 = time.time()
    dist_matrix = shortest_path(
        graph, method="D", directed=False, indices=joint_indices
    )
    # dist_matrix shape: (J, N+M)
    # We only need distances to mesh vertices (first N columns)
    dis = dist_matrix[:, :N]  # (J, N)

    if verbose:
        print(f"  [skin] dijkstra done: {J} joints  ({time.time()-t2:.2f}s)")

    # --- Step 5: Handle unreachable vertices ------------------------------
    unreachable = np.isinf(dis).all(axis=0)
    if unreachable.any():
        joint_tree = cKDTree(joint_positions)
        k = min(J, 3)
        fallback_dist, fallback_idx = joint_tree.query(vertices[unreachable], k=k)
        if k == 1:
            fallback_dist = fallback_dist[:, np.newaxis]
            fallback_idx = fallback_idx[:, np.newaxis]
        unreachable_indices = np.where(unreachable)[0]
        for i in range(k):
            dis[fallback_idx[:, i], unreachable_indices] = fallback_dist[:, i]
        if verbose:
            print(f"  [skin] patched {unreachable.sum()} unreachable vertices")

    # Replace remaining inf/nan with max finite distance
    finite_vals = dis[np.isfinite(dis)]
    max_dis = np.max(finite_vals) if finite_vals.size > 0 else 1.0
    dis = np.nan_to_num(dis, nan=max_dis, posinf=max_dis, neginf=max_dis)
    dis = np.maximum(dis, 1e-6)

    # --- Step 6: Distance-to-weight conversion ----------------------------
    if mode == "exp":
        skin = np.exp(-dis / max_dis * 20.0)
    elif mode == "square":
        skin = (1.0 / ((1 - alpha) * dis + alpha * dis**2)) ** 2
    else:
        raise ValueError(f"invalid mode: {mode}")

    # Normalize per vertex (columns of skin = vertices)
    col_sums = skin.sum(axis=0, keepdims=True)
    col_sums[col_sums == 0] = 1.0
    skin = skin / col_sums

    # Transpose to (N, J)
    weights = skin.T

    if verbose:
        print(f"  [skin] total: {time.time()-t0:.2f}s  |  "
              f"verts={N}  joints={J}  voxels={M}  grid={grid_resolution}")

    return weights


# ---------------------------------------------------------------------------
# Convenience wrapper for auto_rig_bridge.py
# ---------------------------------------------------------------------------

def skin_mesh_file(mesh_path, joint_positions, grid_resolution=64, verbose=True):
    """
    Load a mesh file (GLB/OBJ/FBX/STL) and compute skinning weights.

    Args:
        mesh_path:       path to mesh file (any format trimesh can load)
        joint_positions: (J, 3) array or list-of-lists of joint world positions
        grid_resolution: voxel grid resolution
        verbose:         print progress

    Returns:
        dict with keys:
            'weights':  (N, J) ndarray
            'vertices': (N, 3) ndarray
            'faces':    (F, 3) ndarray
    """
    import trimesh

    scene_or_mesh = trimesh.load(mesh_path, force="mesh", process=False)
    if isinstance(scene_or_mesh, trimesh.Scene):
        # Merge all meshes in the scene
        mesh = trimesh.util.concatenate(
            [g for g in scene_or_mesh.geometry.values()
             if isinstance(g, trimesh.Trimesh)]
        )
    else:
        mesh = scene_or_mesh

    vertices = np.array(mesh.vertices, dtype=np.float64)
    faces = np.array(mesh.faces, dtype=np.int64)
    joint_positions = np.asarray(joint_positions, dtype=np.float64)

    weights = compute_skin_weights(
        vertices, faces, joint_positions,
        grid_resolution=grid_resolution, verbose=verbose,
    )

    return {
        "weights": weights,
        "vertices": vertices,
        "faces": faces,
    }


# ---------------------------------------------------------------------------
# CLI test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import sys
    import trimesh

    print("=" * 60)
    print("Voxel Heat Diffusion Skinning — standalone test")
    print("=" * 60)

    # Try to load a real mesh from the project
    mesh_path = None
    candidates = [
        # Common test meshes in the project
        "c:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/meshes",
        "c:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/output",
    ]

    if len(sys.argv) > 1:
        mesh_path = sys.argv[1]
    else:
        import glob
        for d in candidates:
            for ext in ("*.glb", "*.obj", "*.fbx", "*.stl"):
                found = glob.glob(f"{d}/{ext}")
                if found:
                    mesh_path = found[0]
                    break
            if mesh_path:
                break

    if mesh_path:
        print(f"\nLoading mesh: {mesh_path}")
        scene_or_mesh = trimesh.load(mesh_path, force="mesh", process=False)
        if isinstance(scene_or_mesh, trimesh.Scene):
            mesh = trimesh.util.concatenate(
                [g for g in scene_or_mesh.geometry.values()
                 if isinstance(g, trimesh.Trimesh)]
            )
        else:
            mesh = scene_or_mesh
        verts = np.array(mesh.vertices)
        tris = np.array(mesh.faces)
    else:
        # Generate a simple test sphere
        print("\nNo mesh file found, generating test sphere (642 verts)...")
        mesh = trimesh.creation.icosphere(subdivisions=3, radius=1.0)
        verts = np.array(mesh.vertices)
        tris = np.array(mesh.faces)

    print(f"Mesh: {verts.shape[0]} vertices, {tris.shape[0]} faces")

    # Create fake joint positions mimicking a simple humanoid skeleton
    bbox_min = verts.min(axis=0)
    bbox_max = verts.max(axis=0)
    center = (bbox_min + bbox_max) / 2.0
    height = bbox_max[1] - bbox_min[1]  # assume Y-up
    width = bbox_max[0] - bbox_min[0]

    joints = np.array([
        center + [0, -height * 0.4, 0],          # 0: hips
        center + [0, -height * 0.1, 0],          # 1: spine
        center + [0, height * 0.1, 0],           # 2: chest
        center + [0, height * 0.3, 0],           # 3: neck
        center + [0, height * 0.45, 0],          # 4: head
        center + [-width * 0.3, height * 0.2, 0],  # 5: left shoulder
        center + [-width * 0.5, height * 0.0, 0],  # 6: left elbow
        center + [-width * 0.7, height * -0.1, 0],  # 7: left hand
        center + [width * 0.3, height * 0.2, 0],   # 8: right shoulder
        center + [width * 0.5, height * 0.0, 0],   # 9: right elbow
        center + [width * 0.7, height * -0.1, 0],  # 10: right hand
        center + [-width * 0.15, -height * 0.45, 0],  # 11: left hip
        center + [-width * 0.15, -height * 0.7, 0],   # 12: left knee
        center + [-width * 0.15, -height * 0.95, 0],  # 13: left foot
        center + [width * 0.15, -height * 0.45, 0],   # 14: right hip
        center + [width * 0.15, -height * 0.7, 0],    # 15: right knee
        center + [width * 0.15, -height * 0.95, 0],   # 16: right foot
    ], dtype=np.float64)

    print(f"Joints: {joints.shape[0]} fake humanoid joints")
    print()

    # Run skinning
    weights = compute_skin_weights(
        verts, tris, joints,
        grid_resolution=48,  # lower res for quick test
        verbose=True,
    )

    print()
    print(f"Result weights shape: {weights.shape}")
    print(f"  min={weights.min():.6f}  max={weights.max():.6f}")
    print(f"  row sums: min={weights.sum(axis=1).min():.6f}  "
          f"max={weights.sum(axis=1).max():.6f}")

    # Show dominant joint per vertex (first 20 verts)
    dominant = np.argmax(weights, axis=1)
    joint_names = [
        "hips", "spine", "chest", "neck", "head",
        "L_shoulder", "L_elbow", "L_hand",
        "R_shoulder", "R_elbow", "R_hand",
        "L_hip", "L_knee", "L_foot",
        "R_hip", "R_knee", "R_foot",
    ]
    print("\nDominant joint for first 20 vertices:")
    for i in range(min(20, len(dominant))):
        jname = joint_names[dominant[i]] if dominant[i] < len(joint_names) else f"j{dominant[i]}"
        print(f"  v{i}: {jname} (w={weights[i, dominant[i]]:.4f})")

    print("\nDone.")
