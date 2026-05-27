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
import { MfaEnrollButton } from './MfaEnrollButton';

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
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: '8px 0 4px' }}>
            <span style={{
              fontSize: 32, lineHeight: 1,
              color: '#ffe066',
              textShadow:
                '-2px -2px 0 #1a1a1a, 2px -2px 0 #1a1a1a, ' +
                '-2px 2px 0 #1a1a1a, 2px 2px 0 #1a1a1a, ' +
                '0 2px 4px rgba(0,0,0,0.5)',
              position: 'relative', top: 4,
            }}>⚡</span>
            <span style={{
              fontSize: 42, fontWeight: 800, lineHeight: 1,
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

      {/* MFA TOTP enrolment — protects the Supabase login itself
          (separate layer from the /admin TOTP for the admin panel). */}
      <MfaEnrollButton />

      {/* GDPR — Art. 15 (export) + Art. 17 (right to be forgotten).
          Required by EU law if you sell to EU users. */}
      <div className="card" style={{ marginBottom: 24 }}>
        <h3 style={{ marginTop: 0, marginBottom: 12 }}>Privacy &amp; data</h3>
        <p style={{ color: 'var(--text-2)', fontSize: 13, marginBottom: 16, lineHeight: 1.5 }}>
          You can download every piece of data we hold about you, or
          permanently delete your account and all of its data.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <a href="/api/me/export" download className="ghost-btn">⬇ Download my data (JSON)</a>
          <button
            type="button"
            className="ghost-btn"
            style={{ color: 'var(--err)', borderColor: 'var(--err)' }}
            onClick={async () => {
              const ok = window.prompt(
                'Type DELETE (uppercase) to permanently erase your account, ALL projects, meshes, images and payments history. This cannot be undone.',
              );
              if (ok !== 'DELETE') return;
              try {
                const r = await fetch('/api/me/delete', {
                  method: 'POST', credentials: 'include',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ confirm: 'DELETE' }),
                });
                const j = await r.json().catch(() => ({} as Record<string, unknown>));
                if (!r.ok) {
                  alert('Delete failed: ' + ((j as { error?: string }).error || r.status));
                  return;
                }
                // R2 + profile + jobs + payments deletion happens before
                // the Supabase admin API call. If the auth deletion
                // failed (Supabase down / network blip) the user can
                // still log back in even though their data is gone —
                // we tell them so they can retry instead of being
                // confused later. Best-effort signout of the HttpOnly
                // cookies regardless of the auth-delete outcome.
                await fetch('/api/auth/signout', {
                  method: 'POST', credentials: 'include',
                }).catch(() => {});
                if ((j as { auth_user_deleted?: boolean }).auth_user_deleted === false) {
                  alert(
                    'Your projects, images, meshes and payment history were deleted, ' +
                    'but the Supabase login record could not be removed (transient ' +
                    'error). Please try again in a minute or contact support — ' +
                    'fabien65400@hotmail.fr.',
                  );
                } else {
                  alert('Account deleted. You will now be logged out.');
                }
                window.location.href = '/login';
              } catch (e) {
                alert('Delete failed: ' + (e instanceof Error ? e.message : String(e)));
              }
            }}
          >
            🗑 Delete my account
          </button>
        </div>
      </div>
    </div>
  );
}
