"""SAMPart3D — segmentation sémantique de mesh en parties (cloud / Modal).

Reçoit les bytes d'un GLB, découpe le mesh en parties (tête / buste / bras
/ jambes ; roue / châssis / cabine ; etc.) et renvoie **un GLB SEGMENTÉ** :
chaque partie est un sous-mesh NOMMÉ (`part_00`, `part_01`, …) d'une couleur
pleine distincte. Contrat identique à l'auto-rig (GLB in → GLB out) : le
worker le stocke en R2, le viewer le charge comme nouvelle version de mesh
(aucun parsing côté client). En interne SAMPart3D produit des labels par-face
(vote depuis un nuage de points) qu'on re-projette en sous-meshes via trimesh.

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
CONFIRMÉ depuis les sources officielles (2026-07-08) :
- repo GitHub Pointcept/SAMPart3D (MIT), config sampart3d-trainmlp-render16views ;
- clés config = mesh_root / data_root / backbone_weight_path (toutes "") ;
  val_scales_list = [0.0, 0.5, 1.0, 1.5, 2.0] ;
- Blender : `blender -b -P blender_render_16views.py <MESH> glb <OUT>` (TYPES="glb",
  pas de séparateur '--') ;
- sortie : exp/sampart3d/{name}/results/{weight}/mesh_{scale}.npy, RELATIF au cwd.

⚠ Restant runtime (géré défensivement, non bloquant) : le formatage exact du
float dans `mesh_{scale}.npy` (0.0 vs 0 vs 0.00) → `_find_labels_npy()` teste
plusieurs variantes + fallback récursif. Le build de l'image (deps + compiles
+ checkpoints) est déterministe.
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
        "FORCE_CUDA": "1",
        "HF_HOME": "/root/.cache/huggingface",
    })
    # NB : tiny-cuda-nn n'est PAS installé — `_patch_sampart3d.py` remplace
    # `import tinycudann as tcnn` par un MLP pur-torch équivalent (SAMPart3D
    # ne s'en sert que comme 2 MLP denses). Évite une compile fragile.
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


def _patch_config(mesh_root: str, render_root: str) -> None:
    """Réécrit les chemins de données dans le config Pointcept vers nos
    répertoires de job. Clés CONFIRMÉES depuis le config upstream
    (sampart3d-trainmlp-render16views.py, toutes = "" par défaut) :
    `mesh_root`, `data_root`, `backbone_weight_path`. Le save_path n'est
    PAS dans ce config : il est fixé par scripts/train.sh (=exp/{dataset}/
    {name}, relatif au cwd), donc on ne le patche pas ici."""
    if not os.path.isfile(CONFIG_PATH):
        _log(f"WARN config introuvable: {CONFIG_PATH} — skip patch")
        return
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        src = f.read()

    # (clé_config, nouvelle_valeur). On matche `key = "..."` ou `key = '...'`
    # (y compris la valeur vide `key = ""` du config upstream).
    replacements = {
        "mesh_root": mesh_root,
        "data_root": render_root,
        "backbone_weight_path": PTV3_CKPT,
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
    Signature OFFICIELLE (README SAMPart3D) :
      blender -b -P blender_render_16views.py <MESH_PATH> <TYPES> <OUTPUT_PATH>
    où TYPES = le TYPE DE FICHIER du mesh ("glb"), et SANS séparateur '--'
    (leur script lit sys.argv directement). Ex. upstream :
      blender -b -P blender_render_16views.py mesh_root/knight.glb glb data_root/knight
    """
    os.makedirs(out_dir, exist_ok=True)
    script = f"{SAMPART3D_DIR}/tools/blender_render_16views.py"
    tools_dir = f"{SAMPART3D_DIR}/tools"
    # Forme documentée : pas de '--', TYPES="glb".
    cmd = [f"{BLENDER_DIR}/blender", "-b", "-P", script, mesh_glb, "glb", out_dir]
    rc = _run(cmd, cwd=tools_dir, label="blender")
    produced = any(fn.startswith("render_") for fn in _safe_listdir(out_dir))
    if rc != 0 or not produced:
        # Fallback défensif : si un fork lit sys.argv APRÈS '--'.
        _log("blender: retry avec séparateur '--'")
        cmd_sep = [
            f"{BLENDER_DIR}/blender", "-b", "-P", script,
            "--", mesh_glb, "glb", out_dir,
        ]
        rc = _run(cmd_sep, cwd=tools_dir, label="blender(--)")
    return rc


