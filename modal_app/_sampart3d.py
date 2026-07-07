"""SAMPart3D — segmentation sémantique de mesh en parties (cloud / Modal).

Reçoit les bytes d'un GLB, découpe le mesh en parties (tête / buste / bras
/ jambes ; roue / châssis / cabine ; etc.) et renvoie des **labels entiers
par-face** (un `.npy` d'entiers de longueur = nombre de faces). Le desktop
et le worker re-projettent ensuite ces labels en sous-meshes coloriés /
séparables.

────────────────────────────────────────────────────────────────────────
POINT CRITIQUE (dicté par la recherche pipeline du 2026-07-07) :
SAMPart3D N'EST PAS feedforward. Pour CHAQUE mesh il entraîne un petit MLP
"grouping field" from-scratch (5000 itérations, ~5 min) par-dessus un
backbone PTv3 GELÉ (`ptv3-object.pth`, 452 Mo). Coût total par mesh :
  rendu Blender 16 vues + SAM ViT-H (~1 min) + optim MLP (~5 min)
  + HDBSCAN + vote par-face  ≈ 6-10 min GPU.
→ On l'architecture donc comme un JOB ASYNCHRONE (comme _puppeteer_rig.py),
  jamais comme un endpoint HTTP synchrone. timeout=1500 s (25 min).

Étapes internes (pilotées via les scripts upstream, cwd=/SAMPart3D) :
  1. Blender-4.0 headless → 16 vues RGB + depth (tools/blender_render_16views.py)
  2. SAM ViT-H (facebook/sam-vit-huge, transformers) → masques 2D (à la volée)
  3. PTv3 gelé (ptv3-object.pth) → features 384-d par point (15k points)
  4. optim MLP scale-conditionné 5000 iters  → scripts/train.sh
  5. HDBSCAN (sklearn, pas RAPIDS) + vote par-face → scripts/eval.sh
     → sortie: exp/sampart3d/{name}/results/{weight}/mesh_{scale}.npy

────────────────────────────────────────────────────────────────────────
ALLÈGEMENTS vs INSTALL.md upstream (validés par la recherche) :
- RAPIDS cuml/cudf (HDBSCAN GPU) → REMPLACÉ par sklearn.cluster.HDBSCAN
  (le cluster tourne sur ~15k points, CPU suffit) : évite tout le stack
  RAPIDS glibc/CUDA-pointilleux dans l'image.
- flash-attn → DÉSACTIVÉ (`enable_flash=False` dans le config PTv3). PTv3
  tourne sans, ça évite l'enfer de compilation flash-attn.
- DINOv2 : PAS utilisé à l'inférence (déjà distillé dans ptv3-object.pth).

GPU : torch 2.1.0 / cu121 → sm_90 max. On vise A100 (rapide pour l'optim
5000 iters) ; A10G/L4 24 Go marchent aussi (proche du 4090 testé upstream).
PAS de B200 / RTX 5090 (sm_120) avec ce stack torch 2.1 figé.

DEPLOY:
    modal secret create huggingface HF_TOKEN=<hf token>          # (si pas déjà fait)
    modal secret create myfabmesh-shared SHARED_SECRET=<32-byte hex>  # (idem)
    modal deploy modal_app/_sampart3d.py
Le worker pointe MODAL_SEGMENT_URL sur l'URL du router `segment_router`.

License: SAMPart3D = MIT (code + poids). SAM ViT-H = Apache-2.0.
Blender = GPL (utilisé comme binaire externe headless, pas linké).
────────────────────────────────────────────────────────────────────────
⚠ À VÉRIFIER AU 1er DÉPLOIEMENT (marqués `# DEPLOY-VERIFY` dans le code) :
- noms exacts des clés de chemins dans le config Pointcept
  (mesh_root / data_root / backbone_weight_path) — `_patch_config()` les
  réécrit par regex et LOG un warning si une clé n'est pas trouvée.
- signature exacte de tools/blender_render_16views.py (ordre des args).
- emplacement de sortie `results/{weight}/mesh_{scale}.npy`.
Le build de l'image (deps + compiles + checkpoints) est, lui, déterministe.
"""
import base64
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.request
import uuid

import modal

