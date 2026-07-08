"""Patches build-time du repo SAMPart3D pour l'image Modal (_sampart3d.py).

Trois allègements validés par la recherche (2026-07-07 / 2026-07-08) :

  1. flash-attn → OFF : PTv3 tourne avec `enable_flash=False`. On évite ainsi
     de compiler flash-attn (enfer notoire) — le config upstream le met à True.

  2. HDBSCAN GPU (RAPIDS cuml/cudf) → HDBSCAN CPU (sklearn) : le clustering
     tourne sur ~15k points, le CPU suffit largement, et on retire tout le
     stack RAPIDS glibc/CUDA-pointilleux de l'image. Upstream a d'ailleurs
     la ligne sklearn en commentaire juste à côté de l'import cuml.

  3. tiny-cuda-nn → MLP pur-torch : SAMPart3D n'utilise tcnn QUE comme deux
     MLP denses (CutlassMLP 384 neurones, ReLU — PAS de hashgrid/encoding).
     On remplace `import tinycudann as tcnn` par un shim pur-torch : les
     appels `tcnn.Network(...)` marchent inchangés, et on élimine toute
     compilation tiny-cuda-nn (fragile sur Blackwell sm_120 et Windows).

Le script marche par balayage du repo (on ne présume pas des chemins exacts)
et LOG chaque modification. Il n'échoue jamais le build s'il ne trouve rien
(un warning suffit — le runtime révèlera un éventuel oubli).

Usage: python _patch_sampart3d.py /SAMPart3D
"""
import os
import re
import sys

# Console Windows en cp1252 par défaut → force UTF-8 pour les logs (le wizard
# peut appeler ce script sans PYTHONUTF8/PYTHONIOENCODING).
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def _iter_py(root):
    for dirpath, _dirs, files in os.walk(root):
        # on saute les gros dossiers non pertinents
        if any(seg in dirpath for seg in (os.sep + ".git", os.sep + "libs")):
            continue
        for fn in files:
            if fn.endswith(".py"):
                yield os.path.join(dirpath, fn)


# Shim pur-torch injecté à la place de `import tinycudann as tcnn`.
# `tcnn.Network(n_input_dims, n_output_dims, network_config={...})` construit
# un MLP dense équivalent (n_neurons de large, n_hidden_layers couches, ReLU,
# sortie linéaire) — identique à ce que fait le CutlassMLP tcnn dans SAMPart3D.
_TCNN_SHIM = '''# import tinycudann as tcnn  # FabMesh: remplacé par un MLP pur-torch (sm_120, pas de build tcnn)
import torch.nn as _fab_nn


class _FabTcnn:
    class Network(_fab_nn.Module):
        """Remplacement pur-torch du CutlassMLP tcnn (MLP dense uniquement)."""
        def __init__(self, n_input_dims, n_output_dims, network_config=None, **_kw):
            super().__init__()
            cfg = network_config or {}
            w = int(cfg.get("n_neurons", 128))
            h = int(cfg.get("n_hidden_layers", 2))
            layers = [_fab_nn.Linear(n_input_dims, w), _fab_nn.ReLU()]
            for _ in range(max(0, h - 1)):
                layers += [_fab_nn.Linear(w, w), _fab_nn.ReLU()]
            layers.append(_fab_nn.Linear(w, n_output_dims))
            self.net = _fab_nn.Sequential(*layers)

        def forward(self, x):
            return self.net(x.float())


tcnn = _FabTcnn'''


def patch_repo(root):
    n_flash = 0
    n_hdbscan = 0
    n_tcnn = 0

    # Patterns de remplacement (regex, remplacement).
    flash_pat = re.compile(r"enable_flash\s*=\s*True")
    tcnn_pat = re.compile(r"^import\s+tinycudann\s+as\s+tcnn\s*$", re.MULTILINE)
    # cuml → sklearn : plusieurs formes d'import possibles.
    cuml_imports = [
        re.compile(r"from\s+cuml\.cluster\.hdbscan\s+import\s+HDBSCAN"),
        re.compile(r"from\s+cuml\.cluster\s+import\s+HDBSCAN"),
        re.compile(r"from\s+cuml\s+import\s+HDBSCAN"),
    ]
    sklearn_import = "from sklearn.cluster import HDBSCAN"

    for path in _iter_py(root):
        try:
            with open(path, "r", encoding="utf-8") as f:
                src = f.read()
        except Exception:
            continue
        orig = src

        # 1. enable_flash=True → False
        src, c = flash_pat.subn("enable_flash=False", src)
        n_flash += c

        # 2. import cuml HDBSCAN → sklearn
        for pat in cuml_imports:
            src, c = pat.subn(sklearn_import, src)
            n_hdbscan += c

        # 3. import tinycudann as tcnn → shim pur-torch
        src, c = tcnn_pat.subn(lambda _m: _TCNN_SHIM, src)
        n_tcnn += c

        # 2b. si une ligne `import cuml` isolée traîne pour HDBSCAN,
        #     on la neutralise (best-effort, ne casse rien si absente).
        src = re.sub(
            r"^\s*import\s+cuml\s*$",
            "# import cuml  # patched out (RAPIDS removed, using sklearn)",
            src, flags=re.MULTILINE,
        )

        if src != orig:
            with open(path, "w", encoding="utf-8") as f:
                f.write(src)
            rel = os.path.relpath(path, root)
            print(f"[patch] {rel}", flush=True)

    print(
        f"[patch] enable_flash=False x{n_flash}, "
        f"cuml->sklearn HDBSCAN x{n_hdbscan}, tcnn->pytorch x{n_tcnn}",
        flush=True,
    )
    if n_flash == 0:
        print("[patch] WARN: aucun 'enable_flash=True' trouvé "
              "(DEPLOY-VERIFY: le config a peut-être une autre clé)",
              flush=True)
    if n_hdbscan == 0:
        print("[patch] WARN: aucun import cuml HDBSCAN trouvé "
              "(DEPLOY-VERIFY: eval.py utilise peut-être un autre import)",
              flush=True)
    if n_tcnn == 0:
        print("[patch] WARN: aucun 'import tinycudann as tcnn' trouvé "
              "(DEPLOY-VERIFY: SAMPart3D.py utilise peut-être un autre import)",
              flush=True)


if __name__ == "__main__":
    root = sys.argv[1] if len(sys.argv) > 1 else "/SAMPart3D"
    patch_repo(root)
