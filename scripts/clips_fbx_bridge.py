"""Pont CLIPS PERSONNELS : animer un rig SkinTokens avec des clips FBX/GLB.

Renomme depuis `apovivor_bridge.py` le 2026-08-09 : le filtre de paquetage
exclut `apovivor_*.py` (nom du projet personnel du developpeur), la
fonctionnalite n'etait donc JAMAIS livree. Elle vaut pourtant comme
argument de vente : tout client possedant des packs Mixamo, Fab ou maison
peut brancher FabMesh dessus.

CHAINE (decision user du 2026-08-08) :
  SkinTokens genere le squelette  ->  une banque de clips l'anime.

  1. `ue_export_anims.py` (dans l'editeur UE) sort les AnimSequence en FBX ;
  2. `fbx_vers_glb.py` (bpy) les convertit en GLB, noms d'os preserves ;
  3. ce pont lit le clip (lecteur de `mesh2motion_bridge`), le classe via les
     conventions de nommage des packs UE (`frontHip_R`, `Tail0_M`...), et le
     retargete sur le rig SkinTokens (`retarget_motion_to_rig`, qui sait
     viser les os anonymes bone_N par classification geometrique).

RAPPEL LICENCE : ce pont ne distribue AUCUN clip — il lit ceux que
l'utilisateur possede deja. Les packs commerciaux (Fab, Mixamo...) restent
soumis a leur propre licence : usage dans les produits de leur acheteur,
jamais redistribues en tant qu'assets.

CLI :
  python clips_fbx_bridge.py --rig <rig_skintokens.glb> \
      --clip <dossier>/mon_clip.glb \
      --out sortie.glb [--clip-name course]
"""
from __future__ import annotations

import argparse
import os
import re
import sys

_ICI = os.path.abspath(os.path.dirname(__file__))
if _ICI not in sys.path:
    sys.path.insert(0, _ICI)

import anytop_retarget as ar          # noqa: E402
import mesh2motion_bridge as m2m      # noqa: E402


def classer_ue(nom: str):
    """(role, cote, index) pour les conventions des packs animaliers UE.

    Exemples reels (celtic_wolfhound, 41 os) : frontRump_R, backKnee_L,
    Tail0_M, RootPart1_M, Spine1_M, Chest_M, NeckPart2_M, Head_M, Jaw_M,
    Ear02_L. Suffixe _R/_L = cote, _M = axe. Renvoyer un role vide ecarte
    l'os (convention de `retarget_motion_to_rig`).
    """
    n = nom.strip().lower()
    cote = None
    if n.endswith("_r"):
        cote = "r"
    elif n.endswith("_l"):
        cote = "l"
    base = n[:-2] if n.endswith(("_r", "_l", "_m")) else n
    m = re.search(r"(\d+)", base)
    idx = int(m.group(1)) if m else 0

    if "tail" in base:
        return ("tail", None, idx)
    if "root" in base:
        return ("hip", None, 0)
    if "spine" in base or "chest" in base:
        return ("spine", None, idx + (3 if "chest" in base else 0))
    if "neck" in base:
        return ("neck", None, idx)
    if "head" in base or "jaw" in base:
        return ("head", None, idx)
    if "ear" in base or "eye" in base:
        return ("", None, 0)          # pas de correspondant chez la cible
    # membres : rump -> hip -> knee -> ankle -> toes = segments 0..4.
    # AVANT -> 'arm', ARRIERE -> 'leg'. Raison decouverte le 2026-08-09 :
    # _build_chains groupe les os par (role, cote) — deux pattes du meme cote
    # partageant 'leg' sont FUSIONNEES en une pseudo-chaine entrelacee, d'ou
    # « les pattes bougent mal ». Mon ancienne hypothese (« l'appariement
    # positionnel repartit avant/arriere ») etait fausse : il n'y a pas
    # d'appariement multi-chaines. Des roles distincts = plus de fusion.
    for i, seg in enumerate(("rump", "hip", "knee", "ankle", "toe")):
        if seg in base:
            return (("arm" if "front" in base else "leg"), cote, i)
    return ("body", cote, idx)


