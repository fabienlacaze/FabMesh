import { getSessionUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { LogoutButton } from './LogoutButton';
import { MOCK, mock } from '@/lib/mock-store';

interface JobRow {
  id: string; asset_type: string; mode: string;
  credit_cost: number; status: string;
  mesh_url: string | null; created_at: string;
}
interface PaymentRow {
  id: number | string; pack_id: string; credits: number;
  amount_eur: number | null; created_at: string;
}

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ paid?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect('/login?next=/account');
  const sp = await searchParams;

  let jobs: JobRow[] = [];
  let payments: PaymentRow[] = [];
  if (MOCK) {
    jobs = mock.listJobs(user.id).slice(0, 20);
    payments = mock.listPayments(user.id).slice(0, 10);
  } else {
    const sb = supabaseAdmin();
    const j = await sb.from('jobs').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(20);
    const p = await sb.from('payments').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(10);
    jobs = (j.data ?? []) as JobRow[];
    payments = (p.data ?? []) as PaymentRow[];
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2>Account</h2>
          <div style={{ color: 'var(--text-2)', fontSize: 13 }}>{user.email}</div>
        </div>
        <LogoutButton />
      </div>

      {sp.paid && (
        <div className="banner ok" style={{ marginBottom: 24 }}>
          ✓ Payment received · credits are arriving in a few seconds.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, marginBottom: 24 }}>
        <div className="card">
          <div style={{ color: 'var(--text-2)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 }}>Balance</div>
          <div style={{ fontSize: 42, fontWeight: 800, margin: '8px 0 4px',
            background: 'var(--accent-grad)',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            {user.credits}
          </div>
          <div style={{ color: 'var(--text-2)', fontSize: 12, marginBottom: 14 }}>credits</div>
          <Link href="/buy" className="primary-btn">+ Top up</Link>
        </div>
        <div className="card">
          <div style={{ color: 'var(--text-2)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 }}>Total spent</div>
          <div style={{ fontSize: 42, fontWeight: 800, margin: '8px 0 4px' }}>
            {(payments.reduce((s, p) => s + (p.amount_eur ?? 0), 0)).toFixed(2)} €
          </div>
          <div style={{ color: 'var(--text-2)', fontSize: 12 }}>across {payments.length} payment{payments.length > 1 ? 's' : ''}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <h3 style={{ marginBottom: 12 }}>Recent generations</h3>
        {jobs.length === 0 ? (
          <p style={{ color: 'var(--text-2)' }}>No generation yet. <Link href="/generate">Start a project →</Link></p>
        ) : (
          <table className="history">
            <thead>
              <tr><th>Date</th><th>Type</th><th>Mode</th><th>Cost</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {jobs.map((j) => {
                const statusClass = j.status === 'succeeded' ? 'success' : j.status === 'failed' ? 'error' : 'warn';
                return (
                  <tr key={j.id}>
                    <td>{new Date(j.created_at).toLocaleString('fr', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                    <td>{j.asset_type}</td>
                    <td>{j.mode}</td>
                    <td>{j.credit_cost} c</td>
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

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>Payments</h3>
        {payments.length === 0 ? (
          <p style={{ color: 'var(--text-2)' }}>No payment yet.</p>
        ) : (
          <table className="history">
            <thead>
              <tr><th>Date</th><th>Pack</th><th>Credits</th><th>Amount</th></tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td>{new Date(p.created_at).toLocaleString('fr')}</td>
                  <td>{p.pack_id}</td>
                  <td>+{p.credits}</td>
                  <td>{p.amount_eur?.toFixed(2)} €</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
