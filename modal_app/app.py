"""MyFabmesh.AI Cloud — Modal app (POC: text2image only).

Why Modal vs Replicate (recap):
    Replicate L40S w/ Cog: $0.000975/s × (87s setup + 35s inference) = $0.12 / image
    Modal    L40S w/ snap: $0.000542/s × (~5s restore + 35s inference) = $0.022 / image
    → ~5.5× cost reduction + cold start UX goes from 90s to ~5s.

The trick is Memory Snapshots: @modal.enter(snap=True) loads weights
to CPU memory ONCE; Modal snapshots that memory state; subsequent cold
restores rehydrate the snapshot in seconds instead of re-downloading
the 12GB of HF weights from scratch.

DEPLOY:
    pip install modal
    modal token new                # one-time, opens browser to authenticate
    modal deploy modal_app/app.py  # builds image (~5-10 min first time),
                                   #   then publishes the app

INVOKE (once deployed):
    The class methods are exposed at:
      https://<workspace>--myfabmesh-cloud-myfabmeshpredictor-text2image.modal.run
    (Modal generates the URL on `modal deploy` output. Worker
    integrates via the URL set in env MODAL_TEXT2IMAGE_URL.)

NOTE: Do not name this directory `modal/` — Python would shadow the
Modal SDK. We use `modal_app/`.
"""
import io
import os
import sys
import time

import modal


# ---------------------------------------------------------------------------
# HARD FLOOR — illegal content (CSAM / child abuse) blocked on EVERY
# generation, regardless of the `unrestricted` flag. Mirrors checkHardFloor
# in src/main/main.js and cloud/src/nsfw_filter.ts. The Worker pre-filters
# prompts too, but this is the unbypassable last line at the generator.
# ---------------------------------------------------------------------------
_HARD_FLOOR_KEYWORDS = (
    "pedophil", "paedophil", "pédophil", "loli", "shota", "lolicon",
    "shotacon", "child abuse", "toddler abuse", "infant abuse",
    "child porn", "childporn",
)
_HF_MINOR = (
    "child", "children", "kid", "kids", "boy", "girl", "teen", "teenager",
    "young", "infant", "baby", "toddler", "minor", "preteen", "schoolgirl",
    "schoolboy", "enfant", "fille", "garcon", "jeune", "ado", "adolescent",
    "gamin", "gamine", "bebe",
)
_HF_SEXUAL = (
    "without clothes", "no clothes", "unclothed", "undressed", "disrobed",
    "bare", "exposed", "revealing", "intimate", "sensual", "seductive",
    "provocative", "suggestive", "sexy", "hot", "bath", "shower", "bedroom",
    "bed", "diaper only", "lingerie", "underwear", "panties",
    "bra", "bikini", "swimsuit", "naked", "nude", "nsfw", "sexual",
    "erotic", "porn", "deshabill", "sans vetement", "sans habit",
    "nu ", "nue ", "nus ", "nues",
)
_HF_VIOLENCE = (
    "hurt", "hit", "beat", "punch", "slap", "abuse", "attack", "weapon",
    "knife", "gun", "shoot", "bleed", "cry", "scream", "pain", "suffer",
    "frapper", "battre", "blesser",
)


def _hf_match(text: str, kw: str) -> bool:
    """Word-boundary match for short tokens (<=4), substring for longer —
    mirrors _matchesKeyword in the JS filters (avoids 'menu' matching 'nu')."""
    if len(kw) <= 4:
        padded = " " + text + " "
        for suf in (" ", ",", ".", "!", "?"):
            if (" " + kw + suf) in padded:
                return True
        return text.startswith(kw + " ") or text.endswith(" " + kw)
    return kw in text


def _prompt_hard_floor(prompt: str):
    """Return a block reason if `prompt` hits the illegal floor (minors x
    sexual/violence, or always-illegal terms), else None. NEVER bypassed by
    `unrestricted`."""
    lower = (prompt or "").lower()
    for kw in _HARD_FLOOR_KEYWORDS:
        if _hf_match(lower, kw):
            return f"illegal content blocked ({kw})"
    has_minor = any(_hf_match(lower, m) for m in _HF_MINOR)
    if has_minor and any(_hf_match(lower, s) for s in _HF_SEXUAL):
        return "sexual content involving minors is illegal"
    if has_minor and any(_hf_match(lower, v) for v in _HF_VIOLENCE):
        return "abusive content involving minors is illegal"
    return None


# ---------------------------------------------------------------------------
# DRY helpers for the ASGI routers below. Each router (predictor / backview
# / mesh) wraps multiple POST routes that share the SAME auth pattern, body
# parsing and PNG encoding — we factor them once here so each route body
# stays focused on the heavy AI call.
#
# Why ASGI consolidation? Modal Starter caps web functions at 8. We had 8
# `@modal.fastapi_endpoint`s (text2image + back_view + tpose + rectify +
# image_op + sheet + mesh_start + mesh_status). One `@modal.asgi_app` is
# ONE endpoint slot regardless of how many internal routes it serves, so
# we collapse to 3 routers and free 5 slots for future endpoints (puppeteer
# rig, animation, retopo…) without ever needing a plan upgrade.
#
# Critical: `@modal.asgi_app()` on a `@app.cls` method runs the ASGI server
# INSIDE the same GPU container as the class — `self.pipe` is on the local
# GPU, no `.remote()` hop needed (that would double-bill and double cold
# start). Only `mesh_start` keeps `.spawn()` because it really crosses a
# container boundary (CPU front-end → separate GPU MyFabmeshMesh class).
# ---------------------------------------------------------------------------
def _check_auth(payload: dict) -> None:
    """401 immediately if the shared secret is missing/wrong.

    Raises BEFORE any heavy work — keeps the abuse story identical to the
    legacy `@modal.fastapi_endpoint` paths. Each route called this inline;
    factored here so a worker secret rotation only touches one place.
    """
    from fastapi import HTTPException
    expected = os.environ.get("SHARED_SECRET", "")
    provided = (payload.get("_auth") or "").strip()
    if not expected or provided != expected:
        raise HTTPException(status_code=401, detail="auth")


async def _read_json(request) -> dict:
    """FastAPI hands us a `Request`; legacy endpoints used `payload: dict`.

    We restore the legacy contract by reading + parsing the body once here.
    A malformed body → 400 (same status FastAPI would give for a bad
    `payload: dict` argument before).
    """
    from fastapi import HTTPException
    try:
        return await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid json body")


def _ai_pnginfo():
    """PNG metadata marking the image as AI-generated — EU AI Act Art. 50(2)
    transparency + IPTC DigitalSourceType=trainedAlgorithmicMedia (machine-
    readable, recognised by Google/Adobe/etc.) + an XMP packet. Invisible: it
    does NOT alter pixels, so it never degrades the user's asset."""
    from PIL.PngImagePlugin import PngInfo
    info = PngInfo()
    xmp = (
        '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>'
        '<x:xmpmeta xmlns:x="adobe:ns:meta/">'
        '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        '<rdf:Description rdf:about="" '
        'xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" '
        'xmlns:xmp="http://ns.adobe.com/xap/1.0/">'
        '<Iptc4xmpExt:DigitalSourceType>'
        'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia'
        '</Iptc4xmpExt:DigitalSourceType>'
        '<xmp:CreatorTool>FabMesh</xmp:CreatorTool>'
        '</rdf:Description></rdf:RDF></x:xmpmeta>'
        '<?xpacket end="w"?>'
    )
    try:
        info.add_itxt("XML:com.adobe.xmp", xmp)
    except Exception:
        pass
    info.add_text("Software", "FabMesh")
    info.add_text("DigitalSourceType", "trainedAlgorithmicMedia")
    info.add_text("Comment",
        "AI-generated image. Created with FabMesh. EU AI Act Art. 50 / IPTC disclosure.")
    return info


def _png_response(img):
    """Encode a PIL.Image → PNG → fastapi.Response with image/png type.

    Matches the tail of every legacy endpoint — `buf = io.BytesIO();
    img.save(buf, format='PNG', …); Response(content=buf.getvalue(), …)`.
    """
    from fastapi.responses import Response
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=False, pnginfo=_ai_pnginfo())
    return Response(content=buf.getvalue(), media_type="image/png")


def _fetch_image(url: str, mode: str = "RGB"):
    """Browser-UA GET → PIL.Image. Required because Cloudflare R2 returns
    403 to the default urllib UA — every legacy endpoint reimplemented this
    same `urllib.request.Request(..., headers={'User-Agent': ...})` dance.
    """
    import urllib.request
    from PIL import Image
    req = urllib.request.Request(
        url,
        headers={"User-Agent":
                 "Mozilla/5.0 (X11; Linux x86_64) myfabmesh-cloud/1.0"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return Image.open(io.BytesIO(r.read())).convert(mode)

# ---------------------------------------------------------------------------
# Image: CUDA 12.4 + torch 2.4 (same stack as the desktop & the Cog) so
# diffusers loads identical weights and produces byte-identical output
# given the same seed. xformers 0.0.28 needs torch 2.4 — bumping torch
# means re-checking xformers/transformers/diffusers compat (we already
# fought this fight in cog/cog.yaml, no need to re-fight it).
# ---------------------------------------------------------------------------
# Base image — CUDA + Python + the heavy pip deps shared by every
# pipeline (torch, diffusers, fastapi). Both `image` (text2image +
# back-view) and `mesh_image` (TRELLIS-2) extend from here.
_base_image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.4.0-devel-ubuntu22.04",
        add_python="3.11",
    )
    .apt_install(
        "libgl1", "libglib2.0-0", "libsm6", "libxext6", "libxrender-dev",
    )
    .pip_install(
        "torch==2.4.1",
        "torchvision==0.19.1",
        extra_options="--index-url https://download.pytorch.org/whl/cu124",
    )
    .pip_install(
        # Pinned to versions known compatible with torch 2.4.
        # transformers 4.47+ requires torch.distributed.tensor.device_mesh
        # (torch 2.5+) → import-time crash on torch 2.4. Keep at 4.45.
        "transformers==4.45.2",
        "diffusers==0.31.0",
        "huggingface_hub==0.25.2",
        "accelerate==0.34.2",
        "safetensors==0.4.5",
        "xformers==0.0.28",
        # Image processing
        "pillow>=10",
        "numpy>=1.26,<2.0",
        # FastAPI — required since Modal 1.x for @modal.fastapi_endpoint.
        "fastapi[standard]>=0.115",
        # Florence-2 (used by back-view) imports einops + timm via
        # trust_remote_code — without these the @enter(snap=True)
        # crashes with ImportError before the snapshot is even taken.
        "einops>=0.7", "timm>=0.9",
    )
)

# Image for text2image + back-view (no mesh deps needed). Ships the
# shared modal_app/ Python source + the back skeleton PNG.
# Modal rule: add_local_* must come LAST.
image = (
    _base_image
    # opencv-python-headless ships the Haar Cascade XMLs we need for
    # face detection in image_op face_fix_image. Pure CPU (~50ms per
    # image). Kept here (NOT in _base_image) so adding it doesn't
    # invalidate mesh_image — which would re-build CuMesh + the
    # nvdiffrast + o-voxel CUDA stack for 30-60min for nothing.
    # Same logic for trimesh: needed by mesh_start's op_type dispatch
    # (smooth/decimate/center/fix_normals/fill_holes) but pure CPU.
    # mapbox_earcut: polygon triangulation engine for trimesh — needed by
    # construction3d's cross-section cap (planar.triangulate()); without it
    # the cap silently degrades to open cuts.
    # fast_simplification: moteur de decimation requis par
    # trimesh>=4 pour Trimesh.simplify_quadric_decimation(). Sans lui,
    # l'appel leve et l'outil « Nombre de triangles » renvoyait le maillage
    # INTACT tout en debitant 1 credit (constate en production le 2026-07-27 :
    # cible 4 500, resultat 481 202 triangles). Voir _mesh_op.decimate().
    .pip_install("opencv-python-headless", "trimesh>=4.0", "scipy>=1.10", "mapbox_earcut",
                 "fast_simplification")
    .add_local_python_source("modal_app")
    .add_local_file(
        "modal_app/back_tpose_skeleton.png",
        remote_path="/opt/back_tpose_skeleton.png",
    )
    # FRONT T-pose skeleton — used by the `tpose` endpoint on
    # MyFabmeshBackview (the back-view class already has all the
    # RealVisXL + ControlNet OpenPose + IPAdapter weights we need,
    # so we just need the additional front skeleton PNG here).
    .add_local_file(
        "modal_app/front_tpose_skeleton.png",
        remote_path="/opt/front_tpose_skeleton.png",
    )
)

