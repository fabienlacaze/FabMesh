"""puppeteer_semantic_extractor.py

Extraction de labels semantiques pour chaque joint Puppeteer SANS
modifier le source de Puppeteer.

CONCLUSION DES FINDINGS (3 angles convergents):
  - SkeletonGPT n'a AUCUNE tete semantique. Son vocab = 131 tokens
    (128 bins coord + bos/eos/pad). lm_head ne projette que sur ces 131.
  - La seule information utile a recuperer du forward = embeddings
    cachees du decodeur OPT (1024-D par joint) et attention cross sur
    les 257 tokens Michelangelo de la mesh.
  - Le .txt produit par save_skeleton_to_txt_joint contient deja
    joints/root/hier complets - source de verite pour topologie+coords.

STRATEGIE (3 etages cumulatifs, du plus simple au plus riche):

  ETAGE 1 -- PARSE .txt PUPPETEER (deterministe, zero GPU)
      Lit <run>/<file>_pred.txt -> {root, parents, world_xyz, DFS order}
      Source de verite topologique.

  ETAGE 2 -- RENAMER GEOMETRIQUE (existant, deterministe)
      Reutilise puppeteer_joint_renamer.rename_for_anytop().
      Tier1 = rig_mappings/*.json (humanoides, flying_quadruped...).
      Tier2 = heuristique topologique (chaines, X-symmetrie, Z-hauteur).

  ETAGE 3 -- HOOKS RUNTIME (OPTIONNEL, GPU requis)
      Monkey-patch read-only sur SkeletonGPT.generate pour capturer:
        - hidden_states derniere couche (n_joints, 1024)
        - attention cross sur 257 cond tokens Michelangelo
        - cond tokens eux-memes (257, 768)
      Sauvegarde en .npy alongside _pred.txt pour:
        a) entrainer un classifieur d'ancrage offline (Plan B1 AnyTop)
        b) k-NN cosine contre anchors humanoides/quadrupedes connus

USAGE:
  # Mode passif (zero GPU) - parse une run Puppeteer existante:
  python scripts/puppeteer_semantic_extractor.py \\
      --pred-txt outputs/infer_results/asset_pred.txt \\
      --family humanoid_puppeteer \\
      --out outputs/infer_results/asset.labels.json

  # Mode hook (GPU, run Puppeteer instrumente):
  python scripts/puppeteer_semantic_extractor.py \\
      --hook \\
      --input-path path/to/mesh.glb \\
      --output-dir outputs/instrumented \\
      --family humanoid_puppeteer

  # Mode k-NN sur embeddings (apres avoir construit des anchors):
  python scripts/puppeteer_semantic_extractor.py \\
      --pred-txt outputs/infer_results/asset_pred.txt \\
      --embeds outputs/infer_results/asset_joint_embeds.npy \\
      --anchors scripts/rig_mappings/_puppeteer_anchors/humanoid \\
      --out outputs/infer_results/asset.labels.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
PUPPETEER_DIR = REPO / "external" / "Puppeteer"
SKEL_DIR = PUPPETEER_DIR / "skeleton"
CKPT_PATH = SKEL_DIR / "skeleton_ckpts" / "puppeteer_skeleton_w_diverse_pose.pth"
ANCHORS_DIR = HERE / "rig_mappings" / "_puppeteer_anchors"


# ===========================================================================
# ETAGE 1 -- parse Puppeteer .txt (format RigNet utilise par save_utils.py)
# ===========================================================================
def parse_puppeteer_txt(txt_path: str | Path) -> dict[str, Any]:
    """Parse le fichier <file>_pred.txt produit par
    save_skeleton_to_txt[_joint]. Renvoie un dict avec:
      - name_by_idx: {int -> 'joint0'/'joint1'/...}
      - world_by_idx: {int -> [x, y, z]}
      - parent_by_idx: {int -> int}  (root absent ou root -> -1)
      - root_idx: int
      - dfs_order: list[int]  (root -> ... ordre DFS pre-order)
      - children_by_idx: {int -> list[int]}
    """
    txt_path = Path(txt_path)
    if not txt_path.exists():
        raise FileNotFoundError(f"Puppeteer .txt not found: {txt_path}")

    joints: dict[str, tuple[int, list[float]]] = {}  # name -> (idx, xyz)
    hier: list[tuple[str, str]] = []                 # (parent, child)
    root_name: str | None = None

    for line in txt_path.read_text(encoding="utf-8").splitlines():
        w = line.split()
        if not w:
            continue
        if w[0] == "joints" and len(w) >= 5:
            joints[w[1]] = (len(joints), [float(w[2]), float(w[3]), float(w[4])])
        elif w[0] == "root" and len(w) >= 2:
            root_name = w[1]
        elif w[0] == "hier" and len(w) >= 3:
            hier.append((w[1], w[2]))

    if root_name is None:
        # Fallback: joint qui n'est jamais enfant
        all_parents = {p for p, _ in hier}
        all_children = {c for _, c in hier}
        roots = all_parents - all_children
        if roots:
            root_name = sorted(roots)[0]
        else:
            root_name = next(iter(joints.keys()))

    name_by_idx = {v[0]: k for k, v in joints.items()}
    world_by_idx = {v[0]: v[1] for v in joints.values()}
    parent_by_idx: dict[int, int] = {}
    children_by_idx: dict[int, list[int]] = {i: [] for i in name_by_idx}
    for p_name, c_name in hier:
        if p_name not in joints or c_name not in joints:
            continue
        p_idx = joints[p_name][0]
        c_idx = joints[c_name][0]
        parent_by_idx[c_idx] = p_idx
        children_by_idx[p_idx].append(c_idx)

    root_idx = joints[root_name][0]
    parent_by_idx.setdefault(root_idx, -1)

    # DFS pre-order from root
    dfs_order: list[int] = []
    stack = [root_idx]
    seen: set[int] = set()
    while stack:
        n = stack.pop()
        if n in seen:
            continue
        seen.add(n)
        dfs_order.append(n)
        for c in reversed(children_by_idx.get(n, [])):
            stack.append(c)

    return {
        "name_by_idx": name_by_idx,
        "world_by_idx": world_by_idx,
        "parent_by_idx": parent_by_idx,
        "children_by_idx": children_by_idx,
        "root_idx": root_idx,
        "root_name": root_name,
        "dfs_order": dfs_order,
        "num_joints": len(name_by_idx),
    }


# ===========================================================================
# ETAGE 2 -- delegue au renamer existant (geometrique + rig_mappings JSON)
# ===========================================================================
def label_via_renamer(parsed: dict[str, Any], family: str | None) -> dict[int, str]:
    """Appelle puppeteer_joint_renamer.rename_for_anytop avec la
    topologie parsee. Retourne {joint_idx -> 'Hips'/'Spine01'/...}."""
    sys.path.insert(0, str(HERE))
    try:
        from puppeteer_joint_renamer import rename_for_anytop  # type: ignore
    except Exception as e:
        print(f"[WARN] puppeteer_joint_renamer indisponible: {e}", file=sys.stderr)
        # Fallback minimal: renvoie 'joint{i}' inchange
        return dict(parsed["name_by_idx"])

    joint_idxs = list(parsed["name_by_idx"].keys())
    # convertir world coords en np arrays scalaires (le renamer attend
    # acces direct via indexation)
    world_arr = {i: np.asarray(parsed["world_by_idx"][i], dtype=np.float64)
                 for i in joint_idxs}

    return rename_for_anytop(
        joint_idxs=joint_idxs,
        parent_by_idx=parsed["parent_by_idx"],
        world_by_idx=world_arr,
        name_by_idx=parsed["name_by_idx"],
        rig_mapping_path=family,
    )


# ===========================================================================
# ETAGE 3a -- k-NN cosine sur embeddings vs anchors (offline)
# ===========================================================================
def label_via_anchors(
    joint_embeds_path: str | Path,
    anchors_dir: str | Path,
) -> dict[int, str]:
    """Charge une matrice (N_query, 1024) et fait k-NN cosine vs anchors
    <anchors_dir>/{embeds.npy, labels.json}. Retourne {idx -> label}."""
    anchors_dir = Path(anchors_dir)
    emb_path = anchors_dir / "embeds.npy"
    lbl_path = anchors_dir / "labels.json"
    if not emb_path.exists() or not lbl_path.exists():
        raise FileNotFoundError(
            f"Anchors not found in {anchors_dir}. Need embeds.npy + labels.json."
        )

    A = np.load(emb_path)                       # (N_anchor, 1024)
    L = json.loads(lbl_path.read_text(encoding="utf-8"))  # list[str]

    Q = np.load(joint_embeds_path)              # (N_query, 1024)

    # 2026-06-11 (FabMesh): the dump may save RAW token embeds (T tokens)
    # instead of per-joint averages (J joints). Aggregate query to match
    # anchor's per-joint granularity. bone_per_token=4 is the standard
    # joint_token=True / hier_order=True config of Puppeteer.
    def _per_joint(emb: np.ndarray, target_n: int) -> np.ndarray:
        if emb.shape[0] == target_n:
            return emb
        # Try 4-token grouping first
        if emb.shape[0] % 4 == 0:
            n = emb.shape[0] // 4
            agg = emb.reshape(n, 4, -1).mean(axis=1)
        else:
            n = emb.shape[0] // 4
            if n == 0:
                return emb
            agg = emb[:n*4].reshape(n, 4, -1).mean(axis=1)
        # Pad / truncate to target_n
        if agg.shape[0] == target_n:
            return agg
        if agg.shape[0] < target_n:
            pad = np.tile(agg[-1:], (target_n - agg.shape[0], 1))
            return np.concatenate([agg, pad], axis=0)
        return agg[:target_n]

    A = _per_joint(A, len(L))
    Q = _per_joint(Q, len(L))                  # collapse query tokens too

    A = A / (np.linalg.norm(A, axis=1, keepdims=True) + 1e-9)
    Q = Q / (np.linalg.norm(Q, axis=1, keepdims=True) + 1e-9)

    sims = Q @ A.T                              # (N_query, N_anchor)
    best = sims.argmax(axis=1)
    return {int(i): L[int(j)] for i, j in enumerate(best.tolist())}


# ===========================================================================
# ETAGE 3b -- hook runtime sur SkeletonGPT (GPU, venv Puppeteer requis)
# ===========================================================================
# Buffers globaux pour capturer les tenseurs - lus apres demo.py
_EMB_STEPS: list = []   # list[Tensor]  hidden_states[-1] par step
_ATTN_STEPS: list = []  # list[Tensor]  cross-attn par step
_COND_TOKENS: list = [] # list[Tensor]  (1, 257, 768)


def _install_runtime_hooks() -> None:
    """Monkey-patch SkeletonGPT.generate + encode_latents Michelangelo.
    READ-ONLY: ne modifie aucune logique, capture uniquement."""
    # Ajout des paths Puppeteer
    sys.path.insert(0, str(SKEL_DIR))
    sys.path.insert(0, str(SKEL_DIR / "third_partys" / "Michelangelo"))

    from skeleton_models.skeletongen import SkeletonGPT  # type: ignore

    _orig_generate = SkeletonGPT.generate

    def patched_generate(self, data_dict):
        inner_generate = self.transformer.generate

        def wrapped(**kw):
            kw["output_hidden_states"] = True
            kw["output_attentions"] = True
            kw["return_dict_in_generate"] = True
            out = inner_generate(**kw)
            # hidden_states est tuple sur steps; chacun tuple sur layers
            # On garde la derniere couche -> (B, q_step, 1024)
            try:
                for step in out.hidden_states:
                    _EMB_STEPS.append(step[-1].detach().float().cpu())
                for step in out.attentions:
                    # derniere couche, moyenne sur heads
                    last = step[-1]  # (B, n_heads, q, k)
                    _ATTN_STEPS.append(last.mean(dim=1).detach().float().cpu())
            except Exception as ex:
                print(f"[hook] capture failed: {ex}", file=sys.stderr)
            return out.sequences

        self.transformer.generate = wrapped
        try:
            return _orig_generate(self, data_dict)
        finally:
            self.transformer.generate = inner_generate

    SkeletonGPT.generate = patched_generate

    # Hook Michelangelo encoder pour capter les 257 cond tokens (offline analysis)
    try:
        from third_partys.Michelangelo.michelangelo.models.tsal.asl_pl_module import (  # type: ignore
            AlignedShapeLatentPLModule,
        )
        _orig_enc = AlignedShapeLatentPLModule.encode_latents

        def patched_enc(self, pc):
            out = _orig_enc(self, pc)
            try:
                _COND_TOKENS.append(out.detach().float().cpu())
            except Exception:
                pass
            return out

        AlignedShapeLatentPLModule.encode_latents = patched_enc
    except Exception as e:
        print(f"[hook] Michelangelo encoder hook skipped: {e}", file=sys.stderr)


def _dump_hooks(out_dir: str | Path, file_stem: str) -> dict[str, str]:
    """Apres run, concatene les buffers et ecrit les .npy."""
    import torch
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    paths: dict[str, str] = {}

    if _EMB_STEPS:
        emb = torch.cat(_EMB_STEPS, dim=1)[0].numpy()    # (T_total, 1024)
        # joint_token=True -> bone_per_token=4 (xyz+parent). Drop prefill (=cond_length=257).
        # NB: en mode inputs_embeds, generate ne reemet PAS le prefill dans hidden_states[step]
        # de la meme facon. On garde tout puis on slice par groupes de 4.
        if emb.shape[0] >= 4:
            n_joints = emb.shape[0] // 4
            joint_emb = emb[: n_joints * 4].reshape(n_joints, 4, -1).mean(axis=1)
            p = out_dir / f"{file_stem}_joint_embeds.npy"
            np.save(p, joint_emb)
            paths["joint_embeds"] = str(p)
            print(f"[hook] WROTE {p} shape={joint_emb.shape}")

    if _ATTN_STEPS:
        # concat sur l'axe q
        A = torch.cat(_ATTN_STEPS, dim=1)[0].numpy()      # (T_total, k_total)
        p = out_dir / f"{file_stem}_cond_attention.npy"
        np.save(p, A)
        paths["cond_attention"] = str(p)
        print(f"[hook] WROTE {p} shape={A.shape}")

    if _COND_TOKENS:
        C = _COND_TOKENS[0][0].numpy()                     # (257, 768)
        p = out_dir / f"{file_stem}_cond_tokens.npy"
        np.save(p, C)
        paths["cond_tokens"] = str(p)
        print(f"[hook] WROTE {p} shape={C.shape}")

    return paths


def run_hooked_demo(input_path: str, output_dir: str, save_name: str = "instrumented") -> str:
    """Execute demo.py de Puppeteer avec hooks installes.
    Doit etre lance depuis le venv Puppeteer (torch + flash_attn + ...)."""
    _install_runtime_hooks()

    # Argv pour demo.py
    argv = [
        "demo.py",
        "--input_path", input_path,
        "--pretrained_weights", str(CKPT_PATH),
        "--output_dir", output_dir,
        "--save_name", save_name,
        "--input_pc_num", "8192",
        "--apply_marching_cubes",
        "--joint_token",
        "--seq_shuffle",
    ]
    orig_argv = sys.argv[:]
    orig_cwd = os.getcwd()
    sys.argv = argv
    os.chdir(str(SKEL_DIR))
    try:
        import runpy
        runpy.run_path(str(SKEL_DIR / "demo.py"), run_name="__main__")
    finally:
        sys.argv = orig_argv
        os.chdir(orig_cwd)

    # Dump des buffers
    run_out = Path(output_dir) / save_name
    file_stem = Path(input_path).stem
    _dump_hooks(run_out, file_stem)
    pred_txt = run_out / f"{file_stem}_pred.txt"
    return str(pred_txt)


# ===========================================================================
# Orchestration high-level
# ===========================================================================
def extract_semantics(
    pred_txt: str | Path,
    family: str | None = None,
    joint_embeds: str | Path | None = None,
    anchors_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Pipeline complet (etages 1+2 [+3a si embeds fournis]).
    Retourne dict serialisable JSON."""
    parsed = parse_puppeteer_txt(pred_txt)

    # Etage 2 = renamer geometrique (toujours)
    geom_labels = label_via_renamer(parsed, family)

    # Etage 3a = anchors k-NN (si embeds dispo)
    anchor_labels: dict[int, str] = {}
    if joint_embeds and anchors_dir:
        try:
            anchor_labels = label_via_anchors(joint_embeds, anchors_dir)
        except Exception as e:
            print(f"[WARN] anchor labeling failed: {e}", file=sys.stderr)

    # Fusion: anchors prioritaires si dispo et coherents, sinon geom
    final_labels: dict[int, str] = {}
    for idx in parsed["name_by_idx"]:
        if anchor_labels.get(idx):
            final_labels[idx] = anchor_labels[idx]
        elif geom_labels.get(idx):
            final_labels[idx] = geom_labels[idx]
        else:
            final_labels[idx] = parsed["name_by_idx"][idx]

    return {
        "source_txt": str(pred_txt),
        "family": family,
        "num_joints": parsed["num_joints"],
        "root_idx": parsed["root_idx"],
        "dfs_order": parsed["dfs_order"],
        "parent_by_idx": {str(k): int(v) for k, v in parsed["parent_by_idx"].items()},
        "world_by_idx": {str(k): list(v) for k, v in parsed["world_by_idx"].items()},
        "puppeteer_name_by_idx": {str(k): v for k, v in parsed["name_by_idx"].items()},
        "geometric_labels": {str(k): v for k, v in geom_labels.items()},
        "anchor_labels": {str(k): v for k, v in anchor_labels.items()},
        "labels": {str(k): v for k, v in final_labels.items()},
    }


