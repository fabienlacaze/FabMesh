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

  useEffect(() => {
    fetch('/api/me')
      .then(r => r.ok ? r.json() : { user: null })
      .then(j => setUser(j.user ?? null))
      .catch(() => setUser(null));
  }, []);

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
        {Object.values(PACKS).filter(p => p.mode === 'payment').map((p) => (
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
      <div className="pricing-grid" style={{ padding: 0 }}>
        {Object.values(PACKS).filter(p => p.mode === 'subscription').map((p) => (
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

      <div className="card" style={{ marginTop: 32 }}>
        <h3 style={{ marginBottom: 12 }}>How credits convert to meshes</h3>
        <table className="history">
          <thead>
            <tr><th>Mesh option</th><th>Cost</th><th>Details</th></tr>
          </thead>
          <tbody>
            <tr><td><strong>Lite</strong> mesh</td><td>1 credit</td><td>~60 s · 100k tris · voxel 1024</td></tr>
            <tr><td><strong>Standard</strong> mesh</td><td>1 credit</td><td>~90 s · 500k tris · voxel 1024</td></tr>
            <tr><td><strong>Full</strong> mesh</td><td>2 credits</td><td>~180 s · 1.5M tris · cascade 1536</td></tr>
            <tr><td>Fast mode (H100)</td><td>+1 credit</td><td>~50 s instead of 90 s</td></tr>
            <tr><td>Ultra HD 8K texture</td><td>+1 credit</td><td>Real-ESRGAN x2 upscale</td></tr>
            <tr><td>Face fix (AI inpaint)</td><td>+1 credit</td><td>Characters / creatures only</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
