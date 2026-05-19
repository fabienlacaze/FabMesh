"""Back-view generator wrapping the SDXL multi-view sheet.

Calls multiview_sheet_gen.py which produces a 4-view 2x2 grid in a
single SDXL pass (front / back / right / left). Persists all 4 views
in <stem>_multiview/ (FabMesh convention) AND copies view_1.png (back)
into <output_dir>/back_<stem>_0.png for the legacy back-photo IPC
contract.

CLI (identical to other back-view generators) :
    python generate_back_view_sheet.py <front> <output_dir>
                                        [prompt_hint] [num] [name_suffix]

Output marker lines :
    BACK_VIEW_PATH:  <output_dir>/back_<stem>_0.png
    MULTIVIEW_PATH:  label=<path>   (for view_0..view_3)
"""
import os
import sys
import time
import shutil
import subprocess


def log(msg):
    print(f'[back-sheet] {msg}', flush=True)


def main():
    if len(sys.argv) < 3:
        print('Usage: generate_back_view_sheet.py <front_image> '
              '<output_dir> [prompt_hint] [num_images] [name_suffix]')
        sys.exit(1)
    front_image = os.path.abspath(sys.argv[1])
    output_dir = os.path.abspath(sys.argv[2])
    prompt_hint = sys.argv[3] if len(sys.argv) > 3 else ''
    # num_images accepted for CLI compat, ignored (always 4 views).
    _num_images = int(sys.argv[4]) if len(sys.argv) > 4 else 1
    name_suffix = sys.argv[5] if len(sys.argv) > 5 else os.path.splitext(
        os.path.basename(front_image))[0]

    if not os.path.isfile(front_image):
        log(f'ERROR: front image not found: {front_image}')
        sys.exit(2)
    os.makedirs(output_dir, exist_ok=True)

    # Persist the 4 views in <front_dir>/<stem>_multiview/ (FabMesh
    # convention, picked up by hi3dgen_full_pipeline / trellis2_native).
    front_dir = os.path.dirname(front_image)
    mv_persist_dir = os.path.join(front_dir, f'{name_suffix}_multiview')
    log(f'front={front_image}')
    log(f'mv_persist_dir={mv_persist_dir}')

    t0 = time.time()
    sheet_script = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 'multiview_sheet_gen.py')
    cmd = [sys.executable, sheet_script, front_image, mv_persist_dir]
    if prompt_hint:
        cmd.append(prompt_hint)
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    # Forward sheet stdout for diagnosability.
    if result.stdout:
        for line in result.stdout.splitlines()[-25:]:
            log(line)
    if result.returncode != 0:
        log(f'sheet_gen failed (rc={result.returncode}):')
        log(result.stderr[-2000:] if result.stderr else '')
        sys.exit(3)
    log(f'sheet generation done in {time.time()-t0:.1f}s')

    # Pick view_1.png (back) as the back-photo to expose via the IPC
    # contract. Same naming as the other back generators.
    back_view = os.path.join(mv_persist_dir, 'view_1.png')
    if not os.path.isfile(back_view):
        log(f'ERROR: view_1.png missing in {mv_persist_dir}')
        sys.exit(4)
    dest = os.path.join(output_dir, f'back_{name_suffix}_0.png')
    shutil.copy2(back_view, dest)
    log(f'wrote back -> {dest}')
    print(f'BACK_VIEW_PATH: {dest}', flush=True)

    # Emit MULTIVIEW_PATH markers so callers can pick up the side views.
    for i, label in enumerate(['front', 'back', 'right', 'left']):
        p = os.path.join(mv_persist_dir, f'view_{i}.png')
        if os.path.isfile(p):
            print(f'MULTIVIEW_PATH: {label}={p}', flush=True)

    log(f'TOTAL: {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
