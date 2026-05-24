import { PACKS } from '@/lib/stripe';
import { BuyButton } from './BuyButton';
import { getSessionUser } from '@/lib/auth';

export default async function BuyPage() {
  const user = await getSessionUser();
  return (
    <div className="page">
      <div className="page-header">
        <h2>Buy credits</h2>
        {user && <span className="credits-pill">{user.credits} credits</span>}
      </div>
      <p style={{ color: 'var(--text-2)', marginBottom: 24 }}>
        No subscription. Credits never expire.
      </p>

      <div className="pricing-grid" style={{ padding: 0 }}>
        {Object.values(PACKS).map((p) => (
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
