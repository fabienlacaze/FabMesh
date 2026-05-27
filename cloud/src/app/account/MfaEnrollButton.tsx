'use client';
// MFA TOTP enrolment on the user's own account. Calls Supabase JS
// directly (auth.mfa.enroll + challengeAndVerify) — Supabase persists
// the factor in their auth.mfa_factors table and gates future logins
// on a TOTP code.
//
// Three UI states:
//   - idle:    "Enable two-factor auth" button + current factor status
//   - enroll:  QR + 6-digit input
//   - error:   shown inline, user can retry

import { useEffect, useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';

type Factor = { id: string; status: 'verified' | 'unverified'; created_at: string };

export function MfaEnrollButton() {
  const [factors, setFactors] = useState<Factor[]>([]);
  const [mode, setMode] = useState<'idle' | 'enrolling' | 'busy'>('idle');
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const sb = () => createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );

  async function refresh() {
    try {
      const { data, error } = await sb().auth.mfa.listFactors();
      if (error) throw error;
      // Cleanup: drop unverified leftovers (enrol started but never confirmed).
      const totp = (data?.totp ?? []) as Factor[];
      setFactors(totp);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => { refresh(); }, []);

  async function startEnroll() {
    setError(null); setInfo(null); setMode('busy');
    try {
      // Clean stale unverified factors first — Supabase otherwise
      // errors "factor already exists" on retry.
      for (const f of factors) {
        if (f.status === 'unverified') {
          await sb().auth.mfa.unenroll({ factorId: f.id }).catch(() => {});
        }
      }
      const { data, error } = await sb().auth.mfa.enroll({ factorType: 'totp' });
      if (error) throw error;
      setQrSvg(data.totp.qr_code);
      setSecret(data.totp.secret);
      setFactorId(data.id);
      setMode('enrolling');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMode('idle');
    }
  }

  async function confirmEnroll(e: React.FormEvent) {
    e.preventDefault();
    if (!factorId) return;
    setError(null); setMode('busy');
    try {
      const { error } = await sb().auth.mfa.challengeAndVerify({
        factorId, code: code.trim(),
      });
      if (error) throw error;
      setMode('idle');
      setQrSvg(null); setSecret(null); setFactorId(null); setCode('');
      setInfo('Two-factor authentication enabled. Future sign-ins will require a code from your authenticator app.');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMode('enrolling');
    }
  }

  async function disable(id: string) {
    if (!window.confirm('Disable two-factor authentication? You will only need your password on future sign-ins.')) return;
    setError(null); setMode('busy');
    try {
      const { error } = await sb().auth.mfa.unenroll({ factorId: id });
      if (error) throw error;
      setInfo('Two-factor authentication disabled.');
      await refresh();
      setMode('idle');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMode('idle');
    }
  }

  const verified = factors.find((f) => f.status === 'verified');

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <h3 style={{ marginTop: 0, marginBottom: 8 }}>🔐 Two-factor authentication</h3>
      <p style={{ color: 'var(--text-2)', fontSize: 13, marginBottom: 14, lineHeight: 1.5 }}>
        Adds a 6-digit code from your phone (Microsoft Authenticator, Google
        Authenticator, Authy…) on top of your password. Strongly recommended.
      </p>

      {verified && mode === 'idle' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ color: '#4cd964', fontWeight: 600 }}>✓ Enabled</span>
          <span style={{ color: 'var(--text-2)', fontSize: 12 }}>
            Enrolled {new Date(verified.created_at).toLocaleDateString()}
          </span>
          <button type="button" className="ghost-btn"
                  style={{ marginLeft: 'auto', color: 'var(--err)', borderColor: 'var(--err)' }}
                  onClick={() => disable(verified.id)}>
            Disable 2FA
          </button>
        </div>
      )}

      {!verified && mode === 'idle' && (
        <button type="button" className="primary-btn" onClick={startEnroll}>
          Enable two-factor auth
        </button>
      )}

      {mode === 'enrolling' && (
        <form onSubmit={confirmEnroll}>
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 14 }}>
            {qrSvg && (
              <div style={{ background: '#fff', padding: 10, borderRadius: 8 }}
                   dangerouslySetInnerHTML={{ __html: qrSvg }} />
            )}
            <div style={{ flex: 1, minWidth: 220 }}>
              <p style={{ color: 'var(--text-2)', fontSize: 13, marginBottom: 8 }}>
                1. Open your authenticator app → Add account → Scan QR.
              </p>
              {secret && (
                <details style={{ color: 'var(--text-2)', fontSize: 12, marginBottom: 12 }}>
                  <summary style={{ cursor: 'pointer' }}>Can't scan? Enter the secret manually</summary>
                  <code style={{ display: 'block', marginTop: 6, padding: '6px 8px', background: 'var(--bg-2)', borderRadius: 6, wordBreak: 'break-all', fontSize: 12 }}>
                    {secret}
                  </code>
                </details>
              )}
              <label style={{ fontSize: 13, fontWeight: 600 }}>2. Enter the 6-digit code:</label>
              <input
                type="text" inputMode="numeric" pattern="\d{6}" maxLength={6}
                autoComplete="one-time-code" required autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="123 456"
                style={{ width: '100%', padding: '10px 14px', background: 'var(--bg-2)', color: 'var(--text-0)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 18, letterSpacing: 6, textAlign: 'center', fontVariantNumeric: 'tabular-nums', marginTop: 6 }}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="primary-btn" disabled={code.length !== 6}>
              Confirm and enable
            </button>
            <button type="button" className="ghost-btn" onClick={() => {
              setMode('idle'); setQrSvg(null); setSecret(null); setFactorId(null); setCode('');
            }}>Cancel</button>
          </div>
        </form>
      )}

      {info  && <div className="banner ok" style={{ marginTop: 12 }}>{info}</div>}
      {error && <div className="banner error" style={{ marginTop: 12 }}>⚠ {error}</div>}
    </div>
  );
}
