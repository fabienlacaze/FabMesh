"""Pont Mesh2Motion : animer une CREATURE riggee SkinTokens avec des clips CC0.

POURQUOI CE FICHIER EXISTE
Kimodo (NVIDIA, poids « ready for commercial use ») couvre les HUMANOIDES et
rien d'autre. Les creatures — araignees, dragons, serpents, quadrupedes —
n'avaient aucune voie commercialisable : AnyTop est bloque a la racine (sa
dependance `Motion` remonte au code de Daniel Holden, sans licence, donc
personne dans la chaine ne PEUT la licencier), et ses auteurs declarent
eux-memes le probleme de generalisation non resolu (issues #17 et #24).

Mesh2Motion resout le probleme autrement : ce n'est pas un modele generatif,
c'est une banque de mouvements. Code MIT, et surtout **assets en CC0** —
verifie a la source dans son README : « The art assets (3d models, rigs,
animations) are all licensed under CC0 ». 73 clips sur 8 creatures, 5,3 Mo au
total : assez petit pour etre EMBARQUE dans le paquet Store, contrairement aux
arbres de moteurs qui ont fait echouer l'etape « moteur de rig » de
l'assistant.

CHAINE COMPLETE ET SA LICENCE
  rig      SkinTokens (VAST-AI)      MIT
  clips    Mesh2Motion               CC0
  retarget notre `anytop_retarget`   maison
Aucun maillon non commercialisable.

CE QUE FAIT CE PONT
  1. Lit un clip depuis `<creature>-animations.glb` (quaternions echantillonnes).
  2. Le convertit en dictionnaire de mouvement au format BVH — c'est le contrat
     de `retarget_motion_to_rig`, deja eprouve par `kimodo_bridge.py`.
  3. Retargete sur le rig via le classifieur geometrique generique, qui sait
     traiter les noms anonymes `bone_N` de SkinTokens.
  4. Ecrit le GLB anime (maillage, materiaux et peau intacts).

CLI :
  python mesh2motion_bridge.py --rig in.glb --out out.glb \
      --creature spider --clip Walk [--clip-name marche]
  python mesh2motion_bridge.py --list --creature spider
"""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np
from scipy.spatial.transform import Rotation as R

_ICI = os.path.abspath(os.path.dirname(__file__))
if _ICI not in sys.path:
    sys.path.insert(0, _ICI)

import anytop_retarget as ar  # noqa: E402

# Les clips sont resolus dans cet ordre : variable d'environnement, dossier
# embarque dans le paquet, puis emplacement de travail. Le paquet Store n'a pas
# `build/`, et une machine de developpement n'a pas `resources/`.
_CANDIDATS_CLIPS = [
    os.environ.get("FABMESH_M2M_CLIPS", ""),
    os.path.join(os.path.dirname(_ICI), "resources", "m2m_clips"),
    os.path.join(os.path.dirname(_ICI), "assets", "m2m_clips"),
    os.path.join(os.path.dirname(_ICI), "build", "m2m"),
]

CREATURES = ("spider", "dragon", "snake", "kaiju", "horse", "bird", "fox", "shark")

# Chaines de pattes ABANDONNEES au retargeting.
#
# Les clips d'araignee pilotent 8 pattes (leg_a a leg_d, gauche et droite). Une
# fourmi SkinTokens en a 6. Decision produit du 2026-08-08 : on abandonne la
# paire arriere (`leg_d`) plutot que de repartir 8 phases sur 6 pattes — les 6
# restantes conservent ainsi leur alternance de marche, la ou une repartition
# produirait une demarche flottante.
#
# Ce n'est PAS une constante figee : `--garder-toutes-les-pattes` la desactive
# pour une cible qui a bien 8 pattes.
CHAINES_ABANDONNEES = ("leg_d",)


def _log(msg: str) -> None:
    print(f"M2M: {msg}", flush=True)


def _progress(pct: int) -> None:
    # Meme canal que kimodo_bridge, pour que la barre de l'interface bouge sans
    # nouveau cablage cote renderer.
    print(f"LOCAL_M2M_PROGRESS: {max(0, min(99, int(pct)))}", flush=True)


