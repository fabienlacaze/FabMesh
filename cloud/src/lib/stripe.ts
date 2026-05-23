import Stripe from 'stripe';

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', {
  apiVersion: '2025-02-24.acacia',
});

export const PACKS = {
  starter: { id: 'starter', name: 'Starter',  euros: 5,  credits: 25 },
  pro:     { id: 'pro',     name: 'Pro',      euros: 20, credits: 120 },
  studio:  { id: 'studio',  name: 'Studio',   euros: 50, credits: 350 },
} as const;
export type PackId = keyof typeof PACKS;
