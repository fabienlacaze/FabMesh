"""Patches for Puppeteer upstream code:
1. torch.load() — add weights_only=False (torch 2.6+ default flipped)
2. SkeletonOPT.forward() — add **kwargs to ignore cache_position from
   newer transformers (>=4.40)
"""
import os
import sys

root = sys.argv[1] if len(sys.argv) > 1 else "/Puppeteer"
count = 0

for dp, _, files in os.walk(root):
    for f in files:
        if not f.endswith(".py"):
            continue
        p = os.path.join(dp, f)
        try:
            with open(p, encoding="utf-8", errors="ignore") as fh:
                src = fh.read()
        except Exception:
            continue
        if "torch.load(" not in src:
            continue
        out = []
        i = 0
        while i < len(src):
            j = src.find("torch.load(", i)
            if j < 0:
                out.append(src[i:])
                break
            out.append(src[i:j + 11])
            depth = 1
            k = j + 11
            while k < len(src) and depth > 0:
                c = src[k]
                if c == "(":
                    depth += 1
                elif c == ")":
                    depth -= 1
                k += 1
            inner = src[j + 11:k - 1]
            if "weights_only" not in inner:
                inner = inner.rstrip() + ", weights_only=False"
            out.append(inner + ")")
            i = k
        new = "".join(out)
        if new != src:
            with open(p, "w", encoding="utf-8") as fh:
                fh.write(new)
            count += 1

print(f"Patched {count} files with weights_only=False")

# ---- Patch 2: SkeletonOPT.forward — add **kwargs for cache_position ----
skel_opt = os.path.join(root, "skeleton/skeleton_models/skeleton_opt.py")
if os.path.isfile(skel_opt):
    with open(skel_opt, encoding="utf-8") as fh:
        src = fh.read()
    new = src.replace(
        "return_dict: Optional[bool] = None,\n    ) -> Union[Tuple, CausalLMOutputWithPast]:",
        "return_dict: Optional[bool] = None,\n        **kwargs,\n    ) -> Union[Tuple, CausalLMOutputWithPast]:",
    )
    new = new.replace(
        "return_dict: Optional[bool] = None,\n    ) -> Union[Tuple, BaseModelOutputWithPast]:",
        "return_dict: Optional[bool] = None,\n        **kwargs,\n    ) -> Union[Tuple, BaseModelOutputWithPast]:",
    )
    if new != src:
        with open(skel_opt, "w", encoding="utf-8") as fh:
            fh.write(new)
        print("Patched SkeletonOPT forward(**kwargs)")
    else:
        print("WARN: SkeletonOPT forward pattern not found — replacement count=0")

