'use client';
//
// Home page — was a server component calling getSessionUser() to redirect
// authenticated users to /app/. For static export we do the same check on
// the client: fetch /api/me, then navigate.
//
import Link from 'next/link';
import { useEffect, useState } from 'react';

export default function HomePage() {
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/me')
      .then(r => r.ok ? r.json() : { user: null })
      .then(j => {
        if (cancelled) return;
        if (j.user) window.location.href = '/app/';
        else setChecking(false);
      })
      .catch(() => { if (!cancelled) setChecking(false); });
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
