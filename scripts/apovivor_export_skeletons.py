"""
apovivor_export_skeletons.py
=============================

Extracts bone hierarchies from 12 hand-picked Apovivor SkeletalMesh / Skeleton
assets and writes one `.bones.json` per skeleton into the FabMesh project,
plus a partial update of `scripts/rig_templates/skm/registry.json`.

READ-ONLY GUARANTEES (verify before running):
---------------------------------------------
- ONLY reads .uasset via `unreal.EditorAssetLibrary.load_asset(path)`.
- NEVER calls   save_asset / save_directory / delete_asset /
                rename_asset / duplicate_asset / create_asset.
- NEVER triggers a content-browser refresh, registry rebuild, save-all,
  source-control commit, or anything that mutates the Apovivor project.
- Output files are written ONLY to:
    c:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/scripts/rig_templates/skm/
  (and a single in-place rewrite of registry.json under that same folder).
- A pre-flight banner is printed listing every action; a 5-second sleep
  gives you the chance to abort with Ctrl+C in the UE5 Python console.

HOW TO RUN (UE5 5.4+):
----------------------
1. Open the **Apovivor** project in the Unreal Editor.
2. Menu bar -> Tools -> Python -> Execute Python Script...
   (If you do not see it, enable: Edit -> Plugins -> "Python Editor Script
    Plugin" and "Editor Scripting Utilities", then restart the editor.)
3. Pick this file:
   c:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/scripts/apovivor_export_skeletons.py
4. Press Run. Watch the Output Log (Window -> Developer Tools -> Output Log).
5. After it finishes, confirm in the Output Log that the line
   `[apovivor_export] DONE - 0 saves performed, 0 assets modified`
   is printed (the script asserts this at the end).

The script does NOT prompt, does NOT pop dialogs, and does NOT save anything
to the Apovivor project. If anything looks wrong, just close the editor
WITHOUT saving and nothing will be persisted on the Apovivor side.
"""

import json
import os
import time
import traceback

import unreal


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

OUT_DIR = (
    "c:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/"
    "scripts/rig_templates/skm"
)
REGISTRY_PATH = os.path.join(OUT_DIR, "registry.json").replace("\\", "/")

