// Credit pack catalog — kept in its own module so the client bundle
// doesn't have to drag in the Stripe SDK just to render the pricing grid.
export const PACKS = {
  // One-shot top-ups (Stripe Payment mode).
  starter: { id: 'starter', name: 'Starter', euros: 5,  credits: 25,  mode: 'payment' as const },
  pro:     { id: 'pro',     name: 'Pro',     euros: 20, credits: 120, mode: 'payment' as const },
  studio:  { id: 'studio',  name: 'Studio',  euros: 50, credits: 350, mode: 'payment' as const },
  // Monthly subscriptions (Stripe Subscription mode). Credits drop
  // every billing cycle automatically.
  sub_starter: { id: 'sub_starter', name: 'Starter Monthly', euros: 5,  credits: 30,  mode: 'subscription' as const, interval: 'month' as const },
  sub_pro:     { id: 'sub_pro',     name: 'Pro Monthly',     euros: 15, credits: 100, mode: 'subscription' as const, interval: 'month' as const },
  sub_studio:  { id: 'sub_studio',  name: 'Studio Monthly',  euros: 40, credits: 300, mode: 'subscription' as const, interval: 'month' as const },
} as const;
export type PackId = keyof typeof PACKS;
