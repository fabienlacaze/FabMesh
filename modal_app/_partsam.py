"""PartSAM — segmentation d'un mesh en PARTIES (cloud / Modal, feedforward).

Miroir cloud de `scripts/partsam_bridge.py` (desktop, RTX 5080 / sm_120).
Reçoit les bytes d'un GLB, découpe le mesh en parties avec **PartSAM**
(natif-3D, promptable, feedforward ~40-90 s/mesh, licence MIT) et renvoie
**un GLB SEGMENTÉ** : chaque partie est un sous-mesh NOMMÉ (`part_00`,
`part_01`, …) d'une couleur pleine distincte. Contrat identique à la voie
SAMPart3D et à l'auto-rig (GLB in → GLB out) : le worker le stocke en R2, le
viewer le charge comme nouvelle version de mesh (aucun parsing côté client).

────────────────────────────────────────────────────────────────────────
POURQUOI c'est SÉPARÉ de `_sampart3d.py` (app + image distinctes) :
PartSAM est **feedforward** — PAS d'optim par-mesh (SAMPart3D entraîne un
petit MLP 5000 iters ~5 min PAR mesh). PartSAM échantillonne 512 points FPS,
prédit des masques de parties en un seul passage, filtre par IoU + NMS, puis
vote par-face. Coût GPU : ~40-90 s/mesh. Stack incompatible avec SAMPart3D
(pas de Blender, pas de PTv3/spconv, pas de tiny-cuda-nn) → image dédiée.

On garde le MÊME contrat async que _sampart3d / _puppeteer_rig :
  segment-start (.spawn) → segment-status (poll) → segment-fetch (stream).
timeout GPU 900 s (large ; le feedforward est court, la marge couvre le
cold-start + le 1er chargement des 900 Mo de poids).

Étapes internes (pilotées comme partsam_bridge, cwd=/PartSAM) :
  1. Copie du mesh dans un dossier d'entrée isolé (ValDataset le walk).
  2. `python evaluation/eval_everypart.py dataset.root_dir=<dir>
       eval_params.use_graph_cut=False eval_params.batch_size=4
       eval_params.iou_threshold=X eval_params.nms_threshold=Y`
     → labels par-face `results/{id}_labels.npy` (patch FabMesh).
  3. Relecture des labels → débruitage « v7_watershed » (mode kNN cutoff
     3·h + island absorption + watershed crease-aware sur normales robustes,
     mirroir EXACT de partsam_bridge ; mesuré sur tank 488k tris : faces
     parasites 12.83 % → 1.23 %, frontière-sur-pli robuste 0.327 → 0.458) →
     reconstruction du GLB en sous-meshes part_XX.

Granularité (contrat partsam_bridge, mirroir EXACT) :
  `granularity` 0.0 (grossier, ~10 parties propres) → 1.0 (fin, ~45 parties).
  Mappée sur (iou, nms) : iou = 0.65 − 0.15·g (bas = plus de masques),
  nms = 0.30 + 0.35·g (haut = moins de suppression).

────────────────────────────────────────────────────────────────────────
IMAGE (dictée par AGENT_LOG « PIVOT #2 : PartSAM » 2026-07-08) :
- CUDA 12.8 devel (nvcc requis pour compiler torkit3d + pointops), Python
  3.11, torch 2.7.0+cu128 — l'env local validé sm_120. Sur Modal on vise
  A100 (sm_80) / H100 (sm_90) : cu128 émet ces archs sans souci.
- **apex CONTOURNÉ** : PartSAM ne s'en sert que pour `FusedLayerNorm`.
  Sur la clone fraîche on patche `PartSAM/utils/torch_utils.py` (import apex
  → try/except → no-op : garde les `nn.LayerNorm` standard, comportement
  local validé) + `PartSAM/model/build.py` (dead code, patch défensif). Le
  patch est appliqué au build (script embarqué, heredoc).
- **torkit3d** + **pointops** = extensions CUDA compilées ici (FORCE_CUDA +
  TORCH_CUDA_ARCH_LIST). PartField backbone = PVCNN pur-torch (PAS de
  spconv/natten).
- deps pip : hydra-core omegaconf loguru igraph open3d boto3 h5py
  scikit-image simple_parsing arrgh safetensors timm einops trimesh +
  torch_scatter (wheel pt27cu128) + (matplotlib scipy psutil networkx
  accelerate tqdm : imports vérifiés du pipeline). PAS lightning /
  polyscope / potpourri3d / libigl.
- poids : HF `Czvvd/PartSAM` → `/PartSAM/pretrained/model.safetensors`
  (~900 Mo, bakés dans l'image, guard de build).
- inférence : batch_size=4 (borne OOM cdist mask_decoder validée en 16 Go ;
  conservateur mais sûr sur A100), use_graph_cut=False.

DEPLOY:
    modal secret create huggingface HF_TOKEN=<hf token>              # (si absent)
    modal secret create myfabmesh-shared SHARED_SECRET=<32-byte hex> # (idem)
    modal deploy modal_app/_partsam.py
Le worker pointe (nouvel) MODAL_PARTSAM_URL sur l'URL du router `segment_router`.

License: PartSAM = MIT (code + poids). torkit3d / pointops = MIT/Apache.
────────────────────────────────────────────────────────────────────────
"""
import json
import os
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
# Sources externes
# ---------------------------------------------------------------------------
PARTSAM_REPO = "https://github.com/czvvd/PartSAM.git"
PARTSAM_DIR = "/PartSAM"
# pointops : la même implémentation Pointcept que SAMPart3D (libs/pointops).
SAMPART3D_REPO = "https://github.com/Pointcept/SAMPart3D.git"
# torkit3d : FPS / chamfer / batch_index_select (extensions CUDA).
TORKIT3D_REPO = "https://github.com/Jiayuan-Gu/torkit3d.git"
# Poids PartSAM (MIT). README upstream : model.safetensors à la racine du repo HF.
PARTSAM_HF_REPO = "Czvvd/PartSAM"
PARTSAM_CKPT_FILE = "model.safetensors"
PARTSAM_CKPT = f"{PARTSAM_DIR}/pretrained/{PARTSAM_CKPT_FILE}"

# ---------------------------------------------------------------------------
# Script de patch appliqué à la clone fraîche (apex contourné + save labels).
# RAW string : les `\n` restent littéraux dans le fichier écrit puis sont
# interprétés par Python à l'exécution du patcher (heredoc quoté = verbatim).
# Idempotent (chaque patch a un marqueur ; skip si déjà présent).
# ---------------------------------------------------------------------------
_PATCH_SCRIPT = r'''
import os
import sys

repo = sys.argv[1]


def patch(path, old, new, marker):
    if not os.path.isfile(path):
        print("PATCH SKIP (missing):", path, flush=True)
        return
    with open(path, "r", encoding="utf-8") as f:
        src = f.read()
    if marker in src:
        print("PATCH SKIP (already):", path, flush=True)
        return
    if old not in src:
        print("PATCH WARN (anchor not found):", path, flush=True)
        return
    src = src.replace(old, new, 1)
    with open(path, "w", encoding="utf-8") as f:
        f.write(src)
    print("PATCHED:", path, flush=True)


# 1) torch_utils.py (IMPORTÉ par eval_everypart) : import apex -> try/except
#    return. Reproduit le comportement local validé (apex indispo -> on garde
#    les nn.LayerNorm standard, aucun remplacement).
patch(
    os.path.join(repo, "PartSAM", "utils", "torch_utils.py"),
    "    from apex.normalization import FusedLayerNorm\n",
    "    try:\n"
    "        from apex.normalization import FusedLayerNorm\n"
    "    except Exception:\n"
    "        return\n",
    "    except Exception:\n        return",
)

# 2) build.py : dead code sur le chemin d'inference (model/__init__.py vide,
#    pc_sam n'importe pas build). Patch defensif de l'import apex top-level.
patch(
    os.path.join(repo, "PartSAM", "model", "build.py"),
    "from apex.normalization import FusedLayerNorm\n",
    "try:\n"
    "    from apex.normalization import FusedLayerNorm\n"
    "except Exception:\n"
    "    from torch.nn import LayerNorm as FusedLayerNorm\n",
    "from torch.nn import LayerNorm as FusedLayerNorm",
)

# 3) eval_everypart.py : sauve les labels par-face (pre-post-processing) pour
#    reconstruire un GLB en sous-meshes part_XX (meme patch que la voie locale).
patch(
    os.path.join(repo, "evaluation", "eval_everypart.py"),
    '        mesh_save_path = os.path.join(f"results", f"{id}.ply")',
    '        np.save(os.path.join("results", f"{id}_labels.npy"), '
    'np.asarray(mesh_group))\n'
    '        mesh_save_path = os.path.join(f"results", f"{id}.ply")',
    "_labels.npy",
)
'''

