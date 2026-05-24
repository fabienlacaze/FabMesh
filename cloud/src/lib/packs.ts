// Credit pack catalog — kept in its own module so the client bundle
// doesn't have to drag in the Stripe SDK just to render the pricing grid.
export const PACKS = {
  starter: { id: 'starter', name: 'Starter',  euros: 5,  credits: 25 },
  pro:     { id: 'pro',     name: 'Pro',      euros: 20, credits: 120 },
  studio:  { id: 'studio',  name: 'Studio',   euros: 50, credits: 350 },
} as const;
export type PackId = keyof typeof PACKS;
