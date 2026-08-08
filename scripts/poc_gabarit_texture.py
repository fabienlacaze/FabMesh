"""Fusionne le maillage TEXTURE d'origine avec un rig gabarit + ses clips.

POURQUOI
SkinTokens jette matériaux et textures (vérifié : le GLB riggé n'a ni
TEXCOORD ni images, l'original en a). Les résultats des étapes 0-2 étaient
donc des nuages de points gris. Ce script réassemble le livrable réel :

  maillage d'origine (TEXCOORD_0 + matériaux + textures)
  + squelette gabarit + peau (du GLB final d'une étape)
  + clips

Les poids sont rapatriés par plus proche voisin en espace normalisé — les
deux maillages représentent la même géométrie mais l'aller-retour Blender
change le nombre de sommets (coutures dupliquées).

  python poc_gabarit_texture.py <original.glb> <final_etape.glb> <sortie.glb>
"""
import json
import struct
import sys

import numpy as np
from scipy.spatial import cKDTree

ORIGINAL = sys.argv[1] if len(sys.argv) > 1 else "meshes/ant_trellis2_native_1781901851036.glb"
FINAL = sys.argv[2] if len(sys.argv) > 2 else "build/_etape2_final.glb"
SORTIE = sys.argv[3] if len(sys.argv) > 3 else "build/_etape2_final_texture.glb"

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
    if a.get("normalized"):
        out = out.astype(np.float64) / (255.0 if a["componentType"] == 5121 else 65535.0)
    return out


oj, obb = lire(ORIGINAL)
fj, fbb = lire(FINAL)

# ── 1. Poids du final -> sommets de l'original, par plus proche voisin ─────
prim_f = fj["meshes"][0]["primitives"][0]
V_f = acc(fj, fbb, prim_f["attributes"]["POSITION"]).astype(np.float64)
J_f = acc(fj, fbb, prim_f["attributes"]["JOINTS_0"]).astype(np.int64)
W_f = acc(fj, fbb, prim_f["attributes"]["WEIGHTS_0"]).astype(np.float32)

prim_o = oj["meshes"][0]["primitives"][0]
V_o = acc(oj, obb, prim_o["attributes"]["POSITION"]).astype(np.float64)


def norm_bbox(P):
    lo, hi = P.min(0), P.max(0)
    return (P - lo) / max(1e-9, np.max(hi - lo))


d_nn, idx_nn = cKDTree(norm_bbox(V_f)).query(norm_bbox(V_o), k=1)
print("  original %s sommets <- final %s | NN mediane %.2e pire %.2e"
      % (format(len(V_o), ","), format(len(V_f), ","),
         float(np.median(d_nn)), float(d_nn.max())))
J_o = J_f[idx_nn].astype(np.uint8)
W_o = W_f[idx_nn]

# L'ESPACE doit etre le meme : si l'original n'est pas dans le repere du
# final (echelle/offset), la peau se decale. On verifie et on recale
# lineairement l'original sur le final (par boite englobante, par axe).
lo_o, hi_o = V_o.min(0), V_o.max(0)
lo_f, hi_f = V_f.min(0), V_f.max(0)
S = (hi_f - lo_f) / np.maximum(hi_o - lo_o, 1e-12)
T = lo_f - lo_o * S
if np.max(np.abs(S - 1)) > 1e-3 or np.max(np.abs(T)) > 1e-3:
    print("  recalage de l'original sur l'espace du rig : echelle %s" % np.round(S, 4))
    V_o = V_o * S + T

# ── 2. Assembler : tampon = [binaire original] + [ajouts] ──────────────────
# On GARDE tout le JSON de l'original (accessors, bufferViews, materiaux,
# textures, images, samplers pointent dans son tampon, offsets inchanges) et
# on AJOUTE a la fin : positions recalees si besoin, JOINTS/WEIGHTS, IBM, et
# les pistes d'animation copiees du final.
js = json.loads(json.dumps(oj))          # copie profonde de l'original
bin_out = bytearray(obb)

