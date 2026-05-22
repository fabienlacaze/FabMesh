# MyFabmesh.AI — Gumroad + itch.io listings

Two stores, two listings, ~1 h total. Both free. Both let you go live
immediately (no review process). They can stay live alongside Fab.com
when that one is approved.

---

## 1. Gumroad listing (~25 min)

### Why Gumroad first
- Live in minutes, no review
- 10% + 0.30 € per sale
- Direct deposit to your bank account
- Free `gumroad.com/l/<slug>` page (own domain optional later)

### Steps

1. https://app.gumroad.com/signup if you don't have an account
2. **Products → New product**
3. **Type** : "Digital product"
4. **Name** : `MyFabmesh.AI — image to 3D mesh generator`
5. **Price** : 0 € (free during beta) — use the "Pay what you want"
   option with a 0 € floor so beta users can tip if they want
6. **What's included** :
   ```
   • Windows installer (~146 MB, .exe)
   • First-run wizard: hardware check, model download, smoke test
   • ~15 GB of AI models downloaded on first launch
   • Free lifetime updates during the public beta
   ```
7. **Cover image** : a 16:9 PNG that hooks. Use one of the slideshow
   screenshots — `docs/screenshots/02-generate.png` is a good start.
8. **Product file** : use the **GitHub Releases URL** as the redirect
   instead of uploading 146 MB:
   - Go to **Settings → Page** of your Gumroad product
   - Add a "Custom download URL" pointing to:
     ```
     https://github.com/fabienlacaze/MyFabmesh/releases/latest/download/MyFabmesh.AI-Setup-1.0.0.exe
     ```
   - This way Gumroad doesn't bill you for storage and the link always
     points to the latest release.
9. **Description** : paste the block at the bottom of this file.
10. **Tags** : `3d, ai, generative, unreal, blender, unity, indie,
    gamedev, mesh, texture, indie-tools`
11. **Publish** — your product is live at
    `https://fabidou.gumroad.com/l/myfabmesh-ai` (or similar).

### Tracking
- Gumroad has built-in analytics: visits, conversions, geo.
- Pin the link in your social bios.

---

## 2. itch.io listing (~25 min)

### Why itch.io
- Free, 10% default (adjustable down to 0%)
- Indie / experimental audience already there
- "Devlog" feature is great for building public following
- No external bank account required (PayPal or Stripe)

### Steps

1. https://itch.io/register if you don't have an account
2. **Upload new project** (top-right user menu → "Upload new project")
3. **Title** : `MyFabmesh.AI`
4. **Project URL** : `myfabmesh-ai` (the slug)
5. **Short description** : "Image to 3D mesh generator. Edit photo,
   mesh, and textures end-to-end — no round-trips."
6. **Classification** : Tools
7. **Kind of project** : Downloadable
8. **Pricing** :
   - "Pay what you want" with **minimum 0 €** for the beta
   - Later when you exit beta: switch to "Paid" with 24.99 €
9. **Uploads** :
   - Click **"Upload files"** → name it `MyFabmesh.AI-Setup-1.0.0.exe`
   - itch.io has a 1 GB / file limit, you're at 146 MB so direct upload works
   - Check **"This file will be played in the browser"** OFF
   - Set the platform : **Windows**
10. **Description** : same long-form text as Gumroad (see bottom)
11. **Screenshots** : upload 3-5 from `docs/screenshots/` — itch.io
    has a dedicated screenshots block on the page
12. **Cover image** : 630×500 minimum, use a wide crop of slide 02
13. **Genre** : Other → "AI" or "Procedural generation"
14. **Tags** : `3d, ai, generator, mesh, unreal, blender, unity, indie-tool`
15. **Visibility** : Public (live immediately)

### itch.io devlog
After launch, post a devlog whenever you ship v1.x — itch.io
notifies followers and surfaces it on the front page if it's good.

---

## 3. Same description for both (copy-paste)

```
MyFabmesh.AI — image to 3D mesh, edit every step.

Generate textured, game-ready 3D meshes from any reference image,
then refine the photo, the mesh, and the textures directly inside
the app. Paint, mask, inpaint, retouch geometry. End-to-end, no
round-trips to Photoshop or Blender.

📦 What you get
• Windows installer (~146 MB)
• Hardware auto-detection wizard
• AI model bundle downloaded on first run (~15 GB)
• Lifetime updates during the public beta
• Built-in MCP server: drive everything from Claude Code / VS Code
• Optional Unreal Engine plugin pairing (community MCP)

✅ Commercial-safe AI
All bundled AI models use commercial-safe licenses (MIT, Apache 2.0,
BSD, OpenRAIL++-M). Your generated meshes are 100% yours to sell on
Fab.com, Sketchfab, Unity Asset Store, or anywhere.

⚙️ Requirements
• Windows 10/11 (64-bit)
• NVIDIA GPU with 8 GB VRAM (12 GB+ recommended)
• 16 GB RAM, 30 GB free disk
• Internet on first launch only (model download)

🌐 Site & support
https://fabienlacaze.github.io/MyFabmesh/

🆓 Why free during beta?
We're still polishing rough edges and gathering feedback. Expect
some Windows SmartScreen warnings until v1.1 ships with code
signing (Azure Trusted Signing). Crash reports are sent
anonymously via Sentry so we can fix what we see.
```

---

## 4. After both listings are live

1. Add the **Gumroad link** and **itch.io link** to:
   - Your Twitter / X bio
   - Bluesky bio
   - GitHub profile
   - YouTube channel description
2. Post the launch:
   - 1 tweet with a GIF of a generation
   - 1 itch.io devlog "MyFabmesh.AI beta is live — here's what it does"
   - r/IndieDev or r/unrealengine (read the rules — self-promo allowed
     in specific weekly threads)
3. Watch Gumroad / itch.io / Sentry / GitHub Insights for the first
   downloads. Fix what shows up in Sentry first, that's the dataset
   that matters most.

---

## 5. When you exit beta

Switch both listings:
- Price : 0 → **24,99 €** (final beta tester emails get a discount
  code via Gumroad "View All Customers" → bulk email)
- Description : remove "during public beta", add the "Sign-by-Microsoft
  via Azure Trusted Signing" badge

You don't need to delete and recreate — both stores let you edit
the price + description of a live product without losing reviews.
