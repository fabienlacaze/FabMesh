/**
 * In-memory store for MOCK mode.
 *
 * Lets us run the whole UI locally without Supabase/Stripe accounts.
 * Persists across hot-reloads via globalThis. Wiped on server restart
 * (which is what you want for testing).
 *
 * Activate by setting MOCK=1 in .env.local. In production this code
 * stays dormant — every export checks the flag.
 */

export const MOCK = process.env.MOCK === '1';

interface MockUser {
  id: string;
  email: string;
  credits: number;
  createdAt: string;
}

interface MockJob {
  id: string;
  user_id: string;
  asset_type: string;
  mode: string;
  seed: number;
  credit_cost: number;
  status: string;
  options: Record<string, unknown>;
  mesh_url: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

interface MockPayment {
  id: number;
  stripe_session_id: string;
  user_id: string;
  pack_id: string;
  credits: number;
  amount_eur: number;
  created_at: string;
}

interface Store {
  users: Map<string, MockUser>;          // by id
  emailIndex: Map<string, string>;        // email → id
  sessions: Map<string, string>;          // sessionToken → userId
  jobs: Map<string, MockJob>;
  payments: MockPayment[];
  paymentSeq: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __mockStore: Store | undefined;
}

function getStore(): Store {
  if (!globalThis.__mockStore) {
    globalThis.__mockStore = {
      users: new Map(),
      emailIndex: new Map(),
      sessions: new Map(),
      jobs: new Map(),
      payments: [],
      paymentSeq: 1,
    };
  }
  return globalThis.__mockStore;
}

export const mock = {
  /** Idempotent : returns existing user or creates one with 50 dev credits. */
  upsertUser(email: string): MockUser {
    const store = getStore();
    let userId = store.emailIndex.get(email);
    if (userId) return store.users.get(userId)!;
    userId = 'mock_' + crypto.randomUUID();
    const user: MockUser = {
      id: userId, email,
      credits: parseInt(process.env.MOCK_DEFAULT_CREDITS ?? '50'),
      createdAt: new Date().toISOString(),
    };
    store.users.set(userId, user);
    store.emailIndex.set(email, userId);
    return user;
  },

  createSession(userId: string): string {
    const store = getStore();
    const token = 'sess_' + crypto.randomUUID();
    store.sessions.set(token, userId);
    return token;
  },

  getUserBySession(token: string | null | undefined): MockUser | null {
    if (!token) return null;
    const store = getStore();
    const userId = store.sessions.get(token);
    return userId ? store.users.get(userId) ?? null : null;
  },

  destroySession(token: string): void {
    getStore().sessions.delete(token);
  },

  spend(userId: string, amount: number): number | null {
    const u = getStore().users.get(userId);
    if (!u || u.credits < amount) return null;
    u.credits -= amount;
    return u.credits;
  },

  add(userId: string, amount: number): number {
    const u = getStore().users.get(userId);
    if (!u) return 0;
    u.credits += amount;
    return u.credits;
  },

  insertJob(job: Omit<MockJob, 'mesh_url' | 'error' | 'finished_at'> & Partial<Pick<MockJob, 'mesh_url' | 'error' | 'finished_at'>>): void {
    getStore().jobs.set(job.id, {
      mesh_url: null, error: null, finished_at: null,
      ...job,
    });
  },

  getJob(id: string): MockJob | undefined {
    return getStore().jobs.get(id);
  },

  updateJob(id: string, patch: Partial<MockJob>): void {
    const j = getStore().jobs.get(id);
    if (j) Object.assign(j, patch);
  },

  listJobs(userId: string): MockJob[] {
    return [...getStore().jobs.values()]
      .filter((j) => j.user_id === userId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  insertPayment(p: Omit<MockPayment, 'id'>): MockPayment {
    const store = getStore();
    const payment: MockPayment = { id: store.paymentSeq++, ...p };
    store.payments.push(payment);
    return payment;
  },

  listPayments(userId: string): MockPayment[] {
    return getStore().payments
      .filter((p) => p.user_id === userId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  },
};
