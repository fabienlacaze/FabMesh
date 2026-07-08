"""SAMPart3D — bridge LOCAL (desktop, RTX 5080 / sm_120).

Port local de `modal_app/_sampart3d.py` : segmente un GLB en parties et
écrit un **GLB SEGMENTÉ** (sous-meshes nommés `part_00`… + couleur pleine
par partie) — même contrat que la voie cloud, mais tout tourne sur la
machine de l'utilisateur (aucun Modal, aucun réseau).

CONTRAT CLI (appelé par main.js `ipcMain.handle('mesh-segment')`) :
    <python-sampart3d> scripts/sampart3d_bridge.py <mesh_in.glb> <out.glb> [scale]
  - progress → stdout (lignes `[segment] …`, relayées à 'ai3d-progress')
  - exit 0 = succès (out.glb écrit) ; exit != 0 = échec (message sur stderr)
  - scale = granularité 0.0 (fin/bcp de parties) → 2.0 (grossier), défaut 1.0

ENVIRONNEMENT (posé par le wizard d'install / main.js) :
  - FABMESH_SAMPART3D_DIR   : racine du repo SAMPart3D cloné localement
  - FABMESH_SAMPART3D_CKPT  : chemin de ptv3-object.pth (défaut <repo>/ckpts/…)
  - (le python courant = env dédié SAMPart3D : torch cu128 sm_120 + pointops
    + spconv-cu126 + torch_scatter + trimesh + embreex + transformers,
    provisionné par le wizard — AUCUN Blender requis, rendu pur-Python)

Différence clé avec la version Modal : au lieu de `sh scripts/train.sh`,
on appelle DIRECTEMENT `python launch/train.py` / `python launch/eval.py`
(pas de dépendance bash — indispensable sur Windows packagé). Les args
reproduisent exactement ce que les .sh upstream génèrent :
  train : launch/train.py --config-file configs/{d}/{c}.py --num-gpus 1
          --options save_path=exp/{d}/{n} oid={oid} label=
  eval  : launch/eval.py  --config-file configs/{d}/{c}.py --num-gpus 1
          --options save_path=exp/{d}/{n} weight=exp/{d}/{n}/model/5000.pth
"""
import os
import re
import shutil
import subprocess
import sys
import time
import traceback

# Windows : forcer UTF-8 pour éviter les UnicodeEncodeError (cp1252) en
# relayant la sortie des sous-process.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

DATASET = "sampart3d"
CONFIG_NAME = "sampart3d-trainmlp-render16views"
WEIGHT = "last"                      # train.py écrit results/last/ (self.cfg.weight -> "last")

# Palette de couleurs distinctes (RGB 0-255) — une par partie (cyclée).
_PART_PALETTE = [
    (228, 26, 28), (55, 126, 184), (77, 175, 74), (152, 78, 163),
    (255, 127, 0), (255, 214, 0), (166, 86, 40), (247, 129, 191),
    (0, 206, 209), (128, 0, 128), (0, 128, 128), (190, 190, 60),
    (0, 90, 181), (220, 90, 90), (120, 200, 120), (150, 150, 150),
]


def log(msg):
    print(f"[segment] {msg}", flush=True)


def _repo():
    d = os.environ.get("FABMESH_SAMPART3D_DIR")
    if not d or not os.path.isdir(d):
        raise RuntimeError(
            "FABMESH_SAMPART3D_DIR non défini ou introuvable — "
            "l'environnement SAMPart3D n'est pas installé.")
    return d


def _ckpt(repo):
    c = os.environ.get("FABMESH_SAMPART3D_CKPT") \
        or os.path.join(repo, "ckpts", "ptv3-object.pth")
    if not os.path.isfile(c):
        raise RuntimeError(f"checkpoint ptv3-object.pth introuvable: {c}")
    return c


def _run(cmd, cwd, env=None, label=""):
    log(f"{label}: {' '.join(str(c) for c in cmd)}")
    proc = subprocess.Popen(
        cmd, cwd=cwd, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1, encoding="utf-8", errors="replace",
    )
    for line in proc.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
    rc = proc.wait()
    log(f"{label}: rc={rc}")
    return rc


def _safe_listdir(p):
    try:
        return os.listdir(p)
    except Exception:
        return []