def _safe_listdir(p):
    try:
        return os.listdir(p)
    except Exception:
        return []


def _results_dir(exp_root: str, exp_name: str, weight: str):
    """Répertoire des labels par-face : exp/sampart3d/{name}/results/{weight}/,
    avec fallback récursif si l'arborescence diffère."""
    d = os.path.join(exp_root, "sampart3d", exp_name, "results", str(weight))
    if os.path.isdir(d):
        return d
    for root, _dirs, _files in os.walk(exp_root):
        if os.path.basename(root) == str(weight) and "results" in root:
            return root
    return d


def _pick_nearest_labels(exp_root: str, exp_name: str, weight: str,
                         scale: float):
    """Choisit le mesh_{s}.npy dont l'échelle {s} est la PLUS PROCHE de
    `scale`. Le formatage du float dans le nom pouvant varier (0.0 / 0 /
    0.00), on parse l'échelle depuis chaque nom `mesh_<s>.npy`. Renvoie
    (chemin, echelle_reelle) ou (None, None)."""
    results_dir = _results_dir(exp_root, exp_name, weight)
    found = []  # (echelle, chemin)
    for fn in _safe_listdir(results_dir):
        if fn.startswith("mesh_") and fn.endswith(".npy"):
            token = fn[len("mesh_"):-len(".npy")]
            try:
                found.append((float(token), os.path.join(results_dir, fn)))
            except ValueError:
                found.append((None, os.path.join(results_dir, fn)))
    if not found:
        return None, None
    parsable = [(s, p) for s, p in found if s is not None]
    if parsable:
        s, p = min(parsable, key=lambda sp: abs(sp[0] - scale))
        return p, s
    # aucun nom parsable → prend le premier
    return found[0][1], None


# Palette de couleurs distinctes (RGB 0-255) — une par partie. Cyclée si le
# nombre de parties dépasse la taille (rare : au-delà de ~16 parties la
# distinction visuelle sature de toute façon).
_PART_PALETTE = [
    (228, 26, 28), (55, 126, 184), (77, 175, 74), (152, 78, 163),
    (255, 127, 0), (255, 214, 0), (166, 86, 40), (247, 129, 191),
    (0, 206, 209), (128, 0, 128), (0, 128, 128), (190, 190, 60),
    (0, 90, 181), (220, 90, 90), (120, 200, 120), (150, 150, 150),
]


