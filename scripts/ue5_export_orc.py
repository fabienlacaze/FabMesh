"""
Export ORC_M1 skeletal mesh from Unreal as FBX.
Run via: UnrealEditor.exe <project>.uproject -run=pythonscript -script="this_script.py" -unattended -nullrhi

This is a one-time operation to extract the ORC_M1 skeletal mesh + skeleton
that FabMesh will use as a template for auto-rigging biped meshes.
"""
import unreal
import os

OUTPUT_DIR = r"C:\Users\Utilisateur\Desktop\FabWare\MeshyMyself\scripts\rig_templates"
os.makedirs(OUTPUT_DIR, exist_ok=True)

TARGETS = [
    {
        "asset_path": "/Game/1_Actors/Units/initial/orc/ORC_M1/SKM_Orc_M1",
        "output_name": "orc_m1_skeletal_mesh.fbx",
    },
    {
        "asset_path": "/Game/1_Actors/Units/initial/orc/ORC_M1/SK_Orc_M1",
        "output_name": "orc_m1_skeleton.fbx",
    },
]


def get_exporter_for(asset):
    """Pick the right exporter class based on the asset type."""
    cls_name = asset.get_class().get_name()
    print(f"[ORC EXPORT] Asset class: {cls_name}")

    # SkeletalMesh -> SkeletalMeshExporterFBX
    # Skeleton -> AnimSequenceExporterFBX (handles Skeleton too in some versions)
    candidates = [
        "SkeletalMeshExporterFBX",
        "AnimSequenceExporterFBX",
        "StaticMeshExporterFBX",
        "ExporterFBX",
    ]
    for name in candidates:
        if hasattr(unreal, name):
            try:
                exp_cls = getattr(unreal, name)
                inst = exp_cls()
                # Check if this exporter accepts the asset class
                supported = inst.get_supported_class()
                if supported and asset.get_class() == supported:
                    print(f"[ORC EXPORT] Using exporter: {name}")
                    return inst
            except Exception as e:
                print(f"[ORC EXPORT] {name} skipped: {e}")
                continue

    # Fallback: try the first SkeletalMesh exporter we find
    if hasattr(unreal, "SkeletalMeshExporterFBX"):
        print("[ORC EXPORT] Fallback to SkeletalMeshExporterFBX")
        return unreal.SkeletalMeshExporterFBX()

    return None


def export_asset(target):
    asset_path = target["asset_path"]
    output_path = os.path.join(OUTPUT_DIR, target["output_name"])

    print(f"\n[ORC EXPORT] === {target['output_name']} ===")
    print(f"[ORC EXPORT] Loading {asset_path}...")
    asset = unreal.EditorAssetLibrary.load_asset(asset_path)
    if not asset:
        print(f"[ORC EXPORT] FAIL: Could not load {asset_path}")
        return False

    print(f"[ORC EXPORT] Loaded: {asset.get_name()} ({asset.get_class().get_name()})")

    exporter = get_exporter_for(asset)
    if not exporter:
        print(f"[ORC EXPORT] FAIL: No exporter found for {asset.get_class().get_name()}")
        return False

    task = unreal.AssetExportTask()
    task.object = asset
    task.filename = output_path
    task.automated = True
    task.prompt = False
    task.replace_identical = True
    task.exporter = exporter

    # Try to set FBX export options - DISABLE material baking which crashes 5.7
    try:
        options = unreal.FbxExportOption()
        options.fbx_export_compatibility = unreal.FbxExportCompatibility.FBX_2018
        options.ascii = False
        options.vertex_color = False  # Disable - triggers MeshMerge crash
        options.level_of_detail = False
        options.collision = False
        options.export_morph_targets = False  # Disable - triggers MeshMerge crash
        options.export_preview_mesh = False
        # Try to disable material baking
        try:
            options.bake_materials = False
        except Exception:
            pass
        try:
            options.export_local_time = False
        except Exception:
            pass
        task.options = options
    except Exception as e:
        print(f"[ORC EXPORT] FbxExportOption skipped: {e}")

    print(f"[ORC EXPORT] Exporting to {output_path}...")
    success = unreal.Exporter.run_asset_export_task(task)
    if success and os.path.exists(output_path):
        size = os.path.getsize(output_path)
        print(f"[ORC EXPORT] SUCCESS: {output_path} ({size} bytes)")
        return True
    else:
        print(f"[ORC EXPORT] FAIL: returned={success}, file_exists={os.path.exists(output_path)}")
        return False


print("[ORC EXPORT] Listing available unreal exporters...")
for name in dir(unreal):
    if "Exporter" in name and "FBX" in name.upper():
        print(f"  - {name}")

for target in TARGETS:
    try:
        export_asset(target)
    except Exception as e:
        print(f"[ORC EXPORT] ERROR on {target['asset_path']}: {e}")
        import traceback
        traceback.print_exc()

print("\n[ORC EXPORT] Done")