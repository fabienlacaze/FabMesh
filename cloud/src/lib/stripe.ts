// Stripe SDK access — lazy-initialized so that the build step does NOT
// require STRIPE_SECRET_KEY to be present (it's a runtime secret on
// Cloudflare Workers, not a build-time env var).
//
// Without lazy init, `next build` on a CI runner that doesn't have
// STRIPE_SECRET_KEY exported fails with:
//   Error: Neither apiKey nor config.authenticator provided
// inside `Failed to collect page data for /api/stripe-webhook`.
import Stripe from 'stripe';

let _stripe: Stripe | null = null;

/**
 * Returns a Stripe client. Lazily instantiated on first call.
 * Throws a clear error at runtime if STRIPE_SECRET_KEY is missing,
 * which is way easier to debug than a vendor message.
 */
export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      'STRIPE_SECRET_KEY is not set. Add it as a Worker secret '
      + '(wrangler secret put STRIPE_SECRET_KEY) or in your .env.local.'
    );
  }
  _stripe = new Stripe(key, { apiVersion: '2025-02-24.acacia' });
  return _stripe;
}

/**
 * Proxy that defers Stripe instantiation until the first property access.
 * Lets existing callers keep using `stripe.checkout.sessions.create(...)`
 * unchanged, while still being build-time safe.
 */
export const stripe: Stripe = new Proxy({} as Stripe, {
  get(_t, prop) {
    return (getStripe() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export const PACKS = {
  starter: { id: 'starter', name: 'Starter',  euros: 5,  credits: 25 },
  pro:     { id: 'pro',     name: 'Pro',      euros: 20, credits: 120 },
  studio:  { id: 'studio',  name: 'Studio',   euros: 50, credits: 350 },
} as const;
export type PackId = keyof typeof PACKS;
