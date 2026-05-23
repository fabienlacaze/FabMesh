/**
 * GET /auth/callback?code=…
 *
 * Supabase magic-link redirect target. Exchanges the OTP code for a session
 * cookie, then redirects to /generate (or the original `next` param).
 */
import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') ?? '/generate';
  const origin = url.origin;

  if (code) {
    const sb = await supabaseServer();
    await sb.auth.exchangeCodeForSession(code);
  }
  return NextResponse.redirect(`${origin}${next}`);
}
