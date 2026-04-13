"""
FabMesh Procedural Animations
=============================
Generates CC0 (FabMesh-authored) idle / walk / run animation clips for any
skeleton described by a .bones.json file (humanoid_basic.bones.json etc.).

All output is authored by FabMesh and released under CC0 — safe for
commercial distribution. No external animation assets are used.

Usage:
    python procedural_anims.py <bones_json> <out_dir> [--fps 30]

Produces three GLB files containing a single skinned-skeleton animation
track each (no mesh): idle.glb, walk.glb, run.glb.
Also writes idle.json / walk.json / run.json with raw keyframe data so
auto_rig_bridge.py can consume them directly without pygltflib.

Public API:
    generate_idle_anim(bones_json, duration_frames=60, fps=30) -> dict
    generate_walk_anim(bones_json, duration_frames=40, fps=30) -> dict
    generate_run_anim (bones_json, duration_frames=20, fps=30) -> dict
    bake_anim_to_glb (anim_dict, bones_json, out_glb_path)

Each generator returns:
    {
        "name":   "idle" | "walk" | "run",
        "fps":    int,
        "duration_frames": int,
        "tracks": {
            bone_name: [
                { "frame": int, "rot": [x,y,z,w], "pos": [x,y,z] | null },
                ...
            ]
        }
    }

Rotations are quaternions (xyzw). Positions are only set for the Hips bone
(vertical bounce) to keep things simple.
"""

from __future__ import annotations

import json
import math
import os
import sys
from typing import Dict, List, Optional


# ---------------------------------------------------------------------------
# Quaternion helpers (no numpy dependency required for generation itself)
# ---------------------------------------------------------------------------

def _quat_from_euler(rx: float, ry: float, rz: float) -> List[float]:
    """ZYX intrinsic Euler (radians) -> quaternion [x,y,z,w]."""
    cx, sx = math.cos(rx * 0.5), math.sin(rx * 0.5)
    cy, sy = math.cos(ry * 0.5), math.sin(ry * 0.5)
    cz, sz = math.cos(rz * 0.5), math.sin(rz * 0.5)
    x = sx * cy * cz - cx * sy * sz
    y = cx * sy * cz + sx * cy * sz
    z = cx * cy * sz - sx * sy * cz
    w = cx * cy * cz + sx * sy * sz
    return [x, y, z, w]


def _identity_quat() -> List[float]:
    return [0.0, 0.0, 0.0, 1.0]


# ---------------------------------------------------------------------------
# Bone resolution (tolerant to naming variants)
# ---------------------------------------------------------------------------

_BONE_ALIASES = {
    "Hips":          ["Hips", "hips", "Pelvis", "pelvis", "Root_M"],
    "Spine":         ["Spine", "spine", "Spine_01", "spine_01"],
    "Spine1":        ["Spine1", "Spine_02", "spine1", "spine_02"],
    "Spine2":        ["Spine2", "Spine_03", "Chest", "chest", "spine_03"],
    "Neck":          ["Neck", "neck", "neck_01", "Neck_01"],
    "Head":          ["Head", "head"],
    "LeftShoulder":  ["LeftShoulder", "L_Shoulder", "Shoulder_L", "clavicle_l", "Clavicle_L"],
    "LeftArm":       ["LeftArm", "L_Arm", "UpperArm_L", "upperarm_l"],
    "LeftForeArm":   ["LeftForeArm", "L_ForeArm", "Forearm_L", "lowerarm_l", "LowerArm_L"],
    "LeftHand":      ["LeftHand", "L_Hand", "Hand_L", "hand_l"],
    "RightShoulder": ["RightShoulder", "R_Shoulder", "Shoulder_R", "clavicle_r", "Clavicle_R"],
    "RightArm":      ["RightArm", "R_Arm", "UpperArm_R", "upperarm_r"],
    "RightForeArm":  ["RightForeArm", "R_ForeArm", "Forearm_R", "lowerarm_r", "LowerArm_R"],
    "RightHand":     ["RightHand", "R_Hand", "Hand_R", "hand_r"],
    "LeftUpLeg":     ["LeftUpLeg", "L_UpLeg", "Thigh_L", "thigh_l"],
    "LeftLeg":       ["LeftLeg", "L_Leg", "Calf_L", "calf_l"],
    "LeftFoot":      ["LeftFoot", "L_Foot", "Foot_L", "foot_l"],
    "RightUpLeg":    ["RightUpLeg", "R_UpLeg", "Thigh_R", "thigh_r"],
    "RightLeg":      ["RightLeg", "R_Leg", "Calf_R", "calf_r"],
    "RightFoot":     ["RightFoot", "R_Foot", "Foot_R", "foot_r"],
}


