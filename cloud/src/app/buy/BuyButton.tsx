'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { PACKS } from '@/lib/packs';

const MOCK = process.env.NEXT_PUBLIC_MOCK === '1';

/* RENONCIATION AU DROIT DE RETRACTATION — Art. L221-28 13° du Code de la
 * consommation.
 *
 * La case vivait en haut de /buy, au-dessus des cartes de prix : le
 * proprietaire lui-meme l'a ratee (« elle est pas assez visible »). Deux
 * defauts en decoulaient. D'abord les boutons « Acheter » restaient desactives
 * sans que rien n'explique pourquoi. Ensuite, et c'est le plus grave, le
 * consentement etait donne AVANT le choix du pack et de facon globale : rien
 * ne rattachait le clic a un achat precis.
 *
 * Il est desormais demande au moment de l'achat, dans une fenetre qui nomme
 * le pack, son prix et son nombre de credits. Le consentement porte alors sur
 * un contrat identifie, ce qu'exige le texte, et il devient impossible a
 * manquer. Le serveur le refuse s'il est absent et en garde la trace dans les
 * metadonnees Stripe (voir handleCheckout). */
export function BuyButton({ packId, loggedIn }: { packId: string; loggedIn: boolean; consented?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [ouvert, setOuvert] = useState(false);
  const [accepte, setAccepte] = useState(false);
  const [erreur, setErreur] = useState('');

  const pack = PACKS[packId as keyof typeof PACKS];

  function demander() {
    if (!loggedIn) { router.push(`/login?next=/buy`); return; }
    setAccepte(false);
    setErreur('');
    setOuvert(true);
  }

  async function payer() {
    if (!accepte) return;
    setBusy(true);
    setErreur('');
    const endpoint = MOCK ? '/api/mock-checkout' : '/api/checkout';
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        // `consent` n'est pas decoratif : le serveur refuse la creation de la
        // session de paiement sans lui, et l'horodate dans Stripe.
        body: JSON.stringify({ packId, consent: true, consentedAt: new Date().toISOString() }),
        headers: { 'Content-Type': 'application/json' },
      });
      const j = await res.json();
      if (j.url) { window.location.href = j.url; return; }
      setBusy(false);
      setErreur(j.error || 'Erreur lors du paiement.');
    } catch (e) {
      setBusy(false);
      setErreur(e instanceof Error ? e.message : 'Erreur réseau.');
    }
  }

  return (
    <>
      <button onClick={demander} disabled={busy} className="primary-btn" style={{ width: '100%' }}>
        {busy ? '…' : MOCK ? 'Ajouter des crédits (DEV)' : 'Acheter'}
      </button>

      {ouvert && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={`consent-titre-${packId}`}
          onClick={(e) => { if (e.target === e.currentTarget && !busy) setOuvert(false); }}
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(0,0,0,.72)', backdropFilter: 'blur(3px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}
        >
          <div
            style={{
              background: 'var(--bg-1, #16161c)', border: '1px solid var(--border, #333)',
              borderRadius: 14, maxWidth: 520, width: '100%', padding: '26px 26px 22px',
              boxShadow: '0 20px 60px rgba(0,0,0,.6)', textAlign: 'left',
            }}
          >
            <h3 id={`consent-titre-${packId}`} style={{ margin: '0 0 6px', fontSize: 19 }}>
              Confirmez votre achat
            </h3>

            {pack && (
              <div
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                  gap: 12, margin: '14px 0 18px', padding: '12px 14px',
                  background: 'var(--bg-2, #1e1e26)', borderRadius: 10,
                }}
              >
                <span style={{ fontWeight: 600 }}>{pack.name}</span>
                <span style={{ color: 'var(--text-2)' }}>{pack.credits} crédits</span>
                <span style={{ fontWeight: 700, fontSize: 18 }}>{pack.euros} € TTC</span>
              </div>
            )}

            {/* Le consentement lui-meme. Encadre, sur fond distinct : c'est la
                seule chose a lire dans cette fenetre. */}
            <label
              style={{
                display: 'flex', gap: 12, alignItems: 'flex-start', cursor: 'pointer',
                padding: '14px 16px', borderRadius: 10, lineHeight: 1.55, fontSize: 13.5,
                border: `2px solid ${accepte ? 'var(--accent, #a855f7)' : 'rgba(255,170,51,.55)'}`,
                background: accepte ? 'rgba(168,85,247,.08)' : 'rgba(255,170,51,.07)',
                transition: 'border-color .15s, background .15s',
              }}
            >
              <input
                type="checkbox"
                checked={accepte}
                onChange={(e) => setAccepte(e.target.checked)}
                style={{ marginTop: 3, width: 17, height: 17, flexShrink: 0, cursor: 'pointer' }}
              />
              <span>
                Je demande expressément que mes crédits soient mis à ma disposition
                immédiatement, et je reconnais que dès que je commence à consommer un
                crédit ou que je génère un asset, je{' '}
                <strong>perds mon droit de rétractation de 14 jours</strong> sur ce
                contenu numérique (art. L. 221-28 13° du code de la consommation).
                Voir les <a href="/legal/terms" target="_blank" rel="noreferrer">conditions générales de vente</a>.
              </span>
            </label>

            <p style={{ fontSize: 12, color: 'var(--text-2)', margin: '12px 0 0' }}>
              Les crédits non consommés restent remboursables pendant 14 jours.
            </p>

            {erreur && (
              <p style={{ color: '#ff6b6b', fontSize: 13, margin: '12px 0 0' }}>{erreur}</p>
            )}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
              <button className="ghost-btn" onClick={() => setOuvert(false)} disabled={busy}>
                Annuler
              </button>
              <button
                className="primary-btn"
                onClick={payer}
                disabled={!accepte || busy}
                title={accepte ? '' : 'Cochez la case ci-dessus pour continuer'}
              >
                {busy ? '…' : `Confirmer et payer${pack ? ` ${pack.euros} €` : ''}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
