"""FabMesh — adjust GLB material properties post-bake.

Live-tunable knobs for the textured GLB:
  - brightness
  - saturation
  - contrast
  - emissive_factor (0=PBR-only, 1=fully self-lit)
  - metallic_factor (0=non-metal, 1=mirror)
  - roughness_factor (0=glossy, 1=matte)

Reads the input GLB's baseColorTexture, applies PIL ImageEnhance, and
re-exports a new GLB with adjusted material params. Idempotent because
each invocation starts from the source atlas in the bake's work dir
(if available) — otherwise from the GLB's embedded texture.

CLI:
    python mesh_material_adjust.py <in.glb> <out.glb>
        [--brightness 1.2] [--saturation 1.0] [--contrast 1.0]
        [--emissive 0.6] [--metallic 0.0] [--roughness 0.7]
        [--source-atlas <path.png>]    # optional pristine source

Returns JSON on stdout with the final values applied so the UI can
display them.
"""
from __future__ import annotations
import os
import sys
import json
import argparse
import trimesh
from PIL import Image, ImageEnhance


def adjust(in_glb, out_glb, brightness=1.2, saturation=1.0, contrast=1.0,
           emissive=0.6, metallic=0.0, roughness=0.7,
           source_atlas=None):
    m = trimesh.load(in_glb, force='mesh', process=False)
    if isinstance(m, trimesh.Scene):
        m = list(m.geometry.values())[0]

    # Source atlas: prefer the pristine bake output if given, else
    # the GLB-embedded texture (which may already have been adjusted
    # in a previous pass).
    if source_atlas and os.path.isfile(source_atlas):
        img = Image.open(source_atlas).convert('RGB')
        atlas_source = 'work_dir'
    elif hasattr(m.visual, 'material') and hasattr(m.visual.material,
                                                    'baseColorTexture'):
        img = m.visual.material.baseColorTexture.convert('RGB')
        atlas_source = 'glb_embedded'
    else:
        raise RuntimeError('No texture found in mesh and no --source-atlas given')

    # Apply enhancers in stable order: brightness → saturation → contrast
    if brightness != 1.0:
        img = ImageEnhance.Brightness(img).enhance(brightness)
    if saturation != 1.0:
        img = ImageEnhance.Color(img).enhance(saturation)
    if contrast != 1.0:
        img = ImageEnhance.Contrast(img).enhance(contrast)

    # Rebuild material with the adjusted texture + PBR factors.
    material = trimesh.visual.material.PBRMaterial(
        name='fabmesh_adjusted',
        baseColorTexture=img,
        emissiveTexture=img,
        emissiveFactor=[emissive, emissive, emissive],
        metallicFactor=metallic,
        roughnessFactor=roughness,
    )
    m.visual = trimesh.visual.TextureVisuals(uv=m.visual.uv, material=material)
    m.export(out_glb)

    return {
        'in': in_glb,
        'out': out_glb,
        'atlas_source': atlas_source,
        'applied': {
            'brightness': brightness,
            'saturation': saturation,
            'contrast': contrast,
            'emissive': emissive,
            'metallic': metallic,
            'roughness': roughness,
        },
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('in_glb')
    ap.add_argument('out_glb')
    ap.add_argument('--brightness', type=float, default=1.2)
    ap.add_argument('--saturation', type=float, default=1.0)
    ap.add_argument('--contrast', type=float, default=1.0)
    ap.add_argument('--emissive', type=float, default=0.6)
    ap.add_argument('--metallic', type=float, default=0.0)
    ap.add_argument('--roughness', type=float, default=0.7)
    ap.add_argument('--source-atlas', default=None)
    args = ap.parse_args()
    result = adjust(args.in_glb, args.out_glb,
                    brightness=args.brightness,
                    saturation=args.saturation,
                    contrast=args.contrast,
                    emissive=args.emissive,
                    metallic=args.metallic,
                    roughness=args.roughness,
                    source_atlas=args.source_atlas)
    print('MATERIAL_ADJUST_RESULT: ' + json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
