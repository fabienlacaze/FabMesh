"""Post-process Puppeteer animation output (.tgz) into a game-ready GLB.

Input:
  - Source rigged GLB (the mesh + skeleton that was sent to Puppeteer)
  - Puppeteer .tgz containing raw/local_quats.pt, raw/root_quats.pt, raw/root_pos.pt

Output:
  - A new GLB with a single AnimationClip baked from the optimized motion.
  - Unity/Unreal/three.js can load it directly.

Usage:
  python scripts/puppeteer_anim_to_glb.py \
      --rig-glb c:/tmp/dragon_rig_lowpoly.glb \
      --anim-tgz c:/tmp/dragon_walk_quick.tgz \
      --output c:/tmp/dragon_walk_final.glb \
      --fps 10 \
      --clip-name walk

License: MIT (FabMesh proprietary).
"""
from __future__ import annotations

import argparse
import io
import json
import os
import struct
import sys
import tarfile
from typing import Tuple

import numpy as np
import torch
from pygltflib import (
    GLTF2, Animation, AnimationChannel, AnimationChannelTarget, AnimationSampler,
    Accessor, BufferView, Buffer,
)


def load_anim_tensors(tgz_path: str) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    """Extract per-frame joint rotations + root from Puppeteer .tgz."""
    local_quats = None
    root_quats = None
    root_pos = None
    with tarfile.open(tgz_path, "r:gz") as tar:
        for member in tar.getmembers():
            name = os.path.basename(member.name)
            if name in ("local_quats.pt", "root_quats.pt", "root_pos.pt"):
                f = tar.extractfile(member)
                buf = io.BytesIO(f.read())
                tensor = torch.load(buf, map_location="cpu", weights_only=False)
                if name == "local_quats.pt":
                    local_quats = tensor
                elif name == "root_quats.pt":
                    root_quats = tensor
                elif name == "root_pos.pt":
                    root_pos = tensor

    if local_quats is None:
        raise RuntimeError(f"local_quats.pt not found in {tgz_path}")
    print(f"[load] local_quats shape: {tuple(local_quats.shape)}")
    if root_quats is not None:
        print(f"[load] root_quats shape: {tuple(root_quats.shape)}")
    if root_pos is not None:
        print(f"[load] root_pos shape: {tuple(root_pos.shape)}")
    return local_quats, root_quats, root_pos


def find_skin_root(gltf: GLTF2) -> Tuple[int, list[int]]:
    """Return (root_joint_node_id, joints_list) from the first skin.

    The root is the joint whose parent is NOT another joint.
    """
    if not gltf.skins:
        raise RuntimeError("GLB has no skin")
    skin = gltf.skins[0]
    joints = list(skin.joints)

    # Find parent: scan all nodes, look for those that list joints as children
    joint_set = set(joints)
    parent_of = {j: -1 for j in joints}
    for node_idx, node in enumerate(gltf.nodes):
        for child in (node.children or []):
            if child in joint_set:
                # Mark parent if it's also a joint
                if node_idx in joint_set:
                    parent_of[child] = node_idx
    # Root = joint with no joint-parent
    roots = [j for j in joints if parent_of[j] == -1]
    if len(roots) != 1:
        print(f"[warn] Found {len(roots)} root joints, using first: {roots[0]}")
    return roots[0], joints


def quat_xyzw_to_wxyz(q: np.ndarray) -> np.ndarray:
    """Convert (...,4) xyzw quat to wxyz."""
    return np.stack([q[..., 3], q[..., 0], q[..., 1], q[..., 2]], axis=-1)


def quat_wxyz_to_xyzw(q: np.ndarray) -> np.ndarray:
    """Convert (...,4) wxyz quat to xyzw (glTF format)."""
    return np.stack([q[..., 1], q[..., 2], q[..., 3], q[..., 0]], axis=-1)


def add_accessor(gltf: GLTF2, bin_data: bytearray, raw: np.ndarray,
                 acc_type: str, comp_type: int = 5126) -> int:
    """Append `raw` bytes to bin_data, create bufferView + accessor."""
    payload = raw.tobytes()
    if len(payload) % 4 != 0:
        # Pad to 4 bytes
        payload += b"\x00" * (4 - len(payload) % 4)
    offset = len(bin_data)
    bin_data.extend(payload)
    bv = BufferView(buffer=0, byteOffset=offset, byteLength=len(payload))
    gltf.bufferViews.append(bv)
    bv_idx = len(gltf.bufferViews) - 1

    if acc_type == "SCALAR":
        count = len(raw)
        type_size = 1
    elif acc_type == "VEC3":
        count = raw.shape[0]
        type_size = 3
    elif acc_type == "VEC4":
        count = raw.shape[0]
        type_size = 4
    else:
        raise ValueError(acc_type)

    acc = Accessor(
        bufferView=bv_idx,
        componentType=comp_type,
        count=count,
        type=acc_type,
        min=raw.min(axis=0).tolist() if raw.ndim > 1 else [float(raw.min())],
        max=raw.max(axis=0).tolist() if raw.ndim > 1 else [float(raw.max())],
    )
    gltf.accessors.append(acc)
    return len(gltf.accessors) - 1


