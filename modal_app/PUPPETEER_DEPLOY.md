# Puppeteer Rig — Modal Deployment

This walkthrough wires the **auto-rigging** Modal endpoint
(`modal_app/_puppeteer_rig.py`) to the Cloudflare cloud worker so that the
**Generate Rig** button on the cloud UI starts producing rigged GLBs.

End-to-end first-time setup takes ~10 minutes; subsequent re-deploys are
~2 minutes.

---

## 1. Prerequisites

Install the Modal CLI and authenticate (one-time per machine):

```bash
pip install modal
modal token new
```

`modal token new` opens a browser to confirm — make sure you log in with
the workspace that owns the MyFabmesh project.

---

## 2. Create the Hugging Face secret on Modal

The rigging model pulls weights from Hugging Face, so the Modal container
needs a token with `read` scope on gated models:

```bash
modal secret create huggingface HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxxxxxx
```

Get a token at https://huggingface.co/settings/tokens — `read` is enough.

---

## 3. Deploy the Modal app

From the repo root:

```bash
modal deploy modal_app/_puppeteer_rig.py
```

When the build finishes, Modal prints a public URL such as:

```
https://fabien--myfabmesh-puppeteer-rig.modal.run
```

**Copy that URL** — you'll paste it into Cloudflare next.

---

## 4. Register the URL with Cloudflare Workers

From `cloud/`:

```bash
cd cloud
wrangler secret put MODAL_PUPPETEER_RIG_URL
# paste the URL from step 3, press Enter
```

The worker (`src/worker.ts`) reads this secret and routes
`POST /api/rig` to the Modal endpoint when it is set.

---

## 5. Rebuild + redeploy the cloud worker

The static frontend embeds feature flags at build time, so you MUST
rebuild before redeploying:

```bash
cd cloud
npm run build
npx wrangler deploy
```

Skipping `npm run build` is the #1 cause of "I deployed but nothing
changed" — `out/` is what `wrangler deploy` actually uploads.

---

## 6. Smoke test

Open https://myfabmesh-cloud.fabien65400.workers.dev , then:

1. Sign in.
2. Generate (or upload) an image.
3. Generate a 3D mesh.
4. Click **Generate Rig**.

Expected timing:

- **Cold start (first call of the day)**: 3 – 5 min
- **Warm**: ~1.5 min

Output: a rigged `.glb` available in the Library, downloadable and
ready for UE5 / Blender import.

---

## 7. Cost estimate

Puppeteer runs on an **A10G GPU** (~ \$1.10 / hr on Modal).

Per rig job: ~2 min of GPU time → **~ \$0.04 raw GPU cost** per rig.

Add ~10 s of CPU container overhead → negligible. Storage on R2 for the
rigged GLB: well under \$0.001 / file.

Daily safety cap is shared with the other Modal endpoints via
`MAX_DAILY_MODAL_SPEND_USD` in `cloud/wrangler.toml` — tune that ceiling
once real user volume kicks in.

---

## Rollback

To disable the rig button on the cloud UI (hides it client-side because
the worker stops advertising the capability):

```bash
cd cloud
wrangler secret delete MODAL_PUPPETEER_RIG_URL
npx wrangler deploy
```
