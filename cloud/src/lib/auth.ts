import { supabaseServer, supabaseAdmin } from './supabase';

export interface SessionUser {
  id: string;
  email: string | null;
  credits: number;
}

/**
 * Returns the current authenticated user (with credits), or null.
 * Safe to call from server components and route handlers.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
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
    // Env vars not configured yet → return null instead of crashing the layout.
    return null;
  }
}

/** Atomic credit decrement. Returns new balance, or null if insufficient. */
export async function spendCredits(userId: string, amount: number): Promise<number | null> {
  const sb = supabaseAdmin();
  const { data, error } = await sb.rpc('spend_credits', { p_user_id: userId, p_amount: amount });
  if (error || data == null) return null;
  return data as number;
}

export async function addCredits(userId: string, amount: number): Promise<number | null> {
  const sb = supabaseAdmin();
  const { data, error } = await sb.rpc('add_credits', { p_user_id: userId, p_amount: amount });
  if (error || data == null) return null;
  return data as number;
}