# Blender image — export format conversion (GLB -> FBX/OBJ/STL/...).
# Deliberately built on debian_slim and NOT on _base_image: bpy is a
# ~356MB wheel and adding it to `image` would inflate the cold start of
# the CPU front-end (mesh_router) that every mesh edit goes through, for
# a dependency only the export path uses. Separate image = the existing
# CUDA layers are untouched, so deploying this does NOT trigger the
# 30-60min CuMesh/nvdiffrast/o-voxel rebuild.
#
# bpy 4.5.x is the last series with cp311 wheels (5.x is Python 3.13
# only) — pinned so a future 3.13-only release can't silently break the
# build. The apt list is what the manylinux wheel dlopen()s at import:
# without them `import bpy` dies with an ImportError on libXi/libSM.
#
# Licence: Blender is GPL-2.0-or-later. It runs server-side and is never
# distributed to customers, so no source-disclosure obligation attaches —
# unlike the Michelangelo/PartField code purged from the shipped package.
blender_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "libgl1", "libglib2.0-0", "libsm6", "libxi6", "libxxf86vm1",
        "libxfixes3", "libxrender1", "libxkbcommon0",
    )
    .pip_install("bpy==4.5.9")
    .add_local_python_source("modal_app")
)

app = modal.App("myfabmesh-cloud", image=image)


@app.function(image=blender_image, timeout=900, memory=8192)
def blender_convert(glb_bytes: bytes, fmt: str):
    """Convert a GLB to `fmt` with Blender. Called with .remote() from
    mesh_router — a plain Modal function, NOT a web endpoint, so it costs
    no web-function slot and its 356MB image never touches the router.

    Returns (bytes, extension); extension is 'zip' when the format needs
    sidecar files (OBJ + .mtl + textures)."""
    from modal_app._convert_op import convert
    return convert(glb_bytes, fmt)


# ---------------------------------------------------------------------------
# Mesh image — TRELLIS-2 has heavy CUDA build deps that we DON'T want
# in the shared image (text2image + back-view would re-pay them for
# nothing). We extend `_base_image` with the TRELLIS-2 source + its
# native CUDA components (nvdiffrast, o-voxel) BEFORE the add_local_*
# step (Modal forbids run_commands/pip_install after add_local_*).
#
# CAUTION: build can take 30-60 min the first time. Modal caches the
# image so subsequent deploys are fast.
# ---------------------------------------------------------------------------
mesh_image = (
    _base_image
    # libeigen3-dev required because the desktop fork's
    # `o-voxel/third_party/eigen/` is an empty git submodule placeholder
    # (we ship it via add_local_dir but the headers aren't there).
    # We `cp -r /usr/include/eigen3/Eigen` into the fork's third_party
    # tree just before `pip install o-voxel`.
    .apt_install("git", "ninja-build", "build-essential",
                 "libjpeg-dev", "libeigen3-dev")
    .pip_install(
        # Build tools — REQUIRED before nvdiffrast/o-voxel/etc. use
        # --no-build-isolation (otherwise bdist_wheel is missing →
        # "invalid command 'bdist_wheel'" at install time).
        "wheel>=0.42", "setuptools>=68", "packaging",
        # TRELLIS-2 basic deps (mirror of setup.sh BASIC=true block).
        "imageio", "imageio-ffmpeg", "tqdm", "easydict",
        "opencv-python-headless", "ninja", "trimesh",
        "tensorboard", "pandas", "lpips", "zstandard",
        "kornia",
        # utils3d pinned by TRELLIS-2 setup.sh.
        "utils3d @ git+https://github.com/EasternJournalist/utils3d.git"
        "@9a4eb15e4021b67b12c460c7057d642626897ec8",
        # rembg uses ONNX runtime — needs onnxruntime-gpu for L40S.
        "rembg[gpu]>=2.0",
        # transformers 4.56.0 — the FIRST version that ships
        # DINOv3ViTModel (the fork's image_feature_extractor.py does
        # `from transformers import DINOv3ViTModel`, added on 2025-08-29).
        # Anything < 4.56.0 (incl. the 4.51.3 we tried previously)
        # crashes the @enter(snap=True) with `ImportError: cannot import
        # name 'DINOv3ViTModel' from 'transformers'`.
        # transformers 4.56 still works on torch 2.4 (min torch is 2.2).
        # We DON'T pin tokenizers manually — pip picks one compatible.
        # Override the _base_image's 4.45.2 with `--upgrade`.
        "transformers==4.56.0", "huggingface_hub>=0.34",
    )
    .env({
        "CC": "gcc", "CXX": "g++",
        "CUDA_HOME": "/usr/local/cuda",
        "TORCH_CUDA_ARCH_LIST": "8.0;8.9;9.0+PTX",
        "FORCE_CUDA": "1",
        # COMMERCIAL build: use the kaolin (Apache-2.0) rasterizer shim
        # instead of nvdiffrast (NVIDIA non-commercial). The TRELLIS-2
        # texturing pipeline reads this at import time.
        "TRELLIS2_USE_KAOLIN_RASTER": "1",
    })
    # Ship the DESKTOP fork of TRELLIS-2 directly into the image
    # (≈40 MB of pure source — no precompiled .so/.pyd, all the .cu/.cpp
    # files compile fresh below). This is the SAME tree the desktop
    # runs against and the user has hardened over several days. We do
    # NOT clone microsoft/TRELLIS.2 main anymore — its layout drifted
    # (root vs src/) and its image_feature_extractor expects API surfaces
    # that the desktop fork patched.
    .add_local_dir(
        "external/TRELLIS2_win/src",
        remote_path="/opt/trellis2_local",
        copy=True,   # bake into image so subsequent run_commands can use it
    )
    .run_commands(
        # CRITICAL: force-upgrade transformers to 4.56 BEFORE TRELLIS-2
        # imports DINOv3ViTModel (the symbol only exists from 4.56.0+,
        # released 2025-08-29 — 4.51 we tried previously DOES NOT have
        # it, so the import crashed @enter(snap=True)).
        # We do it via run_commands rather than pip_install so the step
        # cannot be deduped against a previous build's pip_install layer.
        # --no-deps to keep torch 2.4.1 pinned (transformers 4.56 only
        # needs torch >= 2.2, so 2.4 is fine).
        "pip install --upgrade --no-deps "
        "transformers==4.56.0 'tokenizers>=0.22,<0.23' "
        "'huggingface_hub>=0.34,<1.0'",
        # BUILD-TIME GUARD — fail the image build (clear traceback)
        # instead of crash-looping the running app if the upgrade did
        # not take effect for any reason (cache, conflict, etc.).
        "python -c \"import transformers; "
        "print('transformers', transformers.__version__, transformers.__file__); "
        "from transformers import DINOv3ViTModel; print('DINOv3ViTModel OK')\"",
        # Kaolin (Apache-2.0) rasterizer — REPLACES nvdiffrast (NVIDIA
        # Source Code License = non-commercial, a hard blocker for a paid
        # product). The TRELLIS-2 texturing pipeline + o-voxel use the
        # `nvdiffrast_kaolin_compat` shim (backed by kaolin.render.mesh.
        # rasterize) when TRELLIS2_USE_KAOLIN_RASTER=1 (default). Prebuilt
        # wheel for torch 2.4.1 + cu124 + cp311 from NVIDIA's kaolin index.
        # We use ONLY kaolin CORE (render.mesh) — never kaolin/non_commercial.
        # nvdiffrast is NO LONGER installed in the commercial image.
        "pip install --no-deps kaolin==0.17.0 "
        "-f https://nvidia-kaolin.s3.us-east-2.amazonaws.com/torch-2.4.1_cu124.html",
        # The desktop fork's `o-voxel/third_party/eigen/` is an empty
        # submodule placeholder — Modal's add_local_dir skips empty
        # dirs so we mkdir + populate from libeigen3-dev so the
        # #include <Eigen/Dense> in the .cpp files resolves.
        "mkdir -p /opt/trellis2_local/o-voxel/third_party/eigen "
        "&& cp -r /usr/include/eigen3/Eigen /opt/trellis2_local/o-voxel/third_party/eigen/Eigen",
        # o-voxel from the SHIPPED desktop fork. --no-deps so its setup
        # cannot quietly pull in a transformers pin that downgrades the
        # 4.56 we just installed above.
        "pip install /opt/trellis2_local/o-voxel --no-build-isolation --no-deps",
        # nvdiffrast (NC) is NOT installed at all. o-voxel's postprocess.py is
        # the only hard importer of `nvdiffrast.torch` — repoint that ONE import
        # directly at the kaolin (Apache-2.0) shim. (We must NOT create a fake
        # `nvdiffrast` package: kaolin itself imports nvdiffrast.torch to probe
        # availability, and a fake that re-imports kaolin causes a circular
        # import. With nvdiffrast simply absent, kaolin's nvdiffrast_is_available
        # detector falls back to its CUDA backend cleanly.) Patch the INSTALLED
        # copy via find_spec (string lookup, no module execution).
        "python -c \"import importlib.util,os; s=importlib.util.find_spec('o_voxel'); p=os.path.join(os.path.dirname(s.origin),'postprocess.py'); src=open(p,encoding='utf-8').read(); out=src.replace('import nvdiffrast.torch as dr','from trellis2.renderers import nvdiffrast_kaolin_compat as dr'); open(p,'w',encoding='utf-8').write(out); print('o_voxel patched' if out!=src else 'o_voxel NO-CHANGE')\"",
        # cumesh — `import cumesh` is needed by
        # trellis2/representations/mesh/base.py:4. The desktop fork has
        # cumesh only in its Windows .venv (no source), so we clone the
        # upstream JeffreyXiang/CuMesh repo (same as TRELLIS-2 setup.sh)
        # and pip install --no-deps to preserve torch 2.4. CuMesh has
        # NO triton dependency — safe to keep.
        "git clone --recursive https://github.com/JeffreyXiang/CuMesh.git /tmp/cumesh "
        "&& pip install /tmp/cumesh --no-build-isolation --no-deps",
        # flex-gemm — sparse GEMM kernels used by trellis2/representations/
        # mesh/base.py:5 (`from flex_gemm.ops.grid_sample import grid_sample_3d`)
        # AND by sparse-conv backend. Pinned to v1.0.0 (Jan 2026 stable
        # release) to avoid unannounced API breakage on `main`.
        "git clone --depth 1 --branch v1.0.0 --recursive "
        "https://github.com/JeffreyXiang/FlexGEMM.git /tmp/flexgemm "
        "&& pip install /tmp/flexgemm --no-build-isolation --no-deps",
        # flash-attn — required by TRELLIS-2's attention layers. Without
        # it the mesh runtime fails with `ModuleNotFoundError: flash_attn`
        # at the first pipeline.run() call. Same version the desktop
        # setup.sh installs. --no-deps so it doesn't try to upgrade torch.
        # We install BEFORE the triton 3.2 pin and the build-time guards.
        "pip install --no-deps --no-build-isolation flash-attn==2.7.3",
        # *** THE FIX FROM 17 DEPLOYS OF FAILURE ***
        # flex-gemm's `flex_gemm/utils/autotuner.py` does:
        #   class TritonPersistentCacheAutotuner(triton.runtime.Autotuner):
        #       def __init__(self, ...):
        #           super().__init__(<13 args incl. do_bench>)
        # Triton 3.2.0+ `Autotuner.__init__` accepts those 13 args; triton
        # 3.0.0 (the version torch 2.4 SHIPS) only accepts up to 12 →
        # "Autotuner.__init__() takes from 7 to 13 positional arguments
        #  but 14 were given" at the very first cumesh/mesh import.
        # We install triton 3.2.0 explicitly here AFTER flex-gemm is
        # already installed (so its --no-deps doesn't skip this) and
        # BEFORE the final torch reinstall (which would otherwise
        # downgrade triton). Triton is pure Python wrappers around CUDA
        # PTX — no torch ABI to break.
        "pip install --no-deps 'triton==3.2.0' filelock",
        # BUILD-TIME GUARD — only torch + triton + presence of TRELLIS
        # extensions. We CANNOT import flex_gemm at build time because
        # its @triton_autotune decorator queries the GPU driver. We
        # check presence via importlib.find_spec (string-only lookup,
        # no module execution).
        "python -c \"import torch, triton; "
        "print('torch', torch.__version__, 'triton', triton.__version__)\"",
        "python -c \"import importlib.util; "
        "missing = [p for p in ['cumesh','o_voxel','flex_gemm','transformers','kaolin'] "
        "if importlib.util.find_spec(p) is None]; "
        "assert not missing, f'missing packages: {missing}'; "
        "print('all required packages located')\"",
    )
    # Final torch pin: o-voxel/cumesh/flex-gemm installs may upgrade torch
    # despite --no-deps in edge cases. Force it back to 2.4.1 + torchvision
    # 0.19.1. The CUDA .so binaries built above were compiled against torch
    # 2.4, so downgrading the Python torch module leaves them functional.
    .run_commands(
        "pip install --force-reinstall --no-deps "
        "torch==2.4.1 torchvision==0.19.1 "
        "--index-url https://download.pytorch.org/whl/cu124",
        # Pull kaolin's FULL pure-python dependency set in one shot (pygltflib,
        # usd-core, dataclasses-json, marshmallow, scipy, ...). The cached
        # kaolin install used --no-deps to protect the torch/CUDA pins, leaving
        # its import-time deps missing. kaolin + torch are already satisfied so
        # this only adds the missing pure-python deps (no CUDA rebuild).
        "pip install kaolin==0.17.0 pygltflib usd-core "
        "-f https://nvidia-kaolin.s3.us-east-2.amazonaws.com/torch-2.4.1_cu124.html",
        # Re-pin numpy<2 AFTER the above (some dep may pull numpy 2.x): kaolin
        # 0.17.0's numpy-C-API Cython ext (triangle_hash) was built against
        # numpy 1.x and crashes on numpy 2.x ("numpy.dtype size changed").
        # torch / o-voxel / cumesh are torch exts (numpy-agnostic) -> safe.
        "pip install --force-reinstall --no-deps 'numpy<2'",
        # kaolin does a bare `import nvdiffrast` to probe backend availability,
        # and that import is NOT exception-guarded on the path the texturing/
        # o-voxel shim takes. Provide a LAZY proxy package: it imports kaolin/
        # trellis2 only when a function is CALLED, never at module load, so
        # `import nvdiffrast` always succeeds WITHOUT the circular import a
        # normal re-export causes (kaolin imports nvdiffrast -> nvdiffrast
        # imports kaolin). The no-op context needs nothing; rasterize/
        # interpolate delegate to the kaolin (Apache-2.0) shim. Real nvdiffrast
        # (NC) is never installed.
        "python -c \"import site,os; d=os.path.join(site.getsitepackages()[0],'nvdiffrast'); os.makedirs(d,exist_ok=True); open(os.path.join(d,'__init__.py'),'w').close(); L=['class RasterizeCudaContext:', '    def __init__(self,*a,**k): pass', 'def rasterize(*a,**k):', '    from trellis2.renderers import nvdiffrast_kaolin_compat as _k', '    return _k.rasterize(*a,**k)', 'def interpolate(*a,**k):', '    from trellis2.renderers import nvdiffrast_kaolin_compat as _k', '    return _k.interpolate(*a,**k)']; open(os.path.join(d,'torch.py'),'w').write(chr(10).join(L)+chr(10)); print('lazy nvdiffrast proxy ->',d)\"",
        # BUILD GUARD replaying the EXACT mesh-runtime import path (trellis2 on
        # sys.path -> shim -> kaolin -> import nvdiffrast proxy): catches the
        # nvdiffrast/numpy break at BUILD, not at mesh-gen runtime.
        "python -c \"import sys; sys.path.insert(0,'/opt/trellis2_local'); import kaolin, numpy, nvdiffrast.torch; from trellis2.renderers.nvdiffrast_kaolin_compat import rasterize; print('kaolin', kaolin.__version__, 'numpy', numpy.__version__, 'shim+nvdiffrast-proxy OK')\"",
        # FINAL GUARD — torch --force-reinstall + the o-voxel install
        # above are the steps most likely to clobber transformers.
        # Re-verify the import works at the END of all build steps so
        # any regression fails the build, not the runtime.
        "python -c \"import transformers, triton; "
        "assert transformers.__version__.startswith('4.56'), "
        "'transformers got downgraded to '+transformers.__version__; "
        "assert triton.__version__.startswith('3.2'), "
        "'triton got downgraded to '+triton.__version__; "
        "from transformers import DINOv3ViTModel; "
        "print('FINAL transformers', transformers.__version__, "
        "'triton', triton.__version__, 'DINOv3ViTModel OK')\"",
    )
    .add_local_python_source("modal_app")
)