def table_cible_quadrupede(rig_glb: str, avant: str = "z+"):
    """Table {nom_os_minuscule: (role, cote, index)} pour un rig natif bone_N.

    Meme mecanique d'epluchage que le recalage : chaines disjointes, paires
    miroir laterales triees d'avant en arriere. La PREMIERE paire (avant)
    recoit le role 'arm', la seconde 'leg' — pour empecher la fusion des
    pattes dans _build_chains (voir classer_ue). Chaines centrales : vers
    l'arriere = queue ; le tronc = hip/spine/head.
    """
    import numpy as np
    from gabarit_recaler import lire, squelette, chaines, longueur

    js, _ = lire(rig_glb)
    _, noms, pj, pos = squelette(js)
    ch, _enf = chaines(pj, pos)
    F = 1.0 if avant == "z+" else -1.0

    ech_x = float(pos[:, 0].max() - pos[:, 0].min()) or 1.0
    lats, centraux = [], []
    for embr, seg in ch:
        d = {"seg": seg, "A": pos[seg[0]], "E": pos[seg[-1]],
             "long": longueur(pos[seg])}
        (lats if abs(d["E"][0]) > 0.08 * ech_x else centraux).append(d)

    # paires miroir mutuelles, jumeau synthetique pour les orphelines franches
    gauche = [d for d in lats if d["E"][0] > 0]
    droite = [d for d in lats if d["E"][0] < 0]
    def miroir(p):
        return np.array([-p[0], p[1], p[2]])
    paires, pris = [], set()
    for g in sorted(gauche, key=lambda d: -F * d["A"][2]):
        cands = sorted(((np.linalg.norm(miroir(g["A"]) - dr["A"])
                         + np.linalg.norm(miroir(g["E"]) - dr["E"]), j)
                        for j, dr in enumerate(droite) if j not in pris))
        if cands:
            pris.add(cands[0][1])
            paires.append((g, droite[cands[0][1]]))
    long_max = max((d["long"] for d in lats), default=1.0)
    en_paire = {id(x) for p in paires for x in p}
    for d in lats:
        if id(d) not in en_paire and d["long"] >= 0.3 * long_max:
            paires.append((d, None) if d["E"][0] > 0 else (None, d))
    paires.sort(key=lambda p: -F * float(np.mean(
        [x["A"][2] for x in p if x is not None])))

    table = {}
    roles_membres = ["arm", "leg", "leg", "leg"]        # avant puis arrieres
    for rang, (g, dr) in enumerate(paires[:4]):
        role = roles_membres[min(rang, 3)]
        for cote, d in (("l", g), ("r", dr)):
            if d is None:
                continue
            for i, b in enumerate(d["seg"]):
                table[noms[b].lower()] = (role, cote, i)
    for d in centraux:
        arriere = F * (d["E"] - d["A"])[2] < 0
        for i, b in enumerate(d["seg"]):
            nom = noms[b].lower()
            if nom in table:
                continue
            if arriere:
                table[nom] = ("tail", None, i)
            else:
                # tronc : premier os = hanche, dernier = tete, entre = colonne
                if i == 0 and pj[b] == -1:
                    table[nom] = ("hip", None, 0)
                elif i >= len(d["seg"]) - 1:
                    table[nom] = ("head", None, 0)
                else:
                    table[nom] = ("spine", None, i)
    print("CLIPS: table cible — %d os classes (%d paires de membres)"
          % (len(table), len(paires)), flush=True)
    return table


def animer(rig_glb: str, clip_glb: str, out_glb: str, nom_sortie: str | None):
    # nom du clip : les exports UE n'en ont qu'un, au nom impose par le
    # convertisseur (« Root_M|Unreal Take|Base Layer ») — on prend le premier.
    gltf, _, _ = ar._read_glb(clip_glb)
    anims = gltf.get("animations", [])
    if not anims:
        raise SystemExit("aucune animation dans " + clip_glb)
    nom_clip = anims[0].get("name", "clip_0")

    # attenuation : meme raisonnement que mesh2motion_bridge — le defaut 0.25
    # est calibre pour le cas dragon 142->47 os ; ici les echelles sont
    # comparables (wolfhound 41 os -> rig natif ~30-60 os).
    if "ANYTOP_OUTPUT_DAMP" not in os.environ:
        os.environ["ANYTOP_OUTPUT_DAMP"] = "1.0"

    motion = m2m.lire_clip(clip_glb, nom_clip)
    print("M2M: clip '%s' : %d images, %d os source"
          % (nom_clip, motion["n_frames"], len(motion["names"])), flush=True)

    ar.retarget_motion_to_rig(
        rig_glb_path=rig_glb,
        motion=motion,
        out_glb_path=out_glb,
        clip_name=nom_sortie or os.path.splitext(os.path.basename(clip_glb))[0],
        target_fps=30.0,
        ckpt_family="all",
        source_classifier=classer_ue,
        target_table=table_cible_quadrupede(rig_glb),
        target_drop_re=None,
    )
    print("CLIPS_SUCCESS: %s" % out_glb, flush=True)


def main():
    ap = argparse.ArgumentParser(description="Clips personnels sur rig SkinTokens")
    ap.add_argument("--rig", required=True)
    ap.add_argument("--clip", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--clip-name", default=None)
    a = ap.parse_args()
    animer(a.rig, a.clip, a.out, a.clip_name)


if __name__ == "__main__":
    main()
