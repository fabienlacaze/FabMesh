# MyFabmesh.AI — Launch Kit

Tous les textes prêts à copier-coller pour annoncer la beta. Adapte
le ton et les hashtags si besoin, mais le squelette est testé pour
matcher le tone of voice indé/dev.

---

## Liens à mettre dans toutes les bios + premier post

| Where | What |
|---|---|
| Site | https://fabienlacaze.github.io/MyFabmesh/ |
| Download direct | https://github.com/fabienlacaze/MyFabmesh/releases/latest |
| GitHub | https://github.com/fabienlacaze/MyFabmesh |
| Compatibility checker | https://fabienlacaze.github.io/MyFabmesh/check.html |

---

## 1. Tweet / X (280 chars)

### Version A — focus produit
```
🚀 MyFabmesh.AI is in public beta.

Drop a photo → get a textured 3D mesh, then edit photo and mesh end-to-end inside the app. NVIDIA local, free during beta.

Even drive it from @claudeai Code with the built-in MCP server.

👉 https://fabienlacaze.github.io/MyFabmesh/

#gamedev #b3d #unrealengine
```

### Version B — focus différenciateur MCP
```
What if Claude could generate a 3D mesh and drop it straight into Unreal — in one prompt?

That's what MyFabmesh.AI ships today, in public beta. Built-in MCP server, Unreal MCP plugin support, end-to-end editor.

Free until v1.1.

https://fabienlacaze.github.io/MyFabmesh/
```

### Thread d'accompagnement (optionnel, après le tweet principal)
```
2/ Most AI 3D generators stop at "you got a GLB, good luck". MyFabmesh.AI gives you the photo editor AND the mesh editor in the same app. Mask, inpaint, paint on 3D, fix face artefacts, 8K upscale. No round-trip to Blender between iterations.

3/ Pipeline is 100% commercial-safe (MIT / Apache / BSD / OpenRAIL++-M). What you generate is 100% yours to sell on Fab.com, Sketchfab, Unity Asset Store, anywhere.

4/ Runs locally on NVIDIA GPU 8 GB+. Wizard auto-detects your config, picks the right install mode, downloads ~15 GB of models on first launch.

5/ Plus the developer angle: it's an MCP server. Pair with @claudeai Code in VS Code + the Unreal MCP plugin → one prompt turns a photo into a mesh AND drops it into your scene. No glue code, no API keys.

6/ Free during the beta. Pricing arrives with code signing (~v1.1). Anyone testing now keeps the build forever.

Try it, break it, tell me what's missing: https://fabienlacaze.github.io/MyFabmesh/
```

---

## 2. Reddit posts

### r/IndieDev (1x par semaine max, lis les rules)
```
**Title:** I built a tool that turns a photo into an editable 3D mesh — public beta is live

I've been working on **MyFabmesh.AI** for a while: drop a reference image, get a textured 3D mesh, then refine **both the photo and the mesh** in the same app. No more bouncing between Photoshop and Blender between iterations.

What it does:
- Image → textured GLB on your own NVIDIA GPU (~60-120s)
- In-app photo editor (mask, inpaint, clone, blur)
- In-app mesh polish (paint on 3D, fix face artefacts, 4K then 8K upscale)
- Built-in MCP server: drive it from Claude Code / VS Code
- Pairs with the community Unreal MCP plugin for one-prompt asset pipelines

It's free during the public beta. Commercial-safe models only (MIT / Apache / BSD / OpenRAIL++-M) so anything you generate is yours to sell.

Requirements: Windows 10/11 + NVIDIA GPU with 8 GB VRAM. Browser-based compatibility check before you commit:
https://fabienlacaze.github.io/MyFabmesh/check.html

Direct page:
https://fabienlacaze.github.io/MyFabmesh/

Happy to answer questions, brutal feedback welcome.
```

### r/unrealengine
```
**Title:** AI mesh generator + Unreal MCP plugin = image to in-scene asset in one prompt

I just shipped the public beta of **MyFabmesh.AI**, an image-to-3D tool that exposes a built-in MCP server. If you've installed the community Unreal Engine MCP plugin, Claude Code (or any MCP client) can chain both:

1. Tell Claude what to build
2. MyFabmesh.AI generates the textured mesh from a reference image
3. Unreal imports the GLB and spawns the actor in your level

No manual export/import, no folder hopping. The whole loop runs locally on your machine, no API keys.

Free during beta. Windows + NVIDIA GPU 8 GB+ for the desktop app (cloud version coming for the rest).

Site: https://fabienlacaze.github.io/MyFabmesh/
Compatibility check: https://fabienlacaze.github.io/MyFabmesh/check.html

Devlog Twitter: [ton handle]
```

### r/blender
```
**Title:** Free beta — image to textured GLB, ready for Blender import

I made a tool that turns reference photos into textured 3D meshes you can drop straight into Blender. The point isn't to replace your modeling — it's to skip the boring "blockout from scratch" part when you have a reference image.

Workflow:
- Drop a photo or sketch
- Tool generates geometry + UV + PBR textures (~60-120s on RTX 3060+)
- Refine the photo, regenerate, or polish the mesh in-app
- Export GLB → File > Import > glTF in Blender

Models are commercial-safe (MIT / Apache / OpenRAIL++-M etc.) so anything you make is yours.

Free during the beta. Windows + NVIDIA 8 GB+ for now (cloud version for the rest later).

https://fabienlacaze.github.io/MyFabmesh/
```

---

## 3. Hacker News — Show HN