def _resolve_bones(bones_json: dict) -> Dict[str, Optional[str]]:
    """Map canonical name -> actual bone name present in the skeleton."""
    present = {b["name"]: b["name"] for b in bones_json.get("bones", [])}
    out: Dict[str, Optional[str]] = {}
    for canonical, aliases in _BONE_ALIASES.items():
        hit = next((a for a in aliases if a in present), None)
        out[canonical] = hit
    return out


# ---------------------------------------------------------------------------
# Keyframe builder helpers
# ---------------------------------------------------------------------------

def _add_rot(tracks: Dict[str, List[dict]], bone: Optional[str],
             frame: int, rx: float, ry: float, rz: float) -> None:
    if not bone:
        return
    tracks.setdefault(bone, []).append({
        "frame": frame,
        "rot":   _quat_from_euler(rx, ry, rz),
        "pos":   None,
    })


def _add_pos(tracks: Dict[str, List[dict]], bone: Optional[str],
             frame: int, pos: List[float]) -> None:
    if not bone:
        return
    tracks.setdefault(bone, []).append({
        "frame": frame,
        "rot":   _identity_quat(),
        "pos":   pos,
    })


# ---------------------------------------------------------------------------
# IDLE: subtle breathing + slight head sway
# ---------------------------------------------------------------------------

def generate_idle_anim(bones_json: dict,
                       duration_frames: int = 60,
                       fps: int = 30) -> dict:
    b = _resolve_bones(bones_json)
    tracks: Dict[str, List[dict]] = {}

    for f in range(duration_frames + 1):
        t = (f / duration_frames) * 2.0 * math.pi  # one breath cycle
        breathe = math.sin(t) * math.radians(2.5)  # +-2.5 deg on chest
        head_sway = math.sin(t * 0.5) * math.radians(1.5)
        hip_bob = 0.005 * math.sin(t * 2.0)        # 5 mm vertical bob

        _add_rot(tracks, b["Spine1"], f,  breathe,       0.0, 0.0)
        _add_rot(tracks, b["Spine2"], f,  breathe * 0.5, 0.0, 0.0)
        _add_rot(tracks, b["Head"],   f,  0.0, head_sway, 0.0)

        # Slight arm relaxation (arms hang down-ish)
        arm_swing = math.sin(t) * math.radians(1.0)
        _add_rot(tracks, b["LeftArm"],  f, 0.0, 0.0,  arm_swing)
        _add_rot(tracks, b["RightArm"], f, 0.0, 0.0, -arm_swing)

        _add_pos(tracks, b["Hips"], f, [0.0, 0.0, hip_bob])

    return {
        "name": "idle",
        "fps": fps,
        "duration_frames": duration_frames,
        "tracks": tracks,
    }


# ---------------------------------------------------------------------------
# WALK: alternating legs + counter-swing arms
# ---------------------------------------------------------------------------

def generate_walk_anim(bones_json: dict,
                       duration_frames: int = 40,
                       fps: int = 30) -> dict:
    b = _resolve_bones(bones_json)
    tracks: Dict[str, List[dict]] = {}

    leg_amp    = math.radians(25)
    knee_amp   = math.radians(35)
    arm_amp    = math.radians(30)
    elbow_amp  = math.radians(20)

    for f in range(duration_frames + 1):
        phase = (f / duration_frames) * 2.0 * math.pi
        # Legs in opposition
        l_thigh =  math.sin(phase)          * leg_amp
        r_thigh =  math.sin(phase + math.pi) * leg_amp
        l_knee  = max(0.0, math.sin(phase + math.pi * 0.5)) * knee_amp
        r_knee  = max(0.0, math.sin(phase + math.pi * 1.5)) * knee_amp

        _add_rot(tracks, b["LeftUpLeg"],  f, l_thigh, 0.0, 0.0)
        _add_rot(tracks, b["RightUpLeg"], f, r_thigh, 0.0, 0.0)
        _add_rot(tracks, b["LeftLeg"],    f, -l_knee, 0.0, 0.0)
        _add_rot(tracks, b["RightLeg"],   f, -r_knee, 0.0, 0.0)

        # Arms counter-swing
        l_arm =  math.sin(phase + math.pi) * arm_amp
        r_arm =  math.sin(phase)           * arm_amp
        l_elb = max(0.0, math.sin(phase))           * elbow_amp
        r_elb = max(0.0, math.sin(phase + math.pi)) * elbow_amp

        _add_rot(tracks, b["LeftArm"],      f, l_arm, 0.0, 0.0)
        _add_rot(tracks, b["RightArm"],     f, r_arm, 0.0, 0.0)
        _add_rot(tracks, b["LeftForeArm"],  f, -l_elb, 0.0, 0.0)
        _add_rot(tracks, b["RightForeArm"], f, -r_elb, 0.0, 0.0)

        # Torso twist + vertical bob (double frequency)
        _add_rot(tracks, b["Spine"],  f, 0.0, 0.0, math.sin(phase) * math.radians(4))
        _add_rot(tracks, b["Spine2"], f, 0.0, 0.0, -math.sin(phase) * math.radians(3))

        hip_bob = 0.03 * abs(math.sin(phase * 2))  # 3 cm bounce
        _add_pos(tracks, b["Hips"], f, [0.0, 0.0, hip_bob])

    return {
        "name": "walk",
        "fps": fps,
        "duration_frames": duration_frames,
        "tracks": tracks,
    }


