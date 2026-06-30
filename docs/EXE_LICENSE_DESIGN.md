# MyFabmesh.AI — Direct-`.exe` License / Payment / Anti-Piracy Architecture

> Design produced 2026-06-30 by a 6-agent architecture workflow, grounded in the real
> code (`cloud/sql/schema.sql`, `cloud/src/worker.ts`, `lib/stripe.ts`, `lib/auth.ts`,
> `lib/packs.ts`, `src/main/main.js`, `src/renderer/wizard.js`, `scripts/hw_detect.py`).
> Applies ONLY to channel (2), the direct `.exe`. Channel (1), the Microsoft Store `.appx`,
> creates **no license row** and the wizard **skips the license step** (build-flag gated).

---

## 1. Architecture overview (purchase → key → activation → re-check)

```
PURCHASE   /buy (or itch/Gumroad → admin mint) → POST /api/checkout (worker.ts:3669)
           metadata.kind='license_purchase', enterprise: adjustable_quantity → seats, NO login required
              ▼ Stripe Checkout
KEY MINT   handleStripeWebhook (3731) → _processLicensePurchase (NEW, mirrors _processPayment 3763)
           idempotent on stripe_session_id · seats from SERVER catalog (never client) ·
           genLicenseKey() → MYFM-XXXX-XXXX-XXXX-XXXX · store key_hash=sha256(key) (NOT plaintext) ·
           _sendEmail key to buyer
              ▼ email + /license/thanks?session_id fallback
ACTIVATION desktop wizard 'license' step (FIRST gate) → src/main/license.js (NEW)
           1. scripts/machine_id.py → machine_hash + label
           2. POST /api/license/activate {key, machine_hash, label} → claim_seat RPC (FOR UPDATE, race-free)
           3. safeStorage.encryptString(token) → userData/license.bin (DPAPI)
              ▼
RE-CHECK   main.js boot + every 24h → POST /api/license/validate {token, machine_hash}
           200 valid:false (revoked/refunded/seat-removed) → wipe + force wizard#license
           5xx/timeout → run on cached token within 14-day grace (monotonic floor, rollback-proof)

REVOCATION charge.refunded/charge.dispute.created → status flip → next /validate de-licenses
ENTERPRISE /account self-serve seats · admin.html "Licenses" tab behind _requireAdmin (TOTP)
```

**Source of truth = Worker + Supabase, never the client.** A patched `.exe` can free *local GPU
generation* (paid one-time anyway) but never cloud credits / animation / marketplace — those stay
gated by `getSessionUser` server-side. The seat ceiling lives in Postgres; no `.exe` patch bypasses it.

---

## 2. Supabase schema — append to `cloud/sql/schema.sql` (single-file canonical schema)

- **`licenses`**: `id, license_key, key_hash (sha256, the hot lookup), buyer_user_id (nullable),
  buyer_email, plan ('individual'|'enterprise'), activation_limit (individual=3; enterprise=Stripe qty),
  status ('active'|'revoked'|'refunded'), admin_user_id (enterprise seat manager), stripe_session_id
  (unique, idempotency), amount_eur, expires_at (NULL=perpetual), created_at, revoked_at`.
- **`license_activations`** (one row per machine holding a seat): `id, license_id, machine_hash,
  machine_label, fingerprint_meta (jsonb, per-component hashes for drift-heal), activation_token,
  status ('active'|'deactivated'), last_ip, first_seen_at, last_seen_at, deactivated_at`.
  - **Seat guarantee** = partial-unique index `(license_id, machine_hash) WHERE status='active'`
    → re-activating the same PC refreshes (no seat consumed); a deactivated machine can re-activate
    (move-to-new-PC, no manual reset).
- **`claim_seat(...)` RPC** (`security definer`, `FOR UPDATE` row lock on the license → atomic
  seat counting, mirrors `spend_credits`/`add_credits`). Returns `{ok, seat:'new'|'existing', used, limit, plan}`
  or `{ok:false, error:'invalid_key'|'seat_limit'|'revoked'|'refunded'|'expired'}`.
- **RLS**: own-row SELECT (`auth.uid() = buyer_user_id or admin_user_id`); writes service-role only.

Resolved contradictions: table names = `licenses`+`license_activations`; seat primitive = Postgres
`claim_seat FOR UPDATE` (not R2 CAS — R2 counter reused only for the per-IP throttle); the partial-unique
`WHERE status='active'` (not plain unique) is what makes re-activation idempotent.

