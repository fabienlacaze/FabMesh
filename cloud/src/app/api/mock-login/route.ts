/**
 * Dev-only instant login. Disabled when MOCK=0.
 * Used by the login page when no Supabase is configured.
 */
import { NextRequest, NextResponse } from 'next/server';
import { MOCK } from '@/lib/mock-store';
import { mockSignIn } from '@/lib/auth';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!MOCK) return NextResponse.json({ error: 'mock disabled' }, { status: 400 });
  const { email } = await req.json();
  if (!email || typeof email !== 'string') {
    return NextResponse.json({ error: 'email required' }, { status: 400 });
  }
  const user = await mockSignIn(email);
  return NextResponse.json({ user });
}
