"""TRELLIS-2 image-to-3D — cloud version.

Mirrors `scripts/trellis2_native_full_pipeline.py` but as a pure function
that takes a PIL image and returns GLB bytes. The pipeline + o_voxel
post-processor are loaded ONCE in @modal.enter and reused per call.

CAUTION: TRELLIS-2 ships custom CUDA kernels (diffoctreerast, spconv,
mip-gaussian) that compile on first .cuda() call. Memory Snapshots
DON'T capture compiled CUDA state — the kernels recompile at every
cold restore. The cold-start UX depends on whether `pipeline.cuda()`
triggers compilation (~30-60s) or just memcpy (~5-10s). We measure
this on the POC and rollback to Replicate if compilation dominates.

License: MIT (microsoft/TRELLIS.2-4B) → we can redistribute.
"""
import io
import os
import time

import numpy as np
from PIL import Image, ImageEnhance


def prep_image(image: Image.Image) -> Image.Image:
    """Background removal via rembg u2net (Apache 2.0) — same as
    desktop pipeline. Skip if image already has a non-trivial alpha."""
    needs_rembg = True
    if image.mode == 'RGBA':
        a = np.asarray(image)[:, :, 3]
        if not (a == 255).all():
            needs_rembg = False
    if needs_rembg:
        import rembg
        image = rembg.remove(
            image.convert('RGBA'),
            session=rembg.new_session('u2net'))
    return image


def brighten_baseColor(glb_obj) -> None:
    """In-place +50% brightness / +30% sat / +10% contrast on
    baseColorTexture — compensates the ACES tonemap of glTF viewers
    (model-viewer / Babylon / Three.js KHR_lights_image_based). Same
    multipliers as desktop's trellis2_native_full_pipeline.py."""
    geoms = (list(glb_obj.geometry.values())
             if hasattr(glb_obj, 'geometry') else [glb_obj])
    for m in geoms:
        visual = getattr(m, 'visual', None)
        if not visual: continue
        material = getattr(visual, 'material', None)
        if not material: continue
        tex = getattr(material, 'baseColorTexture', None)
        if not tex: continue
        tex = ImageEnhance.Brightness(tex).enhance(1.5)
        tex = ImageEnhance.Color(tex).enhance(1.3)
        tex = ImageEnhance.Contrast(tex).enhance(1.1)
        material.baseColorTexture = tex


