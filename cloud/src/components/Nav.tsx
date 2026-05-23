import Link from 'next/link';
import { getSessionUser } from '@/lib/auth';

export async function Nav() {
  const user = await getSessionUser();
  return (
    <nav style={{ borderBottom: '1px solid var(--line)', background: 'var(--bg)' }}>
      <div className="container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 60 }}>
        <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text)', fontWeight: 600 }}>
          <span style={{ width: 28, height: 28, background: 'linear-gradient(135deg, var(--accent), var(--accent-2))', borderRadius: 6 }} />
          MyFabmesh.AI
          <span className="beta-badge">CLOUD</span>
        </Link>
        <div style={{ display: 'flex', gap: 20, alignItems: 'center', fontSize: 14 }}>
          <Link href="/generate" className="muted">Générer</Link>
          <Link href="/buy" className="muted">Crédits</Link>
          {user ? (
            <>
              <Link href="/account" className="muted">{user.email?.split('@')[0]}</Link>
              <span className="pill">{user.credits} crédits</span>
            </>
          ) : (
            <Link href="/login">
              <button className="ghost" style={{ padding: '6px 14px', fontSize: 13 }}>Se connecter</button>
            </Link>
          )}
        </div>
      </div>
    </nav>
  );
}
