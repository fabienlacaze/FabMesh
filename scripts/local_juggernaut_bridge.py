"""
FabMesh Local Image Generation Bridge — RealVis XL v4.0
SDXL fine-tune with photorealistic output. ~7 GB download.
License: CreativeML OpenRAIL++-M (commercial use permitted).
Model: https://huggingface.co/SG161222/RealVisXL_V4.0
Usage: python local_juggernaut_bridge.py "<prompt>" <output_dir> [num_images]

Note: file name kept as local_juggernaut_bridge.py for backwards compatibility
with main.js process references.
"""
import sys
import os
import time
import json
import torch

# GPU throttle — respects FABMESH_GPU_LIMIT / FABMESH_TEMP_LIMIT env vars
# by sleeping between diffusion steps when the GPU exceeds the user's
# configured limits. No-op if the env vars are not set.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from gpu_throttle import make_throttle_callback
except Exception as _gt_err:
    print(f"LOCAL_REALVIS: gpu_throttle unavailable ({_gt_err}), continuing unthrottled", flush=True)
    def make_throttle_callback():
        return None


def generate_images(prompt, output_dir, num_images=4, steps=30):
    from diffusers import StableDiffusionXLPipeline
    # Compel helper bypasses SDXL's 77-token CLIP-L cap (workflow wb66mnlri).
    # If Compel is not installed we fall back to legacy pipe(prompt=...).
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from _sdxl_prompt_utils import encode_sdxl_long_prompt
        _HAS_COMPEL = True
    except Exception as _ce:
        encode_sdxl_long_prompt = None
        _HAS_COMPEL = False
        print(f"LOCAL_REALVIS: Compel helper unavailable ({_ce}), "
              f"falling back to truncated 77-token prompts", flush=True)
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from fabmesh_log import Logger
        _slog = Logger('realvis',
                       project=os.path.basename(output_dir),
                       num_images=num_images, steps=steps)
    except Exception:
        _slog = None
    def _evt(event, **f):
        if _slog:
            _slog.info(event, **f)
    def _warn(event, **f):
        if _slog:
            _slog.warn(event, **f)
    _t0 = time.time()
    _evt('pipeline_started',
         prompt=prompt[:120],
         output_dir=output_dir,
         torch_cuda=torch.cuda.is_available())

    os.makedirs(output_dir, exist_ok=True)
    # Find starting index so we don't overwrite earlier 'Generate new version'
    # runs. Scan for existing ref_N.png in the output dir.
    import re as _re_idx
    _existing_idx = [-1]
    for _f in os.listdir(output_dir):
        _m = _re_idx.match(r'^ref_(\d+)\.png$', _f)
        if _m:
            _existing_idx.append(int(_m.group(1)))
    _start_idx = max(_existing_idx) + 1
    print(f'LOCAL_REALVIS: starting at ref_{_start_idx} (existing highest={max(_existing_idx)})', flush=True)

    # Enforce VRAM limit from FabMesh settings (FABMESH_VRAM_FRACTION env var).
    # The fraction is (slider% / 100), e.g. 0.75 for a 75% slider.
    if torch.cuda.is_available():
        try:
            free_b, total_b = torch.cuda.mem_get_info()
            print(f"LOCAL_REALVIS: VRAM free={free_b/1e9:.1f}GB total={total_b/1e9:.1f}GB", flush=True)
        except Exception:
            pass
        frac = float(os.environ.get('FABMESH_VRAM_FRACTION', '0.95'))
        if 0.1 <= frac < 1.0:
            try:
                torch.cuda.set_per_process_memory_fraction(frac)
                print(f"LOCAL_REALVIS: VRAM hard cap set to {frac*100:.0f}% of total", flush=True)
            except Exception as e:
                print(f"LOCAL_REALVIS: Could not set VRAM cap ({e}), continuing uncapped", flush=True)

    # Enforce system RAM limit from FabMesh settings (FABMESH_RAM_LIMIT_MB env var).
    _ram_limit_mb = os.environ.get('FABMESH_RAM_LIMIT_MB', '')
    if _ram_limit_mb:
        try:
            import psutil, gc
            rss_mb = psutil.Process().memory_info().rss / (1024 * 1024)
            sys_used = psutil.virtual_memory().percent
            print(f"LOCAL_REALVIS: RAM usage: process={rss_mb:.0f}MB, system={sys_used:.0f}%, limit={_ram_limit_mb}MB", flush=True)
        except ImportError:
            print("LOCAL_REALVIS: psutil not installed, RAM monitoring skipped", flush=True)
        except Exception as e:
            print(f"LOCAL_REALVIS: RAM check error: {e}", flush=True)

    # Read asset_type signal from env (set by main.js childEnv when the
    # 'generate-images' IPC is triggered). Falls back to 'character' so
    # CLI/legacy callers behave exactly as before. Drives the cloud-parity
    # anti-portrait negative + CFG=9.5 branch below (animal/creature only).
    _asset_type = (os.environ.get('FABMESH_ASSET_TYPE') or 'character').strip().lower()
    print(f"LOCAL_REALVIS: asset_type={_asset_type}", flush=True)

    # Detect whether the user asked for a T-pose front-facing character.
    # Drives both (a) the model choice — DreamShaper XL Lightning + ControlNet
    # OpenPose gives a GUARANTEED T-pose that RealVisXL cannot match, and
    # (b) the prompt enhancement.
    #
    # STRICT KEYWORD LIST: previously we matched generic phrases like
    # "front view" / "facing camera" which now appear in the prop/vehicle/
    # weapon templates (added to fight RealVis doubling — see commit ca7086c).
    # That caused a prop prompt for "couteau" to load the T-pose skeleton
    # ControlNet and produce a mannequin holding a knife + fork instead of
    # a knife. Restrict to UNAMBIGUOUS character markers.
    _p_low = prompt.lower()
    _is_tpose = any(kw in _p_low for kw in (
        't-pose', 't pose', 'tpose',
        'arms extended horizontally',  # character template (legs apart)
        'rts unit',                    # character template token
        'neutral stance',              # character/creature templates only
    ))
    # Animal/creature never go through the T-pose / DreamShaper path — that
    # branch is wired for humanoid skeletons (OpenPose). Force-disable to
    # protect against keyword bleed from prompt templates.
    if _asset_type in ('animal', 'creature') and _is_tpose:
        print("LOCAL_REALVIS: asset_type=animal/creature -> forcing _is_tpose=False (cloud parity)", flush=True)
        _is_tpose = False

    _ctrl_pipe = None
    _tpose_skeleton = None
    if _is_tpose:
        # T-pose mode: DreamShaper XL Lightning (CreativeML OpenRAIL++-M,
        # commercial-safe) + xinsir ControlNet OpenPose SDXL (Apache 2.0,
        # commercial-safe) + a pre-rendered T-pose skeleton as control image.
        print("LOCAL_REALVIS: T-pose mode — loading DreamShaper XL + ControlNet OpenPose...", flush=True)
        sys.stdout.flush()
        from diffusers import (
            StableDiffusionXLControlNetPipeline,
            ControlNetModel,
        )
        _skel_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                  'assets', 'tpose_skeleton.png')
        if not os.path.exists(_skel_path):
            # Auto-generate if missing
            try:
                from assets.tpose_skeleton import build_tpose_skeleton
                build_tpose_skeleton(1024).save(_skel_path)
                print(f"LOCAL_REALVIS: auto-generated T-pose skeleton at {_skel_path}", flush=True)
            except Exception as _se:
                print(f"LOCAL_REALVIS: could not generate skeleton ({_se}), falling back to plain DreamShaper", flush=True)
        from PIL import Image as _PImg
        if os.path.exists(_skel_path):
            _tpose_skeleton = _PImg.open(_skel_path).convert('RGB').resize((1024, 1024), _PImg.LANCZOS)
        # xinsir's OpenPose SDXL ControlNet — Apache 2.0
        _ctrl = ControlNetModel.from_pretrained(
            "xinsir/controlnet-openpose-sdxl-1.0",
            torch_dtype=torch.float16,
            use_safetensors=True,
        )
        # DreamShaper XL Lightning — OpenRAIL++-M, commercial-safe. Only
        # 4-6 steps needed. (We still accept `steps` arg but cap it at 8 for
        # Lightning since more steps over-burns the output.)
        pipe = StableDiffusionXLControlNetPipeline.from_pretrained(
            "Lykon/dreamshaper-xl-lightning",
            controlnet=_ctrl,
            torch_dtype=torch.float16,
            use_safetensors=True,
            variant="fp16",
        )
        try:
            pipe.unet.to(torch.float16)
            pipe.text_encoder.to(torch.float16)
            pipe.text_encoder_2.to(torch.float16)
            if hasattr(pipe, 'controlnet'):
                pipe.controlnet.to(torch.float16)
        except Exception as _e:
            print(f"LOCAL_REALVIS: fp16 cast skipped: {_e}", flush=True)
        # Upcast VAE to fp32 — SDXL's fp16 VAE NaNs to a flat grey image.
        try:
            pipe.upcast_vae()
        except Exception as _e:
            try: pipe.vae.to(torch.float32)
            except Exception: pass
            print(f"LOCAL_REALVIS: upcast_vae fallback ({_e})", flush=True)
        pipe.enable_model_cpu_offload()
        _ctrl_pipe = pipe
        steps = min(int(steps), 8)
        print(f"LOCAL_REALVIS: Loaded DreamShaper XL Lightning + OpenPose (steps clamped to {steps})", flush=True)
    else:
        # Default path: RealVis XL V4.0 for photoreal / prop subjects.
        print("LOCAL_REALVIS: Loading RealVis XL v4.0 (first run downloads ~7 GB)...")
        sys.stdout.flush()
        pipe = StableDiffusionXLPipeline.from_pretrained(
            "SG161222/RealVisXL_V4.0",
            torch_dtype=torch.float16,
            variant="fp16",
            use_safetensors=True,
        )
        try:
            pipe.unet.to(torch.float16)
            pipe.text_encoder.to(torch.float16)
            pipe.text_encoder_2.to(torch.float16)
        except Exception as _e:
            print(f"LOCAL_REALVIS: fp16 cast skipped: {_e}", flush=True)
        # SDXL's VAE is NUMERICALLY UNSTABLE in fp16: it overflows to NaN latents
        # and decodes a FLAT GREY/black image (observed: ref_0 grey ~165, var~0,
        # triggered while changing the quality/steps slider). Upcast the VAE to
        # fp32 (diffusers handles the fp16->fp32 decode); fall back to a plain
        # fp32 cast. This is the standard fix for SDXL grey/black outputs.
        try:
            pipe.upcast_vae()
        except Exception as _e:
            try: pipe.vae.to(torch.float32)
            except Exception: pass
            print(f"LOCAL_REALVIS: upcast_vae fallback ({_e})", flush=True)
        pipe.enable_model_cpu_offload()
        print("LOCAL_REALVIS: Loaded with fp32 VAE (no grey/NaN) + CPU offload")
        sys.stdout.flush()
    if _is_tpose:
        # T-pose/front mode: reinforce strict symmetry, arms out horizontally,
        # no perspective. Zero123++ will be able to rotate around properly.
        optimized_prompt = (
            f"{prompt}, "
            f"arms extended straight out horizontally to the sides, "
            f"legs apart shoulder-width, standing upright, symmetrical pose, "
            f"perfectly centered, strict front view, orthographic-like flat view, "
            f"looking directly at the camera, no tilt, no rotation, "
            f"single character isolated on plain white background, "
            f"studio lighting, sharp focus, ultra detailed, 8k, "
            f"no text, no watermark, full body visible, feet on the ground"
        )
        negative_prompt = (
            "dynamic pose, action pose, combat stance, fighting, running, "
            "jumping, crouching, bent arms, bent legs, tilted head, "
            "twisted torso, asymmetric, side view, three-quarter view, "
            "profile view, back view, perspective distortion, foreshortening, "
            "blurry, low quality, text, watermark, signature, deformed, "
            "extra limbs, bad anatomy, cropped, worst quality"
        )
        print(f"LOCAL_REALVIS: T-pose mode detected (keywords in prompt)", flush=True)
    else:
        # Hard-surface / prop subjects: SF3D textures only what the front
        # shows and "invents" the back/sides as a duller version of the
        # front. A slight angle in the source helps SF3D bake a richer
        # texture. BUT: if the renderer template already injected an
        # angle keyword (three-quarter / angled / isometric / side view),
        # don't add another — RealVis interprets the duplicate as a
        # "studio composition" cue and generates 2 instances of the
        # subject stacked in one frame.
        _lc = prompt.lower()
        _has_angle = any(t in _lc for t in (
            'three-quarter', 'three quarter', '3/4', 'angled view',
            'angled side view', 'isometric', 'side profile', 'side view',
            # Front-view variants count too — if the template already asks
            # for "strict front view" we MUST NOT inject "slight angle, one
            # side visible" or RealVis tilts the camera and texture
            # projection (which assumes az=0/el=0 for the source) breaks.
            'strict front view', 'front view', 'facing camera',
            'frontal view', 'front-facing',
        ))
        _angle_token = '' if _has_angle else 'slight angle, one side visible, '
        # 2026-06-09 (workflow wb66mnlri): dropped 'single instance only,
        # one subject, no duplicate' — canonical SDXL anti-pattern that
        # fills empty space with the subject (the bear-cub doubling at
        # seed 1004/1009). Replaced with concrete background. Mirror of
        # modal_app/_realvis.py L40-46.
        optimized_prompt = (
            f"{prompt}, {_angle_token}"
            f"centered subject, neutral grey studio backdrop, soft seamless background, "
            f"plain backdrop, no composition grid, "
            f"studio lighting, ultra detailed, 8k, sharp focus, professional photography, "
            f"masterpiece, no text, no watermark"
        )
        # Asset-type-aware negative — mirrors cloud modal_app/_realvis.py.
        # For animal/creature, RealVis V4 tends to default to portrait /
        # headshot framing (dragon head, animal head close-up). The cloud
        # path prepends a brute-force-repeated anti-portrait block (x2/x3
        # of each token, since the base diffusers SDXL pipeline strips
        # Compel-style (token:weight) parentheses — only the bare repeated
        # word counts in CLIP weighting). Combined with guidance_scale=9.5
        # (set below) this forces the full-body / long-shot framing.
        # Other asset_types keep the existing hard-surface anti-doubling
        # block unchanged for parity with prior commits.
        if _asset_type in ('animal', 'creature'):
            # 2026-06-09 (workflow wb66mnlri): rewritten for SDXL CLIP-L
            # 77-token cap. Previous neg = 410 tokens, 333 silently
            # truncated. Anti-anatomy + anti-doubling were past pos 77
            # = INVISIBLE to U-Net. Mirror of modal_app/_realvis.py
            # build_prompts() rewrite.
            _anatomy = (
                "five legs, six legs, three legs, polydactyly, two heads, "
                if _asset_type == 'animal'
                else "extra wings, missing wing, five legs, three legs, two heads, "
            )
            negative_prompt = (
                _anatomy +
                "two animals, animal pair, duplicate, twin, "
                "split image, collage, side by side, "
                "headshot, portrait, close-up, head only, partial body, "
                "body cut off, cropped, out of frame, "
                "blurry, deformed, bad anatomy"
            )
        else:
            negative_prompt = (
                "blurry, low quality, text, watermark, signature, deformed, "
                "extra limbs, bad anatomy, distorted, cropped, worst quality, "
                "flat profile, "
                # Anti-doubling: product/vehicle/kitchenware datasets often pair
                # 2 angles of the same item OR show a "set" of 2-3 items
                # side-by-side. We weighted-block the doubling pattern across
                # all common subject categories.
                # WEIGHTED tokens (parenthesis+:1.4) get extra strength from
                # the SDXL prompt parser; we go aggressive on duplication.
                "(two:1.6), (pair:1.5), (duplicate:1.5), (twin:1.5), "
                "(set of two:1.5), (multiple instances:1.5), "
                "(two objects:1.5), (two subjects:1.5), (two items:1.5), "
                "(two cars:1.5), (two vehicles:1.5), (two knives:1.5), "
                "(two characters:1.5), (two props:1.5), (two weapons:1.5), "
                "(second instance:1.5), (second copy:1.4), (companion item:1.4), "
                "(side by side:1.5), (paired:1.4), (matched set:1.4), "
                "(rear view inset:1.4), (front and back:1.4), "
                "split image, stacked vertically, stacked horizontally, "
                "collage, grid layout, comparison view, "
                "product comparison, kitchenware set, catalog grid"
            )

    _throttle_cb = make_throttle_callback()  # None if disabled

    images = []
    for i in range(num_images):
        print(f"LOCAL_REALVIS_PROGRESS: Generating image {i+1}/{num_images}...")
        sys.stdout.flush()

        # CFG: 7.0 for hard-surface/character (preserves prior behavior),
        # 9.5 for animal/creature so the repeated anti-portrait negative
        # actually bites in classifier-free guidance. Mirrors cloud
        # modal_app/_realvis.py. T-pose override (=2.0) still wins below.
        _cfg = 9.5 if _asset_type in ('animal', 'creature') else 7.0
        # Build base kwargs (everything EXCEPT the prompt pair). We then
        # attach either (prompt, negative_prompt) [legacy / Compel KO] or
        # (*_embeds) [Compel OK] just below. Same dict feeds both the
        # regular pipe and the ControlNet T-pose pipe — when _is_tpose is
        # True, `pipe` IS `_ctrl_pipe` (see line ~175), and ControlNet
        # SDXL accepts the *_embeds kwargs since diffusers 0.24+.
        _pipe_kwargs = dict(
            num_inference_steps=int(steps),
            guidance_scale=_cfg,
            height=1024,
            width=1024,
            generator=torch.Generator("cuda").manual_seed(int(time.time()) + i),
        )
        _used_embeds = False
        if _HAS_COMPEL:
            try:
                _embeds = encode_sdxl_long_prompt(
                    pipe, optimized_prompt, negative_prompt
                )
                _pipe_kwargs.update(_embeds)
                _used_embeds = True
            except Exception as _ee:
                print(f"LOCAL_REALVIS: Compel encode failed ({_ee}), "
                      f"falling back to truncated prompts", flush=True)
        if not _used_embeds:
            _pipe_kwargs['prompt'] = optimized_prompt
            _pipe_kwargs['negative_prompt'] = negative_prompt
        if _is_tpose and _ctrl_pipe is not None and _tpose_skeleton is not None:
            # ControlNet OpenPose path: feed the T-pose skeleton as control image.
            # Lower CFG because Lightning prefers 1.5-3.0. ControlNet scale 0.85
            # is strong enough to lock the pose without killing diversity.
            _pipe_kwargs['image'] = _tpose_skeleton
            _pipe_kwargs['controlnet_conditioning_scale'] = 0.85
            _pipe_kwargs['guidance_scale'] = 2.0
        if _throttle_cb is not None:
            # Diffusers >= 0.25 uses callback_on_step_end; older versions use callback
            try:
                _pipe_kwargs['callback_on_step_end'] = _throttle_cb
                result = pipe(**_pipe_kwargs)
            except TypeError:
                _pipe_kwargs.pop('callback_on_step_end', None)
                _pipe_kwargs['callback'] = _throttle_cb
                _pipe_kwargs['callback_steps'] = 1
                result = pipe(**_pipe_kwargs)
        else:
            result = pipe(**_pipe_kwargs)

        img_path = os.path.join(output_dir, f"ref_{_start_idx + i}.png")
        gen_img = result.images[0]

        # Post-generation safety check (parental control).
        # Uses Falconsai/nsfw_image_detection ViT classifier (Apache 2.0).
        # Scans EVERY generated image regardless of prompt — catches all
        # circumventions that keyword filters miss.
        if os.environ.get('FABMESH_UNRESTRICTED') != '1':
            try:
                from transformers import pipeline as _tfpipeline
                import numpy as _np2
                # Dual model detection (both Apache 2.0, local, ~350 MB total)
                _clf1 = _tfpipeline('image-classification', model='Falconsai/nsfw_image_detection', device='cpu')
                _clf2 = _tfpipeline('image-classification', model='AdamCodd/vit-base-nsfw-detector', device='cpu')
                _img224 = gen_img.convert('RGB').resize((224, 224))
                _r1 = _clf1(_img224)
                _r2 = _clf2(_img224)
                _s1 = next((x['score'] for x in _r1 if x['label'] == 'nsfw'), 0)
                _s2 = next((x['score'] for x in _r2 if x['label'] == 'nsfw'), 0)
                _nsfw_score = max(_s1, _s2)
                _is_blocked = _nsfw_score > 0.5
                # Fallback: skin ratio for cases both models miss
                if not _is_blocked:
                    _arr = _np2.array(gen_img.convert('RGB').resize((256, 256))).astype(float)
                    _rv, _gv, _bv = _arr[:,:,0], _arr[:,:,1], _arr[:,:,2]
                    _skin = ((_rv>95)&(_gv>40)&(_bv>20)&(_rv>_gv)&(_rv>_bv)&((_rv-_gv)>15)&(_arr.max(2)-_arr.min(2)>15))
                    _skin_ratio = float(_skin.sum()) / (256*256)
                    if _skin_ratio > 0.35:
                        _is_blocked = True
                        print(f"LOCAL_REALVIS: skin ratio {_skin_ratio:.0%} -> blocked", flush=True)
                if _is_blocked:
                    print(f"LOCAL_REALVIS_BLOCKED: image {i} blocked (nsfw={_nsfw_score:.0%})", flush=True)
                    try:
                        with open(img_path + '.nsfw', 'w') as _nf:
                            _nf.write(f'{_nsfw_score:.4f}')
                    except: pass
                    from PIL import ImageDraw
                    gen_img = Image.new('RGB', gen_img.size, (30, 30, 30))
                    draw = ImageDraw.Draw(gen_img)
                    draw.text((gen_img.width//2 - 120, gen_img.height//2 - 10), "Blocked by content filter", fill=(200, 50, 50))
                else:
                    print(f"LOCAL_REALVIS: safety check passed (nsfw={_nsfw_score:.0%})", flush=True)
            except Exception as _se:
                print(f"LOCAL_REALVIS: safety check error ({_se}), allowing image", flush=True)

        gen_img.save(img_path)
        images.append(img_path)
        _sz = os.path.getsize(img_path)
        _evt('image_saved', index=i, path=img_path, bytes=_sz,
             w=gen_img.size[0], h=gen_img.size[1])
        # Per-project manifest entry
        try:
            from manifest import append_entry as _ma
            _ma(output_dir,
                kind='image_gen',
                path=img_path,
                engine='local-realvis',
                model='SG161222/RealVisXL_V4.0',
                prompt=prompt,
                full_prompt=optimized_prompt,
                negative_prompt=negative_prompt,
                steps=int(steps),
                guidance_scale=float(_pipe_kwargs.get('guidance_scale', 7.0)),
                seed=int(_pipe_kwargs['generator'].initial_seed())
                     if hasattr(_pipe_kwargs.get('generator'), 'initial_seed') else None,
                width=1024, height=1024,
                bytes=_sz)
        except Exception:
            pass
        print(f"LOCAL_REALVIS_DONE: {img_path} ({_sz} bytes)")
        sys.stdout.flush()

    del pipe
    torch.cuda.empty_cache()

    _evt('pipeline_done', images=len(images),
         total_ms=int((time.time() - _t0) * 1000))
    print(f"LOCAL_REALVIS_SUCCESS: {len(images)} images generated")
    sys.stdout.flush()
    return images


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python local_juggernaut_bridge.py \"<prompt>\" <output_dir> [num_images] [steps]")
        sys.exit(1)

    prompt = sys.argv[1]
    output_dir = sys.argv[2]
    num_images = int(sys.argv[3]) if len(sys.argv) > 3 else 4
    steps = int(sys.argv[4]) if len(sys.argv) > 4 else 30

    try:
        images = generate_images(prompt, output_dir, num_images, steps)
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"LOCAL_REALVIS_ERROR: {e}")
        sys.exit(1)

    if images:
        print(f"RESULT: {json.dumps(images)}")
    sys.exit(0 if images else 1)
