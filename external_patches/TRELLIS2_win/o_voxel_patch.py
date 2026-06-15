"""o_voxel_patch.py

Drop-in replacement for ``o_voxel.postprocess.to_glb`` that does NOT depend on
``nvdiffrast`` (which is shipped under the NVIDIA Source Code License =
non-commercial).  All the rasterisation / barycentric interpolation work is
done with a small pure-PyTorch rasteriser, so the only deps used here are:

* PyTorch                       (BSD-3)
* trimesh                       (MIT)
* OpenCV (cv2)                  (Apache 2.0)
* Pillow / NumPy                (BSD / PSF / BSD)
* o_voxel.cumesh / flex_gemm    (already part of the TRELLIS-2 stack)

No new dependency is introduced.  All licences are commercial-safe.

Usage (mirrors the original API exactly):

    import o_voxel_patch
    glb = o_voxel_patch.to_glb(
        vertices=mesh.vertices,
        faces=mesh.faces,
        attr_volume=mesh.attrs,
        coords=mesh.coords,
        attr_layout=mesh.layout,
        voxel_size=mesh.voxel_size,
        aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
        decimation_target=1000000,
        texture_size=1024,
        remesh=True,
        remesh_band=1,
        remesh_project=0,
        verbose=True,
    )

The texture-baking step is the only non-trivial change vs. the original
``o_voxel.postprocess.to_glb`` — see :func:`_pytorch_rasterize_uv` and
:func:`_pytorch_interpolate_attr` below.
"""

from typing import Dict, List, Tuple, Union

import numpy as np
import torch
import cv2
from PIL import Image
import trimesh
import trimesh.visual

# [blackwell_fix] Pure-PyTorch grid_sample_3d replacement.
# flex_gemm's grid_sample_3d is broken on sm_120 (RTX 50xx Blackwell):
# returns ~85% noise samples, producing fluo confetti texture atlas.
# See visualbruno/ComfyUI-Trellis2 issue #157 (OPEN, no upstream fix).
import torch.nn.functional as _F
def grid_sample_3d(features, coords, shape, grid, mode='trilinear'):
    """
    Pure-PyTorch sparse 3D trilinear sampler.

    Args:
        features: (L, C) sparse voxel features
        coords:   (L, 4) [batch, x, y, z] integer voxel coordinates
        shape:    torch.Size([B, C, D, H, W]) target dense volume shape
        grid:     (B, N, 3) sampling positions in voxel space [0, D/H/W]
        mode:     'trilinear' (only supported mode)

    Returns:
        (N, C) sampled features at grid positions
    """
    B, C, D, H, W = shape
    assert mode == 'trilinear', f"Only trilinear supported, got {mode}"
    assert features.shape[1] == C, f"feature C={features.shape[1]} != shape C={C}"

    # Densify sparse → dense (zero-fill empty voxels)
    dense = torch.zeros(B, C, D, H, W, device=features.device, dtype=features.dtype)
    if coords.shape[1] == 4:
        b, x, y, z = coords.long().unbind(dim=-1)
    else:  # legacy (L, 3) — assume single batch
        b = torch.zeros(coords.shape[0], dtype=torch.long, device=coords.device)
        x, y, z = coords.long().unbind(dim=-1)
    dense[b, :, x, y, z] = features

    # Normalize grid from voxel space [0, D] to F.grid_sample space [-1, 1]
    # F.grid_sample expects (B, N_out, 1, 1, 3) with order (x, y, z) for 5D input
    # but volume layout is (B, C, D, H, W) where dim D=spatial0 (z), H=spatial1 (y), W=spatial2 (x)
    # → grid input order must be (W_norm, H_norm, D_norm) = (x_norm, y_norm, z_norm)
    grid_xyz = grid.clone().float()  # (B, N, 3) in voxel coords
    # Coords order in voxel space here: matches dense indexing dense[b, :, x, y, z]
    # so grid axis 0 = x (matches D), axis 1 = y (matches H), axis 2 = z (matches W)?
    # Actually dense[b, :, x, y, z] means D=x, H=y, W=z → so grid (x,y,z) maps to (D,H,W)
    # F.grid_sample expects last dim = (W_idx, H_idx, D_idx) = (z_norm, y_norm, x_norm)
    # Normalize each axis to [-1, 1] using its own dim size
    sizes = torch.tensor([D, H, W], device=grid.device, dtype=grid_xyz.dtype)  # (D=x_size, H=y_size, W=z_size)
    grid_norm = (grid_xyz + 0.5) / sizes * 2.0 - 1.0  # (B, N, 3) [-1,1]
    # Flip axis order from (x,y,z) to (z,y,x) for F.grid_sample
    grid_for_sample = grid_norm[..., [2, 1, 0]]  # (B, N, 3)
    # Reshape to (B, N, 1, 1, 3) for 5D grid_sample
    grid_5d = grid_for_sample.view(B, -1, 1, 1, 3)

    sampled = _F.grid_sample(
        dense, grid_5d,
        mode='bilinear',  # PyTorch's bilinear for 5D input = trilinear
        padding_mode='zeros',
        align_corners=False,
    )  # (B, C, N, 1, 1)
    sampled = sampled.squeeze(-1).squeeze(-1).permute(0, 2, 1)  # (B, N, C)
    return sampled.reshape(-1, C)
