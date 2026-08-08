"""Etape 2 — recalage PAR MEMBRE du gabarit sur le maillage.

Le recalage de l'etape 0 (boite englobante par axe) laissait trois defauts
mesures : antennes peau-liees a des pattes, abdomen debordant sur une chaine
de patte (21,9 % contre 3,0 % de l'autre cote), cambrure excessive en
mouvement. Cause commune : les os du gabarit ne sont pas DANS les appendices
de la fourmi, seulement dans son volume global.

METHODE
Le rig NATIF SkinTokens de la fourmi (passe 1, symetrise) connait les vraies
articulations : il sert de DETECTEUR. On en extrait les chaines d'appendices
(feuille -> premier embranchement), on les classe geometriquement (antenne /
patte / abdomen / mandibule, cote par signe de X), puis on apparie les chaines
du gabarit d'avant en arriere par cote et on REECHANTILLONNE chaque chaine du
gabarit par abscisse curviligne le long de l'appendice detecte.

DECISION D'APPARIEMENT (fourmi) : l'araignee a 4 paires de pattes, la fourmi
3 + les antennes. La paire AVANT (leg_a) va sur les ANTENNES — chaque
appendice de la fourmi recoit ainsi sa propre chaine du gabarit, et les
antennes bougeront comme les pattes avant de l'araignee (dont la gestuelle
en est proche) au lieu d'etre des passagers clandestins d'une patte.

Sortie : build/_etape2_entree.glb (meme format que l'etape 0, positions
recalees par membre) + build/_etape2_recalage.png (avant/apres).
"""
from __future__ import annotations

import json
import struct
import sys
from collections import Counter

import numpy as np

NATIF = "build/_ant_sym.glb"                 # rig natif symetrise = detecteur
SPIDER = "build/m2m/spider.glb"
ANT = "meshes/ant_trellis2_native_1781901851036_rigged_skintokens_1786199629367.glb"
SORTIE = "build/_etape2_entree.glb"
IMAGE = "build/_etape2_recalage.png"

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
    """joints, noms, parent_par_joint, positions monde."""
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


def chaines_appendices(pj):
    """Chaines feuille -> premier embranchement (indices de joints, de
    l'attache vers la feuille), + l'index du noeud d'embranchement."""
    n = len(pj)
    enfants = [[] for _ in range(n)]
    for k, p in enumerate(pj):
        if p != -1:
            enfants[p].append(k)
    feuilles = [k for k in range(n) if not enfants[k]]
    chaines = []
    for f in feuilles:
        ch = [f]
        k = pj[f]
        while k != -1 and len(enfants[k]) == 1:
            ch.append(k)
            k = pj[k]
        chaines.append((k, list(reversed(ch))))     # (embranchement, attache->feuille)
    return chaines


def reechantillonner(polyligne, K):
    """K points par abscisse curviligne le long d'une polyligne (M,3)."""
    P = np.asarray(polyligne, np.float64)
    if len(P) == 1:
        return np.tile(P[0], (K, 1))
    d = np.r_[0.0, np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))]
    if d[-1] < 1e-12:
        return np.tile(P[0], (K, 1))
    cibles = np.linspace(0.0, d[-1], K)
    out = np.empty((K, 3))
    for c in range(3):
        out[:, c] = np.interp(cibles, d, P[:, c])
    return out


# ── 1. Detecteur : rig natif de la fourmi ─────────────────────────────────
nj, nn, npj, npos = squelette(lire(NATIF)[0])
corps_lo, corps_hi = npos.min(0), npos.max(0)
centre_y = float(np.median(npos[:, 1]))
ch_natives = chaines_appendices(npj)
print("  rig natif : %d os, %d chaines d'appendices" % (len(nj), len(ch_natives)))

