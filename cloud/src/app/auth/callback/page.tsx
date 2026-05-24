'use client';

// Handles the PKCE magic-link callback ENTIRELY on the client. Why:
// Supabase's PKCE flow stores the `code_verifier` in localStorage at
// sign-in time. The Worker handler we used before tried to exchange
// the code server-side without that verifier and silently failed, so
// users were bounced back to /login.
//
// The browser SDK picks up the verifier automatically from
// localStorage, calls /auth/v1/token?grant_type=pkce with the right
// payload, then persists the session in a cookie that the Worker can
// read on subsequent /api/* calls.

import { useEffect, useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';

export default function AuthCallbackPage() {
  const [status, setStatus] = useState<'working' | 'ok' | 'error'>('working');
  const [message, setMessage] = useState('Signing you in…');

  useEffect(() => {
    (async () => {
      try {
        const sb = createBrowserClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        );

        const url = new URL(window.location.href);
        const code = url.searchParams.get('code');
        const next = url.searchParams.get('next') || '/account';

        if (code) {
          const { error } = await sb.auth.exchangeCodeForSession(code);
          if (error) throw error;
        } else {
          // Fall back to implicit flow — tokens come back in the hash
          // fragment (#access_token=…). The SDK reads them on init.
          const { data, error } = await sb.auth.getSession();
          if (error) throw error;
          if (!data.session) throw new Error('No session');
        }

        setStatus('ok');
        setMessage('Signed in — redirecting…');
        window.location.replace(next);
      } catch (err: unknown) {
        setStatus('error');
        setMessage(
          err instanceof Error ? err.message : String(err),
        );
      }
    })();
  }, []);

  return (
    <main style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ textAlign: 'center', maxWidth: 420 }}>
        <div style={{ fontSize: 42, marginBottom: 12 }}>
          {status === 'working' ? '⏳' : status === 'ok' ? '✓' : '⚠'}
        </div>
        <h2 style={{ marginBottom: 8 }}>
          {status === 'error' ? 'Sign-in failed' : 'MyFabmesh.AI'}
        </h2>
        <p style={{ color: 'var(--text-2)', fontSize: 14, lineHeight: 1.6 }}>
          {message}
        </p>
        {status === 'error' && (
          <a href="/login" style={{ color: '#a855f7', marginTop: 16, display: 'inline-block' }}>
            ← Back to sign in
          </a>
        )}
      </div>
    </main>
  );
}
