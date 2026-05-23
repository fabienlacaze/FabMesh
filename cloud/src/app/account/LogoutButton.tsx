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
      await sb.auth.signOut();
    }
    window.location.href = '/';
  }
  return <button className="ghost" onClick={logout}>Se déconnecter</button>;
}