# ---------------------------------------------------------------------------
# Predictor class with Memory Snapshots.
#
# Lifecycle on each cold container:
#   1. Container boots (~1s on Modal vs ~30s on Replicate because no
#      6GB Docker image pull).
#   2. @modal.enter(snap=True) runs ONCE per snapshot version. It loads
#      diffusion weights to *CPU memory*. CUDA must NOT be used here —
#      the GPU is not attached yet.
#   3. Modal takes the snapshot of process memory after (2).
#   4. On every cold container after that:
#      - Snapshot restored (~3-5s — restores the entire CPU state)
#      - GPU is attached
#      - @modal.enter(snap=False) runs → moves the pipes onto CUDA
#      - We're ready in ~5-10s total (vs Replicate ~90s for an
#        equivalent workload)
# ---------------------------------------------------------------------------
@app.cls(
    gpu="L40S",
    timeout=600,
    # 30 s is aggressive: a container is killed 30 s after its last
    # request, so back-to-back gens stay warm but a user who pauses
    # 1 min between gens will pay the snapshot-restore cold start
    # again (~54 s). The trade-off: 180 s scaledown billed ~$0.10
    # of idle L40S per gen, while 30 s billed ~$0.02. We checked the
    # user's first invoice on 2026-05-25 ($0.52 for 2 gens) and it
    # was dominated by scaledown idle time. 30 s is the sweet spot
    # for the bursty workload of an image generator (one user
    # iterates on 3-5 gens in a row, then is idle for minutes).
    scaledown_window=300,  # keep warm 5 min after last call so back-to-back gens stay fast
    enable_memory_snapshot=True,
    # Surface the HF token + R2 creds so the predictor can pull
    # private/gated weights and (optionally) upload directly to R2.
    secrets=[
        # Shared secret the Worker sends in the request body so random
        # people can't burn our credits hitting the public URL.
        # Set via:  modal secret create myfabmesh-shared SHARED_SECRET=<32-byte hex>
        modal.Secret.from_name("myfabmesh-shared", required_keys=["SHARED_SECRET"]),
        # HuggingFace token is OPTIONAL for the POC — RealVisXL V4.0 is
        # a public model. If you ever swap in a gated model, uncomment:
        #   modal.Secret.from_name("huggingface", required_keys=["HF_TOKEN"]),
    ],
)
class MyFabmeshPredictor:
    @modal.enter(snap=True)
    def load_to_cpu(self):
        """CPU-only weight loading — runs once, gets snapshotted."""
        t0 = time.time()
        print("[snap] loading RealVisXL V4.0 onto CPU…", flush=True)
        import torch
        from diffusers import StableDiffusionXLPipeline
        from transformers import pipeline as _hfpipeline

        # CRITICAL: load on CPU (torch_dtype=fp16 is fine on CPU for
        # storage). DO NOT call .to("cuda") here — GPU is not attached.
        self.pipe = StableDiffusionXLPipeline.from_pretrained(
            "SG161222/RealVisXL_V4.0",
            torch_dtype=torch.float16,
            variant="fp16",
            use_safetensors=True,
        )
        # Pre-cast all sub-modules to fp16 (matches desktop bridge).
        self.pipe.unet.to(torch.float16)
        self.pipe.vae.to(torch.float16)
        self.pipe.text_encoder.to(torch.float16)
        self.pipe.text_encoder_2.to(torch.float16)
        # Upcast VAE to fp32 — SDXL's fp16 VAE NaNs to a flat grey image.
        try:
            self.pipe.upcast_vae()
        except Exception as _e:
            try: self.pipe.vae.to(torch.float32)
            except Exception: pass
            print(f"[snap] upcast_vae fallback ({_e})", flush=True)

        # NSFW classifiers — small (~350MB total) and CPU-only, so we
        # also load them under the snapshot. Both are Apache 2.0.
        print("[snap] loading NSFW classifiers (Falconsai + AdamCodd)…", flush=True)
        self.nsfw_clf1 = _hfpipeline(
            "image-classification",
            model="Falconsai/nsfw_image_detection",
            device="cpu",
        )
        self.nsfw_clf2 = _hfpipeline(
            "image-classification",
            model="AdamCodd/vit-base-nsfw-detector",
            device="cpu",
        )
        print(f"[snap] CPU load done in {time.time() - t0:.1f}s", flush=True)

    @modal.enter(snap=False)
    def move_to_gpu(self):
        """Runs AFTER snapshot restore + GPU attach. Moves the pipe to
        CUDA. Should be ~2-3 s on a warm-restore container."""
        t0 = time.time()
        print("[ready] moving pipe → CUDA…", flush=True)
        self.pipe.to("cuda")
        # xformers attention speeds up SDXL by ~25% with no quality loss.
        try:
            self.pipe.enable_xformers_memory_efficient_attention()
            print("[ready] xformers attention enabled", flush=True)
        except Exception as e:
            print(f"[ready] xformers skipped: {e}", flush=True)
        # SDXL-Lightning turbo: load the 4-step LoRA as a DISABLED named adapter.
        # Toggled per-request in _generate_png (Modal runs 1 input/container, so
        # set_adapters has no concurrency race). Same licence as RealVisXL.
        self._has_lightning = False
        try:
            from huggingface_hub import hf_hub_download
            from diffusers import EulerDiscreteScheduler
            _lora = hf_hub_download("ByteDance/SDXL-Lightning",
                                    "sdxl_lightning_4step_lora.safetensors")
            self.pipe.load_lora_weights(_lora, adapter_name="lightning")
            self.pipe.set_adapters([])  # disabled -> normal RealVis by default
            self._default_scheduler = self.pipe.scheduler
            self._euler_trailing = EulerDiscreteScheduler.from_config(
                self.pipe.scheduler.config, timestep_spacing="trailing")
            self._has_lightning = True
            print("[ready] SDXL-Lightning adapter loaded (disabled)", flush=True)
        except Exception as e:
            print(f"[ready] lightning adapter skipped: {e}", flush=True)
        print(f"[ready] GPU move done in {time.time() - t0:.1f}s", flush=True)

    def _generate_png(
        self,
        prompt: str,
        asset_type: str,
        asset_style: str,
        seed: int,
        steps: int,
        unrestricted: bool = False,
        turbo: bool = False,
    ) -> bytes:
        """Internal: do the generation and return PNG bytes."""
        from modal_app._prompts import build_enriched_prompt
        from modal_app._realvis import generate
        from modal_app._nsfw import is_safe, make_blocked_placeholder

        t0 = time.time()
        enriched = build_enriched_prompt(prompt, asset_type, asset_style)
        if not seed:
            seed = int(time.time())
        print(
            f"[predict] task=text2image asset={asset_type}/{asset_style} "
            f"seed={seed} steps={steps}",
            flush=True,
        )
        _use_turbo = turbo and getattr(self, "_has_lightning", False)
        if _use_turbo:
            self.pipe.set_adapters(["lightning"])
            self.pipe.scheduler = self._euler_trailing
        try:
            img = generate(self.pipe, enriched, seed=seed, steps=steps,
                           asset_type=asset_type, turbo=_use_turbo)
        finally:
            if _use_turbo:
                self.pipe.set_adapters([])
                self.pipe.scheduler = self._default_scheduler

        # Parental control. Two bypass paths:
        #  - server-wide FABMESH_UNRESTRICTED env var (test environments)
        #  - per-user `unrestricted` flag forwarded from the Worker
        #    (user toggled parental lock off via PIN in the UI)
        # Pass asset_type so the skin-ratio fallback is skipped for
        # animals/creatures/vehicles (false-positives on lion fur etc.).
        if not unrestricted and os.environ.get("FABMESH_UNRESTRICTED") != "1":
            safe, nsfw_score = is_safe(img, self.nsfw_clf1, self.nsfw_clf2,
                                        asset_type=asset_type)
            if not safe:
                print(f"[predict] BLOCKED nsfw={nsfw_score:.2f} asset={asset_type}", flush=True)
                img = make_blocked_placeholder(img.size)

        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=False, pnginfo=_ai_pnginfo())
        png = buf.getvalue()
        print(
            f"[predict] DONE text2image dt={time.time() - t0:.1f}s "
            f"bytes={len(png)}",
            flush=True,
        )
        return png

    @modal.asgi_app()
    def router(self):
        """ASGI router consolidating MyFabmeshPredictor routes under a
        single Modal web-function slot. Previously `text2image` was its
        own `@modal.fastapi_endpoint` — moving it inside an ASGI app lets
        us add `/healthz` (and any future predictor-only routes such as
        `/text2image-anime`) without burning more of Modal's 8-endpoint
        cap. Lives INSIDE the GPU container, so `self.pipe` is local —
        no `.remote()` hop.
        """
        from fastapi import FastAPI, HTTPException, Request
        from fastapi.responses import Response
        api = FastAPI(title="myfabmesh-predictor")

        @api.post("/text2image")
        async def text2image(request: Request):
            """HTTPS route hit by the Cloudflare Worker.

            Request body (JSON):
                {
                  "_auth": "<shared_secret>",
                  "prompt": "medieval orc warrior",
                  "asset_type": "character",
                  "asset_style": "realistic",
                  "seed": 424242,
                  "steps": 30
                }
            Response: raw PNG bytes (Content-Type image/png).
            """
            payload = await _read_json(request)
            _check_auth(payload)
            prompt = (payload.get("prompt") or "").strip()
            if not prompt:
                raise HTTPException(status_code=400, detail="prompt required")
            _hf = _prompt_hard_floor(prompt)
            if _hf:
                raise HTTPException(status_code=403, detail=_hf)
            png = self._generate_png(
                prompt=prompt,
                asset_type=payload.get("asset_type") or "character",
                asset_style=payload.get("asset_style") or "realistic",
                seed=int(payload.get("seed") or 0),
                steps=int(payload.get("steps") or 30),
                unrestricted=bool(payload.get("unrestricted")),
                turbo=bool(payload.get("turbo")),
            )
            return Response(content=png, media_type="image/png")

        @api.get("/healthz")
        async def healthz():
            return {"ok": True, "class": "MyFabmeshPredictor"}

        return api


