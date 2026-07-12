#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""name_parts.py — ROUTEUR « Part Namer » : aiguille un GLB segmente vers la
bonne voie de nommage semantique de ses sous-parties, puis ecrit un sidecar
JSON stable que l'app lira par part_id (les nodes du GLB ne sont PAS renommes,
c'est plus simple et reversible).

Deux voies (chacune un script autonome, appele en sous-processus avec le meme
interpreteur Python que le routeur) :

  VOIE A — squelette (scripts/skin_zone_namer.py)
      Pour les etres vivants RIGGES (character/creature/animal/insect/
      other_living) : les zones sont deduites des POIDS DE SKINNING (bone
      dominant par face -> zone canonique), transferees au mesh segmente par
      plus-proche-voisin. Gratuit, deterministe, tres fiable quand un rig
      existe. Necessite --rig.

  VOIE B — vision (scripts/part_namer_vision.py)
      Pour tout le reste (vehicules, batiments, armes, objets) ET pour les
      etres vivants SANS rig : rendu isole de chaque part + CLIP-L + priors
      geometriques + abstention. Vocabulaire ferme par type d'asset.

Regle de routage
----------------
    --rig fourni ET assetType ∈ living_types  -> VOIE A
    sinon (ou si la VOIE A echoue)            -> VOIE B (fallback gracieux)

Degradations gracieuses gerees :
  * assetType vivant mais PAS de rig                 -> VOIE B (vocab vivant)
  * VOIE A leve une erreur (mesh non skinne, etc.)   -> VOIE B (fallback)
  * assetType inconnu                                -> VOIE B (vocab 'other')

Sortie
------
Sidecar JSON ecrit dans <out_sidecar.json> (convention app : <mesh>.parts.json)
    {
      "schema": 1,
      "source": "skeleton" | "vision",
      "asset_type": "<tel que passe>",
      "parts": [{"part_id": str, "label": str, "confidence": float,
                 "abstained": bool}],
      "ts": <epoch float>,
      ... champs de diagnostic additifs (route, engine, ...) toleres ...
    }
En cas d'echec total (les deux voies echouent) : sidecar
    {"schema":1, "source":"error", "error": str, "parts": []}  + exit 1.

Usage
-----
    python name_parts.py <segmented.glb> <out_sidecar.json> --asset-type TYPE \
        [--rig RIGGED.glb]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

os.environ.setdefault("PYTHONUTF8", "1")

SCRIPT_DIR = Path(__file__).resolve().parent
VOCAB_JSON = SCRIPT_DIR / "rig_templates" / "part_vocab.json"
SKIN_NAMER = SCRIPT_DIR / "skin_zone_namer.py"
VISION_NAMER = SCRIPT_DIR / "part_namer_vision.py"

# assetType qui peuvent partir en VOIE A (squelette) si un rig est fourni.
LIVING_TYPES = {"character", "creature", "animal", "insect", "other_living"}

# Remapping assetType -> assetType compris par part_namer_vision (VOIE B).
# part_namer_vision connait: vehicle/avion/bateau, building/environment, weapon,
# character/creature/animal, other/custom. On rabat insect/other_living sur
# 'creature' pour recuperer le vocab du vivant plutot que le generique 'part'.
_VISION_TYPE_ALIASES = {
    "insect": "creature",
    "other_living": "creature",
}


def log(msg: str) -> None:
    print(f"[name_parts] {msg}", file=sys.stderr, flush=True)


def load_vocab() -> dict:
    with open(VOCAB_JSON, "r", encoding="utf-8") as f:
        return json.load(f)


def vision_asset_type(asset_type: str) -> str:
    at = (asset_type or "other").strip().lower()
    return _VISION_TYPE_ALIASES.get(at, at)


