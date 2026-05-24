# Launch posts — drafts ready to copy-paste

To use the day **MyFabmesh.AI** goes live on Microsoft Store.
Each draft fits within platform character limits.

⚠ Before posting:
- Replace `[STORE_URL]` with the actual MS Store listing URL
  (`https://apps.microsoft.com/detail/9PH6GT8XKQDW` — already known)
- Replace `[GIF_URL]` if you have an animated demo, otherwise drop the asset directly
- Replace `[YOUR_TWITTER]` with your handle (or remove if you don't have one)
- Pick the right tone per platform (chill on Reddit, factual on HN, energetic on Twitter)

---

## Twitter / X (280 chars max)

### Variant A — pragmatic
```
After months of building: MyFabmesh.AI is on the Microsoft Store ✨

Drop a photo → get a 3D mesh (GLB, game-ready) in 90 s
Runs 100% locally on your NVIDIA GPU
No cloud upload, no subscription, your IP stays yours

Free during public beta:
https://apps.microsoft.com/detail/9PH6GT8XKQDW
```
(257 chars)

### Variant B — punchy
```
Image → 3D mesh in 90 s.
Locally. On your GPU.
No cloud. No subscription.

MyFabmesh.AI is now on Microsoft Store, free during beta.

For indie devs, 3D artists, anyone who's tired of paying $30/mo for cloud-only tools.

https://apps.microsoft.com/detail/9PH6GT8XKQDW
```
(243 chars)

### Variant C — feature-focused
```
🎯 Photo → 3D mesh, 90 s, your NVIDIA GPU
🛠 Built-in editor: photo + mesh + textures
💻 Scriptable from VS Code / Claude Code (MCP)
🎮 GLB output, Unreal / Blender / Unity ready
📦 Free public beta on Microsoft Store

MyFabmesh.AI
https://apps.microsoft.com/detail/9PH6GT8XKQDW
```
(265 chars)

**Recommendation**: variant A. Most balanced.

---

## Reddit — r/gamedev

**Title** (use one of):
- `I built a local image-to-3D mesh generator that runs on your own GPU (free beta, no cloud upload)`
- `Solo dev: I released MyFabmesh.AI on Microsoft Store - image to GLB in 90s, runs locally`

**Body**:

```
Hey r/gamedev,

After months of head-banging into CUDA toolkits and Electron quirks, I just released the public beta of **MyFabmesh.AI** on the Microsoft Store.

**What it does**: drop a reference image (photo, AI-generated concept art, whatever), and ~90 seconds later you get a clean GLB mesh with PBR textures, UV-unwrapped, ready for Unreal / Blender / Unity / Godot.

**What's different**:
- **Runs entirely on your local NVIDIA GPU** — no cloud upload, no monthly subscription, your reference images and meshes never leave your machine
- Built-in editor: refine the photo (mask, inpaint, clone, blur), refine the mesh, paint textures — all in one app
- Asset-type intelligent presets (Character, Creature, Vehicle, Building, Weapon, Prop...) that tune the pipeline behind the scenes
- Multi-view back-view generation so character meshes are coherent in 360°, not just front-only
- Three quality modes (Lite ~60s, Standard ~90s, Full ~180s) depending on your patience and your GPU
- Scriptable from VS Code or Claude Code via the bundled MCP server (batch generation, etc.)

**Requirements**: Windows 10/11 64-bit, NVIDIA GPU with 8 GB VRAM (RTX 2060 minimum, RTX 4070+ recommended), 16 GB RAM, 30 GB free disk for the models.

**Pricing**: free during the public beta. After beta, planned at 24.99 € one-shot (no subscription). The 3D meshes you generate are 100% yours, commercial use allowed (all bundled AI models are MIT / Apache / BSD / OpenRAIL++-M licensed).

**Cloud version** is in dev for Mac / AMD / Intel users — pay-as-you-go, ~0.20 €/mesh, no subscription.

Microsoft Store: https://apps.microsoft.com/detail/9PH6GT8XKQDW
Site: https://fabienlacaze.github.io/MyFabmesh
GitHub (source + issues): https://github.com/fabienlacaze/MyFabmesh

Happy to answer questions. Would love feedback on what features matter most for your workflow.

— Fabien (Ayros Studio)
```

---

## Reddit — r/3Dprinting

**Title**: `Free Windows tool: photo to printable 3D mesh in 90 seconds, local NVIDIA GPU`

**Body** (similar to gamedev but rephrased for 3D printing):

```
Just released the public beta of MyFabmesh.AI, a Windows app that turns any reference photo into a 3D mesh (GLB format).

For 3D printing specifically:
- Output is GLB / glTF with clean topology
- Three quality modes — Full mode produces 1.5M triangle meshes suitable for high-detail prints
- Texture maps included (useful for color FDM or just for visual reference)
- Convert to STL via Blender / Meshmixer / Cura in one click

Runs 100% locally on your NVIDIA GPU (8 GB VRAM minimum). No cloud upload — your designs stay on your machine.

Free during public beta, post-beta planned at 24.99 € one-shot, no subscription. Commercial use allowed (all bundled AI models are commercially licensed).

Microsoft Store: https://apps.microsoft.com/detail/9PH6GT8XKQDW

Happy to answer questions if you want to try it on a specific use case.
```

---

## Reddit — r/StableDiffusion

**Title**: `MyFabmesh.AI — image-to-3D desktop app, runs on your NVIDIA GPU, free beta`

**Body**:

```
Public beta of MyFabmesh.AI is up on the Microsoft Store. It's a Windows desktop app that takes a reference image and generates a 3D mesh (GLB) in ~90 seconds, running 100% locally on the user's NVIDIA GPU.

Stack-wise: it bundles state-of-the-art open-source image-to-3D models with a polished workspace UI (photo editor, mesh viewer, texture paint), asset-type presets that tune the pipeline, and multi-view consistency for characters / creatures.

Why I built it: I was tired of paying $30/mo for cloud-only image-to-3D tools that also keep my reference images. Now everything runs on my own 5080 with no compromise on quality.

Free during beta. NVIDIA only for now (Cloud version for AMD/Intel/Mac coming).

https://apps.microsoft.com/detail/9PH6GT8XKQDW
github.com/fabienlacaze/MyFabmesh
```

---

## Hacker News (Show HN)

**Title**: `Show HN: MyFabmesh.AI – local image-to-3D mesh generator (free beta, Windows + NVIDIA)`

**Body** (first comment by yourself, HN style):

```
Hi HN. I'm Fabien, solo dev based in France. I just released the public beta of MyFabmesh.AI on the Microsoft Store after several months of work.

It's a Windows desktop app that takes a reference image and produces a textured, game-ready 3D mesh (GLB) in 60-180 seconds. Everything runs locally on the user's NVIDIA GPU — no cloud upload, no subscription, full IP ownership of the output.

What it solves for me (and hopefully others):
- Cloud image-to-3D tools work great but keep your reference images and force you into a subscription. I wanted local-first, one-shot pricing.
- Open-source models exist but they require ~17 GB of CUDA dependencies and significant Python wrangling to install. The app does that automatically on first launch.
- Standalone gen tools give you a mesh and stop there. I wanted the ability to refine the photo, refine the mesh, and paint textures in the same workspace.

Built with Electron + Node + a Python backend that runs the AI pipeline. About 12k lines of renderer JS and ~30k lines of Python. The hardest part wasn't the AI (well-documented open-source models) — it was the packaging: Windows code-signing, Smart App Control, NSIS quirks, model download UX, GPU detection.

Free during the public beta. Post-beta plan: 24.99 € one-shot (no subscription) for Desktop, and a separate Cloud version (~0.20 € per mesh) for users without NVIDIA.

Happy to answer questions about the stack, the packaging journey, or anything else.

Microsoft Store: https://apps.microsoft.com/detail/9PH6GT8XKQDW
Site: https://fabienlacaze.github.io/MyFabmesh
```

---

## Discord — gamedev / 3D channels

**Short version** (most Discord servers ban long posts):

```
Just dropped the public beta of **MyFabmesh.AI** — a free Windows tool that turns a reference image into a textured 3D mesh in 90s, all running locally on your NVIDIA GPU.

GLB output, Unreal / Blender / Unity ready. No cloud upload, no subscription.

Microsoft Store: https://apps.microsoft.com/detail/9PH6GT8XKQDW

Would love feedback if you give it a try 🙏
```

---

## LinkedIn (more formal)

```
Excited to announce the public beta launch of MyFabmesh.AI on the Microsoft Store.

MyFabmesh.AI is a Windows desktop application that transforms reference images into game-ready 3D meshes in 60-120 seconds, running entirely on the user's local NVIDIA GPU. It's designed for indie game developers, 3D artists, hobbyists, and architectural visualizers who want a privacy-first, subscription-free alternative to cloud image-to-3D services.

Key features:
→ 100% local generation, no cloud upload
→ Built-in editor: refine photos, meshes, and textures in a single workspace
→ Asset-type intelligent presets (Character, Vehicle, Weapon, etc.)
→ Game-ready GLB output for Unreal Engine, Blender, Unity, Godot
→ Scriptable via MCP from Claude Code and VS Code
→ Free during public beta

Built by Ayros Studio (Fabien Lacaze, France).

A Cloud version targeting Mac, AMD, and Intel users is in development for Q3 2026.

Microsoft Store: https://apps.microsoft.com/detail/9PH6GT8XKQDW
Website: https://fabienlacaze.github.io/MyFabmesh

#gamedev #3D #AI #indiedev #unrealengine #blender #unity
```

---

## Posting schedule (recommended)

| Day | Time (CET) | Platform |
|-----|------------|----------|
| **Day 0** (launch) | 09:00 | Twitter/X (variant A) + LinkedIn |
| Day 0 | 14:00 | Reddit r/gamedev (peak EU + waking US) |
| Day 0 | 18:00 | Discord servers (after work CET) |
| Day 0 | 21:00 | Reddit r/StableDiffusion (peak US) |
| **Day 1** | 09:00 | Hacker News Show HN (Tue/Wed/Thu best) |
| Day 1 | 14:00 | Reddit r/3Dprinting |
| Day 3 | — | Wait for organic feedback before pushing more |
| Day 7 | — | Follow-up Twitter post with stats / user testimonials |

**Don't post on Friday afternoon or Saturday** — engagement is much lower for indie launches.

**Don't cross-post the same text everywhere on the same day** — communities check for cross-posts and downvote. Use the variants.

---

## Post-launch monitoring

- Twitter: respond to every reply in the first 6h (algorithm boost)
- Reddit: monitor your post for the first 4h, reply to top comments
- HN: only respond to substantive technical comments, ignore flame bait
- Discord: be present in the channel for 1-2h after posting

Set up notifications on:
- Sentry (for crash reports as new users install)
- GitHub Issues (for bug reports)
- Microsoft Partner Center (for reviews and ratings)