def _build_segmented_glb(src_mesh, labels, out_path: str) -> int:
    """Construit un GLB où CHAQUE partie (label distinct) devient un sous-mesh
    NOMMÉ `part_00`, `part_01`, … avec une COULEUR PLEINE distincte (couleurs
    de faces → COLOR_0 ; aucune texture). C'est le rendu « carte des parties »
    clair et séparable que les 2 viewers three.js (desktop + cloud) affichent
    nativement — GLTFLoader auto-active les vertex-colors, et sans texture il
    n'y a pas de multiplication « boueuse ». Chaque partie garde le winding
    d'origine (les viewers forcent FrontSide). Renvoie le nombre de parties."""
    import numpy as np
    import trimesh

    faces = np.asarray(src_mesh.faces)
    n_faces = len(faces)
    labels = np.asarray(labels).reshape(-1).astype(np.int64)
    # Aligne défensivement la longueur des labels sur le nombre de faces.
    if labels.shape[0] != n_faces:
        if labels.shape[0] > n_faces:
            labels = labels[:n_faces]
        else:
            pad = labels[-1] if labels.size else 0
            labels = np.pad(labels, (0, n_faces - labels.shape[0]),
                            constant_values=pad)

    scene = trimesh.Scene()
    uniq = sorted(set(int(x) for x in labels.tolist()))
    n_parts = 0
    for i, lab in enumerate(uniq):
        face_idx = np.where(labels == lab)[0]
        if face_idx.size == 0:
            continue
        # submesh([indices], append=True) → un Trimesh des faces de la partie.
        part = src_mesh.submesh([face_idx], append=True)
        if part is None or len(part.faces) == 0:
            continue
        color = _PART_PALETTE[i % len(_PART_PALETTE)]
        rgba = np.array([color[0], color[1], color[2], 255], dtype=np.uint8)
        # Couleur pleine par face → COLOR_0 à l'export (pas de texture).
        part.visual = trimesh.visual.ColorVisuals(
            mesh=part, face_colors=np.tile(rgba, (len(part.faces), 1)))
        name = f"part_{n_parts:02d}"
        scene.add_geometry(part, geom_name=name, node_name=name)
        n_parts += 1

    if n_parts == 0:
        # Aucun découpage : exporte le mesh source tel quel (une seule partie).
        src_mesh.export(out_path)
        return 1
    scene.export(out_path)
    return n_parts


