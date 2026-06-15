"""
UE5 Python Editor Script — Batch FBX export of all Apovivor character animations.

Run inside UE5 Editor via Output Log -> Cmd dropdown "Python":
    exec(open(r'C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/scripts/ue5_batch_export_anims.py').read())

Targets:
  /Game/1_Actors/Animals/
  /Game/1_Actors/Units/

Exports each AnimSequence to:
  c:/tmp/apovivor_fbx/<character>/ANIM_<name>.fbx

The Skeletal Mesh is embedded only in the FIRST export per character
(export_mesh=True), all subsequent anims for the same skeleton are
exported anim-only (export_mesh=False) to keep disk usage reasonable.
"""

import os
import time
import unreal


# --------------------------------------------------------------------- config
SEARCH_ROOTS = [
    "/Game/1_Actors/Animals",
    "/Game/1_Actors/Units",
]
OUTPUT_ROOT = r"c:/tmp/apovivor_fbx"
PROGRESS_EVERY = 10

# Animation filter — kept loose on purpose. We match anything that looks
# like an animation by:
#   - asset class == AnimSequence (primary signal)
#   - OR asset name starts with "ANIM_"
#   - OR asset name contains "_Animation"
NAME_PREFIXES = ("ANIM_",)
NAME_CONTAINS = ("_Animation",)


# ----------------------------------------------------------------- utilities
def _safe_load(asset_path):
    """Load an asset, swallowing errors and returning None on failure."""
    try:
        return unreal.EditorAssetLibrary.load_asset(asset_path)
    except Exception as exc:  # noqa: BLE001
        unreal.log_warning(f"[batch-export] load failed {asset_path}: {exc}")
        return None


def _is_animation_asset(asset_data):
    """Return True if this AssetData looks like one of our animations."""
    try:
        cls_name = str(asset_data.asset_class_path.asset_name)
    except AttributeError:
        # UE 5.0 compatibility
        cls_name = str(asset_data.asset_class)
    if cls_name == "AnimSequence":
        return True
    name = str(asset_data.asset_name)
    if name.startswith(NAME_PREFIXES):
        return True
    if any(tag in name for tag in NAME_CONTAINS):
        return True
    return False


def _character_name_from_path(package_path):
    """
    /Game/1_Actors/Animals/Wolf/Anims/ANIM_Wolf_Idle  ->  Wolf
    /Game/1_Actors/Units/Knight/Subdir/...            ->  Knight
    """
    parts = str(package_path).split("/")
    for root in ("Animals", "Units"):
        if root in parts:
            idx = parts.index(root)
            if idx + 1 < len(parts):
                return parts[idx + 1]
    # fallback: last meaningful folder
    return parts[-2] if len(parts) >= 2 else "Misc"


def _skeleton_of(anim_seq):
    """Return the unreal.Skeleton bound to this AnimSequence (or None)."""
    try:
        return anim_seq.get_editor_property("skeleton")
    except Exception:  # noqa: BLE001
        return None


def _skeletal_mesh_for_skeleton(skeleton):
    """
    Find a SkeletalMesh that uses this Skeleton. We use the AssetRegistry's
    referencers to avoid loading every mesh in the project.
    """
    if skeleton is None:
        return None
    try:
        ar = unreal.AssetRegistryHelpers.get_asset_registry()
        skel_path = skeleton.get_path_name().split(".")[0]
        refs = ar.get_referencers(
            skel_path,
            unreal.AssetRegistryDependencyOptions(
                include_soft_package_references=True,
                include_hard_package_references=True,
                include_searchable_names=False,
                include_soft_management_references=False,
                include_hard_management_references=False,
            ),
        ) or []
        for ref_path in refs:
            assets = ar.get_assets_by_package_name(ref_path)
            for ad in assets:
                try:
                    cls_name = str(ad.asset_class_path.asset_name)
                except AttributeError:
                    cls_name = str(ad.asset_class)
                if cls_name == "SkeletalMesh":
                    return _safe_load(str(ad.get_full_name()).split(" ")[-1])
    except Exception as exc:  # noqa: BLE001
        unreal.log_warning(f"[batch-export] skel mesh lookup failed: {exc}")
    return None


