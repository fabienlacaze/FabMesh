/**
 * Supabase clients. We use the SSR helper for the App Router so cookies
 * stay in sync between server components, route handlers, and the browser.
 *
 * Two clients :
 *  - `supabaseServer()`     → server-side, reads cookies, RLS applies
 *  - `supabaseAdmin()`      → server-side, service-role key, BYPASSES RLS
 *                             (use only in API routes for credit ops + webhook)
 */
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export async function supabaseServer() {
  const cookieStore = await cookies();
  return createServerClient(URL, ANON, {
    cookies: {
      getAll() { return cookieStore.getAll(); },
      setAll(items: { name: string; value: string; options?: CookieOptions }[]) {
        try {
          items.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options as CookieOptions));
        } catch {
          // Route handlers / server components without write access — ignore.
        }
      },
    },
  });
}

export function supabaseAdmin() {
  return createClient(URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
