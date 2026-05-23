/**
 * GET /api/me
 *
 * Returns the current session user + credit balance.
 * Called by the ported desktop renderer's meshyAPI-cloud shim (getConfig).
 */
import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';

export const runtime = 'nodejs';

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ user: null }, { status: 401 });
  return NextResponse.json({ user });
}
