"""FabMesh Auto-Rig Orchestrator.

Two-stage pipeline that replaces the broken ARMATURE_AUTO + manual skinning
fallback with high-quality voxel heat diffusion weights:

  Stage 1 (system Python): run voxel_heat_skinning to compute per-vertex
           per-bone weights and save them to a temp NPZ file.
  Stage 2 (Blender):       import mesh + template FBX, scale/align, load
           precomputed weights, assign vertex groups, retarget animations,
           export GLB.

Usage:
    python fabmesh_autorig.py <mesh_path> <template_name> <output_glb> <blender_exe> [landmarks_json]

Requires: numpy, scipy, trimesh (system Python only — NOT Blender's Python).
"""

import sys
import os
import json
import subprocess
import tempfile
import time

import numpy as np

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
TEMPLATES_DIR = os.path.join(SCRIPT_DIR, "rig_templates")


# ---------------------------------------------------------------------------
# Template loading (shared with auto_rig_bridge.py)
# ---------------------------------------------------------------------------

def load_template(name):
    """Load a template from the SKM registry or direct file lookup."""
    registry_path = os.path.join(TEMPLATES_DIR, "skm", "registry.json")
    if os.path.exists(registry_path):
        with open(registry_path, "r", encoding="utf-8") as f:
            reg = json.load(f)
        for t in reg.get("skm_templates", []):
            if t.get("id") == name:
                fbx_path = os.path.join(TEMPLATES_DIR, t["fbx"])
                if os.path.exists(fbx_path):
                    return {
                        "type": "fbx",
                        "path": fbx_path,
                        "name": name,
                        "registry": t,
                    }
        for t in reg.get("generic_templates", []):
            if t.get("id") == name:
                json_path = os.path.join(TEMPLATES_DIR, t["json"])
                if os.path.exists(json_path):
                    with open(json_path, "r", encoding="utf-8") as jf:
                        data = json.load(jf)
                    data["type"] = "json"
                    return data

    # Direct file fallback
    for ext in (".fbx", ".FBX"):
        p = os.path.join(TEMPLATES_DIR, f"{name}{ext}")
        if os.path.exists(p):
            return {"type": "fbx", "path": p, "name": name}
    raise FileNotFoundError(f"Template not found: {name}")


# ---------------------------------------------------------------------------
# Bones JSON loading
# ---------------------------------------------------------------------------

def load_bones_json(template_name):
    """Load the bones JSON for the given template.

    Searches for <template_name>.bones.json in the skm/ directory.
    Returns a list of bone dicts: [{name, head, tail, parent}, ...].
    """
    candidates = [
        os.path.join(TEMPLATES_DIR, "skm", f"{template_name}.bones.json"),
        # Some templates use the FBX filename as prefix
    ]
    # Also scan for <FBX_name>.bones.json
    skm_dir = os.path.join(TEMPLATES_DIR, "skm")
    if os.path.isdir(skm_dir):
        for fname in os.listdir(skm_dir):
            if fname.endswith(".bones.json"):
                candidates.append(os.path.join(skm_dir, fname))

    for path in candidates:
        if not os.path.exists(path):
            continue
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        bones = data.get("bones", data if isinstance(data, list) else [])
        if bones:
            return bones, path

    raise FileNotFoundError(
        f"No bones JSON found for template '{template_name}' in {skm_dir}"
    )


# ---------------------------------------------------------------------------
# Stage 1: Compute voxel heat diffusion weights (system Python)
# ---------------------------------------------------------------------------