# Premiere version : classement par seuils geometriques (patte/antenne/
# abdomen). ECHEC constate : 5 « pattes » a droite, 3 a gauche, aucune
# antenne — les seuils sont fragiles et l'asymetrie du rig natif (19 os a
# gauche, 15 a droite) contamine la detection.
#
# Version robuste : DETECTION PAR PAIRES MIROIR. Un appendice lateral n'est
# retenu que si un appendice de l'autre cote lui repond en miroir (attache ET
# extremite proches apres reflexion en X, appariement mutuellement le plus
# proche). Cela filtre les chaines aberrantes d'office et garantit un
# appariement symetrique — condition d'une demarche non boiteuse. Les chaines
# CENTRALES (|X| faible aux deux bouts) sont classees axiales : vers l'arriere
# = abdomen, vers l'avant = tete/mandibule centrale.
brutes = []
for embr, ch in ch_natives:
    pts = npos[ch]
    brutes.append({"points": pts, "A": pts[0], "E": pts[-1],
                   "long": float(np.sum(np.linalg.norm(np.diff(pts, axis=0), axis=1)))})
ech_x = corps_hi[0] - corps_lo[0]
lat_l = [b for b in brutes if b["E"][0] > 0.08 * ech_x]
lat_r = [b for b in brutes if b["E"][0] < -0.08 * ech_x]
centraux = [b for b in brutes if abs(b["E"][0]) <= 0.08 * ech_x]

def miroir(p):
    return np.array([-p[0], p[1], p[2]])

def d_paire(a, b):
    return (np.linalg.norm(miroir(a["A"]) - b["A"])
            + np.linalg.norm(miroir(a["E"]) - b["E"]))

paires = []
pris_r = set()
for ga in sorted(lat_l, key=lambda b: -b["A"][2]):
    if not lat_r:
        break
    cands = [(d_paire(ga, dr), j) for j, dr in enumerate(lat_r) if j not in pris_r]
    if not cands:
        break
    d0, j0 = min(cands)
    # reciprocite : ga doit aussi etre le plus proche de lat_r[j0]
    d1 = min(d_paire(g2, lat_r[j0]) for g2 in lat_l)
    if d0 <= d1 + 1e-9:
        pris_r.add(j0)
        paires.append((ga, lat_r[j0]))
# Chaines laterales SANS jumeau : le rig natif a un nombre IMPAIR de chaines
# (13 — son asymetrie 19/15 se paie ici aussi). Constate : les pattes arriere
# restaient sans os. On fabrique donc un jumeau SYNTHETIQUE par miroir de la
# chaine elle-meme : couverture symetrique garantie, geometrie reelle d'un
# cote, reflechie de l'autre. Seules les chaines substantielles y ont droit
# (> 30 % de la plus longue), pour ne pas symetriser du bruit.
en_paire = set()
for ga, dr in paires:
    en_paire.add(id(ga)); en_paire.add(id(dr))
long_max = max((b["long"] for b in brutes), default=1.0)
for b in lat_l + lat_r:
    if id(b) in en_paire or b["long"] < 0.30 * long_max:
        continue
    jumeau = {"points": np.array([miroir(p) for p in b["points"]]),
              "A": miroir(b["A"]), "E": miroir(b["E"]), "long": b["long"]}
    paires.append((b, jumeau) if b["E"][0] > 0 else (jumeau, b))
    en_paire.add(id(b))

paires.sort(key=lambda p: -(p[0]["A"][2] + p[1]["A"][2]))     # avant d'abord

# 6 paires pour 4 emplacements leg_a..d : le tri « avant d'abord » seul
# gardait antenne + mandibules + 2 pattes et JETAIT les pattes arriere
# (constate sur l'image de controle). On separe donc :
#   - paires COURTES (< 35 % de la plus longue) a l'avant -> mandibules
#     (chaine `teeth` du gabarit) ;
#   - paires SUBSTANTIELLES, d'avant en arriere -> leg_a..d ; s'il en reste
#     plus de 4, on ecarte les plus courtes, jamais les plus en arriere.
def long_paire(p):
    return 0.5 * (p[0]["long"] + p[1]["long"])
paires_courtes = [p for p in paires if long_paire(p) < 0.35 * long_max]
paires_sub = [p for p in paires if long_paire(p) >= 0.35 * long_max]
# suppression par INDEX : list.remove compare par ==, ce qui broadcast les
# tableaux numpy contenus dans les paires et leve une ValueError
while len(paires_sub) > 4:
    paires_sub.pop(min(range(len(paires_sub)), key=lambda i: long_paire(paires_sub[i])))
