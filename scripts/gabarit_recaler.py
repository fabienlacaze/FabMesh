"""Recalage GENERIQUE d'un squelette-gabarit sur un maillage — toute espece.

Generalisation de `poc_gabarit_recalage.py` (qui etait ecrit pour le couple
fourmi/araignee) : plus aucun nom d'os code en dur. Les chaines sont extraites
DU GABARIT LUI-MEME par la meme analyse topologique que celle appliquee au
rig natif detecteur :

  1. les deux squelettes sont decomposes en chaines feuille -> embranchement ;
  2. cote par suffixe de nom (_l/_r) pour le gabarit, par paires miroir pour
     le rig natif (jumeau synthetique si le rig, souvent asymetrique, n'en
     fournit pas) ;
  3. appariement d'avant en arriere par cote, surplus ecarte par longueur ;
  4. chaque chaine appariee est reechantillonnee par abscisse curviligne le
     long de l'appendice reel ;
  5. les chaines du gabarit SANS correspondant (doigts d'une main, oreilles)
     SUIVENT leur parent en bloc : l'offset relatif au parent est conserve,
     multiplie par le rapport d'echelle local ;
  6. l'axe central (racine -> tete) est recale le long de l'axe du corps.

CLI :
  python gabarit_recaler.py --gabarit build/m2m/horse.glb \
      --natif build/_esp_x_natif.glb --mesh meshes/x.glb \
      --sortie build/_esp_x_entree.glb [--image build/_esp_x_recalage.png]
"""
from __future__ import annotations

import argparse
import json
import struct
from collections import Counter

import numpy as np
from scipy.spatial import cKDTree

_NP = {5120: "<i1", 5121: "<u1", 5122: "<i2", 5123: "<u2", 5125: "<u4", 5126: "<f4"}
_N = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def lire(p):
    d = open(p, "rb").read()
    js = bb = None
    off = 12
    while off < len(d):
        lg, ty = struct.unpack_from("<II", d, off)
        bloc = d[off + 8: off + 8 + lg]
        if ty == 0x4E4F534A:
            js = json.loads(bloc)
        elif ty == 0x004E4942:
            bb = bloc
        off += 8 + lg
    return js, bb


def acc(js, bb, i):
    a = js["accessors"][i]
    n, c = a["count"], _N[a["type"]]
    bv = js["bufferViews"][a["bufferView"]]
    o = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    return np.frombuffer(bb, _NP[a["componentType"]], n * c, o).reshape(n, c)