def compute_weights_stage(mesh_path, template_name, landmarks=None,
                          grid_resolution=64):
    """Run voxel_heat_skinning on the mesh with joint positions from landmarks.

    NEW APPROACH (landmark-driven):
      - Place each bone's head/tail at the corresponding landmark positions
      - Bones without landmark entries get interpolated from parent/child
      - Compute weights using these landmark-aligned positions
      - No T-pose / A-pose mismatch — positions match the actual mesh pose

    Returns path to the saved NPZ file containing:
        - weights: (N, J) float32
        - bone_names: list of bone name strings
        - joint_positions: (J, 3) float64  (at landmark positions)
        - joint_tails: (J, 3) float64  (tail positions for Blender)
    """
    print(f"AUTORIG-ORCH: Stage 1 — landmark-driven bone placement for "
          f"'{template_name}'", flush=True)

    # ------------------------------------------------------------------
    # Load bones JSON (for hierarchy, names, parent info, template proportions)
    # ------------------------------------------------------------------
    bones_list, bones_path = load_bones_json(template_name)
    print(f"AUTORIG-ORCH: loaded {len(bones_list)} bones from {bones_path}",
          flush=True)

    NON_DEFORM_PREFIXES = ("ik_", "ctrl_", "target_", "pole_")
    deform_bones = [
        b for b in bones_list
        if not any(b["name"].lower().startswith(p) for p in NON_DEFORM_PREFIXES)
    ]
    print(f"AUTORIG-ORCH: {len(deform_bones)} deform bones (filtered from "
          f"{len(bones_list)})", flush=True)

    bone_names = [b["name"] for b in deform_bones]

    # Build lookup by name for template bone data
    tpl_by_name = {b["name"]: b for b in deform_bones}

    # ------------------------------------------------------------------
    # Load mesh
    # ------------------------------------------------------------------
    import trimesh
    scene_or_mesh = trimesh.load(mesh_path, force="mesh", process=False)
    if isinstance(scene_or_mesh, trimesh.Scene):
        mesh = trimesh.util.concatenate(
            [g for g in scene_or_mesh.geometry.values()
             if isinstance(g, trimesh.Trimesh)]
        )
    else:
        mesh = scene_or_mesh

    vertices = np.array(mesh.vertices, dtype=np.float64)
    faces = np.array(mesh.faces, dtype=np.int64)
    m_min = vertices.min(axis=0)
    m_max = vertices.max(axis=0)
    m_size = m_max - m_min

    print(f"AUTORIG-ORCH: mesh bbox {m_min} .. {m_max}  size={m_size}",
          flush=True)

    # ------------------------------------------------------------------
    # Load landmarks
    # ------------------------------------------------------------------
    if not landmarks or not os.path.exists(landmarks):
        raise FileNotFoundError(
            f"Landmarks JSON required for landmark-driven rigging: {landmarks}"
        )

    with open(landmarks, "r", encoding="utf-8") as f:
        lm_raw = json.load(f)

    # Landmarks may be normalized (0..1 in the THREE.js mesh bbox) or world-space.
    # If normalized (__normalized__: true), remap to world using the mesh bbox.
    is_normalized = lm_raw.pop("__normalized__", False)
    lm = {}
    for k, v in lm_raw.items():
        if k.startswith("__"):
            continue
        if not isinstance(v, (list, tuple)) or len(v) != 3:
            continue
        pos = np.array(v, dtype=np.float64)
        if is_normalized:
            # THREE.js is Y-up: (x, y, z) where y=up
            # trimesh loads GLB as-is (Y-up), so mesh bbox matches THREE.js
            pos = m_min + pos * m_size
        lm[k] = pos
    print(f"AUTORIG-ORCH: denormalized={is_normalized}", flush=True)
    head_y = lm.get("head", np.zeros(3))[1]
    print(f"AUTORIG-ORCH: landmarks loaded — {len(lm)} points, "
          f"head.Y={head_y:.3f}  mesh maxY={m_max[1]:.3f}", flush=True)
    if abs(head_y - m_max[1]) > m_size[1] * 0.3:
        print("AUTORIG-ORCH: WARNING — head landmark far from mesh top; "
              "coordinate system mismatch?", flush=True)

    # ------------------------------------------------------------------
    # Landmark → bone mapping table
    # ------------------------------------------------------------------
    # (bone_name, head_landmark, tail_landmark)
    # None tail → computed from offsets
    LANDMARK_TO_BONE = [
        ('pelvis',     'hips',       'spine_mid'),
        ('spine_01',   'hips',       'spine_mid'),
        ('spine_02',   'spine_mid',  'spine_top'),
        ('spine_03',   'spine_top',  'neck'),
        ('spine_04',   'spine_top',  'neck'),
        ('spine_05',   'spine_top',  'neck'),
        ('neck_01',    'neck',       'head'),
        ('neck_02',    'neck',       'head'),
        ('head',       'head',       None),
        ('clavicle_l', 'spine_top',  'shoulder_l'),
        ('clavicle_r', 'spine_top',  'shoulder_r'),
        ('upperarm_l', 'shoulder_l', 'elbow_l'),
        ('upperarm_r', 'shoulder_r', 'elbow_r'),
        ('lowerarm_l', 'elbow_l',    'hand_l'),
        ('lowerarm_r', 'elbow_r',    'hand_r'),
        ('hand_l',     'hand_l',     None),
        ('hand_r',     'hand_r',     None),
        ('thigh_l',    'hip_l',      'knee_l'),
        ('thigh_r',    'hip_r',      'knee_r'),
        ('calf_l',     'knee_l',     'ankle_l'),
        ('calf_r',     'knee_r',     'ankle_r'),
        ('foot_l',     'ankle_l',    'foot_l'),
        ('foot_r',     'ankle_r',    'foot_r'),
    ]
    lm_map = {entry[0]: (entry[1], entry[2]) for entry in LANDMARK_TO_BONE}

    # ------------------------------------------------------------------
    # Compute template proportions for interpolation of unmapped bones
    # ------------------------------------------------------------------
    # For each bone in the template, store head/tail as numpy arrays and
    # the vector from parent.head to this bone.head / bone.tail
    tpl_heads = {b["name"]: np.array(b["head"], dtype=np.float64)
                 for b in deform_bones}
    tpl_tails = {b["name"]: np.array(b["tail"], dtype=np.float64)
                 for b in deform_bones}

    # ------------------------------------------------------------------
    # Place bones at landmark positions
    # ------------------------------------------------------------------
    joint_heads = np.zeros((len(deform_bones), 3), dtype=np.float64)
    joint_tails = np.zeros((len(deform_bones), 3), dtype=np.float64)

    # First pass: place all bones that have direct landmark mappings
    placed = set()
    for i, bname in enumerate(bone_names):
        if bname not in lm_map:
            continue
        head_lm, tail_lm = lm_map[bname]
        if head_lm not in lm:
            print(f"AUTORIG-ORCH: WARNING — landmark '{head_lm}' not found "
                  f"for bone '{bname}'", flush=True)
            continue

        joint_heads[i] = lm[head_lm]

        if tail_lm is not None and tail_lm in lm:
            joint_tails[i] = lm[tail_lm]
        elif bname == 'head':
            # Head bone: tail = head + small upward offset
            head_to_top = m_max[1] - lm['head'][1]
            offset_up = max(head_to_top * 0.5, 0.05)
            joint_tails[i] = lm['head'] + np.array([0, offset_up, 0])
        elif bname in ('hand_l', 'hand_r'):
            # Hand bone: tail = head + forward/down offset from template proportion
            tpl_h = tpl_heads.get(bname, np.zeros(3))
            tpl_t = tpl_tails.get(bname, np.zeros(3))
            tpl_len = np.linalg.norm(tpl_t - tpl_h)
            # Scale template bone length proportionally to mesh height
            tpl_all_pts = np.array([b["head"] for b in bones_list]
                                   + [b["tail"] for b in bones_list])
            tpl_height = tpl_all_pts[:, 1].max() - tpl_all_pts[:, 1].min()
            if tpl_height < 1e-6:
                tpl_height = 1.0
            scale = m_size[1] / tpl_height
            direction = tpl_t - tpl_h
            direction_norm = direction / max(np.linalg.norm(direction), 1e-8)
            joint_tails[i] = lm[head_lm] + direction_norm * tpl_len * scale
        else:
            # Fallback: small offset along parent-to-head direction
            joint_tails[i] = joint_heads[i] + np.array([0, 0.02, 0])

        placed.add(bname)

    print(f"AUTORIG-ORCH: placed {len(placed)} bones from landmarks", flush=True)

    # ------------------------------------------------------------------
    # Second pass: interpolate unmapped bones from their parent chain
    # ------------------------------------------------------------------
    # For bones NOT in the landmark map (twist, share, fingers, facial, etc.),
    # find the nearest ancestor that IS placed, and use the template's
    # proportional offset from that ancestor.

    # Compute template bounding box for global scale factor
    tpl_all_pts = np.array([b["head"] for b in bones_list]
                           + [b["tail"] for b in bones_list],
                           dtype=np.float64)
    tpl_height = tpl_all_pts[:, 1].max() - tpl_all_pts[:, 1].min()
    if tpl_height < 1e-6:
        tpl_height = 1.0
    global_scale = m_size[1] / tpl_height

    def _find_placed_ancestor(bname):
        """Walk up the parent chain to find the first placed bone."""
        visited = set()
        cur = bname
        while cur:
            if cur in placed:
                return cur
            visited.add(cur)
            b = tpl_by_name.get(cur)
            if b is None:
                break
            cur = b.get("parent")
            if cur in visited:
                break
        return None

    interpolated = 0
    for i, bname in enumerate(bone_names):
        if bname in placed:
            continue

        ancestor = _find_placed_ancestor(bname)
        if ancestor is None:
            # Last resort: place at mesh center
            joint_heads[i] = np.array([
                (m_min[0] + m_max[0]) / 2,
                (m_min[1] + m_max[1]) / 2,
                (m_min[2] + m_max[2]) / 2,
            ])
            joint_tails[i] = joint_heads[i] + np.array([0, 0.01, 0])
            continue

        anc_idx = bone_names.index(ancestor)
        anc_tpl_head = tpl_heads[ancestor]
        anc_placed_head = joint_heads[anc_idx]

        # Offset from ancestor in template space, scaled to mesh space
        bone_tpl_head = tpl_heads[bname]
        bone_tpl_tail = tpl_tails[bname]
        offset_head = (bone_tpl_head - anc_tpl_head) * global_scale
        offset_tail = (bone_tpl_tail - anc_tpl_head) * global_scale

        joint_heads[i] = anc_placed_head + offset_head
        joint_tails[i] = anc_placed_head + offset_tail
        interpolated += 1

    print(f"AUTORIG-ORCH: interpolated {interpolated} bones from template "
          f"proportions", flush=True)

    # ------------------------------------------------------------------
    # Sanity check: joints should be within or near the mesh bbox
    # ------------------------------------------------------------------
    jmin = joint_heads.min(axis=0)
    jmax = joint_heads.max(axis=0)
    print(f"AUTORIG-ORCH: joint heads bbox: {jmin} .. {jmax}", flush=True)

    # ------------------------------------------------------------------
    # Run voxel heat diffusion skinning
    # ------------------------------------------------------------------
    print(f"AUTORIG-ORCH: computing voxel heat skinning "
          f"(grid={grid_resolution})...", flush=True)
    t0 = time.time()

    from voxel_heat_skinning import compute_skin_weights
    weights = compute_skin_weights(
        vertices, faces, joint_heads,
        grid_resolution=grid_resolution,
        verbose=True,
    )
    elapsed = time.time() - t0
    print(f"AUTORIG-ORCH: skinning done in {elapsed:.1f}s  "
          f"weights shape={weights.shape}", flush=True)

    # ------------------------------------------------------------------
    # Save to NPZ
    # ------------------------------------------------------------------
    npz_fd, npz_path = tempfile.mkstemp(suffix=".npz", prefix="fabmesh_skin_")
    os.close(npz_fd)
    np.savez_compressed(
        npz_path,
        weights=weights.astype(np.float32),
        bone_names=np.array(bone_names, dtype=object),
        joint_positions=joint_heads,
        joint_tails=joint_tails,
        landmark_driven=True,
    )
    npz_size = os.path.getsize(npz_path)
    print(f"AUTORIG-ORCH: saved weights to {npz_path} ({npz_size} bytes)",
          flush=True)

    return npz_path


