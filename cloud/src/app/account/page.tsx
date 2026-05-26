'use client';
//
// Account page — was a server component that ran `getSessionUser()` and
// direct Supabase admin queries. For static export we fetch the same
// data from /api/me (user + credits) and /api/projects (recent jobs).
//
// Payments are no longer surfaced here — they're available via the Stripe
// dashboard / webhook receipt email. (Adding a /api/payments endpoint would
// require a new Worker route and exceeds the migration scope; see TODO.)
//
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { LogoutButton } from './LogoutButton';

interface User { id: string; email: string | null; credits: number; }
interface Project {
  id: string; asset_type: string; mode: string; status: string;
  mesh_url: string | null; createdAt: string;
}

export default function AccountPage() {
  const [user, setUser] = useState<User | null>(null);
  const [jobs, setJobs] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [paidBanner, setPaidBanner] = useState(false);

  useEffect(() => {
    setPaidBanner(new URLSearchParams(window.location.search).get('paid') === '1');
    (async () => {
      const meRes = await fetch('/api/me');
      if (!meRes.ok) { window.location.href = '/login?next=/account'; return; }
      const me = await meRes.json();
      setUser(me.user);
      const pjRes = await fetch('/api/projects');
      const pj = pjRes.ok ? await pjRes.json() : { projects: [] };
      setJobs((pj.projects ?? []).slice(0, 20));
      setLoading(false);
    })();
  }, []);

  if (loading || !user) return <div className="page">…</div>;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2>Account</h2>
          <div style={{ color: 'var(--text-2)', fontSize: 13 }}>{user.email}</div>
        </div>
        <LogoutButton />
      </div>

      {paidBanner && (
        <div className="banner ok" style={{ marginBottom: 24 }}>
          ✓ Payment received · credits are arriving in a few seconds.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, marginBottom: 24 }}>
        <div className="card">
          <div style={{ color: 'var(--text-2)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 }}>Balance</div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, margin: '8px 0 4px' }}>
            <span style={{
              fontSize: 38, lineHeight: 1,
              color: '#ffe066',
              textShadow:
                '-2px -2px 0 #1a1a1a, 2px -2px 0 #1a1a1a, ' +
                '-2px 2px 0 #1a1a1a, 2px 2px 0 #1a1a1a, ' +
                '0 2px 4px rgba(0,0,0,0.5)',
            }}>⚡</span>
            <span style={{
              fontSize: 42, fontWeight: 800,
              background: 'linear-gradient(135deg, #ffd84a, #f5a623)',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
            }}>
              {user.credits}
            </span>
          </div>
          <div style={{ color: 'var(--text-2)', fontSize: 12, marginBottom: 14 }}>credits</div>
          <Link href="/buy" className="primary-btn">+ Top up</Link>
        </div>
        <div className="card">
          <div style={{ color: 'var(--text-2)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 }}>Generations</div>
          <div style={{ fontSize: 42, fontWeight: 800, margin: '8px 0 4px' }}>
            {jobs.length}
          </div>
          <div style={{ color: 'var(--text-2)', fontSize: 12 }}>recent jobs</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Recent generations</h3>
          <a href="/api/history.csv" download className="ghost-btn" style={{ fontSize: 13 }}>
            ⬇ Download history (CSV)
          </a>
        </div>
        {jobs.length === 0 ? (
          <p style={{ color: 'var(--text-2)' }}>No generation yet. <a href="/app/" style={{ color: 'var(--accent)' }}>Start a project →</a></p>
        ) : (
          <table className="history">
            <thead>
              <tr><th>Date</th><th>Type</th><th>Mode</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {jobs.map((j) => {
                const statusClass = j.status === 'succeeded' ? 'success' : j.status === 'failed' ? 'error' : 'warn';
                return (
                  <tr key={j.id}>
                    <td>{new Date(j.createdAt).toLocaleString('fr', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                    <td>{j.asset_type}</td>
                    <td>{j.mode}</td>
                    <td><span className={`pill ${statusClass}`}>{j.status}</span></td>
                    <td style={{ textAlign: 'right' }}>
                      <Link href={`/project/${j.id}`} className="nav-link" style={{ fontSize: 12 }}>view</Link>
                      {j.mesh_url && <a href={j.mesh_url} download className="nav-link" style={{ fontSize: 12, marginLeft: 8 }}>⬇</a>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
