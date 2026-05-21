# FabMesh — build/ directory

Files needed BEFORE running `npm run build:installer`. Most are
downloaded once by helper scripts and gitignored.

## What goes here

| File / Dir | What | How |
|---|---|---|
| `python-embed/` | Python 3.11 portable distribution (~30 MB) | `python build/fetch_python_embed.py` |
| `vc_redist.x64.exe` | Visual C++ 2022 Redistributable (~25 MB) | `python build/fetch_vc_redist.py` |
| `uninstaller.nsh` | NSIS hook for the uninstall flow | committed |
| `fetch_*.py` | Helper scripts | committed |
| `build_wheels.md` | How to build custom torch/flash-attn/kaolin/xformers wheels | committed |

## First-time setup (dev machine)

```
python build/fetch_python_embed.py     # ~30 MB download
python build/fetch_vc_redist.py        # ~25 MB download
npm run build:installer                # produces dist/installer/FabMesh-Setup-1.0.0.exe
```

The installer auto-includes everything via `extraResources` in
`package.json`.

## What's gitignored

- `python-embed/` (download artefact, ~30 MB, re-fetchable)
- `vc_redist.x64.exe` (download artefact, ~25 MB)
- Both can be re-downloaded by their `fetch_*.py` script with
  SHA-256 verification.

Commit `build/uninstaller.nsh`, `build_wheels.md`, and the `fetch_*.py`
scripts. Do not commit the binaries.