# ---------------------------------------------------------------------------
# Stage 2: Run Blender with blender_assemble_rig.py
# ---------------------------------------------------------------------------

def run_blender_stage(blender_exe, mesh_path, template_name, template_fbx_path,
                      output_glb, npz_path, landmarks_json_path=None):
    """Invoke Blender in background mode with the assembly script."""
    assemble_script = os.path.join(SCRIPT_DIR, "blender_assemble_rig.py")
    if not os.path.exists(assemble_script):
        raise FileNotFoundError(f"Assembly script not found: {assemble_script}")

    # Resolve animation directory
    anim_dir = os.path.join(TEMPLATES_DIR, "animations", template_name)
    if not os.path.isdir(anim_dir):
        anim_dir = ""

    # Build argument list that the Blender script reads from sys.argv
    # Blender strips its own args before '--', everything after goes to the script
    cmd = [
        blender_exe, "--background", "--python", assemble_script,
        "--",
        mesh_path,
        template_fbx_path,
        output_glb,
        npz_path,
        anim_dir,
        landmarks_json_path or "",
    ]

    print(f"AUTORIG-ORCH: Stage 2 — running Blender...", flush=True)
    print(f"AUTORIG-ORCH: cmd = {' '.join(cmd[:6])} ... ", flush=True)

    keywords = (
        "AUTORIG", "Error", "ERROR", "Traceback", "  File ",
        "Exception", "raise ", "ValueError", "TypeError",
        "AttributeError", "RuntimeError",
    )
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    stdout_tail = []
    try:
        for line in iter(proc.stdout.readline, ""):
            if not line:
                break
            line = line.rstrip()
            stdout_tail.append(line)
            if len(stdout_tail) > 300:
                stdout_tail.pop(0)
            if any(k in line for k in keywords):
                print(line, flush=True)
        proc.wait(timeout=600)
    except subprocess.TimeoutExpired:
        print("AUTORIG-ORCH: ERROR — Blender timed out after 600s", flush=True)
        try:
            proc.kill()
        except Exception:
            pass
        return False
    finally:
        try:
            proc.stdout.close()
        except Exception:
            pass

    if proc.returncode != 0:
        print(f"AUTORIG-ORCH: ERROR — Blender exited with code "
              f"{proc.returncode}", flush=True)
        print("=== STDOUT (tail) ===")
        print("\n".join(stdout_tail[-60:]))
        return False

    if not os.path.exists(output_glb):
        print("AUTORIG-ORCH: ERROR — output GLB not created", flush=True)
        print("=== STDOUT (tail) ===")
        print("\n".join(stdout_tail[-80:]))
        return False

    size = os.path.getsize(output_glb)
    print(f"AUTORIG-ORCH: SUCCESS — {output_glb} ({size} bytes)", flush=True)
    return True


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    if len(sys.argv) < 5:
        print("Usage: python fabmesh_autorig.py <mesh_path> <template_name> "
              "<output_glb> <blender_exe> [landmarks.json]")
        sys.exit(1)

    mesh_path = os.path.abspath(sys.argv[1])
    template_name = sys.argv[2]
    output_glb = os.path.abspath(sys.argv[3])
    blender_exe = sys.argv[4]
    landmarks_json_path = sys.argv[5] if len(sys.argv) > 5 else None

    if not os.path.exists(mesh_path):
        print(f"AUTORIG-ORCH: ERROR — mesh not found: {mesh_path}")
        sys.exit(1)
    if not os.path.exists(blender_exe):
        print(f"AUTORIG-ORCH: ERROR — Blender not found: {blender_exe}")
        sys.exit(1)

    # Load template metadata
    try:
        template = load_template(template_name)
    except Exception as e:
        print(f"AUTORIG-ORCH: ERROR — {e}")
        sys.exit(1)

    if template.get("type") != "fbx":
        print(f"AUTORIG-ORCH: ERROR — only FBX templates are supported by "
              f"the new pipeline (got type={template.get('type')})")
        sys.exit(1)

    template_fbx_path = template["path"]
    print(f"AUTORIG-ORCH: template '{template_name}' -> {template_fbx_path}",
          flush=True)

    # Stage 1: compute weights
    t0 = time.time()
    try:
        npz_path = compute_weights_stage(
            mesh_path, template_name,
            landmarks=landmarks_json_path,
            grid_resolution=64,
        )
    except Exception as e:
        print(f"AUTORIG-ORCH: Stage 1 FAILED — {e}", flush=True)
        import traceback
        traceback.print_exc()
        sys.exit(1)
    print(f"AUTORIG-ORCH: Stage 1 completed in {time.time()-t0:.1f}s",
          flush=True)

    # Stage 2: Blender assembly
    t1 = time.time()
    success = run_blender_stage(
        blender_exe, mesh_path, template_name, template_fbx_path,
        output_glb, npz_path, landmarks_json_path,
    )
    print(f"AUTORIG-ORCH: Stage 2 completed in {time.time()-t1:.1f}s",
          flush=True)

    # Cleanup temp NPZ
    try:
        os.unlink(npz_path)
    except Exception:
        pass

    if not success:
        sys.exit(1)

    total = time.time() - t0
    print(f"AUTORIG-ORCH: total pipeline time: {total:.1f}s", flush=True)


if __name__ == "__main__":
    main()
