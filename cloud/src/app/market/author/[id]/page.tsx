'use client';
//
// Public author profile — /market/author/<user_id>. No auth required.
// Shows the creator's display name, member-since date, headline stats
// (listings / sales / earnings) and the grid of their approved
// listings. Clicking a card jumps to /market?item=<id> where the
// existing public detail modal handles the rest.
//
import { useEffect, useState, use } from 'react';
import Script from 'next/script';

interface AuthorListing {
  id: string;
  title: string;
  description: string;
  price_cents: number;
  currency: string;
  licence: string;
  asset_kind?: 'mesh' | 'image';
  asset_type: string | null;
  asset_url?: string;
  mesh_url: string;
  created_at: string;
  rating_avg?: number;
  rating_count?: number;
}

interface EarningsByCurrency {
  currency: string;
  total_cents: number;
}

interface AuthorProfile {
  user_id: string;
  display: string;
  member_since: string;
  listings_count: number;
  total_sales: number;
  earnings: EarningsByCurrency[];
  listings: AuthorListing[];
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

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
  } catch { return iso; }
}

function StarRating({ avg, count }: { avg?: number; count?: number }) {
  if (!count || count === 0) {
    return <div style={{ color: 'var(--text-3)', fontSize: 10 }}>No ratings yet</div>;
  }
  const filled = Math.round(avg || 0);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-2)' }}>
      <span style={{ color: '#ffcc66', letterSpacing: 1 }}>
        {'★'.repeat(filled)}{'☆'.repeat(Math.max(0, 5 - filled))}
      </span>
      <span>{(avg || 0).toFixed(1)} ({count})</span>
    </div>
  );
}

export default function AuthorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [profile, setProfile] = useState<AuthorProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/market/author/${encodeURIComponent(id)}`);
        if (!r.ok) {
          throw new Error(`HTTP ${r.status}`);
        }
        const j = await r.json();
        setProfile(j as AuthorProfile);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  if (loading) {
    return (
      <div className="page">
        <div style={{ padding: 60, textAlign: 'center', color: 'var(--text-2)' }}>
          Loading author profile…
        </div>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="page">
        <div style={{ padding: 20 }}>
          <a href="/market" style={{ color: 'var(--accent)', fontSize: 13, textDecoration: 'none' }}>← Back to marketplace</a>
        </div>
        <div style={{ padding: 60, textAlign: 'center', color: 'var(--text-2)' }}>
          Could not load this author profile{error ? ` (${error})` : ''}.
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <Script
        src="https://unpkg.com/@google/model-viewer@3.5.0/dist/model-viewer.min.js"
        type="module" strategy="afterInteractive"
      />

      <div style={{ marginBottom: 12 }}>
        <a href="/market" style={{ color: 'var(--accent)', fontSize: 13, textDecoration: 'none' }}>
          ← Back to marketplace
        </a>
      </div>

      <div className="page-header" style={{ alignItems: 'flex-end', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <h2 style={{ marginBottom: 4 }}>👤 {profile.display}</h2>
          <div style={{ color: 'var(--text-2)', fontSize: 13 }}>
            Member since {formatDate(profile.member_since)}
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 28 }}>
        <div style={{ background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 10, padding: 16 }}>
          <div style={{ color: 'var(--text-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Listings published</div>
          <div style={{ fontSize: 26, fontWeight: 800, marginTop: 6 }}>{profile.listings_count}</div>
        </div>
        <div style={{ background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 10, padding: 16 }}>
          <div style={{ color: 'var(--text-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Total sales</div>
          <div style={{ fontSize: 26, fontWeight: 800, marginTop: 6 }}>{profile.total_sales}</div>
        </div>
        <div style={{ background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 10, padding: 16 }}>
          <div style={{ color: 'var(--text-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Total earned</div>
          <div style={{ fontSize: 20, fontWeight: 800, marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {profile.earnings.length === 0 ? (
              <span style={{ color: 'var(--text-2)', fontSize: 16 }}>—</span>
            ) : (
              profile.earnings.map((e) => (
                <span key={e.currency}>{formatPrice(e.total_cents, e.currency)}</span>
              ))
            )}
          </div>
        </div>
      </div>

      <h3 style={{ marginBottom: 14, fontSize: 16 }}>Listings by {profile.display}</h3>

      {profile.listings.length === 0 ? (
        <div style={{ padding: 60, textAlign: 'center', color: 'var(--text-2)' }}>
          This creator hasn&apos;t published anything yet.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
          {profile.listings.map((l) => {
            const kind = l.asset_kind || (l.mesh_url ? 'mesh' : 'image');
            const url = l.asset_url || l.mesh_url;
            return (
              <a
                key={l.id}
                href={`/market?item=${encodeURIComponent(l.id)}`}
                style={{ background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', cursor: 'pointer', display: 'flex', flexDirection: 'column', textDecoration: 'none', color: 'inherit', transition: 'transform 0.15s, border-color 0.15s' }}
                onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.borderColor = 'var(--accent)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = ''; e.currentTarget.style.borderColor = ''; }}
              >
                {kind === 'image' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={url} alt={l.title} style={{ width: '100%', height: 200, objectFit: 'cover', background: '#0a0a0e', display: 'block' }} />
                ) : (
                  // @ts-expect-error model-viewer is a custom element
                  <model-viewer src={url} camera-controls auto-rotate shadow-intensity="1" exposure="1" style={{ width: '100%', height: 200, background: '#0a0a0e' }} />
                )}
                <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.title}</div>
                    <div style={{ background: l.price_cents === 0 ? 'rgba(76,175,80,0.2)' : 'rgba(255,200,80,0.2)', color: l.price_cents === 0 ? 'var(--ok)' : '#ffcc66', padding: '2px 9px', borderRadius: 999, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
                      {formatPrice(l.price_cents, l.currency)}
                    </div>
                  </div>
                  <div style={{ color: 'var(--text-3)', fontSize: 10 }}>
                    {LICENCE_LABELS[l.licence] || l.licence}
                  </div>
                  <StarRating avg={l.rating_avg} count={l.rating_count} />
                </div>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