def generate(
    pipeline,                     # Trellis2ImageTo3DPipeline (already on GPU)
    o_voxel_module,               # imported o_voxel module
    front_img: Image.Image,
    back_img: Image.Image = None,  # optional, for multi-view conditioning
    mode: str = '1024',
    seed: int = 42,
    decimation_target: int = 500_000,
    texture_size: int = 2048,
    tex_steps: int = 0,           # 0 = garder le defaut d'environnement
) -> bytes:
    """Run TRELLIS-2 inference + GLB export. Returns the GLB bytes
    (caller pushes to R2). When `back_img` is provided, runs the
    multi-view conditioning path (mirror of the desktop fork's
    `scripts/trellis2_native_full_pipeline.py:main()` multi-view
    branch using pipeline.get_cond([front, back])). Otherwise runs
    single-view pipeline.run()."""
    import torch

    t0 = time.time()
    img = prep_image(front_img)
    print(f'[mesh] image prepared in {time.time()-t0:.1f}s size={img.size}', flush=True)
    mv_images = [img]
    if back_img is not None:
        back_prepped = prep_image(back_img)
        mv_images.append(back_prepped)
        print(f'[mesh] multi-view conditioning: 2 images (front + back)', flush=True)

    # Sharpen the texture bake — mirror of the desktop fix (2026-06-22): the
    # native path sampled tex_slat with {} -> pipeline.json defaults (steps=12,
    # guidance_strength=1.0, near-unconditional vs 7.5 for shape), giving a soft
    # bake. Raise steps + guidance (env-overridable). Validated A/B on desktop.
    # PALIERS DE QUALITE ENFIN REELS. Le menu Fast/Balanced/Quality/
    # Ultra 8K est facture 3/4/6/8 credits, mais son nombre de steps
    # (12/24/32) n'arrivait JAMAIS jusqu'ici : la valeur venait d'une
    # variable d'environnement, identique pour TOUS les jobs. Les quatre
    # paliers produisaient donc le meme travail GPU a quatre prix
    # differents (mesure : 373 s contre 420 s entre le palier bas et
    # celui a 8 credits, 13 % d'ecart pour un prix x2,7).
    #
    # tex_steps=0 conserve EXACTEMENT l'ancien comportement : aucune
    # regression si l'appelant ne precise rien.
    _tex_params = {
        'steps': int(tex_steps) if tex_steps and tex_steps > 0
                 else int(os.environ.get('FABMESH_TEX_STEPS', '24')),
        'guidance_strength': float(os.environ.get('FABMESH_TEX_GUIDANCE', '3.0')),
        'guidance_interval': [0.5, 1.0],
        # Audit fixes — see scripts/trellis2_native_full_pipeline.py for the rationale:
        # guidance_rescale 0.0->0.5 (anti color-wash) + rescale_t 3.0->1.5 (steps to detail).
        'guidance_rescale': float(os.environ.get('FABMESH_TEX_RESCALE', '0.5')),
        'rescale_t': float(os.environ.get('FABMESH_TEX_RESCALE_T', '1.5')),
    }
    try:
        if isinstance(getattr(pipeline, 'tex_slat_sampler_params', None), dict):
            pipeline.tex_slat_sampler_params.update(_tex_params)
    except Exception:
        pass
    print(f"[mesh] texture sampler: steps={_tex_params['steps']} "
          f"guidance={_tex_params['guidance_strength']} (sharpened)", flush=True)

    torch.manual_seed(seed)
    t_inf = time.time()
    o_voxel_obj = None
    vues_utilisees = len(mv_images)
    # REPLI MONO-VUE SI LE MULTI-VUES ECHOUE — ajoute le 2026-08-04.
    #
    # Ce chemin n'avait JAMAIS tourne en production : la vue arriere plantait
    # systematiquement en amont (xformers ecrasait les processeurs d'attention
    # de l'IP-Adapter, 0 succes sur 15 tentatives), donc `back_img` etait
    # toujours None. En reparant la vue arriere on l'a reveille, et il a
    # immediatement leve : « The size of tensor a (256) must match the size of
    # tensor b (128) at non-singleton dimension 3 ».
    #
    # Sans filet, cette exception fait echouer la generation ENTIERE — un
    # utilisateur qui demande une vue arriere se retrouverait avec rien du
    # tout, ce qui est pire qu'avant le correctif. On degrade donc vers le
    # mono-vue, qui fonctionne : le maillage sort, TRELLIS devine l'arriere.
    if len(mv_images) > 1 and mode in ('512', '1024'):
      try:
          # Multi-view path — verbatim port of
          # scripts/trellis2_native_full_pipeline.py:210-254 (the same
          # stage chain that runs on the user's desktop). Cascade modes
          # use single-view fallback because their `sample_shape_slat_cascade`
          # has extra constraints we haven't threaded through yet.
          cond_512 = pipeline.get_cond(mv_images, 512)
          cond_1024 = pipeline.get_cond(mv_images, 1024) if mode != '512' else None
          ss_res = {'512': 32, '1024': 64}[mode]
          coords = pipeline.sample_sparse_structure(cond_512, ss_res, 1, {})
          if mode == '512':
              shape_slat = pipeline.sample_shape_slat(
                  cond_512,
                  pipeline.models['shape_slat_flow_model_512'],
                  coords, {})
              tex_slat = pipeline.sample_tex_slat(
                  cond_512,
                  pipeline.models['tex_slat_flow_model_512'],
                  shape_slat, _tex_params)
              res = 512
          else:  # '1024'
              shape_slat = pipeline.sample_shape_slat(
                  cond_1024,
                  pipeline.models['shape_slat_flow_model_1024'],
                  coords, {})
              tex_slat = pipeline.sample_tex_slat(
                  cond_1024,
                  pipeline.models['tex_slat_flow_model_1024'],
                  shape_slat, _tex_params)
              res = 1024
          torch.cuda.empty_cache()
          o_voxel_obj = pipeline.decode_latent(shape_slat, tex_slat, res)
          if isinstance(o_voxel_obj, list):
              o_voxel_obj = o_voxel_obj[0]
      except Exception as e:
        print(f'[mesh] multi-vues ECHOUE, repli mono-vue : {e}', flush=True)
        o_voxel_obj = None
        vues_utilisees = 1
        torch.cuda.empty_cache()
    if o_voxel_obj is None:
        # Single-view path (or cascade fallback) — same as before.
        out = pipeline.run(img, num_samples=1, seed=seed,
                           pipeline_type=mode, preprocess_image=False)
        o_voxel_obj = out[0]
    print(f'[mesh] TRELLIS-2 inference dt={time.time()-t_inf:.1f}s '
          f'mode={mode} views={vues_utilisees}', flush=True)

    t_glb = time.time()
    glb_obj = o_voxel_module.postprocess.to_glb(
        vertices=o_voxel_obj.vertices,
        faces=o_voxel_obj.faces,
        attr_volume=o_voxel_obj.attrs,
        coords=o_voxel_obj.coords,
        attr_layout=o_voxel_obj.layout,
        voxel_size=o_voxel_obj.voxel_size,
        aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
        decimation_target=decimation_target,
        texture_size=texture_size,
        remesh=True,
        verbose=False,
    )
    print(f'[mesh] GLB export dt={time.time()-t_glb:.1f}s', flush=True)

    try:
        brighten_baseColor(glb_obj)
    except Exception as e:
        print(f'[mesh] brighten skipped: {e}', flush=True)

    # Serialize to bytes in-memory (trimesh's .export needs a path OR
    # a writeable file-like; BytesIO works).
    buf = io.BytesIO()
    glb_obj.export(buf, file_type='glb', extension_webp=True)
    glb_bytes = buf.getvalue()

    # EU AI Act art. 50 metadata — required by EU Regulation 2024/1689,
    # applicable from 2026-08-02. Marks the GLB as AI-generated. Same
    # patch as scripts/add_ai_metadata.py:patch_glb() on desktop.
    glb_bytes = _patch_ai_act_metadata(glb_bytes)

    print(f'[mesh] TOTAL dt={time.time()-t0:.1f}s bytes={len(glb_bytes)}', flush=True)
    return glb_bytes


