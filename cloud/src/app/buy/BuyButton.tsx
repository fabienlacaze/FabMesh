'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function BuyButton({ packId, loggedIn }: { packId: string; loggedIn: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function buy() {
    if (!loggedIn) { router.push(`/login?next=/buy`); return; }
    setBusy(true);
    const res = await fetch('/api/checkout', { method: 'POST', body: JSON.stringify({ packId }), headers: { 'Content-Type': 'application/json' } });
    const j = await res.json();
    if (j.url) window.location.href = j.url;
    else { setBusy(false); alert('Erreur checkout: ' + (j.error || 'unknown')); }
  }

  return (
    <button onClick={buy} disabled={busy} style={{ width: '100%' }}>
      {busy ? '…' : 'Acheter'}
    </button>
  );
}