# ---------------------------------------------------------------------------
# RUN: faster, larger amplitudes, forward lean
# ---------------------------------------------------------------------------

def generate_run_anim(bones_json: dict,
                      duration_frames: int = 20,
                      fps: int = 30) -> dict:
    b = _resolve_bones(bones_json)
    tracks: Dict[str, List[dict]] = {}

    leg_amp    = math.radians(55)
    knee_amp   = math.radians(85)
    arm_amp    = math.radians(70)
    elbow_amp  = math.radians(75)
    lean       = math.radians(12)  # forward lean on spine

    for f in range(duration_frames + 1):
        phase = (f / duration_frames) * 2.0 * math.pi

        l_thigh =  math.sin(phase)           * leg_amp
        r_thigh =  math.sin(phase + math.pi) * leg_amp
        l_knee  = max(0.0, math.sin(phase + math.pi * 0.5)) * knee_amp + math.radians(15)
        r_knee  = max(0.0, math.sin(phase + math.pi * 1.5)) * knee_amp + math.radians(15)

        _add_rot(tracks, b["LeftUpLeg"],  f, l_thigh, 0.0, 0.0)
        _add_rot(tracks, b["RightUpLeg"], f, r_thigh, 0.0, 0.0)
        _add_rot(tracks, b["LeftLeg"],    f, -l_knee, 0.0, 0.0)
        _add_rot(tracks, b["RightLeg"],   f, -r_knee, 0.0, 0.0)

        l_arm =  math.sin(phase + math.pi) * arm_amp
        r_arm =  math.sin(phase)           * arm_amp

        _add_rot(tracks, b["LeftArm"],      f, l_arm, 0.0, 0.0)
        _add_rot(tracks, b["RightArm"],     f, r_arm, 0.0, 0.0)
        _add_rot(tracks, b["LeftForeArm"],  f, -elbow_amp, 0.0, 0.0)
        _add_rot(tracks, b["RightForeArm"], f, -elbow_amp, 0.0, 0.0)

        _add_rot(tracks, b["Spine"],  f, lean, 0.0, math.sin(phase) * math.radians(6))
        _add_rot(tracks, b["Spine2"], f, lean * 0.5, 0.0, -math.sin(phase) * math.radians(4))

        hip_bob = 0.06 * abs(math.sin(phase * 2))
        _add_pos(tracks, b["Hips"], f, [0.0, 0.0, hip_bob])

    return {
        "name": "run",
        "fps": fps,
        "duration_frames": duration_frames,
        "tracks": tracks,
    }


# ---------------------------------------------------------------------------
# Optional: bake to GLB (requires pygltflib + numpy)
# ---------------------------------------------------------------------------

