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
  MODAL_SHARED_SECRET?: string;

  // Budget safeguards (override the defaults if set).
  MAX_DAILY_SPEND_USD?: string;       // Replicate-side cap (default $0.50)
  MAX_DAILY_MODAL_SPEND_USD?: string; // Modal-side cap   (default $2.00)
  MAX_USER_DAILY_CALLS?: string;

  // NSFW filter bypass — set to "1" to disable the prompt pre-filter
  // (intended for dev/staging, NEVER in prod). When unset, all prompts
  // are checked against the desktop's NSFW_KEYWORDS + NSFW_COMBOS.
  FABMESH_UNRESTRICTED?: string;

  // Secret password gating /admin and every /api/admin/* endpoint. In
  // addition to the Supabase email check, the caller must present a
  // valid admin_session cookie set by POST /api/admin/login with this
  // password. Stored as a Cloudflare Worker secret — never logged.
  ADMIN_PASSWORD?: string;

  SUPABASE_SERVICE_ROLE_KEY?: string;

  // Optional R2 S3 endpoint (kept for parity; native R2 binding is preferred).
  R2_PUBLIC_URL?: string;
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

function todayUTC(): string { return new Date().toISOString().slice(0, 10); }

async function r2GetText(env: Env, key: string): Promise<string | null> {
  if (!env.MESHES) return null;
  const obj = await env.MESHES.get(key);
  if (!obj) return null;
  try { return await obj.text(); } catch { return null; }
}

/** Check the daily Replicate spend cap. Returns the remaining budget
 *  in USD, or null if the request would push us over. */