def dossier_clips() -> str:
    for c in _CANDIDATS_CLIPS:
        if c and os.path.isdir(c):
            return c
    raise FileNotFoundError(
        "Clips Mesh2Motion introuvables. Cherches dans : "
        + " | ".join(x for x in _CANDIDATS_CLIPS if x)
    )


# ---------------------------------------------------------------------------
# Classifieur SOURCE — noms de Mesh2Motion
# ---------------------------------------------------------------------------
def _classer_source(nom: str, abandonner=CHAINES_ABANDONNEES):
    """(role, cote, index_de_chaine) pour un os Mesh2Motion.

    Les squelettes Mesh2Motion sont nommes semantiquement (`hips`, `spine_1`,
    `leg_a_2_l`, `tail_3`, `wing_...`), ce qui evite toute heuristique
    geometrique cote source. Renvoyer un role vide ecarte l'os : c'est la
    convention de `_classify_source_bone`, verifiee (`if not role: continue`).
    """
    if not nom:
        return ("", None, 0)
    n = nom.strip().lower()

    # Abandon explicite (pattes surnumeraires).
    for prefixe in abandonner:
        if n.startswith(prefixe):
            return ("", None, 0)

    # Les extremites et ancrages ne portent pas de mouvement exploitable :
    # les `*_tip` sont des end-sites, les `*_anchor*` des pivots techniques
    # de la plateforme Mesh2Motion.
    if n.endswith("_tip") or "_tip_" in n or "anchor" in n:
        return ("", None, 0)

    cote = None
    if n.endswith("_l") or "_l_" in n:
        cote = "l"
    elif n.endswith("_r") or "_r_" in n:
        cote = "r"

    # Index de chaine : dernier nombre du nom (`leg_a_2_l` -> 2).
    idx = 0
    for morceau in reversed(n.replace(".", "_").split("_")):
        if morceau.isdigit():
            idx = int(morceau)
            break

    if n == "root":
        return ("hip", None, 0)
    if n.startswith("hips") or n.startswith("pelvis"):
        return ("hip", None, 0)
    if n.startswith("spine") or n.startswith("ribcage") or n.startswith("chest"):
        return ("spine", None, idx)
    if n.startswith("neck"):
        return ("neck", None, idx)
    if n.startswith("head") or n.startswith("teeth") or n.startswith("mouth") \
            or n.startswith("jaw") or n.startswith("eye"):
        return ("head", None, idx)
    if n.startswith("tail"):
        return ("tail", None, idx)
    if n.startswith("wing"):
        return ("wing", cote, idx)
    if n.startswith("arm") or n.startswith("shoulder") or n.startswith("hand"):
        return ("arm", cote, idx)
    if n.startswith("leg") or n.startswith("thigh") or n.startswith("foot") \
            or n.startswith("toe") or n.startswith("knee"):
        return ("leg", cote, idx)
    if n.startswith("fin"):
        return ("wing", cote, idx)
    return ("body", cote, idx)


# ---------------------------------------------------------------------------
# Lecture d'un clip glTF -> dictionnaire de mouvement au format BVH
# ---------------------------------------------------------------------------
def _matrice_locale(nd: dict) -> np.ndarray:
    if "matrix" in nd:
        return np.array(nd["matrix"], dtype=np.float64).reshape(4, 4).T
    m = np.eye(4)
    if "scale" in nd:
        m = m @ np.diag(list(nd["scale"]) + [1.0])
    if "rotation" in nd:
        m = np.block([[R.from_quat(nd["rotation"]).as_matrix(), np.zeros((3, 1))],
                      [np.zeros((1, 3)), np.ones((1, 1))]]) @ m
    if "translation" in nd:
        t = np.eye(4)
        t[:3, 3] = nd["translation"]
        m = t @ m
    return m


