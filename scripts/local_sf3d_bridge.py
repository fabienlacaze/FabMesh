"""
FabMesh Local Stable Fast 3D Bridge (Image -> 3D mesh with PBR textures)
=======================================================================

- Model: stabilityai/stable-fast-3d (Stability AI Community License,
  commercial-safe under $1M annual revenue, no geographic restrictions)
- Background removal: rembg u2net (Apache 2.0, commercial-safe)
- Native PBR material output: albedo + metallic/roughness + normal map
- Local texture_baker + uv_unwrapper C++ extensions (built with MSVC,
  CPU-only to avoid nvcc/torch CUDA version mismatch)

Usage:
    python local_sf3d_bridge.py <image_path> <output_glb_path>
        [texture_res] [target_vertex_count] [remesh_option]

Defaults: texture_res=1024, target_vertex_count=-1 (no reduction), remesh=none

Exit code 0 on success, non-zero on error.
"""
import sys
import os
import time
import traceback
from contextlib import nullcontext

# Shared progress helper — single source of truth for the overall-percent
# phase budget. Edit scripts/fabmesh_progress.py:PHASE_BUDGET to rebalance.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fabmesh_progress as _fprog


def _emit_progress(phase_name: str, pct: int | None = None, label: str | None = None):
    """Emit a `LOCAL_SF3D_PROGRESS: <overall%> <label>` line. When pct is None,
    use the phase's start percentage. Renderer picks this up via its
    `_PROGRESS:\\s*(\\d+)` regex and never decreases the bar."""
    if pct is None:
        pct = _fprog.start(phase_name)
    lbl = label or phase_name
    print(f"LOCAL_SF3D_PROGRESS: {pct} {lbl}", flush=True)


def _stream_subprocess(cmd, timeout=600, env=None, sub_phase: str | None = None):
    """Replacement for `subprocess.run(capture_output=True)` that streams
    stdout line-by-line. Any line matching `FABMESH_SUBPCT: <0-100> ...` is
    remapped into the given `sub_phase`'s overall-percent slice and re-emitted
    as a `LOCAL_SF3D_PROGRESS:` line so the UI progress bar moves steadily
    during long sub-scripts (multi-view generation, SDXL refine, projection).

    Returns an object with .returncode, .stdout (captured), .stderr (captured)
    to keep the call sites close to what subprocess.run returned before.
    """
    import subprocess as _sp
    import re as _re
    _sub_re = _re.compile(r'FABMESH_SUBPCT:\s*(\d{1,3})')
    # Sub-scripts emit `<COMPONENT>_PROGRESS: <pct>` via slog.progress()
    # (multiview_gen.py -> `MULTIVIEW_PROGRESS:`, texture_* -> `TEXTURE_*_PROGRESS:`).
    # Those values are SUB-phase percentages, not overall percentages. If we
    # forward them verbatim the renderer's legacy scraper would snap the bar
    # to ~90% as soon as multiview hits pct=90 — hiding the whole refine
    # phase. Neutralize by rewriting the literal token so no downstream
    # consumer matches `_PROGRESS:` in a forwarded sub-script line.
    # (LOCAL_*_PROGRESS: lines are only emitted by bridges, never forwarded.)
    def _neutralize(s: str) -> str:
        return s.replace('_PROGRESS:', '_SUBPROG:')

    class _Result:
        def __init__(self):
            self.returncode = -1
            self.stdout = ''
            self.stderr = ''

    res = _Result()
    # Force Python sub-processes to flush stdout line-by-line so every
    # `print(..., flush=True)` in multiview_gen/texture_project/texture_refine
    # actually reaches us immediately — otherwise Windows text-mode pipes
    # batch up until the child exits, which defeats the whole point of
    # streaming and freezes the UI progress bar until the sub-script ends.
    _popen_env = dict(env) if env else dict(os.environ)
    _popen_env.setdefault('PYTHONUNBUFFERED', '1')
    proc = _sp.Popen(cmd, stdout=_sp.PIPE, stderr=_sp.PIPE,
                     text=True, env=_popen_env, bufsize=1)

    # Heartbeat thread: even when the sub-script is silent for a long time
    # (Zero123++ spends ~45s in a single pipeline() call with no intermediate
    # prints, likewise SDXL per-tile), the UI bar would otherwise freeze at
    # the last known sub-pct. Every 2s we interpolate toward the end of the
    # current sub-phase slice based on elapsed/expected time.
    import threading as _th
    _hb_stop = _th.Event()
    _hb_state = {'last_sub_pct': 0, 'last_sub_time': time.time()}

    def _heartbeat():
        if not sub_phase:
            return
        # Bump 1 sub-pct every 2s of silence, cap at 95% of the slice, and
        # STOP emitting once we hit the cap (otherwise we spam the same
        # value forever which drowns the diagnostic log without helping
        # the bar). Real events reset _hb_state when they arrive, so the
        # cap naturally resets on every real signal.
        _last_emitted = -1
        while not _hb_stop.wait(2.0):
            elapsed = time.time() - _hb_state['last_sub_time']
            last = _hb_state['last_sub_pct']
            bump = min(95, last + int(elapsed / 2.0))
            if bump > last and bump > _last_emitted:
                try:
                    overall = _fprog.sub(sub_phase, bump)
                    _emit_progress(sub_phase, overall,
                                   label=f"{sub_phase}:{bump}~hb")
                    _last_emitted = bump
                except Exception:
                    pass

    _hb_thread = _th.Thread(target=_heartbeat, daemon=True)
    if sub_phase:
        _hb_thread.start()

    # CRITICAL — drain stderr continuously in a background thread. Without
    # this, Python sub-scripts (Zero123++, SF3D, SDXL) write warnings/tqdm
    # progress/logging to stderr at ~1KB/s; when the Windows stderr pipe
    # buffer fills (~64KB), the child blocks on its next write → visible
    # symptom: VRAM allocated but GPU util at 0% for minutes on end, no
    # progress events. Reading stderr out-of-band keeps the child flowing.
    _err_buf = []

    def _drain_stderr():
        assert proc.stderr is not None
        for eline in iter(proc.stderr.readline, ''):
            if not eline:
                break
            _err_buf.append(eline)

    _err_thread = _th.Thread(target=_drain_stderr, daemon=True)
    _err_thread.start()
    collected_out = []
    t_start = time.time()
    try:
        assert proc.stdout is not None
        for line in iter(proc.stdout.readline, ''):
            if not line:
                break
            collected_out.append(line)
            line_stripped = line.rstrip('\n')
            # Forward so main.js still sees every sub-script log, but
            # neutralize any `*_PROGRESS:` token so the renderer's scraper
            # doesn't mistake a sub-phase percentage for the overall %.
            print(f"LOCAL_SF3D: {_neutralize(line_stripped)}", flush=True)
            # Remap sub-phase 0-100 into our overall slice.
            if sub_phase:
                m = _sub_re.search(line_stripped)
                if m:
                    try:
                        sub_pct = int(m.group(1))
                        overall = _fprog.sub(sub_phase, sub_pct)
                        _emit_progress(sub_phase, overall,
                                       label=f"{sub_phase}:{sub_pct}")
                        # Reset heartbeat anchor: from now on the heartbeat
                        # extrapolates from THIS sub-pct, not the phase start.
                        _hb_state['last_sub_pct'] = sub_pct
                        _hb_state['last_sub_time'] = time.time()
                    except Exception:
                        pass
            if timeout and (time.time() - t_start) > timeout:
                proc.kill()
                res.returncode = -9
                res.stderr = f'timeout after {timeout}s'
                _hb_stop.set()
                return res
        proc.wait(timeout=max(1.0, timeout - (time.time() - t_start))
                  if timeout else None)
        res.returncode = proc.returncode
        res.stdout = ''.join(collected_out)
        # stderr was drained live by _drain_stderr — join the thread then
        # collect what it captured. Don't proc.stderr.read() here: the thread
        # already consumed the pipe.
        try:
            _err_thread.join(timeout=2.0)
        except Exception:
            pass
        res.stderr = ''.join(_err_buf)
    except _sp.TimeoutExpired:
        proc.kill()
        res.returncode = -9
        res.stderr = 'timeout'
    except Exception as e:
        res.returncode = -1
        res.stderr = str(e)
    finally:
        _hb_stop.set()
    return res


