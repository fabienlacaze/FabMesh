"""PartSAM — bridge LOCAL (desktop, RTX 5080 / sm_120).

Découpe un mesh en PARTIES avec **PartSAM** (feedforward, ~40 s/mesh, MIT) —
remplaçant rapide de SAMPart3D (optim par-mesh ~4 min). Écrit un **GLB
SEGMENTÉ** (sous-meshes nommés part_00… + couleur pleine par partie), même
contrat que la voie SAMPart3D → viewer explode + add-version inchangés.

CONTRAT CLI (appelé par main.js `ipcMain.handle('mesh-segment')`) :
    <python-partsam> scripts/partsam_bridge.py <mesh_in> <out.glb> [granularity]
  - progress → stdout (lignes `[partsam] …`, relayées à 'ai3d-progress')
  - exit 0 = succès (out.glb écrit) ; exit != 0 = échec (message sur stderr)
  - granularity 0.0 (grossier, ~10 parties propres) → 1.0 (fin, ~45 parties).
    Mappée sur (iou_threshold, nms_threshold) de PartSAM.

ENVIRONNEMENT (posé par le wizard d'install / main.js) :
  - FABMESH_PARTSAM_DIR : racine du repo PartSAM cloné (contient evaluation/,
    configs/, pretrained/model.safetensors, PartSAM/, partfield/, utils/).
  - le python courant = env dédié (torch cu128 sm_120 + torkit3d + pointops +
    partfield PVCNN + deps), provisionné par le wizard. AUCUN apex, AUCUN Blender.

Détail : PartSAM est natif-3D feedforward → PAS de rendu multi-vues ni de SAM 2D.
On lance `evaluation/eval_everypart.py` (hydra) sur un dossier ne contenant que
notre mesh, avec des overrides (granularité + batch=4 pour tenir en 16 Go +
graph_cut=False pour les gros meshes), puis on relit results/{id}_labels.npy et
on reconstruit le GLB en sous-meshes.
"""
import os
import shutil
import subprocess
import sys
import time
import traceback

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

_PART_PALETTE = [
    (228, 26, 28), (55, 126, 184), (77, 175, 74), (152, 78, 163),
    (255, 127, 0), (255, 214, 0), (166, 86, 40), (247, 129, 191),
    (0, 206, 209), (128, 0, 128), (0, 128, 128), (190, 190, 60),
    (0, 90, 181), (220, 90, 90), (120, 200, 120), (150, 150, 150),
]


def log(msg):
    print(f"[partsam] {msg}", flush=True)


def _repo():
    d = os.environ.get("FABMESH_PARTSAM_DIR")
    if not d or not os.path.isdir(d):
        raise RuntimeError(
            "FABMESH_PARTSAM_DIR non défini ou introuvable — "
            "l'environnement PartSAM n'est pas installé.")
    return d


def _granularity_to_thresholds(g):
    """g 0.0 (grossier) → 1.0 (fin). Interpole iou (0.65→0.5, plus bas = plus
    de masques) et nms (0.3→0.65, plus haut = moins de suppression)."""
    g = max(0.0, min(1.0, g))
    iou = 0.65 - 0.15 * g
    nms = 0.30 + 0.35 * g
    return round(iou, 3), round(nms, 3)


def _run(cmd, cwd, env):
    log(f"eval: {' '.join(str(c) for c in cmd)}")
    proc = subprocess.Popen(
        cmd, cwd=cwd, env=env, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, text=True, bufsize=1,
        encoding="utf-8", errors="replace")
    for line in proc.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
    return proc.wait()