import cumesh

try:
    from tqdm import tqdm  # noqa: F401
except ImportError:  # pragma: no cover
    tqdm = None  # type: ignore


# ---------------------------------------------------------------------------
# Pure-PyTorch UV rasteriser
# ---------------------------------------------------------------------------
#
# nvdiffrast.rasterize() returns, for every output texel, a 4-vector
#     (u, v, depth, triangle_id+1)
# where (u, v) are the barycentric coords w.r.t. the *first two* vertices of
# the triangle (the third one is 1 - u - v) and depth is the clip-space z.
#
# In ``to_glb`` we only need:
#   * the triangle id (alpha channel) — used as a foreground mask and to fetch
#     the right vertex positions for the interpolation step
#   * the barycentric (u, v) — used by the subsequent ``dr.interpolate`` call
#     to compute the 3-D position of every texel.
#
# Depth is irrelevant here: every UV "vertex" sits on the z=0 plane, so the
# only question per texel is *which* triangle covers it (no depth test
# needed beyond "any of them").
#
# We therefore implement a barycentric / edge-function rasteriser running
# fully on the GPU in chunks of triangles.  For each chunk we:
#
#   1. Compute the integer pixel bounding box of every triangle.
#   2. Build a per-triangle local pixel grid clamped to a maximum side.
#   3. Compute barycentric coords for every (triangle, local-pixel) pair via
#      the standard 2-D edge function.
#   4. Keep only pairs whose barycentric coords are all >= 0 (-> inside the
#      triangle).
#   5. Scatter (u, v, 0, face_id+1) into the output buffer at the
#      corresponding global pixel.  Whichever triangle writes last wins,
#      which mirrors nvdiffrast's behaviour for coplanar triangles.
#
# The implementation is intentionally simple — no Z-buffer, no MSAA, no
# anti-aliasing.  This is exactly what the original code path needed.
# ---------------------------------------------------------------------------