# ===========================================================================
# Back-view predictor — second @app.cls with its own snapshot.
#
# We don't merge with MyFabmeshPredictor because:
#   - 4 extra models would push the text2image snapshot from ~9 GB to ~22 GB
#     (past Modal's comfort zone) and slow the snapshot restore for the
#     common-case text2image path.
#   - text2image and back-view are independent — splitting them lets each
#     scale-down on its own and lets a back-view cold start NOT block a
#     text2image call (they can warm up in parallel).
#
# Snapshot contents (~15 GB CPU memory after @enter(snap=True)):
#   - RealVisXL V4 base
#   - ControlNet OpenPose SDXL (xinsir/controlnet-openpose-sdxl-1.0)
#   - CLIP image encoder for IP-Adapter (h94/IP-Adapter)
#   - Florence-2 large (microsoft/Florence-2-large, pinned revision)
#   - The PIL back-skeleton image (shipped in /opt/back_tpose_skeleton.png)
#
# IP-Adapter weights are loaded by `pipe.load_ip_adapter()` AFTER the
# pipe is on GPU — calling it before .to('cuda') silently picks the CPU
# path and crashes at inference. That call lives in @enter(snap=False).
# ===========================================================================
@app.cls(
    gpu="L40S",
    timeout=600,
    # SNAPSHOT GPU ESSAYE PUIS RETIRE LE 2026-08-04 — il ne prenait pas.
    #
    # L'idee etait bonne et avait marche sur MyFabmeshMesh (211 s -> 17 s) :
    # faire entrer la phase `move_to_gpu` dans la photo pour supprimer les
    # HTTP 524 a froid sur les cinq routes SYNCHRONES de cette classe.
    # Mesure : le journal continuait d'afficher « [backview/ready] GPU move
    # done in 14.3s » a chaque demarrage, et DEUX creations de snapshot GPU
    # sont apparues en 25 minutes — la photo etait refaite au lieu d'etre
    # restauree. Cout constate : la generation de reference est passee de
    # 0,7074 \$ a 0,9752 \$, soit l'inverse du but recherche.
    #
    # Difference avec la classe maillage, piste pour un futur essai : ici la
    # pile est diffusers + xformers + IP-Adapter, et `load_ip_adapter()`
    # installe des processeurs d'attention APRES le passage sur CUDA. Il est
    # possible que cet etat ne survive pas au checkpoint CUDA.
    # A ne PAS reessayer sans un banc isole : chaque tentative coute ~1 \$.
    # Bumped 300→600 on 2026-05-26 because cold start of this class
    # (RealVisXL + ControlNet + IPAdapter + Florence-2 + lazy SDXL
    # Inpaint = 12-18 GB) takes ~50-90s, which combined with inference
    # easily crosses Cloudflare's 100s subrequest timeout → HTTP 524
    # in the Worker. Longer scaledown keeps the container warm across
    # typical edit sessions (multi-modify cycles) without re-paying
    # the 90s cold tax. Idle cost: ~$0.16 per 5min extra warm time.
    #
    # RAMENE A 300 s LE 2026-08-04. La raison ci-dessus a vieilli : elle date
    # d'AVANT l'activation du snapshot memoire sur cette classe. Mesure du
    # jour, journal Modal : « [backview/ready] GPU move done in 15.8s » — plus
    # 50-90 s, donc plus de risque serieux de franchir les 100 s de Cloudflare.
    #
    # Ce que coutait la difference : la vue arriere automatique fait ~16 s de
    # calcul par generation, puis gardait un L40S allume 10 minutes. Sur une
    # generation de maillage mesuree a 1,22 \$, cette seule traine pesait
    # 0,325 \$ — un quart de la facture pour un conteneur qui ne fait rien.
    #
    # On ne descend PAS plus bas volontairement : la fenetre de 5 min protege
    # les sessions d'edition en rafale (modifier / retoucher), qui sont le
    # vrai motif d'origine et restent valables.
    scaledown_window=300,
    enable_memory_snapshot=True,
    secrets=[
        modal.Secret.from_name("myfabmesh-shared", required_keys=["SHARED_SECRET"]),
    ],
)
class MyFabmeshBackview:
    @modal.enter(snap=True)
    def load_to_cpu(self):
        """CPU-only load — RealVisXL + ControlNet + Florence-2 + CLIP."""
        t0 = time.time()
        print("[backview/snap] loading RealVisXL + ControlNet + Florence-2 onto CPU…", flush=True)
        import torch
        from diffusers import StableDiffusionXLControlNetPipeline, ControlNetModel
        from transformers import (
            CLIPVisionModelWithProjection,
            AutoProcessor, AutoModelForCausalLM,
        )
        from PIL import Image
        from modal_app._backview import FLORENCE2_REVISION

        image_encoder = CLIPVisionModelWithProjection.from_pretrained(
            "h94/IP-Adapter", subfolder="models/image_encoder",
            torch_dtype=torch.float16,
        )
        controlnet = ControlNetModel.from_pretrained(
            "xinsir/controlnet-openpose-sdxl-1.0",
            torch_dtype=torch.float16,
        )
        self.pipe = StableDiffusionXLControlNetPipeline.from_pretrained(
            "SG161222/RealVisXL_V4.0",
            controlnet=controlnet,
            torch_dtype=torch.float16,
            variant="fp16",
            use_safetensors=True,
            image_encoder=image_encoder,
        )
        self.pipe.unet.to(torch.float16)
        self.pipe.vae.to(torch.float16)
        self.pipe.text_encoder.to(torch.float16)
        self.pipe.text_encoder_2.to(torch.float16)
        self.pipe.controlnet.to(torch.float16)
        # Upcast VAE to fp32 — SDXL's fp16 VAE NaNs to a flat grey image.
        try:
            self.pipe.upcast_vae()
        except Exception as _e:
            try: self.pipe.vae.to(torch.float32)
            except Exception: pass
            print(f"[snap] upcast_vae fallback ({_e})", flush=True)

        # Florence-2 — pinned revision + eager attn (sdpa missing in this rev).
        self.florence_proc = AutoProcessor.from_pretrained(
            "microsoft/Florence-2-large",
            revision=FLORENCE2_REVISION,
            trust_remote_code=True,
        )
        self.florence_model = AutoModelForCausalLM.from_pretrained(
            "microsoft/Florence-2-large",
            revision=FLORENCE2_REVISION,
            torch_dtype=torch.float16,
            trust_remote_code=True,
            attn_implementation="eager",
        )
        # Florence-2 was written before DynamicCache (transformers 4.56+) —
        # disable cache so prepare_inputs_for_generation doesn't crash.
        self.florence_model.config.use_cache = False

        # NSFW classifiers (Falconsai + AdamCodd, Apache 2.0, CPU, ~350MB) so the
        # ControlNet routes (tpose/back_view/rectify/sheet) get the same
        # post-image scan as text2image instead of relying only on the Worker
        # prompt pre-filter.
        from transformers import pipeline as _hfpipeline
        print("[backview/snap] loading NSFW classifiers…", flush=True)
        self.nsfw_clf1 = _hfpipeline("image-classification",
                                     model="Falconsai/nsfw_image_detection", device="cpu")
        self.nsfw_clf2 = _hfpipeline("image-classification",
                                     model="AdamCodd/vit-base-nsfw-detector", device="cpu")

        # Pre-load the back skeleton (shipped via image.add_local_file).
        self.skel_img = Image.open("/opt/back_tpose_skeleton.png").convert("RGB")
        # FRONT T-pose skeleton — used by the `tpose` endpoint. Same
        # pipeline (RealVisXL + ControlNet OpenPose), different skeleton
        # so the openpose conditioning produces arms-extended T-pose
        # FRONT instead of arms-extended T-pose BACK.
        self.skel_front = Image.open("/opt/front_tpose_skeleton.png").convert("RGB")

        print(f"[backview/snap] CPU load done in {time.time() - t0:.1f}s", flush=True)

    @modal.enter(snap=False)
    def move_to_gpu(self):
        """After snapshot restore + GPU attach: move everything to CUDA
        and load IP-Adapter (it MUST come after .to('cuda')).
        Expected ~25-35 s on L40S — the ControlNet + IP-Adapter make
        this heavier than the text2image path's ~18 s GPU move."""
        t0 = time.time()
        print("[backview/ready] moving pipes → CUDA + loading IP-Adapter…", flush=True)
        self.pipe.to("cuda")
        self.florence_model.to("cuda")
        # ORDRE CRITIQUE — xformers D'ABORD, IP-Adapter ENSUITE.
        #
        # L'inverse cassait la vue arriere en production, silencieusement.
        # `enable_xformers_memory_efficient_attention()` REMPLACE tous les
        # processeurs d'attention par `XFormersAttnProcessor`. Appele apres
        # `load_ip_adapter()`, il ecrasait donc les processeurs que
        # l'IP-Adapter venait d'installer. Or l'IP-Adapter transmet
        # `encoder_hidden_states` sous forme de TUPLE (texte, image), que
        # seuls ses propres processeurs savent deballer ; le processeur
        # xformers, lui, fait `encoder_hidden_states.shape` et leve
        # « AttributeError: 'tuple' object has no attribute 'shape' »
        # (diffusers, XFormersAttnProcessor.__call__).
        #
        # Consequence observee le 2026-08-04 : chaque appel de vue arriere
        # plantait, le worker recevait un HTTP 524, et le repli silencieux
        # laissait la generation continuer en VUE UNIQUE — TRELLIS devinait
        # l'arriere au lieu de le recevoir. Qualite perdue sur chaque
        # maillage, GPU paye pour rien, et rien ne le signalait tant que les
        # appels auxiliaires n'ecrivaient aucune ligne.
        try:
            self.pipe.enable_xformers_memory_efficient_attention()
        except Exception as e:
            print(f"[backview/ready] xformers skipped: {e}", flush=True)
        # Charge EN DERNIER : ses processeurs doivent avoir le dernier mot
        # sur les couches d'attention croisee.
        self.pipe.load_ip_adapter(
            "h94/IP-Adapter", subfolder="sdxl_models",
            weight_name="ip-adapter-plus_sdxl_vit-h.safetensors",
        )
        # IP-Adapter scale set per-call (default 0.65 in _backview.generate).
        print(f"[backview/ready] GPU move done in {time.time() - t0:.1f}s", flush=True)

    def _route_back_view(self, payload: dict):
        """Back-view generation core — called from the ASGI router below.

        Verbatim port of the legacy `back_view` `@modal.fastapi_endpoint`
        body (auth + fetch + generate). Kept as a method (not a closure)
        so the heavy `self.pipe` / `self.florence_*` references read
        naturally.
        """
        from fastapi import HTTPException
        from fastapi.responses import Response
        from modal_app._backview import generate

        _check_auth(payload)
        front_url = (payload.get("front_image_url") or "").strip()
        if not front_url:
            raise HTTPException(status_code=400, detail="front_image_url required")

        try:
            front_img = _fetch_image(front_url)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"front download: {e}")

        _hf = _prompt_hard_floor(payload.get("prompt_hint") or "")
        if _hf:
            raise HTTPException(status_code=403, detail=_hf)

        t0 = time.time()
        img = generate(
            self.pipe,
            self.florence_proc, self.florence_model,
            self.skel_img,
            front_img,
            prompt_hint=payload.get("prompt_hint") or "",
            ip_scale=float(payload.get("ip_scale") or 0.65),
            steps=int(payload.get("steps") or 30),
            seed=int(payload.get("seed") or 424242),
            n_candidates=int(payload.get("n_candidates") or 4),
        )
        if os.environ.get("FABMESH_UNRESTRICTED") != "1" and getattr(self, "nsfw_clf1", None):
            from modal_app._nsfw import is_safe, make_blocked_placeholder
            _safe, _ns = is_safe(img, self.nsfw_clf1, self.nsfw_clf2, asset_type="character")
            if not _safe:
                print(f"[backview] BLOCKED nsfw={_ns:.2f}", flush=True)
                img = make_blocked_placeholder(img.size)
        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=False, pnginfo=_ai_pnginfo())
        png = buf.getvalue()
        print(f"[backview] DONE dt={time.time() - t0:.1f}s bytes={len(png)}", flush=True)
        return Response(content=png, media_type="image/png")

    def _route_tpose(self, payload: dict):
        """T-pose FRONT view generation core — called from the ASGI router.

        Verbatim port of `scripts/generate_front_tpose.py`. Reuses the
        SAME pipeline as back_view (RealVisXL + ControlNet OpenPose +
        IPAdapter) so we don't pay a second snapshot. Two modes:

          - text2image (prompt only): generate a T-pose from scratch
          - img2img (ref_image_url provided): re-pose an existing image
            in T-pose while preserving identity/outfit via IP-Adapter

        Returns: raw PNG bytes — already rembg'd + centered on white.
        """
        from fastapi import HTTPException
        from fastapi.responses import Response
        from modal_app._tpose import generate as tpose_generate
        from modal_app._nsfw import is_safe, make_blocked_placeholder

        _check_auth(payload)

        prompt = (payload.get("prompt") or "").strip()
        ref_url = (payload.get("ref_image_url") or "").strip()
        if not prompt and not ref_url:
            raise HTTPException(status_code=400, detail="prompt or ref_image_url required")
        _hf = _prompt_hard_floor(prompt)
        if _hf:
            raise HTTPException(status_code=403, detail=_hf)

        ref_img = None
        if ref_url:
            try:
                ref_img = _fetch_image(ref_url)
            except Exception as e:
                raise HTTPException(status_code=502, detail=f"ref download: {e}")
            # Same caption fallback as desktop generate_front_tpose.py:run_from_image
            if not prompt:
                prompt = ("a person in a T-pose, arms extended horizontally sideways, "
                          "facing camera directly, plain white background")

        t0 = time.time()
        img = tpose_generate(
            self.pipe,
            self.skel_front,
            prompt,
            ref_img=ref_img,
            seed=int(payload.get("seed") or 42),
            cn_scale=float(payload.get("cn_scale") or 1.15),
            ip_scale=float(payload.get("ip_scale") or 0.75),
            steps=int(payload.get("steps") or 30),
        )

        # Parental control — image NSFW scan, same as text2image path.
        if os.environ.get("FABMESH_UNRESTRICTED") != "1" and getattr(self, "nsfw_clf1", None):
            safe, _ns = is_safe(img, self.nsfw_clf1, self.nsfw_clf2, asset_type="character")
            if not safe:
                print(f"[tpose] BLOCKED nsfw={_ns:.2f}", flush=True)
                img = make_blocked_placeholder(img.size)

        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=False, pnginfo=_ai_pnginfo())
        png = buf.getvalue()
        print(f"[tpose] DONE mode={'img2img' if ref_img else 'text2image'} "
              f"dt={time.time() - t0:.1f}s bytes={len(png)}", flush=True)
        return Response(content=png, media_type="image/png")

    def _route_rectify(self, payload: dict):
        """Strict orthographic FRONT (or 3/4 ISO) view rectification.

        Verbatim port of `scripts/generate_front_strict.py`. Runs the SAME
        pipeline as back_view/tpose but with ControlNet neutralized
        (cn_scale=0 + black image). Multi-seed (default 3), picks the
        best candidate by horizontal-symmetry IoU on the rembg silhouette.

        Returns: raw PNG bytes (rembg + centered).
        """
        from fastapi import HTTPException
        from fastapi.responses import Response
        from modal_app._rectify import generate as rectify_generate

        _check_auth(payload)

        prompt = (payload.get("prompt") or "").strip()
        ref_url = (payload.get("ref_image_url") or "").strip()
        if not prompt and not ref_url:
            raise HTTPException(status_code=400, detail="prompt or ref_image_url required")
        _hf = _prompt_hard_floor(prompt)
        if _hf:
            raise HTTPException(status_code=403, detail=_hf)

        ref_img = None
        if ref_url:
            try:
                ref_img = _fetch_image(ref_url)
            except Exception as e:
                raise HTTPException(status_code=502, detail=f"ref download: {e}")
            if not prompt:
                # Same generic fallback as desktop generate_front_strict.py:main()
                prompt = "subject"

        mode = (payload.get("mode") or "front").strip()
        if mode not in ("front", "iso"):
            mode = "front"

        t0 = time.time()
        img = rectify_generate(
            self.pipe,
            prompt,
            ref_img=ref_img,
            mode=mode,
            seeds=int(payload.get("seeds") or 3),
            steps=int(payload.get("steps") or 30),
            guidance=float(payload.get("guidance") or 7.0),
            ip_scale=float(payload.get("ip_scale") or 0.7),
        )

        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=False, pnginfo=_ai_pnginfo())
        png = buf.getvalue()
        print(f"[rectify] DONE mode={mode} dt={time.time() - t0:.1f}s "
              f"bytes={len(png)}", flush=True)
        return Response(content=png, media_type="image/png")

    def _get_auto_inpaint_models(self):
        """Lazy-load CLIPSeg + SDXL Inpainting on first auto_inpaint call.
        These add ~7 GB on GPU so we don't snapshot them upfront — most
        sessions never use auto-inpaint, no reason to pay that cost.
        Cached on self so subsequent calls reuse."""
        if getattr(self, '_ai_loaded', False):
            return self._ai_seg_processor, self._ai_seg_model, self._ai_inpaint_pipe
        t0 = time.time()
        print('[auto-inpaint] lazy-loading CLIPSeg + SDXL Inpainting...', flush=True)
        import torch
        from transformers import CLIPSegProcessor, CLIPSegForImageSegmentation
        from diffusers import StableDiffusionXLInpaintPipeline
        self._ai_seg_processor = CLIPSegProcessor.from_pretrained(
            'CIDAS/clipseg-rd64-refined')
        # Raise CLIPSeg input resolution 352 -> 512 for a ~2x sharper mask.
        try:
            self._ai_seg_processor.image_processor.size = {'height': 512, 'width': 512}
        except Exception:
            pass
        self._ai_seg_model = CLIPSegForImageSegmentation.from_pretrained(
            'CIDAS/clipseg-rd64-refined').to('cuda').eval()
        # SDXL inpainting model — different from RealVisXL; it's the
        # dedicated 5-channel UNet from diffusers (same one the desktop
        # script loads at scripts/local_inpaint_bridge.py:98).
        self._ai_inpaint_pipe = StableDiffusionXLInpaintPipeline.from_pretrained(
            'diffusers/stable-diffusion-xl-1.0-inpainting-0.1',
            torch_dtype=torch.float16, variant='fp16',
        )
        self._ai_inpaint_pipe.to('cuda')
        self._ai_inpaint_pipe.enable_attention_slicing()
        self._ai_inpaint_pipe.enable_vae_tiling()
        self._ai_loaded = True
        print(f'[auto-inpaint] models ready in {time.time() - t0:.1f}s', flush=True)
        return self._ai_seg_processor, self._ai_seg_model, self._ai_inpaint_pipe

    def _route_image_op(self, payload: dict):
        """Unified img2img/auto-inpaint dispatcher core — called from the
        ASGI router below.

        Kept as a single multi-op handler (vs. one route per op) because
        the dispatcher already lived in the legacy `image_op` endpoint and
        the worker calls it with `op=...` in the body — splitting would
        require a worker-side migration we DON'T want here.

        Returns: raw PNG bytes.
        """
        from fastapi import HTTPException
        from fastapi.responses import Response

        _check_auth(payload)

        op        = (payload.get("op") or "").strip()
        image_url = (payload.get("image_url") or "").strip()
        if not image_url:
            raise HTTPException(status_code=400, detail="image_url required")
        if op not in ("modify", "auto_inpaint", "mask_inpaint", "face_fix_image", "upscale", "segment"):
            raise HTTPException(status_code=400,
                detail="op must be 'modify', 'auto_inpaint', 'mask_inpaint', 'face_fix_image', 'upscale' or 'segment'")

        try:
            src_img = _fetch_image(image_url)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"image download: {e}")

        t0 = time.time()
        if op == "modify":
            from modal_app._modify import generate as modify_generate
            prompt = (payload.get("prompt") or "").strip()
            if not prompt:
                raise HTTPException(status_code=400, detail="prompt required for modify")
            _hf = _prompt_hard_floor(prompt)
            if _hf:
                raise HTTPException(status_code=403, detail=_hf)
            img = modify_generate(
                self.pipe, src_img, prompt,
                strength=float(payload.get("strength") or 0.55),
                seed=int(payload.get("seed") or 42),
                steps=int(payload.get("steps") or 30),
            )
            tag = "modify"
        elif op == "auto_inpaint":
            from modal_app._auto_inpaint import generate as ai_generate
            target_text = (payload.get("target_text") or "").strip()
            if not target_text:
                raise HTTPException(status_code=400, detail="target_text required for auto_inpaint")
            _hf = _prompt_hard_floor((target_text + " " + (payload.get("prompt") or "")).strip())
            if _hf:
                raise HTTPException(status_code=403, detail=_hf)
            seg_proc, seg_model, inpaint_pipe = self._get_auto_inpaint_models()
            try:
                img = ai_generate(
                    seg_proc, seg_model, inpaint_pipe, src_img, target_text,
                    prompt=payload.get("prompt") or "",
                    dilate=int(payload.get("dilate") or 15),
                )
            except ValueError as e:
                raise HTTPException(status_code=422, detail=str(e))
            tag = "auto_inpaint"

        elif op == "mask_inpaint":
            # Caller-supplied mask (drawn by the user in the renderer's
            # Draw Mask modal). Reuses the SDXL Inpainting pipe loaded
            # by _get_auto_inpaint_models() — same model, different mask
            # source.
            from modal_app._mask_inpaint import generate as mask_generate
            mask_url = (payload.get("mask_url") or "").strip()
            prompt   = (payload.get("prompt") or "").strip()
            if not mask_url: raise HTTPException(status_code=400, detail="mask_url required for mask_inpaint")
            if not prompt:   raise HTTPException(status_code=400, detail="prompt required for mask_inpaint")
            _hf = _prompt_hard_floor(prompt)
            if _hf:
                raise HTTPException(status_code=403, detail=_hf)
            try:
                mask_img = _fetch_image(mask_url, mode="L")
            except Exception as e:
                raise HTTPException(status_code=502, detail=f"mask download: {e}")
            _, _, inpaint_pipe = self._get_auto_inpaint_models()
            img = mask_generate(inpaint_pipe, src_img, mask_img, prompt)
            tag = "mask_inpaint"

        elif op == "face_fix_image":
            # Auto face detection (OpenCV Haar) + SDXL Inpaint on the
            # detected bbox. Mirrors the mesh-level face_fix but applied
            # to a flat 2D image (no GLB atlas).
            from modal_app._face_fix_image import generate as ffi_generate
            _, _, inpaint_pipe = self._get_auto_inpaint_models()
            try:
                img = ffi_generate(
                    inpaint_pipe, src_img,
                    strength=float(payload.get("strength") or 0.45),
                )
            except ValueError as e:
                # No face detected — caller refunds credits.
                raise HTTPException(status_code=422, detail=str(e))
            tag = "face_fix_image"

        elif op == "segment":
            # Detect-only CLIPSeg mask for the on-demand "Preview mask" button —
            # no SDXL inpaint, just the soft mask so the user sees what Auto
            # Inpaint will target before spending a generation.
            from modal_app._auto_inpaint import _segment as ai_segment
            from PIL import Image as _PILImg
            target_text = (payload.get("target_text") or "").strip()
            if not target_text:
                raise HTTPException(status_code=400, detail="target_text required for segment")
            seg_proc, seg_model, _ = self._get_auto_inpaint_models()
            _src = src_img.convert("RGB")
            _ow, _oh = _src.size
            _md = 1024
            if max(_ow, _oh) > _md:
                if _ow > _oh:
                    _ww, _wh = _md, int(_oh * _md / _ow)
                else:
                    _wh, _ww = _md, int(_ow * _md / _oh)
            else:
                _ww, _wh = _ow, _oh
            _ww = (_ww // 8) * 8 or 8
            _wh = (_wh // 8) * 8 or 8
            _work = _src.resize((_ww, _wh), _PILImg.LANCZOS)
            mask = ai_segment(seg_proc, seg_model, _work, target_text,
                              _ww, _wh, int(payload.get("dilate") or 15))
            # White mask on black, upscaled back to the original size with
            # LANCZOS (was NEAREST = blocky) so the preview overlay is smooth.
            img = mask.convert("RGB").resize((_ow, _oh), _PILImg.LANCZOS)
            tag = "segment"

        else:  # upscale
            from modal_app._upscale import generate as upscale_generate
            scale = int(payload.get("scale") or 2)
            if scale not in (2, 4):
                raise HTTPException(status_code=400, detail="scale must be 2 or 4")
            img = upscale_generate(
                self.pipe, src_img, scale=scale,
                refine_strength=float(payload.get("refine_strength") or 0.15),
                seed=int(payload.get("seed") or 42),
                steps=int(payload.get("steps") or 20),
            )
            tag = "upscale"

        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=False, pnginfo=_ai_pnginfo())
        png = buf.getvalue()
        print(f"[{tag}] DONE dt={time.time() - t0:.1f}s bytes={len(png)}", flush=True)
        return Response(content=png, media_type="image/png")

    def _route_sheet(self, payload: dict):
        """4-view orthographic model-sheet generator (front/right/back/left).
        Verbatim port of `scripts/multiview_sheet_gen.py` — single SDXL
        pass with IPAdapter Plus on RealVisXL produces a 2x2 grid where
        all 4 cells share the same identity / lighting / paint.

        Used by Wave 2.2/2.3 for hard-surface asset types (vehicle,
        building, weapon, prop) — for these the desktop dispatches the
        `sheet` back-view mode (main.js:4806) instead of the realvis
        T-pose pipeline (which only makes sense for humanoids).

        Returns ONLY the BACK view as PNG (cloud doesn't yet consume the
        other 3 views — multi-view texture refine is a future Wave).
        """
        from fastapi import HTTPException
        from fastapi.responses import Response
        from modal_app._sheet import generate as sheet_generate

        _check_auth(payload)

        front_url = (payload.get("front_image_url") or "").strip()
        if not front_url:
            raise HTTPException(status_code=400, detail="front_image_url required")

        try:
            front_img = _fetch_image(front_url)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"front download: {e}")

        _hf = _prompt_hard_floor(payload.get("prompt_hint") or "")
        if _hf:
            raise HTTPException(status_code=403, detail=_hf)

        t0 = time.time()
        views = sheet_generate(
            self.pipe,
            front_img,
            prompt_hint=payload.get("prompt_hint") or "",
            ip_scale=float(payload.get("ip_scale") or 0.6),
            seed=int(payload.get("seed") or 424242),
            steps=int(payload.get("steps") or 30),
        )
        back_img = views.get("back")
        if back_img is None:
            raise HTTPException(status_code=500, detail="sheet split missing back cell")

        buf = io.BytesIO()
        back_img.save(buf, format="PNG", optimize=False, pnginfo=_ai_pnginfo())
        png = buf.getvalue()
        print(f"[sheet] DONE dt={time.time() - t0:.1f}s bytes={len(png)}", flush=True)
        return Response(content=png, media_type="image/png")

    @modal.asgi_app()
    def router(self):
        """ASGI router consolidating the 5 back-view family routes
        (back_view + tpose + rectify + image_op + sheet) plus /healthz
        under a single Modal web-function slot.

        Why ASGI here? Each of these routes shares the SAME heavy CPU+GPU
        snapshot (~15 GB: RealVisXL + ControlNet + IPAdapter + Florence-2),
        so running them in the SAME container is correct — the alternative
        (one endpoint per route, each in its own container) would mean
        re-paying the snapshot restore 5× when the worker bursts through
        all of them in an editing session. Lives INSIDE the GPU container
        so `self.pipe` is local — no `.remote()` hop needed.
        """
        from fastapi import FastAPI, Request
        api = FastAPI(title="myfabmesh-backview")

        @api.post("/back_view")
        async def back_view(request: Request):
            return self._route_back_view(await _read_json(request))

        @api.post("/tpose")
        async def tpose(request: Request):
            return self._route_tpose(await _read_json(request))

        @api.post("/rectify")
        async def rectify(request: Request):
            return self._route_rectify(await _read_json(request))

        @api.post("/image_op")
        async def image_op(request: Request):
            return self._route_image_op(await _read_json(request))

        @api.post("/sheet")
        async def sheet(request: Request):
            return self._route_sheet(await _read_json(request))

        @api.get("/healthz")
        async def healthz():
            return {"ok": True, "class": "MyFabmeshBackview"}

        return api


