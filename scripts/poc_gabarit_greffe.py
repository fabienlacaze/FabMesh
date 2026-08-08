"""Etape 1 — greffe d'identite : le rig final porte le VRAI gabarit.

Entrees :
  build/m2m/spider.glb          gabarit d'origine (noms, hierarchie, rotations)
  build/_etape0_entree.glb      maillage fourmi + positions recalees par axe
  build/_etape0_sortie.glb      peau predite par SkinTokens (os bone_i, 55/56)
Sortie :
  build/_etape1_final.glb       fourmi + squelette araignee COMPLET (56 os,
                                noms d'origine, root compris) + peau predite
                                + clip « Walk » appose SANS retargeting

LE POINT TECHNIQUE QUI CONDITIONNE TOUT :
les canaux d'animation glTF REMPLACENT la rotation locale du noeud. Pour que
les clips du gabarit se jouent directement, chaque os doit donc garder la
ROTATION LOCALE D'ORIGINE du gabarit — sinon les memes valeurs de clip
s'appliquent dans d'autres reperes et le mouvement est faux. On conserve les
rotations, et on ne recalcule que les translations locales pour que les
positions monde atteignent les positions recalees :
    t_local = R_monde(parent)^-1 @ (p_recale(os) - p_recale(parent))
Ainsi les rotations monde de toute la hierarchie restent IDENTIQUES au
gabarit d'origine, image par image — un clip du gabarit produit exactement
les memes rotations monde, autour des pivots de la fourmi.

La peau de l'etape 0 reste valable telle quelle : elle ne depend que des
POSITIONS des articulations, inchangees ici.
"""
import json
import struct
import sys

import numpy as np

SPIDER = "build/m2m/spider.glb"
# Chemins parametrables : greffe.py [entree] [sortie_sk] [final] — memes
# defauts qu'a l'etape 1, pour rejouer les iterations suivantes (etape 2...).
ENTREE = sys.argv[1] if len(sys.argv) > 1 else "build/_etape0_entree.glb"
SORTIE_SK = sys.argv[2] if len(sys.argv) > 2 else "build/_etape0_sortie.glb"
FINAL = sys.argv[3] if len(sys.argv) > 3 else "build/_etape1_final.glb"
CLIPS = ("Walk",)

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
    out = np.frombuffer(bb, _NP[a["componentType"]], n * c, o).reshape(n, c)
    if a.get("normalized") and a["componentType"] == 5121:
        out = out.astype(np.float64) / 255.0
    elif a.get("normalized") and a["componentType"] == 5123:
        out = out.astype(np.float64) / 65535.0
    return out


