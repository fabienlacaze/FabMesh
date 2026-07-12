#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""part_namer_vision.py — « Part Namer » VOIE B (vision) : nommage sémantique
des sous-parties d'un mesh segmenté NON riggé (véhicules, objets, bâtiments,
armes, créatures…) par rendu isolé + CLIP-L + priors géométriques + abstention.

Pipeline consolidé (« V3 » validé sur le tank : 88.9%->100%, 0 faux confiant) :

1. RASTERIZER torch maison (z-buffer, flat-shading, aucune dépendance de rendu
   externe — pas de pyrender/OpenGL/nvdiffrast). Chaque part est rendue ISOLÉE
   (centrée/normalisée seule), en 6 vues orthographiques, puis CONVERTIE EN
   NIVEAUX DE GRIS pour neutraliser la teinte du rasterizer (CLIP se concentre
   sur la forme). On garde les 3 vues de plus grande aire couverte.
   ⚠️  Le rendu CONTEXTUEL plein-cadre (part surlignée dans le tout) est BANNI :
       mesuré à effondrer CLIP à 22-33%.

2. CLIP-L (openai/clip-vit-large-patch14, local_files_only, offline). GPU si
   VRAM libre >= 4 Go, sinon CPU. Vocabulaire FERMÉ par type d'asset, ensembling
   multi-prompts (moyenne d'embeddings texte), softmax par vue puis moyenne.
   ⚠️  CLIP-H (laion/CLIP-ViT-H-14) est PIRE (turret/wheel -> hatch) : NE PAS
       l'utiliser.

3. FUSION log-prob avec PRIORS GÉOMÉTRIQUES :
       score = log(softmax_clip) + LAMBDA * log(softmax(geom_scores))
   Les priors géométriques (allongement / verticalité / volume / position +
   DÉTECTION DE PAIRE MIROIR mutuelle 1-à-1) redressent les plaques plates où
   CLIP est documenté-faible (fender vs track), sans dégrader les signatures
   fortes. Les priors « véhicule » (validés) ne s'appliquent qu'à la famille
   vehicle/avion/bateau ; les autres types reçoivent des priors génériques.

4. ABSTENTION -> label 'unknown' si conf(top1) < 0.40 OU marge(top1-top2) < 0.10.

Sortie JSON : {ok, source:'vision', model, parts:[{part_id,label,confidence,
top3,geom}]}. Déterministe, offline, aucune écriture hors du fichier de sortie.

Usage
-----
    python part_namer_vision.py <segmented.glb> <out.json> --asset-type vehicle
"""
from __future__ import annotations

import argparse
import colorsys
import json
import os
import sys
import time

os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

import numpy as np
import torch
import trimesh
from PIL import Image

MODEL_ID = "openai/clip-vit-large-patch14"

# ---- rendu ----
W = H = 384
MARGIN = 0.90   # fraction de la demi-extension utilisée (laisse une bordure)
BG = 235        # gris clair du fond
FACE_CHUNK = 40000

# ---- fusion / abstention (hyperparamètres validés) ----
LAMBDA = 1.5          # poids du log-prior géométrique dans la fusion
CONF_THRESH = 0.40    # abstention si prob max fusionnée < ce seuil
MARGIN_THRESH = 0.10  # abstention si (top1 - top2) < ce seuil

# ---- 6 vues : (right, up, depth) axes unitaires monde ----
# depth = axe pointant VERS l'observateur (plus grand = plus proche)
VIEWS = {
    "front":  ((1, 0, 0),  (0, 1, 0),  (0, 0, 1)),
    "back":   ((-1, 0, 0), (0, 1, 0),  (0, 0, -1)),
    "right":  ((0, 0, -1), (0, 1, 0),  (1, 0, 0)),
    "left":   ((0, 0, 1),  (0, 1, 0),  (-1, 0, 0)),
    "top":    ((1, 0, 0),  (0, 0, -1), (0, 1, 0)),
    "bottom": ((1, 0, 0),  (0, 0, 1),  (0, -1, 0)),
}
LIGHT = np.array([0.4, 0.7, 0.6], dtype=np.float64)
LIGHT = LIGHT / np.linalg.norm(LIGHT)

TEMPLATES = [
    "a 3D render of {}",
    "a grayscale 3D render of {}",
    "a photo of {}",
    "{} isolated on a plain background",
    "a close-up of {}",
    "the {} part of a {ctx}",
]

# =====================================================================
#  VOCABULAIRES PAR TYPE D'ASSET (labels canoniques snake_case)
#  vehicle = VALIDÉ ; les autres = best-effort raisonnable.
# =====================================================================
VEHICLE_NP = {
    "wheel":            ["a tank road wheel", "a road wheel of an armored vehicle",
                         "a circular metal wheel", "a drive sprocket wheel of a tank"],
    "continuous_track": ["a continuous caterpillar track", "a tank tread belt",
                         "the segmented rubber track of a tank", "the long tracks of a tank"],
    "turret":           ["a tank turret", "the rotating gun turret of a tank",
                         "a rounded armored turret dome"],
    "cannon_barrel":    ["a tank cannon barrel", "the long gun barrel of a tank",
                         "a cylindrical main gun barrel", "a straight artillery barrel"],
    "hull":             ["the hull of a tank", "the armored body of a tank",
                         "the flat top deck of a tank chassis", "the main chassis plate of an armored vehicle"],
    "hatch":            ["a round crew hatch on a tank", "an armored hatch cover",
                         "a small circular tank hatch"],
    "antenna":          ["a thin whip radio antenna", "a long thin antenna rod",
                         "a slender vertical antenna"],
    "headlight":        ["a vehicle headlight", "a small round headlamp",
                         "the headlight of a military vehicle"],
    "fender":           ["a track mudguard fender", "a side fender panel of a tank",
                         "a long flat fender over the tracks"],
    "exhaust":          ["an engine exhaust pipe", "a muffler exhaust outlet",
                         "an exhaust vent of a tank"],
    "fuel_tank":        ["an external cylindrical fuel tank", "an auxiliary fuel drum",
                         "a jerry-can fuel container"],
    "machine_gun":      ["a mounted machine gun", "a small caliber machine gun on a tank",
                         "a coaxial machine gun"],
    "wing":             ["an aircraft wing", "the main wing of a plane", "a swept aircraft wing"],
    "propeller":        ["an aircraft propeller", "a spinning propeller blade set",
                         "a multi-blade propeller"],
    "cockpit":          ["an aircraft cockpit canopy", "the glass cockpit of a plane",
                         "a bubble canopy cockpit"],
    "rotor":            ["a helicopter rotor", "the main rotor blades of a helicopter",
                         "a spinning rotor hub"],
}
BUILDING_NP = {
    "roof":       ["a building roof", "a pitched rooftop", "the roof of a house"],
    "wall":       ["a building wall", "a flat exterior wall", "a large wall panel"],
    "door":       ["a building door", "an entrance door", "a wooden door"],
    "window":     ["a building window", "a glass window", "a window pane"],
    "stairs":     ["a flight of stairs", "an exterior staircase", "stone steps"],
    "chimney":    ["a brick chimney", "a rooftop chimney stack", "a tall chimney"],
    "balcony":    ["a building balcony", "a railed balcony", "an overhanging balcony"],
    "column":     ["a structural column", "a stone pillar", "a supporting column"],
    "foundation": ["a building foundation slab", "a concrete base", "the ground foundation of a building"],
}
WEAPON_NP = {
    "blade":    ["a sword blade", "a sharp metal blade", "the cutting edge of a weapon"],
    "handle":   ["a weapon handle", "a grip handle", "the hilt handle of a sword"],
    "guard":    ["a sword crossguard", "a hand guard of a blade", "a hilt guard"],
    "barrel":   ["a gun barrel", "a firearm barrel", "the long barrel of a rifle"],
    "stock":    ["a rifle stock", "the shoulder stock of a gun", "a wooden gun stock"],
    "magazine": ["a gun magazine", "an ammunition magazine clip", "a curved rifle magazine"],
    "scope":    ["a rifle scope", "a telescopic gun sight", "an optical scope"],
    "trigger":  ["a gun trigger", "a firearm trigger", "a small trigger lever"],
    "grip":     ["a pistol grip", "a hand grip of a weapon", "a textured weapon grip"],
}
CHARACTER_NP = {
    "head":   ["a character head", "a humanoid head", "the head of a creature"],
    "torso":  ["a character torso", "a humanoid chest and body", "the trunk of a creature"],
    "arm":    ["a character arm", "a humanoid arm limb", "an upper limb"],
    "leg":    ["a character leg", "a humanoid leg limb", "a lower limb"],
    "hand":   ["a character hand", "a humanoid hand with fingers", "a gripping hand"],
    "foot":   ["a character foot", "a humanoid foot", "the foot of a creature"],
    "hair":   ["a head of hair", "a hairstyle", "strands of hair"],
    "tail":   ["a creature tail", "a long animal tail", "a tapering tail"],
    "wing":   ["a creature wing", "a feathered wing", "a bat-like wing"],
    "weapon": ["a handheld weapon", "a sword or gun held by a character", "a character's weapon"],
    "shield": ["a shield", "a round protective shield", "a combat shield"],
}
OTHER_NP = {"part": ["a mechanical part", "a component of an object", "an isolated 3D part"]}

# familles -> (label list, np dict, contexte texte pour {ctx})
_FAMILIES = {
    "vehicle":     (list(VEHICLE_NP.keys()),   VEHICLE_NP,   "military vehicle"),
    "avion":       (list(VEHICLE_NP.keys()),   VEHICLE_NP,   "aircraft"),
    "bateau":      (list(VEHICLE_NP.keys()),   VEHICLE_NP,   "ship"),
    "building":    (list(BUILDING_NP.keys()),  BUILDING_NP,  "building"),
    "environment": (list(BUILDING_NP.keys()),  BUILDING_NP,  "structure"),
    "weapon":      (list(WEAPON_NP.keys()),    WEAPON_NP,    "weapon"),
    "character":   (list(CHARACTER_NP.keys()), CHARACTER_NP, "character"),
    "creature":    (list(CHARACTER_NP.keys()), CHARACTER_NP, "creature"),
    "animal":      (list(CHARACTER_NP.keys()), CHARACTER_NP, "animal"),
    "other":       (list(OTHER_NP.keys()),     OTHER_NP,     "object"),
    "custom":      (list(OTHER_NP.keys()),     OTHER_NP,     "object"),
}
_VEHICLE_FAMILY = {"vehicle", "avion", "bateau"}


def resolve_vocab(asset_type: str):
    at = (asset_type or "other").strip().lower()
    if at not in _FAMILIES:
        at = "other"
    labels, np_map, ctx = _FAMILIES[at]
    return at, labels, np_map, ctx


# =====================================================================
#  DEVICE
# =====================================================================
def pick_device():
    if not torch.cuda.is_available():
        return "cpu", "no-cuda"
    try:
        free, total = torch.cuda.mem_get_info()
        fg = free / (1024 ** 3)
        dev = "cuda" if fg >= 4.0 else "cpu"
        return dev, f"VRAM libre {fg:.1f}/{total / (1024 ** 3):.1f} Go"
    except Exception as e:
        return "cpu", f"mem_get_info fail: {e}"


def as_tensor(x):
    """transformers 5.x peut renvoyer un output object au lieu d'un tensor."""
    if isinstance(x, torch.Tensor):
        return x
    for attr in ("text_embeds", "image_embeds", "pooler_output", "last_hidden_state"):
        v = getattr(x, attr, None)
        if isinstance(v, torch.Tensor):
            return v
    raise TypeError(f"cannot coerce {type(x)} to tensor")


# =====================================================================
#  RASTERIZER (isolé, N&B via post-conversion) — sortie image en mémoire
# =====================================================================
def _part_color(i, n):
    r, g, b = colorsys.hsv_to_rgb((i / max(1, n)) % 1.0, 0.85, 1.0)
    return np.array([r, g, b], dtype=np.float64)


def rasterize_view(verts_w, faces, right, up, depth, base_rgb, device):
    """verts_w: (V,3) déjà centrés/normalisés dans [-1,1].
    Renvoie (img uint8 HxWx3, coverage_frac float)."""
    dev = device
    R = torch.tensor(np.stack([right, up, depth], axis=0), dtype=torch.float32, device=dev)
    V = torch.as_tensor(verts_w, dtype=torch.float32, device=dev)
    F = torch.as_tensor(faces, dtype=torch.long, device=dev)
    cam = V @ R.t()
    cx, cy, cz = cam[:, 0], cam[:, 1], cam[:, 2]
    sx = (cx * MARGIN * 0.5 + 0.5) * (W - 1)
    sy = (0.5 - cy * MARGIN * 0.5) * (H - 1)
    depthv = cz

    p0 = torch.stack([sx[F[:, 0]], sy[F[:, 0]]], 1)
    p1 = torch.stack([sx[F[:, 1]], sy[F[:, 1]]], 1)
    p2 = torch.stack([sx[F[:, 2]], sy[F[:, 2]]], 1)
    z0 = depthv[F[:, 0]]; z1 = depthv[F[:, 1]]; z2 = depthv[F[:, 2]]

    v0 = V[F[:, 0]]; v1 = V[F[:, 1]]; v2 = V[F[:, 2]]
    fn = torch.cross(v1 - v0, v2 - v0, dim=1)
    fn = fn / torch.linalg.norm(fn, dim=1, keepdim=True).clamp_min(1e-9)
    ld = torch.tensor(LIGHT, dtype=torch.float32, device=dev)
    shade = (fn @ ld).abs().clamp(0.25, 1.0)

    d = (p1[:, 0] - p0[:, 0]) * (p2[:, 1] - p0[:, 1]) - (p2[:, 0] - p0[:, 0]) * (p1[:, 1] - p0[:, 1])
    valid = d.abs() > 1e-6
    xmin = torch.stack([p0[:, 0], p1[:, 0], p2[:, 0]], 1).amin(1)
    xmax = torch.stack([p0[:, 0], p1[:, 0], p2[:, 0]], 1).amax(1)
    ymin = torch.stack([p0[:, 1], p1[:, 1], p2[:, 1]], 1).amin(1)
    ymax = torch.stack([p0[:, 1], p1[:, 1], p2[:, 1]], 1).amax(1)
    x0i = xmin.floor().clamp(0, W - 1).long(); x1i = xmax.ceil().clamp(0, W - 1).long()
    y0i = ymin.floor().clamp(0, H - 1).long(); y1i = ymax.ceil().clamp(0, H - 1).long()
    onscreen = (xmax >= 0) & (xmin <= W - 1) & (ymax >= 0) & (ymin <= H - 1)
    keep = valid & onscreen
    idx_all = torch.nonzero(keep, as_tuple=False).squeeze(1)

    zbuf = torch.full((H * W,), float("inf"), device=dev)
    shadebuf = torch.zeros((H * W,), device=dev)
    covered = torch.zeros((H * W,), dtype=torch.bool, device=dev)

    for cs in range(0, idx_all.numel(), FACE_CHUNK):
        fi = idx_all[cs:cs + FACE_CHUNK]
        w = (x1i[fi] - x0i[fi] + 1).clamp_min(0)
        h = (y1i[fi] - y0i[fi] + 1).clamp_min(0)
        area = (w * h)
        good = area > 0
        fi = fi[good]; w = w[good]; h = h[good]; area = area[good]
        if fi.numel() == 0:
            continue
        offs = torch.cumsum(area, 0)
        total = int(offs[-1].item())
        start = offs - area
        cand_face = torch.repeat_interleave(torch.arange(fi.numel(), device=dev), area)
        local = torch.arange(total, device=dev) - start[cand_face]
        wf = w[cand_face]
        dx = (local % wf); dy = (local // wf)
        px = x0i[fi][cand_face] + dx; py = y0i[fi][cand_face] + dy
        gf = fi[cand_face]
        ax, ay = p0[gf, 0], p0[gf, 1]
        bx, by = p1[gf, 0], p1[gf, 1]
        yx, yy = p2[gf, 0], p2[gf, 1]
        dd = (bx - ax) * (yy - ay) - (yx - ax) * (by - ay)
        pxf = px.float() + 0.5; pyf = py.float() + 0.5
        l1 = ((bx - pxf) * (yy - pyf) - (yx - pxf) * (by - pyf)) / dd
        l2 = ((yx - pxf) * (ay - pyf) - (ax - pxf) * (yy - pyf)) / dd
        l3 = 1.0 - l1 - l2
        inside = (l1 >= -1e-4) & (l2 >= -1e-4) & (l3 >= -1e-4)
        if inside.sum() == 0:
            continue
        px = px[inside]; py = py[inside]; gf = gf[inside]
        l1 = l1[inside]; l2 = l2[inside]; l3 = l3[inside]
        zc = l1 * z0[gf] + l2 * z1[gf] + l3 * z2[gf]
        negz = -zc
        lin = py * W + px
        covered[lin] = True
        zbuf.scatter_reduce_(0, lin, negz, reduce="amin", include_self=True)
        winner = negz <= (zbuf[lin] + 1e-5)
        lw = lin[winner]
        shadebuf[lw] = shade[gf[winner]]

    cov = covered.reshape(H, W).cpu().numpy()
    sh = shadebuf.reshape(H, W).cpu().numpy()
    img = np.full((H, W, 3), BG, dtype=np.uint8)
    col = (base_rgb[None, None, :] * sh[:, :, None] * 255.0)
    col = np.clip(col, 0, 255).astype(np.uint8)
    img[cov] = col[cov]
    frac = float(cov.mean())
    return img, frac


def gray_rgb(img_uint8):
    """Niveaux de gris (neutralise la teinte), re-RGB pour CLIP."""
    return Image.fromarray(img_uint8).convert("L").convert("RGB")


# =====================================================================
#  FEATURES GÉOMÉTRIQUES + PAIRES MIROIR
# =====================================================================
def compute_geom(parts, names):
    """parts[name] = {'vw':(V,3) world, 'faces':(F,3), 'geom':trimesh}.
    Retourne (feats, frame, mutual_set, pairs, track_ref_h)."""
    allv = np.concatenate([parts[k]["vw"] for k in names], 0)
    gmin = allv.min(0); gmax = allv.max(0); gext = gmax - gmin
    gcenter = (gmin + gmax) * 0.5
    gscale = max(gext.max() * 0.5, 1e-9)
    up_ax = 1
    horiz = [0, 2]
    long_ax = horiz[0] if gext[horiz[0]] >= gext[horiz[1]] else horiz[1]
    width_ax = horiz[1] if long_ax == horiz[0] else horiz[0]

    # somme des volumes bbox (dénominateur de hull_frac_of_total, cf. pipeline validé)
    sum_bbox = sum(float(np.prod(parts[k]["vw"].max(0) - parts[k]["vw"].min(0))) for k in names)
    sum_bbox = max(sum_bbox, 1e-12)

    feats = {}
    for name in names:
        vw = parts[name]["vw"]; faces = parts[name]["faces"]; geom = parts[name]["geom"]
        pmin = vw.min(0); pmax = vw.max(0); ext = pmax - pmin; cen = (pmin + pmax) * 0.5
        se = np.sort(ext)[::-1]
        elong = float(se[0] / max(se[1], 1e-9))
        flat = float(se[1] / max(se[2], 1e-9))
        vert = float(ext[up_ax] / max(ext[long_ax], ext[width_ax], 1e-9))
        try:
            hull_vol = float(geom.convex_hull.volume)
        except Exception:
            hull_vol = float(np.prod(ext))
        bbox_vol = float(np.prod(ext))
        cn = (cen - gmin) / np.maximum(gext, 1e-9)
        feats[name] = {
            "ext_world": [round(float(e), 4) for e in ext],
            "ext_long": round(float(ext[long_ax]), 4),
            "ext_width": round(float(ext[width_ax]), 4),
            "ext_up": round(float(ext[up_ax]), 4),
            "elongation": round(elong, 3),
            "flatness": round(flat, 3),
            "verticality": round(vert, 3),
            "bbox_vol": round(bbox_vol, 5),
            "hull_vol": round(hull_vol, 5),
            "hull_frac_of_total": round(hull_vol / sum_bbox, 4),
            "centroid_world": [round(float(c), 4) for c in cen],
            "centroid_norm": {
                "height_lo0_hi1": round(float(cn[up_ax]), 3),
                "long_0front_1back": round(float(cn[long_ax]), 3),
                "width_0left_1right": round(float(cn[width_ax]), 3),
            },
            "n_faces": int(len(faces)),
        }

    # ---- paires miroir sur le plan médian de largeur ----
    wmid = gcenter[width_ax]
    cands = []
    for a in range(len(names)):
        for b in range(a + 1, len(names)):
            ka, kb = names[a], names[b]
            ca = np.array(feats[ka]["centroid_world"]); cb = np.array(feats[kb]["centroid_world"])
            ca_m = ca.copy(); ca_m[width_ax] = 2 * wmid - ca[width_ax]
            dn = float(np.linalg.norm(ca_m - cb) / gscale)
            ea = np.array(feats[ka]["ext_world"]); eb = np.array(feats[kb]["ext_world"])
            ext_ratio = float(np.max(np.abs(ea - eb)) / max(np.max(np.maximum(ea, eb)), 1e-9))
            opp = bool((ca[width_ax] - wmid) * (cb[width_ax] - wmid) < 0)
            offset_w = abs(ca[width_ax] - wmid) / max(gext[width_ax] * 0.5, 1e-9)
            cands.append({"a": ka, "b": kb, "mirror_dist_norm": round(dn, 3),
                          "ext_diff_ratio": round(ext_ratio, 3), "opposite_sides": opp,
                          "width_offset_frac": round(float(offset_w), 3)})
    cands.sort(key=lambda c: c["mirror_dist_norm"])

    # appariement mutuel STRICT 1-à-1 (évite les faux positifs plaque<->track)
    good = [c for c in cands
            if c["opposite_sides"] and c["mirror_dist_norm"] < 0.02 and c["ext_diff_ratio"] < 0.10]
    good.sort(key=lambda c: c["mirror_dist_norm"])
    used, pairs = set(), []
    for c in good:
        if c["a"] in used or c["b"] in used:
            continue
        used.add(c["a"]); used.add(c["b"])
        pairs.append((c["a"], c["b"]))

    if used:
        track_ref_h = min(feats[p]["centroid_norm"]["height_lo0_hi1"] for p in used)
    else:
        track_ref_h = 0.15

    frame = {"up_axis": "Y", "long_axis": int(long_ax), "width_axis": int(width_ax),
             "global_ext": [round(float(e), 4) for e in gext]}
    return feats, frame, used, pairs, track_ref_h


def geom_scores(family, labels, f, is_mutual, track_ref_h):
    """Scores géométriques interprétables par label (bornes douces) -> softmax
    = prior géométrique. On n'ajoute des bonus qu'aux labels PRÉSENTS dans le
    vocab actif. La branche 'vehicle' est celle VALIDÉE sur le tank ; les autres
    familles reçoivent des indices géométriques génériques best-effort."""
    s = {l: 0.0 for l in labels}
    LS = set(labels)

    def add(lab, v):
        if lab in LS:
            s[lab] += v

    elong = f["elongation"]
    vert = f["verticality"]
    flat = f["flatness"]
    hf = f["hull_frac_of_total"]
    h = f["centroid_norm"]["height_lo0_hi1"]
    w = f["centroid_norm"]["width_0left_1right"]
    lg = f["centroid_norm"]["long_0front_1back"]
    side = abs(w - 0.5)          # ~0 central, ~0.5 loin sur le côté
    long_ext = abs(lg - 0.5)     # extrémité le long de la longueur
    ext_w = f["ext_width"]
    ext_up = f["ext_up"]

    if family in _VEHICLE_FAMILY:
        # ---- priors VÉHICULE (validés tank : 88.9%->100%) ----
        # antenna : tige verticale très fine
        if vert > 4.0:
            add("antenna", 4.0)
        elif vert > 1.4 and hf < 0.001:
            add("antenna", 0.8)
        # continuous_track : la paire miroir mutuelle, longue, basse, sur un côté
        if is_mutual and elong > 3.0 and h < 0.25:
            add("continuous_track", 3.2)
            add("wheel", 0.6)  # les chenilles portent des galets
        # fender / jupe latérale : longue plaque fine sur un CÔTÉ, PAS la paire
        # track mutuelle, et plus HAUTE que la ligne de chenille -> le fix clé.
        if (not is_mutual) and elong > 3.0 and side > 0.25 and h > track_ref_h + 0.02:
            add("fender", 2.8)
        # wheel : petit disque bas compact
        if elong < 1.4 and hf < 0.01 and h < 0.2 and vert > 0.9:
            add("wheel", 2.6)
        # turret : bloc haut compact, verticalité modérée
        if h > 0.5 and elong < 1.6 and 0.35 < vert < 1.3 and ext_up > 0.25:
            add("turret", 3.0)
        # cannon_barrel : tube allongé plat (incliné), petit volume, à une extrémité
        if elong > 1.4 and flat > 3.0 and hf < 0.02 and long_ext > 0.25:
            add("cannon_barrel", 3.0)
        # hull : gros volume, pleine largeur, centré latéralement
        if hf > 0.12 and side < 0.12 and ext_w > 0.30:
            add("hull", 3.0)
    else:
        # ---- priors GÉNÉRIQUES best-effort (autres familles) ----
        # tige/lame verticale très fine
        if vert > 4.0:
            for lab in ("antenna", "blade", "column", "chimney", "barrel", "cannon_barrel"):
                add(lab, 3.0)
        # tube allongé fin (barrel/blade/barrel d'arme, bras/jambe/queue)
        if elong > 2.5 and flat > 2.0 and hf < 0.03:
            for lab in ("barrel", "cannon_barrel", "blade", "arm", "leg", "tail"):
                add(lab, 2.0)
        # gros volume centré = corps/base
        if hf > 0.12 and side < 0.15:
            for lab in ("hull", "foundation", "torso", "wall"):
                add(lab, 2.5)
        # bloc haut compact = tête/tourelle/toit
        if h > 0.6 and elong < 1.6:
            for lab in ("head", "roof", "scope"):
                add(lab, 2.0)
        # petit élément bas compact = pied/roue
        if elong < 1.4 and h < 0.2 and hf < 0.01:
            for lab in ("foot", "wheel"):
                add(lab, 2.0)
        # paire miroir mutuelle = membres/roues/ailes symétriques
        if is_mutual:
            for lab in ("arm", "leg", "wing", "wheel", "continuous_track"):
                add(lab, 1.5)
        # plaque plate large et haute = toit / mur / aile
        if flat > 3.0 and elong > 1.5:
            for lab in ("roof", "wall", "wing", "fender"):
                add(lab, 1.5)

    return s


def softmax_over(labels, s):
    xs = np.array([s[l] for l in labels], dtype=np.float64)
    xs = xs - xs.max()
    e = np.exp(xs)
    return e / e.sum()


# =====================================================================
#  CLIP
# =====================================================================
def clip_label_embeddings(model, tok, img_proc, labels, np_map, ctx, device):
    label_embs = []
    with torch.no_grad():
        for lab in labels:
            prompts = []
            for phrase in np_map[lab]:
                for tpl in TEMPLATES:
                    prompts.append(tpl.format(phrase, ctx=ctx))
            tin = tok(prompts, return_tensors="pt", padding=True, truncation=True, max_length=77)
            tin = {k: v.to(device) for k, v in tin.items()}
            te = as_tensor(model.get_text_features(**tin))
            te = te / te.norm(dim=-1, keepdim=True)
            m = te.mean(dim=0); m = m / m.norm()
            label_embs.append(m)
    return torch.stack(label_embs, dim=0)


def clip_probs_for_part(model, img_proc, label_embs, logit_scale, imgs, device):
    with torch.no_grad():
        iin = img_proc(images=imgs, return_tensors="pt")
        iin = {k: v.to(device) for k, v in iin.items()}
        ie = as_tensor(model.get_image_features(**iin))
        ie = ie / ie.norm(dim=-1, keepdim=True)
        logits = logit_scale * ie @ label_embs.t()
        probs = torch.softmax(logits, dim=-1).mean(dim=0)
    return probs.cpu().numpy().astype(np.float64)


# =====================================================================
#  MAIN
# =====================================================================
def run(glb_path, out_path, asset_type):
    t0 = time.time()
    family, labels, np_map, ctx = resolve_vocab(asset_type)
    device, devinfo = pick_device()

    scene = trimesh.load(glb_path, process=False)
    if isinstance(scene, trimesh.Trimesh):
        # mono-mesh : un seul « part »
        geoms = {"part_00": scene}
        graph = None
    else:
        geoms = dict(scene.geometry)
        graph = scene.graph
    names = sorted(geoms.keys())
    n = len(names)
    if n == 0:
        raise ValueError("aucune géométrie dans le GLB")

    # ---- verts monde par part ----
    parts = {}
    for name in names:
        geom = geoms[name]
        T = np.eye(4)
        if graph is not None:
            try:
                T = graph.get(name)[0]
            except Exception:
                T = np.eye(4)
        vloc = np.asarray(geom.vertices, dtype=np.float64)
        vw = (np.c_[vloc, np.ones(len(vloc))] @ T.T)[:, :3]
        parts[name] = {"vw": vw, "faces": np.asarray(geom.faces, dtype=np.int64), "geom": geom}

    # ---- features géométriques + paires miroir ----
    feats, frame, mutual_set, pairs, track_ref_h = compute_geom(parts, names)

    # ---- rendu isolé N&B, garde les 3 meilleures vues ----
    part_imgs = {}
    for i, name in enumerate(names):
        vw = parts[name]["vw"]; faces = parts[name]["faces"]
        cmin = vw.min(0); cmax = vw.max(0)
        center = (cmin + cmax) * 0.5
        scale = (cmax - cmin).max() * 0.5
        if scale <= 0:
            scale = 1.0
        vn = (vw - center) / scale
        base = _part_color(i, n)
        views_cov = []
        for vname, (r, u, dz) in VIEWS.items():
            img, frac = rasterize_view(vn, faces, np.array(r, float), np.array(u, float),
                                       np.array(dz, float), base, device)
            views_cov.append((frac, img))
        views_cov.sort(key=lambda x: -x[0])
        part_imgs[name] = [gray_rgb(img) for frac, img in views_cov[:3] if frac > 0]
        if not part_imgs[name]:
            # part dégénérée : garde au moins la meilleure vue
            part_imgs[name] = [gray_rgb(views_cov[0][1])]

    # ---- CLIP ----
    from transformers import CLIPModel, CLIPImageProcessor, AutoTokenizer
    model = CLIPModel.from_pretrained(MODEL_ID, local_files_only=True).to(device).eval()
    img_proc = CLIPImageProcessor(
        do_resize=True, size={"shortest_edge": 224}, do_center_crop=True,
        crop_size={"height": 224, "width": 224}, do_rescale=True, do_normalize=True,
        image_mean=[0.48145466, 0.4578275, 0.40821073],
        image_std=[0.26862954, 0.26130258, 0.27577711])
    tok = AutoTokenizer.from_pretrained(MODEL_ID, local_files_only=True)
    logit_scale = model.logit_scale.exp().item()
    label_embs = clip_label_embeddings(model, tok, img_proc, labels, np_map, ctx, device)

    eps = 1e-6
    out_parts = []
    for name in names:
        cp_prob = clip_probs_for_part(model, img_proc, label_embs, logit_scale, part_imgs[name], device)
        gs = geom_scores(family, labels, feats[name], name in mutual_set, track_ref_h)
        gp = softmax_over(labels, gs)
        fused_log = np.log(cp_prob + eps) + LAMBDA * np.log(gp + eps)
        fused_log -= fused_log.max()
        fe = np.exp(fused_log)
        fused = fe / fe.sum()

        order = np.argsort(-fused)
        i0, i1 = int(order[0]), int(order[1]) if len(order) > 1 else int(order[0])
        top1_p = float(fused[i0])
        top2_p = float(fused[i1]) if len(order) > 1 else 0.0
        margin = top1_p - top2_p
        abstain = (top1_p < CONF_THRESH) or (margin < MARGIN_THRESH)
        pred = labels[i0]
        final = "unknown" if abstain else pred

        top3 = [{"label": labels[int(j)], "prob": round(float(fused[int(j)]), 4)}
                for j in order[:3]]
        cn = feats[name]["centroid_norm"]
        out_parts.append({
            "part_id": name,
            "label": final,
            "confidence": round(top1_p, 4),
            "top3": top3,
            "geom": {
                "elongation": feats[name]["elongation"],
                "verticality": feats[name]["verticality"],
                "flatness": feats[name]["flatness"],
                "hull_frac_of_total": feats[name]["hull_frac_of_total"],
                "height_lo0_hi1": cn["height_lo0_hi1"],
                "width_0left_1right": cn["width_0left_1right"],
                "long_0front_1back": cn["long_0front_1back"],
                "is_mirror_pair": bool(name in mutual_set),
                "geom_top": labels[int(np.argmax(gp))],
                "geom_conf": round(float(gp.max()), 4),
            },
            "clip_top": labels[int(np.argmax(cp_prob))],
            "clip_conf": round(float(cp_prob.max()), 4),
            "margin": round(margin, 4),
            "abstained": bool(abstain),
        })
        flag = "ABSTAIN" if abstain else "OK"
        print(f"[{name}] {flag:7s} {final:18s} conf={top1_p:.3f} m={margin:.3f} "
              f"clip={out_parts[-1]['clip_top']}/{cp_prob.max():.2f} "
              f"geom={out_parts[-1]['geom']['geom_top']}/{gp.max():.2f}", file=sys.stderr)

    result = {
        "ok": True,
        "source": "vision",
        "model": MODEL_ID,
        "asset_type": asset_type,
        "asset_family": family,
        "device": device,
        "device_info": devinfo,
        "vocab": labels,
        "mirror_pairs": [list(p) for p in pairs],
        "frame": frame,
        "fusion": f"log(clip) + {LAMBDA}*log(softmax(geom)); abstain conf<{CONF_THRESH} or margin<{MARGIN_THRESH}",
        "n_parts": n,
        "n_abstained": sum(1 for p in out_parts if p["abstained"]),
        "parts": out_parts,
        "elapsed_s": round(time.time() - t0, 1),
    }
    return result


def main():
    ap = argparse.ArgumentParser(description="Part Namer voie B (vision) — CLIP-L + priors géométriques.")
    ap.add_argument("glb", help="chemin du GLB segmenté (sous-meshes part_XX)")
    ap.add_argument("out", help="chemin du JSON de sortie")
    ap.add_argument("--asset-type", default="other",
                    help="vehicle|avion|bateau|building|environment|weapon|character|creature|animal|other|custom")
    args = ap.parse_args()
    try:
        result = run(args.glb, args.out, args.asset_type)
    except Exception as e:
        import traceback
        traceback.print_exc()
        err = {"ok": False, "source": "vision", "error": str(e)}
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(err, f, indent=2)
        print(json.dumps(err))
        sys.exit(1)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)
    print(f"[done] {result['elapsed_s']}s  {result['n_parts']} parts, "
          f"{result['n_abstained']} abstention(s) -> {args.out}", file=sys.stderr)
    # résumé stdout (léger)
    print(json.dumps({"ok": True, "n_parts": result["n_parts"],
                      "n_abstained": result["n_abstained"],
                      "labels": [p["label"] for p in result["parts"]]}))


if __name__ == "__main__":
    main()