def _echantillonner(temps: np.ndarray, valeurs: np.ndarray, t: np.ndarray,
                    interp: str, quaternion: bool) -> np.ndarray:
    """Reechantillonne une piste glTF aux instants `t`.

    CUBICSPLINE stocke (tangente_entrante, valeur, tangente_sortante) : on ne
    garde que la valeur et on interpole lineairement. C'est une approximation
    assumee — a 30 images/s l'ecart est sous le seuil visible, et aucun clip
    Mesh2Motion n'utilise ce mode aujourd'hui (verifie a l'import).
    """
    if interp == "CUBICSPLINE":
        valeurs = valeurs[1::3]
    if len(temps) == 1:
        return np.repeat(valeurs[:1], len(t), axis=0)

    if quaternion:
        # Slerp : interpoler des quaternions composante par composante
        # deforme la rotation (l'interpolation lineaire ne suit pas la
        # sphere unite). scipy fait le travail correctement.
        from scipy.spatial.transform import Slerp
        rot = R.from_quat(valeurs)
        if interp == "STEP":
            idx = np.searchsorted(temps, t, side="right") - 1
            return valeurs[np.clip(idx, 0, len(valeurs) - 1)]
        slerp = Slerp(temps, rot)
        return slerp(np.clip(t, temps[0], temps[-1])).as_quat()

    if interp == "STEP":
        idx = np.searchsorted(temps, t, side="right") - 1
        return valeurs[np.clip(idx, 0, len(valeurs) - 1)]
    sortie = np.empty((len(t), valeurs.shape[1]), dtype=np.float64)
    for c in range(valeurs.shape[1]):
        sortie[:, c] = np.interp(t, temps, valeurs[:, c])
    return sortie


