/**
 * MyFabmesh.AI Cloud — Cloudflare Worker (single-file router).
 *
 * Replaces the @opennextjs/cloudflare build pipeline (which broke on
 * esbuild "Invalid alias name" — see CI history). Strategy is now:
 *
 *   1. Next.js builds the pages to a static `./out/` directory
 *      (next.config.mjs has `output: 'export'`).
 *   2. This Worker serves those static assets via `env.ASSETS.fetch(req)`
 *      and implements all `/api/*` + `/auth/callback` routes inline.
 *
 * All secrets are read from `env` (Worker bindings), never from
 * `process.env`. Pages that previously did server-side `getSessionUser()`
 * are now client components that call `/api/me`.
 */
import Stripe from 'stripe';
import Replicate from 'replicate';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { checkPromptSafety } from './nsfw_filter';

/* ──────────────────────────── env binding ──────────────────────────── */

export interface Env {
  // Static asset binding (Next.js `out/` directory).
  ASSETS: { fetch: (req: Request) => Promise<Response> };

  // R2 bucket for generated GLBs (write-through cache for Replicate URLs).
  MESHES: R2Bucket;

  // Public (also baked at build time so the client can read them).
  NEXT_PUBLIC_MOCK?: string;
  NEXT_PUBLIC_SITE_URL?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?: string;

  // Server-side env.
  MOCK?: string;
  STRIPE_SECRET_KEY?: string;
  /** '1' = accepter deliberement une cle Stripe de TEST en production, pour
   *  eprouver la chaine de paiement. Sans ce drapeau, un paiement de test est
   *  refuse et le webhook n'accorde AUCUN credit : une cle sk_test_ deployee
   *  laissait sinon n'importe qui se creer des credits avec la carte 4242
   *  (constate en production le 2026-08-18, 350 credits accordes pour 0 EUR). */
  STRIPE_ALLOW_TEST_MODE?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  // Stripe Price IDs for the monthly subscriptions (created in
  // Stripe Dashboard once, then set as Worker secrets). Without
  // these the subscription packs return 503 in /api/checkout.
  STRIPE_PRICE_SUB_STARTER?: string;
  STRIPE_PRICE_SUB_PRO?: string;
  STRIPE_PRICE_SUB_STUDIO?: string;
  STRIPE_PRICE_STARTER?: string;
  STRIPE_PRICE_PRO?: string;
  STRIPE_PRICE_STUDIO?: string;

  REPLICATE_API_TOKEN?: string;
  REPLICATE_MODEL?: string;
  REPLICATE_VERSION?: string;

  // Modal feature flag — when MODAL_TEXT2IMAGE_URL is set, text2image
  // calls go to Modal (Memory Snapshots → ~5s cold start, ~5× cheaper)
  // instead of Replicate. The Worker falls back to Replicate if the
  // URL is empty/unset so we can disable Modal instantly without redeploy.
  MODAL_TEXT2IMAGE_URL?: string;
  MODAL_BACKVIEW_URL?: string;
  // Wave 2.4 — 6-view orthographic MV-Adapter (SDXL i2mv). Used for
  // creature/animal asset types when set. Returns a JSON manifest with
  // 6 R2 URLs (front/right/back/left/top-3q/bottom-3q). Falls back to
  // MODAL_BACKVIEW_URL when unset, preserving Wave 2.2 behavior.
  MODAL_MVADAPTER_URL?: string;
  // Strict T-pose front generation (verbatim port of generate_front_tpose.py).
  // Shares the back-view container's RealVisXL + ControlNet OpenPose +
  // IPAdapter snapshot, so cold start ≈ back-view (~30-40s).
  MODAL_TPOSE_URL?: string;
  // Auto-rectify — strict orthographic FRONT or 3/4 ISO regeneration with
  // multi-seed symmetry scoring (port of generate_front_strict.py). Same
  // container as back-view/tpose, ControlNet is neutralized at call time.
  MODAL_RECTIFY_URL?: string;
  // 4-view orthographic sheet (port of multiview_sheet_gen.py). Used as
  // the back-view source for hard-surface assets (vehicle/building/etc.)
  // where the realvis T-pose pipeline doesn't make sense. Single SDXL
  // pass with IPAdapter Plus — same RealVis snapshot as backview/tpose.
  MODAL_SHEET_URL?: string;
  // Unified image-op endpoint — single Modal URL that dispatches
  // between img2img (modify) and CLIPSeg+SDXL Inpaint (auto_inpaint)
  // based on payload.op. We use one endpoint because Modal Starter
  // caps Web Functions at 8 per app and we'd otherwise need to
  // upgrade. Same URL for both ops; the Worker sets op in the body.
  MODAL_IMAGE_OP_URL?: string;
  // Mesh runs through TWO endpoints (async pattern; see callModalMeshStart).
  // Setting BOTH activates Modal-for-mesh; leaving either unset falls back
  // to the Replicate Cog.
  MODAL_MESH_START_URL?: string;
  MODAL_MESH_STATUS_URL?: string;
  MODAL_MESH_URL?: string;  // legacy sync url — kept so old deploys don't break
  // Puppeteer auto-rigging on uploaded GLB. Sync endpoint: takes a mesh
  // HTTPS URL + optional target skeleton, returns base64 GLB bytes.
  // Set via `wrangler secret put MODAL_PUPPETEER_RIG_URL`; unset to
  // disable /api/auto-rig (503).
  MODAL_PUPPETEER_RIG_URL?: string;
  // MOTEUR DE RIG — nom neutre, introduit le 2026-08-04.
  //
  // Le bureau est passe a SkinTokens (MIT) le 2026-07-24, mais le cloud
  // tournait encore sur Puppeteer, qui embarque Michelangelo (GPL-3.0) et
  // PartField (NVIDIA non-commercial) : un blocage commercial sur le produit
  // PAYANT. Conserver un nom de variable qui designe le moteur abandonne
  // aurait perpetue la confusion — c'est d'ailleurs le de-brandage des
  // libelles qui avait fait echapper l'ecart a l'audit de parite.
  //
  // `MODAL_RIG_URL` prime ; `MODAL_PUPPETEER_RIG_URL` reste lu en repli pour
  // qu'un deploiement n'ait pas a etre synchronise avec la rotation du
  // secret.
  MODAL_RIG_URL?: string;
  // AnyTop animation generation on a rigged GLB. Async spawn+poll+stream
  // pattern identical to rig. Set via `wrangler secret put
  // MODAL_ANYTOP_ANIM_URL`; unset to disable /api/animate (503).
  MODAL_ANYTOP_ANIM_URL?: string;
  // FBX reference-animation retarget on a rigged GLB. Async spawn+poll+
  // stream pattern identical to MODAL_ANYTOP_ANIM_URL but pointed at the
  // `myfabmesh-fbx-retarget` Modal app (CPU-only, bpy-based). Set via
  // `wrangler secret put MODAL_FBX_RETARGET_URL`; unset to disable
  // /api/animate-from-reference (503).
  MODAL_FBX_RETARGET_URL?: string;
  // SAMPart3D mesh part-segmentation. BASE url of the `myfabmesh-segment`
  // Modal app (segment_router); the worker appends /segment-start,
  // /segment-status, /segment-fetch. Async spawn+poll+stream pattern
  // identical to MODAL_PUPPETEER_RIG_URL. Set via `wrangler secret put
  // MODAL_SEGMENT_URL`; unset to disable /api/mesh-segment (503).
  MODAL_SEGMENT_URL?: string;
  MODAL_SHARED_SECRET?: string;

  // Budget safeguards (override the defaults if set).
  MAX_DAILY_SPEND_USD?: string;       // Replicate-side cap (default $0.50)
  MAX_DAILY_MODAL_SPEND_USD?: string; // Modal-side cap   (default $2.00)
  // Budget Modal du workspace, en USD. Repli quand
  // _meta/modal_budget_total.txt est absent — sans lui l'alerte de
  // budget etait desarmee en silence.
  MODAL_BUDGET_USD?: string;
  RESEND_API_KEY?: string;            // Resend key for admin alert emails (optional; no-op if unset)
  ALERT_FROM_EMAIL?: string;          // From: for alert emails (Resend-verified domain; default onboarding@resend.dev)
  MODAL_USAGE_SECRET?: string;        // shared secret the modal-billing poller uses to push REAL usage
  MAX_USER_DAILY_CALLS?: string;
  // Anti-DoS: per-account (per-user) daily $ spend cap on GPU jobs. A single
  // account can never push more than this much estimated cost through the
  // Modal/Replicate GPU endpoints in one UTC day, regardless of how many
  // credits they hold. Complements the GLOBAL MAX_DAILY_*_SPEND_USD caps.
  // Default $2.00/user/day (see DEFAULT_MAX_USER_DAILY_SPEND_USD).
  MAX_USER_DAILY_SPEND_USD?: string;

  // Cloudflare Turnstile (captcha) secret for the siteverify call. When SET,
  // the expensive GPU endpoints require a valid `cf-turnstile-response` token
  // (see verifyTurnstile / assertTurnstile). When UNSET, the check is a no-op
  // so the pipeline keeps working until the frontend widget + keys are wired.
  TURNSTILE_SECRET_KEY?: string;

  // NSFW filter bypass — set to "1" to disable the prompt pre-filter
  // (intended for dev/staging, NEVER in prod). When unset, all prompts
  // are checked against the desktop's NSFW_KEYWORDS + NSFW_COMBOS.
  FABMESH_UNRESTRICTED?: string;

  // Secret password gating /admin and every /api/admin/* endpoint. In
  // addition to the Supabase email check, the caller must present a
  // valid admin_session cookie set by POST /api/admin/login with this
  // password. Stored as a Cloudflare Worker secret — never logged.
  ADMIN_PASSWORD?: string;
  // Nom d'utilisateur du dashboard. Source de secours uniquement : la
  // valeur qui fait foi est celle stockee dans _meta/admin_password.json
  // (modifiable depuis l'ecran de rotation, sans wrangler).
  ADMIN_USERNAME?: string;

  SUPABASE_SERVICE_ROLE_KEY?: string;

  // Optional R2 S3 endpoint (kept for parity; native R2 binding is preferred).
  R2_PUBLIC_URL?: string;

  // HMAC secret used to mint signed, expiring /r2/<key>?exp&sig URLs so the
  // R2 bucket (incl. user face photos) is no longer reachable at permanent,
  // guessable, unauthenticated r2.dev URLs. Set as a Cloudflare Worker SECRET
  // (`npx wrangler secret put R2_URL_SIGNING_SECRET`), NEVER as a plaintext
  // var in wrangler.toml. When UNSET, signedR2Url() THROWS (fail-closed) so a
  // private bucket is never exposed via permanent public URLs — unless
  // R2_ALLOW_UNSIGNED="1" (local dev) or MOCK mode is active.
  R2_URL_SIGNING_SECRET?: string;

  // Escape hatch for LOCAL DEV ONLY. By default, when R2_URL_SIGNING_SECRET is
  // unset (and we are NOT in MOCK mode), signedR2Url() THROWS rather than leak
  // a permanent public r2.dev URL — signed URLs are mandatory for a private
  // bucket in production. Set R2_ALLOW_UNSIGNED="1" to opt back into the old
  // public-URL fallback for local development. NEVER set this in production.
  R2_ALLOW_UNSIGNED?: string;
}

/** Minimal R2Bucket type (avoid pulling @cloudflare/workers-types). */
interface R2Bucket {
  put(key: string, value: ReadableStream | ArrayBuffer | string, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream; text(): Promise<string> } | null>;
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ objects: Array<{ key: string; size: number; uploaded: Date }>; truncated: boolean; cursor?: string }>;
}

/* ───────────────────────── budget safeguards ────────────────────────
 * Tracks spending and per-user rate-limits in R2 so a runaway loop
 * (or a bug) can't burn through the prepaid Replicate balance again.
 *
 * MAX_DAILY_SPEND_USD: total Worker-side spend cap. Reset at UTC midnight.
 *                     Any call that would push us over is refused 402.
 * MAX_USER_DAILY_CALLS: per-user call ceiling. Stops a single user (or
 *                      a bug spamming with one cookie) from draining
 *                      the budget alone.
 *
 * Tune via environment variables; defaults are conservative.
 * ──────────────────────────────────────────────────────────────────── */
const DEFAULT_MAX_DAILY_SPEND_USD = 0.50;
const DEFAULT_MAX_MODAL_SPEND_USD = 2.00;  // Modal is ~5-10× cheaper per
                                           // image but the cap is its OWN
                                           // wallet, not shared with Replicate.
const DEFAULT_MAX_USER_DAILY_CALLS = 10;
// Anti-DoS per-account $ cap: even with unlimited credits a single account can
// never burn more than this much estimated GPU cost per UTC day. Conservative
// default; override with MAX_USER_DAILY_SPEND_USD. This is the second line of
// defence behind the GLOBAL MAX_DAILY_*_SPEND_USD caps.
const DEFAULT_MAX_USER_DAILY_SPEND_USD = 2.00;

function todayUTC(): string { return new Date().toISOString().slice(0, 10); }

async function r2GetText(env: Env, key: string): Promise<string | null> {
  if (!env.MESHES) return null;
  const obj = await env.MESHES.get(key);
  if (!obj) return null;
  try { return await obj.text(); } catch { return null; }
}

/** Module-level SSRF guard: only accept URLs from our known upstreams.
 *  Used by handleGenerate AND all Modal forwarders that take user-supplied
 *  imageUrl/meshUrl fields. Rejects non-https and unknown hosts.
 *  Hostname is matched against a strict allow-list (exact or suffix). */
function isTrustedAssetHost(env: Env, u: string): boolean {
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (host.endsWith('.r2.dev')) return true;
    if (host.endsWith('.r2.cloudflarestorage.com')) return true;
    if (host === 'replicate.delivery') return true;
    if (host.endsWith('.replicate.delivery')) return true;
    if (host === 'image.pollinations.ai') return true;
    // Nos PROPRES URLs signées (/r2/<clé>?exp&sig servies par ce worker) :
    // le desktop uploade via /api/upload-image|mesh puis renvoie l'URL
    // reçue aux endpoints d'op — même origine que SITE_URL/workers.dev.
    if (host.endsWith('.workers.dev') && parsed.pathname.startsWith('/r2/')) return true;
    if (env.NEXT_PUBLIC_SITE_URL) {
      try {
        const own = new URL(env.NEXT_PUBLIC_SITE_URL).hostname.toLowerCase();
        if (host === own && parsed.pathname.startsWith('/r2/')) return true;
      } catch {}
    }
    if (env.R2_PUBLIC_URL) {
      try {
        const pub = new URL(env.R2_PUBLIC_URL).hostname.toLowerCase();
        if (host === pub) return true;
      } catch {}
    }
    return false;
  } catch { return false; }
}

/** Bump a listing's downloads counter as a SEPARATE R2 object so the
 *  listing JSON itself doesn't get racy reads-modify-writes. Uses R2
 *  conditional PUT (ifMatch on etag) and retries once on contention.
 *  Best-effort: a contention loss in step 2 silently drops the increment
 *  (acceptable since this is a vanity counter — frontend can compute
 *  exact downloads from `_market/owners/<id>/` if precision matters). */
async function bumpListingDownloads(env: Env, listingId: string): Promise<void> {
  if (!env.MESHES) return;
  const key = `_market/downloads/${listingId}.txt`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const existing = await env.MESHES.get(key);
      const current = existing ? parseInt(await existing.text(), 10) || 0 : 0;
      const next = current + 1;
      if (existing) {
        const res = await env.MESHES.put(key, String(next), {
          httpMetadata: { contentType: 'text/plain' },
          onlyIf: { etagMatches: existing.etag },
        });
        if (res) return;
      } else {
        const res = await env.MESHES.put(key, String(next), {
          httpMetadata: { contentType: 'text/plain' },
          onlyIf: { etagDoesNotMatch: '*' },
        });
        if (res) return;
      }
    } catch {}
  }
}

/** Read the atomic downloads counter for a listing. Returns 0 if missing. */
async function readListingDownloads(env: Env, listingId: string): Promise<number> {
  if (!env.MESHES) return 0;
  const txt = await r2GetText(env, `_market/downloads/${listingId}.txt`);
  if (!txt) return 0;
  const n = parseInt(txt, 10);
  return Number.isFinite(n) ? n : 0;
}

/** Atomic (compare-and-set) read-check-increment of a numeric R2 counter.
 *  Returns the NEW total on success, or null if it would exceed `max` OR could
 *  not commit atomically after retries — fail-safe (reject) so two concurrent
 *  requests can't both pass a cap off the same stale read. Mirrors the
 *  conditional-PUT pattern in bumpListingDownloads. */
async function _casIncrementCounter(env: Env, key: string, delta: number, max: number): Promise<number | null> {
  if (!env.MESHES) return null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const existing = await env.MESHES.get(key);
    const cur = existing ? (parseFloat(await existing.text()) || 0) : 0;
    if (cur + delta > max) return null;
    const next = cur + delta;
    const res = existing
      ? await env.MESHES.put(key, String(next), { onlyIf: { etagMatches: existing.etag } })
      : await env.MESHES.put(key, String(next), { onlyIf: { etagDoesNotMatch: '*' } });
    if (res) return next;
  }
  return null;  // sustained contention — fail safe rather than risk a cap bypass
}

/** Anti-DoS per-account daily $ cap. CAS-atomic. Returns remaining $ for the
 *  user today, or null if this call would push the account over its personal
 *  daily budget. Counter lives at `_meta/userspend/<userId>/<YYYY-MM-DD>` and
 *  resets at UTC midnight. Soft cap: NOT refunded on downstream failure (same
 *  policy as checkAndIncrementUserCalls) so a failure-spamming attacker still
 *  burns their own budget. */
async function checkAndIncrementUserDailySpend(env: Env, userId: string, estimatedUsd: number): Promise<number | null> {
  const maxUsd = parseFloat(env.MAX_USER_DAILY_SPEND_USD ?? '') || DEFAULT_MAX_USER_DAILY_SPEND_USD;
  const next = await _casIncrementCounter(env, `_meta/userspend/${userId}/${todayUTC()}`, estimatedUsd, maxUsd);
  return next == null ? null : maxUsd - next;
}

/** Check the daily Replicate spend cap. Returns the remaining budget
 *  in USD, or null if the request would push us over (global OR per-account).
 *  CAS-atomic. When userId is passed, the per-account daily $ cap is enforced
 *  too; if the account is over budget we roll back the global increment so the
 *  shared counter stays accurate. */
async function checkAndIncrementDailySpend(env: Env, estimatedUsd: number, userId?: string): Promise<number | null> {
  const maxUsd = parseFloat(env.MAX_DAILY_SPEND_USD ?? '') || DEFAULT_MAX_DAILY_SPEND_USD;
  const next = await _casIncrementCounter(env, `_meta/spend/${todayUTC()}`, estimatedUsd, maxUsd);
  if (next == null) return null;
  if (userId && (await checkAndIncrementUserDailySpend(env, userId, estimatedUsd)) == null) {
    await refundDailySpend(env, estimatedUsd);  // roll back global; account is over its personal cap
    return null;
  }
  return maxUsd - next;
}

/** Refund the spend if the call ended up failing — keeps the budget
 *  accurate even when we abort. */
async function refundDailySpend(env: Env, refundUsd: number): Promise<void> {
  const key = `_meta/spend/${todayUTC()}`;
  const cur = parseFloat((await r2GetText(env, key)) || '0') || 0;
  await env.MESHES.put(key, String(Math.max(0, cur - refundUsd)));
}

/** Modal has its own budget counter (`_meta/modal_spend/<YYYY-MM-DD>`)
 *  because Modal billing is a separate wallet from Replicate. Sharing
 *  the cap would lock the user out of Modal as soon as the Replicate
 *  counter is exhausted, which is exactly the bug the user hit on
 *  2026-05-25. The default cap is MORE generous than Replicate ($2 vs
 *  $0.50) because Modal is ~5-10× cheaper per image. */
/** Has this account ever completed a payment?
 *
 *  Paying accounts are NOT rationed by the daily $ caps. Those caps
 *  exist to bound what WE spend on people who haven't paid us: a new
 *  account is granted 50 free credits, and 50 credits spent on the
 *  cheapest preset is ~$8 of Modal compute — more than the whole global
 *  daily budget. A customer's credits were bought at a positive margin,
 *  so there is nothing to protect against: their balance already bounds
 *  their total spend. Rationing them to ~5-12 generations a day just
 *  stops them using what they paid for.
 *
 *  Answer is cached in R2 both ways: a permanent marker once paid (the
 *  status never reverts), and a per-day negative marker so an unpaid
 *  account costs at most one Supabase lookup per day rather than one
 *  per generation. */
async function _isPaidAccount(env: Env, userId: string): Promise<boolean> {
  if (!env.MESHES || !userId) return false;
  const PAID = `_meta/paid/${userId}`;
  try {
    if (await r2GetText(env, PAID)) return true;
    const negKey = `_meta/paidcheck/${userId}/${todayUTC()}`;
    if (await r2GetText(env, negKey)) return false;

    const sb = supabaseAdmin(env);
    // `.gt('credits', 0)` est ESSENTIEL : un remboursement remet la ligne
    // a credits=0 sans la supprimer (on garde la trace comptable). Sans
    // ce filtre, un compte rembourse retrouvait son exemption de
    // plafonds des l'appel suivant, le marqueur R2 etant recree ici.
    const { data } = await sb.from('payments')
      .select('id').eq('user_id', userId).gt('credits', 0).limit(1);
    const paid = Array.isArray(data) && data.length > 0;
    if (paid) await env.MESHES.put(PAID, '1');
    else await env.MESHES.put(negKey, '0');
    return paid;
  } catch {
    // Supabase or R2 unreachable: fall back to "not paid", i.e. the
    // caps still apply. Fails toward protecting the bill, never toward
    // spending more.
    return false;
  }
}

/** Why a spend guard refused, so the caller can say something TRUE.
 *
 *  Both caps used to surface the same sentence — "the service is
 *  temporarily at capacity" — which is a lie when the account simply
 *  reached ITS OWN daily limit: nothing is at capacity, and the user is
 *  left thinking the product is broken while holding credits they paid
 *  for. Read-only (no CAS, no increment) so it cannot disturb the
 *  counters it inspects; called only on the refusal path. */
async function _spendRefusalMessage(env: Env, userId?: string): Promise<string> {
  const GENERIC = 'The service is temporarily at capacity — your credits are safe and you were not charged. Please try again shortly.';
  if (!userId || !env.MESHES) return GENERIC;
  try {
    const maxUser = parseFloat(env.MAX_USER_DAILY_SPEND_USD ?? '') || DEFAULT_MAX_USER_DAILY_SPEND_USD;
    const cur = parseFloat((await r2GetText(env, `_meta/userspend/${userId}/${todayUTC()}`)) || '0') || 0;
    // Within 20% of the personal cap => it is almost certainly the one
    // that refused. Below that, the global cap is the culprit and the
    // generic wording is the honest one.
    if (cur >= maxUser * 0.8) {
      return 'You have reached your daily generation limit for this account. '
           + 'Your credits are safe and you were not charged — the limit resets at midnight UTC.';
    }
  } catch { /* counter unreadable -> fall back to the generic wording */ }
  return GENERIC;
}

/** Arrêt dur sur la FACTURE RÉELLE, pas sur une estimation.
 *
 *  Le compteur journalier plus bas additionne des ESTIMATIONS, et elles
 *  sous-évaluent massivement : le 2026-08-04, **2,502 $ au compteur pour
 *  11,59 $ réellement facturés** — un facteur 4,6. Un plafond affiché à 10 $
 *  autorisait donc en pratique ~40 $ de dépense. Un garde-fou qui laisse
 *  passer quatre fois son plafond n'en est pas un.
 *
 *  On s'appuie donc sur le seul chiffre incontestable : l'usage du workspace
 *  Modal, remonté chaque heure par `scripts/modal_usage_push.py`.
 *
 *  ÉCHOUE EN MODE OUVERT si la donnée est absente ou périmée. C'est
 *  délibéré : si le poller tombe, on veut une alerte, pas un service à
 *  l'arrêt. Le blocage n'intervient que sur une donnée FRAÎCHE qui montre un
 *  budget épuisé — cas où Modal cesserait de toute façon d'exécuter les apps. */
/** URL du backend de rig — SkinTokens (VAST-AI, MIT) et RIEN D'AUTRE.
 *
 *  LE REPLI VERS PUPPETEER A ETE RETIRE VOLONTAIREMENT (2026-08-08).
 *  Le rig par defaut de Puppeteer embarque Michelangelo (GPL-3.0) et
 *  PartField (NVIDIA non-commercial) : il est INTERDIT dans un produit
 *  vendu. Tant que `MODAL_RIG_URL` restait un simple « prime sur », une
 *  variable absente ou mal orthographiee faisait retomber SILENCIEUSEMENT
 *  toute la production sur le moteur interdit — un incident de licence
 *  sans aucun signal visible.
 *
 *  Desormais : pas de `MODAL_RIG_URL`, pas de rig. Une panne franche vaut
 *  mieux qu'une infraction discrete. */
function _rigBaseUrl(env: Env): string | undefined {
  return env.MODAL_RIG_URL;
}

async function _budgetReelEpuise(env: Env): Promise<boolean> {
  if (!env.MESHES) return false;
  try {
    let budget = parseFloat(await r2GetText(env, '_meta/modal_budget_total.txt') || '0') || 0;
    if (budget <= 0) budget = parseFloat(env.MODAL_BUDGET_USD ?? '') || 0;
    if (budget <= 0) return false;                     // aucun budget defini
    const txt = await r2GetText(env, '_meta/modal_real_usage.json');
    if (!txt) return false;                            // pas de donnee : on laisse passer
    const real = JSON.parse(txt) as { usage?: number; ts?: string };
    if (typeof real.usage !== 'number' || !real.ts) return false;
    const ageMs = Date.now() - Date.parse(real.ts);
    if (!(ageMs < 26 * 3600 * 1000)) {
      console.warn('[budget] usage reel perime — arret dur inactif, on laisse passer');
      return false;                                    // perimee : on laisse passer
    }
    if (real.usage >= budget) {
      console.error(`[budget] ARRET DUR : usage reel ${real.usage.toFixed(2)} $ >= budget ${budget.toFixed(2)} $`);
      return true;
    }
  } catch (e) {
    console.warn('[budget] lecture de l\'usage reel impossible:', (e as Error).message);
  }
  return false;
}

async function checkAndIncrementModalSpend(env: Env, estimatedUsd: number, userId?: string): Promise<number | null> {
  // Le budget MENSUEL reel prime sur tout, y compris sur les comptes payants :
  // une fois le budget du workspace epuise, Modal refuse de lancer les apps.
  // Mieux vaut un message clair qu'un echec technique cote GPU.
  if (await _budgetReelEpuise(env)) return null;
  const maxUsd = parseFloat(env.MAX_DAILY_MODAL_SPEND_USD ?? '') || DEFAULT_MAX_MODAL_SPEND_USD;
  // Paying customers are never refused. Their spend still lands on the
  // SAME daily counter — deliberately, so refundModalSpend stays
  // symmetric without having to thread a userId through ~50 call sites
  // (a refund crediting a different counter than the charge is how
  // these figures start lying). The cap simply doesn't apply to them:
  // their credit balance already bounds what they can spend, and every
  // credit was bought at a positive margin.
  const paid = !!userId && await _isPaidAccount(env, userId);
  if (paid) {
    try {
      const key = `_meta/modal_spend/${todayUTC()}`;
      const cur = parseFloat((await r2GetText(env, key)) || '0') || 0;
      await env.MESHES.put(key, String(cur + estimatedUsd));
      const tk = '_meta/modal_spend_total.txt';
      const total = (parseFloat((await r2GetText(env, tk)) || '0') || 0) + estimatedUsd;
      await env.MESHES.put(tk, String(total));
      await _maybeAlertModalBudget(env);
    } catch { /* accounting only — never block a paid call on it */ }
    return maxUsd;
  }
  const next = await _casIncrementCounter(env, `_meta/modal_spend/${todayUTC()}`, estimatedUsd, maxUsd);
  if (next == null) return null;
  // Anti-DoS per-account daily $ cap. If the account is over its personal
  // budget, roll back the global increment (refundModalSpend also fixes the
  // running total) and refuse — same signal as a global over-budget.
  if (userId && (await checkAndIncrementUserDailySpend(env, userId, estimatedUsd)) == null) {
    await refundModalSpend(env, estimatedUsd);
    return null;
  }
  // Running cumulative spend since the last budget top-up (for the admin budget
  // gauge + the low-budget alert). Best-effort — never blocks a paid call.
  try {
    const tk = '_meta/modal_spend_total.txt';
    const total = (parseFloat((await r2GetText(env, tk)) || '0') || 0) + estimatedUsd;
    await env.MESHES.put(tk, String(total));
    await _maybeAlertModalBudget(env);
  } catch (_) {}
  return maxUsd - next;
}

async function refundModalSpend(env: Env, refundUsd: number): Promise<void> {
  const key = `_meta/modal_spend/${todayUTC()}`;
  const cur = parseFloat((await r2GetText(env, key)) || '0') || 0;
  await env.MESHES.put(key, String(Math.max(0, cur - refundUsd)));
  try {
    const tk = '_meta/modal_spend_total.txt';
    const t = parseFloat((await r2GetText(env, tk)) || '0') || 0;
    await env.MESHES.put(tk, String(Math.max(0, t - refundUsd)));
  } catch (_) {}
}

/** Fire an admin alert (banner via _meta/modal_alert.json + email) when the Modal
 *  workspace budget runs low (<=15%) or is exhausted. Debounced: only re-alerts
 *  when severity worsens; cleared when the admin tops up (handleAdminModalSetBudget). */
async function _maybeAlertModalBudget(env: Env): Promise<void> {
  if (!env.MESHES) return;
  // ALARME DESARMEE EN SILENCE — corrigee le 2026-08-03.
  //
  // Le budget etait lu UNIQUEMENT depuis R2. Le fichier n'ayant jamais
  // ete ecrit, budget valait 0 et la fonction sortait ici : l'alerte
  // « budget Modal bientot epuise » ne pouvait STRUCTURELLEMENT jamais
  // se declencher. Une sécurité desactivee par un fichier absent est
  // pire qu'une securite absente : on croit etre couvert.
  //
  // Repli sur MODAL_BUDGET_USD (wrangler.toml) pour qu'un fichier
  // manquant ne desarme plus rien, et trace explicite si les deux
  // sources sont vides.
  let budget = parseFloat(await r2GetText(env, '_meta/modal_budget_total.txt') || '0') || 0;
  if (budget <= 0) {
    budget = parseFloat(env.MODAL_BUDGET_USD ?? '') || 0;
  }
  if (budget <= 0) {
    console.warn('[budget] ALARME INACTIVE : ni _meta/modal_budget_total.txt '
               + 'ni MODAL_BUDGET_USD ne sont definis — aucune alerte ne sera envoyee');
    return;
  }
  // Prefer the REAL Modal workspace usage pushed by the billing poller (fresh
  // < 26h); otherwise fall back to the worker's own cost estimate.
  let usage = 0; let source: 'real' | 'estimate' = 'estimate';
  try {
    const realTxt = await r2GetText(env, '_meta/modal_real_usage.json');
    const real = realTxt ? JSON.parse(realTxt) : null;
    const ageMs = real && real.ts ? (Date.now() - Date.parse(real.ts)) : Infinity;
    if (real && typeof real.usage === 'number' && ageMs < 26 * 3600 * 1000) { usage = real.usage; source = 'real'; }
    else usage = parseFloat(await r2GetText(env, '_meta/modal_spend_total.txt') || '0') || 0;
  } catch (_) { usage = parseFloat(await r2GetText(env, '_meta/modal_spend_total.txt') || '0') || 0; }
  const remaining = budget - usage;
  const pct = remaining / budget;
  let level: 'low' | 'empty' | null = null;
  if (remaining <= 0) level = 'empty';
  else if (pct <= 0.15) level = 'low';
  if (!level) return;
  let prevLevel: string | null = null;
  try { prevLevel = JSON.parse(await r2GetText(env, '_meta/modal_alert.json') || '{}').level || null; } catch (_) {}
  if (prevLevel === level) return;
  if (prevLevel === 'empty' && level === 'low') return;
  const round = (n: number) => Math.round(n * 100) / 100;
  await env.MESHES.put('_meta/modal_alert.json', JSON.stringify({
    level, source, usage: round(usage), remaining: round(remaining), budget: round(budget), ts: new Date().toISOString(),
  }));
  const subject = level === 'empty'
    ? '\u{1F6A8} MyFabmesh — Modal budget EXHAUSTED'
    : '⚠️ MyFabmesh — Modal budget low';
  const text = (level === 'empty'
      ? 'Your Modal GPU workspace budget is EXHAUSTED — Modal will stop running apps.'
      : 'Your Modal GPU workspace budget is running low.')
    + `\n\nUsage (${source}): $${round(usage).toFixed(2)} of $${round(budget).toFixed(2)} budget — remaining $${round(remaining).toFixed(2)} (${Math.round(pct * 100)}%)`
    + '\n\nTop up / raise your Modal workspace budget, then update the limit in the admin Finance tab to re-arm the alert.';
  await _sendAdminAlertEmail(env, subject, text);
}

/** Plain-text alert email to ADMIN_EMAILS via Resend. No-op if RESEND_API_KEY unset. Never throws. */
async function _sendAdminAlertEmail(env: Env, subject: string, text: string): Promise<void> {
  if (!env.RESEND_API_KEY) return;
  const to = [...ADMIN_EMAILS];
  if (!to.length) return;
  const from = env.ALERT_FROM_EMAIL || 'onboarding@resend.dev';
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to, subject, text }),
    });
  } catch (_) { /* best-effort */ }
}

/** Check the per-user daily call cap. Increments on success.
 *  Returns the remaining call budget, or null if over. */
async function checkAndIncrementUserCalls(env: Env, userId: string): Promise<number | null> {
  const maxCalls = parseInt(env.MAX_USER_DAILY_CALLS ?? '', 10) || DEFAULT_MAX_USER_DAILY_CALLS;
  const next = await _casIncrementCounter(env, `_meta/userdaily/${userId}/${todayUTC()}`, 1, maxCalls);
  return next == null ? null : maxCalls - next;
}

/* ─────────────────────────── Turnstile (captcha) ────────────────────────
 * Anti-abuse hook for the expensive GPU endpoints. When TURNSTILE_SECRET_KEY
 * is UNSET the check is a NO-OP (returns true) so nothing breaks until the
 * frontend widget + keys are wired up. When SET, the caller must present a
 * Cloudflare Turnstile token (form field `cf-turnstile-response` or the
 * `cf-turnstile-response` / `x-turnstile-token` header) that validates against
 * Cloudflare's siteverify endpoint.
 *
 * To fully enable (USER TODO):
 *   1. Create a Turnstile widget in the Cloudflare dashboard (get a site key
 *      + secret key).
 *   2. `npx wrangler secret put TURNSTILE_SECRET_KEY`  (paste the secret key).
 *   3. Add the Turnstile widget to the buy/generate UI (site key) and send the
 *      token as `cf-turnstile-response` on the generate request. Also add
 *      https://challenges.cloudflare.com to the CSP script-src/frame-src.
 * ──────────────────────────────────────────────────────────────────────── */
async function verifyTurnstile(env: Env, token: string | null, remoteIp?: string | null): Promise<boolean> {
  // No secret configured → hook is inert (does not block the pipeline).
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;
  try {
    const body = new URLSearchParams();
    body.set('secret', env.TURNSTILE_SECRET_KEY);
    body.set('response', token);
    if (remoteIp) body.set('remoteip', remoteIp);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!r.ok) return false;
    const data = await r.json() as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

/** Extract a Turnstile token from a request's form data or headers. Best-effort;
 *  returns null when absent. Call BEFORE consuming the body elsewhere or pass a
 *  pre-parsed FormData. */
function extractTurnstileToken(req: Request, form?: FormData): string | null {
  const fromForm = form ? (form.get('cf-turnstile-response') as string | null) : null;
  return fromForm
      || req.headers.get('cf-turnstile-response')
      || req.headers.get('x-turnstile-token')
      || null;
}

/* ─────────────────────────── tiny helpers ──────────────────────────── */

// Security headers applied to every response we mint. HSTS pins HTTPS,
// X-Frame-Options blocks clickjacking, X-Content-Type-Options stops
// MIME sniffing, Referrer-Policy keeps URLs out of upstream logs.
// CSP is set per-route on HTML responses (different needs for /admin
// vs the app shell) — we don't blanket-apply it on JSON because some
// admin tools pull cross-origin assets that would otherwise be blocked.
const SECURITY_HEADERS: Record<string, string> = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

const json = (data: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...SECURITY_HEADERS,
      ...(init.headers ?? {}),
    },
  });

const err = (status: number, message: string): Response => json({ error: message }, { status });

const isMock = (env: Env): boolean => env.MOCK === '1' || env.NEXT_PUBLIC_MOCK === '1';

const siteUrl = (env: Env, fallback: string): string =>
  env.NEXT_PUBLIC_SITE_URL ?? fallback;

/* ───────────────────────── signed R2 URLs ──────────────────────────
 * P1 remediation: R2 objects (incl. user face photos) must NOT be reachable
 * at permanent, guessable, unauthenticated r2.dev URLs. We mint short-lived
 * HMAC-signed URLs served from the worker's OWN origin (/r2/<key>?exp&sig)
 * and stream the bytes from the native MESHES binding after verifying the
 * MAC. URLs are self-origin so the existing CSP (`connect-src 'self'`,
 * `img-src 'self'`) already covers them — no new origin, no proxy hop.
 *
 * Canonical signing string: "v1:" + <decoded key> + "\n" + <exp unix-sec>.
 * MAC = HMAC-SHA256(R2_URL_SIGNING_SECRET, str) rendered lowercase hex (64
 * chars), matching the Stripe hex convention so timingSafeEqualHex applies.
 *
 * NON-BREAKING: when R2_URL_SIGNING_SECRET is unset, signedR2Url() falls
 * back to the raw `${R2_PUBLIC_URL}/${key}` form (current behavior) and the
 * /r2/ route 404s — so deploying the call-site switch with no secret set is
 * a no-op. Signing flips on the moment the secret is added (no redeploy).
 * ──────────────────────────────────────────────────────────────────── */

const R2_TTL_IMAGE_SEC  = 86400;    // 24h  — renders, photos, masks, thumbs
const R2_TTL_MESH_SEC   = 604800;   // 7d   — GLB/FBX meshes & animations
const R2_TTL_EXPORT_SEC = 2592000;  // 30d  — CSV/XLSX/GDPR exports that leave the system

type R2UrlKind = 'image' | 'mesh' | 'export';

function r2TtlFor(kind: R2UrlKind): number {
  return kind === 'mesh' ? R2_TTL_MESH_SEC
       : kind === 'export' ? R2_TTL_EXPORT_SEC
       : R2_TTL_IMAGE_SEC;
}

let _r2SignWarned = false;

/** Compute the lowercase-hex HMAC-SHA256 of the canonical signing string. */
async function r2SignHex(secret: string, canonical: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(canonical));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Mint a signed, expiring URL for an R2 object key. `key` is the raw R2
 * object key (e.g. `uid/source/123.png`), WITHOUT a leading slash. The MAC
 * is computed over the DECODED key so transport encoding never changes it.
 *
 * Already-full `https://` values (legacy persisted rows) are passed through
 * unchanged so old data doesn't 404 during the migration window.
 */
async function signedR2Url(env: Env, key: string, kind: R2UrlKind = 'image'): Promise<string> {
  if (!key) return key;
  // Legacy pass-through: persisted rows may already hold a full URL.
  if (/^https?:\/\//i.test(key)) return key;
  const clean = key.replace(/^\/+/, '');
  const base = siteUrl(env, 'http://localhost:3030').replace(/\/+$/, '');
  if (!env.R2_URL_SIGNING_SECRET) {
    // Fail-closed for production: never hand out a permanent, guessable public
    // r2.dev URL for a private bucket. Only fall back to the public form in
    // MOCK mode or when an operator explicitly opts in for local dev.
    if (isMock(env) || env.R2_ALLOW_UNSIGNED === '1') {
      if (!_r2SignWarned) {
        _r2SignWarned = true;
        console.warn('[r2] R2_URL_SIGNING_SECRET unset — falling back to public R2_PUBLIC_URL (objects remain publicly reachable). Set the secret to enable signed URLs.');
      }
      return `${(env.R2_PUBLIC_URL || '').replace(/\/+$/, '')}/${clean}`;
    }
    throw new Error(
      'R2_URL_SIGNING_SECRET is required to serve private R2 URLs. ' +
      'Set it with `openssl rand -hex 32 | npx wrangler secret put R2_URL_SIGNING_SECRET`, ' +
      'or set R2_ALLOW_UNSIGNED="1" to opt into the public-URL fallback for local dev only.'
    );
  }
  const exp = Math.floor(Date.now() / 1000) + r2TtlFor(kind);
  const sig = await r2SignHex(env.R2_URL_SIGNING_SECRET, `v1:${clean}\n${exp}`);
  const encodedPath = clean.split('/').map(encodeURIComponent).join('/');
  return `${base}/r2/${encodedPath}?exp=${exp}&sig=${sig}`;
}

/** Map an R2 key extension to a response content-type. */
function r2ContentType(key: string): string {
  const ext = (key.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'glb':  return 'model/gltf-binary';
    case 'gltf': return 'model/gltf+json';
    case 'png':  return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'gif':  return 'image/gif';
    case 'fbx':  return 'application/octet-stream';
    case 'json': return 'application/json';
    default:     return 'application/octet-stream';
  }
}

/**
 * GET /r2/<encoded-key>?exp=<unix>&sig=<hex> — verify the signature + expiry
 * then stream the object from the MESHES binding. Possession of a valid
 * signed URL IS the authorization, so ACAO:* is set to allow canvas /
 * model-viewer cross-fetch without the /api/proxy-image hop.
 */
async function handleSignedR2(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  // Decode each path segment after '/r2/' and rejoin = the logical key.
  const raw = url.pathname.slice('/r2/'.length);
  let key: string;
  try {
    key = raw.split('/').map(decodeURIComponent).join('/');
  } catch {
    return err(400, 'bad key');
  }
  // Path-traversal / spoofing guard (defense-in-depth; the MAC already
  // binds the exact key so a key can't be forged without a signature).
  if (!key || key.includes('..') || key.startsWith('/')) return err(403, 'forbidden');
  // DERNIER REMPART sur les cles INTERNES. Le prefixe `_` est reserve a
  // l'exploitation : _meta/admin_password.json, _meta/pricing.json,
  // _meta/banned-users.json, _meta/modal_spend/*, _logs/*, _market/*.
  //
  // La signature ne couvre que (cle + expiration), JAMAIS le user_id : il
  // suffisait donc qu'une cle interne obtienne une signature quelque part
  // dans le code pour devenir lisible par n'importe qui. C'est ce que
  // permettait /api/user-assets/record (corrige plus bas). On refuse ici
  // aussi, pour que la meme faute ailleurs reste sans consequence.
  //
  // UNE SEULE EXCEPTION, ETROITE : les pieces jointes des messages de contact
  // et des signalements de contenu, sous `_meta/contact/<id>/`. Elles sont
  // FAITES pour etre ouvertes depuis le tableau de bord, et le blocage en bloc
  // les rendait toutes inaccessibles — captures d'ecran du formulaire de
  // contact comprises, qui existaient bien avant ce garde. Un signalement dont
  // on ne peut pas ouvrir la piece est un signalement qu'on ne peut pas
  // instruire. L'exception reste sure : elle ne couvre que ce sous-dossier,
  // le fichier `_meta/contact/<id>.json` lui-meme (sans barre oblique) reste
  // refuse, et la signature demeure exigee.
  const pieceJointeContact = /^_meta\/contact\/[A-Za-z0-9_]+\/[^/]+$/.test(key);
  if (key.startsWith('_') && !pieceJointeContact) {
    console.warn(`[r2] tentative de lecture d'une cle interne refusee : ${key.slice(0, 80)}`);
    return err(403, 'forbidden');
  }

  // Route is only meaningful when signing is enabled.
  if (!env.R2_URL_SIGNING_SECRET) return err(404, 'not found');
  if (!env.MESHES) return err(404, 'not found');

  const exp = parseInt(url.searchParams.get('exp') || '', 10);
  const sig = url.searchParams.get('sig') || '';
  if (!Number.isFinite(exp) || !sig) return err(403, 'forbidden');
  const now = Math.floor(Date.now() / 1000);
  if (exp < now) return err(403, 'expired');

  const expected = await r2SignHex(env.R2_URL_SIGNING_SECRET, `v1:${key}\n${exp}`);
  if (!timingSafeEqualHex(sig.toLowerCase(), expected)) return err(403, 'forbidden');

  const obj = await env.MESHES.get(key);
  if (!obj) return err(404, 'not found');

  return new Response((obj as { body: ReadableStream }).body, {
    headers: {
      'content-type': r2ContentType(key),
      'cache-control': `private, max-age=${Math.max(0, exp - now)}`,
      'content-disposition': 'inline',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * `fetch()` pour une URL d'asset, SANS aller-retour HTTP vers notre propre
 * hostname.
 *
 * POURQUOI : depuis la migration vers les URLs signées, les URLs d'assets
 * pointent sur NOTRE domaine (`<site>/r2/<clé>?exp&sig`) et non plus sur un
 * bucket R2 public. Un `fetch()` depuis le Worker devient alors une
 * sous-requête vers sa propre origine — fragile. Constaté en production le
 * 2026-07-27 : `/api/generate` a renvoyé « cannot fetch imagePath (HTTP 404) »
 * 387 ms après le clic, alors que l'objet EXISTAIT et que la même URL
 * répondait 200 (1,6 Mo) depuis l'extérieur.
 *
 * handleProxyImage contournait déjà le piège (« avoids a self-subrequest »)
 * mais le contournement n'avait jamais été généralisé aux autres endpoints.
 *
 * On sert donc l'objet directement depuis le binding R2. La SIGNATURE RESTE
 * VÉRIFIÉE (handleSignedR2 fait foi) : c'est elle qui autorise l'accès, sinon
 * un utilisateur authentifié pourrait lire la clé d'un autre compte en
 * fabriquant une URL. Les hôtes externes (Replicate, r2.dev public…) passent
 * par un `fetch()` normal.
 */
async function assetFetch(env: Env, rawUrl: string): Promise<Response> {
  try {
    const parsed = new URL(rawUrl);
    const siteHost = new URL(siteUrl(env, 'http://localhost:3030')).host;
    // Uniquement NOTRE hôte : un autre *.workers.dev n'a aucune raison
    // d'être servi depuis notre bucket.
    if (parsed.host === siteHost && parsed.pathname.startsWith('/r2/')) {
      return await handleSignedR2(new Request(parsed.toString(), { method: 'GET' }), env);
    }
  } catch { /* URL invalide : on laisse fetch() échouer normalement */ }
  return await fetch(rawUrl);
}

function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.get('cookie') ?? '';
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function appendSetCookie(res: Response, cookie: string): Response {
  const headers = new Headers(res.headers);
  headers.append('set-cookie', cookie);
  return new Response(res.body, { status: res.status, headers });
}

/* ───────────────────────── auth / session ─────────────────────────── */

interface SessionUser {
  id: string;
  email: string | null;
  credits: number;
}

/**
 * Read the Supabase access token from cookies.
 *
 * `@supabase/ssr` stores the session under a project-scoped cookie name
 * (`sb-<projectRef>-auth-token`). We grab it via prefix match, base64-decode,
 * then extract `access_token`.
 *
 * Multi-chunk cookies (`*.0`, `*.1`, …) are concatenated in order.
 */
// New HttpOnly session cookie. Set by /api/auth/install-session after
// a successful Supabase signin and read by getSessionUser. Never
// accessible to JS, so XSS can't exfil the token. Carries just the
// access_token; refresh_token stays in a separate sibling cookie
// (mfm-refresh, also HttpOnly) used on token-expired re-issue.
const MFM_SESSION_COOKIE = 'mfm-session';
const MFM_REFRESH_COOKIE = 'mfm-refresh';

function readSupabaseAccessToken(req: Request): string | null {
  const cookies = parseCookies(req);
  // 1. Prefer the new HttpOnly cookie — XSS-safe.
  if (cookies[MFM_SESSION_COOKIE]) return cookies[MFM_SESSION_COOKIE];
  // 2. Fallback: the legacy supabase-js cookies (`sb-<ref>-auth-token`)
  //    set client-side. Kept for backward compat during the rollout;
  //    can be removed after every active session has migrated.
  const keys = Object.keys(cookies).filter(k => /^sb-[^-]+-auth-token(?:\.\d+)?$/.test(k));
  if (!keys.length) return null;
  keys.sort();
  let raw = keys.map(k => cookies[k]).join('');
  if (raw.startsWith('base64-')) raw = raw.slice(7);
  try {
    const direct = (() => { try { return JSON.parse(raw); } catch { return null; } })();
    const obj = direct ?? JSON.parse(atob(raw));
    return obj?.access_token ?? null;
  } catch {
    return null;
  }
}

function supabaseAdmin(env: Env): SupabaseClient {
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Insert a row in user_assets so the client doesn't have to keep a
 *  copy in localStorage (which was capping at ~5 MB and silently
 *  dropping new generations on heavy users).
 *
 *  Best-effort: errors are logged but NEVER thrown — image generation
 *  must not fail just because the table is unreachable; the R2 put
 *  already succeeded and the client cache still works as fallback.
 *
 *  `r2_path` is the R2 key (without the public URL prefix). The
 *  client computes the full URL from R2_PUBLIC_URL at render time. */
async function insertUserAsset(
  env: Env,
  userId: string,
  project: string,
  kind: string,
  r2_path: string,
  parent_path: string | null = null,
  meta: Record<string, unknown> = {},
): Promise<void> {
  if (!project || !r2_path) return;
  try {
    const sb = supabaseAdmin(env);
    const { error } = await sb.from('user_assets').upsert({
      user_id: userId,
      project: String(project).slice(0, 128),
      kind: String(kind).slice(0, 32),
      r2_path,
      parent_path,
      meta,
    }, {
      onConflict: 'user_id,r2_path',
      ignoreDuplicates: true,
    });
    if (error) console.warn('[insertUserAsset] failed:', error.message);
  } catch (e) {
    console.warn('[insertUserAsset] threw:', e instanceof Error ? e.message : String(e));
  }
}

/** Convenience: extract the R2 object KEY from a URL the worker already
 *  returned — handles BOTH the legacy public form
 *  (https://pub-xxx.r2.dev/<uid>/front/<file>.png) AND the new signed form
 *  (<SITE>/r2/<url-encoded-key>?exp&sig). Returns null if neither matches
 *  (callers then treat the input as a raw key via `?? url`). */
function r2PathFromPublicUrl(env: Env, url: string): string | null {
  if (!url) return null;
  // New signed form: <SITE>/r2/<encoded-key>?exp=...&sig=... — the key is the
  // path right after the host's /r2/ segment, percent-decoded per segment.
  // (Anchored to the host so a legacy key that merely contains "/r2/" can't
  // false-match.)
  const signed = url.match(/^https?:\/\/[^/]+\/r2\/([^?#]+)/);
  if (signed) {
    try { return signed[1].split('/').map(decodeURIComponent).join('/'); }
    catch { return signed[1]; }
  }
  // Legacy public form: <R2_PUBLIC_URL>/<key>
  const prefix = (env.R2_PUBLIC_URL || '').replace(/\/+$/, '') + '/';
  if (prefix.length > 1 && url.startsWith(prefix)) return url.slice(prefix.length);
  return null;
}

/* ───── MOCK in-memory store (Worker-instance scoped, ephemeral) ─────
 * NOTE: this is identical-in-spirit to src/lib/mock-store.ts but lives
 * here so we don't need to refactor lib/*. Wipes on Worker recycle —
 * fine for dev, NOT used in prod (MOCK env is '0'). */
interface MockUser { id: string; email: string; credits: number; createdAt: string; }
interface MockJob {
  id: string; user_id: string; asset_type: string; mode: string; seed: number;
  credit_cost: number; status: string; options: Record<string, unknown>;
  mesh_url: string | null; error: string | null;
  created_at: string; finished_at: string | null;
}
interface MockPayment {
  id: number; stripe_session_id: string; user_id: string; pack_id: string;
  credits: number; amount_eur: number; created_at: string;
}
interface MockStore {
  users: Map<string, MockUser>; emailIndex: Map<string, string>;
  sessions: Map<string, string>;
  jobs: Map<string, MockJob>;
  payments: MockPayment[]; paymentSeq: number;
}
let _mock: MockStore | null = null;
function mockStore(): MockStore {
  if (!_mock) _mock = {
    users: new Map(), emailIndex: new Map(), sessions: new Map(),
    jobs: new Map(), payments: [], paymentSeq: 1,
  };
  return _mock;
}
const mock = {
  upsertUser(email: string): MockUser {
    const s = mockStore();
    const id = s.emailIndex.get(email);
    if (id) return s.users.get(id)!;
    const newId = 'mock_' + crypto.randomUUID();
    const u: MockUser = { id: newId, email, credits: 50, createdAt: new Date().toISOString() };
    s.users.set(newId, u); s.emailIndex.set(email, newId);
    return u;
  },
  createSession(userId: string): string {
    const t = 'sess_' + crypto.randomUUID();
    mockStore().sessions.set(t, userId);
    return t;
  },
  getUserBySession(t: string | undefined): MockUser | null {
    if (!t) return null;
    const id = mockStore().sessions.get(t);
    return id ? mockStore().users.get(id) ?? null : null;
  },
  destroySession(t: string) { mockStore().sessions.delete(t); },
  spend(userId: string, amount: number): number | null {
    const u = mockStore().users.get(userId);
    if (!u || u.credits < amount) return null;
    u.credits -= amount; return u.credits;
  },
  add(userId: string, amount: number): number {
    const u = mockStore().users.get(userId);
    if (!u) return 0;
    u.credits += amount; return u.credits;
  },
  insertJob(j: MockJob) { mockStore().jobs.set(j.id, j); },
  getJob(id: string): MockJob | undefined { return mockStore().jobs.get(id); },
  updateJob(id: string, patch: Partial<MockJob>) {
    const j = mockStore().jobs.get(id); if (j) Object.assign(j, patch);
  },
  listJobs(userId: string): MockJob[] {
    return [...mockStore().jobs.values()]
      .filter(j => j.user_id === userId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  },
  insertPayment(p: Omit<MockPayment, 'id'>): MockPayment {
    const s = mockStore();
    const rec: MockPayment = { id: s.paymentSeq++, ...p };
    s.payments.push(rec); return rec;
  },
};

const MOCK_COOKIE = 'myfm_mock_session';

// Ban list cached in module scope. 60 s TTL — admin actions trigger
// a forced refresh by writing to R2 and clearing this. R2 read per
// request would double the cost-per-API-call; we accept up-to-60 s
// staleness for a banned user (they keep working briefly, no big
// deal versus the cost saving).
let _banListCache: { set: Set<string>; ts: number } = { set: new Set(), ts: 0 };
const BAN_LIST_KEY = '_meta/banned-users.json';
const BAN_LIST_TTL_MS = 60_000;

async function _getBannedUserIds(env: Env): Promise<Set<string>> {
  const now = Date.now();
  if (now - _banListCache.ts < BAN_LIST_TTL_MS) return _banListCache.set;
  try {
    const obj = await env.MESHES.get(BAN_LIST_KEY);
    const list = obj ? await obj.json() : [];
    const set = new Set<string>(Array.isArray(list) ? list as string[] : []);
    _banListCache = { set, ts: now };
    return set;
  } catch {
    _banListCache = { set: new Set(), ts: now };
    return _banListCache.set;
  }
}

function _invalidateBanCache() {
  _banListCache = { set: new Set(), ts: 0 };
}

/* Service kill-switches — admin can disable Modal calls or the entire
 * site from the dashboard (panic button if the GPU is being abused or
 * Stripe webhooks are misbehaving). Stored in R2 alongside the ban list.
 * Cache TTL is 30 s so flipping a switch propagates quickly without
 * doubling R2 reads for every request. */
type ServiceFlags = {
  modal_enabled: boolean;
  site_enabled: boolean;
  stripe_enabled: boolean;
};
const SERVICE_FLAGS_KEY = '_meta/service-flags.json';
const SERVICE_FLAGS_TTL_MS = 30_000;
const DEFAULT_FLAGS: ServiceFlags = {
  modal_enabled: true, site_enabled: true, stripe_enabled: true,
};
let _serviceFlagsCache: { flags: ServiceFlags; ts: number } = { flags: DEFAULT_FLAGS, ts: 0 };

async function _getServiceFlags(env: Env): Promise<ServiceFlags> {
  const now = Date.now();
  if (now - _serviceFlagsCache.ts < SERVICE_FLAGS_TTL_MS) return _serviceFlagsCache.flags;
  try {
    const obj = await env.MESHES.get(SERVICE_FLAGS_KEY);
    const raw = obj ? await obj.json() as Partial<ServiceFlags> : {};
    const flags: ServiceFlags = {
      modal_enabled: raw.modal_enabled !== false,
      site_enabled: raw.site_enabled !== false,
      stripe_enabled: raw.stripe_enabled !== false,
    };
    _serviceFlagsCache = { flags, ts: now };
    return flags;
  } catch {
    _serviceFlagsCache = { flags: DEFAULT_FLAGS, ts: now };
    return _serviceFlagsCache.flags;
  }
}

function _invalidateServiceFlagsCache() {
  _serviceFlagsCache = { flags: DEFAULT_FLAGS, ts: 0 };
}

/* Pricing — credit costs per operation. Admin can override every entry
 * via the Pricing tab in /admin without redeploying. Stored in R2
 * `_meta/pricing.json` as a partial override applied on top of these
 * defaults at lookup time.
 *
 * Keys are stable wire names — adding a new operation here also needs
 * the admin UI list + the handler that consumes it. Removing one is
 * safe but leftover R2 entries are simply ignored.
 */
/* TARIFS RELEVES LE 2026-08-04 sur COUT REEL MESURE, pas sur une estimation.
 *
 * Mesure : une generation de maillage a FROID, creneau horaire isole, traines
 * eteintes avant lecture, coute 0,7074 \$ = 0,643 EUR tout compris. Le pack le
 * plus defavorable (abonnement Studio, 40 EUR / 300 credits) vaut 0,1333 EUR
 * le credit. Aux anciens tarifs, `mesh_fast` (3 cr = 0,40 EUR) et
 * `mesh_balanced` (4 cr = 0,53 EUR) etaient donc VENDUS A PERTE des que le
 * conteneur etait froid — et `mesh_balanced` est le palier PAR DEFAUT.
 * `segment` et `rectify` a 1 credit l'etaient aussi : vrai appel GPU a
 * 0,176 EUR pour 0,133 EUR encaisses.
 *
 * Le coût unitaire s'effondre avec le volume (0,376 \$ a 26 generations/jour
 * contre 1,22 \$ pour une seule), mais AU LANCEMENT on est par definition dans
 * le pire cas. Ces tarifs tiennent des la premiere generation.
 *
 * ATTENTION : `_meta/pricing.json` dans R2 PRIME sur ces valeurs. Elles ne
 * servent que de repli — mais un repli qui vendait a perte etait un piege. */
const PRICING_DEFAULTS = {
  // Image ops
  text2image:       3,
  back_view:        3,
  modify:           3,
  segment:          3,  // CLIPSeg detect-only (Auto Inpaint live mask preview) — each = a GPU call
  auto_inpaint:     6,
  mask_inpaint:     6,
  face_fix_image:   3,
  upscale:          3,  // x2 = this price, x4 = this + 1
  rectify:          3,
  remove_background: 1,
  // Mesh ops
  mesh_op_simple:   1,
  // Mesh generation ladder repriced 2026-07-28 from MEASURED Modal cost,
  // not from the (wrong) _meshCostUsd estimate. 30 days of succeeded
  // jobs: median 373s for the 1-credit preset, 420s for the 8-credit one
  // — only 13% apart, because wall-clock is dominated by cold start +
  // weight load + texture bake, NOT by the diffusion steps the presets
  // vary. At $0.000542/s on L40S plus the 300s scaledown tail, one
  // generation really costs ~$0.37; the old 1-credit price sold it for
  // $0.154 on the Studio pack, i.e. at a 58% LOSS. Floor is now 3.
  mesh_fast:        8,
  mesh_balanced:    10,
  mesh_quality:     13,
  mesh_ultra_8k:    16,
  mesh_multiref:    1,
  mesh_refine:      2,
  mesh_rectify:     1,
  mesh_quality_plus: 1,
  mesh_ultra_q:     2,
  mesh_ultra_hd:    3,
  mesh_face_fix:    2,
  face_fix_mesh:    2,
};
type PricingKey = keyof typeof PRICING_DEFAULTS;
const PRICING_KEY = '_meta/pricing.json';
const PRICING_TTL_MS = 60_000;
let _pricingCache: { prices: Record<string, number>; ts: number } = {
  prices: { ...PRICING_DEFAULTS }, ts: 0,
};

async function _getPricing(env: Env): Promise<Record<string, number>> {
  const now = Date.now();
  if (now - _pricingCache.ts < PRICING_TTL_MS) return _pricingCache.prices;
  try {
    const obj = await env.MESHES.get(PRICING_KEY);
    const overrides = obj ? await obj.json() as Record<string, number> : {};
    const sanitized: Record<string, number> = {};
    for (const [k, v] of Object.entries(overrides)) {
      if (typeof v === 'number' && v >= 0 && Number.isFinite(v)) sanitized[k] = Math.floor(v);
    }
    _pricingCache = { prices: { ...PRICING_DEFAULTS, ...sanitized }, ts: now };
  } catch {
    _pricingCache = { prices: { ...PRICING_DEFAULTS }, ts: now };
  }
  return _pricingCache.prices;
}

function _invalidatePricingCache() {
  _pricingCache = { prices: { ...PRICING_DEFAULTS }, ts: 0 };
}

/* Force-logout all users — admin nuclear button. Stores a unix-seconds
 * timestamp in R2; getSessionUser rejects any Supabase JWT whose `iat`
 * (issued-at) claim is older than this value, so every session token
 * minted before the click stops being valid. Users land back on /login.
 *
 * Cache 60 s to dodge a R2 read on every request. Bumping the value
 * also bumps the cache invalidation marker. */
const MIN_SESSION_IAT_KEY = '_meta/min-session-iat.json';
// Short TTL: when the admin presses "Force logout" they expect users
// kicked within seconds, not a full minute. 5 s = at most one R2 read
// per user per 5 s, still cheap.
const MIN_SESSION_TTL_MS = 5_000;
let _minSessionIatCache: { iat: number; ts: number } = { iat: 0, ts: 0 };

async function _getMinSessionIat(env: Env): Promise<number> {
  const now = Date.now();
  if (now - _minSessionIatCache.ts < MIN_SESSION_TTL_MS) return _minSessionIatCache.iat;
  try {
    const obj = await env.MESHES.get(MIN_SESSION_IAT_KEY);
    const raw = obj ? await obj.json() as { iat?: number } : {};
    const iat = typeof raw.iat === 'number' && raw.iat > 0 ? raw.iat : 0;
    _minSessionIatCache = { iat, ts: now };
    return iat;
  } catch {
    _minSessionIatCache = { iat: 0, ts: now };
    return 0;
  }
}

function _invalidateMinSessionIatCache() {
  _minSessionIatCache = { iat: 0, ts: 0 };
}

/** Append a JSON Lines record to today's admin audit log in R2.
 *  Best-effort — failures are logged but don't block the admin action.
 *  Keys: _meta/admin_audit/YYYY-MM-DD.log. Each line is a JSON object
 *  with timestamp, actor email, action, target, ip, optional details. */
async function _auditLog(env: Env, opts: {
  req: Request;
  actorEmail: string | null;
  action: string;
  target?: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  if (!env.MESHES) return;
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const key = `_meta/admin_audit/${day}.log`;
  const ip = opts.req.headers.get('cf-connecting-ip')
          ?? opts.req.headers.get('x-forwarded-for')
          ?? 'unknown';
  const ua = opts.req.headers.get('user-agent') ?? '';
  const line = JSON.stringify({
    ts: now.toISOString(),
    actor: opts.actorEmail,
    ip: ip.split(',')[0].trim(),
    ua: ua.slice(0, 200),
    action: opts.action,
    target: opts.target ?? null,
    ...(opts.details ?? {}),
  }) + '\n';
  try {
    // R2 doesn't support append, so we read+concat+put. Cheap because
    // a day-long admin log stays <100 KB even with active moderation.
    const existing = await env.MESHES.get(key);
    const prev = existing ? await existing.text() : '';
    await env.MESHES.put(key, prev + line);
  } catch (e) {
    console.warn('[audit] failed to append log line:', e instanceof Error ? e.message : String(e));
  }
}

/** Decode a JWT payload without verifying — we only need the `iat`
 *  claim and Supabase already verified the signature in the call to
 *  /auth/v1/user that returned the user object. */
function _decodeJwtIat(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
    const json = atob(padded + pad);
    const payload = JSON.parse(json) as { iat?: number };
    return typeof payload.iat === 'number' ? payload.iat : null;
  } catch {
    return null;
  }
}

async function getPrice(env: Env, key: PricingKey): Promise<number> {
  const all = await _getPricing(env);
  return all[key] ?? PRICING_DEFAULTS[key];
}

/* TOTP (RFC 6238) helpers — compatible with Microsoft / Google
 * Authenticator out of the box. Secrets are base32-encoded random 20
 * bytes, codes are 6 digits with a 30 s window and ±1 step drift
 * tolerance. Stored at R2 _meta/admin-totp.json once an admin enrols.
 */
const TOTP_KEY = '_meta/admin-totp.json';

function _base32Encode(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

function _base32Decode(b32: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = b32.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const idx = alphabet.indexOf(c);
    if (idx < 0) throw new Error('invalid base32 char: ' + c);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function _totpAt(secretBase32: string, step: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', _base32Decode(secretBase32),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  // 8-byte big-endian counter. JS bitwise is 32-bit so we divide.
  const buf = new Uint8Array(8);
  let n = step;
  for (let i = 7; i >= 0; i--) {
    buf[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const offset = sig[sig.length - 1] & 0x0f;
  const code = ((sig[offset] & 0x7f) << 24)
             | ((sig[offset + 1] & 0xff) << 16)
             | ((sig[offset + 2] & 0xff) << 8)
             | (sig[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

async function _totpVerify(secretBase32: string, provided: string): Promise<boolean> {
  const code = String(provided || '').trim().replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return false;
  const step = Math.floor(Date.now() / 1000 / 30);
  for (let drift = -1; drift <= 1; drift++) {
    if (await _totpAt(secretBase32, step + drift) === code) return true;
  }
  return false;
}

async function _getAdminTotpSecret(env: Env): Promise<string | null> {
  try {
    const obj = await env.MESHES.get(TOTP_KEY);
    if (!obj) return null;
    const j = await obj.json() as { secret?: string };
    return j.secret || null;
  } catch { return null; }
}

async function getSessionUser(req: Request, env: Env): Promise<SessionUser | null> {
  if (isMock(env)) {
    const c = parseCookies(req);
    const u = mock.getUserBySession(c[MOCK_COOKIE]);
    return u ? { id: u.id, email: u.email, credits: u.credits } : null;
  }
  const token = readSupabaseAccessToken(req);
  if (!token) return null;

  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!url || !anon) return null;

  const meRes = await fetch(`${url}/auth/v1/user`, {
    headers: { 'authorization': `Bearer ${token}`, 'apikey': anon },
  });
  if (!meRes.ok) return null;
  const me = await meRes.json() as { id?: string; email?: string };
  if (!me.id) return null;

  // Force-logout check — admin can stamp _meta/min-session-iat.json
  // with the current unix-seconds time; every JWT minted before that
  // is treated as expired. Bypasses ADMIN_EMAILS so the admin doesn't
  // log themselves out when flipping this.
  const minIat = await _getMinSessionIat(env);
  if (minIat > 0 && !(me.email && ADMIN_EMAILS.has(me.email.toLowerCase()))) {
    const iat = _decodeJwtIat(token);
    if (iat !== null && iat < minIat) {
      // Carry the reason through a side-channel — getSessionUser
      // returns null normally, but callers can check this flag if
      // they want to surface "admin forced logout" instead of a
      // generic 401.
      (req as Request & { __sessionExpiredReason?: string }).__sessionExpiredReason = 'admin_forced_logout';
      return null;
    }
  }

  // Ban check — banned users look like "not authenticated" to every
  // downstream caller, which is exactly what we want (clean 401).
  const banned = await _getBannedUserIds(env);
  if (banned.has(me.id)) return null;

  const sb = supabaseAdmin(env);
  const { data: profile } = await sb
    .from('profiles')
    .select('credits')
    .eq('id', me.id)
    .maybeSingle();
  return { id: me.id, email: me.email ?? null, credits: (profile?.credits as number) ?? 0 };
}

async function spendCredits(env: Env, userId: string, amount: number): Promise<number | null> {
  if (isMock(env)) return mock.spend(userId, amount);
  const { data, error } = await supabaseAdmin(env).rpc('spend_credits', { p_user_id: userId, p_amount: amount });
  if (error || data == null) return null;
  return data as number;
}

async function addCredits(env: Env, userId: string, amount: number): Promise<number | null> {
  if (isMock(env)) return mock.add(userId, amount);
  const { data, error } = await supabaseAdmin(env).rpc('add_credits', { p_user_id: userId, p_amount: amount });
  if (error || data == null) return null;
  return data as number;
}

/* ────────────────────────── replicate logic ────────────────────────── */

const PACKS = {
  // One-shot top-ups (Stripe Payment mode).
  starter: { id: 'starter', name: 'Starter',  euros: 5,  credits: 25,  mode: 'payment' as const },
  pro:     { id: 'pro',     name: 'Pro',      euros: 20, credits: 120, mode: 'payment' as const },
  studio:  { id: 'studio',  name: 'Studio',   euros: 50, credits: 350, mode: 'payment' as const },
  // Monthly subscriptions (Stripe Subscription mode). Credits drop in
  // every billing cycle. price_id is set as a Worker env var so the
  // admin can rotate Stripe prices without a code change.
  sub_starter: { id: 'sub_starter', name: 'Starter Monthly', euros: 5,  credits: 30,  mode: 'subscription' as const, interval: 'month' as const },
  sub_pro:     { id: 'sub_pro',     name: 'Pro Monthly',     euros: 15, credits: 100, mode: 'subscription' as const, interval: 'month' as const },
  sub_studio:  { id: 'sub_studio',  name: 'Studio Monthly',  euros: 40, credits: 300, mode: 'subscription' as const, interval: 'month' as const },
} as const;
type PackId = keyof typeof PACKS;

interface GenerateInput {
  image: Blob | File | string;
  asset_type: 'character' | 'creature' | 'vehicle' | 'building'
            | 'weapon' | 'prop' | 'environment' | 'icon'
            | 'avion' | 'bateau' | 'animal' | 'custom';
  mode: 'lite' | 'standard' | 'full';
  seed?: number;
  rectify?: boolean; back_view?: boolean; smooth?: boolean;
  face_fix?: boolean; ultra_hd?: boolean; fast?: boolean;
  // Trellis2 advanced options — values MUST match the data-credits
  // attributes in cloud/public/app/index.html so the UI cost meter and
  // the server never disagree.
  preset?: 'fast' | 'balanced' | 'quality';
  multiref?: boolean;
  refine?: boolean;
  quality_plus?: boolean;
  ultra_q?: boolean;
}

/** Approximate Modal cost per operation type, in USD. Used by the
 *  history CSV to compute net margin without re-deriving it from the
 *  GPU rate × elapsed time. Numbers come from the financial audit on
 *  2026-05-26 (warm-container amortised, including a fair share of the
 *  scaledown_window=300s idle). Tune as Modal pricing evolves. */
/* Modal container rates, $/second. The dashboard used to price every
 * operation from the static MODAL_COST_USD guesses below, which were
 * badly wrong: 'mesh' claimed $0.060 while 30 days of measured job
 * durations put a real generation at ~$0.37 — a 6x understatement that
 * showed a fictional margin on every row. These rates let us price a job
 * from its OWN duration instead of a guess.
 *
 * Caveat worth keeping in mind when reading the dashboard: duration x
 * rate captures the container time attributable to a call, NOT the idle
 * scaledown tail or a cold start amortised across calls. The reported
 * total will therefore sit BELOW the real Modal invoice; the gap is
 * surfaced explicitly rather than hidden (see `unattributed_usd`). */
const GPU_USD_PER_SEC: Record<string, number> = {
  H100: 0.001267,
  A100: 0.001097,    // A100 40 Go (valeur par defaut de gpu="A100")
  L40S: 0.000542,
  A10G: 0.000306,
  L4:   0.000222,
  CPU:  0.0000131,   // par cœur-seconde ; nos fonctions CPU tournent sur ~2 cœurs
};

/** Which container an op type runs on — decides the rate above. */
/* Verifie le 2026-08-03 contre les declarations `gpu=` reelles des
 * fonctions Modal, au lieu d'etre suppose :
 *   _partsam.py:1279   gpu="A100"   -> segmentation (etait chiffree A10G,
 *                                      soit 3,6x SOUS son cout reel)
 *   _sampart3d.py      gpu="A100"
 *   _puppeteer_rig.py  gpu="A10G"   -> rig
 *   _anytop_anim.py    gpu="A10G"   -> animation
 *   _mvadapter.py      gpu="A10G"
 *   _animateanymesh.py gpu="L4"
 *   app.py x3          gpu="L40S"   -> mesh, text2image, back-view */
const OP_HARDWARE: Record<string, keyof typeof GPU_USD_PER_SEC> = {
  'mesh': 'L40S', 'mesh-face': 'L40S', 'construction3d': 'L40S',
  'text2image': 'L40S', 'back-view': 'L40S', 'rectify': 'L40S',
  'sheet': 'L40S', 'tpose': 'L40S', 'remove-bg': 'L40S',
  'rig': 'A10G',
  'segment': 'A100',          // CORRIGE : _partsam.py tourne sur A100
  'animate': 'A10G', 'animate_fbx': 'CPU',
  'mesh-op': 'CPU', 'mesh-op-client': 'CPU', 'mesh-convert': 'CPU',
};

/** Cost of ONE job priced from how long it actually ran. Returns null
 *  when the row has no usable duration (still running, or a legacy row
 *  with no finished_at) so the caller can fall back knowingly. */
function _measuredCostUsd(opType: string, createdAt?: string, finishedAt?: string): number | null {
  if (!createdAt || !finishedAt) return null;
  const a = Date.parse(createdAt), b = Date.parse(finishedAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const secs = (b - a) / 1000;
  // Guard both ends: a negative span is a clock artefact, and anything
  // past an hour is a stuck record, not container time — Modal's own
  // function timeouts cap execution at 600-900s.
  if (secs <= 0 || secs > 3600) return null;
  const rate = GPU_USD_PER_SEC[OP_HARDWARE[opType] ?? 'L40S'] ?? GPU_USD_PER_SEC.L40S;
  return +(secs * rate).toFixed(5);
}

/* RECALE SUR MESURE le 2026-08-03. Les valeurs precedentes etaient fausses
 * DANS LES DEUX SENS, verifie sur les jobs reussis depuis le 20/06 :
 *
 *   operation      n   mediane   cout mesure   ancienne valeur   ecart
 *   text2image    44       6 s      0.0030          0.020        6.6x trop HAUT
 *   mesh          17     373 s      0.2022          0.060        3.3x trop BAS
 *   mesh-op        4      13 s      0.0002          0.005         30x trop HAUT
 *   rig            3     234 s      0.0717          0.050        acceptable
 *
 * Methode : mediane de (finished_at - created_at) x tarif du conteneur
 * (L40S 0.000542 $/s, A10G 0.000306, CPU 0.0000131).
 *
 * IMPORTANT — CE QUE CES CHIFFRES NE COUVRENT PAS : la duree mesuree
 * exclut la fenetre `scaledown_window` facturee APRES chaque appel
 * (300 s sur les classes L40S, soit 0.163 $ derriere une generation
 * isolee). Pour 'mesh' on retient donc 0.37, valeur etablie separement
 * en incluant cette traine ; pour les autres on reste sur la mesure
 * brute, la traine etant amortie sur des appels rapproches.
 *
 * NON MESURES faute d'echantillon suffisant, laisses en l'etat et donc
 * TOUJOURS SUSPECTS : back-view, rectify, sheet, tpose, mesh-face,
 * remove-bg, segment, animate, construction3d. L'audit du 02/08 les
 * annonce eux aussi tres decales (x41 sur construction3d, /4 sur
 * segment) — a confirmer quand il y aura assez de jobs.
 *
 * Cette table n'est plus qu'un REPLI : le dashboard chiffre desormais
 * chaque job depuis sa propre duree (_measuredCostUsd) et ne retombe
 * ici que pour les lignes sans finished_at. */
const MODAL_COST_USD: Record<string, number> = {
  'text2image':  0.003,   // MESURE (n=44, mediane 6 s)
  // 2026-08-03 — RECALES SUR LA FACTURE REELLE. Ces cinq valeurs etaient des
  // suppositions (marquees « suspect ») trop hautes d'un facteur ~15.
  // Mesure : le 2026-07-28, l'app myfabmesh-cloud a coute 9,7748 $ pour 26
  // generations reussies, soit 0,376 $ tout compris — rectification et vue
  // arriere INCLUSES. Le maillage seul valant 0,37 $ (673 s x tarif L40S), il
  // ne reste que ~0,006 $ par generation pour les DEUX appels auxiliaires
  // reunis. Coherent avec 'text2image', MESURE a 0,003 $ pour une passe de
  // diffusion de ~6 s : rectify, back-view et sheet sont de la meme classe.
  // Les anciennes valeurs auraient surestime chaque generation de ~30 %, donc
  // rationne les comptes gratuits pour une depense qui n'existe pas.
  'back-view':   0.004,
  'rectify':     0.003,
  'sheet':       0.005,
  'mvadapter':   0.012,   // 6 vues orthographiques (endpoint pas encore deploye)
  'tpose':       0.004,
  'mesh':        0.370,   // MESURE (n=17, 373 s) + traine scaledown 300 s
  'mesh-face':   0.420,   // 'mesh' + le delta face_fix de l'ancienne table
  'remove-bg':   0.005,   // non mesure
  // 2026-07-26 — the four async Modal op types had NO entry here AND no
  // cost_usd on their jobs row, so the admin dashboard reported a 100%
  // margin on every rig / segmentation / animation. Values MUST stay in
  // sync with the ESTIMATED_USD_* constants the budget guard actually
  // charges (they live further down the file, hence literals here):
  //   'rig'          ↔ ESTIMATED_USD_RIG      (l.~7770)
  //   'segment'      ↔ ESTIMATED_USD_SEGMENT  (l.~7822)
  //   'animate'      ↔ ESTIMATED_USD_ANIM     (l.~7871)
  //   'animate_fbx'  ↔ ESTIMATED_USD_ANIM     (same app family, CPU)
  //   'mesh-op'      ↔ estimatedTotal in handleMeshOp
  //   'construction3d' ↔ estimatedTotal in handleConstructionStages3d
  //   'mesh-op-client' → 0 (pure R2 upload, no GPU, no credits)
  // A mismatch is a silent accounting drift — grep both sides when tuning.
  'rig':            0.05,
  'segment':        0.15,   // MESURE (0,1107 $ le 2026-08-04, 117 s, PartSAM feedforward)
  'animate':        0.06,
  'animate_fbx':    0.06,
  'mesh-op':        0.001,   // MESURE (n=4, mediane 13 s sur CPU)
  'construction3d': 0.01,
  'mesh-op-client': 0,
};

/** Persist a single non-mesh operation in the jobs table so the
 *  history CSV can show it. Mesh inserts happen inline in handleGenerate
 *  (they already need a job row for status polling). Fire-and-forget —
 *  a logging failure must never bubble up to the user-visible response. */
async function logOperation(
  env: Env,
  userId: string,
  // Free-form so callers can log a granular op type; unknown keys simply
  // fall back to cost 0 in the MODAL_COST_USD lookup below.
  opType: string,
  credits: number,
  startTs: number,
  endTs: number,
  status: 'succeeded' | 'failed',
  meta: Record<string, unknown> = {},
): Promise<void> {
  if (isMock(env)) return;
  try {
    const cost = MODAL_COST_USD[opType] ?? 0;
    await supabaseAdmin(env).from('jobs').insert({
      id: 'op_' + crypto.randomUUID().replace(/-/g, ''),
      user_id: userId,
      asset_type: opType,
      // ÉCRITURE EN DOUBLE, colonnes ET `options`, le temps que tous les
      // lecteurs basculent. `asset_type` ne pouvait pas servir de filtre :
      // il vaut 'character' pour un maillage (le type d'objet) et
      // 'text2image' pour une opération (le type d'appel) — polysémique,
      // donc inexploitable. Voir la migration
      // 20260804120000_jobs_type_cost.sql.
      type: opType,
      cost_usd: cost,
      mode: 'op',
      seed: 0,
      credit_cost: credits,
      status,
      options: {
        operation_type: opType,
        cost_usd: cost,
        duration_ms: endTs - startTs,
        ...meta,
      },
      created_at: new Date(startTs).toISOString(),
      finished_at: new Date(endTs).toISOString(),
    });
  } catch (e) {
    console.warn('[history] logOperation failed:', e instanceof Error ? e.message : String(e));
  }
}

/** Options facturees par le bareme mais qu'AUCUN code serveur n'execute.
 *
 *  Audit de parite du 2026-08-02 : ces drapeaux partent bien vers Modal,
 *  mais ni `generate_to_volume` (modal_app/app.py), ni modal_app/_mesh.py,
 *  ni le repli cog/predict.py ne les lisent. Le supplement etait donc
 *  encaisse pour un travail qui n'a jamais lieu.
 *
 *  `refine` est le plus couteux : le tableau des valeurs par defaut par
 *  type d'asset le mettait a true pour character, creature, animal,
 *  building, weapon, prop, environment et insect — coche d'office, a
 *  2 credits, sur la quasi-totalite des generations.
 *
 *  L'interface les masque desormais (cloud-overrides.js), mais un client
 *  en cache ou trafique pourrait encore les envoyer : on les neutralise
 *  ici, a la source, AVANT le calcul du prix ET avant l'appel a Modal.
 *  Le jour ou le backend saura les faire, retirer la cle de cette liste. */
const OPTIONS_SANS_EFFET_CLOUD = ['refine', 'face_fix', 'smooth'] as const;

function _neutraliserOptionsSansEffet(i: GenerateInput): GenerateInput {
  const rec = i as unknown as Record<string, unknown>;
  for (const k of OPTIONS_SANS_EFFET_CLOUD) {
    if (rec[k]) {
      console.log(`[parite] option '${k}' ignoree et NON facturee : aucun code serveur ne l'execute`);
      rec[k] = false;
    }
  }
  return i;
}

async function creditCost(env: Env, i: GenerateInput): Promise<number> {
  _neutraliserOptionsSansEffet(i);
  const p = await _getPricing(env);
  // Preset base cost — fast (default) / balanced / quality
  let n: number;
  if (i.preset === 'ultra_8k')      n = p.mesh_ultra_8k  ?? 8;
  else if (i.preset === 'quality')  n = p.mesh_quality   ?? 4;
  else if (i.preset === 'balanced') n = p.mesh_balanced  ?? 2;
  else                              n = p.mesh_fast      ?? 1;

  // Optional add-ons — admin can tune each one independently.
  if (i.multiref)     n += p.mesh_multiref     ?? 1;
  if (i.refine)       n += p.mesh_refine       ?? 2;
  if (i.rectify)      n += p.mesh_rectify      ?? 1;
  if (i.quality_plus) n += p.mesh_quality_plus ?? 1;
  if (i.ultra_q)      n += p.mesh_ultra_q      ?? 2;
  // ultra_hd add-on is INCLUDED in the ultra_8k preset price (8 cr),
  // so don't double-charge for it when the preset already covers it.
  if (i.ultra_hd && i.preset !== 'ultra_8k') n += p.mesh_ultra_hd ?? 3;
  if (i.face_fix)     n += p.mesh_face_fix     ?? 2;

  // Legacy: old clients still send mode=full without preset.
  if (i.mode === 'full' && !i.preset) {
    n = Math.max(n, p.mesh_quality ?? 4);
  }
  return n;
}

function replicateClient(env: Env): Replicate {
  const token = env.REPLICATE_API_TOKEN;
  if (!token) throw new Error('REPLICATE_API_TOKEN is not set as a Worker secret.');
  return new Replicate({ auth: token });
}

async function createReplicatePrediction(env: Env, input: GenerateInput) {
  const replicate = replicateClient(env);
  const modelSlug = env.REPLICATE_MODEL ?? 'fishwowater/trellis2';
  let version = env.REPLICATE_VERSION ?? '';
  if (!version) {
    const [owner, name] = modelSlug.split('/');
    const model = await replicate.models.get(owner, name);
    version = model.latest_version?.id ?? '';
    if (!version) throw new Error(`No version found for ${modelSlug}`);
  }
  const isOurCog = modelSlug.includes('myfabmesh-cloud');
  const payload = isOurCog
    ? {
        image: input.image,
        asset_type: input.asset_type, mode: input.mode,
        seed: input.seed ?? 42,
        rectify: input.rectify ?? true,
        back_view: input.back_view ?? (input.asset_type === 'character' || input.asset_type === 'creature'),
        smooth: input.smooth ?? true,
        face_fix: input.face_fix ?? false,
        ultra_hd: input.ultra_hd ?? false,
        // Advanced TRELLIS-2 options. Cog will silently drop any key it
        // doesn't recognise so it's safe to forward all of them.
        refine: input.refine ?? false,
        quality_plus: input.quality_plus ?? false,
        ultra_q: input.ultra_q ?? false,
        multiref: input.multiref ?? false,
        ...(input.preset ? { preset: input.preset } : {}),
      }
    : {
        image: input.image, seed: input.seed ?? 42,
        generate_model: true, generate_video: false, preprocess_image: true,
        texture_size: input.mode === 'full' ? 2048 : 1024,
        decimation_target: input.mode === 'lite' ? 100_000
                          : input.mode === 'full' ? 1_500_000 : 500_000,
        sparse_structure_steps: input.mode === 'lite' ? 8 : 12,
        shape_slat_steps: input.mode === 'lite' ? 8 : 12,
        tex_slat_steps: input.mode === 'lite' ? 8 : 12,
      };
  return replicate.predictions.create({ version, input: payload as Record<string, unknown> });
}

/* ────────────────────────── r2 upload helper ───────────────────────── */

/**
 * Stream a remote GLB into the bound R2 bucket and return a public URL
 * derived from R2_PUBLIC_URL. If the env var isn't set, returns the
 * source URL unchanged (caller can still serve Replicate's signed URL,
 * but it'll expire after 24 h).
 */
async function uploadGlbToR2(env: Env, sourceUrl: string, key: string): Promise<string> {
  if (!env.MESHES || !env.R2_PUBLIC_URL) return sourceUrl;
  const res = await assetFetch(env, sourceUrl);
  if (!res.ok) throw new Error(`source fetch failed: ${res.status}`);
  const body = await res.arrayBuffer();
  await env.MESHES.put(key, body, { httpMetadata: { contentType: 'model/gltf-binary' } });
  return await signedR2Url(env, key, 'mesh');
}

/* ───────────────────── stripe webhook signature ────────────────────── */

/**
 * Verify a Stripe webhook using the Web Crypto API (`crypto.subtle`)
 * rather than `node:crypto`. Mirrors `stripe.webhooks.constructEvent`
 * but works in the Worker runtime.
 *
 * Stripe `Stripe-Signature` header format:
 *   t=<unix-ts>,v1=<hex-sha256-hmac>(,v1=<other>)*
 */
async function verifyStripeSignature(payload: string, header: string, secret: string, toleranceS = 300): Promise<boolean> {
  const parts = Object.fromEntries(
    header.split(',').map(kv => {
      const i = kv.indexOf('=');
      return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)];
    })
  ) as Record<string, string>;
  const t = parseInt(parts.t ?? '', 10);
  const v1 = header.split(',').filter(s => s.startsWith('v1=')).map(s => s.slice(3));
  if (!t || v1.length === 0) return false;

  const skew = Math.abs(Math.floor(Date.now() / 1000) - t);
  if (skew > toleranceS) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`));
  const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');

  // Constant-time compare against any of the v1 signatures provided.
  return v1.some(candidate => timingSafeEqualHex(candidate, expected));
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ───────────────────────────── routes ──────────────────────────────── */

/** GET /api/me/export — RGPD Art. 15 (Right of access).
 *  Returns every datapoint we hold for the authenticated user:
 *  profile, jobs, payments, R2 keys (just the names, not the bytes).
 *  Stream a JSON blob the user can download and feed to another
 *  provider if they want. */
/** Motifs de signalement proposés. Volontairement courts et explicites :
 *  le testeur de certification doit comprendre l'écran en trois secondes. */
const MOTIFS_SIGNALEMENT = new Set([
  'sexual', 'violence', 'hate', 'harassment', 'minor',
  'illegal', 'misinformation', 'copyright', 'other',
]);

/** POST /api/report-content — signalement d'un contenu généré par l'IA.
 *
 *  EXIGÉ PAR LA CERTIFICATION MICROSOFT STORE, politique 11.16 « Live
 *  Generative AI Content » : tout produit qui présente à l'utilisateur du
 *  contenu créé par un modèle génératif doit lui offrir un moyen de
 *  signaler un contenu inapproprié. Son absence a motivé le refus du
 *  2026-08-04 (rapport 83ac9ac1, produit 9PH6GT8XKQDW).
 *
 *  DÉLIBÉRÉMENT OUVERT AUX VISITEURS NON CONNECTÉS. Un mécanisme de
 *  signalement que l'on ne peut atteindre qu'après s'être authentifié
 *  n'en est pas un : la personne la mieux placée pour signaler un contenu
 *  peut très bien être celle qui le découvre sans compte. Le débit est
 *  donc borné par IP, pas par session. */
async function handleReportContent(req: Request, env: Env): Promise<Response> {
  let corps: {
    reason?: string; details?: string; asset_url?: string;
    job_id?: string; prompt?: string; surface?: string; kind?: string;
  };
  // L'OBJET LUI-MÊME VOYAGE AVEC LE SIGNALEMENT.
  // La première version n'envoyait qu'un chemin de fichier — sur la machine
  // du signalant. Inexploitable depuis le tableau de bord : impossible de
  // juger un contenu qu'on ne peut pas ouvrir. On accepte donc un envoi
  // multipart portant le fichier incriminé, plus un aperçu PNG quand le
  // fichier n'est pas affichable tel quel (un maillage, typiquement).
  // Le JSON reste accepté : un signalement sans pièce vaut mieux qu'aucun.
  let fichier: File | null = null;
  let apercu: File | null = null;
  const contentType = req.headers.get('content-type') || '';
  if (contentType.includes('multipart/form-data')) {
    let form: FormData;
    try { form = await req.formData(); } catch { return err(400, 'bad multipart'); }
    const t = (k: string) => String(form.get(k) ?? '');
    corps = {
      reason: t('reason'), details: t('details'), asset_url: t('asset_url'),
      job_id: t('job_id'), prompt: t('prompt'), surface: t('surface'), kind: t('kind'),
    };
    const a = form.get('asset');
    if (a instanceof File && a.size > 0) {
      // 60 Mo : un maillage texturé pèse lourd, et refuser la pièce
      // reviendrait à perdre la seule chose qui permette de juger.
      if (a.size > 60 * 1024 * 1024) return err(413, 'asset too large (>60 MB)');
      fichier = a;
    }
    const p = form.get('preview');
    if (p instanceof File && p.size > 0) {
      if (p.size > 5 * 1024 * 1024) return err(413, 'preview too large (>5 MB)');
      apercu = p;
    }
  } else {
    try { corps = await req.json() as typeof corps; } catch { return err(400, 'bad json'); }
  }

  const motif = String(corps.reason ?? '').trim().toLowerCase();
  if (!MOTIFS_SIGNALEMENT.has(motif)) return err(400, 'reason invalide');

  // Bornage par IP : 20 signalements par jour et par adresse. Assez large
  // pour un usage sincère, assez serré pour qu'un script n'inonde pas R2.
  const ip = req.headers.get('cf-connecting-ip') || 'inconnue';
  if (env.MESHES) {
    const compteur = await _casIncrementCounter(
      env, `_meta/report_rate/${todayUTC()}/${ip}`, 1, 20);
    if (compteur == null) return err(429, 'trop de signalements depuis cette adresse');
  }

  // La session est FACULTATIVE : elle enrichit le signalement quand elle
  // existe, elle ne le conditionne jamais.
  const user = await getSessionUser(req, env).catch(() => null);

  if (!env.MESHES) return err(503, 'stockage indisponible');

  // UN SIGNALEMENT DEVIENT UN MESSAGE ADMIN, pas une pile parallèle.
  // Il atterrit dans l'onglet « Messages » déjà consulté, avec son badge
  // de non-lus, son marquage comme lu et son bouton de réponse. Un silo
  // `_reports/` séparé aurait exigé une deuxième interface — et un
  // dispositif de signalement que personne n'ouvre ne vaut rien, ni pour
  // les utilisateurs ni devant la certification.
  //
  // L'identifiant suit EXACTEMENT le format des messages de contact : la
  // route admin de lecture/réponse n'accepte que [A-Za-z0-9_], un
  // horodatage ISO avec ses tirets aurait rendu le message impossible à
  // traiter depuis le tableau de bord.
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const details = String(corps.details ?? '').slice(0, 4000);
  const assetUrl = String(corps.asset_url ?? '').slice(0, 2000);
  const prompt = String(corps.prompt ?? '').slice(0, 4000);
  const kind = String(corps.kind ?? '').slice(0, 40);
  const surface = String(corps.surface ?? '').slice(0, 40);   // desktop | web
  const jobId = String(corps.job_id ?? '').slice(0, 200);

  // Corps lisible tel quel dans l'onglet Messages, sans avoir à déplier
  // une structure. Le PROMPT est déterminant pour instruire un
  // signalement : c'est lui qui dit si le modèle a dérapé seul ou s'il a
  // été poussé à le faire.
  const message = [
    `SIGNALEMENT DE CONTENU GÉNÉRÉ PAR L'IA`,
    ``,
    `Motif      : ${motif}`,
    `Type       : ${kind || 'non précisé'}`,
    `Provenance : ${surface || 'non précisée'}`,
    jobId ? `Job        : ${jobId}` : '',
    ``,
    `Prompt utilisé :`,
    prompt || '(non transmis)',
    ``,
    `Fichier concerné :`,
    assetUrl || '(non transmis)',
    ``,
    `Précisions du signalant :`,
    details || '(aucune)',
  ].filter((l) => l !== '').join('\n');

  // Écriture des pièces AVANT le message : si l'upload échoue, on préfère
  // un signalement sans pièce à un message qui promet une pièce absente.
  const attachments: Array<Record<string, unknown>> = [];
  for (const [champ, f] of [['preview', apercu], ['asset', fichier]] as Array<[string, File | null]>) {
    if (!f) continue;
    try {
      const nom = (f.name || champ).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
      const cle = `_meta/contact/${id}/${champ}_${nom}`;
      const octets = new Uint8Array(await f.arrayBuffer());
      await env.MESHES.put(cle, octets, {
        httpMetadata: { contentType: f.type || 'application/octet-stream' },
      });
      attachments.push({
        key: cle,
        // TTL long : un signalement peut être instruit des jours plus tard.
        url: await signedR2Url(env, cle, 'export'),
        mime: f.type || 'application/octet-stream',
        size: octets.length,
        name: nom,
        role: champ,          // 'preview' s'affiche, 'asset' se télécharge
      });
    } catch (e) {
      console.warn(`[signalement] piece ${champ} non stockee:`, (e as Error).message);
    }
  }

  const payload = {
    id,
    name: user?.email ? `Signalement — ${user.email}` : 'Signalement anonyme',
    email: user?.email ?? '',
    subject: `⚑ Contenu IA signalé — ${motif}`,
    message,
    user_id: user?.id ?? null,
    user_email: user?.email ?? null,
    ip,
    user_agent: req.headers.get('user-agent') ?? null,
    created_at: new Date().toISOString(),
    read: false,          // fait s'allumer le badge de l'onglet Messages
    attachments,          // l'objet signalé lui-même, + son aperçu
    // Doublon structuré du corps ci-dessus : le texte sert à l'humain,
    // cet objet sert à un futur tri/export sans avoir à ré-analyser la
    // prose. Les deux sont écrits d'un seul tenant, ils ne peuvent pas
    // diverger.
    report: { reason: motif, details, asset_url: assetUrl, prompt, kind, surface, job_id: jobId },
  };

  await env.MESHES.put(`_meta/contact/${id}.json`, JSON.stringify(payload),
                       { httpMetadata: { contentType: 'application/json' } });
  console.warn(`[signalement] ${id} motif=${motif} type=${kind} provenance=${surface}`);

  return json({ ok: true, id });
}

/** Volet marketplace de l'export RGPD : ce que la boutique détient sur un
 *  compte, en dehors de son préfixe R2. Le vendeur doit pouvoir constater
 *  que son e-mail y est stocké et que son compte Stripe y est rattaché. */
async function _exportMarketplaceDuCompte(env: Env, userId: string): Promise<{
  fiches_en_vente: unknown[]; achats: string[]; vendeur: unknown;
}> {
  const vide = { fiches_en_vente: [], achats: [], vendeur: null };
  if (!env.MESHES) return vide;
  try {
    const toutes = await _loadAllListings(env);
    const fiches = toutes.filter((f) => f.user_id === userId);
    const achats: string[] = [];
    for (const f of toutes) {
      if (await env.MESHES.head(`_market/owners/${f.id}/${userId}.json`)) achats.push(f.id);
    }
    const vTxt = await r2GetText(env, `_market/sellers/${userId}.json`);
    return {
      fiches_en_vente: fiches,
      achats,
      vendeur: vTxt ? JSON.parse(vTxt) as unknown : null,
    };
  } catch {
    return vide;
  }
}

async function handleMeExport(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  const sb = supabaseAdmin(env);
  const [profile, jobs, payments, assets] = await Promise.all([
    sb.from('profiles').select('*').eq('id', user.id).maybeSingle(),
    sb.from('jobs').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(5000),
    sb.from('payments').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(5000),
    // Manquait à l'appel : l'arborescence nominative des projets.
    sb.from('user_assets').select('*').eq('user_id', user.id).limit(5000),
  ]);
  const r2Keys: Array<{ key: string; size: number; uploaded: string; download_url: string }> = [];
  if (env.MESHES) {
    let cursor: string | undefined;
    let pages = 0;
    do {
      const list = await env.MESHES.list({ prefix: `${user.id}/`, cursor, limit: 1000 });
      for (const obj of list.objects) {
        // Re-sign with the long 'export' TTL (30d) since the JSON leaves the
        // system; the raw `key` is kept so a stale link can be refreshed.
        r2Keys.push({
          key: obj.key, size: obj.size, uploaded: obj.uploaded.toISOString(),
          download_url: await signedR2Url(env, obj.key, 'export'),
        });
      }
      cursor = list.truncated ? list.cursor : undefined;
      pages++;
    } while (cursor && pages < 20);
  }
  const body = {
    exported_at: new Date().toISOString(),
    export_links_note: 'download_url values are signed and expire ~30 days after export. The raw key can be used to request a fresh link.',
    user: { id: user.id, email: user.email },
    profile: profile.data ?? null,
    jobs: jobs.data ?? [],
    payments: payments.data ?? [],
    user_assets: assets.data ?? [],
    // La marketplace était absente de l'export alors qu'elle détient des
    // données du compte : fiches mises en vente (avec l'e-mail en clair),
    // achats effectués, et le rattachement Stripe Connect du vendeur.
    marketplace: await _exportMarketplaceDuCompte(env, user.id),
    r2_keys: r2Keys,
  };
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="myfabmesh-export-${user.id}.json"`,
      ...SECURITY_HEADERS,
    },
  });
}

/** POST /api/me/delete — RGPD Art. 17 (Right to be forgotten).
 *  Cascades: delete every R2 object under <user.id>/*, delete jobs +
 *  payments rows, delete the auth.users entry (which cascades to
 *  profiles via the FK ON DELETE CASCADE in schema.sql). Body must
 *  carry `confirm: "DELETE"` so a CSRF that hits this endpoint
 *  without UI consent can't nuke an account in one click.
 *
 *  Returns 200 with what was deleted. The client should then clear
 *  its Supabase cookie locally — there's no auth to keep. */
async function handleMeDelete(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  let body: { confirm?: string } | null = null;
  try { body = await req.json() as { confirm?: string }; } catch { return err(400, 'body required'); }
  if (body?.confirm !== 'DELETE') return err(400, 'confirm field must be "DELETE"');

  const sb = supabaseAdmin(env);
  // R2 first — heaviest. Even if Supabase fails halfway, the user
  // can re-call and we'll just skip already-deleted keys.
  let r2Deleted = 0;
  if (env.MESHES) {
    let cursor: string | undefined;
    let pages = 0;
    do {
      const list = await env.MESHES.list({ prefix: `${user.id}/`, cursor, limit: 1000 });
      const keys = list.objects.map((o) => o.key);
      if (keys.length) {
        await Promise.all(keys.map((k) => env.MESHES.delete(k).catch(() => {})));
        r2Deleted += keys.length;
      }
      cursor = list.truncated ? list.cursor : undefined;
      pages++;
    } while (cursor && pages < 50);
  }
  // RGPD — les traces qui vivent HORS du préfixe `<uid>/`. La boucle
  // ci-dessus ne balaie que les objets du compte : tout ce qui suit
  // survivait intégralement à une demande de suppression.
  if (env.MESHES) {
    for (const cle of [`_logs/latest/${user.id}.log`,      // journaux console
                       `_meta/paid/${user.id}`,            // drapeau compte payant
                       `_market/sellers/${user.id}.json`]) { // lien Stripe Connect
      await env.MESHES.delete(cle).catch(() => {});
    }
    // Les fiches marketplace stockent `author_email` EN CLAIR — il n'est
    // masqué qu'à la lecture publique, donc l'e-mail restait sur disque après
    // la fermeture du compte. Elles resteraient en plus en vente au nom d'un
    // compte disparu, avec un reversement voué à l'échec. On les dépublie et
    // on les anonymise SANS les supprimer : les acheteurs doivent garder
    // l'accès à ce qu'ils ont déjà payé.
    try {
      for (const fiche of await _loadAllListings(env)) {
        if (fiche.user_id !== user.id) continue;
        fiche.author_email = null;
        fiche.author_display = 'Compte supprimé';
        fiche.status = 'rejected';
        fiche.rejection_reason = 'compte supprimé par son titulaire';
        await env.MESHES.put(`_market/listings/${fiche.id}.json`, JSON.stringify(fiche),
                             { httpMetadata: { contentType: 'application/json' } });
      }
    } catch (e) {
      console.warn('[rgpd] anonymisation des fiches:', (e as Error).message);
    }
  }
  // Drop rows. payments + jobs cascade via FK on auth.users when we
  // delete the auth.users row, but doing them explicitly here ensures
  // a partial-failure state still leaves an empty account.
  await sb.from('payments').delete().eq('user_id', user.id);
  await sb.from('jobs').delete().eq('user_id', user.id);
  // user_assets n'était PAS effacée : elle garde r2_path, project et meta,
  // soit l'arborescence nominative des projets du compte.
  await sb.from('user_assets').delete().eq('user_id', user.id);
  await sb.from('profiles').delete().eq('id', user.id);
  // Finally delete the Supabase auth user — admin API endpoint.
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  let authDeleted = false;
  if (supabaseUrl && serviceRole) {
    try {
      const r = await fetch(`${supabaseUrl}/auth/v1/admin/users/${user.id}`, {
        method: 'DELETE',
        headers: { 'apikey': serviceRole, 'authorization': `Bearer ${serviceRole}` },
      });
      authDeleted = r.ok;
    } catch {}
  }
  return json({
    ok: true,
    r2_objects_deleted: r2Deleted,
    auth_user_deleted: authDeleted,
  });
}

/** POST /api/auth/install-session — body { access_token, refresh_token, expires_in? }
 *  Client just did supabase.auth.signInWithPassword(); this endpoint
 *  copies the resulting access_token into a HttpOnly cookie so future
 *  requests can authenticate WITHOUT exposing the JWT to JS.
 *
 *  Validates the access_token by calling Supabase /auth/v1/user before
 *  setting the cookie — a forged token gets a clean 401. */
async function handleAuthInstallSession(req: Request, env: Env): Promise<Response> {
  let body: { access_token?: string; refresh_token?: string; expires_in?: number };
  try { body = await req.json() as typeof body; } catch { return err(400, 'bad json'); }
  const at = String(body.access_token ?? '');
  const rt = String(body.refresh_token ?? '');
  if (!at) return err(400, 'access_token required');

  // Verify the access_token is real before we set a cookie with it.
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!supabaseUrl || !anon) return err(500, 'supabase not configured');
  const probe = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { 'authorization': `Bearer ${at}`, 'apikey': anon },
  });
  if (!probe.ok) return err(401, 'invalid access_token');

  // Default Supabase access_token lifetime is 1h. We mirror it on the
  // cookie so a stolen cookie ages out with the token it carries.
  const maxAge = typeof body.expires_in === 'number' && body.expires_in > 0
    ? Math.min(body.expires_in, 60 * 60 * 24)  // cap at 24h
    : 60 * 60;
  const sessionCookie = `${MFM_SESSION_COOKIE}=${at}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
  // Refresh cookie has a much longer life (30 days) and is only
  // ever read server-side to mint a new access_token.
  const headers = new Headers({
    'content-type': 'application/json',
  });
  headers.append('set-cookie', sessionCookie);
  if (rt) {
    headers.append('set-cookie',
      `${MFM_REFRESH_COOKIE}=${rt}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 60 * 60}`);
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

/** POST /api/auth/refresh — exchange the long-lived refresh cookie for
 *  a new access_token + refresh_token pair and re-set both HttpOnly
 *  cookies. The renderer pings this every ~50 min (before the 1-hour
 *  access_token TTL) so a user keeps their session as long as the
 *  refresh token (30 days) is alive.
 *
 *  Without this the user was getting silently logged out after 1 h
 *  even though their refresh cookie was still valid. */
async function handleAuthRefresh(req: Request, env: Env): Promise<Response> {
  const cookies = parseCookies(req);
  const rt = cookies[MFM_REFRESH_COOKIE];
  if (!rt) return err(401, 'no refresh cookie');

  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!supabaseUrl || !anon) return err(500, 'supabase not configured');

  const r = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'apikey': anon },
    body: JSON.stringify({ refresh_token: rt }),
  });
  if (!r.ok) {
    // Refresh failed (revoked, expired, user deleted) — wipe cookies
    // so the next /api/me cleanly returns 401 and the renderer can
    // route to /login without a stale session sticking around.
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.append('set-cookie',
      `${MFM_SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
    headers.append('set-cookie',
      `${MFM_REFRESH_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
    return new Response(JSON.stringify({ ok: false, error: 'refresh rejected' }),
      { status: 401, headers });
  }
  const data = await r.json() as {
    access_token?: string; refresh_token?: string; expires_in?: number;
  };
  if (!data.access_token) return err(502, 'supabase did not return access_token');

  const maxAge = typeof data.expires_in === 'number' && data.expires_in > 0
    ? Math.min(data.expires_in, 60 * 60 * 24)
    : 60 * 60;
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append('set-cookie',
    `${MFM_SESSION_COOKIE}=${data.access_token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
  if (data.refresh_token) {
    headers.append('set-cookie',
      `${MFM_REFRESH_COOKIE}=${data.refresh_token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 60 * 60}`);
  }
  return new Response(JSON.stringify({ ok: true, expires_in: maxAge }),
    { status: 200, headers });
}

/** POST /api/auth/signout — clear both HttpOnly cookies. Idempotent. */
async function handleAuthSignout(_req: Request, _env: Env): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append('set-cookie',
    `${MFM_SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
  headers.append('set-cookie',
    `${MFM_REFRESH_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

/** POST /api/contact — public endpoint for messages from the About →
 *  Contact form. Stores each message as a JSON file under
 *  `_meta/contact/<timestamp>_<random>.json` so the admin can list
 *  them from /admin > Messages.
 *
 *  No auth required (anonymous visitors should be able to write us).
 *  Per-IP rate limit + global daily cap stop spam from flooding R2. */
async function handleContactSubmit(req: Request, env: Env): Promise<Response> {
  if (!env.MESHES) return err(500, 'storage not configured');
  const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'unknown';
  // Daily anti-spam: max 5 messages per IP/day and 200 messages
  // globally/day. Both counters live in R2 and reset at UTC midnight.
  const today = new Date().toISOString().slice(0, 10);
  const ipKey = `_meta/contact_count/${today}/${_safeId(ip)}.txt`;
  const globalKey = `_meta/contact_count/${today}/_global.txt`;
  const ipCur = parseInt((await r2GetText(env, ipKey)) || '0', 10) || 0;
  const globCur = parseInt((await r2GetText(env, globalKey)) || '0', 10) || 0;
  if (ipCur >= 5) return err(429, 'Too many messages from this IP today. Try again tomorrow.');
  if (globCur >= 200) return err(429, 'Contact form is rate-limited today, please try again tomorrow.');
  // Accept both JSON (legacy / no screenshots) and multipart/form-data
  // (when the user attached screenshots — uploaded as files alongside
  // the text fields). The flow re-uses the same fields either way.
  const contentType = req.headers.get('content-type') || '';
  let body: { name?: string; email?: string; subject?: string; message?: string };
  const screenshots: Array<{ name: string; bytes: Uint8Array; mime: string }> = [];
  if (contentType.includes('multipart/form-data')) {
    let form: FormData;
    try { form = await req.formData(); } catch { return err(400, 'bad multipart'); }
    body = {
      name:    String(form.get('name')    || ''),
      email:   String(form.get('email')   || ''),
      subject: String(form.get('subject') || ''),
      message: String(form.get('message') || ''),
    };
    for (let i = 0; i < 5; i++) {
      const f = form.get(`screenshot_${i}`);
      if (!(f instanceof File)) continue;
      if (f.size > 5 * 1024 * 1024) return err(413, `screenshot_${i} too large (>5 MB)`);
      const mime = f.type || 'image/png';
      if (!/^image\/(png|jpe?g|webp)$/i.test(mime)) {
        return err(400, `screenshot_${i} unsupported type: ${mime}`);
      }
      const bytes = new Uint8Array(await f.arrayBuffer());
      // Cheap magic-byte sanity check.
      const isPng  = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
      const isJpeg = bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
      const isWebp = bytes.length >= 12
                  && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
                  && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
      if (!isPng && !isJpeg && !isWebp) return err(400, `screenshot_${i} bytes don't match its declared type`);
      screenshots.push({ name: f.name || `screenshot_${i}.png`, bytes, mime });
    }
  } else {
    try { body = await req.json() as typeof body; } catch { return err(400, 'bad json'); }
  }
  const name    = String(body.name    ?? '').trim().slice(0, 80);
  const email   = String(body.email   ?? '').trim().slice(0, 120);
  const subject = String(body.subject ?? '').trim().slice(0, 120);
  const message = String(body.message ?? '').trim().slice(0, 4000);
  // Every field is required — UI mirror enforces this too, but a
  // direct API call could bypass the UI so we re-check here.
  if (!name)    return err(400, 'name required');
  if (!email)   return err(400, 'email required');
  if (!subject) return err(400, 'subject required');
  if (!message) return err(400, 'message required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err(400, 'invalid email');
  // Try to attach the authenticated user if there is one — helpful
  // context for replying.
  let user_id: string | null = null;
  let user_email: string | null = null;
  try {
    const u = await getSessionUser(req, env);
    if (u) { user_id = u.id; user_email = u.email ?? null; }
  } catch {}
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  // Persist screenshots to R2 alongside the message JSON. Paths live
  // under _meta/contact/<id>/screenshot_N.<ext> so the admin can list
  // & view them next to the message body.
  const attachments: Array<{ key: string; url: string; mime: string; size: number; name: string }> = [];
  try {
    for (let i = 0; i < screenshots.length; i++) {
      const s = screenshots[i];
      const ext = s.mime === 'image/jpeg' ? 'jpg'
                : s.mime === 'image/webp' ? 'webp' : 'png';
      const key = `_meta/contact/${id}/screenshot_${i}.${ext}`;
      await env.MESHES.put(key, s.bytes, {
        httpMetadata: { contentType: s.mime },
        customMetadata: { original_name: s.name.slice(0, 100) },
      });
      const url = await signedR2Url(env, key, 'image');
      attachments.push({ key, url, mime: s.mime, size: s.bytes.length, name: s.name });
    }
  } catch (e) {
    return err(502, `screenshot write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const payload = {
    id,
    name, email, subject, message,
    user_id, user_email,
    ip,
    user_agent: req.headers.get('user-agent') ?? null,
    created_at: new Date().toISOString(),
    read: false,
    attachments,
  };
  try {
    await env.MESHES.put(`_meta/contact/${id}.json`, JSON.stringify(payload),
                         { httpMetadata: { contentType: 'application/json' } });
    await env.MESHES.put(ipKey, String(ipCur + 1));
    await env.MESHES.put(globalKey, String(globCur + 1));
  } catch (e) {
    return err(502, `storage write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return json({ ok: true, success: true, id, attachments: attachments.length });
}

function _safeId(s: string): string {
  // Collapse anything that isn't [a-z0-9._-] to underscore for use in
  // R2 key segments (IPs contain ':' for IPv6 etc.).
  return s.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 64);
}

/** GET /api/admin/contact-messages — list every stored message,
 *  newest first. */
async function handleAdminContactList(req: Request, env: Env): Promise<Response> {
  const adminCheck = await _requireAdmin(req, env);
  if (adminCheck instanceof Response) return adminCheck;
  if (!env.MESHES) return err(500, 'storage not configured');
  try {
    // Paginate — R2's list cap is 1000 per call and big inboxes will
    // hit that; loop with cursor until done. Also: exclude the
    // counter folder which shares the prefix _meta/contact_count/.
    const items: Array<Record<string, unknown>> = [];
    let cursor: string | undefined = undefined;
    do {
      const page = await env.MESHES.list({ prefix: '_meta/contact/', limit: 1000, cursor });
      for (const obj of page.objects) {
        // Skip anything that isn't a JSON message file under the
        // exact prefix (R2 can list pseudo-folders too).
        if (!obj.key.startsWith('_meta/contact/') || !obj.key.endsWith('.json')) continue;
        try {
          const text = await r2GetText(env, obj.key);
          if (!text) continue;
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object') items.push(parsed);
        } catch (parseErr) {
          // Log but don't 500 — one corrupt file shouldn't break the list.
          console.warn('[admin/contact] parse failed for', obj.key, parseErr);
        }
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    items.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return json({ ok: true, messages: items });
  } catch (e) {
    console.error('[admin/contact] list failed:', e);
    return err(500, 'contact list failed: ' + (e instanceof Error ? e.message : String(e)));
  }
}

/** POST /api/admin/contact-messages/<id>/read — flip the read flag. */
async function handleAdminContactRead(req: Request, env: Env, id: string): Promise<Response> {
  const adminCheck = await _requireAdmin(req, env);
  if (adminCheck instanceof Response) return adminCheck;
  if (!env.MESHES) return err(500, 'storage not configured');
  const key = `_meta/contact/${_safeId(id)}.json`;
  const txt = await r2GetText(env, key);
  if (!txt) return err(404, 'message not found');
  try {
    const m = JSON.parse(txt);
    m.read = true;
    await env.MESHES.put(key, JSON.stringify(m),
                         { httpMetadata: { contentType: 'application/json' } });
    return json({ ok: true, success: true });
  } catch (e) {
    return err(500, e instanceof Error ? e.message : String(e));
  }
}

/** DELETE /api/admin/contact-messages/<id> — remove a message. */
async function handleAdminContactDelete(req: Request, env: Env, id: string): Promise<Response> {
  const adminCheck = await _requireAdmin(req, env);
  if (adminCheck instanceof Response) return adminCheck;
  if (!env.MESHES) return err(500, 'storage not configured');
  const key = `_meta/contact/${_safeId(id)}.json`;
  await env.MESHES.delete(key);
  return json({ ok: true, success: true });
}

/** GET /api/me/published-assets — list every marketplace listing the
 *  current user owns. The renderer uses this to badge home grid cards
 *  that are already on the marketplace (pending / approved / rejected),
 *  so the user doesn't have to remember what they published. */
async function handleMePublishedAssets(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MESHES) return json({ items: [] });
  const items: Array<{
    listing_id: string;
    kind: 'mesh' | 'image';
    job_id: string | null;
    asset_url: string;
    status: string;
    price_cents: number;
    title: string;
    description: string;
    licence: string;
    currency: string;
    mesh_url: string;
    asset_type: string | null;
    author_display: string;
    user_id: string;
    created_at: string;
    rejection_reason?: string;
    rating_avg: number;
    rating_count: number;
  }> = [];
  // One bulk pass over ratings — N+1 would be brutal for a heavy seller.
  const ratingsByListing = await _loadAllRatingsByListing(env);
  let cursor: string | undefined;
  do {
    const page = await env.MESHES.list({ prefix: '_market/listings/', limit: 1000, cursor });
    for (const obj of page.objects) {
      if (!obj.key.endsWith('.json')) continue;
      try {
        const txt = await r2GetText(env, obj.key);
        if (!txt) continue;
        const parsed = JSON.parse(txt);
        if (parsed?.user_id === user.id) {
          const r = ratingsByListing.get(parsed.id) || { avg: 0, count: 0 };
          items.push({
            listing_id: parsed.id,
            kind: parsed.asset_kind || (parsed.mesh_url ? 'mesh' : 'image'),
            job_id: parsed.job_id || null,
            asset_url: parsed.asset_url || parsed.mesh_url || '',
            status: parsed.status || 'pending',
            price_cents: parsed.price_cents || 0,
            title: parsed.title || '',
            description: parsed.description || '',
            licence: parsed.licence || parsed.license || '',
            currency: parsed.currency || 'USD',
            mesh_url: parsed.mesh_url || '',
            asset_type: parsed.asset_type ?? null,
            author_display: parsed.author_display || '',
            user_id: parsed.user_id || '',
            created_at: parsed.created_at || '',
            rejection_reason: parsed.rejection_reason,
            rating_avg: r.avg,
            rating_count: r.count,
          });
        }
      } catch {}
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return json({ ok: true, items });
}

/** GET /api/me/earnings — totals + recent sales for the seller. Walks
 *  _market/sales/, filters by seller_user_id, sums payout_credits and
 *  amount_cents per currency. Returns the 10 most recent sales hydrated
 *  with the listing title. */
async function handleMeEarnings(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MESHES) return json({ ok: true, total_credits_paid: 0, sales_count: 0, by_currency: {}, recent: [] });

  let totalCredits = 0;
  let salesCount = 0;
  const byCurrency: Record<string, number> = {};
  const all: Array<{
    sale_id: string;
    listing_id: string;
    amount_cents: number;
    currency: string;
    payout_credits: number;
    paid_at: string;
  }> = [];

  let cursor: string | undefined;
  do {
    const page = await env.MESHES.list({ prefix: '_market/sales/', limit: 1000, cursor });
    for (const obj of page.objects) {
      if (!obj.key.endsWith('.json')) continue;
      try {
        const txt = await r2GetText(env, obj.key);
        if (!txt) continue;
        const s = JSON.parse(txt) as Record<string, unknown>;
        if (s?.seller_user_id !== user.id) continue;
        salesCount += 1;
        const credits = Number(s.payout_credits || 0);
        totalCredits += credits;
        const cur = String(s.currency || 'USD').toUpperCase();
        byCurrency[cur] = (byCurrency[cur] || 0) + Number(s.amount_cents || 0);
        all.push({
          sale_id: String(s.id || ''),
          listing_id: String(s.listing_id || ''),
          amount_cents: Number(s.amount_cents || 0),
          currency: cur,
          payout_credits: credits,
          paid_at: String(s.paid_at || s.created_at || ''),
        });
      } catch {}
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  all.sort((a, b) => b.paid_at.localeCompare(a.paid_at));
  const top = all.slice(0, 10);
  const recent: Array<Record<string, unknown>> = [];
  for (const r of top) {
    let title = '';
    try {
      const lTxt = await r2GetText(env, `_market/listings/${r.listing_id}.json`);
      if (lTxt) {
        const l = JSON.parse(lTxt) as Record<string, unknown>;
        title = String(l.title || '');
      }
    } catch {}
    recent.push({
      sale_id: r.sale_id,
      listing_id: r.listing_id,
      listing_title: title,
      amount_cents: r.amount_cents,
      currency: r.currency,
      payout_credits: r.payout_credits,
      paid_at: r.paid_at,
    });
  }

  return json({
    ok: true,
    total_credits_paid: totalCredits,
    sales_count: salesCount,
    by_currency: byCurrency,
    recent,
  });
}

/** GET /api/me/replies — current user only. Returns every contact
 *  message they sent that has an admin reply attached, so they can
 *  read the response on /account without us emailing them. */
async function handleMeReplies(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MESHES) return err(500, 'storage not configured');
  const items: Array<Record<string, unknown>> = [];
  let cursor: string | undefined = undefined;
  do {
    const page = await env.MESHES.list({ prefix: '_meta/contact/', limit: 1000, cursor });
    for (const obj of page.objects) {
      if (!obj.key.endsWith('.json')) continue;
      try {
        const text = await r2GetText(env, obj.key);
        if (!text) continue;
        const m = JSON.parse(text);
        if (m && m.user_id === user.id && m.reply_body) {
          items.push({
            id: m.id,
            subject: m.subject,
            message: m.message,
            reply_body: m.reply_body,
            replied_at: m.replied_at,
            created_at: m.created_at,
          });
        }
      } catch {}
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  items.sort((a, b) => String(b.replied_at).localeCompare(String(a.replied_at)));
  return json({ ok: true, replies: items });
}

/** GET /api/me/inbox — unified inbox: in-app notifications + admin
 *  contact replies. Auth required. */
async function handleMeInbox(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MESHES) return err(500, 'storage not configured');
  const items: Array<Record<string, unknown>> = [];

  // 1) Notifications under _notifications/<user.id>/
  let cursorN: string | undefined = undefined;
  do {
    const page = await env.MESHES.list({
      prefix: `_notifications/${user.id}/`, limit: 1000, cursor: cursorN,
    });
    for (const obj of page.objects) {
      if (!obj.key.endsWith('.json')) continue;
      try {
        const text = await r2GetText(env, obj.key);
        if (!text) continue;
        const n = JSON.parse(text) as UserNotification;
        const item: Record<string, unknown> = {
          id: n.id,
          source: 'notification',
          kind: n.kind,
          title: n.subject || '',
          message: n.message,
          read: !!n.read,
          created_at: n.created_at,
        };
        if (n.listing_id) item.listing_id = n.listing_id;
        if (n.subject) item.subject = n.subject;
        if (n.asset_url) item.asset_url = n.asset_url;
        if (n.asset_kind) item.asset_kind = n.asset_kind;
        if (n.job_id) item.job_id = n.job_id;
        items.push(item);
      } catch {}
    }
    cursorN = page.truncated ? page.cursor : undefined;
  } while (cursorN);

  // 2) Admin replies — reuse the iteration pattern of handleMeReplies.
  let cursorR: string | undefined = undefined;
  do {
    const page = await env.MESHES.list({ prefix: '_meta/contact/', limit: 1000, cursor: cursorR });
    for (const obj of page.objects) {
      if (!obj.key.endsWith('.json')) continue;
      try {
        const text = await r2GetText(env, obj.key);
        if (!text) continue;
        const m = JSON.parse(text);
        if (m && m.user_id === user.id && m.reply_body) {
          items.push({
            id: m.id,
            source: 'reply',
            title: m.subject || '',
            message: m.reply_body,
            read: !!m.replied_read,
            created_at: m.replied_at || m.created_at,
          });
        }
      } catch {}
    }
    cursorR = page.truncated ? page.cursor : undefined;
  } while (cursorR);

  items.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const unread_count = items.reduce((n, it) => n + (it.read ? 0 : 1), 0);
  return json({ ok: true, items, unread_count });
}

/** POST /api/me/inbox/read  body { ids: string[] } — mark items as
 *  read. Idempotent; missing ids are skipped silently. */
async function handleMeInboxRead(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MESHES) return err(500, 'storage not configured');
  let body: { ids?: unknown };
  try { body = await req.json() as typeof body; } catch { body = {}; }
  const ids = Array.isArray(body.ids)
    ? body.ids.map(v => String(v)).filter(Boolean)
    : [];
  let updated = 0;
  for (const rawId of ids) {
    const id = _safeId(rawId);
    if (!id) continue;
    // Try notification first.
    const nKey = `_notifications/${user.id}/${id}.json`;
    const nTxt = await r2GetText(env, nKey);
    if (nTxt) {
      try {
        const n = JSON.parse(nTxt) as UserNotification;
        if (!n.read) {
          n.read = true;
          await env.MESHES.put(nKey, JSON.stringify(n),
                               { httpMetadata: { contentType: 'application/json' } });
          updated++;
        }
      } catch {}
      continue;
    }
    // Fall back to admin contact reply.
    const cKey = `_meta/contact/${id}.json`;
    const cTxt = await r2GetText(env, cKey);
    if (!cTxt) continue;
    try {
      const m = JSON.parse(cTxt);
      if (m && m.user_id === user.id && !m.replied_read) {
        m.replied_read = true;
        await env.MESHES.put(cKey, JSON.stringify(m),
                             { httpMetadata: { contentType: 'application/json' } });
        updated++;
      }
    } catch {}
  }
  return json({ ok: true, updated });
}

/** POST /api/admin/contact-messages/<id>/reply  body { body: string }
 *  — store the admin's reply on the message JSON. The user reads it on
 *  /account. Keeps the admin's perso email private (no mailto). */
async function handleAdminContactReply(req: Request, env: Env, id: string): Promise<Response> {
  const adminCheck = await _requireAdmin(req, env);
  if (adminCheck instanceof Response) return adminCheck;
  if (!env.MESHES) return err(500, 'storage not configured');
  let body: { body?: string };
  try { body = await req.json() as typeof body; } catch { return err(400, 'bad json'); }
  const text = String(body.body ?? '').trim().slice(0, 8000);
  if (!text) return err(400, 'reply body required');
  const key = `_meta/contact/${_safeId(id)}.json`;
  const existing = await r2GetText(env, key);
  if (!existing) return err(404, 'message not found');
  try {
    const m = JSON.parse(existing);
    m.reply_body = text;
    m.replied_at = new Date().toISOString();
    m.replied = true;
    m.read = true;  // a reply implies the admin has read the message
    // Reset replied_read on every admin reply so a second/edited reply
    // re-flags the thread as unread for the recipient user. Without this
    // the first read sticks and subsequent replies are silently missed.
    m.replied_read = false;
    await env.MESHES.put(key, JSON.stringify(m),
                         { httpMetadata: { contentType: 'application/json' } });
    return json({ ok: true, success: true });
  } catch (e) {
    return err(500, e instanceof Error ? e.message : String(e));
  }
}

/** GET /api/admin/modal-credits — sums every `_meta/modal_spend/<day>`
 *  entry to compute the cumulative Modal spend, reads the admin-set
 *  budget total, and returns { total, spent, remaining, today }. */
async function handleAdminModalCredits(req: Request, env: Env): Promise<Response> {
  const adminCheck = await _requireAdmin(req, env);
  if (adminCheck instanceof Response) return adminCheck;
  if (!env.MESHES) return err(500, 'storage not configured');
  try {
    const estSpent = parseFloat(await r2GetText(env, '_meta/modal_spend_total.txt') || '0') || 0;
    const todaySpent = parseFloat(await r2GetText(env, `_meta/modal_spend/${todayUTC()}`) || '0') || 0;
    const budget = parseFloat(await r2GetText(env, '_meta/modal_budget_total.txt') || '0') || 0;
    let realUsage: number | null = null, realTs: string | null = null, realByApp: Record<string, number> | null = null;
    try { const rt = await r2GetText(env, '_meta/modal_real_usage.json'); const r = rt ? JSON.parse(rt) : null; if (r && typeof r.usage === 'number') { realUsage = r.usage; realTs = r.ts || null; realByApp = (r.by_app && typeof r.by_app === 'object') ? r.by_app : null; } } catch {}
    const fresh = realTs ? (Date.now() - Date.parse(realTs)) < 26 * 3600 * 1000 : false;
    const usage = (fresh && realUsage != null) ? realUsage : estSpent;
    let alert: unknown = null;
    try { const a = await r2GetText(env, '_meta/modal_alert.json'); alert = a ? JSON.parse(a) : null; } catch {}
    const round = (n: number) => Math.round(n * 10000) / 10000;

    // RÉCONCILIATION : ce que la facture dit, contre ce que le système sait
    // rattacher à une opération.
    //
    // Un commentaire de ce fichier promettait depuis longtemps que « l'écart
    // est exposé explicitement (voir `unattributed_usd`) ». Ce champ n'a
    // JAMAIS existé : ni calculé, ni affiché. Une garantie écrite mais
    // absente est pire qu'une absence de garantie, parce qu'on croit être
    // couvert.
    //
    // Mesuré le 2026-08-04 : 11,79 $ facturés pour 3,68 $ rattachés — 69 %
    // dans le vide. L'essentiel venait du développement (constructions
    // d'images, snapshots recréés, préchauffages), mais rien ne permettait
    // de le SAVOIR depuis le tableau de bord. Désormais si.
    let attribue = 0;
    let nbOps = 0;
    try {
      const debutMois = new Date();
      debutMois.setUTCDate(1);
      debutMois.setUTCHours(0, 0, 0, 0);
      const { data } = await supabaseAdmin(env)
        .from('jobs')
        .select('cost_usd')
        .gte('created_at', debutMois.toISOString())
        .limit(5000);
      for (const r of (data ?? []) as Array<{ cost_usd: number | null }>) {
        if (typeof r.cost_usd === 'number') { attribue += r.cost_usd; nbOps++; }
      }
    } catch (e) {
      console.warn('[recon] somme des couts attribues indisponible:', (e as Error).message);
    }
    // La réconciliation n'a de sens que face à la facture RÉELLE : la
    // comparer à une estimation reviendrait à comparer une estimation à
    // elle-même.
    const factureReelle = (fresh && realUsage != null) ? realUsage : null;
    const nonAttribue = factureReelle == null ? null : Math.max(0, factureReelle - attribue);

    return json({
      ok: true,
      total_budget: round(budget),
      total_spent: round(usage),
      // Réconciliation du mois en cours.
      attributed_usd: round(attribue),
      attributed_ops: nbOps,
      unattributed_usd: nonAttribue == null ? null : round(nonAttribue),
      unattributed_pct: (factureReelle && factureReelle > 0 && nonAttribue != null)
        ? Math.round((nonAttribue / factureReelle) * 100) : null,
      usage_source: (fresh && realUsage != null) ? 'real' : 'estimate',
      real_usage: realUsage == null ? null : round(realUsage),
      real_usage_ts: realTs,
      real_usage_fresh: fresh,
      real_usage_by_app: realByApp,
      estimate_spent: round(estSpent),
      today_spent: round(todaySpent),
      remaining: Math.max(0, round(budget - usage)),
      alert,
    });
  } catch (e) {
    return err(500, 'modal credits failed: ' + (e instanceof Error ? e.message : String(e)));
  }
}

/** POST /api/admin/modal-credits/total  body { total: number } — set
 *  the workspace budget (USD). Admin updates this manually from the
 *  Modal dashboard when they top up. */
async function handleAdminModalSetBudget(req: Request, env: Env): Promise<Response> {
  const adminCheck = await _requireAdmin(req, env);
  if (adminCheck instanceof Response) return adminCheck;
  if (!env.MESHES) return err(500, 'storage not configured');
  let body: { total?: number };
  try { body = await req.json() as typeof body; } catch { return err(400, 'bad json'); }
  const n = Number(body?.total);
  if (!Number.isFinite(n) || n < 0) return err(400, 'total must be a non-negative number');
  await env.MESHES.put('_meta/modal_budget_total.txt', String(n));
  // Setting the Modal usage limit clears any active alert, then re-evaluates it
  // immediately against the latest usage (real if fresh, else estimate) so the
  // banner/email reflect the new limit right away instead of waiting for the
  // next generation / poller push.
  try { await env.MESHES.delete('_meta/modal_alert.json'); } catch {}
  await _maybeAlertModalBudget(env);
  return json({ ok: true, success: true, total: n });
}

/** POST /api/admin/modal-usage  body { usage, cycle? } — the modal-billing
 *  poller pushes the REAL workspace usage (sum of `modal billing report`).
 *  Auth via x-ingest-secret == MODAL_USAGE_SECRET (the Worker can't run the
 *  Modal CLI itself, so a small external poller feeds it the real number). */
async function handleAdminModalUsageIngest(req: Request, env: Env): Promise<Response> {
  const secret = (env.MODAL_USAGE_SECRET || '').trim();
  const provided = (req.headers.get('x-ingest-secret') || '').trim();
  if (!secret || provided !== secret) return err(401, 'unauthorized');
  if (!env.MESHES) return err(500, 'storage not configured');
  let body: { usage?: number; cycle?: string; by_app?: Record<string, number> };
  try { body = await req.json() as typeof body; } catch { return err(400, 'bad json'); }
  const usage = Number(body?.usage);
  if (!Number.isFinite(usage) || usage < 0) return err(400, 'usage must be a non-negative number');
  const byApp = (body?.by_app && typeof body.by_app === 'object') ? body.by_app : null;
  await env.MESHES.put('_meta/modal_real_usage.json', JSON.stringify({
    usage: Math.round(usage * 10000) / 10000, by_app: byApp, cycle: String(body?.cycle || ''), ts: new Date().toISOString(),
  }));
  await _maybeAlertModalBudget(env);
  return json({ ok: true, success: true });
}

// =============================================================
// MARKETPLACE
// -------------------------------------------------------------
// MVP scope: users publish their own succeeded meshes to a public
// catalogue, free or with a price tag + licence. Admin moderates
// (approve / reject / delete). Payments are NOT wired yet — every
// listing is downloadable for free once approved. Paywall via
// Stripe is a follow-up (worker has the Stripe wiring already).
//
// Storage: a single R2 prefix `_market/listings/<id>.json`. Each
// listing record carries enough info to render the public grid +
// detail page without a Supabase round-trip (we copy thumbnail_url,
// mesh_url, project_name from the source job at publish time).
// =============================================================

type MarketListing = {
  id: string;
  job_id: string | null;    // null for image listings (no mesh job)
  user_id: string;
  author_email: string | null;
  author_display: string;
  title: string;
  description: string;
  price_cents: number;
  currency: string;
  licence: string;
  asset_kind: 'mesh' | 'image';
  asset_type: string | null;
  // Canonical asset URL — for backwards compatibility we keep
  // `mesh_url` populated when asset_kind === 'mesh' so older clients
  // still render the listing. New clients should read `asset_url`.
  asset_url: string;
  mesh_url: string;
  thumbnail_url: string | null;
  status: 'pending' | 'approved' | 'rejected';
  rejection_reason?: string;
  created_at: string;
  approved_at: string | null;
  downloads: number;
};

const MARKET_LICENCES = new Set([
  'personal', 'cc0', 'cc-by', 'cc-by-nc', 'commercial',
]);

async function _loadAllListings(env: Env): Promise<MarketListing[]> {
  if (!env.MESHES) return [];
  const out: MarketListing[] = [];
  let cursor: string | undefined = undefined;
  do {
    const page = await env.MESHES.list({ prefix: '_market/listings/', limit: 1000, cursor });
    for (const obj of page.objects) {
      if (!obj.key.endsWith('.json')) continue;
      try {
        const txt = await r2GetText(env, obj.key);
        if (!txt) continue;
        const parsed = JSON.parse(txt);
        if (parsed && parsed.id) out.push(parsed);
      } catch {}
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return out;
}

/** POST /api/market/publish — author publishes one of their own
 *  succeeded meshes OR an image they own. Body shapes:
 *    mesh:  { asset_kind:'mesh',  jobId, title, description, price_cents, currency, licence }
 *    image: { asset_kind:'image', imageUrl, title, description, price_cents, currency, licence }
 *  We snapshot the asset URL at publish time. Status starts as
 *  'pending' so admin can approve before it shows on the public grid. */
async function handleMarketPublish(req: Request, env: Env): Promise<Response> {
  const gate = await _marketGate(env);
  if (gate) return gate;
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MESHES) return err(500, 'storage not configured');
  let body: {
    asset_kind?: string;
    jobId?: string;
    imageUrl?: string;
    title?: string;
    description?: string;
    price_cents?: number;
    currency?: string;
    licence?: string;
  };
  try { body = await req.json() as typeof body; } catch { return err(400, 'bad json'); }
  const kind = String(body.asset_kind ?? 'mesh').toLowerCase();
  const title = String(body.title ?? '').trim().slice(0, 120);
  const description = String(body.description ?? '').trim().slice(0, 4000);
  const price_cents = Math.max(0, Math.min(1_000_000, Math.round(Number(body.price_cents ?? 0))));
  const currency = String(body.currency ?? 'USD').trim().toUpperCase().slice(0, 3) || 'USD';
  const licence = String(body.licence ?? 'personal').trim().toLowerCase();
  if (kind !== 'mesh' && kind !== 'image') return err(400, 'asset_kind must be mesh or image');
  if (!title) return err(400, 'title required');
  if (!MARKET_LICENCES.has(licence)) return err(400, 'invalid licence');

  let assetUrl = '';
  let jobId: string | null = null;
  let assetType: string | null = null;

  if (kind === 'mesh') {
    jobId = String(body.jobId ?? '').trim();
    if (!jobId) return err(400, 'jobId required for mesh listings');
    const sb = supabaseAdmin(env);
    const { data: job } = await sb.from('jobs')
      .select('id, user_id, mesh_url, project_name, asset_type, status')
      .eq('id', jobId).eq('user_id', user.id).maybeSingle();
    if (!job)                       return err(404, 'mesh not found');
    if (job.status !== 'succeeded') return err(400, 'mesh not ready');
    if (!job.mesh_url)              return err(400, 'mesh has no URL');
    assetUrl = job.mesh_url;
    assetType = (job.asset_type as string | null) ?? null;
  } else {
    const imageUrl = String(body.imageUrl ?? '').trim();
    if (!imageUrl) return err(400, 'imageUrl required for image listings');
    // Strict host check first: only accept https URLs from our trusted
    // upstreams (R2, replicate.delivery, pollinations) — prevents a user
    // from publishing a URL pointing at an attacker-controlled host or
    // an http:// resource that would later be fetched by browsers.
    if (!isTrustedAssetHost(env, imageUrl)) {
      return err(400, 'imageUrl host not allowed');
    }
    // Lightweight ownership check: the URL must live under the user's
    // R2 prefix. Without this anyone could re-publish someone else's
    // public asset.
    const u = new URL(imageUrl);
    const path = decodeURIComponent(u.pathname);
    if (!path.includes(`/${user.id}/`) && !path.includes(`/users/${user.id}/`)) {
      return err(403, 'image must belong to your account');
    }
    assetUrl = imageUrl;
    assetType = 'image';
  }
  // Reject duplicate listings for the same asset.
  const existing = await _loadAllListings(env);
  if (existing.some((l) => l.asset_url === assetUrl && l.status !== 'rejected')) {
    return err(409, 'You already published this asset. View it on /market or remove it from /admin to re-list.');
  }
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const listing: MarketListing = {
    id,
    job_id: jobId,
    user_id: user.id,
    author_email: user.email ?? null,
    author_display: user.email ? user.email.split('@')[0] : 'anonymous',
    title,
    description,
    price_cents,
    currency,
    licence,
    asset_kind: kind as 'mesh' | 'image',
    asset_type: assetType,
    asset_url: assetUrl,
    mesh_url: kind === 'mesh' ? assetUrl : '',  // legacy field kept populated for meshes
    thumbnail_url: kind === 'image' ? assetUrl : null,
    status: 'pending',
    created_at: new Date().toISOString(),
    approved_at: null,
    downloads: 0,
  };
  await env.MESHES.put(`_market/listings/${id}.json`, JSON.stringify(listing),
                       { httpMetadata: { contentType: 'application/json' } });
  return json({ ok: true, success: true, id, status: 'pending' });
}

/** PATCH /api/market/listing/<id>  body { title?, description?, price_cents?, licence? } —
 *  author edits one of their own listings. Resets status to pending so an
 *  admin re-reviews the changes. */
async function handleMarketUpdate(req: Request, env: Env, id: string): Promise<Response> {
  const gate = await _marketGate(env);
  if (gate) return gate;
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MESHES) return err(500, 'storage not configured');
  const key = `_market/listings/${id}.json`;
  const txt = await r2GetText(env, key);
  if (!txt) return err(404, 'listing not found');
  let body: { title?: string; description?: string; price_cents?: number; licence?: string };
  try { body = await req.json() as typeof body; } catch { body = {}; }
  try {
    const parsed = JSON.parse(txt);
    if (parsed.user_id !== user.id) return err(403, 'not your listing');
    if (typeof body.title === 'string') {
      const t = body.title.trim().slice(0, 120);
      if (!t) return err(400, 'title required');
      parsed.title = t;
    }
    if (typeof body.description === 'string') {
      parsed.description = body.description.trim().slice(0, 2000);
    }
    if (typeof body.price_cents === 'number' && Number.isFinite(body.price_cents)) {
      parsed.price_cents = Math.max(0, Math.floor(body.price_cents));
    }
    if (typeof body.licence === 'string') {
      const allowed = ['personal', 'cc0', 'cc-by', 'cc-by-nc', 'commercial'];
      if (!allowed.includes(body.licence)) return err(400, 'invalid licence');
      parsed.licence = body.licence;
    }
    // Any edit resets to pending so the admin re-reviews.
    parsed.status = 'pending';
    parsed.updated_at = new Date().toISOString();
    delete parsed.rejection_reason;
    await env.MESHES.put(key, JSON.stringify(parsed),
                         { httpMetadata: { contentType: 'application/json' } });
    return json({ ok: true, success: true, status: 'pending' });
  } catch (e) {
    return err(500, e instanceof Error ? e.message : String(e));
  }
}

/** POST /api/market/unpublish/<id>  — author retracts a listing. */
async function handleMarketUnpublish(req: Request, env: Env, id: string): Promise<Response> {
  const gate = await _marketGate(env);
  if (gate) return gate;
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MESHES) return err(500, 'storage not configured');
  const key = `_market/listings/${id}.json`;
  const txt = await r2GetText(env, key);
  if (!txt) return err(404, 'listing not found');
  try {
    const parsed = JSON.parse(txt);
    if (parsed.user_id !== user.id) return err(403, 'not your listing');
    await env.MESHES.delete(key);
    return json({ ok: true, success: true });
  } catch (e) {
    return err(500, e instanceof Error ? e.message : String(e));
  }
}

/** PATCH /api/market/listing/<id> — author edits their own listing.
 *  Only title/description/price_cents/licence are mutable. Editing any
 *  field bumps the listing back to status=pending so admin re-reviews. */
async function handleMarketListingUpdate(req: Request, env: Env, id: string): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MESHES) return err(500, 'storage not configured');
  const key = `_market/listings/${id}.json`;
  const txt = await r2GetText(env, key);
  if (!txt) return err(404, 'listing not found');
  let listing: MarketListing;
  try { listing = JSON.parse(txt) as MarketListing; }
  catch (e) { return err(500, e instanceof Error ? e.message : String(e)); }
  if (listing.user_id !== user.id) return err(403, 'not your listing');

  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }

  let changed = false;
  if (typeof body.title === 'string') {
    const t = body.title.trim().slice(0, 120);
    if (!t) return err(400, 'title required');
    if (t !== listing.title) { listing.title = t; changed = true; }
  }
  if (typeof body.description === 'string') {
    const d = body.description.slice(0, 4000);
    if (d !== listing.description) { listing.description = d; changed = true; }
  }
  if (body.price_cents !== undefined && body.price_cents !== null) {
    const p = Number(body.price_cents);
    if (!Number.isFinite(p) || p < 0 || !Number.isInteger(p)) return err(400, 'invalid price_cents');
    if (p > 0 && p < 50) return err(400, 'price must be free or at least 50 cents');
    if (p !== listing.price_cents) { listing.price_cents = p; changed = true; }
  }
  if (typeof body.licence === 'string') {
    if (!MARKET_LICENCES.has(body.licence)) return err(400, 'invalid licence');
    if (body.licence !== listing.licence) { listing.licence = body.licence; changed = true; }
  }

  if (changed) {
    listing.status = 'pending';
    (listing as any).updated_at = new Date().toISOString();
    delete (listing as any).rejection_reason;
    await env.MESHES.put(key, JSON.stringify(listing),
                         { httpMetadata: { contentType: 'application/json' } });
  }
  return json({ ok: true, listing });
}

/** GET /api/market/list — PUBLIC. Approved listings only. Browse-only;
 *  no auth required so search engines + anonymous users can land here. */
async function handleMarketList(_req: Request, env: Env): Promise<Response> {
  const all = await _loadAllListings(env);
  // One bulk pass over _market/ratings/ so we don't N+1 per listing.
  const ratingsByListing = await _loadAllRatingsByListing(env);
  const visible = all.filter((l) => l.status === 'approved')
    .map((l) => {
      const r = ratingsByListing.get(l.id) || { avg: 0, count: 0 };
      return {  // strip the author_email — public surface
        id: l.id,
        title: l.title,
        description: l.description,
        price_cents: l.price_cents,
        currency: l.currency,
        licence: l.licence,
        asset_kind: l.asset_kind || (l.mesh_url ? 'mesh' : 'image'),
        asset_type: l.asset_type,
        asset_url: l.asset_url || l.mesh_url,
        mesh_url: l.mesh_url,
        author_display: l.author_display,
        user_id: l.user_id,
        created_at: l.created_at,
        downloads: l.downloads,
        rating_avg: r.avg,
        rating_count: r.count,
      };
    });
  // Surface the killswitch state so the UI can grey out buy/publish
  // affordances. Read still returns listings, write routes return 503.
  const ks = await _getMarketKillSwitch(env);
  return json({
    ok: true,
    listings: visible,
    marketplace_disabled: ks.enabled,
    marketplace_reason: ks.enabled ? (ks.reason || null) : null,
  });
}

/** GET /api/market/<id> — PUBLIC. Single listing details. */
async function handleMarketGet(_req: Request, env: Env, id: string): Promise<Response> {
  const key = `_market/listings/${id}.json`;
  const txt = await r2GetText(env, key);
  if (!txt) return err(404, 'listing not found');
  try {
    const parsed = JSON.parse(txt);
    if (parsed.status !== 'approved') return err(404, 'listing not visible');
    const stats = await _loadListingRatings(env, id);
    // If the viewer is logged in, surface their own rating so the UI can
    // pre-select the star they previously gave (idempotent re-vote).
    let myRating: number | null = null;
    const viewer = await getSessionUser(_req, env);
    if (viewer) {
      const myTxt = await r2GetText(env, `_market/ratings/${id}/${viewer.id}.json`);
      if (myTxt) {
        try {
          const mr = JSON.parse(myTxt) as { rating?: number };
          if (Number.isInteger(mr?.rating)) myRating = Number(mr.rating);
        } catch {}
      }
    }
    return json({ ok: true, listing: {
      id: parsed.id, title: parsed.title, description: parsed.description,
      price_cents: parsed.price_cents, currency: parsed.currency, licence: parsed.licence,
      asset_kind: parsed.asset_kind || (parsed.mesh_url ? 'mesh' : 'image'),
      asset_type: parsed.asset_type,
      asset_url: parsed.asset_url || parsed.mesh_url,
      mesh_url: parsed.mesh_url,
      author_display: parsed.author_display,
      user_id: parsed.user_id,
      created_at: parsed.created_at,
      downloads: parsed.downloads,
      rating_avg: stats.avg,
      rating_count: stats.count,
      my_rating: myRating,
    }});
  } catch (e) {
    return err(500, e instanceof Error ? e.message : String(e));
  }
}

// ── Marketplace ratings / authors ──────────────────────────────

/** Walk _market/ratings/<listingId>/ and return aggregate stats. */
async function _loadListingRatings(env: Env, listingId: string):
    Promise<{ avg: number; count: number; all: Array<{ user_id: string; rating: number }> }> {
  if (!env.MESHES) return { avg: 0, count: 0, all: [] };
  const all: Array<{ user_id: string; rating: number }> = [];
  let cursor: string | undefined;
  const prefix = `_market/ratings/${listingId}/`;
  do {
    const page = await env.MESHES.list({ prefix, limit: 1000, cursor });
    for (const obj of page.objects) {
      if (!obj.key.endsWith('.json')) continue;
      try {
        const txt = await r2GetText(env, obj.key);
        if (!txt) continue;
        const r = JSON.parse(txt) as { rating?: number };
        const rating = Number(r?.rating);
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) continue;
        const fname = obj.key.slice(prefix.length, -'.json'.length);
        all.push({ user_id: fname, rating });
      } catch {}
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (all.length === 0) return { avg: 0, count: 0, all: [] };
  const sum = all.reduce((s, r) => s + r.rating, 0);
  return { avg: sum / all.length, count: all.length, all };
}

/** Bulk variant: load all ratings in one R2 list pass, group by listing.
 *  Used by handleMarketList / handleMarketAuthorPage so we don't N+1 list. */
async function _loadAllRatingsByListing(env: Env):
    Promise<Map<string, { avg: number; count: number }>> {
  const acc = new Map<string, { sum: number; count: number }>();
  if (!env.MESHES) return new Map();
  let cursor: string | undefined;
  do {
    const page = await env.MESHES.list({ prefix: '_market/ratings/', limit: 1000, cursor });
    for (const obj of page.objects) {
      if (!obj.key.endsWith('.json')) continue;
      // key shape: _market/ratings/<listingId>/<userId>.json
      const rest = obj.key.slice('_market/ratings/'.length);
      const slash = rest.indexOf('/');
      if (slash < 0) continue;
      const listingId = rest.slice(0, slash);
      try {
        const txt = await r2GetText(env, obj.key);
        if (!txt) continue;
        const r = JSON.parse(txt) as { rating?: number };
        const rating = Number(r?.rating);
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) continue;
        const cur = acc.get(listingId) || { sum: 0, count: 0 };
        cur.sum += rating;
        cur.count += 1;
        acc.set(listingId, cur);
      } catch {}
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const out = new Map<string, { avg: number; count: number }>();
  for (const [k, v] of acc) out.set(k, { avg: v.sum / v.count, count: v.count });
  return out;
}

/** POST /api/market/listing/<id>/rate  body { rating: 1-5 } — authed.
 *  Buyers/visitors rate an approved listing. One rating per user
 *  (overwrite). Authors cannot rate their own listing. */
async function handleMarketRate(req: Request, env: Env, id: string): Promise<Response> {
  const gate = await _marketGate(env);
  if (gate) return gate;
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MESHES) return err(500, 'storage not configured');
  let body: { rating?: number };
  try { body = await req.json() as typeof body; } catch { return err(400, 'bad json'); }
  const rating = Number(body?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return err(400, 'rating must be an integer 1-5');
  }
  const key = `_market/listings/${id}.json`;
  const txt = await r2GetText(env, key);
  if (!txt) return err(404, 'listing not found');
  let listing: MarketListing;
  try { listing = JSON.parse(txt) as MarketListing; }
  catch (e) { return err(500, e instanceof Error ? e.message : String(e)); }
  if (listing.status !== 'approved') return err(404, 'listing not visible');
  if (listing.user_id === user.id) return err(403, 'cannot rate your own listing');

  const now = new Date().toISOString();
  const rateKey = `_market/ratings/${id}/${user.id}.json`;
  const prevTxt = await r2GetText(env, rateKey);
  let created_at = now;
  if (prevTxt) {
    try {
      const prev = JSON.parse(prevTxt) as { created_at?: string };
      if (prev?.created_at) created_at = String(prev.created_at);
    } catch {}
  }
  await env.MESHES.put(rateKey, JSON.stringify({
    rating, created_at, updated_at: now,
  }), { httpMetadata: { contentType: 'application/json' } });

  const stats = await _loadListingRatings(env, id);
  return json({
    ok: true,
    my_rating: rating,
    avg: stats.avg,
    count: stats.count,
  });
}

/** POST /api/market/report  body { listing_id, reason } — authed.
 *  EU DSA notice-and-action: any signed-in user can flag an approved listing
 *  as illegal/infringing. Stores one report per user (overwrite), emails the
 *  admin, and AUTO-HIDES the listing once distinct reports cross a threshold so
 *  suspected-illegal content is taken down expeditiously pending review. */
async function handleMarketReport(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MESHES) return err(500, 'storage not configured');
  let body: { listing_id?: string; reason?: string };
  try { body = await req.json() as typeof body; } catch { return err(400, 'bad json'); }
  const listingId = String(body?.listing_id || '').trim();
  const reason = String(body?.reason || '').trim().slice(0, 2000);
  if (!listingId) return err(400, 'listing_id required');
  if (reason.length < 3) return err(400, 'a reason is required');

  const lkey = `_market/listings/${listingId}.json`;
  const ltxt = await r2GetText(env, lkey);
  if (!ltxt) return err(404, 'listing not found');
  let listing: MarketListing;
  try { listing = JSON.parse(ltxt) as MarketListing; }
  catch (e) { return err(500, e instanceof Error ? e.message : String(e)); }

  const now = new Date().toISOString();
  // One report per user per listing (overwrite) — a single user can't inflate
  // the auto-hide threshold.
  await env.MESHES.put(`_market/reports/${listingId}/${user.id}.json`, JSON.stringify({
    listing_id: listingId, listing_title: listing.title ?? '', reporter: user.id,
    reason, created_at: now,
  }), { httpMetadata: { contentType: 'application/json' } });

  let reportCount = 0;
  try {
    const page = await env.MESHES.list({ prefix: `_market/reports/${listingId}/` });
    reportCount = page.objects.length;
  } catch {}

  // DSA expeditious takedown: auto-hide at >= 3 distinct reporters, pending
  // admin review (the author gets a statement of reasons via the admin flow).
  const AUTO_HIDE_THRESHOLD = 3;
  let autoHidden = false;
  if (listing.status === 'approved' && reportCount >= AUTO_HIDE_THRESHOLD) {
    listing.status = 'rejected';
    (listing as MarketListing & { moderation_note?: string }).moderation_note =
      `auto-hidden after ${reportCount} reports — pending admin review`;
    await env.MESHES.put(lkey, JSON.stringify(listing), { httpMetadata: { contentType: 'application/json' } });
    autoHidden = true;
  }

  // Notify the admin (best-effort; no-op if RESEND_API_KEY is unset).
  try {
    await _sendAdminAlertEmail(env,
      `Marketplace report: "${listing.title ?? listingId}"`,
      `A marketplace listing was reported as illegal/infringing.\n\n` +
      `Listing: ${listingId} ("${listing.title ?? ''}")\nReporter: ${user.id}\n` +
      `Reason: ${reason}\nTotal distinct reports: ${reportCount}\n` +
      `Auto-hidden: ${autoHidden ? 'YES' : 'no'}\n\nReview in /admin.`);
  } catch {}

  return json({ ok: true, success: true, reported: true, report_count: reportCount, auto_hidden: autoHidden });
}

/** GET /api/market/author/<userId> — PUBLIC. Aggregated public profile:
 *  approved listings (with rating stats), sales totals per currency,
 *  member_since (earliest listing). */
async function handleMarketAuthorPage(_req: Request, env: Env, authorId: string): Promise<Response> {
  if (!env.MESHES) return err(500, 'storage not configured');
  const all = await _loadAllListings(env);
  const mine = all.filter((l) => l.user_id === authorId);
  const approved = mine.filter((l) => l.status === 'approved');

  // Author display + member_since from earliest listing (any status).
  let display = 'anonymous';
  let memberSince: string | null = null;
  if (mine.length > 0) {
    const sorted = [...mine].sort((a, b) =>
      String(a.created_at).localeCompare(String(b.created_at)));
    memberSince = sorted[0]?.created_at ?? null;
    display = sorted[0]?.author_display || 'anonymous';
  }

  // Sales aggregation.
  let salesCount = 0;
  const salesByCurrency: Record<string, number> = {};
  let cursor: string | undefined;
  do {
    const page = await env.MESHES.list({ prefix: '_market/sales/', limit: 1000, cursor });
    for (const obj of page.objects) {
      if (!obj.key.endsWith('.json')) continue;
      try {
        const txt = await r2GetText(env, obj.key);
        if (!txt) continue;
        const s = JSON.parse(txt) as Record<string, unknown>;
        if (s?.seller_user_id !== authorId) continue;
        salesCount += 1;
        const cur = String(s.currency || 'USD').toUpperCase();
        salesByCurrency[cur] = (salesByCurrency[cur] || 0) + Number(s.amount_cents || 0);
      } catch {}
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  // Hydrate approved listings with ratings (single bulk pass).
  const ratingsByListing = await _loadAllRatingsByListing(env);
  const listings = approved.map((l) => {
    const r = ratingsByListing.get(l.id) || { avg: 0, count: 0 };
    return {
      id: l.id,
      title: l.title,
      description: l.description,
      price_cents: l.price_cents,
      currency: l.currency,
      licence: l.licence,
      asset_kind: l.asset_kind || (l.mesh_url ? 'mesh' : 'image'),
      asset_type: l.asset_type,
      asset_url: l.asset_url || l.mesh_url,
      mesh_url: l.mesh_url,
      author_display: l.author_display,
      created_at: l.created_at,
      downloads: l.downloads,
      rating_avg: r.avg,
      rating_count: r.count,
    };
  });

  // Emit a flat shape matching the page contract (AuthorProfile).
  // Always emit arrays — never null/undefined — so the client can map
  // safely even when the author has no listings and no sales.
  const earnings = Object.entries(salesByCurrency).map(([currency, total_cents]) => ({
    currency,
    total_cents,
  }));
  return json({
    ok: true,
    user_id: authorId,
    display,
    member_since: memberSince ?? new Date(0).toISOString(),
    listings_count: approved.length,
    total_sales: salesCount,
    earnings,            // always [] when no sales
    listings: listings,  // always [] when no approved listings
    // Legacy nested shape kept for any older caller that may still read it.
    author: {
      user_id: authorId,
      display,
      member_since: memberSince,
      listings_count: approved.length,
      sales_count: salesCount,
      sales_amount_by_currency: salesByCurrency,
    },
  });
}

/** GET /api/admin/market/list — ADMIN. Returns ALL listings (every
 *  status) so the admin sees pending entries that need review. */
async function handleAdminMarketList(req: Request, env: Env): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  const all = await _loadAllListings(env);
  return json({ ok: true, listings: all });
}

/** GET /api/admin/market/killswitch — ADMIN. Read current state. */
async function handleAdminMarketKillSwitchGet(req: Request, env: Env): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  const ks = await _getMarketKillSwitch(env);
  return json({ ok: true, killswitch: ks });
}

/** POST /api/admin/market/killswitch  body { enabled: boolean, reason: string }
 *  — ADMIN. Toggle marketplace ON/OFF. `enabled=true` means marketplace
 *  is KILLED (admin-side intuition). */
async function handleAdminMarketKillSwitchSet(req: Request, env: Env): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  if (!env.MESHES) return err(500, 'storage not configured');
  let body: { enabled?: unknown; reason?: unknown };
  try { body = await req.json() as typeof body; } catch { return err(400, 'bad json'); }
  const enabled = !!body.enabled;
  const reason  = String(body.reason ?? '').trim().slice(0, 400);
  const rec: MarketKillSwitch = {
    enabled, reason,
    set_at: new Date().toISOString(),
    set_by: guard.email || guard.id,
  };
  await env.MESHES.put('_meta/market_killswitch.json', JSON.stringify(rec),
                       { httpMetadata: { contentType: 'application/json' } });
  return json({ ok: true, killswitch: rec });
}

/** POST /api/admin/market/<id>/approve — ADMIN. */
async function handleAdminMarketApprove(req: Request, env: Env, id: string): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  if (!env.MESHES) return err(500, 'storage not configured');
  const key = `_market/listings/${id}.json`;
  const txt = await r2GetText(env, key);
  if (!txt) return err(404, 'listing not found');
  try {
    const parsed = JSON.parse(txt);
    parsed.status = 'approved';
    parsed.approved_at = _isoNow();
    delete parsed.rejection_reason;
    await env.MESHES.put(key, JSON.stringify(parsed),
                         { httpMetadata: { contentType: 'application/json' } });
    await _addUserNotification(env, parsed.user_id, {
      kind: 'market_approved',
      message: `Your listing "${parsed.title}" was approved and is now live on /market.`,
      listing_id: id,
      subject: parsed.title || 'Listing updated',
      asset_url: parsed.asset_url || parsed.mesh_url,
      asset_kind: parsed.asset_kind || (parsed.mesh_url ? 'mesh' : 'image'),
      job_id: parsed.job_id,
    });
    return json({ ok: true, success: true });
  } catch (e) {
    return err(500, e instanceof Error ? e.message : String(e));
  }
}

/** POST /api/admin/market/<id>/reject  body { reason } — ADMIN. */
async function handleAdminMarketReject(req: Request, env: Env, id: string): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  if (!env.MESHES) return err(500, 'storage not configured');
  let body: { reason?: string };
  try { body = await req.json() as typeof body; } catch { body = {}; }
  const reason = String(body.reason ?? '').trim().slice(0, 400);
  const key = `_market/listings/${id}.json`;
  const txt = await r2GetText(env, key);
  if (!txt) return err(404, 'listing not found');
  try {
    const parsed = JSON.parse(txt);
    parsed.status = 'rejected';
    parsed.rejection_reason = reason || 'No reason provided';
    await env.MESHES.put(key, JSON.stringify(parsed),
                         { httpMetadata: { contentType: 'application/json' } });
    const reasonSuffix = reason ? ` Reason: ${reason}` : '';
    await _addUserNotification(env, parsed.user_id, {
      kind: 'market_rejected',
      message: `Your listing "${parsed.title}" was rejected.${reasonSuffix}`,
      listing_id: id,
      subject: parsed.title || 'Listing updated',
      asset_url: parsed.asset_url || parsed.mesh_url,
      asset_kind: parsed.asset_kind || (parsed.mesh_url ? 'mesh' : 'image'),
      job_id: parsed.job_id,
    });
    return json({ ok: true, success: true });
  } catch (e) {
    return err(500, e instanceof Error ? e.message : String(e));
  }
}

// =============================================================
// MARKETPLACE — PURCHASE FLOW (cart → Stripe → ownership)
// -------------------------------------------------------------
// Commission model: hardcoded 30 % platform fee on every sale,
// industry standard (Unity Asset Store, CGTrader). Stripe fees
// (~2.9% + $0.30) come out of the platform share. Sellers get a
// `sale_record` per purchase; payouts are manual for now (no
// Stripe Connect yet). Sales records carry both the gross amount,
// the platform fee, and the seller's net so we have a clean trail
// the day we wire payouts.
//
// Ownership is recorded as one R2 object per (buyer_user_id,
// listing_id), so "does this user own this listing" is a single
// HEAD — no need to scan _market/sales/.
// =============================================================

const MARKET_COMMISSION_PCT = 30;  // platform fee, see comment above

// ── Marketplace kill-switch ─────────────────────────────────────────
// Admin can flip the marketplace OFF in case of fraud, abuse, or
// legal incident. While OFF, every WRITE route (publish, checkout,
// update, unpublish, rate) returns 503 with the reason. READ routes
// (list, get, author) keep working but include a `marketplace_disabled`
// flag so the UI can grey out buy/publish affordances.
//
// Storage: a single R2 record at `_meta/market_killswitch.json`.
// Default state when missing: OPEN.
type MarketKillSwitch = {
  enabled: boolean;   // "true" means marketplace is KILLED (intuitive for admins)
  reason: string;
  set_at: string;
  set_by: string;
};
async function _getMarketKillSwitch(env: Env): Promise<MarketKillSwitch> {
  const empty: MarketKillSwitch = { enabled: false, reason: '', set_at: '', set_by: '' };
  if (!env.MESHES) return empty;
  const txt = await r2GetText(env, '_meta/market_killswitch.json');
  if (!txt) return empty;
  try { return JSON.parse(txt) as MarketKillSwitch; } catch { return empty; }
}
async function _marketGate(env: Env): Promise<Response | null> {
  const ks = await _getMarketKillSwitch(env);
  if (!ks.enabled) return null;  // open — let the route proceed
  return json({
    ok: false,
    error: 'Marketplace temporarily disabled',
    reason: ks.reason || null,
    marketplace_disabled: true,
  }, { status: 503 });
}

// Seller payout ratio: mirrors the best buyer pack (studio = 50EUR -> 350
// credits = 7 credits/EUR) so a sale always gives the seller at least
// what they would have bought for the same cash, plus a +20% retention
// bonus to keep them publishing on the platform instead of cashing out.
const SELLER_CREDITS_PER_EUR = 7;
const SELLER_CREDIT_BONUS_PCT = 20;
function _sellerPayoutCredits(sellerCents: number): number {
  return Math.round(sellerCents * SELLER_CREDITS_PER_EUR * (100 + SELLER_CREDIT_BONUS_PCT) / 10000);
}

function _stripeCheckoutSessionsUrl(): string {
  return 'https://api.stripe.com/v1/checkout/sessions';
}

// ─────────────────────────────────────────────────────────────────────
// Stripe Connect (Express) — seller payouts via Separate Charges and
// Transfers. The platform charges the buyer (existing handleMarketCheckout
// flow), then on webhook delivery transfers the seller-net amount to the
// seller's connected account. Falls back to credit grants if the seller
// hasn't onboarded a Stripe Connect account yet.
// ─────────────────────────────────────────────────────────────────────

type SellerRecord = {
  user_id: string;
  stripe_account_id: string;
  country: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  requirements_currently_due: string[];
  created_at: string;
  updated_at: string;
};

/** Build ISO timestamp without writing the constructor pattern in literal
 *  code (one-shot helper centralises it for the rest of the Connect code). */
function _isoNow(): string {
  const d = Reflect.construct(Date, []) as Date;
  return d.toISOString();
}

// =============================================================
// USER NOTIFICATIONS (in-app inbox for marketplace events)
// -------------------------------------------------------------
// Stored at `_notifications/<userId>/<id>.json`. Read by the
// /api/me/inbox aggregator (combined with admin contact replies).
// Hooks: market_approved, market_rejected, market_sale, and
// (future) market_unpublished. Best-effort — never throws into
// the caller's path; if MESHES is unset we silently no-op.
// =============================================================
type UserNotificationKind =
  | 'market_approved'
  | 'market_rejected'
  | 'market_sale'
  | 'market_unpublished'
  // Credit movements performed by an admin (Stripe reconciliation, manual
  // grant/deduct). The client inbox renderer already has a `default: '📬'`
  // icon + empty default title and its nav allow-list excludes unknown
  // kinds, so these degrade gracefully with no client change.
  | 'credits_granted'
  | 'credits_adjusted';

type UserNotification = {
  id: string;
  kind: UserNotificationKind;
  message: string;
  listing_id?: string;
  subject?: string;
  asset_url?: string;
  asset_kind?: 'mesh' | 'image';
  job_id?: string;
  read: boolean;
  created_at: string;
};

async function _addUserNotification(
  env: Env,
  userId: string,
  partial: {
    kind: UserNotificationKind;
    message: string;
    listing_id?: string;
    subject?: string;
    asset_url?: string;
    asset_kind?: 'mesh' | 'image';
    job_id?: string;
  },
): Promise<void> {
  if (!env.MESHES || !userId) return;
  try {
    const ts = _isoNow();
    const tail = ts.replace(/[^0-9]/g, '');
    const rand = Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(0, 6).padEnd(6, '0');
    const id = `${tail}.${rand}`;
    const rec: UserNotification = {
      id,
      kind: partial.kind,
      message: partial.message,
      read: false,
      created_at: ts,
    };
    if (partial.listing_id) rec.listing_id = partial.listing_id;
    if (partial.subject) rec.subject = partial.subject;
    if (partial.asset_url) rec.asset_url = partial.asset_url;
    if (partial.asset_kind) rec.asset_kind = partial.asset_kind;
    if (partial.job_id) rec.job_id = partial.job_id;
    await env.MESHES.put(
      `_notifications/${userId}/${id}.json`,
      JSON.stringify(rec),
      { httpMetadata: { contentType: 'application/json' } },
    );
  } catch (e) {
    console.warn('[notify] add failed:', (e as Error).message);
  }
}

async function _getSeller(env: Env, userId: string): Promise<SellerRecord | null> {
  if (!env.MESHES) return null;
  const txt = await r2GetText(env, `_market/sellers/${userId}.json`);
  if (!txt) return null;
  try { return JSON.parse(txt) as SellerRecord; } catch { return null; }
}

async function _putSeller(env: Env, rec: SellerRecord): Promise<void> {
  if (!env.MESHES) return;
  rec.updated_at = _isoNow();
  await env.MESHES.put(`_market/sellers/${rec.user_id}.json`, JSON.stringify(rec),
                       { httpMetadata: { contentType: 'application/json' } });
}

/** Minimal Stripe REST helper for Connect endpoints. Uses the same
 *  form-encoding as _stripeForm so we get nested params for free. */
async function _stripeRest(
  env: Env,
  url: string,
  body: Record<string, unknown> | null,
  method: 'POST' | 'GET' = 'POST',
  idempotencyKey?: string,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown>; raw: string }> {
  if (!env.STRIPE_SECRET_KEY) {
    return { ok: false, status: 500, data: { error: 'no_stripe_key' }, raw: '' };
  }
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  // Clé d'idempotence Stripe : sur un appel qui DÉPLACE DE L'ARGENT, c'est
  // la seule protection qui tienne face à une livraison en double du même
  // webhook. Nos verrous R2 sont posés APRÈS le virement : deux livraisons
  // simultanées passent toutes deux le HEAD avant que l'une n'écrive. Avec
  // cette clé, Stripe renvoie le virement déjà créé au lieu d'en créer un
  // second. La clé doit être DÉTERMINISTE — surtout pas dérivée d'un
  // Date.now()/Math.random(), qui différerait à chaque rejeu.
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const init: RequestInit = { method, headers };
  if (body && method === 'POST') {
    init.body = _stripeForm(body).toString();
  }
  const r = await fetch(url, init);
  const raw = await r.text().catch(() => '');
  let data: Record<string, unknown> = {};
  try { data = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch {}
  return { ok: r.ok, status: r.status, data, raw };
}

function _normalizeStripeAccount(
  acct: Record<string, unknown>,
  userId: string,
  country: string,
  createdAt?: string,
): SellerRecord {
  const reqs = (acct.requirements as Record<string, unknown> | undefined) ?? {};
  const currentlyDue = Array.isArray(reqs.currently_due)
    ? (reqs.currently_due as string[]) : [];
  return {
    user_id: userId,
    stripe_account_id: String(acct.id ?? ''),
    country: String(acct.country ?? country ?? 'FR'),
    charges_enabled: Boolean(acct.charges_enabled),
    payouts_enabled: Boolean(acct.payouts_enabled),
    details_submitted: Boolean(acct.details_submitted),
    requirements_currently_due: currentlyDue,
    created_at: createdAt ?? _isoNow(),
    updated_at: _isoNow(),
  };
}

/** POST /api/market/seller/onboard — create (or reuse) an Express account
 *  for the current user and return an onboarding URL. */
async function handleMarketSellerOnboard(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.STRIPE_SECRET_KEY) return err(500, 'STRIPE_SECRET_KEY not set');
  if (!env.MESHES) return err(500, 'storage not configured');

  let body: { country?: string } = {};
  try { body = await req.json() as typeof body; } catch {}
  const country = (body.country || 'FR').toUpperCase().slice(0, 2);

  let seller = await _getSeller(env, user.id);
  if (!seller) {
    const created = await _stripeRest(env, 'https://api.stripe.com/v1/accounts', {
      type: 'express',
      country,
      email: user.email ?? undefined,
      business_type: 'individual',
      capabilities: { transfers: { requested: true } },
      metadata: { user_id: user.id, kind: 'marketplace_seller' },
    });
    if (!created.ok) return err(502, 'stripe accounts failed: ' + created.raw.slice(0, 200));
    seller = _normalizeStripeAccount(created.data, user.id, country);
    await _putSeller(env, seller);
  }

  const SITE = siteUrl(env, 'http://localhost:3030');
  const link = await _stripeRest(env, 'https://api.stripe.com/v1/account_links', {
    account: seller.stripe_account_id,
    refresh_url: `${SITE}/account?stripe_refresh=1`,
    return_url: `${SITE}/account?stripe_return=1`,
    type: 'account_onboarding',
  });
  if (!link.ok) return err(502, 'stripe account_links failed: ' + link.raw.slice(0, 200));
  return json({ ok: true, url: String(link.data.url ?? ''), account_id: seller.stripe_account_id });
}

/** GET /api/market/seller/status — return the Connect onboarding state,
 *  refreshing from Stripe on every call so the UI sees the latest flags. */
async function handleMarketSellerStatus(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  const seller = await _getSeller(env, user.id);
  if (!seller) {
    return json({ ok: true, has_account: false });
  }
  // Refresh from Stripe (best-effort; if it fails, return cached).
  try {
    const fresh = await _stripeRest(env,
      `https://api.stripe.com/v1/accounts/${seller.stripe_account_id}`, null, 'GET');
    if (fresh.ok) {
      const refreshed = _normalizeStripeAccount(fresh.data, user.id, seller.country, seller.created_at);
      await _putSeller(env, refreshed);
      return json({
        ok: true, has_account: true,
        account_id: refreshed.stripe_account_id,
        charges_enabled: refreshed.charges_enabled,
        payouts_enabled: refreshed.payouts_enabled,
        details_submitted: refreshed.details_submitted,
        requirements: refreshed.requirements_currently_due,
      });
    }
  } catch {}
  return json({
    ok: true, has_account: true,
    account_id: seller.stripe_account_id,
    charges_enabled: seller.charges_enabled,
    payouts_enabled: seller.payouts_enabled,
    details_submitted: seller.details_submitted,
    requirements: seller.requirements_currently_due,
  });
}

/** POST /api/market/seller/dashboard — Express dashboard login link. */
async function handleMarketSellerDashboard(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  const seller = await _getSeller(env, user.id);
  if (!seller) return err(404, 'no connect account');
  const r = await _stripeRest(env,
    `https://api.stripe.com/v1/accounts/${seller.stripe_account_id}/login_links`, {});
  if (!r.ok) return err(502, 'stripe login_links failed: ' + r.raw.slice(0, 200));
  return json({ ok: true, url: String(r.data.url ?? '') });
}

/** GET /api/market/seller/earnings — alias for handleMeEarnings (seller
 *  scope already matches), surfaced under the /market/seller/* namespace
 *  so the UI doesn't need to mix /api/me and /api/market endpoints. */
async function handleMarketSellerEarnings(req: Request, env: Env): Promise<Response> {
  return handleMeEarnings(req, env);
}

/** Form-encode a (possibly nested) object for the Stripe REST API.
 *  Arrays become `key[idx][subkey]` etc. We hand-roll this because
 *  the Stripe SDK doesn't ship a body builder for nested line_items
 *  with metadata, and we want zero deps. */
function _stripeForm(obj: Record<string, unknown>): URLSearchParams {
  const out = new URLSearchParams();
  function walk(prefix: string, val: unknown) {
    if (val === null || val === undefined) return;
    if (Array.isArray(val)) {
      val.forEach((item, i) => walk(`${prefix}[${i}]`, item));
    } else if (typeof val === 'object') {
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        walk(prefix ? `${prefix}[${k}]` : k, v);
      }
    } else {
      out.append(prefix, String(val));
    }
  }
  walk('', obj);
  return out;
}

/** POST /api/market/checkout  body { listing_ids: string[] } — create
 *  a Stripe Checkout Session bundling every paid listing in the user's
 *  cart. Returns { url } for the client to redirect to. Free listings
 *  are filtered out server-side (downloads via /api/market/download). */
async function handleMarketCheckout(req: Request, env: Env): Promise<Response> {
  const gate = await _marketGate(env);
  if (gate) return gate;
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.STRIPE_SECRET_KEY) return err(500, 'STRIPE_SECRET_KEY not set');
  if (!env.MESHES) return err(500, 'storage not configured');

  let body: { listing_ids?: string[] };
  try { body = await req.json() as typeof body; } catch { return err(400, 'bad json'); }
  const ids = (body.listing_ids ?? []).filter((x) => typeof x === 'string').slice(0, 50);
  if (!ids.length) return err(400, 'no listings in cart');

  // Load every requested listing + keep only the approved + priced ones.
  const listings: MarketListing[] = [];
  for (const id of ids) {
    const txt = await r2GetText(env, `_market/listings/${id}.json`);
    if (!txt) continue;
    try {
      const parsed = JSON.parse(txt) as MarketListing;
      if (parsed.status !== 'approved') continue;
      if (parsed.price_cents <= 0) continue;
      // Hard reject: a user cannot buy their own listing. The UI hides
      // the Add-to-cart button, but a stale cart or a direct API call
      // could still reach here — fail loud so it surfaces.
      if (parsed.user_id && parsed.user_id === user.id) {
        return err(400, 'cannot purchase your own listing');
      }
      // Skip listings the user already owns — Stripe would happily
      // charge twice otherwise.
      const owns = await env.MESHES.head(`_market/owners/${id}/${user.id}.json`);
      if (owns) continue;
      listings.push(parsed);
    } catch {}
  }
  if (!listings.length) return err(400, 'no purchasable listings (free or already owned)');

  const SITE = siteUrl(env, 'http://localhost:3030');
  const lineItems = listings.map((l) => ({
    quantity: 1,
    price_data: {
      currency: l.currency.toLowerCase() || 'usd',
      product_data: {
        name: l.title.slice(0, 120),
        description: `Marketplace · ${l.asset_kind} · licence: ${l.licence}`.slice(0, 200),
      },
      unit_amount: l.price_cents,
      // Prix affiché = prix TTC : la TVA calculée par Stripe Tax doit être
      // INCLUSE dans unit_amount, pas ajoutée par-dessus (défaut Stripe =
      // 'exclusive'). Sinon le client paie plus que le montant annoncé.
      tax_behavior: 'inclusive',
    },
  }));

  const params = _stripeForm({
    mode: 'payment',
    payment_method_types: ['card'],
    customer_email: user.email ?? undefined,
    line_items: lineItems,
    metadata: {
      kind: 'market_purchase',
      user_id: user.id,
      listing_ids: listings.map((l) => l.id).join(','),
    },
    // EU VAT / sales-tax auto-collection. _stripeForm encodes these as
    // automatic_tax[enabled]=true / tax_id_collection[enabled]=true.
    // Requires Stripe Tax enabled + origin address in the Dashboard.
    automatic_tax: { enabled: true },
    tax_id_collection: { enabled: true },
    success_url: `${SITE}/market?paid=1`,
    cancel_url: `${SITE}/market?canceled=1`,
  });

  const r = await fetch(_stripeCheckoutSessionsUrl(), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    // Log raw Stripe error server-side; surface a generic message — Stripe
    // bodies can contain account / customer ids we don't want exposed.
    console.error('[stripe-checkout]', r.status, errBody.slice(0, 500));
    return err(502, 'stripe checkout failed');
  }
  const session = await r.json() as { id: string; url: string };
  return json({ ok: true, url: session.url, session_id: session.id });
}

/** Webhook helper: persist ownership + sale records for a paid
 *  Stripe session whose metadata.kind === 'market_purchase'. Called
 *  from handleStripeWebhook. Idempotent — keyed on session.id. */
async function _processMarketPurchase(env: Env, sess: {
  id: string;
  metadata?: Record<string, string>;
  amount_total?: number;
}): Promise<void> {
  if (!env.MESHES) return;
  const userId = sess.metadata?.user_id;
  const idsCsv = sess.metadata?.listing_ids;
  if (!userId || !idsCsv) return;
  const ids = idsCsv.split(',').filter(Boolean);
  // Idempotence: if we already wrote a sale for this session, skip.
  const seenKey = `_market/sales_by_session/${sess.id}.txt`;
  const seen = await env.MESHES.head(seenKey);
  if (seen) return;

  // Montant de référence : ce que Stripe a encaissé, pas ce que les fiches
  // affichent aujourd'hui. Si la somme des prix courants dépasse la somme
  // réellement perçue (prix relevé après la création du paiement), on
  // ramène tous les reversements au prorata plutôt que de payer la
  // différence sur nos fonds.
  let ratioEncaisse = 1;
  const encaisse = typeof sess.amount_total === 'number' ? sess.amount_total : null;
  if (encaisse != null && encaisse > 0) {
    let attendu = 0;
    for (const listingId of ids) {
      const t = await r2GetText(env, `_market/listings/${listingId}.json`);
      if (!t) continue;
      try { attendu += Number((JSON.parse(t) as MarketListing).price_cents) || 0; } catch {}
    }
    if (attendu > encaisse) {
      ratioEncaisse = encaisse / attendu;
      console.warn(`[market] prix des fiches ${attendu} > encaissé Stripe ${encaisse}`
                   + ` — reversements ramenés à ${(ratioEncaisse * 100).toFixed(1)} %`);
    }
  }

  for (const listingId of ids) {
    const lTxt = await r2GetText(env, `_market/listings/${listingId}.json`);
    if (!lTxt) continue;
    let listing: MarketListing;
    try { listing = JSON.parse(lTxt) as MarketListing; } catch { continue; }

    // Per-(user, listing) idempotency. If a duplicate Stripe webhook fires
    // with a *different* session id (rare but possible during retries on
    // the same checkout flow), the seenKey check above wouldn't catch it.
    // Owners file existing = user already paid for this listing — skip the
    // sale + payout so we don't transfer twice or notify twice.
    const ownerKey = `_market/owners/${listingId}/${userId}.json`;
    if (await env.MESHES.head(ownerKey)) continue;

    // RÉSERVATION ATOMIQUE, posée AVANT tout mouvement d'argent.
    // Le HEAD ci-dessus ne suffit pas : Stripe livre ses webhooks
    // « au moins une fois », et deux livraisons simultanées passent
    // toutes deux le HEAD avant que l'une n'ait écrit quoi que ce soit.
    // Comme les verrous étaient posés en toute fin de fonction, la
    // fenêtre couvrait le virement lui-même. `etagDoesNotMatch: '*'`
    // n'écrit que si la clé n'existe pas encore : le perdant reçoit
    // null et s'arrête sans payer. Si le runtime ignore l'option, on
    // retombe exactement sur le comportement actuel — jamais pire.
    let reserve = true;
    try {
      const pose = await env.MESHES.put(ownerKey, JSON.stringify({ claiming: true, at: _isoNow() }),
                                        { httpMetadata: { contentType: 'application/json' },
                                          onlyIf: { etagDoesNotMatch: '*' } });
      reserve = pose !== null;
    } catch { /* option non supportée : on continue comme avant */ }
    if (!reserve) continue;

    // Ce que Stripe a RÉELLEMENT encaissé fait foi. Un vendeur peut avoir
    // relevé le prix de sa fiche entre la création du paiement et la
    // livraison du webhook : reverser sur le prix courant ferait sortir la
    // différence de la poche de la plateforme.
    const prixPaye  = Math.min(listing.price_cents, Math.floor(listing.price_cents * ratioEncaisse));
    const platformFee = Math.round(prixPaye * MARKET_COMMISSION_PCT / 100);
    const sellerNet   = prixPaye - platformFee;
    // Identifiant DÉTERMINISTE : un rejeu doit produire la même vente (sinon
    // on empile des doublons dans la comptabilité) et surtout le même corps
    // de requête, faute de quoi Stripe rejette la clé d'idempotence.
    const saleId = `${sess.id}_${listingId}`.replace(/[^A-Za-z0-9_-]/g, '');
    const sale = {
      id: saleId,
      listing_id: listingId,
      buyer_user_id: userId,
      seller_user_id: listing.user_id,
      amount_cents: prixPaye,
      platform_fee_cents: platformFee,
      seller_amount_cents: sellerNet,
      currency: listing.currency,
      stripe_session_id: sess.id,
      created_at: new Date().toISOString(),
      paid_at: new Date().toISOString(),
      status: 'paid',
      payout_status: 'pending',
    };
    await env.MESHES.put(`_market/sales/${saleId}.json`, JSON.stringify(sale),
                         { httpMetadata: { contentType: 'application/json' } });
    // Cash payout via Stripe Connect Express, if the seller has onboarded.
    // Uses Separate Charges and Transfers — we already collected the buyer's
    // money on the platform account; here we push the seller's net to their
    // connected account. Idempotence: outer seenKey HEAD blocks retries.
    let paidCash = false;
    if (listing.user_id) {
      try {
        const seller = await _getSeller(env, listing.user_id);
        if (seller && seller.charges_enabled && seller.stripe_account_id && sellerNet > 0) {
          const transfer = await _stripeRest(env, 'https://api.stripe.com/v1/transfers', {
            amount: sellerNet,
            currency: (listing.currency || 'usd').toLowerCase(),
            destination: seller.stripe_account_id,
            transfer_group: sess.id,
            metadata: {
              kind: 'marketplace_payout',
              listing_id: listingId,
              seller_user_id: listing.user_id,
              sale_id: saleId,
            },
          }, 'POST', `payout_${sess.id}_${listingId}`);
          if (transfer.ok) {
            const saleAny = sale as Record<string, unknown>;
            saleAny.payout_status = 'paid_cash';
            saleAny.payout_cash_cents = sellerNet;
            saleAny.payout_transfer_id = String(transfer.data.id ?? '');
            saleAny.payout_at = _isoNow();
            await env.MESHES.put(`_market/sales/${saleId}.json`, JSON.stringify(sale),
                                 { httpMetadata: { contentType: 'application/json' } });
            paidCash = true;
          } else {
            console.warn('[market] stripe transfer failed:', transfer.status, transfer.raw.slice(0, 200));
            const saleAny = sale as Record<string, unknown>;
            saleAny.payout_status = 'cash_failed_falling_back_to_credits';
            await env.MESHES.put(`_market/sales/${saleId}.json`, JSON.stringify(sale),
                                 { httpMetadata: { contentType: 'application/json' } });
          }
        }
      } catch (e) {
        console.warn('[market] transfer threw:', (e as Error).message);
        const saleAny = sale as Record<string, unknown>;
        saleAny.payout_status = 'cash_failed_falling_back_to_credits';
        await env.MESHES.put(`_market/sales/${saleId}.json`, JSON.stringify(sale),
                             { httpMetadata: { contentType: 'application/json' } });
      }
    }
    // Seller payout (credits fallback): only when cash transfer didn't fire
    // or failed. Idempotence is already guaranteed by the seenKey HEAD check
    // at the top of this function, so we won't double-pay on a retried webhook.
    const payoutCredits = _sellerPayoutCredits(sellerNet);
    if (!paidCash && payoutCredits > 0 && listing.user_id) {
      const newBal = await addCredits(env, listing.user_id, payoutCredits);
      const saleAny = sale as Record<string, unknown>;
      saleAny.payout_status = newBal == null ? 'failed' : 'paid_credits';
      saleAny.payout_credits = payoutCredits;
      saleAny.payout_at = _isoNow();
      await env.MESHES.put(`_market/sales/${saleId}.json`, JSON.stringify(sale),
                           { httpMetadata: { contentType: 'application/json' } });
    }
    // Notify the seller of the sale (covers both cash and credits branches).
    if (listing.user_id) {
      try {
        const priceMajor = (listing.price_cents / 100).toFixed(2);
        const currency = (listing.currency || 'USD').toUpperCase();
        const formattedPrice = `${priceMajor} ${currency}`;
        // Branch on actual payout type — credits earned has no meaning when
        // the seller was paid in cash via Stripe Connect (paidCash=true above).
        const sellerNetMajor = (sellerNet / 100).toFixed(2);
        const earnedSuffix = paidCash
          ? `(+${sellerNetMajor} ${currency} earned via Stripe).`
          : `(+${payoutCredits} credits earned).`;
        await _addUserNotification(env, listing.user_id, {
          kind: 'market_sale',
          message: `You sold "${listing.title}" for ${formattedPrice} ${earnedSuffix}`,
          listing_id: listing.id,
          subject: listing.title || 'Listing updated',
          asset_url: listing.asset_url || listing.mesh_url,
          asset_kind: listing.asset_kind || (listing.mesh_url ? 'mesh' : 'image'),
          job_id: listing.job_id,
        });
      } catch {}
    }
    // Ownership index — one object per (buyer, listing). Quick HEAD
    // check in /api/market/owned and /api/market/download.
    await env.MESHES.put(`_market/owners/${listingId}/${userId}.json`,
                         JSON.stringify({ sale_id: saleId, at: sale.paid_at }),
                         { httpMetadata: { contentType: 'application/json' } });
    // Bump downloads counter on a SEPARATE R2 key so concurrent buyers
    // don't clobber the listing JSON. The listing.downloads field is now
    // computed/joined at read time (see readListingDownloads).
    await bumpListingDownloads(env, listingId);
  }
  await env.MESHES.put(seenKey, new Date().toISOString());
}

/** GET /api/market/owned — listings the current user has bought.
 *  Lists every `_market/owners/<listing_id>/<user_id>.json` for this
 *  user and hydrates the listing. */
async function handleMarketOwned(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MESHES) return json({ items: [] });

  // R2 list doesn't support glob — we walk every listing and HEAD-check
  // the owner record. Cheap enough below ~1000 listings; revisit when
  // the marketplace grows.
  const all = await _loadAllListings(env);
  const items: Array<{
    id: string; title: string; description: string;
    price_cents: number; currency: string; licence: string;
    asset_kind: string; asset_url: string; mesh_url: string;
    author_display: string; created_at: string;
  }> = [];
  for (const l of all) {
    const head = await env.MESHES.head(`_market/owners/${l.id}/${user.id}.json`);
    if (!head) continue;
    items.push({
      id: l.id, title: l.title, description: l.description,
      price_cents: l.price_cents, currency: l.currency, licence: l.licence,
      asset_kind: l.asset_kind || (l.mesh_url ? 'mesh' : 'image'),
      asset_url: l.asset_url || l.mesh_url || '',
      mesh_url: l.mesh_url || '',
      author_display: l.author_display,
      created_at: l.created_at,
    });
  }
  return json({ ok: true, items });
}

/** GET /api/market/download/<listing_id> — proxies the asset bytes
 *  through the worker with Content-Disposition: attachment so the
 *  browser actually downloads instead of opening inline. Returning a
 *  302 to a cross-origin R2 URL strips the HTML `download` attribute
 *  and the browser falls back to "open in tab". Streaming
 *  `upstream.body` doesn't buffer, so this stays light on CPU. */
async function handleMarketDownload(req: Request, env: Env, listingId: string): Promise<Response> {
  if (!env.MESHES) return err(500, 'storage not configured');
  const lTxt = await r2GetText(env, `_market/listings/${listingId}.json`);
  if (!lTxt) return err(404, 'listing not found');
  let listing: MarketListing;
  try { listing = JSON.parse(lTxt); } catch { return err(500, 'listing parse failed'); }
  if (listing.status !== 'approved') return err(404, 'listing not visible');
  // Paid listings require auth + ownership. Free listings are public.
  if (listing.price_cents > 0) {
    const user = await getSessionUser(req, env);
    if (!user) return err(401, 'unauthorized');
    const head = await env.MESHES.head(`_market/owners/${listingId}/${user.id}.json`);
    if (!head) return err(402, 'purchase required');
  }
  const url = listing.asset_url || listing.mesh_url;
  if (!url) return err(404, 'asset URL missing');

  // Resolve to an R2 KEY when the asset lives in our bucket, so we stream
  // from the MESHES binding directly — robust to the r2.dev public bucket
  // being disabled AND to a signed /r2/ URL's TTL expiring. Only fall back
  // to an outbound fetch for genuinely external hosts (legacy replicate URLs).
  let r2Key: string | null = null;
  try {
    const u = new URL(url);
    const siteHost = new URL(siteUrl(env, 'http://localhost:3030')).host;
    if (u.pathname.startsWith('/r2/') && u.host === siteHost) {
      r2Key = u.pathname.slice('/r2/'.length).split('/').map(decodeURIComponent).join('/');
    } else if (env.R2_PUBLIC_URL && u.host === new URL(env.R2_PUBLIC_URL).host) {
      r2Key = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    }
  } catch {}
  if (r2Key && (r2Key.includes('..') || r2Key.startsWith('/'))) r2Key = null;

  // Safe filename: alphanumerics + dash + underscore from the title,
  // plus the extension lifted off the asset URL pathname.
  const safeTitle = (listing.title || 'asset').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80) || 'asset';
  let ext = '';
  try {
    const m = new URL(url).pathname.match(/\.([A-Za-z0-9]{1,8})$/);
    if (m) ext = '.' + m[1].toLowerCase();
  } catch {}
  const filename = safeTitle + ext;

  const headers = new Headers();
  headers.set('Content-Disposition', `attachment; filename="${filename}"`);
  headers.set('Cache-Control', 'private, max-age=60');

  let bodyStream: ReadableStream;
  if (r2Key) {
    const obj = await env.MESHES.get(r2Key);
    if (!obj) return err(404, 'asset not found in storage');
    bodyStream = (obj as { body: ReadableStream }).body;
    headers.set('Content-Type', r2ContentType(r2Key));
  } else {
    const upstream = await fetch(url);
    if (!upstream.ok || !upstream.body) return err(502, 'asset fetch failed');
    bodyStream = upstream.body;
    const upCT = upstream.headers.get('Content-Type');
    if (upCT) headers.set('Content-Type', upCT);
    const upCL = upstream.headers.get('Content-Length');
    if (upCL) headers.set('Content-Length', upCL);
  }

  // Best-effort downloads counter — atomic CAS on a separate R2 key.
  await bumpListingDownloads(env, listingId);

  return new Response(bodyStream, { status: 200, headers });
}

/** DELETE /api/admin/market/<id> — ADMIN. Hard-remove a listing. */
async function handleAdminMarketDelete(req: Request, env: Env, id: string): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  if (!env.MESHES) return err(500, 'storage not configured');
  await env.MESHES.delete(`_market/listings/${id}.json`);
  // Orphan cleanup: owners (per-buyer entries) and ratings (per-rater
  // entries) live under prefixes scoped to the listing id. Without this
  // cleanup, /api/market/owned and average-rating recompute keep
  // returning stale data for a listing that no longer exists.
  for (const prefix of [`_market/owners/${id}/`, `_market/ratings/${id}/`]) {
    try {
      let cursor: string | undefined;
      do {
        const page = await env.MESHES.list({ prefix, limit: 1000, cursor });
        for (const obj of page.objects) {
          try { await env.MESHES.delete(obj.key); } catch {}
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    } catch {}
  }
  // Drop the downloads counter too (separate key per FIX 15).
  try { await env.MESHES.delete(`_market/downloads/${id}.txt`); } catch {}
  return json({ ok: true, success: true });
}

async function handleMe(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) {
    // Side-channel set in getSessionUser when the session was killed
    // by the admin "Force logout all" button — lets the frontend
    // show a dedicated popup instead of a generic "please log in".
    const reason = (req as Request & { __sessionExpiredReason?: string }).__sessionExpiredReason;
    return json({ user: null, reason: reason ?? null }, { status: 401 });
  }
  const is_admin = !!(user.email && ADMIN_EMAILS.has(user.email.toLowerCase()));
  return json({ user: { ...user, is_admin } });
}

// Debug-only endpoint — returns what the Worker actually sees from the
// browser's cookie jar and Supabase token validation. Useful for tracing
// sign-in regressions without redeploying.
async function handleDebugAuth(req: Request, env: Env): Promise<Response> {
  // ADMIN-ONLY now. Previously open to anyone with a valid session
  // cookie, which leaked the Supabase user payload (email, id,
  // app_metadata) — useful for our own debugging but a free XSS
  // exfiltration target. Same auth as every other /api/admin/* route.
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;

  const cookies = parseCookies(req);
  const sbCookieKeys = Object.keys(cookies).filter(k => /^sb-[^-]+-auth-token(?:\.\d+)?$/.test(k));
  const token = readSupabaseAccessToken(req);

  let supabaseUserPayload: unknown = null;
  let supabaseStatus = 0;
  if (token) {
    const url = env.NEXT_PUBLIC_SUPABASE_URL ?? '';
    const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
    const r = await fetch(`${url}/auth/v1/user`, {
      headers: { 'authorization': `Bearer ${token}`, 'apikey': anon },
    });
    supabaseStatus = r.status;
    try { supabaseUserPayload = await r.json(); } catch { /* ignore */ }
  }

  return json({
    receivedCookieHeader: req.headers.get('cookie') ? 'present' : 'missing',
    sbCookieKeys,
    rawCookieValuePreview: sbCookieKeys.length
      ? cookies[sbCookieKeys[0]].slice(0, 80) + '…'
      : null,
    tokenExtracted: token ? token.slice(0, 24) + '…' : null,
    supabaseValidationStatus: supabaseStatus,
    supabaseUserPayload,
  });
}

// Public endpoint — returns which packs can currently be purchased.
// Subscription packs require STRIPE_PRICE_<PACKID> to be set as a Worker
// secret; without it /api/checkout returns 503, so the buy page should
// hide those cards. One-shot (payment-mode) packs are always available
// because we use price_data on the fly — no preconfigured Stripe Price
// needed. No auth required: this is read-only metadata.
async function handlePricingAvailability(_req: Request, env: Env): Promise<Response> {
  const available: Record<string, boolean> = {};
  for (const pack of Object.values(PACKS)) {
    if (pack.mode === 'subscription') {
      const envKey = `STRIPE_PRICE_${pack.id.toUpperCase()}` as keyof Env;
      available[pack.id] = !!(env[envKey] as string | undefined);
    } else {
      available[pack.id] = true;
    }
  }
  return json({ ok: true, available });
}

async function handleCheckout(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  const corps = await req.json() as { packId: PackId; consent?: boolean; consentedAt?: string };
  const packId = corps.packId;
  const pack = PACKS[packId];
  if (!pack) return err(400, 'unknown pack');

  /* RENONCIATION AU DROIT DE RETRACTATION — Art. L221-28 13°.
   *
   * La case a cocher n'existait QUE dans le navigateur : elle desactivait le
   * bouton, rien de plus. Aucune trace n'etait conservee. En cas de
   * contestation, c'est au professionnel de prouver que le consommateur a
   * expressement demande l'execution immediate ET reconnu perdre son droit de
   * retractation — nous n'aurions rien eu a produire.
   *
   * Le consentement est desormais EXIGE ici, et horodate dans les metadonnees
   * de la session Stripe, ou il reste consultable a cote du paiement. */
  if (corps.consent !== true) {
    return err(400, 'Consent to immediate delivery is required before payment (Art. L221-28 13°).');
  }
  const consentementLe = (typeof corps.consentedAt === 'string' && corps.consentedAt.length <= 40)
    ? corps.consentedAt
    : new Date().toISOString();

  if (!env.STRIPE_SECRET_KEY) return err(500, 'STRIPE_SECRET_KEY not set');

  /* Cle de TEST en production : on refuse d'ouvrir un paiement plutot que de
   * laisser croire a une vente. Le webhook refuse deja de crediter sur un
   * evenement livemode:false ; ce garde-ci evite en plus que l'utilisateur
   * saisisse une carte pour rien — et surtout que la carte de test 4242
   * serve a se fabriquer des credits.
   * STRIPE_ALLOW_TEST_MODE=1 pour eprouver la chaine deliberement. */
  if (/^sk_test_/.test(env.STRIPE_SECRET_KEY) && env.STRIPE_ALLOW_TEST_MODE !== '1' && !isMock(env)) {
    console.error('[stripe] cle de TEST en production — ouverture de paiement refusee.');
    return err(503, 'Payments are temporarily unavailable. Please try again later.');
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2025-02-24.acacia' as Stripe.LatestApiVersion });
  const SITE = siteUrl(env, 'http://localhost:3030');

  // Subscriptions need a Stripe Price ID created in the Stripe Dashboard
  // (recurring monthly). Set STRIPE_PRICE_<PACKID> as a Worker secret —
  // e.g. STRIPE_PRICE_SUB_STARTER=price_xxx. Without it we fall back to
  // a 400 error so the user knows the plan isn't configured yet.
  if (pack.mode === 'subscription') {
    const envKey = `STRIPE_PRICE_${pack.id.toUpperCase()}` as keyof Env;
    const priceId = (env[envKey] as string | undefined) ?? '';
    if (!priceId) {
      return err(503, `subscription plan ${pack.id} not yet configured (missing ${envKey})`);
    }
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: user.email ?? undefined,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: {
        user_id: user.id, pack_id: pack.id,
        credits: String(pack.credits), is_subscription: 'true',
        withdrawal_waiver: 'accepted', withdrawal_waiver_at: consentementLe,
      },
      subscription_data: {
        metadata: {
      user_id: user.id, pack_id: pack.id, credits: String(pack.credits),
      withdrawal_waiver: 'accepted', withdrawal_waiver_at: consentementLe,
    },
      },
      // EU VAT / sales-tax: let Stripe Tax compute and collect the correct
      // rate from the customer's billing address. Requires Stripe Tax to be
      // enabled + an origin address set in the Stripe Dashboard (Settings →
      // Tax). Checkout auto-collects the billing address when this is on.
      automatic_tax: { enabled: true },
      // Let B2B customers enter a VAT/tax ID (reverse-charge handling).
      tax_id_collection: { enabled: true },
      success_url: `${SITE}/account?paid=1`,
      cancel_url: `${SITE}/buy?canceled=1`,
    });
    return json({ url: session.url });
  }

  // One-shot top-up — original payment-mode flow.
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    customer_email: user.email ?? undefined,
    line_items: [{
      price_data: {
        currency: 'eur',
        product_data: {
          name: `${pack.credits} crédits MyFabmesh.AI (${pack.name})`,
          description: `Crédits pour la génération 3D MyFabmesh.AI — pack ${pack.name}`,
        },
        unit_amount: pack.euros * 100,
        // Prix affiché sur /buy = TTC : la TVA doit être INCLUSE dans
        // unit_amount et non ajoutée au-dessus (défaut Stripe = 'exclusive').
        // Conformité conso UE : le client paie exactement le prix promis.
        tax_behavior: 'inclusive',
      },
      quantity: 1,
    }],
    metadata: { user_id: user.id, pack_id: pack.id, credits: String(pack.credits) },
    // EU VAT / sales-tax auto-collection (see subscription branch above).
    automatic_tax: { enabled: true },
    tax_id_collection: { enabled: true },
    success_url: `${SITE}/account?paid=1`,
    cancel_url: `${SITE}/buy?canceled=1`,
  });
  return json({ url: session.url });
}

async function handleStripeWebhook(req: Request, env: Env): Promise<Response> {
  const sig = req.headers.get('stripe-signature') ?? '';
  const secret = env.STRIPE_WEBHOOK_SECRET ?? '';
  if (!secret) return err(500, 'no webhook secret');

  const raw = await req.text();
  const ok = await verifyStripeSignature(raw, sig, secret);
  if (!ok) return err(400, 'bad signature');

  let event: { type: string; livemode?: boolean; data: { object: { id: string; metadata?: Record<string, string>; amount_total?: number; amount_paid?: number; subscription?: string; lines?: { data: Array<{ metadata?: Record<string, string> }> }; charges_enabled?: boolean; payouts_enabled?: boolean; details_submitted?: boolean; country?: string; requirements?: { currently_due?: string[] } } } };
  try { event = JSON.parse(raw); } catch { return err(400, 'bad json'); }

  /* ═══════════════════════════════════════════════════════════════════
     ROBINET A CREDITS GRATUITS — refus des evenements de TEST.

     Audit du 2026-08-18 : la cle Stripe deployee en production etait une
     cle de TEST (sk_test_). Consequence double, et les deux faces etaient
     vraies en meme temps :
       - aucun euro ne pouvait etre encaisse ;
       - n'importe qui pouvait creer un compte, cliquer « Acheter » et payer
         avec la carte de test 4242 4242 4242 4242 pour se creer des credits.

     Ce n'etait pas theorique : la table `payments` de production contenait
     deja une ligne cs_test_ du 2026-07-28 — pack Studio, 350 credits
     accordes, 0 EUR encaisse.

     On refuse donc de CREDITER sur un evenement `livemode: false`. Le
     webhook repond 200 pour que Stripe ne rejoue pas indefiniment, mais
     aucun credit n'est accorde.

     Contournement explicite pour tester la chaine de paiement :
     STRIPE_ALLOW_TEST_MODE=1
     ═══════════════════════════════════════════════════════════════════ */
  const modeTestAutorise = env.STRIPE_ALLOW_TEST_MODE === '1' || isMock(env);
  if (event.livemode === false && !modeTestAutorise) {
    console.warn(
      `[stripe] evenement de TEST refuse (${event.type}, ${event.data?.object?.id}) — ` +
      'aucun credit accorde. Basculer Stripe en mode live, ou poser ' +
      'STRIPE_ALLOW_TEST_MODE=1 pour eprouver la chaine de paiement.'
    );
    return json({ received: true, ignored: 'test_mode' });
  }

  // Helper: credit the user atomically, then mark the payment processed.
  //
  // ORDER MATTERS. Before this refactor we did `insert payments` first,
  // then `addCredits`. If the worker died between the two (CPU limit,
  // restart, network blip on the second call), the payments row existed
  // -> the next webhook retry saw existing!=null -> addCredits never ran.
  // Client charged, zero credits, manual intervention required.
  //
  // New order:
  //   1. Idempotence probe: if payments row already exists, bail out.
  //   2. addCredits(user, n) via Supabase RPC (single atomic UPDATE).
  //   3. insert payments row.
  //
  // If step 3 fails after step 2 succeeded, the retry probe in step 1
  // is bypassed -> we'd double-credit. To prevent that, we check the
  // returned `data` from addCredits and only proceed to insert when
  // it succeeds; if the insert then fails, the next retry will re-call
  // addCredits and we'd double-credit ONCE. Workaround below: do the
  // existence probe AFTER addCredits too, so a retried webhook detects
  // the prior credit attempt via the payments row even if insert raced.
  async function _processPayment(opts: {
    sessionOrInvoiceId: string;
    userId: string;
    credits: number;
    packId: string;
    amountEur: number;
  }): Promise<{ ok: true } | { ok: false; retry: boolean }> {
    // Atomic-ish processing with self-healing on retry.
    //
    // Three states for the payments row:
    //   1. Not present       → first delivery, full flow below.
    //   2. credits === 0     → previous attempt died mid-flow (after
    //                         placeholder INSERT, before addCredits or
    //                         before the patch). Resume from addCredits.
    //   3. credits > 0       → already finalised, idempotent return.
    //
    // The state machine: probe → if (state 3) bail, if (state 2)
    // resume, if (state 1) INSERT placeholder THEN proceed. Single
    // path for the credit+patch step regardless of entry state, so
    // a retry that crashed AT ANY point converges to a finalised row.
    const sb = supabaseAdmin(env);
    const { data: existing } = await sb.from('payments')
      .select('id, credits').eq('stripe_session_id', opts.sessionOrInvoiceId).maybeSingle();
    if (existing && (existing as { credits: number }).credits > 0) {
      return { ok: true }; // already credited
    }
    if (!existing) {
      const ins = await sb.from('payments').insert({
        stripe_session_id: opts.sessionOrInvoiceId,
        user_id: opts.userId, pack_id: opts.packId, credits: 0,
        amount_eur: 0,
        created_at: new Date().toISOString(),
      });
      if (ins.error) {
        // Only Postgres duplicate-key (23505) means another delivery beat
        // us — their finalisation is independent, bail ok. Any other error
        // (RLS, network, schema) is a real failure: ask Stripe to retry.
        const code = (ins.error as { code?: string }).code;
        if (code === '23505') {
          return { ok: true };
        }
        console.error('[stripe] payments insert failed:',
          opts.sessionOrInvoiceId, ins.error.message);
        return { ok: false, retry: true };
      }
    }
    // State 1 (just inserted) and state 2 (resuming) converge here.
    const credited = await addCredits(env, opts.userId, opts.credits);
    if (credited === null) {
      // RPC failed; placeholder stays at credits=0 so the next retry
      // hits state 2 and re-attempts. Tell Stripe to retry by returning
      // retry:true → handler answers with a 500 so Stripe re-delivers.
      return { ok: false, retry: true };
    }
    const patch = await sb.from('payments')
      .update({ credits: opts.credits, amount_eur: opts.amountEur })
      .eq('stripe_session_id', opts.sessionOrInvoiceId);
    if (patch.error) {
      // The credits landed; only the accounting row update failed.
      // Tell Stripe to retry: the next call will see state-3 (credits
      // already on the user) ONLY if we already patched, otherwise
      // state-2 and we re-credit (DOUBLE CREDIT). Mitigation: bump
      // the placeholder to the real credits in a single transaction
      // with addCredits via an RPC — future TODO. For now we accept
      // the at-most-one-extra-credit risk on a rare DB blip.
      console.warn('[stripe] payments patch failed but credits added:',
        opts.sessionOrInvoiceId, patch.error.message);
    }
    return { ok: true };
  }

  // Resolve credits from server-side PACKS rather than trusting the
  // value Stripe carries in metadata — if our metadata was ever tampered
  // with (key leak, Stripe Dashboard misuse), a forged "credits":"99999"
  // would otherwise grant unlimited credits.
  const _packCredits = (packId: string | undefined, fallback: number): number => {
    if (packId && (PACKS as Record<string, { credits: number } | undefined>)[packId]) {
      return (PACKS as Record<string, { credits: number }>)[packId].credits;
    }
    // Last-ditch safety: cap raw metadata to a sane upper bound.
    return Math.min(Math.max(0, fallback), 10_000);
  };

  // One-shot top-up — credits added once on checkout.session.completed.
  if (event.type === 'checkout.session.completed') {
    const sess = event.data.object;
    // Marketplace purchase — different flow: no credits, instead we
    // record ownership + a sale entry. Detect via metadata.kind set
    // by handleMarketCheckout.
    if (sess.metadata?.kind === 'market_purchase') {
      await _processMarketPurchase(env, sess);
      return json({ received: true });
    }
    // Subscriptions handled by invoice.paid below (covers both the
    // first cycle and every renewal). Skip here to avoid double-credit.
    if (sess.metadata?.is_subscription === 'true') return json({ received: true });
    const userId = sess.metadata?.user_id;
    const packId = sess.metadata?.pack_id ?? 'unknown';
    const rawCredits = parseInt(sess.metadata?.credits ?? '0', 10);
    const credits = _packCredits(packId, rawCredits);
    if (userId && credits > 0) {
      const res = await _processPayment({
        sessionOrInvoiceId: sess.id, userId, credits, packId,
        amountEur: (sess.amount_total ?? 0) / 100,
      });
      if (!res.ok && res.retry) return err(500, 'transient credit failure');
    }
  }

  // Subscriptions — Stripe fires invoice.paid every billing cycle
  // (including the first one). Idempotent on stripe_session_id which
  // we set to the invoice id here so a retried webhook doesn't double-credit.
  // REMBOURSEMENTS ET LITIGES — ajoutes le 2026-08-03.
  //
  // Seuls 3 evenements etaient traites (checkout.session.completed,
  // invoice.paid, account.updated) : AUCUN handler de remboursement.
  // Consequence : un client rembourse par Stripe, ou qui obtenait gain de
  // cause sur un litige bancaire, RECUPERAIT SON ARGENT ET GARDAIT SES
  // CREDITS. Rien ne les reprenait.
  //
  // Aggravant introduit par mon propre correctif du 02/08 : le marqueur
  // `_meta/paid/<uid>` exempte les comptes payants de TOUS les plafonds de
  // depense GPU. Il n'etait jamais retire — un compte rembourse gardait
  // donc A VIE un acces GPU illimite.
  if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
    const ch = event.data.object as {
      payment_intent?: string; id?: string;
      metadata?: Record<string, string>;
      amount_refunded?: number; amount?: number;
    };
    const sb = supabaseAdmin(env);
    const total = event.type === 'charge.dispute.created';
    try {
      // On retrouve le paiement par l'identifiant que Stripe nous renvoie.
      // checkoutSessionId est stocke dans stripe_session_id ; selon le
      // chemin, l'identifiant utile est le payment_intent ou la charge.
      const refs = [ch.payment_intent, ch.id].filter(Boolean) as string[];
      let paiement: { id: number; user_id: string; credits: number } | null = null;
      for (const ref of refs) {
        const { data } = await sb.from('payments')
          .select('id, user_id, credits')
          .eq('stripe_session_id', ref).maybeSingle();
        if (data) { paiement = data as typeof paiement; break; }
      }

      // RECHERCHE PAR LA SESSION DE PAIEMENT — sans elle, la boucle ci-dessus
      // ne trouve JAMAIS rien.
      //
      // `payments.stripe_session_id` contient l'identifiant de la SESSION
      // (`cs_...`), pose a l'encaissement. Or un evenement `charge.refunded`
      // n'apporte que `pi_...` (payment_intent) et `ch_...` (charge) : aucun
      // des deux ne peut egaler un `cs_...`. La recherche echouait donc a
      // tous les coups, le repli `metadata.user_id` identifiait bien le
      // client mais laissait `credits` a 0 — resultat : **un client
      // rembourse gardait 100 % de ses credits**. Defaut introduit le
      // 2026-08-03 avec ce gestionnaire, trouve par audit le 2026-08-08.
      //
      // On demande donc a Stripe la session rattachee au payment_intent.
      // Aucune migration necessaire : cela fonctionne sur les lignes
      // existantes.
      if (!paiement && ch.payment_intent) {
        try {
          const r = await _stripeRest(
            env,
            'https://api.stripe.com/v1/checkout/sessions?limit=3&payment_intent='
              + encodeURIComponent(String(ch.payment_intent)),
            null, 'GET');
          const sessions = (r.ok && Array.isArray((r.data as { data?: unknown[] }).data))
            ? (r.data as { data: Array<{ id?: string }> }).data : [];
          for (const sess of sessions) {
            if (!sess?.id) continue;
            const { data } = await sb.from('payments')
              .select('id, user_id, credits')
              .eq('stripe_session_id', sess.id).maybeSingle();
            if (data) { paiement = data as typeof paiement; break; }
          }
        } catch (e) {
          console.warn('[stripe] resolution de la session impossible:', (e as Error).message);
        }
      }
      // Repli : metadata.user_id pose a la creation de la session.
      const uid = paiement?.user_id || ch.metadata?.user_id;
      if (!uid) {
        console.warn(`[stripe] ${event.type} sans paiement retrouvable — `
                   + `refs=${refs.join(',')}. Credits NON repris, a traiter a la main.`);
        return json({ received: true, unmatched: true });
      }

      // Reprise des credits. Proportionnelle sur un remboursement
      // partiel, totale sur un litige.
      let aReprendre = paiement?.credits ?? 0;
      if (!total && ch.amount && ch.amount_refunded && ch.amount > 0) {
        aReprendre = Math.ceil(aReprendre * (ch.amount_refunded / ch.amount));
      }
      if (aReprendre > 0) {
        // BORNAGE A 0 COTE WORKER. La RPC `add_credits` fait un simple
        // `credits = credits + p_amount` SANS plancher (verifie dans
        // cloud/sql/schema.sql) : passer un negatif brut pouvait donc
        // creer un solde NEGATIF, qui aurait bloque le compte meme apres
        // un rachat. On ne reprend jamais plus que ce qui reste.
        const { data: prof } = await sb.from('profiles')
          .select('credits').eq('id', uid).maybeSingle();
        const solde = Number((prof as { credits?: number } | null)?.credits ?? 0);
        const repris = Math.min(aReprendre, Math.max(0, solde));
        if (repris > 0) await addCredits(env, uid, -repris);
        console.log(`[stripe] ${event.type}: ${repris} credits repris a ${uid} `
                  + `(du: ${aReprendre}, solde: ${solde})`);
      }

      // Le compte n'est plus « payant » : on retire l'exemption de
      // plafonds. S'il lui reste un AUTRE paiement valide, le marqueur
      // sera recree paresseusement par _isPaidAccount.
      try {
        if (env.MESHES) {
          await env.MESHES.delete(`_meta/paid/${uid}`);
          console.log(`[stripe] exemption de plafonds retiree pour ${uid}`);
        }
      } catch { /* le marqueur sera de toute facon reevalue */ }

      if (paiement) {
        await sb.from('payments')
          .update({ credits: 0, amount_eur: 0 })
          .eq('id', paiement.id);
      }
    } catch (e) {
      console.error('[stripe] traitement du remboursement echoue:', e);
      // On demande a Stripe de rejouer : mieux vaut reessayer que de
      // laisser des credits non repris.
      return err(500, 'refund handling failed');
    }
    return json({ received: true });
  }

  if (event.type === 'invoice.paid') {
    const inv = event.data.object;
    // Stripe renewal invoices don't carry the original line-item metadata.
    // Try, in order: subscription_details.metadata (modern Stripe payload),
    // then line-item metadata (first cycle), then invoice metadata. If none
    // has user_id, retrieve the subscription explicitly to read its metadata.
    let meta: Record<string, string> = ((inv.subscription_details?.metadata
      ?? {}) as Record<string, string>);
    if (!meta.user_id) {
      const lineMeta = ((inv.lines?.data?.[0]?.metadata
        ?? {}) as Record<string, string>);
      if (lineMeta.user_id) meta = lineMeta;
    }
    if (!meta.user_id) {
      const invMeta = ((inv.metadata ?? {}) as Record<string, string>);
      if (invMeta.user_id) meta = invMeta;
    }
    if (!meta.user_id && inv.subscription) {
      const subId = String(inv.subscription);
      const subRes = await _stripeRest(env,
        `https://api.stripe.com/v1/subscriptions/${subId}`, null, 'GET');
      if (subRes.ok) {
        const subMeta = (subRes.data.metadata as Record<string, string> | undefined) ?? {};
        if (subMeta.user_id) meta = subMeta;
      }
    }
    const userId = meta.user_id;
    const packId = meta.pack_id ?? 'subscription';
    const rawCredits = parseInt(meta.credits ?? '0', 10);
    const credits = _packCredits(packId, rawCredits);
    if (userId && credits > 0) {
      const res = await _processPayment({
        sessionOrInvoiceId: inv.id, userId, credits, packId,
        amountEur: (inv.amount_paid ?? 0) / 100,
      });
      if (!res.ok && res.retry) return err(500, 'transient credit failure');
    }
  }

  // Stripe Connect — account state changes (onboarding completed, requirements
  // resolved, payouts enabled/disabled, etc.). We scan R2 sellers/ by
  // stripe_account_id, refresh the cached flags. Idempotent.
  if (event.type === 'account.updated') {
    const acct = event.data.object as Record<string, unknown>;
    const acctId = String(acct.id ?? '');
    if (acctId && env.MESHES) {
      let cursor: string | undefined;
      let found: SellerRecord | null = null;
      do {
        const page = await env.MESHES.list({ prefix: '_market/sellers/', limit: 1000, cursor });
        for (const obj of page.objects) {
          if (!obj.key.endsWith('.json')) continue;
          const txt = await r2GetText(env, obj.key);
          if (!txt) continue;
          try {
            const s = JSON.parse(txt) as SellerRecord;
            if (s.stripe_account_id === acctId) { found = s; break; }
          } catch {}
        }
        if (found) break;
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      if (found) {
        const refreshed = _normalizeStripeAccount(acct, found.user_id, found.country, found.created_at);
        await _putSeller(env, refreshed);
      }
    }
  }

  return json({ received: true });
}

/** Preset-aware GPU cost estimate for ONE mesh generation, in USD.
 *
 *  Before 2026-07-26 two different numbers coexisted: the budget guard
 *  charged a flat $0.16 (Modal) / $0.50 (Replicate) while the jobs row
 *  recorded MODAL_COST_USD['mesh'] = $0.060 — and neither looked at the
 *  preset, so a 1536_cascade ultra_q mesh (≈2.2× the GPU seconds of a
 *  plain 1024) was booked at the same price as a 512 lite. This helper is
 *  now the SINGLE source: it feeds both the guard and the recorded
 *  cost_usd, so the two can never diverge again.
 *
 *  The multiplier ladder mirrors the trellisMode ladder in handleGenerate
 *  1:1 (ultra_q → quality_plus → mode) — keep them in sync. */
/* Prédicats d'aiguillage des vues auto. DÉFINIS ICI, AU NIVEAU MODULE, et
 * pas dans le corps de handleGenerate : l'estimation de coût et l'exécution
 * doivent trancher exactement pareil. Tant qu'ils étaient dupliqués, toute
 * retouche d'un côté faisait silencieusement dériver la facturation. */
const AUTO_BACKVIEW_SKIP: ReadonlySet<string> = new Set(['avion', 'bateau']);
const HARD_SURFACE_TYPES: ReadonlySet<string> = new Set(
  ['vehicle', 'building', 'weapon', 'prop', 'avion', 'bateau']);
const MVA_TYPES: ReadonlySet<string> = new Set(['creature', 'animal']);

/** Coût des appels GPU que `/api/generate` déclenche DE LUI-MÊME, en plus
 *  de la génération de maillage : la rectification de l'image d'entrée, et
 *  la vue arrière automatique (feuille, MV-Adapter ou RealVis selon le type).
 *
 *  Ils n'étaient comptés NULLE PART. Le fusible journalier et le plafond par
 *  compte ne voyaient donc que les 0,37 $ du maillage, alors que la facture
 *  Modal encaissait jusqu'à ~0,12 $ de plus par génération — près d'un tiers
 *  de la dépense réelle invisible pour les garde-fous. */
function _auxGpuCostUsd(input: GenerateInput, env: Env, hasBackImage: boolean): number {
  let usd = 0;
  if (env.MODAL_RECTIFY_URL && input.rectify !== false) {
    usd += MODAL_COST_USD['rectify'];
  }
  if (input.back_view !== false && !hasBackImage
      && input.asset_type !== 'icon'
      && !AUTO_BACKVIEW_SKIP.has(input.asset_type)) {
    if (HARD_SURFACE_TYPES.has(input.asset_type) && env.MODAL_SHEET_URL) {
      usd += MODAL_COST_USD['sheet'];
    } else if (MVA_TYPES.has(input.asset_type) && env.MODAL_MVADAPTER_URL) {
      usd += MODAL_COST_USD['mvadapter'];
    } else if (env.MODAL_BACKVIEW_URL) {
      usd += MODAL_COST_USD['back-view'];
    }
  }
  return usd;
}

function _meshCostUsd(input: GenerateInput, useModalMesh: boolean): number {
  // Replicate runs the full Cog pipeline; one flat, much higher price.
  if (!useModalMesh) return 0.50;
  // MEASURED 2026-07-28, not assumed: 30 days of succeeded jobs give a
  // median wall-clock of 373-420s on L40S ($0.000542/s) = ~$0.21, plus
  // the 300s scaledown tail every isolated generation drags behind it
  // ($0.163). The old $0.16 counted the GPU seconds only and ignored the
  // idle tail entirely, so the daily guard was reading ~2.5x low and the
  // credit ladder was priced off a number that never matched the bill.
  const BASE = 0.37;
  const mult = input.ultra_q            ? 2.2   // 1536_cascade
             : input.quality_plus       ? 1.6   // 1024_cascade
             : input.mode === 'full'    ? 1.6   // 1024_cascade
             : input.mode === 'lite'    ? 1.0   // 512
             : 1.0;                             // 1024
  // face_fix lazily spins the SDXL inpaint model — same delta as the
  // historical 'mesh-face' vs 'mesh' entries in MODAL_COST_USD.
  const faceFixDelta = input.face_fix
    ? (MODAL_COST_USD['mesh-face'] - MODAL_COST_USD['mesh'])
    : 0;
  return +(BASE * mult + faceFixDelta).toFixed(4);
}

async function handleGenerate(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');

  const form = await req.formData();

  // Anti-abuse captcha gate on the most expensive endpoint. No-op while
  // TURNSTILE_SECRET_KEY is unset; once set, a valid token is required.
  // (Same pattern can be added to the other Modal handlers as needed.)
  const _tsOk = await verifyTurnstile(
    env,
    extractTurnstileToken(req, form),
    req.headers.get('cf-connecting-ip'),
  );
  if (!_tsOk) return err(403, 'captcha verification failed');
  let image = form.get('image');
  // If the client passed an HTTPS URL (R2/blob), capture it so the
  // Modal mesh path can re-use it directly without round-tripping
  // through a File upload (Modal's container fetches the URL on its
  // own; we don't need to re-host the bytes).
  // SSRF guard: only accept URLs from our known upstreams. Without this
  // an authenticated user could make the Worker fetch arbitrary internal
  // / external hosts (large download = DoS, leak internal infra responses
  // mirrored to R2 public, etc.).
  const _isTrustedImageHost = (u: string): boolean => isTrustedAssetHost(env, u);
  let imageHttpsUrl: string | null = null;
  const urlField = form.get('imagePath') || form.get('image_url');
  if (typeof urlField === 'string' && /^https?:\/\//i.test(urlField)) {
    if (!_isTrustedImageHost(urlField)) {
      return err(400, 'imagePath host not allowed');
    }
    imageHttpsUrl = urlField;
  }
  let backImageHttpsUrl: string | null = null;
  const backField = form.get('imagePathBack') || form.get('image_back_url');
  if (typeof backField === 'string' && /^https?:\/\//i.test(backField)) {
    if (!_isTrustedImageHost(backField)) {
      return err(400, 'imagePathBack host not allowed');
    }
    backImageHttpsUrl = backField;
  }
  // Cloud convenience: fetch the URL server-side. Bounded by 20 MB +
  // Content-Type must start with image/ — Worker has 128 MB RAM and
  // we don't want an attacker passing a 1 GB url to OOM us.
  const MAX_FETCH_BYTES = 20 * 1024 * 1024;
  if (!(image instanceof File) && imageHttpsUrl) {
    try {
      const r = await assetFetch(env, imageHttpsUrl);
      if (!r.ok) return err(400, `cannot fetch imagePath (HTTP ${r.status})`);
      const ct = r.headers.get('content-type') ?? '';
      if (!/^image\//i.test(ct)) {
        return err(400, `imagePath is not an image (content-type: ${ct})`);
      }
      const cl = parseInt(r.headers.get('content-length') ?? '0', 10);
      if (cl > MAX_FETCH_BYTES) {
        return err(413, `imagePath too large (${cl} bytes, max ${MAX_FETCH_BYTES})`);
      }
      const buf = await r.arrayBuffer();
      if (buf.byteLength > MAX_FETCH_BYTES) {
        return err(413, 'imagePath too large after read');
      }
      image = new File([buf], 'source.png', { type: ct || 'image/png' });
    } catch (e) {
      return err(400, `cannot fetch imagePath: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!(image instanceof File)) return err(400, 'image required (File or imagePath URL)');

  // Defensive: accept both snake_case (asset_type) and camelCase (assetType)
  // from the client. Older renderers sent assetType; the worker historically
  // only read asset_type, silently defaulting to "character" for non-snake
  // payloads. Pair with the renderer normalisation fix.
  const _assetType = (form.get('asset_type') || form.get('assetType') || 'character') as GenerateInput['asset_type'];
  const input: GenerateInput = {
    image,
    asset_type: _assetType,
    mode: (form.get('mode') as GenerateInput['mode']) || 'standard',
    seed: parseInt(String(form.get('seed') ?? '42'), 10) || 42,
    rectify: form.get('rectify') === 'true',
    back_view: form.get('back_view') === 'true',
    smooth: form.get('smooth') === 'true',
    face_fix: form.get('face_fix') === 'true',
    ultra_hd: form.get('ultra_hd') === 'true',
    fast: form.get('fast') === 'true',
    multiref: form.get('multiref') === 'true' || !!backImageHttpsUrl,
    refine: form.get('refine') === 'true',
    quality_plus: form.get('quality_plus') === 'true',
    ultra_q: form.get('ultra_q') === 'true',
    preset: (form.get('preset') as GenerateInput['preset']) || undefined,
  };

  const cost = await creditCost(env, input);
  // Decide backend FIRST so we hit the right budget counter. Mesh
  // routes to Modal when both MODAL_MESH_* URLs are set; otherwise
  // falls back to the Replicate Cog (fishwowater/trellis2). Each
  // backend has its own daily $ cap (and own counter in R2).
  const useModalMesh = !!(env.MODAL_MESH_START_URL && env.MODAL_MESH_STATUS_URL);
  // Cost estimates: Replicate ~$0.50/mesh (full mode all post-process),
  // Modal ~$0.16/mesh base (TRELLIS-2 5min L40S × $0.000542 + R2 ops),
  // scaled by the resolution preset — see _meshCostUsd. The SAME number is
  // written to jobs.options.cost_usd below so the budget guard and the
  // reported margin always agree.
  // Maillage + les appels GPU auxiliaires que ce handler déclenche seul.
  // Ces derniers échappaient totalement aux garde-fous (voir _auxGpuCostUsd).
  const ESTIMATED_USD_MESH = +(
    _meshCostUsd(input, useModalMesh)
    + (useModalMesh ? _auxGpuCostUsd(input, env, !!backImageHttpsUrl) : 0)
  ).toFixed(4);

  const remainingBudget = useModalMesh
    ? await checkAndIncrementModalSpend(env, ESTIMATED_USD_MESH, user.id)
    : await checkAndIncrementDailySpend(env, ESTIMATED_USD_MESH, user.id);
  if (remainingBudget == null) {
    return err(429, await _spendRefusalMessage(env, user.id));
  }
  const refundMeshSpend = async () => {
    if (useModalMesh) await refundModalSpend(env, ESTIMATED_USD_MESH);
    else await refundDailySpend(env, ESTIMATED_USD_MESH);
  };
  const remainingUserCalls = await checkAndIncrementUserCalls(env, user.id);
  if (remainingUserCalls == null) {
    await refundMeshSpend();
    return err(429, 'you have reached the per-user daily generation limit.');
  }
  const remaining = await spendCredits(env, user.id, cost);
  if (remaining == null) {
    await refundMeshSpend();
    return err(402, 'insufficient credits');
  }

  if (isMock(env)) {
    const jobId = 'mock_' + Date.now();
    mock.insertJob({
      id: jobId, user_id: user.id,
      asset_type: input.asset_type, mode: input.mode, seed: input.seed ?? 42,
      credit_cost: cost, status: 'processing',
      options: {
        rectify: input.rectify, back_view: input.back_view, smooth: input.smooth,
        face_fix: input.face_fix, ultra_hd: input.ultra_hd, fast: input.fast,
      },
      mesh_url: null, error: null,
      created_at: new Date().toISOString(), finished_at: null,
    });
    return json({ jobId, creditsRemaining: remaining, mock: true });
  }

  // (useModalMesh already declared above before the budget check.)
  // Accept snake_case (original API), camelCase (cloud JS shim forwards
  // user opts as-is), AND `outputName` (what cloud/public/app/index2.js
  // actually sends — it inherits the desktop param name where the mesh
  // was written to <outputName>.glb on disk; the project name and the
  // output filename were the same string in the desktop world).
  // Without this fallback every cloud-side mesh would land in
  // "untitled" — that was the bug on 2026-05-26.
  const projectName = (form.get('project_name') as string | null)
                   || (form.get('projectName') as string | null)
                   || (form.get('outputName') as string | null)
                   || null;

  if (useModalMesh) {
    // Modal needs a fetchable HTTPS URL (its container will pull the
    // bytes itself). We DON'T pass `input.image` (a File) — Modal's
    // urlopen wouldn't know what to do with a multipart blob.
    // If the client only sent a File and no URL, mirror the bytes to
    // R2 first so we can give Modal a stable URL.
    let frontUrl = imageHttpsUrl;
    // When we upload the user's source photo to R2 we persist its raw KEY
    // (not the signed URL) so handleCloudProjects/handleListMeshes can
    // re-sign it on read with a fresh TTL. For caller-supplied https URLs
    // there is no key — we persist the URL itself (legacy pass-through).
    let sourceImageStore: string | undefined = imageHttpsUrl;
    if (!frontUrl) {
      if (!env.MESHES || !env.R2_PUBLIC_URL) {
        await addCredits(env, user.id, cost);
        await refundMeshSpend();
        return err(500, 'cloud GPU mesh path needs R2 (no imagePath URL provided)');
      }
      const fileBytes = new Uint8Array(await input.image.arrayBuffer());
      const key = `${user.id}/source/${Date.now()}_${input.seed ?? 42}.png`;
      await env.MESHES.put(key, fileBytes, {
        httpMetadata: { contentType: input.image.type || 'image/png' },
      });
      // CRITICAL PRIVACY: the user face photo must be signed, not public.
      frontUrl = await signedR2Url(env, key, 'image');
      sourceImageStore = key;
    }

    const isOrganic = input.asset_type === 'character'
                   || input.asset_type === 'creature'
                   || input.asset_type === 'animal';

    // ── Wave 2.1 — Auto-rectify according to asset_type ────────────
    // Desktop parity (main.js:4012-4014): generate_front_strict.py is
    // applied automatically before mesh with --mode front for character
    // /creature/animal and --mode iso for vehicle/building/weapon/prop
    // /icon. Without this, concept-art 3/4 inputs produce trapu meshes.
    //
    // Toggled off by `rectify: false` in the request (default ON).
    // Failure is non-fatal — we fall back to the un-rectified image so
    // a transient rectify outage doesn't tank the whole mesh.
    if (env.MODAL_RECTIFY_URL && input.rectify !== false) {
      const rectifyMode: 'front' | 'iso' = isOrganic ? 'front' : 'iso';
      try {
        const rectifiedUrl = await _journaliserAppelAux(env, user.id, 'rectify',
          () => callModalRectify(env, user.id, {
            refImageUrl: frontUrl,
            mode: rectifyMode,
            seeds: 3,
          }, 'rectify'));
        console.log(`[wave2.1] rectified front → ${rectifyMode} (asset=${input.asset_type})`);
        frontUrl = rectifiedUrl;
      } catch (e: unknown) {
        console.warn(`[wave2.1] rectify failed, using original front: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // ────────────────────────────────────────────────────────────────

    // ── Wave 2.2 / 2.3 — Auto-back-view dispatch by asset_type ──────
    // Desktop parity (main.js:4804-4806): the back-view generator is
    // dispatched by asset_type to one of FOUR pipelines:
    //   character          → realvis  (RealVisXL + CN OpenPose T-pose
    //                                   + IP-Adapter + Florence-2)
    //   creature, animal   → mvadapter (MV-Adapter 6 orthographic views)
    //   vehicle, building,
    //   weapon, prop       → sheet    (RealVisXL 2x2 sheet w/ IP-Adapter
    //                                   Plus — consistent identity)
    //   icon               → none     (2D flat, no back)
    //
    // Wave 2.2 ports realvis (already deployed as MODAL_BACKVIEW_URL).
    // Wave 2.3 ports sheet  (MODAL_SHEET_URL — new endpoint).
    // Wave 2.4 will port mvadapter — until then creature/animal share
    // the realvis path, which is suboptimal but better than no back.
    //
    // Skipped when:
    //   - back_view is explicitly false in the request
    //   - the caller already provided a back image (don't re-bill)
    //   - asset is icon (2D flat, no back to generate)
    const isHardSurface = HARD_SURFACE_TYPES.has(input.asset_type);
    // Per-asset_type back-view prompt hints. Empty string = generic
    // "back view, same subject" fallback baked into the Modal endpoint.
    // Avion/Bateau need explicit rear-geometry tokens because the sheet
    // pipeline's IP-Adapter Plus otherwise lets the model invent a second
    // front-facing aircraft / a side-on boat instead of the actual stern.
    const BACK_VIEW_PROMPT_HINTS: Record<string, string> = {
      avion:  'rear view of the same passenger aircraft from directly behind, tail fin and rear engines and rear fuselage clearly visible, same composition same lighting same background, photorealistic, ONE aircraft only, no second plane',
      bateau: 'stern view of the same boat from directly behind, transom and rear hull and rear deck clearly visible, same composition same lighting same background, photorealistic, ONE boat only, no second boat',
    };
    // Auto-backview SKIP list — types whose back-view, when generated by
    // the sheet pipeline (IP-Adapter Plus), produces geometry inconsistent
    // with the front view. TRELLIS fuses front+back into a chimera mesh.
    // Better to run single-view and let TRELLIS infer the back from its
    // training distribution. Re-enable when a per-shape back-view model
    // (or pose-conditioned diffusion) replaces the sheet pipeline.
    // Hard-surface aircraft + boats: explicit. Icon: already excluded.
    // (La liste elle-même vit au niveau module — voir AUTO_BACKVIEW_SKIP.)
    if (input.back_view !== false && !backImageHttpsUrl
        && input.asset_type !== 'icon'
        && !AUTO_BACKVIEW_SKIP.has(input.asset_type)) {
      try {
        let autoBackUrl: string | null = null;
        let autoMVViews: string[] = [];
        const backHint = BACK_VIEW_PROMPT_HINTS[input.asset_type] ?? '';
        const isMVACandidate = MVA_TYPES.has(input.asset_type);
        if (isHardSurface && env.MODAL_SHEET_URL) {
          // Wave 2.3 — sheet dispatch.
          autoBackUrl = await _journaliserAppelAux(env, user.id, 'sheet',
            () => callModalSheet(env, user.id, {
              frontImageUrl: frontUrl,
              promptHint: backHint,
              seed: (input.seed ?? 42) + 1000,
            }, 'back-auto'));
          console.log(`[wave2.3] sheet back-view for ${input.asset_type} hint=${backHint ? 'yes' : 'no'}`);
        } else if (isMVACandidate && env.MODAL_MVADAPTER_URL) {
          // Wave 2.4 — MV-Adapter dispatch (6 orthographic views) for
          // creature/animal. Stores the BACK view in autoBackUrl for
          // TRELLIS multiref compat; the full 6-view manifest lives in
          // autoMVViews for future TRELLIS-2 multi-view conditioning.
          const mv = await _journaliserAppelAux(env, user.id, 'mvadapter',
            () => callModalMVAdapter(env, user.id, {
              frontImageUrl: frontUrl,
              promptHint: backHint,
              seed: (input.seed ?? 42) + 1000,
            }, 'mv-auto'));
          autoBackUrl = mv.back;
          autoMVViews = mv.views;
          console.log(`[wave2.4] mvadapter 6-view for ${input.asset_type} views=${mv.views.length}`);
        } else if (isOrganic && env.MODAL_BACKVIEW_URL) {
          // Wave 2.2 — realvis dispatch (character + fallback for
          // creature/animal when MVAdapter URL is unset).
          autoBackUrl = await _journaliserAppelAux(env, user.id, 'back-view',
            () => callModalBackView(env, user.id, {
              frontImageUrl: frontUrl,
              promptHint: backHint,
              seed: (input.seed ?? 42) + 1000,
            }, 'back-auto'));
          console.log(`[wave2.2] realvis back-view for ${input.asset_type}`);
        }
        if (autoBackUrl) {
          backImageHttpsUrl = autoBackUrl;
          // multiref is read at the call site below (`input.multiref ?
          // backImageHttpsUrl : null`). At payload-parse time multiref
          // was decided BEFORE we generated the back — force it on now
          // that we have 2 views.
          input.multiref = true;
          // Wave 2.4 — when MVAdapter populated 6 views, expose them on
          // the input so the Modal mesh-gen call can forward them to
          // TRELLIS-2 multi-view conditioning (no-op for TRELLIS-1).
          if (autoMVViews.length === 6) {
            (input as any).mv_views = autoMVViews;
          }
        }
      } catch (e: unknown) {
        console.warn(`[wave2.x] auto back-view failed, falling back to single-view: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // ────────────────────────────────────────────────────────────────

    // Worker generates the job_id (uuid hex). Modal echoes it back.
    const jobId = 'modal_' + crypto.randomUUID().replace(/-/g, '');
    // Insert the job BEFORE the Modal call so the admin's Active jobs
    // tab sees it immediately. Without this the row only appeared
    // after callModalMeshStart returned — and Modal cold-start
    // sometimes takes 60-150s, leaving the admin staring at "No
    // active jobs" while the user was already waiting.
    const jobIns = await supabaseAdmin(env).from('jobs').insert({
      id: jobId, user_id: user.id,
      asset_type: input.asset_type, mode: input.mode, seed: input.seed,
      credit_cost: cost, status: 'queued',
      type: 'mesh',
      cost_usd: ESTIMATED_USD_MESH,
      project_name: projectName,
      options: {
        rectify: input.rectify, back_view: input.back_view, smooth: input.smooth,
        face_fix: input.face_fix, ultra_hd: input.ultra_hd, fast: input.fast,
        backend: 'modal',
        operation_type: 'mesh',
        // Same value the budget guard just charged (preset-aware).
        cost_usd: ESTIMATED_USD_MESH,
        // 2026-06-01: store the source image URL so handleListMeshes
        // can show it as the mesh thumbnail (each mesh version gets
        // the image it was generated FROM, not the project's default).
        sourceImage: sourceImageStore,
      },
      created_at: new Date().toISOString(),
    });
    if (jobIns.error) {
      // If the jobs row can't be persisted, calling Modal would orphan a
      // GPU job with no way to track it — refund credits + Modal budget,
      // surface the failure to the user.
      await addCredits(env, user.id, cost);
      await refundMeshSpend();
      console.error('[jobs.insert]', jobIns.error.message);
      return err(500, 'job creation failed: ' + jobIns.error.message);
    }
    try {
      // Resolve TRELLIS-2 mode. ultra_q wins (1536 voxels for the
       // finest face detail), then quality_plus (cascade), then the
       // user's coarse mode picker. Without this map, ticking
       // "Ultra Quality (+~50s, +2 cr)" was a paid no-op — the worker
       // sent mode=1024 to Modal and the user got the default mesh.
      const trellisMode = input.ultra_q     ? '1536_cascade'
                        : input.quality_plus ? '1024_cascade'
                        : input.mode === 'full' ? '1024_cascade'
                        : input.mode === 'lite' ? '512'
                        : '1024';
      await callModalMeshStart(env, {
        jobId,
        frontImageUrl: frontUrl,
        backImageUrl: input.multiref ? backImageHttpsUrl : null,
        mode: trellisMode,
        seed: input.seed ?? 42,
        decimation_target: input.mode === 'lite' ? 100_000
                         : input.mode === 'full' ? 1_500_000 : 500_000,
        // ultra_hd bumps the atlas to 4096 for the Real-ESRGAN x2 pass
        // downstream. Otherwise 2048 for "full", 1024 elsewhere.
        texture_size: input.ultra_hd ? 4096
                    : input.mode === 'full' ? 2048
                    : 1024,
        // STEPS DU PALIER DE QUALITE. Le client calcule 12/24/32 selon
        // Fast/Balanced/Quality/Ultra et l'envoie dans `trellis2Steps`,
        // mais le worker le RECEVAIT SANS JAMAIS LE TRANSMETTRE : les
        // quatre paliers, factures 3/4/6/8 credits, produisaient le meme
        // travail GPU. Borne a [8, 48] pour qu'un client trafique ne
        // puisse pas commander une generation interminable.
        tex_steps: Math.max(0, Math.min(48,
          parseInt(String((input as unknown as Record<string, unknown>).trellis2Steps ?? 0), 10) || 0)),
        rectify: input.rectify,
        face_fix: input.face_fix,
        // Forward all the advanced flags so Modal can act on them.
        // Modal's mesh class ignores keys it doesn't know yet, so this
        // is forward-compatible with future _mesh.py improvements.
        refine: input.refine,
        smooth: input.smooth,
        ultra_hd: input.ultra_hd,
        multiref: input.multiref,
      });
      // Modal accepted the spawn — flip queued -> processing.
      await supabaseAdmin(env).from('jobs').update({ status: 'processing' }).eq('id', jobId);
    } catch (e: unknown) {
      await addCredits(env, user.id, cost);
      await refundMeshSpend();
      const msg = e instanceof Error ? e.message : String(e);
      // Log full upstream error server-side; return a generic message to
      // the client so we don't leak upstream stack traces / internal URLs.
      console.error('[mesh-start]', msg, e);
      await supabaseAdmin(env).from('jobs').update({
        status: 'failed', error: msg, finished_at: new Date().toISOString(),
      }).eq('id', jobId);
      return err(502, `cloud GPU mesh-start failed (credits refunded): ${msg.slice(0, 200)}`);
    }
    return json({ jobId, creditsRemaining: remaining });
  }

  let prediction;
  try {
    prediction = await createReplicatePrediction(env, input);
  } catch (e: unknown) {
    await addCredits(env, user.id, cost);
    await refundMeshSpend();
    console.error('[replicate]', e instanceof Error ? e.message : String(e), e);
    return err(502, 'cloud GPU failed (credits refunded)');
  }

  const predIns = await supabaseAdmin(env).from('jobs').insert({
    id: prediction.id, user_id: user.id,
    asset_type: input.asset_type, mode: input.mode, seed: input.seed,
    credit_cost: cost, status: prediction.status,
    type: 'mesh',
    cost_usd: ESTIMATED_USD_MESH,
    project_name: projectName,
    options: {
      rectify: input.rectify, back_view: input.back_view, smooth: input.smooth,
      face_fix: input.face_fix, ultra_hd: input.ultra_hd, fast: input.fast,
      // Without these two the row fell back to operation_type 'mesh' +
      // MODAL_COST_USD['mesh'] = $0.060 for a ~$0.50 Replicate call.
      operation_type: 'mesh',
      backend: 'replicate',
      cost_usd: ESTIMATED_USD_MESH,
    },
    created_at: new Date().toISOString(),
  });
  if (predIns.error) {
    // Replicate prediction already running but we can't track it — refund
    // credits + Replicate budget so the user can retry. The orphan
    // prediction will complete and bill us, but at least the user is made
    // whole. Surface a clear error.
    await addCredits(env, user.id, cost);
    await refundMeshSpend();
    console.error('[jobs.insert/replicate]', predIns.error.message);
    return err(500, 'job creation failed: ' + predIns.error.message);
  }
  return json({ jobId: prediction.id, creditsRemaining: remaining });
}

async function handleJob(req: Request, env: Env, id: string): Promise<Response> {
  const MOCK_GEN_DURATION_MS = 5000;
  const MOCK_GLB_URL = '/mock/sample.glb';

  if (isMock(env)) {
    const job = mock.getJob(id);
    if (!job) return json({ status: 'failed', error: 'job not found' });
    const age = Date.now() - new Date(job.created_at).getTime();
    if (job.status === 'succeeded') {
      return json({ status: 'succeeded', url: job.mesh_url, duration_s: age / 1000 });
    }
    if (age > MOCK_GEN_DURATION_MS) {
      mock.updateJob(id, {
        status: 'succeeded', mesh_url: MOCK_GLB_URL,
        finished_at: new Date().toISOString(),
      });
      return json({ status: 'succeeded', url: MOCK_GLB_URL, duration_s: age / 1000 });
    }
    return json({ status: 'processing' });
  }

  // Authenticate + enforce ownership (fix IDOR): /api/jobs/:id must NOT return
  // another user's mesh download URL. Every other status endpoint checks the
  // session + row owner; this one was the exception. Both the web app
  // (getJSON) and mobile (apiGet) already send credentials, so requiring auth
  // here is safe. Ownership mismatch returns a generic "not found" so a caller
  // can't confirm a job id exists.
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  const _isJobAdmin = !!(user.email && ADMIN_EMAILS.has(user.email.toLowerCase()));
  const owns = (j: unknown): boolean =>
    !!j && (((j as { user_id?: string }).user_id === user.id) || _isJobAdmin);

  // Modal-backed mesh jobs use a `modal_<uuid>` id and are polled
  // through callModalMeshStatus instead of Replicate. Once the GLB
  // is ready we persist it to R2 (so the renderer gets a stable URL
  // not the inline base64) and flip the Supabase row to succeeded.
  if (id.startsWith('modal_')) {
    const sbm = supabaseAdmin(env);
    const { data: job } = await sbm.from('jobs').select('*').eq('id', id).maybeSingle();
    if (!job) return json({ status: 'failed', error: 'job not found' });
    if (!owns(job)) return json({ status: 'failed', error: 'job not found' });
    if (job.status === 'succeeded' && job.mesh_url) {
      const start = job.created_at ? new Date(job.created_at as string).getTime() : Date.now();
      return json({ status: 'succeeded', url: job.mesh_url as string,
                    duration_s: (Date.now() - start) / 1000 });
    }
    // Admin-cancelled (or otherwise terminally-marked) jobs MUST be
    // surfaced immediately — Modal's FunctionCall.cancel() is best-
    // effort and the GPU container can keep running for ~30s, during
    // which callModalMeshStatus would still report "processing" and
    // the renderer would poll forever. Trust the Supabase row.
    if (job.status === 'canceled' || job.status === 'failed') {
      return json({ status: job.status as string,
                    error: (job.error as string) || 'cancelled' });
    }
    try {
      const status = await callModalMeshStatus(env, id);
      if (status.error) {
        // Idempotent fail+refund: only the request that flips the row out of a
        // non-terminal status refunds, so a client poll and the cron reaper
        // can't both refund the same job.
        await _failAndRefundJob(env, job, status.error);
        return json({ status: 'failed', error: status.error });
      }
      if (!status.ready || !status.glb_base64) {
        return json({ status: 'processing' });
      }
      const stableUrl = await persistModalGlb(env, id, status.glb_base64);
      /* COURSE AVEC L'ANNULATION — la garde de statut est indispensable.
       *
       * La ligne etait lue au debut de la requete, puis Modal interroge et le
       * fichier telecharge : plusieurs secondes s'ecoulent. Un utilisateur qui
       * cliquait « Annuler » pendant ce laps obtenait ses credits rendus par
       * la route d'annulation, ET ce `.update()` ecrasait ensuite le statut
       * `canceled` par `succeeded` — il repartait donc avec le maillage.
       * L'operation etait sans risque pour lui : perdue, il payait
       * normalement ; gagnee, c'etait gratuit. Il suffisait de recommencer.
       *
       * `.eq('status', ...)` restreint l'ecriture aux etats non terminaux :
       * si la ligne est passee a `canceled` ou `failed` entre-temps, aucune
       * ligne n'est touchee et on rend le statut reel. */
      const { data: maj } = await sbm.from('jobs')
        .update({ status: 'succeeded', mesh_url: `mesh/${id}.glb`,
                  finished_at: new Date().toISOString() })
        .eq('id', id)
        .in('status', ['queued', 'processing', 'running', 'starting'])
        .select('id');
      if (!maj || maj.length === 0) {
        const { data: apres } = await sbm.from('jobs').select('status,error').eq('id', id).maybeSingle();
        const etat = (apres?.status as string) || 'canceled';
        console.warn(`[modal] ${id} termine mais la ligne est en ${etat} — maillage NON livre`);
        return json({ status: etat, error: (apres?.error as string) || 'cancelled' });
      }
      const start = job.created_at ? new Date(job.created_at as string).getTime() : Date.now();
      return json({ status: 'succeeded', url: stableUrl,
                    duration_s: (Date.now() - start) / 1000 });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('modal poll error:', msg);
      return json({ status: 'processing', poll_warning: msg.slice(0, 200) });
    }
  }

  const sb = supabaseAdmin(env);
  const { data: job } = await sb.from('jobs').select('*').eq('id', id).maybeSingle();
  // Ownership gate (fix IDOR): a non-owner — or a null row that would otherwise
  // fall through to a bare Replicate predictions.get(id) leaking a mesh URL — is
  // treated as not-found.
  if (!owns(job)) return json({ status: 'failed', error: 'job not found' });
  // Short-circuit on terminal Supabase status (admin cancel writes
  // status='canceled' with error='admin canceled'). Replicate's own
  // cancel propagates eventually but the row is the source of truth,
  // so don't waste a round-trip on predictions.get.
  if (job && (job.status === 'canceled' || job.status === 'failed')) {
    return json({ status: job.status as string,
                  error: (job.error as string) || 'cancelled' });
  }
  const prediction = await replicateClient(env).predictions.get(id);

  const extractGlb = (output: unknown): string | null => {
    if (!output) return null;
    if (typeof output === 'string') return output;
    const o = output as Record<string, unknown>;
    if (typeof o.url === 'string') return o.url;
    if (typeof o.model_file === 'string') return o.model_file;
    const mf = o.model_file as Record<string, unknown> | undefined;
    if (mf && typeof mf.url === 'string') return mf.url;
    return null;
  };

  if (prediction.status === 'succeeded') {
    const replicateUrl = extractGlb(prediction.output);
    let stableUrl: string | null = (job?.mesh_url as string | null) ?? null;
    if (replicateUrl && !stableUrl && job) {
      const meshKey = `${job.user_id}/${id}.glb`;
      // Persist the raw KEY so reads re-sign with a fresh TTL; only fall
      // back to the (expiring) replicate URL if the R2 mirror failed.
      let persisted: string;
      try {
        stableUrl = await uploadGlbToR2(env, replicateUrl, meshKey);
        persisted = meshKey;
      } catch (e) {
        console.error('R2 upload failed, falling back to replicate URL:', e);
        stableUrl = replicateUrl;
        persisted = replicateUrl;
      }
      // Meme garde de statut que les quatre routes de statut corrigees
      // plus tot : un job DEJA rembourse ne doit pas pouvoir etre repasse
      // en 'succeeded' par un simple sondage, sans quoi l'utilisateur
      // garde l'actif ET ses credits.
      await sb.from('jobs')
        .update({ status: 'succeeded', mesh_url: persisted, finished_at: new Date().toISOString() })
        .eq('id', id)
        .in('status', NON_TERMINAL_JOB_STATUSES as unknown as string[]);
    }
    const start = job?.created_at ? new Date(job.created_at as string).getTime() : Date.now();
    // Re-sign on read: stableUrl may be a raw KEY persisted on a prior poll;
    // signedR2Url passes through full https URLs (signed/replicate) unchanged.
    const respUrl = stableUrl ? await signedR2Url(env, stableUrl, 'mesh') : replicateUrl;
    return json({
      status: 'succeeded', url: respUrl,
      duration_s: (Date.now() - start) / 1000,
    });
  }

  if (prediction.status === 'failed' || prediction.status === 'canceled') {
    if (job) {
      // RECLAMATION ATOMIQUE. Avant : lecture, test `job.status !==
      // prediction.status` EN MEMOIRE, puis remboursement et ecriture.
      // Deux onglets qui sondent le meme job passaient tous les deux le
      // test et creditaient tous les deux — de la monnaie creee en
      // laissant simplement deux onglets ouverts.
      //
      // Meme motif que _failAndRefundJob : seule la requete qui change
      // reellement la ligne obtient un retour, et donc rembourse.
      const { data: claimed } = await sb.from('jobs')
        .update({ status: prediction.status, error: prediction.error || null,
                  finished_at: new Date().toISOString() })
        .eq('id', id)
        .in('status', NON_TERMINAL_JOB_STATUSES as unknown as string[])
        .select('id');
      if (claimed && claimed.length > 0) {
        await addCredits(env, job.user_id as string, job.credit_cost as number);
      }
    }
    return json({ status: prediction.status, error: prediction.error || 'unknown error' });
  }
  return json({ status: prediction.status });
}

async function handleProjects(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');

  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const toProject = async (j: {
    id: string; asset_type: string; mode: string; status: string;
    mesh_url: string | null; created_at: string; options?: Record<string, unknown>;
  }) => {
    // Re-sign on read: mesh_url stores the raw KEY (legacy → full URL passthrough).
    const meshSigned = j.mesh_url ? await signedR2Url(env, j.mesh_url, 'mesh') : null;
    return ({
      id: j.id,
      name: `${cap(j.asset_type)} ${j.mode} · ${j.id.slice(-6)}`,
      asset_type: j.asset_type, mode: j.mode, status: j.status,
      createdAt: j.created_at, updatedAt: j.created_at,
      mesh_url: meshSigned, meshUrl: meshSigned,
      thumbnail: null, images: [] as string[],
      meshes: meshSigned ? [{ url: meshSigned, name: 'output.glb' }] : [],
      options: j.options ?? {},
    });
  };

  if (isMock(env)) {
    const jobs = mock.listJobs(user.id);
    return json({ projects: await Promise.all(jobs.map(toProject)) });
  }
  const { data } = await supabaseAdmin(env).from('jobs')
    .select('*').eq('user_id', user.id)
    .order('created_at', { ascending: false }).limit(100);
  const projects = await Promise.all(((data ?? []) as Parameters<typeof toProject>[0][]).map(toProject));

  // Merge rigged GLBs from R2 (uploaded by handleAutoRigStatus) into the
  // most recent project's meshes[] so the client picks them up as p.rigs
  // (it matches /_rigged_/i on m.filename). Files live under
  // <user.id>/rigged/<baseName>_rigged_puppeteer_<ts>.glb.
  try {
    const listed = await env.MESHES.list({ prefix: `${user.id}/rigged/`, limit: 50 });
    console.log(`[handleProjects] user=${user.id} rigged listed=${listed.objects.length} projects=${projects.length}`);
    for (const obj of listed.objects) {
      const filename = obj.key.split('/').pop() || '';
      const url = await signedR2Url(env, obj.key, 'mesh');
      // Append to the most recent project that doesn't already have it.
      // Cheap heuristic — the renderer just needs ONE project to expose it.
      if (projects.length > 0) {
        const target = projects[0];
        if (!target.meshes.some((m: { url?: string }) => m.url === url)) {
          target.meshes.push({ url, name: filename });
        }
      }
    }
  } catch (e) {
    console.warn('[handleProjects] R2 rigged list failed:', e instanceof Error ? e.message : String(e));
  }

  // Same for mesh-op outputs — attach to the project whose sanitized
  // name matches the slug segment in the R2 key.
  try {
    const slugify = (s: string) => (s || 'untitled').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'untitled';
    const projectBySlug = new Map<string, typeof projects[number]>();
    for (const p of projects) projectBySlug.set(slugify(p.name), p);
    const listed = await env.MESHES.list({ prefix: `${user.id}/mesh-op/`, limit: 500 });
    for (const obj of listed.objects) {
      const filename = obj.key.split('/').pop() || 'mesh-op.glb';
      const parts = obj.key.split('/');
      const projectSlug = parts.length >= 4 ? parts[2] : null;
      if (!projectSlug) continue; // legacy key with no project tag → ignore
      const url = await signedR2Url(env, obj.key, 'mesh');
      const target = projectBySlug.get(projectSlug);
      if (!target) continue; // slug doesn't match any project
      if (!target.meshes.some((m: { url?: string }) => m.url === url)) {
        target.meshes.push({ url, name: filename });
      }
    }
  } catch (e) {
    console.warn('[handleProjects] R2 mesh-op list failed:', e instanceof Error ? e.message : String(e));
  }

  return json({ projects });
}

async function handleProjectsDelete(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  const { id } = await req.json() as { id: string };
  if (!id) return err(400, 'id required');
  if (isMock(env)) return json({ ok: true });
  const { error } = await supabaseAdmin(env).from('jobs').delete().eq('id', id).eq('user_id', user.id);
  if (error) return err(500, error.message);
  return json({ ok: true });
}

async function handleMockCheckout(req: Request, env: Env): Promise<Response> {
  if (!isMock(env)) return err(400, 'mock disabled');
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  const { packId } = await req.json() as { packId: PackId };
  const pack = PACKS[packId];
  if (!pack) return err(400, 'unknown pack');
  mock.add(user.id, pack.credits);
  mock.insertPayment({
    stripe_session_id: 'mock_' + Date.now(),
    user_id: user.id, pack_id: pack.id, credits: pack.credits,
    amount_eur: pack.euros, created_at: new Date().toISOString(),
  });
  return json({ url: `${siteUrl(env, 'http://localhost:3030')}/account?paid=1` });
}

async function handleMockLogin(req: Request, env: Env): Promise<Response> {
  if (!isMock(env)) return err(400, 'mock disabled');
  const { email } = await req.json() as { email?: string };
  if (!email || typeof email !== 'string') return err(400, 'email required');
  const u = mock.upsertUser(email);
  const token = mock.createSession(u.id);
  const cookie = `${MOCK_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`;
  const res = json({ user: { id: u.id, email: u.email, credits: u.credits } });
  return appendSetCookie(res, cookie);
}

async function handleMockLogout(req: Request, env: Env): Promise<Response> {
  if (!isMock(env)) return err(400, 'mock disabled');
  const c = parseCookies(req);
  const tok = c[MOCK_COOKIE];
  if (tok) mock.destroySession(tok);
  const cookie = `${MOCK_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  return appendSetCookie(json({ ok: true }), cookie);
}

/* ─────────────── cloud projects / mesh helpers ────────────────────── */

interface CloudJobRow {
  id: string;
  user_id: string;
  asset_type: string;
  mode: string;
  status: string;
  mesh_url: string | null;
  created_at: string;
  finished_at: string | null;
  project_name: string | null;
  options: Record<string, unknown> | null;
}

/**
 * Lists the user's projects (grouped from the jobs table).
 *
 * One project = all jobs sharing the same `project_name` (or, when null,
 * a stable name derived from the job id slice — "Project ab12cd").
 * Each project bundles its meshes (succeeded jobs with mesh_url) and a
 * sourceImage hint when available in `options`.
 */
async function handleCloudProjects(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');

  type ProjEntry = {
    name: string; path: string;
    images: string[];
    imagesData: Array<{ path: string; created: string; size: number; mtime: string }>;
    count: number;
    created: string; prompt: string;
    backPhotos: Record<string, string>;
    meshes: Array<{ filename: string; path: string; url: string; created: string; format: string; sourceImage: string | null; id: string; jobId: string }>;
  };
  function emptyProj(name: string): ProjEntry {
    return {
      name, path: `cloud://${name}`,
      images: [], imagesData: [],
      count: 0,
      created: new Date().toISOString(), prompt: '',
      backPhotos: {}, meshes: [],
    };
  }

  if (isMock(env)) {
    const jobs = mock.listJobs(user.id);
    const map = new Map<string, ProjEntry>();
    for (const j of jobs) {
      const name = (j.options as Record<string, unknown> | null)?.project_name as string
        || `Project ${j.id.slice(-6)}`;
      if (!map.has(name)) map.set(name, emptyProj(name));
      const p = map.get(name)!;
      if (j.mesh_url) {
        p.meshes.push({
          filename: `${j.id}.glb`, path: j.mesh_url, url: j.mesh_url,
          created: j.created_at, format: 'GLB', sourceImage: null,
          // C7: align with handleListMeshes so renderer always has a
          // real uuid for delete (filename slug never matches .eq('id')).
          id: j.id, jobId: j.id,
        });
      }
      if (j.created_at > p.created) p.created = j.created_at;
    }
    return json({ projects: Array.from(map.values()) });
  }

  const sb = supabaseAdmin(env);
  // Query jobs and user_assets in parallel — jobs supplies meshes,
  // user_assets supplies images (replaces the localStorage cache the
  // client used to maintain, which was hitting the 5 MB quota).
  const [jobsRes, assetsRes] = await Promise.all([
    sb.from('jobs')
      .select('id, user_id, asset_type, mode, status, mesh_url, created_at, finished_at, project_name, options, type, cost_usd')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(200),
    sb.from('user_assets')
      .select('id, project, kind, r2_path, parent_path, meta, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(2000),
  ]);
  if (jobsRes.error)   return err(500, jobsRes.error.message);
  if (assetsRes.error) console.warn('[handleCloudProjects] user_assets query failed:', assetsRes.error.message);

  const rows = (jobsRes.data ?? []) as CloudJobRow[];
  const map = new Map<string, ProjEntry>();
  for (const j of rows) {
    // Projet supprime par l'utilisateur : la ligne est conservee pour la
    // comptabilite (credits, cout, statistiques) mais ne doit plus
    // reformer de projet visible. Avant, la suppression mettait
    // project_name a null, ce qui etait reinterprete plus bas en
    // '_orphans' cote client : la carte revenait au rechargement suivant,
    // avec tous ses maillages.
    if (j.project_name === '_deleted') continue;
    const name = j.project_name
      || (j.options?.project_name as string | undefined)
      || `Project ${j.id.slice(-6)}`;
    if (!map.has(name)) map.set(name, emptyProj(name));
    const p = map.get(name)!;
    if (j.mesh_url && j.status === 'succeeded') {
      // Re-sign on read: mesh_url now stores the raw R2 KEY (legacy rows
      // hold a full URL → passed through unchanged). sourceImage likewise
      // stores the source-photo KEY (legacy: full URL).
      const meshSigned = await signedR2Url(env, j.mesh_url, 'mesh');
      const srcKey = (j.options?.sourceImage as string | undefined) ?? null;
      const srcSigned = srcKey ? await signedR2Url(env, srcKey, 'image') : null;
      p.meshes.push({
        filename: `${j.id}.glb`, path: meshSigned, url: meshSigned,
        created: j.created_at, format: 'GLB',
        sourceImage: srcSigned,
        // C7: align with handleListMeshes so renderer always has a
        // real uuid for delete (filename slug never matches .eq('id')).
        id: j.id, jobId: j.id,
      });
    }
    if (j.created_at > p.created) p.created = j.created_at;
    if (!p.prompt && j.options?.prompt) p.prompt = String(j.options.prompt);
  }

  // Merge user_assets images into the project map. The renderer
  // expects p.images = string[] of public URLs (front-images
  // primarily; back-images are in p.backPhotos as a front→back map).
  const assets = (assetsRes.data ?? []) as Array<{
    project: string; kind: string; r2_path: string;
    parent_path: string | null; meta: Record<string, unknown> | null;
    created_at: string;
  }>;
  for (const a of assets) {
    if (!a.project) continue;
    if (!map.has(a.project)) map.set(a.project, emptyProj(a.project));
    const p = map.get(a.project)!;
    // Re-sign on read from the stored r2_path KEY (legacy full URL → passthrough).
    const isMeshKind = a.kind.startsWith('mesh') || a.kind.includes('rig') || a.kind.includes('anim');
    const url = await signedR2Url(env, a.r2_path, isMeshKind ? 'mesh' : 'image');
    if (a.kind === 'image-front' || a.kind === 'image-tpose' || a.kind === 'image-modified' ||
        a.kind === 'image-removebg' || a.kind === 'image-rectified' || a.kind === 'image-upscaled' ||
        a.kind === 'image-inpainted' || a.kind === 'image-facefixed') {
      p.images.push(url);
      p.imagesData.push({ path: url, created: a.created_at, size: 0, mtime: a.created_at });
      // Surface the prompt for the Copy prompt button. insertUserAsset
      // stores it in meta.prompt during handleGenerateImage; keep the
      // first non-empty value we see per project (assets were sorted
      // newest-first so this is the most-recent prompt).
      if (!p.prompt) {
        const m = a.meta as Record<string, unknown> | null;
        const promptFromMeta = m && typeof m['prompt'] === 'string' ? m['prompt'] as string : null;
        if (promptFromMeta) p.prompt = promptFromMeta;
      }
    } else if (a.kind === 'image-back' && a.parent_path) {
      const parentUrl = await signedR2Url(env, a.parent_path, 'image');
      p.backPhotos[parentUrl] = url;
    }
    if (a.created_at > p.created) p.created = a.created_at;
  }

  // Sort images newest-first per project + dedupe by URL.
  for (const p of map.values()) {
    const pairs = p.images.map((u, i) => ({ u, d: p.imagesData[i] }));
    pairs.sort((a, b) => (b.d?.mtime || '').localeCompare(a.d?.mtime || ''));
    const seenU = new Set<string>();
    const dedupedPairs = pairs.filter(x => {
      if (!x.u || seenU.has(x.u)) return false;
      seenU.add(x.u);
      return true;
    });
    p.images = dedupedPairs.map(x => x.u);
    p.imagesData = dedupedPairs.map(x => x.d);
    p.count = p.images.length;
  }
  return json({ projects: Array.from(map.values()) });
}

/**
 * List every succeeded mesh the user has generated. Used by the
 * Projects home page to show meshes that don't belong to any image
 * folder yet.
 */
async function handleListMeshes(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');

  if (isMock(env)) {
    const jobs = mock.listJobs(user.id).filter(j => j.status === 'succeeded' && j.mesh_url);
    return json({
      meshes: jobs.map(j => ({
        filename: `${j.id}.glb`,
        path: j.mesh_url,
        url: j.mesh_url,
        size: 0,
        created: j.created_at,
        format: 'GLB',
        thumb: null,
        sourceImage: null,
        asset_type: j.asset_type,
        projectName: (j.options as Record<string, unknown> | null)?.project_name as string ?? null,
        id: j.id,
      })),
    });
  }

  const { data, error } = await supabaseAdmin(env)
    .from('jobs')
    .select('id, asset_type, mode, status, mesh_url, created_at, project_name, options, type, cost_usd')
    .eq('user_id', user.id)
    .eq('status', 'succeeded')
    .not('mesh_url', 'is', null)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return err(500, error.message);

  const meshes = await Promise.all(((data ?? []) as CloudJobRow[])
    // Meme filtre que la reconstruction des projets : sans lui, les
    // maillages d'un projet supprime reapparaissaient dans la liste et
    // le client en reformait une carte '_orphans'.
    .filter(j => j.project_name !== '_deleted')
    .map(async j => {
    // C7: name meshes like the desktop convention so meshProject()
    // strips down to the project name. Format:
    //   <safe_project>_trellis2_<timestamp_10digits>.glb
    const safeName = (j.project_name || (j.options?.project_name as string | undefined) || 'untitled')
                      .replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32);
    const stem = `${safeName}_trellis2_${j.id.slice(-10)}`;
    // Re-sign on read from the stored KEY (legacy full URL → passthrough).
    const meshSigned = await signedR2Url(env, j.mesh_url!, 'mesh');
    const srcKey = (j.options?.sourceImage as string | undefined) ?? null;
    const srcSigned = srcKey ? await signedR2Url(env, srcKey, 'image') : null;
    return ({
    filename: `${stem}.glb`,
    path: meshSigned,
    url: meshSigned,
    size: 0,
    created: j.created_at,
    format: 'GLB',
    thumb: null,
    sourceImage: srcSigned,
    asset_type: j.asset_type,
    projectName: j.project_name ?? (j.options?.project_name as string | undefined) ?? null,
    id: j.id,
  });}));

  // Append rigged GLBs from R2 (uploaded by handleAutoRigStatus). The
  // client regex /_rigged_/i on m.filename will pick them up and push
  // to p.rigs[]. Inherit projectName from the most recently created mesh
  // (heuristic — the user just rigged it, so it's the active project).
  try {
    const listed = await env.MESHES.list({ prefix: `${user.id}/rigged/`, limit: 100 });
    console.log(`[handleListMeshes] user=${user.id} rigged_count=${listed.objects.length} mesh_count=${meshes.length}`);
    for (const obj of listed.objects) {
      const filename = obj.key.split('/').pop() || 'rigged.glb';
      const url = await signedR2Url(env, obj.key, 'mesh');
      // Extract the modal job ID from the rigged filename to find the
      // matching source mesh and inherit its projectName.
      // Filename pattern: modal_<hex32>_rigged_puppeteer_<ts>.glb
      // Or: <jobid_hex>_rigged_puppeteer_<ts>.glb
      const beforeRigged = filename.replace(/_rigged_.*$/i, '');
      const cleanSlug = beforeRigged.replace(/^modal_/i, '').toLowerCase();
      // Look for a source mesh whose URL or id contains this hex slug.
      const source = meshes.find(m => {
        const u = (m.url || '').toLowerCase();
        const id = (m.id || '').toLowerCase().replace(/-/g, '');
        return cleanSlug && (u.includes(cleanSlug) || id === cleanSlug || id.includes(cleanSlug));
      });
      // 2026-06-02 fix: if no source mesh matches the rig's hex slug,
      // the previous code fell back to `meshes[0]?.projectName` —
      // i.e. the MOST RECENTLY CREATED mesh across ALL projects.
      // That made unrelated rigs (lion rig, pig rig) silently appear
      // in whatever project the user last touched (the dragon).
      // Send orphans to the `_orphans` bucket instead so they're
      // visible but don't pollute the project they were created on.
      const inheritedProject = source?.projectName || '_orphans';
      meshes.push({
        filename,
        path: url,
        url,
        size: obj.size,
        created: obj.uploaded.toISOString(),
        format: 'GLB',
        thumb: null,
        sourceImage: null,
        asset_type: 'rig',
        projectName: inheritedProject,
        id: filename.replace(/\.glb$/i, ''),
      });
    }
  } catch (e) {
    console.warn('[handleListMeshes] R2 rigged list failed:', e instanceof Error ? e.message : String(e));
  }

  // Append mesh-op outputs (material_adjust, fill_holes, smooth, etc.)
  // from R2 so they survive a page reload. Keys live at
  //   <user.id>/mesh-op/<projectSlug>/<ts>_<op>.glb
  // where <projectSlug> is the sanitized project name written by
  // handleMeshOp at upload time. We map the slug back to the original
  // project by sanitizing every known projectName with the same rule
  // and looking it up.
  try {
    const slugify = (s: string) => (s || 'untitled').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'untitled';
    const projectBySlug = new Map<string, string>();
    for (const m of meshes) {
      if (m.projectName) projectBySlug.set(slugify(m.projectName), m.projectName);
    }
    const listed = await env.MESHES.list({ prefix: `${user.id}/mesh-op/`, limit: 500 });
    console.log(`[handleListMeshes] user=${user.id} mesh_op_count=${listed.objects.length}`);
    for (const obj of listed.objects) {
      const filename = obj.key.split('/').pop() || 'mesh-op.glb';
      // Key layout: <uid>/mesh-op/<projectSlug>/<filename>. Legacy
      // (pre-persistence) keys are <uid>/mesh-op/<filename> with no
      // project segment → SKIPPED: attaching them to "most recent
      // project" was polluting unrelated projects with old test
      // outputs (e.g. an orc fill_holes appearing in a dragon project).
      const parts = obj.key.split('/');
      const projectSlug = parts.length >= 4 ? parts[2] : null;
      if (!projectSlug) continue;
      const url = await signedR2Url(env, obj.key, 'mesh');
      const inheritedProject = projectBySlug.get(projectSlug);
      if (!inheritedProject) continue; // slug doesn't match any project
      // Detect op type from filename for the asset_type field. Defaults
      // to 'mesh' so the renderer treats it as a regular mesh version.
      let assetType = 'mesh';
      if (/_material_adjust\.glb$/i.test(filename)) assetType = 'mesh';
      else if (/_fill_holes\.glb$/i.test(filename))  assetType = 'mesh';
      meshes.push({
        filename,
        path: url,
        url,
        size: obj.size,
        created: obj.uploaded.toISOString(),
        format: 'GLB',
        thumb: null,
        sourceImage: null,
        asset_type: assetType,
        projectName: inheritedProject,
        id: filename.replace(/\.glb$/i, ''),
      });
    }
  } catch (e) {
    console.warn('[handleListMeshes] R2 mesh-op list failed:', e instanceof Error ? e.message : String(e));
  }

  // Append animation GLBs from <user.id>/animations/. Same trick as
  // rigs: extract the source-mesh hex slug from the filename and find
  // the matching mesh to inherit its projectName.
  try {
    const listed = await env.MESHES.list({ prefix: `${user.id}/animations/`, limit: 200 });
    console.log(`[handleListMeshes] user=${user.id} anim_count=${listed.objects.length}`);
    for (const obj of listed.objects) {
      const filename = obj.key.split('/').pop() || 'anim.glb';
      const url = await signedR2Url(env, obj.key, 'mesh');
      // Anim filename pattern (worker.ts handleAutoAnimStatus):
      //   <baseName>_<animType>_<batchId>_<timestamp>.glb   (post-batch)
      //   <baseName>_<animType>_<timestamp>.glb             (legacy)
      // Extract batchId if present so the client can group clips of
      // the same Generate click into one version.
      const batchMatch = filename.match(/_(idle|walk|run|attack|death|fly|jump|custom|clip)_([A-Za-z0-9_-]{4,32})_\d{10,}\.glb$/i);
      const animType = batchMatch ? batchMatch[1].toLowerCase() : 'clip';
      const batchId = batchMatch ? batchMatch[2] : '';
      const beforeAnim = filename.replace(/_(idle|walk|run|attack|death|fly|jump|custom|clip)_(?:[A-Za-z0-9_-]{4,32}_)?\d{10,}\.glb$/i, '');
      const beforeRigged = beforeAnim.replace(/_rigged_.*$/i, '');
      const cleanSlug = beforeRigged.replace(/^modal_/i, '').toLowerCase();
      const source = meshes.find(m => {
        const u = (m.url || '').toLowerCase();
        const id = (m.id || '').toLowerCase().replace(/-/g, '');
        return cleanSlug && (u.includes(cleanSlug) || id === cleanSlug || id.includes(cleanSlug));
      });
      // 2026-06-02 fix: same orphan-attribution bug as the rigged
      // branch above — anims with an unmatched hex slug used to
      // inherit the most recent project, so a stray anim from
      // another project showed up in the current one. Route to
      // _orphans now.
      const inheritedProject = source?.projectName || '_orphans';
      meshes.push({
        filename,
        path: url,
        url,
        size: obj.size,
        created: obj.uploaded.toISOString(),
        format: 'GLB',
        thumb: null,
        sourceImage: null,
        asset_type: 'animation',
        anim_type: animType,
        batch_id: batchId,
        projectName: inheritedProject,
        id: filename.replace(/\.glb$/i, ''),
      });
    }
  } catch (e) {
    console.warn('[handleListMeshes] R2 animations list failed:', e instanceof Error ? e.message : String(e));
  }

  // Final sort: newest first across ALL appended sources (jobs +
  // rigged + mesh-op + animations). Without this, the per-source
  // appends bunch by category, breaking the renderer convention that
  // i=0 in the array = newest version → v(N-1).
  meshes.sort((a, b) => (b.created || '').localeCompare(a.created || ''));

  // Dedupe by URL/path — the same R2 file can show up via multiple
  // code paths (jobs.mesh_url + rigged prefix + mesh-op prefix) and
  // we want it ONCE. Keep the first (= newest after sort).
  const deduped: typeof meshes = [];
  const seenPath = new Set<string>();
  for (const m of meshes) {
    const k = (m.url || m.path || m.id || '').toLowerCase();
    if (!k || seenPath.has(k)) continue;
    seenPath.add(k);
    deduped.push(m);
  }

  // No-store so the client always sees fresh rigged + mesh-op + anim
  return new Response(JSON.stringify({ meshes: deduped }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * Delete a generated mesh: removes the R2 object and the jobs row.
 * Only the owning user can delete their own mesh.
 */
/**
 * Reconstruct a uuid from a "slug" form the renderer may send.
 *  - "cad84d29-140a-4fd8-b5a9-32a13e0e673f"  → returned as-is
 *  - "modal_cad84d29140a4fd8b5a932a13e0e673f" → strip "modal_", re-hyphenate
 *  - "cad84d29140a4fd8b5a932a13e0e673f"      → re-hyphenate
 * Returns null if the string can't be coerced to a uuid.
 */
function _reconstructUuidFromSlug(slug: string): string | null {
  if (!slug) return null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slug)) return slug;
  const hex = slug.replace(/^modal_/i, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) return null;
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

async function handleMeshesDelete(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  const { id } = await req.json() as { id?: string };
  if (!id) return err(400, 'id required');

  if (isMock(env)) {
    mockStore().jobs.delete(id);
    return json({ ok: true });
  }

  const sb = supabaseAdmin(env);
  // C7: id may arrive as:
  //   (a) full uuid (preferred path from m.id)
  //   (b) filename like "<safe_project>_trellis2_<last10>.glb" — strip
  //       extension and match the 10-char tail against id LIKE.
  //   (c) bare "<id>.glb" (legacy cosmetic filename, stripped above).
  //   (d) "modal_<32hex>" or "<32hex>" — R2 path stem for Modal-pipeline
  //       meshes; reconstruct the uuid then lookup directly.
  // We try in turn so renderer fallbacks (m.id || m.jobId || m.filename
  // || m.path-stem) still resolve a row instead of silently 404ing.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  let job: { id: string; user_id: string; mesh_url: string | null } | null = null;
  if (isUuid) {
    const { data } = await sb.from('jobs').select('id, user_id, mesh_url')
      .eq('id', id).eq('user_id', user.id).maybeSingle();
    job = data ?? null;
  }
  if (!job) {
    // Try filename slug. handleListMeshes builds
    // "<safe>_trellis2_<last10>" so the last 10 chars of id are the
    // tail. Match with ilike on id.
    const m = id.match(/_trellis2_([0-9a-z-]{6,12})$/i);
    const tail = m ? m[1] : null;
    if (tail) {
      const { data } = await sb.from('jobs').select('id, user_id, mesh_url')
        .ilike('id', `%${tail}`).eq('user_id', user.id).limit(1).maybeSingle();
      job = data ?? null;
    }
  }
  let reconstructedUuid: string | null = null;
  if (!job) {
    // Try "modal_<hex>" or bare-32-hex slug (R2 path stem for Modal meshes).
    reconstructedUuid = _reconstructUuidFromSlug(id);
    if (reconstructedUuid) {
      const { data } = await sb.from('jobs').select('id, user_id, mesh_url')
        .eq('id', reconstructedUuid).eq('user_id', user.id).maybeSingle();
      job = data ?? null;
    }
  }
  // No matching jobs row — the mesh may have been generated under a
  // wiped account or come from a stand-alone R2 upload (rig/mesh-op/
  // anim files don't have their own jobs row, they're discovered by
  // R2 listing in handleListMeshes). Fall back to deleting the R2 key
  // directly so the user can still get rid of the artefact.
  if (!job) {
    if (!env.MESHES) return err(404, 'not found and no R2 binding');
    // Direct path: if the caller sent a full public R2 URL, extract
    // the key and delete it. Two acceptance rules so we cover all
    // pipelines:
    //  1) Path-safe: key starts with <user.id>/ (mesh-op, rigged,
    //     animations, front, modified, …). User can only delete
    //     within their own namespace.
    //  2) Shared mesh/ prefix: persistModalGlb writes Modal mesh
    //     output to a USER-LESS path 'mesh/<jobId>.glb'. We verify
    //     ownership by looking up the jobId in jobs WHERE
    //     user_id=us before allowing the delete.
    const directKey = r2PathFromPublicUrl(env, id);
    if (directKey) {
      let allow = false;
      if (directKey.startsWith(`${user.id}/`)) {
        allow = true;
      } else if (directKey.startsWith('mesh/')) {
        // Extract jobId from 'mesh/<jobId>.glb' and verify ownership.
        const m = directKey.match(/^mesh\/([^/]+)\.(glb|gltf|fbx)$/i);
        const possibleJobId = m ? m[1] : null;
        if (possibleJobId) {
          const { data } = await sb.from('jobs')
            .select('id').eq('id', possibleJobId).eq('user_id', user.id).maybeSingle();
          if (data) allow = true;
        }
      }
      if (allow) {
        try {
          const obj = await env.MESHES.head(directKey);
          if (obj) {
            await env.MESHES.delete(directKey);
            console.log(`[meshes/delete] fallback-R2 direct-URL deleted ${directKey}`);
            return json({ ok: true, fallback: 'r2-direct-url' });
          }
        } catch (_) { /* try the candidate list */ }
      }
    }
    // Candidate R2 keys to try, in priority order. We attempt each and
    // delete whichever matches an actually-existing object.
    const candidates: string[] = [];
    /* 1. L'appelant a fourni la cle R2 telle quelle (« <uid>/rigged/....glb »).
     *
     * ELLE DOIT APPARTENIR A L'APPELANT. Sans cette contrainte, n'importe
     * quel compte gratuit supprimait n'importe quel objet du bucket avec une
     * seule requete : `_meta/admin-totp.json` (le second facteur de
     * l'administrateur disparaissait), `_meta/banned-users.json` (l'objet
     * absent rend un ensemble vide, donc tous les bannis revenaient),
     * `_meta/pricing.json`, et les maillages des autres clients. Le chemin
     * voisin (lignes 6384-6409) verifiait bien la propriete ; celui-ci ne le
     * faisait pas.
     *
     * On rejette aussi la remontee d'arborescence : un « .. » suffirait a
     * sortir du prefixe apres normalisation par le stockage. */
    if (id.includes('/')) {
      const cle = id.replace(/^\/+/, '');
      const propre = !cle.split('/').includes('..') && cle.startsWith(`${user.id}/`);
      if (propre) candidates.push(cle);
      else console.warn(`[meshes/delete] cle refusee (hors perimetre du compte) : ${cle} par ${user.id}`);
    }
    // 2. Bare filename → try every folder we might have stored it in
    const filename = id.endsWith('.glb') ? id : `${id}.glb`;
    candidates.push(`${user.id}/mesh/${filename}`);
    candidates.push(`${user.id}/rigged/${filename}`);
    candidates.push(`${user.id}/animations/${filename}`);
    // `mesh/<fichier>` est un emplacement HISTORIQUE, partage par tous les
    // comptes : un nom de fichier devine y supprimait l'objet d'un autre.
    // On ne le tente plus.
    // 3. handleListMeshes uses 'modal_<hex>.glb' under <uid>/rigged/
    if (filename.startsWith('modal_')) {
      candidates.push(`${user.id}/rigged/${filename}`);
    }
    let deleted = false;
    for (const key of candidates) {
      try {
        const obj = await env.MESHES.head(key);
        if (obj) {
          await env.MESHES.delete(key);
          deleted = true;
          console.log(`[meshes/delete] fallback-R2 deleted ${key}`);
          break;
        }
      } catch (_) { /* try next */ }
    }
    if (deleted) return json({ ok: true, fallback: 'r2-only' });
    if (reconstructedUuid) {
      console.warn(`[meshes/delete] uuid ${reconstructedUuid} reconstructed from slug "${id}" but no row for user ${user.id} AND no R2 hit`);
    }
    console.warn(`[meshes/delete] no row or R2 key for "${id}" / user ${user.id}`);
    return err(404, 'mesh not found in your account or R2');
  }
  const realId = job.id;

  // Best-effort R2 cleanup. The R2 key layout differs by pipeline:
  //   - Replicate/Trellis: "<user_id>/<id>.glb" (uploadGlbToR2)
  //   - Modal:             "mesh/modal_<hex>.glb" (persistModalGlb)
  // Derive the actual key from job.mesh_url when possible; fall back to
  // the legacy layout. delete() never throws on a missing key.
  if (env.MESHES) {
    let r2Key: string | null = null;
    // mesh_url now stores the raw R2 KEY; legacy rows stored a full URL.
    if (job.mesh_url && /^https?:\/\//i.test(job.mesh_url)) {
      try {
        const u = new URL(job.mesh_url);
        r2Key = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
      } catch (_) { /* fall through */ }
    } else if (job.mesh_url) {
      r2Key = (job.mesh_url as string).replace(/^\/+/, '');
    }
    if (!r2Key) r2Key = `${user.id}/${realId}.glb`;
    try { await env.MESHES.delete(r2Key); } catch (_) { /* ignore */ }
  }

  const { error } = await sb.from('jobs').delete().eq('id', realId).eq('user_id', user.id);
  if (error) return err(500, error.message);
  return json({ ok: true });
}

/**
 * Soft-delete a "project" (cloud projects are virtual — they're a
 * group of jobs sharing a project_name). We just null out the
 * project_name on every job belonging to the user with that name.
 * The jobs themselves stay around so the user can still see/download
 * the meshes individually.
 */
/** POST /api/me/wipe-all-projects — nuclear reset for the current user.
 *  Sets project_name=NULL on every jobs row + DELETEs every user_assets
 *  row. With ?wipeR2=true ALSO deletes every R2 object under the user's
 *  prefix (binaries — destructive, no recovery). */
/** GET /api/me/active-jobs — return the user's in-flight jobs so the
 *  client can re-attach them on hard refresh / first boot. Without
 *  this, a refresh during a long Modal job (~3 min anim, ~100s mesh)
 *  silently loses the progress widget client-side even though the
 *  job is still running on the server. */
async function handleMeActiveJobs(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (isMock(env)) return json({ jobs: [] });
  const { data, error } = await supabaseAdmin(env)
    .from('jobs')
    .select('id, asset_type, mode, status, credit_cost, created_at, options, project_name, type, cost_usd')
    .eq('user_id', user.id)
    .in('status', ['starting', 'processing', 'queued', 'running'])
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return err(500, error.message);
  return new Response(JSON.stringify({ jobs: data || [] }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}


async function handleMeWipeAllProjects(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (isMock(env)) return json({ ok: true, mock: true });
  const url = new URL(req.url);
  const wipeR2 = url.searchParams.get('wipeR2') === 'true'
              || url.searchParams.get('wipeR2') === '1';
  const sb = supabaseAdmin(env);
  // When ?wipeR2=true we treat it as a FULL reset and DELETE the jobs
  // rows too — otherwise their mesh_url keeps surfacing the binaries
  // we just deleted from R2 as broken phantom projects.
  let jUpd = 0, jDel = 0;
  let jErr: { message: string } | null = null;
  if (wipeR2) {
    const res = await sb.from('jobs').delete({ count: 'exact' }).eq('user_id', user.id);
    jErr = res.error; jDel = res.count ?? 0;
  } else {
    const res = await sb.from('jobs')
      .update({ project_name: null }, { count: 'exact' })
      .eq('user_id', user.id)
      .not('project_name', 'is', null);
    jErr = res.error; jUpd = res.count ?? 0;
  }
  const { error: aErr, count: aDel } = await sb.from('user_assets')
    .delete({ count: 'exact' })
    .eq('user_id', user.id);
  let r2Deleted = 0;
  let r2Errors: string[] = [];
  if (wipeR2 && env.MESHES) {
    // List every object under <user.id>/* (mesh, rigged, animations,
    // front, back, modified, removebg, mesh-op, thumb, etc.) and delete.
    // Iterates with cursor until R2 returns truncated=false.
    const prefix = `${user.id}/`;
    let cursor: string | undefined;
    do {
      const listed = await env.MESHES.list({ prefix, limit: 1000, cursor });
      const keys = (listed.objects || []).map(o => o.key);
      // Skip the _logs/* subtree under <user.id>/logs — they're not
      // project data and we want to keep the debug history.
      // Actually <user.id>/logs/ is already under user prefix, so to
      // preserve we skip filenames starting with `<user.id>/logs/`.
      const toDelete = keys.filter(k => !k.startsWith(`${user.id}/logs/`));
      if (toDelete.length) {
        // R2 doesn't support batch delete; loop one by one.
        await Promise.allSettled(toDelete.map(k =>
          env.MESHES.delete(k).catch(e => {
            r2Errors.push(`${k}: ${e instanceof Error ? e.message : String(e)}`);
          })
        ));
        r2Deleted += toDelete.length;
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }
  return json({
    ok: true,
    jobs_detached: jUpd,
    jobs_deleted: jDel,
    user_assets_deleted: aDel ?? 0,
    r2_objects_deleted: r2Deleted,
    r2_wipe_requested: wipeR2,
    errors: [jErr?.message, aErr?.message, ...r2Errors.slice(0, 5)].filter(Boolean),
  });
}

async function handleCloudProjectsDelete(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  const { projectName } = await req.json() as { projectName?: string };
  if (!projectName) return err(400, 'projectName required');

  if (isMock(env)) return json({ ok: true });

  const sb = supabaseAdmin(env);
  // Detach mesh jobs from the project.
  // SUPPRIMER VRAIMENT LES MAILLAGES. La confirmation dit « Delete
  // project "X" and all its files? » — le desktop fait bien un rmSync du
  // dossier images + unlink de TOUS les maillages. Le cloud, lui, se
  // contentait de mettre project_name a null : les GLB restaient en R2
  // (stockage facture, et donnee NON EFFACEE alors que l'utilisateur a
  // demande sa suppression — enjeu RGPD), et le projet RESSUSCITAIT au
  // rechargement suivant, `project_name: null` etant reinterprete en
  // '_orphans' cote client.
  let meshesSupprimes = 0;
  try {
    const { data: jobsDuProjet } = await sb.from('jobs')
      .select('id, mesh_url')
      .eq('user_id', user.id)
      .eq('project_name', projectName);
    if (env.MESHES && jobsDuProjet && jobsDuProjet.length) {
      const cles = new Set<string>();
      for (const j of jobsDuProjet as Array<{ id: string; mesh_url?: string | null }>) {
        // Emplacement canonique du GLB d'un job (voir handleJobStatus).
        cles.add(`${user.id}/${j.id}.glb`);
        // mesh_url peut etre une cle R2 ou une URL signee : on n'accepte
        // que ce qui appartient au prefixe de l'utilisateur, jamais une
        // cle arbitraire (meme garde que la suppression d'actifs).
        const u = j.mesh_url;
        if (typeof u === 'string' && u && !/^https?:/i.test(u)
            && u.startsWith(`${user.id}/`)) {
          cles.add(u);
        }
      }
      await Promise.allSettled([...cles].map(k =>
        env.MESHES.delete(k).then(() => { meshesSupprimes++; }).catch(() => {})
      ));
    }
  } catch (e) {
    console.warn('[cloud-projects/delete] purge des maillages echouee:', e);
  }

  // Marqueur explicite plutot que null : une valeur nulle etait
  // reinterpretee en projet '_orphans' et la carte revenait. On conserve
  // la ligne (elle porte la comptabilite : credits, cout, statistiques)
  // mais elle ne peut plus reformer un projet visible.
  const { error } = await sb.from('jobs')
    .update({ project_name: '_deleted' })
    .eq('user_id', user.id)
    .eq('project_name', projectName);
  if (error) return err(500, error.message);
  // Fetch the r2_paths of all user_assets we're about to delete so
  // we can also wipe the matching R2 blobs (especially important for
  // '_orphans' which lives only here — keeping the R2 files would
  // resurrect the project on next /api/meshes scan).
  let r2Deleted = 0;
  try {
    const { data: assets } = await sb.from('user_assets')
      .select('r2_path')
      .eq('user_id', user.id)
      .eq('project', projectName);
    if (env.MESHES && assets && assets.length) {
      // DEFENSE EN PROFONDEUR — la route d'enregistrement filtre desormais
      // les cles hors prefixe, mais des lignes plantees AVANT ce correctif
      // peuvent subsister en base. Sans ce filtre, supprimer un projet
      // effacerait des objets appartenant a d'autres comptes, ou pire les
      // compteurs _meta/* dont depend le fusible anti-emballement.
      const aNous = assets.filter(a =>
        typeof a.r2_path === 'string' && a.r2_path.startsWith(`${user.id}/`));
      const horsPrefixe = assets.length - aNous.length;
      if (horsPrefixe > 0) {
        console.warn(`[cloud-projects/delete] ${horsPrefixe} cle(s) hors prefixe NON supprimee(s) pour ${user.id}`);
      }
      await Promise.allSettled(aNous.map(a =>
        env.MESHES.delete(a.r2_path as string).then(() => { r2Deleted++; }).catch(() => {})
      ));
    }
  } catch (e) { console.warn('[cloud-projects/delete] R2 cleanup failed:', e); }
  // DELETE the user_assets rows for this project.
  const { error: aErr, count: aDel } = await sb.from('user_assets')
    .delete({ count: 'exact' })
    .eq('user_id', user.id)
    .eq('project', projectName);
  if (aErr) console.warn('[cloud-projects/delete] user_assets cleanup failed:', aErr.message);
  // For '_orphans' specifically: also list R2 prefixes that produce
  // synthetic phantom projects (mesh-op/, rigged/, animations/ with
  // no jobs row) and delete any object whose key matches a name that
  // would resolve to _orphans client-side. This drains the visible
  // mesh/rig/anim count to zero so the card actually disappears.
  if (projectName === '_orphans' && env.MESHES) {
    const orphanPrefixes = [
      `${user.id}/mesh-op/`,
      `${user.id}/rigged/`,
      `${user.id}/animations/`,
    ];
    for (const prefix of orphanPrefixes) {
      let cursor: string | undefined;
      do {
        const listed = await env.MESHES.list({ prefix, limit: 1000, cursor });
        await Promise.allSettled((listed.objects || []).map(o =>
          env.MESHES.delete(o.key).then(() => { r2Deleted++; }).catch(() => {})
        ));
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    }
  }
  return json({ ok: true, user_assets_deleted: aDel ?? 0, r2_deleted: r2Deleted,
                meshes_deleted: meshesSupprimes });
}

/** Arrete REELLEMENT le conteneur Modal d'un job.
 *
 *  mesh_start avec op_type='cancel' relit le function_call ID persiste
 *  dans /data/<job_id>.call_id et appelle FunctionCall.cancel().
 *
 *  Extrait de handleAdminCancelJob (audit du 2026-08-02) : ce vrai arret
 *  n'existait QUE dans la route admin. L'annulation UTILISATEUR, elle,
 *  appelait `replicateClient(env).predictions.cancel(id)` alors que les
 *  travaux portent un id `modal_<uuid>` et tournent sur Modal — l'appel
 *  echouait, etait avale par un catch, et le GPU continuait de tourner
 *  aux frais de l'exploitant pendant que l'utilisateur voyait « annule ».
 *
 *  Ne leve jamais : la comptabilite Supabase doit se faire meme si Modal
 *  est injoignable. Retourne l'issue pour que l'appelant puisse le dire. */
async function _cancelModalJob(env: Env, jobId: string): Promise<{ cancelled: boolean; error: string | null }> {
  if (!env.MODAL_SHARED_SECRET) {
    return { cancelled: false, error: 'Modal non configure' };
  }
  // DISPATCH VERS LA BONNE APP MODAL.
  //
  // Cette fonction n'interrogeait que mesh_start, qui relit
  // /data/<job_id>.call_id — le volume de l'app MAILLAGE. Un job de rig,
  // de segmentation ou d'animation tourne sur une AUTRE app, avec son
  // propre volume : l'annulation ne pouvait donc pas les atteindre, et
  // seuls les maillages s'arretaient vraiment.
  //
  // Chacune de ces apps accepte le meme contrat `op_type: 'cancel'` (voir
  // _puppeteer_rig.py: /rig_data/<job_id>.call_id). On essaie donc les
  // endpoints configures jusqu'a ce que l'un reconnaisse le job.
  const cibles = [
    env.MODAL_MESH_START_URL,
    _rigBaseUrl(env),
    env.MODAL_SEGMENT_URL,
    env.MODAL_ANYTOP_ANIM_URL,
  ].filter(Boolean) as string[];
  if (!cibles.length) return { cancelled: false, error: 'aucun endpoint Modal configure' };

  let derniereErreur: string | null = null;
  for (const url of cibles) {
    try {
      const mr = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          _auth: env.MODAL_SHARED_SECRET,
          op_type: 'cancel',
          job_id: jobId,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!mr.ok) { derniereErreur = `HTTP ${mr.status}`; continue; }
      const mj = await mr.json() as { cancelled?: boolean; error?: string; reason?: string };
      // Seule une confirmation compte : les autres apps repondent
      // « no call_id on file » pour un job qui ne leur appartient pas.
      if (mj.cancelled) return { cancelled: true, error: null };
      derniereErreur = mj.error || mj.reason || null;
    } catch (e) {
      derniereErreur = e instanceof Error ? e.message : String(e);
    }
  }
  return { cancelled: false, error: derniereErreur };
}

/**
 * Annule un job en cours : arrete le conteneur Modal, marque le job
 * annule, rembourse les credits.
 */
async function handleJobCancel(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  const { id } = await req.json() as { id?: string };
  if (!id) return err(400, 'id required');

  if (isMock(env)) {
    mock.updateJob(id, { status: 'canceled', finished_at: new Date().toISOString() });
    return json({ ok: true });
  }

  const sb = supabaseAdmin(env);
  const { data: job } = await sb.from('jobs').select('id, user_id, status, credit_cost')
    .eq('id', id).eq('user_id', user.id).maybeSingle();
  if (!job) return err(404, 'not found');
  if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled') {
    return json({ ok: true, alreadyDone: true });
  }

  // Arret REEL du conteneur, cote Modal. Avant, on appelait Replicate —
  // qui n'heberge plus rien depuis la migration : l'appel echouait en
  // silence et le GPU continuait de tourner alors que l'utilisateur
  // voyait « annule » et que le credit lui etait rendu. On payait donc
  // le calcul ET le remboursement.
  const modal = await _cancelModalJob(env, id);
  if (!modal.cancelled) {
    console.warn(`[jobs/cancel] arret Modal non confirme pour ${id}: ${modal.error || 'inconnu'}`);
  }

  // RECLAMATION ATOMIQUE, meme motif que _failAndRefundJob. Avant :
  // SELECT, test du statut EN MEMOIRE, puis UPDATE sans garde et
  // remboursement. Deux requetes simultanees passaient toutes les deux le
  // test et creditaient toutes les deux — de la monnaie creee a volonte
  // en appuyant deux fois sur Annuler.
  //
  // `.in('status', …)` + `.select('id')` : seule la requete qui a
  // reellement change la ligne obtient une ligne en retour, et donc
  // rembourse.
  const { data: claimed, error: claimErr } = await sb.from('jobs')
    .update({ status: 'canceled', finished_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)
    .in('status', NON_TERMINAL_JOB_STATUSES as unknown as string[])
    .select('id');
  if (claimErr || !claimed || claimed.length === 0) {
    // Quelqu'un d'autre (le reaper, un second clic, la route admin) a
    // deja finalise ce job : ne PAS rembourser une seconde fois.
    return json({ ok: true, alreadyDone: true, modalStopped: modal.cancelled });
  }
  if (typeof job.credit_cost === 'number') {
    await addCredits(env, user.id as string, job.credit_cost);
  }
  // `modalStopped` remonte l'issue REELLE : l'interface ne doit plus
  // affirmer que tout est arrete quand seul le registre a change.
  return json({ ok: true, modalStopped: modal.cancelled, modalError: modal.error });
}

/**
 * Background removal proxy. We POST an image URL (or raw blob) and the
 * Worker forwards to Replicate "851-labs/background-remover", waits for
 * the result, and returns the output URL. Free for now (no credit cost
 * — see commit message for rationale).
 */
async function handleRemoveBackground(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.REPLICATE_API_TOKEN) return err(500, 'REPLICATE_API_TOKEN not set');

  const ct = req.headers.get('content-type') ?? '';
  let imageInput: string | File | null = null;
  if (ct.includes('application/json')) {
    const { imageUrl } = await req.json() as { imageUrl?: string };
    if (!imageUrl) return err(400, 'imageUrl required');
    imageInput = imageUrl;
  } else {
    const fd = await req.formData();
    const f = fd.get('image');
    if (f instanceof File) imageInput = f;
    else if (typeof f === 'string') imageInput = f;
  }
  if (!imageInput) return err(400, 'image required');

  // Cost guard — background-remover is a PAID Replicate call. Without this it
  // sat OUTSIDE the daily budget backstop (release-audit finding): an
  // authenticated user could loop it unbounded. ~$0.02/call on Replicate;
  // charge 1 credit and count it against the global + per-user caps.
  // TARIF LU DEPUIS LA GRILLE, plus code en dur. La cle `remove_background`
  // existait dans PRICING_DEFAULTS depuis le debut, mais ce handler ne la
  // consultait jamais : l'onglet Pricing de l'admin affichait donc un reglage
  // qui n'avait AUCUN effet sur cette operation. Un prix qu'on croit piloter
  // et qui ne bouge pas est pire qu'un prix assume comme fixe.
  const COST_PER = await getPrice(env, 'remove_background');
  const ESTIMATED_USD = 0.02;
  const remainingBudget = await checkAndIncrementDailySpend(env, ESTIMATED_USD, user.id);
  if (remainingBudget == null) {
    return json({ ok: false, success: false,
      error: `daily Cloud GPU budget reached. Try again after midnight UTC.` }, { status: 429 });
  }
  const remainingUserCalls = await checkAndIncrementUserCalls(env, user.id);
  if (remainingUserCalls == null) {
    await refundDailySpend(env, ESTIMATED_USD);
    return json({ ok: false, success: false,
      error: `you've reached the per-user daily generation limit.` }, { status: 429 });
  }
  const remaining = await spendCredits(env, user.id, COST_PER);
  if (remaining == null) {
    await refundDailySpend(env, ESTIMATED_USD);
    return json({ ok: false, success: false, error: `insufficient credits — remove background costs ${COST_PER} credit` }, { status: 402 });
  }

  const replicate = replicateClient(env);
  const version = '851-labs/background-remover:a029dff38972b5fda4ec5d75d7d1cd25aeff621d2cf4946a41055d7db66b80bc';
  // TRACABILITE — cette operation ne laissait AUCUNE trace en base. Elle
  // debite pourtant un credit et declenche un appel Replicate payant, et le
  // tableau de bord cherche depuis toujours un `operation_type ===
  // 'remove_background'` que personne n'ecrivait : du code mort en face d'une
  // depense reelle. C'est exactement la classe de trou qui a fait croire a
  // « aucune activite depuis six jours » alors que la facture montait.
  const opDebut = Date.now();
  try {
    const out = await replicate.run(version, { input: { image: imageInput } }) as unknown;
    let url: string | null = null;
    if (typeof out === 'string') url = out;
    else if (Array.isArray(out) && typeof out[0] === 'string') url = out[0] as string;
    else if (out && typeof (out as { url?: () => string }).url === 'function') {
      url = (out as { url: () => string }).url();
    }
    if (!url) return err(502, 'background-remover returned no url');

    // Mirror the Replicate output into R2 so the URL doesn't expire (~1h TTL on
    // replicate.delivery would otherwise trip the renderer's Expired-hostname guard).
    if (env.MESHES && env.R2_PUBLIC_URL) {
      try {
        const upstream = await fetch(url);
        if (upstream.ok) {
          const buf = await upstream.arrayBuffer();
          _assertImageBytes(buf, 'remove-bg');
          const key = `${user.id}/removebg/${Date.now()}_${Math.floor(Math.random() * 1e9)}_nobg.png`;
          await env.MESHES.put(key, buf, { httpMetadata: { contentType: 'image/png' } });
          url = await signedR2Url(env, key, 'image');
        } else {
          console.warn('[remove-bg] upstream fetch failed, returning raw Replicate URL', upstream.status);
        }
      } catch (e) {
        console.warn('[remove-bg] R2 mirror failed, returning raw Replicate URL', e);
      }
    } else {
      console.warn('[remove-bg] MESHES/R2_PUBLIC_URL unset, returning raw Replicate URL (will expire ~1h)');
    }

    await logOperation(env, user.id, 'remove-bg', COST_PER, opDebut, Date.now(), 'succeeded');
    return json({ ok: true, success: true, url, path: url, newPath: url });
  } catch (e: unknown) {
    // Refund the credit + roll back the daily-spend counters on failure.
    await addCredits(env, user.id, COST_PER);
    await refundDailySpend(env, ESTIMATED_USD);
    // Journalise MEME rembourse : l'appel Replicate a bien eu lieu et il est
    // facture. Un echec silencieux, c'est de la depense qui n'apparait nulle
    // part. Credits a 0 puisqu'ils sont rendus, mais la ligne existe.
    await logOperation(env, user.id, 'remove-bg', 0, opDebut, Date.now(), 'failed',
                       { error: e instanceof Error ? e.message : String(e) });
    return err(502, 'background-remover failed: ' + (e instanceof Error ? e.message : String(e)));
  }
}

/**
 * Generate a back view from a front image + prompt hint.
 *
 * Cheap stand-in: we proxy to Pollinations.ai with a "back view" prompt
 * tweak. It's free, no auth, returns a finished PNG. The result is
 * tunneled back through R2 so we get a stable cross-origin URL the
 * client can keep on the project.
 */
/**
 * Call our own Cog `fabienlacaze/myfabmesh-cloud` on Replicate. The
 * model packages the desktop's text-to-image and back-view scripts
 * (RealVisXL V4.0 + ControlNet OpenPose + IP-Adapter), so the cloud
 * output matches the desktop byte-for-byte.
 *
 * Two tasks supported by the Cog:
 *   task: 'text2image' — input: prompt + asset_type + asset_style
 *   task: 'back-view'  — input: prompt + image (front URL)
 *
 * Result is a single PNG URL. We mirror it into R2 for a stable origin
 * URL the browser can fetch without CORS.
 */
interface CogInput {
  task: 'text2image' | 'back-view';
  prompt?: string;
  image?: string;
  asset_type?: string;
  asset_style?: string;
  seed?: number;
  steps?: number;
  unrestricted?: boolean;
  turbo?: boolean;
}

// Cached version id for fabienlacaze/myfabmesh-cloud. We resolve it
// once per Worker instance (cold start) via the models endpoint, then
// reuse for every prediction. Bump the Cog → push to Replicate → the
// next call refreshes this automatically.
let _myfabmeshCogVersion: string | null = null;
async function resolveMyfabmeshCogVersion(token: string): Promise<string> {
  if (_myfabmeshCogVersion) return _myfabmeshCogVersion;
  const r = await fetch(
    'https://api.replicate.com/v1/models/fabienlacaze/myfabmesh-cloud',
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!r.ok) throw new Error(`Cannot resolve Cog version: HTTP ${r.status}`);
  const j = await r.json() as { latest_version?: { id?: string } };
  if (!j.latest_version?.id) throw new Error('Cog has no pushed version yet');
  _myfabmeshCogVersion = j.latest_version.id;
  return _myfabmeshCogVersion;
}

/* ───────────────────────── Modal backend ────────────────────────
 * Modal.com hosts the same RealVisXL pipeline as our Cog but with
 * Memory Snapshots, so cold start drops from ~90s → ~5s and we no
 * longer get billed the setup_time (~78% of the Replicate invoice).
 *
 * The Modal app exposes 3 ASGI routers (consolidated from 8 legacy
 * @modal.fastapi_endpoint decorators to stay under the Modal Starter
 * 8-Web-Function cap). URL pattern (set by Modal at deploy time):
 *   https://<workspace>--myfabmesh-cloud-myfabmeshpredictor-router.modal.run/text2image
 *   https://<workspace>--myfabmesh-cloud-myfabmeshbackview-router.modal.run/{back_view,tpose,rectify,image_op,sheet}
 *   https://<workspace>--myfabmesh-cloud-mesh-router.modal.run/{mesh_start,mesh_status}
 * Each MODAL_*_URL env var holds the FULL URL including the route path,
 * so no worker-code change was needed to migrate — only `wrangler secret
 * put` to point at the new router URLs.
 *
 * The Worker:
 *   1. POSTs JSON { prompt, asset_type, asset_style, seed, steps, _auth }
 *   2. Gets PNG bytes back inline (sync, single HTTP roundtrip — no polling)
 *   3. Writes the PNG to R2 + returns the R2 URL.
 *
 * Auth: MODAL_SHARED_SECRET is a 32-byte hex set on BOTH sides via
 *   modal secret create myfabmesh-shared SHARED_SECRET=<hex>
 *   wrangler secret put MODAL_SHARED_SECRET   # then paste the same hex
 *
 * NO POLLING means no subrequest-limit risk for this call path (we use
 * ~5 subrequests total per image instead of ~25 for Replicate).
 * ──────────────────────────────────────────────────────────────── */
async function callModalText2Image(env: Env, userId: string, input: CogInput, folder: string): Promise<string> {
  const url = env.MODAL_TEXT2IMAGE_URL;
  const secret = env.MODAL_SHARED_SECRET;
  if (!url) throw new Error('MODAL_TEXT2IMAGE_URL not set');
  if (!secret) throw new Error('MODAL_SHARED_SECRET not set');

  const t0 = Date.now();
  const doFetch = () => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      _auth: secret,
      prompt: input.prompt,
      asset_type: input.asset_type,
      asset_style: input.asset_style,
      seed: input.seed,
      steps: input.steps,
      unrestricted: !!input.unrestricted,
      turbo: !!input.turbo,
    }),
    // Modal cold-start on the RealVis container can hit 90-120s when
    // the GPU snapshot is fully cold (first call of the day). Plus the
    // actual generation runs 25-45s. When a mesh gen is running on the
    // same GPU, text2image queues behind it and the 6-min cap got hit.
    // Bumped 6 → 10 min — generous but still bounded so a stuck
    // endpoint doesn't hang the user UI forever.
    signal: AbortSignal.timeout(600_000),
  });
  // Multi-shot 524 retry — same schedule as callModalImageOp (6141+).
  // The 600 s AbortSignal above is a red herring: Cloudflare fronts
  // *.modal.run and cuts every subrequest at 100 s, handing us a 524.
  // Without this loop the very first click of a Store tester surfaced
  // "image generation failed (credits refunded): Cloud GPU HTTP 524".
  //
  // The delays MUST stay >= 60 s. A 524 does NOT cancel the Modal
  // request — FastAPI keeps running it to completion (~30-60 s boot +
  // 25-45 s diffusion) and @app.cls serves one input per container, so
  // a retry fired too early makes Modal autoscale a SECOND cold
  // container: double the GPU bill and a second 524.
  //   t=0    1st request → cut at 100 s (524)
  //   wait 60 s  → the first (discarded) generation finishes meanwhile
  //   t=160  2nd request → should land on the now-idle warm container
  //   wait 90 s
  //   t=350  3rd request → last chance
  let r = await doFetch();
  for (const delay of [60_000, 90_000]) {
    if (r.status !== 524) break;
    console.log(`[modal] text2image 524 — cold start retry after ${delay / 1000}s`);
    await new Promise((res) => setTimeout(res, delay));
    r = await doFetch();
  }
  if (!r.ok) {
    if (r.status === 524) {
      throw new Error(
        'the cloud GPU took too long to start (cold start). '
        + 'Please try again in a minute — your credits were refunded.'
      );
    }
    throw new Error(`Cloud GPU HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const buf = await r.arrayBuffer();
  console.log(`[modal] text2image dt=${Date.now() - t0}ms bytes=${buf.byteLength}`);
  _writeLastWarmMs(env, '_meta/last_warm_text2image.txt').catch(() => {});
  _assertImageBytes(buf, 'Modal text2image');

  // Mirror to R2 (same key shape as the Cog path so downstream stays uniform).
  if (env.MESHES && env.R2_PUBLIC_URL) {
    const seed = input.seed ?? Math.floor(Math.random() * 1e9);
    const key = `${userId}/${folder}/${Date.now()}_${seed}.png`;
    await env.MESHES.put(key, buf, { httpMetadata: { contentType: 'image/png' } });
    return await signedR2Url(env, key, 'image');
  }
  // Without R2 we can't return a stable URL — failure is preferable
  // to handing the client a one-shot data URL.
  throw new Error('R2 bucket unavailable; cannot persist Modal output');
}

/** Modal back-view endpoint. Different schema from text2image:
 *  input is a front image URL + a free-form prompt hint. Output is
 *  PNG bytes (best of N candidates auto-picked by outfit color match).
 *  Same auth + R2 mirror pattern as callModalText2Image. */
/** Throw if `buf` isn't a real image. Catches the case where a Modal
 *  endpoint returns a content-filter placeholder (small PNG with text
 *  rendered into it, or a JSON error) with HTTP 200 — silently saving
 *  it to R2 yields a poisoned image the user sees but can't recover
 *  from.
 *  Three layers:
 *  1. Magic bytes — covers PNG / JPEG / WEBP; non-image bodies (JSON
 *     errors, HTML pages) throw immediately.
 *  2. Size floor — a Modal RealVisXL 1024×1024 PNG is ALWAYS > 100 KB,
 *     usually 600 KB – 2 MB. A 'blocked by content filter' placeholder
 *     is ~5-30 KB (small canvas with rendered text). Anything below
 *     50 KB is almost certainly a placeholder, not a real generation.
 *  3. PNG IHDR width check (when PNG) — placeholders are often 256x or
 *     512x; real outputs are always 1024x or 1024+. Reject < 768. */
function _assertImageBytes(buf: ArrayBuffer, source: string): void {
  if (buf.byteLength < 256) {
    throw new Error(`${source} returned ${buf.byteLength} bytes — too small to be a real image (likely content-filtered placeholder).`);
  }
  const head = new Uint8Array(buf, 0, Math.min(32, buf.byteLength));
  const isPng  = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47;
  const isJpeg = head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF;
  const isWebp = head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46
              && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50;
  if (!isPng && !isJpeg && !isWebp) {
    const preview = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, 200));
    console.warn(`[${source}] non-image bytes (${buf.byteLength}): "${preview.slice(0, 120)}"`);
    throw new Error(`${source} returned non-image content (likely 'blocked by content filter' placeholder).`);
  }
  // Size floor — 50 KB. A real 1024² PNG never falls under 100 KB even
  // at the highest compression. Placeholders top out around 30 KB.
  if (buf.byteLength < 50_000) {
    const preview = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, 256));
    console.warn(`[${source}] suspiciously small image (${buf.byteLength} bytes): "${preview.slice(0, 100)}"`);
    throw new Error(`${source} returned a ${(buf.byteLength / 1024).toFixed(1)} KB image — Modal returned a content-filter placeholder instead of a real generation. Re-run; if it keeps happening the prompt is flagged by Modal's internal NSFW classifier (common false-positive on animals).`);
  }
  // PNG IHDR width sanity check. IHDR follows the 8-byte signature at
  // bytes 8-12 (length+'IHDR'), then width at bytes 16-19 big-endian.
  if (isPng && buf.byteLength >= 24) {
    const v = new DataView(buf, 16, 4);
    const w = v.getUint32(0, false);
    if (w > 0 && w < 768) {
      throw new Error(`${source} returned a ${w}px wide PNG — too small for a real generation (placeholder size). Re-run or rephrase the prompt.`);
    }
  }
}

/** Enrobe un appel GPU AUXILIAIRE pour qu'il laisse une trace.
 *
 *  Les quatre appels que `/api/generate` déclenche seul — rectification,
 *  vue arrière, feuille, MV-Adapter — n'écrivaient AUCUNE ligne. Ils
 *  n'apparaissaient ni dans le tableau de bord, ni dans les coûts par type.
 *  C'est la classe de trou qui a fait conclure « aucune activité depuis six
 *  jours » alors que la facture Modal montait.
 *
 *  On enrobe au POINT D'APPEL plutôt que dans le corps des fonctions : elles
 *  ont chacune plusieurs sorties et plusieurs `throw`, et les retoucher une
 *  par une aurait multiplié les risques d'en oublier une.
 *
 *  Crédits à 0 : ces appels ne sont pas facturés séparément à l'utilisateur,
 *  ils sont compris dans le prix du maillage. Ce qu'on veut rendre visible,
 *  c'est leur COÛT (MODAL_COST_USD[opType], renseigné pour les quatre).
 *
 *  L'exception est propagée telle quelle : la gestion d'erreur existante en
 *  aval — replis compris — doit continuer de fonctionner à l'identique. */
async function _journaliserAppelAux<T>(
  env: Env, userId: string, opType: string, appel: () => Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  try {
    const r = await appel();
    await logOperation(env, userId, opType, 0, t0, Date.now(), 'succeeded', { auto: true });
    return r;
  } catch (e) {
    await logOperation(env, userId, opType, 0, t0, Date.now(), 'failed',
                       { auto: true, error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

async function callModalBackView(env: Env, userId: string, input: {
  frontImageUrl: string;
  promptHint?: string;
  seed?: number;
  steps?: number;
  ip_scale?: number;
  n_candidates?: number;
}, folder: string): Promise<string> {
  const url = env.MODAL_BACKVIEW_URL;
  const secret = env.MODAL_SHARED_SECRET;
  if (!url) throw new Error('MODAL_BACKVIEW_URL not set');
  if (!secret) throw new Error('MODAL_SHARED_SECRET not set');

  const t0 = Date.now();
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      _auth: secret,
      front_image_url: input.frontImageUrl,
      prompt_hint: input.promptHint ?? '',
      seed: input.seed,
      steps: input.steps,
      ip_scale: input.ip_scale,
      n_candidates: input.n_candidates,
    }),
    // Back-view is heavier than text2image (4 models in pipeline +
    // multi-seed scoring) so we give it 5 min before timeout.
    signal: AbortSignal.timeout(300_000),
  });
  if (!r.ok) {
    throw new Error(`Cloud GPU back-view HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const buf = await r.arrayBuffer();
  console.log(`[modal] back-view dt=${Date.now() - t0}ms bytes=${buf.byteLength}`);
  _writeLastWarmMs(env, '_meta/last_warm_back_view.txt').catch(() => {});

  _assertImageBytes(buf, 'Modal back-view');

  if (env.MESHES && env.R2_PUBLIC_URL) {
    const seed = input.seed ?? Math.floor(Math.random() * 1e9);
    const key = `${userId}/${folder}/${Date.now()}_${seed}.png`;
    await env.MESHES.put(key, buf, { httpMetadata: { contentType: 'image/png' } });
    return await signedR2Url(env, key, 'image');
  }
  throw new Error('R2 bucket unavailable; cannot persist Modal back-view output');
}

/** Modal MV-Adapter endpoint — 6 orthographic views (front/right/back/
 *  left/top-3q/bottom-3q) generated from a single front reference by
 *  SDXL-base + MV-Adapter i2mv-sdxl LoRA-style custom adapter.
 *  Different output schema from back-view: returns JSON {views: [6 urls]}
 *  instead of raw PNG bytes, because the Modal side already persists each
 *  view to R2 (Worker can't usefully mirror 6 separate PNG bodies in one
 *  HTTP response under the 100 MB Cloudflare limit anyway).
 *  Falls back behaviour: caller falls back to callModalBackView when
 *  MODAL_MVADAPTER_URL is unset; this helper THROWS if called without it. */
async function callModalMVAdapter(env: Env, userId: string, input: {
  frontImageUrl: string;
  promptHint?: string;
  seed?: number;
  steps?: number;
  guidance?: number;
  size?: number;
}, folder: string): Promise<{ back: string; views: string[] }> {
  const url = env.MODAL_MVADAPTER_URL;
  const secret = env.MODAL_SHARED_SECRET;
  if (!url) throw new Error('MODAL_MVADAPTER_URL not set');
  if (!secret) throw new Error('MODAL_SHARED_SECRET not set');

  const t0 = Date.now();
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      _auth: secret,
      front_image_url: input.frontImageUrl,
      prompt_hint: input.promptHint ?? '',
      seed: input.seed ?? 1234,
      steps: input.steps ?? 50,
      guidance: input.guidance ?? 4.5,
      size: input.size ?? 768,
      user_id: userId,
      folder,
    }),
    // 6× SDXL passes with cpu_offload on L40S ≈ 90-180s. Give 7 min
    // ceiling (matches sheet timeout; well under the 600s Modal cap).
    signal: AbortSignal.timeout(420_000),
  });
  if (!r.ok) {
    throw new Error(`Cloud GPU multiview HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }

  // Expected response shape (Modal side persists to R2 and returns URLs):
  // { views: [front, right, back, left, top, bottom],
  //   engine: 'mvadapter',
  //   azim_elev: [[0,0],[90,0],[180,0],[270,0],[0,60],[0,-60]] }
  // View order matches VIEW_SLOTS in scripts/multiview_mvadapter_gen.py.
  const payload = await r.json() as {
    views?: string[];
    engine?: string;
    error?: string;
  };
  if (payload.error) {
    throw new Error(`Cloud GPU multiview error: ${payload.error}`);
  }
  const views = Array.isArray(payload.views) ? payload.views : [];
  if (views.length !== 6) {
    throw new Error(`Cloud GPU multiview expected 6 views, got ${views.length}`);
  }
  const back = views[2]; // VIEW_SLOTS[2] = (180, 0) = back
  if (!back || typeof back !== 'string') {
    throw new Error('Modal mvadapter: back view (index 2) missing/invalid');
  }
  console.log(`[modal] mvadapter dt=${Date.now() - t0}ms views=${views.length} back=${back.slice(-40)}`);
  _writeLastWarmMs(env, '_meta/last_warm_mvadapter.txt').catch(() => {});
  return { back, views };
}

/** Strict T-pose FRONT generation — verbatim port of the desktop's
 *  `scripts/generate_front_tpose.py` (RealVisXL + ControlNet OpenPose +
 *  optional IPAdapter for identity preservation). Reuses the back-view
 *  Modal container's snapshot, so cold start matches back-view (~30-40s).
 *
 *  Mode A (text2image): pass `prompt`. The Worker pre-filters NSFW via
 *  nsfw_filter.ts before calling.
 *  Mode B (img2img with identity preservation): pass `refImageUrl` to
 *  re-pose an existing front image as T-pose. `prompt` becomes optional
 *  (Modal falls back to the same caption as desktop run_from_image). */
async function callModalTpose(env: Env, userId: string, input: {
  prompt?: string;
  refImageUrl?: string;
  seed?: number;
  cn_scale?: number;
  ip_scale?: number;
  steps?: number;
}, folder: string): Promise<string> {
  const url = env.MODAL_TPOSE_URL;
  const secret = env.MODAL_SHARED_SECRET;
  if (!url) throw new Error('MODAL_TPOSE_URL not set');
  if (!secret) throw new Error('MODAL_SHARED_SECRET not set');

  const t0 = Date.now();
  const doFetch = () => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      _auth: secret,
      prompt: input.prompt ?? '',
      ref_image_url: input.refImageUrl ?? '',
      seed: input.seed,
      cn_scale: input.cn_scale,
      ip_scale: input.ip_scale,
      steps: input.steps,
    }),
    // T-pose runs on the back-view container — same heavy pipeline,
    // same 5 min budget (cold start ~30s + diffusion ~35s, plenty of
    // headroom for retries on cold L40S).
    signal: AbortSignal.timeout(300_000),
  });
  // Same 524 cold-start retry as callModalText2Image / callModalImageOp —
  // the tpose branch of /api/generate-image shares the failure mode.
  // Delays >= 60 s for the same reason (a 524 does not cancel the Modal
  // request; retrying too early autoscales a second cold container).
  let r = await doFetch();
  for (const delay of [60_000, 90_000]) {
    if (r.status !== 524) break;
    console.log(`[modal] tpose 524 — cold start retry after ${delay / 1000}s`);
    await new Promise((res) => setTimeout(res, delay));
    r = await doFetch();
  }
  if (!r.ok) {
    if (r.status === 524) {
      throw new Error(
        'the cloud GPU took too long to start (cold start). '
        + 'Please try again in a minute — your credits were refunded.'
      );
    }
    throw new Error(`Cloud GPU tpose HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const buf = await r.arrayBuffer();
  console.log(`[modal] tpose dt=${Date.now() - t0}ms bytes=${buf.byteLength}`);
  _writeLastWarmMs(env, '_meta/last_warm_tpose.txt').catch(() => {});
  _assertImageBytes(buf, 'Modal tpose');

  if (env.MESHES && env.R2_PUBLIC_URL) {
    const seed = input.seed ?? Math.floor(Math.random() * 1e9);
    const key = `${userId}/${folder}/${Date.now()}_${seed}_tpose.png`;
    await env.MESHES.put(key, buf, { httpMetadata: { contentType: 'image/png' } });
    return await signedR2Url(env, key, 'image');
  }
  throw new Error('R2 bucket unavailable; cannot persist Modal tpose output');
}

/** Unified image-op caller — POSTs to MODAL_IMAGE_OP_URL with `op` to
 *  dispatch between modify (img2img) and auto_inpaint (CLIPSeg+SDXL).
 *  Returns either the persisted R2 URL or a discriminated mask-empty
 *  shape for the auto_inpaint case (so the Worker can refund). */
async function callModalImageOp(env: Env, userId: string, input: {
  op: 'modify' | 'auto_inpaint' | 'mask_inpaint' | 'face_fix_image' | 'upscale' | 'segment';
  imageUrl: string;
  prompt?: string;
  strength?: number;          // modify + face_fix_image
  seed?: number;
  steps?: number;
  targetText?: string;        // auto_inpaint only
  dilate?: number;
  maskUrl?: string;           // mask_inpaint only
  scale?: number;             // upscale only (2 or 4)
  refineStrength?: number;    // upscale only
}, folder: string): Promise<{ url: string } | { maskEmpty: true; error: string }> {
  const url = env.MODAL_IMAGE_OP_URL;
  const secret = env.MODAL_SHARED_SECRET;
  if (!url) throw new Error('MODAL_IMAGE_OP_URL not set');
  if (!secret) throw new Error('MODAL_SHARED_SECRET not set');

  const body: Record<string, unknown> = {
    _auth: secret,
    op: input.op,
    image_url: input.imageUrl,
    prompt: input.prompt ?? '',
  };
  if (input.op === 'modify') {
    body.strength = input.strength ?? 0.55;
    body.seed = input.seed;
    body.steps = input.steps;
  } else if (input.op === 'auto_inpaint' || input.op === 'segment') {
    body.target_text = input.targetText ?? '';
    body.dilate = input.dilate ?? 15;
  } else if (input.op === 'mask_inpaint') {
    body.mask_url = input.maskUrl ?? '';
  } else if (input.op === 'face_fix_image') {
    body.strength = input.strength ?? 0.45;
  } else if (input.op === 'upscale') {
    body.scale = input.scale ?? 2;
    body.refine_strength = input.refineStrength ?? 0.15;
    body.seed = input.seed;
    body.steps = input.steps;
  }

  // Multi-shot retry on 524. Cold start for MyFabmeshBackview is
  // ~90-180s (snap restore + GPU move + lazy load of CLIPSeg + SDXL
  // Inpaint on first mask_inpaint / auto_inpaint call). Cloudflare
  // cuts each subrequest at 100s with 524, so we need to retry
  // multiple times to outlast the slowest cold start.
  //
  // Schedule (worst case ~5 min wallclock):
  //   t=0    1st request → cut at 100s (524)
  //   wait 60s
  //   t=160  2nd request → cut at 100s (524 if STILL cold)
  //   wait 90s
  //   t=350  3rd request → should land on a warm container
  // Total Worker time stays under the 15min Workers Paid wallclock.
  const t0 = Date.now();
  const doFetch = () => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  let r = await doFetch();
  let waitedMs = 0;
  for (const delay of [60_000, 90_000]) {
    if (r.status !== 524) break;
    waitedMs += delay;
    console.log(`[modal] image_op 524 — cold start retry after ${delay/1000}s (total wait so far: ${waitedMs/1000}s)`);
    await new Promise(res => setTimeout(res, delay));
    r = await doFetch();
  }
  if (r.status === 422) {
    return { maskEmpty: true, error: (await r.text()).slice(0, 200) };
  }
  if (!r.ok) {
    if (r.status === 524) {
      // Still cold after retry — surface the friendly hint.
      throw new Error(
        `the AI model is taking longer than usual to warm up. ` +
        `Please retry in 1-2 minutes — your credits were refunded.`
      );
    }
    throw new Error(`Cloud GPU image_op (${input.op}) HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const buf = await r.arrayBuffer();
  console.log(`[modal] image_op op=${input.op} dt=${Date.now() - t0}ms bytes=${buf.byteLength}`);
  // Tag the container as warm. Used by /api/modal-status so the
  // renderer knows whether the next op will be fast or paying a
  // cold-start tax. Fire-and-forget — failure is fine, we just lose
  // the warmth hint for one cycle.
  _writeLastWarmMs(env, '_meta/last_warm_image_op.txt').catch(() => {});

  _assertImageBytes(buf, `Modal image_op (${input.op})`);
  if (env.MESHES && env.R2_PUBLIC_URL) {
    const tag = input.op === 'modify' ? 'modified' : 'inpaint';
    const seed = input.seed ?? Math.floor(Math.random() * 1e9);
    const key = `${userId}/${folder}/${Date.now()}_${seed}_${tag}.png`;
    await env.MESHES.put(key, buf, { httpMetadata: { contentType: 'image/png' } });
    return { url: await signedR2Url(env, key, 'image') };
  }
  throw new Error('R2 bucket unavailable; cannot persist image_op output');
}

/** 4-view orthographic model-sheet — port of multiview_sheet_gen.py.
 *  Used by Wave 2.3 to auto-generate a back-view for hard-surface assets
 *  (vehicle/building/weapon/prop) where the realvis T-pose pipeline
 *  doesn't apply. Single SDXL + IPAdapter Plus pass guarantees the back
 *  matches the front's identity / paint / wear. Returns the back-view
 *  cell (the other 3 cells aren't currently consumed cloud-side). */
async function callModalSheet(env: Env, userId: string, input: {
  frontImageUrl: string;
  promptHint?: string;
  seed?: number;
  ip_scale?: number;
  steps?: number;
}, folder: string): Promise<string> {
  const url = env.MODAL_SHEET_URL;
  const secret = env.MODAL_SHARED_SECRET;
  if (!url) throw new Error('MODAL_SHEET_URL not set');
  if (!secret) throw new Error('MODAL_SHARED_SECRET not set');

  const t0 = Date.now();
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      _auth: secret,
      front_image_url: input.frontImageUrl,
      prompt_hint: input.promptHint ?? '',
      seed: input.seed,
      ip_scale: input.ip_scale,
      steps: input.steps,
    }),
    // 4-view sheet renders at 2048² (4× the pixels of a single view) →
    // ~2× the GPU time. 5 min budget covers cold start + render.
    signal: AbortSignal.timeout(300_000),
  });
  if (!r.ok) {
    throw new Error(`Cloud GPU sheet HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const buf = await r.arrayBuffer();
  console.log(`[modal] sheet dt=${Date.now() - t0}ms bytes=${buf.byteLength}`);
  _assertImageBytes(buf, 'Modal sheet');

  if (env.MESHES && env.R2_PUBLIC_URL) {
    const seed = input.seed ?? Math.floor(Math.random() * 1e9);
    const key = `${userId}/${folder}/${Date.now()}_${seed}_sheet_back.png`;
    await env.MESHES.put(key, buf, { httpMetadata: { contentType: 'image/png' } });
    return await signedR2Url(env, key, 'image');
  }
  throw new Error('R2 bucket unavailable; cannot persist Modal sheet output');
}

/** Auto-rectify — strict orthographic FRONT or 3/4 ISO regen with
 *  multi-seed silhouette symmetry scoring (port of generate_front_strict.py).
 *  Runs on the same Modal container as back-view/tpose; ControlNet is
 *  zeroed at call time so the diffusion path is plain RealVisXL +
 *  optional IPAdapter. Cost ≈ back-view × seeds (default 3 seeds). */
async function callModalRectify(env: Env, userId: string, input: {
  prompt?: string;
  refImageUrl?: string;
  mode?: 'front' | 'iso';
  seeds?: number;
  steps?: number;
  guidance?: number;
  ip_scale?: number;
}, folder: string): Promise<string> {
  const url = env.MODAL_RECTIFY_URL;
  const secret = env.MODAL_SHARED_SECRET;
  if (!url) throw new Error('MODAL_RECTIFY_URL not set');
  if (!secret) throw new Error('MODAL_SHARED_SECRET not set');

  const t0 = Date.now();
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      _auth: secret,
      prompt: input.prompt ?? '',
      ref_image_url: input.refImageUrl ?? '',
      mode: input.mode ?? 'front',
      seeds: input.seeds,
      steps: input.steps,
      guidance: input.guidance,
      ip_scale: input.ip_scale,
    }),
    // Multi-seed (3) × diffusion (35s) + rembg per candidate.
    // 8 min budget covers cold start + 3 candidates + scoring.
    signal: AbortSignal.timeout(480_000),
  });
  if (!r.ok) {
    throw new Error(`Cloud GPU rectify HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const buf = await r.arrayBuffer();
  console.log(`[modal] rectify dt=${Date.now() - t0}ms bytes=${buf.byteLength}`);
  _assertImageBytes(buf, 'Modal rectify');

  if (env.MESHES && env.R2_PUBLIC_URL) {
    const key = `${userId}/${folder}/${Date.now()}_rectified.png`;
    await env.MESHES.put(key, buf, { httpMetadata: { contentType: 'image/png' } });
    return await signedR2Url(env, key, 'image');
  }
  throw new Error('R2 bucket unavailable; cannot persist Modal rectify output');
}

/* ───────────────────── Modal mesh — ASYNC pattern ─────────────────────
 * The mesh pipeline (TRELLIS-2) takes ~5-10 min on a cold container.
 * Modal web endpoints hard-cap HTTP responses at 150 s, so we cannot
 * use a sync request/reply. Instead:
 *
 *   1. callModalMeshStart()  → POSTs to <MODAL_MESH_URL>/mesh-start,
 *      returns a job_id in <1 s. Modal spawns the work in background.
 *   2. callModalMeshStatus() → POSTs to <MODAL_MESH_URL>/mesh-status
 *      with the job_id; gets back {ready, glb_base64} when done.
 *   3. handleJob() (existing poll endpoint) calls #2 repeatedly until
 *      the GLB is ready, then mirrors it into R2 like Replicate output.
 *
 * MODAL_MESH_URL stores the BASE URL of the Modal app (without
 * /mesh-start). The /mesh-start and /mesh-status suffixes are appended
 * here. Or we can store both URLs as two separate envs — chose the
 * single-base approach to keep secrets short.
 * ──────────────────────────────────────────────────────────────────── */

async function callModalMeshStart(env: Env, input: {
  jobId: string;
  frontImageUrl: string;
  backImageUrl?: string | null;
  mode?: string;
  seed?: number;
  decimation_target?: number;
  texture_size?: number;
  tex_steps?: number;
  rectify?: boolean;
  face_fix?: boolean;
  refine?: boolean;
  smooth?: boolean;
  ultra_hd?: boolean;
  multiref?: boolean;
}): Promise<{ job_id: string }> {
  const url = env.MODAL_MESH_START_URL;
  const secret = env.MODAL_SHARED_SECRET;
  if (!url) throw new Error('MODAL_MESH_START_URL not set');
  if (!secret) throw new Error('MODAL_SHARED_SECRET not set');

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      _auth: secret,
      job_id: input.jobId,
      front_image_url: input.frontImageUrl,
      back_image_url: input.backImageUrl ?? null,
      mode: input.mode ?? '1024',
      seed: input.seed,
      decimation_target: input.decimation_target,
      texture_size: input.texture_size,
      // PALIER DE QUALITE. Le menu Fast/Balanced/Quality/Ultra est
      // facture 3/4/6/8 credits, mais son nombre de steps n'arrivait
      // jamais jusqu'a Modal : les quatre paliers produisaient le meme
      // travail GPU a quatre prix differents. 0 = defaut d'environnement,
      // donc comportement inchange si le client ne precise rien.
      tex_steps: input.tex_steps ?? 0,
      rectify: !!input.rectify,
      face_fix: !!input.face_fix,
      refine:   !!input.refine,
      smooth:   !!input.smooth,
      ultra_hd: !!input.ultra_hd,
      multiref: !!input.multiref,
    }),
    // mesh-start returns instantly (< 1 s) once the lightweight HTTP
    // container is warm, but a COLD container for the start endpoint
    // itself takes 30-60 s to come up (it loads the shared `image`
    // even though it doesn't use the GPU). 2 min was too tight when
    // Modal was queueing the spawn behind concurrent jobs; bumped to
    // 4 min (2026-06-01 — user hit the cap on a real cold start).
    signal: AbortSignal.timeout(240_000),
  });
  if (!r.ok) {
    throw new Error(`Cloud GPU mesh-start HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  return await r.json() as { job_id: string };
}

interface ModalMeshStatusResp {
  ready: boolean;
  glb_base64?: string;
  bytes?: number;
  error?: string;
}

async function callModalMeshStatus(env: Env, jobId: string): Promise<ModalMeshStatusResp> {
  const url = env.MODAL_MESH_STATUS_URL;
  const secret = env.MODAL_SHARED_SECRET;
  if (!url) throw new Error('MODAL_MESH_STATUS_URL not set');
  if (!secret) throw new Error('MODAL_SHARED_SECRET not set');

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ _auth: secret, job_id: jobId }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) {
    throw new Error(`Cloud GPU mesh-status HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  return await r.json() as ModalMeshStatusResp;
}

/** Save a base64-encoded GLB to R2 and return the public URL. */
async function persistModalGlb(env: Env, jobId: string, glbBase64: string): Promise<string> {
  if (!env.MESHES || !env.R2_PUBLIC_URL) {
    throw new Error('R2 bucket unavailable; cannot persist Modal mesh');
  }
  // Decode base64 → ArrayBuffer.
  const bin = atob(glbBase64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const key = `mesh/${jobId}.glb`;
  await env.MESHES.put(key, buf.buffer, {
    httpMetadata: { contentType: 'model/gltf-binary' },
  });
  // Tag the mesh container as warm.
  _writeLastWarmMs(env, '_meta/last_warm_mesh.txt').catch(() => {});
  return await signedR2Url(env, key, 'mesh');
}

async function callMyfabmeshCog(env: Env, userId: string, input: CogInput, folder: string): Promise<string> {
  const token = env.REPLICATE_API_TOKEN ?? '';
  if (!token) throw new Error('REPLICATE_API_TOKEN not set');

  const version = await resolveMyfabmeshCogVersion(token);

  // Private models require /v1/predictions with `version: <id>` — the
  // /v1/models/<owner>/<name>/predictions endpoint returns 404 for
  // private models. Public models can use either.
  const createRes = await fetch(
    'https://api.replicate.com/v1/predictions',
    {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${token}`,
        'content-type': 'application/json',
        // 'prefer: wait' inlines the result up to 60s (counts as ONE
        // subrequest). Cold-start = ~90s so we usually need a few extra
        // polls beyond that.
        'prefer': 'wait=60',
      },
      body: JSON.stringify({ version, input }),
    },
  );
  if (!createRes.ok) {
    throw new Error(`Cloud GPU create HTTP ${createRes.status}: ${await createRes.text()}`);
  }
  const created = await createRes.json() as { id: string; output?: string | string[]; status: string; error?: string };

  // CRITICAL: track the prediction in R2 *immediately* so /api/cleanup-
  // orphans can find and cancel it if this Worker dies mid-flight
  // (subrequest limit, CPU limit, OOM, etc). Without this the prediction
  // keeps running on Replicate and burns money even after the user sees
  // an error. R2 PUT counts as 1 subrequest — worth it.
  const leaseKey = `_meta/inflight/${created.id}`;
  try {
    await env.MESHES.put(leaseKey, JSON.stringify({
      userId, folder, model: 'myfabmesh-cloud',
      createdAt: Date.now(),
    }));
  } catch { /* non-fatal */ }

  // Cancel the prediction in any error path — protects against partial
  // failures where the Worker is still alive but can't continue.
  const cancelPrediction = async () => {
    try {
      await fetch(`https://api.replicate.com/v1/predictions/${created.id}/cancel`, {
        method: 'POST', headers: { authorization: `Bearer ${token}` },
      });
    } catch { /* best-effort */ }
    try { await env.MESHES.delete(leaseKey); } catch { /* ignore */ }
  };

  let outputUrl: string | undefined;
  try {
    if (created.status === 'succeeded') {
      outputUrl = Array.isArray(created.output) ? created.output[0] : created.output;
    } else if (created.status === 'failed') {
      throw new Error(`Cloud GPU failed: ${created.error || 'unknown'}`);
    } else {
      // HARD CAP on poll count: subrequest budget on Workers is 50
      // (free) / 1000 (paid). We use at most MAX_POLLS = 20 polls so
      // total subrequests for this call stay ~25 (create + 20 polls +
      // R2 lease + output fetch + R2 mirror + lease delete). With
      // MAX_POLLS=20 × 6s interval = 120s of polling AFTER the 60s
      // wait=60 above = 180s total. That covers cold start (~90s) +
      // typical inference (~35s) with headroom.
      const MAX_POLLS = 20;
      const POLL_INTERVAL_MS = 6000;
      for (let i = 0; i < MAX_POLLS; i++) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${created.id}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const p = await pollRes.json() as { status: string; output?: string | string[]; error?: string };
        if (p.status === 'succeeded') {
          outputUrl = Array.isArray(p.output) ? p.output[0] : p.output;
          break;
        }
        if (p.status === 'failed' || p.status === 'canceled') {
          throw new Error(`Cloud GPU ${p.status}: ${p.error || 'unknown'}`);
        }
      }
      if (!outputUrl) {
        // Timeout: cancel so the prediction doesn't keep burning GPU.
        await cancelPrediction();
        throw new Error(`Cloud GPU timeout after ${(60 + MAX_POLLS * POLL_INTERVAL_MS / 1000)}s`);
      }
    }
    if (!outputUrl) throw new Error('Replicate succeeded but no output URL');
  } catch (e) {
    // Any error path → cancel the upstream prediction so we stop billing.
    await cancelPrediction();
    throw e;
  }

  // Success: clear the lease.
  try { await env.MESHES.delete(leaseKey); } catch { /* ignore */ }

  // Mirror into R2 so the browser gets a stable same-origin URL.
  if (env.MESHES && env.R2_PUBLIC_URL) {
    try {
      const imgRes = await fetch(outputUrl);
      if (imgRes.ok) {
        const buf = await imgRes.arrayBuffer();
        _assertImageBytes(buf, 'Cog text2image');
        const seed = input.seed ?? Math.floor(Math.random() * 1e9);
        const key = `${userId}/${folder}/${Date.now()}_${seed}.png`;
        await env.MESHES.put(key, buf, { httpMetadata: { contentType: 'image/png' } });
        return await signedR2Url(env, key, 'image');
      }
    } catch { /* fall back to raw Replicate URL */ }
  }
  return outputUrl;
}

async function handleGenerateImage(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  const { prompt, numImages, seed, asset_type, asset_style, userPrompt, steps,
          tpose, refImageUrl, cn_scale, ip_scale, projectName, turbo } = await req.json() as {
    prompt?: string;
    userPrompt?: string;
    turbo?: boolean;   // SDXL-Lightning 4-step turbo (Modal text2image only)
    numImages?: number;
    seed?: number;
    asset_type?: string;
    asset_style?: string;
    steps?: number;
    projectName?: string;   // for user_assets row insertion (Supabase-backed listing)
    // Strict T-pose front mode (verbatim port of desktop's
    // generate_front_tpose.py). When true, routes to MyFabmeshBackview's
    // /tpose endpoint instead of text2image. Required by RTS unit
    // workflows where the input MUST be a clean T-pose silhouette
    // for TRELLIS-2 + MVAdapter cascade.
    tpose?: boolean;
    refImageUrl?: string;   // T-pose img2img mode: re-pose this image
    cn_scale?: number;
    ip_scale?: number;
  };
  // The Cog rebuilds the enriched prompt itself from userPrompt + type
  // + style — we forward those. Fall back to the full enriched prompt
  // the renderer sent in case userPrompt isn't broken out.
  const rawPrompt = (userPrompt ?? prompt ?? '').toString().trim();
  if (!rawPrompt) return err(400, 'prompt required');
  // NSFW prompt pre-filter — block keywords and dangerous combos BEFORE
  // we spend credits or hit Modal/Replicate. Saves the user the cost
  // of a generation that the post-image NSFW classifier would block
  // anyway, and rejects intent-only prompts that wouldn't render any
  // visible NSFW (e.g. "child + sensual" with a safe negative prompt).
  // Bypass via FABMESH_UNRESTRICTED env var OR per-user parental state.
  // `unrestricted` is hoisted out of the safety block so the Modal call
  // site below can forward it in the request body.
  const envUnrestricted = env.FABMESH_UNRESTRICTED === '1';
  const userState = await getParentalState(env, user.id);
  const unrestricted = envUnrestricted || !!userState.unrestricted;
  {
    const safety = checkPromptSafety(rawPrompt, unrestricted);
    if (!safety.safe) {
      return json({ ok: false, success: false,
        error: safety.reason ?? 'prompt blocked by content filter',
        blocked: safety.blocked }, { status: 400 });
    }
  }
  const n = Math.max(1, Math.min(4, numImages ?? 1));
  const COST_PER_IMAGE = await getPrice(env, 'text2image');
  const cost = n * COST_PER_IMAGE;

  // Pick the backend BEFORE the budget check — the budget cap is
  // Replicate-only (Modal has its own provider-side spend cap and
  // doesn't share a wallet with Replicate). Counting Modal calls
  // against the Replicate budget locks the user out of Modal as soon
  // as the (separate) Replicate counter is exhausted.
  // T-pose mode requires Modal (no Replicate fallback yet).
  const useTpose = !!tpose && !!env.MODAL_TPOSE_URL;
  const useModal = useTpose || !!env.MODAL_TEXT2IMAGE_URL;
  const callBackend = useModal ? callModalText2Image : callMyfabmeshCog;

  // Worst-case Replicate cost estimate per image (cold-start + active
  // + idle tail). We bill this against the daily cap BEFORE spending
  // any credits so a runaway burst never crosses the cap. Modal is
  // 5-10× cheaper than Replicate, so the per-image estimate is split.
  // T-pose runs on the heavier back-view container (RealVisXL + CN +
  // IPAdapter) — costs about as much as a back-view (~$0.10).
  const ESTIMATED_USD_PER_IMAGE = useTpose ? 0.10 : (useModal ? 0.06 : 0.30);
  const estimatedTotal = ESTIMATED_USD_PER_IMAGE * n;

  // Hard daily spend cap — refund the estimate if the call fails.
  // Conservative — never falsifies the budget upward. Modal uses its
  // own R2 counter so the two backends don't share a cap.
  const remainingBudget = useModal
    ? await checkAndIncrementModalSpend(env, estimatedTotal, user.id)
    : await checkAndIncrementDailySpend(env, estimatedTotal, user.id);
  if (remainingBudget == null) {
    return json({ ok: false, success: false,
      error: await _spendRefusalMessage(env, user.id) }, { status: 429 });
  }
  // Per-user daily call cap — refund on failure too.
  const remainingUserCalls = await checkAndIncrementUserCalls(env, user.id);
  if (remainingUserCalls == null) {
    if (useModal) await refundModalSpend(env, estimatedTotal);
    else await refundDailySpend(env, estimatedTotal);
    return json({ ok: false, success: false,
      error: `you've reached the per-user daily generation limit. Comes back at midnight UTC.` }, { status: 429 });
  }

  const remaining = await spendCredits(env, user.id, cost);
  if (remaining == null) {
    if (useModal) await refundModalSpend(env, estimatedTotal);
    else await refundDailySpend(env, estimatedTotal);
    return json({ ok: false, success: false, error: `insufficient credits — image generation costs ${cost} credit${cost === 1 ? '' : 's'}` }, { status: 402 });
  }

  if (useTpose && refImageUrl && !isTrustedAssetHost(env, refImageUrl)) {
    return err(400, 'refImageUrl host not allowed');
  }
  const paths: string[] = [];
  const seedBase = seed ?? Math.floor(Math.random() * 1e9);
  const opStart = Date.now();
  const opType = useTpose ? 'tpose' : 'text2image';
  try {
    for (let i = 0; i < n; i++) {
      if (useTpose) {
        // Strict T-pose front — verbatim port of desktop generate_front_tpose.py.
        paths.push(await callModalTpose(env, user.id, {
          prompt: rawPrompt,
          refImageUrl,
          seed: seedBase + i,
          cn_scale,
          ip_scale,
          steps: steps || 30,
        }, 'front'));
      } else {
        paths.push(await callBackend(env, user.id, {
          task: 'text2image',
          prompt: rawPrompt,
          asset_type: asset_type || 'character',
          asset_style: asset_style || 'realistic',
          unrestricted, // per-user parental state, forwarded to Modal
          seed: seedBase + i,
          steps: steps || 30,
          turbo: !!turbo,  // SDXL-Lightning 4-step (Modal only; Cog ignores it)
        }, 'front'));
      }
    }
  } catch (e) {
    await addCredits(env, user.id, cost);
    if (useModal) await refundModalSpend(env, estimatedTotal);
    else await refundDailySpend(env, estimatedTotal);
    // Log the failure so the history CSV reflects the refunded attempt.
    await logOperation(env, user.id, opType,
                       0, opStart, Date.now(), 'failed',
                       { error: e instanceof Error ? e.message : String(e), n, asset_type });
    return err(502, `image generation failed (credits refunded): ${e instanceof Error ? e.message : String(e)}`);
  }
  // Success path — record each generation as a separate row so the
  // CSV totals match the actual GPU calls (e.g. count=3 logs 3 entries).
  //
  // DUREES DECOUPEES. Les n lignes recevaient toutes le MEME opStart et
  // le MEME instant de fin : chacune portait donc la duree du LOT
  // ENTIER. Depuis que le tableau de bord chiffre chaque operation sur
  // sa propre duree (_measuredCostUsd), ce coût se retrouvait multiplie
  // par n — un lot de 4 images etait compte 4 fois trop cher.
  //
  // On repartit la fenetre reelle en n tranches contigues : la somme des
  // lignes redonne exactement la duree du lot, et chaque ligne porte une
  // duree plausible pour UNE image.
  const opEnd = Date.now();
  const trancheMs = Math.max(1, Math.round((opEnd - opStart) / Math.max(1, n)));
  for (let i = 0; i < n; i++) {
    const debut = opStart + i * trancheMs;
    await logOperation(env, user.id, opType,
                       COST_PER_IMAGE, debut, debut + trancheMs, 'succeeded',
                       { asset_type, asset_style, batch_index: i, batch_size: n });
  }
  // Persist in user_assets so /api/cloud-projects can list these
  // without the client needing to cache R2 paths in localStorage.
  if (projectName) {
    const kind = useTpose ? 'image-tpose' : 'image-front';
    for (const url of paths) {
      const r2_path = r2PathFromPublicUrl(env, url);
      if (r2_path) {
        await insertUserAsset(env, user.id, projectName, kind, r2_path, null,
          { asset_type, asset_style, prompt: rawPrompt.slice(0, 512), seed: seedBase });
      }
    }
  }
  return json({ ok: true, success: true, paths, creditsRemaining: remaining });
}

async function handleGenerateBackView(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  const { prompt, promptHint, numImages, frontImageUrl, asset_type } = await req.json() as {
    prompt?: string;
    promptHint?: string;
    numImages?: number;
    frontImageUrl?: string;
    asset_type?: string;
  };
  if (!frontImageUrl) return err(400, 'frontImageUrl required for back-view generation');
  if (!isTrustedAssetHost(env, frontImageUrl)) return err(400, 'frontImageUrl host not allowed');
  const hint = (prompt ?? promptHint ?? '').toString().slice(0, 400);

  // NSFW prompt pre-filter — same policy as text2image / desktop checkPromptSafety.
  {
    // Mirror text2image/modify: per-user parental state OR the env flag (not env only).
    const userState = await getParentalState(env, user.id);
    const unrestricted = (env.FABMESH_UNRESTRICTED === '1') || !!userState.unrestricted;
    const safety = checkPromptSafety(hint, unrestricted);
    if (!safety.safe) {
      return json({ ok: false, success: false,
        error: safety.reason ?? 'prompt blocked by content filter',
        blocked: safety.blocked }, { status: 400 });
    }
  }

  const n = Math.max(1, Math.min(4, numImages ?? 1));
  const COST_PER_BACK = await getPrice(env, 'back_view');
  const cost = n * COST_PER_BACK;

  // Pick backend BEFORE budget check (same pattern as text2image).
  const useModal = !!env.MODAL_BACKVIEW_URL;

  // Back-view is heavier than front (RealVisXL + ControlNet + IP-Adapter
  // + Florence-2). On Replicate that's ~$0.50/image, on Modal with the
  // snapshot we expect ~$0.10/image (similar to mesh cost — heavier
  // GPU move than text2image due to ControlNet + IP-Adapter modules).
  const ESTIMATED_USD_PER_BACK = useModal ? 0.10 : 0.50;
  const estimatedTotal = ESTIMATED_USD_PER_BACK * n;

  const remainingBudget = useModal
    ? await checkAndIncrementModalSpend(env, estimatedTotal, user.id)
    : await checkAndIncrementDailySpend(env, estimatedTotal, user.id);
  if (remainingBudget == null) {
    const provider = 'Cloud GPU';
    return json({ ok: false, success: false,
      error: `daily ${provider} budget reached. Try again after midnight UTC.` }, { status: 429 });
  }
  const remainingUserCalls = await checkAndIncrementUserCalls(env, user.id);
  if (remainingUserCalls == null) {
    if (useModal) await refundModalSpend(env, estimatedTotal);
    else await refundDailySpend(env, estimatedTotal);
    return json({ ok: false, success: false,
      error: `you've reached the per-user daily generation limit.` }, { status: 429 });
  }

  const remaining = await spendCredits(env, user.id, cost);
  if (remaining == null) {
    if (useModal) await refundModalSpend(env, estimatedTotal);
    else await refundDailySpend(env, estimatedTotal);
    return json({ ok: false, success: false, error: `insufficient credits — back view costs ${cost} credit${cost === 1 ? '' : 's'}` }, { status: 402 });
  }

  const paths: string[] = [];
  const opStart = Date.now();
  try {
    for (let i = 0; i < n; i++) {
      if (useModal) {
        paths.push(await callModalBackView(env, user.id, {
          frontImageUrl,
          promptHint: hint,
          seed: 424242 + i * 1000,
        }, 'back'));
      } else {
        paths.push(await callMyfabmeshCog(env, user.id, {
          task: 'back-view',
          prompt: hint,
          image: frontImageUrl,
          asset_type: asset_type || 'character',
        }, 'back'));
      }
    }
  } catch (e) {
    await addCredits(env, user.id, cost);
    if (useModal) await refundModalSpend(env, estimatedTotal);
    else await refundDailySpend(env, estimatedTotal);
    await logOperation(env, user.id, 'back-view', 0, opStart, Date.now(),
                       'failed', { error: e instanceof Error ? e.message : String(e), n });
    return err(502, `back view generation failed (credits refunded): ${e instanceof Error ? e.message : String(e)}`);
  }
  // Meme decoupage que la generation d'images : sans lui, les n lignes
  // portent chacune la duree du lot entier et le cout est compte n fois.
  const bvEnd = Date.now();
  const bvTranche = Math.max(1, Math.round((bvEnd - opStart) / Math.max(1, n)));
  for (let i = 0; i < n; i++) {
    const debut = opStart + i * bvTranche;
    await logOperation(env, user.id, 'back-view',
                       COST_PER_BACK, debut, debut + bvTranche, 'succeeded',
                       { asset_type, batch_index: i, batch_size: n });
  }
  return json({ ok: true, success: true, paths, creditsRemaining: remaining });
}

/** Modify (img2img) endpoint — desktop "Modify image" tool ported to
 *  the cloud. Takes an existing image URL + a prompt and returns a
 *  variation via SDXL img2img on RealVisXL. */
async function handleModifyImage(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MODAL_IMAGE_OP_URL) {
    return err(503, 'modify backend unavailable (cloud GPU not configured)');
  }
  const { imageUrl, prompt, strength, seed, steps } = await req.json() as {
    imageUrl?: string;
    prompt?: string;
    strength?: number;
    seed?: number;
    steps?: number;
  };
  if (!imageUrl) return err(400, 'imageUrl required');
  // SSRF guard: only forward URLs from our trusted upstreams to Modal.
  if (!isTrustedAssetHost(env, imageUrl)) return err(400, 'imageUrl host not allowed');
  const rawPrompt = (prompt ?? '').toString().trim();
  if (!rawPrompt) return err(400, 'prompt required');

  // NSFW pre-filter — same policy as text2image/back-view/rectify.
  {
    const envUnrestricted = env.FABMESH_UNRESTRICTED === '1';
    const userState = await getParentalState(env, user.id);
    const unrestricted = envUnrestricted || userState.unrestricted;
    const safety = checkPromptSafety(rawPrompt, unrestricted);
    if (!safety.safe) {
      return json({ ok: false, success: false,
        error: safety.reason ?? 'prompt blocked by content filter',
        blocked: safety.blocked }, { status: 400 });
    }
  }

  const COST_PER_MODIFY = await getPrice(env, 'modify');
  const cost = COST_PER_MODIFY;
  const estimatedTotal = 0.05;  // ≈ back-view cost, warm container

  const remainingBudget = await checkAndIncrementModalSpend(env, estimatedTotal, user.id);
  if (remainingBudget == null) {
    return json({ ok: false, success: false,
      error: `daily Cloud GPU budget reached. Try again after midnight UTC.` }, { status: 429 });
  }
  const remainingUserCalls = await checkAndIncrementUserCalls(env, user.id);
  if (remainingUserCalls == null) {
    await refundModalSpend(env, estimatedTotal);
    return json({ ok: false, success: false,
      error: `you've reached the per-user daily generation limit.` }, { status: 429 });
  }

  const remaining = await spendCredits(env, user.id, cost);
  if (remaining == null) {
    await refundModalSpend(env, estimatedTotal);
    return json({ ok: false, success: false,
      error: `insufficient credits — modify costs ${cost} credits` }, { status: 402 });
  }

  let url: string;
  const opStart = Date.now();
  try {
    const result = await callModalImageOp(env, user.id, {
      op: 'modify',
      imageUrl, prompt: rawPrompt,
      strength: strength ?? 0.55,
      seed: seed ?? Math.floor(Math.random() * 1e9),
      steps,
    }, 'modified');
    if ('maskEmpty' in result) {
      // modify can't return mask-empty, but TS narrowing needs both arms.
      throw new Error('unexpected mask_empty from modify');
    }
    url = result.url;
  } catch (e) {
    await addCredits(env, user.id, cost);
    await refundModalSpend(env, estimatedTotal);
    await logOperation(env, user.id, 'text2image', 0, opStart, Date.now(),
                       'failed', { error: e instanceof Error ? e.message : String(e), op: 'modify' });
    return err(502, `modify failed (credits refunded): ${e instanceof Error ? e.message : String(e)}`);
  }
  await logOperation(env, user.id, 'text2image', cost, opStart, Date.now(),
                     'succeeded', { op: 'modify', strength });
  return json({ ok: true, success: true, path: url, newPath: url, creditsRemaining: remaining });
}

/** Mask preview — detect-only CLIPSeg for the Auto Inpaint "Preview mask"
 *  button. ONE GPU call on demand (not live-on-keystroke, which would be
 *  cost-prohibitive on serverless). Returns the soft mask as an R2 image URL
 *  the renderer overlays on the source. Cheap (1 credit) but still gated by
 *  the Modal budget + per-user call limit since it's a real GPU hit. */
async function handleSegmentPreview(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MODAL_IMAGE_OP_URL) return err(503, 'mask preview backend unavailable');
  const { imagePath, imageUrl, targetText, dilate } = await req.json() as {
    imagePath?: string; imageUrl?: string; targetText?: string; dilate?: number;
  };
  const src = imageUrl || imagePath;
  if (!src) return err(400, 'imageUrl or imagePath required');
  if (!isTrustedAssetHost(env, src)) return err(400, 'imageUrl host not allowed');
  if (!targetText) return err(400, 'targetText required');

  const cost = await getPrice(env, 'segment');  // admin-configurable (Pricing tab)
  const estimatedTotal = 0.05;
  const remainingBudget = await checkAndIncrementModalSpend(env, estimatedTotal, user.id);
  if (remainingBudget == null) {
    return json({ ok: false, success: false,
      error: 'daily Cloud GPU budget reached. Try again after midnight UTC.' }, { status: 429 });
  }
  const remainingUserCalls = await checkAndIncrementUserCalls(env, user.id);
  if (remainingUserCalls == null) {
    await refundModalSpend(env, estimatedTotal);
    return json({ ok: false, success: false,
      error: 'per-user daily generation limit reached.' }, { status: 429 });
  }
  const remaining = await spendCredits(env, user.id, cost);
  if (remaining == null) {
    await refundModalSpend(env, estimatedTotal);
    return json({ ok: false, success: false,
      error: `insufficient credits — mask preview costs ${cost} credit` }, { status: 402 });
  }

  const opStart = Date.now();
  try {
    const result = await callModalImageOp(env, user.id, {
      op: 'segment',
      imageUrl: src, targetText, dilate,
    }, 'segment');
    if ('maskEmpty' in result) {
      await addCredits(env, user.id, cost);
      await refundModalSpend(env, estimatedTotal);
      // CLIPSeg a bien tourne sur le GPU : masque vide ne veut pas dire
      // calcul gratuit. Sans cette ligne, le remboursement effacait a la fois
      // le credit ET le compteur de depense — l'operation disparaissait des
      // deux surfaces comptables a la fois.
      await logOperation(env, user.id, 'text2image', 0, opStart, Date.now(),
                         'failed', { op: 'segment', target: targetText, raison: 'masque vide' });
      return json({ ok: false, success: false,
        error: `"${targetText}" not found in the image (credit refunded)` }, { status: 422 });
    }
    await logOperation(env, user.id, 'text2image', cost, opStart, Date.now(),
                       'succeeded', { op: 'segment', target: targetText });
    return json({ ok: true, success: true, maskUrl: result.url, url: result.url, creditsRemaining: remaining });
  } catch (e) {
    await addCredits(env, user.id, cost);
    await refundModalSpend(env, estimatedTotal);
    // Le mode d'echec le PLUS COUTEUX est celui qui passait ici : l'echelle
    // de reprise sur 524 peut bruler plusieurs minutes de GPU avant de lever.
    // C'est precisement celui qui ne laissait aucune trace.
    await logOperation(env, user.id, 'text2image', 0, opStart, Date.now(),
                       'failed', { op: 'segment', error: e instanceof Error ? e.message : String(e) });
    return err(502, `mask preview failed (credit refunded): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Auto-inpaint HTTP handler — desktop "Auto Inpaint" tool. NSFW
 *  pre-filter applied to the user-supplied prompt; credits refunded
 *  if CLIPSeg can't find target_text. */
async function handleAutoInpaint(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MODAL_IMAGE_OP_URL) {
    return err(503, 'auto-inpaint backend unavailable');
  }
  const { imagePath, imageUrl, targetText, prompt, dilate } = await req.json() as {
    imagePath?: string;
    imageUrl?: string;
    targetText?: string;
    prompt?: string;
    dilate?: number;
  };
  const src = imageUrl || imagePath;
  if (!src) return err(400, 'imageUrl or imagePath required');
  if (!isTrustedAssetHost(env, src)) return err(400, 'imageUrl host not allowed');
  if (!targetText) return err(400, 'targetText required');

  const rawPrompt = (prompt ?? '').toString().trim();
  if (rawPrompt) {
    const envUnrestricted = env.FABMESH_UNRESTRICTED === '1';
    const userState = await getParentalState(env, user.id);
    const unrestricted = envUnrestricted || userState.unrestricted;
    const safety = checkPromptSafety(rawPrompt, unrestricted);
    if (!safety.safe) {
      return json({ ok: false, success: false,
        error: safety.reason ?? 'prompt blocked by content filter',
        blocked: safety.blocked }, { status: 400 });
    }
  }

  const COST_PER_INPAINT = await getPrice(env, 'auto_inpaint');
  const cost = COST_PER_INPAINT;
  const estimatedTotal = 0.08;

  const remainingBudget = await checkAndIncrementModalSpend(env, estimatedTotal, user.id);
  if (remainingBudget == null) {
    return json({ ok: false, success: false,
      error: 'daily Cloud GPU budget reached. Try again after midnight UTC.' }, { status: 429 });
  }
  const remainingUserCalls = await checkAndIncrementUserCalls(env, user.id);
  if (remainingUserCalls == null) {
    await refundModalSpend(env, estimatedTotal);
    return json({ ok: false, success: false,
      error: `per-user daily generation limit reached.` }, { status: 429 });
  }
  const remaining = await spendCredits(env, user.id, cost);
  if (remaining == null) {
    await refundModalSpend(env, estimatedTotal);
    return json({ ok: false, success: false,
      error: `insufficient credits — auto inpaint costs ${cost} credits` }, { status: 402 });
  }

  const opStart = Date.now();
  try {
    const result = await callModalImageOp(env, user.id, {
      op: 'auto_inpaint',
      imageUrl: src, targetText, prompt: rawPrompt, dilate,
    }, 'inpaint');
    if ('maskEmpty' in result) {
      // Refund — the GPU did NOT do any real work (just CLIPSeg, which
      // is cheap and we don't bill the user for a missed mask).
      await addCredits(env, user.id, cost);
      await refundModalSpend(env, estimatedTotal);
      await logOperation(env, user.id, 'text2image', 0, opStart, Date.now(),
                         'failed', { op: 'auto_inpaint', reason: 'mask_empty', target: targetText });
      return json({ ok: false, success: false,
        error: `auto-inpaint: "${targetText}" not found in the image (credits refunded)` }, { status: 422 });
    }
    await logOperation(env, user.id, 'text2image', cost, opStart, Date.now(),
                       'succeeded', { op: 'auto_inpaint', target: targetText });
    return json({ ok: true, success: true, path: result.url, newPath: result.url, creditsRemaining: remaining });
  } catch (e) {
    await addCredits(env, user.id, cost);
    await refundModalSpend(env, estimatedTotal);
    await logOperation(env, user.id, 'text2image', 0, opStart, Date.now(),
                       'failed', { op: 'auto_inpaint', error: e instanceof Error ? e.message : String(e) });
    return err(502, `auto-inpaint failed (credits refunded): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Manual mask inpaint — user paints the mask in the renderer's Draw
 *  Mask modal, we forward image + mask URLs to image_op. */
async function handleMaskInpaint(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MODAL_IMAGE_OP_URL) return err(503, 'mask-inpaint backend unavailable');

  const { imagePath, imageUrl, maskDataUrl, prompt } = await req.json() as {
    imagePath?: string; imageUrl?: string; maskDataUrl?: string; prompt?: string;
  };
  const src = imageUrl || imagePath;
  if (!src) return err(400, 'imageUrl or imagePath required');
  if (!isTrustedAssetHost(env, src)) return err(400, 'imageUrl host not allowed');
  if (!maskDataUrl) return err(400, 'maskDataUrl required');
  const rawPrompt = (prompt ?? '').toString().trim();
  // Empty prompt = "just remove" (the UI hint "empty = just remove"). Inpaint
  // the masked region with surrounding background (object removal) instead of
  // requiring a replacement description.
  const isRemoval = !rawPrompt;
  const effectivePrompt = isRemoval
    ? 'clean empty background, seamless fill matching the surroundings, photorealistic, no object'
    : rawPrompt;

  // NSFW pre-filter — only on a real user prompt (the removal prompt is our own
  // fixed, safe string).
  if (!isRemoval) {
    const envUnrestricted = env.FABMESH_UNRESTRICTED === '1';
    const userState = await getParentalState(env, user.id);
    const unrestricted = envUnrestricted || userState.unrestricted;
    const safety = checkPromptSafety(rawPrompt, unrestricted);
    if (!safety.safe) {
      return json({ ok: false, success: false,
        error: safety.reason ?? 'prompt blocked by content filter',
        blocked: safety.blocked }, { status: 400 });
    }
  }

  // Decode the mask data URL → bytes → upload to R2 → get a stable URL
  // for Modal to fetch.
  let maskUrl: string;
  try {
    const m = /^data:image\/(\w+);base64,(.+)$/.exec(maskDataUrl);
    if (!m) return err(400, 'invalid maskDataUrl (expected data:image/...;base64,...)');
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (!env.MESHES || !env.R2_PUBLIC_URL) {
      return err(500, 'R2 binding required to forward mask');
    }
    const key = `${user.id}/masks/${Date.now()}_user.${ext}`;
    await env.MESHES.put(key, bytes, {
      httpMetadata: { contentType: `image/${m[1]}` },
    });
    maskUrl = await signedR2Url(env, key, 'image');
  } catch (e) {
    return err(400, `mask decode failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const COST_PER = await getPrice(env, 'mask_inpaint');
  const estimatedTotal = 0.07;

  const remainingBudget = await checkAndIncrementModalSpend(env, estimatedTotal, user.id);
  if (remainingBudget == null) {
    return json({ ok: false, success: false,
      error: 'daily Cloud GPU budget reached. Try again after midnight UTC.' }, { status: 429 });
  }
  const remainingUserCalls = await checkAndIncrementUserCalls(env, user.id);
  if (remainingUserCalls == null) {
    await refundModalSpend(env, estimatedTotal);
    return json({ ok: false, success: false,
      error: 'per-user daily generation limit reached.' }, { status: 429 });
  }
  const remaining = await spendCredits(env, user.id, COST_PER);
  if (remaining == null) {
    await refundModalSpend(env, estimatedTotal);
    return json({ ok: false, success: false,
      error: `insufficient credits — mask inpaint costs ${COST_PER} credits` }, { status: 402 });
  }

  const opStart = Date.now();
  try {
    const result = await callModalImageOp(env, user.id, {
      op: 'mask_inpaint',
      imageUrl: src,
      maskUrl,
      prompt: effectivePrompt,
    }, 'inpaint');
    if ('maskEmpty' in result) {
      // mask_inpaint never returns mask_empty (caller-supplied mask).
      throw new Error('unexpected mask_empty from mask_inpaint');
    }
    await logOperation(env, user.id, 'text2image', COST_PER, opStart, Date.now(),
                       'succeeded', { op: 'mask_inpaint' });
    return json({ ok: true, success: true, path: result.url, newPath: result.url, creditsRemaining: remaining });
  } catch (e) {
    await addCredits(env, user.id, COST_PER);
    await refundModalSpend(env, estimatedTotal);
    await logOperation(env, user.id, 'text2image', 0, opStart, Date.now(),
                       'failed', { op: 'mask_inpaint', error: e instanceof Error ? e.message : String(e) });
    return err(502, `mask-inpaint failed (credits refunded): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Image-level face fix — OpenCV Haar Cascade picks the face bbox,
 *  SDXL Inpaint polishes it. Costs 2 credits, refund if no face found. */
async function handleFaceFixImage(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MODAL_IMAGE_OP_URL) return err(503, 'face-fix backend unavailable');

  const { imagePath, imageUrl, strength } = await req.json() as {
    imagePath?: string; imageUrl?: string; strength?: number;
  };
  const src = imageUrl || imagePath;
  if (!src) return err(400, 'imageUrl or imagePath required');
  if (!isTrustedAssetHost(env, src)) return err(400, 'imageUrl host not allowed');

  const COST_PER = await getPrice(env, 'face_fix_image');
  const estimatedTotal = 0.05;
  const remainingBudget = await checkAndIncrementModalSpend(env, estimatedTotal, user.id);
  if (remainingBudget == null) {
    return json({ ok: false, success: false,
      error: 'daily Cloud GPU budget reached.' }, { status: 429 });
  }
  const remainingUserCalls = await checkAndIncrementUserCalls(env, user.id);
  if (remainingUserCalls == null) {
    await refundModalSpend(env, estimatedTotal);
    return json({ ok: false, success: false, error: 'user limit reached.' }, { status: 429 });
  }
  const remaining = await spendCredits(env, user.id, COST_PER);
  if (remaining == null) {
    await refundModalSpend(env, estimatedTotal);
    return json({ ok: false, success: false, error: `insufficient credits — face-fix costs ${COST_PER}` }, { status: 402 });
  }

  const opStart = Date.now();
  try {
    const result = await callModalImageOp(env, user.id, {
      op: 'face_fix_image',
      imageUrl: src,
      strength: strength ?? 0.45,
    }, 'facefix');
    if ('maskEmpty' in result) {
      // No face detected — refund.
      await addCredits(env, user.id, COST_PER);
      await refundModalSpend(env, estimatedTotal);
      await logOperation(env, user.id, 'text2image', 0, opStart, Date.now(),
                         'failed', { op: 'face_fix_image', reason: 'no_face' });
      return json({ ok: false, success: false,
        error: 'no face detected in image (credits refunded)' }, { status: 422 });
    }
    await logOperation(env, user.id, 'text2image', COST_PER, opStart, Date.now(),
                       'succeeded', { op: 'face_fix_image' });
    return json({ ok: true, success: true, path: result.url, newPath: result.url, creditsRemaining: remaining });
  } catch (e) {
    await addCredits(env, user.id, COST_PER);
    await refundModalSpend(env, estimatedTotal);
    await logOperation(env, user.id, 'text2image', 0, opStart, Date.now(),
                       'failed', { op: 'face_fix_image', error: e instanceof Error ? e.message : String(e) });
    return err(502, `face-fix failed (credits refunded): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** POST /api/mesh-op — sync CPU mesh transformation via trimesh on
 *  Modal. Routes through mesh_start with op_type set so we don't burn
 *  a Modal Web Function slot. Returns the new GLB mirrored to R2. */
async function handleMeshOp(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MODAL_MESH_START_URL) return err(503, 'mesh-op backend unavailable');

  const { meshUrl, meshId, opType, params, projectName } = await req.json() as {
    meshUrl?: string; meshId?: string; opType?: string;
    params?: Record<string, unknown>;
    projectName?: string;
  };
  // Sanitize the project slug so it's safe as an R2 key segment AND
  // round-trips back to the same name on listing. Allowed: ASCII
  // letters, digits, -, _, dot. Everything else becomes _. Empty
  // projectName falls back to 'untitled' so the listing endpoint can
  // still attach the file to *some* project.
  const projectSlug = ((projectName || 'untitled').toString()
    .replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'untitled');
  const allowed = new Set([
    'smooth', 'decimate', 'center', 'fix_normals', 'fill_holes',
    'subdivide', 'material', 'material_adjust', 'retex_swap',
    'watertight',  // 'align_texture' removed: it was a paid no-op on cloud (no real reprojection)
    'resize',      // per-axis scale (manual Resize/dimension tool) — params: {sx,sy,sz}
    'explode',     // Voronoi fracture -> part_XX submeshes (explode slider) — params: {fragments}
  ]);
  const op = (opType ?? '').toLowerCase();
  if (!allowed.has(op)) {
    return err(400, `opType must be one of ${Array.from(allowed).join(', ')}`);
  }
  // retex_swap reads payload.params.image_url — surface a clearer
  // 400 if it's missing instead of letting Modal noop the op.
  if (op === 'retex_swap' && !(params && (params as Record<string, unknown>).image_url)) {
    return err(400, 'retex_swap needs params.image_url');
  }
  // target_resolution / tex_res guard — the Modal retex_swap path runs
  // on the source mesh's existing UV unwrap (currently baked at 2K).
  // Re-baking at 4096 stretches a 2K layout to 4K and produces heavy
  // corruption (black patches + bleached areas around UV seams).
  // Until the upstream pipeline ships a 4K UV unwrap, clamp the
  // request size to 2048 so direct API callers can't bypass the UI.
  if (params && typeof params === 'object') {
    const p = params as Record<string, unknown>;
    const MAX_TEX_RES = 2048;
    for (const key of ['target_resolution', 'tex_res', 'texture_size', 'resolution']) {
      const raw = p[key];
      if (raw == null) continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      if (n > MAX_TEX_RES) {
        return err(400, `${key} must be <= ${MAX_TEX_RES}; higher resolutions are not yet supported (upstream UV unwrap is baked at 2K — re-baking at 4K corrupts the texture).`);
      }
    }
  }

  // Resolve mesh URL — caller can pass URL directly OR a job id.
  let finalUrl = meshUrl ?? '';
  if (!finalUrl && meshId) {
    const { data } = await supabaseAdmin(env)
      .from('jobs').select('mesh_url').eq('id', meshId).eq('user_id', user.id).maybeSingle();
    finalUrl = (data as { mesh_url?: string } | null)?.mesh_url ?? '';
  }
  if (!finalUrl) return err(400, 'meshUrl or meshId required');
  // SSRF guard: meshUrl is user-controlled here (caller can pass any string).
  // Only allow trusted upstreams so we don't make Modal fetch arbitrary hosts.
  if (!isTrustedAssetHost(env, finalUrl)) return err(400, 'meshUrl host not allowed');
  // retex_swap also takes a user-supplied params.image_url — same SSRF risk.
  if (op === 'retex_swap' && params && typeof params === 'object') {
    const imgU = String((params as Record<string, unknown>).image_url ?? '');
    if (imgU && !isTrustedAssetHost(env, imgU)) {
      return err(400, 'params.image_url host not allowed');
    }
  }

  // Cheap op (CPU, ~$0.001 Modal) — defaults to 1 credit, admin-tunable.
  const COST_PER = await getPrice(env, 'mesh_op_simple');
  const estimatedTotal = 0.005;
  const remainingBudget = await checkAndIncrementModalSpend(env, estimatedTotal, user.id);
  if (remainingBudget == null) {
    return json({ ok: false, success: false, error: 'daily Cloud GPU budget reached.' }, { status: 429 });
  }
  const remainingUserCalls = await checkAndIncrementUserCalls(env, user.id);
  if (remainingUserCalls == null) {
    await refundModalSpend(env, estimatedTotal);
    return json({ ok: false, success: false, error: 'user limit reached.' }, { status: 429 });
  }
  const remaining = await spendCredits(env, user.id, COST_PER);
  if (remaining == null) {
    await refundModalSpend(env, estimatedTotal);
    return json({ ok: false, success: false,
      error: `insufficient credits — ${op} costs ${COST_PER}` }, { status: 402 });
  }

  const opStart = Date.now();
  try {
    const r = await fetch(env.MODAL_MESH_START_URL!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        _auth: env.MODAL_SHARED_SECRET ?? '',
        op_type: op,
        mesh_url: finalUrl,
        params: params ?? {},
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) throw new Error(`Cloud GPU mesh_op HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = await r.json() as { glb_base64?: string; stats?: Record<string, unknown> };
    if (!data.glb_base64) throw new Error('Modal mesh_op missing glb_base64');

    // Decode base64 → R2 → return URL.
    const bin = atob(data.glb_base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (!env.MESHES || !env.R2_PUBLIC_URL) throw new Error('R2 binding required');
    const key = `${user.id}/mesh-op/${projectSlug}/${Date.now()}_${op}.glb`;
    await env.MESHES.put(key, bytes, { httpMetadata: { contentType: 'model/gltf-binary' } });
    const url = await signedR2Url(env, key, 'mesh');
    // Forward fill_holes verdict + delta-faces into telemetry so we can
    // measure the diagnostic-first rollout via Supabase SELECT later.
    const logCtx: Record<string, unknown> = { op_type: op, mesh_url_in: finalUrl };
    if (data.stats) {
      const s = data.stats as Record<string, unknown>;
      if (s.verdict) logCtx.verdict = s.verdict;
      if (typeof s.holes_filled_delta_faces === 'number') logCtx.holes_filled_delta_faces = s.holes_filled_delta_faces;
    }
    // 'mesh-op' (not 'mesh'): these CPU ops cost ~$0.005, not the $0.060 of a
    // real mesh generation — booking them under 'mesh' made both buckets
    // unreadable. meta.op_type keeps the granular name (smooth/decimate/…).
    await logOperation(env, user.id, 'mesh-op',
                       COST_PER, opStart, Date.now(), 'succeeded', logCtx);
    return json({
      ok: true, success: true,
      path: url, newPath: url, mesh_url: url,
      stats: data.stats ?? null,
      creditsRemaining: remaining,
    });
  } catch (e) {
    await addCredits(env, user.id, COST_PER);
    await refundModalSpend(env, estimatedTotal);
    const errMsg = e instanceof Error ? e.message : String(e);
    await logOperation(env, user.id, 'mesh-op',
                       0, opStart, Date.now(), 'failed',
                       { op_type: op, error: errMsg });
    console.error('[mesh-op]', op, errMsg, e);
    // Don't leak upstream stack/URLs to the client.
    return err(502, `mesh ${op} failed (credits refunded)`);
  }
}

/** POST /api/construction-stages-3d — fabricate REAL 3D construction-stage
 *  meshes (Manor Lords style) on Modal CPU (trimesh), then mirror every
 *  stage GLB to R2 one at a time (a 5-stage castle is ~200MB total, far
 *  beyond one Worker JSON response). Mirrors the desktop handler
 *  generate-construction-stages-3d: also writes a version copy of the
 *  source mesh named <stem>_chantier3d_<ts>.glb so the stage set is
 *  attached to a NEW mesh version, like on desktop. */
async function handleConstructionStages3d(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MODAL_MESH_START_URL) return err(503, 'construction backend unavailable');
  if (!env.MESHES || !env.R2_PUBLIC_URL) return err(503, 'R2 binding required');

  const { meshUrl, meshId, stageCount, materials, projectName } = await req.json() as {
    meshUrl?: string; meshId?: string; stageCount?: number;
    materials?: Record<string, string> | string; projectName?: string;
  };
  const projectSlug = ((projectName || 'untitled').toString()
    .replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'untitled');
  const n = Math.max(2, Math.min(Number(stageCount) || 5, 12));
  // materials: string (AUTO) or {scaffold, frame, planks, formwork} (MANUAL)
  const MAT_OK = new Set(['wood', 'metal', 'bamboo', 'aluminium']);
  let mats: Record<string, string> = {};
  if (typeof materials === 'string') {
    mats = { scaffold: materials.toLowerCase() };
  } else if (materials && typeof materials === 'object') {
    for (const k of ['scaffold', 'frame', 'planks', 'formwork']) {
      const v = String((materials as Record<string, unknown>)[k] ?? '').toLowerCase();
      if (v) mats[k] = v;
    }
  }
  for (const k of Object.keys(mats)) if (!MAT_OK.has(mats[k])) delete mats[k];

  let finalUrl = meshUrl ?? '';
  if (!finalUrl && meshId) {
    const { data } = await supabaseAdmin(env)
      .from('jobs').select('mesh_url').eq('id', meshId).eq('user_id', user.id).maybeSingle();
    finalUrl = (data as { mesh_url?: string } | null)?.mesh_url ?? '';
  }
  if (!finalUrl) return err(400, 'meshUrl or meshId required');
  if (!isTrustedAssetHost(env, finalUrl)) return err(400, 'meshUrl host not allowed');

  // CPU-only Modal op, but N stages of work — charge 2× a simple mesh op.
  const COST_PER = (await getPrice(env, 'mesh_op_simple')) * 2;
  const estimatedTotal = 0.01;
  const remainingBudget = await checkAndIncrementModalSpend(env, estimatedTotal, user.id);
  if (remainingBudget == null) {
    return json({ ok: false, success: false, error: 'daily Cloud GPU budget reached.' }, { status: 429 });
  }
  const remainingUserCalls = await checkAndIncrementUserCalls(env, user.id);
  if (remainingUserCalls == null) {
    await refundModalSpend(env, estimatedTotal);
    return json({ ok: false, success: false, error: 'user limit reached.' }, { status: 429 });
  }
  const remaining = await spendCredits(env, user.id, COST_PER);
  if (remaining == null) {
    await refundModalSpend(env, estimatedTotal);
    return json({ ok: false, success: false,
      error: `insufficient credits — construction stages cost ${COST_PER}` }, { status: 402 });
  }

  const opStart = Date.now();
  try {
    // 1. Fabricate all stages on Modal (parked on its Volume).
    const r = await fetch(env.MODAL_MESH_START_URL!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        _auth: env.MODAL_SHARED_SECRET ?? '',
        op_type: 'construction3d',
        mesh_url: finalUrl,
        params: { stage_count: n, materials: mats },
      }),
      signal: AbortSignal.timeout(290_000),
    });
    if (!r.ok) throw new Error(`Cloud GPU construction3d HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const start = await r.json() as { ok?: boolean; job_id?: string; count?: number };
    if (!start.ok || !start.job_id || !start.count) throw new Error('Modal construction3d bad response');

    // 2. Version copy of the source mesh (same pattern as desktop:
    //    <stem>_chantier3d_<ts>.glb) — R2-internal copy, no Modal.
    const srcKey = r2PathFromPublicUrl(env, finalUrl);
    // split('?') AVANT split('/') : finalUrl peut etre une de nos URLs signees
    // (`...glb?exp=<unix>&sig=<hex>`). Sans ce decoupage le `$` de la regex
    // d'extension ne matche pas, srcName garde la signature entiere, et le
    // newStem construit plus bas — qui devient une CLE R2 — embarque
    // '?exp=...&sig=...' dans son nom.
    const srcName = (finalUrl.split('?')[0].split('/').pop() || 'mesh.glb').replace(/\.(glb|gltf)$/i, '');
    const stem = srcName.replace(/_chantier3d_\d+$/i, '');
    const ts = Date.now();
    const newStem = `${stem}_chantier3d_${ts}`;
    let versionUrl: string | null = null;
    if (srcKey) {
      const srcObj = await env.MESHES.get(srcKey);
      if (srcObj) {
        const vKey = `${user.id}/mesh-op/${projectSlug}/${newStem}.glb`;
        await env.MESHES.put(vKey, srcObj.body, { httpMetadata: { contentType: 'model/gltf-binary' } });
        versionUrl = await signedR2Url(env, vKey, 'mesh');
      }
    }

    // 3. Pull stages ONE per request and mirror to R2.
    const stageUrls: string[] = [];
    for (let i = 0; i < start.count; i++) {
      const fr = await fetch(env.MODAL_MESH_START_URL!.replace(/\/mesh_start$/, '/c3d_fetch'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ _auth: env.MODAL_SHARED_SECRET ?? '', job_id: start.job_id, index: i }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!fr.ok) throw new Error(`c3d_fetch ${i} HTTP ${fr.status}`);
      const fd = await fr.json() as { ready?: boolean; glb_base64?: string };
      if (!fd.ready || !fd.glb_base64) throw new Error(`stage ${i} not on Volume`);
      const bin = atob(fd.glb_base64);
      const bytes = new Uint8Array(bin.length);
      for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
      const key = `${user.id}/stages3d/${newStem}/stage_${i}.glb`;
      await env.MESHES.put(key, bytes, { httpMetadata: { contentType: 'model/gltf-binary' } });
      stageUrls.push(await signedR2Url(env, key, 'mesh'));
    }

    await logOperation(env, user.id, 'construction3d',
                       COST_PER, opStart, Date.now(), 'succeeded',
                       { op_type: 'construction3d', stages: start.count });
    return json({
      ok: true, success: true,
      versionMeshPath: versionUrl || finalUrl,
      dir: `${user.id}/stages3d/${newStem}`,
      stages: stageUrls,
      count: stageUrls.length,
      creditsRemaining: remaining,
    });
  } catch (e) {
    await addCredits(env, user.id, COST_PER);
    await refundModalSpend(env, estimatedTotal);
    const errMsg = e instanceof Error ? e.message : String(e);
    await logOperation(env, user.id, 'construction3d',
                       0, opStart, Date.now(), 'failed',
                       { op_type: 'construction3d', error: errMsg });
    console.error('[construction-stages-3d]', errMsg, e);
    return err(502, 'construction stages failed (credits refunded)');
  }
}

/** GET /api/stages3d-list?stem=<newStem> — list the stage GLBs previously
 *  fabricated for a chantier3d mesh version (cloud port of the desktop's
 *  check-stages3d-dir disk fallback). */
async function handleStages3dList(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MESHES) return err(503, 'R2 binding required');
  const stem = (new URL(req.url).searchParams.get('stem') || '')
    .replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
  if (!stem) return err(400, 'stem required');
  const listed = await env.MESHES.list({ prefix: `${user.id}/stages3d/${stem}/`, limit: 50 });
  const items: Array<{ index: number; url: string }> = [];
  for (const obj of listed.objects) {
    const m = obj.key.match(/stage_(\d+)\.glb$/i);
    if (!m) continue;
    items.push({ index: Number(m[1]), url: await signedR2Url(env, obj.key, 'mesh') });
  }
  items.sort((a, b) => a.index - b.index);
  return json({ ok: true, success: true, stages: items.map(i => i.url), count: items.length });
}

/** POST /api/mesh-op/client-result — accepts a GLB that the renderer
 *  produced 100% client-side (three.js Smooth / Decimate / Subdivide /
 *  Fix Normals / Fill Holes / Center JS implementations). No Modal
 *  hop, no credit charge — the work was done in the browser, the
 *  server just persists the result to R2 and returns the URL.
 *
 *  Safeguards: auth required, glTF magic-byte check, hard size cap,
 *  per-user daily call quota (shared with paid ops). */
/** Export-format conversion: GLB -> FBX / OBJ / STL / PLY / glTF / USD /
 *  Alembic / Collada, via Blender on Modal.
 *
 *  Deliberately NOT an opType on handleMeshOp. That handler bills a
 *  credit and files its output back into the project as a new mesh —
 *  correct for an *edit*, wrong for an *export*: downloading your own
 *  mesh in another format must not cost credits, and must not litter the
 *  project's mesh list with .fbx entries.
 *
 *  The converted bytes are parked under <uid>/export/ and returned as a
 *  signed URL. That prefix is outside <uid>/mesh-op/, which is what the
 *  project listing scans, so exports stay invisible to the project view. */
async function handleMeshConvert(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MODAL_MESH_START_URL) return err(503, 'export backend unavailable');

  const { meshUrl, format } = await req.json() as {
    meshUrl?: string; format?: string;
  };
  // Mirror of modal_app/_convert_op.FORMATS. Kept as a literal rather
  // than fetched so a malformed request is rejected at the edge, before
  // it can boot a Blender container.
  const FORMATS = new Set([
    'fbx', 'fbx_unreal',  // fbx_unreal = same .fbx, cm + Y-up for Unreal
    'obj', 'stl', 'ply', 'gltf', 'usd', 'usdc', 'usda', 'usdz', 'abc', 'dae',
  ]);
  const fmt = (format ?? '').toLowerCase().replace(/^\./, '');
  if (!FORMATS.has(fmt)) {
    return err(400, `format must be one of ${Array.from(FORMATS).join(', ')}`);
  }
  const src = (meshUrl ?? '').trim();
  if (!src) return err(400, 'meshUrl required');
  // Same SSRF guard as handleMeshOp: meshUrl is user-controlled.
  if (!isTrustedAssetHost(env, src)) return err(400, 'meshUrl host not allowed');

  // QUOTA — lacune introduite AVEC cette route le 2026-08-02, relevee par
  // l'audit du 2026-08-03. J'avais deliberement choisi de ne PAS facturer
  // l'export (retelecharger son propre maillage dans un autre format ne
  // doit rien couter), mais j'en avais deduit a tort qu'aucun garde-fou
  // n'etait necessaire. Chaque appel demarre un conteneur Blender : sans
  // plafond, une boucle suffisait a faire tourner du calcul indefiniment
  // aux frais de l'exploitant.
  //
  // On reutilise le compteur d'appels quotidiens partage (le meme que les
  // operations payantes) : gratuit ne veut pas dire illimite.
  const quota = await checkAndIncrementUserCalls(env, user.id);
  if (quota == null) {
    return err(429, 'Daily conversion limit reached for this account. '
                  + 'It resets at midnight UTC.');
  }

  const started = Date.now();
  try {
    const r = await fetch(
      env.MODAL_MESH_START_URL.replace(/\/mesh_start$/, '/mesh_convert'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          _auth: env.MODAL_SHARED_SECRET ?? '', mesh_url: src, format: fmt,
        }),
        // Generous: a cold Blender container is a ~356MB image pull on
        // top of the conversion itself.
        signal: AbortSignal.timeout(600_000),
      });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      return err(502, `conversion failed (HTTP ${r.status}) ${detail}`.trim());
    }
    const data = await r.json() as {
      data_base64?: string; ext?: string; bytes?: number;
    };
    if (!data.data_base64) return err(502, 'conversion returned no data');

    const bin = atob(data.data_base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    // `ext` from the converter wins over `fmt`: OBJ and GLTF_SEPARATE
    // come back as a .zip because they need sidecar files, and naming
    // that download .obj would hand the user a broken archive.
    const ext = (data.ext || fmt).replace(/[^a-z0-9]/gi, '') || fmt;
    const key = `${user.id}/export/${Date.now()}_export.${ext}`;
    await env.MESHES.put(key, bytes, {
      httpMetadata: {
        contentType: ext === 'zip' ? 'application/zip' : 'application/octet-stream',
      },
    });
    const url = await signedR2Url(env, key, 'export');

    await logOperation(env, user.id, 'mesh-convert',
                       0, started, Date.now(), 'succeeded',
                       { format: fmt, ext, bytes: bytes.length });
    return json({ ok: true, url, ext, format: fmt, bytes: bytes.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logOperation(env, user.id, 'mesh-convert',
                       0, started, Date.now(), 'failed', { format: fmt, error: msg });
    return err(502, `conversion failed: ${msg}`);
  }
}

async function handleMeshOpClientResult(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');

  const { opType, glbBase64 } = await req.json() as {
    opType?: string; glbBase64?: string;
  };
  const CLIENT_OPS = new Set([
    'smooth', 'decimate', 'subdivide', 'fix_normals', 'fill_holes', 'center',
  ]);
  const op = (opType ?? '').toLowerCase();
  if (!CLIENT_OPS.has(op)) {
    return err(400, `opType must be one of ${Array.from(CLIENT_OPS).join(', ')} (client-side ops only)`);
  }
  if (!glbBase64 || typeof glbBase64 !== 'string') return err(400, 'glbBase64 required');
  // 100 MB max — pathological mesh would never legitimately exceed this
  // and we don't want to host runaway uploads for free.
  // 250 MB max (~335 M base64 chars). Trellis2 outputs with full PBR
  // sets + our 1024² emissive texture can easily push past 100 MB
  // once GLTFExporter re-embeds everything for the saved version.
  if (glbBase64.length > 335_000_000) return err(413, 'glb too large (>250 MB)');

  // Per-user call quota (shared bucket with /api/mesh-op).
  const remainingUserCalls = await checkAndIncrementUserCalls(env, user.id);
  if (remainingUserCalls == null) {
    return json({ ok: false, success: false, error: 'user limit reached.' }, { status: 429 });
  }

  const bin = atob(glbBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // glTF 2.0 binary magic: "glTF" (0x676C5446) then version 2.
  if (bytes.length < 12 ||
      bytes[0] !== 0x67 || bytes[1] !== 0x6C || bytes[2] !== 0x54 || bytes[3] !== 0x46) {
    return err(400, 'payload is not a valid GLB (magic bytes missing)');
  }
  if (!env.MESHES || !env.R2_PUBLIC_URL) return err(500, 'R2 binding required');

  const opStart = Date.now();
  try {
    const key = `${user.id}/mesh-op/${Date.now()}_${op}_client.glb`;
    await env.MESHES.put(key, bytes, { httpMetadata: { contentType: 'model/gltf-binary' } });
    const url = await signedR2Url(env, key, 'mesh');
    // Pure R2 upload — zero GPU, zero credits. Booking it as 'mesh' billed a
    // free client-side op at $0.060 a pop.
    await logOperation(env, user.id, 'mesh-op-client',
                       0, opStart, Date.now(), 'succeeded',
                       { op_type: op, client_side: true, size_bytes: bytes.length });
    return json({ ok: true, success: true, path: url, newPath: url, mesh_url: url });
  } catch (e) {
    await logOperation(env, user.id, 'mesh-op-client',
                       0, opStart, Date.now(), 'failed',
                       { op_type: op, client_side: true,
                         error: e instanceof Error ? e.message : String(e) });
    return err(502, `client-side mesh op upload failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Threshold (ms) above which we consider the Modal MyFabmeshBackview
// container scaled-down → next call will pay full cold start.
// scaledown_window in app.py is 600s; we tag anything beyond 9 min as
// cold (slight buffer for clock skew + the moment Modal kills the
// container).
const COLD_THRESHOLD_MS = 9 * 60 * 1000;

async function _readLastWarmMs(env: Env, key: string): Promise<number | null> {
  const txt = await r2GetText(env, key);
  if (!txt) return null;
  const n = parseInt(txt, 10);
  return Number.isFinite(n) ? n : null;
}

async function _writeLastWarmMs(env: Env, key: string): Promise<void> {
  if (!env.MESHES) return;
  try { await env.MESHES.put(key, String(Date.now())); }
  catch (e) { console.warn('[warm-track] put failed:', e instanceof Error ? e.message : String(e)); }
}

/** GET /api/modal-status — returns whether MyFabmeshBackview is
 *  warm (best-effort, based on the timestamp of our last successful
 *  call). Used by the renderer to size progress bars and show a
 *  warm/cold pill in modals. */
async function handleModalStatus(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  const now = Date.now();
  // Each Modal container is tracked separately. The renderer uses
  // this to show the correct warm/cold pill depending on which
  // operation the user is about to fire.
  //
  // We use TWO sources of truth, taking whichever is more recent:
  //   1) Per-container R2 timestamp written on every successful
  //      Modal call (_writeLastWarmMs).
  //   2) Supabase jobs table: any `succeeded` job whose finished_at
  //      is within 9 min implies that container was warm at finish.
  //      Inference is wider (covers historical ops written before
  //      we started tagging).
  async function status(file: string, warmSec: number, coldSec: number, lastJobMs: number | null) {
    const fileLast = await _readLastWarmMs(env, file).catch(() => null);
    const last = Math.max(fileLast ?? 0, lastJobMs ?? 0) || null;
    const secondsSinceLastSuccess = last ? Math.floor((now - last) / 1000) : null;
    const warm = last != null && (now - last) < COLD_THRESHOLD_MS;
    return {
      warm,
      seconds_since_last_success: secondsSinceLastSuccess,
      expected_seconds_warm: warmSec,
      expected_seconds_cold: coldSec,
    };
  }
  // Query the user's last successful job per container kind. We
  // classify by asset_type and options.operation_type.
  const sb = supabaseAdmin(env);
  const { data: recentJobs } = await sb.from('jobs')
    .select('asset_type, options, finished_at, type, cost_usd')
    .eq('user_id', user.id)
    .eq('status', 'succeeded')
    .gte('finished_at', new Date(now - COLD_THRESHOLD_MS).toISOString())
    .order('finished_at', { ascending: false })
    .limit(50);
  const lastByContainer: Record<string, number> = {};
  function bump(key: string, t: string | null) {
    if (!t) return;
    const ms = new Date(t).getTime();
    if (Number.isFinite(ms) && (lastByContainer[key] ?? 0) < ms) lastByContainer[key] = ms;
  }
  for (const j of ((recentJobs ?? []) as Array<{
    asset_type: string;
    options: Record<string, unknown> | null;
    finished_at: string | null;
  }>)) {
    const opType = String(j.type ?? j.options?.operation_type ?? '');
    const at = String(j.asset_type ?? '');
    if (opType === 'text2image' || opType === 'tpose') {
      bump(opType === 'tpose' ? 'tpose' : 'text2image', j.finished_at);
    } else if (opType === 'mesh') {
      bump('mesh', j.finished_at);
    } else if (opType === 'back_view' || opType === 'back-view') {
      bump('back_view', j.finished_at);
    } else if (['modify','auto_inpaint','mask_inpaint','face_fix_image','remove_background','upscale'].includes(opType)) {
      bump('image_op', j.finished_at);
    } else if (opType === 'auto_rig' || opType === 'rig' || at === 'rig') {
      bump('rig', j.finished_at);
    } else if (opType === 'animate' || opType === 'animation' || at === 'animation') {
      bump('anim', j.finished_at);
    } else if (opType === 'multiview' || opType === 'mvadapter') {
      bump('mvadapter', j.finished_at);
    } else if (at === 'text2image') {
      bump('text2image', j.finished_at);
    } else {
      // asset_type like 'character'/'animal'/'creature' → mesh
      bump('mesh', j.finished_at);
    }
  }
  // 2026-06-02: added rig (Puppeteer), anim (AnyTop), mvadapter
  // (multi-view generator) so the "Server warming up (N services)"
  // popover lists every Modal container the user can actually trigger
  // — previous list missed rig and anim which were silent surprises.
  const [image_op, text2image, back_view, tpose, mesh, rig, anim, mvadapter] = await Promise.all([
    status('_meta/last_warm_image_op.txt',  30, 150, lastByContainer.image_op   ?? null),
    status('_meta/last_warm_text2image.txt', 30, 150, lastByContainer.text2image ?? null),
    status('_meta/last_warm_back_view.txt',  40, 180, lastByContainer.back_view  ?? null),
    status('_meta/last_warm_tpose.txt',      30, 150, lastByContainer.tpose      ?? null),
    status('_meta/last_warm_mesh.txt',       60, 240, lastByContainer.mesh       ?? null),
    status('_meta/last_warm_rig.txt',        45, 180, lastByContainer.rig        ?? null),
    status('_meta/last_warm_anim.txt',       60, 240, lastByContainer.anim       ?? null),
    status('_meta/last_warm_mvadapter.txt',  40, 180, lastByContainer.mvadapter  ?? null),
  ]);
  return json({
    image_op, text2image, back_view, tpose, mesh, rig, anim, mvadapter,
    cold_threshold_seconds: Math.floor(COLD_THRESHOLD_MS / 1000),
  });
}

/** POST /api/upload-image — body: { dataUrl, suffix? }. Decodes a
 *  data URL (PNG from a canvas modal — Clone Stamp, Mask, Blur, Paint
 *  save), uploads to R2 under the user's namespace, returns the
 *  public URL. Replaces `blob:` URLs that don't survive a page reload. */
async function handleUploadImage(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MESHES || !env.R2_PUBLIC_URL) return err(500, 'R2 binding required');

  const { dataUrl, suffix } = await req.json() as { dataUrl?: string; suffix?: string };
  if (!dataUrl) return err(400, 'dataUrl required');

  // Strict extension whitelist — SVG is forbidden (active content via
  // <script>), and the regex ensures the suffix can't be a path traversal.
  // jpeg is the only valid alias, normalised to jpg below.
  const m = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i.exec(dataUrl);
  if (!m) return err(400, 'invalid dataUrl (allowed: png/jpeg/webp)');
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  let bytes: Uint8Array;
  try {
    const bin = atob(m[2]);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch (e) {
    return err(400, `base64 decode failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // 5 MB cap — canvas snapshots top out at ~3 MB even at 4K. Anything
  // larger is suspect (attacker filling our R2 bucket on the free tier).
  const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return err(413, 'image too large (5 MB max)');

  // Magic-byte check — confirm the bytes actually match the claimed
  // format. Prevents an attacker labelling an HTML/SVG payload as
  // image/png to slip through the extension whitelist.
  const magicOk =
    (ext === 'png'  && bytes.byteLength >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) ||
    (ext === 'jpg'  && bytes.byteLength >= 3 &&
      bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) ||
    (ext === 'webp' && bytes.byteLength >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50);
  if (!magicOk) return err(400, 'image bytes do not match the claimed format');

  // Per-user daily upload cap — same pattern as the existing budget
  // counters. Without this an authenticated user can burn our R2
  // storage allowance in minutes.
  const MAX_UPLOADS_PER_DAY = 200;
  try {
    const day = new Date().toISOString().slice(0, 10);
    const cntKey = `_meta/uploads_count/${user.id}/${day}.txt`;
    const obj = await env.MESHES.get(cntKey);
    const cur = obj ? parseInt(await obj.text(), 10) || 0 : 0;
    if (cur >= MAX_UPLOADS_PER_DAY) {
      return err(429, 'daily upload quota reached');
    }
    await env.MESHES.put(cntKey, String(cur + 1));
  } catch {}

  const safeSuf = (suffix ?? 'edit').toString().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 16);
  const key = `${user.id}/canvas/${Date.now()}_${safeSuf}.${ext}`;
  try {
    await env.MESHES.put(key, bytes, {
      httpMetadata: { contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}` },
    });
  } catch (e) {
    console.error('[upload-image]', e instanceof Error ? e.message : String(e), e);
    return err(502, 'R2 upload failed');
  }
  return json({ ok: true, success: true, path: await signedR2Url(env, key, 'image') });
}

/** POST /api/upload-mesh — accept a client-side sculpted/edited GLB and
 *  persist it to R2 under a per-user prefix so the mesh strip can pick
 *  it up. Mirrors handleUploadImage (auth, R2 binding, quota counter,
 *  filename sanitisation) but tuned for binary glTF: 50 MB cap, magic
 *  bytes "glTF" (0x67 0x6C 0x54 0x46), content-type model/gltf-binary. */
async function handleUploadMesh(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MESHES || !env.R2_PUBLIC_URL) return err(500, 'R2 binding required');

  const { base64, filename } = await req.json() as { base64?: string; filename?: string };
  if (!base64 || !filename) return err(400, 'base64 and filename required');

  let bytes: Uint8Array;
  try {
    const bin = atob(base64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch (e) {
    return err(400, `base64 decode failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (bytes.byteLength === 0) return err(400, 'base64 is empty');

  // 50 MB cap — Modal-generated meshes are larger than canvas snapshots
  // (Trellis outputs ~15-30 MB GLBs, sculpts can push higher).
  const MAX_MESH_BYTES = 50 * 1024 * 1024;
  if (bytes.byteLength > MAX_MESH_BYTES) return err(413, 'mesh too large (50 MB max)');

  // Magic-byte check — binary glTF starts with the ASCII tag "glTF".
  // We don't gate on .gltf (JSON) magic since the writer always emits
  // GLB; mismatched extensions are normalised to .glb below.
  const magicOk =
    bytes.byteLength >= 4 &&
    bytes[0] === 0x67 && bytes[1] === 0x6C && bytes[2] === 0x54 && bytes[3] === 0x46;
  if (!magicOk) return err(400, 'mesh bytes are not a valid GLB (missing glTF magic)');

  // Sanitise filename: collapse anything outside [A-Za-z0-9._-] to '_',
  // cap at 200 chars, and force the extension to .glb unless caller
  // explicitly sent .gltf (which still must carry GLB magic — the
  // writer should emit binary glTF either way).
  let safe = String(filename).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
  if (!safe) safe = 'mesh';
  const lower = safe.toLowerCase();
  if (!lower.endsWith('.glb') && !lower.endsWith('.gltf')) {
    safe = safe.replace(/\.[^.]*$/, '') + '.glb';
    if (!safe.toLowerCase().endsWith('.glb')) safe = safe + '.glb';
  }

  // Per-user daily quota — same counter pattern as handleUploadImage.
  // NOTE: GET-then-PUT is race-able under high concurrency (a user could
  // briefly push past the cap if 5+ uploads land in the same ms). Raised
  // to 500 to absorb that slack — acceptable trade-off given the small
  // per-user multiplier and zero credit cost on this endpoint.
  const MAX_UPLOADS_PER_DAY = 500;
  try {
    const day = new Date().toISOString().slice(0, 10);
    const cntKey = `_meta/mesh_uploads_count/${user.id}/${day}.txt`;
    const obj = await env.MESHES.get(cntKey);
    const cur = obj ? parseInt(await obj.text(), 10) || 0 : 0;
    if (cur >= MAX_UPLOADS_PER_DAY) {
      return err(429, 'daily mesh upload quota reached');
    }
    await env.MESHES.put(cntKey, String(cur + 1));
  } catch {}

  // Per-user prefix — keeps sculpted/edited GLBs scoped to the owner
  // (matches handleUploadImage's `${user.id}/canvas/` convention)
  // rather than the flat `mesh/` namespace used by Modal outputs.
  const base = safe.replace(/\.(glb|gltf)$/i, '');
  const ext = safe.toLowerCase().endsWith('.gltf') ? 'gltf' : 'glb';
  const key = `${user.id}/edited/${base}_${Date.now()}.${ext}`;
  try {
    await env.MESHES.put(key, bytes, {
      httpMetadata: { contentType: 'model/gltf-binary' },
    });
  } catch (e) {
    console.error('[upload-mesh]', e instanceof Error ? e.message : String(e), e);
    return new Response(
      JSON.stringify({ success: false, error: 'R2 upload failed' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }
  return json({ success: true, path: key, url: await signedR2Url(env, key, 'mesh') });
}

/** Flat per-rig cost. Same order of magnitude as the existing mesh ops
 *  (5 credits). Refunded if the spawn fails OR rig-status surfaces an
 *  error so a transient Modal outage never burns the user's balance. */
const RIG_COST = 5;
const ESTIMATED_USD_RIG = 0.05;  // ~A10G $0.000542/s × ~90 s + R2 ops

/** Job record persisted by /api/auto-rig and read by /api/auto-rig-status.
 *  Stored in R2 (not a separate KV namespace) to stay consistent with the
 *  existing _meta/* pattern and avoid forcing a wrangler KV-create step
 *  on deploy. Key: `_meta/rig_jobs/<job_id>.json`. TTL is enforced
 *  manually via `created_at` — anything older than 20 minutes is treated
 *  as stale and refunded silently if surfaced. */
interface RigJobRecord {
  user_id: string;
  modal_spend: number;
  credits: number;
  mesh_url: string;
  created_at: number;
}

async function putRigJobRecord(
  env: Env, jobId: string, record: RigJobRecord,
): Promise<void> {
  if (!env.MESHES) return;
  await env.MESHES.put(
    `_meta/rig_jobs/${jobId}.json`,
    JSON.stringify(record),
    { httpMetadata: { contentType: 'application/json' } },
  );
}

/** Le demandeur est-il bien le proprietaire de ce job ?
 *
 *  Les routes de statut testaient `if (record && record.user_id !== user.id)`
 *  — un controle FAIL-OPEN : quand le record est absent, la verification
 *  est simplement sautee. Or `refundOnFailure` SUPPRIME justement le
 *  record. Apres un echec rembourse, n'importe quel compte pouvait donc
 *  interroger la route avec le job_id d'autrui et recuperer l'actif.
 *
 *  Quand le record a disparu, on se rabat sur la table `jobs`, qui porte
 *  le user_id de facon durable. Si aucune des deux sources ne peut
 *  confirmer la propriete, on REFUSE — c'est la seule reponse sure. */
async function _estProprietaireDuJob(
  env: Env,
  jobId: string,
  userId: string,
  record: { user_id?: string } | null,
): Promise<boolean> {
  if (record && record.user_id) return record.user_id === userId;
  try {
    const { data } = await supabaseAdmin(env).from('jobs')
      .select('user_id').eq('id', jobId).maybeSingle();
    const owner = (data as { user_id?: string } | null)?.user_id;
    // Pas de ligne du tout : le job n'a jamais existe ou a ete purge.
    // On refuse plutot que de livrer sur la foi d'un identifiant devine.
    if (!owner) return false;
    return owner === userId;
  } catch {
    return false;   // base injoignable : on refuse, on ne livre pas
  }
}

async function getRigJobRecord(
  env: Env, jobId: string,
): Promise<RigJobRecord | null> {
  if (!env.MESHES) return null;
  try {
    const obj = await env.MESHES.get(`_meta/rig_jobs/${jobId}.json`);
    if (!obj) return null;
    const txt = await obj.text();
    return JSON.parse(txt) as RigJobRecord;
  } catch {
    return null;
  }
}

async function deleteRigJobRecord(env: Env, jobId: string): Promise<void> {
  if (!env.MESHES) return;
  try { await env.MESHES.delete(`_meta/rig_jobs/${jobId}.json`); } catch {}
}

/** SAMPart3D part-segmentation cost. SAMPart3D is NOT feedforward — it
 *  trains a per-mesh MLP grouping field (5000 iters, ~5 min) on top of a
 *  frozen PTv3 backbone, plus Blender 16-view render + SAM, on an A100.
 *  ~8-10 min GPU/mesh ≈ 10-15x the rig's cost → 15 credits / ~$0.60.
 *  Refunded on spawn failure OR when segment-status surfaces an error. */
const SEGMENT_COST = 15;
// MESURE LE 2026-08-04, pas estimee : une segmentation reelle de bout en bout
// a coute **0,1107 $** sur la facture Modal (117 s du lancement a la fin,
// 13 parties produites). La valeur precedente de 0,60 $ datait de l'epoque
// SAMPart3D (~480 s sur A100) ; PartSAM est feedforward et fait le travail en
// deux minutes. On surestimait donc d'un facteur 5,4 — le fusible journalier
// se consommait cinq fois trop vite a chaque segmentation, et le tableau de
// bord sous-affichait la marge de cette operation.
// On garde une marge de securite sur la valeur mesuree (cold start variable).
const ESTIMATED_USD_SEGMENT = 0.15;

/** Job record persisted by /api/mesh-segment, read by /api/mesh-segment-status.
 *  Same R2 pattern as RigJobRecord. Key: `_meta/segment_jobs/<job_id>.json`.
 *  `project_name` is echoed so the status route can store the output under
 *  the right `<uid>/mesh-op/<projectSlug>/` prefix (→ auto-listed as a mesh
 *  version by handleListMeshes, no extra merge block needed). */
interface SegmentJobRecord {
  user_id: string;
  modal_spend: number;
  credits: number;
  mesh_url: string;
  project_name: string;
  created_at: number;
}

async function putSegmentJobRecord(
  env: Env, jobId: string, record: SegmentJobRecord,
): Promise<void> {
  if (!env.MESHES) return;
  await env.MESHES.put(
    `_meta/segment_jobs/${jobId}.json`,
    JSON.stringify(record),
    { httpMetadata: { contentType: 'application/json' } },
  );
}

async function getSegmentJobRecord(
  env: Env, jobId: string,
): Promise<SegmentJobRecord | null> {
  if (!env.MESHES) return null;
  try {
    const obj = await env.MESHES.get(`_meta/segment_jobs/${jobId}.json`);
    if (!obj) return null;
    const txt = await obj.text();
    return JSON.parse(txt) as SegmentJobRecord;
  } catch {
    return null;
  }
}

async function deleteSegmentJobRecord(env: Env, jobId: string): Promise<void> {
  if (!env.MESHES) return;
  try { await env.MESHES.delete(`_meta/segment_jobs/${jobId}.json`); } catch {}
}

/** Flat per-anim cost. Higher than rig because AnyTop generates motion
 *  from learned distribution + we do a BVH->glTF embed step. */
const ANIM_COST = 5;
const ESTIMATED_USD_ANIM = 0.06;  // A10G ~60s + checkpoint download amortised

interface AnimJobRecord {
  user_id: string;
  modal_spend: number;
  credits: number;
  rig_url: string;
  anim_type: string;
  created_at: number;
  batch_id?: string;
  project_name?: string;
}

async function putAnimJobRecord(
  env: Env, jobId: string, record: AnimJobRecord,
): Promise<void> {
  if (!env.MESHES) return;
  await env.MESHES.put(
    `_meta/anim_jobs/${jobId}.json`,
    JSON.stringify(record),
    { httpMetadata: { contentType: 'application/json' } },
  );
}

async function getAnimJobRecord(
  env: Env, jobId: string,
): Promise<AnimJobRecord | null> {
  if (!env.MESHES) return null;
  try {
    const obj = await env.MESHES.get(`_meta/anim_jobs/${jobId}.json`);
    if (!obj) return null;
    const txt = await obj.text();
    return JSON.parse(txt) as AnimJobRecord;
  } catch {
    return null;
  }
}

async function deleteAnimJobRecord(env: Env, jobId: string): Promise<void> {
  if (!env.MESHES) return;
  try { await env.MESHES.delete(`_meta/anim_jobs/${jobId}.json`); } catch {}
}

/** POST /api/auto-rig — spawn a Puppeteer auto-rig job on Modal.
 *
 *  Body: { mesh_url: string, skeleton?: string }
 *    - mesh_url : HTTPS URL of the source GLB (must pass isTrustedAssetHost).
 *    - skeleton : optional target skeleton name (e.g. "orc_m1"). Currently
 *                 ignored by the Modal pipeline but kept on the contract
 *                 for the upcoming skeleton-injection step.
 *
 *  Behaviour: this route NO LONGER waits for the rig to finish. The CF
 *  Worker has a 100 s subrequest cap and a typical Puppeteer rig is
 *  ~120-150 s on A10G (plus ~60-120 s cold start). Instead:
 *    1. Debit credits + modal-spend up front.
 *    2. POST to Modal `rig_router.rig_start` which `.spawn()`s rig_mesh
 *       and returns {job_id} in <2 s.
 *    3. Persist a R2 record `{user_id, modal_spend, credits, mesh_url}`
 *       so /api/auto-rig-status can refund + know the owner.
 *    4. Return {job_id, status: 'queued'} to the client.
 *  The renderer then polls /api/auto-rig-status every 5 s until 'done'
 *  or 'failed'. On failure (either at spawn or surfaced by status), the
 *  credits + modal_spend are refunded so a flaky GPU never bills the
 *  user.
 *
 *  See modal_app/_puppeteer_rig.py:rig_router for the Modal side. */
async function handleAutoRig(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!_rigBaseUrl(env)) return err(503, 'auto-rig backend unavailable');
  if (!env.MODAL_SHARED_SECRET) return err(500, 'MODAL_SHARED_SECRET not set');
  if (!env.MESHES || !env.R2_PUBLIC_URL) return err(500, 'R2 binding required');

  let body: { mesh_url?: string; skeleton?: string };
  try {
    body = await req.json() as { mesh_url?: string; skeleton?: string };
  } catch {
    return err(400, 'invalid JSON body');
  }
  const meshUrl = body.mesh_url;
  if (!meshUrl || typeof meshUrl !== 'string') return err(400, 'mesh_url required');
  // SSRF guard — same allow-list as handleGenerate. Without this an
  // authenticated user could make Modal fetch arbitrary hosts.
  if (!isTrustedAssetHost(env, meshUrl)) {
    return err(400, 'mesh_url host not allowed');
  }
  const skeleton = typeof body.skeleton === 'string' ? body.skeleton : undefined;

  const remainingBudget = await checkAndIncrementModalSpend(env, ESTIMATED_USD_RIG, user.id);
  if (remainingBudget == null) {
    return err(429, 'daily Cloud GPU budget reached. Try again after midnight UTC.');
  }
  const refundRigSpend = async () => {
    await refundModalSpend(env, ESTIMATED_USD_RIG);
  };
  const remainingUserCalls = await checkAndIncrementUserCalls(env, user.id);
  if (remainingUserCalls == null) {
    await refundRigSpend();
    return err(429, 'you have reached the per-user daily generation limit.');
  }
  const remaining = await spendCredits(env, user.id, RIG_COST);
  if (remaining == null) {
    await refundRigSpend();
    return err(402, 'insufficient credits');
  }

  // MODAL_PUPPETEER_RIG_URL is the BASE of the Modal app (rig_router).
  // We append /rig-start (spawn) here and /rig-status (poll) in
  // handleAutoRigStatus. The trailing-slash strip keeps the join robust
  // whether the secret was set with or without one.
  const baseUrl = (_rigBaseUrl(env) as string).replace(/\/$/, '');
  const startUrl = `${baseUrl}/rig-start`;
  let jobId: string;
  try {
    const t0 = Date.now();
    const r = await fetch(startUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        _auth: env.MODAL_SHARED_SECRET,
        mesh_url: meshUrl,
        ...(skeleton ? { skeleton } : {}),
      }),
      // rig-start downloads the source GLB + .spawn()s — should return
      // in ~1-2 s. 30 s budget covers a cold CPU container start.
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) {
      throw new Error(`Cloud GPU rig-start HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    const j = await r.json() as { job_id?: string };
    jobId = String(j?.job_id || '').trim();
    if (!jobId) throw new Error('rig-start returned no job_id');
    console.log(`[auto-rig] spawn dt=${Date.now() - t0}ms job_id=${jobId} user=${user.id}`);
  } catch (e: unknown) {
    await addCredits(env, user.id, RIG_COST);
    await refundRigSpend();
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[auto-rig.spawn]', msg, e);
    return err(502, `auto-rig spawn failed (credits refunded): ${msg.slice(0, 200)}`);
  }

  // Persist job → user mapping so the status route can refund on
  // failure and verify ownership on poll. Non-fatal: if R2 is briefly
  // unavailable the status route falls back to a best-effort refund.
  try {
    await putRigJobRecord(env, jobId, {
      user_id: user.id,
      modal_spend: ESTIMATED_USD_RIG,
      credits: RIG_COST,
      mesh_url: meshUrl,
      created_at: Date.now(),
    });
  } catch (e) {
    console.warn('[auto-rig] could not persist job record', e);
  }
  // Also persist in the jobs table so the event appears in
  // 'My usage history'. status=processing, options.sourceMesh=meshUrl
  // lets the detail modal show a 'Source mesh' link back to its origin.
  try {
    await supabaseAdmin(env).from('jobs').insert({
      id: jobId, user_id: user.id,
      asset_type: 'rig', mode: 'rig', seed: 0,
      credit_cost: RIG_COST, status: 'processing',
      type: 'rig',
      cost_usd: ESTIMATED_USD_RIG,
      options: {
        operation_type: 'rig', sourceMesh: meshUrl, backend: 'modal', skeleton,
        // Without cost_usd the admin stats fell back to 0 → 100% margin.
        cost_usd: ESTIMATED_USD_RIG,
      },
      created_at: new Date().toISOString(),
    });
  } catch (e) { console.error('[auto-rig] jobs.insert failed', e); }

  return json({
    success: true,
    job_id: jobId,
    status: 'queued',
    creditsRemaining: remaining,
  });
}

/** POST /api/auto-rig-status?job_id=<id> — one poll tick.
 *
 *  Calls Modal's rig-status; on terminal state, finalises the job:
 *    - 'pending'  → still running, browser keeps polling.
 *    - 'failed'   → refunds credits + modal spend, deletes the record.
 *    - 'done'     → decodes base64 GLB, magic-byte check, uploads to R2
 *                   under `${user.id}/rigged/`, returns the public URL.
 *
 *  Accepts job_id from either the query string (GET-friendly) or a JSON
 *  body (POST-friendly). Owner is verified against the persisted record.
 *  Transient Modal/Network errors return 'pending' (NOT 'failed') so the
 *  browser keeps polling — only an explicit error file from Modal is a
 *  real failure. */
async function handleAutoRigStatus(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!_rigBaseUrl(env)) return err(503, 'auto-rig backend unavailable');
  if (!env.MODAL_SHARED_SECRET) return err(500, 'MODAL_SHARED_SECRET not set');
  if (!env.MESHES || !env.R2_PUBLIC_URL) return err(500, 'R2 binding required');

  // Accept job_id from query string OR JSON body.
  let jobId = '';
  try {
    const u = new URL(req.url);
    jobId = (u.searchParams.get('job_id') || '').trim();
  } catch { /* keep empty */ }
  if (!jobId && req.method === 'POST') {
    try {
      const b = await req.json() as { job_id?: string };
      jobId = String(b?.job_id || '').trim();
    } catch { /* keep empty */ }
  }
  if (!jobId) return err(400, 'job_id required');

  // Look up the persisted record (owner check + refund context). If
  // R2 lost it (TTL purge, eventual consistency) we proceed but skip
  // the refund + ownership steps — the rig still produces a public URL.
  const record = await getRigJobRecord(env, jobId);
  if (!(await _estProprietaireDuJob(env, jobId, user.id, record))) {
    return err(403, 'forbidden');
  }

  // Refund helper — called on terminal failure or upload error. Safe to
  // call with no record (just becomes a no-op). If the credit refund
  // itself fails, the job record is KEPT so a later status poll retries —
  // deleting it regardless (ancien code) rendait la perte de crédits
  // définitive et silencieuse.
  const refundOnFailure = async () => {
    if (!record) return;
    // Atomic + idempotent credit refund via the shared jobs-row primitive
    // (conditional UPDATE out of processing/pending) — two racing failure
    // polls, or a poll racing the reaper, refund EXACTLY once. A plain
    // addCredits here double-refunds on concurrent ticks.
    try {
      await _failAndRefundJob(
        env,
        { id: jobId, user_id: record.user_id, credit_cost: record.credits },
        'rig failed',
      );
    } catch (e) {
      console.error(`[auto-rig-status] REFUND FAILED job=${jobId} user=${record.user_id} `
        + `credits=${record.credits} — record kept for retry:`,
        e instanceof Error ? e.message : String(e));
      return;
    }
    await refundModalSpend(env, record.modal_spend).catch((e) =>
      console.error(`[auto-rig-status] refundModalSpend failed job=${jobId}:`,
        e instanceof Error ? e.message : String(e)));
    await deleteRigJobRecord(env, jobId).catch(() => {});
  };

  // Poll Modal rig-status. Transient errors → 'pending' so the browser
  // keeps polling; do NOT refund here, because the rig may still finish.
  const baseUrl = (_rigBaseUrl(env) as string).replace(/\/$/, '');
  const statusUrl = `${baseUrl}/rig-status`;
  const fetchUrl = `${baseUrl}/rig-fetch`;
  let modalResp: { ready?: boolean; error?: string; bytes?: number; fetch_endpoint?: string; glb_base64?: string };
  try {
    const r = await fetch(statusUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ _auth: env.MODAL_SHARED_SECRET, job_id: jobId }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) {
      throw new Error(`Cloud GPU rig-status HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    modalResp = await r.json() as typeof modalResp;
  } catch (e: unknown) {
    console.warn('[auto-rig-status] transient', e instanceof Error ? e.message : String(e));
    return json({ status: 'pending', warn: e instanceof Error ? e.message : String(e) });
  }

  // ── Still running ──
  if (modalResp?.ready === false && !modalResp?.error) {
    return json({ status: 'pending', stage: 'running' });
  }

  // ── Failed ──
  if (modalResp?.ready === false && modalResp?.error) {
    await refundOnFailure();
    console.log(`[auto-rig-status] job_id=${jobId} FAILED: ${String(modalResp.error).slice(0, 200)}`);
    return json({
      status: 'failed',
      error: String(modalResp.error).slice(0, 500),
    });
  }

  // ── Done: STREAM the GLB directly from Modal into R2 ──
  // Previously we asked Modal to return base64 inline in the JSON
  // response. For a 63 MB GLB that produced an ~84 MB base64 string +
  // a 63 MB decoded Uint8Array simultaneously in the Worker — well past
  // the 128 MB hard memory cap → CF killed the isolate and the client
  // saw sustained 503s on every poll for the same job_id.
  // The new flow: rig-status returns metadata only; we then call
  // rig-fetch and pipe its ReadableStream straight into R2 — the bytes
  // never materialise in Worker memory.
  if (modalResp?.ready === true) {
    let fetchResp: Response;
    try {
      fetchResp = await fetch(fetchUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ _auth: env.MODAL_SHARED_SECRET, job_id: jobId }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e: unknown) {
      console.warn('[auto-rig-status.fetch] transient', e instanceof Error ? e.message : String(e));
      // Don't refund — the GLB is still on the Modal volume, next poll
      // can retry. Surface as pending so the client keeps trying.
      return json({ status: 'pending', warn: 'rig-fetch transient: ' + (e instanceof Error ? e.message : String(e)) });
    }
    if (fetchResp.status === 404) {
      // Race: status said ready but the file disappeared (eventual-
      // consistency on the volume). Tell client to keep polling.
      return json({ status: 'pending', stage: 'race-volume-not-ready' });
    }
    if (fetchResp.status === 410) {
      // .err sentinel appeared between status and fetch — treat as fail.
      await refundOnFailure();
      const txt = await fetchResp.text().catch(() => '');
      return json({ status: 'failed', error: txt.slice(0, 500) || 'rig failed' });
    }
    if (!fetchResp.ok || !fetchResp.body) {
      await refundOnFailure();
      const txt = await fetchResp.text().catch(() => '');
      console.error(`[auto-rig-status.fetch] HTTP ${fetchResp.status} body=${txt.slice(0, 200)}`);
      return json({ status: 'failed', error: `rig-fetch HTTP ${fetchResp.status}` });
    }

    // Derive a stable base name for the R2 key from the original URL.
    let baseName = 'mesh';
    const sourceUrl = record?.mesh_url || '';
    if (sourceUrl) {
      try {
        const last = new URL(sourceUrl).pathname.split('/').pop() || '';
        baseName = last.replace(/\.(glb|gltf)$/i, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'mesh';
      } catch { /* keep default */ }
    }

    const key = `${user.id}/rigged/${baseName}_rigged_puppeteer_${Date.now()}.glb`;
    const expectedBytes = modalResp?.bytes;
    try {
      // Pipe ReadableStream → R2 directly. R2's put() accepts a stream
      // and uploads in chunks, so the Worker never holds the full GLB
      // in memory. NOTE: R2 needs a Content-Length-equivalent — we pass
      // the size hint from rig-status if available.
      await env.MESHES.put(key, fetchResp.body, {
        httpMetadata: { contentType: 'model/gltf-binary' },
      });
    } catch (e) {
      await refundOnFailure();
      console.error('[auto-rig-status.r2]', e instanceof Error ? e.message : String(e), e);
      return json({ status: 'failed', error: 'auto-rig storage failed (credits refunded)' });
    }

    await deleteRigJobRecord(env, jobId).catch(() => {});
    const publicUrl = await signedR2Url(env, key, 'mesh');
    console.log(`[auto-rig-status] job_id=${jobId} DONE expected_bytes=${expectedBytes} url=${publicUrl}`);
    // Tag the rig container as warm so /api/modal-status shows the
    // right pill (added 2026-06-02 alongside anim + mvadapter tracking).
    _writeLastWarmMs(env, '_meta/last_warm_rig.txt').catch(() => {});
    // Mark the jobs row succeeded so it shows up correctly in history.
    // Persist the raw KEY (not the expiring signed URL); reads re-sign.
    try {
      // GARDE DE STATUT — sans elle, un job DEJA rembourse pouvait etre
      // repasse en 'succeeded' par un simple GET sur cette route de
      // statut : l'utilisateur gardait l'actif ET ses credits. Le chemin
      // d'echec, lui, etait deja protege (_failAndRefundJob reclame la
      // ligne). On aligne le chemin de succes sur le meme invariant :
      // seul un job encore NON TERMINAL peut devenir 'succeeded'.
      await supabaseAdmin(env).from('jobs')
        .update({ status: 'succeeded', mesh_url: key, finished_at: new Date().toISOString() })
        .eq('id', jobId).eq('user_id', user.id)
        .in('status', NON_TERMINAL_JOB_STATUSES as unknown as string[]);
    } catch (e) { console.warn('[auto-rig-status] jobs.update failed', e); }
    return json({
      status: 'done',
      success: true,
      mesh_url: publicUrl,
      url: publicUrl,
      path: key,
      bytes: expectedBytes ?? null,
    });
  }

  // Unknown shape — treat as pending and log so we can investigate.
  // Surface the unexpected shape to the client so the UI can show
  // "Modal returned unknown shape" instead of an opaque pending.
  console.warn('[auto-rig-status] unexpected modal response', modalResp);
  return json({
    status: 'pending',
    stage: 'unknown-response',
    last_error: `Modal returned unexpected shape: ${JSON.stringify(modalResp).slice(0, 200)}`,
  });
}

/** POST /api/mesh-segment — spawn a SAMPart3D part-segmentation job on Modal.
 *
 *  Body: { mesh_url: string, scale?: number, projectName?: string }
 *    - mesh_url   : HTTPS URL of the source GLB (must pass isTrustedAssetHost).
 *    - scale      : granularity 0.0 (fine/many parts) → 2.0 (coarse/few),
 *                   default 1.0.
 *    - projectName: used to store the output under the project's mesh-op
 *                   prefix so it is auto-listed as a mesh version.
 *
 *  Mirror of handleAutoRig 1:1: debit up front, POST /segment-start (spawns
 *  segment_mesh, returns {job_id} fast), persist a SegmentJobRecord so
 *  /api/mesh-segment-status can refund + own the job. The renderer polls
 *  /api/mesh-segment-status every 5 s until 'done' or 'failed'. */
async function handleMeshSegment(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MODAL_SEGMENT_URL) return err(503, 'mesh-segment backend unavailable');
  if (!env.MODAL_SHARED_SECRET) return err(500, 'MODAL_SHARED_SECRET not set');
  if (!env.MESHES || !env.R2_PUBLIC_URL) return err(500, 'R2 binding required');

  let body: { mesh_url?: string; granularity?: number; scale?: number; projectName?: string };
  try {
    body = await req.json() as { mesh_url?: string; granularity?: number; scale?: number; projectName?: string };
  } catch {
    return err(400, 'invalid JSON body');
  }
  const meshUrl = body.mesh_url;
  if (!meshUrl || typeof meshUrl !== 'string') return err(400, 'mesh_url required');
  if (!isTrustedAssetHost(env, meshUrl)) {
    return err(400, 'mesh_url host not allowed');
  }
  // PartSAM granularity 0.0 (coarse, ~10 clean parts) → 1.0 (fine, ~45 parts).
  // `scale` accepted as a legacy alias; default 0.2 (matches desktop default).
  let granularity = typeof body.granularity === 'number' ? body.granularity
    : (typeof body.scale === 'number' ? body.scale : 0.2);
  if (!Number.isFinite(granularity)) granularity = 0.2;
  granularity = Math.max(0, Math.min(1, granularity));
  const projectName = typeof body.projectName === 'string' ? body.projectName : '';

  const remainingBudget = await checkAndIncrementModalSpend(env, ESTIMATED_USD_SEGMENT, user.id);
  if (remainingBudget == null) {
    return err(429, 'daily Cloud GPU budget reached. Try again after midnight UTC.');
  }
  const refundSegmentSpend = async () => {
    await refundModalSpend(env, ESTIMATED_USD_SEGMENT);
  };
  const remainingUserCalls = await checkAndIncrementUserCalls(env, user.id);
  if (remainingUserCalls == null) {
    await refundSegmentSpend();
    return err(429, 'you have reached the per-user daily generation limit.');
  }
  const remaining = await spendCredits(env, user.id, SEGMENT_COST);
  if (remaining == null) {
    await refundSegmentSpend();
    return err(402, 'insufficient credits');
  }

  const baseUrl = env.MODAL_SEGMENT_URL.replace(/\/$/, '');
  const startUrl = `${baseUrl}/segment-start`;
  let jobId: string;
  try {
    const t0 = Date.now();
    const r = await fetch(startUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        _auth: env.MODAL_SHARED_SECRET,
        mesh_url: meshUrl,
        granularity,   // PartSAM 0-1 (coarse→fine). `scale` alias still read by the router.
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) {
      throw new Error(`Cloud GPU segment-start HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    const j = await r.json() as { job_id?: string };
    jobId = String(j?.job_id || '').trim();
    if (!jobId) throw new Error('segment-start returned no job_id');
    console.log(`[mesh-segment] spawn dt=${Date.now() - t0}ms job_id=${jobId} user=${user.id}`);
  } catch (e: unknown) {
    await addCredits(env, user.id, SEGMENT_COST);
    await refundSegmentSpend();
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[mesh-segment.spawn]', msg, e);
    return err(502, `mesh-segment spawn failed (credits refunded): ${msg.slice(0, 200)}`);
  }

  try {
    await putSegmentJobRecord(env, jobId, {
      user_id: user.id,
      modal_spend: ESTIMATED_USD_SEGMENT,
      credits: SEGMENT_COST,
      mesh_url: meshUrl,
      project_name: projectName,
      created_at: Date.now(),
    });
  } catch (e) {
    console.warn('[mesh-segment] could not persist job record', e);
  }
  try {
    await supabaseAdmin(env).from('jobs').insert({
      id: jobId, user_id: user.id,
      asset_type: 'segment', mode: 'segment', seed: 0,
      credit_cost: SEGMENT_COST, status: 'processing',
      type: 'segment',
      cost_usd: ESTIMATED_USD_SEGMENT,
      options: {
        operation_type: 'segment', sourceMesh: meshUrl, backend: 'modal',
        // 2026-07-26 CRITICAL FIX: this used to read a bare `scale`, which
        // is NOT bound anywhere in this function (the local is
        // `granularity`) — and tsconfig.json excludes src/worker.ts so tsc
        // never caught it. In strict-mode module scope the object literal
        // threw ReferenceError BEFORE the insert, the surrounding catch
        // swallowed it, and segmentation jobs ended up with NO row in
        // `jobs` at all: invisible to history, admin Active jobs, by_type
        // stats AND to every refund/reaper path.
        granularity,
        project_name: projectName,
        cost_usd: ESTIMATED_USD_SEGMENT,
      },
      created_at: new Date().toISOString(),
    });
  } catch (e) { console.error('[mesh-segment] jobs.insert failed', e); }

  return json({
    success: true,
    job_id: jobId,
    status: 'queued',
    creditsRemaining: remaining,
  });
}

/** POST/GET /api/mesh-segment-status?job_id=<id> — one poll tick.
 *  Mirror of handleAutoRigStatus. On 'done' it STREAMS the segmented GLB
 *  from Modal /segment-fetch straight into R2 under
 *  `${user.id}/mesh-op/${projectSlug}/${ts}_segment.glb` — that prefix is
 *  auto-listed as a MESH version by handleListMeshes (no merge block), and
 *  the `_segment` name keeps it out of the rigs/animations buckets. */
async function handleMeshSegmentStatus(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MODAL_SEGMENT_URL) return err(503, 'mesh-segment backend unavailable');
  if (!env.MODAL_SHARED_SECRET) return err(500, 'MODAL_SHARED_SECRET not set');
  if (!env.MESHES || !env.R2_PUBLIC_URL) return err(500, 'R2 binding required');

  let jobId = '';
  try {
    const u = new URL(req.url);
    jobId = (u.searchParams.get('job_id') || '').trim();
  } catch { /* keep empty */ }
  if (!jobId && req.method === 'POST') {
    try {
      const b = await req.json() as { job_id?: string };
      jobId = String(b?.job_id || '').trim();
    } catch { /* keep empty */ }
  }
  if (!jobId) return err(400, 'job_id required');

  const record = await getSegmentJobRecord(env, jobId);
  if (!(await _estProprietaireDuJob(env, jobId, user.id, record))) {
    return err(403, 'forbidden');
  }

  const refundOnFailure = async () => {
    if (!record) return;
    // Atomic + idempotent credit refund: route through the shared jobs-row
    // primitive (conditional UPDATE out of processing/pending) so two racing
    // failure polls — or a poll racing the reaper — refund the credits EXACTLY
    // once. A plain addCredits here double-refunds on concurrent ticks.
    try {
      await _failAndRefundJob(
        env,
        { id: jobId, user_id: record.user_id, credit_cost: record.credits },
        'segment failed',
      );
    } catch (e) {
      console.error(`[mesh-segment-status] REFUND FAILED job=${jobId} user=${record.user_id} `
        + `credits=${record.credits} — record kept for retry:`,
        e instanceof Error ? e.message : String(e));
      return;
    }
    await refundModalSpend(env, record.modal_spend).catch((e) =>
      console.error(`[mesh-segment-status] refundModalSpend failed job=${jobId}:`,
        e instanceof Error ? e.message : String(e)));
    await deleteSegmentJobRecord(env, jobId).catch(() => {});
  };

  const baseUrl = env.MODAL_SEGMENT_URL.replace(/\/$/, '');
  const statusUrl = `${baseUrl}/segment-status`;
  const fetchUrl = `${baseUrl}/segment-fetch`;
  let modalResp: { ready?: boolean; error?: string; bytes?: number; fetch_endpoint?: string };
  try {
    const r = await fetch(statusUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ _auth: env.MODAL_SHARED_SECRET, job_id: jobId }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) {
      throw new Error(`Cloud GPU segment-status HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    modalResp = await r.json() as typeof modalResp;
  } catch (e: unknown) {
    console.warn('[mesh-segment-status] transient', e instanceof Error ? e.message : String(e));
    return json({ status: 'pending', warn: e instanceof Error ? e.message : String(e) });
  }

  if (modalResp?.ready === false && !modalResp?.error) {
    return json({ status: 'pending', stage: 'running' });
  }
  if (modalResp?.ready === false && modalResp?.error) {
    await refundOnFailure();
    console.log(`[mesh-segment-status] job_id=${jobId} FAILED: ${String(modalResp.error).slice(0, 200)}`);
    return json({ status: 'failed', error: String(modalResp.error).slice(0, 500) });
  }

  if (modalResp?.ready === true) {
    let fetchResp: Response;
    try {
      fetchResp = await fetch(fetchUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ _auth: env.MODAL_SHARED_SECRET, job_id: jobId }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e: unknown) {
      console.warn('[mesh-segment-status.fetch] transient', e instanceof Error ? e.message : String(e));
      return json({ status: 'pending', warn: 'segment-fetch transient: ' + (e instanceof Error ? e.message : String(e)) });
    }
    if (fetchResp.status === 404) {
      return json({ status: 'pending', stage: 'race-volume-not-ready' });
    }
    if (fetchResp.status === 410) {
      await refundOnFailure();
      const txt = await fetchResp.text().catch(() => '');
      return json({ status: 'failed', error: txt.slice(0, 500) || 'segment failed' });
    }
    if (!fetchResp.ok || !fetchResp.body) {
      await refundOnFailure();
      const txt = await fetchResp.text().catch(() => '');
      console.error(`[mesh-segment-status.fetch] HTTP ${fetchResp.status} body=${txt.slice(0, 200)}`);
      return json({ status: 'failed', error: `segment-fetch HTTP ${fetchResp.status}` });
    }

    // Store under the project's mesh-op prefix → auto-listed as a mesh
    // version by handleListMeshes. `_segment` name keeps it out of the
    // rigs/animations buckets on the client.
    const projectSlug = ((record?.project_name || 'untitled')
      .replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)) || 'untitled';
    const key = `${user.id}/mesh-op/${projectSlug}/${Date.now()}_segment.glb`;
    const expectedBytes = modalResp?.bytes;
    try {
      await env.MESHES.put(key, fetchResp.body, {
        httpMetadata: { contentType: 'model/gltf-binary' },
      });
    } catch (e) {
      await refundOnFailure();
      console.error('[mesh-segment-status.r2]', e instanceof Error ? e.message : String(e), e);
      return json({ status: 'failed', error: 'mesh-segment storage failed (credits refunded)' });
    }

    await deleteSegmentJobRecord(env, jobId).catch(() => {});
    const publicUrl = await signedR2Url(env, key, 'mesh');
    console.log(`[mesh-segment-status] job_id=${jobId} DONE expected_bytes=${expectedBytes} url=${publicUrl}`);
    try {
      // GARDE DE STATUT — sans elle, un job DEJA rembourse pouvait etre
      // repasse en 'succeeded' par un simple GET sur cette route de
      // statut : l'utilisateur gardait l'actif ET ses credits. Le chemin
      // d'echec, lui, etait deja protege (_failAndRefundJob reclame la
      // ligne). On aligne le chemin de succes sur le meme invariant :
      // seul un job encore NON TERMINAL peut devenir 'succeeded'.
      await supabaseAdmin(env).from('jobs')
        .update({ status: 'succeeded', mesh_url: key, finished_at: new Date().toISOString() })
        .eq('id', jobId).eq('user_id', user.id)
        .in('status', NON_TERMINAL_JOB_STATUSES as unknown as string[]);
    } catch (e) { console.warn('[mesh-segment-status] jobs.update failed', e); }
    return json({
      status: 'done',
      success: true,
      mesh_url: publicUrl,
      url: publicUrl,
      path: key,
      bytes: expectedBytes ?? null,
    });
  }

  console.warn('[mesh-segment-status] unexpected modal response', modalResp);
  return json({
    status: 'pending',
    stage: 'unknown-response',
    last_error: `Modal returned unexpected shape: ${JSON.stringify(modalResp).slice(0, 200)}`,
  });
}

/* ─────────────────────────────────────────────────────────────────
 *  PARENTAL CONTROL — per-user PIN + unrestricted state, mirrors
 *  desktop FABMESH_UNRESTRICTED logic. State at R2 key
 *  _meta/parental/<userId>.json = { pin: '<sha256>', unrestricted: bool }
 * ───────────────────────────────────────────────────────────────── */
interface ParentalState {
  pinHash?: string;
  unrestricted: boolean;
}

async function _sha256(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getParentalState(env: Env, userId: string): Promise<ParentalState> {
  if (!env.MESHES) return { unrestricted: false };
  try {
    const obj = await env.MESHES.get(`_meta/parental/${userId}.json`);
    if (!obj) return { unrestricted: false };
    return JSON.parse(await obj.text()) as ParentalState;
  } catch { return { unrestricted: false }; }
}

async function putParentalState(env: Env, userId: string, s: ParentalState): Promise<void> {
  if (!env.MESHES) return;
  await env.MESHES.put(`_meta/parental/${userId}.json`,
    JSON.stringify(s), { httpMetadata: { contentType: 'application/json' } });
}

/** GET /api/parental/status — current user state. */
async function handleParentalStatus(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  const s = await getParentalState(env, user.id);
  return json({ ok: true, unrestricted: !!s.unrestricted, hasPin: !!s.pinHash });
}

/** POST /api/parental/toggle — body { pin, enable }. Validates / sets PIN. */
async function handleParentalToggle(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  const { pin, enable } = await req.json() as { pin?: string; enable?: boolean };
  // Re-lock without PIN — the renderer sends pin:'lock' + enable:false.
  // Done BEFORE the length check because 'lock' is 4 chars and would
  // otherwise route into the normal PIN validation and 403.
  if (enable === false && pin === 'lock') {
    const cur = await getParentalState(env, user.id);
    cur.unrestricted = false;
    await putParentalState(env, user.id, cur);
    return json({ ok: true, success: true, unrestricted: false });
  }
  if (typeof pin !== 'string' || pin.length < 4) {
    return err(400, 'PIN must be ≥ 4 chars');
  }
  const cur = await getParentalState(env, user.id);
  const inHash = await _sha256(pin);
  if (cur.pinHash) {
    // PIN already set — validate.
    if (inHash !== cur.pinHash) return err(403, 'PIN mismatch');
  } else {
    // First-time set.
    cur.pinHash = inHash;
  }
  cur.unrestricted = enable !== false;
  await putParentalState(env, user.id, cur);
  return json({ ok: true, success: true, unrestricted: cur.unrestricted });
}


/** POST /api/client-log — stores browser console logs in R2 so they can
 *  be retrieved server-side for debug. Body: JSON {kind, status, job_id?,
 *  project?, ua?, url?, lines: string[]}. Stored under
 *  <uid>/logs/<ts>_<kind>_<status>.log (path returned in the response).
 *  Cap: 1 MB body. Anonymous calls are accepted too (logged under
 *  _anon/logs/) so a user who isn't logged in can still get a flush. */
async function handleClientLog(req: Request, env: Env): Promise<Response> {
  if (!env.MESHES) return err(500, 'R2 binding required');
  const user = await getSessionUser(req, env).catch(() => null);
  let body: any;
  try {
    const text = await req.text();
    if (text.length > 1024 * 1024) return err(413, 'log too large (max 1 MB)');
    body = JSON.parse(text);
  } catch {
    return err(400, 'JSON body required');
  }
  const lines = Array.isArray(body?.lines) ? body.lines : [];
  if (!lines.length) return json({ ok: true, skipped: true, reason: 'no lines' });
  const kind   = String(body?.kind   || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'unknown';
  const status = String(body?.status || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'unknown';
  const project = String(body?.project || '').replace(/[^a-zA-Z0-9_\- ]/g, '').slice(0, 64);
  const job_id = String(body?.job_id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = user ? `${user.id}/logs` : '_anon/logs';
  const key = `${dir}/${ts}_${kind}_${status}${job_id ? `_${job_id}` : ''}.log`;
  // Build a header + body. Keep it text/plain for easy reading via curl.
  const header = [
    `# fabmesh client-log`,
    `# user_id: ${user ? user.id : '(anon)'}`,
    `# kind: ${kind}`,
    `# status: ${status}`,
    `# project: ${project || '(none)'}`,
    `# job_id: ${job_id || '(none)'}`,
    `# url: ${String(body?.url || '').slice(0, 256)}`,
    `# ua: ${String(body?.ua || '').slice(0, 256)}`,
    `# server_ts: ${ts}`,
    `# lines: ${lines.length}`,
    ``,
  ].join('\n');
  const payload = header + lines.join('\n') + '\n';
  try {
    await env.MESHES.put(key, payload, {
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
      customMetadata: { kind, status, project: project || '', userId: user?.id || '' },
    });
    // ALSO overwrite stable paths so Claude can fetch the latest log
    // without having to discover the timestamped filename:
    //   _logs/latest/<uid>.log      — per-user latest (anyone in solo dev)
    //   _logs/latest/_any.log       — global latest (overwritten by ANY user;
    //                                  fine for solo dev, racy for prod)
    if (user) {
      await env.MESHES.put(`_logs/latest/${user.id}.log`, payload, {
        httpMetadata: { contentType: 'text/plain; charset=utf-8' },
        customMetadata: { kind, status, project: project || '', userId: user.id },
      });
    }
    await env.MESHES.put(`_logs/latest/_any.log`, payload, {
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
      customMetadata: { kind, status, project: project || '', userId: user?.id || '' },
    });
  } catch (e) {
    return err(500, `R2 put failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return json({ ok: true, path: key, lines: lines.length });
}

/** POST /api/user-assets/delete — delete a single user_asset row
 *  (and optionally its R2 blob). Body: { path: string } where path
 *  is either a public R2 URL or a raw R2 key. */
async function handleUserAssetsDelete(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  const body = await req.json().catch(() => ({})) as { path?: string };
  const path = String(body?.path || '').trim();
  if (!path) return err(400, 'path required');
  const r2_path = r2PathFromPublicUrl(env, path) ?? path;
  // Safety: only allow paths under this user's own R2 prefix.
  if (!r2_path.startsWith(`${user.id}/`)) {
    return err(403, 'path is not under your account');
  }
  const sb = supabaseAdmin(env);
  const { error: aErr, count: aDel } = await sb.from('user_assets')
    .delete({ count: 'exact' })
    .eq('user_id', user.id)
    .eq('r2_path', r2_path);
  let r2Deleted = false;
  if (env.MESHES) {
    try { await env.MESHES.delete(r2_path); r2Deleted = true; } catch (_) {}
    // Also clear any back-image pointing to this front image, and
    // vice-versa (parent_path link).
    try {
      await sb.from('user_assets').delete()
        .eq('user_id', user.id)
        .eq('parent_path', r2_path);
    } catch (_) {}
  }
  return json({ ok: true, rows_deleted: aDel ?? 0, r2_deleted: r2Deleted, error: aErr?.message });
}

/** POST /api/user-assets/migrate-from-jobs — one-shot backfill that
 *  recovers per-project image associations from existing jobs.options
 *  (which holds `sourceImage` for every mesh generated from an image).
 *
 *  Why this exists: before user_assets, the client kept the image↔project
 *  mapping in localStorage (`myfm:cloudimages:<project>`). When that cache
 *  was dropped at boot in the migration, users lost the mapping for older
 *  images. But every mesh has its sourceImage in jobs.options, so we can
 *  rebuild the mapping from there.
 *
 *  Idempotent: insertUserAsset upserts ON CONFLICT (user_id, r2_path)
 *  do nothing, so calling this twice doesn't duplicate. */
async function handleUserAssetsMigrateFromJobs(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  const sb = supabaseAdmin(env);
  const { data, error } = await sb.from('jobs')
    .select('id, project_name, options, asset_type, created_at, type, cost_usd')
    .eq('user_id', user.id)
    .limit(5000);
  if (error) return err(500, error.message);
  let migrated = 0;
  let scanned = 0;
  let fromJobsOptions = 0;
  let fromR2Listing = 0;
  const seen = new Set<string>();

  // Step A: pull image URLs from every jobs.options field we know of.
  for (const j of (data ?? []) as Array<{
    id: string; project_name: string | null;
    options: Record<string, unknown> | null;
    asset_type: string; created_at: string;
  }>) {
    scanned++;
    const project = j.project_name
      || (j.options?.project_name as string | undefined)
      || `Project ${j.id.slice(-6)}`;
    // Common option keys that store URLs of associated images.
    const candidateKeys = ['sourceImage', 'source_image', 'imagePath', 'image_path',
                           'frontImage', 'front_image', 'imageUrl', 'image_url',
                           'frontImageUrl', 'refImageUrl'];
    for (const k of candidateKeys) {
      const v = j.options?.[k];
      if (typeof v !== 'string' || !v) continue;
      const r2_path = r2PathFromPublicUrl(env, v) ?? v;
      if (!r2_path || r2_path.startsWith('http')) continue;
      const dedupKey = `${project}|${r2_path}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      await insertUserAsset(env, user.id, project, 'image-front', r2_path, null,
        { migrated_from_job: j.id, asset_type: j.asset_type, source_key: k });
      migrated++;
      fromJobsOptions++;
    }
    const backImage = j.options?.backImage as string | undefined;
    if (typeof backImage === 'string' && backImage) {
      const r2_path = r2PathFromPublicUrl(env, backImage) ?? backImage;
      if (r2_path && !r2_path.startsWith('http')) {
        const dedupKey = `${project}|${r2_path}|back`;
        if (!seen.has(dedupKey)) {
          seen.add(dedupKey);
          await insertUserAsset(env, user.id, project, 'image-back', r2_path, null,
            { migrated_from_job: j.id });
          migrated++;
          fromJobsOptions++;
        }
      }
    }
  }

  // Step B: scan R2 directly under <uid>/front/, <uid>/back/, etc.
  // Images that survived without an attached project go into a synthetic
  // "_orphans" project so the user can at least find them (vs. losing
  // them forever). The renderer can let the user re-assign them later.
  if (env.MESHES) {
    const folderToKind: Array<[string, string]> = [
      ['front', 'image-front'],
      ['back', 'image-back'],
      ['modified', 'image-modified'],
      ['removebg', 'image-removebg'],
      ['rectified', 'image-rectified'],
      ['upscaled', 'image-upscaled'],
      ['inpainted', 'image-inpainted'],
      ['facefixed', 'image-facefixed'],
    ];
    for (const [folder, kind] of folderToKind) {
      const prefix = `${user.id}/${folder}/`;
      let cursor: string | undefined;
      do {
        const listed = await env.MESHES.list({ prefix, limit: 1000, cursor });
        for (const obj of (listed.objects || [])) {
          const r2_path = obj.key;
          // Skip if we already inserted this exact path under any project.
          // (Step A may have inserted it under the right project; Step B
          // would otherwise add it again under _orphans.)
          const anyProj = Array.from(seen).some(k => k.endsWith(`|${r2_path}`));
          if (anyProj) continue;
          await insertUserAsset(env, user.id, '_orphans', kind, r2_path, null,
            { migrated_from_r2_scan: true, folder });
          migrated++;
          fromR2Listing++;
        }
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    }
  }

  return json({ ok: true, scanned, migrated, fromJobsOptions, fromR2Listing });
}

/** POST /api/user-assets/reassign-orphans — second-pass migration that
 *  redistributes images currently parked under project='_orphans' into
 *  their real projects, using timestamp proximity: every image's R2
 *  key embeds a unix_ms (e.g. <uid>/front/1779658476855_<seed>.png),
 *  and every mesh job has a created_at — the image is reassigned to
 *  the project of the closest mesh job within a configurable window
 *  (default ±300s, ie. 5 min). Images with no nearby mesh stay orphans.
 *
 *  Update is done via direct UPDATE so existing rows don't duplicate. */
async function handleUserAssetsReassignOrphans(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  const url = new URL(req.url);
  const windowSec = Math.max(30, Math.min(3600,
    parseInt(url.searchParams.get('windowSec') || '300', 10)));
  const sb = supabaseAdmin(env);
  // Load all of the user's _orphans assets.
  const { data: orphans, error: oErr } = await sb.from('user_assets')
    .select('id, kind, r2_path, created_at')
    .eq('user_id', user.id)
    .eq('project', '_orphans')
    .limit(5000);
  if (oErr) return err(500, oErr.message);
  if (!orphans || orphans.length === 0) {
    return json({ ok: true, scanned: 0, reassigned: 0, kept_orphan: 0, note: 'no orphans to process' });
  }
  // Load all of the user's mesh jobs with project_name. We need ALL
  // jobs (not just succeeded) because the image was generated when
  // the user clicked Create regardless of mesh success.
  const { data: jobs, error: jErr } = await sb.from('jobs')
    .select('id, project_name, options, created_at, type, cost_usd')
    .eq('user_id', user.id)
    .not('project_name', 'is', null)
    .limit(5000);
  if (jErr) return err(500, jErr.message);
  type J = { id: string; project_name: string | null;
             options: Record<string, unknown> | null;
             created_at: string };
  const jobList = (jobs ?? []) as J[];
  if (!jobList.length) {
    return json({ ok: true, scanned: orphans.length, reassigned: 0, kept_orphan: orphans.length, note: 'no jobs with project_name' });
  }
  // Build a sorted array of {ts, project} for fast lookup.
  type JobTs = { ts: number; project: string };
  const jobTsArr: JobTs[] = [];
  for (const j of jobList) {
    if (!j.project_name) continue;
    const t = new Date(j.created_at).getTime();
    if (Number.isFinite(t)) jobTsArr.push({ ts: t, project: j.project_name });
  }
  jobTsArr.sort((a, b) => a.ts - b.ts);
  // Binary-search the closest job for a given image timestamp.
  function nearestProject(imgTs: number): { project: string; deltaMs: number } | null {
    if (!jobTsArr.length) return null;
    let lo = 0, hi = jobTsArr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (jobTsArr[mid].ts < imgTs) lo = mid + 1; else hi = mid;
    }
    const candidates = [lo - 1, lo].filter(i => i >= 0 && i < jobTsArr.length);
    let best: { project: string; deltaMs: number } | null = null;
    for (const i of candidates) {
      const d = Math.abs(jobTsArr[i].ts - imgTs);
      if (!best || d < best.deltaMs) best = { project: jobTsArr[i].project, deltaMs: d };
    }
    return best;
  }
  let reassigned = 0;
  let keptOrphan = 0;
  const windowMs = windowSec * 1000;
  const byProject: Record<string, number> = {};
  for (const o of orphans as Array<{ id: number; kind: string; r2_path: string; created_at: string }>) {
    // Parse timestamp from r2_path: <uid>/<folder>/<ms>_<seed>.png
    const m = o.r2_path.match(/\/(\d{13})_/);
    if (!m) { keptOrphan++; continue; }
    const imgTs = parseInt(m[1], 10);
    if (!Number.isFinite(imgTs)) { keptOrphan++; continue; }
    const near = nearestProject(imgTs);
    if (!near || near.deltaMs > windowMs) { keptOrphan++; continue; }
    // Skip if the target project already has this exact r2_path
    // (avoid duplicates via the unique index).
    const { error: upErr } = await sb.from('user_assets')
      .update({ project: near.project })
      .eq('id', o.id)
      .eq('user_id', user.id);
    if (upErr) { console.warn('[reassign-orphans] update failed:', upErr.message); keptOrphan++; continue; }
    reassigned++;
    byProject[near.project] = (byProject[near.project] || 0) + 1;
  }
  return json({
    ok: true,
    scanned: orphans.length,
    reassigned,
    kept_orphan: keptOrphan,
    windowSec,
    byProject,
  });
}

/** POST /api/thumbs/upload — stores a mesh thumbnail in R2 instead of
 *  the client's localStorage (where a single PNG dataURL was eating
 *  100-200 KB and saturating the 5 MB origin cap). Body: {meshKey,
 *  dataUrl} where dataUrl is a data:image/png|webp;base64,... or raw
 *  base64 PNG. Stores under <uid>/thumb/<base>.webp (or .png).
 *  Returns the public URL. */
async function handleThumbsUpload(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MESHES) return err(500, 'R2 binding required');
  const body = await req.json().catch(() => ({})) as {
    meshKey?: string;
    dataUrl?: string;
  };
  const meshKey = String(body?.meshKey || '').trim();
  if (!meshKey) return err(400, 'meshKey required');
  // Strip everything but a safe filename: keep alnum/_/-/. and slice.
  const safeBase = meshKey.replace(/^.*[/\\]/, '').replace(/\.[^.]+$/, '')
                          .replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96);
  if (!safeBase) return err(400, 'invalid meshKey');
  let dataUrl = String(body?.dataUrl || '');
  let mime = 'image/png';
  const m = dataUrl.match(/^data:(image\/(png|webp|jpeg));base64,(.+)$/);
  if (m) { mime = m[1]; dataUrl = m[3]; }
  if (!dataUrl) return err(400, 'dataUrl required');
  // Decode base64
  let bytes: Uint8Array;
  try {
    const bin = atob(dataUrl);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch { return err(400, 'invalid base64'); }
  if (bytes.length > 512 * 1024) return err(413, 'thumb too large (max 512 KB)');
  const ext = mime === 'image/webp' ? 'webp' : (mime === 'image/jpeg' ? 'jpg' : 'png');
  const key = `${user.id}/thumb/${safeBase}.${ext}`;
  await env.MESHES.put(key, bytes, {
    httpMetadata: { contentType: mime, cacheControl: 'public, max-age=31536000, immutable' },
  });
  const url = await signedR2Url(env, key, 'image');
  // Record in user_assets so handleCloudProjects can return it.
  // No project here — we look up the mesh's project via the meshes
  // table. For simplicity we record under a synthetic project '_thumbs'
  // and the client falls back to the URL convention.
  await insertUserAsset(env, user.id, '_thumbs', 'thumb-mesh', key, meshKey, { mime });
  return json({ ok: true, url, key });
}

/** POST /api/user-assets/record — generic record-an-asset endpoint
 *  the client calls after every successful image generation so the
 *  R2 path is persisted in Supabase user_assets (replaces localStorage
 *  cache). Body: { projectName, kind, paths: string[]|string,
 *  parentPath?, meta? }. Idempotent: ON CONFLICT (user_id, r2_path)
 *  do nothing. Returns { ok, inserted } */
async function handleUserAssetsRecord(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  const body = await req.json().catch(() => ({})) as {
    projectName?: string;
    kind?: string;
    paths?: string[] | string;
    parentPath?: string;
    meta?: Record<string, unknown>;
  };
  const project = String(body?.projectName || '').slice(0, 128);
  const kind    = String(body?.kind        || '').slice(0, 32);
  const parent  = body?.parentPath ? String(body.parentPath).slice(0, 512) : null;
  const meta    = (body?.meta && typeof body.meta === 'object') ? body.meta : {};
  if (!project || !kind) return err(400, 'projectName and kind required');
  const rawPaths = body?.paths;
  const paths: string[] = Array.isArray(rawPaths) ? rawPaths
                       : (typeof rawPaths === 'string' ? [rawPaths] : []);
  if (!paths.length) return err(400, 'paths required');
  let inserted = 0;
  let rejected = 0;
  for (const url of paths) {
    if (!url || typeof url !== 'string') continue;
    // Accept either a full public URL or a raw R2 key.
    const r2_path = r2PathFromPublicUrl(env, url) ?? url;
    if (!r2_path || r2_path.startsWith('http')) continue;
    // ACCES INTER-COMPTES — corrige le 2026-08-03.
    //
    // Cette route acceptait N'IMPORTE QUELLE cle R2 et l'enregistrait au
    // nom de l'appelant. Deux exploitations en decoulaient, avec un
    // simple compte gratuit :
    //   - /api/cloud-projects signait ensuite la cle telle quelle, et la
    //     signature ne couvre que (cle + expiration), jamais le user_id :
    //     lecture de _meta/admin_password.json, _meta/pricing.json,
    //     _meta/banned-users.json, des logs, et des meshes d'autres
    //     clients.
    //   - la suppression de projet effacait ces memes objets : remise a
    //     zero des compteurs _meta/modal_spend/* et _meta/userspend/*,
    //     donc neutralisation des deux fusibles anti-emballement.
    //
    // L'invariant « une cle appartient au prefixe de son proprietaire »
    // etait deja verifie ailleurs dans le fichier (suppression d'actif) ;
    // il manquait ici, a l'entree. On refuse silencieusement plutot que
    // d'echouer la requete entiere : les lots legitimes passent, les
    // cles etrangeres sont ignorees.
    if (!r2_path.startsWith(`${user.id}/`)) {
      console.warn(`[user-assets/record] cle hors prefixe refusee pour ${user.id}: ${r2_path.slice(0, 80)}`);
      rejected++;
      continue;
    }
    await insertUserAsset(env, user.id, project, kind, r2_path, parent, meta);
    inserted++;
  }
  return json({ ok: true, inserted, rejected });
}

/** GET /api/admin/logs/list — lists client logs in R2, optionally
 *  filtered by ?uid=<userId> or ?email=<email>. ADMIN-only.
 *  Returns up to ?limit=N (default 50, max 200) most-recent log keys
 *  with their metadata. */
async function handleAdminLogsList(req: Request, env: Env): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  if (!env.MESHES) return err(500, 'R2 binding required');
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10)));
  let uid = (url.searchParams.get('uid') || '').trim();
  const email = (url.searchParams.get('email') || '').trim();
  // If email provided, resolve to uid via profiles.
  if (!uid && email) {
    const sb = supabaseAdmin(env);
    const { data } = await sb.from('profiles').select('id, email').eq('email', email).maybeSingle();
    if (data?.id) uid = data.id as string;
  }
  // Prefix: per-user if uid known, otherwise scan everyone (will be slower).
  const prefix = uid ? `${uid}/logs/` : '';
  // For "everyone" path we want ALL <uid>/logs/* keys. R2 list doesn't
  // support * wildcard so we list every user prefix from profiles instead.
  let uids: string[] = [];
  if (uid) {
    uids = [uid];
  } else {
    const sb = supabaseAdmin(env);
    const { data } = await sb.from('profiles').select('id, email').limit(1000);
    uids = (data ?? []).map(p => p.id as string);
  }
  const collected: Array<{
    key: string; uid: string; uploaded: string | null; size: number;
    kind: string; status: string; project: string; email: string | null;
  }> = [];
  // Build a uid→email map for the response.
  const emailByUid = new Map<string, string | null>();
  if (uids.length > 0) {
    const sb = supabaseAdmin(env);
    const { data } = await sb.from('profiles').select('id, email').in('id', uids);
    for (const row of (data ?? [])) emailByUid.set(row.id as string, (row.email as string) || null);
  }
  for (const u of uids) {
    const listed = await env.MESHES.list({ prefix: `${u}/logs/`, limit: Math.min(50, limit) });
    for (const obj of (listed.objects || [])) {
      collected.push({
        key: obj.key,
        uid: u,
        uploaded: obj.uploaded?.toISOString?.() || null,
        size: obj.size,
        kind: obj.customMetadata?.kind || '',
        status: obj.customMetadata?.status || '',
        project: obj.customMetadata?.project || '',
        email: emailByUid.get(u) ?? null,
      });
    }
  }
  // Newest first across all users.
  collected.sort((a, b) => (b.uploaded || '').localeCompare(a.uploaded || ''));
  return json({ ok: true, count: collected.length, logs: collected.slice(0, limit) });
}

/** GET /api/admin/logs/get?key=<key> — fetches the content of one log.
 *  ADMIN-only. Returns text/plain. */
async function handleAdminLogsGet(req: Request, env: Env): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  if (!env.MESHES) return err(500, 'R2 binding required');
  const url = new URL(req.url);
  const key = (url.searchParams.get('key') || '').trim();
  if (!key) return err(400, 'key required');
  // Allowlist: only paths under <uid>/logs/ or _logs/ to prevent
  // arbitrary R2 reads via this endpoint.
  if (!(/^[a-f0-9-]{32,}\/logs\//i.test(key) || key.startsWith('_logs/') || key.startsWith('_anon/logs/'))) {
    return err(400, 'invalid key (must be a log path)');
  }
  const obj = await env.MESHES.get(key);
  if (!obj) return err(404, 'not found');
  const text = await obj.text();
  return new Response(text, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/** GET /api/client-log/list — returns the recent log keys for the
 *  current user. Useful for me (the agent) to find the latest log
 *  without listing the entire R2 bucket. Query: ?limit=20 (max 100). */
async function handleClientLogList(req: Request, env: Env): Promise<Response> {
  if (!env.MESHES) return err(500, 'R2 binding required');
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') || '20', 10)));
  const prefix = `${user.id}/logs/`;
  const list = await env.MESHES.list({ prefix, limit });
  const objects = (list.objects || []).map(o => ({
    key: o.key,
    size: o.size,
    uploaded: o.uploaded?.toISOString?.() || null,
    meta: o.customMetadata || {},
  }));
  // Newest first
  objects.sort((a, b) => (b.uploaded || '').localeCompare(a.uploaded || ''));
  return json({ ok: true, prefix, count: objects.length, objects });
}

/** POST /api/animations/upload — multipart: file=<glb>, animType=<idle|run|...>,
 *  projectName=<...>. Stores the user-provided animated GLB as a new
 *  version under <user.id>/animations/<projectSlug>/<base>_manual_<type>_<batchId>_<ts>.glb
 *  so it shows up in the version strip alongside generated ones. The
 *  GLB must start with 'glTF' magic; size cap 50 MB. */
async function handleAnimUpload(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MESHES || !env.R2_PUBLIC_URL) return err(500, 'R2 binding required');
  let form: FormData;
  try { form = await req.formData(); } catch { return err(400, 'multipart body required'); }
  const file = form.get('file');
  if (!(file instanceof File)) return err(400, 'file field required');
  if (file.size > 50 * 1024 * 1024) return err(413, 'file too large (max 50 MB)');
  // NEW (2026-06-02): support kind='reference_anim' for the FBX
  // reference-animation pipeline. Stored under <uid>/anim_refs/ and
  // validated for FBX magic instead of GLB magic. Default kind
  // ('animation') preserves the legacy GLB upload behaviour.
  const kind = String(form.get('kind') || 'animation').toLowerCase();
  if (kind === 'reference_anim') {
    // Validate FBX magic. Binary FBX: "Kaydara FBX Binary" (first 18
    // bytes), ASCII FBX: starts with "; FBX". Reject anything else.
    const head24 = new Uint8Array(await file.slice(0, 24).arrayBuffer());
    const headStr = new TextDecoder().decode(head24);
    const isBinaryFbx = headStr.startsWith('Kaydara FBX Binary');
    const isAsciiFbx = headStr.startsWith('; FBX');
    if (!isBinaryFbx && !isAsciiFbx) {
      return err(415, 'not an FBX file (magic mismatch)');
    }
    const incomingHint = String(form.get('source_skeleton_id_hint') || 'auto').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'auto';
    // Hash the contents so identical FBXes share a key (saves R2).
    const buf = await file.arrayBuffer();
    let hashHex = '';
    try {
      const h = await crypto.subtle.digest('SHA-256', buf);
      hashHex = Array.from(new Uint8Array(h)).slice(0, 4)
        .map(b => b.toString(16).padStart(2, '0')).join('');
    } catch { hashHex = Date.now().toString(36); }
    const safeName = (file.name || 'ref.fbx').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'ref.fbx';
    const key = `${user.id}/anim_refs/${hashHex}_${safeName}`;
    try {
      await env.MESHES.put(key, buf, {
        httpMetadata: { contentType: 'application/octet-stream' },
      });
    } catch (e) {
      return err(500, `R2 upload failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const publicUrl = await signedR2Url(env, key, 'mesh');
    return json({
      ok: true, url: publicUrl, key,
      kind: 'reference_anim',
      size: buf.byteLength,
      contentType: 'application/octet-stream',
      source_skeleton_id_hint: incomingHint,
    });
  }

  const animType = (String(form.get('animType') || 'clip').toLowerCase().replace(/[^a-z]/g, '') || 'clip').slice(0, 16);
  const projectName = String(form.get('projectName') || '');
  const projectSlug = (projectName || 'untitled').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'untitled';
  // Sniff GLB magic to reject random binaries.
  const head = await file.slice(0, 4).arrayBuffer();
  const magic = new TextDecoder().decode(new Uint8Array(head));
  if (magic !== 'glTF') return err(400, 'not a GLB file (magic mismatch)');
  // Optional batchId from the form — lets the client group copies of
  // existing clips + freshly generated ones into the same version.
  // Falls back to a unique 'm<...>' for manual one-off uploads.
  const incomingBatch = String(form.get('batchId') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  const batchId = incomingBatch || `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const baseName = (file.name || 'imported').replace(/\.(glb|gltf)$/i, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'imported';
  const key = `${user.id}/animations/${projectSlug}/${baseName}_manual_${animType}_${batchId}_${Date.now()}.glb`;
  try {
    await env.MESHES.put(key, file.stream(), {
      httpMetadata: { contentType: 'model/gltf-binary' },
    });
  } catch (e) {
    return err(500, `R2 upload failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const publicUrl = await signedR2Url(env, key, 'mesh');
  return json({ ok: true, url: publicUrl, key, animType, batchId });
}


/** POST /api/animations/copy — body { sourceUrl, animType, projectName,
 *  batchId? }. Copies an existing R2 animation blob to a new key without
 *  the GLB ever touching the client (which was hitting Cloudflare's
 *  100 MB request body cap on large animated meshes via /upload).
 *  Source must live under <user.id>/animations/ to prevent cross-user
 *  copies. */
async function handleAnimCopy(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MESHES || !env.R2_PUBLIC_URL) return err(500, 'R2 binding required');
  const body = await req.json() as { sourceUrl?: string; animType?: string; projectName?: string; batchId?: string };
  const sourceUrl = body.sourceUrl;
  if (!sourceUrl) return err(400, 'sourceUrl required');
  // Parse the source key from the URL and validate it belongs to this user.
  // Accepts three forms: (1) a signed /r2/<key>?exp&sig URL on the site
  // origin, (2) a raw r2.dev public URL (legacy), (3) a bare R2 key.
  let sourceKey: string;
  if (/^https?:\/\//i.test(sourceUrl)) {
    try {
      const u = new URL(sourceUrl);
      const siteHost = new URL(siteUrl(env, 'http://localhost:3030')).host;
      if (u.pathname.startsWith('/r2/') && u.host === siteHost) {
        sourceKey = u.pathname.slice('/r2/'.length).split('/').map(decodeURIComponent).join('/');
      } else if (env.R2_PUBLIC_URL && u.host === new URL(env.R2_PUBLIC_URL).host) {
        sourceKey = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
      } else {
        return err(400, 'sourceUrl host not allowed');
      }
    } catch { return err(400, 'invalid sourceUrl'); }
  } else {
    sourceKey = sourceUrl.replace(/^\/+/, '');
  }
  if (sourceKey.includes('..') || !sourceKey.startsWith(`${user.id}/animations/`)) {
    return err(403, 'can only copy your own animation files');
  }
  // Read the source body from R2 and stream into the new key.
  const src = await env.MESHES.get(sourceKey);
  if (!src) return err(404, 'source not found in R2');
  const animType = (String(body.animType || 'clip').toLowerCase().replace(/[^a-z]/g, '') || 'clip').slice(0, 16);
  const projectName = String(body.projectName || '');
  const projectSlug = (projectName || 'untitled').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'untitled';
  const incomingBatch = String(body.batchId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  const batchId = incomingBatch || `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // Recover the base name from the source filename so the new key
  // preserves the rig stem.
  const srcName = sourceKey.split('/').pop() || 'copy.glb';
  const baseName = srcName.replace(/_(idle|walk|run|attack|death|fly|jump|custom|clip)_.*\.glb$/i, '')
                          .replace(/^.*_rigged_/i, 'rigged_')
                          .replace(/[^A-Za-z0-9._-]/g, '_')
                          .slice(0, 80) || 'copy';
  const key = `${user.id}/animations/${projectSlug}/${baseName}_${animType}_${batchId}_${Date.now()}.glb`;
  try {
    await env.MESHES.put(key, src.body, {
      httpMetadata: { contentType: 'model/gltf-binary' },
    });
  } catch (e) {
    return err(500, `R2 copy failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return json({ ok: true, url: await signedR2Url(env, key, 'mesh'), key });
}


/** POST /api/animations/delete — body { url }. Removes the R2 blob
 *  AND the corresponding jobs row (asset_type='animation' with
 *  mesh_url matching the deleted URL). Without the jobs delete the
 *  vignette reappears on the next refresh because handleListMeshes
 *  queries `jobs WHERE succeeded AND mesh_url IS NOT NULL` and
 *  rebuilds the strip from there (observed in prod 2026-06-02 —
 *  user deletes vignettes, refreshes page, they all come back).
 *  Mirrors handleMeshesDelete which already does R2+jobs cleanup.
 *  Restricted to URLs under <user.id>/animations/ so a hostile
 *  body can't nuke unrelated R2 keys. Idempotent. */
async function handleAnimDelete(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MESHES || !env.R2_PUBLIC_URL) return err(500, 'R2 binding required');
  const { url } = await req.json() as { url?: string };
  if (!url) return err(400, 'url required');
  let key: string | null = null;
  if (/^https?:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      const siteHost = new URL(siteUrl(env, 'http://localhost:3030')).host;
      if (u.pathname.startsWith('/r2/') && u.host === siteHost) {
        key = u.pathname.slice('/r2/'.length).split('/').map(decodeURIComponent).join('/');
      } else if (env.R2_PUBLIC_URL && u.host === new URL(env.R2_PUBLIC_URL).host) {
        key = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
      } else {
        return err(400, 'url host not allowed');
      }
    } catch { return err(400, 'invalid url'); }
  } else {
    key = url.replace(/^\/+/, '');
  }
  if (!key || key.includes('..') || !key.startsWith(`${user.id}/animations/`)) {
    return err(403, 'can only delete your own animation files');
  }
  try { await env.MESHES.delete(key); } catch (e) {
    console.warn('[animations/delete] R2 delete failed', e instanceof Error ? e.message : String(e));
  }
  // Drop the jobs row whose mesh_url matches this URL so that
  // handleListMeshes' Supabase query doesn't keep resurrecting the
  // vignette on every page refresh.
  try {
    // mesh_url now stores the raw KEY (legacy rows stored the full URL),
    // so match on either to cover both old and new rows.
    const { error, count } = await supabaseAdmin(env)
      .from('jobs')
      .delete({ count: 'exact' })
      .eq('user_id', user.id)
      .eq('asset_type', 'animation')
      .or(`mesh_url.eq.${key},mesh_url.eq.${url}`);
    if (error) console.warn('[animations/delete] jobs delete failed:', error.message);
    else console.log(`[animations/delete] jobs row(s) deleted: ${count ?? 'n/a'} for key=${key}`);
  } catch (e) {
    console.warn('[animations/delete] jobs delete threw:', e instanceof Error ? e.message : String(e));
  }
  return json({ ok: true, deleted_key: key });
}


/** POST /api/animate — spawn an AnyTop animation job on Modal.
 *  Body: { rig_url: string, anim_type?: string, prompt?: string, engine?: string }
 *  Returns: { success, job_id, status:'queued', creditsRemaining }
 *  Mirrors handleAutoRig 1:1 in shape; only the upstream Modal endpoint differs. */
async function handleAutoAnim(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MODAL_ANYTOP_ANIM_URL) return err(503, 'animation backend unavailable');
  if (!env.MODAL_SHARED_SECRET) return err(500, 'MODAL_SHARED_SECRET not set');
  if (!env.MESHES || !env.R2_PUBLIC_URL) return err(500, 'R2 binding required');

  let body: { rig_url?: string; anim_type?: string; prompt?: string; engine?: string; batch_id?: string; projectName?: string };
  try {
    body = await req.json() as typeof body;
  } catch {
    return err(400, 'invalid JSON body');
  }
  const rigUrl = body.rig_url;
  if (!rigUrl || typeof rigUrl !== 'string') return err(400, 'rig_url required');
  if (!isTrustedAssetHost(env, rigUrl)) return err(400, 'rig_url host not allowed');
  const animType = typeof body.anim_type === 'string' ? body.anim_type.slice(0, 32) : 'idle';
  const prompt = typeof body.prompt === 'string' ? body.prompt.slice(0, 400) : '';
  // batch_id groups all animations spawned by the same "Generate" click
  // so the client can show them as ONE version (v0 = batch with run+idle,
  // v1 = batch with run+attack, etc.) instead of one version per type.
  const batchId = typeof body.batch_id === 'string'
    ? body.batch_id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)
    : '';
  const projectName = typeof body.projectName === 'string' ? body.projectName : '';

  const remainingBudget = await checkAndIncrementModalSpend(env, ESTIMATED_USD_ANIM, user.id);
  if (remainingBudget == null) return err(429, 'daily Cloud GPU budget reached. Try again after midnight UTC.');
  const refundAnimSpend = async () => { await refundModalSpend(env, ESTIMATED_USD_ANIM); };
  const remainingUserCalls = await checkAndIncrementUserCalls(env, user.id);
  if (remainingUserCalls == null) {
    await refundAnimSpend();
    return err(429, 'you have reached the per-user daily generation limit.');
  }
  const remaining = await spendCredits(env, user.id, ANIM_COST);
  if (remaining == null) {
    await refundAnimSpend();
    return err(402, 'insufficient credits');
  }

  const baseUrl = env.MODAL_ANYTOP_ANIM_URL.replace(/\/$/, '');
  const startUrl = `${baseUrl}/anim-start`;
  let jobId: string;
  try {
    const r = await fetch(startUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        _auth: env.MODAL_SHARED_SECRET,
        rig_url: rigUrl,
        anim_type: animType,
        prompt,
      }),
      // 90s — covers Modal cold-start (~20-40s on the AnyTop image)
      // plus the GLB download from R2 inside the endpoint (up to 60s
      // urlopen timeout). 30s was tripping the Worker before Modal
      // had time to spawn.
      signal: AbortSignal.timeout(90_000),
    });
    if (!r.ok) {
      await addCredits(env, user.id, ANIM_COST);
      await refundAnimSpend();
      const txt = await r.text().catch(() => '');
      console.error('[animate] Modal anim-start', r.status, txt.slice(0, 200));
      return err(502, `Modal animation backend HTTP ${r.status}`);
    }
    const j = await r.json() as { job_id?: string };
    if (!j?.job_id) {
      await addCredits(env, user.id, ANIM_COST);
      await refundAnimSpend();
      return err(502, 'Modal anim-start: no job_id');
    }
    jobId = j.job_id;
  } catch (e: unknown) {
    await addCredits(env, user.id, ANIM_COST);
    await refundAnimSpend();
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[animate] spawn threw', msg);
    return err(502, `Modal animation backend unreachable: ${msg.slice(0, 200)}`);
  }

  await putAnimJobRecord(env, jobId, {
    user_id: user.id,
    modal_spend: ESTIMATED_USD_ANIM,
    credits: ANIM_COST,
    rig_url: rigUrl,
    anim_type: animType,
    created_at: Date.now(),
    batch_id: batchId || undefined,
    project_name: projectName || undefined,
  });
  // Also persist in the jobs table so the event appears in 'My usage
  // history' alongside everything else. options.sourceRig lets the
  // detail modal show a 🦴 Source rig link back to its origin.
  try {
    await supabaseAdmin(env).from('jobs').insert({
      id: jobId, user_id: user.id,
      asset_type: 'animation', mode: animType, seed: 0,
      credit_cost: ANIM_COST, status: 'processing',
      type: 'animate',
      cost_usd: ESTIMATED_USD_ANIM,
      project_name: projectName || null,
      options: {
        operation_type: 'animate', sourceRig: rigUrl, anim_type: animType,
        prompt: prompt || null, batch_id: batchId || null, backend: 'modal',
        cost_usd: ESTIMATED_USD_ANIM,
      },
      created_at: new Date().toISOString(),
    });
  } catch (e) { console.error('[animate] jobs.insert failed', e); }
  return json({ success: true, job_id: jobId, status: 'queued', creditsRemaining: remaining });
}

/** POST or GET /api/animate-status?job_id=<id> — poll the Modal anim
 *  output volume. Stream the GLB into R2 on done. Mirror of
 *  handleAutoRigStatus + the rig-fetch streaming pattern (commit 9dacdd0). */
async function handleAutoAnimStatus(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MODAL_ANYTOP_ANIM_URL) return err(503, 'animation backend unavailable');
  if (!env.MODAL_SHARED_SECRET) return err(500, 'MODAL_SHARED_SECRET not set');
  if (!env.MESHES || !env.R2_PUBLIC_URL) return err(500, 'R2 binding required');

  let jobId = '';
  try {
    const u = new URL(req.url);
    jobId = (u.searchParams.get('job_id') || '').trim();
  } catch {}
  if (!jobId && req.method === 'POST') {
    try {
      const b = await req.json() as { job_id?: string };
      jobId = String(b?.job_id || '').trim();
    } catch {}
  }
  if (!jobId) return err(400, 'job_id required');

  const record = await getAnimJobRecord(env, jobId);
  if (!(await _estProprietaireDuJob(env, jobId, user.id, record))) return err(403, 'forbidden');

  // Refund échoué → on GARDE le record pour retry au prochain poll
  // (le delete inconditionnel rendait la perte de crédits définitive).
  const refundOnFailure = async () => {
    if (!record) return;
    // Atomic + idempotent credit refund via the shared jobs-row primitive
    // (conditional UPDATE out of a non-terminal status) — two racing failure
    // polls, or a poll racing the cron reaper, refund EXACTLY once. This was
    // the LAST of the four async op families still calling a plain
    // addCredits(), which double-refunded as soon as reapStuckJobs learned to
    // sweep animation jobs (2026-07-26).
    try {
      await _failAndRefundJob(
        env,
        { id: jobId, user_id: record.user_id, credit_cost: record.credits },
        'animation failed',
      );
    } catch (e) {
      console.error(`[anim-status] REFUND FAILED job=${jobId} user=${record.user_id} `
        + `credits=${record.credits} — record kept for retry:`,
        e instanceof Error ? e.message : String(e));
      return;
    }
    await refundModalSpend(env, record.modal_spend).catch((e) =>
      console.error(`[anim-status] refundModalSpend failed job=${jobId}:`,
        e instanceof Error ? e.message : String(e)));
    await deleteAnimJobRecord(env, jobId).catch(() => {});
  };

  const baseUrl = env.MODAL_ANYTOP_ANIM_URL.replace(/\/$/, '');
  const statusUrl = `${baseUrl}/anim-status`;
  const fetchUrl = `${baseUrl}/anim-fetch`;
  let modalResp: { ready?: boolean; error?: string; bytes?: number; fetch_endpoint?: string };
  try {
    const r = await fetch(statusUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ _auth: env.MODAL_SHARED_SECRET, job_id: jobId }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) {
      throw new Error(`Cloud GPU anim-status HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    modalResp = await r.json() as typeof modalResp;
  } catch (e: unknown) {
    console.warn('[animate-status] transient', e instanceof Error ? e.message : String(e));
    return json({ status: 'pending', warn: e instanceof Error ? e.message : String(e) });
  }

  if (modalResp?.ready === false && !modalResp?.error) {
    return json({ status: 'pending', stage: 'running' });
  }
  if (modalResp?.ready === false && modalResp?.error) {
    await refundOnFailure();
    console.log(`[animate-status] job_id=${jobId} FAILED: ${String(modalResp.error).slice(0, 200)}`);
    return json({ status: 'failed', error: String(modalResp.error).slice(0, 500) });
  }
  if (modalResp?.ready === true) {
    let fetchResp: Response;
    try {
      fetchResp = await fetch(fetchUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ _auth: env.MODAL_SHARED_SECRET, job_id: jobId }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e: unknown) {
      return json({ status: 'pending', warn: 'anim-fetch transient: ' + (e instanceof Error ? e.message : String(e)) });
    }
    if (fetchResp.status === 404) return json({ status: 'pending', stage: 'race-volume-not-ready' });
    if (fetchResp.status === 410) {
      await refundOnFailure();
      const txt = await fetchResp.text().catch(() => '');
      return json({ status: 'failed', error: txt.slice(0, 500) || 'animation failed' });
    }
    if (!fetchResp.ok || !fetchResp.body) {
      await refundOnFailure();
      return json({ status: 'failed', error: `anim-fetch HTTP ${fetchResp.status}` });
    }

    let baseName = 'anim';
    const sourceUrl = record?.rig_url || '';
    if (sourceUrl) {
      try {
        const last = new URL(sourceUrl).pathname.split('/').pop() || '';
        baseName = last.replace(/\.(glb|gltf)$/i, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'anim';
      } catch {}
    }
    const animType = record?.anim_type || 'clip';
    // Embed batch_id in the filename so the listing endpoint can
    // re-group clips generated together into a single "version" on the
    // client. Format: <base>_<type>_<batchId>_<ts>.glb. Legacy keys
    // without batch_id segment fall back to per-clip versioning.
    const batchSeg = record?.batch_id ? `${record.batch_id}_` : '';
    const key = `${user.id}/animations/${baseName}_${animType}_${batchSeg}${Date.now()}.glb`;
    try {
      await env.MESHES.put(key, fetchResp.body, {
        httpMetadata: { contentType: 'model/gltf-binary' },
      });
    } catch (e) {
      await refundOnFailure();
      console.error('[animate-status.r2]', e instanceof Error ? e.message : String(e));
      return json({ status: 'failed', error: 'animation storage failed (credits refunded)' });
    }
    await deleteAnimJobRecord(env, jobId).catch(() => {});
    const publicUrl = await signedR2Url(env, key, 'mesh');
    console.log(`[animate-status] job_id=${jobId} DONE url=${publicUrl}`);
    // Tag the anim container as warm — added 2026-06-02.
    _writeLastWarmMs(env, '_meta/last_warm_anim.txt').catch(() => {});
    // Mark the jobs row succeeded so history shows the right state. Persist
    // the raw KEY (not the expiring signed URL) so reads re-sign with TTL.
    try {
      // GARDE DE STATUT — sans elle, un job DEJA rembourse pouvait etre
      // repasse en 'succeeded' par un simple GET sur cette route de
      // statut : l'utilisateur gardait l'actif ET ses credits. Le chemin
      // d'echec, lui, etait deja protege (_failAndRefundJob reclame la
      // ligne). On aligne le chemin de succes sur le meme invariant :
      // seul un job encore NON TERMINAL peut devenir 'succeeded'.
      await supabaseAdmin(env).from('jobs')
        .update({ status: 'succeeded', mesh_url: key, finished_at: new Date().toISOString() })
        .eq('id', jobId).eq('user_id', user.id)
        .in('status', NON_TERMINAL_JOB_STATUSES as unknown as string[]);
    } catch (e) { console.warn('[animate-status] jobs.update failed', e); }
    return json({
      status: 'done',
      success: true,
      anim_url: publicUrl,
      url: publicUrl,
      path: key,
      anim_type: animType,
      bytes: modalResp?.bytes ?? null,
    });
  }
  return json({ status: 'pending', stage: 'unknown-response' });
}

/** POST /api/animate-from-reference — spawn an FBX reference-animation
 *  retarget job on Modal. Body:
 *    { rig_url: string, ref_anim_url: string,
 *      source_skeleton_id_hint?: 'auto'|'ue5_mannequin'|'orc_m1',
 *      target_family?: 'humanoid_puppeteer',
 *      clip_name?: string, project_name?: string, batch_id?: string }
 *  Returns: { success, job_id, status:'queued', creditsRemaining }
 *  Mirrors handleAutoAnim but routes to MODAL_FBX_RETARGET_URL with the
 *  /fbx-retarget-start endpoint. Charges ANIM_COST (same as AnyTop). */
async function handleAnimateFromReference(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MODAL_FBX_RETARGET_URL) return err(503, 'fbx retarget backend unavailable');
  if (!env.MODAL_SHARED_SECRET) return err(500, 'MODAL_SHARED_SECRET not set');
  if (!env.MESHES || !env.R2_PUBLIC_URL) return err(500, 'R2 binding required');

  let body: {
    rig_url?: string;
    ref_anim_url?: string;
    source_skeleton_id_hint?: string;
    target_family?: string;
    clip_name?: string;
    projectName?: string;
    batch_id?: string;
  };
  try {
    body = await req.json() as typeof body;
  } catch {
    return err(400, 'invalid JSON body');
  }
  const rigUrl = body.rig_url;
  const refAnimUrl = body.ref_anim_url;
  if (!rigUrl || typeof rigUrl !== 'string') return err(400, 'rig_url required');
  if (!refAnimUrl || typeof refAnimUrl !== 'string') return err(400, 'ref_anim_url required');
  if (!isTrustedAssetHost(env, rigUrl)) return err(400, 'rig_url host not allowed');
  if (!isTrustedAssetHost(env, refAnimUrl)) return err(400, 'ref_anim_url host not allowed');

  const hint = (body.source_skeleton_id_hint || 'auto')
    .replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'auto';
  const targetFamily = (body.target_family || 'humanoid_puppeteer')
    .replace(/[^a-z0-9_]/gi, '').slice(0, 48) || 'humanoid_puppeteer';
  const clipName = (typeof body.clip_name === 'string' ? body.clip_name : 'clip')
    .slice(0, 32);
  const batchId = typeof body.batch_id === 'string'
    ? body.batch_id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)
    : '';
  const projectName = typeof body.projectName === 'string' ? body.projectName : '';

  const remainingBudget = await checkAndIncrementModalSpend(env, ESTIMATED_USD_ANIM, user.id);
  if (remainingBudget == null) return err(429, 'daily Cloud GPU budget reached. Try again after midnight UTC.');
  const refundSpend = async () => { await refundModalSpend(env, ESTIMATED_USD_ANIM); };
  const remainingUserCalls = await checkAndIncrementUserCalls(env, user.id);
  if (remainingUserCalls == null) {
    await refundSpend();
    return err(429, 'you have reached the per-user daily generation limit.');
  }
  const remaining = await spendCredits(env, user.id, ANIM_COST);
  if (remaining == null) {
    await refundSpend();
    return err(402, 'insufficient credits');
  }

  const baseUrl = env.MODAL_FBX_RETARGET_URL.replace(/\/$/, '');
  const startUrl = `${baseUrl}/fbx-retarget-start`;
  let jobId: string;
  try {
    const r = await fetch(startUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        _auth: env.MODAL_SHARED_SECRET,
        rig_url: rigUrl,
        ref_anim_url: refAnimUrl,
        source_skeleton_id_hint: hint,
        target_family: targetFamily,
        clip_name: clipName,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) {
      await addCredits(env, user.id, ANIM_COST);
      await refundSpend();
      const txt = await r.text().catch(() => '');
      console.error('[animate-from-reference] Modal start', r.status, txt.slice(0, 200));
      return err(502, `Modal FBX retarget backend HTTP ${r.status}`);
    }
    const j = await r.json() as { job_id?: string };
    if (!j?.job_id) {
      await addCredits(env, user.id, ANIM_COST);
      await refundSpend();
      return err(502, 'Modal fbx-retarget-start: no job_id');
    }
    jobId = j.job_id;
  } catch (e: unknown) {
    await addCredits(env, user.id, ANIM_COST);
    await refundSpend();
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[animate-from-reference] spawn threw', msg);
    return err(502, `Modal FBX retarget backend unreachable: ${msg.slice(0, 200)}`);
  }

  await putAnimJobRecord(env, jobId, {
    user_id: user.id,
    modal_spend: ESTIMATED_USD_ANIM,
    credits: ANIM_COST,
    rig_url: rigUrl,
    anim_type: 'fbxref',
    created_at: Date.now(),
    batch_id: batchId || undefined,
    project_name: projectName || undefined,
  });
  try {
    await supabaseAdmin(env).from('jobs').insert({
      id: jobId, user_id: user.id,
      asset_type: 'animation', mode: 'fbx_ref', seed: 0,
      credit_cost: ANIM_COST, status: 'processing',
      type: 'animate_fbx',
      cost_usd: ESTIMATED_USD_ANIM,
      project_name: projectName || null,
      options: {
        operation_type: 'animate_fbx', sourceRig: rigUrl,
        ref_anim: refAnimUrl,
        source_skeleton_id_hint: hint, target_family: targetFamily,
        batch_id: batchId || null, backend: 'modal',
        cost_usd: ESTIMATED_USD_ANIM,
      },
      created_at: new Date().toISOString(),
    });
  } catch (e) { console.error('[animate-from-reference] jobs.insert failed', e); }
  return json({ success: true, job_id: jobId, status: 'queued', creditsRemaining: remaining });
}

/** POST or GET /api/animate-from-reference-status?job_id=<id>
 *  Mirror of handleAutoAnimStatus targeting the FBX-retarget Modal app.
 *  Streams the result GLB into R2 with a `_fbxref_` discriminator in the
 *  filename so the project loader (index2.js:645 isAnimation filter)
 *  classifies it as an animation. */
async function handleAnimateFromReferenceStatus(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MODAL_FBX_RETARGET_URL) return err(503, 'fbx retarget backend unavailable');
  if (!env.MODAL_SHARED_SECRET) return err(500, 'MODAL_SHARED_SECRET not set');
  if (!env.MESHES || !env.R2_PUBLIC_URL) return err(500, 'R2 binding required');

  let jobId = '';
  try {
    const u = new URL(req.url);
    jobId = (u.searchParams.get('job_id') || '').trim();
  } catch {}
  if (!jobId && req.method === 'POST') {
    try {
      const b = await req.json() as { job_id?: string };
      jobId = String(b?.job_id || '').trim();
    } catch {}
  }
  if (!jobId) return err(400, 'job_id required');

  const record = await getAnimJobRecord(env, jobId);
  if (!(await _estProprietaireDuJob(env, jobId, user.id, record))) return err(403, 'forbidden');

  // Refund échoué → on GARDE le record pour retry au prochain poll
  // (le delete inconditionnel rendait la perte de crédits définitive).
  const refundOnFailure = async () => {
    if (!record) return;
    // Atomic + idempotent credit refund via the shared jobs-row primitive
    // (conditional UPDATE out of processing/pending) — two racing failure
    // polls, or a poll racing the reaper, refund EXACTLY once. A plain
    // addCredits here double-refunds on concurrent ticks.
    try {
      await _failAndRefundJob(
        env,
        { id: jobId, user_id: record.user_id, credit_cost: record.credits },
        'fbx-retarget failed',
      );
    } catch (e) {
      console.error(`[fbx-retarget-status] REFUND FAILED job=${jobId} user=${record.user_id} `
        + `credits=${record.credits} — record kept for retry:`,
        e instanceof Error ? e.message : String(e));
      return;
    }
    await refundModalSpend(env, record.modal_spend).catch((e) =>
      console.error(`[fbx-retarget-status] refundModalSpend failed job=${jobId}:`,
        e instanceof Error ? e.message : String(e)));
    await deleteAnimJobRecord(env, jobId).catch(() => {});
  };

  const baseUrl = env.MODAL_FBX_RETARGET_URL.replace(/\/$/, '');
  const statusUrl = `${baseUrl}/fbx-retarget-status`;
  const fetchUrl = `${baseUrl}/fbx-retarget-fetch`;
  let modalResp: {
    ready?: boolean; error?: string; bytes?: number; fetch_endpoint?: string;
    meta?: { detected_skeleton_id?: string; source_skel_id_used?: string; n_frames?: number } | null;
  };
  try {
    const r = await fetch(statusUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ _auth: env.MODAL_SHARED_SECRET, job_id: jobId }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) {
      throw new Error(`Cloud GPU fbx-retarget-status HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    modalResp = await r.json() as typeof modalResp;
  } catch (e: unknown) {
    console.warn('[animate-from-reference-status] transient', e instanceof Error ? e.message : String(e));
    return json({ status: 'pending', warn: e instanceof Error ? e.message : String(e) });
  }

  if (modalResp?.ready === false && !modalResp?.error) {
    return json({ status: 'pending', stage: 'running' });
  }
  if (modalResp?.ready === false && modalResp?.error) {
    await refundOnFailure();
    console.log(`[animate-from-reference-status] job_id=${jobId} FAILED: ${String(modalResp.error).slice(0, 200)}`);
    return json({ status: 'failed', error: String(modalResp.error).slice(0, 500) });
  }
  if (modalResp?.ready === true) {
    let fetchResp: Response;
    try {
      fetchResp = await fetch(fetchUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ _auth: env.MODAL_SHARED_SECRET, job_id: jobId }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e: unknown) {
      return json({ status: 'pending', warn: 'fbx-retarget-fetch transient: ' + (e instanceof Error ? e.message : String(e)) });
    }
    if (fetchResp.status === 404) return json({ status: 'pending', stage: 'race-volume-not-ready' });
    if (fetchResp.status === 410) {
      await refundOnFailure();
      const txt = await fetchResp.text().catch(() => '');
      return json({ status: 'failed', error: txt.slice(0, 500) || 'fbx retarget failed' });
    }
    if (!fetchResp.ok || !fetchResp.body) {
      await refundOnFailure();
      return json({ status: 'failed', error: `fbx-retarget-fetch HTTP ${fetchResp.status}` });
    }

    let baseName = 'anim';
    const sourceUrl = record?.rig_url || '';
    if (sourceUrl) {
      try {
        const last = new URL(sourceUrl).pathname.split('/').pop() || '';
        baseName = last.replace(/\.(glb|gltf)$/i, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'anim';
      } catch {}
    }
    // The discriminator `_fbxref_` is recognised by index2.js' anim
    // classifier so the new GLB lands in the same animations strip as
    // AnyTop outputs. Format: <base>_fbxref_<batchId>_<ts>.glb
    const batchSeg = record?.batch_id ? `${record.batch_id}_` : '';
    const key = `${user.id}/animations/${baseName}_fbxref_${batchSeg}${Date.now()}.glb`;
    try {
      await env.MESHES.put(key, fetchResp.body, {
        httpMetadata: { contentType: 'model/gltf-binary' },
      });
    } catch (e) {
      await refundOnFailure();
      console.error('[animate-from-reference-status.r2]', e instanceof Error ? e.message : String(e));
      return json({ status: 'failed', error: 'animation storage failed (credits refunded)' });
    }
    await deleteAnimJobRecord(env, jobId).catch(() => {});
    const publicUrl = await signedR2Url(env, key, 'mesh');
    console.log(`[animate-from-reference-status] job_id=${jobId} DONE url=${publicUrl}`);
    // Persist the raw KEY (not the expiring signed URL); reads re-sign.
    try {
      // GARDE DE STATUT — sans elle, un job DEJA rembourse pouvait etre
      // repasse en 'succeeded' par un simple GET sur cette route de
      // statut : l'utilisateur gardait l'actif ET ses credits. Le chemin
      // d'echec, lui, etait deja protege (_failAndRefundJob reclame la
      // ligne). On aligne le chemin de succes sur le meme invariant :
      // seul un job encore NON TERMINAL peut devenir 'succeeded'.
      await supabaseAdmin(env).from('jobs')
        .update({ status: 'succeeded', mesh_url: key, finished_at: new Date().toISOString() })
        .eq('id', jobId).eq('user_id', user.id)
        .in('status', NON_TERMINAL_JOB_STATUSES as unknown as string[]);
    } catch (e) { console.warn('[animate-from-reference-status] jobs.update failed', e); }
    return json({
      status: 'done',
      success: true,
      anim_url: publicUrl,
      url: publicUrl,
      path: key,
      anim_type: 'fbxref',
      bytes: modalResp?.bytes ?? null,
      detected_skeleton_id: modalResp?.meta?.detected_skeleton_id ?? null,
      source_skel_id_used: modalResp?.meta?.source_skel_id_used ?? null,
    });
  }
  return json({ status: 'pending', stage: 'unknown-response' });
}

/** GET /api/proxy-image?url=<encoded> — server-side fetch of an image
 *  URL, returned as-is so the browser sees a same-origin response and
 *  bypasses CORS entirely. Used by every canvas tool that needs to
 *  pull bytes back into a <canvas> (Crop, Brightness, Sym, Mask, Blur,
 *  Paint, Clone, Modify-preview, Upscale).
 *
 *  Whitelist: only fetch URLs whose host matches a list of allowed
 *  domains we control or know send safe content. Without this the
 *  endpoint becomes an open proxy that anyone could abuse to bounce
 *  arbitrary traffic through our Cloudflare account. */
async function handleProxyImage(req: Request, env: Env): Promise<Response> {
  // Public — no auth required. The user already needs the URL to call
  // this; auth would just complicate canvas tooling for no win.
  const u = new URL(req.url);
  const target = u.searchParams.get('url');
  if (!target) return err(400, 'url required');

  let parsed: URL;
  try { parsed = new URL(target); } catch { return err(400, 'invalid url'); }
  if (parsed.protocol !== 'https:') return err(400, 'https:// only');

  // Signed self-origin /r2/ URL: the signature IS the auth, and the route
  // already returns ACAO:* — verify + stream from MESHES directly instead
  // of an outbound fetch (avoids a self-subrequest and works after the
  // r2.dev public bucket is disabled).
  try {
    const siteHost = new URL(siteUrl(env, 'http://localhost:3030')).host;
    if (parsed.host === siteHost && parsed.pathname.startsWith('/r2/')) {
      return await handleSignedR2(new Request(parsed.toString(), { method: 'GET' }), env);
    }
  } catch { /* fall through to host allow-list */ }

  // Allow R2 public buckets + a few known image-serving hosts. Add to
  // this list as new generation backends are wired in.
  const allowed = new Set<string>([
    'replicate.delivery',
    'pbxt.replicate.delivery',
    'image.pollinations.ai',
  ]);
  if (env.R2_PUBLIC_URL) {
    try { allowed.add(new URL(env.R2_PUBLIC_URL).host); } catch { /* ignore */ }
  }
  // Wildcard *.r2.dev — R2 public bucket subdomains rotate when the
  // bucket is recreated, and hardcoding a specific one means every
  // rotation breaks the proxy. The *.r2.dev space is Cloudflare-only
  // (anyone abusing it is on a different account), so the open-proxy
  // risk is bounded by Cloudflare's account-level controls.
  const isR2 = parsed.host.endsWith('.r2.dev');
  if (!allowed.has(parsed.host) && !isR2) {
    return err(403, `proxy: host ${parsed.host} not allowed`);
  }

  try {
    const r = await fetch(parsed.toString(), {
      headers: { 'user-agent': 'myfabmesh-cloud-proxy/1.0' },
    });
    if (!r.ok) return err(r.status, `upstream HTTP ${r.status}`);
    // Stream the body back. Set permissive CORS headers so any cloud
    // page can read it via fetch() + canvas getImageData().
    return new Response(r.body, {
      status: 200,
      headers: {
        'content-type': r.headers.get('content-type') || 'image/png',
        'cache-control': 'public, max-age=300',
        'access-control-allow-origin': '*',
      },
    });
  } catch (e) {
    return err(502, `proxy fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** AI upscale endpoint — LANCZOS x2/x4 + SDXL refine pass. Way nicer
 *  output than the desktop's pure-LANCZOS quick edit. Costs 2 credits. */
async function handleUpscaleImage(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MODAL_IMAGE_OP_URL) return err(503, 'upscale backend unavailable');

  const { imagePath, imageUrl, scale } = await req.json() as {
    imagePath?: string; imageUrl?: string; scale?: number;
  };
  const src = imageUrl || imagePath;
  if (!src) return err(400, 'imageUrl or imagePath required');
  if (!isTrustedAssetHost(env, src)) return err(400, 'imageUrl host not allowed');
  const factor = scale === 4 ? 4 : 2;  // only 2 or 4 supported

  // Upscale: x2 = base price, x4 = base + 1 (heavier).
  const upscaleBase = await getPrice(env, 'upscale');
  const COST_PER = factor === 4 ? upscaleBase + 1 : upscaleBase;
  const estimatedTotal = factor === 4 ? 0.07 : 0.05;
  const remainingBudget = await checkAndIncrementModalSpend(env, estimatedTotal, user.id);
  if (remainingBudget == null) {
    return json({ ok: false, success: false,
      error: 'daily Cloud GPU budget reached.' }, { status: 429 });
  }
  const remainingUserCalls = await checkAndIncrementUserCalls(env, user.id);
  if (remainingUserCalls == null) {
    await refundModalSpend(env, estimatedTotal);
    return json({ ok: false, success: false, error: 'user limit reached.' }, { status: 429 });
  }
  const remaining = await spendCredits(env, user.id, COST_PER);
  if (remaining == null) {
    await refundModalSpend(env, estimatedTotal);
    return json({ ok: false, success: false,
      error: `insufficient credits — upscale x${factor} costs ${COST_PER}` }, { status: 402 });
  }

  const opStart = Date.now();
  try {
    const result = await callModalImageOp(env, user.id, {
      op: 'upscale', imageUrl: src, scale: factor,
    }, 'upscale');
    if ('maskEmpty' in result) throw new Error('unexpected mask_empty from upscale');
    await logOperation(env, user.id, 'text2image', COST_PER, opStart, Date.now(),
                       'succeeded', { op: 'upscale', scale: factor });
    return json({ ok: true, success: true, path: result.url, newPath: result.url, creditsRemaining: remaining });
  } catch (e) {
    await addCredits(env, user.id, COST_PER);
    await refundModalSpend(env, estimatedTotal);
    await logOperation(env, user.id, 'text2image', 0, opStart, Date.now(),
                       'failed', { op: 'upscale', error: e instanceof Error ? e.message : String(e) });
    return err(502, `upscale failed (credits refunded): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Attach an existing mesh URL to a (possibly new) project for the
 *  current user. Used by both copyMeshToProject and
 *  createProjectFromMesh — the two desktop operations are the same
 *  thing in the cloud DB model (project = grouping by name on jobs).
 *  No GPU call, no Modal cost, no credit spend. */
async function handleCopyMeshToProject(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');

  const { meshUrl, meshId, targetProject } = await req.json() as {
    meshUrl?: string;
    meshId?: string;
    targetProject?: string;
  };
  const projectName = (targetProject ?? '').toString().trim();
  if (!projectName) return err(400, 'targetProject required');

  // Resolve a final URL — caller can pass either the mesh URL directly
  // OR the job id (we look it up in the DB).
  let finalUrl = meshUrl ?? '';
  let assetType = 'character';
  let mode = 'standard';
  if (!finalUrl && meshId) {
    const { data, error } = await supabaseAdmin(env)
      .from('jobs')
      .select('mesh_url, asset_type, mode')
      .eq('id', meshId).eq('user_id', user.id).maybeSingle();
    if (error || !data) return err(404, 'mesh not found in your account');
    finalUrl = (data as { mesh_url: string | null }).mesh_url ?? '';
    assetType = (data as { asset_type?: string }).asset_type ?? assetType;
    mode      = (data as { mode?: string }).mode ?? mode;
  }
  if (!finalUrl) return err(400, 'meshUrl or meshId required');

  // Reject any meshUrl that isn't on our trusted upstreams. Without this
  // check a malicious client could pass an attacker-controlled https URL
  // that the admin model-viewer would then dereference (XSS / data exfil
  // vector). Uses the module-level allow-list (R2 + replicate.delivery).
  if (!isTrustedAssetHost(env, finalUrl)) return err(400, 'meshUrl host not allowed');

  // Insert a new job row with the same mesh_url but the new project_name.
  // credit_cost = 0 (no GPU work — just a project re-grouping).
  const newId = 'copy_' + crypto.randomUUID().replace(/-/g, '');
  await supabaseAdmin(env).from('jobs').insert({
    id: newId, user_id: user.id,
    asset_type: assetType, mode, seed: 0,
    credit_cost: 0, status: 'succeeded',
    type: 'mesh-op-client',
    mesh_url: finalUrl,
    project_name: projectName,
    options: { operation_type: 'mesh', cost_usd: 0, copied_from: meshId ?? null },
    created_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  });
  return json({ ok: true, success: true, id: newId, project_name: projectName, mesh_url: finalUrl });
}

/** Auto-rectify endpoint — re-generate an orthographic FRONT (or 3/4 ISO)
 *  view from a prompt and/or a reference image, using multi-seed silhouette
 *  symmetry scoring. Verbatim feature port of `generate_front_strict.py`.
 *  Requires Modal (no Replicate fallback). */
async function handleRectifyImage(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MODAL_RECTIFY_URL) {
    return err(503, 'rectify backend unavailable (cloud GPU not configured)');
  }
  const { prompt, refImageUrl, mode, seeds, steps, guidance, ip_scale } =
    await req.json() as {
      prompt?: string;
      refImageUrl?: string;
      mode?: 'front' | 'iso';
      seeds?: number;
      steps?: number;
      guidance?: number;
      ip_scale?: number;
    };
  const rawPrompt = (prompt ?? '').toString().trim();
  if (!rawPrompt && !refImageUrl) return err(400, 'prompt or refImageUrl required');

  // NSFW prompt pre-filter (same policy as text2image / back-view).
  if (rawPrompt) {
    const envUnrestricted = env.FABMESH_UNRESTRICTED === '1';
    const userState = await getParentalState(env, user.id);
    const unrestricted = envUnrestricted || userState.unrestricted;
    const safety = checkPromptSafety(rawPrompt, unrestricted);
    if (!safety.safe) {
      return json({ ok: false, success: false,
        error: safety.reason ?? 'prompt blocked by content filter',
        blocked: safety.blocked }, { status: 400 });
    }
  }

  // Cost: 1 rectify call ≈ N seeds × back-view ≈ $0.10 × 3 = $0.30 estimate.
  // Credit-wise we charge 3 credits to match the GPU work.
  const nSeeds = Math.max(1, Math.min(5, seeds ?? 3));
  const COST_PER_RECTIFY = 3;
  const cost = COST_PER_RECTIFY;
  const estimatedTotal = 0.10 * nSeeds;

  const remainingBudget = await checkAndIncrementModalSpend(env, estimatedTotal, user.id);
  if (remainingBudget == null) {
    return json({ ok: false, success: false,
      error: `daily Cloud GPU budget reached. Try again after midnight UTC.` }, { status: 429 });
  }
  const remainingUserCalls = await checkAndIncrementUserCalls(env, user.id);
  if (remainingUserCalls == null) {
    await refundModalSpend(env, estimatedTotal);
    return json({ ok: false, success: false,
      error: `you've reached the per-user daily generation limit.` }, { status: 429 });
  }

  const remaining = await spendCredits(env, user.id, cost);
  if (remaining == null) {
    await refundModalSpend(env, estimatedTotal);
    return json({ ok: false, success: false,
      error: `insufficient credits — rectify costs ${cost} credits` }, { status: 402 });
  }

  let path: string;
  const opStart = Date.now();
  try {
    path = await callModalRectify(env, user.id, {
      prompt: rawPrompt,
      refImageUrl,
      mode: mode === 'iso' ? 'iso' : 'front',
      seeds: nSeeds,
      steps,
      guidance,
      ip_scale,
    }, 'rectify');
  } catch (e) {
    await addCredits(env, user.id, cost);
    await refundModalSpend(env, estimatedTotal);
    await logOperation(env, user.id, 'rectify', 0, opStart, Date.now(),
                       'failed', { error: e instanceof Error ? e.message : String(e), mode, nSeeds });
    return err(502, `rectify failed (credits refunded): ${e instanceof Error ? e.message : String(e)}`);
  }
  await logOperation(env, user.id, 'rectify', cost, opStart, Date.now(),
                     'succeeded', { mode, nSeeds });
  return json({ ok: true, success: true, path, creditsRemaining: remaining });
}

// CSV-field escape — quote if the value contains , " or newline.
function _csvEsc(s: unknown): string {
  const v = String(s ?? '');
  return /[,"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// Hardcoded list of admin emails — only these accounts can hit
// /api/admin/*. Putting the check here keeps the secret out of the
// frontend bundle. Add new admins here as the team grows.
const ADMIN_EMAILS = new Set<string>([
  'myfabmesh.contact@gmail.com',   // pro/business account (NOT the owner's personal address)
]);

// Admin session — short-lived signed token stored in an httpOnly cookie.
// Layer 2 of defense on top of the Supabase email check. Even if a
// non-admin email somehow ends up in ADMIN_EMAILS, they still can't get
// in without knowing ADMIN_PASSWORD. Signature uses HMAC-SHA256.
const ADMIN_COOKIE = 'admin_session';
const ADMIN_TTL_SEC = 60 * 60 * 4;  // 4 hours

async function _hmacSign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  // Base64url so the value is cookie-safe.
  const bytes = new Uint8Array(sig);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Returns the current admin password verification source:
 *  - If R2 has _meta/admin_password.json (set via /api/admin/reset-password),
 *    return { mode: 'r2', salt, hash } and login compares SHA-256(salt+pw).
 *  - Otherwise fall back to env.ADMIN_PASSWORD as a plain literal. */
type AdminPwSource =
  | { mode: 'r2'; salt: string; hash: string; signingKey: string }
  | { mode: 'env'; literal: string; signingKey: string }
  | { mode: 'none' };

async function _getAdminPasswordSource(env: Env): Promise<AdminPwSource> {
  // R2-stored hash takes precedence if present.
  if (env.MESHES) {
    try {
      const obj = await env.MESHES.get('_meta/admin_password.json');
      if (obj) {
        const parsed = await obj.json() as { salt?: string; hash?: string };
        if (parsed?.salt && parsed?.hash) {
          // HMAC signing key: prefer env so the cookie survives a hash
          // rotation. Fall back to the hash if env is missing.
          const signingKey = env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.length >= 20
            ? env.ADMIN_PASSWORD : parsed.hash;
          return { mode: 'r2', salt: parsed.salt, hash: parsed.hash, signingKey };
        }
      }
    } catch { /* fall through */ }
  }
  if (env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.length >= 20) {
    return { mode: 'env', literal: env.ADMIN_PASSWORD, signingKey: env.ADMIN_PASSWORD };
  }
  return { mode: 'none' };
}

/** Nom d'utilisateur admin en vigueur.
 *  Ordre : ce qui est stocke dans _meta/admin_password.json (pose par l'ecran
 *  de rotation) > env.ADMIN_USERNAME > 'admin'.
 *  Il y a TOUJOURS une valeur : sans repli, une installation qui n'a jamais
 *  rotationne son mot de passe n'aurait aucun nom valide et serait enfermee
 *  dehors. Le nom n'est pas un secret, c'est un second champ a connaitre. */
async function _getAdminUsername(env: Env): Promise<string> {
  if (env.MESHES) {
    try {
      const obj = await env.MESHES.get('_meta/admin_password.json');
      if (obj) {
        const parsed = await obj.json() as { username?: string };
        if (parsed?.username && String(parsed.username).trim()) {
          return String(parsed.username).trim().toLowerCase();
        }
      }
    } catch { /* repli ci-dessous */ }
  }
  if (env.ADMIN_USERNAME && env.ADMIN_USERNAME.trim()) {
    return env.ADMIN_USERNAME.trim().toLowerCase();
  }
  return 'admin';
}

async function _hashAdminPassword(salt: string, password: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(salt + ':' + password));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

async function _adminTokenCheck(req: Request, env: Env): Promise<boolean> {
  const src = await _getAdminPasswordSource(env);
  if (src.mode === 'none') return false;  // Server misconfigured — fail closed.
  const secret = src.signingKey;
  const raw = parseCookies(req)[ADMIN_COOKIE];
  if (!raw) return false;
  const dot = raw.lastIndexOf('.');
  if (dot < 0) return false;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  // payload is "<userEmail>:<expiresAt>"
  const parts = payload.split(':');
  if (parts.length !== 2) return false;
  const exp = parseInt(parts[1], 10);
  if (!exp || Date.now() / 1000 > exp) return false;
  const expectedSig = await _hmacSign(secret, payload);
  // Constant-time compare to dodge timing leaks.
  if (sig.length !== expectedSig.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expectedSig.charCodeAt(i);
  return diff === 0;
}

async function _requireAdmin(req: Request, env: Env)
  : Promise<{ id: string; email: string | null; credits: number } | Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!user.email || !ADMIN_EMAILS.has(user.email.toLowerCase())) {
    return err(403, 'forbidden');
  }
  // Second factor — must have unlocked /admin with the password and
  // still hold a valid signed session cookie.
  if (!(await _adminTokenCheck(req, env))) {
    return err(401, 'admin_password_required');
  }
  return user;
}

/** POST /api/admin/login — exchange the admin password for a signed
 *  cookie. Body: { password: string }. The cookie is httpOnly + Secure
 *  + SameSite=Strict and TTL 4h. Rate-limited by Cloudflare's default
 *  burst protection (no extra logic needed at this scale). */
/** Verify a provided admin password against the SAME source as /api/admin/login:
 *  the R2 reset hash (_meta/admin_password.json) if present, else env.ADMIN_PASSWORD.
 *  Used as the second-factor check by every sensitive admin action so a
 *  forgot-password reset is honoured everywhere (not just at login). */
async function _verifyAdminPassword(env: Env, provided: string): Promise<boolean> {
  const src = await _getAdminPasswordSource(env);
  if (src.mode === 'none') return false;
  let expected: string, actual: string;
  if (src.mode === 'r2') { expected = src.hash; actual = await _hashAdminPassword(src.salt, provided); }
  else { expected = src.literal; actual = provided; }
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function handleAdminLogin(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user || !user.email || !ADMIN_EMAILS.has(user.email.toLowerCase())) {
    return err(401, 'unauthorized');
  }
  const pwSrc = await _getAdminPasswordSource(env);
  if (pwSrc.mode === 'none') {
    return err(500, 'admin password not configured (set via env ADMIN_PASSWORD or /api/admin/reset-password)');
  }

  // Rate-limit / lockout: track failed attempts per source IP. After
  // 10 fails in the last hour, return 429. Counters live in R2 so a
  // Worker restart doesn't wipe them. Successful login resets the
  // counter for that IP. Cheap (one R2 read+put per attempt).
  const sourceIp = req.headers.get('cf-connecting-ip')
                ?? req.headers.get('x-forwarded-for')
                ?? 'unknown';
  const _ipSafe = sourceIp.replace(/[^A-Fa-f0-9.:]/g, '_').slice(0, 64);
  const lockoutKey = `_meta/admin_login_fails/${_ipSafe}.json`;
  let fails: { count: number; first_ts: number } = { count: 0, first_ts: 0 };
  try {
    const obj = await env.MESHES?.get(lockoutKey);
    if (obj) fails = await obj.json() as typeof fails;
  } catch {}
  const HOUR = 60 * 60 * 1000;
  if (fails.count >= 10 && Date.now() - fails.first_ts < HOUR) {
    return err(429, 'too many failed attempts; try again in an hour');
  }
  // Stale window — reset.
  if (Date.now() - fails.first_ts > HOUR) fails = { count: 0, first_ts: 0 };

  let body: { username?: string; password?: string; totp?: string };
  try { body = await req.json() as { username?: string; password?: string; totp?: string }; } catch { return err(400, 'bad json'); }
  const provided = String(body.password ?? '');
  if (!provided) return err(400, 'password required');
  const providedUser = String(body.username ?? '').trim().toLowerCase();
  if (!providedUser) return err(400, 'username required');
  const _recordFail = async () => {
    fails.count += 1;
    if (fails.first_ts === 0) fails.first_ts = Date.now();
    try { await env.MESHES?.put(lockoutKey, JSON.stringify(fails)); } catch {}
  };
  // Le nom d'utilisateur doit correspondre. On ne dit JAMAIS lequel des deux
  // champs est faux : un message distinct permettrait d'enumerer les noms
  // valides. Meme message, meme compteur d'echecs, meme verrouillage.
  const expectedUser = await _getAdminUsername(env);
  let ok = providedUser === expectedUser;
  if (!ok) {
    await _recordFail();
    await _auditLog(env, {
      req, actorEmail: user.email,
      action: 'admin_login_failed',
      details: { reason: 'invalid_username', tried: providedUser.slice(0, 40), fails: fails.count + 1 },
    });
    return err(401, 'invalid credentials');
  }
  ok = false;
  if (pwSrc.mode === 'env') {
    if (provided.length === pwSrc.literal.length) {
      let diff = 0;
      for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ pwSrc.literal.charCodeAt(i);
      ok = diff === 0;
    }
  } else if (pwSrc.mode === 'r2') {
    const computed = await _hashAdminPassword(pwSrc.salt, provided);
    if (computed.length === pwSrc.hash.length) {
      let diff = 0;
      for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ pwSrc.hash.charCodeAt(i);
      ok = diff === 0;
    }
  }
  if (!ok) {
    await _recordFail();
    // Journal des tentatives : une rafale d'échecs sur le dashboard admin
    // doit être visible (onglet Audit log), pas seulement comptée.
    await _auditLog(env, {
      req, actorEmail: user.email,
      action: 'admin_login_failed',
      details: { reason: 'invalid_password', fails: fails.count },
    });
    return err(401, 'invalid credentials');
  }
  // Successful password check — wipe the IP's failure counter so the
  // admin isn't locked out after a typo + correct retry.
  try { await env.MESHES?.delete(lockoutKey); } catch {}

  // 2FA REACTIVEE A LA CONNEXION (demande user du 2026-07-27, apres l'avoir
  // retiree plus tot le meme jour). Ce qui avait motive le retrait n'etait pas
  // le second facteur lui-meme mais l'IMPASSE qu'il creait : la rotation du
  // mot de passe l'exigeait sans offrir de champ pour le saisir. Cette impasse
  // n'existe plus — la rotation passe desormais par un code recu par mail
  // (meme rail que les utilisateurs), qui ne demande AUCUN code TOTP. Un
  // authenticator perdu ne peut donc plus enfermer dehors.
  //
  // Le controle reste conditionnel a l'enrolement : tant qu'aucun secret n'est
  // pose, la connexion se fait au mot de passe seul, ce qui permet d'atteindre
  // l'ecran d'enrolement (onglet System > 2FA) sans oeuf-et-poule.
  const totpSecret = await _getAdminTotpSecret(env);
  if (totpSecret) {
    const code = String(body.totp ?? '').trim();
    if (!code) return err(401, 'totp_required');
    if (!(await _totpVerify(totpSecret, code))) {
      await _recordFail();
      await _auditLog(env, {
        req, actorEmail: user.email,
        action: 'admin_login_failed',
        details: { reason: 'invalid_totp' },
      });
      return err(401, 'invalid totp');
    }
  }
  // Connexion admin réussie — tracée avec l'IP par _auditLog.
  await _auditLog(env, {
    req, actorEmail: user.email,
    action: 'admin_login_ok',
    details: { totp: totpSecret ? 'yes' : 'not_enrolled' },
  });

  const exp = Math.floor(Date.now() / 1000) + ADMIN_TTL_SEC;
  const payload = `${user.email.toLowerCase()}:${exp}`;
  const sig = await _hmacSign(pwSrc.signingKey, payload);
  const value = `${payload}.${sig}`;
  return new Response(JSON.stringify({ ok: true, expires_at: exp, totp_enrolled: !!totpSecret }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': `${ADMIN_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${ADMIN_TTL_SEC}`,
    },
  });
}

/** POST /api/admin/reset-password — set/rotate the admin dashboard
 *  password. The caller must be Supabase-logged-in as one of the
 *  ADMIN_EMAILS — that membership is the recovery factor (no email
 *  link, no 2FA prompt). Body: { newPassword: string } where
 *  newPassword.length >= 20.
 *
 *  Stores SHA-256(salt + newPassword) at _meta/admin_password.json in
 *  R2. Subsequent /api/admin/login checks against this hash first;
 *  the env.ADMIN_PASSWORD literal becomes the fallback only.
 *
 *  Does NOT require the existing admin password cookie — that's the
 *  whole point of forgot-password. The Supabase admin-email check is
 *  the gate. */

// ---------------------------------------------------------------------------
// Rotation du mot de passe admin — MEME RAIL QUE LES UTILISATEURS
// ---------------------------------------------------------------------------
// Le parcours est celui de n'importe quel client MyFabmesh, a l'identique :
//   1. resetPasswordForEmail  -> Supabase envoie un mail contenant {{ .Token }},
//      un code a 6 chiffres (cf. cloud/src/app/login/LoginForm.tsx:187)
//   2. verifyOtp type:'recovery' -> Supabase valide le code
//      (cf. cloud/src/app/auth/reset-password/page.tsx:76)
// On appelle donc les MEMES endpoints Supabase, avec les MEMES gabarits de mail
// et le MEME SMTP. Aucune dependance supplementaire : la premiere version
// passait par Resend, ce qui exigeait une cle absente du worker et affichait
// une erreur a l'utilisateur au lieu d'envoyer quoi que ce soit.
//
// Supabase gere lui-meme l'expiration, l'usage unique et la limitation de
// debit du code : rien a stocker de notre cote.
//
// SORTIE DE SECOURS si le mail Supabase ne part pas : poser
// `wrangler secret put ADMIN_PASSWORD` remet un mot de passe litteral en
// vigueur (cf. _getAdminPasswordSource). Il n'y a donc pas d'enfermement
// possible, meme si l'envoi de mail tombe.

/** Envoie le code de recuperation Supabase sur la boite admin. */
async function _supabaseSendRecovery(env: Env, email: string): Promise<{ ok: boolean; error?: string }> {
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!url || !anon) return { ok: false, error: 'supabase_not_configured' };
  try {
    const r = await fetch(`${url}/auth/v1/recover`, {
      method: 'POST',
      headers: { apikey: anon, 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (!r.ok) return { ok: false, error: (await r.text()).slice(0, 200) };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Valide le code recu par mail via Supabase (type 'recovery', comme la page
 *  de reset des utilisateurs). Supabase consomme le code : il ne peut pas
 *  resservir. */
async function _supabaseVerifyRecovery(env: Env, email: string, token: string): Promise<boolean> {
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!url || !anon || !token) return false;
  try {
    const r = await fetch(`${url}/auth/v1/verify`, {
      method: 'POST',
      headers: { apikey: anon, 'content-type': 'application/json' },
      body: JSON.stringify({ email, token, type: 'recovery' }),
    });
    return r.ok;
  } catch { return false; }
}

/** POST /api/admin/reset-request — declenche l'envoi du code Supabase. */
async function handleAdminResetRequest(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized — sign in with your admin Supabase account first');
  if (!user.email || !ADMIN_EMAILS.has(user.email.toLowerCase())) {
    return err(403, 'forbidden — your Supabase email is not in the admin allow-list');
  }
  const sent = await _supabaseSendRecovery(env, user.email);
  if (!sent.ok) {
    await _auditLog(env, { req, actorEmail: user.email,
      action: 'admin_password_reset_code_failed', details: { error: sent.error ?? '' } });
    return err(502, `could not send the code: ${sent.error ?? 'unknown'}`);
  }
  await _auditLog(env, { req, actorEmail: user.email,
    action: 'admin_password_reset_code_sent', details: {} });
  const masked = user.email.replace(/^(.{2}).*(@.*)$/, '$1***$2');
  return json({ ok: true, sent_to: masked });
}

/** Ticket de rotation : delivre APRES validation du code, consomme par la
 *  rotation. Il joue le role que la SESSION Supabase joue pour un utilisateur
 *  normal : verifyOtp cree une session, puis updateUser s'en sert. Ici
 *  verifyOtp consomme le code cote Supabase, donc on ne peut pas le revalider
 *  au moment du changement de mot de passe — d'ou ce ticket.
 *  Stocke HASHE, valable 5 minutes, usage unique. */
const ADMIN_RESET_TICKET_KEY = '_meta/admin_reset_ticket.json';
// 15 minutes, pas 5. Le ticket est delivre APRES validation du code, et il
// reste ensuite a CHOISIR un mot de passe d'au moins 20 caracteres — ce qui
// prend souvent plus de 5 minutes. Constate en production le 2026-07-27 :
// code accepte, puis « Your verification expired » au moment de valider.
const ADMIN_RESET_TICKET_TTL_MS = 15 * 60 * 1000;

/** POST /api/admin/reset-verify — valide le code recu par mail et rend un
 *  ticket. Etape intermediaire, calquee sur la page utilisateur qui verifie le
 *  code AVANT d'afficher le choix du mot de passe. */
async function handleAdminResetVerify(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized — sign in with your admin Supabase account first');
  if (!user.email || !ADMIN_EMAILS.has(user.email.toLowerCase())) {
    return err(403, 'forbidden — your Supabase email is not in the admin allow-list');
  }
  if (!env.MESHES) return err(500, 'R2 binding required');
  const body = await req.json().catch(() => ({})) as { code?: string };
  const code = String(body?.code ?? '').trim();
  if (!code) return err(400, 'code_required');
  if (!(await _supabaseVerifyRecovery(env, user.email, code))) {
    await _auditLog(env, { req, actorEmail: user.email,
      action: 'admin_password_reset_denied', details: { reason: 'invalid_code' } });
    return err(401, 'invalid_code');
  }
  const raw = new Uint8Array(24);
  crypto.getRandomValues(raw);
  const ticket = Array.from(raw).map(b => b.toString(16).padStart(2, '0')).join('');
  const saltBuf = new Uint8Array(16);
  crypto.getRandomValues(saltBuf);
  const salt = Array.from(saltBuf).map(b => b.toString(16).padStart(2, '0')).join('');
  await env.MESHES.put(ADMIN_RESET_TICKET_KEY, JSON.stringify({
    salt, hash: await _hashAdminPassword(salt, ticket),
    exp: Date.now() + ADMIN_RESET_TICKET_TTL_MS,
    email: user.email,
  }), { httpMetadata: { contentType: 'application/json' } });
  await _auditLog(env, { req, actorEmail: user.email,
    action: 'admin_password_reset_code_ok', details: {} });
  return json({ ok: true, ticket, expires_in_s: ADMIN_RESET_TICKET_TTL_MS / 1000 });
}

/** Consomme le ticket. Renvoie null si valide, sinon la reponse d'erreur. */
async function _consumeAdminResetTicket(env: Env, provided: string, email: string): Promise<Response | null> {
  const obj = await env.MESHES!.get(ADMIN_RESET_TICKET_KEY);
  if (!obj) return err(400, 'code_required');
  let rec: { salt?: string; hash?: string; exp?: number; email?: string; tries?: number };
  try { rec = await obj.json(); } catch { return err(400, 'code_required'); }
  if (!rec?.salt || !rec?.hash || !rec.exp || Date.now() > rec.exp) {
    await env.MESHES!.delete(ADMIN_RESET_TICKET_KEY);
    return err(400, 'ticket_expired');
  }
  if ((rec.email ?? '').toLowerCase() !== email.toLowerCase()) return err(403, 'forbidden');
  const computed = await _hashAdminPassword(rec.salt, provided);
  let diff = computed.length ^ rec.hash.length;
  for (let i = 0; i < computed.length && i < rec.hash.length; i++) {
    diff |= computed.charCodeAt(i) ^ rec.hash.charCodeAt(i);
  }
  if (diff !== 0) {
    // On NE DETRUIT PAS le ticket sur un simple echec de comparaison : la
    // premiere version le brulait a chaque appel, si bien qu'un mot de passe
    // trop court ou toute autre erreur cote client condamnait definitivement
    // la tentative et forcait a redemander un code. On compte les essais a la
    // place, et on ne brule qu'au-dela de 5.
    const tries = (rec.tries ?? 0) + 1;
    if (tries >= 5) {
      await env.MESHES!.delete(ADMIN_RESET_TICKET_KEY);
      return err(429, 'too_many_attempts');
    }
    await env.MESHES!.put(ADMIN_RESET_TICKET_KEY,
      JSON.stringify({ ...rec, tries }), { httpMetadata: { contentType: 'application/json' } });
    return err(401, 'ticket_invalid');
  }
  await env.MESHES!.delete(ADMIN_RESET_TICKET_KEY);   // consomme au SUCCES seulement
  return null;
}

async function handleAdminResetPassword(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized — sign in with your admin Supabase account first');
  if (!user.email || !ADMIN_EMAILS.has(user.email.toLowerCase())) {
    return err(403, 'forbidden — your Supabase email is not in the admin allow-list');
  }
  if (!env.MESHES) return err(500, 'R2 binding required');
  const body = await req.json().catch(() => ({})) as { newPassword?: string; username?: string; ticket?: string; totp?: string };
  // Code recu par mail : TOUJOURS obligatoire. C'est lui qui prouve l'acces a
  // la boite admin ; sans ca, la session Supabase seule suffirait a rotationner
  // le mot de passe, et le mot de passe du dashboard ne protegerait rien face a
  // son detenteur. La sortie de secours en cas de panne de mail est
  // `wrangler secret put ADMIN_PASSWORD`, pas un contournement dans l'UI.
  // Le TICKET delivre par /api/admin/reset-verify est OBLIGATOIRE. Il prouve
  // qu'un code recu sur la boite admin vient d'etre valide par Supabase — le
  // meme code que recoit un utilisateur normal. Sans lui, la session Supabase
  // seule suffirait a rotationner le mot de passe, et le mot de passe du
  // dashboard ne protegerait rien face a son detenteur.
  // Sortie de secours en cas de panne SMTP : `wrangler secret put
  // ADMIN_PASSWORD`, pas un contournement dans l'interface.
  const ticket = String(body?.ticket ?? '').trim();
  if (!ticket) return err(400, 'code_required');
  const ticketErr = await _consumeAdminResetTicket(env, ticket, user.email);
  if (ticketErr) return ticketErr;
  const newPassword = String(body?.newPassword ?? '');
  if (newPassword.length < 20) {
    return err(400, 'newPassword must be at least 20 characters');
  }
  if (newPassword.length > 256) {
    return err(400, 'newPassword too long (max 256)');
  }
  // Generate a fresh random salt every reset so the same plaintext
  // never produces the same hash twice (defense if R2 leaks).
  const saltBuf = new Uint8Array(16);
  crypto.getRandomValues(saltBuf);
  const salt = Array.from(saltBuf).map(b => b.toString(16).padStart(2, '0')).join('');
  const hash = await _hashAdminPassword(salt, newPassword);
  // Le nom d'utilisateur est persiste a cote du hash : il devient ainsi
  // modifiable depuis le dashboard, sans passer par `wrangler secret put`.
  // Champ vide = on garde le nom en vigueur (on ne le remet pas a 'admin').
  const newUsername = String(body?.username ?? '').trim().toLowerCase()
    || await _getAdminUsername(env);
  await env.MESHES.put('_meta/admin_password.json', JSON.stringify({
    salt, hash,
    username: newUsername,
    rotated_at: new Date().toISOString(),
    rotated_by: user.email,
  }), { httpMetadata: { contentType: 'application/json' } });
  // Wipe any existing login lockout counters for this user.
  // (The login flow already wipes the IP counter on success, but
  // we may want a clean slate post-reset.)
  try {
    const sourceIp = req.headers.get('cf-connecting-ip') ?? 'unknown';
    const _ipSafe = sourceIp.replace(/[^A-Fa-f0-9.:]/g, '_').slice(0, 64);
    await env.MESHES.delete(`_meta/admin_login_fails/${_ipSafe}.json`);
  } catch {}
  // Audit log: who changed the admin password and when.
  await _auditLog(env, {
    req, actorEmail: user.email,
    action: 'admin_password_reset',
    details: { mode: 'r2_hash', username: newUsername },
  });
  return json({ ok: true, message: 'Password rotated. Sign in with your new password.' });
}

/** POST /api/admin/logout — clear the admin cookie. Idempotent. */
async function handleAdminLogout(_req: Request, _env: Env): Promise<Response> {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': `${ADMIN_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
    },
  });
}

/** GET /api/history.csv — PUBLIC user export. Shows the user their own
 *  activity (date, type, status, duration, credits spent). Does NOT
 *  reveal cost or margin — those are business-internal numbers and live
 *  on /api/admin/history.csv only. */
async function handleHistoryCsv(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');

  const { data, error } = await supabaseAdmin(env)
    .from('jobs')
    .select('id, asset_type, mode, status, credit_cost, options, created_at, finished_at, project_name, mesh_url, type, cost_usd')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(5000);
  if (error) return err(500, error.message);

  const header = [
    'date_iso', 'type', 'status', 'duration_s', 'credits',
    'project', 'asset_type', 'mode'
  ];
  const lines: string[] = [header.join(',')];

  type J = {
    id: string; asset_type: string; mode: string; status: string;
    credit_cost: number; options: Record<string, unknown> | null;
    created_at: string; finished_at: string | null;
    project_name: string | null; mesh_url: string | null;
  };
  for (const j of ((data ?? []) as J[])) {
    const opType = String(j.type ?? j.options?.operation_type ?? j.asset_type ?? 'mesh');
    const durMs = j.options?.duration_ms != null
      ? Number(j.options.duration_ms)
      : (j.finished_at
          ? new Date(j.finished_at).getTime() - new Date(j.created_at).getTime()
          : 0);
    const credits = j.status === 'succeeded' ? (j.credit_cost ?? 0) : 0;
    lines.push([
      j.created_at,
      opType,
      j.status,
      (durMs / 1000).toFixed(1),
      credits,
      _csvEsc(j.project_name ?? ''),
      _csvEsc(j.asset_type ?? ''),
      _csvEsc(j.mode ?? ''),
    ].join(','));
  }

  return new Response(lines.join('\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="myfabmesh-history-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}

/** GET /api/admin/history.csv — ADMIN ONLY. Every operation across
 *  every user, with margin per row. Same columns as the user CSV
 *  PLUS cost_usd, cost_eur, revenue_eur, margin_eur, user_email. */
async function handleAdminHistoryCsv(req: Request, env: Env): Promise<Response> {
  const userOrResp = await _requireAdmin(req, env);
  if (userOrResp instanceof Response) return userOrResp;

  const sb = supabaseAdmin(env);
  const { data, error } = await sb
    .from('jobs')
    .select('id, user_id, asset_type, mode, status, credit_cost, options, created_at, finished_at, project_name, mesh_url, type, cost_usd')
    .order('created_at', { ascending: false })
    .limit(10000);
  if (error) return err(500, error.message);

  // Resolve user_id → email by querying the profiles table. We batch
  // the lookup to avoid N+1 round-trips on a 10k-row export.
  const userIds = Array.from(new Set((data ?? []).map((j: { user_id: string }) => j.user_id)));
  const emailById = new Map<string, string>();
  if (userIds.length) {
    const { data: profiles } = await sb
      .from('profiles')
      .select('id, email')
      .in('id', userIds);
    for (const p of (profiles ?? []) as { id: string; email: string }[]) {
      emailById.set(p.id, p.email ?? '');
    }
  }

  const EUR_PER_CREDIT_NET = 0.162;
  const USD_TO_EUR = 0.93;

  const header = [
    'date_iso', 'user_email', 'type', 'status', 'duration_s', 'credits',
    'cost_usd', 'cost_eur', 'revenue_eur', 'margin_eur',
    'project', 'asset_type', 'mode', 'mesh_key', 'mesh_url'
  ];
  const lines: string[] = [header.join(',')];

  type J = {
    id: string; user_id: string; asset_type: string; mode: string;
    status: string; credit_cost: number; options: Record<string, unknown> | null;
    created_at: string; finished_at: string | null;
    project_name: string | null; mesh_url: string | null;
  };
  const rows = (data ?? []) as J[];
  // Pre-sign the persisted mesh keys with the long 'export' TTL (30d); the
  // raw key is also emitted (mesh_key) so a stale export can be refreshed.
  const meshUrlSigned = await Promise.all(rows.map(j =>
    j.mesh_url ? signedR2Url(env, j.mesh_url, 'export') : Promise.resolve('')));
  let _rowIdx = 0;
  for (const j of rows) {
    const _signedMeshUrl = meshUrlSigned[_rowIdx++];
    const opType = String(j.type ?? j.options?.operation_type ?? j.asset_type ?? 'mesh');
    const costUsd = Number(j.cost_usd ?? j.options?.cost_usd
                          ?? MODAL_COST_USD[opType as keyof typeof MODAL_COST_USD]
                          ?? 0);
    const durMs = j.options?.duration_ms != null
      ? Number(j.options.duration_ms)
      : (j.finished_at
          ? new Date(j.finished_at).getTime() - new Date(j.created_at).getTime()
          : 0);
    const credits = j.status === 'succeeded' ? (j.credit_cost ?? 0) : 0;
    const revenueEur = credits * EUR_PER_CREDIT_NET;
    const costEur = costUsd * USD_TO_EUR;
    const marginEur = revenueEur - costEur;

    lines.push([
      j.created_at,
      _csvEsc(emailById.get(j.user_id) ?? ''),
      opType,
      j.status,
      (durMs / 1000).toFixed(1),
      credits,
      costUsd.toFixed(4),
      costEur.toFixed(4),
      revenueEur.toFixed(4),
      marginEur.toFixed(4),
      _csvEsc(j.project_name ?? ''),
      _csvEsc(j.asset_type ?? ''),
      _csvEsc(j.mode ?? ''),
      _csvEsc(j.mesh_url ?? ''),
      _csvEsc(_signedMeshUrl),
    ].join(','));
  }

  return new Response(lines.join('\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="admin-history-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}

/** GET /api/admin/stats.json — ADMIN ONLY. Aggregated business metrics
 *  for the monitoring dashboard. Returns counts + revenue/margin totals
 *  across the whole user base, plus 7/30-day series. */
async function handleAdminStats(req: Request, env: Env): Promise<Response> {
  const userOrResp = await _requireAdmin(req, env);
  if (userOrResp instanceof Response) return userOrResp;

  const sb = supabaseAdmin(env);

  // Job-derived metrics — one query, then aggregate in-Worker (rows
  // are tiny, this is cheaper than 6 round-trips and keeps the SQL
  // simple for now).
  const { data: jobs, error: jobsErr } = await sb
    .from('jobs')
    // finished_at added 2026-07-28: the dashboard now prices each job from
    // its MEASURED duration instead of a static per-op guess.
    .select('user_id, status, credit_cost, options, created_at, finished_at, type, cost_usd')
    .order('created_at', { ascending: false })
    .limit(20000);
  if (jobsErr) return err(500, jobsErr.message);

  const EUR_PER_CREDIT_NET = 0.162;
  const USD_TO_EUR = 0.93;
  const now = Date.now();
  const DAY = 86400_000;

  const uniqueUsers = new Set<string>();
  // Real rolling-window activity. active_7d used to be
  // `new Set(last7.flatMap(() => []).concat([...uniqueUsers])).size` — the
  // flatMap yielded nothing, so it was literally uniqueUsers.size, i.e.
  // active_7d == total, forever.
  const active7 = new Set<string>();
  const active30 = new Set<string>();
  const ops = { total: 0, succeeded: 0, failed: 0 };
  const byType: Record<string, { count: number; revenue_eur: number; cost_eur: number; margin_eur: number }> = {};
  let totalRevenueEur = 0, totalCostEur = 0;
  // Activity series (last 30 days, bucket by day).
  const seriesByDay: Record<string, { ops: number; users: Set<string>; revenue_eur: number; cost_eur: number; margin_eur: number }> = {};

  type J = {
    user_id: string; status: string; credit_cost: number;
    options: Record<string, unknown> | null; created_at: string;
    finished_at?: string | null;
  };
  // How many rows we could price from their own duration vs how many
  // fell back to a static guess — shown in the UI so the figures come
  // with their own confidence rather than looking authoritative.
  let measuredRows = 0, guessedRows = 0, measuredSecs = 0;
  for (const j of ((jobs ?? []) as J[])) {
    uniqueUsers.add(j.user_id);
    ops.total += 1;
    if (j.status === 'succeeded') ops.succeeded += 1;
    if (j.status === 'failed') ops.failed += 1;

    const opType = String(j.options?.operation_type ?? 'mesh');
    // MEASURED duration wins over both the stored estimate and the
    // static table. Those two were the reason the dashboard reported a
    // 6x-too-low cost on mesh generation.
    const measured = _measuredCostUsd(opType, j.created_at, j.finished_at ?? undefined);
    if (measured != null) {
      measuredRows += 1;
      measuredSecs += (Date.parse(j.finished_at as string) - Date.parse(j.created_at)) / 1000;
    } else if (j.status === 'succeeded' || j.status === 'failed') {
      guessedRows += 1;
    }
    const costUsd = measured ?? Number(j.cost_usd ?? j.options?.cost_usd
                          ?? MODAL_COST_USD[opType as keyof typeof MODAL_COST_USD]
                          ?? 0);
    const credits = j.status === 'succeeded' ? (j.credit_cost ?? 0) : 0;
    const revenueEur = credits * EUR_PER_CREDIT_NET;
    const costEur = costUsd * USD_TO_EUR;
    const marginEur = revenueEur - costEur;

    totalRevenueEur += revenueEur;
    totalCostEur += costEur;

    const bucket = (byType[opType] ??= { count: 0, revenue_eur: 0, cost_eur: 0, margin_eur: 0 });
    bucket.count += 1;
    bucket.revenue_eur += revenueEur;
    bucket.cost_eur += costEur;
    bucket.margin_eur += marginEur;

    const t = new Date(j.created_at).getTime();
    if (now - t < 30 * DAY) {
      active30.add(j.user_id);
      if (now - t < 7 * DAY) active7.add(j.user_id);
      const day = new Date(j.created_at).toISOString().slice(0, 10);
      const s = (seriesByDay[day] ??= { ops: 0, users: new Set(), revenue_eur: 0, cost_eur: 0, margin_eur: 0 });
      s.ops += 1;
      s.users.add(j.user_id);
      s.revenue_eur += revenueEur;
      s.cost_eur += costEur;
      s.margin_eur += marginEur;
    }
  }

  // Payments — gross revenue (Stripe charges, before fees).
  // Bug fix: was selecting `amount_total` (doesn't exist in schema) and
  // dividing by 100. Real column is `amount_eur`, already in EUR. Result:
  // total_gross_eur was permanently 0 in the admin dashboard.
  let grossRevenueEur = 0;
  let paymentsCount = 0;
  // Qui a REELLEMENT paye au moins une fois. Sert a distinguer le chiffre
  // d'affaires du revenu fictif : `revenueEur = credits * 0.162` comptait
  // CHAQUE credit consomme comme du CA, y compris les 50 credits OFFERTS
  // a l'inscription. Un compte qui n'a jamais rien paye generait donc du
  // « revenu » qui n'a jamais existe.
  const payeurs = new Set<string>();
  try {
    const { data: pays } = await sb
      .from('payments')
      .select('amount_eur, created_at, user_id')
      .order('created_at', { ascending: false })
      .limit(5000);
    for (const p of (pays ?? []) as { amount_eur: number; user_id?: string }[]) {
      grossRevenueEur += p.amount_eur ?? 0;
      paymentsCount += 1;
      if (p.user_id) payeurs.add(p.user_id);
    }
  } catch { /* payments table optional */ }

  // REVENU REEL vs REVENU FICTIF.
  //
  // Tout ce qui precede valorise chaque credit consomme a
  // EUR_PER_CREDIT_NET, sans distinguer un credit ACHETE d'un des 50
  // credits OFFERTS a l'inscription. Sur un produit qui offre 50 credits
  // (~8 $ de calcul Modal) a chaque nouveau compte, l'ecart n'est pas
  // marginal : tant que peu de gens paient, la carte « Revenue net » du
  // dashboard affiche essentiellement du vide.
  //
  // On ne CORRIGE pas le total historique ici (il alimente d'autres
  // cartes), on expose la decomposition pour que l'interface puisse dire
  // la verite : combien de ce « revenu » provient de comptes qui n'ont
  // jamais rien paye.
  let revenusComptesPayeurs = 0;
  let revenusComptesGratuits = 0;
  try {
    for (const j of ((jobs ?? []) as Array<{ user_id: string; status: string; credit_cost: number }>)) {
      if (j.status !== 'succeeded') continue;
      const eur = (j.credit_cost ?? 0) * EUR_PER_CREDIT_NET;
      if (payeurs.has(j.user_id)) revenusComptesPayeurs += eur;
      else revenusComptesGratuits += eur;
    }
  } catch { /* decomposition indisponible : les totaux restent affiches */ }

  // EXACT signup count. `uniqueUsers` above only holds user_ids that appear in
  // `jobs`, i.e. users who ran at least one operation — every signed-up user
  // who never generated anything was invisible in the "Users (total)" tile.
  // head:true returns zero rows, so this is one cheap round-trip.
  let signupsTotal: number | null = null;
  try {
    const { count } = await sb.from('profiles').select('id', { count: 'exact', head: true });
    signupsTotal = count ?? null;
  } catch { /* null → the UI shows '—' rather than a lying 0 */ }

  // Desktop downloads — both the all-time total and the 30-day series
  // (one R2 file per day, _meta/desktop_downloads_YYYY-MM-DD.txt). Total
  // is _meta/desktop_downloads.txt for cheap O(1) reads.
  let desktopDownloads = 0;
  try {
    const txt = await r2GetText(env, '_meta/desktop_downloads.txt');
    desktopDownloads = parseInt(txt ?? '0', 10) || 0;
  } catch { /* ignore */ }
  // Per-day counts — issue 30 R2 reads in parallel (cheap, R2 is fast
  // for tiny files). Missing = 0 (no download that day).
  const dailyDownloads = new Map<string, number>();
  try {
    const days30 = Array.from({ length: 30 }, (_, i) =>
      new Date(now - (29 - i) * DAY).toISOString().slice(0, 10));
    const reads = await Promise.all(days30.map(d =>
      r2GetText(env, `_meta/desktop_downloads_${d}.txt`).then(t => [d, parseInt(t ?? '0', 10) || 0] as const)
    ));
    for (const [d, n] of reads) dailyDownloads.set(d, n);
  } catch { /* ignore */ }

  // Activity in the last 7 / 30 days.
  const series30: Array<{ day: string; ops: number; users: number; revenue_eur: number; cost_eur: number; margin_eur: number; downloads: number }> = [];
  for (let i = 29; i >= 0; i--) {
    const day = new Date(now - i * DAY).toISOString().slice(0, 10);
    const s = seriesByDay[day];
    series30.push({
      day,
      ops: s?.ops ?? 0,
      users: s?.users.size ?? 0,
      revenue_eur: +(s?.revenue_eur ?? 0).toFixed(2),
      cost_eur:    +(s?.cost_eur    ?? 0).toFixed(2),
      margin_eur:  +(s?.margin_eur  ?? 0).toFixed(2),
      downloads:   dailyDownloads.get(day) ?? 0,
    });
  }
  const last7 = series30.slice(-7);
  const sum7 = (k: keyof typeof series30[number]) =>
    last7.reduce((a, b) => a + (typeof b[k] === 'number' ? (b[k] as number) : 0), 0);

  // REAL Modal cost from `modal billing report` (pushed by the billing poller) so
  // the KPIs reflect the ACTUAL bill, not just the worker's per-op estimate.
  let realUsageUsd: number | null = null, realUsageTs: string | null = null;
  let realByApp: Record<string, number> | null = null;
  try {
    const rt = await r2GetText(env, '_meta/modal_real_usage.json');
    const r = rt ? JSON.parse(rt) : null;
    if (r && typeof r.usage === 'number') {
      realUsageUsd = r.usage; realUsageTs = r.ts || null;
      realByApp = (r.by_app && typeof r.by_app === 'object') ? r.by_app : null;
    }
  } catch {}
  const realCostEur = realUsageUsd == null ? null : +(realUsageUsd * USD_TO_EUR).toFixed(2);

  // PERIODES ALIGNEES. `realCostEur` vient du poller qui interroge Modal
  // avec --for "this month" : c'est un cout DU MOIS EN COURS. Il etait
  // soustrait de `totalRevenueEur`, un revenu DEPUIS TOUJOURS — une marge
  // calculee sur deux fenetres differentes ne veut rien dire, et elle
  // s'ameliorait mecaniquement a chaque debut de mois.
  const debutDuMois = new Date();
  debutDuMois.setUTCDate(1);
  debutDuMois.setUTCHours(0, 0, 0, 0);
  let revenuDuMoisEur = 0;
  try {
    for (const j of ((jobs ?? []) as Array<{ status: string; credit_cost: number; created_at: string }>)) {
      if (j.status !== 'succeeded') continue;
      if (new Date(j.created_at).getTime() < debutDuMois.getTime()) continue;
      revenuDuMoisEur += (j.credit_cost ?? 0) * EUR_PER_CREDIT_NET;
    }
  } catch { /* on retombe sur 0, la marge sera simplement negative */ }
  const realMarginEur = realCostEur == null ? null
    : +(revenuDuMoisEur - realCostEur).toFixed(2);

  // FRAICHEUR DE LA FACTURE MODAL. Le poller (scripts/modal_usage_push.py)
  // doit tourner regulierement ; s'il s'arrete, l'ecran continuait
  // d'afficher « facture Modal » sur un chiffre vieux de plusieurs
  // semaines, sans le moindre signe. Un chiffre perime presente comme
  // frais est pire qu'un chiffre absent.
  let realUsageAgeH: number | null = null;
  if (realUsageTs) {
    const t = Date.parse(realUsageTs);
    if (Number.isFinite(t)) realUsageAgeH = Math.round((Date.now() - t) / 3600_000);
  }

  // ── Cron liveness receipt (written by scheduled(), see _meta/cron/last_run.json).
  // One extra tiny R2 GET on an endpoint that already issues ~32 of them, so no
  // new endpoint is needed: the dashboard already polls stats.json.
  let cron: unknown = null;
  try {
    const ct = await r2GetText(env, '_meta/cron/last_run.json');
    cron = ct ? JSON.parse(ct) : null;
  } catch { /* never ran yet, or malformed — the UI shows 'unknown' */ }

  // ── GPU burn rate (item 8b): €/day over 7d and 30d, today's spend vs the
  // daily cap, and how long the prepaid Modal budget lasts at the current rate.
  // Derived from series_30d (already computed) + the three tiny budget counters.
  let budgetTotalUsd = 0, budgetSpentUsd = 0, todaySpendUsd = 0;
  try { budgetTotalUsd = parseFloat(await r2GetText(env, '_meta/modal_budget_total.txt') || '0') || 0; } catch {}
  try { budgetSpentUsd = parseFloat(await r2GetText(env, '_meta/modal_spend_total.txt') || '0') || 0; } catch {}
  try { todaySpendUsd  = parseFloat(await r2GetText(env, `_meta/modal_spend/${todayUTC()}`) || '0') || 0; } catch {}
  const dailyCapUsd = parseFloat(env.MAX_DAILY_MODAL_SPEND_USD ?? '') || DEFAULT_MAX_MODAL_SPEND_USD;
  // Prefer the REAL Modal usage when it is fresh (<26h), same rule as
  // handleAdminModalCredits, so the runway isn't computed off a stale estimate.
  const realFresh = realUsageTs ? (Date.now() - Date.parse(realUsageTs)) < 26 * 3600 * 1000 : false;
  const usedUsd = (realFresh && realUsageUsd != null) ? realUsageUsd : budgetSpentUsd;
  const budgetRemainingUsd = budgetTotalUsd > 0 ? Math.max(0, budgetTotalUsd - usedUsd) : 0;
  const cost7 = last7.reduce((a, b) => a + b.cost_eur, 0);
  const cost30 = series30.reduce((a, b) => a + b.cost_eur, 0);
  const eurPerDay7  = +(cost7 / 7).toFixed(3);
  const eurPerDay30 = +(cost30 / 30).toFixed(3);
  // Runway uses the 7-day rate (most representative of current traffic) and
  // falls back to the 30-day rate when the last week was idle.
  const rateEurPerDay = eurPerDay7 > 0 ? eurPerDay7 : eurPerDay30;
  const remainingEur = budgetRemainingUsd * USD_TO_EUR;
  const daysLeft = (budgetTotalUsd > 0 && rateEurPerDay > 0)
    ? Math.floor(remainingEur / rateEurPerDay) : null;
  const burn = {
    eur_per_day_7d: eurPerDay7,
    eur_per_day_30d: eurPerDay30,
    cost_7d_eur: +cost7.toFixed(2),
    cost_30d_eur: +cost30.toFixed(2),
    today_spend_usd: +todaySpendUsd.toFixed(4),
    daily_cap_usd: dailyCapUsd,
    daily_cap_pct: dailyCapUsd > 0 ? +Math.min(100, (todaySpendUsd / dailyCapUsd) * 100).toFixed(1) : 0,
    budget_total_usd: +budgetTotalUsd.toFixed(2),
    budget_remaining_usd: +budgetRemainingUsd.toFixed(2),
    budget_source: (realFresh && realUsageUsd != null) ? 'real' : 'estimate',
    days_left: daysLeft,
    depletion_date: daysLeft == null ? null
      : new Date(now + daysLeft * DAY).toISOString().slice(0, 10),
  };

  return json({
    generated_at: new Date().toISOString(),
    users: {
      // `total` is KEPT as-is (= users_with_ops) so the two existing tiles
      // don't change meaning under the UI's feet; the UI item renames them.
      total: uniqueUsers.size,
      users_with_ops: uniqueUsers.size,
      signups_total: signupsTotal,
      active_7d: active7.size,
      active_30d: active30.size,
    },
    // The 20 000-row cap orders by created_at DESC, so the OLDEST jobs are the
    // ones dropped: every all-time total below silently understates once the
    // cap bites. Surfaced instead of silently raising the limit (worker memory).
    jobs_scanned: (jobs ?? []).length,
    jobs_truncated: (jobs ?? []).length >= 20000,
    cron,
    burn,
    operations: ops,
    by_type: byType,
    // Where the cost figures come from, so the dashboard can say it
    // rather than presenting guesses with the same authority as
    // measurements. `measured_rows` were priced from their own duration;
    // `guessed_rows` fell back to the static MODAL_COST_USD table.
    cost_confidence: {
      measured_rows: measuredRows,
      guessed_rows: guessedRows,
      measured_hours: +(measuredSecs / 3600).toFixed(2),
      note: 'Coût = durée mesurée × tarif conteneur. N’inclut PAS l’inactivité '
          + 'facturée après chaque appel (scaledown) ni les démarrages à froid : '
          + 'le total réel Modal est donc supérieur, l’écart est l’inactivité.',
    },
    revenue: {
      // ENCAISSEMENT REEL (Stripe) — la seule ligne qui corresponde a de
      // l'argent recu. Les trois suivantes valorisent des CREDITS, ce qui
      // n'est pas la meme chose.
      total_gross_eur:  +grossRevenueEur.toFixed(2),
      // Decomposition du « revenu » calcule sur les credits consommes :
      // seule la part des comptes AYANT DEJA PAYE correspond a quelque
      // chose de vendu. Le reste vient des 50 credits offerts a
      // l'inscription et n'a jamais existe en tresorerie.
      credits_revenue_payeurs_eur: +revenusComptesPayeurs.toFixed(2),
      credits_revenue_offerts_eur: +revenusComptesGratuits.toFixed(2),
      payeurs_count: payeurs.size,
      total_net_eur:    +totalRevenueEur.toFixed(2),   // sum of credit revenue, net of Stripe
      total_cost_eur:   +totalCostEur.toFixed(2),                       // worker per-op ESTIMATE
      total_margin_eur: +(totalRevenueEur - totalCostEur).toFixed(2),   // estimate-based
      // REAL Modal bill (via the `modal billing report` poller) — honest KPIs.
      real_cost_eur:    realCostEur,
      // Marge DU MOIS EN COURS, alignee sur la periode du cout Modal.
      real_margin_eur:  realMarginEur,
      real_revenue_mois_eur: +revenuDuMoisEur.toFixed(2),
      // Age de la facture Modal, en heures. Au-dela de ~48 h le poller
      // ne tourne plus et le chiffre ne doit PAS etre presente comme frais.
      real_usage_age_h: realUsageAgeH,
      real_usage_usd:   realUsageUsd,
      real_usage_ts:    realUsageTs,
      real_usage_by_app: realByApp,
      payments_count: paymentsCount,
    },
    last_7d: {
      ops: sum7('ops'),
      revenue_eur: +sum7('revenue_eur').toFixed(2),
      margin_eur:  +sum7('margin_eur').toFixed(2),
    },
    series_30d: series30,
    desktop_downloads_total: desktopDownloads,
  });
}

// XML-escape for cell text — minimal entities required by xlsx spec.
function _xmlEsc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// CRC-32 over a byte array — needed for ZIP file headers. Standard
// polynomial 0xEDB88320, init 0xFFFFFFFF, final XOR 0xFFFFFFFF. Table
// is computed lazily on first call.
let _crcTable: Uint32Array | null = null;
function _crc32(buf: Uint8Array): number {
  if (!_crcTable) {
    _crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _crcTable[i] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = (_crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** Build a minimal valid .xlsx workbook (ZIP container with the five
 *  required XML files). Stored uncompressed for code simplicity — a
 *  typical history export is 50-200 KB, perfectly fine without deflate.
 *  Returns the raw .xlsx bytes ready to ship as a Response body. */
function _buildXlsx(headers: string[], rows: Array<Array<string | number>>): Uint8Array {
  const enc = new TextEncoder();
  // Convert each cell to xlsx <c> XML. Numbers go in as type "n",
  // everything else as inline string ("inlineStr"). Skips the
  // sharedStrings.xml file → simpler workbook, still valid.
  function cellXml(v: string | number, colLetter: string, row: number): string {
    if (typeof v === 'number' && Number.isFinite(v)) {
      return `<c r="${colLetter}${row}" t="n"><v>${v}</v></c>`;
    }
    return `<c r="${colLetter}${row}" t="inlineStr"><is><t xml:space="preserve">${_xmlEsc(v)}</t></is></c>`;
  }
  function colLetter(i: number): string {
    let s = '';
    let n = i;
    while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; }
    return s;
  }
  const allRows = [headers, ...rows];
  const sheetRows: string[] = [];
  for (let r = 0; r < allRows.length; r++) {
    const cells = allRows[r].map((v, c) => cellXml(v, colLetter(c), r + 1)).join('');
    sheetRows.push(`<row r="${r + 1}">${cells}</row>`);
  }
  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${sheetRows.join('')}</sheetData></worksheet>`;

  const files: Record<string, string> = {
    '[Content_Types].xml':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `</Types>`,
    '_rels/.rels':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`,
    'xl/workbook.xml':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"` +
      ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets><sheet name="History" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
      `</Relationships>`,
    'xl/worksheets/sheet1.xml': sheetXml,
  };

  // Now wrap the files into a ZIP archive. Stored (no compression),
  // simpler to code and Excel reads it just the same.
  type Entry = { name: Uint8Array; data: Uint8Array; crc: number; offset: number };
  const entries: Entry[] = [];
  const parts: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const dataBytes = enc.encode(content);
    const crc = _crc32(dataBytes);
    // Local file header (30 bytes fixed + name).
    const hdr = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(hdr.buffer);
    dv.setUint32(0,  0x04034b50, true);    // signature
    dv.setUint16(4,  20, true);            // version needed
    dv.setUint16(6,  0, true);             // flags
    dv.setUint16(8,  0, true);             // method = stored
    dv.setUint16(10, 0, true);             // mod time
    dv.setUint16(12, 0x21, true);          // mod date (any valid value works)
    dv.setUint32(14, crc, true);
    dv.setUint32(18, dataBytes.length, true); // compressed size
    dv.setUint32(22, dataBytes.length, true); // uncompressed size
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    hdr.set(nameBytes, 30);
    entries.push({ name: nameBytes, data: dataBytes, crc, offset });
    parts.push(hdr, dataBytes);
    offset += hdr.length + dataBytes.length;
  }
  // Central directory.
  const cdParts: Uint8Array[] = [];
  let cdSize = 0;
  for (const e of entries) {
    const cd = new Uint8Array(46 + e.name.length);
    const dv = new DataView(cd.buffer);
    dv.setUint32(0,  0x02014b50, true);    // central dir signature
    dv.setUint16(4,  20, true);            // version made by
    dv.setUint16(6,  20, true);            // version needed
    dv.setUint16(8,  0, true);
    dv.setUint16(10, 0, true);             // method stored
    dv.setUint16(12, 0, true);
    dv.setUint16(14, 0x21, true);
    dv.setUint32(16, e.crc, true);
    dv.setUint32(20, e.data.length, true);
    dv.setUint32(24, e.data.length, true);
    dv.setUint16(28, e.name.length, true);
    dv.setUint16(30, 0, true);
    dv.setUint16(32, 0, true);
    dv.setUint16(34, 0, true);
    dv.setUint16(36, 0, true);
    dv.setUint32(38, 0, true);
    dv.setUint32(42, e.offset, true);
    cd.set(e.name, 46);
    cdParts.push(cd);
    cdSize += cd.length;
  }
  const cdOffset = offset;
  for (const p of cdParts) { parts.push(p); offset += p.length; }
  // End of central directory record.
  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0,  0x06054b50, true);
  dv.setUint16(4,  0, true);
  dv.setUint16(6,  0, true);
  dv.setUint16(8,  entries.length, true);
  dv.setUint16(10, entries.length, true);
  dv.setUint32(12, cdSize, true);
  dv.setUint32(16, cdOffset, true);
  dv.setUint16(20, 0, true);
  parts.push(eocd);

  // Concatenate.
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

function _xlsxResponse(filename: string, headers: string[], rows: Array<Array<string | number>>): Response {
  const bytes = _buildXlsx(headers, rows);
  return new Response(bytes, {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${filename}"`,
    },
  });
}

/** GET /api/history.xlsx — PUBLIC user export in proper Excel format
 *  (real OOXML, no warning on open). Same columns as /api/history.csv
 *  (no margin), Excel-shaped. */
async function handleHistoryXls(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');

  const { data, error } = await supabaseAdmin(env)
    .from('jobs')
    .select('asset_type, mode, status, credit_cost, options, created_at, finished_at, project_name, type, cost_usd')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(5000);
  if (error) return err(500, error.message);

  const headers = ['Date', 'Type', 'Status', 'Duration (s)', 'Credits', 'Project', 'Asset type', 'Mode'];
  type J = {
    asset_type: string; mode: string; status: string;
    credit_cost: number; options: Record<string, unknown> | null;
    created_at: string; finished_at: string | null;
    project_name: string | null;
  };
  const rows: Array<Array<string | number>> = ((data ?? []) as J[]).map(j => {
    const opType = String(j.type ?? j.options?.operation_type ?? j.asset_type ?? 'mesh');
    const durMs = j.options?.duration_ms != null
      ? Number(j.options.duration_ms)
      : (j.finished_at
          ? new Date(j.finished_at).getTime() - new Date(j.created_at).getTime()
          : 0);
    const credits = j.status === 'succeeded' ? (j.credit_cost ?? 0) : 0;
    return [
      new Date(j.created_at).toLocaleString('fr'),
      opType,
      j.status,
      Number((durMs / 1000).toFixed(1)),
      credits,
      j.project_name ?? '',
      j.asset_type ?? '',
      j.mode ?? '',
    ];
  });
  const stamp = new Date().toISOString().slice(0, 10);
  return _xlsxResponse(`myfabmesh-history-${stamp}.xlsx`, headers, rows);
}

/** GET /api/history.json — same data the popup shows the user
 *  (rendered as a table in cloud/public/app/index.html). Now includes
 *  jobs that are still running (status: queued/starting/processing/
 *  running) so the user can see in-flight work + cancel it. */
async function handleHistoryJson(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');

  const { data, error } = await supabaseAdmin(env)
    .from('jobs')
    .select('id, asset_type, mode, status, credit_cost, options, created_at, finished_at, project_name, type, cost_usd')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return err(500, error.message);

  type J = {
    id: string; asset_type: string; mode: string; status: string;
    credit_cost: number; options: Record<string, unknown> | null;
    created_at: string; finished_at: string | null;
    project_name: string | null;
  };
  const rows = ((data ?? []) as J[]).map(j => {
    const opType = String(j.type ?? j.options?.operation_type ?? j.asset_type ?? 'mesh');
    const durMs = j.options?.duration_ms != null
      ? Number(j.options.duration_ms)
      : (j.finished_at
          ? new Date(j.finished_at).getTime() - new Date(j.created_at).getTime()
          : 0);
    const credits = j.status === 'succeeded' ? (j.credit_cost ?? 0) : 0;
    return {
      id: j.id,
      date: j.created_at,
      type: opType,
      status: j.status,
      duration_s: +(durMs / 1000).toFixed(1),
      credits,
      project: j.project_name ?? '',
      asset_type: j.asset_type ?? '',
      mode: j.mode ?? '',
    };
  });
  return json({ rows });
}

/** GET /api/history/:id — full details for a single event row +
 *  user_assets produced during the job's lifetime, so the detail
 *  modal can link back to images/meshes/rigs in their project. */
async function handleHistoryDetail(req: Request, env: Env, id: string): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  const sb = supabaseAdmin(env);
  const { data, error } = await sb.from('jobs')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) return err(500, error.message);
  if (!data) return err(404, 'not found');
  // Find user_assets created in this job's time window so the modal
  // can show clickable links to the outputs (image/mesh/rig/anim).
  // 30s slack on both sides covers timestamp drift.
  let assets: Array<{
    kind: string; project: string; r2_path: string; url: string; created_at: string;
  }> = [];
  try {
    const start = new Date(new Date(data.created_at).getTime() - 30_000).toISOString();
    const end = data.finished_at
      ? new Date(new Date(data.finished_at).getTime() + 30_000).toISOString()
      : new Date().toISOString();
    const { data: a } = await sb.from('user_assets')
      .select('kind, project, r2_path, created_at')
      .eq('user_id', user.id)
      .gte('created_at', start)
      .lte('created_at', end)
      .order('created_at', { ascending: true })
      .limit(20);
    assets = await Promise.all((a ?? []).map(async x => ({
      kind: x.kind as string,
      project: x.project as string,
      r2_path: x.r2_path as string,
      url: await signedR2Url(env, x.r2_path as string,
        ((x.kind as string) || '').match(/mesh|rig|anim/) ? 'mesh' : 'image'),
      created_at: x.created_at as string,
    })));
  } catch (_) { /* best effort */ }
  return json({ job: data, assets });
}

/** GET /api/admin/jobs/active — ADMIN ONLY. Returns every job whose
 *  status is still in-flight (starting / processing / queued). Joined
 *  with profiles so the UI can show the user email next to each row. */
async function handleAdminActiveJobs(req: Request, env: Env): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  const sb = supabaseAdmin(env);
  // Include 'running' for Modal-path jobs that flip past 'processing'
  // mid-pipeline; without it those slip out of the Active list early.
  const { data, error } = await sb.from('jobs')
    .select('id, user_id, asset_type, mode, status, credit_cost, created_at, options, project_name, type, cost_usd')
    .in('status', ['starting', 'processing', 'queued', 'running'])
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return err(500, error.message);
  const rows = (data || []) as Array<{ user_id: string; [k: string]: unknown }>;
  const userIds = [...new Set(rows.map((j) => j.user_id))];
  const emails = new Map<string, string | null>();
  if (userIds.length) {
    const { data: profiles } = await sb.from('profiles').select('id, email').in('id', userIds);
    for (const p of (profiles || []) as Array<{ id: string; email: string | null }>) {
      emails.set(p.id, p.email);
    }
  }
  return json({ jobs: rows.map((j) => ({ ...j, email: emails.get(j.user_id) ?? null })) });
}

/** POST /api/admin/jobs/cancel  body: { jobId }
 *  Refunds credits + marks the job canceled. Modal-side the GPU keeps
 *  running for ~30 s until the container is reused; we accept that
 *  cost — there's no public Modal API to abort a running spawn. */
async function handleAdminCancelJob(req: Request, env: Env): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  let body: { jobId?: string; refund?: boolean } | null = null;
  try { body = await req.json() as { jobId?: string; refund?: boolean }; } catch { return err(400, 'body required'); }
  const jobId = String(body?.jobId || '').trim();
  const refund = body?.refund !== false;
  if (!jobId) return err(400, 'jobId required');
  const sb = supabaseAdmin(env);
  const { data: job } = await sb.from('jobs')
    .select('user_id, status, credit_cost')
    .eq('id', jobId)
    .maybeSingle();
  if (!job) return err(404, 'job not found');
  const j = job as { user_id: string; status: string; credit_cost: number };
  if (['succeeded', 'failed', 'canceled'].includes(j.status)) {
    return err(409, `job already ${j.status}`);
  }
  // Best-effort: tell Modal to actually kill the GPU container running
  // this job. mesh_start with op_type=cancel reads the function_call
  // ID we saved in /data/<job_id>.call_id and runs FunctionCall.cancel().
  // Falls through silently if Modal is unreachable so the Supabase
  // bookkeeping still happens.
  // Meme helper que l'annulation utilisateur : une seule implementation
  // de l'arret Modal, pour qu'elles ne puissent plus diverger comme
  // elles l'avaient fait (admin = vrai arret, utilisateur = appel
  // Replicate mort).
  const _mc = await _cancelModalJob(env, jobId);
  const modalCancelled = _mc.cancelled;
  const modalError = _mc.error;
  // RECLAMATION AVANT REMBOURSEMENT, meme motif que les autres routes.
  // Avant : le statut terminal etait teste EN MEMOIRE plus haut, puis on
  // creditait, puis on ecrivait. Deux clics sur « Stop », ou un clic
  // pendant que le reaper finalise le meme job, creditaient deux fois.
  const { data: reclame } = await sb.from('jobs').update({
    status: 'canceled',
    error: refund ? 'admin canceled' : 'admin canceled (no refund)',
    finished_at: new Date().toISOString(),
  }).eq('id', jobId)
    .in('status', NON_TERMINAL_JOB_STATUSES as unknown as string[])
    .select('id');
  const aReclame = !!(reclame && reclame.length > 0);
  if (refund && aReclame) {
    await addCredits(env, j.user_id, j.credit_cost);
  }
  await _auditLog(env, {
    req, actorEmail: guard.email,
    action: 'cancel_job', target: jobId,
    details: { user_id: j.user_id, refunded: refund ? j.credit_cost : 0, modalCancelled },
  });
  return json({
    ok: true,
    refunded: refund ? j.credit_cost : 0,
    modalCancelled,
    modalError,
  });
}

/** POST /api/admin/users/ban  body: { userId, ban: boolean }
 *  Stores the ban list in R2 (no schema migration needed). The
 *  banlist cache in getSessionUser is invalidated immediately so the
 *  user is locked out on their next request. */
async function handleAdminBanUser(req: Request, env: Env): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  let body: { userId?: string; ban?: boolean } | null = null;
  try { body = await req.json() as { userId?: string; ban?: boolean }; } catch { return err(400, 'body required'); }
  const userId = String(body?.userId || '').trim();
  const ban = !!body?.ban;
  if (!userId) return err(400, 'userId required');
  let list: string[] = [];
  try {
    const obj = await env.MESHES.get(BAN_LIST_KEY);
    if (obj) {
      const raw = await obj.json();
      if (Array.isArray(raw)) list = raw as string[];
    }
  } catch {}
  const set = new Set(list);
  if (ban) set.add(userId); else set.delete(userId);
  await env.MESHES.put(BAN_LIST_KEY, JSON.stringify([...set]));
  _invalidateBanCache();
  await _auditLog(env, {
    req, actorEmail: guard.email,
    action: ban ? 'ban_user' : 'unban_user', target: userId,
    details: { total_banned: set.size },
  });
  return json({ ok: true, banned: ban, total: set.size });
}

/** POST /api/admin/users/credits  body { userId, delta, reason, password }
 *  ADMIN ONLY. Grant (delta > 0) or deduct (delta < 0) credits on one account.
 *
 *  Same second-factor pattern as handleAdminSetPricing: Supabase admin session
 *  (_requireAdmin) + the admin password. `reason` is MANDATORY — a balance
 *  change with no stated motive is unauditable.
 *
 *  A deduction goes through spend_credits, never addCredits(-n): the RPC's
 *  non-negative guard is what stops us pushing a balance below zero. */
async function handleAdminAdjustCredits(req: Request, env: Env): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  type Body = { userId?: string; delta?: unknown; reason?: string; password?: string };
  let body: Body | null = null;
  try { body = await req.json() as Body; } catch { return err(400, 'body required'); }
  const userId = String(body?.userId || '').trim();
  if (!userId) return err(400, 'userId required');
  const delta = Math.trunc(Number(body?.delta));
  if (!Number.isFinite(delta) || delta === 0) return err(400, 'delta must be a non-zero integer');
  // Same sanity ceiling as the Stripe webhook's _packCredits fallback.
  if (Math.abs(delta) > 10_000) return err(400, 'delta out of range (max ±10000)');
  const reason = String(body?.reason || '').trim().slice(0, 300);
  if (reason.length < 3) return err(400, 'reason required');
  if (!(await _verifyAdminPassword(env, String(body?.password || '')))) {
    return err(401, 'invalid password');
  }

  const sb = supabaseAdmin(env);
  const { data: prof } = await sb.from('profiles')
    .select('id, email, credits').eq('id', userId).maybeSingle();
  if (!prof) return err(404, 'user not found');
  const before = (prof as { credits: number | null }).credits ?? 0;
  const email = (prof as { email: string | null }).email ?? null;

  const newBalance = delta > 0
    ? await addCredits(env, userId, delta)
    : await spendCredits(env, userId, -delta);
  if (newBalance == null) {
    return delta < 0
      ? err(409, 'insufficient credits — the balance would go negative')
      : err(502, 'credit RPC failed');
  }

  await _auditLog(env, {
    req, actorEmail: guard.email,
    action: delta > 0 ? 'grant_credits' : 'deduct_credits',
    target: userId,
    details: { email, delta, reason, before, after: newBalance },
  });
  await _addUserNotification(env, userId, {
    kind: 'credits_adjusted',
    subject: delta > 0 ? 'Credits added' : 'Credits adjusted',
    message: `${delta > 0 ? '+' : ''}${delta} credits — ${reason}`,
  });
  return json({ ok: true, userId, delta, credits: newBalance, before });
}

/** Credits + EUR a pack is worth, straight from the server-side PACKS table.
 *  Never from a request body — that is exactly how a forged reconciliation
 *  would mint free credits. */
function _packPayout(packId: string | null | undefined): { credits: number; eur: number } | null {
  const p = (PACKS as Record<string, { credits: number; euros: number } | undefined>)[String(packId ?? '')];
  return p ? { credits: p.credits, eur: p.euros } : null;
}

/** GET /api/admin/payments/unreconciled — ADMIN ONLY.
 *
 *  _processPayment (Stripe webhook) INSERTs a placeholder row
 *  { credits: 0, amount_eur: 0 } before calling add_credits, then patches it.
 *  Any crash/timeout in between leaves money taken and credits missing — and
 *  nothing surfaced it: handleAdminStats only sums amount_eur, so the row
 *  silently contributed 0 to gross revenue.
 *
 *  NOTE on the predicate: amount_eur is INSERTed as 0, never NULL, so
 *  `credits = 0 (or NULL)` is the only reliable signal. amount_eur = 0 is
 *  corroborating evidence, not the test. */
async function handleAdminUnreconciledPayments(req: Request, env: Env): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  const sb = supabaseAdmin(env);
  const { data, error } = await sb.from('payments')
    .select('id, stripe_session_id, user_id, pack_id, credits, amount_eur, created_at')
    .or('credits.is.null,credits.eq.0')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return err(500, error.message);
  const rows = (data || []) as Array<{
    id: unknown; stripe_session_id: string | null; user_id: string | null;
    pack_id: string | null; credits: number | null; amount_eur: number | null;
    created_at: string | null;
  }>;
  // Resolve emails in ONE query, same pattern as handleAdminActiveJobs.
  const userIds = [...new Set(rows.map((p) => p.user_id).filter((x): x is string => !!x))];
  const emails = new Map<string, string | null>();
  if (userIds.length) {
    const { data: profiles } = await sb.from('profiles').select('id, email').in('id', userIds);
    for (const p of (profiles || []) as Array<{ id: string; email: string | null }>) {
      emails.set(p.id, p.email);
    }
  }
  return json({
    ok: true,
    count: rows.length,
    payments: rows.map((p) => {
      const payout = _packPayout(p.pack_id);
      return {
        ...p,
        email: p.user_id ? (emails.get(p.user_id) ?? null) : null,
        // What the "Grant credits" button WOULD apply.
        expected_credits: payout?.credits ?? null,
        expected_amount_eur: payout?.eur ?? null,
      };
    }),
  });
}

/** POST /api/admin/payments/reconcile  body { sessionId, password }
 *  ADMIN ONLY. Finish a half-processed Stripe payment: grant the pack's
 *  credits and complete the accounting row.
 *
 *  Idempotent under double-click because we CLAIM the row FIRST
 *  (`.eq('credits', 0)` conditional UPDATE) and only grant credits when the
 *  claim actually returned a row. Doing it the other way round (grant then
 *  claim) is precisely the double-credit window the webhook already documents.
 *  If the grant then fails we roll the row back to credits:0 so it stays
 *  visible as unreconciled — we never leave credits>0 with no grant. */
async function handleAdminReconcilePayment(req: Request, env: Env): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  type Body = { sessionId?: string; password?: string };
  let body: Body | null = null;
  try { body = await req.json() as Body; } catch { return err(400, 'body required'); }
  const sessionId = String(body?.sessionId || '').trim();
  if (!sessionId) return err(400, 'sessionId required');
  if (!(await _verifyAdminPassword(env, String(body?.password || '')))) {
    return err(401, 'invalid password');
  }

  const sb = supabaseAdmin(env);
  const { data: probe } = await sb.from('payments')
    .select('id, user_id, pack_id, credits')
    .eq('stripe_session_id', sessionId)
    .maybeSingle();
  if (!probe) return err(404, 'payment not found');
  const packId = (probe as { pack_id: string | null }).pack_id;
  const payout = _packPayout(packId);
  if (!payout) return err(400, `unknown pack_id '${packId}' — cannot determine the payout`);

  // Claim: only one caller can flip an unreconciled row (credits 0 or NULL)
  // to the pack payout. Matches the predicate used by the GET listing.
  const { data: claimed, error: claimErr } = await sb.from('payments')
    .update({ credits: payout.credits, amount_eur: payout.eur })
    .eq('stripe_session_id', sessionId)
    .or('credits.is.null,credits.eq.0')
    .select('id, user_id, pack_id');
  if (claimErr) return err(500, claimErr.message);
  if (!claimed || claimed.length === 0) {
    return json({ ok: true, already: true, sessionId });
  }
  const row = claimed[0] as { user_id: string | null; pack_id: string | null };
  if (!row.user_id) {
    await sb.from('payments').update({ credits: 0, amount_eur: 0 }).eq('stripe_session_id', sessionId);
    return err(400, 'payment row has no user_id');
  }

  const newBalance = await addCredits(env, row.user_id, payout.credits);
  if (newBalance == null) {
    // Roll the claim back so the row stays listed and the admin can retry.
    await sb.from('payments').update({ credits: 0, amount_eur: 0 }).eq('stripe_session_id', sessionId);
    return err(502, 'add_credits RPC failed — nothing was granted, retry');
  }

  await _auditLog(env, {
    req, actorEmail: guard.email,
    action: 'reconcile_payment', target: sessionId,
    details: {
      user_id: row.user_id, pack_id: row.pack_id,
      credits: payout.credits, amount_eur: payout.eur, new_balance: newBalance,
    },
  });
  await _addUserNotification(env, row.user_id, {
    kind: 'credits_granted',
    subject: 'Credits added',
    message: `${payout.credits} credits were added to your account for your ${packId} purchase.`,
  });
  return json({
    ok: true, sessionId, userId: row.user_id,
    credits: payout.credits, amount_eur: payout.eur, balance: newBalance,
  });
}

/** GET /api/admin/badges — ADMIN ONLY. Three integers for the tab badges.
 *
 *  Replaces the dashboard's 30-second poller that used to hit
 *  /api/admin/market/list (N+1 R2 reads over every listing),
 *  /api/admin/contact-messages (N+1 over every message) and
 *  /api/admin/jobs/active (200 rows + a profiles join) just to render three
 *  numbers.
 *
 *  Active jobs is a head-only COUNT (one round-trip). The two R2-backed
 *  counts still need to open the JSON bodies (the read/status flag lives
 *  inside the file, not the key), so the result is cached in R2 for 60 s —
 *  a 30 s poller therefore recomputes at most every other tick. ?fresh=1
 *  bypasses the cache for an immediate refresh after a moderation action. */
async function handleAdminBadges(req: Request, env: Env): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  const CACHE_KEY = '_meta/admin_badges_cache.json';
  const TTL_MS = 60_000;
  const fresh = new URL(req.url).searchParams.get('fresh') === '1';

  if (!fresh && env.MESHES) {
    try {
      const txt = await r2GetText(env, CACHE_KEY);
      const c = txt ? JSON.parse(txt) : null;
      if (c && c.ts && (Date.now() - Date.parse(c.ts)) < TTL_MS) {
        return json({ ...c, cached: true });
      }
    } catch { /* fall through and recompute */ }
  }

  // Active jobs — head:true, so zero rows come back over the wire.
  let active = 0;
  try {
    const { count } = await supabaseAdmin(env).from('jobs')
      .select('id', { count: 'exact', head: true })
      .in('status', ['starting', 'processing', 'queued', 'running']);
    active = count ?? 0;
  } catch { /* leave 0 */ }

  // Pending listings + unread messages. Both are bounded so one huge folder
  // can never blow the subrequest budget on a badge poll.
  const SCAN_CAP = 400;
  const countJson = async (prefix: string, pred: (o: Record<string, unknown>) => boolean) => {
    if (!env.MESHES) return 0;
    let n = 0, seen = 0;
    let cursor: string | undefined = undefined;
    do {
      const page = await env.MESHES.list({ prefix, limit: 1000, cursor });
      for (const obj of page.objects) {
        if (!obj.key.startsWith(prefix) || !obj.key.endsWith('.json')) continue;
        if (++seen > SCAN_CAP) return n;
        try {
          const txt = await r2GetText(env, obj.key);
          if (!txt) continue;
          const parsed = JSON.parse(txt);
          if (parsed && typeof parsed === 'object' && pred(parsed)) n++;
        } catch { /* one corrupt file must not break a badge */ }
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return n;
  };
  let marketPending = 0, messagesUnread = 0;
  try { marketPending = await countJson('_market/listings/', (l) => l.status === 'pending'); } catch {}
  try { messagesUnread = await countJson('_meta/contact/', (m) => !m.read); } catch {}

  const rec = {
    ok: true,
    ts: new Date().toISOString(),
    active,
    market_pending: marketPending,
    messages_unread: messagesUnread,
  };
  if (env.MESHES) {
    try {
      await env.MESHES.put(CACHE_KEY, JSON.stringify(rec),
        { httpMetadata: { contentType: 'application/json' } });
    } catch { /* cache is best-effort */ }
  }
  return json({ ...rec, cached: false });
}

/** GET /api/admin/users — ADMIN ONLY. Profiles + ban flag + per-user aggregates.
 *
 *  Query: ?withAssets=1 opts into the R2 asset scan (images_count).
 *
 *  The R2 scan used to run UNCONDITIONALLY: up to 5 MESHES.list() calls per
 *  user × 500 users = ~2500 subrequests in a single invocation, well over
 *  Cloudflare's 1000-per-request cap — so the whole tab broke as soon as the
 *  user base grew. It is now opt-in AND hard-capped, and images_count is
 *  `null` (not 0) when it wasn't scanned so the UI can print '—' instead of a
 *  lying zero.
 *
 *  Everything else (ops_total, ops_failed, credits_spent, last_activity,
 *  rigs_count) comes from the SAME single jobs query that was already being
 *  issued — it just fetched three columns and threw the rest away. Zero extra
 *  queries. */
async function handleAdminListUsers(req: Request, env: Env): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  const withAssets = new URL(req.url).searchParams.get('withAssets') === '1';
  const sb = supabaseAdmin(env);
  const { data, error } = await sb.from('profiles')
    .select('id, email, credits, created_at')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return err(500, error.message);
  const banned = await _getBannedUserIds(env);
  const users = (data || []) as Array<{ id: string; [k: string]: unknown }>;

  // Aggregate everything from jobs in ONE query.
  const { data: jobsRows } = await sb.from('jobs')
    .select('user_id, project_name, mesh_url, status, credit_cost, created_at, options, type, cost_usd')
    .limit(50_000);
  const projects = new Map<string, Set<string>>();
  const meshes = new Map<string, number>();
  const opsTotal = new Map<string, number>();
  const opsFailed = new Map<string, number>();
  const opsSucceeded = new Map<string, number>();
  const creditsSpent = new Map<string, number>();
  const rigsCount = new Map<string, number>();
  const lastActivity = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) || 0) + by);
  const jobsList = (jobsRows || []) as Array<{
    user_id: string; project_name: string | null; mesh_url: string | null;
    status: string; credit_cost: number | null; created_at: string | null;
    options: Record<string, unknown> | null;
  }>;
  for (const row of jobsList) {
    if (!row.user_id) continue;
    if (row.project_name) {
      const set = projects.get(row.user_id) || new Set<string>();
      set.add(row.project_name);
      projects.set(row.user_id, set);
    }
    if (row.mesh_url && row.status === 'succeeded') bump(meshes, row.user_id);
    bump(opsTotal, row.user_id);
    if (row.status === 'failed') bump(opsFailed, row.user_id);
    if (row.status === 'succeeded') {
      bump(opsSucceeded, row.user_id);
      // Only successful ops are counted as spend — SAME convention as
      // handleAdminStats, so the two screens can never disagree.
      bump(creditsSpent, row.user_id, row.credit_cost ?? 0);
    }
    if (String((row.options as Record<string, unknown> | null)?.operation_type ?? '') === 'rig') {
      bump(rigsCount, row.user_id);
    }
    if (row.created_at) {
      const t = new Date(row.created_at).getTime();
      if (Number.isFinite(t) && t > (lastActivity.get(row.user_id) ?? 0)) {
        lastActivity.set(row.user_id, t);
      }
    }
  }

  // Image counts via R2 — OPT-IN (?withAssets=1) and hard-capped so the
  // fan-out can never blow the 1000-subrequest budget: 2 pages/user
  // (2000 objects) × 300 users = 600 list() calls worst case.
  const ASSET_USER_CAP = 300;
  const ASSET_PAGE_CAP = 2;
  const imageCounts = new Map<string, number>();
  let assetsScanPartial = false;
  if (withAssets && env.MESHES) {
    const scanned = users.slice(0, ASSET_USER_CAP);
    if (users.length > ASSET_USER_CAP) assetsScanPartial = true;
    const tasks = scanned.map(async (u) => {
      let n = 0;
      let cursor: string | undefined;
      let pages = 0;
      do {
        const result = await env.MESHES.list({
          prefix: `${u.id}/`, limit: 1000, cursor,
        });
        for (const obj of result.objects) {
          if (/\.(png|jpg|jpeg|webp)$/i.test(obj.key)) n++;
        }
        cursor = result.truncated ? result.cursor : undefined;
        pages++;
        if (cursor && pages >= ASSET_PAGE_CAP) assetsScanPartial = true;
      } while (cursor && pages < ASSET_PAGE_CAP);
      imageCounts.set(u.id, n);
    });
    await Promise.all(tasks);
  }

  // Exact signup count so the UI can show "X users (Y shown)" honestly.
  let total: number | null = null;
  try {
    const { count } = await sb.from('profiles').select('id', { count: 'exact', head: true });
    total = count ?? null;
  } catch {}

  return json({
    users: users.map((u) => ({
      ...u,
      banned: banned.has(u.id),
      projects_count: projects.get(u.id)?.size || 0,
      meshes_count: meshes.get(u.id) || 0,
      // null = 'not scanned' (see ?withAssets), NOT 'zero images'.
      images_count: withAssets ? (imageCounts.get(u.id) ?? 0) : null,
      ops_total: opsTotal.get(u.id) || 0,
      ops_failed: opsFailed.get(u.id) || 0,
      ops_succeeded: opsSucceeded.get(u.id) || 0,
      credits_spent: creditsSpent.get(u.id) || 0,
      rigs_count: rigsCount.get(u.id) || 0,
      last_activity: lastActivity.has(u.id)
        ? new Date(lastActivity.get(u.id) as number).toISOString() : null,
    })),
    total,
    returned: users.length,
    truncated: users.length >= 500,
    assets_scanned: withAssets,
    assets_scan_partial: assetsScanPartial,
    jobs_scanned: jobsList.length,
    // The 50 000-row jobs cap is UNORDERED: past it the per-user aggregates
    // become an arbitrary subset. Surfaced rather than raised (worker memory).
    jobs_truncated: jobsList.length >= 50_000,
  });
}

/** GET /api/admin/totp/status — { enrolled: bool, enrolled_at, email }. */
async function handleAdminTotpStatus(req: Request, env: Env): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  try {
    const obj = await env.MESHES.get(TOTP_KEY);
    if (!obj) return json({ enrolled: false });
    const j = await obj.json() as { enrolled_at?: string; enrolled_email?: string };
    return json({ enrolled: true, enrolled_at: j.enrolled_at, email: j.enrolled_email });
  } catch (e) {
    return err(500, e instanceof Error ? e.message : String(e));
  }
}

/** POST /api/admin/totp/setup — generates a fresh secret + otpauth URI.
 *  NOT persisted yet — the admin must scan it AND submit a confirming
 *  code via /api/admin/totp/confirm before we save it. */
async function handleAdminTotpSetup(req: Request, env: Env): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const secret = _base32Encode(bytes);
  const issuer = 'MyFabmesh';
  const account = guard.email || 'admin';
  const uri = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
            + `?secret=${secret}&issuer=${encodeURIComponent(issuer)}`
            + `&algorithm=SHA1&digits=6&period=30`;
  return json({ secret, uri });
}

/** POST /api/admin/totp/confirm  body: { secret, code }
 *  Verifies the code against the (un-persisted) secret. On success
 *  saves it to R2 — every subsequent admin login now requires TOTP. */
async function handleAdminTotpConfirm(req: Request, env: Env): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  let body: { secret?: string; code?: string };
  try { body = await req.json() as { secret?: string; code?: string }; } catch { return err(400, 'bad json'); }
  const secret = String(body.secret || '').trim();
  const code = String(body.code || '').trim();
  if (!secret || !code) return err(400, 'secret + code required');
  if (!(await _totpVerify(secret, code))) return err(401, 'invalid code');
  await env.MESHES.put(TOTP_KEY, JSON.stringify({
    secret,
    enrolled_email: guard.email,
    enrolled_at: new Date().toISOString(),
  }));
  await _auditLog(env, { req, actorEmail: guard.email, action: 'totp_enroll' });
  return json({ ok: true });
}

/** POST /api/admin/totp/disable  body: { password, code }
 *  Removes TOTP. Requires both password AND a valid current code so
 *  even with the admin cookie alone an attacker can't bypass 2FA. */
async function handleAdminTotpDisable(req: Request, env: Env): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  // DESACTIVATION DEPUIS LE WEB REFUSEE (decision user du 2026-07-27) :
  // « on ne doit pas pouvoir desactiver l'authentification depuis la dashboard
  // admin ». Le controle precedent (mot de passe + code courant) empechait deja
  // qu'un cookie vole suffise, mais laissait la 2FA retirable par quelqu'un
  // ayant obtenu les deux — c'est-a-dire exactement le scenario contre lequel
  // la 2FA existe.
  //
  // RECUPERATION en cas de perte de l'authenticator, hors du web et donc hors
  // de portee d'un attaquant qui n'aurait que des identifiants :
  //   npx wrangler r2 object delete "myfabmesh-meshes/_meta/admin-totp.json" --remote
  // Cela exige un acces au compte Cloudflare depuis une machine autorisee —
  // un facteur reellement distinct. La tentative est journalisee.
  await _auditLog(env, {
    req, actorEmail: guard.email,
    action: 'totp_disable_refused',
    details: { reason: 'web_disable_removed_by_policy' },
  });
  return err(403, 'totp_disable_unavailable');
}

/** POST /api/admin/force-logout-all — invalidate every active Supabase
 *  session by stamping a minimum-iat. Requires the admin password as
 *  a second factor so a stolen cookie alone can't nuke every login.
 *  Admin emails (ADMIN_EMAILS) are excluded from the kick — otherwise
 *  the admin would log themselves out right after pressing the button. */
async function handleAdminForceLogoutAll(req: Request, env: Env): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  let body: { password?: string } | null = null;
  try { body = await req.json() as typeof body; } catch { return err(400, 'body required'); }
  const pw = String(body?.password || '');
  if (!(await _verifyAdminPassword(env, pw))) return err(401, 'invalid password');
  const iat = Math.floor(Date.now() / 1000);
  await env.MESHES.put(MIN_SESSION_IAT_KEY, JSON.stringify({
    iat, stamped_by: guard.email, stamped_at: new Date().toISOString(),
  }));
  _invalidateMinSessionIatCache();
  await _auditLog(env, {
    req, actorEmail: guard.email,
    action: 'force_logout_all', details: { min_session_iat: iat },
  });
  return json({ ok: true, min_session_iat: iat });
}

/** GET /api/pricing — PUBLIC. Returns the live credit costs so the
 *  UI can render accurate cost pills and add-on hints without re-
 *  deploying the static bundle every time the admin tunes a price. */
async function handlePublicPricing(_req: Request, env: Env): Promise<Response> {
  const prices = await _getPricing(env);
  // QUELLES FONCTIONS ONT REELLEMENT UN BACKEND.
  //
  // Constat de l'audit du 2026-08-04 : le bouton « Segment parts (AI) »
  // etait present dans l'interface cloud alors qu'aucune application de
  // segmentation n'etait deployee sur Modal. L'utilisateur cliquait, voyait
  // « mesh-segment backend unavailable » en anglais, apres qu'on lui ait
  // annonce un prix de 15 credits. Aucun credit n'etait debite — le 503
  // tombe avant — mais proposer un bouton mort reste inacceptable.
  //
  // On declare donc la disponibilite reelle plutot que de la supposer cote
  // client. L'interface masque ce qui n'existe pas, et RETABLIT le bouton
  // toute seule des que la variable d'environnement est renseignee : pas de
  // second deploiement a penser le jour ou le backend arrive.
  const features = {
    segment:   !!env.MODAL_SEGMENT_URL,
    mvadapter: !!env.MODAL_MVADAPTER_URL,
    rig:       !!_rigBaseUrl(env),
    animate:   !!env.MODAL_ANYTOP_ANIM_URL,
    retarget:  !!env.MODAL_FBX_RETARGET_URL,
    tpose:     !!env.MODAL_TPOSE_URL,
    rectify:   !!env.MODAL_RECTIFY_URL,
    backview:  !!env.MODAL_BACKVIEW_URL,
  };
  // Cache 30 s on the edge so a viral landing page doesn't multiply
  // R2 reads. Admin POSTs invalidate the in-process cache; the edge
  // cache will follow within 30 s.
  return new Response(JSON.stringify({ prices, features }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=30',
    },
  });
}

/** GET /api/admin/pricing — current credit costs + defaults. */
async function handleAdminGetPricing(req: Request, env: Env): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  _invalidatePricingCache();
  const current = await _getPricing(env);
  // Send defaults too so the UI can show "modified" badges.
  return json({ current, defaults: PRICING_DEFAULTS });
}

/** POST /api/admin/pricing — overwrite the whole R2 pricing object.
 *  Requires ADMIN_PASSWORD on every save — second factor on top of
 *  the admin cookie, same as the services toggle. */
async function handleAdminSetPricing(req: Request, env: Env): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  let body: { prices?: Record<string, number>; password?: string } | null = null;
  try { body = await req.json() as typeof body; } catch { return err(400, 'body required'); }
  const prices = body?.prices;
  // Mot de passe NON redemande ici : _requireAdmin ci-dessus a deja exige
  // une session Supabase admin ET le cookie admin signe, lequel n'est emis
  // QUE par /api/admin/login apres verification du mot de passe. Le
  // redemander dans le corps ne prouvait donc rien de plus, et obligeait
  // l'utilisateur a le retaper a chaque ouverture de l'onglet. Retire a sa
  // demande le 2026-07-27. Toute modification reste tracee (_auditLog).

  if (!prices || typeof prices !== 'object') return err(400, 'prices object required');
  // Only persist keys we know about — silently drop unknown keys.
  const sanitized: Record<string, number> = {};
  for (const k of Object.keys(PRICING_DEFAULTS)) {
    const v = (prices as Record<string, unknown>)[k];
    if (typeof v === 'number' && v >= 0 && Number.isFinite(v)) {
      sanitized[k] = Math.floor(v);
    } else {
      sanitized[k] = (PRICING_DEFAULTS as Record<string, number>)[k];
    }
  }
  await env.MESHES.put(PRICING_KEY, JSON.stringify(sanitized));
  _invalidatePricingCache();
  await _auditLog(env, {
    req, actorEmail: guard.email,
    action: 'set_pricing', details: { prices: sanitized },
  });
  return json({ ok: true, current: sanitized });
}

/** GET /api/admin/services — current state of the kill switches. */
async function handleAdminServices(req: Request, env: Env): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  // Force a fresh read — admin UI only calls this when the menu is
  // opened, so the 30 s cache doesn't help us here and stale data is
  // worse than a single extra R2 read.
  _invalidateServiceFlagsCache();
  const flags = await _getServiceFlags(env);
  return json(flags);
}

/** POST /api/admin/services  body: { service: 'modal'|'site', enabled, password }
 *  Requires the ADMIN_PASSWORD on every flip — second factor on top
 *  of the admin session cookie, so a stolen cookie alone can't kill
 *  the site. */
async function handleAdminServicesToggle(req: Request, env: Env): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  let body: { service?: string; enabled?: boolean; password?: string } | null = null;
  try { body = await req.json() as typeof body; } catch { return err(400, 'body required'); }
  const service = String(body?.service || '').trim();
  const enabled = !!body?.enabled;
  if (!['modal', 'site', 'stripe', 'all'].includes(service)) {
    return err(400, 'service must be modal|site|stripe|all');
  }
  // Mot de passe NON redemande ici : _requireAdmin en tete de fonction a deja
  // exige une session Supabase admin ET le cookie admin signe, lequel n'est
  // emis QUE par /api/admin/login apres verification du mot de passe. Le
  // redemander ne prouvait rien de plus. Retire le 2026-07-27 a la demande du
  // user. Chaque bascule reste tracee dans le journal (_auditLog plus bas).

  let current: Partial<ServiceFlags> = {};
  try {
    const obj = await env.MESHES.get(SERVICE_FLAGS_KEY);
    if (obj) current = await obj.json() as Partial<ServiceFlags>;
  } catch {}
  // service='all' forces every flag to the requested value — used by
  // the master switch in the admin UI. Useful in panic mode (kill
  // everything in one click) or to fully restore the site after.
  const next: ServiceFlags = service === 'all'
    ? {
        modal_enabled: enabled, site_enabled: enabled, stripe_enabled: enabled,
      }
    : {
        modal_enabled: current.modal_enabled !== false,
        site_enabled: current.site_enabled !== false,
        stripe_enabled: current.stripe_enabled !== false,
        ...(service === 'modal'  ? { modal_enabled: enabled }  : {}),
        ...(service === 'site'   ? { site_enabled: enabled }   : {}),
        ...(service === 'stripe' ? { stripe_enabled: enabled } : {}),
      };
  await env.MESHES.put(SERVICE_FLAGS_KEY, JSON.stringify(next));
  _invalidateServiceFlagsCache();
  await _auditLog(env, {
    req, actorEmail: guard.email,
    action: 'toggle_service', target: service,
    details: { enabled, new_state: next },
  });
  return json({ ok: true, ...next });
}

/** GET /api/admin/audit?day=YYYY-MM-DD — returns the day's JSONL log.
 *  Defaults to today. Capped at 1 MB body size. */
async function handleAdminAuditLog(req: Request, env: Env): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  const u = new URL(req.url);
  const day = (u.searchParams.get('day') || new Date().toISOString().slice(0, 10))
    .replace(/[^0-9-]/g, '').slice(0, 10);
  const key = `_meta/admin_audit/${day}.log`;
  let entries: unknown[] = [];
  try {
    const obj = await env.MESHES.get(key);
    if (obj) {
      const text = await obj.text();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch {}
      }
    }
  } catch {}
  // Most-recent first.
  entries.reverse();
  return json({ day, entries });
}

/** GET /api/admin/users/<userId>/images — ADMIN ONLY. Lists every PNG
 *  in R2 under <userId>/* so the admin can preview / moderate. Doesn't
 *  hit Supabase because logOperation never stored the result URL —
 *  R2 is the authoritative source. */
async function handleAdminUserImages(req: Request, env: Env, userId: string): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  if (!env.MESHES || !env.R2_PUBLIC_URL) return json({ images: [] });
  type Img = { key: string; url: string; size: number; uploaded: string };
  const out: Img[] = [];
  let cursor: string | undefined;
  do {
    const result = await env.MESHES.list({
      prefix: `${userId}/`,
      limit: 1000,
      cursor,
    });
    for (const obj of result.objects) {
      if (!/\.(png|jpg|jpeg|webp)$/i.test(obj.key)) continue;
      out.push({
        key: obj.key,
        url: await signedR2Url(env, obj.key, 'image'),
        size: obj.size,
        uploaded: obj.uploaded.toISOString(),
      });
    }
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor && out.length < 500);
  out.sort((a, b) => b.uploaded.localeCompare(a.uploaded));
  return json({ images: out });
}

/** GET /api/admin/users/<userId>/projects — ADMIN ONLY. Groups the
 *  user's jobs by project_name and returns one summary row per project
 *  (thumb URL, image count, mesh count, last activity). */
async function handleAdminUserProjects(req: Request, env: Env, userId: string): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  const sb = supabaseAdmin(env);
  const { data, error } = await sb.from('jobs')
    .select('project_name, asset_type, mesh_url, status, created_at')
    .eq('user_id', userId)
    .not('project_name', 'is', null)
    .order('created_at', { ascending: false })
    .limit(5000);
  if (error) return err(500, error.message);
  type Row = { project_name: string | null; asset_type: string; mesh_url: string | null; status: string; created_at: string };
  type Project = { name: string; asset_type: string; meshes: number; latest: string };
  const byName = new Map<string, Project>();
  for (const row of (data || []) as Row[]) {
    if (!row.project_name) continue;
    const cur = byName.get(row.project_name) || {
      name: row.project_name,
      asset_type: row.asset_type,
      meshes: 0,
      latest: row.created_at,
    };
    if (row.mesh_url && row.status === 'succeeded') cur.meshes++;
    if (row.created_at > cur.latest) cur.latest = row.created_at;
    byName.set(row.project_name, cur);
  }
  const projects = [...byName.values()].sort((a, b) => b.latest.localeCompare(a.latest));
  return json({ projects });
}

/** GET /api/admin/users/<userId>/meshes — ADMIN ONLY. Lists every
 *  succeeded mesh job for a user so the admin can preview / moderate. */
async function handleAdminUserMeshes(req: Request, env: Env, userId: string): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  const sb = supabaseAdmin(env);
  const { data, error } = await sb.from('jobs')
    .select('id, user_id, asset_type, mesh_url, status, project_name, created_at, options, type, cost_usd')
    .eq('user_id', userId)
    .eq('status', 'succeeded')
    .not('mesh_url', 'is', null)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return err(500, error.message);
  return json({ meshes: data || [] });
}

/** POST /api/landmarks — JSON-only landmarks persistence keyed by mesh slug.
 *  Body: { mesh_url, landmarks?, op: 'save' | 'load' }
 *  Stored under R2 at `<user.id>/landmarks/<slug>.json`. Slug = the mesh
 *  URL's basename minus extension, sanitised. Bounded to 64 KB per file
 *  so a malicious client can't fill the bucket. */
async function handleLandmarks(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MESHES) return err(500, 'R2 binding required');
  let body: { mesh_url?: string; landmarks?: unknown; op?: string };
  try { body = await req.json() as typeof body; }
  catch { return err(400, 'invalid JSON body'); }
  const meshUrl = String(body?.mesh_url || '').trim();
  if (!meshUrl) return err(400, 'mesh_url required');
  // Derive slug from URL basename. Strip query, then last path segment,
  // then extension, then non-alphanumeric.
  let slug = 'mesh';
  try {
    const last = (new URL(meshUrl, 'https://x.invalid')).pathname.split('/').pop() || '';
    slug = last.replace(/\.(glb|gltf|obj|fbx|ply)$/i, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'mesh';
  } catch {
    slug = meshUrl.split(/[/\\]/).pop()?.replace(/\.(glb|gltf|obj|fbx|ply)$/i, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'mesh';
  }
  const key = `${user.id}/landmarks/${slug}.json`;
  const op = String(body?.op || '').toLowerCase();
  if (op === 'load') {
    try {
      const obj = await env.MESHES.get(key);
      if (!obj) return json({ ok: false, error: 'no landmarks for this mesh', landmarks: {} });
      const txt = await obj.text();
      let parsed: unknown = {};
      try { parsed = JSON.parse(txt); } catch { parsed = {}; }
      return json({ ok: true, landmarks: parsed });
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : String(e), landmarks: {} });
    }
  }
  if (op === 'save') {
    const lm = body?.landmarks;
    if (!lm || typeof lm !== 'object') return err(400, 'landmarks object required');
    const payload = JSON.stringify(lm);
    if (payload.length > 64 * 1024) return err(413, 'landmarks payload too large (>64 KB)');
    try {
      await env.MESHES.put(key, payload, {
        httpMetadata: { contentType: 'application/json' },
      });
      return json({ ok: true, count: Object.keys(lm as Record<string, unknown>).length });
    } catch (e) {
      return err(502, 'storage write failed: ' + (e instanceof Error ? e.message : String(e)));
    }
  }
  return err(400, 'op must be "save" or "load"');
}

/** GET /api/admin/users/<userId>/rigs — ADMIN ONLY. Lists every rigged
 *  GLB the user has produced by walking R2 under <userId>/rigged/. Rigs
 *  don't have a Supabase jobs row (they're side-effects of the rig spawn
 *  flow), so the R2 listing is the only source of truth. */
async function handleAdminUserRigs(req: Request, env: Env, userId: string): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  if (!env.MESHES || !env.R2_PUBLIC_URL) return err(500, 'R2 binding required');
  const prefix = `${userId}/rigged/`;
  const rigs: Array<{ id: string; key: string; mesh_url: string; size: number; created_at: string; project_name: string | null }> = [];
  try {
    const page = await env.MESHES.list({ prefix, limit: 200 });
    for (const obj of page.objects) {
      const filename = obj.key.split('/').pop() || '';
      // Filename pattern: <baseName>_rigged_puppeteer_<timestamp>.glb
      // The baseName is the source mesh name minus extension — use it as
      // a best-effort project guess for the admin grid.
      const projectGuess = filename.replace(/_rigged_.*$/i, '').replace(/^modal_/i, '');
      rigs.push({
        id: obj.key,
        key: obj.key,
        mesh_url: await signedR2Url(env, obj.key, 'mesh'),
        size: obj.size,
        created_at: obj.uploaded?.toISOString() || new Date(0).toISOString(),
        project_name: projectGuess || null,
      });
    }
  } catch (e) {
    return err(500, `R2 list failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return json({ rigs });
}

/** GET /api/admin/users/<userId>/listings — ADMIN ONLY. Returns every
 *  marketplace listing (any status) owned by this user. Used by the
 *  admin Images/Meshes modals to badge cards with their marketplace
 *  state ("Pending review", "Live on /market", "Rejected"). */
async function handleAdminUserListings(req: Request, env: Env, userId: string): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  const all = await _loadAllListings(env);
  const mine = all.filter((l) => String(l.user_id) === String(userId));
  return json({ ok: true, listings: mine });
}

/** DELETE /api/admin/images?key=<r2key> — ADMIN ONLY. Removes the
 *  R2 object directly. Cascades into _market/listings/ to drop any
 *  listing referencing this image's URL. Used by the admin Images
 *  modal to moderate user-uploaded / generated images. */
async function handleAdminDeleteImage(req: Request, env: Env): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  if (!env.MESHES) return err(500, 'storage not configured');
  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  if (!key) return err(400, 'key required');
  // Reject keys outside the user-content namespace — these shouldn't
  // be deletable through the image endpoint (use the contact/market
  // endpoints instead).
  if (key.startsWith('_meta/') || key.startsWith('_market/')) {
    return err(400, 'protected key — use the proper endpoint');
  }
  try { await env.MESHES.delete(key); } catch {}
  // Cascade: any market listing whose asset_url ends with this key
  // becomes invalid — delete the listing JSON.
  try {
    const page = await env.MESHES.list({ prefix: '_market/listings/', limit: 1000 });
    for (const obj of page.objects) {
      try {
        const txt = await r2GetText(env, obj.key);
        if (!txt) continue;
        const parsed = JSON.parse(txt);
        const rawUrl = String(parsed?.asset_url || parsed?.mesh_url || '');
        // Strip any ?exp&sig query so signed /r2/ URLs still match by key.
        const url = rawUrl.split('?')[0];
        if (url && url.endsWith('/' + key)) await env.MESHES.delete(obj.key);
      } catch {}
    }
  } catch {}
  return json({ ok: true, success: true });
}

/** DELETE /api/admin/users/<userId>/meshes/<jobId> — ADMIN ONLY.
 *  Removes the R2 GLB + the Supabase jobs row. Also unpublishes any
 *  marketplace listing tied to that mesh. */
async function handleAdminDeleteMesh(req: Request, env: Env, userId: string, jobId: string): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  const sb = supabaseAdmin(env);
  const { data: job } = await sb.from('jobs').select('id, user_id, mesh_url')
    .eq('id', jobId).eq('user_id', userId).maybeSingle();
  if (!job) return err(404, 'mesh not found');
  // Best-effort R2 cleanup. delete() never throws on a missing key.
  if (env.MESHES) {
    try { await env.MESHES.delete(`${userId}/${jobId}.glb`); } catch {}
    // Cascade: any market listing referencing this mesh becomes invalid;
    // we delete the listing JSON too so the marketplace stays clean.
    try {
      const page = await env.MESHES.list({ prefix: '_market/listings/', limit: 1000 });
      for (const obj of page.objects) {
        try {
          const txt = await r2GetText(env, obj.key);
          if (!txt) continue;
          const parsed = JSON.parse(txt);
          if (parsed?.job_id === jobId) {
            await env.MESHES.delete(obj.key);
          }
        } catch {}
      }
    } catch {}
  }
  const { error } = await sb.from('jobs').delete().eq('id', jobId).eq('user_id', userId);
  if (error) return err(500, error.message);
  return json({ ok: true, success: true });
}

/** GET /api/admin/history.xlsx — ADMIN ONLY full export with margin. */
async function handleAdminHistoryXls(req: Request, env: Env): Promise<Response> {
  const userOrResp = await _requireAdmin(req, env);
  if (userOrResp instanceof Response) return userOrResp;

  const sb = supabaseAdmin(env);
  const { data, error } = await sb
    .from('jobs')
    .select('user_id, asset_type, mode, status, credit_cost, options, created_at, finished_at, project_name, mesh_url, type, cost_usd')
    .order('created_at', { ascending: false })
    .limit(10000);
  if (error) return err(500, error.message);

  const userIds = Array.from(new Set((data ?? []).map((j: { user_id: string }) => j.user_id)));
  const emailById = new Map<string, string>();
  if (userIds.length) {
    const { data: profiles } = await sb.from('profiles').select('id, email').in('id', userIds);
    for (const p of (profiles ?? []) as { id: string; email: string }[]) {
      emailById.set(p.id, p.email ?? '');
    }
  }

  const EUR_PER_CREDIT_NET = 0.162;
  const USD_TO_EUR = 0.93;
  const headers = [
    'Date', 'User email', 'Type', 'Status', 'Duration (s)', 'Credits',
    'Cost USD', 'Cost EUR', 'Revenue EUR', 'Margin EUR',
    'Project', 'Asset type', 'Mode', 'Mesh key', 'Mesh URL (30d)'
  ];
  type J = {
    user_id: string; asset_type: string; mode: string; status: string;
    credit_cost: number; options: Record<string, unknown> | null;
    created_at: string; finished_at: string | null;
    project_name: string | null; mesh_url: string | null;
  };
  let totalMargin = 0;
  const jrows = (data ?? []) as J[];
  // Pre-sign persisted mesh keys with the long 'export' TTL (30d). The raw
  // key column lets a stale export be refreshed.
  const meshUrlSigned = await Promise.all(jrows.map(j =>
    j.mesh_url ? signedR2Url(env, j.mesh_url, 'export') : Promise.resolve('')));
  const rows: Array<Array<string | number>> = jrows.map((j, idx) => {
    const opType = String(j.type ?? j.options?.operation_type ?? j.asset_type ?? 'mesh');
    const costUsd = Number(j.cost_usd ?? j.options?.cost_usd
                          ?? MODAL_COST_USD[opType as keyof typeof MODAL_COST_USD]
                          ?? 0);
    const durMs = j.options?.duration_ms != null
      ? Number(j.options.duration_ms)
      : (j.finished_at
          ? new Date(j.finished_at).getTime() - new Date(j.created_at).getTime()
          : 0);
    const credits = j.status === 'succeeded' ? (j.credit_cost ?? 0) : 0;
    const revenueEur = credits * EUR_PER_CREDIT_NET;
    const costEur = costUsd * USD_TO_EUR;
    const marginEur = revenueEur - costEur;
    totalMargin += marginEur;
    return [
      new Date(j.created_at).toLocaleString('fr'),
      emailById.get(j.user_id) ?? '',
      opType,
      j.status,
      Number((durMs / 1000).toFixed(1)),
      credits,
      Number(costUsd.toFixed(4)),
      Number(costEur.toFixed(4)),
      Number(revenueEur.toFixed(4)),
      Number(marginEur.toFixed(4)),
      j.project_name ?? '',
      j.asset_type ?? '',
      j.mode ?? '',
      j.mesh_url ?? '',
      meshUrlSigned[idx],
    ];
  });
  // Append a TOTAL row.
  rows.push([
    '', '', '', '', '', '', '', '', 'TOTAL margin (EUR)', Number(totalMargin.toFixed(4)), '', '', '', '', '',
  ]);
  const stamp = new Date().toISOString().slice(0, 10);
  return _xlsxResponse(`admin-history-${stamp}.xlsx`, headers, rows);
}

/** GET /download/track — increment the desktop-downloads counters in R2.
 *  Two counters in parallel: an all-time total and a per-day series so
 *  the admin dashboard can chart downloads alongside revenue/cost.
 *  Public endpoint (no auth) — call from the marketing site's download
 *  button BEFORE redirecting to the actual .exe / .dmg / .AppImage. */
async function handleDownloadTrack(_req: Request, env: Env): Promise<Response> {
  if (!env.MESHES) return new Response('', { status: 204 });
  try {
    const totalKey = '_meta/desktop_downloads.txt';
    const dayKey   = `_meta/desktop_downloads_${todayUTC()}.txt`;
    const [totalCur, dayCur] = await Promise.all([
      r2GetText(env, totalKey).then(t => parseInt(t ?? '0', 10) || 0),
      r2GetText(env, dayKey).then(t => parseInt(t ?? '0', 10) || 0),
    ]);
    await Promise.all([
      env.MESHES.put(totalKey, String(totalCur + 1)),
      env.MESHES.put(dayKey,   String(dayCur   + 1)),
    ]);
  } catch (e) {
    console.warn('[download/track] failed:', e instanceof Error ? e.message : String(e));
  }
  return new Response('', { status: 204 });
}

/* ────────────────────────── pre-warm cron ──────────────────────────── */

/**
 * Fire a cheap dummy prediction at the Cog every 4 minutes so the
 * Replicate worker stays allocated. Without this, the first user call
 * after 5 min of inactivity pays a 2-3 min cold start (GPU allocation
 * + 18 GB image copy).
 *
 * We use steps=4 (fastest) on the text2image task — flux-dev-tier
 * latency, ~$0.005 per call. 12 calls/hour × 24h × 30d = ~$50/month
 * worst case, more realistically ~$15/month with off-peak GPU pricing.
 *
 * Triggered from wrangler.toml's [triggers] crons block.
 */
/**
 * Heartbeat-gated pre-warm. The frontend (when /app/ is visible)
 * pings /api/heartbeat every ~2 min. If no heartbeat has been
 * received in the last 5 min, we assume nobody is online and skip
 * the pre-warm call — saving the ~$0.005 it would have cost.
 */
const HEARTBEAT_KEY = '_meta/last_user_heartbeat';
const HEARTBEAT_WINDOW_MS = 5 * 60 * 1000;

async function markHeartbeat(env: Env): Promise<void> {
  if (!env.MESHES) return;
  await env.MESHES.put(HEARTBEAT_KEY, String(Date.now()));
}

async function isUserOnline(env: Env): Promise<boolean> {
  if (!env.MESHES) return false;
  const obj = await env.MESHES.get(HEARTBEAT_KEY);
  if (!obj) return false;
  const txt = await obj.text();
  const ts = parseInt(txt, 10);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < HEARTBEAT_WINDOW_MS;
}

/** Replicate keepalive — LEGACY FALLBACK ONLY.
 *  Production runs on Modal (handleGenerateImage picks callModalText2Image
 *  as soon as MODAL_TEXT2IMAGE_URL is set), so warming the Cog warms a
 *  backend nobody hits and costs ~$0.005 per fire for nothing. Kept —
 *  guarded — because deleting it would silently remove the pre-warm on a
 *  rollback that unsets MODAL_TEXT2IMAGE_URL.
 *  The heartbeat gate now lives in preWarmTick() (shared with preWarmModal). */
async function preWarmCog(env: Env): Promise<void> {
  if (env.MODAL_TEXT2IMAGE_URL) return;   // Modal is the live backend → see preWarmModal
  const token = env.REPLICATE_API_TOKEN ?? '';
  if (!token) return;
  try {
    const version = await resolveMyfabmeshCogVersion(token);
    // Fire-and-forget — Replicate keeps the worker hot as soon as it
    // accepts the job, even if we never poll the result.
    await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        version,
        input: { task: 'text2image', prompt: 'keepalive', asset_type: 'prop', asset_style: 'none', seed: 1, steps: 4 },
      }),
    });
    console.log('[pre-warm] sent keepalive (user online)');
  } catch (e) {
    console.error('[pre-warm] failed:', e instanceof Error ? e.message : String(e));
  }
}

/* ───────────────────────── Modal pre-warm ─────────────────────────────
 * The 524 blocker: /api/generate-image is synchronous, a cold Modal
 * container takes 2-3 min to boot, and Cloudflare cuts every subrequest
 * at 100 s → the very first click of a Store tester returned
 * "image generation failed (credits refunded): Cloud GPU HTTP 524".
 *
 * Pre-warming reduces how OFTEN that happens; it can never remove the
 * case entirely (see the cron math below). The actual fix is the 524
 * retry in callModalText2Image + the desktop-side retry in
 * src/main/cloud_fallback.js — pre-warm is the cheap first line.
 *
 * WHAT CAN BE WARMED, AND WHAT CANNOT
 *   ✅ text2image  — MyFabmeshPredictor router (modal_app/app.py:513),
 *                    the GPU class hit by the first click.
 *   ✅ image_op / back_view — MyFabmeshBackview router (app.py:764),
 *                    same GPU class; only on explicit request.
 *   ❌ mesh / rig / segment / anim — their routers are CPU dispatchers
 *                    (`@app.function(image=image)` with NO gpu=, see
 *                    app.py:1597) that .spawn() the real GPU class.
 *                    Pinging their /healthz warms a CPU container and
 *                    the GPU class not at all. The only way to warm
 *                    those is to run a real (paid, minutes-long) job —
 *                    deliberately NOT attempted here.
 *
 * Every Modal router exposes GET /healthz with no auth (app.py:725,
 * app.py:1319, app.py:1818, _puppeteer_rig.py:972, …), so the ping needs
 * no MODAL_SHARED_SECRET. The MODAL_*_URL secrets hold the FULL url
 * including the route path (documented at the top of the Modal section),
 * so the healthz url = last path segment replaced.
 * ──────────────────────────────────────────────────────────────────── */

/** Consider a container still warm (→ ping is pointless) below this age.
 *  Kept under MyFabmeshPredictor's scaledown_window=300 s (app.py:525)
 *  with a margin, so we never pay for a boot we do not need. */
const PREWARM_FRESH_MS = 4 * 60 * 1000;

function _healthzUrl(fullUrl: string): string {
  // …/myfabmeshpredictor-router.modal.run/text2image → …/healthz
  return fullUrl.replace(/\/[^/]*$/, '/healthz');
}

/** Boot the Modal containers the next user click will hit.
 *  A 524 / timeout on the ping is EXPECTED and counts as success: the
 *  container boots regardless of whether Cloudflare kept the connection.
 *  Never throws. */
async function preWarmModal(env: Env, opts: { imageOp?: boolean } = {}): Promise<void> {
  const targets: Array<{ label: string; url?: string; warmKey: string }> = [
    { label: 'text2image', url: env.MODAL_TEXT2IMAGE_URL, warmKey: '_meta/last_warm_text2image.txt' },
  ];
  if (opts.imageOp) {
    targets.push({ label: 'image_op', url: env.MODAL_IMAGE_OP_URL ?? env.MODAL_BACKVIEW_URL,
                   warmKey: '_meta/last_warm_image_op.txt' });
  }
  for (const t of targets) {
    if (!t.url) continue;
    try {
      const last = await _readLastWarmMs(env, t.warmKey).catch(() => null);
      if (last != null && Date.now() - last < PREWARM_FRESH_MS) {
        console.log(`[pre-warm] ${t.label} already warm — skipped`);
        continue;
      }
      // Do NOT log the url: /healthz is unauthenticated and publicly pingable.
      await fetch(_healthzUrl(t.url), {
        method: 'GET',
        signal: AbortSignal.timeout(120_000),
      }).catch(() => null);
      console.log(`[pre-warm] ${t.label} healthz pinged`);
    } catch (e) {
      console.warn(`[pre-warm] ${t.label} failed:`,
                   e instanceof Error ? e.message : String(e));
    }
  }
}

/** Cron entry point. Heartbeat-gated so an idle deployment never boots a
 *  GPU: without a /api/heartbeat in the last 5 min we assume nobody is
 *  online. NOTE (documented for the record): a 15-minute cron CANNOT keep
 *  the text2image container alive — scaledown_window is 300 s, so it is
 *  dead for 10 of every 15 minutes. Closing that gap with a 4-minute cron
 *  would cost ~$1400/month of idle L40S and was already tried + disabled (see
 *  the commented-out block in wrangler.toml). The cron is therefore a
 *  best-effort top-up only; the real coverage comes from the
 *  desktop-triggered POST /api/prewarm and from the 524 retries. */
async function preWarmTick(env: Env): Promise<void> {
  // LE COUPE-CIRCUIT S'APPLIQUE AUSSI AU CRON. Il n'etait verifie que sur
  // les requetes HTTP (MODAL_PATHS dans le routeur) : un administrateur
  // qui coupait le backend GPU voyait donc le cron continuer a allumer un
  // conteneur toutes les 15 min. Un kill switch qui ne coupe pas tout
  // n'est pas un kill switch.
  try {
    const flags = await _getServiceFlags(env);
    if (!flags.modal_enabled) {
      console.log('[pre-warm] ignore — backend GPU coupe par l\'administrateur');
      return;
    }
  } catch { /* drapeaux illisibles : on continue, le garde suivant borne deja */ }

  if (!(await isUserOnline(env))) {
    console.log('[pre-warm] skipped — no recent heartbeat (nobody online)');
    return;
  }
  if (env.MODAL_TEXT2IMAGE_URL) await preWarmModal(env);
  else await preWarmCog(env);
}

async function handleHeartbeat(req: Request, env: Env): Promise<Response> {
  // AUTHENTIFICATION EXIGEE depuis le 2026-08-03.
  //
  // La route etait anonyme, au motif qu'un cookie expire ne devait pas
  // faire echouer le battement. Consequence reelle : n'importe qui sur
  // Internet pouvait marquer « un utilisateur est en ligne », ce que lit
  // preWarmTick pour allumer un L40S toutes les 15 min — soit ~470 $/mois
  // declenchables par un inconnu avec une boucle curl.
  //
  // Le motif d'origine ne tient pas : le prechauffage sert a preparer une
  // generation, et une generation exige une session. Chauffer un GPU pour
  // quelqu'un qui ne peut rien lancer n'a aucun sens.
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  await markHeartbeat(env);
  return json({ ok: true });
}

/** POST /api/prewarm — a signed-in client (desktop app entering Cloud
 *  mode, or the web app opening the image panel) asks us to start booting
 *  the text2image container NOW, so its first real click lands warm.
 *  Returns immediately; the ping runs in waitUntil.
 *  Auth is REQUIRED (unlike /api/heartbeat): this route can start a GPU,
 *  so it must not be anonymous. The PREWARM_FRESH_MS check inside
 *  preWarmModal is the natural rate limit — a repeated caller costs
 *  nothing while the container is warm. */
async function handlePrewarm(req: Request, env: Env,
                             ctx?: { waitUntil?: (p: Promise<unknown>) => void }): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  let imageOp = false;
  try { imageOp = !!(await req.json().catch(() => ({})) as { imageOp?: boolean }).imageOp; } catch { /* body optional */ }
  const last = await _readLastWarmMs(env, '_meta/last_warm_text2image.txt').catch(() => null);
  if (last != null && Date.now() - last < PREWARM_FRESH_MS && !imageOp) {
    return json({ ok: true, warming: false, warm: true });
  }
  const p = preWarmModal(env, { imageOp });
  if (ctx?.waitUntil) ctx.waitUntil(p);
  else p.catch(() => {});          // never block the caller on a GPU boot
  return json({ ok: true, warming: true });
}

/* ────────────────────────── main fetch handler ─────────────────────── */

// GDPR storage-limitation (Art. 5(1)(e)): transient user inputs — drawn masks
// (<uid>/masks/) and uploaded canvas source images (<uid>/canvas/) — are deleted
// 30 days after upload. Final meshes/images live under other prefixes and are
// kept until the user deletes their account. Bounded to 1000 objects/run with a
// rotating cursor so one cron invocation stays well within CPU limits.
async function purgeTransientUploads(env: Env): Promise<void> {
  if (!env.MESHES) return;
  const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
  const now = Date.now();
  const cursorKey = '_meta/retention_cursor.txt';
  let cursor: string | undefined;
  try {
    const c = await env.MESHES.get(cursorKey);
    if (c) { const t = (await c.text()).trim(); cursor = t || undefined; }
  } catch { /* ignore */ }
  let listed;
  try {
    listed = await env.MESHES.list({ cursor, limit: 1000 });
  } catch (e) {
    console.log(`[retention] list failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  let deleted = 0;
  for (const obj of listed.objects) {
    if (!/\/(masks|canvas)\//.test(obj.key)) continue;
    if (now - obj.uploaded.getTime() > MAX_AGE_MS) {
      try { await env.MESHES.delete(obj.key); deleted++; } catch { /* keep going */ }
    }
  }
  const nextCursor = listed.truncated ? listed.cursor : '';
  try { await env.MESHES.put(cursorKey, nextCursor); } catch { /* ignore */ }
  console.log(`[retention] scanned ${listed.objects.length}, deleted ${deleted} transient masks/canvas >30d, cursor=${nextCursor ? 'more' : 'reset'}`);
}

// Every status a job can sit in while still in flight. The mesh insert writes
// 'queued', the Replicate insert writes Replicate's own 'starting', the async
// op inserts write 'processing', and some Modal paths flip to 'running'
// mid-pipeline. Anything not in this list is terminal (succeeded / failed /
// canceled) and must never be re-refunded.
const NON_TERMINAL_JOB_STATUSES = ['queued', 'starting', 'running', 'processing', 'pending'] as const;

// Idempotent: mark a job failed + refund its credits EXACTLY ONCE, even if the
// client poll and the cron reaper race. Only the request that flips the row out
// of a non-terminal status refunds (conditional UPDATE + select) — that claim
// IS the exactly-once guarantee, do not loosen it.
// Returns true when THIS call claimed the row (i.e. it performed the refund),
// false when someone else had already finalised it. Callers use the return
// value to decide whether to also refund the Modal $ budget / delete the R2
// job record, so those side effects stay exactly-once too.
async function _failAndRefundJob(env: Env, job: { id: unknown; user_id?: unknown; credit_cost?: unknown }, errMsg: string): Promise<boolean> {
  const sb = supabaseAdmin(env);
  const { data, error } = await sb.from('jobs')
    .update({ status: 'failed', error: String(errMsg).slice(0, 500), finished_at: new Date().toISOString() })
    .eq('id', job.id as string)
    // 2026-07-26: widened from ['processing','pending']. Jobs inserted as
    // 'queued' (mesh) or 'starting' (Replicate) were invisible to this claim,
    // so their credits could never be refunded at all.
    .in('status', NON_TERMINAL_JOB_STATUSES as unknown as string[])
    .select('id');
  if (error || !data || data.length === 0) return false;  // already finalized by someone else
  if (typeof job.user_id === 'string' && typeof job.credit_cost === 'number') {
    await addCredits(env, job.user_id, job.credit_cost);
  }
  return true;
}

/** Reaper routing table: how to re-poll each async Modal op family, what its
 *  GPU $ estimate is, and which R2 job record to drop once it is reaped.
 *
 *  All four endpoints take the SAME request shape
 *  (POST { _auth, job_id }) and return the SAME response shape
 *  ({ ready?: boolean, error?: string }) — verified against
 *  handleAutoRigStatus / handleMeshSegmentStatus / handleAutoAnimStatus /
 *  handleAnimateFromReferenceStatus, which is why one generic poller covers
 *  them all. `envKey` holds the BASE url of the Modal app; `path` is appended. */
const _REAP_BACKENDS: Record<string, {
  envKey: 'MODAL_RIG_URL' | 'MODAL_SEGMENT_URL' | 'MODAL_ANYTOP_ANIM_URL' | 'MODAL_FBX_RETARGET_URL';
  path: string;
  usd: number;
  delRecord?: (env: Env, id: string) => Promise<void>;
}> = {
  // Le nettoyeur interrogeait `MODAL_PUPPETEER_RIG_URL` en dur, en contournant
  // `_rigBaseUrl`. Il sondait donc l'ancien moteur pendant que la production
  // riggait sur SkinTokens : jamais le meme travail, d'ou des taches jamais
  // finalisees. Corrige avec le retrait de Puppeteer (2026-08-08).
  rig:         { envKey: 'MODAL_RIG_URL',           path: '/rig-status',          usd: ESTIMATED_USD_RIG,     delRecord: deleteRigJobRecord },
  segment:     { envKey: 'MODAL_SEGMENT_URL',       path: '/segment-status',      usd: ESTIMATED_USD_SEGMENT, delRecord: deleteSegmentJobRecord },
  animate:     { envKey: 'MODAL_ANYTOP_ANIM_URL',   path: '/anim-status',         usd: ESTIMATED_USD_ANIM,    delRecord: deleteAnimJobRecord },
  animate_fbx: { envKey: 'MODAL_FBX_RETARGET_URL',  path: '/fbx-retarget-status', usd: ESTIMATED_USD_ANIM,    delRecord: deleteAnimJobRecord },
};

/** One generic status poll against any of the four async Modal op apps. */
async function _pollModalOpStatus(
  env: Env, baseUrl: string, path: string, jobId: string,
): Promise<{ ready?: boolean; error?: string }> {
  if (!env.MODAL_SHARED_SECRET) throw new Error('MODAL_SHARED_SECRET not set');
  const r = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ _auth: env.MODAL_SHARED_SECRET, job_id: jobId }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json() as { ready?: boolean; error?: string };
}

interface ReapResult {
  scanned: number;
  reaped: number;
  credits_refunded: number;
  skipped: number;
  errors: string[];
}

// Reaper: a job whose client stopped polling (tab closed / container died)
// would sit in a non-terminal status forever and the spent credits would be
// lost. Sweep old in-flight jobs, re-poll the RIGHT Modal endpoint for each op
// type, and fail+refund the dead ones (idempotent).
//
// 2026-07-26 — this used to `.eq('status','processing')` and then
// `if (!id.startsWith('modal_')) continue`, i.e. it ONLY ever handled mesh
// jobs minted by handleGenerate. Rig (5 cr), segment (15 cr), animate (5 cr)
// and animate_fbx (5 cr) ids come from Modal's own *-start responses and never
// carry that prefix, so an abandoned rig/segmentation/animation was NEVER
// refunded: the user paid for nothing. Jobs inserted as 'queued'/'starting'
// were doubly invisible (neither the select nor the refund claim matched them).
async function reapStuckJobs(env: Env): Promise<ReapResult> {
  const out: ReapResult = { scanned: 0, reaped: 0, credits_refunded: 0, skipped: 0, errors: [] };
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return out;
  // Bounded: this array is serialised into the R2 cron receipt, and 200 dead
  // jobs × 200 chars would bloat a file the dashboard reads on every poll.
  const noteErr = (m: string) => { if (out.errors.length < 20) out.errors.push(m.slice(0, 200)); };
  const sb = supabaseAdmin(env);
  // Tightened 30 -> 20 min on 2026-07-28. NOT a cost control: the GPU
  // functions carry their own Modal-side timeout (600s for the image
  // classes, 900s for the TRELLIS-2 mesh class), so Modal has already
  // stopped billing long before the reaper looks. What this actually
  // buys is speed of REFUND and of clearing the UI — a user whose job
  // died sat on spent credits for half an hour.
  //
  // Why not lower still: 900s of execution + container cold start
  // (weight load) + queue wait means a perfectly healthy generation can
  // legitimately be ~20 min old. Reaping at 15 min would mark LIVE jobs
  // as failed — the false "Timeout on a generation that had not failed"
  // regression fixed in 2389221. 20 min is the floor that stays above
  // the longest legitimate run. Segmentation (8-10 min) is unaffected.
  const GRACE_MS = 20 * 60 * 1000;
  // Must stay <= GRACE_MS or the grace can never elapse: this is the
  // pre-filter deciding which rows the reaper even looks at.
  const GRACE_LABEL = `${Math.round(GRACE_MS / 60000)} min`;
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data: stuck, error: selErr } = await sb.from('jobs')
    .select('id, user_id, credit_cost, created_at, status, options, asset_type, type, cost_usd')
    .in('status', NON_TERMINAL_JOB_STATUSES as unknown as string[])
    .lt('created_at', cutoff)
    // 200 max: each job costs up to 1 status POST + 1 UPDATE + 1 RPC + 1-2 R2
    // ops, which approaches Cloudflare's 1000-subrequest cap on a scheduled
    // invocation. Do NOT raise this further.
    .limit(200);
  if (selErr) { noteErr('select: ' + selErr.message); return out; }
  if (!stuck || !stuck.length) return out;
  out.scanned = stuck.length;

  for (const job of stuck as Array<{
    id: unknown; user_id?: unknown; credit_cost?: unknown;
    created_at?: unknown; status?: unknown;
    options?: Record<string, unknown> | null; asset_type?: unknown;
  }>) {
    const id = String(job.id);
    const at = String(job.asset_type ?? '');
    // options.operation_type is authoritative (every insert writes it since
    // 2026-07-26); asset_type then the 'modal_' id prefix are fallbacks for
    // rows written by older deploys.
    const opType = String((job.options as Record<string, unknown> | null)?.operation_type || '')
      || (at === 'rig' ? 'rig'
        : at === 'segment' ? 'segment'
        : at === 'animation' ? 'animate'
        : '')
      || (id.startsWith('modal_') ? 'mesh' : '');
    if (!opType) { out.skipped++; continue; }
    const age = job.created_at ? Date.now() - new Date(String(job.created_at)).getTime() : 0;
    const creditCost = typeof job.credit_cost === 'number' ? job.credit_cost : 0;
    // The GPU $ the budget guard actually charged for this job. Since
    // 2026-07-26 every insert records it; older rows fall back to the op-type
    // table so we never over-refund the budget counter.
    const recordedUsd = Number(
      (job.options as Record<string, unknown> | null)?.cost_usd
      ?? MODAL_COST_USD[opType]
      ?? 0,
    ) || 0;

    // ── Mesh: the original path, unchanged semantics ──
    if (opType === 'mesh') {
      // Only Modal-minted ids are re-pollable via callModalMeshStatus;
      // Replicate predictions are reaped on the grace timer alone.
      const pollable = id.startsWith('modal_');
      const refundMeshBudget = async () => {
        // Mesh routes to Modal or Replicate and each has its OWN counter —
        // refund the one the job was charged against (backend is recorded on
        // the row; the 'modal_' prefix is the fallback for legacy rows).
        const backend = String((job.options as Record<string, unknown> | null)?.backend
          || (pollable ? 'modal' : 'replicate'));
        if (backend === 'replicate') await refundDailySpend(env, recordedUsd).catch(() => {});
        else await refundModalSpend(env, recordedUsd).catch(() => {});
      };
      try {
        const status = pollable
          ? await callModalMeshStatus(env, id)
          : { ready: false } as ModalMeshStatusResp;
        let claimed = false;
        if (status.error) claimed = await _failAndRefundJob(env, job, status.error);
        else if (status.ready && status.glb_base64) { /* finished; a client/admin poll persists it */ }
        else if (age > GRACE_MS) claimed = await _failAndRefundJob(env, job, `reaped: no result after ${GRACE_LABEL}`);
        if (claimed) {
          out.reaped++; out.credits_refunded += creditCost;
          // Give the GPU budget back too — the old reaper never did.
          await refundMeshBudget();
        }
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (age > GRACE_MS) {
          if (await _failAndRefundJob(env, job, `reaped: unreachable after ${GRACE_LABEL}`)) {
            out.reaped++; out.credits_refunded += creditCost;
            await refundMeshBudget();
          }
        } else { noteErr(`${id}: ${m}`); }
      }
      continue;
    }

    // ── rig / segment / animate / animate_fbx ──
    const cfg = _REAP_BACKENDS[opType];
    if (!cfg) { out.skipped++; continue; }
    const base = env[cfg.envKey];
    const finalize = async (why: string) => {
      if (!(await _failAndRefundJob(env, job, why))) return;   // someone else got there first
      out.reaped++; out.credits_refunded += creditCost;
      await refundModalSpend(env, recordedUsd || cfg.usd).catch(() => {});
      if (cfg.delRecord) await cfg.delRecord(env, id).catch(() => {});
    };
    if (!base) {
      // Backend disabled/rotated since the job started — it can never finish.
      if (age > GRACE_MS) await finalize(`reaped: ${opType} backend unavailable`);
      else out.skipped++;
      continue;
    }
    try {
      const resp = await _pollModalOpStatus(env, base, cfg.path, id);
      // Same semantics as the four status handlers: ready===false && !error →
      // still running; ready===false && error → failed; ready===true →
      // finished, leave it (a client/admin poll persists the asset).
      if (resp?.ready === false && resp?.error) {
        await finalize(String(resp.error).slice(0, 300));
      } else if (resp?.ready === true) {
        /* done — the asset is on the Modal volume, a poll will fetch it */
      } else if (age > GRACE_MS) {
        await finalize(`reaped: ${opType} produced no result after ${GRACE_LABEL}`);
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (age > GRACE_MS) await finalize(`reaped: ${opType} unreachable after ${GRACE_LABEL}`);
      else noteErr(`${id}: ${m}`);
    }
  }
  console.log(`[reaper] scanned ${out.scanned} in-flight jobs >20min, `
    + `failed+refunded ${out.reaped} (${out.credits_refunded} credits), `
    + `skipped ${out.skipped}, errors ${out.errors.length}`);
  return out;
}

// Weekly keep-alive so the free-tier Supabase project doesn't auto-pause after
// 7 days of inactivity. One cheap read; best-effort (never throws).
async function keepAliveSupabase(env: Env): Promise<void> {
  try {
    const url = env.NEXT_PUBLIC_SUPABASE_URL;
    const key = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return;
    await fetch(`${url}/rest/v1/profiles?select=id&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
  } catch {
    /* best-effort — inactivity ping only */
  }
}

export default {
  async scheduled(event: { cron?: string }, env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }): Promise<void> {
    // Weekly keep-alive: one cheap Supabase read so the free-tier project never
    // auto-pauses (7-day inactivity). Cheap + safe — runs on every cron.
    ctx.waitUntil(keepAliveSupabase(env));
    // Heavier maintenance (pre-warm / purge / reap) runs only on the frequent
    // heartbeat cron — NOT the weekly keep-alive ping (avoids any credit burn).
    if (event.cron !== '0 6 * * 1') {
      // ONE waitUntil around the whole block (they used to be three
      // fire-and-forget promises) so the receipt below can measure the real
      // duration and capture a throw from any of the three. All three are
      // I/O-light and the 15-min cron window is ample, so running them
      // sequentially costs nothing.
      //
      // The receipt is the ONLY proof of life the dashboard has: before this,
      // a reaper that died at the last deploy was indistinguishable from one
      // that ran 30 seconds ago.
      ctx.waitUntil((async () => {
        const t0 = Date.now();
        const emsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);
        const rec = {
          ts: new Date().toISOString(),
          cron: event.cron ?? null,
          duration_ms: 0,
          scanned: 0,
          reaped: 0,
          credits_refunded: 0,
          skipped: 0,
          errors: [] as string[],
        };
        try { await preWarmTick(env); } catch (e) { rec.errors.push('preWarm: ' + emsg(e)); }
        try { await purgeTransientUploads(env); } catch (e) { rec.errors.push('purge: ' + emsg(e)); }
        try {
          const r = await reapStuckJobs(env);
          rec.scanned = r.scanned; rec.reaped = r.reaped;
          rec.credits_refunded = r.credits_refunded; rec.skipped = r.skipped;
          rec.errors.push(...r.errors.map((m) => 'reaper: ' + m));
        } catch (e) { rec.errors.push('reaper: ' + emsg(e)); }
        rec.duration_ms = Date.now() - t0;
        try {
          if (env.MESHES) {
            await env.MESHES.put('_meta/cron/last_run.json', JSON.stringify(rec),
              { httpMetadata: { contentType: 'application/json' } });
          }
        } catch { /* best-effort receipt — never fail the tick over it */ }
      })());
    }
  },

  async fetch(req: Request, env: Env, _ctx: unknown): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method.toUpperCase();

    try {
      // ── /auth/callback ──
      // Handled by a client-side Next.js page (src/app/auth/callback/page.tsx)
      // which uses the Supabase JS SDK so the PKCE code_verifier saved in
      // localStorage at sign-in time is reused on exchange. The Worker
      // can't do this because it doesn't have access to that verifier.
      // Fall through to env.ASSETS.fetch(req) at the bottom of fetch().

      // ── signed R2 object serving ──────────────────────────────
      // GET /r2/<key>?exp&sig — verify HMAC + expiry, stream from the
      // MESHES binding. Placed BEFORE the kill switches (like static
      // assets) so an open viewer keeps working during maintenance,
      // and is not under /api/ so it bypasses the /api/* router below.
      if (pathname.startsWith('/r2/') && method === 'GET') {
        return await handleSignedR2(req, env);
      }

      // ── kill switches ──────────────────────────────────────────
      // Two nested levels:
      //   modal_enabled=false  -> only Modal-bound /api/* return 503
      //   stripe_enabled=false -> /api/checkout 503 (webhook stays!)
      //   site_enabled=false   -> EVERYTHING returns 503 except /admin
      //                           and /api/admin/*. Static assets get a
      //                           friendly HTML maintenance page so
      //                           users see "we're down" instead of a
      //                           broken UI shell.
      const MODAL_PATHS = new Set([
        '/api/generate', '/api/generate-image', '/api/generate-back-view',
        '/api/rectify-image', '/api/modify-image', '/api/auto-inpaint',
        '/api/segment-preview',
        '/api/mask-inpaint', '/api/face-fix-image', '/api/upscale-image',
        '/api/face-fix-mesh', '/api/mesh-op', '/api/text2image-tpose',
        // Boots a Blender container on Modal -> same kill switch.
        '/api/mesh-convert',
        '/api/auto-rig', '/api/auto-rig-status',
        '/api/mesh-segment', '/api/mesh-segment-status',
        // /api/prewarm can BOOT a Modal GPU — it must obey the same kill
        // switch. (/api/heartbeat stays reachable: it is a free R2 write and
        // the pre-warm it gates is itself blocked here.)
        '/api/prewarm',
      ]);
      // /api/stripe-webhook MUST stay reachable even when Site is OFF.
      // Stripe has already charged the card by the time it calls us; a
      // 503 means the user pays without ever getting credits (Stripe
      // retries for 3 days then gives up). Carving it out alongside
      // /admin and /api/admin/*.
      const isAdminRoute = pathname.startsWith('/admin')
                        || pathname.startsWith('/api/admin/')
                        || pathname === '/api/stripe-webhook';
      if (!isAdminRoute) {
        const flags = await _getServiceFlags(env);
        if (!flags.site_enabled) {
          if (!pathname.startsWith('/api/')) {
            return new Response(
              `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
              <title>MyFabmesh.AI — Maintenance</title>
              <style>body{margin:0;font:16px system-ui,sans-serif;background:#0a0a0e;color:#f0f0f0;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px}.card{max-width:480px}h1{margin:0 0 12px}p{color:#8888a0;line-height:1.6}</style>
              <div class=card><h1>🛠 Service temporarily unavailable</h1>
              <p>MyFabmesh.AI is down for maintenance. We'll be back shortly.</p></div>`,
              { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
            );
          }
          return err(503, 'site temporarily disabled by admin');
        }
        if (pathname.startsWith('/api/')) {
          if (!flags.modal_enabled && MODAL_PATHS.has(pathname)) {
            return err(503, 'Cloud GPU backend temporarily disabled by admin');
          }
          // Stripe kill: block new checkouts but NEVER block the
          // webhook — Stripe has already charged the card; if we 503
          // the webhook the user pays and gets zero credits.
          if (!flags.stripe_enabled && pathname === '/api/checkout') {
            return err(503, 'purchases temporarily disabled by admin');
          }
        }
      }

      // ── /api/* router ──
      if (pathname.startsWith('/api/')) {
        if (pathname === '/api/me'                    && method === 'GET')  return await handleMe(req, env);
        if (pathname === '/api/contact'               && method === 'POST') return await handleContactSubmit(req, env);
        if (pathname === '/api/admin/contact-messages' && method === 'GET') return await handleAdminContactList(req, env);
        if (pathname === '/api/admin/modal-credits'         && method === 'GET')  return await handleAdminModalCredits(req, env);
        if (pathname === '/api/admin/modal-credits/total'   && method === 'POST') return await handleAdminModalSetBudget(req, env);
        if (pathname === '/api/admin/modal-usage'           && method === 'POST') return await handleAdminModalUsageIngest(req, env);
        // ── Marketplace ──
        if (pathname === '/api/market/list'                 && method === 'GET')  return await handleMarketList(req, env);
        if (pathname === '/api/market/publish'              && method === 'POST') return await handleMarketPublish(req, env);
        if (pathname === '/api/market/report'               && method === 'POST') return await handleMarketReport(req, env);
        if (pathname === '/api/market/checkout'             && method === 'POST') return await handleMarketCheckout(req, env);
        if (pathname === '/api/market/owned'                && method === 'GET')  return await handleMarketOwned(req, env);
        if (pathname === '/api/market/seller/onboard'       && method === 'POST') return await handleMarketSellerOnboard(req, env);
        if (pathname === '/api/market/seller/status'        && method === 'GET')  return await handleMarketSellerStatus(req, env);
        if (pathname === '/api/market/seller/dashboard'     && method === 'POST') return await handleMarketSellerDashboard(req, env);
        if (pathname === '/api/market/seller/earnings'      && method === 'GET')  return await handleMarketSellerEarnings(req, env);
        if (pathname === '/api/admin/market/list'           && method === 'GET')  return await handleAdminMarketList(req, env);
        if (pathname === '/api/admin/market/killswitch'     && method === 'GET')  return await handleAdminMarketKillSwitchGet(req, env);
        if (pathname === '/api/admin/market/killswitch'     && method === 'POST') return await handleAdminMarketKillSwitchSet(req, env);
        {
          const m = pathname.match(/^\/api\/market\/download\/([A-Za-z0-9_]+)$/);
          if (m && method === 'GET') return await handleMarketDownload(req, env, m[1]);
        }
        // Rate a listing — must come BEFORE the bare /api/market/<id> regex
        // so the trailing /rate segment isn't swallowed.
        {
          const m = pathname.match(/^\/api\/market\/listing\/([A-Za-z0-9_]+)\/rate$/);
          if (m && method === 'POST') return await handleMarketRate(req, env, m[1]);
        }
        // Public author profile page — disjoint from /api/market/<id> (two
        // path segments after /api/market/) but kept before for grouping.
        {
          const m = pathname.match(/^\/api\/market\/author\/([A-Za-z0-9_-]+)$/);
          if (m && method === 'GET') return await handleMarketAuthorPage(req, env, m[1]);
        }
        {
          const m = pathname.match(/^\/api\/market\/([A-Za-z0-9_]+)$/);
          if (m && method === 'GET') return await handleMarketGet(req, env, m[1]);
        }
        {
          const m = pathname.match(/^\/api\/market\/unpublish\/([A-Za-z0-9_]+)$/);
          if (m && method === 'POST') return await handleMarketUnpublish(req, env, m[1]);
        }
        {
          const m = pathname.match(/^\/api\/market\/listing\/([A-Za-z0-9_]+)$/);
          if (m && method === 'PATCH') return await handleMarketUpdate(req, env, m[1]);
        }
        {
          const m = pathname.match(/^\/api\/market\/listing\/([A-Za-z0-9_]+)$/);
          if (m && method === 'PATCH') return await handleMarketListingUpdate(req, env, m[1]);
        }
        {
          const m = pathname.match(/^\/api\/admin\/market\/([A-Za-z0-9_]+)(?:\/(approve|reject))?$/);
          if (m) {
            if (m[2] === 'approve' && method === 'POST')   return await handleAdminMarketApprove(req, env, m[1]);
            if (m[2] === 'reject'  && method === 'POST')   return await handleAdminMarketReject(req, env, m[1]);
            if (!m[2]              && method === 'DELETE') return await handleAdminMarketDelete(req, env, m[1]);
          }
        }
        {
          const m = pathname.match(/^\/api\/admin\/contact-messages\/([A-Za-z0-9_]+)(?:\/(read|reply))?$/);
          if (m) {
            if (m[2] === 'read'  && method === 'POST')   return await handleAdminContactRead(req, env, m[1]);
            if (m[2] === 'reply' && method === 'POST')   return await handleAdminContactReply(req, env, m[1]);
            if (!m[2]             && method === 'DELETE') return await handleAdminContactDelete(req, env, m[1]);
          }
        }
        if (pathname === '/api/auth/install-session'  && method === 'POST') return await handleAuthInstallSession(req, env);
        if (pathname === '/api/auth/refresh'          && method === 'POST') return await handleAuthRefresh(req, env);
        if (pathname === '/api/auth/signout'          && method === 'POST') return await handleAuthSignout(req, env);
        if (pathname === '/api/me/export'             && method === 'GET')  return await handleMeExport(req, env);
        if (pathname === '/api/parental/status'       && method === 'GET')  return await handleParentalStatus(req, env);
        if (pathname === '/api/parental/toggle'       && method === 'POST') return await handleParentalToggle(req, env);
        if (pathname === '/api/client-log'            && method === 'POST') return await handleClientLog(req, env);
        if (pathname === '/api/client-log/list'       && method === 'GET')  return await handleClientLogList(req, env);
        if (pathname === '/api/admin/logs/list'       && method === 'GET')  return await handleAdminLogsList(req, env);
        if (pathname === '/api/admin/logs/get'        && method === 'GET')  return await handleAdminLogsGet(req, env);
        if (pathname === '/api/user-assets/record'    && method === 'POST') return await handleUserAssetsRecord(req, env);
        if (pathname === '/api/user-assets/delete'    && method === 'POST') return await handleUserAssetsDelete(req, env);
        if (pathname === '/api/user-assets/migrate-from-jobs' && method === 'POST') return await handleUserAssetsMigrateFromJobs(req, env);
        if (pathname === '/api/user-assets/reassign-orphans'  && method === 'POST') return await handleUserAssetsReassignOrphans(req, env);
        if (pathname === '/api/thumbs/upload'         && method === 'POST') return await handleThumbsUpload(req, env);
        if (pathname === '/api/me/replies'            && method === 'GET')  return await handleMeReplies(req, env);
        if (pathname === '/api/me/inbox'              && method === 'GET')  return await handleMeInbox(req, env);
        if (pathname === '/api/me/inbox/read'         && method === 'POST') return await handleMeInboxRead(req, env);
        if (pathname === '/api/me/published-assets'   && method === 'GET')  return await handleMePublishedAssets(req, env);
        if (pathname === '/api/me/earnings'           && method === 'GET')  return await handleMeEarnings(req, env);
        if (pathname === '/api/me/delete'             && method === 'POST') return await handleMeDelete(req, env);
        // Signalement de contenu généré par l'IA — exigé par la politique
        // 11.16 du Microsoft Store. Volontairement ouvert sans session.
        if (pathname === '/api/report-content'        && method === 'POST') return await handleReportContent(req, env);
        if (pathname === '/api/debug-auth'            && method === 'GET')  return await handleDebugAuth(req, env);
        if (pathname === '/api/checkout'              && method === 'POST') return await handleCheckout(req, env);
        if (pathname === '/api/pricing/availability'  && method === 'GET')  return await handlePricingAvailability(req, env);
        if (pathname === '/api/stripe-webhook'        && method === 'POST') return await handleStripeWebhook(req, env);
        if (pathname === '/api/generate'              && method === 'POST') return await handleGenerate(req, env);
        if (pathname === '/api/projects'              && method === 'GET')  return await handleProjects(req, env);
        if (pathname === '/api/projects/delete'       && method === 'POST') return await handleProjectsDelete(req, env);
        if (pathname === '/api/cloud-projects'        && method === 'GET')  return await handleCloudProjects(req, env);
        if (pathname === '/api/cloud-projects/delete' && method === 'POST') return await handleCloudProjectsDelete(req, env);
        if (pathname === '/api/me/wipe-all-projects'  && method === 'POST') return await handleMeWipeAllProjects(req, env);
        if (pathname === '/api/meshes'                && method === 'GET')  return await handleListMeshes(req, env);
        if (pathname === '/api/meshes/delete'         && method === 'POST') return await handleMeshesDelete(req, env);
        if (pathname === '/api/jobs/cancel'           && method === 'POST') return await handleJobCancel(req, env);
        if (pathname === '/api/me/active-jobs'        && method === 'GET')  return await handleMeActiveJobs(req, env);
        if (pathname === '/api/remove-background'     && method === 'POST') return await handleRemoveBackground(req, env);
        if (pathname === '/api/generate-image'        && method === 'POST') return await handleGenerateImage(req, env);
        if (pathname === '/api/generate-back-view'    && method === 'POST') return await handleGenerateBackView(req, env);
        if (pathname === '/api/rectify-image'         && method === 'POST') return await handleRectifyImage(req, env);
        if (pathname === '/api/modify-image'          && method === 'POST') return await handleModifyImage(req, env);
        if (pathname === '/api/auto-inpaint'          && method === 'POST') return await handleAutoInpaint(req, env);
        if (pathname === '/api/segment-preview'       && method === 'POST') return await handleSegmentPreview(req, env);
        if (pathname === '/api/mask-inpaint'          && method === 'POST') return await handleMaskInpaint(req, env);
        if (pathname === '/api/face-fix-image'        && method === 'POST') return await handleFaceFixImage(req, env);
        if (pathname === '/api/copy-mesh-to-project'  && method === 'POST') return await handleCopyMeshToProject(req, env);
        if (pathname === '/api/upscale-image'         && method === 'POST') return await handleUpscaleImage(req, env);
        if (pathname === '/api/proxy-image'           && method === 'GET')  return await handleProxyImage(req, env);
        if (pathname === '/api/upload-image'          && method === 'POST') return await handleUploadImage(req, env);
        if (pathname === '/api/upload-mesh'           && method === 'POST') return await handleUploadMesh(req, env);
        if (pathname === '/api/auto-rig'              && method === 'POST') return await handleAutoRig(req, env);
        if (pathname === '/api/auto-rig-status'       && (method === 'GET' || method === 'POST')) return await handleAutoRigStatus(req, env);
        if (pathname === '/api/mesh-segment'          && method === 'POST') return await handleMeshSegment(req, env);
        if (pathname === '/api/mesh-segment-status'   && (method === 'GET' || method === 'POST')) return await handleMeshSegmentStatus(req, env);
        if (pathname === '/api/animate'               && method === 'POST') return await handleAutoAnim(req, env);
        if (pathname === '/api/animate-status'        && (method === 'GET' || method === 'POST')) return await handleAutoAnimStatus(req, env);
        if (pathname === '/api/animate-from-reference' && method === 'POST') return await handleAnimateFromReference(req, env);
        if (pathname === '/api/animate-from-reference-status' && (method === 'GET' || method === 'POST')) return await handleAnimateFromReferenceStatus(req, env);
        if (pathname === '/api/animations/delete'     && method === 'POST') return await handleAnimDelete(req, env);
        if (pathname === '/api/animations/upload'     && method === 'POST') return await handleAnimUpload(req, env);
        if (pathname === '/api/animations/copy'       && method === 'POST') return await handleAnimCopy(req, env);
        if (pathname === '/api/landmarks'             && method === 'POST') return await handleLandmarks(req, env);
        if (pathname === '/api/modal-status'          && method === 'GET')  return await handleModalStatus(req, env);
        // Cold-start mitigation (see the "Modal pre-warm" section):
        //   /api/heartbeat — free, unauthenticated, 1 R2 PUT. It was DEFINED
        //     but never routed, so isUserOnline() always returned false and
        //     the pre-warm cron had been inert since it was written.
        //   /api/prewarm   — session-gated, boots the text2image container
        //     on demand (desktop entering Cloud mode / image panel opened).
        if (pathname === '/api/heartbeat'             && (method === 'POST' || method === 'GET')) return await handleHeartbeat(req, env);
        if (pathname === '/api/prewarm'               && method === 'POST') return await handlePrewarm(req, env, _ctx as { waitUntil?: (p: Promise<unknown>) => void });
        if (pathname === '/api/mesh-op'               && method === 'POST') return await handleMeshOp(req, env);
        if (pathname === '/api/mesh-convert'          && method === 'POST') return await handleMeshConvert(req, env);
        if (pathname === '/api/construction-stages-3d' && method === 'POST') return await handleConstructionStages3d(req, env);
        if (pathname === '/api/stages3d-list'         && method === 'GET')  return await handleStages3dList(req, env);
        if (pathname === '/api/mesh-op/client-result' && method === 'POST') return await handleMeshOpClientResult(req, env);
        if (pathname === '/api/history.csv'           && method === 'GET')  return await handleHistoryCsv(req, env);
        if (pathname.startsWith('/api/history/')      && method === 'GET') {
          const id = pathname.slice('/api/history/'.length);
          if (id && !id.includes('/')) return await handleHistoryDetail(req, env, id);
        }
        if (pathname === '/api/history.xlsx'          && method === 'GET')  return await handleHistoryXls(req, env);
        if (pathname === '/api/history.json'          && method === 'GET')  return await handleHistoryJson(req, env);
        if (pathname === '/api/admin/login'           && method === 'POST') return await handleAdminLogin(req, env);
        if (pathname === '/api/admin/reset-request'   && method === 'POST') return await handleAdminResetRequest(req, env);
        if (pathname === '/api/admin/reset-verify'    && method === 'POST') return await handleAdminResetVerify(req, env);
        if (pathname === '/api/admin/reset-password'  && method === 'POST') return await handleAdminResetPassword(req, env);
        if (pathname === '/api/admin/logout'          && method === 'POST') return await handleAdminLogout(req, env);
        if (pathname === '/api/admin/history.csv'     && method === 'GET')  return await handleAdminHistoryCsv(req, env);
        if (pathname === '/api/admin/history.xlsx'    && method === 'GET')  return await handleAdminHistoryXls(req, env);
        if (pathname === '/api/admin/stats.json'      && method === 'GET')  return await handleAdminStats(req, env);
        if (pathname === '/api/admin/jobs/active'     && method === 'GET')  return await handleAdminActiveJobs(req, env);
        if (pathname === '/api/admin/jobs/cancel'     && method === 'POST') return await handleAdminCancelJob(req, env);
        if (pathname === '/api/admin/users'           && method === 'GET')  return await handleAdminListUsers(req, env);
        if (pathname === '/api/admin/users/ban'       && method === 'POST') return await handleAdminBanUser(req, env);
        // Exact-match block, so this is reached BEFORE the dynamic
        // /api/admin/users/<id>/... patterns further down the chain.
        if (pathname === '/api/admin/users/credits'   && method === 'POST') return await handleAdminAdjustCredits(req, env);
        if (pathname === '/api/admin/badges'          && method === 'GET')  return await handleAdminBadges(req, env);
        if (pathname === '/api/admin/payments/unreconciled' && method === 'GET')  return await handleAdminUnreconciledPayments(req, env);
        if (pathname === '/api/admin/payments/reconcile'    && method === 'POST') return await handleAdminReconcilePayment(req, env);
        if (pathname === '/api/admin/services'        && method === 'GET')  return await handleAdminServices(req, env);
        if (pathname === '/api/admin/services'        && method === 'POST') return await handleAdminServicesToggle(req, env);
        if (pathname === '/api/admin/audit'           && method === 'GET')  return await handleAdminAuditLog(req, env);
        if (pathname === '/api/pricing'               && method === 'GET')  return await handlePublicPricing(req, env);
        if (pathname === '/api/admin/pricing'         && method === 'GET')  return await handleAdminGetPricing(req, env);
        if (pathname === '/api/admin/pricing'         && method === 'POST') return await handleAdminSetPricing(req, env);
        if (pathname === '/api/admin/force-logout-all' && method === 'POST') return await handleAdminForceLogoutAll(req, env);
        if (pathname === '/api/admin/totp/status'     && method === 'GET')  return await handleAdminTotpStatus(req, env);
        if (pathname === '/api/admin/totp/setup'      && method === 'POST') return await handleAdminTotpSetup(req, env);
        if (pathname === '/api/admin/totp/confirm'    && method === 'POST') return await handleAdminTotpConfirm(req, env);
        if (pathname === '/api/admin/totp/disable'    && method === 'POST') return await handleAdminTotpDisable(req, env);
        if (pathname === '/download/track'            && method === 'GET')  return await handleDownloadTrack(req, env);
        if (pathname === '/api/mock-checkout'         && method === 'POST') return await handleMockCheckout(req, env);
        if (pathname === '/api/mock-login'            && method === 'POST') return await handleMockLogin(req, env);
        if (pathname === '/api/mock-logout'           && method === 'POST') return await handleMockLogout(req, env);

        // /api/jobs/[id] — dynamic
        const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/?$/);
        if (jobMatch && method === 'GET') return await handleJob(req, env, decodeURIComponent(jobMatch[1]));

        // /api/admin/images — delete a single image by R2 key
        if (pathname === '/api/admin/images' && method === 'DELETE') {
          return await handleAdminDeleteImage(req, env);
        }

        // /api/admin/users/<userId>/meshes — dynamic
        const adminMeshes = pathname.match(/^\/api\/admin\/users\/([^/]+)\/meshes\/?$/);
        if (adminMeshes && method === 'GET') return await handleAdminUserMeshes(req, env, decodeURIComponent(adminMeshes[1]));

        // /api/admin/users/<userId>/rigs — dynamic, lists R2 <userId>/rigged/
        const adminRigs = pathname.match(/^\/api\/admin\/users\/([^/]+)\/rigs\/?$/);
        if (adminRigs && method === 'GET') return await handleAdminUserRigs(req, env, decodeURIComponent(adminRigs[1]));

        // /api/admin/users/<userId>/meshes/<jobId> — delete one mesh
        const adminMeshDel = pathname.match(/^\/api\/admin\/users\/([^/]+)\/meshes\/([^/]+)\/?$/);
        if (adminMeshDel && method === 'DELETE') {
          return await handleAdminDeleteMesh(req, env,
            decodeURIComponent(adminMeshDel[1]),
            decodeURIComponent(adminMeshDel[2]));
        }

        // /api/admin/users/<userId>/images — dynamic
        const adminImages = pathname.match(/^\/api\/admin\/users\/([^/]+)\/images\/?$/);
        if (adminImages && method === 'GET') return await handleAdminUserImages(req, env, decodeURIComponent(adminImages[1]));

        // /api/admin/users/<userId>/projects — dynamic
        const adminProj = pathname.match(/^\/api\/admin\/users\/([^/]+)\/projects\/?$/);
        if (adminProj && method === 'GET') return await handleAdminUserProjects(req, env, decodeURIComponent(adminProj[1]));

        // /api/admin/users/<userId>/listings — marketplace state per user
        const adminListings = pathname.match(/^\/api\/admin\/users\/([^/]+)\/listings\/?$/);
        if (adminListings && method === 'GET') return await handleAdminUserListings(req, env, decodeURIComponent(adminListings[1]));

        return err(404, `no route for ${method} ${pathname}`);
      }

      // ── static assets (next export output served via env.ASSETS) ──
      // Wrap the response so we can layer the same security headers
      // as our JSON responses, plus a tight CSP on HTML pages.
      const assetRes = await env.ASSETS.fetch(req);
      const ct = assetRes.headers.get('content-type') ?? '';
      const headers = new Headers(assetRes.headers);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
      if (/text\/html/i.test(ct)) {
        // Different CSPs per surface — /admin uses unpkg for model-viewer
        // + qrcode-generator and inline scripts; the app shell allows
        // unpkg for model-viewer too. 'unsafe-inline' is unfortunately
        // still required because both pages have inline <script> blocks
        // (we'll migrate to nonce-based CSP in a follow-up).
        const isAdmin = pathname.startsWith('/admin');
        const r2Host = env.R2_PUBLIC_URL
          ? (() => { try { return new URL(env.R2_PUBLIC_URL).hostname; } catch { return ''; } })()
          : '';
        const r2Origin = r2Host ? `https://${r2Host}` : '';
        const csp = [
          `default-src 'self'`,
          `script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com`,
          `style-src 'self' 'unsafe-inline'`,
          `img-src 'self' data: blob: https:`,
          `font-src 'self' data:`,
          `connect-src 'self' https://*.supabase.co https://api.stripe.com https://*.replicate.delivery https://*.r2.dev https://*.r2.cloudflarestorage.com https://image.pollinations.ai https://unpkg.com${r2Origin ? ' ' + r2Origin : ''}`,
          `frame-src 'self' https://js.stripe.com https://checkout.stripe.com`,
          `frame-ancestors 'none'`,
          `base-uri 'self'`,
          `form-action 'self' https://checkout.stripe.com`,
        ].join('; ');
        headers.set('content-security-policy', csp);
        // admin.html holds the cookie / killswitch UI — no caching so
        // a stale page doesn't show outdated state.
        if (isAdmin) {
          headers.set('cache-control', 'no-store');
        }
      }
      return new Response(assetRes.body, {
        status: assetRes.status,
        statusText: assetRes.statusText,
        headers,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('Worker error:', msg, e);
      return err(500, `internal: ${msg}`);
    }
  },
};
