"""Pont apovivor : animer un rig SkinTokens avec les clips exportes d'Unreal.

CHAINE (decision user du 2026-08-08) :
  SkinTokens genere le squelette  ->  la banque apovivor l'anime.

  1. `ue_export_anims.py` (dans l'editeur UE) sort les AnimSequence en FBX ;
  2. `fbx_vers_glb.py` (bpy) les convertit en GLB, noms d'os preserves ;
  3. ce pont lit le clip (lecteur de `mesh2motion_bridge`), le classe via les
     conventions de nommage des packs UE (`frontHip_R`, `Tail0_M`...), et le
     retargete sur le rig SkinTokens (`retarget_motion_to_rig`, qui sait
     viser les os anonymes bone_N par classification geometrique).

RAPPEL LICENCE : les packs apovivor sont sous licence Fab — usage dans TES
produits, jamais redistribues en tant qu'assets. Ce pont est un outil
personnel ; il n'entre pas dans le paquet vendu avec ces clips.

CLI :
  python apovivor_bridge.py --rig <rig_skintokens.glb> \
      --clip C:/tmp/apovivor_fbx/glb/celtic_wolfhound_run_anim.glb \
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
    # front et back partagent le role 'leg' : l'appariement de chaines du
    # retargeting est positionnel, il repartira avant/arriere tout seul
    # (meme mecanique que les 8 pattes de l'araignee sur la fourmi).
    for i, seg in enumerate(("rump", "hip", "knee", "ankle", "toe")):
        if seg in base:
            return ("leg", cote, i)
    return ("body", cote, idx)


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
        target_table=None,
        target_drop_re=None,
    )
    print("APOVIVOR_SUCCESS: %s" % out_glb, flush=True)


def main():
    ap = argparse.ArgumentParser(description="Clips apovivor sur rig SkinTokens")
    ap.add_argument("--rig", required=True)
    ap.add_argument("--clip", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--clip-name", default=None)
    a = ap.parse_args()
    animer(a.rig, a.clip, a.out, a.clip_name)


if __name__ == "__main__":
    main()
