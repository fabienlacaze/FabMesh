# MyFabmesh.AI — Beta release readiness

3 things to set up before pushing the beta to Gumroad / itch.io.
All zero-cost, all done by **you** (the dev) — I (Claude) cannot
create accounts on third-party services for you.

---

## 1. HuggingFace fallback token (5 min)

**Why** : if HF rate-limits an anonymous download mid-install, the
wizard retries with this token. Read-only token = safe to ship in
the binary, gives the user a higher quota without any private access.

**Steps** :

1. Go to https://huggingface.co/join (free account, ~30 sec)
2. Verify your email
3. https://huggingface.co/settings/tokens → **New token**
4. Settings:
   - Name : `myfabmesh-fallback-readonly`
   - Type : **Read** (NEVER Write — never)
   - Repositories : leave default (all public)
5. Click **Create token**
6. Copy the token (starts with `hf_`)
7. Paste it into `scripts/wizard_download.py` line 32:
   ```python
   HF_FALLBACK_TOKEN = 'hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
   ```
8. Rebuild the installer: `npm run build:installer`
9. Re-upload the new installer to the GitHub release v1.0.0-beta

---

## 2. Sentry crash reporting (15 min)

**Why** : when a user hits a crash, the stack trace lands in your
Sentry dashboard automatically. No more "it doesn't work" tickets
without context.

**Steps** :

1. Go to https://sentry.io/signup/ (free developer tier: 5K events/mo,
   1 user, no credit card needed)
2. Verify your email
3. **Create a project**:
   - Platform : choose **Electron**
   - Alert frequency : "On every new issue" is fine for now
   - Team : default (Personal)
   - Project name : `myfabmesh-ai-desktop`
4. After creation, Sentry shows the **DSN** — it looks like:
   ```
   https://abc123def456@o4501234.ingest.sentry.io/4501234
   ```
5. Create the file `build/sentry-dsn.txt` (one line, the DSN):
   ```
   echo "https://abc123def456@o4501234.ingest.sentry.io/4501234" > build/sentry-dsn.txt
   ```
6. Rebuild the installer: `npm run build:installer`

After release, watch your Sentry dashboard at sentry.io — crashes
appear within ~30 seconds of happening on a user machine, with full
stack trace, OS, GPU, the works. Tutorial: https://docs.sentry.io/platforms/javascript/guides/electron/

**Privacy note** : the SDK strips Windows username and machine name
before sending (see `_initSentry` in `src/main/main.js`). Only the
stack trace + app version + OS are shipped. No PII.

---

## 3. Test wizard on a clean machine (1-7 days, depending on access)

**Why** : your dev box has Python, CUDA, models, drivers, all
already set up. A clean Windows machine has none of that. Most
install bugs only show up there.

**Easiest path: a clean Windows 11 VM**

1. Download Win11 ISO from Microsoft (free)
2. Install Hyper-V or VirtualBox (free)
3. Create a VM with **24 GB RAM, no GPU passthrough** (for now)
4. Mount the ISO, install Windows
5. Inside the VM:
   - Browse to your `fabienlacaze.github.io/MyFabmesh/` site
   - Click "Download — Free beta"
   - Run the installer
   - Walk through the wizard
   - Note every weird thing
6. Even **without a GPU**, the wizard should detect "no NVIDIA",
   skip Mode page, and route to the Cloud screen — this exercises
   the no-GPU branch which is the most fragile.

**Better path: a friend's laptop**

If you have access to a non-dev PC (gamer friend with RTX, etc.):
1. Same procedure: download from site, run installer
2. Verify wizard renders correctly (resolution, scaling)
3. Run a real generation to verify the model download + first mesh
4. Note time taken at each step (for the FAQ "how long does it
   take" question)

**Test matrix** :

| Config | What to verify |
|---|---|
| Win 11 VM, no GPU | "No compatible GPU" screen + Cloud redirect link |
| Win 10 host, GTX 1660 (6 GB) | Mode = Lite, models download OK, generation works |
| Win 11 host, RTX 3060 / 4070 / 5080 | Mode = Standard or Full, smoke test passes |
| Win 11 + Smart App Control ON | Installer blocked at SmartScreen — note exact warning text |
| Antivirus other than Defender | App not killed mid-launch |
| Network drops mid-download | Resume works on relaunch |

Capture any glitch in a screenshot, share back to me, I'll patch.

---

## 4. After the 3 items above

When all three are done (`HF_FALLBACK_TOKEN` filled, `build/sentry-dsn.txt`
created, beta-tested on at least one clean machine), you're cleared
to:

- Re-build: `npm run build:installer`
- Upload to the GitHub release: `gh release upload v1.0.0-beta dist/installer/MyFabmesh.AI-Setup-1.0.0.exe --clobber`
- Announce on Reddit / Twitter / Discord
- Submit to Fab.com (review takes 7-14 days)
- Listing on itch.io and Gumroad (live immediately)

Don't wait for code signing — beta users on Gumroad / itch.io expect
the SmartScreen warning. The signed v1.1 comes after the first 15
sales (Azure Trusted Signing ~110€/year).