# ---------------------------------------------------------------------------
# Image
# ---------------------------------------------------------------------------
image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.8.1-devel-ubuntu22.04",
        add_python="3.11",
    )
    .env({"CUDA_HOME": "/usr/local/cuda"})
    .apt_install(
        "git", "build-essential", "ninja-build", "cmake",
        "wget", "ca-certificates",
        # libs GL/X11 partagées par trimesh / open3d / scikit-image.
        "libgl1", "libegl1", "libglib2.0-0", "libgomp1",
        "libsm6", "libxext6", "libxrender1", "libx11-6", "libxi6",
    )
    # ---- PyTorch 2.7.0 + cu128 (env local validé sm_120 ; A100/H100 OK) ----
    .pip_install(
        "torch==2.7.0",
        "torchvision==0.22.0",
        extra_options="--index-url https://download.pytorch.org/whl/cu128",
    )
    # ---- Build deps pour les compiles CUDA (torkit3d / pointops) ----
    .pip_install("packaging", "setuptools", "wheel", "ninja")
    .env({
        "CC": "gcc", "CXX": "g++",
        "CUDA_HOME": "/usr/local/cuda",
        # A100 (8.0) + L40S (8.9) + H100 (9.0) + PTX pour le reste.
        "TORCH_CUDA_ARCH_LIST": "8.0;8.9;9.0+PTX",
        "FORCE_CUDA": "1",
        "HF_HOME": "/root/.cache/huggingface",
    })
    # ---- torch-scatter apparié torch 2.7.0+cu128 (index PyG, pas PyPI) ----
    .pip_install(
        "torch-scatter==2.1.2",
        extra_options="-f https://data.pyg.org/whl/torch-2.7.0+cu128.html",
    )
    # ---- deps d'inference (liste AGENT_LOG PIVOT #2 + imports vérifiés) ----
    .pip_install(
        "hydra-core", "omegaconf", "loguru", "igraph", "open3d",
        "boto3", "h5py", "scikit-image", "simple_parsing", "arrgh",
        "safetensors", "timm", "einops", "trimesh",
        # imports vérifiés du pipeline non listés explicitement en PIVOT #2 :
        "matplotlib", "scipy", "psutil", "networkx",
        "accelerate>=0.30", "tqdm", "huggingface_hub>=0.34",
        "numpy<2",
        # FastAPI — requis par @modal.asgi_app.
        "fastapi[standard]>=0.115",
    )
    # ---- torkit3d (FPS / chamfer / batch_index_select) : compile CUDA ----
    .run_commands(
        f"git clone --depth 1 {TORKIT3D_REPO} /tmp/torkit3d",
        "cd /tmp/torkit3d && FORCE_CUDA=1 pip install --no-build-isolation .",
        "python -c \"import torkit3d, torkit3d._C; print('torkit3d ok')\"",
    )
    # ---- pointops (FPS / knn_query au vote par-face) : compile CUDA ----
    .run_commands(
        f"git clone --depth 1 {SAMPART3D_REPO} /tmp/sampart3d",
        "cd /tmp/sampart3d/libs/pointops && FORCE_CUDA=1 python setup.py install",
        "python -c \"import pointops; print('pointops ok')\"",
        "rm -rf /tmp/sampart3d /tmp/torkit3d",
    )
    # ---- Clone PartSAM + patches (apex contourné + save labels) ----
    .run_commands(
        f"git clone --depth 1 {PARTSAM_REPO} {PARTSAM_DIR}",
        # Écrit le patcher (heredoc quoté = verbatim), puis l'exécute.
        "cat > /tmp/_patch_partsam.py <<'PARTSAM_PATCH_EOF'\n"
        + _PATCH_SCRIPT
        + "\nPARTSAM_PATCH_EOF",
        f"python /tmp/_patch_partsam.py {PARTSAM_DIR}",
        # Répertoires attendus par eval (RELATIFS au cwd=/PartSAM).
        f"mkdir -p {PARTSAM_DIR}/results {PARTSAM_DIR}/_fabmesh_in "
        f"{PARTSAM_DIR}/pretrained",
        # Guard : le patch labels DOIT avoir pris (sinon pas de _labels.npy).
        "python -c \"import io; "
        f"src=open('{PARTSAM_DIR}/evaluation/eval_everypart.py',encoding='utf-8').read(); "
        "assert '_labels.npy' in src, 'eval_everypart labels patch missing'; "
        "print('eval patch ok')\"",
    )
    # ---- Poids PartSAM (MIT) bakés dans l'image ----
    .run_commands(
        "python -c \""
        "from huggingface_hub import hf_hub_download; "
        "import os; tok = os.environ.get('HF_TOKEN'); "
        f"hf_hub_download(repo_id='{PARTSAM_HF_REPO}', "
        f"filename='{PARTSAM_CKPT_FILE}', "
        f"local_dir='{PARTSAM_DIR}/pretrained', token=tok); "
        "print('model.safetensors downloaded')\"",
        # Guard de build : échoue si le poids manque / est vide.
        "python -c \"import os; "
        f"p='{PARTSAM_CKPT}'; "
        "assert os.path.isfile(p) and os.path.getsize(p) > 1024*1024, "
        "f'partsam ckpt missing/empty: {p}'; print('ckpt guard ok')\"",
        secrets=[
            modal.Secret.from_name("huggingface", required_keys=["HF_TOKEN"]),
        ],
    )
)

app = modal.App("myfabmesh-partsam", image=image)

# Volume pour persister les sorties async (GLB segmenté), même pattern que
# _sampart3d / _puppeteer_rig : segment-start spawn → segment-status poll →
# segment-fetch stream. /seg_data/<job_id>.glb (succès) ou <job_id>.err.
seg_output_volume = modal.Volume.from_name(
    "myfabmesh-partsam-output", create_if_missing=True,
)


def _log(msg: str) -> None:
    print(f"[partsam] {msg}", flush=True)


def _stream(proc: subprocess.Popen) -> int:
    """Relaie stdout ligne-à-ligne vers les logs Modal (progression eval)."""
    if proc.stdout is None:
        return proc.wait()
    for line in proc.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
    return proc.wait()


def _run(cmd, cwd, env=None, label=""):
    _log(f"{label}: {' '.join(str(c) for c in cmd)}  (cwd={cwd})")
    proc = subprocess.Popen(
        cmd, cwd=cwd, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1, encoding="utf-8", errors="replace",
    )
    rc = _stream(proc)
    _log(f"{label}: rc={rc}")
    return rc


def _granularity_to_thresholds(g):
    """g 0.0 (grossier) → 1.0 (fin). Interpole iou (0.65→0.55) et nms
    (0.3→0.55) — mapping TEMPÉRÉ (l'ancien plafond 0.5/0.65 donnait 51 labels
    mosaïque à g=1.0). Mirroir EXACT de
    scripts/partsam_bridge.py._granularity_to_thresholds."""
    try:
        g = float(g)
    except (TypeError, ValueError):
        g = 0.0
    g = max(0.0, min(1.0, g))
    iou = 0.65 - 0.10 * g
    nms = 0.30 + 0.25 * g
    return round(iou, 3), round(nms, 3)


# Palette de couleurs distinctes (RGB 0-255) — une par partie. Cyclée si le
# nombre de parties dépasse la taille (identique aux 2 autres voies : la
# palette DOIT rester la même pour un rendu cohérent desktop/cloud/SAMPart3D).
_PART_PALETTE = [
    (228, 26, 28), (55, 126, 184), (77, 175, 74), (152, 78, 163),
    (255, 127, 0), (255, 214, 0), (166, 86, 40), (247, 129, 191),
    (0, 206, 209), (128, 0, 128), (0, 128, 128), (190, 190, 60),
    (0, 90, 181), (220, 90, 90), (120, 200, 120), (150, 150, 150),
]


def _knn_mode_vote(lab, n_lab, dist, idx, r_cut, sub_k=None, only_faces=None):
    """Une passe de FILTRE MAJORITAIRE kNN vectorisé (bincount, ~5-10x plus
    rapide que scipy.stats.mode) avec CUTOFF de distance : un voisin à
    dist > r_cut est exclu du vote — stoppe le bleeding à travers les gaps
    d'air d'un mesh non soudé (coques internes, chenille↔caisse). `lab` doit
    être compact 0..n_lab-1. `sub_k` limite aux sub_k premiers voisins ;
    `only_faces` (masque bool) restreint la mise à jour à ces faces.
    Mirroir EXACT de scripts/partsam_bridge.py._knn_mode_vote."""
    import numpy as np
    N = lab.shape[0]
    d = dist if sub_k is None else dist[:, :sub_k]
    ix = idx if sub_k is None else idx[:, :sub_k]
    if N * n_lab > 400_000_000:      # garde-fou mémoire (800+ labels: improbable)
        return lab, False
    valid = d <= r_cut
    valid[:, 0] = True               # self (dist 0) vote toujours
    rows = np.broadcast_to(np.arange(N, dtype=np.int64)[:, None], ix.shape)
    flat = rows[valid] * np.int64(n_lab) + lab[ix][valid].astype(np.int64)
    votes = np.bincount(flat, minlength=N * n_lab).reshape(N, n_lab)
    out = votes.argmax(axis=1).astype(np.int64)
    if only_faces is not None:
        res = lab.copy()
        res[only_faces] = out[only_faces]
        return res, True
    return out, True


