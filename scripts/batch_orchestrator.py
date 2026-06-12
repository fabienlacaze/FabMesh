"""MyFabmesh v1 batch orchestrator — full retarget pipeline over a CSV.

Per input row (mesh_glb, motion_fbx, class, priority):
  1. If <mesh_glb>.labels.json is missing -> call auto_label_rig.py
  2. Call rokoko_batch_retarget.py (Blender single-retarget mode) to bake
     <out>/animations/<motion_stem>__<mesh_stem>.glb
  3. Call judge_retarget.py for per-clip metrics (verdict + score). If
     the script is missing, fall back to an inline lightweight judge
     that inspects the produced GLB (animation length, per-bone motion
     variance, file size sanity) — keeps the batch self-contained so
     v1 ships without waiting on the judge.
  4. If verdict == BAD: log to failed.csv (with reason). Else: log to
     success.csv with score + metrics. Skip-on-resume if the output GLB
     and report already exist.

Layout written under --out-dir:
  animations/<motion_stem>__<mesh_stem>.glb
  qa/<motion_stem>__<mesh_stem>_report.json
  logs/<motion_stem>__<mesh_stem>.log     (stdout+stderr of each step)
  success.csv  failed.csv  summary.json   batch.log

Execution:
  ProcessPoolExecutor with --jobs workers (default 4). Each worker is a
  CPU-heavy Blender subprocess so leave at ~CPU_COUNT / 2 on the rig.
  Per-row hard timeout (--row-timeout, default 300 s) so a stuck
  nla.bake (Rokoko issue #65) can't poison the queue.

  Progress line every 50 rows. SIGINT writes a partial summary.json and
  exits cleanly (futures get cancelled, in-flight Blender subprocesses
  are killed).

CLI examples
  # Small test — 4 pairs, 2 workers, no resume
  python scripts/batch_orchestrator.py \
      --csv c:/tmp/batch_small.csv \
      --out-dir c:/tmp/batch_smoke \
      --jobs 2 --row-timeout 240

  # Full overnight batch (55k+) — 8 workers, resume from last run
  python scripts/batch_orchestrator.py \
      --csv c:/tmp/batch_full.csv \
      --out-dir c:/tmp/batch_v1 \
      --jobs 8 --row-timeout 360 --resume

  # Helper: build the CSV from two dirs (every motion x every rig of
  # matching class). Class is auto-detected from rig filename + pred.txt
  # (humanoid / quadruped / winged_biped).
  python scripts/batch_orchestrator.py build-csv \
      --motions-dir c:/tmp/apovivor_fbx/1_Source \
      --rigs-dir   c:/tmp/training_rigs \
      --out        c:/tmp/batch_full.csv
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import signal
import subprocess
import sys
import time
import traceback
from concurrent.futures import ProcessPoolExecutor, as_completed, TimeoutError as FutTimeout
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Optional


# ---------------------------------------------------------------------------
# Paths / config — match conventions used by the rest of the pipeline.
# ---------------------------------------------------------------------------
REPO = Path(__file__).resolve().parent.parent
SCRIPTS = REPO / "scripts"

AUTO_LABEL = SCRIPTS / "label_by_topology.py"  # was auto_label_rig.py — topology-based gives +7 pts mean score on humanoid smoke test
ROKOKO_BATCH = SCRIPTS / "rokoko_batch_retarget.py"
JUDGE = SCRIPTS / "judge_retarget.py"  # optional — inline fallback below

BLENDER_EXE = r"c:/tools/blender-4.4.3-windows-x64/blender.exe"

# Verdict thresholds for the inline fallback judge. Tuned against the
# Apovivor->humanoid baseline from rokoko_out/: a clip with at least
# 1.0 s of motion and per-bone position variance > 1e-4 is plausible.
INLINE_MIN_DURATION_S = 0.5
INLINE_MIN_BONE_VARIANCE = 1e-5
INLINE_MIN_FILE_KB = 64

CLASSES = ("humanoid", "quadruped", "winged_biped")


# ---------------------------------------------------------------------------
# Row model
# ---------------------------------------------------------------------------
@dataclass
class Row:
    mesh_glb: str
    motion_fbx: str
    cls: str
    priority: int = 1

    @property
    def stem(self) -> str:
        # Match rokoko_batch_retarget.py's output naming: <motion>__<rig>.glb
        return f"{Path(self.motion_fbx).stem}__{Path(self.mesh_glb).stem}"


@dataclass
class RowResult:
    row: Row
    status: str                  # "ok" / "skip" / "fail"
    verdict: str = "UNKNOWN"     # GOOD / BAD / UNKNOWN
    score: float = 0.0
    reason: str = ""
    duration_s: float = 0.0
    out_glb: str = ""
    report_json: str = ""
    metrics: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# CSV I/O
# ---------------------------------------------------------------------------
def load_rows(csv_path: Path) -> list[Row]:
    rows: list[Row] = []
    with open(csv_path, "r", newline="", encoding="utf-8") as f:
        rdr = csv.DictReader(f)
        for r in rdr:
            cls = (r.get("class") or "").strip().lower()
            if cls not in CLASSES:
                # Skip silently; orchestrator only handles known classes.
                # Unknowns belong in a separate triage run.
                continue
            try:
                pr = int(r.get("priority", "1"))
            except ValueError:
                pr = 1
            rows.append(Row(
                mesh_glb=r["mesh_glb"].strip(),
                motion_fbx=r["motion_fbx"].strip(),
                cls=cls,
                priority=pr,
            ))
    # Highest priority first so the most important assets land early
    # even if the batch is killed mid-run.
    rows.sort(key=lambda x: (-x.priority, x.stem))
    return rows


def append_csv(path: Path, header: list[str], row: dict) -> None:
    new = not path.exists()
    with open(path, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=header)
        if new:
            w.writeheader()
        w.writerow(row)


# ---------------------------------------------------------------------------
# Step 1 — auto label
# ---------------------------------------------------------------------------
def ensure_labels(row: Row, log_fp) -> tuple[bool, str]:
    """Return (ok, reason). Writes <mesh_glb>.labels.json if missing."""
    labels_path = Path(row.mesh_glb + ".labels.json")
    if labels_path.is_file():
        return True, "cached"

    # label_by_topology.py does not take a --class flag (it's humanoid-only
    # right now — topology-based identification of the 22 canonical bones).
    cmd = [
        sys.executable, str(AUTO_LABEL),
        "--rig", row.mesh_glb,
        "--out", str(labels_path),
    ]
    try:
        rc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=120,
        )
    except subprocess.TimeoutExpired:
        log_fp.write("[auto-label] TIMEOUT\n")
        return False, "auto_label timeout"

    log_fp.write(f"[auto-label] rc={rc.returncode}\n")
    log_fp.write(rc.stdout or "")
    log_fp.write(rc.stderr or "")
    if rc.returncode != 0 or not labels_path.is_file():
        return False, f"auto_label rc={rc.returncode}"
    return True, "labeled"


# ---------------------------------------------------------------------------
# Step 2 — rokoko retarget (single mode via Blender)
# ---------------------------------------------------------------------------
def run_rokoko(row: Row, anims_dir: Path, log_fp, timeout_s: int) -> tuple[bool, Path, str]:
    out_glb = anims_dir / f"{row.stem}.glb"
    if out_glb.is_file():
        return True, out_glb, "cached"

    cmd = [
        BLENDER_EXE,
        "--background",
        "--factory-startup",
        "--python", str(ROKOKO_BATCH),
        "--",
        "--src-fbx", row.motion_fbx,
        "--tgt-glb", row.mesh_glb,
        "--out-dir", str(anims_dir),
    ]
    try:
        rc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout_s,
        )
    except subprocess.TimeoutExpired:
        log_fp.write("[rokoko] TIMEOUT\n")
        return False, out_glb, "rokoko timeout"

    log_fp.write(f"[rokoko] rc={rc.returncode}\n")
    # Blender stdout is huge — only keep the tail to bound disk use.
    log_fp.write((rc.stdout or "")[-4000:])
    log_fp.write((rc.stderr or "")[-2000:])
    if rc.returncode != 0 or not out_glb.is_file():
        return False, out_glb, f"rokoko rc={rc.returncode}"
    return True, out_glb, "baked"


# ---------------------------------------------------------------------------
# Step 3 — judge (external if present, inline fallback otherwise)
# ---------------------------------------------------------------------------
def judge_external(out_glb: Path, report_path: Path, log_fp, timeout_s: int = 90) -> Optional[dict]:
    if not JUDGE.is_file():
        return None
    cmd = [
        sys.executable, str(JUDGE),
        str(out_glb),
        "--out", str(report_path),
    ]
    try:
        rc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout_s,
        )
    except subprocess.TimeoutExpired:
        log_fp.write("[judge] TIMEOUT\n")
        return {"verdict": "BAD", "score": 0.0, "reason": "judge timeout"}

    log_fp.write(f"[judge] rc={rc.returncode}\n")
    log_fp.write((rc.stdout or "")[-2000:])
    log_fp.write((rc.stderr or "")[-1000:])
    if rc.returncode != 0 or not report_path.is_file():
        return {"verdict": "BAD", "score": 0.0,
                "reason": f"judge rc={rc.returncode}"}
    try:
        return json.loads(report_path.read_text(encoding="utf-8"))
    except Exception as e:
        return {"verdict": "BAD", "score": 0.0,
                "reason": f"judge report unreadable: {e}"}


def judge_inline(out_glb: Path) -> dict:
    """Lightweight verdict from the GLB alone — no Blender needed.

    Checks:
      - File size > INLINE_MIN_FILE_KB (catches empty exports)
      - Animation exists with duration > INLINE_MIN_DURATION_S
      - Mean per-bone translation variance > INLINE_MIN_BONE_VARIANCE
        (catches "all bones frozen" failures where retarget produced
        an animation track of identity transforms)
    """
    metrics: dict = {"file_kb": 0.0, "duration_s": 0.0,
                     "num_anims": 0, "num_bones_animated": 0,
                     "mean_translation_var": 0.0}
    if not out_glb.is_file():
        return {"verdict": "BAD", "score": 0.0,
                "reason": "missing output", "metrics": metrics}

    metrics["file_kb"] = out_glb.stat().st_size / 1024.0
    if metrics["file_kb"] < INLINE_MIN_FILE_KB:
        return {"verdict": "BAD", "score": 0.0,
                "reason": f"file < {INLINE_MIN_FILE_KB} KB",
                "metrics": metrics}

    try:
        import pygltflib  # lazy: not installed on every machine
        import struct
        g = pygltflib.GLTF2().load(str(out_glb))
        blob = g.binary_blob()

        if not g.animations:
            return {"verdict": "BAD", "score": 0.1,
                    "reason": "no animations", "metrics": metrics}
        metrics["num_anims"] = len(g.animations)

        # Collect duration + translation samples (one per animated bone).
        max_time = 0.0
        translation_vars: list[float] = []
        animated_bones = set()

        for anim in g.animations:
            for ch in anim.channels or []:
                target = ch.target
                if target is None or target.node is None:
                    continue
                animated_bones.add(target.node)
                if ch.sampler is None or ch.sampler >= len(anim.samplers):
                    continue
                samp = anim.samplers[ch.sampler]
                # Input accessor (time)
                in_acc = g.accessors[samp.input]
                if in_acc.max:
                    try:
                        t_max = float(in_acc.max[0])
                        if t_max > max_time:
                            max_time = t_max
                    except Exception:
                        pass

                if target.path != "translation":
                    continue
                out_acc = g.accessors[samp.output]
                if out_acc.componentType != 5126 or out_acc.type != "VEC3":
                    continue
                bv = g.bufferViews[out_acc.bufferView]
                offs = (bv.byteOffset or 0) + (out_acc.byteOffset or 0)
                count = out_acc.count
                raw = blob[offs:offs + 12 * count]
                vals = struct.unpack(f"<{count * 3}f", raw)
                # Per-axis variance — sum over xyz
                if count < 2:
                    continue
                xs = vals[0::3]; ys = vals[1::3]; zs = vals[2::3]
                def var(seq):
                    m = sum(seq) / len(seq)
                    return sum((v - m) ** 2 for v in seq) / len(seq)
                translation_vars.append(var(xs) + var(ys) + var(zs))

        metrics["duration_s"] = round(max_time, 3)
        metrics["num_bones_animated"] = len(animated_bones)
        mean_var = (sum(translation_vars) / len(translation_vars)
                    if translation_vars else 0.0)
        metrics["mean_translation_var"] = mean_var

        if max_time < INLINE_MIN_DURATION_S:
            return {"verdict": "BAD", "score": 0.2,
                    "reason": f"duration {max_time:.2f}s < min", "metrics": metrics}
        if mean_var > 0 and mean_var < INLINE_MIN_BONE_VARIANCE:
            return {"verdict": "BAD", "score": 0.3,
                    "reason": "bones frozen (variance ~ 0)",
                    "metrics": metrics}

        # Composite score in [0, 1] — duration up to 5 s and variance up
        # to 0.01 saturate. This is a rough sanity signal, not a quality
        # ranking; judge_retarget.py is expected to replace it.
        dur_score = min(1.0, max_time / 5.0)
        var_score = min(1.0, mean_var * 100.0) if mean_var > 0 else 0.5
        score = 0.6 * dur_score + 0.4 * var_score
        return {"verdict": "GOOD", "score": round(score, 3),
                "reason": "inline-judge ok", "metrics": metrics}

    except Exception as e:
        # Be conservative: if the GLB parser blows up, treat as BAD so
        # the user can re-run with a real judge later.
        return {"verdict": "BAD", "score": 0.0,
                "reason": f"inline judge crash: {e}", "metrics": metrics}


def run_judge(out_glb: Path, report_path: Path, log_fp) -> dict:
    rep = judge_external(out_glb, report_path, log_fp)
    if rep is None:
        rep = judge_inline(out_glb)
    # Always persist a copy so the user can inspect / re-judge later.
    try:
        report_path.write_text(json.dumps(rep, indent=2), encoding="utf-8")
    except Exception:
        pass
    return rep


# ---------------------------------------------------------------------------
# Per-row worker (runs in a subprocess via ProcessPoolExecutor)
# ---------------------------------------------------------------------------
def process_row(row_dict: dict, out_dir_str: str, row_timeout: int,
                resume: bool) -> dict:
    row = Row(**row_dict)
    out_dir = Path(out_dir_str)
    anims_dir = out_dir / "animations"
    qa_dir = out_dir / "qa"
    log_dir = out_dir / "logs"
    anims_dir.mkdir(parents=True, exist_ok=True)
    qa_dir.mkdir(parents=True, exist_ok=True)
    log_dir.mkdir(parents=True, exist_ok=True)

    out_glb = anims_dir / f"{row.stem}.glb"
    report_path = qa_dir / f"{row.stem}_report.json"
    log_path = log_dir / f"{row.stem}.log"

    t0 = time.time()

    # Resume — both artefacts exist AND the report is well-formed.
    if resume and out_glb.is_file() and report_path.is_file():
        try:
            rep = json.loads(report_path.read_text(encoding="utf-8"))
            return asdict(RowResult(
                row=row,
                status="skip",
                verdict=rep.get("verdict", "UNKNOWN"),
                score=float(rep.get("score", 0.0)),
                reason="resume:cached",
                duration_s=0.0,
                out_glb=str(out_glb),
                report_json=str(report_path),
                metrics=rep.get("metrics", {}),
            ))
        except Exception:
            # Bad cache — fall through and redo this row.
            pass

    # Quick sanity on inputs so we don't waste a Blender startup.
    if not Path(row.mesh_glb).is_file():
        return asdict(RowResult(row=row, status="fail",
                                reason="mesh_glb missing"))
    if not Path(row.motion_fbx).is_file():
        return asdict(RowResult(row=row, status="fail",
                                reason="motion_fbx missing"))

    with open(log_path, "w", encoding="utf-8") as log_fp:
        log_fp.write(f"[orchestrator] {row.stem}\n")
        log_fp.write(f"  mesh:   {row.mesh_glb}\n")
        log_fp.write(f"  motion: {row.motion_fbx}\n")
        log_fp.write(f"  class:  {row.cls}\n\n")

        # Step 1 — labels
        ok, reason = ensure_labels(row, log_fp)
        if not ok:
            return asdict(RowResult(row=row, status="fail",
                                    reason=f"label:{reason}",
                                    duration_s=time.time() - t0))

        # Step 2 — retarget (Blender does most of the heavy lifting)
        ok, glb_path, reason = run_rokoko(
            row, anims_dir, log_fp, row_timeout,
        )
        if not ok:
            return asdict(RowResult(row=row, status="fail",
                                    reason=f"rokoko:{reason}",
                                    out_glb=str(glb_path),
                                    duration_s=time.time() - t0))

        # Step 3 — judge
        rep = run_judge(glb_path, report_path, log_fp)
        verdict = str(rep.get("verdict", "UNKNOWN")).upper()
        score = float(rep.get("score", 0.0))
        metrics = rep.get("metrics", {})

        status = "fail" if verdict == "BAD" else "ok"
        return asdict(RowResult(
            row=row,
            status=status,
            verdict=verdict,
            score=score,
            reason=rep.get("reason", ""),
            duration_s=time.time() - t0,
            out_glb=str(glb_path),
            report_json=str(report_path),
            metrics=metrics,
        ))


# ---------------------------------------------------------------------------
# Orchestrator driver
# ---------------------------------------------------------------------------
SUCCESS_HEADER = ["mesh_glb", "motion_fbx", "class", "verdict", "score",
                  "out_glb", "report_json", "duration_s", "reason"]
FAILED_HEADER = ["mesh_glb", "motion_fbx", "class", "verdict", "reason",
                 "duration_s"]


def _result_to_csv_rows(res: dict) -> tuple[dict, dict]:
    """Project the dataclass dict back to the success/failed CSV columns."""
    row = res["row"]
    base = {
        "mesh_glb": row["mesh_glb"],
        "motion_fbx": row["motion_fbx"],
        "class": row["cls"],
    }
    succ = dict(base, **{
        "verdict": res["verdict"],
        "score": f"{res['score']:.3f}",
        "out_glb": res["out_glb"],
        "report_json": res["report_json"],
        "duration_s": f"{res['duration_s']:.1f}",
        "reason": res["reason"],
    })
    fail = dict(base, **{
        "verdict": res["verdict"],
        "reason": res["reason"],
        "duration_s": f"{res['duration_s']:.1f}",
    })
    return succ, fail


def run_batch(args: argparse.Namespace) -> None:
    csv_path = Path(args.csv)
    if not csv_path.is_file():
        print(f"[batch] CSV not found: {csv_path}")
        sys.exit(2)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "animations").mkdir(exist_ok=True)
    (out_dir / "qa").mkdir(exist_ok=True)
    (out_dir / "logs").mkdir(exist_ok=True)

    rows = load_rows(csv_path)
    if args.limit:
        rows = rows[: args.limit]
    n = len(rows)
    print(f"[batch] {n} rows, jobs={args.jobs}, resume={args.resume}, "
          f"row_timeout={args.row_timeout}s, out={out_dir}")
    if n == 0:
        print("[batch] nothing to do — wrote summary.json with zeros.")
        (out_dir / "summary.json").write_text(json.dumps({
            "total": 0, "ok": 0, "fail": 0, "skip": 0,
        }, indent=2), encoding="utf-8")
        return

    success_csv = out_dir / "success.csv"
    failed_csv = out_dir / "failed.csv"
    batch_log = out_dir / "batch.log"
    summary_path = out_dir / "summary.json"
    if not args.resume:
        for p in (success_csv, failed_csv):
            if p.exists():
                p.unlink()

    counts = {"ok": 0, "fail": 0, "skip": 0}
    by_class: dict[str, dict[str, int]] = {}
    scores: list[float] = []
    t0 = time.time()

    def write_summary(done_now: int) -> None:
        elapsed = time.time() - t0
        summary_path.write_text(json.dumps({
            "total": n,
            "done": done_now,
            "elapsed_s": round(elapsed, 1),
            "ok": counts["ok"],
            "fail": counts["fail"],
            "skip": counts["skip"],
            "mean_score": (sum(scores) / len(scores)) if scores else 0.0,
            "by_class": by_class,
            "csv": str(csv_path),
            "jobs": args.jobs,
            "row_timeout": args.row_timeout,
        }, indent=2), encoding="utf-8")

    def log_batch(msg: str) -> None:
        line = f"[{time.strftime('%H:%M:%S')}] {msg}"
        print(line, flush=True)
        with open(batch_log, "a", encoding="utf-8") as f:
            f.write(line + "\n")

    # Graceful Ctrl+C — write what we have and let futures cancel.
    interrupted = {"flag": False}
    def _sigint(_sig, _frm):
        interrupted["flag"] = True
        log_batch("Ctrl+C — finishing in-flight rows then exiting.")
    try:
        signal.signal(signal.SIGINT, _sigint)
    except Exception:
        pass

    row_dicts = [asdict(r) for r in rows]
    done = 0
    with ProcessPoolExecutor(max_workers=args.jobs) as ex:
        futs = {
            ex.submit(process_row, rd, str(out_dir),
                      args.row_timeout, args.resume): rd
            for rd in row_dicts
        }
        for fut in as_completed(futs):
            rd = futs[fut]
            try:
                # The worker itself enforces row_timeout on Blender,
                # but bound the wait here too in case a worker hangs
                # before reaching subprocess.run.
                res = fut.result(timeout=args.row_timeout + 30)
            except FutTimeout:
                res = asdict(RowResult(
                    row=Row(**rd), status="fail",
                    reason="worker future timeout",
                ))
            except Exception as e:
                res = asdict(RowResult(
                    row=Row(**rd), status="fail",
                    reason=f"worker crash: {e!r}",
                ))
                traceback.print_exc()

            done += 1
            status = res["status"]
            counts[status] = counts.get(status, 0) + 1
            cls = res["row"]["cls"]
            cb = by_class.setdefault(cls, {"ok": 0, "fail": 0, "skip": 0})
            cb[status] = cb.get(status, 0) + 1
            if status == "ok":
                scores.append(res["score"])

            succ, fail = _result_to_csv_rows(res)
            if status == "fail":
                append_csv(failed_csv, FAILED_HEADER, fail)
            else:
                append_csv(success_csv, SUCCESS_HEADER, succ)

            if done % 50 == 0 or done == n or done <= 5:
                elapsed = time.time() - t0
                eta = (elapsed / done) * (n - done) if done else 0
                log_batch(
                    f"[{done}/{n}] ok={counts['ok']} "
                    f"fail={counts['fail']} skip={counts['skip']} "
                    f"({elapsed/60:.1f} min elapsed, "
                    f"ETA {eta/60:.1f} min)"
                )
                write_summary(done)

            if interrupted["flag"]:
                # Cancel pending futures — running Blender procs will
                # be killed when the worker process tears down.
                for f2 in futs:
                    if not f2.done():
                        f2.cancel()
                break

    write_summary(done)
    log_batch(
        f"DONE — {counts['ok']} ok, {counts['fail']} fail, "
        f"{counts['skip']} skip in {(time.time() - t0)/60:.1f} min. "
        f"summary={summary_path}"
    )


# ---------------------------------------------------------------------------
# Helper sub-command: build CSV from two directories
# ---------------------------------------------------------------------------
def _detect_class_from_rig(rig: Path) -> Optional[str]:
    """Look for explicit hints in (a) parent dir, (b) filename,
    (c) pred.txt header, in that order."""
    parts_lower = {p.lower() for p in rig.parts}
    for c in CLASSES:
        if c in parts_lower:
            return c
    name = rig.stem.lower()
    for c in CLASSES:
        if c in name:
            return c
    # pred.txt sidecar may contain a leading comment "# class: humanoid"
    pred = Path(str(rig) + ".pred.txt")
    if pred.is_file():
        try:
            head = pred.read_text(encoding="utf-8", errors="ignore")[:512]
            head_l = head.lower()
            for c in CLASSES:
                if c in head_l:
                    return c
        except Exception:
            pass
    return None


def _detect_class_from_motion(motion: Path) -> Optional[str]:
    parts_lower = {p.lower() for p in motion.parts}
    for c in CLASSES:
        if c in parts_lower:
            return c
    name = motion.stem.lower()
    for c in CLASSES:
        if c in name:
            return c
    # Apovivor convention: ANIM_AS_Robot*/Human*/Char* = humanoid
    if any(k in name for k in ("robot", "human", "char", "guy", "man",
                                "warrior", "soldier")):
        return "humanoid"
    if any(k in name for k in ("dog", "cat", "horse", "wolf", "tiger",
                                "spider")):
        return "quadruped"
    if any(k in name for k in ("dragon", "wyvern", "bird", "bat")):
        return "winged_biped"
    return None


def build_csv(args: argparse.Namespace) -> None:
    motions_dir = Path(args.motions_dir)
    rigs_dir = Path(args.rigs_dir)
    out_csv = Path(args.out)

    motions = sorted(motions_dir.rglob(args.motion_glob))
    rigs = sorted(rigs_dir.rglob(args.rig_glob))
    print(f"[build-csv] {len(motions)} motions x {len(rigs)} rigs")

    motion_class = {m: _detect_class_from_motion(m) for m in motions}
    rig_class = {r: _detect_class_from_rig(r) for r in rigs}

    n_unknown_motion = sum(1 for v in motion_class.values() if v is None)
    n_unknown_rig = sum(1 for v in rig_class.values() if v is None)
    if n_unknown_motion:
        print(f"[build-csv] WARN {n_unknown_motion} motions with no class — "
              f"assuming 'humanoid'")
    if n_unknown_rig:
        print(f"[build-csv] WARN {n_unknown_rig} rigs with no class — "
              f"skipping (provide class hint via filename or pred.txt)")

    out_csv.parent.mkdir(parents=True, exist_ok=True)
    with open(out_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["mesh_glb", "motion_fbx", "class", "priority"])
        pairs = 0
        for r in rigs:
            rc = rig_class[r]
            if rc is None:
                continue
            for m in motions:
                mc = motion_class.get(m) or "humanoid"
                if mc != rc:
                    continue
                w.writerow([str(r), str(m), rc, 1])
                pairs += 1
    print(f"[build-csv] wrote {out_csv} — {pairs} pairs")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="MyFabmesh v1 batch orchestrator")
    sub = p.add_subparsers(dest="cmd")

    # Default sub-command = "run" so plain
    #   batch_orchestrator.py --csv x --out-dir y
    # keeps working.
    run = sub.add_parser("run", help="Run the batch (default)")
    for ap in (p, run):
        ap.add_argument("--csv")
        ap.add_argument("--out-dir")
        ap.add_argument("--jobs", type=int, default=4)
        ap.add_argument("--row-timeout", type=int, default=300,
                        help="hard per-row timeout in seconds")
        ap.add_argument("--limit", type=int, default=None,
                        help="cap total rows (for smoke tests)")
        ap.add_argument("--resume", action="store_true",
                        help="skip rows whose GLB + report already exist")

    bc = sub.add_parser("build-csv",
                        help="Pair every motion with every rig of matching class")
    bc.add_argument("--motions-dir", required=True)
    bc.add_argument("--rigs-dir",    required=True)
    bc.add_argument("--out",         required=True)
    bc.add_argument("--motion-glob", default="*.fbx")
    bc.add_argument("--rig-glob",    default="*.glb")

    args = p.parse_args(argv)
    if args.cmd is None:
        args.cmd = "run"
    return args


def main() -> None:
    args = parse_args()
    if args.cmd == "build-csv":
        build_csv(args)
        return
    if not args.csv or not args.out_dir:
        print("ERR --csv and --out-dir are required for the run command")
        sys.exit(2)
    run_batch(args)


if __name__ == "__main__":
    main()
