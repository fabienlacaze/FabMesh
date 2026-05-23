import { GenerateClient } from './GenerateClient';
import { getSessionUser } from '@/lib/auth';
import { redirect } from 'next/navigation';

export default async function GeneratePage() {
  const user = await getSessionUser();
  if (!user) {
    // For the beta, we still allow visit (form pre-filled) — but block submit
    // server-side. The client component handles the redirect on action.
  }
  return (
    <div className="container" style={{ padding: '40px 0' }}>
      <h1>Générer un mesh</h1>
      <p className="muted" style={{ marginBottom: 24 }}>
        Image de référence → mesh 3D GLB. {user ? <>Tu as <strong>{user.credits}</strong> crédits.</> : <>Connecte-toi pour commencer.</>}
      </p>
      <GenerateClient initialCredits={user?.credits ?? 0} isLoggedIn={!!user} />
    </div>
  );
}