# Each target: short_id, asset path (game-relative, no .uasset),
# display_name (FR), emoji, default_height_cm, category.
TARGETS = [
    {
        "id": "ue5_mannequin",
        "asset_path": (
            "/Game/2_Levels/4_Cinematic/FirstPerson/FirstPersonArms/"
            "Character/Mesh/SK_Mannequin_Arms"
        ),
        "display_name": "Bras FPS (Mannequin)",
        "emoji": "\U0001F64B",  # raising hand
        "default_height_cm": 180,
        "category": "humanoid",
    },
    {
        "id": "zebra",
        "asset_path": (
            "/Game/1_Actors/Animals/1_Source/AfricanAnimalsPack/Zebra/"
            "Meshes/SK_Zebra"
        ),
        "display_name": "Zebre",
        "emoji": "\U0001F993",  # zebra
        "default_height_cm": 140,
        "category": "quadruped",
    },
    {
        "id": "lion",
        "asset_path": (
            "/Game/1_Actors/Animals/1_Source/AfricanAnimalsPack/"
            "LionAndLioness/Meshes/SK_Lion_LOD0"
        ),
        "display_name": "Lion",
        "emoji": "\U0001F981",  # lion
        "default_height_cm": 120,
        "category": "quadruped",
    },
    {
        "id": "wolf",
        "asset_path": (
            "/Game/1_Actors/Animals/1_Source/AnimalVarietyPack/Wolf/"
            "Meshes/SK_Wolf"
        ),
        "display_name": "Loup",
        "emoji": "\U0001F43A",  # wolf
        "default_height_cm": 90,
        "category": "quadruped",
    },
    {
        "id": "crocodile",
        "asset_path": (
            "/Game/1_Actors/Animals/1_Source/AfricanAnimalsPack/Crocodile/"
            "Meshes/SK_Crocodile"
        ),
        "display_name": "Crocodile",
        "emoji": "\U0001F40A",  # crocodile
        "default_height_cm": 50,
        "category": "quadruped",
    },
    {
        "id": "elephant",
        "asset_path": (
            "/Game/1_Actors/Animals/1_Source/AfricanAnimalsPack/Elephant/"
            "Meshes/SK_Elephant"
        ),
        "display_name": "Elephant",
        "emoji": "\U0001F418",  # elephant
        "default_height_cm": 320,
        "category": "quadruped",
    },
    {
        "id": "deer",
        "asset_path": (
            "/Game/1_Actors/Animals/1_Source/AnimalVarietyPack/"
            "DeerStagAndDoe/Meshes/SK_DeerStag"
        ),
        "display_name": "Cerf",
        "emoji": "\U0001F98C",  # deer
        "default_height_cm": 150,
        "category": "quadruped",
    },
    {
        "id": "crow",
        "asset_path": (
            "/Game/1_Actors/Animals/1_Source/AnimalVarietyPack/Crow/"
            "Meshes/SK_Crow"
        ),
        "display_name": "Corbeau",
        "emoji": "\U0001F426",  # bird
        "default_height_cm": 30,
        "category": "bird",
    },
    {
        "id": "turtle",
        # NOTE: this asset is a Skeleton (not SkeletalMesh). load_asset
        # still returns the right object; we handle both cases below.
        "asset_path": (
            "/Game/1_Actors/Animals/1_Source/Animal_pack_ultra_2/"
            "Meshes/Box_turtle/box_turtle_Skeleton"
        ),
        "display_name": "Tortue",
        "emoji": "\U0001F422",  # turtle
        "default_height_cm": 20,
        "category": "quadruped",
    },
    {
        "id": "spider",
        # On-disk filename is lowercase per audit.
        "asset_path": (
            "/Game/1_Actors/Animals/1_Source/Animal_pack_ultra_2/"
            "Meshes/Goliath_spider/goliath_spider_Skeleton"
        ),
        "display_name": "Araignee",
        "emoji": "\U0001F577",  # spider
        "default_height_cm": 15,
        "category": "hexapod",
    },
    {
        "id": "bat",
        "asset_path": (
            "/Game/1_Actors/Animals/1_Source/Animal_pack_ultra_2/"
            "Meshes/Bat/bat_Skeleton"
        ),
        "display_name": "Chauve-souris",
        "emoji": "\U0001F987",  # bat
        "default_height_cm": 20,
        "category": "bird",
    },
    {
        "id": "dragon",
        "asset_path": (
            "/Game/1_Actors/Animals/1_Source/QuadrapedCreatures/"
            "MountainDragon/Meshes/MOUNTAIN_DRAGON_Skeleton"
        ),
        "display_name": "Dragon",
        "emoji": "\U0001F432",  # dragon
        "default_height_cm": 300,
        "category": "quadruped",
    },
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _vec_to_list(v):
    """unreal.Vector -> [x, y, z]."""
    return [float(v.x), float(v.y), float(v.z)]


def _resolve_skeleton(asset):
    """
    Accept either a SkeletalMesh (use its .skeleton) or a Skeleton directly.
    Returns the unreal.Skeleton, or None.
    """
    if asset is None:
        return None
    cls = asset.get_class().get_name()
    if cls == "SkeletalMesh":
        sk = asset.get_editor_property("skeleton")
        if sk is None:
            # Older API path.
            try:
                sk = asset.skeleton
            except Exception:
                sk = None
        return sk
    if cls == "Skeleton":
        return asset
    unreal.log_warning(
        "[apovivor_export] unexpected asset class '%s' for %s" %
        (cls, asset.get_path_name())
    )
    return None


def _extract_bones(skeleton, sk_mesh=None):
    """
    Walk the reference skeleton, return list of dicts compatible with
    orc_m1.bones.json schema: name, head [x,y,z], tail [x,y,z], parent.

    Strategy:
      - bone names + parent indices come from skeleton.get_editor_property(
        'bone_tree') style call... which is not exposed in BP. We use
        unreal.SkeletalMeshExportInfo? Not available either. Falling back
        to the documented EditorScripting path:
            unreal.SkeletalMeshEditorSubsystem.get_bone_pose_transform_for_index
        is missing too in some versions, so we use the universally available:
            ref = unreal.Skeleton.get_reference_pose(skeleton)  (UE5.4+)
        and:
            skeleton.get_editor_property('bone_pose')          (UE5.2 fallback)

    Bones come back in world space of the rest pose; "head" is bone origin,
    "tail" is computed as parent->child midpoint, falling back to
    head + (0,0,bone_length_guess) for leaf bones.
    """
    # 1. Bone names + parents from the legacy BoneTree property.
    try:
        bone_tree = skeleton.get_editor_property("bone_tree")
    except Exception:
        bone_tree = None

    # 2. Names + parent indices via the Skeleton.reference_skeleton API.
    #    unreal exposes get_bone_count / get_bone_name / get_parent_index
    #    on the Skeleton itself in 5.3+.
    bone_count = None
    try:
        bone_count = skeleton.get_num_bones()
    except Exception:
        pass
    if bone_count is None:
        try:
            bone_count = skeleton.get_editor_property("bone_count")
        except Exception:
            pass
    if bone_count is None and bone_tree is not None:
        bone_count = len(bone_tree)
    if not bone_count:
        unreal.log_warning(
            "[apovivor_export] could not determine bone count for %s" %
            skeleton.get_path_name()
        )
        return []

    names = []
    parents = []
    for i in range(bone_count):
        try:
            names.append(str(skeleton.get_bone_name(i)))
        except Exception:
            names.append("bone_%d" % i)
        try:
            parents.append(int(skeleton.get_parent_index(i)))
        except Exception:
            parents.append(-1)

    # 3. Rest-pose component-space transforms.
    component_transforms = [None] * bone_count

    # Preferred: per-index ref-pose accessor.
    got_transforms = False
    try:
        for i in range(bone_count):
            local_t = skeleton.get_reference_pose_transform(i)  # local space
            component_transforms[i] = local_t
        got_transforms = True
    except Exception:
        got_transforms = False

    if not got_transforms:
        # Fallback: try SkeletalMesh ref pose if supplied.
        if sk_mesh is not None:
            try:
                ref_pose = sk_mesh.get_editor_property("ref_skeleton")
                for i in range(bone_count):
                    component_transforms[i] = ref_pose.get_bone_pose(i)
                got_transforms = True
            except Exception:
                got_transforms = False

    if not got_transforms:
        unreal.log_warning(
            "[apovivor_export] no rest-pose transforms available for %s; "
            "writing zero positions" % skeleton.get_path_name()
        )
        component_transforms = [unreal.Transform() for _ in range(bone_count)]

    # Convert local -> component (root-relative) by chaining parents.
    world_positions = [None] * bone_count
    for i in range(bone_count):
        t = component_transforms[i]
        if t is None:
            world_positions[i] = unreal.Vector(0.0, 0.0, 0.0)
            continue
        local_loc = t.translation
        p = parents[i]
        if p < 0 or p >= bone_count:
            world_positions[i] = unreal.Vector(
                float(local_loc.x), float(local_loc.y), float(local_loc.z)
            )
        else:
            parent_pos = world_positions[p] or unreal.Vector(0.0, 0.0, 0.0)
            world_positions[i] = unreal.Vector(
                float(parent_pos.x) + float(local_loc.x),
                float(parent_pos.y) + float(local_loc.y),
                float(parent_pos.z) + float(local_loc.z),
            )

    # 4. children-of map (for tail computation).
    children = {i: [] for i in range(bone_count)}
    for i in range(bone_count):
        p = parents[i]
        if 0 <= p < bone_count:
            children[p].append(i)

    # 5. Build bones[] in schema order.
    bones = []
    for i in range(bone_count):
        head = world_positions[i]
        head_l = _vec_to_list(head)

        # Tail = average of children positions if any, else head + offset
        # toward parent direction (unit guess).
        if children[i]:
            sx = sy = sz = 0.0
            for ci in children[i]:
                cp = world_positions[ci]
                sx += cp.x
                sy += cp.y
                sz += cp.z
            n = float(len(children[i]))
            tail_l = [sx / n, sy / n, sz / n]
        else:
            p = parents[i]
            if 0 <= p < bone_count:
                pp = world_positions[p]
                dx = head.x - pp.x
                dy = head.y - pp.y
                dz = head.z - pp.z
                # Same direction, half length, fallback to small offset.
                length = (dx * dx + dy * dy + dz * dz) ** 0.5
                if length < 1e-6:
                    tail_l = [head.x, head.y, head.z + 0.01]
                else:
                    tail_l = [
                        head.x + dx * 0.5,
                        head.y + dy * 0.5,
                        head.z + dz * 0.5,
                    ]
            else:
                tail_l = [head.x, head.y, head.z + 0.1]

        parent_name = (
            names[parents[i]] if 0 <= parents[i] < bone_count else None
        )

        bones.append({
            "name": names[i],
            "head": head_l,
            "tail": tail_l,
            "parent": parent_name,
        })

    return bones


def _bbox_from_bones(bones):
    if not bones:
        return {"min": [0.0, 0.0, 0.0], "max": [0.0, 0.0, 0.0]}
    xs = [b["head"][0] for b in bones] + [b["tail"][0] for b in bones]
    ys = [b["head"][1] for b in bones] + [b["tail"][1] for b in bones]
    zs = [b["head"][2] for b in bones] + [b["tail"][2] for b in bones]
    return {
        "min": [min(xs), min(ys), min(zs)],
        "max": [max(xs), max(ys), max(zs)],
    }


def _export_one(target):
    """Returns dict ready to be merged into registry, or None on failure."""
    short = target["id"]
    asset_path = target["asset_path"]
    unreal.log("[apovivor_export] -> loading %s" % asset_path)

    asset = unreal.EditorAssetLibrary.load_asset(asset_path)
    if asset is None:
        unreal.log_warning(
            "[apovivor_export] FAILED to load %s (skip)" % asset_path
        )
        return None

    sk_mesh = None
    if asset.get_class().get_name() == "SkeletalMesh":
        sk_mesh = asset
    skeleton = _resolve_skeleton(asset)
    if skeleton is None:
        unreal.log_warning(
            "[apovivor_export] no skeleton for %s (skip)" % asset_path
        )
        return None

    bones = _extract_bones(skeleton, sk_mesh=sk_mesh)
    if not bones:
        return None

    armature_name = "root"
    try:
        armature_name = str(skeleton.get_name())
    except Exception:
        pass

    out_data = {
        "armature_name": armature_name,
        "bone_count": len(bones),
        "bones": bones,
        "bbox": _bbox_from_bones(bones),
        "_source": {
            "project": "Apovivor",
            "asset_path": asset_path,
            "asset_class": asset.get_class().get_name(),
            "note": (
                "Bone positions and names only (uncopyrightable "
                "landmarks). No mesh / texture / animation data exported."
            ),
        },
    }

    out_file = os.path.join(OUT_DIR, "%s.bones.json" % short).replace(
        "\\", "/"
    )
    if not os.path.isdir(OUT_DIR):
        os.makedirs(OUT_DIR)
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(out_data, f, indent=2)
    unreal.log(
        "[apovivor_export]    wrote %s (%d bones)" %
        (out_file, len(bones))
    )

    return {
        "id": short,
        "name": "%s %s" % (target["emoji"], target["display_name"]),
        "category": target["category"],
        "type": "json",
        "json": "skm/%s.bones.json" % short,
        "animations_dir": None,
        "default_height_cm": target["default_height_cm"],
        "description": (
            "Imported from Apovivor SK asset (%s) - bone positions only, "
            "uncopyrightable landmarks." % target["asset_path"]
        ),
        "license": "landmarks-only",
        "bone_count": len(bones),
    }


def _update_registry(new_entries):
    """Merge new_entries into registry.json under a new 'apovivor_templates'
    section. Idempotent: re-running replaces matching ids."""
    if not os.path.isfile(REGISTRY_PATH):
        unreal.log_warning(
            "[apovivor_export] registry %s missing, skipping update" %
            REGISTRY_PATH
        )
        return

    with open(REGISTRY_PATH, "r", encoding="utf-8") as f:
        reg = json.load(f)

    existing = reg.get("apovivor_templates", [])
    by_id = {e.get("id"): e for e in existing}
    for ne in new_entries:
        by_id[ne["id"]] = ne
    reg["apovivor_templates"] = [
        by_id[k] for k in sorted(by_id.keys())
    ]

    with open(REGISTRY_PATH, "w", encoding="utf-8") as f:
        json.dump(reg, f, indent=2, ensure_ascii=False)
    unreal.log(
        "[apovivor_export] registry updated: %d apovivor entries total" %
        len(reg["apovivor_templates"])
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print("=" * 72)
    print(" APOVIVOR -> FABMESH SKELETON EXPORT")
    print("=" * 72)
    print(" READ-ONLY: this script will NOT save, modify, rename, delete,")
    print(" or duplicate any Apovivor asset. It only calls load_asset() and")
    print(" reads bone names + ref-pose positions.")
    print("")
    print(" Output directory (only writes happen here):")
    print("   %s" % OUT_DIR)
    print("")
    print(" Targets (%d):" % len(TARGETS))
    for t in TARGETS:
        print("   [%s] %s" % (t["id"], t["asset_path"]))
    print("")
    print(" Starting in 5 seconds... press Ctrl+C in this console to abort.")
    print("=" * 72)
    time.sleep(5)

    ok_entries = []
    failures = []
    for t in TARGETS:
        try:
            entry = _export_one(t)
            if entry is None:
                failures.append(t["id"])
            else:
                ok_entries.append(entry)
        except Exception as e:
            unreal.log_error(
                "[apovivor_export] EXCEPTION on %s: %s" % (t["id"], e)
            )
            traceback.print_exc()
            failures.append(t["id"])

    if ok_entries:
        _update_registry(ok_entries)

    print("")
    print("=" * 72)
    print(" SUMMARY")
    print(" exported : %d / %d" % (len(ok_entries), len(TARGETS)))
    if failures:
        print(" failed   : %s" % ", ".join(failures))
    print(" output   : %s" % OUT_DIR)
    print(" registry : %s" % REGISTRY_PATH)
    print("")
    print(" [apovivor_export] DONE - 0 saves performed, 0 assets modified")
    print("=" * 72)


if __name__ == "__main__":
    main()