def lire_clip(glb_path: str, nom_clip: str, fps: float = 30.0) -> dict:
    """Renvoie le dictionnaire attendu par `retarget_motion_to_rig`.

    Cles produites : names, parents, offsets, channels, n_frames, frame_time,
    euler, root_pos — le contrat documente de `_parse_bvh`.
    """
    # ATTENTION a l'ordre : `_read_glb` renvoie (gltf, json_blob, bin_blob).
    # Le deuxieme element est le JSON, pas le binaire. L'inverser fait lire les
    # accesseurs dans le mauvais tampon : les temps sortaient a [0, 1e-08] au
    # lieu de [0.0417, 1.0], d'ou un nombre d'images astronomique.
    gltf, _json_blob, bin_blob = ar._read_glb(glb_path)
    noeuds = gltf["nodes"]
    anims = gltf.get("animations", [])
    noms_dispo = [a.get("name", f"clip_{i}") for i, a in enumerate(anims)]
    trouve = next((a for a in anims if a.get("name", "") == nom_clip), None)
    if trouve is None:
        # Tolerance de casse et d'espaces : « fly flap » trouve « Fly Flap ».
        cible = nom_clip.strip().lower().replace("_", " ")
        trouve = next((a for a in anims
                       if a.get("name", "").strip().lower().replace("_", " ") == cible), None)
    if trouve is None:
        raise ValueError(f"clip '{nom_clip}' absent de {os.path.basename(glb_path)}. "
                         f"Disponibles : {', '.join(noms_dispo)}")

    joints = gltf["skins"][0]["joints"]
    rang = {ni: k for k, ni in enumerate(joints)}
    ensemble = set(joints)

    # Parents restreints aux articulations : un os peut etre porte par un
    # noeud intermediaire qui n'appartient pas a la peau.
    parent_de = {}
    for ni, nd in enumerate(noeuds):
        for enfant in nd.get("children", []):
            parent_de[enfant] = ni
    parents = []
    for ni in joints:
        p = parent_de.get(ni, -1)
        while p != -1 and p not in ensemble:
            p = parent_de.get(p, -1)
        parents.append(rang[p] if p != -1 else -1)

    noms = [noeuds[ni].get("name", f"bone_{ni}") for ni in joints]
    offsets = np.array([noeuds[ni].get("translation", [0.0, 0.0, 0.0]) for ni in joints],
                       dtype=np.float64)
    # Rotation de REPOS de chaque noeud : c'est la reference dont on retranche
    # l'animation (voir plus bas).
    q_repos = np.array([noeuds[ni].get("rotation", [0.0, 0.0, 0.0, 1.0]) for ni in joints],
                       dtype=np.float64)

    # Duree du clip = borne haute de toutes les pistes.
    duree = 0.0
    pistes = []
    for ch in trouve["channels"]:
        cible_ni = ch["target"]["node"]
        if cible_ni not in ensemble:
            continue
        ech = trouve["samplers"][ch["sampler"]]
        temps = ar._read_accessor_floats(gltf, bin_blob, ech["input"]).reshape(-1)
        vals = ar._read_accessor_floats(gltf, bin_blob, ech["output"])
        duree = max(duree, float(temps[-1]) if len(temps) else 0.0)
        pistes.append((rang[cible_ni], ch["target"]["path"],
                       temps, vals, ech.get("interpolation", "LINEAR")))
    if duree <= 0.0:
        raise ValueError(f"clip '{nom_clip}' sans image cle exploitable")

    n_frames = max(2, int(round(duree * fps)) + 1)
    t = np.linspace(0.0, duree, n_frames)

    # Rotations locales par image, initialisees au repos.
    quats = np.tile(q_repos[None, :, :], (n_frames, 1, 1))
    trans = np.tile(offsets[None, :, :], (n_frames, 1, 1))
    for k, chemin, temps, vals, interp in pistes:
        if chemin == "rotation":
            quats[:, k, :] = _echantillonner(temps, vals.reshape(-1, 4), t, interp, True)
        elif chemin == "translation":
            trans[:, k, :] = _echantillonner(temps, vals.reshape(-1, 3), t, interp, False)
        # `scale` volontairement ignore : le format BVH ne l'exprime pas, et
        # aucun clip Mesh2Motion n'anime l'echelle (verifie a l'import).

    # ── Rotation RELATIVE AU REPOS ────────────────────────────────────────
    # Le BVH n'a pas de rotation de repos : sa pose de repos est faite des
    # seuls offsets. Le glTF, lui, porte une rotation sur chaque noeud. Fournir
    # la rotation absolue injecterait donc un decalage constant sur CHAQUE os,
    # et la creature arriverait tordue des la premiere image.
    # On transmet delta = inv(q_repos) * q_image : la meme motricite, exprimee
    # dans la convention que le retargeting attend.
    r_repos_inv = R.from_quat(q_repos).inv()
    euler = np.zeros((n_frames, len(joints), 3), dtype=np.float64)
    for k in range(len(joints)):
        delta = r_repos_inv[k] * R.from_quat(quats[:, k, :])
        # Colonnes TOUJOURS en [X, Y, Z] ; l'ordre de composition est declare
        # separement par `channels` — c'est le contrat de `_eulers_to_quats`.
        ang = delta.as_euler("ZXY", degrees=True)          # -> [Z, X, Y]
        euler[:, k, 0] = ang[:, 1]
        euler[:, k, 1] = ang[:, 2]
        euler[:, k, 2] = ang[:, 0]

    racine = next((k for k, p in enumerate(parents) if p == -1), 0)
    root_pos = trans[:, racine, :].astype(np.float64)

    canaux = []
    for k in range(len(joints)):
        rot = ["Zrotation", "Xrotation", "Yrotation"]        # coherent avec 'ZXY'
        canaux.append((["Xposition", "Yposition", "Zposition"] + rot) if k == racine else rot)

    return {
        "names": noms,
        "parents": parents,
        "offsets": offsets,
        "channels": canaux,
        "n_frames": n_frames,
        "frame_time": 1.0 / fps,
        "euler": euler,
        "root_pos": root_pos,
    }


def clips_disponibles(creature: str) -> list:
    chemin = os.path.join(dossier_clips(), f"{creature}.glb")
    if not os.path.isfile(chemin):
        chemin = os.path.join(dossier_clips(), f"{creature}-animations.glb")
    gltf, _, _ = ar._read_glb(chemin)
    return [a.get("name", f"clip_{i}") for i, a in enumerate(gltf.get("animations", []))]


