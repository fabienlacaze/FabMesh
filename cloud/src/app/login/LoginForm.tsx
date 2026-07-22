'use client';
import { useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';

const MOCK = process.env.NEXT_PUBLIC_MOCK === '1';

/** Map raw Supabase/auth errors to clear, user-facing messages. Falls back to
 *  the original text for anything unrecognized. The signup email-send failure
 *  ("Error sending confirmation email") is the common one when the SMTP relay
 *  is misconfigured — surface something actionable instead of the raw string. */
function friendlyAuthError(raw: string): string {
  const m = (raw || '').toLowerCase();
  if (m.includes('sending') && m.includes('email')) {
    return "We couldn't send the verification email right now (the email service is temporarily unavailable). Please try again in a minute — if it keeps failing, contact us.";
  }
  if (m.includes('already registered') || m.includes('already been registered') || m.includes('user already exists')) {
    return 'This email is already registered — use "Sign in" instead (or reset your password).';
  }
  if (m.includes('invalid login credentials')) {
    return 'Incorrect email or password.';
  }
  if (m.includes('email not confirmed')) {
    return "Your email isn't verified yet — check your inbox (and spam) for the 6-digit code.";
  }
  if (m.includes('rate limit') || m.includes('too many') || m.includes('for security purposes')) {
    return 'Too many attempts — please wait a minute and try again.';
  }
  if (m.includes('otp_expired') || (m.includes('token') && (m.includes('expired') || m.includes('invalid')))) {
    return 'That code is invalid or has expired — request a new one.';
  }
  return raw;
}

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
  const [showPassword, setShowPassword] = useState(false);
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
    // Land in the app on the projects listing (nicer than the bare /account
    // page), unless an explicit ?next= was provided.
    const next = new URLSearchParams(window.location.search).get('next') || '/app/#/projects';
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
      setError(friendlyAuthError(err instanceof Error ? err.message : String(err)));
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
      setError(friendlyAuthError(err instanceof Error ? err.message : String(err)));
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
      setError(friendlyAuthError(err instanceof Error ? err.message : String(err)));
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
      setError(friendlyAuthError(err instanceof Error ? err.message : String(err)));
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
      <div style={{ position: 'relative', marginBottom: 14 }}>
        <input type={showPassword ? 'text' : 'password'} required value={password}
               onChange={(e) => setPassword(e.target.value)}
               placeholder={isSignUp ? 'Choose a password (6+ characters)' : 'Your password'}
               autoComplete={isSignUp ? 'new-password' : 'current-password'}
               minLength={6}
               style={{ width: '100%', paddingRight: 44, boxSizing: 'border-box', margin: 0 }} />
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
