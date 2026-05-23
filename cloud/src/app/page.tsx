import Link from 'next/link';

export default function HomePage() {
  return (
    <div>
      {/* Hero */}
      <section style={{ padding: '80px 0 60px' }}>
        <div className="container" style={{ textAlign: 'center', maxWidth: 760 }}>
          <span className="pill" style={{ marginBottom: 16 }}>
            🚀 Beta · Pas d'installation, pas de GPU requis
          </span>
          <h1 style={{ fontSize: 48, lineHeight: 1.1, margin: '12px 0' }}>
            Une image. Un mesh 3D. <br />
            <span style={{ background: 'linear-gradient(135deg, var(--accent), var(--accent-2))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
              En 90 secondes.
            </span>
          </h1>
          <p className="muted" style={{ fontSize: 18, marginBottom: 32 }}>
            Generation d'assets 3D game-ready depuis une image de référence.
            TRELLIS-2, IP-Adapter, back-view, face-fix, upscale 8K — tout le pipeline desktop, hébergé.
          </p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link href="/generate"><button style={{ fontSize: 15, padding: '12px 24px' }}>Générer maintenant</button></Link>
            <Link href="/buy"><button className="ghost" style={{ fontSize: 15, padding: '12px 24px' }}>Acheter des crédits</button></Link>
          </div>
          <p className="dim" style={{ fontSize: 13, marginTop: 16 }}>
            À partir de 0,14 € / mesh · Sans abonnement · GLB téléchargeable
          </p>
        </div>
      </section>

      {/* Features */}
      <section style={{ padding: '40px 0' }}>
        <div className="container">
          <div className="grid-3">
            <div className="card">
              <h3>🎯 Match référence</h3>
              <p className="muted" style={{ fontSize: 14 }}>
                Le mesh respecte la silhouette ET la texture de ton image.
                Pas une approximation générique.
              </p>
            </div>
            <div className="card">
              <h3>⚡ Pipeline complet</h3>
              <p className="muted" style={{ fontSize: 14 }}>
                Auto-rectify · back-view · texture smooth · face inpaint ·
                upscale 8K. Tout, optionnel selon ton besoin.
              </p>
            </div>
            <div className="card">
              <h3>🎮 Game-ready</h3>
              <p className="muted" style={{ fontSize: 14 }}>
                GLB exporté, UV unwrap propre, decimation contrôlée
                (100 k / 500 k / 1.5 M tris). Drop direct dans Unreal / Unity / Blender.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing teaser */}
      <section style={{ padding: '60px 0' }}>
        <div className="container">
          <h2 style={{ textAlign: 'center' }}>Tarifs simples · pas d'abonnement</h2>
          <p className="muted" style={{ textAlign: 'center', marginBottom: 32 }}>
            Tu paies ce que tu utilises. Crédits jamais expirés.
          </p>
          <div className="grid-3">
            {[
              { name: 'Starter', price: '5 €', credits: 25, perMesh: '0,20 €' },
              { name: 'Pro', price: '20 €', credits: 120, perMesh: '0,17 €', highlight: true },
              { name: 'Studio', price: '50 €', credits: 350, perMesh: '0,14 €' },
            ].map((p) => (
              <div key={p.name} className="card" style={p.highlight ? { borderColor: 'var(--accent)' } : {}}>
                <h3>{p.name} {p.highlight && <span className="beta-badge" style={{ marginLeft: 8 }}>POPULAIRE</span>}</h3>
                <div style={{ fontSize: 28, fontWeight: 600, margin: '8px 0' }}>{p.price}</div>
                <div className="muted" style={{ fontSize: 14, marginBottom: 12 }}>{p.credits} crédits</div>
                <div className="dim" style={{ fontSize: 13 }}>≈ {p.perMesh} / mesh standard</div>
              </div>
            ))}
          </div>
          <p className="dim" style={{ textAlign: 'center', fontSize: 12, marginTop: 20 }}>
            1 mesh standard = 1 crédit · Mode "Full" = 2 crédits · Options premium (Fast, 8K, Face-fix) = +1 crédit chacune
          </p>
        </div>
      </section>

      {/* Desktop vs Cloud */}
      <section style={{ padding: '40px 0' }}>
        <div className="container">
          <div className="card">
            <h2 style={{ marginBottom: 8 }}>Tu préfères local ?</h2>
            <p className="muted">
              L'app desktop est gratuite et open-beta sur Windows (GPU NVIDIA requis).
              Tout le pipeline tourne sur ta machine, aucune image n'est envoyée sur internet.
            </p>
            <Link href="https://fabienlacaze.github.io/MyFabmesh" target="_blank">
              <button className="ghost" style={{ marginTop: 12 }}>Télécharger desktop →</button>
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
