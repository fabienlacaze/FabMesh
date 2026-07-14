"""Generate 150 reference images for AnyTop training dataset (Plan B1).

Uses the EXACT same code path as MyFabmesh DESKTOP version
(scripts/local_juggernaut_bridge.py:generate_images). The bridge logic
is mirrored verbatim below — same prompt enrichment, same archetype-aware
negative prompts, same CFG=9.5 for animal/creature, same RealVis XL V4.0
pipeline — so the training data matches the distribution Trellis sees
in production.

Difference vs the bridge: single pipeline load + 150 prompts in one
process (the bridge reloads SDXL on every call which would take 1.5h
of just-loading time for 150 images).

CLI:
    python scripts/training_data_gen.py --steps 30
    python scripts/training_data_gen.py --archetype quadruped --n 5  # quick test
"""
from __future__ import annotations
import argparse
import os
import sys
import time
from pathlib import Path

# Import the FabMesh production prompt builder so the prompts here go
# through THE EXACT same enrichment + negatives as the deployed Modal
# /text2image endpoint (modal_app/_realvis.py:build_prompts) — which the
# desktop bridge also mirrors verbatim (scripts/local_juggernaut_bridge.py
# L240-302).
_proj_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _proj_root not in sys.path:
    sys.path.insert(0, _proj_root)


