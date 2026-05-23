import Link from 'next/link';
import { getSessionUser } from '@/lib/auth';
import { MOCK } from '@/lib/mock-store';

export async function Nav() {
  const user = await getSessionUser();
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
            <Link href="/generate" className="nav-link">New mesh</Link>
            <Link href="/" className="nav-link">My projects</Link>
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