---

## 3. Worker endpoints — added to `cloud/src/worker.ts` (router ~11420)

New `Env.LICENSE_SIGNING_SECRET` (≥32 bytes via `wrangler secret put`, **separate** from other secrets).
Token = JWS-compact over `_hmacSign` (9396): claims `{v,jti,lid,kid,mh,plan,iat,nbf,exp:+30d,gmax:1209600}`.
The `.exe` does NOT verify HMAC offline (symmetric → would leak the keygen secret); offline trust =
DPAPI + machine binding + online cadence. (v2: Ed25519, ship public key only.)
Brute-force throttle on public endpoints: `_casIncrementCounter(... 30/day)` → 429.

**Public (desktop):**
- `POST /api/license/activate` `{key, machine_hash, machine_label, fingerprint_meta?, app_version?}`
  → `{ok:true, status:'activated'|'existing', token, expires_at, seats:{used,limit}, license:{plan,buyer_email}}`
  / `409 seat_limit` / `404 invalid_key` / `403 revoked|refunded|expired`.
- `POST /api/license/validate` `{token, machine_hash}` → `200 {valid:true, token:<fresh>, grace_seconds:1209600, server_time}`
  / `200 {valid:false, reason:...}` (**200 not 5xx** so desktop distinguishes "killed" from "server down → grace").
- `POST /api/license/deactivate` `{token|key, machine_hash}` → frees a seat (idempotent).
- `GET /api/license/by-session?session_id=` → key (email-delivery fallback for /license/thanks).

**Authenticated (enterprise admin, `getSessionUser` + RLS):** `claim-admin` (bind key↔account by email),
`GET /seats`, `POST /seats/revoke`, `POST /seats/label`.

**Super-admin (`_requireAdmin` TOTP + `_auditLog`):** `GET /api/admin/licenses`, `POST .../mint`
(itch/Gumroad hand-issue), `set-status` (instant kill switch), `set-seats` (upsell), `deactivate-seat`,
`anomalies` (velocity view, deferred).

**Webhook (extend `handleStripeWebhook` 3731):** `checkout.session.completed` + `kind==='license_purchase'`
→ `_processLicensePurchase`; `charge.refunded`→status='refunded'; `charge.dispute.created`→flag/review.

---

## 4. Hardware fingerprint — NEW `scripts/machine_id.py` (pure stdlib, no wmic)

