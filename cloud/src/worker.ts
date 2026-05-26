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

async function handleMe(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env);
  if (!user) return json({ user: null }, { status: 401 });
  // Expose `is_admin` so the frontend can show/hide the admin dashboard
  // button without having to make a second request. The check stays on
  // the server (frontend just trusts the flag for UI purposes — every
  // admin endpoint re-checks the email in _requireAdmin).
  const is_admin = !!(user.email && ADMIN_EMAILS.has(user.email.toLowerCase()));
  return json({ user: { ...user, is_admin } });
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
    refine: form.get('refine') === 'true',
    quality_plus: form.get('quality_plus') === 'true',
    ultra_q: form.get('ultra_q') === 'true',
    preset: (form.get('preset') as GenerateInput['preset']) || undefined,
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
        // History tracking — operation_type + cost_usd let /api/history.csv
        // compute the margin without re-deriving it from credit_cost alone.
        // face_fix doubles GPU usage so the cost_usd is bumped.
        operation_type: 'mesh',
        cost_usd: input.face_fix ? MODAL_COST_USD['mesh-face'] : MODAL_COST_USD['mesh'],
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
    return err(503, 'modify backend unavailable (MODAL_IMAGE_OP_URL not configured)');
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

  const COST_PER_MODIFY = 2;  // same as text2image (single SDXL pass)
  const cost = COST_PER_MODIFY;
  const estimatedTotal = 0.05;  // ≈ back-view cost, warm container

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

  const COST_PER_INPAINT = 3;   // 2 model load + SDXL inpaint heavier than text2image
  const cost = COST_PER_INPAINT;
  const estimatedTotal = 0.08;

  const remainingBudget = await checkAndIncrementModalSpend(env, estimatedTotal);
  if (remainingBudget == null) {
    return json({ ok: false, success: false,
      error: 'daily Modal budget reached. Try again after midnight UTC.' }, { status: 429 });
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

  const COST_PER = 3;
  const estimatedTotal = 0.07;

  const remainingBudget = await checkAndIncrementModalSpend(env, estimatedTotal);
  if (remainingBudget == null) {
    return json({ ok: false, success: false,
      error: 'daily Modal budget reached. Try again after midnight UTC.' }, { status: 429 });
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

  const COST_PER = 2;
  const estimatedTotal = 0.05;
  const remainingBudget = await checkAndIncrementModalSpend(env, estimatedTotal);
  if (remainingBudget == null) {
    return json({ ok: false, success: false,
      error: 'daily Modal budget reached.' }, { status: 429 });
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

  // Resolve mesh URL — caller can pass URL directly OR a job id.
  let finalUrl = meshUrl ?? '';
  if (!finalUrl && meshId) {
    const { data } = await supabaseAdmin(env)
      .from('jobs').select('mesh_url').eq('id', meshId).eq('user_id', user.id).maybeSingle();
    finalUrl = (data as { mesh_url?: string } | null)?.mesh_url ?? '';
  }
  if (!finalUrl) return err(400, 'meshUrl or meshId required');

  // Cheap op (CPU, ~$0.001 Modal) — 1 credit flat.
  const COST_PER = 1;
  const estimatedTotal = 0.005;
  const remainingBudget = await checkAndIncrementModalSpend(env, estimatedTotal);
  if (remainingBudget == null) {
    return json({ ok: false, success: false, error: 'daily Modal budget reached.' }, { status: 429 });
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

  const m = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl);
  if (!m) return err(400, 'invalid dataUrl (expected data:image/...;base64,...)');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  let bytes: Uint8Array;
  try {
    const bin = atob(m[2]);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch (e) {
    return err(400, `base64 decode failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Cheap size guard — canvas saves should be <10 MB at 4K.
  if (bytes.byteLength > 20 * 1024 * 1024) return err(413, 'image too large (20 MB max)');

  const safeSuf = (suffix ?? 'edit').toString().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 16);
  const key = `${user.id}/canvas/${Date.now()}_${safeSuf}.${ext}`;
  try {
    await env.MESHES.put(key, bytes, {
      httpMetadata: { contentType: `image/${m[1]}` },
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

  const COST_PER = factor === 4 ? 3 : 2;
  const estimatedTotal = factor === 4 ? 0.07 : 0.05;
  const remainingBudget = await checkAndIncrementModalSpend(env, estimatedTotal);
  if (remainingBudget == null) {
    return json({ ok: false, success: false,
      error: 'daily Modal budget reached.' }, { status: 429 });
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
    // We don't disclose which factor failed — generic 401 keeps the
    // password attack surface low.
    return err(401, 'unauthorized');
  }
  if (!env.ADMIN_PASSWORD) return err(500, 'ADMIN_PASSWORD not configured');

  let body: { password?: string };
  try { body = await req.json() as { password?: string }; } catch { return err(400, 'bad json'); }
  const provided = String(body.password ?? '');
  if (!provided) return err(400, 'password required');
  // Constant-time compare so a wrong password doesn't leak length.
  if (provided.length !== env.ADMIN_PASSWORD.length) return err(401, 'invalid password');
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ env.ADMIN_PASSWORD.charCodeAt(i);
  if (diff !== 0) return err(401, 'invalid password');

  const exp = Math.floor(Date.now() / 1000) + ADMIN_TTL_SEC;
  const payload = `${user.email.toLowerCase()}:${exp}`;
  const sig = await _hmacSign(env.ADMIN_PASSWORD, payload);
  const value = `${payload}.${sig}`;
  return new Response(JSON.stringify({ ok: true, expires_at: exp }), {
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
  let grossRevenueEur = 0;
  let paymentsCount = 0;
  try {
    const { data: pays } = await sb
      .from('payments')
      .select('amount_total, created_at')
      .order('created_at', { ascending: false })
      .limit(5000);
    for (const p of (pays ?? []) as { amount_total: number }[]) {
      grossRevenueEur += (p.amount_total ?? 0) / 100;
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
        if (pathname === '/api/history.csv'           && method === 'GET')  return await handleHistoryCsv(req, env);
        if (pathname === '/api/history.xlsx'          && method === 'GET')  return await handleHistoryXls(req, env);
        if (pathname === '/api/history.json'          && method === 'GET')  return await handleHistoryJson(req, env);
        if (pathname === '/api/admin/login'           && method === 'POST') return await handleAdminLogin(req, env);
        if (pathname === '/api/admin/logout'          && method === 'POST') return await handleAdminLogout(req, env);
        if (pathname === '/api/admin/history.csv'     && method === 'GET')  return await handleAdminHistoryCsv(req, env);
        if (pathname === '/api/admin/history.xlsx'    && method === 'GET')  return await handleAdminHistoryXls(req, env);
        if (pathname === '/api/admin/stats.json'      && method === 'GET')  return await handleAdminStats(req, env);
        if (pathname === '/download/track'            && method === 'GET')  return await handleDownloadTrack(req, env);
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
