"""Patches build-time du repo PartSAM pour FabMesh (env local sm_120).

PartSAM (feedforward, MIT) tourne sur RTX 5080 (sm_120, torch 2.7.0+cu128)
SANS apex — qui ne compile pas sur Blackwell. Ce script applique de façon
REPRODUCTIBLE et IDEMPOTENTE les trois modifs validées (AGENT_LOG « PIVOT #2 :
PartSAM ») à un checkout PartSAM passé en argument :

  1. `PartSAM/model/build.py` : `from apex.normalization import FusedLayerNorm`
     (import top-level) → bloc try/except retombant sur
     `from torch.nn import LayerNorm as FusedLayerNorm` (équivalent fonctionnel).

  2. `PartSAM/utils/torch_utils.py`, fn `replace_with_fused_layernorm` : l'import
     apex interne devient un try/except avec `return` (no-op) si apex absent —
     on garde alors les `nn.LayerNorm` standard du modèle.

  3. `evaluation/eval_everypart.py` : juste après `id = data['ids'][0]`, insérer
     un `np.save(results/{id}_labels.npy, mesh_group)` pour que le bridge
     (`scripts/partsam_bridge.py`) relise les labels par-face et reconstruise un
     GLB en sous-meshes part_XX.

Le script localise les fichiers par balayage + signature de contenu (on ne
présume pas d'un layout exact — le repo cloné imbrique parfois PartSAM/PartSAM/).
Chaque patch est idempotent (re-runnable : détecte l'état déjà patché et ne
double pas) et le résultat est vérifié parseable (compile()) AVANT écriture —
un fichier cassé n'est jamais écrit.

Usage:
    python patch_partsam.py <chemin_repo_PartSAM>
    # à défaut d'argument : $FABMESH_PARTSAM_DIR, sinon le dossier courant.

Sortie : lignes `[patch] …`. Exit 0 si les trois patches sont OK (appliqués ou
déjà présents), 1 si une cible est introuvable ou son motif absent (l'inférence
crasherait sur apex — on veut un signal clair pour le wizard).
"""
import os
import re
import sys

# Console Windows en cp1252 par défaut → force UTF-8 (le wizard peut appeler ce
# script sans PYTHONUTF8/PYTHONIOENCODING, et les logs contiennent des accents).
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


# ---------------------------------------------------------------------------- #
# Patches (chacun : src -> (nouveau_src, status)).
#   status ∈ {"patched", "already", "notfound"}.
# On reproduit À L'IDENTIQUE les blocs déjà validés dans le checkout courant
# pour qu'un re-run sur un clone frais donne un résultat byte-à-byte stable.
# ---------------------------------------------------------------------------- #

# --- 1. build.py : import apex top-level -> try/except LayerNorm --------------- #
_BUILD_APEX = re.compile(
    r"^from\s+apex\.normalization\s+import\s+FusedLayerNorm[ \t]*$",
    re.MULTILINE,
)
_BUILD_REPL = (
    "try:  # FabMesh: apex indispo sm_120 -> LayerNorm standard "
    "(équivalent fonctionnel)\n"
    "    from apex.normalization import FusedLayerNorm\n"
    "except Exception:\n"
    "    from torch.nn import LayerNorm as FusedLayerNorm"
)


def patch_build(src):
    # Idempotent : le fallback torch est déjà en place.
    if re.search(r"import\s+LayerNorm\s+as\s+FusedLayerNorm", src):
        return src, "already"
    new, n = _BUILD_APEX.subn(lambda _m: _BUILD_REPL, src)
    if n == 0:
        return src, "notfound"
    return new, "patched"


# --- 2. torch_utils.py : import apex interne -> try/except return -------------- #
_TU_APEX = re.compile(
    r"^([ \t]+)from\s+apex\.normalization\s+import\s+FusedLayerNorm[ \t]*$",
    re.MULTILINE,
)
# Détecte l'état déjà patché : try:/from apex/except Exception:/return.
_TU_DONE = re.compile(
    r"try:[^\n]*\n[ \t]+from\s+apex\.normalization\s+import\s+FusedLayerNorm[ \t]*\n"
    r"[ \t]+except\s+Exception\s*:[ \t]*\n[ \t]+return\b",
)


def patch_torch_utils(src):
    if _TU_DONE.search(src):
        return src, "already"

    def _repl(m):
        ind = m.group(1)
        return (
            f"{ind}try:  # FabMesh: apex indispo sm_120 -> no-op, "
            f"on garde les nn.LayerNorm standard\n"
            f"{ind}    from apex.normalization import FusedLayerNorm\n"
            f"{ind}except Exception:\n"
            f"{ind}    return"
        )

    new, n = _TU_APEX.subn(_repl, src)
    if n == 0:
        return src, "notfound"
    return new, "patched"


# --- 3. eval_everypart.py : np.save des labels par-face ----------------------- #
_EVAL_ID = re.compile(
    r"^([ \t]*)id\s*=\s*data\[['\"]ids['\"]\]\[0\][ \t]*$",
    re.MULTILINE,
)