# ---------------------------------------------------------------------------
# Image : CUDA 12.1 devel (nvcc requis pour compiler pointops + tiny-cuda-nn),
# Python 3.10, torch 2.1.0+cu121 — l'env EXACT testé par upstream (INSTALL.md,
# RTX 4090 24 Go). On NE bump PAS torch : les compiles pointops/spconv/tcnn
# sont figées dessus.
# ---------------------------------------------------------------------------
SAMPART3D_REPO = "https://github.com/Pointcept/SAMPart3D.git"
PTV3_HF_REPO = "yhyang-myron/SAMPart3D"          # ptv3-object.pth (452 Mo, MIT)
PTV3_CKPT_FILE = "ptv3-object.pth"
SAM_HF_REPO = "facebook/sam-vit-huge"            # ~2.5 Go, Apache-2.0
BLENDER_URL = (
    "https://download.blender.org/release/Blender4.0/"
    "blender-4.0.0-linux-x64.tar.xz"
)
BLENDER_DIR = "/opt/blender-4.0.0-linux-x64"

image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.1.1-devel-ubuntu22.04",
        add_python="3.10",
    )
    .env({"CUDA_HOME": "/usr/local/cuda"})
    .apt_install(
        "git", "build-essential", "ninja-build", "cmake",
        # Blender headless + trimesh/opencv/open3d partagent ces libs GL/X11.
        "libgl1", "libegl1", "libglib2.0-0", "libsm6", "libxext6",
        "libxrender1", "libxi6", "libxxf86vm1", "libxfixes3", "libxkbcommon0",
        # Décompression de l'archive Blender (.tar.xz) + fetch.
        "xz-utils", "wget", "ca-certificates",
        # OpenEXR : les depth maps rendues par Blender sont en .exr.
        "libopenexr-dev", "openexr",
    )
    # ---- PyTorch 2.1.0 + cu121 (env upstream figé) ----
    .pip_install(
        "torch==2.1.0",
        "torchvision==0.16.0",
        "torchaudio==2.1.0",
        extra_options="--index-url https://download.pytorch.org/whl/cu121",
    )
    # ---- Build deps pour les compiles CUDA (pointops / tiny-cuda-nn) ----
    .pip_install("packaging", "setuptools", "wheel", "ninja")
    # ---- requirements.txt upstream (sans pins) + torch-scatter ----
    .pip_install(
        "Pillow", "opencv-python", "transformers", "einops",
        "scikit-learn", "tensorboard", "tensorboardx", "yapf", "addict",
        "scipy", "timm", "open3d", "trimesh", "huggingface_hub>=0.34",
        "accelerate>=0.30", "numpy<2",
        # FastAPI — requis par @modal.fastapi_endpoint / @modal.asgi_app.
        "fastapi[standard]>=0.115",
    )
    .pip_install(
        # torch-scatter apparié à torch 2.1.0+cu121 (index PyG, pas PyPI).
        "torch-scatter",
        extra_options="-f https://data.pyg.org/whl/torch-2.1.0+cu121.html",
    )
    .pip_install(
        # spconv apparié à CUDA 12.1 (wheel binaire, pas de compile).
        "spconv-cu120",
    )
    .env({
        "CC": "gcc", "CXX": "g++",
        "CUDA_HOME": "/usr/local/cuda",
        # sm_80 (A100) + sm_89 (A10G/L4) + sm_90 (H100) — l'éventail Modal
        # compatible cu121. PAS de 120 (torch 2.1 ne l'a pas de toute façon).
        "TORCH_CUDA_ARCH_LIST": "8.0;8.6;8.9;9.0+PTX",
        "TCNN_CUDA_ARCHITECTURES": "80;86;89;90",
        "FORCE_CUDA": "1",
        "HF_HOME": "/root/.cache/huggingface",
    })
    # ---- tiny-cuda-nn (encodage positionnel du grouping-field MLP) ----
    # Compile depuis git NVlabs contre notre torch + nvcc. ~5-10 min.
    .run_commands(
        "pip install --no-build-isolation "
        "'git+https://github.com/NVlabs/tiny-cuda-nn/#subdirectory=bindings/torch'",
    )
    # ---- Blender 4.0.0 (binaire headless pour le rendu 16 vues) ----
    .run_commands(
        f"wget -q -O /tmp/blender.tar.xz {BLENDER_URL}",
        "tar -xf /tmp/blender.tar.xz -C /opt",
        "rm /tmp/blender.tar.xz",
        f"test -x {BLENDER_DIR}/blender && echo 'blender ok'",
    )
    # ---- Clone SAMPart3D + compile pointops + patches ----
    .add_local_file(
        "modal_app/_patch_sampart3d.py",
        "/tmp/_patch_sampart3d.py",
        copy=True,
    )
    .run_commands(
        f"git clone --depth 1 {SAMPART3D_REPO} /SAMPart3D",
        # pointops : knn_query au clustering/vote (REQUIS à l'inférence).
        "cd /SAMPart3D/libs/pointops && python setup.py install",
        # Patches upstream : enable_flash=False (drop flash-attn) +
        # cuml.HDBSCAN → sklearn.cluster.HDBSCAN (drop RAPIDS).
        # Fait par un script Python (paren/indent matching propre, pas sed).
        "python /tmp/_patch_sampart3d.py /SAMPart3D",
    )
    # ---- Checkpoints : ptv3-object.pth + SAM ViT-H (bakés dans l'image) ----
    .run_commands(
        "python -c \""
        "from huggingface_hub import hf_hub_download; "
        "import os; tok = os.environ.get('HF_TOKEN'); "
        f"hf_hub_download(repo_id='{PTV3_HF_REPO}', filename='{PTV3_CKPT_FILE}', "
        "local_dir='/ckpts', token=tok); "
        "print('ptv3-object.pth downloaded')\"",
        # Pré-télécharge SAM ViT-H dans le cache HF pour éviter un pull de
        # 2.5 Go au cold-start (le dataset l'instancie via transformers).
        "python -c \""
        "from transformers import pipeline; "
        "pipeline('mask-generation', model='facebook/sam-vit-huge'); "
        "print('sam-vit-huge cached')\"",
        # Guard de build : échoue le build si un ckpt manque/est vide.
        "python -c \"import os; "
        "p='/ckpts/ptv3-object.pth'; "
        "assert os.path.isfile(p) and os.path.getsize(p) > 1024*1024, "
        "f'ptv3 ckpt missing/empty: {p}'; print('ckpt guard ok')\"",
        secrets=[
            modal.Secret.from_name("huggingface", required_keys=["HF_TOKEN"]),
        ],
    )
)

