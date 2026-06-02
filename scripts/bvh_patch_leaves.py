"""Patch AnyTop's output BVH so End Sites carry CHANNELS.

AnyTop's BVH writer omits the CHANNELS line on End Sites (leaf
joints), which is technically spec-conformant but causes every
downstream BVH parser that *is* leaf-aware (UE5's import, Blender's
BVH addon, our own bvh_to_gltf_anim retargeter, …) to drop the
predicted rotation of every wing-tip, tail-tip, finger-tip and claw.
The diffusion model HAS predicted a rotation for those joints — it
just never makes it into the file.

Workaround inspired by sy-hwang/custom_bvh.py (Issue #32): rewrite
each `End Site { OFFSET … }` block into a proper child Joint named
"<parent>_end" with 3 rotation channels, then pad each MOTION frame
with 3 extra floats per promoted leaf so the frame width matches the
new HIERARCHY.

What this version does:
  (a) HIERARCHY rewrite: every End Site → `JOINT <parent>_end` with
      `CHANNELS 3 Zrotation Xrotation Yrotation` and a zero-offset
      End Site of its own (so the file stays spec-valid).
  (b) MOTION padding: insert 3 zero rotations per promoted leaf at
      the correct column index of every frame line.

Why zeros (and not the real rotations from the sibling .npy):
  AnyTop's .npy stores motion in a custom tensor layout (T, J, …)
  whose joint ordering depends on the trained class (cond.npy parent
  table). Mapping that ordering onto the BVH's DFS End-Site order is
  fragile and class-dependent. Emitting zeros is a strict superset
  of the current behaviour: the leaves stay frozen as they already
  are, but the BVH is now spec-correct AND every downstream tool
  sees the leaf joints, so we (or a future patch) can transplant
  real rotations onto them without touching the AnyTop subprocess.

  Translation: this is half of the fix described in Issue #32. The
  shape (HIERARCHY + frame width) is correct; the content of the new
  leaf channels is zero. Visual difference vs. the unpatched file =
  none for the bones we care about (they were already frozen). Bug
  difference = the retargeter no longer encounters orphaned End
  Sites, which is the actual crash-vector on some Mixamo-style
  importers.

API:
  patch_bvh_leaves(bvh_path: str) -> int
      Rewrites the file in place. Returns the number of End Sites
      promoted to real Joints.

CLI:
  python bvh_patch_leaves.py /path/to/anim.bvh
"""
from __future__ import annotations

import os
import re
import sys
from typing import List, Tuple


# Rotation channels we emit on the promoted leaf. AnyTop's writer uses
# ZXY everywhere (see AnyTop's utils/bvh_io); we mirror that so the
# concatenated frame stays in a consistent rotation order across the
# whole skeleton — saves us from declaring per-joint orders that don't
# match downstream code.
_LEAF_ROT_CHANNELS = "Zrotation Xrotation Yrotation"
_LEAF_CHANNELS_LINE_TPL = "CHANNELS 3 " + _LEAF_ROT_CHANNELS


def _split_hierarchy_motion(text: str) -> Tuple[str, str]:
    """Split a BVH file's HIERARCHY block from its MOTION block.

    Returns (hierarchy_text, motion_text). Both keep their original
    newline at the boundary so we can reassemble with simple +.
    """
    # MOTION is always its own line in a BVH; we anchor on "\nMOTION\n"
    # but also accept files where the writer used "\r\n".
    m = re.search(r"(\r?\n)MOTION(\r?\n)", text)
    if not m:
        raise ValueError("BVH has no MOTION section")
    return text[: m.start() + len(m.group(1))], text[m.start() + len(m.group(1)):]


