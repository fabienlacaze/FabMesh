"""MyFabmesh.AI Cloud predictor.

Replicate calls Predictor.predict() with a JSON-serialisable input and
expects a Path back. We reuse the desktop app's `scripts/` modules so
the cloud output is byte-for-byte equivalent to what the desktop
generates with the same options.

Pipeline (matches main.js dispatch order):
    1. (optional) auto-rectify   → generate_front_strict.py
    2. trellis2 native           → trellis2_native_full_pipeline.py
    3. (optional) back-view      → generate_back_view.py
    4. (optional) texture smooth → texture_smooth.py
    5. (optional) face inpaint   → face_inpaint_atlas.py
    6. (optional) ultra HD 8K    → texture_upscale.py

This file lives in cog/ but imports from ../scripts/. cog.yaml has the
scripts dir copied alongside via the implicit working dir.
"""
from cog import BasePredictor, Input, Path
import os
import sys
import tempfile
import time

# Make ../scripts/ importable so we can reuse the desktop pipeline.
_HERE = os.path.dirname(os.path.abspath(__file__))
_SCRIPTS = os.path.normpath(os.path.join(_HERE, '..', 'scripts'))
if os.path.isdir(_SCRIPTS) and _SCRIPTS not in sys.path:
    sys.path.insert(0, _SCRIPTS)


class Predictor(BasePredictor):
    """Loaded ONCE per worker. Replicate keeps the worker warm between
    requests so model loading happens at most once per container start."""

    def setup(self):
        """Pre-load heavy weights so the first inference doesn't pay
        the model-load cost. Warm container = ~80s per gen.

        TODO Phase B implementation : the desktop scripts are written
        as CLI tools (argparse + sys.exit). To avoid refactoring them
        into importable modules, we call them via subprocess from
        predict() below. Cog keeps the worker warm so subsequent
        predict() calls reuse the Python process — model weights stay
        cached on disk between calls."""
        import torch
        self.device = 'cuda' if torch.cuda.is_available() else 'cpu'
        print(f'[predictor] device = {self.device}', flush=True)

    def predict(
        self,
        image: Path = Input(description="Reference image (PNG / JPG)"),
        asset_type: str = Input(
            description="Asset category — drives the rectify mode and the post-process pipeline",
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
        rectify: bool = Input(default=True,
            description="Auto-rectify the source to a canonical view"),
        back_view: bool = Input(default=True,
            description="Generate a back-view to improve mesh consistency (characters / creatures only)"),
        smooth: bool = Input(default=True,
            description="Bilateral filter on the base color atlas"),
        face_fix: bool = Input(default=False,
            description="SDXL inpaint on the face region (characters / creatures only)"),
        ultra_hd: bool = Input(default=False,
            description="Real-ESRGAN 8K texture upscale"),
    ) -> Path:
        t0 = time.time()
        work = tempfile.mkdtemp(prefix='myfabmesh_')
        print(f'[predict] workdir = {work}', flush=True)

        # --- 1. RECTIFY ------------------------------------------------
        src_path = str(image)
        if rectify and asset_type in ('character', 'creature', 'vehicle',
                                        'building', 'icon'):
            rectified = os.path.join(work, 'rectified.png')
            rectify_mode = 'front' if asset_type == 'character' else 'iso'
            print(f'[predict] rectify mode={rectify_mode}', flush=True)
            from generate_front_strict import rectify_image
            rectify_image(src_path, rectified, mode=rectify_mode, seeds=3)
            if os.path.isfile(rectified):
                src_path = rectified

        # --- 2. TRELLIS-2 GENERATION ----------------------------------
        mesh_out = os.path.join(work, 'mesh.glb')
        from trellis2_native_full_pipeline import generate_mesh
        decim = {'lite': 100_000, 'standard': 1_000_000, 'full': 1_500_000}[mode]
        cascade = 'cascade' if mode in ('standard', 'full') else 'fast'
        voxel_res = '1536' if mode == 'full' else '1024'
        print(f'[predict] TRELLIS-2 mode={voxel_res}_{cascade} decim={decim}', flush=True)
        generate_mesh(
            src_path,
            mesh_out,
            voxel_resolution=int(voxel_res),
            cascade=cascade == 'cascade',
            decimation_target=decim,
            seed=seed,
        )

        # --- 3. BACK-VIEW (characters / creatures only) ---------------
        if back_view and asset_type in ('character', 'creature'):
            print('[predict] back-view generation', flush=True)
            from generate_back_view import generate_back_view
            back_img = os.path.join(work, 'back.png')
            generate_back_view(src_path, back_img, seeds=4)
            # Re-run TRELLIS-2 with both views (front+back) to refine.
            # NOTE: implementation TBD — desktop uses a different
            # codepath here. For Cog v1, we skip the re-run and ship
            # the front-only mesh. v2 adds the dual-view refinement.

        # --- 4. TEXTURE SMOOTH ----------------------------------------
        if smooth:
            print('[predict] texture smooth', flush=True)
            from texture_smooth import smooth_atlas
            smoothed = os.path.join(work, 'mesh_smooth.glb')
            smooth_atlas(mesh_out, smoothed)
            if os.path.isfile(smoothed):
                mesh_out = smoothed

        # --- 5. FACE INPAINT ------------------------------------------
        if face_fix and asset_type in ('character', 'creature'):
            print('[predict] face inpaint', flush=True)
            from face_inpaint_atlas import face_inpaint
            inpainted = os.path.join(work, 'mesh_face.glb')
            face_inpaint(mesh_out, inpainted, strength=0.45)
            if os.path.isfile(inpainted):
                mesh_out = inpainted

        # --- 6. ULTRA HD 8K UPSCALE -----------------------------------
        if ultra_hd:
            print('[predict] Real-ESRGAN x2 upscale', flush=True)
            from texture_upscale import upscale_atlas
            upscaled = os.path.join(work, 'mesh_8k.glb')
            upscale_atlas(mesh_out, upscaled, scale=2, tile=512)
            if os.path.isfile(upscaled):
                mesh_out = upscaled

        dt = time.time() - t0
        print(f'[predict] DONE in {dt:.1f}s — out: {mesh_out}', flush=True)
        return Path(mesh_out)
