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
interface Reply {
  id: string; subject: string; message: string;
  reply_body: string; replied_at: string; created_at: string;
}
interface EarningsCashBucket { currency: string; amount_cents: number; }
interface Earnings {
  total_credits_paid: number;
  sales_count: number;
  cash: EarningsCashBucket[];
}
interface SellerStatus {
  has_account: boolean;
  charges_enabled: boolean;
  payouts_enabled?: boolean;
  details_submitted?: boolean;
}

export default function AccountPage() {
  const [user, setUser] = useState<User | null>(null);
  const [jobs, setJobs] = useState<Project[]>([]);
  const [replies, setReplies] = useState<Reply[]>([]);
  const [loading, setLoading] = useState(true);
  const [paidBanner, setPaidBanner] = useState(false);
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [sellerStatus, setSellerStatus] = useState<SellerStatus | null>(null);
  const [stripeReturn, setStripeReturn] = useState<'return' | 'refresh' | null>(null);
  const [onboardBusy, setOnboardBusy] = useState(false);

  // After a Stripe payment (?paid=1), the credit grant lands via the webhook a
  // moment AFTER the redirect, so the first /api/me can still show the old
  // balance. Re-poll every 2s for ~30s so the Balance card updates itself
  // instead of the user seeing 0 credits right after paying.
  useEffect(() => {
    if (!paidBanner) return;
    let n = 0;
    const iv = setInterval(async () => {
      n += 1;
      try {
        const r = await fetch('/api/me');
        if (r.ok) { const m = await r.json(); setUser(m.user); }
      } catch {}
      if (n >= 15) clearInterval(iv);
    }, 2000);
    return () => clearInterval(iv);
  }, [paidBanner]);

  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    setPaidBanner(qs.get('paid') === '1');
    if (qs.get('stripe_return') === '1') setStripeReturn('return');
    else if (qs.get('stripe_refresh') === '1') setStripeReturn('refresh');
    (async () => {
      const meRes = await fetch('/api/me');
      if (!meRes.ok) { window.location.href = '/login?next=/account'; return; }
      const me = await meRes.json();
      setUser(me.user);
      const pjRes = await fetch('/api/projects');
      const pj = pjRes.ok ? await pjRes.json() : { projects: [] };
      setJobs((pj.projects ?? []).slice(0, 20));
      // Replies from support — silent failure if endpoint missing
      // (older deploys), the rest of the page still renders.
      try {
        const rpRes = await fetch('/api/me/replies');
        if (rpRes.ok) {
          const rp = await rpRes.json();
          setReplies(rp.replies ?? []);
        }
      } catch {}
      // Marketplace earnings + Stripe Connect status — fetched in
      // parallel, silent 401/404 fall back to no-display so older
      // deploys (without these routes) still render the rest of the
      // page.
      try {
        const [erRes, ssRes] = await Promise.all([
          fetch('/api/me/earnings').catch(() => null),
          fetch('/api/market/seller/status').catch(() => null),
        ]);
        if (erRes && erRes.ok) {
          const er = await erRes.json();
          setEarnings({
            total_credits_paid: er.total_credits_paid ?? 0,
            sales_count: er.sales_count ?? 0,
            cash: Array.isArray(er.cash) ? er.cash : [],
          });
        }
        if (ssRes && ssRes.ok) {
          const ss = await ssRes.json();
          setSellerStatus({
            has_account: !!ss.has_account,
            charges_enabled: !!ss.charges_enabled,
            payouts_enabled: !!ss.payouts_enabled,
            details_submitted: !!ss.details_submitted,
          });
        }
      } catch {}
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

      {stripeReturn === 'return' && (
        <div className="banner ok" style={{ marginBottom: 24 }}>
          ✓ Stripe setup completed — your payout status will update in a moment.
        </div>
      )}
      {stripeReturn === 'refresh' && (
        <div className="banner" style={{ marginBottom: 24 }}>
          Onboarding resumed — finish in Stripe.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, marginBottom: 24 }}>
        <div className="card">
          <div style={{ color: 'var(--text-2)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 }}>Balance</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '12px 0 6px' }}>
            <span className="credit-badge lg">{user.credits}</span>
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
                      {/* /project/[id] detail page was never built → 404; the download below is the useful action */}
                      {j.mesh_url
                        ? <a href={j.mesh_url} download className="nav-link" style={{ fontSize: 12 }}>⬇ download</a>
                        : <span style={{ fontSize: 12, opacity: 0.5 }}>—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Marketplace earnings — sales summary + Stripe Connect status.
          Hidden if both endpoints 401/404 (no marketplace activity AND
          no Connect account). */}
      {(earnings || sellerStatus) && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h3 style={{ marginTop: 0, marginBottom: 12 }}>Marketplace earnings</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
            {/* Stats column */}
            <div style={{ flex: '1 1 220px', minWidth: 220 }}>
              <div style={{ color: 'var(--text-2)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Sales</div>
              <div style={{ fontSize: 28, fontWeight: 800, marginBottom: 2 }}>
                {earnings?.sales_count ?? 0}
              </div>
              <div style={{ color: 'var(--text-2)', fontSize: 12, marginBottom: 14 }}>items sold</div>
              <div style={{ color: 'var(--text-2)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Credits earned</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                <span className="credit-badge">{earnings?.total_credits_paid ?? 0}</span>
              </div>
              {earnings && earnings.cash.length > 0 && (
                <>
                  <div style={{ color: 'var(--text-2)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Cash payouts</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {earnings.cash.map((b) => (
                      <div key={b.currency} style={{ fontSize: 14, fontWeight: 600 }}>
                        {(b.amount_cents / 100).toLocaleString('fr', { style: 'currency', currency: b.currency.toUpperCase() })}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
            {/* Stripe Connect column */}
            <div style={{ flex: '1 1 260px', minWidth: 260 }}>
              <div style={{ color: 'var(--text-2)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>Payouts</div>
              {!sellerStatus?.has_account && (
                <>
                  <p style={{ color: 'var(--text-2)', fontSize: 13, marginTop: 0, marginBottom: 12, lineHeight: 1.5 }}>
                    Sellers are paid in platform credits by default. Activate Stripe payouts to receive cash instead.
                  </p>
                  <button
                    type="button"
                    className="primary-btn"
                    disabled={onboardBusy}
                    onClick={async () => {
                      setOnboardBusy(true);
                      try {
                        const r = await fetch('/api/market/seller/onboard', { method: 'POST', credentials: 'include' });
                        const j = await r.json().catch(() => ({} as { url?: string }));
                        if (r.ok && j.url) { window.location.href = j.url; return; }
                        alert('Stripe onboarding failed: ' + ((j as { error?: string }).error || r.status));
                      } catch (e) {
                        alert('Stripe onboarding failed: ' + (e instanceof Error ? e.message : String(e)));
                      } finally {
                        setOnboardBusy(false);
                      }
                    }}
                  >
                    {onboardBusy ? '…' : '💳 Set up cash payouts'}
                  </button>
                </>
              )}
              {sellerStatus?.has_account && !sellerStatus.charges_enabled && (
                <>
                  <div style={{ marginBottom: 10 }}>
                    <span className="pill warn">Verification pending</span>
                  </div>
                  <p style={{ color: 'var(--text-2)', fontSize: 13, marginTop: 0, marginBottom: 12, lineHeight: 1.5 }}>
                    Stripe is verifying your details.
                  </p>
                  <button
                    type="button"
                    className="ghost-btn"
                    disabled={onboardBusy}
                    onClick={async () => {
                      setOnboardBusy(true);
                      try {
                        const r = await fetch('/api/market/seller/onboard', { method: 'POST', credentials: 'include' });
                        const j = await r.json().catch(() => ({} as { url?: string }));
                        if (r.ok && j.url) { window.location.href = j.url; return; }
                        alert('Could not resume onboarding: ' + ((j as { error?: string }).error || r.status));
                      } catch (e) {
                        alert('Could not resume onboarding: ' + (e instanceof Error ? e.message : String(e)));
                      } finally {
                        setOnboardBusy(false);
                      }
                    }}
                  >
                    {onboardBusy ? '…' : 'Resume onboarding'}
                  </button>
                </>
              )}
              {sellerStatus?.has_account && sellerStatus.charges_enabled && (
                <>
                  <div style={{ marginBottom: 12 }}>
                    <span className="pill success">Payouts active</span>
                  </div>
                  <button
                    type="button"
                    className="ghost-btn"
                    disabled={onboardBusy}
                    onClick={async () => {
                      setOnboardBusy(true);
                      try {
                        const r = await fetch('/api/market/seller/dashboard', { method: 'POST', credentials: 'include' });
                        const j = await r.json().catch(() => ({} as { url?: string }));
                        if (r.ok && j.url) { window.open(j.url, '_blank', 'noopener,noreferrer'); return; }
                        alert('Could not open Stripe dashboard: ' + ((j as { error?: string }).error || r.status));
                      } catch (e) {
                        alert('Could not open Stripe dashboard: ' + (e instanceof Error ? e.message : String(e)));
                      } finally {
                        setOnboardBusy(false);
                      }
                    }}
                  >
                    {onboardBusy ? '…' : 'Open Stripe dashboard'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Replies from support — the admin's response to any contact-form
          message you sent. Stored on the platform, never delivered to
          email, so the admin's perso address stays private. Always
          rendered so the user can see the section exists even before
          any reply lands. */}
      <div className="card" style={{ marginBottom: 24 }}>
        <h3 style={{ marginTop: 0, marginBottom: 12 }}>Replies from support</h3>
        {replies.length === 0 ? (
          <p style={{ color: 'var(--text-2)', fontSize: 13, margin: 0 }}>
            No replies yet. When the support team responds to a message you sent via the in-app
            <strong> About → Contact us</strong> form, their reply will appear here.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {replies.map((r) => (
              <div key={r.id} style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 14 }}>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{r.subject}</div>
                <div style={{ color: 'var(--text-2)', fontSize: 11, marginBottom: 10 }}>
                  You wrote on {new Date(r.created_at).toLocaleString('fr')} · replied {new Date(r.replied_at).toLocaleString('fr')}
                </div>
                <details>
                  <summary style={{ cursor: 'pointer', color: 'var(--text-2)', fontSize: 12, marginBottom: 8 }}>Your message</summary>
                  <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--bg-1)', padding: 10, borderRadius: 6, fontSize: 12, fontFamily: 'inherit', margin: '8px 0 0' }}>{r.message}</pre>
                </details>
                <div style={{ marginTop: 10, padding: 10, background: 'rgba(76,175,80,0.1)', borderLeft: '3px solid var(--ok)', borderRadius: '0 6px 6px 0' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 4 }}>Reply</div>
                  <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13, fontFamily: 'inherit', margin: 0 }}>{r.reply_body}</pre>
                </div>
              </div>
            ))}
          </div>
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
