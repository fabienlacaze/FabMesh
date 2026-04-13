"""
FabMesh - Bake procedural animations into an existing rigged GLB
================================================================
Post-processing step used by the auto-rig-ai pipeline:

    python bake_procedural_anims.py <input.glb> <bones.json> <output.glb>

Loads a rigged GLB produced by swap_skeleton.py (mesh + skin + nodes already
match <bones.json>), generates Idle / Walk / Run keyframe clips via
procedural_anims.py, and appends them as three additional animation tracks
in the GLB (so a Three.js viewer can expose them in an anim dropdown).

All animations are CC0 (FabMesh-authored) - safe for commercial distribution.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Dict, List

# Local imports (same scripts dir)
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)

import procedural_anims  # noqa: E402


def _log(msg: str) -> None:
    print(f"bake_procedural_anims: {msg}", flush=True)


def _find_node_index_by_name(gltf, name: str):
    for i, node in enumerate(gltf.nodes or []):
        if getattr(node, "name", None) == name:
            return i
    return None


def _append_animation(gltf, blob: bytearray, anim: dict,
                      bones_json: dict) -> bool:
    """Append one procedural animation clip to the given GLTF2 object.

    Writes new bufferViews + accessors into the shared binary blob and
    appends a new Animation object. Returns True if anything was added.
    """
    import numpy as np
    from pygltflib import (
        Animation, AnimationChannel, AnimationChannelTarget,
        AnimationSampler, BufferView, Accessor, ANIM_LINEAR,
    )

    FLOAT = 5126

    # Resolve bone name -> node index in the actual GLB (not the bones_json
    # order) so we don't rely on swap_skeleton preserving index parity.
    tracks = anim.get("tracks") or {}
    if not tracks:
        _log(f"clip '{anim.get('name')}' has no tracks; skipped")
        return False

    # Pre-compute common input (time) accessor
    fps = anim.get("fps", 30)
    frames_set = sorted(
        {k["frame"] for track in tracks.values() for k in track}
    )
    if not frames_set:
        _log(f"clip '{anim.get('name')}' has no frames; skipped")
        return False

    # --- helper to append a typed accessor to the blob ---
    def add_accessor(arr, type_str: str) -> int:
        data = arr.astype("<f4").tobytes()
        # align to 4 bytes
        while len(blob) % 4:
            blob.append(0)
        offset = len(blob)
        blob.extend(data)
        bv = BufferView(
            buffer=0, byteOffset=offset, byteLength=len(data),
        )
        gltf.bufferViews.append(bv)
        bv_idx = len(gltf.bufferViews) - 1
        acc = Accessor(
            bufferView=bv_idx,
            componentType=FLOAT,
            count=int(arr.shape[0]),
            type=type_str,
            max=arr.max(axis=0).tolist() if arr.ndim > 1 else [float(arr.max())],
            min=arr.min(axis=0).tolist() if arr.ndim > 1 else [float(arr.min())],
        )
        gltf.accessors.append(acc)
        return len(gltf.accessors) - 1

    inputs_np = np.array([f / fps for f in frames_set], dtype="<f4")
    input_acc = add_accessor(inputs_np, "SCALAR")

    # Bones JSON -> base positions (for pos offsets)
    base_pos_by_name = {b["name"]: b["head"] for b in bones_json.get("bones", [])}

    samplers: List[AnimationSampler] = []
    channels: List[AnimationChannel] = []

    added_any = False
    missing: List[str] = []

    for bone_name, keys in tracks.items():
        node_idx = _find_node_index_by_name(gltf, bone_name)
        if node_idx is None:
            missing.append(bone_name)
            continue

        key_by_frame = {k["frame"]: k for k in keys}
        rot_list: List[List[float]] = []
        pos_list: List[List[float]] = []
        base = base_pos_by_name.get(bone_name, [0.0, 0.0, 0.0])
        has_pos = False
        for f in frames_set:
            k = key_by_frame.get(f)
            rot_list.append(k["rot"] if k else [0.0, 0.0, 0.0, 1.0])
            if k and k.get("pos") is not None:
                pos_list.append([
                    base[0] + k["pos"][0],
                    base[1] + k["pos"][1],
                    base[2] + k["pos"][2],
                ])
                has_pos = True
            else:
                pos_list.append([base[0], base[1], base[2]])

        rot_np = np.array(rot_list, dtype="<f4")
        rot_acc = add_accessor(rot_np, "VEC4")
        samplers.append(AnimationSampler(
            input=input_acc, output=rot_acc, interpolation=ANIM_LINEAR))
        channels.append(AnimationChannel(
            sampler=len(samplers) - 1,
            target=AnimationChannelTarget(node=node_idx, path="rotation"),
        ))

        if has_pos:
            pos_np = np.array(pos_list, dtype="<f4")
            pos_acc = add_accessor(pos_np, "VEC3")
            samplers.append(AnimationSampler(
                input=input_acc, output=pos_acc, interpolation=ANIM_LINEAR))
            channels.append(AnimationChannel(
                sampler=len(samplers) - 1,
                target=AnimationChannelTarget(node=node_idx, path="translation"),
            ))

        added_any = True

    if missing:
        _log(
            f"clip '{anim.get('name')}': {len(missing)} bone(s) not found in "
            f"GLB (first: {missing[:3]})"
        )

    if not added_any:
        return False

    if gltf.animations is None:
        gltf.animations = []
    gltf.animations.append(Animation(
        name=anim["name"], channels=channels, samplers=samplers,
    ))
    return True


def bake(input_glb: str, bones_path: str, output_glb: str) -> int:
    if not os.path.exists(input_glb):
        _log(f"ERROR input not found: {input_glb}")
        return 2
    if not os.path.exists(bones_path):
        _log(f"ERROR bones json not found: {bones_path}")
        return 2

    try:
        import numpy as np  # noqa: F401
        from pygltflib import GLTF2, Buffer
    except ImportError as e:
        _log(f"ERROR missing dependency: {e} (need pygltflib + numpy)")
        return 3

    with open(bones_path, "r", encoding="utf-8") as f:
        bones_json = json.load(f)

    _log(f"loading {input_glb}")
    gltf = GLTF2().load(input_glb)
    if gltf is None:
        _log("ERROR pygltflib failed to load input GLB")
        return 4

    # Ensure lists exist
    if gltf.bufferViews is None:
        gltf.bufferViews = []
    if gltf.accessors is None:
        gltf.accessors = []
    if gltf.animations is None:
        gltf.animations = []

    # Pull existing binary blob into a mutable bytearray
    existing_blob = gltf.binary_blob() or b""
    blob = bytearray(existing_blob)

    clips = {
        "Idle": procedural_anims.generate_idle_anim(bones_json),
        "Walk": procedural_anims.generate_walk_anim(bones_json),
        "Run":  procedural_anims.generate_run_anim(bones_json),
    }

    added = 0
    for name, clip in clips.items():
        clip["name"] = name
        if _append_animation(gltf, blob, clip, bones_json):
            added += 1
            _log(f"appended animation '{name}'")
        else:
            _log(f"animation '{name}' NOT appended")

    if added == 0:
        _log("WARNING no animations were added; writing unchanged copy")

    # Update single-buffer length and re-pack binary blob
    if gltf.buffers is None or len(gltf.buffers) == 0:
        gltf.buffers = [Buffer(byteLength=len(blob))]
    else:
        gltf.buffers[0].byteLength = len(blob)
        # Drop any external URI so set_binary_blob takes effect
        gltf.buffers[0].uri = None

    gltf.set_binary_blob(bytes(blob))

    os.makedirs(os.path.dirname(os.path.abspath(output_glb)) or ".", exist_ok=True)
    gltf.save_binary(output_glb)
    _log(f"wrote {output_glb} ({added} clip(s) baked)")
    return 0


def main(argv: List[str]) -> int:
    if len(argv) < 4:
        print(
            "Usage: python bake_procedural_anims.py <input.glb> <bones.json> "
            "<output.glb>",
            flush=True,
        )
        return 1
    return bake(argv[1], argv[2], argv[3])


if __name__ == "__main__":
    sys.exit(main(sys.argv))
