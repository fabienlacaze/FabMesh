"""Back-view generator via MV-Adapter (Apache 2.0).

Default back-photo generator for non-character asset types (creatures,
animals, objects, vehicles...). Replaces the ControlNet-OpenPose-based
`generate_back_view.py` which is hard-wired to a humanoid T-pose
skeleton — irrelevant for animals/objects, so it ends up producing a
front-like variation instead of a real rear view.

Approach :
  1. Run MV-Adapter (i2mv-sdxl, Apache 2.0) on the front photo via the
     existing `multiview_mvadapter_gen.py` script. MV-Adapter generates
     6 multi-view-consistent images : front, back, left, right, top,
     bottom (768 px).
  2. Pick `view_1.png` (back) as the back photo.
  3. Save it to <output_dir>/back_<front_stem>_0.png (same naming
     convention as `generate_back_view.py` so the rest of the pipeline
     doesn't care which generator was used).

CLI (identical to generate_back_view.py contract):
    python generate_back_view_mvadapter.py <front_image> <output_dir>
                                            [prompt_hint] [num_images] [name_suffix]

Outputs:
    <output_dir>/back_<front_stem>_0.png

Prints a `BACK_VIEW_PATH:` line for each generated back image so the
parent IPC handler (main.js) can pick them up.
"""
import sys
import os
import time
import shutil
import subprocess
import tempfile


def log(msg):
    print(f'[back-mva] {msg}', flush=True)


def main():
    if len(sys.argv) < 3:
        print('Usage: generate_back_view_mvadapter.py <front_image> '
              '<output_dir> [prompt_hint] [num_images] [name_suffix]')
        sys.exit(1)
    front_image = os.path.abspath(sys.argv[1])
    output_dir = os.path.abspath(sys.argv[2])
    # prompt_hint and num_images are accepted for CLI compat but ignored
    # (MV-Adapter is not text-conditioned; only the input image matters).
    _prompt_hint = sys.argv[3] if len(sys.argv) > 3 else ''
    _num_images = int(sys.argv[4]) if len(sys.argv) > 4 else 1
    name_suffix = sys.argv[5] if len(sys.argv) > 5 else ''

    if not os.path.isfile(front_image):
        log(f'ERROR: front image not found: {front_image}')
        sys.exit(2)

    os.makedirs(output_dir, exist_ok=True)
    front_stem = name_suffix or os.path.splitext(os.path.basename(front_image))[0]
    log(f'front={front_image}')
    log(f'out_dir={output_dir}  stem={front_stem}')

    t0 = time.time()
    # Persist all 6 views in <front_dir>/<stem>_multiview/ (FabMesh
    # convention — texture_project / hi3dgen_full_pipeline / texture_augment
    # all look here). This gives downstream pipelines free multi-view
    # data without re-running MV-Adapter.
    front_dir = os.path.dirname(front_image)
    mv_persist_dir = os.path.join(front_dir, f'{front_stem}_multiview')
    log(f'persisting all 6 views to {mv_persist_dir}')

    log(f'running MV-Adapter into {mv_persist_dir}...')
    mva_script = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               'multiview_mvadapter_gen.py')
    result = subprocess.run(
        [sys.executable, mva_script, front_image, mv_persist_dir],
        capture_output=True, text=True, timeout=600,
    )
    if result.returncode != 0:
        log(f'MV-Adapter failed (rc={result.returncode}):')
        log(result.stderr[-2000:] if result.stderr else '')
        sys.exit(3)
    log(f'MV-Adapter done in {time.time()-t0:.1f}s')

    # MV-Adapter writes view_0..view_5 into mv_persist_dir.
    # Convention (per multiview_mvadapter_gen.py contract) :
    #   view_0 = front, view_1 = back, view_2 = right,
    #   view_3 = left, view_4 = top, view_5 = bottom
    back_view = os.path.join(mv_persist_dir, 'view_1.png')
    if not os.path.isfile(back_view):
        log(f'ERROR: view_1.png not found in MV-Adapter output ({mv_persist_dir})')
        sys.exit(4)

    # Copy the back into _backphotos/ as back_<stem>_0.png (legacy contract
    # — main.js + the 3D pipeline read back photos from there).
    dest = os.path.join(output_dir, f'back_{front_stem}_0.png')
    shutil.copy2(back_view, dest)
    log(f'wrote {dest}')
    print(f'BACK_VIEW_PATH: {dest}', flush=True)

    # Log the other persisted views so callers can pick them up if useful.
    for i, label in enumerate(['front', 'back', 'right', 'left', 'top', 'bottom']):
        p = os.path.join(mv_persist_dir, f'view_{i}.png')
        if os.path.isfile(p):
            print(f'MULTIVIEW_PATH: {label}={p}', flush=True)

    log(f'TOTAL: {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