def _absorb_islands(mesh, labels, k=12, r_mult=3.0,
                    keep_frac=0.002, keep_abs=1500,
                    min_label_keep=32, max_iters=8, _pre=None):
    """ISLAND ABSORPTION — absorbe les FRAGMENTS PARASITES (petites composantes
    connexes spatiales d'un label qui existe en grand ailleurs) dans le label
    majoritaire de leurs voisins spatiaux externes.

    Ce que le mode kNN ne peut pas faire : un îlot compact de 50-500 faces a
    un intérieur dont les k voisins sont tous DANS l'îlot → point fixe du
    filtre majoritaire. Ici on raisonne PAR COMPOSANTE (kNN ∩ rayon 3·h sur
    les centroïdes, robuste au mesh non soudé) et on réassigne la composante
    ENTIÈRE. Anti-antenne : la composante DOMINANTE d'un label n'est JAMAIS
    absorbée, sauf label entier < min_label_keep faces (poussière).
    `_pre` = (cent, area, h, dist, idx) précalculés (query cKDTree partagé).
    No-op si scipy absent ou en cas d'erreur.
    Mirroir EXACT de scripts/partsam_bridge.py._absorb_islands."""
    try:
        import numpy as np
        from scipy.sparse import coo_matrix
        from scipy.sparse.csgraph import connected_components
        from scipy.spatial import cKDTree
    except Exception:
        return labels
    try:
        t0 = time.time()
        labels = np.asarray(labels).reshape(-1).astype(np.int64)
        faces = getattr(mesh, "faces", None)
        if faces is None or len(labels) != len(faces) or len(labels) < 100:
            return labels
        N = len(labels)
        # remap labels -> 0..L-1 (compacité des matrices de vote)
        uniq, labels = np.unique(labels, return_inverse=True)
        labels = labels.astype(np.int64)
        n_lab = len(uniq)
        if _pre is not None:
            cent, area, h, dist, idx = _pre
            kq = idx.shape[1]
        else:
            cent = np.asarray(mesh.triangles_center, dtype=np.float64)
            area = np.asarray(mesh.area_faces, dtype=np.float64)
            h = float(np.median(np.sqrt(np.maximum(area, 1e-30))))
            kq = min(k, N)
            dist, idx = cKDTree(cent).query(cent, k=kq, workers=-1)
        r_max = r_mult * h
        size_thr = int(min(keep_abs, keep_frac * N))
        if size_thr < 2:
            return uniq[labels]
        src_all = np.repeat(np.arange(N), kq - 1)
        dst_all = idx[:, 1:].ravel()
        near = dist[:, 1:].ravel() <= r_max
        frozen = np.zeros(N, bool)  # faces réassignées par fallback = gelées

        def _components():
            ok = near & (labels[src_all] == labels[dst_all])
            adj = coo_matrix(
                (np.ones(int(ok.sum()), np.int8), (src_all[ok], dst_all[ok])),
                shape=(N, N))
            n_comp, comp = connected_components(adj, directed=False)
            comp_size = np.bincount(comp, minlength=n_comp)
            comp_label = np.zeros(n_comp, dtype=np.int64)
            comp_label[comp] = labels
            label_total = np.bincount(labels, minlength=n_lab)
            # comp DOMINANTE de chaque label = protégée (antennes).
            # tri stable -> déterministe en cas d'égalité de tailles.
            order = np.argsort(-comp_size, kind="stable")
            is_dom = np.zeros(n_comp, bool)
            seen = np.zeros(n_lab, bool)
            for c in order:
                l = comp_label[c]
                if not seen[l]:
                    seen[l] = True
                    is_dom[c] = True
            has_free = np.zeros(n_comp, bool)
            np.logical_or.at(has_free, comp, ~frozen)
            absorbable = (comp_size < size_thr) & has_free & (
                ~is_dom | (label_total[comp_label] < min_label_keep))
            return n_comp, comp, absorbable

        def _vote_pass(n_comp, comp, absorbable):
            """Réassigne chaque comp absorbable au label majoritaire (pondéré
            aire) de ses voisins spatiaux EXTERNES non-absorbables."""
            para_face = absorbable[comp]
            vsrc, vdst = src_all[near], dst_all[near]
            vote_ok = para_face[vsrc] & ~para_face[vdst]
            vsrc, vdst = vsrc[vote_ok], vdst[vote_ok]
            votes = np.zeros((n_comp, n_lab), dtype=np.float64)
            np.add.at(votes, (comp[vsrc], labels[vdst]), area[vdst])
            change = absorbable & (votes.sum(axis=1) > 0)
            if not change.any():
                return 0, 0
            new_lab = votes.argmax(axis=1)
            upd = change[comp]
            labels[upd] = new_lab[comp[upd]]
            return int(change.sum()), int(upd.sum())

        n_absorbed = 0
        # Phase 1 — vote majoritaire des voisins externes, jusqu'à stabilité
        for it in range(max_iters):
            n_comp, comp, absorbable = _components()
            if not absorbable.any():
                break
            nc, nf = _vote_pass(n_comp, comp, absorbable)
            if nc == 0:
                break
            n_absorbed += nc
        # Phase 2 — fallback UNE FOIS : floaters sans voisin externe < r_max
        # -> plus proche face conservée, puis GEL (anti boucle infinie)
        n_comp, comp, absorbable = _components()
        if absorbable.any():
            para_face = absorbable[comp]
            keep_idx = np.where(~para_face)[0]
            pf = np.where(para_face)[0]
            if keep_idx.size and pf.size:
                _, nn = cKDTree(cent[keep_idx]).query(cent[pf], k=1, workers=-1)
                labels[pf] = labels[keep_idx[nn]]
                frozen[pf] = True
                _log(f"absorb: fallback {pf.size} faces isolées -> "
                     "plus proche partie")
                # Phase 3 — le fallback peut débloquer des voisins (<=2 passes)
                for it in range(2):
                    n_comp, comp, absorbable = _components()
                    if not absorbable.any():
                        break
                    nc, nf = _vote_pass(n_comp, comp, absorbable)
                    if nc == 0:
                        break
                    n_absorbed += nc
        out = uniq[labels]
        n1 = len(np.unique(out))
        _log(f"absorb: {n_absorbed} îlots absorbés (size_thr={size_thr}, "
             f"r_max={r_max:.5f}) labels {n_lab}->{n1} "
             f"en {time.time() - t0:.1f}s")
        return out
    except Exception as e:
        _log(f"absorb indispo ({e}) — labels du denoise gardés")
        return labels


def _absorb_scattered(labels, cent, dist, idx, r_max,
                      dom_thr=0.45, dust=120):
    """Absorbe les LABELS ÉPARPILLÉS entiers (mouchetis multi-fragments dont
    la composante dominante < dom_thr des faces, ou poussière < dust faces).
    Mirroir EXACT de scripts/partsam_bridge.py._absorb_scattered."""
    try:
        import numpy as np
        from scipy.sparse import coo_matrix
        from scipy.sparse.csgraph import connected_components
        from scipy.spatial import cKDTree
    except Exception:
        return labels
    try:
        labels = np.asarray(labels).reshape(-1).astype(np.int64)
        uniq, lab = np.unique(labels, return_inverse=True)
        lab = lab.astype(np.int64)
        n_lab = len(uniq)
        N = len(lab)
        if n_lab < 2 or N < 100:
            return labels
        kq = idx.shape[1]
        src = np.repeat(np.arange(N), kq - 1)
        dst = idx[:, 1:].ravel()
        near = dist[:, 1:].ravel() <= r_max
        ok = near & (lab[src] == lab[dst])
        adj = coo_matrix(
            (np.ones(int(ok.sum()), np.int8), (src[ok], dst[ok])),
            shape=(N, N))
        n_comp, comp = connected_components(adj, directed=False)
        comp_size = np.bincount(comp, minlength=n_comp)
        comp_label = np.zeros(n_comp, np.int64)
        comp_label[comp] = lab
        label_total = np.bincount(lab, minlength=n_lab)
        dom = np.zeros(n_lab)
        np.maximum.at(dom, comp_label, comp_size.astype(np.float64))
        dominance = dom / np.maximum(label_total, 1)
        scattered = (dominance < dom_thr) | (label_total < dust)
        if not scattered.any() or scattered.all():
            return labels
        kill = scattered[lab]
        keep_idx = np.where(~kill)[0]
        kf = np.where(kill)[0]
        _, nn = cKDTree(cent[keep_idx]).query(cent[kf], k=1, workers=-1)
        lab[kf] = lab[keep_idx[nn]]
        out = uniq[lab]
        _log(f"scatter: {int(scattered.sum())} labels éparpillés/poussière "
             f"absorbés (dominance<{dom_thr} ou <{dust} faces) "
             f"{n_lab}->{len(np.unique(out))}")
        return out
    except Exception as e:
        _log(f"scatter indispo ({e}) — labels gardés")
        return labels