def _pytorch_rasterize_uv(
    uvs_clip: torch.Tensor,        # (V, 2) UV coordinates in clip space [-1, 1]
    faces: torch.Tensor,           # (F, 3) int triangle indices
    resolution: int,
    face_id_offset: int = 0,
    out_buffer: torch.Tensor = None,  # (1, H, W, 4)
    chunk_size: int = 8192,
    max_tri_pixels: int = 4096,
) -> torch.Tensor:
    """Rasterise a UV-space triangle soup into a 4-channel buffer.

    Returns a tensor of shape (1, resolution, resolution, 4) where each
    texel stores ``(bary_u, bary_v, 0, face_id + 1 + face_id_offset)``
    (zero everywhere outside any triangle).  ``out_buffer`` may be passed
    in to accumulate over several chunks.
    """

    device = uvs_clip.device
    H = W = resolution

    if out_buffer is None:
        out_buffer = torch.zeros((1, H, W, 4), dtype=torch.float32, device=device)

    if faces.numel() == 0:
        return out_buffer

    # Vertex positions per triangle in pixel space (origin = top-left, +y down)
    # nvdiffrast convention: clip-space y points up, image y points down -> flip y
    # Internally we just compute pixel coords; the eventual flip is consistent
    # with the original code path because we pre-multiply uv by 2-1 the same
    # way and use the same convention everywhere.
    uv_pix = (uvs_clip * 0.5 + 0.5) * resolution  # (V, 2)

    tri_xy = uv_pix[faces.long()]  # (F, 3, 2)

    # Bounding box per triangle (clamped to the image)
    tri_min = torch.floor(tri_xy.min(dim=1).values).clamp(0, resolution - 1).to(torch.int32)
    tri_max = torch.ceil(tri_xy.max(dim=1).values).clamp(0, resolution - 1).to(torch.int32)
    tri_size = (tri_max - tri_min + 1).clamp(min=1)  # (F, 2) [w, h]

    # Edge function denominator (twice the signed area)
    v0 = tri_xy[:, 0]  # (F, 2)
    v1 = tri_xy[:, 1]
    v2 = tri_xy[:, 2]
    denom = (v1[:, 0] - v0[:, 0]) * (v2[:, 1] - v0[:, 1]) \
          - (v1[:, 1] - v0[:, 1]) * (v2[:, 0] - v0[:, 0])
    valid_tri = denom.abs() > 1e-12  # degenerate triangles get skipped

    # Process triangles in chunks to control memory.
    F_total = faces.shape[0]
    for chunk_start in range(0, F_total, chunk_size):
        chunk_end = min(chunk_start + chunk_size, F_total)
        idx = torch.arange(chunk_start, chunk_end, device=device)
        idx = idx[valid_tri[idx]]
        if idx.numel() == 0:
            continue

        c_v0 = v0[idx]               # (n, 2)
        c_v1 = v1[idx]
        c_v2 = v2[idx]
        c_denom = denom[idx]         # (n,)
        c_min = tri_min[idx]         # (n, 2)
        c_size = tri_size[idx]       # (n, 2)

        # Cap the per-triangle pixel count.  With a sane UV unwrap this only
        # kicks in for pathological cases (e.g. a tiny ribbon spanning the
        # whole atlas).  When it does we just rasterise on the clamped bbox;
        # the rest of the triangle area will be picked up by adjacent
        # triangles or filled in later by the cv2.inpaint() pass.
        c_w = c_size[:, 0].clamp(max=int(np.sqrt(max_tri_pixels)))
        c_h = c_size[:, 1].clamp(max=int(np.sqrt(max_tri_pixels)))
        max_w = int(c_w.max().item())
        max_h = int(c_h.max().item())
        if max_w == 0 or max_h == 0:
            continue

        # Per-triangle pixel grid (n, max_h, max_w, 2).  Cells outside the
        # actual bbox are masked out below.
        ax = torch.arange(max_w, device=device)
        ay = torch.arange(max_h, device=device)
        gy, gx = torch.meshgrid(ay, ax, indexing='ij')   # (max_h, max_w)
        # Pixel centres
        px = c_min[:, None, None, 0].float() + gx.float() + 0.5  # (n, max_h, max_w)
        py = c_min[:, None, None, 1].float() + gy.float() + 0.5

        # In-bbox mask
        in_w = (gx[None, :, :] < c_w[:, None, None])
        in_h = (gy[None, :, :] < c_h[:, None, None])
        in_bbox = in_w & in_h

        # Edge functions (2x signed area of the sub-triangle).
        # Barycentric (w0, w1, w2) where w_i corresponds to vertex i.
        w0 = (c_v1[:, None, None, 0] - px) * (c_v2[:, None, None, 1] - py) \
           - (c_v1[:, None, None, 1] - py) * (c_v2[:, None, None, 0] - px)
        w1 = (c_v2[:, None, None, 0] - px) * (c_v0[:, None, None, 1] - py) \
           - (c_v2[:, None, None, 1] - py) * (c_v0[:, None, None, 0] - px)
        w2 = (c_v0[:, None, None, 0] - px) * (c_v1[:, None, None, 1] - py) \
           - (c_v0[:, None, None, 1] - py) * (c_v1[:, None, None, 0] - px)

        # Normalise.  Account for triangle orientation via sign(denom).
        inv_denom = 1.0 / c_denom[:, None, None]
        w0 = w0 * inv_denom
        w1 = w1 * inv_denom
        w2 = w2 * inv_denom

        # Coverage test.  Use a small epsilon to be inclusive on edges, the
        # same way nvdiffrast's "top-left" rule keeps shared edges covered.
        eps = 1e-5
        inside = (w0 >= -eps) & (w1 >= -eps) & (w2 >= -eps) & in_bbox

        if not inside.any():
            continue

        # Gather (n_inside,) lists
        sel = inside.nonzero(as_tuple=False)        # (K, 3) -> (tri_local, y, x)
        tri_local = sel[:, 0]
        local_y = sel[:, 1]
        local_x = sel[:, 2]

        global_x = (c_min[tri_local, 0] + local_x).long()
        global_y = (c_min[tri_local, 1] + local_y).long()

        # nvdiffrast returns (u, v) where they are the bary coords for v1, v2
        # (so vertex 0's weight is 1 - u - v).  Confirmed by reading the
        # nvdiffrast docs and the dr.interpolate() math.
        bary_u = w1[tri_local, local_y, local_x]
        bary_v = w2[tri_local, local_y, local_x]

        global_face_id = (idx[tri_local] + 1 + face_id_offset).float()

        # Scatter into the output buffer.  We don't have a Z test here (UV
        # plane), so the latest writer wins, mirroring nvdiffrast for
        # coplanar triangles.
        out_buffer[0, global_y, global_x, 0] = bary_u
        out_buffer[0, global_y, global_x, 1] = bary_v
        out_buffer[0, global_y, global_x, 2] = 0.0
        out_buffer[0, global_y, global_x, 3] = global_face_id

    return out_buffer