paire_mand = paires_courtes[0] if paires_courtes else None
abdos = [{"points": b["points"]} for b in centraux
         if (b["E"] - b["A"])[2] < 0]
print("  paires : %d substantielles (leg_a..d), %d courtes (mandibules), centrales arriere %d"
      % (len(paires_sub), len(paires_courtes), len(abdos)))
paires = paires_sub

# ── 2. Gabarit : chaines par nom ──────────────────────────────────────────
gjs, _ = lire(SPIDER)
gj, gn, gpj, gpos = squelette(gjs)
idx = {n: k for k, n in enumerate(gn)}

def chaine_gabarit(prefixe, cote):
    """Indices des os leg_<p>_1.._3 + tip, dans l'ordre."""
    out = []
    for suff in ("1", "2", "3", "tip"):
        nom = f"leg_{prefixe}_{suff}_{cote}"
        if nom in idx:
            out.append(idx[nom])
    return out

# ── 3. Appariement d'avant en arriere, par cote ───────────────────────────
p_fit = gpos.copy()          # on part des positions du gabarit, tout est recale
S_corps = None               # echelle par axe, pour les elements non apparies

# maillage de la fourmi pour la boite (et l'image de controle)
aj, abb = lire(ANT)
V = acc(aj, abb, aj["meshes"][0]["primitives"][0]["attributes"]["POSITION"]).astype(np.float64)
lo_a, hi_a = V.min(0), V.max(0)
lo_g, hi_g = gpos.min(0), gpos.max(0)
S_corps = (hi_a - lo_a) / np.maximum(hi_g - lo_g, 1e-9) * 0.94
def bbox_fit(p):
    return (p - (lo_g + hi_g) / 2) * S_corps + (lo_a + hi_a) / 2
# base : recalage boite par axe (identique etape 0) pour TOUT...
p_fit = bbox_fit(gpos)
# ...puis on ecrase membre par membre.

rapport = []
for k_cote, cote in ((0, "l"), (1, "r")):
    gabarits = [chaine_gabarit(p, cote) for p in ("a", "b", "c", "d")]
    cibles = [p[k_cote]["points"] for p in paires]
    for g_ch, pts in zip(gabarits, cibles):
        if not g_ch:
            continue
        p_fit[g_ch] = reechantillonner(pts, len(g_ch))
        rapport.append("%s <- paire %s" % (gn[g_ch[0]][:12], cote))
    # gabarits sans cible (la fourmi a moins d'appendices par cote que
    # l'araignee) : rabattus sur la derniere paire, retractes vers l'attache
    for g_ch in gabarits[len(cibles):]:
        if g_ch and cibles:
            neuf = reechantillonner(cibles[-1], len(g_ch))
            p_fit[g_ch] = 0.7 * neuf + 0.3 * neuf[0]
            rapport.append("%s <- (rabattu) %s" % (gn[g_ch[0]][:12], cote))

# ancres : chaque legs_anchor_N_<cote> au debut de la chaine correspondante
for cote in ("l", "r"):
    for n_anc, pref in (("legs_anchor_1_", "a"), ("legs_anchor_2_", "b"),
                        ("legs_anchor_3_", "c"), ("legs_anchor_4_", "d")):
        nom = n_anc + cote
        ch = chaine_gabarit(pref, cote)
        if nom in idx and ch:
            p_fit[idx[nom]] = 0.85 * p_fit[ch[0]] + 0.15 * np.array(
                [0, p_fit[ch[0]][1], p_fit[ch[0]][2]])
    nom_g = "legs_anchor_" + cote
    anc = [idx[n_anc + cote] for n_anc, _ in (("legs_anchor_1_", "a"), ("legs_anchor_2_", "b"),
           ("legs_anchor_3_", "c"), ("legs_anchor_4_", "d")) if (n_anc + cote) in idx]
    if nom_g in idx and anc:
        p_fit[idx[nom_g]] = p_fit[anc].mean(0) * [0.6, 1, 1]