app = modal.App("myfabmesh-segment", image=image)

# Volume pour persister les sorties async (labels par-face), même pattern
# que _puppeteer_rig.py : segment-start spawn → segment-status poll →
# segment-fetch stream. /data/<job_id>.npz (labels) ou <job_id>.err.
seg_output_volume = modal.Volume.from_name(
    "myfabmesh-segment-output", create_if_missing=True,
)

# ---------------------------------------------------------------------------
# Chemins internes
# ---------------------------------------------------------------------------
SAMPART3D_DIR = "/SAMPart3D"
PTV3_CKPT = f"/ckpts/{PTV3_CKPT_FILE}"
CONFIG_NAME = "sampart3d-trainmlp-render16views"       # DEPLOY-VERIFY nom config
CONFIG_PATH = f"{SAMPART3D_DIR}/configs/sampart3d/{CONFIG_NAME}.py"
# Échelles de granularité émises par eval (basse = fin/plus de parties).
# La recherche donne val_scales_list=[0.0, 0.5, 1.0, 1.5, 2.0].
DEFAULT_SCALES = [0.0, 0.5, 1.0, 1.5, 2.0]


def _log(msg: str) -> None:
    print(f"[segment] {msg}", flush=True)


def _stream(proc: subprocess.Popen) -> int:
    """Relaie stdout ligne-à-ligne vers les logs Modal (progression optim)."""
    if proc.stdout is None:
        return proc.wait()
    for line in proc.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
    return proc.wait()


def _run(cmd, cwd, env=None, label=""):
    _log(f"{label}: {' '.join(cmd)}  (cwd={cwd})")
    proc = subprocess.Popen(
        cmd, cwd=cwd, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1, encoding="utf-8", errors="replace",
    )
    rc = _stream(proc)
    _log(f"{label}: rc={rc}")
    return rc


