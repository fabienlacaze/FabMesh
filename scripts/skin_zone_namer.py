#!/usr/bin/env python3
"""skin_zone_namer.py — POC-1 « Part Namer » voie A : nommage des zones
d'un mesh riggé à partir de ses poids de skinning.

Principe
--------
1. Lit JOINTS_0 / WEIGHTS_0 du GLB riggé (parser GLB pur numpy, zéro
   dépendance au-delà de numpy/scipy).
2. Bone DOMINANT par face = argmax de la somme des poids des 3 sommets.
3. Bone -> zone canonique via la table `rig_templates/bone_zones.json`
   (prefix-match insensible à la casse, longest-prefix-wins ; alias
   UE5/orc_m1 + Mixamo ; ik_/ctrl_/target_/pole_/root exclus ;
   twist / bones non matchés -> héritage du label du parent).
   RÉCUPÉRATION DES OS IK PORTEURS DE POIDS : sur certains rigs
   UE5-mannequin, les os de contrôle (ik_hand_l, ik_foot_r…) portent
   des poids et DOMINENT des faces ; les exclure sèchement ferait
   tomber ces faces en 'unlabeled' (jusqu'à ~22% d'aire mains/pieds).
   Or ces os forment leur PROPRE sous-arbre (ik_hand_l -> ik_hand_gun
   -> ik_hand_root) : remonter les parents ne trouve aucun os
   mappable. On récupère donc leur zone en RETIRANT le préfixe technique
   (ik_/ctrl_/…) puis en re-classant le reste par nom (ik_hand_l ->
   hand_l -> left_hand). Si le nom ne donne rien, on tente malgré tout
   l'héritage parent. Aucun label fantôme : on n'assigne que ce que le
   nom dit, jamais par proximité.
4. Si un GLB segmenté (PartSAM, sous-meshes part_XX) est fourni : vote
   majoritaire PONDÉRÉ PAR AIRE des faces de chaque part, transfert par
   cKDTree sur les centres de triangles (topologies possiblement
   différentes ; les deux nuages sont normalisés bbox avant le match).
5. Rig synthétique (joint_N / bone_N majoritaires) : détecté et signalé
   (`synthetic_rig: true`) ; zones GROSSIÈRES par positions relatives
   (hauteur/latéralité normalisées, convention Y-up) marquées
   `coarse: true`. Le fallback topologique complet = TODO v2.

Sortie : JSON sur stdout (logs sur stderr). Toute erreur -> JSON
`{"error": ...}` propre + exit 1. Déterministe, CPU only.

Usage
-----
    python skin_zone_namer.py <rigged.glb> [segmented.glb]

Labels canoniques : head, torso, pelvis, left_arm, right_arm,
left_hand, right_hand, left_leg, right_leg, left_foot, right_foot,
tail, left_wing, right_wing (l'i18n FR viendra à l'affichage).
"""

from __future__ import annotations

import json
import re
import struct
import sys
import time
from pathlib import Path

import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
BONE_ZONES_JSON = SCRIPT_DIR / "rig_templates" / "bone_zones.json"

# Mêmes patterns que scripts/puppeteer_joint_renamer.py (_SYNTHETIC_PATTERNS)
_SYNTHETIC_PATTERNS = [
    re.compile(r"^joint[_ ]*\d+$", re.IGNORECASE),
    re.compile(r"^bone[_ ]*\d+$", re.IGNORECASE),
    re.compile(r"^j\d+$", re.IGNORECASE),
    re.compile(r"^b\d+$", re.IGNORECASE),
]

