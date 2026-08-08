"""Symetrise la pose de liaison d'un rig, en recalculant les matrices de liaison.

POURQUOI
Mesure du 2026-08-08 sur un rig SkinTokens de fourmi :
  asymetrie du MAILLAGE : mediane 0,33 %   (la fourmi EST symetrique)
  asymetrie du RIG      : mediane 2,71 %, pire 16,4 %, 31 os sur 40 deviants
Le rig est donc huit fois plus tordu que le modele qu'il habille. Or une marche
suppose des membres en miroir : c'est ce qui plafonne l'amplitude du mouvement
retargete.

CE QUE CE SCRIPT FAIT — ET NE FAIT PAS
Il corrige les POSITIONS : chaque os est apparie a son symetrique, et les deux
sont ramenes a la moyenne de leurs positions miroir. Les os proches du plan
sagittal y sont replaques.

Il ne peut PAS egaliser les longueurs de chaines. Sur la fourmi, les
profondeurs sont [4,4,4,5,5,5,6,6,6,7,7,7,7] : des comptes impairs, donc des
pattes gauches et droites qui n'ont pas le meme nombre d'articulations. Cela
releve de la TOPOLOGIE, pas de la geometrie — aucun deplacement d'os ne le
resoudra. Le script le SIGNALE au lieu de faire semblant.

POINT CRITIQUE
Deplacer un os sans recalculer `inverseBindMatrices` decale la peau : la
matrice de liaison encode la pose de repos, et le shader compose
`monde(os) x IBM`. Si l'un bouge sans l'autre, le maillage se deforme des la
premiere image. On recalcule donc IBM = inverse(matrice monde) pour chaque os.

  python rig_symetriser.py entree.glb sortie.glb [--axe x] [--seuil 0.04]
"""
from __future__ import annotations

import argparse
import json
import struct

import numpy as np


# ---------------------------------------------------------------------------
# Lecture / ecriture GLB
# ---------------------------------------------------------------------------
def lire_glb(chemin):
    brut = open(chemin, "rb").read()
    if brut[:4] != b"glTF":
        raise SystemExit("ce n'est pas un GLB")
    js = bb = None
    off = 12
    while off < len(brut):
        lg, ty = struct.unpack_from("<II", brut, off)
        bloc = brut[off + 8: off + 8 + lg]
        if ty == 0x4E4F534A:
            js = json.loads(bloc)
        elif ty == 0x004E4942:
            bb = bytearray(bloc)
        off += 8 + lg
    return js, bb


def ecrire_glb(chemin, js, bb):
    j = json.dumps(js, separators=(",", ":")).encode("utf-8")
    j += b" " * ((4 - len(j) % 4) % 4)
    b = bytes(bb) + b"\x00" * ((4 - len(bb) % 4) % 4)
    total = 12 + 8 + len(j) + 8 + len(b)
    with open(chemin, "wb") as f:
        f.write(b"glTF" + struct.pack("<II", 2, total))
        f.write(struct.pack("<I", len(j)) + b"JSON" + j)
        f.write(struct.pack("<I", len(b)) + b"BIN\x00" + b)


_NP = {5120: "<i1", 5121: "<u1", 5122: "<i2", 5123: "<u2", 5125: "<u4", 5126: "<f4"}
_NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def lire_accesseur(js, bb, i):
    a = js["accessors"][i]
    n, c = a["count"], _NC[a["type"]]
    bv = js["bufferViews"][a["bufferView"]]
    o = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    return np.frombuffer(bytes(bb), _NP[a["componentType"]], n * c, o).reshape(n, c).astype(np.float64)