# ---------------------------------------------------------------------------
# VOIE A — squelette
# ---------------------------------------------------------------------------
def run_voie_a(segmented_glb: str, rig_glb: str) -> dict:
    """Appelle skin_zone_namer.py <rig> <segmented> et parse le JSON stdout.

    Retourne le dict brut du sous-script. Leve RuntimeError si le sous-script
    echoue (returncode != 0 ou JSON {"error": ...}) pour permettre le fallback.
    """
    cmd = [sys.executable, str(SKIN_NAMER), rig_glb, segmented_glb]
    log(f"VOIE A -> {' '.join(Path(c).name if os.path.sep in c else c for c in cmd[1:])}")
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if proc.stderr:
        for line in proc.stderr.rstrip().splitlines():
            log(f"  [A] {line}")
    out = proc.stdout.strip()
    if not out:
        raise RuntimeError(f"skin_zone_namer: sortie vide (rc={proc.returncode})")
    try:
        data = json.loads(out.splitlines()[-1])
    except Exception as e:
        raise RuntimeError(f"skin_zone_namer: JSON illisible: {e}") from e
    if proc.returncode != 0 or "error" in data:
        raise RuntimeError(f"skin_zone_namer: {data.get('error', 'rc=' + str(proc.returncode))}")
    return data


def parts_from_voie_a(data: dict) -> list[dict]:
    """Normalise les parts de la VOIE A vers le contrat sidecar.

    skin_zone_namer ne renvoie pas d'`abstained` par part : on le derive
    (label 'unlabeled'/vide, ou abstention globale du rig => abstained).
    """
    global_abstain = bool(data.get("abstained"))
    parts = []
    for p in data.get("parts", []):
        label = p.get("label") or "unlabeled"
        abst = global_abstain or label in ("unlabeled", "_unlabeled", "")
        parts.append({
            "part_id": p["part_id"],
            "label": "unlabeled" if abst and label in ("", "_unlabeled") else label,
            "confidence": round(float(p.get("confidence", 0.0)), 4),
            "abstained": bool(abst),
        })
    return parts


# ---------------------------------------------------------------------------
# VOIE B — vision
# ---------------------------------------------------------------------------
def run_voie_b(segmented_glb: str, asset_type: str) -> dict:
    """Appelle part_namer_vision.py <segmented> <tmp.json> --asset-type <at>.

    Le sous-script ECRIT son resultat complet dans le fichier de sortie ; on le
    relit. Retourne le dict. Leve RuntimeError si echec.
    """
    vat = vision_asset_type(asset_type)
    tmp = Path(segmented_glb).with_suffix(".vision.tmp.json")
    cmd = [sys.executable, str(VISION_NAMER), segmented_glb, str(tmp),
           "--asset-type", vat]
    log(f"VOIE B -> part_namer_vision (--asset-type {vat})")
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if proc.stderr:
        for line in proc.stderr.rstrip().splitlines():
            log(f"  [B] {line}")
    data = None
    if tmp.exists():
        try:
            with open(tmp, "r", encoding="utf-8") as f:
                data = json.load(f)
        finally:
            try:
                tmp.unlink()
            except OSError:
                pass
    if data is None:
        raise RuntimeError(f"part_namer_vision: pas de sortie (rc={proc.returncode})")
    if not data.get("ok", False):
        raise RuntimeError(f"part_namer_vision: {data.get('error', 'echec')}")
    return data


def parts_from_voie_b(data: dict) -> list[dict]:
    """Normalise les parts de la VOIE B vers le contrat sidecar."""
    parts = []
    for p in data.get("parts", []):
        parts.append({
            "part_id": p["part_id"],
            "label": p.get("label", "unknown"),
            "confidence": round(float(p.get("confidence", 0.0)), 4),
            "abstained": bool(p.get("abstained", False)),
        })
    return parts


