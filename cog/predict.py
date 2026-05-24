"""MyFabmesh.AI Cloud predictor.

Replicate calls Predictor.predict() with a JSON-serialisable input and
expects a Path back. We reuse the desktop app's `scripts/` modules so
the cloud output is byte-for-byte equivalent to what the desktop
generates with the same options.

Pipeline (matches main.js dispatch order):
    1. (optional) auto-rectify   → generate_front_strict.py
    2. trellis2 native           → trellis2_native_full_pipeline.py
    3. (optional) back-view      → generate_back_view.py (front+back fed to TRELLIS)
    4. (optional) texture smooth → texture_smooth.py
    5. (optional) face inpaint   → face_inpaint_atlas.py
    6. (optional) ultra HD 8K    → texture_upscale.py

We call each script via subprocess (they're argparse CLIs, not modules).
The first subprocess pays a one-time torch warmup; the Cog worker stays
warm between predictions so subsequent calls reuse the same Python env.
"""
from cog import BasePredictor, Input, Path
import os
import shutil
import subprocess
import sys
import tempfile
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.normpath(os.path.join(_HERE, '..'))
# Look for scripts as a sibling first (the GitHub Actions build copies
# scripts/ into cog/ so the Cog tarball is self-contained), then fall
# back to the repo layout for local dev runs.
_SCRIPTS_LOCAL = os.path.join(_HERE, 'scripts')
_SCRIPTS_REPO = os.path.join(_REPO_ROOT, 'scripts')
_SCRIPTS = _SCRIPTS_LOCAL if os.path.isdir(_SCRIPTS_LOCAL) else _SCRIPTS_REPO
_PY = sys.executable


# Mirror of src/renderer/index2.js ASSET_TYPE_PROMPTS + ASSET_STYLE_PROMPTS
# (kept verbatim so the Cog produces byte-identical prompts to the desktop).
_ASSET_TYPE_PROMPTS = {
    'character':   'single isolated 3D character, one character only, full body, T-pose neutral stance, arms extended horizontally, legs apart, strict front view, facing camera, symmetric, RTS unit game asset, plain white background, even studio lighting, no shadows, no other characters, centered, clean silhouette, no text, no UI',
    'building':    'ONE building only, single instance, isolated, full structure, plain white background, even studio lighting, no shadows, no characters, centered, isometric angle, clean silhouette, no text, no UI, no duplicate, no second building',
    'vehicle':     'ONE car only, single vehicle, only one instance, isolated, complete vehicle, plain white background, even studio lighting, no shadows, no characters, centered, strict front view, facing camera, clean silhouette, no text, no UI, no duplicate, no second car, no twin, no rear view inset',
    'weapon':      'ONE weapon only, single instance, isolated, full weapon, plain white background, even studio lighting, no shadows, centered, side profile, clean silhouette, no text, no UI, no duplicate',
    'prop':        'ONE prop only, single instance, isolated, full item, plain white background, even studio lighting, no shadows, no characters, centered, strict front view, clean silhouette, no text, no UI, no duplicate',
    'creature':    'ONE creature only, single instance, isolated, full body, neutral stance, front view, facing camera, symmetric, plain white background, even studio lighting, no shadows, no other creatures, centered, clean silhouette, no text, no UI, no duplicate',
    'environment': 'ONE environment piece only, single instance, isolated, full structure, plain white background, even studio lighting, no shadows, no characters, centered, strict front view, clean silhouette, no text, no UI, no duplicate',
    'icon':        'single flat icon, app icon, UI icon, ONE element only, isolated subject centered in square frame, transparent or pure white background, soft rim light, vibrant colors, clean silhouette, slight isometric 3/4 angle, glossy material, mobile / desktop application icon style, no text, no logo, no duplicate, no extra elements',
    'custom':      '',
}
_ASSET_STYLE_PROMPTS = {
    'realistic':   'realistic style, photorealistic, sharp details, detailed materials',
    'stylized':    'stylized art, mid-poly game asset, hand-painted textures, fantasy game style',
    'low-poly':    'low-poly 3D art, flat-shaded, faceted geometry, minimalist, geometric shapes, vibrant colors',
    'cartoon':     'cartoon style, bold outlines, cel-shading, vibrant flat colors, expressive shapes',
    'anime':       'anime style, soft cel-shading, expressive features, japanese animation aesthetic',
    'pixel-art':   'pixel art style, 16-bit retro game aesthetic, limited palette, sharp pixel edges',
    'concept-art': 'painterly style, brushstroke textures, hand-painted concept art look',
    'none':        '',
}