def bake_anim_to_glb(anim: dict, bones_json: dict, out_glb_path: str) -> bool:
    """
    Bakes a generated anim into a minimal GLB containing only a skeleton and
    its animation track (no mesh). Requires pygltflib + numpy. Returns True
    on success, False if dependencies missing.
    """
    try:
        import numpy as np
        import pygltflib
        from pygltflib import (
            GLTF2, Node, Scene, Skin, Animation, AnimationChannel,
            AnimationChannelTarget, AnimationSampler, Buffer, BufferView,
            Accessor, ANIM_LINEAR,
        )
    except ImportError as e:
        print(f"procedural_anims: bake_anim_to_glb skipped ({e})", flush=True)
        return False

    bones = bones_json["bones"]
    name_to_idx = {b["name"]: i for i, b in enumerate(bones)}

    nodes: List[Node] = []
    for b in bones:
        nodes.append(Node(
            name=b["name"],
            translation=b["head"],
            rotation=[0.0, 0.0, 0.0, 1.0],
        ))
    for i, b in enumerate(bones):
        parent = b.get("parent")
        if parent and parent in name_to_idx:
            p = name_to_idx[parent]
            if nodes[p].children is None:
                nodes[p].children = []
            nodes[p].children.append(i)

    # Build animation buffers
    fps = anim["fps"]
    inputs: List[float] = []
    per_bone_rot: Dict[int, List[List[float]]] = {}
    per_bone_pos: Dict[int, List[List[float]]] = {}

    frames_set = sorted({k["frame"] for track in anim["tracks"].values() for k in track})
    for f in frames_set:
        inputs.append(f / fps)

    for bone_name, keys in anim["tracks"].items():
        idx = name_to_idx.get(bone_name)
        if idx is None:
            continue
        key_by_frame = {k["frame"]: k for k in keys}
        rot_list: List[List[float]] = []
        pos_list: List[List[float]] = []
        for f in frames_set:
            k = key_by_frame.get(f)
            rot_list.append(k["rot"] if k else [0.0, 0.0, 0.0, 1.0])
            if k and k["pos"] is not None:
                base = bones[idx]["head"]
                pos_list.append([base[0] + k["pos"][0],
                                 base[1] + k["pos"][1],
                                 base[2] + k["pos"][2]])
            else:
                pos_list.append(list(bones[idx]["head"]))
        per_bone_rot[idx] = rot_list
        per_bone_pos[idx] = pos_list

    # Pack binary blob
    blob = bytearray()
    buffer_views: List[BufferView] = []
    accessors: List[Accessor] = []

    def add_accessor(arr: "np.ndarray", component_type: int, type_str: str) -> int:
        data = arr.astype("<f4").tobytes()
        offset = len(blob)
        blob.extend(data)
        # pad to 4
        while len(blob) % 4:
            blob.append(0)
        bv = BufferView(buffer=0, byteOffset=offset, byteLength=len(data))
        buffer_views.append(bv)
        acc = Accessor(
            bufferView=len(buffer_views) - 1,
            componentType=component_type,
            count=arr.shape[0],
            type=type_str,
            max=arr.max(axis=0).tolist() if arr.ndim > 1 else [float(arr.max())],
            min=arr.min(axis=0).tolist() if arr.ndim > 1 else [float(arr.min())],
        )
        accessors.append(acc)
        return len(accessors) - 1

    FLOAT = 5126
    inputs_np = np.array(inputs, dtype="<f4").reshape(-1)
    input_acc = add_accessor(inputs_np, FLOAT, "SCALAR")

    channels: List[AnimationChannel] = []
    samplers: List[AnimationSampler] = []

    for idx, rots in per_bone_rot.items():
        rot_np = np.array(rots, dtype="<f4")
        rot_acc = add_accessor(rot_np, FLOAT, "VEC4")
        samplers.append(AnimationSampler(
            input=input_acc, output=rot_acc, interpolation=ANIM_LINEAR))
        channels.append(AnimationChannel(
            sampler=len(samplers) - 1,
            target=AnimationChannelTarget(node=idx, path="rotation"),
        ))

        pos_np = np.array(per_bone_pos[idx], dtype="<f4")
        pos_acc = add_accessor(pos_np, FLOAT, "VEC3")
        samplers.append(AnimationSampler(
            input=input_acc, output=pos_acc, interpolation=ANIM_LINEAR))
        channels.append(AnimationChannel(
            sampler=len(samplers) - 1,
            target=AnimationChannelTarget(node=idx, path="translation"),
        ))

    gltf = GLTF2()
    gltf.scenes = [Scene(nodes=[i for i, b in enumerate(bones) if b.get("parent") is None])]
    gltf.scene = 0
    gltf.nodes = nodes
    gltf.bufferViews = buffer_views
    gltf.accessors = accessors
    gltf.animations = [Animation(name=anim["name"], channels=channels, samplers=samplers)]
    gltf.buffers = [Buffer(byteLength=len(blob))]
    gltf.set_binary_blob(bytes(blob))
    gltf.save_binary(out_glb_path)
    return True


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: List[str]) -> int:
    if len(argv) < 3:
        print("Usage: python procedural_anims.py <bones_json> <out_dir> [--fps N]")
        return 1

    bones_path = argv[1]
    out_dir    = argv[2]
    fps = 30
    if "--fps" in argv:
        fps = int(argv[argv.index("--fps") + 1])

    os.makedirs(out_dir, exist_ok=True)
    with open(bones_path, "r", encoding="utf-8") as f:
        bones_json = json.load(f)

    clips = {
        "idle": generate_idle_anim(bones_json, fps=fps),
        "walk": generate_walk_anim(bones_json, fps=fps),
        "run":  generate_run_anim(bones_json,  fps=fps),
    }

    for name, clip in clips.items():
        j = os.path.join(out_dir, f"{name}.json")
        with open(j, "w", encoding="utf-8") as f:
            json.dump(clip, f, indent=2)
        print(f"procedural_anims: wrote {j}", flush=True)

        glb = os.path.join(out_dir, f"{name}.glb")
        ok = bake_anim_to_glb(clip, bones_json, glb)
        if ok:
            print(f"procedural_anims: baked {glb}", flush=True)
        else:
            print(f"procedural_anims: GLB bake skipped for {name} (install pygltflib + numpy)",
                  flush=True)

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
