"""
FabMesh — Outil « Tenue » V1 (outfit_repaint.py)
================================================

Repeint les VETEMENTS d'un personnage 3D texture (GLB) a partir d'un prompt,
en mode TEXTURE-ONLY : geometrie, UV, rig (skinning SkinTokens) et visage
restent strictement intacts. Seule l'image baseColor de l'atlas change
(swap in-place via texture_refine.replace_glb_atlas — jamais de re-export
trimesh qui perdrait le skinning).

Pipeline (V1, personnages humanoides d'abord) :
  1. Segmentation en parties  : partsam_bridge.py (subprocess, interpreteur
     dedie <repo>/python-segment/python.exe + FABMESH_PARTSAM_DIR).
  2. Nommage semantique       : name_parts.py (voie squelette ou vision).
     Selection vetements = parts {torso, arm, leg} (prefixes left_/right_
     acceptes), exclusion dure {head, hair, hand, foot, weapon, shield}.
     FALLBACK (PartSAM/namer KO) : heuristique geometrique par hauteur
     (tout sauf tete/mains — voir fallback_face_mask()).
  3. Masque texels            : rasterisation des triangles UV des faces
     vetement (convention x=u*R, y=(1-v)*R identique a texture_project).
     DEUX masques distincts, ne jamais les confondre :
       - mask_paint   = rasterisation NON dilatee = appartenance. Seul lui
         autorise le fill et compte dans la couverture.
       - mask_feather = version dilatee de 1-2 texels + flou = POIDS de
         composite uniquement (anti-couture).
     Le masque visage atlas (face_inpaint_atlas / texture_refine
     --protect-face) est soustrait, mais seulement s'il couvre < 15 % de
     l'atlas : au-dela il n'est pas discriminant (mesure : 65 % sur un
     atlas TRELLIS-2) et amputerait le vetement.
  4. Rendus ortho multi-vues  : pyrender, contrat cameras MVAdapter de
     fabmesh_6views_runner.py (get_c2w / get_ortho_proj / mesh2std /
     rescale) — le SEUL contrat compatible avec le chemin orthographique
     de texture_project (proj[1,1] negatif = flip Y integre, PAS de
     re-flip V). Eclairage flat (ambient 1.0, aucune directionnelle).
  5. Inpaint SDXL sequentiel  : type TEXTure — vue de face d'abord, puis
     chaque vue suivante n'inpainte que les texels non encore couverts
     (le deja-peint re-rendu sert de contexte de coherence). Checkpoint
     diffusers/stable-diffusion-xl-1.0-inpainting-0.1 charge IN-PROCESS
     (le POST /mask_inpaint du sdxl_server a une strength FIGEE a 0.99,
     inutilisable pour le slider).
  6. Reprojection vues→atlas  : kernel stack de texture_project
     (_raster_core_jit, V=1, prio=1.0, alpha = masque 2D d'inpaint),
     composite restreint au masque texels + feather.
  7. Remplissage texels non vus (aisselles, entrejambe, micro-triangles
     rates par la rasterisation conservative) : fill nearest (EDT) depuis
     les texels peints + Telea rayon 3, BORNE A 8 TEXELS. Au-dela, la
     texture d'origine est conservee.
     COMPROMIS documente : le _push_pull_fill de texture_project est une
     closure locale non importable ; le fill EDT-nearest + Telea produit
     le meme comportement (couleur locale continue) sur les petites
     zones concernees.
     Le composite final est gate par les texels REELLEMENT peints ou
     remplis (`touched`), jamais par le masque vetement seul.

LIMITES V1 connues (mesurees, pas supposees) :
  - Seule la baseColor change. La metallicRoughnessTexture d'origine
    reste : une armure d'acier peinte sur une MR de tissu rendra mate.
  - Sortie JPEG (qualite 92) : un cutout en alphaMode MASK/BLEND serait
    perdu. Le mesh de test est OPAQUE, sans effet.
  - Couverture directe mesuree 55 % (4 vues, atlas 1024) / 73 % (6 vues,
    atlas 2048) ; le reste est bouche par le fill borne. --tex-res 2048
    est le meilleur levier qualite.
  - Sans PartSAM, le mode degrade repeint « tout ce qui est sous 70 % de
    la hauteur », armes et os compris (voir fallback_face_mask).

CLI :
    python outfit_repaint.py --mesh in.glb --prompt "medieval armor"
        --strength 0.75 [--seed 42] [--out out.glb] [--views 4]
        [--granularity 0.2] [--asset-type character] [--rig rigged.glb]
        [--segmented seg.glb]

  --strength : denoise SDXL 0.3 → 1.0. ATTENTION : le checkpoint
      inpainting-0.1 est entraine a strength≈1 ; a 0.3-0.5 il agit en
      « recoloration douce » (comportement voulu par le slider, qualite
      moindre qu'un vrai img2img — limite connue, documentee).

Contrat bridge (stdout) :
    OUTFIT_PROGRESS: <int 0-99>   (reguliers)
    OUTFIT_OK: <chemin_absolu>    (final)
  Erreurs sur stderr + exit != 0. Logs prefixes `[outfit] `.

Interpreteur cible : venv IA <repo>/external/TRELLIS2_win/.venv (torch cu128,
diffusers, transformers, PIL, numpy, numba, trimesh, pyrender, scipy).

Env :
    FABMESH_SEGMENT_PYTHON      chemin python-segment (def <repo>/python-segment/python.exe).
                                Pose sur un chemin inexistant = opt-out
                                explicite de PartSAM (mode degrade).
    FABMESH_PARTSAM_DIR         repo PartSAM (def <repo>/PartSAM)
    FABMESH_VRAM_FRACTION       cap VRAM torch (def 0.95)
    FABMESH_OUTFIT_KEEP_SCRATCH =1 pour garder le dossier .outfit_scratch
    FABMESH_OUTFIT_STACK_FLOOR / _FULL   feather stack (def 0.10 / 0.45)
    FABMESH_OUTFIT_BAKE_EXP     exposant visibilite ortho (def 1.0)
    FABMESH_OUTFIT_DEPTH_EPS    epsilon depth-diff (def 2e-3, mesh normalise)

Licences : pyrender (MIT), trimesh (MIT), OpenCV Haar (BSD), SDXL
inpainting-0.1 (OpenRAIL++-M), numba/scipy (BSD). PAS de nvdiffrast.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import threading
import time

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(SCRIPTS)
sys.path.insert(0, SCRIPTS)

os.environ.setdefault('PYTHONUTF8', '1')

SDXL_SERVER = 'http://127.0.0.1:5555'
SDXL_INPAINT_CKPT = 'diffusers/stable-diffusion-xl-1.0-inpainting-0.1'

# Contrat cameras MVAdapter (fabmesh_6views_runner.py, valide prod voies B/C)
CAM_DISTANCE = 1.8
CAM_L, CAM_R, CAM_B, CAM_T = -0.55, 0.55, -0.55, 0.55

NEGATIVE_PROMPT = ('blurry, distorted, deformed, extra limbs, nude, naked, '
                   'changed face, changed skin, watermark, text, low quality')

# Ordre sequentiel TEXTure : face d'abord (masque complet), puis les autres
# vues ne peignent que les texels encore non couverts.
VIEWS_4 = [('front', 0.0, 0.0), ('back', 180.0, 0.0),
           ('right', 90.0, 0.0), ('left', 270.0, 0.0)]
VIEWS_6 = VIEWS_4 + [('top', 0.0, 89.99), ('bottom', 0.0, -89.99)]

# `pelvis` est emis par la voie squelette du namer (bone_zones.json /
# coarse_labels_from_positions) : c'est le bas du vetement (pantalon, jupe,
# ceinture) — sans lui la tenue s'arretait a la taille.
GARMENT_LABELS = {'torso', 'arm', 'leg', 'pelvis'}
EXCLUDED_LABELS = {'head', 'hair', 'hand', 'foot', 'weapon', 'shield',
                   'tail', 'wing'}

# Un masque « visage » qui couvre plus que ca n'est pas un visage : sur les
# atlas confettis la projection UV d'une bbox ecran deborde partout.
FACE_PROTECT_MAX_FRAC = 0.15
# Distance max (en texels) sur laquelle on propage une couleur peinte vers un
# texel non couvert. Au-dela, on garde la texture d'origine.
FILL_MAX_DIST = 8.0

_last_progress = [-1]


def log(msg):
    print(f'[outfit] {msg}', flush=True)


def progress(pct):
    """OUTFIT_PROGRESS monotone, borne 0-99 (contrat bridge)."""
    p = max(0, min(99, int(pct)))
    if p > _last_progress[0]:
        _last_progress[0] = p
        print(f'OUTFIT_PROGRESS: {p}', flush=True)


# ===========================================================================
# (1) Resolution des chemins / interpreteurs
# ===========================================================================

def resolve_segment_python():
    """Python dedie PartSAM (PAS le venv IA) — meme resolution que main.js.

    Si FABMESH_SEGMENT_PYTHON est pose EXPLICITEMENT mais ne pointe pas sur
    un fichier, on renvoie None au lieu de retomber en douce sur un autre
    interpreteur : c'est le levier d'opt-out (mode degrade) et une valeur
    fausse doit se voir."""
    cand = os.environ.get('FABMESH_SEGMENT_PYTHON')
    if cand:
        if os.path.isfile(cand):
            return cand
        log(f'FABMESH_SEGMENT_PYTHON={cand} introuvable -> PartSAM desactive '
            f'(mode degrade heuristique demande explicitement)')
        return None
    cand = os.path.join(REPO, 'python-segment', 'python.exe')
    if os.path.isfile(cand):
        return cand
    cand = os.path.join(REPO, 'python-segment', 'bin', 'python')
    if os.path.isfile(cand):
        return cand
    return None


def resolve_partsam_dir():
    d = os.environ.get('FABMESH_PARTSAM_DIR')
    if d and os.path.isdir(d):
        return d
    d = os.path.join(REPO, 'PartSAM')
    return d if os.path.isdir(d) else None


def default_out_path(mesh_in):
    stem, _ = os.path.splitext(os.path.abspath(mesh_in))
    return f'{stem}_outfit_{int(time.time())}.glb'


# ===========================================================================
# Subprocess streaming (progress pendant PartSAM ~60-90 s)
# ===========================================================================

def _run_streaming(cmd, env, timeout_s, tag, prog_lo, prog_hi):
    """Lance cmd, relaie stdout en logs, avance la progression, timeout dur.

    Retourne (returncode, lignes). returncode None => timeout/kill."""
    log(f'{tag}: {" ".join(os.path.basename(c) if os.path.sep in str(c) else str(c) for c in cmd)}')
    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding='utf-8', errors='replace', env=env,
            cwd=SCRIPTS)
    except OSError as e:
        log(f'{tag}: lancement impossible ({e})')
        return None, []

    killed = [False]

    def _kill():
        killed[0] = True
        try:
            proc.kill()
        except Exception:
            pass

    timer = threading.Timer(timeout_s, _kill)
    timer.start()
    lines = []
    n = 0
    try:
        for line in proc.stdout:
            line = line.rstrip()
            if line:
                lines.append(line)
                log(f'{tag}| {line}')
                n += 1
                # Progression douce : +1 point toutes les ~4 lignes.
                progress(min(prog_hi, prog_lo + n // 4))
    finally:
        proc.stdout.close()
        rc = proc.wait()
        timer.cancel()
    if killed[0]:
        log(f'{tag}: TIMEOUT apres {timeout_s}s — process tue')
        return None, lines
    return rc, lines


# ===========================================================================
# (2) Segmentation PartSAM (subprocess python-segment)
# ===========================================================================

def segment_mesh(mesh_in, scratch, granularity, segmented_arg):
    """Retourne le chemin du GLB segmente (part_00..NN) ou None => fallback."""
    if segmented_arg:
        if os.path.isfile(segmented_arg):
            log(f'segmentation reutilisee: {segmented_arg}')
            return os.path.abspath(segmented_arg)
        log(f'--segmented introuvable ({segmented_arg}) — on relance PartSAM')

    seg_py = resolve_segment_python()
    partsam_dir = resolve_partsam_dir()
    if not seg_py or not partsam_dir:
        log(f'PartSAM indisponible (python-segment={seg_py}, '
            f'FABMESH_PARTSAM_DIR={partsam_dir}) -> fallback heuristique')
        return None

    seg_out = os.path.join(scratch, 'seg.glb')
    env = dict(os.environ)
    env['FABMESH_PARTSAM_DIR'] = partsam_dir
    env['PYTHONUTF8'] = '1'
    env['PYTORCH_CUDA_ALLOC_CONF'] = 'expandable_segments:True'
    cmd = [seg_py, os.path.join(SCRIPTS, 'partsam_bridge.py'),
           mesh_in, seg_out, str(granularity)]
    # 900 s et non 600 : sur un mesh ~500k faces a num_points=200000 le
    # bridge annonce lui-meme 6-10 min — 600 s tuait le process pile a la
    # limite et basculait en fallback sans le dire.
    rc, _ = _run_streaming(cmd, env, timeout_s=900, tag='partsam',
                           prog_lo=3, prog_hi=17)
    if rc is None:
        log('partsam_bridge: fallback heuristique car TIMEOUT (900 s)')
        return None
    if rc != 0 or not os.path.isfile(seg_out):
        log(f'partsam_bridge a echoue (rc={rc}) -> fallback heuristique')
        return None
    return seg_out


# ===========================================================================
# (3) Part Namer + selection vetements
# ===========================================================================

def _sidecar_candidates(seg_glb):
    stem, _ = os.path.splitext(seg_glb)
    return [seg_glb + '.parts.json', stem + '.parts.json']


def name_parts(seg_glb, asset_type, rig, scratch):
    """Sidecar {parts:[{part_id,label,confidence,abstained}]} ou None."""
    for cand in _sidecar_candidates(seg_glb):
        if os.path.isfile(cand):
            try:
                with open(cand, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                if data.get('parts'):
                    log(f'sidecar Part Namer reutilise: {cand}')
                    return data
            except Exception as e:
                log(f'sidecar illisible ({cand}: {e}) — on relance name_parts')

    sidecar = os.path.join(scratch, 'seg.parts.json')
    # name_parts tourne dans le MEME venv IA (part_namer_vision = CLIP,
    # lance AVANT SDXL : un seul modele GPU a la fois).
    cmd = [sys.executable, os.path.join(SCRIPTS, 'name_parts.py'),
           seg_glb, sidecar, '--asset-type', asset_type]
    if rig and os.path.isfile(rig):
        cmd += ['--rig', rig]
    rc, _ = _run_streaming(cmd, dict(os.environ), timeout_s=300,
                           tag='namer', prog_lo=19, prog_hi=23)
    if not os.path.isfile(sidecar):
        log(f'name_parts sans sortie (rc={rc}) -> fallback heuristique')
        return None
    try:
        with open(sidecar, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception as e:
        log(f'sidecar produit illisible ({e}) -> fallback heuristique')
        return None
    if data.get('source') == 'error':
        log(f'name_parts source=error ({data.get("error")}) -> fallback')
        return None
    return data


def select_garment_parts(sidecar):
    """part_ids vetements = labels {torso,arm,leg} (± left_/right_) non
    abstenus. Retourne None si le nommage est inutilisable (>50% abstention
    ou aucune part vetement)."""
    parts = sidecar.get('parts') or []
    if not parts:
        return None
    n_abst = sum(1 for p in parts if p.get('abstained'))
    if n_abst / len(parts) > 0.5:
        log(f'nommage trop abstenu ({n_abst}/{len(parts)}) -> fallback')
        return None
    garment, excluded = [], []
    for p in parts:
        label = str(p.get('label', '')).strip().lower()
        base = label
        for pre in ('left_', 'right_'):
            if base.startswith(pre):
                base = base[len(pre):]
        if p.get('abstained'):
            excluded.append((p['part_id'], label, 'abstained'))
        elif base in GARMENT_LABELS:
            garment.append(p['part_id'])
        else:
            excluded.append((p['part_id'], label, 'non-vetement'))
    log(f'selection vetements: {len(garment)} part(s) '
        f'({", ".join(garment) if garment else "aucune"})')
    for pid, label, why in excluded:
        log(f'  exclu {pid} label={label or "?"} ({why})')
    if not garment:
        log('aucune part torso/arm/leg -> fallback heuristique')
        return None
    return garment


def face_mask_from_parts(mesh, seg_glb, garment_ids):
    """Masque bool par FACE du mesh SOURCE via re-association centroides.

    partsam_bridge detruit son labels.npy (finally) — le seul artefact est
    le GLB segmente en sous-meshes part_XX. Chaque part copie la geometrie
    du mesh source (submesh par label de face), donc la correspondance
    centroide-triangle -> centroide-triangle est quasi exacte (dist ~0)."""
    import trimesh
    from scipy.spatial import cKDTree

    seg = trimesh.load(seg_glb)
    if not hasattr(seg, 'geometry') or not seg.geometry:
        raise RuntimeError(f'GLB segmente sans geometrie: {seg_glb}')
    geoms = seg.geometry

    src_cent = mesh.triangles_center
    tree = cKDTree(src_cent)
    scale = float(np.max(mesh.extents)) or 1.0
    face_mask = np.zeros(len(mesh.faces), dtype=bool)
    matched = 0
    for pid in garment_ids:
        g = geoms.get(pid)
        if g is None:
            # Cle fuzzy (trimesh peut suffixer les noms de geometrie)
            for k in geoms:
                if k == pid or k.startswith(pid):
                    g = geoms[k]
                    break
        if g is None or not hasattr(g, 'faces') or len(g.faces) == 0:
            log(f'  part {pid}: geometrie introuvable dans le GLB segmente')
            continue
        d, idx = tree.query(np.asarray(g.triangles_center), k=1)
        face_mask[idx] = True
        matched += len(idx)
        if float(np.median(d)) > 1e-3 * scale:
            log(f'  WARN part {pid}: distance mediane centroides '
                f'{np.median(d):.2e} (> 1e-3*scale) — association imprecise')
    log(f'masque faces vetements: {int(face_mask.sum())}/{len(face_mask)} '
        f'faces (depuis {matched} triangles de parts)')
    if not face_mask.any():
        raise RuntimeError('re-association centroides: masque vide')
    return face_mask


def fallback_face_mask(mesh):
    """FALLBACK heuristique documente (PartSAM/namer KO) :
    axe up = +Y du GLB, h = hauteur totale des centroides.
      - garde  : centroide_y < y_min + 0.75h        (exclut la tete)
      - exclut : mains = faces dans les 8% extremes de |x - centre| pour
                 la tranche 0.45h-0.75h (bras ecartes T/A-pose)
    La protection visage atlas (brique 6) est OBLIGATOIRE dans ce mode."""
    c = mesh.triangles_center
    y = c[:, 1]
    y_min, y_max = float(y.min()), float(y.max())
    h = max(y_max - y_min, 1e-9)
    rel = (y - y_min) / h
    mask = rel < 0.75

    x = c[:, 0]
    x_mid = 0.5 * (float(x.min()) + float(x.max()))
    half_w = max(0.5 * (float(x.max()) - float(x.min())), 1e-9)
    arm_band = (rel >= 0.45) & (rel < 0.75)
    hands = arm_band & (np.abs(x - x_mid) > (1.0 - 0.08) * half_w)
    mask &= ~hands

    # Accessoires tenus (baton, arme) : composantes connexes petites ET
    # excentrees. L'heuristique « mains » ci-dessus suppose une T/A-pose ;
    # bras le long du corps elle n'exclut rien (mesure : 0 face).
    #
    # ATTENTION : ne s'applique QUE si le mesh est reellement structure en
    # composantes. Les meshes TRELLIS-2 sont eclates en micro-coques (mesure
    # sur le mesh de test : 46 868 composantes, la plus grosse = 0,44 % des
    # faces) — dans ce cas « petite composante excentree » decrit la moitie
    # du corps et l'heuristique ne veut plus rien dire. On la desactive.
    n_acc = 0
    try:
        labels = _face_components(mesh)
        if labels is None:
            raise RuntimeError('composantes indisponibles')
        n_faces = len(mesh.faces)
        uniq, counts = np.unique(labels, return_counts=True)
        biggest = counts.max() / float(n_faces)
        if biggest < 0.10:
            log(f'fallback: {len(uniq)} composantes, la plus grosse ne fait '
                f'que {biggest*100:.2f}% des faces -> mesh non structure en '
                f'composantes, detection accessoires DESACTIVEE')
        else:
            cand = np.zeros(n_faces, dtype=bool)
            for lab, cnt in zip(uniq, counts):
                if cnt / float(n_faces) >= 0.01:
                    continue  # trop gros pour un accessoire
                sel = labels == lab
                if float(np.abs(c[sel, 0] - x_mid).mean()) / half_w > 0.50:
                    cand |= sel
            # Garde-fou : un accessoire ne represente jamais 15 % du perso.
            if cand.sum() / float(n_faces) > 0.15:
                log(f'fallback: candidats accessoires = '
                    f'{100.0*cand.sum()/n_faces:.1f}% des faces (> 15%) '
                    f'-> heuristique jugee non fiable, ignoree')
            else:
                mask &= ~cand
                n_acc = int(cand.sum())
    except Exception as e:
        log(f'fallback: detection accessoires ignoree ({e})')

    log(f'fallback heuristique: {int(mask.sum())}/{len(mask)} faces '
        f'({int(hands.sum())} faces mains exclues, {n_acc} faces accessoires)')
    return mask


def _face_components(mesh):
    """Etiquette de composante connexe par face (ou None si indisponible)."""
    try:
        from scipy.sparse import coo_matrix
        from scipy.sparse.csgraph import connected_components
        adj = np.asarray(mesh.face_adjacency)
        n = len(mesh.faces)
        if len(adj) == 0:
            return None
        g = coo_matrix(
            (np.ones(len(adj)), (adj[:, 0], adj[:, 1])), shape=(n, n))
        _, labels = connected_components(g, directed=False)
        return labels
    except Exception:
        return None


# ===========================================================================
# (4) Masque texels sur l'atlas
# ===========================================================================

def rasterize_faces_to_atlas(uv, faces, face_mask, tex_res):
    """Triangles UV des faces masquees -> masque atlas bool.
    MEME mapping que texture_project : x = u*R, y = (1-v)*R."""
    img = Image.new('L', (tex_res, tex_res), 0)
    draw = ImageDraw.Draw(img)
    for fi in np.where(face_mask)[0]:
        tri = uv[faces[fi]]
        pts = [(float(u) * tex_res, (1.0 - float(v)) * tex_res)
               for u, v in tri]
        draw.polygon(pts, fill=255)
    return np.asarray(img) > 0


def build_face_protect_mask(in_glb, tex_res):
    """Masque atlas bool du VISAGE (pipeline texture_refine --protect-face :
    render front pyrender -> Haar -> bande haute fallback -> UV project).
    None si le pipeline echoue completement OU si le masque produit est trop
    gros pour etre credible.

    MESURE (mesh de test 499k faces, atlas 1024) : Haar renvoie une bbox de
    248x247 px, 93 144 faces la touchent et la projection UV donne 65 % de
    l'atlas — les atlas TRELLIS-2 sont des confettis, une bbox ecran attrape
    des iles UV appartenant a tout le corps. Soustraire ca ampute les deux
    tiers du vetement au hasard : on refuse donc tout masque > FACE_PROTECT_MAX.
    """
    try:
        from texture_refine import _make_face_protect_mask
        m = _make_face_protect_mask(in_glb, tex_res)
        if m is None:
            return None
        arr = np.asarray(m.resize((tex_res, tex_res), Image.LANCZOS))
        mask = arr > 16  # attrape le feather du GaussianBlur(8)
        frac = float(mask.mean())
        if frac > FACE_PROTECT_MAX_FRAC:
            log(f'masque visage atlas IGNORE: {frac*100:.1f}% de l\'atlas '
                f'(> {FACE_PROTECT_MAX_FRAC*100:.0f}%) — projection UV non '
                f'discriminante sur cet atlas, il amputerait le vetement')
            return None
        log(f'masque visage atlas: {int(mask.sum())} texels '
            f'({frac*100:.1f}% de l\'atlas)')
        return mask
    except Exception as e:
        log(f'masque visage atlas indisponible ({type(e).__name__}: {e})')
        return None


def _dilate_iters(tex_res, n_faces):
    """Dilatation proportionnelle a la densite de l'atlas.

    Les atlas TRELLIS-2 packent ~500k triangles dans 1024^2, soit ~2 texels
    par triangle et AUCUN gutter : dilater de 6 texels pontait toutes les
    iles UV et faisait passer le masque de 547k a 1 025k texels (97,7 % de
    l'atlas). On borne donc a 1-2 iterations, et uniquement pour le feather.
    """
    if n_faces <= 0:
        return 2
    texels_per_face = (tex_res * tex_res) / float(n_faces)
    if texels_per_face < 8.0:      # atlas confetti (TRELLIS-2)
        return 1
    if texels_per_face < 64.0:
        return 2
    return 3


def build_texel_mask(mesh, in_glb, face_mask, tex_res, fallback_mode):
    """Retourne (mask_paint, mask_feather, face_mask maj).

    DEUX masques distincts (correctif du bloqueur n°1) :
      - mask_paint   : rasterisation NON dilatee des faces vetement. C'est la
                       reference d'APPARTENANCE : seul lui autorise le fill et
                       compte dans la couverture.
      - mask_feather : version legerement dilatee + floue, utilisee UNIQUEMENT
                       comme poids de composite (anti-couture).
    Melanger les deux (l'ancien `mask_bin` dilate de 6) faisait croire que
    92 % du masque restait « non couvert » et lachait un EDT-nearest sur tout
    l'atlas -> texture detruite.
    """
    from scipy import ndimage

    uv = np.asarray(mesh.visual.uv, dtype=np.float64)
    faces_np = np.asarray(mesh.faces)

    mask_paint = rasterize_faces_to_atlas(uv, faces_np, face_mask, tex_res)
    log(f'masque texels (non dilate): {int(mask_paint.sum())} texels, '
        f'atlas {tex_res}x{tex_res}')

    face_protect = build_face_protect_mask(in_glb, tex_res)
    if face_protect is not None:
        before = int(mask_paint.sum())
        mask_paint &= ~face_protect
        log(f'protection visage: -{before - int(mask_paint.sum())} texels')
    elif fallback_mode:
        # En fallback, la protection visage est la SEULE ceinture pour la
        # tete : sans elle on reduit par bande de hauteur (< 0.70h) puis on
        # re-rasterise.
        log('fallback SANS masque visage -> reduction bande tronc (<0.70h)')
        c = mesh.triangles_center
        y = c[:, 1]
        h = max(float(y.max()) - float(y.min()), 1e-9)
        face_mask = face_mask & ((y - float(y.min())) / h < 0.70)
        mask_paint = rasterize_faces_to_atlas(uv, faces_np, face_mask, tex_res)
        log(f'masque texels apres bande: {int(mask_paint.sum())} texels')
    else:
        log('parts head/hair deja exclues par le namer — on continue '
            'sans masque visage atlas')

    if not mask_paint.any():
        raise RuntimeError('masque texels vide apres protection visage')

    iters = _dilate_iters(tex_res, int(face_mask.sum()))
    mask_dil = ndimage.binary_dilation(mask_paint, iterations=iters)
    log(f'feather: dilatation {iters} texel(s) -> {int(mask_dil.sum())} '
        f'({100.0*mask_dil.mean():.1f}% de l\'atlas)')
    feather = Image.fromarray((mask_dil * 255).astype(np.uint8), 'L') \
        .filter(ImageFilter.GaussianBlur(1.5))
    mask_feather = np.asarray(feather, dtype=np.float64) / 255.0
    return mask_paint, mask_feather, face_mask


# ===========================================================================
# (5) Cameras + rendus ortho (contrat MVAdapter, copie fabmesh_6views_runner)
# ===========================================================================

def get_c2w(azim_mva_deg, elev_deg, distance):
    """Copie de fabmesh_6views_runner.get_c2w (Z-up MVAdapter, OpenGL :
    la camera regarde -Z — pose directement compatible pyrender)."""
    az = math.radians(azim_mva_deg)
    el = math.radians(elev_deg)
    cp = np.array([
        distance * math.cos(el) * math.cos(az),
        distance * math.cos(el) * math.sin(az),
        distance * math.sin(el),
    ])
    up = np.array([0.0, 0.0, 1.0])
    lookat = -cp / (np.linalg.norm(cp) + 1e-10)
    right = np.cross(lookat, up)
    n = np.linalg.norm(right)
    if n < 1e-6:
        right = np.array([1.0, 0.0, 0.0])
    else:
        right = right / n
    new_up = np.cross(right, lookat)
    R = np.stack([right, new_up, -lookat], axis=-1)
    c2w = np.eye(4)
    c2w[:3, :3] = R
    c2w[:3, 3] = cp
    return c2w


def get_ortho_proj(L, R, B, T, near=0.1, far=100.0):
    """Copie de fabmesh_6views_runner.get_ortho_proj. proj[1,1] NEGATIF =
    flip Y integre — le chemin ortho ne re-flip donc PAS V."""
    m = np.zeros((4, 4))
    m[0, 0] = 2 / (R - L)
    m[1, 1] = -2 / (T - B)
    m[2, 2] = -2 / (far - near)
    m[0, 3] = -(R + L) / (R - L)
    m[1, 3] = -(T + B) / (T - B)
    m[2, 3] = -(far + near) / (far - near)
    m[3, 3] = 1.0
    return m


def mesh_std_transforms(vertices):
    """Copie de fabmesh_6views_runner.load_mesh_transforms : rescale=True
    scale=0.5, offset None, up=+y / front=+x."""
    rescale_factor = float(np.abs(vertices).max()) / 0.5
    up_vec = np.array([0, 1, 0], dtype=np.float64)
    front_vec = np.array([1, 0, 0], dtype=np.float64)
    y_vec = np.cross(up_vec, front_vec)
    std2mesh = np.stack([front_vec, y_vec, up_vec], axis=0).T
    mesh2std = np.linalg.inv(std2mesh)
    return rescale_factor, mesh2std


def build_views(n_views):
    specs = VIEWS_6 if int(n_views) >= 6 else VIEWS_4
    proj = get_ortho_proj(CAM_L, CAM_R, CAM_B, CAM_T)
    views = []
    for label, azim, elev in specs:
        c2w = get_c2w(azim - 90.0, elev, CAM_DISTANCE)  # azim logique -90
        views.append({'label': label, 'azim': azim, 'elev': elev,
                      'c2w': c2w, 'w2c': np.linalg.inv(c2w), 'proj': proj})
    return views


def write_views_json(scratch, views, rescale_factor, mesh2std):
    """views.json au format MVAdapter (debug / compat texture_project)."""
    schema = {
        'engine': 'outfit_repaint',
        'projection': 'orthographic',
        'cam_distance': CAM_DISTANCE,
        'cam_bounds': [CAM_L, CAM_R, CAM_B, CAM_T],
        'mesh_rescale_factor': rescale_factor,
        'mesh_offset': None,
        'mesh2std': mesh2std.tolist(),
        'views': [{'azim': v['azim'], 'elev': v['elev'],
                   'w2c': v['w2c'].tolist(), 'proj_mtx': v['proj'].tolist()}
                  for v in views],
    }
    path = os.path.join(scratch, 'views.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(schema, f, indent=2)
    return path


class ViewRenderer:
    """Rendus pyrender partages : couleur (atlas courant), depth full,
    depth vetements, et rendu du masque texels « pending » (texture masque
    plaquee sur le mesh = projection exacte texel->ecran).

    UN SEUL OffscreenRenderer pour toute la duree de vie (contexte GL —
    coexiste avec la VRAM torch, mais on le .delete() dans close())."""

    def __init__(self, v_std, faces, uv, face_mask, render_size=1024):
        import pyrender
        import trimesh
        self._pyrender = pyrender
        self._trimesh = trimesh
        self.size = render_size
        self.v_std = v_std
        self.faces = faces
        self.uv = uv

        self.renderer = pyrender.OffscreenRenderer(render_size, render_size)

        def _make_scene(bg):
            sc = pyrender.Scene(bg_color=bg, ambient_light=[1.0, 1.0, 1.0])
            cam = pyrender.OrthographicCamera(
                xmag=CAM_R, ymag=CAM_T, znear=0.01, zfar=100.0)
            cam_node = sc.add(cam, pose=np.eye(4))
            return sc, cam_node

        # Eclairage FLAT : ambient 1.0, aucune directionnelle — l'inpaint
        # ne doit pas voir d'ombrage bake.
        self.scene_tex, self.cam_tex = _make_scene([1.0, 1.0, 1.0, 1.0])
        self.scene_mask, self.cam_mask = _make_scene([0.0, 0.0, 0.0, 1.0])
        self.scene_dfull, self.cam_dfull = _make_scene([1.0, 1.0, 1.0, 1.0])
        self.scene_dgarm, self.cam_dgarm = _make_scene([1.0, 1.0, 1.0, 1.0])

        tm_full = trimesh.Trimesh(v_std, faces, process=False)
        self.scene_dfull.add(pyrender.Mesh.from_trimesh(tm_full, smooth=False))
        tm_garm = trimesh.Trimesh(v_std, faces[face_mask], process=False)
        self.scene_dgarm.add(pyrender.Mesh.from_trimesh(tm_garm, smooth=False))

        self._tex_node = None
        self._mask_node = None

        # Rendu de chauffe jete : le tout premier render() apres creation du
        # contexte GL peut revenir noir (observe sur pyglet 2.x).
        try:
            self.renderer.render(self.scene_dfull,
                                 flags=pyrender.RenderFlags.DEPTH_ONLY)
        except Exception as e:
            log(f'rendu de chauffe ignore ({e})')

    def _textured_node(self, scene, old_node, atlas_pil):
        pyrender = self._pyrender
        trimesh = self._trimesh
        if old_node is not None:
            scene.remove_node(old_node)
        mat = trimesh.visual.material.PBRMaterial(
            baseColorTexture=atlas_pil.convert('RGB'),
            metallicFactor=0.0, roughnessFactor=1.0)
        tm = trimesh.Trimesh(self.v_std, self.faces, process=False)
        tm.visual = trimesh.visual.texture.TextureVisuals(
            uv=self.uv, material=mat)
        return scene.add(pyrender.Mesh.from_trimesh(tm, smooth=False))

    def set_atlas(self, atlas_pil):
        self._tex_node = self._textured_node(
            self.scene_tex, self._tex_node, atlas_pil)

    def set_pending_mask_texture(self, mask_bin):
        m = Image.fromarray((mask_bin * 255).astype(np.uint8), 'L')
        self._mask_node = self._textured_node(
            self.scene_mask, self._mask_node, m)

    def render_color(self, c2w):
        self.scene_tex.set_pose(self.cam_tex, pose=c2w)
        color, _ = self.renderer.render(self.scene_tex)
        return Image.fromarray(color[:, :, :3], 'RGB')

    def render_pending2d(self, c2w):
        """Texels pending projetes a l'ecran (blanc = a inpainter)."""
        self.scene_mask.set_pose(self.cam_mask, pose=c2w)
        color, _ = self.renderer.render(self.scene_mask)
        return np.asarray(color)[:, :, 0] > 100

    def garment_mask2d(self, c2w):
        """Masque 2D vetements par depth-diff : depth du mesh ENTIER vs
        depth du seul submesh vetements — gere l'occlusion (un bras devant
        le torse ne perce pas le masque). Epsilon RELATIF a l'echelle du
        mesh normalise (coques doublees TRELLIS-2)."""
        import pyrender
        eps = float(os.environ.get('FABMESH_OUTFIT_DEPTH_EPS', '2e-3'))
        self.scene_dfull.set_pose(self.cam_dfull, pose=c2w)
        d_full = self.renderer.render(
            self.scene_dfull, flags=pyrender.RenderFlags.DEPTH_ONLY)
        self.scene_dgarm.set_pose(self.cam_dgarm, pose=c2w)
        d_garm = self.renderer.render(
            self.scene_dgarm, flags=pyrender.RenderFlags.DEPTH_ONLY)
        return (d_garm > 0) & (np.abs(d_garm - d_full) < eps)

    def close(self):
        try:
            self.renderer.delete()
        except Exception:
            pass


# ===========================================================================
# (6) Reprojection vue -> atlas (kernel stack de texture_project, V=1)
# ===========================================================================

def ortho_project_vertices(v_std, n_std, w2c, proj):
    """Formule EXACTE du chemin ortho de texture_project (l.1116-1156) :
    clip = proj @ w2c @ [v;1] ; p_u = 0.5(ndc_x+1) ; p_v = 0.5(ndc_y+1)
    SANS re-flip V (le signe negatif de proj[1,1] l'a deja fait) ;
    vis = clip(n_camspace.z, 0, 1)**BAKE_EXP * in_frame."""
    v_h = np.concatenate([v_std, np.ones((len(v_std), 1))], axis=1)
    clip = (proj @ w2c @ v_h.T).T
    w = np.where(np.abs(clip[:, 3]) < 1e-8, 1.0, clip[:, 3])
    ndc = clip[:, :3] / w[:, np.newaxis]
    p_u = 0.5 * (ndc[:, 0] + 1.0)
    p_v = 0.5 * (ndc[:, 1] + 1.0)
    R_w2c = w2c[:3, :3]
    n_cs = (R_w2c @ n_std.T).T
    norms_n = n_cs / (np.linalg.norm(n_cs, axis=1, keepdims=True) + 1e-10)
    # exp=1.0 et non 4.0 : avec 4.0 il fallait une normale a moins de ~37 deg
    # de la camera pour passer le plancher du stack, et la couverture tombait
    # a 35 %. Ici le rendu est flat (ambient 1.0) et l'ecriture est deja
    # bornee par le masque 2D : accepter les angles rasants est sans risque
    # et fait passer la couverture a ~55 % (mesure, 4 vues).
    bake_exp = float(os.environ.get('FABMESH_OUTFIT_BAKE_EXP', '1.0'))
    vis = np.clip(norms_n[:, 2], 0, 1) ** bake_exp
    in_frame = (p_u >= 0) & (p_u <= 1) & (p_v >= 0) & (p_v <= 1)
    return p_u, p_v, vis * in_frame.astype(np.float64)


def compute_face_ok(uv, faces, face_mask, tex_res):
    """Filtre degenere de texture_project (uv_areas/aspect/edge) restreint
    aux faces vetements (le kernel ne doit ecrire que dans leurs texels)."""
    face_uvs = uv[faces]  # (F, 3, 2)
    uv_px = face_uvs * tex_res
    uv_areas = 0.5 * np.abs(
        (uv_px[:, 1, 0] - uv_px[:, 0, 0]) * (uv_px[:, 2, 1] - uv_px[:, 0, 1])
        - (uv_px[:, 2, 0] - uv_px[:, 0, 0]) * (uv_px[:, 1, 1] - uv_px[:, 0, 1]))
    edges = np.stack([
        np.linalg.norm(uv_px[:, 1] - uv_px[:, 0], axis=1),
        np.linalg.norm(uv_px[:, 2] - uv_px[:, 1], axis=1),
        np.linalg.norm(uv_px[:, 0] - uv_px[:, 2], axis=1),
    ], axis=1)
    max_edge = edges.max(axis=1)
    min_edge = edges.min(axis=1)
    aspect_ok = (min_edge > 0.1) & (max_edge / np.clip(min_edge, 0.01, None) < 50)
    edge_size_ok = max_edge < (tex_res * 0.2)
    return (uv_areas >= 0.1) & aspect_ok & edge_size_ok & face_mask, face_uvs


def reproject_view(atlas_f, view_img, alpha_mask2d, p_u, p_v, vis,
                   faces, face_uvs, face_ok, tex_res, progress_cb=None):
    """UNE vue -> atlas via le kernel stack de texture_project (V=1,
    prio=1.0). L'alpha de la vue = masque 2D d'inpaint applique en amont
    (pixels hors masque -> alpha 0, ignores via src_alpha).

    Retourne (proj_arr, weight_arr) : proj_arr part de l'atlas courant et
    n'est modifie que la ou le kernel couvre (feather FLOOR/FULL)."""
    from texture_project import _raster_core_jit

    rgba = np.dstack([
        np.asarray(view_img.convert('RGB')),
        (alpha_mask2d * 255).astype(np.uint8)])
    h, w = rgba.shape[:2]
    pixels_flat = rgba.reshape(-1, 4).astype(np.float64)
    offs = np.array([0, h * w], dtype=np.int64)

    p_u_v = np.ascontiguousarray(p_u[np.newaxis, :], dtype=np.float64)
    p_v_v = np.ascontiguousarray(p_v[np.newaxis, :], dtype=np.float64)
    vis_v = np.ascontiguousarray(vis[np.newaxis, :], dtype=np.float64)
    prio_v = np.array([1.0], dtype=np.float64)
    vw = np.array([w], dtype=np.int64)
    vh = np.array([h], dtype=np.int64)

    faces_i64 = np.ascontiguousarray(faces, dtype=np.int64)
    face_uvs_c = np.ascontiguousarray(face_uvs, dtype=np.float64)
    face_ok_c = np.ascontiguousarray(face_ok)

    # floor 0.10 (et non 0.40) : meme raison que bake_exp ci-dessus.
    stack_floor = float(os.environ.get('FABMESH_OUTFIT_STACK_FLOOR', '0.10'))
    stack_full = float(os.environ.get('FABMESH_OUTFIT_STACK_FULL', '0.45'))

    proj_arr = atlas_f.copy()
    weight_arr = np.zeros((tex_res, tex_res), dtype=np.float64)

    n_chunks = 8
    edges = np.linspace(0, len(faces_i64), n_chunks + 1, dtype=np.int64)
    for ci in range(n_chunks):
        c0, c1 = int(edges[ci]), int(edges[ci + 1])
        if c1 <= c0:
            continue
        _raster_core_jit(c0, c1, faces_i64, face_uvs_c, face_ok_c, tex_res,
                         p_u_v, p_v_v, vis_v, prio_v, vw, vh,
                         pixels_flat, offs, proj_arr, weight_arr,
                         stack_floor, stack_full, 0)  # blend_code 0 = stack
        if progress_cb:
            progress_cb((ci + 1) / n_chunks)
    return proj_arr, weight_arr


# ===========================================================================
# (7) SDXL inpaint in-process (pattern local_inpaint_bridge.py)
# ===========================================================================

def unload_sdxl_server_best_effort():
    """Si le serveur SDXL persistant tourne, liberer sa VRAM (best-effort,
    timeouts courts). Ne PAS passer par /mask_inpaint (strength figee)."""
    import urllib.request
    try:
        with urllib.request.urlopen(f'{SDXL_SERVER}/ping', timeout=2):
            pass
    except Exception:
        log('serveur SDXL absent — rien a decharger')
        return
    for model in ('img2img', 'inpaint', 'controlnet_tile',
                  'controlnet_geo', 'clipseg'):
        try:
            req = urllib.request.Request(
                f'{SDXL_SERVER}/unload',
                data=json.dumps({'model': model}).encode('utf-8'),
                headers={'Content-Type': 'application/json'}, method='POST')
            with urllib.request.urlopen(req, timeout=5):
                pass
            log(f'serveur SDXL: unload {model} OK')
        except Exception as e:
            log(f'serveur SDXL: unload {model} ignore ({e})')


def load_inpaint_pipeline():
    import torch
    from diffusers import StableDiffusionXLInpaintPipeline

    if torch.cuda.is_available():
        frac = float(os.environ.get('FABMESH_VRAM_FRACTION', '0.95'))
        if 0.1 <= frac < 1.0:
            try:
                torch.cuda.set_per_process_memory_fraction(frac)
                log(f'cap VRAM {frac*100:.0f}%')
            except Exception as e:
                log(f'cap VRAM impossible ({e})')

    log(f'chargement SDXL inpaint ({SDXL_INPAINT_CKPT})...')
    t0 = time.time()
    pipe = StableDiffusionXLInpaintPipeline.from_pretrained(
        SDXL_INPAINT_CKPT, torch_dtype=torch.float16, variant='fp16')
    pipe.to('cuda')
    pipe.enable_attention_slicing()
    pipe.enable_vae_tiling()
    log(f'SDXL inpaint pret en {time.time()-t0:.1f}s '
        f'({torch.cuda.memory_allocated()/1024**3:.1f} GB)')
    return pipe


def free_pipeline():
    """A appeler APRES avoir mis la variable `pipe` de l'appelant a None :
    `del pipe` a l'interieur d'une fonction ne supprimait que la reference
    locale, la frame appelante gardait les ~7 Go de SDXL vivants."""
    import gc
    try:
        import torch
        gc.collect()
        torch.cuda.empty_cache()
        log('SDXL inpaint libere (empty_cache)')
    except Exception as e:
        log(f'liberation VRAM partielle ({e})')


def inpaint_view(pipe, render_img, mask2d, prompt, strength, seed, steps=32):
    """Inpaint SDXL d'une vue. Masque BLANC = inpaint, GaussianBlur 2.
    Seed FIXE inter-vues (coherence), strength = slider CLI."""
    import torch
    size = render_img.size[0]
    mask_pil = Image.fromarray((mask2d * 255).astype(np.uint8), 'L') \
        .filter(ImageFilter.GaussianBlur(2))
    gen = torch.Generator('cuda').manual_seed(int(seed))
    full_prompt = (f'{prompt}, clothing, outfit, fabric, detailed textile, '
                   f'consistent character, high quality')
    result = pipe(
        prompt=full_prompt,
        negative_prompt=NEGATIVE_PROMPT,
        image=render_img.convert('RGB'),
        mask_image=mask_pil,
        num_inference_steps=int(steps),
        guidance_scale=8.0,
        strength=float(strength),
        height=size, width=size,
        generator=gen,
    ).images[0]
    return result


# ===========================================================================
# (8) Remplissage des texels jamais couverts (aisselles, entrejambe)
# ===========================================================================

def fill_uncovered(atlas_painted, coverage, mask_paint):
    """Bouche les trous du masque PEIGNABLE laisses par les vues (aisselles,
    entrejambe, micro-triangles rates par la rasterisation conservative).

    Retourne (atlas, touched) ou `touched` = coverage | texels effectivement
    remplis. C'est CE masque, et pas le masque vetement, qui autorise ensuite
    l'ecriture dans l'atlas final.

    BORNE DURE (correctif du bloqueur n°1) : on ne propage une couleur que sur
    FILL_MAX_DIST texels. Sans borne, l'EDT-nearest recopiait la couleur du
    texel peint le plus proche sur 92 % de l'atlas et le resultat etait une
    bouillie. Au-dela de la borne, la texture d'origine est conservee.
    """
    from scipy import ndimage

    pending = mask_paint & ~coverage
    n_pending = int(pending.sum())
    n_mask = max(1, int(mask_paint.sum()))
    if not coverage.any():
        log('fill: AUCUN texel couvert — atlas repeint laisse tel quel')
        return atlas_painted, coverage
    if n_pending == 0:
        log('fill: tous les texels peignables sont couverts')
        return atlas_painted, coverage
    log(f'fill: {n_pending} texels non couverts '
        f'({100.0*n_pending/n_mask:.1f}% du masque peignable)')

    dist, ind = ndimage.distance_transform_edt(
        ~coverage, return_distances=True, return_indices=True)
    fillable = pending & (dist <= FILL_MAX_DIST)
    n_fill = int(fillable.sum())
    log(f'fill: {n_fill} texels a <= {FILL_MAX_DIST:.0f} texels d\'un texel '
        f'peint (les {n_pending - n_fill} autres gardent la texture source)')
    if n_fill == 0:
        return atlas_painted, coverage

    out = atlas_painted.copy()
    out[fillable] = atlas_painted[ind[0][fillable], ind[1][fillable]]

    try:
        import cv2
        bgr = np.clip(out, 0, 255).astype(np.uint8)[:, :, ::-1].copy()
        hole = (fillable * 255).astype(np.uint8)
        inp = cv2.inpaint(bgr, hole, 3, cv2.INPAINT_TELEA)
        # Telea repeint AUSSI un anneau autour des trous : on ne reprend son
        # resultat que sur les texels a boucher.
        smoothed = inp[:, :, ::-1].astype(np.float64)
        out[fillable] = smoothed[fillable]
        log('fill: Telea rayon 3 applique (restreint aux trous)')
    except Exception as e:
        log(f'fill: Telea indisponible ({e}) — EDT nearest seul')
    return out, (coverage | fillable)


# ===========================================================================
# Chargement mesh / atlas
# ===========================================================================

def load_source_mesh(mesh_in):
    """MEME chargement que partsam_bridge (trimesh.load force='mesh') pour
    que la re-association centroides part->source soit exacte."""
    import trimesh
    mesh = trimesh.load(mesh_in, force='mesh')
    if not hasattr(mesh, 'visual') or getattr(mesh.visual, 'uv', None) is None:
        raise RuntimeError('mesh sans UV — outfit_repaint exige un atlas UV')
    if len(mesh.visual.uv) != len(mesh.vertices):
        raise RuntimeError(
            f'topologie UV/vertex incoherente '
            f'(uv={len(mesh.visual.uv)} verts={len(mesh.vertices)})')
    return mesh


def load_atlas(mesh):
    """Atlas baseColor du GLB, force carre (tex_res = max cote).
    Retourne (PIL RGB carre, tex_res)."""
    tex = None
    mat = getattr(mesh.visual, 'material', None)
    if mat is not None:
        tex = getattr(mat, 'baseColorTexture', None)
        if tex is None:
            tex = getattr(mat, 'image', None)
    if tex is None:
        raise RuntimeError('mesh sans baseColorTexture — rien a repeindre')
    tex = tex.convert('RGB')
    w, h = tex.size
    tex_res = max(w, h)
    if w != h:
        log(f'atlas non carre {w}x{h} -> redimensionne {tex_res}x{tex_res} '
            f'(UV normalises, swap final re-encode de toute facon)')
        tex = tex.resize((tex_res, tex_res), Image.LANCZOS)
    return tex, tex_res


# ===========================================================================
# main
# ===========================================================================

def parse_args():
    ap = argparse.ArgumentParser(
        description='FabMesh — repeindre les vetements (texture-only). '
                    'NB: strength 0.3-0.5 = recoloration douce (limite du '
                    'checkpoint inpainting-0.1, entraine a strength~1) ; '
                    '0.75-1.0 = nouvelle tenue.')
    ap.add_argument('--mesh', required=True, help='GLB texture en entree')
    ap.add_argument('--prompt', required=True,
                    help='tenue voulue, ex: "medieval armor"')
    ap.add_argument('--strength', type=float, default=0.75,
                    help='denoise SDXL 0.3 (recolore) -> 1.0 (nouvelle tenue)')
    ap.add_argument('--seed', type=int, default=42)
    ap.add_argument('--out', default=None,
                    help='GLB de sortie (def: <in>_outfit_<ts>.glb)')
    ap.add_argument('--views', type=int, default=4, choices=[4, 6],
                    help='4 = front/back/right/left ; 6 = + top/bottom')
    ap.add_argument('--granularity', type=float, default=0.2,
                    help='granularite PartSAM (0.2 = parties grossieres, '
                         'recommande pour le mapping vetements)')
    ap.add_argument('--asset-type', default='character')
    ap.add_argument('--rig', default=None,
                    help='GLB rigge (active la voie squelette du Part Namer)')
    ap.add_argument('--segmented', default=None,
                    help='GLB deja segmente (part_00..NN) a reutiliser')
    ap.add_argument('--steps', type=int, default=32,
                    help='steps SDXL par vue (30-40)')
    ap.add_argument('--tex-res', type=int, default=0,
                    help='resolution de travail de l\'atlas (0 = celle du '
                         'GLB). 2048 sur un atlas 1024 quadruple le nombre '
                         'de texels par triangle et augmente nettement la '
                         'couverture des micro-triangles TRELLIS-2.')
    return ap.parse_args()


def run(args):
    mesh_in = os.path.abspath(args.mesh)
    if not os.path.isfile(mesh_in):
        raise RuntimeError(f'mesh introuvable: {mesh_in}')
    out_glb = os.path.abspath(args.out) if args.out else default_out_path(mesh_in)
    strength = min(1.0, max(0.05, float(args.strength)))

    out_dir = os.path.dirname(out_glb) or '.'
    os.makedirs(out_dir, exist_ok=True)
    scratch = os.path.join(out_dir, '.outfit_scratch')
    os.makedirs(scratch, exist_ok=True)

    progress(1)
    log(f'mesh={mesh_in}')
    log(f'out={out_glb} prompt="{args.prompt}" strength={strength} '
        f'seed={args.seed} views={args.views}')

    # ------------------------------------------------------------------
    # Chargement mesh + atlas
    # ------------------------------------------------------------------
    mesh = load_source_mesh(mesh_in)
    atlas_pil, tex_res = load_atlas(mesh)
    want_res = int(getattr(args, 'tex_res', 0) or 0)
    if want_res and want_res != tex_res:
        # Sur-echantillonnage : ~2 texels/triangle sur les atlas TRELLIS-2,
        # la rasterisation conservative du kernel en perd la majorite.
        # replace_glb_atlas re-encode de toute facon.
        log(f'atlas sur-echantillonne {tex_res} -> {want_res} '
            f'(--tex-res) pour la reprojection')
        atlas_pil = atlas_pil.resize((want_res, want_res), Image.LANCZOS)
        tex_res = want_res
    log(f'mesh: {len(mesh.vertices)} verts, {len(mesh.faces)} faces, '
        f'atlas de travail {tex_res}x{tex_res}')
    progress(2)

    # ------------------------------------------------------------------
    # (2) Segmentation PartSAM [2 -> 18]   (subprocess : meurt apres)
    # ------------------------------------------------------------------
    fallback_mode = False
    face_mask = None
    seg_glb = segment_mesh(mesh_in, scratch, args.granularity, args.segmented)
    progress(18)

    # ------------------------------------------------------------------
    # (3) Part Namer + selection [18 -> 24]  (CLIP subprocess : meurt
    #     AVANT le chargement SDXL — un seul modele GPU a la fois)
    # ------------------------------------------------------------------
    if seg_glb is not None:
        sidecar = name_parts(seg_glb, args.asset_type, args.rig, scratch)
        garment_ids = select_garment_parts(sidecar) if sidecar else None
        if garment_ids:
            try:
                face_mask = face_mask_from_parts(mesh, seg_glb, garment_ids)
            except Exception as e:
                log(f're-association parts->faces echouee ({e}) -> fallback')
    if face_mask is None:
        fallback_mode = True
        face_mask = fallback_face_mask(mesh)
    progress(24)

    # ------------------------------------------------------------------
    # (4) Masque texels [24 -> 28]  (+ protection visage brique 6)
    # ------------------------------------------------------------------
    mask_paint, mask_feather, face_mask = build_texel_mask(
        mesh, mesh_in, face_mask, tex_res, fallback_mode)
    Image.fromarray((mask_paint * 255).astype(np.uint8), 'L').save(
        os.path.join(scratch, 'mask_texels.png'))
    progress(28)

    # ------------------------------------------------------------------
    # (5) Cameras + renderer [28 -> 30]
    # ------------------------------------------------------------------
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces, dtype=np.int64)
    uv = np.asarray(mesh.visual.uv, dtype=np.float64)
    normals = np.asarray(mesh.vertex_normals, dtype=np.float64)

    rescale_factor, mesh2std = mesh_std_transforms(vertices)
    v_std = (mesh2std @ (vertices / rescale_factor).T).T
    n_std = (mesh2std @ normals.T).T
    views = build_views(args.views)
    write_views_json(scratch, views, rescale_factor, mesh2std)

    face_ok, face_uvs = compute_face_ok(uv, faces, face_mask, tex_res)
    log(f'kernel: {int(face_ok.sum())}/{len(faces)} faces vetements valides')

    renderer = ViewRenderer(v_std, faces, uv, face_mask, render_size=1024)
    progress(30)

    # Definis AVANT le try : ils sont consommes apres le finally. S'ils
    # naissaient dans le try, un echec de load_inpaint_pipeline() (HF hors
    # ligne, OOM, variante fp16 absente) declenchait un NameError qui
    # masquait l'erreur reelle.
    atlas_orig = np.asarray(atlas_pil, dtype=np.float64)
    atlas_cur = atlas_orig.copy()
    coverage = np.zeros((tex_res, tex_res), dtype=bool)

    pipe = None
    try:
        # --------------------------------------------------------------
        # (6) Boucle inpaint sequentielle TEXTure [30 -> 80]
        # --------------------------------------------------------------
        unload_sdxl_server_best_effort()
        pipe = load_inpaint_pipeline()

        n_views = len(views)
        budget = 50.0 / n_views
        for k, view in enumerate(views):
            base = 30.0 + budget * k
            label = view['label']
            c2w = view['c2w']
            log(f'--- vue {k+1}/{n_views}: {label} '
                f'(azim={view["azim"]}, elev={view["elev"]}) ---')

            # Re-render avec l'atlas COURANT : le deja-peint reste visible
            # comme contexte de coherence pour les vues suivantes.
            renderer.set_atlas(Image.fromarray(
                np.clip(atlas_cur, 0, 255).astype(np.uint8)))
            render_img = renderer.render_color(c2w)
            garment2d = renderer.garment_mask2d(c2w)

            # Vue front : masque = tout le vetement visible. Vues
            # suivantes : seulement les texels PAS encore couverts.
            pending_tex = mask_paint & ~coverage
            renderer.set_pending_mask_texture(pending_tex)
            pending2d = renderer.render_pending2d(c2w)
            mask2d = garment2d & pending2d
            progress(base + budget * 0.15)

            render_img.save(os.path.join(scratch, f'view_{k}_{label}.png'))
            Image.fromarray((mask2d * 255).astype(np.uint8), 'L').save(
                os.path.join(scratch, f'mask2d_{k}_{label}.png'))

            cov2d = float(mask2d.mean())
            log(f'  masque 2D: {cov2d*100:.2f}% de la vue')
            if cov2d < 0.002:
                log('  masque 2D quasi vide — vue sautee')
                progress(base + budget)
                continue

            t0 = time.time()
            painted = inpaint_view(pipe, render_img, mask2d, args.prompt,
                                   strength, args.seed, steps=args.steps)
            log(f'  inpaint SDXL en {time.time()-t0:.1f}s')
            painted.save(os.path.join(scratch, f'painted_{k}_{label}.png'))
            progress(base + budget * 0.60)

            # Reprojection : kernel stack V=1, alpha = masque 2D.
            t0 = time.time()
            p_u, p_v, vis = ortho_project_vertices(
                v_std, n_std, view['w2c'], view['proj'])

            def _cb(frac, _b=base, _bu=budget):
                progress(_b + _bu * (0.60 + 0.38 * frac))

            proj_arr, weight_arr = reproject_view(
                atlas_cur, painted, mask2d, p_u, p_v, vis,
                faces, face_uvs, face_ok, tex_res, progress_cb=_cb)
            log(f'  reprojection en {time.time()-t0:.1f}s '
                f'({int((weight_arr > 0).sum())} texels touches)')

            # Composite restreint : m = feather_texels * (weight > 0).
            # Le feather ne sert QUE de poids ; il n'autorise jamais a lui
            # seul l'ecriture (c'est `weight > 0` qui decide).
            m = mask_feather * (weight_arr > 0)
            atlas_cur = atlas_cur * (1.0 - m[:, :, None]) \
                + proj_arr * m[:, :, None]
            coverage |= (weight_arr > 0) & mask_paint
            log(f'  couverture cumulee: {int(coverage.sum())}/'
                f'{int(mask_paint.sum())} texels peignables '
                f'({100.0*coverage.sum()/max(1,int(mask_paint.sum())):.1f}%)')
            progress(base + budget)

        progress(80)
    finally:
        renderer.close()
        # `del pipe` dans une fonction ne libere rien : la frame de run()
        # garde la reference. On la coupe ICI, avant empty_cache().
        pipe = None
        free_pipeline()

    # ------------------------------------------------------------------
    # (7) Remplissage des texels non couverts [80 -> 88]
    # ------------------------------------------------------------------
    atlas_cur, touched = fill_uncovered(atlas_cur, coverage, mask_paint)
    progress(88)

    # ------------------------------------------------------------------
    # (8) Export [88 -> 99] — composite final + swap baseColor IN-PLACE
    #     (jamais de re-export trimesh : le skinning serait perdu)
    # ------------------------------------------------------------------
    # Le composite final est gate par `touched` (texels reellement peints ou
    # remplis), PAS par le masque vetement : partout ailleurs la texture
    # d'origine passe telle quelle. Le feather ne module que l'intensite.
    if not touched.any():
        raise RuntimeError(
            'aucun texel peint : rien a ecrire (masque 2D vide sur toutes '
            'les vues ?) — voir les mask2d_*.png du scratch')
    from scipy import ndimage as _ndi
    gate = _ndi.binary_dilation(touched, iterations=1)
    gate_soft = np.asarray(
        Image.fromarray((gate * 255).astype(np.uint8), 'L')
        .filter(ImageFilter.GaussianBlur(1.0)), dtype=np.float64) / 255.0
    m = (mask_feather * gate_soft)[:, :, None]
    log(f'composite final: {int(touched.sum())} texels peints '
        f'({100.0*touched.mean():.1f}% de l\'atlas)')
    atlas_out = np.clip(atlas_orig * (1.0 - m) + atlas_cur * m,
                        0, 255).astype(np.uint8)
    atlas_out_pil = Image.fromarray(atlas_out, 'RGB')
    # Debug conserve a cote du GLB (comme texture_project _tex.png)
    debug_tex = out_glb[:-4] + '_tex.png' if out_glb.lower().endswith('.glb') \
        else out_glb + '_tex.png'
    atlas_out_pil.save(debug_tex)
    progress(92)

    from texture_refine import replace_glb_atlas
    replace_glb_atlas(mesh_in, out_glb, atlas_out_pil)
    if not os.path.isfile(out_glb):
        raise RuntimeError('swap atlas: GLB de sortie non ecrit')
    log(f'GLB ecrit: {out_glb} ({os.path.getsize(out_glb)} octets), '
        f'atlas debug: {debug_tex}')
    progress(99)

    # Nettoyage scratch (garde avec FABMESH_OUTFIT_KEEP_SCRATCH=1)
    if os.environ.get('FABMESH_OUTFIT_KEEP_SCRATCH') != '1':
        try:
            shutil.rmtree(scratch, ignore_errors=True)
        except Exception:
            pass
    else:
        log(f'scratch conserve: {scratch}')

    print(f'OUTFIT_OK: {out_glb}', flush=True)
    return out_glb


def main():
    args = parse_args()
    t0 = time.time()
    try:
        run(args)
        log(f'termine en {time.time()-t0:.1f}s')
        return 0
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f'[outfit] ERREUR: {type(e).__name__}: {e}',
              file=sys.stderr, flush=True)
        return 1


if __name__ == '__main__':
    sys.exit(main())
