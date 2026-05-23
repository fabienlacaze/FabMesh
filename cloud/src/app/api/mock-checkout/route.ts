/**
 * MOCK Stripe Checkout. Credits the user immediately and returns a redirect
 * URL to /account?paid=1. Only active when MOCK=1.
 */
import { NextRequest, NextResponse } from 'next/server';
import { MOCK, mock } from '@/lib/mock-store';
import { getSessionUser } from '@/lib/auth';
import { PACKS, type PackId } from '@/lib/stripe';

export const runtime = 'nodejs';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3030';

export async function POST(req: NextRequest) {
  if (!MOCK) return NextResponse.json({ error: 'mock disabled' }, { status: 400 });
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { packId } = (await req.json()) as { packId: PackId };
  const pack = PACKS[packId];
  if (!pack) return NextResponse.json({ error: 'unknown pack' }, { status: 400 });

  mock.add(user.id, pack.credits);
  mock.insertPayment({
    stripe_session_id: 'mock_' + Date.now(),
    user_id: user.id, pack_id: pack.id, credits: pack.credits,
    amount_eur: pack.euros, created_at: new Date().toISOString(),
  });
  return NextResponse.json({ url: `${SITE}/account?paid=1` });
}
