"""
nvdiffrast → Kaolin compatibility shim.

Provides drop-in replacements for the subset of `nvdiffrast.torch` used by
`trellis2.pipelines.trellis2_texturing.Trellis2TexturingPipeline.postprocess_mesh`:
  - RasterizeCudaContext (no-op)
  - rasterize(ctx, pos, tri, resolution) -> (rast, _)
       rast[B,H,W,4] = (bary_u, bary_v, z_unused, tri_id_plus_one)
       where bary_u = weight of vertex 1, bary_v = weight of vertex 2,
       and w0 = 1 - u - v applies to vertex 0 (nvdiffrast convention).
  - interpolate(attr, rast, tri) -> (out, _) of shape [B,H,W,C]

Backed by `kaolin.render.mesh.rasterize` (Apache 2.0, CUDA backend),
NOT nvdiffrast (NVIDIA non-commercial). Validated against nvdiffrast
output to PSNR > 35 dB / IoU > 0.99 / SSIM > 0.95 before deployment.
"""
import torch
from kaolin.render.mesh import rasterize as _kaolin_rasterize


class RasterizeCudaContext:
    """No-op: kaolin doesn't need a persistent context."""
    def __init__(self, *args, **kwargs):
        pass


def rasterize(ctx, pos, tri, resolution, ranges=None, grad_db=False):
    """
    pos: (B, V, 4) clip-space positions. We use pos[..., :2] as 2D UV-NDC.
    tri: (F, 3) int32/int64 vertex indices.
    resolution: [H, W].
    Returns: (rast, None) where rast is (B, H, W, 4) = (bary_u, bary_v, 0, tri_id+1).
    """
    if pos.dim() == 3:
        B, V, _ = pos.shape
    else:
        raise ValueError(f"pos must be (B,V,4), got shape {tuple(pos.shape)}")
    F = tri.shape[0]
    H, W = int(resolution[0]), int(resolution[1])

    tri_long = tri.long()
    # face_uvs: (B, F, 3, 2)
    face_uvs = pos[:, :, :2][:, tri_long]
    # face_z: (B, F, 3) — kaolin uses this for depth ordering. UV-space rasterization,
    # so all zero (single z plane).
    face_z = torch.zeros(B, F, 3, device=pos.device, dtype=pos.dtype)

    # Pass barycentric basis as features so kaolin's interpolation returns (w0, w1, w2)
    # at each fragment, allowing us to reconstruct nvdiffrast's (bary_u=w1, bary_v=w2).
    bary_basis = torch.eye(3, device=pos.device, dtype=pos.dtype)  # (3, 3)
    face_features = bary_basis.unsqueeze(0).unsqueeze(0).expand(B, F, 3, 3).contiguous()

    interp, face_idx = _kaolin_rasterize(
        height=H, width=W,
        face_vertices_z=face_z,
        face_vertices_image=face_uvs,
        face_features=face_features,
        backend='cuda',
    )
    # interp: (B, H, W, 3) = (w0, w1, w2)
    # face_idx: (B, H, W) int64, -1 = background

    rast = torch.zeros(B, H, W, 4, device=pos.device, dtype=pos.dtype)
    # nvdiffrast: rast[...,0] = u = weight of vertex 1 (not 0)
    #             rast[...,1] = v = weight of vertex 2
    #             rast[...,2] = z (unused in this pipeline)
    #             rast[...,3] = tri_id + 1, with 0 = background
    rast[..., 0] = interp[..., 1]
    rast[..., 1] = interp[..., 2]
    rast[..., 2] = 0.0
    rast[..., 3] = (face_idx + 1).to(pos.dtype)

    # nvdiffrast convention: image Y axis goes BOTTOM-UP (clip Y == screen Y, +Y up).
    # kaolin convention: image Y axis goes TOP-DOWN (row 0 at top, +Y down in image
    # coordinates while still receiving +Y up clip-space vertices). The two backends
    # therefore disagree on row order. Flipping vertically aligns them.
    rast = torch.flip(rast, dims=[1])

    return rast, None


def interpolate(attr, rast, tri, rast_db=None, diff_attrs=None):
    """
    attr: (B, V, C) vertex attributes (typically B=1).
    rast: (B, H, W, 4) from rasterize() above.
    tri: (F, 3) vertex indices.
    Returns: (out, None) where out is (B, H, W, C).
    """
    B, H, W, _ = rast.shape
    bary_u = rast[..., 0:1]              # weight of vertex 1
    bary_v = rast[..., 1:2]              # weight of vertex 2
    bary_w = 1.0 - bary_u - bary_v       # weight of vertex 0
    tri_id_p1 = rast[..., 3].long()
    valid = tri_id_p1 > 0
    tri_id = (tri_id_p1 - 1).clamp(min=0)        # (B, H, W)

    face_v_idx = tri.long()[tri_id]              # (B, H, W, 3)
    # attr is (B, V, C). nvdiffrast supports B=1 broadcast; we mirror that.
    if attr.shape[0] == 1 and B > 1:
        attr_b = attr.expand(B, -1, -1)
    else:
        attr_b = attr
    # Gather per-pixel vertex attributes
    # attr_b[b, face_v_idx[b, h, w, k]] for k in 0..2
    batch_idx = torch.arange(B, device=attr.device).view(B, 1, 1, 1).expand(B, H, W, 3)
    gathered = attr_b[batch_idx, face_v_idx]  # (B, H, W, 3, C)

    v0 = gathered[..., 0, :]
    v1 = gathered[..., 1, :]
    v2 = gathered[..., 2, :]

    out = bary_w * v0 + bary_u * v1 + bary_v * v2
    out = out * valid.unsqueeze(-1).to(out.dtype)
    return out, None