# ---------------------------------------------------------------------------
# 150 prompts (50/archetype) — short user-style prompts; the FabMesh
# enrichment adds the 3D-asset constraints (full body, isolated, plain
# background, anti-portrait negatives etc.) so we keep these clean.
# ---------------------------------------------------------------------------
PROMPTS = {
    "quadruped": [
        "a majestic gray wolf, full body side view",
        "a brown wolf walking, full body side view",
        "an arctic white wolf, full body 3/4 view",
        "a black wolf in alert pose, full body side",
        "a wolf pup, full body 3/4 view",
        "a brown bear standing on four legs, side profile",
        "a polar bear walking, full body side view",
        "a grizzly bear, full body 3/4 view",
        "a panda bear, full body side view",
        "a black bear cub, full body 3/4",
        "a lion male with mane, side profile, full body",
        "a lioness walking, full body 3/4 view",
        "a young lion cub, full body side",
        "a lion roaring, full body 3/4 view",
        "a stalking lion, low pose, full body side",
        "an arabian horse, side profile, full body",
        "a black stallion, full body 3/4 view, running pose",
        "a brown horse standing, full body side view",
        "a white horse galloping, full body side",
        "a draft horse, full body 3/4 view, muscular",
        "a red deer with antlers, side profile, full body",
        "a fallow deer doe, full body 3/4",
        "an elk with massive antlers, full body side view",
        "a young deer fawn, full body 3/4",
        "a moose standing in snow, full body side",
        "a red fox, full body side view",
        "an arctic fox in snow, full body 3/4 view",
        "a desert fox, full body side",
        "a fox pup, full body 3/4",
        "a fox hunting pose, low body side view",
        "a german shepherd dog, full body side view",
        "a husky dog, full body 3/4 view",
        "a labrador retriever, full body side",
        "a doberman, full body 3/4 view",
        "a wolfhound, full body side",
        "a black panther stalking, full body side view",
        "a leopard standing in profile, full body, spotted",
        "a cheetah running, full body 3/4 view",
        "a tiger walking, full body side profile",
        "a snow leopard, full body 3/4 view",
        "a holstein cow, side profile, full body",
        "a brown bull, full body 3/4 view, muscular",
        "a highland cattle with long horns, full body side",
        "a goat standing on rocks, full body side view",
        "a mountain goat with curved horns, full body 3/4",
        "a mythical dire wolf, oversized, full body side view, fantasy",
        "a hellhound fire demon dog, full body 3/4 view, dark fantasy",
        "a giant saber-tooth tiger, full body side view, prehistoric",
        "a winged feline snow leopard, full body 3/4",
        "a six-legged alien hound, full body side view, sci-fi",
    ],
    # Humanoid prompts WITH weapons — restored after Compel bypass of
    # 77-token cap (workflow wb66mnlri + woydvj5w6). The anti-mirror-
    # weapon negative ("two weapons, dual wielding, mirrored weapons,
    # pair of weapons, holding two weapons") in build_prompts() now
    # actually reaches the U-Net via CFG, preventing the bow/sword
    # doubling. Each prompt mentions ONE weapon explicitly so SDXL
    # doesn't have to "fill" empty hands by inventing extras.
    "humanoid": [
        "a muscular green orc warrior holding one large axe in right hand",
        "an orc warrior with armor holding one sword in right hand",
        "an orc shaman with tribal markings holding one wooden staff",
        "an orc berserker holding one giant club",
        "an orc chieftain holding one battle axe in right hand",
        "a dwarf warrior with beard holding one war hammer",
        "a dwarf miner holding one pickaxe in right hand",
        "a dwarf paladin in armor holding one hammer",
        "a dwarf wizard holding one magic staff",
        "a dwarf king with crown holding one royal scepter",
        "an elf archer female holding one bow in left hand",
        "an elf warrior male holding one sword in right hand",
        "an elf druid holding one wooden staff with leaves",
        "an elf mage in robes holding one magic wand",
        "an elf ranger holding one short bow in left hand",
        "a goblin holding one small dagger in right hand",
        "a goblin shaman holding one bone staff",
        "a goblin warrior holding one round shield in left hand",
        "a hobgoblin captain holding one curved sword",
        "a goblin chief with crown holding one spear",
        "a human knight in plate armor holding one long sword",
        "a human peasant farmer holding one pitchfork",
        "a human mercenary holding one short sword",
        "a human merchant holding one money pouch",
        "a human paladin holding one warhammer",
        "a human skeleton warrior holding one rusty sword",
        "a skeleton mage holding one black staff",
        "a skeleton archer holding one bow in left hand",
        "a skeleton king with crown holding one bone scepter",
        "a lich skeleton holding one dark crystal staff",
        "a forest troll with green skin holding one tree branch club",
        "a mountain troll holding one giant wooden club",
        "a cave troll with brown skin holding one stone club",
        "a frost troll with blue skin holding one icy club",
        "a hill troll warrior holding one large mace",
        "an undead zombie warrior holding one broken sword",
        "a vampire lord holding one elegant rapier",
        "a tiefling demon humanoid with red skin holding one cursed blade",
        "a dragonborn warrior with scales holding one greatsword",
        "a minotaur warrior with horns holding one large battle axe",
        "a barbarian warrior shirtless holding one giant club",
        "a viking berserker holding one bearded axe",
        "an assassin in dark robes holding one curved dagger",
        "a samurai warrior holding one katana in right hand",
        "a ninja stealth holding one short sword",
        "a wizard old man with beard holding one wooden staff",
        "a necromancer in black robes holding one skull staff",
        "a cleric priest holding one holy mace",
        "a monk martial artist with empty hands ready to fight",
        "an alien humanoid grey holding one energy weapon",
    ],
    "winged_biped": [
        "a majestic red dragon with wings spread",
        "a green forest dragon, wings half open",
        "a black dragon perched, wings spread",
        "a blue ice dragon, wings open",
        "a gold dragon flying, wings spread",
        "a wyvern dragon, two legs and wings",
        "a wyvern hunter, wings half open",
        "a smaller wyvern, wings open",
        "a fire wyvern, wings spread",
        "a poison wyvern, wings open",
        "a chinese oriental dragon, long body with wings",
        "a chinese dragon serpent with wings",
        "an asian dragon, wings spread",
        "a chinese dragon in flight, wings",
        "a japanese dragon, wings open",
        "a fierce harpy female, bird wings",
        "a harpy queen with feathered wings",
        "a young harpy, wings half open",
        "a dark harpy, black wings",
        "a snow harpy, white wings spread",
        "a living stone gargoyle creature, demonic wings spread, standing on bare ground",
        "an animated flying gargoyle creature, wings open, standing on flat ground, no pedestal",
        "a marble gargoyle living creature with wings spread, standing on flat ground, no base",
        "a fire gargoyle alive, glowing wings, standing on bare ground",
        "an ancient gargoyle warrior alive, wings open, standing on flat ground",
        "a dragon hatchling, small wings",
        "an undead skeletal dragon, wings spread",
        "a zombie dragon, wings open",
        "a crystal dragon, wings spread",
        "a copper dragon, wings open",
        "a silver dragon, wings spread",
        "a bronze dragon, wings open",
        "a young red dragon, wings half open",
        "an emerald dragon, wings open",
        "a sapphire blue dragon, wings spread",
        "a fairy with butterfly wings, humanoid",
        "a demon with bat wings, humanoid",
        "an angel with white feathered wings",
        "a phoenix bird-humanoid hybrid, wings spread",
        "a manticore with bat wings",
        "a wraith with shadowy wings, humanoid",
        "a succubus with bat wings",
        "an imp small demon, bat wings",
        "a draconian humanoid, dragon wings",
        "a winged elf, feathered wings",
        "a feathered serpent dragon, wings",
        "a basilisk with vestigial wings",
        "a cockatrice with wings",
        "a roc giant bird, wings spread",
        "a quetzal feathered dragon, wings spread",
    ],
}