# ===========================================================================
# Mesh predictor — TRELLIS-2 image-to-3D — ASYNC ARCHITECTURE.
#
# Why async: Modal web endpoints have a 150 s HTTP response timeout that we
# cannot extend. The mesh cold start alone (no @enter(snap=True) because
# flex_gemm's @triton_autotune decorators need GPU at import time) takes
# ~169 s just to load TRELLIS-2 + DINOv3 + GPU move. Sync mesh = guaranteed
# HTTP 303 every cold call.
#
# So we split the endpoint in two:
#   POST /mesh-start  — spawns the work in background via .spawn(), returns
#                       {"job_id": "<uuid>"} immediately (< 1s).
#   POST /mesh-status — reads the persistent Volume; returns the GLB inline
#                       when ready, or {"ready": false} otherwise.
#
# The GLB is persisted to a `modal.Volume` mounted at /data — the volume
# survives between container restarts so the status endpoint (which may
# land on a different container than the generate function) can read it.
# ===========================================================================

# Persistent volume that stores GLB outputs keyed by job_id. Auto-created
# on first deploy. Worker can poll the status endpoint until ready.
mesh_output_volume = modal.Volume.from_name(
    "myfabmesh-mesh-output", create_if_missing=True,
)


@app.cls(
    image=mesh_image,
    gpu="L40S",
    timeout=900,           # full TRELLIS-2 pipeline can run ~5-10 min cold
    # TRAINE RAMENEE DE 300 A 90 s LE 2026-08-04, apres mesure.
    #
    # Une longue traine est une ASSURANCE CONTRE UN DEMARRAGE LENT. Le
    # snapshot GPU active ci-dessous fait tomber ce demarrage de 211,6 s a
    # ~17 s : l'assurance ne vaut plus sa prime. Mesure du jour, generation
    # a froid a 0,7074 \$ dont ~0,49 \$ de conteneurs INACTIFS.
    #
    # SEULE CETTE CLASSE EST RACCOURCIE, et c'est un choix.
    # `MyFabmeshMesh` est ASYNCHRONE : `/mesh_start` rend la main en quelques
    # secondes et le client interroge `/mesh_status` ensuite. Un demarrage a
    # froid n'y produit donc aucun 524.
    # `MyFabmeshBackview` (vue arriere, rectification, tpose, feuille,
    # operations d'image) est SYNCHRONE sous la limite de 100 s des
    # sous-requetes Cloudflare — c'est deja la qu'on recolte des 524 a froid.
    # Y raccourcir la traine rendrait ces echecs PLUS FREQUENTS : on
    # economiserait des dollars en degradant le service. On n'y touche pas
    # tant que son demarrage n'aura pas ete accelere de la meme facon.
    scaledown_window=90,
    # SNAPSHOT GPU ACTIVE LE 2026-08-04, apres mesure sur une app isolee.
    #
    # C'etait `enable_memory_snapshot=False`, au motif — exact a l'epoque —
    # que l'import de flex_gemm/cumesh declenche des `@triton_autotune` qui
    # exigent un GPU, alors qu'un snapshot memoire classique se prend SANS
    # GPU. Consequence : 211,6 s de rechargement complet a CHAQUE demarrage
    # a froid, pour 130 s de calcul utile.
    #
    # `enable_gpu_snapshot` (modal 1.4.3) prend la photo AVEC un GPU attache,
    # ce qui leve exactement ce blocage. Verifie sur l'app separee
    # `myfabmesh-gpusnap-test` (voir modal_app/test_gpusnap.py), trois
    # preuves distinctes :
    #   1. journal Modal « Creating GPU memory snapshot » puis « Restoring
    #      Function from memory snapshot » ;
    #   2. temps mur 253,8 s a la creation, puis 16,8 s et 17,4 s aux appels
    #      suivants — le dernier apres 3 min d'attente, conteneur eteint a
    #      coup sur ;
    #   3. inference reelle sur le snapshot restaure : GLB de 1,52 Mo,
    #      en-tete « glTF » valide. Charger sans erreur ne prouve pas que le
    #      contexte CUDA ressuscite calcule juste — il fallait le verifier.
    enable_memory_snapshot=True,
    experimental_options={"enable_gpu_snapshot": True},
    volumes={"/data": mesh_output_volume},
    secrets=[
        modal.Secret.from_name("myfabmesh-shared", required_keys=["SHARED_SECRET"]),
        modal.Secret.from_name("huggingface", required_keys=["HF_TOKEN"]),
    ],
)
class MyFabmeshMesh:
    @modal.enter(snap=True)
    def load_everything(self):
        """All TRELLIS-2 loading happens here (GPU attached).

        Mirror of scripts/trellis2_native_full_pipeline.py:main().

        HISTORIQUE — le commentaire d'origine disait : « We CANNOT use
        @modal.enter(snap=True) because flex_gemm / cumesh chain decorate
        module-level kernels with @triton_autotune which calls
        driver.active.get_benchmarker() at IMPORT time. Without a GPU that
        fails with "0 active drivers". » C'etait vrai des snapshots CPU.
        Le snapshot GPU active sur la classe attache un GPU pendant la prise
        de la photo : `snap=True` fonctionne desormais. Verifie, voir le
        commentaire du decorateur ci-dessus."""
        t0 = time.time()
        print("[mesh/ready] importing trellis2 + loading TRELLIS.2-4B…", flush=True)
        import sys
        sys.path.insert(0, "/opt/trellis2_local")

        # Env vars matching the desktop script defaults.
        os.environ.setdefault("TRELLIS2_USE_KAOLIN_RASTER", "1")
        os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
        os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")
        os.environ.setdefault("TORCHINDUCTOR_USE_TRITON", "0")
        os.environ.setdefault("TRANSFORMERS_ATTN_IMPLEMENTATION", "eager")

        # Patch the cached pipeline.json to swap the gated briaai/RMBG-2.0
        # for ZhengPeng7/BiRefNet (Apache 2.0). Same logic as the desktop
        # script's _patch_rmbg_in_hf_cache().
        try:
            from huggingface_hub import snapshot_download
            cache_root = snapshot_download(
                "microsoft/TRELLIS.2-4B",
                allow_patterns=["pipeline.json"],
            )
            pipeline_json = os.path.join(cache_root, "pipeline.json")
            if os.path.isfile(pipeline_json):
                with open(pipeline_json, "r", encoding="utf-8") as f:
                    content = f.read()
                if "briaai/RMBG-2.0" in content:
                    with open(pipeline_json, "w", encoding="utf-8") as f:
                        f.write(content.replace(
                            "briaai/RMBG-2.0", "ZhengPeng7/BiRefNet"))
                    print("[mesh/ready] patched HF cache: briaai/RMBG-2.0 -> ZhengPeng7/BiRefNet",
                          flush=True)
        except Exception as e:
            print(f"[mesh/ready] rmbg patch skipped: {e}", flush=True)

        from trellis2.pipelines import Trellis2ImageTo3DPipeline
        self.pipeline = Trellis2ImageTo3DPipeline.from_pretrained(
            "microsoft/TRELLIS.2-4B")
        self.pipeline.rembg_model = None
        self.pipeline.cuda()
        import o_voxel
        self.o_voxel = o_voxel
        # SDXL inpaint pipe is lazy-loaded on first face_fix request — it's
        # ~6 GB and most mesh calls don't ask for face_fix, so paying that
        # cost upfront would slow every cold start by 30-60s for nothing.
        self.inpaint_pipe = None
        print(f"[mesh/ready] full load + GPU move done in {time.time() - t0:.1f}s",
              flush=True)

    def _get_inpaint_pipe(self):
        """Lazy-load SDXL inpaint (RealVisXL_V4.0 weights). Cached on the
        instance so subsequent face_fix calls don't reload."""
        if self.inpaint_pipe is not None:
            return self.inpaint_pipe
        t0 = time.time()
        print("[mesh/face-fix] loading SDXL inpaint (RealVisXL V4.0)…", flush=True)
        import torch
        from diffusers import StableDiffusionXLInpaintPipeline
        pipe = StableDiffusionXLInpaintPipeline.from_pretrained(
            "SG161222/RealVisXL_V4.0",
            torch_dtype=torch.float16,
            variant="fp16",
            use_safetensors=True,
        )
        pipe.unet.to(torch.float16)
        pipe.vae.to(torch.float16)
        pipe.text_encoder.to(torch.float16)
        pipe.text_encoder_2.to(torch.float16)
        # Upcast VAE to fp32 — SDXL's fp16 VAE NaNs to a flat grey image.
        try:
            pipe.upcast_vae()
        except Exception as _e:
            try: pipe.vae.to(torch.float32)
            except Exception: pass
            print(f"LOCAL_REALVIS: upcast_vae fallback ({_e})", flush=True)
        # CPU offload — keeps VRAM headroom for the TRELLIS-2 pipeline
        # that's already on GPU. Same trade-off the desktop makes.
        pipe.enable_model_cpu_offload()
        self.inpaint_pipe = pipe
        print(f"[mesh/face-fix] SDXL inpaint ready in {time.time() - t0:.1f}s",
              flush=True)
        return self.inpaint_pipe

    @modal.method()
    def generate_to_volume(self, job_id: str, payload: dict):
        """Run TRELLIS-2 pipeline + write GLB bytes to /data/<job_id>.glb
        in the shared Volume so the status endpoint can return it.
        Errors are written to /data/<job_id>.err for the status endpoint
        to surface."""
        import urllib.request
        import traceback
        from PIL import Image as _PImg
        from modal_app._mesh import generate

        t0 = time.time()
        out_path = f"/data/{job_id}.glb"
        err_path = f"/data/{job_id}.err"
        try:
            def _fetch_image(url: str):
                """Fetch a URL with a browser UA (Cloudflare R2 returns
                403 to default python-urllib UA). Returns a PIL Image."""
                req = urllib.request.Request(
                    url,
                    headers={"User-Agent":
                             "Mozilla/5.0 (X11; Linux x86_64) myfabmesh-cloud/1.0"},
                )
                with urllib.request.urlopen(req, timeout=30) as r:
                    data = r.read()
                return _PImg.open(io.BytesIO(data))

            front_url = (payload.get("front_image_url") or "").strip()
            if not front_url:
                raise ValueError("front_image_url required")
            print(f"[mesh] fetching front_url={front_url[:120]}", flush=True)
            front_img = _fetch_image(front_url)
            # Optional back image for multi-view conditioning. When
            # provided, TRELLIS-2 gets a 2-image cond and the resulting
            # texture is materially better on the back faces (matches
            # the desktop's `FABMESH_TRELLIS2_MULTIVIEW_DIR` flow).
            back_img = None
            back_url = (payload.get("back_image_url") or "").strip()
            if back_url:
                print(f"[mesh] fetching back_url={back_url[:120]}", flush=True)
                try:
                    back_img = _fetch_image(back_url)
                except Exception as e:
                    print(f"[mesh] back image fetch failed ({e}) — "
                          f"falling back to single-view", flush=True)

            glb_bytes = generate(
                self.pipeline,
                self.o_voxel,
                front_img,
                back_img=back_img,
                mode=payload.get("mode") or "1024",
                seed=int(payload.get("seed") or 42),
                decimation_target=int(payload.get("decimation_target") or 500_000),
                texture_size=int(payload.get("texture_size") or 2048),
                # steps du palier de qualite (12/24/32). 0 = defaut
                # d'environnement, donc comportement inchange si le
                # worker ne le transmet pas.
                tex_steps=int(payload.get("tex_steps") or 0),
            )

            # Optional face polish — SDXL inpaint on the atlas face region.
            # Verbatim port of scripts/face_inpaint_atlas.py (with the
            # pyrender step replaced by face detection on the original
            # front input — TRELLIS-2 puts the mesh face at the same
            # screen-space coords as the input image, see _face_fix.py).
            # Wrapped in try/except so a face_fix failure never tanks an
            # otherwise-valid mesh (same passthrough policy as desktop).
            if payload.get("face_fix"):
                try:
                    from modal_app._face_fix import apply_face_fix
                    t_ff = time.time()
                    glb_bytes = apply_face_fix(
                        glb_bytes,
                        front_img,
                        self._get_inpaint_pipe(),
                        strength=float(payload.get("face_fix_strength") or 0.4),
                    )
                    print(f"[mesh] face_fix done in {time.time()-t_ff:.1f}s "
                          f"bytes={len(glb_bytes)}", flush=True)
                except Exception as e:
                    print(f"[mesh] face_fix skipped: {e}", flush=True)

            with open(out_path, "wb") as f:
                f.write(glb_bytes)
            mesh_output_volume.commit()
            print(f"[mesh] DONE job={job_id} dt={time.time() - t0:.1f}s "
                  f"bytes={len(glb_bytes)}", flush=True)
        except Exception as e:
            err_msg = f"{type(e).__name__}: {e}\n{traceback.format_exc()}"
            try:
                with open(err_path, "w") as f:
                    f.write(err_msg)
                mesh_output_volume.commit()
            except Exception:
                pass
            print(f"[mesh] FAILED job={job_id}: {err_msg}", flush=True)
            raise

    # NOTE: mesh_start / mesh_status are NOT on this class. They live
    # below as @app.function (lightweight image, no GPU) so that an
    # HTTP request to /mesh-start does NOT trigger this class's heavy
    # @enter (TRELLIS-2 load = 170 s, would blow past Modal's 150 s
    # HTTP timeout even for "instant" enqueue calls).

    @modal.method()
    def inference_bytes(
        self,
        image_bytes: bytes,
        mode: str = '1024',
        seed: int = 42,
        decimation: int = 500_000,
        texture_size: int = 1024,
    ) -> bytes:
        """Batch-friendly TRELLIS-2 inference: image bytes in, GLB bytes out.

        Unlike generate_to_volume() this doesn't need an R2 URL or a
        job_id — caller passes raw PNG/JPEG bytes via Modal's gRPC
        and gets the GLB inline. Used by scripts/training_data_trellis_batch.py
        to materialize the 150-image AnyTop training mesh set without
        round-tripping through Cloudflare R2.

        Args identical to generate_to_volume's payload (texture_size
        default lowered to 1024 to fit Modal's 5 min default per-call
        timeout when batching).
        """
        from PIL import Image as _PImg
        from modal_app._mesh import generate
        front_img = _PImg.open(io.BytesIO(image_bytes))
        glb_bytes = generate(
            self.pipeline, self.o_voxel, front_img,
            mode=mode, seed=seed,
            decimation_target=decimation,
            texture_size=texture_size,
        )
        return glb_bytes


