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

DÉBRUITAGE (validé sur le tank 488k tris, g=0.2 ET g=1.0 — voir AGENT_LOG) :
pipeline « v6_snap » en 3 étapes, UN SEUL query cKDTree k=12 partagé :
  1) mode kNN 1 passe (k=12, cutoff distance 3·h, vote bincount vectorisé) —
     tue le speckle 1-10 faces sans bleeding à travers les gaps d'air ;
  2) ISLAND ABSORPTION — réassigne les composantes connexes spatiales
     parasites (îlots 50-1500 faces, point fixe du filtre majoritaire) au
     label majoritaire de leurs voisins externes, composante ENTIÈRE ;
     + 2bis) absorption des LABELS ÉPARPILLÉS entiers (dominance < 45 %) ;
  3) SNAP CREASE-AWARE des frontières — relaxation itérée pondérée
     exp(-(θ/σ)²)·aire restreinte à une bande autour des frontières : la
     coupe MIGRE vers les plis géométriques (bord de tourelle, jupe de
     caisse) au lieu de serpenter en Voronoï du nuage de points PartSAM.
Résultat mesuré (g=0.2, 200k pts) : faces parasites 12.83 % → 1.31 %,
fragments excédentaires 459 → 4, frontière-sur-pli (normales brutes)
0.51 → 0.67 (angle frontière moyen 33.8° → 43.5°), ~1.6 s CPU total.
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
    """g 0.0 (grossier) → 1.0 (fin). Interpole iou (0.65→0.55, plus bas = plus
    de masques) et nms (0.3→0.55, plus haut = moins de suppression).
    Mapping TEMPÉRÉ (mesuré, tank g=1.0) : l'ancien plafond (iou 0.5/nms 0.65)
    acceptait 51 labels dont 21 minuscules → mosaïque ; 0.55/0.55 donne
    ~27-29 parties fines mais propres."""
    g = max(0.0, min(1.0, g))
    iou = 0.65 - 0.10 * g
    nms = 0.30 + 0.25 * g
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


def _absorb_scattered(labels, cent, dist, idx, r_max,
                      dom_thr=0.45, dust=120):
    """Absorbe les LABELS ÉPARPILLÉS entiers : un label dont la composante
    connexe dominante représente < dom_thr de ses faces est du mouchetis
    multi-fragments, pas une pièce (une vraie pièce est compacte ; les pièces
    miroir ~2 composantes égales ont une dominance ~0.5 ≥ dom_thr). Idem les
    labels-poussière < dust faces. Faces réassignées au plus proche label
    conservé. No-op si scipy absent, en cas d'erreur, ou si tout est éparpillé."""
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
        log(f"scatter: {int(scattered.sum())} labels éparpillés/poussière "
            f"absorbés (dominance<{dom_thr} ou <{dust} faces) "
            f"{n_lab}->{len(np.unique(out))}")
        return out
    except Exception as e:
        log(f"scatter indispo ({e}) — labels gardés")
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
    le garder PAIR."""
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
    log(f"snap: {int((lab[B] != before).sum())} faces migrées vers les plis "
        f"(bande {B.size}, σ={sigma_deg:.0f}°, {it + 1} iters) "
        f"en {time.time() - t0:.2f}s")
    return lab, True


def _clean_labels(mesh, labels, gran=0.0):
    """Débruite les labels par-face — pipeline « v6_snap » complet, un seul
    query cKDTree k=12 partagé par les trois étapes :
      1) mode kNN 1 passe (k=12, cutoff 3·h, bincount) — tue le speckle 1-10
         faces et fiabilise la dominance des composantes pour l'absorption ;
      2) ISLAND ABSORPTION — résorbe les îlots moyens 50-1500 faces (point
         fixe du mode) par réassignation de composantes entières ;
         + 2bis) absorption des LABELS ÉPARPILLÉS entiers ;
      3) SNAP CREASE-AWARE — relaxation pondérée exp(-(θ/σ)²)·aire dans une
         bande autour des frontières : la coupe migre vers les plis
         géométriques (remplace l'ancien lissage k=8 crease-blind, qui
         déferait le snap). Post-condition : 0 label perdu, sinon revert.
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
        # --- 2bis) absorption des LABELS ÉPARPILLÉS : un label dont la
        # composante dominante < 45 % de ses faces n'est pas une vraie pièce
        # (une pièce est spatialement compacte ; les pièces MIROIR type
        # chenilles ~50 % restent au-dessus du seuil), idem poussière
        # < 120 faces. L'anti-antenne de l'étape 2 protège leur composante
        # dominante — cette étape retire le label ENTIER. ---
        labels2 = _absorb_scattered(labels2, cent, dist, idx, r_max)
        # --- 3) snap crease-aware : la frontière migre vers les plis ---
        labels2 = np.asarray(labels2).reshape(-1).astype(np.int64)
        uniq2, lab2 = np.unique(labels2, return_inverse=True)
        lab2 = lab2.astype(np.int64)
        n2 = len(uniq2)
        out = labels2
        try:
            fn = np.asarray(mesh.face_normals, dtype=np.float64)
            lab2, ok3 = _crease_snap(
                lab2, n2, fn, cent, area, dist, idx, r_max)
            if ok3:
                out = uniq2[lab2]
                if len(np.unique(out)) != n2:   # post-condition défensive
                    log("snap: label perdu — revert étape 3")
                    out = labels2
        except Exception as e:
            log(f"snap indispo ({e}) — labels étape 2 gardés")
            out = labels2
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
            # 2x le nuage de points (100k -> 200k) : les labels par-face sont
            # peints par plus-proche-point → un nuage plus dense = frontières
            # de coupe 2x plus fines (mesuré : parasites 1.73->1.34 %,
            # fragments 6->4, +45 s de runtime, pas d'OOM à batch=4/16 Go).
            "num_points=200000",
        ]
        rc = _run(cmd, cwd=repo, env=env)
        if rc != 0 or not os.path.isfile(labels_npy):
            raise RuntimeError(f"eval_everypart a échoué (rc={rc}) / labels absents")

        labels = np.load(labels_npy).astype(np.int64).reshape(-1)
        src = trimesh.load(mesh_in, force="mesh")
        # débruite : mode kNN + island absorption + snap crease-aware
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
