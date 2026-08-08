"""Etape 0 — construit le GLB « maillage fourmi + armature araignee CC0 ».

Le test decisif du plan squelette-gabarit : on impose le squelette de
l'araignee Mesh2Motion au maillage de la fourmi, et on demande a SkinTokens
(--use_skeleton) de ne predire QUE les poids de peau.

Contrat d'entree impose par SkinTokens : il importe via Blender, et
l'importateur glTF ne cree une armature que depuis une PEAU referencee par un
maillage. Le GLB construit contient donc : le maillage de la fourmi, la
hierarchie d'os de l'araignee, une peau (joints + inverseBindMatrices), et des
poids FACTICES (tout sur l'os racine) — SkinTokens les re-predit de toute
facon, mais sans eux le fichier serait invalide et Blender n'importerait rien.
"""
import json
import struct
import sys

import numpy as np

SPIDER = "build/m2m/spider.glb"
ANT = "meshes/ant_trellis2_native_1781901851036_rigged_skintokens_1786199629367.glb"
SORTIE = "build/_etape0_entree.glb"

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


def locale(nd):
    if "matrix" in nd:
        return np.array(nd["matrix"], np.float64).reshape(4, 4).T
    m = np.eye(4)
    m[:3, :3] = q2m(nd.get("rotation", [0, 0, 0, 1])) @ np.diag(nd.get("scale", [1, 1, 1]))
    m[:3, 3] = nd.get("translation", [0, 0, 0])
    return m


# ── 1. Armature araignee : hierarchie + monde au repos ─────────────────────
sj, sb = lire(SPIDER)
noeuds_s = sj["nodes"]
joints_s = sj["skins"][0]["joints"]
ens = set(joints_s)
parent_de = {}
for ni, nd in enumerate(noeuds_s):
    for e in nd.get("children", []):
        parent_de[e] = ni

W = {}
def monde(i):
    if i in W:
        return W[i]
    p = parent_de.get(i, -1)
    W[i] = (monde(p) if p != -1 else np.eye(4)) @ locale(noeuds_s[i])
    return W[i]
pos_s = np.array([monde(i)[:3, 3] for i in joints_s])
noms_s = [noeuds_s[i].get("name", f"bone_{i}") for i in joints_s]

# ── 2. Maillage fourmi (sans son ancienne peau) ────────────────────────────
aj, ab = lire(ANT)
prim = aj["meshes"][0]["primitives"][0]
V = acc(aj, ab, prim["attributes"]["POSITION"]).astype(np.float32)
Nrm = acc(aj, ab, prim["attributes"]["NORMAL"]).astype(np.float32)
IDX = acc(aj, ab, prim["indices"]).astype(np.uint32).reshape(-1)

lo_a, hi_a = V.min(0).astype(np.float64), V.max(0).astype(np.float64)
lo_s, hi_s = pos_s.min(0), pos_s.max(0)
ext_a, ext_s = hi_a - lo_a, np.maximum(hi_s - lo_s, 1e-9)
print("  fourmi  : etendues %s" % np.round(ext_a, 3))
print("  araignee: etendues %s" % np.round(ext_s, 3))

# Orientation : les deux ont leur grand axe en Z — pas de rotation.
#
# Echelle PAR AXE, pas uniforme. L'araignee ecarte ses pattes sur 2,96 en X
# quand la fourmi ne fait que 1,42 : l'echelle uniforme « min des rapports »
# retrecissait le squelette a 44 % et il ne couvrait plus que la moitie de la
# longueur du corps — le test aurait juge un squelette mal place, pas la
# prediction de peau. On cuit donc des positions par-axe directement dans les
# os, en TRANSLATION SEULE (rotations abandonnees) : ce que le tokenizer
# consomme, ce sont les positions des articulations ; simplification assumee
# pour ce test — l'etape 2 du plan fera un vrai recalage par membre.
S_ax = 0.94 * ext_a / ext_s
centre_a = (lo_a + hi_a) / 2
centre_s = (lo_s + hi_s) / 2
print("  echelle par axe %s" % np.round(S_ax, 3))
pos_cuites = (pos_s - centre_s) * S_ax + centre_a          # monde voulu par os
IBM = np.stack([np.eye(4, dtype=np.float64) for _ in joints_s])
for k in range(len(joints_s)):
    IBM[k][:3, 3] = -pos_cuites[k]
IBM = IBM.astype(np.float32)

# ── 3. Construire le GLB de sortie ─────────────────────────────────────────
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