def q2m(q):
    x, y, z, w = q
    return np.array([
        [1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
        [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
        [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]], dtype=np.float64)


def locale(nd):
    if "matrix" in nd:
        return np.array(nd["matrix"], np.float64).reshape(4, 4).T
    m = np.eye(4)
    m[:3, :3] = q2m(nd.get("rotation", [0, 0, 0, 1])) @ np.diag(nd.get("scale", [1, 1, 1]))
    m[:3, 3] = nd.get("translation", [0, 0, 0])
    return m


def mondes(js):
    nds = js["nodes"]
    par = {}
    for ni, nd in enumerate(nds):
        for e in nd.get("children", []):
            par[e] = ni
    W = {}
    def m(i):
        if i in W:
            return W[i]
        p = par.get(i, -1)
        W[i] = (m(p) if p != -1 else np.eye(4)) @ locale(nds[i])
        return W[i]
    return m, par


# ── 1. Gabarit d'origine : ordre des joints, noms, parents, rotations ──────
gj, gbb = lire(SPIDER)
joints_g = gj["skins"][0]["joints"]
noms_g = [gj["nodes"][i].get("name", "?") for i in joints_g]
m_g, par_g = mondes(gj)
ens_g = set(joints_g)
parent_joint = []
for ni in joints_g:
    p = par_g.get(ni, -1)
    while p != -1 and p not in ens_g:
        p = par_g.get(p, -1)
    parent_joint.append(joints_g.index(p) if p != -1 else -1)
# Rotation monde de chaque os du gabarit (echelle ecartee : bones sans scale).
Rm_g = [m_g(ni)[:3, :3] for ni in joints_g]
rot_loc = [gj["nodes"][ni].get("rotation", [0, 0, 0, 1]) for ni in joints_g]

# ── 2. Positions recalees (etape 0) : chaines en translation seule ─────────
ej, ebb = lire(ENTREE)
joints_e = ej["skins"][0]["joints"]
noms_e = [ej["nodes"][i].get("name", "?") for i in joints_e]
assert noms_e == noms_g, "l'entree de l'etape 0 doit porter le meme gabarit"
m_e, _ = mondes(ej)
p_fit = np.array([m_e(i)[:3, 3] for i in joints_e])

# ── 3. Peau predite : correspondance sortie -> gabarit par position ────────
sj, sbb = lire(SORTIE_SK)
joints_s = sj["skins"][0]["joints"]
m_s, _ = mondes(sj)
P_s = np.array([m_s(i)[:3, 3] for i in joints_s])
def norme(P):
    lo = P.min(0)
    return (P - lo) / max(1e-9, np.max(P.max(0) - lo))
Ne, Ns = norme(p_fit), norme(P_s)
pris, corr = set(), {}
for k in range(len(Ns)):
    dd = np.linalg.norm(Ne - Ns[k], axis=1)
    for c in np.argsort(dd):
        if int(c) not in pris:
            pris.add(int(c)); corr[k] = int(c); break
absents = [noms_g[c] for c in range(len(noms_g)) if c not in pris]
print("  correspondance sortie->gabarit : %d os, absents %s" % (len(corr), absents))

prim_s = sj["meshes"][0]["primitives"][0]
J_s = acc(sj, sbb, prim_s["attributes"]["JOINTS_0"]).astype(np.int64)
W_s = acc(sj, sbb, prim_s["attributes"]["WEIGHTS_0"]).astype(np.float32)
# Reindexer les poids vers l'ordre du GABARIT (56 os, root compris sans peau).
tab = np.zeros(max(J_s.max() + 1, len(joints_s)), np.int64)
for k, c in corr.items():
    tab[k] = c
# NOTE : la reindexation vers l'ordre du gabarit (J_g) se fait APRES le
# transfert par plus proche voisin ci-dessous — J_s y est reordonne.

# Le maillage de la sortie SkinTokens est NORMALISE par l'amont, et
# l'aller-retour Blender DUPLIQUE quelques sommets sur les coutures (constate :
# 1 496 561 contre 1 496 541 en entree — l'ordre n'est donc pas fiable). On
# reprend le maillage de l'ENTREE et on rapatrie les poids par plus proche
# voisin dans l'espace normalise : meme geometrie, correspondance quasi exacte.
prim_e = ej["meshes"][0]["primitives"][0]
V = acc(ej, ebb, prim_e["attributes"]["POSITION"]).astype(np.float32)
Nrm = acc(ej, ebb, prim_e["attributes"]["NORMAL"]).astype(np.float32)
IDX = acc(ej, ebb, prim_e["indices"]).astype(np.uint32).reshape(-1)
V_sortie = acc(sj, sbb, prim_s["attributes"]["POSITION"]).astype(np.float64)

def norm_bbox(P):
    lo, hi = P.min(0), P.max(0)
    return (P - lo) / max(1e-9, np.max(hi - lo))

from scipy.spatial import cKDTree
arbre_vs = cKDTree(norm_bbox(V_sortie))
d_nn, idx_nn = arbre_vs.query(norm_bbox(V.astype(np.float64)), k=1)
print("  transfert des poids par position : ecart NN mediane %.2e, pire %.2e"
      % (float(np.median(d_nn)), float(d_nn.max())))
J_s = J_s[idx_nn]
W_s = W_s[idx_nn]
J_g = tab[J_s]

# ── 4. Translations locales refit, rotations d'origine conservees ──────────
t_loc = []
for k in range(len(joints_g)):
    pj = parent_joint[k]
    if pj == -1:
        t_loc.append(p_fit[k])
    else:
        R_par = Rm_g[pj]
        t_loc.append(R_par.T @ (p_fit[k] - p_fit[pj]))

# Monde du squelette refit (rotations gabarit + translations refit) et IBM.
W_fit = [None] * len(joints_g)
for k in range(len(joints_g)):
    L = np.eye(4)
    L[:3, :3] = q2m(rot_loc[k])
    L[:3, 3] = t_loc[k]
    pj = parent_joint[k]
    W_fit[k] = (W_fit[pj] @ L) if pj != -1 else L
ecart = np.max([np.linalg.norm(W_fit[k][:3, 3] - p_fit[k]) for k in range(len(joints_g))])
print("  refit : ecart position max %.2e (doit etre ~0)" % ecart)
IBM = np.stack([np.linalg.inv(W_fit[k]) for k in range(len(joints_g))]).astype(np.float32)

# ── 5. Ecrire le GLB final ────────────────────────────────────────────────
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

a_pos = pousse(V, 5126, "VEC3", 34962, minmax=True)
a_nrm = pousse(Nrm, 5126, "VEC3", 34962)
a_idx = pousse(IDX.reshape(-1, 1), 5125, "SCALAR", 34963)
a_j = pousse(J_g.astype(np.uint8), 5121, "VEC4", 34962)
a_w = pousse(W_s, 5126, "VEC4", 34962)
a_ibm = pousse(IBM.transpose(0, 2, 1).reshape(len(joints_g), 16), 5126, "MAT4")

rang = {ni: k + 1 for k, ni in enumerate(joints_g)}       # noeud 0 = Armature
noeuds_out = [{"name": "Armature", "children": []}]
for k, ni in enumerate(joints_g):
    nd = {"name": noms_g[k], "translation": [float(x) for x in t_loc[k]]}
    if rot_loc[k] != [0, 0, 0, 1]:
        nd["rotation"] = [float(x) for x in rot_loc[k]]
    enfants = [rang[e] for e in gj["nodes"][ni].get("children", []) if e in ens_g]
    if enfants:
        nd["children"] = enfants
    noeuds_out.append(nd)
for k in range(len(joints_g)):
    if parent_joint[k] == -1:
        noeuds_out[0]["children"].append(k + 1)
i_mesh = len(noeuds_out)
noeuds_out.append({"name": "fourmi", "mesh": 0, "skin": 0})

# ── 6. Apposer les clips du gabarit, par NOM, sans retargeting ─────────────
animations = []
for nom_clip in CLIPS:
    clip = next((a for a in gj.get("animations", []) if a.get("name") == nom_clip), None)
    if clip is None:
        print("  clip absent du gabarit :", nom_clip)
        continue
    nom_vers_noeud = {noms_g[k]: k + 1 for k in range(len(joints_g))}
    canaux, echant = [], []
    for ch in clip["channels"]:
        ni_src = ch["target"]["node"]
        if ni_src not in ens_g:
            continue
        nom_os = gj["nodes"][ni_src].get("name", "?")
        chemin = ch["target"]["path"]
        if chemin == "scale":
            continue
        s = clip["samplers"][ch["sampler"]]
        t_in = acc(gj, gbb, s["input"]).astype(np.float32).reshape(-1, 1)
        v_out = acc(gj, gbb, s["output"]).astype(np.float32)
        if chemin == "translation":
            # Les translations du clip sont dans le repere du PARENT, aux
            # proportions du gabarit d'origine. Une correction exacte
            # exigerait le facteur par axe exprime dans chaque repere local ;
            # pour la racine et les hanches (seules pistes de translation des
            # clips m2m, verifie), le repere parent est l'armature : on
            # applique directement l'echelle par axe du recalage.
            k_os = noms_g.index(nom_os)
            if parent_joint[k_os] == -1:
                ratio = (p_fit.max(0) - p_fit.min(0)) / np.maximum(
                    np.array([m_g(j)[:3, 3] for j in joints_g]).max(0)
                    - np.array([m_g(j)[:3, 3] for j in joints_g]).min(0), 1e-9)
                v_out = v_out * ratio.astype(np.float32)
            else:
                # translation d'un os interne : on la remplace par la
                # translation refit constante (proportions fourmi).
                v_out = np.tile(np.asarray(t_loc[k_os], np.float32), (len(v_out), 1))
        a_t = pousse(t_in, 5126, "SCALAR", minmax=True)
        a_v = pousse(v_out, 5126, "VEC4" if chemin == "rotation" else "VEC3")
        echant.append({"input": a_t, "output": a_v, "interpolation": s.get("interpolation", "LINEAR")})
        canaux.append({"sampler": len(echant) - 1,
                       "target": {"node": nom_vers_noeud[nom_os], "path": chemin}})
    animations.append({"name": nom_clip.lower(), "channels": canaux, "samplers": echant})
    print("  clip '%s' appose : %d canaux, zero retargeting" % (nom_clip, len(canaux)))

js_out = {
    "asset": {"version": "2.0", "generator": "FabMesh greffe gabarit"},
    "scene": 0,
    "scenes": [{"nodes": [0, i_mesh]}],
    "nodes": noeuds_out,
    "meshes": [{"primitives": [{"attributes": {"POSITION": a_pos, "NORMAL": a_nrm,
                                               "JOINTS_0": a_j, "WEIGHTS_0": a_w},
                                "indices": a_idx}]}],
    "skins": [{"joints": [rang[ni] for ni in joints_g],
               "inverseBindMatrices": a_ibm, "skeleton": rang[joints_g[0]]}],
    "animations": animations,
    "accessors": accs,
    "bufferViews": vues,
    "buffers": [{"byteLength": len(bin_out)}],
}
j = json.dumps(js_out, separators=(",", ":")).encode()
j += b" " * ((4 - len(j) % 4) % 4)
b = bytes(bin_out) + b"\0" * ((4 - len(bin_out) % 4) % 4)
with open(FINAL, "wb") as f:
    f.write(b"glTF" + struct.pack("<II", 2, 12 + 8 + len(j) + 8 + len(b)))
    f.write(struct.pack("<I", len(j)) + b"JSON" + j)
    f.write(struct.pack("<I", len(b)) + b"BIN\0" + b)

import os
print("  ecrit : %s (%.1f Mo) — %d os, noms du gabarit, %d clip(s)"
      % (FINAL, os.path.getsize(FINAL) / 1048576, len(joints_g), len(animations)))