# ---------------------------------------------------------------------------
# Transformations
# ---------------------------------------------------------------------------
def q2m(q):
    x, y, z, w = q
    return np.array([
        [1 - 2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
        [2*(x*y+z*w), 1 - 2*(x*x+z*z), 2*(y*z-x*w)],
        [2*(x*z-y*w), 2*(y*z+x*w), 1 - 2*(x*x+y*y)]], dtype=np.float64)


def locale(nd):
    if "matrix" in nd:
        return np.array(nd["matrix"], dtype=np.float64).reshape(4, 4).T
    m = np.eye(4)
    m[:3, :3] = q2m(nd.get("rotation", [0, 0, 0, 1])) @ np.diag(nd.get("scale", [1, 1, 1]))
    m[:3, 3] = nd.get("translation", [0, 0, 0])
    return m


def mondes(js):
    noeuds = js["nodes"]
    W, parent = {}, {}

    def descendre(i, p=np.eye(4), pi=-1):
        W[i] = p @ locale(noeuds[i])
        parent[i] = pi
        for e in noeuds[i].get("children", []):
            descendre(e, W[i], i)

    for r in js["scenes"][js.get("scene", 0)]["nodes"]:
        descendre(r)
    return W, parent


def main():
    ap = argparse.ArgumentParser(description="Symetrise la pose de liaison d'un rig")
    ap.add_argument("entree")
    ap.add_argument("sortie")
    ap.add_argument("--axe", default="x", choices=["x", "y", "z"],
                    help="normale du plan de symetrie (defaut x)")
    ap.add_argument("--seuil", type=float, default=0.04,
                    help="fraction de la taille en deca de laquelle un os est "
                         "considere CENTRAL et replaque sur le plan")
    a = ap.parse_args()
    AX = {"x": 0, "y": 1, "z": 2}[a.axe]

    js, bb = lire_glb(a.entree)
    if "skins" not in js or not js["skins"]:
        raise SystemExit("ce GLB n'a pas de peau — rien a symetriser")
    joints = js["skins"][0]["joints"]
    W, parent = mondes(js)
    pos = np.array([W[i][:3, 3] for i in joints])
    n = len(joints)

    # ── Plan de symetrie : deduit du MAILLAGE, pas du rig ─────────────────
    # C'est tout l'interet de l'operation : le maillage est la reference fiable
    # (asymetrie mediane 0,33 % contre 2,71 % pour le rig). Prendre le plan sur
    # le rig reviendrait a valider sa propre derive.
    plan = None
    prim = js["meshes"][0]["primitives"][0] if js.get("meshes") else None
    if prim and "POSITION" in prim.get("attributes", {}):
        V = lire_accesseur(js, bb, prim["attributes"]["POSITION"])
        plan = float(np.median(V[:, AX]))
        etendue = float(np.linalg.norm(V.max(0) - V.min(0)))
    else:
        plan = float(np.median(pos[:, AX]))
        etendue = float(np.linalg.norm(pos.max(0) - pos.min(0)))
    seuil_abs = a.seuil * etendue

    def miroir(p):
        q = p.copy()
        q[AX] = 2 * plan - q[AX]
        return q

    # ── Appariement gauche/droite ─────────────────────────────────────────
    # Appariement MUTUELLEMENT le plus proche : si a designe b comme son
    # symetrique et b designe a, la paire est sure. Un appariement simplement
    # « le plus proche » accouplerait deux os du meme cote sur un rig tordu.
    ecart = pos[:, AX] - plan
    gauche = [k for k in range(n) if ecart[k] > seuil_abs]
    droite = [k for k in range(n) if ecart[k] < -seuil_abs]
    centre = [k for k in range(n) if abs(ecart[k]) <= seuil_abs]

    voulu = {}
    for k in gauche:
        m = miroir(pos[k])
        voulu[k] = min(droite, key=lambda j: np.linalg.norm(pos[j] - m)) if droite else None
    for k in droite:
        m = miroir(pos[k])
        voulu[k] = min(gauche, key=lambda j: np.linalg.norm(pos[j] - m)) if gauche else None

    paires = [(k, voulu[k]) for k in gauche
              if voulu.get(k) is not None and voulu.get(voulu[k]) == k]

    print("  os %d — gauche %d, droite %d, centre %d" % (n, len(gauche), len(droite), len(centre)))
    print("  paires mutuelles trouvees : %d  (%d os non apparies)"
          % (len(paires), len(gauche) + len(droite) - 2 * len(paires)))

    # ── Nouvelles positions monde ─────────────────────────────────────────
    neuf = pos.copy()
    for g, d in paires:
        moy = 0.5 * (pos[g] + miroir(pos[d]))
        neuf[g] = moy
        neuf[d] = miroir(moy)
    for k in centre:
        neuf[k, AX] = plan

    # ── Retour en translations locales ────────────────────────────────────
    # On garde les rotations et echelles telles quelles et on ne recalcule que
    # la translation : t_local = inv(monde_parent) x position_monde_voulue.
    # Il faut proceder du parent vers l'enfant, un parent deplace changeant le
    # repere de tous ses descendants.
    rang = {ni: k for k, ni in enumerate(joints)}
    ordre = sorted(range(n), key=lambda k: _profondeur(joints[k], parent))
    Wn = dict(W)
    for k in ordre:
        ni = joints[k]
        pi = parent[ni]
        Wp = Wn.get(pi, np.eye(4)) if pi != -1 else np.eye(4)
        L = np.linalg.inv(Wp) @ W[ni]              # locale d'origine (rotation/echelle)
        cible_locale = (np.linalg.inv(Wp) @ np.append(neuf[k], 1.0))[:3]
        L[:3, 3] = cible_locale
        Wn[ni] = Wp @ L
        nd = js["nodes"][ni]
        nd.pop("matrix", None)
        nd["translation"] = [float(x) for x in cible_locale]
        # Rotation et echelle inchangees : si elles etaient dans une matrice,
        # on les reexprime pour rester coherent.
        if "rotation" not in nd and "scale" not in nd:
            M = np.linalg.inv(Wp) @ W[ni]
            ech = np.linalg.norm(M[:3, :3], axis=0)
            ech[ech < 1e-12] = 1.0
            Rm = M[:3, :3] / ech
            nd["rotation"] = [float(x) for x in _m2q(Rm)]
            nd["scale"] = [float(x) for x in ech]

    # Propager aux descendants NON articulaires (rien a faire : leurs locales
    # sont inchangees, leur monde suit celui de leur parent).

    # ── Recalcul des matrices de liaison ──────────────────────────────────
    peau = js["skins"][0]
    if "inverseBindMatrices" in peau:
        acc = js["accessors"][peau["inverseBindMatrices"]]
        bv = js["bufferViews"][acc["bufferView"]]
        base = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
        Wn2, _ = mondes(js)              # apres modification des noeuds
        for k, ni in enumerate(joints):
            ibm = np.linalg.inv(Wn2[ni]).T.astype(np.float32)   # glTF = colonnes
            struct.pack_into("<16f", bb, base + k * 64, *ibm.reshape(-1))
        print("  matrices de liaison recalculees pour %d os" % len(joints))
    else:
        print("  ATTENTION : pas d'inverseBindMatrices — la peau pourrait se decaler")

    ecrire_glb(a.sortie, js, bb)

    # ── Mesure avant / apres ──────────────────────────────────────────────
    def asym(P):
        e = []
        for k in range(n):
            if abs(P[k, AX] - plan) < seuil_abs:
                continue
            m = miroir(P[k])
            e.append(np.min(np.linalg.norm(P - m, axis=1)))
        return (np.median(e) / etendue * 100, np.max(e) / etendue * 100) if e else (0, 0)

    av_m, av_p = asym(pos)
    ap_m, ap_p = asym(neuf)
    print("  ASYMETRIE  avant : mediane %.2f %%  pire %.2f %%" % (av_m, av_p))
    print("             apres : mediane %.2f %%  pire %.2f %%" % (ap_m, ap_p))

    # Longueurs de chaines : ce que la geometrie ne peut PAS corriger.
    enfants = {}
    for ni in joints:
        p = parent[ni]
        while p != -1 and p not in set(joints):
            p = parent[p]
        enfants.setdefault(p, []).append(ni)
    feuilles = [ni for ni in joints if ni not in enfants]
    profs = sorted(_profondeur(ni, parent) for ni in feuilles)
    from collections import Counter
    impairs = [p for p, c in Counter(profs).items() if c % 2]
    print("  profondeurs de chaines : %s" % profs)
    if impairs:
        print("  RESTE UN DEFAUT DE TOPOLOGIE : profondeurs en nombre impair %s"
              " — des membres gauche/droite n'ont pas le meme nombre"
              " d'articulations. Aucun deplacement d'os ne corrige cela." % impairs)


def _profondeur(ni, parent):
    d = 0
    while parent.get(ni, -1) != -1:
        ni = parent[ni]
        d += 1
    return d


def _m2q(R):
    t = np.trace(R)
    if t > 0:
        s = np.sqrt(t + 1.0) * 2
        return np.array([(R[2,1]-R[1,2])/s, (R[0,2]-R[2,0])/s, (R[1,0]-R[0,1])/s, 0.25*s])
    i = int(np.argmax([R[0,0], R[1,1], R[2,2]]))
    if i == 0:
        s = np.sqrt(1.0 + R[0,0] - R[1,1] - R[2,2]) * 2
        return np.array([0.25*s, (R[0,1]+R[1,0])/s, (R[0,2]+R[2,0])/s, (R[2,1]-R[1,2])/s])
    if i == 1:
        s = np.sqrt(1.0 + R[1,1] - R[0,0] - R[2,2]) * 2
        return np.array([(R[0,1]+R[1,0])/s, 0.25*s, (R[1,2]+R[2,1])/s, (R[0,2]-R[2,0])/s])
    s = np.sqrt(1.0 + R[2,2] - R[0,0] - R[1,1]) * 2
    return np.array([(R[0,2]+R[2,0])/s, (R[1,2]+R[2,1])/s, 0.25*s, (R[1,0]-R[0,1])/s])


if __name__ == "__main__":
    main()
