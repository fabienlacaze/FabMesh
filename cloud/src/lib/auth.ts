import { cookies } from 'next/headers';
import { supabaseServer, supabaseAdmin } from './supabase';
import { MOCK, mock } from './mock-store';

export interface SessionUser {
  id: string;
  email: string | null;
  credits: number;
}

const MOCK_COOKIE = 'myfm_mock_session';

/**
 * Returns the current authenticated user (with credits), or null.
 * Safe to call from server components and route handlers.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  if (MOCK) {
    const c = await cookies();
    const u = mock.getUserBySession(c.get(MOCK_COOKIE)?.value);
    return u ? { id: u.id, email: u.email, credits: u.credits } : null;
  }
  try {
    const sb = await supabaseServer();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return null;
    const { data: profile } = await sb
      .from('profiles')
      .select('credits')
      .eq('id', user.id)
      .maybeSingle();
    return { id: user.id, email: user.email ?? null, credits: profile?.credits ?? 0 };
  } catch {
    return null;
  }
}

/** Atomic credit decrement. Returns new balance, or null if insufficient. */
export async function spendCredits(userId: string, amount: number): Promise<number | null> {
  if (MOCK) return mock.spend(userId, amount);
  const sb = supabaseAdmin();
  const { data, error } = await sb.rpc('spend_credits', { p_user_id: userId, p_amount: amount });
  if (error || data == null) return null;
  return data as number;
}

export async function addCredits(userId: string, amount: number): Promise<number | null> {
  if (MOCK) return mock.add(userId, amount);
  const sb = supabaseAdmin();
  const { data, error } = await sb.rpc('add_credits', { p_user_id: userId, p_amount: amount });
  if (error || data == null) return null;
  return data as number;
}

/** MOCK ONLY: sign in by email instantly (used by the dev login form). */
export async function mockSignIn(email: string): Promise<SessionUser> {
  if (!MOCK) throw new Error('mockSignIn called outside MOCK mode');
  const u = mock.upsertUser(email);
  const token = mock.createSession(u.id);
  const c = await cookies();
  c.set(MOCK_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  return { id: u.id, email: u.email, credits: u.credits };
}

export async function mockSignOut(): Promise<void> {
  if (!MOCK) return;
  const c = await cookies();
  const tok = c.get(MOCK_COOKIE)?.value;
  if (tok) mock.destroySession(tok);
  c.delete(MOCK_COOKIE);
}
