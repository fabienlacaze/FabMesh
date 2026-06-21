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
import json


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
    # convention, picked up by trellis2_native).
    front_dir = os.path.dirname(front_image)
    mv_persist_dir = os.path.join(front_dir, f'{name_suffix}_multiview')
    log(f'front={front_image}')
    log(f'mv_persist_dir={mv_persist_dir}')

    # Number of views in the sheet — comes from the UI's Extra views
    # dropdown via FABMESH_SHEET_VIEWS env (2 / 4 / 6). Default to 4
    # (front/back/right/left, 2x2 grid).
    n_views = os.environ.get('FABMESH_SHEET_VIEWS', '4')

    t0 = time.time()
    sheet_script = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 'multiview_sheet_gen.py')
    cmd = [sys.executable, sheet_script, front_image, mv_persist_dir]
    if prompt_hint:
        cmd.append(prompt_hint)
    cmd += ['--views', n_views]
    log(f'sheet config: views={n_views}')
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

    # Map view_{i}.png -> real label from views.json (written by
    # multiview_sheet_gen.py). The cell order is NOT always
    # [front, back, right, left] — e.g. the 4-view layout is
    # front/right/back/left, so the old hardcoded view_1 = "back" actually
    # textured the back of the mesh from a SIDE (right-profile) image.
    labels = None
    views_json = os.path.join(mv_persist_dir, 'views.json')
    if os.path.isfile(views_json):
        try:
            with open(views_json, 'r', encoding='utf-8') as _vf:
                _meta = json.load(_vf)
            labels = [str(v.get('label', '')).lower() for v in _meta.get('views', [])]
        except Exception as _e:
            log(f'could not read views.json ({_e}); falling back to index order')

    back_idx = None
    if labels:
        for _i, _lbl in enumerate(labels):
            if _lbl == 'back':
                back_idx = _i
                break
    if back_idx is None:
        log('no "back" label in views.json — falling back to view_1')
        back_idx = 1

    back_view = os.path.join(mv_persist_dir, f'view_{back_idx}.png')
    if not os.path.isfile(back_view):
        log(f'ERROR: view_{back_idx}.png (back) missing in {mv_persist_dir}')
        sys.exit(4)
    dest = os.path.join(output_dir, f'back_{name_suffix}_0.png')
    shutil.copy2(back_view, dest)
    log(f'wrote back (view_{back_idx}, label=back) -> {dest}')
    print(f'BACK_VIEW_PATH: {dest}', flush=True)

    # Emit MULTIVIEW_PATH markers using the REAL labels from views.json.
    _emit_labels = labels if labels else ['front', 'back', 'right', 'left']
    for i, label in enumerate(_emit_labels):
        p = os.path.join(mv_persist_dir, f'view_{i}.png')
        if os.path.isfile(p):
            print(f'MULTIVIEW_PATH: {label}={p}', flush=True)

    log(f'TOTAL: {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
