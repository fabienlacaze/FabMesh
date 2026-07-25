"""Desktop bridge: text -> humanoid animation on a SkinTokens-rigged GLB.

Engine: NVIDIA Kimodo (Kimodo-SOMA-RP-v1.1) — text-to-motion diffusion,
commercial weights (NVIDIA Open Model License), trained on commercially
licensed mocap (Bones Rigplay 1). Runs locally on the RTX 5080 (sm_120,
plain torch cu128, <3 GB VRAM with the text encoder on CPU).

Pipeline:
  1. Spawn `kimodo.scripts.generate` in the Kimodo venv -> SOMA BVH
     (77 joints, Mixamo-like names, 30 fps, foot-skate corrected).
  2. Retarget the BVH onto the rig GLB via anytop_retarget's generic
     `retarget_motion_to_rig` (geometric target classifier — handles
     SkinTokens' generic bone_N names) with a SOMA source classifier.
  3. Write the animated GLB (mesh/skin untouched, AnimationClip appended).

CLI:
  python kimodo_bridge.py --rig in.glb --out out.glb \
      --prompt "a person walks forward" [--clip-name walk] [--bvh existing.bvh]

Env:
  FABMESH_KIMODO_PY     python.exe of the Kimodo venv (default c:\tmp\kmv312)
  KIMODO_TEXT_ENC_DIR   local text-encoder dir (default c:\tmp\kenc)
  KIMODO_OUTPUT_DAMP    retarget damping (default 1.0 = full motion;
                        humanoid->humanoid needs no damping, unlike the
                        dragon 142->47 case that motivated 0.25)

Prints LOCAL_KIMODO_PROGRESS: <0-99> lines so the renderer bar moves via
the existing onAI3DProgress channel.
"""
import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
KIMODO_DIR = PROJECT_ROOT / "external" / "kimodo"


def _log(level, msg):
    print(f"[kimodo:{level}] {msg}", flush=True)


def _progress(pct):
    print(f"LOCAL_KIMODO_PROGRESS: {int(pct)}", flush=True)


def _resolve_kimodo_python():
    for cand in (os.environ.get("FABMESH_KIMODO_PY"),
                 r"c:\tmp\kmv312\Scripts\python.exe",
                 r"c:\tmp\kmv\Scripts\python.exe"):
        if cand and os.path.exists(cand):
            return cand
    return None


def generate_bvh(prompt: str, out_stem: str) -> str:
    """Run kimodo_gen in the Kimodo venv; return the BVH path."""
    py = _resolve_kimodo_python()
    if not py:
        _log("error", "Kimodo venv introuvable. Setup:\n"
             "  python -m venv c:\\tmp\\kmv312 (Python 3.12)\n"
             "  pip install torch --index-url https://download.pytorch.org/whl/cu128\n"
             "  pip install -e external/kimodo bvhsdk")
        sys.exit(2)
    env = dict(os.environ)
    env.setdefault("PYTHONUTF8", "1")
    env.setdefault("TEXT_ENCODER_DEVICE", "cpu")     # <3 GB VRAM au lieu de ~17
    tenc = os.environ.get("KIMODO_TEXT_ENC_DIR", r"c:\tmp\kenc")
    if os.path.isdir(tenc):
        env.setdefault("TEXT_ENCODERS_DIR", tenc)    # adapters locaux (base = miroir non-gated)
    mc = str(KIMODO_DIR / "MotionCorrection" / "python")
    env["PYTHONPATH"] = mc + os.pathsep + env.get("PYTHONPATH", "")
    cmd = [py, "-m", "kimodo.scripts.generate", prompt, "--bvh",
           "--output", out_stem]
    _log("info", f"generation: {prompt!r}")
    _progress(5)
    r = subprocess.run(cmd, cwd=str(KIMODO_DIR), env=env,
                       capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=1800)
    tail = "\n".join((r.stdout or "").splitlines()[-8:])
    if r.returncode != 0:
        # MotionCorrection absent (py 3.11) -> retente sans post-process
        if "motion_correction" in (r.stdout or "") + (r.stderr or ""):
            _log("warn", "MotionCorrection indisponible - retry --no-postprocess")
            r = subprocess.run(cmd + ["--no-postprocess"], cwd=str(KIMODO_DIR),
                               env=env, capture_output=True, text=True,
                               encoding="utf-8", errors="replace", timeout=1800)
        if r.returncode != 0:
            _log("error", f"kimodo_gen rc={r.returncode}\n{tail}\n{(r.stderr or '')[-800:]}")
            sys.exit(3)
    bvh = out_stem + ".bvh"
    if not os.path.isfile(bvh):
        _log("error", f"BVH absent: {bvh}")
        sys.exit(3)
    _progress(60)
    return bvh