# ---------------------------------------------------------------------------
# Map our archetype labels to the FabMesh production asset_type taxonomy
# (see modal_app/_prompts.py:ASSET_TYPE_PROMPTS).
#
# - 'animal'   : 4-legged creatures (anti-portrait + CFG=9.5)
# - 'character': humanoid bipeds (T-pose, arms extended)
# - 'creature' : winged_biped, monsters (single instance, neutral stance)
# ---------------------------------------------------------------------------
ARCHETYPE_ASSET_TYPE = {
    "quadruped":    "animal",
    "humanoid":     "character",
    "winged_biped": "creature",
}


# ---------------------------------------------------------------------------
# Prompt + negative builders — VERBATIM ports of the production paths
#
#   modal_app/_realvis.py:build_prompts()  (cloud)
#   scripts/local_juggernaut_bridge.py:generate_images() L211-302 (desktop)
#
# Both are byte-identical for the same (prompt, asset_type) pair. The
# bridge has a few extra paths (T-pose ControlNet for character) that
# we don't need for batch ref-image generation.
# ---------------------------------------------------------------------------
def build_prod_prompts(user_prompt: str, asset_type: str) -> tuple[str, str]:
    """Use the EXACT same prompt path as MyFabmesh production now that
    modal_app/_realvis.py has been rewritten to fit the SDXL 77-token
    cap (workflow wb66mnlri). Call straight into build_prompts() —
    asset_type is forwarded so anti-anatomy + anti-doubling are
    properly front-loaded inside the budget."""
    from modal_app._prompts import build_enriched_prompt
    from modal_app._realvis import build_prompts
    enriched = build_enriched_prompt(user_prompt, asset_type, "realistic")
    return build_prompts(enriched, asset_type=asset_type)