# mandibules -> chaines teeth du gabarit
if paire_mand is not None:
    for k_cote, cote in ((0, "l"), (1, "r")):
        ch_t = [idx[n] for n in (f"teeth_{cote}", f"teeth_tip_{cote}") if n in idx]
        if ch_t:
            p_fit[ch_t] = reechantillonner(paire_mand[k_cote]["points"], len(ch_t))

# abdomen -> chaine tail
if abdos:
    ch_tail = [idx[n] for n in ("tail_1", "tail_2", "tail_3", "tail_tip") if n in idx]
    if ch_tail:
        p_fit[ch_tail] = reechantillonner(
            max(abdos, key=lambda a: len(a["points"]))["points"], len(ch_tail))

# axe du corps : hips a l'attache de l'abdomen ; tete au milieu des attaches
# de la PREMIERE paire (l'appendice le plus en avant part de la tete)
p_hips = abdos[0]["points"][0] if abdos else bbox_fit(gpos[idx["hips"]])
p_tete = (0.5 * (paires[0][0]["A"] + paires[0][1]["A"])
          if paires else bbox_fit(gpos[idx["head"]]))
if "hips" in idx:
    p_fit[idx["hips"]] = p_hips
if "head" in idx:
    p_fit[idx["head"]] = p_tete
for nom, t in (("spine_1", 0.38), ("spine_2", 0.72)):
    if nom in idx:
        p_fit[idx[nom]] = p_hips + t * (p_tete - p_hips)
if "head_tip" in idx:
    p_fit[idx["head_tip"]] = p_tete + [0, 0.04 * (hi_a[1]-lo_a[1]), 0.16 * (hi_a[2]-lo_a[2])]
if "root" in idx:
    p_fit[idx["root"]] = [p_hips[0], lo_a[1], p_hips[2]]

dedans = np.all((p_fit >= lo_a - 1e-6) & (p_fit <= hi_a + 1e-6), axis=1)
print("  appariements : %s" % " | ".join(rapport[:8]))
print("  os dans la boite : %d / %d" % (dedans.sum(), len(gn)))

# ── 4. Image de controle avant/apres ──────────────────────────────────────
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
p_avant = bbox_fit(gpos)
rng = np.random.default_rng(0)
sel = rng.choice(len(V), 45000, replace=False)
fig, axes = plt.subplots(1, 2, figsize=(13, 5.4), facecolor="#0d1117")
for ax, (ti, a, b) in zip(axes, [("profil (Z,Y)", 2, 1), ("dessus (X,Z)", 0, 2)]):
    ax.set_facecolor("#0d1117")
    ax.scatter(V[sel, a], V[sel, b], s=0.3, c="#3a4656", alpha=0.4, linewidths=0)
    ax.scatter(p_avant[:, a], p_avant[:, b], s=16, c="#ff6b6b", label="avant (boîte)")
    ax.scatter(p_fit[:, a], p_fit[:, b], s=16, c="#69db7c", label="après (par membre)")
    ax.set_title(ti, color="#e6edf3", fontsize=11)
    ax.set_aspect("equal"); ax.axis("off")
axes[0].legend(frameon=False, labelcolor="#e6edf3", fontsize=10, loc="lower left")
fig.suptitle("Étape 2 — recalage par membre : les os du gabarit rejoignent les appendices",
             color="#e6edf3", fontsize=12.5)
fig.tight_layout(rect=(0, 0, 1, 0.93))
fig.savefig(IMAGE, dpi=100, facecolor="#0d1117")
print("  image : %s" % IMAGE)

# ── 5. GLB d'entree pour SkinTokens (meme fabrique que l'etape 0) ─────────
Nrm = acc(aj, abb, aj["meshes"][0]["primitives"][0]["attributes"]["NORMAL"]).astype(np.float32)
IDX = acc(aj, abb, aj["meshes"][0]["primitives"][0]["indices"]).astype(np.uint32).reshape(-1)
V32 = V.astype(np.float32)
nv = len(V32)