def _py_launch(repo, script_rel, extra_args):
    """Commande pour lancer un script du repo avec `repo` injecté dans
    sys.path. Le Python embeddable ignore PYTHONPATH (à cause du ._pth) ;
    on passe donc par un bootstrap runpy qui insère le repo explicitement
    (indépendant du layout des dossiers)."""
    script_abs = os.path.join(repo, script_rel).replace("\\", "/")
    boot = (
        "import sys, runpy; "
        f"sys.path.insert(0, r'{repo}'); "
        f"sys.argv = [r'{script_abs}'] + {list(extra_args)!r}; "
        f"runpy.run_path(r'{script_abs}', run_name='__main__')"
    )
    return [sys.executable, "-c", boot]


def _patch_config(repo, mesh_root, render_root, ckpt):
    """Réécrit mesh_root / data_root / backbone_weight_path dans le config
    Pointcept (toutes = "" par défaut) vers nos répertoires de job."""
    cfg = os.path.join(repo, "configs", DATASET, f"{CONFIG_NAME}.py")
    if not os.path.isfile(cfg):
        log(f"WARN config introuvable: {cfg}")
        return
    with open(cfg, "r", encoding="utf-8") as f:
        src = f.read()
    repl = {
        "mesh_root": mesh_root.replace("\\", "/"),
        "data_root": render_root.replace("\\", "/"),
        "backbone_weight_path": ckpt.replace("\\", "/"),
    }
    for key, val in repl.items():
        pat = re.compile(rf'(^\s*{re.escape(key)}\s*=\s*)(["\']).*?\2',
                         re.MULTILINE)
        if pat.search(src):
            src = pat.sub(rf'\g<1>"{val}"', src)
            log(f"config: {key} -> {val}")
        else:
            log(f"WARN config: clé '{key}' introuvable")
    with open(cfg, "w", encoding="utf-8") as f:
        f.write(src)


def _pick_nearest_labels(exp_root, exp_name, weight, scale):
    """mesh_{s}.npy dont {s} est le plus proche de `scale`. Renvoie
    (chemin, echelle) ou (None, None)."""
    results_dir = os.path.join(exp_root, DATASET, exp_name, "results",
                               str(weight))
    if not os.path.isdir(results_dir):
        for root, _dirs, _files in os.walk(exp_root):
            if os.path.basename(root) == str(weight) and "results" in root:
                results_dir = root
                break
    found = []
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
    return found[0][1], None


def _build_segmented_glb(src_mesh, labels, out_path):
    """Chaque partie (label) → sous-mesh nommé part_00… + couleur pleine
    (COLOR_0, pas de texture). Renvoie le nombre de parties."""
    import numpy as np
    import trimesh

    faces = np.asarray(src_mesh.faces)
    n_faces = len(faces)
    labels = np.asarray(labels).reshape(-1).astype(np.int64)
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
        part = src_mesh.submesh([face_idx], append=True)
        if part is None or len(part.faces) == 0:
            continue
        color = _PART_PALETTE[i % len(_PART_PALETTE)]
        rgba = np.array([color[0], color[1], color[2], 255], dtype=np.uint8)
        part.visual = trimesh.visual.ColorVisuals(
            mesh=part, face_colors=np.tile(rgba, (len(part.faces), 1)))
        name = f"part_{n_parts:02d}"
        scene.add_geometry(part, geom_name=name, node_name=name)
        n_parts += 1
    if n_parts == 0:
        src_mesh.export(out_path)
        return 1
    scene.export(out_path)
    return n_parts