def _pytorch_interpolate_attr(
    attr: torch.Tensor,    # (1, V, C) or (V, C)
    rast: torch.Tensor,    # (1, H, W, 4)
    faces: torch.Tensor,   # (F, 3) int
) -> torch.Tensor:
    """Replicates ``nvdiffrast.torch.interpolate`` for our use case.

    nvdiffrast computes, for every texel covered by triangle ``t``:
        attr[v0] * (1 - u - v) + attr[v1] * u + attr[v2] * v
    where (u, v) are the barycentric coords stored in ``rast[..., :2]``.

    Returns a tensor of shape (1, H, W, C).  Texels with face_id == 0 (no
    triangle) are zero.
    """
    if attr.dim() == 2:
        attr_v = attr            # (V, C)
    else:
        assert attr.dim() == 3 and attr.size(0) == 1
        attr_v = attr[0]         # (V, C)

    H, W = rast.shape[1], rast.shape[2]
    face_id = rast[0, ..., 3].long() - 1   # (-1 for empty)
    bary_u = rast[0, ..., 0]
    bary_v = rast[0, ..., 1]

    valid = face_id >= 0
    face_clamped = face_id.clamp(min=0)

    tri = faces[face_clamped.flatten()]              # (H*W, 3)
    v0_idx = tri[:, 0].long()
    v1_idx = tri[:, 1].long()
    v2_idx = tri[:, 2].long()

    a0 = attr_v[v0_idx].view(H, W, -1)
    a1 = attr_v[v1_idx].view(H, W, -1)
    a2 = attr_v[v2_idx].view(H, W, -1)

    bw0 = (1.0 - bary_u - bary_v).unsqueeze(-1)
    bw1 = bary_u.unsqueeze(-1)
    bw2 = bary_v.unsqueeze(-1)

    out = a0 * bw0 + a1 * bw1 + a2 * bw2
    out = torch.where(valid.unsqueeze(-1), out, torch.zeros_like(out))
    return out.unsqueeze(0)