_COMPONENT_DTYPES = {
    5120: np.int8, 5121: np.uint8,
    5122: np.int16, 5123: np.uint16,
    5125: np.uint32, 5126: np.float32,
}
_TYPE_COUNTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def log(msg: str) -> None:
    """Log sur stderr (stdout est réservé au JSON de sortie)."""
    print(f"[skin_zone_namer] {msg}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Parser GLB minimal (JSON chunk + BIN chunk), pur struct/numpy
# ---------------------------------------------------------------------------
def load_glb(path: str) -> tuple[dict, bytes]:
    """Charge un .glb -> (gltf_json, bin_blob)."""
    with open(path, "rb") as f:
        data = f.read()
    if len(data) < 20 or data[:4] != b"glTF":
        raise ValueError(f"Pas un GLB valide: {path}")
    gltf_json = None
    blob = b""
    offset = 12
    while offset + 8 <= len(data):
        chunk_len, chunk_type = struct.unpack_from("<II", data, offset)
        chunk = data[offset + 8: offset + 8 + chunk_len]
        if chunk_type == 0x4E4F534A:  # 'JSON'
            gltf_json = json.loads(chunk)
        elif chunk_type == 0x004E4942:  # 'BIN'
            blob = bytes(chunk)
        offset += 8 + chunk_len
    if gltf_json is None:
        raise ValueError(f"Chunk JSON absent du GLB: {path}")
    return gltf_json, blob


def read_accessor(gltf: dict, blob: bytes, accessor_index: int) -> np.ndarray:
    """Lit un accessor glTF en numpy (adapté de swap_skeleton.read_accessor_data).

    Les WEIGHTS_0 stockés en uint8/uint16 normalisés sont convertis en
    float via le flag `normalized`.
    """
    acc = gltf["accessors"][accessor_index]
    bv = gltf["bufferViews"][acc["bufferView"]]
    dtype = _COMPONENT_DTYPES[acc["componentType"]]
    n_comp = _TYPE_COUNTS[acc["type"]]
    elem_size = np.dtype(dtype).itemsize * n_comp
    stride = bv.get("byteStride") or elem_size
    offset = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    count = acc["count"]

    if stride == elem_size:
        raw = blob[offset: offset + count * elem_size]
        arr = np.frombuffer(raw, dtype=dtype).reshape(count, n_comp).copy()
    else:
        raw = np.frombuffer(blob, dtype=np.uint8)
        idx = offset + stride * np.arange(count)[:, None] + np.arange(elem_size)[None, :]
        arr = raw[idx].view(dtype).reshape(count, n_comp).copy()

    if acc.get("normalized") and dtype in (np.uint8, np.uint16):
        arr = arr.astype(np.float32) / float(np.iinfo(dtype).max)
    return arr


def _node_local_matrix(node: dict) -> np.ndarray:
    """Matrice locale 4x4 d'un node (matrix ou composition T*R*S)."""
    if "matrix" in node:
        return np.array(node["matrix"], dtype=np.float64).reshape(4, 4).T
    m = np.eye(4)
    if "rotation" in node:
        x, y, z, w = node["rotation"]
        m[:3, :3] = np.array([
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ])
    if "scale" in node:
        m[:3, :3] = m[:3, :3] @ np.diag(node["scale"])
    if "translation" in node:
        m[:3, 3] = node["translation"]
    return m


def compute_world_matrices(gltf: dict) -> list[np.ndarray]:
    """Matrices monde de tous les nodes (parcours parent -> enfant)."""
    nodes = gltf.get("nodes", [])
    parent = {}
    for i, node in enumerate(nodes):
        for c in node.get("children", []):
            parent[c] = i
    world: list[np.ndarray | None] = [None] * len(nodes)

    def resolve(i: int) -> np.ndarray:
        if world[i] is None:
            local = _node_local_matrix(nodes[i])
            p = parent.get(i, -1)
            world[i] = local if p < 0 else resolve(p) @ local
        return world[i]

    for i in range(len(nodes)):
        resolve(i)
    return world  # type: ignore[return-value]


def build_joint_parent_map(gltf: dict, joints: list[int]) -> dict[int, int]:
    """Pour chaque node-joint, le node-joint ancêtre le plus proche (-1 si racine)."""
    parent = {}
    for i, node in enumerate(gltf.get("nodes", [])):
        for c in node.get("children", []):
            parent[c] = i
    joint_set = set(joints)
    out = {}
    for j in joints:
        p = parent.get(j, -1)
        while p >= 0 and p not in joint_set:
            p = parent.get(p, -1)
        out[j] = p
    return out


# ---------------------------------------------------------------------------
# Extraction géométrie + skin
# ---------------------------------------------------------------------------
def extract_skinned_geometry(gltf: dict, blob: bytes):
    """Concatène tous les primitives des nodes skinnés du GLB.

    Retourne (positions_world (V,3) f64, faces (F,3) i64,
    dominant_joint_node (F,) i64 = index du NODE joint dominant par face,
    joint_nodes = liste triée des nodes joints rencontrés).
    """
    all_pos, all_faces, all_dom = [], [], []
    v_off = 0
    joint_nodes_seen: list[int] = []
    world = compute_world_matrices(gltf)

    skinned = [(i, n) for i, n in enumerate(gltf.get("nodes", []))
               if n.get("mesh") is not None and n.get("skin") is not None]
    if not skinned:
        raise ValueError("Aucun node skinné (mesh + skin) — le GLB est-il riggé ?")

    for node_idx, node in skinned:
        skin = gltf["skins"][node["skin"]]
        skin_joints = list(skin["joints"])  # local joint idx -> node idx
        for jn in skin_joints:
            if jn not in joint_nodes_seen:
                joint_nodes_seen.append(jn)
        local_to_node = np.array(skin_joints, dtype=np.int64)
        wm = world[node_idx]

        mesh = gltf["meshes"][node["mesh"]]
        for prim in mesh["primitives"]:
            attrs = prim["attributes"]
            if "JOINTS_0" not in attrs or "WEIGHTS_0" not in attrs:
                raise ValueError("Primitive sans JOINTS_0/WEIGHTS_0")
            pos = read_accessor(gltf, blob, attrs["POSITION"]).astype(np.float64)
            pos = pos @ wm[:3, :3].T + wm[:3, 3]
            joints = read_accessor(gltf, blob, attrs["JOINTS_0"]).astype(np.int64)
            weights = read_accessor(gltf, blob, attrs["WEIGHTS_0"]).astype(np.float64)
            if "indices" in prim:
                idx = read_accessor(gltf, blob, prim["indices"]).reshape(-1)
            else:
                idx = np.arange(len(pos))
            faces = idx.reshape(-1, 3).astype(np.int64)

            # Bone dominant par face: argmax de la somme des poids des 3 sommets
            J = len(skin_joints)
            F = len(faces)
            flat = np.zeros(F * J, dtype=np.float64)
            face_ids = np.repeat(np.arange(F, dtype=np.int64), 4)
            for k in range(3):
                v = faces[:, k]
                keys = face_ids * J + joints[v].reshape(-1)
                np.add.at(flat, keys, weights[v].reshape(-1))
            dom_local = flat.reshape(F, J).argmax(axis=1)
            dom_node = local_to_node[dom_local]

            all_pos.append(pos)
            all_faces.append(faces + v_off)
            all_dom.append(dom_node)
            v_off += len(pos)

    positions = np.concatenate(all_pos)
    faces = np.concatenate(all_faces)
    dominant = np.concatenate(all_dom)
    return positions, faces, dominant, joint_nodes_seen


def face_centers_areas(positions: np.ndarray, faces: np.ndarray):
    """Centres et aires des triangles."""
    tri = positions[faces]  # (F,3,3)
    centers = tri.mean(axis=1)
    areas = 0.5 * np.linalg.norm(
        np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1)
    return centers, areas


# ---------------------------------------------------------------------------
# Classification bone -> zone
# ---------------------------------------------------------------------------
def load_zone_table(path: Path = BONE_ZONES_JSON) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _detect_side(core: str) -> tuple[str | None, str]:
    """Détecte le marqueur de côté et le retire du nom normalisé."""
    for pre, side in (("left_", "left"), ("left", "left"), ("l_", "left"),
                      ("right_", "right"), ("right", "right"), ("r_", "right")):
        if core.startswith(pre) and len(core) > len(pre):
            return side, core[len(pre):]
    for suf, side in (("_left", "left"), ("_l", "left"), (".l", "left"),
                      ("_right", "right"), ("_r", "right"), (".r", "right")):
        if core.endswith(suf) and len(core) > len(suf):
            return side, core[: -len(suf)]
    for tok, side in (("_left_", "left"), ("_l_", "left"),
                      ("_right_", "right"), ("_r_", "right")):
        if tok in core:
            return side, core.replace(tok, "_", 1)
    return None, core


def classify_bone_name(name: str, table: dict) -> str | None:
    """Nom de bone -> label canonique, ou None (exclu / non matché)."""
    core = name.strip().lower()
    for sp in table.get("strip_prefixes", []):
        if core.startswith(sp):
            core = core[len(sp):]
    for ex in table.get("exclude_prefixes", []):
        if core.startswith(ex) or core == ex.rstrip("_"):
            return None
    side, stem = _detect_side(core)
    best_len, best = -1, None
    for part in table["parts"]:
        for pfx in part["prefixes"]:
            if stem.startswith(pfx) and len(pfx) > best_len:
                best_len, best = len(pfx), part
        # aussi tenter sans retrait de côté (ex: 'ringtoe' vs 'ring')
        for pfx in part["prefixes"]:
            if core.startswith(pfx) and len(pfx) > best_len:
                best_len, best = len(pfx), part
    if best is None:
        return None
    if best["sided"] and side:
        return f"{side}_{best['label']}"
    return best["label"]


def recover_excluded_label(name: str, table: dict) -> str | None:
    """Zone d'un os EXCLU (ik_/ctrl_/…) porteur de poids, déduite de son
    NOM en retirant le préfixe technique puis en re-classant le reste.

    ik_hand_l -> hand_l -> left_hand ; ik_foot_r -> foot_r -> right_foot ;
    ik_foot_root -> foot_root -> foot. Retourne None si le préfixe est le
    nom entier (ex: 'root') ou si le reste ne matche aucune zone — dans ce
    cas l'appelant tentera l'héritage parent.
    """
    core = name.strip().lower()
    for ex in table.get("exclude_prefixes", []):
        if core.startswith(ex) and len(core) > len(ex):
            # Re-classe le reste ; classify_bone_name ré-applique
            # strip_prefixes, détection de côté et exclude_prefixes.
            return classify_bone_name(core[len(ex):], table)
    return None


def classify_all_bones(gltf: dict, joint_nodes: list[int], table: dict) -> dict[int, str | None]:
    """Label par node-joint.

    - Twist génériques / sharebones non matchés -> héritage du label du
      parent dans la hiérarchie.
    - Os EXCLUS (ik_/ctrl_/…) : récupération par NOM (retrait du préfixe
      technique + re-classement), puis héritage parent en dernier recours.
      Évite que des os IK porteurs de poids (mains/pieds sur rigs UE5)
      fassent tomber leurs faces en 'unlabeled'.
    """
    names = {j: (gltf["nodes"][j].get("name") or f"joint_{j}") for j in joint_nodes}
    direct = {j: classify_bone_name(names[j], table) for j in joint_nodes}
    jparent = build_joint_parent_map(gltf, joint_nodes)
    excl_prefixes = table.get("exclude_prefixes", [])

    resolved: dict[int, str | None] = {}

    def resolve(j: int, depth: int = 0) -> str | None:
        if j in resolved:
            return resolved[j]
        if depth > 64:
            return None
        resolved[j] = None  # garde-fou anti-cycle pendant la récursion
        lbl = direct.get(j)
        if lbl is None:
            core = names[j].strip().lower()
            excluded = any(core.startswith(ex) for ex in excl_prefixes)
            if excluded:
                # 1) déduire la zone du nom de l'os IK lui-même
                lbl = recover_excluded_label(names[j], table)
            # 2) héritage parent (os exclus au nom muet, ou os non matchés)
            if lbl is None:
                p = jparent.get(j, -1)
                if p >= 0:
                    lbl = resolve(p, depth + 1)
        resolved[j] = lbl
        return lbl

    for j in joint_nodes:
        resolve(j)
    return resolved


def is_synthetic_rig(names: list[str]) -> bool:
    """True si >= 60% des noms de joints sont auto-générés (joint_0...)."""
    if not names:
        return False
    n = sum(1 for nm in names if any(p.match(nm.strip()) for p in _SYNTHETIC_PATTERNS))
    return n >= max(1, int(0.6 * len(names)))


# ---------------------------------------------------------------------------
# Fallback grossier pour rigs synthétiques (positions relatives, Y-up)
# ---------------------------------------------------------------------------
def coarse_labels_from_positions(joint_nodes, dominant, centers, areas):
    """Zones GROSSIÈRES par bone via le centroïde (pondéré aire) des faces
    dominées par chaque bone, normalisé dans la bbox du mesh. Convention:
    Y-up, +X = côté gauche du personnage (personnage face à +Z glTF).
    Le vrai fallback topologique (chaînes/symétrie) = TODO v2.
    """
    lo, hi = centers.min(axis=0), centers.max(axis=0)
    size = np.maximum(hi - lo, 1e-9)
    labels: dict[int, str | None] = {}
    for j in joint_nodes:
        mask = dominant == j
        a = areas[mask]
        if a.sum() <= 0:
            labels[j] = None
            continue
        c = (centers[mask] * a[:, None]).sum(axis=0) / a.sum()
        ny = (c[1] - lo[1]) / size[1]                      # 0=bas, 1=haut
        nx = (c[0] - (lo[0] + hi[0]) / 2) / (size[0] / 2)  # -1..1 latéral
        side = "left" if nx >= 0 else "right"
        if ny > 0.75 and abs(nx) < 0.40:
            labels[j] = "head"
        elif ny < 0.45:
            labels[j] = f"{side}_leg" if abs(nx) > 0.05 else "pelvis"
        elif abs(nx) > 0.30:
            labels[j] = f"{side}_arm"
        else:
            labels[j] = "torso"
    return labels


def coarse_self_check(face_labels, areas) -> tuple[bool, str]:
    """Plausibilité des zones grossières. Un rig synthétique sur une pose
    non-debout (créature rampante, pose dynamique) rend le classement par
    positions relatives invalide -> il faut s'abstenir proprement.

    Critères: aires gauche/droite équilibrées (ratio <= 3) et une zone
    head plausible (0.5%..35% de l'aire).
    """
    fl = np.array([l if l else "" for l in face_labels])
    total = float(areas.sum()) or 1.0
    left = float(areas[np.char.startswith(fl, "left_")].sum())
    right = float(areas[np.char.startswith(fl, "right_")].sum())
    if left + right > 0:
        lo_side, hi_side = min(left, right), max(left, right)
        if lo_side <= 0 or hi_side / max(lo_side, 1e-12) > 3.0:
            return False, (f"asymetrie gauche/droite invraisemblable "
                           f"(left={100 * left / total:.1f}%, right={100 * right / total:.1f}%)")
    head = float(areas[fl == "head"].sum()) / total
    if not (0.005 <= head <= 0.35):
        return False, f"zone head invraisemblable ({100 * head:.1f}% de l'aire)"
    return True, ""


# ---------------------------------------------------------------------------
# Agrégation zones + transfert vers mesh segmenté
# ---------------------------------------------------------------------------
def summarize_zones(face_labels, centers, areas) -> dict:
    """{label: {area_pct, centroid}} sur les faces du mesh riggé."""
    total = float(areas.sum()) or 1.0
    zones: dict[str, dict] = {}
    uniq = sorted(set(l for l in face_labels if l))
    fl = np.array([l if l else "" for l in face_labels])
    for lbl in uniq:
        m = fl == lbl
        a = float(areas[m].sum())
        c = (centers[m] * areas[m][:, None]).sum(axis=0) / max(a, 1e-12)
        zones[lbl] = {"area_pct": round(100 * a / total, 2),
                      "centroid": [round(float(x), 5) for x in c]}
    unlabeled = float(areas[fl == ""].sum())
    if unlabeled > 0:
        zones["_unlabeled"] = {"area_pct": round(100 * unlabeled / total, 2),
                               "centroid": None}
    return zones


def extract_plain_meshes(gltf: dict, blob: bytes):
    """Sous-meshes d'un GLB segmenté: [(part_name, centers, areas)]."""
    world = compute_world_matrices(gltf)
    parts = []
    for node_idx, node in enumerate(gltf.get("nodes", [])):
        if node.get("mesh") is None:
            continue
        mesh = gltf["meshes"][node["mesh"]]
        name = node.get("name") or mesh.get("name") or f"part_{len(parts):02d}"
        wm = world[node_idx]
        p_list, f_list, off = [], [], 0
        for prim in mesh["primitives"]:
            pos = read_accessor(gltf, blob, prim["attributes"]["POSITION"]).astype(np.float64)
            pos = pos @ wm[:3, :3].T + wm[:3, 3]
            if "indices" in prim:
                idx = read_accessor(gltf, blob, prim["indices"]).reshape(-1)
            else:
                idx = np.arange(len(pos))
            p_list.append(pos)
            f_list.append(idx.reshape(-1, 3).astype(np.int64) + off)
            off += len(pos)
        pos = np.concatenate(p_list)
        faces = np.concatenate(f_list)
        centers, areas = face_centers_areas(pos, faces)
        parts.append((name, centers, areas))
    if not parts:
        raise ValueError("Aucun mesh trouvé dans le GLB segmenté")
    return parts


def transfer_labels_to_parts(parts, rig_centers, rig_face_labels):
    """Vote majoritaire pondéré par aire, transfert cKDTree (nuages
    normalisés bbox chacun de leur côté pour tolérer des frames
    différents entre le mesh riggé et le mesh segmenté).

    Retourne une LISTE ordonnée [{part_id, label, confidence, ...}]
    conforme au contrat de sortie (part_id = nom du sous-mesh). Les
    faces non nommées côté rig produisent le label 'unlabeled'.
    """
    from scipy.spatial import cKDTree

    def normalize(pts, lo, hi):
        c = (lo + hi) / 2
        s = max(float((hi - lo).max()), 1e-9)
        return (pts - c) / s

    rig_lo, rig_hi = rig_centers.min(axis=0), rig_centers.max(axis=0)
    all_seg = np.concatenate([c for _, c, _ in parts])
    seg_lo, seg_hi = all_seg.min(axis=0), all_seg.max(axis=0)

    tree = cKDTree(normalize(rig_centers, rig_lo, rig_hi))
    fl = np.array([l if l else "unlabeled" for l in rig_face_labels])
    grand_total = sum(float(a.sum()) for _, _, a in parts) or 1.0

    out = []
    for name, centers, areas in parts:
        _, nn = tree.query(normalize(centers, seg_lo, seg_hi), workers=-1)
        lbls = fl[nn]
        total = float(areas.sum()) or 1e-12
        shares = {}
        for lbl in np.unique(lbls):
            shares[str(lbl)] = float(areas[lbls == lbl].sum()) / total
        win = max(shares, key=shares.get)
        out.append({
            "part_id": name,
            "label": win,
            "confidence": round(shares[win], 3),
            "area_pct_of_mesh": round(100 * total / grand_total, 2),
            "areas": {k: round(100 * v, 2) for k, v in
                      sorted(shares.items(), key=lambda kv: -kv[1])},
        })
    return out


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def name_zones(rigged_glb: str, segmented_glb: str | None = None) -> dict:
    """Pipeline complet -> dict JSON-sérialisable."""
    t0 = time.perf_counter()
    gltf, blob = load_glb(rigged_glb)
    positions, faces, dominant, joint_nodes = extract_skinned_geometry(gltf, blob)
    centers, areas = face_centers_areas(positions, faces)
    names = [gltf["nodes"][j].get("name") or f"joint_{j}" for j in joint_nodes]
    log(f"{len(faces)} faces, {len(joint_nodes)} joints "
        f"({rigged_glb.rsplit('/', 1)[-1].rsplit(chr(92), 1)[-1]})")

    abstained, abstain_reason = False, ""
    synthetic = is_synthetic_rig(names)
    if synthetic:
        log("rig SYNTHÉTIQUE détecté (joint_N/bone_N) -> zones grossières "
            "par positions relatives (fallback topologique = TODO v2)")
        bone_labels = coarse_labels_from_positions(joint_nodes, dominant, centers, areas)
        face_labels = [bone_labels.get(int(j)) for j in dominant]
        ok, abstain_reason = coarse_self_check(face_labels, areas)
        if not ok:
            log(f"ABSTENTION zones grossières: {abstain_reason}")
            abstained = True
            bone_labels = {j: None for j in joint_nodes}
    else:
        table = load_zone_table()
        bone_labels = classify_all_bones(gltf, joint_nodes, table)

    face_labels = [bone_labels.get(int(j)) for j in dominant]
    zones = summarize_zones(face_labels, centers, areas)

    # Contrat de sortie stable (voir StructuredOutput / wiring prod) :
    #   {ok, source:'skeleton', synthetic_rig, abstained,
    #    parts:[{part_id,label,confidence}]  (si segmented.glb fourni)
    #    | zones:{label:{area_pct,centroid}}  (sinon)}
    # Champs de diagnostic supplémentaires (num_faces, elapsed_s,
    # abstain_reason, coarse) tolérés par les consommateurs JSON.
    result: dict = {
        "ok": True,
        "source": "skeleton",
        "synthetic_rig": synthetic,
        "abstained": abstained,
        "abstain_reason": abstain_reason,
        "coarse": synthetic and not abstained,
        "num_faces": int(len(faces)),
        "num_joints": len(joint_nodes),
    }

    if segmented_glb:
        seg_gltf, seg_blob = load_glb(segmented_glb)
        parts = extract_plain_meshes(seg_gltf, seg_blob)
        log(f"{len(parts)} parts dans le GLB segmenté, transfert cKDTree...")
        result["segmented_glb"] = segmented_glb
        result["parts"] = transfer_labels_to_parts(parts, centers, face_labels)
    else:
        result["zones"] = zones

    result["elapsed_s"] = round(time.perf_counter() - t0, 3)
    return result


def main(argv: list[str]) -> int:
    if len(argv) < 2 or len(argv) > 3:
        print(json.dumps({"error": "usage: skin_zone_namer.py <rigged.glb> [segmented.glb]"}))
        return 1
    try:
        result = name_zones(argv[1], argv[2] if len(argv) == 3 else None)
    except Exception as e:  # noqa: BLE001 — no-op JSON propre sur tout échec
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