def main():
    if len(sys.argv) < 3:
        print("usage: sampart3d_bridge.py <mesh_in.glb> <out.glb> [scale]",
              file=sys.stderr)
        return 2
    mesh_in = sys.argv[1]
    out_glb = sys.argv[2]
    try:
        scale = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0
    except ValueError:
        scale = 1.0
    scale = max(0.0, min(2.0, scale))

    if not os.path.isfile(mesh_in):
        print(f"mesh introuvable: {mesh_in}", file=sys.stderr)
        return 2

    import numpy as np
    import trimesh

    t_total = time.time()
    repo = _repo()
    ckpt = _ckpt(repo)
    render_script = os.path.join(repo, "tools", "render_16views_local.py")

    # oid unique (évite les collisions dans exp/ entre 2 runs).
    import uuid
    oid = "fabmesh_" + uuid.uuid4().hex[:8]
    work = os.path.join(repo, "_fabmesh_work", oid)
    mesh_root = os.path.join(work, "mesh")
    render_root = os.path.join(work, "render")
    exp_root = os.path.join(repo, "exp")     # launch/*.py écrit exp/{d}/{n}/ RELATIF au cwd=repo
    for d in (mesh_root, render_root):
        os.makedirs(d, exist_ok=True)
    shutil.rmtree(os.path.join(exp_root, DATASET, oid), ignore_errors=True)

    mesh_glb = os.path.join(mesh_root, f"{oid}.glb")
    shutil.copyfile(mesh_in, mesh_glb)

    src_mesh = trimesh.load(mesh_glb, force="mesh")
    n_faces = int(len(src_mesh.faces))
    log(f"mesh: {n_faces} faces, {len(src_mesh.vertices)} vertices, scale={scale}")

    # Env commun aux sous-process python (import pointcept depuis le repo).
    env = dict(os.environ)
    env["PYTHONPATH"] = repo + os.pathsep + env.get("PYTHONPATH", "")
    env.setdefault("CUDA_VISIBLE_DEVICES", "0")
    env["PYTHONIOENCODING"] = "utf-8"   # sous-process en UTF-8 (Windows cp1252)

    try:
        # ── 0. patch config chemins ──
        _patch_config(repo, mesh_root, render_root, ckpt)

        # ── 1. rendu 16 vues (pur-Python, ray-cast — plus de Blender) ──
        log("== Étape 1/4 : rendu 16 vues (ray-cast, sans Blender) ==")
        t0 = time.time()
        render_out = os.path.join(render_root, oid)
        rc = _run(
            [sys.executable, render_script, mesh_glb, render_out],
            cwd=repo, env=env, label="render",
        )
        n_views = sum(1 for fn in _safe_listdir(render_out)
                      if fn.startswith("render_"))
        if rc != 0 or n_views == 0:
            raise RuntimeError(f"rendu 16 vues: {n_views} vue(s) produite(s) (rc={rc})")
        log(f"étape 1 ok en {time.time()-t0:.1f}s ({n_views} vues)")

        cfg_file = os.path.join(repo, "configs", DATASET, f"{CONFIG_NAME}.py")
        save_path = f"exp/{DATASET}/{oid}"

        # ── 2. optim MLP + eval interne (launch/train.py) ──
        # train.py entraîne PUIS lance self.eval() au dernier epoch (HDBSCAN +
        # vote par-face) et écrit results/last/mesh_{scale}.npy avec le modèle
        # en mémoire — pas besoin d'un eval.py séparé (qui rechargerait un poids).
        log("== Étape 2/3 : optim grouping-field MLP + eval ==")
        t0 = time.time()
        rc = _run(
            _py_launch(repo, os.path.join("launch", "train.py"),
                       ["--config-file", cfg_file, "--num-gpus", "1",
                        "--options", f"save_path={save_path}",
                        f"oid={oid}", "label="]),
            cwd=repo, env=env, label="train",
        )
        if rc != 0:
            raise RuntimeError(f"train.py a échoué (rc={rc})")
        log(f"étape 2 ok en {time.time()-t0:.1f}s")

        # ── 3. labels échelle proche → GLB segmenté ──
        log("== Étape 3/3 : construction du GLB segmenté ==")
        npy, actual = _pick_nearest_labels(exp_root, oid, WEIGHT, scale)
        if npy is None:
            raise RuntimeError("aucun mesh_{scale}.npy produit par eval")
        labels = np.load(npy).astype(np.int64).reshape(-1)
        n_parts = _build_segmented_glb(src_mesh, labels, out_glb)
        if not os.path.isfile(out_glb) or os.path.getsize(out_glb) == 0:
            raise RuntimeError("export du GLB segmenté vide")
        log(f"OK: {n_parts} parties (scale={actual}) → {out_glb} "
            f"({os.path.getsize(out_glb)} bytes) en {time.time()-t_total:.1f}s")
        return 0
    finally:
        # Nettoyage du dossier de travail + de la sortie exp (volumineuse).
        shutil.rmtree(work, ignore_errors=True)
        shutil.rmtree(os.path.join(exp_root, DATASET, oid), ignore_errors=True)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"[segment][fatal] {type(e).__name__}: {e}", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)