def pousse(donnees, ctype, atype, cible=None, norm=False, minmax=False):
    global bin_out
    while len(bin_out) % 4:
        bin_out += b"\0"
    off = len(bin_out)
    raw = donnees.tobytes()
    bin_out += raw
    js.setdefault("bufferViews", []).append(
        {"buffer": 0, "byteOffset": off, "byteLength": len(raw),
         **({"target": cible} if cible else {})})
    a = {"bufferView": len(js["bufferViews"]) - 1, "byteOffset": 0,
         "componentType": ctype, "count": len(donnees), "type": atype,
         **({"normalized": True} if norm else {})}
    if minmax:
        a["min"] = [float(x) for x in donnees.min(0)]
        a["max"] = [float(x) for x in donnees.max(0)]
    js.setdefault("accessors", []).append(a)
    return len(js["accessors"]) - 1

a_j = pousse(J_o, 5121, "VEC4", 34962)
a_w = pousse(W_o.astype(np.float32), 5126, "VEC4", 34962)
if np.max(np.abs(S - 1)) > 1e-3 or np.max(np.abs(T)) > 1e-3:
    a_p = pousse(V_o.astype(np.float32), 5126, "VEC3", 34962, minmax=True)
    for prim in js["meshes"][0]["primitives"]:
        prim["attributes"]["POSITION"] = a_p
for prim in js["meshes"][0]["primitives"]:
    prim["attributes"]["JOINTS_0"] = a_j
    prim["attributes"]["WEIGHTS_0"] = a_w

# ── 3. Copier armature + peau + animations du final ────────────────────────
base_nd = len(js.get("nodes", []))
peau_f = fj["skins"][0]
joints_f = peau_f["joints"]
# les noeuds du final : Armature(0) + os (1..n) + noeud maillage (ignore)
utiles = [0] + list(joints_f)
remap = {ni: base_nd + k for k, ni in enumerate(utiles)}
for ni in utiles:
    nd = json.loads(json.dumps(fj["nodes"][ni]))
    nd.pop("mesh", None); nd.pop("skin", None)
    if "children" in nd:
        nd["children"] = [remap[e] for e in nd["children"] if e in remap]
        if not nd["children"]:
            del nd["children"]
    js["nodes"].append(nd)

IBM_f = acc(fj, fbb, peau_f["inverseBindMatrices"]).astype(np.float32)
a_ibm = pousse(IBM_f, 5126, "MAT4")
js["skins"] = [{"joints": [remap[ni] for ni in joints_f],
                "inverseBindMatrices": a_ibm,
                "skeleton": remap[joints_f[0]]}]

# rattacher : l'armature entre en scene, le maillage reference la peau
js["scenes"][js.get("scene", 0)]["nodes"].append(remap[0])
for ni, nd in enumerate(js["nodes"][:base_nd]):
    if "mesh" in nd:
        nd["skin"] = 0

anims = []
for a_f in fj.get("animations", []):
    canaux, echant = [], []
    for ch in a_f["channels"]:
        s = a_f["samplers"][ch["sampler"]]
        t_in = acc(fj, fbb, s["input"]).astype(np.float32)
        v_out = acc(fj, fbb, s["output"]).astype(np.float32)
        a_t = pousse(t_in, 5126, "SCALAR", minmax=True)
        a_v = pousse(v_out, 5126, "VEC4" if v_out.shape[1] == 4 else "VEC3")
        echant.append({"input": a_t, "output": a_v,
                       "interpolation": s.get("interpolation", "LINEAR")})
        canaux.append({"sampler": len(echant) - 1,
                       "target": {"node": remap[ch["target"]["node"]],
                                  "path": ch["target"]["path"]}})
    anims.append({"name": a_f.get("name", "clip"), "channels": canaux, "samplers": echant})
js["animations"] = anims

js["buffers"] = [{"byteLength": len(bin_out)}]
j = json.dumps(js, separators=(",", ":")).encode()
j += b" " * ((4 - len(j) % 4) % 4)
b = bytes(bin_out) + b"\0" * ((4 - len(bin_out) % 4) % 4)
with open(SORTIE, "wb") as f:
    f.write(b"glTF" + struct.pack("<II", 2, 12 + 8 + len(j) + 8 + len(b)))
    f.write(struct.pack("<I", len(j)) + b"JSON" + j)
    f.write(struct.pack("<I", len(b)) + b"BIN\0" + b)
import os
print("  ecrit : %s (%.1f Mo) — maillage texture + %d os + %d clip(s)"
      % (SORTIE, os.path.getsize(SORTIE) / 1048576, len(joints_f), len(anims)))