def _patch_ai_act_metadata(glb_bytes: bytes) -> bytes:
    """Inject asset.extras.aiGenerated + asset.generator into the JSON
    chunk of a GLB. Returns a new GLB byte string. Compatible with the
    desktop `add_ai_metadata.py` so the cloud output is interchangeable
    with the desktop output."""
    import struct, json
    if len(glb_bytes) < 12 or glb_bytes[:4] != b'glTF':
        return glb_bytes
    version, total_length = struct.unpack('<II', glb_bytes[4:12])
    if version != 2:
        return glb_bytes
    json_chunk_len = struct.unpack('<I', glb_bytes[12:16])[0]
    json_chunk_type = glb_bytes[16:20]
    if json_chunk_type != b'JSON':
        return glb_bytes
    json_blob = glb_bytes[20:20 + json_chunk_len]
    rest = glb_bytes[20 + json_chunk_len:]
    try:
        gltf = json.loads(json_blob.decode('utf-8'))
    except Exception:
        return glb_bytes
    asset = gltf.setdefault('asset', {})
    asset['generator'] = 'FabMesh 1.0.0 (AI-generated)'
    extras = asset.setdefault('extras', {})
    extras['aiGenerated'] = True
    extras['aiSystem'] = 'FabMesh'
    extras['aiActArticle50'] = True
    # Re-serialize JSON, pad to 4-byte boundary.
    new_json = json.dumps(gltf, separators=(',', ':')).encode('utf-8')
    while len(new_json) % 4:
        new_json += b' '
    # Rebuild GLB header + chunks.
    new_total = 12 + 8 + len(new_json) + len(rest)
    header = b'glTF' + struct.pack('<II', 2, new_total)
    json_chunk = struct.pack('<I', len(new_json)) + b'JSON' + new_json
    return header + json_chunk + rest
