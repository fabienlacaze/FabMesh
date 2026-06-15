"""
UE5 Python Editor Script — Export SK_MOUNTAIN_DRAGON + animations to FBX.

Run inside the UE5 editor:
    Window > Python > paste/exec this file
or from the Python console:
    exec(open(r'C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/scripts/ue5_export_sk_with_anim.py').read())

Strategy (UE 5.1+):
  We export each AnimSequence as the FBX *object* and rely on
  FbxExportOption.export_preview_mesh = True so the exporter embeds the
  bound Skeletal Mesh (geometry + skin weights) into the SAME FBX file
  as the animation track + skeleton. Result: one FBX = mesh + skeleton
  + anim, no Blender merge step needed.

Notes / caveats:
  - export_preview_mesh ships the SkeletalMesh referenced by the
    AnimSequence's Skeleton "Preview Mesh" slot. If that slot is empty
    on the Skeleton asset, the FBX will only contain the skeleton + anim
    (no geometry). In that case open the Skeleton asset in UE and set
    SK_MOUNTAIN_DRAGON as Preview Mesh, then re-run.
  - fbx_export_compatibility = FBX_2013 is the safest target for
    downstream Blender / AnyTop retarget tooling (FBX 7.4 ascii=False).
  - map_skeletal_motion_to_root is left False so root motion stays on
    the root bone exactly as authored.
"""

import os
import unreal

# ---------------------------------------------------------------------------
# CONFIG
# ---------------------------------------------------------------------------

SK_PATH = (
    '/Game/1_Actors/Animals/1_Source/QuadrapedCreatures/MountainDragon/'
    'Meshes/SK_MOUNTAIN_DRAGON'
)

# Per-anim mapping: short action name -> /Game asset path
ANIM_BASE = (
    '/Game/1_Actors/Animals/1_Source/QuadrapedCreatures/MountainDragon/'
    'Animations'
)
ANIMS = {
    'walk':         f'{ANIM_BASE}/ANIM_MOUNTAIN_DRAGON_walk',
    'run':          f'{ANIM_BASE}/ANIM_MOUNTAIN_DRAGON_run',
    'death':        f'{ANIM_BASE}/ANIM_MOUNTAIN_DRAGON_death',
    'idle_breathe': f'{ANIM_BASE}/ANIM_MOUNTAIN_DRAGON_idle_breathe',
    'fly_normal':   f'{ANIM_BASE}/ANIM_MOUNTAIN_DRAGON_fly_normal',
    'bite':         f'{ANIM_BASE}/ANIM_MOUNTAIN_DRAGON_bite',
}

OUT_DIR = r'C:/tmp'
OUT_PATTERN = 'MountainDragon_{action}.fbx'


# ---------------------------------------------------------------------------
# CORE
# ---------------------------------------------------------------------------

def _build_fbx_options():
    """One FbxExportOption configured for mesh + skeleton + anim in 1 FBX."""
    opts = unreal.FbxExportOption()
    # --- format ---
    opts.fbx_export_compatibility = unreal.FbxExportCompatibility.FBX_2013
    opts.ascii = False
    opts.force_front_x_axis = False
    # --- mesh content ---
    opts.level_of_detail = False           # LOD0 only, no LOD chain
    opts.vertex_color = False
    opts.export_morph_targets = False
    opts.export_preview_mesh = True        # KEY: embeds SkeletalMesh in FBX
    # --- animation content ---
    opts.export_local_time = True
    opts.map_skeletal_motion_to_root = False
    # Collision off — we want clean mesh for retarget
    if hasattr(opts, 'collision'):
        opts.collision = False
    return opts


def export_anim_with_mesh(action, anim_path, out_dir):
    """Export ONE animation + its preview SkeletalMesh as a single FBX.

    Returns (ok: bool, out_path: str, msg: str).
    """
    out_path = os.path.join(out_dir, OUT_PATTERN.format(action=action))
    out_path = out_path.replace('\\', '/')

    print(f'[{action}] loading anim asset: {anim_path}')
    anim = unreal.EditorAssetLibrary.load_asset(anim_path)
    if anim is None:
        return False, out_path, f'cannot load anim asset {anim_path}'

    opts = _build_fbx_options()

    task = unreal.AssetExportTask()
    task.object = anim
    task.filename = out_path
    task.selected = False
    task.replace_identical = True
    task.prompt = False
    task.automated = True
    task.use_file_archive = False
    task.write_empty_files = False
    task.options = opts

    print(f'[{action}] exporting -> {out_path}')
    ok = unreal.Exporter.run_asset_export_task(task)

    if not ok:
        return False, out_path, 'run_asset_export_task returned False'

    if not os.path.exists(out_path):
        return False, out_path, 'task succeeded but FBX file missing on disk'

    size = os.path.getsize(out_path)
    if size < 4096:
        return False, out_path, f'FBX suspiciously small ({size} bytes)'

    return True, out_path, f'ok ({size:,} bytes)'


def main():
    print('=' * 72)
    print('UE5 export — SK_MOUNTAIN_DRAGON + animations -> single FBX each')
    print('=' * 72)
    print(f'SK asset      : {SK_PATH}')
    print(f'Output folder : {OUT_DIR}')
    print(f'Anims         : {len(ANIMS)} -> {list(ANIMS.keys())}')
    print('-' * 72)

    # Sanity: verify SK asset exists (does not block — export uses Anim's
    # preview-mesh slot, but missing SK is usually a sign the skeleton's
    # preview-mesh slot is also empty)
    if not unreal.EditorAssetLibrary.does_asset_exist(SK_PATH):
        print(f'WARNING: SK asset not found at {SK_PATH} — '
              f'preview-mesh slot may also be empty, FBX may have no geom.')

    if not os.path.isdir(OUT_DIR):
        os.makedirs(OUT_DIR, exist_ok=True)
        print(f'created output dir: {OUT_DIR}')

    successes, failures = [], []

    for action, anim_path in ANIMS.items():
        print()
        print(f'--- [{action}] ---')
        try:
            ok, out_path, msg = export_anim_with_mesh(action, anim_path, OUT_DIR)
        except Exception as exc:
            ok, out_path, msg = False, '', f'exception: {exc!r}'

        if ok:
            successes.append((action, out_path, msg))
            print(f'[{action}] OK  {msg}')
        else:
            failures.append((action, anim_path, msg))
            print(f'[{action}] FAIL {msg}')

    # ------- summary -------
    print()
    print('=' * 72)
    print(f'DONE  successes={len(successes)}  failures={len(failures)}')
    print('=' * 72)
    for action, out_path, msg in successes:
        print(f'  OK   {action:<14} -> {out_path}  [{msg}]')
    for action, anim_path, msg in failures:
        print(f'  FAIL {action:<14} ({anim_path})  [{msg}]')
    print('=' * 72)

    return 0 if not failures else 1


if __name__ == '__main__':
    main()
