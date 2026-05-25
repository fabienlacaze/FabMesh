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

  SUPABASE_SERVICE_ROLE_KEY?: string;

  // Optional R2 S3 endpoint (kept for parity; native R2 binding is preferred).
  R2_PUBLIC_URL?: string;
}

/** Minimal R2Bucket type (avoid pulling @cloudflare/workers-types). */
interface R2Bucket {
  put(key: string, value: ReadableStream | ArrayBuffer | string, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream } | null>;
  delete(key: string): Promise<void>;
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
  // Cloud convenience: accept `imagePath` (a R2/blob URL) and fetch it
  // server-side. Saves the client from a CORS round-trip through R2.
  if (!(image instanceof File)) {
    const url = form.get('imagePath') || form.get('image_url');
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      try {
        const r = await fetch(url);
        if (!r.ok) return err(400, `cannot fetch imagePath (HTTP ${r.status})`);
        const buf = await r.arrayBuffer();
        image = new File([buf], 'source.png', { type: r.headers.get('content-type') ?? 'image/png' });
      } catch (e) {
        return err(400, `cannot fetch imagePath: ${e instanceof Error ? e.message : String(e)}`);
      }
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
  };

  const cost = creditCost(input);
  const remaining = await spendCredits(env, user.id, cost);
  if (remaining == null) return err(402, 'insufficient credits');

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

  let prediction;
  try {
    prediction = await createReplicatePrediction(env, input);
  } catch (e: unknown) {
    await addCredits(env, user.id, cost);
    return err(502, 'replicate failed: ' + (e instanceof Error ? e.message : String(e)));
  }

  const projectName = (form.get('project_name') as string | null) || null;
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
        // For text2image (RealVisXL 30 steps) we expect ~5-15s; for
        // back-view (RealVisXL + ControlNet + IP-Adapter) ~30-60s.
        // 'prefer: wait' inlines the result up to 60s, beyond we poll.
        'prefer': 'wait=60',
      },
      body: JSON.stringify({ version, input }),
    },
  );
  if (!createRes.ok) {
    throw new Error(`Replicate create HTTP ${createRes.status}: ${await createRes.text()}`);
  }
  const created = await createRes.json() as { id: string; output?: string | string[]; status: string; error?: string };

  let outputUrl: string | undefined;
  if (created.status === 'succeeded') {
    outputUrl = Array.isArray(created.output) ? created.output[0] : created.output;
  } else if (created.status === 'failed') {
    throw new Error(`Replicate failed: ${created.error || 'unknown'}`);
  } else {
    // Poll for up to 5 min (cold-start can be slow on first call).
    const start = Date.now();
    while (Date.now() - start < 300_000) {
      await new Promise(r => setTimeout(r, 2500));
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
    if (!outputUrl) throw new Error('Replicate timeout');
  }
  if (!outputUrl) throw new Error('Replicate succeeded but no output URL');

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
  const { prompt, numImages, seed, asset_type, asset_style, userPrompt, steps } = await req.json() as {
    prompt?: string;
    userPrompt?: string;
    numImages?: number;
    seed?: number;
    asset_type?: string;
    asset_style?: string;
    steps?: number;
  };
  // The Cog rebuilds the enriched prompt itself from userPrompt + type
  // + style — we forward those. Fall back to the full enriched prompt
  // the renderer sent in case userPrompt isn't broken out.
  const rawPrompt = (userPrompt ?? prompt ?? '').toString().trim();
  if (!rawPrompt) return err(400, 'prompt required');
  const n = Math.max(1, Math.min(4, numImages ?? 1));
  // 2 credits per image — covers Replicate's setup + idle overhead
  // (active compute alone is ~$0.04, but cold-start adds ~$0.08 + 5min
  // idle adds ~$0.30, so we charge 2 credits = ~0.40€ to stay margin-
  // positive on the first call of a session).
  const COST_PER_IMAGE = 2;
  const cost = n * COST_PER_IMAGE;

  const remaining = await spendCredits(env, user.id, cost);
  if (remaining == null) {
    return json({ ok: false, success: false, error: `insufficient credits — image generation costs ${cost} credit${cost === 1 ? '' : 's'}` }, { status: 402 });
  }

  const paths: string[] = [];
  const seedBase = seed ?? Math.floor(Math.random() * 1e9);
  try {
    for (let i = 0; i < n; i++) {
      paths.push(await callMyfabmeshCog(env, user.id, {
        task: 'text2image',
        prompt: rawPrompt,
        asset_type: asset_type || 'character',
        asset_style: asset_style || 'realistic',
        seed: seedBase + i,
        steps: steps || 30,
      }, 'front'));
    }
  } catch (e) {
    await addCredits(env, user.id, cost);
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
  const n = Math.max(1, Math.min(4, numImages ?? 1));
  // 2 credits per back view image, same pricing as front. Back view
  // is actually MORE expensive on Replicate (~96s vs ~35s active) but
  // we keep parity with front for simplicity.
  const COST_PER_BACK = 2;
  const cost = n * COST_PER_BACK;

  const remaining = await spendCredits(env, user.id, cost);
  if (remaining == null) {
    return json({ ok: false, success: false, error: `insufficient credits — back view costs ${cost} credit${cost === 1 ? '' : 's'}` }, { status: 402 });
  }

  const paths: string[] = [];
  try {
    for (let i = 0; i < n; i++) {
      paths.push(await callMyfabmeshCog(env, user.id, {
        task: 'back-view',
        prompt: hint,
        image: frontImageUrl,
        asset_type: asset_type || 'character',
      }, 'back'));
    }
  } catch (e) {
    await addCredits(env, user.id, cost);
    return err(502, `back view generation failed (credits refunded): ${e instanceof Error ? e.message : String(e)}`);
  }
  return json({ ok: true, success: true, paths, creditsRemaining: remaining });
}

/* ────────────────────────── main fetch handler ─────────────────────── */

export default {
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