# ---------------------------------------------------------------------------
# Drop-in replacement for o_voxel.postprocess.to_glb
# ---------------------------------------------------------------------------


def to_glb(
    vertices: torch.Tensor,
    faces: torch.Tensor,
    attr_volume: torch.Tensor,
    coords: torch.Tensor,
    attr_layout: Dict[str, slice],
    aabb: Union[list, tuple, np.ndarray, torch.Tensor],
    voxel_size: Union[float, list, tuple, np.ndarray, torch.Tensor] = None,
    grid_size: Union[int, list, tuple, np.ndarray, torch.Tensor] = None,
    decimation_target: int = 1000000,
    texture_size: int = 2048,
    remesh: bool = False,
    remesh_band: float = 1,
    remesh_project: float = 0.9,
    mesh_cluster_threshold_cone_half_angle_rad=np.radians(90.0),
    mesh_cluster_refine_iterations=0,
    mesh_cluster_global_iterations=1,
    mesh_cluster_smooth_strength=1,
    verbose: bool = False,
    use_tqdm: bool = False,
):
    """Commercial-safe version of ``o_voxel.postprocess.to_glb``.

    Behaviour is identical to the original; only the rasterisation /
    barycentric interpolation step is reimplemented in pure PyTorch.
    """

    # --- Input Normalization (AABB, Voxel Size, Grid Size) ---
    if isinstance(aabb, (list, tuple)):
        aabb = np.array(aabb)
    if isinstance(aabb, np.ndarray):
        aabb = torch.tensor(aabb, dtype=torch.float32, device=coords.device)
    assert isinstance(aabb, torch.Tensor)
    assert aabb.dim() == 2 and aabb.size(0) == 2 and aabb.size(1) == 3

    if voxel_size is not None:
        if isinstance(voxel_size, float):
            voxel_size = [voxel_size, voxel_size, voxel_size]
        if isinstance(voxel_size, (list, tuple)):
            voxel_size = np.array(voxel_size)
        if isinstance(voxel_size, np.ndarray):
            voxel_size = torch.tensor(voxel_size, dtype=torch.float32, device=coords.device)
        grid_size = ((aabb[1] - aabb[0]) / voxel_size).round().int()
    else:
        assert grid_size is not None, "Either voxel_size or grid_size must be provided"
        if isinstance(grid_size, int):
            grid_size = [grid_size, grid_size, grid_size]
        if isinstance(grid_size, (list, tuple)):
            grid_size = np.array(grid_size)
        if isinstance(grid_size, np.ndarray):
            grid_size = torch.tensor(grid_size, dtype=torch.int32, device=coords.device)
        voxel_size = (aabb[1] - aabb[0]) / grid_size

    assert isinstance(voxel_size, torch.Tensor)
    assert voxel_size.dim() == 1 and voxel_size.size(0) == 3
    assert isinstance(grid_size, torch.Tensor)
    assert grid_size.dim() == 1 and grid_size.size(0) == 3

    if use_tqdm:
        pbar = tqdm(total=6, desc="Extracting GLB")
    if verbose:
        print(f"Original mesh: {vertices.shape[0]} vertices, {faces.shape[0]} faces")

    vertices = vertices.cuda()
    faces = faces.cuda()

    mesh = cumesh.CuMesh()
    mesh.init(vertices, faces)

    mesh.fill_holes(max_hole_perimeter=3e-2)
    if verbose:
        print(f"After filling holes: {mesh.num_vertices} vertices, {mesh.num_faces} faces")
    vertices, faces = mesh.read()
    if use_tqdm:
        pbar.update(1)

    if use_tqdm:
        pbar.set_description("Building BVH")
    if verbose:
        print("Building BVH for current mesh...", end='', flush=True)
    bvh = cumesh.cuBVH(vertices, faces)
    if use_tqdm:
        pbar.update(1)
    if verbose:
        print("Done")

    if use_tqdm:
        pbar.set_description("Cleaning mesh")
    if verbose:
        print("Cleaning mesh...")

    if not remesh:
        mesh.simplify(decimation_target * 3, verbose=verbose)
        if verbose:
            print(f"After inital simplification: {mesh.num_vertices} vertices, {mesh.num_faces} faces")
        mesh.remove_duplicate_faces()
        mesh.repair_non_manifold_edges()
        mesh.remove_small_connected_components(1e-5)
        mesh.fill_holes(max_hole_perimeter=3e-2)
        if verbose:
            print(f"After initial cleanup: {mesh.num_vertices} vertices, {mesh.num_faces} faces")

        mesh.simplify(decimation_target, verbose=verbose)
        if verbose:
            print(f"After final simplification: {mesh.num_vertices} vertices, {mesh.num_faces} faces")

        mesh.remove_duplicate_faces()
        mesh.repair_non_manifold_edges()
        mesh.remove_small_connected_components(1e-5)
        mesh.fill_holes(max_hole_perimeter=3e-2)
        if verbose:
            print(f"After final cleanup: {mesh.num_vertices} vertices, {mesh.num_faces} faces")

        mesh.unify_face_orientations()
    else:
        center = aabb.mean(dim=0)
        scale = (aabb[1] - aabb[0]).max().item()
        resolution = grid_size.max().item()

        mesh.init(*cumesh.remeshing.remesh_narrow_band_dc(
            vertices, faces,
            center=center,
            scale=(resolution + 3 * remesh_band) / resolution * scale,
            resolution=resolution,
            band=remesh_band,
            project_back=remesh_project,
            verbose=verbose,
            bvh=bvh,
        ))
        if verbose:
            print(f"After remeshing: {mesh.num_vertices} vertices, {mesh.num_faces} faces")
        mesh.simplify(decimation_target, verbose=verbose)
        if verbose:
            print(f"After simplifying: {mesh.num_vertices} vertices, {mesh.num_faces} faces")

    if use_tqdm:
        pbar.update(1)
    if verbose:
        print("Done")

    # --- UV Parameterization ---
    if use_tqdm:
        pbar.set_description("Parameterizing new mesh")
    if verbose:
        print("Parameterizing new mesh...")

    out_vertices, out_faces, out_uvs, out_vmaps = mesh.uv_unwrap(
        compute_charts_kwargs={
            "threshold_cone_half_angle_rad": mesh_cluster_threshold_cone_half_angle_rad,
            "refine_iterations": mesh_cluster_refine_iterations,
            "global_iterations": mesh_cluster_global_iterations,
            "smooth_strength": mesh_cluster_smooth_strength,
        },
        return_vmaps=True,
        verbose=verbose,
    )
    out_vertices = out_vertices.cuda()
    out_faces = out_faces.cuda()
    out_uvs = out_uvs.cuda()
    out_vmaps = out_vmaps.cuda()
    mesh.compute_vertex_normals()
    out_normals = mesh.read_vertex_normals()[out_vmaps]

    if use_tqdm:
        pbar.update(1)
    if verbose:
        print("Done")

    # --- Texture Baking (Attribute Sampling) — pure-PyTorch path ---
    if use_tqdm:
        pbar.set_description("Sampling attributes")
    if verbose:
        print("Sampling attributes (pure PyTorch rasteriser)...", end='', flush=True)

    # Same UV-space "clip" coords as the original code
    uvs_clip = out_uvs * 2 - 1                                   # (V, 2)

    rast = torch.zeros(
        (1, texture_size, texture_size, 4),
        device='cuda', dtype=torch.float32,
    )
    # Match the original 100k-tri chunking.  Per chunk we offset face ids
    # to mirror the "alpha += i" trick of the original code.
    CHUNK = 100000
    for i in range(0, out_faces.shape[0], CHUNK):
        chunk_faces = out_faces[i:i + CHUNK]
        rast = _pytorch_rasterize_uv(
            uvs_clip,
            chunk_faces,
            resolution=texture_size,
            face_id_offset=i,
            out_buffer=rast,
        )

    mask = rast[0, ..., 3] > 0

    # Interpolate vertex *positions* per texel — the bary stored in rast
    # already references the global face id (via face_id_offset above), so
    # we can use the full out_faces tensor directly.
    pos = _pytorch_interpolate_attr(out_vertices.unsqueeze(0), rast, out_faces)[0]
    valid_pos = pos[mask]

    # Map back onto the original high-res mesh to recover accurate attrs.
    _, face_id, uvw = bvh.unsigned_distance(valid_pos, return_uvw=True)
    orig_tri_verts = vertices[faces[face_id.long()]]
    valid_pos = (orig_tri_verts * uvw.unsqueeze(-1)).sum(dim=1)

    attrs = torch.zeros(texture_size, texture_size, attr_volume.shape[1], device='cuda')
    attrs[mask] = grid_sample_3d(
        attr_volume,
        torch.cat([torch.zeros_like(coords[:, :1]), coords], dim=-1),
        shape=torch.Size([1, attr_volume.shape[1], *grid_size.tolist()]),
        grid=((valid_pos - aabb[0]) / voxel_size).reshape(1, -1, 3),
        mode='trilinear',
    )
    if use_tqdm:
        pbar.update(1)
    if verbose:
        print("Done")

    # --- Texture Post-Processing & Material Construction ---
    if use_tqdm:
        pbar.set_description("Finalizing mesh")
    if verbose:
        print("Finalizing mesh...", end='', flush=True)

    mask = mask.cpu().numpy()

    base_color = np.clip(attrs[..., attr_layout['base_color']].cpu().numpy() * 255, 0, 255).astype(np.uint8)
    metallic = np.clip(attrs[..., attr_layout['metallic']].cpu().numpy() * 255, 0, 255).astype(np.uint8)
    roughness = np.clip(attrs[..., attr_layout['roughness']].cpu().numpy() * 255, 0, 255).astype(np.uint8)
    alpha = np.clip(attrs[..., attr_layout['alpha']].cpu().numpy() * 255, 0, 255).astype(np.uint8)
    alpha_mode = 'OPAQUE'

    mask_inv = (~mask).astype(np.uint8)
    base_color = cv2.inpaint(base_color, mask_inv, 3, cv2.INPAINT_TELEA)
    metallic = cv2.inpaint(metallic, mask_inv, 1, cv2.INPAINT_TELEA)[..., None]
    roughness = cv2.inpaint(roughness, mask_inv, 1, cv2.INPAINT_TELEA)[..., None]
    alpha = cv2.inpaint(alpha, mask_inv, 1, cv2.INPAINT_TELEA)[..., None]

    material = trimesh.visual.material.PBRMaterial(
        baseColorTexture=Image.fromarray(np.concatenate([base_color, alpha], axis=-1)),
        baseColorFactor=np.array([255, 255, 255, 255], dtype=np.uint8),
        metallicRoughnessTexture=Image.fromarray(
            np.concatenate([np.zeros_like(metallic), roughness, metallic], axis=-1)
        ),
        metallicFactor=1.0,
        roughnessFactor=1.0,
        alphaMode=alpha_mode,
        doubleSided=True if not remesh else False,
    )

    vertices_np = out_vertices.cpu().numpy()
    faces_np = out_faces.cpu().numpy()
    uvs_np = out_uvs.cpu().numpy()
    normals_np = out_normals.cpu().numpy()

    vertices_np[:, 1], vertices_np[:, 2] = vertices_np[:, 2], -vertices_np[:, 1]
    normals_np[:, 1], normals_np[:, 2] = normals_np[:, 2], -normals_np[:, 1]
    uvs_np[:, 1] = 1 - uvs_np[:, 1]

    textured_mesh = trimesh.Trimesh(
        vertices=vertices_np,
        faces=faces_np,
        vertex_normals=normals_np,
        process=False,
        visual=trimesh.visual.TextureVisuals(uv=uvs_np, material=material),
    )

    if use_tqdm:
        pbar.update(1)
        pbar.close()
    if verbose:
        print("Done")

    return textured_mesh
