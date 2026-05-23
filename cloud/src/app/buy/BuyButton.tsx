'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

const MOCK = process.env.NEXT_PUBLIC_MOCK === '1';

export function BuyButton({ packId, loggedIn }: { packId: string; loggedIn: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function buy() {
    if (!loggedIn) { router.push(`/login?next=/buy`); return; }
    setBusy(true);
    const endpoint = MOCK ? '/api/mock-checkout' : '/api/checkout';
    const res = await fetch(endpoint, {
      method: 'POST',
      body: JSON.stringify({ packId }),
      headers: { 'Content-Type': 'application/json' },
    });
    const j = await res.json();
    if (j.url) window.location.href = j.url;
    else { setBusy(false); alert('Checkout error: ' + (j.error || 'unknown')); }
  }

  return (
    <button onClick={buy} disabled={busy} className="primary-btn" style={{ width: '100%' }}>
      {busy ? '…' : MOCK ? 'Add credits (DEV)' : 'Buy'}
    </button>
  );
}