def bake_animation_into_glb(
    rig_glb_path: str,
    local_quats: torch.Tensor,
    root_quats: torch.Tensor | None,
    root_pos: torch.Tensor | None,
    fps: float,
    clip_name: str,
    out_path: str,
) -> None:
    """Apply per-frame quats from Puppeteer to the GLB skeleton.

    local_quats expected shape: [F, J, 4] in (w,x,y,z) or (x,y,z,w) — we
    auto-detect by checking which channel has values closer to 1 in rest.
    root_quats:  [F, 4]
    root_pos:    [F, 3]
    """
    gltf = GLTF2().load(rig_glb_path)
    root_node, joints = find_skin_root(gltf)
    print(f"[bake] root joint node = {root_node}, total joints = {len(joints)}")

    # Decode quats
    if hasattr(local_quats, "detach"):
        local_quats = local_quats.detach().cpu().numpy()
    F = local_quats.shape[0]
    J = local_quats.shape[1] if local_quats.ndim > 2 else len(joints)
    print(f"[bake] {F} frames, {J} joints (rig has {len(joints)})")

    if J != len(joints):
        print(f"[warn] joint count mismatch — anim has {J}, rig has {len(joints)}")
        # Use whatever's smaller
        J = min(J, len(joints))

    # Detect quat convention. If frame 0 is roughly identity, the w should be ~1
    # In wxyz, identity = [1,0,0,0]. In xyzw, identity = [0,0,0,1].
    q0 = local_quats[0]  # (J, 4)
    if abs(q0[0, 0]) > abs(q0[0, 3]):
        # Higher abs value at index 0 → wxyz
        local_quats_xyzw = quat_wxyz_to_xyzw(local_quats)
        print("[bake] detected wxyz, converted to xyzw")
    else:
        local_quats_xyzw = local_quats
        print("[bake] detected xyzw, no conversion")

    # Read existing binary blob to extend it for animation data
    # pygltflib stores binary as gltf.binary_blob() — but we need a writable extension.
    # Easier: just write everything anew via set_binary_blob.
    bin_data = bytearray(gltf.binary_blob())

    # Timeline (input accessor) — shared by all channels
    times = (np.arange(F, dtype=np.float32) / fps).astype("<f4")
    times_acc = add_accessor(gltf, bin_data, times, "SCALAR")

    # Build animation
    anim = Animation(name=clip_name)
    anim.samplers = []
    anim.channels = []

    for j_idx in range(J):
        target_node = joints[j_idx]
        # Output accessor: per-frame xyzw quat
        quats = local_quats_xyzw[:, j_idx, :].astype("<f4")
        out_acc = add_accessor(gltf, bin_data, quats, "VEC4")

        samp = AnimationSampler(input=times_acc, output=out_acc, interpolation="LINEAR")
        anim.samplers.append(samp)
        s_idx = len(anim.samplers) - 1

        ch = AnimationChannel(
            sampler=s_idx,
            target=AnimationChannelTarget(node=target_node, path="rotation"),
        )
        anim.channels.append(ch)

    # Add root translation channel if provided
    if root_pos is not None:
        if hasattr(root_pos, "detach"):
            root_pos = root_pos.detach().cpu().numpy()
        root_pos_xyz = root_pos[:F].astype("<f4")
        # Convert to glTF Y-up if Puppeteer is Y-up too (assume yes)
        out_acc = add_accessor(gltf, bin_data, root_pos_xyz, "VEC3")
        samp = AnimationSampler(input=times_acc, output=out_acc, interpolation="LINEAR")
        anim.samplers.append(samp)
        s_idx = len(anim.samplers) - 1
        ch = AnimationChannel(
            sampler=s_idx,
            target=AnimationChannelTarget(node=root_node, path="translation"),
        )
        anim.channels.append(ch)
        print(f"[bake] added root translation channel ({F} frames)")

    gltf.animations.append(anim)

    # Update buffer size
    if not gltf.buffers:
        gltf.buffers = [Buffer(byteLength=len(bin_data))]
    else:
        gltf.buffers[0].byteLength = len(bin_data)

    # Save
    gltf.set_binary_blob(bytes(bin_data))
    gltf.save(out_path)
    print(f"[bake] wrote {out_path} ({os.path.getsize(out_path)/1e6:.1f} MB)")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--rig-glb", required=True, help="Input rigged GLB (mesh+skin)")
    p.add_argument("--anim-tgz", required=True, help="Puppeteer .tgz with raw/*.pt")
    p.add_argument("--output", required=True, help="Output animated GLB path")
    p.add_argument("--fps", type=float, default=10.0, help="Anim fps (default 10)")
    p.add_argument("--clip-name", default="anim", help="Animation clip name")
    args = p.parse_args()

    local_q, root_q, root_p = load_anim_tensors(args.anim_tgz)
    bake_animation_into_glb(
        args.rig_glb, local_q, root_q, root_p,
        args.fps, args.clip_name, args.output,
    )


if __name__ == "__main__":
    main()