# --------------------------------------------------------------- main export
def run():
    t_start = time.time()

    # 1) Recursively list all assets under both roots.
    all_assets = []
    for root in SEARCH_ROOTS:
        if not unreal.EditorAssetLibrary.does_directory_exist(root):
            unreal.log_warning(f"[batch-export] missing root: {root}")
            continue
        found = unreal.EditorAssetLibrary.list_assets(
            root, recursive=True, include_folder=False
        ) or []
        unreal.log(f"[batch-export] {root}: {len(found)} assets")
        all_assets.extend(found)

    # 2) Filter for animations (use AssetRegistry data — no load needed).
    ar = unreal.AssetRegistryHelpers.get_asset_registry()
    anim_paths = []
    for asset_path in all_assets:
        pkg = asset_path.split(".")[0]
        datas = ar.get_assets_by_package_name(pkg) or []
        for ad in datas:
            if _is_animation_asset(ad):
                anim_paths.append(asset_path)
                break

    total = len(anim_paths)
    unreal.log(f"[batch-export] {total} animation candidates to export")
    if total == 0:
        unreal.log("[batch-export] nothing to do — exiting")
        return

    # 3) Export loop.
    os.makedirs(OUTPUT_ROOT, exist_ok=True)
    exported_skeletons = set()  # skeleton path -> mesh already embedded once
    counts = {
        "exported": 0,
        "skipped_existing": 0,
        "skipped_no_skel": 0,
        "errors": 0,
    }
    per_char = {}

    for idx, asset_path in enumerate(anim_paths, 1):
        try:
            anim = _safe_load(asset_path)
            if anim is None:
                counts["errors"] += 1
                continue

            pkg_path = asset_path.split(".")[0]
            char = _character_name_from_path(pkg_path)
            out_dir = os.path.join(OUTPUT_ROOT, char)
            os.makedirs(out_dir, exist_ok=True)

            anim_name = anim.get_name()
            if not anim_name.startswith("ANIM_"):
                anim_name = "ANIM_" + anim_name
            out_path = os.path.join(out_dir, anim_name + ".fbx")

            # Skip if already on disk.
            if os.path.isfile(out_path):
                counts["skipped_existing"] += 1
                per_char[char] = per_char.get(char, 0) + 1
                if idx % PROGRESS_EVERY == 0:
                    unreal.log(
                        f"[batch-export] {idx}/{total} (skip existing) {char}/{anim_name}"
                    )
                continue

            skel = _skeleton_of(anim)
            if skel is None:
                counts["skipped_no_skel"] += 1
                unreal.log_warning(
                    f"[batch-export] no skeleton on {asset_path} — skipping"
                )
                continue

            skel_key = skel.get_path_name()
            embed_mesh = skel_key not in exported_skeletons
            mesh = _skeletal_mesh_for_skeleton(skel) if embed_mesh else None

            # Build export options.
            opts = unreal.FbxExportOption()
            opts.fbx_export_compatibility = unreal.FbxExportCompatibility.FBX_2013
            opts.ascii = False
            opts.force_front_x_axis = False
            opts.vertex_color = True
            opts.level_of_detail = False
            opts.collision = False
            opts.export_morph_targets = True
            opts.export_preview_mesh = False
            opts.map_skeletal_motion_to_root = False
            opts.export_local_time = True
            # mesh embedding
            try:
                opts.set_editor_property("export_mesh", bool(embed_mesh and mesh))
            except Exception:  # noqa: BLE001
                pass

            task = unreal.AssetExportTask()
            task.object = anim
            task.filename = out_path
            task.automated = True
            task.prompt = False
            task.replace_identical = True
            task.use_file_archive = False
            task.write_empty_files = False
            task.options = opts
            task.exporter = unreal.AnimSequenceExporterFBX()

            ok = unreal.Exporter.run_asset_export_task(task)
            if ok and os.path.isfile(out_path):
                counts["exported"] += 1
                per_char[char] = per_char.get(char, 0) + 1
                if embed_mesh and mesh is not None:
                    exported_skeletons.add(skel_key)
            else:
                counts["errors"] += 1
                unreal.log_warning(
                    f"[batch-export] export failed: {asset_path} -> {out_path}"
                )

            if idx % PROGRESS_EVERY == 0:
                elapsed = time.time() - t_start
                rate = idx / max(elapsed, 1e-6)
                eta = (total - idx) / max(rate, 1e-6)
                unreal.log(
                    f"[batch-export] {idx}/{total} "
                    f"({100.0 * idx / total:.1f}%) "
                    f"{char}/{anim_name}  "
                    f"rate={rate:.2f}/s  eta={eta / 60.0:.1f} min"
                )

        except Exception as exc:  # noqa: BLE001
            counts["errors"] += 1
            unreal.log_error(f"[batch-export] {asset_path}: {exc}")

    # 4) Summary.
    elapsed = time.time() - t_start
    unreal.log("=" * 72)
    unreal.log("[batch-export] DONE")
    unreal.log(f"  total candidates : {total}")
    unreal.log(f"  exported         : {counts['exported']}")
    unreal.log(f"  skipped (exists) : {counts['skipped_existing']}")
    unreal.log(f"  skipped (no skel): {counts['skipped_no_skel']}")
    unreal.log(f"  errors           : {counts['errors']}")
    unreal.log(f"  characters       : {len(per_char)}")
    unreal.log(f"  elapsed          : {elapsed / 60.0:.1f} min")
    unreal.log(f"  output root      : {OUTPUT_ROOT}")
    unreal.log("=" * 72)
    for char in sorted(per_char):
        unreal.log(f"    {char:24s}  {per_char[char]:5d} anims")


run()