def patch_eval(src):
    # Idempotent : le save des labels est déjà présent.
    if "_labels.npy" in src:
        return src, "already"

    def _repl(m):
        ind = m.group(1)
        # {{id}} -> {id} littéral dans la f-string cible.
        return (
            f"{m.group(0)}\n"
            f"{ind}# FabMesh: sauve les labels par-face (pré-post-processing) pour\n"
            f"{ind}# reconstruire un GLB en sous-meshes part_XX (comparaison SAMPart3D).\n"
            f"{ind}np.save(os.path.join(\"results\", f\"{{id}}_labels.npy\"), "
            f"np.asarray(mesh_group))"
        )

    new, n = _EVAL_ID.subn(_repl, src)
    if n == 0:
        return src, "notfound"
    return new, "patched"


# ---------------------------------------------------------------------------- #
# Localisation robuste des cibles (basename + signature de contenu).
# ---------------------------------------------------------------------------- #
def _is_build(path, src):
    return (
        os.path.basename(path) == "build.py"
        and "def build_sam" in src
        and "FusedLayerNorm" in src
    )


def _is_torch_utils(path, src):
    return (
        os.path.basename(path) == "torch_utils.py"
        and "def replace_with_fused_layernorm" in src
    )


def _is_eval(path, src):
    return os.path.basename(path) == "eval_everypart.py" and "mesh_group" in src


# (nom lisible, prédicat, fonction de patch).
TARGETS = [
    ("build.py:apex-layernorm", _is_build, patch_build),
    ("torch_utils.py:replace_with_fused_layernorm", _is_torch_utils, patch_torch_utils),
    ("eval_everypart.py:save-labels", _is_eval, patch_eval),
]


def _iter_py(root):
    for dirpath, _dirs, files in os.walk(root):
        # on saute .git et les caches
        if (os.sep + ".git") in dirpath or "__pycache__" in dirpath:
            continue
        for fn in files:
            if fn.endswith(".py"):
                yield os.path.join(dirpath, fn)


def _check_syntax(src, path):
    """py_compile-équivalent en mémoire : lève SyntaxError si non parseable.
    On vérifie AVANT d'écrire pour ne jamais laisser un fichier cassé."""
    compile(src, path, "exec")


def patch_repo(root):
    # meilleur statut observé par cible ("patched" > "already" > sinon problème).
    status = {name: None for name, _, _ in TARGETS}
    changed = []

    for path in _iter_py(root):
        try:
            with open(path, "r", encoding="utf-8") as f:
                src = f.read()
        except Exception:
            continue
        for name, pred, fn in TARGETS:
            try:
                if not pred(path, src):
                    continue
            except Exception:
                continue
            rel = os.path.relpath(path, root)
            try:
                new, st = fn(src)
            except Exception as e:  # regex ne doit jamais faire tomber le run
                print(f"[patch] {name}: ERREUR {type(e).__name__}: {e} ({rel})",
                      flush=True)
                st = "notfound"
                new = src
            if st == "patched":
                try:
                    _check_syntax(new, path)
                except SyntaxError as e:
                    print(f"[patch] {name}: FATAL — patch casse la syntaxe de "
                          f"{rel} ({e}); fichier NON modifié.", flush=True)
                    st = "notfound"
                else:
                    with open(path, "w", encoding="utf-8") as f:
                        f.write(new)
                    changed.append(rel)
                    print(f"[patch] {name}: PATCHED {rel}", flush=True)
            elif st == "already":
                print(f"[patch] {name}: déjà appliqué ({rel})", flush=True)
            else:
                print(f"[patch] {name}: WARN motif introuvable dans {rel}",
                      flush=True)
            # priorité de statut : ne pas écraser un OK par un problème.
            _rank = {"patched": 3, "already": 2, "notfound": 1}
            if status[name] is None or _rank[st] > _rank[status[name]]:
                status[name] = st
            break  # un fichier ne correspond qu'à une seule cible

    # ---- résumé + code de sortie ---------------------------------------- #
    print(f"[patch] résumé: {len(changed)} fichier(s) modifié(s)"
          + (": " + ", ".join(changed) if changed else ""), flush=True)
    problems = []
    for name, _, _ in TARGETS:
        st = status[name]
        if st in ("patched", "already"):
            print(f"[patch]   OK   {name} ({st})", flush=True)
        elif st == "notfound":
            print(f"[patch]   FAIL {name} (fichier trouvé, motif absent)",
                  flush=True)
            problems.append(name)
        else:  # None -> fichier jamais rencontré
            print(f"[patch]   FAIL {name} (fichier introuvable sous {root})",
                  flush=True)
            problems.append(name)

    if problems:
        print("[patch] ATTENTION: patches manquants -> l'inférence PartSAM "
              "peut crasher (apex). Cibles: " + ", ".join(problems), flush=True)
        return 1
    print("[patch] tous les patches PartSAM sont en place.", flush=True)
    return 0


def main(argv):
    if len(argv) > 1:
        root = argv[1]
    else:
        root = os.environ.get("FABMESH_PARTSAM_DIR") or "."
    root = os.path.abspath(root)
    if not os.path.isdir(root):
        print(f"[patch] FATAL: repo PartSAM introuvable: {root}",
              file=sys.stderr, flush=True)
        return 2
    print(f"[patch] repo PartSAM: {root}", flush=True)
    return patch_repo(root)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
