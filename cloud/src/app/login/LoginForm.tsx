'use client';
import { useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';

const MOCK = process.env.NEXT_PUBLIC_MOCK === '1';

/**
 * Email + password sign-in (the classic flow).
 *
 * - "Sign in":   email + password → session
 * - "Sign up":   email + password → Supabase emails a 6-digit OTP
 *                code to verify ownership → user pastes code → session
 *                (created with the password they chose, no second prompt)
 * - "Forgot password": email → Supabase emails a reset link
 *
 * Returning users only ever see email + password. Codes are involved
 * only on initial signup and password reset.
 */
type Mode = 'signin' | 'signup' | 'verify' | 'forgot' | 'forgot-sent';

export function LoginForm() {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);  // signup gate: ToS/Privacy + age

  function client() {
    return createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
  }

  /** Hand the Supabase session off to the Worker so it can mint an
   *  HttpOnly cookie. The Worker validates the access_token against
   *  Supabase /auth/v1/user before setting the cookie, then mirrors
   *  the access_token in mfm-session (HttpOnly+Secure+SameSite=Strict)
   *  and the refresh_token in mfm-refresh.
   *
   *  This replaces the previous client-side document.cookie write —
   *  the JWT is now unreachable from any JS context (XSS-safe). */
  async function persistSession(session: { access_token: string; refresh_token?: string; expires_in?: number; expires_at?: number; token_type?: string; user?: unknown }) {
    const r = await fetch('/api/auth/install-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_in: session.expires_in,
      }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error('cookie install failed: ' + ((j as { error?: string }).error || r.status));
    }
  }

  function navigateAfterAuth() {
    const next = new URLSearchParams(window.location.search).get('next') || '/account';
    window.location.href = next;
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setInfo(null);
    try {
      if (MOCK) {
        const r = await fetch('/api/mock-login', {
          method: 'POST', body: JSON.stringify({ email }),
          headers: { 'Content-Type': 'application/json' },
        });
        if (!r.ok) throw new Error('mock login failed');
        navigateAfterAuth();
        return;
      }
      const { data, error } = await client().auth.signInWithPassword({ email, password });
      if (error) throw error;
      if (!data.session) throw new Error('Sign-in succeeded but no session was returned.');
      await persistSession(data.session);
      navigateAfterAuth();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setInfo(null);
    if (password.length < 6) {
      setBusy(false);
      setError('Password must be at least 6 characters.');
      return;
    }
    if (!consent) {
      setBusy(false);
      setError('Please confirm your age and accept the Terms and Privacy Policy.');
      return;
    }
    try {
      const { data, error } = await client().auth.signUp({
        email, password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
          // GDPR: record the timestamped consent + age attestation on the user.
          data: {
            tos_accepted: true,
            tos_version: 'v1',
            tos_accepted_at: new Date().toISOString(),
            age_confirmed_16: true,
          },
        },
      });
      if (error) throw error;
      // If email confirmation is required (default in Supabase), we don't
      // get a session — we get a "check your inbox" state instead.
      if (data.session) {
        await persistSession(data.session);
        navigateAfterAuth();
        return;
      }
      setMode('verify');
      setInfo('Account created. Check your inbox for a 6-digit code to verify your email.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setInfo(null);
    try {
      const sb = client();
      // For a brand-new signup, the OTP type is "signup".
      let res = await sb.auth.verifyOtp({ email, token: code.trim(), type: 'signup' });
      if (res.error) {
        // Fallback for users whose Supabase project sends "email" type instead.
        res = await sb.auth.verifyOtp({ email, token: code.trim(), type: 'email' });
      }
      if (res.error) throw res.error;
      if (!res.data.session) throw new Error('Verification succeeded but no session was returned.');
      await persistSession(res.data.session);
      navigateAfterAuth();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setInfo(null);
    try {
      const { error } = await client().auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/reset-password`,
      });
      if (error) throw error;
      setMode('forgot-sent');
      // CRITICAL: do NOT instruct the user to "click the link in the
      // email" — Outlook SafeLinks blocks Supabase auth URLs as
      // "unsafe" (the email domain `onboarding@resend.dev` has poor
      // reputation + the Supabase callback URL is unknown to Outlook),
      // which locks every hotmail/outlook user out of password reset.
      // The 6-digit code path works in 100% of cases — that's what we
      // direct people to.
      setInfo(`We sent a 6-digit code to ${email}. Open the email (check spam too) and enter the code on the next screen.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  // -------------------------------------------------------------------

  if (mode === 'verify') return (
    <form onSubmit={handleVerifyCode}>
      <div style={{ textAlign: 'center', marginBottom: 18 }}>
        <div style={{ fontSize: 42, marginBottom: 6 }}>✉</div>
        <h3 style={{ marginBottom: 4 }}>Verify your email</h3>
        <p style={{ color: 'var(--text-2)', fontSize: 13 }}>
          We sent a 6-digit code to <strong>{email}</strong>.<br />
          Paste it below to confirm your account.
        </p>
      </div>
      <label>Verification code</label>
      <input
        type="text" required inputMode="numeric" autoComplete="one-time-code"
        pattern="[0-9]{6}" maxLength={6}
        value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        placeholder="123456"
        style={{ marginBottom: 14, fontSize: 22, letterSpacing: 8, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}
        autoFocus
      />
      <button type="submit" className="primary-btn" disabled={busy || code.length !== 6} style={{ width: '100%' }}>
        {busy ? '…' : 'Confirm account'}
      </button>
      <button type="button" onClick={() => { setMode('signin'); setCode(''); setError(null); setInfo(null); }}
              style={{ background: 'transparent', border: 'none', color: 'var(--text-2)', marginTop: 12, fontSize: 13, cursor: 'pointer', width: '100%' }}>
        ← Back to sign in
      </button>
      {info && <div className="banner ok" style={{ marginTop: 12 }}>{info}</div>}
      {error && <div className="banner error" style={{ marginTop: 12 }}>⚠ {error}</div>}
    </form>
  );

  if (mode === 'forgot') return (
    <form onSubmit={handleForgot}>
      <h3 style={{ marginBottom: 6 }}>Reset your password</h3>
      <p style={{ color: 'var(--text-2)', fontSize: 13, marginBottom: 18 }}>
        Enter your account email — we&apos;ll send you a reset link.
      </p>
      <label>Email</label>
      <input type="email" required value={email}
             onChange={(e) => setEmail(e.target.value)}
             placeholder="you@studio.com"
             style={{ marginBottom: 14 }} autoFocus />
      <button type="submit" className="primary-btn" disabled={busy} style={{ width: '100%' }}>
        {busy ? '…' : 'Send reset link'}
      </button>
      <button type="button" onClick={() => { setMode('signin'); setError(null); setInfo(null); }}
              style={{ background: 'transparent', border: 'none', color: 'var(--text-2)', marginTop: 12, fontSize: 13, cursor: 'pointer', width: '100%' }}>
        ← Back to sign in
      </button>
      {error && <div className="banner error" style={{ marginTop: 12 }}>⚠ {error}</div>}
    </form>
  );

  if (mode === 'forgot-sent') return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 42, marginBottom: 8 }}>✉</div>
      <h3 style={{ marginBottom: 6 }}>Check your inbox</h3>
      <p style={{ color: 'var(--text-2)', fontSize: 13, marginBottom: 18 }}>{info}</p>
      {/* Primary CTA = the code path. Don't rely on clicking the email
          link — Outlook SafeLinks blocks Supabase callback URLs and
          locks users out. */}
      <a href="/auth/reset-password" className="primary-btn"
         style={{ width: '100%', display: 'block', boxSizing: 'border-box', textDecoration: 'none' }}>
        I have the code → Enter it
      </a>
      <button type="button" onClick={() => { setMode('signin'); setError(null); setInfo(null); }}
              style={{ width: '100%', marginTop: 10, background: 'transparent',
                       border: 'none', color: 'var(--text-3)', cursor: 'pointer',
                       padding: '8px 0', fontSize: 13 }}>
        ← Back to sign in
      </button>
    </div>
  );

  // signin / signup
  const isSignUp = mode === 'signup';
  return (
    <form onSubmit={isSignUp ? handleSignUp : handleSignIn}>
      {MOCK && (
        <div className="banner warn">
          🛠 <strong>DEV MODE</strong> · Instant login · 50 credits offered · No real email sent
        </div>
      )}
      <label>Email</label>
      <input type="email" required value={email}
             onChange={(e) => setEmail(e.target.value)}
             placeholder="you@studio.com"
             autoComplete="email"
             style={{ marginBottom: 14 }} />
      <label>Password</label>
      <input type="password" required value={password}
             onChange={(e) => setPassword(e.target.value)}
             placeholder={isSignUp ? 'Choose a password (6+ characters)' : 'Your password'}
             autoComplete={isSignUp ? 'new-password' : 'current-password'}
             minLength={6}
             style={{ marginBottom: 14 }} />
      {isSignUp && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '4px 0 14px', fontSize: 12, color: 'var(--text-2)', cursor: 'pointer' }}>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)}
                 style={{ marginTop: 2, flexShrink: 0 }} />
          <span>
            I confirm I am at least 16 years old (or have my guardian&apos;s consent)
            and I accept the{' '}
            <a href="/legal/terms" target="_blank" rel="noopener">Terms of Service</a>{' '}
            and <a href="/legal/privacy" target="_blank" rel="noopener">Privacy Policy</a>.
          </span>
        </label>
      )}
      <button type="submit" className="primary-btn"
              disabled={busy || (isSignUp && !consent)} style={{ width: '100%' }}>
        {busy ? '…' : (isSignUp ? 'Create account' : 'Sign in')}
      </button>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 14, fontSize: 13 }}>
        {isSignUp ? (
          <button type="button" onClick={() => { setMode('signin'); setError(null); setInfo(null); }}
                  style={{ background: 'transparent', border: 'none', color: 'var(--text-2)', cursor: 'pointer', padding: 0 }}>
            ← Have an account? Sign in
          </button>
        ) : (
          <>
            <button type="button" onClick={() => { setMode('signup'); setError(null); setInfo(null); }}
                    style={{ background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0 }}>
              Create an account
            </button>
            <button type="button" onClick={() => { setMode('forgot'); setError(null); setInfo(null); }}
                    style={{ background: 'transparent', border: 'none', color: 'var(--text-2)', cursor: 'pointer', padding: 0 }}>
              Forgot password?
            </button>
          </>
        )}
      </div>

      {info && <div className="banner ok" style={{ marginTop: 12 }}>{info}</div>}
      {error && <div className="banner error" style={{ marginTop: 12 }}>⚠ {error}</div>}
    </form>
  );
}