# ---------------------------------------------------------------------------
# Routeur
# ---------------------------------------------------------------------------
def route(segmented_glb: str, out_sidecar: str, asset_type: str,
          rig_glb: str | None = None) -> dict:
    t0 = time.time()
    at = (asset_type or "other").strip().lower()
    is_living = at in LIVING_TYPES
    rig_ok = bool(rig_glb) and Path(rig_glb).is_file()

    source = None
    parts: list[dict] = []
    route_taken = None
    fallback_reason = None
    engine = None

    want_voie_a = is_living and rig_ok
    if is_living and rig_glb and not rig_ok:
        log(f"rig demande mais introuvable: {rig_glb} -> bascule VOIE B")
        fallback_reason = "rig_not_found"
    elif is_living and not rig_glb:
        log("assetType vivant sans --rig -> VOIE B (vision)")
        fallback_reason = "no_rig_provided"

    if want_voie_a:
        try:
            data = run_voie_a(segmented_glb, rig_glb)  # type: ignore[arg-type]
            parts = parts_from_voie_a(data)
            source = "skeleton"
            route_taken = "A"
            engine = "skin_zone_namer"
            if not parts:
                raise RuntimeError("VOIE A n'a produit aucune part")
            # Filet anti-mauvais-routage : si la voie squelette abstient en
            # masse (>60% 'unlabeled'), c'est un non-humanoïde étiqueté vivant
            # (ex: véhicule en assetType 'character' + un rig quelconque du
            # projet) -> bascule vision (le vrai signal était l'assetType faux).
            _na = sum(1 for p in parts if p["abstained"])
            if len(parts) and _na / len(parts) > 0.6:
                raise RuntimeError(
                    f"VOIE A abstient en masse ({_na}/{len(parts)}) — "
                    "mauvais match squelette")
        except Exception as e:  # noqa: BLE001 — fallback gracieux vers vision
            log(f"VOIE A a echoue ({e}) -> fallback VOIE B")
            fallback_reason = f"voie_a_failed: {e}"
            source = None

    if source is None:
        # VOIE B (par choix de routage OU fallback)
        data = run_voie_b(segmented_glb, at)
        parts = parts_from_voie_b(data)
        source = "vision"
        route_taken = "B"
        engine = data.get("model", "part_namer_vision")

    result = {
        "schema": 1,
        "source": source,
        "asset_type": asset_type,
        "parts": parts,
        "ts": round(time.time(), 3),
        # --- diagnostic additif (tolere par les consommateurs) ---
        "route": route_taken,
        "engine": engine,
        "rig": rig_glb if (route_taken == "A") else None,
        "fallback_reason": fallback_reason,
        "n_parts": len(parts),
        "n_abstained": sum(1 for p in parts if p["abstained"]),
        "elapsed_s": round(time.time() - t0, 2),
    }
    return result


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Routeur Part Namer : squelette (voie A) ou vision (voie B).")
    ap.add_argument("segmented", help="GLB segmente (sous-meshes part_XX)")
    ap.add_argument("out", help="chemin du sidecar JSON de sortie (<mesh>.parts.json)")
    ap.add_argument("--asset-type", default="other",
                    help="character|creature|animal|insect|other_living|vehicle|"
                         "avion|bateau|building|environment|weapon|other|custom")
    ap.add_argument("--rig", default=None,
                    help="GLB rigge (active la voie A pour les assetType vivants)")
    args = ap.parse_args()

    if not Path(args.segmented).is_file():
        err = {"schema": 1, "source": "error",
               "error": f"segmented GLB introuvable: {args.segmented}", "parts": []}
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(err, f, ensure_ascii=False, indent=2)
        print(json.dumps(err, ensure_ascii=False))
        return 1

    try:
        result = route(args.segmented, args.out, args.asset_type, args.rig)
    except Exception as e:  # noqa: BLE001 — echec total des deux voies
        import traceback
        traceback.print_exc()
        err = {"schema": 1, "source": "error", "error": f"{type(e).__name__}: {e}",
               "asset_type": args.asset_type, "parts": []}
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(err, f, ensure_ascii=False, indent=2)
        print(json.dumps(err, ensure_ascii=False))
        return 1

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    log(f"OK route={result['route']} source={result['source']} "
        f"{result['n_parts']} parts, {result['n_abstained']} abstention(s), "
        f"{result['elapsed_s']}s -> {args.out}")
    # resume leger sur stdout
    print(json.dumps({
        "schema": 1, "source": result["source"], "route": result["route"],
        "asset_type": result["asset_type"], "n_parts": result["n_parts"],
        "n_abstained": result["n_abstained"],
        "labels": [p["label"] for p in result["parts"]],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