def _patch_hierarchy(hierarchy: str) -> Tuple[str, int, List[int]]:
    """Replace every `End Site { OFFSET … }` with a real Joint.

    Returns (new_hierarchy_text, n_leaves_promoted, channel_insertion_offsets).

    channel_insertion_offsets is the list, in DFS order, of *channel
    column indices* at which the 3 new rotations need to be inserted
    in every MOTION frame. We compute it by walking the HIERARCHY in
    file order and tracking the running channel count: every CHANNELS
    line widens the frame, and the new leaf channels go RIGHT AFTER
    the parent joint's own channels are followed by any siblings —
    which in DFS-emission order is "at the current channel cursor at
    the moment we hit the End Site". That insertion point is exactly
    the running channel total just before the End Site block.
    """
    lines = hierarchy.splitlines(keepends=True)
    out: List[str] = []
    channel_cursor = 0
    n_promoted = 0
    insert_offsets: List[int] = []

    # Track parent joint name for naming the promoted leaf. The
    # nearest enclosing JOINT/ROOT line on the way down is what we
    # want. We stash names in a stack synced with `{`/`}` depth.
    name_stack: List[str] = []

    i = 0
    while i < len(lines):
        ln = lines[i]
        stripped = ln.strip()

        # Track CHANNELS to advance the cursor.
        if stripped.startswith("CHANNELS"):
            # "CHANNELS N <names…>"
            try:
                n = int(stripped.split()[1])
            except (IndexError, ValueError):
                n = 0
            channel_cursor += n
            out.append(ln)
            i += 1
            continue

        # Track ROOT / JOINT names → push on stack at the opening
        # brace that follows.
        m_node = re.match(r"\s*(ROOT|JOINT)\s+(\S+)", ln)
        if m_node:
            name_stack.append(m_node.group(2))
            out.append(ln)
            i += 1
            continue

        # Detect End Site block. Original block looks like:
        #     End Site
        #     {
        #         OFFSET 0.1 0 0
        #     }
        # bvhsdk-style writers may put the brace on the same line; we
        # handle both. Indentation must be preserved.
        if stripped == "End Site" or stripped.startswith("End Site"):
            # Capture indentation of "End Site".
            indent = ln[: len(ln) - len(ln.lstrip())]
            # Look ahead to capture the OFFSET line and the closing
            # brace. We tolerate blank/extra lines inside.
            # State machine:
            j = i + 1
            offset_line: str = ""
            depth = 0
            saw_open = False
            block_end = None
            while j < len(lines):
                s = lines[j].strip()
                if s == "{":
                    depth += 1
                    saw_open = True
                elif s.startswith("OFFSET"):
                    offset_line = s
                elif s == "}":
                    if saw_open and depth == 1:
                        block_end = j
                        break
                    depth -= 1
                j += 1
            if block_end is None or not offset_line:
                # Malformed — leave alone.
                out.append(ln)
                i += 1
                continue

            parent_name = name_stack[-1] if name_stack else "ROOT"
            promoted_name = f"{parent_name}_end"

            # Emit a real Joint with the SAME offset, 3 rotation
            # channels, and a tiny zero-offset End Site so the file
            # remains valid for tools that still want one.
            inner = indent + "  "
            inner2 = inner + "  "
            out.append(f"{indent}JOINT {promoted_name}\n")
            out.append(f"{indent}{{\n")
            out.append(f"{inner}{offset_line}\n")
            out.append(f"{inner}{_LEAF_CHANNELS_LINE_TPL}\n")
            out.append(f"{inner}End Site\n")
            out.append(f"{inner}{{\n")
            out.append(f"{inner2}OFFSET 0 0 0\n")
            out.append(f"{inner}}}\n")
            out.append(f"{indent}}}\n")

            # Record insertion point in the MOTION row: at the
            # current channel_cursor (i.e. AFTER everything emitted
            # so far). Then advance cursor by 3 for the new leaf.
            insert_offsets.append(channel_cursor)
            channel_cursor += 3
            n_promoted += 1

            # Skip past the original End Site block in the source.
            i = block_end + 1
            continue

        # Closing brace closes the most recent JOINT/ROOT scope.
        if stripped == "}":
            if name_stack:
                name_stack.pop()
            out.append(ln)
            i += 1
            continue

        out.append(ln)
        i += 1

    return "".join(out), n_promoted, insert_offsets


def _patch_motion(motion: str, insert_offsets: List[int]) -> str:
    """Insert 3 zero rotations at each offset (in original column
    space) into every MOTION frame line.

    `motion` includes the leading "MOTION" line. The header lines we
    must NOT touch are:
        MOTION
        Frames: N
        Frame Time: dt
    Everything after that is frame data — one frame per line, each a
    whitespace-separated list of floats.

    Because the offsets are expressed against the ORIGINAL frame
    width, we must insert in DESCENDING order so earlier inserts
    don't shift later indices.
    """
    if not insert_offsets:
        return motion

    lines = motion.splitlines(keepends=True)
    # Find first frame-data line: skip MOTION, Frames:, Frame Time:.
    header_end = 0
    for idx, ln in enumerate(lines):
        s = ln.strip()
        if s.startswith("Frame Time"):
            header_end = idx + 1
            break

    # Pre-sort offsets descending so insert order is stable.
    sorted_offsets = sorted(insert_offsets, reverse=True)
    pad = ["0.000000", "0.000000", "0.000000"]

    out = lines[:header_end]
    for ln in lines[header_end:]:
        # Preserve trailing newline.
        if not ln.strip():
            out.append(ln)
            continue
        nl = ""
        body = ln
        if body.endswith("\r\n"):
            nl = "\r\n"
            body = body[:-2]
        elif body.endswith("\n"):
            nl = "\n"
            body = body[:-1]
        toks = body.split()
        for off in sorted_offsets:
            # off is the column at which to insert; clamp into range.
            o = max(0, min(off, len(toks)))
            toks[o:o] = pad
        out.append(" ".join(toks) + nl)
    return "".join(out)


def patch_bvh_leaves(bvh_path: str) -> int:
    """Promote every End Site in `bvh_path` to a real Joint.

    Rewrites the file in place. Returns the count of leaves promoted.
    Raises on malformed BVH.
    """
    with open(bvh_path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()

    hierarchy, motion = _split_hierarchy_motion(text)
    new_hier, n_promoted, offsets = _patch_hierarchy(hierarchy)
    if n_promoted == 0:
        return 0
    new_motion = _patch_motion(motion, offsets)

    tmp_path = bvh_path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(new_hier)
        f.write(new_motion)
    os.replace(tmp_path, bvh_path)
    return n_promoted


def _main(argv: List[str]) -> int:
    if len(argv) != 2:
        print("usage: bvh_patch_leaves.py <path/to/anim.bvh>", file=sys.stderr)
        return 2
    n = patch_bvh_leaves(argv[1])
    print(f"patched {n} End-Site leaves in {argv[1]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv))
