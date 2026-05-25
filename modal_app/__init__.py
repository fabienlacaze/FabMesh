"""MyFabmesh.AI Cloud — Modal application package.

POC for replacing Replicate Cog with Modal (Memory Snapshots for
near-instant cold start, per-second billing without setup-time markup).

This package is *isolated* from `scripts/` — desktop pipeline is
untouched. Modules in here are cloud-only:
    _prompts.py   — asset/style prompt suffixes (no torch deps)
    _realvis.py   — text2image generation (pure function on pipe)
    _nsfw.py      — dual-model safety classifier (CPU-only)
    app.py        — Modal app entrypoint (@app.cls with snapshots)
"""
