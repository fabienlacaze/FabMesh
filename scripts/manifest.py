"""
FabMesh per-project manifest writer.

Each project has a single `<project_dir>/manifest.json` file that
records every step of its lifecycle: image generations, image edits,
mesh generations, rig generations, exports. This is what we read
later to know exactly which parameters produced which artefact.

Format (top-level): {
  "project": "poule_geante",
  "created": "2026-04-15T00:24:00Z",
  "fabmesh_commit": "abcdef0",
  "entries": [
    {"kind": "image_gen", "ts": ..., "path": "...", "engine": ...,
     "prompt": ..., "steps": ..., ...},
    {"kind": "image_edit", "ts": ..., "from": "...", "to": "...",
     "operation": "remove_bg", ...},
    {"kind": "mesh_gen", "ts": ..., "path": "...", "from_image": "...",
     "engine": "sf3d", "tex_res": ..., "target_triangles": ...,
     "project_mode": ..., "subdivide": ..., "verts": ..., "faces": ...},
    {"kind": "rig_gen", ...},
    ...
  ]
}

Concurrency: the file is written atomically (temp file + rename) and
read with a single fs.open call, so multi-process appends never half-
write. Two simultaneous appends could race; if that becomes an issue
we'll add a real lock, but in FabMesh's serial pipeline it's a non-
issue.

Usage:
    from manifest import append_entry
    append_entry(project_dir,
        kind='mesh_gen',
        path='meshes/foo.glb',
        engine='sf3d',
        tex_res=2048,
        ...)
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone


def _project_dir_for(any_path: str) -> str | None:
    """
    Manifests live in `images/<project>/manifest.json`. Given any path
    that belongs to a known FabMesh project (image, mesh, rig), return
    the matching images/<project>/ directory if we can resolve it.
    Returns None when we can't (caller falls back to a no-op).
    """
    if not any_path:
        return None
    abs_path = os.path.abspath(any_path)
    norm = abs_path.replace('\\', '/')
    parts = norm.split('/')
    # If the path itself is inside images/<project>/..., great.
    if 'images' in parts:
        idx = parts.index('images')
        if idx + 1 < len(parts):
            return '/'.join(parts[: idx + 2])
    # Fallback: a mesh `meshes/<project>_sf3d_xxx.glb` -> derive project
    # name from the file basename. Project name is everything before
    # the first `_sf3d`/`_triposg`/`_trellis` segment.
    if 'meshes' in parts:
        base = os.path.basename(norm)
        for marker in ('_sf3d_', '_triposg_', '_trellis_', '_hunyuan_',
                       '_triposr_', '_inst_', '_meshy_'):
            if marker in base:
                proj = base.split(marker, 1)[0]
                # Find a sibling images/<proj> dir
                root_idx = parts.index('meshes')
                root = '/'.join(parts[: root_idx])
                cand = root + '/images/' + proj
                if os.path.isdir(cand):
                    return cand
                # Else still return the candidate so we create it on append
                return cand
    return None


def _manifest_path(project_dir: str) -> str:
    return os.path.join(project_dir, 'manifest.json')


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _safe_load(path: str) -> dict:
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get('entries'), list):
            return data
    except Exception:
        pass
    return {}


def _atomic_write(path: str, data: dict) -> None:
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write('\n')
    os.replace(tmp, path)


def _git_commit_short() -> str | None:
    """Return the current FabMesh git short SHA, or None."""
    try:
        import subprocess
        repo_root = os.path.abspath(os.path.join(
            os.path.dirname(os.path.abspath(__file__)), '..'))
        sha = subprocess.check_output(
            ['git', '-C', repo_root, 'rev-parse', '--short', 'HEAD'],
            stderr=subprocess.DEVNULL, text=True, timeout=2,
        ).strip()
        return sha or None
    except Exception:
        return None


def _ensure_manifest(project_dir: str) -> dict:
    os.makedirs(project_dir, exist_ok=True)
    p = _manifest_path(project_dir)
    data = _safe_load(p)
    if not data:
        data = {
            'project': os.path.basename(project_dir),
            'created': _utcnow_iso(),
            'fabmesh_commit': _git_commit_short(),
            'entries': [],
        }
    return data


def append_entry(project_dir_or_path: str, **fields) -> dict | None:
    """
    Append one entry to the manifest for the project that
    `project_dir_or_path` belongs to. Returns the written entry, or
    None if we couldn't resolve the project.

    Required field: 'kind' (e.g. 'image_gen', 'mesh_gen', 'rig_gen',
                            'image_edit', 'export').
    A 'ts' (millis) is added if not provided.
    """
    if 'kind' not in fields:
        return None

    pd = (project_dir_or_path
          if os.path.isdir(project_dir_or_path)
          else _project_dir_for(project_dir_or_path))
    if not pd:
        return None

    data = _ensure_manifest(pd)
    entry = dict(fields)
    entry.setdefault('ts', int(time.time() * 1000))
    entry.setdefault('iso', _utcnow_iso())
    data['entries'].append(entry)
    try:
        _atomic_write(_manifest_path(pd), data)
    except Exception:
        return None
    return entry


def read(project_dir_or_path: str) -> dict | None:
    pd = (project_dir_or_path
          if os.path.isdir(project_dir_or_path)
          else _project_dir_for(project_dir_or_path))
    if not pd:
        return None
    p = _manifest_path(pd)
    if not os.path.exists(p):
        return None
    return _safe_load(p)


if __name__ == '__main__':
    # Smoke test from the CLI:
    #   python manifest.py path/to/whatever
    import sys
    if len(sys.argv) < 2:
        print('Usage: python manifest.py <path-inside-project>')
        sys.exit(1)
    print(json.dumps(read(sys.argv[1]) or {}, indent=2, ensure_ascii=False))
