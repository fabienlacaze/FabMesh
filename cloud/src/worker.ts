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

const json = (data: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers ?? {}) },
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
function readSupabaseAccessToken(req: Request): string | null {
  const cookies = parseCookies(req);
  const keys = Object.keys(cookies).filter(k => /^sb-[^-]+-auth-token(?:\.\d+)?$/.test(k));
  if (!keys.length) return null;
  keys.sort();
  let raw = keys.map(k => cookies[k]).join('');
  if (raw.startsWith('base64-')) raw = raw.slice(7);
  try {
    // Some chunks may already be JSON; try direct parse first.
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

  // Validate token against Supabase Auth (cheap call, returns the user).
  const meRes = await fetch(`${url}/auth/v1/user`, {
    headers: { 'authorization': `Bearer ${token}`, 'apikey': anon },
  });
  if (!meRes.ok) return null;
  const me = await meRes.json() as { id?: string; email?: string };
  if (!me.id) return null;

  // Fetch credit balance from the admin client (bypass RLS).
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
  starter: { id: 'starter', name: 'Starter',  euros: 5,  credits: 25 },
  pro:     { id: 'pro',     name: 'Pro',      euros: 20, credits: 120 },
  studio:  { id: 'studio',  name: 'Studio',   euros: 50, credits: 350 },
} as const;
type PackId = keyof typeof PACKS;

interface GenerateInput {
  image: Blob | File | string;
  asset_type: 'character' | 'creature' | 'vehicle' | 'building'
            | 'weapon' | 'prop' | 'environment' | 'icon' | 'custom';
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

function creditCost(i: GenerateInput): number {
  // Preset base cost
  let n: number;
  if (i.preset === 'quality')       n = 4;
  else if (i.preset === 'balanced') n = 2;
  else                              n = 1;  // fast (default)

  // Optional add-ons — same costs as the HTML data-credits.
  if (i.multiref)     n += 1;
  if (i.refine)       n += 2;
  if (i.rectify)      n += 1;
  // smooth is free — CPU-only bilateral filter, no AI
  if (i.quality_plus) n += 1;
  if (i.ultra_q)      n += 2;
  if (i.ultra_hd)     n += 3;
  if (i.face_fix)     n += 2;

  // Legacy: old clients still send mode=full without preset.
  if (i.mode === 'full' && !i.preset) n = Math.max(n, 4);
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

async function handleMe(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return json({ user: null }, { status: 401 });
  return json({ user });
}

// Debug-only endpoint — returns what the Worker actually sees from the
// browser's cookie jar and Supabase token validation. Useful for tracing
// sign-in regressions without redeploying.
async function handleDebugAuth(req: Request, env: Env): Promise<Response> {
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

async function handleCheckout(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  const { packId } = await req.json() as { packId: PackId };
  const pack = PACKS[packId];
  if (!pack) return err(400, 'unknown pack');
  if (!env.STRIPE_SECRET_KEY) return err(500, 'STRIPE_SECRET_KEY not set');

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2025-02-24.acacia' as Stripe.LatestApiVersion });
  const SITE = siteUrl(env, 'http://localhost:3030');
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

  let event: { type: string; data: { object: { id: string; metadata?: Record<string, string>; amount_total?: number } } };
  try { event = JSON.parse(raw); } catch { return err(400, 'bad json'); }

  if (event.type === 'checkout.session.completed') {
    const sess = event.data.object;
    const userId = sess.metadata?.user_id;
    const credits = parseInt(sess.metadata?.credits ?? '0', 10);
    const packId = sess.metadata?.pack_id ?? 'unknown';
    if (userId && credits > 0) {
      const sb = supabaseAdmin(env);
      const { data: existing } = await sb.from('payments')
        .select('id').eq('stripe_session_id', sess.id).maybeSingle();
      if (!existing) {
        await sb.from('payments').insert({
          stripe_session_id: sess.id,
          user_id: userId, pack_id: packId, credits,
          amount_eur: (sess.amount_total ?? 0) / 100,
          created_at: new Date().toISOString(),
        });
        await addCredits(env, userId, credits);
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
  let imageHttpsUrl: string | null = null;
  const urlField = form.get('imagePath') || form.get('image_url');
  if (typeof urlField === 'string' && /^https?:\/\//i.test(urlField)) {
    imageHttpsUrl = urlField;
  }
  // Optional back-view URL — when the user enables `multiref` the
  // renderer sends `imagePathBack`. We forward it to the Modal mesh
  // endpoint which passes both URLs to TRELLIS-2's get_cond([f, b])
  // for multi-view conditioning (better back-texture coherence).
  let backImageHttpsUrl: string | null = null;
  const backField = form.get('imagePathBack') || form.get('image_back_url');
  if (typeof backField === 'string' && /^https?:\/\//i.test(backField)) {
    backImageHttpsUrl = backField;
  }
  // Cloud convenience: accept `imagePath` (a R2/blob URL) and fetch it
  // server-side. Saves the client from a CORS round-trip through R2.
  // Still needed for the Replicate Cog path which takes a File input.
  if (!(image instanceof File) && imageHttpsUrl) {
    try {
      const r = await fetch(imageHttpsUrl);
      if (!r.ok) return err(400, `cannot fetch imagePath (HTTP ${r.status})`);
      const buf = await r.arrayBuffer();
      image = new File([buf], 'source.png', { type: r.headers.get('content-type') ?? 'image/png' });
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
  };

  const cost = creditCost(input);
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
    const provider = useModalMesh ? 'Modal' : 'Replicate';
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
        return err(500, 'modal mesh path needs R2 (no imagePath URL provided)');
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
                       || input.asset_type === 'prop';
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
    try {
      await callModalMeshStart(env, {
        jobId,
        frontImageUrl: frontUrl,
        // Pass the back URL when multiref is on so TRELLIS-2 can
        // condition on both front + back (better back texture).
        // Falls through to single-view if backImageHttpsUrl is null.
        backImageUrl: input.multiref ? backImageHttpsUrl : null,
        mode: input.mode === 'full' ? '1024_cascade'
            : input.mode === 'lite' ? '512'
            : '1024',
        seed: input.seed ?? 42,
        decimation_target: input.mode === 'lite' ? 100_000
                         : input.mode === 'full' ? 1_500_000 : 500_000,
        texture_size: input.mode === 'full' ? 2048 : 1024,
        // Auto-rectify the source image before mesh — port of
        // scripts/generate_front_strict.py. Modal mesh class handles
        // this when `rectify=true` in the payload.
        rectify: input.rectify,
        // Face fix toggle — runs an SDXL face inpaint step on the
        // mesh's texture atlas. Honoured by Modal mesh when `face_fix=true`.
        face_fix: input.face_fix,
      });
    } catch (e: unknown) {
      await addCredits(env, user.id, cost);
      return err(502, 'modal mesh-start failed: ' + (e instanceof Error ? e.message : String(e)));
    }
    await supabaseAdmin(env).from('jobs').insert({
      id: jobId, user_id: user.id,
      asset_type: input.asset_type, mode: input.mode, seed: input.seed,
      credit_cost: cost, status: 'processing',
      project_name: projectName,
      options: {
        rectify: input.rectify, back_view: input.back_view, smooth: input.smooth,
        face_fix: input.face_fix, ultra_hd: input.ultra_hd, fast: input.fast,
        backend: 'modal',
      },
      created_at: new Date().toISOString(),
    });
    return json({ jobId, creditsRemaining: remaining });
  }

  let prediction;
  try {
    prediction = await createReplicatePrediction(env, input);
  } catch (e: unknown) {
    await addCredits(env, user.id, cost);
    return err(502, 'replicate failed: ' + (e instanceof Error ? e.message : String(e)));
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

  const prediction = await replicateClient(env).predictions.get(id);
  const sb = supabaseAdmin(env);
  const { data: job } = await sb.from('jobs').select('*').eq('id', id).maybeSingle();

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
    meshes: Array<{ filename: string; path: string; url: string; created: string; format: string; sourceImage: string | null }>;
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
  const { data: job } = await sb.from('jobs').select('id, user_id, mesh_url')
    .eq('id', id).eq('user_id', user.id).maybeSingle();
  if (!job) return err(404, 'not found');

  // Best-effort R2 cleanup. We store under "<user_id>/<id>.glb" (see
  // uploadGlbToR2). delete() never throws on a missing key.
  if (env.MESHES) {
    try { await env.MESHES.delete(`${user.id}/${id}.glb`); } catch (_) { /* ignore */ }
  }

  const { error } = await sb.from('jobs').delete().eq('id', id).eq('user_id', user.id);
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
    return json({ ok: true, success: true, url, newPath: url });
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
  const COST_PER_IMAGE = 2;
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
    const provider = useModal ? 'Modal' : 'Replicate';
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
    return err(502, `image generation failed (credits refunded): ${e instanceof Error ? e.message : String(e)}`);
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
  const COST_PER_BACK = 2;
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
    const provider = useModal ? 'Modal' : 'Replicate';
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
    return err(502, `back view generation failed (credits refunded): ${e instanceof Error ? e.message : String(e)}`);
  }
  return json({ ok: true, success: true, paths, creditsRemaining: remaining });
}

/** Auto-rectify endpoint — re-generate an orthographic FRONT (or 3/4 ISO)
 *  view from a prompt and/or a reference image, using multi-seed silhouette
 *  symmetry scoring. Verbatim feature port of `generate_front_strict.py`.
 *  Requires Modal (no Replicate fallback). */
async function handleRectifyImage(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return err(401, 'unauthorized');
  if (!env.MODAL_RECTIFY_URL) {
    return err(503, 'rectify backend unavailable (MODAL_RECTIFY_URL not configured)');
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
      error: `daily Modal budget reached. Try again after midnight UTC.` }, { status: 429 });
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
    return err(502, `rectify failed (credits refunded): ${e instanceof Error ? e.message : String(e)}`);
  }
  return json({ ok: true, success: true, path, creditsRemaining: remaining });
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

      // ── /api/* router ──
      if (pathname.startsWith('/api/')) {
        if (pathname === '/api/me'                    && method === 'GET')  return await handleMe(req, env);
        if (pathname === '/api/debug-auth'            && method === 'GET')  return await handleDebugAuth(req, env);
        if (pathname === '/api/checkout'              && method === 'POST') return await handleCheckout(req, env);
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
        if (pathname === '/api/mock-checkout'         && method === 'POST') return await handleMockCheckout(req, env);
        if (pathname === '/api/mock-login'            && method === 'POST') return await handleMockLogin(req, env);
        if (pathname === '/api/mock-logout'           && method === 'POST') return await handleMockLogout(req, env);

        // /api/jobs/[id] — dynamic
        const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/?$/);
        if (jobMatch && method === 'GET') return await handleJob(req, env, decodeURIComponent(jobMatch[1]));

        return err(404, `no route for ${method} ${pathname}`);
      }

      // ── static assets (next export output served via env.ASSETS) ──
      return await env.ASSETS.fetch(req);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('Worker error:', msg, e);
      return err(500, `internal: ${msg}`);
    }
  },
};