# ---------------------------------------------------------------------------
# SOMA -> roles: le classifieur générique d'anytop_retarget couvre presque
# tout (noms Mixamo-like) ; on corrige les 3 trous et on écarte le bruit.
# ---------------------------------------------------------------------------
def _classify_soma(name: str):
    import re
    import anytop_retarget as ar
    n = (name or "").strip()
    # Bruit / feuilles sans influence : Root (translation via root_pos),
    # end-sites, visage, doigts (les mains SkinTokens restent au bind).
    if (not n or n == "Root" or n.endswith("End")
            or n in ("Jaw", "LeftEye", "RightEye")
            or re.search(r"Hand(Thumb|Index|Middle|Ring|Pinky)", n)):
        return ("", None, 0)
    side = "l" if n.startswith("Left") else ("r" if n.startswith("Right") else None)
    if re.fullmatch(r"(Left|Right)Leg", n):     # SOMA: cuisse
        return ("leg", side, 1)
    if re.fullmatch(r"(Left|Right)Shin", n):
        return ("leg", side, 2)
    if n == "Chest":
        return ("spine", None, 3)
    return ar._classify_source_bone(n)


# ---------------------------------------------------------------------------
# Table cible humanoide construite par GEOMETRIE (bind pose) — le classifieur
# geometrique generique d'anytop_retarget suppose un layout Puppeteer et
# etiquette les bras SkinTokens en jambes (hanche a y~0, pieds y<0). Ici :
# jambes = chaines qui descendent sous la hanche, tete = chaine centrale
# haute, bras = chaines partant du haut du torse. Cles = noms en minuscules
# (contrat du parametre target_table).
# ---------------------------------------------------------------------------
def _build_humanoid_target_table(rig_glb_path: str):
    import numpy as np
    import anytop_retarget as ar
    gltf, _j, bin_blob = ar._read_glb(rig_glb_path)
    skin = gltf["skins"][0]
    joints = list(skin["joints"])
    jset = set(joints)
    nodes = gltf["nodes"]
    parent = {}
    for i, n in enumerate(nodes):
        for c in n.get("children", []):
            parent[c] = i
    ibm = ar._read_accessor_floats(gltf, bin_blob, skin["inverseBindMatrices"])
    ibm = np.asarray(ibm).reshape(-1, 4, 4)
    W = {}
    for k, j in enumerate(joints):
        W[j] = np.linalg.inv(ibm[k].T)[:3, 3]

    def nm(j):
        return (nodes[j].get("name") or f"node{j}").lower()

    kids = {j: [c for c in nodes[j].get("children", []) if c in jset] for j in joints}
    roots = [j for j in joints if parent.get(j) not in jset]
    if not roots:
        return None
    root = roots[0]
    hipY, hipX = float(W[root][1]), float(W[root][0])
    ys = [float(W[j][1]) for j in joints]
    span = max(1e-6, max(ys) - min(ys))

    table = {nm(root): ("hip", None, 0)}
    # chaines simples : de chaque feuille jusqu'au premier embranchement
    chains = []
    for leaf in [j for j in joints if not kids[j]]:
        path, cur = [leaf], leaf
        while True:
            p = parent.get(cur)
            if p not in jset or len(kids[p]) > 1 or p == root:
                break
            path.append(p)
            cur = p
        path.reverse()
        chains.append(path)

    classified = set()

    def _mark(j, role, side, idx):
        table[nm(j)] = (role, side, idx)
        classified.add(j)

    ext_starts = []   # (premier os de chaine, role, side, prochain idx)
    for path in chains:
        leaf = path[-1]
        ly, lx = float(W[leaf][1]), float(W[leaf][0])
        startY = float(W[path[0]][1])
        mx = float(np.mean([W[j][0] for j in path]))
        side = "l" if mx > hipX else "r"
        if ly < hipY - 0.25 * span:                       # jambe
            idx = 4
            for j in reversed(path):
                _mark(j, "leg", side, max(1, idx))
                idx -= 1
            ext_starts.append((path[0], "leg", side, idx))
        elif ly > hipY + 0.35 * span and abs(lx - hipX) < 0.2 * span:  # cou/tete
            _mark(leaf, "head", None, 0)
            for i, j in enumerate(path[:-1]):
                _mark(j, "neck", None, i + 1)
        elif startY > hipY + 0.3 * span:                  # bras
            idx = 3
            for j in reversed(path):
                _mark(j, "arm", side, max(0, idx))
                idx -= 1
            ext_starts.append((path[0], "arm", side, idx))
        # sinon : helper pelvien etc. -> ignore

    # Extension vers le haut : un pied a 2 feuilles (orteil+talon) -> le
    # noeud de branche au pied laisse cuisse/genou/cheville hors des
    # chaines feuille->branche. On remonte tant que le parent est un os
    # de skin non classe, sous l'epaule/la hanche selon le membre.
    for start, role, side, idx in ext_starts:
        cur = parent.get(start)
        while (cur in jset and cur != root and cur not in classified
               and idx >= (1 if role == "leg" else 0)):
            cy = float(W[cur][1])
            if role == "leg" and cy > hipY + 0.08 * span:
                break     # remonte au bassin (tete de femur souvent > hanche)
            if role == "arm" and abs(float(W[cur][0]) - hipX) < 0.05 * span:
                break                                     # remonte au torse
            _mark(cur, role, side, max(1 if role == "leg" else 0, idx))
            idx -= 1
            cur = parent.get(cur)

    # colonne : nodes centraux restants au-dessus de la hanche, ordre par Y
    spine = [j for j in joints if nm(j) not in table
             and abs(float(W[j][0]) - hipX) < 0.12 * span
             and float(W[j][1]) > hipY + 0.05 * span]
    for k, j in enumerate(sorted(spine, key=lambda j: float(W[j][1]))):
        table[nm(j)] = ("spine", None, k + 1)

    roles = {}
    for v in table.values():
        roles[v[0]] = roles.get(v[0], 0) + 1
    _log("info", f"target_table humanoide: {roles}")
    # metriques pour l'echelle de translation racine
    lens = []
    for j in joints:
        p = parent.get(j)
        if p in jset:
            l = float(np.linalg.norm(W[j] - W[p]))
            if l > 1e-6:
                lens.append(l)
    tgt_mbl = float(np.median(lens)) if lens else 0.0
    # sanite : sans 2 bras + 2 jambes on laisse le classifieur geometrique
    legs = sum(1 for v in table.values() if v[0] == "leg")
    arms = sum(1 for v in table.values() if v[0] == "arm")
    if legs < 4 or arms < 4:
        _log("warn", "table incomplete -> fallback classifieur geometrique")
        return None, span, tgt_mbl
    return table, span, tgt_mbl