# ---------------------------------------------------------------------------
# Fonction GPU — segmente `glb_bytes` et renvoie un GLB SEGMENTÉ (sous-meshes
# nommés + couleurs par partie) pour la granularité demandée. Persiste sur le
# Volume si job_id fourni. Mirroir du contrat rig_mesh (GLB in → GLB out).
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
    scale: float = 1.0,
    job_id: str | None = None,
) -> bytes:
    """Segmente le GLB en parties → renvoie les bytes d'un GLB SEGMENTÉ.

    `scale` = granularité SAMPart3D (0.0 = fin/beaucoup de parties → 2.0 =
    grossier/peu de parties). L'optim MLP est entraînée UNE fois puis eval
    produit toutes les échelles ; on construit le GLB de l'échelle la plus
    proche de `scale`. Le GLB contient un sous-mesh nommé par partie, chacun
    d'une couleur pleine distincte → chargé directement comme nouvelle version
    de mesh par les viewers (aucun parsing côté client).

    Sur `job_id`, écrit /seg_data/<job_id>.glb (succès) ou <job_id>.err
    (échec JSON) pour que segment_status/segment_fetch servent le résultat.
    """
    t_total = time.time()
    try:
        scale = float(scale)
    except (TypeError, ValueError):
        scale = 1.0
    tmp_dir = tempfile.mkdtemp(prefix="sampart3d_")
    try:
        try:
            out_bytes = _run_segment_pipeline(
                glb_bytes, tmp_dir, scale, t_total)
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
                with open(f"/seg_data/{job_id}.glb", "wb") as f:
                    f.write(out_bytes)
                seg_output_volume.commit()
                _log(f"wrote /seg_data/{job_id}.glb ({len(out_bytes)} bytes)")
            except Exception as e:
                _log(f"WARN volume write failed for {job_id}: {e}")
        return out_bytes
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def _run_segment_pipeline(glb_bytes: bytes, tmp_dir: str, scale: float,
                          t_total: float) -> bytes:
    """Corps du pipeline (extrait pour l'enrobage async). Renvoie les bytes
    d'un GLB SEGMENTÉ pour la granularité `scale`."""
    import numpy as np
    import trimesh

    # oid UNIQUE par appel : le dossier de sortie exp/ est RELATIF au cwd
    # (=/SAMPart3D) et partagé si Modal réutilise un container chaud → un
    # nom unique évite toute collision avec un run précédent.
    oid = "fabmesh_" + uuid.uuid4().hex[:8]
    # ── Layout de données attendu par les scripts upstream ──
    mesh_root = os.path.join(tmp_dir, "mesh")            # {mesh_root}/{oid}.glb
    render_root = os.path.join(tmp_dir, "render")        # rendus 16 vues → {oid}/
    # SORTIE eval : train.sh/eval.sh écrivent dans exp/{dataset}/{name}/…
    # RELATIF au cwd (=/SAMPart3D) — on ne choisit PAS ce chemin, on le LIT.
    exp_root = os.path.join(SAMPART3D_DIR, "exp")
    for d in (mesh_root, render_root):
        os.makedirs(d, exist_ok=True)
    # Nettoie une éventuelle sortie d'un run homonyme (container réutilisé).
    shutil.rmtree(os.path.join(exp_root, "sampart3d", oid), ignore_errors=True)
    mesh_glb = os.path.join(mesh_root, f"{oid}.glb")
    with open(mesh_glb, "wb") as f:
        f.write(glb_bytes)

    # Nb de faces du mesh d'entrée (pour valider la longueur des labels).
    src_mesh = trimesh.load(mesh_glb, force="mesh")
    n_faces = int(len(src_mesh.faces))
    _log(f"mesh chargé: {n_faces} faces, {len(src_mesh.vertices)} vertices")

    # ── Étape 0 : patch config (chemins → nos dirs) ──
    _patch_config(mesh_root, render_root)

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

    # ── Étape 4 : labels par-face de l'échelle la plus proche → GLB segmenté ──
    _log(f"== Étape 4 : labels (scale≈{scale}) + construction GLB segmenté ==")
    npy, actual_scale = _pick_nearest_labels(exp_root, oid, weight, scale)
    if npy is None:
        raise RuntimeError(
            "aucun fichier de labels produit par eval — "
            "vérifier le chemin results/{weight}/mesh_{scale}.npy")
    labels = np.load(npy).astype(np.int64).reshape(-1)
    n_parts_raw = int(labels.max()) + 1 if labels.size else 0
    _log(f"labels: {os.path.basename(npy)} (scale réel={actual_scale}), "
         f"{n_parts_raw} parties brutes, {labels.shape[0]} labels / "
         f"{n_faces} faces")

    out_glb = os.path.join(tmp_dir, "segmented.glb")
    n_parts = _build_segmented_glb(src_mesh, labels, out_glb)
    with open(out_glb, "rb") as f:
        out_bytes = f.read()
    _log(f"TOTAL dt={time.time()-t_total:.1f}s  glb={len(out_bytes)} bytes  "
         f"parties={n_parts}  scale={actual_scale}")
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
        Body: {"_auth","mesh_url", "scale"?:float, "job_id"?}
              scale = granularité (0.0 fin → 2.0 grossier), défaut 1.0.
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
        try:
            scale = float(payload.get("scale", 1.0))
        except (TypeError, ValueError):
            scale = 1.0
        scale = max(0.0, min(2.0, scale))   # borne au domaine SAMPart3D

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
        call = segment_mesh.spawn(in_bytes, scale=scale, job_id=job_id)
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
        out_path = f"/seg_data/{job_id}.glb"
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
        """Stream le GLB segmenté pour job_id. 404 si pas prêt, 410 si .err."""
        payload = await _read_json(request)
        _check_auth(payload)
        job_id = (payload.get("job_id") or "").strip()
        if not job_id:
            raise HTTPException(status_code=400, detail="job_id required")
        if ("/" in job_id or ".." in job_id
                or not all(c in "0123456789abcdef" for c in job_id.lower())):
            raise HTTPException(status_code=400, detail="job_id must be hex")
        seg_output_volume.reload()
        out_path = f"/seg_data/{job_id}.glb"
        err_path = f"/seg_data/{job_id}.err"
        if os.path.isfile(err_path):
            raise HTTPException(status_code=410, detail="segment failed")
        if not os.path.isfile(out_path):
            raise HTTPException(status_code=404, detail="segment not ready")
        return FileResponse(
            out_path,
            media_type="model/gltf-binary",
            filename=f"{job_id}.glb",
        )

    return api
