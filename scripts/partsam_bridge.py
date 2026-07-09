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

DÉBRUITAGE (validé sur le tank 488k tris, g=0.2 — voir AGENT_LOG) :
pipeline « v4_combo » en 3 étapes, UN SEUL query cKDTree k=12 partagé :
  1) mode kNN 1 passe (k=12, cutoff distance 3·h, vote bincount vectorisé) —
     tue le speckle 1-10 faces sans bleeding à travers les gaps d'air ;
  2) ISLAND ABSORPTION — réassigne les composantes connexes spatiales
     parasites (îlots 50-1500 faces, point fixe du filtre majoritaire) au
     label majoritaire de leurs voisins externes, composante ENTIÈRE ;
  3) lissage frontière — 1 passe mode k=8 restreinte aux faces à voisinage
     mixte (adoucit les bords crénelés de la réassignation).
Résultat mesuré : faces parasites 12.83 % → 1.73 %, fragments excédentaires
459 → 6, ~2 s CPU (vs ~9 s pour l'ancien kNN k=16 x3 scipy.stats.mode).
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


def _knn_mode_vote(lab, n_lab, dist, idx, r_cut, sub_k=None, only_faces=None):
    """Une passe de FILTRE MAJORITAIRE kNN vectorisé (bincount, ~5-10x plus
    rapide que scipy.stats.mode) avec CUTOFF de distance : un voisin à
    dist > r_cut est exclu du vote — stoppe le bleeding à travers les gaps
    d'air d'un mesh non soudé (coques internes, chenille↔caisse). `lab` doit
    être compact 0..n_lab-1. `sub_k` limite aux sub_k premiers voisins ;
    `only_faces` (masque bool) restreint la mise à jour à ces faces."""
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
    les centroïdes, robuste au mesh non soudé — face_adjacency inutilisable à
    40k composantes géométriques) et on réassigne la composante ENTIÈRE.

    Anti-antenne : la composante DOMINANTE d'un label n'est JAMAIS absorbée
    (une vraie petite partie = un label entier petit), sauf label entier
    < min_label_keep faces (poussière). Les comps non-dominantes >= size_thr
    (chenille miroir, roues symétriques) sont conservées — pas de split.
    `_pre` = (cent, area, h, dist, idx) précalculés (query cKDTree partagé).
    No-op si scipy absent ou en cas d'erreur."""
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
                log(f"absorb: fallback {pf.size} faces isolées -> "
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
        log(f"absorb: {n_absorbed} îlots absorbés (size_thr={size_thr}, "
            f"r_max={r_max:.5f}) labels {n_lab}->{n1} "
            f"en {time.time() - t0:.1f}s")
        return out
    except Exception as e:
        log(f"absorb indispo ({e}) — labels du denoise gardés")
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
    No-op si scipy absent ou en cas d'erreur."""
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
        log(f"denoise: mode kNN 1 passe (k={kq}, cutoff {r_max:.5f}) "
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
                log(f"denoise: lissage frontière k={k8} "
                    f"({int(mixed.sum())} faces mixtes)")
        out = uniq2[lab2]
        log(f"denoise total {time.time()-t0:.1f}s "
            f"(labels {n0}->{len(np.unique(out))})")
        return out
    except Exception as e:
        log(f"denoise indispo ({e}) — labels bruts")
        return labels_in


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
        # débruite : mode kNN + island absorption + lissage frontière
        labels = _clean_labels(src, labels, gran)
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