nv = len(V)
a_pos = pousse(V, 5126, "VEC3", 34962, minmax=True)
a_nrm = pousse(Nrm, 5126, "VEC3", 34962)
a_idx = pousse(IDX.reshape(-1, 1), 5125, "SCALAR", 34963)
# Poids initiaux : chaque sommet sur son os LE PLUS PROCHE — pas tout sur la
# racine. Raison decouverte a la premiere tentative : la transformation de
# prediction de SkinTokens appelle `trim_skeleton()`, qui SUPPRIME tout os
# dont le sous-arbre ne porte aucun poids (asset.py:478-498). Avec des poids
# 100 % racine, 55 os sur 56 etaient elagues avant tokenisation — la sortie
# n'avait qu'un os. Le plus-proche-os garantit que chaque os garde de la peau.
from scipy.spatial import cKDTree
arbre = cKDTree(pos_cuites)
_, plus_proche = arbre.query(V.astype(np.float64), k=1)
J4 = np.zeros((nv, 4), np.uint8)
J4[:, 0] = plus_proche.astype(np.uint8)
# Un os feuille sans peau serait quand meme elague par trim_skeleton : on
# attribue de force a chaque os orphelin ses 60 sommets les plus proches,
# pour que l'elagage ne touche RIEN et que le gabarit reste 1:1.
# IMPERATIF : avant `pousse(J4)` — tobytes() copie, une retouche apres coup
# n'irait jamais dans le fichier.
import collections as _c
occ = _c.Counter(plus_proche.tolist())
orphelins = [k for k in range(len(joints_s)) if occ.get(k, 0) == 0]
if orphelins:
    arbre_v = cKDTree(V.astype(np.float64))
    for k in orphelins:
        _, idx_v = arbre_v.query(pos_cuites[k], k=60)
        J4[idx_v, 0] = k
    print("  os orphelins repeches : %d (60 sommets forces chacun)" % len(orphelins))
a_j = pousse(J4, 5121, "VEC4", 34962)
w = np.zeros((nv, 4), np.uint8); w[:, 0] = 255
a_w = pousse(w, 5121, "VEC4", 34962, norm=True)
a_ibm = pousse(IBM.transpose(0, 2, 1).reshape(len(joints_s), 16), 5126, "MAT4")

# Noeuds : [0]=parent armature (identite), [1..n]=os en TRANSLATION SEULE
# (position cuite relative au parent articulaire), [n+1]=maillage.
rang = {ni: k + 1 for k, ni in enumerate(joints_s)}
parent_joint = {}
for k, ni in enumerate(joints_s):
    p = parent_de.get(ni, -1)
    while p != -1 and p not in ens:
        p = parent_de.get(p, -1)
    parent_joint[k] = joints_s.index(p) if p != -1 else -1

noeuds_out = [{"name": "Armature", "children": []}]
for k, ni in enumerate(joints_s):
    pj = parent_joint[k]
    t_loc = pos_cuites[k] - (pos_cuites[pj] if pj != -1 else 0.0)
    nd = {"name": noms_s[k], "translation": [float(x) for x in t_loc]}
    enfants = [rang[e] for e in noeuds_s[ni].get("children", []) if e in ens]
    if enfants:
        nd["children"] = enfants
    noeuds_out.append(nd)
for k in range(len(joints_s)):
    if parent_joint[k] == -1:
        noeuds_out[0]["children"].append(k + 1)

i_mesh = len(noeuds_out)
noeuds_out.append({"name": "fourmi", "mesh": 0, "skin": 0})

js_out = {
    "asset": {"version": "2.0", "generator": "FabMesh etape0"},
    "scene": 0,
    "scenes": [{"nodes": [0, i_mesh]}],
    "nodes": noeuds_out,
    "meshes": [{"primitives": [{"attributes": {"POSITION": a_pos, "NORMAL": a_nrm,
                                               "JOINTS_0": a_j, "WEIGHTS_0": a_w},
                                "indices": a_idx}]}],
    "skins": [{"joints": [rang[ni] for ni in joints_s],
               "inverseBindMatrices": a_ibm, "skeleton": rang[joints_s[0]]}],
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
print("  ecrit : %s (%.1f Mo) — %d sommets, %d os araignee"
      % (SORTIE, os.path.getsize(SORTIE) / 1048576, nv, len(joints_s)))
# Controle : les os recales tiennent-ils dans la boite du maillage ?
dedans = np.all((pos_cuites >= lo_a - 1e-6) & (pos_cuites <= hi_a + 1e-6), axis=1)
print("  os dans la boite du maillage : %d / %d" % (dedans.sum(), len(joints_s)))
print("  couverture du squelette : %s -> %s"
      % (np.round(pos_cuites.min(0), 2), np.round(pos_cuites.max(0), 2)))
