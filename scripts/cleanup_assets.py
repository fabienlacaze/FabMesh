"""Clean up FabMesh artifacts from the user's machine.

Used both:
  - During NSIS uninstall (build/uninstaller.nsh covers most of this
    natively, but the script is a portable cross-OS fallback)
  - As a manual CLI for power users who want to free disk space
    without uninstalling the app

Removes one or more of:
  --models   AI model cache (HuggingFace + Real-ESRGAN), ~17 GB
  --config   App settings + setup state in AppData, < 1 MB
  --logs     FabMesh's own logs folder, < 100 MB
  --all      Everything above

Never removes generated meshes (Documents\FabMesh\) — those are user work.

Usage:
    python cleanup_assets.py --models             # free 17 GB
    python cleanup_assets.py --config             # reset settings
    python cleanup_assets.py --all --dry-run      # preview only
"""
import argparse
import os
import shutil
import sys


def _human(bytes_):
    units = ['B', 'KB', 'MB', 'GB', 'TB']
    n = float(bytes_)
    for u in units:
        if n < 1024 or u == units[-1]:
            return f'{n:.1f} {u}'
        n /= 1024


def _dir_size_bytes(path):
    if not os.path.isdir(path):
        return 0
    total = 0
    for root, _dirs, files in os.walk(path):
        for fn in files:
            try:
                total += os.path.getsize(os.path.join(root, fn))
            except OSError:
                pass
    return total


def _remove(path, dry_run, label):
    if not os.path.exists(path):
        print(f'[skip] {label}: not present ({path})')
        return 0
    size = _dir_size_bytes(path) if os.path.isdir(path) else os.path.getsize(path)
    if dry_run:
        print(f'[dry-run] would remove {label}: {path} ({_human(size)})')
        return size
    try:
        if os.path.isdir(path):
            shutil.rmtree(path)
        else:
            os.remove(path)
        print(f'[ok] removed {label}: {path} ({_human(size)})')
        return size
    except Exception as e:
        print(f'[error] {label}: {e}')
        return 0


def _models_targets():
    home = os.path.expanduser('~')
    return [
        (os.path.join(home, '.cache', 'huggingface', 'hub'), 'HuggingFace cache'),
        (os.path.join(home, '.cache', 'realesrgan_weights'), 'Real-ESRGAN weights'),
    ]


def _config_targets():
    appdata = os.environ.get('APPDATA') or os.path.expanduser('~')
    return [
        (os.path.join(appdata, 'fabmesh'), 'FabMesh AppData'),
    ]


def _logs_targets():
    # Default: relative to this script's directory. The packaged
    # installer places scripts inside <install>/resources/scripts/, so
    # logs/ next to it is the right target. Never hard-code the dev's
    # workstation path — that leaks the dev's username + repo name.
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.normpath(os.path.join(here, '..', 'logs')),
        os.path.normpath(os.path.join(here, '..', '..', 'logs')),
    ]
    return [(p, 'MyFabmesh.AI logs') for p in candidates if os.path.isdir(p)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--models', action='store_true',
                    help='remove AI model caches (~17 GB)')
    ap.add_argument('--config', action='store_true',
                    help='remove app settings in AppData')
    ap.add_argument('--logs', action='store_true',
                    help='remove FabMesh logs')
    ap.add_argument('--all', action='store_true',
                    help='all of the above')
    ap.add_argument('--dry-run', action='store_true',
                    help='show what would be removed without touching anything')
    args = ap.parse_args()

    if args.all:
        args.models = args.config = args.logs = True

    if not (args.models or args.config or args.logs):
        ap.print_help()
        sys.exit(1)

    targets = []
    if args.models: targets += _models_targets()
    if args.config: targets += _config_targets()
    if args.logs:   targets += _logs_targets()

    print(f'FabMesh cleanup ({"dry-run" if args.dry_run else "live"})')
    total_freed = 0
    for path, label in targets:
        total_freed += _remove(path, args.dry_run, label)
    print(f'\nTotal: {_human(total_freed)} '
          f'{"would be" if args.dry_run else ""} freed')


if __name__ == '__main__':
    main()
