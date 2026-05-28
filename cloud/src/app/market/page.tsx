'use client';
//
// Public marketplace — anyone (logged in or not) can browse approved
// listings. Look-and-feel mirrors the in-app "Your projects" grid:
// big card with mesh thumbnail, title, author, status pill. Free
// listings are downloadable on click; paid listings are stubbed (we
// surface the price + licence but Stripe wiring is a follow-up).
//
import { useEffect, useState } from 'react';
import Script from 'next/script';

interface Listing {
  id: string;
  title: string;
  description: string;
  price_cents: number;
  currency: string;
  licence: string;
  asset_type: string | null;
  mesh_url: string;
  author_display: string;
  created_at: string;
  downloads: number;
}

const LICENCE_LABELS: Record<string, string> = {
  personal: 'Personal use',
  cc0: 'CC0 (public domain)',
  'cc-by': 'CC-BY 4.0',
  'cc-by-nc': 'CC-BY-NC 4.0',
  commercial: 'Royalty-free commercial',
};

function formatPrice(cents: number, currency: string): string {
  if (cents === 0) return 'Free';
  const amount = (cents / 100).toFixed(2);
  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency + ' ';
  return symbol + amount;
}

export default function MarketPage() {
  const [listings, setListings] = useState<Listing[]>([]);
  const [filtered, setFiltered] = useState<Listing[]>([]);
  const [search, setSearch] = useState('');
  const [filterPrice, setFilterPrice] = useState<'all' | 'free' | 'paid'>('all');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Listing | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/market/list');
        if (r.ok) {
          const j = await r.json();
          setListings(j.listings ?? []);
        }
      } catch {}
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    const q = search.trim().toLowerCase();
    setFiltered(listings.filter((l) => {
      if (filterPrice === 'free' && l.price_cents !== 0) return false;
      if (filterPrice === 'paid' && l.price_cents === 0) return false;
      if (q && !`${l.title} ${l.description} ${l.author_display}`.toLowerCase().includes(q)) return false;
      return true;
    }));
  }, [listings, search, filterPrice]);

  return (
    <div className="page">
      <Script
        src="https://unpkg.com/@google/model-viewer@3.5.0/dist/model-viewer.min.js"
        type="module" strategy="afterInteractive"
      />
      <div className="page-header" style={{ alignItems: 'flex-end', gap: 16 }}>
        <div>
          <h2 style={{ marginBottom: 4 }}>Marketplace</h2>
          <div style={{ color: 'var(--text-2)', fontSize: 13 }}>
            Community-made 3D assets. Free downloads + paid listings under various licences.
          </div>
        </div>
        <input
          type="search"
          placeholder="🔍 Search listings…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ padding: '8px 12px', borderRadius: 999, border: '1px solid var(--border)', background: 'var(--bg-2)', color: 'var(--text-0)', minWidth: 240, fontSize: 13 }}
        />
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
        {(['all', 'free', 'paid'] as const).map((p) => (
          <button
            key={p}
            onClick={() => setFilterPrice(p)}
            className={filterPrice === p ? 'primary-btn' : 'ghost-btn'}
            style={{ padding: '6px 16px', fontSize: 13, textTransform: 'capitalize' }}
          >
            {p === 'all' ? 'All' : p === 'free' ? 'Free' : 'Paid'}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', color: 'var(--text-2)', fontSize: 12, alignSelf: 'center' }}>
          {loading ? 'Loading…' : `${filtered.length} listing${filtered.length === 1 ? '' : 's'}`}
        </div>
      </div>

      {!loading && filtered.length === 0 ? (
        <div style={{ padding: 60, textAlign: 'center', color: 'var(--text-2)' }}>
          No listings match your filters yet.{' '}
          <a href="/app/" style={{ color: 'var(--accent)' }}>Publish your first mesh →</a>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
          {filtered.map((l) => (
            <div
              key={l.id}
              onClick={() => setSelected(l)}
              style={{ background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', cursor: 'pointer', display: 'flex', flexDirection: 'column', transition: 'transform 0.15s, border-color 0.15s' }}
              onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.borderColor = 'var(--accent)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = ''; e.currentTarget.style.borderColor = ''; }}
            >
              {/* @ts-expect-error model-viewer is a custom element */}
              <model-viewer
                src={l.mesh_url}
                camera-controls auto-rotate
                shadow-intensity="1" exposure="1"
                style={{ width: '100%', height: 200, background: '#0a0a0e' }}
              />
              <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.title}</div>
                  <div style={{ background: l.price_cents === 0 ? 'rgba(76,175,80,0.2)' : 'rgba(255,200,80,0.2)', color: l.price_cents === 0 ? 'var(--ok)' : '#ffcc66', padding: '2px 9px', borderRadius: 999, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
                    {formatPrice(l.price_cents, l.currency)}
                  </div>
                </div>
                <div style={{ color: 'var(--text-2)', fontSize: 11 }}>
                  by {l.author_display}{l.asset_type ? ` · ${l.asset_type}` : ''}
                </div>
                <div style={{ color: 'var(--text-3)', fontSize: 10 }}>
                  {LICENCE_LABELS[l.licence] || l.licence}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <div onClick={() => setSelected(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 100 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 12, padding: 24, maxWidth: 720, width: '100%', maxHeight: '90vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div>
                <h2 style={{ margin: 0 }}>{selected.title}</h2>
                <div style={{ color: 'var(--text-2)', fontSize: 13, marginTop: 4 }}>
                  by {selected.author_display}{selected.asset_type ? ` · ${selected.asset_type}` : ''} · {LICENCE_LABELS[selected.licence] || selected.licence}
                </div>
              </div>
              <button onClick={() => setSelected(null)} className="ghost-btn" style={{ padding: '4px 12px' }}>✕</button>
            </div>
            {/* @ts-expect-error model-viewer is a custom element */}
            <model-viewer
              src={selected.mesh_url}
              camera-controls auto-rotate
              shadow-intensity="1" exposure="1"
              style={{ width: '100%', height: 420, background: '#0a0a0e', borderRadius: 8 }}
            />
            {selected.description && (
              <p style={{ whiteSpace: 'pre-wrap', color: 'var(--text-1)', fontSize: 13, lineHeight: 1.5, margin: 0 }}>{selected.description}</p>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 18, fontWeight: 800 }}>{formatPrice(selected.price_cents, selected.currency)}</div>
              {selected.price_cents === 0 ? (
                <a href={selected.mesh_url} download className="primary-btn" style={{ padding: '10px 24px', textDecoration: 'none' }}>
                  ⬇ Download GLB
                </a>
              ) : (
                <button className="primary-btn" disabled style={{ padding: '10px 24px', opacity: 0.6, cursor: 'not-allowed' }} title="Stripe checkout coming soon">
                  Buy (coming soon)
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: 40, padding: 20, background: 'var(--bg-2)', borderRadius: 10, color: 'var(--text-2)', fontSize: 13, lineHeight: 1.6 }}>
        Want to publish a mesh you generated? Open the app, click any
        succeeded mesh, and use the <strong>🛒 Publish to marketplace</strong> button.
        An admin will review your listing before it goes live here.
      </div>
    </div>
  );
}
