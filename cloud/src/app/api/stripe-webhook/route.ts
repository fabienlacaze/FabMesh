/**
 * POST /api/stripe-webhook
 *
 * Stripe → us: payment succeeded → credit user account.
 * Configure the endpoint in Stripe Dashboard: <SITE_URL>/api/stripe-webhook
 * and copy the signing secret into STRIPE_WEBHOOK_SECRET.
 *
 * Idempotent: we record the session.id in `payments` so a webhook replay
 * doesn't double-credit.
 */
import { NextRequest, NextResponse } from 'next/server';
import { stripe } from '@/lib/stripe';
import { addCredits } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature') ?? '';
  const secret = process.env.STRIPE_WEBHOOK_SECRET ?? '';
  if (!secret) return NextResponse.json({ error: 'no webhook secret' }, { status: 500 });

  const raw = await req.text();
  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, secret);
  } catch (err: any) {
    return NextResponse.json({ error: `bad signature: ${err.message}` }, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as any;
    const userId = session.metadata?.user_id;
    const credits = parseInt(session.metadata?.credits ?? '0');
    const packId = session.metadata?.pack_id ?? 'unknown';
    if (userId && credits > 0) {
      const sb = supabaseAdmin();
      // idempotency: only credit if this session hasn't already been processed
      const { data: existing } = await sb.from('payments').select('id').eq('stripe_session_id', session.id).maybeSingle();
      if (!existing) {
        await sb.from('payments').insert({
          stripe_session_id: session.id,
          user_id: userId,
          pack_id: packId,
          credits,
          amount_eur: (session.amount_total ?? 0) / 100,
          created_at: new Date().toISOString(),
        });
        await addCredits(userId, credits);
      }
    }
  }

  return NextResponse.json({ received: true });
}