def cfg_for(asset_type: str) -> float:
    """Mirror local_juggernaut_bridge.py:315 — CFG=9.5 for animal/creature
    so the repeated anti-portrait negative actually bites under classifier-
    free guidance. Other types use 7.0."""
    return 9.5 if asset_type in ('animal', 'creature') else 7.0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="c:/tmp/training_refs")
    ap.add_argument("--archetype", default=None)
    ap.add_argument("--n", type=int, default=None)
    ap.add_argument("--steps", type=int, default=30)
    ap.add_argument("--seed-base", type=int, default=42)
    ap.add_argument("--width", type=int, default=1024)
    ap.add_argument("--height", type=int, default=1024)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    archetypes = [args.archetype] if args.archetype else list(PROMPTS.keys())
    out_root = Path(args.out)
    for a in archetypes:
        (out_root / a).mkdir(parents=True, exist_ok=True)

    total = sum(min(len(PROMPTS[a]), args.n or 9999) for a in archetypes)
    print(f"[gen] archetypes: {archetypes}")
    print(f"[gen] total images: {total}")
    print(f"[gen] output: {args.out}")
    print(f"[gen] steps: {args.steps}, resolution: {args.width}x{args.height}")
    print(f"[gen] using SAME prompt pipeline as MyFabmesh DESKTOP "
          f"(scripts/local_juggernaut_bridge.py L211-302)")

    if args.dry_run:
        for a in archetypes:
            asset_type = ARCHETYPE_ASSET_TYPE[a]
            prompts = PROMPTS[a][: args.n] if args.n else PROMPTS[a]
            print(f"\n=== {a} ({len(prompts)}, asset_type={asset_type}, "
                  f"cfg={cfg_for(asset_type)}) ===")
            for i, p in enumerate(prompts[:3]):
                opt, _ = build_prod_prompts(p, asset_type)
                print(f"  [{i:02d}] PROMPT: {p}")
                print(f"        ENRICHED: {opt[:180]}...")
        return 0

    print("[gen] loading RealVisXL V4.0 (~30s)…")
    import torch
    from diffusers import StableDiffusionXLPipeline
    pipe = StableDiffusionXLPipeline.from_pretrained(
        "SG161222/RealVisXL_V4.0",
        torch_dtype=torch.float16,
        use_safetensors=True,
        variant="fp16",
        add_watermarker=False,
    ).to("cuda")
    try:
        pipe.enable_xformers_memory_efficient_attention()
    except Exception:
        pass
    pipe.set_progress_bar_config(disable=True)

    overall_start = time.time()
    n_done = 0
    n_skipped = 0
    n_total = total
    for archetype in archetypes:
        asset_type = ARCHETYPE_ASSET_TYPE[archetype]
        cfg = cfg_for(asset_type)
        prompts = PROMPTS[archetype][: args.n] if args.n else PROMPTS[archetype]
        for idx, prompt in enumerate(prompts):
            seed = args.seed_base + idx
            out_path = out_root / archetype / f"{archetype}_{idx:02d}_seed{seed}.png"
            if out_path.exists():
                n_skipped += 1
                continue
            t0 = time.time()
            optimized, negative = build_prod_prompts(prompt, asset_type)
            gen = torch.Generator(device="cuda").manual_seed(seed)
            base_kwargs = dict(
                num_inference_steps=args.steps,
                guidance_scale=cfg,
                width=args.width,
                height=args.height,
                generator=gen,
            )
            # Compel bypasses SDXL's 77-token CLIP-L cap (workflow wb66mnlri)
            # so the anti-anatomy + anti-doubling + anti-mirror-weapon
            # negatives actually reach CFG instead of being truncated.
            try:
                from _sdxl_prompt_utils import encode_sdxl_long_prompt
                embeds = encode_sdxl_long_prompt(pipe, optimized, negative)
                img = pipe(**embeds, **base_kwargs).images[0]
            except Exception as _ce:
                print(f"[gen] Compel fallback ({_ce})", flush=True)
                img = pipe(prompt=optimized, negative_prompt=negative,
                           **base_kwargs).images[0]
            img.save(out_path)
            dt = time.time() - t0
            n_done += 1
            elapsed = time.time() - overall_start
            eta = elapsed / max(n_done, 1) * (n_total - n_done - n_skipped)
            print(f"[gen] [{n_done + n_skipped:3d}/{n_total}] "
                  f"{archetype}/{out_path.name} "
                  f"(asset_type={asset_type}, cfg={cfg}, {dt:.1f}s)  "
                  f"ETA {eta/60:.1f} min")

    print(f"\n[gen] DONE — {n_done} generated, {n_skipped} skipped. "
          f"Total: {(time.time()-overall_start)/60:.1f} min")
    return 0


if __name__ == "__main__":
    sys.exit(main())