def _fix_root_pos(motion, bvh_path: str):
    """Kimodo met la trajectoire sur Hips (le Root BVH reste statique) ;
    _parse_bvh ne lit que les canaux position du Root -> root_pos plat.
    On y substitue la position monde de Hips par frame (bvhio).
    Retourne la hauteur (span Y) du squelette source, ou None."""
    import numpy as np
    src_span = None
    try:
        import bvhio
        root = bvhio.readAsHierarchy(bvh_path)
        joints = [j for j, _, _ in root.layout()]
        root.loadPose(0)
        ys = [float(j.PositionWorld[1]) for j in joints]
        src_span = max(ys) - min(ys)
        rp = np.asarray(motion.get("root_pos"))
        if rp is not None and rp.size and float(np.ptp(rp, axis=0).max()) > 1e-3:
            return src_span  # le root bouge deja
        hips = None
        for j in joints:
            if j.Name.lower() in ("hips", "pelvis", "hip"):
                hips = j
                break
        if hips is None:
            return src_span
        n = motion["n_frames"]
        traj = np.empty((n, 3), dtype=np.float64)
        for f in range(n):
            root.loadPose(f)
            traj[f] = tuple(hips.PositionWorld)
        motion["root_pos"] = traj
        _log("info", f"root_pos <- trajectoire Hips (deplacement "
                     f"{float(np.linalg.norm(traj[-1]-traj[0])):.1f} unites BVH)")
    except Exception as e:
        _log("warn", f"fix root_pos saute ({type(e).__name__}: {e})")
    return src_span


