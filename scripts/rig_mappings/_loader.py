"""Loader for rig-mapping JSON files in scripts/rig_mappings/.

Each JSON file is keyed by (source_skeleton_id, target_family) and
defines:

  * a per-bone mapping table (source_name → role, side, chain_idx)
  * a list of `drop_patterns` (regex) — bones the retarget core must
    silently ignore in the SOURCE
  * an optional `extends` field naming another mapping JSON whose
    bones + drop_patterns are inherited (so ORC_M1 reuses every
    UE5 row without duplication)
  * an axis convention (e.g. source=z_up, target=y_up) used to build a
    3x3 rotation applied to bone offsets + root translation before the
    retarget core sees them
  * a fingerprint heuristic used by `parse_fbx` to auto-detect the
    source skeleton when the caller passes `hint='auto'`

Design goals (CLAUDE.md / chosen design):
  - Adding a new skeleton = adding a JSON file. NEVER a code change in
    the retarget core or this loader.
  - The loader exposes a Mapping object with `.classify(name)` that
    matches `scripts/anytop_retarget.py:_classify_source_bone` so it
    can be swapped in via the existing function signature.
  - `drop_patterns` matches return a sentinel tuple ('', '', -1) so the
    retarget bucketing loop (anytop_retarget.py L690-714) skips them
    automatically — it already ignores roles with empty strings.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np


_THIS_DIR = os.path.dirname(os.path.abspath(__file__))


# Sentinel returned by classify() for bones explicitly matched by a
# drop_patterns entry. The retarget core treats an empty role string
# as "ignore" (see anytop_retarget.py L693), so dropped bones
# contribute no motion and are never picked by the target matcher.
_DROP_SENTINEL: Tuple[str, Optional[str], int] = ("", None, -1)


@dataclass
class Mapping:
    """A resolved (source_skeleton_id, target_family) mapping.

    Attributes
    ----------
    source_skeleton_id : str
        e.g. 'ue5_mannequin', 'orc_m1'
    target_family : str
        e.g. 'humanoid_puppeteer', 'winged_puppeteer'
    bone_table : Dict[str, Tuple[str, Optional[str], int]]
        explicit source-bone-name → (role, side, chain_idx) lookup
    drop_re : re.Pattern
        compiled regex of OR'd drop_patterns (matches → sentinel)
    axis_source : str
        'y_up' | 'z_up' — used to build axis_to_target rotation
    axis_target : str
    root_strategy : str
        'pelvis_only' | 'root_and_pelvis' | 'motion_extraction'
    unit_scale : str | float
        'auto_bbox' (default) or a literal float multiplier
    fingerprint_required_bones : List[str]
        bones that MUST all be present for this skeleton to fingerprint
    """
    source_skeleton_id: str
    target_family: str
    bone_table: Dict[str, Tuple[str, Optional[str], int]] = field(default_factory=dict)
    drop_re: Optional[re.Pattern] = None
    axis_source: str = "y_up"
    axis_target: str = "y_up"
    root_strategy: str = "pelvis_only"
    unit_scale: object = "auto_bbox"
    fingerprint_required_bones: List[str] = field(default_factory=list)
    _drop_patterns_raw: List[str] = field(default_factory=list)
    # JSON-driven TARGET classification overlay. Built from the
    # optional "target_bones" + "target_drop_patterns" blocks in the
    # mapping JSON. Used by anytop_retarget.py to override the
    # geometric `_target_anatomical_roles` heuristic on known rig
    # families (humanoid_puppeteer) while leaving unknown rigs to
    # the geometric fallback.
    target_table: Dict[str, Tuple[str, Optional[str], int]] = field(default_factory=dict)
    target_drop_re: Optional[re.Pattern] = None
    _target_drop_patterns_raw: List[str] = field(default_factory=list)

    def classify(self, name: str) -> Tuple[str, Optional[str], int]:
        """Source-bone classifier. Same signature as
        `anytop_retarget._classify_source_bone`.

        Resolution order:
          1. drop_patterns regex  → ('', None, -1) sentinel (skip).
          2. explicit bone_table  → table row.
          3. fall back to caller (the retarget core uses
             `_classify_source_bone` as the default, so unknown bones
             still get the generic regex pass).
        """
        if not name:
            return ("", None, 0)
        # Case-insensitive match against the table — UE5 / CC4 names
        # use lowercase but exports occasionally capitalize on the
        # round-trip through Blender / Maya. Normalising here keeps
        # the JSON files readable (lowercase only).
        lower = name.strip().lower()
        if self.drop_re is not None and self.drop_re.search(lower):
            return _DROP_SENTINEL
        if lower in self.bone_table:
            return self.bone_table[lower]
        # Unknown — let the caller's fallback classifier handle it.
        # Returning a sentinel "no role" lets the retarget core's
        # existing generic regex pass run on the raw name. We can't
        # actually invoke it from here without importing the retarget
        # module, so we return the "no role" tuple and rely on the
        # `source_classifier` keyword argument plumbing in
        # `retarget_motion_to_rig` to do a two-stage resolution.
        return ("", None, 0)

    def is_dropped(self, name: str) -> bool:
        """True iff this bone name matches one of the drop_patterns."""
        if self.drop_re is None or not name:
            return False
        return bool(self.drop_re.search(name.strip().lower()))

    def axis_to_target(self, arr: np.ndarray) -> np.ndarray:
        """Apply the axis-convention rotation to a (..., 3) array.

        For UE5 (z-up) → Puppeteer (y-up), this is Rx(-90°):
            [ 1,  0,  0 ]
            [ 0,  0,  1 ]
            [ 0, -1,  0 ]
        which sends +Z → +Y, +Y → -Z.

        Per-bone parent-relative rotations are NOT touched. Once the
        WORLD rest pose is rotated consistently (we rotate offsets +
        root_pos here) the per-frame relative quaternions remain
        valid in the new frame.
        """
        if self.axis_source == self.axis_target or arr is None:
            return arr
        a = np.asarray(arr, dtype=np.float64)
        if a.shape[-1] != 3:
            return arr
        if self.axis_source == "z_up" and self.axis_target == "y_up":
            R = np.array([
                [1.0,  0.0, 0.0],
                [0.0,  0.0, 1.0],
                [0.0, -1.0, 0.0],
            ], dtype=np.float64)
            return a @ R.T
        if self.axis_source == "y_up" and self.axis_target == "z_up":
            R = np.array([
                [1.0,  0.0, 0.0],
                [0.0,  0.0, -1.0],
                [0.0,  1.0,  0.0],
            ], dtype=np.float64)
            return a @ R.T
        return arr


# Process-level cache: scanning + parsing happens once per import.
_CACHE: Dict[Tuple[str, str], Mapping] = {}
_LOADED = False


def _scan_dir() -> Dict[str, dict]:
    """Read every *.json file in this directory once. Return a dict
    keyed by JSON basename without extension so `extends` can resolve."""
    raw_by_basename: Dict[str, dict] = {}
    if not os.path.isdir(_THIS_DIR):
        return raw_by_basename
    for fn in os.listdir(_THIS_DIR):
        if not fn.endswith(".json"):
            continue
        path = os.path.join(_THIS_DIR, fn)
        try:
            with open(path, "r", encoding="utf-8") as f:
                raw = json.load(f)
        except Exception as e:
            print(f"[rig_mappings] WARN: cannot parse {fn}: {e}", flush=True)
            continue
        base = fn[:-len(".json")]
        raw_by_basename[base] = raw
    return raw_by_basename


def _resolve_one(base: str, raw_by_basename: Dict[str, dict],
                 seen: Optional[set] = None) -> Mapping:
    """Resolve a single mapping JSON, applying `extends` chains.

    `extends` semantics: the BASE mapping's bones + drop_patterns are
    PRE-pended; the child can override by listing the same bone again
    (last wins) and adds more drop_patterns.
    """
    seen = seen or set()
    if base in seen:
        raise RuntimeError(f"[rig_mappings] extends cycle at {base}")
    seen.add(base)
    raw = raw_by_basename.get(base)
    if raw is None:
        raise RuntimeError(f"[rig_mappings] unknown base {base!r}")

    bones: List[dict] = []
    drop_patterns: List[str] = []
    fingerprint: List[str] = []
    target_bones: List[dict] = []
    target_drop_patterns: List[str] = []

    parent_base = raw.get("extends")
    if isinstance(parent_base, str) and parent_base:
        parent = _resolve_one(parent_base, raw_by_basename, seen=set(seen))
        # Re-export the parent's table back to row form so we can
        # merge with the child's. The parent's `bone_table` is a dict
        # so we reverse-engineer rows from it.
        for src_name, (role, side, idx) in parent.bone_table.items():
            bones.append({"source": src_name, "role": role, "side": side, "chain_idx": idx})
        drop_patterns.extend(parent._drop_patterns_raw)
        fingerprint.extend(parent.fingerprint_required_bones)
        # Same trick for the target-side overlay so children inherit
        # the humanoid_puppeteer classification without redeclaring it.
        for tgt_name, (role, side, idx) in parent.target_table.items():
            target_bones.append({"target": tgt_name, "role": role, "side": side, "chain_idx": idx})
        target_drop_patterns.extend(parent._target_drop_patterns_raw)

    for b in (raw.get("bones") or []):
        bones.append(b)
    for p in (raw.get("drop_patterns") or []):
        drop_patterns.append(p)
    for fp in (raw.get("fingerprint_required_bones") or []):
        if fp not in fingerprint:
            fingerprint.append(fp)
    for b in (raw.get("target_bones") or []):
        target_bones.append(b)
    for p in (raw.get("target_drop_patterns") or []):
        target_drop_patterns.append(p)

    # Build the lookup table; later entries overwrite earlier ones so
    # the child JSON can override an inherited row.
    table: Dict[str, Tuple[str, Optional[str], int]] = {}
    for b in bones:
        name = str(b.get("source") or "").strip().lower()
        if not name:
            continue
        role = str(b.get("role") or "")
        raw_side = b.get("side", None)
        side: Optional[str] = None
        if isinstance(raw_side, str) and raw_side.strip():
            side = raw_side.strip().lower()
        try:
            idx = int(b.get("chain_idx") or 0)
        except (TypeError, ValueError):
            idx = 0
        table[name] = (role, side, idx)

    drop_re: Optional[re.Pattern] = None
    if drop_patterns:
        # Combine into one regex with non-capturing alternation. We
        # apply re.search on lower-cased names in classify().
        try:
            drop_re = re.compile("|".join(f"(?:{p})" for p in drop_patterns))
        except re.error as e:
            print(f"[rig_mappings] WARN bad drop_patterns in {base}: {e}", flush=True)
            drop_re = None

    # Build the target-side lookup table the same way as bone_table.
    target_table: Dict[str, Tuple[str, Optional[str], int]] = {}
    for b in target_bones:
        name = str(b.get("target") or "").strip().lower()
        if not name:
            continue
        role = str(b.get("role") or "")
        raw_side = b.get("side", None)
        side: Optional[str] = None
        if isinstance(raw_side, str) and raw_side.strip():
            side = raw_side.strip().lower()
        try:
            idx = int(b.get("chain_idx") or 0)
        except (TypeError, ValueError):
            idx = 0
        target_table[name] = (role, side, idx)

    target_drop_re: Optional[re.Pattern] = None
    if target_drop_patterns:
        try:
            target_drop_re = re.compile(
                "|".join(f"(?:{p})" for p in target_drop_patterns)
            )
        except re.error as e:
            print(f"[rig_mappings] WARN bad target_drop_patterns in {base}: {e}",
                  flush=True)
            target_drop_re = None

    axis = raw.get("axis_convention") or {}
    return Mapping(
        source_skeleton_id=str(raw.get("source_skeleton_id") or ""),
        target_family=str(raw.get("target_family") or ""),
        bone_table=table,
        drop_re=drop_re,
        axis_source=str(axis.get("source") or "y_up"),
        axis_target=str(axis.get("target") or "y_up"),
        root_strategy=str(raw.get("root_strategy") or "pelvis_only"),
        unit_scale=raw.get("unit_scale", "auto_bbox"),
        fingerprint_required_bones=fingerprint,
        _drop_patterns_raw=drop_patterns,
        target_table=target_table,
        target_drop_re=target_drop_re,
        _target_drop_patterns_raw=target_drop_patterns,
    )


def _load_all() -> None:
    global _LOADED
    if _LOADED:
        return
    raw = _scan_dir()
    for base in list(raw.keys()):
        try:
            m = _resolve_one(base, raw)
        except Exception as e:
            print(f"[rig_mappings] WARN: skipping {base}: {e}", flush=True)
            continue
        if m.source_skeleton_id and m.target_family:
            _CACHE[(m.source_skeleton_id, m.target_family)] = m
    _LOADED = True


def load_mapping(source_skel_id: str, target_family: str) -> Mapping:
    """Public entry. Returns the resolved Mapping for the requested
    (source, target) pair. Raises KeyError if no JSON declares it."""
    _load_all()
    key = (source_skel_id, target_family)
    if key not in _CACHE:
        raise KeyError(
            f"no rig mapping for source={source_skel_id!r} target={target_family!r} "
            f"(known: {list(_CACHE.keys())})"
        )
    return _CACHE[key]


def list_supported_pairs() -> List[Tuple[str, str]]:
    """List every (source_skeleton_id, target_family) pair we have a
    JSON file for. Used by the UI to populate the dropdown and by the
    fingerprint heuristic in `parse_fbx`."""
    _load_all()
    return sorted(_CACHE.keys())


def fingerprint_skeleton(bone_names: List[str],
                         target_family: str = "humanoid_puppeteer") -> Optional[str]:
    """Try every loaded mapping with the requested target_family and
    return the source_skeleton_id whose `fingerprint_required_bones`
    are ALL present in `bone_names`. The most-specific match wins
    (most required-bones — so ORC_M1 beats UE5 when CC4 facial bones
    are present)."""
    _load_all()
    names = {n.strip().lower() for n in bone_names if n}
    best: Optional[str] = None
    best_score = -1
    for (src, tgt), m in _CACHE.items():
        if tgt != target_family:
            continue
        req = [r.strip().lower() for r in m.fingerprint_required_bones]
        if not req:
            continue
        if all(r in names for r in req):
            score = len(req)
            if score > best_score:
                best_score = score
                best = src
    return best


def make_classifier_chain(
    mapping: Mapping,
    fallback: Callable[[str], Tuple[str, Optional[str], int]],
) -> Callable[[str], Tuple[str, Optional[str], int]]:
    """Build a callable that:
      (1) returns the drop sentinel if drop_re matches
      (2) returns the mapping table entry if name is in it
      (3) otherwise calls `fallback` (the retarget core's
          `_classify_source_bone`) so unknown bones still get the
          generic regex classification.
    This is what gets passed to `retarget_motion_to_rig(source_classifier=...)`."""
    def _classify(name: str) -> Tuple[str, Optional[str], int]:
        if not name:
            return ("", None, 0)
        lower = name.strip().lower()
        if mapping.drop_re is not None and mapping.drop_re.search(lower):
            return _DROP_SENTINEL
        if lower in mapping.bone_table:
            return mapping.bone_table[lower]
        return fallback(name)
    return _classify