def _patch_config(mesh_root: str, render_root: str, exp_root: str) -> None:
    """Réécrit les chemins de données dans le config Pointcept vers nos
    répertoires de job. DEPLOY-VERIFY : les noms de clés (`mesh_root`,
    `data_root`, `backbone_weight_path`) proviennent de la recherche ; si
    une clé n'existe pas telle quelle dans le config upstream, on LOG un
    warning explicite (le 1er déploiement révèle le nom exact)."""
    if not os.path.isfile(CONFIG_PATH):
        _log(f"WARN config introuvable: {CONFIG_PATH} — skip patch")
        return
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        src = f.read()

    # (clé_config, nouvelle_valeur). On matche `key = "..."` ou `key = '...'`.
    replacements = {
        "mesh_root": mesh_root,
        "data_root": render_root,
        "backbone_weight_path": PTV3_CKPT,
        "save_path": exp_root,
    }
    for key, val in replacements.items():
        pat = re.compile(
            rf'(^\s*{re.escape(key)}\s*=\s*)(["\']).*?\2',
            re.MULTILINE,
        )
        if pat.search(src):
            src = pat.sub(rf'\g<1>"{val}"', src)
            _log(f"config: {key} -> {val}")
        else:
            _log(f"WARN config: clé '{key}' introuvable (DEPLOY-VERIFY)")

    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        f.write(src)


def _render_blender(mesh_glb: str, out_dir: str) -> int:
    """Rendu 16 vues RGB + depth via Blender headless.
    DEPLOY-VERIFY signature: `blender -b -P tools/blender_render_16views.py
    <MESH_PATH> <TYPES> <OUTPUT_PATH>` (ordre des args upstream)."""
    os.makedirs(out_dir, exist_ok=True)
    script = f"{SAMPART3D_DIR}/tools/blender_render_16views.py"
    cmd = [
        f"{BLENDER_DIR}/blender", "-b",
        "-P", script,
        "--",                       # sépare les args Blender des args script
        mesh_glb,
        "object",                   # TYPES (DEPLOY-VERIFY: valeur attendue)
        out_dir,
    ]
    # Certains scripts Blender ne veulent PAS le `--` (parsing sys.argv brut).
    # On tente d'abord avec `--`; si rc!=0 et aucune vue produite, retry sans.
    rc = _run(cmd, cwd=f"{SAMPART3D_DIR}/tools", label="blender(--)")
    produced = any(
        fn.startswith("render_") for fn in _safe_listdir(out_dir)
    )
    if rc != 0 or not produced:
        _log("blender: retry sans séparateur '--'")
        cmd_no_sep = [
            f"{BLENDER_DIR}/blender", "-b", "-P", script,
            mesh_glb, "object", out_dir,
        ]
        rc = _run(cmd_no_sep, cwd=f"{SAMPART3D_DIR}/tools", label="blender")
    return rc


def _safe_listdir(p):
    try:
        return os.listdir(p)
    except Exception:
        return []


def _find_labels_npy(exp_root: str, exp_name: str, weight: str,
                     scale: float):
    """Localise le .npy de labels par-face pour une échelle donnée.
    Sortie upstream: exp/sampart3d/{name}/results/{weight}/mesh_{scale}.npy
    (DEPLOY-VERIFY chemin). On tente plusieurs variantes de nom de fichier
    car le formatage du float (0.0 vs 0 vs 0.00) peut varier."""
    results_dir = os.path.join(
        exp_root, "sampart3d", exp_name, "results", str(weight),
    )
    if not os.path.isdir(results_dir):
        # fallback: cherche récursivement un results/ sous exp_root
        for root, dirs, files in os.walk(exp_root):
            if os.path.basename(root) == str(weight) and "results" in root:
                results_dir = root
                break
    candidates = [
        f"mesh_{scale}.npy",
        f"mesh_{scale:.1f}.npy",
        f"mesh_{scale:.2f}.npy",
        f"mesh_{int(scale)}.npy" if float(scale).is_integer() else None,
    ]
    for name in filter(None, candidates):
        p = os.path.join(results_dir, name)
        if os.path.isfile(p):
            return p
    # dernier recours : n'importe quel mesh_*.npy présent
    for fn in _safe_listdir(results_dir):
        if fn.startswith("mesh_") and fn.endswith(".npy"):
            _log(f"labels: fallback sur {fn} (scale demandé {scale} absent)")
            return os.path.join(results_dir, fn)
    return None