def build_anchors_from_run(
    pred_txt: str | Path,
    joint_embeds: str | Path,
    manual_labels: list[str],
    out_dir: str | Path,
) -> None:
    """Helper one-shot: a partir d'une run instrumentee + labels manuels
    dans l'ordre joint0..jointN, ecrit embeds.npy + labels.json sous
    out_dir pour servir d'anchor a label_via_anchors()."""
    parsed = parse_puppeteer_txt(pred_txt)
    emb = np.load(joint_embeds)
    n = parsed["num_joints"]
    if emb.shape[0] != n:
        raise ValueError(
            f"embeds {emb.shape[0]} joints != txt {n}. "
            "Tronquer ou re-lancer la run."
        )
    if len(manual_labels) != n:
        raise ValueError(
            f"manual_labels len={len(manual_labels)} != n_joints={n}"
        )
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    np.save(out_dir / "embeds.npy", emb)
    (out_dir / "labels.json").write_text(
        json.dumps(manual_labels, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"[anchors] wrote {out_dir}/embeds.npy + labels.json ({n} joints)")


# ===========================================================================
# CLI
# ===========================================================================
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--pred-txt", type=str, default=None,
                    help="Chemin vers <file>_pred.txt produit par Puppeteer.")
    ap.add_argument("--family", type=str, default=None,
                    help="target_family ou nom rig_mapping (humanoid_puppeteer, flying_quadruped, ...).")
    ap.add_argument("--embeds", type=str, default=None,
                    help="Chemin vers <file>_joint_embeds.npy (etage 3a).")
    ap.add_argument("--anchors", type=str, default=None,
                    help="Repertoire avec embeds.npy + labels.json (etage 3a).")
    ap.add_argument("--out", type=str, default=None,
                    help="Chemin de sortie JSON labels (defaut: <pred-txt>.labels.json).")
    ap.add_argument("--hook", action="store_true",
                    help="Lance Puppeteer demo.py avec hooks (necessite venv GPU).")
    ap.add_argument("--input-path", type=str, default=None,
                    help="Mesh d'entree pour mode --hook.")
    ap.add_argument("--output-dir", type=str, default="outputs/instrumented",
                    help="Repertoire de sortie pour mode --hook.")
    ap.add_argument("--save-name", type=str, default="instrumented",
                    help="Sous-dossier de --output-dir.")
    ap.add_argument("--build-anchors-from", type=str, default=None,
                    help="JSON {pred_txt, joint_embeds, labels: [...], out_dir}.")
    args = ap.parse_args()

    # Mode build-anchors
    if args.build_anchors_from:
        cfg = json.loads(Path(args.build_anchors_from).read_text(encoding="utf-8"))
        build_anchors_from_run(
            cfg["pred_txt"], cfg["joint_embeds"], cfg["labels"], cfg["out_dir"]
        )
        return 0

    # Mode hook -> run Puppeteer instrumente, puis chaine sur le pred_txt produit
    pred_txt = args.pred_txt
    embeds = args.embeds
    if args.hook:
        if not args.input_path:
            ap.error("--hook requires --input-path")
        pred_txt = run_hooked_demo(args.input_path, args.output_dir, args.save_name)
        # auto-detection embeds dans le meme dossier
        stem = Path(args.input_path).stem
        cand = Path(args.output_dir) / args.save_name / f"{stem}_joint_embeds.npy"
        if cand.exists() and not embeds:
            embeds = str(cand)

    if not pred_txt:
        ap.error("Need --pred-txt (or --hook).")

    result = extract_semantics(
        pred_txt=pred_txt,
        family=args.family,
        joint_embeds=embeds,
        anchors_dir=args.anchors,
    )

    out_path = args.out or (str(pred_txt) + ".labels.json")
    Path(out_path).write_text(
        json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"[OK] wrote {out_path}")
    print(f"     {result['num_joints']} joints | family={result['family']}")
    print(f"     sample labels: "
          + ", ".join(f"{k}:{v}" for k, v in list(result["labels"].items())[:6]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
