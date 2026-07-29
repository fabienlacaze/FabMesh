'use client';

// Password reset landing.
//
// Two paths:
//   1. PKCE link path — Supabase appends ?code=… to the URL. If the
//      SAME browser initiated "Forgot password" we can exchange the
//      code for a session and let the user pick a new password.
//   2. Cross-browser fallback — when the user clicks the email link in
//      a browser different from the one where they typed their email
//      (Outlook desktop → system default browser is the canonical case),
//      the PKCE verifier is missing and step 1 fails. We then show a
//      manual form: email + 6-digit code (from the same email) + new
//      password. We call sb.auth.verifyOtp({ type:'recovery' }) which
//      mints a session without any local verifier.

import { useEffect, useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';

type Mode = 'init' | 'set-password' | 'enter-code';

export default function ResetPasswordPage() {
  const [mode, setMode] = useState<Mode>('init');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  // Œil « afficher le mot de passe », comme sur la page de connexion
  // (LoginForm.tsx). Il manquait ici alors que c'est précisément l'écran
  // où l'on tape un mot de passe NEUF, sans champ de confirmation : sans
  // relecture possible, une faute de frappe ne se découvre qu'à la
  // connexion suivante.
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  function client() {
    return createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
  }

  // On mount, try the PKCE path. If it succeeds we go straight to
  // "set new password". If it fails (cross-browser case), drop into
  // the manual OTP fallback.
  useEffect(() => {
    (async () => {
      try {
        const sb = client();
        const url = new URL(window.location.href);
        const code = url.searchParams.get('code');
        const hasHash = window.location.hash.includes('access_token');

        if (code) {
          const { error } = await sb.auth.exchangeCodeForSession(code);
          if (error) throw error;
          window.history.replaceState(null, '', window.location.pathname);
          setMode('set-password');
          return;
        }
        if (hasHash) {
          await sb.auth.getSession();
          window.history.replaceState(null, '', window.location.pathname);
          setMode('set-password');
          return;
        }
        // No code, no hash — let the user enter their email + the OTP code
        // from the mail manually.
        setMode('enter-code');
      } catch {
        // PKCE failed (cross-browser) — fall back to manual OTP code.
        setMode('enter-code');
      }
    })();
  }, []);

  async function verifyCodeAndStart(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setInfo(null);
    try {
      const { data, error } = await client().auth.verifyOtp({
        email: email.trim(),
        token: code.trim(),
        type: 'recovery',
      });
      if (error) throw error;
      if (!data.session) throw new Error('Code accepted but no session was created.');
      setMode('set-password');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function setNewPassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setInfo(null);
    try {
      if (password.length < 6) throw new Error('Password must be at least 6 characters.');
      const sb = client();
      const { error } = await sb.auth.updateUser({ password });
      if (error) throw error;
      // Pipe the new session through our HttpOnly cookie endpoint so
      // the JWT stops being readable from JS (matches the login flow).
      const { data: sessData } = await sb.auth.getSession();
      if (sessData.session) {
        await fetch('/api/auth/install-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            access_token: sessData.session.access_token,
            refresh_token: sessData.session.refresh_token,
            expires_in: sessData.session.expires_in,
          }),
        }).catch(() => {});
      }
      setInfo('Password updated — redirecting…');
      setTimeout(() => { window.location.replace('/account'); }, 700);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  return (
    <main style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ maxWidth: 420, width: '100%' }}>
        <h2 style={{ marginBottom: 6 }}>Reset your password</h2>
        <p style={{ color: 'var(--text-2)', fontSize: 13, marginBottom: 18 }}>
          Choose a new password for your MyFabmesh.AI account.
        </p>

        {mode === 'init' && (
          <p style={{ color: 'var(--text-2)' }}>Validating link…</p>
        )}

        {mode === 'enter-code' && (
          <form onSubmit={verifyCodeAndStart}>
            <p style={{ color: 'var(--text-2)', fontSize: 13, marginBottom: 14 }}>
              Enter your email and the 6-digit code we sent you to verify your reset request.
            </p>
            <label>Email</label>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
                   placeholder="you@studio.com" autoComplete="email"
                   style={{ marginBottom: 14 }} autoFocus />
            <label>Code from the reset email</label>
            <input type="text" required inputMode="numeric" autoComplete="one-time-code"
                   pattern="[0-9]{6}" maxLength={6}
                   value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                   placeholder="123456"
                   style={{ marginBottom: 14, fontSize: 20, letterSpacing: 6, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }} />
            <button type="submit" className="primary-btn"
                    disabled={busy || code.length !== 6 || !email}
                    style={{ width: '100%' }}>
              {busy ? '…' : 'Verify code'}
            </button>
            <p style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 12, textAlign: 'center' }}>
              No code yet?{' '}
              <a href="/login" style={{ color: 'var(--accent)' }}>request a new reset</a>.
            </p>
            {error && <div className="banner error" style={{ marginTop: 12 }}>⚠ {error}</div>}
          </form>
        )}

        {mode === 'set-password' && (
          <form onSubmit={setNewPassword}>
            <label>New password</label>
            <div style={{ position: 'relative', marginBottom: 14 }}>
              <input type={showPassword ? 'text' : 'password'} required minLength={6}
                     value={password} onChange={(e) => setPassword(e.target.value)}
                     placeholder="At least 6 characters"
                     autoComplete="new-password"
                     style={{ width: '100%', paddingRight: 44, boxSizing: 'border-box', margin: 0 }} autoFocus />
              <button type="button" onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      title={showPassword ? 'Hide password' : 'Show password'}
                      style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                               background: 'none', border: 'none', padding: 4, cursor: 'pointer',
                               color: 'var(--text-2, #8a93b2)', display: 'flex', alignItems: 'center' }}>
                {showPassword ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                )}
              </button>
            </div>
            <button type="submit" className="primary-btn" disabled={busy} style={{ width: '100%' }}>
              {busy ? '…' : 'Set new password'}
            </button>
            {info && <div className="banner ok" style={{ marginTop: 12 }}>{info}</div>}
            {error && <div className="banner error" style={{ marginTop: 12 }}>⚠ {error}</div>}
          </form>
        )}
      </div>
    </main>
  );
}
