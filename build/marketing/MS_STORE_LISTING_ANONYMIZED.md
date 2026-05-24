# MS Store Listing — anonymized version (to apply post-cert)

The submission currently in certification has the previous description
that mentions TRELLIS-2, IP-Adapter, SDXL — competitor-friendly info.

Once the app is **live** on the Store, edit the Store listings and
swap to the version below. Store listing edits do NOT re-trigger a
package review — they're validated in a few hours.

URL: https://partner.microsoft.com/en-US/dashboard/products/9PH6GT8XKQDW
→ Store listings → English (United States) → Edit

---

## Description (replace whole block)

```
Turn any reference image into a textured, game-ready 3D mesh in 60-120 seconds — running entirely on your own NVIDIA GPU. No cloud upload, no monthly subscription, your assets never leave your machine.

MyFabmesh.AI brings state-of-the-art image-to-3D AI into a single Windows desktop application built for indie game developers, 3D artists, hobbyists and architectural visualizers. Drop a photo or AI-generated concept art, and get back a clean GLB mesh ready for Unreal Engine, Blender, Unity, Godot, or any standard 3D pipeline.

KEY FEATURES

• Image-to-3D in one click — automatic background removal, view rectification, mesh generation and texture projection. No 3D modeling expertise required.

• Edit every step — refine the input photo (mask, inpaint, clone, blur), refine the mesh geometry, paint or smooth the textures, all inside the same app.

• 100% local generation — your reference images, prompts and meshes never touch the internet. Runs offline after the first-run model download.

• Asset-type intelligent presets — Character, Creature, Vehicle, Building, Weapon, Prop, Environment, Icon — each preset tunes the pipeline (rectification mode, back-view generation, face inpaint, texture smoothing) to the right defaults.

• Multi-view back-view generation — for characters and creatures, generates a coherent back view so the final mesh is consistent in 360°, not just from the front.

• Game-ready output — GLB / glTF with PBR textures, UV-unwrapped, decimation-controlled (100k / 500k / 1.5M triangles depending on quality mode).

• Scriptable from Claude Code, VS Code, or any MCP-compatible IDE via the bundled MCP server — automate batch generations programmatically.

• Three quality modes — Lite (~60s, 100k tris, 8GB VRAM), Standard (~90s, 500k tris, 12GB VRAM), Full (~180s, 1.5M tris, 16GB+ VRAM).

REQUIREMENTS

• Windows 10 or Windows 11 (64-bit)
• NVIDIA GPU with at least 8 GB VRAM (RTX 2060 minimum, RTX 4070+ recommended). AMD and Intel GPUs are not supported — use our upcoming Cloud version instead.
• 16 GB RAM minimum (32 GB recommended)
• 30 GB free disk space
• Internet connection on first launch only (downloads the bundled AI models)

YOUR MESHES, YOUR PROPERTY

All bundled AI models are commercial-safe (MIT / Apache 2.0 / BSD / OpenRAIL++-M licensed). Meshes you generate are 100% yours to use commercially — in your games, your portfolio, your 3D prints, your client work.

PUBLIC BETA

MyFabmesh.AI is currently in free public beta. Report issues at github.com/fabienlacaze/MyFabmesh/issues. Crash reports are sent anonymously (no personal data, no machine identifier — see our privacy policy at https://fabienlacaze.github.io/MyFabmesh/privacy.html).

Made with care in France by Ayros Studio.
```

## Diff summary vs current Store listing

Removed words (avoid stack leakage):
- TRELLIS-2 (mentioned 2× → removed)
- IP-Adapter (mentioned 1× → removed)
- SDXL (mentioned 1× → removed)
- "latest 2026 AI models" → replaced with "state-of-the-art image-to-3D AI"
- "~15-22 GB of open-source AI models from Hugging Face" → "the bundled AI models" (more vague)

Kept (these are facts, not stack leak):
- "Made with care in France by Ayros Studio" (publisher = us)
- Privacy URL (legal requirement)
- GitHub repo URL (still useful for bug reports)
- License names (MIT/Apache/BSD/OpenRAIL++-M) — these are public license families, not specific to our stack