def _build_segmented_glb(src_mesh, labels, out_path):
    import numpy as np
    import trimesh
    faces = np.asarray(src_mesh.faces)
    labels = np.asarray(labels).reshape(-1).astype(np.int64)
    if labels.shape[0] != len(faces):
        n = min(labels.shape[0], len(faces))
        labels = labels[:n]
    scene = trimesh.Scene()
    uniq = sorted(set(int(x) for x in labels.tolist()))
    # Mesh TEXTURÉ : on GARDE la texture sur chaque partie (submesh préserve
    # UV + matériau) et on PARTAGE le matériau source → l'atlas n'est pas
    # dupliqué N fois dans le GLB. Le viewer applique les couleurs de parties
    # à la volée (toggle couleurs ↔ texture). Sinon (pas de texture) : on bake
    # une couleur pleine par partie (fallback).
    src_vis = getattr(src_mesh, "visual", None)
    src_uv = getattr(src_vis, "uv", None)
    has_tex = src_uv is not None and len(src_uv) == len(src_mesh.vertices)
    src_mat = getattr(src_vis, "material", None) if has_tex else None
    n_parts = 0
    for i, lab in enumerate(uniq):
        fidx = np.where(labels == lab)[0]
        if fidx.size == 0:
            continue
        part = src_mesh.submesh([fidx], append=True)
        if part is None or len(part.faces) == 0:
            continue
        if has_tex:
            # NE PAS partager le matériau source : trimesh droppe alors les
            # NORMAL à l'export (→ rendu PBR noir). Le submesh garde sa
            # TextureVisuals (UV) ; les images texture sont dédupliquées à
            # l'export de toute façon (même taille). On force le calcul des
            # normales pour qu'elles soient bien exportées.
            try:
                _ = part.vertex_normals
            except Exception:
                pass
        else:
            c = _PART_PALETTE[i % len(_PART_PALETTE)]
            rgba = np.array([c[0], c[1], c[2], 255], dtype=np.uint8)
            part.visual = trimesh.visual.ColorVisuals(
                mesh=part, face_colors=np.tile(rgba, (len(part.faces), 1)))
        nm = f"part_{n_parts:02d}"
        scene.add_geometry(part, geom_name=nm, node_name=nm)
        n_parts += 1
    if n_parts == 0:
        src_mesh.export(out_path)
        return 1
    scene.export(out_path)
    return n_parts


def main():
    if len(sys.argv) < 3:
        print("usage: partsam_bridge.py <mesh_in> <out.glb> [granularity]",
              file=sys.stderr)
        return 2
    mesh_in, out_glb = sys.argv[1], sys.argv[2]
    try:
        gran = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0
    except ValueError:
        gran = 0.0
    if not os.path.isfile(mesh_in):
        print(f"mesh introuvable: {mesh_in}", file=sys.stderr)
        return 2

    import uuid
    import numpy as np
    import trimesh

    t0 = time.time()
    repo = _repo()
    iou, nms = _granularity_to_thresholds(gran)
    log(f"granularité={gran:.2f} -> iou={iou} nms={nms}")

    stem = "fabmesh_" + uuid.uuid4().hex[:8]
    in_dir = os.path.join(repo, "_fabmesh_in", stem)
    res_dir = os.path.join(repo, "results")
    os.makedirs(in_dir, exist_ok=True)
    os.makedirs(res_dir, exist_ok=True)
    shutil.copyfile(mesh_in, os.path.join(in_dir, f"{stem}.glb"))

    env = dict(os.environ)
    env["PYTHONPATH"] = repo + os.pathsep + env.get("PYTHONPATH", "")
    env.setdefault("CUDA_VISIBLE_DEVICES", "0")
    env["PYTHONIOENCODING"] = "utf-8"

    labels_npy = os.path.join(res_dir, f"{stem}_labels.npy")
    try:
        log("== PartSAM (feedforward) ==")
        # eval_everypart.py fait sys.path.append(".") + imports relatifs -> cwd=repo.
        # hydra config_dir "../configs" est relatif au fichier (evaluation/).
        cmd = [
            sys.executable, os.path.join("evaluation", "eval_everypart.py"),
            f"dataset.root_dir={in_dir.replace(os.sep, '/')}",
            "eval_params.use_graph_cut=False",
            "eval_params.batch_size=4",           # 16 Go: cdist OOM au-delà
            f"eval_params.iou_threshold={iou}",
            f"eval_params.nms_threshold={nms}",
        ]
        rc = _run(cmd, cwd=repo, env=env)
        if rc != 0 or not os.path.isfile(labels_npy):
            raise RuntimeError(f"eval_everypart a échoué (rc={rc}) / labels absents")

        labels = np.load(labels_npy).astype(np.int64).reshape(-1)
        src = trimesh.load(mesh_in, force="mesh")
        n_parts = _build_segmented_glb(src, labels, out_glb)
        if not os.path.isfile(out_glb) or os.path.getsize(out_glb) == 0:
            raise RuntimeError("export du GLB segmenté vide")
        log(f"OK: {n_parts} parties → {out_glb} "
            f"({os.path.getsize(out_glb)} bytes) en {time.time()-t0:.1f}s")
        return 0
    finally:
        shutil.rmtree(in_dir, ignore_errors=True)
        for suf in (f"{stem}_labels.npy", f"{stem}.ply"):
            try:
                os.remove(os.path.join(res_dir, suf))
            except OSError:
                pass


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"[partsam][fatal] {type(e).__name__}: {e}", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)