def q2m(q):
    x, y, z, w = q
    return np.array([
        [1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
        [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
        [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]], dtype=np.float64)


def squelette(js):
    nds = js["nodes"]
    par = {}
    for ni, nd in enumerate(nds):
        for e in nd.get("children", []):
            par[e] = ni
    W = {}
    def m(i):
        if i in W:
            return W[i]
        nd = nds[i]
        if "matrix" in nd:
            L = np.array(nd["matrix"], np.float64).reshape(4, 4).T
        else:
            L = np.eye(4)
            if "rotation" in nd:
                L[:3, :3] = q2m(nd["rotation"])
            if "scale" in nd:
                L[:3, :3] = L[:3, :3] @ np.diag(nd["scale"])
            L[:3, 3] = nd.get("translation", [0, 0, 0])
        p = par.get(i, -1)
        W[i] = (m(p) if p != -1 else np.eye(4)) @ L
        return W[i]
    joints = js["skins"][0]["joints"]
    ens = set(joints)
    pj = []
    for ni in joints:
        p = par.get(ni, -1)
        while p != -1 and p not in ens:
            p = par.get(p, -1)
        pj.append(joints.index(p) if p != -1 else -1)
    noms = [nds[i].get("name", f"bone_{i}") for i in joints]
    pos = np.array([m(i)[:3, 3] for i in joints])
    return joints, noms, pj, pos


def chaines(pj):
    n = len(pj)
    enfants = [[] for _ in range(n)]
    for k, p in enumerate(pj):
        if p != -1:
            enfants[p].append(k)
    feuilles = [k for k in range(n) if not enfants[k]]
    out = []
    for f in feuilles:
        ch = [f]
        k = pj[f]
        while k != -1 and len(enfants[k]) == 1:
            ch.append(k)
            k = pj[k]
        out.append((k, list(reversed(ch))))
    return out, enfants


def longueur(pts):
    return float(np.sum(np.linalg.norm(np.diff(pts, axis=0), axis=1))) if len(pts) > 1 else 0.0


def reech(polyligne, K):
    P = np.asarray(polyligne, np.float64)
    if len(P) == 1 or longueur(P) < 1e-12:
        return np.tile(P[0], (K, 1))
    d = np.r_[0.0, np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))]
    cibles = np.linspace(0.0, d[-1], K)
    out = np.empty((K, 3))
    for c in range(3):
        out[:, c] = np.interp(cibles, d, P[:, c])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gabarit", required=True)
    ap.add_argument("--natif", required=True)
    ap.add_argument("--mesh", required=True)
    ap.add_argument("--sortie", required=True)
    ap.add_argument("--image", default=None)
    ap.add_argument("--tri", choices=["z", "y"], default="z",
                    help="ordre d'appariement des membres : z = d'avant en "
                         "arriere (quadrupedes, insectes), y = de haut en bas "
                         "(bipedes : bras avant jambes)")
    ap.add_argument("--avant", choices=["z+", "z-"], default="z+",
                    help="sens du regard du MAILLAGE cible (les gabarits "
                         "Mesh2Motion regardent tous vers z+)")
    a = ap.parse_args()

    # ── Detecteur : chaines du rig natif, paires miroir ────────────────────
    njs, _ = lire(a.natif)
    _, _, npj, npos = squelette(njs)
    ch_nat, _ = chaines(npj)
    brutes = [{"points": npos[ch], "A": npos[ch][0], "E": npos[ch][-1],
               "long": longueur(npos[ch])} for _, ch in ch_nat]
    ech_x = npos[:, 0].max() - npos[:, 0].min()
    lat_l = [b for b in brutes if b["E"][0] > 0.08 * ech_x]
    lat_r = [b for b in brutes if b["E"][0] < -0.08 * ech_x]
    centraux = [b for b in brutes if abs(b["E"][0]) <= 0.08 * ech_x]

    def miroir(p):
        return np.array([-p[0], p[1], p[2]])

    def d_paire(x, y):
        return (np.linalg.norm(miroir(x["A"]) - y["A"])
                + np.linalg.norm(miroir(x["E"]) - y["E"]))

    paires, pris_r = [], set()
    for ga in sorted(lat_l, key=lambda b: -b["A"][2]):
        cands = [(d_paire(ga, dr), j) for j, dr in enumerate(lat_r) if j not in pris_r]
        if not cands:
            break
        d0, j0 = min(cands)
        if d0 <= min(d_paire(g2, lat_r[j0]) for g2 in lat_l) + 1e-9:
            pris_r.add(j0)
            paires.append((ga, lat_r[j0]))
    en_paire = set()
    for x, y in paires:
        en_paire.add(id(x)); en_paire.add(id(y))
    long_max = max((b["long"] for b in brutes), default=1.0)
    for b in lat_l + lat_r:
        if id(b) in en_paire or b["long"] < 0.30 * long_max:
            continue
        jum = {"points": np.array([miroir(p) for p in b["points"]]),
               "A": miroir(b["A"]), "E": miroir(b["E"]), "long": b["long"]}
        paires.append((b, jum) if b["E"][0] > 0 else (jum, b))
    F = 1.0 if a.avant == "z+" else -1.0
    if a.tri == "z":
        paires.sort(key=lambda p: -F * (p[0]["A"][2] + p[1]["A"][2]))
    else:
        paires.sort(key=lambda p: -(p[0]["A"][1] + p[1]["A"][1]))
    arrieres = [b for b in centraux if F * (b["E"] - b["A"])[2] < 0]
    print("  natif : %d chaines, %d paires laterales, %d centrales arriere"
          % (len(brutes), len(paires), len(arrieres)))

    # ── Gabarit : chaines par nom (_l/_r), centrales par direction ─────────
    gjs, _ = lire(a.gabarit)
    _, gn, gpj, gpos = squelette(gjs)
    ch_gab, enfants_g = chaines(gpj)

    def cote_nom(ch):
        nom = gn[ch[-1]].lower()
        if nom.endswith("_l") or "_l_" in nom or nom.endswith("_l_leaf"):
            return "l"
        if nom.endswith("_r") or "_r_" in nom or nom.endswith("_r_leaf"):
            return "r"
        x = float(np.mean(gpos[ch][:, 0]))
        ecart = gpos[:, 0].max() - gpos[:, 0].min()
        if x > 0.06 * ecart:
            return "l"
        if x < -0.06 * ecart:
            return "r"
        return "c"

    gab_l, gab_r, gab_c = [], [], []
    for embr, ch in ch_gab:
        d = {"ch": ch, "embr": embr, "long": longueur(gpos[ch]),
             "A": gpos[ch][0], "E": gpos[ch][-1]}
        {"l": gab_l, "r": gab_r, "c": gab_c}[cote_nom(ch)].append(d)
    for lst in (gab_l, gab_r):
        if a.tri == "z":
            lst.sort(key=lambda d: -d["A"][2])
        else:
            lst.sort(key=lambda d: -d["A"][1])
    print("  gabarit : %d chaines (g %d / d %d / centrales %d)"
          % (len(ch_gab), len(gab_l), len(gab_r), len(gab_c)))

    # ── Base : recalage boite par axe, puis ecrasement membre par membre ───
    mjs, mbb = lire(a.mesh)
    V = acc(mjs, mbb, mjs["meshes"][0]["primitives"][0]["attributes"]["POSITION"]).astype(np.float64)
    lo_a, hi_a = V.min(0), V.max(0)
    lo_g, hi_g = gpos.min(0), gpos.max(0)
    S = (hi_a - lo_a) / np.maximum(hi_g - lo_g, 1e-9) * 0.94
    p_fit = (gpos - (lo_g + hi_g) / 2) * S + (lo_a + hi_a) / 2
    p_avant = p_fit.copy()

    # membres apparies : reechantillonnage curviligne. Le SURPLUS de chaines
    # du gabarit est ecarte par LONGUEUR (jamais par position).
    substantielle = lambda d: d["long"] >= 0.25 * max((x["long"] for x in gab_l + gab_r), default=1.0)
    for k_cote, lst in ((0, gab_l), (1, gab_r)):
        subs = [d for d in lst if substantielle(d)]
        while len(subs) > len(paires):
            subs.pop(min(range(len(subs)), key=lambda i: subs[i]["long"]))
        for d, paire in zip(subs, paires):
            p_fit[d["ch"]] = reech(paire[k_cote]["points"], len(d["ch"]))

    # centrales arriere (queue) le long de l'appendice arriere reel
    g_arr = [d for d in gab_c if (d["E"] - d["A"])[2] < -0.05 * (hi_g[2] - lo_g[2])]
    if g_arr and arrieres:
        cible = max(arrieres, key=lambda b: b["long"])
        d = max(g_arr, key=lambda d: d["long"])
        p_fit[d["ch"]] = reech(cible["points"], len(d["ch"]))

    # chaines non recalees : elles SUIVENT leur embranchement (offset conserve
    # a l'echelle boite) — c'est le cas des doigts, oreilles, feuilles
    recalees = set()
    for k_cote, lst in ((0, gab_l), (1, gab_r)):
        subs = [d for d in lst if substantielle(d)]
        while len(subs) > len(paires):
            subs.pop(min(range(len(subs)), key=lambda i: subs[i]["long"]))
        for d in subs:
            recalees.update(d["ch"])
    if g_arr and arrieres:
        recalees.update(max(g_arr, key=lambda d: d["long"])["ch"])
    for embr, ch in ch_gab:
        if recalees.isdisjoint(ch) and embr != -1:
            delta = p_fit[embr] - p_avant[embr]
            for k in ch:
                p_fit[k] = p_avant[k] + delta

    dedans = np.all((p_fit >= lo_a - 1e-6) & (p_fit <= hi_a + 1e-6), axis=1)
    print("  os dans la boite : %d / %d" % (int(dedans.sum()), len(gn)))

    # ── Image de controle ──────────────────────────────────────────────────
    if a.image:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        rng = np.random.default_rng(0)
        sel = rng.choice(len(V), min(len(V), 45000), replace=False)
        fig, axes = plt.subplots(1, 2, figsize=(13, 5.4), facecolor="#0d1117")
        for ax, (ti, x_, y_) in zip(axes, [("profil (Z,Y)", 2, 1), ("dessus (X,Z)", 0, 2)]):
            ax.set_facecolor("#0d1117")
            ax.scatter(V[sel, x_], V[sel, y_], s=0.3, c="#3a4656", alpha=0.4, linewidths=0)
            ax.scatter(p_avant[:, x_], p_avant[:, y_], s=14, c="#ff6b6b", label="boîte")
            ax.scatter(p_fit[:, x_], p_fit[:, y_], s=14, c="#69db7c", label="par membre")
            ax.set_title(ti, color="#e6edf3", fontsize=11)
            ax.set_aspect("equal"); ax.axis("off")
        axes[0].legend(frameon=False, labelcolor="#e6edf3", fontsize=10, loc="lower left")
        fig.tight_layout()
        fig.savefig(a.image, dpi=100, facecolor="#0d1117")
        print("  image : %s" % a.image)

    # ── GLB d'entree pour SkinTokens ───────────────────────────────────────
    Nrm_attr = mjs["meshes"][0]["primitives"][0]["attributes"].get("NORMAL")
    if Nrm_attr is not None:
        Nrm = acc(mjs, mbb, Nrm_attr).astype(np.float32)
    else:
        Nrm = np.zeros((len(V), 3), np.float32)
        Nrm[:, 1] = 1.0
    IDX = acc(mjs, mbb, mjs["meshes"][0]["primitives"][0]["indices"]).astype(np.uint32).reshape(-1)

    arbre = cKDTree(p_fit)
    _, plus_proche = arbre.query(V, k=1)
    J4 = np.zeros((len(V), 4), np.uint8)
    J4[:, 0] = plus_proche.astype(np.uint8)
    occ = Counter(plus_proche.tolist())
    orphelins = [k for k in range(len(gn)) if occ.get(k, 0) == 0]
    if orphelins:
        arbre_v = cKDTree(V)
        for k in orphelins:
            _, iv = arbre_v.query(p_fit[k], k=60)
            J4[iv, 0] = k
        print("  orphelins repeches : %d" % len(orphelins))

    bin_out = bytearray()
    vues, accs = [], []

    def pousse(donnees, ctype, atype, cible=None, norm=False, minmax=False):
        nonlocal bin_out
        while len(bin_out) % 4:
            bin_out += b"\0"
        off = len(bin_out)
        raw = donnees.tobytes()
        bin_out += raw
        vues.append({"buffer": 0, "byteOffset": off, "byteLength": len(raw),
                     **({"target": cible} if cible else {})})
        d = {"bufferView": len(vues)-1, "byteOffset": 0, "componentType": ctype,
             "count": len(donnees), "type": atype, **({"normalized": True} if norm else {})}
        if minmax:
            d["min"] = [float(x) for x in donnees.min(0)]
            d["max"] = [float(x) for x in donnees.max(0)]
        accs.append(d)
        return len(accs) - 1

    a_pos = pousse(V.astype(np.float32), 5126, "VEC3", 34962, minmax=True)
    a_nrm = pousse(Nrm, 5126, "VEC3", 34962)
    a_idx = pousse(IDX.reshape(-1, 1), 5125, "SCALAR", 34963)
    a_j = pousse(J4, 5121, "VEC4", 34962)
    w = np.zeros((len(V), 4), np.uint8); w[:, 0] = 255
    a_w = pousse(w, 5121, "VEC4", 34962, norm=True)
    IBM = np.stack([np.eye(4) for _ in gn])
    for k in range(len(gn)):
        IBM[k][:3, 3] = -p_fit[k]
    a_ibm = pousse(IBM.astype(np.float32).transpose(0, 2, 1).reshape(len(gn), 16), 5126, "MAT4")

    noeuds = [{"name": "Armature", "children": []}]
    for k in range(len(gn)):
        pjt = gpj[k]
        t_loc = p_fit[k] - (p_fit[pjt] if pjt != -1 else 0.0)
        nd = {"name": gn[k], "translation": [float(x) for x in t_loc]}
        enf = [i + 1 for i in range(len(gn)) if gpj[i] == k]
        if enf:
            nd["children"] = enf
        noeuds.append(nd)
    for k in range(len(gn)):
        if gpj[k] == -1:
            noeuds[0]["children"].append(k + 1)
    i_mesh = len(noeuds)
    noeuds.append({"name": "maillage", "mesh": 0, "skin": 0})

    js_out = {
        "asset": {"version": "2.0", "generator": "FabMesh gabarit_recaler"},
        "scene": 0, "scenes": [{"nodes": [0, i_mesh]}], "nodes": noeuds,
        "meshes": [{"primitives": [{"attributes": {"POSITION": a_pos, "NORMAL": a_nrm,
                                                   "JOINTS_0": a_j, "WEIGHTS_0": a_w},
                                    "indices": a_idx}]}],
        "skins": [{"joints": list(range(1, len(gn) + 1)),
                   "inverseBindMatrices": a_ibm, "skeleton": 1}],
        "accessors": accs, "bufferViews": vues,
        "buffers": [{"byteLength": len(bin_out)}],
    }
    j = json.dumps(js_out, separators=(",", ":")).encode()
    j += b" " * ((4 - len(j) % 4) % 4)
    b = bytes(bin_out) + b"\0" * ((4 - len(bin_out) % 4) % 4)
    with open(a.sortie, "wb") as f:
        f.write(b"glTF" + struct.pack("<II", 2, 12 + 8 + len(j) + 8 + len(b)))
        f.write(struct.pack("<I", len(j)) + b"JSON" + j)
        f.write(struct.pack("<I", len(b)) + b"BIN\0" + b)
    import os
    print("  ecrit : %s (%.1f Mo)" % (a.sortie, os.path.getsize(a.sortie) / 1048576))


if __name__ == "__main__":
    main()
