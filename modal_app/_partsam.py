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
  3. Relecture des labels → débruitage « v4_combo » (mode kNN cutoff 3·h +
     island absorption + lissage frontière, mirroir EXACT de partsam_bridge ;
     mesuré sur tank 488k tris : faces parasites 12.83 % → 1.73 %) →
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
    """g 0.0 (grossier) → 1.0 (fin). Interpole iou (0.65→0.5, plus bas = plus
    de masques) et nms (0.3→0.65, plus haut = moins de suppression). Mirroir
    EXACT de scripts/partsam_bridge.py._granularity_to_thresholds."""
    try:
        g = float(g)
    except (TypeError, ValueError):
        g = 0.0
    g = max(0.0, min(1.0, g))
    iou = 0.65 - 0.15 * g
    nms = 0.30 + 0.35 * g
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


def _clean_labels(mesh, labels, gran=0.0):
    """Débruite les labels par-face — pipeline « v4_combo » complet, un seul
    query cKDTree k=12 partagé par les trois étapes :
      1) mode kNN 1 passe (k=12, cutoff 3·h, bincount) — tue le speckle 1-10
         faces et fiabilise la dominance des composantes pour l'absorption ;
      2) ISLAND ABSORPTION — résorbe les îlots moyens 50-1500 faces (point
         fixe du mode) par réassignation de composantes entières ;
      3) lissage frontière — 1 passe mode k=8 restreinte aux faces à
         voisinage mixte (adoucit les bords crénelés de la réassignation).
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
        dist, idx = cKDTree(cent).query(cent, k=kq, workers=-1)
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
        # --- 3) lissage frontière : mode k=8 sur faces à voisinage mixte ---
        uniq2, lab2 = np.unique(
            np.asarray(labels2).reshape(-1).astype(np.int64),
            return_inverse=True)
        lab2 = lab2.astype(np.int64)
        n2 = len(uniq2)
        k8 = min(8, kq)
        valid8 = dist[:, :k8] <= r_max
        valid8[:, 0] = True
        mixed = ((lab2[idx[:, :k8]] != lab2[:, None]) & valid8).any(axis=1)
        if mixed.any():
            lab2, ok8 = _knn_mode_vote(
                lab2, n2, dist, idx, r_max, sub_k=k8, only_faces=mixed)
            if ok8:
                _log(f"denoise: lissage frontière k={k8} "
                     f"({int(mixed.sum())} faces mixtes)")
        out = uniq2[lab2]
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

        # débruite : mode kNN + island absorption + lissage frontière
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