**Weighted SET of per-component SHA-256 hashes** (NOT one concatenated hash — so a GPU/RAM/disk swap
can't deactivate a license):

| Component | Source (stdlib) | Weight |
|---|---|---|
| Windows **MachineGuid** (anchor) | `winreg` HKLM\\...\\Cryptography\\MachineGuid | 3 |
| **NVIDIA GPU UUID** (anchor) | `nvidia-smi --query-gpu=uuid` (extends hw_detect.py:37) | 3 |
| **C: volume serial** | `ctypes GetVolumeInformationW` | 1 |

`machine_hash = sha256("v1|" + sorted component hashes)`. Raw values **normalized** (strip OEM junk) and
**never leave the machine** (only hashes + coarse label). **Drift-heal:** on `/validate`, match if weighted
overlap ≥ 4 of 7 (one anchor=3 fails; anchor+volume=4 passes; both anchors=6); on a passing-but-changed
match, rewrite `fingerprint_meta` so identity follows the machine. Motherboard+OS-reinstall = new machine.
(SMBIOS/CPU-id via CIM deferred — needs a PowerShell round-trip; the triad is enough for launch.)

---

## 5. Desktop integration

- **License gate = FIRST wizard step**, before the expensive download (a pirate must not pull 17 GB
  before paying). `STEPS` → `['license','welcome','detect','mode','download','test','no-gpu']`.
- **Boot gate in `main.js createWindow()`**: `const licensed = !app.isPackaged || isLicenseValid();`
  → unlicensed/packaged → `wizard.html#license`; licensed+setup-done → `index2.html`.
- **Token storage = `safeStorage` (DPAPI) only** → `userData/license.bin` (ciphertext; decrypt fail = unlicensed,
  defeats file-copy to PC#2).
- **Offline grace (the hard part):** `monotonic_floor = max(floor, server_time)` advances only forward
  (clock-rollback can't reset the 14-day grace); past grace → app opens but generation disabled.
- **Dev bypass mandatory:** every gate short-circuits on `!app.isPackaged` + optional `FABMESH_DEV_LICENSE=1`.
- New module `src/main/license.js`; `preload.js` exposes `licenseStatus`/`activateLicense`/`licenseSeats`/`deactivateSeat`.

---

## 6. Anti-piracy mitigations, RANKED (honest)

> No client check on an Electron binary is uncrackable (asar extracts trivially). Goal = stop **casual**
> copying; win **server-side where no patch reaches**. The free MS Store tier lowers crack demand.

**MUST-DO (cheap, blocks ~90%, mostly uncrackable):** (1) server-enforced seat limit via `claim_seat`;
(2) valuable cloud features stay `getSessionUser`-gated; (3) machine-bound token + DPAPI at rest;
(4) refund/chargeback webhook → de-license; (5) store only `sha256(key)`; (6) per-IP throttle.
**OPTIONAL (when revenue justifies):** Electron integrity fuses, clock-rollback high-water-mark (already in),
offline gen-count cap, fingerprint in the Python sidecar, anomaly view, Ed25519 tokens.
**DON'T BUILD:** VMProtect/Themida (break on SmartScreen/SAC — see MEMORY), code virtualization, TPM sealing,
VM-detection, per-employee keys by default.

---

## 7. Enterprise seat management

**ONE key with `activation_limit = N`** (Stripe `adjustable_quantity` → `activation_limit = line_item.quantity`).
Reassignment instant (deactivate frees a seat); upsell = bump one number via `set-seats`.
- **Company-admin self-serve** in `cloud/src/app/account/page.tsx` ("License & Seats": seat table, revoke,
  reassign = deactivate-then-activate). Admin bound at checkout or via `claim-admin` (email match), RLS-scoped.
- **Vendor super-admin** = new "Licenses" tab in `cloud/public/admin.html` behind `_requireAdmin`+`_auditLog`.

---

## 8. Sequenced build plan (smallest-shippable-first)

- **Phase 0 — Catalog + schema:** `packs.ts` LICENSES const · append schema §§6-9 · `LICENSE_SIGNING_SECRET`.
- **Phase 1 — MVP single-seat ONLINE activation (revenue path):** worker license branch + endpoints +
  `genLicenseKey` + `_processLicensePurchase`; `scripts/machine_id.py`; `src/main/license.js`; main.js boot gate;
  preload; wizard `'license'` step; buy page SKU. → buy→email→activate→unlock (always-online).
- **Phase 2 — Offline grace + re-check + refund kill:** monotonic-floor 14-day grace; launch+24h `/validate`;
  refund/dispute webhook branches.
- **Phase 3 — Enterprise + seat management:** adjustable_quantity checkout; `/seats*` endpoints; account panel;
  wizard inline seat-manager for the 409 case.
- **Phase 4 — Vendor admin console + hardening:** admin.html Licenses tab; integrity fuses; drift-heal; Ed25519.

**Files touched:** `cloud/sql/schema.sql` · `cloud/src/lib/packs.ts` · `cloud/src/worker.ts` · `cloud/wrangler.toml` ·
`cloud/src/app/buy/page.tsx` · `cloud/src/app/account/page.tsx` · `cloud/public/admin.html` ·
`scripts/machine_id.py` (NEW) · `src/main/license.js` (NEW) · `src/main/main.js` · `src/main/preload.js` ·
`src/renderer/wizard.js` · `src/renderer/wizard.html`.

---

## 9. Open questions (need your decision before building)

1. **Pricing & individual seats** — placeholders €49 individual (3 PCs) / €39-per-seat enterprise. Confirm.
2. **Perpetual vs term** — perpetual one-shot assumed (`expires_at` NULL). Confirm (annual changes Stripe + token TTL).
3. **Offline-grace window** — 14 days proposed (tunable per-plan server-side). Air-gapped studios may need 30+. Gen-cap during grace?
4. **`charge.dispute.created`** — auto-revoke vs flag-for-review? (Recommend: flag on dispute, auto-revoke on refund.)
5. **Bundle cloud credits with a desktop purchase?** (Needs a buyer account; defer grant to account-link.)
6. **Enterprise identity** — each employee their own account (cleaner audit) vs key+token with a shared account?
7. **Gumroad/itch** — all sales via Stripe (auto-mint) or ingest Gumroad webhooks? (Recommend admin-mint only.)
8. **MS Store** — confirm `.appx` creates NO license row + skips the wizard `'license'` step (build-flag).
9. **v2 token** — launch HMAC (online cadence as the boundary), upgrade to Ed25519 later? (Recommended.)