# ---------------------------------------------------------------------------
# Fonction GPU — segmente `glb_bytes`, renvoie un dict de labels par-face
# (numpy encodé) pour chaque échelle. Persiste sur le Volume si job_id fourni.
# ---------------------------------------------------------------------------
@app.function(
    image=image,
    gpu="A100",
    timeout=1500,                 # 25 min : rendu + SAM + 5000-iter optim + eval
    volumes={"/seg_data": seg_output_volume},
    secrets=[
        modal.Secret.from_name("huggingface", required_keys=["HF_TOKEN"]),
    ],
)
def segment_mesh(
    glb_bytes: bytes,
    scales=None,
    job_id: str | None = None,
) -> bytes:
    """Segmente le GLB en parties → labels entiers PAR-FACE.

    Renvoie (et persiste sur le Volume si `job_id`) un `.npz` numpy
    contenant :
      - `scales`     : liste des échelles calculées
      - `labels_<s>` : array int32 de longueur = nb de faces, pour chaque
                       échelle `s` (un label = un id de partie, 0..K-1)
      - `n_faces`    : nombre de faces du mesh d'entrée
    Le caller (worker/desktop) choisit l'échelle et re-projette en
    sous-meshes coloriés.

    Sur `job_id`, écrit /seg_data/<job_id>.npz (succès) ou <job_id>.err
    (échec JSON) pour que segment_status/segment_fetch servent le résultat.
    """
    import numpy as np

    t_total = time.time()
    scales = list(scales) if scales else list(DEFAULT_SCALES)
    tmp_dir = tempfile.mkdtemp(prefix="sampart3d_")
    try:
        try:
            out_bytes = _run_segment_pipeline(
                glb_bytes, tmp_dir, scales, t_total)
        except Exception as e:
            if job_id:
                try:
                    with open(f"/seg_data/{job_id}.err", "w") as f:
                        f.write(json.dumps({
                            "error": str(e),
                            "type": type(e).__name__,
                            "trace": traceback.format_exc(),
                        })[:8000])
                    seg_output_volume.commit()
                    _log(f"wrote /seg_data/{job_id}.err")
                except Exception as e2:
                    _log(f"WARN err-file write failed for {job_id}: {e2}")
            raise

        if job_id:
            try:
                with open(f"/seg_data/{job_id}.npz", "wb") as f:
                    f.write(out_bytes)
                seg_output_volume.commit()
                _log(f"wrote /seg_data/{job_id}.npz ({len(out_bytes)} bytes)")
            except Exception as e:
                _log(f"WARN volume write failed for {job_id}: {e}")
        return out_bytes
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def _run_segment_pipeline(glb_bytes: bytes, tmp_dir: str, scales,
                          t_total: float) -> bytes:
    """Corps du pipeline (extrait pour l'enrobage async). Renvoie le `.npz`
    (bytes) des labels par-face."""
    import numpy as np
    import trimesh

    oid = "fabmesh"
    # ── Layout de données attendu par les scripts upstream ──
    mesh_root = os.path.join(tmp_dir, "mesh")            # {mesh_root}/{oid}.glb
    render_root = os.path.join(tmp_dir, "render")        # rendus 16 vues
    exp_root = os.path.join(tmp_dir, "exp")              # exp/sampart3d/{oid}/…
    for d in (mesh_root, render_root, exp_root):
        os.makedirs(d, exist_ok=True)
    mesh_glb = os.path.join(mesh_root, f"{oid}.glb")
    with open(mesh_glb, "wb") as f:
        f.write(glb_bytes)

    # Nb de faces du mesh d'entrée (pour valider la longueur des labels).
    src_mesh = trimesh.load(mesh_glb, force="mesh")
    n_faces = int(len(src_mesh.faces))
    _log(f"mesh chargé: {n_faces} faces, {len(src_mesh.vertices)} vertices")

    # ── Étape 0 : patch config (chemins → nos dirs) ──
    _patch_config(mesh_root, render_root, exp_root)

    # ── Étape 1 : rendu Blender 16 vues ──
    _log("== Étape 1 : rendu Blender 16 vues ==")
    t0 = time.time()
    render_out = os.path.join(render_root, oid)
    rc = _render_blender(mesh_glb, render_out)
    n_views = sum(
        1 for fn in _safe_listdir(render_out) if fn.startswith("render_")
    )
    if n_views == 0:
        raise RuntimeError(
            f"rendu Blender: aucune vue produite (rc={rc}). "
            f"Vérifier la signature de blender_render_16views.py.")
    _log(f"étape 1 ok en {time.time()-t0:.1f}s ({n_views} vues)")

    # ── Étape 2 : optim MLP (train.sh) — inclut SAM + PTv3 + 5000 iters ──
    _log("== Étape 2 : optim grouping-field MLP (train.sh, ~5 min) ==")
    t0 = time.time()
    env = dict(os.environ)
    env["PYTHONPATH"] = SAMPART3D_DIR + os.pathsep + env.get("PYTHONPATH", "")
    rc = _run(
        ["sh", "scripts/train.sh",
         "-g", "1", "-d", "sampart3d", "-c", CONFIG_NAME,
         "-n", oid, "-o", oid],
        cwd=SAMPART3D_DIR, env=env, label="train",
    )
    if rc != 0:
        raise RuntimeError(f"train.sh a échoué (rc={rc})")
    _log(f"étape 2 ok en {time.time()-t0:.1f}s")

    # ── Étape 3 : cluster + vote par-face (eval.sh) → mesh_{scale}.npy ──
    _log("== Étape 3 : HDBSCAN + vote par-face (eval.sh) ==")
    t0 = time.time()
    weight = "5000"
    rc = _run(
        ["sh", "scripts/eval.sh",
         "-g", "1", "-d", "sampart3d", "-n", oid, "-w", weight],
        cwd=SAMPART3D_DIR, env=env, label="eval",
    )
    if rc != 0:
        raise RuntimeError(f"eval.sh a échoué (rc={rc})")
    _log(f"étape 3 ok en {time.time()-t0:.1f}s")

    # ── Étape 4 : collecte des labels par-face pour chaque échelle ──
    _log("== Étape 4 : collecte des labels par-face ==")
    payload = {"scales": [], "n_faces": n_faces}
    for scale in scales:
        npy = _find_labels_npy(exp_root, oid, weight, scale)
        if npy is None:
            _log(f"WARN: aucun mesh_{scale}.npy trouvé — échelle ignorée")
            continue
        labels = np.load(npy).astype(np.int32).reshape(-1)
        if labels.shape[0] != n_faces:
            _log(f"WARN: labels[{scale}] len={labels.shape[0]} != n_faces="
                 f"{n_faces} — conservé tel quel (le caller remappe).")
        n_parts = int(labels.max()) + 1 if labels.size else 0
        payload["scales"].append(float(scale))
        payload[f"labels_{scale}"] = labels
        _log(f"échelle {scale}: {n_parts} parties, {labels.shape[0]} labels")

    if not payload["scales"]:
        raise RuntimeError(
            "aucun fichier de labels produit par eval — "
            "vérifier le chemin results/{weight}/mesh_{scale}.npy")

    buf = io.BytesIO()
    np.savez_compressed(buf, **payload)
    out_bytes = buf.getvalue()
    _log(f"TOTAL dt={time.time()-t_total:.1f}s  npz={len(out_bytes)} bytes  "
         f"scales={payload['scales']}")
    return out_bytes


