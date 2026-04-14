"""
Example: batch-generate from a list of prompts.

Reads a CSV (prompt,engine,count,steps), drives FabMesh end-to-end for
each row (image -> 3D mesh), and saves a screenshot per prompt.

Usage:
    python scripts/examples/batch_generate.py prompts.csv out_dir/

CSV format (header optional):
    prompt,engine,count,steps
    an orc warrior,local-realvis,1,30
    medieval knight,local-realvis,1,30
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from fabmesh_client import FabMesh, FabMeshError  # type: ignore  # noqa: E402


def run_one(fm: FabMesh, prompt: str, engine: str, count: int, steps: int,
            out_dir: Path) -> dict:
    print(f"[{prompt}] generate image")
    fm.generate_image(prompt=prompt, engine=engine, count=count, steps=steps)
    r = fm.wait_job(timeout=300)
    if r.get("status") != "completed":
        return {"ok": False, "stage": "image", "info": r}

    print(f"[{prompt}] generate 3D mesh")
    fm.generate_3d(image_index=0, engine="sf3d")
    r = fm.wait_job(timeout=600)
    if r.get("status") != "completed":
        return {"ok": False, "stage": "mesh", "info": r}

    safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in prompt)[:60]
    shot = out_dir / f"{safe}.png"
    fm.save_screenshot(str(shot))
    return {"ok": True, "screenshot": str(shot)}


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    csv_path = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    fm = FabMesh()
    print("connected:", fm.ping()["name"])

    with csv_path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f) if _has_header(csv_path) else csv.reader(f)
        for row in reader:
            if isinstance(row, dict):
                prompt = row["prompt"]
                engine = row.get("engine", "local-realvis")
                count = int(row.get("count", 1))
                steps = int(row.get("steps", 30))
            else:
                prompt = row[0]
                engine = row[1] if len(row) > 1 else "local-realvis"
                count = int(row[2]) if len(row) > 2 else 1
                steps = int(row[3]) if len(row) > 3 else 30
            try:
                r = run_one(fm, prompt, engine, count, steps, out_dir)
                print(f"  -> {r}")
            except FabMeshError as e:
                print(f"  !! {prompt}: {e}")


def _has_header(p: Path) -> bool:
    with p.open("r", encoding="utf-8") as f:
        first = f.readline().strip()
    return first.lower().startswith("prompt")


if __name__ == "__main__":
    main()
