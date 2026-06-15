# ue5_export_sk_with_anim.py

Export the MountainDragon skeletal mesh together with 6 animations as
standalone `.fbx` files, ready for Puppeteer animation testing.

## Purpose

Pull `SK_MountainDragon` and its 6 paired AnimSequences out of the
`apovivor450` UE5 project as individual FBX files. Each FBX embeds the
preview mesh + skeleton + one animation track, so Puppeteer (or any
external rigging/anim tool) can ingest them without needing the .uproject.

## Prerequisites

- UE5 **5.1 or later** installed
- `apovivor450.uproject` open in `D:/apovivor512.15/`
- **Python Editor Script Plugin** enabled
  (Edit > Plugins > search "Python", restart editor if you just turned it on)
- **Output Log** window open, **Cmd** dropdown (bottom-left of the log) set
  to **Python**

## Run

Paste into the UE5 Output Log Python prompt:

```python
exec(open(r'C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/scripts/ue5_export_sk_with_anim.py').read())
```

That single line drives the whole export — no editor UI interaction needed.

## Expected output

6 files written to:

```
C:/tmp/MountainDragon_<action>.fbx
```

One file per action listed in `ANIMATIONS_TO_EXPORT` inside the script.
Each FBX is ~5-10 MB (mesh + skeleton + one anim track).

## Runtime

**1-3 minutes total.** The dragon mesh is small; most time is spent in
UE5's Asset Action queue, not actual FBX writing.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `cannot load <asset>` | Asset path is wrong. Open the Content Browser, right-click the AnimSequence > **Copy Reference**, and paste it into the script's path list. |
| FBX opens with skeleton/anim but **no mesh** | In the script, set `export_preview_mesh=True` on the `FbxExportOption` block. |
| Asset Action / export **times out** | Shrink `ANIMATIONS_TO_EXPORT` (export 1-2 anims at a time) and rerun. |

## Files

- Script: `C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/scripts/ue5_export_sk_with_anim.py`
- Output dir: `C:/tmp/`
- UE5 project: `D:/apovivor512.15/apovivor450.uproject`