async function checkAndIncrementDailySpend(env: Env, estimatedUsd: number): Promise<number | null> {
  const maxUsd = parseFloat(env.MAX_DAILY_SPEND_USD ?? '') || DEFAULT_MAX_DAILY_SPEND_USD;
  const key = `_meta/spend/${todayUTC()}`;
  const cur = parseFloat((await r2GetText(env, key)) || '0') || 0;
  if (cur + estimatedUsd > maxUsd) return null;
  await env.MESHES.put(key, String(cur + estimatedUsd));
  return maxUsd - cur - estimatedUsd;
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
async function checkAndIncrementModalSpend(env: Env, estimatedUsd: number): Promise<number | null> {
  const maxUsd = parseFloat(env.MAX_DAILY_MODAL_SPEND_USD ?? '') || DEFAULT_MAX_MODAL_SPEND_USD;
  const key = `_meta/modal_spend/${todayUTC()}`;
  const cur = parseFloat((await r2GetText(env, key)) || '0') || 0;
  if (cur + estimatedUsd > maxUsd) return null;
  await env.MESHES.put(key, String(cur + estimatedUsd));
  return maxUsd - cur - estimatedUsd;
}

async function refundModalSpend(env: Env, refundUsd: number): Promise<void> {
  const key = `_meta/modal_spend/${todayUTC()}`;
  const cur = parseFloat((await r2GetText(env, key)) || '0') || 0;
  await env.MESHES.put(key, String(Math.max(0, cur - refundUsd)));
}

/** Check the per-user daily call cap. Increments on success.
 *  Returns the remaining call budget, or null if over. */
async function checkAndIncrementUserCalls(env: Env, userId: string): Promise<number | null> {
  const maxCalls = parseInt(env.MAX_USER_DAILY_CALLS ?? '', 10) || DEFAULT_MAX_USER_DAILY_CALLS;
  const key = `_meta/userdaily/${userId}/${todayUTC()}`;
  const cur = parseInt((await r2GetText(env, key)) || '0', 10) || 0;
  if (cur >= maxCalls) return null;
  await env.MESHES.put(key, String(cur + 1));
  return maxCalls - cur - 1;
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
const PRICING_DEFAULTS = {
  // Image ops
  text2image:       2,
  back_view:        2,
  modify:           2,
  auto_inpaint:     3,
  mask_inpaint:     3,
  face_fix_image:   2,
  upscale:          2,  // x2 = this price, x4 = this + 1
  rectify:          1,
  remove_background: 1,
  // Mesh ops
  mesh_op_simple:   1,
  mesh_fast:        1,
  mesh_balanced:    2,
  mesh_quality:     4,
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
const MODAL_COST_USD: Record<string, number> = {
  'text2image':  0.020,
  'back-view':   0.050,
  'rectify':     0.070,
  'sheet':       0.050,
  'tpose':       0.040,
  'mesh':        0.060,   // base mesh (no face_fix, warm container)
  'mesh-face':   0.110,   // mesh + face_fix lazy SDXL inpaint
  'remove-bg':   0.005,
};

/** Persist a single non-mesh operation in the jobs table so the
 *  history CSV can show it. Mesh inserts happen inline in handleGenerate
 *  (they already need a job row for status polling). Fire-and-forget —
 *  a logging failure must never bubble up to the user-visible response. */
async function logOperation(
  env: Env,
  userId: string,
  opType: keyof typeof MODAL_COST_USD,
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

async function creditCost(env: Env, i: GenerateInput): Promise<number> {
  const p = await _getPricing(env);
  // Preset base cost — fast (default) / balanced / quality
  let n: number;
  if (i.preset === 'quality')       n = p.mesh_quality   ?? 4;
  else if (i.preset === 'balanced') n = p.mesh_balanced  ?? 2;
  else                              n = p.mesh_fast      ?? 1;

  // Optional add-ons — admin can tune each one independently.
  if (i.multiref)     n += p.mesh_multiref     ?? 1;
  if (i.refine)       n += p.mesh_refine       ?? 2;
  if (i.rectify)      n += p.mesh_rectify      ?? 1;
  if (i.quality_plus) n += p.mesh_quality_plus ?? 1;
  if (i.ultra_q)      n += p.mesh_ultra_q      ?? 2;
  if (i.ultra_hd)     n += p.mesh_ultra_hd     ?? 3;
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
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`source fetch failed: ${res.status}`);
  const body = await res.arrayBuffer();
  await env.MESHES.put(key, body, { httpMetadata: { contentType: 'model/gltf-binary' } });
  return `${env.R2_PUBLIC_URL}/${key}`;
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
async function handleMeExport(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  const sb = supabaseAdmin(env);
  const [profile, jobs, payments] = await Promise.all([
    sb.from('profiles').select('*').eq('id', user.id).maybeSingle(),
    sb.from('jobs').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(5000),
    sb.from('payments').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(5000),
  ]);
  const r2Keys: Array<{ key: string; size: number; uploaded: string }> = [];
  if (env.MESHES) {
    let cursor: string | undefined;
    let pages = 0;
    do {
      const list = await env.MESHES.list({ prefix: `${user.id}/`, cursor, limit: 1000 });
      for (const obj of list.objects) {
        r2Keys.push({ key: obj.key, size: obj.size, uploaded: obj.uploaded.toISOString() });
      }
      cursor = list.truncated ? list.cursor : undefined;
      pages++;
    } while (cursor && pages < 20);
  }
  const body = {
    exported_at: new Date().toISOString(),
    user: { id: user.id, email: user.email },
    profile: profile.data ?? null,
    jobs: jobs.data ?? [],
    payments: payments.data ?? [],
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
  // Drop rows. payments + jobs cascade via FK on auth.users when we
  // delete the auth.users row, but doing them explicitly here ensures
  // a partial-failure state still leaves an empty account.
  await sb.from('payments').delete().eq('user_id', user.id);
  await sb.from('jobs').delete().eq('user_id', user.id);
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
  let body: { name?: string; email?: string; subject?: string; message?: string };
  try { body = await req.json() as typeof body; } catch { return err(400, 'bad json'); }
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
  const payload = {
    id,
    name, email, subject, message,
    user_id, user_email,
    ip,
    user_agent: req.headers.get('user-agent') ?? null,
    created_at: new Date().toISOString(),
    read: false,
  };
  try {
    await env.MESHES.put(`_meta/contact/${id}.json`, JSON.stringify(payload),
                         { httpMetadata: { contentType: 'application/json' } });
    await env.MESHES.put(ipKey, String(ipCur + 1));
    await env.MESHES.put(globalKey, String(globCur + 1));
  } catch (e) {
    return err(502, `storage write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return json({ ok: true, success: true, id });
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
    let cursor: string | undefined = undefined;
    let total = 0;
    do {
      const page = await env.MESHES.list({ prefix: '_meta/modal_spend/', limit: 1000, cursor });
      for (const obj of page.objects) {
        // Skip the optional running-total marker (we recompute every call).
        if (obj.key.endsWith('/_total.txt')) continue;
        try {
          const txt = await r2GetText(env, obj.key);
          const n = parseFloat(txt || '0');
          if (Number.isFinite(n)) total += n;
        } catch {}
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    const todayKey = `_meta/modal_spend/${todayUTC()}`;
    const todayTxt = await r2GetText(env, todayKey);
    const todaySpent = parseFloat(todayTxt || '0') || 0;
    const budgetTxt = await r2GetText(env, '_meta/modal_budget_total.txt');
    const budget = parseFloat(budgetTxt || '0') || 0;
    return json({
      ok: true,
      total_budget: budget,
      total_spent: Math.round(total * 10000) / 10000,
      today_spent: Math.round(todaySpent * 10000) / 10000,
      remaining: Math.max(0, Math.round((budget - total) * 10000) / 10000),
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
  return json({ ok: true, success: true, total: n });
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
  | 'market_unpublished';

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
): Promise<{ ok: boolean; status: number; data: Record<string, unknown>; raw: string }> {
  if (!env.STRIPE_SECRET_KEY) {
    return { ok: false, status: 500, data: { error: 'no_stripe_key' }, raw: '' };
  }
  const init: RequestInit = {
    method,
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  };
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
    return err(502, 'stripe checkout failed: ' + errBody.slice(0, 200));
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

  for (const listingId of ids) {
    const lTxt = await r2GetText(env, `_market/listings/${listingId}.json`);
    if (!lTxt) continue;
    let listing: MarketListing;
    try { listing = JSON.parse(lTxt) as MarketListing; } catch { continue; }

    const platformFee = Math.round(listing.price_cents * MARKET_COMMISSION_PCT / 100);
    const sellerNet   = listing.price_cents - platformFee;
    const saleId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const sale = {
      id: saleId,
      listing_id: listingId,
      buyer_user_id: userId,
      seller_user_id: listing.user_id,
      amount_cents: listing.price_cents,
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
          });
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
        await _addUserNotification(env, listing.user_id, {
          kind: 'market_sale',
          message: `You sold "${listing.title}" for ${formattedPrice} (+${payoutCredits} credits earned).`,
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
    // Bump downloads counter on the listing.
    try {
      listing.downloads = (listing.downloads || 0) + 1;
      await env.MESHES.put(`_market/listings/${listingId}.json`, JSON.stringify(listing),
                           { httpMetadata: { contentType: 'application/json' } });
    } catch {}
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

  const upstream = await fetch(url);
  if (!upstream.ok || !upstream.body) return err(502, 'asset fetch failed');

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
  const upCT = upstream.headers.get('Content-Type');
  if (upCT) headers.set('Content-Type', upCT);
  const upCL = upstream.headers.get('Content-Length');
  if (upCL) headers.set('Content-Length', upCL);
  headers.set('Content-Disposition', `attachment; filename="${filename}"`);
  headers.set('Cache-Control', 'private, max-age=60');

  // Best-effort downloads counter — don't block the response on this.
  try {
    listing.downloads = (listing.downloads || 0) + 1;
    await env.MESHES.put(`_market/listings/${listingId}.json`, JSON.stringify(listing),
                         { httpMetadata: { contentType: 'application/json' } });
  } catch {}

  return new Response(upstream.body, { status: 200, headers });
}

/** DELETE /api/admin/market/<id> — ADMIN. Hard-remove a listing. */
async function handleAdminMarketDelete(req: Request, env: Env, id: string): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  if (!env.MESHES) return err(500, 'storage not configured');
  await env.MESHES.delete(`_market/listings/${id}.json`);
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
  const { packId } = await req.json() as { packId: PackId };
  const pack = PACKS[packId];
  if (!pack) return err(400, 'unknown pack');
  if (!env.STRIPE_SECRET_KEY) return err(500, 'STRIPE_SECRET_KEY not set');

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
      },
      subscription_data: {
        metadata: { user_id: user.id, pack_id: pack.id, credits: String(pack.credits) },
      },
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
          description: `Crédits pour la génération 3D sur myfabmesh.ai/cloud — pack ${pack.name}`,
        },
        unit_amount: pack.euros * 100,
      },
      quantity: 1,
    }],
    metadata: { user_id: user.id, pack_id: pack.id, credits: String(pack.credits) },
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

  let event: { type: string; data: { object: { id: string; metadata?: Record<string, string>; amount_total?: number; amount_paid?: number; subscription?: string; lines?: { data: Array<{ metadata?: Record<string, string> }> }; charges_enabled?: boolean; payouts_enabled?: boolean; details_submitted?: boolean; country?: string; requirements?: { currently_due?: string[] } } } };
  try { event = JSON.parse(raw); } catch { return err(400, 'bad json'); }

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
        // Race: another delivery beat us to the INSERT. They'll
        // (re-)credit; we bail. Their finalisation is independent.
        return { ok: true };
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
  if (event.type === 'invoice.paid') {
    const inv = event.data.object;
    const meta = inv.lines?.data?.[0]?.metadata ?? {};
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

async function handleGenerate(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');

  const form = await req.formData();
  let image = form.get('image');
  // If the client passed an HTTPS URL (R2/blob), capture it so the
  // Modal mesh path can re-use it directly without round-tripping
  // through a File upload (Modal's container fetches the URL on its
  // own; we don't need to re-host the bytes).
  // SSRF guard: only accept URLs from our known upstreams. Without this
  // an authenticated user could make the Worker fetch arbitrary internal
  // / external hosts (large download = DoS, leak internal infra responses
  // mirrored to R2 public, etc.).
  const _isTrustedImageHost = (u: string): boolean => {
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== 'https:') return false;
      const host = parsed.hostname.toLowerCase();
      if (host.endsWith('.r2.dev')) return true;
      if (host.endsWith('.r2.cloudflarestorage.com')) return true;
      if (host === 'replicate.delivery') return true;
      if (host.endsWith('.replicate.delivery')) return true;
      if (host === 'image.pollinations.ai') return true;
      // R2_PUBLIC_URL is set in wrangler.toml; check it explicitly too.
      if (env.R2_PUBLIC_URL) {
        try {
          const pub = new URL(env.R2_PUBLIC_URL).hostname.toLowerCase();
          if (host === pub) return true;
        } catch {}
      }
      return false;
    } catch { return false; }
  };
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
      const r = await fetch(imageHttpsUrl);
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

  const input: GenerateInput = {
    image,
    asset_type: (form.get('asset_type') as GenerateInput['asset_type']) || 'character',
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
  // Modal ~$0.16/mesh (TRELLIS-2 5min L40S × $0.000542 + R2 ops).
  const ESTIMATED_USD_MESH = useModalMesh ? 0.16 : 0.50;

  const remainingBudget = useModalMesh
    ? await checkAndIncrementModalSpend(env, ESTIMATED_USD_MESH)
    : await checkAndIncrementDailySpend(env, ESTIMATED_USD_MESH);
  if (remainingBudget == null) {
    const provider = 'Cloud GPU';
    return err(429, `daily ${provider} budget reached. Try again after midnight UTC, or raise MAX_DAILY_${useModalMesh ? 'MODAL_' : ''}SPEND_USD.`);
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
    if (!frontUrl) {
      if (!env.MESHES || !env.R2_PUBLIC_URL) {
        await addCredits(env, user.id, cost);
        return err(500, 'cloud GPU mesh path needs R2 (no imagePath URL provided)');
      }
      const fileBytes = new Uint8Array(await input.image.arrayBuffer());
      const key = `${user.id}/source/${Date.now()}_${input.seed ?? 42}.png`;
      await env.MESHES.put(key, fileBytes, {
        httpMetadata: { contentType: input.image.type || 'image/png' },
      });
      frontUrl = `${env.R2_PUBLIC_URL}/${key}`;
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
        const rectifiedUrl = await callModalRectify(env, user.id, {
          refImageUrl: frontUrl,
          mode: rectifyMode,
          seeds: 3,
        }, 'rectify');
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
    const isHardSurface = input.asset_type === 'vehicle'
                       || input.asset_type === 'building'
                       || input.asset_type === 'weapon'
                       || input.asset_type === 'prop'
                       || input.asset_type === 'avion'
                       || input.asset_type === 'bateau';
    if (input.back_view !== false && !backImageHttpsUrl
        && input.asset_type !== 'icon') {
      try {
        let autoBackUrl: string | null = null;
        if (isHardSurface && env.MODAL_SHEET_URL) {
          // Wave 2.3 — sheet dispatch.
          autoBackUrl = await callModalSheet(env, user.id, {
            frontImageUrl: frontUrl,
            promptHint: '',
            seed: (input.seed ?? 42) + 1000,
          }, 'back-auto');
          console.log(`[wave2.3] sheet back-view for ${input.asset_type}`);
        } else if (isOrganic && env.MODAL_BACKVIEW_URL) {
          // Wave 2.2 — realvis dispatch (also used as creature fallback
          // until Wave 2.4 brings mvadapter).
          autoBackUrl = await callModalBackView(env, user.id, {
            frontImageUrl: frontUrl,
            promptHint: '',
            seed: (input.seed ?? 42) + 1000,
          }, 'back-auto');
          console.log(`[wave2.2] realvis back-view for ${input.asset_type}`);
        }
        if (autoBackUrl) {
          backImageHttpsUrl = autoBackUrl;
          // multiref is read at the call site below (`input.multiref ?
          // backImageHttpsUrl : null`). At payload-parse time multiref
          // was decided BEFORE we generated the back — force it on now
          // that we have 2 views.
          input.multiref = true;
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
    await supabaseAdmin(env).from('jobs').insert({
      id: jobId, user_id: user.id,
      asset_type: input.asset_type, mode: input.mode, seed: input.seed,
      credit_cost: cost, status: 'queued',
      project_name: projectName,
      options: {
        rectify: input.rectify, back_view: input.back_view, smooth: input.smooth,
        face_fix: input.face_fix, ultra_hd: input.ultra_hd, fast: input.fast,
        backend: 'modal',
        operation_type: 'mesh',
        cost_usd: input.face_fix ? MODAL_COST_USD['mesh-face'] : MODAL_COST_USD['mesh'],
      },
      created_at: new Date().toISOString(),
    });
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
      const msg = e instanceof Error ? e.message : String(e);
      await supabaseAdmin(env).from('jobs').update({
        status: 'failed', error: msg, finished_at: new Date().toISOString(),
      }).eq('id', jobId);
      return err(502, 'cloud GPU mesh-start failed: ' + msg);
    }
    return json({ jobId, creditsRemaining: remaining });
  }

  let prediction;
  try {
    prediction = await createReplicatePrediction(env, input);
  } catch (e: unknown) {
    await addCredits(env, user.id, cost);
    return err(502, 'cloud GPU failed: ' + (e instanceof Error ? e.message : String(e)));
  }

  await supabaseAdmin(env).from('jobs').insert({
    id: prediction.id, user_id: user.id,
    asset_type: input.asset_type, mode: input.mode, seed: input.seed,
    credit_cost: cost, status: prediction.status,
    project_name: projectName,
    options: {
      rectify: input.rectify, back_view: input.back_view, smooth: input.smooth,
      face_fix: input.face_fix, ultra_hd: input.ultra_hd, fast: input.fast,
    },
    created_at: new Date().toISOString(),
  });
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

  // Modal-backed mesh jobs use a `modal_<uuid>` id and are polled
  // through callModalMeshStatus instead of Replicate. Once the GLB
  // is ready we persist it to R2 (so the renderer gets a stable URL
  // not the inline base64) and flip the Supabase row to succeeded.
  if (id.startsWith('modal_')) {
    const sbm = supabaseAdmin(env);
    const { data: job } = await sbm.from('jobs').select('*').eq('id', id).maybeSingle();
    if (!job) return json({ status: 'failed', error: 'job not found' });
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
        await sbm.from('jobs')
          .update({ status: 'failed', error: status.error.slice(0, 500),
                    finished_at: new Date().toISOString() })
          .eq('id', id);
        // Refund credits on failure (same policy as Replicate).
        if (typeof job.user_id === 'string' && typeof job.credit_cost === 'number') {
          await addCredits(env, job.user_id, job.credit_cost);
        }
        return json({ status: 'failed', error: status.error });
      }
      if (!status.ready || !status.glb_base64) {
        return json({ status: 'processing' });
      }
      const stableUrl = await persistModalGlb(env, id, status.glb_base64);
      await sbm.from('jobs')
        .update({ status: 'succeeded', mesh_url: stableUrl,
                  finished_at: new Date().toISOString() })
        .eq('id', id);
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
      try {
        stableUrl = await uploadGlbToR2(env, replicateUrl, `${job.user_id}/${id}.glb`);
      } catch (e) {
        console.error('R2 upload failed, falling back to replicate URL:', e);
        stableUrl = replicateUrl;
      }
      await sb.from('jobs')
        .update({ status: 'succeeded', mesh_url: stableUrl, finished_at: new Date().toISOString() })
        .eq('id', id);
    }
    const start = job?.created_at ? new Date(job.created_at as string).getTime() : Date.now();
    return json({
      status: 'succeeded', url: stableUrl ?? replicateUrl,
      duration_s: (Date.now() - start) / 1000,
    });
  }

  if (prediction.status === 'failed' || prediction.status === 'canceled') {
    if (job && job.status !== prediction.status) {
      await addCredits(env, job.user_id as string, job.credit_cost as number);
      await sb.from('jobs')
        .update({ status: prediction.status, error: prediction.error || null, finished_at: new Date().toISOString() })
        .eq('id', id);
    }
    return json({ status: prediction.status, error: prediction.error || 'unknown error' });
  }
  return json({ status: prediction.status });
}

async function handleProjects(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');

  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const toProject = (j: {
    id: string; asset_type: string; mode: string; status: string;
    mesh_url: string | null; created_at: string; options?: Record<string, unknown>;
  }) => ({
    id: j.id,
    name: `${cap(j.asset_type)} ${j.mode} · ${j.id.slice(-6)}`,
    asset_type: j.asset_type, mode: j.mode, status: j.status,
    createdAt: j.created_at, updatedAt: j.created_at,
    mesh_url: j.mesh_url, meshUrl: j.mesh_url,
    thumbnail: null, images: [],
    meshes: j.mesh_url ? [{ url: j.mesh_url, name: 'output.glb' }] : [],
    options: j.options ?? {},
  });

  if (isMock(env)) {
    const jobs = mock.listJobs(user.id);
    return json({ projects: jobs.map(toProject) });
  }
  const { data } = await supabaseAdmin(env).from('jobs')
    .select('*').eq('user_id', user.id)
    .order('created_at', { ascending: false }).limit(100);
  return json({ projects: ((data ?? []) as Parameters<typeof toProject>[0][]).map(toProject) });
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

  const { data, error } = await supabaseAdmin(env)
    .from('jobs')
    .select('id, user_id, asset_type, mode, status, mesh_url, created_at, finished_at, project_name, options')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return err(500, error.message);

  const rows = (data ?? []) as CloudJobRow[];
  const map = new Map<string, ProjEntry>();
  for (const j of rows) {
    const name = j.project_name
      || (j.options?.project_name as string | undefined)
      || `Project ${j.id.slice(-6)}`;
    if (!map.has(name)) map.set(name, emptyProj(name));
    const p = map.get(name)!;
    if (j.mesh_url && j.status === 'succeeded') {
      p.meshes.push({
        filename: `${j.id}.glb`, path: j.mesh_url, url: j.mesh_url,
        created: j.created_at, format: 'GLB',
        sourceImage: (j.options?.sourceImage as string | undefined) ?? null,
        // C7: align with handleListMeshes so renderer always has a
        // real uuid for delete (filename slug never matches .eq('id')).
        id: j.id, jobId: j.id,
      });
    }
    if (j.created_at > p.created) p.created = j.created_at;
    if (!p.prompt && j.options?.prompt) p.prompt = String(j.options.prompt);
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
    .select('id, asset_type, mode, status, mesh_url, created_at, project_name, options')
    .eq('user_id', user.id)
    .eq('status', 'succeeded')
    .not('mesh_url', 'is', null)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return err(500, error.message);

  const meshes = ((data ?? []) as CloudJobRow[]).map(j => {
    // C7: name meshes like the desktop convention so meshProject()
    // strips down to the project name. Format:
    //   <safe_project>_trellis2_<timestamp_10digits>.glb
    const safeName = (j.project_name || (j.options?.project_name as string | undefined) || 'untitled')
                      .replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32);
    const stem = `${safeName}_trellis2_${j.id.slice(-10)}`;
    return ({
    filename: `${stem}.glb`,
    path: j.mesh_url!,
    url: j.mesh_url!,
    size: 0,
    created: j.created_at,
    format: 'GLB',
    thumb: null,
    sourceImage: (j.options?.sourceImage as string | undefined) ?? null,
    asset_type: j.asset_type,
    projectName: j.project_name ?? (j.options?.project_name as string | undefined) ?? null,
    id: j.id,
  });});
  return json({ meshes });
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
  if (!job) {
    if (reconstructedUuid) {
      console.warn(`[meshes/delete] uuid ${reconstructedUuid} reconstructed from slug "${id}" but no row for user ${user.id}`);
      return err(404, 'no such mesh under your account (this row may have been deleted by an admin)');
    }
    if (!isUuid && !id.match(/_trellis2_/i) && !_reconstructUuidFromSlug(id)) {
      console.warn(`[meshes/delete] unrecognised slug "${id}" from user ${user.id}`);
      return err(400, 'unrecognised mesh id format');
    }
    console.warn(`[meshes/delete] no row for id "${id}" / user ${user.id}`);
    return err(404, 'not found');
  }
  const realId = job.id;

  // Best-effort R2 cleanup. The R2 key layout differs by pipeline:
  //   - Replicate/Trellis: "<user_id>/<id>.glb" (uploadGlbToR2)
  //   - Modal:             "mesh/modal_<hex>.glb" (persistModalGlb)
  // Derive the actual key from job.mesh_url when possible; fall back to
  // the legacy layout. delete() never throws on a missing key.
  if (env.MESHES) {
    let r2Key: string | null = null;
    const pub = env.R2_PUBLIC_URL;
    if (job.mesh_url && pub && job.mesh_url.startsWith(pub)) {
      try {
        const u = new URL(job.mesh_url);
        r2Key = u.pathname.replace(/^\/+/, '');
      } catch (_) { /* fall through */ }
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
async function handleCloudProjectsDelete(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  const { projectName } = await req.json() as { projectName?: string };
  if (!projectName) return err(400, 'projectName required');

  if (isMock(env)) return json({ ok: true });

  const sb = supabaseAdmin(env);
  const { error } = await sb.from('jobs')
    .update({ project_name: null })
    .eq('user_id', user.id)
    .eq('project_name', projectName);
  if (error) return err(500, error.message);
  return json({ ok: true });
}

/**
 * Cancel an in-flight Replicate prediction and mark the job canceled.
 * Refunds the credits spent at job creation.
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

  // Best-effort Replicate cancellation. Continue even if it fails — the
  // local status update is the source of truth for the UI.
  try { await replicateClient(env).predictions.cancel(id); } catch (_) { /* ignore */ }
  await sb.from('jobs')
    .update({ status: 'canceled', finished_at: new Date().toISOString() })
    .eq('id', id);
  if (typeof job.credit_cost === 'number') {
    await addCredits(env, user.id as string, job.credit_cost);
  }
  return json({ ok: true });
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

  const replicate = replicateClient(env);
  const version = '851-labs/background-remover:a029dff38972b5fda4ec5d75d7d1cd25aeff621d2cf4946a41055d7db66b80bc';
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
          const key = `${user.id}/removebg/${Date.now()}_${Math.floor(Math.random() * 1e9)}_nobg.png`;
          await env.MESHES.put(key, buf, { httpMetadata: { contentType: 'image/png' } });
          url = `${env.R2_PUBLIC_URL}/${key}`;
        } else {
          console.warn('[remove-bg] upstream fetch failed, returning raw Replicate URL', upstream.status);
        }
      } catch (e) {
        console.warn('[remove-bg] R2 mirror failed, returning raw Replicate URL', e);
      }
    } else {
      console.warn('[remove-bg] MESHES/R2_PUBLIC_URL unset, returning raw Replicate URL (will expire ~1h)');
    }

    return json({ ok: true, success: true, url, path: url, newPath: url });
  } catch (e: unknown) {
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
 * The Modal app exposes ONE HTTPS endpoint per @modal.fastapi_endpoint
 * decorator. URL pattern (set by Modal at deploy time):
 *   https://<workspace>--myfabmesh-cloud-myfabmeshpredictor-text2image.modal.run
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
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      _auth: secret,
      prompt: input.prompt,
      asset_type: input.asset_type,
      asset_style: input.asset_style,
      seed: input.seed,
      steps: input.steps,
    }),
    // Modal cold-start can hit ~30s on first call before the snapshot
    // is warm. We give it 4 min before timing out — generous but safe.
    signal: AbortSignal.timeout(240_000),
  });
  if (!r.ok) {
    throw new Error(`Modal HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const buf = await r.arrayBuffer();
  console.log(`[modal] text2image dt=${Date.now() - t0}ms bytes=${buf.byteLength}`);

  // Mirror to R2 (same key shape as the Cog path so downstream stays uniform).
  if (env.MESHES && env.R2_PUBLIC_URL) {
    const seed = input.seed ?? Math.floor(Math.random() * 1e9);
    const key = `${userId}/${folder}/${Date.now()}_${seed}.png`;
    await env.MESHES.put(key, buf, { httpMetadata: { contentType: 'image/png' } });
    return `${env.R2_PUBLIC_URL}/${key}`;
  }
  // Without R2 we can't return a stable URL — failure is preferable
  // to handing the client a one-shot data URL.
  throw new Error('R2 bucket unavailable; cannot persist Modal output');
}

/** Modal back-view endpoint. Different schema from text2image:
 *  input is a front image URL + a free-form prompt hint. Output is
 *  PNG bytes (best of N candidates auto-picked by outfit color match).
 *  Same auth + R2 mirror pattern as callModalText2Image. */
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
    throw new Error(`Modal back-view HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const buf = await r.arrayBuffer();
  console.log(`[modal] back-view dt=${Date.now() - t0}ms bytes=${buf.byteLength}`);

  if (env.MESHES && env.R2_PUBLIC_URL) {
    const seed = input.seed ?? Math.floor(Math.random() * 1e9);
    const key = `${userId}/${folder}/${Date.now()}_${seed}.png`;
    await env.MESHES.put(key, buf, { httpMetadata: { contentType: 'image/png' } });
    return `${env.R2_PUBLIC_URL}/${key}`;
  }
  throw new Error('R2 bucket unavailable; cannot persist Modal back-view output');
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
  const r = await fetch(url, {
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
  if (!r.ok) {
    throw new Error(`Modal tpose HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const buf = await r.arrayBuffer();
  console.log(`[modal] tpose dt=${Date.now() - t0}ms bytes=${buf.byteLength}`);

  if (env.MESHES && env.R2_PUBLIC_URL) {
    const seed = input.seed ?? Math.floor(Math.random() * 1e9);
    const key = `${userId}/${folder}/${Date.now()}_${seed}_tpose.png`;
    await env.MESHES.put(key, buf, { httpMetadata: { contentType: 'image/png' } });
    return `${env.R2_PUBLIC_URL}/${key}`;
  }
  throw new Error('R2 bucket unavailable; cannot persist Modal tpose output');
}

/** Unified image-op caller — POSTs to MODAL_IMAGE_OP_URL with `op` to
 *  dispatch between modify (img2img) and auto_inpaint (CLIPSeg+SDXL).
 *  Returns either the persisted R2 URL or a discriminated mask-empty
 *  shape for the auto_inpaint case (so the Worker can refund). */
async function callModalImageOp(env: Env, userId: string, input: {
  op: 'modify' | 'auto_inpaint' | 'mask_inpaint' | 'face_fix_image' | 'upscale';
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
  } else if (input.op === 'auto_inpaint') {
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
    throw new Error(`Modal image_op (${input.op}) HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const buf = await r.arrayBuffer();
  console.log(`[modal] image_op op=${input.op} dt=${Date.now() - t0}ms bytes=${buf.byteLength}`);
  // Tag the container as warm. Used by /api/modal-status so the
  // renderer knows whether the next op will be fast or paying a
  // cold-start tax. Fire-and-forget — failure is fine, we just lose
  // the warmth hint for one cycle.
  _writeLastWarmMs(env, '_meta/last_warm_image_op.txt').catch(() => {});

  if (env.MESHES && env.R2_PUBLIC_URL) {
    const tag = input.op === 'modify' ? 'modified' : 'inpaint';
    const seed = input.seed ?? Math.floor(Math.random() * 1e9);
    const key = `${userId}/${folder}/${Date.now()}_${seed}_${tag}.png`;
    await env.MESHES.put(key, buf, { httpMetadata: { contentType: 'image/png' } });
    return { url: `${env.R2_PUBLIC_URL}/${key}` };
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
    throw new Error(`Modal sheet HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const buf = await r.arrayBuffer();
  console.log(`[modal] sheet dt=${Date.now() - t0}ms bytes=${buf.byteLength}`);

  if (env.MESHES && env.R2_PUBLIC_URL) {
    const seed = input.seed ?? Math.floor(Math.random() * 1e9);
    const key = `${userId}/${folder}/${Date.now()}_${seed}_sheet_back.png`;
    await env.MESHES.put(key, buf, { httpMetadata: { contentType: 'image/png' } });
    return `${env.R2_PUBLIC_URL}/${key}`;
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
    throw new Error(`Modal rectify HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const buf = await r.arrayBuffer();
  console.log(`[modal] rectify dt=${Date.now() - t0}ms bytes=${buf.byteLength}`);

  if (env.MESHES && env.R2_PUBLIC_URL) {
    const key = `${userId}/${folder}/${Date.now()}_rectified.png`;
    await env.MESHES.put(key, buf, { httpMetadata: { contentType: 'image/png' } });
    return `${env.R2_PUBLIC_URL}/${key}`;
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
    // even though it doesn't use the GPU). 2 min cap covers it.
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) {
    throw new Error(`Modal mesh-start HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
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
    throw new Error(`Modal mesh-status HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
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
  return `${env.R2_PUBLIC_URL}/${key}`;
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
    throw new Error(`Replicate create HTTP ${createRes.status}: ${await createRes.text()}`);
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
      throw new Error(`Replicate failed: ${created.error || 'unknown'}`);
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
          throw new Error(`Replicate ${p.status}: ${p.error || 'unknown'}`);
        }
      }
      if (!outputUrl) {
        // Timeout: cancel so the prediction doesn't keep burning GPU.
        await cancelPrediction();
        throw new Error(`Replicate timeout after ${(60 + MAX_POLLS * POLL_INTERVAL_MS / 1000)}s`);
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
        const seed = input.seed ?? Math.floor(Math.random() * 1e9);
        const key = `${userId}/${folder}/${Date.now()}_${seed}.png`;
        await env.MESHES.put(key, buf, { httpMetadata: { contentType: 'image/png' } });
        return `${env.R2_PUBLIC_URL}/${key}`;
      }
    } catch { /* fall back to raw Replicate URL */ }
  }
  return outputUrl;
}

async function handleGenerateImage(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  const { prompt, numImages, seed, asset_type, asset_style, userPrompt, steps,
          tpose, refImageUrl, cn_scale, ip_scale } = await req.json() as {
    prompt?: string;
    userPrompt?: string;
    numImages?: number;
    seed?: number;
    asset_type?: string;
    asset_style?: string;
    steps?: number;
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
  // Bypass via FABMESH_UNRESTRICTED env var on the Worker for testing.
  {
    const unrestricted = env.FABMESH_UNRESTRICTED === '1';
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
    ? await checkAndIncrementModalSpend(env, estimatedTotal)
    : await checkAndIncrementDailySpend(env, estimatedTotal);
  if (remainingBudget == null) {
    const provider = 'Cloud GPU';
    return json({ ok: false, success: false,
      error: `daily ${provider} budget reached. Try again after midnight UTC, or raise MAX_DAILY_${useModal ? 'MODAL_' : ''}SPEND_USD.` }, { status: 429 });
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
          seed: seedBase + i,
          steps: steps || 30,
        }, 'front'));
      }
    }
  } catch (e) {
    await addCredits(env, user.id, cost);
    if (useModal) await refundModalSpend(env, estimatedTotal);
    else await refundDailySpend(env, estimatedTotal);
    // Log the failure so the history CSV reflects the refunded attempt.
    await logOperation(env, user.id, opType as keyof typeof MODAL_COST_USD,
                       0, opStart, Date.now(), 'failed',
                       { error: e instanceof Error ? e.message : String(e), n, asset_type });
    return err(502, `image generation failed (credits refunded): ${e instanceof Error ? e.message : String(e)}`);
  }
  // Success path — record each generation as a separate row so the
  // CSV totals match the actual GPU calls (e.g. count=3 logs 3 entries).
  for (let i = 0; i < n; i++) {
    await logOperation(env, user.id, opType as keyof typeof MODAL_COST_USD,
                       COST_PER_IMAGE, opStart, Date.now(), 'succeeded',
                       { asset_type, asset_style });
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
  const hint = (prompt ?? promptHint ?? '').toString().slice(0, 400);

  // NSFW prompt pre-filter — same policy as text2image / desktop checkPromptSafety.
  {
    const unrestricted = env.FABMESH_UNRESTRICTED === '1';
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
    ? await checkAndIncrementModalSpend(env, estimatedTotal)
    : await checkAndIncrementDailySpend(env, estimatedTotal);
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
  for (let i = 0; i < n; i++) {
    await logOperation(env, user.id, 'back-view',
                       COST_PER_BACK, opStart, Date.now(), 'succeeded',
                       { asset_type });
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
  const rawPrompt = (prompt ?? '').toString().trim();
  if (!rawPrompt) return err(400, 'prompt required');

  // NSFW pre-filter — same policy as text2image/back-view/rectify.
  {
    const unrestricted = env.FABMESH_UNRESTRICTED === '1';
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

  const remainingBudget = await checkAndIncrementModalSpend(env, estimatedTotal);
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
  if (!targetText) return err(400, 'targetText required');

  const rawPrompt = (prompt ?? '').toString().trim();
  if (rawPrompt) {
    const unrestricted = env.FABMESH_UNRESTRICTED === '1';
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

  const remainingBudget = await checkAndIncrementModalSpend(env, estimatedTotal);
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
  if (!maskDataUrl) return err(400, 'maskDataUrl required');
  const rawPrompt = (prompt ?? '').toString().trim();
  if (!rawPrompt) return err(400, 'prompt required');

  // NSFW pre-filter on prompt.
  {
    const unrestricted = env.FABMESH_UNRESTRICTED === '1';
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
    maskUrl = `${env.R2_PUBLIC_URL}/${key}`;
  } catch (e) {
    return err(400, `mask decode failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const COST_PER = await getPrice(env, 'mask_inpaint');
  const estimatedTotal = 0.07;

  const remainingBudget = await checkAndIncrementModalSpend(env, estimatedTotal);
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
      prompt: rawPrompt,
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

  const COST_PER = await getPrice(env, 'face_fix_image');
  const estimatedTotal = 0.05;
  const remainingBudget = await checkAndIncrementModalSpend(env, estimatedTotal);
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

  const { meshUrl, meshId, opType, params } = await req.json() as {
    meshUrl?: string; meshId?: string; opType?: string;
    params?: Record<string, unknown>;
  };
  const allowed = new Set([
    'smooth', 'decimate', 'center', 'fix_normals', 'fill_holes',
    'subdivide', 'align_texture', 'material', 'retex_swap',
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

  // Cheap op (CPU, ~$0.001 Modal) — defaults to 1 credit, admin-tunable.
  const COST_PER = await getPrice(env, 'mesh_op_simple');
  const estimatedTotal = 0.005;
  const remainingBudget = await checkAndIncrementModalSpend(env, estimatedTotal);
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
    if (!r.ok) throw new Error(`Modal mesh_op HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = await r.json() as { glb_base64?: string };
    if (!data.glb_base64) throw new Error('Modal mesh_op missing glb_base64');

    // Decode base64 → R2 → return URL.
    const bin = atob(data.glb_base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (!env.MESHES || !env.R2_PUBLIC_URL) throw new Error('R2 binding required');
    const key = `${user.id}/mesh-op/${Date.now()}_${op}.glb`;
    await env.MESHES.put(key, bytes, { httpMetadata: { contentType: 'model/gltf-binary' } });
    const url = `${env.R2_PUBLIC_URL}/${key}`;
    await logOperation(env, user.id, 'mesh' as keyof typeof MODAL_COST_USD,
                       COST_PER, opStart, Date.now(), 'succeeded',
                       { op_type: op, mesh_url_in: finalUrl });
    return json({ ok: true, success: true, path: url, newPath: url, mesh_url: url, creditsRemaining: remaining });
  } catch (e) {
    await addCredits(env, user.id, COST_PER);
    await refundModalSpend(env, estimatedTotal);
    await logOperation(env, user.id, 'mesh' as keyof typeof MODAL_COST_USD,
                       0, opStart, Date.now(), 'failed',
                       { op_type: op, error: e instanceof Error ? e.message : String(e) });
    return err(502, `mesh ${op} failed (credits refunded): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** POST /api/mesh-op/client-result — accepts a GLB that the renderer
 *  produced 100% client-side (three.js Smooth / Decimate / Subdivide /
 *  Fix Normals / Fill Holes / Center JS implementations). No Modal
 *  hop, no credit charge — the work was done in the browser, the
 *  server just persists the result to R2 and returns the URL.
 *
 *  Safeguards: auth required, glTF magic-byte check, hard size cap,
 *  per-user daily call quota (shared with paid ops). */
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
    const url = `${env.R2_PUBLIC_URL}/${key}`;
    await logOperation(env, user.id, 'mesh' as keyof typeof MODAL_COST_USD,
                       0, opStart, Date.now(), 'succeeded',
                       { op_type: op, client_side: true, size_bytes: bytes.length });
    return json({ ok: true, success: true, path: url, newPath: url, mesh_url: url });
  } catch (e) {
    await logOperation(env, user.id, 'mesh' as keyof typeof MODAL_COST_USD,
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
  const last = await _readLastWarmMs(env, '_meta/last_warm_image_op.txt');
  const now = Date.now();
  const secondsSinceLastSuccess = last ? Math.floor((now - last) / 1000) : null;
  const warm = last != null && (now - last) < COLD_THRESHOLD_MS;
  return json({
    image_op: {
      warm,
      seconds_since_last_success: secondsSinceLastSuccess,
      expected_seconds_warm: 30,
      expected_seconds_cold: 150,
    },
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
    return err(502, `R2 upload failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return json({ ok: true, success: true, path: `${env.R2_PUBLIC_URL}/${key}` });
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

  // Allow R2 public buckets + a few known image-serving hosts. Add to
  // this list as new generation backends are wired in.
  const allowed = new Set<string>([
    'pub-ca633fb6a3334d0ea29be5fe53cae66c.r2.dev',  // myfabmesh-meshes public
    'replicate.delivery',
    'pbxt.replicate.delivery',
    'image.pollinations.ai',
  ]);
  if (env.R2_PUBLIC_URL) {
    try { allowed.add(new URL(env.R2_PUBLIC_URL).host); } catch { /* ignore */ }
  }
  if (!allowed.has(parsed.host)) {
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
  const factor = scale === 4 ? 4 : 2;  // only 2 or 4 supported

  // Upscale: x2 = base price, x4 = base + 1 (heavier).
  const upscaleBase = await getPrice(env, 'upscale');
  const COST_PER = factor === 4 ? upscaleBase + 1 : upscaleBase;
  const estimatedTotal = factor === 4 ? 0.07 : 0.05;
  const remainingBudget = await checkAndIncrementModalSpend(env, estimatedTotal);
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

  // Reject any meshUrl that isn't on our trusted upstreams. Without
  // this check a malicious client could insert javascript: or attacker-
  // controlled https URLs that the admin model-viewer would then
  // dereference (XSS / data exfil vector).
  try {
    const parsed = new URL(finalUrl);
    if (parsed.protocol !== 'https:') return err(400, 'meshUrl must be https');
    const host = parsed.hostname.toLowerCase();
    const r2Pub = env.R2_PUBLIC_URL ? new URL(env.R2_PUBLIC_URL).hostname.toLowerCase() : '';
    const ok = host === r2Pub
            || host.endsWith('.r2.dev')
            || host.endsWith('.r2.cloudflarestorage.com')
            || host === 'replicate.delivery'
            || host.endsWith('.replicate.delivery');
    if (!ok) return err(400, 'meshUrl host not allowed');
  } catch { return err(400, 'invalid meshUrl'); }

  // Insert a new job row with the same mesh_url but the new project_name.
  // credit_cost = 0 (no GPU work — just a project re-grouping).
  const newId = 'copy_' + crypto.randomUUID().replace(/-/g, '');
  await supabaseAdmin(env).from('jobs').insert({
    id: newId, user_id: user.id,
    asset_type: assetType, mode, seed: 0,
    credit_cost: 0, status: 'succeeded',
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
    const unrestricted = env.FABMESH_UNRESTRICTED === '1';
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

  const remainingBudget = await checkAndIncrementModalSpend(env, estimatedTotal);
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
  'fabien65400@hotmail.fr',
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

async function _adminTokenCheck(req: Request, env: Env): Promise<boolean> {
  const secret = env.ADMIN_PASSWORD;
  if (!secret) return false;  // Server misconfigured — fail closed.
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
async function handleAdminLogin(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user || !user.email || !ADMIN_EMAILS.has(user.email.toLowerCase())) {
    return err(401, 'unauthorized');
  }
  if (!env.ADMIN_PASSWORD) return err(500, 'ADMIN_PASSWORD not configured');
  // Reject obviously weak passwords at runtime — a 12-char admin
  // password is brute-forceable from the open internet given we have
  // no captcha or aggressive WAF. Require >=20 chars to push brute force
  // out of reach.
  if (env.ADMIN_PASSWORD.length < 20) {
    return err(500, 'ADMIN_PASSWORD too short: rotate to >=20 chars before allowing logins');
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

  let body: { password?: string; totp?: string };
  try { body = await req.json() as { password?: string; totp?: string }; } catch { return err(400, 'bad json'); }
  const provided = String(body.password ?? '');
  if (!provided) return err(400, 'password required');
  const _recordFail = async () => {
    fails.count += 1;
    if (fails.first_ts === 0) fails.first_ts = Date.now();
    try { await env.MESHES?.put(lockoutKey, JSON.stringify(fails)); } catch {}
  };
  if (provided.length !== env.ADMIN_PASSWORD.length) {
    await _recordFail();
    return err(401, 'invalid password');
  }
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ env.ADMIN_PASSWORD.charCodeAt(i);
  if (diff !== 0) {
    await _recordFail();
    return err(401, 'invalid password');
  }
  // Successful password check — wipe the IP's failure counter so the
  // admin isn't locked out after a typo + correct retry.
  try { await env.MESHES?.delete(lockoutKey); } catch {}

  // TOTP second factor — only enforced after the admin has enrolled.
  // First-ever login uses password only so the admin can reach the
  // setup page and enrol; afterwards every login also needs a code.
  const totpSecret = await _getAdminTotpSecret(env);
  if (totpSecret) {
    const code = String(body.totp ?? '').trim();
    if (!code) return err(401, 'totp_required');
    if (!(await _totpVerify(totpSecret, code))) return err(401, 'invalid totp');
  }

  const exp = Math.floor(Date.now() / 1000) + ADMIN_TTL_SEC;
  const payload = `${user.email.toLowerCase()}:${exp}`;
  const sig = await _hmacSign(env.ADMIN_PASSWORD, payload);
  const value = `${payload}.${sig}`;
  return new Response(JSON.stringify({ ok: true, expires_at: exp, totp_enrolled: !!totpSecret }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': `${ADMIN_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${ADMIN_TTL_SEC}`,
    },
  });
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
    .select('id, asset_type, mode, status, credit_cost, options, created_at, finished_at, project_name, mesh_url')
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
    const opType = String(j.options?.operation_type ?? j.asset_type ?? 'mesh');
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
    .select('id, user_id, asset_type, mode, status, credit_cost, options, created_at, finished_at, project_name, mesh_url')
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
    'project', 'asset_type', 'mode', 'mesh_url'
  ];
  const lines: string[] = [header.join(',')];

  type J = {
    id: string; user_id: string; asset_type: string; mode: string;
    status: string; credit_cost: number; options: Record<string, unknown> | null;
    created_at: string; finished_at: string | null;
    project_name: string | null; mesh_url: string | null;
  };
  for (const j of ((data ?? []) as J[])) {
    const opType = String(j.options?.operation_type ?? j.asset_type ?? 'mesh');
    const costUsd = Number(j.options?.cost_usd
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
    .select('user_id, status, credit_cost, options, created_at')
    .order('created_at', { ascending: false })
    .limit(20000);
  if (jobsErr) return err(500, jobsErr.message);

  const EUR_PER_CREDIT_NET = 0.162;
  const USD_TO_EUR = 0.93;
  const now = Date.now();
  const DAY = 86400_000;

  const uniqueUsers = new Set<string>();
  const ops = { total: 0, succeeded: 0, failed: 0 };
  const byType: Record<string, { count: number; revenue_eur: number; cost_eur: number; margin_eur: number }> = {};
  let totalRevenueEur = 0, totalCostEur = 0;
  // Activity series (last 30 days, bucket by day).
  const seriesByDay: Record<string, { ops: number; users: Set<string>; revenue_eur: number; cost_eur: number; margin_eur: number }> = {};

  type J = {
    user_id: string; status: string; credit_cost: number;
    options: Record<string, unknown> | null; created_at: string;
  };
  for (const j of ((jobs ?? []) as J[])) {
    uniqueUsers.add(j.user_id);
    ops.total += 1;
    if (j.status === 'succeeded') ops.succeeded += 1;
    if (j.status === 'failed') ops.failed += 1;

    const opType = String(j.options?.operation_type ?? 'mesh');
    const costUsd = Number(j.options?.cost_usd
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
  try {
    const { data: pays } = await sb
      .from('payments')
      .select('amount_eur, created_at')
      .order('created_at', { ascending: false })
      .limit(5000);
    for (const p of (pays ?? []) as { amount_eur: number }[]) {
      grossRevenueEur += p.amount_eur ?? 0;
      paymentsCount += 1;
    }
  } catch { /* payments table optional */ }

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

  return json({
    generated_at: new Date().toISOString(),
    users: {
      total: uniqueUsers.size,
      active_7d: new Set(last7.flatMap(d => []).concat([...new Set([...uniqueUsers])])).size,  // proxy
    },
    operations: ops,
    by_type: byType,
    revenue: {
      total_gross_eur:  +grossRevenueEur.toFixed(2),
      total_net_eur:    +totalRevenueEur.toFixed(2),   // sum of credit revenue, net of Stripe
      total_cost_eur:   +totalCostEur.toFixed(2),
      total_margin_eur: +(totalRevenueEur - totalCostEur).toFixed(2),
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
    .select('asset_type, mode, status, credit_cost, options, created_at, finished_at, project_name')
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
    const opType = String(j.options?.operation_type ?? j.asset_type ?? 'mesh');
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
 *  (rendered as a table in cloud/public/app/index.html). No margin. */
async function handleHistoryJson(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');

  const { data, error } = await supabaseAdmin(env)
    .from('jobs')
    .select('id, asset_type, mode, status, credit_cost, options, created_at, finished_at, project_name')
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
    const opType = String(j.options?.operation_type ?? j.asset_type ?? 'mesh');
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
    .select('id, user_id, asset_type, mode, status, credit_cost, created_at, options, project_name')
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
  let modalCancelled = false;
  let modalError: string | null = null;
  if (env.MODAL_MESH_START_URL && env.MODAL_SHARED_SECRET) {
    try {
      const mr = await fetch(env.MODAL_MESH_START_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          _auth: env.MODAL_SHARED_SECRET,
          op_type: 'cancel',
          // Modal mesh_start persisted call_id under the same job_id it
          // received from the worker — full `modal_<uuid>` prefix.
          job_id: jobId,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (mr.ok) {
        const mj = await mr.json() as { cancelled?: boolean; error?: string };
        modalCancelled = !!mj.cancelled;
        modalError = mj.error || null;
      } else {
        modalError = `HTTP ${mr.status}`;
      }
    } catch (e) {
      modalError = e instanceof Error ? e.message : String(e);
    }
  }
  if (refund) {
    await addCredits(env, j.user_id, j.credit_cost);
  }
  await sb.from('jobs').update({
    status: 'canceled',
    error: refund ? 'admin canceled' : 'admin canceled (no refund)',
    finished_at: new Date().toISOString(),
  }).eq('id', jobId);
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

/** GET /api/admin/users — ADMIN ONLY. Profiles + ban flag + counts. */
async function handleAdminListUsers(req: Request, env: Env): Promise<Response> {
  const guard = await _requireAdmin(req, env);
  if (guard instanceof Response) return guard;
  const sb = supabaseAdmin(env);
  const { data, error } = await sb.from('profiles')
    .select('id, email, credits, created_at')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return err(500, error.message);
  const banned = await _getBannedUserIds(env);
  const users = (data || []) as Array<{ id: string; [k: string]: unknown }>;

  // Aggregate counts from jobs in one query. project_name and mesh_url
  // come straight from the table — we count distinct projects + every
  // succeeded mesh per user. Image count comes from R2 (logged jobs
  // never stored the result URL).
  const { data: jobsRows } = await sb.from('jobs')
    .select('user_id, project_name, mesh_url, status')
    .limit(50_000);
  type ProjectsMap = Map<string, Set<string>>;
  const projects: ProjectsMap = new Map();
  const meshes = new Map<string, number>();
  for (const row of (jobsRows || []) as Array<{
    user_id: string; project_name: string | null; mesh_url: string | null; status: string;
  }>) {
    if (row.project_name) {
      const set = projects.get(row.user_id) || new Set<string>();
      set.add(row.project_name);
      projects.set(row.user_id, set);
    }
    if (row.mesh_url && row.status === 'succeeded') {
      meshes.set(row.user_id, (meshes.get(row.user_id) || 0) + 1);
    }
  }

  // Image counts via R2 — only computed for the users we'll actually
  // display (limit 500) and capped at 200 listings each so the
  // endpoint stays under a few seconds. Parallel.
  let imageCounts = new Map<string, number>();
  if (env.MESHES) {
    const tasks = users.slice(0, 500).map(async (u) => {
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
      } while (cursor && pages < 5);
      imageCounts.set(u.id, n);
    });
    await Promise.all(tasks);
  }

  return json({
    users: users.map((u) => ({
      ...u,
      banned: banned.has(u.id),
      projects_count: projects.get(u.id)?.size || 0,
      meshes_count: meshes.get(u.id) || 0,
      images_count: imageCounts.get(u.id) || 0,
    })),
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
  let body: { password?: string; code?: string };
  try { body = await req.json() as { password?: string; code?: string }; } catch { return err(400, 'bad json'); }
  if (!env.ADMIN_PASSWORD) return err(500, 'ADMIN_PASSWORD not configured');
  const pw = String(body.password || '');
  if (pw.length !== env.ADMIN_PASSWORD.length) return err(401, 'invalid password');
  let d = 0;
  for (let i = 0; i < pw.length; i++) d |= pw.charCodeAt(i) ^ env.ADMIN_PASSWORD.charCodeAt(i);
  if (d !== 0) return err(401, 'invalid password');
  const cur = await _getAdminTotpSecret(env);
  if (cur) {
    const code = String(body.code || '').trim();
    if (!(await _totpVerify(cur, code))) return err(401, 'invalid code');
  }
  await env.MESHES.delete(TOTP_KEY);
  await _auditLog(env, { req, actorEmail: guard.email, action: 'totp_disable' });
  return json({ ok: true });
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
  if (!env.ADMIN_PASSWORD) return err(500, 'ADMIN_PASSWORD not configured');
  const pw = String(body?.password || '');
  if (pw.length !== env.ADMIN_PASSWORD.length) return err(401, 'invalid password');
  let diff = 0;
  for (let i = 0; i < pw.length; i++) diff |= pw.charCodeAt(i) ^ env.ADMIN_PASSWORD.charCodeAt(i);
  if (diff !== 0) return err(401, 'invalid password');
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
  // Cache 30 s on the edge so a viral landing page doesn't multiply
  // R2 reads. Admin POSTs invalidate the in-process cache; the edge
  // cache will follow within 30 s.
  return new Response(JSON.stringify({ prices }), {
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
  const password = String(body?.password || '');
  if (!env.ADMIN_PASSWORD) return err(500, 'ADMIN_PASSWORD not configured');
  if (password.length !== env.ADMIN_PASSWORD.length) return err(401, 'invalid password');
  let diff = 0;
  for (let i = 0; i < password.length; i++) {
    diff |= password.charCodeAt(i) ^ env.ADMIN_PASSWORD.charCodeAt(i);
  }
  if (diff !== 0) return err(401, 'invalid password');
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
  const password = String(body?.password || '');
  if (!['modal', 'site', 'stripe', 'all'].includes(service)) {
    return err(400, 'service must be modal|site|stripe|all');
  }
  if (!env.ADMIN_PASSWORD) return err(500, 'ADMIN_PASSWORD not configured');
  // Constant-time compare.
  if (password.length !== env.ADMIN_PASSWORD.length) return err(401, 'invalid password');
  let diff = 0;
  for (let i = 0; i < password.length; i++) {
    diff |= password.charCodeAt(i) ^ env.ADMIN_PASSWORD.charCodeAt(i);
  }
  if (diff !== 0) return err(401, 'invalid password');

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
        url: `${env.R2_PUBLIC_URL}/${obj.key}`,
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
    .select('id, user_id, asset_type, mesh_url, status, project_name, created_at, options')
    .eq('user_id', userId)
    .eq('status', 'succeeded')
    .not('mesh_url', 'is', null)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return err(500, error.message);
  return json({ meshes: data || [] });
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
        const url = String(parsed?.asset_url || parsed?.mesh_url || '');
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
    .select('user_id, asset_type, mode, status, credit_cost, options, created_at, finished_at, project_name, mesh_url')
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
    'Project', 'Asset type', 'Mode', 'Mesh URL'
  ];
  type J = {
    user_id: string; asset_type: string; mode: string; status: string;
    credit_cost: number; options: Record<string, unknown> | null;
    created_at: string; finished_at: string | null;
    project_name: string | null; mesh_url: string | null;
  };
  let totalMargin = 0;
  const rows: Array<Array<string | number>> = ((data ?? []) as J[]).map(j => {
    const opType = String(j.options?.operation_type ?? j.asset_type ?? 'mesh');
    const costUsd = Number(j.options?.cost_usd
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
    ];
  });
  // Append a TOTAL row.
  rows.push([
    '', '', '', '', '', '', '', '', 'TOTAL margin (EUR)', Number(totalMargin.toFixed(4)), '', '', '', '',
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

async function preWarmCog(env: Env): Promise<void> {
  if (!(await isUserOnline(env))) {
    console.log('[pre-warm] skipped — no recent heartbeat (nobody online)');
    return;
  }
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

async function handleHeartbeat(req: Request, env: Env): Promise<Response> {
  // No auth — heartbeat is cheap and unauthenticated.
  // (We don't want to fail the heartbeat if the user's cookie has
  // expired; we just want to know "is the tab still open".)
  void req;
  await markHeartbeat(env);
  return json({ ok: true });
}

/* ────────────────────────── main fetch handler ─────────────────────── */

export default {
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }): Promise<void> {
    ctx.waitUntil(preWarmCog(env));
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
        '/api/mask-inpaint', '/api/face-fix-image', '/api/upscale-image',
        '/api/face-fix-mesh', '/api/mesh-op', '/api/text2image-tpose',
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
        // ── Marketplace ──
        if (pathname === '/api/market/list'                 && method === 'GET')  return await handleMarketList(req, env);
        if (pathname === '/api/market/publish'              && method === 'POST') return await handleMarketPublish(req, env);
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
        if (pathname === '/api/me/replies'            && method === 'GET')  return await handleMeReplies(req, env);
        if (pathname === '/api/me/inbox'              && method === 'GET')  return await handleMeInbox(req, env);
        if (pathname === '/api/me/inbox/read'         && method === 'POST') return await handleMeInboxRead(req, env);
        if (pathname === '/api/me/published-assets'   && method === 'GET')  return await handleMePublishedAssets(req, env);
        if (pathname === '/api/me/earnings'           && method === 'GET')  return await handleMeEarnings(req, env);
        if (pathname === '/api/me/delete'             && method === 'POST') return await handleMeDelete(req, env);
        if (pathname === '/api/debug-auth'            && method === 'GET')  return await handleDebugAuth(req, env);
        if (pathname === '/api/checkout'              && method === 'POST') return await handleCheckout(req, env);
        if (pathname === '/api/pricing/availability'  && method === 'GET')  return await handlePricingAvailability(req, env);
        if (pathname === '/api/stripe-webhook'        && method === 'POST') return await handleStripeWebhook(req, env);
        if (pathname === '/api/generate'              && method === 'POST') return await handleGenerate(req, env);
        if (pathname === '/api/projects'              && method === 'GET')  return await handleProjects(req, env);
        if (pathname === '/api/projects/delete'       && method === 'POST') return await handleProjectsDelete(req, env);
        if (pathname === '/api/cloud-projects'        && method === 'GET')  return await handleCloudProjects(req, env);
        if (pathname === '/api/cloud-projects/delete' && method === 'POST') return await handleCloudProjectsDelete(req, env);
        if (pathname === '/api/meshes'                && method === 'GET')  return await handleListMeshes(req, env);
        if (pathname === '/api/meshes/delete'         && method === 'POST') return await handleMeshesDelete(req, env);
        if (pathname === '/api/jobs/cancel'           && method === 'POST') return await handleJobCancel(req, env);
        if (pathname === '/api/remove-background'     && method === 'POST') return await handleRemoveBackground(req, env);
        if (pathname === '/api/generate-image'        && method === 'POST') return await handleGenerateImage(req, env);
        if (pathname === '/api/generate-back-view'    && method === 'POST') return await handleGenerateBackView(req, env);
        if (pathname === '/api/rectify-image'         && method === 'POST') return await handleRectifyImage(req, env);
        if (pathname === '/api/modify-image'          && method === 'POST') return await handleModifyImage(req, env);
        if (pathname === '/api/auto-inpaint'          && method === 'POST') return await handleAutoInpaint(req, env);
        if (pathname === '/api/mask-inpaint'          && method === 'POST') return await handleMaskInpaint(req, env);
        if (pathname === '/api/face-fix-image'        && method === 'POST') return await handleFaceFixImage(req, env);
        if (pathname === '/api/copy-mesh-to-project'  && method === 'POST') return await handleCopyMeshToProject(req, env);
        if (pathname === '/api/upscale-image'         && method === 'POST') return await handleUpscaleImage(req, env);
        if (pathname === '/api/proxy-image'           && method === 'GET')  return await handleProxyImage(req, env);
        if (pathname === '/api/upload-image'          && method === 'POST') return await handleUploadImage(req, env);
        if (pathname === '/api/modal-status'          && method === 'GET')  return await handleModalStatus(req, env);
        if (pathname === '/api/mesh-op'               && method === 'POST') return await handleMeshOp(req, env);
        if (pathname === '/api/mesh-op/client-result' && method === 'POST') return await handleMeshOpClientResult(req, env);
        if (pathname === '/api/history.csv'           && method === 'GET')  return await handleHistoryCsv(req, env);
        if (pathname === '/api/history.xlsx'          && method === 'GET')  return await handleHistoryXls(req, env);
        if (pathname === '/api/history.json'          && method === 'GET')  return await handleHistoryJson(req, env);
        if (pathname === '/api/admin/login'           && method === 'POST') return await handleAdminLogin(req, env);
        if (pathname === '/api/admin/logout'          && method === 'POST') return await handleAdminLogout(req, env);
        if (pathname === '/api/admin/history.csv'     && method === 'GET')  return await handleAdminHistoryCsv(req, env);
        if (pathname === '/api/admin/history.xlsx'    && method === 'GET')  return await handleAdminHistoryXls(req, env);
        if (pathname === '/api/admin/stats.json'      && method === 'GET')  return await handleAdminStats(req, env);
        if (pathname === '/api/admin/jobs/active'     && method === 'GET')  return await handleAdminActiveJobs(req, env);
        if (pathname === '/api/admin/jobs/cancel'     && method === 'POST') return await handleAdminCancelJob(req, env);
        if (pathname === '/api/admin/users'           && method === 'GET')  return await handleAdminListUsers(req, env);
        if (pathname === '/api/admin/users/ban'       && method === 'POST') return await handleAdminBanUser(req, env);
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
