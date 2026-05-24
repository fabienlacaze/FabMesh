# MyFabmesh.AI — Press Kit

_For journalists, content creators, distributors, and anyone writing about MyFabmesh.AI._

**Last updated**: 2026-05-24 · Public beta · By Ayros Studio (France)

---

## Quick pitch (1 sentence)

> MyFabmesh.AI turns any reference image into a textured, game-ready 3D mesh in 60-120 seconds — running 100% locally on your NVIDIA GPU, no cloud upload, no subscription.

## Quick pitch (1 paragraph)

> MyFabmesh.AI is a Windows desktop application that lets indie game developers, 3D artists, hobbyists and architectural visualizers turn any reference image into a clean, textured, game-ready 3D mesh in 60-120 seconds. Everything runs locally on the user's NVIDIA GPU — no cloud upload, no monthly subscription, full IP ownership of the generated assets. Outputs are standard GLB files ready to drop into Unreal Engine, Blender, Unity or Godot. Free during public beta.

## Quick pitch (3 paragraphs / blog post intro)

> Generating 3D models from a single image used to mean either spending hours in Blender or sending your reference photos to a cloud API that may or may not use them to train its next model. **MyFabmesh.AI** takes a different path: it's a single Windows desktop app that runs the entire state-of-the-art image-to-3D pipeline on the user's own NVIDIA GPU.
>
> Drop a photo or AI-generated concept art, and 60 to 120 seconds later you get a clean, UV-unwrapped GLB mesh with PBR textures, ready for Unreal Engine, Blender, Unity or Godot. The app handles background removal, view rectification, mesh generation and texture projection automatically, with asset-type presets (Character, Creature, Vehicle, Building, Weapon, Prop, Environment) that tune the pipeline to the right defaults out of the box.
>
> Built by Ayros Studio (a French solo dev), MyFabmesh.AI is free during its public beta. All bundled AI models are commercially licensed (MIT / Apache / BSD / OpenRAIL++-M), so the meshes you generate are 100% yours to ship in commercial games and assets. It's available on the Microsoft Store and as a direct download.

---

## Key facts

| Field | Value |
|-------|-------|
| **Name** | MyFabmesh.AI |
| **Publisher** | Ayros Studio (France) |
| **Platform** | Windows 10 / 11 (64-bit) |
| **Distribution** | Microsoft Store + direct download (GitHub Releases) |
| **Pricing** | Free during public beta |
| **GPU required** | NVIDIA, 8 GB VRAM minimum (RTX 2060+) |
| **Internet** | Required on first launch only (model download) |
| **Output format** | GLB / glTF with PBR textures |
| **Generation time** | 60-180 s depending on quality mode |
| **Mesh detail** | 100k / 500k / 1.5M triangles |
| **Texture resolution** | 1024 / 2048 / 4096 px (mode-dependent) |
| **Commercial use** | Allowed (MIT / Apache / BSD / OpenRAIL++-M models) |
| **Beta launch** | May 2026 |
| **Cloud version** | In development (Q3 2026) |
| **Source code** | github.com/fabienlacaze/MyFabmesh |
| **Website** | fabienlacaze.github.io/MyFabmesh (custom domain coming) |
| **Contact** | fabien65400@hotmail.fr |

---

## What makes MyFabmesh.AI different from Meshy / Tripo / CSM / Hunyuan3D-Cloud

| Feature | MyFabmesh.AI | Cloud-based competitors |
|---------|--------------|-------------------------|
| **Runs locally** | ✅ Yes | ❌ No (cloud only) |
| **Privacy** | ✅ Your images never leave your machine | ❌ Uploaded to vendor servers |
| **Monthly subscription** | ❌ No (one-time purchase post-beta) | ✅ Typically $20-50/mo |
| **Unlimited generations** | ✅ Yes (limited only by your GPU) | ❌ Quota-based |
| **Offline after install** | ✅ Yes | ❌ No |
| **Edit photo + mesh + textures in same app** | ✅ Yes | ❌ Export to other tools |
| **Scriptable from IDE (MCP)** | ✅ Claude Code, VS Code | ❌ Web UI only |
| **AMD / Intel GPU support** | ❌ No (Cloud version planned) | ✅ |

---

## Common Q&A

### Q: Is this another wrapper around a public API?
**No.** Everything runs on the user's machine. There is no API call back to MyFabmesh.AI's servers (except an anonymous crash report opt-in via Sentry).

### Q: Why NVIDIA only?
The AI models we run require CUDA. AMD and Intel paths exist (ROCm, DirectML) but they are slower and less stable for the model architectures we use. The Cloud version (coming in Q3 2026) will cover AMD/Intel/Mac users.

### Q: Can I use the generated meshes commercially?
**Yes, 100%.** All bundled AI models are MIT, Apache 2.0, BSD, or OpenRAIL++-M licensed. Your meshes are yours to sell, publish, modify.

### Q: How does this compare to free open-source 3D AI tools?
The open-source models we bundle ARE free and open-source. MyFabmesh.AI adds: a one-click installer, automatic dependency management (~17 GB of CUDA libs + models bundled), asset-type intelligent presets, integrated photo+mesh+texture editor, automatic back-view generation, multi-view consistency, and a polished workspace UI. Think of it as Photoshop for AI 3D generation.

### Q: Why is there a free Cloud version planned?
For the ~65% of PC users who don't have an NVIDIA GPU with 8 GB+ VRAM (AMD, Intel, Mac, mobile, low-end NVIDIA). Same app UI, but generation happens on rented GPUs. Pay-as-you-go pricing (~0.20 €/mesh), no subscription.

### Q: Is this a one-person project? How can I trust it'll be maintained?
Yes, a solo dev (Fabien Lacaze, France, operating under Ayros Studio). Source code is on GitHub, all AI models are open-source (so the app would still work even if Ayros Studio disappeared), and crash reports flow into Sentry for active monitoring.

---

## Assets

### Logo
- `build/store_assets/icon_300x300.png` (300×300, transparent BG)
- `build/store_assets/icon_1080x1080.png` (1080×1080, transparent BG)
- `build/store_assets/promo_2400x1200.png` (2400×1200 landscape, dark BG)

### Screenshots
- `docs/screenshots/01-wizard.png` (1600×1000) — setup wizard mockup
- `docs/screenshots/02-generate.png` (1600×1000) — main generation workspace mockup
- Real captures of the installed app: TBD (coming when the Microsoft Store version is live and we can capture without SAC blocking)

### Brand colors
- Background dark: `#0b0b14` (deep navy)
- Accent primary: `#a855f7` (purple)
- Accent secondary: `#e94560` (crimson)
- Gradient: `linear-gradient(135deg, #e94560, #a855f7)`

### Typography
- UI: Segoe UI, system-ui (Windows native)
- Site web: same

---

## Contact

- **Email**: fabien65400@hotmail.fr
- **GitHub**: github.com/fabienlacaze
- **Website**: fabienlacaze.github.io/MyFabmesh

For press inquiries: please mention "MyFabmesh.AI press" in the subject.

---

## License & permissions

You may use the text and assets from this press kit freely to write about MyFabmesh.AI (reviews, news articles, social posts, etc.). Please link back to https://fabienlacaze.github.io/MyFabmesh when possible.
