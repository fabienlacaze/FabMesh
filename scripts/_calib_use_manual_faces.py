"""
Use the 6 user-painted face textures (calib_Front / Back / Right / Left /
Top / Bottom .png) in images/_calibration/ to rebuild the calibration
cube with THOSE textures instead of the synthetic ones.

Then re-render ref_0.png + the 6 orthographic multi-view frames so the
calibration project stays in sync.

Outputs:
  images/_calibration/ref_0.png                          (front ortho render)
  images/_calibration/ref_0_multiview/view_0..5.png      (6 ortho views)
  images/_calibration/ref_0_multiview/input.png          (copy of ref_0)
  meshes/_calibration_groundtruth.glb                    (textured cube)

Usage:  python scripts/_calib_use_manual_faces.py
"""
from __future__ import annotations

import os
import numpy as np
from PIL import Image

# Re-use the cube-building + rendering logic from the existing script.
import importlib.util
_spec = importlib.util.spec_from_file_location(
    '_calib', os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           '_build_calibration_suite.py'))
_c = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_c)


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    img_dir = os.path.join(root, 'images', '_calibration')
    mesh_dir = os.path.join(root, 'meshes')
    mv_dir = os.path.join(img_dir, 'ref_0_multiview')
    os.makedirs(mv_dir, exist_ok=True)

    # Map the six user PNGs into the atlas cells we use.
    # Cell layout: row0 = front/right/back, row1 = left/top/bottom.
    face_files = {
        'front':  'calib_Front.png',
        'back':   'calib_Back.png',
        'right':  'calib_Right.png',
        'left':   'calib_Left.png',
        'top':    'calib_Top.png',
        'bottom': 'calib_Bottom.png',
    }

    # Load all 6 and resize to a common square size.
    face_size = 512
    faces = {}
    for name, fn in face_files.items():
        p = os.path.join(img_dir, fn)
        if not os.path.exists(p):
            raise FileNotFoundError(f'missing {p}')
        im = Image.open(p).convert('RGBA').resize(
            (face_size, face_size), Image.LANCZOS)
        faces[name] = im
        print(f'[calib-manual] loaded {fn} -> {im.size}')

    # Build atlas 3x2
    W = 3 * face_size
    H = 2 * face_size
    atlas = Image.new('RGBA', (W, H), (0, 0, 0, 255))
    layout = [
        ('front', 0, 0), ('right', 1, 0), ('back', 2, 0),
        ('left',  0, 1), ('top',   1, 1), ('bottom', 2, 1),
    ]
    for name, cx, cy in layout:
        tex = faces[name]
        # NO pre-flip here: the user-painted PNGs are already the
        # "natural" letter orientation and will read correctly on the
        # cube when mapped from outside (glTF convention).
        atlas.paste(tex, (cx * face_size, cy * face_size))

    # Save a debug copy of the atlas (for inspection only; NOT in images/
    # so it doesn't show up as an image version in the project UI).
    atlas_debug = os.path.join(mesh_dir, '_calibration_atlas.png')
    atlas.convert('RGB').save(atlas_debug)
    print(f'[calib-manual] wrote atlas: {atlas_debug}')

    # Build the subdivided cube using the existing logic but with our
    # hand-made atlas.
    print('[calib-manual] building cube mesh...')
    m = _c.build_cube_mesh(side=0.8)
    # The builder already set a synthetic atlas; replace with ours.
    material = _c.trimesh.visual.material.PBRMaterial(
        baseColorTexture=atlas,
        metallicFactor=0.0,
        roughnessFactor=0.85,
    )
    m.visual = _c.trimesh.visual.texture.TextureVisuals(
        uv=m.visual.uv, material=material,
    )
    gt_path = os.path.join(mesh_dir, '_calibration_groundtruth.glb')
    m.export(gt_path)
    print(f'[calib-manual] wrote ground-truth GLB: {gt_path}')

    # Re-render front + 6 multi-views using the existing orthographic
    # renderer, but with the hand-made atlas.
    print('[calib-manual] rendering front (azim=0 ortho)...')
    front = _c.render_textured_view(m, atlas, 0, 0, size=768,
                                    bg=(245, 245, 245))
    front.save(os.path.join(img_dir, 'ref_0.png'))
    front.save(os.path.join(mv_dir, 'input.png'))

    # Zero123++ v1.2 view angles (azim, elev)
    views = [(30, 20), (90, -10), (150, 20), (210, -10), (270, 20), (330, -10)]
    for i, (az, el) in enumerate(views):
        print(f'[calib-manual] rendering view_{i} (azim={az}, elev={el})...')
        v = _c.render_textured_view(m, atlas, az, el, size=768,
                                    bg=(255, 255, 255))
        v_rgba = v.convert('RGBA')
        arr = np.array(v_rgba)
        white = (arr[:, :, 0] > 240) & (arr[:, :, 1] > 240) & (arr[:, :, 2] > 240)
        arr[white, 3] = 0
        Image.fromarray(arr, 'RGBA').save(os.path.join(mv_dir, f'view_{i}.png'))

    print('\n[calib-manual] DONE.')
    print('  Cube textured with user faces, ref_0 + 6 multi-views regenerated.')
    print('  Reopen the _calibration project in FabMesh to see the new ref_0.')


if __name__ == '__main__':
    main()