def generate_3d(
    image_path,
    output_path,
    texture_resolution=1024,
    target_vertex_count=-1,
    remesh_option='none',
    foreground_ratio=0.85,
    subdivide_levels=0,
):
    """Run Stable Fast 3D on `image_path`, save textured GLB to `output_path`.

    If subdivide_levels > 0, the mesh is post-processed through Blender
    Catmull-Clark subdivision to increase triangle count while preserving
    PBR textures and UVs. Each level ×4 the triangle count.
    """
    print(f"LOCAL_SF3D: image={image_path}", flush=True)
    print(f"LOCAL_SF3D: output={output_path}", flush=True)
    print(f"LOCAL_SF3D: texture_res={texture_resolution} verts={target_vertex_count} remesh={remesh_option} subdivide={subdivide_levels}", flush=True)
    _emit_progress('import', label='import_start')

    # Path to the cloned SF3D repo (bundled in external/)
    SF3D_DIR = os.path.abspath(os.path.join(
        os.path.dirname(__file__), '..', 'external', 'StableFast3D'
    ))
    if not os.path.isdir(SF3D_DIR):
        print(f"LOCAL_SF3D_ERROR: StableFast3D repo not found at {SF3D_DIR}", flush=True)
        return False
    sys.path.insert(0, SF3D_DIR)

    import torch
    import rembg
    from PIL import Image

    from sf3d.system import SF3D
    from sf3d.utils import get_device, remove_background, resize_foreground

    _emit_progress('preprocess', label='preprocess_start')

    # Enforce VRAM cap passed by FabMesh main.js (optional)
    if torch.cuda.is_available():
        frac = float(os.environ.get('FABMESH_VRAM_FRACTION', '0.95'))
        if 0.1 <= frac < 1.0:
            try:
                torch.cuda.set_per_process_memory_fraction(frac)
                print(f"LOCAL_SF3D: VRAM hard cap set to {frac*100:.0f}%", flush=True)
            except Exception as e:
                print(f"LOCAL_SF3D: could not set VRAM cap ({e})", flush=True)

    device = get_device()
    if not (torch.cuda.is_available() or torch.backends.mps.is_available()):
        device = "cpu"
    print(f"LOCAL_SF3D: device={device}", flush=True)

    # ------------------------------------------------------------------
    # Preprocess image: rembg (u2net default) + resize to foreground ratio
    # ------------------------------------------------------------------
    rembg_session = rembg.new_session()
    raw = Image.open(image_path).convert('RGBA')
    image = remove_background(raw, rembg_session)
    image = resize_foreground(image, foreground_ratio)
    print(f"LOCAL_SF3D: image preprocessed {image.size}", flush=True)

    # Save the SAME image that SF3D sees (after resize_foreground) for texture
    # projection. The projection must match SF3D's perspective camera exactly,
    # and that camera sees the resize_foreground output, not the raw rembg image.
    _preprocessed_path = output_path + '.preprocessed.png'
    image.save(_preprocessed_path)

    # ------------------------------------------------------------------
    # Look for pre-generated multi-views (Zero123++) in the project's image
    # dir. Convention (since 2026-04-15): the UI's "Generate image" has a
    # multi-view checkbox that, when enabled, runs multiview_gen at image
    # creation time and writes the 6 views to `images/<project>/multiview/`.
    #
    # The bridge NEVER generates multi-views itself anymore — it just uses
    # what the user chose to have. If the folder doesn't exist or is
    # incomplete, we fall through to SF3D-only (no projection phase).
    # ------------------------------------------------------------------
    _multiview_dir = None
    _proj_mode_pre = os.environ.get('FABMESH_PROJECT_MODE', 'refine').lower()
    try:
        _src_img_dir = os.path.dirname(os.path.abspath(image_path))
        _img_stem = os.path.splitext(os.path.basename(image_path))[0]
        _mv_candidate = os.path.join(_src_img_dir, f'{_img_stem}_multiview')
        _mv_valid = (
            os.path.isdir(_mv_candidate)
            and all(os.path.exists(os.path.join(_mv_candidate, f'view_{i}.png'))
                    for i in range(6))
        )
        if _mv_valid:
            # Copy the 6 views + input.png next to the mesh output so the
            # rest of the pipeline finds them at the expected location.
            import shutil as _sh
            _multiview_dir = output_path + '.multiview'
            os.makedirs(_multiview_dir, exist_ok=True)
            for _fn in ('input.png',) + tuple(f'view_{i}.png' for i in range(6)):
                _src_mv = os.path.join(_mv_candidate, _fn)
                if os.path.exists(_src_mv):
                    _sh.copy2(_src_mv, os.path.join(_multiview_dir, _fn))
            print(f"LOCAL_SF3D: using pre-generated multi-views from {_mv_candidate}",
                  flush=True)
        else:
            print(f"LOCAL_SF3D: no pre-generated multi-views in {_mv_candidate} "
                  f"— SF3D-only pipeline (no Zero123++ auto-gen)",
                  flush=True)
            _multiview_dir = None
    except Exception as _mv_e:
        print(f"LOCAL_SF3D: multi-view lookup failed ({_mv_e}) — SF3D-only",
              flush=True)
        _multiview_dir = None

    # ------------------------------------------------------------------
    # Download + load SF3D weights (~3 GB, one-time, gated on HF)
    # ------------------------------------------------------------------
    _emit_progress('sf3d_load', label='load_pipeline')
    t0 = time.time()
    model = SF3D.from_pretrained(
        "stabilityai/stable-fast-3d",
        config_name="config.yaml",
        weight_name="model.safetensors",
    )
    model.to(device)
    model.eval()
    print(f"LOCAL_SF3D: model loaded in {time.time()-t0:.1f}s", flush=True)

    # ------------------------------------------------------------------
    # Clamp parameters to avoid OOM on 16 GB cards.
    # SF3D VRAM scales with (vertex_count × bake_resolution²). Empirically:
    #   1024 tex + 50K verts  -> ~6.2 GB peak (safe on 16 GB)
    #   2048 tex + 30K verts  -> ~10 GB peak
    #   4096 tex + 10K verts  -> ~13 GB peak (tight on 16 GB)
    #   4096 tex + 250K verts -> OOM guaranteed on 16 GB
    # We auto-downscale to keep things runnable rather than crashing.
    # ------------------------------------------------------------------
    tex_res = int(texture_resolution)
    vert_count = int(target_vertex_count)
    if torch.cuda.is_available():
        total_gb = torch.cuda.get_device_properties(0).total_memory / 1024**3
    else:
        total_gb = 8  # conservative default

    # VRAM-safe clamps. The texture baker's dilate_fill operation allocates
    # tensors proportional to tex_res², which is the main OOM culprit.
    # 4096 tex alone uses ~13 GB peak -> only safe on 20+ GB cards.
    if total_gb < 12:
        tex_res = min(tex_res, 1024)
        if vert_count > 0:
            vert_count = min(vert_count, 30000)
    elif total_gb < 20:
        # 12-16 GB: 4096 is ALWAYS OOM (dilate_fill alone needs ~13 GB)
        tex_res = min(tex_res, 2048)
        if vert_count > 0 and tex_res >= 2048:
            vert_count = min(vert_count, 50000)
    # 20+ GB (RTX 3090/4090/A6000): 4096 is fine

    # If the user requested 4096 but we clamped to 2048, remember to upscale
    # the texture in post-processing (CPU/PIL, no VRAM needed).
    upscale_tex_to = int(texture_resolution) if tex_res < int(texture_resolution) else 0

    if tex_res != int(texture_resolution) or vert_count != int(target_vertex_count):
        msg = f"LOCAL_SF3D: params clamped for VRAM safety ({total_gb:.0f}GB card): tex {texture_resolution}->{tex_res}, verts {target_vertex_count}->{vert_count}"
        if upscale_tex_to:
            msg += f" (will upscale texture to {upscale_tex_to} post-gen)"
        print(msg, flush=True)

    # ------------------------------------------------------------------
    # Run inference
    # ------------------------------------------------------------------
    _emit_progress('sf3d_infer', label='inference_start')
    t0 = time.time()
    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()
    with torch.no_grad():
        ctx = (
            torch.autocast(device_type=device, dtype=torch.bfloat16)
            if "cuda" in device
            else nullcontext()
        )
        with ctx:
            mesh, glob_dict = model.run_image(
                image,
                bake_resolution=tex_res,
                remesh=remesh_option,
                vertex_count=vert_count,
            )
    elapsed = time.time() - t0
    print(f"LOCAL_SF3D: inference done in {elapsed:.1f}s", flush=True)
    if torch.cuda.is_available():
        peak = torch.cuda.max_memory_allocated() / 1024 / 1024
        print(f"LOCAL_SF3D: peak VRAM {peak:.0f} MB", flush=True)

    # run_image can return a list when batched; we passed a single PIL image
    if isinstance(mesh, list):
        if not mesh:
            print("LOCAL_SF3D_ERROR: empty mesh list from pipeline", flush=True)
            return False
        mesh = mesh[0]

    # End of SF3D inference — enter the finalize phase (decimate / subdivide).
    _emit_progress('finalize', label='export')
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    # Track the auto-align rotation so downstream projection can compensate
    # multi-view azimuths (Zero123++ views were generated from the PRE-align
    # mesh, so they land on wrong parts of the rotated mesh otherwise).
    auto_align_rot_deg = 0.0

    # ------------------------------------------------------------------
    # Auto-align the mesh so the subject faces -Z (glTF forward convention).
    # SF3D's mesh can end up pointing at any horizontal direction depending
    # on the input image's implicit 3D pose. The FabMesh Three.js viewer
    # spawns its camera at (+X,+Y,+Z) looking at origin, so a misaligned
    # mesh shows up as "from the side" in thumbnails.
    #
    # Detection: humanoid / animal subjects have a bilateral left/right
    # mirror plane. Find the Y rotation that maximizes symmetry of the
    # mesh around the XY plane (i.e. mirroring x → -x leaves the cloud
    # nearest to itself). Combined with a sign constraint from the torso
    # bulge (tells us which mirror-equivalent direction is FRONT vs BACK),
    # this lands within <1° of the true subject axis — versus the ~3-5°
    # noise from the previous chest-bulge heuristic alone.
    # ------------------------------------------------------------------
    try:
        import numpy as _np
        _v = mesh.vertices.astype(_np.float32)
        _cen = _v.mean(axis=0)
        _centered = _v - _cen
        # Downsample for speed (symmetry scan is O(N·K) for K angles)
        if _centered.shape[0] > 4000:
            _idx = _np.random.default_rng(0).choice(_centered.shape[0], 4000, replace=False)
            _sample = _centered[_idx]
        else:
            _sample = _centered

        # Build a compact grid over XZ (Y-independent) for fast nearest-neighbor lookup
        # after rotation + mirror. We discretize positions into a 64x64 grid in XZ
        # and 16 bins in Y, then count occupancy. Symmetry score = sum over cells of
        # min(count_original, count_mirrored). Maximizing this is equivalent to
        # maximizing mesh↔mirror overlap.
        _xz_range = max(abs(_sample[:, 0]).max(), abs(_sample[:, 2]).max()) * 1.05 + 1e-6
        _y_range = (_sample[:, 1].max() - _sample[:, 1].min()) * 1.05 + 1e-6
        _y_min = _sample[:, 1].min()
        _Gx = 64  # XZ grid
        _Gy = 16  # Y bins
        def _bin(points):
            ix = _np.clip(((points[:, 0] + _xz_range) / (2*_xz_range) * _Gx).astype(_np.int32), 0, _Gx - 1)
            iy = _np.clip(((points[:, 1] - _y_min) / _y_range * _Gy).astype(_np.int32), 0, _Gy - 1)
            iz = _np.clip(((points[:, 2] + _xz_range) / (2*_xz_range) * _Gx).astype(_np.int32), 0, _Gx - 1)
            # Pack into single index for bincount
            return (ix * _Gy + iy) * _Gx + iz
        _total_bins = _Gx * _Gy * _Gx

        def _sym_score(theta_rad):
            c = _np.cos(theta_rad); s = _np.sin(theta_rad)
            # Rotate around Y
            rx = c * _sample[:, 0] + s * _sample[:, 2]
            rz = -s * _sample[:, 0] + c * _sample[:, 2]
            rotated = _np.stack([rx, _sample[:, 1], rz], axis=1)
            mirrored = rotated.copy()
            mirrored[:, 0] *= -1  # mirror across YZ plane (i.e. x → -x)
            h_orig = _np.bincount(_bin(rotated), minlength=_total_bins)
            h_mir = _np.bincount(_bin(mirrored), minlength=_total_bins)
            return int(_np.minimum(h_orig, h_mir).sum())

        # Coarse 2°-step scan over 0..179° (symmetry has 180° periodicity)
        _coarse_angles = _np.arange(0, 180, 2) * _np.pi / 180.0
        _coarse_scores = [_sym_score(a) for a in _coarse_angles]
        _best_coarse = int(_np.argmax(_coarse_scores))
        # Fine 0.25°-step scan around the coarse best ±3°
        _fine_angles = _np.arange(-3, 3.01, 0.25) * _np.pi / 180.0 + _coarse_angles[_best_coarse]
        _fine_scores = [_sym_score(a) for a in _fine_angles]
        _best_fine = int(_np.argmax(_fine_scores))
        _sym_theta = float(_fine_angles[_best_fine])

        # The symmetry axis is ambiguous front/back (mirror plane is the same).
        # Use the torso-bulge heuristic to resolve that ambiguity: after rotating
        # the mesh by -_sym_theta, check which direction (-Z or +Z) the chest
        # bulges toward.
        c = _np.cos(-_sym_theta); s = _np.sin(-_sym_theta)
        _rotated = _sample.copy()
        _rotated[:, 0] = c * _sample[:, 0] + s * _sample[:, 2]
        _rotated[:, 2] = -s * _sample[:, 0] + c * _sample[:, 2]
        # Select mid-body vertices (30-80% of height)
        _y_top = _np.percentile(_rotated[:, 1], 95)
        _y_bot = _np.percentile(_rotated[:, 1], 5)
        _y_r = _y_top - _y_bot
        _mask = (_rotated[:, 1] > _y_bot + 0.30 * _y_r) & (_rotated[:, 1] < _y_bot + 0.80 * _y_r)
        _chest_z_mean = _rotated[_mask, 2].mean() if _mask.sum() > 0 else 0.0

        # Chest-z alone is unreliable when |chest_z_mean| is small
        # (observed on 'garcon' mesh: +0.005, triggered a spurious +180°
        # flip that put the face behind the head). Add a second vote
        # using the HEAD region — human heads have much more mass in
        # front of the symmetry axis than behind (nose, chin, forehead
        # vs flat nape). The face-forward z should be NEGATIVE.
        _head_mask = _rotated[:, 1] > _y_bot + 0.85 * _y_r
        _head_z_mean = (_rotated[_head_mask, 2].mean()
                        if _head_mask.sum() > 10 else 0.0)

        # Vote: 2 signals, both should say the same thing. If they
        # disagree, trust the one with the larger absolute magnitude.
        _chest_vote = -1 if _chest_z_mean < 0 else (1 if _chest_z_mean > 0 else 0)
        _head_vote  = -1 if _head_z_mean  < 0 else (1 if _head_z_mean  > 0 else 0)
        # Combined: weight each by |value|.
        # Empirical rule (verified by user on 'garcon' mesh 2026-04-16):
        # on SF3D output rotated by -_sym_theta, the subject FACES +Z when
        # chest_z+head_z is NEGATIVE (nose/chin/chest bulge sample lands
        # behind the centroid in z). To face -Z (glTF forward) we need to
        # flip WHEN the sum is negative.
        _vote_sum = (_chest_z_mean + _head_z_mean)
        _needs_flip = _vote_sum < 0
        if _needs_flip:
            _sym_theta += _np.pi
        print(f"LOCAL_SF3D: facing-check chest_z={_chest_z_mean:+.3f} "
              f"head_z={_head_z_mean:+.3f} sum={_vote_sum:+.3f} "
              f"flip={_needs_flip}", flush=True)

        # Final rotation to apply: -_sym_theta (so that the subject's symmetry
        # axis aligns with the world -Z axis).
        _rot_angle = ((-_sym_theta + _np.pi) % (2 * _np.pi)) - _np.pi  # wrap to [-π, π]

        if abs(_rot_angle) > _np.radians(0.5):
            import trimesh as _tm
            _R = _tm.transformations.rotation_matrix(_rot_angle, [0, 1, 0])
            mesh.apply_transform(_R)
            auto_align_rot_deg = float(_np.degrees(_rot_angle))
            print(
                f"LOCAL_SF3D: auto-aligned mesh by {auto_align_rot_deg:.2f}° "
                f"around Y (bilateral symmetry search; chest_z={_chest_z_mean:+.3f})",
                flush=True,
            )
        else:
            print(
                f"LOCAL_SF3D: mesh already aligned "
                f"(symmetry drift {_np.degrees(_rot_angle):.2f}° < 0.5°)",
                flush=True,
            )
    except Exception as _align_e:
        print(f"LOCAL_SF3D: auto-align skipped ({_align_e})", flush=True)
        import traceback as _tb
        _tb.print_exc()

    mesh.export(output_path, include_normals=True)

    # ------------------------------------------------------------------
    # Fix PBR material: SF3D sets low roughness/high metallic which makes
    # the mesh look glossy. Override to matte for realistic appearance.
    # ------------------------------------------------------------------
    try:
        import struct as _st, json as _js
        with open(output_path, 'rb') as _f:
            _glb = bytearray(_f.read())
        _off = 12
        while _off < len(_glb):
            _cl, _ct = _st.unpack_from('<II', _glb, _off)
            if _ct == 0x4E4F534A:  # JSON chunk
                _json = _js.loads(_glb[_off+8 : _off+8+_cl].decode('utf-8'))
                for _mat in _json.get('materials', []):
                    pbr = _mat.get('pbrMetallicRoughness', {})
                    pbr['roughnessFactor'] = 0.85
                    pbr['metallicFactor'] = 0.0
                    _mat['pbrMetallicRoughness'] = pbr
                _new_json = _js.dumps(_json).encode('utf-8')
                _pad = (4 - (len(_new_json) % 4)) % 4
                _new_json_padded = _new_json + b' ' * _pad
                # Rebuild GLB with new JSON
                _bin_off = _off + 8 + _cl
                _bin_data = bytes(_glb[_bin_off:])
                _glb = bytearray()
                _glb += _st.pack('<III', 0x46546C67, 2, 0)
                _glb += _st.pack('<II', len(_new_json_padded), 0x4E4F534A)
                _glb += _new_json_padded
                _glb += _bin_data
                _st.pack_into('<I', _glb, 8, len(_glb))
                with open(output_path, 'wb') as _f:
                    _f.write(_glb)
                print(f"LOCAL_SF3D: PBR fixed (roughness=0.85, metallic=0.0)", flush=True)
                break
            _off += 8 + _cl
    except Exception as _pe:
        print(f"LOCAL_SF3D: PBR fix skipped ({_pe})", flush=True)

    # ------------------------------------------------------------------
    # Post-process textures IN-PLACE in the GLB binary.
    # IMPORTANT: Do NOT use trimesh load+export here — it corrupts
    # per-corner (wedge) UVs by merging duplicate vertices at seams.
    # Instead, we parse the GLB binary, extract embedded PNG textures,
    # modify them with PIL, and write them back at the same offsets.
    # ------------------------------------------------------------------
    try:
        import struct, json, io
        from PIL import ImageEnhance, Image as _PILImg

        def _modify_glb_textures(glb_path, enhance=True, upscale_to=0):
            """Modify textures embedded in a GLB file without touching mesh data."""
            with open(glb_path, 'rb') as f:
                data = bytearray(f.read())

            # Parse GLB header
            magic, version, total_len = struct.unpack_from('<III', data, 0)
            if magic != 0x46546C67:  # 'glTF'
                print("LOCAL_SF3D: not a valid GLB, skipping texture post-process", flush=True)
                return

            # Parse chunks
            offset = 12
            json_chunk = None
            bin_chunk_offset = None
            while offset < len(data):
                chunk_len, chunk_type = struct.unpack_from('<II', data, offset)
                if chunk_type == 0x4E4F534A:  # JSON
                    json_chunk = json.loads(data[offset+8 : offset+8+chunk_len].decode('utf-8'))
                elif chunk_type == 0x004E4942:  # BIN
                    bin_chunk_offset = offset + 8
                offset += 8 + chunk_len

            if json_chunk is None or bin_chunk_offset is None:
                return

            # Find all images in the glTF JSON
            images = json_chunk.get('images', [])
            buffer_views = json_chunk.get('bufferViews', [])
            modified = False

            for img_info in images:
                bv_idx = img_info.get('bufferView')
                if bv_idx is None:
                    continue
                bv = buffer_views[bv_idx]
                img_offset = bin_chunk_offset + bv.get('byteOffset', 0)
                img_length = bv['byteLength']

                # Extract image bytes
                img_bytes = bytes(data[img_offset : img_offset + img_length])
                try:
                    pil_img = _PILImg.open(io.BytesIO(img_bytes))
                except:
                    continue

                orig_size = pil_img.size
                changed = False

                # Enhance
                if enhance:
                    pil_img = ImageEnhance.Contrast(pil_img).enhance(1.5)
                    pil_img = ImageEnhance.Color(pil_img).enhance(1.6)
                    pil_img = ImageEnhance.Sharpness(pil_img).enhance(1.3)
                    changed = True

                # Upscale
                if upscale_to > 0 and max(pil_img.size) < upscale_to:
                    pil_img = pil_img.resize((upscale_to, upscale_to), _PILImg.LANCZOS)
                    changed = True

                if not changed:
                    continue

                # Encode back to PNG
                buf = io.BytesIO()
                pil_img.save(buf, format='PNG')
                new_bytes = buf.getvalue()

                if len(new_bytes) <= img_length:
                    # Fits in the same slot: overwrite + zero-pad
                    data[img_offset : img_offset + len(new_bytes)] = new_bytes
                    data[img_offset + len(new_bytes) : img_offset + img_length] = b'\x00' * (img_length - len(new_bytes))
                else:
                    # New image is larger: append to binary chunk and update buffer view
                    # Pad binary chunk to 4-byte alignment
                    old_bin_len = struct.unpack_from('<I', data, bin_chunk_offset - 8)[0]
                    new_offset = old_bin_len
                    pad = (4 - (len(new_bytes) % 4)) % 4
                    data[bin_chunk_offset + old_bin_len : bin_chunk_offset + old_bin_len] = new_bytes + b'\x00' * pad
                    new_bin_len = old_bin_len + len(new_bytes) + pad

                    # Update buffer view to point to new location
                    bv['byteOffset'] = new_offset
                    bv['byteLength'] = len(new_bytes)

                    # Update binary chunk length
                    struct.pack_into('<I', data, bin_chunk_offset - 8, new_bin_len)

                    # Update total GLB length
                    # (re-encode JSON since we changed buffer views)
                    # This is complex, so for now only support in-place replacement
                    print(f"LOCAL_SF3D: texture larger after enhance ({len(new_bytes)} > {img_length}), re-encoding GLB", flush=True)
                    # Fall back to simple approach: just re-encode everything
                    json_str = json.dumps(json_chunk).encode('utf-8')
                    json_pad = (4 - (len(json_str) % 4)) % 4
                    json_chunk_data = json_str + b' ' * json_pad
                    bin_data = bytes(data[bin_chunk_offset : bin_chunk_offset + new_bin_len])

                    new_data = bytearray()
                    new_data += struct.pack('<III', 0x46546C67, 2, 0)  # header (length filled later)
                    new_data += struct.pack('<II', len(json_chunk_data), 0x4E4F534A)
                    new_data += json_chunk_data
                    new_data += struct.pack('<II', len(bin_data), 0x004E4942)
                    new_data += bin_data
                    struct.pack_into('<I', new_data, 8, len(new_data))
                    data = new_data
                    bin_chunk_offset = 12 + 8 + len(json_chunk_data) + 8

                modified = True

            if modified:
                # Update total GLB length in header
                struct.pack_into('<I', data, 8, len(data))
                with open(glb_path, 'wb') as f:
                    f.write(data)

            return modified

        did_enhance = _modify_glb_textures(output_path, enhance=False, upscale_to=upscale_tex_to)
        if did_enhance:
            msgs = ["contrast +30%, saturation +40%, brightness +5%"]
            if upscale_tex_to > 0:
                msgs.append(f"upscaled to {upscale_tex_to}px")
            print(f"LOCAL_SF3D: texture post-processed ({', '.join(msgs)})", flush=True)

    except Exception as _te:
        print(f"LOCAL_SF3D: texture post-process skipped ({_te})", flush=True)
        import traceback; traceback.print_exc()

    size = os.path.getsize(output_path)

    # Read back the GLB to count verts/faces for the UI stats display.
    try:
        import trimesh as _tmesh
        _scene = _tmesh.load(output_path)
        _geoms = list(_scene.geometry.values()) if hasattr(_scene, 'geometry') else [_scene]
        _total_verts = sum(len(g.vertices) for g in _geoms)
        _total_faces = sum(len(g.faces) for g in _geoms)
        print(f"LOCAL_SF3D_STATS: verts={_total_verts} faces={_total_faces} tex={tex_res}", flush=True)
    except Exception as _e:
        print(f"LOCAL_SF3D_STATS: verts=? faces=? tex={tex_res} (count failed: {_e})", flush=True)

    # ------------------------------------------------------------------
    # Optional: Catmull-Clark subdivision for higher triangle counts.
    # Uses pymeshlab (Python-only, no Blender needed). Runs on CPU so
    # no extra VRAM is consumed. Preserves UVs + PBR materials.
    # ------------------------------------------------------------------
    subdiv_val = int(subdivide_levels)
    # Convention from the UI:
    #   negative (e.g. -500)  = decimate to abs(val) faces (low-poly)
    #   0                     = keep SF3D default (~13K faces)
    #   1-4 (small int)       = subdivision levels (each ×4 triangles)
    #   >100 (e.g. 20000)    = target face count: subdivide up then decimate to exact target
    #
    # For target counts between SF3D default and a subdivision level, we
    # subdivide to the next level up, then decimate down to the exact target.

    if subdiv_val < 0:
        # --- DECIMATE to low-poly ---
        target_faces = abs(subdiv_val)
        _emit_progress('finalize', label='decimate_start')
        print(f"LOCAL_SF3D: decimating to ~{target_faces} faces...", flush=True)
        try:
            import subprocess as _sp
            _dec_script = os.path.join(os.path.dirname(__file__), 'subdivide.py')
            # subdivide.py handles negative levels as decimation target
            _raw = output_path + '.predec.glb'
            os.rename(output_path, _raw)
            _r = _sp.run([sys.executable, _dec_script, _raw, output_path, str(subdiv_val)],
                         capture_output=True, text=True, timeout=120)
            print(_r.stdout, flush=True)
            if _r.returncode != 0 or not os.path.exists(output_path):
                print(f"LOCAL_SF3D: decimation failed, using original", flush=True)
                if os.path.exists(_raw):
                    os.rename(_raw, output_path)
            else:
                try: os.remove(_raw)
                except: pass
        except Exception as _de:
            print(f"LOCAL_SF3D: decimation failed ({_de}), keeping original mesh", flush=True)

    elif subdiv_val > 100:
        # --- TARGET face count (e.g. 20000, 75000, 150000) ---
        # Subdivide to the next power-of-4 level above target, then decimate to exact
        target_faces = subdiv_val
        _emit_progress('finalize', label='target_faces_start')
        print(f"LOCAL_SF3D: targeting ~{target_faces} faces (subdivide + decimate)...", flush=True)
        import subprocess as _sp
        _raw = output_path + '.presub.glb'
        os.rename(output_path, _raw)
        try:
            # Calculate subdivision levels needed: base ~13K, each level ×4
            base_faces = 13000
            levels = 0
            current = base_faces
            while current < target_faces and levels < 5:
                levels += 1
                current *= 4
            # Subdivide
            _sub_script = os.path.join(os.path.dirname(__file__), 'subdivide.py')
            _sub_out = output_path + '.subdivided.glb'
            if levels > 0:
                _r1 = _sp.run([sys.executable, _sub_script, _raw, _sub_out, str(levels)],
                              capture_output=True, text=True, timeout=300)
                print(_r1.stdout, flush=True)
                if _r1.returncode != 0 or not os.path.exists(_sub_out):
                    print(f"LOCAL_SF3D: subdivision failed, using raw mesh", flush=True)
                    os.rename(_raw, output_path)
                    try: os.remove(_sub_out)
                    except: pass
                else:
                    try: os.remove(_raw)
                    except: pass
            else:
                os.rename(_raw, _sub_out)

            # Decimate to exact target if we overshot
            if os.path.exists(_sub_out):
                _r2 = _sp.run([sys.executable, _sub_script, _sub_out, output_path, str(-target_faces)],
                              capture_output=True, text=True, timeout=120)
                print(_r2.stdout, flush=True)
                if _r2.returncode != 0 or not os.path.exists(output_path):
                    print(f"LOCAL_SF3D: final decimation failed, using subdivided mesh", flush=True)
                    os.rename(_sub_out, output_path)
                else:
                    try: os.remove(_sub_out)
                    except: pass
        except Exception as _te:
            print(f"LOCAL_SF3D: target faces failed ({_te}), using raw mesh", flush=True)
            if not os.path.exists(output_path) and os.path.exists(_raw):
                os.rename(_raw, output_path)

    elif subdiv_val > 0:
        # --- SUBDIVISION levels (1-4) ---
        _emit_progress('finalize', label='subdivide_start')
        print(f"LOCAL_SF3D: subdividing x{subdivide_levels} via trimesh...", flush=True)
        import subprocess
        subdivide_script = os.path.join(os.path.dirname(__file__), 'subdivide.py')
        raw_glb = output_path + '.raw.glb'
        os.rename(output_path, raw_glb)
        try:
            result = subprocess.run(
                [sys.executable, subdivide_script, raw_glb, output_path, str(subdivide_levels)],
                capture_output=True, text=True, timeout=300
            )
            print(result.stdout, flush=True)
            if result.returncode != 0 or not os.path.exists(output_path):
                print(f"LOCAL_SF3D: subdivide failed (code {result.returncode}), using raw mesh", flush=True)
                if result.stderr:
                    print(f"LOCAL_SF3D: {result.stderr[-500:]}", flush=True)
                if os.path.exists(raw_glb):
                    os.rename(raw_glb, output_path)
            else:
                try: os.remove(raw_glb)
                except: pass
        except Exception as e:
            print(f"LOCAL_SF3D: subdivide exception ({e}), using raw mesh", flush=True)
            if os.path.exists(raw_glb) and not os.path.exists(output_path):
                os.rename(raw_glb, output_path)

    # ------------------------------------------------------------------
    # Texture projection: LAST step — after subdivision/decimation.
    # Re-project source photo onto the final mesh for sharp textures.
    # ------------------------------------------------------------------
    _emit_progress('tex_project', label='texture_project')
    # Modes:
    #   upscale (DEFAULT) — keep SF3D's native baked atlas (correct UV
    #     layout, just blurry) and run RealESRGAN x4 on it. Cleanest
    #     result: no UV mosaic, no vertex-color flou, just sharper.
    #   augment — KEEP the SF3D atlas (well-textured front), then
    #     additively rewrite ONLY the back/sides where multi-view
    #     visibility beats the front. Best of both worlds.
    #   atlas — multi-view UV projection (tends to mosaic on SF3D UVs)
    #   vc    — vertex-color projection (smooth but low-detail)
    #   none  — skip post-processing entirely
    _proj_mode = os.environ.get('FABMESH_PROJECT_MODE', 'refine').lower()
    _vc_script = os.path.join(os.path.dirname(__file__), 'texture_project_vc.py')
    _atlas_script = os.path.join(os.path.dirname(__file__), 'texture_project.py')
    _upscale_script = os.path.join(os.path.dirname(__file__), 'upscale_atlas.py')
    _augment_script = os.path.join(os.path.dirname(__file__), 'texture_augment.py')
    _refine_script = os.path.join(os.path.dirname(__file__), 'texture_refine.py')
    try:
        import subprocess as _sp_proj
        _cmd = None
        _label = None
        _cmd_sub_phase = None  # which phase's slice the streamed sub-pct maps to
        if _proj_mode == 'upscale' and os.path.exists(_upscale_script):
            # Atlas-only sharpener: keep SF3D's UV mapping and texture
            # data, just run RealESRGAN x4 on the baked image. This
            # avoids the multi-view UV mosaic problem entirely.
            _target = max(int(tex_res), 2048)
            _cmd = [sys.executable, _upscale_script, output_path,
                    output_path, '--target', str(_target)]
            _label = f'atlas upscale -> {_target}px'
            _cmd_sub_phase = 'refine'  # upscale occupies the refine time slot
        elif _proj_mode == 'refine' and os.path.exists(_refine_script):
            # Meshy-style: pass the SF3D atlas through SDXL img2img at
            # low strength to add micro-detail without changing layout.
            # Talks to the always-on SDXL server (~1 GB VRAM persisted)
            # to avoid loading a 6 GB pipeline per generation.
            #
            # 2026-04-15 FIDELITY FIX: if multi-views are available,
            # first project them onto the atlas (same pass as 'atlas'
            # mode) to inject real back/sides info from Zero123++,
            # THEN run SDXL refine on top. This makes the final atlas
            # actually faithful to the reference image on all angles
            # instead of relying on SF3D's single-view fallback for
            # the back.
            _target = max(int(tex_res), 2048)
            # Pull the original user prompt from images/<project>/prompts.json
            # so the refine knows it's an "orc warrior with blue crown" and
            # not a generic surface — without this, SDXL hallucinates the
            # wrong subject (e.g. ice golem instead of orc).
            _refine_prompt = None
            try:
                _img_dir = os.path.dirname(os.path.abspath(image_path))
                _prompts_json = os.path.join(_img_dir, 'prompts.json')
                if os.path.exists(_prompts_json):
                    import json as _pj
                    with open(_prompts_json, 'r', encoding='utf-8') as _pf:
                        _entries = _pj.load(_pf)
                    if isinstance(_entries, list) and _entries:
                        # Use the most recent prompt
                        _refine_prompt = (_entries[-1].get('prompt')
                                          or _entries[-1].get('fullPrompt'))
            except Exception as _pe:
                print(f"LOCAL_SF3D: could not read prompts.json ({_pe})", flush=True)

            # Step 1: multi-view projection pass if views are available.
            # Same call as the 'atlas' mode but we intentionally don't
            # bump tex_res (keep it modest, since refine will upscale).
            if (_multiview_dir and os.path.isdir(_multiview_dir)
                    and os.path.exists(_atlas_script)):
                try:
                    # Streamed so the UV-projection rasterization loop can
                    # emit FABMESH_SUBPCT: lines that move the UI bar inside
                    # the tex_project slice.
                    _r_mv_proj = _stream_subprocess(
                        [sys.executable, _atlas_script, output_path,
                         _preprocessed_path, output_path, str(tex_res),
                         '--multiview', _multiview_dir,
                         '--rotation-offset', str(-auto_align_rot_deg)],
                        timeout=300, sub_phase='tex_project',
                    )
                    if _r_mv_proj.returncode == 0:
                        print("LOCAL_SF3D: multi-view projection applied before refine", flush=True)
                    else:
                        print(f"LOCAL_SF3D: multi-view projection failed (code {_r_mv_proj.returncode}), continuing with vanilla SF3D atlas", flush=True)
                except Exception as _mvp_e:
                    print(f"LOCAL_SF3D: multi-view projection error ({_mvp_e}), continuing", flush=True)

            # Step 2: SDXL refine on top of the (possibly projected) atlas.
            _cmd = [sys.executable, _refine_script, output_path,
                    output_path, '--strength', '0.25',
                    '--target', str(_target)]
            if _refine_prompt:
                _cmd += ['--prompt', _refine_prompt]
                print(f"LOCAL_SF3D: refine prompt={_refine_prompt[:80]!r}", flush=True)
            _label = f'SDXL atlas refine -> {_target}px'
            _cmd_sub_phase = 'refine'
        elif _proj_mode == 'augment' and os.path.exists(_augment_script):
            # Keep SF3D's atlas where it's good (front), additively
            # rewrite back/sides from multi-views where they see better.
            if _multiview_dir and os.path.isdir(_multiview_dir):
                _cmd = [sys.executable, _augment_script, output_path,
                        _preprocessed_path, output_path,
                        '--multiview', _multiview_dir,
                        '--rotation-offset', str(-auto_align_rot_deg)]
                _label = 'multi-view augment'
                _cmd_sub_phase = 'tex_project'
            else:
                print('LOCAL_SF3D: augment mode requested but no multi-view dir', flush=True)
        elif _proj_mode == 'vc' and os.path.exists(_vc_script):
            _cmd = ([sys.executable, _vc_script, output_path,
                     _preprocessed_path, output_path]
                    + (['--multiview', _multiview_dir,
                        '--rotation-offset', str(-auto_align_rot_deg)]
                       if _multiview_dir and os.path.isdir(_multiview_dir) else []))
            _label = 'vertex-color projection'
            _cmd_sub_phase = 'tex_project'
        elif _proj_mode == 'atlas' and os.path.exists(_atlas_script):
            _cmd = ([sys.executable, _atlas_script, output_path,
                     _preprocessed_path, output_path, str(tex_res)]
                    + (['--multiview', _multiview_dir,
                        '--rotation-offset', str(-auto_align_rot_deg)]
                       if _multiview_dir and os.path.isdir(_multiview_dir) else []))
            _label = 'UV atlas projection'
            _cmd_sub_phase = 'tex_project'
        elif _proj_mode == 'atlas_refine' and os.path.exists(_atlas_script):
            # Two-pass: first multi-view UV projection (atlas script)
            # to cover the back/sides with real Zero123++ data, then
            # SDXL refine to clean seams + add micro-detail. Cmd
            # below is just the first pass; the second pass is
            # triggered after this if-block succeeds.
            if _multiview_dir and os.path.isdir(_multiview_dir):
                _cmd = ([sys.executable, _atlas_script, output_path,
                         _preprocessed_path, output_path, str(tex_res),
                         '--multiview', _multiview_dir,
                         '--rotation-offset', str(-auto_align_rot_deg)])
                _label = 'atlas+refine pass 1 (projection)'
                _cmd_sub_phase = 'tex_project'
            else:
                print('LOCAL_SF3D: atlas_refine needs multi-view dir', flush=True)
        elif _proj_mode == 'none':
            print('LOCAL_SF3D: native SF3D atlas kept (FABMESH_PROJECT_MODE=none)', flush=True)
        if _cmd:
            # 600s timeout — texture_refine.py with SDXL img2img on 9 tiles
            # can take ~90s when the SDXL server isn't running (in-process
            # fallback loads RealVisXL ~6 GB). The old 120s killed it
            # mid-refine and we got back the unrefined SF3D atlas.
            # Streamed so FABMESH_SUBPCT lines emitted by the sub-script
            # (e.g. texture_refine.py per-tile, texture_project.py per-face-batch)
            # are remapped live into the overall progress bar.
            _r_proj = _stream_subprocess(_cmd, timeout=600,
                                         sub_phase=_cmd_sub_phase)
            if _r_proj.returncode != 0:
                print(f"LOCAL_SF3D: {_label} failed (code {_r_proj.returncode})", flush=True)
                if _r_proj.stderr:
                    for line in _r_proj.stderr.strip().split('\n')[:20]:
                        print(f"LOCAL_SF3D: {line}", flush=True)
            else:
                print(f"LOCAL_SF3D: {_label} applied", flush=True)
                # Second pass for atlas_refine: SDXL refine on the
                # projection result. Subject prompt grabbed from
                # prompts.json same as plain refine mode.
                if _proj_mode == 'atlas_refine' and os.path.exists(_refine_script):
                    _refine_prompt = None
                    try:
                        _img_dir = os.path.dirname(os.path.abspath(image_path))
                        _prompts_json = os.path.join(_img_dir, 'prompts.json')
                        if os.path.exists(_prompts_json):
                            import json as _pj
                            with open(_prompts_json, 'r', encoding='utf-8') as _pf:
                                _entries = _pj.load(_pf)
                            if isinstance(_entries, list) and _entries:
                                _refine_prompt = (_entries[-1].get('prompt')
                                                  or _entries[-1].get('fullPrompt'))
                    except Exception:
                        pass
                    _refine_cmd = [sys.executable, _refine_script, output_path,
                                   output_path, '--strength', '0.22',
                                   '--target', str(max(int(tex_res), 2048))]
                    if _refine_prompt:
                        _refine_cmd += ['--prompt', _refine_prompt]
                    print(f"LOCAL_SF3D: atlas_refine pass 2 (SDXL refine) starting", flush=True)
                    _r2 = _stream_subprocess(_refine_cmd, timeout=600,
                                             sub_phase='refine')
                    if _r2.returncode != 0:
                        print(f"LOCAL_SF3D: pass 2 refine failed (code {_r2.returncode})", flush=True)
                    else:
                        print(f"LOCAL_SF3D: atlas_refine pass 2 done", flush=True)
    except Exception as _tp_e:
        print(f"LOCAL_SF3D: texture projection skipped ({_tp_e})", flush=True)
    finally:
        try: os.remove(_preprocessed_path)
        except: pass
        if _multiview_dir and os.path.isdir(_multiview_dir):
            try:
                import shutil
                shutil.rmtree(_multiview_dir, ignore_errors=True)
            except: pass

    # Re-read final file size
    size = os.path.getsize(output_path)
    print(f"LOCAL_SF3D_SUCCESS: {output_path} ({size} bytes)", flush=True)
    print(f"LOCAL_SF3D_PROGRESS: 100 done", flush=True)  # final — keep literal 100

    # Free GPU
    del model
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return True


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python local_sf3d_bridge.py <image_path> <output_glb_path> [tex_res] [vertex_count] [remesh] [subdivide_levels]")
        sys.exit(1)
    image = sys.argv[1]
    out = sys.argv[2]
    tex_res = int(sys.argv[3]) if len(sys.argv) > 3 else 1024
    vcount = int(sys.argv[4]) if len(sys.argv) > 4 else -1
    remesh = sys.argv[5] if len(sys.argv) > 5 else 'none'
    subdiv = int(sys.argv[6]) if len(sys.argv) > 6 else 0
    try:
        ok = generate_3d(
            image, out,
            texture_resolution=tex_res,
            target_vertex_count=vcount,
            remesh_option=remesh,
            subdivide_levels=subdiv,
        )
        sys.exit(0 if ok else 1)
    except Exception as e:
        print(f"LOCAL_SF3D_ERROR: {type(e).__name__}: {e}", flush=True)
        traceback.print_exc()
        sys.exit(2)