from scipy.spatial import cKDTree
arbre = cKDTree(p_fit)
_, plus_proche = arbre.query(V, k=1)
J4 = np.zeros((nv, 4), np.uint8)
J4[:, 0] = plus_proche.astype(np.uint8)
occ = Counter(plus_proche.tolist())
orphelins = [k for k in range(len(gn)) if occ.get(k, 0) == 0]
if orphelins:
    arbre_v = cKDTree(V)
    for k in orphelins:
        _, iv = arbre_v.query(p_fit[k], k=60)
        J4[iv, 0] = k
    print("  orphelins repeches : %d" % len(orphelins))

parent_joint = gpj
bin_out = bytearray()
vues, accs = [], []
def pousse(donnees, ctype, atype, cible=None, norm=False, minmax=False):
    global bin_out
    while len(bin_out) % 4:
        bin_out += b"\0"
    off = len(bin_out)
    raw = donnees.tobytes()
    bin_out += raw
    vues.append({"buffer": 0, "byteOffset": off, "byteLength": len(raw),
                 **({"target": cible} if cible else {})})
    a = {"bufferView": len(vues)-1, "byteOffset": 0, "componentType": ctype,
         "count": len(donnees), "type": atype, **({"normalized": True} if norm else {})}
    if minmax:
        a["min"] = [float(x) for x in donnees.min(0)]
        a["max"] = [float(x) for x in donnees.max(0)]
    accs.append(a)
    return len(accs) - 1

a_pos = pousse(V32, 5126, "VEC3", 34962, minmax=True)
a_nrm = pousse(Nrm, 5126, "VEC3", 34962)
a_idx = pousse(IDX.reshape(-1, 1), 5125, "SCALAR", 34963)
a_j = pousse(J4, 5121, "VEC4", 34962)
w = np.zeros((nv, 4), np.uint8); w[:, 0] = 255
a_w = pousse(w, 5121, "VEC4", 34962, norm=True)
IBM = np.stack([np.eye(4) for _ in gn])
for k in range(len(gn)):
    IBM[k][:3, 3] = -p_fit[k]
a_ibm = pousse(IBM.astype(np.float32).transpose(0, 2, 1).reshape(len(gn), 16), 5126, "MAT4")

noeuds_out = [{"name": "Armature", "children": []}]
for k in range(len(gn)):
    pjt = parent_joint[k]
    t_loc = p_fit[k] - (p_fit[pjt] if pjt != -1 else 0.0)
    nd = {"name": gn[k], "translation": [float(x) for x in t_loc]}
    enfants = [i + 1 for i in range(len(gn)) if parent_joint[i] == k]
    if enfants:
        nd["children"] = enfants
    noeuds_out.append(nd)
for k in range(len(gn)):
    if parent_joint[k] == -1:
        noeuds_out[0]["children"].append(k + 1)
i_mesh = len(noeuds_out)
noeuds_out.append({"name": "fourmi", "mesh": 0, "skin": 0})

js_out = {
    "asset": {"version": "2.0", "generator": "FabMesh etape2"},
    "scene": 0,
    "scenes": [{"nodes": [0, i_mesh]}],
    "nodes": noeuds_out,
    "meshes": [{"primitives": [{"attributes": {"POSITION": a_pos, "NORMAL": a_nrm,
                                               "JOINTS_0": a_j, "WEIGHTS_0": a_w},
                                "indices": a_idx}]}],
    "skins": [{"joints": list(range(1, len(gn) + 1)),
               "inverseBindMatrices": a_ibm, "skeleton": 1}],
    "accessors": accs,
    "bufferViews": vues,
    "buffers": [{"byteLength": len(bin_out)}],
}
j = json.dumps(js_out, separators=(",", ":")).encode()
j += b" " * ((4 - len(j) % 4) % 4)
b = bytes(bin_out) + b"\0" * ((4 - len(bin_out) % 4) % 4)
with open(SORTIE, "wb") as f:
    f.write(b"glTF" + struct.pack("<II", 2, 12 + 8 + len(j) + 8 + len(b)))
    f.write(struct.pack("<I", len(j)) + b"JSON" + j)
    f.write(struct.pack("<I", len(b)) + b"BIN\0" + b)
import os
print("  ecrit : %s (%.1f Mo)" % (SORTIE, os.path.getsize(SORTIE) / 1048576))