def retarget(bvh_path: str, rig_glb: str, out_glb: str, clip_name: str):
    sys.path.insert(0, str(HERE))
    # Humanoide->humanoide : pas d'amortissement (le défaut 0.25 vient du
    # cas dragon 142->47 os) — surchargable via KIMODO_OUTPUT_DAMP.
    os.environ.setdefault("ANYTOP_OUTPUT_DAMP",
                          os.environ.get("KIMODO_OUTPUT_DAMP", "1.0"))
    import numpy as np
    import anytop_retarget as ar
    _log("info", f"retarget {os.path.basename(bvh_path)} -> {os.path.basename(rig_glb)}")
    motion = ar._parse_bvh(bvh_path)
    src_span = _fix_root_pos(motion, bvh_path)
    target_table, tgt_span, tgt_mbl = _build_humanoid_target_table(rig_glb)

    # Le moteur echelonne la translation racine par le ratio des LONGUEURS
    # D'OS medianes — la mediane SOMA est ecrasee par les ~40 mini-os de
    # doigts, ce qui sur-echelonne la marche (x4). On pre-compense pour que
    # l'echelle nette soit le ratio des HAUTEURS de squelette.
    offs, pars = motion.get("offsets"), motion.get("parents")
    src_lens = [float(np.linalg.norm(offs[j])) for j in range(len(offs))
                if int(pars[j]) >= 0 and float(np.linalg.norm(offs[j])) > 1e-6]
    src_mbl = float(np.median(src_lens)) if src_lens else 0.0
    if (src_span and src_mbl > 1e-6 and tgt_mbl > 1e-6 and tgt_span > 1e-6):
        mbl_scale = tgt_mbl / src_mbl
        height_scale = tgt_span / src_span
        k = height_scale / mbl_scale
        rp = np.asarray(motion["root_pos"], dtype=np.float64)
        motion["root_pos"] = rp[0:1] + (rp - rp[0:1]) * k
        _log("info", f"root scale pre-compense: hauteur={height_scale:.4f} "
                     f"mbl={mbl_scale:.4f} k={k:.3f}")
    _progress(75)
    ar.retarget_motion_to_rig(
        rig_glb_path=rig_glb,
        motion=motion,
        out_glb_path=out_glb,
        clip_name=clip_name,
        target_fps=30.0,
        ckpt_family="all",
        source_classifier=_classify_soma,
        target_table=target_table,  # table humanoïde géométrique (pas de JSON Puppeteer)
        target_drop_re=None,
    )
    _progress(95)


def main():
    ap = argparse.ArgumentParser(description="Kimodo text->anim sur rig SkinTokens")
    ap.add_argument("--rig", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--prompt", default="a person walks forward.")
    ap.add_argument("--clip-name", default="kimodo")
    ap.add_argument("--bvh", default=None,
                    help="BVH SOMA existant (saute la génération)")
    args = ap.parse_args()

    if not os.path.isfile(args.rig):
        _log("error", f"rig introuvable: {args.rig}")
        sys.exit(1)

    if args.bvh:
        bvh = args.bvh
        _progress(60)
    else:
        with tempfile.TemporaryDirectory(prefix="kimodo_") as td:
            stem = os.path.join(td, "gen")
            bvh = generate_bvh(args.prompt, stem)
            retarget(bvh, args.rig, args.out, args.clip_name)
            _progress(99)
            print(f"KIMODO_OK: {args.out}", flush=True)
            return

    retarget(bvh, args.rig, args.out, args.clip_name)
    _progress(99)
    print(f"KIMODO_OK: {args.out}", flush=True)


if __name__ == "__main__":
    main()