def _crease_snap(lab, n_lab, fn, cent, area, dist, idx, r_max,
                 sigma_deg=30.0, rings=2, iters=8, self_w=0.5):
    """SNAP CREASE-AWARE — migre les frontières de coupe vers les PLIS
    géométriques (angle dièdre fort entre normales de faces) au lieu de les
    laisser serpenter en Voronoï du nuage de points PartSAM sur les surfaces
    plates. Relaxation itérée SYNCHRONE restreinte à une BANDE autour des
    frontières : chaque face de la bande reprend le label majoritaire de ses
    voisins spatiaux avec un poids w_ij = exp(-(θ_ij/σ)²)·aire_j (θ_ij =
    angle entre normales BRUTES, dot orienté — fiable par-face même sur un
    mesh non soudé) : continuité forte sur du plat, coupe quasi gratuite au
    pli. Les faces HORS bande sont des ANCRES (votent, ne bougent jamais —
    pas de dérive globale) ; un label entièrement contenu dans la bande est
    GELÉ (retiré de la bande) → garantit 0 label perdu. `lab` = labels
    compacts int64 0..n_lab-1 (modifié en place) ; dist/idx = query cKDTree
    k=12 partagé du pipeline. Retourne (lab, ok).
    Mesuré (tank 488k faces, g=0.2) : ~0.2 s, frontière-sur-pli (normales
    brutes) 0.51→0.67, angle frontière moyen 33.8°→43.5°, parasites
    1.34→1.31 %, fragments et n_parts strictement stables. Le cap `iters`
    borne un cycle limite 2-périodique résiduel (~0.5 % de la bande) —
    le garder PAIR. Depuis v7 : REPLI de _crease_watershed (exception).
    Mirroir EXACT de scripts/partsam_bridge.py._crease_snap."""
    import numpy as np
    t0 = time.time()
    validk = dist <= r_max
    validk[:, 0] = True                                  # self vote toujours
    # --- 1) BANDE = faces à voisinage mixte + `rings` anneaux de dilatation
    mixed = ((lab[idx] != lab[:, None]) & validk).any(axis=1)
    band = mixed.copy()
    for _ in range(rings):
        band |= (band[idx] & validk).any(axis=1)         # dilatation kNN
    # --- 2) ANCRAGE : un label entièrement dans la bande serait perdable →
    #        on le GÈLE en retirant ses faces de la bande (0 label perdu)
    anch = np.bincount(lab[~band], minlength=n_lab)
    if (anch == 0).any():
        band[np.isin(lab, np.where(anch == 0)[0])] = False
    B = np.where(band)[0]
    if B.size == 0 or B.size * n_lab > 400_000_000:      # garde-fou mémoire
        return lab, False                                # (cf. _knn_mode_vote)
    # --- 3) POIDS FIXES (précalculés UNE fois, la bande est figée) ---
    nb = idx[B]                                          # (B, k)
    cosb = np.einsum('ij,ikj->ik', fn[B], fn[nb])        # dot BRUT, PAS |dot|
    theta = np.arccos(np.clip(cosb, -1.0, 1.0))
    w = np.exp(-(theta / np.radians(sigma_deg)) ** 2) * area[nb]
    w[~validk[B]] = 0.0                                  # cutoff gaps d'air
    w[:, 0] = self_w * area[B]                           # inertie (amortit
    rows = np.repeat(np.arange(B.size), nb.shape[1])     #  l'oscillation)
    before = lab[B].copy()
    # --- 4) RELAXATION ITÉRÉE synchrone — hors-bande = ancres qui votent
    #        mais ne bougent pas ---
    for it in range(iters):
        votes = np.zeros((B.size, n_lab))                # B×n_lab, jamais N×n_lab
        np.add.at(votes, (rows, lab[nb].ravel()), w.ravel())
        new = np.where(votes.max(axis=1) > 0, votes.argmax(axis=1), lab[B])
        ch = int((new != lab[B]).sum())
        lab[B] = new
        if ch == 0 or ch < max(1, B.size // 1000):       # convergence
            break
    _log(f"snap: {int((lab[B] != before).sum())} faces migrées vers les plis "
         f"(bande {B.size}, σ={sigma_deg:.0f}°, {it + 1} iters) "
         f"en {time.time() - t0:.2f}s")
    return lab, True


def _robust_normals(cent, area, fn_raw, dist, idx, r_max, tree,
                    pca_k=32, smooth_iters=2):
    """Normales ROBUSTES par face — indispensables sur la soupe TRELLIS2
    (les normales brutes sont du BRUIT : ~40k patchs non soudés, coques
    doublées, marches de voxel — 76 % des paires voisines > 25° sur le tank,
    aucun signal de pli exploitable). (1) plan PCA pondéré aire ajusté sur
    les `pca_k` voisins spatiaux de chaque face ; (2) `smooth_iters`
    itérations de lissage à signe aligné (le signe du vecteur propre PCA est
    arbitraire → alignement local par sign(n_i·n_j) avant moyenne) ;
    (3) RÉ-ORIENTATION en signe sur les normales brutes du mesh — permet un
    dot ORIENTÉ en aval (les paires de coques doublées lisent ~180°, pas 0°).
    ~2 s sur 488k faces (dominé par eigh batch). `tree` = cKDTree(cent)
    partagé du pipeline (le query k=pca_k est refait ici).
    Mirroir EXACT de scripts/partsam_bridge.py._robust_normals."""
    import numpy as np
    N = len(cent)
    kp = min(pca_k, N)
    dP, iP = tree.query(cent, k=kp, workers=-1)
    w = area[iP]                                   # (N, kp) poids aire
    P = cent[iP]                                   # (N, kp, 3)
    mu = (w[..., None] * P).sum(1) / w.sum(1, keepdims=True)
    D = P - mu[:, None, :]
    C = np.einsum("nk,nki,nkj->nij", w, D, D)
    nf = np.linalg.eigh(C)[1][:, :, 0]             # plus petit vecteur propre
    for _ in range(smooth_iters):
        nb = nf[idx]                               # (N, k, 3)
        sgn = np.sign(np.einsum("ni,nki->nk", nf, nb))
        sgn[sgn == 0] = 1.0
        wk = (dist <= r_max) * area[idx] * sgn
        m = np.einsum("nk,nki->ni", wk, nb)
        nn = np.linalg.norm(m, axis=1, keepdims=True)
        nn[nn < 1e-20] = 1.0
        nf = m / nn
    s = np.sign(np.einsum("ij,ij->i", nf, fn_raw))
    s[s == 0] = 1.0
    return nf * s[:, None]


def _crease_watershed(lab, n_lab, fn_rob, cent, area, dist, idx, r_max,
                      erosion_rings=3, n_levels=16, lo_deg=5.0, hi_deg=60.0):
    """WATERSHED CREASE-AWARE par immersion par niveaux (100 % vectorisé,
    déterministe) — remplace le snap v6 comme étape 3. Le snap (relaxation
    locale) reste dans un MINIMUM LOCAL à côté du vrai pli sur les grandes
    plaques ; ici on ÉRODE toute une bande autour des frontières (faces
    mixtes + `erosion_rings` anneaux kNN) puis on la re-fait pousser depuis
    les régions conservées par NIVEAUX d'angle croissants (5°→60°, `n_levels`
    seuils sur l'angle ORIENTÉ entre normales ROBUSTES des paires voisines) :
    les paires plates inondent d'abord, les fronts se rencontrent exactement
    sur les CRÊTES du champ de plis. Garanties : un label entièrement dans la
    bande est GELÉ (retiré, comme le snap v6) → 0 label perdu ; vote pondéré
    aire, argmax numpy (tie-break plus petit index, stable) ; reliquat non
    atteint → plus proche face étiquetée. `lab` = labels compacts int64
    0..n_lab-1 (copié, PAS modifié en place). Retourne (lab_out, ok).
    Mesuré (tank 488k faces) : frontière-sur-pli robuste 0.327→0.458 (g=0.2),
    0.357→0.518 (g=1.0), ~3-6 s (~320-360 itérations internes vectorisées).
    Mirroir EXACT de scripts/partsam_bridge.py._crease_watershed."""
    import numpy as np
    from scipy.spatial import cKDTree
    t0 = time.time()
    lab = lab.copy()
    N = lab.shape[0]
    validk = dist <= r_max
    validk[:, 0] = True
    # --- érosion : bande = faces mixtes + rings de dilatation kNN ---
    mixed = ((lab[idx] != lab[:, None]) & validk).any(axis=1)
    band = mixed.copy()
    for _ in range(erosion_rings):
        band |= (band[idx] & validk).any(axis=1)
    # --- gel : un label entièrement dans la bande serait perdu par
    #     l'érosion -> retiré de la bande (0 label perdu garanti) ---
    anch = np.bincount(lab[~band], minlength=n_lab)
    if (anch == 0).any():
        band[np.isin(lab, np.where(anch == 0)[0])] = False
    Bfaces = np.where(band)[0]
    B = Bfaces.size
    if B == 0 or B * n_lab > 400_000_000:            # garde-fou mémoire
        return lab, False
    bandpos = np.full(N, -1, dtype=np.int64)
    bandpos[Bfaces] = np.arange(B)
    seed = lab.copy()
    seed[Bfaces] = -1                                # bande érodée = non étiquetée
    # --- paires voisines uniques i<j (kNN cutoff), touchant la bande ---
    kq = idx.shape[1]
    srcf = np.repeat(np.arange(N, dtype=np.int64), kq - 1)
    dstf = idx[:, 1:].ravel().astype(np.int64)
    near = dist[:, 1:].ravel() <= r_max
    srcf, dstf = srcf[near], dstf[near]
    a = np.minimum(srcf, dstf)
    b = np.maximum(srcf, dstf)
    keys = np.unique(a * np.int64(N) + b)
    pa = (keys // N).astype(np.int64)
    pb = (keys % N).astype(np.int64)
    touch = band[pa] | band[pb]
    pa, pb = pa[touch], pb[touch]
    # --- niveaux : angle ORIENTÉ entre normales robustes ré-orientées ---
    cosr = np.einsum("ij,ij->i", fn_rob[pa], fn_rob[pb])
    theta = np.arccos(np.clip(cosr, -1.0, 1.0))
    edges = np.linspace(np.radians(lo_deg), np.radians(hi_deg), n_levels)
    lvl = np.digitize(theta, edges)                  # 0..n_levels
    wa = area[pa]
    wb = area[pb]
    # --- immersion par niveaux croissants ---
    n_assigned = 0
    act = np.arange(pa.size)                         # paires encore utiles
    for L in range(n_levels + 1):
        la = seed[pa[act]]
        lb = seed[pb[act]]
        act = act[(la == -1) | (lb == -1)]           # prune : tout étiqueté
        sub = act[lvl[act] <= L]
        while sub.size:
            spa = pa[sub]
            spb = pb[sub]
            la = seed[spa]
            lb = seed[spb]
            m1 = (la == -1) & (lb != -1)             # vote b -> a
            m2 = (lb == -1) & (la != -1)             # vote a -> b
            if not (m1.any() or m2.any()):
                break
            votes = np.zeros((B, n_lab))
            np.add.at(votes, (bandpos[spa[m1]], lb[m1]), wb[sub][m1])
            np.add.at(votes, (bandpos[spb[m2]], la[m2]), wa[sub][m2])
            gain = votes.sum(axis=1) > 0
            if not gain.any():
                break
            seed[Bfaces[gain]] = votes[gain].argmax(axis=1)
            n_assigned += int(gain.sum())
            la = seed[spa]                           # prune du niveau
            lb = seed[spb]
            sub = sub[(la == -1) | (lb == -1)]
    # --- reliquat non atteint -> plus proche face étiquetée ---
    unl = seed == -1
    n_fallback = int(unl.sum())
    if n_fallback:
        keep = np.where(~unl)[0]
        uf = np.where(unl)[0]
        _, nn = cKDTree(cent[keep]).query(cent[uf], k=1, workers=-1)
        seed[uf] = seed[keep[nn]]
    _log(f"watershed: bande {B} faces ré-inondée "
         f"({int((seed != lab).sum())} faces changées, {n_fallback} fallback) "
         f"en {time.time() - t0:.2f}s")
    return seed, True


def _face_lab_field(mesh, area, dist, idx, r_max):
    """CHAMP COULEUR Lab PAR FACE (étape 4a du dé-patchwork v8) — échantillonne
    la texture au CENTROÏDE UV de chaque face (tex[H-1-y, x] : axe Y texture
    inversé, validé), convertit sRGB→Lab (D65, 100 % numpy, AUCUNE dépendance)
    puis LISSE par 2 passes de moyenne kNN pondérée aire (mêmes dist/idx que le
    pipeline, cutoff 3·h → pas de bleeding à travers les gaps d'air
    chenille↔caisse). Anti-bruit texel. Retourne (N,3) float64, ou None si le
    mesh n'est pas texturé (→ l'étape 4 bascule en geo-only durci).
    Mesuré : ~1 s / 488k faces. Mirroir EXACT de
    scripts/partsam_bridge.py._face_lab_field."""
    try:
        import numpy as np
        vis = getattr(mesh, "visual", None)
        uv = getattr(vis, "uv", None)
        mat = getattr(vis, "material", None)
        img = getattr(mat, "baseColorTexture", None)
        if uv is None or img is None or len(uv) != len(mesh.vertices):
            return None
        tex = np.asarray(img.convert("RGB"), dtype=np.float64) / 255.0
        H, W = tex.shape[:2]
        fuv = np.asarray(uv, dtype=np.float64)[mesh.faces].mean(axis=1)
        u = np.mod(fuv[:, 0], 1.0)
        v = np.mod(fuv[:, 1], 1.0)
        x = np.clip((u * (W - 1)).round().astype(np.int64), 0, W - 1)
        y = np.clip((v * (H - 1)).round().astype(np.int64), 0, H - 1)
        rgb = tex[H - 1 - y, x]                       # axe Y texture inversé
        fac = getattr(mat, "baseColorFactor", None)
        if fac is not None:
            fac = np.asarray(fac, dtype=np.float64).reshape(-1)
            if fac.size >= 3:
                f3 = fac[:3]
                if f3.max() > 1.0:                    # trimesh stocke en uint8
                    f3 = f3 / 255.0
                if not np.allclose(f3, 1.0):
                    rgb = rgb * f3
        # --- sRGB -> Lab (D65), 100 % numpy ---
        lin = np.where(rgb <= 0.04045, rgb / 12.92,
                       ((rgb + 0.055) / 1.055) ** 2.4)
        M = np.array([[0.4124564, 0.3575761, 0.1804375],
                      [0.2126729, 0.7151522, 0.0721750],
                      [0.0193339, 0.1191920, 0.9503041]])
        xyz = lin @ M.T
        xyz /= np.array([0.95047, 1.0, 1.08883])
        d = 6.0 / 29.0
        f = np.where(xyz > d ** 3, np.cbrt(xyz),
                     xyz / (3 * d * d) + 4.0 / 29.0)
        lab_col = np.stack([116.0 * f[:, 1] - 16.0,
                            500.0 * (f[:, 0] - f[:, 1]),
                            200.0 * (f[:, 1] - f[:, 2])], axis=1)
        # --- anti-bruit texel : 2 passes de moyenne kNN pondérée aire ---
        validk = dist <= r_max
        validk[:, 0] = True
        w = validk * area[idx]
        wsum = w.sum(axis=1, keepdims=True)
        wsum[wsum <= 0] = 1.0
        for _ in range(2):
            lab_col = np.einsum("nk,nki->ni", w, lab_col[idx]) / wsum
        return lab_col
    except Exception as e:
        _log(f"champ couleur indispo ({e}) — étape 4 en geo-only")
        return None


def _appearance_pair_rows(labels, pa, pb, th_un, perp, idx, validk,
                          lab_col, fn_rob, area, crease_deg):
    """Table par PAIRE de labels adjacents pour la fusion par apparence :
    n_pairs (contact), crease (part de frontière sur pli, angle NON orienté
    > `crease_deg`), ang (angle MÉDIAN de frontière), dE (‖médiane Lab bande A
    − médiane Lab bande B‖ ; None si pas de couleur), perp (médiane
    |Δc·n|/|Δc| = anti-survol canon/glacis), plate (min sur les 2 bandes de
    λmax(Σ aire·n nᵀ / Σ aire) = anti-tube). Chaque bande = faces ring0 au
    contact + 2 anneaux de dilatation kNN restant DANS le même label. Les
    comparaisons couleur sont des MÉDIANES par bande (quantile robuste aux
    décals/salissures) — jamais la moyenne globale d'un label bicolore.
    Mirroir EXACT de scripts/partsam_bridge.py._appearance_pair_rows."""
    import numpy as np
    uniq, lab = np.unique(labels, return_inverse=True)
    lab = lab.astype(np.int64)
    L = len(uniq)
    la, lb = lab[pa], lab[pb]
    bnd = la != lb
    if not bnd.any():
        return []
    key = (np.minimum(la[bnd], lb[bnd]) * np.int64(L)
           + np.maximum(la[bnd], lb[bnd]))
    pkeys, inv, counts = np.unique(key, return_inverse=True,
                                   return_counts=True)
    th_b = th_un[bnd]
    perp_b = perp[bnd]
    pa_b, pb_b = pa[bnd], pb[bnd]
    rows = []
    for pi, (k, n) in enumerate(zip(pkeys, counts)):
        A, B = int(k // L), int(k % L)
        sel = inv == pi
        sides = []
        for side in (A, B):
            s = np.unique(np.concatenate(
                [pa_b[sel][lab[pa_b[sel]] == side],
                 pb_b[sel][lab[pb_b[sel]] == side]]))
            for _ in range(2):                        # 2 anneaux intra-label
                nb = idx[s][validk[s]]
                s = np.unique(np.concatenate([s, nb[lab[nb] == side]]))
            sides.append(s)
        sideA, sideB = sides
        dE = None
        if lab_col is not None:
            dE = float(np.linalg.norm(np.median(lab_col[sideA], axis=0)
                                      - np.median(lab_col[sideB], axis=0)))
        plates = []
        for s in (sideA, sideB):
            nn = fn_rob[s]
            w = area[s]
            Mn = np.einsum("k,ki,kj->ij", w, nn, nn) / max(w.sum(), 1e-30)
            plates.append(float(np.linalg.eigvalsh(Mn)[-1]))
        rows.append({
            "A": int(uniq[A]), "B": int(uniq[B]), "n_pairs": int(n),
            "crease": float((th_b[sel] > crease_deg).mean()),
            "ang": float(np.median(th_b[sel])),
            "dE": dE,
            "perp": float(np.median(perp_b[sel])),
            "plate": float(min(plates)),
        })
    return rows


def _merge_eligible(r, P, hard_crease):
    """Une paire (A,B) est fusionnable si sa frontière est PLATE (crease sous
    le seuil ET sous le HARD BLOCK absolu qui protège canon/chenilles), FINE
    d'angle, de MÊME couleur (dE), et n'est ni un survol (perp) ni un tube
    (plate) — chaque garde bloque un piège mesuré du tank. Mirroir EXACT de
    scripts/partsam_bridge.py._merge_eligible."""
    return (r["n_pairs"] >= P["min_pairs"]
            and r["crease"] < min(P["crease_max"], hard_crease)
            and r["ang"] <= P["ang_max"]
            and (r["dE"] is None or r["dE"] <= P["dE_max"])
            and r["perp"] <= P["perp_max"]
            and r["plate"] >= P["plate_min"])


def _absorb_debords(labels, pa, pb, th_un, idx, validk, lab_col,
                    area, N, P, crease_deg):
    """ÉTAPE 4bis — ABSORPTION DES DÉBORDS PAR APPARENCE : les composantes
    spatiales NON-dominantes d'un label posées sur la nappe d'un voisin (le
    patchwork entremêlé visible). Gates : `comp_min` ≤ taille ≤ comp_frac_max·N
    ET taille < mirror_ratio·(comp dominante du label) [ANTI-MIROIR
    chenilles/roues] ET voisin majoritaire ≥ maj_min de la frontière ET
    crease(frontière) < crease_max_comp ET dE bande ≤ dE_max_comp. PAS de gate
    perp/plate (un débord est par nature posé sur la nappe voisine ; on ne
    déplace qu'un fragment, jamais un label entier). Décisions sur l'état
    d'ENTRÉE, ordre déterministe = taille décroissante (argsort stable).
    Retourne (labels_out, n_absorbed). Mirroir EXACT de
    scripts/partsam_bridge.py._absorb_debords."""
    import numpy as np
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    out = np.asarray(labels).copy()
    uniq, lab = np.unique(out, return_inverse=True)
    lab = lab.astype(np.int64)
    same = lab[pa] == lab[pb]
    adj = coo_matrix((np.ones(int(same.sum()), np.int8),
                      (pa[same], pb[same])), shape=(N, N))
    n_comp, comp = connected_components(adj, directed=False)
    comp_size = np.bincount(comp, minlength=n_comp)
    comp_label = np.zeros(n_comp, np.int64)
    comp_label[comp] = lab
    dom_size = np.zeros(len(uniq), np.int64)
    np.maximum.at(dom_size, comp_label, comp_size)
    diff = ~same
    dpa, dpb = pa[diff], pb[diff]
    th_d = th_un[diff]
    size_cap = P["comp_frac_max"] * N
    n_abs = 0
    for c in np.argsort(-comp_size, kind="stable"):
        sz = int(comp_size[c])
        if sz > size_cap:
            continue
        if sz < P["comp_min"]:
            break                                     # tri décroissant
        l = int(comp_label[c])
        if sz >= P["mirror_ratio"] * dom_size[l]:
            continue                                  # dominante ou miroir
        selA = comp[dpa] == c
        selB = comp[dpb] == c
        if not (selA.any() or selB.any()):
            continue
        th_bnd = np.concatenate([th_d[selA], th_d[selB]])
        crease = float((th_bnd > crease_deg).mean())
        if crease >= P["crease_max_comp"]:
            continue
        other = np.concatenate([lab[dpb[selA]], lab[dpa[selB]]])
        maj = int(np.bincount(other).argmax())
        if float((other == maj).mean()) < P["maj_min"]:
            continue
        if lab_col is not None:
            side = np.unique(np.concatenate([dpa[selA], dpb[selB]]))
            oth = np.unique(np.concatenate(
                [dpb[selA][lab[dpb[selA]] == maj],
                 dpa[selB][lab[dpa[selB]] == maj]]))
            if oth.size == 0:
                continue
            for _ in range(2):                        # 2 anneaux de dilatation
                nb = idx[side][validk[side]]
                side = np.unique(np.concatenate([side, nb[comp[nb] == c]]))
                nb = idx[oth][validk[oth]]
                oth = np.unique(np.concatenate([oth, nb[lab[nb] == maj]]))
            dE = float(np.linalg.norm(np.median(lab_col[side], axis=0)
                                      - np.median(lab_col[oth], axis=0)))
            if dE > P["dE_max_comp"]:
                continue
        out[comp == c] = uniq[maj]
        n_abs += 1
    return out, n_abs


def _merge_by_appearance(labels, gran, fn_rob, lab_col, cent, area,
                         dist, idx, r_max, crease_deg=25.0, hard_crease=0.45):
    """ÉTAPE 4 — FUSION PAR APPARENCE (dé-patchwork v8). Après le watershed
    (les frontières sont déjà sur les plis), deux labels voisins dont la
    frontière commune est majoritairement HORS PLI (plate) ET dont les
    couleurs sont proches sont la MÊME pièce sémantique → fusion. Vagues :
    re-évaluation COMPLÈTE de la table entre chaque vague (anti-transitivité),
    matching glouton 1 fusion max par label par vague (anti-cascade), plancher
    de parties strict, tri stable (dE, crease, A, B) → déterministe ; puis
    étape 4bis (absorption des débords). Paramètres modulés par granularité
    (g fin = plus conservateur, le user veut plus de parties) ; geo-only durci
    si `lab_col is None`. POST-CONDITIONS (sinon repli no-op = labels étape 3
    inchangés) : n_parts_out == n_parts_in − fusions, ≥ plancher, AUCUNE fusion
    de frontière crease ≥ `hard_crease` (préservation canon/chenilles/antennes,
    dont les frontières sont sur pli). Réutilise `fn_rob` déjà calculé pour le
    watershed. Mesuré (tank) : 0.4-0.7 s, g=0.2 12→10 parties, g=1.0 27→25,
    canon/chenilles/tourelle INTACTS. No-op sur exception. Mirroir EXACT de
    scripts/partsam_bridge.py._merge_by_appearance."""
    import numpy as np
    labels_in = np.asarray(labels).reshape(-1).astype(np.int64)
    try:
        t0 = time.time()
        N = labels_in.shape[0]
        fine = gran >= 0.7
        has_col = lab_col is not None
        P = dict(
            # --- étape 4 : label-merge par apparence ---
            crease_max=0.28 if fine else 0.32,        # % max frontière sur pli
            dE_max=7.0 if fine else 9.0,              # ΔE médian max entre bandes
            min_pairs=50 if fine else 40,             # contact significatif
            ang_max=28.0,                             # angle MÉDIAN de frontière
            perp_max=0.47,                            # anti-survol (canon 0.546)
            plate_min=0.60,                           # anti-tube (canon 0.478)
            floor=12 if fine else 6, max_waves=6,
            # --- étape 4bis : absorption des débords ---
            comp_min=200, comp_frac_max=0.02, mirror_ratio=0.5,
            maj_min=0.60, crease_max_comp=0.50, dE_max_comp=8.0,
        )
        if not has_col:                               # non texturé -> geo durci
            P.update(dE_max=float("inf"), crease_max=0.28,
                     perp_max=0.45, plate_min=0.65, dE_max_comp=float("inf"))
        # --- précalculs par PAIRE de faces voisines (i<j, cutoff 3·h) ---
        validk = dist <= r_max
        validk[:, 0] = True
        kq = idx.shape[1]
        srcf = np.repeat(np.arange(N, dtype=np.int64), kq - 1)
        dstf = idx[:, 1:].ravel().astype(np.int64)
        near = dist[:, 1:].ravel() <= r_max
        srcf, dstf = srcf[near], dstf[near]
        keys = np.unique(np.minimum(srcf, dstf) * np.int64(N)
                         + np.maximum(srcf, dstf))
        pa = (keys // N).astype(np.int64)
        pb = (keys % N).astype(np.int64)
        # angle NON ORIENTÉ [0,90] (l'orienté sature à ~0.9 : coques doublées)
        dots = np.abs(np.clip(np.einsum("ij,ij->i", fn_rob[pa], fn_rob[pb]),
                              -1.0, 1.0))
        th_un = np.degrees(np.arccos(dots))
        d = cent[pb] - cent[pa]
        pd = np.maximum(np.linalg.norm(d, axis=1), 1e-12)
        perp = np.maximum(np.abs(np.einsum("ij,ij->i", d, fn_rob[pa])),
                          np.abs(np.einsum("ij,ij->i", d, fn_rob[pb]))) / pd
        # --- étape 4 : label-merge par vagues ---
        labels = labels_in.copy()
        n_in = len(np.unique(labels))
        n_merges = 0
        max_merge_crease = 0.0
        for _wave in range(P["max_waves"]):
            n_parts = len(np.unique(labels))
            if n_parts <= P["floor"]:
                break
            rows = _appearance_pair_rows(labels, pa, pb, th_un, perp, idx,
                                         validk, lab_col, fn_rob, area,
                                         crease_deg)
            cand = [r for r in rows if _merge_eligible(r, P, hard_crease)]
            cand.sort(key=lambda r: (
                r["dE"] if r["dE"] is not None else 0.0,
                r["crease"], r["A"], r["B"]))
            used, merges = set(), []
            for r in cand:
                if r["A"] in used or r["B"] in used:
                    continue
                if n_parts - len(merges) - 1 < P["floor"]:
                    break
                used.update((r["A"], r["B"]))
                merges.append(r)
            if not merges:                            # point fixe = stabilité
                break
            for r in merges:                          # B -> A (A < B, stable)
                if r["crease"] >= hard_crease:        # défensif
                    continue
                labels[labels == r["B"]] = r["A"]
                max_merge_crease = max(max_merge_crease, r["crease"])
                n_merges += 1
        # --- post-conditions du label-merge (sinon no-op) ---
        n_mid = len(np.unique(labels))
        if (n_mid != n_in - n_merges or n_mid < P["floor"]
                or max_merge_crease >= hard_crease):
            _log("appearance: post-condition violée — labels étape 3 gardés")
            return labels_in
        # --- étape 4bis : absorption des débords ---
        final, n_deb = _absorb_debords(labels, pa, pb, th_un, idx, validk,
                                       lab_col, area, N, P, crease_deg)
        if len(np.unique(final)) != n_mid:            # défensif (impossible)
            _log("appearance: label perdu en 4bis — débords ignorés")
            final, n_deb = labels, 0
        _log(f"appearance: {n_merges} fusions ({n_in}->{n_mid} parties), "
             f"{n_deb} débords absorbés en {time.time()-t0:.2f}s "
             f"(max crease fusion {max_merge_crease:.3f}, "
             f"{'texturé' if has_col else 'geo-only'})")
        return final
    except Exception as e:
        _log(f"appearance indispo ({e}) — labels étape 3 gardés (no-op)")
        return labels_in


def _clean_labels(mesh, labels, gran=0.0):
    """Débruite les labels par-face — pipeline « v7_watershed » complet, un
    seul query cKDTree k=12 partagé par les trois étapes :
      1) mode kNN 1 passe (k=12, cutoff 3·h, bincount) — tue le speckle 1-10
         faces et fiabilise la dominance des composantes pour l'absorption ;
      2) ISLAND ABSORPTION — résorbe les îlots moyens 50-1500 faces (point
         fixe du mode) par réassignation de composantes entières ;
         + 2bis) absorption des LABELS ÉPARPILLÉS entiers ;
      3) WATERSHED CREASE-AWARE — érosion d'une bande autour des frontières
         puis re-croissance par immersion par niveaux d'angle sur des
         normales ROBUSTES (_robust_normals) : la coupe se pose sur les
         crêtes du champ de plis (le snap v6 restait dans un minimum local
         sur les grandes plaques) ; + 3bis) absorption anti-pincement.
         Repli sur le snap v6 en cas d'exception. Post-condition à chaque
         sous-étape : 0 label perdu, sinon revert.
      4) FUSION PAR APPARENCE (v8) — dé-patchwork des grandes plaques lisses
         (caisse/tourelle) : deux labels voisins dont la frontière commune est
         PLATE (hors pli, watershed déjà passé) ET de couleur texture proche
         sont fusionnés (_merge_by_appearance), + 4bis absorption des débords.
         Ne s'exécute QUE si le watershed robuste a réussi (frontières fiables
         sur les plis) ; réutilise fn_rob. No-op sur exception.
    Robuste aux meshes fragmentés (kNN spatial, pas de connectivité).
    No-op si scipy absent ou en cas d'erreur.
    Mirroir EXACT de scripts/partsam_bridge.py._clean_labels."""
    try:
        import numpy as np
        from scipy.spatial import cKDTree
    except Exception:
        return labels
    labels_in = labels
    try:
        t0 = time.time()
        labels = np.asarray(labels).reshape(-1).astype(np.int64)
        faces = getattr(mesh, "faces", None)
        if faces is None or len(labels) != len(faces) or len(labels) < 100:
            return labels_in
        N = len(labels)
        cent = np.asarray(mesh.triangles_center, dtype=np.float64)
        area = np.asarray(mesh.area_faces, dtype=np.float64)
        h = float(np.median(np.sqrt(np.maximum(area, 1e-30))))
        r_max = 3.0 * h
        kq = min(12, N)
        tree = cKDTree(cent)
        dist, idx = tree.query(cent, k=kq, workers=-1)
        # --- 1) mode kNN 1 passe, cutoff 3·h, bincount vectorisé ---
        uniq0, lab = np.unique(labels, return_inverse=True)
        lab = lab.astype(np.int64)
        n0 = len(uniq0)
        lab, ok = _knn_mode_vote(lab, n0, dist, idx, r_max)
        labels1 = uniq0[lab]
        _log(f"denoise: mode kNN 1 passe (k={kq}, cutoff {r_max:.5f}) "
             f"labels {n0}->{len(np.unique(labels1))} en {time.time()-t0:.1f}s")
        # --- 2) island absorption (précalculs partagés) ---
        labels2 = _absorb_islands(
            mesh, labels1, keep_frac=(0.001 if gran >= 0.7 else 0.002),
            _pre=(cent, area, h, dist, idx))
        # --- 2bis) absorption des LABELS ÉPARPILLÉS (mirroir bridge) ---
        labels2 = _absorb_scattered(labels2, cent, dist, idx, r_max)
        # --- 3) watershed crease-aware : la coupe se pose sur les crêtes
        #        du champ de plis (normales robustes) ---
        labels2 = np.asarray(labels2).reshape(-1).astype(np.int64)
        uniq2, lab2 = np.unique(labels2, return_inverse=True)
        lab2 = lab2.astype(np.int64)
        n2 = len(uniq2)
        out = labels2
        fn_rob = None                    # hissé : réutilisé par l'étape 4
        step4_ready = False              # True seulement si watershed robuste OK
        try:
            fn_raw = np.asarray(mesh.face_normals, dtype=np.float64)
            fn_rob = _robust_normals(cent, area, fn_raw, dist, idx,
                                     r_max, tree)
            lab3, ok3 = _crease_watershed(
                lab2, n2, fn_rob, cent, area, dist, idx, r_max)
            if ok3 and (lab3 >= 0).all():
                cand = uniq2[lab3]
                if len(np.unique(cand)) != n2:  # post-condition défensive
                    _log("watershed: label perdu — revert étape 3")
                else:
                    out = cand
                    step4_ready = True
                    # --- 3bis) anti-pincement : deux fronts qui se pincent
                    # créent des fragments — résorbés par l'absorption de
                    # l'étape 2 (revert si un label disparaît) ---
                    out3b = np.asarray(_absorb_islands(
                        mesh, out,
                        keep_frac=(0.001 if gran >= 0.7 else 0.002),
                        _pre=(cent, area, h, dist, idx))
                    ).reshape(-1).astype(np.int64)
                    if len(np.unique(out3b)) == n2:
                        out = out3b
                    else:
                        _log("watershed: label perdu en 3bis — absorb ignoré")
        except Exception as e:
            # repli v6 : snap crease-aware local sur normales brutes
            _log(f"watershed indispo ({e}) — repli snap v6")
            try:
                fn = np.asarray(mesh.face_normals, dtype=np.float64)
                lab2, ok3 = _crease_snap(
                    lab2, n2, fn, cent, area, dist, idx, r_max)
                if ok3:
                    cand = uniq2[lab2]
                    if len(np.unique(cand)) == n2:
                        out = cand
                    else:
                        _log("snap: label perdu — revert étape 3")
            except Exception as e2:
                _log(f"snap indispo ({e2}) — labels étape 2 gardés")
        # --- 4) FUSION PAR APPARENCE — dé-patchwork des grandes plaques :
        #        deux labels voisins à frontière plate (hors pli) ET couleur
        #        texture proche = même pièce → fusion, + 4bis débords. Ne tourne
        #        que si le watershed robuste a réussi (frontières déjà sur les
        #        plis, condition d'un signal « frontière plate » fiable) et
        #        réutilise fn_rob. No-op interne sur exception/post-condition. ---
        if step4_ready and fn_rob is not None:
            lab_col = _face_lab_field(mesh, area, dist, idx, r_max)
            out = np.asarray(_merge_by_appearance(
                out, gran, fn_rob, lab_col, cent, area, dist, idx, r_max)
            ).reshape(-1).astype(np.int64)
        _log(f"denoise total {time.time()-t0:.1f}s "
             f"(labels {n0}->{len(np.unique(out))})")
        return out
    except Exception as e:
        _log(f"denoise indispo ({e}) — labels bruts")
        return labels_in


def _build_segmented_glb(src_mesh, labels, out_path: str) -> int:
    """Construit un GLB où CHAQUE partie (label distinct) devient un sous-mesh
    NOMMÉ `part_00`, `part_01`, … avec une COULEUR PLEINE distincte (couleurs
    de faces → COLOR_0 ; aucune texture). Rendu « carte des parties » que les
    2 viewers three.js (desktop + cloud) affichent nativement. Renvoie le
    nombre de parties. Identique à _sampart3d._build_segmented_glb."""
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
    # Mesh TEXTURÉ : chaque partie GARDE la texture (submesh préserve UV) +
    # matériau source PARTAGÉ (atlas non dupliqué). Le viewer applique les
    # couleurs de parties (toggle couleurs ↔ texture). Sinon : couleur pleine.
    src_vis = getattr(src_mesh, "visual", None)
    src_uv = getattr(src_vis, "uv", None)
    has_tex = src_uv is not None and len(src_uv) == len(src_mesh.vertices)
    src_mat = getattr(src_vis, "material", None) if has_tex else None
    n_parts = 0
    for i, lab in enumerate(uniq):
        face_idx = np.where(labels == lab)[0]
        if face_idx.size == 0:
            continue
        part = src_mesh.submesh([face_idx], append=True)
        if part is None or len(part.faces) == 0:
            continue
        if has_tex:
            # NE PAS partager le matériau (trimesh droppe les NORMAL à l'export
            # → PBR noir). Le submesh garde sa TextureVisuals ; images
            # dédupliquées à l'export. On force les normales pour l'export.
            try:
                _ = part.vertex_normals
            except Exception:
                pass
        else:
            color = _PART_PALETTE[i % len(_PART_PALETTE)]
            rgba = np.array([color[0], color[1], color[2], 255], dtype=np.uint8)
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
# Volume si job_id fourni. Miroir du contrat rig_mesh (GLB in → GLB out).
# ---------------------------------------------------------------------------
@app.function(
    image=image,
    gpu="A100",
    timeout=900,                  # feedforward ~40-90 s + marge cold-start
    volumes={"/seg_data": seg_output_volume},
    secrets=[
        modal.Secret.from_name("huggingface", required_keys=["HF_TOKEN"]),
    ],
)
def segment_mesh(
    glb_bytes: bytes,
    granularity: float = 0.0,
    job_id: str | None = None,
) -> bytes:
    """Segmente le GLB en parties → renvoie les bytes d'un GLB SEGMENTÉ.

    `granularity` = granularité PartSAM (0.0 = grossier/peu de parties → 1.0 =
    fin/beaucoup de parties). Mappée sur (iou, nms). Le GLB contient un
    sous-mesh nommé par partie, chacun d'une couleur pleine distincte → chargé
    directement comme nouvelle version de mesh par les viewers (aucun parsing
    côté client).

    Sur `job_id`, écrit /seg_data/<job_id>.glb (succès) ou <job_id>.err
    (échec JSON) pour que segment_status / segment_fetch servent le résultat.
    """
    t_total = time.time()
    tmp_dir = tempfile.mkdtemp(prefix="partsam_")
    try:
        try:
            out_bytes = _run_segment_pipeline(
                glb_bytes, tmp_dir, granularity, t_total)
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


def _run_segment_pipeline(glb_bytes: bytes, tmp_dir: str, granularity: float,
                          t_total: float) -> bytes:
    """Corps du pipeline (extrait pour l'enrobage async). Reprend la LOGIQUE
    de partsam_bridge : eval_everypart → labels → GLB part_XX. Renvoie les
    bytes d'un GLB SEGMENTÉ pour la granularité demandée."""
    import numpy as np
    import trimesh

    iou, nms = _granularity_to_thresholds(granularity)
    _log(f"granularité={float(granularity):.2f} -> iou={iou} nms={nms}")

    # stem UNIQUE par appel : les sorties eval (results/{id}_*) sont RELATIVES
    # au cwd (=/PartSAM) et partagées si Modal réutilise un container chaud →
    # un nom unique évite toute collision avec un run précédent.
    stem = "fabmesh_" + uuid.uuid4().hex[:8]
    in_dir = os.path.join(PARTSAM_DIR, "_fabmesh_in", stem)
    res_dir = os.path.join(PARTSAM_DIR, "results")
    os.makedirs(in_dir, exist_ok=True)
    os.makedirs(res_dir, exist_ok=True)
    mesh_in = os.path.join(in_dir, f"{stem}.glb")
    with open(mesh_in, "wb") as f:
        f.write(glb_bytes)

    src_mesh = trimesh.load(mesh_in, force="mesh")
    n_faces = int(len(src_mesh.faces))
    _log(f"mesh chargé: {n_faces} faces, {len(src_mesh.vertices)} vertices")

    labels_npy = os.path.join(res_dir, f"{stem}_labels.npy")
    ply_out = os.path.join(res_dir, f"{stem}.ply")

    env = dict(os.environ)
    # eval_everypart fait sys.path.append(".") + imports relatifs (utils.*,
    # PartSAM.*, partfield.*) → cwd DOIT être /PartSAM. PYTHONPATH en renfort.
    env["PYTHONPATH"] = PARTSAM_DIR + os.pathsep + env.get("PYTHONPATH", "")
    env.setdefault("CUDA_VISIBLE_DEVICES", "0")
    env["PYTHONIOENCODING"] = "utf-8"

    try:
        _log("== PartSAM (feedforward) ==")
        cmd = [
            sys.executable, os.path.join("evaluation", "eval_everypart.py"),
            f"dataset.root_dir={in_dir.replace(os.sep, '/')}",
            "eval_params.use_graph_cut=False",   # faces>50k : évite l'optim
            "eval_params.batch_size=4",           # borne OOM cdist mask_decoder
            f"eval_params.iou_threshold={iou}",
            f"eval_params.nms_threshold={nms}",
            # Nuage 2x plus dense (100k -> 200k) : frontières de coupe 2x plus
            # fines (labels par-face peints par plus-proche-point). Mirroir du
            # bridge desktop ; l'A10G/A100 Modal a la marge VRAM à batch=4.
            "num_points=200000",
        ]
        rc = _run(cmd, cwd=PARTSAM_DIR, env=env, label="eval")
        if rc != 0 or not os.path.isfile(labels_npy):
            raise RuntimeError(
                f"eval_everypart a échoué (rc={rc}) / labels absents "
                f"({labels_npy})")

        labels = np.load(labels_npy).astype(np.int64).reshape(-1)
        n_parts_raw = int(labels.max()) + 1 if labels.size else 0
        _log(f"labels: {os.path.basename(labels_npy)}, {n_parts_raw} parties "
             f"brutes, {labels.shape[0]} labels / {n_faces} faces")

        # débruite : mode kNN + island absorption + snap crease-aware
        labels = _clean_labels(src_mesh, labels, granularity)
        out_glb = os.path.join(tmp_dir, "segmented.glb")
        n_parts = _build_segmented_glb(src_mesh, labels, out_glb)
        if not os.path.isfile(out_glb) or os.path.getsize(out_glb) == 0:
            raise RuntimeError("export du GLB segmenté vide")
        with open(out_glb, "rb") as f:
            out_bytes = f.read()
        _log(f"TOTAL dt={time.time()-t_total:.1f}s  glb={len(out_bytes)} bytes "
             f" parties={n_parts}  (iou={iou} nms={nms})")
        return out_bytes
    finally:
        shutil.rmtree(in_dir, ignore_errors=True)
        for p in (labels_npy, ply_out):
            try:
                os.remove(p)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Router ASGI async — segment-start (spawn) / segment-status (poll) /
# segment-fetch (stream). Miroir de segment_router dans _sampart3d.py.
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
    Chaque appel retourne en <1 s (le GPU tourne dans un container séparé via
    .spawn()) → compatible cap 100 s des Workers Cloudflare. Même contrat que
    _sampart3d (GLB in → GLB out) ; le paramètre de granularité s'appelle
    `granularity` (0.0 grossier → 1.0 fin ; `scale` accepté en alias)."""
    from fastapi import FastAPI, HTTPException, Request
    from fastapi.responses import JSONResponse, FileResponse

    api = FastAPI(title="myfabmesh-partsam")

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

    def _granularity_from(payload: dict) -> float:
        """granularity 0.0-1.0 (grossier→fin). `scale` accepté en alias
        (legacy voie SAMPart3D) et clampé au domaine PartSAM [0,1]."""
        raw = payload.get("granularity")
        if raw is None:
            raw = payload.get("scale", 0.0)
        try:
            g = float(raw)
        except (TypeError, ValueError):
            g = 0.0
        return max(0.0, min(1.0, g))

    @api.get("/healthz")
    async def healthz():
        return {"ok": True, "fn": "segment_router", "engine": "partsam"}

    @api.post("/segment-start")
    async def segment_start(request: Request):
        """Spawn async d'un job de segmentation.
        Body: {"_auth","mesh_url", "granularity"?:float, "job_id"?}
              granularity = 0.0 grossier → 1.0 fin (défaut 0.0 ; `scale` alias).
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
        granularity = _granularity_from(payload)

        # Télécharge le GLB ici (container CPU, cheap) plutôt que sur le GPU.
        try:
            req = urllib.request.Request(
                mesh_url, headers={"User-Agent": "myfabmesh-partsam/1.0"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                in_bytes = resp.read()
        except Exception as e:
            raise HTTPException(status_code=502,
                                detail=f"mesh fetch failed: {e}")
        if not in_bytes or in_bytes[:4] != b"glTF":
            raise HTTPException(status_code=400,
                                detail="mesh_url did not return a GLB")

        job_id = (payload.get("job_id") or "").strip() or uuid.uuid4().hex
        call = segment_mesh.spawn(
            in_bytes, granularity=granularity, job_id=job_id)
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
