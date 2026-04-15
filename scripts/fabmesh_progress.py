"""
FabMesh overall-progress helper — SINGLE SOURCE OF TRUTH for the 3D pipeline
progress bar.

Problem this solves:
    Before this helper, the bridge hardcoded progress jumps (5, 10, 12, 25,
    50, 90, 97, 100). Real wall-clock time didn't match: the bar hit 97%
    after ~45% of actual work (SF3D was done, but multi-view, UV projection
    and SDXL refine still had 100+ seconds left — bar frozen).

How it works:
    PHASE_BUDGET lists phases in pipeline order with their *expected
    wall-clock weight*. Each phase gets a contiguous overall-percent slice.
    `start(phase)` returns the overall percent at the START of that phase;
    `sub(phase, pct)` maps a sub-phase 0-100 into the middle of the slice.

    Editing one number here auto-rebalances every emitter.
"""
from __future__ import annotations
from typing import Tuple


# Wall-clock weights (arbitrary units, they're normalized to 100%).
# Numbers based on observed RTX 5080 timings (refine mode, default config):
#   import       ~1 s     1
#   preprocess   ~2 s     2
#   multiview    ~45 s    25   (Zero123++ + RealESRGAN + rembg + style)
#   sf3d_load    ~10 s    8    (SF3D weights load)
#   sf3d_infer   ~5 s     5    (single-view inference)
#   tex_project  ~25 s    15   (multi-view UV rasterization loop)
#   refine       ~120 s   40   (SDXL img2img, 9 tiles of 1024²)
#   finalize     ~3 s     4    (decimate, GLB rewrite, cleanup)
PHASE_BUDGET = [
    ('import',       1),
    ('preprocess',   2),
    ('multiview',   25),
    ('sf3d_load',    8),
    ('sf3d_infer',   5),
    ('finalize',     4),   # decimate / subdivide between infer and projection
    ('tex_project', 15),
    ('refine',      40),
]


def _cumulative() -> list[Tuple[str, float, float]]:
    """Return [(name, start_pct, end_pct)] normalized to 0..100."""
    total = float(sum(w for _, w in PHASE_BUDGET))
    out = []
    acc = 0.0
    for name, w in PHASE_BUDGET:
        start = acc / total * 100.0
        acc += w
        end = acc / total * 100.0
        out.append((name, start, end))
    return out


_RANGES = {name: (s, e) for name, s, e in _cumulative()}


def start(phase: str) -> int:
    """Overall percent at the BEGINNING of `phase`. Clamped [1, 99]."""
    if phase not in _RANGES:
        return 0
    s, _ = _RANGES[phase]
    return max(1, min(99, int(round(s))))


def end(phase: str) -> int:
    """Overall percent at the END of `phase`. Clamped [1, 99]."""
    if phase not in _RANGES:
        return 0
    _, e = _RANGES[phase]
    return max(1, min(99, int(round(e))))


def sub(phase: str, pct: float) -> int:
    """Map a sub-phase progress (0..100) into the overall-percent slice."""
    if phase not in _RANGES:
        return 0
    s, e = _RANGES[phase]
    pct = max(0.0, min(100.0, float(pct)))
    overall = s + (e - s) * (pct / 100.0)
    return max(1, min(99, int(round(overall))))