```
**Title:** Show HN: MyFabmesh.AI – image to 3D mesh, editable in-app, scriptable from Claude

**Body:**
I shipped a public beta of MyFabmesh.AI today.

It's an Electron app that turns a reference image into a textured 3D mesh on your local NVIDIA GPU, then lets you edit both the source photo and the resulting mesh in the same UI. No round-trip to Photoshop and Blender between iterations.

The differentiator I care about most: it ships an MCP server, so Claude Code in VS Code can drive the whole pipeline. Pair it with the community Unreal Engine MCP plugin and one prompt turns a photo into a mesh AND drops it into your scene.

Stack:
- Electron + Python embedded (no system Python required after install)
- TRELLIS-2 for the geometry, RealVisXL for texture refine, OpenPose ControlNet for back-view, Real-ESRGAN for 8K upscale, BLIP for captioning
- All models commercial-safe (MIT / Apache / BSD / OpenRAIL++-M)
- 142 MB installer, ~15 GB of model weights downloaded on first launch
- Auto-update via electron-updater + GitHub Releases
- Crash reports via Sentry (anonymized)

What I'd love feedback on:
- The "edit photo + edit mesh + regenerate part" loop — does it actually save you time over a Blender round-trip?
- The MCP integration — is anyone else trying to chain MCP servers (Unreal, Blender, Unity) for end-to-end pipelines?
- The Windows-only / NVIDIA-only filter — too restrictive for indie devs?

Free during the beta. Requirements + browser-based PC compatibility checker on the site.

Site: https://fabienlacaze.github.io/MyFabmesh/
GitHub: https://github.com/fabienlacaze/MyFabmesh
```

---

## 4. Product Hunt (à préparer 7 jours en avance)

### Tagline (60 chars max)
```
Image to 3D mesh — editable photo and mesh, scriptable from Claude.
```

### Description (260 chars)
```
MyFabmesh.AI turns a reference photo into a textured 3D mesh on your NVIDIA GPU, then lets you refine the photo, the mesh, and the textures end-to-end in the same app. Free during beta. Pair with Claude Code + Unreal MCP for one-prompt asset pipelines.
```

### Topics
3D · AI · Developer Tools · Productivity · Open Source

---

## 5. Discord communities

À poster dans des servers où la self-promo est OK (r/unrealengine,
r/gamedev, BlenderArtists, lis les règles). Format court :

```
👋 Hey — I just dropped the public beta of MyFabmesh.AI: an image-to-3D mesh tool with in-app photo + mesh editor, built-in MCP server (Claude Code compatible), Unreal MCP pairing.

Free during beta. Windows + NVIDIA 8 GB+.

https://fabienlacaze.github.io/MyFabmesh/

Brutal feedback welcome 🙏
```

---

## 6. YouTubers à contacter (template email)

```
Subject: A 3D mesh generator that takes prompts from Claude Code — would you take a look?

Hi [name],

I'm Fabien, an indie dev. I just shipped the public beta of MyFabmesh.AI — an Electron app that generates textured 3D meshes from reference photos, locally on NVIDIA GPU. The angle I think might interest you: it ships an MCP server, so it pairs with Claude Code + the Unreal Engine MCP plugin to chain "generate mesh → drop into Unreal scene" in a single prompt.

It's free during the beta, no signup, no email gate.

If you have 10 minutes between videos, I'd love to send you a download link and hear if the editing loop (photo + mesh in the same app) saves time over your current workflow.

Site: https://fabienlacaze.github.io/MyFabmesh/

Thanks for considering — even a no answer helps me calibrate.

Fabien
@fabidou (HuggingFace) / fabienlacaze (GitHub)
```

**Cibles prio (gamedev + AI tools)**:
- UnrealSensei
- William Faucher
- Smeaf
- Blender Guru side-channels
- Brackeys (si retour)
- Bad Decisions Studio
- AI Code King
- Matt Wolfe (AI news)

---

## 7. Suggested launch day timeline

**T-3 jours** :
- Product Hunt "Coming soon" page
- Email aux YouTubers
- Discord servers : teaser

**T-1 jour** :
- Tweet teaser ("Launching tomorrow")
- Post Reddit r/IndieDev devlog "shipping tomorrow"

**T-0 (mardi ou mercredi 9h ET = 15h Paris)** :
- 9h00 ET : Product Hunt launch
- 9h15 ET : Tweet d'annonce + thread
- 9h30 ET : Hacker News Show HN
- 9h45 ET : Reddit r/IndieDev
- 10h00 ET : Reddit r/unrealengine
- 10h30 ET : Reddit r/blender
- 11h00 ET : Discord servers
- Pendant la journée : réponds à chaque commentaire en < 30 min

**T+1 à T+7** :
- Devlog itch.io
- Tweets show & tell (creations users)
- Patche les bugs Sentry au fur et à mesure

---

## 8. À PAS faire au launch

- ❌ Pas plus d'1 post Reddit par sub par semaine (sinon shadowban)
- ❌ Pas de cross-posting agressif entre subs
- ❌ Pas d'auto-promo dans des subs qui l'interdisent (r/3DPrinting etc.)
- ❌ Pas mentir sur les specs requises ou la pricing future
- ❌ Pas dire "Microsoft-signed" tant que tu n'as pas le cert
- ❌ Pas mentionner les noms internes des modèles (TRELLIS, RealVisXL, etc.) sauf sur HN où l'audience est dev

---

## 9. Cas où on précise "Generated by AI"

EU AI Act Art. 50 dit que les contenus générés par AI doivent être
labellés. MyFabmesh.AI le fait automatiquement dans le GLB (metadata
`extras.aiGenerated = true` + `asset.generator = "MyFabmesh.AI (AI-generated)"`).
À mentionner si quelqu'un te demande sur Reddit / Twitter — montre
que tu es propre sur la compliance EU.
