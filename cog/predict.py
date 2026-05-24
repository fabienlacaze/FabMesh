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
        task: str = Input(
            description="What this call produces. "
                        "text2image: enriched text prompt → 1 PNG (RealVisXL V4 or "
                        "DreamShaper-XL Lightning + ControlNet OpenPose for T-pose). "
                        "back-view: front image + prompt → 1 back-view PNG "
                        "(RealVisXL V4 + ControlNet OpenPose back skeleton + IP-Adapter). "
                        "The 3D mesh step lives in a separate Replicate model "
                        "(microsoft/TRELLIS.2-4B) and is NOT handled here.",
            choices=["text2image", "back-view"],
            default="text2image",
        ),
        prompt: str = Input(
            description="Text prompt. For text2image this is the user's idea "
                        "(asset_type + asset_style suffixes are appended). "
                        "For back-view it's a hint about the subject's outfit "
                        "(no need to mention 'back view' — we add that ourselves).",
            default="",
        ),
        image: Path = Input(
            description="Source image — required for task=back-view "
                        "(front image of the character to flip).",
            default=None,
        ),
        asset_style: str = Input(
            description="Visual style suffix appended to the prompt (matches "
                        "desktop's ASSET_STYLE_PROMPTS).",
            choices=["realistic", "stylized", "cartoon", "anime",
                     "low-poly", "pixel-art", "concept-art", "none"],
            default="realistic",
        ),
        asset_type: str = Input(
            description="Asset category — drives the prompt suffix.",
            choices=["character", "creature", "vehicle", "building",
                     "weapon", "prop", "environment", "icon", "custom"],
            default="character",
        ),
        seed: int = Input(default=0, ge=0, le=2**31 - 1,
            description="0 = random."),
        steps: int = Input(
            description="Diffusion steps. Desktop uses 30 for RealVisXL, 8 for the "
                        "DreamShaper-XL Lightning T-pose path (auto-detected).",
            default=30, ge=4, le=60,
        ),
    ) -> Path:
        t0 = time.time()
        work = tempfile.mkdtemp(prefix='myfabmesh_')
        print(f'[predict] task={task} workdir={work} asset={asset_type} '
              f'style={asset_style} prompt_chars={len(prompt or "")} '
              f'image={"yes" if image else "no"} seed={seed} steps={steps}',
              flush=True)

        if task == "text2image":
            if not prompt or not prompt.strip():
                raise ValueError("`prompt` is required for task=text2image.")
            enriched = _build_enriched_prompt(prompt.strip(), asset_type, asset_style)
            print(f'[predict] T→I via local_juggernaut_bridge.py — '
                  f'"{enriched[:140]}…"', flush=True)
            img_dir = os.path.join(work, 'gen_image')
            os.makedirs(img_dir, exist_ok=True)
            # local_juggernaut_bridge.py CLI:
            #   python local_juggernaut_bridge.py <prompt> <out_dir> <num_images> <steps>
            _run('local_juggernaut_bridge.py',
                 enriched, img_dir, '1', str(steps))
            refs = sorted(f for f in os.listdir(img_dir)
                          if f.startswith('ref_') and f.endswith('.png'))
            if not refs:
                raise RuntimeError('text→image produced no ref_*.png')
            out_path = os.path.join(img_dir, refs[0])

        elif task == "back-view":
            if image is None:
                raise ValueError("`image` is required for task=back-view.")
            mv_dir = os.path.join(work, 'back')
            os.makedirs(mv_dir, exist_ok=True)
            # generate_back_view.py CLI:
            #   python generate_back_view.py <front> <out_dir> <prompt_hint> <num_images>
            hint = (prompt or '').strip()
            _run('generate_back_view.py', str(image), mv_dir, hint, '1')
            # Script writes back_<stem>_<n>.png. Pick the first one.
            backs = sorted(f for f in os.listdir(mv_dir)
                           if f.startswith('back') and f.endswith('.png'))
            if not backs:
                raise RuntimeError('back-view produced no back_*.png')
            out_path = os.path.join(mv_dir, backs[0])

        else:
            raise ValueError(f"unknown task: {task}")

        dt = time.time() - t0
        print(f'[predict] DONE task={task} in {dt:.1f}s — out: {out_path}', flush=True)
        return Path(out_path)
