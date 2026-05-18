"""Add AI-generated metadata to a .glb file.

Required by EU Regulation 2024/1689 ("AI Act") Article 50, applicable from
2 August 2026. Marks the output as AI-generated in machine-readable form.

Adds to the glTF JSON:
  - asset.generator = "FabMesh <version> (AI-generated)"
  - asset.extras.aiGenerated = true
  - asset.extras.aiSystem = "FabMesh"
  - asset.extras.aiActArticle50 = true

Usage:
    python add_ai_metadata.py <input.glb> [<output.glb>]

If <output.glb> is omitted, the input is patched in place.
"""
import sys
import os
import json
import struct

FABMESH_VERSION = "1.0.0"


def patch_glb(in_path, out_path=None):
    if out_path is None:
        out_path = in_path
    with open(in_path, 'rb') as f:
        data = f.read()

    # GLB structure: 12-byte header + chunks.
    # Header: magic(4) version(4) length(4)
    if len(data) < 12 or data[:4] != b'glTF':
        print(f'[add_ai_metadata] not a valid GLB: {in_path}', flush=True)
        return False
    version, total_length = struct.unpack('<II', data[4:12])
    if version != 2:
        print(f'[add_ai_metadata] unsupported GLB version {version}', flush=True)
        return False

    # First chunk = JSON chunk: length(4) type(4) data(length)
    json_chunk_len = struct.unpack('<I', data[12:16])[0]
    json_chunk_type = data[16:20]
    if json_chunk_type != b'JSON':
        print(f'[add_ai_metadata] first chunk is not JSON ({json_chunk_type!r})', flush=True)
        return False
    json_blob = data[20:20 + json_chunk_len]
    rest = data[20 + json_chunk_len:]

    # Parse the JSON, mutate the `asset` section.
    try:
        gltf = json.loads(json_blob.decode('utf-8'))
    except Exception as e:
        print(f'[add_ai_metadata] JSON parse failed: {e}', flush=True)
        return False

    asset = gltf.setdefault('asset', {})
    asset['generator'] = f'FabMesh {FABMESH_VERSION} (AI-generated)'
    extras = asset.setdefault('extras', {})
    extras['aiGenerated'] = True
    extras['aiSystem'] = 'FabMesh'
    extras['aiActArticle50'] = True

    # Reserialize JSON, pad to 4-byte alignment with spaces (required by GLB spec).
    new_json = json.dumps(gltf, separators=(',', ':')).encode('utf-8')
    pad = (4 - len(new_json) % 4) % 4
    new_json = new_json + b' ' * pad

    # Rebuild the GLB:
    #   header (12) + JSON chunk header (8) + JSON + binary chunk + ...
    new_total = 12 + 8 + len(new_json) + len(rest)
    header = b'glTF' + struct.pack('<II', 2, new_total)
    json_header = struct.pack('<I', len(new_json)) + b'JSON'
    new_data = header + json_header + new_json + rest

    with open(out_path, 'wb') as f:
        f.write(new_data)
    return True


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    inp = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else None
    if not os.path.isfile(inp):
        print(f'[add_ai_metadata] file not found: {inp}', flush=True)
        sys.exit(2)
    ok = patch_glb(inp, out)
    if ok:
        target = out or inp
        print(f'[add_ai_metadata] OK: {target}', flush=True)
        sys.exit(0)
    else:
        sys.exit(3)
