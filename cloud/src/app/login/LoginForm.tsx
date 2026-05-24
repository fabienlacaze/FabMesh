'use client';
import { useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';

const MOCK = process.env.NEXT_PUBLIC_MOCK === '1';

export function LoginForm() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
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
      const sb = createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        // Force implicit flow: PKCE stores a per-browser code_verifier
        // in localStorage at sign-in time, which breaks when the user
        // clicks the mail in a different browser than the one where
        // they entered their email (very common with desktop webmail).
        // Implicit flow puts the access_token straight in the URL hash,
        // so any browser can complete the sign-in.
        { auth: { flowType: 'implicit' } },
      );
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) throw error;
      setSent(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  if (sent) return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 42, marginBottom: 8 }}>✉</div>
      <h3 style={{ marginBottom: 6 }}>Check your inbox</h3>
      <p style={{ color: 'var(--text-2)', fontSize: 13 }}>
        A sign-in link has been sent to <strong>{email}</strong>.
      </p>
    </div>
  );

  return (
    <form onSubmit={submit}>
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
        {busy ? '…' : MOCK ? 'Instant sign in' : 'Send magic link'}
      </button>
      {error && <div className="banner error" style={{ marginTop: 12 }}>⚠ {error}</div>}
    </form>
  );
}