def _build_enriched_prompt(user_prompt: str, asset_type: str, asset_style: str) -> str:
    """Mirror of index2.js buildFullPrompt()."""
    style_prefix = _ASSET_STYLE_PROMPTS.get(asset_style, '')
    type_suffix = _ASSET_TYPE_PROMPTS.get(asset_type, '')
    parts = [p for p in (style_prefix, user_prompt, type_suffix) if p]
    return ', '.join(parts)


def _run(script: str, *args, env_extra: dict | None = None, timeout: int = 1800):
    """Invoke a pipeline script and stream its output to the Cog log."""
    cmd = [_PY, os.path.join(_SCRIPTS, script), *map(str, args)]
    env = os.environ.copy()
    env['PYTHONPATH'] = _SCRIPTS + os.pathsep + env.get('PYTHONPATH', '')
    if env_extra:
        env.update({k: str(v) for k, v in env_extra.items()})
    print(f'[predict] >>> {script} {" ".join(map(str, args))}', flush=True)
    t0 = time.time()
    proc = subprocess.run(cmd, env=env, cwd=_REPO_ROOT,
                          capture_output=False, timeout=timeout)
    dt = time.time() - t0
    print(f'[predict] <<< {script} exit={proc.returncode} dt={dt:.1f}s', flush=True)
    if proc.returncode != 0:
        raise RuntimeError(f'{script} failed (exit {proc.returncode})')


