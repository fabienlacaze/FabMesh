'use client';
//
// Home page — was a server component calling getSessionUser() to redirect
// authenticated users to /app/. For static export we do the same check on
// the client: fetch /api/me, then navigate.
//
// Also handles the case where Supabase redirects here with #access_token=…
// in the URL hash (implicit flow for magic links that bypass our /auth/
// callback PKCE handler). We init the Supabase JS SDK so it picks up the
// hash, writes the session cookie, then bounces to /account.
//
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';

export default function HomePage() {
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 1) If Supabase dropped us here with an implicit-flow token in the
        //    hash, let the SDK absorb it (it persists into cookies for
        //    @supabase/ssr) then forward to /account where the Worker can
        //    read the session.
        if (typeof window !== 'undefined' && window.location.hash.includes('access_token')) {
          const sb = createBrowserClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
          );
          await sb.auth.getSession();
          if (cancelled) return;
          // Strip the hash so a reload doesn't loop here.
          window.history.replaceState(null, '', window.location.pathname);
          window.location.replace('/account');
          return;
        }

        // 2) Normal path: ask the Worker whether the cookie is valid.
        const r = await fetch('/api/me');
        const j = r.ok ? await r.json() : { user: null };
        if (cancelled) return;
        if (j.user) window.location.href = '/app/';
        else setChecking(false);
      } catch {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (checking) {
    return <div className="page" style={{ textAlign: 'center', paddingTop: 80 }}>…</div>;
  }
  return (
    <div className="page" style={{ textAlign: 'center', paddingTop: 80 }}>
      <h1 style={{ marginBottom: 12 }}>MyFabmesh.AI <span style={{ color: 'var(--accent)' }}>Cloud</span></h1>
      <p style={{ color: 'var(--text-2)', marginBottom: 32 }}>
        Generate game-ready 3D meshes from a single image — same UI as Desktop, on cloud GPU.
      </p>
      <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
        <Link href="/login" className="primary-btn">Sign in / Sign up</Link>
        <Link href="https://fabienlacaze.github.io/MyFabmesh" target="_blank" className="ghost-btn">
          Visit MyFabmesh.AI site →
        </Link>
      </div>
      <p style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 20 }}>
        Want the local NVIDIA version ? <Link href="https://fabienlacaze.github.io/MyFabmesh">Download Desktop</Link>.
      </p>
    </div>
  );
}
