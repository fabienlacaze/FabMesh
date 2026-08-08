"""Etape 0 — juge la peau predite par SkinTokens sur le squelette impose.

Deux verdicts :
1. STRUCTUREL — l'ordre des os de sortie correspond-il au gabarit impose ?
   (comparaison des positions relatives, a la quantification pres ; l'export
   amont ecrase les noms en bone_i, c'est attendu et corrige a l'etape 1)
2. QUALITE DE PEAU — chaque patte de la fourmi est-elle peau-liee a UNE
   chaine de patte du gabarit ? On colore chaque sommet par sa CHAINE
   dominante (8 pattes + corps + tete + queue) et on rend trois vues. Une
   peau saine = des pattes unicolores, nettement separees. Une peau ratee =
   du bruit de couleurs ou une patte etalee sur la moitie du corps.
"""
import json
import struct
import sys

import numpy as np

# Chemins parametrables : evaluer.py [entree] [sortie_sk] [image]
ENTREE = sys.argv[1] if len(sys.argv) > 1 else "build/_etape0_entree.glb"
SORTIE_SK = sys.argv[2] if len(sys.argv) > 2 else "build/_etape0_sortie.glb"
IMAGE = sys.argv[3] if len(sys.argv) > 3 else "build/_etape0_peau.png"

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


# ── Gabarit impose : noms et chaines ───────────────────────────────────────
ej, ebb = lire(ENTREE)
joints_e = ej["skins"][0]["joints"]
noms_gab = [ej["nodes"][i].get("name", "?") for i in joints_e]

def chaine_de(nom):
    n = nom.lower()
    if n.startswith("leg_"):
        return "patte_" + n.split("_")[1] + "_" + ("l" if n.endswith("_l") or "_l_" in n else "r")
    if "anchor" in n:
        return "corps"
    if n.startswith(("head", "teeth", "mouth")):
        return "tete"
    if n.startswith("tail"):
        return "queue"
    return "corps"

chaines_gab = [chaine_de(n) for n in noms_gab]

# ── Sortie SkinTokens ─────────────────────────────────────────────────────
sj, sbb = lire(SORTIE_SK)
sk = sj.get("skins", [])
if not sk:
    print("VERDICT : ECHEC — la sortie n'a pas de peau"); sys.exit(1)
joints_s = sk[0]["joints"]
print("  os gabarit %d / os sortie %d" % (len(joints_e), len(joints_s)))
# L'elagage amont retire les os-reperes sans peau (ici : root, verifie par
# diagnostic). On apparie donc par POSITION plutot que par ordre strict.
if len(joints_s) < len(joints_e) - 2:
    print("VERDICT : ECHEC — trop d'os perdus"); sys.exit(1)

# Correspondance par ORDRE, verifiee par les positions relatives (les deux
# nuages normalises sur leur boite ; l'export amont requantifie a ~0,8 %).
def mondes(js):
    nds = js["nodes"]; par = {}
    for ni, nd in enumerate(nds):
        for e in nd.get("children", []):
            par[e] = ni
    W = {}
    def m(i):
        if i in W: return W[i]
        nd = nds[i]
        if "matrix" in nd:
            L = np.array(nd["matrix"], np.float64).reshape(4, 4).T
        else:
            L = np.eye(4)
            if "rotation" in nd:
                x, y, z, w = nd["rotation"]
                L[:3, :3] = np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],
                                      [2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],
                                      [2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])
            if "scale" in nd:
                L[:3, :3] = L[:3, :3] @ np.diag(nd["scale"])
            L[:3, 3] = nd.get("translation", [0, 0, 0])
        p = par.get(i, -1)
        W[i] = (m(p) if p != -1 else np.eye(4)) @ L
        return W[i]
    return m

m_e, m_s = mondes(ej), mondes(sj)
P_e = np.array([m_e(i)[:3, 3] for i in joints_e])
P_s = np.array([m_s(i)[:3, 3] for i in joints_s])
def norme(P):
    lo, hi = P.min(0), P.max(0)
    return (P - lo) / max(1e-9, np.max(hi - lo))
