import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth';
import Link from 'next/link';

/**
 * Root route of the Cloud app.
 *
 * - Authenticated users → redirected to /app/ (the ported desktop renderer).
 * - Anonymous users → redirected to the public marketing site
 *   (docs/index.html → fabienlacaze.github.io/MyFabmesh) which has the
 *   Desktop vs Cloud product choice + downloads.
 *
 * We keep a minimal fallback HTML so direct visits to /cloud-myfabmesh.pages.dev
 * land on something useful instead of a 404.
 */
export default async function HomePage() {
  const user = await getSessionUser();
  if (user) redirect('/app/');

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
