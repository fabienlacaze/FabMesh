'use client';
import { useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';

const MOCK = process.env.NEXT_PUBLIC_MOCK === '1';

// Two-step sign-in:
//   1. User enters email → server emails them a 6-digit code (+ a magic
//      link as backup).
//   2. User pastes the code → SDK exchanges it for a session in THIS
//      browser (no cross-browser failure mode like PKCE has).
//
// Why not just the magic link? Supabase forces PKCE on magic links since
// gotrue 2.155+, which stores a code_verifier in this browser's storage.
// If the user clicks the mail from a different browser (Outlook desktop
// opening the system default browser, for instance), the verifier is
// missing and sign-in fails. OTP codes have no such state.
export function LoginForm() {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function client() {
    return createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
  }

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (MOCK) {
        const r = await fetch('/api/mock-login', {
          method: 'POST', body: JSON.stringify({ email }),
          headers: { 'Content-Type': 'application/json' },
        });
        if (!r.ok) throw new Error('mock login failed');
        window.location.href = new URLSearchParams(window.location.search).get('next') || '/';
        return;
      }
      const { error } = await client().auth.signInWithOtp({
        email,
        options: {
          // The magic link inside the email still works as a fallback,
          // but the recipient will see the 6-digit code rendered above
          // it in the branded template.
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) throw error;
      setStep('code');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      // Codes from sb.auth.signInWithOtp() are 'email' type for brand-new
      // signups and 'magiclink' for existing users. Try 'email' first
      // (covers both signup and OTP-code), fall back to 'magiclink' if
      // Supabase returns "Invalid OTP type".
      const sb = client();
      let res = await sb.auth.verifyOtp({ email, token: code.trim(), type: 'email' });
      if (res.error) {
        res = await sb.auth.verifyOtp({ email, token: code.trim(), type: 'magiclink' });
      }
      if (res.error) throw res.error;
      if (!res.data.session) throw new Error('Verification succeeded but no session was returned.');
      const next = new URLSearchParams(window.location.search).get('next') || '/account';
      window.location.href = next;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  if (step === 'code') return (
    <form onSubmit={verifyCode}>
      <div style={{ textAlign: 'center', marginBottom: 18 }}>
        <div style={{ fontSize: 42, marginBottom: 6 }}>✉</div>
        <h3 style={{ marginBottom: 4 }}>Check your inbox</h3>
        <p style={{ color: 'var(--text-2)', fontSize: 13 }}>
          We sent a 6-digit code to <strong>{email}</strong>.<br />
          Paste it below to sign in.
        </p>
      </div>
      <label>Sign-in code</label>
      <input
        type="text" required
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        placeholder="123456"
        style={{
          marginBottom: 14, fontSize: 22, letterSpacing: 8,
          textAlign: 'center', fontVariantNumeric: 'tabular-nums',
        }}
        autoFocus
      />
      <button type="submit" className="primary-btn" disabled={busy || code.length !== 6} style={{ width: '100%' }}>
        {busy ? '…' : 'Verify code'}
      </button>
      <button
        type="button"
        onClick={() => { setStep('email'); setCode(''); setError(null); }}
        style={{
          background: 'transparent', border: 'none', color: 'var(--text-2)',
          marginTop: 12, fontSize: 13, cursor: 'pointer', width: '100%',
        }}
      >
        ← Use a different email
      </button>
      {error && <div className="banner error" style={{ marginTop: 12 }}>⚠ {error}</div>}
    </form>
  );

  return (
    <form onSubmit={sendCode}>
      {MOCK && (
        <div className="banner warn">
          🛠 <strong>DEV MODE</strong> · Instant login · 50 credits offered · No real email sent
        </div>
      )}
      <label>Email</label>
      <input
        type="email" required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@studio.com"
        style={{ marginBottom: 14 }}
      />
      <button type="submit" className="primary-btn" disabled={busy} style={{ width: '100%' }}>
        {busy ? '…' : MOCK ? 'Instant sign in' : 'Email me a sign-in code'}
      </button>
      {error && <div className="banner error" style={{ marginTop: 12 }}>⚠ {error}</div>}
    </form>
  );
}