# Lightweight HTTP endpoints that DELEGATE to the heavy mesh class.
# These use the regular `image` (text2image + back-view) — no GPU
# needed for the endpoint itself, just for the spawned background
# work. Cold-start of these endpoints is fast (CPU container with
# the cached `image`) so the HTTP response comes back in <1 s.

@app.function(
    image=image,
    volumes={"/data": mesh_output_volume},
    secrets=[
        modal.Secret.from_name("myfabmesh-shared", required_keys=["SHARED_SECRET"]),
    ],
)
@modal.asgi_app()
def mesh_router():
    """ASGI router consolidating the two CPU front-end mesh endpoints
    (mesh_start + mesh_status) into ONE Modal web-function slot.

    These run on the lightweight `image` (no GPU) for two reasons:

      1. mesh_start MUST respond < 1 s — it only enqueues work via
         `MyFabmeshMesh().generate_to_volume.spawn(...)` (THE real
         .remote()-style call in this file, untouched by this refactor).
         Putting the front-end on the GPU `mesh_image` would force a
         170 s TRELLIS-2 cold start before we could acknowledge the
         enqueue, blowing past Modal's 150 s HTTP cap.

      2. mesh_status is a pure Volume.reload() + file read — no GPU
         needed, and sharing the CPU container with mesh_start means
         the polling loop hits a warm container after the first call.
    """
    from fastapi import FastAPI, HTTPException, Request
    api = FastAPI(title="myfabmesh-mesh")

    @api.post("/mesh_start")
    async def mesh_start(request: Request):
        """Dual-purpose route:

        - op_type unset OR 'generate'   → async TRELLIS-2 mesh job. Spawns
          MyFabmeshMesh, returns {job_id, status: 'queued'} in <1s; the
          Worker polls mesh_status until the GLB is ready.

        - op_type ∈ {smooth, decimate, center, fix_normals, fill_holes} →
          synchronous CPU mesh edit via trimesh. Caller supplies a
          `mesh_url` (R2 / public HTTPS) we fetch, transform, and return
          as base64-encoded GLB. ~1s wall-clock for typical meshes, no GPU.

        - op_type == 'cancel' → cancel a running spawn by job_id.

        Body for the sync ops:
            {
              "_auth": "...",
              "op_type": "smooth" | "decimate" | "center" | "fix_normals" | "fill_holes",
              "mesh_url": "https://.../mesh.glb",
              "params": { ... }   // op-specific (e.g. iterations, target_faces)
            }
        Returns: { "glb_base64": "...", "bytes": N }
        """
        import uuid
        payload = await _read_json(request)
        _check_auth(payload)

        op_type = (payload.get("op_type") or "generate").strip().lower()

        # ── 3D construction stages (CPU trimesh, multi-GLB output) ──
        # Fabricates N stage meshes and parks them on the Volume; the
        # Worker then pulls them ONE per request via /c3d_fetch (a 5-stage
        # castle is ~200MB total — far beyond a single JSON response).
        # Runs inline in a thread: ~10-60s CPU, no GPU.
        if op_type == "construction3d":
            import asyncio, base64
            from modal_app._construction3d import build_stages
            mesh_url = (payload.get("mesh_url") or "").strip()
            if not mesh_url:
                raise HTTPException(status_code=400, detail="mesh_url required")
            import urllib.request
            try:
                req = urllib.request.Request(mesh_url, headers={
                    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) myfabmesh-cloud/1.0"})
                with urllib.request.urlopen(req, timeout=120) as r:
                    src = r.read()
            except Exception as e:
                raise HTTPException(status_code=502, detail=f"mesh download: {e}")
            params = payload.get("params") or {}
            try:
                stages = await asyncio.to_thread(
                    build_stages, src,
                    int(params.get("stage_count") or 5),
                    params.get("materials"))
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"construction3d: {e}")
            job_id = uuid.uuid4().hex
            sizes = []
            for i, blob in enumerate(stages):
                with open(f"/data/{job_id}_c3d_{i}.glb", "wb") as f:
                    f.write(blob)
                sizes.append(len(blob))
            mesh_output_volume.commit()
            return {"ok": True, "job_id": job_id, "count": len(stages), "sizes": sizes}

        # ── Synchronous CPU mesh edits ──────────────────────────────
        if op_type != "generate" and op_type != "cancel":
            from modal_app._mesh_op import OPS, run as run_mesh_op
            if op_type not in OPS:
                raise HTTPException(status_code=400,
                    detail=f"unknown op_type '{op_type}' (allowed: generate, {', '.join(OPS.keys())})")
            mesh_url = (payload.get("mesh_url") or "").strip()
            if not mesh_url:
                raise HTTPException(status_code=400, detail="mesh_url required for op_type=" + op_type)
            import urllib.request, base64
            try:
                req = urllib.request.Request(mesh_url, headers={
                    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) myfabmesh-cloud/1.0"})
                with urllib.request.urlopen(req, timeout=60) as r:
                    src = r.read()
            except Exception as e:
                raise HTTPException(status_code=502, detail=f"mesh download: {e}")
            try:
                out, stats = run_mesh_op(op_type, src, payload.get("params") or {})
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))
            resp = {
                "ok": True,
                "op_type": op_type,
                "bytes": len(out),
                "glb_base64": base64.b64encode(out).decode("ascii"),
            }
            if stats is not None:
                resp["stats"] = stats
            return resp

        # ── Cancel a running spawn ─────────────────────────────────
        if op_type == "cancel":
            job_id = (payload.get("job_id") or "").strip()
            if not job_id:
                raise HTTPException(status_code=400, detail="job_id required for cancel")
            call_id_path = f"/data/{job_id}.call_id"
            try:
                with open(call_id_path) as f:
                    call_id = f.read().strip()
            except FileNotFoundError:
                # Job finished before we could cancel, or never spawned.
                return {"ok": True, "cancelled": False, "reason": "no call_id on file"}
            try:
                modal.FunctionCall.from_id(call_id).cancel(terminate_containers=True)
                return {"ok": True, "cancelled": True, "call_id": call_id}
            except Exception as e:
                # Already finished, already cancelled, or transient — surface
                # the error but don't fail hard so the admin UI can still
                # mark the job canceled in Supabase.
                return {"ok": True, "cancelled": False, "error": str(e)}

        # ── Async TRELLIS-2 generate (original behaviour) ─────────────
        if not payload.get("front_image_url"):
            raise HTTPException(status_code=400, detail="front_image_url required")

        job_id = payload.get("job_id") or uuid.uuid4().hex
        # .spawn() returns a FunctionCall; save its object_id in the shared
        # volume so mesh_start with op_type='cancel' can find it and call
        # .cancel(). Without this we can mark the job canceled in Supabase
        # but the GPU keeps running to completion.
        # NOTE: this is the ONLY true cross-container .remote()-style call
        # in the file. It STAYS because mesh_start runs in a CPU container
        # and MyFabmeshMesh truly is a separate GPU container.
        call = MyFabmeshMesh().generate_to_volume.spawn(job_id, payload)
        try:
            with open(f"/data/{job_id}.call_id", "w") as f:
                f.write(call.object_id)
            mesh_output_volume.commit()
        except Exception as e:
            print(f"[mesh_start] WARN could not persist call_id for {job_id}: {e}", flush=True)
        return {"job_id": job_id, "status": "queued"}

    @api.post("/mesh_status")
    async def mesh_status(request: Request):
        """Worker polls this endpoint to know whether a mesh job is ready.
        Returns base64-encoded GLB inline once the worker container has
        written it to the Volume. No GPU needed — just a Volume read.
        """
        import base64
        payload = await _read_json(request)
        _check_auth(payload)
        job_id = (payload.get("job_id") or "").strip()
        if not job_id:
            raise HTTPException(status_code=400, detail="job_id required")

        # Reload so we see the latest commits from the GPU worker container.
        mesh_output_volume.reload()
        out_path = f"/data/{job_id}.glb"
        err_path = f"/data/{job_id}.err"
        if os.path.isfile(err_path):
            with open(err_path) as f:
                return {"ready": False, "error": f.read()[:500]}
        if os.path.isfile(out_path):
            with open(out_path, "rb") as f:
                glb = f.read()
            return {
                "ready": True,
                "glb_base64": base64.b64encode(glb).decode("ascii"),
                "bytes": len(glb),
            }
        return {"ready": False}

    @api.post("/c3d_fetch")
    async def c3d_fetch(request: Request):
        """Fetch ONE construction stage parked on the Volume by a previous
        op_type=construction3d call — one GLB per response (a full stage
        set would blow the Worker's memory). Files are deleted lazily by
        the Volume's normal retention; no explicit GC here."""
        import base64
        payload = await _read_json(request)
        _check_auth(payload)
        job_id = (payload.get("job_id") or "").strip()
        index = payload.get("index")
        if not job_id or index is None:
            raise HTTPException(status_code=400, detail="job_id and index required")
        if not str(job_id).isalnum():
            raise HTTPException(status_code=400, detail="bad job_id")
        mesh_output_volume.reload()
        out_path = f"/data/{job_id}_c3d_{int(index)}.glb"
        if not os.path.isfile(out_path):
            return {"ready": False}
        with open(out_path, "rb") as f:
            glb = f.read()
        return {"ready": True, "glb_base64": base64.b64encode(glb).decode("ascii"),
                "bytes": len(glb)}

    @api.post("/mesh_convert")
    async def mesh_convert(request: Request):
        """Export-format conversion, separate from /mesh_start on purpose.

        /mesh_start's ops are *edits*: the Worker bills a credit and files
        the result back into the project as a new mesh. An export is
        neither — it must not charge and must not add an .fbx entry to the
        user's mesh list. Hence its own route.

        Body: {"_auth": "...", "mesh_url": "https://.../mesh.glb",
               "format": "fbx"|"obj"|"stl"|"ply"|"gltf"|"usd"|"abc"|"dae"}
        Returns: {ok, data_base64, ext, bytes}. `ext` is authoritative —
        it comes back as 'zip' when the format needed sidecar files, so
        the caller must name the download from it rather than from the
        requested format.
        """
        import base64
        import urllib.request

        payload = await _read_json(request)
        _check_auth(payload)

        from modal_app._convert_op import FORMATS
        fmt = (payload.get("format") or "").strip().lower().lstrip(".")
        if fmt not in FORMATS:
            raise HTTPException(status_code=400,
                detail=f"unsupported format '{fmt}' "
                       f"(supported: {', '.join(sorted(FORMATS))})")

        mesh_url = (payload.get("mesh_url") or "").strip()
        if not mesh_url:
            raise HTTPException(status_code=400, detail="mesh_url required")
        try:
            req = urllib.request.Request(mesh_url, headers={
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) myfabmesh-cloud/1.0"})
            with urllib.request.urlopen(req, timeout=120) as r:
                src = r.read()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"mesh download: {e}")

        # Runs on blender_image in its own container; first call after an
        # idle period pays a cold start (~30-60s) that the caller's
        # timeout must accommodate.
        try:
            out, ext = blender_convert.remote(src, fmt)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"convert failed: {e}")

        return {"ok": True, "format": fmt, "ext": ext, "bytes": len(out),
                "data_base64": base64.b64encode(out).decode("ascii")}

    @api.get("/healthz")
    async def healthz():
        return {"ok": True, "fn": "mesh_router"}

    return api


# ===========================================================================


@app.local_entrypoint()
def smoke():
    """Smoke-test the web endpoint by calling it via HTTPS.

    Run with:  modal run modal_app/app.py
    """
    import urllib.request, json as _json
    import os as _os
    url = _os.environ.get("MODAL_TEXT2IMAGE_URL")
    secret = _os.environ.get("SHARED_SECRET")
    if not url or not secret:
        print("Set MODAL_TEXT2IMAGE_URL and SHARED_SECRET before running smoke.")
        return
    body = _json.dumps({
        "_auth": secret,
        "prompt": "medieval orc warrior with axe",
        "asset_type": "character",
        "asset_style": "realistic",
        "seed": 424242,
        "steps": 30,
    }).encode()
    req = urllib.request.Request(url, data=body,
                                  headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        png = r.read()
    out_path = "modal_app/_smoke_out.png"
    with open(out_path, "wb") as f:
        f.write(png)
    print(f"smoke output saved to {out_path} ({len(png)} bytes)")
