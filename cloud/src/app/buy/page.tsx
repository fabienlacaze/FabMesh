import { PACKS } from '@/lib/stripe';
import { BuyButton } from './BuyButton';
import { getSessionUser } from '@/lib/auth';

export default async function BuyPage() {
  const user = await getSessionUser();
  return (
    <div className="container" style={{ padding: '40px 0' }}>
      <h1>Acheter des crédits</h1>
      <p className="muted" style={{ marginBottom: 32 }}>
        Sans abonnement, les crédits n'expirent pas.
        {user ? <> Tu as actuellement <strong>{user.credits}</strong> crédits.</> : null}
      </p>
      <div className="grid-3">
        {Object.values(PACKS).map((p) => (
          <div key={p.id} className="card" style={p.id === 'pro' ? { borderColor: 'var(--accent)' } : {}}>
            <h3>{p.name} {p.id === 'pro' && <span className="beta-badge" style={{ marginLeft: 8 }}>POPULAIRE</span>}</h3>
            <div style={{ fontSize: 32, fontWeight: 600, margin: '12px 0' }}>{p.euros} €</div>
            <div className="muted" style={{ marginBottom: 16 }}>{p.credits} crédits</div>
            <div className="dim" style={{ fontSize: 13, marginBottom: 20 }}>
              ≈ {(p.euros / p.credits).toFixed(2)} € / crédit
            </div>
            <BuyButton packId={p.id} loggedIn={!!user} />
          </div>
        ))}
      </div>
      <div className="card" style={{ marginTop: 32 }}>
        <h3>Coût par mesh</h3>
        <ul className="muted" style={{ fontSize: 14, lineHeight: 1.8 }}>
          <li>Mesh <strong>Lite</strong> (rapide, 100k tris) = 1 crédit</li>
          <li>Mesh <strong>Standard</strong> (équilibré, 500k tris) = 1 crédit</li>
          <li>Mesh <strong>Full</strong> (cascade 1536, 1.5M tris) = 2 crédits</li>
          <li>Mode <strong>Fast</strong> (GPU H100, ~50 s au lieu de 90) = +1 crédit</li>
          <li>Texture <strong>Ultra HD 8K</strong> = +1 crédit</li>
          <li><strong>Face fix</strong> SDXL (personnages) = +1 crédit</li>
        </ul>
      </div>
    </div>
  );
}
