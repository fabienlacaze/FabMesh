'use client';
import { useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';

export function LoginForm() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const sb = createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      );
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) throw error;
      setSent(true);
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  if (sent) return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 48, marginBottom: 8 }}>✉</div>
      <h3>Vérifie ta boîte mail</h3>
      <p className="muted" style={{ fontSize: 14 }}>
        Un lien de connexion a été envoyé à <strong>{email}</strong>.
      </p>
    </div>
  );

  return (
    <form onSubmit={submit}>
      <label>Email</label>
      <input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="toi@studio.com"
        style={{ width: '100%', marginBottom: 12 }}
      />
      <button type="submit" disabled={busy} style={{ width: '100%' }}>
        {busy ? '…' : 'Recevoir le lien magique'}
      </button>
      {error && <div style={{ color: 'var(--bad)', marginTop: 12, fontSize: 13 }}>⚠ {error}</div>}
    </form>
  );
}