# ---------------------------------------------------------------------------
# Router ASGI async — segment-start (spawn) / segment-status (poll) /
# segment-fetch (stream). Miroir de rig_router dans _puppeteer_rig.py.
# ---------------------------------------------------------------------------
@app.function(
    image=image,
    timeout=120,
    volumes={"/seg_data": seg_output_volume},
    secrets=[
        modal.Secret.from_name(
            "myfabmesh-shared", required_keys=["SHARED_SECRET"],
        ),
    ],
)
@modal.asgi_app()
def segment_router():
    """Router : /segment-start, /segment-status, /segment-fetch, /healthz.
    Chaque appel retourne en <1 s (le GPU tourne dans un container séparé
    via .spawn()) → compatible cap 100 s des Workers Cloudflare."""
    from fastapi import FastAPI, HTTPException, Request
    from fastapi.responses import JSONResponse, FileResponse

    api = FastAPI(title="myfabmesh-segment")

    async def _read_json(request: Request) -> dict:
        try:
            return await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="invalid JSON body")

    def _check_auth(payload: dict) -> None:
        expected = os.environ.get("SHARED_SECRET", "")
        provided = (payload or {}).get("_auth") or ""
        if not expected or provided != expected:
            raise HTTPException(status_code=401, detail="unauthorized")

    @api.get("/healthz")
    async def healthz():
        return {"ok": True, "fn": "segment_router"}

    @api.post("/segment-start")
    async def segment_start(request: Request):
        """Spawn async d'un job de segmentation.
        Body: {"_auth","mesh_url", "scales"?:[..], "job_id"?}
              op_type=="cancel" → annule un spawn en cours par job_id.
        Retour: {"job_id","status":"queued"}."""
        payload = await _read_json(request)
        _check_auth(payload)

        op_type = (payload.get("op_type") or "segment").strip().lower()
        if op_type == "cancel":
            job_id = (payload.get("job_id") or "").strip()
            if not job_id:
                raise HTTPException(status_code=400, detail="job_id required")
            try:
                with open(f"/seg_data/{job_id}.call_id") as f:
                    call_id = f.read().strip()
            except FileNotFoundError:
                return {"ok": True, "cancelled": False,
                        "reason": "no call_id on file"}
            try:
                modal.FunctionCall.from_id(call_id).cancel(
                    terminate_containers=True)
                return {"ok": True, "cancelled": True, "call_id": call_id}
            except Exception as e:
                return {"ok": True, "cancelled": False, "error": str(e)}

        mesh_url = (payload.get("mesh_url") or "").strip()
        if not mesh_url:
            raise HTTPException(status_code=400, detail="mesh_url required")
        scales = payload.get("scales")
        if scales is not None and not isinstance(scales, list):
            raise HTTPException(status_code=400, detail="scales must be a list")

        # Télécharge le GLB ici (container CPU, cheap) plutôt que sur le GPU.
        try:
            req = urllib.request.Request(
                mesh_url, headers={"User-Agent": "myfabmesh-segment/1.0"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                in_bytes = resp.read()
        except Exception as e:
            raise HTTPException(status_code=502,
                                detail=f"mesh fetch failed: {e}")
        if not in_bytes or in_bytes[:4] != b"glTF":
            raise HTTPException(status_code=400,
                                detail="mesh_url did not return a GLB")

        job_id = (payload.get("job_id") or "").strip() or uuid.uuid4().hex
        call = segment_mesh.spawn(in_bytes, scales=scales, job_id=job_id)
        try:
            with open(f"/seg_data/{job_id}.call_id", "w") as f:
                f.write(call.object_id)
            seg_output_volume.commit()
        except Exception as e:
            _log(f"WARN could not persist call_id for {job_id}: {e}")
        return {"job_id": job_id, "status": "queued"}

    @api.post("/segment-status")
    async def segment_status(request: Request):
        """Un tick de poll. {"ready":false} | {"ready":false,"error":…} |
        {"ready":true,"bytes":N,"fetch_endpoint":"/segment-fetch"}."""
        payload = await _read_json(request)
        _check_auth(payload)
        job_id = (payload.get("job_id") or "").strip()
        if not job_id:
            raise HTTPException(status_code=400, detail="job_id required")

        seg_output_volume.reload()
        out_path = f"/seg_data/{job_id}.npz"
        err_path = f"/seg_data/{job_id}.err"
        if os.path.isfile(err_path):
            with open(err_path) as f:
                raw = f.read()
            err_msg = raw
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict) and parsed.get("error"):
                    err_msg = str(parsed["error"])
            except Exception:
                pass
            return JSONResponse({"ready": False, "error": err_msg[:500]})
        if os.path.isfile(out_path):
            return JSONResponse({
                "ready": True,
                "bytes": os.path.getsize(out_path),
                "fetch_endpoint": "/segment-fetch",
            })
        return JSONResponse({"ready": False})

    @api.post("/segment-fetch")
    async def segment_fetch(request: Request):
        """Stream le .npz de labels pour job_id. 404 si pas prêt, 410 si .err."""
        payload = await _read_json(request)
        _check_auth(payload)
        job_id = (payload.get("job_id") or "").strip()
        if not job_id:
            raise HTTPException(status_code=400, detail="job_id required")
        if ("/" in job_id or ".." in job_id
                or not all(c in "0123456789abcdef" for c in job_id.lower())):
            raise HTTPException(status_code=400, detail="job_id must be hex")
        seg_output_volume.reload()
        out_path = f"/seg_data/{job_id}.npz"
        err_path = f"/seg_data/{job_id}.err"
        if os.path.isfile(err_path):
            raise HTTPException(status_code=410, detail="segment failed")
        if not os.path.isfile(out_path):
            raise HTTPException(status_code=404, detail="segment not ready")
        return FileResponse(
            out_path,
            media_type="application/octet-stream",
            filename=f"{job_id}.npz",
        )

    return api
