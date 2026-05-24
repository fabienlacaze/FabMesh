'use client';
//
// Nav — was a server component (`async function Nav` calling getSessionUser).
// For static export (output: 'export') we can't run server code at request
// time, so it's now a client component that fetches /api/me on mount.
//
import Link from 'next/link';
import { useEffect, useState } from 'react';

const MOCK = process.env.NEXT_PUBLIC_MOCK === '1';

interface User { id: string; email: string | null; credits: number; }

export function Nav() {
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/me')
      .then(r => r.ok ? r.json() : { user: null })
      .then(j => { if (!cancelled) setUser(j.user ?? null); })
      .catch(() => { /* silent — anonymous */ });
    return () => { cancelled = true; };
  }, []);

  return (
    <header className="topbar">
      <div className="topbar-left">
        <Link href="/" className="brand">
          MyFabmesh<span className="brand-ai">.AI</span>
          <span className="brand-cloud">CLOUD</span>
        </Link>
        {MOCK && <span className="pill warn" style={{ marginLeft: 6 }}>DEV MODE</span>}
      </div>
      <div className="topbar-right">
        {user ? (
          <>
            <a href="/app/" className="nav-link">New mesh</a>
            <a href="/app/" className="nav-link">My projects</a>
            <Link href="/buy" className="nav-link">Credits</Link>
            <Link href="/account" className="nav-link" title={user.email ?? ''}>
              {user.email?.split('@')[0]}
            </Link>
            <span className="credits-pill">{user.credits}</span>
          </>
        ) : (
          <>
            <Link href="/buy" className="nav-link">Pricing</Link>
            <Link href="https://fabienlacaze.github.io/MyFabmesh" target="_blank" className="nav-link">Desktop</Link>
            <Link href="/login" className="primary-btn" style={{ height: 32, padding: '6px 16px', fontSize: 12 }}>
              Sign in
            </Link>
          </>
        )}
      </div>
    </header>
  );
}