class Predictor(BasePredictor):
    """Loaded ONCE per worker. Cog keeps the worker warm between
    predictions; the first call pays cold-start (~30s + first-gen model
    download), subsequent calls reuse the cached weights on disk."""

    def setup(self):
        import torch
        self.device = 'cuda' if torch.cuda.is_available() else 'cpu'
        print(f'[predictor] device = {self.device}', flush=True)
        print(f'[predictor] scripts dir = {_SCRIPTS}', flush=True)
        print(f'[predictor] python = {_PY}', flush=True)

    def predict(
        self,
        image: Path = Input(
            description="Reference image (PNG / JPG). Optional if `prompt` is set.",
            default=None,
        ),
        prompt: str = Input(
            description="Text prompt — if `image` is empty, we run the desktop's "
                        "RealVisXL V4.0 pipeline (or DreamShaper-XL Lightning + "
                        "ControlNet OpenPose when the prompt asks for a T-pose) "
                        "to generate the source image first. The asset_type + "
                        "asset_style suffixes are appended automatically.",
            default="",
        ),
        asset_style: str = Input(
            description="Visual style suffix appended to the prompt (matches "
                        "desktop's ASSET_STYLE_PROMPTS).",
            choices=["realistic", "stylized", "cartoon", "anime",
                     "low-poly", "pixel-art", "concept-art", "none"],
            default="realistic",
        ),
        asset_type: str = Input(
            description="Asset category — drives the prompt suffix, the rectify "
                        "mode, the back-view engine choice, and the post-process pipeline.",
            choices=["character", "creature", "vehicle", "building",
                     "weapon", "prop", "environment", "icon", "custom"],
            default="character",
        ),
        mode: str = Input(
            description="Quality tier — matches desktop wizard modes",
            choices=["lite", "standard", "full"],
            default="standard",
        ),
        seed: int = Input(default=42, ge=0, le=2**31 - 1),
        gen_steps: int = Input(
            description="Diffusion steps for the optional text→image step (30 = desktop default).",
            default=30, ge=4, le=60,
        ),
        rectify: bool = Input(default=True,
            description="Auto-rectify the source to a canonical view (skipped when "
                        "image is generated from prompt — it's already canonical)."),
        back_view: bool = Input(default=True,
            description="Generate a back-view to improve mesh consistency (characters / creatures only)"),
        smooth: bool = Input(default=True,
            description="Bilateral filter on the base color atlas"),
        face_fix: bool = Input(default=False,
            description="SDXL inpaint on the face region (characters / creatures only)"),
        ultra_hd: bool = Input(default=False,
            description="Real-ESRGAN x2 texture upscale"),
        texture_size: int = Input(default=2048, ge=512, le=4096),
    ) -> Path:
        t0 = time.time()
        work = tempfile.mkdtemp(prefix='myfabmesh_')
        print(f'[predict] workdir = {work}', flush=True)
        print(f'[predict] image={"yes" if image else "no"} prompt_chars={len(prompt or "")} '
              f'asset={asset_type} style={asset_style} mode={mode} seed={seed} '
              f'rectify={rectify} back={back_view} smooth={smooth} '
              f'face={face_fix} hd={ultra_hd} tex={texture_size}',
              flush=True)

        # --- 0. TEXT → IMAGE (if no image was uploaded) ----------------
        # Mirrors src/main/main.js generate-images handler: build the
        # enriched prompt (style prefix + user prompt + asset suffix),
        # then call scripts/local_juggernaut_bridge.py exactly like the
        # desktop does. Output is ref_1.png 1024².
        if image is None:
            if not prompt or not prompt.strip():
                raise ValueError("Either `image` or `prompt` must be provided.")
            enriched = _build_enriched_prompt(prompt.strip(), asset_type, asset_style)
            print(f'[predict] T→I via local_juggernaut_bridge.py — '
                  f'"{enriched[:120]}…"', flush=True)
            img_dir = os.path.join(work, 'gen_image')
            os.makedirs(img_dir, exist_ok=True)
            _run('local_juggernaut_bridge.py',
                 enriched, img_dir, '1', str(gen_steps))
            # Pick the first ref_*.png produced.
            refs = sorted(f for f in os.listdir(img_dir) if f.startswith('ref_') and f.endswith('.png'))
            if not refs:
                raise RuntimeError('text→image step produced no ref_*.png')
            src_path = os.path.join(img_dir, refs[0])
            # Skip auto-rectify — the freshly-generated front is already canonical
            # (RealVisXL + STRICT_FRONT_TAIL suffix in our enriched prompt).
            rectify = False
            print(f'[predict] T→I produced {src_path}', flush=True)
        else:
            src_path = str(image)

        # --- 1. RECTIFY ------------------------------------------------
        if rectify and asset_type in ('character', 'creature', 'vehicle',
                                       'building', 'icon'):
            rectified = os.path.join(work, 'rectified.png')
            rectify_mode = 'front' if asset_type in ('character', 'creature') else 'iso'
            _run('generate_front_strict.py',
                 '--from-image', src_path,
                 '--mode', rectify_mode,
                 '--seeds', '3',
                 '_unused_prompt_',
                 rectified)
            if os.path.isfile(rectified):
                src_path = rectified

        # --- 2. BACK-VIEW (so TRELLIS-2 gets front + back together) ---
        # The desktop pipeline writes <stem>_multiview/view_*.png next to
        # the source image, and trellis2_native auto-detects that dir.
        if back_view and asset_type in ('character', 'creature'):
            mv_dir = os.path.join(work, 'multiview')
            os.makedirs(mv_dir, exist_ok=True)
            # generate_back_view writes back_<n>.png into out_dir.
            _run('generate_back_view.py', src_path, mv_dir, '', '1')
            # Rename to TRELLIS-2's expected view_1.png slot (view_0 = front).
            for fn in os.listdir(mv_dir):
                if fn.startswith('back') and fn.endswith('.png'):
                    shutil.move(os.path.join(mv_dir, fn),
                                os.path.join(mv_dir, 'view_1.png'))
                    break

        # --- 3. TRELLIS-2 GENERATION ----------------------------------
        mesh_out = os.path.join(work, 'mesh.glb')
        decim = {'lite': 100_000, 'standard': 500_000, 'full': 1_500_000}[mode]
        voxel_res = '1536' if mode == 'full' else '1024'
        env = {
            'FABMESH_TRELLIS2_NATIVE_MODE': voxel_res,
            'FABMESH_TRELLIS2_NATIVE_SEED': str(seed),
            'FABMESH_TRELLIS2_NATIVE_DECIM': str(decim),
        }
        if back_view and asset_type in ('character', 'creature'):
            env['FABMESH_TRELLIS2_MULTIVIEW_DIR'] = os.path.join(work, 'multiview')
        _run('trellis2_native_full_pipeline.py',
             src_path, mesh_out, str(texture_size),
             env_extra=env)

        # --- 4. TEXTURE SMOOTH ----------------------------------------
        if smooth:
            smoothed = os.path.join(work, 'mesh_smooth.glb')
            _run('texture_smooth.py', mesh_out, smoothed)
            if os.path.isfile(smoothed):
                mesh_out = smoothed

        # --- 5. FACE INPAINT ------------------------------------------
        if face_fix and asset_type in ('character', 'creature'):
            inpainted = os.path.join(work, 'mesh_face.glb')
            _run('face_inpaint_atlas.py', mesh_out, inpainted,
                 '--strength', '0.45')
            if os.path.isfile(inpainted):
                mesh_out = inpainted

        # --- 6. ULTRA HD 8K UPSCALE -----------------------------------
        if ultra_hd:
            upscaled = os.path.join(work, 'mesh_8k.glb')
            _run('texture_upscale.py', mesh_out, upscaled,
                 '--scale', '2', '--tile', '512')
            if os.path.isfile(upscaled):
                mesh_out = upscaled

        dt = time.time() - t0
        print(f'[predict] DONE in {dt:.1f}s — out: {mesh_out}', flush=True)
        return Path(mesh_out)
