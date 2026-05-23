/**
 * POST /api/checkout
 *
 * Creates a Stripe Checkout session for a credit pack and returns the URL.
 * The session metadata carries the userId + packId; the webhook reads them
 * to credit the right account on payment success.
 */
import { NextRequest, NextResponse } from 'next/server';
import { stripe, PACKS, type PackId } from '@/lib/stripe';
import { getSessionUser } from '@/lib/auth';

export const runtime = 'nodejs';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3030';

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { packId } = (await req.json()) as { packId: PackId };
  const pack = PACKS[packId];
  if (!pack) return NextResponse.json({ error: 'unknown pack' }, { status: 400 });

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

  return NextResponse.json({ url: session.url });
}
