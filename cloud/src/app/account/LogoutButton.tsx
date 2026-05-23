'use client';
import { createBrowserClient } from '@supabase/ssr';

export function LogoutButton() {
  async function logout() {
    const sb = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    await sb.auth.signOut();
    window.location.href = '/';
  }
  return <button className="ghost" onClick={logout}>Se déconnecter</button>;
}