Ne, Ns = norme(P_e), norme(P_s)
pris = set(); corr = {}
for k in range(len(Ns)):
    dd = np.linalg.norm(Ne - Ns[k], axis=1)
    for c in np.argsort(dd):
        if c not in pris:
            pris.add(int(c)); corr[k] = int(c); break
d = np.array([np.linalg.norm(Ne[corr[k]] - Ns[k]) for k in range(len(Ns))])
absents = [noms_gab[c] for c in range(len(noms_gab)) if c not in pris]
print("  appariement par position : mediane %.3f  pire %.3f | absents : %s"
      % (np.median(d), d.max(), absents or 'aucun'))
chaines_sortie = [chaines_gab[corr[k]] for k in range(len(joints_s))]

# ── Poids de peau : chaine dominante par sommet ────────────────────────────
prim = sj["meshes"][0]["primitives"][0]
V = acc(sj, sbb, prim["attributes"]["POSITION"]).astype(np.float64)
J = acc(sj, sbb, prim["attributes"]["JOINTS_0"]).astype(np.int64)
Wt = acc(sj, sbb, prim["attributes"]["WEIGHTS_0"]).astype(np.float64)
print("  sommets peau-lies : %s | somme des poids mediane %.3f"
      % (format(len(V), ","), float(np.median(Wt.sum(1)))))

os_dominant = J[np.arange(len(J)), Wt.argmax(1)]
idx_chaine = {c: k for k, c in enumerate(sorted(set(chaines_gab)))}
chaine_som = np.array([idx_chaine[chaines_sortie[o]] for o in os_dominant])

from collections import Counter
rep = Counter(chaine_som)
noms_ch = sorted(idx_chaine, key=idx_chaine.get)
print("  repartition par chaine :")
for c, k in sorted(idx_chaine.items()):
    print("     %-10s %5.1f %%" % (c, 100 * rep.get(k, 0) / len(V)))

# Localite : distance de chaque sommet a l'os qui le domine (une peau saine
# lie chaque sommet a un os PROCHE).
d_os = np.linalg.norm(V - P_s[os_dominant], axis=1)
ech = np.linalg.norm(V.max(0) - V.min(0))
print("  distance sommet->os dominant : mediane %.1f %%  p95 %.1f %% de la taille"
      % (100 * np.median(d_os) / ech, 100 * np.percentile(d_os, 95) / ech))

# ── Rendu : nuage colore par chaine, 3 vues ───────────────────────────────
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
PAL = ["#ff6b6b", "#ffa94d", "#ffd43b", "#a9e34b", "#69db7c", "#38d9a9",
       "#3bc9db", "#4dabf7", "#748ffc", "#da77f2", "#f783ac", "#ced4da"]
coul = np.array([PAL[k % len(PAL)] for k in range(len(idx_chaine))])
rng = np.random.default_rng(0)
ech_i = rng.choice(len(V), min(len(V), 70000), replace=False)
fig, axes = plt.subplots(1, 3, figsize=(16, 5.6), facecolor="#0d1117")
for ax, (ti, a, b) in zip(axes, [("profil (Z,Y)", 2, 1), ("dessus (X,Z)", 0, 2), ("face (X,Y)", 0, 1)]):
    ax.set_facecolor("#0d1117")
    ax.scatter(V[ech_i, a], V[ech_i, b], s=0.5,
               c=coul[chaine_som[ech_i]], linewidths=0, alpha=0.75)
    ax.set_title(ti, color="#e6edf3", fontsize=11)
    ax.set_aspect("equal"); ax.axis("off")
handles = [plt.Line2D([], [], marker="o", ls="", color=PAL[idx_chaine[c] % len(PAL)],
                      label=c, markersize=6) for c in noms_ch]
fig.legend(handles=handles, loc="lower center", ncol=6, frameon=False,
           labelcolor="#e6edf3", fontsize=9)
fig.suptitle("Étape 0 — peau SkinTokens sur squelette araignée imposé (fourmi, %d os)"
             % len(joints_s), color="#e6edf3", fontsize=13)
fig.tight_layout(rect=(0, 0.07, 1, 0.93))
fig.savefig(IMAGE, dpi=100, facecolor="#0d1117")
print("  image : %s" % IMAGE)
