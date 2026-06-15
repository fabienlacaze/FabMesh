# UE5 Batch Animation Export — Apovivor

Batch-exports every `AnimSequence` found under
`/Game/1_Actors/Animals/` and `/Game/1_Actors/Units/`
to FBX, grouped by character folder, into `c:/tmp/apovivor_fbx/`.

Script: `scripts/ue5_batch_export_anims.py`

---

## 1. Open the project in UE5 (5.1+)

1. Launch **Epic Games Launcher** → Unreal Engine → Library.
2. Use an Engine version **>= 5.1** (5.3 / 5.4 tested).
3. Double-click `D:\apovivor512.15\apovivor512.15.uproject`
   (or wherever the project lives — adjust the path if needed).
4. Wait for shader compilation and asset registry scan to finish
   (lower-right progress bar must be empty).

> If the project asks to convert a copy, choose **More Options → Open Copy**
> only if you want a one-off, otherwise **Convert In-Place**.

---

## 2. Enable the Python Editor Script Plugin

1. **Edit → Plugins**.
2. Search box: `Python`.
3. Tick **Python Editor Script Plugin** (Epic Games).
4. Click **Restart Now** when prompted. The editor will relaunch.

To verify it loaded:
- **Window → Output Log**.
- Bottom-left of the Output Log, there's a small dropdown next to the
  command input. Set it to **Python**. If "Python" is missing, the
  plugin is not enabled (re-check step 2).

---

## 3. Run the batch export

1. **Window → Output Log**.
2. Set the Cmd dropdown to **Python**.
3. Paste and execute:

```python
exec(open(r'C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/scripts/ue5_batch_export_anims.py').read())
```

The script prints progress every 10 exports, e.g.:

```
[batch-export] /Game/1_Actors/Animals: 842 assets
[batch-export] /Game/1_Actors/Units: 1117 assets
[batch-export] 1574 animation candidates to export
[batch-export] 10/1574 (0.6%) Wolf/ANIM_Wolf_Idle  rate=0.42/s  eta=62.1 min
[batch-export] 20/1574 (1.3%) Wolf/ANIM_Wolf_Walk  rate=0.55/s  eta=47.0 min
...
```

When done, you'll get a summary like:

```
[batch-export] DONE
  total candidates : 1574
  exported         : 1561
  skipped (exists) : 0
  skipped (no skel): 4
  errors           : 9
  characters       : 86
  elapsed          : 42.3 min
  output root      : c:/tmp/apovivor_fbx
```

---

## 4. Expected output structure

```
c:/tmp/apovivor_fbx/
  Wolf/
    ANIM_Wolf_Idle.fbx            <- first anim has the skeletal mesh embedded
    ANIM_Wolf_Walk.fbx            <- anim-only (smaller)
    ANIM_Wolf_Attack.fbx
    ...
  Knight/
    ANIM_Knight_Idle.fbx
    ...
  Dragon/
    ...
```

Mesh embedding rule: only the **first** export for a given Skeleton
embeds the Skeletal Mesh (`export_mesh=True`). Every subsequent
animation that shares the same Skeleton is exported anim-only
(`export_mesh=False`). This typically saves 60-90% disk space on a
character with dozens of animations.

---

## 5. Runtime expectations

| Asset count   | Expected wall-clock |
|---------------|---------------------|
|   100 anims   |   ~3-5 min          |
|   500 anims   |  ~10-20 min         |
|  1500 anims   |  ~30-60 min         |
|  3000+ anims  |    ~1-2 h           |

Speed depends on:
- whether the Skeletal Mesh is embedded (slower for the first anim of
  each character),
- average animation length,
- disk speed (SSD vs HDD on `c:/tmp/`),
- whether shader compilation is still running in the background.

---

## 6. Restart-safe

The script **skips any FBX that already exists** at the target path.
If the export crashes the editor or you kill it midway, just rerun
the same `exec(...)` line — it picks up where it left off.

To force a full re-export, delete `c:/tmp/apovivor_fbx/` first.

---

## 7. Troubleshooting

- **"Python" missing in the Output Log dropdown** → plugin not
  enabled, redo step 2.
- **`no skeleton on ...`** → the AnimSequence has a broken Skeleton
  reference. Fix in the editor or accept the skip.
- **`export failed`** → check the Output Log just above the warning,
  UE prints the underlying FBX exporter error there.
- **Editor freezes** → exports run on the Game Thread, so the editor
  UI is unresponsive during the run. This is normal. Don't kill it
  unless it has been silent for >10 minutes.
- **Out of memory** on huge projects → lower `PROGRESS_EVERY` is not
  the cause; restart the editor between batches and rely on the
  skip-existing logic.
