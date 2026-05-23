import { getSessionUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { LogoutButton } from './LogoutButton';

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ paid?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect('/login?next=/account');

  const sp = await searchParams;

  const sb = supabaseAdmin();
  const { data: jobs } = await sb
    .from('jobs')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(20);

  const { data: payments } = await sb
    .from('payments')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(10);

  return (
    <div className="container" style={{ padding: '40px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>Mon compte</h1>
          <div className="muted">{user.email}</div>
        </div>
        <LogoutButton />
      </div>

      {sp.paid && (
        <div className="card" style={{ borderColor: 'var(--good)', marginBottom: 24 }}>
          ✓ Paiement reçu. Les crédits arrivent dans quelques secondes.
        </div>
      )}

      <div className="grid-2" style={{ marginBottom: 32 }}>
        <div className="card">
          <h3>Solde</h3>
          <div style={{ fontSize: 36, fontWeight: 600, color: 'var(--accent)' }}>{user.credits}</div>
          <div className="muted">crédits</div>
          <Link href="/buy"><button style={{ marginTop: 12 }}>Recharger</button></Link>
        </div>
        <div className="card">
          <h3>Total dépensé</h3>
          <div style={{ fontSize: 36, fontWeight: 600 }}>
            {(payments ?? []).reduce((sum, p) => sum + (p.amount_eur ?? 0), 0).toFixed(2)} €
          </div>
          <div className="muted">depuis l'inscription</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <h3>Historique des générations</h3>
        {(!jobs || jobs.length === 0) ? (
          <p className="muted">Aucune génération pour l'instant. <Link href="/generate">Commencer →</Link></p>
        ) : (
          <table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--line)', color: 'var(--text-muted)', fontSize: 12, textAlign: 'left' }}>
                <th style={{ padding: '8px 0' }}>Date</th>
                <th>Type</th>
                <th>Mode</th>
                <th>Coût</th>
                <th>État</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} style={{ borderBottom: '1px solid var(--line)' }}>
                  <td style={{ padding: '10px 0' }}>{new Date(j.created_at).toLocaleString('fr')}</td>
                  <td>{j.asset_type}</td>
                  <td>{j.mode}</td>
                  <td>{j.credit_cost}c</td>
                  <td>
                    <span className="pill" style={{
                      background: j.status === 'succeeded' ? 'rgba(74,222,128,0.15)' :
                                  j.status === 'failed' ? 'rgba(248,113,113,0.15)' : undefined,
                      color: j.status === 'succeeded' ? 'var(--good)' :
                             j.status === 'failed' ? 'var(--bad)' : undefined
                    }}>
                      {j.status}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {j.mesh_url && <a href={j.mesh_url} download>⬇ GLB</a>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>Paiements</h3>
        {(!payments || payments.length === 0) ? (
          <p className="muted">Aucun paiement pour l'instant.</p>
        ) : (
          <table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--line)', color: 'var(--text-muted)', fontSize: 12, textAlign: 'left' }}>
                <th style={{ padding: '8px 0' }}>Date</th>
                <th>Pack</th>
                <th>Crédits</th>
                <th>Montant</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} style={{ borderBottom: '1px solid var(--line)' }}>
                  <td style={{ padding: '10px 0' }}>{new Date(p.created_at).toLocaleString('fr')}</td>
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
