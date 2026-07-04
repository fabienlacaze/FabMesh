'use client';
//
// Buy page — was a server component. Static-export converts it to a
// client component that fetches /api/me to get the credit balance.
//
import { useEffect, useState } from 'react';
import { PACKS } from '@/lib/packs';
import { BuyButton } from './BuyButton';

interface User { id: string; email: string | null; credits: number; }

export default function BuyPage() {
  const [user, setUser] = useState<User | null>(null);
  // Per-pack availability map from /api/pricing/availability. Subscription
  // packs without a Stripe Price ID configured come back as false; we hide
  // those cards so the user doesn't get a 503 mid-checkout. null = still
  // loading; missing key = treat as available (fail-open on fetch error).
  const [availability, setAvailability] = useState<Record<string, boolean> | null>(null);

  useEffect(() => {
    fetch('/api/me')
      .then(r => r.ok ? r.json() : { user: null })
      .then(j => setUser(j.user ?? null))
      .catch(() => setUser(null));
  }, []);

  useEffect(() => {
    fetch('/api/pricing/availability')
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (j && j.available) setAvailability(j.available);
        else setAvailability({}); // fail-open: missing keys default to true below
      })
      .catch(() => setAvailability({}));
  }, []);

  const visibleSubs = Object.values(PACKS).filter(
    p => p.mode === 'subscription' && (availability?.[p.id] ?? true),
  );

  return (
    <div className="page">
      <div className="page-header">
        <h2>Buy credits</h2>
        {user && <span className="credits-pill">{user.credits} credits</span>}
      </div>
      <p style={{ color: 'var(--text-2)', marginBottom: 24 }}>
        No subscription. Credits never expire.
      </p>

      <h3 style={{ marginTop: 24, marginBottom: 12, fontSize: 14, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-2)' }}>One-shot top-ups</h3>
      <div className="pricing-grid" style={{ padding: 0 }}>
        {Object.values(PACKS).filter(p => p.mode === 'payment' && (availability?.[p.id] ?? true)).map((p) => (
          <div key={p.id} className={`price-card ${p.id === 'pro' ? 'featured' : ''}`}>
            <div className="name">
              {p.name}
              {p.id === 'pro' && <span className="feat-tag">popular</span>}
            </div>
            <div className="amount">{p.euros} €</div>
            <div className="unit">{p.credits} credits</div>
            <div className="per-mesh">≈ {(p.euros / p.credits).toFixed(2)} € / credit</div>
            <BuyButton packId={p.id} loggedIn={!!user} />
          </div>
        ))}
      </div>

      <h3 style={{ marginTop: 36, marginBottom: 4, fontSize: 14, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-2)' }}>Monthly subscriptions</h3>
      <p style={{ color: 'var(--text-2)', fontSize: 13, marginBottom: 16 }}>
        Credits drop in automatically every month. Cancel anytime from your Stripe customer portal.
      </p>
      {visibleSubs.length === 0 ? (
        <p style={{ color: 'var(--text-2)', fontSize: 13, fontStyle: 'italic' }}>
          Monthly subscription plans coming soon — top-ups available above.
        </p>
      ) : (
        <div className="pricing-grid" style={{ padding: 0 }}>
          {visibleSubs.map((p) => (
            <div key={p.id} className={`price-card ${p.id === 'sub_pro' ? 'featured' : ''}`}>
              <div className="name">
                {p.name}
                {p.id === 'sub_pro' && <span className="feat-tag">best value</span>}
              </div>
              <div className="amount">{p.euros} € <span style={{ fontSize: 14, fontWeight: 400, color: 'var(--text-2)' }}>/ month</span></div>
              <div className="unit">{p.credits} credits / month</div>
              <div className="per-mesh">≈ {(p.euros / p.credits).toFixed(2)} € / credit</div>
              <BuyButton packId={p.id} loggedIn={!!user} />
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ marginTop: 32 }}>
        <h3 style={{ marginBottom: 12 }}>How credits convert to meshes</h3>
        <table className="history">
          <thead>
            <tr><th>Mesh option</th><th>Cost</th><th>Details</th></tr>
          </thead>
          <tbody>
            <tr><td><strong>Fast</strong> mesh</td><td>1 credit</td><td>~50 s · quick draft</td></tr>
            <tr><td><strong>Balanced</strong> mesh</td><td>2 credits</td><td>~90 s · recommended</td></tr>
            <tr><td><strong>Quality</strong> mesh</td><td>4 credits</td><td>~180 s · high detail</td></tr>
            <tr><td><strong>Ultra 8K</strong> mesh</td><td>8 credits</td><td>maximum detail + texture</td></tr>
            <tr><td>Text → image (before the mesh)</td><td>2 credits</td><td>only if you start from a text prompt, not an image</td></tr>
            <tr><td>8K texture · Face fix · Refine</td><td>+2 to +3 credits</td><td>optional add-ons</td></tr>
          </tbody>
        </table>
        <p style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 8 }}>
          Standard rates. Your remaining balance is always shown before you generate.
        </p>
      </div>
    </div>
  );
}
