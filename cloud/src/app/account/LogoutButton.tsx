'use client';
import { createBrowserClient } from '@supabase/ssr';

const MOCK = process.env.NEXT_PUBLIC_MOCK === '1';

export function LogoutButton() {
  async function logout() {
    if (MOCK) {
      await fetch('/api/mock-logout', { method: 'POST' });
    } else {
      const sb = createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      );
      // Supabase SDK clears its own sb-*-auth-token cookies + revokes
      // the JWT server-side. Then we ask our Worker to wipe the
      // HttpOnly mfm-session / mfm-refresh cookies it minted on signin.
      await sb.auth.signOut().catch(() => {});
      await fetch('/api/auth/signout', { method: 'POST', credentials: 'include' }).catch(() => {});
    }
    window.location.href = '/';
  }
  return <button className="ghost" onClick={logout}>Se déconnecter</button>;
}
