'use client';

// Handles the magic-link callback. Two scenarios:
//
// 1) Implicit flow (our default — see LoginForm.tsx) — Supabase sends
//    the user back here with #access_token=… in the URL hash. The
//    @supabase/ssr browser client picks it up on instantiation and
//    writes the session cookie.
//
// 2) PKCE flow — Supabase appends ?code=… as a query param. We try
//    exchangeCodeForSession(code), which only works if the same
//    browser still has the code_verifier in localStorage from
//    sign-in time. If the user clicked the mail in a different
//    browser, this fails — we then send them back to /login.

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
          { auth: { flowType: 'implicit' } },
        );

        const url = new URL(window.location.href);
        const code = url.searchParams.get('code');
        const next = url.searchParams.get('next') || '/account';
        const hasHashToken =
          typeof window !== 'undefined'
          && window.location.hash.includes('access_token');

        if (hasHashToken) {
          // Implicit flow — SDK already absorbed the hash on init.
          // Force a getSession() so the cookie is definitely flushed
          // before we navigate.
          await sb.auth.getSession();
        } else if (code) {
          // PKCE — only works if the same browser holds the verifier.
          const { error } = await sb.auth.exchangeCodeForSession(code);
          if (error) throw error;
        } else {
          // Maybe the SDK already picked things up from the URL.
          const { data, error } = await sb.auth.getSession();
          if (error) throw error;
          if (!data.session) throw new Error('No session in URL');
        }

        // Pipe the freshly-minted session through our HttpOnly cookie
        // endpoint so the JWT stops being readable from JS.
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

        setStatus('ok');
        setMessage('Signed in — redirecting…');
        // Strip query/hash before navigating so a reload doesn't loop.
        window.history.replaceState(null, '', window.location.pathname);
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
      <div style={{ textAlign: 'center', maxWidth: 460 }}>
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
