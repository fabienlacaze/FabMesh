"""Extrait un GLB SQUELETTE SEUL, animation comprise, depuis un GLB rigge.

POURQUOI
Juger une animation ne demande pas le maillage. Un GLB de production porte ici
1,5 M de sommets pour 69 Mo : le telecharger dans un visualiseur prend des
dizaines de secondes pendant lesquelles la page parait plantee, alors que
l'information utile — le mouvement des os — pese quelques dizaines de kilo-octets.

Ce script garde la hierarchie de noeuds et les pistes d'animation, jette
maillages, peaux, materiaux et textures, puis RECOMPACTE le tampon binaire pour
n'y laisser que les accesseurs encore references. Sans ce compactage le fichier
resterait aussi lourd : supprimer une reference ne supprime pas les octets.

  python glb_squelette_seul.py entree.glb sortie.glb
"""
import json
import struct
import sys


def lire(chemin):
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
            bb = bloc
        off += 8 + lg
    return js, (bb or b"")


def ecrire(chemin, js, bb):
    j = json.dumps(js, separators=(",", ":")).encode("utf-8")
    j += b" " * ((4 - len(j) % 4) % 4)
    b = bb + b"\x00" * ((4 - len(bb) % 4) % 4)
    total = 12 + 8 + len(j) + (8 + len(b) if b else 0)
    with open(chemin, "wb") as f:
        f.write(b"glTF" + struct.pack("<II", 2, total))
        f.write(struct.pack("<I", len(j)) + b"JSON" + j)
        if b:
            f.write(struct.pack("<I", len(b)) + b"BIN\x00" + b)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    js, bb = lire(src)

    anims = js.get("animations", [])
    if not anims:
        print("  ATTENTION : aucune animation dans la source")

    # 1. Accesseurs encore utiles = ceux des echantillonneurs d'animation.
    gardes = set()
    for a in anims:
        for s in a.get("samplers", []):
            gardes.add(s["input"])
            gardes.add(s["output"])
    gardes = sorted(gardes)
    remap = {vieux: neuf for neuf, vieux in enumerate(gardes)}

    # 2. Recopier les octets de ces seuls accesseurs, serres.
    _T = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
    _N = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
    neuf_bin = bytearray()
    neufs_acc, neufs_bv = [], []
    for vieux in gardes:
        a = js["accessors"][vieux]
        bv = js["bufferViews"][a["bufferView"]]
        taille = _T[a["componentType"]] * _N[a["type"]]
        pas = bv.get("byteStride") or taille
        base = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        if pas == taille:
            donnees = bb[base: base + taille * a["count"]]
        else:
            # Accesseur entrelace : on le deserre, sinon l'offset n'a plus de sens
            # une fois les autres accesseurs retires.
            donnees = b"".join(bb[base + k * pas: base + k * pas + taille]
                               for k in range(a["count"]))
        while len(neuf_bin) % 4:
            neuf_bin.append(0)
        depart = len(neuf_bin)
        neuf_bin.extend(donnees)
        neufs_bv.append({"buffer": 0, "byteOffset": depart, "byteLength": len(donnees)})
        neufs_acc.append({
            "bufferView": len(neufs_bv) - 1, "byteOffset": 0,
            "componentType": a["componentType"], "count": a["count"], "type": a["type"],
            **({"min": a["min"]} if "min" in a else {}),
            **({"max": a["max"]} if "max" in a else {}),
        })

    # 3. Reindexer les echantillonneurs.
    for a in anims:
        for s in a.get("samplers", []):
            s["input"] = remap[s["input"]]
            s["output"] = remap[s["output"]]

    # 4. Noeuds : retirer maillage et peau, garder la hierarchie et les transformations.
    for n in js.get("nodes", []):
        n.pop("mesh", None)
        n.pop("skin", None)
        n.pop("camera", None)

    # On CONSERVE `skins` — sans elles, un lecteur glTF ne reconnait plus les
    # noeuds comme des OS : three.js n'instancie `Bone` que pour les noeuds cites
    # dans `skin.joints`, et `SkeletonHelper` ne dessine alors plus rien. La
    # premiere version jetait les peaux et produisait un fichier de 54 Ko
    # parfaitement vide a l'ecran.
    # En revanche `inverseBindMatrices` part : ces matrices ne servent qu'a
    # deformer un maillage, qu'on vient justement de retirer.
    for peau in js.get("skins", []):
        peau.pop("inverseBindMatrices", None)
    for cle in ("meshes", "materials", "textures", "images", "samplers"):
        js.pop(cle, None)
    js["accessors"] = neufs_acc
    js["bufferViews"] = neufs_bv
    js["buffers"] = [{"byteLength": len(neuf_bin)}]
    js["animations"] = anims

    ecrire(dst, js, bytes(neuf_bin))
    import os
    print("  %s : %.1f Mo  ->  %s : %.1f Ko  (%d os, %d clips)"
          % (os.path.basename(src), os.path.getsize(src) / 1048576,
             os.path.basename(dst), os.path.getsize(dst) / 1024,
             len(js.get("nodes", [])), len(anims)))


if __name__ == "__main__":
    main()