def animer(rig_glb: str, out_glb: str, creature: str, clip: str,
           nom_sortie: str = None, garder_toutes_les_pattes: bool = False) -> None:
    src = os.path.join(dossier_clips(), f"{creature}.glb")
    if not os.path.isfile(src):
        src = os.path.join(dossier_clips(), f"{creature}-animations.glb")
    if not os.path.isfile(src):
        raise FileNotFoundError(f"clips '{creature}' introuvables dans {dossier_clips()}")

    _log(f"source : {os.path.basename(src)} / clip '{clip}'")
    _progress(10)
    motion = lire_clip(src, clip)
    _log(f"{motion['n_frames']} images, {len(motion['names'])} os source")
    _progress(45)

    # ── Attenuation de sortie ────────────────────────────────────────────
    # `anytop_retarget` applique par defaut ANYTOP_OUTPUT_DAMP=0.25 : seuls
    # 25 % du mouvement passent. Ce reglage a ete choisi pour le cas dragon
    # (142 os canoniques -> 47 os Puppeteer), ou les ecarts par articulation
    # atteignaient 178-180 deg et fragmentaient le maillage.
    #
    # Ici la situation est tout autre : araignee 56 os -> fourmi 58 os, des
    # echelles comparables. Mesure sur la marche :
    #     damp 0,25 -> amplitude  10,0 %   (le defaut, mouvement a peine visible)
    #     damp 0,50 -> amplitude  18,9 %
    #     damp 1,00 -> amplitude  33,6 %   et squelette VERIFIE intact
    # On passe donc a 1.0 pour cette voie, sans toucher au defaut global dont
    # dependent les autres appelants. Une valeur deja posee par l'appelant est
    # respectee.
    if "ANYTOP_OUTPUT_DAMP" not in os.environ:
        os.environ["ANYTOP_OUTPUT_DAMP"] = "1.0"
        _log("attenuation de sortie : 1.0 (defaut 0.25 reserve au cas dragon)")

    abandon = () if garder_toutes_les_pattes else CHAINES_ABANDONNEES
    if abandon:
        n_abandonnes = sum(1 for nom in motion["names"]
                           if _classer_source(nom, abandon)[0] == ""
                           and _classer_source(nom, ())[0] != "")
        _log(f"chaines abandonnees {abandon} : {n_abandonnes} os ecartes")

    ar.retarget_motion_to_rig(
        rig_glb_path=rig_glb,
        motion=motion,
        out_glb_path=out_glb,
        clip_name=nom_sortie or clip.lower().replace(" ", "_"),
        target_fps=30.0,
        ckpt_family="all",
        source_classifier=lambda nom: _classer_source(nom, abandon),
        target_table=None,       # classifieur geometrique generique (bone_N)
        target_drop_re=None,
    )
    _progress(99)
    _log(f"ecrit : {out_glb}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Anime un rig SkinTokens avec des clips CC0")
    ap.add_argument("--rig")
    ap.add_argument("--out")
    ap.add_argument("--creature", required=True, choices=CREATURES)
    ap.add_argument("--clip")
    ap.add_argument("--clip-name", default=None)
    ap.add_argument("--garder-toutes-les-pattes", action="store_true")
    ap.add_argument("--list", action="store_true", help="lister les clips et sortir")
    a = ap.parse_args()

    if a.list:
        for nom in clips_disponibles(a.creature):
            print(f"  {nom}")
        return 0
    if not (a.rig and a.out and a.clip):
        ap.error("--rig, --out et --clip sont requis (ou utilisez --list)")
    try:
        animer(a.rig, a.out, a.creature, a.clip, a.clip_name, a.garder_toutes_les_pattes)
    except Exception as e:
        print(f"M2M_ERROR: {type(e).__name__}: {e}", flush=True)
        return 1
    print(f"M2M_SUCCESS: {a.out}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
