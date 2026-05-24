'use client';

// Reset-password landing. Supabase's recovery email links here with
// either a #access_token=… hash (implicit) or a ?code=… query (PKCE).
// We let the JS SDK absorb whichever arrives, then show a "set new
// password" form. On submit we updateUser({ password }) and bounce
// back to the workspace.

import { useEffect, useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';

export default function ResetPasswordPage() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  function client() {
    return createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
  }

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
        } else if (hasHash) {
          await sb.auth.getSession();
        } else {
          throw new Error('Missing recovery code. Open the link from the reset email again.');
        }
        // Clean up the URL so a refresh doesn't try the same code twice.
        window.history.replaceState(null, '', window.location.pathname);
        setReady(true);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  async function setNewPassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setInfo(null);
    try {
      if (password.length < 6) throw new Error('Password must be at least 6 characters.');
      const { error } = await client().auth.updateUser({ password });
      if (error) throw error;
      setInfo('Password updated — redirecting…');
      setTimeout(() => { window.location.replace('/account'); }, 700);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  return (
    <main style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ maxWidth: 380, width: '100%' }}>
        <h2 style={{ marginBottom: 6 }}>Reset your password</h2>
        <p style={{ color: 'var(--text-2)', fontSize: 13, marginBottom: 18 }}>
          Choose a new password for your MyFabmesh.AI account.
        </p>

        {!ready && !error && <p style={{ color: 'var(--text-2)' }}>Validating link…</p>}
        {error && <div className="banner error" style={{ marginBottom: 12 }}>⚠ {error}</div>}

        {ready && (
          <form onSubmit={setNewPassword}>
            <label>New password</label>
            <input type="password" required minLength={6}
                   value={password} onChange={(e) => setPassword(e.target.value)}
                   placeholder="At least 6 characters"
                   autoComplete="new-password"
                   style={{ marginBottom: 14 }} autoFocus />
            <button type="submit" className="primary-btn" disabled={busy} style={{ width: '100%' }}>
              {busy ? '…' : 'Set new password'}
            </button>
          </form>
        )}

        {info && <div className="banner ok" style={{ marginTop: 12 }}>{info}</div>}
      </div>
    </main>
  );
}
